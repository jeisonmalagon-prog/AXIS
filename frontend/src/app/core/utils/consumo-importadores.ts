import { importarWsdl } from './wsdl-importador';

// Lectura de los archivos de consumo que se adjuntan a un servicio (proyecto SoapUI, colección Postman,
// OpenAPI JSON) para convertirlos en peticiones listas para enviar desde la consola «Probar servicio».
// Todo es local en el navegador: solo se lee texto, no se ejecuta nada.

export interface ParClaveValor {
  nombre: string;
  valor: string;
  activo: boolean;
}

export interface AutorizacionImportada {
  tipo: 'ninguna' | 'basic' | 'bearer' | 'apikey';
  usuario?: string;
  clave?: string;
  token?: string;
  /** API key: nombre de la cabecera (X-API-Key…) y su valor. */
  claveNombre?: string;
  claveValor?: string;
}

export interface SolicitudImportada {
  /** La URL viene del WSDL (soap:address): al elegirla se conserva la del ambiente que el usuario ya eligió. */
  urlDelWsdl?: boolean;
  nombre: string;
  /** Carpeta / interfaz / operación de donde sale (para agrupar en pantalla). */
  grupo: string;
  metodo: string;
  url: string;
  cabeceras: ParClaveValor[];
  cuerpo: string;
  auth: AutorizacionImportada;
}

export type OrigenImportacion = 'SOAPUI' | 'POSTMAN' | 'OPENAPI' | 'WSDL' | 'CURL';

export interface ResultadoImportacion {
  origen: OrigenImportacion;
  solicitudes: SolicitudImportada[];
  /** Variables definidas en el archivo (Postman) más las detectadas como {{variable}}. */
  variables: ParClaveValor[];
  avisos: string[];
}

const METODOS_HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function par(nombre: string, valor: string, activo = true): ParClaveValor {
  return { nombre, valor, activo };
}

function textoSinBom(t: string): string {
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/** Variables {{nombre}} que aparecen en un conjunto de textos. */
export function detectarVariables(textos: string[]): string[] {
  const encontradas = new Set<string>();
  for (const t of textos) {
    // Las que empiezan con $ ({{$guid}}, {{$timestamp}}…) se generan solas al enviar.
    for (const m of t.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) if (!m[1].startsWith('$')) encontradas.add(m[1]);
  }
  return [...encontradas];
}

// ----------------------------------------------------------------------------------------------
// SoapUI
// ----------------------------------------------------------------------------------------------
function hijos(el: Element, local: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === local);
}

function hijo(el: Element, local: string): Element | null {
  return hijos(el, local)[0] || null;
}

function descendientes(el: Element | Document, local: string): Element[] {
  return Array.from(el.getElementsByTagNameNS('*', local));
}

function cabecerasSoapUi(solicitud: Element): ParClaveValor[] {
  // SoapUI guarda las cabeceras como un fragmento XML escapado dentro de un <con:setting>.
  const salida: ParClaveValor[] = [];
  for (const s of descendientes(solicitud, 'setting')) {
    if (!/request-headers$/.test(s.getAttribute('id') || '')) continue;
    const fragmento = (s.textContent || '').trim();
    if (!fragmento) continue;
    try {
      const doc = new DOMParser().parseFromString(fragmento, 'application/xml');
      for (const e of descendientes(doc, 'entry')) {
        const clave = e.getAttribute('key');
        if (clave) salida.push(par(clave, e.getAttribute('value') || ''));
      }
    } catch { /* fragmento ilegible: se ignora */ }
  }
  return salida;
}

function autorizacionSoapUi(solicitud: Element): AutorizacionImportada {
  const cred = hijo(solicitud, 'credentials');
  const tipo = (cred && hijo(cred, 'authType')?.textContent) || '';
  if (/basic|preemptive/i.test(tipo)) {
    return { tipo: 'basic', usuario: (cred && hijo(cred, 'username')?.textContent) || '', clave: (cred && hijo(cred, 'password')?.textContent) || '' };
  }
  return { tipo: 'ninguna' };
}

