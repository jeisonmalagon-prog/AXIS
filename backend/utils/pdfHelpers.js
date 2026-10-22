// Helpers compartidos para armar los PDF de informes (Certificados,
// Servidores/Monitoreo, Aplicaciones, Apuntamientos, F5, ...). Antes vivían
// dentro de utils/reportesPdf.js (que solo tenía el informe de
// Certificados); se separaron aquí para que cada módulo tenga su propio
// archivo "reportesPdf<Modulo>.js" sin duplicar esta lógica de layout.
//
// Layout deliberadamente simple (texto + tablas manuales) porque pdfkit no
// trae tablas nativas — se dibuja fila por fila con columnas de ancho fijo.

const COLOR_TEXTO = '#1e293b';
const COLOR_GRIS = '#64748b';
const COLOR_OK = '#16a34a';
const COLOR_WARN = '#d97706';
const COLOR_DANGER = '#dc2626';
const COLOR_ACENTO = '#673ab7'; // morado de marca — para KPIs que no son ok/warn/danger
const MARGEN_IZQ = 40;
const ANCHO_UTIL = 515; // A4 (595pt) - 2*40 de margen

function formatoFechaLegible(valor) {
  if (!valor) return '-';
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (isNaN(fecha.getTime())) return String(valor);
  return fecha.toLocaleDateString('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function asegurarEspacio(doc, alturaNecesaria) {
  const espacioRestante = doc.page.height - doc.page.margins.bottom - doc.y;
  if (espacioRestante < alturaNecesaria) {
    doc.addPage();
  }
}

// IMPORTANTE: siempre se pasa x/width explícitos. pdfkit recuerda el x del
// último doc.text() si no se le da uno nuevo — después de imprimir una tabla
// (cuya última columna queda con un x muy a la derecha), un doc.text(texto)
// sin x hereda ese x y el título termina angosto y envuelto en 3-4 líneas.
function titulo(doc, texto) {
  asegurarEspacio(doc, 40);
  doc.moveDown(0.5);
  doc.fontSize(13).fillColor(COLOR_TEXTO).font('Helvetica-Bold')
    .text(texto, MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
  doc.moveDown(0.3);
  doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(MARGEN_IZQ, doc.y).lineTo(MARGEN_IZQ + ANCHO_UTIL, doc.y).stroke();
  doc.moveDown(0.4);
}

// Título principal del documento (nombre del informe) + línea de periodo.
function encabezadoDocumento(doc, tituloInforme, periodo) {
  doc.fontSize(18).font('Helvetica-Bold').fillColor(COLOR_TEXTO).text(tituloInforme, MARGEN_IZQ, 40);
  doc.fontSize(10).font('Helvetica').fillColor(COLOR_GRIS);
  if (periodo) {
    doc.text(`Periodo: ${formatoFechaLegible(periodo.desde)} — ${formatoFechaLegible(periodo.hasta)}`);
  }
  doc.text(`Generado: ${formatoFechaLegible(new Date())}`);
  doc.moveDown(0.5);
}

// Fila de "cajas" KPI (número grande + etiqueta) repartidas en el ancho útil.
// cajas: [{ etiqueta, valor, color }]
function filaKpis(doc, cajas) {
  const anchoCaja = ANCHO_UTIL / cajas.length;
  const yCajas = doc.y;
  cajas.forEach((caja, i) => {
    const x = MARGEN_IZQ + i * anchoCaja;
    doc.font('Helvetica-Bold').fontSize(20).fillColor(caja.color || COLOR_ACENTO).text(String(caja.valor), x, yCajas, { width: anchoCaja, align: 'left' });
    doc.font('Helvetica').fontSize(9).fillColor(COLOR_GRIS).text(caja.etiqueta, x, yCajas + 26, { width: anchoCaja, align: 'left' });
  });
  doc.y = yCajas + 50;
}

// columnas: [{ etiqueta, ancho, campo, formato? , color?(valor, fila) }]
function tabla(doc, columnas, filas, opciones = {}) {
  const alturaFila = 18;
  const xInicial = MARGEN_IZQ;

  function encabezado() {
    asegurarEspacio(doc, alturaFila * 2);
    // Un solo "y" fijo para toda la fila — si no, cada doc.text() de columna
    // avanza el cursor y la siguiente columna se imprime más abajo que la
    // anterior (mismo problema que en titulo(), ver comentario ahí).
    const yEncabezado = doc.y;
    let x = xInicial;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR_GRIS);
    columnas.forEach((col) => {
      doc.text(col.etiqueta.toUpperCase(), x, yEncabezado, { width: col.ancho - 4, lineBreak: false, ellipsis: true });
      x += col.ancho;
    });
    doc.y = yEncabezado + 12;
    doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(xInicial, doc.y).lineTo(xInicial + ANCHO_UTIL, doc.y).stroke();
    doc.moveDown(0.3);
  }

  encabezado();

  if (!filas.length) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLOR_GRIS).text(opciones.vacio || 'Sin registros en este periodo.');
    doc.moveDown(0.6);
    return;
  }

  doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_TEXTO);
  filas.forEach((fila, indice) => {
    asegurarEspacio(doc, alturaFila);
    const yFila = doc.y;
    let x = xInicial;
    columnas.forEach((col) => {
      const valorCrudo = col.campo ? fila[col.campo] : '';
      const texto = col.formato ? col.formato(valorCrudo, fila) : (valorCrudo == null ? '-' : String(valorCrudo));
      doc.fillColor(col.color ? col.color(valorCrudo, fila) : COLOR_TEXTO);
      doc.text(texto, x, yFila, { width: col.ancho - 4, height: alturaFila, ellipsis: true, lineBreak: false });
      x += col.ancho;
    });
    doc.y = yFila + alturaFila;
    if (indice < filas.length - 1) {
      doc.strokeColor('#f1f5f9').lineWidth(0.5).moveTo(xInicial, doc.y - 2).lineTo(xInicial + ANCHO_UTIL, doc.y - 2).stroke();
    }
  });
  doc.moveDown(0.6);
}

module.exports = {
  COLOR_TEXTO,
  COLOR_GRIS,
  COLOR_OK,
  COLOR_WARN,
  COLOR_DANGER,
  COLOR_ACENTO,
  MARGEN_IZQ,
  ANCHO_UTIL,
  formatoFechaLegible,
  asegurarEspacio,
  titulo,
  encabezadoDocumento,
  filaKpis,
  tabla,
};
