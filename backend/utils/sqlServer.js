// Conexiones de SOLO LECTURA a SQL Server para el módulo Biometría de firmas.
//
// Se usan dos servidores distintos (MotorFirma y ORQBIOMETRIA).
//
// CREDENCIALES PREDEFINIDAS EN EL CÓDIGO (archivo biometriaClave.js, excluido de git): ya no se piden
// usuarios ni claves en la pantalla. Nunca van al navegador, a la auditoría ni a los logs.
// (Se conserva la posibilidad de credenciales de sesión por persona, pero ninguna pantalla las usa.)
// Usuarios de dominio: DOMINIO\usuario usa autenticación de Windows (NTLM).
// Recomendado: una cuenta con SELECT solo sobre esas tablas.
//
// Variables opcionales del .env (NO son credenciales; valores por defecto de la conexión):
//   MOTORFIRMA_DB_TIMEOUT_MS / ORQBIO_DB_TIMEOUT_MS  tiempo máximo por consulta, por defecto 30000
//
// Solo se ejecutan consultas construidas por el propio backend, siempre con
// parámetros; el módulo no acepta SQL escrito por el usuario.

const PERFILES = {
  motorfirma: { prefijo: 'MOTORFIRMA_DB', baseDefecto: 'MotorFirma', nombre: 'MotorFirma' },
  orqbiometria: { prefijo: 'ORQBIO_DB', baseDefecto: 'ORQBIOMETRIA', nombre: 'ORQBIOMETRIA' },
  // GestionCliente (prospección de aliados, esquema PD): la conexión la configura el ADMIN_POD desde la app
  // (Soporte Nivel 1 > Monitorear prospección) y queda guardada cifrada; el .env es solo respaldo.
  gestioncliente: {
    prefijo: 'GESTIONCLIENTE_DB', baseDefecto: 'GestionCliente', nombre: 'GestionCliente', appName: 'AXIS-Prospeccion', envConexion: true,
    sinConfig: 'La conexión a GestionCliente no está configurada: el ADMIN_POD debe guardarla en Soporte Nivel 1 > Monitorear prospección > Conexión.',
    mensajeLogin: 'Inicio de sesión rechazado en GestionCliente: el usuario o la clave guardados ya no son válidos, o la cuenta no tiene acceso a la base (el ADMIN_POD los actualiza en Monitorear prospección > Conexión).',
  },
  // BreB (Monitoreo transaccional > BREB): la conexión la configura el ADMIN_POD desde la app (se guarda cifrada); el .env es solo respaldo.
  breb: {
    prefijo: 'BREB_DB', baseDefecto: 'BreB', nombre: 'BreB (SQL Server)', appName: 'AXIS-BreB', envConexion: true,
    sinConfig: 'La conexión a la base SQL Server de BreB no está configurada: el ADMIN_POD debe guardarla en Monitoreo transaccional > BREB > Conexiones.',
    mensajeLogin: 'Inicio de sesión rechazado en la base de BreB: el usuario o la clave guardados ya no son válidos, o la cuenta no tiene acceso a la base (el ADMIN_POD los actualiza en BREB > Conexiones).',
  },
};

const { AsyncLocalStorage } = require('async_hooks');
const { cifrar, descifrar } = require('./catalogoOrigenes');

// Credenciales predefinidas por perfil (si el archivo no existe, el módulo avisa que faltan).
let PREDEFINIDAS = {};
try { PREDEFINIDAS = require('./biometriaClave').sql || {}; } catch { /* sin archivo: no hay credenciales predefinidas */ }

let mssql = null;
const pools = new Map();

// ---------------------------------------------------------------------------
// Credenciales de SESIÓN (solo memoria, por usuario)
// ---------------------------------------------------------------------------
const contextoUsuario = new AsyncLocalStorage();
const sesiones = new Map(); // usuario -> { perfil -> { campos (clave cifrada), expira } }

function horasSesion() {
  const h = parseFloat(process.env.BIOMETRIA_SESION_HORAS || '8');
  return Math.min(Math.max(Number.isFinite(h) ? h : 8, 0.25), 72);
}

/** Ejecuta `fn` (y todo lo asíncrono que dispare) en nombre de `usuario`: ahí se usan sus credenciales de sesión. */
function ejecutarComo(usuario, fn) {
  return contextoUsuario.run({ usuario: usuario ? String(usuario) : null }, fn);
}

