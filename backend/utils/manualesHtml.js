// Utilidades del módulo MANUALES: limpieza del HTML que se guarda, texto plano
// para la búsqueda, y separación de un documento Word en varias páginas.
//
// El contenido de un manual es HTML. Como luego se muestra tal cual en la
// pantalla, SIEMPRE se limpia en el servidor (sanitize-html) antes de guardarlo:
// se conservan solo las etiquetas y estilos que el editor y el importador de
// Word realmente producen, y se descarta todo lo demás (scripts, iframes,
// manejadores onclick, enlaces javascript:, etc.).

const sanitizeHtml = require('sanitize-html');

const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/i, /^[a-z]{3,20}$/i];
const MEDIDA = [/^\d+(\.\d+)?(px|%|em|rem)$/];

const OPCIONES_SANITIZAR = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'mark', 'sub', 'sup',
    'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col', 'caption',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'style'],
    td: ['colspan', 'rowspan', 'data-colwidth', 'style'],
    th: ['colspan', 'rowspan', 'data-colwidth', 'style'],
    col: ['span', 'style'],
    ol: ['start', 'type'],
    code: ['class'],
    pre: ['class'],
    '*': ['style', 'data-color'],
  },
  allowedStyles: {
    '*': {
      color: COLOR,
      'background-color': COLOR,
      'text-align': [/^(left|right|center|justify)$/],
      width: MEDIDA,
      'min-width': MEDIDA,
      height: MEDIDA,
      'font-weight': [/^(normal|bold|[1-9]00)$/],
      'font-style': [/^(normal|italic)$/],
      'text-decoration': [/^(none|underline|line-through)( (underline|line-through))?$/],
    },
  },
  allowedClasses: { code: ['language-*'], pre: ['language-*'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // Las imágenes pegadas o importadas viajan dentro del HTML como data:image/...
  allowedSchemesByTag: { img: ['data'], a: ['http', 'https', 'mailto', 'tel'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tag, attribs) => ({
      tagName: 'a',
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
    }),
    // Solo se aceptan imágenes data:image/(png|jpeg|gif|webp|bmp); cualquier otra se descarta.
    img: (tag, attribs) => {
      const src = String(attribs.src || '');
      if (!/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(src)) return { tagName: 'span', attribs: {} };
      return { tagName: 'img', attribs };
    },
  },
};

function sanitizar(html) {
  return sanitizeHtml(String(html || ''), OPCIONES_SANITIZAR);
}

const ENTIDADES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&#x27;': "'" };

// Texto plano (para buscar y para armar títulos/resúmenes).
function aTexto(html) {
  const conCortes = String(html || '')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote|td|th)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ');
  const sinTags = sanitizeHtml(conCortes, { allowedTags: [], allowedAttributes: {} });
  return sinTags
    .replace(/&(amp|lt|gt|quot|#39|nbsp|#x27);/g, (m) => ENTIDADES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function tieneContenido(html) {
  return aTexto(html).length > 0 || /<img\s/i.test(html || '');
}

const MESES = { enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11 };
const RE_FECHA = /^(?:[a-záéíóú]+,?\s+)?(\d{1,2}) de ([a-záéú]+) de (\d{4})(?:[\s,]+(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s?m\.?)?)?$/i;
const RE_HORA = /^(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s?m\.?)?$/i;

function aFecha(dia, mesTxt, anio, h, m, ampm) {
  const mes = MESES[String(mesTxt).toLowerCase()];
  if (mes === undefined) return null;
  let hora = h !== undefined ? Number(h) : 0;
  if (ampm) {
    const pm = String(ampm).toLowerCase() === 'p';
    if (pm && hora < 12) hora += 12;
    if (!pm && hora === 12) hora = 0;
  }
  return { y: Number(anio), mo: mes, d: Number(dia), h: hora, mi: m !== undefined ? Number(m) : 0 };
}

function fechaSql(f) {
  const p = (n) => String(n).padStart(2, '0');
  return `${f.y}-${p(f.mo + 1)}-${p(f.d)} ${p(f.h)}:${p(f.mi)}:00`;
}

// OneNote, al exportar a Word, deja bajo el título la fecha de creación de la
// página ("miércoles, 20 de mayo de 2026" y, a veces en otro párrafo, "4:53 p. m.").
// Si el primer bloque es esa fecha se retira del contenido y se devuelve aparte.
function extraerFechaOrigen(html) {
  const bloque = /^\s*<(p|div)[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  if (!bloque) return { html, fecha: null };
  const t1 = aTexto(bloque[2]);
  const m1 = RE_FECHA.exec(t1);
  if (!m1) return { html, fecha: null };
  let fecha = aFecha(m1[1], m1[2], m1[3], m1[4], m1[5], m1[6]);
  if (!fecha) return { html, fecha: null };
  let resto = html.slice(bloque[0].length);
  if (m1[4] === undefined) {
    const b2 = /^\s*<(p|div)[^>]*>([\s\S]*?)<\/\1>/i.exec(resto);
    const m2 = b2 && RE_HORA.exec(aTexto(b2[2]));
    if (m2) {
      fecha = aFecha(String(fecha.d), Object.keys(MESES)[fecha.mo], String(fecha.y), m2[1], m2[2], m2[3]) || fecha;
      resto = resto.slice(b2[0].length);
    }
  }
  return { html: resto, fecha: fechaSql(fecha) };
}

const MAX_TITULO = 200;
function recortarTitulo(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_TITULO ? s.slice(0, MAX_TITULO - 1) + '…' : s;
}

// Primer bloque con texto = título de la página (y se retira del cuerpo si cabe).
function tituloDelPrimerBloque(html) {
  const m = /<(p|h[1-6]|div)[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  if (!m) return { titulo: '', html };
  const texto = aTexto(m[2]);
  if (!texto) {
    return tituloDelPrimerBloque(html.slice(m.index + m[0].length));
  }
  if (texto.length > MAX_TITULO) return { titulo: recortarTitulo(texto), html };
  return { titulo: texto, html: html.slice(m.index + m[0].length) };
}

// Convierte el HTML que produce mammoth (Word) en una lista de páginas.
//   modo 'titulo' : cada «Título 1» abre una página nueva.
//   modo 'pagina' : cada salto de página de Word abre una página nueva.
//   modo 'una'    : todo el documento es una sola página.
//   modo 'auto'   : título si hay 2 o más; si no, saltos de página; si no, una.
const RE_SALTO = /<hr class="page-break"\s*\/?>/gi;

function dividirPaginas(html, modo, tituloArchivo) {
  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  const saltos = (html.match(RE_SALTO) || []).length;
  let m = modo;
  if (!['titulo', 'pagina', 'una'].includes(m)) m = h1 >= 2 ? 'titulo' : saltos >= 1 ? 'pagina' : 'una';

  let crudas = [];
  if (m === 'titulo') {
    const partes = html.split(/(?=<h1[\s>])/i);
    for (const parte of partes) {
      const t = /^<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(parte);
      if (t) crudas.push({ titulo: recortarTitulo(aTexto(t[1])), html: parte.slice(t[0].length) });
      else if (tieneContenido(parte)) crudas.push({ titulo: tituloArchivo, html: parte });
    }
  } else if (m === 'pagina') {
    for (const parte of html.split(RE_SALTO)) {
      if (!tieneContenido(parte)) continue;
      crudas.push(tituloDelPrimerBloque(parte));
    }
  } else {
    const t = /^\s*<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (t && h1 === 1) crudas.push({ titulo: recortarTitulo(aTexto(t[1])), html: html.slice(t[0].length) });
    else crudas.push({ titulo: tituloArchivo, html });
  }

  const paginas = [];
  for (const c of crudas) {
    const { html: sinFecha, fecha } = extraerFechaOrigen(c.html.replace(RE_SALTO, ''));
    if (!tieneContenido(sinFecha) && !c.titulo) continue;
    paginas.push({
      titulo: c.titulo || tituloArchivo || 'Sin título',
      html: sinFecha.trim(),
      fechaOrigen: fecha,
    });
  }
  return { modo: m, paginas };
}

// Word no tiene «bloque de código»: los comandos se escriben con una fuente de
// ancho fijo (Consolas, Courier New...). El importador marca esas ejecuciones
// como <code>; aquí los párrafos que son solo código se juntan en un único
// <pre><code> para que se vean (y se copien) como un bloque de consola.
function agruparCodigo(html) {
  let h = String(html || '').replace(/<\/code>(\s*)<code>/gi, '$1');
  h = h.replace(/<\/pre>\s*<pre>/gi, '\n');
  const re = /(?:<p>\s*<code>([\s\S]*?)<\/code>\s*<\/p>\s*)+/gi;
  return h.replace(re, (bloque) => {
    const lineas = [];
    const reP = /<p>\s*<code>([\s\S]*?)<\/code>\s*<\/p>/gi;
    let m;
    while ((m = reP.exec(bloque))) lineas.push(m[1]);
    return `<pre><code>${lineas.join('\n')}</code></pre>`;
  });
}

module.exports = { agruparCodigo, sanitizar, aTexto, tieneContenido, dividirPaginas, extraerFechaOrigen, recortarTitulo };
