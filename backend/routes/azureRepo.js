const express = require('express');
const path = require('path');
const router = express.Router();
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { getPool } = require('../db');
const { controlAcceso, puedeVerRepo } = require('../utils/repositorioPermisos');
const C = require('../utils/azureCliente');

// Todo este módulo solo necesita LEER el repositorio de Azure DevOps, así que
// solo exige sesión + el módulo REPOSITORIO habilitado (no requireEditPermission:
// aquí no hay ningún POST/PUT/DELETE, es un espejo de solo lectura).
router.use(verifyToken, requireModule('REPOSITORIO'));
// Control de acceso fino por usuario (secciones y repositorios). Mientras no exista
// la tabla repositorio_permisos no restringe nada; el ADMIN_POD siempre pasa.
// La configuración de Azure (tokens, organización, repo) se administra desde la app; se refresca antes de atender.
router.use(C.middlewareConfig);
router.use(controlAcceso(getPool, () => C.REPO));

// --- Configuración de Azure DevOps (organización/proyecto/repositorio y tokens) ---
// Se administra desde la app (Repositorio → Conexión, solo ADMIN_POD) y se guarda en la BD
// (tokens cifrados); el .env queda como respaldo. Ver utils/azureConfig.js y azureCliente.js.
// Los valores se leen en cada uso (no al arrancar) para reflejar los cambios al instante.
const projectBaseUrl = () => `${C.host('dev')}/${encodeURIComponent(C.ORG)}/${encodeURIComponent(C.PROJECT)}/_apis`;

// Resuelve qué repositorio usar en cada llamada: el query param ?repo= que
// manda el selector del frontend, o si no viene (clientes viejos, o
// llamadas de servicios internos) el repo fijo por variable de entorno --
// así el cambio es retrocompatible con cualquier integración existente.
function resolverRepo(req) {
  const solicitado = (req.query.repo || '').trim();
  return solicitado || C.REPO;
}
function urlBaseRepo(repo) {
  return `${projectBaseUrl()}/git/repositories/${encodeURIComponent(repo)}`;
}

// Cachea (en memoria, por nombre de repo) la rama por defecto real de cada
// repositorio -- se resuelve una sola vez por repo porque rara vez cambia.
// Para el repo fijo de siempre (REPO) no hace falta ni pedirla: se asume
// AZURE_DEVOPS_BRANCH tal como estaba configurado antes de este cambio.
const cacheRamaPorDefecto = new Map();

async function obtenerRamaPorDefectoDeRepo(repo) {
  if (repo === C.REPO) return C.BRANCH;
  const claveCache = `${C.PROJECT}/${repo}`;
  if (cacheRamaPorDefecto.has(claveCache)) return cacheRamaPorDefecto.get(claveCache);

  try {
    const data = await llamarAzureDevOps(`${urlBaseRepo(repo)}?api-version=7.1`);
    const rama = (data.defaultBranch || '').replace('refs/heads/', '') || C.BRANCH;
    cacheRamaPorDefecto.set(claveCache, rama);
    return rama;
  } catch (error) {
    // Si no se pudo resolver (permisos, repo vacío sin ninguna rama aún,
    // etc.), se cae al valor configurado globalmente en vez de romper la
    // navegación -- en el peor caso, el usuario ve un 404 igual que antes.
    console.error(`No se pudo resolver la rama por defecto de "${repo}":`, error.message || error);
    return C.BRANCH;
  }
}

// Resuelve qué rama usar en una llamada dada: la que mande explícitamente
// el frontend (?rama=, ej. al navegar una rama distinta desde la pestaña
// Branches) o, si no viene, la rama por defecto REAL de ese repositorio.
async function resolverRama(req, repo) {
  const solicitada = (req.query.rama || '').trim();
  return solicitada || obtenerRamaPorDefectoDeRepo(repo);
}

