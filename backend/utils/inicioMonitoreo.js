// Inicio: proveedores de datos de los widgets de MONITOREO (Portainer y F5) con
// opciones por usuario (filtros). Cada widget declara:
//   - normalizar(crudo): valida/limpia las opciones que manda el navegador (lista blanca; nada llega sin pasar por aquí).
//   - proveedor(req, opciones): arma los datos YA filtrados.
// Los datos de Portainer/F5 se cachean pocos segundos en el servidor y se comparten entre usuarios: filtrar es barato y
// no vuelve a consultar Portainer/F5.

const { getPool } = require('../db');
const { tablaExiste } = require('./esquemaSeguro');
const { listarTodosLosEntornos, PORTAINER_CONFIGURADO } = require('./portainer');
const {
  cargarDispositivosF5, buscarDispositivo, obtenerVirtualesConEstado, peticionF5, leer, extraerContadores, extraerEstado,
  calcularTrafico, hayMuestraReciente, esperar,
} = require('./f5Cliente');
const { leerFilasDispositivo } = require('./f5HistorialNodos');

// ---------------------------------------------------------------------------
// Caché en memoria compartida (las peticiones simultáneas comparten la misma promesa)
// ---------------------------------------------------------------------------
const cache = new Map(); // clave -> { hasta, valor } | { hasta, promesa }

function podarCache() {
  if (cache.size < 400) return;
  const ahora = Date.now();
  for (const [k, v] of cache) if (v.hasta <= ahora && !v.promesa) cache.delete(k);
}

async function conCache(clave, ttlMs, fn) {
  const hit = cache.get(clave);
  if (hit && hit.hasta > Date.now()) return hit.promesa ? hit.promesa : hit.valor;
  podarCache();
  const promesa = fn().then(
    (valor) => { cache.set(clave, { hasta: Date.now() + ttlMs, valor }); return valor; },
    (err) => { cache.delete(clave); throw err; }
  );
  cache.set(clave, { hasta: Date.now() + ttlMs, promesa });
  return promesa;
}

const redondear = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const nombreOrden = (a, b) => String(a).localeCompare(String(b), 'es', { numeric: true });

// ---------------------------------------------------------------------------
// Normalizadores de opciones (por usuario)
// ---------------------------------------------------------------------------
const listaEnteros = (v, max = 200) => (Array.isArray(v)
  ? [...new Set(v.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))].slice(0, max)
  : []);
const listaTextos = (v, max, largo = 200) => (Array.isArray(v)
  ? [...new Set(v.map((x) => String(x ?? '').trim()).filter((x) => x && x.length <= largo))].slice(0, max)
  : []);
const elegir = (v, validos, defecto) => (validos.includes(v) ? v : defecto);
const elegirNum = (v, validos, defecto) => (validos.includes(Number(v)) ? Number(v) : defecto);
const bool = (v, defecto = false) => (v === true || v === 1 || v === '1' || v === 'true' ? true : v === false || v === 0 || v === '0' || v === 'false' ? false : defecto);

const NORMALIZAR = {
  portainer_flota: (o = {}) => ({
    entornos: listaEnteros(o.entornos),
    soloAtencion: bool(o.soloAtencion),
    orden: elegir(o.orden, ['atencion', 'nombre', 'memoria', 'cpu'], 'atencion'),
  }),
  portainer_problemas: (o = {}) => {
    const tipos = (Array.isArray(o.tipos) ? o.tipos : []).filter((t) => ['detenido', 'reiniciando', 'insano'].includes(t));
    return { entornos: listaEnteros(o.entornos), tipos: tipos.length ? [...new Set(tipos)] : ['reiniciando', 'insano'] };
  },
  portainer_consumo: (o = {}) => ({
    entornos: listaEnteros(o.entornos),
    metrica: elegir(o.metrica, ['cpu', 'mem'], 'cpu'),
    cantidad: elegirNum(o.cantidad, [6, 10, 20], 6),
  }),
  portainer_tendencia: (o = {}) => ({
    entornos: listaEnteros(o.entornos),
    horas: elegirNum(o.horas, [1, 6, 24, 168], 6),
    metrica: elegir(o.metrica, ['cpu', 'mem'], 'cpu'),
    agrupar: elegir(o.agrupar, ['total', 'servidor'], 'total'),
  }),
  f5_trafico: (o = {}) => ({
    dispositivos: listaTextos(o.dispositivos, 20, 80),
    horas: elegirNum(o.horas, [1, 3, 6, 24], 3),
  }),
  f5_salud: (o = {}) => ({
    dispositivos: listaTextos(o.dispositivos, 20, 80),
    soloProblemas: bool(o.soloProblemas),
  }),
  f5_vivo: (o = {}) => ({
    dispositivo: String(o.dispositivo ?? '').trim().slice(0, 80),
    vs: listaTextos(o.vs, 8, 250),
    minutos: elegirNum(o.minutos, [5, 10, 15], 10),
    metrica: elegir(o.metrica, ['trafico', 'entrada', 'salida', 'conexiones', 'peticiones'], 'trafico'),
  }),
};

