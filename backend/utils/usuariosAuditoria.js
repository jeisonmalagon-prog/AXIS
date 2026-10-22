// Auditoría de cuentas de usuario — historial detallado de cada cambio
// (quién lo hizo, qué cambió, cuándo, desde dónde) más el mecanismo de
// "debe cambiar su contraseña" (primer ingreso de una cuenta nueva, o
// después de que un administrador le resetee la contraseña).
//
// Igual que con las tablas de histórico de otros módulos (F5, Portainer),
// tanto la tabla UsuariosHistorico como las columnas nuevas de `usuarios`
// se garantizan en tiempo de ejecución (CREATE TABLE IF NOT EXISTS / ALTER
// TABLE ADD COLUMN IF NOT EXISTS) para no depender de que alguien corra un
// script de migración a mano antes de desplegar este código — mismo
// criterio que garantizarTablaF5Historico()/garantizarTablaHistorico().
//
// IMPORTANTE sobre seguridad: esta tabla NUNCA guarda una contraseña (ni en
// texto plano ni el hash) — solo el booleano PasswordCambiada indica que un
// cambio de contraseña ocurrió en ese evento.

const {
  esErrorDePrivilegios, tablaExiste, columnasFaltantes, errorFaltaEsquema,
} = require('./esquemaSeguro');

let columnasUsuariosListas = false;
let tablaHistoricoLista = false;
// true cuando la tabla no existe y el usuario de BD no puede crearla: la
// auditoría detallada se omite (con aviso en el log) en vez de bloquear el login.
let historicoNoDisponible = false;

async function garantizarColumnasUsuarios(pool) {
  if (columnasUsuariosListas) return;
  // Solo se ejecuta DDL si falta alguna columna (el usuario de BD puede no
  // tener ALTER); ver utils/esquemaSeguro.js.
  const faltan = await columnasFaltantes(pool, 'usuarios', ['debe_cambiar_password', 'fecha_ultimo_cambio_password', 'tipo_autenticacion']);
  if (faltan.length === 0) {
    columnasUsuariosListas = true;
    return;
  }
  // DEFAULT 0: agregar esta columna NO obliga retroactivamente a las cuentas
  // que ya existían a cambiar su contraseña — la exigencia aplica a cuentas
  // nuevas (POST /usuarios) y a partir de que un admin resetee la
  // contraseña de alguien (PUT /usuarios/:id con password).
  try {
    await pool.query(`
      ALTER TABLE usuarios
        ADD COLUMN IF NOT EXISTS debe_cambiar_password TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS fecha_ultimo_cambio_password DATETIME NULL,
        ADD COLUMN IF NOT EXISTS tipo_autenticacion ENUM('LOCAL','AD') NOT NULL DEFAULT 'LOCAL'
    `);
  } catch (err) {
    if (esErrorDePrivilegios(err)) throw errorFaltaEsquema(`usuarios: faltan columnas ${faltan.join(', ')}`, err);
    throw err;
  }
  columnasUsuariosListas = true;
}

async function garantizarTablaUsuariosHistorico(pool) {
  if (tablaHistoricoLista || historicoNoDisponible) return;

  // Si la tabla y las columnas de tipo de autenticación ya existen no se toca
  // el esquema (evita exigir CREATE/ALTER al usuario de la aplicación).
  if (await tablaExiste(pool, 'UsuariosHistorico')) {
    const faltan = await columnasFaltantes(pool, 'UsuariosHistorico', ['TipoAutenticacionAnterior', 'TipoAutenticacionNuevo']);
    if (faltan.length === 0) {
      tablaHistoricoLista = true;
      return;
    }
  }

  try {
    await crearTablaUsuariosHistorico(pool);
  } catch (err) {
    if (esErrorDePrivilegios(err)) {
      historicoNoDisponible = true;
      console.error(
        '[usuarios] No se puede crear/actualizar UsuariosHistorico (sin privilegios de DDL). ' +
        'La auditoría detallada de usuarios queda DESACTIVADA hasta ejecutar migracion_esquema_sin_privilegios.sql ' +
        'con una cuenta con privilegios. El resto de la aplicación sigue funcionando.'
      );
      return;
    }
    throw err;
  }
  tablaHistoricoLista = true;
}

