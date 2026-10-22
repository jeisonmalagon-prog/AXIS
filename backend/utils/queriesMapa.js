// ==========================================================================
// Relación entre el repositorio de queries y el esquema del Catálogo de Datos (mapa estelar).
//
// Los queries guardados solo conocen nombres (base.esquema.tabla), no el servidor. Aquí se
// resuelve cada tabla contra el catálogo ya cargado en memoria y se agrega:
//   - porBase():  cuántos queries tocan cada base y qué bases cruzan los queries con JOIN (puentes);
//   - base():     por tabla de una base, cuántos queries la usan, y los JOIN que el equipo hace
//                 entre tablas de esa base (marcando cuáles ya son llave foránea y cuáles no);
//   - tabla():    queries de una tabla, con qué otras tablas se une el equipo, uso por columna
//                 y los filtros más repetidos;
//   - enriquecer(): datos del catálogo para el detalle de un query.
// Todo es de solo lectura sobre memoria: no consulta las bases de origen.
// ==========================================================================

const catalogo = require('./catalogoDatos');
const repo = require('./queriesRepositorio');

const norm = (s) => String(s || '').toLowerCase();
const SEP = '\u0001';

// Devuelve las tablas del catálogo que corresponden a una tabla de un query ([] si no se sabe cuál).
function crearResolvedor() {
  const memo = new Map();
  return function resolver(t, bdQuery) {
    if (!t || t.servidor || !t.tabla) return [];
    const bd = t.bd || bdQuery || '';
    const k = `${norm(bd)}|${norm(t.esquema)}|${norm(t.tabla)}`;
    if (memo.has(k)) return memo.get(k);
    let l = catalogo.tablasPorNombre({ bd, esquema: t.esquema || '', tabla: t.tabla });
    if (l.length > 3) l = [];
    memo.set(k, l);
    return l;
  };
}

const claveBase = (t) => `${t.origenId}${SEP}${t.bd}`;
const nombreCorto = (t) => `${t.esquema || 'dbo'}.${t.nombre}`;

function esFk(a, b) {
  return a.padres.some((p) => p.tabla === b) || a.hijas.some((h) => h.tabla === b);
}

// Para cada JOIN de un query devuelve [{ ta, tb, ca, cb }] con cada lado resuelto (producto cartesiano chico).
function ladosDeJoin(o, j, resolver) {
  const A = resolver(j.a, o.baseDatos);
  const B = resolver(j.b, o.baseDatos);
  const res = [];
  for (const ta of A) for (const tb of B) if (ta !== tb) res.push({ ta, tb, ca: j.a.columna, cb: j.b.columna });
  return res;
}

async function filasDe(pool) {
  const c = await repo.cargar(pool);
  return c.filas;
}

// --------------------------------------------------------------------------
// Nivel galaxia: bases y puentes
// --------------------------------------------------------------------------
async function porBase(pool) {
  const filas = await filasDe(pool);
  const resolver = crearResolvedor();
  const bases = new Map();
  const puentes = new Map();
  const sin = new Map();
  let sinResolver = 0;

  const dato = (t) => {
    const k = claveBase(t);
    let b = bases.get(k);
    if (!b) { b = { o: t.origenId, bd: t.bd, queries: new Set(), modifican: new Set(), tablas: new Set() }; bases.set(k, b); }
    return b;
  };

  for (const q of filas) {
    let faltan = false;
    for (const t of q.tablas) {
      const r = resolver(t, q.baseDatos);
      if (!r.length) {
        faltan = true;
        const nombre = t.servidor ? `${t.servidor}.${t.bd || ''}.${t.esquema || 'dbo'}.${t.tabla}` : `${t.bd || q.baseDatos || '?'}.${t.esquema || 'dbo'}.${t.tabla}`;
        sin.set(nombre, (sin.get(nombre) || 0) + 1);
        continue;
      }
      for (const x of r) {
        const b = dato(x);
        b.queries.add(q.id);
        if (q.modifica) b.modifican.add(q.id);
        b.tablas.add(x.clave);
      }
    }
    if (faltan) sinResolver += 1;
    const vistosEnQuery = new Set();
    for (const j of q.joins) {
      for (const l of ladosDeJoin(q, j, resolver)) {
        if (l.ta.origenId === l.tb.origenId && l.ta.bd === l.tb.bd) continue;
        const ka = claveBase(l.ta);
        const kb = claveBase(l.tb);
        const [x, y] = ka < kb ? [l.ta, l.tb] : [l.tb, l.ta];
        const k = `${claveBase(x)}${SEP}${SEP}${claveBase(y)}`;
        let p = puentes.get(k);
        if (!p) { p = { a: { o: x.origenId, bd: x.bd }, b: { o: y.origenId, bd: y.bd }, joins: 0, queries: new Set(), ejemplos: [] }; puentes.set(k, p); }
        p.joins += 1;
        p.queries.add(q.id);
        const id = `${q.id}:${k}`;
        if (!vistosEnQuery.has(id) && p.ejemplos.length < 4) {
          vistosEnQuery.add(id);
          p.ejemplos.push({ id: q.id, titulo: q.titulo, desde: `${nombreCorto(l.ta)}.${l.ca}`, hacia: `${nombreCorto(l.tb)}.${l.cb}` });
        }
      }
    }
  }

  return {
    total: filas.length,
    bases: [...bases.values()].map((b) => ({ o: b.o, bd: b.bd, queries: b.queries.size, modifican: b.modifican.size, tablas: b.tablas.size }))
      .sort((a, b) => b.queries - a.queries || a.bd.localeCompare(b.bd)),
    puentes: [...puentes.values()].map((p) => ({ a: p.a, b: p.b, joins: p.joins, queries: p.queries.size, ejemplos: p.ejemplos }))
      .sort((a, b) => b.queries - a.queries || b.joins - a.joins).slice(0, 40),
    sinResolver: {
      queries: sinResolver,
      tablas: [...sin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([nombre, usos]) => ({ nombre, usos })),
    },
  };
}

