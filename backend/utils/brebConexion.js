// Conexiones de Monitoreo transaccional > BREB. Las configura el ADMIN_POD desde la app (igual que las demás conexiones):
//   · sql: base SQL Server de BreB (trx.Redeban, dbo.llave, dbo.usuario…)            — servidor, puerto, base, usuario, clave
//   · log: base de logs LogBre_B (MariaDB, tabla Log)                                  — servidor, puerto, base, usuario, clave
//   · api: servicio de llaves de BreB (Swagger; SOLO «consultar llave» y «resolver llave») — URL, validar TLS, rutas (opcionales)
//
//  · Se guardan en ConfiguracionSistema (clave/valor). Las claves se guardan CIFRADAS (AES-256-GCM); jamás vuelven al navegador
//    (solo se informa si hay una y sus 2 últimos caracteres), ni a la auditoría, ni al log.
//  · La cuenta de BD de AXIS no tiene DELETE: «quitar» una conexión = guardar todo vacío.
//  · Respaldo: si no hay nada guardado se usan las variables BREB_DB_* / BREB_LOG_DB_* / BREB_API_URL del .env.
//  · Todo se usa en SOLO LECTURA.

const { getPool } = require('../db');
const sql = require('./sqlServer');
const maria = require('./brebMaria');
const api = require('./brebApi');
const { cifrar, descifrar } = require('./catalogoOrigenes');

const TABLA = 'ConfiguracionSistema';
const TTL_MS = 20000;
const DESTINOS = ['sql', 'log', 'api'];

const CLAVES = {
  sql: { servidor: 'breb_sql_servidor', puerto: 'breb_sql_puerto', base: 'breb_sql_base', usuario: 'breb_sql_usuario', clave: 'breb_sql_clave', opciones: 'breb_sql_opciones', propio: 'breb_banco_propio' },
  log: { servidor: 'breb_log_servidor', puerto: 'breb_log_puerto', base: 'breb_log_base', usuario: 'breb_log_usuario', clave: 'breb_log_clave', opciones: 'breb_log_opciones' },
  api: { url: 'breb_api_url', opciones: 'breb_api_opciones', rutaConsultar: 'breb_api_ruta_consultar', rutaResolver: 'breb_api_ruta_resolver' },
};
const ETIQUETA = { sql: 'Base SQL Server de BreB', log: 'Logs de BreB (MariaDB)', api: 'Servicio de llaves de BreB (Swagger)' };

const RE_HOST = /^[A-Za-z0-9_.\-\\]{1,200}$/;
const RE_IDENT = /^[A-Za-z0-9_$\- .]{1,128}$/;
const BANCO_PROPIO_DEF = '0063';
const RE_RUTA = /^\/[A-Za-z0-9_\-./]{1,150}$/;

class ErrorConexion extends Error {
  constructor(mensaje, status = 400, codigo = 'VALIDACION') { super(mensaje); this.status = status; this.codigo = codigo; }
}

let estado = { cargadoEn: 0, guardada: { sql: null, log: null, api: null } };
let cargando = null;

const esTablaInexistente = (e) => e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE');

function parsearOpciones(texto) {
  const o = { cifrado: false, confiarCertificado: true, validarTls: false };
  for (const par of String(texto || '').split(';')) {
    const [k, v] = par.split('=');
    if (k === 'cifrado') o.cifrado = v === '1';
    if (k === 'confiar') o.confiarCertificado = v !== '0';
    if (k === 'tls') o.validarTls = v === '1';
  }
  return o;
}
const textoOpciones = (v) => `cifrado=${v.cifrado ? 1 : 0};confiar=${v.confiarCertificado ? 1 : 0}`;
const textoOpcionesApi = (v) => `tls=${v.validarTls ? 1 : 0}`;

