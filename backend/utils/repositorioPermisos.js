// Permisos por usuario del módulo Repositorio: qué SECCIONES ve cada usuario de
// AXIS (Resumen, Commits, Pull Requests, Pipelines...) y sobre qué REPOSITORIOS
// de Azure DevOps puede mirar el código.
//
// - ADMIN_POD ve todo siempre.
// - Mientras la tabla repositorio_permisos NO exista (script
//   crear_tabla_repositorio_permisos.sql sin ejecutar) todo funciona como antes:
//   cada usuario con el módulo ve todas las secciones y todos los repositorios.
//   Cuando la tabla existe, el control es estricto (lista blanca): solo se ve lo
//   que el ADMIN_POD asignó.
// - El usuario de BD de producción no tiene DELETE: quitar un acceso es un
//   UPDATE (Activo = 0). La tabla NO se crea sola en tiempo de ejecución a
//   propósito: activar el control es una decisión explícita, no un efecto de
//   desplegar.
// - Repositorios: la clave '*' significa "todos los repositorios (también los
//   que se creen después)". Sin '*', solo los repositorios marcados.

const { tablaExiste } = require('./esquemaSeguro');
const { usuariosAsignablesDelModulo } = require('./usuariosAxis');

const MODULO = 'REPOSITORIO';
const TIPO_SECCION = 'SECCION';
const TIPO_REPO = 'REPO';
const TODOS_LOS_REPOS = '*';
const REPO_VALIDO = /^[A-Za-z0-9_. -]{1,120}$/;

// Catálogo de secciones (el id es el que se guarda en la tabla y el que usa el
// frontend para mostrar u ocultar cada pestaña).
const SECCIONES = [
  { id: 'resumen', nombre: 'Resumen', descripcion: 'Panel general con estadísticas (muestra solo los bloques de las secciones que el usuario también tenga).', porRepo: true },
  { id: 'archivos', nombre: 'Archivos', descripcion: 'Explorar carpetas, ver contenido e historial de archivos.', porRepo: true },
  { id: 'commits', nombre: 'Commits', descripcion: 'Historial de commits y diferencias de cada cambio.', porRepo: true },
  { id: 'pull-requests', nombre: 'Pull Requests', descripcion: 'Pull requests, revisores, archivos y conversaciones.', porRepo: true },
  { id: 'ramas', nombre: 'Ramas y tags', descripcion: 'Ramas, tags, comparador y actividad de código.', porRepo: true },
  { id: 'pipelines', nombre: 'Pipelines', descripcion: 'Ejecuciones, logs, estadísticas y pruebas (del proyecto completo).', porRepo: false },
  { id: 'releases', nombre: 'Releases', descripcion: 'Releases y despliegues por ambiente (del proyecto completo).', porRepo: false },
  { id: 'boards', nombre: 'Boards', descripcion: 'Work items, sprints y consultas (del proyecto completo).', porRepo: false },
  { id: 'wiki', nombre: 'Wiki', descripcion: 'Páginas de la wiki del proyecto.', porRepo: false },
  { id: 'equipo', nombre: 'Equipo', descripcion: 'Equipos, políticas, agentes, ambientes, artefactos y diagnóstico de permisos. Conexiones y variables siguen siendo solo del ADMIN_POD.', porRepo: false },
  { id: 'buscar', nombre: 'Buscar', descripcion: 'Búsqueda de código y wiki (el código se limita a los repositorios permitidos).', porRepo: true },
];
const IDS_SECCION = new Set(SECCIONES.map((s) => s.id));

// ---------- ¿Existe la tabla? ----------

let tablaConfirmada = false;
let proximaRevision = 0;

async function modoEstricto(pool) {
  if (tablaConfirmada) return true;
  if (Date.now() < proximaRevision) return false;
  try {
    if (await tablaExiste(pool, 'repositorio_permisos')) { tablaConfirmada = true; return true; }
  } catch (err) {
    console.error('No se pudo verificar la tabla repositorio_permisos:', err.message);
  }
  proximaRevision = Date.now() + 30000; // reintenta a los 30 s por si ya corrieron el script
  return false;
}

// ---------- Acceso de un usuario ----------
// { total: true } = sin restricción. Si no:
// { total: false, secciones: Set<id>, todosRepos: bool, repos: Set<nombre en minúsculas>, nombresRepos: [nombres tal como se guardaron] }

