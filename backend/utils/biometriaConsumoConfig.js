// Configuración del tablero «Consumo y reusos» de Biometría (solo la edita el ADMIN_POD, desde la pantalla).
//
//  · CONEXIÓN a ORQBIOMETRIA (SQL Server, solo lectura): servidor, puerto, base, usuario y clave. La clave se guarda
//    CIFRADA (AES-256-GCM) y jamás vuelve al navegador. Un usuario «DOMINIO\usuario» entra con autenticación de Windows (NTLM):
//    desde el servidor de AXIS (Linux/Docker) no se puede usar «mi sesión de Windows», hace falta una cuenta con su clave.
//  · UMBRALES: límite de consultas por cliente POR PROVEEDOR y por periodo (día y mes), si ese proveedor genera alerta (ASISA no tiene
//    sobrecosto: solo se monitorea; OLIMPIA sí: 5 por día y 15 por mes por cliente), cupos opcionales por proveedor, valor por consulta
//    excedente (opcional), si se avisa por correo y cada cuánto se RECUERDA mientras la alerta siga activa (un caso nuevo siempre se
//    avisa de inmediato).
//
// Todo vive en ConfiguracionSistema (clave/valor, la misma tabla del tema y del correo). La app no tiene privilegio DELETE:
// «quitar» un valor es guardarlo vacío. No hace falta ningún script SQL.

const { getPool } = require('../db');
const { cifrar, descifrar } = require('./catalogoOrigenes');
const sql = require('./sqlServer');

const TABLA = 'ConfiguracionSistema';
const TTL_MS = 20000;
const RE_HOST = /^[A-Za-z0-9_.\-\\]{1,200}$/;
const RE_IDENT = /^[A-Za-z0-9_$\- .]{1,128}$/;
const PROVEEDORES = ['ASISA', 'OLIMPIA'];

const CLAVES = {
  servidor: 'bio_cons_servidor', puerto: 'bio_cons_puerto', base: 'bio_cons_base', usuario: 'bio_cons_usuario', clave: 'bio_cons_clave',
  cifrado: 'bio_cons_cifrado', confiarCertificado: 'bio_cons_confiar',
  alerta: 'bio_cons_alerta', alertaCada: 'bio_cons_alerta_cada',
  // Límites por cliente y proveedor (vacío = sin límite, solo monitoreo) y si ese proveedor genera alerta por correo.
  limDiaAsisa: 'bio_cons_lim_d_asisa', limMesAsisa: 'bio_cons_lim_m_asisa', avisarAsisa: 'bio_cons_avisar_asisa',
  limDiaOlimpia: 'bio_cons_lim_d_olimp', limMesOlimpia: 'bio_cons_lim_m_olimp', avisarOlimpia: 'bio_cons_avisar_olimp',
  cupoDiaAsisa: 'bio_cons_cupo_d_asisa', cupoMesAsisa: 'bio_cons_cupo_m_asisa', valorAsisa: 'bio_cons_valor_asisa',
  cupoDiaOlimpia: 'bio_cons_cupo_d_olimp', cupoMesOlimpia: 'bio_cons_cupo_m_olimp', valorOlimpia: 'bio_cons_valor_olimp',
};
const CLAVE_ULTIMA_ALERTA = 'bio_cons_alerta_ult';
// El detalle de clientes ya avisados no cabe en 255 caracteres: se reparte en varias claves (ver biometriaConsumoAlertas.js).
const CLAVES_CLIENTES_AVISADOS = ['bio_cons_alerta_c1', 'bio_cons_alerta_c2', 'bio_cons_alerta_c3', 'bio_cons_alerta_c4'];
const LARGO_CLAVE_ESTADO = 250;
// Opciones de «recordar cada…» (minutos); 0 = no recordar, solo avisar cuando aparezca algo nuevo.
const RECORDATORIOS_MIN = [0, 15, 30, 60, 120, 240, 480, 720, 1440];

// Regla del negocio: ASISA no tiene sobrecosto (se monitorea, sin límite ni alerta); OLIMPIA sí: cada cliente tiene 5 intentos por día y 15 por mes.
const LIMITES_DEFECTO = {
  ASISA: { dia: null, mes: null, avisar: false },
  OLIMPIA: { dia: 5, mes: 15, avisar: true },
};
const DEFECTOS = {
  servidor: 'AWLPROD001', puerto: 61733, base: 'ORQBIOMETRIA', cifrado: true, confiarCertificado: true,
  alerta: true, alertaCadaMin: 240, limites: LIMITES_DEFECTO,
};

