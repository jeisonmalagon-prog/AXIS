// Visibilidad y permisos de la bitácora de Pasos a Producción.
//
// Modelo (ver crear_tablas_bitacora_equipos_y_accesos.sql):
//  - Un paso es UNO solo. Lo creó alguien (CreadoPorId); pueden participar varias personas
//    (PasosProduccionEquipo) y alguien lo ejecuta (EjecutadoPorId). Todas esas personas
//    «están involucradas» y el paso aparece en la bitácora de cada una, sin copias.
//  - Un paso lo ve: quien está involucrado, quien tiene un acceso ACEPTADO a la bitácora
//    completa de alguien involucrado, quien tiene un acceso ACEPTADO a ese paso, y ADMIN_POD.
//  - Edita: el creador, los participantes y quien tenga permiso de EDICION. ADMIN_POD ve todo
//    pero no edita pasos ajenos. Elimina solo el creador.
//  - Mientras las tablas nuevas no existan se mantiene el comportamiento anterior (todos ven
//    y editan todo según su rol del módulo); la privacidad se activa al ejecutar el script SQL.

const TABLAS_ACCESOS = ['BitacoraAccesos', 'BitacoraEquipos', 'BitacoraEquipoMiembros'];
const MENSAJE_SIN_TABLAS =
  'Para activar la privacidad de la bitácora, los equipos y los accesos falta crear sus tablas en la base de datos. ' +
  'Ejecuta una sola vez crear_tablas_bitacora_equipos_y_accesos.sql (carpeta «Claude outputs») con una cuenta con privilegios de CREATE. ' +
  'Mientras tanto la bitácora funciona como antes: todos ven todo.';

const estados = new Map(); // clave -> { lista, revisadoEn }

async function tablasListas(pool, clave, tablas) {
  const e = estados.get(clave);
  if (e && e.lista) return true;
  if (e && Date.now() - e.revisadoEn < 30 * 1000) return false;
  try {
    for (const t of tablas) await pool.query(`SELECT 1 FROM ${t} LIMIT 1`);
    estados.set(clave, { lista: true, revisadoEn: Date.now() });
    return true;
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      estados.set(clave, { lista: false, revisadoEn: Date.now() });
      return false;
    }
    throw error;
  }
}

// Sonda genérica: ¿responde esta consulta? (tabla o columna que se crea con un script SQL manual).
async function sondaLista(pool, clave, sql) {
  const e = estados.get(clave);
  if (e && e.lista) return true;
  if (e && Date.now() - e.revisadoEn < 30 * 1000) return false;
  try {
    await pool.query(sql);
    estados.set(clave, { lista: true, revisadoEn: Date.now() });
    return true;
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') {
      estados.set(clave, { lista: false, revisadoEn: Date.now() });
      return false;
    }
    throw error;
  }
}

const accesosListos = (pool) => tablasListas(pool, 'accesos', TABLAS_ACCESOS);
// Eliminación lógica (columnas Eliminado, EliminadoEn, EliminadoPorId, MotivoEliminacion) y «ocultos» por persona.
// Se crean con agregar_eliminacion_y_ocultos_pasos_produccion.sql; mientras no existan todo sigue como antes.
const MENSAJE_SIN_ELIMINACION =
  'Para usar «Eliminados» y «Ocultos» falta ejecutar una sola vez agregar_eliminacion_y_ocultos_pasos_produccion.sql (carpeta «Claude outputs») con una cuenta con privilegios de ALTER/CREATE.';
const eliminacionLista = (pool) => sondaLista(pool, 'eliminacion', 'SELECT Eliminado, EliminadoEn, EliminadoPorId, MotivoEliminacion FROM PasosProduccion LIMIT 1');
const ocultosListos = (pool) => tablasListas(pool, 'ocultos', ['PasosProduccionOcultos']);

/** Condición SQL «el paso no está eliminado» (1=1 mientras no exista la columna). */
async function sqlActivo(pool, alias) {
  return (await eliminacionLista(pool)) ? `${alias}.Eliminado = 0` : '1=1';
}
const serviciosListos = (pool) => tablasListas(pool, 'servicios', ['PasosProduccionServicios']);
/** Solo para pruebas: olvida lo ya detectado. */
const reiniciarDeteccion = () => estados.clear();

