// Servicio de «Monitorear prospección»: ejecuta las consultas del catálogo en SOLO LECTURA contra GestionCliente, aísla los
// errores por bloque, oculta columnas sensibles y arma la línea de tiempo y los hallazgos.
//
// Garantías de solo lectura (defensa en profundidad):
//  1) Las consultas las arma el backend (prospeccionConsultas), jamás vienen de la pantalla; los valores van como parámetros.
//  2) Antes de ejecutar, `sqlSoloLectura` exige que sea un único SELECT/WITH sin palabras de escritura, DDL, EXEC ni INTO.
//  3) Cada consulta lleva SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED y SET LOCK_TIMEOUT: no bloquea a nadie.
//  4) Se recomienda además que la cuenta de BD tenga solo permiso SELECT.

const sql = require('./sqlServer');
const conexion = require('./prospeccionConexion');
const C = require('./prospeccionConsultas');

const PERFIL = conexion.PERFIL;
const PREFIJO = 'SET NOCOUNT ON; SET LOCK_TIMEOUT 8000; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n';
const MAX_TEXTO = 300;
const MAX_FILAS_RESPUESTA = 500;
const TTL_ESQUEMA_MS = 10 * 60 * 1000;
const CONCURRENCIA = 2;
// Errores de conexión (no de una consulta concreta): si TODOS los bloques fallan así, la pantalla muestra un solo aviso claro.
const CODIGOS_CONEXION = ['ELOGIN', 'ESOCKET', 'ETIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EINSTLOOKUP', 'EHOSTUNREACH', 'ECONNCLOSED', 'ENOTOPEN', 'SIN_CONFIG', 'SIN_DRIVER'];

class ErrorProspeccion extends Error {
  constructor(mensaje, status = 400, codigo = 'VALIDACION') { super(mensaje); this.status = status; this.codigo = codigo; }
}

// ---------------------------------------------------------------------------
// Guarda de solo lectura
// ---------------------------------------------------------------------------
const RE_PROHIBIDAS = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|SHUTDOWN|RECONFIGURE|DBCC|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|WAITFOR|INTO|KILL|USE|SET|DECLARE)\b/i;

/** true si el texto es un único SELECT (o WITH … SELECT) sin nada que escriba o cambie algo. */
function sqlSoloLectura(texto) {
  const t = String(texto || '')
    .replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\[[^\]]*\]/g, '[x]') // identificadores entre corchetes
    .replace(/'(?:[^']|'')*'/g, "''") // literales de texto
    .trim();
  if (!/^(SELECT|WITH)\b/i.test(t)) return false;
  if (t.includes(';')) return false;
  if (RE_PROHIBIDAS.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Formato de valores
// ---------------------------------------------------------------------------
const dos = (n) => String(n).padStart(2, '0');

function valorSeguro(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // El driver entrega la hora de la base como si fuera UTC: se muestra tal cual, sin convertir zonas.
    const base = `${v.getUTCFullYear()}-${dos(v.getUTCMonth() + 1)}-${dos(v.getUTCDate())}`;
    const hora = `${dos(v.getUTCHours())}:${dos(v.getUTCMinutes())}:${dos(v.getUTCSeconds())}`;
    return hora === '00:00:00' ? base : `${base} ${hora}`;
  }
  if (Buffer.isBuffer(v)) return `(binario ${v.length} bytes)`;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  const s = String(v);
  return s.length > MAX_TEXTO ? `${s.slice(0, MAX_TEXTO)}…` : s;
}

function escapar(valor, tipo) {
  if (tipo === 'int' || tipo === 'bigint') return String(valor).replace(/[^\d-]/g, '');
  return `${tipo === 'nvarchar' ? 'N' : ''}'${String(valor).replace(/'/g, "''")}'`;
}

/** El SQL listo para pegar en SSMS (con los valores puestos en lugar de los parámetros). */
function sqlParaCopiar(bloque) {
  let texto = bloque.sql;
  const params = [...(bloque.params || [])].sort((a, b) => b.nombre.length - a.nombre.length);
  for (const p of params) texto = texto.replace(new RegExp(`@${p.nombre}\\b`, 'g'), escapar(p.valor, p.tipo));
  return `-- Solo lectura. Base: ${PERFIL === 'gestioncliente' ? 'GestionCliente' : PERFIL}\nSET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n${texto};`;
}

