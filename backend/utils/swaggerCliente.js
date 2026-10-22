// Cliente HTTP mínimo del módulo Swagger: hace las peticiones desde el
// SERVIDOR de AXIS (no desde el navegador), porque los Swagger internos suelen
// estar en IPs privadas con certificado autofirmado y sin CORS.
//
// No sigue redirecciones por su cuenta (una redirección podría llevar a otro
// host que el administrador no registró); las devuelve tal cual para que el
// usuario vea el 3xx y su Location.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_BYTES_POR_DEFECTO = 5 * 1024 * 1024;
const TIMEOUT_POR_DEFECTO_MS = 30000;

// Encabezados que el usuario no puede fijar: los controla Node/el protocolo.
const ENCABEZADOS_PROHIBIDOS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'proxy-connection', 'te', 'trailer',
]);

const TIPOS_TEXTO = /json|xml|text|html|javascript|csv|yaml|x-www-form-urlencoded|problem\+|graphql/i;

function esTipoTexto(contentType) {
  if (!contentType) return true; // sin Content-Type, lo más probable es texto
  return TIPOS_TEXTO.test(contentType);
}

// Agentes por modo de validación TLS (se reutilizan para no abrir un socket por petición).
const agentes = {
  validar: new https.Agent({ keepAlive: false, rejectUnauthorized: true }),
  noValidar: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
};

// url: instancia de URL. Devuelve { status, statusTexto, headers, buffer, truncado, duracionMs }.
// Rechaza con Error (con .codigo = código de red) si no hubo respuesta.
function peticionHttp(url, { metodo = 'GET', headers = {}, body = null, validarTls = true, timeoutMs = TIMEOUT_POR_DEFECTO_MS, maxBytes = MAX_BYTES_POR_DEFECTO } = {}) {
  return new Promise((resolve, reject) => {
    const inicio = Date.now();
    const esHttps = url.protocol === 'https:';
    const cuerpo = body === null || body === undefined || body === '' ? null : Buffer.from(String(body), 'utf8');

    const cabeceras = { Accept: '*/*', 'User-Agent': 'AXIS-Swagger/1.0', ...headers };
    if (cuerpo) cabeceras['Content-Length'] = cuerpo.length;

    const opciones = {
      method: metodo,
      headers: cabeceras,
      timeout: timeoutMs,
      ...(esHttps ? { agent: validarTls ? agentes.validar : agentes.noValidar } : {}),
    };

    let terminado = false;
    const fin = (fn, valor) => { if (!terminado) { terminado = true; fn(valor); } };

    const req = (esHttps ? https : http).request(url, opciones, (res) => {
      const trozos = [];
      let total = 0;
      let truncado = false;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          if (!truncado) {
            truncado = true;
            const resto = maxBytes - (total - chunk.length);
            if (resto > 0) trozos.push(chunk.subarray(0, resto));
          }
          res.destroy();
          return;
        }
        trozos.push(chunk);
      });
      const terminar = () => fin(resolve, {
        status: res.statusCode,
        statusTexto: res.statusMessage || '',
        headers: res.headers,
        buffer: Buffer.concat(trozos),
        truncado,
        duracionMs: Date.now() - inicio,
      });
      res.on('end', terminar);
      res.on('close', terminar); // cubre el destroy() por exceso de tamaño
      res.on('error', (e) => { if (truncado) terminar(); else fin(reject, e); });
    });

    req.on('timeout', () => {
      const e = new Error(`Tiempo de espera agotado (${Math.round(timeoutMs / 1000)} s)`);
      e.codigo = 'ETIMEDOUT';
      req.destroy(e);
      fin(reject, e);
    });
    req.on('error', (e) => {
      if (!e.codigo) e.codigo = e.code;
      fin(reject, e);
    });

    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

// Mensaje entendible para el usuario a partir de un error de red.
function mensajeErrorRed(error) {
  const c = error?.codigo || error?.code;
  const detalle = error?.message || String(error);
  switch (c) {
    case 'ECONNREFUSED': return 'Conexión rechazada: el servicio no está escuchando en ese host/puerto.';
    case 'ENOTFOUND': return 'No se pudo resolver el nombre del host.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return 'El host no es alcanzable desde el servidor de AXIS (revisa red/VPN/firewall).';
    case 'ECONNRESET': return 'La conexión fue cerrada por el servidor remoto.';
    case 'ETIMEDOUT': return detalle.startsWith('Tiempo') ? detalle : 'Tiempo de espera agotado al conectar.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `Certificado TLS no válido (${c}). Desactiva «Validar certificado» en el origen si es un certificado autofirmado.`;
    default: return detalle;
  }
}

module.exports = { peticionHttp, mensajeErrorRed, esTipoTexto, ENCABEZADOS_PROHIBIDOS, MAX_BYTES_POR_DEFECTO, TIMEOUT_POR_DEFECTO_MS };
