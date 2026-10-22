// ==========================================================================
// Constructor guiado de queries sobre el Catálogo de Datos.
//
// A partir de tablas elegidas del catálogo arma un SELECT de solo lectura:
//   - encuentra cómo unirlas (1.º llaves foráneas reales, 2.º JOIN que ya usa el equipo en
//     el repositorio de queries, 3.º columnas con el mismo nombre/convención),
//   - genera filtros, agrupaciones y ordenamientos con valores escapados,
//   - propone recetas (últimos registros, contar por estado, duplicados, huérfanos…),
//   - sugiere tablas relacionadas y queries del repositorio que ya tocan esas tablas.
//
// Nada de esto ejecuta SQL: solo produce texto. Ejecutar es un paso aparte (rutas de queries).
// ==========================================================================

const catalogo = require('./catalogoDatos');

const norm = (s) => String(s || '').toLowerCase();
const GENERICAS = catalogo.COLUMNAS_GENERICAS || new Set();
const MAX_FILAS = 5000;
const ALIAS_RESERVADOS = new Set(['as', 'is', 'in', 'on', 'or', 'by', 'to', 'go', 'if', 'at', 'of', 'no', 'not', 'and', 'all', 'any', 'for', 'key', 'set', 'top', 'use', 'end', 'add']);

