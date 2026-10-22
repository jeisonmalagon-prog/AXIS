// Lógica de armado del informe de Aplicaciones e Inventario de
// Sub-aplicativos (Fase 2 del informe general del aplicativo) — mismo
// patrón que utils/informeCertificados.js.
//
// LIMITACIÓN CONOCIDA (documentada a propósito, igual que en los demás
// informes de esta fase): ni Aplicaciones ni inv_aplicativos tienen una
// columna de auditoría real (FechaRegistro/FechaActualizacion) — la única
// fecha de auditoría confiable en todo este módulo es
// inv_aplicativo_conexiones_bd.fecha_registro. Por eso este informe es,
// sobre todo, un SNAPSHOT del estado actual (cuántos hay, cuáles quedaron
// sin certificado, servidores sin aplicativos), y el único dato realmente
// filtrado por periodo (y con tendencia/comparación) es la lista de
// conexiones a bases de datos registradas. Si más adelante se necesita un
// "altas de sub-aplicativos por periodo" real, hay que agregar una columna
// de fecha a Aplicaciones/inv_aplicativos primero (ver
// fix_vista_aplicativos_negocio.sql como ejemplo de migración ya hecha en
// este mismo módulo).
//
// AMPLIACIÓN (estadística): se agregó tendencia de conexiones a BD
// registradas por periodo (mismas cubetas adaptativas que
// informeCertificados.js) y comparación contra el periodo anterior. Se
// agregó un tercer parámetro opcional "periodoSeleccionado" con valor por
// defecto, así que cualquier llamador existente sigue funcionando igual.

const { getPool } = require('../db');

function formatoFechaSql(fecha) {
  return fecha.toISOString().slice(0, 10);
}

function sumarDias(fecha, dias) {
  const resultado = new Date(fecha);
  resultado.setDate(resultado.getDate() + dias);
  return resultado;
}

function sumarMeses(fecha, meses) {
  const resultado = new Date(fecha);
  resultado.setMonth(resultado.getMonth() + meses);
  return resultado;
}

function calcularRangoPeriodo(periodo) {
  const hasta = new Date();
  const desde = new Date();
  switch (periodo) {
    case 'dia':
      desde.setDate(desde.getDate() - 1);
      break;
    case 'mes':
      desde.setMonth(desde.getMonth() - 1);
      break;
    case 'semana':
    default:
      desde.setDate(desde.getDate() - 7);
      break;
  }
  return { desde: formatoFechaSql(desde), hasta: formatoFechaSql(hasta) };
}

function resolverRango(req) {
  const { desde, hasta, periodo } = req.query;
  if (desde && hasta) return { desde, hasta };
  return calcularRangoPeriodo(periodo);
}

// ==========================================================================
// TENDENCIA POR PERIODOS HISTÓRICOS (mismo criterio de cubetas adaptativas
// que informeCertificados.js).
// ==========================================================================
function generarBucketsTendencia(hasta, periodoSeleccionado, desdeSeleccionado) {
  const hastaDate = new Date(`${hasta}T00:00:00`);
  let unidad = 'semana';
  let cantidad = 8;

  if (periodoSeleccionado === 'dia') {
    unidad = 'dia';
    cantidad = 14;
  } else if (periodoSeleccionado === 'mes') {
    unidad = 'mes';
    cantidad = 6;
  } else if (periodoSeleccionado === 'rango' && desdeSeleccionado) {
    const desdeDate = new Date(`${desdeSeleccionado}T00:00:00`);
    const diasSpan = Math.max(1, Math.round((hastaDate - desdeDate) / 86400000) + 1);
    if (diasSpan <= 14) {
      unidad = 'dia';
      cantidad = diasSpan;
    } else if (diasSpan <= 90) {
      unidad = 'semana';
      cantidad = Math.min(12, Math.ceil(diasSpan / 7));
    } else {
      unidad = 'mes';
      cantidad = Math.min(12, Math.ceil(diasSpan / 30));
    }
  }

  const formatoCorto = (fecha) => fecha.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit' });
  const formatoMes = (fecha) => fecha.toLocaleDateString('es-CO', { month: 'short', year: '2-digit' }).replace('.', '');

  const buckets = [];
  for (let i = cantidad - 1; i >= 0; i--) {
    let inicio;
    let fin;
    let etiqueta;
    if (unidad === 'dia') {
      fin = sumarDias(hastaDate, -i);
      inicio = fin;
      etiqueta = formatoCorto(inicio);
    } else if (unidad === 'semana') {
      fin = sumarDias(hastaDate, -i * 7);
      inicio = sumarDias(fin, -6);
      etiqueta = formatoCorto(inicio);
    } else {
      fin = sumarMeses(hastaDate, -i);
      inicio = new Date(fin.getFullYear(), fin.getMonth(), 1);
      etiqueta = formatoMes(inicio);
    }
    buckets.push({ desde: formatoFechaSql(inicio), hasta: formatoFechaSql(fin), etiqueta });
  }
  return buckets;
}