// ---------------------------------------------------------------------------
// Portainer
// ---------------------------------------------------------------------------
function entornosPortainer() {
  return conCache('portainer:entornos', 20000, () => listarTodosLosEntornos());
}

/** Clasifica un contenedor: salud, y si es un "problema" (detenido / reiniciando / insano). */
function clasificar(c) {
  const texto = c.estadoTexto || '';
  const estado = c.estado || '';
  const salud = /\(unhealthy\)/i.test(texto) ? 'unhealthy' : /\(healthy\)/i.test(texto) ? 'healthy' : /health: starting/i.test(texto) ? 'starting' : null;
  let tipo = null;
  if (estado === 'restarting') tipo = 'reiniciando';
  else if (estado === 'running' && salud === 'unhealthy') tipo = 'insano';
  else if (estado && estado !== 'running') tipo = 'detenido';
  return { salud, tipo };
}

function filtrarEntornos(entornos, op) {
  const sel = new Set(op.entornos || []);
  return sel.size ? entornos.filter((e) => sel.has(e.id)) : entornos;
}

const catalogoEntornos = (entornos) => entornos
  .map((e) => ({ id: e.id, nombre: e.nombre, estado: e.estadoConexion }))
  .sort((a, b) => nombreOrden(a.nombre, b.nombre));

function resumenEntorno(e) {
  const up = e.estadoConexion === 'up';
  let reiniciando = 0; let insanos = 0; let detenidos = 0; let corriendo = 0;
  let cpuSuma = 0; let memBytes = 0; let medidos = 0;
  for (const c of e.contenedores || []) {
    const { tipo } = clasificar(c);
    if (tipo === 'reiniciando') reiniciando += 1;
    else if (tipo === 'insano') insanos += 1;
    if (c.estado === 'running') corriendo += 1; else detenidos += 1;
    if (c.estado === 'running' && c.recursos) {
      cpuSuma += c.recursos.cpuPorcentajeNum || 0;
      memBytes += c.recursos.memUsoBytesNum || 0;
      medidos += 1;
    }
  }
  const memGb = memBytes / (1024 ** 3);
  const cores = e.cpuCores || null;
  const memTotalGb = e.memoriaTotalGb || null;
  return {
    id: e.id,
    nombre: e.nombre,
    estado: e.estadoConexion,
    ip: e.ipPortainer || null,
    dockerVersion: e.dockerVersion || null,
    error: up ? e.error || null : e.error || 'Desconectado',
    cores,
    memTotalGb,
    total: e.resumenContenedores.total,
    corriendo,
    detenidos,
    reiniciando,
    insanos,
    medidos,
    cpuSumaPct: redondear(cpuSuma, 1),
    // Uso de CPU de los contenedores respecto a TODOS los núcleos del host (100 % = todos los núcleos ocupados).
    cpuHostPct: cores ? redondear(Math.min(100, cpuSuma / cores), 1) : null,
    memUsadaGb: redondear(memGb, 2),
    memHostPct: memTotalGb ? redondear(Math.min(100, (memGb / memTotalGb) * 100), 1) : null,
    atencion: !up || !!e.error || reiniciando > 0 || insanos > 0,
    grave: !up || !!e.error || reiniciando > 0 || insanos > 0,
  };
}

