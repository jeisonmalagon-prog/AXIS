// ==========================================================================
// Credenciales PERSONALES del Catálogo de Datos.
//
// Los servidores (nombre, host, puerto) son una lista compartida que administra el ADMIN_POD, pero
// SIN usuario ni clave. Cada persona escribe SU usuario y SU clave (una por motor: SQL Server /
// MariaDB, que se usan con todos los servidores de ese motor) y con ellas se construye SU catálogo
// y SU mapa estelar. Nadie usa las credenciales de otra persona:
//   - viven solo en la memoria del backend (clave cifrada), ligadas a su usuario;
//   - vencen solas (CATALOGO_SESION_HORAS, 8 h por defecto) y no se guardan en ninguna base ni en el .env;
//   - nunca vuelven al navegador (solo se muestra el usuario y los 2 últimos caracteres de la clave);
//   - nunca se escriben en la auditoría ni en los logs.
// Lo que cada persona puede ver o consultar lo decide su propia cuenta de base de datos.
// ==========================================================================

const { AsyncLocalStorage } = require('async_hooks');
const { cifrar, descifrar } = require('./catalogoOrigenes');

const MOTORES = ['MSSQL', 'MARIADB'];
const contexto = new AsyncLocalStorage();
const sesiones = new Map(); // usuarioApp -> { MSSQL: { usuario, claveCifrada, claveFin, expira }, MARIADB: {...} }

function horasSesion() {
  const h = parseFloat(process.env.CATALOGO_SESION_HORAS || '8');
  return Math.min(Math.max(Number.isFinite(h) ? h : 8, 0.25), 72);
}

/** Ejecuta `fn` (y todo lo asíncrono que dispare) en nombre de `usuario`: ahí se usa SU catálogo y SUS credenciales. */
function ejecutarComo(usuario, fn) {
  return contexto.run({ usuario: usuario ? String(usuario) : null }, fn);
}

function usuarioActual() {
  return contexto.getStore()?.usuario || null;
}

function entrada(usuarioApp, motor) {
  if (!usuarioApp) return null;
  const e = sesiones.get(usuarioApp)?.[motor];
  if (!e) return null;
  if (Date.now() > e.expira) { quitar(usuarioApp, motor); return null; }
  return e;
}

// Devuelve { valor } o { error }. `existente`: ya hay una clave en la sesión (se conserva si no se envía otra).
function validar(datos, existente) {
  const d = datos || {};
  const usuario = String(d.usuario ?? '').trim();
  if (!usuario || usuario.length > 128) return { error: 'El usuario es obligatorio (máx. 128 caracteres).' };
  const clave = d.clave === undefined || d.clave === null ? '' : String(d.clave);
  if (clave === '' && !existente) return { error: 'La clave es obligatoria.' };
  if (clave.length > 256) return { error: 'La clave es demasiado larga.' };
  return { valor: { usuario, ...(clave !== '' ? { clave } : {}) } };
}

function tieneClave(usuarioApp, motor) {
  return !!entrada(usuarioApp, motor)?.claveCifrada;
}

function definir(usuarioApp, motor, { usuario, clave }) {
  if (!usuarioApp) throw new Error('No se pudo identificar tu sesión.');
  if (!MOTORES.includes(motor)) throw new Error(`Motor desconocido: ${motor}`);
  const previa = entrada(usuarioApp, motor);
  const claveEnClaro = clave !== undefined ? String(clave) : (previa?.claveCifrada ? descifrar(previa.claveCifrada) || '' : '');
  const porMotor = sesiones.get(usuarioApp) || {};
  porMotor[motor] = {
    usuario, claveCifrada: cifrar(claveEnClaro), claveFin: claveEnClaro.slice(-2),
    expira: Date.now() + horasSesion() * 3600 * 1000,
  };
  sesiones.set(usuarioApp, porMotor);
}

function quitar(usuarioApp, motor) {
  const porMotor = sesiones.get(usuarioApp);
  if (!porMotor || !porMotor[motor]) return false;
  delete porMotor[motor];
  if (!Object.keys(porMotor).length) sesiones.delete(usuarioApp);
  return true;
}

/** ¿Esta persona tiene credenciales vigentes para algún motor? */
function tieneSesion(usuarioApp) {
  return MOTORES.some((m) => !!entrada(usuarioApp, m));
}

// Credenciales en claro de ESA persona (solo uso interno del backend).
function credencialesDe(usuarioApp, motor) {
  const e = entrada(usuarioApp, motor);
  if (!e) return null;
  const clave = e.claveCifrada ? descifrar(e.claveCifrada) : null;
  return clave ? { usuario: e.usuario, clave } : null;
}

/** Devuelve el origen con las credenciales de `usuarioApp`, o null si esa persona no las tiene para ese motor. */
function conCredenciales(origen, usuarioApp) {
  const c = credencialesDe(usuarioApp, origen.motor);
  return c ? { ...origen, usuario: c.usuario, clave: c.clave } : null;
}

// Para la pantalla: nunca la clave.
function resumen(usuarioApp) {
  const salida = {};
  for (const m of MOTORES) {
    const e = entrada(usuarioApp, m);
    salida[m] = e
      ? { configurada: true, usuario: e.usuario, claveFin: e.claveFin || null, expira: new Date(e.expira).toISOString() }
      : { configurada: false, usuario: null, claveFin: null, expira: null };
  }
  return salida;
}

const nombreMotor = (m) => (m === 'MSSQL' ? 'SQL Server' : 'MariaDB');

// Barre las sesiones vencidas cada 5 minutos.
setInterval(() => {
  for (const [u, porMotor] of [...sesiones.entries()]) for (const m of Object.keys(porMotor)) entrada(u, m);
}, 5 * 60 * 1000).unref();

module.exports = {
  MOTORES, ejecutarComo, usuarioActual, validar, definir, quitar, tieneSesion, tieneClave, credencialesDe, conCredenciales, resumen, nombreMotor,
};