class ErrorConfig extends Error {
  constructor(mensaje, status = 400, codigo = 'CONFIG') { super(mensaje); this.status = status; this.codigo = codigo; }
}

let cache = { en: 0, valores: null, tabla: true };
let pool = null; // pool de SQL Server (clave: huella de la conexión)
let huellaPool = null;

const esErrorTablaInexistente = (e) => e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE');

async function leerValores({ force = false } = {}) {
  if (!force && cache.valores && Date.now() - cache.en < TTL_MS) return cache;
  const bd = await getPool();
  const claves = [...Object.values(CLAVES), CLAVE_ULTIMA_ALERTA, ...CLAVES_CLIENTES_AVISADOS];
  let filas = [];
  let tabla = true;
  try {
    [filas] = await bd.query(`SELECT Clave, Valor FROM ${TABLA} WHERE Clave IN (${claves.map(() => '?').join(',')})`, claves);
  } catch (e) {
    if (!esErrorTablaInexistente(e)) throw e;
    tabla = false;
  }
  const valores = Object.fromEntries(filas.map((f) => [f.Clave, String(f.Valor ?? '')]));
  cache = { en: Date.now(), valores, tabla };
  return cache;
}

const texto = (v, defecto = '') => (v === undefined || v === null || String(v).trim() === '' ? defecto : String(v).trim());
const entero = (v, defecto = null) => {
  if (v === undefined || v === null || String(v).trim() === '') return defecto;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defecto;
};
const decimal = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
/** Límite por cliente: sin valor guardado → el defecto; guardado vacío → sin límite (solo monitoreo); un número → ese límite. */
const limiteGuardado = (v, defecto) => {
  if (v === undefined || v === null) return defecto;
  if (String(v).trim() === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : defecto;
};
const booleano = (v, defecto) => (v === undefined || v === null || String(v).trim() === '' ? defecto : /^(1|true|si|sí|yes|on)$/i.test(String(v).trim()));

/** Configuración efectiva (con la clave EN CLARO: solo para uso interno del backend). */
async function obtenerInterna(opciones) {
  const { valores, tabla } = await leerValores(opciones);
  const v = (k) => valores[CLAVES[k]];
  let claveSql = '';
  let claveIlegible = false;
  if (texto(v('clave'))) {
    const claro = descifrar(v('clave'));
    if (claro === null) claveIlegible = true; else claveSql = claro;
  }
  const cfg = {
    servidor: texto(v('servidor'), DEFECTOS.servidor),
    puerto: entero(v('puerto'), DEFECTOS.puerto),
    base: texto(v('base'), DEFECTOS.base),
    usuario: texto(v('usuario')),
    clave: claveSql,
    claveIlegible,
    cifrado: booleano(v('cifrado'), DEFECTOS.cifrado),
    confiarCertificado: booleano(v('confiarCertificado'), DEFECTOS.confiarCertificado),
    limites: {
      ASISA: { dia: limiteGuardado(v('limDiaAsisa'), LIMITES_DEFECTO.ASISA.dia), mes: limiteGuardado(v('limMesAsisa'), LIMITES_DEFECTO.ASISA.mes), avisar: booleano(v('avisarAsisa'), LIMITES_DEFECTO.ASISA.avisar) },
      OLIMPIA: { dia: limiteGuardado(v('limDiaOlimpia'), LIMITES_DEFECTO.OLIMPIA.dia), mes: limiteGuardado(v('limMesOlimpia'), LIMITES_DEFECTO.OLIMPIA.mes), avisar: booleano(v('avisarOlimpia'), LIMITES_DEFECTO.OLIMPIA.avisar) },
    },
    alerta: booleano(v('alerta'), DEFECTOS.alerta),
    alertaCadaMin: (() => { const m = entero(v('alertaCada'), DEFECTOS.alertaCadaMin); return Number.isInteger(m) && m >= 0 && m <= 1440 ? m : DEFECTOS.alertaCadaMin; })(),
    cupos: {
      ASISA: { dia: entero(v('cupoDiaAsisa')), mes: entero(v('cupoMesAsisa')), valor: decimal(v('valorAsisa')) },
      OLIMPIA: { dia: entero(v('cupoDiaOlimpia')), mes: entero(v('cupoMesOlimpia')), valor: decimal(v('valorOlimpia')) },
    },
    ultimaAlerta: texto(valores[CLAVE_ULTIMA_ALERTA]),
    clientesAvisados: CLAVES_CLIENTES_AVISADOS.map((k) => texto(valores[k])).join(''),
    tablaLista: tabla,
  };
  cfg.configurada = !!(cfg.servidor && cfg.usuario && cfg.clave);
  return cfg;
}

/** Lo que ve la pantalla. `admin`: además servidor, usuario y demás datos de la conexión (nunca la clave). */
async function obtenerPublica({ admin = false } = {}) {
  const c = await obtenerInterna();
  const base = {
    configurada: c.configurada, limites: c.limites, alerta: c.alerta, alertaCadaMin: c.alertaCadaMin, cupos: c.cupos,
    tablaLista: c.tablaLista,
  };
  if (!admin) return base;
  return {
    ...base,
    servidor: c.servidor, puerto: c.puerto, base: c.base, usuario: c.usuario, tieneClave: !!c.clave, claveIlegible: c.claveIlegible,
    claveFin: c.clave ? c.clave.slice(-2) : null, cifrado: c.cifrado, confiarCertificado: c.confiarCertificado,
    windows: /^[^\\]+\\.+$/.test(c.usuario), defectos: DEFECTOS, recordatorios: RECORDATORIOS_MIN,
  };
}

// ---------------------------------------------------------------------------
// Validación y guardado
// ---------------------------------------------------------------------------
function enteroOpcional(valor, etiqueta, max = 100000000) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return { valor: null };
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0 || n > max) return { error: `${etiqueta} debe ser un número entero entre 0 y ${max}.` };
  return { valor: n };
}

