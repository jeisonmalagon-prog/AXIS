// ==========================================================================
// Repositorio de queries del Catálogo de Datos.
//
// Guarda los scripts T-SQL que el equipo usa a diario (consultas de soporte, trazas,
// validaciones, etc.) con su análisis: tablas que tocan, JOIN que usan, parámetros,
// si modifican datos y a qué base pertenecen. Con eso el catálogo puede:
//   - buscar queries por texto o por tabla («¿qué queries usan Keyflow_Recipients?»),
//   - aprender relaciones entre tablas que no tienen llave foránea declarada,
//   - sugerir queries parecidas al armar una nueva.
//
// Reglas de la casa:
//   - una sola tabla (catalogo_queries); el usuario de producción no tiene DELETE, así
//     que «quitar» marca Eliminado = 1 (script crear_tabla_catalogo_queries.sql);
//   - sin la tabla, el módulo avisa qué script correr y el resto del catálogo sigue igual;
//   - al guardar, se enmascaran valores sensibles (claves, tokens, documentos, correos);
//   - todo el índice vive en memoria (cientos de queries): se recarga al escribir.
// ==========================================================================

const { esErrorDePrivilegios, tablaExiste, errorFaltaEsquema } = require('./esquemaSeguro');
const analisis = require('./queriesAnalisis');

const TABLA = 'catalogo_queries';
const MAX_CONSULTA = 100000;
const MAX_ARCHIVOS_LOTE = 40;

const SQL_CREAR_TABLA = `
  CREATE TABLE IF NOT EXISTS catalogo_queries (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    Titulo VARCHAR(200) NOT NULL,
    Descripcion VARCHAR(1000) NULL,
    Consulta LONGTEXT NOT NULL,
    Tipo VARCHAR(12) NOT NULL DEFAULT 'SELECT',
    NivelRiesgo VARCHAR(14) NOT NULL DEFAULT 'lectura',
    Modifica TINYINT(1) NOT NULL DEFAULT 0,
    BaseDatos VARCHAR(128) NULL,
    Archivo VARCHAR(300) NULL,
    Etiquetas VARCHAR(500) NULL,
    Analisis LONGTEXT NULL,
    Huella CHAR(40) NOT NULL,
    Enmascarado TINYINT(1) NOT NULL DEFAULT 0,
    Ejecuciones INT NOT NULL DEFAULT 0,
    UltimaEjecucion DATETIME NULL,
    Eliminado TINYINT(1) NOT NULL DEFAULT 0,
    CreadoPorId INT NULL,
    CreadoPorUsername VARCHAR(100) NULL,
    ActualizadoPorUsername VARCHAR(100) NULL,
    FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FechaActualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_catalogoqueries_estado (Eliminado, Tipo),
    INDEX idx_catalogoqueries_huella (Huella)
  )`;

let tablaLista = false;
let proximaRevision = 0;
let sinPrivilegios = false;

async function tablaDisponible(pool) {
  if (tablaLista) return true;
  if (Date.now() < proximaRevision) return false;
  if (await tablaExiste(pool, TABLA)) { tablaLista = true; return true; }
  if (!sinPrivilegios) {
    try {
      await pool.query(SQL_CREAR_TABLA);
      tablaLista = true;
      return true;
    } catch (err) {
      if (!esErrorDePrivilegios(err)) throw err;
      sinPrivilegios = true;
    }
  }
  proximaRevision = Date.now() + 60000;
  return false;
}

function errorSinTabla() {
  const e = errorFaltaEsquema('tabla catalogo_queries', TABLA);
  e.message = 'Falta crear la tabla del repositorio de queries. Ejecuta una sola vez crear_tabla_catalogo_queries.sql con una cuenta con privilegio CREATE.';
  e.estado = 409;
  return e;
}

// --------------------------------------------------------------------------
// Índice en memoria
// --------------------------------------------------------------------------
let cache = null; // { cargadoEn, filas: [], porId: Map, porHuella: Map, porTabla: Map }
const VIGENCIA_MS = 5 * 60 * 1000;

