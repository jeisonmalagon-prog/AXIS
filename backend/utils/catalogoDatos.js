// ==========================================================================
// Catálogo de Datos: caché en memoria del mapa de bases/tablas/columnas de
// todos los orígenes activos + buscador, diccionario, grafo ER y mapa estelar.
//
// - Se llena leyendo SOLO catálogos del sistema (ver catalogoExtraccion.js):
//   al abrir el módulo por primera vez y cada vez que se pulsa «Actualizar».
//   Las búsquedas y los grafos se resuelven en memoria: no tocan las bases.
// - Una sola lectura por origen a la vez (single-flight) y máximo 2 orígenes
//   en paralelo, para no cargar los servidores.
// - Al reiniciar el backend la caché se pierde (se vuelve a leer al abrir).
// - CADA PERSONA TIENE SU PROPIO CATÁLOGO: se construye con SUS credenciales
//   (utils/catalogoSesion.js) y nadie más lo ve. Lo que aparece en él lo decide
//   lo que su cuenta de base de datos puede ver. La lista de servidores es la
//   misma para todos, pero sin credenciales propias el servidor aparece como
//   «sin credenciales» y no se lee. Los catálogos de personas sin sesión vigente
//   se descartan de la memoria al cabo de 1 hora.
// ==========================================================================

const { extraerOrigen, mensajeErrorOrigen } = require('./catalogoExtraccion');
const { origenesParaExtraccion } = require('./catalogoOrigenes');
const sesion = require('./catalogoSesion');

const HORAS_RETENCION_SIN_SESION = 1;

const MAX_PARALELO = 2;
const MAX_NODOS_GRAFO = 40;
const MAX_COLUMNAS_NODO = 8;
const MAX_ARISTAS_MAPA = 30000;

// Nombres de columna demasiado genéricos para sugerir un "puente" entre bases.
const COLUMNAS_GENERICAS = new Set([
  'id', 'ids', 'fecha', 'fechacreo', 'fechacreacion', 'fechaactualizacion', 'fechamodificacion', 'fecharegistro',
  'estado', 'nombre', 'nombres', 'descripcion', 'usuario', 'codigo', 'tipo', 'activo', 'observaciones', 'observacion',
  'created_at', 'updated_at', 'createdat', 'updatedat', 'creadopor', 'modificadopor', 'valor', 'orden', 'version',
  'comentario', 'comentarios', 'detalle', 'status', 'name', 'description', 'type', 'active', 'deleted', 'eliminado',
  'fechacreado', 'fechamodificado', 'usuariocreacion', 'usuariomodificacion', 'idusuario', 'timestamp', 'rowversion',
]);

// --- Estado (UNO POR PERSONA) ---------------------------------------------------
// usuarioApp -> { origenes: Map(id -> { info, estado, progreso, error, actualizadoEn, duracionMs, advertencias, bases, tablas }),
//                 cargas: Map(id -> Promise), inicializado, indice, ultimoUso }
const estados = new Map();

function nuevoEstado() {
  return { origenes: new Map(), cargas: new Map(), inicializado: false, indice: construirIndice([]), ultimoUso: Date.now() };
}

// Estado de la persona del contexto actual (sin contexto: un estado vacío aparte, nunca el de otra persona).
function est() {
  const u = sesion.usuarioActual() || '';
  let st = estados.get(u);
  if (!st) { st = nuevoEstado(); estados.set(u, st); }
  st.ultimoUso = Date.now();
  return st;
}

// Los nombres de abajo apuntan siempre al estado de quien hace la llamada.
const origenes = new Proxy({}, { get: (_, p) => { const m = est().origenes; const v = m[p]; return typeof v === 'function' ? v.bind(m) : v; } });
const cargas = new Proxy({}, { get: (_, p) => { const m = est().cargas; const v = m[p]; return typeof v === 'function' ? v.bind(m) : v; } });
const indice = new Proxy({}, { get: (_, p) => est().indice[p] });

// Descarta los catálogos de quien ya no tiene credenciales vigentes y no ha vuelto en un rato.
setInterval(() => {
  const limite = Date.now() - HORAS_RETENCION_SIN_SESION * 3600 * 1000;
  for (const [u, st] of [...estados.entries()]) {
    if (st.ultimoUso < limite && !st.cargas.size && !sesion.tieneSesion(u)) estados.delete(u);
  }
}, 10 * 60 * 1000).unref();

