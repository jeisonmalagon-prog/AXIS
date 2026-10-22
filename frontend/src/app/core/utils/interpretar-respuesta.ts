// Traduce la respuesta de un servicio (XML/SOAP o JSON) a un resumen que entienda alguien no técnico:
// un veredicto (¿salió bien?), los datos con nombres en español y las listas como tablas.
// Todo ocurre en el navegador; no se envía nada a ningún lado.

export type NivelEstado = 'ok' | 'aviso' | 'error' | 'info';

export interface EstadoLegible {
  nivel: NivelEstado;
  titulo: string;
  detalle: string;
  /** Código de resultado que informa el propio servicio (si lo trae). */
  codigo: string;
}

export interface CampoLegible { etiqueta: string; valor: string; original: string; tecnico: boolean }
export interface TablaLegible {
  titulo: string;
  original: string;
  columnas: { etiqueta: string; original: string; tecnica: boolean }[];
  filas: string[][];
  total: number;
}
export interface SeccionLegible { titulo: string; original: string; campos: CampoLegible[]; tablas: TablaLegible[]; secciones: SeccionLegible[] }

export interface Interpretacion {
  formato: 'XML' | 'JSON' | 'TEXTO';
  estado: EstadoLegible;
  raiz: SeccionLegible | null;
  /** Nombre técnico del bloque principal (para quien quiera ubicarlo en el cuerpo). */
  origenRaiz: string;
  /** Resumen en una frase de lo recibido ("2 listas, 14 datos…"). */
  contenido: string;
  hayTecnicos: boolean;
  /** Aviso si no se pudo leer del todo (respuesta cortada, formato raro…). */
  nota: string;
}

export interface RespuestaParaInterpretar {
  estado?: number;
  estadoTexto?: string;
  cuerpo?: string;
  truncado?: boolean;
  headers?: { nombre: string; valor: string }[];
}