async function datosPortainerFlota(req, op) {
  if (!PORTAINER_CONFIGURADO) return { configurado: false };
  const todos = await entornosPortainer();
  let lista = filtrarEntornos(todos, op).map(resumenEntorno);
  const hayAtencion = lista.filter((e) => e.atencion).length;
  if (op.soloAtencion) lista = lista.filter((e) => e.atencion);

  const peso = (e) => (!e.estado || e.estado !== 'up' ? 1000 : 0) + (e.error ? 500 : 0) + e.reiniciando * 50 + e.insanos * 50 + Math.min(e.detenidos, 40);
  const orden = {
    atencion: (a, b) => peso(b) - peso(a) || nombreOrden(a.nombre, b.nombre),
    nombre: (a, b) => nombreOrden(a.nombre, b.nombre),
    memoria: (a, b) => (b.memHostPct ?? -1) - (a.memHostPct ?? -1) || nombreOrden(a.nombre, b.nombre),
    cpu: (a, b) => (b.cpuHostPct ?? -1) - (a.cpuHostPct ?? -1) || nombreOrden(a.nombre, b.nombre),
  }[op.orden];
  lista.sort(orden);

  const arriba = lista.filter((e) => e.estado === 'up');
  const suma = (f) => arriba.reduce((n, e) => n + (f(e) || 0), 0);
  const memTotal = suma((e) => e.memTotalGb);
  const memUsada = suma((e) => (e.memTotalGb ? e.memUsadaGb : 0));
  return {
    configurado: true,
    catalogo: catalogoEntornos(todos),
    totales: {
      entornos: lista.length,
      arriba: arriba.length,
      caidos: lista.length - arriba.length,
      contenedores: suma((e) => e.total),
      corriendo: suma((e) => e.corriendo),
      detenidos: suma((e) => e.detenidos),
      conProblemas: suma((e) => e.reiniciando + e.insanos),
      memUsadaGb: redondear(suma((e) => e.memUsadaGb), 1),
      memTotalGb: redondear(memTotal, 1),
      memHostPct: memTotal ? redondear((memUsada / memTotal) * 100, 1) : null,
      conAtencion: hayAtencion,
    },
    entornos: lista.slice(0, 100),
    hayMas: Math.max(0, lista.length - 100),
  };
}

async function datosPortainerProblemas(req, op) {
  if (!PORTAINER_CONFIGURADO) return { configurado: false };
  const todos = await entornosPortainer();
  const entornos = filtrarEntornos(todos, op);
  const cuentas = { detenido: 0, reiniciando: 0, insano: 0 };
  const filas = [];
  const sinConexion = [];
  for (const e of entornos) {
    if (e.estadoConexion !== 'up') { sinConexion.push({ id: e.id, nombre: e.nombre, error: e.error || 'Desconectado' }); continue; }
    for (const c of e.contenedores || []) {
      const { tipo, salud } = clasificar(c);
      if (!tipo) continue;
      cuentas[tipo] += 1;
      if (!op.tipos.includes(tipo)) continue;
      filas.push({ entornoId: e.id, entorno: e.nombre, contenedor: c.nombre, imagen: c.imagen, tipo, salud, estado: c.estado, detalle: c.estadoTexto || '' });
    }
  }
  const prioridad = { insano: 0, reiniciando: 1, detenido: 2 };
  filas.sort((a, b) => prioridad[a.tipo] - prioridad[b.tipo] || nombreOrden(a.entorno, b.entorno) || nombreOrden(a.contenedor, b.contenedor));
  return {
    configurado: true,
    catalogo: catalogoEntornos(todos),
    cuentas,
    total: filas.length,
    filas: filas.slice(0, 120),
    sinConexion,
  };
}

async function datosPortainerConsumo(req, op) {
  if (!PORTAINER_CONFIGURADO) return { configurado: false };
  const todos = await entornosPortainer();
  const filas = [];
  for (const e of filtrarEntornos(todos, op)) {
    for (const c of e.contenedores || []) {
      if (c.estado !== 'running' || !c.recursos) continue;
      filas.push({
        entorno: e.nombre,
        nombre: c.nombre,
        imagen: c.imagen,
        cpu: redondear(c.recursos.cpuPorcentajeNum || 0, 1),
        memMb: redondear((c.recursos.memUsoBytesNum || 0) / (1024 * 1024), 0),
      });
    }
  }
  return {
    configurado: true,
    catalogo: catalogoEntornos(todos),
    totalMedidos: filas.length,
    porCpu: [...filas].sort((a, b) => b.cpu - a.cpu).slice(0, op.cantidad),
    porMem: [...filas].sort((a, b) => b.memMb - a.memMb).slice(0, op.cantidad),
  };
}

