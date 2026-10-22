// Cliente de solo lectura para la API REST de Azure DevOps.
//
// Qué resuelve respecto a llamar fetch() a mano en cada ruta:
//  - Un único lugar con organización/proyecto/PAT (variables de entorno).
//  - Timeout, reintentos (429/5xx) y límite de llamadas simultáneas, para no
//    saturar la cuota de Azure DevOps cuando una pantalla pide varias cosas.
//  - Caché corta en memoria (los mismos datos no se piden dos veces en 1-2 min).
//  - Errores con "área": si el PAT no tiene un permiso (p. ej. Work Items), esa
//    sección lo dice claramente y el resto del módulo sigue funcionando.
//  - Azure responde 203 + HTML de inicio de sesión cuando el PAT no alcanza: se
//    detecta y se trata como falta de permiso (no como "JSON inválido").
//
// El PAT nunca sale del backend ni se incluye en mensajes de error.

const { ocultarSecretos } = require('./ocultarSecretos');

// Organización/proyecto/repo/rama y tokens: se administran desde la app (ADMIN_POD) y se guardan en la BD;
// el .env queda como valor por defecto. Ver utils/azureConfig.js.
const CFG = require('./azureConfig');
const ORG = () => CFG.cfg().org;
const PROJECT = () => CFG.cfg().project;
const REPO = () => CFG.cfg().repo;
const BRANCH = () => CFG.cfg().branch;
const API = '7.1';

// Solo para pruebas / proxys internos: si está definida, todos los servicios de
// Azure (dev, vsrm, feeds, almsearch, vssps) se piden a ESA dirección bajo
// /<servicio>/... En producción no se define y se usan los hosts reales.
const BASE_ALTERNA = (process.env.AZURE_DEVOPS_BASE_URL || '').replace(/\/+$/, '');

function host(servicio) {
  if (BASE_ALTERNA) return `${BASE_ALTERNA}/${servicio}`;
  return servicio === 'dev' ? 'https://dev.azure.com' : `https://${servicio}.dev.azure.com`;
}

const enc = encodeURIComponent;

// Permiso del PAT que hace falta para cada área (texto para el administrador).
const PERMISOS_POR_AREA = {
  codigo: 'Code (Read)',
  builds: 'Build (Read)',
  releases: 'Release (Read)',
  workitems: 'Work Items (Read)',
  proyecto: 'Project and Team (Read)',
  pruebas: 'Test Management (Read)',
  paquetes: 'Packaging (Read)',
  conexiones: 'Service Connections (Read)',
  variables: 'Variable Groups (Read)',
  agentes: 'Agent Pools (Read)',
  ambientes: 'Environment (Read)',
  politicas: 'Code (Read)',
  busqueda: 'Code (Read) y la extensión Code Search habilitada en la organización',
  wiki: 'Wiki (Read)',
};

class AzureError extends Error {
  constructor(mensaje, { status = 502, area = null, codigo = 'AZURE', detalle = null } = {}) {
    super(mensaje);
    this.name = 'AzureError';
    this.status = status;
    this.area = area;
    this.codigo = codigo;
    this.detalle = detalle;
  }
}

function cabeceraAuth(valorToken) {
  // Azure DevOps usa Basic Auth con usuario vacío y el PAT como contraseña.
  return `Basic ${Buffer.from(`:${valorToken}`).toString('base64')}`;
}

function errorSinConfigurar() {
  const e = new AzureError('Falta configurar el token (PAT) de Azure DevOps. Un administrador (ADMIN_POD) puede agregarlo en Repositorio → Conexión.', { status: 500, codigo: 'SIN_CONFIGURAR' });
  e.configuracionFaltante = true;
  return e;
}

// --- URLs ---------------------------------------------------------------------