// ------------------------------------------------------------------------------------------------
// Nombres legibles
// ------------------------------------------------------------------------------------------------
const NOMBRES: Record<string, string> = {
  acct: 'Cuenta', acctid: 'Número de cuenta', accttype: 'Tipo de cuenta', acctsumm: 'Cuentas', acctinfo: 'Información de la cuenta',
  acctlist: 'Lista de cuentas', acctstatus: 'Estado de la cuenta', acctbal: 'Saldos de la cuenta', depacctid: 'Cuenta de depósito',
  custid: 'Cliente', custpermid: 'Código permanente del cliente', custinfo: 'Información del cliente', custname: 'Nombre del cliente',
  rquid: 'Identificador de la solicitud', rsuid: 'Identificador de la respuesta', status: 'Estado', statuscode: 'Código de resultado',
  statusdesc: 'Descripción del resultado', serverstatuscode: 'Código del servidor', severity: 'Severidad',
  identtype: 'Tipo de documento', identnum: 'Número de documento', identnumber: 'Número de documento', ident: 'Documento',
  curamt: 'Monto', amt: 'Monto', curcode: 'Moneda', curr: 'Moneda', currency: 'Moneda', bal: 'Saldo', baltype: 'Tipo de saldo', availbal: 'Saldo disponible',
  curbal: 'Saldo actual', ledgerbal: 'Saldo contable', desc: 'Descripción', name: 'Nombre', fullname: 'Nombre completo', firstname: 'Nombres',
  lastname: 'Apellidos', email: 'Correo electrónico', phone: 'Teléfono', phonenum: 'Teléfono', address: 'Dirección', city: 'Ciudad',
  opendt: 'Fecha de apertura', closedt: 'Fecha de cierre', dt: 'Fecha', date: 'Fecha', trndt: 'Fecha de la transacción', effdt: 'Fecha efectiva',
  productid: 'Producto', branchid: 'Oficina', branchname: 'Nombre de la oficina', bankid: 'Banco', trnamt: 'Monto de la transacción',
  trntype: 'Tipo de transacción', trnid: 'Número de transacción', msg: 'Mensaje', message: 'Mensaje', error: 'Error', errors: 'Errores',
  faultcode: 'Código del error', faultstring: 'Mensaje del error', detail: 'Detalle', codigo: 'Código', mensaje: 'Mensaje',
  id: 'Identificador', uuid: 'Identificador único', data: 'Datos', result: 'Resultado', results: 'Resultados', items: 'Elementos',
  total: 'Total', count: 'Cantidad', page: 'Página', pagesize: 'Tamaño de página', timestamp: 'Fecha y hora', createdat: 'Fecha de creación',
  updatedat: 'Fecha de actualización', state: 'Estado', type: 'Tipo', value: 'Valor', description: 'Descripción',
};
const CABEZA: Record<string, string> = {
  type: 'Tipo', id: 'Identificador', num: 'Número', number: 'Número', desc: 'Descripción', description: 'Descripción', date: 'Fecha', dt: 'Fecha',
  code: 'Código', amt: 'Monto', amount: 'Monto', status: 'Estado', name: 'Nombre', bal: 'Saldo', balance: 'Saldo', rate: 'Tasa', count: 'Cantidad',
  total: 'Total', list: 'Lista', info: 'Información', value: 'Valor', msg: 'Mensaje', message: 'Mensaje', ind: 'Indicador', flag: 'Indicador',
  time: 'Hora', summ: 'Resumen', summary: 'Resumen',
};
const MODIFICADOR: Record<string, string> = {
  acct: 'cuenta', account: 'cuenta', cust: 'cliente', customer: 'cliente', client: 'cliente', open: 'apertura', close: 'cierre', prod: 'producto',
  product: 'producto', branch: 'oficina', ident: 'documento', start: 'inicio', end: 'fin', min: 'mínimo', max: 'máximo', avail: 'disponible',
  available: 'disponible', card: 'tarjeta', loan: 'crédito', org: 'organización', user: 'usuario', bank: 'banco', trn: 'transacción',
  trx: 'transacción', tran: 'transacción', src: 'origen', dest: 'destino', pay: 'pago', payment: 'pago', due: 'vencimiento', int: 'interés',
  interest: 'interés', fee: 'comisión', tax: 'impuesto', ref: 'referencia', seq: 'secuencia', eff: 'vigencia', exp: 'vencimiento',
};

/** Campos en español escritos sin tilde (numero, codigo…): se muestran bien escritos. */
const ACENTOS: Record<string, string> = {
  numero: 'número', codigo: 'código', descripcion: 'descripción', telefono: 'teléfono', direccion: 'dirección', identificacion: 'identificación',
  correlacion: 'correlación', transaccion: 'transacción', informacion: 'información', ultimo: 'último', cedula: 'cédula', pais: 'país',
  razon: 'razón', dia: 'día', dias: 'días', tasa: 'tasa', vigencia: 'vigencia', ubicacion: 'ubicación', observacion: 'observación',
  operacion: 'operación', cotizacion: 'cotización', comision: 'comisión', interes: 'interés', credito: 'crédito', debito: 'débito',
  oficina: 'oficina', ciudad: 'ciudad', pagina: 'página', periodo: 'período', categoria: 'categoría', gestion: 'gestión', solicitud: 'solicitud',
};

