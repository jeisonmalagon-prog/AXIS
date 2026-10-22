// Configuración global del sistema (clave/valor) — pensada para ajustes que
// aplican a TODA la aplicación (ej. tema claro/oscuro, color del login), no
// a un usuario en particular. El login necesita poder leer estos valores
// ANTES de que exista una sesión, así que esto vive fuera del mecanismo de
// "preferencias de usuario".
//
// Igual que con f5_historico/AuditoriaGeneral, la tabla se garantiza en
// tiempo de ejecución (CREATE TABLE IF NOT EXISTS) para no depender de una
// migración manual, pero como la cuenta de BD de la app NO tiene privilegio
// CREATE, en la práctica esta tabla la crea antes un DBA con el script
// crear_tabla_configuracion_sistema_BIC_CERTI_MARIA.sql — esto de aquí es
// solo una red de seguridad para no tronar si igual se intenta.

const TEMA_POR_DEFECTO = 'claro';
const TEMAS_VALIDOS = ['claro', 'oscuro'];

// Color de marca del login (degradado, botón, acentos). Es un color HEX de
// 6 dígitos ("#673ab7"); a partir de este único valor el frontend genera el
// resto de la paleta (tono oscuro para el degradado, tonos claros para modo
// oscuro) -- ver frontend/src/app/shared/color-login.util.ts. Solo afecta
// la pantalla de login, nunca el resto del sistema.
const COLOR_LOGIN_POR_DEFECTO = '#673ab7';
const PATRON_COLOR_HEX = /^#[0-9A-Fa-f]{6}$/;

// errno 1142/1143 = el usuario de BD no tiene permiso CREATE/ALTER (mismo
// criterio que esErrorDePermisosDdl() en auditoriaGeneral.js/usuariosAuditoria.js).
function esErrorDePermisosDdl(err) {
  return err && (err.errno === 1142 || err.errno === 1143);
}

