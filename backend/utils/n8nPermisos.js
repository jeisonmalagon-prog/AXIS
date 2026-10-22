// Permisos por usuario y por flujo del módulo Orquestador n8n.
//
// - ADMIN_POD ve y opera TODOS los flujos siempre.
// - Para el resto, mientras la tabla n8n_permisos NO exista (script
//   crear_tabla_n8n_permisos.sql sin ejecutar) todo funciona como antes: cada
//   usuario con el módulo ve todos los flujos. Cuando la tabla existe, el
//   control es estricto: solo se ve lo que el ADMIN_POD asignó (lista blanca),
//   y un flujo sin asignar queda oculto.
// - El usuario de BD de producción no tiene DELETE: quitar un acceso es un
//   UPDATE (Activo = 0). La tabla NO se crea sola en tiempo de ejecución a
//   propósito: activar el modo estricto es una decisión explícita (ejecutar el
//   script), no un efecto colateral de desplegar.

const { tablaExiste } = require('./esquemaSeguro');
const { usuariosAsignablesDelModulo } = require('./usuariosAxis');

const MODULO = 'ORQUESTADOR_N8N';
const ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;

let tablaConfirmada = false;
let proximaRevision = 0;

async function modoEstricto(pool) {
  if (tablaConfirmada) return true;
  if (Date.now() < proximaRevision) return false;
  try {
    if (await tablaExiste(pool, 'n8n_permisos')) { tablaConfirmada = true; return true; }
  } catch (err) {
    console.error('No se pudo verificar la tabla n8n_permisos:', err.message);
  }
  proximaRevision = Date.now() + 30000; // reintenta a los 30 s por si ya corrieron el script
  return false;
}

// null = sin restricción (ADMIN_POD o modo no estricto). Si no: Set de ids de flujo permitidos.
async function flujosPermitidos(pool, user) {
  if (!user || user.rol === 'ADMIN_POD') return null;
  if (!(await modoEstricto(pool))) return null;
  const [filas] = await pool.query('SELECT WorkflowId FROM n8n_permisos WHERE UsuarioId = ? AND Activo = 1', [user.id]);
  return new Set(filas.map((f) => f.WorkflowId));
}

const puedeVer = (permitidos, workflowId) => permitidos === null || permitidos.has(String(workflowId));

// Usuarios a los que se les asignan flujos: todos los activos que no son ADMIN_POD
// (con la marca tieneModulo para ver a quién aún le falta el módulo n8n).
const usuariosAsignables = (pool) => usuariosAsignablesDelModulo(pool, MODULO);

// { [usuarioId]: [workflowId...] } con los accesos vigentes.
async function asignacionesVigentes(pool) {
  const [filas] = await pool.query('SELECT UsuarioId, WorkflowId FROM n8n_permisos WHERE Activo = 1');
  const mapa = {};
  for (const f of filas) (mapa[f.UsuarioId] ||= []).push(f.WorkflowId);
  return mapa;
}

// Cuántos usuarios tienen acceso a cada flujo: { [workflowId]: n }
async function conteoPorFlujo(pool) {
  const [filas] = await pool.query('SELECT WorkflowId, COUNT(*) AS n FROM n8n_permisos WHERE Activo = 1 GROUP BY WorkflowId');
  return Object.fromEntries(filas.map((f) => [f.WorkflowId, Number(f.n)]));
}

// Reemplaza el conjunto de flujos de un usuario. Devuelve { agregados: [ids], quitados: [ids] }.
async function guardarAsignacion(pool, req, usuarioId, workflowIds, nombrePorId = {}) {
  const deseados = new Set(workflowIds.map(String));
  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    const [actuales] = await conexion.query('SELECT WorkflowId, Activo FROM n8n_permisos WHERE UsuarioId = ?', [usuarioId]);
    const vigentes = new Set(actuales.filter((f) => f.Activo).map((f) => f.WorkflowId));

    const agregados = [...deseados].filter((id) => !vigentes.has(id));
    const quitados = [...vigentes].filter((id) => !deseados.has(id));

    for (const id of agregados) {
      await conexion.query(
        `INSERT INTO n8n_permisos (UsuarioId, WorkflowId, WorkflowNombre, Activo, ConcedidoPorId, ConcedidoPorUsername)
         VALUES (?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE Activo = 1, WorkflowNombre = VALUES(WorkflowNombre),
           ConcedidoPorId = VALUES(ConcedidoPorId), ConcedidoPorUsername = VALUES(ConcedidoPorUsername)`,
        [usuarioId, id, (nombrePorId[id] || null), req.user?.id ?? null, req.user?.username ?? null]
      );
    }
    if (quitados.length) {
      await conexion.query('UPDATE n8n_permisos SET Activo = 0 WHERE UsuarioId = ? AND WorkflowId IN (?)', [usuarioId, quitados]);
    }
    await conexion.commit();
    return { agregados, quitados };
  } catch (err) {
    try { await conexion.rollback(); } catch { /* sin acción */ }
    throw err;
  } finally {
    conexion.release();
  }
}

module.exports = {
  MODULO, ID_VALIDO, modoEstricto, flujosPermitidos, puedeVer,
  usuariosAsignables, asignacionesVigentes, conteoPorFlujo, guardarAsignacion,
};
