// Azure DevOps -- consultas avanzadas de SOLO LECTURA: código (commits, diferencias,
// ramas, tags, comparar, pushes), pull requests, resumen general, búsqueda y
// diagnóstico de permisos. Se monta dentro de azureRepo.js, que ya exige sesión y
// el módulo REPOSITORIO. Nada aquí crea, aprueba, ejecuta ni borra en Azure.

const express = require('express');
const C = require('../utils/azureCliente');
const M = require('../utils/azureMapas');
const D = require('../utils/azureDatos');
const S = require('../utils/azureEstadisticas');
const { ocultarSecretos } = require('../utils/ocultarSecretos');
const { probarAreas } = require('../utils/azurePermisos');

const router = express.Router();
const {
  obtener, llamar, urlRepo, urlProyecto, urlBusqueda, seccion, responderError, repoDe, ramaDe, esSha, esEntero, enteroEntre, fechaIso, mapLimit, AzureError, web,
} = C;

const envolver = (contexto, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { responderError(res, err, `azure-repo ${contexto}`); }
};
const peticionInvalida = (msg) => new AzureError(msg, { status: 400, codigo: 'PETICION' });

const TIPOS_VERSION = ['branch', 'tag', 'commit'];
function versionDe(valor, tipo) {
  const v = String(valor || '').trim();
  if (!v || v.length > 250 || v.includes('..')) throw peticionInvalida('Falta una versión válida (rama, tag o commit).');
  const t = TIPOS_VERSION.includes(tipo) ? tipo : 'branch';
  if (t === 'commit' && !esSha(v)) throw peticionInvalida('Commit no válido.');
  return { v, t };
}
function rutaArchivo(valor) {
  const r = String(valor || '').trim();
  if (!r || r.length > 1000 || r.includes('..') || /[\0\r\n]/.test(r)) throw peticionInvalida('Ruta de archivo no válida.');
  return r.startsWith('/') ? r : `/${r}`;
}

// --------------------------------------------------------------------------------------
// Resumen general
// --------------------------------------------------------------------------------------

