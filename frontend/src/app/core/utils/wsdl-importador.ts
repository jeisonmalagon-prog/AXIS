// Genera peticiones SOAP de ejemplo a partir de un WSDL 1.1 (como «New SOAP Project» de SoapUI):
// una petición por operación, con el sobre SOAP y los campos del esquema XSD rellenos con «?».
// Todo se hace en el navegador: solo se lee texto, no se ejecuta nada.

import type { ResultadoImportacion, SolicitudImportada } from './consumo-importadores';

const NS_XSD = 'http://www.w3.org/2001/XMLSchema';
const NS_WSDL = 'http://schemas.xmlsoap.org/wsdl/';
const NS_SOAP11 = 'http://schemas.xmlsoap.org/wsdl/soap/';
const NS_SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const ENV11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const ENV12 = 'http://www.w3.org/2003/05/soap-envelope';
const SANGRIA = '   ';
const MAX_PROFUNDIDAD = 12;

export interface DocumentoXml {
  /** URL de donde salió (vacía si se cargó desde un archivo local). */
  url: string;
  texto: string;
}

interface Contexto {
  elementos: Map<string, Element>;
  tipos: Map<string, Element>;
  grupos: Map<string, Element>;
  mensajes: Map<string, Element>;
  portTypes: Map<string, Element>;
  bindings: Map<string, Element>;
  servicios: Element[];
  avisos: string[];
}

interface QName { ns: string; local: string; }

const clave = (ns: string, local: string): string => `${ns}|${local}`;
const hijos = (el: Element, local: string, ns?: string): Element[] =>
  Array.from(el.children).filter((c) => c.localName === local && (ns === undefined || c.namespaceURI === ns));
const hijo = (el: Element, local: string, ns?: string): Element | null => hijos(el, local, ns)[0] || null;

function resolverQName(el: Element, valor: string): QName {
  const i = valor.indexOf(':');
  const prefijo = i >= 0 ? valor.slice(0, i) : null;
  const local = i >= 0 ? valor.slice(i + 1) : valor;
  return { ns: el.lookupNamespaceURI(prefijo) || '', local };
}

function esquemaDe(el: Element): Element | null {
  let actual: Element | null = el;
  while (actual && !(actual.localName === 'schema' && actual.namespaceURI === NS_XSD)) actual = actual.parentElement;
  return actual;
}

function tnsDe(el: Element): string {
  return esquemaDe(el)?.getAttribute('targetNamespace') || '';
}

