// Auditoría reforzada para el rol CONSULTA en el módulo Servicios.
//
// Un usuario con rol Consulta puede probar servicios (también PRODUCCIÓN, con confirmación), cargar sus propios
// certificados y guardar sus propias peticiones. A cambio, todo lo que hace queda:
//   1. MARCADO como «Consulta» en la auditoría general (cambio `rolModulo`), para filtrarlo aparte.
//   2. Con MÁS DETALLE: URL completa (con los valores sensibles enmascarados), nombres de las cabeceras enviadas,
//      resultado, duración, certificado usado y un resumen del cuerpo enviado (recortado y sin secretos).
//   3. Con ALERTA por correo al ADMIN_POD, pero SOLO en lo crítico (producción, certificados, TLS sin verificar,
//      exceso de envíos). El resto solo queda en la auditoría: no se mandan correos por cada acción.
//
// Nada de esto afecta a ADMIN_POD ni a ADMIN_MIN: su auditoría sigue como antes.

const { ROL_CONSULTA, rolEnModulo } = require('./permisosModulos');
const { registrarEventoGeneral } = require('./auditoriaGeneral');

const MODULO = 'SERVICIOS';
const MAX_CUERPO_AUDITADO = 1500;
const VENTANA_ALERTA_MS = 10 * 60 * 1000; // un correo por usuario y tipo cada 10 min (lo demás se resume en el siguiente)

const RE_CLAVE_SECRETA = /(pass(word|wd)?|pwd|secret|token|api[-_ ]?key|apikey|authorization|bearer|credential|clave|llave|otp|cvv|signature)/i;
const MASCARA = '***';

// ------------------------------------------------------------------ rol
/** true si quien hace la petición tiene rol Consulta en Servicios (no aplica a ADMIN_POD). Se cachea en req. */
async function esConsulta(req) {
  if (req._esConsultaServicios !== undefined) return req._esConsultaServicios;
  let resultado = false;
  try {
    if (req.user && req.user.rol !== 'ADMIN_POD') resultado = (await rolEnModulo(req, MODULO)) === ROL_CONSULTA;
  } catch (e) {
    console.error('esConsulta: no se pudo determinar el rol:', e.message);
  }
  req._esConsultaServicios = resultado;
  return resultado;
}

// ------------------------------------------------------------------ saneamiento
function enmascararObjeto(valor, profundidad = 0) {
  if (profundidad > 8) return valor;
  if (Array.isArray(valor)) return valor.map((v) => enmascararObjeto(v, profundidad + 1));
  if (valor && typeof valor === 'object') {
    const salida = {};
    for (const [k, v] of Object.entries(valor)) {
      salida[k] = RE_CLAVE_SECRETA.test(k) ? MASCARA : enmascararObjeto(v, profundidad + 1);
    }
    return salida;
  }
  return valor;
}

