// Lógica de armado del informe de Bitácora de Apuntamientos (Fase 2 del
// informe general del aplicativo) — mismo patrón que
// utils/informeCertificados.js.
//
// Fuente de la tendencia por periodo: ApuntamientosHistorico.FechaCambio
// (cada alta/ajuste/actualización queda registrada ahí con fecha real, ver
// routes/apuntamientosHistorico.js). El snapshot "ahora mismo" sale de la
// tabla Apuntamientos.
//
// "Incidencia" = una fila de histórico con Accion = 'AJUSTE' que además
// trae TrandId o ErrorDescripcion — ese es el criterio que ya se usa en el
// flujo de "Registrar cambio" del frontend para documentar un
// error/mantenimiento puntual sobre un apuntamiento (ver
// RegistrarCambioApuntamientoPayload en core/models/models.ts).
//
// AMPLIACIÓN (estadística/tendencia/comparación): se agregó tendencia por
// periodos históricos y comparación contra el periodo anterior equivalente
// (altas/ajustes/incidencias), con el mismo mecanismo de cubetas adaptativas
// que ya usa informeCertificados.js. Al igual que allí, esto es solo para
// la vista en pantalla — se agregó un tercer parámetro opcional
// "periodoSeleccionado" con valor por defecto, así que el PDF y cualquier
// otro llamador existente no se rompen sin tocarlos.

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

