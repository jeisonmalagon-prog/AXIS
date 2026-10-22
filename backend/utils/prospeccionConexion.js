// Conexión de SOLO LECTURA a GestionCliente (esquema PD) para Soporte Nivel 1 > Monitorear prospección.
//
// La configura el ADMIN_POD desde la app (igual que las demás conexiones): servidor, puerto, base, usuario y clave.
//  · Se guarda en ConfiguracionSistema (clave/valor). La clave se guarda CIFRADA (AES-256-GCM); jamás vuelve al navegador
//    (solo se informa si hay una y sus 2 últimos caracteres), ni a la auditoría, ni al log.
//  · La cuenta de BD de AXIS no tiene DELETE: «quitar» la conexión = guardar todo vacío.
//  · Respaldo: si no hay nada guardado se usan las variables GESTIONCLIENTE_DB_HOST/USER/PASSWORD/PORT/NAME del .env.
//  · Todo se usa en SOLO LECTURA: este módulo nunca escribe en SQL Server (ver prospeccionServicio.sqlSoloLectura).

const { getPool } = require('../db');
const sql = require('./sqlServer');
const { cifrar, descifrar } = require('./catalogoOrigenes');

const PERFIL = 'gestioncliente';
const TABLA = 'ConfiguracionSistema';
const CLAVES = {
  servidor: 'gc_servidor', puerto: 'gc_puerto', base: 'gc_base', usuario: 'gc_usuario', clave: 'gc_clave', opciones: 'gc_opciones',
};
const TTL_MS = 20000;

const RE_HOST = /^[A-Za-z0-9_.\-\\]{1,200}$/;
const RE_IDENT = /^[A-Za-z0-9_$\- .]{1,128}$/;

class ErrorConexion extends Error {
  constructor(mensaje, status = 400, codigo = 'VALIDACION') { super(mensaje); this.status = status; this.codigo = codigo; }
}

let estado = { cargadoEn: 0, guardada: null };
let cargando = null;

const esTablaInexistente = (e) => e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE');

function parsearOpciones(texto) {
  const o = { cifrado: false, confiarCertificado: true };
  for (const par of String(texto || '').split(';')) {
    const [k, v] = par.split('=');
    if (k === 'cifrado') o.cifrado = v === '1';
    if (k === 'confiar') o.confiarCertificado = v !== '0';
  }
  return o;
}

const textoOpciones = (v) => `cifrado=${v.cifrado ? 1 : 0};confiar=${v.confiarCertificado ? 1 : 0}`;

/** Lee lo guardado en la base de AXIS. Devuelve null si no hay servidor guardado. */
async function leerGuardada() {
  const bd = await getPool();
  let filas = [];
  try {
    [filas] = await bd.query(`SELECT Clave, Valor FROM ${TABLA} WHERE Clave IN (${Object.values(CLAVES).map(() => '?').join(',')})`, Object.values(CLAVES));
  } catch (e) {
    if (!esTablaInexistente(e)) throw e;
  }
  const v = Object.fromEntries(filas.map((f) => [f.Clave, String(f.Valor ?? '')]));
  if (!String(v[CLAVES.servidor] || '').trim()) return null;
  let clave = '';
  try { clave = v[CLAVES.clave] ? (descifrar(v[CLAVES.clave]) || '') : ''; } catch { clave = ''; }
  return {
    servidor: v[CLAVES.servidor].trim(), puerto: parseInt(v[CLAVES.puerto] || '1433', 10) || 1433, base: (v[CLAVES.base] || '').trim(),
    usuario: (v[CLAVES.usuario] || '').trim(), clave, ...parsearOpciones(v[CLAVES.opciones]),
  };
}

/** Carga lo guardado y lo aplica a la conexión en memoria (cada 20 s o cuando se fuerza). */
async function asegurar(forzar = false) {
  if (!forzar && Date.now() - estado.cargadoEn < TTL_MS) return estado;
  if (!cargando) {
    cargando = (async () => {
      try {
        const guardada = await leerGuardada();
        const igual = JSON.stringify(guardada) === JSON.stringify(estado.guardada);
        if (!igual || (guardada && !sql.hayGlobal(PERFIL)) || (!guardada && sql.hayGlobal(PERFIL))) {
          sql.establecerGlobal(PERFIL, guardada);
        }
        estado = { cargadoEn: Date.now(), guardada };
      } catch (e) {
        console.error('[prospeccion] No se pudo leer la conexión guardada (se usa la última conocida o el .env):', e.message);
        estado = { ...estado, cargadoEn: Date.now() - TTL_MS + 3000 };
      }
      return estado;
    })().finally(() => { cargando = null; });
  }
  return cargando;
}