/** Devuelve { valor } (campos listos para guardar) o { error }. `claveExistente`: true si ya hay una clave guardada. */
function validar(entrada, claveExistente) {
  const e = entrada || {};
  const v = {};

  let servidor = texto(e.servidor);
  let puerto = e.puerto;
  const coma = servidor.match(/^([^,]+),\s*(\d{1,5})$/); // «AWLPROD001,61733» como en SSMS
  if (coma) { servidor = coma[1].trim(); if (puerto === undefined || puerto === null || String(puerto).trim() === '') puerto = coma[2]; }
  if (!servidor) return { error: 'El servidor es obligatorio.' };
  if (!RE_HOST.test(servidor)) return { error: 'El servidor solo puede tener letras, números, punto, guion y «\\» (instancia).' };
  v.servidor = servidor;

  const p = entero(puerto, DEFECTOS.puerto);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: 'El puerto debe estar entre 1 y 65535.' };
  v.puerto = p;

  v.base = texto(e.base, DEFECTOS.base);
  if (!RE_IDENT.test(v.base)) return { error: 'El nombre de la base de datos no es válido.' };

  v.usuario = texto(e.usuario);
  if (!v.usuario || v.usuario.length > 128) return { error: 'El usuario es obligatorio (máx. 128 caracteres). Para una cuenta de dominio escribe DOMINIO\\usuario.' };

  const clave = e.clave === undefined || e.clave === null ? '' : String(e.clave);
  if (clave !== '') {
    if (clave.length > 100) return { error: 'La clave es demasiado larga (máx. 100 caracteres).' };
    v.clave = clave;
  } else if (!claveExistente) {
    return { error: 'La clave es obligatoria.' };
  }
  v.cifrado = !!e.cifrado;
  v.confiarCertificado = e.confiarCertificado === undefined ? true : !!e.confiarCertificado;

  // Límites por cliente, por proveedor: vacío o 0 = sin límite (solo monitoreo). `avisar`: ese proveedor genera alerta por correo.
  const limites = {};
  for (const prov of PROVEEDORES) {
    // Si quien llama no manda los límites de un proveedor, se usan los de la regla del negocio (OLIMPIA 5/15 con alerta; ASISA sin límite).
    if (!e.limites || !e.limites[prov]) { limites[prov] = { ...LIMITES_DEFECTO[prov] }; continue; }
    const l = e.limites[prov];
    const dia = enteroOpcional(l.dia, `El límite diario por cliente de ${prov}`, 1000);
    const mes = enteroOpcional(l.mes, `El límite mensual por cliente de ${prov}`, 100000);
    if (dia.error || mes.error) return { error: dia.error || mes.error };
    if (dia.valor && mes.valor && mes.valor < dia.valor) return { error: `El límite mensual de ${prov} (${mes.valor}) no puede ser menor que el diario (${dia.valor}).` };
    limites[prov] = { dia: dia.valor || null, mes: mes.valor || null, avisar: !!l.avisar };
  }
  v.limites = limites;
  v.alerta = !!e.alerta;

  if (e.alertaCadaMin === undefined || e.alertaCadaMin === null || String(e.alertaCadaMin).trim() === '') v.alertaCadaMin = DEFECTOS.alertaCadaMin;
  else {
    const m = Number(e.alertaCadaMin);
    if (!Number.isInteger(m) || !RECORDATORIOS_MIN.includes(m)) return { error: 'Elige un intervalo de recordatorio válido de la lista.' };
    v.alertaCadaMin = m;
  }

  const cupos = {};
  for (const prov of PROVEEDORES) {
    const c = (e.cupos && e.cupos[prov]) || {};
    const dia = enteroOpcional(c.dia, `El cupo diario de ${prov}`);
    const mes = enteroOpcional(c.mes, `El cupo mensual de ${prov}`);
    if (dia.error || mes.error) return { error: dia.error || mes.error };
    let valor = null;
    if (c.valor !== undefined && c.valor !== null && String(c.valor).trim() !== '') {
      valor = decimal(c.valor);
      if (valor === null || valor < 0 || valor > 1000000000) return { error: `El valor por consulta de ${prov} no es válido.` };
    }
    cupos[prov] = { dia: dia.valor, mes: mes.valor, valor };
  }
  v.cupos = cupos;
  return { valor: v };
}