// URLs "web" (para que el usuario pueda abrir el detalle completo en Azure
// DevOps) -- estas NO son endpoints de API, son las páginas normales del
// portal, así que se arman a mano (la API no siempre devuelve un link web
// directo, salvo builds).
const webBaseUrl = () => `https://dev.azure.com/${encodeURIComponent(C.ORG)}/${encodeURIComponent(C.PROJECT)}`;
function urlWebPullRequest(repo, id) {
  return `${webBaseUrl()}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`;
}
function urlWebBranch(repo, nombreRama) {
  return `${webBaseUrl()}/_git/${encodeURIComponent(repo)}?version=GB${encodeURIComponent(nombreRama)}`;
}
function urlWebBuild(id) {
  return `${webBaseUrl()}/_build/results?buildId=${id}`;
}
function urlWebWikiPagina(nombreWiki, wikiPath) {
  return `${webBaseUrl()}/_wiki/wikis/${encodeURIComponent(nombreWiki)}?pagePath=${encodeURIComponent(wikiPath)}`;
}

// --- Visor de contenido (GET /contenido) ---
// Límite de tamaño para no cargar un blob gigante entero en memoria del
// backend solo para "previsualizarlo" -- por encima de esto, mejor abrirlo
// directo en Azure DevOps.
const TAMANO_MAXIMO_PREVIEW_BYTES = 20 * 1024 * 1024; // 20 MB

