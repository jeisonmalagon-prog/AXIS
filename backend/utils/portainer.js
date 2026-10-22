const https = require('https');
const { URL } = require('url');

// ==========================================
// CONFIGURACIÓN PORTAINER (un solo Portainer central, con un "environment"
// por servidor Docker — igual que se ve en su interfaz)
// ==========================================
// Configura en tu .env:
//   PORTAINER_URL=https://192.168.125.105:9443
//   PORTAINER_USER=usuario_con_acceso_de_lectura
//   PORTAINER_PASS=...
//   PORTAINER_TLS_INSECURE=true   (solo si usa certificado autofirmado, como
//                                  se ve en la captura de "Not secure")
//
// Si estas variables no están, o Portainer no tiene un environment cuyo
// nombre coincida con el hostname de un servidor, ese servidor simplemente
// sigue mostrando su sección de Docker por SSH (ver monitoreo.js) — nunca se
// rompe nada por no tener Portainer configurado.
const PORTAINER_URL = process.env.PORTAINER_URL;
const PORTAINER_USER = process.env.PORTAINER_USER;
const PORTAINER_PASS = process.env.PORTAINER_PASS;
// Por defecto SÍ se valida el certificado TLS; hay que pedir explícitamente
// lo contrario (común en paneles de gestión internos con certificado
// autofirmado).
const VALIDAR_TLS = process.env.PORTAINER_TLS_INSECURE !== 'true';

const PORTAINER_CONFIGURADO = !!(PORTAINER_URL && PORTAINER_USER && PORTAINER_PASS);

if (!PORTAINER_CONFIGURADO) {
  console.warn(
    '⚠️  PORTAINER_URL/PORTAINER_USER/PORTAINER_PASS no están configurados en el .env — ' +
    'el monitoreo de contenedores seguirá funcionando solo por SSH, sin el detalle extra de Portainer.'
  );
}

// ==========================================
// CLIENTE HTTP MÍNIMO HACIA PORTAINER (mismo patrón que peticionF5 en
// f5Monitoreo.js: https.request directo, para controlar rejectUnauthorized
// por si el certificado es autofirmado)
// ==========================================
// "raw: true" devuelve el Buffer crudo de la respuesta en vez de intentar
// parsearlo como JSON — lo necesitan los logs de un contenedor, que Docker
// entrega como texto (a veces con un pequeño encabezado binario por línea,
// ver limpiarLogsDocker más abajo), no como JSON.
function peticionPortainer(path, { method = 'GET', token, body, raw = false, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(path, PORTAINER_URL);
    } catch (e) {
      return reject(new Error(`PORTAINER_URL mal configurado: ${PORTAINER_URL}`));
    }

    const datosBody = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (datosBody) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(datosBody);
    }

    const opciones = {
      method,
      headers,
      rejectUnauthorized: VALIDAR_TLS,
      timeout: timeoutMs,
    };

    const req = https.request(url, opciones, (res) => {
      const trozos = [];
      res.on('data', (chunk) => { trozos.push(chunk); });
      res.on('end', () => {
        const buffer = Buffer.concat(trozos);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`Portainer respondió ${res.statusCode}. ${buffer.toString('utf8')}`.slice(0, 400));
          err.status = res.statusCode;
          return reject(err);
        }
        if (raw) return resolve(buffer);
        const texto = buffer.toString('utf8');
        try {
          resolve(texto ? JSON.parse(texto) : {});
        } catch (e) {
          reject(new Error('La respuesta de Portainer no es JSON válido.'));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado contactando a Portainer.')));
    req.on('error', reject);
    if (datosBody) req.write(datosBody);
    req.end();
  });
}

// ==========================================
// AUTENTICACIÓN: se cachea el JWT en memoria (no en la base de datos) y se
// renueva sola si Portainer responde 401 o si ya pasó el tiempo estimado de
// vigencia. Portainer no informa cuándo expira el token en la respuesta de
// login, así que se asume una vigencia conservadora de 7 horas (el default
// de Portainer suele ser 8h) para renovar antes de que caduque de verdad.
// ==========================================
let jwtCacheado = null;
let jwtExpiraEn = 0;
const VIGENCIA_JWT_MS = 7 * 60 * 60 * 1000;

async function iniciarSesion() {
  const resp = await peticionPortainer('/api/auth', {
    method: 'POST',
    body: { Username: PORTAINER_USER, Password: PORTAINER_PASS },
  });
  jwtCacheado = resp.jwt;
  jwtExpiraEn = Date.now() + VIGENCIA_JWT_MS;
  return jwtCacheado;
}

async function obtenerJwt() {
  if (!PORTAINER_CONFIGURADO) return null;
  if (jwtCacheado && Date.now() < jwtExpiraEn) return jwtCacheado;
  return iniciarSesion();
}

// Reintenta UNA sola vez con un login nuevo si Portainer responde 401 (token
// vencido o revocado desde la interfaz de Portainer) — nunca en bucle.
async function peticionAutenticada(path, opts = {}) {
  const token = await obtenerJwt();
  if (!token) throw new Error('Portainer no está configurado.');
  try {
    return await peticionPortainer(path, { ...opts, token });
  } catch (e) {
    if (e.status === 401) {
      jwtCacheado = null;
      const nuevoToken = await obtenerJwt();
      return peticionPortainer(path, { ...opts, token: nuevoToken });
    }
    throw e;
  }
}

