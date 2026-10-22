// Histórico de TRÁFICO por nodo (miembro de pool) del balanceador F5.
//
// El F5 solo entrega contadores acumulados, así que cada vez que el muestreo
// en segundo plano (utils/f5ActividadNodos.js, cada F5_ACTIVIDAD_INTERVALO_MS,
// 5 min por defecto) lee un nodo se guarda una fila con lo ocurrido DESDE LA
// LECTURA ANTERIOR: segundos transcurridos, conexiones abiertas en ese
// momento, conexiones nuevas y bits de entrada/salida (deltas). De ahí salen
// las velocidades (bits / segundos), los totales transferidos y los picos.
//
// Persistencia: tabla f5_nodo_trafico (solo INSERT y SELECT; la app no borra
// nada). El usuario de BD de producción no tiene DDL: la tabla se crea con
// "Claude outputs/crear_tabla_f5_nodo_trafico.sql". Si no existe, el histórico
// vive solo en memoria (hasta 30 días de lecturas, se pierde al reiniciar).

const { getPool } = require('../db');

const MAX_PUNTOS_MEMORIA = 8640; // 30 días a una lectura cada 5 min, por nodo
const MAX_HORAS = 720;           // rango máximo que se puede consultar (30 días)
const MAX_PUNTOS_GRAFICA = 150;  // la gráfica no necesita más resolución que esto
const BUCKETS_SEG = [300, 600, 900, 1800, 3600, 7200, 14400, 21600];
const REINTENTO_BD_MS = 30 * 60 * 1000;

const claveDe = (dispositivoId, poolPath, miembro) => `${dispositivoId}|${poolPath}|${miembro}`;

const memoria = new Map(); // clave -> [fila]   (fila = { t, seg, conn, nuevas, bitsIn, bitsOut })
const bases = new Map();   // clave -> { t, tot, bitsIn, bitsOut }  (solo las actualiza el muestreo)
let pendientes = [];       // filas por insertar en la BD

// ---------- Base de datos ----------
let bd = { disponible: false, proximoIntento: 0, avisado: false };

async function prepararTabla() {
  const ahora = Date.now();
  if (bd.disponible) return true;
  if (ahora < bd.proximoIntento) return false;
  try {
    const pool = await getPool();
    const [existe] = await pool.query(
      "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'f5_nodo_trafico' LIMIT 1"
    );
    if (!existe.length) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS f5_nodo_trafico (
          Id BIGINT AUTO_INCREMENT PRIMARY KEY,
          dispositivo_id VARCHAR(64) NOT NULL,
          pool_path VARCHAR(255) NOT NULL,
          miembro VARCHAR(120) NOT NULL,
          fecha DATETIME NOT NULL,
          seg INT NULL,
          conn_actuales INT NULL,
          conn_nuevas DOUBLE NULL,
          bits_in DOUBLE NULL,
          bits_out DOUBLE NULL,
          INDEX idx_f5nt_pool_fecha (dispositivo_id, pool_path, fecha)
        )
      `);
    }
    bd.disponible = true;
  } catch (err) {
    bd.proximoIntento = ahora + REINTENTO_BD_MS;
    if (!bd.avisado) {
      bd.avisado = true;
      console.warn(
        'F5: no hay tabla f5_nodo_trafico y no se pudo crear (' + (err.sqlMessage || err.message) + '). ' +
        'El histórico de tráfico por nodo vivirá solo en memoria; ejecuta crear_tabla_f5_nodo_trafico.sql para conservarlo.'
      );
    }
    return false;
  }
  return true;
}

async function guardarHistorial() {
  if (!pendientes.length) return;
  if (!(await prepararTabla())) { pendientes = []; return; } // sigue en memoria
  const lote = pendientes;
  pendientes = [];
  try {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO f5_nodo_trafico (dispositivo_id, pool_path, miembro, fecha, seg, conn_actuales, conn_nuevas, bits_in, bits_out) VALUES ?`,
      [lote.map((f) => [f.dispositivoId, f.poolPath, f.miembro, new Date(f.t), f.seg, f.conn, f.nuevas, f.bitsIn, f.bitsOut])]
    );
  } catch (err) {
    console.warn(`F5: no se pudo guardar el histórico de tráfico de nodos: ${err.sqlMessage || err.message}`);
    // Si el problema fue de permisos, se reintenta la verificación más tarde.
    bd = { ...bd, disponible: false, proximoIntento: Date.now() + REINTENTO_BD_MS };
  }
}