function fechaDentroDeBucket(fecha, bucket) {
  const soloFecha = (typeof fecha === 'string' ? fecha : fecha.toISOString()).slice(0, 10);
  return soloFecha >= bucket.desde && soloFecha <= bucket.hasta;
}

async function calcularTendenciaConexiones(pool, bucketDefs) {
  if (!bucketDefs.length) return [];
  const desdeGlobal = bucketDefs[0].desde;
  const hastaGlobal = bucketDefs[bucketDefs.length - 1].hasta;

  const [filas] = await pool.query(
    `SELECT fecha_registro FROM inv_aplicativo_conexiones_bd WHERE fecha_registro BETWEEN ? AND ?`,
    [`${desdeGlobal} 00:00:00`, `${hastaGlobal} 23:59:59`]
  );

  return bucketDefs.map((bucket) => {
    let total = 0;
    for (const fila of filas) {
      if (fechaDentroDeBucket(fila.fecha_registro, bucket)) total += 1;
    }
    return { etiqueta: bucket.etiqueta, desde: bucket.desde, hasta: bucket.hasta, total };
  });
}

function calcularPeriodoAnterior(desde, hasta) {
  const desdeDate = new Date(`${desde}T00:00:00`);
  const hastaDate = new Date(`${hasta}T00:00:00`);
  const diasSpan = Math.round((hastaDate - desdeDate) / 86400000) + 1;
  const nuevoHasta = sumarDias(desdeDate, -1);
  const nuevoDesde = sumarDias(nuevoHasta, -(diasSpan - 1));
  return { desde: formatoFechaSql(nuevoDesde), hasta: formatoFechaSql(nuevoHasta) };
}

function calcularCambioPorcentual(actual, anterior) {
  if (anterior === 0) return actual === 0 ? 0 : null;
  return Math.round(((actual - anterior) / anterior) * 100);
}

async function calcularComparacionConexiones(pool, desde, hasta, actual) {
  const anterior = calcularPeriodoAnterior(desde, hasta);
  const [[{ totalAnterior }]] = await pool.query(
    `SELECT COUNT(*) AS totalAnterior FROM inv_aplicativo_conexiones_bd WHERE fecha_registro BETWEEN ? AND ?`,
    [`${anterior.desde} 00:00:00`, `${anterior.hasta} 23:59:59`]
  );
  return {
    periodoAnterior: anterior,
    actual,
    anterior: totalAnterior,
    cambioPorc: calcularCambioPorcentual(actual, totalAnterior),
  };
}

