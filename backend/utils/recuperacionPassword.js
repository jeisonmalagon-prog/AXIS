// Recuperación de contraseña con código de un solo uso (OTP).
//
// Flujo (rutas en routes/recuperacion.js, públicas porque la persona no puede iniciar sesión):
//   1. solicitar  -> se genera un código de 6 dígitos y se envía el MISMO código por correo y/o SMS
//                    a los datos de contacto que tenga la cuenta (usuarios.correo / usuarios.telefono).
//   2. verificar  -> la persona escribe el código (vence a los 10 min, máx. 5 intentos) y recibe un
//                    token de restablecimiento de corta vida (10 min, un solo uso).
//   3. restablecer-> con ese token fija la contraseña nueva (misma política de contraseñas de siempre).
//
// Seguridad: el código NUNCA se guarda (solo su HMAC con el secreto del servidor); las respuestas no
// revelan si un usuario existe; hay límites por IP y por cuenta; las cuentas de Active Directory no
// participan (su contraseña vive en el directorio); todo queda en la auditoría de usuarios.
//
// Esquema (script Claude outputs/agregar_recuperacion_password.sql, o solo si el usuario de BD puede
// hacer DDL): usuarios.correo, usuarios.telefono y la tabla RecuperacionPassword. Mientras no exista
// el esquema la app funciona igual que antes y la recuperación responde con un aviso claro.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { esErrorDePrivilegios, tablaExiste, columnasFaltantes } = require('./esquemaSeguro');
const correo = require('./informes/correo');

const CODIGO_DIGITOS = 6;
const VIGENCIA_CODIGO_MIN = 10;
const VIGENCIA_RESET_MIN = 10;
const MAX_INTENTOS = 5;
const REENVIO_SEG = 60;

const MENSAJE_FALTA_ESQUEMA =
  'La recuperación de contraseña aún no está habilitada: faltan las columnas correo y telefono y la tabla RecuperacionPassword. ' +
  'Ejecuta una vez el script agregar_recuperacion_password.sql con una cuenta con privilegios.';
const MENSAJE_FALTA_COLUMNAS =
  'Faltan las columnas correo y telefono en la tabla usuarios y el usuario de la aplicación no puede crearlas. ' +
  'Ejecuta una vez el script agregar_recuperacion_password.sql con una cuenta con privilegios.';

// ------------------------------------------------------------------ esquema
let columnasOk = false;
let proximaRevisionColumnas = 0;
let tablaOk = false;
let proximaRevisionTabla = 0;

// ¿Existen usuarios.correo y usuarios.telefono? (SELECT sobre information_schema: no exige DDL)
async function contactoDisponible(pool) {
  if (columnasOk) return true;
  if (Date.now() < proximaRevisionColumnas) return false;
  const faltan = await columnasFaltantes(pool, 'usuarios', ['correo', 'telefono']);
  if (!faltan.length) { columnasOk = true; return true; }
  proximaRevisionColumnas = Date.now() + 60000;
  return false;
}

