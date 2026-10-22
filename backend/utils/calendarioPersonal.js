// Personalización del calendario por usuario.
//
//  - CalendariosUsuario: calendarios de Google (por correo, solo lectura) que un
//    usuario agrega para verse SOLO él. Los del equipo (CalendariosEquipo) siguen
//    siendo comunes: todos pueden verlos y cada quien decide si los muestra.
//  - CalendariosPreferencias: qué calendarios/personas tiene OCULTOS cada usuario
//    (lista de claves: 'axis', 'c:<id>' equipo, 'p:<id>' personal, 'u:<id>' persona).
//
// Esquema: igual que el resto de módulos, primero se consulta information_schema y
// el DDL solo se intenta si falta algo; si el usuario de BD no tiene privilegios,
// el calendario sigue funcionando como siempre (vista común) y las funciones
// personales piden correr crear_tablas_calendario_personal.sql una vez.

const { esErrorDePrivilegios, tablaExiste, errorFaltaEsquema } = require('./esquemaSeguro');

const TABLAS = ['CalendariosUsuario', 'CalendariosPreferencias'];

const DDL = [
  `CREATE TABLE IF NOT EXISTS CalendariosUsuario (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    UsuarioId INT NOT NULL,
    Correo VARCHAR(255) NOT NULL,
    Etiqueta VARCHAR(100) NOT NULL,
    FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY ux_calusuario (UsuarioId, Correo),
    KEY idx_calusuario_usuario (UsuarioId)
  )`,
  `CREATE TABLE IF NOT EXISTS CalendariosPreferencias (
    UsuarioId INT NOT NULL PRIMARY KEY,
    Ocultos TEXT NULL,
    FechaActualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
];

let esquemaListo = false;
let esquemaError = null;
let esquemaFallaHasta = 0;

// Devuelve null si las tablas están listas, o un Error (mensaje accionable) si
// faltan y no se pueden crear. Otros errores sí se propagan.
async function garantizarEsquemaCalendario(pool) {
  if (esquemaListo) return null;
  if (Date.now() < esquemaFallaHasta && esquemaError) return esquemaError;

  const faltan = [];
  for (const t of TABLAS) if (!(await tablaExiste(pool, t))) faltan.push(t);
  if (!faltan.length) { esquemaListo = true; esquemaError = null; return null; }

  try {
    for (const sentencia of DDL) await pool.query(sentencia);
    esquemaListo = true;
    esquemaError = null;
    return null;
  } catch (err) {
    if (!esErrorDePrivilegios(err)) throw err;
    esquemaError = errorFaltaEsquema(`faltan las tablas ${faltan.join(', ')}`, err);
    esquemaError.message = esquemaError.message.replace(
      'migracion_esquema_sin_privilegios.sql',
      'crear_tablas_calendario_personal.sql'
    );
    esquemaFallaHasta = Date.now() + 30000;
    return esquemaError;
  }
}

const CLAVE_VALIDA = /^(axis|[ucp]:\d{1,10})$/;

function limpiarClaves(lista) {
  if (!Array.isArray(lista)) return null;
  const claves = [...new Set(lista.map((c) => String(c)))];
  if (claves.length > 300 || claves.some((c) => !CLAVE_VALIDA.test(c))) return null;
  return claves;
}

function leerClaves(texto) {
  if (!texto) return [];
  try {
    return limpiarClaves(JSON.parse(texto)) || [];
  } catch (_) {
    return [];
  }
}

// Preferencias + calendarios personales del usuario. Nunca lanza por falta de
// esquema: devuelve { disponible: false, mensaje } y la vista común sigue igual.
async function contextoDeUsuario(pool, usuarioId) {
  const vacio = { disponible: true, mensaje: null, ocultos: [], personales: [] };
  let err;
  try {
    err = await garantizarEsquemaCalendario(pool);
  } catch (e) {
    console.error('No se pudo verificar el esquema del calendario personal:', e);
    return { ...vacio, disponible: false, mensaje: 'No se pudo cargar la personalización del calendario.' };
  }
  if (err) return { ...vacio, disponible: false, mensaje: err.message };

  const [prefs] = await pool.query('SELECT Ocultos FROM CalendariosPreferencias WHERE UsuarioId = ?', [usuarioId]);
  const pref = prefs[0];
  const [personales] = await pool.query(
    'SELECT Id, Correo, Etiqueta FROM CalendariosUsuario WHERE UsuarioId = ? ORDER BY Etiqueta',
    [usuarioId]
  );
  return { ...vacio, ocultos: leerClaves(pref?.Ocultos), personales };
}

module.exports = { DDL, TABLAS, garantizarEsquemaCalendario, limpiarClaves, leerClaves, contextoDeUsuario };
