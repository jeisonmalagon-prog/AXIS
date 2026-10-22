// Catálogo de ORQBIOMETRIA para cruzar con los casos (SOLO LECTURA).
//
// Cómo se relacionan las tablas (esquema real):
//   CASO.idRegla ─► REGLA.id. Una REGLA es la configuración de UN producto/subproducto en UNA transacción:
//        REGLA.idProductoSubProducto ─► PRODUCTOSUBPRODUCTO ─► PRODUCTO.producto + SUBPRODUCTO.subProducto
//        REGLA.idTransaccion         ─► TRANSACCION.tipoTransaccion (1 Enrolamiento, 2 Login)   ← la transacción NO es la regla
//        REGLA.idValidacion          ─► VALIDACION.idValidacion (varias filas, una por proveedor-servicio con su peso)
//                                       VALIDACION.idProveedorServicio ─► PROVEEDORSERVICIO ─► PROVEEDOR.nombreProveedor + SERVICIO.tipoServicio
//                                    ─► VALIDACIONTIPOCAPTURA ─► TIPOCAPTURA.tipoCaptura (capturas que pide, esObligatorio)
//        REGLA.intentosDia / intentosMes / vigencia = límites de la regla;  INTENTO(idCliente, idRegla) = contadores del cliente.
//   CASO.idCanal ─► CANAL (0 = canal por defecto que el equipo llama WhoisWho, 1 = App Personas).
//   CLIENTE.idTipoDocumento ─► TIPODOCUMENTO.
//
// Son tablas de configuración pequeñas: se leen completas (SELECT *) y las columnas se buscan por nombre sin distinguir
// mayúsculas, así que un nombre distinto no rompe el tablero (solo deja ese dato en blanco y lo informa en `avisos`).
// Se guardan 10 minutos en memoria. Nunca se leen CAPTURA ni RESULTADO completas (pueden traer imágenes).

const cfg = require('./biometriaConsumoConfig');

const TTL_MS = 10 * 60 * 1000;
const TABLAS = [
  'REGLA', 'PROVEEDOR', 'PROVEEDORSERVICIO', 'SERVICIO', 'TRANSACCION', 'VALIDACION', 'VALIDACIONTIPOCAPTURA', 'TIPOCAPTURA',
  'PRODUCTOSUBPRODUCTO', 'PRODUCTO', 'SUBPRODUCTO', 'TIPODOCUMENTO', 'CANAL',
];
let cache = null; // { expira, datos }

const n = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const texto = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

/** Valor de la primera columna cuyo nombre cumpla alguna de las expresiones (sin distinguir mayúsculas). */
function col(fila, ...res) {
  if (!fila) return undefined;
  const claves = Object.keys(fila);
  for (const re of res) {
    const k = claves.find((c) => re.test(c));
    if (k !== undefined) return fila[k];
  }
  return undefined;
}

/**
 * Nombre legible de una fila de catálogo. Primero busca la columna esperada por nombre (ej. /^tipotransaccion$/i); si no existe
 * (otro nombre de columna), usa la primera columna de texto que no sea id, código, fecha ni usuario.
 */