// Tamaño de cada tramo (segundos) según el rango, para no mandar miles de puntos.
const tramoSeg = (horas) => (horas <= 6 ? 600 : horas <= 24 ? 1800 : 7200);

async function datosPortainerTendencia(req, op) {
  if (!PORTAINER_CONFIGURADO) return { configurado: false };
  const todos = await entornosPortainer();
  const base = { configurado: true, catalogo: catalogoEntornos(todos), horas: op.horas, agrupar: op.agrupar };
  const pool = await getPool();
  if (!(await tablaExiste(pool, 'monitoreo_historico_portainer'))) return { ...base, puntos: [], series: [] };
  const tramo = tramoSeg(op.horas);
  const filtro = op.entornos.length ? ` AND EntornoId IN (${op.entornos.map(() => '?').join(',')})` : '';
  const parametros = [op.horas, ...op.entornos];

  if (op.agrupar === 'total') {
    const [filas] = await pool.query(
      `SELECT MIN(fecha) AS fecha, AVG(cpu) AS cpu, AVG(mem) AS mem, AVG(corriendo) AS corriendo
         FROM (SELECT Fecha AS fecha, AVG(CpuPromedioPct) AS cpu, SUM(MemUsadaGb) AS mem, SUM(ContenedoresCorriendo) AS corriendo
                 FROM monitoreo_historico_portainer
                WHERE Fecha >= (NOW() - INTERVAL ? HOUR)${filtro}
                GROUP BY Fecha) x
        GROUP BY FLOOR(UNIX_TIMESTAMP(fecha) / ${tramo})
        ORDER BY fecha ASC`,
      parametros
    );
    return {
      ...base,
      puntos: filas.map((f) => ({ t: new Date(f.fecha).getTime(), cpu: redondear(Number(f.cpu) || 0, 2), memGb: redondear(Number(f.mem) || 0, 2), corriendo: Math.round(Number(f.corriendo) || 0) })),
    };
  }

  // Una línea por servidor (máx. 6: los de mayor memoria si no se eligieron).
  const [filas] = await pool.query(
    `SELECT EntornoId AS id, MIN(Fecha) AS fecha, AVG(CpuPromedioPct) AS cpu, AVG(MemUsadaGb) AS mem
       FROM monitoreo_historico_portainer
      WHERE Fecha >= (NOW() - INTERVAL ? HOUR)${filtro}
      GROUP BY EntornoId, FLOOR(UNIX_TIMESTAMP(Fecha) / ${tramo})
      ORDER BY fecha ASC`,
    parametros
  );
  const nombres = new Map(todos.map((e) => [e.id, e.nombre]));
  const por = new Map();
  for (const f of filas) {
    const id = Number(f.id);
    if (!por.has(id)) por.set(id, { id, nombre: nombres.get(id) || `Entorno ${id}`, suma: 0, puntos: [] });
    const s = por.get(id);
    s.suma += Number(f.mem) || 0;
    s.puntos.push({ t: new Date(f.fecha).getTime(), cpu: redondear(Number(f.cpu) || 0, 2), memGb: redondear(Number(f.mem) || 0, 2) });
  }
  const series = [...por.values()].sort((a, b) => b.suma - a.suma).slice(0, 6).map(({ id, nombre, puntos }) => ({ id, nombre, puntos }));
  return { ...base, series, hayMasServidores: Math.max(0, por.size - series.length) };
}

// ---------------------------------------------------------------------------
// F5
// ---------------------------------------------------------------------------
const CUBETA_MS = 5 * 60 * 1000;
const catalogoDispositivos = () => cargarDispositivosF5().map((d) => ({ id: String(d.id), nombre: d.nombre }));

function dispositivosElegidos(op) {
  const todos = cargarDispositivosF5();
  const sel = new Set(op.dispositivos || []);
  return sel.size ? todos.filter((d) => sel.has(String(d.id))) : todos;
}