function usuarioActual() {
  return contextoUsuario.getStore()?.usuario || null;
}

function claveSesion(usuario, perfil) { return `${perfil}|u:${usuario}`; }

function cerrarPool(clave) {
  const abierta = pools.get(clave);
  pools.delete(clave);
  if (abierta) Promise.resolve(abierta).then((p) => p.close()).catch(() => { /* ya cerrada */ });
}

function sesionDe(usuario, perfil) {
  if (!usuario) return null;
  const porPerfil = sesiones.get(usuario);
  const s = porPerfil?.[perfil];
  if (!s) return null;
  if (Date.now() > s.expira) { quitarSesion(usuario, perfil); return null; }
  return s;
}

/** campos: { servidor, puerto, base, usuario, clave (en claro), cifrado, confiarCertificado } */
function establecerSesion(usuario, perfil, campos) {
  if (!usuario) throw new Error('No se pudo identificar tu sesión.');
  if (!PERFILES[perfil]) throw new Error(`Perfil de conexión desconocido: ${perfil}`);
  const porPerfil = sesiones.get(usuario) || {};
  porPerfil[perfil] = {
    campos: { ...campos, clave: undefined, claveCifrada: cifrar(String(campos.clave || '')) },
    expira: Date.now() + horasSesion() * 3600 * 1000,
  };
  sesiones.set(usuario, porPerfil);
  cerrarPool(claveSesion(usuario, perfil)); // si cambió la clave, se reconecta con la nueva
}

function quitarSesion(usuario, perfil) {
  const porPerfil = sesiones.get(usuario);
  if (!porPerfil || !porPerfil[perfil]) return false;
  delete porPerfil[perfil];
  if (!Object.keys(porPerfil).length) sesiones.delete(usuario);
  cerrarPool(claveSesion(usuario, perfil));
  return true;
}

/** Datos de la sesión sin la clave (para la pantalla): { campos sin clave, claveFin, expira } */
function infoSesion(usuario, perfil) {
  const s = sesionDe(usuario, perfil);
  if (!s) return null;
  const clave = s.campos.claveCifrada ? descifrar(s.campos.claveCifrada) : '';
  return {
    servidor: s.campos.servidor, puerto: s.campos.puerto, base: s.campos.base, usuario: s.campos.usuario,
    cifrado: !!s.campos.cifrado, confiarCertificado: s.campos.confiarCertificado !== false,
    tieneClave: !!clave, claveFin: clave ? clave.slice(-2) : null, expira: new Date(s.expira).toISOString(),
  };
}

function claveEnClaroSesion(usuario, perfil) {
  const s = sesionDe(usuario, perfil);
  return s?.campos.claveCifrada ? (descifrar(s.campos.claveCifrada) || '') : '';
}

/** Usuarios que tienen credenciales vigentes para TODOS los perfiles indicados (para la consulta automática de cada uno). */
function usuariosConSesion(perfiles = Object.keys(PERFILES)) {
  return [...sesiones.keys()].filter((u) => perfiles.every((perfil) => !!sesionDe(u, perfil)));
}