// ---------------------------------------------------------------------------
// Ejecución de un bloque
// ---------------------------------------------------------------------------
async function ejecutarBloque(bloque) {
  const base = { id: bloque.id, titulo: bloque.titulo, ayuda: bloque.ayuda || null, vista: bloque.vista || 'tabla', clic: bloque.clic || null, externa: !!bloque.externa, vertical: !!bloque.vertical };
  if (bloque.omitido) return { ...base, id: bloque.id, ok: false, omitido: true, error: bloque.omitido, columnas: [], filas: [], sql: null };
  if (!sqlSoloLectura(bloque.sql)) {
    return { ...base, ok: false, error: 'Consulta bloqueada: no es de solo lectura.', columnas: [], filas: [], sql: null };
  }
  const t0 = Date.now();
  try {
    const crudo = await sql.consultar(PERFIL, PREFIJO + bloque.sql, bloque.params || []);
    const nombres = Object.keys(crudo.columns || crudo[0] || {});
    const ocultas = [];
    let visibles = nombres;
    if (bloque.generico) {
      visibles = nombres.filter((n) => !C.RE_COLUMNA_SENSIBLE.test(n));
      for (const n of nombres) if (!visibles.includes(n)) ocultas.push(n);
    }
    const truncado = crudo.length > MAX_FILAS_RESPUESTA;
    const filas = crudo.slice(0, MAX_FILAS_RESPUESTA).map((f) => {
      const o = {};
      for (const n of visibles) o[n] = valorSeguro(f[n]);
      return o;
    });
    return {
      ...base, ok: true, columnas: visibles.map((n) => ({ clave: n, etiqueta: n.replace(/^Ax/, '') })), filas, ocultas, truncado,
      ms: Date.now() - t0, sql: sqlParaCopiar(bloque), columnaId: bloque.columnaId || null,
      _crudo: crudo.slice(0, MAX_FILAS_RESPUESTA),
    };
  } catch (error) {
    return {
      ...base, ok: false, error: sql.mensajeErrorSql(error, PERFIL), columnas: [], filas: [], ms: Date.now() - t0, sql: sqlParaCopiar(bloque),
      conexionCaida: CODIGOS_CONEXION.includes(error?.code || error?.codigo),
    };
  }
}

async function ejecutarLista(lista) {
  const resultados = {};
  let i = 0;
  const trabajadores = Array.from({ length: Math.min(CONCURRENCIA, lista.length) }, async () => {
    while (i < lista.length) {
      const [id, bloque] = lista[i]; i += 1;
      resultados[id] = await ejecutarBloque({ ...bloque, id: bloque.id || id });
    }
  });
  await Promise.all(trabajadores);
  return resultados;
}

/** Quita lo interno (filas crudas) antes de responder. */
function limpiar(resultados) {
  const o = {};
  for (const [k, v] of Object.entries(resultados)) { const { _crudo, ...resto } = v; o[k] = resto; }
  return o;
}

// ---------------------------------------------------------------------------
// Esquema (INFORMATION_SCHEMA, solo metadatos)
// ---------------------------------------------------------------------------
let cacheEsquema = { en: 0, esq: null, error: null };

async function obtenerEsquema({ forzar = false } = {}) {
  await conexion.asegurar();
  if (!forzar && cacheEsquema.esq && Date.now() - cacheEsquema.en < TTL_ESQUEMA_MS) return cacheEsquema;
  try {
    const filas = await sql.consultar(PERFIL, PREFIJO + C.SQL_ESQUEMA, []);
    if (filas.length) cacheEsquema = { en: Date.now(), esq: new C.Esquema(filas), error: null };
    else cacheEsquema = { en: Date.now() - TTL_ESQUEMA_MS + 60000, esq: C.Esquema.base(), error: `No se ven tablas del esquema ${C.SCHEMA} (la cuenta no tiene permiso sobre metadatos o el esquema se llama distinto): se usan los nombres de las consultas de referencia.` };
  } catch (error) {
    if (error.codigo === 'SIN_CONFIG' || error.codigo === 'SIN_DRIVER') throw error;
    // Sin metadatos: se intenta igual con el esquema mínimo conocido y cada bloque dirá si falla.
    if (CODIGOS_CONEXION.includes(error.code)) throw error;
    cacheEsquema = { en: Date.now() - TTL_ESQUEMA_MS + 60000, esq: C.Esquema.base(), error: sql.mensajeErrorSql(error, PERFIL) };
  }
  return cacheEsquema;
}

/** Convierte errores de conexión en un ErrorProspeccion con mensaje entendible. */
function aErrorConexion(error) {
  if (error instanceof ErrorProspeccion) return error;
  const codigo = error?.codigo || error?.code;
  const sinConfig = codigo === 'SIN_CONFIG';
  return new ErrorProspeccion(sql.mensajeErrorSql(error, PERFIL), sinConfig ? 409 : 502, sinConfig ? 'SIN_CONFIG' : 'CONEXION');
}

