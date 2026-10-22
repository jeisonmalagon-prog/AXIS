// Datos personales en Monitoreo transaccional > BREB.
//
// La pantalla es de monitoreo: ayuda a ver QUÉ pasó con una transacción, no a leer datos de clientes. Por eso todo lo que sale
// hacia el navegador pasa por aquí:
//  · documentos → solo los últimos 3 caracteres; cuentas → últimos 4; nombres → primer nombre + iniciales;
//  · correos y celulares → parcialmente ocultos; llaves → inicio y fin;
//  · claves, tokens, firmas, imágenes de QR → «[oculto]».
// Los payloads de los logs (Rq/Rs en JSON, XML o texto) se limpian con las mismas reglas.

const dos = (n) => String(n).padStart(2, '0');

function mascDocumento(v) {
  if (v === null || v === undefined || v === '') return v ?? null;
  const s = String(v).trim();
  if (!s || /^null$/i.test(s)) return s;
  return s.length <= 3 ? '***' : `${'*'.repeat(Math.min(s.length - 3, 8))}${s.slice(-3)}`;
}

function mascCuenta(v) {
  if (v === null || v === undefined || v === '') return v ?? null;
  const s = String(v).trim();
  if (!s || /^null$/i.test(s)) return s;
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}

function mascNombre(v) {
  if (v === null || v === undefined || v === '') return v ?? null;
  const palabras = String(v).trim().split(/\s+/).filter(Boolean);
  if (!palabras.length || /^null$/i.test(palabras[0])) return String(v);
  const [primero, ...resto] = palabras;
  const cap = (p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  return [cap(primero), ...resto.map((p) => `${p.charAt(0).toUpperCase()}.`)].join(' ');
}

function mascInicial(v) {
  if (v === null || v === undefined || v === '') return v ?? null;
  const t = String(v).trim();
  return t ? `${t.charAt(0).toUpperCase()}.` : t;
}

function mascCorreo(v) {
  if (v === null || v === undefined || v === '') return v ?? null;
  const s = String(v).trim();
  const i = s.indexOf('@');
  if (i < 1) return '[oculto]';
  return `${s.slice(0, 1)}***${s.slice(i)}`;
}

function mascTelefono(v) {
  if (v === null || v === undefined || v === '') return v ?? null;
  const s = String(v).replace(/\s+/g, '');
  return s.length <= 3 ? '***' : `${'*'.repeat(Math.min(s.length - 3, 8))}${s.slice(-3)}`;
}

/** Llaves BreB: pueden ser celular, correo, documento, código de comercio o alfanuméricas. */
function mascLlave(v) {
  if (v === null || v === undefined || v === '') return v ?? null;
  const s = String(v).trim();
  if (s.includes('@')) return mascCorreo(s);
  if (s.length <= 5) return '***';
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(s.length - 5, 8))}${s.slice(-3)}`;
}

const APLICAR = {
  documento: mascDocumento, cuenta: mascCuenta, nombre: mascNombre, inicial: mascInicial, correo: mascCorreo, telefono: mascTelefono, llave: mascLlave,
  oculto: () => '[oculto]',
};

/** Aplica máscaras por columna: { NombreColumna: 'documento' | 'cuenta' | 'nombre' | 'correo' | 'telefono' | 'llave' | 'oculto' }. */
function enmascararFilas(filas, mapa) {
  const claves = Object.entries(mapa || {});
  if (!claves.length) return filas;
  return filas.map((f) => {
    const o = { ...f };
    for (const [col, tipo] of claves) if (col in o && o[col] !== null && o[col] !== undefined) o[col] = (APLICAR[tipo] || APLICAR.oculto)(o[col]);
    return o;
  });
}

// ---------------------------------------------------------------------------
// Payloads de logs
// ---------------------------------------------------------------------------
const RE_CLAVE_OCULTA = /(pass(word)?|clave|secret|token|authorization|apikey|api_key|pwd|credential|signer|qrcodeimage|securitycode|otp|pin\b|cvv|hash|firma)/i;
const RE_CLAVE_CORREO = /(e-?mail|correo|mail)/i;
const RE_CLAVE_TEL = /(celular|telefono|teléfono|phone|movil|móvil|mobile|\btel\b)/i;
const RE_CLAVE_DOC = /(documento|document(number)?|numerodocumento|identificacion|identification|cedula|cédula|\bnit\b|numdoc|custpermid|govissueident)/i;
const RE_CLAVE_CUENTA = /(account|cuenta|acctid|numerocuenta|iban)/i;
const RE_CLAVE_NOMBRE = /(^nombre|name|alias|apellido|nombres|partyalias|fullname|razonsocial)/i;
const RE_CLAVE_LLAVE = /(^llave$|aliasvalue|keyvalue|handle)/i;
const RE_CLAVE_DIR = /(direccion|dirección|address)/i;
const RE_CORREO_TEXTO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const RE_CLAVE_NO_PERSONAL = /(date|time|fecha|hora|stamp|amount|monto|sum|valor|value|^id$|id$|codigo|code|aprobacion|approval|aproval|trace|secuencia|sequence|consecutivo|^t\d{3}$)/i;

function valorPorClave(clave, valor) {
  if (valor === null || valor === undefined || typeof valor === 'object') return valor;
  const s = String(valor);
  if (s === '' || /^null$/i.test(s)) return valor;
  if (RE_CLAVE_OCULTA.test(clave)) return '[oculto]';
  if (RE_CLAVE_CORREO.test(clave)) return mascCorreo(s);
  if (RE_CLAVE_TEL.test(clave)) return mascTelefono(s);
  if (RE_CLAVE_DIR.test(clave)) return '[oculto]';
  if (RE_CLAVE_CUENTA.test(clave) && !/type|tipo|entity|status|estado/i.test(clave)) return mascCuenta(s);
  if (RE_CLAVE_DOC.test(clave) && !/type|tipo/i.test(clave)) return mascDocumento(s);
  if (RE_CLAVE_LLAVE.test(clave)) return mascLlave(s);
  if (RE_CLAVE_NOMBRE.test(clave) && !/entity|status|bank|banco|tipo|type|usuario|user|method|metodo|app|class|clase/i.test(clave)) return mascNombre(s);
  // Respaldo: un número largo (8+ dígitos) en un campo que no es fecha, monto ni identificador técnico se trata como dato personal.
  if (typeof valor === 'string' && /^\d{8,}$/.test(s) && !RE_CLAVE_NO_PERSONAL.test(clave)) return mascDocumento(s);
  return typeof valor === 'string' ? s.replace(RE_CORREO_TEXTO, (m) => mascCorreo(m)) : valor;
}

/** Recorre un objeto JSON enmascarando por nombre de campo. Los pares {nombre, valor} (como en `parametro`) se tratan por su nombre. */
function limpiarObjeto(x, clave = '', profundidad = 0) {
  if (profundidad > 12) return '[…]';
  if (Array.isArray(x)) return x.map((i) => limpiarObjeto(i, clave, profundidad + 1));
  if (x && typeof x === 'object') {
    const o = {};
    const esPar = typeof x.nombre === 'string' && 'valor' in x && Object.keys(x).length === 2;
    for (const [k, v] of Object.entries(x)) {
      if (esPar && k === 'valor') o[k] = valorPorClave(x.nombre, v);
      else o[k] = limpiarObjeto(v, k, profundidad + 1);
    }
    return o;
  }
  return valorPorClave(clave, x);
}

const RE_ETIQUETA_XML = /<([A-Za-z0-9_:.-]*(Acct|Account|Cust|Ident|Doc|Phone|Email|Name|Tel|Addr|Token|Pass|Secret)[A-Za-z0-9_:.-]*)>([^<]{1,200})<\/\1>/gi;

function limpiarTexto(texto) {
  return String(texto)
    .replace(RE_ETIQUETA_XML, (_m, tag, _g, valor) => `<${tag}>${valorPorClave(tag, valor.trim())}</${tag}>`)
    .replace(RE_CORREO_TEXTO, (m) => mascCorreo(m))
    .replace(/\b\d{8,}\b/g, (m) => `${'*'.repeat(Math.min(m.length - 3, 8))}${m.slice(-3)}`);
}

/** Columnas de texto libre (descripciones, mensajes, motivos…) que pueden traer documentos o correos incrustados. */
const RE_COLUMNA_LIBRE = /(descrip|adicional|mensaje|detalle|motivo|ejemplo|muestra|observ|texto)/i;
function limpiarTextoLibre(filas) {
  return filas.map((f) => {
    let o = f;
    for (const [k, v] of Object.entries(f)) {
      if (typeof v === 'string' && v && RE_COLUMNA_LIBRE.test(k)) {
        const l = limpiarTexto(v);
        if (l !== v) { if (o === f) o = { ...f }; o[k] = l; }
      }
    }
    return o;
  });
}

/** Devuelve el payload (JSON, XML o texto) listo para mostrar: datos personales ocultos y tamaño acotado. */
function limpiarPayload(texto, { max = 12000 } = {}) {
  if (texto === null || texto === undefined || texto === '') return null;
  const crudo = String(texto);
  const t = crudo.trim();
  let salida;
  let tipo = 'texto';
  if (/^[{[]/.test(t)) {
    try {
      salida = JSON.stringify(limpiarObjeto(JSON.parse(t)), null, 2);
      tipo = 'json';
    } catch { salida = limpiarTexto(crudo); }
  } else {
    salida = limpiarTexto(crudo);
    if (/^</.test(t)) tipo = 'xml';
  }
  const truncado = salida.length > max;
  return { tipo, texto: truncado ? `${salida.slice(0, max)}\n… (recortado)` : salida, truncado, bytes: crudo.length };
}

/** Intenta leer un JSON; si no es JSON válido devuelve null. */
function leerJson(texto) {
  if (texto === null || texto === undefined) return null;
  const t = String(texto).trim();
  if (!/^[{[]/.test(t)) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** Aplana un objeto JSON (ya limpio) a filas Campo/Valor para mostrarlo como tabla. */
function aplanar(x, prefijo = '', salida = [], profundidad = 0) {
  if (salida.length > 200) return salida;
  if (Array.isArray(x)) {
    if (!x.length) salida.push({ Campo: prefijo || '(vacío)', Valor: '[]' });
    x.slice(0, 50).forEach((v, i) => aplanar(v, `${prefijo}[${i}]`, salida, profundidad + 1));
  } else if (x && typeof x === 'object' && profundidad < 8) {
    for (const [k, v] of Object.entries(x)) aplanar(v, prefijo ? `${prefijo}.${k}` : k, salida, profundidad + 1);
  } else {
    salida.push({ Campo: prefijo || '(valor)', Valor: x === null || x === undefined ? null : String(x).slice(0, 300) });
  }
  return salida;
}

const fechaCorta = (d) => `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())}`;

module.exports = {
  mascDocumento, mascCuenta, mascNombre, mascInicial, mascCorreo, mascTelefono, mascLlave, enmascararFilas, limpiarObjeto, limpiarPayload, limpiarTexto, limpiarTextoLibre, leerJson, aplanar, fechaCorta,
};