async function datosF5Trafico(req, op) {
  const dispositivos = dispositivosElegidos(op);
  const catalogo = catalogoDispositivos();
  if (!catalogo.length) return { configurado: false };
  const ahora = Date.now();
  const desde = ahora - op.horas * 60 * 60 * 1000;
  const cubetaMs = op.horas <= 3 ? CUBETA_MS : op.horas <= 6 ? 10 * 60 * 1000 : 30 * 60 * 1000;
  const cubetas = new Map(); // t -> Map(nodo -> { inBps, outBps, conn, n })
  const nodos = new Map();
  let fuente = 'bd';
  for (const d of dispositivos) {
    const r = await leerFilasDispositivo(d.id, desde, ahora);
    if (r.fuente !== 'bd') fuente = r.fuente;
    for (const f of r.filas) {
      const seg = f.seg || 0;
      if (!seg) continue;
      const k = `${d.id}|${f.pool}|${f.miembro}`;
      const t = Math.floor(f.t / cubetaMs) * cubetaMs;
      let porNodo = cubetas.get(t);
      if (!porNodo) { porNodo = new Map(); cubetas.set(t, porNodo); }
      let c = porNodo.get(k);
      if (!c) { c = { inBps: 0, outBps: 0, conn: 0, n: 0 }; porNodo.set(k, c); }
      c.n += 1;
      c.inBps += (f.bitsIn || 0) / seg;
      c.outBps += (f.bitsOut || 0) / seg;
      c.conn += f.conn || 0;
      let n = nodos.get(k);
      if (!n) { n = { dispositivo: d.nombre, pool: f.pool, miembro: f.miembro, inBps: 0, outBps: 0, muestras: 0, conn: null, tConn: 0 }; nodos.set(k, n); }
      n.inBps += (f.bitsIn || 0) / seg;
      n.outBps += (f.bitsOut || 0) / seg;
      n.muestras += 1;
      if (f.t >= n.tConn) { n.tConn = f.t; n.conn = f.conn; }
    }
  }
  // Cada tramo = suma, por nodo, del promedio de sus lecturas en el tramo (no depende de cuántas lecturas caigan en él).
  let lista = [...cubetas.entries()].sort((a, b) => a[0] - b[0]).map(([t, porNodo]) => {
    let inBps = 0; let outBps = 0; let conn = 0;
    for (const c of porNodo.values()) { inBps += c.inBps / c.n; outBps += c.outBps / c.n; conn += c.conn / c.n; }
    return { t, inBps, outBps, conn, n: porNodo.size };
  });
  // Los tramos de los extremos suelen venir incompletos (faltan nodos): se descartan frente a la mediana.
  if (lista.length >= 4) {
    const ns = lista.map((c) => c.n).sort((a, b) => a - b);
    const mediana = ns[Math.floor(ns.length / 2)];
    while (lista.length > 2 && lista[lista.length - 1].n < mediana * 0.6) lista.pop();
    while (lista.length > 2 && lista[0].n < mediana * 0.6) lista.shift();
  }
  const puntos = lista.map((c) => ({ t: c.t, inBps: Math.round(c.inBps), outBps: Math.round(c.outBps), conn: Math.round(c.conn) }));
  const ultimo = puntos.length ? puntos[puntos.length - 1] : null;
  const picos = puntos.length ? {
    inBps: Math.max(...puntos.map((p) => p.inBps)),
    outBps: Math.max(...puntos.map((p) => p.outBps)),
    conn: Math.max(...puntos.map((p) => p.conn)),
  } : null;
  const topNodos = [...nodos.values()]
    .map((n) => ({
      dispositivo: n.dispositivo,
      pool: String(n.pool || '').split('/').pop(),
      miembro: n.miembro,
      bps: Math.round((n.inBps + n.outBps) / Math.max(1, n.muestras)),
      inBps: Math.round(n.inBps / Math.max(1, n.muestras)),
      outBps: Math.round(n.outBps / Math.max(1, n.muestras)),
      conn: n.conn,
    }))
    .sort((a, b) => b.bps - a.bps)
    .slice(0, 10);
  return {
    configurado: true,
    fuente,
    horas: op.horas,
    catalogo,
    dispositivos: dispositivos.map((d) => d.nombre),
    puntos,
    ultimo,
    picos,
    ultimaMuestraMs: ultimo ? ultimo.t : null,
    topNodos,
  };
}

