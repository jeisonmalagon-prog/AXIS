// Conexión de SOLO LECTURA a la base de logs de BreB (MariaDB, base LogBre_B, tabla Log).
//
// La configura el ADMIN_POD desde la app (ver brebConexion.js); el .env (BREB_LOG_DB_HOST/USER/PASSWORD/PORT/NAME) es respaldo.
// Garantías de solo lectura:
//  1) Las consultas las arma el backend (brebConsultas), jamás vienen de la pantalla; los valores van como parámetros (?).
//  2) `sqlSoloLecturaMaria` exige un único SELECT/WITH sin palabras de escritura, DDL, CALL, INTO ni funciones de pausa.
//  3) Cada conexión se abre con SET SESSION TRANSACTION READ ONLY y un tope de tiempo por consulta (max_statement_time).
//  4) Se recomienda además que la cuenta de BD tenga solo permiso SELECT sobre LogBre_B.

const { cifrar, descifrar } = require('./catalogoOrigenes');

let mysql = null;
let pool = null;
let global = null; // campos con clave cifrada
const TIMEOUT_S = 20;

function cargarDriver() {
  if (mysql) return mysql;
  // eslint-disable-next-line global-require
  mysql = require('mysql2/promise');
  return mysql;
}

/** Solo para pruebas. */
function usarDriver(m) { mysql = m; cerrarPool(); }

function cerrarPool() {
  const p = pool;
  pool = null;
  if (p) Promise.resolve(p).then((x) => x.end()).catch(() => { /* ya cerrada */ });
}

/** campos: { servidor, puerto, base, usuario, clave (en claro), cifrado, confiarCertificado } o null para quitar. */
function establecer(campos) {
  if (!campos) global = null;
  else global = { ...campos, clave: undefined, claveCifrada: cifrar(String(campos.clave || '')) };
  cerrarPool();
}

function hayGlobal() { return !!global; }

const booleano = (v, d) => (v === undefined || v === null || String(v).trim() === '' ? d : /^(1|true|si|sí|yes|on)$/i.test(String(v).trim()));

function camposDe(explicita) {
  const env = (k) => process.env[`BREB_LOG_DB_${k}`];
  const g = explicita || null;
  if (g) {
    return { origen: 'pantalla', servidor: String(g.servidor || '').trim(), puerto: parseInt(g.puerto || '3306', 10), base: String(g.base || 'LogBre_B').trim(), usuario: String(g.usuario || '').trim(), clave: g.clave || '', ssl: !!g.cifrado, confiar: g.confiarCertificado !== false };
  }
  if (global) {
    return { origen: 'guardada', servidor: String(global.servidor || '').trim(), puerto: parseInt(global.puerto || '3306', 10), base: String(global.base || 'LogBre_B').trim(), usuario: String(global.usuario || '').trim(), clave: descifrar(global.claveCifrada) || '', ssl: !!global.cifrado, confiar: global.confiarCertificado !== false };
  }
  if (env('HOST') || env('USER') || env('PASSWORD')) {
    return { origen: 'env', servidor: String(env('HOST') || '').trim(), puerto: parseInt(env('PORT') || '3306', 10), base: String(env('NAME') || 'LogBre_B').trim(), usuario: String(env('USER') || '').trim(), clave: env('PASSWORD') || '', ssl: booleano(env('SSL'), false), confiar: booleano(env('TRUST_CERT'), true) };
  }
  return { origen: 'ninguno', servidor: '', puerto: 3306, base: 'LogBre_B', usuario: '', clave: '', ssl: false, confiar: true };
}

function faltantes(f) {
  const faltan = [];
  if (!f.servidor) faltan.push('el servidor');
  if (!f.usuario) faltan.push('el usuario');
  if (!f.clave) faltan.push('la clave');
  return faltan;
}

function resumen() {
  const f = camposDe();
  const faltan = faltantes(f);
  return { nombre: 'Logs de BreB (MariaDB)', servidor: f.servidor || null, puerto: f.puerto, base: f.base, origen: f.origen, configurada: faltan.length === 0, faltan };
}