const urlProyecto = (ruta = '') => `${host('dev')}/${enc(ORG())}/${enc(PROJECT())}/_apis${ruta}`;
const urlOrg = (ruta = '') => `${host('dev')}/${enc(ORG())}/_apis${ruta}`;
const urlRepo = (repo, ruta = '') => urlProyecto(`/git/repositories/${enc(repo)}${ruta}`);
const urlVsrm = (ruta = '') => `${host('vsrm')}/${enc(ORG())}/${enc(PROJECT())}/_apis${ruta}`;
const urlFeeds = (ruta = '', conProyecto = true) => `${host('feeds')}/${enc(ORG())}/${conProyecto ? `${enc(PROJECT())}/` : ''}_apis${ruta}`;
const urlBusqueda = (ruta = '') => `${host('almsearch')}/${enc(ORG())}/${enc(PROJECT())}/_apis${ruta}`;
const urlVssps = (ruta = '') => `${host('vssps')}/${enc(ORG())}/_apis${ruta}`;

// Páginas "web" del portal (para el enlace "Ver en Azure DevOps")
const webBase = () => `https://dev.azure.com/${enc(ORG())}/${enc(PROJECT())}`;
const web = {
  get base() { return webBase(); },
  commit: (repo, id) => `${webBase()}/_git/${enc(repo)}/commit/${id}`,
  pr: (repo, id) => `${webBase()}/_git/${enc(repo)}/pullrequest/${id}`,
  rama: (repo, rama) => `${webBase()}/_git/${enc(repo)}?version=GB${enc(rama)}`,
  tag: (repo, tag) => `${webBase()}/_git/${enc(repo)}?version=GT${enc(tag)}`,
  archivo: (repo, ruta, rama) => `${webBase()}/_git/${enc(repo)}?path=${enc(ruta)}&version=GB${enc(rama)}`,
  build: (id) => `${webBase()}/_build/results?buildId=${id}`,
  definicion: (id) => `${webBase()}/_build?definitionId=${id}`,
  release: (id) => `${webBase()}/_releaseProgress?releaseId=${id}`,
  workItem: (id) => `${webBase()}/_workitems/edit/${id}`,
  sprint: (teamNombre, ruta) => `${webBase()}/_sprints/taskboard/${enc(teamNombre)}/${ruta.split('\\').map(enc).join('/')}`,
};

// --- Concurrencia y caché -------------------------------------------------------

const MAX_SIMULTANEAS = 6;
let enCurso = 0;
const cola = [];
function adquirir() {
  if (enCurso < MAX_SIMULTANEAS) { enCurso++; return Promise.resolve(); }
  return new Promise((ok) => cola.push(ok));
}
function liberar() {
  const sig = cola.shift();
  if (sig) sig(); else enCurso--;
}

const cache = new Map();   // clave -> { vence, valor }
const pendientes = new Map(); // clave -> Promise (evita pedir lo mismo dos veces a la vez)
const MAX_CACHE = 400;

function invalidarCache() { cache.clear(); cacheRamaPorDefecto.clear(); }

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Llamada base ---------------------------------------------------------------

// Un intento HTTP completo (incluida la lectura del cuerpo) dentro de un cupo de
// concurrencia. Devuelve { status, headers, buffer }.
async function intentoUnico(url, init, timeoutMs) {
  await adquirir();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' });
    const buffer = Buffer.from(await resp.arrayBuffer());
    return { status: resp.status, headers: resp.headers, buffer };
  } finally {
    clearTimeout(t);
    liberar();
  }
}

function errorDeEstado(resp, area) {
  const { status } = resp;
  const tipo = String(resp.headers.get('content-type') || '');
  if (status === 203 || (status >= 300 && status < 400)) {
    return new AzureError('Azure DevOps pidió iniciar sesión: el token (PAT) no tiene permiso para esta sección.', { status: 403, area, codigo: 'SIN_PERMISO' });
  }
  if (status === 401 || status === 403) {
    return new AzureError('Azure DevOps rechazó las credenciales para esta sección.', { status: 403, area, codigo: 'SIN_PERMISO' });
  }
  if (status === 404) return new AzureError('No se encontró el recurso en Azure DevOps.', { status: 404, area, codigo: 'NO_ENCONTRADO' });
  if (status === 429) return new AzureError('Azure DevOps limitó las consultas (demasiadas peticiones). Intenta en unos segundos.', { status: 429, area, codigo: 'LIMITE' });
  if (status >= 500) return new AzureError(`Azure DevOps respondió ${status}.`, { status: 502, area, codigo: 'AZURE', detalle: '5xx' });
  if (status >= 400) {
    const cuerpo = ocultarSecretos(resp.buffer.toString('utf8')).slice(0, 300);
    let mensaje = cuerpo;
    if (tipo.includes('json')) { try { mensaje = JSON.parse(cuerpo).message || cuerpo; } catch { /* texto plano */ } }
    return new AzureError(`Azure DevOps respondió ${status}: ${mensaje}`.trim(), { status: status === 400 ? 400 : 502, area, codigo: status === 400 ? 'PETICION' : 'AZURE' });
  }
  return null;
}