// ---------- Registro ----------
// `contadores` viene de extraerContadores(campos, 'serverside'). `intervaloMs`
// es el intervalo normal del muestreo: si pasó mucho más que eso desde la
// lectura anterior (backend apagado, F5 inaccesible) no se reparte el
// acumulado como si fuera una velocidad.
function registrarHistorial(dispositivoId, poolPath, miembro, contadores, ahora, intervaloMs) {
  const k = claveDe(dispositivoId, poolPath, miembro);
  const base = bases.get(k);
  const actual = { t: ahora, tot: contadores.totConns, bitsIn: contadores.bitsIn, bitsOut: contadores.bitsOut };
  bases.set(k, actual);

  let seg = null; let nuevas = null; let bitsIn = null; let bitsOut = null;
  if (base && ahora - base.t >= 1000 && ahora - base.t <= intervaloMs * 3) {
    const delta = (a, b) => (a === null || b === null || a === undefined || b === undefined || a < b ? null : a - b);
    seg = Math.round((ahora - base.t) / 1000);
    nuevas = delta(actual.tot, base.tot);
    bitsIn = delta(actual.bitsIn, base.bitsIn);
    bitsOut = delta(actual.bitsOut, base.bitsOut);
  }
  const fila = { dispositivoId, poolPath, miembro, t: ahora, seg, conn: contadores.curConns ?? null, nuevas, bitsIn, bitsOut };

  let lista = memoria.get(k);
  if (!lista) { lista = []; memoria.set(k, lista); }
  lista.push(fila);
  if (lista.length > MAX_PUNTOS_MEMORIA) lista.splice(0, lista.length - MAX_PUNTOS_MEMORIA);
  pendientes.push(fila);
  return fila;
}

// Última lectura de histórico de cualquier nodo del pool (ms) o 0.
function ultimaLecturaPool(dispositivoId, poolPath) {
  const prefijo = `${dispositivoId}|${poolPath}|`;
  let max = 0;
  for (const [k, lista] of memoria) {
    if (k.startsWith(prefijo) && lista.length) max = Math.max(max, lista[lista.length - 1].t);
  }
  return max;
}

// ---------- Consulta y agregación ----------
function elegirBucketSeg(rangoSeg, intervaloSeg) {
  const ideal = rangoSeg / MAX_PUNTOS_GRAFICA;
  const candidato = BUCKETS_SEG.find((b) => b >= ideal) || BUCKETS_SEG[BUCKETS_SEG.length - 1];
  return Math.max(candidato, intervaloSeg);
}

async function leerFilas(dispositivoId, poolPath, desdeMs, hastaMs) {
  // Filas por miembro, ordenadas por fecha.
  await guardarHistorial(); // que lo recién muestreado ya esté en la BD
  const porMiembro = new Map();
  if (bd.disponible || (await prepararTabla())) {
    try {
      const pool = await getPool();
      const [filas] = await pool.query(
        `SELECT miembro, fecha, seg, conn_actuales, conn_nuevas, bits_in, bits_out
           FROM f5_nodo_trafico
          WHERE dispositivo_id = ? AND pool_path = ? AND fecha >= ? AND fecha <= ?
          ORDER BY fecha`,
        [dispositivoId, poolPath, new Date(desdeMs), new Date(hastaMs)]
      );
      for (const f of filas) {
        const num = (v) => (v === null || v === undefined ? null : Number(v));
        if (!porMiembro.has(f.miembro)) porMiembro.set(f.miembro, []);
        porMiembro.get(f.miembro).push({
          t: new Date(f.fecha).getTime(), seg: num(f.seg), conn: num(f.conn_actuales),
          nuevas: num(f.conn_nuevas), bitsIn: num(f.bits_in), bitsOut: num(f.bits_out),
        });
      }
      return { porMiembro, fuente: 'bd' };
    } catch (err) {
      console.warn(`F5: no se pudo leer el histórico de tráfico de la BD, se usa la memoria: ${err.message}`);
    }
  }
  const prefijo = `${dispositivoId}|${poolPath}|`;
  for (const [k, lista] of memoria) {
    if (!k.startsWith(prefijo)) continue;
    porMiembro.set(k.slice(prefijo.length), lista.filter((f) => f.t >= desdeMs && f.t <= hastaMs));
  }
  return { porMiembro, fuente: 'memoria' };
}