/** Valida lo que llega de la pantalla. `claveActual`: clave ya guardada (se conserva si no se envía otra). */
function validar(entrada, { claveActual = '' } = {}) {
  const e = entrada || {};
  const v = {};
  v.servidor = String(e.servidor ?? '').trim();
  if (!v.servidor) return { error: 'El servidor es obligatorio.' };
  if (!RE_HOST.test(v.servidor)) return { error: 'El servidor solo puede tener letras, números, punto, guion y «\\» (instancia).' };
  const puerto = e.puerto === undefined || e.puerto === null || String(e.puerto).trim() === '' ? 1433 : parseInt(e.puerto, 10);
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) return { error: 'El puerto debe estar entre 1 y 65535.' };
  v.puerto = puerto;
  v.base = String(e.base ?? '').trim() || 'GestionCliente';
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
  return { valor: v };
}

async function guardarFila(bd, clave, valor, usuarioId) {
  await bd.query(
    `INSERT INTO ${TABLA} (Clave, Valor, ActualizadoPorId) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE Valor = VALUES(Valor), ActualizadoPorId = VALUES(ActualizadoPorId)`,
    [clave, valor, usuarioId || null],
  );
}

/** Guarda la conexión (v ya validado) o la quita (v = null → se guardan vacíos). */
async function guardar(v, usuarioId) {
  const bd = await getPool();
  const filas = v
    ? { servidor: v.servidor, puerto: String(v.puerto), base: v.base, usuario: v.usuario, clave: cifrar(v.clave), opciones: textoOpciones(v) }
    : { servidor: '', puerto: '', base: '', usuario: '', clave: '', opciones: '' };
  for (const [campo, valor] of Object.entries(filas)) {
    if (String(valor).length > 255) throw new ErrorConexion('Un dato de la conexión no cabe en la configuración (máximo 255 caracteres).');
    await guardarFila(bd, CLAVES[campo], valor, usuarioId);
  }
  await asegurar(true);
}

/** Lo que ve la pantalla: nunca la clave. `admin`: también usuario y últimos 2 caracteres de la clave. */
async function vista({ admin = false } = {}) {
  await asegurar();
  const r = sql.resumenConexion(PERFIL);
  const g = estado.guardada;
  const base = {
    configurada: r.configurada, origen: r.origen, servidor: r.servidor, puerto: r.puerto, base: r.base,
    faltan: r.faltan, guardadaEnApp: !!g,
  };
  if (!admin) return base;
  return {
    ...base,
    usuario: g ? g.usuario : null, tieneClave: !!(g && g.clave), claveFin: g && g.clave ? g.clave.slice(-2) : null,
    cifrado: g ? g.cifrado : false, confiarCertificado: g ? g.confiarCertificado : true,
  };
}

/** Prueba lo guardado (sin campos) o un borrador de la pantalla (sin guardarlo). */
async function probar(entrada) {
  await asegurar();
  if (!entrada || !String(entrada.servidor || '').trim()) {
    const r = await sql.probarConexion(PERFIL);
    return r;
  }
  const v = validar(entrada, { claveActual: estado.guardada ? estado.guardada.clave : '' });
  if (v.error) return { ok: false, error: v.error };
  return sql.probarBorrador(PERFIL, v.valor);
}

/** Clave guardada en claro (solo para el backend: se conserva si el formulario no trae una nueva). */
async function claveActual() { await asegurar(); return estado.guardada ? estado.guardada.clave : ''; }

function invalidar() { estado = { ...estado, cargadoEn: 0 }; }

module.exports = { PERFIL, ErrorConexion, CLAVES, validar, guardar, vista, probar, asegurar, invalidar, claveActual, parsearOpciones, textoOpciones };