// opciones: { method, body, area, accept ('json'|'texto'|'buffer'), timeoutMs, cacheMs, conCabeceras, reintentos, maxBytes }
function llamar(url, opciones = {}) {
  const {
    method = 'GET', body = undefined, area = null, accept = 'json', timeoutMs = 25000, cacheMs = 0,
    conCabeceras = false, reintentos = 2, maxBytes = null,
  } = opciones;

  const clave = cacheMs ? `${method} ${url} ${body !== undefined ? JSON.stringify(body) : ''} ${accept} ${conCabeceras}` : null;
  if (clave) {
    const c = cache.get(clave);
    if (c && c.vence > Date.now()) return Promise.resolve(c.valor);
    if (pendientes.has(clave)) return pendientes.get(clave);
  }

  const ejecutarConToken = async (tokenValor) => {
    const init = {
      method,
      headers: {
        Authorization: cabeceraAuth(tokenValor),
        Accept: accept === 'json' ? 'application/json' : (accept === 'texto' ? 'text/plain' : '*/*'),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    let ultimo = null;
    for (let intento = 0; intento <= reintentos; intento++) {
      let resp;
      try {
        resp = await intentoUnico(url, init, timeoutMs);
      } catch (err) {
        ultimo = new AzureError(err.name === 'AbortError' ? 'Azure DevOps tardó demasiado en responder.' : 'No se pudo conectar con Azure DevOps.', { status: 504, area, codigo: 'RED' });
        if (intento < reintentos) { await espera(400 * (intento + 1)); continue; }
        throw ultimo;
      }

      const tipo = String(resp.headers.get('content-type') || '');
      const falla = errorDeEstado(resp, area) || (accept === 'json' && tipo.includes('text/html')
        ? new AzureError('Azure DevOps pidió iniciar sesión: el token (PAT) no tiene permiso para esta sección.', { status: 403, area, codigo: 'SIN_PERMISO' })
        : null);
      if (falla) {
        if ((falla.codigo === 'LIMITE' || falla.detalle === '5xx') && intento < reintentos) {
          ultimo = falla;
          const retry = Math.min(5000, (parseInt(resp.headers.get('retry-after'), 10) || intento + 1) * 1000);
          await espera(retry);
          continue;
        }
        throw falla;
      }

      let valor;
      if (accept === 'json') {
        const texto = resp.buffer.toString('utf8');
        try { valor = texto ? JSON.parse(texto) : {}; } catch { throw new AzureError('Azure DevOps devolvió una respuesta que no es JSON.', { status: 502, area, codigo: 'AZURE' }); }
      } else if (accept === 'texto') {
        valor = resp.buffer.toString('utf8');
      } else {
        if (maxBytes && resp.buffer.length > maxBytes) throw new AzureError('El archivo es demasiado grande.', { status: 413, area, codigo: 'GRANDE' });
        valor = resp.buffer;
      }
      if (conCabeceras) valor = { datos: valor, continuacion: resp.headers.get('x-ms-continuationtoken') || null };
      return valor;
    }
    throw ultimo || new AzureError('No se pudo consultar Azure DevOps.', { area });
  };

  // Usa el token que sí tenga permiso para el área: prueba los guardados en orden y pasa al
  // siguiente cuando Azure responde «sin permiso». `opciones.token` fuerza uno (pruebas).
  const ejecutar = async () => {
    await CFG.asegurar();
    if (opciones.token) return ejecutarConToken(opciones.token.valor);
    const areaClave = area || 'general';
    const { hayTokens, candidatos } = CFG.candidatos(areaClave);
    if (!hayTokens) throw errorSinConfigurar();
    let ultimo = null;
    for (const t of candidatos) {
      try {
        const v = await ejecutarConToken(t.valor);
        CFG.marcar(t.id, areaClave, true);
        return v;
      } catch (err) {
        if (err && err.codigo === 'SIN_PERMISO') { CFG.marcar(t.id, areaClave, false); ultimo = err; continue; }
        throw err;
      }
    }
    throw ultimo || new AzureError('Ningún token guardado tiene permiso para esta sección.', { status: 403, area, codigo: 'SIN_PERMISO' });
  };

  const promesa = ejecutar();
  if (clave) {
    pendientes.set(clave, promesa);
    promesa.then((valor) => {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(clave, { vence: Date.now() + cacheMs, valor });
    }).catch(() => {}).finally(() => pendientes.delete(clave));
  }
  return promesa;
}

// GET JSON con parámetros (los vacíos se omiten). Atajo más usado.
function obtener(url, params = {}, opciones = {}) {
  const q = new URLSearchParams({ 'api-version': opciones.apiVersion || API });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return llamar(`${url}${url.includes('?') ? '&' : '?'}${q.toString()}`, { cacheMs: 60000, ...opciones });
}

// Ejecuta tareas con un máximo de N en paralelo (además del límite global).
async function mapLimit(lista, limite, fn) {
  const resultados = new Array(lista.length);
  let i = 0;
  const trabajadores = Array.from({ length: Math.min(limite, lista.length) }, async () => {
    while (i < lista.length) {
      const idx = i++;
      resultados[idx] = await fn(lista[idx], idx);
    }
  });
  await Promise.all(trabajadores);
  return resultados;
}

// Ejecuta una consulta y, si falla, devuelve { error } en vez de lanzar: así una
// pantalla con varias secciones muestra las que sí funcionan.
async function seccion(promesaFn) {
  try { return { datos: await promesaFn() }; } catch (err) {
    if (err.configuracionFaltante) throw err;
    return { error: mensajePublico(err), codigo: err.codigo || 'AZURE', area: err.area || null, permisoRequerido: err.area ? PERMISOS_POR_AREA[err.area] || null : null };
  }
}

function mensajePublico(err) {
  if (err instanceof AzureError) return err.message;
  return 'No se pudo consultar Azure DevOps.';
}

// Respuesta HTTP uniforme para errores de Azure en las rutas.
function responderError(res, err, contexto) {
  if (!(err instanceof AzureError) || err.codigo === 'AZURE' || err.codigo === 'RED') console.error(`Azure DevOps (${contexto}):`, err.message);
  if (err.configuracionFaltante) return res.status(500).json({ error: err.message, codigo: 'SIN_CONFIGURAR' });
  if (err.codigo === 'SIN_PERMISO') {
    const permiso = err.area ? PERMISOS_POR_AREA[err.area] : null;
    return res.status(403).json({
      error: permiso ? `Ningún token de Azure DevOps guardado tiene permiso para esta sección. Hace falta: ${permiso}. Un administrador puede agregar otro token en Conexión.` : err.message,
      codigo: 'SIN_PERMISO', area: err.area, permisoRequerido: permiso,
    });
  }
  if (err.codigo === 'NO_ENCONTRADO') return res.status(404).json({ error: err.message, codigo: 'NO_ENCONTRADO' });
  if (err.codigo === 'PETICION') return res.status(400).json({ error: err.message, codigo: 'PETICION' });
  if (err.codigo === 'GRANDE') return res.status(413).json({ error: err.message, codigo: 'GRANDE' });
  if (err.codigo === 'LIMITE') return res.status(429).json({ error: err.message, codigo: 'LIMITE' });
  return res.status(502).json({ error: err instanceof AzureError ? err.message : 'No se pudo consultar Azure DevOps. Intenta de nuevo en un momento.', codigo: err.codigo || 'AZURE' });
}

// --- Repositorio y rama por defecto ------------------------------------------------

const cacheRamaPorDefecto = new Map();

async function ramaPorDefectoDe(repo) {
  if (repo === REPO()) return BRANCH();
  if (cacheRamaPorDefecto.has(repo)) return cacheRamaPorDefecto.get(repo);
  try {
    const d = await obtener(urlRepo(repo), {}, { area: 'codigo' });
    const rama = (d.defaultBranch || '').replace('refs/heads/', '') || BRANCH();
    cacheRamaPorDefecto.set(repo, rama);
    return rama;
  } catch {
    return BRANCH();
  }
}

const REPO_VALIDO = /^[\w .()\-]{1,120}$/;
const RAMA_VALIDA = /^[\w./()#+@\- ]{1,250}$/;

function repoDe(req) {
  const r = String(req.query.repo || '').trim();
  if (!r) return REPO();
  if (!REPO_VALIDO.test(r)) throw new AzureError('Nombre de repositorio no válido.', { status: 400, codigo: 'PETICION' });
  return r;
}

async function ramaDe(req, repo) {
  const r = String(req.query.rama || '').trim();
  if (!r) return ramaPorDefectoDe(repo);
  if (!RAMA_VALIDA.test(r) || r.includes('..')) throw new AzureError('Nombre de rama no válido.', { status: 400, codigo: 'PETICION' });
  return r;
}

// Validaciones de entradas que se insertan en URLs o consultas
const esEntero = (v) => /^\d{1,12}$/.test(String(v));
const esSha = (v) => /^[0-9a-fA-F]{6,40}$/.test(String(v));
const esGuid = (v) => /^[0-9a-fA-F-]{8,40}$/.test(String(v));
function enteroEntre(v, min, max, porDefecto) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, n));
}
function fechaIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const esAdminPod = (req) => req.user?.rol === 'ADMIN_POD';

