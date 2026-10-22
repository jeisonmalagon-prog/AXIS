// Soporte Nivel 1 (Monitoreo > Soporte Nivel 1): reinicios operativos de contenedores concretos vía Portainer.
//
//  · Acciones (catálogo cerrado): reiniciar el monitor de pagos y reiniciar el monitor naranja. Cada una apunta a un
//    contenedor de un entorno de Portainer (por defecto FABOGAPPLIN07 / container_monitor_pagos y container_monitor_naranja).
//    Nadie puede pedir reiniciar un contenedor distinto: el destino sale SOLO de la configuración que guarda el ADMIN_POD.
//  · Quien tiene rol de administración en el módulo (ADMIN_MIN / ADMIN_POD) reinicia directo.
//  · Quien tiene rol Consulta pide un código (OTP de 6 dígitos): se envía por correo a los APROBADORES que configura el
//    ADMIN_POD (nunca al solicitante), vence en pocos minutos, admite pocos intentos y es de un solo uso. Con el código
//    correcto se reinicia el contenedor.
//  · El código jamás se guarda en claro (solo su HMAC, en memoria) ni se escribe en la auditoría o en el log.
//
// Configuración en ConfiguracionSistema (clave/valor, sin scripts SQL; la app no tiene DELETE: «quitar» = guardar vacío).
// Las solicitudes pendientes viven en memoria: duran minutos y, si el servidor se reinicia, simplemente se pide un código nuevo.

const crypto = require('crypto');
const { getPool } = require('../db');
const correo = require('./informes/correo');
const correoConfig = require('./correoConfig'); // SMTP guardado en Configuración → Correo saliente (el mismo de recuperación, informes y alertas)
const { registrarEventoGeneral } = require('./auditoriaGeneral');
let portainer = require('./portainer');

const TABLA = 'ConfiguracionSistema';
const CLAVES = { aprobadores: 'sn1_aprobadores', vigencia: 'sn1_vigencia_min', monitor_pagos: 'sn1_pagos', monitor_naranja: 'sn1_naranja' };
const TTL_CFG_MS = 15000;

const VIGENCIA_DEFECTO = 10;
const VIGENCIA_MIN = 3;
const VIGENCIA_MAX = 30;
const MAX_INTENTOS = 5;
const REENVIO_SEG = 60;
const MAX_SOLICITUDES_HORA = 5;
const ENFRIAMIENTO_REINICIO_SEG = 30;
const MAX_VALOR = 255; // Valor VARCHAR(255)

const RE_NOMBRE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,99}$/;

// Catálogo cerrado de acciones.
const ACCIONES = {
  monitor_pagos: {
    clave: 'monitor_pagos', titulo: 'Reiniciar monitor de pagos', corto: 'Monitor de pagos', objeto: 'el monitor de pagos',
    descripcion: 'Reinicia el contenedor del monitor de pagos (PSE). Úsalo cuando el monitor deje de refrescar o quede colgado.',
    puerto: 4032, entorno: 'FABOGAPPLIN07', contenedor: 'container_monitor_pagos',
  },
  monitor_naranja: {
    clave: 'monitor_naranja', titulo: 'Reiniciar monitor naranja', corto: 'Monitor naranja', objeto: 'el monitor naranja',
    descripcion: 'Reinicia el contenedor del monitor naranja. Úsalo cuando el monitor deje de refrescar o quede colgado.',
    puerto: 4031, entorno: 'FABOGAPPLIN07', contenedor: 'container_monitor_naranja',
  },
};
const CLAVES_ACCION = Object.keys(ACCIONES);

class ErrorSoporte extends Error {
  constructor(mensaje, status = 400, extra = {}) { super(mensaje); this.status = status; Object.assign(this, extra); }
}

const esErrorTablaInexistente = (e) => e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
let cache = { en: 0, valores: null };

async function leerValores({ force = false } = {}) {
  if (!force && cache.valores && Date.now() - cache.en < TTL_CFG_MS) return cache.valores;
  const bd = await getPool();
  const claves = Object.values(CLAVES);
  let filas = [];
  try {
    [filas] = await bd.query(`SELECT Clave, Valor FROM ${TABLA} WHERE Clave IN (${claves.map(() => '?').join(',')})`, claves);
  } catch (e) {
    if (!esErrorTablaInexistente(e)) throw e;
  }
  cache = { en: Date.now(), valores: Object.fromEntries(filas.map((f) => [f.Clave, String(f.Valor ?? '')])) };
  return cache.valores;
}

