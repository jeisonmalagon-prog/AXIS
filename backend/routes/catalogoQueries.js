const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireEditPermission } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const catalogo = require('../utils/catalogoDatos');
const origenesDb = require('../utils/catalogoOrigenes');
const sesionCatalogo = require('../utils/catalogoSesion');
const { ejecutarLectura, mensajeErrorConsulta } = require('../utils/catalogoExtraccion');
const repo = require('../utils/queriesRepositorio');
const analisis = require('../utils/queriesAnalisis');
const mapa = require('../utils/queriesMapa');
const gen = require('../utils/queriesGenerador');
const ia = require('../utils/queriesIa');

// ==========================================================================
// Repositorio de queries + constructor guiado + asistente IA + ejecución de lectura.
// Se monta dentro del router del Catálogo de Datos (/api/catalogo-datos/queries), que ya exige
// sesión y el módulo CATALOGO_DATOS. Reglas:
//   - consultar el repositorio, armar y sugerir queries: cualquiera con el módulo;
//   - guardar, editar, quitar, importar y EJECUTAR: requiere permiso de edición en el módulo;
//   - ejecutar solo corre un SELECT único (validado), con tope de filas y de tiempo, por la cuenta de
//     solo lectura del origen, y queda en la auditoría general.
// ==========================================================================

async function auditar(req, datos) {
  try {
    await registrarEventoGeneral(await getPool(), req, { modulo: 'CATALOGO_DATOS', ...datos });
  } catch (error) {
    console.error('[catalogo-queries] No se pudo registrar la auditoría:', error.message);
  }
}

const ventanas = new Map();
function excede(clave, limite) {
  const ahora = Date.now();
  const recientes = (ventanas.get(clave) || []).filter((t) => ahora - t < 60000);
  if (recientes.length >= limite) { ventanas.set(clave, recientes); return true; }
  recientes.push(ahora);
  ventanas.set(clave, recientes);
  return false;
}

const MSG_SIN_TABLA = 'Falta crear la tabla del repositorio de queries (crear_tabla_catalogo_queries.sql).';

function manejarError(res, error, contexto) {
  if (error && error.estado === 409) return res.status(409).json({ error: error.message, sinTabla: true });
  console.error(`Error en ${contexto}:`, error);
  return res.status(500).json({ error: mensajeErrorAmigable(error, { contexto }) });
}

// Garantiza la tabla; si falta, 409 con el aviso.
async function conRepositorio(req, res, fn) {
  try {
    const pool = await getPool();
    if (!(await repo.tablaDisponible(pool))) return res.status(409).json({ error: MSG_SIN_TABLA, sinTabla: true });
    return await fn(pool);
  } catch (error) {
    return manejarError(res, error, 'el repositorio de queries');
  }
}

// El repositorio es opcional para el constructor: sin él se arma igual (sin JOIN aprendidos).
async function aprendidosSeguros() {
  try {
    const pool = await getPool();
    if (!(await repo.tablaDisponible(pool))) return { pool, aprendidos: [], disponible: false };
    return { pool, aprendidos: await repo.joinsAprendidos(pool), disponible: true };
  } catch (e) {
    console.error('[catalogo-queries] No se pudieron leer los JOIN aprendidos:', e.message);
    return { pool: null, aprendidos: [], disponible: false };
  }
}

const refDe = (q) => ({ o: String(q.o || ''), bd: String(q.bd || ''), es: String(q.es || ''), n: String(q.n || '') });
const refsDe = (lista) => (Array.isArray(lista) ? lista.slice(0, 8).map(refDe) : []);

