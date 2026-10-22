// ==========================================================================
// Cliente de solo lectura de la API REST de GLPI (mesa de ayuda).
//
// Configuración por variables de entorno (.env del backend):
//   GLPI_API_URL     URL de la API, por defecto http://mesadeayuda/apirest.php
//   GLPI_APP_TOKEN   (opcional) App-Token del cliente API registrado en GLPI.
//                    Solo hace falta si el cliente API de GLPI lo exige; si no
//                    se define, se conecta solo con el token de usuario.
//   GLPI_USER_TOKEN  Token de acceso remoto (API token) del usuario de GLPI
//   GLPI_PERFIL      (opcional) nombre (o id) del perfil GLPI a activar tras iniciar sesión,
//                    p. ej. «Soporte TI». También se acepta GLPI_PERFIL_ID.
//                    (si el perfil por defecto del usuario no tiene permisos de API).
//   GLPI_URL_BASE    (opcional) base para armar el link del caso; por defecto
//                    se deduce de GLPI_API_URL (http://mesadeayuda)
//
// Solo se hacen lecturas (GET). Los tokens nunca se registran en logs ni se
// devuelven al frontend.
// ==========================================================================

const API_URL = (process.env.GLPI_API_URL || 'http://mesadeayuda/apirest.php').replace(/\/+$/, '');
const TIMEOUT_MS = 15000;
const MAX_BYTES_INCRUSTADOS = 4 * 1024 * 1024; // tope de imágenes incrustadas en el texto de una respuesta

const ESTADOS = { 1: 'Nuevo', 2: 'En curso (asignado)', 3: 'En curso (planificado)', 4: 'Pendiente', 5: 'Resuelto', 6: 'Cerrado' };

class GlpiError extends Error {
  constructor(mensaje, codigo = 'GLPI_ERROR', http = 502) {
    super(mensaje);
    this.codigo = codigo;
    this.http = http;
  }
}

function glpiConfigurado() {
  return Boolean(process.env.GLPI_USER_TOKEN);
}

function urlBase() {
  if (process.env.GLPI_URL_BASE) return process.env.GLPI_URL_BASE.replace(/\/+$/, '');
  return API_URL.replace(/\/apirest\.php$/i, '');
}

function urlCaso(id) {
  return `${urlBase()}/front/ticket.form.php?id=${id}`;
}