function parsearDestino(valor, defecto) {
  const [entorno, contenedor] = String(valor || '').split('|').map((x) => x.trim());
  return {
    entorno: entorno && RE_NOMBRE.test(entorno) ? entorno : defecto.entorno,
    contenedor: contenedor && RE_NOMBRE.test(contenedor) ? contenedor : defecto.contenedor,
  };
}

/** Configuración efectiva (con los correos completos: uso interno del backend). */
async function obtenerConfig(opciones) {
  const v = await leerValores(opciones);
  const aprobadores = String(v[CLAVES.aprobadores] || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  let vigencia = parseInt(v[CLAVES.vigencia], 10);
  if (!Number.isFinite(vigencia)) vigencia = VIGENCIA_DEFECTO;
  vigencia = Math.min(Math.max(vigencia, VIGENCIA_MIN), VIGENCIA_MAX);
  const destinos = {};
  for (const k of CLAVES_ACCION) destinos[k] = parsearDestino(v[CLAVES[k]], ACCIONES[k]);
  return { aprobadores: [...new Set(aprobadores)], vigencia, destinos };
}

function enmascarar(c) {
  const [u, d] = String(c).split('@');
  if (!d) return '***';
  return `${u.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(u.length - 1, 6)))}@${d}`;
}

/** Lo que ve la pantalla. `admin`: correos completos; los demás solo ven cuántos hay y los correos enmascarados. */
async function configPublica({ admin = false } = {}) {
  const c = await obtenerConfig();
  const base = {
    vigenciaMin: c.vigencia, maxIntentos: MAX_INTENTOS, aprobadoresTotal: c.aprobadores.length,
    smtpListo: correo.smtpConfigurado(), dominios: correo.dominiosPermitidos(),
    ...(admin ? { correo: (({ configurado, host, port, user, from }) => ({ configurado, host, port, usuario: user, remitente: from || user }))(correoConfig.vista()) } : {}),
    acciones: Object.fromEntries(CLAVES_ACCION.map((k) => [k, { ...c.destinos[k], defecto: { entorno: ACCIONES[k].entorno, contenedor: ACCIONES[k].contenedor } }])),
  };
  return admin ? { ...base, aprobadores: c.aprobadores } : { ...base, aprobadoresEnmascarados: c.aprobadores.map(enmascarar) };
}

/** Devuelve { valor } o { error }. */
function validarConfig(entrada) {
  const e = entrada || {};
  let aprobadores = [];
  const crudo = Array.isArray(e.aprobadores) ? e.aprobadores : String(e.aprobadores || '').split(/[,;\s]+/);
  const lista = crudo.map((x) => String(x).trim()).filter(Boolean);
  if (lista.length) {
    try { aprobadores = correo.validarDestinatarios(lista); } catch (err) { return { error: err.message }; }
  }
  if (aprobadores.join(',').length > MAX_VALOR) return { error: `Los correos aprobadores no caben (máximo ${MAX_VALOR} caracteres en total, unos 6 correos). Usa menos correos o un buzón compartido.` };

  let vigencia = VIGENCIA_DEFECTO;
  if (e.vigenciaMin !== undefined && e.vigenciaMin !== null && String(e.vigenciaMin).trim() !== '') {
    vigencia = Number(e.vigenciaMin);
    if (!Number.isInteger(vigencia) || vigencia < VIGENCIA_MIN || vigencia > VIGENCIA_MAX) return { error: `La vigencia del código debe ser un entero entre ${VIGENCIA_MIN} y ${VIGENCIA_MAX} minutos.` };
  }

  const destinos = {};
  for (const k of CLAVES_ACCION) {
    const d = (e.acciones && e.acciones[k]) || {};
    const entorno = String(d.entorno || '').trim() || ACCIONES[k].entorno;
    const contenedor = String(d.contenedor || '').trim() || ACCIONES[k].contenedor;
    if (!RE_NOMBRE.test(entorno)) return { error: `El entorno de «${ACCIONES[k].corto}» no es válido (letras, números, punto, guion y guion bajo).` };
    if (!RE_NOMBRE.test(contenedor)) return { error: `El nombre del contenedor de «${ACCIONES[k].corto}» no es válido (letras, números, punto, guion y guion bajo).` };
    destinos[k] = { entorno, contenedor };
  }
  return { valor: { aprobadores, vigencia, destinos } };
}

async function guardarConfig(valor, usuarioId) {
  const bd = await getPool();
  const pares = [
    [CLAVES.aprobadores, valor.aprobadores.join(',')], [CLAVES.vigencia, String(valor.vigencia)],
    ...CLAVES_ACCION.map((k) => [CLAVES[k], `${valor.destinos[k].entorno}|${valor.destinos[k].contenedor}`]),
  ];
  try {
    for (const [clave, v] of pares) {
      await bd.query(
        `INSERT INTO ${TABLA} (Clave, Valor, ActualizadoPorId) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE Valor = VALUES(Valor), ActualizadoPorId = VALUES(ActualizadoPorId)`,
        [clave, String(v ?? ''), usuarioId || null]
      );
    }
  } catch (e) {
    if (esErrorTablaInexistente(e)) throw new ErrorSoporte('Falta la tabla ConfiguracionSistema en la base de AXIS (la crea el DBA con crear_tabla_configuracion_sistema_BIC_CERTI_MARIA.sql).', 500);
    throw e;
  }
  cache = { en: 0, valores: null };
}

// ---------------------------------------------------------------------------
// Portainer: ubicar el contenedor de una acción
// ---------------------------------------------------------------------------
const nombreContenedor = (c) => String((c.Names && c.Names[0]) || c.Name || '').replace(/^\//, '');

/** Ubica el contenedor configurado. No lanza: devuelve { ok:false, error } si no se pudo. */
async function ubicar(clave, cfg) {
  const destino = cfg.destinos[clave];
  if (!portainer.PORTAINER_CONFIGURADO) return { ok: false, destino, error: 'Portainer no está configurado en el servidor de AXIS.' };
  try {
    const endpoint = await portainer.listarEndpoints().then((l) => l.find((e) => String(e.Name || '').trim().toLowerCase() === destino.entorno.toLowerCase()));
    if (!endpoint) return { ok: false, destino, error: `No existe un entorno «${destino.entorno}» en Portainer.` };
    const lista = await portainer.listarContenedores(endpoint.Id);
    const c = lista.find((x) => nombreContenedor(x).toLowerCase() === destino.contenedor.toLowerCase());
    if (!c) return { ok: false, destino, endpointId: endpoint.Id, error: `No hay un contenedor «${destino.contenedor}» en ${destino.entorno}.` };
    return { ok: true, destino, endpointId: endpoint.Id, containerId: c.Id, contenedor: c };
  } catch (err) {
    return { ok: false, destino, error: `No se pudo consultar Portainer: ${String(err.message || err).slice(0, 200)}` };
  }
}

function resumenContenedor(c) {
  const puertos = [...new Set((c.Ports || []).filter((p) => p.PublicPort).map((p) => p.PublicPort))];
  return { estado: c.State || null, estadoTexto: c.Status || null, imagen: c.Image || null, puertos };
}

/** Estado en vivo de las acciones (para la pantalla). */
async function estadoAcciones() {
  const cfg = await obtenerConfig();
  const salida = [];
  for (const k of CLAVES_ACCION) {
    const u = await ubicar(k, cfg);
    const a = ACCIONES[k];
    salida.push({
      clave: k, titulo: a.titulo, corto: a.corto, descripcion: a.descripcion, puerto: a.puerto,
      entorno: u.destino.entorno, contenedor: u.destino.contenedor,
      encontrado: u.ok, error: u.ok ? null : u.error,
      ...(u.ok ? resumenContenedor(u.contenedor) : { estado: null, estadoTexto: null, imagen: null, puertos: [] }),
      enfriamientoSeg: segundosEnfriamiento(k),
    });
  }
  return salida;
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------
const SECRETO = crypto.randomBytes(32); // por proceso: las solicitudes pendientes no sobreviven a un reinicio
const solicitudes = new Map(); // id -> { id, accion, userId, username, nombre, hash, creada, expira, intentos, estado }
const historialUsuario = new Map(); // userId -> [timestamps]
const ultimoReinicio = new Map(); // accion -> ts
const enCurso = new Set();

const hashCodigo = (id, codigo) => crypto.createHmac('sha256', SECRETO).update(`${id}:${codigo}`).digest('hex');
function igualesSeguro(a, b) {
  const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function podar() {
  const ahora = Date.now();
  for (const [id, s] of solicitudes) if (s.expira + 10 * 60 * 1000 < ahora) solicitudes.delete(id);
}
function segundosEnfriamiento(clave) {
  const t = ultimoReinicio.get(clave);
  if (!t) return 0;
  return Math.max(0, Math.ceil((t + ENFRIAMIENTO_REINICIO_SEG * 1000 - Date.now()) / 1000));
}
const accionValida = (clave) => {
  if (!ACCIONES[clave]) throw new ErrorSoporte('Acción de soporte no reconocida.', 404);
  return ACCIONES[clave];
};

const MARCA = '#4c1d95';
const fechaHora = (d = new Date()) => d.toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const horaCorta = (d) => d.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
const primerNombre = (u) => String((u && (u.nombre || u.username)) || 'Un usuario').trim().split(/\s+/)[0];
const textoEstado = (estado, estadoTexto) => {
  const m = { running: 'En ejecución', restarting: 'Reiniciando', exited: 'Detenido', paused: 'En pausa', created: 'Creado', dead: 'Caído' };
  if (!estado) return 'No disponible';
  return `${m[estado] || estado}${estadoTexto ? ` · ${estadoTexto}` : ''}`;
};

/** Correo estructurado (tablas e inline-CSS para que se vea igual en Outlook, Gmail y móvil). */
function plantillaCorreo({ titulo, subtitulo, filas, bloque, aviso, pie, cabecera = 'Detalle de la solicitud' }) {
  const fila = ([k, v]) => `<tr><td style="padding:9px 14px;width:34%;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;border-top:1px solid #e2e8f0;vertical-align:top">${esc(k)}</td><td style="padding:9px 14px;font-size:14px;color:#0f172a;border-top:1px solid #e2e8f0;vertical-align:top">${v}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f1f5f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
 <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;font-family:Segoe UI,Arial,sans-serif">
  <tr><td style="background:${MARCA};padding:14px 24px;color:#ede9fe;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase">AXIS &nbsp;·&nbsp; Soporte Nivel 1</td></tr>
  <tr><td style="padding:24px 24px 6px"><div style="font-size:22px;line-height:1.3;font-weight:800;color:#0f172a">${titulo}</div>
   <div style="margin-top:8px;font-size:14px;line-height:1.5;color:#475569">${subtitulo}</div></td></tr>
  <tr><td style="padding:14px 24px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;border-collapse:separate;overflow:hidden">
   <tr><td colspan="2" style="background:#f8fafc;padding:9px 14px;font-size:12px;font-weight:800;color:${MARCA};text-transform:uppercase;letter-spacing:.5px">${esc(cabecera)}</td></tr>
   ${filas.map(fila).join('')}</table></td></tr>
  ${bloque ? `<tr><td style="padding:12px 24px 0">${bloque}</td></tr>` : ''}
  ${aviso ? `<tr><td style="padding:14px 24px 0"><div style="background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #f59e0b;border-radius:8px;padding:10px 14px;font-size:13px;line-height:1.5;color:#78350f">${aviso}</div></td></tr>` : ''}
  <tr><td style="padding:18px 24px 22px;font-size:12px;line-height:1.5;color:#94a3b8">${pie}</td></tr>
 </table></td></tr></table></body></html>`;
}

function correoOtp({ accion, destino, usuario, estado, codigo, vigencia, expira, ip }) {
  const quien = primerNombre(usuario);
  const detalleSolicitante = `<b>${esc(usuario.nombre || usuario.username)}</b><br><span style="color:#64748b;font-size:12.5px">@${esc(usuario.username)}${usuario.correo ? ` · ${esc(usuario.correo)}` : ''}</span>`;
  const filas = [
    ['Solicitante', detalleSolicitante],
    ['Acción', `<b>${esc(accion.titulo)}</b>`],
    ['Servidor', esc(destino.entorno)],
    ['Contenedor', `<code style="font-family:Consolas,monospace;font-size:13px">${esc(destino.contenedor)}</code>`],
    ['Puerto', esc(accion.puerto)],
    ['Estado actual', esc(textoEstado(estado && estado.estado, estado && estado.estadoTexto))],
    ['Solicitado', `${esc(fechaHora())} (hora Colombia)${ip ? `<br><span style="color:#64748b;font-size:12.5px">desde la IP ${esc(ip)}</span>` : ''}`],
  ];
  const bloque = `<div style="text-align:center;border:1px solid #ddd6fe;background:#f5f3ff;border-radius:12px;padding:16px 12px">
    <div style="font-size:12px;font-weight:800;color:${MARCA};text-transform:uppercase;letter-spacing:.6px">Código de aprobación</div>
    <div style="font-family:Consolas,'Courier New',monospace;font-size:38px;letter-spacing:12px;font-weight:800;color:${MARCA};margin:8px 0 4px;padding-left:12px">${esc(codigo)}</div>
    <div style="font-size:12.5px;color:#475569">Vence a las <b>${esc(horaCorta(expira))}</b> (en ${vigencia} minutos) · se puede usar <b>una sola vez</b></div></div>`;
  const html = plantillaCorreo({
    titulo: `${esc(quien)} quiere reiniciar ${esc(accion.objeto)}`,
    subtitulo: `Necesita tu aprobación para continuar. Si estás de acuerdo, <b>entrégale el código</b> de abajo a ${esc(quien)}; con él completará el reinicio.`,
    filas, bloque,
    aviso: `<b>¿No reconoces esta solicitud?</b> Ignora este correo: sin el código no se reinicia nada, y el código se anula solo al vencer.`,
    pie: 'Mensaje automático de AXIS. No respondas a este correo. Cada solicitud, aprobación y reinicio queda registrado en la auditoría.',
  });
  const texto = [
    `${quien} quiere reiniciar ${accion.objeto}`, '',
    `Solicitante: ${usuario.nombre || usuario.username} (@${usuario.username}${usuario.correo ? `, ${usuario.correo}` : ''})`,
    `Acción: ${accion.titulo}`, `Servidor: ${destino.entorno}`, `Contenedor: ${destino.contenedor}`, `Puerto: ${accion.puerto}`,
    `Estado actual: ${textoEstado(estado && estado.estado, estado && estado.estadoTexto)}`, `Solicitado: ${fechaHora()} (hora Colombia)${ip ? ` desde ${ip}` : ''}`, '',
    `Código de aprobación: ${codigo}`,
    `Vence a las ${horaCorta(expira)} (en ${vigencia} minutos) y es de un solo uso.`, '',
    'Si no reconoces esta solicitud, ignora este correo: sin el código no se reinicia nada.',
  ].join('\n');
  return { asunto: `[AXIS] ${quien} quiere reiniciar ${accion.objeto} · código de aprobación`, html, texto };
}

/** Rol Consulta: genera el código y lo envía a los aprobadores. Devuelve datos seguros para la pantalla (sin el código). */
async function solicitarOtp({ clave, usuario, ip }) {
  const accion = accionValida(clave);
  podar();
  await correoConfig.asegurar({ force: true }); // toma lo último guardado en Configuración
  const cfg = await obtenerConfig({ force: true });
  if (!cfg.aprobadores.length) throw new ErrorSoporte('Todavía no hay correos aprobadores configurados. Pide al ADMIN_POD que los configure en Soporte Nivel 1.', 409, { codigo: 'SIN_APROBADORES' });
  if (!correo.smtpConfigurado()) throw new ErrorSoporte('El correo (SMTP) no está configurado en el servidor, así que no se puede enviar el código.', 409, { codigo: 'SIN_SMTP' });

  const ahora = Date.now();
  // Un envío reciente de la misma acción: no se reenvía antes de REENVIO_SEG.
  const previa = [...solicitudes.values()].find((s) => s.userId === usuario.id && s.accion === clave && s.estado === 'PENDIENTE' && s.expira > ahora);
  if (previa) {
    const restante = Math.ceil((previa.creada + REENVIO_SEG * 1000 - ahora) / 1000);
    if (restante > 0) throw new ErrorSoporte(`Ya se envió un código hace poco. Espera ${restante} s para pedir otro.`, 429, { codigo: 'REENVIO', esperaSeg: restante, solicitudId: previa.id, expiraEn: new Date(previa.expira).toISOString() });
  }
  const recientes = (historialUsuario.get(usuario.id) || []).filter((t) => ahora - t < 3600 * 1000);
  if (recientes.length >= MAX_SOLICITUDES_HORA) throw new ErrorSoporte('Superaste el máximo de códigos por hora. Intenta más tarde o pide el reinicio a un administrador.', 429, { codigo: 'LIMITE_HORA' });

  const destino = cfg.destinos[clave];
  const id = crypto.randomBytes(12).toString('hex');
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const vigenciaMs = cfg.vigencia * 60 * 1000;

  const ubic = await ubicar(clave, cfg);
  const estadoActual = ubic.ok ? resumenContenedor(ubic.contenedor) : null;
  const mail = correoOtp({ accion, destino, usuario, estado: estadoActual, codigo, vigencia: cfg.vigencia, expira: new Date(ahora + vigenciaMs), ip });
  try {
    await correo.enviarTexto({ destinatarios: cfg.aprobadores, asunto: mail.asunto, html: mail.html, texto: mail.texto });
  } catch (err) {
    console.error('[soporte-n1] No se pudo enviar el código:', err.message);
    throw new ErrorSoporte('No se pudo enviar el correo con el código. Revisa la configuración del correo e inténtalo de nuevo.', 502, { codigo: 'ENVIO' });
  }

  for (const s of solicitudes.values()) if (s.userId === usuario.id && s.accion === clave && s.estado === 'PENDIENTE') s.estado = 'REEMPLAZADA';
  solicitudes.set(id, { id, accion: clave, userId: usuario.id, username: usuario.username, hash: hashCodigo(id, codigo), creada: ahora, expira: ahora + vigenciaMs, intentos: 0, estado: 'PENDIENTE' });
  recientes.push(ahora);
  historialUsuario.set(usuario.id, recientes);
  if (historialUsuario.size > 2000) historialUsuario.clear();

  return {
    solicitudId: id, expiraEn: new Date(ahora + vigenciaMs).toISOString(), vigenciaMin: cfg.vigencia, reenvioSeg: REENVIO_SEG,
    enviadoA: cfg.aprobadores.map(enmascarar), aprobadores: cfg.aprobadores.length, maxIntentos: MAX_INTENTOS,
  };
}

/** Verifica el código y lo consume. Lanza ErrorSoporte con `auditoria` para que la ruta deje rastro. */
function consumirOtp({ clave, solicitudId, codigo, usuario }) {
  const s = solicitudes.get(String(solicitudId || ''));
  const txt = String(codigo || '').replace(/\s+/g, '');
  if (!s || s.userId !== usuario.id || s.accion !== clave) throw new ErrorSoporte('No hay una solicitud de código vigente. Pide uno nuevo.', 400, { codigo: 'SIN_SOLICITUD' });
  if (s.estado !== 'PENDIENTE') throw new ErrorSoporte(s.estado === 'USADA' ? 'Ese código ya se usó. Pide uno nuevo.' : 'Ese código ya no es válido. Pide uno nuevo.', 400, { codigo: 'NO_VIGENTE' });
  if (Date.now() > s.expira) { s.estado = 'VENCIDA'; throw new ErrorSoporte('El código venció. Pide uno nuevo.', 410, { codigo: 'VENCIDO', auditoria: 'OTP_VENCIDA' }); }
  if (!/^\d{6}$/.test(txt)) throw new ErrorSoporte('El código tiene 6 dígitos.', 400, { codigo: 'FORMATO', intentosRestantes: MAX_INTENTOS - s.intentos });
  if (!igualesSeguro(hashCodigo(s.id, txt), s.hash)) {
    s.intentos += 1;
    if (s.intentos >= MAX_INTENTOS) { s.estado = 'BLOQUEADA'; throw new ErrorSoporte('Demasiados intentos fallidos. El código quedó bloqueado: pide uno nuevo.', 429, { codigo: 'BLOQUEADO', auditoria: 'OTP_BLOQUEADA' }); }
    throw new ErrorSoporte(`Código incorrecto. Te quedan ${MAX_INTENTOS - s.intentos} intento(s).`, 400, { codigo: 'INCORRECTO', intentosRestantes: MAX_INTENTOS - s.intentos, auditoria: 'OTP_INCORRECTA' });
  }
  s.estado = 'USADA';
}

// ---------------------------------------------------------------------------
// Reinicio
// ---------------------------------------------------------------------------
/** Reinicia el contenedor y espera unos segundos a verlo «running». No valida permisos: lo hace la ruta. */
async function reiniciar(clave, { esperaMs = parseInt(process.env.SOPORTE_N1_ESPERA_MS || '2500', 10), intentos = 4 } = {}) {
  const accion = accionValida(clave);
  const falta = segundosEnfriamiento(clave);
  if (falta > 0) throw new ErrorSoporte(`${accion.corto} se reinició hace instantes. Espera ${falta} s antes de volver a hacerlo.`, 429, { codigo: 'ENFRIAMIENTO' });
  if (enCurso.has(clave)) throw new ErrorSoporte(`Ya hay un reinicio de ${accion.corto.toLowerCase()} en curso.`, 409, { codigo: 'EN_CURSO' });
  enCurso.add(clave);
  try {
    const cfg = await obtenerConfig({ force: true });
    const u = await ubicar(clave, cfg);
    if (!u.ok) throw new ErrorSoporte(u.error, 502, { codigo: 'SIN_CONTENEDOR' });
    const inicio = Date.now();
    try {
      await portainer.ejecutarAccionContenedor(u.endpointId, u.containerId, 'restart');
    } catch (err) {
      console.error(`[soporte-n1] Falló el reinicio de ${u.destino.contenedor}:`, err.message);
      throw new ErrorSoporte(`Portainer no pudo reiniciar el contenedor: ${String(err.message || err).slice(0, 200)}`, 502, { codigo: 'FALLO_REINICIO' });
    }
    ultimoReinicio.set(clave, Date.now());

    let estado = null; let estadoTexto = null;
    for (let i = 0; i < intentos; i += 1) {
      await dormir(esperaMs);
      try {
        const lista = await portainer.listarContenedores(u.endpointId);
        const c = lista.find((x) => x.Id === u.containerId) || lista.find((x) => nombreContenedor(x).toLowerCase() === u.destino.contenedor.toLowerCase());
        if (c) { estado = c.State; estadoTexto = c.Status; if (estado === 'running') break; }
      } catch (_e) { /* se reintenta */ }
    }
    return { entorno: u.destino.entorno, contenedor: u.destino.contenedor, estado, estadoTexto, arriba: estado === 'running', duracionMs: Date.now() - inicio, titulo: accion.titulo };
  } finally {
    enCurso.delete(clave);
  }
}

/** Aviso por correo a los aprobadores de que el reinicio se hizo (mejor esfuerzo; nunca rompe el reinicio). */
async function avisarReinicio({ clave, usuario, via, resultado }) {
  try {
    const cfg = await obtenerConfig();
    if (!cfg.aprobadores.length || !correo.smtpConfigurado()) return;
    const accion = ACCIONES[clave];
    const quien = primerNombre(usuario);
    const ok = !!resultado.arriba;
    const filas = [
      ['Ejecutado por', `<b>${esc(usuario.nombre || usuario.username)}</b><br><span style="color:#64748b;font-size:12.5px">@${esc(usuario.username)}</span>`],
      ['Acción', `<b>${esc(accion.titulo)}</b>`],
      ['Vía', esc(via === 'otp' ? 'Con código de aprobación' : 'Directo (rol de administración)')],
      ['Servidor', esc(resultado.entorno)],
      ['Contenedor', `<code style="font-family:Consolas,monospace;font-size:13px">${esc(resultado.contenedor)}</code>`],
      ['Estado tras el reinicio', `<b style="color:${ok ? '#047857' : '#b45309'}">${esc(ok ? 'En ejecución' : (resultado.estado || 'Sin confirmar'))}</b>${resultado.estadoTexto ? ` · ${esc(resultado.estadoTexto)}` : ''}`],
      ['Hora', `${esc(fechaHora())} (hora Colombia)`],
    ];
    const html = plantillaCorreo({
      titulo: `${esc(quien)} reinició ${esc(accion.objeto)}`,
      subtitulo: ok ? 'El reinicio se completó y el contenedor volvió a estar en ejecución.' : 'Portainer aceptó el reinicio, pero el contenedor aún no figura en ejecución. Conviene revisarlo.',
      filas, bloque: null, cabecera: 'Detalle del reinicio',
      aviso: ok ? null : '<b>Revisa el monitor:</b> si sigue sin responder, escala el caso.',
      pie: 'Mensaje informativo de AXIS: no requiere ninguna acción. Queda registrado en la auditoría.',
    });
    await correo.enviarTexto({
      destinatarios: cfg.aprobadores,
      asunto: `[AXIS] ${quien} reinició ${accion.objeto} · ${ok ? 'en ejecución' : 'sin confirmar'}`,
      html,
      texto: `${quien} reinició ${accion.objeto}.\nEjecutado por: ${usuario.nombre || usuario.username} (@${usuario.username})\nVía: ${via === 'otp' ? 'con código de aprobación' : 'directo (rol de administración)'}\nServidor: ${resultado.entorno}\nContenedor: ${resultado.contenedor}\nEstado tras el reinicio: ${ok ? 'en ejecución' : (resultado.estado || 'sin confirmar')}\nHora: ${fechaHora()} (hora Colombia)`,
    });
  } catch (err) {
    console.error('[soporte-n1] No se pudo avisar del reinicio:', err.message);
  }
}

async function probarCorreo({ usuario }) {
  await correoConfig.asegurar({ force: true });
  const cfg = await obtenerConfig({ force: true });
  if (!cfg.aprobadores.length) throw new ErrorSoporte('Primero guarda al menos un correo aprobador.', 400);
  if (!correo.smtpConfigurado()) throw new ErrorSoporte('El correo (SMTP) no está configurado en el servidor.', 409);
  await correo.enviarTexto({
    destinatarios: cfg.aprobadores,
    asunto: '[AXIS] Prueba · aprobadores de Soporte Nivel 1',
    html: plantillaCorreo({
      titulo: 'Correo de prueba de aprobadores',
      subtitulo: 'Recibirás en esta cuenta los códigos de aprobación cuando alguien con rol Consulta pida reiniciar un monitor. No requiere ninguna acción.',
      cabecera: 'Detalle de la prueba',
      filas: [['Enviado por', `<b>${esc(usuario.nombre || usuario.username)}</b>`], ['Hora', `${esc(fechaHora())} (hora Colombia)`], ['Aprobadores', esc(cfg.aprobadores.length)]],
      bloque: null, aviso: null, pie: 'Mensaje automático de AXIS.',
    }),
    texto: 'Correo de prueba: recibirás por aquí los códigos de aprobación de Soporte Nivel 1 de AXIS. No requiere ninguna acción.',
  });
  return { ok: true, enviadoA: cfg.aprobadores.length };
}

/** Últimos eventos de Soporte Nivel 1 de la auditoría (sin datos sensibles: nunca se escribe el código). */
async function actividad(limite = 15) {
  try {
    const bd = await getPool();
    const [filas] = await bd.query(
      `SELECT FechaEvento, Accion, EntidadNombre, Detalle, RealizadoPorUsername FROM AuditoriaGeneral
       WHERE Entidad = 'Soporte N1' ORDER BY Id DESC LIMIT ?`, [limite]);
    return filas.map((f) => ({ fecha: f.FechaEvento, accion: f.Accion, entidad: f.EntidadNombre, detalle: f.Detalle, usuario: f.RealizadoPorUsername }));
  } catch (e) {
    return [];
  }
}

async function auditar(req, datos) {
  try {
    await registrarEventoGeneral(await getPool(), req, { modulo: 'SOPORTE_N1', entidad: 'Soporte N1', ...datos });
  } catch (e) { console.error('[soporte-n1] No se pudo registrar la auditoría:', e.message); }
}

function _usarPortainer(mock) { portainer = mock; }
function _reiniciarEstado() { solicitudes.clear(); historialUsuario.clear(); ultimoReinicio.clear(); enCurso.clear(); cache = { en: 0, valores: null }; }

module.exports = {
  ACCIONES, CLAVES_ACCION, ErrorSoporte, MAX_INTENTOS,
  obtenerConfig, configPublica, validarConfig, guardarConfig,
  estadoAcciones, solicitarOtp, consumirOtp, reiniciar, avisarReinicio, probarCorreo, actividad, auditar,
  _usarPortainer, _reiniciarEstado,
};
