// Renderizador Excel (.xlsx) de un informe descrito con utils/informes/kit.js.
//
// No usa ninguna librería de hojas de cálculo: escribe el OOXML a mano con
// jszip (que el backend ya trae) para poder incluir GRÁFICOS NATIVOS de Excel
// (barras, líneas, dona) que se pueden editar, y estilos reales (encabezados,
// formatos numéricos, semáforos, filtros, paneles inmovilizados).
//
// Hojas: "Resumen" (indicadores + hallazgos + notas), "Gráficos" (cada gráfico
// con su tabla de datos al lado) y una hoja por cada tabla del informe.

const JSZip = require('jszip');
const { F, PALETA, COLOR_TONO, COLOR_NIVEL, tonoDeCelda } = require('./kit');

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colLetra(n) { // 0 -> A
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const ref = (c, r) => `${colLetra(c)}${r + 1}`;
const rgb = (hex) => `FF${hex.replace('#', '').toUpperCase()}`;
function aclarar(hex, t) {
  const p = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${p.map((v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

// Serie de fecha de Excel (días desde 1899-12-30).
function serialFecha(iso) {
  const p = F.partesFecha(iso);
  if (!p) return null;
  const ms = Date.UTC(p.a, p.m - 1, p.d, p.h || 0, p.mi || 0);
  return ms / 86400000 + 25569;
}

// ---------------- Registro de estilos ----------------
class Estilos {
  constructor(marca) {
    this.marca = marca;
    this.fuentes = ['<font><sz val="10"/><color rgb="FF1E293B"/><name val="Calibri"/><family val="2"/></font>'];
    this.rellenos = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    this.bordes = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    this.numFmts = new Map(); // codigo -> id
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    this.cache = new Map();
  }
  _idx(lista, xml) { const i = lista.indexOf(xml); if (i >= 0) return i; lista.push(xml); return lista.length - 1; }
  fmtId(codigo) {
    if (!codigo) return 0;
    if (!this.numFmts.has(codigo)) this.numFmts.set(codigo, 164 + this.numFmts.size);
    return this.numFmts.get(codigo);
  }
  // o: { b, i, sz, color, fill, fmt, h, v, wrap, borde, indent }
  xf(o = {}) {
    const k = JSON.stringify(o);
    if (this.cache.has(k)) return this.cache.get(k);
    const fuente = this._idx(this.fuentes, `<font>${o.b ? '<b/>' : ''}${o.i ? '<i/>' : ''}<sz val="${o.sz || 10}"/><color rgb="${rgb(o.color || '#1e293b')}"/><name val="Calibri"/><family val="2"/></font>`);
    const relleno = o.fill ? this._idx(this.rellenos, `<fill><patternFill patternType="solid"><fgColor rgb="${rgb(o.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const lado = (n, c) => `<${n} style="thin"><color rgb="${rgb(c)}"/></${n}>`;
    let borde = 0;
    if (o.borde === 'fino') borde = this._idx(this.bordes, `<border>${lado('left', '#e2e8f0')}${lado('right', '#e2e8f0')}${lado('top', '#e2e8f0')}${lado('bottom', '#e2e8f0')}<diagonal/></border>`);
    if (o.borde === 'abajo') borde = this._idx(this.bordes, `<border><left/><right/><top/>${lado('bottom', '#cbd5e1')}<diagonal/></border>`);
    const align = (o.h || o.v || o.wrap || o.indent) ? `<alignment${o.h ? ` horizontal="${o.h}"` : ''} vertical="${o.v || 'center'}"${o.wrap ? ' wrapText="1"' : ''}${o.indent ? ` indent="${o.indent}"` : ''}/>` : '';
    const id = this.xfs.length;
    this.xfs.push(`<xf numFmtId="${this.fmtId(o.fmt)}" fontId="${fuente}" fillId="${relleno}" borderId="${borde}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${align ? ' applyAlignment="1"' : ''}>${align}</xf>`);
    this.cache.set(k, id);
    return id;
  }
  xml() {
    const nf = [...this.numFmts.entries()].map(([c, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(c)}"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${nf ? `<numFmts count="${this.numFmts.size}">${nf}</numFmts>` : ''}<fonts count="${this.fuentes.length}">${this.fuentes.join('')}</fonts><fills count="${this.rellenos.length}">${this.rellenos.join('')}</fills><borders count="${this.bordes.length}">${this.bordes.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
}

// ---------------- Hoja ----------------
class Hoja {
  constructor(nombre, estilos) {
    this.nombre = nombre;
    this.est = estilos;
    this.filas = new Map(); // r -> Map(c -> xml)
    this.altos = new Map();
    this.anchos = [];
    this.merges = [];
    this.freeze = null; // { fila, col }
    this.autofiltro = null;
    this.extra = []; // conditionalFormatting
    this.dibujo = null;
    this.tabColor = null;
    this.charts = [];
  }
  _celda(c, r, xml) { if (!this.filas.has(r)) this.filas.set(r, new Map()); this.filas.get(r).set(c, xml); }
  texto(c, r, valor, estilo) {
    const s = estilo === undefined ? 0 : estilo;
    if (valor === null || valor === undefined || valor === '') { this._celda(c, r, `<c r="${ref(c, r)}" s="${s}"/>`); return; }
    this._celda(c, r, `<c r="${ref(c, r)}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(valor)}</t></is></c>`);
  }
  numero(c, r, valor, estilo) {
    if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) { this._celda(c, r, `<c r="${ref(c, r)}" s="${estilo || 0}"/>`); return; }
    this._celda(c, r, `<c r="${ref(c, r)}" s="${estilo || 0}"><v>${Number(valor)}</v></c>`);
  }
  vacio(c, r, estilo) { this._celda(c, r, `<c r="${ref(c, r)}" s="${estilo || 0}"/>`); }
  ancho(c, w) { this.anchos[c] = w; }
  alto(r, h) { this.altos.set(r, h); }
  merge(c1, r1, c2, r2) { this.merges.push(`${ref(c1, r1)}:${ref(c2, r2)}`); }

  xml(tieneDibujo) {
    const filas = [...this.filas.keys()].sort((a, b) => a - b).map((r) => {
      const celdas = [...this.filas.get(r).entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]).join('');
      const h = this.altos.get(r);
      return `<row r="${r + 1}"${h ? ` ht="${h}" customHeight="1"` : ''}>${celdas}</row>`;
    }).join('');
    const cols = this.anchos.map((w, i) => (w ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : '')).join('');
    const pane = this.freeze
      ? `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane${this.freeze.col ? ` xSplit="${this.freeze.col}"` : ''} ySplit="${this.freeze.fila}" topLeftCell="${ref(this.freeze.col || 0, this.freeze.fila)}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${this.tabColor ? `<sheetPr><tabColor rgb="${rgb(this.tabColor)}"/></sheetPr>` : ''}${pane}<sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${filas}</sheetData>${this.autofiltro ? `<autoFilter ref="${this.autofiltro}"/>` : ''}${this.merges.length ? `<mergeCells count="${this.merges.length}">${this.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}${this.extra.join('')}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToHeight="0"/>${tieneDibujo ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
  }
}

function nombreHojaUnico(base, usados) {
  let n = String(base || 'Hoja').replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Hoja';
  let k = 2;
  const original = n;
  while (usados.has(n.toLowerCase())) { const suf = ` ${k++}`; n = original.slice(0, 31 - suf.length) + suf; }
  usados.add(n.toLowerCase());
  return n;
}

// ---------------- Gráficos nativos ----------------
const NS_C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const txPr = (sz = 900, color = '64748B', b = 0) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${b}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="es-CO"/></a:p></c:txPr>`;
const rellenoSolido = (hex) => `<a:solidFill><a:srgbClr val="${hex.replace('#', '').toUpperCase()}"/></a:solidFill>`;

function xmlTitulo(texto) {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100" b="1"><a:solidFill><a:srgbClr val="1E293B"/></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="es-CO" sz="1100" b="1"><a:solidFill><a:srgbClr val="1E293B"/></a:solidFill></a:rPr><a:t>${esc(texto)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

// g: bloque gráfico; datos: { hoja, fila0 (cabecera), c0 (columna de etiquetas) } con los datos ya escritos en la hoja.
function xmlGrafico(g, d) {
  const n = g.etiquetas.length;
  const q = (nombre) => `'${nombre.replace(/'/g, "''")}'`;
  const cat = (c) => `<c:cat><c:strRef><c:f>${q(d.hoja)}!$${colLetra(d.c0)}$${d.fila0 + 2}:$${colLetra(d.c0)}$${d.fila0 + 1 + n}</c:f><c:strCache><c:ptCount val="${n}"/>${g.etiquetas.map((e, i) => `<c:pt idx="${i}"><c:v>${esc(e)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat>`;
  const val = (s, j) => {
    const col = colLetra(d.c0 + 1 + j);
    return `<c:val><c:numRef><c:f>${q(d.hoja)}!$${col}$${d.fila0 + 2}:$${col}$${d.fila0 + 1 + n}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${s.valores.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache></c:numRef></c:val>`;
  };
  const tx = (s, j) => `<c:tx><c:strRef><c:f>${q(d.hoja)}!$${colLetra(d.c0 + 1 + j)}$${d.fila0 + 1}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(s.nombre)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`;
  const fmtCode = ({ pct: '0.0"%"', seg: '0.00" s"', gb: '0.00" GB"', compacto: '#,##0', n: '#,##0', n1: '#,##0.0', n2: '#,##0.00' })[g.fmt] || '#,##0';
  const ejeCat = (pos, extra = '') => `<c:catAx><c:axId val="111"/><c:scaling><c:orientation val="${extra ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln></c:spPr>${txPr(900)}<c:crossAx val="222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const ejeVal = (pos, cruce = 'autoZero') => `<c:valAx><c:axId val="222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${esc(fmtCode)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900)}<c:crossAx val="111"/><c:crosses val="${cruce}"/><c:crossBetween val="between"/></c:valAx>`;

  let plot;
  if (g.forma === 'dona') {
    const s = g.series[0];
    const dpts = g.etiquetas.map((_, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${rellenoSolido((g.colores && g.colores[i]) || PALETA[i % PALETA.length])}<a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('');
    plot = `<c:doughnutChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/>${tx(s, 0)}${dpts}<c:dLbls><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900, '1E293B', 1)}<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>${cat()}${val(s, 0)}</c:ser><c:firstSliceAng val="0"/><c:holeSize val="58"/></c:doughnutChart>`;
  } else if (g.forma === 'linea' || g.forma === 'area') {
    const sers = g.series.map((s, j) => `<c:ser><c:idx val="${j}"/><c:order val="${j}"/>${tx(s, j)}<c:spPr><a:ln w="28575" cap="rnd">${rellenoSolido(s.color)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="${n <= 31 ? 'circle' : 'none'}"/><c:size val="5"/><c:spPr>${rellenoSolido(s.color)}<a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>${cat()}${val(s, j)}<c:smooth val="0"/></c:ser>`).join('');
    plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/><c:axId val="111"/><c:axId val="222"/></c:lineChart>${ejeCat('b')}${ejeVal('l')}`;
  } else {
    const horizontal = g.forma === 'barrasH';
    const sers = g.series.map((s, j) => {
      const dpts = horizontal && g.series.length === 1 && g.colores ? g.etiquetas.map((_, i) => `<c:dPt><c:idx val="${i}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr>${rellenoSolido(g.colores[i] || s.color)}</c:spPr></c:dPt>`).join('') : '';
      const etiquetas = horizontal || (n * g.series.length <= 14 && !g.apilado) ? `<c:dLbls><c:numFmt formatCode="${esc(fmtCode)}" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(850, '1E293B', 1)}<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>` : '';
      return `<c:ser><c:idx val="${j}"/><c:order val="${j}"/>${tx(s, j)}<c:spPr>${rellenoSolido(s.color)}</c:spPr><c:invertIfNegative val="0"/>${dpts}${etiquetas}${cat()}${val(s, j)}</c:ser>`;
    }).join('');
    plot = `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="${g.apilado ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="${horizontal ? 45 : 70}"/>${g.apilado ? '<c:overlap val="100"/>' : ''}<c:axId val="111"/><c:axId val="222"/></c:barChart>${horizontal ? ejeCat('l', 'inv') + ejeVal('b', 'max') : ejeCat('b') + ejeVal('l')}`;
  }
  const leyenda = (g.forma === 'dona' || g.series.length > 1) ? `<c:legend><c:legendPos val="${g.forma === 'dona' ? 'r' : 'b'}"/><c:overlay val="0"/>${txPr(900)}</c:legend>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace ${NS_C}><c:roundedCorners val="0"/><c:chart>${xmlTitulo(g.titulo)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>${leyenda}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:chartSpace>`;
}

function xmlDibujo(anclas) {
  const items = anclas.map((a, i) => `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${a.c1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.r1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${a.c2}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.r2}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Gráfico ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${items}</xdr:wsDr>`;
}

// ---------------- Armado del libro ----------------
async function generarXlsxBuffer(informe, opciones = {}) {
  const marca = /^#[0-9a-fA-F]{6}$/.test(opciones.colorMarca || '') ? opciones.colorMarca : '#673ab7';
  const est = new Estilos(marca);
  const usados = new Set();
  const hojas = [];
  const periodoTxt = informe.periodo ? `${F.fecha(informe.periodo.desde)} — ${F.fecha(informe.periodo.hasta)}` : null;

  // ---------- Hoja Resumen ----------
  const res = new Hoja(nombreHojaUnico('Resumen', usados), est);
  res.tabColor = marca;
  res.ancho(0, 34); res.ancho(1, 36); res.ancho(2, 70);
  const sTitulo = est.xf({ b: 1, sz: 18, color: '#ffffff', fill: marca, v: 'center', indent: 1 });
  const sSub = est.xf({ sz: 10, color: '#ffffff', fill: marca, v: 'center', indent: 1 });
  const sBanda = est.xf({ fill: marca });
  for (let c = 0; c < 3; c++) { res.vacio(c, 0, sBanda); res.vacio(c, 1, sBanda); res.vacio(c, 2, sBanda); }
  res.texto(0, 0, informe.titulo, sTitulo); res.merge(0, 0, 2, 0); res.alto(0, 34);
  res.texto(0, 1, informe.subtitulo || '', sSub); res.merge(0, 1, 2, 1); res.alto(1, 20);
  res.texto(0, 2, [periodoTxt ? `Periodo: ${periodoTxt}` : null, `Generado: ${F.fechaHora(new Date())}`].filter(Boolean).join('      '), sSub); res.merge(0, 2, 2, 2); res.alto(2, 20);
  let r = 4;
  const sSec = est.xf({ b: 1, sz: 12, color: marca, borde: 'abajo' });
  const sCab = est.xf({ b: 1, sz: 9, color: '#64748b', fill: '#f1f5f9', v: 'center', borde: 'fino' });
  const sTxt = est.xf({ borde: 'fino', v: 'center', wrap: 1 });
  const sTxtB = est.xf({ borde: 'fino', v: 'center', wrap: 1, b: 1 });

  if (informe.kpis && informe.kpis.length) {
    for (let c = 0; c < 3; c++) res.vacio(c, r, sSec);
    res.texto(0, r, 'Indicadores', sSec); r += 1;
    res.texto(0, r, 'INDICADOR', sCab); res.texto(1, r, 'VALOR', est.xf({ b: 1, sz: 9, color: '#64748b', fill: '#f1f5f9', v: 'center', borde: 'fino', h: 'right' })); res.texto(2, r, 'DETALLE', sCab); r += 1;
    for (const k of informe.kpis) {
      res.texto(0, r, k.etiqueta, sTxtB);
      const fondo = k.tono && k.tono !== 'brand' ? aclarar(COLOR_TONO[k.tono], 0.86) : undefined;
      const color = k.tono && k.tono !== 'brand' ? COLOR_TONO[k.tono] : '#1e293b';
      const fmtX = F.FORMATOS_EXCEL[k.fmt];
      if (typeof k.valor === 'number' && fmtX) res.numero(1, r, k.valor, est.xf({ b: 1, sz: 11, color, fill: fondo, borde: 'fino', h: 'right', fmt: fmtX }));
      else if (typeof k.valor === 'number') res.numero(1, r, k.valor, est.xf({ b: 1, sz: 11, color, fill: fondo, borde: 'fino', h: 'right', fmt: Number.isInteger(k.valor) ? '#,##0' : '#,##0.00' }));
      else res.texto(1, r, k.fmt === 'seg' || k.fmt === 'pct' ? F.formatear(k.valor, k.fmt) : (k.valor ?? '—'), est.xf({ b: 1, sz: 11, color, fill: fondo, borde: 'fino', h: 'right' }));
      res.texto(2, r, [k.delta ? k.delta.texto : null, k.nota].filter(Boolean).join(' · '), sTxt);
      r += 1;
    }
    r += 1;
  }

  if (informe.hallazgos && informe.hallazgos.length) {
    for (let c = 0; c < 3; c++) res.vacio(c, r, sSec);
    res.texto(0, r, 'Hallazgos clave', sSec); r += 1;
    res.texto(0, r, 'NIVEL', sCab); res.texto(1, r, 'HALLAZGO', sCab); res.texto(2, r, 'DETALLE', sCab); r += 1;
    for (const h of informe.hallazgos) {
      const col = COLOR_NIVEL[h.nivel] || '#64748b';
      res.texto(0, r, ({ critico: 'Crítico', aviso: 'Aviso', info: 'Información', ok: 'Todo bien' })[h.nivel] || 'Información', est.xf({ b: 1, color: col, fill: aclarar(col, 0.88), borde: 'fino', v: 'center' }));
      res.texto(1, r, h.titulo, sTxtB); res.texto(2, r, h.detalle || '', sTxt);
      res.alto(r, Math.max(18, Math.ceil(((h.titulo || '').length / 22 + 0.01)) * 14.5, Math.ceil(((h.detalle || '').length) / 80) * 14.5));
      r += 1;
    }
    r += 1;
  }
  if (informe.notas && informe.notas.length) {
    for (let c = 0; c < 3; c++) res.vacio(c, r, sSec);
    res.texto(0, r, 'Notas y alcance', sSec); r += 1;
    for (const n of informe.notas) {
      res.texto(0, r, n, est.xf({ color: '#64748b', wrap: 1, v: 'top' })); res.merge(0, r, 2, r); res.alto(r, Math.max(15, Math.ceil(n.length / 120) * 14.5)); r += 1;
    }
  }
  hojas.push(res);

  // ---------- Hoja Gráficos ----------
  const graficos = [];
  const tablas = [];
  for (const s of informe.secciones || []) {
    for (const b of s.bloques) {
      if (b.tipo === 'grafico' && b.etiquetas.length && b.series.length) graficos.push({ b, seccion: s.titulo });
      if (b.tipo === 'tabla') tablas.push({ b, seccion: s.titulo });
    }
  }
  const hojaGraf = graficos.length ? new Hoja(nombreHojaUnico('Gráficos', usados), est) : null;
  const anclas = [];
  if (hojaGraf) {
    hojaGraf.tabColor = '#0ea5e9';
    hojaGraf.ancho(0, 26);
    const sCabG = est.xf({ b: 1, sz: 9, color: '#ffffff', fill: marca, v: 'center', h: 'center', borde: 'fino' });
    const sBloque = est.xf({ b: 1, sz: 12, color: marca, borde: 'abajo' });
    let fila = 0;
    graficos.forEach(({ b: g, seccion }, idx) => {
      const ns = g.series.length;
      for (let c = 0; c <= ns + 12; c++) hojaGraf.vacio(c, fila, sBloque);
      hojaGraf.texto(0, fila, `${seccion}  ›  ${g.titulo}`, sBloque);
      const fila0 = fila + 1;
      hojaGraf.texto(0, fila0, 'Categoría', sCabG);
      g.series.forEach((s, j) => { hojaGraf.texto(1 + j, fila0, s.nombre, sCabG); hojaGraf.ancho(1 + j, Math.max(hojaGraf.anchos[1 + j] || 0, 15)); });
      const fmtX = F.FORMATOS_EXCEL[g.fmt] || '#,##0.##';
      g.etiquetas.forEach((e, i) => {
        hojaGraf.texto(0, fila0 + 1 + i, e, est.xf({ borde: 'fino' }));
        g.series.forEach((s, j) => hojaGraf.numero(1 + j, fila0 + 1 + i, s.valores[i], est.xf({ borde: 'fino', fmt: fmtX })));
      });
      const alto = Math.max(g.etiquetas.length + 2, 18);
      const c1 = ns + 2;
      anclas.push({ c1, r1: fila0, c2: c1 + 9, r2: fila0 + Math.max(17, Math.min(alto, 22)), g, datos: { hoja: hojaGraf.nombre, fila0, c0: 0 } });
      fila = fila0 + Math.max(g.etiquetas.length + 2, 20);
      void idx;
    });
    hojaGraf.charts = anclas;
    hojas.push(hojaGraf);
  }

  // ---------- Una hoja por tabla ----------
  for (const { b, seccion } of tablas) {
    const h = new Hoja(nombreHojaUnico(b.hoja || b.titulo, usados), est);
    h.tabColor = '#16a34a';
    const nc = b.columnas.length;
    const sT = est.xf({ b: 1, sz: 14, color: '#ffffff', fill: marca, v: 'center', indent: 1 });
    const sS = est.xf({ sz: 9, color: '#64748b', i: 1 });
    for (let c = 0; c < nc; c++) h.vacio(c, 0, est.xf({ fill: marca }));
    h.texto(0, 0, b.titulo, sT); if (nc > 1) h.merge(0, 0, nc - 1, 0); h.alto(0, 26);
    h.texto(0, 1, [seccion, b.descripcion, periodoTxt ? `Periodo: ${periodoTxt}` : null, b.truncada ? `Se incluyen ${b.filas.length} de ${b.totalFilas} registros` : `${b.totalFilas} registros`].filter(Boolean).join('  ·  '), sS);
    const fCab = 3;
    b.columnas.forEach((col, c) => {
      h.texto(c, fCab, col.etiqueta, est.xf({ b: 1, sz: 10, color: '#ffffff', fill: '#475569', v: 'center', h: col.tipo === 'num' ? 'right' : 'left', wrap: 1, borde: 'fino' }));
      const maxLen = Math.max(col.etiqueta.length + 3, ...b.filas.slice(0, 200).map((f) => String(F.formatear(f[col.campo], col.fmt || (col.tipo === 'fecha' ? 'fecha' : col.tipo === 'fechahora' ? 'fechahora' : undefined))).length));
      h.ancho(c, Math.max(10, Math.min(col.peso && col.peso >= 3 ? 60 : 48, maxLen + 3)));
    });
    h.alto(fCab, 24);
    if (!b.filas.length) {
      h.texto(0, fCab + 1, b.vacio, est.xf({ i: 1, color: '#64748b' }));
    }
    b.filas.forEach((fila, i) => {
      const r2 = fCab + 1 + i;
      b.columnas.forEach((col, c) => {
        const v = fila[col.campo];
        const tono = tonoDeCelda(col, v);
        const base = { borde: 'fino', v: 'center', fill: i % 2 ? '#f8fafc' : undefined };
        if (tono) { base.color = COLOR_TONO[tono]; base.b = 1; base.fill = aclarar(COLOR_TONO[tono], 0.88); }
        if (col.tipo === 'fecha' || col.tipo === 'fechahora') {
          const ser = v ? serialFecha(v) : null;
          if (ser === null) h.texto(c, r2, '', est.xf(base));
          else h.numero(c, r2, ser, est.xf({ ...base, h: 'left', fmt: F.FORMATOS_EXCEL[col.tipo] }));
        } else if (typeof v === 'number') {
          h.numero(c, r2, v, est.xf({ ...base, h: 'right', fmt: F.FORMATOS_EXCEL[col.fmt] || (Number.isInteger(v) ? '#,##0' : '#,##0.00') }));
        } else {
          h.texto(c, r2, v === null || v === undefined ? '' : String(v), est.xf({ ...base, h: col.tipo === 'num' ? 'right' : 'left' }));
        }
      });
    });
    h.freeze = { fila: fCab + 1, col: 0 };
    if (b.filas.length) {
      h.autofiltro = `${ref(0, fCab)}:${ref(nc - 1, fCab + b.filas.length)}`;
      let prioridad = 1;
      b.columnas.forEach((col, c) => {
        if (col.barra) {
          h.extra.push(`<conditionalFormatting sqref="${ref(c, fCab + 1)}:${ref(c, fCab + b.filas.length)}"><cfRule type="dataBar" priority="${prioridad++}"><dataBar><cfvo type="num" val="0"/><cfvo type="max"/><color rgb="${rgb(marca)}"/></dataBar></cfRule></conditionalFormatting>`);
        }
      });
    }
    hojas.push(h);
  }

  // ---------------- Empaquetado ----------------
  const zip = new JSZip();
  const tiposContenido = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>', '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'];
  const relsLibro = [];
  const hojasLibro = [];
  let nChart = 0;
  let nDibujo = 0;
  hojas.forEach((h, i) => {
    const id = i + 1;
    tiposContenido.push(`<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    relsLibro.push(`<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${id}.xml"/>`);
    hojasLibro.push(`<sheet name="${esc(h.nombre)}" sheetId="${id}" r:id="rId${id}"/>`);
    const conGraficos = h.charts && h.charts.length;
    zip.file(`xl/worksheets/sheet${id}.xml`, h.xml(conGraficos));
    if (conGraficos) {
      nDibujo += 1;
      zip.file(`xl/worksheets/_rels/sheet${id}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${nDibujo}.xml"/></Relationships>`);
      tiposContenido.push(`<Override PartName="/xl/drawings/drawing${nDibujo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      const relsDibujo = [];
      h.charts.forEach((a, k) => {
        nChart += 1;
        zip.file(`xl/charts/chart${nChart}.xml`, xmlGrafico(a.g, a.datos));
        tiposContenido.push(`<Override PartName="/xl/charts/chart${nChart}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
        relsDibujo.push(`<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${nChart}.xml"/>`);
      });
      zip.file(`xl/drawings/drawing${nDibujo}.xml`, xmlDibujo(h.charts));
      zip.file(`xl/drawings/_rels/drawing${nDibujo}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsDibujo.join('')}</Relationships>`);
    }
  });
  relsLibro.push(`<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${tiposContenido.join('')}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000" activeTab="0"/></bookViews><sheets>${hojasLibro.join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsLibro.join('')}</Relationships>`);
  zip.file('xl/styles.xml', est.xml());
  const ahora = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(informe.titulo)}</dc:title><dc:creator>AXIS · Banco Finandina</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${ahora}</dcterms:created></cp:coreProperties>`);
  zip.file('docProps/app.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>AXIS</Application></Properties>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { generarXlsxBuffer };