// ==========================================
// ENVIRONMENTS (endpoints de Portainer): se cachean pocos segundos para no
// pedir la lista completa en cada refresco de CADA servidor monitoreado
// (el frontend refresca cada 4s).
// ==========================================
let endpointsCache = null;
let endpointsCacheEn = 0;
const ENDPOINTS_CACHE_MS = 20000;

async function listarEndpoints() {
  if (endpointsCache && Date.now() - endpointsCacheEn < ENDPOINTS_CACHE_MS) return endpointsCache;
  const lista = await peticionAutenticada('/api/endpoints');
  endpointsCache = lista;
  endpointsCacheEn = Date.now();
  return lista;
}

// Empareja por hostname: el nombre del "environment" en Portainer coincide
// con el hostname del servidor (ej. "FABOGDOCK012" en ambos lados), sin
// distinguir mayúsculas/minúsculas. Si en algún momento se agregan
// environments con otro criterio de nombre, este es el único lugar que
// habría que ajustar.
async function endpointParaHostname(hostname) {
  if (!hostname) return null;
  const lista = await listarEndpoints();
  const objetivo = hostname.trim().toLowerCase();
  return lista.find((e) => (e.Name || '').trim().toLowerCase() === objetivo) || null;
}

// ==========================================
// DOCKER: Portainer expone el Docker Engine API casi sin modificar bajo
// /api/endpoints/{id}/docker/... — se piden los mismos recursos que ya usa
// el CLI de docker (ps -a, stats, system df), sólo que en JSON nativo en vez
// de tener que parsear texto por SSH.
// ==========================================
function listarContenedores(endpointId) {
  return peticionAutenticada(`/api/endpoints/${endpointId}/docker/containers/json?all=true`);
}

function statsContenedor(endpointId, containerId) {
  return peticionAutenticada(`/api/endpoints/${endpointId}/docker/containers/${containerId}/stats?stream=false`);
}

function systemDf(endpointId) {
  return peticionAutenticada(`/api/endpoints/${endpointId}/docker/system/df`);
}

