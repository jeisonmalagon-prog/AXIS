// ==========================================================================
// Asistente de IA para armar queries (lenguaje natural -> T-SQL de solo lectura).
//
// No «adivina» el esquema: primero busca en el catálogo las tablas que encajan con la
// pregunta y en el repositorio los queries del equipo que ya tocan esos temas, y le da
// al modelo (Ollama, el mismo del chat de AXIS) solo ese contexto: tablas con columnas,
// relaciones conocidas y ejemplos reales. Después valida lo que devuelve (solo SELECT,
// tablas y columnas que existan) y avisa de cualquier duda antes de dejar ejecutarlo.
//
// Variables (las mismas del chat): OLLAMA_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT_MS.
// ==========================================================================

const catalogo = require('./catalogoDatos');
const analisis = require('./queriesAnalisis');
const gen = require('./queriesGenerador');

const OLLAMA_URL = () => (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const OLLAMA_TIMEOUT_MS = () => Number(process.env.OLLAMA_TIMEOUT_MS) || 180000;
const PREFERENCIA = ['qwen2.5-coder', 'qwen2.5', 'qwen3', 'llama3.3', 'llama3.1', 'llama3.2', 'llama3', 'mistral', 'gemma', 'phi', 'deepseek', 'qwen'];

const PARADAS = new Set(['de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'que', 'con', 'por', 'para', 'en', 'y', 'o', 'del', 'al', 'mi', 'me', 'se', 'es', 'son',
  'quiero', 'necesito', 'dame', 'muestra', 'muestrame', 'ver', 'listar', 'lista', 'todos', 'todas', 'cuantos', 'cuantas', 'hay', 'tiene', 'tienen', 'desde', 'hasta', 'entre',
  'donde', 'cuando', 'como', 'query', 'consulta', 'sql', 'datos', 'dato', 'registro', 'registros', 'ultimos', 'ultimas', 'ultimo', 'ultima', 'dias', 'hoy', 'mas', 'menos',
  'sin', 'sobre', 'cada', 'cual', 'cuales', 'esta', 'este', 'esto', 'estan', 'fue', 'fueron', 'ser', 'sea', 'sean', 'han', 'haya', 'otro', 'otra', 'puedo', 'saber', 'dime', 'busca', 'buscar', 'encontrar']);

const sinAcentos = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function palabrasClave(pregunta) {
  const base = sinAcentos(pregunta).replace(/[^a-z0-9_ñ.\s]/g, ' ').split(/\s+/).filter((x) => x.length >= 3 && !PARADAS.has(x));
  const extra = [];
  for (const p of base) {
    if (p.length > 4 && p.endsWith('es')) extra.push(p.slice(0, -2));
    if (p.length > 3 && p.endsWith('s')) extra.push(p.slice(0, -1));
  }
  return [...new Set([...base, ...extra])].slice(0, 10);
}

// --------------------------------------------------------------------------
// Ollama
// --------------------------------------------------------------------------
let cacheModelo = { hasta: 0, modelo: null, instalados: [] };

async function resolverModelo() {
  const ahora = Date.now();
  if (cacheModelo.modelo && cacheModelo.hasta > ahora) return cacheModelo;
  try {
    const r = await fetch(`${OLLAMA_URL()}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const datos = await r.json();
    const instalados = (datos.models || []).map((m) => m.name || m.model).filter(Boolean).filter((n) => !/embed|rerank|bge|nomic/i.test(n));
    const b = (n) => String(n).toLowerCase();
    let elegido = instalados.find((n) => b(n) === b(OLLAMA_MODEL())) || instalados.find((n) => b(n) === `${b(OLLAMA_MODEL())}:latest`);
    if (!elegido) {
      for (const pref of PREFERENCIA) { elegido = instalados.find((n) => b(n).startsWith(pref)); if (elegido) break; }
      elegido = elegido || instalados[0] || null;
    }
    cacheModelo = { hasta: ahora + 5 * 60 * 1000, modelo: elegido, instalados };
    return cacheModelo;
  } catch (err) {
    return { hasta: 0, modelo: OLLAMA_MODEL(), instalados: [], error: err.message };
  }
}

async function llamarOllama({ system, user }) {
  const { modelo, instalados } = await resolverModelo();
  if (!modelo) {
    const e = new Error(`El servidor de IA (${OLLAMA_URL()}) no tiene ningún modelo instalado. Descarga uno con «ollama pull ${OLLAMA_MODEL()}».`);
    e.estado = 502;
    throw e;
  }
  let r;
  try {
    r = await fetch(`${OLLAMA_URL()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS()),
      body: JSON.stringify({
        model: modelo,
        stream: false,
        format: 'json',
        keep_alive: '30m',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        options: { temperature: 0.1, num_predict: 900, num_ctx: 8192, repeat_penalty: 1.05 },
      }),
    });
  } catch (err) {
    const porTiempo = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const e = new Error(porTiempo
      ? 'La IA tardó demasiado en responder. Prueba con una pregunta más corta o inténtalo de nuevo.'
      : `No se pudo conectar con el servicio de IA (Ollama en ${OLLAMA_URL()}). Revisa que esté encendido y que OLLAMA_URL apunte al servidor correcto.`);
    e.estado = porTiempo ? 504 : 502;
    throw e;
  }
  if (!r.ok) {
    const e = new Error(r.status === 404
      ? `El modelo «${modelo}» no está disponible en ${OLLAMA_URL()}.${instalados.length ? ` Instalados: ${instalados.slice(0, 6).join(', ')}.` : ''}`
      : `El servicio de IA respondió con error (${r.status}).`);
    e.estado = 502;
    throw e;
  }
  const datos = await r.json();
  return { texto: datos?.message?.content || '', modelo };
}