// --------------------------------------------------------------------------
// Tipos
// --------------------------------------------------------------------------
function familiaTipo(tipo) {
  const b = norm(tipo).replace(/\(.*\)/, '').trim();
  if (['int', 'integer', 'bigint', 'smallint', 'tinyint', 'mediumint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney', 'double'].includes(b)) return 'num';
  if (b === 'bit') return 'bit';
  if (['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time', 'timestamp', 'year'].includes(b)) return 'fecha';
  if (b === 'uniqueidentifier') return 'guid';
  if (['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'longtext', 'mediumtext', 'tinytext', 'enum'].includes(b)) return 'texto';
  return 'otro';
}

const colReal = (t, nombre) => { const k = norm(nombre); return t.columnas.find((c) => norm(c.nombre) === k) || null; };

// --------------------------------------------------------------------------
// Relaciones entre dos tablas
// --------------------------------------------------------------------------
function coincide(t, ref) {
  if (norm(ref.tabla) !== norm(t.nombre)) return false;
  if (ref.bd && norm(ref.bd) !== norm(t.bd)) return false;
  if (t.esquema && norm(ref.esquema || 'dbo') !== norm(t.esquema)) return false;
  return true;
}

function singular(n) { const x = norm(n); return x.length > 4 && x.endsWith('s') ? x.slice(0, -1) : x; }

function porConvencion(a, b) {
  // la PK simple de `a` aparece en `b` como idTabla / TablaId / Tabla_Id / CodTabla…
  const pks = a.columnas.filter((c) => c.pk);
  if (pks.length !== 1) return [];
  const pk = pks[0];
  const base = singular(a.nombre);
  const pkn = norm(pk.nombre);
  const nombres = new Set([`${base}${pkn}`, `${pkn}${base}`, `${base}_${pkn}`, `${pkn}_${base}`, `id${base}`, `${base}id`, `id_${base}`, `${base}_id`, `cod${base}`, `codigo${base}`, `cod_${base}`, `${base}cod`]);
  nombres.delete(pkn);
  const res = [];
  for (const c of b.columnas) {
    if (nombres.has(norm(c.nombre)) && familiaTipo(c.tipo) === familiaTipo(pk.tipo)) res.push({ ca: pk.nombre, cb: c.nombre });
  }
  return res;
}

function aristasEntre(a, b, aprendidos = []) {
  const res = [];
  if (a === b) return res;
  for (const p of a.padres) if (p.tabla === b) res.push({ a, b, condiciones: p.columnas.map((c) => ({ ca: c.col, cb: c.refCol })), tipo: 'fk', confianza: 100, detalle: p.nombre });
  for (const h of a.hijas) if (h.tabla === b) res.push({ a, b, condiciones: h.columnas.map((c) => ({ ca: c.refCol, cb: c.col })), tipo: 'fk', confianza: 100, detalle: h.nombre });

  // JOIN que el equipo ya usa
  const pares = [];
  for (const e of aprendidos) {
    let ca; let cb;
    if (coincide(a, e.a) && coincide(b, e.b)) { ca = e.a.columna; cb = e.b.columna; }
    else if (coincide(a, e.b) && coincide(b, e.a)) { ca = e.b.columna; cb = e.a.columna; }
    else continue;
    const ra = colReal(a, ca);
    const rb = colReal(b, cb);
    if (!ra || !rb) continue;
    pares.push({ ca: ra.nombre, cb: rb.nombre, usos: e.usos, queries: new Set(e.queries || []) });
  }
  pares.sort((x, y) => y.usos - x.usos);
  const usados = new Set();
  for (let i = 0; i < pares.length; i++) {
    if (usados.has(i)) continue;
    const grupo = [pares[i]];
    let comunes = new Set(pares[i].queries);
    usados.add(i);
    for (let j = i + 1; j < pares.length; j++) {
      if (usados.has(j)) continue;
      const inter = new Set([...comunes].filter((q) => pares[j].queries.has(q)));
      if (inter.size) { grupo.push(pares[j]); comunes = inter; usados.add(j); }
    }
    const usos = Math.min(...grupo.map((g) => g.usos));
    res.push({ a, b, condiciones: grupo.map((g) => ({ ca: g.ca, cb: g.cb })), tipo: 'aprendida', confianza: 80 + Math.min(usos, 10), usos, detalle: `usada en ${comunes.size || usos} query(s) del repositorio` });
  }

  // Mismo nombre de columna / convención de llaves
  const yaCubiertas = new Set(res.flatMap((r) => r.condiciones.map((c) => `${norm(c.ca)}=${norm(c.cb)}`)));
  const candidatas = [];
  for (const ca of a.columnas) {
    const n = norm(ca.nombre);
    if (GENERICAS.has(n) || n.length < 4) continue;
    const cb = colReal(b, ca.nombre);
    if (!cb || familiaTipo(cb.tipo) !== familiaTipo(ca.tipo) || ['fecha', 'bit', 'otro'].includes(familiaTipo(ca.tipo))) continue;
    candidatas.push({ ca: ca.nombre, cb: cb.nombre, confianza: 40 + (ca.pk || cb.pk ? 20 : 0) + (n.length >= 7 ? 5 : 0) });
  }
  for (const c of porConvencion(a, b)) candidatas.push({ ...c, confianza: 55 });
  for (const c of porConvencion(b, a)) candidatas.push({ ca: c.cb, cb: c.ca, confianza: 55 });
  candidatas.sort((x, y) => y.confianza - x.confianza);
  const vistos = new Set();
  for (const c of candidatas) {
    const k = `${norm(c.ca)}=${norm(c.cb)}`;
    if (vistos.has(k) || yaCubiertas.has(k)) continue;
    vistos.add(k);
    if (res.filter((r) => r.tipo === 'nombre').length >= 2) break;
    res.push({ a, b, condiciones: [{ ca: c.ca, cb: c.cb }], tipo: 'nombre', confianza: c.confianza, detalle: norm(c.ca) === norm(c.cb) ? 'columna con el mismo nombre' : 'convención de nombres' });
  }
  return res.sort((x, y) => y.confianza - x.confianza);
}

// --------------------------------------------------------------------------
// Plan de unión
// --------------------------------------------------------------------------
function vecinos(t, aprendidos) {
  const m = new Map();
  const poner = (otra, arista) => { if (otra === t) return; const previa = m.get(otra); if (!previa || previa.confianza < arista.confianza) m.set(otra, arista); };
  for (const p of t.padres) poner(p.tabla, { a: t, b: p.tabla, condiciones: p.columnas.map((c) => ({ ca: c.col, cb: c.refCol })), tipo: 'fk', confianza: 100 });
  for (const h of t.hijas) poner(h.tabla, { a: t, b: h.tabla, condiciones: h.columnas.map((c) => ({ ca: c.refCol, cb: c.col })), tipo: 'fk', confianza: 100 });
  for (const e of aprendidos) {
    let propia; let otro;
    if (coincide(t, e.a)) { propia = e.a; otro = e.b; } else if (coincide(t, e.b)) { propia = e.b; otro = e.a; } else continue;
    if (!colReal(t, propia.columna)) continue;
    for (const o of catalogo.tablasPorNombre({ bd: otro.bd, esquema: otro.esquema, tabla: otro.tabla, origenId: t.origenId })) {
      if (!colReal(o, otro.columna)) continue;
      poner(o, { a: t, b: o, condiciones: [{ ca: colReal(t, propia.columna).nombre, cb: colReal(o, otro.columna).nombre }], tipo: 'aprendida', confianza: 80 + Math.min(e.usos, 10), usos: e.usos });
    }
  }
  return m;
}

function planificar(tablas, aprendidos = [], manuales = []) {
  const aristasManuales = [];
  for (const m of manuales || []) {
    const a = tablas[m.t1];
    const b = tablas[m.t2];
    if (!a || !b || a === b) continue;
    const ca = colReal(a, m.c1);
    const cb = colReal(b, m.c2);
    if (!ca || !cb) continue;
    aristasManuales.push({ a, b, condiciones: [{ ca: ca.nombre, cb: cb.nombre }], tipo: 'manual', confianza: 110, detalle: 'elegida por ti' });
  }
  const incluidas = [tablas[0]];
  const restantes = tablas.slice(1);
  const joins = [];
  const cache = new Map();
  const entre = (a, b) => {
    const k = `${tablas.indexOf(a)}-${tablas.indexOf(b)}`;
    if (!cache.has(k)) {
      const manual = aristasManuales.filter((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))
        .map((e) => (e.a === a ? e : { a, b, condiciones: e.condiciones.map((c) => ({ ca: c.cb, cb: c.ca })), tipo: e.tipo, confianza: e.confianza, detalle: e.detalle }));
      cache.set(k, [...manual, ...aristasEntre(a, b, aprendidos)]);
    }
    return cache.get(k);
  };
  while (restantes.length) {
    let mejor = null;
    for (const r of restantes) {
      for (const i of incluidas) {
        const [e] = entre(i, r);
        if (e && (!mejor || e.confianza > mejor.arista.confianza)) mejor = { arista: e, desde: i, nueva: r };
      }
    }
    if (!mejor) break;
    joins.push({ desde: mejor.desde, hacia: mejor.nueva, arista: mejor.arista, alternativas: entre(mejor.desde, mejor.nueva).slice(1, 4) });
    incluidas.push(mejor.nueva);
    restantes.splice(restantes.indexOf(mejor.nueva), 1);
  }
  const puentes = [];
  for (const r of restantes) {
    const vr = vecinos(r, aprendidos);
    for (const i of incluidas) {
      const vi = vecinos(i, aprendidos);
      for (const [x, ar] of vr) {
        const ai = vi.get(x);
        if (!ai || tablas.includes(x)) continue;
        puentes.push({ tabla: x, conecta: [r, i], confianza: Math.min(ar.confianza, ai.confianza) });
      }
    }
  }
  puentes.sort((p, q) => q.confianza - p.confianza);
  const vistos = new Set();
  const puentesUnicos = puentes.filter((p) => { if (vistos.has(p.tabla.clave)) return false; vistos.add(p.tabla.clave); return true; }).slice(0, 5);
  return { raiz: tablas[0], joins, sinRelacion: restantes, puentes: puentesUnicos };
}

// --------------------------------------------------------------------------
// Texto SQL
// --------------------------------------------------------------------------
const quote = (motor, n) => (motor === 'MSSQL' ? `[${String(n).replace(/\]/g, ']]')}]` : `\`${String(n).replace(/`/g, '``')}\``);
const nombreCompleto = (motor, t) => (motor === 'MSSQL'
  ? `${quote(motor, t.bd)}.${quote(motor, t.esquema || 'dbo')}.${quote(motor, t.nombre)}`
  : `${quote(motor, t.bd)}.${quote(motor, t.nombre)}`);

function generarAlias(tablas) {
  const usados = new Set();
  return tablas.map((t) => {
    const palabras = String(t.nombre).replace(/([a-z])([A-Z])/g, '$1_$2').split(/[^A-Za-z0-9]+/).filter(Boolean);
    let a = palabras.length > 1 ? palabras.map((p) => p[0]).join('') : String(t.nombre).slice(0, 2);
    a = a.toLowerCase().replace(/[^a-z0-9]/g, '') || 't';
    if (ALIAS_RESERVADOS.has(a)) a += 'x';
    let final = a;
    let n = 2;
    while (usados.has(final) || ALIAS_RESERVADOS.has(final)) { final = `${a}${n}`; n += 1; }
    usados.add(final);
    return final;
  });
}