// --------------------------------------------------------------------------
// Nivel base: uso por tabla y JOIN entre tablas de la base
// --------------------------------------------------------------------------
async function base(pool, origenId, bd) {
  const filas = await filasDe(pool);
  const resolver = crearResolvedor();
  const o = String(origenId);
  const enBase = (t) => t.origenId === o && norm(t.bd) === norm(bd);
  const tablas = new Map();
  const joins = new Map();
  const queries = new Set();

  for (const q of filas) {
    let toca = false;
    for (const t of q.tablas) {
      for (const x of resolver(t, q.baseDatos)) {
        if (!enBase(x)) continue;
        toca = true;
        let e = tablas.get(x.clave);
        if (!e) { e = { es: x.esquema || '', n: x.nombre, queries: new Set(), modifican: new Set(), escriben: new Set() }; tablas.set(x.clave, e); }
        e.queries.add(q.id);
        if (q.modifica) e.modifican.add(q.id);
        if (t.escribe) e.escriben.add(q.id);
      }
    }
    if (toca) queries.add(q.id);
    for (const j of q.joins) {
      for (const l of ladosDeJoin(q, j, resolver)) {
        if (!enBase(l.ta) || !enBase(l.tb)) continue;
        const [x, y, cx, cy] = l.ta.clave < l.tb.clave ? [l.ta, l.tb, l.ca, l.cb] : [l.tb, l.ta, l.cb, l.ca];
        const k = `${x.clave}${SEP}${SEP}${y.clave}`;
        let e = joins.get(k);
        if (!e) { e = { a: { es: x.esquema || '', n: x.nombre }, b: { es: y.esquema || '', n: y.nombre }, usos: 0, queries: new Set(), condiciones: new Map(), fk: esFk(x, y) }; joins.set(k, e); }
        e.usos += 1;
        e.queries.add(q.id);
        const ck = `${cx}=${cy}`.toLowerCase();
        if (!e.condiciones.has(ck)) e.condiciones.set(ck, { ca: cx, cb: cy });
      }
    }
  }

  return {
    o, bd, total: queries.size,
    tablas: [...tablas.values()].map((e) => ({ es: e.es, n: e.n, queries: e.queries.size, modifican: e.modifican.size, escriben: e.escriben.size }))
      .sort((a, b) => b.queries - a.queries),
    joins: [...joins.values()].map((e) => ({ a: e.a, b: e.b, usos: e.usos, queries: e.queries.size, fk: e.fk, condiciones: [...e.condiciones.values()].slice(0, 4) }))
      .sort((a, b) => b.usos - a.usos).slice(0, 400),
  };
}

// --------------------------------------------------------------------------
// Nivel tabla
// --------------------------------------------------------------------------
function resolverFiltro(f, q, resolver) {
  return resolver({ bd: f.bd, esquema: f.esquema, tabla: f.tabla }, q.baseDatos);
}