const sinAcentos = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function parseJson(txt, defecto) {
  try { return txt ? JSON.parse(txt) : defecto; } catch { return defecto; }
}

function filaAObjeto(f, { conConsulta = true } = {}) {
  const a = parseJson(f.Analisis, {});
  const o = {
    id: f.Id,
    titulo: f.Titulo,
    descripcion: f.Descripcion || '',
    tipo: f.Tipo,
    nivelRiesgo: f.NivelRiesgo,
    modifica: !!f.Modifica,
    baseDatos: f.BaseDatos || '',
    archivo: f.Archivo || '',
    etiquetas: String(f.Etiquetas || '').split(',').map((x) => x.trim()).filter(Boolean),
    tablas: a.tablas || [],
    joins: a.joins || [],
    parametros: a.parametros || [],
    procedimientos: a.procedimientos || [],
    remoto: !!a.remoto,
    usaOpenquery: !!a.usaOpenquery,
    filtros: Array.isArray(a.filtros) ? a.filtros : null,
    cfgConstructor: a.cfgConstructor || null,
    enmascarado: !!f.Enmascarado,
    ejecuciones: f.Ejecuciones || 0,
    ultimaEjecucion: f.UltimaEjecucion || null,
    creadoPor: f.CreadoPorUsername || '',
    fechaCreacion: f.FechaCreacion,
    fechaActualizacion: f.FechaActualizacion,
  };
  if (conConsulta) o.consulta = f.Consulta;
  else o.previa = String(f.Consulta || '').replace(/\s+/g, ' ').slice(0, 260);
  return o;
}

function claveTablaObj(t) {
  return `${(t.bd || '').toLowerCase()}.${(t.esquema || 'dbo').toLowerCase()}.${String(t.tabla || '').toLowerCase()}`;
}
const claveCorta = (t) => `${(t.esquema || 'dbo').toLowerCase()}.${String(t.tabla || '').toLowerCase()}`;

async function cargar(pool, forzar = false) {
  if (!forzar && cache && Date.now() - cache.cargadoEn < VIGENCIA_MS) return cache;
  const [filas] = await pool.query(`SELECT * FROM ${TABLA} WHERE Eliminado = 0 ORDER BY Id`);
  const nuevo = { cargadoEn: Date.now(), filas: [], porId: new Map(), porHuella: new Map(), porTabla: new Map() };
  for (const f of filas) {
    const o = filaAObjeto(f);
    if (o.filtros === null) {
      // Queries guardados antes de existir la extracción de filtros: se calculan una vez al cargar.
      try { o.filtros = analisis.analizarSql(o.consulta, { bd: o.baseDatos }).filtros || []; } catch { o.filtros = []; }
    }
    o._texto = sinAcentos([o.titulo, o.descripcion, o.archivo, o.etiquetas.join(' '), o.tablas.map((t) => `${t.bd}.${t.esquema}.${t.tabla}`).join(' ')].join(' | '));
    o._consulta = sinAcentos(o.consulta);
    o._huella = f.Huella;
    nuevo.filas.push(o);
    nuevo.porId.set(o.id, o);
    if (!nuevo.porHuella.has(f.Huella)) nuevo.porHuella.set(f.Huella, o.id);
    for (const t of o.tablas) {
      for (const k of [claveTablaObj(t), claveCorta(t)]) {
        if (!nuevo.porTabla.has(k)) nuevo.porTabla.set(k, new Set());
        nuevo.porTabla.get(k).add(o.id);
      }
    }
  }
  cache = nuevo;
  return cache;
}

function invalidar() { cache = null; }

function publico(o, { conConsulta = true } = {}) {
  const { _texto, _consulta, _huella, ...resto } = o;
  void _texto; void _consulta; void _huella;
  if (!conConsulta) {
    const { consulta, filtros, cfgConstructor, ...sinConsulta } = resto;
    void filtros; void cfgConstructor;
    return { ...sinConsulta, tieneConstructor: !!cfgConstructor, previa: String(consulta || '').replace(/\s+/g, ' ').slice(0, 260) };
  }
  return resto;
}

