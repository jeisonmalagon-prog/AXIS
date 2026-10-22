// Rol POR MÓDULO: además de decidir QUÉ módulos ve cada usuario, el ADMIN_POD
// elige para cada uno si el usuario solo CONSULTA o si es ADMIN_MIN (puede
// crear, editar y borrar en ese módulo). El rol se guarda en
// usuario_modulos.rol_modulo (una fila por usuario y módulo).
//
// Compatibilidad: si esa columna todavía no existe (el usuario de BD de
// producción no puede hacer DDL), todo sigue funcionando como antes -- el rol
// de cada módulo se deduce del rol global del usuario (BASIC = Consulta,
// ADMIN_MIN = Admin) y la pantalla de usuarios avisa que falta el script
// agregar_rol_por_modulo.sql. Una fila con rol_modulo NULL también hereda del
// rol global.

const { columnasFaltantes, esErrorDePrivilegios } = require('./esquemaSeguro');
const { MODULOS_VALIDOS } = require('./modulos');

const ROL_CONSULTA = 'CONSULTA';
const ROL_ADMIN_MIN = 'ADMIN_MIN';
const ROLES_MODULO = [ROL_CONSULTA, ROL_ADMIN_MIN];

function normalizarRolModulo(valor) {
  const s = String(valor || '').trim().toUpperCase();
  return ROLES_MODULO.includes(s) ? s : null;
}

// Módulos donde TODO usuario siempre pudo crear/gestionar lo suyo, aunque su
// rol global fuera BASIC (Tareas: cada quien crea sus pendientes). Mientras el
// ADMIN_POD no le asigne un rol explícito a ese módulo, se conserva ese
// comportamiento, para que activar los roles por módulo no le quite a nadie lo
// que ya hacía.
const MODULOS_ABIERTOS_POR_DEFECTO = ['TAREAS'];

// Rol que tendría un módulo "sin rol propio" según el rol global del usuario.
function rolDesdeRolGlobal(rolGlobal, modulo) {
  if (modulo && MODULOS_ABIERTOS_POR_DEFECTO.includes(modulo)) return ROL_ADMIN_MIN;
  return rolGlobal === 'BASIC' ? ROL_CONSULTA : ROL_ADMIN_MIN;
}

// ----- ¿Existe la columna usuario_modulos.rol_modulo? -----
let columnaConfirmada = false;
let columnaProximaRevision = 0;

async function columnaRolModuloDisponible(pool) {
  if (columnaConfirmada) return true;
  if (Date.now() < columnaProximaRevision) return false;
  try {
    const faltan = await columnasFaltantes(pool, 'usuario_modulos', ['rol_modulo']);
    if (faltan.length === 0) {
      columnaConfirmada = true;
      return true;
    }
  } catch (error) {
    console.error('No se pudo verificar usuario_modulos.rol_modulo:', error.message);
  }
  columnaProximaRevision = Date.now() + 30000;
  return false;
}

// Igual que la anterior pero, si falta, intenta crearla (solo la usa la pantalla
// de administración de usuarios, no el login). Sin privilegios de DDL devuelve
// false y reintenta como mucho cada 60 s.
let creacionProximoIntento = 0;
async function asegurarColumnaRolModulo(pool) {
  if (await columnaRolModuloDisponible(pool)) return true;
  if (Date.now() < creacionProximoIntento) return false;
  try {
    await pool.query('ALTER TABLE usuario_modulos ADD COLUMN IF NOT EXISTS rol_modulo VARCHAR(20) NULL');
    columnaConfirmada = true;
    return true;
  } catch (error) {
    if (!esErrorDePrivilegios(error)) console.error('No se pudo crear usuario_modulos.rol_modulo:', error);
    creacionProximoIntento = Date.now() + 60000;
    columnaProximaRevision = Date.now() + 30000;
    return false;
  }
}

// ----- Permisos de un usuario -----
// { modulos: [nombres], roles: { MODULO: 'CONSULTA' | 'ADMIN_MIN' } }
async function cargarPermisos(pool, user) {
  if (user.rol === 'ADMIN_POD') {
    const roles = {};
    MODULOS_VALIDOS.forEach((m) => { roles[m] = ROL_ADMIN_MIN; });
    return { modulos: [...MODULOS_VALIDOS], roles };
  }
  const conColumna = await columnaRolModuloDisponible(pool);
  const [filas] = await pool.query(
    `SELECT m.nombre, ${conColumna ? 'um.rol_modulo' : 'NULL'} AS rol_modulo
     FROM usuario_modulos um
     INNER JOIN modulos m ON um.modulo_id = m.id
     WHERE um.usuario_id = ?`,
    [user.id]
  );
  const roles = {};
  filas.forEach((f) => { roles[f.nombre] = normalizarRolModulo(f.rol_modulo) || rolDesdeRolGlobal(user.rol, f.nombre); });
  return { modulos: filas.map((f) => f.nombre), roles };
}

// ----- Consulta "en vivo" con caché corta -----
// El token (JWT) dura hasta 2 h; sin esto, quitarle a alguien el permiso de
// edición solo tendría efecto cuando vuelva a iniciar sesión. Se consulta la BD
// (como mucho cada TTL_MS por usuario) y se invalida al guardar un usuario.
const TTL_MS = 20000;
const cache = new Map();

function invalidarPermisos(usuarioId) {
  if (usuarioId === undefined || usuarioId === null) cache.clear();
  else cache.delete(Number(usuarioId));
}

async function permisosVigentes(pool, usuarioId) {
  const id = Number(usuarioId);
  const guardado = cache.get(id);
  if (guardado && guardado.hasta > Date.now()) return guardado.valor;
  const [[usuario]] = await pool.query('SELECT id, rol FROM usuarios WHERE id = ?', [id]);
  const valor = usuario
    ? { rol: usuario.rol, ...(await cargarPermisos(pool, usuario)) }
    : { rol: null, modulos: [], roles: {} };
  cache.set(id, { hasta: Date.now() + TTL_MS, valor });
  return valor;
}

// Rol efectivo del usuario de la petición en un módulo:
//   'ADMIN_MIN' | 'CONSULTA' | null (el módulo no está habilitado para él).
async function rolEnModulo(req, modulo) {
  const user = req.user || {};
  if (user.rol === 'ADMIN_POD') return ROL_ADMIN_MIN;
  try {
    const { getPool } = require('../db');
    const vigentes = await permisosVigentes(await getPool(), user.id);
    if (vigentes.rol === 'ADMIN_POD') return ROL_ADMIN_MIN;
    return vigentes.roles[modulo] || null;
  } catch (error) {
    // Si la BD no responde se usa lo que trae el token, que es lo que
    // requireModule ya usa para el acceso al módulo.
    console.error('rolEnModulo: se usa el rol del token por error de BD:', error.message);
    if (!(user.modulos || []).includes(modulo)) return null;
    return normalizarRolModulo(user.modulosRoles && user.modulosRoles[modulo]) || rolDesdeRolGlobal(user.rol, modulo);
  }
}

module.exports = {
  ROL_CONSULTA,
  ROL_ADMIN_MIN,
  ROLES_MODULO,
  normalizarRolModulo,
  rolDesdeRolGlobal,
  columnaRolModuloDisponible,
  asegurarColumnaRolModulo,
  cargarPermisos,
  invalidarPermisos,
  permisosVigentes,
  rolEnModulo,
};
