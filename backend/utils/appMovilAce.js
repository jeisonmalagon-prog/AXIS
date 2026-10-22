// ============================================================================
// Catálogo ACE para el visor de logs de App Móvil
// ============================================================================
// Las filas de LogApp que llaman al bus de integración (ACE) se describen como
//   "C004-AccountListInq-getAcctListInfoLite"  (código-servicio-operación).
// Este módulo las cruza con el catálogo del módulo "Servicios" (tablas
// AceServicios / AceOperaciones / AceServiciosInventario de BIC_CERTI_MARIA,
// cargadas desde CatalogoAce.xlsx) para decir QUÉ HACE esa llamada, cuántas
// instancias tiene, cuántos servicios compone, y en qué pod corre.
//
// Reglas de cruce (verificadas con logs reales; sin adivinar):
//   1) Código de servicio (Cnnn) + nombre de operación, sin distinguir mayúsculas.
//   2) Si la operación no está, la mejor coincidencia por nombre dentro del MISMO
//      servicio (p. ej. getAccountListCardInfo ~ getAcctListCardInfo) -> se marca
//      `aproximado: true` para que la pantalla lo diga.
//   3) Si tampoco, solo se informa el servicio (si el código existe).
//   4) Si el código no existe en el catálogo: encontrado=false. Nunca se inventa.
// ============================================================================

const RE_ACE = /^C(\d{3})-([^-]+)-(.+)$/;

/** "C004-AccountListInq-getAcctListInfoLite" -> { id, servicio, operacion } | null */
function parseDescripcionAce(descripcion) {
  const m = RE_ACE.exec(String(descripcion || '').trim());
  if (!m) return null;
  return { id: `C${m[1]}`, servicio: m[2], operacion: m[3].trim() };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Abreviaturas que el catálogo usa de forma sistemática (Acct = Account, Inq...).
function aNormalizadoParaComparar(s) {
  return norm(s).replace(/account/g, 'acct');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Array<{Codigo:string,Nombre:string,Id?:number}>} servicios
 * @param {Array<object>} operaciones filas de AceOperaciones (con ServicioId o con Codigo del servicio)
 * @param {Array<object>} inventario  filas de AceServiciosInventario (opcional)
 */
function crearCatalogoAce(servicios, operaciones, inventario) {
  const porId = new Map(); // 'C004' -> { nombre, ids:Set, ops:[] }
  const idServ = new Map(); // Id numérico -> código
  for (const s of servicios || []) {
    const cod = String(s.Codigo || '').trim().toUpperCase();
    if (!cod) continue;
    let e = porId.get(cod);
    if (!e) { e = { codigo: cod, nombre: s.Nombre, ops: [] }; porId.set(cod, e); }
    if (s.Id !== undefined) idServ.set(s.Id, cod);
  }
  for (const o of operaciones || []) {
    const cod = o.CodigoServicio ? String(o.CodigoServicio).trim().toUpperCase() : idServ.get(o.ServicioId);
    const e = cod && porId.get(cod);
    if (e) e.ops.push(o);
  }
  const inv = new Map();
  for (const i of inventario || []) {
    const cod = String(i.Codigo || '').trim().toUpperCase();
    if (cod && !inv.has(cod)) inv.set(cod, i);
  }

  function resumen(e, o, aproximado) {
    const i = inv.get(e.codigo);
    return {
      encontrado: true,
      aproximado,
      codigo: e.codigo,
      servicio: e.nombre,
      operacion: o ? o.Operacion : null,
      codigoOperacion: o ? o.CodigoOperacion || null : null,
      operacionBackend: o ? o.OperacionBackend || null : null,
      descripcion: o ? (o.Descripcion || '').trim() || null : null,
      version: o ? o.Version || null : null,
      instancias: o ? num(o.Instancias) : null,
      compuestos: o ? num(o.Compuestos) : null,
      atomicos: o ? num(o.Atomicos) : null,
      sincrono: o ? !!Number(o.Sincrono) : null,
      asincrono: o ? !!Number(o.Asincrono) : null,
      pod: i ? i.Pod || null : null
    };
  }

  /** @param {string} id 'C004' @param {string} servicio nombre en el log @param {string} operacion nombre en el log */
  function describir(id, servicio, operacion) {
    const e = porId.get(String(id || '').toUpperCase());
    if (!e) return { encontrado: false, codigo: id, servicio: servicio || null, operacion: operacion || null };
    const buscada = norm(operacion);
    const exacta = e.ops.filter((o) => norm(o.Operacion) === buscada);
    if (exacta.length) {
      // Varias filas de la misma operación (versiones): se prefiere la de mayor versión / más instancias.
      exacta.sort((a, b) => String(b.Version || '').localeCompare(String(a.Version || '')) || (num(b.Instancias) || 0) - (num(a.Instancias) || 0));
      return resumen(e, exacta[0], false);
    }
    const busq2 = aNormalizadoParaComparar(operacion);
    const similar = e.ops.filter((o) => aNormalizadoParaComparar(o.Operacion) === busq2);
    if (similar.length) return resumen(e, similar[0], true);
    return { ...resumen(e, null, true), operacionNoCatalogada: true };
  }

  return { describir, servicios: porId.size, operaciones: (operaciones || []).length };
}

// --------------------------------------------------------------------------
// Carga desde la base (con caché). Tolerante: si las tablas no existen, el
// catálogo queda vacío y todo sigue funcionando sin descripciones.
// --------------------------------------------------------------------------
let cache = { en: 0, catalogo: null };
const TTL_MS = 10 * 60 * 1000;

async function cargarCatalogoAce(getPool) {
  if (cache.catalogo && Date.now() - cache.en < TTL_MS) return cache.catalogo;
  try {
    const pool = await getPool();
    const [servicios] = await pool.query('SELECT Id, Codigo, Nombre FROM AceServicios');
    const [operaciones] = await pool.query(
      `SELECT ServicioId, CodigoOperacion, Operacion, OperacionBackend, Descripcion, Version, Instancias, Compuestos, Atomicos, Sincrono, Asincrono
       FROM AceOperaciones`
    );
    let inventario = [];
    try {
      [inventario] = await pool.query('SELECT Codigo, Pod FROM AceServiciosInventario');
    } catch (e) { /* inventario es opcional */ }
    cache = { en: Date.now(), catalogo: crearCatalogoAce(servicios, operaciones, inventario) };
  } catch (err) {
    console.error('Catálogo ACE no disponible para el visor de logs:', err.message);
    cache = { en: Date.now() - TTL_MS + 60 * 1000, catalogo: crearCatalogoAce([], [], []) }; // reintenta en 1 min
  }
  return cache.catalogo;
}

module.exports = { parseDescripcionAce, crearCatalogoAce, cargarCatalogoAce };