// Misma fórmula que usa el CLI de Docker para "docker stats":
//   cpu% = (cpu_delta / system_delta) * núm_cpus * 100
function calcularCpuPorcentaje(stats) {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sistemaDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const numCpus = stats.cpu_stats.online_cpus
      || (stats.cpu_stats.cpu_usage.percpu_usage || []).length
      || 1;
    if (sistemaDelta > 0 && cpuDelta > 0) {
      return (cpuDelta / sistemaDelta) * numCpus * 100;
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

function formatoBytes(bytes) {
  if (!bytes || bytes <= 0) return '0B';
  const unidades = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let valor = bytes;
  while (valor >= 1000 && i < unidades.length - 1) {
    valor /= 1000;
    i++;
  }
  return `${valor.toFixed(i === 0 ? 0 : 2)}${unidades[i]}`;
}

// Mismos 6 campos que ya espera el frontend (RecursosContenedor), calculados
// a partir del JSON crudo de "docker stats" en vez de parsear el texto de la
// tabla que imprime el CLI.
function calcularRecursos(stats) {
  const cpuPorcentaje = calcularCpuPorcentaje(stats);

  const memUsoBytes = (stats.memory_stats && stats.memory_stats.usage) || 0;
  // El CLI de Docker resta el cache de páginas del uso reportado, para no
  // contar como "en uso" memoria que el kernel puede reclamar libremente.
  const statsMemoria = (stats.memory_stats && stats.memory_stats.stats) || {};
  const cache = statsMemoria.cache || statsMemoria.inactive_file || 0;
  const memUsoReal = Math.max(memUsoBytes - cache, 0);
  const memLimite = (stats.memory_stats && stats.memory_stats.limit) || 0;
  const memPorcentaje = memLimite > 0 ? (memUsoReal / memLimite) * 100 : 0;

  let rx = 0;
  let tx = 0;
  if (stats.networks) {
    Object.values(stats.networks).forEach((n) => {
      rx += n.rx_bytes || 0;
      tx += n.tx_bytes || 0;
    });
  }

  let lecturas = 0;
  let escrituras = 0;
  const io = (stats.blkio_stats && stats.blkio_stats.io_service_bytes_recursive) || [];
  io.forEach((entrada) => {
    const op = (entrada.op || '').toLowerCase();
    if (op === 'read') lecturas += entrada.value || 0;
    if (op === 'write') escrituras += entrada.value || 0;
  });

  return {
    cpuPorcentaje: `${cpuPorcentaje.toFixed(2)}%`,
    memUso: `${formatoBytes(memUsoReal)} / ${formatoBytes(memLimite)}`,
    memPorcentaje: `${memPorcentaje.toFixed(2)}%`,
    redIO: `${formatoBytes(rx)} / ${formatoBytes(tx)}`,
    discoIO: `${formatoBytes(lecturas)} / ${formatoBytes(escrituras)}`,
    pids: (stats.pids_stats && stats.pids_stats.current) || 0,
    // Versiones numéricas "crudas" de CPU%/memoria usada, además de los
    // textos ya formateados de arriba — las necesita el Análisis
    // Estadístico (promedios/sumas de toda la flota) para no tener que
    // volver a parsear "12.34%"/"70.51MB" desde el texto.
    cpuPorcentajeNum: +cpuPorcentaje.toFixed(2),
    memUsoBytesNum: memUsoReal,
  };
}

// Mismo formato de texto que ya usa el frontend (resumenPuertos), ej:
// "0.0.0.0:3030->443/tcp, 8080/tcp"
function formatoPuertos(ports) {
  if (!ports || !ports.length) return '';
  return ports
    .map((p) => (p.PublicPort
      ? `${p.IP || '0.0.0.0'}:${p.PublicPort}->${p.PrivatePort}/${p.Type}`
      : `${p.PrivatePort}/${p.Type}`))
    .join(', ');
}

// Los 4 renglones que ya muestra el frontend en "Espacio de Docker"
// (bloque-espacio-docker), calculados desde /docker/system/df en vez de
// `docker system df --format`. El "recuperable" que calcula el CLI de Docker
// no viene resuelto en este endpoint, así que se deja explícito como "N/D"
// en vez de inventar un número que podría ser incorrecto.
function armarEspacioDocker(df) {
  const imagenes = df.Images || [];
  const contenedores = df.Containers || [];
  const volumenes = df.Volumes || [];
  const buildCache = df.BuildCache || [];

  return [
    {
      tipo: 'Images',
      total: imagenes.length,
      activos: imagenes.filter((i) => (i.Containers || 0) > 0).length,
      tamano: formatoBytes(imagenes.reduce((acc, i) => acc + (i.Size || 0), 0)),
      recuperable: 'N/D',
    },
    {
      tipo: 'Containers',
      total: contenedores.length,
      activos: contenedores.filter((c) => c.State === 'running').length,
      tamano: formatoBytes(contenedores.reduce((acc, c) => acc + (c.SizeRw || 0), 0)),
      recuperable: 'N/D',
    },
    {
      tipo: 'Local Volumes',
      total: volumenes.length,
      activos: volumenes.filter((v) => v.UsageData && v.UsageData.RefCount > 0).length,
      tamano: formatoBytes(volumenes.reduce((acc, v) => acc + ((v.UsageData && v.UsageData.Size) || 0), 0)),
      recuperable: 'N/D',
    },
    {
      tipo: 'Build Cache',
      total: buildCache.length,
      activos: buildCache.filter((b) => b.InUse).length,
      tamano: formatoBytes(buildCache.reduce((acc, b) => acc + (b.Size || 0), 0)),
      recuperable: 'N/D',
    },
  ];
}

// ==========================================
// ARMADO PRINCIPAL: mismo "shape" que parsearDocker() en monitoreo.js
// (contenedores/resumenContenedores/dockerDisponible/espacioDocker), más los
// campos extra de detalle en cada contenedor (comando, creadoEn, redes,
// volumenes) que la vía SSH no puede dar sin volverse mucho más compleja.
//
// Devuelve null cuando Portainer no está configurado o no tiene un
// environment para este hostname — es la señal para que quien llama (ver
// monitoreo.js) haga fallback a lo que ya sacó por SSH, sin romper nada.
// ==========================================
async function obtenerDockerPortainer(hostname) {
  if (!PORTAINER_CONFIGURADO) return null;

  const endpoint = await endpointParaHostname(hostname);
  if (!endpoint) return null;

  const crudos = await listarContenedores(endpoint.Id);

  const enEjecucion = crudos.filter((c) => c.State === 'running');
  const statsPorId = new Map();
  await Promise.all(enEjecucion.map(async (c) => {
    try {
      const stats = await statsContenedor(endpoint.Id, c.Id);
      statsPorId.set(c.Id, calcularRecursos(stats));
    } catch (e) {
      // Un contenedor puntual sin stats (por ejemplo, apagándose justo en
      // este instante) no debe tumbar el resto de la respuesta.
    }
  }));

  const contenedores = crudos.map((c) => ({
    id: c.Id.substring(0, 12),
    nombre: ((c.Names && c.Names[0]) || '').replace(/^\//, ''),
    imagen: c.Image,
    estado: (c.State || '').toLowerCase(),
    estadoTexto: c.Status || '',
    puertos: formatoPuertos(c.Ports),
    recursos: statsPorId.get(c.Id) || null,
    origen: 'portainer',
    comando: c.Command || '',
    creadoEn: c.Created ? new Date(c.Created * 1000).toISOString() : undefined,
    redes: (c.NetworkSettings && c.NetworkSettings.Networks) ? Object.keys(c.NetworkSettings.Networks) : [],
    volumenes: (c.Mounts || []).map((m) => ({
      origen: m.Source || m.Name || '',
      destino: m.Destination || '',
      modo: m.RW === false ? 'ro' : 'rw',
    })),
  }));

  const corriendo = contenedores.filter((c) => c.estado === 'running').length;

  let espacioDocker = [];
  try {
    const df = await systemDf(endpoint.Id);
    espacioDocker = armarEspacioDocker(df);
  } catch (e) {
    // El detalle de contenedores es lo importante; si "system df" falla, se
    // omite ese bloque sin romper el resto de la respuesta.
  }

  return {
    contenedores,
    resumenContenedores: { total: contenedores.length, corriendo, detenidos: contenedores.length - corriendo },
    dockerDisponible: true,
    espacioDocker,
  };
}

// ==========================================
// LISTADO DIRECTO DE TODOS LOS ENTORNOS (sin depender de que un servidor
// esté agregado al grupo de monitoreo por SSH): arma, para cada environment
// que Portainer conoce, su lista de contenedores + resumen — la misma vista
// que ya se ve al entrar directamente a la interfaz de Portainer (Home).
// ==========================================

// Datos aproximados del host que trae el propio "snapshot" que Portainer
// guarda de cada environment (se actualiza solo cuando Portainer sincroniza,
// no es una lectura en vivo): núm. de CPUs, memoria total y versión de
// Docker. OJO: esto NO incluye CPU/memoria EN USO del host — Portainer no
// expone eso por environment sin una extensión de pago, así que no se
// inventa ese dato aquí (por eso las tarjetas de entorno no muestran
// "salud" tipo semáforo como las de SSH, sólo lo que Portainer sí sabe con
// certeza: sus contenedores).
function snapshotEntorno(endpoint) {
  const snap = (endpoint.Snapshots && endpoint.Snapshots[0]) || null;
  if (!snap) return { cpuCores: null, memoriaTotalGb: null, dockerVersion: null };
  return {
    cpuCores: typeof snap.TotalCPU === 'number' ? snap.TotalCPU : null,
    memoriaTotalGb: typeof snap.TotalMemory === 'number'
      ? +(snap.TotalMemory / (1024 ** 3)).toFixed(2)
      : null,
    dockerVersion: snap.DockerVersion || null,
  };
}

// El "environment" de Portainer se conecta a un agente en
// "tcp://<ip-del-servidor>:9001" (o similar) — esa URL YA trae la IP real
// del servidor, sin depender de que alguien la haya cargado a mano en
// Inventario. Se usa como respaldo/alternativa a la IP de Inventario DB (ver
// GET /portainer/entornos en monitoreo.js), que es donde de verdad importa:
// varios servidores conectados a Portainer todavía no estaban dados de alta
// en Inventario y por eso no mostraban ninguna IP.
function extraerIpDeUrl(url) {
  if (!url) return null;
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^:/]+)(?::\d+)?/i);
  if (!m) return null;
  const host = m[1];
  // Sólo se usa si es una IPv4 real — un socket local ("unix:///...") o un
  // nombre DNS interno no son un dato confiable para mostrar como "la IP".
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : null;
}