// --------------------------------------------------------------------------
// Constructor, sugerencias, IA, análisis (lectura)
// --------------------------------------------------------------------------
router.post('/constructor/sugerir', async (req, res) => {
  try {
    const refs = refsDe(req.body?.tablas);
    if (!refs.length) return res.status(400).json({ error: 'Elige al menos una tabla.' });
    const { pool, aprendidos, disponible } = await aprendidosSeguros();
    const tablas = refs.map((r) => catalogo.tablaPorRef(r));
    if (tablas.some((t) => !t)) return res.status(404).json({ error: 'Alguna tabla ya no está en el catálogo: actualiza el catálogo.' });
    const relacionadas = gen.relacionadasDe(refs, aprendidos);
    let filtrosEquipo = [];
    if (disponible) {
      try { filtrosEquipo = await mapa.filtrosDeTabla(pool, refs[0]); } catch (e) { console.error('[catalogo-queries] filtros del equipo:', e.message); }
    }
    const recetas = gen.recetas(refs, aprendidos, filtrosEquipo);
    let queries = [];
    if (disponible) {
      const vistos = new Map();
      for (const t of tablas) {
        for (const q of await repo.queriesDeTabla(pool, { bd: t.bd, esquema: t.esquema, tabla: t.nombre }, 20)) {
          const x = vistos.get(q.id) || { q, n: 0 };
          x.n += 1;
          vistos.set(q.id, x);
        }
      }
      queries = [...vistos.values()].sort((a, b) => b.n - a.n || Number(a.q.modifica) - Number(b.q.modifica)).slice(0, 10).map((x) => ({ ...x.q, tablasEnComun: x.n }));
    }
    res.json({ relacionadas, recetas, queries, filtrosEquipo, repositorio: disponible });
  } catch (error) {
    manejarError(res, error, 'las sugerencias de queries');
  }
});

router.post('/constructor/armar', async (req, res) => {
  try {
    const c = req.body?.config || {};
    const { aprendidos } = await aprendidosSeguros();
    const r = gen.construir({ ...c, tablas: refsDe(c.tablas) }, { aprendidos });
    if (r.error) return res.status(422).json(r);
    res.json(r);
  } catch (error) {
    manejarError(res, error, 'el armado de queries');
  }
});

router.post('/constructor/ia', async (req, res) => {
  if (excede(`qia:${req.user.id}`, 6)) return res.status(429).json({ error: 'Demasiadas consultas a la IA seguidas. Espera un minuto.' });
  try {
    const { pool, aprendidos, disponible } = await aprendidosSeguros();
    const repoPool = pool || await getPool();
    const r = await ia.generarConIa(
      { pregunta: req.body?.pregunta, origenId: req.body?.origenId || null, tablasPreferidas: refsDe(req.body?.tablas) },
      { pool: repoPool, repo: disponible ? repo : { listar: async () => ({ queries: [] }), obtener: async () => null }, aprendidos },
    );
    if (r.error) return res.status(422).json(r);
    await auditar(req, { entidad: 'Query', entidadId: 'ia', entidadNombre: 'Asistente de queries (IA)', accion: 'EJECUCION', detalle: `Petición: ${String(req.body?.pregunta || '').slice(0, 200)}` });
    res.json(r);
  } catch (error) {
    if (error && (error.estado === 502 || error.estado === 504)) return res.status(error.estado).json({ error: error.message });
    manejarError(res, error, 'el asistente de queries');
  }
});

router.post('/sugerir-nombre', (req, res) => {
  try {
    const texto = String(req.body?.consulta || '');
    if (!texto.trim()) return res.status(400).json({ error: 'No hay consulta para ponerle nombre.' });
    if (texto.length > 100000) return res.status(400).json({ error: 'La consulta es demasiado larga.' });
    const p = repo.prepararConsulta({ consulta: texto, archivo: req.body?.archivo }, { enmascarar: true });
    if (p.error) return res.status(400).json({ error: p.error });
    res.json({ titulo: p.valor.titulo, descripcion: p.valor.descripcion, etiquetas: p.valor.etiquetas.split(',').filter(Boolean) });
  } catch (error) {
    manejarError(res, error, 'la sugerencia de nombre');
  }
});

router.post('/analizar', (req, res) => {
  try {
    const texto = String(req.body?.consulta || '');
    if (!texto.trim()) return res.status(400).json({ error: 'La consulta está vacía.' });
    if (texto.length > 100000) return res.status(400).json({ error: 'La consulta es demasiado larga.' });
    const enmascarar = req.body?.enmascarar !== false;
    const p = repo.prepararConsulta({ consulta: texto, titulo: req.body?.titulo, descripcion: req.body?.descripcion, archivo: req.body?.archivo }, { enmascarar });
    if (p.error) return res.status(400).json({ error: p.error });
    const partes = analisis.separarUse(p.valor.consulta);
    const v = analisis.validarSoloLectura(partes.sql);
    const an = p.analisis;
    res.json({
      titulo: p.valor.titulo, descripcion: p.valor.descripcion, etiquetas: p.valor.etiquetas.split(',').filter(Boolean),
      tipo: p.valor.tipo, nivelRiesgo: p.valor.nivelRiesgo, modifica: !!p.valor.modifica, baseDatos: p.valor.baseDatos,
      tablas: an.tablas, joins: an.joins, parametros: an.parametros, procedimientos: an.procedimientos,
      enmascarado: !!p.valor.enmascarado, cambios: p.cambios, consultaFinal: p.valor.consulta,
      ejecutable: v.ok, motivoNoEjecutable: v.ok ? '' : v.motivo,
    });
  } catch (error) {
    manejarError(res, error, 'el análisis de la consulta');
  }
});

