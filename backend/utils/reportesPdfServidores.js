// PDF del informe de Servidores/Monitoreo (Fase 2). Mismo layout compartido
// que utils/reportesPdf.js (Certificados) — ver utils/pdfHelpers.js.
const {
  COLOR_OK,
  COLOR_WARN,
  COLOR_DANGER,
  COLOR_ACENTO,
  COLOR_GRIS,
  MARGEN_IZQ,
  titulo,
  encabezadoDocumento,
  filaKpis,
  tabla,
} = require('./pdfHelpers');

function formatoFechaCorta(valor) {
  if (!valor) return '-';
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (isNaN(fecha.getTime())) return String(valor);
  return fecha.toLocaleDateString('es-CO', { month: '2-digit', day: '2-digit' });
}

function generarPdfServidores(doc, datos) {
  const { periodo, portainerConfigurado, resumenActual, tendenciaDiaria, picosPeriodo, topEntornosPorCpu, topEntornosPorMemoria } = datos;

  encabezadoDocumento(doc, 'Informe de Servidores / Monitoreo', periodo);

  if (!portainerConfigurado) {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(COLOR_GRIS)
      .text('Portainer todavía no está configurado en el backend — este informe solo puede mostrar la tendencia histórica ya guardada, sin snapshot en vivo de la flota.', MARGEN_IZQ, doc.y, { width: 515 });
    doc.moveDown(0.6);
  }

  // ---------- Resumen actual (en vivo) ----------
  titulo(doc, 'Resumen actual de la flota (en vivo)');
  filaKpis(doc, [
    { etiqueta: 'Entornos arriba', valor: `${resumenActual.entornosArriba}/${resumenActual.entornosTotal}`, color: resumenActual.entornosArriba === resumenActual.entornosTotal ? COLOR_OK : COLOR_WARN },
    { etiqueta: 'Contenedores corriendo', valor: resumenActual.contenedoresCorriendo, color: COLOR_OK },
    { etiqueta: 'Contenedores detenidos', valor: resumenActual.contenedoresDetenidos, color: resumenActual.contenedoresDetenidos ? COLOR_DANGER : COLOR_OK },
    { etiqueta: 'CPU en uso ahora', valor: `${resumenActual.cpuPromedioActual}%`, color: COLOR_ACENTO },
    { etiqueta: 'Memoria en uso ahora', valor: `${resumenActual.memUsadaActualGb} GB`, color: COLOR_ACENTO },
  ]);

  // ---------- Picos del periodo ----------
  titulo(doc, `Picos del periodo (${picosPeriodo.totalCapturas} capturas registradas)`);
  filaKpis(doc, [
    { etiqueta: 'Pico de CPU promedio', valor: `${picosPeriodo.cpuPico}%`, color: COLOR_WARN },
    { etiqueta: 'Pico de memoria usada', valor: `${picosPeriodo.memPico} GB`, color: COLOR_WARN },
  ]);

  // ---------- Tendencia diaria ----------
  titulo(doc, 'Tendencia diaria del periodo');
  tabla(doc, [
    { etiqueta: 'Fecha', campo: 'fecha', ancho: 80, formato: formatoFechaCorta },
    { etiqueta: 'Contenedores (prom.)', campo: 'contenedoresTotalProm', ancho: 140 },
    { etiqueta: 'Corriendo (prom.)', campo: 'contenedoresCorriendoProm', ancho: 130 },
    { etiqueta: 'CPU prom.', campo: 'cpuPromedio', ancho: 80, formato: (v) => `${v}%` },
    { etiqueta: 'Memoria prom.', campo: 'memUsadaGb', ancho: 85, formato: (v) => `${v} GB` },
  ], tendenciaDiaria, { vacio: 'Aún no hay suficiente histórico guardado en este periodo — las muestras se guardan cada 10 minutos.' });

  // ---------- Rankings ----------
  titulo(doc, 'Entornos con mayor uso de CPU en el periodo (promedio)');
  tabla(doc, [
    { etiqueta: 'Entorno', campo: 'entorno', ancho: 350 },
    { etiqueta: 'CPU promedio', campo: 'cpuPromedio', ancho: 165, formato: (v) => `${v}%` },
  ], topEntornosPorCpu, { vacio: 'Sin datos históricos suficientes en este periodo.' });

  titulo(doc, 'Entornos con mayor uso de memoria en el periodo (promedio)');
  tabla(doc, [
    { etiqueta: 'Entorno', campo: 'entorno', ancho: 350 },
    { etiqueta: 'Memoria promedio', campo: 'memUsadaGbProm', ancho: 165, formato: (v) => `${v} GB` },
  ], topEntornosPorMemoria, { vacio: 'Sin datos históricos suficientes en este periodo.' });
}

module.exports = { generarPdfServidores };