async function entornoConContenedores(endpoint) {
  const base = {
    id: endpoint.Id,
    nombre: endpoint.Name,
    // Status de Portainer: 1 = up, 2 = down (agente desconectado/caído).
    estadoConexion: endpoint.Status === 1 ? 'up' : 'down',
    ipPortainer: extraerIpDeUrl(endpoint.URL) || extraerIpDeUrl(endpoint.PublicURL),
    ...snapshotEntorno(endpoint),
  };

  if (base.estadoConexion !== 'up') {
    return {
      ...base,
      contenedores: [],
      resumenContenedores: { total: 0, corriendo: 0, detenidos: 0 },
      error: 'Este entorno aparece desconectado en Portainer.',
    };
  }

  try {
    const crudos = await listarContenedores(endpoint.Id);

    const enEjecucion = crudos.filter((c) => c.State === 'running');
    const statsPorId = new Map();
    await Promise.all(enEjecucion.map(async (c) => {
      try {
        const stats = await statsContenedor(endpoint.Id, c.Id);
        statsPorId.set(c.Id, calcularRecursos(stats));
      } catch (e) {
        // Un contenedor puntual sin stats no debe tumbar el resto.
      }
    }));

    const contenedores = crudos.map((c) => ({
      id: c.Id.substring(0, 12),
      nombre: ((c.Names && c.Names[0]) || '').replace(/^\//, ''),
      imagen: c.Image,
      estado: (c.State || '').toLowerCase(),
      estadoTexto: c.Status || '',
      puertos: formatoPuertos(c.Ports),
      recursos: statsPorId.get(c.Id) || null,
    }));

    const corriendo = contenedores.filter((c) => c.estado === 'running').length;

    return {
      ...base,
      contenedores,
      resumenContenedores: { total: contenedores.length, corriendo, detenidos: contenedores.length - corriendo },
      error: null,
    };
  } catch (e) {
    return {
      ...base,
      contenedores: [],
      resumenContenedores: { total: 0, corriendo: 0, detenidos: 0 },
      error: e.message || 'No se pudo consultar este entorno en Portainer.',
    };
  }
}

// Trae TODOS los entornos configurados en Portainer, cada uno con su lista
// de contenedores — a diferencia de obtenerDockerPortainer() (que busca UN
// solo entorno por hostname), esto no depende de que el servidor esté dado
// de alta en monitoreo_servidores ni en Servidores: es la vista directa de
// "qué hay en Portainer".
async function listarTodosLosEntornos() {
  if (!PORTAINER_CONFIGURADO) return [];
  const endpoints = await listarEndpoints();
  return Promise.all(endpoints.map(entornoConContenedores));
}

// ==========================================
// DETALLE, LOGS Y ACCIONES SOBRE UN CONTENEDOR — para que un administrador
// pueda operar contenedores sin salir de la aplicación (igual que en la
// propia interfaz de Portainer): Start, Stop, Restart, Pause, Resume, Kill
// y Remove, más el detalle completo (inspect) y los logs.
// ==========================================

// Arma un resumen legible del "inspect" crudo de Docker — sólo los campos
// que tiene sentido mostrarle a un humano, no el JSON completo (que trae
// mucho ruido interno: capacidades del kernel, cgroups, etc.).
function resumenInspeccion(raw) {
  const config = raw.Config || {};
  const hostConfig = raw.HostConfig || {};
  const networkSettings = raw.NetworkSettings || {};
  const mounts = raw.Mounts || [];
  // Docker deja "0001-01-01T00:00:00Z" (su "tiempo cero") en FinishedAt
  // cuando el contenedor nunca ha terminado — no es una fecha real.
  const terminadoEn = raw.State && raw.State.FinishedAt && !raw.State.FinishedAt.startsWith('0001-01-01')
    ? raw.State.FinishedAt
    : null;

  return {
    id: (raw.Id || '').substring(0, 12),
    nombre: (raw.Name || '').replace(/^\//, ''),
    imagen: config.Image || '',
    comando: [...(config.Entrypoint || []), ...(config.Cmd || [])].join(' '),
    creadoEn: raw.Created || null,
    iniciadoEn: (raw.State && raw.State.StartedAt) || null,
    terminadoEn,
    politicaReinicio: (hostConfig.RestartPolicy && hostConfig.RestartPolicy.Name) || 'no',
    reinicios: typeof raw.RestartCount === 'number' ? raw.RestartCount : null,
    privilegiado: !!hostConfig.Privileged,
    variablesEntorno: (config.Env || []).length,
    redes: Object.keys(networkSettings.Networks || {}),
    volumenes: mounts.map((m) => ({
      origen: m.Source || m.Name || '',
      destino: m.Destination || '',
      modo: m.RW === false ? 'ro' : 'rw',
      tipo: m.Type || '',
    })),
    etiquetas: config.Labels || {},
  };
}

async function inspeccionarContenedor(endpointId, containerId) {
  const raw = await peticionAutenticada(`/api/endpoints/${endpointId}/docker/containers/${containerId}/json`);
  return resumenInspeccion(raw);
}

// Los logs de un contenedor SIN tty vienen "multiplexados": cada línea trae
// un encabezado de 8 bytes (1 byte de tipo de stream + 3 en cero + 4 de
// tamaño en big-endian) antes del texto. Si el contenedor SÍ tiene tty, no
// hay encabezados — ya es texto plano. Se detecta intentando leer el
// patrón de encabezados; si en algún punto no calza con el tamaño real del
// buffer, se asume texto plano y se devuelve tal cual (mejor mostrar algo
// legible que nada).
function limpiarLogsDocker(buffer) {
  const lineas = [];
  let offset = 0;
  try {
    if (buffer.length === 0) return '';
    while (offset + 8 <= buffer.length) {
      const tipo = buffer.readUInt8(offset);
      if (tipo > 2) throw new Error('no-multiplex');
      const tamano = buffer.readUInt32BE(offset + 4);
      const inicio = offset + 8;
      const fin = inicio + tamano;
      if (fin > buffer.length) throw new Error('no-multiplex');
      lineas.push(buffer.slice(inicio, fin).toString('utf8'));
      offset = fin;
    }
    if (offset !== buffer.length) throw new Error('no-multiplex');
    return lineas.join('');
  } catch (e) {
    return buffer.toString('utf8');
  }
}

async function logsContenedor(endpointId, containerId, tail = 200) {
  const path = `/api/endpoints/${endpointId}/docker/containers/${containerId}/logs`
    + `?stdout=true&stderr=true&timestamps=true&tail=${encodeURIComponent(tail)}`;
  const buffer = await peticionAutenticada(path, { raw: true, timeoutMs: 15000 });
  return limpiarLogsDocker(buffer);
}

// Cada acción es la misma llamada que haría el CLI de docker — Portainer
// expone el Docker Engine API casi sin modificar bajo /docker/...
const ACCIONES_CONTENEDOR = {
  start: { method: 'POST', ruta: (id) => `/containers/${id}/start` },
  stop: { method: 'POST', ruta: (id) => `/containers/${id}/stop?t=10` },
  restart: { method: 'POST', ruta: (id) => `/containers/${id}/restart?t=10` },
  pause: { method: 'POST', ruta: (id) => `/containers/${id}/pause` },
  unpause: { method: 'POST', ruta: (id) => `/containers/${id}/unpause` },
  kill: { method: 'POST', ruta: (id) => `/containers/${id}/kill` },
  remove: { method: 'DELETE', ruta: (id) => `/containers/${id}?force=true` },
};

async function ejecutarAccionContenedor(endpointId, containerId, accion) {
  const definicion = ACCIONES_CONTENEDOR[accion];
  if (!definicion) throw new Error(`Acción de contenedor no reconocida: "${accion}".`);
  const path = `/api/endpoints/${endpointId}/docker${definicion.ruta(containerId)}`;
  await peticionAutenticada(path, { method: definicion.method, timeoutMs: 15000 });
}

// ==========================================
// IMÁGENES, REDES Y VOLÚMENES — mismas listas que se ven en la interfaz de
// Portainer bajo Images/Networks/Volumes de un environment, con su acción
// de eliminar para administradores (mismo criterio de permisos que las
// acciones de contenedores).
// ==========================================

// Se cruza con la lista de contenedores para marcar qué imágenes están "en
// uso" (Docker no deja eliminar una imagen en uso sin --force, así que vale
// la pena avisarlo en la lista en vez de que el usuario se entere recién al
// fallar el borrado). Se descartan las entradas "<none>:<none>" (imágenes
// intermedias sin tag) del listado de tags, no de la lista en sí.
async function listarImagenes(endpointId) {
  const [imagenes, contenedores] = await Promise.all([
    peticionAutenticada(`/api/endpoints/${endpointId}/docker/images/json`),
    peticionAutenticada(`/api/endpoints/${endpointId}/docker/containers/json?all=true`),
  ]);
  const idsEnUso = new Set(contenedores.map((c) => c.ImageID));
  return imagenes
    .map((img) => ({
      id: (img.Id || '').replace('sha256:', '').substring(0, 12),
      tags: (img.RepoTags || []).filter((t) => t !== '<none>:<none>'),
      tamano: formatoBytes(img.Size),
      // Bytes crudos además del texto formateado de arriba — el Análisis
      // Estadístico suma el espacio de TODAS las imágenes del parque y
      // necesita el número, no el texto ya formateado por entorno.
      tamanoBytes: img.Size || 0,
      creadaEn: img.Created ? new Date(img.Created * 1000).toISOString() : null,
      enUso: idsEnUso.has(img.Id),
    }))
    .sort((a, b) => (b.creadaEn || '').localeCompare(a.creadaEn || ''));
}

async function eliminarImagen(endpointId, imagenId) {
  await peticionAutenticada(`/api/endpoints/${endpointId}/docker/images/${imagenId}`, {
    method: 'DELETE',
    timeoutMs: 15000,
  });
}

async function listarRedes(endpointId) {
  const redes = await peticionAutenticada(`/api/endpoints/${endpointId}/docker/networks`);
  return redes
    .map((r) => ({
      id: (r.Id || '').substring(0, 12),
      nombre: r.Name,
      driver: r.Driver,
      scope: r.Scope,
      interna: !!r.Internal,
      contenedoresConectados: Object.keys(r.Containers || {}).length,
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

async function eliminarRed(endpointId, redId) {
  await peticionAutenticada(`/api/endpoints/${endpointId}/docker/networks/${redId}`, {
    method: 'DELETE',
    timeoutMs: 15000,
  });
}

async function listarVolumenes(endpointId) {
  const resp = await peticionAutenticada(`/api/endpoints/${endpointId}/docker/volumes`);
  const volumenes = resp.Volumes || [];

  // El cruce con contenedores para marcar "en uso" es best-effort: si falla,
  // se sigue mostrando la lista de volúmenes igual, sólo sin esa marca.
  let nombresEnUso = new Set();
  try {
    const contenedores = await peticionAutenticada(`/api/endpoints/${endpointId}/docker/containers/json?all=true`);
    contenedores.forEach((c) => {
      (c.Mounts || []).forEach((m) => { if (m.Name) nombresEnUso.add(m.Name); });
    });
  } catch (e) {
    // Ver comentario arriba — no debe tumbar el resto de la respuesta.
  }

  return volumenes
    .map((v) => ({
      nombre: v.Name,
      driver: v.Driver,
      puntoMontaje: v.Mountpoint || '',
      creadoEn: v.CreatedAt || null,
      enUso: nombresEnUso.has(v.Name),
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

async function eliminarVolumen(endpointId, nombre) {
  await peticionAutenticada(`/api/endpoints/${endpointId}/docker/volumes/${encodeURIComponent(nombre)}`, {
    method: 'DELETE',
    timeoutMs: 15000,
  });
}

// ==========================================
// EVENTOS Y DATOS DEL HOST (Fase 3 — últimas dos secciones de Portainer que
// faltaban: Events y la vista de Host de cada environment).
// ==========================================

// Docker sólo cierra sola la conexión de /events cuando se le pasa "until"
// además de "since" — sin eso es un stream infinito (lo mismo que
// `docker events` sin límite), que nunca terminaría de llegar como una
// respuesta HTTP normal. Pidiendo un rango acotado [ahora - minutos, ahora]
// se obtiene una lista puntual y ya cerrada, compatible con el mismo cliente
// HTTP (peticionAutenticada) que se usa para todo lo demás.
async function listarEventos(endpointId, minutos = 60) {
  const ahora = Math.floor(Date.now() / 1000);
  const desde = ahora - minutos * 60;
  const path = `/api/endpoints/${endpointId}/docker/events?since=${desde}&until=${ahora}`;
  const buffer = await peticionAutenticada(path, { raw: true, timeoutMs: 20000 });
  const texto = buffer.toString('utf8').trim();
  if (!texto) return [];

  // La respuesta es NDJSON (un objeto JSON por línea), no un único array —
  // una línea suelta que no parsee (por ejemplo si el buffer se cortó justo
  // en el límite de tiempo) se descarta en vez de tumbar toda la lista.
  const eventos = texto
    .split('\n')
    .map((linea) => {
      try {
        return JSON.parse(linea);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);

  return eventos
    .map((ev) => {
      const actorId = (ev.Actor && ev.Actor.ID) || '';
      const atributos = (ev.Actor && ev.Actor.Attributes) || {};
      return {
        id: `${ev.time || ''}-${ev.Action || ''}-${actorId}`,
        tiempo: ev.time ? new Date(ev.time * 1000).toISOString() : null,
        tipo: ev.Type || '',
        accion: ev.Action || '',
        recurso: atributos.name || atributos.image || (actorId ? actorId.substring(0, 12) : ''),
      };
    })
    .sort((a, b) => (b.tiempo || '').localeCompare(a.tiempo || ''));
}

// Datos del host que corre este environment — lo mismo que Portainer muestra
// en su página "Host" de cada environment, sacado de `docker info` en vez
// del snapshot cacheado que ya se usa para las tarjetas (ver snapshotEntorno
// arriba): esto es una consulta en vivo, no el último snapshot sincronizado.
async function obtenerInfoHost(endpointId) {
  const info = await peticionAutenticada(`/api/endpoints/${endpointId}/docker/info`);
  return {
    nombreHost: info.Name || '',
    sistemaOperativo: info.OperatingSystem || '',
    arquitectura: info.Architecture || '',
    kernelVersion: info.KernelVersion || '',
    versionDocker: info.ServerVersion || '',
    cpus: typeof info.NCPU === 'number' ? info.NCPU : null,
    memoriaTotalGb: typeof info.MemTotal === 'number' ? +(info.MemTotal / (1024 ** 3)).toFixed(2) : null,
    driverAlmacenamiento: info.Driver || '',
    directorioRaizDocker: info.DockerRootDir || '',
    loggingDriver: info.LoggingDriver || '',
    cgroupDriver: info.CgroupDriver || '',
    contenedoresTotal: typeof info.Containers === 'number' ? info.Containers : null,
    contenedoresCorriendo: typeof info.ContainersRunning === 'number' ? info.ContainersRunning : null,
    contenedoresPausados: typeof info.ContainersPaused === 'number' ? info.ContainersPaused : null,
    contenedoresDetenidos: typeof info.ContainersStopped === 'number' ? info.ContainersStopped : null,
    imagenesTotal: typeof info.Images === 'number' ? info.Images : null,
  };
}

// ==========================================
// ANÁLISIS ESTADÍSTICO: agregados de TODO el parque (todos los entornos a
// la vez), no de uno puntual — para las secciones que no encajan dentro de
// una sola tarjeta de entorno (imágenes/redes/volúmenes de la flota
// completa). El resumen de salud y el top de consumidores de CPU/memoria
// NO necesitan una llamada aparte: se calculan en el frontend a partir de
// la misma respuesta que ya trae /portainer/entornos (cpuPorcentajeNum/
// memUsoBytesNum de cada contenedor, agregados arriba).
// ==========================================

// Trae imágenes/redes/volúmenes de TODOS los entornos activos en paralelo
// y devuelve sólo los conteos agregados — no la lista completa (eso ya lo
// da cada pestaña de imágenes/redes/volúmenes por entorno). Es una consulta
// pesada (3 llamadas × N entornos activos), así que el frontend la pide una
// sola vez al entrar al Análisis, nunca en el poll de 6s.
async function estadisticasRecursosFlota() {
  const vacio = {
    imagenesTotal: 0,
    imagenesSinTag: 0,
    imagenesEnUso: 0,
    espacioImagenesTexto: '0B',
    redesTotal: 0,
    redesSinUsar: 0,
    volumenesTotal: 0,
    volumenesSinUsar: 0,
    entornosConsultados: 0,
  };
  if (!PORTAINER_CONFIGURADO) return vacio;

  const endpoints = (await listarEndpoints()).filter((e) => e.Status === 1);
  if (!endpoints.length) return vacio;

  const porEntorno = await Promise.all(
    endpoints.map(async (ep) => {
      try {
        const [imagenes, redes, volumenes] = await Promise.all([
          listarImagenes(ep.Id),
          listarRedes(ep.Id),
          listarVolumenes(ep.Id),
        ]);
        return { imagenes, redes, volumenes };
      } catch (e) {
        // Un entorno puntual que falle (agente caído, timeout) no debe
        // tumbar el agregado de todos los demás.
        return { imagenes: [], redes: [], volumenes: [] };
      }
    })
  );

  let imagenesTotal = 0;
  let imagenesSinTag = 0;
  let imagenesEnUso = 0;
  let espacioImagenesBytes = 0;
  let redesTotal = 0;
  let redesSinUsar = 0;
  let volumenesTotal = 0;
  let volumenesSinUsar = 0;

  porEntorno.forEach(({ imagenes, redes, volumenes }) => {
    imagenes.forEach((img) => {
      imagenesTotal++;
      if (!img.tags.length) imagenesSinTag++;
      if (img.enUso) imagenesEnUso++;
      espacioImagenesBytes += img.tamanoBytes || 0;
    });
    redes.forEach((r) => {
      redesTotal++;
      if (!r.contenedoresConectados && !['bridge', 'host', 'none'].includes(r.nombre)) redesSinUsar++;
    });
    volumenes.forEach((v) => {
      volumenesTotal++;
      if (!v.enUso) volumenesSinUsar++;
    });
  });

  return {
    imagenesTotal,
    imagenesSinTag,
    imagenesEnUso,
    espacioImagenesTexto: formatoBytes(espacioImagenesBytes),
    redesTotal,
    redesSinUsar,
    volumenesTotal,
    volumenesSinUsar,
    entornosConsultados: endpoints.length,
  };
}

// Descarta la lista de environments en caché (la pantalla de Puertos la pide con «Actualizar»).
// ==========================================
// ARCHIVOS DE UN CONTENEDOR (solo lectura): GET /containers/{id}/archive?path=
// Docker devuelve un TAR con el archivo o la carpeta pedida. Se entrega por trozos a «alTrozo» (que puede pedir
// que se deje de leer devolviendo false) y se corta solo al llegar a «maxBytes», para no traer carpetas enormes.
// Resultado: { existe, bytes, truncado }. Un 404 (la ruta no existe en ese contenedor) NO es un error.
// ==========================================
async function descargarArchivoContenedor(endpointId, containerId, ruta, { alTrozo, maxBytes = 64 * 1024 * 1024, timeoutMs = 20000, totalMs = 90000 } = {}) {
  if (!PORTAINER_CONFIGURADO) throw new Error('Portainer no está configurado.');
  const camino = `/api/endpoints/${endpointId}/docker/containers/${containerId}/archive?path=${encodeURIComponent(ruta)}`;

  const intentar = (token) => new Promise((resolve, reject) => {
    let url;
    try { url = new URL(camino, PORTAINER_URL); } catch (e) { return reject(new Error(`PORTAINER_URL mal configurado: ${PORTAINER_URL}`)); }
    let bytes = 0;
    let truncado = false;
    let cerrado = false;
    const terminar = (fn, valor) => { if (cerrado) return; cerrado = true; clearTimeout(reloj); fn(valor); };
    const req = https.request(url, {
      method: 'GET',
      headers: { Accept: 'application/x-tar', Authorization: `Bearer ${token}` },
      rejectUnauthorized: VALIDAR_TLS,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode === 404) { res.resume(); return terminar(resolve, { existe: false, bytes: 0, truncado: false }); }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const trozos = [];
        res.on('data', (c) => trozos.push(c));
        res.on('end', () => {
          const err = new Error(`Portainer respondió ${res.statusCode}. ${Buffer.concat(trozos).toString('utf8')}`.slice(0, 300));
          err.status = res.statusCode;
          terminar(reject, err);
        });
        return undefined;
      }
      res.on('data', (chunk) => {
        if (cerrado) return;
        bytes += chunk.length;
        let seguir = true;
        try { seguir = alTrozo ? alTrozo(chunk) !== false : true; } catch (e) { return terminar(reject, e); }
        if (!seguir || bytes >= maxBytes) {
          truncado = bytes >= maxBytes && seguir;
          req.destroy();
          terminar(resolve, { existe: true, bytes, truncado });
        }
      });
      res.on('end', () => terminar(resolve, { existe: true, bytes, truncado }));
      res.on('error', (e) => terminar(cerrado ? () => {} : reject, e));
      return undefined;
    });
    const reloj = setTimeout(() => { req.destroy(); terminar(reject, new Error('Tiempo de espera agotado leyendo archivos del contenedor.')); }, totalMs);
    req.on('timeout', () => { req.destroy(); terminar(reject, new Error('Tiempo de espera agotado contactando a Portainer.')); });
    req.on('error', (e) => terminar(reject, e));
    req.end();
  });

  const token = await obtenerJwt();
  try {
    return await intentar(token);
  } catch (e) {
    if (e.status === 401) { jwtCacheado = null; return intentar(await obtenerJwt()); }
    throw e;
  }
}

function olvidarEndpoints() {
  endpointsCache = null;
  endpointsCacheEn = 0;
}

module.exports = {
  // Piezas de bajo nivel que reutiliza Inventario > Puertos (routes/puertosPortainer.js).
  listarEndpoints,
  listarContenedores,
  peticionAutenticada,
  descargarArchivoContenedor,
  extraerIpDeUrl,
  olvidarEndpoints,
  obtenerDockerPortainer,
  listarTodosLosEntornos,
  inspeccionarContenedor,
  logsContenedor,
  ejecutarAccionContenedor,
  listarImagenes,
  eliminarImagen,
  listarRedes,
  eliminarRed,
  listarVolumenes,
  eliminarVolumen,
  listarEventos,
  obtenerInfoHost,
  estadisticasRecursosFlota,
  PORTAINER_CONFIGURADO,
};
