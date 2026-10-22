// Funciones de descarga de datos de Azure DevOps (solo lectura) reutilizadas por
// varias rutas: commits, PRs, builds, releases, work items y contenido de archivos.

const C = require('./azureCliente');
const M = require('./azureMapas');
const { diffLineas } = require('./diffLineas');

const { obtener, llamar, urlRepo, urlProyecto, urlVsrm, mapLimit, AzureError } = C;

const MAX_BYTES_DIFF = 1500000;

// ---------------------------- Commits ---------------------------------------------

async function traerCommits(repo, rama, { desde, hasta, autor, ruta, maximo = 1000, tipoVersion = 'branch', saltar = 0 } = {}) {
  const lista = [];
  const pagina = 500;
  while (lista.length < maximo) {
    const tope = Math.min(pagina, maximo - lista.length);
    // eslint-disable-next-line no-await-in-loop
    const d = await obtener(urlRepo(repo, '/commits'), {
      'searchCriteria.itemVersion.versionType': tipoVersion,
      'searchCriteria.itemVersion.version': rama,
      'searchCriteria.fromDate': desde,
      'searchCriteria.toDate': hasta,
      'searchCriteria.author': autor,
      'searchCriteria.itemPath': ruta,
      'searchCriteria.$top': tope,
      'searchCriteria.$skip': saltar + lista.length,
    }, { area: 'codigo' });
    const v = d.value || [];
    lista.push(...v);
    if (v.length < tope) break;
  }
  return lista.map((c) => M.mapearCommit(c, C.web, repo));
}

// ---------------------------- Pull requests ---------------------------------------

async function traerPRs(repo, { estado = 'all', destino, desde, maximo = 300, saltar = 0 } = {}) {
  const lista = [];
  const pagina = 100;
  while (lista.length < maximo) {
    const tope = Math.min(pagina, maximo - lista.length);
    // eslint-disable-next-line no-await-in-loop
    const d = await obtener(urlRepo(repo, '/pullrequests'), {
      'searchCriteria.status': estado,
      'searchCriteria.targetRefName': destino ? `refs/heads/${destino}` : undefined,
      'searchCriteria.minTime': desde,
      'searchCriteria.queryTimeRangeType': desde ? 'created' : undefined,
      $top: tope,
      $skip: saltar + lista.length,
    }, { area: 'codigo' });
    const v = d.value || [];
    lista.push(...v);
    if (v.length < tope) break;
  }
  return lista.map((p) => M.mapearPR(p, C.web, repo));
}

// ---------------------------- Builds -----------------------------------------------

const RESULTADOS_BUILD = ['succeeded', 'partiallySucceeded', 'failed', 'canceled'];
const ESTADOS_BUILD = ['notStarted', 'inProgress', 'completed', 'cancelling', 'postponed'];
const MOTIVOS_BUILD = ['manual', 'individualCI', 'batchedCI', 'schedule', 'pullRequest', 'buildCompletion', 'resourceTrigger', 'triggered'];

async function traerBuilds({ dias = 30, definiciones, resultado, estado, rama, motivo, maximo = 1000, continuacion } = {}) {
  const lista = [];
  let token = continuacion || null;
  const minTime = new Date(Date.now() - dias * M.DIA_MS).toISOString();
  while (lista.length < maximo) {
    const tope = Math.min(200, maximo - lista.length);
    // eslint-disable-next-line no-await-in-loop
    const r = await obtener(urlProyecto('/build/builds'), {
      definitions: definiciones,
      resultFilter: resultado,
      statusFilter: estado,
      branchName: rama ? `refs/heads/${rama}` : undefined,
      reasonFilter: motivo,
      minTime,
      queryOrder: 'queueTimeDescending',
      $top: tope,
      continuationToken: token || undefined,
    }, { area: 'builds', conCabeceras: true });
    const v = r.datos.value || [];
    lista.push(...v);
    token = r.continuacion;
    if (!token || v.length < tope) { token = null; break; }
  }
  return { builds: lista.map((b) => M.mapearBuild(b, C.web)), continuacion: token };
}

// ---------------------------- Releases / despliegues -----------------------------------

async function traerReleases({ dias = 60, definicionId, maximo = 200 } = {}) {
  const lista = [];
  let token = null;
  const minCreatedTime = new Date(Date.now() - dias * M.DIA_MS).toISOString();
  while (lista.length < maximo) {
    const tope = Math.min(100, maximo - lista.length);
    // eslint-disable-next-line no-await-in-loop
    const r = await obtener(urlVsrm('/release/releases'), {
      definitionId: definicionId,
      $expand: 'environments',
      minCreatedTime,
      queryOrder: 'descending',
      $top: tope,
      continuationToken: token || undefined,
    }, { area: 'releases', conCabeceras: true });
    const v = r.datos.value || [];
    lista.push(...v);
    token = r.continuacion;
    if (!token || v.length < tope) break;
  }
  return lista.map((r) => M.mapearRelease(r, C.web));
}

const ESTADOS_DESPLIEGUE = { succeeded: 'Exitoso', failed: 'Fallido', partiallySucceeded: 'Parcial', inProgress: 'En curso', notDeployed: 'Sin desplegar', undefined: '—' };