let tablaConfiguracionLista = false;
async function garantizarTablaConfiguracion(pool) {
  if (tablaConfiguracionLista) return;
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS ConfiguracionSistema (
      Clave VARCHAR(50) NOT NULL PRIMARY KEY,
      Valor VARCHAR(255) NOT NULL,
      ActualizadoPorId INT NULL,
      ActualizadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
    `);
  } catch (err) {
    if (!esErrorDePermisosDdl(err)) throw err;
    console.warn('No se pudo verificar/crear la tabla ConfiguracionSistema (el usuario de BD no tiene permiso CREATE); se asume que ya existe:', err.sqlMessage || err.message);
  }
  tablaConfiguracionLista = true;
}

async function obtenerTema(pool) {
  await garantizarTablaConfiguracion(pool);
  const [filas] = await pool.query(
    "SELECT Valor FROM ConfiguracionSistema WHERE Clave = 'tema_global'"
  );
  const valor = filas[0]?.Valor;
  return TEMAS_VALIDOS.includes(valor) ? valor : TEMA_POR_DEFECTO;
}

async function actualizarTema(pool, nuevoTema, usuarioId) {
  if (!TEMAS_VALIDOS.includes(nuevoTema)) {
    const err = new Error(`Tema inválido: "${nuevoTema}". Debe ser "claro" u "oscuro".`);
    err.esValidacion = true;
    throw err;
  }
  await garantizarTablaConfiguracion(pool);
  await pool.query(
    `INSERT INTO ConfiguracionSistema (Clave, Valor, ActualizadoPorId)
     VALUES ('tema_global', ?, ?)
     ON DUPLICATE KEY UPDATE Valor = VALUES(Valor), ActualizadoPorId = VALUES(ActualizadoPorId)`,
    [nuevoTema, usuarioId || null]
  );
  return nuevoTema;
}


// ---------------------------------------------------------------------------
// Color del LOGIN (elegible solo por ADMIN_POD desde /configuracion). Se
// reusa la misma tabla ConfiguracionSistema (clave/valor), igual criterio
// que con tema_global: una sola fila, visible sin sesión porque el login la
// necesita antes de que exista un token.
async function obtenerColorLogin(pool) {
  await garantizarTablaConfiguracion(pool);
  const [filas] = await pool.query(
    "SELECT Valor FROM ConfiguracionSistema WHERE Clave = 'color_login'"
  );
  const valor = filas[0]?.Valor;
  return PATRON_COLOR_HEX.test(valor || '') ? valor : COLOR_LOGIN_POR_DEFECTO;
}

async function actualizarColorLogin(pool, nuevoColor, usuarioId) {
  if (!PATRON_COLOR_HEX.test(nuevoColor || '')) {
    const err = new Error(`Color inválido: "${nuevoColor}". Debe ser un color hexadecimal, ej. "#673ab7".`);
    err.esValidacion = true;
    throw err;
  }
  await garantizarTablaConfiguracion(pool);
  await pool.query(
    `INSERT INTO ConfiguracionSistema (Clave, Valor, ActualizadoPorId)
     VALUES ('color_login', ?, ?)
     ON DUPLICATE KEY UPDATE Valor = VALUES(Valor), ActualizadoPorId = VALUES(ActualizadoPorId)`,
    [nuevoColor, usuarioId || null]
  );
  return nuevoColor;
}


// ---------------------------------------------------------------------------
// Tema PERSONAL por usuario (opcional): cada usuario puede elegir su propio
// tema desde /perfil, independiente del tema_global que sigue controlando
// ADMIN_POD desde /configuracion (y lo que ve el login, antes de iniciar
// sesión). Se reusa la MISMA tabla ConfiguracionSistema (clave/valor) en vez
// de crear una tabla o columna nueva -- exactamente el mismo motivo de
// siempre: la cuenta de BD de la app no tiene privilegio CREATE/ALTER, solo
// SELECT/INSERT/UPDATE (tampoco DELETE), así que la preferencia "vuelve a
// seguir el tema del sistema" se guarda como el valor 'sistema' en vez de
// borrar la fila.
const TEMAS_USUARIO_VALIDOS = ['claro', 'oscuro', 'sistema'];

function claveTemaUsuario(usuarioId) {
  return `tema_usuario_${usuarioId}`;
}

// Devuelve 'claro' | 'oscuro' si el usuario tiene una preferencia propia
// guardada, o null si nunca la definió (o eligió explícitamente 'sistema') --
// en cualquiera de esos casos el que llama debe usar el tema_global.
async function obtenerTemaUsuario(pool, usuarioId) {
  await garantizarTablaConfiguracion(pool);
  const [filas] = await pool.query(
    'SELECT Valor FROM ConfiguracionSistema WHERE Clave = ?',
    [claveTemaUsuario(usuarioId)]
  );
  const valor = filas[0]?.Valor;
  return TEMAS_VALIDOS.includes(valor) ? valor : null;
}

// nuevoValor: 'claro' | 'oscuro' | 'sistema'. Siempre INSERT/UPDATE (nunca
// DELETE, ver nota arriba). Devuelve 'claro'/'oscuro' guardado, o null si
// el usuario eligió 'sistema'.
async function actualizarTemaUsuario(pool, usuarioId, nuevoValor) {
  if (!TEMAS_USUARIO_VALIDOS.includes(nuevoValor)) {
    const err = new Error(`Tema inválido: "${nuevoValor}". Debe ser "claro", "oscuro" o "sistema".`);
    err.esValidacion = true;
    throw err;
  }
  await garantizarTablaConfiguracion(pool);
  await pool.query(
    `INSERT INTO ConfiguracionSistema (Clave, Valor, ActualizadoPorId)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE Valor = VALUES(Valor), ActualizadoPorId = VALUES(ActualizadoPorId)`,
    [claveTemaUsuario(usuarioId), nuevoValor, usuarioId]
  );
  return nuevoValor === 'sistema' ? null : nuevoValor;
}

module.exports = {
  TEMA_POR_DEFECTO,
  TEMAS_VALIDOS,
  obtenerTema,
  actualizarTema,
  obtenerTemaUsuario,
  actualizarTemaUsuario,
  COLOR_LOGIN_POR_DEFECTO,
  obtenerColorLogin,
  actualizarColorLogin,
};
