// Lector de documentos Swagger / OpenAPI (2.0 y 3.x en JSON).
//
//  1) descubrirDocumento(): a partir de la URL registrada (normalmente la del
//     "index.html" de Swagger UI) encuentra el documento JSON de la API.
//  2) normalizarDocumento(): lo convierte a una estructura simple y estable
//     (operaciones, parámetros, cuerpo de ejemplo...) para que el frontend no
//     tenga que entender las diferencias entre Swagger 2 y OpenAPI 3.
//
// YAML no se soporta (no hay parser YAML en el proyecto): Swagger UI de .NET
// (Swashbuckle) y la mayoría de generadores sirven JSON.

const { URL } = require('url');
const { peticionHttp, mensajeErrorRed } = require('./swaggerCliente');

const METODOS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const MAX_OPERACIONES = 5000;
const MAX_BYTES_DOCUMENTO = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Descubrimiento
// ---------------------------------------------------------------------------
async function pedirTexto(url, validarTls, maxBytes = MAX_BYTES_DOCUMENTO) {
  const r = await peticionHttp(new URL(url), {
    headers: { Accept: 'application/json, text/html;q=0.9, */*;q=0.5' },
    validarTls,
    timeoutMs: 12000,
    maxBytes,
  });
  return { status: r.status, texto: r.buffer.toString('utf8'), truncado: r.truncado, headers: r.headers };
}

function esDocumentoValido(doc) {
  return !!doc && typeof doc === 'object' && (doc.openapi || doc.swagger) && doc.paths && typeof doc.paths === 'object';
}

function pareceUrlDeDocumento(u) {
  const ruta = u.pathname.toLowerCase();
  return /\.(json|ya?ml)$/.test(ruta) || /\/(api-docs|openapi|swagger)(\/[^/]*)?$/.test(ruta) && !/\.html?$/.test(ruta) && !/\/swagger\/?$/.test(ruta) && !/\/swagger\/index$/.test(ruta);
}

function resolver(relativa, base) {
  try { return new URL(relativa, base).toString(); } catch (_) { return null; }
}