function literal(motor, col, valor) {
  const v = String(valor === undefined || valor === null ? '' : valor);
  if (v === '<VALOR>') return "'<VALOR>'";
  const fam = familiaTipo(col.tipo);
  const limpio = v.replace(/\u0000/g, '');
  if (fam === 'num') {
    const t = limpio.trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error(`«${col.nombre}» es numérica: el valor «${limpio.slice(0, 30)}» no es un número.`);
    return t;
  }
  if (fam === 'bit') {
    const t = limpio.trim().toLowerCase();
    if (['1', 'true', 'si', 'sí', 'verdadero'].includes(t)) return '1';
    if (['0', 'false', 'no', 'falso'].includes(t)) return '0';
    throw new Error(`«${col.nombre}» es de tipo sí/no: usa 1 o 0.`);
  }
  if (fam === 'fecha') {
    const t = limpio.trim();
    if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?)?$/.test(t)) throw new Error(`«${col.nombre}» es una fecha: usa el formato AAAA-MM-DD (opcional HH:MM:SS).`);
    return `'${t.replace('T', ' ')}'`;
  }
  let esc = limpio.replace(/'/g, "''");
  if (motor !== 'MSSQL') esc = esc.replace(/\\/g, '\\\\');
  const prefijo = motor === 'MSSQL' && /^n/i.test(String(col.tipo)) ? 'N' : '';
  return `${prefijo}'${esc}'`;
}

function escaparLike(motor, v) {
  let t = String(v).replace(/\u0000/g, '').replace(/'/g, "''");
  if (motor === 'MSSQL') t = t.replace(/\[/g, '[[]').replace(/%/g, '[%]').replace(/_/g, '[_]');
  else t = t.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return t;
}

function listaValores(v) {
  const l = Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/);
  return l.map((x) => String(x).trim()).filter(Boolean).slice(0, 500);
}

const OPERADORES = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contiene', 'nocontiene', 'empieza', 'termina', 'en', 'noen', 'nulo', 'nonulo', 'vacio', 'novacio',
  'entre', 'hoy', 'ayer', 'ultimosDias', 'mes', 'mesPasado'];

const esSoloFecha = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
const diaSiguiente = (motor, lit) => (motor === 'MSSQL' ? `DATEADD(DAY, 1, ${lit})` : `(${lit} + INTERVAL 1 DAY)`);

function condicionFiltro(motor, expr, col, f) {
  const op = f.op;
  const fam = familiaTipo(col.tipo);
  const mssql = motor === 'MSSQL';
  switch (op) {
    case 'eq': return `${expr} = ${literal(motor, col, f.v)}`;
    case 'ne': return `${expr} <> ${literal(motor, col, f.v)}`;
    case 'gt': return `${expr} > ${literal(motor, col, f.v)}`;
    case 'ge': return `${expr} >= ${literal(motor, col, f.v)}`;
    case 'lt': return `${expr} < ${literal(motor, col, f.v)}`;
    case 'le': return `${expr} <= ${literal(motor, col, f.v)}`;
    case 'contiene': return `${expr} LIKE '%${escaparLike(motor, f.v)}%'`;
    case 'nocontiene': return `${expr} NOT LIKE '%${escaparLike(motor, f.v)}%'`;
    case 'empieza': return `${expr} LIKE '${escaparLike(motor, f.v)}%'`;
    case 'termina': return `${expr} LIKE '%${escaparLike(motor, f.v)}'`;
    case 'en':
    case 'noen': {
      const l = listaValores(f.v);
      if (!l.length) throw new Error(`El filtro «en lista» de ${col.nombre} no tiene valores.`);
      return `${expr} ${op === 'noen' ? 'NOT IN' : 'IN'} (${l.map((x) => literal(motor, col, x)).join(', ')})`;
    }
    case 'nulo': return `${expr} IS NULL`;
    case 'nonulo': return `${expr} IS NOT NULL`;
    case 'vacio': return fam === 'texto' ? `(${expr} IS NULL OR ${expr} = '')` : `${expr} IS NULL`;
    case 'novacio': return fam === 'texto' ? `(${expr} IS NOT NULL AND ${expr} <> '')` : `${expr} IS NOT NULL`;
    case 'entre': {
      const desde = literal(motor, col, f.v);
      const hasta = literal(motor, col, f.v2);
      // «hasta» con solo la fecha incluye todo ese día
      if (fam === 'fecha' && esSoloFecha(f.v2)) return `${expr} >= ${desde} AND ${expr} < ${diaSiguiente(motor, hasta)}`;
      return `${expr} BETWEEN ${desde} AND ${hasta}`;
    }
    case 'hoy':
      return mssql
        ? `${expr} >= CAST(GETDATE() AS date) AND ${expr} < DATEADD(DAY, 1, CAST(GETDATE() AS date))`
        : `${expr} >= CURDATE() AND ${expr} < CURDATE() + INTERVAL 1 DAY`;
    case 'ayer':
      return mssql
        ? `${expr} >= DATEADD(DAY, -1, CAST(GETDATE() AS date)) AND ${expr} < CAST(GETDATE() AS date)`
        : `${expr} >= CURDATE() - INTERVAL 1 DAY AND ${expr} < CURDATE()`;
    case 'ultimosDias': {
      const n = Math.min(Math.max(parseInt(f.v, 10) || 7, 1), 3650);
      return mssql ? `${expr} >= DATEADD(DAY, -${n}, CAST(GETDATE() AS date))` : `${expr} >= CURDATE() - INTERVAL ${n} DAY`;
    }
    case 'mes':
      return mssql
        ? `${expr} >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) AND ${expr} < DATEADD(MONTH, 1, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))`
        : `${expr} >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND ${expr} < DATE_FORMAT(CURDATE(), '%Y-%m-01') + INTERVAL 1 MONTH`;
    case 'mesPasado':
      return mssql
        ? `${expr} >= DATEADD(MONTH, -1, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) AND ${expr} < DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)`
        : `${expr} >= DATE_FORMAT(CURDATE(), '%Y-%m-01') - INTERVAL 1 MONTH AND ${expr} < DATE_FORMAT(CURDATE(), '%Y-%m-01')`;
    default: throw new Error(`Operador de filtro no válido: ${op}`);
  }
}