const claveDe = (origenId, bd, esquema, nombre) => [origenId, bd, esquema || '', nombre].join('\u0001');
const norm = (s) => String(s || '').toLowerCase();

function construirIndice(listas) {
  const tablas = [];
  for (const l of listas) for (const t of l) tablas.push(t);
  const porClave = new Map(tablas.map((t) => [t.clave, t]));

  // Relaciones padre/hija resueltas dentro del mismo origen/base.
  for (const t of tablas) { t.padres = []; t.hijas = []; }
  for (const t of tablas) {
    for (const fk of t.fks) {
      const destino = porClave.get(claveDe(t.origenId, fk.refBd, fk.refEsquema, fk.refTabla));
      if (!destino) continue;
      t.padres.push({ tabla: destino, nombre: fk.nombre, columnas: fk.columnas });
      destino.hijas.push({ tabla: t, nombre: fk.nombre, columnas: fk.columnas });
    }
  }

  // Columna -> tablas donde aparece (para el buscador y "dónde más aparece").
  const columnas = new Map();
  for (const t of tablas) {
    for (const c of t.columnas) {
      const k = norm(c.nombre);
      let e = columnas.get(k);
      if (!e) { e = { nombre: c.nombre, tablas: [] }; columnas.set(k, e); }
      e.tablas.push({ tabla: t, columna: c });
    }
  }
  // Nombre -> tablas (para relacionar queries guardados, que no conocen el id del origen).
  const porNombre = new Map();
  const agregar = (k, t) => { const l = porNombre.get(k) || []; l.push(t); porNombre.set(k, l); };
  for (const t of tablas) {
    const n = norm(t.nombre);
    const es = norm(t.esquema || 'dbo');
    agregar(`${norm(t.bd)}.${es}.${n}`, t);
    agregar(`${es}.${n}`, t);
    agregar(n, t);
  }
  return { tablas, porClave, columnas, porNombre };
}

function reconstruir(st = est()) {
  st.indice = construirIndice([...st.origenes.values()].map((o) => o.tablas));
}

// --- Normalización al cargar -----------------------------------------------------
function enriquecer(info, base, t) {
  const clave = claveDe(info.id, t.bd, t.esquema, t.nombre);
  return {
    ...t,
    clave, origenId: info.id, origenNombre: info.nombre, motor: info.motor,
    ref: { o: info.id, bd: t.bd, es: t.esquema || '', n: t.nombre },
    padres: [], hijas: [],
  };
}