function resolverUrl(ubicacion: string, base: string): string | null {
  try {
    return new URL(ubicacion, base || undefined).href.split('#')[0];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------- lectura
function parsear(d: DocumentoXml): Document {
  const doc = new DOMParser().parseFromString(d.texto, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`El XML de ${d.url || 'el WSDL'} está mal formado.`);
  return doc;
}

function reunirEsquema(esquema: Element, urlBase: string, ctx: Contexto, porUrl: Map<string, Document>, visitados: Set<string>): void {
  const tns = esquema.getAttribute('targetNamespace') || '';
  for (const h of Array.from(esquema.children)) {
    const nombre = h.getAttribute('name');
    if (h.namespaceURI === NS_XSD) {
      if (h.localName === 'element' && nombre) ctx.elementos.set(clave(tns, nombre), h);
      else if ((h.localName === 'complexType' || h.localName === 'simpleType') && nombre) ctx.tipos.set(clave(tns, nombre), h);
      else if (h.localName === 'group' && nombre) ctx.grupos.set(clave(tns, nombre), h);
      else if (['import', 'include', 'redefine'].includes(h.localName)) {
        const ubicacion = h.getAttribute('schemaLocation');
        if (ubicacion) seguirImport(ubicacion, urlBase, ctx, porUrl, visitados);
      }
    }
  }
}

function seguirImport(ubicacion: string, urlBase: string, ctx: Contexto, porUrl: Map<string, Document>, visitados: Set<string>): void {
  const url = resolverUrl(ubicacion, urlBase);
  if (!url) {
    ctx.avisos.push(`El WSDL importa «${ubicacion}», que no se puede resolver sin su URL. Usa «Leer WSDL desde la URL» para traer los esquemas.`);
    return;
  }
  if (visitados.has(url)) return;
  visitados.add(url);
  const doc = porUrl.get(url);
  if (!doc) {
    ctx.avisos.push(`No se pudo traer ${ubicacion}: los campos de ese esquema quedarán sin detalle.`);
    return;
  }
  reunirDocumento(doc.documentElement, url, ctx, porUrl, visitados);
}

function reunirDocumento(raiz: Element, url: string, ctx: Contexto, porUrl: Map<string, Document>, visitados: Set<string>): void {
  if (raiz.localName === 'schema' && raiz.namespaceURI === NS_XSD) {
    reunirEsquema(raiz, url, ctx, porUrl, visitados);
    return;
  }
  if (raiz.localName !== 'definitions' || raiz.namespaceURI !== NS_WSDL) return;
  const tns = raiz.getAttribute('targetNamespace') || '';
  for (const h of Array.from(raiz.children)) {
    if (h.namespaceURI === NS_XSD) continue;
    const nombre = h.getAttribute('name') || '';
    if (h.namespaceURI !== NS_WSDL) continue;
    if (h.localName === 'import') {
      const ubicacion = h.getAttribute('location');
      if (ubicacion) seguirImport(ubicacion, url, ctx, porUrl, visitados);
    } else if (h.localName === 'types') {
      for (const e of hijos(h, 'schema', NS_XSD)) reunirEsquema(e, url, ctx, porUrl, visitados);
    } else if (h.localName === 'message') ctx.mensajes.set(clave(tns, nombre), h);
    else if (h.localName === 'portType') ctx.portTypes.set(clave(tns, nombre), h);
    else if (h.localName === 'binding') ctx.bindings.set(clave(tns, nombre), h);
    else if (h.localName === 'service') ctx.servicios.push(h);
  }
}

// ---------------------------------------------------------------------------------- generación del XML de ejemplo
class Generador {
  private prefijos = new Map<string, string>();
  private usados = new Set<string>(['soapenv', 'xsd', 'xml', 'xmlns']);
  private contador = 0;

  constructor(private ctx: Contexto) {}

  get declaraciones(): string {
    return [...this.prefijos.entries()].map(([ns, p]) => ` xmlns:${p}="${ns}"`).join('');
  }

  private prefijo(ns: string, pista: Element): string {
    const existente = this.prefijos.get(ns);
    if (existente) return existente;
    let candidato = pista.lookupPrefix(ns) || '';
    if (!candidato || this.usados.has(candidato) || !/^[A-Za-z_][\w.-]*$/.test(candidato)) {
      do { candidato = `ns${++this.contador}`; } while (this.usados.has(candidato));
    }
    this.usados.add(candidato);
    this.prefijos.set(ns, candidato);
    return candidato;
  }

  /** Elemento global del esquema (como parte de un mensaje document/literal). */
  elementoGlobal(ns: string, local: string, nivel: number): string[] {
    const decl = this.ctx.elementos.get(clave(ns, local));
    if (!decl) {
      const p = ns ? this.prefijoSinPista(ns) : '';
      return [`${SANGRIA.repeat(nivel)}<${p ? p + ':' : ''}${local}>?</${p ? p + ':' : ''}${local}>`, `${SANGRIA.repeat(nivel)}<!--No se encontró la definición de ${local} en el esquema-->`];
    }
    return this.emitirElemento(decl, nivel, true, [], 0);
  }

  /** Prefijo para un espacio de nombres (se declarará en el sobre). */
  prefijoDe(ns: string): string {
    return this.prefijoSinPista(ns);
  }

  private prefijoSinPista(ns: string): string {
    const existente = this.prefijos.get(ns);
    if (existente) return existente;
    let c: string;
    do { c = `ns${++this.contador}`; } while (this.usados.has(c));
    this.usados.add(c);
    this.prefijos.set(ns, c);
    return c;
  }

  /** Elemento con nombre propio (partes rpc o document con type=). */
  elementoPorTipo(nombre: string, nsTipo: QName | null, nivel: number): string[] {
    const sangria = SANGRIA.repeat(nivel);
    if (!nsTipo || nsTipo.ns === NS_XSD) return [`${sangria}<${nombre}>?</${nombre}>`];
    const def = this.ctx.tipos.get(clave(nsTipo.ns, nsTipo.local));
    if (!def) return [`${sangria}<${nombre}>?</${nombre}>`];
    const c = this.contenidoDeDefinicion(def, nivel + 1, [], 1);
    return this.cerrar(nombre, c, nivel);
  }

  private cerrar(tag: string, c: { atributos: string; hijos: string[]; texto: string | null }, nivel: number): string[] {
    const sangria = SANGRIA.repeat(nivel);
    if (c.hijos.length) return [`${sangria}<${tag}${c.atributos}>`, ...c.hijos, `${sangria}</${tag}>`];
    if (c.texto !== null) return [`${sangria}<${tag}${c.atributos}>${c.texto}</${tag}>`];
    return [`${sangria}<${tag}${c.atributos}/>`];
  }

  private emitirElemento(decl: Element, nivel: number, esGlobal: boolean, pila: string[], profundidad: number): string[] {
    const sangria = SANGRIA.repeat(nivel);
    if (profundidad > MAX_PROFUNDIDAD) return [`${sangria}<!--Se omite el resto (demasiado anidado)-->`];
    let d = decl;
    let global = esGlobal;
    const ref = decl.getAttribute('ref');
    if (ref) {
      const q = resolverQName(decl, ref);
      const g = this.ctx.elementos.get(clave(q.ns, q.local));
      if (!g) return [`${sangria}<!--No se encontró el elemento ${ref}-->`];
      d = g;
      global = true;
    }
    const nombre = d.getAttribute('name') || 'elemento';
    const esquema = esquemaDe(d);
    const calificado = global || (d.getAttribute('form') || esquema?.getAttribute('elementFormDefault') || 'unqualified') === 'qualified';
    const ns = calificado ? tnsDe(d) : '';
    const tag = ns ? `${this.prefijo(ns, d)}:${nombre}` : nombre;

    const lineas: string[] = [];
    const min = decl.getAttribute('minOccurs');
    const max = decl.getAttribute('maxOccurs');
    const repetido = max === 'unbounded' || (max !== null && Number(max) > 1);
    if (repetido) lineas.push(`${sangria}<!--${min === '0' ? 'Zero or more repetitions:' : '1 or more repetitions:'}-->`);
    else if (min === '0') lineas.push(`${sangria}<!--Optional:-->`);

    const tipoAttr = d.getAttribute('type');
    let c: { atributos: string; hijos: string[]; texto: string | null };
    if (tipoAttr) {
      const q = resolverQName(d, tipoAttr);
      const def = q.ns === NS_XSD ? null : this.ctx.tipos.get(clave(q.ns, q.local));
      c = def ? this.contenidoDeDefinicion(def, nivel + 1, pila, profundidad + 1) : { atributos: '', hijos: [], texto: '?' };
    } else {
      const inline = hijo(d, 'complexType', NS_XSD) || hijo(d, 'simpleType', NS_XSD);
      c = inline ? this.contenidoDeDefinicion(inline, nivel + 1, pila, profundidad + 1) : { atributos: '', hijos: [], texto: '?' };
    }
    // Los identificadores únicos de petición (RqUID…) se generan solos al enviar.
    if (c.texto === '?' && /^(rquid|uuid|msguid|requestuid)$/i.test(nombre)) c = { ...c, texto: '{{$guid}}' };
    return [...lineas, ...this.cerrar(tag, c, nivel)];
  }

  private contenidoDeDefinicion(def: Element, nivel: number, pila: string[], profundidad: number): { atributos: string; hijos: string[]; texto: string | null } {
    const vacio = { atributos: '', hijos: [] as string[], texto: null as string | null };
    const nombre = def.getAttribute('name');
    const id = nombre ? clave(tnsDe(def), nombre) : '';
    if (id && pila.includes(id)) return { ...vacio, hijos: [`${SANGRIA.repeat(nivel)}<!--Estructura recursiva: ${nombre}-->`] };
    const nuevaPila = id ? [...pila, id] : pila;

    if (def.localName === 'simpleType') {
      const enumeracion = Array.from(def.getElementsByTagNameNS(NS_XSD, 'enumeration')).map((e) => e.getAttribute('value') || '');
      return { ...vacio, texto: enumeracion.length ? enumeracion[0] : '?' };
    }

    // complexType
    let atributos = '';
    const lista: string[] = [];
    const agregarAtributos = (padre: Element): void => {
      for (const a of hijos(padre, 'attribute', NS_XSD)) {
        if (a.getAttribute('use') === 'required' && a.getAttribute('name')) atributos += ` ${a.getAttribute('name')}="${a.getAttribute('fixed') || a.getAttribute('default') || '?'}"`;
      }
    };
    const procesar = (padre: Element, n: number): string[] => {
      const salida: string[] = [];
      for (const p of Array.from(padre.children)) {
        if (p.namespaceURI !== NS_XSD) continue;
        if (p.localName === 'element') salida.push(...this.emitirElemento(p, n, false, nuevaPila, profundidad + 1));
        else if (p.localName === 'sequence' || p.localName === 'all') salida.push(...procesar(p, n));
        else if (p.localName === 'choice') {
          const opciones = Array.from(p.children).filter((x) => x.namespaceURI === NS_XSD && ['element', 'sequence', 'group'].includes(x.localName));
          if (opciones.length) {
            const nombres = opciones.map((o) => o.getAttribute('name') || o.getAttribute('ref') || o.localName).join(' | ');
            if (opciones.length > 1) salida.push(`${SANGRIA.repeat(n)}<!--Elige una opción: ${nombres} (se muestra la primera)-->`);
            const primera = opciones[0];
            if (primera.localName === 'element') salida.push(...this.emitirElemento(primera, n, false, nuevaPila, profundidad + 1));
            else salida.push(...procesar(primera, n));
          }
        } else if (p.localName === 'group') {
          const ref = p.getAttribute('ref');
          const g = ref ? this.ctx.grupos.get(clave(resolverQName(p, ref).ns, resolverQName(p, ref).local)) : p;
          if (g) salida.push(...procesar(g, n));
        } else if (p.localName === 'any') salida.push(`${SANGRIA.repeat(n)}<!--Cualquier elemento (xsd:any)-->`);
      }
      return salida;
    };

    const simple = hijo(def, 'simpleContent', NS_XSD);
    const complejo = hijo(def, 'complexContent', NS_XSD);
    if (simple) {
      const ext = hijo(simple, 'extension', NS_XSD) || hijo(simple, 'restriction', NS_XSD);
      if (ext) agregarAtributos(ext);
      return { atributos, hijos: [], texto: '?' };
    }
    if (complejo) {
      const ext = hijo(complejo, 'extension', NS_XSD);
      const restr = hijo(complejo, 'restriction', NS_XSD);
      if (ext) {
        const base = ext.getAttribute('base');
        if (base) {
          const q = resolverQName(ext, base);
          const defBase = q.ns === NS_XSD ? null : this.ctx.tipos.get(clave(q.ns, q.local));
          if (defBase && defBase.localName === 'complexType') {
            const cb = this.contenidoDeDefinicion(defBase, nivel, nuevaPila, profundidad + 1);
            atributos += cb.atributos;
            lista.push(...cb.hijos);
          }
        }
        lista.push(...procesar(ext, nivel));
        agregarAtributos(ext);
      } else if (restr) {
        lista.push(...procesar(restr, nivel));
        agregarAtributos(restr);
      }
      return { atributos, hijos: lista, texto: null };
    }
    lista.push(...procesar(def, nivel));
    agregarAtributos(def);
    return { atributos, hijos: lista, texto: null };
  }
}

// ---------------------------------------------------------------------------------- operaciones
function construirSobre(v12: boolean, g: Generador, cuerpo: string[]): string {
  const env = v12 ? ENV12 : ENV11;
  return [
    `<soapenv:Envelope xmlns:soapenv="${env}"${g.declaraciones}>`,
    `${SANGRIA}<soapenv:Header/>`,
    `${SANGRIA}<soapenv:Body>`,
    ...cuerpo,
    `${SANGRIA}</soapenv:Body>`,
    '</soapenv:Envelope>',
  ].join('\n');
}

export function importarWsdl(documentos: DocumentoXml[]): ResultadoImportacion {
  if (!documentos.length) throw new Error('No hay ningún documento WSDL para leer.');
  const porUrl = new Map<string, Document>();
  const docs = documentos.map((d) => ({ d, doc: parsear(d) }));
  for (const { d, doc } of docs) if (d.url) porUrl.set(d.url.split('#')[0], doc);

  const raiz = docs[0].doc.documentElement;
  if (raiz.localName === 'description') throw new Error('Es un WSDL 2.0, que no se puede leer aquí. Descárgalo e impórtalo en SoapUI.');
  if (raiz.localName !== 'definitions' || raiz.namespaceURI !== NS_WSDL) throw new Error('El documento no es un WSDL 1.1.');

  const ctx: Contexto = {
    elementos: new Map(), tipos: new Map(), grupos: new Map(), mensajes: new Map(),
    portTypes: new Map(), bindings: new Map(), servicios: [], avisos: [],
  };
  const visitados = new Set<string>();
  const urlRaiz = documentos[0].url.split('#')[0];
  if (urlRaiz) visitados.add(urlRaiz);
  reunirDocumento(raiz, urlRaiz, ctx, porUrl, visitados);
  // Documentos sueltos (sin import que los referencie) también aportan sus definiciones.
  for (const { d, doc } of docs.slice(1)) {
    const u = d.url.split('#')[0];
    if (!visitados.has(u)) { visitados.add(u); reunirDocumento(doc.documentElement, u, ctx, porUrl, visitados); }
  }

  // Dirección (soap:address) por binding.
  const direcciones = new Map<string, { url: string; servicio: string }>();
  for (const s of ctx.servicios) {
    for (const puerto of hijos(s, 'port', NS_WSDL)) {
      const enlace = puerto.getAttribute('binding');
      if (!enlace) continue;
      const q = resolverQName(puerto, enlace);
      const dir = Array.from(puerto.children).find((x) => x.localName === 'address' && (x.namespaceURI === NS_SOAP11 || x.namespaceURI === NS_SOAP12));
      const k = clave(q.ns, q.local);
      if (dir && !direcciones.has(k)) direcciones.set(k, { url: dir.getAttribute('location') || '', servicio: s.getAttribute('name') || '' });
    }
  }

  const solicitudes: SolicitudImportada[] = [];
  const avisos = [...new Set(ctx.avisos)];

  for (const [k, enlace] of ctx.bindings) {
    const soapBinding = Array.from(enlace.children).find((x) => x.localName === 'binding' && (x.namespaceURI === NS_SOAP11 || x.namespaceURI === NS_SOAP12));
    if (!soapBinding) continue; // binding HTTP u otro: no es SOAP
    const v12 = soapBinding.namespaceURI === NS_SOAP12;
    const estiloBinding = soapBinding.getAttribute('style') || 'document';
    const tipoPuerto = enlace.getAttribute('type');
    if (!tipoPuerto) continue;
    const qp = resolverQName(enlace, tipoPuerto);
    const portType = ctx.portTypes.get(clave(qp.ns, qp.local));
    if (!portType) { avisos.push(`El binding ${enlace.getAttribute('name')} apunta a un portType que no está en el WSDL.`); continue; }
    const direccion = direcciones.get(k);
    const nombreBinding = enlace.getAttribute('name') || 'Binding';
    const tnsWsdl = enlace.ownerDocument.documentElement.getAttribute('targetNamespace') || '';

    for (const op of hijos(enlace, 'operation', NS_WSDL)) {
      const nombreOp = op.getAttribute('name') || 'operación';
      const opSoap = Array.from(op.children).find((x) => x.localName === 'operation' && (x.namespaceURI === NS_SOAP11 || x.namespaceURI === NS_SOAP12));
      const accion = opSoap?.getAttribute('soapAction') || '';
      const estilo = opSoap?.getAttribute('style') || estiloBinding;
      const opPuerto = hijos(portType, 'operation', NS_WSDL).find((x) => x.getAttribute('name') === nombreOp);
      const entrada = opPuerto && hijo(opPuerto, 'input', NS_WSDL);
      const refMensaje = entrada?.getAttribute('message');
      if (!opPuerto || !entrada || !refMensaje) continue; // operación sin entrada (solo respuesta): no hay qué enviar
      const qm = resolverQName(entrada, refMensaje);
      const mensaje = ctx.mensajes.get(clave(qm.ns, qm.local));
      if (!mensaje) { avisos.push(`La operación ${nombreOp} usa un mensaje que no está en el WSDL.`); continue; }

      const g = new Generador(ctx);
      const cuerpo: string[] = [];
      const partes = hijos(mensaje, 'part', NS_WSDL);
      const bodyEl = hijo(op, 'input', NS_WSDL) && Array.from(hijo(op, 'input', NS_WSDL)!.children).find((x) => x.localName === 'body');
      const nsRpc = bodyEl?.getAttribute('namespace') || tnsWsdl;
      const partesCuerpo = (() => {
        const filtro = bodyEl?.getAttribute('parts');
        return filtro ? partes.filter((p) => filtro.split(/\s+/).includes(p.getAttribute('name') || '')) : partes;
      })();

      if (estilo === 'rpc') {
        const hijosRpc: string[] = [];
        for (const p of partesCuerpo) {
          const nombreP = p.getAttribute('name') || 'parte';
          if (p.getAttribute('element')) {
            const q = resolverQName(p, p.getAttribute('element')!);
            hijosRpc.push(...g.elementoGlobal(q.ns, q.local, 3));
          } else {
            const t = p.getAttribute('type');
            hijosRpc.push(...g.elementoPorTipo(nombreP, t ? resolverQName(p, t) : null, 3));
          }
        }
        const pref = nsRpc ? `${g.prefijoDe(nsRpc)}:` : '';
        cuerpo.push(`${SANGRIA.repeat(2)}<${pref}${nombreOp}>`, ...hijosRpc, `${SANGRIA.repeat(2)}</${pref}${nombreOp}>`);
      } else {
        for (const p of partesCuerpo) {
          if (p.getAttribute('element')) {
            const q = resolverQName(p, p.getAttribute('element')!);
            cuerpo.push(...g.elementoGlobal(q.ns, q.local, 2));
          } else {
            const t = p.getAttribute('type');
            cuerpo.push(...g.elementoPorTipo(p.getAttribute('name') || 'parte', t ? resolverQName(p, t) : null, 2));
          }
        }
      }

      const cabeceras = v12
        ? [{ nombre: 'Content-Type', valor: `application/soap+xml;charset=UTF-8${accion ? `;action="${accion}"` : ''}`, activo: true }]
        : [{ nombre: 'Content-Type', valor: 'text/xml;charset=UTF-8', activo: true }, { nombre: 'SOAPAction', valor: `"${accion}"`, activo: true }];

      solicitudes.push({
        nombre: nombreOp,
        grupo: `${nombreBinding}${v12 ? ' (SOAP 1.2)' : ''}`,
        metodo: 'POST',
        url: direccion?.url || '',
        cabeceras,
        cuerpo: construirSobre(v12, g, cuerpo),
        auth: { tipo: 'ninguna' },
        urlDelWsdl: true,
      });
    }
  }

  if (!solicitudes.length) avisos.push('No se encontraron operaciones SOAP con mensaje de entrada en el WSDL.');
  return { origen: 'WSDL', solicitudes, variables: [], avisos };
}
