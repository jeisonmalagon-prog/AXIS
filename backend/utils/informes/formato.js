// Formato de valores compartido por los tres "renderizadores" de informes
// (pantalla, PDF y Excel). Un valor se guarda CRUDO en el informe (número,
// fecha ISO) y cada salida lo presenta a su manera; aquí vive el criterio de
// presentación en texto (PDF y correo). Excel usa formatos numéricos nativos
// (ver FORMATOS_EXCEL) para que la celda siga siendo un número.

const TZ = 'America/Bogota';

const num = (v, dec = 0) => Number(v).toLocaleString('es-CO', { minimumFractionDigits: dec, maximumFractionDigits: dec });

function esVacio(v) {
  return v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v));
}

// Un valor de fecha puede llegar como Date (mysql2), 'YYYY-MM-DD' o ISO completo.
function partesFecha(v) {
  if (esVacio(v)) return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m && v.length <= 10) return { a: +m[1], m: +m[2], d: +m[3], h: null, mi: null };
    if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) return { a: +m[1], m: +m[2], d: +m[3], h: m[4] !== undefined ? +m[4] : null, mi: m[5] !== undefined ? +m[5] : null };
  }
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  // Date de mysql2 = hora local del servidor; ISO con zona = se lleva a Bogotá.
  if (v instanceof Date) return { a: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => +f.find((p) => p.type === t).value;
  return { a: g('year'), m: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute') };
}

const dos = (n) => String(n).padStart(2, '0');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fecha(v) {
  const p = partesFecha(v);
  return p ? `${dos(p.d)}/${dos(p.m)}/${p.a}` : '—';
}
function fechaCorta(v) {
  const p = partesFecha(v);
  return p ? `${p.d} ${MESES[p.m - 1]}` : '—';
}
function fechaLarga(v) {
  const p = partesFecha(v);
  return p ? `${p.d} de ${['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][p.m - 1]} de ${p.a}` : '—';
}
function fechaHora(v) {
  const p = partesFecha(v);
  if (!p) return '—';
  return p.h === null ? fecha(v) : `${dos(p.d)}/${dos(p.m)}/${p.a} ${dos(p.h)}:${dos(p.mi)}`;
}
// Fecha ISO 'YYYY-MM-DD' (para guardar en el informe sin zonas horarias).
function isoFecha(v) {
  const p = partesFecha(v);
  return p ? `${p.a}-${dos(p.m)}-${dos(p.d)}` : null;
}
function isoFechaHora(v) {
  const p = partesFecha(v);
  if (!p) return null;
  return `${p.a}-${dos(p.m)}-${dos(p.d)}T${dos(p.h || 0)}:${dos(p.mi || 0)}:00`;
}

function segundos(v) {
  if (esVacio(v)) return '—';
  const s = Number(v);
  if (s < 1) return `${num(s * 1000, 0)} ms`;
  if (s < 60) return `${num(s, s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

function bytes(v) {
  if (esVacio(v)) return '—';
  let n = Number(v);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${num(n, i === 0 ? 0 : 1)} ${u[i]}`;
}

const num1 = (v) => Number(v).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
function compacto(v) {
  if (esVacio(v)) return '—';
  const n = Number(v);
  const a = Math.abs(n);
  if (a >= 1e9) return `${num1(n / 1e9)} MM`;
  if (a >= 1e6) return `${num1(n / 1e6)} M`;
  if (a >= 1e4) return `${num1(n / 1e3)} k`;
  return num(n, Number.isInteger(n) ? 0 : 1);
}

// fmt: n | n1 | n2 | pct | pct0 | seg | gb | bytes | compacto | fecha | fechahora | txt
function formatear(valor, fmt) {
  if (esVacio(valor)) return '—';
  switch (fmt) {
    case 'n': return num(valor, 0);
    case 'n1': return num(valor, 1);
    case 'n2': return num(valor, 2);
    case 'pct': return `${num(valor, 1)} %`;
    case 'pct0': return `${num(valor, 0)} %`;
    case 'seg': return segundos(valor);
    case 'gb': return `${num(valor, 2)} GB`;
    case 'bytes': return bytes(valor);
    case 'compacto': return compacto(valor);
    case 'fecha': return fecha(valor);
    case 'fechahora': return fechaHora(valor);
    default:
      if (typeof valor === 'number') return num(valor, Number.isInteger(valor) ? 0 : 2);
      return String(valor);
  }
}

// Formatos numéricos nativos de Excel (la celda sigue siendo un número).
const FORMATOS_EXCEL = {
  n: '#,##0',
  n1: '#,##0.0',
  n2: '#,##0.00',
  pct: '0.0"%"',
  pct0: '0"%"',
  seg: '0.00" s"',
  gb: '#,##0.00" GB"',
  compacto: '#,##0',
  fecha: 'dd/mm/yyyy',
  fechahora: 'dd/mm/yyyy hh:mm',
};

// Reemplaza lo que Helvetica (WinAnsi) del PDF no sabe dibujar.
const PERMITIDOS = new Set('–—‘’“”•…€™'.split(''));
function paraPdf(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
    .replace(/→/g, '>').replace(/←/g, '<').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/✓|✔/g, 'OK').replace(/×/g, 'x')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[^\u0000-ÿ]/g, (c) => (PERMITIDOS.has(c) ? c : '?'));
}

module.exports = { num, esVacio, fecha, fechaCorta, fechaLarga, fechaHora, isoFecha, isoFechaHora, segundos, bytes, compacto, formatear, FORMATOS_EXCEL, paraPdf, partesFecha };