// --------------------------------------------------------------------------
// Repositorio (lectura)
// --------------------------------------------------------------------------
router.get('/resumen', async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await repo.tablaDisponible(pool))) return res.json({ tabla: false });
    res.json({ tabla: true, ...(await repo.resumen(pool)) });
  } catch (error) {
    manejarError(res, error, 'el resumen del repositorio de queries');
  }
});

// Relación con el esquema del catálogo (mapa estelar).
router.get('/mapa/resumen', async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await repo.tablaDisponible(pool))) return res.json({ tabla: false, bases: [], puentes: [], total: 0 });
    res.json({ tabla: true, ...(await mapa.porBase(pool)) });
  } catch (error) {
    manejarError(res, error, 'el mapa de queries');
  }
});

router.get('/mapa/base', async (req, res) => {
  try {
    const o = String(req.query.o || '').slice(0, 40);
    const bd = String(req.query.bd || '').slice(0, 128);
    if (!o || !bd) return res.status(400).json({ error: 'Indica el servidor y la base.' });
    const pool = await getPool();
    if (!(await repo.tablaDisponible(pool))) return res.json({ tabla: false, o, bd, total: 0, tablas: [], joins: [] });
    res.json({ tabla: true, ...(await mapa.base(pool, o, bd)) });
  } catch (error) {
    manejarError(res, error, 'el mapa de queries de la base');
  }
});

router.get('/mapa/tabla', async (req, res) => {
  try {
    const r = refDe(req.query);
    if (!r.o || !r.n) return res.status(400).json({ error: 'Indica la tabla.' });
    const pool = await getPool();
    if (!(await repo.tablaDisponible(pool))) return res.json({ tabla: false, total: 0, queries: [], relacionadas: [], columnas: [], filtros: [] });
    const d = await mapa.tabla(pool, r);
    if (!d) return res.status(404).json({ error: 'Esa tabla ya no está en el catálogo.' });
    res.json({ tabla: true, ...d });
  } catch (error) {
    manejarError(res, error, 'los queries de la tabla');
  }
});

router.get('/', (req, res) => conRepositorio(req, res, async (pool) => {
  const q = req.query;
  res.json(await repo.listar(pool, {
    q: String(q.q || '').slice(0, 120), tabla: String(q.tabla || '').slice(0, 120), bd: String(q.bd || '').slice(0, 128),
    tipo: String(q.tipo || '').slice(0, 12), riesgo: String(q.riesgo || '').slice(0, 14), etiqueta: String(q.etiqueta || '').slice(0, 60),
    desde: q.desde, limite: q.limite,
  }));
}));

router.get('/de-tabla', (req, res) => conRepositorio(req, res, async (pool) => {
  const r = refDe(req.query);
  const t = catalogo.tablaPorRef(r);
  const ref = t ? { bd: t.bd, esquema: t.esquema, tabla: t.nombre } : { bd: r.bd, esquema: r.es, tabla: r.n };
  res.json({ queries: await repo.queriesDeTabla(pool, ref, 40) });
}));

router.get('/:id(\\d+)', (req, res) => conRepositorio(req, res, async (pool) => {
  const q = await repo.obtener(pool, req.params.id);
  if (!q) return res.status(404).json({ error: 'Ese query ya no existe en el repositorio.' });
  let extra = {};
  try { extra = mapa.enriquecer(q); } catch (e) { console.error('[catalogo-queries] enriquecer:', e.message); }
  res.json({ ...q, ...extra });
}));

router.get('/:id(\\d+)/similares', (req, res) => conRepositorio(req, res, async (pool) => {
  res.json({ queries: await repo.similares(pool, req.params.id, 8) });
}));

