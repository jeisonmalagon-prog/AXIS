// PDF del informe de Bitácora de Apuntamientos (Fase 2). Mismo layout
// compartido que utils/reportesPdf.js (Certificados) — ver
// utils/pdfHelpers.js.
const {
  COLOR_OK,
  COLOR_WARN,
  COLOR_DANGER,
  COLOR_ACENTO,
  formatoFechaLegible,
  titulo,
  encabezadoDocumento,
  filaKpis,
  tabla,
} = require('./pdfHelpers');

function generarPdfApuntamientos(doc, datos) {
  const { periodo, resumenActual, altasEnPeriodo, ajustesEnPeriodo, incidenciasEnPeriodo, topServiciosPorIncidencias, topAplicacionesPorIncidencias } = datos;

  encabezadoDocumento(doc, 'Informe de Bitácora de Apuntamientos', periodo);

  // ---------- Resumen general (snapshot actual) ----------
  titulo(doc, 'Resumen general (estado actual)');
  filaKpis(doc, [
    { etiqueta: 'Total apuntamientos', valor: resumenActual.total, color: COLOR_ACENTO },
    { etiqueta: 'Sin apuntamiento', valor: resumenActual.sinApuntamiento, color: resumenActual.sinApuntamiento ? COLOR_WARN : COLOR_OK },
    { etiqueta: 'ACE', valor: resumenActual.ace, color: COLOR_ACENTO },
    { etiqueta: 'Bus de Integración 10', valor: resumenActual.busIntegracion10, color: COLOR_ACENTO },
  ]);

  // ---------- Actividad del periodo ----------
  titulo(doc, `Actividad del periodo (${altasEnPeriodo} altas, ${ajustesEnPeriodo} ajustes)`);
  filaKpis(doc, [
    { etiqueta: 'Altas en el periodo', valor: altasEnPeriodo, color: COLOR_OK },
    { etiqueta: 'Ajustes registrados', valor: ajustesEnPeriodo, color: COLOR_ACENTO },
    { etiqueta: 'Incidencias (con error/TRANDID)', valor: incidenciasEnPeriodo.length, color: incidenciasEnPeriodo.length ? COLOR_DANGER : COLOR_OK },
  ]);

  // ---------- Incidencias del periodo ----------
  titulo(doc, 'Incidencias registradas en el periodo');
  tabla(doc, [
    { etiqueta: 'Fecha', campo: 'FechaCambio', ancho: 65, formato: formatoFechaLegible },
    { etiqueta: 'Servicio', campo: 'ServicioNuevoNombre', ancho: 120, formato: (v) => v || 'Sin asignar' },
    { etiqueta: 'Aplicación', campo: 'AplicacionNuevoNombre', ancho: 110, formato: (v) => v || 'Sin asignar' },
    { etiqueta: 'TRANDID', campo: 'TrandId', ancho: 80, formato: (v) => v || '-' },
    { etiqueta: 'Descripción', campo: 'ErrorDescripcion', ancho: 140, formato: (v) => v || '-' },
  ], incidenciasEnPeriodo, { vacio: 'No se registraron incidencias en este periodo.' });

  // ---------- Rankings ----------
  titulo(doc, 'Servicios con más incidencias en el periodo');
  tabla(doc, [
    { etiqueta: 'Servicio', campo: 'nombre', ancho: 350 },
    { etiqueta: 'Incidencias', campo: 'total', ancho: 165 },
  ], topServiciosPorIncidencias, { vacio: 'Sin incidencias registradas en este periodo.' });

  titulo(doc, 'Aplicaciones con más incidencias en el periodo');
  tabla(doc, [
    { etiqueta: 'Aplicación', campo: 'nombre', ancho: 350 },
    { etiqueta: 'Incidencias', campo: 'total', ancho: 165 },
  ], topAplicacionesPorIncidencias, { vacio: 'Sin incidencias registradas en este periodo.' });
}

module.exports = { generarPdfApuntamientos };
