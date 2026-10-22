const express = require('express');
const { URL } = require('url');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { descubrirDocumento, normalizarDocumento } = require('../utils/swaggerLector');
const { peticionHttp, mensajeErrorRed, esTipoTexto, ENCABEZADOS_PROHIBIDOS } = require('../utils/swaggerCliente');
const {
  tablasListas, motivoNoDisponible, esEncabezadoSecreto, ocultarEncabezados, ocultarCuerpo, ocultarUrl, recortar,
} = require('../utils/swaggerDatos');

// ==========================================================================
// Módulo SWAGGER: lector de documentos Swagger/OpenAPI de servicios internos
// + consola para hacer consumos desde ahí, con consumos guardados e historial.
//
//  - Los orígenes (nombre + URL del Swagger) los registra quien tenga permiso
//    de edición del módulo y son PRIVADOS de quien los registra: nadie más los
//    ve (ni sus consumos guardados) hasta que su dueño los comparte, con todos
//    o con usuarios concretos. Quien recibe uno compartido puede verlo y
//    consumirlo, pero no modificarlo ni darlo de baja ni compartirlo. El
//    ADMIN_POD puede gestionar cualquiera (en la lista ve los suyos y los que
//    no tienen dueño; los demás solo si pide «ver todos»).
//  - El servidor SOLO consulta y consume hosts de un
//    origen registrado (el del propio Swagger o los que declara su documento),
//    para que el módulo no sirva de puente hacia cualquier host de la red.
//  - Ejecutar y guardar consumos requiere permiso de edición del módulo
//    (guardar, además, ser el dueño del origen).
//  - Los secretos (Authorization, API keys, contraseñas, tokens) no se guardan
//    en los consumos ni en el historial.
//  - Sin DELETE: los orígenes y consumos se desactivan (Activo = 0).
// ==========================================================================

router.use(verifyToken, requireModule('SWAGGER'));

const esAdminPod = (req) => req.user?.rol === 'ADMIN_POD';