function palabras(nombre: string): string[] {
  return nombre
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const mayuscula = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "AcctType" → "Tipo de cuenta"; "NombreServicio" → "Nombre servicio"; lo desconocido se deja legible, sin inventar. */
export function etiquetaLegible(nombre: string): string {
  const limpio = nombre.includes(':') ? nombre.slice(nombre.lastIndexOf(':') + 1) : nombre;
  const clave = limpio.toLowerCase().replace(/[_\-.\s]/g, '');
  if (NOMBRES[clave]) return NOMBRES[clave];
  const ps = palabras(limpio);
  if (!ps.length) return limpio;
  const bajas = ps.map((p) => p.toLowerCase());
  const cabeza = CABEZA[bajas[bajas.length - 1]];
  if (cabeza && bajas.length === 2 && MODIFICADOR[bajas[0]]) return `${cabeza} de ${MODIFICADOR[bajas[0]]}`;
  if (cabeza && bajas.length === 1) return cabeza;
  if (bajas.length === 1 && MODIFICADOR[bajas[0]]) return mayuscula(MODIFICADOR[bajas[0]]);
  return mayuscula(ps.map((p, i) => {
    const sigla = /^[A-Z0-9]{2,}$/.test(p);
    const w = sigla ? p : (i === 0 ? p : p.toLowerCase());
    return ACENTOS[w.toLowerCase()] ? (i === 0 ? mayuscula(ACENTOS[w.toLowerCase()]) : ACENTOS[w.toLowerCase()]) : w;
  }).join(' '));
}

// ------------------------------------------------------------------------------------------------
// Valores
// ------------------------------------------------------------------------------------------------
const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const RE_MONTO = /(amt|amount|bal|balance|monto|saldo|valor|importe|total|cupo|limite|límite|capital)/i;
const SEVERIDAD: Record<string, string> = { info: 'Información', information: 'Información', warn: 'Advertencia', warning: 'Advertencia', error: 'Error', fatal: 'Error grave' };

function formatearValor(nombre: string, valor: string): string {
  const v = valor.trim();
  if (!v) return '—';
  const f = v.match(RE_FECHA);
  if (f) return f[4] ? `${f[3]}/${f[2]}/${f[1]} ${f[4]}:${f[5]}${f[6] ? ':' + f[6] : ''}` : `${f[3]}/${f[2]}/${f[1]}`;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true' ? 'Sí' : 'No';
  if (RE_MONTO.test(nombre) && /^-?\d+(\.\d+)?$/.test(v) && v.replace('-', '').split('.')[0].length <= 15) {
    return Number(v).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  if (/severity|severidad/i.test(nombre) && SEVERIDAD[v.toLowerCase()]) return SEVERIDAD[v.toLowerCase()];
  return v;
}

const TECNICOS = new Set(['rquid', 'rsuid', 'serverstatuscode', 'clientdt', 'uuid', 'guid', 'correlationid', 'trackingid', 'requestid', 'traceid', 'spanid', 'messageid', 'xmlns']);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function esTecnico(nombre: string, valor: string): boolean {
  const limpio = (nombre.includes(':') ? nombre.slice(nombre.lastIndexOf(':') + 1) : nombre).toLowerCase().replace(/[_\-.]/g, '');
  return TECNICOS.has(limpio) || limpio.endsWith('uid') || RE_UUID.test(valor.trim());
}

// ------------------------------------------------------------------------------------------------
// Árbol genérico (XML y JSON se llevan a la misma forma)
// ------------------------------------------------------------------------------------------------
interface Nodo { nombre: string; texto: string; attrs: { nombre: string; valor: string }[]; hijos: Nodo[] }

const local = (n: string): string => (n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n);

function desdeXml(el: Element): Nodo {
  const hijos: Nodo[] = [];
  let texto = '';
  el.childNodes.forEach((c) => {
    if (c.nodeType === 1) hijos.push(desdeXml(c as Element));
    else if (c.nodeType === 3 || c.nodeType === 4) texto += c.nodeValue || '';
  });
  const attrs: { nombre: string; valor: string }[] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.name === 'xmlns' || a.name.startsWith('xmlns:') || a.name.startsWith('xsi:')) continue;
    attrs.push({ nombre: local(a.name), valor: a.value });
  }
  return { nombre: local(el.nodeName), texto: hijos.length ? '' : texto.trim(), attrs, hijos };
}