// --------------------------------------------------------------------------
// Preparación de una consulta para guardarla
// --------------------------------------------------------------------------
function etiquetasAuto(an, archivo) {
  const e = new Set();
  for (const t of an.tablas) { if (t.bd) e.add(t.bd.toLowerCase()); else if (t.servidor) e.add(t.servidor.toLowerCase()); }
  if (an.modifica) e.add('modifica-datos');
  if (an.usaOpenquery) e.add('as400');
  if (/flexi/i.test(archivo || '')) e.add('flexidigital');
  return [...e].slice(0, 8);
}

function baseDeAnalisis(an) {
  const cuenta = new Map();
  for (const t of an.tablas) {
    const k = t.bd || t.servidor || '';
    if (k) cuenta.set(k, (cuenta.get(k) || 0) + 1);
  }
  let mejor = an.bd || '';
  let n = 0;
  for (const [k, v] of cuenta) if (v > n) { mejor = k; n = v; }
  return mejor;
}

// La configuración del constructor guiado se guarda tal cual (acotada) para poder reabrir el query armado.
function limpiarConfig(config) {
  if (!config || typeof config !== 'object') return null;
  try {
    const txt = JSON.stringify(config);
    if (txt.length > 20000) return null;
    return JSON.parse(txt);
  } catch { return null; }
}