/** Lee lo guardado en la base de AXIS (una sola consulta para los tres destinos). */
async function leerTodas() {
  const bd = await getPool();
  const todas = DESTINOS.flatMap((d) => Object.values(CLAVES[d]));
  let filas = [];
  try {
    [filas] = await bd.query(`SELECT Clave, Valor FROM ${TABLA} WHERE Clave IN (${todas.map(() => '?').join(',')})`, todas);
  } catch (e) {
    if (!esTablaInexistente(e)) throw e;
  }
  const v = Object.fromEntries(filas.map((f) => [f.Clave, String(f.Valor ?? '')]));
  const salida = { sql: null, log: null, api: null };
  for (const d of ['sql', 'log']) {
    const k = CLAVES[d];
    if (!String(v[k.servidor] || '').trim()) continue;
    let clave = '';
    try { clave = v[k.clave] ? (descifrar(v[k.clave]) || '') : ''; } catch { clave = ''; }
    salida[d] = {
      servidor: v[k.servidor].trim(), puerto: parseInt(v[k.puerto] || (d === 'sql' ? '1433' : '3306'), 10) || (d === 'sql' ? 1433 : 3306),
      base: (v[k.base] || '').trim(), usuario: (v[k.usuario] || '').trim(), clave, ...parsearOpciones(v[k.opciones]),
      ...(d === 'sql' ? { bancoPropio: (v[k.propio] || '').trim() } : {}),
    };
  }
  const ka = CLAVES.api;
  if (String(v[ka.url] || '').trim()) {
    const o = parsearOpciones(v[ka.opciones]);
    salida.api = { url: v[ka.url].trim(), validarTls: o.validarTls, rutaConsultar: (v[ka.rutaConsultar] || '').trim(), rutaResolver: (v[ka.rutaResolver] || '').trim() };
  }
  return salida;
}

function aplicar(destino, guardada) {
  if (destino === 'sql') sql.establecerGlobal('breb', guardada);
  else if (destino === 'log') maria.establecer(guardada);
  else api.establecer(guardada);
}

const hayAplicada = (destino) => (destino === 'sql' ? sql.hayGlobal('breb') : destino === 'log' ? maria.hayGlobal() : api.hayGlobal());

/** Carga lo guardado y lo aplica a las conexiones en memoria (cada 20 s o cuando se fuerza). */
async function asegurar(forzar = false) {
  if (!forzar && Date.now() - estado.cargadoEn < TTL_MS) return estado;
  if (!cargando) {
    cargando = (async () => {
      try {
        const guardada = await leerTodas();
        for (const d of DESTINOS) {
          const igual = JSON.stringify(guardada[d]) === JSON.stringify(estado.guardada[d]);
          if (!igual || (guardada[d] && !hayAplicada(d)) || (!guardada[d] && hayAplicada(d))) aplicar(d, guardada[d]);
        }
        estado = { cargadoEn: Date.now(), guardada };
      } catch (e) {
        console.error('[breb] No se pudieron leer las conexiones guardadas (se usa lo último conocido o el .env):', e.message);
        estado = { ...estado, cargadoEn: Date.now() - TTL_MS + 3000 };
      }
      return estado;
    })().finally(() => { cargando = null; });
  }
  return cargando;
}

function destinoValido(d) {
  if (!DESTINOS.includes(d)) throw new ErrorConexion('Conexión desconocida.', 404, 'DESTINO');
  return d;
}