function desdeJson(valor: unknown, nombre: string, prof = 0): Nodo {
  if (valor === null || valor === undefined) return { nombre, texto: '', attrs: [], hijos: [] };
  if (Array.isArray(valor)) {
    // Una lista dentro de otro nodo se expresa repitiendo el nombre; la raíz usa «Elemento».
    return { nombre, texto: '', attrs: [], hijos: prof > 40 ? [] : valor.map((v) => desdeJson(v, nombre === '' ? 'Elemento' : nombre, prof + 1)) };
  }
  if (typeof valor === 'object') {
    const hijos: Nodo[] = [];
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach((x) => hijos.push(desdeJson(x, k, prof + 1)));
      else hijos.push(desdeJson(v, k, prof + 1));
    }
    return { nombre, texto: '', attrs: [], hijos: prof > 40 ? [] : hijos };
  }
  return { nombre, texto: String(valor), attrs: [], hijos: [] };
}

function hoja(n: Nodo): boolean { return n.hijos.length === 0; }

// ------------------------------------------------------------------------------------------------
// Estado (¿salió bien?)
// ------------------------------------------------------------------------------------------------
const CLAVES_CODIGO = ['statuscode', 'codigorespuesta', 'codigo', 'code', 'errorcode', 'returncode', 'resultcode', 'responsecode', 'faultcode'];
const CLAVES_MENSAJE = ['statusdesc', 'faultstring', 'mensaje', 'message', 'msg', 'errormessage', 'descripcion', 'description', 'error', 'detail', 'reason'];
const CLAVES_SEVERIDAD = ['severity', 'severidad'];
const EXITO = /^(0+|ok|success|exito|éxito|exitoso|true|200)$/i;

function hojasPorNombre(n: Nodo, mapa: Map<string, string>): void {
  if (hoja(n)) {
    const k = n.nombre.toLowerCase();
    if (n.texto && !mapa.has(k)) mapa.set(k, n.texto);
  }
  n.hijos.forEach((h) => hojasPorNombre(h, mapa));
}

function buscarBloqueEstado(n: Nodo): Nodo | null {
  if (n.nombre.toLowerCase() === 'status' && n.hijos.some((h) => CLAVES_CODIGO.includes(h.nombre.toLowerCase()))) return n;
  for (const h of n.hijos) {
    const r = buscarBloqueEstado(h);
    if (r) return r;
  }
  return null;
}

export function explicarHttp(estado: number): { titulo: string; detalle: string } {
  if (estado >= 200 && estado < 300) return { titulo: 'El servicio respondió correctamente', detalle: '' };
  const m: Record<number, [string, string]> = {
    400: ['El servicio no entendió la petición', 'Los datos enviados no son válidos o falta algún dato obligatorio.'],
    401: ['No se pudo identificar quién consulta', 'El servicio exige credenciales o un token válido y no los recibió o están vencidos.'],
    403: ['No tienes permiso en este servicio', 'El servicio reconoció la petición pero no autoriza esta consulta.'],
    404: ['No se encontró lo que se pidió', 'La dirección del servicio o el dato consultado no existe.'],
    405: ['Método no permitido', 'El servicio no acepta esta forma de consulta (GET, POST…).'],
    408: ['El servicio tardó demasiado', 'Se agotó el tiempo de espera antes de recibir respuesta.'],
    409: ['Conflicto con el estado actual', 'La operación choca con datos que ya existen o con otra operación en curso.'],
    415: ['Formato no aceptado', 'El servicio no acepta el tipo de contenido que se envió.'],
    422: ['Los datos no pasaron las validaciones', 'El servicio entendió la petición pero algún dato no es válido.'],
    429: ['Demasiadas consultas seguidas', 'El servicio pidió esperar un momento antes de volver a intentar.'],
    500: ['El servicio tuvo un error interno', 'El problema está del lado del servicio, no en tu computador. Suele deberse a datos que no esperaba o a una falla propia.'],
    502: ['Falla entre servidores', 'Un servidor intermedio no obtuvo respuesta del servicio de destino.'],
    503: ['El servicio no está disponible', 'Está caído, en mantenimiento o sobrecargado. Intenta más tarde.'],
    504: ['El servicio tardó demasiado en responder', 'Un servidor intermedio se cansó de esperar la respuesta.'],
  };
  if (m[estado]) return { titulo: m[estado][0], detalle: m[estado][1] };
  if (estado >= 500) return { titulo: 'El servicio tuvo un error', detalle: 'El problema está del lado del servicio.' };
  if (estado >= 400) return { titulo: 'La petición fue rechazada', detalle: 'Revisa los datos enviados y los permisos.' };
  if (estado >= 300) return { titulo: 'El servicio redirigió la consulta', detalle: 'La dirección cambió de lugar.' };
  return { titulo: `El servicio respondió con el código ${estado}`, detalle: '' };
}