async function escribir(bd, pares, usuarioId) {
  for (const [clave, valor] of pares) {
    await bd.query(
      `INSERT INTO ${TABLA} (Clave, Valor, ActualizadoPorId) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE Valor = VALUES(Valor), ActualizadoPorId = VALUES(ActualizadoPorId)`,
      [clave, String(valor ?? ''), usuarioId || null]
    );
  }
}

async function guardar(valor, usuarioId) {
  const bd = await getPool();
  const c = valor.cupos;
  const pares = [
    [CLAVES.servidor, valor.servidor], [CLAVES.puerto, valor.puerto], [CLAVES.base, valor.base], [CLAVES.usuario, valor.usuario],
    [CLAVES.cifrado, valor.cifrado ? '1' : '0'], [CLAVES.confiarCertificado, valor.confiarCertificado ? '1' : '0'],
    [CLAVES.limDiaAsisa, valor.limites.ASISA.dia ?? ''], [CLAVES.limMesAsisa, valor.limites.ASISA.mes ?? ''], [CLAVES.avisarAsisa, valor.limites.ASISA.avisar ? '1' : '0'],
    [CLAVES.limDiaOlimpia, valor.limites.OLIMPIA.dia ?? ''], [CLAVES.limMesOlimpia, valor.limites.OLIMPIA.mes ?? ''], [CLAVES.avisarOlimpia, valor.limites.OLIMPIA.avisar ? '1' : '0'],
    [CLAVES.alerta, valor.alerta ? '1' : '0'], [CLAVES.alertaCada, valor.alertaCadaMin],
    [CLAVES.cupoDiaAsisa, c.ASISA.dia ?? ''], [CLAVES.cupoMesAsisa, c.ASISA.mes ?? ''], [CLAVES.valorAsisa, c.ASISA.valor ?? ''],
    [CLAVES.cupoDiaOlimpia, c.OLIMPIA.dia ?? ''], [CLAVES.cupoMesOlimpia, c.OLIMPIA.mes ?? ''], [CLAVES.valorOlimpia, c.OLIMPIA.valor ?? ''],
  ];
  if (valor.clave !== undefined) pares.push([CLAVES.clave, cifrar(valor.clave)]);
  try {
    await escribir(bd, pares, usuarioId);
  } catch (e) {
    if (esErrorTablaInexistente(e)) throw new ErrorConfig('Falta la tabla ConfiguracionSistema en la base de AXIS (la crea el DBA con crear_tabla_configuracion_sistema_BIC_CERTI_MARIA.sql).', 500, 'SIN_TABLA');
    throw e;
  }
  cache = { en: 0, valores: null, tabla: true };
  await cerrarPool();
}