// --------------------------------------------------------------------------
// Repositorio (escritura): permiso de edición en el módulo
// --------------------------------------------------------------------------
router.post('/', requireEditPermission, (req, res) => conRepositorio(req, res, async (pool) => {
  const b = req.body || {};
  const r = await repo.crear(pool, req, {
    titulo: b.titulo, descripcion: b.descripcion, consulta: b.consulta, etiquetas: b.etiquetas, archivo: b.archivo, config: b.config,
  }, { enmascarar: b.enmascarar !== false, permitirDuplicado: !!b.permitirDuplicado });
  if (r.error) return res.status(400).json({ error: r.error });
  if (r.duplicadoDe) return res.status(409).json({ error: 'Ya existe un query igual en el repositorio.', duplicadoDe: r.duplicadoDe });
  const q = await repo.obtener(pool, r.id);
  await auditar(req, { entidad: 'Query', entidadId: String(r.id), entidadNombre: q?.titulo || `Query ${r.id}`, accion: 'CREACION', detalle: `Query guardado en el repositorio (${q?.tipo || ''}${q?.modifica ? ', modifica datos' : ''}).` });
  res.status(201).json({ ...q, cambios: r.cambios });
}));

router.put('/:id(\\d+)', requireEditPermission, (req, res) => conRepositorio(req, res, async (pool) => {
  const b = req.body || {};
  const r = await repo.actualizar(pool, req, req.params.id, { titulo: b.titulo, descripcion: b.descripcion, consulta: b.consulta, etiquetas: b.etiquetas, archivo: b.archivo, config: b.config }, { enmascarar: b.enmascarar !== false });
  if (r.noEncontrado) return res.status(404).json({ error: 'Ese query ya no existe en el repositorio.' });
  if (r.error) return res.status(400).json({ error: r.error });
  const q = await repo.obtener(pool, r.id);
  await auditar(req, { entidad: 'Query', entidadId: String(r.id), entidadNombre: q?.titulo || `Query ${r.id}`, accion: 'MODIFICACION', detalle: 'Query editado en el repositorio.' });
  res.json(q);
}));

router.delete('/:id(\\d+)', requireEditPermission, (req, res) => conRepositorio(req, res, async (pool) => {
  const q = await repo.obtener(pool, req.params.id);
  if (!q) return res.status(404).json({ error: 'Ese query ya no existe en el repositorio.' });
  await repo.quitar(pool, req, req.params.id);
  await auditar(req, { entidad: 'Query', entidadId: String(q.id), entidadNombre: q.titulo, accion: 'ELIMINACION', detalle: 'Query quitado del repositorio (se conserva marcado como eliminado).' });
  res.json({ ok: true });
}));

router.post('/importar/previa', requireEditPermission, (req, res) => conRepositorio(req, res, async (pool) => {
  if (excede(`qimp:${req.user.id}`, 30)) return res.status(429).json({ error: 'Demasiadas importaciones seguidas. Espera un minuto.' });
  const b = req.body || {};
  const archivos = Array.isArray(b.archivos) ? b.archivos.map((a) => ({ nombre: String(a?.nombre || '').slice(0, 300), contenido: typeof a?.contenido === 'string' ? a.contenido : '' })) : [];
  const r = await repo.previaImportacion(pool, archivos, { dividir: b.dividir !== false, enmascarar: b.enmascarar !== false });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
}));

router.post('/importar/items', requireEditPermission, (req, res) => conRepositorio(req, res, async (pool) => {
  if (excede(`qimp:${req.user.id}`, 30)) return res.status(429).json({ error: 'Demasiadas importaciones seguidas. Espera un minuto.' });
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items.slice(0, 100).map((x) => ({
    titulo: String(x?.titulo || '').slice(0, 200), descripcion: String(x?.descripcion || '').slice(0, 1000),
    consulta: typeof x?.consulta === 'string' ? x.consulta.slice(0, 100000) : '', etiquetas: x?.etiquetas,
    archivo: String(x?.archivo || '').slice(0, 300), baseDatos: String(x?.baseDatos || '').slice(0, 128),
  })) : [];
  const r = await repo.importarItems(pool, req, items, { enmascarar: b.enmascarar !== false });
  if (r.error) return res.status(400).json({ error: r.error });
  await auditar(req, { entidad: 'Query', entidadId: 'importacion', entidadNombre: 'Importación de queries', accion: 'CREACION', detalle: `${r.creadas} query(s) nuevos desde la vista previa, ${r.duplicadas} repetido(s), ${r.modifican} que modifican datos.` });
  res.json(r);
}));

