// Envío del informe de Certificados por correo corporativo (adjunto en
// PDF), usando SMTP directo (nodemailer) — sin depender de ningún servicio
// externo de terceros. Pensado para el envío AUTOMÁTICO programado (ver el
// scheduler al final de routes/reportes.js), pero enviarInformeCertificadosPorCorreo()
// no sabe nada de "cuándo" — solo recibe los datos ya armados y los manda.
//
// Todas las credenciales/parámetros salen de variables de entorno del
// backend (.env) — a propósito NUNCA hay un valor por defecto para
// SMTP_HOST/SMTP_USER/SMTP_PASS: si faltan, el envío se omite (ver
// correoAutomaticoConfigurado) en vez de fallar con una excepción rara a
// mitad de la noche.
//
// Variables esperadas en backend/.env:
//   SMTP_HOST                    ej. smtp.bancofinandina.com
//   SMTP_PORT                    ej. 587 (STARTTLS) o 465 (SSL) — por defecto 587
//   SMTP_SECURE                  "true" para conexión SSL directa (puerto 465),
//                                 "false" (o vacío) para STARTTLS (puerto 587, lo más común)
//   SMTP_USER                    usuario/cuenta de correo corporativo
//   SMTP_PASS                    clave de esa cuenta (o clave de aplicación, según el proveedor)
//   REPORTE_EMAIL_FROM           remitente que ve el destinatario (opcional; si falta, se usa SMTP_USER)
//   REPORTE_EMAIL_DESTINATARIOS  lista de correos separados por coma, ej. "jeison.malagon@bancofinandina.com,otro@bancofinandina.com"

const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const { generarPdfCertificados } = require('./reportesPdf');

function correoAutomaticoConfigurado() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    (process.env.REPORTE_EMAIL_DESTINATARIOS || '').trim()
  );
}

function crearTransporter() {
  // Opciones desde Configuración (BD) o, si no hay, del .env: ver utils/correoConfig.js
  return nodemailer.createTransport(require('./correoConfig').opcionesTransporte());
}

function obtenerDestinatarios() {
  return (process.env.REPORTE_EMAIL_DESTINATARIOS || '')
    .split(',')
    .map((correo) => correo.trim())
    .filter(Boolean);
}

// Genera el PDF en memoria (Buffer) en vez de a disco — el correo lo manda
// como adjunto directo, no hace falta un archivo temporal.
function generarPdfBuffer(datos) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const partes = [];
    doc.on('data', (parte) => partes.push(parte));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    generarPdfCertificados(doc, datos);
    doc.end();
  });
}

// datos: la misma forma que devuelve armarDatosInforme() de
// utils/informeCertificados.js (periodo, resumen, vencidosEnPeriodo, etc.)
async function enviarInformeCertificadosPorCorreo(datos) {
  if (!correoAutomaticoConfigurado()) {
    return { enviado: false, motivo: 'SMTP o destinatarios no configurados en el .env' };
  }

  const destinatarios = obtenerDestinatarios();
  const pdfBuffer = await generarPdfBuffer(datos);
  const transporter = crearTransporter();
  const remitente = process.env.REPORTE_EMAIL_FROM || process.env.SMTP_USER;

  await transporter.sendMail({
    from: remitente,
    to: destinatarios.join(','),
    subject: `Informe de Certificados — ${datos.periodo.desde} a ${datos.periodo.hasta}`,
    text:
      `Adjunto el informe de Certificados correspondiente al periodo ${datos.periodo.desde} a ${datos.periodo.hasta}.\n\n` +
      `Vigentes: ${datos.resumen.Vigente || 0} · Por vencer: ${datos.resumen['Por vencer'] || 0} · Vencidos: ${datos.resumen.Vencido || 0}\n\n` +
      `Generado automáticamente por el aplicativo de Gestión de Certificados. No responder a este correo.`,
    attachments: [
      {
        filename: `informe-certificados_${datos.periodo.desde}_a_${datos.periodo.hasta}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });

  return { enviado: true, destinatarios };
}

module.exports = { enviarInformeCertificadosPorCorreo, correoAutomaticoConfigurado };