// Para código antiguo que usa fetch() directo: hace la petición con el token que tenga permiso.
// Devuelve la Response de Azure (o lanza si no hay tokens / ninguno tiene permiso).
async function fetchAutenticado(url, { area = 'codigo', headers = {} } = {}) {
  await CFG.asegurar();
  const { hayTokens, candidatos } = CFG.candidatos(area);
  if (!hayTokens) throw errorSinConfigurar();
  let ultima = null;
  for (const t of candidatos) {
    const resp = await fetch(url, { headers: { ...headers, Authorization: cabeceraAuth(t.valor) }, redirect: 'manual' });
    if (resp.status === 401 || resp.status === 403 || resp.status === 203 || (resp.status >= 300 && resp.status < 400)) {
      CFG.marcar(t.id, area, false);
      ultima = resp;
      continue;
    }
    CFG.marcar(t.id, area, true);
    return resp;
  }
  const e = new Error('Azure DevOps rechazó las credenciales de todos los tokens guardados para esta sección.');
  e.status = ultima && ultima.status === 401 ? 401 : 403;
  throw e;
}

// Middleware: deja lista la configuración vigente (síncrona) antes de atender la petición.
function middlewareConfig(req, res, next) {
  CFG.asegurar().then(() => next(), next);
}

module.exports = {
  API, PERMISOS_POR_AREA, AzureError, fetchAutenticado, middlewareConfig,
  urlProyecto, urlOrg, urlRepo, urlVsrm, urlFeeds, urlBusqueda, urlVssps, web, host,
  llamar, obtener, mapLimit, seccion, responderError, mensajePublico, invalidarCache,
  ramaPorDefectoDe, repoDe, ramaDe, esEntero, esSha, esGuid, enteroEntre, fechaIso, esAdminPod, enc,
};

// ORG/PROJECT/REPO/BRANCH se leen siempre de la configuración vigente (C.ORG, C.PROJECT, ...).
for (const [nombre, fn] of [['ORG', ORG], ['PROJECT', PROJECT], ['REPO', REPO], ['BRANCH', BRANCH]]) {
  Object.defineProperty(module.exports, nombre, { get: fn, enumerable: true });
}