async function datosF5Salud(req, op) {
  const dispositivos = dispositivosElegidos(op);
  const catalogo = catalogoDispositivos();
  if (!catalogo.length) return { configurado: false };
  const resultados = await Promise.all(
    dispositivos.map(async (d) => {
      try { return { d, virtuales: await obtenerVirtualesConEstado(d), error: null }; }
      catch (e) { return { d, virtuales: [], error: e.message || 'No se pudo consultar el F5.' }; }
    })
  );
  const totales = { disponibles: 0, noDisponibles: 0, deshabilitados: 0, desconocidos: 0, nodosArriba: 0, nodosTotal: 0 };
  const virtuales = [];
  const errores = [];
  for (const r of resultados) {
    if (r.error) { errores.push({ dispositivo: r.d.nombre, error: r.error }); continue; }
    for (const v of r.virtuales) {
      let clase;
      if (!v.habilitado) { totales.deshabilitados += 1; clase = 'deshabilitado'; }
      else if (v.estado === 'available') { totales.disponibles += 1; clase = 'disponible'; }
      else if (v.estado === 'offline') { totales.noDisponibles += 1; clase = 'offline'; }
      else { totales.desconocidos += 1; clase = 'desconocido'; }
      if (Number.isFinite(v.nodosTotal)) { totales.nodosTotal += v.nodosTotal; totales.nodosArriba += v.nodosArriba || 0; }
      const nodosCaidos = Number.isFinite(v.nodosTotal) && (v.nodosArriba || 0) < v.nodosTotal;
      const problema = v.habilitado && (v.estado !== 'available' || nodosCaidos);
      virtuales.push({
        dispositivo: r.d.nombre,
        nombre: v.nombre,
        destino: v.destino ? String(v.destino).split('/').pop() : null,
        clase,
        estado: v.estado,
        motivo: v.motivoEstado,
        nodosArriba: v.nodosArriba,
        nodosTotal: v.nodosTotal,
        conexiones: Number.isFinite(Number(v.conexionesActuales)) ? Number(v.conexionesActuales) : null,
        problema,
      });
    }
  }
  const rango = (v) => (v.clase === 'offline' ? 0 : v.problema ? 1 : v.clase === 'desconocido' ? 2 : v.clase === 'disponible' ? 3 : 4);
  virtuales.sort((a, b) => rango(a) - rango(b) || nombreOrden(a.nombre, b.nombre));
  const problemas = virtuales.filter((v) => v.problema).length;
  return {
    configurado: true,
    catalogo,
    totales,
    problemas,
    virtuales: (op.soloProblemas ? virtuales.filter((v) => v.problema) : virtuales).slice(0, 300),
    errores,
  };
}

// ---- F5 en vivo: lecturas de /virtual/stats compartidas por todos los usuarios + historia corta en memoria ----
const HISTORIA_MAX = 180;          // 15 min a 5 s
const historia = new Map();         // `${dispositivo}|${fullPath}` -> [[t, inBps, outBps, conn, rps, nuevas]]

function guardarPunto(dispositivoId, fullPath, t, tr) {
  const k = `${dispositivoId}|${fullPath}`;
  let arr = historia.get(k);
  if (!arr) { arr = []; historia.set(k, arr); }
  arr.push([t, tr.entradaBps, tr.salidaBps, tr.conexionesActuales, tr.peticionesPorSeg, tr.conexionesNuevasPorSeg]);
  if (arr.length > HISTORIA_MAX) arr.splice(0, arr.length - HISTORIA_MAX);
}

async function leerStatsVirtuales(dispositivo) {
  const data = await peticionF5(dispositivo, '/mgmt/tm/ltm/virtual/stats');
  const lista = [];
  for (const entrada of Object.values(data.entries || {})) {
    const campos = entrada.nestedStats?.entries || {};
    const fullPath = leer(campos.tmName);
    if (!fullPath) continue;
    lista.push({ fullPath, contadores: extraerContadores(campos, 'clientside'), estado: extraerEstado(campos) });
  }
  return lista;
}

