// Diagnóstico de AVR (Application Visibility and Reporting) del F5.
//
// La pantalla "Statistics > Analytics" del F5 guarda histórico por nodo en AVR.
// Este diagnóstico solo LEE (GET) y devuelve qué acepta este equipo, para
// saber cómo pedir por API ese histórico. No modifica nada en el F5.
//
// Lo ya comprobado en este F5 (BIG-IP 17.5):
//   - /mgmt/tm/analytics/http/report/stats?options=view-by pool-member
//     devuelve "transactions" por miembro; acepta además "measures { }" y "limit".
//   - "time-range", "time-granularity", "drilldown-by" y "sort-by" NO son
//     propiedades reconocidas, y "time" no es una entidad válida.
// Ahora se sondean muchos nombres de propiedad y de entidad: el F5 contesta
// distinto a un nombre desconocido que a uno conocido con valor inválido.

const { peticionF5 } = require('./f5Cliente');

const REPORTE = '/mgmt/tm/analytics/http/report/stats?options=';
const opciones = (txt) => `${REPORTE}${encodeURIComponent(txt)}`;

// Ya comprobado: "range" (fecha-hora UTC), "order-by", "drilldown" y "format" son
// propiedades reconocidas; "pool-name" y otras (virtual, url, client-ip,
// application, response-code, user-agent, country, browser, os) son entidades
// válidas; "time" no. Ahora se busca el FORMATO de "range" (para pedir ventanas
// de tiempo y armar la serie por horas) y las MEDIDAS válidas (bytes, latencia).
const MEDIDAS = [
  'transactions', 'max-tps', 'avg-tps', 'tps', 'throughput-request', 'throughput-response', 'request-throughput',
  'response-throughput', 'max-request-throughput', 'max-response-throughput', 'avg-request-throughput',
  'avg-response-throughput', 'server-latency', 'page-load-time', 'client-latency', 'bytes-in', 'bytes-out',
  'request-bytes', 'response-bytes', 'connections', 'new-connections', 'concurrent-connections',
  'max-connections', 'avg-server-latency', 'max-server-latency', 'request-count', 'hits',
];

const pad = (n) => String(n).padStart(2, '0');
const utc = (d, f) => {
  const [Y, M, D, h, m, s] = [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), pad(d.getUTCHours()), pad(d.getUTCMinutes()), pad(d.getUTCSeconds())];
  return f
    .replace('YYYY', Y).replace('MM', M).replace('DD', D).replace('hh', h).replace('mm', m).replace('ss', s);
};
function candidatosRange() {
  const fin = new Date(Math.floor(Date.now() / 3600000) * 3600000 - 3600000);
  const ini = new Date(fin.getTime() - 3600000);
  const formatos = ['YYYY-MM-DDThh:mm:ssZ', 'YYYY-MM-DDThh:mm:ss', 'YYYY-MM-DD:hh:mm:ss', 'YYYYMMDDThhmmssZ', 'YYYYMMDDhh:mm:ss', 'YYYY-MM-DD hh:mm:ss'];
  const c = [];
  for (const f of formatos) {
    const A = utc(ini, f); const B = utc(fin, f);
    const q = (v) => (v.includes(' ') ? `"${v}"` : v);
    c.push(`range ${q(A)}`);
    c.push(`range ${q(A)} ${q(B)}`);
  }
  c.push(`range { start ${utc(ini, 'YYYY-MM-DDThh:mm:ssZ')} end ${utc(fin, 'YYYY-MM-DDThh:mm:ssZ')} }`);
  c.push('range now-1h', 'range -1h', 'range last-hour', `range ${Math.floor(ini.getTime() / 1000)}`);
  return c;
}

const clasificar = (msg) => {
  if (/unknown property/i.test(msg)) return 'desconocida';
  if (/is not a valid entity/i.test(msg)) return 'no-valida';
  return 'otra';
};

const recortar = (obj, max = 1200) => {
  let t;
  try { t = JSON.stringify(obj); } catch { t = String(obj); }
  return t.length > max ? `${t.slice(0, max)}… (${t.length} caracteres)` : t;
};

async function enLotes(items, tam, fn) {
  for (let i = 0; i < items.length; i += tam) {
    await Promise.all(items.slice(i, i + tam).map(fn));
  }
}

