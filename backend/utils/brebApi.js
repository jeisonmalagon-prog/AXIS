// Consulta de llaves BreB (Swagger del servicio de llaves). SOLO LECTURA y SOLO DOS LLAMADAS FIJAS:
//   · «Consultar llave»: por tipo de persona, tipo de documento y número de documento (qué llaves tiene esa persona en el directorio).
//   · «Resolver llave»: por el valor de la llave/alias (a quién pertenece, entidad y cuenta destino).
// No es un proxy genérico: la ruta sale de la configuración (o se descubre en el documento Swagger), el cuerpo lo arma este módulo
// con campos validados y la dirección base solo la cambia el ADMIN_POD. No se envían credenciales ni se guardan respuestas.

const { URL } = require('url');
const { peticionHttp, mensajeErrorRed } = require('./swaggerCliente');
const S = require('./brebSanitizar');

const RUTA_RESOLVER_DEF = '/api/LlavesBreB/ResolverLLave';
const RUTAS_DOCUMENTO = ['/swagger/v1/swagger.json', '/swagger/swagger.json', '/swagger/docs/v1', '/openapi.json', '/v1/swagger.json'];
const TTL_DESCUBRIR_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 512 * 1024;

class ErrorLlaves extends Error {
  constructor(mensaje, status = 400, codigo = 'VALIDACION') { super(mensaje); this.status = status; this.codigo = codigo; }
}

let global = null; // { url, validarTls, rutaConsultar, rutaResolver }
let descubierto = { en: 0, clave: '', rutas: null };

function establecer(campos) { global = campos ? { ...campos } : null; descubierto = { en: 0, clave: '', rutas: null }; }
function hayGlobal() { return !!global; }

function camposDe(explicita) {
  if (explicita) return { origen: 'pantalla', url: explicita.url || '', validarTls: !!explicita.validarTls, rutaConsultar: explicita.rutaConsultar || '', rutaResolver: explicita.rutaResolver || '' };
  if (global) return { origen: 'guardada', url: global.url || '', validarTls: !!global.validarTls, rutaConsultar: global.rutaConsultar || '', rutaResolver: global.rutaResolver || '' };
  if (process.env.BREB_API_URL) {
    return { origen: 'env', url: String(process.env.BREB_API_URL).trim(), validarTls: /^(1|true|si|yes)$/i.test(String(process.env.BREB_API_VALIDAR_TLS || '')), rutaConsultar: process.env.BREB_API_RUTA_CONSULTAR || '', rutaResolver: process.env.BREB_API_RUTA_RESOLVER || '' };
  }
  return { origen: 'ninguno', url: '', validarTls: false, rutaConsultar: '', rutaResolver: '' };
}

function resumen() {
  const c = camposDe();
  return { nombre: 'Servicio de llaves de BreB', url: c.url || null, validarTls: c.validarTls, rutaConsultar: c.rutaConsultar || null, rutaResolver: c.rutaResolver || null, origen: c.origen, configurada: !!c.url };
}

function urlBase(c) {
  if (!c.url) throw new ErrorLlaves('El servicio de llaves de BreB no está configurado: el ADMIN_POD debe guardar su dirección en Monitoreo transaccional > BREB > Conexiones.', 409, 'SIN_CONFIG');
  try { return new URL(c.url); } catch { throw new ErrorLlaves('La dirección configurada del servicio de llaves no es válida.', 409, 'SIN_CONFIG'); }
}

function unir(base, ruta) {
  const u = new URL(base.href);
  u.pathname = `${base.pathname.replace(/\/+$/, '')}${ruta}`;
  u.search = '';
  u.hash = '';
  return u;
}