// Todas las lecturas de TODOS los pools de un dispositivo en un rango, en una
// lista plana [{ pool, miembro, t, seg, conn, nuevas, bitsIn, bitsOut }]. La usa
// el informe de F5 (agrega y resume en JS, así sirve igual con BD o con memoria).
// `fuente` dice de dónde salió ('bd' | 'memoria'); `limitada` avisa si se cortó
// por el tope de filas.
const MAX_FILAS_INFORME = 2000000;
async function leerFilasDispositivo(dispositivoId, desdeMs, hastaMs) {
  await guardarHistorial();
  if (bd.disponible || (await prepararTabla())) {
    try {
      const pool = await getPool();
      const [filas] = await pool.query(
        `SELECT pool_path, miembro, fecha, seg, conn_actuales, conn_nuevas, bits_in, bits_out
           FROM f5_nodo_trafico
          WHERE dispositivo_id = ? AND fecha >= ? AND fecha <= ?
          ORDER BY fecha
          LIMIT ${MAX_FILAS_INFORME}`,
        [dispositivoId, new Date(desdeMs), new Date(hastaMs)]
      );
      const num = (v) => (v === null || v === undefined ? null : Number(v));
      return {
        fuente: 'bd',
        limitada: filas.length >= MAX_FILAS_INFORME,
        filas: filas.map((f) => ({
          pool: f.pool_path, miembro: f.miembro, t: new Date(f.fecha).getTime(), seg: num(f.seg), conn: num(f.conn_actuales),
          nuevas: num(f.conn_nuevas), bitsIn: num(f.bits_in), bitsOut: num(f.bits_out),
        })),
      };
    } catch (err) {
      console.warn(`F5: no se pudo leer el histórico de tráfico de la BD para el informe, se usa la memoria: ${err.message}`);
    }
  }
  const filas = [];
  const prefijo = `${dispositivoId}|`;
  for (const [k, lista] of memoria) {
    if (!k.startsWith(prefijo)) continue;
    const [, pool, ...resto] = k.split('|');
    const miembro = resto.join('|');
    for (const f of lista) {
      if (f.t >= desdeMs && f.t <= hastaMs) filas.push({ pool, miembro, t: f.t, seg: f.seg, conn: f.conn, nuevas: f.nuevas, bitsIn: f.bitsIn, bitsOut: f.bitsOut });
    }
  }
  filas.sort((a, b) => a.t - b.t);
  return { fuente: 'memoria', limitada: false, filas };
}

const redondear = (n, d = 0) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

function resumirNodo(filas, intervaloSeg) {
  let segTot = 0; let bitsIn = 0; let bitsOut = 0; let nuevas = 0; let conTrafico = 0;
  let sumaConn = 0; let nConn = 0;
  let picoIn = { v: 0, t: null }; let picoOut = { v: 0, t: null }; let picoConn = { v: 0, t: null };
  let ultimoTrafico = null;
  for (const f of filas) {
    if (f.conn !== null) {
      sumaConn += f.conn; nConn++;
      if (f.conn > picoConn.v) picoConn = { v: f.conn, t: f.t };
    }
    const hubo = (f.conn || 0) > 0 || (f.nuevas || 0) > 0 || (f.bitsIn || 0) > 0 || (f.bitsOut || 0) > 0;
    if (hubo) { conTrafico++; ultimoTrafico = f.t; }
    if (f.seg) {
      segTot += f.seg; bitsIn += f.bitsIn || 0; bitsOut += f.bitsOut || 0; nuevas += f.nuevas || 0;
      const rin = (f.bitsIn || 0) / f.seg; const rout = (f.bitsOut || 0) / f.seg;
      if (rin > picoIn.v) picoIn = { v: rin, t: f.t };
      if (rout > picoOut.v) picoOut = { v: rout, t: f.t };
    }
  }
  return {
    muestras: filas.length,
    entradaPromBps: segTot ? redondear(bitsIn / segTot) : null,
    salidaPromBps: segTot ? redondear(bitsOut / segTot) : null,
    entradaPicoBps: redondear(picoIn.v), entradaPicoEn: picoIn.t ? new Date(picoIn.t).toISOString() : null,
    salidaPicoBps: redondear(picoOut.v), salidaPicoEn: picoOut.t ? new Date(picoOut.t).toISOString() : null,
    conexionesProm: nConn ? redondear(sumaConn / nConn, 1) : null,
    conexionesPico: picoConn.v, conexionesPicoEn: picoConn.t ? new Date(picoConn.t).toISOString() : null,
    conexionesNuevas: Math.round(nuevas),
    datosEntradaBytes: Math.round(bitsIn / 8), datosSalidaBytes: Math.round(bitsOut / 8),
    minutosConTrafico: Math.round((conTrafico * intervaloSeg) / 60),
    ultimoTraficoEn: ultimoTrafico ? new Date(ultimoTrafico).toISOString() : null,
  };
}

