// Kit para describir un informe como DATOS (sin HTML ni PDF): KPIs, hallazgos,
// gráficos y tablas. Un mismo informe alimenta la pantalla, el PDF, el Excel y
// el correo — por eso todo es JSON puro (sin funciones). Los formatos y los
// colores se piden por nombre (fmt: 'n' | 'pct' | 'seg'…, tono: 'ok' | 'warn'
// | 'danger' | 'brand') y cada salida los traduce a lo suyo.

const F = require('./formato');

const TONOS = ['ok', 'warn', 'danger', 'brand'];
const NIVELES = ['ok', 'info', 'aviso', 'critico'];

// Paleta de series (misma que el resto de la app: primero la de marca).
const PALETA = ['#673ab7', '#0ea5e9', '#16a34a', '#d97706', '#dc2626', '#0d9488', '#db2777', '#64748b'];
const COLOR_TONO = { ok: '#16a34a', warn: '#d97706', danger: '#dc2626', brand: '#673ab7', neutro: '#64748b' };
const COLOR_NIVEL = { ok: '#16a34a', info: '#0ea5e9', aviso: '#d97706', critico: '#dc2626' };

// ---------- Utilidades de número/porcentaje ----------
const n0 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));
const redondo = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : +Number(v).toFixed(d));
const porcentaje = (parte, total, d = 1) => (n0(total) > 0 ? redondo((n0(parte) / n0(total)) * 100, d) : null);
const suma = (arr, f) => arr.reduce((a, x) => a + n0(f ? f(x) : x), 0);
const promedio = (arr, f) => (arr.length ? suma(arr, f) / arr.length : null);

// Cambio porcentual actual vs. anterior (null si no hay base).
function cambioPct(actual, anterior) {
  if (anterior === null || anterior === undefined || actual === null || actual === undefined) return null;
  if (Number(anterior) === 0) return Number(actual) === 0 ? 0 : null;
  return Math.round(((Number(actual) - Number(anterior)) / Math.abs(Number(anterior))) * 100);
}

// Compara contra el periodo anterior y decide si el cambio es bueno o malo.
// mejorSiBaja: true cuando "menos es mejor" (errores, vencidos, latencia).
function delta(actual, anterior, { mejorSiBaja = false, etiqueta = 'vs. periodo anterior', fmt = 'n', puntos = false } = {}) {
  if (anterior === null || anterior === undefined || actual === null || actual === undefined) return null;
  let texto;
  let diff;
  if (puntos) {
    diff = redondo(Number(actual) - Number(anterior), 2);
    texto = `${diff > 0 ? '+' : ''}${F.num(diff, 2)} pts ${etiqueta}`;
  } else {
    const c = cambioPct(actual, anterior);
    diff = Number(actual) - Number(anterior);
    texto = c === null ? `antes: ${F.formatear(anterior, fmt)}` : `${c > 0 ? '+' : ''}${c} % ${etiqueta}`;
  }
  const igual = Math.abs(diff) < (puntos ? 0.05 : 1e-9);
  const tono = igual ? 'neutro' : ((diff > 0) !== mejorSiBaja ? 'ok' : 'danger');
  return { texto: igual ? `igual ${etiqueta}` : texto, tono };
}

// ---------- Bloques ----------
function kpi(etiqueta, valor, { fmt = 'n', tono = null, delta: d = null, nota = null } = {}) {
  return { etiqueta, valor: valor === undefined ? null : valor, fmt, tono: TONOS.includes(tono) ? tono : null, delta: d, nota };
}

function hallazgo(nivel, titulo, detalle = '') {
  return { nivel: NIVELES.includes(nivel) ? nivel : 'info', titulo, detalle };
}