async function armarDatosInformeAplicaciones(desde, hasta, periodoSeleccionado = 'rango') {
  const pool = await getPool();

  // ---------- Snapshot actual ----------
  const [[{ totalAplicacionesNegocio }]] = await pool.query(
    'SELECT COUNT(*) AS totalAplicacionesNegocio FROM Aplicaciones WHERE ServidorId IS NULL AND Activo = 1'
  );
  const [[{ totalSubaplicativos }]] = await pool.query(
    'SELECT COUNT(*) AS totalSubaplicativos FROM Aplicaciones WHERE ServidorId IS NOT NULL AND Activo = 1'
  );
  const [[{ totalServidores }]] = await pool.query('SELECT COUNT(*) AS totalServidores FROM Servidores WHERE Activo = 1');

  const [servidoresSinAplicativos] = await pool.query(`
    SELECT s.Id, s.Hostname, s.IP
    FROM Servidores s
    WHERE s.Activo = 1
      AND NOT EXISTS (SELECT 1 FROM Aplicaciones a WHERE a.ServidorId = s.Id AND a.Activo = 1)
    ORDER BY s.Hostname ASC
  `);

  const [subaplicativosSinCertificado] = await pool.query(`
    SELECT ap.Id, ap.Nombre, s.Hostname
    FROM Aplicaciones ap
    LEFT JOIN inv_aplicativos ia ON ia.aplicacion_id = ap.Id
    LEFT JOIN Servidores s ON s.Id = ap.ServidorId
    WHERE ap.ServidorId IS NOT NULL AND ap.Activo = 1 AND ia.certificado_id IS NULL
    ORDER BY ap.Nombre ASC
  `);

  const [criticidadFilas] = await pool.query(`
    SELECT COALESCE(NULLIF(TRIM(ia.criticidad), ''), 'Sin definir') AS criticidad, COUNT(*) AS total
    FROM Aplicaciones ap
    LEFT JOIN inv_aplicativos ia ON ia.aplicacion_id = ap.Id
    WHERE ap.ServidorId IS NOT NULL AND ap.Activo = 1
    GROUP BY COALESCE(NULLIF(TRIM(ia.criticidad), ''), 'Sin definir')
    ORDER BY total DESC
  `);

  // ---------- Periodo: única fecha de auditoría real de este módulo ----------
  const [conexionesBdEnPeriodo] = await pool.query(
    `SELECT c.id, c.motor_bd, c.nombre_base_datos, c.esquema, c.usuario_servicio, c.fecha_registro,
            ap.Nombre AS AplicativoNombre, sv.Hostname AS ServidorBdHostname
     FROM inv_aplicativo_conexiones_bd c
     LEFT JOIN Aplicaciones ap ON ap.Id = c.aplicativo_id
     LEFT JOIN Servidores sv ON sv.Id = c.servidor_bd_id
     WHERE c.fecha_registro BETWEEN ? AND ?
     ORDER BY c.fecha_registro DESC`,
    [`${desde} 00:00:00`, `${hasta} 23:59:59`]
  );

  const [motoresBdFilas] = await pool.query(`
    SELECT COALESCE(NULLIF(TRIM(motor_bd), ''), 'Sin definir') AS motor, COUNT(*) AS total
    FROM inv_aplicativo_conexiones_bd
    GROUP BY COALESCE(NULLIF(TRIM(motor_bd), ''), 'Sin definir')
    ORDER BY total DESC
  `);

  // ---------- Tendencia y comparación de conexiones BD ----------
  const bucketDefs = generarBucketsTendencia(hasta, periodoSeleccionado, desde);
  const [tendenciaConexionesBd, comparacionConexionesBd] = await Promise.all([
    calcularTendenciaConexiones(pool, bucketDefs),
    calcularComparacionConexiones(pool, desde, hasta, conexionesBdEnPeriodo.length),
  ]);

  return {
    periodo: { desde, hasta },
    resumenActual: {
      totalAplicacionesNegocio,
      totalSubaplicativos,
      totalServidores,
      servidoresSinAplicativos: servidoresSinAplicativos.length,
      subaplicativosSinCertificado: subaplicativosSinCertificado.length,
    },
    servidoresSinAplicativos,
    subaplicativosSinCertificado,
    criticidadSubaplicativos: criticidadFilas.map((f) => ({ nombre: f.criticidad, total: f.total })),
    altasConexionesBdEnPeriodo: conexionesBdEnPeriodo.length,
    conexionesBdEnPeriodo,
    topMotoresBd: motoresBdFilas.map((f) => ({ nombre: f.motor, total: f.total })),
    tendenciaConexionesBd,
    comparacionConexionesBd,
  };
}

module.exports = { calcularRangoPeriodo, resolverRango, armarDatosInformeAplicaciones };