// --------------------------------------------------------------------------
// Contexto
// --------------------------------------------------------------------------
async function queriesRelevantes(pool, repo, palabras) {
  const puntos = new Map();
  for (const p of palabras.slice(0, 6)) {
    const r = await repo.listar(pool, { q: p, limite: 30 });
    r.queries.forEach((q, i) => puntos.set(q.id, (puntos.get(q.id) || 0) + (30 - i)));
  }
  const ids = [...puntos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
  const lista = [];
  for (const id of ids) { const q = await repo.obtener(pool, id); if (q) lista.push(q); }
  return lista;
}

function descripcionTabla(t, palabras) {
  const fk = new Set();
  for (const p of t.padres) for (const c of p.columnas) fk.add(c.col);
  const puntaje = (c) => (c.pk ? 100 : 0) + (fk.has(c.nombre) ? 60 : 0) + (palabras.some((p) => sinAcentos(c.nombre).includes(p)) ? 40 : 0);
  const cols = [...t.columnas].map((c, i) => ({ c, i })).sort((a, b) => puntaje(b.c) - puntaje(a.c) || a.i - b.i).slice(0, 30);
  const motor = t.motor === 'MSSQL' ? gen.nombreCompleto('MSSQL', t) : gen.nombreCompleto('MARIADB', t);
  return `${motor}${t.descripcion ? ` -- ${t.descripcion}` : ''}\n  columnas: ${cols.map(({ c }) => `${c.nombre} ${String(c.tipo || '').replace(/\s+/g, '')}${c.pk ? ' PK' : ''}`).join(', ')}${t.columnas.length > cols.length ? `, … (+${t.columnas.length - cols.length})` : ''}`;
}

async function armarContexto({ pregunta, origenId, tablasPreferidas }, { pool, repo, aprendidos }) {
  const palabras = palabrasClave(pregunta);
  const puntos = new Map(); // clave -> { t, p }
  const sumar = (t, p) => { const x = puntos.get(t.clave) || { t, p: 0 }; x.p += p; puntos.set(t.clave, x); };
  for (const { t, puntos: p } of catalogo.candidatasPorPalabras(palabras, { origenId, limite: 16 })) sumar(t, p);
  const queries = await queriesRelevantes(pool, repo, palabras);
  for (const q of queries) {
    for (const x of q.tablas) {
      for (const t of catalogo.tablasPorNombre({ bd: x.bd, esquema: x.esquema, tabla: x.tabla, origenId })) sumar(t, 8);
    }
  }
  for (const ref of tablasPreferidas || []) { const t = catalogo.tablaPorRef(ref); if (t) sumar(t, 60); }
  let ordenadas = [...puntos.values()].filter((x) => x.p >= 6).sort((a, b) => b.p - a.p);
  if (!ordenadas.length) return { palabras, tablas: [], queries: [], relaciones: [], ejemplos: [] };
  const origen = origenId ? String(origenId) : ordenadas[0].t.origenId;
  ordenadas = ordenadas.filter((x) => x.t.origenId === origen);
  const tablas = ordenadas.slice(0, 7).map((x) => x.t);

  const relaciones = [];
  for (let i = 0; i < tablas.length; i++) {
    for (let j = i + 1; j < tablas.length; j++) {
      const [e] = gen.aristasEntre(tablas[i], tablas[j], aprendidos);
      if (e && e.confianza >= 55) relaciones.push({ texto: e.condiciones.map((c) => `${tablas[i].nombre}.${c.ca} = ${tablas[j].nombre}.${c.cb}`).join(' AND '), tipo: e.tipo });
    }
  }
  const nombres = new Set(tablas.map((t) => sinAcentos(t.nombre)));
  const ejemplos = queries
    .filter((q) => !q.modifica && q.consulta.length <= 1600 && q.tablas.some((x) => nombres.has(sinAcentos(x.tabla))))
    .slice(0, 3);
  return { palabras, tablas, queries, relaciones: relaciones.slice(0, 14), ejemplos, origen };
}

function armarPrompt(pregunta, ctx) {
  const motor = ctx.tablas[0].motor === 'MSSQL' ? 'MSSQL' : 'MARIADB';
  const dialecto = motor === 'MSSQL'
    ? 'SQL Server (T-SQL): usa [corchetes], TOP n y WITH (NOLOCK) en cada tabla.'
    : 'MariaDB: usa `comillas invertidas` y LIMIT n.';
  const system = [
    'Eres un experto en bases de datos de un banco. Conviertes la petición del usuario en UNA sola consulta SELECT de solo lectura.',
    `Dialecto: ${dialecto}`,
    'Reglas estrictas:',
    '- Usa SOLO las tablas y columnas de la sección ESQUEMA. No inventes nombres.',
    '- Escribe los nombres completos de las tablas tal como aparecen en ESQUEMA y alias cortos.',
    '- Une tablas únicamente con las RELACIONES listadas.',
    `- ${motor === 'MSSQL' ? 'Agrega TOP 100 salvo que pidan un conteo o un total.' : 'Agrega LIMIT 100 salvo que pidan un conteo o un total.'}`,
    '- Nunca uses INSERT, UPDATE, DELETE, EXEC, DECLARE, USE, SELECT INTO ni más de una sentencia.',
    "- Si no conoces un valor, escribe '<VALOR>'.",
    '- Si el ESQUEMA no tiene lo necesario, devuelve "sql" vacío y explica qué falta.',
    'Responde SOLO un objeto JSON: {"sql": "...", "explicacion": "una o dos frases en español"}.',
  ].join('\n');
  const partes = [`PETICIÓN: ${pregunta}`, '', 'ESQUEMA:', ...ctx.tablas.map((t) => descripcionTabla(t, ctx.palabras))];
  if (ctx.relaciones.length) partes.push('', 'RELACIONES:', ...ctx.relaciones.map((r) => `- ${r.texto}${r.tipo === 'fk' ? ' (llave foránea)' : ''}`));
  if (ctx.ejemplos.length) {
    partes.push('', 'EJEMPLOS DE QUERIES QUE EL EQUIPO YA USA (inspírate en su estilo, no los copies si no aplican):');
    for (const q of ctx.ejemplos) partes.push(`-- ${q.titulo}`, q.consulta.trim(), '');
  }
  return { system, user: partes.join('\n') };
}

function extraerRespuesta(texto) {
  const t = String(texto || '').trim();
  const intentos = [t, t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')];
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) intentos.push(m[0]);
  for (const x of intentos) {
    try {
      const o = JSON.parse(x);
      if (o && typeof o === 'object') return { sql: String(o.sql || '').trim(), explicacion: String(o.explicacion || o.explicación || '').trim() };
    } catch { /* siguiente intento */ }
  }
  const bloque = /```(?:sql)?\s*([\s\S]*?)```/i.exec(t);
  if (bloque) return { sql: bloque[1].trim(), explicacion: '' };
  if (/^\s*(select|with)\b/i.test(t)) return { sql: t, explicacion: '' };
  return { sql: '', explicacion: t.slice(0, 400) };
}

function revisarContraCatalogo(sql, origen) {
  const advertencias = [];
  const an = analisis.analizarSql(analisis.separarUse(sql).sql, {});
  const porAlias = new Map();
  for (const t of an.tablas) {
    if (t.servidor) continue;
    const enc = catalogo.tablasPorNombre({ bd: t.bd, esquema: t.esquema, tabla: t.tabla, origenId: origen });
    if (!enc.length) { advertencias.push(`La tabla ${[t.bd, t.esquema, t.tabla].filter(Boolean).join('.')} no existe en el catálogo.`); continue; }
    for (const a of [...t.aliases, t.tabla]) porAlias.set(sinAcentos(a), enc[0]);
  }
  const { mascara } = analisis.escanear(sql);
  const re = /(?<![\w\].])([A-Za-z_]\w*|\[[^\]]+\])\s*\.\s*([A-Za-z_]\w*|\[[^\]]+\])(?![\w(.])/g;
  const faltan = new Set();
  let m;
  while ((m = re.exec(mascara))) {
    if (/\b(FROM|JOIN|INTO|UPDATE|TABLE|USING)\s+$/i.test(mascara.slice(Math.max(0, m.index - 12), m.index))) continue;
    const q = sinAcentos(analisis.partirNombre(m[1])[0] || '');
    const t = porAlias.get(q);
    if (!t) continue;
    const c = analisis.partirNombre(m[2])[0] || '';
    if (c && !gen.colReal(t, c)) faltan.add(`${t.nombre}.${c}`);
  }
  for (const f of [...faltan].slice(0, 6)) advertencias.push(`La columna ${f} no existe en el catálogo.`);
  return { advertencias, tablas: an.tablas };
}