/** Una muestra de TODOS los Virtual Servers del equipo (cada 3 s como máximo, sin importar cuántos usuarios miren). */
function muestraVirtuales(dispositivo) {
  return conCache(`f5vivo:${dispositivo.id}`, 3000, async () => {
    const clave = (fp) => `${dispositivo.id}|virt|${fp}`;
    let lista = await leerStatsVirtuales(dispositivo);
    const sinMuestra = lista.filter((x) => !hayMuestraReciente(clave(x.fullPath)));
    if (sinMuestra.length) {
      sinMuestra.forEach((x) => calcularTrafico(clave(x.fullPath), x.contadores));
      await esperar(1100);
      lista = await leerStatsVirtuales(dispositivo);
    }
    const t = Date.now();
    const virtuales = lista.map((x) => {
      const trafico = calcularTrafico(clave(x.fullPath), x.contadores);
      if (trafico.entradaBps !== null || trafico.salidaBps !== null) guardarPunto(dispositivo.id, x.fullPath, t, trafico);
      return {
        fullPath: x.fullPath,
        nombre: String(x.fullPath).split('/').filter(Boolean).pop() || x.fullPath,
        estado: x.estado.disponibilidad || 'unknown',
        motivo: x.estado.razon || null,
        habilitado: (x.estado.habilitado || 'enabled') !== 'disabled',
        trafico,
      };
    });
    return { t, virtuales };
  });
}

/** Lista liviana de Virtual Servers para el selector (se guarda 60 s). */
function catalogoVirtuales(dispositivo) {
  return conCache(`f5vs:${dispositivo.id}`, 60000, async () => {
    const lista = await leerStatsVirtuales(dispositivo);
    return lista
      .map((x) => ({
        fullPath: x.fullPath,
        nombre: String(x.fullPath).split('/').filter(Boolean).pop() || x.fullPath,
        estado: x.estado.disponibilidad || 'unknown',
        habilitado: (x.estado.habilitado || 'enabled') !== 'disabled',
      }))
      .sort((a, b) => nombreOrden(a.nombre, b.nombre));
  });
}

const suma = (t) => (t.entradaBps ?? 0) + (t.salidaBps ?? 0);

async function datosF5Vivo(req, op) {
  const catalogo = catalogoDispositivos();
  if (!catalogo.length) return { configurado: false };
  const dispositivo = (op.dispositivo && buscarDispositivo(op.dispositivo)) || cargarDispositivosF5()[0];
  const { t, virtuales } = await muestraVirtuales(dispositivo);

  const porRuta = new Map(virtuales.map((v) => [v.fullPath, v]));
  const buscar = (txt) => porRuta.get(txt) || virtuales.find((v) => v.nombre === txt || v.fullPath.endsWith(`/${txt}`));
  let elegidos = []; const noEncontrados = [];
  let automatico = false;
  if (op.vs.length) {
    for (const txt of op.vs) { const v = buscar(txt); if (v) { if (!elegidos.includes(v)) elegidos.push(v); } else noEncontrados.push(txt); }
  } else {
    automatico = true;
    elegidos = [...virtuales].filter((v) => v.habilitado).sort((a, b) => suma(b.trafico) - suma(a.trafico)).slice(0, 3);
  }

  const desde = t - op.minutos * 60 * 1000;
  return {
    configurado: true,
    dispositivos: catalogo,
    dispositivo: String(dispositivo.id),
    dispositivoNombre: dispositivo.nombre,
    muestreadoEn: t,
    totalVirtuales: virtuales.length,
    automatico,
    noEncontrados,
    seleccion: elegidos.map((v) => {
      const h = (historia.get(`${dispositivo.id}|${v.fullPath}`) || []).filter((p) => p[0] >= desde);
      return {
        fullPath: v.fullPath,
        nombre: v.nombre,
        estado: v.estado,
        motivo: v.motivo,
        habilitado: v.habilitado,
        actual: {
          entradaBps: v.trafico.entradaBps,
          salidaBps: v.trafico.salidaBps,
          conexiones: v.trafico.conexionesActuales,
          conexionesNuevasPorSeg: v.trafico.conexionesNuevasPorSeg,
          peticionesPorSeg: v.trafico.peticionesPorSeg,
          conexionesMaximas: v.trafico.conexionesMaximas,
        },
        // [t, entradaBps, salidaBps, conexiones, peticionesPorSeg, conexionesNuevasPorSeg]
        historia: h,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
module.exports = {
  conCache,
  NORMALIZAR,
  catalogoVirtuales,
  catalogoDispositivos,
  PROVEEDORES: {
    portainer_flota: datosPortainerFlota,
    portainer_problemas: datosPortainerProblemas,
    portainer_consumo: datosPortainerConsumo,
    portainer_tendencia: datosPortainerTendencia,
    f5_trafico: datosF5Trafico,
    f5_salud: datosF5Salud,
    f5_vivo: datosF5Vivo,
  },
  _prueba: { clasificar, resumenEntorno, tramoSeg },
};
