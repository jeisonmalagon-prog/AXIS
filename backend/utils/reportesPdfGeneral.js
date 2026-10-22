// PDF combinado del Informe General del Aplicativo — reutiliza el
// generarPdf<Modulo>() que YA existe para cada módulo (mismo pdfkit doc):
// una portada con el resumen de qué se incluyó, seguida de una sección por
// módulo elegido, cada una en su propia página nueva porque
// encabezadoDocumento() de pdfHelpers.js asume que arranca arriba de una
// página en blanco (ver pdfHelpers.js — por eso NO se puede simplemente
// concatenar el contenido de cada módulo sin doc.addPage() de por medio).

const {
  COLOR_TEXTO,
  COLOR_GRIS,
  COLOR_DANGER,
  MARGEN_IZQ,
  ANCHO_UTIL,
  encabezadoDocumento,
  titulo,
} = require('./pdfHelpers');
const { generarPdfCertificados } = require('./reportesPdf');
const { generarPdfServidores } = require('./reportesPdfServidores');
const { generarPdfAplicaciones } = require('./reportesPdfAplicaciones');
const { generarPdfApuntamientos } = require('./reportesPdfApuntamientos');
const { generarPdfF5 } = require('./reportesPdfF5');

// Un generador de PDF por clave de sección — mismas claves que
// SECCIONES_DISPONIBLES en utils/informeGeneral.js.
const GENERADORES_POR_CLAVE = {
  certificados: generarPdfCertificados,
  servidores: generarPdfServidores,
  aplicaciones: generarPdfAplicaciones,
  apuntamientos: generarPdfApuntamientos,
  f5: generarPdfF5,
};

function generarPortada(doc, datosGenerales) {
  const { periodo, seccionesIncluidas, seccionesConError } = datosGenerales;

  encabezadoDocumento(doc, 'Informe General del Aplicativo', periodo);
  doc.moveDown(0.5);

  titulo(doc, 'Secciones incluidas en este informe');
  if (!seccionesIncluidas.length) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLOR_GRIS)
      .text('No se seleccionó ninguna sección.', MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
  } else {
    seccionesIncluidas.forEach((s) => {
      const tuvoError = seccionesConError.some((e) => e.clave === s.clave);
      // OJO: nada de ✓/✗ u otros glyphs fuera de WinAnsi — la fuente estándar
      // Helvetica de pdfkit no los tiene y los pinta como un caracter suelto
      // (se detectó en la revisión visual del PDF de prueba).
      const marca = tuvoError ? '[X]' : '[OK]';
      const sufijo = tuvoError ? ' — no se pudo generar (ver detalle abajo)' : '';
      doc.font('Helvetica-Bold').fontSize(10).fillColor(tuvoError ? COLOR_DANGER : COLOR_TEXTO)
        .text(marca, MARGEN_IZQ, doc.y, { continued: true, width: ANCHO_UTIL })
        .font('Helvetica').text(`  ${s.etiqueta}${sufijo}`);
      doc.moveDown(0.25);
    });
  }

  if (seccionesConError.length) {
    doc.moveDown(0.4);
    titulo(doc, 'Errores al generar alguna sección');
    seccionesConError.forEach((e) => {
      doc.font('Helvetica').fontSize(9).fillColor(COLOR_DANGER)
        .text(`${e.etiqueta}: ${e.error}`, MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
      doc.moveDown(0.25);
    });
    doc.moveDown(0.2);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLOR_GRIS)
      .text('Puedes volver a intentar generar el informe general, o entrar al informe individual de esa sección.', MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
  }

  doc.moveDown(0.8);
  doc.font('Helvetica').fontSize(9).fillColor(COLOR_GRIS)
    .text(
      'Este informe combina, en un solo PDF, los informes individuales de cada módulo que ya existen por separado (Informes > <módulo>). El periodo elegido aplica igual a todas las secciones.',
      MARGEN_IZQ, doc.y, { width: ANCHO_UTIL }
    );
}

function generarPdfGeneral(doc, datosGenerales) {
  generarPortada(doc, datosGenerales);

  datosGenerales.seccionesIncluidas.forEach((s) => {
    const datosSeccion = datosGenerales.secciones[s.clave];
    if (!datosSeccion) return; // sección con error: ya se avisó en la portada
    const generador = GENERADORES_POR_CLAVE[s.clave];
    if (!generador) return;
    doc.addPage();
    // F5 dentro del informe general va resumido (el detalle por nodo está en su informe individual).
    generador(doc, datosSeccion, s.clave === 'f5' ? { resumido: true } : undefined);
  });
}

module.exports = { generarPdfGeneral };