const ACCESO_TOTAL = Object.freeze({ total: true });
const TTL_CACHE_MS = 15000;
const cache = new Map(); // usuarioId -> { hasta, acceso }

function invalidarAcceso(usuarioId) {
  if (usuarioId === undefined) cache.clear(); else cache.delete(Number(usuarioId));
}

async function accesoDe(pool, user) {
  if (!user || user.rol === 'ADMIN_POD') return ACCESO_TOTAL;
  if (!(await modoEstricto(pool))) return ACCESO_TOTAL;
  const enCache = cache.get(user.id);
  if (enCache && enCache.hasta > Date.now()) return enCache.acceso;

  const [filas] = await pool.query('SELECT Tipo, Clave FROM repositorio_permisos WHERE UsuarioId = ? AND Activo = 1', [user.id]);
  const secciones = new Set();
  const nombresRepos = [];
  let todosRepos = false;
  for (const f of filas) {
    if (f.Tipo === TIPO_SECCION && IDS_SECCION.has(f.Clave)) secciones.add(f.Clave);
    else if (f.Tipo === TIPO_REPO) {
      if (f.Clave === TODOS_LOS_REPOS) todosRepos = true; else nombresRepos.push(f.Clave);
    }
  }
  const acceso = { total: false, secciones, todosRepos, repos: new Set(nombresRepos.map((n) => n.toLowerCase())), nombresRepos };
  cache.set(user.id, { hasta: Date.now() + TTL_CACHE_MS, acceso });
  return acceso;
}

const puedeVerSeccion = (acceso, seccion) => acceso.total || acceso.secciones.has(seccion);
const puedeVerRepo = (acceso, repo) => acceso.total || acceso.todosRepos || acceso.repos.has(String(repo || '').toLowerCase());

// Versión serializable para el frontend.
function resumenParaCliente(acceso) {
  if (acceso.total) return { restringido: false, secciones: SECCIONES.map((s) => s.id), todosRepos: true, repos: [] };
  return { restringido: true, secciones: SECCIONES.map((s) => s.id).filter((id) => acceso.secciones.has(id)), todosRepos: acceso.todosRepos, repos: acceso.nombresRepos };
}

// ---------- Ruta -> sección ----------
// Devuelve: null (ruta libre: solo exige tener el módulo), un id de sección, un
// arreglo (basta con tener una de ellas) o undefined (ruta desconocida: se niega
// a los usuarios restringidos).
function seccionDeRuta(path) {
  if (path === '/repositorios' || path === '/refrescar' || path === '/mi-acceso' || path.startsWith('/accesos')) return null;
  if (path === '/resumen') return 'resumen';
  if (path === '/items' || path === '/historial' || path === '/contenido') return 'archivos';
  if (path === '/pull-requests' || path.startsWith('/prs')) return 'pull-requests';
  if (path === '/branches') return ['ramas', 'archivos'];
  if (path === '/ramas' || path === '/tags' || path.startsWith('/comparar') || path === '/pushes') return 'ramas';
  if (path.startsWith('/commits')) return 'commits';
  if (path === '/estadisticas/codigo') return ['resumen', 'commits', 'ramas'];
  if (path.startsWith('/pipelines')) return 'pipelines';
  if (path.startsWith('/releases')) return 'releases';
  if (path.startsWith('/boards')) return 'boards';
  if (path.startsWith('/wiki')) return 'wiki';
  if (path.startsWith('/equipo') || path === '/permisos') return 'equipo';
  if (path === '/buscar') return 'buscar';
  return undefined;
}

const SECCIONES_POR_REPO = new Set(SECCIONES.filter((s) => s.porRepo).map((s) => s.id));