function prepararConsulta({ titulo, descripcion, consulta, etiquetas, archivo, bd, config }, { enmascarar = true } = {}) {
  let texto = analisis.normalizarSaltos(consulta).trim();
  if (!texto) return { error: 'La consulta está vacía.' };
  if (texto.length > MAX_CONSULTA) return { error: `La consulta supera ${MAX_CONSULTA.toLocaleString('es-CO')} caracteres.` };
  let cambios = { secretos: 0, personales: 0 };
  if (enmascarar) {
    const r = analisis.enmascarar(texto);
    texto = r.sql;
    cambios = r.cambios;
  }
  const an = analisis.analizarSql(texto, { bd });
  const sugerido = analisis.sugerirTitulo(texto, an);
  const tituloFinal = String(titulo || '').trim() || sugerido.titulo;
  const desc = descripcion !== undefined && descripcion !== null ? String(descripcion).trim() : sugerido.descripcion;
  const lista = Array.isArray(etiquetas)
    ? etiquetas.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
    : String(etiquetas || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const cfg = limpiarConfig(config);
  const tags = [...new Set([...lista, ...(lista.length ? [] : etiquetasAuto(an, archivo))])].slice(0, 12);
  return {
    valor: {
      titulo: tituloFinal.slice(0, 200),
      descripcion: desc.slice(0, 1000),
      consulta: texto,
      tipo: an.tipo === 'OTRO' ? 'SELECT' : an.tipo,
      nivelRiesgo: an.nivelRiesgo,
      modifica: an.modifica ? 1 : 0,
      baseDatos: baseDeAnalisis(an).slice(0, 128),
      archivo: String(archivo || '').slice(0, 300),
      etiquetas: tags.join(',').slice(0, 500),
      analisis: JSON.stringify({
        tablas: an.tablas.map((t) => ({ servidor: t.servidor, bd: t.bd, esquema: t.esquema, tabla: t.tabla, escribe: t.escribe })),
        joins: an.joins,
        parametros: an.parametros,
        procedimientos: an.procedimientos,
        remoto: an.remoto,
        usaOpenquery: an.usaOpenquery,
        filtros: an.filtros || [],
        ...(cfg ? { cfgConstructor: cfg } : {}),
      }),
      huella: an.huella,
      enmascarado: cambios.secretos + cambios.personales > 0 ? 1 : 0,
    },
    cambios,
    analisis: an,
  };
}

// --------------------------------------------------------------------------
// Lectura
// --------------------------------------------------------------------------
function puntuar(o, tokens) {
  let puntos = 0;
  for (const t of tokens) {
    let ok = false;
    if (sinAcentos(o.titulo).includes(t)) { puntos += 5; ok = true; }
    if (o.tablas.some((x) => sinAcentos(x.tabla).includes(t) || sinAcentos(`${x.bd}.${x.esquema}.${x.tabla}`).includes(t))) { puntos += 4; ok = true; }
    if (o.etiquetas.some((x) => sinAcentos(x).includes(t))) { puntos += 3; ok = true; }
    if (sinAcentos(o.descripcion).includes(t) || sinAcentos(o.archivo).includes(t)) { puntos += 2; ok = true; }
    if (o._consulta.includes(t)) { puntos += 1; ok = true; }
    if (!ok) return 0;
  }
  return puntos;
}

async function listar(pool, filtros = {}) {
  const c = await cargar(pool);
  const tokens = sinAcentos(filtros.q || '').split(/\s+/).filter((x) => x.length >= 2).slice(0, 8);
  const tabla = sinAcentos(filtros.tabla || '').trim();
  const bd = sinAcentos(filtros.bd || '').trim();
  const tipo = String(filtros.tipo || '').toUpperCase();
  const riesgo = String(filtros.riesgo || '');
  const etiqueta = sinAcentos(filtros.etiqueta || '').trim();
  let lista = c.filas;
  if (tabla) {
    const ids = c.porTabla.get(tabla) || new Set([...c.porTabla.entries()].filter(([k]) => k.endsWith(`.${tabla}`) || k === tabla).flatMap(([, v]) => [...v]));
    lista = lista.filter((o) => ids.has(o.id));
  }
  if (bd) lista = lista.filter((o) => sinAcentos(o.baseDatos) === bd || o.tablas.some((t) => sinAcentos(t.bd) === bd || sinAcentos(t.servidor) === bd));
  if (tipo) lista = lista.filter((o) => o.tipo === tipo);
  if (riesgo) lista = lista.filter((o) => o.nivelRiesgo === riesgo);
  if (etiqueta) lista = lista.filter((o) => o.etiquetas.some((x) => sinAcentos(x) === etiqueta));
  let ordenada;
  if (tokens.length) {
    ordenada = lista.map((o) => ({ o, p: puntuar(o, tokens) })).filter((x) => x.p > 0).sort((a, b) => b.p - a.p || b.o.ejecuciones - a.o.ejecuciones || a.o.id - b.o.id).map((x) => x.o);
  } else {
    ordenada = [...lista].sort((a, b) => b.ejecuciones - a.ejecuciones || b.id - a.id);
  }
  const total = ordenada.length;
  const limite = Math.max(1, Math.min(parseInt(filtros.limite, 10) || 50, 200));
  const desde = Math.max(0, parseInt(filtros.desde, 10) || 0);
  return { total, desde, limite, queries: ordenada.slice(desde, desde + limite).map((o) => publico(o, { conConsulta: false })) };
}

async function obtener(pool, id) {
  const c = await cargar(pool);
  const o = c.porId.get(Number(id));
  return o ? publico(o) : null;
}

async function resumen(pool) {
  const c = await cargar(pool);
  const porBd = new Map();
  const porTipo = new Map();
  const porTabla = new Map();
  const etiquetas = new Map();
  let modifican = 0;
  for (const o of c.filas) {
    porBd.set(o.baseDatos || '(sin base)', (porBd.get(o.baseDatos || '(sin base)') || 0) + 1);
    porTipo.set(o.tipo, (porTipo.get(o.tipo) || 0) + 1);
    if (o.modifica) modifican += 1;
    for (const t of o.tablas) porTabla.set(`${t.bd || t.servidor}.${t.esquema}.${t.tabla}`, (porTabla.get(`${t.bd || t.servidor}.${t.esquema}.${t.tabla}`) || 0) + 1);
    for (const e of o.etiquetas) etiquetas.set(e, (etiquetas.get(e) || 0) + 1);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    total: c.filas.length,
    modifican,
    porBase: top(porBd, 30).map(([nombre, total]) => ({ nombre, total })),
    porTipo: top(porTipo, 12).map(([nombre, total]) => ({ nombre, total })),
    tablasFrecuentes: top(porTabla, 15).map(([nombre, total]) => ({ nombre, total })),
    etiquetas: top(etiquetas, 30).map(([nombre, total]) => ({ nombre, total })),
  };
}

// Queries que usan una tabla (por bd.esquema.tabla, o esquema.tabla si no se conoce la base).
async function queriesDeTabla(pool, ref, limite = 30) {
  const c = await cargar(pool);
  const tabla = String(ref.tabla || ref.n || '').toLowerCase();
  const esq = String(ref.esquema || ref.es || 'dbo').toLowerCase();
  const bd = String(ref.bd || '').toLowerCase();
  if (!tabla) return [];
  const ids = new Set();
  const completa = c.porTabla.get(`${bd}.${esq}.${tabla}`);
  if (completa) completa.forEach((i) => ids.add(i));
  const corta = c.porTabla.get(`${esq}.${tabla}`);
  if (corta) {
    for (const i of corta) {
      const o = c.porId.get(i);
      const t = o && o.tablas.find((x) => claveCorta(x) === `${esq}.${tabla}`);
      if (!bd || !t || !t.bd || t.bd.toLowerCase() === bd) ids.add(i);
    }
  }
  return [...ids].map((i) => c.porId.get(i)).filter(Boolean)
    .sort((a, b) => Number(a.modifica) - Number(b.modifica) || b.ejecuciones - a.ejecuciones || a.id - b.id)
    .slice(0, limite).map((o) => publico(o, { conConsulta: false }));
}

// Queries parecidas: comparten tablas (Jaccard sobre esquema.tabla).
async function similares(pool, id, limite = 8) {
  const c = await cargar(pool);
  const base = c.porId.get(Number(id));
  if (!base) return [];
  const a = new Set(base.tablas.map(claveCorta));
  if (!a.size) return [];
  const res = [];
  for (const o of c.filas) {
    if (o.id === base.id) continue;
    const b = new Set(o.tablas.map(claveCorta));
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    if (!inter) continue;
    res.push({ o, s: inter / (a.size + b.size - inter) });
  }
  return res.sort((x, y) => y.s - x.s || x.o.id - y.o.id).slice(0, limite).map((x) => ({ ...publico(x.o, { conConsulta: false }), similitud: Math.round(x.s * 100) }));
}

// Relaciones usadas en los queries del equipo (aprendidas de los JOIN reales).
async function joinsAprendidos(pool) {
  const c = await cargar(pool);
  const m = new Map();
  for (const o of c.filas) {
    for (const j of o.joins) {
      const kA = `${claveTablaObj(j.a)}.${String(j.a.columna).toLowerCase()}`;
      const kB = `${claveTablaObj(j.b)}.${String(j.b.columna).toLowerCase()}`;
      const clave = kA < kB ? `${kA}=${kB}` : `${kB}=${kA}`;
      let r = m.get(clave);
      if (!r) { r = { a: kA < kB ? j.a : j.b, b: kA < kB ? j.b : j.a, usos: 0, queries: [] }; m.set(clave, r); }
      r.usos += 1;
      if (r.queries.length < 20) r.queries.push(o.id);
    }
  }
  return [...m.values()].sort((x, y) => y.usos - x.usos);
}

// --------------------------------------------------------------------------
// Escritura
// --------------------------------------------------------------------------
const quien = (req) => ({ id: req?.user?.id ?? null, usuario: String(req?.user?.username || req?.user?.nombre || '').slice(0, 100) || null });

async function crear(pool, req, entrada, opciones = {}) {
  const p = prepararConsulta(entrada, opciones);
  if (p.error) return { error: p.error };
  const c = await cargar(pool);
  const duplicado = c.porHuella.get(p.valor.huella);
  if (duplicado && !opciones.permitirDuplicado) return { duplicadoDe: duplicado };
  const u = quien(req);
  const v = p.valor;
  const [r] = await pool.query(
    `INSERT INTO ${TABLA} (Titulo, Descripcion, Consulta, Tipo, NivelRiesgo, Modifica, BaseDatos, Archivo, Etiquetas, Analisis, Huella, Enmascarado, CreadoPorId, CreadoPorUsername)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [v.titulo, v.descripcion || null, v.consulta, v.tipo, v.nivelRiesgo, v.modifica, v.baseDatos || null, v.archivo || null, v.etiquetas || null, v.analisis, v.huella, v.enmascarado, u.id, u.usuario]
  );
  invalidar();
  return { id: r.insertId, cambios: p.cambios, modifica: !!v.modifica };
}

async function actualizar(pool, req, id, entrada, opciones = {}) {
  const c = await cargar(pool);
  const actual = c.porId.get(Number(id));
  if (!actual) return { noEncontrado: true };
  const u = quien(req);
  const consultaNueva = entrada.consulta !== undefined && analisis.normalizarSaltos(entrada.consulta).trim() !== actual.consulta.trim();
  if (consultaNueva) {
    const p = prepararConsulta({
      titulo: entrada.titulo !== undefined ? entrada.titulo : actual.titulo,
      descripcion: entrada.descripcion !== undefined ? entrada.descripcion : actual.descripcion,
      consulta: entrada.consulta,
      etiquetas: entrada.etiquetas !== undefined ? entrada.etiquetas : actual.etiquetas,
      archivo: entrada.archivo !== undefined ? entrada.archivo : actual.archivo,
      bd: actual.baseDatos,
      config: entrada.config !== undefined ? entrada.config : actual.cfgConstructor,
    }, opciones);
    if (p.error) return { error: p.error };
    const v = p.valor;
    await pool.query(
      `UPDATE ${TABLA} SET Titulo=?, Descripcion=?, Consulta=?, Tipo=?, NivelRiesgo=?, Modifica=?, BaseDatos=?, Archivo=?, Etiquetas=?, Analisis=?, Huella=?, Enmascarado=?, ActualizadoPorUsername=? WHERE Id=? AND Eliminado=0`,
      [v.titulo, v.descripcion || null, v.consulta, v.tipo, v.nivelRiesgo, v.modifica, v.baseDatos || null, v.archivo || null, v.etiquetas || null, v.analisis, v.huella, v.enmascarado, u.usuario, actual.id]
    );
  } else {
    const titulo = entrada.titulo !== undefined ? String(entrada.titulo).trim().slice(0, 200) : actual.titulo;
    if (!titulo) return { error: 'El título no puede quedar vacío.' };
    const descripcion = entrada.descripcion !== undefined ? String(entrada.descripcion).trim().slice(0, 1000) : actual.descripcion;
    const etiquetas = entrada.etiquetas !== undefined
      ? (Array.isArray(entrada.etiquetas) ? entrada.etiquetas : String(entrada.etiquetas).split(','))
        .map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 12).join(',').slice(0, 500)
      : actual.etiquetas.join(',');
    await pool.query(`UPDATE ${TABLA} SET Titulo=?, Descripcion=?, Etiquetas=?, ActualizadoPorUsername=? WHERE Id=? AND Eliminado=0`,
      [titulo, descripcion || null, etiquetas || null, u.usuario, actual.id]);
  }
  invalidar();
  return { id: actual.id };
}

async function quitar(pool, req, id) {
  const c = await cargar(pool);
  const actual = c.porId.get(Number(id));
  if (!actual) return false;
  await pool.query(`UPDATE ${TABLA} SET Eliminado = 1, ActualizadoPorUsername = ? WHERE Id = ?`, [quien(req).usuario, actual.id]);
  invalidar();
  return true;
}

async function registrarEjecucion(pool, id) {
  try {
    await pool.query(`UPDATE ${TABLA} SET Ejecuciones = Ejecuciones + 1, UltimaEjecucion = NOW() WHERE Id = ?`, [Number(id)]);
    invalidar();
  } catch (e) {
    console.error('[catalogo-queries] No se pudo contar la ejecución:', e.message);
  }
}

// Importación por lotes. `archivos`: [{ nombre, contenido }] (texto ya decodificado por el navegador).
const RE_TITULO_GENERICO = /^(Consulta|Script|Actualización|Borrado|Inserción|Ejecución|Merge|Truncado|Cambio de estructura)( de |$)/;

// Divide los archivos en queries ya analizados (sin escribir nada). Devuelve { items, vacias, errores, archivos }.
function prepararArchivos(archivos, { dividir = true, enmascarar = true } = {}) {
  const salida = { items: [], archivos: [], vacias: 0, errores: [] };
  for (const a of archivos) {
    const nombre = String(a?.nombre || 'sin nombre').slice(0, 300);
    const base = nombre.replace(/\.[^.]+$/, '');
    const info = { nombre, bloques: 0 };
    try {
      const texto = analisis.normalizarSaltos(a?.contenido);
      if (!texto.trim()) { salida.vacias += 1; info.error = 'Archivo vacío.'; salida.archivos.push(info); continue; }
      if (texto.length > 400000) { info.error = 'Archivo demasiado grande (máx. 400 KB).'; salida.errores.push(`${nombre}: demasiado grande`); salida.archivos.push(info); continue; }
      const bloques = dividir ? analisis.dividirBloques(texto) : [{ texto: texto.trim(), bd: '', kind: 'TODO' }];
      info.bloques = bloques.length;
      let n = 0;
      for (const b of bloques) {
        if (!b.texto.trim() || !/[A-Za-z]/.test(analisis.escanear(b.texto).codigo)) continue;
        const p = prepararConsulta({ consulta: b.texto, archivo: nombre, bd: b.bd }, { enmascarar });
        if (p.error) { salida.errores.push(`${nombre}: ${p.error}`); continue; }
        n += 1;
        // título: si no hay comentario útil y el archivo es de un solo bloque, usar el nombre del archivo
        if (RE_TITULO_GENERICO.test(p.valor.titulo)) {
          p.valor.titulo = (bloques.length === 1
            ? base.replace(/[_]+/g, ' ')
            : `${base.replace(/[_]+/g, ' ')} · ${p.valor.titulo}`).slice(0, 200);
        }
        salida.items.push({ valor: p.valor, analisis: p.analisis, archivo: nombre, orden: n });
      }
    } catch (e) {
      salida.errores.push(`${nombre}: ${e.message}`);
      info.error = e.message;
    }
    salida.archivos.push(info);
  }
  return salida;
}

async function insertarValores(pool, u, valores) {
  for (let i = 0; i < valores.length; i += 40) {
    const trozo = valores.slice(i, i + 40);
    const marcas = trozo.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params = trozo.flatMap((v) => [v.titulo, v.descripcion || null, v.consulta, v.tipo, v.nivelRiesgo, v.modifica, v.baseDatos || null, v.archivo || null, v.etiquetas || null, v.analisis, v.huella, v.enmascarado, u.id, u.usuario]);
    await pool.query(
      `INSERT INTO ${TABLA} (Titulo, Descripcion, Consulta, Tipo, NivelRiesgo, Modifica, BaseDatos, Archivo, Etiquetas, Analisis, Huella, Enmascarado, CreadoPorId, CreadoPorUsername) VALUES ${marcas}`,
      params
    );
  }
}

// Vista previa: qué se crearía (con título editable) sin guardar nada.
async function previaImportacion(pool, archivos, { dividir = true, enmascarar = true } = {}) {
  if (!Array.isArray(archivos) || !archivos.length) return { error: 'No llegaron archivos.' };
  if (archivos.length > MAX_ARCHIVOS_LOTE) return { error: `Envía máximo ${MAX_ARCHIVOS_LOTE} archivos por lote.` };
  const c = await cargar(pool, true);
  const vistos = new Map();
  const r = prepararArchivos(archivos, { dividir, enmascarar });
  const items = r.items.map((it) => {
    const v = it.valor;
    const repetidoEnLote = vistos.get(v.huella);
    if (!repetidoEnLote) vistos.set(v.huella, true);
    const enRepo = c.porHuella.get(v.huella) || null;
    return {
      archivo: it.archivo, orden: it.orden, titulo: v.titulo, descripcion: v.descripcion, etiquetas: v.etiquetas.split(',').filter(Boolean),
      tipo: v.tipo, nivelRiesgo: v.nivelRiesgo, modifica: !!v.modifica, baseDatos: v.baseDatos, enmascarado: !!v.enmascarado,
      huella: v.huella, duplicadoDe: enRepo, repetidoEnLote: !!repetidoEnLote,
      tablas: it.analisis.tablas.slice(0, 8).map((t) => `${t.bd ? `${t.bd}.` : ''}${t.esquema || 'dbo'}.${t.tabla}`),
      nTablas: it.analisis.tablas.length,
      previa: v.consulta.replace(/\s+/g, ' ').slice(0, 220),
      consulta: v.consulta,
    };
  });
  return { items, archivos: r.archivos, vacias: r.vacias, errores: r.errores };
}

// Guarda los queries elegidos en la vista previa (con los títulos que puso la persona).
async function importarItems(pool, req, items, { enmascarar = true } = {}) {
  if (!Array.isArray(items) || !items.length) return { error: 'No hay queries para guardar.' };
  if (items.length > 100) return { error: 'Guarda máximo 100 queries por vez.' };
  const c = await cargar(pool, true);
  const huellas = new Set(c.porHuella.keys());
  const u = quien(req);
  const resultado = { creadas: 0, duplicadas: 0, modifican: 0, enmascaradas: 0, errores: [], ids: [] };
  const pendientes = [];
  for (const it of items) {
    const p = prepararConsulta({
      titulo: it?.titulo, descripcion: it?.descripcion, consulta: it?.consulta, etiquetas: it?.etiquetas,
      archivo: it?.archivo, bd: it?.baseDatos,
    }, { enmascarar });
    if (p.error) { resultado.errores.push(`${String(it?.titulo || 'sin título').slice(0, 60)}: ${p.error}`); continue; }
    if (huellas.has(p.valor.huella)) { resultado.duplicadas += 1; continue; }
    huellas.add(p.valor.huella);
    pendientes.push(p.valor);
    if (p.valor.modifica) resultado.modifican += 1;
    if (p.valor.enmascarado) resultado.enmascaradas += 1;
  }
  await insertarValores(pool, u, pendientes);
  resultado.creadas = pendientes.length;
  invalidar();
  return resultado;
}

async function importar(pool, req, archivos, { dividir = true, enmascarar = true } = {}) {
  if (!Array.isArray(archivos) || !archivos.length) return { error: 'No llegaron archivos.' };
  if (archivos.length > MAX_ARCHIVOS_LOTE) return { error: `Envía máximo ${MAX_ARCHIVOS_LOTE} archivos por lote.` };
  const c = await cargar(pool, true);
  const huellas = new Set(c.porHuella.keys());
  const u = quien(req);
  const r = prepararArchivos(archivos, { dividir, enmascarar });
  const resultado = { archivos: r.archivos, creadas: 0, duplicadas: 0, vacias: r.vacias, modifican: 0, procedimientos: 0, enmascaradas: 0, errores: r.errores };
  const porArchivo = new Map(r.archivos.map((a) => [a.nombre, a]));
  const pendientes = [];
  for (const it of r.items) {
    const v = it.valor;
    const info = porArchivo.get(it.archivo);
    if (huellas.has(v.huella)) { if (info) info.duplicadas = (info.duplicadas || 0) + 1; resultado.duplicadas += 1; continue; }
    huellas.add(v.huella);
    pendientes.push(v);
    if (info) info.creadas = (info.creadas || 0) + 1;
    if (v.modifica) resultado.modifican += 1;
    if (v.nivelRiesgo === 'procedimiento') resultado.procedimientos += 1;
    if (v.enmascarado) resultado.enmascaradas += 1;
  }
  await insertarValores(pool, u, pendientes);
  resultado.creadas = pendientes.length;
  invalidar();
  return resultado;
}

module.exports = {
  tablaDisponible,
  errorSinTabla,
  listar,
  obtener,
  resumen,
  queriesDeTabla,
  similares,
  joinsAprendidos,
  crear,
  actualizar,
  quitar,
  importar,
  previaImportacion,
  importarItems,
  publico,
  registrarEjecucion,
  prepararConsulta,
  cargar,
  invalidar,
  TABLA,
};
