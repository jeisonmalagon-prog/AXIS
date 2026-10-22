// ==========================================================================
// LECTURA Y TRADUCCIÓN DE FILAS DE LogApp (App Móvil)
// ==========================================================================
// Módulo PURO (sin base de datos). Hace dos cosas con las filas de LogApp.Log:
//
//   1) LEER el resultado real de una fila (¿respondió bien?, ¿con error?,
//      ¿sin datos?, ¿se agotó el tiempo?) -> interpretarApi / interpretarSoap /
//      interpretarError / clasificarFilaLog. Lo usan el recorrido del cliente
//      (appMovilTraza.js) y el visor de logs, para que ambos digan lo mismo.
//
//   2) TRADUCIR el RQ (lo que la app pidió), el RS (lo que respondió el
//      servicio) y los DATOS (columna Adicional) a lenguaje que entienda una
//      persona no técnica -> traducirFila: campos con nombre en español, listas
//      como tablas, códigos explicados, y el texto original siempre disponible.
//
// Reglas de lectura (verificadas con exportaciones reales de LogApp):
//   * "Inicia flujo - <ruta>" no trae Rs ni Rq a propósito: su Adicional es lo
//     que la app envió. Una fila sin Rs/Rq/Datos NO significa que el servicio
//     no respondió: la respuesta vive en las filas siguientes de la operación.
//   * "API-<verbo>-<url>": Rs = "Status: NNN - <cuerpo>". El éxito real depende
//     del HTTP y del código de negocio que viene dentro del cuerpo.
//   * "Cnnn-<servicio>-<operación>": llamada SOAP al bus de integración (ACE).
//     El resultado está en los bloques <Status>/<AdditionalStatus>
//     (StatusCode + Severity + StatusDesc) o en un <faultstring>.
//     OJO: "StatusDesc" también aparece dentro de los datos (estado de una
//     cuenta: "ACTIVA", "Open"...), por eso solo se leen los bloques de estado.
//   * TipoCodigo 3 / "Error ..." = error registrado por la app. Puede ser
//     inofensivo (el mapper usa un valor por defecto cuando ACE dice "sin datos").
//
// Privacidad: este módulo NO oculta nada. Muestra el contenido tal como está
// en el log (decisión del negocio: el visor es de uso interno y auditado).
// ==========================================================================

const { leerFallaSoap } = require('./appMovilCodigos');

const RE_INICIO = /^Inicia flujo\s*-?\s*(.*)$/i;
const RE_API = /^(ERROR-)?API-(get|post|put|patch|delete|head|options)-(.+)$/i;
const RE_SOAP = /^C(\d{3})-([^-]+)-(.+)$/;
const RE_SIN_DATOS = /no se encontraron datos|no obtuvo resultados|no arroj[oó] (?:ning[uú]n )?resultado|sin resultados?|no se encontr[oó]|no existe(?:n)? (?:registros|informaci[oó]n|datos)|no hay (?:datos|registros)|no (?:tiene|posee) /i;
const RE_VALOR_DEFECTO = /valor por defecto|toma el valor|se simula/i;

// ------------------------------------------------------------------ utilidades
function desescapar(valor) {
  try { return JSON.parse(`"${valor}"`); } catch (e) { return valor; }
}

function limpiarTexto(texto, max = 240) {
  let t = String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim();
  t = t.replace(/^"+|"+$/g, '').replace(/^Error:\s*/i, '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function sinStack(texto) {
  const t = String(texto || '');
  const i = t.indexOf(' -- STACK');
  return i >= 0 ? t.slice(0, i) : t;
}

function stackDe(texto) {
  const t = String(texto || '');
  const i = t.indexOf(' -- STACK');
  return i >= 0 ? t.slice(i + 9).replace(/^:\s*/, '').replace(/\\n/g, '\n').trim() : '';
}

function textoDe(valor) { return valor == null ? '' : String(valor); }

// ------------------------------------------------- explicación de errores comunes
/** Traduce el texto técnico de un error a una frase que entienda cualquier persona. */
function explicarMensaje(texto) {
  const t = String(texto || '');
  if (/ECONNREFUSED/i.test(t)) return 'La conexión fue rechazada: el servicio de destino no está recibiendo llamadas.';
  if (/Timeout\. Integration node|did not provide a response within/i.test(t)) return 'El servidor de integración del banco (ACE) no respondió dentro del tiempo máximo permitido.';
  if (/A timeout occurred during processing/i.test(t)) return 'El sistema del banco no respondió a tiempo (se agotó el tiempo de espera).';
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|timeout/i.test(t)) return 'El servicio tardó demasiado y se agotó el tiempo de espera.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(t)) return 'No se pudo encontrar el servidor de destino (problema de nombre/red).';
  if (/ECONNRESET|socket hang up/i.test(t)) return 'La conexión se cortó antes de recibir la respuesta completa.';
  if (/certificate|SSL|TLS|self.signed/i.test(t)) return 'Problema con el certificado de seguridad de la conexión.';
  if (/Estamos teniendo problemas conect[aá]ndonos con el Banco/i.test(t)) return 'La app mostró al cliente "Estamos teniendo problemas conectándonos con el Banco": el sistema del banco no respondió a tiempo.';
  if (/GatewayTimeout/i.test(t)) return 'El sistema del banco no respondió a tiempo (Gateway Timeout).';
  if (/unauthorized|401/i.test(t) && /token|auth/i.test(t)) return 'La sesión o el token del cliente no es válido o venció.';
  return null;
}

function textoHttp(codigo) {
  if (codigo === 400) return 'Solicitud inválida (HTTP 400)';
  if (codigo === 401) return 'No autorizado (HTTP 401): token vencido o inválido';
  if (codigo === 403) return 'Acceso denegado (HTTP 403)';
  if (codigo === 404) return 'No encontrado (HTTP 404)';
  if (codigo === 408) return 'Tiempo de espera agotado (HTTP 408)';
  if (codigo === 429) return 'Demasiadas solicitudes (HTTP 429)';
  if (codigo >= 500 && codigo < 600) return `Error interno del servicio (HTTP ${codigo})`;
  if (codigo >= 200 && codigo < 300) return `Respuesta correcta (HTTP ${codigo})`;
  return `Respuesta HTTP ${codigo}`;
}

// ============================================================================
// PARSERS TOLERANTES (el log puede traer cuerpos cortados o con escapes raros)
// ============================================================================
/** Cierra comillas/llaves de un JSON cortado para poder leer lo que sí llegó. */
function repararJsonCortado(texto) {
  let s = texto;
  const pila = [];
  let enCadena = false;
  let escapado = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (enCadena) {
      if (escapado) escapado = false;
      else if (ch === '\\') escapado = true;
      else if (ch === '"') enCadena = false;
      continue;
    }
    if (ch === '"') enCadena = true;
    else if (ch === '{') pila.push('}');
    else if (ch === '[') pila.push(']');
    else if (ch === '}' || ch === ']') pila.pop();
  }
  if (enCadena) s += '"';
  // Quitar un fragmento final incompleto: una coma, "clave": sin valor, etc.
  s = s.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/:\s*$/, ': null');
  return s + pila.reverse().join('');
}