/** Resumen del cuerpo enviado: sin secretos y recortado. JSON, XML/SOAP, formularios y texto. */
function sanitizarCuerpo(texto, max = MAX_CUERPO_AUDITADO) {
  let t = String(texto === undefined || texto === null ? '' : texto);
  if (!t.trim()) return '';
  const largo = t.length;
  let hecho = false;
  try {
    t = JSON.stringify(enmascararObjeto(JSON.parse(t)));
    hecho = true;
  } catch { /* no es JSON */ }
  if (!hecho) {
    // XML / SOAP: <wsse:Password ...>valor</wsse:Password>, <clave>valor</clave>…
    t = t.replace(/(<(?:[\w.-]+:)?[\w.-]*(?:pass|pwd|secret|token|clave|key|credential|otp|firma|signature)[\w.-]*\b[^>]*>)([^<]+)(<\/)/gi, `$1${MASCARA}$3`);
    // formularios y pares «clave=valor» / «"clave": "valor"»
    t = t.replace(/([?&;\s]|^)([\w.-]*(?:pass|pwd|secret|token|clave|key|credential|otp)[\w.-]*)=([^&\s]+)/gi, `$1$2=${MASCARA}`);
  }
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASCARA}`);
  t = t.replace(/Basic\s+[A-Za-z0-9+/=]{8,}/gi, `Basic ${MASCARA}`);
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > max) t = `${t.slice(0, max)} … [recortado: ${largo} caracteres en total]`;
  return t;
}

/** URL completa con los VALORES sensibles de la query enmascarados (el resto se conserva para poder investigar). */
function enmascararUrl(url) {
  try {
    const u = url instanceof URL ? new URL(url.href) : new URL(String(url));
    for (const k of [...u.searchParams.keys()]) {
      if (RE_CLAVE_SECRETA.test(k)) u.searchParams.set(k, MASCARA);
    }
    u.username = ''; u.password = '';
    return decodeURIComponent(u.href).slice(0, 1500);
  } catch {
    return String(url || '').slice(0, 300);
  }
}

// ------------------------------------------------------------------ auditoría
/**
 * Igual que registrarEventoGeneral, pero si el usuario es Consulta marca el evento y añade el detalle extra.
 * @param {object} datos  lo mismo que registrarEventoGeneral (modulo se asume SERVICIOS)
 * @param {Array}  extraConsulta  cambios [{campo, etiqueta, anterior, nuevo}] que solo se guardan si es Consulta
 */
async function auditarServicios(pool, req, datos, extraConsulta = []) {
  try {
    const consulta = await esConsulta(req);
    const cambios = [...(datos.cambios || [])];
    let detalle = datos.detalle || null;
    if (consulta) {
      cambios.unshift({ campo: 'rolModulo', etiqueta: 'Rol en el módulo', anterior: null, nuevo: 'Consulta' });
      for (const c of extraConsulta) {
        if (c && c.nuevo !== undefined && c.nuevo !== null && c.nuevo !== '') {
          cambios.push({ campo: c.campo, etiqueta: c.etiqueta, anterior: c.anterior === undefined ? null : c.anterior, nuevo: c.nuevo });
        }
      }
      detalle = `[CONSULTA] ${detalle || ''}`.trim();
    }
    await registrarEventoGeneral(pool, req, { modulo: MODULO, ...datos, detalle: detalle ? String(detalle).slice(0, 500) : null, cambios });
  } catch (e) {
    // La auditoría nunca debe impedir lo que el usuario ya hizo.
    console.error('No se pudo auditar el evento de Servicios:', e.message);
  }
}

// ------------------------------------------------------------------ alertas críticas
const ultimaAlerta = new Map(); // `${usuario}|${tipo}` -> { en, omitidas }
let avisoSinCorreoDado = false;

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function correosAdmin(pool) {
  const { dominiosPermitidos } = require('./informes/correo');
  const permitidos = dominiosPermitidos();
  const [filas] = await pool.query("SELECT correo FROM usuarios WHERE rol = 'ADMIN_POD' AND activo = 1 AND correo IS NOT NULL AND correo <> ''");
  return [...new Set(filas.map((f) => String(f.correo).trim().toLowerCase()).filter((c) => permitidos.includes(c.split('@')[1])))];
}

function ipDe(req) {
  const f = req.headers && req.headers['x-forwarded-for'];
  return f ? String(f).split(',')[0].trim() : (req.ip || (req.socket && req.socket.remoteAddress) || '—');
}

/**
 * Avisa por correo a los ADMIN_POD de un evento CRÍTICO hecho por un usuario Consulta. No hace nada si el usuario no
 * es Consulta. No bloquea la petición ni lanza errores. Máximo un correo por usuario y tipo cada 10 minutos.
 * @param {{tipo: string, titulo: string, filas: [string, string][]}} alerta
 */
function alertarCritico(pool, req, alerta) {
  (async () => {
    if (!(await esConsulta(req))) return;
    const usuario = (req.user && (req.user.username || req.user.id)) || '—';
    const clave = `${usuario}|${alerta.tipo}`;
    const previa = ultimaAlerta.get(clave);
    const ahora = Date.now();
    if (previa && ahora - previa.en < VENTANA_ALERTA_MS) { previa.omitidas += 1; return; }
    const omitidas = previa ? previa.omitidas : 0;
    ultimaAlerta.set(clave, { en: ahora, omitidas: 0 });

    const { smtpConfigurado, enviarTexto } = require('./informes/correo');
    if (!smtpConfigurado()) {
      if (!avisoSinCorreoDado) { avisoSinCorreoDado = true; console.warn('[auditoria-consulta] Hay eventos críticos de rol Consulta pero el correo no está configurado: no se envían alertas.'); }
      return;
    }
    const destinatarios = await correosAdmin(pool);
    if (!destinatarios.length) { console.warn('[auditoria-consulta] No hay ADMIN_POD con correo válido para enviar la alerta.'); return; }

    const filas = [
      ['Usuario', `${(req.user && req.user.username) || '—'} (rol Consulta en Servicios)`],
      ...alerta.filas,
      ['IP', ipDe(req)],
      ['Fecha', new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })],
    ];
    if (omitidas) filas.push(['Similares omitidos', `${omitidas} evento(s) del mismo tipo desde el último aviso (están en la auditoría)`]);
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;color:#1e293b">
<div style="background:#b91c1c;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0"><div style="font-size:11px;letter-spacing:1.5px;opacity:.85">AXIS · ALERTA DE AUDITORÍA</div><div style="font-size:18px;font-weight:700;margin-top:4px">${esc(alerta.titulo)}</div></div>
<div style="border:1px solid #e2e8f0;border-top:0;padding:14px 18px;border-radius:0 0 10px 10px"><table style="width:100%;border-collapse:collapse;font-size:13px">${filas.map(([k, v]) => `<tr><td style="padding:5px 10px 5px 0;color:#64748b;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:5px 0;word-break:break-all">${esc(v)}</td></tr>`).join('')}</table>
<p style="font-size:12px;color:#64748b;margin:14px 0 0">Consulta el detalle en Auditoría → General (filtro «Solo rol Consulta»). Solo se avisan los eventos críticos; el resto queda únicamente en la auditoría. No respondas a este correo.</p></div></div>`;
    const texto = `${alerta.titulo}\n\n${filas.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nDetalle en Auditoría → General (Solo rol Consulta).`;
    await enviarTexto({ destinatarios, asunto: `[AXIS] ${alerta.titulo} — ${(req.user && req.user.username) || ''}`, html, texto });
  })().catch((e) => console.error('[auditoria-consulta] No se pudo enviar la alerta:', e.message));
}

module.exports = {
  esConsulta, auditarServicios, alertarCritico, sanitizarCuerpo, enmascararUrl,
  _prueba: { enmascararObjeto, RE_CLAVE_SECRETA, ultimaAlerta },
};