async function tabla(pool, ref, { limite = 40 } = {}) {
  const t = catalogo.tablaPorRef(ref);
  if (!t) return null;
  const filas = await filasDe(pool);
  const resolver = crearResolvedor();
  const propios = [];
  const rel = new Map();
  const cols = new Map();
  const filtros = new Map();
  const marcar = (col, campo) => {
    const k = norm(col);
    if (!k) return;
    const e = cols.get(k) || { c: col, joins: 0, filtros: 0 };
    e[campo] += 1;
    cols.set(k, e);
  };

  for (const q of filas) {
    if (q.tablas.some((x) => resolver(x, q.baseDatos).includes(t))) propios.push(q);
    for (const j of q.joins) {
      for (const l of ladosDeJoin(q, j, resolver)) {
        let otra = null; let mia = ''; let suya = '';
        if (l.ta === t) { otra = l.tb; mia = l.ca; suya = l.cb; } else if (l.tb === t) { otra = l.ta; mia = l.cb; suya = l.ca; }
        if (!otra) continue;
        let e = rel.get(otra.clave);
        if (!e) { e = { tabla: catalogo.resumenTabla(otra), usos: 0, queries: new Set(), condiciones: new Map(), fk: esFk(t, otra) }; rel.set(otra.clave, e); }
        e.usos += 1;
        e.queries.add(q.id);
        const ck = `${mia}=${suya}`.toLowerCase();
        const c = e.condiciones.get(ck) || { ca: mia, cb: suya, usos: 0 };
        c.usos += 1;
        e.condiciones.set(ck, c);
        marcar(mia, 'joins');
      }
    }
    for (const f of q.filtros || []) {
      if (!resolverFiltro(f, q, resolver).includes(t)) continue;
      marcar(f.columna, 'filtros');
      const k = norm(f.columna);
      const e = filtros.get(k) || { c: f.columna, usos: 0, queries: new Set(), ops: new Map() };
      e.queries.add(q.id);
      e.usos += 1;
      e.ops.set(f.op, (e.ops.get(f.op) || 0) + 1);
      filtros.set(k, e);
    }
  }

  const ordenadas = propios.sort((a, b) => Number(a.modifica) - Number(b.modifica) || b.ejecuciones - a.ejecuciones || a.id - b.id);
  return {
    ref: t.ref,
    total: ordenadas.length,
    queries: ordenadas.slice(0, limite).map((q) => repo.publico(q, { conConsulta: false })),
    relacionadas: [...rel.values()].map((e) => ({
      tabla: e.tabla, usos: e.usos, queries: e.queries.size, fk: e.fk,
      condiciones: [...e.condiciones.values()].sort((a, b) => b.usos - a.usos).slice(0, 4),
    })).sort((a, b) => b.usos - a.usos).slice(0, 30),
    columnas: [...cols.values()].filter((c) => t.columnas.some((x) => norm(x.nombre) === norm(c.c)))
      .map((c) => ({ ...c, c: t.columnas.find((x) => norm(x.nombre) === norm(c.c)).nombre })),
    filtros: [...filtros.values()].map((e) => ({
      c: (t.columnas.find((x) => norm(x.nombre) === norm(e.c)) || { nombre: e.c }).nombre,
      usos: e.usos, queries: e.queries.size,
      ops: [...e.ops.entries()].sort((a, b) => b[1] - a[1]).map(([op]) => op),
    })).sort((a, b) => b.usos - a.usos).slice(0, 20),
  };
}

// Columnas que el equipo filtra en esa tabla, para el constructor: [{ c, usos }].
async function filtrosDeTabla(pool, ref) {
  const r = await tabla(pool, ref, { limite: 0 });
  return r ? r.filtros.map((f) => ({ c: f.c, usos: f.usos })) : [];
}

// --------------------------------------------------------------------------
// Detalle de un query contra el catálogo
// --------------------------------------------------------------------------
function enriquecer(q) {
  const resolver = crearResolvedor();
  const tablasCatalogo = q.tablas.map((t) => {
    const r = resolver(t, q.baseDatos);
    const x = r.length === 1 ? r[0] : null;
    return {
      texto: `${t.servidor ? `${t.servidor}.` : ''}${t.bd ? `${t.bd}.` : ''}${t.esquema || 'dbo'}.${t.tabla}`,
      servidor: t.servidor || '',
      enCatalogo: !!x,
      ambigua: r.length > 1,
      ref: x ? x.ref : null,
      origen: x ? x.origenNombre : '',
      bd: x ? x.bd : (t.bd || q.baseDatos || ''),
      filas: x ? x.filas : null,
      nColumnas: x ? x.columnas.length : null,
      tipo: x ? x.tipo : '',
      escribe: !!t.escribe,
    };
  });
  const joins = q.joins.map((j) => {
    const lados = ladosDeJoin(q, j, resolver);
    const l = lados.length === 1 ? lados[0] : null;
    const existeCol = (t, c) => !!t && t.columnas.some((x) => norm(x.nombre) === norm(c));
    return {
      a: j.a, b: j.b,
      enCatalogo: !!l,
      fk: l ? esFk(l.ta, l.tb) : false,
      columnasOk: l ? existeCol(l.ta, l.ca) && existeCol(l.tb, l.cb) : null,
    };
  });
  const resueltas = tablasCatalogo.filter((t) => t.enCatalogo);
  let sugerencia = null;
  if (resueltas.length && resueltas.length === tablasCatalogo.length && !tablasCatalogo.some((t) => t.escribe)) {
    const origenes = new Set(resueltas.map((t) => t.ref.o));
    const bases = new Set(resueltas.map((t) => t.ref.bd));
    if (origenes.size === 1 && bases.size === 1) sugerencia = { origenId: resueltas[0].ref.o, bd: resueltas[0].ref.bd, tablas: resueltas.slice(0, 8).map((t) => t.ref) };
  }
  return { tablasCatalogo, joinsCatalogo: joins, sugerenciaConstructor: sugerencia };
}

module.exports = { porBase, base, tabla, filtrosDeTabla, enriquecer, crearResolvedor };
