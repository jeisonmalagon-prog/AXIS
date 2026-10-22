// Duración de la sesión por usuario.
//
// Por defecto TODOS tienen la política de siempre: cierre por inactividad a los
// 15 min (lo aplica el frontend, ShellComponent) y un JWT de 2 h.
//
// El ADMIN_POD puede habilitar a ciertos usuarios (usuarios.sesion_personalizable)
// para que ellos mismos elijan en "Mi perfil" cuánto tiempo de inactividad
// tolera su sesión (usuarios.sesion_minutos, una de OPCIONES_MINUTOS). Para esos
// usuarios el JWT dura ese tiempo (+ un margen) y el frontend lo renueva solo
// mientras la persona está activa -- así la sesión se cierra por INACTIVIDAD
// real y no a las 2 h aunque esté trabajando.
//
// Las dos columnas se crean con Claude outputs/agregar_sesion_personalizada_usuarios.sql
// (o solas, si el usuario de BD puede hacer ALTER). Mientras no existan nada se
// rompe: todos siguen con la política por defecto.

const { esErrorDePrivilegios, columnasFaltantes } = require('./esquemaSeguro');

const MINUTOS_POR_DEFECTO = 15;
const OPCIONES_MINUTOS = [15, 30, 60, 120, 240, 480, 720]; // 15 min ... 12 h
const TOKEN_POR_DEFECTO = '2h';
// El token vive un poco más que el tiempo de inactividad: el frontend lo renueva
// con un pequeño retraso (ver ShellComponent) y no debe vencer antes que la
// propia ventana de inactividad elegida.
const MARGEN_TOKEN_MIN = 6;

const COLUMNAS = ['sesion_personalizable', 'sesion_minutos'];

const MENSAJE_FALTA_COLUMNAS =
  'Faltan las columnas sesion_personalizable y sesion_minutos en la base de datos y el usuario de la aplicación no puede crearlas. ' +
  'Ejecuta una vez el script agregar_sesion_personalizada_usuarios.sql con una cuenta con privilegios.';

let columnasConfirmadas = false;
let proximaRevision = 0;

async function columnasSesionDisponibles(pool) {
  if (columnasConfirmadas) return true;
  if (Date.now() < proximaRevision) return false;
  const faltan = await columnasFaltantes(pool, 'usuarios', COLUMNAS);
  if (faltan.length === 0) { columnasConfirmadas = true; return true; }
  proximaRevision = Date.now() + 60000; // reintenta en 1 minuto (por si ya corrieron el script)
  return false;
}

// Como la anterior, pero si faltan intenta crearlas (solo si el usuario de BD
// tiene ALTER); sin privilegios devuelve false y la app sigue como siempre.
async function asegurarColumnasSesion(pool) {
  if (await columnasSesionDisponibles(pool)) return true;
  try {
    await pool.query(`
      ALTER TABLE usuarios
        ADD COLUMN IF NOT EXISTS sesion_personalizable TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS sesion_minutos INT NULL
    `);
  } catch (err) {
    if (esErrorDePrivilegios(err)) return false;
    throw err;
  }
  columnasConfirmadas = true;
  return true;
}

function minutosValidos(m) {
  return Number.isInteger(m) && OPCIONES_MINUTOS.includes(m);
}

// Estado de sesión de una fila de `usuarios`. Si la fila no trae las columnas
// (aún no creadas) nadie es personalizable. El ADMIN_POD siempre puede ajustar la suya.
function estadoSesion(user) {
  const columnas = user && user.sesion_personalizable !== undefined;
  const puede = !!columnas && (user.rol === 'ADMIN_POD' || Number(user.sesion_personalizable) === 1);
  const propio = puede && minutosValidos(Number(user.sesion_minutos)) ? Number(user.sesion_minutos) : null;
  return {
    puedePersonalizar: puede,
    personalizada: propio !== null,
    minutos: propio !== null ? propio : MINUTOS_POR_DEFECTO,
  };
}

// Valor de expiresIn para jwt.sign.
function expiracionToken(user) {
  const { personalizada, minutos } = estadoSesion(user);
  return personalizada ? `${minutos + MARGEN_TOKEN_MIN}m` : TOKEN_POR_DEFECTO;
}

function etiquetaMinutos(m) {
  if (m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}

module.exports = {
  MINUTOS_POR_DEFECTO,
  OPCIONES_MINUTOS,
  MENSAJE_FALTA_COLUMNAS,
  columnasSesionDisponibles,
  asegurarColumnasSesion,
  minutosValidos,
  estadoSesion,
  expiracionToken,
  etiquetaMinutos,
};
