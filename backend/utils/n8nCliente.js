// Cliente de la API pública de n8n (por cuenta/API key): paginación, caché
// corto y manejo de errores. Lo usan las rutas del módulo y el Asistente IA.
//
// n8n entrega máximo 250 elementos por página (y 100 por defecto), con un
// "nextCursor" para seguir. Antes solo se leía la primera página, así que con
// más de 100 flujos o 250 ejecuciones el módulo se quedaba corto.

const N8N_URL = process.env.N8N_URL || 'https://10.254.55.157:5678/api/v1';

const POR_PAGINA = 250;
const MAX_FLUJOS = 2000;
const MAX_EJECUCIONES = 8000;      // por cuenta y consulta
const PRESUPUESTO_MS = 60000;      // tiempo máximo paginando una cuenta
const TTL_CACHE_MS = 45000;

const headersDe = (apiKey) => ({
  'X-N8N-API-KEY': apiKey,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
});

async function fetchN8n(cuenta, ruta, opciones = {}) {
  const { timeout, ...resto } = opciones;
  return fetch(`${N8N_URL}${ruta}`, { ...resto, headers: headersDe(cuenta.apiKey), signal: AbortSignal.timeout(timeout || 20000) });
}

function mensajeErrorN8n(err, status) {
  if (status === 401 || status === 403) return 'n8n rechazó la API key (inválida, vencida o sin permisos).';
  if (status) return `n8n respondió con error ${status}.`;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'n8n no respondió a tiempo.';
  return 'No se pudo conectar con n8n.';
}

// Pagina un listado de n8n. `hastaMs` (opcional): deja de pedir páginas cuando
// la más antigua ya quedó fuera del rango (las ejecuciones vienen de la más
// reciente a la más antigua). Devuelve { items, truncado }.
async function paginar(cuenta, ruta, { max, hastaMs = null, campoFecha = 'startedAt', inicio = Date.now() } = {}) {
  const items = [];
  let cursor = null;
  let truncado = false;
  const sep = ruta.includes('?') ? '&' : '?';
  for (;;) {
    if (Date.now() - inicio > PRESUPUESTO_MS) { truncado = true; break; }
    const url = `${ruta}${sep}limit=${POR_PAGINA}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetchN8n(cuenta, url);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const cuerpo = await res.json();
    const pagina = cuerpo.data || [];
    items.push(...pagina);
    cursor = cuerpo.nextCursor || null;
    if (!cursor || !pagina.length) break;
    if (items.length >= max) { truncado = true; break; }
    if (hastaMs !== null) {
      const ultima = pagina[pagina.length - 1];
      const t = Date.parse(ultima?.[campoFecha] || '');
      if (!Number.isNaN(t) && t < hastaMs) break; // ya llegamos al inicio del periodo
    }
  }
  return { items, truncado };
}

const cache = new Map();
const invalidarCache = () => cache.clear();

// Flujos y ejecuciones de UNA cuenta para un periodo de `dias`. Una cuenta que
// falla NO tumba al resto: devuelve { error }.
async function recolectarCuenta(cuenta, dias) {
  const clave = `${cuenta.id}|${String(cuenta.apiKey).slice(-8)}|${dias}`;
  const guardada = cache.get(clave);
  if (guardada && Date.now() - guardada.t < TTL_CACHE_MS) return { ...guardada.datos, cuenta };

  const inicio = Date.now();
  const desdeMs = inicio - dias * 86400000;
  let datos;
  try {
    const flujos = await paginar(cuenta, '/workflows', { max: MAX_FLUJOS, inicio });
    let ejecuciones = [];
    let truncado = false;
    let avisoEjecuciones = null;
    try {
      const r = await paginar(cuenta, '/executions', { max: MAX_EJECUCIONES, hastaMs: desdeMs, inicio });
      ejecuciones = r.items;
      truncado = r.truncado;
    } catch (err) {
      avisoEjecuciones = `No se pudieron leer las ejecuciones (${mensajeErrorN8n(err, err.status)})`;
    }
    datos = { workflows: flujos.items, ejecuciones, truncado: truncado || flujos.truncado, avisoEjecuciones, error: null };
  } catch (err) {
    console.error(`Error consultando n8n (cuenta ${cuenta.nombre}):`, err.message);
    datos = { workflows: [], ejecuciones: [], truncado: false, avisoEjecuciones: null, error: mensajeErrorN8n(err, err.status) };
  }
  if (!datos.error) cache.set(clave, { t: Date.now(), datos });
  if (cache.size > 60) cache.clear();
  return { ...datos, cuenta };
}

// Detalle de un flujo (nodos, etiquetas, ajustes) con la key de su cuenta.
async function obtenerFlujo(cuenta, id) {
  const res = await fetchN8n(cuenta, `/workflows/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

// Una ejecución con sus datos (para leer el error). Pesado: solo bajo demanda.
async function obtenerEjecucionConDatos(cuenta, id) {
  try {
    const res = await fetchN8n(cuenta, `/executions/${encodeURIComponent(id)}?includeData=true`, { timeout: 25000 });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

module.exports = {
  N8N_URL, fetchN8n, mensajeErrorN8n, recolectarCuenta, invalidarCache, obtenerFlujo, obtenerEjecucionConDatos,
};