const esAdmin = (user) => user && user.rol === 'ADMIN_POD';
const idsValidos = (lista) => [...new Set((Array.isArray(lista) ? lista : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/** «Está involucrado alguien de `ids`»: creó, ejecutó o participa en el paso `alias`. (COALESCE: con NULL el NOT (...) quedaría desconocido.) */
function sqlInvolucra(alias, ids) {
  return {
    sql: `(${alias}.CreadoPorId IN (?) OR COALESCE(${alias}.EjecutadoPorId, 0) IN (?) OR EXISTS (SELECT 1 FROM PasosProduccionEquipo ie WHERE ie.PasoId = ${alias}.Id AND ie.UsuarioId IN (?)))`,
    params: [ids, ids, ids],
  };
}

/**
 * Condición SQL: pasos (alias `alias`) que `user` puede ver. Los pasos eliminados (lógicamente) quedan fuera
 * salvo que se pida `incluirEliminados` (la sección «Eliminados» y las acciones sobre un paso concreto).
 */
async function condicionVisible(pool, alias, user, { incluirEliminados = false } = {}) {
  const base = await condicionAcceso(pool, alias, user);
  if (incluirEliminados || !(await eliminacionLista(pool))) return base;
  return { sql: `(${base.sql} AND ${alias}.Eliminado = 0)`, params: base.params };
}

async function condicionAcceso(pool, alias, user) {
  if (!(await accesosListos(pool)) || esAdmin(user)) return { sql: '1=1', params: [] };
  const inv = sqlInvolucra(alias, [Number(user.id)]);
  return {
    sql: `(${inv.sql} OR EXISTS (SELECT 1 FROM BitacoraAccesos ba WHERE ba.UsuarioId = ? AND ba.Estado = 'ACEPTADA' AND (ba.PasoId = ${alias}.Id OR (ba.PasoId IS NULL AND (ba.PropietarioId = ${alias}.CreadoPorId OR ba.PropietarioId = ${alias}.EjecutadoPorId OR EXISTS (SELECT 1 FROM PasosProduccionEquipo ie2 WHERE ie2.PasoId = ${alias}.Id AND ie2.UsuarioId = ba.PropietarioId))))))`,
    params: [...inv.params, Number(user.id)],
  };
}

/** Condición SQL: pasos de mi bitácora (en los que estoy involucrado). */
const condicionMia = (alias, user) => sqlInvolucra(alias, [Number(user.id)]);

async function accesosAceptadosDe(pool, usuarioId) {
  const [filas] = await pool.query(
    "SELECT PropietarioId, PasoId, Permiso FROM BitacoraAccesos WHERE UsuarioId = ? AND Estado = 'ACEPTADA'",
    [usuarioId]
  );
  return filas.map((f) => ({ PropietarioId: Number(f.PropietarioId), PasoId: f.PasoId === null ? null : Number(f.PasoId), Permiso: f.Permiso }));
}

/**
 * Nivel de `user` sobre un paso: PROPIETARIO (lo creó) > EDICION (participa o se lo compartieron
 * para editar) > LECTURA > ADMIN (ADMIN_POD: ve, no edita) > null (sin acceso).
 * `involucrados`: ids de quienes crearon, ejecutaron o participan en el paso.
 */
function calcularNivel({ user, paso, involucrados, accesos, legacy }) {
  if (legacy) return 'PROPIETARIO';
  const yo = Number(user.id);
  if (Number(paso.CreadoPorId) === yo) return 'PROPIETARIO';
  const set = new Set(involucrados.map(Number));
  if (set.has(yo)) return 'EDICION';
  let mejor = null;
  for (const a of accesos) {
    if (a.PasoId === Number(paso.Id) || (a.PasoId === null && set.has(a.PropietarioId))) {
      if (a.Permiso === 'EDICION') return 'EDICION';
      mejor = 'LECTURA';
    }
  }
  if (mejor) return mejor;
  return esAdmin(user) ? 'ADMIN' : null;
}

const involucradosDe = (paso, equipo) => [paso.CreadoPorId, paso.EjecutadoPorId, ...(equipo || []).map((e) => e.id ?? e)].filter((x) => x !== null && x !== undefined);

/** Nivel y bandera «participo» de cada paso de la lista (una sola consulta de accesos). */
async function nivelesDePasos(pool, user, pasos, equipoPorPaso) {
  const legacy = !(await accesosListos(pool));
  const accesos = legacy ? [] : await accesosAceptadosDe(pool, user.id);
  const mapa = new Map();
  for (const p of pasos) {
    const involucrados = involucradosDe(p, equipoPorPaso.get(p.Id));
    const nivel = calcularNivel({ user, paso: p, involucrados, accesos, legacy });
    const participo = legacy || involucrados.map(Number).includes(Number(user.id));
    mapa.set(p.Id, { nivel, participo });
  }
  return mapa;
}

/** { existe, nivel, participo } de un paso concreto. */
async function nivelDePaso(pool, user, pasoId) {
  const [[paso]] = await pool.query('SELECT Id, CreadoPorId, EjecutadoPorId FROM PasosProduccion WHERE Id = ?', [pasoId]);
  if (!paso) return { existe: false, nivel: null, participo: false };
  const [equipo] = await pool.query('SELECT UsuarioId AS id FROM PasosProduccionEquipo WHERE PasoId = ?', [pasoId]);
  const legacy = !(await accesosListos(pool));
  const accesos = legacy ? [] : await accesosAceptadosDe(pool, user.id);
  const involucrados = involucradosDe(paso, equipo);
  return {
    existe: true,
    nivel: calcularNivel({ user, paso, involucrados, accesos, legacy }),
    participo: legacy || involucrados.map(Number).includes(Number(user.id)),
    paso,
    involucrados: involucrados.map(Number),
  };
}

const puedeEditarNivel = (n) => n === 'PROPIETARIO' || n === 'EDICION';

module.exports = {
  MENSAJE_SIN_TABLAS, MENSAJE_SIN_ELIMINACION, accesosListos, serviciosListos, eliminacionLista, ocultosListos, sqlActivo, reiniciarDeteccion,
  esAdmin, idsValidos, sqlInvolucra, condicionVisible, condicionMia,
  calcularNivel, nivelesDePasos, nivelDePaso, puedeEditarNivel,
};
