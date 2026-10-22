// PDF del informe de Aplicaciones e Inventario de Sub-aplicativos (Fase 2).
// Mismo layout compartido que utils/reportesPdf.js (Certificados) — ver
// utils/pdfHelpers.js.
const {
  COLOR_OK,
  COLOR_WARN,
  COLOR_ACENTO,
  COLOR_GRIS,
  MARGEN_IZQ,
  ANCHO_UTIL,
  formatoFechaLegible,
  titulo,
  encabezadoDocumento,
  filaKpis,
  tabla,
} = require('./pdfHelpers');

function generarPdfAplicaciones(doc, datos) {
  const {
    periodo,
    resumenActual,
    servidoresSinAplicativos,
    subaplicativosSinCertificado,
    criticidadSubaplicativos,
    altasConexionesBdEnPeriodo,
    conexionesBdEnPeriodo,
    topMotoresBd,
  } = datos;

  encabezadoDocumento(doc, 'Informe de Aplicaciones e Inventario', periodo);

  doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLOR_GRIS)
    .text('Este informe es principalmente un snapshot del estado actual — Aplicaciones e Inventario no registran fecha de alta, así que el único dato filtrado por periodo son las conexiones a bases de datos registradas.', MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
  doc.moveDown(0.6);

  // ---------- Resumen general (snapshot actual) ----------
  titulo(doc, 'Resumen general (estado actual)');
  filaKpis(doc, [
    { etiqueta: 'Aplicaciones de negocio', valor: resumenActual.totalAplicacionesNegocio, color: COLOR_ACENTO },
    { etiqueta: 'Sub-aplicativos', valor: resumenActual.totalSubaplicativos, color: COLOR_ACENTO },
    { etiqueta: 'Servidores activos', valor: resumenActual.totalServidores, color: COLOR_ACENTO },
    { etiqueta: 'Servidores sin aplicativos', valor: resumenActual.servidoresSinAplicativos, color: resumenActual.servidoresSinAplicativos ? COLOR_WARN : COLOR_OK },
    { etiqueta: 'Sub-aplicativos sin certificado', valor: resumenActual.subaplicativosSinCertificado, color: resumenActual.subaplicativosSinCertificado ? COLOR_WARN : COLOR_OK },
  ]);

  // ---------- Servidores sin aplicativos ----------
  titulo(doc, 'Servidores sin aplicativos registrados');
  tabla(doc, [
    { etiqueta: 'Servidor', campo: 'Hostname', ancho: 300 },
    { etiqueta: 'IP', campo: 'IP', ancho: 215 },
  ], servidoresSinAplicativos, { vacio: 'Todos los servidores activos tienen al menos un aplicativo registrado.' });

  // ---------- Sub-aplicativos sin certificado ----------
  titulo(doc, 'Sub-aplicativos sin certificado asociado');
  tabla(doc, [
    { etiqueta: 'Sub-aplicativo', campo: 'Nombre', ancho: 300 },
    { etiqueta: 'Servidor', campo: 'Hostname', ancho: 215, formato: (v) => v || 'Sin asignar' },
  ], subaplicativosSinCertificado, { vacio: 'Todos los sub-aplicativos tienen un certificado asociado.' });

  // ---------- Criticidad ----------
  titulo(doc, 'Sub-aplicativos por nivel de criticidad');
  tabla(doc, [
    { etiqueta: 'Criticidad', campo: 'nombre', ancho: 350 },
    { etiqueta: 'Sub-aplicativos', campo: 'total', ancho: 165 },
  ], criticidadSubaplicativos, { vacio: 'Sin sub-aplicativos registrados.' });

  // ---------- Conexiones BD en el periodo ----------
  titulo(doc, `Conexiones a bases de datos registradas en el periodo (${altasConexionesBdEnPeriodo})`);
  tabla(doc, [
    { etiqueta: 'Aplicativo', campo: 'AplicativoNombre', ancho: 120, formato: (v) => v || 'Sin asignar' },
    { etiqueta: 'Motor', campo: 'motor_bd', ancho: 80 },
    { etiqueta: 'Base de datos', campo: 'nombre_base_datos', ancho: 120 },
    { etiqueta: 'Servidor BD', campo: 'ServidorBdHostname', ancho: 100, formato: (v) => v || '-' },
    { etiqueta: 'Registrada', campo: 'fecha_registro', ancho: 95, formato: formatoFechaLegible },
  ], conexionesBdEnPeriodo, { vacio: 'No se registraron conexiones a bases de datos en este periodo.' });

  // ---------- Motores de BD ----------
  titulo(doc, 'Motores de base de datos más usados (todo el inventario)');
  tabla(doc, [
    { etiqueta: 'Motor', campo: 'nombre', ancho: 350 },
    { etiqueta: 'Conexiones', campo: 'total', ancho: 165 },
  ], topMotoresBd, { vacio: 'Sin conexiones a bases de datos registradas.' });
}

module.exports = { generarPdfAplicaciones };