function evaluarEstado(r: RespuestaParaInterpretar, carga: Nodo | null, actual: Nodo | null, hayFault: boolean): EstadoLegible {
  const http = r.estado;
  const bloque = actual ? buscarBloqueEstado(actual) : null;
  // Con bloque «Status» se lee de ahí; si no, solo de los datos del primer nivel (un «code» enterrado en la lista no es el resultado).
  const fuente = new Map<string, string>();
  if (bloque) hojasPorNombre(bloque, fuente);
  else [carga, actual].forEach((n) => n && n.hijos.filter(hoja).forEach((h) => { if (h.texto && !fuente.has(h.nombre.toLowerCase())) fuente.set(h.nombre.toLowerCase(), h.texto); }));
  const primero = (claves: string[]): string => claves.map((k) => fuente.get(k)).find((v) => !!v) || '';
  const codigo = primero(CLAVES_CODIGO);
  const mensaje = primero(CLAVES_MENSAJE);
  const severidad = primero(CLAVES_SEVERIDAD).toLowerCase();

  if (hayFault) {
    return { nivel: 'error', titulo: 'El servicio respondió con un error', detalle: (mensaje ? mensaje + ' — ' : '') + 'Es un error devuelto por el propio servicio (SOAP Fault).', codigo };
  }
  if (http !== undefined && http >= 400) {
    const e = explicarHttp(http);
    return { nivel: 'error', titulo: e.titulo, detalle: [mensaje, e.detalle].filter(Boolean).join(' — '), codigo };
  }
  if (!codigo && !bloque && fuente.has('error') && !hayFault) {
    return { nivel: 'error', titulo: 'El servicio respondió con un error', detalle: fuente.get('error') || '', codigo };
  }
  if (codigo) {
    if (EXITO.test(codigo.trim()) && !/error|fatal/.test(severidad)) {
      return { nivel: 'ok', titulo: 'La operación fue exitosa', detalle: mensaje || 'El servicio confirma que todo salió bien.', codigo };
    }
    const grave = /error|fatal|critical/.test(severidad);
    return {
      nivel: grave ? 'error' : 'aviso',
      titulo: grave ? 'El servicio respondió, pero no pudo completar la operación' : 'El servicio respondió con una observación',
      detalle: mensaje || `Devolvió el código ${codigo}.`,
      codigo,
    };
  }
  if (http !== undefined && http >= 300) {
    const e = explicarHttp(http);
    return { nivel: 'info', titulo: e.titulo, detalle: e.detalle, codigo };
  }
  if (http !== undefined && http >= 200) {
    return { nivel: 'ok', titulo: 'El servicio respondió correctamente', detalle: 'La respuesta no trae un código de resultado propio: revisa los datos que devolvió.', codigo };
  }
  return { nivel: 'info', titulo: 'Respuesta recibida', detalle: '', codigo };
}

// ------------------------------------------------------------------------------------------------
// Secciones y tablas
// ------------------------------------------------------------------------------------------------
const MAX_COLUMNAS = 14;
const MAX_FILAS = 300;
const MAX_PROFUNDIDAD = 8;

