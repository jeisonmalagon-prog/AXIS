// Agregación del TRÁFICO por nodo del balanceador F5 para el informe (Fase 2+).
//
// Parte de las lecturas que guarda el muestreo en segundo plano
// (f5HistorialNodos.js, tabla f5_nodo_trafico o memoria): una fila por nodo y
// lectura con lo ocurrido DESDE LA LECTURA ANTERIOR. Aquí se resumen:
//   - por nodo (miembro de un pool),
//   - por pool (suma de sus nodos en cada lectura; es la forma correcta de
//     hablar de un Virtual Server, porque el tráfico se mide en el pool),
//   - por día para todo el equipo (velocidad promedio y pico, conexiones pico,
//     conexiones nuevas, datos transferidos).
//
// Toda la agregación es en JS sobre una lista plana de filas, así funciona igual
// si el histórico vino de la base de datos o de la memoria.

const { resumirNodo } = require('./f5HistorialNodos');

const CUBETA_MS = 5 * 60 * 1000; // lecturas de distintos pools se alinean en tramos de 5 min

const dosDigitos = (n) => String(n).padStart(2, '0');
// Día LOCAL del servidor (mismo criterio que DATE() en las consultas a la BD).
function claveDia(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`;
}

const redondear = (n, d = 0) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
const sumaONull = (valores) => {
  const v = valores.filter((x) => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

// Une las filas de varios nodos del MISMO pool que comparten instante en una
// sola fila "del pool" (conexiones y bits se suman).
function filasDePool(filasNodos) {
  const porT = new Map();
  for (const f of filasNodos) {
    let g = porT.get(f.t);
    if (!g) { g = { t: f.t, seg: null, conn: null, nuevas: null, bitsIn: null, bitsOut: null }; porT.set(f.t, g); }
    if (f.seg) g.seg = Math.max(g.seg || 0, f.seg);
    const suma = (campo) => { if (f[campo] !== null && f[campo] !== undefined) g[campo] = (g[campo] || 0) + f[campo]; };
    suma('conn'); suma('nuevas'); suma('bitsIn'); suma('bitsOut');
  }
  return [...porT.values()].sort((a, b) => a.t - b.t);
}

// filas: lista plana de leerFilasDispositivo(). Devuelve:
//   { porNodo: Map("pool|miembro" -> resumen), porPool: Map(pool -> resumen), diario: [...], periodo: {...} }
function agregarTrafico(filas, intervaloSeg) {
  const nodos = new Map();   // "pool\0miembro" -> filas
  const pools = new Map();   // pool -> filas de todos sus nodos
  for (const f of filas) {
    const kn = `${f.pool}\u0000${f.miembro}`;
    if (!nodos.has(kn)) nodos.set(kn, []);
    nodos.get(kn).push(f);
    if (!pools.has(f.pool)) pools.set(f.pool, []);
    pools.get(f.pool).push(f);
  }

  const porNodo = new Map();
  for (const [k, lista] of nodos) {
    const [pool, miembro] = k.split('\u0000');
    porNodo.set(`${pool}|${miembro}`, resumirNodo(lista, intervaloSeg));
  }
  const porPool = new Map();
  for (const [pool, lista] of pools) porPool.set(pool, resumirNodo(filasDePool(lista), intervaloSeg));

  // ---- Todo el equipo por día ----
  // Primero se alinean las lecturas de todos los pools en tramos de 5 min; en
  // cada tramo las conexiones y los bits se suman (tráfico simultáneo del equipo).
  const cubetas = new Map();
  for (const f of filas) {
    const i = Math.floor(f.t / CUBETA_MS);
    let c = cubetas.get(i);
    if (!c) { c = { t: i * CUBETA_MS, conn: null, nuevas: 0, bitsIn: 0, bitsOut: 0, segs: [], hayTasa: false }; cubetas.set(i, c); }
    if (f.conn !== null) c.conn = (c.conn || 0) + f.conn;
    if (f.seg) {
      c.hayTasa = true;
      c.segs.push(f.seg);
      c.bitsIn += f.bitsIn || 0; c.bitsOut += f.bitsOut || 0; c.nuevas += f.nuevas || 0;
    }
  }

  const dias = new Map();
  let periodo = {
    entradaPicoBps: 0, entradaPicoEn: null, salidaPicoBps: 0, salidaPicoEn: null, conexionesPico: 0, conexionesPicoEn: null,
    bitsIn: 0, bitsOut: 0, segs: 0, nuevas: 0,
  };
  for (const c of [...cubetas.values()].sort((a, b) => a.t - b.t)) {
    const dia = claveDia(c.t);
    let d = dias.get(dia);
    if (!d) {
      d = { fecha: dia, bitsIn: 0, bitsOut: 0, segs: 0, nuevas: 0, picoIn: 0, picoOut: 0, connPico: 0, lecturas: 0 };
      dias.set(dia, d);
    }
    d.lecturas++;
    if (c.conn !== null && c.conn > d.connPico) d.connPico = c.conn;
    if (c.conn !== null && c.conn > periodo.conexionesPico) { periodo.conexionesPico = c.conn; periodo.conexionesPicoEn = c.t; }
    if (c.hayTasa) {
      const seg = c.segs.reduce((a, b) => a + b, 0) / c.segs.length;
      const rin = c.bitsIn / seg; const rout = c.bitsOut / seg;
      d.bitsIn += c.bitsIn; d.bitsOut += c.bitsOut; d.segs += seg; d.nuevas += c.nuevas;
      if (rin > d.picoIn) d.picoIn = rin;
      if (rout > d.picoOut) d.picoOut = rout;
      periodo.bitsIn += c.bitsIn; periodo.bitsOut += c.bitsOut; periodo.segs += seg; periodo.nuevas += c.nuevas;
      if (rin > periodo.entradaPicoBps) { periodo.entradaPicoBps = rin; periodo.entradaPicoEn = c.t; }
      if (rout > periodo.salidaPicoBps) { periodo.salidaPicoBps = rout; periodo.salidaPicoEn = c.t; }
    }
  }

  const diario = [...dias.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)).map((d) => ({
    fecha: d.fecha,
    entradaPromBps: d.segs ? redondear(d.bitsIn / d.segs) : null,
    salidaPromBps: d.segs ? redondear(d.bitsOut / d.segs) : null,
    entradaPicoBps: d.segs ? redondear(d.picoIn) : null,
    salidaPicoBps: d.segs ? redondear(d.picoOut) : null,
    conexionesPico: d.connPico,
    conexionesNuevas: Math.round(d.nuevas),
    datosEntradaBytes: Math.round(d.bitsIn / 8),
    datosSalidaBytes: Math.round(d.bitsOut / 8),
    lecturas: d.lecturas,
  }));

  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const resumenPeriodo = {
    entradaPromBps: periodo.segs ? redondear(periodo.bitsIn / periodo.segs) : null,
    salidaPromBps: periodo.segs ? redondear(periodo.bitsOut / periodo.segs) : null,
    entradaPicoBps: periodo.segs ? redondear(periodo.entradaPicoBps) : null,
    entradaPicoEn: iso(periodo.entradaPicoEn),
    salidaPicoBps: periodo.segs ? redondear(periodo.salidaPicoBps) : null,
    salidaPicoEn: iso(periodo.salidaPicoEn),
    conexionesPico: cubetas.size ? periodo.conexionesPico : null,
    conexionesPicoEn: iso(periodo.conexionesPicoEn),
    conexionesNuevas: Math.round(periodo.nuevas),
    datosEntradaBytes: Math.round(periodo.bitsIn / 8),
    datosSalidaBytes: Math.round(periodo.bitsOut / 8),
  };

  return { porNodo, porPool, diario, resumenPeriodo, primeraLectura: filas.length ? iso(filas[0].t) : null, totalLecturas: filas.length };
}

module.exports = { agregarTrafico, claveDia, sumaONull };
