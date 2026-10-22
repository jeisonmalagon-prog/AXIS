// Configuración del correo saliente (SMTP) editable desde la pantalla de
// Configuración del administrador, sin tocar el .env.
//
// Se guarda en ConfiguracionSistema (clave/valor, la misma tabla del tema y del
// color de marca): smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass (CIFRADA
// con AES-256-GCM), smtp_from, smtp_dominios y smtp_tls_inseguro. La app no tiene
// privilegio DELETE, así que "quitar" un valor es guardarlo vacío ('').
//
// Cómo se aplica: todo el backend (informes, reportes, recuperación de contraseña,
// alertas de Portainer) ya lee SMTP_HOST/SMTP_USER/SMTP_PASS/... de process.env. En
// vez de tocar cada módulo, esta utilidad vuelca lo guardado en la BD sobre
// process.env (la BD manda; si un campo está vacío vuelve a valer el .env original).
// Se recarga cada 20 s y al guardar, así que un cambio hecho en la pantalla vale ya.

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getPool } = require('../db');

const TABLA = 'ConfiguracionSistema';
const TTL_MS = 20000;
const CLAVE_MAX_PASS = 100;

// campo -> [clave en la BD, variable de entorno]
const CAMPOS = {
  host: ['smtp_host', 'SMTP_HOST'],
  port: ['smtp_port', 'SMTP_PORT'],
  secure: ['smtp_secure', 'SMTP_SECURE'],
  user: ['smtp_user', 'SMTP_USER'],
  pass: ['smtp_pass', 'SMTP_PASS'],
  from: ['smtp_from', 'REPORTE_EMAIL_FROM'],
  dominios: ['smtp_dominios', 'REPORTE_EMAIL_DOMINIOS'],
  tlsInseguro: ['smtp_tls_inseguro', 'SMTP_TLS_INSECURE'],
};

// Valores del .env tal como llegaron al arrancar (para volver a ellos si se limpia un campo).
const ENV_ORIGINAL = {};
for (const [, [, env]] of Object.entries(CAMPOS)) ENV_ORIGINAL[env] = process.env[env];

class ErrorCorreo extends Error {
  constructor(mensaje, status = 400, codigo = 'CORREO') { super(mensaje); this.status = status; this.codigo = codigo; }
}

// --- Cifrado de la contraseña -------------------------------------------------------

