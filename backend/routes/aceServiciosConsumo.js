// Consumo de servicios desde AXIS (equivalente simple a SoapUI / Postman).
//
//   POST /api/ace-servicios/:id/consumir
//
// El navegador NO llama al servicio (CORS, certificados internos, redes que solo ve el servidor):
// envía la petición a este backend y es el backend quien la ejecuta y devuelve la respuesta.
//
// Controles de seguridad (todos del lado servidor, no se pueden saltar desde la pantalla):
//  - Solo http/https. Se bloquea loopback (127.x, ::1, localhost), 0.0.0.0 y link-local
//    (169.254.x.x: metadatos de nube). Se valida la IP ya RESUELTA (anti DNS-rebinding).
//  - Solo se puede llamar a servidores que estén en el inventario de Servicios (host:puerto de
//    las URLs DEV/QA/PRD de ACE 12 y BUS 10). ADMIN_POD puede llamar a cualquier destino; se
//    pueden sumar destinos con la variable SERVICIOS_CONSUMO_HOSTS_EXTRA="host:puerto,host2:puerto".
//  - Un destino que figure como URL de PRODUCCIÓN exige confirmación explícita (confirmarProduccion:true).
//    Lo puede enviar cualquier usuario del módulo, también con rol Consulta; si es Consulta, se avisa al ADMIN_POD.
//  - TLS: se puede elegir un certificado de cliente (mTLS) y se confían las CA internas registradas
//    (ver aceServiciosCertificados.js). Los secretos nunca salen del backend.
//  - «Prueba libre» (POST /consumo/libre/consumir y /consumo/libre/wsdl): permite probar URLs externas y
//    servicios de terceros que NO están en el inventario. Exige permiso de edición en Servicios y solo
//    llega a destinos públicos: las redes internas (10.x, 172.16-31.x, 192.168.x, 100.64.x, fc00::/7)
//    siguen limitadas al inventario (o ADMIN_POD). Se puede apagar con SERVICIOS_CONSUMO_LIBRE=false.
//  - POST /:id/wsdl descarga un WSDL (y los esquemas que importa) para que la pantalla genere las peticiones.
//  - Sin redirecciones, tiempo máximo 120 s, petición y respuesta de hasta 2 MB, máx. 30 envíos
//    por minuto por usuario.
//  - Cada envío queda en la auditoría (método, URL sin query, estado, tiempo). Los usuarios con rol
//    CONSULTA se auditan con más detalle (URL completa con valores sensibles enmascarados, nombres de
//    cabeceras, resumen del cuerpo sin secretos) y quedan marcados como «Consulta»: ver
//    utils/auditoriaConsulta.js. Los valores de las cabeceras nunca se guardan.

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const { auditarServicios, alertarCritico, sanitizarCuerpo, enmascararUrl } = require('../utils/auditoriaConsulta');
const { registrar: registrarCertificados, materialTls } = require('./aceServiciosCertificados');

const METODOS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const CABECERAS_PROHIBIDAS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization']);
const MAX_CUERPO_PETICION = 2 * 1024 * 1024;
const MAX_CUERPO_RESPUESTA = 2 * 1024 * 1024;
const TIMEOUT_POR_DEFECTO_MS = 30 * 1000;
const TIMEOUT_MAXIMO_MS = 120 * 1000;
const MAX_ENVIOS_POR_MINUTO = 30;
const MAX_DOCUMENTOS_WSDL = 30;
const COLUMNAS_URL = ['UrlDev', 'UrlQa', 'UrlPrd', 'UrlDevBus10', 'UrlQaBus10', 'UrlPrdBus10'];
const COLUMNAS_URL_PRD = new Set(['UrlPrd', 'UrlPrdBus10']);

// ---------- utilidades puras (exportadas para pruebas) ----------
function puertoDe(u) {
  return u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
}

function claveHost(u) {
  return `${u.hostname.toLowerCase().replace(/^\[|\]$/g, '')}:${puertoDe(u)}`;
}