// Igual, pero si faltan intenta crearlas (solo si el usuario de BD puede hacer ALTER).
async function asegurarContacto(pool) {
  if (await contactoDisponible(pool)) return true;
  try {
    await pool.query(`
      ALTER TABLE usuarios
        ADD COLUMN IF NOT EXISTS correo VARCHAR(150) NULL,
        ADD COLUMN IF NOT EXISTS telefono VARCHAR(20) NULL
    `);
    try { await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_correo ON usuarios (correo)'); } catch (e) { if (!esErrorDePrivilegios(e)) throw e; }
  } catch (err) {
    if (esErrorDePrivilegios(err)) return false;
    throw err;
  }
  columnasOk = true;
  return true;
}

async function asegurarTabla(pool) {
  if (tablaOk) return true;
  if (Date.now() < proximaRevisionTabla) return false;
  if (await tablaExiste(pool, 'RecuperacionPassword')) { tablaOk = true; return true; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS RecuperacionPassword (
        Id BIGINT AUTO_INCREMENT PRIMARY KEY,
        Token CHAR(48) NOT NULL,
        UsuarioId INT NOT NULL,
        CodigoHash CHAR(64) NOT NULL,
        Canales VARCHAR(30) NOT NULL,
        Intentos TINYINT NOT NULL DEFAULT 0,
        Estado ENUM('PENDIENTE','VERIFICADA','USADA','BLOQUEADA','REEMPLAZADA') NOT NULL DEFAULT 'PENDIENTE',
        IP VARCHAR(64) NULL,
        CreadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ExpiraEn DATETIME NOT NULL,
        VerificadaEn DATETIME NULL,
        UNIQUE KEY uq_recpass_token (Token),
        INDEX idx_recpass_usuario (UsuarioId, CreadoEn),
        CONSTRAINT fk_recpass_usuario FOREIGN KEY (UsuarioId) REFERENCES usuarios(id) ON DELETE CASCADE
      )
    `);
    tablaOk = true;
    return true;
  } catch (err) {
    if (esErrorDePrivilegios(err)) { proximaRevisionTabla = Date.now() + 60000; return false; }
    throw err;
  }
}

// true cuando todo el esquema necesario está listo (o se pudo crear).
async function esquemaListo(pool) {
  return (await asegurarContacto(pool)) && (await asegurarTabla(pool));
}

// ------------------------------------------------------------------ datos de contacto
const RE_CORREO = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

// '' / null -> null. Devuelve el correo en minúscula o lanza un error 400 con mensaje para la persona.
function normalizarCorreo(valor) {
  const v = String(valor === undefined || valor === null ? '' : valor).trim().toLowerCase();
  if (!v) return null;
  if (v.length > 150 || !RE_CORREO.test(v)) throw Object.assign(new Error('El correo electrónico no es válido.'), { status: 400 });
  const permitidos = correo.dominiosPermitidos();
  if (!permitidos.includes(v.split('@')[1])) {
    throw Object.assign(new Error(`El correo debe ser corporativo (${permitidos.map((d) => '@' + d).join(', ')}).`), { status: 400 });
  }
  return v;
}

// Celular colombiano de 10 dígitos (3001234567) o número internacional (+57…). Guarda siempre "+<país><número>".
function normalizarTelefono(valor) {
  const crudo = String(valor === undefined || valor === null ? '' : valor).trim();
  if (!crudo) return null;
  let limpio = crudo.replace(/[\s().-]/g, '');
  if (limpio.startsWith('00')) limpio = '+' + limpio.slice(2);
  if (!limpio.startsWith('+')) {
    if (/^3\d{9}$/.test(limpio)) limpio = '+57' + limpio;
    else if (/^57\d{10}$/.test(limpio)) limpio = '+' + limpio;
  }
  if (!/^\+\d{8,15}$/.test(limpio)) {
    throw Object.assign(new Error('El teléfono no es válido. Usa un celular de 10 dígitos (ej. 3001234567) o formato internacional (+57…).'), { status: 400 });
  }
  return limpio;
}

function enmascararCorreo(c) {
  if (!c) return null;
  const [u, d] = String(c).split('@');
  return `${u.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}`;
}
function enmascararTelefono(t) {
  if (!t) return null;
  const s = String(t);
  return `${s.slice(0, 3)}*****${s.slice(-2)}`;
}

// ------------------------------------------------------------------ código
function generarCodigo() {
  return String(crypto.randomInt(0, 10 ** CODIGO_DIGITOS)).padStart(CODIGO_DIGITOS, '0');
}
function generarToken() {
  return crypto.randomBytes(24).toString('hex'); // 48 caracteres
}
function secreto() {
  return `${process.env.JWT_SECRET || ''}:recuperacion`;
}
function hashCodigo(token, codigo) {
  return crypto.createHmac('sha256', secreto()).update(`${token}:${String(codigo).trim()}`).digest('hex');
}
function hashIgual(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
// Secreto con el que se firma el token de restablecimiento: distinto al del login, así un token de
// restablecimiento jamás sirve como token de sesión (verifyToken usa solo JWT_SECRET).
function secretoReset() {
  return `${process.env.JWT_SECRET || ''}:reset`;
}

// ------------------------------------------------------------------ límites (en memoria)
function crearLimitador({ max, ventanaMs }) {
  const mapa = new Map();
  const t = setInterval(() => {
    const ahora = Date.now();
    for (const [k, v] of mapa) if (v.every((x) => ahora - x > ventanaMs)) mapa.delete(k);
  }, 5 * 60 * 1000);
  t.unref();
  return {
    // true si todavía puede intentar (y registra el intento).
    permitir(clave) {
      const ahora = Date.now();
      const lista = (mapa.get(clave) || []).filter((x) => ahora - x < ventanaMs);
      if (lista.length >= max) { mapa.set(clave, lista); return false; }
      lista.push(ahora);
      mapa.set(clave, lista);
      return true;
    },
  };
}

// ------------------------------------------------------------------ SMS (proveedor configurable)
// Sin SDK ni proveedor fijo: se llama a la API HTTP del proveedor con una plantilla.
//   SMS_URL           https://api.proveedor.com/sms/send           (si falta, el SMS queda desactivado)
//   SMS_METODO        POST (por defecto)
//   SMS_CONTENT_TYPE  application/json (por defecto) | application/x-www-form-urlencoded
//   SMS_HEADERS       {"Authorization":"Bearer xxxx"}              (JSON; opcional)
//   SMS_BODY          {"to":"{{telefono}}","message":"{{mensaje}}"} (por defecto)
// Marcadores: {{telefono}} (+57300…), {{telefono_sin_mas}} (57300…) y {{mensaje}}; se escapan según el tipo de contenido.
// Éxito = respuesta HTTP 2xx.
function smsConfigurado() { return Boolean(process.env.SMS_URL); }

function llenarPlantilla(plantilla, valores, tipo) {
  return plantilla.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = String(valores[k] === undefined ? '' : valores[k]);
    return /json/i.test(tipo) ? JSON.stringify(v).slice(1, -1) : encodeURIComponent(v);
  });
}

function enviarSms(telefono, mensaje) {
  if (!smsConfigurado()) return Promise.reject(Object.assign(new Error('El SMS no está configurado en el backend (falta SMS_URL).'), { status: 503 }));
  const tipo = process.env.SMS_CONTENT_TYPE || 'application/json';
  const plantilla = process.env.SMS_BODY || '{"to":"{{telefono}}","message":"{{mensaje}}"}';
  const cuerpo = llenarPlantilla(plantilla, { telefono, telefono_sin_mas: telefono.replace(/^\+/, ''), mensaje }, tipo);
  let extra = {};
  try { extra = process.env.SMS_HEADERS ? JSON.parse(process.env.SMS_HEADERS) : {}; } catch (_) { return Promise.reject(new Error('SMS_HEADERS no es un JSON válido.')); }
  const url = new URL(process.env.SMS_URL);
  const lib = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: (process.env.SMS_METODO || 'POST').toUpperCase(),
      headers: { 'Content-Type': tipo, 'Content-Length': Buffer.byteLength(cuerpo), ...extra },
      timeout: 10000,
      rejectUnauthorized: process.env.SMS_TLS_INSECURE === 'true' ? false : undefined,
    }, (res) => {
      let datos = '';
      res.on('data', (d) => { if (datos.length < 2000) datos += d; });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300
        ? resolve({ enviado: true })
        : reject(new Error(`El proveedor de SMS respondió ${res.statusCode}: ${datos.slice(0, 200)}`))));
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado con el proveedor de SMS.')));
    req.on('error', reject);
    req.write(cuerpo);
    req.end();
  });
}

// ------------------------------------------------------------------ mensajes
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function textoSms(codigo) {
  return `AXIS Banco Finandina: tu codigo para recuperar la contrasena es ${codigo}. Vence en ${VIGENCIA_CODIGO_MIN} minutos. No lo compartas con nadie.`;
}

function correoCodigo({ nombre, codigo, marca = '#673ab7' }) {
  const digitos = codigo.split('').map((d) => `<span style="display:inline-block;width:38px;height:48px;line-height:48px;margin:0 3px;border-radius:8px;background:#f1f5f9;border:1px solid #e2e8f0;font-size:26px;font-weight:700;color:#1e293b;text-align:center">${d}</span>`).join('');
  return {
    asunto: 'AXIS · Código para recuperar tu contraseña',
    texto: `Hola ${nombre},\n\nTu código para recuperar la contraseña de AXIS es: ${codigo}\nVence en ${VIGENCIA_CODIGO_MIN} minutos y solo sirve una vez.\n\nSi no fuiste tú, ignora este mensaje: tu contraseña no cambia. Nunca compartas este código.`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
<div style="background:${marca};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0"><div style="font-size:11px;letter-spacing:1.5px;opacity:.85">AXIS · BANCO FINANDINA</div><div style="font-size:20px;font-weight:700;margin-top:6px">Recupera tu contraseña</div></div>
<div style="border:1px solid #e2e8f0;border-top:0;padding:22px 24px;border-radius:0 0 10px 10px">
<p style="margin:0 0 14px;font-size:14px">Hola ${esc(nombre)}, usa este código para continuar:</p>
<div style="text-align:center;margin:18px 0">${digitos}</div>
<p style="margin:0 0 6px;font-size:13px;color:#475569">Vence en <b>${VIGENCIA_CODIGO_MIN} minutos</b> y solo sirve una vez.</p>
<p style="margin:12px 0 0;font-size:12px;color:#64748b">Si no fuiste tú, ignora este mensaje: tu contraseña no cambia. Nunca compartas este código con nadie, ni siquiera con soporte.</p>
</div></div>`,
  };
}

function correoAvisoCambio({ nombre, marca = '#673ab7' }) {
  return {
    asunto: 'AXIS · Tu contraseña fue restablecida',
    texto: `Hola ${nombre},\n\nTu contraseña de AXIS se restableció hace un momento con un código de recuperación.\nSi fuiste tú, no tienes que hacer nada. Si no, avisa de inmediato al administrador de AXIS.`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
<div style="background:${marca};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0"><div style="font-size:11px;letter-spacing:1.5px;opacity:.85">AXIS · BANCO FINANDINA</div><div style="font-size:20px;font-weight:700;margin-top:6px">Tu contraseña fue restablecida</div></div>
<div style="border:1px solid #e2e8f0;border-top:0;padding:22px 24px;border-radius:0 0 10px 10px;font-size:14px">
<p style="margin:0 0 10px">Hola ${esc(nombre)}, tu contraseña de AXIS se restableció hace un momento con un código de recuperación.</p>
<p style="margin:0;color:#475569">Si fuiste tú, no tienes que hacer nada. <b>Si no fuiste tú</b>, avisa de inmediato al administrador de AXIS.</p>
</div></div>`,
  };
}

module.exports = {
  CODIGO_DIGITOS, VIGENCIA_CODIGO_MIN, VIGENCIA_RESET_MIN, MAX_INTENTOS, REENVIO_SEG,
  MENSAJE_FALTA_ESQUEMA, MENSAJE_FALTA_COLUMNAS,
  contactoDisponible, asegurarContacto, esquemaListo,
  normalizarCorreo, normalizarTelefono, enmascararCorreo, enmascararTelefono,
  generarCodigo, generarToken, hashCodigo, hashIgual, secretoReset,
  crearLimitador, smsConfigurado, enviarSms, textoSms, correoCodigo, correoAvisoCambio,
};