async function conEsquema(fn) {
  try {
    const { esq, error } = await obtenerEsquema();
    const r = await fn(esq);
    const intentados = Object.values(r.bloques || {}).filter((b) => !b.omitido);
    const caidos = intentados.filter((b) => b.conexionCaida);
    if (intentados.length && caidos.length === intentados.length) {
      olvidarEsquema();
      throw new ErrorProspeccion(caidos[0].error, 502, 'CONEXION');
    }
    return { ...r, esquemaAviso: error || null, esquemaDescubierto: esq.descubierto };
  } catch (e) { throw aErrorConexion(e); }
}

// ---------------------------------------------------------------------------
// Validaciones de parámetros de pantalla
// ---------------------------------------------------------------------------
function entero(valor, defecto, min, max, nombre) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return defecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErrorProspeccion(`${nombre} debe ser un entero entre ${min} y ${max}.`);
  return n;
}

function documentoValido(valor) {
  const d = String(valor ?? '').trim();
  if (!C.RE_DOCUMENTO.test(d)) throw new ErrorProspeccion('El documento debe tener entre 3 y 20 letras o números, sin espacios ni símbolos.');
  return d;
}

const enmascarar = (doc) => { const s = String(doc); return s.length <= 4 ? '****' : `${'*'.repeat(s.length - 3)}${s.slice(-3)}`; };

// ---------------------------------------------------------------------------
// Hallazgos (lectura rápida de los números)
// ---------------------------------------------------------------------------
function calcularHallazgos(kpis, dias) {
  const v = (id) => (kpis[id] && kpis[id].ok && kpis[id].filas[0] ? Number(kpis[id].filas[0].valor) : null);
  const periodo = dias === 1 ? 'hoy' : `en los últimos ${dias} días`;
  const h = [];
  const cargados = v('kpi_prospectos');
  const prospectados = v('kpi_prospectados');
  const cargues = v('kpi_cargues');
  const prospecciones = v('kpi_prospecciones');
  const errores = v('kpi_errores');
  if (cargues === 0 && cargados === 0 && prospecciones === 0) h.push({ nivel: 'info', texto: `No hay cargues ni prospecciones ${periodo}.` });
  if (cargados && cargados > 0 && prospectados === 0) h.push({ nivel: 'alto', texto: `Se cargaron ${cargados} prospectos ${periodo} y ninguno está prospectado (ProspectadoInd = 1): revisar que corra la prospección del aliado.` });
  else if (cargados && prospectados !== null && prospectados < cargados) {
    const pend = cargados - prospectados;
    h.push({ nivel: pend / cargados > 0.5 ? 'medio' : 'info', texto: `${pend} de ${cargados} prospectos cargados ${periodo} siguen sin prospectar (${Math.round((pend / cargados) * 100)}%).` });
  }
  if (cargados && prospecciones === 0) h.push({ nivel: 'medio', texto: `Hay prospectos cargados ${periodo} pero ninguna prospección registrada en PD.Prospeccion.` });
  if (errores && errores > 0) h.push({ nivel: errores > 20 ? 'alto' : 'medio', texto: `${errores} registro(s) de error de aliados ${periodo}: ver la pestaña Errores.` });
  if (!h.length) h.push({ nivel: 'ok', texto: `Sin alertas ${periodo}: la prospección avanza en línea con los cargues.` });
  return h;
}

// ---------------------------------------------------------------------------
// Pantallas
// ---------------------------------------------------------------------------
async function resumen({ dias }) {
  const d = entero(dias, 1, 1, 90, 'Los días');
  return conEsquema(async (esq) => {
    const lista = C.bloquesResumen(esq, { dias: d });
    const res = await ejecutarLista(lista);
    const bloques = limpiar(res);
    return { dias: d, bloques, hallazgos: calcularHallazgos(bloques, d), generadoEn: new Date().toISOString() };
  });
}

async function cargues({ top }) {
  const n = entero(top, 50, 10, 200, 'El tope');
  return conEsquema(async (esq) => {
    const res = await ejecutarLista([['tab_cargues', C.bloqueCargues(esq, { top: n })]]);
    return { bloques: limpiar(res), generadoEn: new Date().toISOString() };
  });
}