async function pedir(ruta, { sessionToken = null, metodo = 'GET', json = undefined, form = undefined, timeout = TIMEOUT_MS } = {}) {
  const headers = {};
  if (process.env.GLPI_APP_TOKEN) headers['App-Token'] = process.env.GLPI_APP_TOKEN;
  if (!form) headers['Content-Type'] = 'application/json';
  if (sessionToken) headers['Session-Token'] = sessionToken;
  else headers.Authorization = `user_token ${process.env.GLPI_USER_TOKEN}`;
  let res;
  try {
    res = await fetch(`${API_URL}/${ruta}`, {
      method: metodo, headers,
      body: form || (json !== undefined ? JSON.stringify(json) : undefined),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new GlpiError('GLPI no respondió a tiempo. Intenta de nuevo.', 'GLPI_TIMEOUT', 504);
    }
    const causa = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'desconocida';
    let destino = API_URL;
    try { destino = new URL(API_URL).host; } catch (e) { /* URL inválida: se muestra tal cual */ }
    console.error(`GLPI: fallo de conexión con ${destino} (${causa})`);
    throw new GlpiError(`No se pudo conectar con GLPI (mesa de ayuda) desde el servidor. Destino: ${destino}. Causa: ${causa}.`, 'GLPI_SIN_CONEXION', 502);
  }
  let cuerpo = null;
  const texto = await res.text();
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch (e) { cuerpo = null; }
  if (!res.ok) {
    const codigoGlpi = Array.isArray(cuerpo) ? String(cuerpo[0] || '') : '';
    const detalleGlpi = Array.isArray(cuerpo) && typeof cuerpo[1] === 'string' ? cuerpo[1].replace(/<[^>]*>/g, '').slice(0, 200) : '';
    if (res.status === 401 || /ERROR_(LOGIN|GLPI_LOGIN|WRONG_APP_TOKEN|APP_TOKEN)/i.test(codigoGlpi)) {
      const pista = /APP_TOKEN/i.test(codigoGlpi)
        ? 'el cliente API de GLPI exige un App-Token (o el configurado es incorrecto)'
        : /LOGIN|USER_TOKEN/i.test(codigoGlpi) ? 'el token de usuario es inválido o fue regenerado' : 'token de usuario o App-Token inválidos';
      throw new GlpiError(`GLPI rechazó la autenticación: ${pista}${codigoGlpi ? ` [${codigoGlpi}${detalleGlpi ? `: ${detalleGlpi}` : ''}]` : ''}.`, 'GLPI_TOKENS', 502);
    }
    if (res.status === 403 || /ERROR_RIGHT_MISSING/i.test(codigoGlpi)) {
      throw new GlpiError(metodo === 'GET'
        ? 'El usuario de la API de GLPI no tiene permiso para ver este caso.'
        : 'El usuario de la API de GLPI no tiene permiso para agregar seguimientos o documentos en este caso (¿está cerrado o sin perfil de técnico?).', 'GLPI_SIN_PERMISO', 403);
    }
    if (res.status === 404 || /ERROR_ITEM_NOT_FOUND/i.test(codigoGlpi)) throw new GlpiError('El caso no existe en GLPI (o la API no tiene acceso a él).', 'GLPI_NO_EXISTE', 404);
    throw new GlpiError(`GLPI respondió con error ${res.status}${codigoGlpi ? ` (${codigoGlpi}${detalleGlpi ? `: ${detalleGlpi}` : ''})` : ''}.`, 'GLPI_HTTP', 502);
  }
  return cuerpo;
}


// Abre sesión y, si se configuró GLPI_PERFIL (nombre o id) o GLPI_PERFIL_ID, cambia el perfil
// activo: el usuario de la API puede tener por defecto un perfil sin permisos (p. ej. «Usuario Final»).
async function abrirSesion() {
  const sesion = await pedir('initSession');
  const sessionToken = sesion && sesion.session_token;
  if (!sessionToken) throw new GlpiError('GLPI no entregó una sesión válida.', 'GLPI_SESION', 502);
  const pedido = String(process.env.GLPI_PERFIL_ID || process.env.GLPI_PERFIL || '').trim();
  if (pedido) {
    try {
      let perfilId = /^\d+$/.test(pedido) ? Number(pedido) : null;
      if (!perfilId) {
        const r = await pedir('getMyProfiles', { sessionToken });
        const lista = Array.isArray(r && r.myprofiles) ? r.myprofiles : [];
        const norm = (t) => String(t || '').trim().toLowerCase();
        const q = norm(pedido);
        const hallado = lista.find((x) => norm(x.name) === q) || lista.find((x) => norm(x.name).startsWith(q));
        if (!hallado) {
          const nombres = lista.map((x) => x.name).filter(Boolean).join(', ') || 'ninguno';
          throw new GlpiError(`El usuario de la API no tiene un perfil llamado «${pedido}». Perfiles disponibles: ${nombres}.`, 'GLPI_PERFIL', 502);
        }
        perfilId = Number(hallado.id);
      }
      await pedir('changeActiveProfile', { sessionToken, metodo: 'POST', json: { profiles_id: perfilId } });
    } catch (err) {
      pedir('killSession', { sessionToken }).catch(() => {});
      if (err instanceof GlpiError && err.codigo === 'GLPI_PERFIL') throw err;
      throw new GlpiError(`No se pudo activar el perfil «${pedido}» en GLPI (¿el usuario no lo tiene asignado?).`, 'GLPI_PERFIL', 502);
    }
  }
  return sessionToken;
}

function nombreCompleto(u) {
  return [u.firstname, u.realname].filter(Boolean).join(' ').trim() || u.name || '';
}

// Lee el caso: datos, contenido y actores (solicitante / asignados / observadores).
async function obtenerCaso(idCaso) {
  const id = String(idCaso || '').replace(/\D/g, '');
  if (!id || id.length > 9) throw new GlpiError('Escribe un número de caso válido (solo dígitos).', 'CASO_INVALIDO', 400);
  if (!glpiConfigurado()) throw new GlpiError('La integración con GLPI no está configurada en el servidor (falta GLPI_USER_TOKEN).', 'GLPI_SIN_CONFIG', 503);

  const sessionToken = await abrirSesion();

  try {
    const ticket = await pedir(`Ticket/${id}?expand_dropdowns=true`, { sessionToken });
    if (!ticket || typeof ticket !== 'object') throw new GlpiError('GLPI devolvió una respuesta inesperada para el caso.', 'GLPI_RESPUESTA', 502);

    // Actores: si algo falla acá no se pierde el caso, solo se omiten.
    const actores = [];
    try {
      const relaciones = await pedir(`Ticket/${id}/Ticket_User`, { sessionToken });
      const tipos = { 1: 'solicitante', 2: 'asignado', 3: 'observador' };
      const cacheUsuarios = new Map();
      for (const r of (Array.isArray(relaciones) ? relaciones : []).slice(0, 20)) {
        const tipo = tipos[r.type];
        if (!tipo || !r.users_id) continue;
        if (!cacheUsuarios.has(r.users_id)) {
          let u = {};
          try { u = await pedir(`User/${r.users_id}?expand_dropdowns=false`, { sessionToken }); } catch (e) { u = {}; }
          cacheUsuarios.set(r.users_id, u || {});
        }
        const u = cacheUsuarios.get(r.users_id);
        actores.push({ tipo, login: u.name || '', nombre: nombreCompleto(u) });
      }
    } catch (e) {
      if (e instanceof GlpiError && e.codigo === 'GLPI_TOKENS') throw e;
    }

    const estadoNum = Number(ticket.status);
    return {
      ticket: {
        id: Number(ticket.id) || Number(id),
        name: ticket.name || '',
        content: ticket.content || '',
        date: ticket.date || null,
        status: ESTADOS[estadoNum] || (ticket.status != null ? String(ticket.status) : null),
        categoria: typeof ticket.itilcategories_id === 'string' ? ticket.itilcategories_id : null,
        url: urlCaso(id)
      },
      actores
    };
  } finally {
    // Cerrar la sesión siempre (no bloquea ni propaga errores).
    pedir('killSession', { sessionToken }).catch(() => {});
  }
}

// Texto plano (el que el usuario revisó/editó) -> HTML simple y seguro para GLPI.
// Líneas en MAYÚSCULAS = títulos en negrita; "- " = viñeta; resto, texto.
// `imagenes`: [{ nombre, dataUri, ancla }]. Cada imagen se inserta DEBAJO de la línea que contiene su
// `ancla` (la descripción del paso al que pertenece); las que no encuentran su línea van al final.
function textoAHtml(texto, imagenes = []) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attr = (t) => esc(t).replace(/"/g, '&quot;');
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const pendientes = imagenes.map((i) => ({ ...i, usada: false }));
  const htmlImagen = (i) => `<p><img src="${i.dataUri}" alt="${attr(i.nombre)}" style="max-width:100%;height:auto;"></p>`;

  const partes = [];
  const bloques = String(texto || '').replace(/\r/g, '').split(/\n{2,}/);
  for (const b of bloques) {
    const lineas = b.split('\n').filter((l) => l.trim() !== '');
    if (!lineas.length) continue;
    let actual = [];
    const cerrar = () => { if (actual.length) { partes.push(`<p>${actual.join('<br>')}</p>`); actual = []; } };
    for (const l of lineas) {
      const t = l.trim();
      const esTitulo = t.length >= 6 && t === t.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{4}/.test(t) && !/[a-záéíóúñ]/.test(t);
      actual.push(esTitulo ? `<strong>${esc(t)}</strong>` : esc(l));
      const nl = norm(l);
      const coinciden = pendientes.filter((i) => !i.usada && i.ancla && nl.includes(norm(i.ancla)));
      if (coinciden.length) {
        cerrar();
        coinciden.forEach((i) => { i.usada = true; partes.push(htmlImagen(i)); });
      }
    }
    cerrar();
  }
  const restantes = pendientes.filter((i) => !i.usada);
  if (restantes.length) {
    partes.push('<p><strong>EVIDENCIAS</strong></p>');
    restantes.forEach((i) => { partes.push(`<p>${esc(i.nombre)}</p>`); partes.push(htmlImagen(i)); });
  }
  const html = partes.join('');
  // En GLPI 9.5 el contenido enriquecido se guarda con las etiquetas escapadas.
  return process.env.GLPI_CONTENIDO_ESCAPADO === '1'
    ? html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : html;
}

// ESCRIBE en GLPI: agrega una respuesta al caso (seguimiento o solución) con las
// imágenes incrustadas bajo cada paso. Solo se llama tras la confirmación
// explícita del usuario en AXIS. `archivos`: [{ nombre, mime, buffer }].
async function publicarSeguimiento(idCaso, { contenido, privado = true, archivos = [], tipo = 'SEGUIMIENTO' }) {
  const esSolucion = tipo === 'SOLUCION';
  const id = String(idCaso || '').replace(/\D/g, '');
  if (!id || id.length > 9) throw new GlpiError('Número de caso inválido.', 'CASO_INVALIDO', 400);
  if (!glpiConfigurado()) throw new GlpiError('La integración con GLPI no está configurada en el servidor (falta GLPI_USER_TOKEN).', 'GLPI_SIN_CONFIG', 503);

  const sessionToken = await abrirSesion();

  try {
    // El caso debe existir y ser visible ANTES de crear nada.
    const ticketActual = await pedir(`Ticket/${id}?get_hateoas=false`, { sessionToken });
    if (ticketActual && [5, 6].includes(Number(ticketActual.status))) {
      throw new GlpiError(`El caso #${id} ya está ${Number(ticketActual.status) === 5 ? 'Resuelto' : 'Cerrado'} en GLPI: no se puede responder ni cerrar desde AXIS.`, 'GLPI_YA_CERRADO', 409);
    }

    // Las imágenes se INCRUSTAN en el texto de la respuesta, cada una debajo de su paso (GLPI_IMAGENES_MODO=adjuntas
    // las deja como adjuntos de la respuesta en vez de incrustarlas). Lo que no es imagen, o excede el tope
    // incrustable, se adjunta a la respuesta.
    const incrustar = String(process.env.GLPI_IMAGENES_MODO || 'incrustadas').toLowerCase() !== 'adjuntas';
    const aIncrustar = [];
    const aAdjuntar = [];
    let bytesIncrustados = 0;
    for (const a of archivos) {
      const esImagen = /^image\/(png|jpe?g|gif|webp)$/i.test(a.mime || '') || /\.(png|jpe?g|gif|webp)$/i.test(a.nombre || '');
      if (incrustar && esImagen && bytesIncrustados + a.buffer.length <= MAX_BYTES_INCRUSTADOS) {
        bytesIncrustados += a.buffer.length;
        const mime = /^image\//i.test(a.mime || '') ? a.mime : `image/${/\.jpe?g$/i.test(a.nombre) ? 'jpeg' : (String(a.nombre).split('.').pop() || 'png').toLowerCase()}`;
        aIncrustar.push({ ...a, dataUri: `data:${mime};base64,${a.buffer.toString('base64')}` });
      } else {
        aAdjuntar.push(a);
      }
    }

    // 1) La RESPUESTA en el caso: seguimiento (como el botón «Respuesta» de GLPI) o SOLUCIÓN (cierre).
    //    Se crea primero: si falla, no queda nada subido a medias.
    const crearRespuesta = async (imagenes) => {
      const html = textoAHtml(contenido, imagenes);
      return esSolucion
        ? pedir('ITILSolution', { sessionToken, metodo: 'POST', timeout: 60000, json: { input: { itemtype: 'Ticket', items_id: Number(id), content: html } } })
        : pedir('ITILFollowup', { sessionToken, metodo: 'POST', timeout: 60000, json: { input: { itemtype: 'Ticket', items_id: Number(id), content: html, is_private: privado ? 1 : 0 } } });
    };
    let creado;
    try {
      creado = await crearRespuesta(aIncrustar.map((i) => ({ nombre: i.nombre, dataUri: i.dataUri, ancla: i.ancla })));
    } catch (err) {
      if (esSolucion && err instanceof GlpiError && err.codigo === 'GLPI_SIN_PERMISO') {
        err.message = 'El perfil activo del usuario de la API en GLPI no tiene permiso para resolver este caso (¿falta «Resolver casos» o el caso ya no admite solución?).';
      }
      throw err;
    }
    const seguimientoId = creado && (Array.isArray(creado) ? creado[0]?.id : creado.id);
    if (!seguimientoId) throw new GlpiError(esSolucion ? 'GLPI no confirmó la creación de la solución.' : 'GLPI no confirmó la creación del seguimiento.', 'GLPI_RESPUESTA', 502);
    const tipoItem = esSolucion ? 'ITILSolution' : 'ITILFollowup';

    // 2) Verificación: que GLPI guardó las imágenes dentro del texto. Si no, se adjuntan a la respuesta.
    const resultadosArchivos = [];
    let incrustadasOk = true;
    if (aIncrustar.length) {
      try {
        const guardado = await pedir(`${tipoItem}/${seguimientoId}`, { sessionToken });
        const contenidoGuardado = String((guardado && guardado.content) || '');
        incrustadasOk = /<img\b|&lt;img\b/i.test(contenidoGuardado);
      } catch (e) { incrustadasOk = true; /* no se pudo verificar: se asume correcto */ }
    }
    if (aIncrustar.length && incrustadasOk) {
      aIncrustar.forEach((i) => resultadosArchivos.push({ nombre: i.nombre, ok: true, incrustada: true }));
    } else {
      aAdjuntar.push(...aIncrustar);
    }

    // 3) Lo que no se pudo incrustar (o no es imagen) se sube ASOCIADO A LA RESPUESTA, no suelto en el caso.
    const idsDocumentos = [];
    for (const a of aAdjuntar) {
      try {
        const form = new FormData();
        form.append('uploadManifest', JSON.stringify({ input: { name: `AXIS - ${a.nombre}`.slice(0, 200), _filename: [a.nombre], itemtype: tipoItem, items_id: Number(seguimientoId) } }));
        form.append('filename[0]', new Blob([a.buffer], { type: a.mime || 'application/octet-stream' }), a.nombre);
        const doc = await pedir('Document', { sessionToken, metodo: 'POST', form, timeout: 60000 });
        const docId = doc && (Array.isArray(doc) ? doc[0]?.id : doc.id);
        if (docId) idsDocumentos.push({ nombre: a.nombre, docId: Number(docId) });
        resultadosArchivos.push({ nombre: a.nombre, ok: true, incrustada: false, docId: docId ? Number(docId) : null });
      } catch (err) {
        resultadosArchivos.push({ nombre: a.nombre, ok: false, error: err instanceof GlpiError ? err.message : 'No se pudo subir el archivo.' });
      }
    }
    if (idsDocumentos.length) {
      try {
        const vinculos = await pedir(`${tipoItem}/${seguimientoId}/Document_Item`, { sessionToken });
        const vinculados = new Set((Array.isArray(vinculos) ? vinculos : []).map((v) => Number(v.documents_id)));
        for (const d of idsDocumentos) {
          let enRespuesta = vinculados.has(d.docId);
          if (!enRespuesta) {
            try {
              await pedir('Document_Item', { sessionToken, metodo: 'POST', json: { input: { documents_id: d.docId, itemtype: tipoItem, items_id: Number(seguimientoId) } } });
              enRespuesta = true;
            } catch (e) { enRespuesta = false; }
          }
          const r = resultadosArchivos.find((x) => x.docId === d.docId);
          if (r) r.enRespuesta = enRespuesta;
        }
      } catch (e) { /* si no se puede verificar, se deja sin marcar */ }
    }
    resultadosArchivos.forEach((r) => { delete r.docId; });

    return { seguimientoId, url: urlCaso(id), archivos: resultadosArchivos, tipo: esSolucion ? 'SOLUCION' : 'SEGUIMIENTO' };
  } finally {
    pedir('killSession', { sessionToken }).catch(() => {});
  }
}


// Solo LECTURA: estado actual del caso en GLPI (para mostrarlo y evitar responder/cerrar casos ya cerrados).
async function obtenerEstadoCaso(idCaso) {
  const id = String(idCaso || '').replace(/\D/g, '');
  if (!id || id.length > 9) throw new GlpiError('Número de caso inválido.', 'CASO_INVALIDO', 400);
  if (!glpiConfigurado()) throw new GlpiError('La integración con GLPI no está configurada en el servidor (falta GLPI_USER_TOKEN).', 'GLPI_SIN_CONFIG', 503);
  const sessionToken = await abrirSesion();
  try {
    const t = await pedir(`Ticket/${id}?get_hateoas=false`, { sessionToken });
    if (!t || typeof t !== 'object') throw new GlpiError('GLPI devolvió una respuesta inesperada para el caso.', 'GLPI_RESPUESTA', 502);
    const codigo = Number(t.status);
    return {
      caso: id,
      titulo: t.name || '',
      codigo,
      estado: ESTADOS[codigo] || (t.status != null ? String(t.status) : 'Desconocido'),
      cerrado: codigo === 5 || codigo === 6,
      url: urlCaso(id),
      fechaApertura: t.date || null,
      fechaSolucion: t.solvedate || null,
      fechaCierre: t.closedate || null
    };
  } finally {
    pedir('killSession', { sessionToken }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Listado de casos (solo LECTURA) con la búsqueda de la API de GLPI.
// Ids de campo del buscador de Ticket: 1 título, 2 id, 3 prioridad, 4 solicitante, 5 técnico asignado,
// 7 categoría, 8 grupo técnico, 12 estado, 15 apertura, 17 fecha de solución, 18 tiempo de solución,
// 19 última actualización, 80 entidad.
// ---------------------------------------------------------------------------
const CAMPOS_LISTA = [2, 1, 12, 15, 19, 18, 17, 4, 5, 8, 7, 3, 80];
const ORDEN_CAMPO = { id: 2, apertura: 15, actualizacion: 19, vencimiento: 18 };
const PRIORIDADES = { 1: 'Muy baja', 2: 'Baja', 3: 'Media', 4: 'Alta', 5: 'Muy alta', 6: 'Mayor' };
const ESTADOS_FILTRO = ['notold', 'notclosed', 'old', 'process', 'all', '1', '2', '3', '4', '5', '6'];

function aTexto(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(aTexto).filter(Boolean).join(', ');
  if (typeof v === 'object') return Object.values(v).map(aTexto).filter(Boolean).join(', ');
  return String(v).replace(/<[^>]*>/g, '').trim();
}
function aLista(v) {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(aLista);
  if (typeof v === 'object') return Object.values(v).flatMap(aLista);
  const t = String(v).replace(/<[^>]*>/g, '').trim();
  return t ? [t] : [];
}
// Hora de Colombia (UTC-5, sin horario de verano) con el formato del buscador de GLPI.
function ahoraColombia() { return new Date(Date.now() - 5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19); }
function fechaGlpi(d) { // 'YYYY-MM-DD' -> valor aceptado por el buscador
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null;
}

function armarCriterios(f) {
  const c = [];
  const agregar = (campo, tipo, valor) => c.push({ field: campo, searchtype: tipo, value: valor });
  const estado = ESTADOS_FILTRO.includes(String(f.estado)) ? String(f.estado) : 'notold';
  if (estado !== 'all') agregar(12, 'equals', estado);
  if (f.alcance === 'yo' && f.usuarioId) agregar(5, 'equals', f.usuarioId);
  else if (f.alcance === 'grupo' && /^\d+$/.test(String(f.grupoId || ''))) agregar(8, 'equals', String(f.grupoId));
  else if (f.alcance === 'tecnico' && /^\d+$/.test(String(f.tecnicoId || ''))) agregar(5, 'equals', String(f.tecnicoId));
  else if (f.alcance === 'tecnico' && f.tecnico) agregar(5, 'contains', String(f.tecnico).slice(0, 80));
  if (f.solicitante) agregar(4, 'contains', String(f.solicitante).slice(0, 80));
  const q = String(f.texto || '').trim().slice(0, 120);
  if (q) /^\d+$/.test(q) ? agregar(2, 'contains', q) : agregar(1, 'contains', q);
  const desde = fechaGlpi(f.desde);
  const hasta = fechaGlpi(f.hasta);
  if (desde) agregar(15, 'morethan', `${desde} 00:00:00`);
  if (hasta) agregar(15, 'lessthan', `${hasta} 23:59:59`);
  if (f.soloVencidos) {
    agregar(18, 'lessthan', ahoraColombia());
    if (estado === 'all' || estado === 'old' || estado === '5' || estado === '6') c.push({ field: 12, searchtype: 'equals', value: 'notold' });
  }
  return c;
}

function paramsBusqueda(criterios, orden, desc, desde, hasta) {
  const p = new URLSearchParams();
  criterios.forEach((c, i) => {
    p.set(`criteria[${i}][link]`, 'AND');
    p.set(`criteria[${i}][field]`, String(c.field));
    p.set(`criteria[${i}][searchtype]`, c.searchtype);
    p.set(`criteria[${i}][value]`, String(c.value));
  });
  CAMPOS_LISTA.forEach((id, i) => p.set(`forcedisplay[${i}]`, String(id)));
  p.set('sort', String(ORDEN_CAMPO[orden] || ORDEN_CAMPO.apertura));
  p.set('order', desc === false ? 'ASC' : 'DESC');
  p.set('range', `${desde}-${hasta}`);
  p.set('expand_dropdowns', 'true');
  p.set('rawdata', 'false');
  return p.toString();
}

function normalizarFila(fila) {
  const id = Number(fila['2']);
  const estadoRaw = fila['12'];
  const codigo = /^\d+$/.test(String(estadoRaw)) ? Number(estadoRaw) : null;
  const estado = codigo ? (ESTADOS[codigo] || String(estadoRaw)) : aTexto(estadoRaw);
  const textoEstado = estado.toLowerCase();
  const cerrado = codigo ? (codigo === 5 || codigo === 6) : /resuelto|cerrado|solved|closed/.test(textoEstado);
  const vence = aTexto(fila['18']) || null;
  const prioRaw = fila['3'];
  return {
    id, url: urlCaso(id), titulo: aTexto(fila['1']), estado, codigo, cerrado,
    apertura: aTexto(fila['15']) || null, actualizacion: aTexto(fila['19']) || null,
    vence, solucion: aTexto(fila['17']) || null,
    vencido: !!vence && !cerrado && new Date(`${vence.replace(' ', 'T')}-05:00`).getTime() < Date.now(),
    solicitantes: aLista(fila['4']), tecnicos: aLista(fila['5']), grupos: aLista(fila['8']),
    categoria: aTexto(fila['7']) || null, entidad: aTexto(fila['80']) || null,
    prioridad: /^\d+$/.test(String(prioRaw)) ? (PRIORIDADES[Number(prioRaw)] || String(prioRaw)) : (aTexto(prioRaw) || null),
  };
}


// Usuarios de GLPI (id -> nombre). El buscador devuelve ids en solicitante/técnico, así que se resuelven aquí.
// Si el perfil de la API no puede listar /User (muy común), los nombres se aprenden de los actores de los
// casos (Ticket_User con expand_dropdowns) y de los miembros de los grupos (Group_User).
const CACHE_USUARIOS_MS = 15 * 60 * 1000;
const MAX_NOMBRES = 20000;
const nombresAprendidos = new Map(); // id -> nombre (persistente mientras viva el proceso)
let cacheUsuarios = null; // { t, mapa, lista: [{id, nombre}], equipo: Set<string> }

function nombreUsuarioGlpi(u) {
  const completo = [u.firstname, u.realname].filter(Boolean).join(' ').trim();
  return completo || u.name || `Usuario ${u.id}`;
}

function recordar(id, nombre) {
  const n = String(nombre || '').trim();
  if (!id || !n || /^\d+$/.test(n)) return;
  if (nombresAprendidos.size > MAX_NOMBRES) nombresAprendidos.clear();
  nombresAprendidos.set(String(id), n);
}

// Lee una colección con y sin expand_dropdowns y empareja users_id (id) con su nombre, fila a fila.
async function aprenderDeSubitems(sessionToken, ruta) {
  const sep = ruta.includes('?') ? '&' : '?';
  const [crudo, nombres] = await Promise.all([
    pedir(ruta, { sessionToken }),
    pedir(`${ruta}${sep}expand_dropdowns=true`, { sessionToken }),
  ]);
  const porFila = new Map((Array.isArray(nombres) ? nombres : []).map((x) => [String(x.id), x]));
  const salida = [];
  for (const f of Array.isArray(crudo) ? crudo : []) {
    const n = porFila.get(String(f.id));
    if (!f || !n || !f.users_id) continue;
    recordar(f.users_id, n.users_id);
    salida.push({ usuarioId: String(f.users_id), tipo: Number(f.type) || 0 });
  }
  return salida;
}

async function aprenderDeTicket(sessionToken, idTicket) {
  try { return await aprenderDeSubitems(sessionToken, `Ticket/${idTicket}/Ticket_User`); } catch (e) { return []; }
}

async function enParalelo(items, limite, fn) {
  const cola = [...items];
  await Promise.all(Array.from({ length: Math.min(limite, cola.length) }, async () => { while (cola.length) await fn(cola.shift()); }));
}

async function cargarDesdeApiUsuarios(sessionToken) {
  const lista = [];
  const PAGINA = 500;
  for (let inicio = 0; inicio < 10000; inicio += PAGINA) {
    let r;
    try { r = await pedir(`User?range=${inicio}-${inicio + PAGINA - 1}&is_deleted=0`, { sessionToken, timeout: 30000 }); } catch (e) { if (inicio === 0) throw e; break; }
    const filas = Array.isArray(r) ? r : [];
    for (const u of filas) {
      if (!u || u.id === undefined || u.id === null) continue;
      recordar(u.id, nombreUsuarioGlpi(u));
      if (u.is_active === 0 || u.is_active === '0') continue;
      if (/^helpdesk$/i.test(u.name || '') && !u.realname) continue;
      lista.push(String(u.id));
    }
    if (filas.length < PAGINA) break;
  }
  return lista;
}

// Sin permiso para listar usuarios: técnicos que aparecen en los casos abiertos (+ miembros de los grupos propios).
async function cargarDesdeActores(sessionToken, misGrupos) {
  const ids = new Set();
  const equipo = new Set();
  for (const gid of misGrupos || []) {
    try {
      const miembros = await aprenderDeSubitems(sessionToken, `Group/${gid}/Group_User?range=0-499`);
      miembros.forEach((m) => { ids.add(m.usuarioId); equipo.add(m.usuarioId); });
    } catch (e) { /* sin acceso a los miembros del grupo */ }
  }
  try {
    const p = new URLSearchParams({ 'criteria[0][field]': '12', 'criteria[0][searchtype]': 'equals', 'criteria[0][value]': 'notold', 'forcedisplay[0]': '2', 'forcedisplay[1]': '5', sort: '19', order: 'DESC', range: '0-299' });
    const r = await pedir(`search/Ticket?${p.toString()}`, { sessionToken, timeout: 30000 });
    const filas = Array.isArray(r && r.data) ? r.data : (r && r.data ? Object.values(r.data) : []);
    const ticketDe = new Map(); // id usuario -> primer ticket donde aparece
    for (const f of filas) {
      for (const u of (Array.isArray(f['5']) ? f['5'] : [f['5']])) {
        if (u === undefined || u === null || u === '') continue;
        const id = String(u);
        if (!/^\d+$/.test(id)) { continue; }
        ids.add(id);
        if (!ticketDe.has(id)) ticketDe.set(id, f['2']);
      }
    }
    const tickets = [...new Set([...ticketDe.entries()].filter(([id]) => !nombresAprendidos.has(id)).map(([, t]) => t))].slice(0, 60);
    await enParalelo(tickets, 6, (t) => aprenderDeTicket(sessionToken, t));
  } catch (e) { /* queda lo aprendido de los grupos */ }
  return { ids: [...ids], equipo };
}

async function usuariosGlpi(sessionToken, misGrupos = null) {
  const vigente = cacheUsuarios && Date.now() - cacheUsuarios.t < CACHE_USUARIOS_MS;
  if (vigente && !misGrupos) return cacheUsuarios;
  let ids = [];
  let equipo = (cacheUsuarios && cacheUsuarios.equipo) || new Set();
  let completo = false;
  try {
    ids = await cargarDesdeApiUsuarios(sessionToken);
    completo = true;
    if (misGrupos) {
      equipo = new Set();
      for (const gid of misGrupos) {
        try { (await pedir(`Group/${gid}/Group_User?range=0-499`, { sessionToken }) || []).forEach((x) => { if (x && x.users_id) equipo.add(String(x.users_id)); }); } catch (e) { /* sin acceso */ }
      }
    }
  } catch (e) {
    if (!misGrupos && cacheUsuarios) return cacheUsuarios; // para nombres de casos no se repite el descubrimiento pesado
    const r = await cargarDesdeActores(sessionToken, misGrupos || []);
    ids = r.ids;
    if (misGrupos) equipo = r.equipo;
  }
  const lista = [...new Set(ids)].filter((id) => nombresAprendidos.has(id)).map((id) => ({ id, nombre: nombresAprendidos.get(id) }));
  lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  cacheUsuarios = { t: Date.now(), mapa: nombresAprendidos, lista, equipo, completo };
  return cacheUsuarios;
}

// Reemplaza ids de usuario por nombres en solicitantes y técnicos de los casos.
async function resolverNombresCasos(sessionToken, casos) {
  try { await usuariosGlpi(sessionToken); } catch (e) { /* se intenta por caso más abajo */ }
  const mapa = nombresAprendidos;
  const pendientes = [];
  const vistos = new Set();
  for (const c of casos) {
    if ([...c.solicitantes, ...c.tecnicos].some((x) => /^\d+$/.test(x) && !mapa.has(x)) && !vistos.has(c.id)) { vistos.add(c.id); pendientes.push(c.id); }
  }
  await enParalelo(pendientes.slice(0, 60), 6, (id) => aprenderDeTicket(sessionToken, id));
  const nombre = (x) => (/^\d+$/.test(x) ? (mapa.get(x) || `Usuario ${x}`) : x);
  for (const c of casos) { c.solicitantes = c.solicitantes.map(nombre); c.tecnicos = c.tecnicos.map(nombre); }
}

// Filtros disponibles: usuario de la API, sus grupos y el resto de grupos visibles.
async function obtenerFiltros() {
  if (!glpiConfigurado()) throw new GlpiError('La integración con GLPI no está configurada en el servidor (falta GLPI_USER_TOKEN).', 'GLPI_SIN_CONFIG', 503);
  const sessionToken = await abrirSesion();
  try {
    let yo = null;
    let misGrupos = [];
    try {
      const full = await pedir('getFullSession', { sessionToken });
      const ses = (full && full.session) || {};
      if (ses.glpiID) yo = { id: String(ses.glpiID), nombre: ses.glpifriendlyname || ses.glpiname || '' };
      misGrupos = Array.isArray(ses.glpigroups) ? ses.glpigroups.map(String) : [];
    } catch (e) { /* sin datos de sesión: el filtro «Mis casos» quedará deshabilitado */ }
    let grupos = [];
    try {
      const lista = await pedir('Group?range=0-499&is_deleted=0', { sessionToken });
      grupos = (Array.isArray(lista) ? lista : []).map((g) => ({ id: String(g.id), nombre: g.completename || g.name || `Grupo ${g.id}`, mio: misGrupos.includes(String(g.id)) }));
    } catch (e) {
      grupos = misGrupos.map((id) => ({ id, nombre: `Grupo ${id}`, mio: true }));
    }
    for (const id of misGrupos) {
      if (!grupos.some((g) => g.id === id)) {
        try { const g = await pedir(`Group/${id}`, { sessionToken }); grupos.push({ id, nombre: g.completename || g.name || `Grupo ${id}`, mio: true }); } catch (e) { /* ignorar */ }
      }
    }
    grupos.sort((a, b) => (Number(b.mio) - Number(a.mio)) || a.nombre.localeCompare(b.nombre, 'es'));
    let usuarios = [];
    let usuariosError = null;
    try {
      const u = await usuariosGlpi(sessionToken, misGrupos);
      usuarios = u.lista.map((x) => ({ id: x.id, nombre: x.nombre, equipo: u.equipo.has(x.id) }));
      usuarios.sort((a, b) => (Number(b.equipo) - Number(a.equipo)) || a.nombre.localeCompare(b.nombre, 'es'));
    } catch (e) { usuariosError = 'No se pudo armar la lista de técnicos desde GLPI.'; }
    return { yo, grupos, usuarios, usuariosError };
  } finally {
    pedir('killSession', { sessionToken }).catch(() => {});
  }
}

async function listarCasos(filtros = {}) {
  if (!glpiConfigurado()) throw new GlpiError('La integración con GLPI no está configurada en el servidor (falta GLPI_USER_TOKEN).', 'GLPI_SIN_CONFIG', 503);
  const limite = Math.min(Math.max(parseInt(filtros.limite, 10) || 50, 1), 500);
  const criterios = armarCriterios(filtros);
  const sessionToken = await abrirSesion();
  try {
    if (filtros.alcance === 'yo' && !filtros.usuarioId) {
      const full = await pedir('getFullSession', { sessionToken });
      const id = full && full.session && full.session.glpiID;
      if (!id) throw new GlpiError('GLPI no informó el usuario de la API; elige un técnico por nombre.', 'GLPI_USUARIO', 502);
      return await ejecutar(sessionToken, armarCriterios({ ...filtros, usuarioId: String(id) }), limite, filtros);
    }
    return await ejecutar(sessionToken, criterios, limite, filtros);
  } finally {
    pedir('killSession', { sessionToken }).catch(() => {});
  }
}

async function ejecutar(sessionToken, criterios, limite, filtros) {
  const PAGINA = 100;
  const casos = [];
  let total = 0;
  for (let inicio = 0; inicio < limite; inicio += PAGINA) {
    const fin = Math.min(inicio + PAGINA, limite) - 1;
    const r = await pedir(`search/Ticket?${paramsBusqueda(criterios, filtros.orden, filtros.descendente, inicio, fin)}`, { sessionToken, timeout: 30000 });
    total = Number((r && r.totalcount) || 0);
    const filas = Array.isArray(r && r.data) ? r.data : (r && r.data ? Object.values(r.data) : []);
    filas.forEach((f) => { if (f && f['2']) casos.push(normalizarFila(f)); });
    if (!filas.length || casos.length >= total) break;
  }
  const salida = casos.slice(0, limite);
  await resolverNombresCasos(sessionToken, salida);
  return { total, devueltos: salida.length, truncado: total > salida.length, casos: salida };
}

module.exports = { listarCasos, obtenerFiltros, glpiConfigurado, obtenerCaso, obtenerEstadoCaso, publicarSeguimiento, textoAHtml, urlCaso, GlpiError };
