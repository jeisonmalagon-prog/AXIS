// Azure DevOps -- consultas de SOLO LECTURA de Pipelines, Pruebas, Releases, Boards
// (work items) y Equipo/seguridad (equipos, políticas, agentes, ambientes,
// artefactos, conexiones de servicio, grupos de variables). Se monta dentro de
// azureRepo.js, que ya exige sesión y el módulo REPOSITORIO.
//
// Seguridad: nunca se devuelven valores de variables, secretos ni credenciales de
// conexiones de servicio; los registros y mensajes de error pasan por
// ocultarSecretos(); las conexiones y variables solo las ve ADMIN_POD.

const express = require('express');
const C = require('../utils/azureCliente');
const M = require('../utils/azureMapas');
const D = require('../utils/azureDatos');
const S = require('../utils/azureEstadisticas');
const { ocultarSecretos } = require('../utils/ocultarSecretos');

const router = express.Router();
const {
  obtener, llamar, urlProyecto, urlOrg, urlVsrm, urlFeeds, seccion, responderError, repoDe, ramaDe, esEntero, esGuid, enteroEntre, mapLimit, AzureError, web, enc,
} = C;

const envolver = (contexto, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { responderError(res, err, `azure-repo ${contexto}`); }
};
const peticionInvalida = (msg) => new AzureError(msg, { status: 400, codigo: 'PETICION' });
const soloAdmin = (req, res) => {
  if (C.esAdminPod(req)) return false;
  res.status(403).json({ error: 'Esta sección solo está disponible para el administrador.', codigo: 'SOLO_ADMIN' });
  return true;
};
const textoSeguro = (v, max = 100) => {
  const t = String(v ?? '').trim();
  if (t.length > max || /[\0\r\n]/.test(t)) throw peticionInvalida('Un filtro tiene un valor no válido.');
  return t;
};
const NOMBRE_SECRETO = /token|key|secret|password|passwd|pwd|credential|clave/i;

// --------------------------------------------------------------------------------------
// Pipelines
// --------------------------------------------------------------------------------------

function mapearDefinicion(d) {
  return {
    id: d.id,
    nombre: d.name,
    carpeta: d.path || '\\',
    estadoCola: d.queueStatus || 'enabled',
    tipo: d.process?.type === 2 ? 'YAML' : 'Clásico',
    archivoYaml: d.process?.yamlFilename || null,
    repositorio: d.repository?.name || null,
    repositorioId: d.repository?.id || null,
    ramaPorDefecto: M.sinRefs(d.repository?.defaultBranch) || null,
    creado: d.createdDate || null,
    autor: M.nombreDe(d.authoredBy),
    ultimo: d.latestBuild ? M.mapearBuild(d.latestBuild, web) : null,
    ultimoCompletado: d.latestCompletedBuild ? M.mapearBuild(d.latestCompletedBuild, web) : null,
    url: web.definicion(d.id),
  };
}

router.get('/pipelines/definiciones', envolver('GET /pipelines/definiciones', async (req, res) => {
  const r = await obtener(urlProyecto('/build/definitions'), { $top: 300, includeLatestBuilds: 'true' }, { area: 'builds' });
  const definiciones = (r.value || []).map(mapearDefinicion).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  res.json({ definiciones, total: definiciones.length });
}));

function resumenTriggers(def) {
  return (def.triggers || []).map((t) => ({
    tipo: t.triggerType,
    ramas: t.branchFilters || [],
    rutas: t.pathFilters || [],
    programaciones: (t.schedules || []).map((s) => ({ ramas: s.branchFilters || [], dias: s.daysToBuild, hora: s.startHours, minuto: s.startMinutes, zona: s.timeZoneId })),
    pipelines: t.definition ? t.definition.name || null : undefined,
  }));
}

router.get('/pipelines/definiciones/:id', envolver('GET /pipelines/definiciones/:id', async (req, res) => {
  const { id } = req.params;
  if (!esEntero(id)) throw peticionInvalida('Pipeline no válido.');
  const def = await obtener(urlProyecto(`/build/definitions/${id}`), {}, { area: 'builds' });
  const [recientes, yaml] = await Promise.all([
    seccion(async () => {
      const { builds } = await D.traerBuilds({ dias: 60, definiciones: id, maximo: 300 });
      return { ejecuciones: builds.slice(0, 20), estadisticas: S.estadisticasBuilds(builds, 30) };
    }),
    seccion(async () => {
      if (def.process?.type !== 2 || !def.process.yamlFilename) return null;
      const rama = M.sinRefs(def.repository?.defaultBranch) || C.BRANCH;
      const buf = await D.contenidoEn(def.repository.id, `/${def.process.yamlFilename.replace(/^\/+/, '')}`, rama, 'branch');
      return buf ? ocultarSecretos(buf.toString('utf8')) : null;
    }),
  ]);
  res.json({
    definicion: mapearDefinicion(def),
    triggers: resumenTriggers(def),
    // Solo nombres de variables: los valores pueden ser sensibles y no se muestran.
    variables: Object.entries(def.variables || {}).map(([nombre, v]) => ({ nombre, secreta: !!v.isSecret || NOMBRE_SECRETO.test(nombre), permiteCambio: !!v.allowOverride })),
    revision: def.revision ?? null,
    ejecuciones: recientes.datos || null, errorEjecuciones: recientes.error || null,
    yaml: yaml.datos ?? null, errorYaml: yaml.error || null,
  });
}));

