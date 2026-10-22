'use strict';

// Análisis estático de scripts T-SQL para el repositorio de queries del catálogo de datos.
// No ejecuta nada: lee el texto, separa sentencias, detecta tablas/JOIN, clasifica el riesgo,
// enmascara valores sensibles y valida que un texto sea de solo lectura.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Decodificación de archivos (UTF-8, UTF-16 con/sin BOM, Windows-1252)
// ---------------------------------------------------------------------------
function decodificarBuffer(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const copia = Buffer.from(buf.subarray(2));
    copia.swap16();
    return copia.toString('utf16le');
  }
  // UTF-16 sin BOM: muchos bytes nulos en posiciones alternas
  const muestra = buf.subarray(0, Math.min(buf.length, 400));
  let nulos = 0;
  for (const b of muestra) if (b === 0) nulos += 1;
  if (muestra.length > 8 && nulos > muestra.length * 0.3) return buf.toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function normalizarSaltos(texto) {
  return String(texto || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------
// Escáner: comentarios, cadenas e identificadores
// ---------------------------------------------------------------------------
// Devuelve una «máscara» del mismo largo que el texto: comentarios y contenido de cadenas
// pasan a espacios (los saltos de línea se conservan), los identificadores [x] se mantienen.
// `codigo` además vacía los identificadores entre corchetes/comillas dobles.
function escanear(sql) {
  const s = String(sql || '');
  const n = s.length;
  const m = new Array(n);
  const cod = new Array(n);
  const segmentos = []; // {t:'str'|'com'|'id', ini, fin}
  let i = 0;
  const blanquear = (a, b, destinos) => {
    for (let k = a; k < b; k++) {
      const ch = s[k];
      const v = ch === '\n' || ch === '\r' ? ch : ' ';
      for (const d of destinos) d[k] = v;
    }
  };
  while (i < n) {
    const ch = s[i];
    const sig = s[i + 1];
    if (ch === '-' && sig === '-') {
      let j = i;
      while (j < n && s[j] !== '\n') j++;
      blanquear(i, j, [m, cod]);
      segmentos.push({ t: 'com', ini: i, fin: j });
      i = j;
    } else if (ch === '/' && sig === '*') {
      let j = i + 2;
      let nivel = 1;
      while (j < n && nivel > 0) {
        if (s[j] === '/' && s[j + 1] === '*') { nivel++; j += 2; }
        else if (s[j] === '*' && s[j + 1] === '/') { nivel--; j += 2; }
        else j++;
      }
      blanquear(i, j, [m, cod]);
      segmentos.push({ t: 'com', ini: i, fin: j });
      i = j;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      const fin = Math.min(j + 1, n);
      m[i] = cod[i] = "'";
      blanquear(i + 1, Math.max(i + 1, fin - 1), [m, cod]);
      if (fin - 1 > i) m[fin - 1] = cod[fin - 1] = j < n ? "'" : ' ';
      segmentos.push({ t: 'str', ini: i, fin });
      i = fin;
    } else if (ch === '[' || ch === '"') {
      const cierre = ch === '[' ? ']' : '"';
      let j = i + 1;
      while (j < n) {
        if (s[j] === cierre) { if (s[j + 1] === cierre) { j += 2; continue; } break; }
        if (s[j] === '\n' && ch === '[') { break; }
        j++;
      }
      const fin = Math.min(j + 1, n);
      for (let k = i; k < fin; k++) m[k] = s[k];
      cod[i] = ch;
      blanquear(i + 1, Math.max(i + 1, fin - 1), [cod]);
      if (fin - 1 > i) cod[fin - 1] = s[fin - 1];
      segmentos.push({ t: 'id', ini: i, fin });
      i = fin;
    } else {
      m[i] = cod[i] = ch;
      i++;
    }
  }
  return { mascara: m.join(''), codigo: cod.join(''), segmentos };
}

// ---------------------------------------------------------------------------
// Nombres de tablas
// ---------------------------------------------------------------------------
const ID = String.raw`(?:\[[^\]\n]+\]|"[^"\n]+"|[A-Za-z_#@][\w$#@]*)`;
const NOMBRE = String.raw`${ID}(?:\s*\.\s*(?:${ID})?){0,3}`;

const RESERVADAS = new Set(['WHERE', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'JOIN', 'ON', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'WITH',
  'SET', 'VALUES', 'SELECT', 'USING', 'WHEN', 'OPTION', 'FOR', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'EXCEPT', 'INTERSECT', 'OUTPUT', 'AS',
  'FROM', 'INTO', 'GO', 'DECLARE', 'AND', 'OR', 'NOT', 'APPLY', 'PIVOT', 'UNPIVOT', 'TABLESAMPLE', 'READUNCOMMITTED', 'NOLOCK', 'TOP', 'DISTINCT',
  'EXEC', 'EXECUTE', 'BEGIN', 'END', 'IF', 'ELSE', 'THEN', 'CASE', 'LIMIT', 'OFFSET', 'FETCH', 'USE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'NATURAL']);

function quitarComillas(p) {
  const t = String(p || '').trim();
  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1).replace(/\]\]/g, ']');
  return t;
}

function partirNombre(texto) {
  const partes = [];
  const re = new RegExp(`(${ID})|(\\.)`, 'g');
  let ultimoPunto = true;
  let m;
  let actual = null;
  const lista = [];
  while ((m = re.exec(texto))) {
    if (m[1]) { actual = quitarComillas(m[1]); lista.push(actual); ultimoPunto = false; }
    else if (m[2]) { if (ultimoPunto) lista.push(''); ultimoPunto = true; }
  }
  for (const p of lista) partes.push(p);
  return partes;
}

function esTemporal(nombre) { return /^[#@]/.test(nombre || ''); }

function tablaDesdePartes(partes, bdPorDefecto) {
  const p = partes.slice();
  if (!p.length) return null;
  const tabla = p.pop();
  const esquema = p.length ? p.pop() : '';
  const bd = p.length ? p.pop() : '';
  const servidor = p.length ? p.pop() : '';
  if (!tabla) return null;
  return {
    servidor: servidor || '',
    bd: bd || bdPorDefecto || '',
    esquema: esquema || 'dbo',
    tabla,
    esquemaExplicito: !!esquema,
  };
}

function claveTabla(t) { return `${(t.bd || '').toLowerCase()}.${(t.esquema || 'dbo').toLowerCase()}.${t.tabla.toLowerCase()}`; }

// ---------------------------------------------------------------------------
// Secretos y enmascaramiento
// ---------------------------------------------------------------------------
const PALABRAS_SECRETO = '(?:password|passwd|pwd|pass|clave|contrase(?:ñ|n)a|contrasena|secret|secreto|token|apikey|api_key|api-key|authorization|bearer|credencial|llave_secreta)';
const RE_SECRETO_CONTEXTO = new RegExp(`${PALABRAS_SECRETO}[\\w\\]\\[]*\\s*(?:=|:|like|,|\\()\\s*N?$`, 'i');
const RE_COLUMNA_PERSONAL = /(documento|cedula|cédula|identific|nit\b|^nit|celular|telefono|teléfono|movil|tarjeta|cuenta|correo|email|e_mail|mail|address|direccion|pasaporte)/i;
const RE_VALOR_PERSONAL = /^(?:\d{6,}|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

function contextoPrevio(codigoAntes) {
  // devuelve {columna, operador, enLista}
  const t = codigoAntes.replace(/\s+$/, '');
  let m = /([\w\]\[.#@]+)\s*(=|<>|!=|>=|<=|like|not\s+like|in\s*\(|not\s+in\s*\()\s*N?$/i.exec(t);
  if (m) return { columna: m[1], operador: m[2].toLowerCase(), enLista: /in\s*\($/i.test(m[2]) };
  return null;
}

function enmascarar(sql) {
  const texto = String(sql || '');
  const { segmentos, mascara } = escanear(texto);
  let salida = '';
  let pos = 0;
  let finCadenaPrevia = 0;
  const cambios = { secretos: 0, personales: 0 };
  let ctxLista = null; // columna del IN ( ... ) en curso

  const reemplazarCodigo = (trozo) => trozo.replace(/([\w\]\[]*(?:documento|cedula|identificacion|nit|celular|telefono|tarjeta|cuenta)[\w\]\[]*)\s*(=|<>|!=)\s*(\d{6,})\b/gi, (_t, col, op) => {
    cambios.personales += 1;
    return `${col} ${op} '<VALOR>'`;
  });

  const mascararComentario = (txt) => txt.replace(/(?<![\d.])\d{7,12}(?![\d.])/g, (x) => {
    if (/^20\d{6}$/.test(x)) return x;
    cambios.personales += 1;
    return '<VALOR>';
  });

  const RE_CAMPO_PERSONAL_EN_CADENA = /((?:documento|cedula|identif\w*|numide|nit|celular|telefono|tarjeta|cuenta|correo|email)\w*\s*(?:=|<>|like)\s*)('{1,2})(\d{6,})\2/gi;

  for (const seg of segmentos) {
    if (seg.t === 'id') continue;
    if (seg.t === 'com') {
      salida += reemplazarCodigo(texto.slice(pos, seg.ini)) + mascararComentario(texto.slice(seg.ini, seg.fin));
      pos = seg.fin;
      continue;
    }
    const previo = texto.slice(pos, seg.ini);
    const codigoAntes = mascara.slice(finCadenaPrevia, seg.ini);
    const crudo = texto.slice(seg.ini, seg.fin);
    const contenido = texto.slice(seg.ini + 1, seg.fin - 1);
    let nuevo = null;
    if (RE_SECRETO_CONTEXTO.test(codigoAntes.replace(/\s+$/, ''))) {
      nuevo = "'<SECRETO>'";
      cambios.secretos += 1;
    } else if (/(?:password|pwd|pass|token|secret|apikey|api_key)\s*=/i.test(contenido) || /\bbearer\s+\S{8,}/i.test(contenido)) {
      const t = crudo
        .replace(/((?:password|pwd|pass|token|secret|apikey|api_key)\s*=)\s*[^;'"]*/gi, '$1<SECRETO>')
        .replace(/(bearer\s+)\S{8,}/gi, '$1<SECRETO>');
      if (t !== crudo) { nuevo = t; cambios.secretos += 1; }
    }
    if (!nuevo) {
      const solo = /^[\s,N]*$/.test(mascara.slice(finCadenaPrevia, seg.ini));
      let ctx = contextoPrevio(codigoAntes);
      if (!ctx && ctxLista && solo) ctx = { columna: ctxLista, operador: 'in', enLista: true };
      if (ctx && RE_COLUMNA_PERSONAL.test(ctx.columna) && RE_VALOR_PERSONAL.test(contenido.trim())) {
        nuevo = "'<VALOR>'";
        cambios.personales += 1;
      }
      ctxLista = ctx && ctx.enLista ? ctx.columna : (ctxLista && solo ? ctxLista : null);
      if (!nuevo && RE_CAMPO_PERSONAL_EN_CADENA.test(crudo)) {
        RE_CAMPO_PERSONAL_EN_CADENA.lastIndex = 0;
        nuevo = crudo.replace(RE_CAMPO_PERSONAL_EN_CADENA, (_t, pre, q) => { cambios.personales += 1; return `${pre}${q}<VALOR>${q}`; });
      }
      RE_CAMPO_PERSONAL_EN_CADENA.lastIndex = 0;
    }
    salida += reemplazarCodigo(previo) + (nuevo || crudo);
    pos = seg.fin;
    finCadenaPrevia = seg.fin;
  }
  salida += reemplazarCodigo(texto.slice(pos));
  return { sql: salida, cambios, huboCambios: cambios.secretos + cambios.personales > 0 };
}

function detectarSecretos(sql) {
  const t = String(sql || '');
  return new RegExp(`${PALABRAS_SECRETO}[\\w\\]\\[]*\\s*(?:=|:|like)\\s*N?'[^']{3,}'`, 'i').test(t)
    || /(?:password|pwd)\s*=\s*[^;'"\s][^;'"]*/i.test(t)
    || /\bbearer\s+[A-Za-z0-9._\-]{16,}/i.test(t)
    || /identified\s+by\s+'/i.test(t);
}

// ---------------------------------------------------------------------------
// Separación en sentencias
// ---------------------------------------------------------------------------
const INICIOS = /^(SELECT|INSERT|UPDATE|DELETE|MERGE|EXEC(?:UTE)?|WITH|DECLARE|USE|TRUNCATE|DROP|ALTER|CREATE|SET|IF|WHILE|BEGIN|PRINT|RETURN|RAISERROR|WAITFOR|OPEN|CLOSE|FETCH|DEALLOCATE|COMMIT|ROLLBACK|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|KILL|BULK)\b/i;
const CTE_INICIO = /^WITH\s+[\[\w"]+\s*(?:\([^)]*\)\s*)?AS\s*\(/i;
const PREVIAS_QUE_CONTINUAN_SELECT = new Set(['UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'AS', 'IN', 'EXISTS', 'ANY', 'SOME', 'THEN', 'ELSE', '(', ',']);

function palabraAnterior(c, k) {
  const tramo = c.slice(Math.max(0, k - 40), k).replace(/\s+$/, '');
  const m = /([A-Za-z_]+|\S)$/.exec(tramo);
  return m ? m[1].toUpperCase() : '';
}

function clasePreambulo(kind) { return kind === 'DECLARE' || kind === 'USE' || kind === 'SET'; }

// Devuelve [{ kind, texto, bd, orden }]
function dividirBloques(sql) {
  const original = normalizarSaltos(sql);
  const { codigo } = escanear(original);
  const c = codigo;
  const n = c.length;
  const starts = []; // {ini, kind, mainVisto}
  let cur = null;
  let depth = 0;
  let i = 0;
  while (i < n) {
    // inicio de línea en i
    let fin = c.indexOf('\n', i);
    if (fin < 0) fin = n;
    let j = i;
    while (j < fin && (c[j] === ' ' || c[j] === '\t' || c[j] === ';')) {
      if (c[j] === ';' && depth === 0 && cur) cur.cerrado = true;
      j++;
    }
    if (j >= fin) {
      // línea en blanco
      if (cur && cur.kind === 'OTRO' && depth === 0) cur = null;
    } else {
      const resto = c.slice(j, Math.min(n, j + 400));
      const linea = c.slice(j, fin);
      if (/^GO\b[ \t]*\d*[ \t]*$/i.test(linea)) {
        cur = null;
        starts.push({ ini: j, kind: 'GO' });
      } else if (depth === 0) {
        const mk = INICIOS.exec(resto);
        if (mk) {
          let kw = mk[1].toUpperCase();
          if (kw === 'EXECUTE') kw = 'EXEC';
          if (cur && cur.cerrado && cur.kind !== 'DEF') cur = null;
          let inicio = true;
          const previa = palabraAnterior(c, j);
          if (cur) {
            if (cur.kind === 'OTRO' || cur.kind === 'DEF') inicio = false;
            else if (kw === 'SELECT') {
              if (PREVIAS_QUE_CONTINUAN_SELECT.has(previa)) inicio = false;
              else if (cur.kind === 'INSERT' && !/\b(SELECT|VALUES|EXEC)\b/i.test(c.slice(cur.ini, j))) inicio = false;
              else if (cur.kind === 'WITH' && !cur.mainVisto) { inicio = false; cur.mainVisto = true; }
            } else if (kw === 'INSERT' || kw === 'UPDATE' || kw === 'DELETE' || kw === 'MERGE') {
              if (cur.kind === 'MERGE' || previa === 'THEN' || previa === 'ELSE') inicio = false;
              else if (cur.kind === 'WITH' && !cur.mainVisto) { inicio = false; cur.mainVisto = true; }
            } else if (kw === 'SET') {
              if (cur.kind === 'UPDATE' || cur.kind === 'MERGE') inicio = false;
            } else if (kw === 'WITH') {
              inicio = CTE_INICIO.test(resto);
            } else if (kw === 'EXEC') {
              if (previa === 'THEN' || previa === 'ELSE' || (cur.kind === 'INSERT' && !/\b(SELECT|VALUES|EXEC)\b/i.test(c.slice(cur.ini, j)))) inicio = false;
            }
          } else if (kw === 'WITH' && !CTE_INICIO.test(resto)) {
            inicio = true;
          }
          if (inicio) {
            const esDef = /^(CREATE|ALTER)\s+(?:OR\s+ALTER\s+)?(?:PROC(?:EDURE)?|FUNCTION|TRIGGER|VIEW)\b/i.test(resto);
            const kind = esDef ? 'DEF' : ['IF', 'WHILE', 'BEGIN', 'PRINT', 'RETURN', 'RAISERROR', 'WAITFOR', 'OPEN', 'CLOSE', 'FETCH', 'DEALLOCATE', 'COMMIT', 'ROLLBACK'].includes(kw) ? 'OTRO' : kw;
            cur = { ini: j, kind, cerrado: false, mainVisto: false };
            starts.push(cur);
          }
        }
      }
    }
    // avanzar contando paréntesis y ';'
    for (let k = i; k < fin; k++) {
      const ch = c[k];
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ';' && depth === 0 && cur && k >= (cur.ini || 0)) cur.cerrado = true;
    }
    i = fin + 1;
  }

  const sentencias = starts.filter((s) => s.kind !== 'GO');
  const cortes = starts.map((s) => s.ini).sort((a, b) => a - b);
  // fin de cada sentencia = último carácter de código antes del siguiente inicio (GO incluido)
  const items = [];
  let inicioRegion = 0;
  for (let idx = 0; idx < sentencias.length; idx++) {
    const s = sentencias[idx];
    const siguiente = cortes.find((x) => x > s.ini);
    const limite = siguiente === undefined ? n : siguiente;
    let fin = limite;
    while (fin > s.ini && /\s/.test(c[fin - 1])) fin--;
    const texto = original.slice(inicioRegion, fin)
      .split('\n')
      .filter((l) => !/^\s*GO\s*\d*\s*$/i.test(l))
      .join('\n')
      .replace(/^\s*\n+/, '')
      .trimEnd();
    items.push({ kind: s.kind, texto, ini: s.ini, fin });
    inicioRegion = fin;
  }
  // comentarios sueltos al final: se pegan al último bloque
  if (items.length && inicioRegion < original.length) {
    const cola = original.slice(inicioRegion).split('\n').filter((l) => !/^\s*GO\s*\d*\s*$/i.test(l)).join('\n').trim();
    if (cola) items[items.length - 1].texto += `\n${cola}`;
  }
  if (!items.length) {
    const t = original.trim();
    return t ? [{ kind: 'OTRO', texto: t, bd: '', orden: 1 }] : [];
  }

  // preámbulos (DECLARE/USE/SET) se pegan al bloque siguiente
  const bloques = [];
  let pre = [];
  let bdActual = '';
  const bdDe = (t) => { const m = /^\s*USE\s+(\[[^\]]+\]|\w+)/im.exec(t.replace(/^(\s*--.*\n|\s*\/\*[\s\S]*?\*\/\s*)+/g, '')); return m ? quitarComillas(m[1]) : ''; };
  for (const it of items) {
    if (it.kind === 'USE') { const b = bdDe(it.texto); if (b) bdActual = b; }
    if (clasePreambulo(it.kind)) { pre.push(it); continue; }
    const texto = pre.length ? [...pre.map((p) => p.texto), it.texto].join('\n') : it.texto;
    bloques.push({ kind: it.kind, texto, bd: bdActual, orden: bloques.length + 1 });
    pre = [];
  }
  if (pre.length) bloques.push({ kind: pre[pre.length - 1].kind, texto: pre.map((p) => p.texto).join('\n'), bd: bdActual, orden: bloques.length + 1 });
  return bloques;
}

// ---------------------------------------------------------------------------
// Títulos y descripciones a partir de comentarios
// ---------------------------------------------------------------------------
const PARECE_CODIGO = /^(and|or|where|select|from|inner|left|join|order|group|update|delete|insert|set|on|top|,|\(|\)|[\w.\[\]]+\s*(=|<>|>=|<=|in\b|like\b|is\b|between\b)|--)/i;

function limpiarComentario(l) {
  return l.replace(/^\s*(?:--+|\/\*+|\*+\/?|\*)\s*/, '').replace(/\s*\*+\/\s*$/, '').replace(/[-=_*#~]{3,}/g, ' ').replace(/\s+/g, ' ').trim();
}

function comentariosDe(texto) {
  const original = normalizarSaltos(texto);
  const { codigo } = escanear(original);
  const lo = original.split('\n');
  const lc = codigo.split('\n');
  const antes = [];
  const durante = [];
  let vistoCodigo = false;
  for (let k = 0; k < lo.length; k++) {
    const hayCodigo = lc[k] !== undefined && lc[k].trim() !== '';
    const hayTexto = lo[k].trim() !== '';
    if (hayCodigo) { vistoCodigo = true; continue; }
    if (!hayTexto) continue;
    const limpio = limpiarComentario(lo[k]);
    if (!limpio) continue;
    (vistoCodigo ? durante : antes).push(limpio);
  }
  return { antes, durante };
}

function sugerirTitulo(texto, analisis) {
  const { antes, durante } = comentariosDe(texto);
  const candidatos = [...antes, ...durante].filter((l) => l.length >= 4 && !PARECE_CODIGO.test(l) && /[A-Za-zÁÉÍÓÚáéíóúñÑ]{3}/.test(l));
  const titulo = candidatos[0] || '';
  const descripcion = candidatos.slice(1, 4).join(' · ');
  if (titulo) return { titulo: titulo.slice(0, 120), descripcion: descripcion.slice(0, 400) };
  const nombres = (analisis?.tablas || []).filter((t) => !t.escribe).slice(0, 2).map((t) => t.tabla);
  const alvo = (analisis?.tablas || []).filter((t) => t.escribe).slice(0, 1).map((t) => t.tabla);
  const verbo = { SELECT: 'Consulta', UPDATE: 'Actualización', DELETE: 'Borrado', INSERT: 'Inserción', MERGE: 'Merge', EXEC: 'Ejecución', TRUNCATE: 'Truncado', DDL: 'Cambio de estructura' }[analisis?.tipo] || 'Script';
  const objetivo = alvo.length ? alvo : nombres;
  return { titulo: (objetivo.length ? `${verbo} de ${objetivo.join(' y ')}` : verbo).slice(0, 120), descripcion: '' };
}

// ---------------------------------------------------------------------------
// Análisis de una sentencia / bloque
// ---------------------------------------------------------------------------
function analizarSql(sql, opciones = {}) {
  const original = normalizarSaltos(sql);
  const { mascara: m, codigo: c } = escanear(original);
  let bdPorDefecto = opciones.bd || '';
  const mUse = /\bUSE\s+(\[[^\]]+\]|\w+)/i.exec(c.replace(/\[[^\]]*\]/g, (x) => x));
  const mUseM = /\bUSE\s+(\[[^\]\n]+\]|\w+)/i.exec(m);
  if (mUseM) bdPorDefecto = quitarComillas(mUseM[1]);
  void mUse;

  // CTE
  const ctes = new Set();
  if (/^\s*;?\s*WITH\b/i.test(c.replace(/\bUSE\s+\S+\s*;?/gi, ''))) {
    const reCte = new RegExp(`(?:\\bWITH|,)\\s*(${ID})\\s*(?:\\([^)]*\\))?\\s+AS\\s*\\(`, 'gi');
    let mc;
    while ((mc = reCte.exec(m))) ctes.add(quitarComillas(mc[1]).toLowerCase());
  }

  const tablas = new Map();
  const aliases = []; // {alias, clave, pos}
  const temporales = new Set();
  const procedimientos = new Set();
  let usaOpenquery = false;
  let remoto = false;

  const agregarTabla = (partes, rol, escribe, pos, alias) => {
    if (!partes.length) return null;
    const ultimo = partes[partes.length - 1];
    if (esTemporal(ultimo)) { temporales.add(ultimo); return null; }
    const t = tablaDesdePartes(partes, bdPorDefecto);
    if (!t) return null;
    if (!t.bd && !t.esquemaExplicito && ctes.has(t.tabla.toLowerCase())) return null;
    if (t.servidor) remoto = true;
    const clave = `${t.servidor ? `${t.servidor.toLowerCase()}.` : ''}${claveTabla(t)}`;
    let reg = tablas.get(clave);
    if (!reg) {
      reg = { servidor: t.servidor, bd: t.bd, esquema: t.esquema, tabla: t.tabla, roles: new Set(), escribe: false, aliases: new Set(), veces: 0 };
      tablas.set(clave, reg);
    }
    reg.roles.add(rol);
    if (escribe) reg.escribe = true;
    reg.veces += 1;
    if (alias) { reg.aliases.add(alias); aliases.push({ alias: alias.toLowerCase(), clave, pos }); }
    return reg;
  };

  const reIni = new RegExp(`\\b(FROM|JOIN|USING|UPDATE|INTO|MERGE\\s+INTO|MERGE|TRUNCATE\\s+TABLE|DELETE(?:\\s+FROM)?)\\s+(${NOMBRE})`, 'gi');
  let mt;
  while ((mt = reIni.exec(m))) {
    const kw = mt[1].replace(/\s+/g, ' ').toUpperCase();
    const nombreTxt = mt[2];
    const partes = partirNombre(nombreTxt);
    const finNombre = mt.index + mt[0].length;
    const despues = m.slice(finNombre, finNombre + 3);
    const ultimo = partes[partes.length - 1] || '';
    const funcion = /^\s*\(/.test(despues);
    if (/^OPENQUERY$|^OPENROWSET$|^OPENDATASOURCE$/i.test(ultimo)) { usaOpenquery = true; continue; }
    // INTO precedido de INSERT / MERGE o de SELECT
    if (kw === 'FROM' || kw === 'JOIN' || kw === 'USING') {
      if (funcion) continue;
      // EXTRACT(x FROM y) / TRIM(... FROM y) / SUBSTRING(...FROM...)
      const previo = c.slice(Math.max(0, mt.index - 60), mt.index);
      if (kw === 'FROM' && /\b(EXTRACT|TRIM|SUBSTRING|OVERLAY)\s*\([^()]*$/i.test(previo)) continue;
    }
    const escribe = kw !== 'FROM' && kw !== 'JOIN' && kw !== 'USING';
    let alias = '';
    let cursor = finNombre;
    const ma = new RegExp(`^\\s*(?:AS\\s+)?(${ID})`, 'i').exec(m.slice(cursor));
    if (ma && !RESERVADAS.has(quitarComillas(ma[1]).toUpperCase()) && !(kw === 'INTO' && /^\s*\(/.test(m.slice(cursor)))) {
      const cand = quitarComillas(ma[1]);
      const tras = m.slice(cursor + ma[0].length, cursor + ma[0].length + 2);
      if (!/^\s*\(/.test(tras) || /^\s*AS\b/i.test(ma[0])) { alias = cand; cursor += ma[0].length; }
    }
    agregarTabla(partes, kw, escribe, mt.index, alias);
    // FROM a x, b y
    if (kw === 'FROM' || kw === 'JOIN') {
      let resto = m.slice(cursor);
      for (let guard = 0; guard < 20; guard++) {
        const mc = new RegExp(`^\\s*,\\s*(${NOMBRE})`, 'i').exec(resto);
        if (!mc) break;
        const p2 = partirNombre(mc[1]);
        let consumido = mc[0].length;
        let al = '';
        const ma2 = new RegExp(`^\\s*(?:AS\\s+)?(${ID})`, 'i').exec(resto.slice(consumido));
        if (ma2 && !RESERVADAS.has(quitarComillas(ma2[1]).toUpperCase()) && !/^\s*\(/.test(resto.slice(consumido + ma2[0].length, consumido + ma2[0].length + 2))) {
          al = quitarComillas(ma2[1]);
          consumido += ma2[0].length;
        }
        if (/^\s*\(/.test(resto.slice(mc[0].length, mc[0].length + 2))) break;
        agregarTabla(p2, 'FROM', false, finNombre, al);
        resto = resto.slice(consumido);
      }
    }
  }

  // Tablas dentro de OPENQUERY(servidor, 'select ...')
  const reOq = new RegExp(`\\bOPENQUERY\\s*\\(\\s*(${ID})\\s*,\\s*N?'((?:[^']|'')*)'\\s*\\)`, 'gi');
  let mo;
  while ((mo = reOq.exec(original))) {
    usaOpenquery = true;
    const servidorOq = quitarComillas(mo[1]);
    let interno;
    try { interno = analizarSql(mo[2].replace(/''/g, "'"), {}); } catch { interno = null; }
    for (const t of interno?.tablas || []) {
      const clave = `${servidorOq.toLowerCase()}.${(t.bd || '').toLowerCase()}.${(t.esquema || 'dbo').toLowerCase()}.${t.tabla.toLowerCase()}`;
      remoto = true;
      if (!tablas.has(clave)) tablas.set(clave, { servidor: servidorOq, bd: t.bd || '', esquema: t.esquema, tabla: t.tabla, roles: new Set(['OPENQUERY']), escribe: false, aliases: new Set(), veces: 1 });
    }
  }

  // El destino de UPDATE a SET ... FROM tabla a: «a» es un alias, no una tabla
  const aliasConocidos = new Set(aliases.map((a) => a.alias));
  for (const [clave, reg] of [...tablas.entries()]) {
    if (!reg.bd && !reg.servidor && !reg.roles.has('FROM') && !reg.roles.has('JOIN') && aliasConocidos.has(reg.tabla.toLowerCase())) {
      const destino = aliases.find((a) => a.alias === reg.tabla.toLowerCase());
      const real = destino && tablas.get(destino.clave);
      if (real && real !== reg) { if (reg.escribe) real.escribe = true; real.roles.add('UPDATE'); tablas.delete(clave); }
    }
  }

  // Procedimientos
  const reExec = new RegExp(`\\bEXEC(?:UTE)?\\s+(?:@\\w+\\s*=\\s*)?(${NOMBRE})`, 'gi');
  let me;
  while ((me = reExec.exec(c.length === m.length ? m : m))) {
    const p = partirNombre(me[1]);
    const nombre = p.filter(Boolean).join('.');
    if (nombre && !/^\(/.test(nombre)) procedimientos.add(nombre);
  }

  // Operaciones
  const ops = new Set();
  if (/\bSELECT\b/i.test(c)) ops.add('SELECT');
  const destinosEscritura = (re) => { const out = []; let x; while ((x = re.exec(c))) out.push(x[1]); return out; };
  const hayPersistente = (nombres) => nombres.some((nm) => { const p = partirNombre(nm); return p.length && !esTemporal(p[p.length - 1]); });
  const detectar = (op, re) => {
    if (!re.test(c)) return;
    const reg = new RegExp(re.source, 'gi');
    const destinos = [];
    let x;
    while ((x = reg.exec(m))) destinos.push(x[1] || '');
    if (!destinos.length || destinos.some((d) => !d || !esTemporal(partirNombre(d).pop() || ''))) ops.add(op);
    void destinosEscritura; void hayPersistente;
  };
  detectar('INSERT', new RegExp(`\\bINSERT\\s+(?:INTO\\s+)?(${NOMBRE})`, 'i'));
  detectar('UPDATE', new RegExp(`\\bUPDATE\\s+(?:TOP\\s*\\(\\s*\\d+\\s*\\)\\s+)?(${NOMBRE})\\s+(?:\\w+\\s+)?SET\\b`, 'i'));
  detectar('DELETE', new RegExp(`\\bDELETE\\s+(?:TOP\\s*\\(\\s*\\d+\\s*\\)\\s+)?(?:FROM\\s+)?(${NOMBRE})`, 'i'));
  detectar('MERGE', new RegExp(`\\bMERGE\\s+(?:INTO\\s+)?(${NOMBRE})`, 'i'));
  detectar('TRUNCATE', new RegExp(`\\bTRUNCATE\\s+TABLE\\s+(${NOMBRE})`, 'i'));
  detectar('DDL', new RegExp(`\\b(?:CREATE|DROP|ALTER)\\s+(?:OR\\s+ALTER\\s+)?(?:UNIQUE\\s+)?(?:CLUSTERED\\s+|NONCLUSTERED\\s+)?(?:TABLE|VIEW|PROC(?:EDURE)?|FUNCTION|INDEX|DATABASE|TRIGGER|SCHEMA|LOGIN|USER|SEQUENCE|TYPE|STATISTICS|ROLE)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(${NOMBRE})`, 'i'));
  // SELECT ... INTO tabla
  const reInto = /\bINTO\s+([#@\w\[\]."]+)/gi;
  let mi;
  while ((mi = reInto.exec(m))) {
    const previa = palabraAnterior(c, mi.index);
    const antes2 = c.slice(Math.max(0, mi.index - 30), mi.index);
    if (/\b(INSERT|MERGE)\s*$/i.test(antes2) || previa === 'INSERT' || previa === 'MERGE') continue;
    if (!esTemporal(partirNombre(mi[1]).pop() || '')) ops.add('INSERT');
  }
  if (/\bGRANT\b|\bREVOKE\b|\bDENY\b|\bBACKUP\b|\bRESTORE\b|\bDBCC\b|\bBULK\s+INSERT\b|\bSHUTDOWN\b/i.test(c)) ops.add('DDL');
  if (procedimientos.size) ops.add('EXEC');

  const MODIFICAN = ['DELETE', 'UPDATE', 'INSERT', 'MERGE', 'TRUNCATE', 'DDL'];
  const modifica = MODIFICAN.some((o) => ops.has(o));
  const tipo = MODIFICAN.find((o) => ops.has(o)) || (ops.has('EXEC') ? 'EXEC' : ops.has('SELECT') ? 'SELECT' : 'OTRO');
  const nivelRiesgo = modifica ? 'modifica' : ops.has('EXEC') ? 'procedimiento' : 'lectura';

  // JOIN por igualdades alias.col = alias.col
  const resolver = (calif, pos) => {
    const q = quitarComillas(calif).toLowerCase();
    let hallado = null;
    for (const a of aliases) if (a.alias === q && a.pos <= pos) hallado = a;
    if (!hallado) hallado = aliases.find((a) => a.alias === q);
    if (hallado) return tablas.get(hallado.clave) || null;
    for (const reg of tablas.values()) if (!reg.aliases.size && reg.tabla.toLowerCase() === q) return reg;
    for (const reg of tablas.values()) if (reg.tabla.toLowerCase() === q) return reg;
    return null;
  };
  const joins = [];
  const vistos = new Set();
  const rePar = new RegExp(`(${ID})\\s*\\.\\s*(${ID})\\s*(=)\\s*(${ID})\\s*\\.\\s*(${ID})`, 'g');
  let mp;
  while ((mp = rePar.exec(m))) {
    const a = resolver(mp[1], mp.index);
    const b = resolver(mp[4], mp.index);
    if (!a || !b || a === b) continue;
    const ca = quitarComillas(mp[2]);
    const cb = quitarComillas(mp[5]);
    const refA = { bd: a.bd, esquema: a.esquema, tabla: a.tabla, columna: ca };
    const refB = { bd: b.bd, esquema: b.esquema, tabla: b.tabla, columna: cb };
    const kA = `${claveTabla(a)}.${ca.toLowerCase()}`;
    const kB = `${claveTabla(b)}.${cb.toLowerCase()}`;
    const clave = kA < kB ? `${kA}=${kB}` : `${kB}=${kA}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    joins.push(kA < kB ? { a: refA, b: refB } : { a: refB, b: refA });
  }

  // Columnas que se filtran en el WHERE (alias.col = …): sirven para sugerir filtros en el constructor.
  const filtros = [];
  if (!modifica) {
    const iw = m.search(/\bWHERE\b/i);
    if (iw >= 0) {
      const unica = tablas.size === 1 ? [...tablas.values()][0] : null;
      const OPS = String.raw`(<>|!=|>=|<=|=|>|<|\bNOT\s+LIKE\b|\bLIKE\b|\bNOT\s+IN\b|\bIN\b|\bBETWEEN\b|\bIS\s+NOT\s+NULL\b|\bIS\s+NULL\b)`;
      const reF = new RegExp(String.raw`(?<![\w.\]\[@#$])(?:(${ID})\s*\.\s*)?(${ID})\s*${OPS}`, 'gi');
      const resto = m.slice(iw);
      const traducir = (o) => {
        const u = o.replace(/\s+/g, ' ').toUpperCase();
        if (u === '=') return 'eq';
        if (u === '<>' || u === '!=') return 'ne';
        if (['>', '>=', '<', '<='].includes(u)) return 'cmp';
        if (u === 'LIKE') return 'contiene';
        if (u === 'NOT LIKE') return 'nocontiene';
        if (u === 'IN') return 'en';
        if (u === 'NOT IN') return 'noen';
        if (u === 'BETWEEN') return 'entre';
        if (u === 'IS NULL') return 'nulo';
        return 'nonulo';
      };
      const vistosF = new Set();
      let mf;
      while ((mf = reF.exec(resto)) && filtros.length < 40) {
        const col = quitarComillas(mf[2]);
        if (RESERVADAS.has(col.toUpperCase()) || /^\d/.test(col)) continue;
        const op = traducir(mf[3]);
        const cola = resto.slice(mf.index + mf[0].length);
        if (op === 'eq' && new RegExp(String.raw`^\s*${ID}\s*\.\s*${ID}\s*(?!\s*\()`, 'i').test(cola) && !/^\s*\w+\s*\.\s*\w+\s*\(/.test(cola)) continue;
        let reg = null;
        if (mf[1]) reg = resolver(mf[1], iw + mf.index); else reg = unica;
        if (!reg || reg.servidor) continue;
        const k = `${claveTabla(reg)}.${col.toLowerCase()}.${op}`;
        if (vistosF.has(k)) continue;
        vistosF.add(k);
        filtros.push({ bd: reg.bd, esquema: reg.esquema, tabla: reg.tabla, columna: col, op });
      }
    }
  }

  const lista = [...tablas.values()].map((t) => ({
    servidor: t.servidor || '', bd: t.bd || '', esquema: t.esquema, tabla: t.tabla,
    escribe: t.escribe, roles: [...t.roles], aliases: [...t.aliases],
  }));
  const parametros = [...new Set((c.match(/(?<![@\w])@(?!@)[A-Za-z_]\w*/g) || []).map((x) => x.toLowerCase()))];
  const resultado = {
    tipo, operaciones: [...ops], modifica, nivelRiesgo,
    tablas: lista, joins, filtros, procedimientos: [...procedimientos],
    tablasTemporales: [...temporales], parametros,
    usaOpenquery, remoto, tieneSecretos: detectarSecretos(original),
    bd: bdPorDefecto,
    huella: huellaSql(original),
  };
  return resultado;
}

function huellaSql(sql) {
  const { codigo } = escanear(normalizarSaltos(sql));
  const normal = codigo.replace(/'[^']*'/g, "'?'").replace(/\b\d+(?:\.\d+)?\b/g, '0').replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase();
  return crypto.createHash('sha1').update(normal).digest('hex');
}

// ---------------------------------------------------------------------------
// Validación de solo lectura (para ejecutar desde la herramienta)
// ---------------------------------------------------------------------------
const PROHIBIDAS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY',
  'BACKUP', 'RESTORE', 'SHUTDOWN', 'RECONFIGURE', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'WAITFOR', 'DBCC', 'BULK', 'KILL',
  'INTO', 'DECLARE', 'USE', 'SET', 'PRINT', 'RAISERROR', 'THROW', 'COMMIT', 'ROLLBACK', 'BEGIN', 'ENABLE', 'DISABLE', 'OUTPUT', 'READTEXT', 'WRITETEXT', 'UPDATETEXT',
];
const RE_PROHIBIDAS = new RegExp(`\\b(${PROHIBIDAS.join('|')})\\b`, 'i');

function validarSoloLectura(sql) {
  const original = normalizarSaltos(sql).trim();
  if (!original) return { ok: false, motivo: 'La consulta está vacía.' };
  if (original.length > 60000) return { ok: false, motivo: 'La consulta es demasiado larga para ejecutarla desde aquí.' };
  const { codigo } = escanear(original);
  let c = codigo.trim();
  c = c.replace(/;\s*$/, '').trim();
  if (!c) return { ok: false, motivo: 'La consulta solo tiene comentarios.' };
  if (/;/.test(c)) return { ok: false, motivo: 'Solo se permite una sentencia a la vez (sin «;» intermedios).' };
  if (/\bGO\b/i.test(c)) return { ok: false, motivo: 'Quita las líneas «GO»: solo se ejecuta una sentencia.' };
  if (!/^(SELECT|WITH)\b/i.test(c)) return { ok: false, motivo: 'Solo se pueden ejecutar consultas que empiecen por SELECT (o WITH … SELECT).' };
  const prohibida = RE_PROHIBIDAS.exec(c);
  if (prohibida) {
    const p = prohibida[1].toUpperCase();
    if (p === 'INTO') return { ok: false, motivo: 'SELECT … INTO crea tablas; no se permite.' };
    if (p === 'OPENQUERY' || p === 'OPENROWSET' || p === 'OPENDATASOURCE') return { ok: false, motivo: `${p} no está permitido: consulta directamente la base de datos de origen.` };
    return { ok: false, motivo: `La palabra «${p}» no está permitida: solo se ejecutan consultas de lectura.` };
  }
  if (/\b(?:xp_|sp_)\w*/i.test(c)) return { ok: false, motivo: 'No se permiten procedimientos del sistema (xp_/sp_).' };
  if (/\bFOR\s+(?:XML|JSON)\b/i.test(c) === false && /\bOPTION\s*\(/i.test(c) && /\bMAXRECURSION\s+0\b/i.test(c)) {
    return { ok: false, motivo: 'MAXRECURSION 0 (recursión sin límite) no está permitido.' };
  }
  return { ok: true, sql: original.replace(/;\s*$/, '') };
}

// Quita un «USE base;» inicial (la base se fija al conectar) y devuelve la base indicada.
function separarUse(sql) {
  const original = normalizarSaltos(sql);
  const { codigo, mascara } = escanear(original);
  const m = /^\s*USE\s+(\[[^\]\n]+\]|\w+)\s*;?/i.exec(codigo);
  if (!m) return { bd: '', sql: original.trim() };
  const nombre = quitarComillas(/^\s*USE\s+(\[[^\]\n]+\]|\w+)/i.exec(mascara)[1]);
  const resto = original.slice(m[0].length).replace(/^\s*\n/, '');
  return { bd: nombre, sql: resto.trim() };
}

module.exports = {
  separarUse,
  decodificarBuffer,
  normalizarSaltos,
  escanear,
  analizarSql,
  dividirBloques,
  sugerirTitulo,
  enmascarar,
  detectarSecretos,
  validarSoloLectura,
  huellaSql,
  claveTabla,
  partirNombre,
};
