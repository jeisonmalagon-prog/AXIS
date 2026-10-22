// Puertos en uso según Portainer (sin SSH ni WinRM).
//
// Portainer expone el API de Docker de cada servidor («environment»). Aquí se lee, para cada
// uno, qué puertos del servidor tiene publicados cada contenedor:
//   - Contenedores en ejecución: los puertos que Docker publica hoy (-p 8080:80).
//   - Contenedores detenidos: sus puertos quedan RESERVADOS (si se reinician volverían a ocuparlos),
//     se leen de su configuración (HostConfig.PortBindings).
//   - Contenedores con red «host»: Docker no informa sus puertos; se listan aparte como aviso.
// Solo lectura. Portainer solo ve Docker: lo que corre fuera de Docker (IIS, servicios del sistema)
// no aparece; para sugerir puertos libres se suma lo que el inventario tiene registrado.
//
// Las funciones con prefijo «puro» no tocan red ni base de datos para poder probarlas.

const fs = require('fs');
const path = require('path');
const portainer = require('./portainer');
const { cruzarConInventario, componentesDelServidor } = require('./puertosInventario');

const ESTADOS_CON_PUERTO = new Set(['running', 'paused', 'restarting']);
const MAX_INSPECCIONES_POR_ENTORNO = 80;
const SIMULTANEAS_INSPECCION = 5;
const SIMULTANEAS_ENTORNOS = 6;
const CACHE_MS = 30 * 1000;

// ---------------------------------------------------------------- normas (rangos por tipo)
const NORMAS_POR_DEFECTO = {
  tipos: [
    { id: 'frontend', nombre: 'Frontend / Web', desde: 3000, hasta: 3499, descripcion: 'Portales y aplicaciones web' },
    { id: 'api', nombre: 'API / Gateway', desde: 8000, hasta: 8499, descripcion: 'APIs REST o SOAP publicadas' },
    { id: 'backend', nombre: 'Backend / Microservicio interno', desde: 8500, hasta: 8999, descripcion: 'Servicios internos' },
    { id: 'worker', nombre: 'Worker / Batch / Jobs', desde: 7000, hasta: 7499, descripcion: 'Procesos en segundo plano' },
    { id: 'integracion', nombre: 'Integración / Mensajería', desde: 9100, hasta: 9399, descripcion: 'Kafka, MQ, ESB' },
    { id: 'monitoreo', nombre: 'Monitoreo / Administración', desde: 9500, hasta: 9899, descripcion: 'Paneles y métricas' },
    { id: 'datos', nombre: 'Datos (BD y caché no estándar)', desde: 10000, hasta: 10499, descripcion: 'BD y cachés fuera del puerto estándar' },
    { id: 'pruebas', nombre: 'Pruebas / Temporal', desde: 20000, hasta: 20999, descripcion: 'Despliegues temporales' },
  ],
  reservados: [1433, 1521, 3000, 3306, 3389, 4200, 5000, 5432, 5985, 5986, 6379, 8000, 8080, 8443, 9000, 9090, 9092, 9200, 9443, 27017, 47001],
};

let cacheNormas = { ruta: null, mtime: 0, valor: null };

function puroValidarNormas(crudo) {
  if (!crudo || !Array.isArray(crudo.tipos) || !crudo.tipos.length) throw new Error('El archivo no trae «tipos».');
  const ids = new Set();
  const tipos = crudo.tipos.map((t) => {
    const id = String(t.id || '').trim().toLowerCase();
    const desde = Number(t.desde);
    const hasta = Number(t.hasta);
    if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`Tipo con id no válido: «${t.id}».`);
    if (ids.has(id)) throw new Error(`Tipo repetido: «${id}».`);
    ids.add(id);
    if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde < 1024 || hasta > 65535 || desde > hasta) {
      throw new Error(`Rango no válido en «${id}» (debe estar entre 1024 y 65535 y «desde» ≤ «hasta»).`);
    }
    return { id, nombre: String(t.nombre || id), desde, hasta, descripcion: String(t.descripcion || '') };
  });
  const reservados = [...new Set((crudo.reservados || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 65535))].sort((a, b) => a - b);
  return { tipos, reservados };
}