/** Datos "planos" de un elemento repetido: ruta → valor. null si contiene listas anidadas (no cabe en una fila). */
function aplanar(n: Nodo, prefijo: string[], prof: number, salida: { ruta: string[]; valor: string }[]): boolean {
  n.attrs.forEach((a) => salida.push({ ruta: [...prefijo, a.nombre], valor: a.valor }));
  if (hoja(n)) {
    if (prefijo.length) salida.push({ ruta: prefijo, valor: n.texto });
    return true;
  }
  if (prof >= 3) return false;
  const cuenta = new Map<string, number>();
  n.hijos.forEach((h) => cuenta.set(h.nombre, (cuenta.get(h.nombre) || 0) + 1));
  for (const h of n.hijos) {
    if ((cuenta.get(h.nombre) || 0) > 1 && !hoja(h)) return false;
    if (!aplanar(h, [...prefijo, h.nombre], prof + 1, salida)) return false;
  }
  return true;
}

function construirTabla(grupo: Nodo[], omitir: Set<Nodo>): TablaLegible | null {
  const filasPlanas: { ruta: string[]; valor: string }[][] = [];
  for (const item of grupo) {
    const celdas: { ruta: string[]; valor: string }[] = [];
    if (!aplanar(item, [], 0, celdas)) return null;
    filasPlanas.push(celdas.filter((c) => c.ruta.length));
  }
  const claves: string[] = [];
  const rutas = new Map<string, string[]>();
  filasPlanas.forEach((f) => f.forEach((c) => {
    const k = c.ruta.join('\u0001');
    if (!rutas.has(k)) { rutas.set(k, c.ruta); claves.push(k); }
  }));
  if (!claves.length || claves.length > MAX_COLUMNAS) return null;
  // Etiqueta corta; si dos columnas se llamarían igual, se usa la ruta completa.
  const cortas = claves.map((k) => {
    const ruta = rutas.get(k)!;
    const ultimo = ruta[ruta.length - 1];
    const padre = ruta.length > 1 ? ruta[ruta.length - 2] : '';
    // «Status › StatusDesc» se entiende mejor como «Estado» que como «Descripción del resultado».
    if (padre && ultimo.toLowerCase().startsWith(padre.toLowerCase()) && /^(desc|description|name|nombre|id|code)$/i.test(ultimo.slice(padre.length))) return etiquetaLegible(padre);
    return etiquetaLegible(ultimo);
  });
  const columnas = claves.map((k, i) => {
    const ruta = rutas.get(k)!;
    const repetida = cortas.filter((c) => c === cortas[i]).length > 1;
    const etiqueta = repetida ? ruta.map(etiquetaLegible).join(' · ') : cortas[i];
    return { etiqueta, original: ruta.join(' › '), tecnica: esTecnico(ruta[ruta.length - 1], '') };
  });
  const filas = filasPlanas.slice(0, MAX_FILAS).map((f) => {
    const porClave = new Map<string, string>();
    f.forEach((c) => porClave.set(c.ruta.join('\u0001'), c.valor));
    return claves.map((k, i) => formatearValor(columnas[i].original, porClave.get(k) ?? ''));
  });
  void omitir;
  return { titulo: etiquetaLegible(grupo[0].nombre), original: grupo[0].nombre, columnas, filas, total: grupo.length };
}