async function crearTablaUsuariosHistorico(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS UsuariosHistorico (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      UsuarioId INT NULL,
      UsernameIntentado VARCHAR(100) NULL,
      Accion VARCHAR(30) NOT NULL,
      NombreCompletoAnterior VARCHAR(150) NULL,
      NombreCompletoNuevo VARCHAR(150) NULL,
      RolAnterior VARCHAR(20) NULL,
      RolNuevo VARCHAR(20) NULL,
      TipoAutenticacionAnterior VARCHAR(10) NULL,
      TipoAutenticacionNuevo VARCHAR(10) NULL,
      ModulosAnterior VARCHAR(500) NULL,
      ModulosNuevo VARCHAR(500) NULL,
      ActivoAnterior TINYINT(1) NULL,
      ActivoNuevo TINYINT(1) NULL,
      PasswordCambiada TINYINT(1) NOT NULL DEFAULT 0,
      RealizadoPorId INT NULL,
      RealizadoPorUsername VARCHAR(100) NULL,
      IP VARCHAR(64) NULL,
      UserAgent VARCHAR(255) NULL,
      Detalle VARCHAR(500) NULL,
      FechaEvento DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_usuarioshistorico_usuario (UsuarioId, FechaEvento),
      INDEX idx_usuarioshistorico_accion (Accion, FechaEvento),
      CONSTRAINT fk_usuarioshistorico_usuario FOREIGN KEY (UsuarioId) REFERENCES usuarios(id) ON DELETE SET NULL
    )
  `);
  // CREATE TABLE IF NOT EXISTS no agrega columnas nuevas a una tabla que ya
  // existe (el caso de todo ambiente donde UsuariosHistorico se creó antes de
  // la integración con Active Directory), así que las columnas de tipo de
  // autenticación se garantizan aparte con ALTER ... ADD COLUMN IF NOT EXISTS.
  await pool.query(`
    ALTER TABLE UsuariosHistorico
      ADD COLUMN IF NOT EXISTS TipoAutenticacionAnterior VARCHAR(10) NULL,
      ADD COLUMN IF NOT EXISTS TipoAutenticacionNuevo VARCHAR(10) NULL
  `);
}

async function garantizarAuditoriaUsuarios(pool) {
  await garantizarColumnasUsuarios(pool);
  await garantizarTablaUsuariosHistorico(pool);
}

// Detrás de un proxy/balanceador el IP real puede venir en X-Forwarded-For;
// si no, se usa el IP de la conexión directa.
function obtenerIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) return String(forwardedFor).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

function obtenerUserAgent(req) {
  const ua = req.headers['user-agent'];
  return ua ? String(ua).slice(0, 255) : null;
}

// Inserta una fila de auditoría. `datos` acepta cualquiera de las columnas
// de arriba (en camelCase); los campos que no cambiaron se dejan en null a
// propósito (así el detalle solo muestra lo que sí cambió).
async function registrarEventoUsuario(pool, req, datos) {
  await garantizarTablaUsuariosHistorico(pool);
  if (historicoNoDisponible) return; // ver garantizarTablaUsuariosHistorico
  const {
    usuarioId = null,
    usernameIntentado = null,
    accion,
    nombreCompletoAnterior = null,
    nombreCompletoNuevo = null,
    rolAnterior = null,
    rolNuevo = null,
    tipoAutenticacionAnterior = null,
    tipoAutenticacionNuevo = null,
    modulosAnterior = null,
    modulosNuevo = null,
    activoAnterior = null,
    activoNuevo = null,
    passwordCambiada = false,
    detalle = null,
  } = datos;

  const realizadoPorId = req?.user?.id ?? null;
  const realizadoPorUsername = req?.user?.username ?? null;

  const aBooleanoONull = (v) => (v === null || v === undefined ? null : (v ? 1 : 0));
  const aCsvONull = (v) => (Array.isArray(v) ? v.join(',') : v);

  await pool.query(
    `INSERT INTO UsuariosHistorico
      (UsuarioId, UsernameIntentado, Accion, NombreCompletoAnterior, NombreCompletoNuevo,
       RolAnterior, RolNuevo, TipoAutenticacionAnterior, TipoAutenticacionNuevo,
       ModulosAnterior, ModulosNuevo, ActivoAnterior, ActivoNuevo,
       PasswordCambiada, RealizadoPorId, RealizadoPorUsername, IP, UserAgent, Detalle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      usuarioId,
      usernameIntentado,
      accion,
      nombreCompletoAnterior,
      nombreCompletoNuevo,
      rolAnterior,
      rolNuevo,
      tipoAutenticacionAnterior,
      tipoAutenticacionNuevo,
      aCsvONull(modulosAnterior),
      aCsvONull(modulosNuevo),
      aBooleanoONull(activoAnterior),
      aBooleanoONull(activoNuevo),
      passwordCambiada ? 1 : 0,
      realizadoPorId,
      realizadoPorUsername,
      obtenerIp(req),
      obtenerUserAgent(req),
      detalle,
    ]
  );
}

module.exports = {
  garantizarAuditoriaUsuarios,
  garantizarColumnasUsuarios,
  garantizarTablaUsuariosHistorico,
  registrarEventoUsuario,
  obtenerIp,
  obtenerUserAgent,
};
