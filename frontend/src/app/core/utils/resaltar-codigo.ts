// Colorea XML y JSON para que se distingan etiquetas, atributos, valores y variables.
// Devuelve HTML ya escapado (solo <span class="tk-…">), pensado para [innerHTML] dentro de un <pre>.
// No cambia ni el ancho ni la altura de los caracteres: sirve también como capa bajo un <textarea>.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ESC[c]);
const span = (clase: string, texto: string): string => (texto ? `<span class="tk-${clase}">${esc(texto)}</span>` : '');

/** Variables de SoapUI/Postman dentro de un texto: ${...} y {{...}}. */
function conVariables(texto: string, clase: string): string {
  return texto
    .split(/(\$\{[^}\n]*\}|\{\{[^}\n]*\}\})/)
    .map((p, i) => (i % 2 === 1 ? span('var', p) : span(clase, p)))
    .join('');
}

function atributos(texto: string): string {
  let salida = '';
  const re = /(\s+)([^\s=<>\/"']+)(\s*=\s*)("[^"]*"|'[^']*')?|(\s+)|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    if (m[2] !== undefined) {
      salida += esc(m[1]) + span('attr', m[2]) + span('pun', m[3]);
      if (m[4]) salida += span('pun', m[4][0]) + conVariables(m[4].slice(1, -1), 'val') + span('pun', m[4][m[4].length - 1]);
    } else if (m[5] !== undefined) salida += esc(m[5]);
    else salida += span('txt', m[6]);
  }
  return salida;
}

export function resaltarXml(texto: string): string {
  const re = /(<!--[\s\S]*?-->)|(<!\[CDATA\[[\s\S]*?\]\]>)|(<[?!][\s\S]*?[?]?>)|(<\/?)([^\s>\/<]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?>)|([^<]+)|(<)/g;
  let salida = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    if (m[1]) salida += span('com', m[1]);
    else if (m[2]) salida += span('cdata', m[2]);
    else if (m[3]) salida += span('com', m[3]);
    else if (m[5] !== undefined) {
      const [prefijo, local] = m[5].includes(':') ? [m[5].slice(0, m[5].indexOf(':') + 1), m[5].slice(m[5].indexOf(':') + 1)] : ['', m[5]];
      salida += span('pun', m[4]) + span('ns', prefijo) + span('tag', local) + atributos(m[6]) + span('pun', m[7]);
    } else if (m[8] !== undefined) salida += conVariables(m[8], 'txt');
    else salida += span('pun', m[9]);
  }
  return salida;
}

export function resaltarJson(texto: string): string {
  const re = /("(?:\\.|[^"\\\n])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\$\{[^}\n]*\}|\{\{[^}\n]*\}\})|([{}\[\],:])|(\s+)|([^\s]+)/g;
  let salida = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    if (m[1] !== undefined) salida += m[2] ? span('key', m[1]) + span('pun', m[2]) : conVariables(m[1], 'str');
    else if (m[3]) salida += span('bool', m[3]);
    else if (m[4]) salida += span('num', m[4]);
    else if (m[5]) salida += span('var', m[5]);
    else if (m[6]) salida += span('pun', m[6]);
    else if (m[7]) salida += esc(m[7]);
    else salida += span('txt', m[8]);
  }
  return salida;
}

/** Elige XML o JSON según cómo empieza el texto; el resto se muestra tal cual (con las variables resaltadas). */
export function resaltarCodigo(texto: string): string {
  const t = texto.trimStart();
  if (t.startsWith('<')) return resaltarXml(texto);
  if (t.startsWith('{') || t.startsWith('[')) return resaltarJson(texto);
  return conVariables(texto, 'txt');
}