async function pedir(c, metodo, ruta, cuerpo) {
  const url = unir(urlBase(c), ruta);
  const r = await peticionHttp(url, {
    metodo, validarTls: c.validarTls, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES,
    headers: { Accept: 'application/json', ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : null,
  });
  return { ...r, texto: r.buffer.toString('utf8') };
}

/** Busca en el documento OpenAPI las rutas POST de llaves: la que recibe numeroDocumento (consultar) y la de resolver. */
function rutasDesdeDocumento(doc) {
  const salida = { consultar: null, resolver: null };
  const paths = doc && typeof doc === 'object' ? doc.paths || {} : {};
  const refSchema = (s) => {
    if (!s) return null;
    if (s.$ref) { const n = String(s.$ref).split('/').pop(); return (doc.components?.schemas || doc.definitions || {})[n] || null; }
    return s;
  };
  for (const [ruta, ops] of Object.entries(paths)) {
    const post = ops && ops.post;
    if (!post || !/llave/i.test(ruta)) continue;
    const cuerpo = post.requestBody?.content ? Object.values(post.requestBody.content)[0]?.schema : (post.parameters || []).find((p) => p.in === 'body')?.schema;
    const props = Object.keys(refSchema(cuerpo)?.properties || {}).map((p) => p.toLowerCase());
    if (props.includes('numerodocumento') && !salida.consultar) salida.consultar = ruta;
    else if (props.includes('aliasvalue') && !salida.resolver) salida.resolver = ruta;
    else if (/consult/i.test(ruta) && !salida.consultar) salida.consultar = ruta;
    else if (/resolv/i.test(ruta) && !salida.resolver) salida.resolver = ruta;
  }
  return salida;
}

async function descubrir(c) {
  const clave = `${c.url}|${c.validarTls}`;
  if (descubierto.rutas && descubierto.clave === clave && Date.now() - descubierto.en < TTL_DESCUBRIR_MS) return descubierto.rutas;
  let rutas = null;
  let ultimoError = null;
  for (const ruta of RUTAS_DOCUMENTO) {
    try {
      const r = await pedir(c, 'GET', ruta);
      if (r.status === 200) {
        const doc = JSON.parse(r.texto);
        if (doc && doc.paths) { rutas = { ...rutasDesdeDocumento(doc), documento: ruta, totalRutas: Object.keys(doc.paths).length }; break; }
      }
    } catch (e) { ultimoError = e; }
  }
  if (!rutas) {
    if (ultimoError) throw ultimoError;
    rutas = { consultar: null, resolver: null, documento: null, totalRutas: 0 };
  }
  descubierto = { en: Date.now(), clave, rutas };
  return rutas;
}

async function rutasEfectivas(c) {
  urlBase(c); // sin dirección configurada: SIN_CONFIG antes de buscar rutas
  let consultar = c.rutaConsultar || null;
  let resolver = c.rutaResolver || null;
  if (!consultar || !resolver) {
    try {
      const d = await descubrir(c);
      consultar = consultar || d.consultar;
      resolver = resolver || d.resolver;
    } catch { /* si el documento no se puede leer, se usan los valores por defecto */ }
  }
  return { consultar, resolver: resolver || RUTA_RESOLVER_DEF };
}

/** Prueba el servicio SIN consumir las llamadas de llaves: solo lee el documento Swagger y dice qué rutas encontró. */
async function probar(borrador) {
  const c = camposDe(borrador || undefined);
  const base = { nombre: 'Servicio de llaves de BreB', url: c.url || null, origen: borrador ? 'pantalla' : c.origen, configurada: !!c.url };
  if (!c.url) return { ok: false, ...base, error: 'No hay una dirección configurada para el servicio de llaves.' };
  try {
    urlBase(c);
    descubierto = { en: 0, clave: '', rutas: null };
    const d = await descubrir(c);
    if (!d.documento) return { ok: false, ...base, error: 'El servicio responde, pero no se encontró el documento Swagger/OpenAPI (se probó /swagger/v1/swagger.json y similares). Puedes indicar las rutas a mano.' };
    const rutas = { consultar: c.rutaConsultar || d.consultar, resolver: c.rutaResolver || d.resolver || RUTA_RESOLVER_DEF };
    return {
      ok: true, ...base, version: `Swagger leído (${d.totalRutas} rutas)`, baseConectada: d.documento,
      rutaConsultar: rutas.consultar || null, rutaResolver: rutas.resolver || null,
      aviso: rutas.consultar ? null : 'No se encontró automáticamente la ruta de «consultar llave»: indícala en el campo «Ruta de consultar llave».',
    };
  } catch (e) {
    return { ok: false, ...base, error: e instanceof ErrorLlaves ? e.message : mensajeErrorRed(e) };
  }
}

// ---------------------------------------------------------------------------
// Llamadas de llaves
// ---------------------------------------------------------------------------
const pad = (n, l = 2) => String(n).padStart(l, '0');

/** Fecha/hora actual con zona de Colombia (-05:00), como la espera el servicio: 2026-10-02T10:04:48.984-05:00. */
function ahoraColombia(d = new Date()) {
  const x = new Date(d.getTime() - 5 * 3600 * 1000);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())}.${pad(x.getUTCMilliseconds(), 3)}-05:00`;
}

const RE_ALIAS = /^[A-Za-z0-9@._+\-]{1,100}$/;
const RE_NUMDOC = /^[A-Za-z0-9]{3,20}$/;

function respuesta(r) {
  const json = S.leerJson(r.texto);
  const limpio = json !== null ? S.limpiarObjeto(json) : null;
  return {
    http: r.status, ms: r.duracionMs, ok: r.status >= 200 && r.status < 300,
    campos: limpio !== null ? S.aplanar(limpio) : [],
    payload: S.limpiarPayload(r.texto, { max: 8000 }),
  };
}

async function llamar(c, ruta, cuerpo) {
  try {
    return respuesta(await pedir(c, 'POST', ruta, cuerpo));
  } catch (e) {
    if (e instanceof ErrorLlaves) throw e;
    throw new ErrorLlaves(`No se pudo consultar el servicio de llaves: ${mensajeErrorRed(e)}`, 502, 'CONEXION');
  }
}

async function consultarLlave({ idTipoPersona, idTipoDocumento, numeroDocumento }) {
  const tp = Number(idTipoPersona);
  const td = Number(idTipoDocumento);
  if (!Number.isInteger(tp) || tp < 0 || tp > 1000) throw new ErrorLlaves('El tipo de persona no es válido.');
  if (!Number.isInteger(td) || td < 0 || td > 1000) throw new ErrorLlaves('El tipo de documento no es válido.');
  const doc = String(numeroDocumento ?? '').trim();
  if (!RE_NUMDOC.test(doc)) throw new ErrorLlaves('El documento debe tener entre 3 y 20 letras o números, sin espacios ni símbolos.');
  const c = camposDe();
  const rutas = await rutasEfectivas(c);
  if (!rutas.consultar) throw new ErrorLlaves('No se encontró la ruta de «consultar llave» en el Swagger del servicio: el ADMIN_POD puede indicarla en BREB > Conexiones > Servicio de llaves.', 409, 'SIN_RUTA');
  const r = await llamar(c, rutas.consultar, { idTipoPersona: tp, idTipoDocumento: td, numeroDocumento: doc });
  return { operacion: 'consultar', ruta: rutas.consultar, ...r };
}

async function resolverLlave({ aliasValue, received }) {
  const alias = String(aliasValue ?? '').trim();
  if (!RE_ALIAS.test(alias)) throw new ErrorLlaves('La llave debe tener entre 1 y 100 caracteres (letras, números, @ . _ + -), sin espacios.');
  let recibido = String(received ?? '').trim();
  if (!recibido) recibido = ahoraColombia();
  else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?([+-]\d{2}:\d{2}|Z)$/.test(recibido)) throw new ErrorLlaves('La fecha «received» debe tener el formato 2026-10-02T10:04:48.984-05:00.');
  const c = camposDe();
  const rutas = await rutasEfectivas(c);
  const r = await llamar(c, rutas.resolver, { aliasValue: alias, received: recibido });
  return { operacion: 'resolver', ruta: rutas.resolver, recibido, ...r };
}

module.exports = {
  ErrorLlaves, establecer, hayGlobal, resumen, probar, consultarLlave, resolverLlave, rutasDesdeDocumento, ahoraColombia, camposDe,
};