function parseJsonTolerante(texto) {
  const t = String(texto || '').trim();
  if (!t) return { ok: false };
  const intentos = [t];
  // Escapes dobles que deja el log: {\status\":{\"code\":0 ...
  intentos.push(t.replace(/\\"/g, '"').replace(/([{,])\\(\w)/g, '$1"$2'));
  for (const candidato of intentos) {
    try { return { ok: true, valor: JSON.parse(candidato), truncado: false }; } catch (e) { /* sigue */ }
  }
  for (const candidato of intentos) {
    try { return { ok: true, valor: JSON.parse(repararJsonCortado(candidato)), truncado: true }; } catch (e) { /* sigue */ }
  }
  return { ok: false };
}

function decodificarEntidades(t) {
  return t
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

/** Árbol XML mínimo: { n: nombre sin prefijo, a: atributos, h: hijos, t: texto }. */
function parseXml(texto) {
  const s = String(texto || '');
  const raiz = { n: '#raiz', a: {}, h: [], t: '' };
  const pila = [raiz];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/\s*([\w:.-]+)\s*>|<\s*([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const actual = pila[pila.length - 1];
    if (m[1] !== undefined) { actual.t += m[1]; continue; }
    if (m[2] !== undefined) {
      const nombre = m[2].replace(/^[\w.-]+:/, '');
      // Cierra hasta el elemento que coincide (tolera cierres que faltan).
      for (let i = pila.length - 1; i > 0; i--) {
        if (pila[i].n === nombre) { pila.length = i; break; }
      }
      continue;
    }
    if (m[3] !== undefined) {
      const nodo = { n: m[3].replace(/^[\w.-]+:/, ''), a: {}, h: [], t: '' };
      const ra = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ra.exec(m[4] || ''))) {
        if (!/^xmlns/i.test(a[1])) nodo.a[a[1].replace(/^[\w.-]+:/, '')] = a[2] !== undefined ? a[2] : a[3];
      }
      actual.h.push(nodo);
      if (m[5] !== '/') pila.push(nodo);
      continue;
    }
    if (m[6] !== undefined && m[6].trim()) actual.t += decodificarEntidades(m[6]);
  }
  return raiz;
}

function buscarNodos(nodo, nombre, salida = []) {
  for (const h of nodo.h) {
    if (h.n === nombre) salida.push(h);
    buscarNodos(h, nombre, salida);
  }
  return salida;
}

function textoHijo(nodo, nombre) {
  const h = nodo.h.find((x) => x.n === nombre);
  return h ? h.t.trim() : null;
}

// ============================================================================
// ESTADO DEL RESULTADO (códigos, severidad, mensajes)
// ============================================================================
// Claves (en minúsculas) con las que los servicios del banco informan el resultado de negocio.
const CLAVES_CODIGO_FUERTES = ['statuscode', 'codstatus', 'statuscod'];
const CLAVES_DESC = ['statusdesc', 'descstatus', 'message', 'mensaje', 'desc'];

/** Valor de la primera clave (sin distinguir mayúsculas) que exista EN ESTE objeto (sin bajar a los hijos). */
function claveEn(obj, claves) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  for (const k of Object.keys(obj)) if (claves.includes(k.toLowerCase())) return obj[k];
  return undefined;
}

/** Busca una clave en el objeto y en sus objetos hijos (hasta `prof` niveles; las listas de datos no se recorren). */
function claveProfunda(obj, claves, prof = 2) {
  const v = claveEn(obj, claves);
  if (v !== undefined) return v;
  if (prof <= 0 || !obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  for (const hijo of Object.values(obj)) {
    if (hijo && typeof hijo === 'object' && !Array.isArray(hijo)) {
      const r = claveProfunda(hijo, claves, prof - 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

const aEntero = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
};

/**
 * Código, descripción y éxito de negocio de una respuesta JSON.
 * Si el cuerpo es un JSON completo solo se leen el bloque "status" y el primer nivel: un "code" o "success"
 * que viaja DENTRO de los datos (por ejemplo ultimoCaso.code) NO es el resultado de la llamada.
 * Si el cuerpo viene cortado (no es JSON válido) se usa la lectura por texto de siempre.
 */
function leerCodigoDesc(cuerpo) {
  let obj = null;
  try { obj = JSON.parse(cuerpo); } catch { obj = null; }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const st = claveEn(obj, ['status']);
    const zona = st && typeof st === 'object' && !Array.isArray(st) ? st : obj;
    let cod = aEntero(claveEn(zona, [...CLAVES_CODIGO_FUERTES, 'code']));
    if (cod === null) cod = aEntero(claveProfunda(obj, CLAVES_CODIGO_FUERTES));
    let desc = claveEn(zona, CLAVES_DESC);
    if (typeof desc !== 'string') desc = claveProfunda(obj, ['statusdesc', 'descstatus', 'message', 'mensaje']);
    const exito = claveEn(zona, ['success']) !== undefined ? claveEn(zona, ['success']) : claveEn(obj, ['success']);
    return {
      codigo: cod,
      desc: typeof desc === 'string' ? desescapar(desc) : null,
      success: typeof exito === 'boolean' ? exito : (exito === 'true' ? true : exito === 'false' ? false : null)
    };
  }
  // Cuerpo cortado o que no es JSON: lectura por texto.
  const bloque = /"status"\s*:\s*\{([^{}]*)\}/i.exec(cuerpo);
  const zona = bloque ? bloque[1] : cuerpo;
  const cod = /"(?:statusCode|StatusCode|codStatus|statusCod|code)"\s*:\s*"?(-?\d+)"?/.exec(zona)
    || /"(?:statusCode|StatusCode|codStatus|statusCod)"\s*:\s*"?(-?\d+)"?/.exec(cuerpo);
  const desc = /"(?:statusDesc|StatusDesc|descStatus|message|Message|mensaje|desc)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(zona)
    || /"(?:statusDesc|StatusDesc|descStatus|message|Message|mensaje)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(cuerpo);
  const exito = /"(?:Success|success)"\s*:\s*(true|false)/.exec(cuerpo);
  return {
    codigo: cod ? parseInt(cod[1], 10) : null,
    desc: desc ? desescapar(desc[1]) : null,
    success: exito ? exito[1] === 'true' : null
  };
}

/** Bloques de estado de una respuesta SOAP: [{adicional, codigo, severidad, desc}]. */
function leerBloquesSoap(rs) {
  const bloques = [];
  const leer = (cuerpo, adicional) => {
    const codigo = /<(?:\w+:)?StatusCode>\s*([^<\s]*)\s*</.exec(cuerpo);
    const servidor = /<(?:\w+:)?ServerStatusCode>\s*([^<\s]*)\s*</.exec(cuerpo);
    const sev = /<(?:\w+:)?Severity>\s*([^<]*?)\s*</.exec(cuerpo);
    const desc = /<(?:\w+:)?StatusDesc>([^<]*)</.exec(cuerpo);
    if (!codigo && !sev && !desc) return;
    bloques.push({
      adicional,
      codigo: codigo && codigo[1] !== '' ? codigo[1] : null,
      serverCodigo: servidor && servidor[1] !== '' ? servidor[1] : null,
      severidad: sev ? sev[1] : null,
      desc: desc ? decodificarEntidades(desc[1]).trim() : ''
    });
  };
  // <Status> contiene a su <AdditionalStatus>: del Status solo se lee su propio nivel.
  const reStatus = /<(?:\w+:)?Status>([\s\S]*?)<\/(?:\w+:)?Status>/g;
  let m;
  while ((m = reStatus.exec(rs))) {
    leer(m[1].replace(/<(?:\w+:)?AdditionalStatus>[\s\S]*?<\/(?:\w+:)?AdditionalStatus>/g, ''), false);
  }
  const reAdic = /<(?:\w+:)?AdditionalStatus>([\s\S]*?)<\/(?:\w+:)?AdditionalStatus>/g;
  while ((m = reAdic.exec(rs))) leer(m[1], true);
  return bloques;
}

function esCodigoOk(c) {
  if (c === null || c === undefined || c === '') return true;
  const n = parseInt(c, 10);
  if (!Number.isFinite(n)) return true;
  return n === 0 || (n >= 200 && n < 300);
}

// ============================================================================
// INTERPRETACIÓN POR TIPO DE FILA (devuelve el "item" que usa el recorrido)
// ============================================================================
function interpretarApi(fila, m) {
  const esErrorPrefijo = !!m[1];
  const verbo = m[2].toUpperCase();
  const url = m[3].trim();
  const sinHost = url.replace(/^https?:\/\//i, '');
  const host = /^https?:\/\//i.test(url) ? sinHost.split('/')[0] : '';
  const ruta = '/' + (sinHost.includes('/') ? sinHost.split('/').slice(1).join('/') : '');
  const rs = fila.Rs == null ? '' : String(fila.Rs) + (fila.RsFin ? ` … ${fila.RsFin}` : '');
  const urlSinConfigurar = /^undefined/i.test(sinHost);
  const rutaMostrada = urlSinConfigurar ? `‹base sin configurar›/${sinHost.replace(/^undefined\/?/i, '')}` : ruta;
  const titulo = `${verbo} ${rutaMostrada.length > 70 ? `${rutaMostrada.slice(0, 69)}…` : rutaMostrada}`;
  const item = { tipo: 'api', titulo, destino: host || null, nivel: 'ok', texto: '', codigo: null };

  const st = /^Status:\s*(\d{3})\s*-?\s*([\s\S]*)$/i.exec(rs);

  if (!st) {
    // Sin "Status:": excepción de red (Rs = "Error: connect ECONNREFUSED ...").
    const msg = limpiarTexto(sinStack(rs) || 'La llamada falló sin respuesta');
    const causa = explicarMensaje(`${sinHost} ${rs}`);
    item.nivel = 'error';
    item.texto = causa ? `${causa} (${msg})` : msg;
    if (urlSinConfigurar) {
      item.texto = `La URL base del servicio no está configurada: la llamada se armó contra "undefined…" y terminó apuntando a localhost (${msg}). Revisar la variable de entorno/URL de este servicio en el backend de la app.`;
    }
    return item;
  }

  const http = parseInt(st[1], 10);
  const cuerpo = st[2] || '';
  item.codigo = http;
  const { codigo, desc, success } = leerCodigoDesc(cuerpo);
  const hayDatos = desc && RE_SIN_DATOS.test(desc);
  item.codigos = { codigoNegocio: codigo, desc: desc ? limpiarTexto(desc, 160) : null };

  // HTTP >= 400 es una falla. Una línea ERROR-API con HTTP 2xx/3xx NO lo es por sí sola: la app anota ERROR-API también
  // cuando su propia validación de negocio no le gustó una respuesta que el servicio dio como correcta. Se juzga por el cuerpo.
  if (http >= 400) {
    const detalle = desc ? `${textoHttp(http)}: ${limpiarTexto(desc)}` : textoHttp(http);
    item.nivel = hayDatos && http < 500 ? 'aviso' : 'error';
    item.texto = detalle;
    return item;
  }
  if (success === false) {
    item.nivel = hayDatos ? 'info' : 'error';
    item.texto = `El servicio respondió HTTP ${http} pero indicó que NO fue exitoso (Success=false)${desc ? `: ${limpiarTexto(desc)}` : ''}`;
    item.sinDatos = !!hayDatos;
    return item;
  }
  // Respuestas "problem details" / errores en el cuerpo aunque el HTTP sea 200.
  const errorCuerpo = /^\s*\{\s*"(?:error|errors|exception|Error|Errors)"\s*:\s*(?!null|false|""|\[\s*\]|\{\s*\})/.exec(cuerpo)
    || /"type"\s*:\s*"https?:\/\/[^"]*(?:rfc|httpstatuses)[^"]*"/i.exec(cuerpo);
  if (errorCuerpo) {
    item.nivel = 'error';
    item.texto = `El servicio respondió HTTP ${http} pero el cuerpo describe un error${desc ? `: ${limpiarTexto(desc)}` : ''}`;
    return item;
  }
  const codigoBueno = codigo === null || esCodigoOk(codigo);
  if (!codigoBueno) {
    if (hayDatos || codigo === 100) {
      item.nivel = hayDatos ? 'info' : 'aviso';
      item.sinDatos = true;
      item.texto = `Sin resultados${desc ? `: ${limpiarTexto(desc)}` : ''} (código ${codigo})`;
    } else {
      item.nivel = 'error';
      item.texto = `El servicio respondió HTTP ${http} pero con código de negocio ${codigo}${desc ? `: ${limpiarTexto(desc)}` : ''}`;
    }
    return item;
  }
  if (/^\s*\[\s*\]\s*$/.test(cuerpo)) { item.texto = 'Respuesta correcta (lista vacía)'; item.sinDatos = true; item.nivel = 'info'; return item; }
  if (/"_xrv"/.test(cuerpo)) { item.texto = 'Respuesta correcta (el contenido viaja cifrado)'; return item; }
  if (esErrorPrefijo) {
    // El servicio respondió bien y el cuerpo no trae ninguna falla: no es un error del servicio.
    // (Con el cuerpo vacío no hay evidencia ni a favor ni en contra: se deja como aviso, que no cuenta como error.)
    item.nivel = cuerpo.trim() ? 'info' : 'aviso';
    item.registradaComoError = true;
    item.texto = `El servicio respondió HTTP ${http} y su respuesta no indica ninguna falla${desc ? ` («${limpiarTexto(desc, 100)}»)` : ''}. La app la anotó como ERROR-API en el log, pero no se cuenta como error del servicio.`;
    return item;
  }
  item.texto = desc ? `Correcta: ${limpiarTexto(desc, 120)}` : `Respuesta correcta (HTTP ${http})`;
  return item;
}

function interpretarSoap(fila, m) {
  const rs = fila.Rs == null ? '' : String(fila.Rs) + (fila.RsFin ? ` … ${fila.RsFin}` : '');
  const item = {
    tipo: 'soap',
    titulo: `ACE ${m[2]} · ${m[3]} (C${m[1]})`,
    destino: null,
    nivel: 'ok',
    texto: 'Respuesta correcta',
    codigo: null,
    // Id de la transacción en ACE (columna Transaccion de LogApp): sirve para rastrear la llamada en el bus.
    transaccion: fila.Transaccion ? String(fila.Transaccion) : null,
    servicioAce: { id: `C${m[1]}`, servicio: m[2], operacion: m[3].trim() }
  };
  const fault = /<(?:\w+:)?faultstring>([^<]*)</i.exec(rs);
  if (fault) {
    const causa = explicarMensaje(fault[1]);
    item.nivel = 'error';
    item.timeout = /timeout/i.test(fault[1]);
    item.falla = leerFallaSoap(rs);
    item.texto = causa ? `${causa} (${limpiarTexto(fault[1])})` : `Falla SOAP: ${limpiarTexto(fault[1])}`;
    return item;
  }
  const bloques = leerBloquesSoap(rs);
  if (!bloques.length) {
    if (!rs.trim()) { item.nivel = 'info'; item.texto = 'Esta fila no guarda el cuerpo de la respuesta'; }
    return item;
  }
  const principal = bloques[0];
  const n = parseInt(principal.codigo, 10);
  item.codigo = Number.isFinite(n) ? n : null;
  item.codigos = { bloques: bloques.slice(0, 6), desc: principal.desc || null };

  // Un bloque es error si trae código distinto de 0 Y su severidad es Error
  // (o no trae severidad). Un código 1 con severidad "Info" no es un error
  // (p. ej. setScoreApp devuelve 0, 1, 0 y es "Transacción exitosa").
  const malos = bloques.filter((b) => !esCodigoOk(b.codigo) && (!b.severidad || /^(error|fatal|critical)/i.test(b.severidad)));
  const ademasError = bloques.filter((b) => b.severidad && /^(error|fatal|critical)/i.test(b.severidad) && esCodigoOk(b.codigo));
  const problemas = [...malos, ...ademasError];
  if (!problemas.length) return item;

  const ultima = problemas[problemas.length - 1];
  const desc = ultima.desc || principal.desc || '';
  const textoTodos = problemas.map((b) => b.desc).join(' ');
  const hayDatos = RE_SIN_DATOS.test(textoTodos);
  const codigo = ultima.codigo !== null ? ultima.codigo : principal.codigo;
  item.sinDatos = hayDatos;
  item.nivel = hayDatos ? 'info' : 'error';
  item.texto = hayDatos
    ? `El sistema del banco respondió sin resultados (código ${codigo}): ${limpiarTexto(desc)}`
    : `El sistema del banco devolvió un error (código ${codigo})${desc ? `: ${limpiarTexto(desc)}` : ''}`;
  return item;
}

function interpretarError(fila) {
  const desc = String(fila.Descripcion || '');
  const crudo = String(fila.Adicional || fila.Rs || '');
  const msg = limpiarTexto(sinStack(crudo));
  const item = { tipo: 'error', titulo: limpiarTexto(desc, 90) || 'Error registrado', destino: null, nivel: 'error', texto: msg, codigo: null };
  if (/^Error Mapper/i.test(desc) && RE_VALOR_DEFECTO.test(desc)) {
    item.nivel = 'info';
    const quien = /\((\w+)\)/.exec(desc);
    const que = desc.replace(/^Error Mapper\s*(\(\w+\))?:?\s*/i, '');
    item.texto = `${quien ? `${quien[1]}: ` : ''}${limpiarTexto(que, 160)}${msg ? ` (el sistema del banco respondió: ${msg})` : ''}`;
    item.manejado = true;
    return item;
  }
  if (RE_SIN_DATOS.test(msg)) {
    item.nivel = 'aviso';
    item.texto = `La consulta no devolvió resultados y el servicio lo registró como error: ${msg}`;
    return item;
  }
  const causa = explicarMensaje(`${desc} ${msg}`);
  item.timeout = /timeout|tiempo de espera|problemas conect/i.test(`${desc} ${msg}`);
  if (causa) item.texto = msg && !/problemas conect/i.test(msg) ? `${causa} (${msg})` : causa;
  if (!item.texto) item.texto = 'Error registrado sin mensaje';
  return item;
}

function clasificar(fila) {
  const desc = String(fila.Descripcion || '');
  let m;
  if ((m = RE_INICIO.exec(desc))) return { tipo: 'inicio', ruta: limpiarTexto(m[1], 120) };
  if ((m = RE_API.exec(desc))) return { tipo: 'api', m };
  if ((m = RE_SOAP.exec(desc))) return { tipo: 'soap', m };
  if (Number(fila.TipoCodigo) === 3 || /^error\b/i.test(desc)) return { tipo: 'error' };
  return { tipo: 'paso' };
}

// ============================================================================
// ESTADO DE UNA FILA SUELTA (visor de logs)
// ============================================================================
const TIPOS_FILA = {
  inicio: 'Inicio de la operación',
  api: 'Llamada a un servicio interno',
  soap: 'Consulta al sistema del banco (ACE)',
  error: 'Error registrado',
  paso: 'Paso interno de la app'
};

/**
 * Estado de UNA fila, en palabras sencillas.
 *  estado: exito | error | aviso | inicio | paso | info
 * Una fila sin Rs/Rq/Datos NUNCA se considera "sin respuesta": el inicio de una
 * operación y los pasos internos no guardan respuesta por diseño.
 */
function clasificarFilaLog(fila) {
  const cls = clasificar(fila);
  const rs = textoDe(fila.Rs);
  const ad = textoDe(fila.Adicional);
  let item = null;

  if (cls.tipo === 'inicio') {
    return {
      tipo: 'inicio', tipoTexto: TIPOS_FILA.inicio, estado: 'inicio',
      estadoTexto: `Inicio de la operación${cls.ruta ? ` (${cls.ruta})` : ''}. La respuesta queda en las filas siguientes.`
    };
  }
  if (cls.tipo === 'api') item = interpretarApi(fila, cls.m);
  else if (cls.tipo === 'soap') item = interpretarSoap(fila, cls.m);
  else if (cls.tipo === 'error') item = interpretarError(fila);

  if (item) {
    const mapa = { ok: 'exito', error: 'error', aviso: 'aviso', info: item.sinDatos || item.manejado ? 'aviso' : 'info' };
    let estado = mapa[item.nivel] || 'info';
    let texto = item.texto;
    if (estado === 'exito' && cls.tipo === 'soap') texto = 'El sistema del banco respondió correctamente.';
    if (estado === 'aviso' && item.sinDatos) texto = `Respondió, pero sin datos. ${texto}`;
    if (estado === 'aviso' && item.manejado) texto = `Error controlado por la app (no afectó al cliente). ${texto}`;
    return { tipo: cls.tipo, tipoTexto: TIPOS_FILA[cls.tipo], estado, estadoTexto: texto, titulo: item.titulo, timeout: !!item.timeout };
  }

  // Paso interno: solo se marca error si su contenido lo es de forma inequívoca.
  if (/^Error:/.test(rs) || /^Error:/.test(ad) || (/^Status:\s*[^2]/.test(rs))) {
    return { tipo: 'paso', tipoTexto: TIPOS_FILA.paso, estado: 'error', estadoTexto: limpiarTexto(sinStack(rs || ad)) };
  }
  return {
    tipo: 'paso', tipoTexto: TIPOS_FILA.paso, estado: 'paso',
    estadoTexto: `Paso interno: ${limpiarTexto(fila.Descripcion, 140) || 'procesamiento de datos'}.`
  };
}

// ============================================================================
// TRADUCCIÓN DE CAMPOS (etiquetas en español)
// ============================================================================
const ETIQUETAS = {
  // --- cabecera ACE / mensajería
  rquid: 'Identificador de la solicitud', clientdt: 'Fecha y hora de la solicitud', networkowner: 'Canal de origen',
  networktrninfo: 'Datos de red', channelid: 'Canal', canal: 'Canal', canalcodigo: 'Código de canal',
  encryptdata: 'Datos cifrados', custid: 'Cliente', custpermid: 'Identificación del cliente',
  status: 'Estado de la respuesta', statuscode: 'Código de estado', serverstatuscode: 'Código interno del servidor',
  severity: 'Severidad', statusdesc: 'Descripción del estado', additionalstatus: 'Estado adicional',
  success: 'Fue exitosa', codstatus: 'Código de estado', descstatus: 'Descripción del estado', statusdescripcion: 'Descripción del estado',
  // --- identificación
  taxid: 'Número de documento', taxidtype: 'Tipo de documento', identnum: 'Número de documento', identtype: 'Tipo de documento',
  numdocumento: 'Número de documento', documento: 'Número de documento', documentnumber: 'Número de documento',
  documenttype: 'Tipo de documento', tipodocumento: 'Tipo de documento', identification: 'Identificación',
  numeroidentificacion: 'Número de identificación', custtaxid: 'Documento del cliente', custtype: 'Tipo de cliente',
  custtypeuser: 'Tipo de cliente', custypeuser: 'Tipo de cliente', custstatus: 'Estado del cliente', custstatuscode: 'Código de estado del cliente',
  // --- persona
  fullname: 'Nombre completo', firstname: 'Nombre', middlename: 'Segundo nombre', lastname: 'Apellido', nombre: 'Nombre', apellido: 'Apellido',
  username: 'Usuario', usuario: 'Usuario', email: 'Correo electrónico', emailaddr: 'Correo electrónico', phone: 'Teléfono', phonenum: 'Número de teléfono',
  phonetype: 'Tipo de teléfono', mobile: 'Celular', mobilenumber: 'Celular', usercellphone: 'Celular', userphone: 'Teléfono',
  birthdt: 'Fecha de nacimiento', gender: 'Género', maritalstatus: 'Estado civil', nationality: 'Nacionalidad', occupation: 'Ocupación',
  addr: 'Dirección', addr1: 'Dirección', address: 'Dirección', city: 'Ciudad', country: 'País', postalcode: 'Código postal',
  // --- cuentas y productos
  acctid: 'Número de cuenta', accountid: 'Número de cuenta', account: 'Cuenta', accountnumber: 'Número de cuenta',
  accttype: 'Tipo de cuenta', accttype1: 'Tipo de cuenta', acctsubtype: 'Subtipo de cuenta', acctstatus: 'Estado de la cuenta', acctbal: 'Saldos',
  acctsumm: 'Resumen de la cuenta', acctlistcardarray: 'Listado de tarjetas', baltype: 'Tipo de saldo', balamt: 'Saldo',
  curamt: 'Monto', amt: 'Valor', curcode: 'Moneda', currency: 'Moneda', productid: 'Producto', productinfo: 'Información del producto',
  productcode: 'Código del producto', desc: 'Descripción', description: 'Descripción', branchid: 'Oficina', opendt: 'Fecha de apertura',
  ownerind: 'Indicador de titular', nickname: 'Alias de la cuenta', immediatexfer: 'Permite transferencia inmediata',
  identservicecode: 'Código de servicio', typeaccount: 'Tipo de cuenta', hassv: 'Tiene cuenta de ahorros', hasallsvopen: 'Todas las cuentas de ahorro abiertas',
  hasln: 'Tiene crédito', hastm: 'Tiene tarjeta', hassignature: 'Tiene firma', count: 'Cantidad',
  availablepoints: 'Puntos disponibles', totalpoints: 'Puntos totales', kilometers: 'Kilómetros', redeempoints: 'Puntos redimidos',
  nextpoints: 'Próximos puntos', totalpendingpoints: 'Puntos pendientes', money: 'Dinero', gasoline: 'Gasolina',
  // --- tarjetas
  pan: 'Número de tarjeta', pannum: 'Número de tarjeta', cardid: 'Tarjeta', cardnumber: 'Número de tarjeta', cardstatus: 'Estado de la tarjeta',
  cardstatuscode: 'Código de estado de la tarjeta', cardprefid: 'Preferencia de la tarjeta', cardprefstatus: 'Estado de la preferencia', cardprefstatuscode: 'Código del estado de la preferencia',
  brand: 'Franquicia', mediainfo: 'Información del medio', statusmedia: 'Estado del medio', expdt: 'Fecha de vencimiento', matdt: 'Fecha de vencimiento',
  issdt: 'Fecha de emisión', cardacctid: 'Cuenta de la tarjeta', ccmotoacct: 'Cuenta de la tarjeta', limitamt: 'Cupo', loclimit: 'Cupo local',
  totalcuramt: 'Monto total', maxcuramt: 'Monto máximo', mincuramt: 'Monto mínimo', paidcuramt: 'Monto pagado', cashamt: 'Monto en efectivo',
  limitdaydb: 'Límite diario débito', limitdaycash: 'Límite diario en efectivo', limitcredtc: 'Límite crédito', limitind: 'Indicador de límite',
  atmlimitcard1: 'Límite cajero tarjeta 1', atmlimitcard2: 'Límite cajero tarjeta 2', maxoperday: 'Máximo de operaciones por día',
  maxoperper: 'Máximo de operaciones por periodo', maxdayc: 'Máximo diario', lastTrndt: 'Última transacción',
  // --- fechas
  fecha: 'Fecha', fechacreacion: 'Fecha de creación', fechamodificacion: 'Fecha de modificación', fechaulogin: 'Último inicio de sesión',
  fechacambioclave: 'Fecha del último cambio de clave', fechaactdatos: 'Fecha de actualización de datos', fechaenrolamiento: 'Fecha de enrolamiento',
  startdate: 'Fecha inicial', enddate: 'Fecha final', inidate: 'Fecha inicial', startdt: 'Fecha de inicio', enddt: 'Fecha de fin', effdt: 'Fecha de vigencia',
  duedt: 'Fecha de vencimiento', nextdt: 'Próxima fecha', lastStmtdt: 'Último extracto', senddt: 'Fecha de envío', updatedt: 'Fecha de actualización',
  registerdate: 'Fecha de registro', dateregister: 'Fecha de registro', datesend: 'Fecha de envío', changedate: 'Fecha del cambio',
  clientcreatedt: 'Fecha de creación en el cliente', datebiometric: 'Fecha de biometría', availdt: 'Fecha de disponibilidad',
  // --- sesión / dispositivo / seguridad
  deviceid: 'Identificador del dispositivo', devicetype: 'Tipo de dispositivo', devicehash: 'Huella del dispositivo', deviceguid: 'Identificador del dispositivo',
  deviceversion: 'Versión de la app', device: 'Dispositivo', os: 'Sistema operativo', so: 'Sistema operativo', sistemaoperativo: 'Sistema operativo',
  ip: 'Dirección IP', ipcliente: 'IP del cliente', latitude: 'Latitud', longitude: 'Longitud', guid: 'Identificador único', guidusuario: 'Identificador único del usuario',
  hash: 'Huella', securityhash: 'Huella de seguridad', token: 'Token', tokenactual: 'Token actual', tokenanterior: 'Token anterior', tokenpush: 'Token de notificaciones',
  tokenmultilogin: 'Token de múltiples sesiones', access_token: 'Token de acceso', expiresin: 'Vigencia del token (segundos)',
  contrasena: 'Contraseña', clave: 'Clave', clavetransaccional: 'Clave transaccional', checksecure: 'Verificación de seguridad', fingerprint: 'Huella digital',
  fraseseguridad: 'Frase de seguridad', imagenseguridad: 'Imagen de seguridad', semilla: 'Semilla de seguridad', sessionactive: 'Sesión activa',
  sessionloginid: 'Identificador de sesión', sesskey: 'Llave de sesión', reintentologin: 'Reintentos de inicio de sesión', reintentopreguntas: 'Reintentos de preguntas',
  securedevice: 'Dispositivo seguro', requiredbiometric: 'Biometría obligatoria', requireddevice: 'Dispositivo obligatorio', requiredquickaccess: 'Acceso rápido obligatorio',
  requiredexceptionbiometric: 'Excepción de biometría obligatoria', quickaccess: 'Acceso rápido', statebiometric: 'Estado de biometría', rulebiometric: 'Regla de biometría',
  locksbiometric: 'Bloqueos de biometría', idcasebiometric: 'Caso de biometría', idrulebiometric: 'Regla de biometría', idstatebiometric: 'Estado de biometría',
  dateexceptionbiometric: 'Fecha de excepción de biometría',
  // --- notificaciones
  notificaciones: 'Notificaciones', titulo: 'Título', title: 'Título', bodymessage: 'Mensaje', tiponotificacion: 'Tipo de notificación', destipotificacion: 'Tipo de notificación',
  desctiponotificacion: 'Tipo de notificación', leido: 'Leída', priority: 'Prioridad', sendnow: 'Enviar ahora', notificado: 'Notificada', messagefirebase: 'Mensaje push',
  vendornotificacion: 'Fabricante del dispositivo', devicenamenotificacion: 'Nombre del dispositivo', sonotificacion: 'Sistema operativo del dispositivo',
  enviarnotificacion: 'Enviar notificación', enviaNotificacion: 'Enviar notificación', issendnotification: 'Enviar notificación', dateSend: 'Fecha de envío',
  // --- ley 2300
  listley2300: 'Autorizaciones Ley 2300', opcioncontactocodigo: 'Opción de contacto (código)', opcioncontanto: 'Opción de contacto', valor: 'Valor', aliado: 'Aliado',
  mora: 'Mora', // genérico
  // --- transferencias / Bre-B
  aliasvalue: 'Llave', aliastype: 'Tipo de llave', handle: 'Llave', keeper: 'Entidad que administra la llave', bankname: 'Banco', bankid: 'Código del banco',
  bankaccountnumber: 'Número de cuenta del banco', bankaccounttype: 'Tipo de cuenta del banco', totalamount: 'Valor total', amounttransferred: 'Valor transferido',
  transactiontype: 'Tipo de transacción', transactionid: 'Identificador de la transacción', transactionstatus: 'Estado de la transacción', transactionsource: 'Origen de la transacción',
  creditor: 'Beneficiario', debtor: 'Ordenante', partyidentifier: 'Identificador de la parte', partyidentifiertype: 'Tipo de identificador', partytype: 'Tipo de parte',
  numberaproval: 'Número de aprobación', approvalid: 'Número de aprobación', merchantid: 'Comercio', instructedagent: 'Entidad destino', note: 'Nota',
  routerreference: 'Referencia de enrutamiento', targetspbvicode: 'Entidad destino (SPBVI)', transactionusecase: 'Caso de uso', transactionscenario: 'Escenario',
  initiatortype: 'Tipo de iniciador', initiatorsubtype: 'Subtipo de iniciador',
  // --- misc
  data: 'Datos', response: 'Respuesta', request: 'Solicitud', message: 'Mensaje', error: 'Error', detail: 'Detalle', text: 'Texto', name: 'Nombre', id: 'Identificador',
  code: 'Código', codigo: 'Código', estado: 'Estado', type: 'Tipo', subtype: 'Subtipo', page: 'Página', pagesize: 'Tamaño de página', index: 'Índice',
  executiontime: 'Tiempo de ejecución', responsetime: 'Tiempo de respuesta', responsecode: 'Código de respuesta', faultcode: 'Código de falla', faultstring: 'Mensaje de falla',
  faultactor: 'Origen de la falla', rs: 'Respuesta', usercreate: 'Usuario que creó', userupdate: 'Usuario que actualizó', usuariocreacion: 'Usuario que creó',
  usuariomodificacion: 'Usuario que modificó', userinfo: 'Información del usuario', myuserinfo: 'Información del usuario', loggerdto: 'Datos de registro',
  jobinfo: 'Información laboral', jobtitle: 'Cargo', personinfo: 'Información personal', personname: 'Nombre de la persona', basicinfo: 'Información básica',
  contactinfo: 'Información de contacto', custinfo: 'Información del cliente', custrec: 'Registro del cliente', segment: 'Segmento', lite: 'Versión resumida',
  registers: 'Registros', register: 'Registro', consultregistry: 'Consulta de registro', spname: 'Procedimiento', ctrlconcur: 'Control de concurrencia', concurkey: 'Llave de concurrencia',
  longchar: 'Texto largo', longtext: 'Texto largo', shortdesc: 'Descripción corta', pageind: 'Indicador de página', pageinfo: 'Información de paginación',
  products: 'Productos', parametros: 'Parámetros', labels: 'Etiquetas', created: 'Creado', createdby: 'Creado por', consented: 'Con consentimiento', requiredbiometric1: 'Biometría obligatoria',
  freq: 'Frecuencia', freqpay: 'Frecuencia de pago', payment: 'Pago', pmtmethod: 'Método de pago', rate: 'Tasa', seqnum: 'Número de secuencia', number: 'Número',
  filtro: 'Filtro', onlypurchases: 'Solo compras', isp2p: 'Es transferencia P2P', ispagodirigido: 'Es pago dirigido', hasln1: 'Tiene crédito', startdate1: 'Fecha inicial',
  localuid: 'Identificador local', incommingUser: 'Usuario entrante', sessionLoginId: 'Identificador de sesión', cusTypeUser: 'Tipo de cliente',
  nameperson: 'Nombre de la persona', nametype: 'Tipo de nombre', bankidtype: 'Tipo de identificador del banco'
};
// Las claves con mayúsculas se normalizan a minúsculas al buscar.
const MAPA_ETIQUETAS = new Map(Object.entries(ETIQUETAS).map(([k, v]) => [k.toLowerCase(), v]));

// Campos de "envoltorio" técnico: se agrupan aparte para no estorbar al lector.
const CAMPOS_TECNICOS = new Set(['rquid', 'clientdt', 'serverstatuscode', 'networkowner', 'networktrninfo', 'optimisticlockfield', 'gcrecord', 'sessionloginid', 'sesskey', 'securityhash', 'devicehash']);

// Valores de código frecuentes (solo los que son inequívocos).
const VALORES_CODIGO = {
  taxidtype: { CC: 'Cédula de ciudadanía', CE: 'Cédula de extranjería', NIT: 'NIT', PA: 'Pasaporte', TI: 'Tarjeta de identidad', RC: 'Registro civil' },
  identtype: { CC: 'Cédula de ciudadanía', CE: 'Cédula de extranjería', NIT: 'NIT', PA: 'Pasaporte', TI: 'Tarjeta de identidad', RC: 'Registro civil' },
  documenttype: { CC: 'Cédula de ciudadanía', CE: 'Cédula de extranjería', NIT: 'NIT', PA: 'Pasaporte', TI: 'Tarjeta de identidad', RC: 'Registro civil' },
  tipodocumento: { CC: 'Cédula de ciudadanía', CE: 'Cédula de extranjería', NIT: 'NIT', PA: 'Pasaporte', TI: 'Tarjeta de identidad', RC: 'Registro civil' },
  curcode: { COP: 'Pesos colombianos', USD: 'Dólares', EUR: 'Euros' },
  currency: { COP: 'Pesos colombianos', USD: 'Dólares', EUR: 'Euros' },
  severity: { Info: 'Informativo', Error: 'Error', Warning: 'Advertencia', Warn: 'Advertencia' }
};

const PALABRAS = {
  acct: 'Cuenta', amt: 'Monto', cur: 'Moneda', dt: 'Fecha', num: 'Número', desc: 'Descripción', info: 'Información', cust: 'Cliente', addr: 'Dirección',
  trn: 'Transacción', pmt: 'Pago', bal: 'Saldo', ref: 'Referencia', seq: 'Secuencia', exp: 'Vencimiento', mat: 'Vencimiento', eff: 'Vigencia', iss: 'Emisión',
  status: 'Estado', type: 'Tipo', code: 'Código', name: 'Nombre', date: 'Fecha', card: 'Tarjeta', limit: 'Límite', max: 'Máximo', min: 'Mínimo', daily: 'Diario',
  monthly: 'Mensual', day: 'Día', month: 'Mes', cash: 'Efectivo', phone: 'Teléfono', email: 'Correo', product: 'Producto', prod: 'Producto', owner: 'Titular',
  branch: 'Oficina', total: 'Total', list: 'Lista', array: 'Lista', rs: 'Respuesta', rq: 'Solicitud', id: 'Id'
};

function partirNombre(clave) {
  return String(clave)
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/** Etiqueta en español para un nombre de campo (o el nombre separado en palabras si no se conoce). */
function etiquetaDe(clave, cual) {
  const k = String(clave).toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (cual === 'rq' && k === 'statusdesc') return { texto: 'Estado que se consulta', conocida: true };
  if (cual === 'rq' && k === 'status') return { texto: 'Estado que se consulta', conocida: true };
  if (MAPA_ETIQUETAS.has(k)) return { texto: MAPA_ETIQUETAS.get(k), conocida: true };
  const palabras = partirNombre(clave).split(/\s+/).filter(Boolean);
  const traducidas = palabras.map((p) => PALABRAS[p.toLowerCase()] || p);
  const algunaTraducida = palabras.some((p) => PALABRAS[p.toLowerCase()]);
  const frase = traducidas.join(' ');
  return { texto: frase ? frase.charAt(0).toUpperCase() + frase.slice(1) : String(clave), conocida: algunaTraducida };
}

// ------------------------------------------------------------ formato de valores
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const RE_FECHA_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function pareceCifrado(v) {
  return typeof v === 'string' && v.length >= 28 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v);
}

/** Devuelve {v: texto a mostrar, nota?: explicación corta}. */
function formatearValor(clave, valor) {
  if (valor === null || valor === undefined) return { v: '(vacío)', vacio: true };
  if (typeof valor === 'boolean') return { v: valor ? 'Sí' : 'No' };
  const texto = String(valor);
  if (texto === '') return { v: '(vacío)', vacio: true };
  const k = String(clave).toLowerCase().replace(/[^a-z0-9_]/g, '');
  const f = RE_FECHA_ISO.exec(texto);
  if (f && texto.length >= 10) {
    const base = `${+f[3]} ${MESES[+f[2] - 1] || f[2]} ${f[1]}`;
    return { v: f[4] ? `${base}, ${f[4]}:${f[5]}${f[6] ? `:${f[6]}` : ''}` : base };
  }
  const tabla = VALORES_CODIGO[k];
  if (tabla && tabla[texto]) return { v: texto, nota: tabla[texto] };
  if (pareceCifrado(texto)) return { v: texto, nota: 'Valor cifrado (así viaja en el log)' };
  return { v: texto };
}

// ============================================================================
// ÁRBOL DE CAMPOS TRADUCIDOS (para mostrar en pantalla)
// ============================================================================
// Nodo: { e: etiqueta, t?: nombre técnico, v?: valor, nota?, h?: [nodos], n?: total de elementos de una lista, vacio? }
const MAX_PROFUNDIDAD = 7;
const MAX_ELEMENTOS_LISTA = 15;
const MAX_NODOS = 500;

function nuevoContexto(cual) { return { nodos: 0, omitidos: 0, tecnicos: [], cual }; }

function nodoHoja(clave, valor, ctx) {
  const { texto, conocida } = etiquetaDe(clave, ctx.cual);
  const f = formatearValor(clave, valor);
  ctx.nodos += 1;
  const n = { e: texto, v: f.v };
  if (!conocida || texto.toLowerCase() !== String(clave).toLowerCase()) n.t = String(clave);
  if (f.nota) n.nota = f.nota;
  if (f.vacio) n.vacio = true;
  return n;
}

function esTecnico(clave) { return CAMPOS_TECNICOS.has(String(clave).toLowerCase()); }

function nodosDeJson(valor, ctx, nivel = 0) {
  const salida = [];
  if (valor === null || typeof valor !== 'object') return salida;
  const entradas = Array.isArray(valor) ? valor.map((v, i) => [String(i + 1), v]) : Object.entries(valor);
  for (const [clave, v] of entradas) {
    if (ctx.nodos >= MAX_NODOS) { ctx.omitidos += 1; continue; }
    if (esTecnico(clave) && nivel <= 2 && (v === null || typeof v !== 'object')) {
      const hoja = nodoHoja(clave, v, ctx);
      ctx.tecnicos.push(hoja);
      continue;
    }
    if (v !== null && typeof v === 'object') {
      const { texto, conocida } = etiquetaDe(clave, ctx.cual);
      const nodo = { e: texto };
      if (!conocida || texto.toLowerCase() !== String(clave).toLowerCase()) nodo.t = String(clave);
      ctx.nodos += 1;
      if (Array.isArray(v)) {
        nodo.n = v.length;
        if (!v.length) { nodo.vacio = true; nodo.v = '(lista vacía)'; salida.push(nodo); continue; }
        const visibles = v.slice(0, MAX_ELEMENTOS_LISTA);
        if (nivel + 1 >= MAX_PROFUNDIDAD) { nodo.v = `${v.length} elemento(s)`; salida.push(nodo); continue; }
        nodo.h = visibles.map((it, i) => {
          if (it !== null && typeof it === 'object') {
            ctx.nodos += 1;
            return { e: `${i + 1}`, indice: true, h: nodosDeJson(it, ctx, nivel + 2) };
          }
          const hoja = nodoHoja(clave, it, ctx);
          return { ...hoja, e: `${i + 1}`, indice: true, t: undefined };
        });
        if (v.length > visibles.length) { nodo.mas = v.length - visibles.length; ctx.omitidos += v.length - visibles.length; }
      } else {
        const hijos = nivel + 1 >= MAX_PROFUNDIDAD ? [] : nodosDeJson(v, ctx, nivel + 1);
        if (!hijos.length) { nodo.v = '(vacío)'; nodo.vacio = true; } else nodo.h = hijos;
      }
      salida.push(nodo);
    } else {
      salida.push(nodoHoja(clave, v, ctx));
    }
  }
  return salida;
}

// Elementos que son "envoltorios" del mensaje SOAP: no aportan al lector.
const ENVOLTORIOS_XML = new Set(['Envelope', 'Body', 'Header', '#raiz']);

function nodosDeXml(nodo, ctx, nivel = 0) {
  const salida = [];
  // Hijos con el mismo nombre repetido -> se tratan como lista.
  const grupos = new Map();
  for (const h of nodo.h) {
    if (!grupos.has(h.n)) grupos.set(h.n, []);
    grupos.get(h.n).push(h);
  }
  for (const [nombre, lista] of grupos) {
    if (ctx.nodos >= MAX_NODOS) { ctx.omitidos += lista.length; continue; }
    if (ENVOLTORIOS_XML.has(nombre)) { salida.push(...nodosDeXml({ h: lista.flatMap((x) => x.h) }, ctx, nivel)); continue; }
    // <XxxRs> / <XxxRq> / <xxxResponse> / <xxxRequest>: se aplanan un nivel.
    if (/(?:Rs|Rq|Response|Request)$/.test(nombre) && lista.every((x) => x.h.length)) {
      salida.push(...nodosDeXml({ h: lista.flatMap((x) => x.h) }, ctx, nivel));
      continue;
    }
    const { texto, conocida } = etiquetaDe(nombre, ctx.cual);
    const tecnicoNombre = !conocida || texto.toLowerCase() !== nombre.toLowerCase() ? nombre : undefined;
    const construir = (x, etiqueta, esIndice) => {
      ctx.nodos += 1;
      if (!x.h.length) {
        const hoja = nodoHoja(nombre, x.t.trim(), ctx);
        if (esIndice) { hoja.e = etiqueta; hoja.indice = true; delete hoja.t; }
        return hoja;
      }
      const n = { e: etiqueta };
      if (tecnicoNombre && !esIndice) n.t = tecnicoNombre;
      if (esIndice) n.indice = true;
      n.h = nivel + 1 >= MAX_PROFUNDIDAD ? [] : nodosDeXml(x, ctx, nivel + 1);
      // Si todos sus hijos eran datos técnicos (ya agrupados aparte), el contenedor sobra.
      if (!n.h.length) return null;
      return n;
    };
    if (lista.length === 1) {
      const x = lista[0];
      if (!x.h.length && esTecnico(nombre)) { ctx.tecnicos.push(nodoHoja(nombre, x.t.trim(), ctx)); continue; }
      if (nombre === 'Status') continue; // el estado se muestra aparte
      const unico = construir(x, texto, false);
      if (unico) salida.push(unico);
    } else {
      const visibles = lista.slice(0, MAX_ELEMENTOS_LISTA);
      const cont = { e: texto, n: lista.length, h: visibles.map((x, i) => construir(x, `${i + 1}`, true)).filter(Boolean) };
      if (tecnicoNombre) cont.t = tecnicoNombre;
      if (lista.length > visibles.length) { cont.mas = lista.length - visibles.length; ctx.omitidos += cont.mas; }
      ctx.nodos += 1;
      salida.push(cont);
    }
  }
  return salida;
}

// ============================================================================
// TRADUCCIÓN DE UN CUERPO (RQ, RS o DATOS)
// ============================================================================
const LIMITE_CRUDO = 60000;

function recortarCrudo(texto) {
  const t = textoDe(texto);
  return t.length > LIMITE_CRUDO ? `${t.slice(0, LIMITE_CRUDO)}\n… (texto recortado: ${t.length - LIMITE_CRUDO} caracteres más)` : t;
}

function pareceXml(t) { return /^\s*(?:<\?xml|<[\w:.-]+[\s>/])/.test(t); }
function pareceJson(t) { return /^\s*[\[{]/.test(t); }

function nodosDeTexto(t, ctx) {
  const tr = t.trim();
  if (pareceXml(tr)) {
    const arbol = parseXml(tr);
    return { formato: 'xml', nodos: nodosDeXml(arbol, ctx), arbol };
  }
  if (pareceJson(tr)) {
    const j = parseJsonTolerante(tr);
    if (j.ok && j.valor !== null && typeof j.valor === 'object') {
      return { formato: 'json', nodos: nodosDeJson(j.valor, ctx), json: j.valor, truncado: j.truncado };
    }
  }
  return null;
}

function nodosDeQuery(t, ctx) {
  const pares = String(t).split('&').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    let k = i >= 0 ? p.slice(0, i) : p;
    let v = i >= 0 ? p.slice(i + 1) : '';
    try { k = decodeURIComponent(k); v = decodeURIComponent(v); } catch (e) { /* tal cual */ }
    return [k, v];
  });
  return pares.map(([k, v]) => nodoHoja(k, v, ctx));
}

/** Operación SOAP (nombre del primer elemento dentro de Body) y su traducción. */
function operacionSoap(arbol) {
  const cuerpos = buscarNodos(arbol, 'Body');
  const op = cuerpos.length && cuerpos[0].h[0] ? cuerpos[0].h[0].n : null;
  return op ? op.replace(/(Request|Response)$/, '') : null;
}

/** Estados (bloques Status/AdditionalStatus o status JSON) de una respuesta, ya en español. */
function estadosDe(formato, cuerpoTexto, json) {
  const estados = [];
  if (formato === 'xml') {
    for (const b of leerBloquesSoap(cuerpoTexto)) {
      const sev = b.severidad;
      const malo = !esCodigoOk(b.codigo) && (!sev || /^(error|fatal|critical)/i.test(sev));
      const sinDatos = RE_SIN_DATOS.test(b.desc);
      estados.push({
        origen: b.adicional ? 'Estado adicional' : 'Estado de la respuesta',
        codigo: b.codigo, severidad: sev ? (VALORES_CODIGO.severity[sev] || sev) : null,
        mensaje: b.desc || null,
        nivel: !malo && !(sev && /^(error|fatal)/i.test(sev) && !esCodigoOk(b.codigo)) ? 'ok' : (sinDatos ? 'aviso' : 'error')
      });
    }
    const fault = /<(?:\w+:)?faultstring>([^<]*)</i.exec(cuerpoTexto);
    if (fault) {
      estados.unshift({ origen: 'Falla SOAP', codigo: null, severidad: 'Error', mensaje: decodificarEntidades(fault[1]), traduccion: explicarMensaje(fault[1]), nivel: 'error' });
    }
  } else if (formato === 'json') {
    const { codigo, desc, success } = leerCodigoDesc(cuerpoTexto);
    if (codigo !== null || desc || success !== null) {
      const sinDatos = desc && RE_SIN_DATOS.test(desc);
      let nivel = 'ok';
      if (success === false) nivel = sinDatos ? 'aviso' : 'error';
      else if (codigo !== null && !esCodigoOk(codigo)) nivel = (sinDatos || codigo === 100) ? 'aviso' : 'error';
      estados.push({ origen: 'Estado de la respuesta', codigo: codigo === null ? null : String(codigo), severidad: success === null ? null : (success ? 'Exitosa' : 'No exitosa'), mensaje: desc || null, nivel });
    }
  }
  return estados;
}

/**
 * Traduce UNA sección (rq | rs | datos).
 * @param {'rq'|'rs'|'datos'} cual
 * @returns {null | {formato, resumen, destino, operacion, estados, nodos, tecnicos, texto, omitidos, truncado, nota, original}}
 */
function traducirSeccion(cual, texto, fila) {
  const bruto = textoDe(texto);
  const t = bruto.trim();
  if (!t) return null;

  const ctx = nuevoContexto(cual);
  const sec = {
    formato: 'texto', resumen: null, destino: null, operacion: null, http: null,
    estados: [], nodos: [], tecnicos: [], texto: null, omitidos: 0, truncado: false, nota: null,
    original: recortarCrudo(bruto)
  };
  let cuerpo = t;

  // ---- prefijos propios de LogApp
  if (cual === 'rs') {
    const st = /^Status:\s*(\d{3})\s*-?\s*([\s\S]*)$/i.exec(t);
    if (st) {
      sec.http = parseInt(st[1], 10);
      cuerpo = st[2].trim();
      sec.resumen = sec.http < 300 ? `El servicio respondió correctamente (HTTP ${sec.http}).` : `El servicio respondió con un problema: ${textoHttp(sec.http)}.`;
    } else if (/^Error:/i.test(t)) {
      sec.formato = 'error';
      sec.resumen = 'La llamada terminó con un error y no hubo respuesta del servicio.';
      sec.texto = limpiarTexto(sinStack(t), 1200);
      const causa = explicarMensaje(t);
      if (causa) sec.nota = causa;
      const pila = stackDe(t);
      if (pila) sec.tecnico = recortarCrudo(pila);
      return sec;
    }
  }
  if (cual === 'rq') {
    if (/^Sin Request$/i.test(t)) {
      sec.formato = 'vacio';
      sec.texto = 'Esta llamada no envía información en el cuerpo (es una consulta simple).';
      return sec;
    }
    const conUrl = /^(https?:\/\/\S+?)\s+-\s+([\s\S]*)$/.exec(t);
    if (conUrl) {
      sec.destino = conUrl[1].replace(/\?wsdl$/i, '');
      cuerpo = conUrl[2].trim();
    }
  }
  if (cual === 'datos') {
    const dec = /^\(decrypt\)\s*([\s\S]*)$/i.exec(t);
    if (dec) { cuerpo = dec[1].trim(); sec.nota = 'Contenido que la app descifró antes de usarlo.'; }
    if (/^Error:/i.test(cuerpo)) {
      sec.formato = 'error';
      sec.resumen = 'La app registró este error.';
      sec.texto = limpiarTexto(sinStack(cuerpo), 1200);
      const causa = explicarMensaje(cuerpo);
      if (causa) sec.nota = causa;
      const pila = stackDe(cuerpo);
      if (pila) sec.tecnico = recortarCrudo(pila);
      return sec;
    }
  }

  // ---- cuerpo estructurado
  const est = nodosDeTexto(cuerpo, ctx);
  if (est) {
    sec.formato = est.formato;
    sec.nodos = est.nodos;
    sec.tecnicos = ctx.tecnicos;
    sec.omitidos = ctx.omitidos;
    sec.truncado = !!est.truncado;
    if (est.formato === 'xml') sec.operacion = operacionSoap(est.arbol);
    if (cual === 'rs') {
      sec.estados = estadosDe(est.formato, cuerpo, est.json);
      // El estado ya se muestra aparte: se quita del detalle (JSON de nivel superior).
      if (est.formato === 'json' && sec.estados.length) {
        const llavesEstado = /^(status|statuscode|statusdesc|success|codstatus|descstatus)$/i;
        sec.nodos = sec.nodos.filter((n) => !(n.t && llavesEstado.test(n.t)) && !(!n.t && llavesEstado.test(n.e)));
      }
    }
    if (/"_xrv"/.test(cuerpo) && est.formato === 'json') {
      sec.nota = 'El contenido de esta respuesta viaja cifrado (campo _xrv): así queda en el log y no se puede leer sin la llave.';
    }
    if (sec.truncado) sec.nota = `${sec.nota ? `${sec.nota} ` : ''}El log guardó el texto cortado; se muestra lo que alcanzó a registrarse.`;
    return sec;
  }

  // ---- texto con forma de parámetros de URL (a=b&c=d)
  if (/^[\w.%\-[\]]+=[^&\s]*(?:&[\w.%\-[\]]+=[^&\s]*)*$/.test(cuerpo)) {
    sec.formato = 'consulta';
    sec.nodos = nodosDeQuery(cuerpo, ctx);
    return sec;
  }

  // ---- texto libre
  sec.formato = 'texto';
  sec.texto = cuerpo.length > 4000 ? `${cuerpo.slice(0, 4000)}…` : cuerpo;
  return sec;
}

// ============================================================================
// DETALLE COMPLETO DE UNA FILA
// ============================================================================
function motivoVacio(cls, cual) {
  const quien = { rq: 'la petición (RQ)', rs: 'la respuesta (RS)', datos: 'los datos adicionales' }[cual];
  if (cls.tipo === 'inicio') {
    if (cual === 'rs') return 'Es normal: esta fila marca el INICIO de la operación y no guarda respuesta. La respuesta del servicio queda en las filas siguientes de la misma operación. Que esté vacía NO significa que el servicio no respondió.';
    if (cual === 'rq') return 'Es normal: esta fila de inicio no guarda la petición; lo que envió la app aparece en "Datos adicionales".';
    return 'Esta fila de inicio no trae datos adicionales.';
  }
  if (cls.tipo === 'paso') return `Este paso interno no guarda ${quien}. Es normal y no indica ningún problema.`;
  if (cls.tipo === 'soap' || cls.tipo === 'api') {
    if (cual === 'datos') return 'Esta fila no trae datos adicionales.';
    return `El log no guardó ${quien} en esta fila. No significa que el servicio no haya respondido.`;
  }
  return `El log no guardó ${quien} en esta fila.`;
}

function descripcionServicio(fila, cls) {
  if (cls.tipo === 'soap') {
    const [, codigo, servicio, operacion] = cls.m;
    return `Servicio ${servicio} · operación ${operacion} (código C${codigo})`;
  }
  if (cls.tipo === 'api') {
    const m = cls.m;
    const url = m[3].trim().replace(/^https?:\/\//i, '');
    return `${m[2].toUpperCase()} a ${url}`;
  }
  if (cls.tipo === 'inicio') return cls.ruta ? `Ruta: ${cls.ruta}` : null;
  return null;
}

/**
 * Detalle traducido de una fila completa (con Rq, Rs, Adicional sin recortar).
 */
function traducirFila(fila) {
  const cls = clasificar(fila);
  const estado = clasificarFilaLog(fila);
  const rq = traducirSeccion('rq', fila.Rq, fila);
  const rs = traducirSeccion('rs', fila.Rs, fila);
  const datos = traducirSeccion('datos', fila.Adicional, fila);

  // En una fila SOAP el Adicional es la descripción de la operación: se muestra como texto.
  let queHace = null;
  if (cls.tipo === 'soap' && datos && datos.formato === 'texto') { queHace = datos.texto; }

  return {
    tipo: estado.tipo,
    tipoTexto: estado.tipoTexto,
    estado: estado.estado,
    estadoTexto: estado.estadoTexto,
    servicioDetalle: descripcionServicio(fila, cls),
    queHace,
    rq,
    rs,
    datos: queHace ? null : datos,
    vacios: {
      rq: rq ? null : motivoVacio(cls, 'rq'),
      rs: rs ? null : motivoVacio(cls, 'rs'),
      datos: datos || queHace ? null : motivoVacio(cls, 'datos')
    }
  };
}

module.exports = {
  RE_INICIO,
  RE_API,
  RE_SOAP,
  RE_SIN_DATOS,
  RE_VALOR_DEFECTO,
  limpiarTexto,
  sinStack,
  explicarMensaje,
  textoHttp,
  leerCodigoDesc,
  leerBloquesSoap,
  interpretarApi,
  interpretarSoap,
  interpretarError,
  clasificar,
  clasificarFilaLog,
  traducirFila,
  traducirSeccion,
  etiquetaDe,
  parseJsonTolerante,
  parseXml
};