function ipNoPermitida(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80')) return true; // link-local
    const mapeada = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapeada) return ipNoPermitida(mapeada[1]);
  }
  return false;
}

/** Red interna (RFC 1918, CGNAT, ULA): en «Prueba libre» solo se alcanza si el servidor está en el inventario. */
function ipPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (/^f[cd]/.test(v)) return true;
    const mapeada = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapeada) return ipPrivada(mapeada[1]);
  }
  return false;
}

function consumoLibreActivo() {
  return String(process.env.SERVICIOS_CONSUMO_LIBRE || 'true').toLowerCase() !== 'false';
}

function hostNoPermitido(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return net.isIP(h) ? ipNoPermitida(h) : false;
}

function parsearUrl(texto) {
  let u;
  try { u = new URL(String(texto || '').trim()); } catch { return { error: 'La URL no es válida. Debe empezar con http:// o https://' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Solo se permiten URL http:// o https://' };
  if (u.username || u.password) return { error: 'No pongas usuario y contraseña dentro de la URL: usa la pestaña de autorización.' };
  if (hostNoPermitido(u.hostname)) return { error: 'Ese destino no está permitido (equipo local o dirección reservada).' };
  return { url: u };
}

function limpiarCabeceras(lista) {
  const salida = {};
  if (!Array.isArray(lista)) return salida;
  for (const c of lista.slice(0, 60)) {
    const nombre = String((c && c.nombre) || '').trim();
    const valor = String((c && c.valor) ?? '');
    if (!nombre || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(nombre)) continue;
    if (CABECERAS_PROHIBIDAS.has(nombre.toLowerCase())) continue;
    if (/[\r\n\0]/.test(valor)) continue; // evita inyección de cabeceras
    salida[nombre] = valor;
  }
  return salida;
}

function esTextoLegible(contentType, buffer) {
  const ct = String(contentType || '').toLowerCase();
  if (/(text\/|json|xml|html|javascript|x-www-form-urlencoded|yaml|csv|soap)/.test(ct)) return true;
  if (!ct) return !buffer.subarray(0, 512).includes(0);
  return false;
}

// ---------- inventario de destinos permitidos ----------
let cacheHosts = { en: 0, permitidos: new Set(), produccion: new Set() };
async function hostsDelInventario(pool) {
  if (Date.now() - cacheHosts.en < 60 * 1000) return cacheHosts;
  const permitidos = new Set();
  const produccion = new Set();
  const [filas] = await pool.query('SELECT * FROM AceServiciosInventario');
  for (const f of filas) {
    for (const col of COLUMNAS_URL) {
      const valor = f[col];
      if (!valor) continue;
      try {
        const u = new URL(String(valor).trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        permitidos.add(claveHost(u));
        if (COLUMNAS_URL_PRD.has(col)) produccion.add(claveHost(u));
      } catch { /* URL mal escrita en el inventario: se ignora */ }
    }
  }
  for (const extra of String(process.env.SERVICIOS_CONSUMO_HOSTS_EXTRA || '').split(',')) {
    const e = extra.trim().toLowerCase();
    if (e) permitidos.add(e.includes(':') ? e : `${e}:443`);
  }
  cacheHosts = { en: Date.now(), permitidos, produccion };
  return cacheHosts;
}

// ---------- límite por usuario ----------
const envios = new Map();
function excedeLimite(usuarioId) {
  const ahora = Date.now();
  const lista = (envios.get(usuarioId) || []).filter((t) => ahora - t < 60 * 1000);
  if (lista.length >= MAX_ENVIOS_POR_MINUTO) { envios.set(usuarioId, lista); return true; }
  lista.push(ahora);
  envios.set(usuarioId, lista);
  return false;
}

// ---------- ejecución ----------
function ejecutar({ metodo, url, cabeceras, cuerpo, timeoutMs, verificarTls, tlsOpciones, soloPublica }) {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const esHttps = url.protocol === 'https:';
    const buffer = cuerpo ? Buffer.from(cuerpo, 'utf8') : null;
    const opciones = {
      method: metodo,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: puertoDe(url),
      path: `${url.pathname}${url.search}`,
      headers: { ...cabeceras },
      // Se valida la IP resuelta justo antes de conectar (evita que un DNS apunte a 127.0.0.1).
      lookup: (host, opts, cb) => dns.lookup(host, opts, (err, address, family) => {
        if (err) return cb(err);
        const lista = Array.isArray(address) ? address : [{ address, family }];
        if (lista.some((a) => ipNoPermitida(a.address))) {
          const e = new Error('El destino resuelve a una dirección no permitida.'); e.code = 'DESTINO_NO_PERMITIDO'; return cb(e);
        }
        if (soloPublica && lista.some((a) => ipPrivada(a.address))) {
          const e = new Error('Ese servidor está en una red interna y no figura en el inventario de Servicios: la prueba libre solo llega a destinos públicos.'); e.code = 'DESTINO_NO_PERMITIDO'; return cb(e);
        }
        return Array.isArray(address) ? cb(null, address) : cb(null, address, family);
      }),
    };
    if (esHttps) Object.assign(opciones, tlsOpciones || {}, { rejectUnauthorized: verificarTls });
    if (buffer && !Object.keys(opciones.headers).some((h) => h.toLowerCase() === 'content-length')) {
      opciones.headers['Content-Length'] = buffer.length;
    }
    if (!Object.keys(opciones.headers).some((h) => h.toLowerCase() === 'accept-encoding')) opciones.headers['Accept-Encoding'] = 'identity';
    if (!Object.keys(opciones.headers).some((h) => h.toLowerCase() === 'user-agent')) opciones.headers['User-Agent'] = 'AXIS-Servicios/1.0';

    let terminado = false;
    const fin = (r) => { if (!terminado) { terminado = true; resolve({ ...r, duracionMs: Date.now() - inicio }); } };

    const req = (esHttps ? https : http).request(opciones, (res) => {
      const partes = [];
      let total = 0;
      let truncado = false;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total <= MAX_CUERPO_RESPUESTA) partes.push(chunk);
        else { truncado = true; }
      });
      res.on('end', () => {
        let crudo = Buffer.concat(partes);
        const codificacion = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (codificacion === 'gzip') crudo = zlib.gunzipSync(crudo);
          else if (codificacion === 'deflate') crudo = zlib.inflateSync(crudo);
          else if (codificacion === 'br') crudo = zlib.brotliDecompressSync(crudo);
        } catch { /* si el cuerpo estaba truncado no se puede descomprimir: se deja tal cual */ }
        const esTexto = esTextoLegible(res.headers['content-type'], crudo);
        const headers = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.push({ nombre: res.rawHeaders[i], valor: res.rawHeaders[i + 1] });
        fin({
          estado: res.statusCode,
          estadoTexto: res.statusMessage || '',
          headers,
          esTexto,
          cuerpo: esTexto ? crudo.toString('utf8') : '',
          tamanoBytes: total,
          truncado,
        });
      });
      res.on('error', (e) => fin({ errorRed: { codigo: e.code || 'ERROR', mensaje: e.message } }));
    });
    req.setTimeout(timeoutMs, () => {
      fin({ errorRed: { codigo: 'TIMEOUT', mensaje: `El servicio no respondió en ${Math.round(timeoutMs / 1000)} segundos.` } });
      req.destroy();
    });
    req.on('error', (e) => fin({ errorRed: { codigo: e.code || 'ERROR', mensaje: traducirError(e, !!(tlsOpciones && (tlsOpciones.pfx || tlsOpciones.cert))) } }));
    if (buffer) req.write(buffer);
    req.end();
  });
}