const METODOS_VALIDOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MAX_CUERPO_PETICION = 1024 * 1024; // 1 MB
const MAX_CUERPO_GUARDADO = 200000;      // caracteres que se guardan de cuerpo de petición/respuesta
const MAX_CUERPO_RESPUESTA_UI = 1500000; // caracteres que se devuelven a la pantalla
const TOKEN_ENCABEZADO = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// ---------------------------------------------------------------------------
// ¿Existen las tablas? (todas las rutas menos /estado dependen de ellas)
// ---------------------------------------------------------------------------
router.get('/estado', async (req, res) => {
  try {
    const listas = await tablasListas(await getPool());
    res.json({ tablasListas: listas, mensaje: listas ? null : motivoNoDisponible() });
  } catch (error) {
    console.error('Error al consultar el estado del módulo Swagger:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.use(async (req, res, next) => {
  try {
    if (await tablasListas(await getPool())) return next();
    res.status(503).json({ error: motivoNoDisponible(), codigo: 'SIN_TABLAS' });
  } catch (error) {
    console.error('Error al verificar las tablas del módulo Swagger:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const aEntero = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function filaOrigen(f, req, compartidoCon = null) {
  const propio = f.CreadoPorId !== null && f.CreadoPorId !== undefined && Number(f.CreadoPorId) === Number(req.user.id);
  const gestiona = propio || esAdminPod(req);
  return {
    Id: f.Id, Nombre: f.Nombre, UrlSwagger: f.UrlSwagger, ValidarTls: !!f.ValidarTls, Notas: f.Notas || '',
    CreadoPor: f.CreadoPorUsername || null, FechaActualizacion: f.FechaActualizacion,
    Propio: propio, SinDueno: f.CreadoPorId === null || f.CreadoPorId === undefined, PuedeGestionar: gestiona,
    CompartidoTodos: !!f.CompartidoTodos,
    // Con cuántos usuarios concretos se compartió: solo lo ve quien lo gestiona.
    CompartidoCon: gestiona ? Number(compartidoCon || 0) : null,
  };
}

async function obtenerOrigen(pool, id) {
  const [filas] = await pool.query('SELECT * FROM swagger_origenes WHERE Id = ? AND Activo = 1', [id]);
  return filas[0] || null;
}

// ¿Qué puede hacer quien hace la petición con este origen?
//  'admin'      -> ADMIN_POD: todo.
//  'dueno'      -> quien lo registró: todo.
//  'compartido' -> se lo compartieron (con todos o con él): ver y consumir.
//  null         -> nada (para él el origen no existe).
async function accesoDe(pool, req, origen) {
  if (esAdminPod(req)) return 'admin';
  if (origen.CreadoPorId !== null && origen.CreadoPorId !== undefined && Number(origen.CreadoPorId) === Number(req.user.id)) return 'dueno';
  if (origen.CompartidoTodos) return 'compartido';
  const [filas] = await pool.query(
    'SELECT 1 FROM swagger_origenes_compartidos WHERE OrigenId = ? AND UsuarioId = ? AND Activo = 1 LIMIT 1',
    [origen.Id, req.user.id]
  );
  return filas.length ? 'compartido' : null;
}

const MENSAJE_SOLO_DUENO =
  'Este Swagger te lo compartieron: puedes verlo y consumirlo, pero solo su dueño puede modificarlo, darlo de baja o compartirlo.';

// Carga un origen y comprueba el acceso. Si no hay acceso responde 404 (para no revelar que existe) y devuelve null;
// con { gestionar: true } exige además ser el dueño (o ADMIN_POD) y responde 403 si solo lo tiene compartido.
async function cargarOrigen(req, res, id, { gestionar = false } = {}) {
  const idNum = aEntero(id);
  const pool = await getPool();
  const origen = idNum ? await obtenerOrigen(pool, idNum) : null;
  const acceso = origen ? await accesoDe(pool, req, origen) : null;
  if (!origen || !acceso) {
    res.status(404).json({ error: 'Origen no encontrado' });
    return null;
  }
  if (gestionar && acceso === 'compartido') {
    res.status(403).json({ error: MENSAJE_SOLO_DUENO });
    return null;
  }
  return { pool, origen, acceso };
}

function leerOrigen(body) {
  const Nombre = String(body.Nombre || '').trim();
  const UrlSwagger = String(body.UrlSwagger || '').trim();
  if (!Nombre) return { error: 'El nombre es obligatorio' };
  if (Nombre.length > 100) return { error: 'El nombre no puede superar 100 caracteres' };
  if (!UrlSwagger) return { error: 'La URL del Swagger es obligatoria' };
  if (UrlSwagger.length > 500) return { error: 'La URL no puede superar 500 caracteres' };
  let u;
  try { u = new URL(UrlSwagger); } catch (_) { return { error: 'La URL del Swagger no es válida' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'La URL debe empezar por http:// o https://' };
  if (u.username || u.password) return { error: 'La URL no debe incluir usuario ni contraseña' };
  const Notas = String(body.Notas || '').trim().slice(0, 500) || null;
  return { valores: { Nombre, UrlSwagger, ValidarTls: body.ValidarTls ? 1 : 0, Notas } };
}

const ETIQUETAS_ORIGEN = { Nombre: 'Nombre', UrlSwagger: 'URL del Swagger', ValidarTls: 'Validar certificado TLS', Notas: 'Notas' };

// ---- Caché del documento (se relee cada 2 min o al pedir "refrescar") ----
const TTL_SPEC_MS = 120000;
const cacheSpec = new Map(); // `${origenId}:${definicion}` -> { hasta, valor, huella }

function huellaOrigen(origen) {
  return `${origen.UrlSwagger}|${origen.ValidarTls ? 1 : 0}`;
}

function invalidarSpec(origenId) {
  for (const k of [...cacheSpec.keys()]) if (k.startsWith(`${origenId}:`)) cacheSpec.delete(k);
}

async function cargarSpec(origen, definicion = 0, refrescar = false) {
  const clave = `${origen.Id}:${definicion}`;
  const guardado = cacheSpec.get(clave);
  if (!refrescar && guardado && guardado.hasta > Date.now() && guardado.huella === huellaOrigen(origen)) return guardado.valor;

  const hallado = await descubrirDocumento(origen.UrlSwagger, { validarTls: !!origen.ValidarTls, definicion });
  const valor = {
    definiciones: hallado.definiciones,
    definicion: hallado.elegida,
    urlDocumento: hallado.urlDocumento,
    ...normalizarDocumento(hallado.doc, hallado.urlDocumento),
  };
  cacheSpec.set(clave, { hasta: Date.now() + TTL_SPEC_MS, valor, huella: huellaOrigen(origen) });
  return valor;
}

// ---- Hosts a los que se puede consumir ----
function puertoDe(u) {
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}
function claveHost(u) {
  return `${u.hostname.toLowerCase()}:${puertoDe(u)}`;
}
const HOST_SENSIBLE = /^(localhost|127\.|0\.0\.0\.0|169\.254\.|\[?::1\]?$|\[?fe80:)/i;

function hostsPermitidos(origen) {
  const permitidos = new Set();
  const base = new URL(origen.UrlSwagger);
  permitidos.add(claveHost(base));
  // Servidores que declara el documento ya leído (de cualquiera de sus definiciones en caché).
  for (const [k, v] of cacheSpec.entries()) {
    if (!k.startsWith(`${origen.Id}:`) || v.huella !== huellaOrigen(origen)) continue;
    (v.valor.servidores || []).forEach((s) => {
      try {
        const u = new URL(s);
        if (!HOST_SENSIBLE.test(u.hostname)) permitidos.add(claveHost(u));
      } catch (_) { /* servidor no válido: se ignora */ }
    });
  }
  return permitidos;
}

// ---------------------------------------------------------------------------
// ORÍGENES
// ---------------------------------------------------------------------------
router.get('/origenes', async (req, res) => {
  try {
    const pool = await getPool();
    const uid = req.user.id;
    const admin = esAdminPod(req);
    const verTodos = admin && req.query.todos === '1';
    // Cada quien ve: los suyos, los compartidos con todos y los compartidos con él. El ADMIN_POD, además, los que no tienen dueño
    // (y, si lo pide, todos).
    const visible = verTodos
      ? { sql: '1 = 1', params: [] }
      : {
        sql: `(o.CreadoPorId = ? OR o.CompartidoTodos = 1
               OR EXISTS (SELECT 1 FROM swagger_origenes_compartidos c WHERE c.OrigenId = o.Id AND c.UsuarioId = ? AND c.Activo = 1)
               ${admin ? 'OR o.CreadoPorId IS NULL' : ''})`,
        params: [uid, uid],
      };
    const [filas] = await pool.query(
      `SELECT o.*,
              (SELECT COUNT(*) FROM swagger_origenes_compartidos c WHERE c.OrigenId = o.Id AND c.Activo = 1) AS NCompartidos
         FROM swagger_origenes o
        WHERE o.Activo = 1 AND ${visible.sql}
        ORDER BY (o.CreadoPorId <=> ?) DESC, o.Nombre`,
      [...visible.params, uid]
    );
    const mapa = new Map();
    if (filas.length) {
      const [conteos] = await pool.query(
        'SELECT OrigenId, COUNT(*) AS n FROM swagger_consumos WHERE Activo = 1 AND OrigenId IN (?) GROUP BY OrigenId',
        [filas.map((f) => f.Id)]
      );
      conteos.forEach((c) => mapa.set(c.OrigenId, Number(c.n)));
    }
    res.json(filas.map((f) => ({ ...filaOrigen(f, req, f.NCompartidos), Consumos: mapa.get(f.Id) || 0 })));
  } catch (error) {
    console.error('Error al listar los orígenes Swagger:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// Prueba una URL (sin guardarla): ¿se encuentra el documento? ¿cuántos endpoints trae?
router.post('/origenes/probar', requireEditPermission, async (req, res) => {
  const { valores, error } = leerOrigen({ Nombre: 'prueba', ...req.body });
  if (error) return res.status(400).json({ error });
  try {
    const hallado = await descubrirDocumento(valores.UrlSwagger, { validarTls: !!valores.ValidarTls });
    const n = normalizarDocumento(hallado.doc, hallado.urlDocumento);
    res.json({
      ok: true, titulo: n.info.titulo, version: n.info.version, especificacion: n.info.especificacion,
      operaciones: n.totalOperaciones, definiciones: hallado.definiciones, urlDocumento: hallado.urlDocumento,
    });
  } catch (e) {
    res.status(422).json({ ok: false, error: e.message || 'No se pudo leer el Swagger' });
  }
});

router.post('/origenes', requireEditPermission, async (req, res) => {
  const { valores, error } = leerOrigen(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const pool = await getPool();
    // El nombre solo debe ser único entre MIS orígenes (los de los demás son privados y no se pueden ver).
    const [dup] = await pool.query('SELECT Id FROM swagger_origenes WHERE Activo = 1 AND LOWER(Nombre) = LOWER(?) AND CreadoPorId <=> ?', [valores.Nombre, req.user.id]);
    if (dup.length) return res.status(409).json({ error: 'Ya tienes un origen con ese nombre' });
    const [r] = await pool.query(
      'INSERT INTO swagger_origenes (Nombre, UrlSwagger, ValidarTls, Notas, CreadoPorId, CreadoPorUsername) VALUES (?, ?, ?, ?, ?, ?)',
      [valores.Nombre, valores.UrlSwagger, valores.ValidarTls, valores.Notas, req.user.id, req.user.username]
    );
    const origen = await obtenerOrigen(pool, r.insertId);
    await registrarEventoGeneral(pool, req, {
      modulo: 'SWAGGER', entidad: 'Origen Swagger', entidadId: r.insertId, entidadNombre: valores.Nombre, accion: 'CREACION',
      detalle: `Origen registrado (privado): ${valores.UrlSwagger}`,
    });
    res.status(201).json(filaOrigen(origen, req));
  } catch (e) {
    console.error('Error al crear el origen Swagger:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

router.put('/origenes/:id', requireEditPermission, async (req, res) => {
  const { valores, error } = leerOrigen(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const cargado = await cargarOrigen(req, res, req.params.id, { gestionar: true });
    if (!cargado) return;
    const { pool, origen: antes } = cargado;
    const [dup] = await pool.query('SELECT Id FROM swagger_origenes WHERE Activo = 1 AND LOWER(Nombre) = LOWER(?) AND CreadoPorId <=> ? AND Id <> ?', [valores.Nombre, antes.CreadoPorId, antes.Id]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe otro origen tuyo con ese nombre' });
    await pool.query(
      'UPDATE swagger_origenes SET Nombre = ?, UrlSwagger = ?, ValidarTls = ?, Notas = ? WHERE Id = ?',
      [valores.Nombre, valores.UrlSwagger, valores.ValidarTls, valores.Notas, antes.Id]
    );
    invalidarSpec(antes.Id);
    const despues = await obtenerOrigen(pool, antes.Id);
    const cambios = diffCampos(
      { ...antes, ValidarTls: !!antes.ValidarTls }, { ...despues, ValidarTls: !!despues.ValidarTls },
      Object.keys(ETIQUETAS_ORIGEN), ETIQUETAS_ORIGEN, { ValidarTls: (v) => (v ? 'Sí' : 'No') }
    );
    await registrarEventoGeneral(pool, req, {
      modulo: 'SWAGGER', entidad: 'Origen Swagger', entidadId: antes.Id, entidadNombre: despues.Nombre, accion: 'EDICION', cambios,
    });
    res.json(filaOrigen(despues, req));
  } catch (e) {
    console.error('Error al actualizar el origen Swagger:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

// "Eliminar" = desactivar (el usuario de BD no necesita DELETE). Sus consumos guardados se conservan.
router.delete('/origenes/:id', requireEditPermission, async (req, res) => {
  try {
    const cargado = await cargarOrigen(req, res, req.params.id, { gestionar: true });
    if (!cargado) return;
    const { pool, origen } = cargado;
    await pool.query('UPDATE swagger_origenes SET Activo = 0 WHERE Id = ?', [origen.Id]);
    invalidarSpec(origen.Id);
    await registrarEventoGeneral(pool, req, {
      modulo: 'SWAGGER', entidad: 'Origen Swagger', entidadId: origen.Id, entidadNombre: origen.Nombre, accion: 'ELIMINACION',
      detalle: `Origen dado de baja (${origen.UrlSwagger})`,
    });
    res.status(204).send();
  } catch (e) {
    console.error('Error al dar de baja el origen Swagger:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

// Documento ya normalizado: endpoints, parámetros, cuerpos de ejemplo...
router.get('/origenes/:id/spec', async (req, res) => {
  try {
    const cargado = await cargarOrigen(req, res, req.params.id);
    if (!cargado) return;
    const spec = await cargarSpec(cargado.origen, Number(req.query.def) || 0, req.query.refrescar === '1');
    res.json(spec);
  } catch (e) {
    console.error('Error al leer el Swagger:', e.message);
    res.status(422).json({ error: e.message || 'No se pudo leer el Swagger' });
  }
});

// ---------------------------------------------------------------------------
// COMPARTIR (solo el dueño del origen o el ADMIN_POD)
// ---------------------------------------------------------------------------
const nombreUsuario = (u) => (u.Nombre ? `${u.Nombre} (${u.Username})` : u.Username || `#${u.Id}`);

// Usuarios con quien se puede compartir: activos, con el módulo Swagger habilitado (o ADMIN_POD), sin contar al dueño ni a quien comparte.
async function candidatosParaCompartir(pool, origen, req) {
  const [filas] = await pool.query(
    `SELECT u.id AS Id, u.username AS Username, u.nombre_completo AS Nombre, u.rol AS Rol
       FROM usuarios u
      WHERE u.activo = 1
        AND (u.rol = 'ADMIN_POD' OR EXISTS (
              SELECT 1 FROM usuario_modulos um INNER JOIN modulos m ON m.id = um.modulo_id
               WHERE um.usuario_id = u.id AND m.nombre = 'SWAGGER'))
      ORDER BY u.nombre_completo, u.username`
  );
  const excluidos = new Set([Number(req.user.id), Number(origen.CreadoPorId)]);
  return filas.filter((u) => !excluidos.has(Number(u.Id)));
}

async function usuariosConAcceso(pool, origenId) {
  const [filas] = await pool.query(
    `SELECT c.UsuarioId AS Id, u.username AS Username, u.nombre_completo AS Nombre
       FROM swagger_origenes_compartidos c LEFT JOIN usuarios u ON u.id = c.UsuarioId
      WHERE c.OrigenId = ? AND c.Activo = 1 ORDER BY u.nombre_completo, u.username`,
    [origenId]
  );
  return filas;
}

router.get('/origenes/:id/comparticion', async (req, res) => {
  try {
    const cargado = await cargarOrigen(req, res, req.params.id, { gestionar: true });
    if (!cargado) return;
    const { pool, origen } = cargado;
    res.json({
      compartidoTodos: !!origen.CompartidoTodos,
      usuarios: await usuariosConAcceso(pool, origen.Id),
      candidatos: await candidatosParaCompartir(pool, origen, req),
    });
  } catch (e) {
    console.error('Error al leer con quién se comparte el origen Swagger:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

// Reemplaza con quién se comparte: { compartidoTodos: boolean, usuarios: [ids] }. «Dejar de compartir» = desactivar (sin DELETE).
router.put('/origenes/:id/comparticion', async (req, res) => {
  try {
    const cargado = await cargarOrigen(req, res, req.params.id, { gestionar: true });
    if (!cargado) return;
    const { pool, origen } = cargado;

    const b = req.body || {};
    if (b.usuarios !== undefined && !Array.isArray(b.usuarios)) return res.status(400).json({ error: 'La lista de usuarios no es válida' });
    const pedidos = [...new Set((b.usuarios || []).map(aEntero))];
    if (pedidos.includes(null)) return res.status(400).json({ error: 'La lista de usuarios no es válida' });
    if (pedidos.length > 300) return res.status(400).json({ error: 'Máximo 300 usuarios' });
    const todos = b.compartidoTodos ? 1 : 0;

    const actuales = await usuariosConAcceso(pool, origen.Id);
    const idsActuales = new Set(actuales.map((u) => Number(u.Id)));
    const candidatos = await candidatosParaCompartir(pool, origen, req);
    const idsPermitidos = new Set(candidatos.map((u) => Number(u.Id)));
    // Solo se pueden AGREGAR usuarios válidos; los que ya tenían acceso pueden mantenerse aunque hoy ya no sean candidatos.
    if (pedidos.some((id) => !idsPermitidos.has(id) && !idsActuales.has(id))) {
      return res.status(400).json({ error: 'Hay usuarios que no existen, están inactivos o no tienen habilitado el módulo Swagger.' });
    }

    const nuevos = new Set(pedidos);
    const agregar = pedidos.filter((id) => !idsActuales.has(id));
    const quitar = [...idsActuales].filter((id) => !nuevos.has(id));
    const cambioTodos = !!origen.CompartidoTodos !== !!todos;
    if (!agregar.length && !quitar.length && !cambioTodos) {
      return res.json({ compartidoTodos: !!todos, usuarios: actuales, candidatos });
    }

    if (cambioTodos) await pool.query('UPDATE swagger_origenes SET CompartidoTodos = ? WHERE Id = ?', [todos, origen.Id]);
    for (const id of agregar) {
      await pool.query(
        `INSERT INTO swagger_origenes_compartidos (OrigenId, UsuarioId, Activo, CompartidoPorId, CompartidoPorUsername)
         VALUES (?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE Activo = 1, CompartidoPorId = VALUES(CompartidoPorId), CompartidoPorUsername = VALUES(CompartidoPorUsername)`,
        [origen.Id, id, req.user.id, req.user.username]
      );
    }
    if (quitar.length) {
      await pool.query('UPDATE swagger_origenes_compartidos SET Activo = 0 WHERE OrigenId = ? AND UsuarioId IN (?)', [origen.Id, quitar]);
    }

    const despues = await usuariosConAcceso(pool, origen.Id);
    const cambios = [];
    if (cambioTodos) cambios.push({ campo: 'CompartidoTodos', etiqueta: 'Compartido con todos', anterior: origen.CompartidoTodos ? 'Sí' : 'No', nuevo: todos ? 'Sí' : 'No' });
    if (agregar.length || quitar.length) {
      const lista = (arr) => (arr.length ? arr.map(nombreUsuario).join(', ') : 'nadie');
      cambios.push({ campo: 'CompartidoCon', etiqueta: 'Compartido con', anterior: lista(actuales), nuevo: lista(despues) });
    }
    await registrarEventoGeneral(pool, req, {
      modulo: 'SWAGGER', entidad: 'Origen Swagger', entidadId: origen.Id, entidadNombre: origen.Nombre, accion: 'EDICION',
      detalle: 'Cambio de con quién se comparte el origen', cambios,
    });
    res.json({ compartidoTodos: !!todos, usuarios: despues, candidatos });
  } catch (e) {
    console.error('Error al compartir el origen Swagger:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

// ---------------------------------------------------------------------------
// EJECUCIÓN
// ---------------------------------------------------------------------------
function leerListaClaveValor(lista, nombreCampo) {
  if (lista === undefined || lista === null) return { valores: [] };
  if (!Array.isArray(lista)) return { error: `${nombreCampo} debe ser una lista` };
  if (lista.length > 100) return { error: `${nombreCampo}: máximo 100 elementos` };
  const valores = [];
  for (const it of lista) {
    const k = String(it?.k ?? '').trim();
    if (!k) continue;
    if (it.activo === false) continue;
    valores.push({ k, v: it?.v === undefined || it?.v === null ? '' : String(it.v) });
  }
  return { valores };
}

function aTextoRespuesta(buffer, contentType) {
  if (!buffer || !buffer.length) return { texto: '', binario: false };
  if (esTipoTexto(contentType)) return { texto: buffer.toString('utf8'), binario: false };
  return { texto: null, binario: true };
}

async function guardarHistorial(pool, d) {
  try {
    const [r] = await pool.query(
      `INSERT INTO swagger_historial
        (OrigenId, ConsumoId, Metodo, Url, RequestHeadersJson, RequestBody, Estado, EstadoTexto, DuracionMs,
         ResponseHeadersJson, ResponseBody, ResponseBytes, Truncado, Error, UsuarioId, Username)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.origenId, d.consumoId || null, d.metodo, recortar(d.url, 1500),
        JSON.stringify(d.requestHeaders || {}), recortar(d.requestBody, MAX_CUERPO_GUARDADO),
        d.estado ?? null, recortar(d.estadoTexto, 100), d.duracionMs ?? null,
        d.responseHeaders ? recortar(JSON.stringify(d.responseHeaders), 60000) : null,
        recortar(d.responseBody, MAX_CUERPO_GUARDADO), d.responseBytes ?? null, d.truncado ? 1 : 0,
        recortar(d.error, 500), d.usuarioId ?? null, d.username ?? null,
      ]
    );
    return r.insertId;
  } catch (e) {
    console.error('No se pudo guardar el historial Swagger:', e.message);
    return null;
  }
}

router.post('/origenes/:id/ejecutar', requireEditPermission, async (req, res) => {
  try {
    const cargado = await cargarOrigen(req, res, req.params.id);
    if (!cargado) return;
    const { pool, origen } = cargado;

    const b = req.body || {};
    const metodo = String(b.metodo || '').toUpperCase();
    if (!METODOS_VALIDOS.includes(metodo)) return res.status(400).json({ error: `Método no permitido (${METODOS_VALIDOS.join(', ')})` });

    // Base: debe ser un host del origen registrado.
    const baseTexto = String(b.baseUrl || '').trim() || new URL(origen.UrlSwagger).origin;
    let base;
    try { base = new URL(baseTexto); } catch (_) { return res.status(400).json({ error: 'La URL base no es válida' }); }
    if (!/^https?:$/.test(base.protocol)) return res.status(400).json({ error: 'La URL base debe ser http o https' });
    if (base.username || base.password) return res.status(400).json({ error: 'La URL base no debe incluir usuario ni contraseña' });

    // Si aún no se leyó el documento, se intenta para conocer los servidores que declara (si falla, solo vale el origen).
    if (![...cacheSpec.keys()].some((k) => k.startsWith(`${origen.Id}:`))) {
      try { await cargarSpec(origen, 0, false); } catch (_) { /* solo se usará el host del origen */ }
    }
    if (!hostsPermitidos(origen).has(claveHost(base))) {
      return res.status(400).json({
        error: `El host ${claveHost(base)} no pertenece a este origen. Solo se puede consumir el host del Swagger o los servidores que declara su documento.`,
      });
    }

    // Ruta + parámetros de ruta
    const ruta = String(b.ruta || '').trim();
    if (!ruta.startsWith('/') || ruta.startsWith('//')) return res.status(400).json({ error: 'La ruta debe empezar por una sola "/"' });
    const pathParams = b.pathParams && typeof b.pathParams === 'object' ? b.pathParams : {};
    let faltante = null;
    const rutaFinal = ruta.replace(/\{([^}/]+)\}/g, (_, nombre) => {
      const v = pathParams[nombre];
      if (v === undefined || v === null || String(v) === '') { faltante = faltante || nombre; return ''; }
      return encodeURIComponent(String(v));
    });
    if (faltante) return res.status(400).json({ error: `Falta el parámetro de ruta «${faltante}»` });

    const query = leerListaClaveValor(b.query, 'query');
    if (query.error) return res.status(400).json({ error: query.error });
    const encabezadosIn = leerListaClaveValor(b.headers, 'headers');
    if (encabezadosIn.error) return res.status(400).json({ error: encabezadosIn.error });

    let url;
    try {
      url = new URL(base.toString().replace(/\/+$/, '') + rutaFinal);
    } catch (_) { return res.status(400).json({ error: 'No se pudo armar la URL' }); }
    if (claveHost(url) !== claveHost(base)) return res.status(400).json({ error: 'La ruta no puede cambiar el host' });
    query.valores.forEach((q) => url.searchParams.append(q.k, q.v));

    // Encabezados
    const headers = {};
    for (const h of encabezadosIn.valores) {
      const nombre = h.k;
      if (!TOKEN_ENCABEZADO.test(nombre)) return res.status(400).json({ error: `Nombre de encabezado no válido: ${nombre}` });
      if (ENCABEZADOS_PROHIBIDOS.has(nombre.toLowerCase())) continue;
      if (/[\r\n]/.test(h.v)) return res.status(400).json({ error: `El valor del encabezado ${nombre} no es válido` });
      headers[nombre] = h.v;
    }

    // Cuerpo
    let cuerpo = b.cuerpo === undefined || b.cuerpo === null ? '' : String(b.cuerpo);
    if (Buffer.byteLength(cuerpo, 'utf8') > MAX_CUERPO_PETICION) return res.status(400).json({ error: 'El cuerpo supera 1 MB' });
    if (cuerpo && ['GET', 'HEAD'].includes(metodo)) cuerpo = ''; // GET/HEAD no llevan cuerpo
    if (cuerpo && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = String(b.tipoContenido || 'application/json').slice(0, 100);
    }

    const timeoutMs = Math.min(Math.max(Number(b.timeoutMs) || 30000, 1000), 120000);
    const consumoId = Number(b.consumoId) || null;
    const urlFinal = url.toString();
    const base_historial = {
      origenId: origen.Id, consumoId, metodo, url: ocultarUrl(urlFinal),
      requestHeaders: ocultarEncabezados(headers), requestBody: ocultarCuerpo(cuerpo),
      usuarioId: req.user.id, username: req.user.username,
    };

    let r;
    try {
      r = await peticionHttp(url, { metodo, headers, body: cuerpo || null, validarTls: !!origen.ValidarTls, timeoutMs });
    } catch (e) {
      const mensaje = mensajeErrorRed(e);
      const historialId = await guardarHistorial(pool, { ...base_historial, error: mensaje });
      return res.status(502).json({ error: mensaje, historialId, url: urlFinal });
    }

    const tipo = r.headers['content-type'] || '';
    const { texto, binario } = aTextoRespuesta(r.buffer, tipo);
    const headersRespuesta = {};
    Object.entries(r.headers).forEach(([k, v]) => { headersRespuesta[k] = Array.isArray(v) ? v.join('; ') : String(v); });

    const historialId = await guardarHistorial(pool, {
      ...base_historial,
      estado: r.status, estadoTexto: r.statusTexto, duracionMs: r.duracionMs,
      responseHeaders: ocultarEncabezados(headersRespuesta),
      responseBody: binario ? `(contenido binario, ${r.buffer.length} bytes)` : ocultarCuerpo(texto),
      responseBytes: r.buffer.length, truncado: r.truncado,
    });

    if (metodo !== 'GET' && metodo !== 'HEAD') {
      try {
        await registrarEventoGeneral(pool, req, {
          modulo: 'SWAGGER', entidad: 'Consumo Swagger', entidadId: consumoId, entidadNombre: origen.Nombre, accion: 'EJECUCION',
          detalle: recortar(`${metodo} ${ocultarUrl(urlFinal)} → ${r.status}`, 500),
        });
      } catch (e) { console.error('No se pudo auditar la ejecución Swagger:', e.message); }
    }

    const cuerpoUi = binario ? null : (texto.length > MAX_CUERPO_RESPUESTA_UI ? texto.slice(0, MAX_CUERPO_RESPUESTA_UI) : texto);
    res.json({
      estado: r.status, estadoTexto: r.statusTexto, duracionMs: r.duracionMs, url: urlFinal,
      headers: headersRespuesta, tipoContenido: tipo, cuerpo: cuerpoUi, binario, bytes: r.buffer.length,
      truncado: r.truncado || (!binario && texto.length > MAX_CUERPO_RESPUESTA_UI), historialId,
    });
  } catch (e) {
    console.error('Error al ejecutar el consumo Swagger:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

// ---------------------------------------------------------------------------
// CONSUMOS GUARDADOS (van con su origen: los ve quien ve el origen; solo el dueño los crea/modifica)
// ---------------------------------------------------------------------------
const ETIQUETAS_CONSUMO = {
  Nombre: 'Nombre', Metodo: 'Método', Ruta: 'Ruta', BaseUrl: 'URL base', Grupo: 'Grupo', Cuerpo: 'Cuerpo', TipoContenido: 'Tipo de contenido', Notas: 'Notas',
};
const FORMATEADORES_CONSUMO = { Cuerpo: (v) => (v ? `(${String(v).length} caracteres)` : null) };

function filaConsumo(f) {
  let parametros = { path: {}, query: [], headers: [] };
  try { parametros = { ...parametros, ...JSON.parse(f.ParametrosJson || '{}') }; } catch (_) { /* se deja vacío */ }
  return {
    Id: f.Id, OrigenId: f.OrigenId, Nombre: f.Nombre, Metodo: f.Metodo, Ruta: f.Ruta, BaseUrl: f.BaseUrl || '',
    OperacionId: f.OperacionId || '', Grupo: f.Grupo || '', Parametros: parametros, Cuerpo: f.Cuerpo || '',
    TipoContenido: f.TipoContenido || '', Notas: f.Notas || '', CreadoPor: f.CreadoPorUsername || null,
    FechaCreacion: f.FechaCreacion, FechaActualizacion: f.FechaActualizacion,
  };
}

function difiereJson(a, b) {
  try { return JSON.stringify(JSON.parse(a)) !== JSON.stringify(JSON.parse(b)); } catch (_) { return false; }
}

function leerConsumo(body) {
  const Nombre = String(body.Nombre || '').trim();
  if (!Nombre) return { error: 'El nombre del consumo es obligatorio' };
  if (Nombre.length > 150) return { error: 'El nombre no puede superar 150 caracteres' };
  const Metodo = String(body.Metodo || '').toUpperCase();
  if (!METODOS_VALIDOS.includes(Metodo)) return { error: 'Método no válido' };
  const Ruta = String(body.Ruta || '').trim();
  if (!Ruta.startsWith('/') || Ruta.startsWith('//')) return { error: 'La ruta debe empezar por una sola "/"' };
  if (Ruta.length > 500) return { error: 'La ruta es demasiado larga' };
  const p = body.Parametros || {};
  const query = leerListaClaveValor(p.query, 'query');
  if (query.error) return { error: query.error };
  const headers = leerListaClaveValor(p.headers, 'headers');
  if (headers.error) return { error: headers.error };
  const path = {};
  Object.entries(p.path && typeof p.path === 'object' ? p.path : {}).slice(0, 50).forEach(([k, v]) => { path[String(k)] = v === null || v === undefined ? '' : String(v); });

  // Nada secreto se guarda: encabezados/parámetros/campos con nombre sensible quedan con el valor vacío.
  const parametros = {
    path,
    query: query.valores.map((q) => ({ k: q.k, v: esEncabezadoSecreto(q.k) ? '' : q.v })),
    headers: ocultarEncabezados(headers.valores, ''),
  };
  const Cuerpo = body.Cuerpo === undefined || body.Cuerpo === null || String(body.Cuerpo).trim() === '' ? null : ocultarCuerpo(String(body.Cuerpo), '');
  if (Cuerpo && Cuerpo.length > MAX_CUERPO_GUARDADO) return { error: `El cuerpo es demasiado largo (máximo ${MAX_CUERPO_GUARDADO} caracteres)` };
  return {
    valores: {
      Nombre, Metodo, Ruta,
      BaseUrl: recortar(String(body.BaseUrl || '').trim(), 300) || null,
      OperacionId: recortar(String(body.OperacionId || '').trim(), 200) || null,
      Grupo: recortar(String(body.Grupo || '').trim(), 100) || null,
      ParametrosJson: JSON.stringify(parametros),
      Cuerpo,
      TipoContenido: recortar(String(body.TipoContenido || '').trim(), 100) || null,
      Notas: recortar(String(body.Notas || '').trim(), 500) || null,
    },
    // ¿Se omitió algún valor sensible al guardar? (para avisarle al usuario)
    secretosOmitidos:
      headers.valores.some((h) => esEncabezadoSecreto(h.k) && h.v !== '') ||
      query.valores.some((q) => esEncabezadoSecreto(q.k) && q.v !== '') ||
      (Cuerpo !== null && difiereJson(String(body.Cuerpo), Cuerpo)),
  };
}

router.get('/origenes/:id/consumos', async (req, res) => {
  try {
    const cargado = await cargarOrigen(req, res, req.params.id);
    if (!cargado) return;
    const [filas] = await cargado.pool.query('SELECT * FROM swagger_consumos WHERE OrigenId = ? AND Activo = 1 ORDER BY Grupo, Nombre', [cargado.origen.Id]);
    res.json(filas.map(filaConsumo));
  } catch (e) {
    console.error('Error al listar los consumos guardados:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

router.post('/origenes/:id/consumos', requireEditPermission, async (req, res) => {
  const { valores, error, secretosOmitidos } = leerConsumo(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const cargado = await cargarOrigen(req, res, req.params.id, { gestionar: true });
    if (!cargado) return;
    const { pool, origen } = cargado;
    const [dup] = await pool.query('SELECT Id FROM swagger_consumos WHERE OrigenId = ? AND Activo = 1 AND LOWER(Nombre) = LOWER(?)', [origen.Id, valores.Nombre]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe un consumo guardado con ese nombre en este origen' });
    const [r] = await pool.query(
      `INSERT INTO swagger_consumos (OrigenId, Nombre, Metodo, Ruta, BaseUrl, OperacionId, Grupo, ParametrosJson, Cuerpo, TipoContenido, Notas, CreadoPorId, CreadoPorUsername)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [origen.Id, valores.Nombre, valores.Metodo, valores.Ruta, valores.BaseUrl, valores.OperacionId, valores.Grupo, valores.ParametrosJson,
        valores.Cuerpo, valores.TipoContenido, valores.Notas, req.user.id, req.user.username]
    );
    const [filas] = await pool.query('SELECT * FROM swagger_consumos WHERE Id = ?', [r.insertId]);
    await registrarEventoGeneral(pool, req, {
      modulo: 'SWAGGER', entidad: 'Consumo guardado', entidadId: r.insertId, entidadNombre: valores.Nombre, accion: 'CREACION',
      detalle: `${valores.Metodo} ${valores.Ruta} (${origen.Nombre})`,
    });
    res.status(201).json({ ...filaConsumo(filas[0]), SecretosOmitidos: !!secretosOmitidos });
  } catch (e) {
    console.error('Error al guardar el consumo:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

router.put('/consumos/:cid', requireEditPermission, async (req, res) => {
  const { valores, error, secretosOmitidos } = leerConsumo(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const pool = await getPool();
    const [antesFilas] = await pool.query('SELECT * FROM swagger_consumos WHERE Id = ? AND Activo = 1', [aEntero(req.params.cid) || 0]);
    if (!antesFilas.length) return res.status(404).json({ error: 'Consumo no encontrado' });
    const antes = antesFilas[0];
    // Solo el dueño del origen (o ADMIN_POD) modifica sus consumos guardados.
    const cargado = await cargarOrigen(req, res, antes.OrigenId, { gestionar: true });
    if (!cargado) return;
    const [dup] = await pool.query('SELECT Id FROM swagger_consumos WHERE OrigenId = ? AND Activo = 1 AND LOWER(Nombre) = LOWER(?) AND Id <> ?', [antes.OrigenId, valores.Nombre, antes.Id]);
    if (dup.length) return res.status(409).json({ error: 'Ya existe otro consumo guardado con ese nombre en este origen' });
    await pool.query(
      `UPDATE swagger_consumos SET Nombre = ?, Metodo = ?, Ruta = ?, BaseUrl = ?, OperacionId = ?, Grupo = ?, ParametrosJson = ?, Cuerpo = ?, TipoContenido = ?, Notas = ? WHERE Id = ?`,
      [valores.Nombre, valores.Metodo, valores.Ruta, valores.BaseUrl, valores.OperacionId, valores.Grupo, valores.ParametrosJson, valores.Cuerpo, valores.TipoContenido, valores.Notas, antes.Id]
    );
    const [filas] = await pool.query('SELECT * FROM swagger_consumos WHERE Id = ?', [antes.Id]);
    const cambios = diffCampos(antes, filas[0], Object.keys(ETIQUETAS_CONSUMO), ETIQUETAS_CONSUMO, FORMATEADORES_CONSUMO);
    await registrarEventoGeneral(pool, req, {
      modulo: 'SWAGGER', entidad: 'Consumo guardado', entidadId: antes.Id, entidadNombre: valores.Nombre, accion: 'EDICION', cambios,
    });
    res.json({ ...filaConsumo(filas[0]), SecretosOmitidos: !!secretosOmitidos });
  } catch (e) {
    console.error('Error al actualizar el consumo guardado:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

router.delete('/consumos/:cid', requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query('SELECT * FROM swagger_consumos WHERE Id = ? AND Activo = 1', [aEntero(req.params.cid) || 0]);
    if (!filas.length) return res.status(404).json({ error: 'Consumo no encontrado' });
    const cargado = await cargarOrigen(req, res, filas[0].OrigenId, { gestionar: true });
    if (!cargado) return;
    await pool.query('UPDATE swagger_consumos SET Activo = 0 WHERE Id = ?', [filas[0].Id]);
    await registrarEventoGeneral(pool, req, {
      modulo: 'SWAGGER', entidad: 'Consumo guardado', entidadId: filas[0].Id, entidadNombre: filas[0].Nombre, accion: 'ELIMINACION',
      detalle: `${filas[0].Metodo} ${filas[0].Ruta}`,
    });
    res.status(204).send();
  } catch (e) {
    console.error('Error al eliminar el consumo guardado:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

// ---------------------------------------------------------------------------
// HISTORIAL (cada quien ve el suyo; el ADMIN_POD puede ver el de todos)
// ---------------------------------------------------------------------------
router.get('/origenes/:id/historial', async (req, res) => {
  try {
    const cargado = await cargarOrigen(req, res, req.params.id);
    if (!cargado) return;
    const { pool, origen } = cargado;
    const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), 300);
    const condiciones = ['OrigenId = ?'];
    const params = [origen.Id];
    const verTodos = esAdminPod(req) && req.query.todos === '1';
    if (!verTodos) { condiciones.push('UsuarioId = ?'); params.push(req.user.id); }
    if (req.query.consumoId) { condiciones.push('ConsumoId = ?'); params.push(Number(req.query.consumoId) || 0); }
    const [filas] = await pool.query(
      `SELECT Id, ConsumoId, Metodo, Url, Estado, EstadoTexto, DuracionMs, ResponseBytes, Error, Username, Fecha
         FROM swagger_historial WHERE ${condiciones.join(' AND ')} ORDER BY Id DESC LIMIT ${limite}`,
      params
    );
    res.json({ items: filas, todos: verTodos });
  } catch (e) {
    console.error('Error al listar el historial Swagger:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

router.get('/historial/:hid', async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query('SELECT * FROM swagger_historial WHERE Id = ?', [req.params.hid]);
    const f = filas[0];
    if (!f || (!esAdminPod(req) && f.UsuarioId !== req.user.id)) return res.status(404).json({ error: 'Registro no encontrado' });
    const json = (t) => { try { return JSON.parse(t || '{}'); } catch (_) { return {}; } };
    res.json({
      Id: f.Id, OrigenId: f.OrigenId, ConsumoId: f.ConsumoId, Metodo: f.Metodo, Url: f.Url,
      RequestHeaders: json(f.RequestHeadersJson), RequestBody: f.RequestBody || '',
      Estado: f.Estado, EstadoTexto: f.EstadoTexto, DuracionMs: f.DuracionMs,
      ResponseHeaders: json(f.ResponseHeadersJson), ResponseBody: f.ResponseBody || '', ResponseBytes: f.ResponseBytes,
      Truncado: !!f.Truncado, Error: f.Error, Username: f.Username, Fecha: f.Fecha,
    });
  } catch (e) {
    console.error('Error al leer el historial Swagger:', e);
    res.status(500).json({ error: mensajeErrorAmigable(e) });
  }
});

module.exports = router;