function construirSeccion(n: Nodo, omitir: Set<Nodo>, prof: number): SeccionLegible {
  const sec: SeccionLegible = { titulo: etiquetaLegible(n.nombre), original: n.nombre, campos: [], tablas: [], secciones: [] };
  n.attrs.forEach((a) => sec.campos.push({ etiqueta: etiquetaLegible(a.nombre), valor: formatearValor(a.nombre, a.valor), original: a.nombre, tecnico: esTecnico(a.nombre, a.valor) }));

  const visibles = n.hijos.filter((h) => !omitir.has(h));
  const grupos = new Map<string, Nodo[]>();
  visibles.forEach((h) => grupos.set(h.nombre, [...(grupos.get(h.nombre) || []), h]));
  const hechos = new Set<string>();
  for (const h of visibles) {
    if (hechos.has(h.nombre)) continue;
    hechos.add(h.nombre);
    const g = grupos.get(h.nombre)!;
    if (hoja(h)) {
      const valores = g.map((x) => formatearValor(x.nombre, x.texto));
      sec.campos.push({ etiqueta: etiquetaLegible(h.nombre), valor: valores.join(', '), original: h.nombre, tecnico: esTecnico(h.nombre, g[0].texto) });
      g[0].attrs.forEach((a) => sec.campos.push({ etiqueta: `${etiquetaLegible(h.nombre)} · ${etiquetaLegible(a.nombre)}`, valor: formatearValor(a.nombre, a.valor), original: `${h.nombre}@${a.nombre}`, tecnico: false }));
      continue;
    }
    if (prof >= MAX_PROFUNDIDAD) continue;
    if (g.length > 1) {
      const tabla = construirTabla(g, omitir);
      if (tabla) { sec.tablas.push(tabla); continue; }
      g.forEach((x, i) => {
        const s = construirSeccion(x, omitir, prof + 1);
        s.titulo = `${s.titulo} ${i + 1}`;
        sec.secciones.push(s);
      });
      continue;
    }
    sec.secciones.push(construirSeccion(h, omitir, prof + 1));
  }
  return sec;
}

/** Quita lo técnico (identificadores internos) cuando la persona no lo pidió. */
export function filtrarTecnicos(sec: SeccionLegible, mostrar: boolean): SeccionLegible {
  if (mostrar) return sec;
  return {
    ...sec,
    campos: sec.campos.filter((c) => !c.tecnico),
    tablas: sec.tablas.map((t) => {
      const mantener = t.columnas.map((c) => !c.tecnica);
      return { ...t, columnas: t.columnas.filter((_, i) => mantener[i]), filas: t.filas.map((f) => f.filter((_, i) => mantener[i])) };
    }).filter((t) => t.columnas.length),
    secciones: sec.secciones.map((s) => filtrarTecnicos(s, false)).filter((s) => s.campos.length || s.tablas.length || s.secciones.length),
  };
}

function contar(sec: SeccionLegible, acum = { datos: 0, listas: 0, registros: 0 }): { datos: number; listas: number; registros: number } {
  acum.datos += sec.campos.length;
  sec.tablas.forEach((t) => { acum.listas += 1; acum.registros += t.total; });
  sec.secciones.forEach((s) => contar(s, acum));
  return acum;
}

function hayTecnicos(sec: SeccionLegible): boolean {
  return sec.campos.some((c) => c.tecnico) || sec.tablas.some((t) => t.columnas.some((c) => c.tecnica)) || sec.secciones.some(hayTecnicos);
}

// ------------------------------------------------------------------------------------------------
// Entrada principal
// ------------------------------------------------------------------------------------------------
function parsear(cuerpo: string, contentType: string): { nodo: Nodo | null; formato: 'XML' | 'JSON' | 'TEXTO'; error: string } {
  const t = cuerpo.trim();
  if (!t) return { nodo: null, formato: 'TEXTO', error: '' };
  if (t.startsWith('{') || t.startsWith('[') || /json/i.test(contentType)) {
    try {
      const v = JSON.parse(t);
      const nodo = desdeJson(v, Array.isArray(v) ? '' : 'Respuesta');
      if (Array.isArray(v)) nodo.nombre = 'Respuesta';
      return { nodo, formato: 'JSON', error: '' };
    } catch { /* se prueba como XML o texto */ }
  }
  if (t.startsWith('<')) {
    try {
      const doc = new DOMParser().parseFromString(t, 'application/xml');
      if (doc.querySelector('parsererror') || !doc.documentElement) return { nodo: null, formato: 'XML', error: 'El XML llegó incompleto o con errores, así que no se pudo traducir.' };
      return { nodo: desdeXml(doc.documentElement), formato: 'XML', error: '' };
    } catch {
      return { nodo: null, formato: 'XML', error: 'No se pudo leer el XML de la respuesta.' };
    }
  }
  return { nodo: null, formato: 'TEXTO', error: '' };
}