/** Lee config/puertos-normas.json (se vuelve a leer si cambia). Si falta o está mal escrito, usa los rangos por defecto y lo informa. */
function cargarNormas(ruta = path.join(__dirname, '..', 'config', 'puertos-normas.json')) {
  try {
    const st = fs.statSync(ruta);
    if (cacheNormas.ruta === ruta && cacheNormas.mtime === st.mtimeMs && cacheNormas.valor) return cacheNormas.valor;
    const valor = { ...puroValidarNormas(JSON.parse(fs.readFileSync(ruta, 'utf8'))), origen: 'archivo', aviso: null };
    cacheNormas = { ruta, mtime: st.mtimeMs, valor };
    return valor;
  } catch (e) {
    const faltaArchivo = e && e.code === 'ENOENT';
    return {
      ...NORMAS_POR_DEFECTO, origen: 'por_defecto',
      aviso: faltaArchivo ? null : `No se pudo leer puertos-normas.json (${e.message}). Se usan los rangos por defecto.`,
    };
  }
}

// ---------------------------------------------------------------- lectura de contenedores (puro)
function alcanceDe(direcciones) {
  const todas = direcciones.some((d) => d === '0.0.0.0' || d === '::' || d === '');
  if (todas) return 'todas';
  if (direcciones.length && direcciones.every((d) => d === '127.0.0.1' || d === '::1')) return 'local';
  return 'especifica';
}

/** Puertos del servidor que publica un contenedor en ejecución (Docker repite cada puerto para IPv4 e IPv6: se unen). */
function puroPuertosPublicados(c) {
  const mapa = new Map();
  for (const p of c.Ports || []) {
    if (!p.PublicPort) continue;
    const proto = String(p.Type || 'tcp').toUpperCase();
    const clave = `${p.PublicPort}/${proto}`;
    if (!mapa.has(clave)) mapa.set(clave, { puerto: p.PublicPort, protocolo: proto, destino: p.PrivatePort || null, direcciones: [] });
    const f = mapa.get(clave);
    const ip = p.IP || '0.0.0.0';
    if (!f.direcciones.includes(ip)) f.direcciones.push(ip);
  }
  return [...mapa.values()].map((f) => ({ ...f, alcance: alcanceDe(f.direcciones) }));
}

/** Puertos reservados por un contenedor detenido, a partir de su «inspect» (HostConfig.PortBindings). */
function puroPuertosReservados(inspect) {
  const enlaces = (inspect && inspect.HostConfig && inspect.HostConfig.PortBindings) || {};
  const mapa = new Map();
  for (const [destino, lista] of Object.entries(enlaces)) {
    const m = destino.match(/^(\d+)(?:\/(\w+))?$/);
    for (const b of lista || []) {
      const puerto = Number(b && b.HostPort);
      if (!Number.isInteger(puerto) || puerto <= 0) continue; // sin puerto fijo (Docker elige uno al arrancar)
      const proto = String((m && m[2]) || 'tcp').toUpperCase();
      const clave = `${puerto}/${proto}`;
      if (!mapa.has(clave)) mapa.set(clave, { puerto, protocolo: proto, destino: m ? Number(m[1]) : null, direcciones: [] });
      const ip = (b && b.HostIp) || '0.0.0.0';
      const f = mapa.get(clave);
      if (!f.direcciones.includes(ip)) f.direcciones.push(ip);
    }
  }
  return [...mapa.values()].map((f) => ({ ...f, alcance: alcanceDe(f.direcciones) }));
}