router.post('/importar', requireEditPermission, (req, res) => conRepositorio(req, res, async (pool) => {
  if (excede(`qimp:${req.user.id}`, 20)) return res.status(429).json({ error: 'Demasiadas importaciones seguidas. Espera un minuto.' });
  const b = req.body || {};
  const archivos = Array.isArray(b.archivos) ? b.archivos.map((a) => ({ nombre: String(a?.nombre || '').slice(0, 300), contenido: typeof a?.contenido === 'string' ? a.contenido : '' })) : [];
  const r = await repo.importar(pool, req, archivos, { dividir: b.dividir !== false, enmascarar: b.enmascarar !== false });
  if (r.error) return res.status(400).json({ error: r.error });
  await auditar(req, { entidad: 'Query', entidadId: 'importacion', entidadNombre: 'Importación de queries', accion: 'CREACION', detalle: `${archivos.length} archivo(s): ${r.creadas} nuevo(s), ${r.duplicadas} repetido(s), ${r.modifican} que modifican datos, ${r.enmascaradas} con valores enmascarados.` });
  res.json(r);
}));

// --------------------------------------------------------------------------
// Ejecución de SOLO LECTURA
// --------------------------------------------------------------------------
// El servidor es de todos, pero la consulta SIEMPRE se hace con las credenciales de quien la pide
// (las de su sesión del Catálogo de datos). Devuelve null si el servidor no existe o, si la persona no
// tiene credenciales para ese motor, { sinCredenciales: 'mensaje' }.
async function origenDePersona(pool, req, id) {
  const base = await origenesDb.obtenerOrigenInterno(pool, id);
  if (!base || base.activo === false) return null;
  const conCred = sesionCatalogo.conCredenciales(base, req.user?.username);
  if (!conCred) {
    return { id: base.id, nombre: base.nombre, sinCredenciales: `Falta tu usuario y clave de ${sesionCatalogo.nombreMotor(base.motor)}: agrégalos en «Mis credenciales» del Catálogo de datos.` };
  }
  return conCred;
}

let enCurso = 0;
const MAX_EN_CURSO = 3;

router.post('/ejecutar', requireEditPermission, async (req, res) => {
  const b = req.body || {};
  const texto = String(b.sql || '');
  if (!texto.trim()) return res.status(400).json({ error: 'No hay consulta para ejecutar.' });
  if (!b.origenId) return res.status(400).json({ error: 'Elige el servidor donde se ejecuta.' });
  const partes = analisis.separarUse(texto);
  const v = analisis.validarSoloLectura(partes.sql);
  if (!v.ok) return res.status(400).json({ error: v.motivo, noEjecutable: true });
  if (/<VALOR>|<SECRETO>/.test(texto)) return res.status(400).json({ error: 'Reemplaza <VALOR> (o <SECRETO>) por el dato real antes de ejecutar.' });
  if (excede(`ejq:${req.user.id}`, 8)) return res.status(429).json({ error: 'Demasiadas ejecuciones seguidas. Espera un minuto.' });
  if (enCurso >= MAX_EN_CURSO) return res.status(429).json({ error: 'Hay varias consultas corriendo. Intenta de nuevo en unos segundos.' });

  enCurso += 1;
  let origen = null;
  try {
    const pool = await getPool();
    origen = await origenDePersona(pool, req, b.origenId);
    if (!origen) return res.status(404).json({ error: 'Ese servidor ya no está registrado.' });
    if (origen.sinCredenciales) return res.status(400).json({ error: origen.sinCredenciales, sinCredenciales: true });
    const info = catalogo.datosOrigen(origen.id);
    const bd = partes.bd || String(b.bd || '');
    if (bd && info && info.bases.length && !info.bases.some((x) => x.toLowerCase() === bd.toLowerCase())) {
      return res.status(400).json({ error: `La base «${bd}» no está en el catálogo de ${origen.nombre}.` });
    }
    const r = await ejecutarLectura(origen, { bd, sql: v.sql, maxFilas: 200, timeoutMs: 20000 });
    const resumenSql = v.sql.replace(/\s+/g, ' ').slice(0, 500);
    await auditar(req, {
      entidad: 'Query', entidadId: b.queryId ? String(b.queryId) : 'libre', entidadNombre: `Ejecución en ${origen.nombre}`,
      accion: 'EJECUCION', detalle: `Base ${bd || '(sin base)'}; ${r.filas.length}${r.truncado ? '+' : ''} fila(s) en ${r.duracionMs} ms. SQL: ${resumenSql}`,
    });
    if (b.queryId && (await repo.tablaDisponible(pool))) await repo.registrarEjecucion(pool, b.queryId);
    res.json({ columnas: r.columnas, filas: r.filas, truncado: r.truncado, duracionMs: r.duracionMs, maxFilas: 200, servidor: origen.nombre, baseDatos: bd });
  } catch (error) {
    const mensaje = mensajeErrorConsulta(error, origen);
    console.error('[catalogo-queries] Falló la ejecución:', error?.code || '', String(error?.message || '').slice(0, 200));
    await auditar(req, { entidad: 'Query', entidadId: b.queryId ? String(b.queryId) : 'libre', entidadNombre: `Ejecución fallida en ${origen?.nombre || b.origenId}`, accion: 'EJECUCION', detalle: `Error: ${mensaje.slice(0, 200)}` });
    res.status(error?.code === 'EREQUEST' ? 422 : 502).json({ error: mensaje });
  } finally {
    enCurso -= 1;
  }
});