// columnas: [{ campo, etiqueta, tipo: 'txt'|'num'|'fecha'|'fechahora', fmt?, peso?, tonos?: {valor:tono}, umbral?: {aviso, critico, mayorEsMalo}, barra? }]
function tabla({ id, titulo, descripcion = null, columnas, filas, vacio = 'Sin registros en este periodo.', hoja = null, maxFilas = 1000, ancho = null }) {
  const total = filas.length;
  const limpias = filas.slice(0, maxFilas).map((f) => {
    const o = {};
    for (const c of columnas) {
      let v = f[c.campo];
      if (v instanceof Date) v = c.tipo === 'fechahora' ? F.isoFechaHora(v) : F.isoFecha(v);
      o[c.campo] = v === undefined ? null : v;
    }
    return o;
  });
  return { tipo: 'tabla', id: id || slug(titulo), titulo, descripcion, columnas: columnas.map((c) => ({ tipo: 'txt', ...c })), filas: limpias, totalFilas: total, truncada: total > limpias.length, vacio, hoja: hoja || titulo, ancho };
}

// forma: 'linea' | 'barras' | 'barrasH' | 'dona' | 'area'
// series: [{ nombre, valores:[...], color? }]  (dona usa series[0] + colores por punto)
function grafico({ id, forma, titulo, descripcion = null, etiquetas, series, fmt = 'n', ancho = null, colores = null, apilado = false }) {
  return {
    tipo: 'grafico', id: id || slug(titulo), forma, titulo, descripcion, etiquetas: etiquetas.map(String), fmt, ancho, apilado,
    colores: colores || null,
    series: series.map((s, i) => ({ nombre: s.nombre, valores: s.valores.map((v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v))), color: s.color || PALETA[i % PALETA.length] })),
  };
}

function texto(t) { return { tipo: 'texto', texto: t }; }
function seccion(titulo, bloques, { id = null, descripcion = null } = {}) {
  return { id: id || slug(titulo), titulo, descripcion, bloques: bloques.filter(Boolean) };
}

function slug(t) {
  return String(t || 'bloque').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'bloque';
}

// Un informe es: encabezado + KPIs + hallazgos + secciones (+ notas de alcance).
function informe({ clave, titulo, subtitulo = '', periodo = null, kpis = [], hallazgos = [], secciones = [], notas = [], alcance = null }) {
  const ordenNivel = { critico: 0, aviso: 1, info: 2, ok: 3 };
  return {
    version: 1,
    clave, titulo, subtitulo, periodo, alcance,
    generadoEn: new Date().toISOString(),
    kpis,
    hallazgos: hallazgos.slice().sort((a, b) => ordenNivel[a.nivel] - ordenNivel[b.nivel]),
    secciones: secciones.filter((s) => s && s.bloques.length),
    notas: notas.filter(Boolean),
  };
}

// Ranking {nombre,total} -> gráfico de barras horizontales (el caso más común).
function rankingH(titulo, items, { fmt = 'n', color = PALETA[0], max = 10, nombreSerie = 'Total', ancho = null } = {}) {
  const top = items.slice(0, max);
  if (!top.length) return null;
  return grafico({ forma: 'barrasH', titulo, etiquetas: top.map((i) => i.nombre ?? '—'), series: [{ nombre: nombreSerie, valores: top.map((i) => i.total), color }], fmt, ancho });
}

module.exports = { F, PALETA, COLOR_TONO, COLOR_NIVEL, TONOS, NIVELES, n0, redondo, porcentaje, suma, promedio, cambioPct, delta, kpi, hallazgo, tabla, grafico, texto, seccion, informe, rankingH, slug };

// Tono de una celda según la regla de su columna (mapa de valores o umbrales).
// Lo usan los tres renderizadores para pintar igual.
function tonoDeCelda(col, valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (col.tonos && col.tonos[valor] !== undefined) return col.tonos[valor];
  if (col.umbral && typeof valor === 'number') {
    const { aviso, critico, mayorEsMalo = true } = col.umbral;
    if (mayorEsMalo) {
      if (critico !== undefined && valor >= critico) return 'danger';
      if (aviso !== undefined && valor >= aviso) return 'warn';
    } else {
      if (critico !== undefined && valor <= critico) return 'danger';
      if (aviso !== undefined && valor <= aviso) return 'warn';
    }
    return null;
  }
  return null;
}
module.exports.tonoDeCelda = tonoDeCelda;