/** Guarda el estado de lo ya avisado: `firma` (texto corto) y `clientes` (texto largo repartido en varias claves). */
async function registrarAlertaEnviada(firma, clientes = '') {
  const bd = await getPool();
  const largo = String(clientes);
  const pares = [[CLAVE_ULTIMA_ALERTA, String(firma).slice(0, LARGO_CLAVE_ESTADO)]];
  CLAVES_CLIENTES_AVISADOS.forEach((k, i) => pares.push([k, largo.slice(i * LARGO_CLAVE_ESTADO, (i + 1) * LARGO_CLAVE_ESTADO)]));
  await escribir(bd, pares, null);
  cache = { en: 0, valores: null, tabla: true };
}

// ---------------------------------------------------------------------------
// Conexión a SQL Server
// ---------------------------------------------------------------------------
/** Convierte la configuración (o un borrador) en la configuración del driver mssql. */
function configDriver(c) {
  let servidor = String(c.servidor || '').trim();
  let instancia = null;
  const m = servidor.match(/^([^\\]+)\\(.+)$/);
  if (m) { servidor = m[1]; instancia = m[2]; }
  let usuario = String(c.usuario || '').trim();
  let dominio = null;
  const d = usuario.match(/^([^\\]+)\\(.+)$/);
  if (d) { dominio = d[1]; usuario = d[2]; }
  const timeout = Math.min(Math.max(parseInt(process.env.BIOMETRIA_CONSUMO_TIMEOUT_MS || '60000', 10) || 60000, 5000), 180000);
  const config = {
    server: servidor, user: usuario, password: c.clave, ...(dominio ? { domain: dominio } : {}),
    database: c.base || DEFECTOS.base,
    connectionTimeout: 15000, requestTimeout: timeout,
    pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: !!c.cifrado, trustServerCertificate: c.confiarCertificado !== false, appName: 'AXIS-Biometria-Consumo', enableArithAbort: true,
      ...(instancia ? { instanceName: instancia } : {}),
    },
  };
  if (!instancia && Number.isInteger(c.puerto) && c.puerto > 0 && c.puerto < 65536) config.port = c.puerto;
  return config;
}

const huella = (c) => [c.servidor, c.puerto, c.base, c.usuario, c.clave, c.cifrado, c.confiarCertificado].join('|');

async function cerrarPool() {
  const p = pool;
  pool = null; huellaPool = null;
  if (p) { try { (await p).close(); } catch (_) { /* ya cerrada */ } }
}

async function obtenerPoolSql() {
  const c = await obtenerInterna();
  if (c.claveIlegible) throw new ErrorConfig('La clave guardada ya no se puede leer (cambió la clave de cifrado del backend). Vuelve a escribirla en Configuración.', 400, 'CLAVE_ILEGIBLE');
  if (!c.configurada) throw new ErrorConfig('Falta configurar la conexión a ORQBIOMETRIA: un ADMIN_POD debe indicar el usuario y la clave en «Consumo y reusos → Configuración».', 400, 'SIN_CONFIG');
  const h = huella(c);
  if (pool && huellaPool === h) return pool;
  await cerrarPool();
  const m = sql.cargarDriver();
  const actual = (async () => {
    const p = new m.ConnectionPool(configDriver(c));
    if (typeof p.on === 'function') p.on('error', () => { if (pool === actual) { pool = null; huellaPool = null; } });
    await p.connect();
    return p;
  })();
  pool = actual; huellaPool = h;
  try { return await actual; } catch (e) { if (pool === actual) { pool = null; huellaPool = null; } throw e; }
}

function tipoSql(m, tipo) {
  if (tipo === 'int') return m.Int;
  if (tipo === 'nvarchar') return m.NVarChar;
  return m.VarChar;
}

/** Ejecuta una consulta de SOLO LECTURA armada por el backend. parametros: [{ nombre, tipo, valor }] */
async function consultar(consulta, parametros = []) {
  let p = null;
  try {
    const m = sql.cargarDriver();
    p = await obtenerPoolSql();
    const req = (await p).request();
    for (const x of parametros) req.input(x.nombre, tipoSql(m, x.tipo), x.valor);
    const r = await req.query(consulta);
    return r.recordset || [];
  } catch (error) {
    if (p && ['ECONNCLOSED', 'ESOCKET', 'ENOTOPEN'].includes(error.code)) await cerrarPool();
    throw error;
  }
}

