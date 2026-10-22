// PDF del informe de Certificados. El layout compartido (títulos, tablas,
// KPIs, encabezado del documento) vive en utils/pdfHelpers.js — este archivo
// solo arma el CONTENIDO específico de Certificados.
const {
  COLOR_OK,
  COLOR_WARN,
  COLOR_DANGER,
  formatoFechaLegible,
  titulo,
  encabezadoDocumento,
  filaKpis,
  tabla,
} = require('./pdfHelpers');

function generarPdfCertificados(doc, datos) {
  const { periodo, resumen, vencidosEnPeriodo, actividadEnPeriodo, altasEnPeriodo, renovacionesEnPeriodo, topResponsablesCriticos, topAplicacionesCriticas, topServidoresCriticos } = datos;

  encabezadoDocumento(doc, 'Informe de Certificados', periodo);

  // ---------- Resumen general (snapshot actual) ----------
  titulo(doc, 'Resumen general (estado actual)');
  filaKpis(doc, [
    { etiqueta: 'Vigentes', valor: resumen.Vigente || 0, color: COLOR_OK },
    { etiqueta: 'Por vencer', valor: resumen['Por vencer'] || 0, color: COLOR_WARN },
    { etiqueta: 'Vencidos', valor: resumen.Vencido || 0, color: COLOR_DANGER },
  ]);

  // ---------- Actividad del periodo ----------
  titulo(doc, `Actividad del periodo (${altasEnPeriodo} altas, ${renovacionesEnPeriodo} renovaciones)`);
  tabla(doc, [
    { etiqueta: 'Fecha', campo: 'FechaCambio', ancho: 70, formato: formatoFechaLegible },
    { etiqueta: 'Acción', campo: 'Accion', ancho: 70 },
    { etiqueta: 'Certificado', campo: 'NombreComun', ancho: 180, formato: (v) => v || '(sin nombre común)' },
    { etiqueta: 'Nueva vigencia', campo: 'FechaFinNueva', ancho: 90, formato: formatoFechaLegible },
    { etiqueta: 'Usuario', campo: 'UsuarioSistema', ancho: 105 },
  ], actividadEnPeriodo, { vacio: 'No hubo altas ni renovaciones registradas en este periodo.' });

  // ---------- Certificados vencidos en el periodo ----------
  titulo(doc, 'Certificados vencidos en el periodo');
  tabla(doc, [
    { etiqueta: 'Servidor', campo: 'Hostname', ancho: 100 },
    { etiqueta: 'Aplicación', campo: 'Aplicacion', ancho: 110 },
    { etiqueta: 'Certificado', campo: 'NombreComun', ancho: 140, formato: (v) => v || '(sin nombre común)' },
    { etiqueta: 'Venció', campo: 'FechaFin', ancho: 70, formato: formatoFechaLegible },
    { etiqueta: 'Responsable', campo: 'Responsable', ancho: 95, formato: (v) => v || 'Sin asignar' },
  ], vencidosEnPeriodo, { vacio: 'No venció ningún certificado activo en este periodo.' });

  // ---------- Rankings ----------
  titulo(doc, 'Responsables con más certificados críticos (por vencer o vencidos)');
  tabla(doc, [
    { etiqueta: 'Responsable', campo: 'nombre', ancho: 350 },
    { etiqueta: 'Certificados críticos', campo: 'total', ancho: 165 },
  ], topResponsablesCriticos);

  titulo(doc, 'Aplicaciones con más certificados críticos');
  tabla(doc, [
    { etiqueta: 'Aplicación', campo: 'nombre', ancho: 350 },
    { etiqueta: 'Certificados críticos', campo: 'total', ancho: 165 },
  ], topAplicacionesCriticas);

  titulo(doc, 'Servidores con más certificados críticos');
  tabla(doc, [
    { etiqueta: 'Servidor', campo: 'nombre', ancho: 350 },
    { etiqueta: 'Certificados críticos', campo: 'total', ancho: 165 },
  ], topServidoresCriticos);
}

module.exports = { generarPdfCertificados };