function datosDeContenedor(c) {
  const labels = c.Labels || {};
  return {
    contenedor: ((c.Names && c.Names[0]) || '').replace(/^\//, '') || String(c.Id || '').substring(0, 12),
    contenedorId: String(c.Id || '').substring(0, 12),
    imagen: c.Image || '',
    stack: labels['com.docker.compose.project'] || labels['com.docker.stack.namespace'] || null,
  };
}

/** Une los puertos de todos los contenedores de un servidor en filas (una por puerto y protocolo y contenedor). */
function puroFilasDeEntorno(crudos, reservasPorId = new Map()) {
  const filas = [];
  const redHost = [];
  for (const c of crudos || []) {
    const base = datosDeContenedor(c);
    const estado = String(c.State || '').toLowerCase();
    const modoRed = c.HostConfig && c.HostConfig.NetworkMode;
    if (modoRed === 'host' && ESTADOS_CON_PUERTO.has(estado)) redHost.push({ contenedor: base.contenedor, imagen: base.imagen });
    if (ESTADOS_CON_PUERTO.has(estado)) {
      for (const p of puroPuertosPublicados(c)) filas.push({ ...p, ...base, estado, reservado: false });
    } else {
      for (const p of reservasPorId.get(c.Id) || []) filas.push({ ...p, ...base, estado: estado || 'detenido', reservado: true });
    }
  }
  filas.sort((a, b) => a.puerto - b.puerto || a.protocolo.localeCompare(b.protocolo) || a.contenedor.localeCompare(b.contenedor));
  return { filas, redHost };
}

/** TODOS los contenedores del servidor (también los que no publican puertos), con lo que necesita el cruce con sub-aplicativos. */
function puroListaContenedores(crudos, reservasPorId = new Map()) {
  return (crudos || []).map((c) => {
    const base = datosDeContenedor(c);
    const estado = String(c.State || '').toLowerCase();
    const corre = ESTADOS_CON_PUERTO.has(estado);
    const puertos = corre
      ? puroPuertosPublicados(c).map((p) => ({ ...p, reservado: false }))
      : (reservasPorId.get(c.Id) || []).map((p) => ({ ...p, reservado: true }));
    return {
      id: base.contenedorId, nombre: base.contenedor, imagen: base.imagen, stack: base.stack,
      estado: estado || 'desconocido', estadoTexto: c.Status || '',
      redHost: !!(corre && c.HostConfig && c.HostConfig.NetworkMode === 'host'),
      puertos: puertos.sort((a, b) => a.puerto - b.puerto),
    };
  });
}

// ---------------------------------------------------------------- consulta a Portainer
async function enLotes(lista, n, tarea) {
  const salida = [];
  let i = 0;
  const trabajador = async () => {
    while (i < lista.length) {
      const k = i; i += 1;
      salida[k] = await tarea(lista[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, trabajador));
  return salida;
}

async function consultarEntorno(endpoint) {
  const base = {
    id: endpoint.Id, nombre: endpoint.Name,
    conexion: endpoint.Status === 1 ? 'up' : 'down',
    ip: portainer.extraerIpDeUrl(endpoint.URL) || portainer.extraerIpDeUrl(endpoint.PublicURL),
  };
  if (base.conexion !== 'up') {
    return { ...base, ok: false, error: 'El entorno aparece desconectado en Portainer.', contenedores: 0, puertos: [], redHost: [], reservasSinLeer: 0 };
  }
  try {
    const crudos = await portainer.listarContenedores(endpoint.Id);
    const detenidos = crudos.filter((c) => !ESTADOS_CON_PUERTO.has(String(c.State || '').toLowerCase()));
    const aInspeccionar = detenidos.slice(0, MAX_INSPECCIONES_POR_ENTORNO);
    const reservas = new Map();
    await enLotes(aInspeccionar, SIMULTANEAS_INSPECCION, async (c) => {
      try {
        const raw = await portainer.peticionAutenticada(`/api/endpoints/${endpoint.Id}/docker/containers/${c.Id}/json`);
        reservas.set(c.Id, puroPuertosReservados(raw));
      } catch { /* un contenedor sin permiso o que ya no existe no debe tumbar el servidor */ }
    });
    const { filas, redHost } = puroFilasDeEntorno(crudos, reservas);
    return {
      ...base, ok: true, error: null, contenedores: crudos.length, puertos: filas, redHost,
      todos: puroListaContenedores(crudos, reservas),
      reservasSinLeer: Math.max(detenidos.length - aInspeccionar.length, 0),
    };
  } catch (e) {
    return { ...base, ok: false, error: e.message || 'No se pudo consultar este entorno en Portainer.', contenedores: 0, puertos: [], redHost: [], reservasSinLeer: 0 };
  }
}

let cacheConsulta = { en: 0, datos: null };

async function consultarEntornos({ forzar = false } = {}) {
  if (!portainer.PORTAINER_CONFIGURADO) return { configurado: false, entornos: [], consultadoEn: null };
  if (!forzar && cacheConsulta.datos && Date.now() - cacheConsulta.en < CACHE_MS) return cacheConsulta.datos;
  if (forzar) portainer.olvidarEndpoints();
  const endpoints = await portainer.listarEndpoints();
  const entornos = await enLotes(endpoints, SIMULTANEAS_ENTORNOS, consultarEntorno);
  const datos = { configurado: true, entornos, consultadoEn: new Date().toISOString() };
  cacheConsulta = { en: Date.now(), datos };
  return datos;
}

// ---------------------------------------------------------------- cruce con el inventario de servidores
const sinCerosDelNumeroFinal = (t) => {
  const m = t.match(/^(.*?)(\d+)$/);
  return m ? m[1] + m[2].replace(/^0+(?=\d)/, '') : t;
};

function normalizarNombre(valor) {
  const base = String(valor || '').trim().toLowerCase();
  const alfa = base.replace(/[^a-z0-9]/g, '');
  return { base, sinDominio: base.split('.')[0], alfa, sinCeros: sinCerosDelNumeroFinal(alfa) };
}

/** Empareja entornos de Portainer con servidores del inventario: por nombre (4 variantes, solo si es único) y, si no, por IP. */
function puroEmparejar(entornos, servidores) {
  const mapas = {};
  for (const variante of ['base', 'sinDominio', 'alfa', 'sinCeros']) {
    const mapa = new Map();
    const ambiguos = new Set();
    for (const s of servidores) {
      const k = normalizarNombre(s.hostname)[variante];
      if (!k) continue;
      const previo = mapa.get(k);
      if (previo && previo.id !== s.id) { ambiguos.add(k); continue; }
      mapa.set(k, s);
    }
    ambiguos.forEach((k) => mapa.delete(k));
    mapas[variante] = mapa;
  }
  const porIp = new Map();
  for (const s of servidores) if (s.ip) porIp.set(String(s.ip).trim(), s);
  return entornos.map((e) => {
    const n = normalizarNombre(e.nombre);
    const s = mapas.base.get(n.base) || mapas.sinDominio.get(n.sinDominio) || mapas.alfa.get(n.alfa) || mapas.sinCeros.get(n.sinCeros) || (e.ip && porIp.get(e.ip)) || null;
    return { entorno: e, servidor: s };
  });
}

function etiquetaAmbiente(a) {
  return String(a || '').trim() || null;
}

/** Entornos con su servidor del inventario y el estado de cada puerto frente al inventario. */
async function consultarConInventario(pool, opciones = {}) {
  const base = await consultarEntornos(opciones);
  if (!base.configurado) return base;
  let servidores = [];
  let errorInventario = null;
  try {
    [servidores] = await pool.query('SELECT Id AS id, Hostname AS hostname, IP AS ip, Ambiente AS ambiente FROM Servidores');
  } catch (e) {
    console.error('Puertos/Portainer: no se pudo leer Servidores:', e.message);
    errorInventario = 'No se pudo leer el inventario de servidores para comparar los puertos.';
  }
  const pares = puroEmparejar(base.entornos, servidores);
  const entornos = [];
  for (const { entorno: eConTodos, servidor } of pares) {
    const { todos, ...e } = eConTodos; // la lista completa de contenedores solo la usa el cruce con sub-aplicativos
    let puertos = e.puertos.map((f) => ({ ...f, estadoInventario: servidor ? 'no_inventariado' : 'sin_servidor', inventario: [] }));
    let inventarioSinEscuchar = [];
    let puertosInventario = [];
    let componentesSinPuerto = 0;
    if (servidor && e.ok) {
      try {
        const comps = await componentesDelServidor(pool, servidor.id);
        puertosInventario = [...new Set(comps.map((c) => Number(c.puerto)).filter((n) => Number.isInteger(n) && n > 0))];
        // Para el cruce cada contenedor cuenta como un proceso de aplicación (nunca «del sistema»).
        const filasCruce = e.puertos.map((f) => ({ puerto: f.puerto, protocolo: f.protocolo, proceso: 'docker' }));
        const cruce = cruzarConInventario(filasCruce, comps);
        const porPuerto = new Map(cruce.puertos.map((f) => [f.puerto, f]));
        puertos = e.puertos.map((f) => {
          const c = porPuerto.get(f.puerto);
          return { ...f, estadoInventario: c ? c.estadoInventario : 'no_inventariado', inventario: c ? c.inventario : [] };
        });
        inventarioSinEscuchar = cruce.inventarioSinEscuchar;
        componentesSinPuerto = cruce.resumen.componentesSinPuerto;
      } catch (err) {
        console.error(`Puertos/Portainer: no se pudo cruzar ${e.nombre} con el inventario:`, err.message);
        errorInventario = 'No se pudo leer el inventario de componentes para comparar los puertos.';
        puertos = e.puertos.map((f) => ({ ...f, estadoInventario: 'sin_servidor', inventario: [] }));
      }
    }
    const enUso = puertos.filter((f) => !f.reservado);
    entornos.push({
      ...e, puertos, inventarioSinEscuchar, puertosInventario,
      servidorId: servidor ? servidor.id : null,
      hostname: servidor ? servidor.hostname : null,
      ipInventario: servidor ? servidor.ip : null,
      ambiente: servidor ? etiquetaAmbiente(servidor.ambiente) : null,
      servidorInventariado: !!servidor,
      resumen: {
        total: puertos.length,
        enUso: enUso.length,
        reservados: puertos.length - enUso.length,
        contenedoresConPuertos: new Set(puertos.map((f) => f.contenedorId)).size,
        sinInventariar: servidor ? puertos.filter((f) => f.estadoInventario === 'no_inventariado').length : 0,
        inventariados: puertos.filter((f) => f.estadoInventario === 'inventariado').length,
        inventarioSinEscuchar: inventarioSinEscuchar.length,
        componentesSinPuerto,
      },
    });
  }
  return { ...base, entornos, errorInventario };
}

// ---------------------------------------------------------------- sugerir puertos libres (puro)
/**
 * @param {object} p
 * @param {Array} p.entornos           salida de consultarConInventario().entornos
 * @param {object} p.normas            salida de cargarNormas()
 * @param {string} p.tipoId            id del tipo (api, backend…)
 * @param {number|null} p.entornoId    entorno de Portainer donde se va a desplegar; null = libre en TODOS
 * @param {number} p.cantidad
 */
function puroSugerir({ entornos, normas, tipoId, entornoId, cantidad }) {
  const tipo = normas.tipos.find((t) => t.id === tipoId);
  if (!tipo) return { error: `Tipo de componente desconocido: «${tipoId}».` };
  const n = Math.min(Math.max(Math.trunc(Number(cantidad)) || 1, 1), 20);
  const reservados = new Set(normas.reservados);
  const consultados = entornos.filter((e) => e.ok);
  let destino = consultados;
  let nombreDestino = 'todos los servidores consultados';
  if (entornoId !== null && entornoId !== undefined) {
    const e = entornos.find((x) => x.id === entornoId);
    if (!e) return { error: 'No se encontró ese servidor en Portainer.' };
    if (!e.ok) return { error: `No se pudo leer «${e.nombre}» en Portainer, así que no se puede saber qué puertos tiene libres.` };
    destino = [e];
    nombreDestino = e.nombre;
  }
  if (!destino.length) return { error: 'No hay servidores consultados en Portainer.' };

  // Quién usa cada puerto (en uso, reservado por un contenedor detenido, o registrado en el inventario).
  const usadoPor = new Map();
  const marcar = (puerto, nombre) => {
    if (!usadoPor.has(puerto)) usadoPor.set(puerto, new Set());
    usadoPor.get(puerto).add(nombre);
  };
  for (const e of consultados) {
    for (const f of e.puertos) marcar(f.puerto, e.nombre);
    for (const p of e.puertosInventario || []) marcar(p, e.nombre);
  }
  const ocupadoEnDestino = (puerto) => destino.some((e) => usadoPor.get(puerto)?.has(e.nombre));

  const limpios = [];       // libres en todo el parque: el mismo puerto sirve en cualquier servidor
  const soloDestino = [];   // libres en el destino pero usados en otro servidor
  let ocupadosEnRango = 0;
  const tamano = tipo.hasta - tipo.desde + 1;
  for (let puerto = tipo.desde; puerto <= tipo.hasta; puerto += 1) {
    if (reservados.has(puerto)) continue;
    if (ocupadoEnDestino(puerto)) { ocupadosEnRango += 1; continue; }
    const otros = [...(usadoPor.get(puerto) || [])];
    if (!otros.length) { if (limpios.length < n) limpios.push({ puerto, libreEnTodos: true, usadoEn: [] }); }
    else if (soloDestino.length < n) soloDestino.push({ puerto, libreEnTodos: false, usadoEn: otros });
    if (limpios.length >= n) break;
  }
  const sugeridos = [...limpios, ...soloDestino.slice(0, n - limpios.length)].sort((a, b) => a.puerto - b.puerto);
  return {
    tipo: { id: tipo.id, nombre: tipo.nombre, desde: tipo.desde, hasta: tipo.hasta, descripcion: tipo.descripcion },
    destino: nombreDestino,
    cantidadPedida: n,
    sugeridos,
    ocupadosEnRango,
    tamanoRango: tamano,
    mensaje: sugeridos.length < n
      ? `Solo hay ${sugeridos.length} puerto(s) libre(s) en el rango ${tipo.desde}–${tipo.hasta} para ${nombreDestino}. Conviene ampliar el rango en la norma.`
      : null,
  };
}

module.exports = {
  cargarNormas, consultarEntornos, consultarConInventario, puroSugerir, puroEmparejar,
  _prueba: { puroListaContenedores, puroPuertosPublicados, puroPuertosReservados, puroFilasDeEntorno, puroEmparejar, puroValidarNormas, puroSugerir, alcanceDe, NORMAS_POR_DEFECTO },
};