// Content-Type por extensión: Azure DevOps con download=true no siempre
// manda un content-type útil para el navegador (a veces todo llega como
// application/octet-stream), así que se infiere acá para que el frontend
// pueda decidir cómo renderizar cada tipo de archivo sin adivinar por su
// cuenta.
const MIME_POR_EXTENSION = {
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.config': 'application/xml; charset=utf-8',
  '.csproj': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.scss': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.gitignore': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// Pequeño helper para llamar a la API REST de Azure DevOps y dar un mensaje
// de error entendible si el token falta, venció o no tiene permisos. Usa el token
// guardado que tenga permiso (ver C.fetchAutenticado).
async function llamarAzureDevOps(url, area = 'codigo') {
  const resp = await C.fetchAutenticado(url, { area, headers: { Accept: 'application/json' } });

  if (!resp.ok) {
    const cuerpo = await resp.text().catch(() => '');
    const err = new Error(
      `Azure DevOps respondió ${resp.status} ${resp.statusText}. ${cuerpo}`.trim()
    );
    err.status = resp.status;
    throw err;
  }

  return resp.json();
}

function manejarError(res, error, contexto) {
  console.error(`Error en ${contexto}:`, error);
  if (error.configuracionFaltante) {
    return res.status(500).json({ error: error.message });
  }
  if (error.status === 401 || error.status === 403) {
    return res.status(502).json({
      error: 'Azure DevOps rechazó las credenciales (token vencido, revocado o sin permisos de lectura sobre el repositorio).'
    });
  }
  if (error.status === 404) {
    return res.status(404).json({ error: 'No se encontró esa ruta en el repositorio de Azure DevOps.' });
  }
  return res.status(502).json({ error: 'No se pudo consultar Azure DevOps. Intenta de nuevo en un momento.' });
}

// Convierte un GitItem de Azure DevOps (con latestProcessedChange=true) al
// formato simple que consume el frontend.
function mapearItem(item, scopePath) {
  const nombreCompleto = item.path || '';
  // El "path" de Azure viene absoluto (ej. "/Servicios/C001 SecurityQuestionsMng");
  // nos quedamos solo con el último segmento como nombre visible.
  const partes = nombreCompleto.split('/').filter(Boolean);
  const nombre = partes[partes.length - 1] || nombreCompleto;

  // Cuando se pide la carpeta actual, Azure DevOps también devuelve un item
  // que ES la propia carpeta (path === scopePath): lo descartamos aquí.
  const esCarpetaActual = nombreCompleto.replace(/\/+$/, '') === (scopePath || '').replace(/\/+$/, '');

  const cambio = item.latestProcessedChange;

  return {
    esCarpetaActual,
    nombre,
    path: nombreCompleto,
    esCarpeta: !!item.isFolder,
    ultimoCambio: cambio?.author?.date || cambio?.committer?.date || null,
    commit: cambio
      ? {
          id: cambio.commitId,
          idCorto: (cambio.commitId || '').substring(0, 8),
          comentario: cambio.comment || '',
          autor: cambio.author?.name || cambio.committer?.name || 'Desconocido'
        }
      : null
  };
}

// GET /api/azure-repo/repositorios
// Lista todos los repositorios del proyecto de Azure DevOps -- alimenta el
// selector de repositorio del frontend. Antes el módulo solo podía navegar
// el repo fijo de AZURE_DEVOPS_REPO; con esto el usuario elige cualquiera.
router.get('/repositorios', async (req, res) => {
  const params = new URLSearchParams({ 'api-version': '7.1' });

  try {
    const data = await llamarAzureDevOps(`${projectBaseUrl()}/git/repositories?${params.toString()}`);
    const repositorios = (data.value || [])
      .map((r) => ({
        id: r.id,
        nombre: r.name,
        esPorDefecto: r.name === C.REPO,
        ramaPorDefecto: (r.defaultBranch || '').replace('refs/heads/', '') || null
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    // Un usuario con acceso restringido solo ve los repositorios que el ADMIN_POD le asignó.
    const acceso = req.accesoRepo;
    const visibles = acceso && !acceso.total ? repositorios.filter((r) => puedeVerRepo(acceso, r.nombre)) : repositorios;
    const porDefecto = visibles.some((r) => r.nombre === C.REPO) ? C.REPO : (visibles[0]?.nombre || '');
    res.json({ repositorioPorDefecto: porDefecto, repositorios: visibles.map((r) => ({ ...r, esPorDefecto: r.nombre === porDefecto })) });
  } catch (error) {
    manejarError(res, error, 'GET /azure-repo/repositorios');
  }
});

// GET /api/azure-repo/items?path=/Servicios&repo=OtroRepo
// Lista el contenido (un nivel) de una carpeta del repositorio, con el dato
// del último commit que tocó cada archivo/carpeta.
router.get('/items', async (req, res) => {
  const repo = resolverRepo(req);
  const scopePath = req.query.path && req.query.path !== '' ? req.query.path : '/';
  const rama = await resolverRama(req, repo);

  const params = new URLSearchParams({
    'api-version': '7.1',
    scopePath,
    recursionLevel: 'OneLevel',
    latestProcessedChange: 'true',
    'versionDescriptor.versionType': 'branch',
    'versionDescriptor.version': rama
  });

  try {
    const data = await llamarAzureDevOps(`${urlBaseRepo(repo)}/items?${params.toString()}`);
    const items = (data.value || [])
      .map((item) => mapearItem(item, scopePath))
      .filter((item) => !item.esCarpetaActual)
      // Carpetas primero, y alfabético dentro de cada grupo — igual que el
      // explorador de Azure Repos.
      .sort((a, b) => {
        if (a.esCarpeta !== b.esCarpeta) return a.esCarpeta ? -1 : 1;
        return a.nombre.localeCompare(b.nombre, 'es');
      });

    res.json({
      organizacion: C.ORG,
      proyecto: C.PROJECT,
      repositorio: repo,
      rama,
      path: scopePath,
      items
    });
  } catch (error) {
    manejarError(res, error, `GET /azure-repo/items (path=${scopePath})`);
  }
});

// GET /api/azure-repo/historial?path=/Servicios/C001 SecurityQuestionsMng
// Historial completo de commits que tocaron esa ruta (archivo o carpeta).
router.get('/historial', async (req, res) => {
  const repo = resolverRepo(req);
  const itemPath = req.query.path;
  if (!itemPath) {
    return res.status(400).json({ error: 'Falta el parámetro path.' });
  }
  const rama = await resolverRama(req, repo);

  const params = new URLSearchParams({
    'api-version': '7.1',
    'searchCriteria.itemPath': itemPath,
    'searchCriteria.itemVersion.versionType': 'branch',
    'searchCriteria.itemVersion.version': rama,
    '$top': '100'
  });

  try {
    const data = await llamarAzureDevOps(`${urlBaseRepo(repo)}/commits?${params.toString()}`);
    const commits = (data.value || []).map((c) => ({
      id: c.commitId,
      idCorto: (c.commitId || '').substring(0, 8),
      comentario: c.comment || '',
      autor: c.author?.name || 'Desconocido',
      fecha: c.author?.date || null,
      url: c.remoteUrl || null
    }));

    res.json({ path: itemPath, commits });
  } catch (error) {
    manejarError(res, error, `GET /azure-repo/historial (path=${itemPath})`);
  }
});

// GET /api/azure-repo/contenido?path=/Servicios/C001 Foo/archivo.xlsx&descargar=true
// Proxy autenticado del contenido crudo de un archivo del repositorio: el
// PAT de Azure DevOps nunca llega al frontend, solo pasa por acá. Sirve
// tanto para "ver" (Content-Disposition inline, lo que consume el visor de
// Repositorio) como para "descargar" (?descargar=true -> attachment).
router.get('/contenido', async (req, res) => {
  const repo = resolverRepo(req);
  const itemPath = req.query.path;
  if (!itemPath) {
    return res.status(400).json({ error: 'Falta el parámetro path.' });
  }
  const rama = await resolverRama(req, repo);
  const params = new URLSearchParams({
    'api-version': '7.1',
    path: itemPath,
    'versionDescriptor.versionType': 'branch',
    'versionDescriptor.version': rama,
    download: 'true'
  });

  try {
    const resp = await C.fetchAutenticado(`${urlBaseRepo(repo)}/items?${params.toString()}`, { area: 'codigo' });

    if (!resp.ok) {
      const cuerpo = await resp.text().catch(() => '');
      const err = new Error(`Azure DevOps respondió ${resp.status} ${resp.statusText}. ${cuerpo}`.trim());
      err.status = resp.status;
      throw err;
    }

    // Corta antes (por content-length, si Azure lo manda) y después (por si
    // no lo manda) de cargar el archivo entero en memoria si pesa más de lo
    // razonable para previsualizar en el navegador.
    const tamanoDeclarado = Number(resp.headers.get('content-length') || 0);
    if (tamanoDeclarado > TAMANO_MAXIMO_PREVIEW_BYTES) {
      return res.status(413).json({
        error: `Este archivo pesa ${(tamanoDeclarado / (1024 * 1024)).toFixed(1)} MB — demasiado grande para previsualizar aquí (límite ${TAMANO_MAXIMO_PREVIEW_BYTES / (1024 * 1024)} MB). Ábrelo directamente en Azure DevOps.`
      });
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > TAMANO_MAXIMO_PREVIEW_BYTES) {
      return res.status(413).json({
        error: `Este archivo pesa ${(buffer.length / (1024 * 1024)).toFixed(1)} MB — demasiado grande para previsualizar aquí (límite ${TAMANO_MAXIMO_PREVIEW_BYTES / (1024 * 1024)} MB). Ábrelo directamente en Azure DevOps.`
      });
    }

    const extension = path.extname(itemPath).toLowerCase();
    const contentType = MIME_POR_EXTENSION[extension] || 'application/octet-stream';
    const nombreArchivo = itemPath.split('/').filter(Boolean).pop() || 'archivo';
    const disposicion = req.query.descargar === 'true' ? 'attachment' : 'inline';

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `${disposicion}; filename="${encodeURIComponent(nombreArchivo)}"`);
    res.send(buffer);
  } catch (error) {
    manejarError(res, error, `GET /azure-repo/contenido (path=${itemPath})`);
  }
});

// ============================================================
// PULL REQUESTS
// ============================================================

// Estados válidos que acepta la API de Azure DevOps para
// searchCriteria.status -- cualquier otro valor recibido se normaliza a
// 'active' para no reenviar basura a la API.
const ESTADOS_PR_VALIDOS = ['active', 'completed', 'abandoned', 'all'];

function mapearPullRequest(pr, repo) {
  return {
    id: pr.pullRequestId,
    titulo: pr.title || '(sin título)',
    descripcion: pr.description || '',
    estado: pr.status, // active | completed | abandoned
    esBorrador: !!pr.isDraft,
    autor: pr.createdBy?.displayName || 'Desconocido',
    ramaOrigen: (pr.sourceRefName || '').replace('refs/heads/', ''),
    ramaDestino: (pr.targetRefName || '').replace('refs/heads/', ''),
    creado: pr.creationDate || null,
    cerrado: pr.closedDate || null,
    url: urlWebPullRequest(repo, pr.pullRequestId)
  };
}

// GET /api/azure-repo/pull-requests?estado=active
// Lista de pull requests del repositorio, filtrable por estado.
router.get('/pull-requests', async (req, res) => {
  const repo = resolverRepo(req);
  const estadoSolicitado = String(req.query.estado || 'active');
  const estado = ESTADOS_PR_VALIDOS.includes(estadoSolicitado) ? estadoSolicitado : 'active';

  const params = new URLSearchParams({
    'api-version': '7.1',
    'searchCriteria.status': estado,
    '$top': '100'
  });

  try {
    const data = await llamarAzureDevOps(`${urlBaseRepo(repo)}/pullrequests?${params.toString()}`);
    const pullRequests = (data.value || [])
      .map((pr) => mapearPullRequest(pr, repo))
      // Más recientes primero.
      .sort((a, b) => new Date(b.creado || 0).getTime() - new Date(a.creado || 0).getTime());

    res.json({ estado, pullRequests });
  } catch (error) {
    manejarError(res, error, `GET /azure-repo/pull-requests (estado=${estado})`);
  }
});

// ============================================================
// BRANCHES (RAMAS)
// ============================================================

// GET /api/azure-repo/branches
// Lista de ramas del repositorio con su último commit -- usa /stats/branches
// porque ya trae el commit más reciente de cada una en una sola llamada.
router.get('/branches', async (req, res) => {
  const repo = resolverRepo(req);
  const params = new URLSearchParams({ 'api-version': '7.1' });

  try {
    const ramaPorDefecto = await obtenerRamaPorDefectoDeRepo(repo);
    const data = await llamarAzureDevOps(`${urlBaseRepo(repo)}/stats/branches?${params.toString()}`);
    const ramas = (data.value || [])
      .map((b) => ({
        nombre: b.name,
        esRamaPorDefecto: b.name === ramaPorDefecto,
        aheadCount: b.aheadCount ?? null,
        behindCount: b.behindCount ?? null,
        commit: b.commit
          ? {
              id: b.commit.commitId,
              idCorto: (b.commit.commitId || '').substring(0, 8),
              comentario: b.commit.comment || '',
              autor: b.commit.author?.name || b.commit.committer?.name || 'Desconocido',
              fecha: b.commit.author?.date || b.commit.committer?.date || null
            }
          : null,
        url: urlWebBranch(repo, b.name)
      }))
      // La rama por defecto primero, luego alfabético.
      .sort((a, b2) => {
        if (a.esRamaPorDefecto !== b2.esRamaPorDefecto) return a.esRamaPorDefecto ? -1 : 1;
        return a.nombre.localeCompare(b2.nombre, 'es');
      });

    res.json({ ramaPorDefecto, ramas });
  } catch (error) {
    manejarError(res, error, 'GET /azure-repo/branches');
  }
});

// ============================================================
// WIKI
// ============================================================

// El identificador del wiki del proyecto se resuelve una sola vez y se
// cachea en memoria (rara vez cambia) para no tener que pedir la lista de
// wikis en cada llamada de navegación/contenido.
let wikiInfoCache = null;

async function obtenerWikiDelProyecto() {
  if (wikiInfoCache) return wikiInfoCache;

  const data = await llamarAzureDevOps(`${projectBaseUrl()}/wiki/wikis?api-version=7.1`, 'wiki');
  const wiki = (data.value || [])[0];
  if (!wiki) {
    const err = new Error('Este proyecto no tiene un Wiki configurado en Azure DevOps.');
    err.sinWiki = true;
    throw err;
  }
  wikiInfoCache = { id: wiki.id, nombre: wiki.name };
  return wikiInfoCache;
}

// Aplana el árbol que devuelve Azure (cada página trae subPages anidadas) a
// una lista plana con "nivel" -- más simple de recorrer en la plantilla que
// un árbol recursivo real.
function aplanarArbolWiki(pagina, nivel, acumulador) {
  if (!pagina) return acumulador;
  const path = pagina.path || '/';
  if (path !== '/' || nivel > 0) {
    const partes = path.split('/').filter(Boolean);
    acumulador.push({
      path,
      nombre: partes[partes.length - 1] || path,
      nivel,
      tieneHijas: !!(pagina.subPages && pagina.subPages.length)
    });
  }
  (pagina.subPages || []).forEach((sub) => aplanarArbolWiki(sub, path === '/' && nivel === 0 ? 0 : nivel + 1, acumulador));
  return acumulador;
}

// GET /api/azure-repo/wiki/estructura
// Árbol completo de páginas del wiki del proyecto (aplanado, con nivel de
// anidamiento) -- de solo lectura, igual que el resto del módulo.
router.get('/wiki/estructura', async (req, res) => {
  try {
    const wiki = await obtenerWikiDelProyecto();
    const params = new URLSearchParams({ 'api-version': '7.1', path: '/', recursionLevel: 'full' });
    const data = await llamarAzureDevOps(
      `${projectBaseUrl()}/wiki/wikis/${encodeURIComponent(wiki.id)}/pages?${params.toString()}`,
      'wiki'
    );
    const paginas = aplanarArbolWiki(data, 0, []);
    res.json({ wiki: wiki.nombre, paginas });
  } catch (error) {
    if (error.sinWiki) {
      return res.status(404).json({ error: error.message });
    }
    manejarError(res, error, 'GET /azure-repo/wiki/estructura');
  }
});

// GET /api/azure-repo/wiki/contenido?path=/Home
// Contenido en markdown de una página puntual del wiki.
router.get('/wiki/contenido', async (req, res) => {
  const wikiPath = req.query.path || '/';

  try {
    const wiki = await obtenerWikiDelProyecto();
    const params = new URLSearchParams({ 'api-version': '7.1', path: wikiPath, includeContent: 'true' });
    const data = await llamarAzureDevOps(
      `${projectBaseUrl()}/wiki/wikis/${encodeURIComponent(wiki.id)}/pages?${params.toString()}`,
      'wiki'
    );
    res.json({
      path: wikiPath,
      titulo: (wikiPath.split('/').filter(Boolean).pop() || wiki.nombre),
      contenido: data.content || '',
      url: urlWebWikiPagina(wiki.nombre, wikiPath)
    });
  } catch (error) {
    if (error.sinWiki) {
      return res.status(404).json({ error: error.message });
    }
    manejarError(res, error, `GET /azure-repo/wiki/contenido (path=${wikiPath})`);
  }
});

// ============================================================
// PIPELINES (BUILDS)
// ============================================================

function mapearBuild(b) {
  return {
    id: b.id,
    numero: b.buildNumber || String(b.id),
    definicion: b.definition?.name || '(sin nombre)',
    estado: b.status || null, // notStarted | inProgress | completed
    resultado: b.result || null, // succeeded | partiallySucceeded | failed | canceled
    solicitadoPor: b.requestedFor?.displayName || b.requestedBy?.displayName || 'Desconocido',
    rama: (b.sourceBranch || '').replace('refs/heads/', ''),
    encolado: b.queueTime || null,
    inicio: b.startTime || null,
    fin: b.finishTime || null,
    url: b._links?.web?.href || urlWebBuild(b.id)
  };
}

// GET /api/azure-repo/pipelines
// Historial reciente de builds/pipelines del proyecto.
router.get('/pipelines', async (req, res) => {
  const params = new URLSearchParams({ 'api-version': '7.1', '$top': '30' });

  try {
    const data = await llamarAzureDevOps(`${projectBaseUrl()}/build/builds?${params.toString()}`, 'builds');
    const builds = (data.value || [])
      .map(mapearBuild)
      .sort((a, b) => new Date(b.encolado || 0).getTime() - new Date(a.encolado || 0).getTime());

    res.json({ builds });
  } catch (error) {
    manejarError(res, error, 'GET /azure-repo/pipelines');
  }
});

// Funciones avanzadas de solo lectura (commits, PRs, ramas, pipelines, releases, boards, equipo...)
router.use('/', require('./azureAvanzado'));
router.use('/', require('./azureProcesos'));
router.use('/', require('./azureAccesos'));
router.use('/', require('./azureConexion'));

module.exports = router;