async function diagnosticoAvr(dispositivo) {
  const salida = [];
  const sonda = async (ruta) => {
    try { return { ok: true, datos: await peticionF5(dispositivo, ruta) }; } catch (err) { return { ok: false, msg: String(err.message || err) }; }
  };
  const BASE = 'view-by pool-member measures { transactions }';

  // A) Documentación del propio F5 (descripción de cada propiedad)
  for (const ruta of ['/mgmt/tm/analytics/http/report/example', '/mgmt/tm/analytics/http/scheduled-report/example']) {
    const r = await sonda(ruta);
    salida.push({ ruta, ok: r.ok, respuesta: r.ok ? recortar(r.datos, 16000) : r.msg.slice(0, 500) });
  }

  // B) Medidas
  const medidasValidas = [];
  let nMedidasNo = 0;
  await enLotes(MEDIDAS, 6, async (m) => {
    const r = await sonda(opciones(`view-by pool-member measures { ${m} }`));
    if (r.ok) { medidasValidas.push(m); return; }
    if (/is not a valid measure/i.test(r.msg)) { nMedidasNo++; return; }
    medidasValidas.push(`${m} (?)`);
    salida.push({ ruta: `medida ${m}`, ok: false, respuesta: r.msg.slice(0, 400) });
  });

  // C) Formato de range
  const rangos = candidatosRange();
  const rangosOk = [];
  await enLotes(rangos, 4, async (rg) => {
    const r = await sonda(opciones(`${BASE} ${rg}`));
    if (r.ok) {
      const n = Object.keys(r.datos.entries || {}).length;
      rangosOk.push(rg);
      salida.push({ ruta: `ACEPTADO: ${rg}`, ok: true, respuesta: `${n} nodos. ${recortar(r.datos, 500)}` });
    } else {
      salida.push({ ruta: `range: ${rg}`, ok: false, respuesta: r.msg.slice(0, 300) });
    }
  });

  // D) order-by y drilldown
  for (const extra of ['order-by transactions', 'order-by { transactions } ', 'drilldown none', 'drilldown { zzz }', 'drilldown { entity pool-name values zzz }']) {
    const r = await sonda(opciones(`${BASE} ${extra}`));
    salida.push({ ruta: extra, ok: r.ok, respuesta: r.ok ? recortar(r.datos, 400) : r.msg.slice(0, 400) });
  }

  const resumen = [
    'RESUMEN',
    `Medidas probadas: ${MEDIDAS.length} | no válidas: ${nMedidasNo} | VÁLIDAS: ${medidasValidas.join(', ') || 'ninguna'}`,
    `Formatos de range aceptados: ${rangosOk.length ? rangosOk.join(' || ') : 'ninguno'}`,
  ].join('\n');

  salida.sort((a, b) => Number(b.ok) - Number(a.ok));
  return { dispositivo: dispositivo.id, generadoEn: new Date().toISOString(), resumen, resultados: salida };
}

// ---------------------------------------------------------------------------
// Histórico por nodo desde AVR (lo que muestra "Statistics > Analytics").
//
// Se pide el reporte "view-by pool-member" una vez por cada tramo de tiempo
// (cubeta) con la propiedad `range` del F5 y se arma la serie. La medida
// disponible es "transactions" (transacciones HTTP): solo aparecen los nodos de
// Virtual Servers con perfil de analítica HTTP. El formato exacto del `range`
// (separador y orden de las fechas) se descubre solo la primera vez, probando
// variantes y validando que una ventana de 2 h dé ~el doble que una de 1 h.
// ---------------------------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const HORA = 3600 * 1000;

const FORMATOS_RANGE = [
  { id: 'fin--inicio', fn: (a, b) => `${iso(b)}--${iso(a)}` }, // como el valor por defecto documentado "now--now-1h"
  { id: 'inicio--fin', fn: (a, b) => `${iso(a)}--${iso(b)}` },
  { id: 'inicio,fin', fn: (a, b) => `${iso(a)},${iso(b)}` },
  { id: 'inicio/fin', fn: (a, b) => `${iso(a)}/${iso(b)}` },
  { id: 'inicio_fin', fn: (a, b) => `${iso(a)}_${iso(b)}` },
  { id: 'inicio..fin', fn: (a, b) => `${iso(a)}..${iso(b)}` },
  { id: 'fin,inicio', fn: (a, b) => `${iso(b)},${iso(a)}` },
];