// Middleware: valida sección y repositorio de cada petición y deja el acceso
// en req.accesoRepo (lo usan /resumen, /buscar y /repositorios para filtrar).
function controlAcceso(getPool, repoPorDefecto) {
  return async (req, res, next) => {
    try {
      const pool = await getPool();
      const acceso = await accesoDe(pool, req.user);
      req.accesoRepo = acceso;
      if (acceso.total) return next();

      const regla = seccionDeRuta(req.path);
      if (regla === null) return next();
      const secciones = regla === undefined ? [] : [].concat(regla);
      if (!secciones.some((s) => acceso.secciones.has(s))) {
        return res.status(403).json({ error: 'No tienes acceso a esta sección del Repositorio. Pídele al administrador que te la habilite.', codigo: 'SIN_ACCESO' });
      }
      const usaRepo = secciones.some((s) => SECCIONES_POR_REPO.has(s));
      if (usaRepo && !acceso.todosRepos) {
        const pedido = String(req.query.repo || '').trim();
        // La búsqueda sin ?repo= recorre todos los repos: el propio handler la limita a los permitidos.
        if (!(req.path === '/buscar' && !pedido)) {
          const efectivo = pedido || (typeof repoPorDefecto === 'function' ? repoPorDefecto() : repoPorDefecto);
          if (!puedeVerRepo(acceso, efectivo)) {
            return res.status(403).json({ error: 'No tienes acceso a este repositorio. Pídele al administrador que te lo habilite.', codigo: 'SIN_ACCESO_REPO' });
          }
        }
      }
      return next();
    } catch (err) {
      console.error('Error validando acceso al Repositorio:', err);
      return res.status(500).json({ error: 'No se pudo validar tu acceso al Repositorio.' });
    }
  };
}

// ---------- Administración (ADMIN_POD) ----------

const usuariosAsignables = (pool) => usuariosAsignablesDelModulo(pool, MODULO);

// { [usuarioId]: { secciones: [ids], repos: ['*' | nombres] } }
async function asignacionesVigentes(pool) {
  const [filas] = await pool.query('SELECT UsuarioId, Tipo, Clave FROM repositorio_permisos WHERE Activo = 1');
  const mapa = {};
  for (const f of filas) {
    const m = (mapa[f.UsuarioId] ||= { secciones: [], repos: [] });
    if (f.Tipo === TIPO_SECCION) m.secciones.push(f.Clave); else if (f.Tipo === TIPO_REPO) m.repos.push(f.Clave);
  }
  return mapa;
}

// Reemplaza el conjunto de un usuario (secciones y repos). Devuelve las diferencias.
async function guardarAsignacion(pool, req, usuarioId, secciones, repos) {
  const deseados = new Map(); // "TIPO|clave" -> { tipo, clave }
  for (const id of secciones) deseados.set(`${TIPO_SECCION}|${id}`, { tipo: TIPO_SECCION, clave: id });
  for (const r of repos) deseados.set(`${TIPO_REPO}|${r}`, { tipo: TIPO_REPO, clave: r });

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    const [actuales] = await conexion.query('SELECT Tipo, Clave, Activo FROM repositorio_permisos WHERE UsuarioId = ?', [usuarioId]);
    const vigentes = new Set(actuales.filter((f) => f.Activo).map((f) => `${f.Tipo}|${f.Clave}`));

    const agregados = [...deseados.keys()].filter((k) => !vigentes.has(k));
    const quitados = [...vigentes].filter((k) => !deseados.has(k));

    for (const k of agregados) {
      const { tipo, clave } = deseados.get(k);
      await conexion.query(
        `INSERT INTO repositorio_permisos (UsuarioId, Tipo, Clave, Activo, ConcedidoPorId, ConcedidoPorUsername)
         VALUES (?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE Activo = 1, ConcedidoPorId = VALUES(ConcedidoPorId), ConcedidoPorUsername = VALUES(ConcedidoPorUsername)`,
        [usuarioId, tipo, clave, req.user?.id ?? null, req.user?.username ?? null]
      );
    }
    for (const k of quitados) {
      const [tipo, ...resto] = k.split('|');
      await conexion.query('UPDATE repositorio_permisos SET Activo = 0 WHERE UsuarioId = ? AND Tipo = ? AND Clave = ?', [usuarioId, tipo, resto.join('|')]);
    }
    await conexion.commit();
    invalidarAcceso(usuarioId);
    return { agregados, quitados };
  } catch (err) {
    try { await conexion.rollback(); } catch { /* sin acción */ }
    throw err;
  } finally {
    conexion.release();
  }
}

module.exports = {
  MODULO, SECCIONES, IDS_SECCION, TODOS_LOS_REPOS, REPO_VALIDO,
  modoEstricto, accesoDe, puedeVerSeccion, puedeVerRepo, resumenParaCliente, invalidarAcceso,
  seccionDeRuta, controlAcceso, usuariosAsignables, asignacionesVigentes, guardarAsignacion,
};