function lineaTiempo(res) {
  const ev = [];
  const poner = (fecha, tipo, titulo, detalle) => { if (fecha) ev.push({ fecha: String(fecha), tipo, titulo, detalle: detalle || null }); };
  const clave = (fila, nombre) => { const k = Object.keys(fila).find((x) => x.toLowerCase() === nombre.toLowerCase()); return k ? fila[k] : undefined; };
  for (const f of res.cl_cargues?._crudo || []) {
    const cargue = clave(f, 'IdCampanaCargue');
    poner(valorSeguro(clave(f, 'FechaCreacion')), 'carga', 'Registro cargado por el aliado', cargue !== undefined ? `Cargue ${cargue}` : null);
    if (Number(clave(f, 'ProspectadoInd')) === 1 || clave(f, 'ProspectadoInd') === true) poner(valorSeguro(clave(f, 'FechaModificacion')), 'prospecto', 'Prospectado', cargue !== undefined ? `Cargue ${cargue}` : null);
  }
  for (const f of res.cl_prospeccion?._crudo || []) poner(valorSeguro(f.FechaRegistro), 'prospeccion', 'Prospección registrada', f.IdLote !== undefined ? `Lote ${f.IdLote}` : null);
  for (const f of res.cl_analisis?._crudo || []) poner(valorSeguro(clave(f, 'FechaCreacion')), 'listas', 'Análisis de listas', null);
  for (const f of res.cl_procesos?._crudo || []) {
    const det = [f.Estado ? `Estado: ${f.Estado}` : null, f.NoSolicitud ? `Solicitud ${f.NoSolicitud}` : null, f.Aliado || null].filter(Boolean).join(' · ');
    poner(valorSeguro(f.Creado), 'proceso', 'Proceso aliado creado', f.IdLote !== undefined ? `Lote ${f.IdLote}` : null);
    const m = valorSeguro(f.Modificado);
    if (m && m !== valorSeguro(f.Creado)) poner(m, 'proceso', 'Proceso aliado actualizado', det);
  }
  ev.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  return ev.slice(0, 200);
}

async function cargue({ id }) {
  return conEsquema(async (esq) => {
    const lista = C.bloquesCargue(esq, { id: String(id) });
    const res = await ejecutarLista(lista);
    return { id: String(id), bloques: limpiar(res), generadoEn: new Date().toISOString() };
  });
}

async function cliente({ documento, trazaDias }) {
  const doc = documentoValido(documento);
  const td = entero(trazaDias, 1, 1, 7, 'Los días de traza');
  return conEsquema(async (esq) => {
    const lista = C.bloquesCliente(esq, { documento: doc, trazaDias: td });
    const res = await ejecutarLista(lista);
    const linea = lineaTiempo(res);
    return { documento: doc, trazaDias: td, bloques: limpiar(res), lineaTiempo: linea, generadoEn: new Date().toISOString() };
  });
}

async function procesos({ dias, top, estado, aliado }) {
  const d = entero(dias, 1, 1, 90, 'Los días');
  const n = entero(top, 200, 10, 500, 'El tope');
  const e = entero(estado, null, 0, 100000, 'El estado');
  const a = entero(aliado, null, 0, 1000000, 'El aliado');
  return conEsquema(async (esq) => {
    const [bP, cats] = [C.bloqueProcesos(esq, { dias: d, top: n, estado: e, aliado: a }), C.bloquesCatalogos(esq)];
    const res = await ejecutarLista([['tab_procesos', bP], ...cats]);
    const bloques = limpiar(res);
    const catalogos = { estados: bloques.estados?.filas || [], aliados: bloques.aliados?.filas || [] };
    delete bloques.estados; delete bloques.aliados;
    return { dias: d, bloques, catalogos, generadoEn: new Date().toISOString() };
  });
}

async function pagares({ dias, top }) {
  const d = entero(dias, 7, 1, 90, 'Los días');
  const n = entero(top, 200, 10, 500, 'El tope');
  return conEsquema(async (esq) => {
    const res = await ejecutarLista(C.bloquesPagares(esq, { dias: d, top: n }));
    return { dias: d, bloques: limpiar(res), generadoEn: new Date().toISOString() };
  });
}

async function logs({ tabla, dias, top }) {
  const d = entero(dias, 1, 1, 90, 'Los días');
  const n = entero(top, 200, 10, 500, 'El tope');
  return conEsquema(async (esq) => {
    const { tablas, elegida, bloques: lista } = C.bloquesLogs(esq, { tabla, dias: d, top: n });
    const res = await ejecutarLista(lista);
    return { dias: d, tablas, tabla: elegida || null, bloques: limpiar(res), generadoEn: new Date().toISOString() };
  });
}

async function esquema({ forzar = false } = {}) {
  try {
    const { esq, error } = await obtenerEsquema({ forzar });
    return { descubierto: esq.descubierto, aviso: error || null, tablas: esq.resumen(), generadoEn: new Date().toISOString() };
  } catch (e) { throw aErrorConexion(e); }
}

function olvidarEsquema() { cacheEsquema = { en: 0, esq: null, error: null }; }

module.exports = {
  ErrorProspeccion, sqlSoloLectura, valorSeguro, sqlParaCopiar, ejecutarBloque, ejecutarLista, obtenerEsquema, olvidarEsquema,
  entero, documentoValido, enmascarar, calcularHallazgos, lineaTiempo,
  resumen, cargues, cargue, cliente, procesos, pagares, logs, esquema,
};