// Textos tipo configObject de Swashbuckle llegan a veces con comillas escapadas.
function desescapar(texto) {
  return texto.replace(/\\u0022/g, '"').replace(/\\"/g, '"').replace(/\\\//g, '/');
}

function extraerUrlsDeTexto(texto, base) {
  const t = desescapar(texto);
  const encontradas = [];
  const agregar = (url, nombre) => {
    if (!url || /petstore\.swagger\.io/i.test(url) || /^(javascript|data):/i.test(url)) return;
    const abs = resolver(url, base);
    if (abs && !encontradas.some((e) => e.url === abs)) encontradas.push({ url: abs, nombre: nombre || null });
  };

  // "urls":[{"url":"/swagger/v1/swagger.json","name":"V1"}, ...]
  const bloque = t.match(/["']?urls["']?\s*:\s*\[([\s\S]*?)\]/);
  if (bloque) {
    const re = /\{[^{}]*?["']url["']\s*:\s*["']([^"']+)["'][^{}]*?\}/g;
    let m;
    while ((m = re.exec(bloque[1]))) {
      const nombre = m[0].match(/["']name["']\s*:\s*["']([^"']+)["']/);
      agregar(m[1], nombre ? nombre[1] : null);
    }
  }
  // url: "..."  /  "url":"..."
  const reUrl = /["']?\burl["']?\s*[:=]\s*["']([^"'\s]+)["']/g;
  let m2;
  while ((m2 = reUrl.exec(t))) {
    const u = m2[1];
    if (/\.json|\.ya?ml|api-docs|openapi|swagger/i.test(u)) agregar(u, null);
  }
  return encontradas;
}

function extraerConfigUrl(texto, base) {
  const m = desescapar(texto).match(/configUrl["']?\s*[:=]\s*["']([^"']+)["']/);
  return m ? resolver(m[1], base) : null;
}

function extraerScriptsDeInicio(html, base) {
  const scripts = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/init|config|initializer/i.test(m[1])) {
      const abs = resolver(m[1], base);
      if (abs && !scripts.includes(abs)) scripts.push(abs);
    }
  }
  return scripts.slice(0, 4);
}

function candidatosPorDefecto(base) {
  const u = new URL(base);
  const dir = new URL('./', u).toString();
  const origen = u.origin;
  const lista = [
    `${dir}v1/swagger.json`, `${dir}swagger.json`,
    `${origen}/swagger/v1/swagger.json`, `${origen}/swagger/v2/swagger.json`, `${origen}/swagger/swagger.json`,
    `${origen}/swagger.json`, `${origen}/openapi.json`, `${origen}/v3/api-docs`, `${origen}/v2/api-docs`, `${origen}/api-docs`,
    `${origen}/api/swagger.json`, `${origen}/docs/swagger.json`,
  ];
  return [...new Set(lista)].map((url) => ({ url, nombre: null }));
}

async function intentarDocumento(url, validarTls) {
  try {
    const r = await pedirTexto(url, validarTls);
    if (r.status < 200 || r.status >= 300) return { ok: false, motivo: `HTTP ${r.status}` };
    if (r.truncado) return { ok: false, motivo: 'El documento supera el tamaño máximo permitido' };
    let doc;
    try { doc = JSON.parse(r.texto); } catch (_) {
      if (/^\s*(openapi|swagger)\s*:/m.test(r.texto)) return { ok: false, motivo: 'El documento está en YAML (solo se soporta JSON)' };
      return { ok: false, motivo: 'La respuesta no es JSON' };
    }
    if (!esDocumentoValido(doc)) return { ok: false, motivo: 'El JSON no es un documento Swagger/OpenAPI' };
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, motivo: mensajeErrorRed(e), conexion: true };
  }
}

// Devuelve { definiciones: [{nombre,url}], elegida: indice, urlDocumento, doc }.
// "definicion" es el índice de la definición a abrir cuando hay varias (Swagger UI con selector).
async function descubrirDocumento(urlRegistrada, { validarTls = true, definicion = 0 } = {}) {
  let base;
  try { base = new URL(urlRegistrada); } catch (_) { throw new Error('La URL del Swagger no es válida'); }
  if (!/^https?:$/.test(base.protocol)) throw new Error('La URL del Swagger debe empezar por http:// o https://');

  let definiciones = [];
  const motivos = [];

  if (pareceUrlDeDocumento(base)) {
    definiciones = [{ url: base.toString(), nombre: null }];
  } else {
    // 1) Leer la página de Swagger UI y buscar la URL del documento en ella o en su script de inicio.
    try {
      const pagina = await pedirTexto(base.toString(), validarTls, 3 * 1024 * 1024);
      if (pagina.status >= 200 && pagina.status < 300) {
        const fuentes = [pagina.texto];
        const configUrl = extraerConfigUrl(pagina.texto, base.toString());
        for (const s of extraerScriptsDeInicio(pagina.texto, base.toString())) {
          try {
            const js = await pedirTexto(s, validarTls, 1024 * 1024);
            if (js.status >= 200 && js.status < 300) {
              fuentes.push(js.texto);
              const cu = extraerConfigUrl(js.texto, s);
              if (cu && !configUrl) fuentes.push(await pedirTexto(cu, validarTls, 512 * 1024).then((x) => x.texto).catch(() => ''));
            }
          } catch (_) { /* sigue con las demás fuentes */ }
        }
        if (configUrl) {
          try { fuentes.push((await pedirTexto(configUrl, validarTls, 512 * 1024)).texto); } catch (_) { /* idem */ }
        }
        for (const f of fuentes) {
          for (const u of extraerUrlsDeTexto(f, base.toString())) {
            if (!definiciones.some((d) => d.url === u.url)) definiciones.push(u);
          }
        }
      } else {
        motivos.push(`La página respondió HTTP ${pagina.status}`);
      }
    } catch (e) {
      motivos.push(mensajeErrorRed(e));
      // Si ni siquiera hay conexión con el host no tiene sentido probar candidatos.
      if (e?.codigo && ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(e.codigo)) {
        throw new Error(mensajeErrorRed(e));
      }
    }
    // 2) Candidatos habituales.
    for (const c of candidatosPorDefecto(base.toString())) {
      if (!definiciones.some((d) => d.url === c.url)) definiciones.push({ ...c, candidato: true });
    }
  }

  // Probar en orden; las definiciones "reales" (halladas en la página) se listan todas,
  // los candidatos de respaldo solo se usan si no se encontró ninguna.
  const reales = definiciones.filter((d) => !d.candidato);
  const validas = [];
  const aProbar = reales.length ? reales : definiciones;
  for (const d of aProbar) {
    const r = await intentarDocumento(d.url, validarTls);
    if (r.ok) {
      validas.push({ ...d, doc: r.doc });
      if (!reales.length) break; // con candidatos basta el primero que responda
    } else {
      motivos.push(`${d.url}: ${r.motivo}`);
    }
  }
  if (reales.length && !validas.length) {
    for (const c of definiciones.filter((d) => d.candidato)) {
      const r = await intentarDocumento(c.url, validarTls);
      if (r.ok) { validas.push({ ...c, doc: r.doc }); break; }
      motivos.push(`${c.url}: ${r.motivo}`);
    }
  }

  if (!validas.length) {
    const err = new Error(
      'No se encontró el documento Swagger/OpenAPI (JSON). Registra directamente la URL del swagger.json si la conoces. ' +
      `Detalle: ${motivos.slice(0, 4).join(' | ') || 'sin respuesta'}`
    );
    err.noEncontrado = true;
    throw err;
  }

  const idx = Math.min(Math.max(Number(definicion) || 0, 0), validas.length - 1);
  return {
    definiciones: validas.map((v, i) => ({ indice: i, nombre: v.nombre || tituloDe(v.doc) || `Definición ${i + 1}`, url: v.url })),
    elegida: idx,
    urlDocumento: validas[idx].url,
    doc: validas[idx].doc,
  };
}

function tituloDe(doc) {
  return doc?.info?.title ? `${doc.info.title}${doc.info.version ? ` ${doc.info.version}` : ''}` : null;
}

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------
function crearResolutor(doc) {
  const buscar = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
    let nodo = doc;
    for (const parte of ref.slice(2).split('/')) {
      const clave = parte.replace(/~1/g, '/').replace(/~0/g, '~');
      if (nodo && typeof nodo === 'object' && clave in nodo) nodo = nodo[clave];
      else return undefined;
    }
    return nodo;
  };
  // Sigue una cadena de $ref (con límite) y devuelve el objeto final.
  const deref = (obj) => {
    let actual = obj;
    for (let i = 0; i < 12 && actual && typeof actual === 'object' && actual.$ref; i += 1) {
      const destino = buscar(actual.$ref);
      if (!destino) return { ...actual, _refRota: true };
      actual = destino;
    }
    return actual;
  };
  return { buscar, deref };
}

const FORMATOS_STRING = {
  'date-time': '2024-01-01T00:00:00Z', date: '2024-01-01', time: '00:00:00', uuid: '00000000-0000-0000-0000-000000000000',
  email: 'usuario@ejemplo.com', uri: 'https://ejemplo.com', url: 'https://ejemplo.com', hostname: 'ejemplo.com', ipv4: '127.0.0.1',
  byte: 'c3RyaW5n', binary: '(archivo)', password: 'string',
};

// Genera un valor de ejemplo a partir de un esquema (con control de ciclos y profundidad).
function ejemploDeEsquema(esquema, resolutor, pila = [], profundidad = 0) {
  if (!esquema || typeof esquema !== 'object' || profundidad > 7) return null;
  if (esquema.$ref) {
    if (pila.includes(esquema.$ref)) return null; // referencia circular
    const destino = resolutor.deref(esquema);
    return ejemploDeEsquema(destino, resolutor, [...pila, esquema.$ref], profundidad + 1);
  }
  if (esquema.example !== undefined) return esquema.example;
  if (esquema.default !== undefined) return esquema.default;
  if (Array.isArray(esquema.enum) && esquema.enum.length) return esquema.enum[0];
  if (esquema.const !== undefined) return esquema.const;

  if (Array.isArray(esquema.allOf) && esquema.allOf.length) {
    const piezas = esquema.allOf.map((s) => ejemploDeEsquema(s, resolutor, pila, profundidad + 1));
    if (piezas.every((p) => p && typeof p === 'object' && !Array.isArray(p))) return Object.assign({}, ...piezas);
    return piezas.find((p) => p !== null) ?? null;
  }
  for (const clave of ['oneOf', 'anyOf']) {
    if (Array.isArray(esquema[clave]) && esquema[clave].length) return ejemploDeEsquema(esquema[clave][0], resolutor, pila, profundidad + 1);
  }

  const tipo = Array.isArray(esquema.type) ? esquema.type.find((t) => t !== 'null') : esquema.type;
  if (tipo === 'object' || esquema.properties || esquema.additionalProperties) {
    const salida = {};
    const props = esquema.properties || {};
    Object.keys(props).slice(0, 60).forEach((k) => {
      if (props[k] && props[k].readOnly) return; // lo calcula el servidor
      salida[k] = ejemploDeEsquema(props[k], resolutor, pila, profundidad + 1);
    });
    if (!Object.keys(props).length && esquema.additionalProperties && typeof esquema.additionalProperties === 'object') {
      salida.clave = ejemploDeEsquema(esquema.additionalProperties, resolutor, pila, profundidad + 1);
    }
    return salida;
  }
  if (tipo === 'array') return [ejemploDeEsquema(esquema.items, resolutor, pila, profundidad + 1)];
  if (tipo === 'integer' || tipo === 'number') return esquema.minimum !== undefined ? esquema.minimum : 0;
  if (tipo === 'boolean') return false;
  if (tipo === 'string' || esquema.format) return FORMATOS_STRING[esquema.format] || 'string';
  return null;
}

function resumenTipo(esquema, resolutor) {
  const e = resolutor.deref(esquema) || {};
  let tipo = Array.isArray(e.type) ? e.type.filter((t) => t !== 'null').join('|') : e.type;
  if (tipo === 'array') tipo = `array<${resumenTipo(e.items || {}, resolutor)}>`;
  if (!tipo && e.properties) tipo = 'object';
  if (!tipo && (e.oneOf || e.anyOf || e.allOf)) tipo = 'object';
  if (e.format && tipo && !String(tipo).startsWith('array')) tipo += ` (${e.format})`;
  return tipo || 'string';
}

// Describe un esquema como árbol (para la vista "Modelo"): tipo, formato, propiedades, restricciones...
// Tiene límites de profundidad y de tamaño, y corta las referencias circulares.
function nombreDeRef(ref) {
  return typeof ref === 'string' ? ref.split('/').pop().replace(/~1/g, '/').replace(/~0/g, '~') : null;
}

function nodoEsquema(esquema, resolutor, pila = [], profundidad = 0, contador = { n: 0 }) {
  if (!esquema || typeof esquema !== 'object') return { tipo: 'any' };
  contador.n += 1;
  if (contador.n > 400) return { tipo: 'object', truncado: true };
  let ref = null;
  let actual = esquema;
  if (actual.$ref) {
    ref = nombreDeRef(actual.$ref);
    if (pila.includes(actual.$ref)) return { tipo: 'object', ref, circular: true };
    const destino = resolutor.deref(actual);
    if (!destino || destino._refRota) return { tipo: 'any', ref, descripcion: 'Referencia no encontrada' };
    pila = [...pila, actual.$ref];
    actual = destino;
  }
  if (profundidad > 6) return { tipo: actual.type || 'object', ref, truncado: true };

  const nodo = { tipo: Array.isArray(actual.type) ? actual.type.filter((t) => t !== 'null').join('|') : (actual.type || null) };
  if (ref) nodo.ref = ref;
  if (actual.format) nodo.formato = String(actual.format);
  if (actual.description) nodo.descripcion = String(actual.description).slice(0, 600);
  if (actual.nullable === true || (Array.isArray(actual.type) && actual.type.includes('null'))) nodo.nullable = true;
  if (actual.readOnly) nodo.soloLectura = true;
  if (actual.writeOnly) nodo.soloEscritura = true;
  if (actual.deprecated) nodo.deprecado = true;
  if (Array.isArray(actual.enum)) nodo.enum = actual.enum.slice(0, 40);
  if (actual.default !== undefined) nodo.defecto = actual.default;
  if (actual.example !== undefined) nodo.ejemplo = actual.example;
  ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'].forEach((k) => {
    if (actual[k] !== undefined) (nodo.restricciones = nodo.restricciones || {})[k] = actual[k];
  });

  // allOf: se funden las propiedades; oneOf/anyOf: alternativas.
  let propsOrigen = { ...(actual.properties || {}) };
  let requeridos = Array.isArray(actual.required) ? [...actual.required] : [];
  if (Array.isArray(actual.allOf)) {
    actual.allOf.slice(0, 10).forEach((parte) => {
      const d = resolutor.deref(parte) || {};
      if (d.properties) propsOrigen = { ...propsOrigen, ...d.properties };
      if (Array.isArray(d.required)) requeridos = requeridos.concat(d.required);
      if (!nodo.tipo && d.type) nodo.tipo = d.type;
      if (d.$ref === undefined && !d.properties && !d.type) return;
      if (parte.$ref && !d.properties) { /* la referencia no aporta propiedades */ }
    });
  }
  ['oneOf', 'anyOf'].forEach((c) => {
    if (Array.isArray(actual[c]) && actual[c].length) {
      nodo.combinador = c;
      nodo.alternativas = actual[c].slice(0, 8).map((alt) => nodoEsquema(alt, resolutor, pila, profundidad + 1, contador));
    }
  });
  const claves = Object.keys(propsOrigen);
  if (claves.length) {
    nodo.tipo = nodo.tipo || 'object';
    nodo.propiedades = claves.slice(0, 80).map((k) => ({
      nombre: k,
      requerido: requeridos.includes(k),
      ...nodoEsquema(propsOrigen[k], resolutor, pila, profundidad + 1, contador),
    }));
  }
  if (actual.items) {
    nodo.tipo = nodo.tipo || 'array';
    nodo.items = nodoEsquema(actual.items, resolutor, pila, profundidad + 1, contador);
  }
  if (actual.additionalProperties && typeof actual.additionalProperties === 'object') {
    nodo.adicional = nodoEsquema(actual.additionalProperties, resolutor, pila, profundidad + 1, contador);
  }
  if (!nodo.tipo) nodo.tipo = nodo.propiedades ? 'object' : (nodo.alternativas ? 'object' : 'any');
  return nodo;
}

function normalizarParametro(p, resolutor, esSwagger2) {
  const param = resolutor.deref(p) || {};
  const esquema = esSwagger2 ? param : (param.schema || {});
  const e = resolutor.deref(esquema) || {};
  let ejemplo = param.example !== undefined ? param.example : e.example;
  if (ejemplo === undefined && param.examples && typeof param.examples === 'object') {
    const primero = Object.values(param.examples)[0];
    if (primero && typeof primero === 'object') ejemplo = resolutor.deref(primero).value;
  }
  const enumeracion = Array.isArray(e.enum) ? e.enum.slice(0, 50) : (e.items && Array.isArray(e.items.enum) ? e.items.enum.slice(0, 50) : null);
  return {
    nombre: String(param.name || ''),
    en: param.in,
    requerido: param.in === 'path' ? true : !!param.required,
    tipo: resumenTipo(esquema, resolutor),
    descripcion: param.description ? String(param.description) : '',
    enum: enumeracion,
    defecto: e.default !== undefined ? e.default : null,
    ejemplo: ejemplo !== undefined ? ejemplo : null,
    deprecado: !!param.deprecated,
  };
}

function textoDeEjemplo(valor, tipoMime) {
  if (valor === undefined) return '';
  if (typeof valor === 'string' && !/json/i.test(tipoMime)) return valor;
  if (/x-www-form-urlencoded/i.test(tipoMime) && valor && typeof valor === 'object' && !Array.isArray(valor)) {
    return Object.entries(valor).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v))}`).join('&');
  }
  if (/json|\*\/\*/i.test(tipoMime) || typeof valor === 'object') {
    try { return JSON.stringify(valor, null, 2); } catch (_) { return ''; }
  }
  return String(valor);
}

function cuerpoOpenApi3(op, resolutor) {
  const rb = resolutor.deref(op.requestBody);
  if (!rb || !rb.content) return null;
  const tipos = Object.keys(rb.content);
  if (!tipos.length) return null;
  const ejemplos = {};
  const esquemas = {};
  const modelos = {};
  tipos.forEach((t) => {
    const media = rb.content[t] || {};
    if (media.schema) modelos[t] = nodoEsquema(media.schema, resolutor);
    let valor;
    if (media.example !== undefined) valor = media.example;
    else if (media.examples && typeof media.examples === 'object') {
      const primero = Object.values(media.examples)[0];
      valor = primero ? resolutor.deref(primero).value : undefined;
    }
    if (valor === undefined && media.schema) valor = ejemploDeEsquema(media.schema, resolutor);
    if (/xml/i.test(t) && typeof valor !== 'string') ejemplos[t] = '';
    else ejemplos[t] = textoDeEjemplo(valor, t);
    esquemas[t] = media.schema ? resumenTipo(media.schema, resolutor) : null;
  });
  return { requerido: !!rb.required, descripcion: rb.description || '', tipos, ejemplos, esquemas, modelos };
}

function cuerpoSwagger2(op, params, doc, resolutor) {
  const body = params.find((p) => p.in === 'body');
  const form = params.filter((p) => p.in === 'formData');
  const consumes = (op.consumes && op.consumes.length ? op.consumes : doc.consumes) || ['application/json'];
  if (body) {
    const tipos = consumes.length ? consumes : ['application/json'];
    const valor = ejemploDeEsquema(body.schema || {}, resolutor);
    const ejemplos = {};
    const modelos = {};
    const modelo = nodoEsquema(body.schema || {}, resolutor);
    tipos.forEach((t) => { ejemplos[t] = /xml/i.test(t) ? '' : textoDeEjemplo(valor, t); modelos[t] = modelo; });
    return { requerido: !!body.required, descripcion: body.description || '', tipos, ejemplos, esquemas: {}, modelos };
  }
  if (form.length) {
    const tipoForm = consumes.find((t) => /x-www-form-urlencoded/i.test(t)) || 'application/x-www-form-urlencoded';
    const valor = {};
    form.forEach((f) => { valor[f.name] = f.default !== undefined ? f.default : (f.type === 'integer' || f.type === 'number' ? 0 : 'string'); });
    return { requerido: form.some((f) => f.required), descripcion: 'Campos de formulario', tipos: [tipoForm], ejemplos: { [tipoForm]: textoDeEjemplo(valor, tipoForm) }, esquemas: {}, modelos: {} };
  }
  return null;
}

function servidoresDe(doc, urlDocumento) {
  const lista = [];
  const agregar = (u) => {
    if (!u) return;
    const abs = resolver(u, urlDocumento);
    if (abs) {
      const limpia = abs.replace(/\/+$/, '');
      if (!lista.includes(limpia)) lista.push(limpia);
    }
  };
  if (Array.isArray(doc.servers) && doc.servers.length) {
    doc.servers.forEach((s) => {
      let url = String(s.url || '');
      if (s.variables && typeof s.variables === 'object') {
        Object.entries(s.variables).forEach(([k, v]) => { url = url.split(`{${k}}`).join(String(v?.default ?? '')); });
      }
      agregar(url || '/');
    });
  } else if (doc.swagger) {
    const doc0 = new URL(urlDocumento);
    const esquema = (Array.isArray(doc.schemes) && doc.schemes[0]) || doc0.protocol.replace(':', '');
    const host = doc.host || doc0.host;
    agregar(`${esquema}://${host}${doc.basePath || ''}`);
  }
  // Siempre se ofrece el origen del propio documento.
  agregar(new URL(urlDocumento).origin);
  return lista;
}

function esquemasDeSeguridad(doc) {
  const origen = (doc.components && doc.components.securitySchemes) || doc.securityDefinitions || {};
  return Object.entries(origen).map(([nombre, s]) => {
    const e = s || {};
    let tipo = e.type;
    let detalle = '';
    if (tipo === 'http') detalle = e.scheme || '';
    if (tipo === 'basic') { tipo = 'http'; detalle = 'basic'; }
    if (tipo === 'apiKey') detalle = `${e.in || ''}:${e.name || ''}`;
    return {
      nombre, tipo, detalle, descripcion: e.description ? String(e.description).slice(0, 1000) : '',
      esquema: tipo === 'http' ? String(e.scheme || (detalle === 'basic' ? 'basic' : '')).toLowerCase() : '',
      en: tipo === 'apiKey' ? String(e.in || 'header') : '',
      nombreParam: tipo === 'apiKey' ? String(e.name || '') : '',
      formatoBearer: e.bearerFormat ? String(e.bearerFormat) : '',
    };
  });
}

function respuestaDoc(codigo, r, resolutor, esSwagger2, op, doc) {
  const d = resolutor.deref(r) || {};
  const salida = { codigo: String(codigo), descripcion: d.description ? String(d.description) : '', tipos: [], ejemplos: {}, modelos: {}, cabeceras: [] };
  const tiposSwagger2 = (op.produces && op.produces.length ? op.produces : doc.produces) || ['application/json'];
  const contenido = esSwagger2 ? (d.schema ? Object.fromEntries(tiposSwagger2.map((t) => [t, { schema: d.schema, example: d.examples && d.examples[t] }])) : {}) : (d.content || {});
  Object.keys(contenido).slice(0, 6).forEach((t) => {
    const media = contenido[t] || {};
    let valor;
    if (media.example !== undefined) valor = media.example;
    else if (media.examples && typeof media.examples === 'object') {
      const primero = Object.values(media.examples)[0];
      valor = primero ? resolutor.deref(primero).value : undefined;
    }
    if (valor === undefined && media.schema) valor = ejemploDeEsquema(media.schema, resolutor);
    salida.tipos.push(t);
    salida.ejemplos[t] = /xml/i.test(t) && typeof valor !== 'string' ? '' : textoDeEjemplo(valor, t);
    if (media.schema) salida.modelos[t] = nodoEsquema(media.schema, resolutor);
  });
  if (d.headers && typeof d.headers === 'object') {
    salida.cabeceras = Object.entries(d.headers).slice(0, 20).map(([nombre, h]) => {
      const hh = resolutor.deref(h) || {};
      return { nombre, tipo: resumenTipo(esSwagger2 ? hh : (hh.schema || {}), resolutor), descripcion: hh.description ? String(hh.description) : '' };
    });
  }
  return salida;
}

function esquemasDelDocumento(doc, resolutor) {
  const origen = (doc.components && doc.components.schemas) || doc.definitions || {};
  const prefijo = doc.swagger ? '#/definitions/' : '#/components/schemas/';
  return Object.keys(origen).slice(0, 300).map((nombre) => {
    const modelo = nodoEsquema({ $ref: `${prefijo}${nombre.replace(/~/g, '~0').replace(/\//g, '~1')}` }, resolutor);
    let ejemplo = '';
    try { ejemplo = textoDeEjemplo(ejemploDeEsquema({ $ref: `${prefijo}${nombre.replace(/~/g, '~0').replace(/\//g, '~1')}` }, resolutor), 'application/json'); } catch (_) { ejemplo = ''; }
    return { nombre, modelo, ejemplo: ejemplo.length > 20000 ? '' : ejemplo };
  });
}

function normalizarDocumento(doc, urlDocumento) {
  const resolutor = crearResolutor(doc);
  const esSwagger2 = !!doc.swagger;
  const operaciones = [];
  const etiquetasUsadas = new Map();

  for (const [ruta, itemCrudo] of Object.entries(doc.paths || {})) {
    const item = resolutor.deref(itemCrudo) || {};
    for (const metodo of METODOS) {
      const op = item[metodo];
      if (!op || typeof op !== 'object') continue;
      if (operaciones.length >= MAX_OPERACIONES) break;

      // Parámetros del path + de la operación (la operación pisa a igual nombre+ubicación).
      const crudos = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => resolutor.deref(p)).filter((p) => p && p.name && p.in);
      const mapa = new Map();
      crudos.forEach((p) => mapa.set(`${p.in}:${p.name}`, p));
      const unicos = [...mapa.values()];

      const parametros = unicos
        .filter((p) => ['path', 'query', 'header'].includes(p.in))
        .map((p) => normalizarParametro(p, resolutor, esSwagger2));

      const cuerpo = esSwagger2 ? cuerpoSwagger2(op, unicos, doc, resolutor) : cuerpoOpenApi3(op, resolutor);

      const respuestas = Object.entries(op.responses || {}).map(([codigo, r]) => respuestaDoc(codigo, r, resolutor, esSwagger2, op, doc));

      const reqSeguridad = Array.isArray(op.security) ? op.security : (Array.isArray(doc.security) ? doc.security : []);
      const seguridadEsquemas = [...new Set(reqSeguridad.flatMap((s) => Object.keys(s || {})))];
      const seguridad = op.security !== undefined ? (Array.isArray(op.security) && op.security.some((s) => Object.keys(s || {}).length)) : (Array.isArray(doc.security) && doc.security.length > 0);
      const etiquetas = Array.isArray(op.tags) && op.tags.length ? op.tags.map(String) : ['(sin etiqueta)'];
      etiquetas.forEach((t) => etiquetasUsadas.set(t, (etiquetasUsadas.get(t) || 0) + 1));

      operaciones.push({
        id: op.operationId ? String(op.operationId) : `${metodo}:${ruta}`,
        metodo: metodo.toUpperCase(),
        ruta,
        resumen: op.summary ? String(op.summary) : '',
        descripcion: op.description ? String(op.description) : '',
        etiquetas,
        deprecado: !!op.deprecated,
        seguridad,
        seguridadEsquemas,
        operationId: op.operationId ? String(op.operationId) : '',
        docExterna: op.externalDocs && op.externalDocs.url ? { url: String(op.externalDocs.url), descripcion: String(op.externalDocs.description || '') } : null,
        parametros,
        cuerpo,
        respuestas,
      });
    }
  }

  const descripcionesEtiqueta = new Map((Array.isArray(doc.tags) ? doc.tags : []).map((t) => [String(t.name), t.description || '']));
  const etiquetas = [...etiquetasUsadas.entries()]
    .map(([nombre, cantidad]) => ({ nombre, cantidad, descripcion: descripcionesEtiqueta.get(nombre) || '' }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  return {
    info: {
      titulo: doc.info?.title || '',
      version: doc.info?.version || '',
      descripcion: doc.info?.description ? String(doc.info.description).slice(0, 2000) : '',
      especificacion: doc.openapi ? `OpenAPI ${doc.openapi}` : `Swagger ${doc.swagger}`,
      terminos: doc.info?.termsOfService ? String(doc.info.termsOfService) : '',
      contacto: doc.info?.contact ? {
        nombre: String(doc.info.contact.name || ''), correo: String(doc.info.contact.email || ''), url: String(doc.info.contact.url || ''),
      } : null,
      licencia: doc.info?.license ? { nombre: String(doc.info.license.name || ''), url: String(doc.info.license.url || '') } : null,
      docExterna: doc.externalDocs && doc.externalDocs.url ? { url: String(doc.externalDocs.url), descripcion: String(doc.externalDocs.description || '') } : null,
    },
    esquemas: esquemasDelDocumento(doc, resolutor),
    servidores: servidoresDe(doc, urlDocumento),
    seguridad: esquemasDeSeguridad(doc),
    etiquetas,
    operaciones,
    totalOperaciones: operaciones.length,
    truncado: operaciones.length >= MAX_OPERACIONES,
  };
}

module.exports = { descubrirDocumento, normalizarDocumento, ejemploDeEsquema, extraerUrlsDeTexto };