// Igual que rankingPorCampo() de informeCertificados.js, pero sin el filtro
// de "Estado <> Vigente" — aquí cada fila que llega ya es una incidencia,
// solo hay que contarlas agrupadas por el campo pedido.
function rankingSimplePorCampo(filas, campo, limite = 8) {
  const mapa = new Map();
  for (const fila of filas) {
    const clave = (fila[campo] && String(fila[campo]).trim()) || 'Sin asignar';
    mapa.set(clave, (mapa.get(clave) || 0) + 1);
  }
  return [...mapa.entries()]
    .map(([nombre, total]) => ({ nombre, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limite);
}

// Mismo SELECT (con los mismos JOINs) que SELECT_HISTORICO en
// routes/apuntamientosHistorico.js — duplicado a propósito para no crear
// una dependencia entre dos archivos de rutas.
const SELECT_HISTORICO = `
  SELECT
    h.Id, h.ApuntamientoId, h.Accion,
    h.AplicacionIdAnterior, apA.Nombre AS AplicacionAnteriorNombre,
    h.AplicacionIdNuevo, apN.Nombre AS AplicacionNuevoNombre,
    h.ServidorIdAnterior, svA.Hostname AS ServidorAnteriorHostname,
    h.ServidorIdNuevo, svN.Hostname AS ServidorNuevoHostname,
    h.ComponenteAnterior, h.ComponenteNuevo,
    h.CategoriaAnterior, h.CategoriaNueva,
    h.ServicioInventarioIdNuevo, siN.Codigo AS ServicioNuevoCodigo, siN.NombreServicio AS ServicioNuevoNombre,
    h.Observaciones, h.TrandId, h.ErrorDescripcion,
    h.Usuario, h.FechaCambio
  FROM ApuntamientosHistorico h
  LEFT JOIN Aplicaciones apA ON apA.Id = h.AplicacionIdAnterior
  LEFT JOIN Aplicaciones apN ON apN.Id = h.AplicacionIdNuevo
  LEFT JOIN Servidores svA ON svA.Id = h.ServidorIdAnterior
  LEFT JOIN Servidores svN ON svN.Id = h.ServidorIdNuevo
  LEFT JOIN AceServiciosInventario siN ON siN.Id = h.ServicioInventarioIdNuevo
`;

// ==========================================================================
// TENDENCIA POR PERIODOS HISTÓRICOS (mismo criterio de cubetas adaptativas
// que informeCertificados.js — ver ese archivo para la explicación completa
// de por qué el tamaño de cubeta depende del periodo seleccionado).
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

function esIncidencia(fila) {
  return fila.Accion === 'AJUSTE' && (fila.TrandId || fila.ErrorDescripcion);
}

async function calcularTendencia(pool, bucketDefs) {
  if (!bucketDefs.length) return [];
  const desdeGlobal = bucketDefs[0].desde;
  const hastaGlobal = bucketDefs[bucketDefs.length - 1].hasta;

  // Una sola consulta para TODO el rango de la tendencia (no una por
  // cubeta) y se reparte en JS — mismo criterio que ya usa
  // armarDatosInforme() de Certificados.
  const [filas] = await pool.query(
    `SELECT Accion, TrandId, ErrorDescripcion, FechaCambio
     FROM ApuntamientosHistorico
     WHERE FechaCambio BETWEEN ? AND ?`,
    [`${desdeGlobal} 00:00:00`, `${hastaGlobal} 23:59:59`]
  );

  return bucketDefs.map((bucket) => {
    let altas = 0;
    let ajustes = 0;
    let incidencias = 0;
    for (const fila of filas) {
      if (!fechaDentroDeBucket(fila.FechaCambio, bucket)) continue;
      if (fila.Accion === 'ALTA') altas += 1;
      else ajustes += 1;
      if (esIncidencia(fila)) incidencias += 1;
    }
    return { etiqueta: bucket.etiqueta, desde: bucket.desde, hasta: bucket.hasta, altas, ajustes, incidencias };
  });
}

// ==========================================================================
// COMPARACIÓN CONTRA EL PERIODO ANTERIOR EQUIVALENTE (mismo criterio que
// informeCertificados.js) — solo aplica a la actividad "del periodo"
// (altas/ajustes/incidencias); el snapshot "ahora mismo" (total/sin
// apuntamiento/ACE/Bus) no tiene un periodo anterior real.
// ==========================================================================
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

async function calcularComparacionAnterior(pool, desde, hasta) {
  const anterior = calcularPeriodoAnterior(desde, hasta);

  const [filasAnterior] = await pool.query(
    `SELECT Accion, TrandId, ErrorDescripcion FROM ApuntamientosHistorico WHERE FechaCambio BETWEEN ? AND ?`,
    [`${anterior.desde} 00:00:00`, `${anterior.hasta} 23:59:59`]
  );

  const altasAnterior = filasAnterior.filter((f) => f.Accion === 'ALTA').length;
  const ajustesAnterior = filasAnterior.length - altasAnterior;
  const incidenciasAnterior = filasAnterior.filter(esIncidencia).length;

  return {
    periodoAnterior: anterior,
    altasAnterior,
    ajustesAnterior,
    incidenciasAnterior,
  };
}

async function armarDatosInformeApuntamientos(desde, hasta, periodoSeleccionado = 'rango') {
  const pool = await getPool();

  // 1. Snapshot actual (no depende del periodo).
  const [apuntamientosActuales] = await pool.query('SELECT SinApuntamiento, Categoria FROM Apuntamientos');
  const resumenActual = {
    total: apuntamientosActuales.length,
    sinApuntamiento: apuntamientosActuales.filter((a) => a.SinApuntamiento).length,
    ace: apuntamientosActuales.filter((a) => a.Categoria === 'ACE').length,
    busIntegracion10: apuntamientosActuales.filter((a) => a.Categoria === 'BUS_INTEGRACION_10').length,
  };

  // 2. Actividad del histórico DENTRO del periodo.
  const [actividadPeriodo] = await pool.query(
    `${SELECT_HISTORICO} WHERE h.FechaCambio BETWEEN ? AND ? ORDER BY h.FechaCambio DESC`,
    [`${desde} 00:00:00`, `${hasta} 23:59:59`]
  );

  const incidenciasEnPeriodo = actividadPeriodo.filter(esIncidencia);
  const altasEnPeriodo = actividadPeriodo.filter((a) => a.Accion === 'ALTA').length;
  const ajustesEnPeriodo = actividadPeriodo.length - altasEnPeriodo;

  // 3. Tendencia histórica y comparación contra el periodo anterior — en
  // paralelo porque son consultas independientes.
  const bucketDefs = generarBucketsTendencia(hasta, periodoSeleccionado, desde);
  const [tendencia, comparacionAnterior] = await Promise.all([
    calcularTendencia(pool, bucketDefs),
    calcularComparacionAnterior(pool, desde, hasta),
  ]);

  const comparacion = {
    periodoAnterior: comparacionAnterior.periodoAnterior,
    altas: {
      actual: altasEnPeriodo,
      anterior: comparacionAnterior.altasAnterior,
      cambioPorc: calcularCambioPorcentual(altasEnPeriodo, comparacionAnterior.altasAnterior),
    },
    ajustes: {
      actual: ajustesEnPeriodo,
      anterior: comparacionAnterior.ajustesAnterior,
      cambioPorc: calcularCambioPorcentual(ajustesEnPeriodo, comparacionAnterior.ajustesAnterior),
    },
    incidencias: {
      actual: incidenciasEnPeriodo.length,
      anterior: comparacionAnterior.incidenciasAnterior,
      cambioPorc: calcularCambioPorcentual(incidenciasEnPeriodo.length, comparacionAnterior.incidenciasAnterior),
    },
  };

  return {
    periodo: { desde, hasta },
    resumenActual,
    altasEnPeriodo,
    ajustesEnPeriodo,
    incidenciasEnPeriodo,
    topServiciosPorIncidencias: rankingSimplePorCampo(incidenciasEnPeriodo, 'ServicioNuevoNombre'),
    topAplicacionesPorIncidencias: rankingSimplePorCampo(incidenciasEnPeriodo, 'AplicacionNuevoNombre'),
    tendencia,
    comparacion,
  };
}

module.exports = { calcularRangoPeriodo, resolverRango, armarDatosInformeApuntamientos };
