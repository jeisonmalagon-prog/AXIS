// Utilidades para "garantizar" el esquema sin exigir privilegios de DDL.
//
// En producción el usuario de la aplicación (usr_certificados) puede NO tener
// CREATE/ALTER/INDEX sobre la base (p. ej. grants por tabla). Antes, cualquier
// CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS corría
// siempre y, aunque el objeto ya existiera, MariaDB rechazaba la sentencia por
// falta de privilegios y el login fallaba. Ahora cada módulo primero CONSULTA
// information_schema (solo requiere SELECT) y ejecuta DDL únicamente si algo
// falta realmente.

// 1142 tabla, 1143 columna, 1044 base, 1227 privilegio específico, 1045 acceso denegado.
const CODIGOS_PRIVILEGIOS = new Set([
  'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_ERROR',
]);

function esErrorDePrivilegios(err) {
  return !!err && (CODIGOS_PRIVILEGIOS.has(err.code) || [1142, 1143, 1044, 1227, 1045].includes(err.errno));
}

async function tablaExiste(pool, tabla) {
  const [filas] = await pool.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [tabla]
  );
  return filas.length > 0;
}

// Devuelve las columnas de la lista que NO existen todavía en la tabla.
async function columnasFaltantes(pool, tabla, columnas) {
  const [filas] = await pool.query(
    'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [tabla]
  );
  const existentes = new Set(filas.map((f) => String(f.c).toLowerCase()));
  return columnas.filter((c) => !existentes.has(c.toLowerCase()));
}

async function indiceExiste(pool, tabla, indice) {
  const [filas] = await pool.query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [tabla, indice]
  );
  return filas.length > 0;
}

// Error con mensaje accionable cuando falta esquema y el usuario no puede crearlo.
function errorFaltaEsquema(detalle, causa) {
  const err = new Error(
    `Falta esquema en la base de datos (${detalle}) y el usuario de la aplicación no tiene privilegios para crearlo. ` +
    'Ejecuta una sola vez el script migracion_esquema_sin_privilegios.sql con una cuenta con privilegios de CREATE/ALTER.'
  );
  err.causa = causa;
  return err;
}

module.exports = { esErrorDePrivilegios, tablaExiste, columnasFaltantes, indiceExiste, errorFaltaEsquema };
