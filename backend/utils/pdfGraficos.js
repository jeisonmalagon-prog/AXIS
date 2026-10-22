// Gráficas simples para los PDF (pdfkit no trae gráficas): líneas, barras
// verticales y barras horizontales, dibujadas con trazos vectoriales. Mismo
// estilo que el resto de pdfHelpers: ejes recesivos, marcas finas, valores solo
// donde aportan. Texto siempre en Helvetica (sin caracteres fuera de WinAnsi).

const { COLOR_TEXTO, COLOR_GRIS, MARGEN_IZQ, ANCHO_UTIL, asegurarEspacio } = require('./pdfHelpers');

const COLOR_GRID = '#e2e8f0';
const PALETA = ['#673ab7', '#0ea5e9', '#16a34a', '#d97706', '#dc2626'];

function techoRedondo(valor) {
  if (!(valor > 0)) return 1;
  const magnitud = 10 ** Math.floor(Math.log10(valor));
  const n = valor / magnitud;
  // 1, 2, 4, 8 y 10 se dividen en 4 tramos sin decimales feos en el eje.
  const techo = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 8 ? 8 : 10;
  return techo * magnitud;
}

// Etiquetas cortas del eje Y (caben en 30 pt): 1,5 M / 250 k / 0,25.
function etiquetaEje(v) {
  const limpio = (n) => String(Math.round(n * 100) / 100).replace('.', ',');
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${limpio(v / 1e9)} G`;
  if (abs >= 1e6) return `${limpio(v / 1e6)} M`;
  if (abs >= 1e4) return `${limpio(v / 1e3)} k`;
  return limpio(v);
}

// Reserva el alto de la gráfica y devuelve su caja { x, y, w, h } ya con título.
function iniciarGrafica(doc, titulo, alto, leyenda) {
  asegurarEspacio(doc, alto + 40);
  doc.moveDown(0.3);
  const y0 = doc.y;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLOR_TEXTO).text(titulo, MARGEN_IZQ, y0, { width: ANCHO_UTIL, lineBreak: false });
  let yTop = y0 + 14;
  if (leyenda && leyenda.length) {
    let x = MARGEN_IZQ;
    doc.font('Helvetica').fontSize(8);
    leyenda.forEach((l) => {
      doc.rect(x, yTop + 2, 8, 8).fill(l.color);
      doc.fillColor(COLOR_GRIS).text(l.nombre, x + 11, yTop + 1, { lineBreak: false });
      x += 11 + doc.widthOfString(l.nombre) + 14;
    });
    yTop += 14;
  }
  return { x: MARGEN_IZQ + 34, y: yTop + 4, w: ANCHO_UTIL - 34 - 6, h: alto - 20, yFin: yTop + alto + 4 };
}

function ejesY(doc, caja, maximo, formato) {
  const pasos = 4;
  doc.font('Helvetica').fontSize(7.5);
  for (let i = 0; i <= pasos; i++) {
    const y = caja.y + caja.h - (caja.h * i) / pasos;
    doc.strokeColor(COLOR_GRID).lineWidth(0.5).moveTo(caja.x, y).lineTo(caja.x + caja.w, y).stroke();
    doc.fillColor(COLOR_GRIS).text((formato || etiquetaEje)((maximo * i) / pasos), MARGEN_IZQ, y - 4, { width: 30, align: 'right', lineBreak: false });
  }
}

function etiquetasX(doc, caja, etiquetas, posX) {
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOR_GRIS);
  const maxEtiquetas = Math.max(2, Math.floor(caja.w / 38));
  const salto = Math.ceil(etiquetas.length / maxEtiquetas);
  etiquetas.forEach((e, i) => {
    if (i % salto !== 0 && i !== etiquetas.length - 1) return;
    doc.text(e, posX(i) - 20, caja.y + caja.h + 4, { width: 40, align: 'center', lineBreak: false });
  });
}

function sinDatos(doc, caja) {
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLOR_GRIS)
    .text('Sin datos suficientes en este periodo.', caja.x, caja.y + caja.h / 2 - 5, { width: caja.w, align: 'center', lineBreak: false });
}

// series: [{ nombre, color, valores: [n|null] }]
function graficaLineas(doc, { titulo, etiquetas, series, alto = 120, formatoY }) {
  const caja = iniciarGrafica(doc, titulo, alto, series.length > 1 ? series.map((s, i) => ({ nombre: s.nombre, color: s.color || PALETA[i % PALETA.length] })) : null);
  const todos = series.flatMap((s) => s.valores).filter((v) => v !== null && v !== undefined);
  if (!etiquetas.length || !todos.length) { sinDatos(doc, caja); doc.y = caja.yFin; return; }
  const maximo = techoRedondo(Math.max(...todos));
  ejesY(doc, caja, maximo, formatoY);
  const n = etiquetas.length;
  const posX = (i) => (n === 1 ? caja.x + caja.w / 2 : caja.x + (caja.w * i) / (n - 1));
  const posY = (v) => caja.y + caja.h - (v / maximo) * caja.h;
  series.forEach((s, si) => {
    const color = s.color || PALETA[si % PALETA.length];
    doc.strokeColor(color).lineWidth(1.6);
    let abierto = false;
    s.valores.forEach((v, i) => {
      if (v === null || v === undefined) { abierto = false; return; }
      if (!abierto) { doc.moveTo(posX(i), posY(v)); abierto = true; } else doc.lineTo(posX(i), posY(v));
    });
    doc.stroke();
    s.valores.forEach((v, i) => { if (v !== null && v !== undefined) doc.circle(posX(i), posY(v), 1.8).fill(color); });
  });
  etiquetasX(doc, caja, etiquetas, posX);
  doc.y = caja.yFin;
}

function graficaBarras(doc, { titulo, etiquetas, valores, color = PALETA[0], alto = 110, formatoY }) {
  const caja = iniciarGrafica(doc, titulo, alto, null);
  const v = valores.filter((x) => x !== null && x !== undefined);
  if (!etiquetas.length || !v.length) { sinDatos(doc, caja); doc.y = caja.yFin; return; }
  const maximo = techoRedondo(Math.max(...v));
  ejesY(doc, caja, maximo, formatoY);
  const n = etiquetas.length;
  const paso = caja.w / n;
  const ancho = Math.max(2, Math.min(28, paso * 0.62));
  const posX = (i) => caja.x + paso * i + paso / 2;
  valores.forEach((x, i) => {
    if (x === null || x === undefined) return;
    const h = Math.max(1, (x / maximo) * caja.h);
    doc.rect(posX(i) - ancho / 2, caja.y + caja.h - h, ancho, h).fill(color);
  });
  etiquetasX(doc, caja, etiquetas, posX);
  doc.y = caja.yFin;
}

// items: [{ nombre, valor, texto }] ya ordenados de mayor a menor.
function barrasHorizontales(doc, { titulo, items, color = PALETA[0] }) {
  const alturaFila = 15;
  asegurarEspacio(doc, 30 + Math.min(items.length, 3) * alturaFila);
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLOR_TEXTO).text(titulo, MARGEN_IZQ, doc.y, { width: ANCHO_UTIL, lineBreak: false });
  doc.moveDown(0.5);
  if (!items.length) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLOR_GRIS).text('Sin datos suficientes en este periodo.', MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
    doc.moveDown(0.6);
    return;
  }
  const maximo = Math.max(...items.map((i) => i.valor), 1);
  const wNombre = 150; const wValor = 78;
  const wBarra = ANCHO_UTIL - wNombre - wValor - 8;
  items.forEach((it) => {
    asegurarEspacio(doc, alturaFila);
    const y = doc.y;
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_TEXTO).text(it.nombre, MARGEN_IZQ, y + 2, { width: wNombre - 6, lineBreak: false, ellipsis: true });
    doc.rect(MARGEN_IZQ + wNombre, y + 3, wBarra, 8).fill('#f1f5f9');
    doc.rect(MARGEN_IZQ + wNombre, y + 3, Math.max(2, (it.valor / maximo) * wBarra), 8).fill(color);
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_GRIS).text(it.texto, MARGEN_IZQ + wNombre + wBarra + 6, y + 2, { width: wValor, lineBreak: false, ellipsis: true });
    doc.y = y + alturaFila;
  });
  doc.moveDown(0.5);
}

module.exports = { PALETA, graficaLineas, graficaBarras, barrasHorizontales };