/** Valida lo que llega de la pantalla. `claveActual`: clave ya guardada (se conserva si no se envía otra). */
function validar(destino, entrada, { claveActual = '' } = {}) {
  destinoValido(destino);
  const e = entrada || {};
  const v = {};
  if (destino === 'api') {
    const u = String(e.url ?? '').trim();
    if (!u) return { error: 'La dirección (URL) del servicio es obligatoria.' };
    let url;
    try { url = new URL(u); } catch { return { error: 'La dirección no es una URL válida (ej. https://192.168.125.73:8001).' }; }
    if (!['http:', 'https:'].includes(url.protocol)) return { error: 'La dirección debe empezar por http:// o https://.' };
    if (url.username || url.password) return { error: 'La dirección no debe incluir usuario ni clave.' };
    if (!/^[A-Za-z0-9_.\-[\]:]+$/.test(url.host)) return { error: 'El host de la dirección no es válido.' };
    v.url = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
    v.validarTls = !!e.validarTls;
    for (const [campo, nombre] of [['rutaConsultar', 'consultar llave'], ['rutaResolver', 'resolver llave']]) {
      const r = String(e[campo] ?? '').trim();
      if (r && !RE_RUTA.test(r)) return { error: `La ruta de «${nombre}» debe empezar por «/» y tener solo letras, números, guion, punto o «/».` };
      if (r && /\.\./.test(r)) return { error: `La ruta de «${nombre}» no es válida.` };
      v[campo] = r;
    }
    return { valor: v };
  }
  const defPuerto = destino === 'sql' ? 1433 : 3306;
  v.servidor = String(e.servidor ?? '').trim();
  if (!v.servidor) return { error: 'El servidor es obligatorio.' };
  if (!RE_HOST.test(v.servidor)) return { error: 'El servidor solo puede tener letras, números, punto, guion y «\\» (instancia).' };
  if (destino === 'log' && v.servidor.includes('\\')) return { error: 'Para MariaDB el servidor es solo el host (sin «\\instancia»).' };
  const puerto = e.puerto === undefined || e.puerto === null || String(e.puerto).trim() === '' ? defPuerto : parseInt(e.puerto, 10);
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) return { error: 'El puerto debe estar entre 1 y 65535.' };
  v.puerto = puerto;
  v.base = String(e.base ?? '').trim() || (destino === 'sql' ? 'BreB' : 'LogBre_B');
  if (!RE_IDENT.test(v.base)) return { error: 'El nombre de la base de datos no es válido.' };
  v.usuario = String(e.usuario ?? '').trim();
  if (!v.usuario || v.usuario.length > 128) return { error: 'El usuario es obligatorio (máx. 128 caracteres).' };
  const clave = e.clave === undefined || e.clave === null ? '' : String(e.clave);
  if (clave !== '') {
    if (clave.length > 100) return { error: 'La clave es demasiado larga (máx. 100 caracteres).' };
    v.clave = clave;
  } else if (!claveActual) {
    return { error: 'La clave es obligatoria.' };
  } else {
    v.clave = claveActual;
  }
  v.cifrado = !!e.cifrado;
  v.confiarCertificado = e.confiarCertificado === undefined ? true : !!e.confiarCertificado;
  if (destino === 'sql') {
    const bp = String(e.bancoPropio ?? '').trim() || BANCO_PROPIO_DEF;
    if (!/^[A-Za-z0-9]{1,10}$/.test(bp)) return { error: 'El código de la entidad (Finandina) solo puede tener letras y números (ej. 0063).' };
    v.bancoPropio = bp;
  }
  return { valor: v };
}

async function guardarFila(bd, clave, valor, usuarioId) {
  await bd.query(
    `INSERT INTO ${TABLA} (Clave, Valor, ActualizadoPorId) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE Valor = VALUES(Valor), ActualizadoPorId = VALUES(ActualizadoPorId)`,
    [clave, valor, usuarioId || null],
  );
}

