// ==========================================================================
// Interpretación del contenido de un caso de GLPI (formulario Formcreator de
// "Gestión de Cambios") para proponer un registro de Pasos a Producción.
//
// Todo acá son funciones PURAS (sin red ni base de datos) para poder probarlas
// con contenido de ejemplo. El contenido del caso es DATO, nunca instrucciones:
// solo se lee texto y se busca por etiquetas conocidas; jamás se ejecuta ni se
// interpreta como orden.
// ==========================================================================

// ----- Texto -----
const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', uuml: 'ü' };

function decodificarEntidades(texto) {
  return String(texto)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (ENTIDADES[n] !== undefined ? ENTIDADES[n] : m));
}

// HTML (a veces escapado, incluso doble o mezclado, como lo entrega GLPI/Formcreator:
// "&lt;p&gt;...", "&amp;lt;strong&amp;gt;...") a texto plano por líneas. Las celdas de
// tabla quedan separadas por TAB. Nunca deja etiquetas visibles en el resultado.
function htmlATexto(html) {
  let t = String(html == null ? '' : html);
  // Pela capas de escape mientras haya etiquetas escapadas (&lt;div, &amp;lt;strong…).
  for (let i = 0; i < 3 && /&(?:amp;)*lt;\s*\/?\s*[a-z!]/i.test(t); i += 1) t = decodificarEntidades(t);
  const sinEtiquetas = (x) => x
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|section|blockquote)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  t = sinEtiquetas(t);
  t = decodificarEntidades(t);
  t = sinEtiquetas(t); // por si tras decodificar quedaron etiquetas sueltas
  return t
    .split('\n')
    .map((l) => l.replace(/[  ]+/g, ' ').replace(/ ?\t ?/g, '\t').replace(/\t+$/g, '').trim())
    .filter((l) => l !== '')
    .join('\n');
}

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ----- Campos del formulario -----
// Devuelve [{ numero, etiqueta, valor, seccion, tabla: string[][] }] en el
// orden en que aparecen. Formato esperado de Formcreator:
//   "8) Fecha y hora requerida para el cambio : 2026-10-06 20:00"
// Las líneas siguientes que no empiezan un campo nuevo son continuación del
// valor; las que traen TAB son filas de una tabla del campo actual.
function extraerCampos(texto) {
  const lineas = String(texto).split('\n');
  const campos = [];
  let seccion = null;
  let actual = null;
  const reNumerado = /^(\d{1,3})\)\s*(.+?)\s*(?::\s*(.*))?$/;
  const reSeccion = /^[A-ZÁÉÍÓÚÑ0-9 ,.\-/()&]{6,}$/;

  for (const linea of lineas) {
    const m = linea.match(reNumerado);
    if (m && !linea.includes('\t')) {
      actual = { numero: Number(m[1]), etiqueta: m[2].trim(), valor: (m[3] || '').trim(), seccion, tabla: [] };
      campos.push(actual);
      continue;
    }
    if (reSeccion.test(linea) && !linea.includes(':') && !linea.includes('\t') && /[A-ZÁÉÍÓÚÑ]{4}/.test(linea)) {
      seccion = linea.trim();
      actual = null;
      continue;
    }
    if (!actual) continue;
    if (linea.includes('\t')) {
      actual.tabla.push(linea.split('\t').map((c) => c.trim()));
    } else {
      actual.valor = actual.valor ? `${actual.valor}\n${linea}` : linea;
    }
  }

  // Respaldo: si no hubo campos numerados, intentar "Etiqueta: valor".
  if (!campos.length) {
    for (const linea of lineas) {
      const m = linea.match(/^([^:\t]{3,80}):\s+(.+)$/);
      if (m) campos.push({ numero: campos.length + 1, etiqueta: m[1].trim(), valor: m[2].trim(), seccion: null, tabla: [] });
    }
  }
  return campos;
}

function buscarCampo(campos, ...patrones) {
  return campos.find((c) => {
    const e = normalizar(c.etiqueta);
    return patrones.some((p) => (p instanceof RegExp ? p.test(e) : e.includes(p)));
  }) || null;
}