// Valores más frecuentes de una columna (para armar filtros). Misma cuenta de solo lectura que ejecutar.
const RE_COLUMNA_PERSONAL = /pass|clave|contras|token|secret|\bpin\b|cvv|tarjeta|card|iban|cuenta|correo|e?mail|telefono|celular|direccion|nombre|apellido|firma|biometr/i;
// Documentos de identidad sí; el TIPO de documento (CC, NIT...) es un catálogo inofensivo.
const esColumnaSensible = (c) => RE_COLUMNA_PERSONAL.test(c) || (/document|cedula|c[eé]dula|identific|\bnit\b/i.test(c) && !/tipo/i.test(c));

router.post('/constructor/valores', requireEditPermission, async (req, res) => {
  const b = req.body || {};
  const ref = refDe(b.tabla || {});
  const columna = String(b.columna || '').slice(0, 128);
  if (!ref.n || !columna) return res.status(400).json({ error: 'Indica la tabla y la columna.' });
  if (esColumnaSensible(columna)) return res.status(400).json({ error: 'Esa columna parece tener datos personales o sensibles: no se listan sus valores.', sensible: true });
  const g = gen.sqlValoresFrecuentes(ref, columna, { muestra: 20000, max: 30 });
  if (g.error) return res.status(422).json({ error: g.error });
  if (excede(`qval:${req.user.id}`, 15)) return res.status(429).json({ error: 'Demasiadas consultas de valores seguidas. Espera un minuto.' });
  if (enCurso >= MAX_EN_CURSO) return res.status(429).json({ error: 'Hay varias consultas corriendo. Intenta de nuevo en unos segundos.' });
  enCurso += 1;
  let origen = null;
  try {
    const pool = await getPool();
    origen = await origenDePersona(pool, req, g.origenId);
    if (!origen) return res.status(404).json({ error: 'Ese servidor ya no está registrado.' });
    if (origen.sinCredenciales) return res.status(400).json({ error: origen.sinCredenciales, sinCredenciales: true });
    const r = await ejecutarLectura(origen, { bd: g.baseDatos, sql: g.sql, maxFilas: 30, timeoutMs: 10000 });
    res.json({
      columna: g.columna, muestra: g.muestra, duracionMs: r.duracionMs,
      valores: r.filas.map((f) => ({ valor: f[0] === null ? null : String(f[0]).slice(0, 120), veces: Number(f[1]) || 0 })),
    });
  } catch (error) {
    console.error('[catalogo-queries] Falló la lectura de valores:', error?.code || '', String(error?.message || '').slice(0, 200));
    res.status(error?.code === 'EREQUEST' ? 422 : 502).json({ error: mensajeErrorConsulta(error, origen, 10000) });
  } finally {
    enCurso -= 1;
  }
});

module.exports = router;
