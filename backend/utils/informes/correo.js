// Envío de informes por correo (SMTP directo con nodemailer): cuerpo con el
// resumen (KPIs y hallazgos) y el informe completo adjunto en PDF y/o Excel.
// Usa las mismas variables SMTP_* que el resto del backend.
const nodemailer = require('nodemailer');
const { F, COLOR_NIVEL, COLOR_TONO } = require('./kit');
const { generarPdfBuffer } = require('./pdfRender');
const { generarXlsxBuffer } = require('./xlsxRender');

function smtpConfigurado() { return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS); }
// Las opciones salen de utils/correoConfig.js: lo guardado en Configuración (BD) manda sobre el .env.
function transporter() {
  return nodemailer.createTransport(require('../correoConfig').opcionesTransporte());
}

// Solo se permite enviar a dominios corporativos (evita sacar informes a correos externos).
function dominiosPermitidos() {
  return (process.env.REPORTE_EMAIL_DOMINIOS || 'bancofinandina.com').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}
const RE_CORREO = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
function validarDestinatarios(lista) {
  const limpios = [...new Set((lista || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
  if (!limpios.length) throw Object.assign(new Error('Indica al menos un destinatario.'), { status: 400 });
  if (limpios.length > 25) throw Object.assign(new Error('Máximo 25 destinatarios por envío.'), { status: 400 });
  const permitidos = dominiosPermitidos();
  for (const c of limpios) {
    if (!RE_CORREO.test(c)) throw Object.assign(new Error(`"${c}" no es un correo válido.`), { status: 400 });
    if (!permitidos.includes(c.split('@')[1])) throw Object.assign(new Error(`Solo se puede enviar a correos de: ${permitidos.map((d) => '@' + d).join(', ')}.`), { status: 400 });
  }
  return limpios;
}

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cuerpoHtml(inf, { nota, url, marca }) {
  const kpis = inf.kpis.slice(0, 6).map((k) => {
    const col = k.tono && k.tono !== 'brand' ? COLOR_TONO[k.tono] : '#1e293b';
    return `<td style="width:33%;padding:6px"><div style="border:1px solid #e2e8f0;border-top:3px solid ${k.tono ? COLOR_TONO[k.tono] : '#e2e8f0'};border-radius:6px;padding:10px 12px"><div style="font-size:11px;color:#64748b">${esc(k.etiqueta)}</div><div style="font-size:21px;font-weight:700;color:${col};margin-top:2px">${esc(F.formatear(k.valor, k.fmt))}</div>${k.delta ? `<div style="font-size:11px;color:${k.delta.tono === 'ok' ? '#16a34a' : k.delta.tono === 'danger' ? '#dc2626' : '#64748b'}">${esc(k.delta.texto)}</div>` : (k.nota ? `<div style="font-size:11px;color:#64748b">${esc(k.nota)}</div>` : '')}</div></td>`;
  });
  const filas = []; for (let i = 0; i < kpis.length; i += 3) filas.push(`<tr>${kpis.slice(i, i + 3).join('')}</tr>`);
  const hall = inf.hallazgos.slice(0, 6).map((h) => `<tr><td style="padding:4px 0"><div style="border-left:4px solid ${COLOR_NIVEL[h.nivel]};background:#f8fafc;padding:8px 12px;border-radius:0 6px 6px 0"><div style="font-size:13px;font-weight:700;color:#1e293b">${esc(h.titulo)}</div>${h.detalle ? `<div style="font-size:12px;color:#64748b;margin-top:2px">${esc(h.detalle)}</div>` : ''}</div></td></tr>`).join('');
  const per = inf.periodo ? `${F.fecha(inf.periodo.desde)} — ${F.fecha(inf.periodo.hasta)}` : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:680px;margin:0 auto;color:#1e293b">
<div style="background:${marca};color:#fff;padding:22px 26px;border-radius:10px 10px 0 0"><div style="font-size:11px;letter-spacing:1.5px;opacity:.8">AXIS · BANCO FINANDINA</div><div style="font-size:22px;font-weight:700;margin-top:6px">${esc(inf.titulo)}</div><div style="font-size:12px;opacity:.9;margin-top:4px">${esc(per ? `Periodo: ${per}` : '')}</div></div>
<div style="border:1px solid #e2e8f0;border-top:0;padding:18px 20px;border-radius:0 0 10px 10px">
${nota ? `<p style="font-size:13px;color:#475569;margin:0 0 12px">${esc(nota)}</p>` : ''}
<table style="width:100%;border-collapse:collapse">${filas.join('')}</table>
<div style="font-size:14px;font-weight:700;margin:16px 0 6px">Hallazgos clave</div>
<table style="width:100%;border-collapse:collapse">${hall}</table>
<p style="font-size:12px;color:#64748b;margin:16px 0 0">El informe completo va adjunto${url ? ` y también puedes verlo en <a href="${esc(url)}" style="color:${marca}">AXIS</a>` : ''}. Generado automáticamente; no respondas a este correo.</p>
</div></div>`;
}

async function enviarInforme(inf, { destinatarios, formatos = ['pdf', 'xlsx'], asunto, nota, colorMarca }) {
  if (!smtpConfigurado()) throw Object.assign(new Error('El correo no está configurado en el backend (configúralo en Configuración → Correo saliente).'), { status: 503 });
  const para = validarDestinatarios(destinatarios);
  const marca = /^#[0-9a-fA-F]{6}$/.test(colorMarca || '') ? colorMarca : '#673ab7';
  const base = `informe-${inf.clave}_${inf.periodo ? `${inf.periodo.desde}_a_${inf.periodo.hasta}` : F.isoFecha(new Date())}`;
  const adjuntos = [];
  if (formatos.includes('pdf')) adjuntos.push({ filename: `${base}.pdf`, content: await generarPdfBuffer(inf, { colorMarca }), contentType: 'application/pdf' });
  if (formatos.includes('xlsx')) adjuntos.push({ filename: `${base}.xlsx`, content: await generarXlsxBuffer(inf, { colorMarca }), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/+$/, '')}/informes/${inf.clave}` : null;
  await transporter().sendMail({
    from: process.env.REPORTE_EMAIL_FROM || process.env.SMTP_USER,
    to: para.join(','),
    subject: asunto || `${inf.titulo} — ${inf.periodo ? `${F.fecha(inf.periodo.desde)} a ${F.fecha(inf.periodo.hasta)}` : ''}`,
    text: `${inf.titulo}\n${inf.periodo ? `Periodo: ${F.fecha(inf.periodo.desde)} a ${F.fecha(inf.periodo.hasta)}\n` : ''}\n${inf.hallazgos.slice(0, 6).map((h) => `- ${h.titulo}${h.detalle ? `: ${h.detalle}` : ''}`).join('\n')}\n\nInforme completo adjunto.`,
    html: cuerpoHtml(inf, { nota, url, marca }),
    attachments: adjuntos,
  });
  return { enviado: true, destinatarios: para, adjuntos: adjuntos.map((a) => a.filename) };
}

// Correo corto sin adjuntos (alertas operativas, p. ej. las de Portainer).
async function enviarTexto({ destinatarios, asunto, html, texto }) {
  if (!smtpConfigurado()) throw Object.assign(new Error('El correo no está configurado en el backend (configúralo en Configuración → Correo saliente).'), { status: 503 });
  const para = validarDestinatarios(destinatarios);
  await transporter().sendMail({ from: process.env.REPORTE_EMAIL_FROM || process.env.SMTP_USER, to: para.join(','), subject: asunto, text: texto, html });
  return { enviado: true, destinatarios: para };
}

module.exports = { smtpConfigurado, validarDestinatarios, enviarInforme, enviarTexto, dominiosPermitidos };