// Serie por cubetas de `bucketSeg` segundos alineadas a la hora UTC. Las
// cubetas sin lecturas llevan null (la gráfica corta la línea: es un hueco, no un cero).
function serieNodo(filas, desdeMs, hastaMs, bucketSeg) {
  const bms = bucketSeg * 1000;
  const inicio = Math.floor(desdeMs / bms) * bms;
  const n = Math.max(1, Math.ceil((hastaMs - inicio) / bms));
  const cub = Array.from({ length: n }, () => ({ seg: 0, bitsIn: 0, bitsOut: 0, picoIn: 0, picoOut: 0, connMax: null, connSuma: 0, connN: 0, nuevas: 0, hayTasa: false }));
  for (const f of filas) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((f.t - inicio) / bms)));
    const c = cub[i];
    if (f.conn !== null) { c.connMax = Math.max(c.connMax ?? 0, f.conn); c.connSuma += f.conn; c.connN++; }
    if (f.seg) {
      c.hayTasa = true; c.seg += f.seg; c.bitsIn += f.bitsIn || 0; c.bitsOut += f.bitsOut || 0; c.nuevas += f.nuevas || 0;
      c.picoIn = Math.max(c.picoIn, (f.bitsIn || 0) / f.seg);
      c.picoOut = Math.max(c.picoOut, (f.bitsOut || 0) / f.seg);
    }
  }
  return cub.map((c, i) => ({
    t: new Date(inicio + i * bms).toISOString(),
    entradaBps: c.hayTasa ? redondear(c.bitsIn / c.seg) : null,
    salidaBps: c.hayTasa ? redondear(c.bitsOut / c.seg) : null,
    entradaPicoBps: c.hayTasa ? redondear(c.picoIn) : null,
    salidaPicoBps: c.hayTasa ? redondear(c.picoOut) : null,
    conexiones: c.connMax,
    nuevasPorSeg: c.hayTasa ? redondear(c.nuevas / c.seg, 2) : null,
  }));
}

function separarMiembro(miembro) {
  const m = String(miembro).match(/^(.*):(\d{1,5})$/);
  return m ? { direccion: m[1], puerto: Number(m[2]) } : { direccion: miembro, puerto: null };
}

// Histórico de TODOS los nodos de un pool en las últimas `horas`.
// `miembrosActuales` (opcional) agrega los nodos del pool que aún no tienen lecturas.
async function consultarHistorial(dispositivoId, poolPath, horas, intervaloMs, miembrosActuales = []) {
  const h = Math.min(MAX_HORAS, Math.max(1, Number(horas) || 24));
  const hastaMs = Date.now();
  const desdeMs = hastaMs - h * 3600 * 1000;
  const intervaloSeg = Math.round(intervaloMs / 1000);
  const bucketSeg = elegirBucketSeg(h * 3600, intervaloSeg);

  const { porMiembro, fuente } = await leerFilas(dispositivoId, poolPath, desdeMs, hastaMs);
  const nombres = [...new Set([...miembrosActuales, ...porMiembro.keys()])]
    .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));

  const nodos = nombres.map((miembro) => {
    const filas = porMiembro.get(miembro) || [];
    return { miembro, ...separarMiembro(miembro), resumen: resumirNodo(filas, intervaloSeg), puntos: serieNodo(filas, desdeMs, hastaMs, bucketSeg) };
  });

  // Total del pool por cubeta (suma de nodos que tienen dato en esa cubeta).
  const totalPuntos = nodos.length ? nodos[0].puntos.map((p, i) => {
    const con = nodos.map((n) => n.puntos[i]);
    const suma = (campo) => {
      const v = con.map((x) => x[campo]).filter((x) => x !== null);
      return v.length ? redondear(v.reduce((a, b) => a + b, 0), campo === 'nuevasPorSeg' ? 2 : 0) : null;
    };
    return { t: p.t, entradaBps: suma('entradaBps'), salidaBps: suma('salidaBps'), conexiones: suma('conexiones'), nuevasPorSeg: suma('nuevasPorSeg') };
  }) : [];

  return {
    pool: poolPath,
    desde: new Date(desdeMs).toISOString(),
    hasta: new Date(hastaMs).toISOString(),
    horas: h,
    bucketSegundos: bucketSeg,
    intervaloMuestreoSegundos: intervaloSeg,
    fuente,
    nodos,
    total: totalPuntos,
  };
}

module.exports = { registrarHistorial, guardarHistorial, consultarHistorial, ultimaLecturaPool, leerFilasDispositivo, resumirNodo, MAX_HORAS };
