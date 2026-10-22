// Prueba qué secciones de Azure DevOps puede leer un token (o el conjunto de tokens guardados).
// Lo usan «Probar token» (Conexión) y GET /permisos del Repositorio.

const C = require('./azureCliente');

const DIA_MS = 24 * 60 * 60 * 1000;

// token = { id, valor } fuerza ese token (sin pasar al siguiente); sin token se usa la selección
// normal (el primero que tenga permiso para cada área).
async function probarAreas({ token = null } = {}) {
  const hoy = new Date();
  const ayer = new Date(Date.now() - DIA_MS);
  const extra = token ? { token } : {};
  const o = (area, mas = {}) => ({ area, cacheMs: 0, ...mas, ...extra });
  const { obtener, llamar, urlRepo, urlProyecto, urlBusqueda } = C;
  const probas = [
    ['codigo', 'Código y repositorios', () => obtener(urlRepo(C.REPO), {}, o('codigo'))],
    ['builds', 'Pipelines (builds)', () => obtener(urlProyecto('/build/definitions'), { $top: 1 }, o('builds'))],
    ['releases', 'Releases y despliegues', () => obtener(C.urlVsrm('/release/definitions'), { $top: 1 }, o('releases'))],
    ['workitems', 'Boards (work items)', () => obtener(urlProyecto('/wit/classificationnodes/areas'), { $depth: 1 }, o('workitems'))],
    ['proyecto', 'Proyecto y equipos', () => obtener(C.urlOrg(`/projects/${C.enc(C.PROJECT)}`), {}, o('proyecto'))],
    ['pruebas', 'Pruebas', () => obtener(urlProyecto('/test/runs'), { minLastUpdatedDate: ayer.toISOString(), maxLastUpdatedDate: hoy.toISOString(), $top: 1 }, o('pruebas'))],
    ['paquetes', 'Artefactos (feeds)', () => obtener(C.urlFeeds('/packaging/feeds', false), {}, o('paquetes'))],
    ['agentes', 'Agentes y pools', () => obtener(C.urlOrg('/distributedtask/pools'), {}, o('agentes'))],
    ['ambientes', 'Ambientes', () => obtener(urlProyecto('/distributedtask/environments'), { $top: 1 }, o('ambientes'))],
    ['conexiones', 'Conexiones de servicio', () => obtener(urlProyecto('/serviceendpoint/endpoints'), {}, o('conexiones', { apiVersion: '7.1-preview.4' }))],
    ['variables', 'Grupos de variables', () => obtener(urlProyecto('/distributedtask/variablegroups'), { $top: 1 }, o('variables', { apiVersion: '7.1-preview.2' }))],
    ['busqueda', 'Búsqueda de código', () => llamar(`${urlBusqueda('/search/codesearchresults')}?api-version=${C.API}`, { method: 'POST', body: { searchText: 'a', $top: 1, filters: { Project: [C.PROJECT] } }, ...o('busqueda', { cacheMs: 0 }) })],
    ['wiki', 'Wiki', () => obtener(urlProyecto('/wiki/wikis'), {}, o('wiki'))],
  ];
  return C.mapLimit(probas, 4, async ([area, nombre, fn]) => {
    const r = await C.seccion(async () => { await fn(); return true; });
    return { area, nombre, permiso: C.PERMISOS_POR_AREA[area], ok: !!r.datos, codigo: r.codigo || null, mensaje: r.error || null };
  });
}

module.exports = { probarAreas };