function nombreDe(fila, ...preferidas) {
  if (!fila) return null;
  for (const re of preferidas) {
    const v = col(fila, re);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const [k, v] of Object.entries(fila)) {
    if (/^(id|codigo|fecha|usuario)/i.test(k)) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

async function leerTabla(nombre, avisos) {
  try {
    return await cfg.consultar(`SELECT TOP 5000 * FROM dbo.${nombre}`, []);
  } catch (error) {
    avisos.push({ seccion: `catálogo ${nombre}`, error: cfg.mensajeError(error) });
    return [];
  }
}

/** Nombre de la clasificación del equipo (misma regla que el tablero): reglas 1 y 99 = ASISA, el resto OLIMPIA. */
const clasificacionDe = (regla) => (regla === 1 || regla === 99 ? 'ASISA' : 'OLIMPIA');

function armar(t, avisos) {
  const porId = (filas) => new Map(filas.map((f) => [n(col(f, /^id$/i)), f]));
  const proveedores = porId(t.PROVEEDOR);
  const servicios = porId(t.SERVICIO);
  const transacciones = porId(t.TRANSACCION);
  const tiposCaptura = porId(t.TIPOCAPTURA);
  const productos = porId(t.PRODUCTO);
  const subproductos = porId(t.SUBPRODUCTO);
  const prodSub = porId(t.PRODUCTOSUBPRODUCTO);

  const provServ = new Map(); // id de PROVEEDORSERVICIO -> { proveedor, servicio }
  for (const ps of t.PROVEEDORSERVICIO) {
    const id = n(col(ps, /^id$/i));
    const idProv = n(col(ps, /^idproveedor$/i, /proveedor/i));
    const idServ = n(col(ps, /^idservicio$/i, /servicio/i));
    provServ.set(id, { proveedor: nombreDe(proveedores.get(idProv), /^nombreproveedor$/i) || (idProv !== null ? `Proveedor ${idProv}` : null), servicio: nombreDe(servicios.get(idServ), /^tiposervicio$/i) || (idServ !== null ? `Servicio ${idServ}` : null) });
  }

  const porValidacion = new Map(); // idValidacion -> [{ proveedor, servicio, peso }]
  for (const v of t.VALIDACION) {
    const idVal = n(col(v, /^idvalidacion$/i));
    const ps = provServ.get(n(col(v, /^idproveedorservicio$/i)));
    const lista = porValidacion.get(idVal) || [];
    lista.push({ proveedor: ps?.proveedor ?? null, servicio: ps?.servicio ?? null, peso: n(col(v, /^pesoresultado$/i, /peso/i)) });
    porValidacion.set(idVal, lista);
  }

  const capturasValidacion = new Map(); // idValidacion -> [{ tipo, obligatorio }]
  for (const c of t.VALIDACIONTIPOCAPTURA) {
    const idVal = n(col(c, /^idvalidacion$/i));
    const tipo = nombreDe(tiposCaptura.get(n(col(c, /^idtipocaptura$/i))), /^tipocaptura$/i) || `Tipo ${n(col(c, /^idtipocaptura$/i))}`;
    const lista = capturasValidacion.get(idVal) || [];
    lista.push({ tipo, obligatorio: Number(col(c, /^esobligatorio$/i)) === 1 || col(c, /^esobligatorio$/i) === true });
    capturasValidacion.set(idVal, lista);
  }

  const reglas = t.REGLA.map((r) => {
    const id = n(col(r, /^id$/i));
    const idVal = n(col(r, /^idvalidacion$/i));
    const idPS = n(col(r, /^idproductosubproducto$/i));
    const idTrans = n(col(r, /^idtransaccion$/i));
    const ps = prodSub.get(idPS);
    const consulta = (porValidacion.get(idVal) || []).slice().sort((a, b) => (b.peso ?? 0) - (a.peso ?? 0));
    const clasificacion = clasificacionDe(id);
    const nombres = consulta.map((c) => String(c.proveedor || '').toUpperCase());
    const producto = nombreDe(productos.get(n(col(ps, /^idproducto$/i))), /^producto$/i);
    const subproducto = nombreDe(subproductos.get(n(col(ps, /^idsubproducto$/i))), /^subproducto$/i);
    return {
      id,
      // Qué producto/subproducto configura la regla (REGLA → PRODUCTOSUBPRODUCTO). Es lo que identifica a una regla; NO es la transacción.
      idProductoSubProducto: idPS, producto, subproducto,
      descripcion: [...new Set([producto, subproducto].filter(Boolean))].join(' · ') || null,
      // Transacción (REGLA.idTransaccion → TRANSACCION): Enrolamiento / Login. Es un dato aparte de la regla.
      idTransaccion: idTrans, transaccion: nombreDe(transacciones.get(idTrans), /^tipotransaccion$/i) || (idTrans !== null ? `Transacción ${idTrans}` : null),
      // Texto libre de REGLA.topico (se conserva solo como dato técnico; no es el nombre de la regla).
      topico: texto(col(r, /^topico$/i)),
      intentosDia: n(col(r, /^intentosdia$/i)), intentosMes: n(col(r, /^intentosmes$/i)), vigencia: n(col(r, /^vigencia$/i)),
      validacion: idVal, consulta, capturas: capturasValidacion.get(idVal) || [],
      clasificacion,
      // ¿La configuración (VALIDACION) consulta al proveedor con el que el equipo clasifica esta regla? null = sin datos para comparar.
      coincide: consulta.length ? nombres.some((x) => x.includes(clasificacion)) : null,
    };
  }).filter((r) => r.id !== null).sort((a, b) => a.id - b.id);

  return {
    reglas,
    tiposCaptura: t.TIPOCAPTURA.map((x) => ({ id: n(col(x, /^id$/i)), nombre: nombreDe(x, /^tipocaptura$/i) })),
    tiposDocumento: t.TIPODOCUMENTO.map((x) => ({ id: n(col(x, /^id$/i)), nombre: nombreDe(x, /^tipodocumento$/i) })),
    canales: t.CANAL.map((x) => ({ id: n(col(x, /^id$/i)), nombre: nombreDe(x, /^canal$/i) })),
    avisos,
  };
}

/** Catálogo ya armado (reglas con sus límites y proveedores, tipos de documento, canales). Nunca lanza: si algo falla, devuelve lo que pudo con `avisos`. */
async function obtener({ forzar = false } = {}) {
  if (!forzar && cache && cache.expira > Date.now()) return cache.datos;
  const avisos = [];
  const t = {};
  for (const nombre of TABLAS) t[nombre] = await leerTabla(nombre, avisos);
  // Si ninguna tabla se pudo leer (sin conexión) se informa un solo aviso y no se guarda, para reintentar pronto.
  const sinNada = avisos.length >= TABLAS.length;
  const datos = armar(t, sinNada ? [{ seccion: 'catálogo de reglas', error: avisos[0].error }] : avisos);
  if (!sinNada) cache = { expira: Date.now() + TTL_MS, datos };
  return datos;
}

module.exports = { obtener, clasificacionDe, _prueba: { armar, col, nombreDe, limpiarCache: () => { cache = null; } } };