function traducirError(e, conCertificadoCliente = false) {
  const c = e.code || '';
  const texto = `${c} ${e.message}`;
  if (c === 'ECONNREFUSED') return 'Conexión rechazada: el servidor no escucha en ese puerto.';
  if (c === 'ENOTFOUND') return 'No se encontró el servidor (el nombre no resuelve en DNS).';
  if (c === 'ETIMEDOUT' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'No hay ruta de red desde el servidor de AXIS hasta ese destino (firewall o segmento).';
  if (c === 'DESTINO_NO_PERMITIDO') return e.message;
  if (/SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_UNTRUSTED|DEPTH_ZERO/i.test(texto)) {
    return 'El certificado del servicio no es de confianza para AXIS (cadena autofirmada o de una CA interna). Registra su CA (botón «Administrar» junto al certificado) o desmarca «Validar certificado del servidor».';
  }
  if (/CERT_HAS_EXPIRED/i.test(texto)) return 'El certificado del servicio está vencido.';
  if (/ALTNAME_INVALID|hostname/i.test(texto) && /cert|tls/i.test(texto)) {
    const host = (e.message.match(/Host: (\S+?)\.? is not/) || [])[1];
    const nombres = (e.message.match(/altnames: (.+)$/) || e.message.match(/CN: (.+)$/) || [])[1];
    const detalle = nombres ? ` El certificado es para «${nombres.replace(/DNS:|IP Address:/g, '').replace(/\s+/g, ' ').trim()}»${host ? ` y te conectas a «${host}»` : ''}.` : '';
    return `El certificado del servicio no corresponde al nombre del servidor al que te conectas.${detalle} Usa la URL con el nombre del certificado o desmarca «Validar certificado del servidor» (SoapUI no valida el nombre).`;
  }
  if (/handshake failure|bad certificate|certificate required|unknown ca|ssl.*alert|tlsv1 alert/i.test(texto) || (c === 'ECONNRESET' && !conCertificadoCliente)) {
    return conCertificadoCliente
      ? 'El servidor rechazó el certificado de cliente (no lo reconoce, está vencido o no tiene permiso).'
      : 'El servidor cerró la conexión TLS. Si exige certificado de cliente (mTLS), elige uno en «Certificado de cliente».';
  }
  if (c === 'ECONNRESET') return 'El servidor cerró la conexión sin responder.';
  return e.message || 'Error de red.';
}

function sinQuery(u) {
  return `${u.protocol}//${u.host}${u.pathname}`;
}

/**
 * Reglas de destino compartidas por «consumir» y «wsdl».
 * @returns {{error: string, status: number, extra?: object} | {url: URL, clave: string, esProduccion: boolean}}
 */
async function validarDestino(pool, req, textoUrl, { exigirConfirmacionProduccion, confirmado, hostBase, libre }) {
  const analisis = parsearUrl(textoUrl);
  if (analisis.error) return { error: analisis.error, status: 400 };
  const url = analisis.url;
  const esAdminPod = req.user.rol === 'ADMIN_POD';
  const { permitidos, produccion } = await hostsDelInventario(pool);
  const clave = claveHost(url);
  const enInventario = permitidos.has(clave) || clave === hostBase;
  let soloPublica = false;
  if (libre) {
    // Prueba libre: cualquier destino público; las redes internas siguen exigiendo inventario.
    soloPublica = !esAdminPod && !enInventario;
    const h = url.hostname.replace(/^\[|\]$/g, '');
    if (soloPublica && net.isIP(h) && ipPrivada(h)) {
      return { status: 403, error: `El destino ${clave} es una dirección de red interna que no está en el inventario de Servicios. La prueba libre solo llega a destinos públicos.` };
    }
  } else if (!esAdminPod && !enInventario) {
    return {
      status: 403,
      error: `El destino ${clave} no está en el inventario de Servicios. Solo se puede probar contra los servidores registrados en las URLs de los servicios (pide al ADMIN_POD si necesitas otro).`,
    };
  }
  const esProduccion = produccion.has(clave);
  if (esProduccion && exigirConfirmacionProduccion) {
    if (confirmado !== true) {
      return { status: 409, error: 'El destino es PRODUCCIÓN: confirma el envío.', extra: { requiereConfirmarProduccion: true } };
    }
  }
  return { url, clave, esProduccion, soloPublica };
}

async function nombreServicio(pool, id) {
  try {
    const [[s]] = await pool.query('SELECT NombreServicio FROM AceServiciosInventario WHERE Id = ?', [id]);
    return s ? s.NombreServicio : null;
  } catch { return null; }
}

function registrar(router, { getPool }) {
  registrarCertificados(router, { getPool });

  const consumir = (libre) => async (req, res) => {
    try {
      if (libre && !consumoLibreActivo()) return res.status(403).json({ error: 'La prueba libre está deshabilitada en este servidor.' });
      const pool = await getPool();
      const b = req.body || {};
      const metodo = String(b.metodo || 'POST').toUpperCase();
      if (!METODOS.has(metodo)) return res.status(400).json({ error: 'Método HTTP no permitido.' });

      const cuerpo = b.cuerpo === undefined || b.cuerpo === null ? '' : String(b.cuerpo);
      if (Buffer.byteLength(cuerpo, 'utf8') > MAX_CUERPO_PETICION) return res.status(400).json({ error: 'El cuerpo de la petición supera 2 MB.' });
      if (['GET', 'HEAD'].includes(metodo) && cuerpo) return res.status(400).json({ error: `Una petición ${metodo} no lleva cuerpo.` });

      const d = await validarDestino(pool, req, b.url, { exigirConfirmacionProduccion: true, confirmado: b.confirmarProduccion, libre });
      if (d.error) return res.status(d.status).json({ error: d.error, ...(d.extra || {}) });

      let material;
      try { material = await materialTls(pool, req.user, Number(b.certificadoId) || null); }
      catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

      if (excedeLimite(req.user.id)) {
        await auditarServicios(pool, req, {
          entidad: 'Servicio ACE', entidadId: libre ? null : req.params.id, entidadNombre: libre ? 'Prueba libre (URL externa)' : await nombreServicio(pool, req.params.id),
          accion: 'CONSUMO_BLOQUEADO', detalle: `Límite de ${MAX_ENVIOS_POR_MINUTO} envíos por minuto superado → ${metodo} ${sinQuery(d.url)}`,
        });
        alertarCritico(pool, req, { tipo: 'LIMITE', titulo: 'Un usuario Consulta superó el límite de envíos', filas: [['Destino', sinQuery(d.url)], ['Límite', `${MAX_ENVIOS_POR_MINUTO} envíos por minuto`]] });
        return res.status(429).json({ error: 'Demasiados envíos seguidos. Espera un minuto e inténtalo de nuevo.' });
      }

      const timeoutMs = Math.min(Math.max(Number(b.timeoutSegundos) * 1000 || TIMEOUT_POR_DEFECTO_MS, 1000), TIMEOUT_MAXIMO_MS);
      const resultado = await ejecutar({
        metodo, url: d.url, cuerpo, timeoutMs,
        cabeceras: limpiarCabeceras(b.cabeceras),
        verificarTls: b.verificarTls !== false,
        tlsOpciones: material.opciones,
        soloPublica: d.soloPublica,
      });

      const resumen = resultado.errorRed ? `${resultado.errorRed.codigo}` : `HTTP ${resultado.estado}`;
      const sinVerificarTls = b.verificarTls === false;
      const cabecerasEnviadas = Object.keys(limpiarCabeceras(b.cabeceras));
      // La auditoría no debe impedir devolver la respuesta que el usuario ya esperó (auditarServicios no lanza errores).
      await auditarServicios(pool, req, {
        entidad: 'Servicio ACE',
        entidadId: libre ? null : req.params.id,
        entidadNombre: libre ? 'Prueba libre (URL externa)' : await nombreServicio(pool, req.params.id),
        accion: 'CONSUMO',
        detalle: `${libre ? '[LIBRE] ' : ''}${metodo} ${sinQuery(d.url)} → ${resumen} (${resultado.duracionMs} ms)${d.esProduccion ? ' [PRODUCCIÓN]' : ''}${material.nombreCliente ? ` [cert: ${material.nombreCliente}]` : ''}${sinVerificarTls ? ' [sin verificar TLS]' : ''}`,
      }, [
        { campo: 'url', etiqueta: 'URL completa', nuevo: enmascararUrl(d.url) },
        { campo: 'ambiente', etiqueta: 'Ambiente', nuevo: d.esProduccion ? 'PRODUCCIÓN (confirmado)' : 'No producción' },
        { campo: 'cabeceras', etiqueta: 'Cabeceras enviadas (solo nombres)', nuevo: cabecerasEnviadas.join(', ') },
        { campo: 'certificado', etiqueta: 'Certificado de cliente', nuevo: material.nombreCliente },
        { campo: 'tls', etiqueta: 'Verificación TLS', nuevo: sinVerificarTls ? 'DESACTIVADA' : null },
        { campo: 'resultado', etiqueta: 'Resultado', nuevo: `${resumen}${resultado.estadoTexto ? ` ${resultado.estadoTexto}` : ''} · ${resultado.duracionMs} ms${resultado.tamanoBytes !== undefined ? ` · ${resultado.tamanoBytes} bytes recibidos` : ''}${resultado.errorRed ? ` · ${resultado.errorRed.mensaje}` : ''}` },
        { campo: 'cuerpo', etiqueta: 'Cuerpo enviado (recortado, sin secretos)', nuevo: sanitizarCuerpo(cuerpo) },
      ]);
      if (d.esProduccion) {
        alertarCritico(pool, req, {
          tipo: 'PRODUCCION', titulo: 'Un usuario Consulta envió una petición a PRODUCCIÓN',
          filas: [['Servicio', libre ? 'Prueba libre' : (await nombreServicio(pool, req.params.id)) || `#${req.params.id}`], ['Petición', `${metodo} ${sinQuery(d.url)}`], ['Resultado', `${resumen} (${resultado.duracionMs} ms)`], ['Certificado', material.nombreCliente || '—']],
        });
      }
      if (sinVerificarTls) {
        alertarCritico(pool, req, {
          tipo: 'TLS', titulo: 'Un usuario Consulta envió una petición con la verificación TLS desactivada',
          filas: [['Petición', `${metodo} ${sinQuery(d.url)}`], ['Ambiente', d.esProduccion ? 'PRODUCCIÓN' : 'No producción']],
        });
      }

      return res.json({ ...resultado, produccion: d.esProduccion, destino: d.clave });
    } catch (error) {
      console.error('Error al consumir el servicio:', error);
      return res.status(500).json({ error: 'No se pudo ejecutar la petición. Revisa el log del backend.' });
    }
  };
  router.post('/:id/consumir', verifyToken, requireModule('SERVICIOS'), consumir(false));
  router.post('/consumo/libre/consumir', verifyToken, requireModule('SERVICIOS'), requireEditPermission, consumir(true));

  // ---- WSDL: descarga el documento y los esquemas/WSDL que importa; la pantalla arma las peticiones ----
  const leerDefinicion = (libre) => async (req, res) => {
    try {
      if (libre && !consumoLibreActivo()) return res.status(403).json({ error: 'La prueba libre está deshabilitada en este servidor.' });
      const pool = await getPool();
      const b = req.body || {};
      const primera = await validarDestino(pool, req, b.url, { exigirConfirmacionProduccion: false, libre });
      if (primera.error) return res.status(primera.status).json({ error: primera.error });

      let material;
      try { material = await materialTls(pool, req.user, Number(b.certificadoId) || null); }
      catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
      if (excedeLimite(req.user.id)) return res.status(429).json({ error: 'Demasiados envíos seguidos. Espera un minuto e inténtalo de nuevo.' });

      const cabeceras = limpiarCabeceras(b.cabeceras);
      const documentos = [];
      const avisos = [];
      const visitadas = new Set();
      const cola = [{ url: primera.url.href }];
      const RE_IMPORT = /<(?:[\w.-]+:)?(?:import|include)\b[^>]*?\b(?:schemaLocation|location)\s*=\s*["']([^"']+)["']/gi;

      while (cola.length && documentos.length < MAX_DOCUMENTOS_WSDL) {
        const { url: texto } = cola.shift();
        const sinHash = texto.split('#')[0];
        if (visitadas.has(sinHash)) continue;
        visitadas.add(sinHash);
        const esPrimero = documentos.length === 0 && sinHash === primera.url.href.split('#')[0];
        const d = esPrimero ? primera : await validarDestino(pool, req, sinHash, { exigirConfirmacionProduccion: false, hostBase: primera.clave, libre });
        if (d.error) { avisos.push(`No se descargó ${sinHash}: ${d.error}`); continue; }
        const r = await ejecutar({
          metodo: 'GET', url: d.url, cuerpo: '', timeoutMs: TIMEOUT_POR_DEFECTO_MS, cabeceras,
          verificarTls: b.verificarTls !== false, tlsOpciones: material.opciones, soloPublica: d.soloPublica,
        });
        if (r.errorRed || r.estado >= 400 || !r.esTexto) {
          const motivo = r.errorRed ? r.errorRed.mensaje : (r.estado >= 400 ? `HTTP ${r.estado}` : 'la respuesta no es texto');
          if (esPrimero) return res.json({ errorRed: r.errorRed || { codigo: `HTTP_${r.estado || 'ERR'}`, mensaje: `No se pudo descargar el WSDL (${motivo}).` }, documentos: [], avisos: [] });
          avisos.push(`No se descargó ${sinHash}: ${motivo}`);
          continue;
        }
        if (r.truncado) avisos.push(`${sinHash} supera 2 MB y se cortó.`);
        documentos.push({ url: sinHash, texto: r.cuerpo });
        for (const m of r.cuerpo.matchAll(RE_IMPORT)) {
          try { cola.push({ url: new URL(m[1], sinHash).href }); } catch { avisos.push(`Ruta de importación no válida: ${m[1]}`); }
        }
      }
      if (cola.length) avisos.push('Se alcanzó el máximo de documentos importados; puede faltar alguno.');

      await auditarServicios(pool, req, {
        entidad: 'Servicio ACE', entidadId: libre ? null : req.params.id,
        entidadNombre: libre ? 'Prueba libre (URL externa)' : await nombreServicio(pool, req.params.id),
        accion: 'CONSUMO', detalle: `${libre ? '[LIBRE] ' : ''}Lectura de definición ${sinQuery(primera.url)} (${documentos.length} documento(s))`,
      }, [
        { campo: 'url', etiqueta: 'URL completa', nuevo: enmascararUrl(primera.url) },
        { campo: 'certificado', etiqueta: 'Certificado de cliente', nuevo: material.nombreCliente },
        { campo: 'tls', etiqueta: 'Verificación TLS', nuevo: b.verificarTls === false ? 'DESACTIVADA' : null },
      ]);
      if (b.verificarTls === false) {
        alertarCritico(pool, req, { tipo: 'TLS', titulo: 'Un usuario Consulta leyó un WSDL con la verificación TLS desactivada', filas: [['URL', sinQuery(primera.url)]] });
      }

      return res.json({ documentos, avisos });
    } catch (error) {
      console.error('Error al leer el WSDL:', error);
      return res.status(500).json({ error: 'No se pudo leer el WSDL. Revisa el log del backend.' });
    }
  };
  router.post('/:id/wsdl', verifyToken, requireModule('SERVICIOS'), leerDefinicion(false));
  router.post('/consumo/libre/wsdl', verifyToken, requireModule('SERVICIOS'), requireEditPermission, leerDefinicion(true));
}

module.exports = { registrar, _prueba: { parsearUrl, limpiarCabeceras, ipNoPermitida, ipPrivada, claveHost, esTextoLegible, traducirError } };