// Fechas truncadas para agrupar («cuántos por día / mes»).
const TRUNCS = ['hora', 'dia', 'mes', 'anio'];
function exprTrunc(motor, expr, trunc) {
  if (motor === 'MSSQL') {
    if (trunc === 'dia') return `CAST(${expr} AS date)`;
    if (trunc === 'mes') return `DATEFROMPARTS(YEAR(${expr}), MONTH(${expr}), 1)`;
    if (trunc === 'anio') return `YEAR(${expr})`;
    return `DATEADD(HOUR, DATEDIFF(HOUR, 0, ${expr}), 0)`;
  }
  if (trunc === 'dia') return `DATE(${expr})`;
  if (trunc === 'mes') return `DATE_FORMAT(${expr}, '%Y-%m-01')`;
  if (trunc === 'anio') return `YEAR(${expr})`;
  return `DATE_FORMAT(${expr}, '%Y-%m-%d %H:00:00')`;
}

const FUNCIONES = ['count', 'cdistinct', 'sum', 'avg', 'min', 'max'];
const PREFIJO_FN = { count: 'Total', cdistinct: 'Distintos', sum: 'Suma', avg: 'Promedio', min: 'Minimo', max: 'Maximo' };
const TEXTO_FN = { count: 'cuenta', cdistinct: 'cuenta los distintos de', sum: 'suma', avg: 'promedia', min: 'toma el mínimo de', max: 'toma el máximo de' };

// Alias de columna escrito por el usuario: una sola línea, sin caracteres de control.
function limpiarAlias(a) {
  return String(a === undefined || a === null ? '' : a).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}
const comentarioLinea = (t) => String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