/** Guarda una conexión (v ya validado) o la quita (v = null → se guardan vacíos). */
async function guardar(destino, v, usuarioId) {
  destinoValido(destino);
  const bd = await getPool();
  let filas;
  if (destino === 'api') {
    filas = v
      ? { url: v.url, opciones: textoOpcionesApi(v), rutaConsultar: v.rutaConsultar || '', rutaResolver: v.rutaResolver || '' }
      : { url: '', opciones: '', rutaConsultar: '', rutaResolver: '' };
  } else {
    filas = v
      ? { servidor: v.servidor, puerto: String(v.puerto), base: v.base, usuario: v.usuario, clave: cifrar(v.clave), opciones: textoOpciones(v), ...(destino === 'sql' ? { propio: v.bancoPropio || BANCO_PROPIO_DEF } : {}) }
      : { servidor: '', puerto: '', base: '', usuario: '', clave: '', opciones: '', ...(destino === 'sql' ? { propio: '' } : {}) };
  }
  for (const [campo, valor] of Object.entries(filas)) {
    if (String(valor).length > 255) throw new ErrorConexion('Un dato de la conexión no cabe en la configuración (máximo 255 caracteres).');
    await guardarFila(bd, CLAVES[destino][campo], valor, usuarioId);
  }
  await asegurar(true);
}

/** Lo que ve la pantalla: nunca la clave. `admin`: también usuario y últimos 2 caracteres de la clave. */
async function vista(destino, { admin = false } = {}) {
  destinoValido(destino);
  await asegurar();
  const g = estado.guardada[destino];
  if (destino === 'api') {
    const r = api.resumen();
    const base = { configurada: r.configurada, origen: r.origen, url: r.url, validarTls: r.validarTls, rutaConsultar: r.rutaConsultar, rutaResolver: r.rutaResolver, guardadaEnApp: !!g, etiqueta: ETIQUETA.api };
    return base;
  }
  const r = destino === 'sql' ? sql.resumenConexion('breb') : maria.resumen();
  const base = {
    configurada: r.configurada, origen: r.origen, servidor: r.servidor, puerto: r.puerto, base: r.base, faltan: r.faltan, guardadaEnApp: !!g, etiqueta: ETIQUETA[destino],
    ...(destino === 'sql' ? { bancoPropio: (g && g.bancoPropio) || process.env.BREB_BANCO_PROPIO || BANCO_PROPIO_DEF } : {}),
  };
  if (!admin) return base;
  return {
    ...base,
    usuario: g ? g.usuario : null, tieneClave: !!(g && g.clave), claveFin: g && g.clave ? g.clave.slice(-2) : null,
    cifrado: g ? g.cifrado : false, confiarCertificado: g ? g.confiarCertificado : true,
  };
}

async function vistas({ admin = false } = {}) {
  const [s, l, a] = await Promise.all(DESTINOS.map((d) => vista(d, { admin })));
  return { sql: s, log: l, api: a };
}

/** Prueba lo guardado (sin campos) o un borrador de la pantalla (sin guardarlo). */
async function probar(destino, entrada) {
  destinoValido(destino);
  await asegurar();
  const hayBorrador = destino === 'api' ? !!String(entrada?.url || '').trim() : !!String(entrada?.servidor || '').trim();
  if (!hayBorrador) {
    if (destino === 'sql') return sql.probarConexion('breb');
    if (destino === 'log') return maria.probar();
    return api.probar();
  }
  const v = validar(destino, entrada, { claveActual: estado.guardada[destino]?.clave || '' });
  if (v.error) return { ok: false, error: v.error };
  if (destino === 'sql') return sql.probarBorrador('breb', v.valor);
  if (destino === 'log') return maria.probarBorrador(v.valor);
  return api.probar(v.valor);
}

/** Código de la entidad propia (por defecto 0063, Banco Finandina) para separar transacciones salientes y entrantes. */
async function bancoPropio() {
  await asegurar();
  return (estado.guardada.sql && estado.guardada.sql.bancoPropio) || process.env.BREB_BANCO_PROPIO || BANCO_PROPIO_DEF;
}

async function claveActual(destino) { await asegurar(); return estado.guardada[destino]?.clave || ''; }

function invalidar() { estado = { ...estado, cargadoEn: 0 }; }

module.exports = {
  DESTINOS, ETIQUETA, ErrorConexion, CLAVES, validar, guardar, vista, vistas, probar, asegurar, invalidar, claveActual, parsearOpciones, destinoValido, bancoPropio,
};