function configMysql(f, { max = 3 } = {}) {
  return {
    host: f.servidor, port: Number.isInteger(f.puerto) && f.puerto > 0 && f.puerto < 65536 ? f.puerto : 3306, user: f.usuario, password: f.clave, database: f.base,
    waitForConnections: true, connectionLimit: max, queueLimit: 20, connectTimeout: 15000,
    charset: 'utf8mb4', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false,
    ...(f.ssl ? { ssl: { rejectUnauthorized: !f.confiar } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Guarda de solo lectura
// ---------------------------------------------------------------------------
const RE_PROHIBIDAS = /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|CALL|LOAD|HANDLER|LOCK|UNLOCK|SET|INTO|OUTFILE|DUMPFILE|SLEEP|BENCHMARK|GET_LOCK|FLUSH|KILL|PREPARE|EXECUTE|DEALLOCATE|SHUTDOWN|USE|DO|ANALYZE|OPTIMIZE|REPAIR|INSTALL)\b/i;

/** true si el texto es un único SELECT (o WITH … SELECT) sin nada que escriba o cambie algo. */
function sqlSoloLecturaMaria(texto) {
  const t = String(texto || '')
    .replace(/--[^\n]*/g, ' ').replace(/#[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/`[^`]*`/g, '`x`')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .trim();
  if (!/^(SELECT|WITH)\b/i.test(t)) return false;
  if (t.includes(';')) return false;
  if (RE_PROHIBIDAS.test(t)) return false;
  return true;
}

async function obtenerPool() {
  const f = camposDe();
  const faltan = faltantes(f);
  if (faltan.length) {
    const err = new Error('La conexión a los logs de BreB (MariaDB) no está configurada: el ADMIN_POD debe guardarla en Monitoreo transaccional > BREB > Conexiones.');
    err.codigo = 'SIN_CONFIG';
    throw err;
  }
  if (pool) return pool;
  const m = cargarDriver();
  const p = m.createPool(configMysql(f));
  p.on('connection', (conn) => {
    // Cada conexión nace en solo lectura y con tope de tiempo (MariaDB: max_statement_time; MySQL: max_execution_time).
    const raw = conn.connection || conn;
    const ejecutar = (q) => { try { raw.query(q, () => { /* si el servidor no lo soporta, se ignora */ }); } catch (_) { /* nada */ } };
    ejecutar('SET SESSION TRANSACTION READ ONLY');
    ejecutar(`SET SESSION max_statement_time=${TIMEOUT_S}`);
    ejecutar(`SET SESSION max_execution_time=${TIMEOUT_S * 1000}`);
  });
  pool = p;
  return p;
}

/** Ejecuta un SELECT de solo lectura con parámetros (?). Devuelve las filas. */
async function consultar(sql, parametros = []) {
  if (!sqlSoloLecturaMaria(sql)) {
    const e = new Error('Consulta bloqueada: no es de solo lectura.');
    e.codigo = 'NO_SOLO_LECTURA';
    throw e;
  }
  try {
    const p = await obtenerPool();
    const [filas] = await p.query({ sql, timeout: (TIMEOUT_S + 5) * 1000 }, parametros);
    return Array.isArray(filas) ? filas : [];
  } catch (error) {
    if (!error.perfil) error.perfil = 'breb-log';
    if (['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE'].includes(error.code)) cerrarPool();
    throw error;
  }
}

const CODIGOS_CONEXION = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ECONNRESET', 'SIN_CONFIG', 'EAI_AGAIN', 'ENETUNREACH', 'ER_HOST_NOT_PRIVILEGED', 'ER_NOT_SUPPORTED_AUTH_MODE'];

/** Mensaje entendible a partir de un error del driver. Nunca incluye credenciales. */
function mensajeError(error) {
  const nombre = 'los logs de BreB (MariaDB)';
  const codigo = error?.codigo || error?.code;
  const texto = String(error?.message || error || '');
  switch (codigo) {
    case 'SIN_CONFIG': return texto;
    case 'NO_SOLO_LECTURA': return texto;
    case 'ER_ACCESS_DENIED_ERROR': return `Inicio de sesión rechazado en ${nombre}: el usuario o la clave guardados no son válidos (el ADMIN_POD los actualiza en BREB > Conexiones).`;
    case 'ER_DBACCESS_DENIED_ERROR': return `La cuenta no tiene acceso a la base configurada de ${nombre}.`;
    case 'ER_BAD_DB_ERROR': return `La base de datos configurada para ${nombre} no existe.`;
    case 'ER_TABLEACCESS_DENIED_ERROR':
    case 'ER_COLUMNACCESS_DENIED_ERROR': return `La cuenta de ${nombre} no tiene permiso SELECT sobre la tabla Log.`;
    case 'ER_NO_SUCH_TABLE': return `En ${nombre} no existe la tabla esperada (${texto.slice(0, 160)}).`;
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EAI_AGAIN': return `No se pudo conectar a ${nombre}: revisa host y puerto, y que el servidor de AXIS tenga ruta y regla de firewall hacia MariaDB.`;
    case 'ETIMEDOUT': return `Tiempo de espera agotado hablando con ${nombre} (host, puerto o firewall).`;
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ECONNRESET': return `La conexión con ${nombre} se cerró; se reintentará en la próxima consulta.`;
    case 'ER_QUERY_TIMEOUT':
    case 'PROTOCOL_SEQUENCE_TIMEOUT': return `La consulta a ${nombre} tardó demasiado (más de ${TIMEOUT_S} s): reduce el rango de fechas o agrega filtros.`;
    default: break;
  }
  if (error?.errno === 1969 || /max_statement_time|Query execution was interrupted/i.test(texto)) {
    return `La consulta a ${nombre} tardó demasiado (más de ${TIMEOUT_S} s): reduce el rango de fechas o agrega filtros. Si es frecuente, conviene un índice por Fecha en la tabla Log.`;
  }
  return `Error consultando ${nombre}: ${texto.slice(0, 300)}`;
}

async function probar() {
  const r = resumen();
  if (!r.configurada) return { ok: false, ...r, error: 'No hay conexión configurada para los logs de BreB.' };
  try {
    const filas = await consultar('SELECT VERSION() AS version, DATABASE() AS base, NOW() AS ahora');
    return { ok: true, ...r, version: String(filas[0]?.version || '').slice(0, 120), baseConectada: filas[0]?.base || r.base };
  } catch (error) {
    return { ok: false, ...r, error: mensajeError(error) };
  }
}

/** Prueba un borrador de la pantalla SIN guardarlo ni tocar la conexión abierta. */
async function probarBorrador(campos) {
  const f = camposDe(campos);
  const faltan = faltantes(f);
  const r = { nombre: 'Logs de BreB (MariaDB)', servidor: f.servidor || null, puerto: f.puerto, base: f.base, origen: 'pantalla', configurada: faltan.length === 0, faltan };
  if (faltan.length) return { ok: false, ...r, error: `Falta completar: ${faltan.join(', ')}.` };
  let p = null;
  try {
    const m = cargarDriver();
    p = m.createPool(configMysql(f, { max: 1 }));
    const [filas] = await p.query('SELECT VERSION() AS version, DATABASE() AS base');
    // Que la tabla exista y sea legible (sin traer filas).
    let aviso = null;
    try { await p.query('SELECT 1 FROM Log LIMIT 1'); } catch (e) { aviso = e.code === 'ER_NO_SUCH_TABLE' ? 'La conexión funciona, pero no se encontró la tabla Log en esa base.' : (e.code && /DENIED/.test(e.code) ? 'La conexión funciona, pero la cuenta no puede leer la tabla Log.' : null); }
    return { ok: !aviso, ...r, version: String(filas[0]?.version || '').slice(0, 120), baseConectada: filas[0]?.base || f.base, ...(aviso ? { error: aviso } : {}) };
  } catch (error) {
    return { ok: false, ...r, error: mensajeError(error) };
  } finally {
    if (p) { try { await p.end(); } catch (_) { /* nada */ } }
  }
}

async function cerrarTodo() { cerrarPool(); }

module.exports = {
  establecer, hayGlobal, resumen, consultar, sqlSoloLecturaMaria, mensajeError, probar, probarBorrador, usarDriver, cerrarTodo,
  CODIGOS_CONEXION, camposDe,
};