function resumenBases(tablas, extra) {
  const porBd = new Map();
  for (const t of tablas) {
    let b = porBd.get(t.bd);
    if (!b) { b = { nombre: t.bd, tablas: 0, vistas: 0, columnas: 0, fks: 0 }; porBd.set(t.bd, b); }
    if (t.tipo === 'VISTA') b.vistas += 1; else b.tablas += 1;
    b.columnas += t.columnas.length;
    b.fks += t.fks.length;
  }
  for (const e of extra) if (!porBd.has(e.nombre)) porBd.set(e.nombre, { nombre: e.nombre, tablas: 0, vistas: 0, columnas: 0, fks: 0, error: e.error || null });
  return [...porBd.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// --- Carga ---------------------------------------------------------------------
function infoPublica(o) {
  return { id: o.id, nombre: o.nombre, motor: o.motor, host: o.host, puerto: o.puerto };
}

function registroNuevo(origen) {
  return { info: infoPublica(origen), estado: 'cargando', progreso: null, error: null, actualizadoEn: null, duracionMs: null, advertencias: [], bases: [], tablas: [] };
}

const esRechazoLogin = (error) => ['ELOGIN', 'ER_ACCESS_DENIED_ERROR'].includes(error?.code || error?.codigo) || error?.errno === 1045;

// Devuelve { ok, rechazoLogin }.
async function cargarOrigen(st, origen) {
  if (st.cargas.has(origen.id)) return st.cargas.get(origen.id);
  const previo = st.origenes.get(origen.id);
  const reg = previo || registroNuevo(origen);
  reg.info = infoPublica(origen);
  reg.progreso = 'Conectando…';
  reg.cargando = true;
  if (!previo || reg.estado === 'sin-credenciales') { reg.estado = 'cargando'; reg.error = null; }
  st.origenes.set(origen.id, reg);

  const promesa = (async () => {
    const inicio = Date.now();
    let resultado = { ok: false, rechazoLogin: false };
    try {
      const { bases, advertencias } = await extraerOrigen(origen, { onProgreso: (p) => { reg.progreso = p; } });
      const tablas = [];
      for (const b of bases) for (const t of b.tablas) tablas.push(enriquecer(reg.info, b, t));
      reg.tablas = tablas;
      reg.bases = resumenBases(tablas, bases.filter((b) => !b.tablas.length));
      reg.advertencias = advertencias;
      reg.error = null;
      reg.estado = 'ok';
      reg.actualizadoEn = new Date().toISOString();
      reg.duracionMs = Date.now() - inicio;
      resultado = { ok: true, rechazoLogin: false };
    } catch (error) {
      resultado = { ok: false, rechazoLogin: esRechazoLogin(error) };
      reg.error = mensajeErrorOrigen(error, origen);
      reg.estado = reg.tablas.length ? 'ok' : 'error';   // si había datos, se conservan (obsoletos)
      reg.duracionMs = Date.now() - inicio;
      console.error(`[catalogo-datos] Falló la lectura de «${origen.nombre}»:`, error?.code || '', String(error?.message || '').slice(0, 200));
    } finally {
      reg.cargando = false;
      reg.progreso = null;
      reconstruir(st);
      st.cargas.delete(origen.id);
    }
    return resultado;
  })();
  st.cargas.set(origen.id, promesa);
  return promesa;
}

// Un servidor sin credenciales de esta persona: no se lee y se descarta lo que hubiera de él.
function marcarSinCredenciales(st, origen) {
  const reg = st.origenes.get(origen.id) || registroNuevo(origen);
  reg.info = infoPublica(origen);
  reg.estado = 'sin-credenciales';
  reg.cargando = false;
  reg.progreso = null;
  reg.tablas = [];
  reg.bases = [];
  reg.advertencias = [];
  reg.error = `Falta tu usuario y clave de ${sesion.nombreMotor(origen.motor)}: agrégalos en «Mis credenciales».`;
  st.origenes.set(origen.id, reg);
}

// Lee los orígenes activos (todos o uno) con las credenciales de la persona actual, máximo MAX_PARALELO a la vez.
// Para no bloquear una cuenta de dominio con una clave mala, se detiene el motor tras 2 inicios de sesión
// rechazados seguidos mientras ninguno haya funcionado.
async function actualizar(pool, { origenId = null, esperar = false } = {}) {
  const st = est();
  const usuario = sesion.usuarioActual();
  st.inicializado = true;
  const { tabla, origenes: lista } = await origenesParaExtraccion(pool);
  if (!tabla) return { tabla: false, iniciados: 0, sinCredenciales: 0 };
  // Orígenes que ya no están activos salen de la caché.
  const activos = new Set(lista.map((o) => o.id));
  let cambio = false;
  for (const id of [...st.origenes.keys()]) if (!activos.has(id) && !st.cargas.has(id)) { st.origenes.delete(id); cambio = true; }

  const objetivos = [];
  let sinCredenciales = 0;
  for (const o of lista) {
    if (origenId && o.id !== String(origenId)) continue;
    const conCred = usuario ? sesion.conCredenciales(o, usuario) : null;
    if (!conCred) { if (!st.cargas.has(o.id)) { marcarSinCredenciales(st, o); cambio = true; } sinCredenciales += 1; continue; }
    objetivos.push(conCred);
  }
  if (cambio) reconstruir(st);

  const motores = {};   // motor -> { rechazos, ok, detenido }
  const cola = [...objetivos];
  const trabajador = async () => {
    while (cola.length) {
      const origen = cola.shift();
      const m = motores[origen.motor] || (motores[origen.motor] = { rechazos: 0, ok: false, detenido: false });
      if (m.detenido) {
        const reg = st.origenes.get(origen.id) || registroNuevo(origen);
        reg.info = infoPublica(origen);
        reg.estado = reg.tablas.length ? 'ok' : 'error';
        reg.cargando = false;
        reg.error = 'Se detuvo para no bloquear tu cuenta: revisa tu usuario y clave en «Mis credenciales» y actualiza de nuevo.';
        st.origenes.set(origen.id, reg);
        reconstruir(st);
        continue;
      }
      const r = await cargarOrigen(st, origen);
      if (r?.ok) { m.ok = true; m.rechazos = 0; }
      else if (r?.rechazoLogin) { m.rechazos += 1; if (!m.ok && m.rechazos >= 2) m.detenido = true; }
      else m.rechazos = 0;
    }
  };
  const trabajo = Promise.all(Array.from({ length: Math.min(MAX_PARALELO, cola.length) }, trabajador));
  if (esperar) await trabajo; else trabajo.catch(() => {});
  return { tabla: true, iniciados: objetivos.length, sinCredenciales };
}

// Primera apertura de esta persona: dispara la lectura en segundo plano.
async function asegurarCargado(pool) {
  if (est().inicializado) return;
  await actualizar(pool);
}

// --- Resumen / galaxia -------------------------------------------------------------
function resumen() {
  const lista = [...origenes.values()].map((o) => ({
    ...o.info, estado: o.estado, cargando: !!o.cargando, progreso: o.progreso, error: o.error,
    actualizadoEn: o.actualizadoEn, duracionMs: o.duracionMs, advertencias: o.advertencias, bases: o.bases,
  })).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const totales = { origenes: lista.length, bases: 0, tablas: 0, vistas: 0, columnas: 0, fks: 0 };
  for (const o of lista) for (const b of o.bases) {
    totales.bases += 1; totales.tablas += b.tablas; totales.vistas += b.vistas; totales.columnas += b.columnas; totales.fks += b.fks;
  }
  return { origenes: lista, totales, cargando: lista.some((o) => o.cargando), sinCredenciales: lista.filter((o) => o.estado === 'sin-credenciales').length };
}

// Afinidad entre bases por columnas con el mismo nombre (inferido, NO son llaves foráneas).
function puentes(limite = 40) {
  const porNombre = new Map(); // nombre -> Map(baseKey -> nTablas)
  for (const [k, e] of indice.columnas) {
    if (k.length < 5 || COLUMNAS_GENERICAS.has(k)) continue;
    const bases = new Map();
    for (const { tabla } of e.tablas) {
      const bk = `${tabla.origenId}\u0001${tabla.bd}`;
      bases.set(bk, (bases.get(bk) || 0) + 1);
    }
    if (bases.size < 2 || bases.size > 6) continue;
    porNombre.set(e.nombre, bases);
  }
  const pares = new Map();
  for (const [nombre, bases] of porNombre) {
    const claves = [...bases.keys()].sort();
    for (let i = 0; i < claves.length; i++) for (let j = i + 1; j < claves.length; j++) {
      const k = `${claves[i]}\u0002${claves[j]}`;
      let p = pares.get(k);
      if (!p) { p = { a: claves[i], b: claves[j], comunes: 0, ejemplos: [] }; pares.set(k, p); }
      p.comunes += 1;
      if (p.ejemplos.length < 6) p.ejemplos.push(nombre);
    }
  }
  const formato = (bk) => { const [o, bd] = bk.split('\u0001'); return { o, bd }; };
  return [...pares.values()].sort((x, y) => y.comunes - x.comunes).slice(0, limite)
    .map((p) => ({ a: formato(p.a), b: formato(p.b), comunes: p.comunes, ejemplos: p.ejemplos }));
}

function galaxia() {
  return { ...resumen(), puentes: puentes() };
}

// --- Búsqueda ----------------------------------------------------------------------
function puntaje(nombreL, tokens) {
  let total = 0;
  for (const t of tokens) {
    if (nombreL === t) total += 100;
    else if (nombreL.startsWith(t)) total += 70;
    else if (new RegExp(`(^|[_\\W])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(nombreL)) total += 50;
    else if (nombreL.includes(t)) total += 40;
    else return 0;
  }
  return total;
}

function resumenTabla(t) {
  return {
    ref: t.ref, origen: t.origenNombre, motor: t.motor, bd: t.bd, esquema: t.esquema, nombre: t.nombre, tipo: t.tipo,
    descripcion: t.descripcion, filas: t.filas, nColumnas: t.columnas.length,
  };
}

function buscar({ q, tipo = 'todo', origenId = null, bd = null, limite = 40 }) {
  const consulta = norm(q).trim();
  if (consulta.length < 2) return { tablas: [], columnas: [], totalTablas: 0, totalColumnas: 0 };
  const tokens = consulta.split(/\s+/).filter(Boolean).slice(0, 5);
  const pasa = (t) => (!origenId || t.origenId === String(origenId)) && (!bd || t.bd === bd);
  const lim = Math.min(Math.max(parseInt(limite, 10) || 40, 1), 100);

  let tablas = [];
  let totalTablas = 0;
  if (tipo === 'todo' || tipo === 'tabla') {
    const hallazgos = [];
    for (const t of indice.tablas) {
      if (!pasa(t)) continue;
      const nombreL = norm(t.nombre);
      let p = puntaje(nombreL, tokens);
      if (!p) {
        // Los tokens pueden repartirse entre nombre, base, esquema y descripción.
        const pajar = `${nombreL} ${norm(t.bd)} ${norm(t.esquema)} ${norm(t.descripcion)}`;
        if (tokens.every((x) => pajar.includes(x))) p = 15;
      }
      if (p) hallazgos.push({ t, p: p + (t.tipo === 'TABLA' ? 2 : 0) });
    }
    totalTablas = hallazgos.length;
    hallazgos.sort((a, b) => b.p - a.p || a.t.nombre.length - b.t.nombre.length || a.t.nombre.localeCompare(b.t.nombre));
    tablas = hallazgos.slice(0, lim).map((h) => resumenTabla(h.t));
  }

  let columnas = [];
  let totalColumnas = 0;
  if (tipo === 'todo' || tipo === 'columna') {
    const hallazgos = [];
    for (const [k, e] of indice.columnas) {
      const p = puntaje(k, tokens);
      if (!p) continue;
      const lugares = e.tablas.filter(({ tabla }) => pasa(tabla));
      if (!lugares.length) continue;
      hallazgos.push({ e, p, lugares });
    }
    totalColumnas = hallazgos.length;
    hallazgos.sort((a, b) => b.p - a.p || b.lugares.length - a.lugares.length || a.e.nombre.localeCompare(b.e.nombre));
    columnas = hallazgos.slice(0, lim).map(({ e, lugares }) => ({
      nombre: e.nombre,
      apariciones: lugares.length,
      bases: new Set(lugares.map(({ tabla }) => `${tabla.origenId}\u0001${tabla.bd}`)).size,
      ejemplos: lugares.slice(0, 6).map(({ tabla, columna }) => ({ ...resumenTabla(tabla), tipoDato: columna.tipo, pk: columna.pk })),
    }));
  }
  return { tablas, columnas, totalTablas, totalColumnas };
}

function lugaresDeColumna(nombre, { origenId = null, bd = null, desde = 0, limite = 50 } = {}) {
  const e = indice.columnas.get(norm(nombre));
  if (!e) return { nombre, total: 0, lugares: [] };
  const filtrados = e.tablas.filter(({ tabla }) => (!origenId || tabla.origenId === String(origenId)) && (!bd || tabla.bd === bd));
  const lim = Math.min(Math.max(parseInt(limite, 10) || 50, 1), 200);
  return {
    nombre: e.nombre, total: filtrados.length,
    lugares: filtrados.slice(Math.max(parseInt(desde, 10) || 0, 0), Math.max(parseInt(desde, 10) || 0, 0) + lim)
      .map(({ tabla, columna }) => ({ ...resumenTabla(tabla), tipoDato: columna.tipo, pk: columna.pk, nulo: columna.nulo })),
  };
}

// --- Diccionario / grafo ---------------------------------------------------------------
function buscarPorRef(ref) {
  if (!ref) return null;
  return indice.porClave.get(claveDe(String(ref.o), ref.bd, ref.es, ref.n)) || null;
}

function detalle(ref) {
  const t = buscarPorRef(ref);
  if (!t) return null;
  const fkPorColumna = new Map();
  for (const p of t.padres) for (const c of p.columnas) {
    const l = fkPorColumna.get(c.col) || [];
    l.push({ tabla: resumenTabla(p.tabla), columna: c.refCol, fk: p.nombre });
    fkPorColumna.set(c.col, l);
  }
  // Columnas de MariaDB/SQL Server que otras tablas referencian.
  const referenciadaPor = new Map();
  for (const h of t.hijas) for (const c of h.columnas) {
    const l = referenciadaPor.get(c.refCol) || [];
    if (l.length < 8) l.push({ tabla: resumenTabla(h.tabla), columna: c.col });
    referenciadaPor.set(c.refCol, l);
  }
  return {
    ref: t.ref, origen: { id: t.origenId, nombre: t.origenNombre, motor: t.motor }, bd: t.bd, esquema: t.esquema, nombre: t.nombre,
    tipo: t.tipo, descripcion: t.descripcion, filas: t.filas,
    columnas: t.columnas.map((c, i) => ({
      orden: i + 1, ...c,
      fk: fkPorColumna.get(c.nombre) || [],
      referenciadaPor: referenciadaPor.get(c.nombre) || [],
      otrasTablas: Math.max((indice.columnas.get(norm(c.nombre))?.tablas.length || 1) - 1, 0),
    })),
    padres: t.padres.map((p) => ({ tabla: resumenTabla(p.tabla), fk: p.nombre, columnas: p.columnas })),
    hijas: t.hijas.map((h) => ({ tabla: resumenTabla(h.tabla), fk: h.nombre, columnas: h.columnas })),
  };
}

function nodoGrafo(t, nivel, destacar) {
  const fkCols = new Set();
  for (const p of t.padres) for (const c of p.columnas) fkCols.add(c.col);
  const refCols = new Set();
  for (const h of t.hijas) for (const c of h.columnas) refCols.add(c.refCol);
  const orden = [...t.columnas].map((c, i) => ({ c, i }))
    .sort((a, b) => (Number(b.c.pk) * 2 + Number(fkCols.has(b.c.nombre))) - (Number(a.c.pk) * 2 + Number(fkCols.has(a.c.nombre))) || a.i - b.i);
  const limite = destacar ? MAX_COLUMNAS_NODO + 8 : MAX_COLUMNAS_NODO;
  return {
    id: t.clave, ref: t.ref, nombre: t.nombre, esquema: t.esquema, bd: t.bd, tipo: t.tipo, nivel,
    nColumnas: t.columnas.length, filas: t.filas,
    columnas: orden.slice(0, limite).map(({ c }) => ({ nombre: c.nombre, tipo: c.tipo, pk: c.pk, fk: fkCols.has(c.nombre), nulo: c.nulo })),
    masColumnas: Math.max(t.columnas.length - limite, 0),
  };
}

// Tabla + dependencias directas (padres e hijas); `profundidad` 2 suma el siguiente anillo.
function grafo(ref, profundidad = 1) {
  const centro = buscarPorRef(ref);
  if (!centro) return null;
  const prof = Math.min(Math.max(parseInt(profundidad, 10) || 1, 1), 2);
  const nivel = new Map([[centro.clave, 0]]);
  const orden = [centro];
  let frontera = [centro];
  let truncado = false;
  for (let d = 1; d <= prof; d++) {
    const siguiente = [];
    for (const t of frontera) {
      // Padres hacia la izquierda (nivel negativo), hijas hacia la derecha (positivo).
      const vecinos = [
        ...t.padres.map((p) => ({ t: p.tabla, signo: -1 })),
        ...t.hijas.map((h) => ({ t: h.tabla, signo: 1 })),
      ];
      for (const { t: v, signo } of vecinos) {
        if (nivel.has(v.clave)) continue;
        if (orden.length >= MAX_NODOS_GRAFO) { truncado = true; continue; }
        const base = nivel.get(t.clave);
        nivel.set(v.clave, base === 0 ? signo * d : base + signo);
        orden.push(v);
        siguiente.push(v);
      }
    }
    frontera = siguiente;
  }
  const incluidos = new Set(orden.map((t) => t.clave));
  const aristas = [];
  for (const t of orden) {
    for (const p of t.padres) {
      if (!incluidos.has(p.tabla.clave)) continue;
      aristas.push({ id: `${t.clave}>${p.nombre}`, desde: t.clave, hacia: p.tabla.clave, nombre: p.nombre, columnas: p.columnas, propia: t.clave === p.tabla.clave });
    }
  }
  return { centro: centro.clave, nodos: orden.map((t) => nodoGrafo(t, nivel.get(t.clave), t === centro)), aristas, truncado };
}

// Todas las tablas de una base con sus relaciones (para el mapa estelar).
function mapaBase(origenId, bd) {
  const lista = indice.tablas.filter((t) => t.origenId === String(origenId) && t.bd === bd);
  if (!lista.length) return null;
  const pos = new Map(lista.map((t, i) => [t.clave, i]));
  const aristas = [];
  const vistos = new Set();
  for (const t of lista) {
    for (const p of t.padres) {
      const j = pos.get(p.tabla.clave);
      if (j === undefined) continue;
      const i = pos.get(t.clave);
      const k = `${i}>${j}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      if (aristas.length < MAX_ARISTAS_MAPA) aristas.push([i, j]);
    }
  }
  return {
    origen: { id: String(origenId), nombre: lista[0].origenNombre, motor: lista[0].motor }, bd,
    tablas: lista.map((t) => ({
      ref: t.ref, nombre: t.nombre, esquema: t.esquema, tipo: t.tipo, nColumnas: t.columnas.length, filas: t.filas,
      nPadres: t.padres.length, nHijas: t.hijas.length, descripcion: t.descripcion,
    })),
    aristas,
  };
}

// --- Apoyo para el constructor de queries (objetos internos: solo uso en el servidor) ---------------
function tablaPorRef(ref) { return buscarPorRef(ref); }

// Tablas que coinciden con un nombre (bd.esquema.tabla, esquema.tabla o solo tabla), opcionalmente de un origen.
function tablasPorNombre({ bd = '', esquema = '', tabla = '', origenId = null } = {}) {
  const n = norm(tabla);
  if (!n) return [];
  const es = norm(esquema || 'dbo');
  let lista = bd ? (indice.porNombre.get(`${norm(bd)}.${es}.${n}`) || []) : (indice.porNombre.get(`${es}.${n}`) || []);
  if (!lista.length && !esquema) lista = indice.porNombre.get(n) || [];
  if (!lista.length && esquema) lista = (indice.porNombre.get(n) || []).filter((t) => norm(t.esquema || 'dbo') === es || !t.esquema);
  return origenId ? lista.filter((t) => t.origenId === String(origenId)) : lista;
}

// Tablas candidatas para una lista de palabras (nombre, columnas y descripción). Devuelve [{ t, puntos }].
function candidatasPorPalabras(palabras, { origenId = null, limite = 12 } = {}) {
  const tokens = [...new Set((palabras || []).map((x) => norm(x).trim()).filter((x) => x.length >= 3))].slice(0, 10);
  if (!tokens.length) return [];
  const res = [];
  for (const t of indice.tablas) {
    if (origenId && t.origenId !== String(origenId)) continue;
    const nombre = norm(t.nombre);
    const desc = norm(t.descripcion);
    const cols = t.columnas.map((c) => norm(c.nombre));
    let puntos = 0;
    for (const k of tokens) {
      if (nombre === k) puntos += 14;
      else if (nombre.includes(k)) puntos += 9;
      if (desc.includes(k)) puntos += 3;
      let en = 0;
      for (const c of cols) if (c.includes(k)) en += 1;
      puntos += Math.min(en, 3) * 2;
    }
    if (puntos > 0) res.push({ t, puntos: puntos + (t.tipo === 'TABLA' ? 1 : 0) });
  }
  return res.sort((a, b) => b.puntos - a.puntos || a.t.nombre.length - b.t.nombre.length).slice(0, limite);
}

function datosOrigen(origenId) {
  const o = origenes.get(String(origenId));
  return o ? { ...o.info, bases: o.bases.map((b) => b.nombre) } : null;
}

// Solo para pruebas.
function _reiniciar() { estados.clear(); }
function _cargarPrueba(lista) {
  const st = est();
  st.origenes.clear();
  for (const { info, tablas } of lista) {
    st.origenes.set(info.id, { info, estado: 'ok', progreso: null, error: null, actualizadoEn: null, duracionMs: 0, advertencias: [], bases: resumenBases(tablas, []), tablas: tablas.map((t) => enriquecer(info, null, t)) });
  }
  st.inicializado = true;
  reconstruir(st);
}

module.exports = {
  actualizar, asegurarCargado, resumen, galaxia, buscar, lugaresDeColumna, detalle, grafo, mapaBase,
  tablaPorRef, tablasPorNombre, candidatasPorPalabras, datosOrigen, resumenTabla, COLUMNAS_GENERICAS,
  _reiniciar, _cargarPrueba,
};