export function interpretarRespuesta(r: RespuestaParaInterpretar): Interpretacion {
  const contentType = (r.headers || []).find((h) => h.nombre.toLowerCase() === 'content-type')?.valor || '';
  const { nodo, formato, error } = parsear(r.cuerpo || '', contentType);

  // SOAP: se entra al sobre; si hay un Fault, ése es el contenido.
  let carga: Nodo | null = nodo;
  let fault: Nodo | null = null;
  if (carga && carga.nombre.toLowerCase() === 'envelope') {
    const cuerpo = carga.hijos.find((h) => h.nombre.toLowerCase() === 'body');
    if (cuerpo) {
      fault = cuerpo.hijos.find((h) => h.nombre.toLowerCase() === 'fault') || null;
      carga = fault || cuerpo;
    }
  }

  // Se baja por los envoltorios de un solo hijo (Body → getXResponse → XRs…) hasta llegar a donde hay datos.
  let actual: Nodo | null = carga;
  while (actual && actual.hijos.length === 1 && !actual.attrs.length && !actual.texto) actual = actual.hijos[0];
  if (actual && carga && hoja(actual) && actual !== carga) actual = carga; // un único valor: se muestra con su contenedor

  const estado = evaluarEstado(r, carga, actual, !!fault);
  let nota = error;
  if (r.truncado && !nota) nota = 'La respuesta era muy grande y solo llegó el inicio: el resumen puede estar incompleto.';

  if (!carga || !actual) {
    return { formato, estado, raiz: null, origenRaiz: '', contenido: '', hayTecnicos: false, nota };
  }

  const omitir = new Set<Nodo>();
  const bloque = buscarBloqueEstado(actual);
  if (bloque) omitir.add(bloque);
  if (fault) fault.hijos.filter((h) => ['faultcode', 'faultstring'].includes(h.nombre.toLowerCase())).forEach((h) => omitir.add(h));

  const raiz = construirSeccion(actual, omitir, 0);
  const c = contar(raiz);
  const partes: string[] = [];
  if (c.datos) partes.push(`${c.datos} dato${c.datos === 1 ? '' : 's'}`);
  if (c.listas) partes.push(`${c.listas} lista${c.listas === 1 ? '' : 's'} con ${c.registros} registro${c.registros === 1 ? '' : 's'}`);
  return {
    formato, estado, raiz, origenRaiz: actual.nombre,
    contenido: partes.length ? `Se recibieron ${partes.join(' y ')}.` : 'La respuesta no trae datos para mostrar.',
    hayTecnicos: hayTecnicos(raiz), nota,
  };
}

/** Texto plano del resumen, para pegarlo en un correo o chat. */
export function resumenATexto(i: Interpretacion, mostrarTecnicos: boolean): string {
  const lineas: string[] = [i.estado.titulo + (i.estado.detalle ? ` — ${i.estado.detalle}` : '')];
  if (i.estado.codigo) lineas.push(`Código de resultado: ${i.estado.codigo}`);
  const recorrer = (s: SeccionLegible, nivel: number): void => {
    const sangria = '  '.repeat(nivel);
    if (nivel > 0) lineas.push('', `${sangria}${s.titulo}`);
    s.campos.forEach((c) => lineas.push(`${sangria}  ${c.etiqueta}: ${c.valor}`));
    s.tablas.forEach((t) => {
      lineas.push('', `${sangria}  ${t.titulo} (${t.total})`);
      lineas.push(`${sangria}  ${t.columnas.map((c) => c.etiqueta).join('\t')}`);
      t.filas.forEach((f) => lineas.push(`${sangria}  ${f.join('\t')}`));
    });
    s.secciones.forEach((x) => recorrer(x, nivel + 1));
  };
  if (i.raiz) { lineas.push(''); recorrer(filtrarTecnicos(i.raiz, mostrarTecnicos), 0); }
  return lineas.join('\n');
}