const rutaReporte = (rango) => `${REPORTE}${encodeURIComponent(`view-by pool-member measures { transactions } limit 1000 range ${rango}`)}`;

// Respuesta del F5 -> Map(miembro "ip:puerto" -> transacciones)
function leerReporte(datos) {
  const mapa = new Map();
  for (const e of Object.values((datos && datos.entries) || {})) {
    const c = (e.nestedStats && e.nestedStats.entries) || {};
    const nombre = c.tmName && c.tmName.description;
    const n = Number(c.transactions && c.transactions.description);
    if (nombre && Number.isFinite(n)) mapa.set(nombre, n);
  }
  return mapa;
}

const suma = (mapa) => [...mapa.values()].reduce((a, b) => a + b, 0);
const formatosDescubiertos = new Map(); // dispositivo.id -> { formato } | { error, hasta }

async function descubrirFormatoRange(dispositivo) {
  const previo = formatosDescubiertos.get(dispositivo.id);
  if (previo && previo.formato) return previo.formato;
  if (previo && previo.hasta > Date.now()) throw new Error(previo.error);

  const intentos = [];
  // Cuatro parejas de ventanas (1 h y 2 h terminando a la misma hora) hacia atrás, por si
  // alguna cae en horas sin tráfico.
  const fin0 = Math.floor(Date.now() / HORA) * HORA - HORA;
  for (const desfase of [0, 3, 6, 12]) {
    const fin = fin0 - desfase * HORA;
    for (const formato of FORMATOS_RANGE) {
      try {
        const [uno, dos] = await Promise.all([
          peticionF5(dispositivo, rutaReporte(formato.fn(fin - HORA, fin))),
          peticionF5(dispositivo, rutaReporte(formato.fn(fin - 2 * HORA, fin))),
        ]);
        const t1 = suma(leerReporte(uno));
        const t2 = suma(leerReporte(dos));
        intentos.push(`${formato.id} (desfase ${desfase} h): 1h=${t1}, 2h=${t2}`);
        if (t1 > 0 && t2 / t1 >= 1.3 && t2 / t1 <= 3.2) {
          formatosDescubiertos.set(dispositivo.id, { formato });
          return formato;
        }
      } catch (err) {
        intentos.push(`${formato.id}: ${String(err.message || err).slice(0, 120)}`);
      }
    }
  }
  // Plan B: "range <inicio>" (confirmado en este F5) entrega lo ocurrido desde <inicio> hasta
  // ahora; la diferencia entre dos inicios consecutivos es lo de ese tramo.
  try {
    const finB = fin0;
    const lecturasB = [];
    for (const k of [1, 2, 3]) lecturasB.push(suma(leerReporte(await peticionF5(dispositivo, rutaReporte(iso(finB - k * HORA))))));
    intentos.push(`diferencias: desde -1h=${lecturasB[0]}, -2h=${lecturasB[1]}, -3h=${lecturasB[2]}`);
    if (lecturasB[0] <= lecturasB[1] && lecturasB[1] <= lecturasB[2] && lecturasB[2] > 0) {
      const formato = { id: 'diferencias (range inicio)', difs: true };
      formatosDescubiertos.set(dispositivo.id, { formato });
      return formato;
    }
  } catch (err) {
    intentos.push(`diferencias: ${String(err.message || err).slice(0, 120)}`);
  }
  const error = `No se encontró un formato de "range" que el F5 acepte. Intentos: ${intentos.slice(0, 12).join(' | ')}`;
  formatosDescubiertos.set(dispositivo.id, { error, hasta: Date.now() + 10 * 60 * 1000 });
  throw new Error(error);
}

const cacheCubetas = new Map(); // "dispositivo|desde|tam" -> Map(miembro -> n) | null (sin datos)

function tamanoCubetaSeg(horas) {
  if (horas <= 1) return 300;
  if (horas <= 6) return 900;
  if (horas <= 24) return 3600;
  if (horas <= 168) return 21600;
  return 86400;
}