/** Mensaje entendible a partir de un error (nunca incluye la clave). */
function mensajeError(error) {
  const codigo = error?.codigo || error?.code;
  const texto_ = String(error?.message || error || '');
  if (['SIN_CONFIG', 'SIN_DRIVER', 'CLAVE_ILEGIBLE', 'SIN_TABLA', 'CONFIG', 'VALIDACION'].includes(codigo)) return texto_;
  switch (codigo) {
    case 'ELOGIN': return 'Inicio de sesión rechazado en ORQBIOMETRIA: el usuario o la clave no son válidos, o la cuenta no tiene acceso a la base. Un ADMIN_POD puede corregirlos en Configuración.';
    case 'ETIMEOUT': return 'Tiempo de espera agotado hablando con ORQBIOMETRIA (host, puerto o firewall; o la consulta tardó demasiado: prueba un rango más corto).';
    case 'ESOCKET': case 'ECONNREFUSED': case 'ENOTFOUND': case 'EINSTLOOKUP': case 'EHOSTUNREACH':
      return 'No se pudo conectar a ORQBIOMETRIA: revisa servidor, puerto y que el servidor de AXIS tenga ruta y regla de firewall hacia SQL Server.';
    case 'ECONNCLOSED': case 'ENOTOPEN': return 'La conexión con ORQBIOMETRIA se cerró; se reintentará en la próxima consulta.';
    default: break;
  }
  const numero = error?.number;
  if (numero === 229 || numero === 230 || numero === 262 || /permission was denied/i.test(texto_)) return 'La cuenta no tiene permiso SELECT sobre alguna de las tablas necesarias de ORQBIOMETRIA.';
  if (numero === 208 || /invalid object name/i.test(texto_)) return `En ORQBIOMETRIA no existe alguna de las tablas esperadas (${texto_.slice(0, 160)}).`;
  if (numero === 4060 || /cannot open database/i.test(texto_)) return 'La base de datos configurada no existe o la cuenta no tiene acceso.';
  if (/self.signed|certificate|ssl|tls/i.test(texto_)) return 'Falló el cifrado de la conexión (certificado). Activa «Confiar en el certificado del servidor» o revisa el cifrado.';
  return `Error consultando ORQBIOMETRIA: ${texto_.slice(0, 300)}`;
}

/** Prueba un borrador (sin guardarlo). Si no trae clave usa la guardada. */
async function probarBorrador(valor) {
  const guardada = await obtenerInterna();
  const campos = { ...valor, clave: valor.clave !== undefined ? valor.clave : guardada.clave };
  if (!campos.clave) return { ok: false, error: 'Falta la clave.' };
  let p = null;
  try {
    const m = sql.cargarDriver();
    p = new m.ConnectionPool({ ...configDriver(campos), pool: { max: 1, min: 0, idleTimeoutMillis: 3000 } });
    if (typeof p.on === 'function') p.on('error', () => { /* se cierra abajo */ });
    await p.connect();
    const r = await p.request().query('SELECT @@VERSION AS version, DB_NAME() AS base, (SELECT COUNT(*) FROM dbo.CASO) AS casos');
    const fila = (r.recordset || [])[0] || {};
    return { ok: true, version: String(fila.version || '').split('\n')[0].slice(0, 120), base: fila.base || campos.base, casos: Number(fila.casos) || 0 };
  } catch (error) {
    return { ok: false, error: mensajeError(error) };
  } finally {
    if (p) { try { await p.close(); } catch (_) { /* nada */ } }
  }
}

async function probarGuardada() {
  const c = await obtenerInterna();
  if (!c.configurada) return { ok: false, error: 'Aún no hay usuario y clave configurados.' };
  return probarBorrador({ servidor: c.servidor, puerto: c.puerto, base: c.base, usuario: c.usuario, cifrado: c.cifrado, confiarCertificado: c.confiarCertificado });
}

module.exports = {
  PROVEEDORES, DEFECTOS, RECORDATORIOS_MIN, CAPACIDAD_CLIENTES_AVISADOS: CLAVES_CLIENTES_AVISADOS.length * LARGO_CLAVE_ESTADO, ErrorConfig, obtenerInterna, obtenerPublica, validar, guardar, registrarAlertaEnviada,
  consultar, mensajeError, probarBorrador, probarGuardada, cerrarPool,
  _prueba: { configDriver, texto, entero, decimal },
};