function importarSoapUi(raiz: Element, avisos: string[]): SolicitudImportada[] {
  const salida: SolicitudImportada[] = [];
  const vistas = new Set<string>();
  const proyecto = raiz.getAttribute('name') || 'Proyecto';

  for (const interfaz of hijos(raiz, 'interface')) {
    const nombreInterfaz = interfaz.getAttribute('name') || 'Interfaz';
    const tipo = (interfaz.getAttribute('type') || '').toLowerCase();
    const soap12 = /1_2|1\.2/.test(interfaz.getAttribute('soapVersion') || '');
    const endpoints = descendientes(interfaz, 'endpoint').filter((e) => e.parentElement?.localName === 'endpoints').map((e) => (e.textContent || '').trim());

    if (tipo === 'wsdl') {
      for (const operacion of hijos(interfaz, 'operation')) {
        const nombreOp = operacion.getAttribute('name') || 'operación';
        const accion = operacion.getAttribute('action') || '';
        for (const llamada of hijos(operacion, 'call')) {
          const cuerpo = hijo(llamada, 'request')?.textContent || '';
          const url = (hijo(llamada, 'endpoint')?.textContent || endpoints[0] || '').trim();
          const cabeceras = cabecerasSoapUi(llamada);
          if (!cabeceras.some((c) => c.nombre.toLowerCase() === 'content-type')) {
            cabeceras.unshift(par('Content-Type', soap12 ? `application/soap+xml;charset=UTF-8;action="${accion}"` : 'text/xml;charset=UTF-8'));
          }
          if (!soap12 && !cabeceras.some((c) => c.nombre.toLowerCase() === 'soapaction')) cabeceras.push(par('SOAPAction', `"${accion}"`));
          const clave = `${url}|${accion}|${cuerpo}`;
          if (vistas.has(clave)) continue;
          vistas.add(clave);
          salida.push({
            nombre: `${nombreOp} · ${llamada.getAttribute('name') || 'Request'}`,
            grupo: `${nombreInterfaz}`,
            metodo: 'POST', url, cabeceras, cuerpo, auth: autorizacionSoapUi(llamada),
          });
        }
      }
    } else if (tipo === 'rest') {
      const base = (interfaz.getAttribute('basePath') || '').replace(/\/$/, '');
      const recorrer = (recurso: Element, rutaPadre: string): void => {
        const ruta = `${rutaPadre}${recurso.getAttribute('path') || ''}`;
        const parametros = descendientes(recurso, 'parameter');
        for (const metodo of hijos(recurso, 'method')) {
          const verbo = (metodo.getAttribute('method') || 'GET').toUpperCase();
          for (const sol of hijos(metodo, 'request')) {
            let url = `${(hijo(sol, 'endpoint')?.textContent || endpoints[0] || '').replace(/\/$/, '')}${base}${ruta}`;
            const consulta: string[] = [];
            for (const p of parametros) {
              const nombreP = hijo(p, 'name')?.textContent || '';
              const valorP = hijo(p, 'value')?.textContent || hijo(p, 'default')?.textContent || '';
              const estilo = (hijo(p, 'style')?.textContent || '').toUpperCase();
              if (!nombreP) continue;
              if (estilo === 'TEMPLATE') url = url.replace(`{${nombreP}}`, encodeURIComponent(valorP));
              else if (estilo === 'QUERY' && valorP) consulta.push(`${encodeURIComponent(nombreP)}=${encodeURIComponent(valorP)}`);
            }
            if (consulta.length) url += (url.includes('?') ? '&' : '?') + consulta.join('&');
            const cabeceras = cabecerasSoapUi(sol);
            const media = sol.getAttribute('mediaType') || '';
            if (media && !cabeceras.some((c) => c.nombre.toLowerCase() === 'content-type') && !['GET', 'HEAD'].includes(verbo)) cabeceras.unshift(par('Content-Type', media));
            const cuerpo = hijo(sol, 'request')?.textContent || '';
            const clave = `${verbo}|${url}|${cuerpo}`;
            if (vistas.has(clave)) continue;
            vistas.add(clave);
            salida.push({
              nombre: `${verbo} ${recurso.getAttribute('path') || '/'} · ${sol.getAttribute('name') || 'Request'}`,
              grupo: nombreInterfaz, metodo: verbo, url, cabeceras, cuerpo, auth: autorizacionSoapUi(sol),
            });
          }
        }
        for (const hijoRecurso of hijos(recurso, 'resource')) recorrer(hijoRecurso, ruta);
      };
      for (const recurso of hijos(interfaz, 'resource')) recorrer(recurso, '');
    }
  }

  // Pasos de tipo "request" dentro de los test suites (suelen traer datos de prueba reales).
  for (const paso of descendientes(raiz, 'testStep')) {
    if ((paso.getAttribute('type') || '').toLowerCase() !== 'request') continue;
    const config = hijo(paso, 'config');
    if (!config) continue;
    const sol = hijo(config, 'request');
    const cuerpo = (sol && hijo(sol, 'request')?.textContent) || (sol && sol.children.length === 0 ? sol.textContent : '') || '';
    const url = (sol && hijo(sol, 'endpoint')?.textContent) || '';
    const accion = hijo(config, 'operation')?.textContent || '';
    if (!cuerpo || !url) continue;
    const clave = `${url}|${accion}|${cuerpo}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    const cabeceras = [par('Content-Type', 'text/xml;charset=UTF-8'), par('SOAPAction', `"${accion}"`)];
    salida.push({ nombre: paso.getAttribute('name') || 'Paso de prueba', grupo: `Pruebas · ${proyecto}`, metodo: 'POST', url: url.trim(), cabeceras, cuerpo, auth: { tipo: 'ninguna' } });
  }

  if (!salida.length) avisos.push('El proyecto de SoapUI no trae peticiones guardadas (solo la definición del WSDL).');
  return salida;
}

// ----------------------------------------------------------------------------------------------
// Postman
// ----------------------------------------------------------------------------------------------
function urlPostman(u: any): string {
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (u.raw) return String(u.raw);
  const protocolo = u.protocol ? `${u.protocol}://` : '';
  const host = Array.isArray(u.host) ? u.host.join('.') : (u.host || '');
  const puerto = u.port ? `:${u.port}` : '';
  const ruta = Array.isArray(u.path) ? `/${u.path.join('/')}` : (u.path ? `/${u.path}` : '');
  const consulta = Array.isArray(u.query) ? u.query.filter((q: any) => !q.disabled && q.key).map((q: any) => `${q.key}=${q.value ?? ''}`).join('&') : '';
  return `${protocolo}${host}${puerto}${ruta}${consulta ? `?${consulta}` : ''}`;
}

function authPostman(a: any): AutorizacionImportada {
  if (!a || !a.type) return { tipo: 'ninguna' };
  const valor = (lista: any, k: string): string => (Array.isArray(lista) ? String((lista.find((x: any) => x.key === k) || {}).value ?? '') : '');
  if (a.type === 'bearer') return { tipo: 'bearer', token: valor(a.bearer, 'token') };
  if (a.type === 'basic') return { tipo: 'basic', usuario: valor(a.basic, 'username'), clave: valor(a.basic, 'password') };
  return { tipo: 'ninguna' };
}

function importarPostman(json: any, avisos: string[]): { solicitudes: SolicitudImportada[]; variables: ParClaveValor[] } {
  const solicitudes: SolicitudImportada[] = [];
  const authColeccion = authPostman(json.auth);
  const recorrer = (items: any[], ruta: string[]): void => {
    for (const it of items || []) {
      if (Array.isArray(it.item)) { recorrer(it.item, [...ruta, it.name || 'Carpeta']); continue; }
      const r = it.request;
      if (!r) continue;
      const req = typeof r === 'string' ? { method: 'GET', url: r } : r;
      let cuerpo = '';
      const cabeceras: ParClaveValor[] = (Array.isArray(req.header) ? req.header : []).map((h: any) => par(String(h.key ?? ''), String(h.value ?? ''), !h.disabled)).filter((h: ParClaveValor) => h.nombre);
      const b = req.body;
      if (b) {
        if (b.mode === 'raw') {
          cuerpo = String(b.raw ?? '');
          const lenguaje = b.options?.raw?.language;
          if (lenguaje === 'json' && !cabeceras.some((h) => h.nombre.toLowerCase() === 'content-type')) cabeceras.push(par('Content-Type', 'application/json'));
          if (lenguaje === 'xml' && !cabeceras.some((h) => h.nombre.toLowerCase() === 'content-type')) cabeceras.push(par('Content-Type', 'text/xml;charset=UTF-8'));
        } else if (b.mode === 'urlencoded') {
          cuerpo = (b.urlencoded || []).filter((x: any) => !x.disabled).map((x: any) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value ?? '')}`).join('&');
          if (!cabeceras.some((h) => h.nombre.toLowerCase() === 'content-type')) cabeceras.push(par('Content-Type', 'application/x-www-form-urlencoded'));
        } else if (b.mode === 'graphql' && b.graphql) {
          cuerpo = JSON.stringify({ query: b.graphql.query, variables: safeJson(b.graphql.variables) });
          if (!cabeceras.some((h) => h.nombre.toLowerCase() === 'content-type')) cabeceras.push(par('Content-Type', 'application/json'));
        } else if (b.mode === 'formdata') {
          avisos.push(`«${it.name}» usa form-data (archivos): no se puede enviar desde aquí, impórtalo en Postman.`);
        }
      }
      const metodo = String(req.method || 'GET').toUpperCase();
      solicitudes.push({
        nombre: it.name || 'Petición',
        grupo: ruta.join(' / ') || 'Colección',
        metodo: METODOS_HTTP.includes(metodo) ? metodo : 'GET',
        url: urlPostman(req.url), cabeceras, cuerpo,
        auth: req.auth ? authPostman(req.auth) : authColeccion,
      });
    }
  };
  recorrer(json.item || [], []);
  const variables: ParClaveValor[] = (Array.isArray(json.variable) ? json.variable : [])
    .filter((v: any) => v.key).map((v: any) => par(String(v.key), String(v.value ?? '')));
  return { solicitudes, variables };
}

function safeJson(t: any): any {
  if (typeof t !== 'string') return t || {};
  try { return JSON.parse(t); } catch { return {}; }
}

// ----------------------------------------------------------------------------------------------
// OpenAPI / Swagger (solo JSON)
// ----------------------------------------------------------------------------------------------
function ejemploDeEsquema(esquema: any, raiz: any, profundidad = 0): any {
  if (!esquema || profundidad > 4) return null;
  if (esquema.$ref && typeof esquema.$ref === 'string') {
    const partes = esquema.$ref.replace(/^#\//, '').split('/');
    let destino: any = raiz;
    for (const p of partes) destino = destino?.[p];
    return ejemploDeEsquema(destino, raiz, profundidad + 1);
  }
  if (esquema.example !== undefined) return esquema.example;
  if (esquema.default !== undefined) return esquema.default;
  if (esquema.enum?.length) return esquema.enum[0];
  switch (esquema.type) {
    case 'object': {
      const o: Record<string, any> = {};
      for (const [k, v] of Object.entries<any>(esquema.properties || {})) o[k] = ejemploDeEsquema(v, raiz, profundidad + 1);
      return o;
    }
    case 'array': return [ejemploDeEsquema(esquema.items, raiz, profundidad + 1)];
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    case 'string': return esquema.format === 'date-time' ? '2026-01-01T00:00:00Z' : '';
    default: return null;
  }
}

function importarOpenApi(json: any): SolicitudImportada[] {
  const salida: SolicitudImportada[] = [];
  const base = json.openapi
    ? ((json.servers && json.servers[0] && json.servers[0].url) || '')
    : `${(json.schemes && json.schemes[0]) || 'https'}://${json.host || ''}${json.basePath || ''}`;
  for (const [ruta, operaciones] of Object.entries<any>(json.paths || {})) {
    for (const [verbo, op] of Object.entries<any>(operaciones || {})) {
      const metodo = verbo.toUpperCase();
      if (!METODOS_HTTP.includes(metodo)) continue;
      const cabeceras: ParClaveValor[] = [];
      let cuerpo = '';
      const contenido = op.requestBody?.content?.['application/json'];
      if (contenido) {
        const ej = contenido.example ?? ejemploDeEsquema(contenido.schema, json);
        cuerpo = JSON.stringify(ej ?? {}, null, 2);
        cabeceras.push(par('Content-Type', 'application/json'));
      } else if (Array.isArray(op.parameters)) {
        const enCuerpo = op.parameters.find((p: any) => p.in === 'body');
        if (enCuerpo) { cuerpo = JSON.stringify(ejemploDeEsquema(enCuerpo.schema, json) ?? {}, null, 2); cabeceras.push(par('Content-Type', 'application/json')); }
      }
      cabeceras.push(par('Accept', 'application/json'));
      salida.push({
        nombre: `${metodo} ${ruta}${op.summary ? ` · ${op.summary}` : ''}`,
        grupo: (op.tags && op.tags[0]) || 'API',
        metodo, url: `${String(base).replace(/\/$/, '')}${ruta}`, cabeceras, cuerpo, auth: { tipo: 'ninguna' },
      });
    }
  }
  return salida;
}

// ----------------------------------------------------------------------------------------------
// cURL (pegar el comando que se copia desde el navegador, Postman, la documentación de una API…)
// ----------------------------------------------------------------------------------------------
function tokenizarShell(texto: string): string[] {
  const tokens: string[] = [];
  let actual = '';
  let hay = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (/\s/.test(c)) { if (hay) { tokens.push(actual); actual = ''; hay = false; } continue; }
    hay = true;
    if (c === "'") {
      const fin = texto.indexOf("'", i + 1);
      actual += texto.slice(i + 1, fin < 0 ? texto.length : fin);
      i = fin < 0 ? texto.length : fin;
    } else if (c === '"') {
      i++;
      while (i < texto.length && texto[i] !== '"') {
        if (texto[i] === '\\' && i + 1 < texto.length && '"\\$`'.includes(texto[i + 1])) i++;
        actual += texto[i++];
      }
    } else if (c === '\\' && i + 1 < texto.length) {
      actual += texto[++i];
    } else {
      actual += c;
    }
  }
  if (hay) tokens.push(actual);
  return tokens;
}

export function importarCurl(texto: string): ResultadoImportacion {
  let t = texto.trim();
  if (/\^"/.test(t)) t = t.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1'); // «Copy as cURL (cmd)» de Windows
  t = t.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ').replace(/^\s*\$\s+/, '');
  const tk = tokenizarShell(t);
  if (!tk.length || !/^curl(\.exe)?$/i.test(tk[0])) throw new Error('Pega un comando que empiece con «curl».');
  const avisos: string[] = [];
  let metodo = '';
  let url = '';
  const cabeceras: ParClaveValor[] = [];
  const datos: string[] = [];
  let auth: AutorizacionImportada = { tipo: 'ninguna' };
  let soloEncabezados = false;
  const cabecera = (h: string): void => {
    const i = h.indexOf(':');
    if (i > 0) cabeceras.push(par(h.slice(0, i).trim(), h.slice(i + 1).trim()));
  };
  for (let i = 1; i < tk.length; i++) {
    const a = tk[i];
    const sig = (): string => tk[++i] ?? '';
    if (a === '-X' || a === '--request') metodo = sig().toUpperCase();
    else if (/^-X./.test(a)) metodo = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') cabecera(sig());
    else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json'].includes(a)) {
      datos.push(sig());
      if (a === '--json') { if (!cabeceras.some((h) => h.nombre.toLowerCase() === 'content-type')) cabeceras.push(par('Content-Type', 'application/json')); }
    } else if (a === '-u' || a === '--user') {
      const v = sig(); const k = v.indexOf(':');
      auth = { tipo: 'basic', usuario: k < 0 ? v : v.slice(0, k), clave: k < 0 ? '' : v.slice(k + 1) };
    } else if (a === '-A' || a === '--user-agent') cabeceras.push(par('User-Agent', sig()));
    else if (a === '-e' || a === '--referer') cabeceras.push(par('Referer', sig()));
    else if (a === '-b' || a === '--cookie') cabeceras.push(par('Cookie', sig()));
    else if (a === '--url') url = sig();
    else if (a === '-I' || a === '--head') soloEncabezados = true;
    else if (a === '-F' || a === '--form') { sig(); avisos.push('El comando usa formulario con archivos (-F): no se puede enviar desde aquí.'); }
    else if (['-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--cert', '--key', '--cacert', '-w', '--write-out'].includes(a)) sig();
    else if (a.startsWith('-')) { /* opciones sin valor (-k, -s, -L, --compressed…) */ }
    else if (!url) url = a;
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('No se encontró una URL http(s) en el comando.');
  let cuerpo = datos.join('&');
  if (cuerpo.trim().startsWith('{') || cuerpo.trim().startsWith('[')) { try { cuerpo = JSON.stringify(JSON.parse(cuerpo), null, 2); } catch { /* se deja como vino */ } }
  if (cuerpo && !cabeceras.some((h) => h.nombre.toLowerCase() === 'content-type')) {
    cabeceras.push(par('Content-Type', /^\s*[{[]/.test(cuerpo) ? 'application/json' : 'application/x-www-form-urlencoded'));
  }
  const m = metodo || (soloEncabezados ? 'HEAD' : cuerpo ? 'POST' : 'GET');
  let ruta = url;
  try { const u = new URL(url); ruta = u.pathname + u.search; } catch { /* queda la URL completa */ }
  return {
    origen: 'CURL', variables: [], avisos,
    solicitudes: [{ nombre: `${m} ${ruta}`.slice(0, 120), grupo: 'cURL', metodo: m, url, cabeceras, cuerpo, auth }],
  };
}

// ----------------------------------------------------------------------------------------------
// Punto de entrada
// ----------------------------------------------------------------------------------------------
export function importarArchivoDeConsumo(nombreArchivo: string, contenido: string): ResultadoImportacion {
  const texto = textoSinBom(contenido).trim();
  const avisos: string[] = [];

  if (texto.startsWith('<')) {
    const doc = new DOMParser().parseFromString(texto, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('El XML está mal formado y no se puede leer.');
    const raiz = doc.documentElement;
    if (raiz.localName === 'soapui-project') {
      const solicitudes = importarSoapUi(raiz, avisos);
      return { origen: 'SOAPUI', solicitudes, variables: [], avisos };
    }
    if (raiz.localName === 'definitions' || raiz.localName === 'description') {
      return importarWsdl([{ url: '', texto }]);
    }
    throw new Error('El XML no es un proyecto de SoapUI.');
  }

  let json: any;
  try { json = JSON.parse(texto); } catch {
    if (/\.ya?ml$/i.test(nombreArchivo)) throw new Error('Los archivos YAML no se pueden leer aquí. Sube la versión JSON o impórtalo en tu aplicación.');
    throw new Error('El archivo no es un XML de SoapUI ni un JSON válido.');
  }
  // Entorno de Postman (Environments → Export): solo trae variables.
  if (json && Array.isArray(json.values) && !json.item && !json.paths) {
    const variables = json.values
      .filter((v: any) => v && v.key)
      .map((v: any) => par(String(v.key), v.enabled === false ? '' : String(v.value ?? ''), v.enabled !== false));
    if (!variables.length) throw new Error('El entorno de Postman no tiene variables.');
    return { origen: 'POSTMAN', solicitudes: [], variables, avisos: [`Se importaron ${variables.length} variables del entorno de Postman (solo quedan en pantalla; no se guardan).`] };
  }
  if (json && json.info && (json.item || json.info.schema)) {
    const { solicitudes, variables } = importarPostman(json, avisos);
    if (!solicitudes.length) avisos.push('La colección no tiene peticiones.');
    return { origen: 'POSTMAN', solicitudes, variables, avisos };
  }
  if (json && (json.openapi || json.swagger) && json.paths) {
    return { origen: 'OPENAPI', solicitudes: importarOpenApi(json), variables: [], avisos };
  }
  throw new Error('No se reconoce el formato. Se aceptan proyectos de SoapUI (.xml), colecciones de Postman (.json) y OpenAPI/Swagger (.json).');
}

// ----------------------------------------------------------------------------------------------
// Formato de respuestas
// ----------------------------------------------------------------------------------------------
export function formatearXml(xml: string): string {
  // Se parte en piezas (etiquetas, comentarios, textos) para que un comentario de varias líneas o un texto largo
  // no se confundan con etiquetas; las etiquetas con muchos atributos se reparten en varias líneas.
  const piezas = xml.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][\s\S]*?>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g) || [];
  const items: string[] = [];
  for (const p of piezas) {
    if (p.startsWith('<')) items.push(p);
    else if (p.trim()) items.push(p.trim());
  }
  const ANCHO = 110;
  const salida: string[] = [];
  let nivel = 0;
  const sangria = (n: number): string => '  '.repeat(n);
  const esApertura = (t: string): boolean => /^<[^!?\/]/.test(t) && !/\/>$/.test(t);
  const esCierre = (t: string): boolean => /^<\//.test(t);
  const nombreDe = (t: string): string => (t.match(/^<\/?([^\s>\/]+)/) || [])[1] || '';
  const escribirEtiqueta = (t: string): void => {
    const atributos = t.match(/\s[^\s=<>\/"']+\s*=\s*(?:"[^"]*"|'[^']*')/g) || [];
    if (atributos.length >= 3 && sangria(nivel).length + t.length > ANCHO) {
      const cierre = /\/>$/.test(t) ? '/>' : '>';
      salida.push(`${sangria(nivel)}<${nombreDe(t)}`);
      atributos.forEach((a, k) => salida.push(`${sangria(nivel + 2)}${a.trim()}${k === atributos.length - 1 ? cierre : ''}`));
    } else {
      salida.push(`${sangria(nivel)}${t}`);
    }
  };
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    if (esCierre(t)) {
      nivel = Math.max(nivel - 1, 0);
      escribirEtiqueta(t);
    } else if (esApertura(t)) {
      const sig = items[i + 1];
      const sig2 = items[i + 2];
      // <x>texto</x> o <x></x> se dejan en una sola línea.
      if (sig !== undefined && esCierre(sig) && nombreDe(sig) === nombreDe(t)) {
        salida.push(`${sangria(nivel)}${t}${sig}`);
        i += 1;
      } else if (sig !== undefined && !sig.startsWith('<') && sig2 !== undefined && esCierre(sig2) && nombreDe(sig2) === nombreDe(t)) {
        salida.push(`${sangria(nivel)}${t}${sig}${sig2}`);
        i += 2;
      } else {
        escribirEtiqueta(t);
        nivel += 1;
      }
    } else {
      escribirEtiqueta(t);
    }
  }
  return salida.join('\n');
}

export function formatearCuerpo(texto: string, contentType: string): { texto: string; tipo: 'JSON' | 'XML' | 'TEXTO' } {
  const t = texto.trim();
  if (/json/i.test(contentType) || t.startsWith('{') || t.startsWith('[')) {
    try { return { texto: JSON.stringify(JSON.parse(t), null, 2), tipo: 'JSON' }; } catch { /* no era JSON */ }
  }
  if (/xml|soap|html/i.test(contentType) || t.startsWith('<')) {
    return { texto: formatearXml(t), tipo: 'XML' };
  }
  return { texto, tipo: 'TEXTO' };
}