// miembros: [{ nombre, direccion, puerto }] del pool. Devuelve la serie por nodo.
async function historialAvr(dispositivo, miembros, horas) {
  const formato = await descubrirFormatoRange(dispositivo);
  const tam = tamanoCubetaSeg(horas) * 1000;
  const ahora = Date.now();
  const inicio = Math.floor((ahora - horas * HORA) / tam) * tam;
  const cubetas = [];
  for (let t = inicio; t < ahora; t += tam) cubetas.push(t);

  let errores = 0;
  let primerError = null;
  const lecturas = new Map(); // t -> Map | null
  const pendientes = [];
  for (const t of cubetas) {
    const clave = `${dispositivo.id}|${t}|${tam}`;
    if (cacheCubetas.has(clave)) lecturas.set(t, cacheCubetas.get(clave));
    else pendientes.push(t);
  }
  if (formato.difs) {
    // Cada lectura es "desde t hasta ahora"; el tramo k es la lectura k menos la k+1.
    const acum = new Map();
    await enLotes(cubetas, 4, async (t) => {
      try {
        acum.set(t, leerReporte(await peticionF5(dispositivo, rutaReporte(iso(t)))));
      } catch (err) {
        errores++;
        if (!primerError) primerError = String(err.message || err).slice(0, 200);
        acum.set(t, undefined);
      }
    });
    cubetas.forEach((t, i) => {
      const a = acum.get(t);
      const b = i + 1 < cubetas.length ? acum.get(cubetas[i + 1]) : new Map();
      if (!a || b === undefined) { lecturas.set(t, undefined); return; }
      const m = new Map();
      for (const [k, v] of a) m.set(k, Math.max(0, v - (b.get(k) || 0)));
      lecturas.set(t, m.size ? m : null);
    });
    pendientes.length = 0;
  }
  await enLotes(pendientes, 4, async (t) => {
    const fin = Math.min(t + tam, ahora);
    try {
      const datos = await peticionF5(dispositivo, rutaReporte(formato.fn(t, fin)));
      const mapa = leerReporte(datos);
      const valor = mapa.size ? mapa : null; // sin filas = AVR no tiene datos de ese tramo
      lecturas.set(t, valor);
      // AVR tarda ~1 ciclo (5 min) en consolidar: solo se guardan tramos ya cerrados hace rato.
      if (t + tam <= ahora - 10 * 60 * 1000) cacheCubetas.set(`${dispositivo.id}|${t}|${tam}`, valor);
    } catch (err) {
      errores++;
      if (!primerError) primerError = String(err.message || err).slice(0, 200);
      lecturas.set(t, undefined);
    }
  });

  const claves = (m) => [...new Set([m.nombre, `${m.direccion}:${m.puerto}`].filter(Boolean))];
  // El tramo en curso aún no está completo: su cantidad de transacciones se vería como una
  // caída falsa, así que solo se informa la velocidad (transacciones/s), que sí es comparable.
  const punto = (t, n) => {
    const seg = (Math.min(t + tam, ahora) - t) / 1000;
    const parcial = t + tam > ahora;
    if (n === null) return { t: new Date(t).toISOString(), transacciones: null, tps: null };
    return { t: new Date(t).toISOString(), transacciones: parcial ? null : n, tps: Math.round((n / seg) * 100) / 100 };
  };
  const crudo = miembros.map((m) => ({
    miembro: m.nombre,
    n: cubetas.map((t) => {
      const lec = lecturas.get(t);
      return lec ? claves(m).reduce((acc, k) => (lec.has(k) ? lec.get(k) : acc), 0) : null;
    }),
  }));
  const nodos = crudo.map((c) => ({ miembro: c.miembro, puntos: cubetas.map((t, i) => punto(t, c.n[i])) }));
  const total = cubetas.map((t, i) => {
    const con = crudo.map((c) => c.n[i]).filter((x) => x !== null);
    return punto(t, con.length ? con.reduce((x, y) => x + y, 0) : null);
  });

  return {
    desde: new Date(inicio).toISOString(),
    hasta: new Date(ahora).toISOString(),
    horas,
    bucketSegundos: tam / 1000,
    formatoRange: formato.id,
    nodos,
    total,
    aviso: errores ? `${errores} de ${cubetas.length} tramos no se pudieron leer del F5 (${primerError}).` : null,
  };
}

module.exports = { diagnosticoAvr, historialAvr, descubrirFormatoRange, leerReporte, tamanoCubetaSeg };