router.get('/pipelines/ejecuciones', envolver('GET /pipelines/ejecuciones', async (req, res) => {
  const dias = enteroEntre(req.query.dias, 1, 180, 30);
  const limite = enteroEntre(req.query.limite, 10, 200, 50);
  const resultado = D.RESULTADOS_BUILD.includes(req.query.resultado) ? req.query.resultado : undefined;
  const estado = D.ESTADOS_BUILD.includes(req.query.estado) ? req.query.estado : undefined;
  const motivo = D.MOTIVOS_BUILD.includes(req.query.motivo) ? req.query.motivo : undefined;
  let definiciones;
  if (req.query.definicion) {
    const ids = String(req.query.definicion).split(',');
    if (!ids.every(esEntero) || ids.length > 20) throw peticionInvalida('Pipeline no válido.');
    definiciones = ids.join(',');
  }
  const rama = req.query.rama ? textoSeguro(req.query.rama, 250) : undefined;
  if (rama && (!/^[\w./()#+@\- ]+$/.test(rama) || rama.includes('..'))) throw peticionInvalida('Rama no válida.');
  const continuacion = req.query.continuacion ? textoSeguro(req.query.continuacion, 300) : undefined;
  const solicitante = textoSeguro(req.query.solicitante || '', 100).toLowerCase();

  const r = await D.traerBuilds({ dias, definiciones, resultado, estado, motivo, rama, maximo: limite, continuacion });
  let ejecuciones = r.builds;
  if (solicitante) ejecuciones = ejecuciones.filter((b) => b.solicitadoPor.toLowerCase().includes(solicitante));
  res.json({ ejecuciones, continuacion: r.continuacion, dias });
}));

function arbolTimeline(registros) {
  const ocultos = (r) => r.type === 'Phase' || String(r.type || '').startsWith('Checkpoint');
  const porId = new Map(registros.map((r) => [r.id, r]));
  const visiblePadre = (r) => {
    let p = r.parentId ? porId.get(r.parentId) : null;
    while (p && ocultos(p)) p = p.parentId ? porId.get(p.parentId) : null;
    return p ? p.id : null;
  };
  const nodos = new Map();
  for (const r of registros.filter((x) => !ocultos(x))) {
    nodos.set(r.id, {
      id: r.id,
      tipo: r.type,
      nombre: r.name,
      estado: r.state || null,
      resultado: r.result || null,
      inicio: r.startTime || null,
      fin: r.finishTime || null,
      duracionMs: M.duracionMs(r.startTime, r.finishTime),
      orden: r.order ?? 0,
      errores: r.errorCount || 0,
      advertencias: r.warningCount || 0,
      problemas: (r.issues || []).slice(0, 10).map((i) => ({ tipo: i.type, mensaje: ocultarSecretos(String(i.message || '')).slice(0, 600) })),
      logId: r.log && r.log.id !== undefined ? r.log.id : null,
      agente: r.workerName || null,
      hijos: [],
    });
  }
  const raices = [];
  for (const r of registros) {
    const nodo = nodos.get(r.id);
    if (!nodo) continue;
    const padre = nodos.get(visiblePadre(r));
    if (padre) padre.hijos.push(nodo); else raices.push(nodo);
  }
  const ordenar = (lista) => { lista.sort((a, b) => a.orden - b.orden); lista.forEach((n) => ordenar(n.hijos)); };
  ordenar(raices);
  return raices;
}

router.get('/pipelines/ejecuciones/:id', envolver('GET /pipelines/ejecuciones/:id', async (req, res) => {
  const { id } = req.params;
  if (!esEntero(id)) throw peticionInvalida('Ejecución no válida.');
  const base = urlProyecto(`/build/builds/${id}`);
  const b = await obtener(base, {}, { area: 'builds' });
  const [timeline, cambios, items, artefactos] = await Promise.all([
    seccion(async () => arbolTimeline((await obtener(`${base}/timeline`, {}, { area: 'builds' })).records || [])),
    seccion(async () => ((await obtener(`${base}/changes`, { $top: 50 }, { area: 'builds' })).value || []).map((c) => ({
      id: (c.id || '').substring(0, 8), mensaje: M.primeraLinea(c.message), autor: M.nombreDe(c.author), fecha: c.timestamp || null,
    }))),
    seccion(async () => {
      const ids = ((await obtener(`${base}/workitems`, {}, { area: 'builds' })).value || []).map((w) => parseInt(w.id, 10)).filter(Number.isInteger);
      return ids.length ? D.traerWorkItems(ids.slice(0, 50)) : [];
    }),
    seccion(async () => ((await obtener(`${base}/artifacts`, {}, { area: 'builds' })).value || []).map((a) => ({
      nombre: a.name, tipo: a.resource?.type || null, tamanoBytes: a.resource?.properties?.artifactsize ? Number(a.resource.properties.artifactsize) : null,
    }))),
  ]);

  let parametros = [];
  try {
    const p = typeof b.parameters === 'string' ? JSON.parse(b.parameters || '{}') : (b.parameters || {});
    parametros = Object.entries(p).slice(0, 60).map(([nombre, valor]) => ({
      nombre, valor: NOMBRE_SECRETO.test(nombre) ? '••••••' : ocultarSecretos(String(valor)).slice(0, 300),
    }));
  } catch { /* sin parámetros */ }

  res.json({
    ejecucion: M.mapearBuild(b, web),
    mensajeCommit: M.primeraLinea(b.sourceVersionMessage || ''),
    prioridad: b.priority || null,
    etapas: timeline.datos || null, errorEtapas: timeline.error || null,
    cambios: cambios.datos || [], workItems: items.datos || [], artefactos: artefactos.datos || [],
    parametros,
  });
}));

router.get('/pipelines/ejecuciones/:id/logs/:logId', envolver('GET /pipelines/ejecuciones/:id/logs/:logId', async (req, res) => {
  const { id, logId } = req.params;
  if (!esEntero(id) || !esEntero(logId)) throw peticionInvalida('Registro no válido.');
  const ultimas = enteroEntre(req.query.ultimas, 100, 10000, 3000);
  const texto = await llamar(`${urlProyecto(`/build/builds/${id}/logs/${logId}`)}?api-version=${C.API}`, { accept: 'texto', area: 'builds', cacheMs: 30000, timeoutMs: 40000 });
  let lineas = String(texto).split(/\r?\n/);
  const total = lineas.length;
  const truncado = total > ultimas;
  if (truncado) lineas = lineas.slice(total - ultimas);
  let salida = ocultarSecretos(lineas.join('\n'));
  if (salida.length > 600000) salida = salida.slice(salida.length - 600000);
  res.json({ texto: salida, lineasTotales: total, lineasMostradas: Math.min(total, ultimas), truncado });
}));

router.get('/pipelines/estadisticas', envolver('GET /pipelines/estadisticas', async (req, res) => {
  const dias = enteroEntre(req.query.dias, 7, 90, 30);
  const { builds } = await D.traerBuilds({ dias, maximo: 1000 });
  res.json({ dias, estadisticas: S.estadisticasBuilds(builds, dias), muestra: builds.length, limitada: builds.length >= 1000 });
}));

// Pruebas (Azure solo permite ventanas de hasta 7 días al listar ejecuciones de pruebas)
function mapearRunPrueba(r) {
  const stats = Array.isArray(r.runStatistics) ? r.runStatistics : [];
  const total = r.totalTests ?? 0;
  const pasadas = r.passedTests ?? 0;
  const noAplica = r.notApplicableTests ?? 0;
  const incompletas = r.incompleteTests ?? 0;
  const fallidasStats = stats.filter((s) => String(s.outcome).toLowerCase() === 'failed').reduce((a, s) => a + (s.count || 0), 0);
  const fallidas = stats.length ? fallidasStats : Math.max(0, total - pasadas - noAplica - incompletas);
  const aplicables = Math.max(0, total - noAplica);
  return {
    id: r.id,
    nombre: r.name,
    estado: r.state,
    automatizada: !!r.isAutomated,
    inicio: r.startedDate || null,
    fin: r.completedDate || null,
    duracionMs: M.duracionMs(r.startedDate, r.completedDate),
    total, pasadas, fallidas, incompletas, noAplica,
    tasaExito: aplicables ? Math.round((pasadas / aplicables) * 1000) / 10 : null,
    buildId: r.build?.id ? Number(r.build.id) : null,
    url: r.webAccessUrl && /^https?:\/\//i.test(r.webAccessUrl) ? r.webAccessUrl : null,
  };
}

router.get('/pipelines/pruebas', envolver('GET /pipelines/pruebas', async (req, res) => {
  const dias = enteroEntre(req.query.dias, 1, 7, 7);
  const ahora = Date.now();
  const r = await obtener(urlProyecto('/test/runs'), {
    minLastUpdatedDate: new Date(ahora - dias * M.DIA_MS).toISOString(),
    maxLastUpdatedDate: new Date(ahora).toISOString(),
    $top: 100,
  }, { area: 'pruebas' });
  const runs = (r.value || []).map(mapearRunPrueba).sort((a, b) => new Date(b.inicio || 0) - new Date(a.inicio || 0));
  const tot = runs.reduce((a, x) => ({ total: a.total + x.total, pasadas: a.pasadas + x.pasadas, fallidas: a.fallidas + x.fallidas }), { total: 0, pasadas: 0, fallidas: 0 });
  res.json({
    dias, runs,
    resumen: { ejecuciones: runs.length, ...tot, tasaExito: S.porcentaje(tot.pasadas, tot.total) },
  });
}));

router.get('/pipelines/pruebas/:id', envolver('GET /pipelines/pruebas/:id', async (req, res) => {
  const { id } = req.params;
  if (!esEntero(id)) throw peticionInvalida('Ejecución de pruebas no válida.');
  const run = await obtener(urlProyecto(`/test/runs/${id}`), {}, { area: 'pruebas' });
  const fallos = await seccion(async () => ((await obtener(urlProyecto(`/test/runs/${id}/results`), { outcomes: 'Failed', $top: 100 }, { area: 'pruebas' })).value || []).map((x) => ({
    nombre: x.testCaseTitle || x.automatedTestName || x.testCase?.name || 'Prueba',
    prueba: x.automatedTestName || null,
    resultado: x.outcome,
    duracionMs: x.durationInMs ?? null,
    mensaje: ocultarSecretos(String(x.errorMessage || '')).slice(0, 1200),
    responsable: M.nombreDe(x.owner),
  })));
  res.json({ run: mapearRunPrueba(run), fallos: fallos.datos || [], errorFallos: fallos.error || null });
}));

// --------------------------------------------------------------------------------------
// Releases
// --------------------------------------------------------------------------------------

router.get('/releases/definiciones', envolver('GET /releases/definiciones', async (req, res) => {
  const r = await obtener(urlVsrm('/release/definitions'), { $expand: 'environments,lastRelease', $top: 200 }, { area: 'releases' });
  const definiciones = (r.value || []).map((d) => ({
    id: d.id,
    nombre: d.name,
    carpeta: d.path || '\\',
    ambientes: (d.environments || []).map((e) => e.name),
    ultimoRelease: d.lastRelease ? { id: d.lastRelease.id, nombre: d.lastRelease.name, creado: d.lastRelease.createdOn || null, autor: M.nombreDe(d.lastRelease.createdBy), url: web.release(d.lastRelease.id) } : null,
    creado: d.createdOn || null,
    autor: M.nombreDe(d.createdBy),
  })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  res.json({ definiciones, total: definiciones.length });
}));

router.get('/releases', envolver('GET /releases', async (req, res) => {
  const dias = enteroEntre(req.query.dias, 1, 365, 60);
  const limite = enteroEntre(req.query.limite, 10, 200, 50);
  const definicionId = req.query.definicion ? (esEntero(req.query.definicion) ? req.query.definicion : (() => { throw peticionInvalida('Definición no válida.'); })()) : undefined;
  const lista = await D.traerReleases({ dias, definicionId, maximo: limite });
  res.json({ releases: lista, dias });
}));

const ESTADO_APROBACION = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada', reassigned: 'Reasignada', canceled: 'Cancelada', skipped: 'Omitida', undefined: '—' };

function mapearAprobacion(a) {
  return {
    aprobador: M.nombreDe(a.approver) || M.nombreDe(a.approvedBy) || 'Automática',
    automatica: !!a.isAutomated,
    estado: a.status,
    estadoTexto: ESTADO_APROBACION[a.status] || a.status || '—',
    comentario: a.comments ? ocultarSecretos(String(a.comments)).slice(0, 500) : '',
    fecha: a.modifiedOn || a.createdOn || null,
  };
}

router.get('/releases/estadisticas', envolver('GET /releases/estadisticas', async (req, res) => {
  const dias = enteroEntre(req.query.dias, 7, 180, 60);
  const [releases, despliegues] = await Promise.all([
    seccion(async () => S.estadisticasReleases(await D.traerReleases({ dias, maximo: 300 }), dias)),
    seccion(async () => S.estadisticasDespliegues(await D.traerDespliegues({ dias, maximo: 500 }), dias)),
  ]);
  res.json({ dias, releases, despliegues });
}));

router.get('/releases/despliegues', envolver('GET /releases/despliegues', async (req, res) => {
  const dias = enteroEntre(req.query.dias, 1, 180, 30);
  const limite = enteroEntre(req.query.limite, 10, 200, 60);
  const estado = ['succeeded', 'failed', 'partiallySucceeded', 'inProgress', 'notDeployed'].includes(req.query.estado) ? req.query.estado : undefined;
  const definicionId = req.query.definicion && esEntero(req.query.definicion) ? req.query.definicion : undefined;
  const lista = await D.traerDespliegues({ dias, estado, definicionId, maximo: limite });
  res.json({ despliegues: lista, dias });
}));

router.get('/releases/:id', envolver('GET /releases/:id', async (req, res) => {
  const { id } = req.params;
  if (!esEntero(id)) throw peticionInvalida('Release no válido.');
  const r = await obtener(urlVsrm(`/release/releases/${id}`), {}, { area: 'releases' });
  const ambientes = (r.environments || []).map((e) => {
    const pasos = e.deploySteps || [];
    const ultimo = pasos[pasos.length - 1] || null;
    const tareas = [];
    for (const fase of (ultimo?.releaseDeployPhases || [])) {
      for (const job of (fase.deploymentJobs || [])) {
        for (const t of (job.tasks || [])) {
          tareas.push({
            fase: fase.name, trabajo: job.job?.name || null, nombre: t.name, estado: t.status,
            inicio: t.startTime || null, fin: t.finishTime || null, duracionMs: M.duracionMs(t.startTime, t.finishTime),
            problemas: (t.issues || []).slice(0, 5).map((i) => ({ tipo: i.issueType, mensaje: ocultarSecretos(String(i.message || '')).slice(0, 500) })),
          });
        }
      }
    }
    return {
      id: e.id, nombre: e.name, estado: e.status || 'notStarted', estadoTexto: M.ESTADO_RELEASE_AMBIENTE[e.status] || e.status || '—',
      intentos: pasos.length,
      solicitadoPor: ultimo ? M.nombreDe(ultimo.requestedFor) : null,
      inicio: ultimo?.queuedOn || null,
      aprobacionesPrevias: (e.preDeployApprovals || []).filter((a) => !a.isAutomated || a.status !== 'approved').map(mapearAprobacion),
      aprobacionesPosteriores: (e.postDeployApprovals || []).filter((a) => !a.isAutomated || a.status !== 'approved').map(mapearAprobacion),
      tareas: tareas.slice(0, 80),
    };
  });
  res.json({
    release: M.mapearRelease(r, web),
    ambientes,
    artefactos: (r.artifacts || []).map((a) => ({
      alias: a.alias, tipo: a.type, principal: !!a.isPrimary,
      definicion: a.definitionReference?.definition?.name || null,
      version: a.definitionReference?.version?.name || null,
      rama: a.definitionReference?.branch?.name || null,
      commit: a.definitionReference?.sourceVersion?.id ? String(a.definitionReference.sourceVersion.id).substring(0, 8) : null,
    })),
  });
}));

// --------------------------------------------------------------------------------------
// Boards (work items)
// --------------------------------------------------------------------------------------

const TERMINADOS_WIQL = "('Closed','Done','Removed','Resolved','Completed')";
const rutaWiql = (path, tipo) => String(path || '').replace(/^\\/, '').replace(new RegExp(`\\\\${tipo}(\\\\|$)`), '$1');

function aplanarNodos(nodo, tipo, salida = []) {
  if (!nodo) return salida;
  salida.push({
    nombre: nodo.name,
    ruta: rutaWiql(nodo.path, tipo),
    inicio: nodo.attributes?.startDate || null,
    fin: nodo.attributes?.finishDate || null,
    profundidad: String(nodo.path || '').split('\\').filter(Boolean).length - 2,
  });
  for (const h of nodo.children || []) aplanarNodos(h, tipo, salida);
  return salida;
}

router.get('/boards/resumen', envolver('GET /boards/resumen', async (req, res) => {
  const dias = enteroEntre(req.query.dias, 7, 180, 30);
  const ids = await D.consultarWiql(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ([System.ChangedDate] >= @today - ${dias} OR [System.State] NOT IN ${TERMINADOS_WIQL}) ORDER BY [System.ChangedDate] DESC`, 1000);
  const lista = await D.traerWorkItems(ids);
  res.json({
    dias, muestra: lista.length, limitada: ids.length >= 1000,
    estadisticas: S.estadisticasWorkItems(lista),
    recientes: [...lista].sort((a, b) => new Date(b.cambiado || 0) - new Date(a.cambiado || 0)).slice(0, 10),
  });
}));

router.get('/boards/items', envolver('GET /boards/items', async (req, res) => {
  const limite = enteroEntre(req.query.limite, 10, 200, 50);
  const cond = ['[System.TeamProject] = @project'];
  const q = (k) => textoSeguro(req.query[k] || '', 120);
  const esc = D.escapar;
  if (q('tipo')) cond.push(`[System.WorkItemType] = '${esc(q('tipo'))}'`);
  if (q('estado')) cond.push(`[System.State] = '${esc(q('estado'))}'`);
  if (req.query.abiertos === 'true') cond.push(`[System.State] NOT IN ${TERMINADOS_WIQL}`);
  if (q('asignado') === '__sin_asignar__') cond.push("[System.AssignedTo] = ''");
  else if (q('asignado')) cond.push(`[System.AssignedTo] = '${esc(q('asignado'))}'`);
  if (q('iteracion')) cond.push(`[System.IterationPath] UNDER '${esc(q('iteracion'))}'`);
  if (q('area')) cond.push(`[System.AreaPath] UNDER '${esc(q('area'))}'`);
  if (q('etiqueta')) cond.push(`[System.Tags] CONTAINS '${esc(q('etiqueta'))}'`);
  if (req.query.dias) cond.push(`[System.ChangedDate] >= @today - ${enteroEntre(req.query.dias, 1, 730, 30)}`);
  const texto = q('texto');
  if (texto) cond.push(esEntero(texto) ? `([System.Id] = ${texto} OR [System.Title] CONTAINS '${esc(texto)}')` : `[System.Title] CONTAINS '${esc(texto)}'`);
  const ids = await D.consultarWiql(`SELECT [System.Id] FROM WorkItems WHERE ${cond.join(' AND ')} ORDER BY [System.ChangedDate] DESC`, limite);
  const items = await D.traerWorkItems(ids.slice(0, limite));
  const orden = new Map(ids.map((id, i) => [id, i]));
  items.sort((a, b) => orden.get(a.id) - orden.get(b.id));
  res.json({ items, total: ids.length, limite, limitado: ids.length >= limite });
}));

router.get('/boards/items/:id', envolver('GET /boards/items/:id', async (req, res) => {
  const { id } = req.params;
  if (!esEntero(id)) throw peticionInvalida('Work item no válido.');
  const base = urlProyecto(`/wit/workitems/${id}`);
  const w = await obtener(base, { $expand: 'all' }, { area: 'workitems' });
  const f = w.fields || {};
  const relaciones = (w.relations || []).map(M.mapearRelacion);
  const idsRel = relaciones.filter((r) => r.clase === 'workitem').map((r) => parseInt(r.id, 10));

  const [comentarios, historial, relacionados] = await Promise.all([
    seccion(async () => ((await obtener(`${base}/comments`, { $top: 100 }, { area: 'workitems', apiVersion: '7.1-preview.4' })).comments || []).map((c) => ({
      autor: M.nombreDe(c.createdBy) || 'Desconocido', fecha: c.createdDate || null, texto: ocultarSecretos(M.htmlATexto(c.text)).slice(0, 4000),
    }))),
    seccion(async () => {
      const u = (await obtener(`${base}/updates`, { $top: 200 }, { area: 'workitems' })).value || [];
      const campos = { 'System.State': 'Estado', 'System.AssignedTo': 'Asignado a', 'System.IterationPath': 'Iteración', 'Microsoft.VSTS.Common.Priority': 'Prioridad', 'System.Title': 'Título' };
      const salida = [];
      for (const x of u) {
        for (const [campo, etiqueta] of Object.entries(campos)) {
          const c = x.fields?.[campo];
          if (!c || c.newValue === undefined) continue;
          salida.push({
            fecha: x.revisedDate && !String(x.revisedDate).startsWith('9999') ? x.revisedDate : (x.fields?.['System.ChangedDate']?.newValue || null),
            autor: M.nombreDe(x.revisedBy), campo: etiqueta,
            antes: c.oldValue === undefined ? null : String(M.nombreDe(c.oldValue) || c.oldValue),
            despues: String(M.nombreDe(c.newValue) || c.newValue),
          });
        }
      }
      return salida;
    }),
    seccion(async () => (idsRel.length ? D.traerWorkItems(idsRel.slice(0, 40)) : [])),
  ]);
  const titulos = new Map((relacionados.datos || []).map((x) => [String(x.id), x]));
  res.json({
    item: M.mapearWorkItem(w, web),
    descripcion: ocultarSecretos(M.htmlATexto(f['System.Description'])),
    criterios: ocultarSecretos(M.htmlATexto(f['Microsoft.VSTS.Common.AcceptanceCriteria'])),
    pasosRepro: ocultarSecretos(M.htmlATexto(f['Microsoft.VSTS.TCM.ReproSteps'])),
    relaciones: relaciones.map((r) => (r.clase === 'workitem' && titulos.has(r.id) ? { ...r, titulo: titulos.get(r.id).titulo, estado: titulos.get(r.id).estado, tipoItem: titulos.get(r.id).tipo, url: web.workItem(r.id) } : r)),
    comentarios: comentarios.datos || [], errorComentarios: comentarios.error || null,
    historial: historial.datos || [], errorHistorial: historial.error || null,
  });
}));

router.get('/boards/sprints', envolver('GET /boards/sprints', async (req, res) => {
  const [it, ar] = await Promise.all([
    obtener(urlProyecto('/wit/classificationnodes/iterations'), { $depth: 6 }, { area: 'workitems' }),
    seccion(() => obtener(urlProyecto('/wit/classificationnodes/areas'), { $depth: 6 }, { area: 'workitems' })),
  ]);
  const ahora = Date.now();
  const iteraciones = aplanarNodos(it, 'Iteration').slice(1).map((n) => {
    const ini = n.inicio ? new Date(n.inicio).getTime() : null;
    const fin = n.fin ? new Date(n.fin).getTime() : null;
    let estado = 'sinFechas';
    if (ini && fin) estado = ahora < ini ? 'futuro' : (ahora > fin + M.DIA_MS ? 'pasado' : 'actual');
    return { ...n, estado };
  });
  res.json({ iteraciones, areas: ar.datos ? aplanarNodos(ar.datos, 'Area').slice(1) : [], errorAreas: ar.error || null });
}));

router.get('/boards/sprints/detalle', envolver('GET /boards/sprints/detalle', async (req, res) => {
  const ruta = textoSeguro(req.query.ruta, 250);
  if (!ruta || !/^[\p{L}\p{N} _.\-\\()#+]+$/u.test(ruta)) throw peticionInvalida('Iteración no válida.');
  const ids = await D.consultarWiql(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.IterationPath] UNDER '${D.escapar(ruta)}' ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.Id] ASC`, 800);
  const lista = await D.traerWorkItems(ids);
  const hechos = lista.filter((i) => M.estaTerminado(i.estado));
  const suma = (arr, k) => arr.reduce((a, i) => a + (Number(i[k]) || 0), 0);
  const porAsignado = new Map();
  for (const i of lista) {
    const k = i.asignado || 'Sin asignar';
    const a = porAsignado.get(k) || { nombre: k, total: 0, hechos: 0, puntos: 0, puntosHechos: 0, restante: 0 };
    a.total++; a.puntos += Number(i.puntos) || 0; a.restante += Number(i.restante) || 0;
    if (M.estaTerminado(i.estado)) { a.hechos++; a.puntosHechos += Number(i.puntos) || 0; }
    porAsignado.set(k, a);
  }
  const iter = await seccion(async () => {
    const n = await obtener(urlProyecto('/wit/classificationnodes/iterations'), { $depth: 6 }, { area: 'workitems' });
    return aplanarNodos(n, 'Iteration').find((x) => x.ruta === ruta) || null;
  });
  res.json({
    ruta, iteracion: iter.datos || null,
    resumen: {
      total: lista.length, hechos: hechos.length, avance: S.porcentaje(hechos.length, lista.length),
      puntos: suma(lista, 'puntos'), puntosHechos: suma(hechos, 'puntos'), avancePuntos: S.porcentaje(suma(hechos, 'puntos'), suma(lista, 'puntos')),
      restante: suma(lista, 'restante'), sinAsignar: lista.filter((i) => !i.asignado && !M.estaTerminado(i.estado)).length,
    },
    porEstado: S.contar(lista, (i) => i.estado),
    porTipo: S.contar(lista, (i) => i.tipo),
    porAsignado: [...porAsignado.values()].sort((a, b) => b.total - a.total),
    items: lista.slice(0, 200),
    limitado: ids.length >= 800,
  });
}));

router.get('/boards/consultas', envolver('GET /boards/consultas', async (req, res) => {
  const r = await obtener(urlProyecto('/wit/queries'), { $depth: 2 }, { area: 'workitems' });
  const salida = [];
  const recorrer = (nodo, carpeta) => {
    for (const q of nodo.children || []) {
      if (q.isFolder) recorrer(q, carpeta ? `${carpeta} / ${q.name}` : q.name);
      else salida.push({ id: q.id, nombre: q.name, carpeta, tipo: q.queryType || null });
    }
  };
  for (const raiz of r.value || []) recorrer(raiz, raiz.name);
  res.json({ consultas: salida });
}));

router.get('/boards/consultas/:id', envolver('GET /boards/consultas/:id', async (req, res) => {
  const { id } = req.params;
  if (!esGuid(id)) throw peticionInvalida('Consulta no válida.');
  const r = await llamar(`${urlProyecto(`/wit/wiql/${id}`)}?$top=200&api-version=${C.API}`, { area: 'workitems', cacheMs: 60000 });
  const ids = (r.workItems || []).map((w) => w.id).slice(0, 200);
  const items = ids.length ? await D.traerWorkItems(ids) : [];
  const orden = new Map(ids.map((i, n) => [i, n]));
  items.sort((a, b) => orden.get(a.id) - orden.get(b.id));
  res.json({ items, total: (r.workItems || []).length });
}));

// --------------------------------------------------------------------------------------
// Equipo y seguridad
// --------------------------------------------------------------------------------------

router.get('/equipo/proyecto', envolver('GET /equipo/proyecto', async (req, res) => {
  const [proyecto, equipos] = await Promise.all([
    obtener(urlOrg(`/projects/${enc(C.PROJECT)}`), { includeCapabilities: 'true' }, { area: 'proyecto' }),
    obtener(urlOrg(`/projects/${enc(C.PROJECT)}/teams`), { $top: 100 }, { area: 'proyecto' }),
  ]);
  const listaEquipos = (equipos.value || []).slice(0, 25);
  const detalle = await mapLimit(listaEquipos, 4, async (t) => {
    const m = await seccion(async () => (await obtener(urlOrg(`/projects/${enc(C.PROJECT)}/teams/${enc(t.id)}/members`), { $top: 200 }, { area: 'proyecto' })).value || []);
    return {
      id: t.id, nombre: t.name, descripcion: t.description || '',
      miembros: (m.datos || []).map((x) => ({ nombre: x.identity?.displayName || 'Desconocido', usuario: x.identity?.uniqueName || null, admin: !!x.isTeamAdmin })),
      errorMiembros: m.error || null,
    };
  });
  const personas = new Map();
  for (const e of detalle) {
    for (const m of e.miembros) {
      const p = personas.get(m.usuario || m.nombre) || { nombre: m.nombre, usuario: m.usuario, equipos: [], admin: false };
      p.equipos.push(e.nombre);
      if (m.admin) p.admin = true;
      personas.set(m.usuario || m.nombre, p);
    }
  }
  res.json({
    proyecto: {
      nombre: proyecto.name, descripcion: proyecto.description || '', estado: proyecto.state, visibilidad: proyecto.visibility,
      ultimaActualizacion: proyecto.lastUpdateTime || null,
      control: proyecto.capabilities?.versioncontrol?.sourceControlType || null,
      proceso: proyecto.capabilities?.processTemplate?.templateName || null,
      url: web.base,
    },
    equipos: detalle,
    personas: [...personas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
  });
}));

const AJUSTES_POLITICA_VISIBLES = new Set([
  'minimumApproverCount', 'creatorVoteCounts', 'allowDownvotes', 'resetOnSourcePush', 'requireVoteOnLastIteration', 'resetOnSourcePush',
  'blockLastPusherVote', 'enforceConsistentCase', 'maximumGitBlobSizeInBytes', 'useUncompressedSize', 'validDuration', 'queueOnSourceUpdateOnly',
  'manualQueueOnly', 'displayName', 'buildDefinitionId', 'isEnabled', 'useSquashMerge', 'allowSquash', 'allowNoFastForward', 'allowRebase',
  'allowRebaseMerge', 'scope.minimumApproverCount',
]);

router.get('/equipo/politicas', envolver('GET /equipo/politicas', async (req, res) => {
  const repo = repoDe(req);
  const info = await obtener(C.urlRepo(repo), {}, { area: 'politicas' });
  const r = await obtener(urlProyecto('/policy/configurations'), { $top: 500 }, { area: 'politicas' });
  const politicas = (r.value || [])
    .filter((p) => !p.isDeleted)
    .filter((p) => {
      const ambito = p.settings?.scope || [];
      return !ambito.length || ambito.some((s) => !s.repositoryId || s.repositoryId === info.id);
    })
    .map((p) => {
      const ajustes = {};
      for (const [k, v] of Object.entries(p.settings || {})) {
        if (AJUSTES_POLITICA_VISIBLES.has(k) && ['string', 'number', 'boolean'].includes(typeof v)) ajustes[k] = typeof v === 'string' ? ocultarSecretos(v).slice(0, 120) : v;
      }
      return {
        id: p.id,
        tipo: p.type?.displayName || 'Política',
        habilitada: !!p.isEnabled,
        requerida: !!p.isBlocking,
        ambito: (p.settings?.scope || []).map((s) => ({ rama: s.refName ? M.sinRefs(s.refName) : '(todas)', coincidencia: s.matchKind || 'Exact', repositorio: s.repositoryId ? 'Este repositorio' : 'Todo el proyecto' })),
        ajustes,
        autor: M.nombreDe(p.createdBy),
        creada: p.createdDate || null,
      };
    });
  const porRama = S.contar(politicas.flatMap((p) => p.ambito.map((a) => ({ rama: a.rama }))), (x) => x.rama);
  res.json({ repo, politicas, resumen: { total: politicas.length, requeridas: politicas.filter((p) => p.requerida && p.habilitada).length, ramasProtegidas: porRama } });
}));

router.get('/equipo/agentes', envolver('GET /equipo/agentes', async (req, res) => {
  const pools = (await obtener(urlOrg('/distributedtask/pools'), {}, { area: 'agentes' })).value || [];
  const propios = pools.filter((p) => !p.isHosted).slice(0, 12);
  const detalle = await mapLimit(propios, 3, async (p) => {
    const a = await seccion(async () => (await obtener(urlOrg(`/distributedtask/pools/${p.id}/agents`), { includeAssignedRequest: 'true', includeCapabilities: 'false' }, { area: 'agentes' })).value || []);
    return {
      id: p.id, nombre: p.name, alojado: false, tamano: p.size ?? null,
      agentes: (a.datos || []).map((x) => ({
        id: x.id, nombre: x.name, estado: x.status, habilitado: x.enabled !== false, version: x.version || null, so: x.osDescription || null,
        trabajoActual: x.assignedRequest ? (x.assignedRequest.definition?.name || x.assignedRequest.jobName || 'En ejecución') : null,
      })),
      errorAgentes: a.error || null,
    };
  });
  const alojados = pools.filter((p) => p.isHosted).map((p) => ({ id: p.id, nombre: p.name, alojado: true, tamano: p.size ?? null, agentes: [] }));
  const todos = [...detalle, ...alojados];
  const agentes = detalle.flatMap((p) => p.agentes);
  res.json({
    pools: todos,
    resumen: { pools: todos.length, agentes: agentes.length, enLinea: agentes.filter((a) => a.estado === 'online').length, desconectados: agentes.filter((a) => a.estado !== 'online').length, ocupados: agentes.filter((a) => a.trabajoActual).length },
  });
}));

router.get('/equipo/ambientes', envolver('GET /equipo/ambientes', async (req, res) => {
  const lista = (await obtener(urlProyecto('/distributedtask/environments'), { $top: 100 }, { area: 'ambientes' })).value || [];
  const ambientes = await mapLimit(lista.slice(0, 30), 4, async (e) => {
    const d = await seccion(() => obtener(urlProyecto(`/distributedtask/environments/${e.id}`), { expands: 'resourceReferences' }, { area: 'ambientes' }));
    return {
      id: e.id, nombre: e.name, descripcion: e.description || '', autor: M.nombreDe(e.createdBy), creado: e.createdOn || null, modificado: e.lastModifiedOn || null,
      recursos: ((d.datos && d.datos.resources) || []).map((x) => ({ nombre: x.name, tipo: x.type })),
    };
  });
  res.json({ ambientes });
}));

router.get('/equipo/ambientes/:id/historial', envolver('GET /equipo/ambientes/:id/historial', async (req, res) => {
  const { id } = req.params;
  if (!esEntero(id)) throw peticionInvalida('Ambiente no válido.');
  const r = await obtener(urlProyecto(`/distributedtask/environments/${id}/environmentdeploymentrecords`), { top: 30 }, { area: 'ambientes' });
  res.json({
    registros: (r.value || []).map((x) => ({
      pipeline: x.definition?.name || null, ejecucion: x.owner?.name || null, resultado: x.result || null, etapa: x.stageName || null,
      inicio: x.startTime || null, fin: x.finishTime || null, duracionMs: M.duracionMs(x.startTime, x.finishTime),
      url: x.owner?.id ? web.build(x.owner.id) : null,
    })),
  });
}));

function mapearFeed(f) {
  return {
    id: f.id, nombre: f.name, descripcion: f.description || '',
    alcance: f.project ? 'Proyecto' : 'Organización', delProyecto: !!f.project,
    upstream: !!f.upstreamEnabled, fuentesUpstream: (f.upstreamSources || []).length,
    ocultaEliminadas: !!f.hideDeletedPackageVersions,
  };
}

router.get('/equipo/feeds', envolver('GET /equipo/feeds', async (req, res) => {
  const [org, proyecto] = await Promise.all([
    seccion(() => obtener(urlFeeds('/packaging/feeds', false), {}, { area: 'paquetes' })),
    seccion(() => obtener(urlFeeds('/packaging/feeds'), {}, { area: 'paquetes' })),
  ]);
  if (org.error && proyecto.error) throw new AzureError(org.error, { status: 403, codigo: org.codigo, area: 'paquetes' });
  const mapa = new Map();
  for (const f of [...((org.datos && org.datos.value) || []), ...((proyecto.datos && proyecto.datos.value) || [])]) mapa.set(f.id, mapearFeed(f));
  res.json({ feeds: [...mapa.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')) });
}));

router.get('/equipo/feeds/:id/paquetes', envolver('GET /equipo/feeds/:id/paquetes', async (req, res) => {
  const { id } = req.params;
  if (!esGuid(id)) throw peticionInvalida('Feed no válido.');
  const delProyecto = req.query.proyecto === 'true';
  const texto = textoSeguro(req.query.texto || '', 100);
  const r = await obtener(urlFeeds(`/packaging/Feeds/${id}/packages`, delProyecto), { includeAllVersions: 'true', $top: 100, packageNameQuery: texto || undefined }, { area: 'paquetes' });
  const paquetes = (r.value || []).map((p) => {
    const vs = p.versions || [];
    const ultima = vs.find((v) => v.isLatest) || vs[0] || null;
    return {
      id: p.id, nombre: p.name, tipo: p.protocolType, versiones: vs.length,
      versionReciente: ultima ? ultima.version : null, publicado: ultima ? ultima.publishDate || null : null,
      listados: vs.filter((v) => v.isListed !== false).length,
    };
  }).sort((a, b) => new Date(b.publicado || 0) - new Date(a.publicado || 0));
  res.json({ paquetes, total: paquetes.length });
}));

// Solo el origen (protocolo + host) de una URL: nunca credenciales, rutas ni parámetros.
function origenSeguro(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return null; }
}

router.get('/equipo/conexiones', envolver('GET /equipo/conexiones', async (req, res) => {
  if (soloAdmin(req, res)) return;
  const r = await obtener(urlProyecto('/serviceendpoint/endpoints'), { includeFailed: 'true' }, { area: 'conexiones', apiVersion: '7.1-preview.4' });
  const conexiones = (r.value || []).map((c) => ({
    id: c.id, nombre: c.name, tipo: c.type, descripcion: c.description || '',
    destino: origenSeguro(c.url), esquemaAutenticacion: c.authorization?.scheme || null,
    lista: c.isReady !== false, compartida: !!c.isShared, autor: M.nombreDe(c.createdBy),
  })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  res.json({ conexiones, resumen: { total: conexiones.length, conProblema: conexiones.filter((c) => !c.lista).length, tipos: S.contar(conexiones, (c) => c.tipo) } });
}));

router.get('/equipo/variables', envolver('GET /equipo/variables', async (req, res) => {
  if (soloAdmin(req, res)) return;
  const r = await obtener(urlProyecto('/distributedtask/variablegroups'), { $top: 200 }, { area: 'variables', apiVersion: '7.1-preview.2' });
  // Solo nombres: nunca valores (ni de variables normales, que a veces contienen datos sensibles).
  const grupos = (r.value || []).map((g) => ({
    id: g.id, nombre: g.name, descripcion: g.description || '', tipo: g.type || 'Vsts',
    modificado: g.modifiedOn || null, modificadoPor: M.nombreDe(g.modifiedBy),
    variables: Object.entries(g.variables || {}).map(([nombre, v]) => ({ nombre, secreta: !!(v && v.isSecret) || NOMBRE_SECRETO.test(nombre) })),
  })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  res.json({ grupos, resumen: { grupos: grupos.length, variables: grupos.reduce((a, g) => a + g.variables.length, 0) } });
}));

module.exports = router;