// Barre las sesiones vencidas (y cierra sus conexiones) cada 5 minutos.
setInterval(() => {
  for (const [usuario, porPerfil] of [...sesiones.entries()]) {
    for (const perfil of Object.keys(porPerfil)) sesionDe(usuario, perfil);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Credenciales GLOBALES por perfil (las guarda el ADMIN_POD en la app; se cargan en memoria desde la base de AXIS)
// ---------------------------------------------------------------------------
const globales = new Map(); // perfil -> campos (con clave cifrada)

/** campos: { servidor, puerto, base, usuario, clave (en claro), cifrado, confiarCertificado } o null para quitar. */
function establecerGlobal(perfil, campos) {
  if (!PERFILES[perfil]) throw new Error(`Perfil de conexión desconocido: ${perfil}`);
  if (!campos) globales.delete(perfil);
  else globales.set(perfil, { ...campos, clave: undefined, claveCifrada: cifrar(String(campos.clave || '')) });
  cerrarPool(perfil); // si cambió algo, se reconecta con lo nuevo
}

function hayGlobal(perfil) { return globales.has(perfil); }

function cargarDriver() {
  if (mssql) return mssql;
  try {
    // eslint-disable-next-line global-require
    mssql = require('mssql');
    return mssql;
  } catch (_) {
    const err = new Error("Falta el paquete 'mssql' en el backend: reconstruye la imagen (npm install) para habilitar la conexión a SQL Server.");
    err.codigo = 'SIN_DRIVER';
    throw err;
  }
}

// Solo para pruebas: reemplaza el driver por uno simulado.
function usarDriver(modulo) {
  mssql = modulo;
  pools.clear();
}

function booleano(valor, defecto) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return defecto;
  return /^(1|true|si|sí|yes|on)$/i.test(String(valor).trim());
}

// Campos efectivos de un perfil: las de la sesión de quien consulta (si las hubiera) o, si no, las predefinidas en el código
// (`explicita` solo para probar un borrador sin guardarlo).
function camposDe(perfil, explicita) {
  const p = PERFILES[perfil];
  if (!p) throw new Error(`Perfil de conexión desconocido: ${perfil}`);
  const env = (k) => process.env[`${p.prefijo}_${k}`];
  const usuarioSesion = explicita ? null : usuarioActual();
  const sesion = usuarioSesion ? sesionDe(usuarioSesion, perfil) : null;
  const g = explicita || (sesion ? { ...sesion.campos, clave: descifrar(sesion.campos.claveCifrada) || '' } : null);
  const timeoutEnv = Math.min(Math.max(parseInt(env('TIMEOUT_MS') || '30000', 10) || 30000, 3000), 120000);
  const nombresFaltan = { servidor: 'el servidor', usuario: 'el usuario', clave: 'la clave' };
  if (g) {
    return {
      origen: explicita ? 'pantalla' : 'sesion',
      usuarioSesion: sesion ? usuarioSesion : null,
      servidor: String(g.servidor || '').trim(), usuario: String(g.usuario || '').trim(), clave: g.clave || '',
      puerto: parseInt(g.puerto || '1433', 10), base: String(g.base || p.baseDefecto).trim(),
      encrypt: !!g.cifrado, trust: g.confiarCertificado !== false, timeout: timeoutEnv, nombresFaltan,
    };
  }
  const glob = explicita ? null : globales.get(perfil);
  if (glob) {
    return {
      origen: 'guardada', usuarioSesion: null,
      servidor: String(glob.servidor || '').trim(), usuario: String(glob.usuario || '').trim(), clave: descifrar(glob.claveCifrada) || '',
      puerto: parseInt(glob.puerto || '1433', 10), base: String(glob.base || p.baseDefecto).trim(),
      encrypt: !!glob.cifrado, trust: glob.confiarCertificado !== false, timeout: timeoutEnv, nombresFaltan,
    };
  }
  const pre = explicita ? null : PREDEFINIDAS[perfil];
  if (pre) {
    return {
      origen: 'predefinida', usuarioSesion: null,
      servidor: String(pre.servidor || '').trim(), usuario: String(pre.usuario || '').trim(), clave: pre.clave || '',
      puerto: parseInt(pre.puerto || '1433', 10), base: String(pre.base || p.baseDefecto).trim(),
      encrypt: !!pre.cifrado, trust: pre.confiarCertificado !== false, timeout: timeoutEnv, nombresFaltan,
    };
  }
  if (p.envConexion && !explicita && (env('HOST') || env('USER') || env('PASSWORD'))) {
    return {
      origen: 'env', usuarioSesion: null,
      servidor: String(env('HOST') || '').trim(), usuario: String(env('USER') || '').trim(), clave: env('PASSWORD') || '',
      puerto: parseInt(env('PORT') || '1433', 10), base: String(env('NAME') || p.baseDefecto).trim(),
      encrypt: booleano(env('ENCRYPT'), false), trust: booleano(env('TRUST_CERT'), true), timeout: timeoutEnv, nombresFaltan,
    };
  }
  return {
    origen: 'ninguno', usuarioSesion: null, servidor: '', usuario: '', clave: '',
    puerto: 1433, base: p.baseDefecto, encrypt: false, trust: true, timeout: timeoutEnv, nombresFaltan,
  };
}

// Configuración de un perfil (la de tu sesión). `explicita` solo para probar un borrador sin guardarlo.
function leerConexion(perfil, explicita) {
  const p = PERFILES[perfil];
  const f = camposDe(perfil, explicita);
  const faltan = [];
  if (!f.servidor) faltan.push(f.nombresFaltan.servidor);
  if (!f.usuario) faltan.push(f.nombresFaltan.usuario);
  if (!f.clave) faltan.push(f.nombresFaltan.clave);

  let servidor = f.servidor;
  let instancia = null;
  const m = f.servidor.match(/^([^\\]+)\\(.+)$/);
  if (m) { servidor = m[1]; instancia = m[2]; }

  // «DOMINIO\\usuario» = cuenta de Windows: se usa autenticación NTLM (con el usuario
  // tal cual como inicio de sesión de SQL Server no entra).
  let usuarioSql = f.usuario;
  let dominio = null;
  const d = f.usuario.match(/^([^\\]+)\\(.+)$/);
  if (d) { dominio = d[1]; usuarioSql = d[2]; }

  const config = {
    server: servidor,
    user: usuarioSql,
    password: f.clave,
    ...(dominio ? { domain: dominio } : {}),
    database: f.base,
    connectionTimeout: 15000,
    requestTimeout: f.timeout,
    pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: f.encrypt,
      trustServerCertificate: f.trust,
      appName: p.appName || 'AXIS-Biometria',
      enableArithAbort: true,
      ...(instancia ? { instanceName: instancia } : {}),
    },
  };
  if (!instancia && Number.isInteger(f.puerto) && f.puerto > 0 && f.puerto < 65536) config.port = f.puerto;

  return {
    perfil, nombre: p.nombre, servidor: f.servidor, base: f.base, puerto: f.puerto, origen: f.origen, faltan,
    windows: !!dominio, clavePool: f.usuarioSesion ? claveSesion(f.usuarioSesion, perfil) : perfil,
    configurada: faltan.length === 0, config,
  };
}

// Resumen seguro para la pantalla (sin usuario ni clave).
function resumenConexion(perfil) {
  const c = leerConexion(perfil);
  return { nombre: c.nombre, servidor: c.servidor || null, puerto: c.puerto, base: c.base, origen: c.origen, windows: c.windows, configurada: c.configurada, faltan: c.faltan };
}

async function obtenerPool(perfil) {
  const c = leerConexion(perfil);
  if (!c.configurada) {
    const err = new Error(PERFILES[perfil].sinConfig || `No hay credenciales predefinidas para ${c.nombre}: falta el archivo backend/utils/biometriaClave.js (o su sección de ${c.nombre}) en el servidor.`);
    err.codigo = 'SIN_CONFIG';
    throw err;
  }
  const clave = c.clavePool;
  if (pools.has(clave)) return pools.get(clave);
  const m = cargarDriver();
  const promesa = (async () => {
    const pool = new m.ConnectionPool(c.config);
    if (typeof pool.on === 'function') pool.on('error', () => { pools.delete(clave); });
    await pool.connect();
    return pool;
  })();
  pools.set(clave, promesa);
  try {
    return await promesa;
  } catch (error) {
    pools.delete(clave);
    throw error;
  }
}

function tipoSql(m, tipo) {
  switch (tipo) {
    case 'int': return m.Int;
    case 'bigint': return m.BigInt;
    case 'nvarchar': return m.NVarChar;
    default: return m.VarChar;
  }
}

// parametros: [{ nombre, tipo: 'varchar'|'nvarchar'|'int', valor }]
async function consultar(perfil, sql, parametros = []) {
  let pool = null;
  try {
    const m = cargarDriver();
    pool = await obtenerPool(perfil);
    const peticion = pool.request();
    for (const p of parametros) peticion.input(p.nombre, tipoSql(m, p.tipo), p.valor);
    const resultado = await peticion.query(sql);
    return resultado.recordset || [];
  } catch (error) {
    if (!error.perfil) error.perfil = perfil;
    if (pool && ['ECONNCLOSED', 'ESOCKET', 'ENOTOPEN', 'ETIMEOUT'].includes(error.code)) {
      pools.delete(leerConexion(perfil).clavePool);
      try { await pool.close(); } catch (_) { /* ya cerrada */ }
    }
    throw error;
  }
}

// Mensaje entendible a partir de un error del driver. Nunca incluye credenciales.
function mensajeErrorSql(error, perfil) {
  const nombre = PERFILES[perfil]?.nombre || 'SQL Server';
  const codigo = error?.codigo || error?.code;
  const texto = String(error?.message || error || '');
  if (codigo === 'SIN_CONFIG' || codigo === 'SIN_DRIVER' || codigo === 'CONFIG') return texto;
  switch (codigo) {
    case 'ELOGIN':
      if (PERFILES[perfil]?.mensajeLogin) return PERFILES[perfil].mensajeLogin;
      return `Inicio de sesión rechazado en ${nombre}: el usuario o la clave predefinidos en el código ya no son válidos, o la cuenta no tiene acceso a la base (se actualizan en backend/utils/biometriaClave.js).`;
    case 'ETIMEOUT':
      return `Tiempo de espera agotado hablando con ${nombre} (host, puerto o firewall; o la consulta tardó demasiado).`;
    case 'ESOCKET':
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EINSTLOOKUP':
    case 'EHOSTUNREACH':
      return `No se pudo conectar a ${nombre}: revisa host, puerto/instancia y que el servidor de AXIS tenga ruta y regla de firewall hacia SQL Server.`;
    case 'ECONNCLOSED':
    case 'ENOTOPEN':
      return `La conexión con ${nombre} se cerró; se reintentará en la próxima consulta.`;
    default:
      break;
  }
  const numero = error?.number;
  if (numero === 229 || numero === 230 || numero === 262 || /permission was denied/i.test(texto)) {
    return `La cuenta de ${nombre} no tiene permiso SELECT sobre alguna de las tablas necesarias.`;
  }
  if (numero === 208 || /invalid object name/i.test(texto)) {
    return `En ${nombre} no existe alguna de las tablas esperadas (${texto.slice(0, 160)}).`;
  }
  if (numero === 4060 || /cannot open database/i.test(texto)) {
    return `La base de datos configurada para ${nombre} no existe o la cuenta no tiene acceso.`;
  }
  return `Error consultando ${nombre}: ${texto.slice(0, 300)}`;
}

async function probarConexion(perfil) {
  const resumen = resumenConexion(perfil);
  if (!resumen.configurada) {
    return { ok: false, ...resumen, error: PERFILES[perfil]?.sinConfig || `No hay credenciales predefinidas para ${resumen.nombre} (archivo backend/utils/biometriaClave.js).` };
  }
  try {
    const filas = await consultar(perfil, 'SELECT @@VERSION AS version, DB_NAME() AS base');
    const version = String(filas[0]?.version || '').split('\n')[0].slice(0, 120);
    return { ok: true, ...resumen, version, baseConectada: filas[0]?.base || resumen.base };
  } catch (error) {
    return { ok: false, ...resumen, error: mensajeErrorSql(error, perfil) };
  }
}

// Prueba un borrador de credenciales SIN guardarlo ni tocar las conexiones abiertas.
async function probarBorrador(perfil, campos) {
  const c = leerConexion(perfil, campos);
  const resumen = { nombre: c.nombre, servidor: c.servidor || null, puerto: c.puerto, base: c.base, origen: 'pantalla', configurada: c.configurada, faltan: c.faltan };
  if (!c.configurada) return { ok: false, ...resumen, error: `Falta completar: ${c.faltan.join(', ')}.` };
  let pool = null;
  try {
    const m = cargarDriver();
    pool = new m.ConnectionPool({ ...c.config, pool: { max: 1, min: 0, idleTimeoutMillis: 3000 } });
    if (typeof pool.on === 'function') pool.on('error', () => { /* se cierra abajo */ });
    await pool.connect();
    const r = await pool.request().query('SELECT @@VERSION AS version, DB_NAME() AS base');
    const fila = (r.recordset || [])[0] || {};
    return { ok: true, ...resumen, version: String(fila.version || '').split('\n')[0].slice(0, 120), baseConectada: fila.base || c.base };
  } catch (error) {
    return { ok: false, ...resumen, error: mensajeErrorSql(error, perfil) };
  } finally {
    if (pool) { try { await pool.close(); } catch (_) { /* nada */ } }
  }
}

async function cerrarTodo() {
  const abiertos = [...pools.values()];
  pools.clear();
  for (const p of abiertos) { try { (await p).close(); } catch (_) { /* nada */ } }
}

module.exports = {
  PERFILES, leerConexion, resumenConexion, consultar, mensajeErrorSql, probarConexion, probarBorrador,
  usarDriver, cargarDriver, cerrarTodo,
  establecerGlobal, hayGlobal,
  ejecutarComo, usuarioActual, establecerSesion, quitarSesion, infoSesion, claveEnClaroSesion, usuariosConSesion,
};