let claveCache = { secreto: null, clave: null };
function clave() {
  const secreto = process.env.CORREO_CLAVE || process.env.JWT_SECRET;
  if (!secreto) throw new ErrorCorreo('No hay clave para cifrar la contraseña del correo (falta JWT_SECRET en el .env del backend).', 500, 'SIN_CLAVE');
  if (claveCache.secreto !== secreto) claveCache = { secreto, clave: crypto.scryptSync(secreto, 'axis-correo-v1', 32) };
  return claveCache.clave;
}
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave(), iv);
  const enc = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function descifrar(valor) {
  const [v, iv, tag, enc] = String(valor || '').split(':');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('formato');
  const d = crypto.createDecipheriv('aes-256-gcm', clave(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// --- Estado en memoria ---------------------------------------------------------------

let estado = { cargadoEn: 0, enBd: {}, passIlegible: false, tabla: null };
let cargando = null;

function aplicarAlEntorno(enBd) {
  for (const [campo, [, env]] of Object.entries(CAMPOS)) {
    const v = enBd[campo];
    if (v) process.env[env] = v;
    else if (ENV_ORIGINAL[env] === undefined) delete process.env[env];
    else process.env[env] = ENV_ORIGINAL[env];
  }
}

async function leerBd(pool) {
  const claves = Object.values(CAMPOS).map(([c]) => c);
  let filas;
  try {
    [filas] = await pool.query(`SELECT Clave, Valor FROM ${TABLA} WHERE Clave IN (${claves.map(() => '?').join(',')})`, claves);
  } catch (err) {
    if (err && (err.errno === 1146 || err.code === 'ER_NO_SUCH_TABLE')) return { enBd: {}, passIlegible: false, tabla: false };
    throw err;
  }
  const porClave = Object.fromEntries(filas.map((f) => [f.Clave, String(f.Valor || '')]));
  const enBd = {};
  let passIlegible = false;
  for (const [campo, [claveBd]] of Object.entries(CAMPOS)) {
    const v = (porClave[claveBd] || '').trim();
    if (!v) continue;
    if (campo === 'pass') {
      try { enBd.pass = descifrar(v); } catch { passIlegible = true; }
    } else enBd[campo] = v;
  }
  return { enBd, passIlegible, tabla: true };
}

// Recarga desde la BD (como mucho cada 20 s, o ya si force). Nunca lanza: si la BD
// falla se queda con lo último que había (o con el .env).
async function asegurar({ force = false } = {}) {
  if (!force && Date.now() - estado.cargadoEn < TTL_MS) return;
  if (cargando) return cargando;
  cargando = (async () => {
    try {
      const pool = await getPool();
      const r = await leerBd(pool);
      estado = { cargadoEn: Date.now(), ...r };
      aplicarAlEntorno(r.enBd);
    } catch (err) {
      estado.cargadoEn = Date.now(); // no reintentar en cada petición
      console.warn('No se pudo leer la configuración de correo de la BD (se usa el .env):', err.message);
    } finally { cargando = null; }
  })();
  return cargando;
}

// --- Lectura para la pantalla (nunca devuelve la contraseña) ------------------------------

function vista() {
  const e = (n) => process.env[n];
  const host = e('SMTP_HOST') || '';
  const origen = estado.enBd.host ? 'bd' : (ENV_ORIGINAL.SMTP_HOST ? 'env' : 'ninguno');
  return {
    host,
    port: Number(e('SMTP_PORT')) || 587,
    secure: e('SMTP_SECURE') === 'true',
    user: e('SMTP_USER') || '',
    tienePass: Boolean(e('SMTP_PASS')),
    passIlegible: estado.passIlegible,
    from: e('REPORTE_EMAIL_FROM') || '',
    dominios: e('REPORTE_EMAIL_DOMINIOS') || 'bancofinandina.com',
    tlsInseguro: e('SMTP_TLS_INSECURE') === 'true',
    configurado: Boolean(e('SMTP_HOST') && e('SMTP_USER') && e('SMTP_PASS')),
    origen,
    tablaLista: estado.tabla !== false,
  };
}

async function obtener() {
  await asegurar({ force: true });
  return vista();
}

// --- Guardado -------------------------------------------------------------------------------

const RE_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,148}[A-Za-z0-9])?$/;
const RE_DOMINIO = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;
const RE_REMITENTE = /^[^\r\n<>]{0,80}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$|^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

function validar(entrada) {
  const host = String(entrada.host ?? '').trim();
  if (!host) throw new ErrorCorreo('Indica el servidor SMTP (por ejemplo smtp.bancofinandina.com).');
  if (!RE_HOST.test(host)) throw new ErrorCorreo('El servidor SMTP no es válido: solo letras, números, punto y guion.');
  const port = Number(entrada.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ErrorCorreo('El puerto debe ser un número entre 1 y 65535.');
  const user = String(entrada.user ?? '').trim();
  if (!user) throw new ErrorCorreo('Indica el usuario de la cuenta de correo.');
  if (user.length > 150 || /[\r\n]/.test(user)) throw new ErrorCorreo('El usuario no es válido.');
  const from = String(entrada.from ?? '').trim();
  if (from && !RE_REMITENTE.test(from)) throw new ErrorCorreo('El remitente debe ser un correo (axis@bancofinandina.com) o «Nombre <correo>».');
  const dominios = String(entrada.dominios ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  for (const d of dominios) if (!RE_DOMINIO.test(d)) throw new ErrorCorreo(`«${d}» no es un dominio válido (ej. bancofinandina.com).`);
  const pass = entrada.pass === undefined || entrada.pass === null ? '' : String(entrada.pass);
  if (pass.length > CLAVE_MAX_PASS || /[\r\n]/.test(pass)) throw new ErrorCorreo(`La contraseña no es válida (máximo ${CLAVE_MAX_PASS} caracteres, sin saltos de línea).`);
  return { host, port, secure: entrada.secure === true || entrada.secure === 'true', user, from, dominios: [...new Set(dominios)].join(','), pass, tlsInseguro: entrada.tlsInseguro === true || entrada.tlsInseguro === 'true' };
}

async function guardar(entrada, usuarioId) {
  const v = validar(entrada || {});
  const pool = await getPool();
  await asegurar({ force: true });
  if (estado.tabla === false) throw new ErrorCorreo('Falta la tabla ConfiguracionSistema. Ejecuta crear_tabla_configuracion_sistema_BIC_CERTI_MARIA.sql.', 409, 'SIN_TABLA');
  // Contraseña vacía = conservar la que ya hay (no se muestra nunca en pantalla).
  let passCifrada;
  if (v.pass) passCifrada = cifrar(v.pass);
  else if (!estado.enBd.pass && !ENV_ORIGINAL.SMTP_PASS) throw new ErrorCorreo('Escribe la contraseña de la cuenta de correo.');
  const valores = {
    smtp_host: v.host, smtp_port: String(v.port), smtp_secure: v.secure ? 'true' : 'false', smtp_user: v.user,
    smtp_from: v.from, smtp_dominios: v.dominios, smtp_tls_inseguro: v.tlsInseguro ? 'true' : '',
  };
  if (passCifrada) valores.smtp_pass = passCifrada;
  for (const [k, val] of Object.entries(valores)) {
    await pool.query(
      `INSERT INTO ${TABLA} (Clave, Valor, ActualizadoPorId) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE Valor = VALUES(Valor), ActualizadoPorId = VALUES(ActualizadoPorId)`,
      [k, val, usuarioId || null],
    );
  }
  await asegurar({ force: true });
  return vista();
}

// Vuelve al .env: deja vacíos los valores guardados (no hay DELETE).
async function restablecer(usuarioId) {
  const pool = await getPool();
  await asegurar({ force: true });
  if (estado.tabla === false) return vista();
  for (const [claveBd] of Object.values(CAMPOS)) {
    await pool.query(
      `INSERT INTO ${TABLA} (Clave, Valor, ActualizadoPorId) VALUES (?, '', ?)
       ON DUPLICATE KEY UPDATE Valor = '', ActualizadoPorId = VALUES(ActualizadoPorId)`,
      [claveBd, usuarioId || null],
    );
  }
  await asegurar({ force: true });
  return vista();
}

// --- Transporte (con tiempos de espera y certificado opcionalmente no verificado) ------------

function opcionesTransporte() {
  const op = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  };
  if (process.env.SMTP_TLS_INSECURE === 'true') op.tls = { rejectUnauthorized: false };
  return op;
}

function mensajeDeErrorSmtp(err) {
  const c = String((err && err.code) || '');
  const m = String((err && err.message) || '');
  const tiene = (re) => re.test(c) || re.test(m);
  if (c === 'EAUTH' || /Invalid login|authentication failed|535/i.test(m)) {
    // Se agrega la respuesta del servidor (p. ej. Gmail: «Application-specific password required») porque dice la causa real.
    const resp = String((err && err.response) || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 170);
    return 'El servidor rechazó el usuario o la contraseña.' + (resp ? ` Respuesta del servidor: «${resp}»` : '');
  }
  if (tiene(/ENOTFOUND|EDNS|EAI_AGAIN/)) return 'No se encontró el servidor SMTP: revisa el nombre.';
  if (tiene(/ECONNREFUSED/)) return 'El servidor rechazó la conexión: revisa el puerto y que el backend tenga acceso de red a ese servidor.';
  if (tiene(/ETIMEDOUT|timeout|timed out|EHOSTUNREACH|ENETUNREACH/i)) return 'No hubo respuesta del servidor (tiempo agotado): revisa servidor, puerto y firewall.';
  if (/self.signed|certificate|CERT_|unable to verify|wrong version number|ssl|tls/i.test(m)) return 'Problema con el certificado o el cifrado. Prueba cambiando el tipo de conexión (STARTTLS ↔ SSL) o marca «Aceptar certificado no verificado».';
  if (c === 'EENVELOPE') return 'El servidor no aceptó el remitente o el destinatario.';
  return `No se pudo enviar: ${m.slice(0, 160)}`;
}

// Envía un correo de prueba con lo que hay guardado y devuelve el resultado legible.
async function probar(destinatario) {
  await asegurar({ force: true });
  if (!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)) throw new ErrorCorreo('Primero guarda el servidor, el usuario y la contraseña.', 409, 'SIN_CONFIG');
  const { validarDestinatarios } = require('./informes/correo');
  const para = validarDestinatarios([destinatario]);
  const t = nodemailer.createTransport(opcionesTransporte());
  try {
    await t.verify();
    await t.sendMail({
      from: process.env.REPORTE_EMAIL_FROM || process.env.SMTP_USER,
      to: para.join(','),
      subject: 'AXIS · Correo de prueba',
      text: 'Este es un correo de prueba de AXIS. Si lo estás leyendo, el envío por correo quedó bien configurado.',
      html: '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1e293b"><strong>AXIS · Banco Finandina</strong><p>Este es un correo de prueba. Si lo estás leyendo, el envío por correo quedó bien configurado.</p></div>',
    });
  } catch (err) {
    if (err && err.status) throw err;
    throw new ErrorCorreo(mensajeDeErrorSmtp(err), 502, 'FALLO_SMTP');
  } finally { try { t.close(); } catch (_) { /* nada */ } }
  return { enviado: true, destinatario: para[0] };
}

module.exports = { ErrorCorreo, asegurar, obtener, guardar, restablecer, probar, opcionesTransporte, vista, _prueba: { cifrar, descifrar, validar } };