router.get('/resumen', envolver('GET /resumen', async (req, res) => {
  const repo = repoDe(req);
  const rama = await ramaDe(req, repo);
  const dias = enteroEntre(req.query.dias, 7, 90, 30);
  const desde = new Date(Date.now() - dias * M.DIA_MS).toISOString();

  // Cada bloque del resumen respeta las secciones que el usuario tiene habilitadas.
  const acc = req.accesoRepo;
  const ver = (id) => !acc || acc.total || acc.secciones.has(id);
  const bloque = (id, fn) => (ver(id) ? seccion(fn) : Promise.resolve({ error: 'No tienes acceso a esta sección.', codigo: 'SIN_ACCESO' }));

  const [info, ramas, tags, commits, prs, builds, releases, items, equipos] = await Promise.all([
    seccion(() => obtener(urlRepo(repo), {}, { area: 'codigo' }).then((r) => ({
      nombre: r.name, tamanoBytes: r.size ?? null, ramaPorDefecto: (r.defaultBranch || '').replace('refs/heads/', '') || null,
      deshabilitado: !!r.isDisabled, esFork: !!r.isFork, url: web.rama(repo, rama),
    }))),
    bloque('ramas', () => obtener(urlRepo(repo, '/refs'), { filter: 'heads/', $top: 1000 }, { area: 'codigo' }).then((r) => (r.value || []).length)),
    bloque('ramas', () => obtener(urlRepo(repo, '/refs'), { filter: 'tags/', $top: 1000 }, { area: 'codigo' }).then((r) => (r.value || []).length)),
    bloque('commits', async () => {
      const lista = await D.traerCommits(repo, rama, { desde, maximo: 2000 });
      return { estadisticas: S.estadisticasCommits(lista, dias), recientes: lista.slice(0, 8) };
    }),
    bloque('pull-requests', async () => {
      const lista = await D.traerPRs(repo, { estado: 'all', desde, maximo: 300 });
      return { estadisticas: S.estadisticasPR(lista), activos: lista.filter((p) => p.estado === 'active').slice(0, 8) };
    }),
    bloque('pipelines', async () => {
      const { builds: lista } = await D.traerBuilds({ dias, maximo: 600 });
      return { estadisticas: S.estadisticasBuilds(lista, dias), recientes: lista.slice(0, 8) };
    }),
    bloque('releases', async () => {
      const lista = await D.traerReleases({ dias: Math.max(dias, 30), maximo: 100 });
      return { estadisticas: S.estadisticasReleases(lista, Math.max(dias, 30)), recientes: lista.slice(0, 6) };
    }),
    bloque('boards', async () => {
      const ids = await D.consultarWiql(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ([System.ChangedDate] >= @today - ${dias} OR [System.State] NOT IN ('Closed','Done','Removed','Resolved','Completed')) ORDER BY [System.ChangedDate] DESC`, 600);
      const lista = await D.traerWorkItems(ids);
      return { estadisticas: S.estadisticasWorkItems(lista) };
    }),
    bloque('equipo', () => C.obtener(C.urlOrg(`/projects/${C.enc(C.PROJECT)}/teams`), { $top: 100 }, { area: 'proyecto' }).then((r) => (r.value || []).length)),
  ]);

  res.json({ repo, rama, dias, organizacion: C.ORG, proyecto: C.PROJECT, info, ramas, tags, commits, prs, builds, releases, workItems: items, equipos, generado: new Date().toISOString() });
}));

// --------------------------------------------------------------------------------------
// Commits
// --------------------------------------------------------------------------------------

router.get('/commits', envolver('GET /commits', async (req, res) => {
  const repo = repoDe(req);
  const rama = await ramaDe(req, repo);
  const limite = enteroEntre(req.query.limite, 5, 100, 30);
  const pagina = enteroEntre(req.query.pagina, 1, 200, 1);
  const texto = String(req.query.texto || '').trim().toLowerCase().slice(0, 100);
  const autor = String(req.query.autor || '').trim().slice(0, 100) || undefined;
  const ruta = req.query.ruta ? rutaArchivo(req.query.ruta) : undefined;
  const desde = fechaIso(req.query.desde) || undefined;
  const hasta = fechaIso(req.query.hasta) || undefined;

  let commits;
  let hayMas;
  if (texto) {
    // Azure no filtra por texto del mensaje: se revisan los últimos 600 y se filtra aquí.
    const base = await D.traerCommits(repo, rama, { desde, hasta, autor, ruta, maximo: 600 });
    const filtrados = base.filter((c) => c.comentarioCompleto.toLowerCase().includes(texto) || c.id.startsWith(texto) || c.autor.toLowerCase().includes(texto));
    commits = filtrados.slice((pagina - 1) * limite, pagina * limite);
    hayMas = filtrados.length > pagina * limite;
  } else {
    const lista = await D.traerCommits(repo, rama, { desde, hasta, autor, ruta, maximo: limite + 1, saltar: (pagina - 1) * limite });
    hayMas = lista.length > limite;
    commits = lista.slice(0, limite);
  }
  res.json({ repo, rama, pagina, limite, hayMas, commits });
}));

router.get('/commits/:sha', envolver('GET /commits/:sha', async (req, res) => {
  const repo = repoDe(req);
  const { sha } = req.params;
  if (!esSha(sha)) throw peticionInvalida('Commit no válido.');
  const [commit, cambios, prs] = await Promise.all([
    obtener(urlRepo(repo, `/commits/${sha}`), { changeCount: 1000 }, { area: 'codigo' }),
    seccion(() => obtener(urlRepo(repo, `/commits/${sha}/changes`), { $top: 1000 }, { area: 'codigo' })),
    seccion(async () => {
      const r = await llamar(`${urlRepo(repo, '/pullrequestquery')}?api-version=${C.API}`, {
        method: 'POST', area: 'codigo', cacheMs: 60000,
        body: { queries: [{ items: [sha], type: 'lastMergeCommit' }] },
      });
      const mapa = (r.results && r.results[0]) || {};
      const lista = Object.values(mapa).flat();
      return lista.map((p) => M.mapearPR(p, web, repo));
    }),
  ]);

  const mapeado = M.mapearCommit(commit, web, repo);
  let archivos = null;
  if (cambios.datos) {
    archivos = (cambios.datos.changes || []).map(M.mapearCambio).filter((a) => !a.esCarpeta);
  }
  res.json({
    commit: mapeado,
    archivos: archivos ? { lista: archivos.slice(0, 500), resumen: M.resumenCambios(archivos), truncado: archivos.length > 500 } : null,
    errorArchivos: cambios.error || null,
    pullRequests: prs.datos || [],
  });
}));

// Diferencias de un archivo en un commit (contra su primer padre).
router.get('/commits/:sha/diff', envolver('GET /commits/:sha/diff', async (req, res) => {
  const repo = repoDe(req);
  const { sha } = req.params;
  if (!esSha(sha)) throw peticionInvalida('Commit no válido.');
  const ruta = rutaArchivo(req.query.ruta);
  const rutaAnterior = req.query.rutaAnterior ? rutaArchivo(req.query.rutaAnterior) : ruta;
  const commit = await obtener(urlRepo(repo, `/commits/${sha}`), {}, { area: 'codigo' });
  const padre = (commit.parents || [])[0] || null;
  const resultado = await D.diffArchivo(repo, { shaBase: padre, shaDestino: commit.commitId, rutaBase: rutaAnterior, rutaDestino: ruta });
  res.json({ ...resultado, commit: commit.commitId.substring(0, 8), padre: padre ? padre.substring(0, 8) : null });
}));

// --------------------------------------------------------------------------------------
// Ramas, tags, comparación, pushes y estadísticas de código
// --------------------------------------------------------------------------------------

router.get('/ramas', envolver('GET /ramas', async (req, res) => {
  const repo = repoDe(req);
  const ramaDefecto = await C.ramaPorDefectoDe(repo);
  const [stats, refs] = await Promise.all([
    obtener(urlRepo(repo, '/stats/branches'), {}, { area: 'codigo' }),
    seccion(() => obtener(urlRepo(repo, '/refs'), { filter: 'heads/', $top: 1000 }, { area: 'codigo' })),
  ]);
  const creadores = new Map(((refs.datos && refs.datos.value) || []).map((r) => [M.sinRefs(r.name), { creador: M.nombreDe(r.creator), bloqueada: !!r.isLocked }]));
  const ahora = Date.now();
  const ramas = (stats.value || []).map((b) => {
    const fecha = b.commit?.author?.date || b.commit?.committer?.date || null;
    const dias = fecha ? Math.floor((ahora - new Date(fecha).getTime()) / M.DIA_MS) : null;
    const extra = creadores.get(b.name) || {};
    const esDefecto = b.name === ramaDefecto;
    return {
      nombre: b.name,
      esRamaPorDefecto: esDefecto,
      adelante: b.aheadCount ?? null,
      atras: b.behindCount ?? null,
      sinCambiosNuevos: !esDefecto && b.aheadCount === 0,
      creador: extra.creador || null,
      bloqueada: !!extra.bloqueada,
      diasSinActividad: dias,
      antigua: dias !== null && dias > 90 && !esDefecto,
      commit: b.commit ? M.mapearCommit(b.commit, web, repo) : null,
      url: web.rama(repo, b.name),
    };
  }).sort((a, b) => (a.esRamaPorDefecto === b.esRamaPorDefecto ? a.nombre.localeCompare(b.nombre, 'es') : (a.esRamaPorDefecto ? -1 : 1)));
  res.json({
    repo, ramaPorDefecto: ramaDefecto, ramas,
    resumen: { total: ramas.length, antiguas: ramas.filter((r) => r.antigua).length, sinCambiosNuevos: ramas.filter((r) => r.sinCambiosNuevos).length, bloqueadas: ramas.filter((r) => r.bloqueada).length },
  });
}));

router.get('/tags', envolver('GET /tags', async (req, res) => {
  const repo = repoDe(req);
  const refs = await obtener(urlRepo(repo, '/refs'), { filter: 'tags/', peelTags: 'true', $top: 500 }, { area: 'codigo' });
  const lista = (refs.value || []).slice(0, 200);
  const detalles = await mapLimit(lista.slice(0, 60), 5, async (t) => {
    const id = t.peeledObjectId || t.objectId;
    try {
      const c = await obtener(urlRepo(repo, `/commits/${id}`), {}, { area: 'codigo' });
      return M.mapearCommit(c, web, repo);
    } catch { return null; }
  });
  const tags = lista.map((t, i) => {
    const nombre = M.sinRefs(t.name);
    const c = i < detalles.length ? detalles[i] : null;
    return {
      nombre, anotado: !!t.peeledObjectId, creador: M.nombreDe(t.creator), objeto: (t.peeledObjectId || t.objectId || '').substring(0, 8),
      commit: c, fecha: c?.fecha || null, url: web.tag(repo, nombre),
    };
  }).sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
  res.json({ repo, tags, total: (refs.value || []).length });
}));

router.get('/comparar', envolver('GET /comparar', async (req, res) => {
  const repo = repoDe(req);
  const base = versionDe(req.query.base, req.query.baseTipo);
  const destino = versionDe(req.query.destino, req.query.destinoTipo);
  const [dif, commits] = await Promise.all([
    obtener(urlRepo(repo, '/diffs/commits'), {
      baseVersion: base.v, baseVersionType: base.t, targetVersion: destino.v, targetVersionType: destino.t, $top: 500,
    }, { area: 'codigo' }),
    seccion(async () => {
      const r = await llamar(`${urlRepo(repo, '/commitsbatch')}?api-version=${C.API}`, {
        method: 'POST', area: 'codigo', cacheMs: 60000,
        body: { itemVersion: { version: destino.v, versionType: destino.t }, compareVersion: { version: base.v, versionType: base.t }, $top: 100 },
      });
      return (r.value || []).map((c) => M.mapearCommit(c, web, repo));
    }),
  ]);
  const archivos = (dif.changes || []).map(M.mapearCambio).filter((a) => !a.esCarpeta);
  res.json({
    repo, base: base.v, destino: destino.v,
    adelante: dif.aheadCount ?? 0, atras: dif.behindCount ?? 0,
    archivos: { lista: archivos.slice(0, 500), resumen: M.resumenCambios(archivos), truncado: dif.allChangesIncluded === false },
    commits: commits.datos || [], errorCommits: commits.error || null,
    baseCommit: dif.baseCommit || null, destinoCommit: dif.targetCommit || null,
  });
}));

// Diferencias de un archivo entre dos versiones (comparar ramas/tags/commits).
router.get('/comparar/diff', envolver('GET /comparar/diff', async (req, res) => {
  const repo = repoDe(req);
  const base = versionDe(req.query.base, req.query.baseTipo);
  const destino = versionDe(req.query.destino, req.query.destinoTipo);
  const ruta = rutaArchivo(req.query.ruta);
  const rutaAnterior = req.query.rutaAnterior ? rutaArchivo(req.query.rutaAnterior) : ruta;
  const [a, b] = await Promise.all([
    D.contenidoEn(repo, rutaAnterior, base.v, base.t).catch((e) => { if (e.codigo === 'GRANDE') return 'grande'; throw e; }),
    D.contenidoEn(repo, ruta, destino.v, destino.t).catch((e) => { if (e.codigo === 'GRANDE') return 'grande'; throw e; }),
  ]);
  if (a === 'grande' || b === 'grande') return res.json({ ruta, grande: true, binario: false, lineas: [], resumen: { agregadas: 0, quitadas: 0 }, sinCambios: false, truncado: false });
  if ((a && a.subarray(0, 8000).includes(0)) || (b && b.subarray(0, 8000).includes(0))) return res.json({ ruta, binario: true, grande: false, lineas: [], resumen: { agregadas: 0, quitadas: 0 }, sinCambios: false, truncado: false });
  const { diffLineas } = require('../utils/diffLineas');
  return res.json({ ruta, binario: false, grande: false, ...diffLineas(a ? a.toString('utf8') : '', b ? b.toString('utf8') : '') });
}));

router.get('/pushes', envolver('GET /pushes', async (req, res) => {
  const repo = repoDe(req);
  const limite = enteroEntre(req.query.limite, 5, 100, 40);
  const params = { $top: limite, 'searchCriteria.includeRefUpdates': 'true' };
  if (req.query.rama) { const rama = await ramaDe(req, repo); params['searchCriteria.refName'] = `refs/heads/${rama}`; }
  const r = await obtener(urlRepo(repo, '/pushes'), params, { area: 'codigo' });
  const pushes = (r.value || []).map((p) => ({
    id: p.pushId,
    fecha: p.date || null,
    autor: M.nombreDe(p.pushedBy) || 'Desconocido',
    ramas: (p.refUpdates || []).map((u) => M.sinRefs(u.name)),
    commitFinal: (p.refUpdates && p.refUpdates[0] && p.refUpdates[0].newObjectId ? p.refUpdates[0].newObjectId.substring(0, 8) : null),
    esNueva: (p.refUpdates || []).some((u) => /^0+$/.test(u.oldObjectId || '')),
  })).sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
  res.json({ repo, pushes });
}));

router.get('/estadisticas/codigo', envolver('GET /estadisticas/codigo', async (req, res) => {
  const repo = repoDe(req);
  const rama = await ramaDe(req, repo);
  const dias = enteroEntre(req.query.dias, 7, 180, 30);
  const desde = new Date(Date.now() - dias * M.DIA_MS).toISOString();
  const [commits, prs] = await Promise.all([
    seccion(async () => S.estadisticasCommits(await D.traerCommits(repo, rama, { desde, maximo: 3000 }), dias)),
    seccion(async () => S.estadisticasPR(await D.traerPRs(repo, { estado: 'all', desde, maximo: 500 }))),
  ]);
  res.json({ repo, rama, dias, commits, prs });
}));

// --------------------------------------------------------------------------------------
// Pull requests
// --------------------------------------------------------------------------------------

const ESTADOS_PR = ['active', 'completed', 'abandoned', 'all'];

router.get('/prs', envolver('GET /prs', async (req, res) => {
  const repo = repoDe(req);
  const estado = ESTADOS_PR.includes(req.query.estado) ? req.query.estado : 'active';
  const limite = enteroEntre(req.query.limite, 5, 100, 30);
  const pagina = enteroEntre(req.query.pagina, 1, 100, 1);
  const texto = String(req.query.texto || '').trim().toLowerCase().slice(0, 100);
  const autor = String(req.query.autor || '').trim().toLowerCase().slice(0, 100);
  const destino = req.query.destino ? String(req.query.destino).slice(0, 250) : undefined;
  if (destino && (!/^[\w./()#+@\- ]+$/.test(destino) || destino.includes('..'))) throw peticionInvalida('Rama de destino no válida.');
  const dias = req.query.dias ? enteroEntre(req.query.dias, 1, 365, 90) : null;
  const desde = dias ? new Date(Date.now() - dias * M.DIA_MS).toISOString() : undefined;

  const filtrado = !!(texto || autor);
  let lista;
  let hayMas;
  if (filtrado) {
    const base = await D.traerPRs(repo, { estado, destino, desde, maximo: 400 });
    const f = base.filter((p) => (!texto || p.titulo.toLowerCase().includes(texto) || String(p.id) === texto || p.ramaOrigen.toLowerCase().includes(texto))
      && (!autor || p.autor.toLowerCase().includes(autor)));
    lista = f.slice((pagina - 1) * limite, pagina * limite);
    hayMas = f.length > pagina * limite;
  } else {
    const base = await D.traerPRs(repo, { estado, destino, desde, maximo: limite + 1, saltar: (pagina - 1) * limite });
    hayMas = base.length > limite;
    lista = base.slice(0, limite);
  }
  res.json({ repo, estado, pagina, limite, hayMas, prs: lista });
}));

router.get('/prs/:id', envolver('GET /prs/:id', async (req, res) => {
  const repo = repoDe(req);
  const { id } = req.params;
  if (!esEntero(id)) throw peticionInvalida('Pull request no válido.');
  const base = urlRepo(repo, `/pullrequests/${id}`);
  const pr = await obtener(base, {}, { area: 'codigo' });
  const proyectoId = pr.repository?.project?.id;

  const [hilos, commits, iteraciones, estados, politicas, items] = await Promise.all([
    seccion(async () => M.mapearHilos((await obtener(`${base}/threads`, {}, { area: 'codigo' })).value)),
    seccion(async () => ((await obtener(`${base}/commits`, { $top: 200 }, { area: 'codigo' })).value || []).map((c) => M.mapearCommit(c, web, repo))),
    seccion(async () => {
      const its = (await obtener(`${base}/iterations`, {}, { area: 'codigo' })).value || [];
      const ultima = its[its.length - 1];
      if (!ultima) return { total: 0, archivos: [], resumen: M.resumenCambios([]), base: null, origen: null };
      const ch = await obtener(`${base}/iterations/${ultima.id}/changes`, { $top: 2000 }, { area: 'codigo' });
      const archivos = (ch.changeEntries || ch.changes || []).map(M.mapearCambio).filter((a) => !a.esCarpeta);
      return {
        total: its.length, archivos: archivos.slice(0, 500), resumen: M.resumenCambios(archivos), truncado: archivos.length > 500,
        base: ultima.commonRefCommit?.commitId || null, origen: ultima.sourceRefCommit?.commitId || null,
        iteraciones: its.map((i) => ({ id: i.id, fecha: i.createdDate, autor: M.nombreDe(i.author), comentario: M.primeraLinea(i.description) })).slice(-20),
      };
    }),
    seccion(async () => ((await obtener(`${base}/statuses`, {}, { area: 'codigo' })).value || []).map((s) => ({
      nombre: s.context?.genre ? `${s.context.genre}/${s.context.name}` : (s.context?.name || 'Estado'),
      estado: s.state, descripcion: s.description || '', fecha: s.creationDate || null,
      enlace: /^https?:\/\//i.test(s.targetUrl || '') ? s.targetUrl : null,
    }))),
    seccion(async () => {
      if (!proyectoId) return [];
      const r = await obtener(urlProyecto('/policy/evaluations'), { artifactId: `vstfs:///CodeReview/CodeReviewId/${proyectoId}/${id}` }, { area: 'politicas', apiVersion: '7.1-preview.1' });
      return (r.value || []).map((e) => ({
        id: e.evaluationId,
        estado: e.status,
        tipo: e.configuration?.type?.displayName || 'Política',
        requerida: !!e.configuration?.isBlocking,
        inicio: e.startedDate || null, fin: e.completedDate || null,
      }));
    }),
    seccion(async () => {
      const r = await obtener(`${base}/workitems`, {}, { area: 'codigo' });
      const ids = (r.value || []).map((w) => parseInt(w.id, 10)).filter(Number.isInteger);
      return ids.length ? D.traerWorkItems(ids) : [];
    }),
  ]);

  res.json({
    pr: M.mapearPR(pr, web, repo),
    commitFusion: pr.lastMergeCommit?.commitId ? pr.lastMergeCommit.commitId.substring(0, 8) : null,
    hilos: hilos.datos || null, errorHilos: hilos.error || null,
    commits: commits.datos || [],
    archivos: iteraciones.datos || null, errorArchivos: iteraciones.error || null,
    estados: estados.datos || [],
    politicas: politicas.datos || [], errorPoliticas: politicas.error || null,
    workItems: items.datos || [], errorWorkItems: items.error || null,
  });
}));

router.get('/prs/:id/diff', envolver('GET /prs/:id/diff', async (req, res) => {
  const repo = repoDe(req);
  const { id } = req.params;
  if (!esEntero(id)) throw peticionInvalida('Pull request no válido.');
  const ruta = rutaArchivo(req.query.ruta);
  const rutaAnterior = req.query.rutaAnterior ? rutaArchivo(req.query.rutaAnterior) : ruta;
  const base = urlRepo(repo, `/pullrequests/${id}`);
  const its = (await obtener(`${base}/iterations`, {}, { area: 'codigo' })).value || [];
  const ultima = its[its.length - 1];
  if (!ultima) throw new AzureError('El pull request no tiene cambios.', { status: 404, codigo: 'NO_ENCONTRADO' });
  const r = await D.diffArchivo(repo, {
    shaBase: ultima.commonRefCommit?.commitId, shaDestino: ultima.sourceRefCommit?.commitId, rutaBase: rutaAnterior, rutaDestino: ruta,
  });
  res.json(r);
}));

// --------------------------------------------------------------------------------------
// Búsqueda (código y wiki)
// --------------------------------------------------------------------------------------

function fragmento(texto, desplazamiento, largo) {
  const ini = Math.max(0, texto.lastIndexOf('\n', desplazamiento) + 1);
  let fin = texto.indexOf('\n', desplazamiento + largo);
  if (fin === -1) fin = texto.length;
  const linea = texto.slice(ini, Math.min(fin, ini + 300));
  const numero = texto.slice(0, desplazamiento).split('\n').length;
  return { linea: numero, texto: ocultarSecretos(linea) };
}

router.get('/buscar', envolver('GET /buscar', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) throw peticionInvalida('Escribe al menos 2 caracteres para buscar.');
  if (q.length > 200) throw peticionInvalida('La búsqueda es demasiado larga.');
  const tipo = req.query.tipo === 'wiki' ? 'wiki' : 'codigo';
  const limite = enteroEntre(req.query.limite, 5, 50, 25);
  const pagina = enteroEntre(req.query.pagina, 1, 100, 1);
  const repo = req.query.repo ? repoDe(req) : null;

  if (tipo === 'wiki') {
    const r = await llamar(`${urlBusqueda('/search/wikisearchresults')}?api-version=${C.API}`, {
      method: 'POST', area: 'busqueda', cacheMs: 30000,
      body: { searchText: q, $skip: (pagina - 1) * limite, $top: limite, filters: { Project: [C.PROJECT] }, includeFacets: false },
    });
    return res.json({
      tipo, q, total: r.count ?? (r.results || []).length, pagina, limite,
      resultados: (r.results || []).map((x) => ({
        archivo: x.fileName, ruta: x.path, wiki: x.wiki?.name || null,
        fragmentos: (x.hits || []).flatMap((h) => h.highlights || []).map((t) => ocultarSecretos(String(t).replace(/<\/?highlighttag>/gi, ''))).slice(0, 3),
      })),
    });
  }

  const filtros = { Project: [C.PROJECT] };
  // Usuario con repositorios restringidos: la búsqueda sin ?repo= se limita a los que puede ver.
  const acc = req.accesoRepo;
  const limitar = acc && !acc.total && !acc.todosRepos;
  if (repo) filtros.Repository = [repo];
  else if (limitar) {
    if (!acc.nombresRepos.length) return res.json({ tipo, q, total: 0, pagina, limite, resultados: [] });
    filtros.Repository = acc.nombresRepos;
  }
  const r = await llamar(`${urlBusqueda('/search/codesearchresults')}?api-version=${C.API}`, {
    method: 'POST', area: 'busqueda', cacheMs: 30000,
    body: { searchText: q, $skip: (pagina - 1) * limite, $top: limite, filters: filtros, includeFacets: false },
  });
  const resultados = (r.results || []).filter((x) => !limitar || acc.repos.has(String(x.repository?.name || '').toLowerCase())).map((x) => {
    const rama = x.versions && x.versions[0] ? x.versions[0].branchName : null;
    const coincidencias = (x.matches && x.matches.content) || [];
    return {
      archivo: x.fileName, ruta: x.path, repositorio: x.repository?.name || null, rama,
      cantidad: coincidencias.length, _desp: coincidencias.slice(0, 3),
      url: x.repository?.name ? web.archivo(x.repository.name, x.path, rama || C.BRANCH) : null,
    };
  });
  // Fragmentos: se descargan los primeros resultados para mostrar la línea encontrada.
  await mapLimit(resultados.slice(0, 15), 4, async (x) => {
    try {
      const buf = await D.contenidoEn(x.repositorio, x.ruta, x.rama || C.BRANCH, 'branch');
      if (buf && !buf.subarray(0, 8000).includes(0)) {
        const texto = buf.toString('utf8');
        x.fragmentos = x._desp.map((m) => fragmento(texto, m.charOffset, m.length || 1));
      }
    } catch { /* sin fragmentos */ }
  });
  resultados.forEach((x) => { delete x._desp; });
  return res.json({ tipo, q, total: r.count ?? resultados.length, pagina, limite, resultados });
}));

// --------------------------------------------------------------------------------------
// Diagnóstico de permisos del token y refresco de caché
// --------------------------------------------------------------------------------------

router.get('/permisos', envolver('GET /permisos', async (req, res) => {
  const areas = await probarAreas();
  res.json({ organizacion: C.ORG, proyecto: C.PROJECT, areas, generado: new Date().toISOString() });
}));

router.post('/refrescar', (req, res) => {
  C.invalidarCache();
  res.json({ ok: true });
});

module.exports = router;