function mapearDespliegue(d) {
  const inicio = d.startedOn || null;
  const fin = d.completedOn || null;
  return {
    id: d.id,
    releaseId: d.release?.id ?? null,
    release: d.release?.name || null,
    definicionId: d.releaseDefinition?.id ?? null,
    definicion: d.releaseDefinition?.name || null,
    ambiente: d.releaseEnvironment?.name || null,
    estado: d.deploymentStatus || 'undefined',
    estadoTexto: ESTADOS_DESPLIEGUE[d.deploymentStatus] || d.deploymentStatus || '—',
    operacion: d.operationStatus || null,
    motivo: d.reason || null,
    solicitadoPor: M.nombreDe(d.requestedFor) || M.nombreDe(d.requestedBy),
    inicio, fin,
    duracionMs: M.duracionMs(inicio, fin),
    url: d.release?.id ? C.web.release(d.release.id) : null,
  };
}

async function traerDespliegues({ dias = 60, definicionId, estado, maximo = 300 } = {}) {
  const lista = [];
  let token = null;
  const minStartedTime = new Date(Date.now() - dias * M.DIA_MS).toISOString();
  while (lista.length < maximo) {
    const tope = Math.min(100, maximo - lista.length);
    // eslint-disable-next-line no-await-in-loop
    const r = await obtener(urlVsrm('/release/deployments'), {
      definitionId: definicionId,
      deploymentStatus: estado,
      minStartedTime,
      queryOrder: 'descending',
      $top: tope,
      continuationToken: token || undefined,
    }, { area: 'releases', conCabeceras: true });
    const v = r.datos.value || [];
    lista.push(...v);
    token = r.continuacion;
    if (!token || v.length < tope) break;
  }
  return lista.map(mapearDespliegue);
}

// ---------------------------- Work items --------------------------------------------

const escapar = (s) => String(s).replace(/'/g, "''");

async function consultarWiql(query, top = 1000) {
  const r = await llamar(`${urlProyecto('/wit/wiql')}?$top=${top}&api-version=${C.API}`, {
    method: 'POST', body: { query: query }, area: 'workitems', cacheMs: 60000,
  });
  return (r.workItems || []).map((w) => w.id);
}

async function traerWorkItems(ids, campos = M.CAMPOS_WORK_ITEM) {
  const unicos = [...new Set(ids)].filter((i) => Number.isInteger(i));
  const lotes = [];
  for (let i = 0; i < unicos.length; i += 200) lotes.push(unicos.slice(i, i + 200));
  const partes = await mapLimit(lotes, 3, async (lote) => {
    const r = await llamar(`${urlProyecto('/wit/workitemsbatch')}?api-version=${C.API}`, {
      method: 'POST', body: { ids: lote, fields: campos, errorPolicy: 'Omit' }, area: 'workitems', cacheMs: 60000,
    });
    return r.value || [];
  });
  return partes.flat().map((w) => M.mapearWorkItem(w, C.web));
}

// ---------------------------- Contenido de archivos y diferencias -----------------------

async function contenidoEn(repo, ruta, version, tipoVersion = 'commit') {
  const url = urlRepo(repo, '/items');
  const q = new URLSearchParams({
    'api-version': C.API,
    path: ruta,
    'versionDescriptor.versionType': tipoVersion,
    'versionDescriptor.version': version,
    download: 'true',
  });
  try {
    const buf = await llamar(`${url}?${q.toString()}`, { accept: 'buffer', area: 'codigo', cacheMs: 300000, maxBytes: MAX_BYTES_DIFF });
    return buf;
  } catch (err) {
    if (err.codigo === 'NO_ENCONTRADO') return null;
    throw err;
  }
}

const esBinario = (buf) => buf.subarray(0, 8000).includes(0);

// Compara un archivo entre dos versiones (commits). Si no existe en una de ellas se
// considera vacío (archivo agregado o eliminado).
async function diffArchivo(repo, { shaBase, shaDestino, rutaBase, rutaDestino }) {
  const [a, b] = await Promise.all([
    shaBase ? contenidoEn(repo, rutaBase, shaBase) : Promise.resolve(null),
    shaDestino ? contenidoEn(repo, rutaDestino, shaDestino) : Promise.resolve(null),
  ]).catch((err) => {
    if (err.codigo === 'GRANDE') return ['grande', null];
    throw err;
  });
  if (a === 'grande') return { ruta: rutaDestino, grande: true, binario: false, lineas: [], resumen: { agregadas: 0, quitadas: 0 }, sinCambios: false, truncado: false };
  if ((a && esBinario(a)) || (b && esBinario(b))) {
    return { ruta: rutaDestino, binario: true, grande: false, lineas: [], resumen: { agregadas: 0, quitadas: 0 }, sinCambios: false, truncado: false };
  }
  const d = diffLineas(a ? a.toString('utf8') : '', b ? b.toString('utf8') : '');
  return { ruta: rutaDestino, binario: false, grande: false, existiaAntes: a !== null, existeDespues: b !== null, ...d };
}

module.exports = {
  traerCommits, traerPRs, traerBuilds, traerReleases, traerDespliegues, mapearDespliegue,
  consultarWiql, traerWorkItems, escapar, contenidoEn, diffArchivo,
  RESULTADOS_BUILD, ESTADOS_BUILD, MOTIVOS_BUILD, AzureError,
};