// --------------------------------------------------------------------------
// Armado del SELECT
// --------------------------------------------------------------------------
// config: {
//   tablas:[ref], modo:'detalle'|'conteo'|'agrupado'|'repetidos',
//   columnas:[{t,c,alias?,trunc?}]                 (detalle)
//   agrupar:[{t,c,alias?,trunc?}], medidas:[{fn,t?,c?,alias?}], minTotal   (agrupado / repetidos)
//   filtros:[{t,c,op,v,v2,g?}]                      (g: los de un mismo grupo se unen con OR; los grupos con AND)
//   orden:[{t,c,dir} | {m,dir}]                     (m: posición de un cálculo)
//   top, tipoJoin:'INNER'|'LEFT', nolock, distinct,
//   joinsManuales:[{t1,c1,t2,c2}], joinsConfig:[{hacia, tipo?, alt?}],
//   nombre?, descripcion?, comentario? }
function construir(config, { aprendidos = [] } = {}) {
  try {
    const refs = Array.isArray(config?.tablas) ? config.tablas : [];
    if (!refs.length) return { error: 'Elige al menos una tabla.' };
    if (refs.length > 8) return { error: 'Usa máximo 8 tablas por consulta.' };
    const tablas = refs.map((r) => catalogo.tablaPorRef(r));
    if (tablas.some((t) => !t)) return { error: 'Alguna tabla ya no está en el catálogo: actualiza el catálogo y vuelve a elegirla.' };
    if (new Set(tablas).size !== tablas.length) return { error: 'Cada tabla se puede usar una sola vez.' };
    const origen = tablas[0].origenId;
    if (tablas.some((t) => t.origenId !== origen)) return { error: 'Las tablas están en servidores distintos; un query no puede unirlas. Elige tablas del mismo servidor.' };
    const motor = tablas[0].motor === 'MSSQL' ? 'MSSQL' : 'MARIADB';
    const alias = generarAlias(tablas);
    const plan = planificar(tablas, aprendidos, config.joinsManuales);
    if (plan.sinRelacion.length) {
      return {
        error: `No encontré cómo unir ${plan.sinRelacion.map((t) => t.nombre).join(', ')} con ${tablas.filter((t) => !plan.sinRelacion.includes(t)).map((t) => t.nombre).join(', ')}. Elige tú las columnas o agrega una tabla puente.`,
        sinRelacion: plan.sinRelacion.map((t) => ({ ref: t.ref, nombre: t.nombre })),
        puentes: plan.puentes.map((p) => ({ ref: p.tabla.ref, nombre: p.tabla.nombre, bd: p.tabla.bd, esquema: p.tabla.esquema, conecta: p.conecta.map((c) => c.nombre) })),
      };
    }
    const modo = ['detalle', 'conteo', 'agrupado', 'repetidos'].includes(config.modo) ? config.modo : 'detalle';
    const tipoJoinGlobal = config.tipoJoin === 'LEFT' ? 'LEFT' : 'INNER';
    const nolock = motor === 'MSSQL' && config.nolock !== false;
    const top = Math.min(Math.max(parseInt(config.top, 10) || 100, 1), MAX_FILAS);
    const advertencias = [];
    const explicacion = [];

    const refCol = (x, etiqueta) => {
      const i = Number.isInteger(x?.t) ? x.t : 0;
      const t = tablas[i];
      if (!t) throw new Error(`${etiqueta}: tabla fuera de rango.`);
      const c = colReal(t, x?.c);
      if (!c) throw new Error(`${etiqueta}: la columna «${x?.c}» no existe en ${t.nombre}.`);
      return { i, t, c, expr: `${alias[i]}.${quote(motor, c.nombre)}` };
    };
    // Columna con posible truncado de fecha (día / mes / año / hora).
    const colExpr = (x, etiqueta) => {
      const r = refCol(x, etiqueta);
      if (!x?.trunc) return { ...r, trunc: '' };
      if (!TRUNCS.includes(x.trunc)) throw new Error(`${etiqueta}: agrupación de fecha no válida.`);
      if (familiaTipo(r.c.tipo) !== 'fecha') throw new Error(`${etiqueta}: «${r.c.nombre}» no es una fecha, no se puede agrupar por ${x.trunc}.`);
      return { ...r, expr: exprTrunc(motor, r.expr, x.trunc), trunc: x.trunc };
    };

    // ---- SELECT -------------------------------------------------------------------------
    let seleccion;
    let agrupacion = '';
    let tieneGrupo = false;
    let grupos = [];
    let nombresMedidas = [];
    if (modo === 'conteo') {
      seleccion = ['COUNT(*) AS Total'];
      explicacion.push('Cuenta cuántas filas cumplen los filtros.');
    } else if (modo === 'agrupado' || modo === 'repetidos') {
      grupos = (config.agrupar || []).map((x) => colExpr(x, 'Agrupar por'));
      if (modo === 'repetidos' && !grupos.length) return { error: 'Elige al menos una columna para buscar repetidos.' };
      let lista = modo === 'repetidos' ? [{ fn: 'count' }] : (Array.isArray(config.medidas) && config.medidas.length ? config.medidas : []);
      if (!lista.length) lista = [{ fn: 'count' }];
      if (modo === 'agrupado' && !grupos.length && !(config.medidas || []).length) return { error: 'Elige al menos una columna para agrupar o un cálculo.' };
      const usados = new Set();
      const medidas = lista.slice(0, 8).map((m) => {
        const fn = FUNCIONES.includes(m?.fn) ? m.fn : 'count';
        const sinCol = fn === 'count' && (m?.c === undefined || m?.c === null || m?.c === '');
        let expr; let base;
        if (sinCol) { expr = 'COUNT(*)'; base = 'Total'; } else {
          const r = refCol(m, 'Calcular');
          const fam = familiaTipo(r.c.tipo);
          if ((fn === 'sum' || fn === 'avg') && fam !== 'num') throw new Error(`Calcular: «${r.c.nombre}» no es numérica, no se puede ${fn === 'sum' ? 'sumar' : 'promediar'}.`);
          if ((fn === 'min' || fn === 'max') && fam === 'bit') throw new Error(`Calcular: «${r.c.nombre}» es de tipo sí/no, no tiene mínimo ni máximo.`);
          if (fn === 'count') expr = `COUNT(${r.expr})`;
          else if (fn === 'cdistinct') expr = `COUNT(DISTINCT ${r.expr})`;
          else if (fn === 'avg') expr = motor === 'MSSQL' ? `AVG(1.0 * ${r.expr})` : `AVG(${r.expr})`;
          else expr = `${fn.toUpperCase()}(${r.expr})`;
          base = `${PREFIJO_FN[fn]}_${r.c.nombre}`;
          explicacion.push(`${TEXTO_FN[fn][0].toUpperCase()}${TEXTO_FN[fn].slice(1)} ${r.t.nombre}.${r.c.nombre}.`);
        }
        let nombre = limpiarAlias(m?.alias) || base;
        let n = 2; const b0 = nombre;
        while (usados.has(norm(nombre))) { nombre = `${b0}_${n}`; n += 1; }
        usados.add(norm(nombre));
        return { expr, nombre };
      });
      nombresMedidas = medidas.map((m) => m.nombre);
      seleccion = [
        ...grupos.map((x, k) => {
          const al = limpiarAlias(config.agrupar[k].alias) || (x.trunc ? `${x.c.nombre}_${x.trunc}` : '');
          return al ? `${x.expr} AS ${quote(motor, al)}` : x.expr;
        }),
        ...medidas.map((m) => `${m.expr} AS ${quote(motor, m.nombre)}`),
      ];
      if (grupos.length) agrupacion = `GROUP BY ${grupos.map((x) => x.expr).join(', ')}`;
      if (modo === 'repetidos') { agrupacion += '\nHAVING COUNT(*) > 1'; explicacion.push('Deja solo los valores que aparecen más de una vez.'); }
      else if (grupos.length && Number.isFinite(Number(config.minTotal)) && Number(config.minTotal) >= 2) {
        agrupacion += `\nHAVING COUNT(*) >= ${Math.min(parseInt(config.minTotal, 10), 1000000000)}`;
        explicacion.push(`Muestra solo los grupos con ${parseInt(config.minTotal, 10)} filas o más.`);
      }
      tieneGrupo = grupos.length > 0;
      if (grupos.length) explicacion.push(`Agrupa por ${grupos.map((x) => `${x.t.nombre}.${x.c.nombre}${x.trunc ? ` (por ${{ dia: 'día', mes: 'mes', anio: 'año', hora: 'hora' }[x.trunc]})` : ''}`).join(', ')}.`);
    } else if (config.columnas && config.columnas.length) {
      const cols = config.columnas.map((x) => colExpr(x, 'Columna'));
      const nombres = cols.map((x) => norm(x.c.nombre));
      seleccion = cols.map((x, k) => {
        const al = limpiarAlias(config.columnas[k].alias) || (x.trunc ? `${x.c.nombre}_${x.trunc}` : '');
        if (al) return `${x.expr} AS ${quote(motor, al)}`;
        const repetida = nombres.filter((n) => n === nombres[k]).length > 1;
        return repetida ? `${x.expr} AS ${quote(motor, `${x.t.nombre}_${x.c.nombre}`)}` : x.expr;
      });
    } else {
      seleccion = tablas.map((_, i) => `${alias[i]}.*`);
    }

    // ---- FROM / JOIN -----------------------------------------------------------------------
    const hint = nolock ? ' WITH (NOLOCK)' : '';
    const lineas = [];
    lineas.push(`FROM ${nombreCompleto(motor, tablas[0])} AS ${alias[0]}${hint}`);
    const resumenJoins = [];
    const cfgJ = Array.isArray(config.joinsConfig) ? config.joinsConfig : [];
    const descCond = (a) => a.condiciones.map((c) => `${c.ca} = ${c.cb}`).join(' y ');
    for (const j of plan.joins) {
      const ia = tablas.indexOf(j.desde);
      const ib = tablas.indexOf(j.hacia);
      const cfg = cfgJ.find((x) => x && x.hacia === ib) || {};
      const candidatos = [j.arista, ...j.alternativas];
      const alt = Number.isInteger(cfg.alt) && candidatos[cfg.alt] ? cfg.alt : 0;
      const ar = candidatos[alt];
      const tipo = ['INNER', 'LEFT', 'RIGHT'].includes(cfg.tipo) ? cfg.tipo : tipoJoinGlobal;
      const on = ar.condiciones.map((c) => `${alias[ib]}.${quote(motor, c.cb)} = ${alias[ia]}.${quote(motor, c.ca)}`).join('\n   AND ');
      lineas.push(`${tipo} JOIN ${nombreCompleto(motor, j.hacia)} AS ${alias[ib]}${hint}\n    ON ${on}`);
      const texto = ar.condiciones.map((c) => `${j.hacia.nombre}.${c.cb} = ${j.desde.nombre}.${c.ca}`).join(' y ');
      resumenJoins.push({
        desde: j.desde.nombre, hacia: j.hacia.nombre, desdeIdx: ia, haciaIdx: ib, condicion: texto, origen: ar.tipo, confianza: ar.confianza,
        detalle: ar.detalle || '', tipo, alt,
        opciones: candidatos.map((a, k) => ({ idx: k, condicion: a.condiciones.map((c) => `${j.desde.nombre}.${c.ca} = ${j.hacia.nombre}.${c.cb}`).join(' y '), origen: a.tipo, confianza: a.confianza, detalle: a.detalle || '' })),
        alternativas: candidatos.filter((_, k) => k !== alt).map((a) => ({ condicion: descCond(a), origen: a.tipo, confianza: a.confianza })),
      });
      if (ar.tipo === 'nombre') advertencias.push(`El JOIN ${texto} se dedujo por nombres de columna (no hay llave foránea ni query del equipo que lo confirme): revísalo.`);
    }

    // ---- WHERE: los filtros de un mismo grupo se unen con OR, los grupos con AND -------------------
    const porGrupo = new Map();
    let hayPlantilla = false;
    (config.filtros || []).forEach((f, i) => {
      if (!OPERADORES.includes(f.op)) throw new Error(`Operador de filtro no válido: ${f.op}`);
      const r = refCol(f, 'Filtro');
      if (String(f.v) === '<VALOR>' || String(f.v2) === '<VALOR>') hayPlantilla = true;
      const cond = condicionFiltro(motor, r.expr, r.c, f);
      const k = Number.isInteger(f.g) ? `g${f.g}` : `i${i}`;
      if (!porGrupo.has(k)) porGrupo.set(k, []);
      porGrupo.get(k).push(cond);
      explicacion.push(`Filtra ${r.t.nombre}.${r.c.nombre} ${textoOperador(f)}.`);
    });
    const condiciones = [...porGrupo.values()].map((l) => (l.length === 1 ? l[0] : `(${l.map((c) => (/ AND /.test(c) && !/^\(.*\)$/.test(c) ? `(${c})` : c)).join(' OR ')})`));
    if (hayPlantilla) advertencias.push('Reemplaza <VALOR> por el dato que buscas antes de ejecutar.');

    // ---- ORDER BY -----------------------------------------------------------------------------
    const orden = [];
    for (const o of config.orden || []) {
      const dir = String(o.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      if (Number.isInteger(o.m)) {
        if (!nombresMedidas[o.m]) throw new Error('Orden: ese cálculo no existe.');
        orden.push(`${quote(motor, nombresMedidas[o.m])} ${dir}`);
        continue;
      }
      if (modo === 'conteo') continue;
      if (tieneGrupo) {
        const r = refCol(o, 'Orden');
        const g = grupos.find((x) => x.i === r.i && norm(x.c.nombre) === norm(r.c.nombre));
        if (!g) throw new Error('Orden: en una consulta agrupada solo puedes ordenar por las columnas que agrupas o por un cálculo.');
        orden.push(`${g.expr} ${dir}`);
      } else {
        orden.push(`${refCol(o, 'Orden').expr} ${dir}`);
      }
    }
    if (tieneGrupo && !orden.length && nombresMedidas.length) orden.push(`${quote(motor, nombresMedidas[0])} DESC`);

    // ---- Ensamble ------------------------------------------------------------------------------
    const cabecera = modo === 'conteo' ? 'SELECT' : `SELECT${config.distinct && modo === 'detalle' ? ' DISTINCT' : ''}${motor === 'MSSQL' ? ` TOP ${top}` : ''}`;
    const partes = [`${cabecera}\n       ${seleccion.join(',\n       ')}`, ...lineas];
    if (condiciones.length) partes.push(`WHERE ${condiciones.join('\n  AND ')}`);
    if (agrupacion) partes.push(agrupacion);
    if (orden.length && modo !== 'conteo') partes.push(`ORDER BY ${orden.join(', ')}`);
    if (motor !== 'MSSQL' && modo !== 'conteo') partes.push(`LIMIT ${top}`);
    const comentarios = [];
    const nombre = comentarioLinea(config.nombre);
    if (nombre && config.comentario !== false) {
      comentarios.push(`-- ${nombre}`);
      const d = comentarioLinea(config.descripcion);
      if (d) comentarios.push(`-- ${d}`);
    }
    const sql = `${comentarios.length ? `${comentarios.join('\n')}\n` : ''}${partes.join('\n')};`;

    const intro = [];
    intro.push(`Consulta ${tablas.length > 1 ? `${tablas.length} tablas` : `la tabla ${tablas[0].nombre}`} en ${tablas[0].bd} (${tablas[0].origenNombre}).`);
    for (const j of resumenJoins) intro.push(`Une ${j.hacia} con ${j.desde} por ${j.condicion}${j.origen === 'fk' ? ' (llave foránea)' : j.origen === 'aprendida' ? ' (así lo hace el equipo en sus queries)' : j.origen === 'manual' ? ' (la que elegiste)' : ' (deducido por nombres)'}${j.tipo === 'LEFT' ? ', mostrando también las filas sin pareja' : j.tipo === 'RIGHT' ? ', conservando todas las filas de la tabla unida' : ''}.`);
    if (nolock) intro.push('Lee con WITH (NOLOCK) para no bloquear la base (como en tus queries habituales).');
    const final = [...intro, ...explicacion];
    final.push(motor === 'MSSQL' ? `Limita el resultado a ${top} filas (TOP).` : `Limita el resultado a ${top} filas (LIMIT).`);

    return {
      sql, motor, origenId: origen, baseDatos: tablas[0].bd, modo,
      tablas: tablas.map((t, i) => ({ alias: alias[i], ref: t.ref, nombre: t.nombre, esquema: t.esquema, bd: t.bd })),
      joins: resumenJoins, advertencias, explicacion: final, soloLectura: true,
      puentes: plan.puentes.map((p) => ({ ref: p.tabla.ref, nombre: p.tabla.nombre })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

const TEXTO_OP = {
  eq: 'es igual a', ne: 'es distinto de', gt: 'es mayor que', ge: 'es mayor o igual que', lt: 'es menor que', le: 'es menor o igual que',
  contiene: 'contiene', nocontiene: 'no contiene', empieza: 'empieza por', termina: 'termina en', en: 'está en la lista', noen: 'no está en la lista',
  nulo: 'está vacío (NULL)', nonulo: 'tiene valor', vacio: 'está vacío', novacio: 'no está vacío', entre: 'está entre', hoy: 'es de hoy', ayer: 'es de ayer',
  ultimosDias: 'es de los últimos días', mes: 'es de este mes', mesPasado: 'es del mes pasado',
};
function textoOperador(f) {
  const base = TEXTO_OP[f.op] || f.op;
  if (f.op === 'entre') return `${base} ${f.v} y ${f.v2}`;
  if (f.op === 'ultimosDias') return `es de los últimos ${parseInt(f.v, 10) || 7} día(s)`;
  if (['nulo', 'nonulo', 'vacio', 'novacio', 'hoy', 'ayer', 'mes', 'mesPasado'].includes(f.op)) return base;
  const v = String(f.v === undefined ? '' : f.v);
  return `${base} ${v.length > 40 ? `${v.slice(0, 39)}…` : v}`;
}

// --------------------------------------------------------------------------
// Sugerencias y recetas
// --------------------------------------------------------------------------
const RE_FECHA = /fecha|date|creado|created|registro|timestamp/i;
const RE_CLAVE = /documento|cedula|numid|identific|\bnit\b|solicitud|flujo|referencia|transaccion|guid|usuario|correo|email|numero|cuenta|llave|idtrx|traza/i;
const RE_ESTADO = /estado|status|tipo|canal|categoria|producto|etapa|paso|metodo|resultado|rol|linea|respuesta/i;

function resumenSimple(t) { return { ref: t.ref, nombre: t.nombre, esquema: t.esquema, bd: t.bd, tipo: t.tipo, origen: t.origenNombre, nColumnas: t.columnas.length, filas: t.filas }; }

function relacionadasDe(refs, aprendidos) {
  const tablas = (refs || []).map((r) => catalogo.tablaPorRef(r)).filter(Boolean);
  const res = new Map();
  for (const t of tablas) {
    for (const [otra, ar] of vecinos(t, aprendidos)) {
      if (tablas.includes(otra)) continue;
      const k = otra.clave;
      const previa = res.get(k);
      const item = {
        tabla: resumenSimple(otra), desde: t.nombre, tipo: ar.tipo, confianza: ar.confianza, usos: ar.usos || 0,
        condicion: ar.condiciones.map((c) => `${t.nombre}.${c.ca} = ${otra.nombre}.${c.cb}`).join(' y '),
        direccion: t.padres.some((p) => p.tabla === otra) ? 'padre' : t.hijas.some((h) => h.tabla === otra) ? 'hija' : 'relacionada',
      };
      if (!previa || previa.confianza < item.confianza) res.set(k, item);
    }
  }
  return [...res.values()].sort((a, b) => b.confianza - a.confianza || b.usos - a.usos || a.tabla.nombre.localeCompare(b.tabla.nombre)).slice(0, 24);
}

const RE_MONTO = /valor|monto|total|saldo|cantidad|importe|precio|capital|cuota|tasa|plazo|dias/i;

// filtrosEquipo: columnas que el equipo ya filtra en sus queries para la primera tabla [{ c, usos }].
function recetas(refs, aprendidos, filtrosEquipo = []) {
  const tablas = refs.map((r) => catalogo.tablaPorRef(r));
  if (!tablas.length || tablas.some((t) => !t)) return [];
  const t0 = tablas[0];
  const cols = t0.columnas;
  const pk = cols.filter((c) => c.pk);
  const fechas = cols.filter((c) => familiaTipo(c.tipo) === 'fecha');
  const colFecha = fechas.find((c) => RE_FECHA.test(c.nombre)) || fechas[0] || null;
  const equipo = (filtrosEquipo || []).map((f) => ({ col: colReal(t0, f.c), usos: f.usos })).filter((x) => x.col && familiaTipo(x.col.tipo) !== 'fecha');
  const usosEquipo = new Map(equipo.map((x) => [norm(x.col.nombre), x.usos]));
  const heur = cols.filter((c) => !c.pk && RE_CLAVE.test(c.nombre) && !GENERICAS.has(norm(c.nombre)));
  const claves = [];
  for (const c of [...equipo.map((x) => x.col), ...pk, ...heur]) if (!claves.some((x) => x === c)) claves.push(c);
  const clavesFinal = claves.slice(0, 4);
  const estados = cols.filter((c) => RE_ESTADO.test(c.nombre) && familiaTipo(c.tipo) !== 'fecha').slice(0, 3);
  const montos = cols.filter((c) => familiaTipo(c.tipo) === 'num' && !c.pk && RE_MONTO.test(c.nombre) && !/^id/i.test(c.nombre)).slice(0, 2);
  const base = { tablas: refs };
  const lista = [];
  const agregar = (id, titulo, descripcion, config) => {
    const r = construir({ ...base, ...config }, { aprendidos });
    if (!r.error) lista.push({ id, titulo, descripcion, config: { ...base, ...config }, sql: r.sql, advertencias: r.advertencias });
  };
  const ordenReciente = colFecha ? [{ t: 0, c: colFecha.nombre, dir: 'desc' }] : (pk.length ? [{ t: 0, c: pk[0].nombre, dir: 'desc' }] : []);
  agregar('ultimos', 'Últimos 100 registros', colFecha ? `Ordenados por ${colFecha.nombre}, del más reciente al más antiguo.` : 'Un vistazo rápido a los datos.', { top: 100, orden: ordenReciente });
  for (const c of clavesFinal) {
    const u = usosEquipo.get(norm(c.nombre));
    agregar(`buscar_${c.nombre}`, `Buscar por ${c.nombre}`, u ? `El equipo filtra por ${c.nombre} en ${u} query(s). Reemplaza <VALOR> por el dato que buscas.` : 'Reemplaza <VALOR> por el dato que buscas.', { top: 100, filtros: [{ t: 0, c: c.nombre, op: 'eq', v: '<VALOR>' }], orden: ordenReciente });
  }
  if (colFecha) {
    agregar('recientes', 'Registros de los últimos 7 días', `Filtra ${colFecha.nombre} de la última semana.`, { top: 500, filtros: [{ t: 0, c: colFecha.nombre, op: 'ultimosDias', v: 7 }], orden: [{ t: 0, c: colFecha.nombre, dir: 'desc' }] });
    agregar('entre_fechas', 'Entre dos fechas', `Registros con ${colFecha.nombre} dentro de un rango. Reemplaza <VALOR> por las fechas (AAAA-MM-DD).`, { top: 500, filtros: [{ t: 0, c: colFecha.nombre, op: 'entre', v: '<VALOR>', v2: '<VALOR>' }], orden: [{ t: 0, c: colFecha.nombre, dir: 'desc' }] });
    agregar('por_dia', 'Cuántos por día', `Conteo diario de ${colFecha.nombre} en los últimos 30 días.`, { modo: 'agrupado', agrupar: [{ t: 0, c: colFecha.nombre, trunc: 'dia' }], filtros: [{ t: 0, c: colFecha.nombre, op: 'ultimosDias', v: 30 }], orden: [{ t: 0, c: colFecha.nombre, dir: 'desc' }], top: 60 });
    agregar('por_mes', 'Cuántos por mes', `Conteo mensual de ${colFecha.nombre}.`, { modo: 'agrupado', agrupar: [{ t: 0, c: colFecha.nombre, trunc: 'mes' }], orden: [{ t: 0, c: colFecha.nombre, dir: 'desc' }], top: 36 });
    agregar('rango', 'Primer y último registro', `Cuántas filas hay y entre qué fechas (${colFecha.nombre}).`, { modo: 'agrupado', agrupar: [], medidas: [{ fn: 'count' }, { fn: 'min', t: 0, c: colFecha.nombre, alias: 'Primero' }, { fn: 'max', t: 0, c: colFecha.nombre, alias: 'Ultimo' }], top: 1 });
  }
  for (const c of estados) agregar(`contar_${c.nombre}`, `Contar por ${c.nombre}`, `Cuántos registros hay por cada valor de ${c.nombre}.`, { modo: 'agrupado', agrupar: [{ t: 0, c: c.nombre }], top: 200 });
  for (const m of montos.slice(0, 1)) {
    const g = estados[0] || null;
    agregar(`sumar_${m.nombre}`, g ? `Sumar ${m.nombre} por ${g.nombre}` : `Total y promedio de ${m.nombre}`, g ? `Suma y promedio de ${m.nombre} por cada ${g.nombre}.` : `Suma, promedio, mínimo y máximo de ${m.nombre}.`,
      g ? { modo: 'agrupado', agrupar: [{ t: 0, c: g.nombre }], medidas: [{ fn: 'count' }, { fn: 'sum', t: 0, c: m.nombre }, { fn: 'avg', t: 0, c: m.nombre }], top: 200 }
        : { modo: 'agrupado', agrupar: [], medidas: [{ fn: 'count' }, { fn: 'sum', t: 0, c: m.nombre }, { fn: 'avg', t: 0, c: m.nombre }, { fn: 'min', t: 0, c: m.nombre }, { fn: 'max', t: 0, c: m.nombre }], top: 1 });
  }
  for (const c of clavesFinal.filter((x) => !x.pk).slice(0, 2)) agregar(`repetidos_${c.nombre}`, `Repetidos por ${c.nombre}`, `Valores de ${c.nombre} que aparecen más de una vez.`, { modo: 'repetidos', agrupar: [{ t: 0, c: c.nombre }], top: 200 });
  if (tablas.length === 1) {
    for (const p of t0.padres.slice(0, 2)) {
      const cond = p.columnas[0];
      if (!cond || !colReal(p.tabla, cond.refCol)) continue;
      agregar(`huerfanos_${p.tabla.nombre}`, `Sin ${p.tabla.nombre} (huérfanos)`, `Filas de ${t0.nombre} cuya referencia a ${p.tabla.nombre} no existe.`,
        { tablas: [t0.ref, p.tabla.ref], tipoJoin: 'LEFT', top: 200, filtros: [{ t: 1, c: cond.refCol, op: 'nulo' }] });
    }
    for (const h of t0.hijas.slice(0, 2)) {
      agregar(`con_${h.tabla.nombre}`, `Con su detalle en ${h.tabla.nombre}`, `${t0.nombre} unida con ${h.tabla.nombre}.`, { tablas: [t0.ref, h.tabla.ref], top: 100 });
    }
  }
  return lista.slice(0, 18);
}

// SELECT de muestra para listar los valores más frecuentes de una columna (sobre las primeras filas, para no cargar el servidor).
function sqlValoresFrecuentes(ref, columna, { muestra = 20000, max = 30 } = {}) {
  const t = catalogo.tablaPorRef(ref);
  if (!t) return { error: 'La tabla ya no está en el catálogo.' };
  const c = colReal(t, columna);
  if (!c) return { error: `La columna «${columna}» no existe en ${t.nombre}.` };
  const fam = familiaTipo(c.tipo);
  if (fam === 'otro') return { error: `«${c.nombre}» es de un tipo (${c.tipo}) del que no se pueden listar valores.` };
  if (/\bmax\b|text|blob|xml|json/i.test(c.tipo) && fam === 'texto') return { error: `«${c.nombre}» es un texto muy largo: no se listan sus valores.` };
  const motor = t.motor === 'MSSQL' ? 'MSSQL' : 'MARIADB';
  const col = quote(motor, c.nombre);
  const tabla = nombreCompleto(motor, t);
  const sql = motor === 'MSSQL'
    ? `SELECT TOP ${max} ${col} AS Valor, COUNT(*) AS Veces\nFROM (SELECT TOP ${muestra} ${col} FROM ${tabla} WITH (NOLOCK)) AS m\nGROUP BY ${col}\nORDER BY COUNT(*) DESC`
    : `SELECT ${col} AS Valor, COUNT(*) AS Veces\nFROM (SELECT ${col} FROM ${tabla} LIMIT ${muestra}) AS m\nGROUP BY ${col}\nORDER BY COUNT(*) DESC\nLIMIT ${max}`;
  return { sql, origenId: t.origenId, baseDatos: t.bd, motor, tabla: t.nombre, columna: c.nombre, muestra };
}

module.exports = {
  construir, planificar, aristasEntre, relacionadasDe, recetas,
  familiaTipo, colReal, vecinos, resumenSimple, nombreCompleto, quote, OPERADORES, sqlValoresFrecuentes, TRUNCS, FUNCIONES,
};