// --------------------------------------------------------------------------
// Principal
// --------------------------------------------------------------------------
async function generarConIa({ pregunta, origenId = null, tablasPreferidas = [] }, { pool, repo, aprendidos = [], ollama = llamarOllama }) {
  const texto = String(pregunta || '').trim();
  if (texto.length < 8) return { error: 'Cuéntame un poco más: ¿qué quieres consultar y con qué datos?' };
  if (texto.length > 800) return { error: 'La petición es muy larga (máx. 800 caracteres).' };
  const ctx = await armarContexto({ pregunta: texto, origenId, tablasPreferidas }, { pool, repo, aprendidos });
  if (!ctx.tablas.length) {
    return { error: 'No encontré tablas del catálogo que encajen con la petición. Prueba con otras palabras (nombres de tablas, columnas o del proceso) o arma el query con el constructor guiado.' };
  }
  const { system, user } = armarPrompt(texto, ctx);
  const { texto: crudo, modelo } = await ollama({ system, user });
  const r = extraerRespuesta(crudo);
  const base = {
    modelo, explicacion: r.explicacion, origenId: ctx.origen, baseDatos: ctx.tablas[0].bd,
    tablasContexto: ctx.tablas.map(gen.resumenSimple),
    queriesEjemplo: ctx.ejemplos.map((q) => ({ id: q.id, titulo: q.titulo })),
    relaciones: ctx.relaciones.map((x) => x.texto),
  };
  if (!r.sql) return { ...base, sql: '', advertencias: [r.explicacion || 'El modelo no pudo armar la consulta con la información disponible.'], soloLectura: { ok: false, motivo: 'Sin consulta.' } };
  const partes = analisis.separarUse(r.sql);
  const validacion = analisis.validarSoloLectura(partes.sql);
  const rev = revisarContraCatalogo(r.sql, ctx.origen);
  const advertencias = [...rev.advertencias];
  if (/<VALOR>/.test(r.sql)) advertencias.push('Reemplaza <VALOR> por el dato real antes de ejecutar.');
  if (!validacion.ok) advertencias.unshift(validacion.motivo);
  advertencias.push('Revisa el resultado: la IA puede equivocarse. Compáralo con los queries del repositorio antes de usarlo.');
  return { ...base, sql: r.sql, advertencias, soloLectura: { ok: validacion.ok, motivo: validacion.ok ? '' : validacion.motivo } };
}

module.exports = { generarConIa, palabrasClave, armarContexto, armarPrompt, extraerRespuesta, revisarContraCatalogo };