// ----- Fechas y duraciones -----
function pad(n) { return String(n).padStart(2, '0'); }
function aInputDatetime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Acepta "2026-10-06 20:00", "06/10/2026 8:00 p. m.", "2026-10-06". Devuelve
// { fecha: 'YYYY-MM-DDTHH:mm', sinHora: boolean } o null.
function parsearFechaHora(texto) {
  if (!texto) return null;
  const t = String(texto).trim();
  let y; let mo; let d; let rest;
  let m = t.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(.*)$/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
  else {
    m = t.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})(.*)$/);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3]; rest = m[4];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let h = 0; let mi = 0; let sinHora = true;
  const hm = (rest || '').match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?/i);
  if (hm) {
    sinHora = false;
    h = +hm[1]; mi = +hm[2];
    const ampm = hm[3] ? hm[3].toLowerCase() : null;
    if (ampm === 'p' && h < 12) h += 12;
    if (ampm === 'a' && h === 12) h = 0;
  }
  if (h > 23 || mi > 59) return null;
  const fecha = new Date(y, mo - 1, d, h, mi);
  if (Number.isNaN(fecha.getTime())) return null;
  return { fecha: aInputDatetime(fecha), sinHora };
}

// "4 horas", "90 minutos", "1,5 h" -> minutos. null si no hay.
function parsearDuracionMinutos(texto) {
  if (!texto) return null;
  const m = String(texto).match(/(\d+(?:[.,]\d+)?)\s*(horas?|hrs?|h|minutos?|mins?)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return /^h/i.test(m[2]) ? Math.round(n * 60) : Math.round(n);
}

// ----- Servidores de la tabla "Aplicativos impactados" -----
const RE_IP = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

// Filas de servidor: celdas [nombre ("HOST - Rol"), url/ip, proceso]. Una fila
// sin host ni IP reconocible (ej. "App | https://appstore…") no es un servidor.
function extraerServidoresDeTabla(campos) {
  const filas = [];
  for (const campo of campos) {
    const e = normalizar(campo.etiqueta);
    if (!/aplicativ|servidor|infraestructura/.test(e) && !campo.tabla.some((f) => f.some((c) => RE_IP.test(c)))) continue;
    for (const fila of campo.tabla) {
      if (!fila.length) continue;
      const cabecera = normalizar(fila.join(' '));
      if (/nombre aplicativo|url ip|proceso al cual/.test(cabecera)) continue; // encabezado
      const texto = fila.join(' | ');
      const ip = (fila.map((c) => c.match(RE_IP)).find(Boolean) || [])[1] || null;
      const primera = fila[0] || '';
      const tokens = primera.split(/[\s\-–,;/()]+/).filter((t) => /^[A-Za-z][A-Za-z0-9_]{3,}\d+$/.test(t));
      if (!ip && !tokens.length) continue;
      filas.push({ texto, nombre: primera, ip, tokens });
    }
  }
  // sin duplicados por (primer token | ip)
  const vistos = new Set();
  return filas.filter((f) => {
    const clave = `${(f.tokens[0] || '').toLowerCase()}|${f.ip || ''}`;
    if (vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
}


// ----- Formato legible para la descripción -----
const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// 'YYYY-MM-DDTHH:mm' -> 'jueves 24/09/2026, 9:00 p. m.' (sin hora si no se conoce)
function fechaLegible(fechaInput, conHora = true) {
  const m = String(fechaInput || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const dia = `${DIAS_ES[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (!conHora) return dia;
  let h = d.getHours();
  const sufijo = h >= 12 ? 'p. m.' : 'a. m.';
  h = h % 12 || 12;
  return `${dia}, ${h}:${pad(d.getMinutes())} ${sufijo}`;
}

function duracionLegible(min) {
  if (!min) return '';
  const h = Math.floor(min / 60); const m = min % 60;
  if (!h) return `${m} min`;
  if (!m) return `${h} ${h === 1 ? 'hora' : 'horas'}`;
  return `${h} h ${m} min`;
}

// "- A - B - C" o varias líneas -> ['A', 'B', 'C']
function aItems(texto) {
  const t = String(texto || '').trim();
  if (!t) return [];
  return t.split(/\n+/)
    .flatMap((l) => l.split(/\s+[-–•]\s+(?=\S)/))
    .map((p) => p.replace(/^[-–•*·]\s*/, '').replace(/[;.]\s*$/, '').trim())
    .filter(Boolean);
}

function mayuscula(t) { const x = String(t || '').trim(); return x ? x.charAt(0).toUpperCase() + x.slice(1) : x; }

// ----- Armado de la propuesta -----
const ETIQUETAS_DESCRIPCION = [
  ['Tipo de cambio', ['tipo de cambio']],
  ['Objetivo del cambio', ['nombre del cambio']],
  ['Circunstancia del cambio', ['circunstancia', 'detallar brevemente']],
  ['Tiempo de estabilización', ['tiempo estabilizacion', 'estabilizacion']],
  ['Cargos requeridos en el despliegue', ['cargos requeridos', 'nombre cargos']],
  ['Plan de implementación', [/plan de (implementacion|despliegue|trabajo|pasos)/, 'plan de implementacion']],
  ['Plan de pruebas', [/plan de pruebas|pruebas (previas|post|funcionales)/]],
  ['Plan de rollback', [/rollback|reversion|plan de regreso|marcha atras/]],
  ['Respaldo', [/backup|respaldo|copia de seguridad/]],
  ['Impacto', [/impacto/]],
  ['Duración', [/duracion|ventana/]],
];

function limpiarLinea(texto, max) {
  const t = String(texto || '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// `entrada`: { ticket: {id, name, content, date, status, categoria, url}, actores: [...] }
// `catalogos`: { servidores: [{Id, IP, Hostname, Ambiente}], componentes: [{Id, ServidorId, Rol}], usuarios: [{id, username, nombre_completo}] }
function construirPropuesta(entrada, catalogos) {
  const { ticket } = entrada;
  const actores = entrada.actores || [];
  const texto = htmlATexto(ticket.content || '');
  const campos = extraerCampos(texto);
  const pendientes = [];
  const marcarPendiente = (campo, etiqueta, motivo) => pendientes.push({ campo, etiqueta, motivo });

  const rfc = String(ticket.id);
  const titulo = limpiarLinea(ticket.name || (buscarCampo(campos, 'nombre del cambio') || {}).valor || `Caso GLPI ${rfc}`, 200);

  // --- Fecha programada ---
  const cFecha = buscarCampo(campos, /fecha y hora requerida|fecha.*(requerid|program|ejecuci|implement|despliegue)/);
  let programada = cFecha ? parsearFechaHora(cFecha.valor) : null;
  if (!programada) marcarPendiente('fechaHoraProgramada', 'Fecha/hora programada', 'No se encontró la fecha requerida del cambio en el caso.');
  else if (programada.sinHora) marcarPendiente('fechaHoraProgramada', 'Hora programada', 'El caso trae la fecha pero no la hora; confirma la hora de inicio.');

  // --- Hora estimada de fin ---
  let minutos = null;
  const cDur = buscarCampo(campos, /duracion|tiempo (estimado )?(de )?ejecucion|ventana/);
  if (cDur) minutos = parsearDuracionMinutos(cDur.valor);
  if (minutos === null) {
    const m = texto.match(/duraci[oó]n[^.\n]{0,40}?(\d+(?:[.,]\d+)?\s*(?:horas?|hrs?|h|minutos?|mins?)\b)/i);
    if (m) minutos = parsearDuracionMinutos(m[1]);
  }
  let estimadaFin = null;
  if (programada && minutos !== null) {
    const fin = new Date(new Date(programada.fecha).getTime() + minutos * 60000);
    estimadaFin = aInputDatetime(fin);
  } else {
    marcarPendiente('fechaHoraEstimadaFin', 'Hora estimada de finalización', 'El caso no indica la duración de la ejecución.');
  }

  // --- Ambiente ---
  const cEntorno = buscarCampo(campos, /^(ambiente|entorno)$|ambiente (del|de) (cambio|despliegue)/);
  let entorno = null;
  const textoEntorno = normalizar(cEntorno ? cEntorno.valor : '');
  if (/produc/.test(textoEntorno)) entorno = 'PRODUCCION';
  else if (/\bqa\b|certific|pruebas/.test(textoEntorno)) entorno = 'QA';
  else if (/desarrollo|\bdev\b/.test(textoEntorno)) entorno = 'DESARROLLO';
  if (!entorno) {
    entorno = 'PRODUCCION';
    marcarPendiente('entorno', 'Ambiente', 'El caso no indica el ambiente; se propone Producción, confírmalo.');
  }

  // --- Servidores / aplicativos ---
  const servidoresTabla = extraerServidoresDeTabla(campos);
  const textoNorm = normalizar(`${ticket.name || ''} ${texto}`);
  const hallazgosServidores = [];
  const componenteIds = [];
  for (const fila of servidoresTabla) {
    const servidor = catalogos.servidores.find((s) =>
      fila.tokens.some((t) => String(s.Hostname).toLowerCase() === t.toLowerCase()) || (fila.ip && s.IP === fila.ip));
    if (!servidor) {
      hallazgosServidores.push({ texto: fila.texto, ip: fila.ip, hostname: fila.tokens[0] || null, servidorId: null, estado: 'no_inventario', componentes: [] });
      continue;
    }
    const candidatos = catalogos.componentes.filter((c) => c.ServidorId === servidor.Id);
    let elegido = null;
    if (candidatos.length === 1) elegido = candidatos[0];
    else if (candidatos.length > 1) {
      // Primero por el rol que trae la propia fila ("HOST - API" -> rol API_APP),
      // luego por el texto completo del caso.
      const palabrasFila = new Set(normalizar(String(fila.nombre || '').replace(/[A-Za-z][A-Za-z0-9_]{3,}\d+/g, ' ')).split(' ').filter((w) => w.length > 1));
      let coincidentes = palabrasFila.size
        ? candidatos.filter((c) => c.Rol && normalizar(c.Rol).split(' ').some((w) => palabrasFila.has(w)))
        : [];
      if (coincidentes.length !== 1) coincidentes = candidatos.filter((c) => c.Rol && textoNorm.includes(normalizar(c.Rol)));
      if (coincidentes.length === 1) elegido = coincidentes[0];
    }
    if (elegido) componenteIds.push(elegido.Id);
    hallazgosServidores.push({
      texto: fila.texto, ip: servidor.IP, hostname: servidor.Hostname, servidorId: servidor.Id,
      estado: elegido ? 'ok' : (candidatos.length ? 'elegir' : 'sin_componentes'),
      componenteId: elegido ? elegido.Id : null,
      componentes: candidatos.map((c) => ({ id: c.Id, nombre: c.Rol }))
    });
  }
  const idsUnicos = [...new Set(componenteIds)];
  if (!servidoresTabla.length) {
    marcarPendiente('componenteIds', 'Aplicativo / servidores', 'No se encontró la tabla de aplicativos impactados con servidores o IP.');
  } else {
    const sinResolver = hallazgosServidores.filter((h) => h.estado !== 'ok');
    if (!idsUnicos.length) {
      marcarPendiente('componenteIds', 'Aplicativo / servidores', 'Los servidores del caso no se pudieron asociar a un sub-aplicativo del inventario; elígelos a mano.');
    } else if (sinResolver.length) {
      marcarPendiente('componenteIds', 'Servidores sin asociar', `No se pudo asociar al inventario: ${sinResolver.map((h) => h.hostname || h.texto).join(', ')}.`);
    }
  }

  // --- Equipo (técnicos asignados al caso) ---
  const asignados = actores.filter((a) => a.tipo === 'asignado');
  const equipoIds = [];
  const equipoDetectado = [];
  for (const a of asignados) {
    const u = encontrarUsuario(catalogos.usuarios, a);
    equipoDetectado.push({ nombre: a.nombre || a.login, usuarioId: u ? u.id : null });
    if (u && !equipoIds.includes(u.id)) equipoIds.push(u.id);
  }
  if (!equipoIds.length) {
    marcarPendiente('equipo', 'Equipo', asignados.length
      ? 'Los técnicos asignados al caso no coinciden con usuarios de AXIS.'
      : 'El caso no tiene técnicos asignados.');
  } else if (equipoDetectado.some((e) => e.usuarioId === null)) {
    marcarPendiente('equipo', 'Equipo incompleto', `Sin usuario en AXIS: ${equipoDetectado.filter((e) => e.usuarioId === null).map((e) => e.nombre).join(', ')}.`);
  }

  // --- Descripción: resumen entendible de lo que se va a hacer ---
  const valorCampo = (...pat) => { const c = buscarCampo(campos, ...pat); return c && c.valor ? c.valor : ''; };
  const solicitante = valorCampo(/nombre colaborador|colaborador que realiza/);
  const cargo = valorCampo(/cargo del colaborador/);
  const objetivo = valorCampo('nombre del cambio') || titulo;
  const queHacer = aItems(valorCampo('circunstancia', 'detallar brevemente'));
  const tipoCambio = valorCampo('tipo de cambio').split('>').pop().trim();
  const estabilizacion = valorCampo('tiempo estabilizacion', 'estabilizacion');
  const aplicativo = valorCampo(/^aplicativos?$/);
  const indisponibilidad = valorCampo(/^indisponibilidad/);
  const observaciones = valorCampo(/^observaciones?$/);
  const planPruebas = valorCampo(/plan de pruebas|pruebas (previas|post|funcionales)/);
  const planRollback = valorCampo(/rollback|reversion|plan de regreso|marcha atras/);

  const bloques = [];
  const cab = [`Caso GLPI #${rfc}: ${objetivo}.`];
  if (solicitante) cab.push(`Solicitado por ${limpiarLinea(solicitante, 120)}${cargo ? ` (${limpiarLinea(cargo, 80)})` : ''}.`);
  if (tipoCambio) cab.push(`Tipo de cambio: ${mayuscula(limpiarLinea(tipoCambio, 80).toLowerCase())}.`);
  bloques.push(cab.join('\n'));

  bloques.push(['QUÉ SE VA A HACER', ...(queHacer.length ? queHacer : [objetivo]).map((i) => `- ${limpiarLinea(mayuscula(i), 300)}`)].join('\n'));

  const cuando = [];
  if (programada) {
    cuando.push(`Ejecución: ${fechaLegible(programada.fecha, !programada.sinHora).replace(/\.$/, '')}.`);
    if (minutos !== null) cuando.push(`Duración estimada: ${duracionLegible(minutos)}${estimadaFin ? ` (termina aprox. ${fechaLegible(estimadaFin)})` : ''}.`);
  }
  if (estabilizacion) cuando.push(`Estabilización hasta: ${limpiarLinea(estabilizacion, 80)}.`);
  if (cuando.length) bloques.push(['CUÁNDO', ...cuando].join('\n'));

  const donde = [];
  if (aplicativo) donde.push(`Aplicativo: ${limpiarLinea(aplicativo, 120)}.`);
  if (servidoresTabla.length) {
    donde.push(`Servidores: ${servidoresTabla.map((f) => (f.tokens[0] ? `${f.tokens[0]}${f.ip ? ` (${f.ip})` : ''}` : f.ip)).join(', ')}.`);
  }
  if (donde.length) bloques.push(['DÓNDE', ...donde].join('\n'));

  const nota = [];
  if (indisponibilidad) nota.push(/^\s*no\b/i.test(indisponibilidad) ? 'Sin indisponibilidad del servicio.' : `Indisponibilidad: ${limpiarLinea(indisponibilidad, 200)}.`);
  if (planPruebas) nota.push(`Pruebas: ${limpiarLinea(planPruebas, 250)}`);
  if (planRollback) nota.push(`Rollback: ${limpiarLinea(planRollback, 250)}`);
  if (observaciones) nota.push(`Observaciones: ${limpiarLinea(observaciones, 300)}`);
  if (nota.length) bloques.push(['TENER EN CUENTA', ...nota].join('\n'));

  if (ticket.url) bloques.push(`Caso en GLPI: ${ticket.url}`);
  if (!campos.length) bloques.splice(1, bloques.length - 1, limpiarLinea(texto, 1500), ...(ticket.url ? [`Caso en GLPI: ${ticket.url}`] : []));
  let descripcion = bloques.join('\n\n');
  if (descripcion.length > 3800) descripcion = `${descripcion.slice(0, 3799)}…`;

  // --- Checklist: solo lo que ejecuta el equipo de aplicaciones ---
  const checklist = [];
  const hosts = hallazgosServidores.map((h) => h.hostname).filter(Boolean);
  const dondeTxt = !hosts.length ? 'los servidores del aplicativo'
    : (hosts.length <= 3 ? hosts.join(', ') : `los ${hosts.length} servidores (${hosts.slice(0, 3).join(', ')}…)`);
  const hayBalanceo = hosts.length > 1 && /balance/i.test(texto);
  checklist.push(`Realizar respaldo (backup) de la aplicación y su configuración en ${dondeTxt}`);
  if (planRollback || /rollback/i.test(texto)) {
    const mr = parsearDuracionMinutos(planRollback || (texto.match(/rollback[^.\n]*/i) || [])[0]);
    checklist.push(`Tener listo el plan de rollback${mr ? ` (${mr} min)` : ''}`);
  }
  if (hayBalanceo) checklist.push('Sacar el nodo del balanceador antes de intervenirlo (despliegue por nodos)');
  checklist.push(`Detener la aplicación y sus servicios en ${dondeTxt}`);
  checklist.push(`Pasar las fuentes (nueva versión) a ${dondeTxt}`);
  checklist.push(`Subir los servicios en ${dondeTxt} y confirmar que inician sin errores`);
  if (hayBalanceo) checklist.push('Devolver el nodo al balanceador cuando esté validado');
  checklist.push('Validar que los servicios estén arriba y los logs sin errores');

  return {
    caso: {
      id: ticket.id, titulo: ticket.name || null, url: ticket.url || null, estado: ticket.status || null,
      fechaApertura: ticket.date || null, categoria: ticket.categoria || null
    },
    propuesta: {
      rfc, titulo, entorno,
      fechaHoraProgramada: programada ? programada.fecha : '',
      fechaHoraEstimadaFin: estimadaFin || '',
      descripcion, componenteIds: idsUnicos, equipoIds,
      checklist: checklist.map((c) => c.slice(0, 250))
    },
    hallazgos: { servidores: hallazgosServidores, equipo: equipoDetectado },
    pendientes,
    camposLeidos: campos.map((c) => ({ numero: c.numero, etiqueta: c.etiqueta, valor: limpiarLinea(c.valor, 300), filasTabla: c.tabla.length }))
  };
}

// Relaciona un actor de GLPI con un usuario de AXIS: primero por login (el
// mismo usuario de dominio), luego por nombre completo normalizado (al menos
// dos palabras en común).
function encontrarUsuario(usuarios, actor) {
  const login = normalizar(actor.login).replace(/ /g, '');
  if (login) {
    const porLogin = usuarios.find((u) => normalizar(u.username).replace(/ /g, '') === login);
    if (porLogin) return porLogin;
  }
  const palabras = new Set(normalizar(actor.nombre).split(' ').filter((p) => p.length > 2));
  if (palabras.size < 2) return null;
  let mejor = null; let mejorPuntaje = 1;
  for (const u of usuarios) {
    const comunes = normalizar(u.nombre_completo).split(' ').filter((p) => palabras.has(p)).length;
    if (comunes > mejorPuntaje) { mejor = u; mejorPuntaje = comunes; }
  }
  return mejor;
}

module.exports = {
  htmlATexto, normalizar, extraerCampos, parsearFechaHora, parsearDuracionMinutos,
  extraerServidoresDeTabla, construirPropuesta, encontrarUsuario, decodificarEntidades
};
