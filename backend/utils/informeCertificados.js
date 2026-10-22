// Lógica compartida para armar los datos del informe de Certificados —
// usada tanto por las rutas on-demand (GET /api/reportes/certificados[/pdf])
// como por el envío automático programado por correo (ver
// backend/utils/correoReportes.js y el scheduler al final de
// backend/routes/reportes.js). Antes vivía solo dentro de reportes.js; se
// separó para que el scheduler no tenga que importar un router de Express
// solo para reutilizar esta función.
//
// AMPLIACIÓN (estadística/tendencia/comparación): se agregó tendencia por
// periodos históricos, comparación contra el periodo anterior equivalente,
// y algunos KPI derivados (tasa de renovación, promedio de días para
// vencer). Todo esto es SOLO para la vista en pantalla por ahora — el PDF y
// el correo automático siguen usando la forma anterior de armarDatosInforme
// (se le agregó un tercer parámetro opcional "periodoSeleccionado" con
// valor por defecto, así que esas dos rutas no se rompen sin tocarlas).

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

// Traduce "dia"/"semana"/"mes" a un rango [desde, hasta] terminando hoy.
// Sólo se usa cuando no se mandan desde/hasta explícitos (para un rango
// personalizado, quien llama ya calculó y manda las fechas directo).
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

// Agrupa por un campo de VW_CertificadosVigencia (Responsable/Aplicacion/
// Hostname) contando sólo lo "crítico" (Por vencer/Vencido). Se hace en JS
// y no con GROUP BY en SQL a propósito: son columnas que pueden venir
// null/vacías según cómo se haya cargado cada certificado, y así el conteo
// no se rompe si alguna no existe o cambia de nombre más adelante.
function rankingPorCampo(filas, campo, limite = 8) {
  const mapa = new Map();
  for (const fila of filas) {
    if (fila.Estado === 'Vigente') continue;
    const clave = (fila[campo] && String(fila[campo]).trim()) || 'Sin asignar';
    mapa.set(clave, (mapa.get(clave) || 0) + 1);
  }
  return [...mapa.entries()]
    .map(([nombre, total]) => ({ nombre, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limite);
}

// ==========================================================================
// TENDENCIA POR PERIODOS HISTÓRICOS
// ==========================================================================
// Construye N "cubetas" (buckets) de tiempo terminando en `hasta`, con un
// tamaño de cubeta que depende de qué periodo esté viendo el usuario en
// pantalla -- la idea es que la tendencia SIEMPRE mire hacia atrás lo
// suficiente para que se note un patrón, sin importar que el periodo
// seleccionado en el selector de arriba sea corto (ej. "Día").
//   - periodo 'dia'    -> últimos 14 días,  cubetas diarias
//   - periodo 'semana' -> últimas 8 semanas, cubetas semanales
//   - periodo 'mes'    -> últimos 6 meses,  cubetas mensuales
//   - periodo 'rango' (personalizado) -> se ajusta el tamaño de cubeta al
//     tamaño del rango elegido, para no devolver ni 1 ni 200 puntos.
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

  const formatoCorto = (fecha) =>
    fecha.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit' });
  const formatoMes = (fecha) =>
    fecha.toLocaleDateString('es-CO', { month: 'short', year: '2-digit' }).replace('.', '');

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

// Fecha "YYYY-MM-DD" (o Date) cae dentro de [bucket.desde, bucket.hasta]
// (inclusive, comparando solo la parte de fecha).
function fechaDentroDeBucket(fecha, bucket) {
  const soloFecha = (typeof fecha === 'string' ? fecha : fecha.toISOString()).slice(0, 10);
  return soloFecha >= bucket.desde && soloFecha <= bucket.hasta;
}

async function calcularTendencia(pool, bucketDefs) {
  if (!bucketDefs.length) return [];
  const desdeGlobal = bucketDefs[0].desde;
  const hastaGlobal = bucketDefs[bucketDefs.length - 1].hasta;

  // Dos consultas para TODO el rango de la tendencia (en vez de una por
  // cubeta) y se reparte en JS -- mismo criterio que ya usa
  // armarDatosInforme() para actividadEnPeriodo/vencidosEnPeriodo.
  const [actividad] = await pool.query(
    `SELECT Accion, FechaCambio FROM HistoricoCertificados WHERE FechaCambio BETWEEN ? AND ?`,
    [`${desdeGlobal} 00:00:00`, `${hastaGlobal} 23:59:59`]
  );
  const [vencimientos] = await pool.query(
    `SELECT FechaFin FROM VW_CertificadosVigencia WHERE FechaFin BETWEEN ? AND ?`,
    [desdeGlobal, hastaGlobal]
  );

  return bucketDefs.map((bucket) => {
    let altas = 0;
    let renovaciones = 0;
    for (const fila of actividad) {
      if (!fechaDentroDeBucket(fila.FechaCambio, bucket)) continue;
      if (fila.Accion === 'ALTA') altas += 1;
      else renovaciones += 1;
    }
    let vencidos = 0;
    for (const fila of vencimientos) {
      if (fechaDentroDeBucket(fila.FechaFin, bucket)) vencidos += 1;
    }
    return { etiqueta: bucket.etiqueta, desde: bucket.desde, hasta: bucket.hasta, altas, renovaciones, vencidos };
  });
}

// ==========================================================================
// COMPARACIÓN CONTRA EL PERIODO ANTERIOR EQUIVALENTE
// ==========================================================================
// Solo aplica a métricas que son "del periodo" (altas, renovaciones,
// vencimientos, actividad total) -- el snapshot "ahora mismo" (Vigente/Por
// vencer/Vencido) no tiene un "periodo anterior" real porque no guardamos
// snapshots históricos de ese conteo, así que NO se compara.
function calcularPeriodoAnterior(desde, hasta) {
  const desdeDate = new Date(`${desde}T00:00:00`);
  const hastaDate = new Date(`${hasta}T00:00:00`);
  const diasSpan = Math.round((hastaDate - desdeDate) / 86400000) + 1; // inclusive
  const nuevoHasta = sumarDias(desdeDate, -1);
  const nuevoDesde = sumarDias(nuevoHasta, -(diasSpan - 1));
  return { desde: formatoFechaSql(nuevoDesde), hasta: formatoFechaSql(nuevoHasta) };
}

// null = "sin base de comparación" (el periodo anterior tuvo 0 y el actual
// también, o no hay con qué comparar) -- el frontend lo muestra como "—"
// en vez de un porcentaje inventado tipo "+Infinity%".
function calcularCambioPorcentual(actual, anterior) {
  if (anterior === 0) return actual === 0 ? 0 : null;
  return Math.round(((actual - anterior) / anterior) * 100);
}

async function calcularComparacionAnterior(pool, desde, hasta) {
  const anterior = calcularPeriodoAnterior(desde, hasta);

  const [actividadAnterior] = await pool.query(
    `SELECT Accion FROM HistoricoCertificados WHERE FechaCambio BETWEEN ? AND ?`,
    [`${anterior.desde} 00:00:00`, `${anterior.hasta} 23:59:59`]
  );
  const [[{ totalVencidosAnterior }]] = await pool.query(
    `SELECT COUNT(*) AS totalVencidosAnterior FROM VW_CertificadosVigencia WHERE FechaFin BETWEEN ? AND ?`,
    [anterior.desde, anterior.hasta]
  );

  const altasAnterior = actividadAnterior.filter((a) => a.Accion === 'ALTA').length;
  const renovacionesAnterior = actividadAnterior.length - altasAnterior;

  return {
    periodoAnterior: anterior,
    altasAnterior,
    renovacionesAnterior,
    vencidosAnterior: totalVencidosAnterior,
    actividadTotalAnterior: actividadAnterior.length,
  };
}

async function armarDatosInforme(desde, hasta, periodoSeleccionado = 'rango') {
  const pool = await getPool();

  // 1. Snapshot actual (no depende del periodo): cuántos hay vigentes / por
  // vencer / vencidos AHORA MISMO — mismo criterio que ya usa el dashboard.
  const [vigenciaRows] = await pool.query('SELECT * FROM VW_CertificadosVigencia');
  const resumen = { Vigente: 0, 'Por vencer': 0, Vencido: 0 };
  vigenciaRows.forEach((fila) => {
    if (resumen[fila.Estado] !== undefined) resumen[fila.Estado] += 1;
  });

  // 2. Certificados cuya fecha de vencimiento cae DENTRO del periodo. OJO:
  // la vista sólo trae certificados activos (Activo=1 en Certificados/
  // Aplicaciones/Servidores) — un certificado que venció y luego alguien
  // desactivó no va a aparecer aquí. Se documenta como limitación conocida
  // en vez de armar un JOIN manual contra columnas que no están confirmadas
  // en el esquema en vivo.
  const [vencidosPeriodo] = await pool.query(
    'SELECT * FROM VW_CertificadosVigencia WHERE FechaFin BETWEEN ? AND ? ORDER BY FechaFin ASC',
    [desde, hasta]
  );

  // 3. Actividad registrada en el histórico (altas + renovaciones) DENTRO
  // del periodo — esto sí incluye certificados hoy inactivos, porque
  // HistoricoCertificados no filtra por Activo.
  const [actividadPeriodo] = await pool.query(
    `SELECT h.Id, h.CertificadoId, h.Accion, h.FechaInicioAnterior, h.FechaFinAnterior,
            h.FechaInicioNueva, h.FechaFinNueva, h.UsuarioSistema, h.FechaCambio,
            c.NombreComun, c.EntidadEmisora
     FROM HistoricoCertificados h
     LEFT JOIN Certificados c ON c.Id = h.CertificadoId
     WHERE h.FechaCambio BETWEEN ? AND ?
     ORDER BY h.FechaCambio DESC`,
    [`${desde} 00:00:00`, `${hasta} 23:59:59`]
  );

  const altasEnPeriodo = actividadPeriodo.filter((a) => a.Accion === 'ALTA').length;
  const renovacionesEnPeriodo = actividadPeriodo.filter((a) => a.Accion !== 'ALTA').length;

  // 4. Tendencia histórica y comparación contra el periodo anterior — en
  // paralelo porque son consultas independientes.
  const bucketDefs = generarBucketsTendencia(hasta, periodoSeleccionado, desde);
  const [tendencia, comparacionAnterior] = await Promise.all([
    calcularTendencia(pool, bucketDefs),
    calcularComparacionAnterior(pool, desde, hasta),
  ]);

  // 5. KPI derivados adicionales.
  const totalActivos = resumen.Vigente + resumen['Por vencer'] + resumen.Vencido;
  const totalActividadPeriodo = altasEnPeriodo + renovacionesEnPeriodo;
  const tasaRenovacionPorc =
    totalActividadPeriodo > 0 ? Math.round((renovacionesEnPeriodo / totalActividadPeriodo) * 100) : null;

  const hoy = new Date();
  const porVencerAhora = vigenciaRows.filter((f) => f.Estado === 'Por vencer' && f.FechaFin);
  const promedioDiasParaVencer = porVencerAhora.length
    ? Math.round(
        porVencerAhora.reduce((acc, f) => acc + Math.max(0, (new Date(f.FechaFin) - hoy) / 86400000), 0) /
          porVencerAhora.length
      )
    : null;

  const comparacion = {
    periodoAnterior: comparacionAnterior.periodoAnterior,
    altas: {
      actual: altasEnPeriodo,
      anterior: comparacionAnterior.altasAnterior,
      cambioPorc: calcularCambioPorcentual(altasEnPeriodo, comparacionAnterior.altasAnterior),
    },
    renovaciones: {
      actual: renovacionesEnPeriodo,
      anterior: comparacionAnterior.renovacionesAnterior,
      cambioPorc: calcularCambioPorcentual(renovacionesEnPeriodo, comparacionAnterior.renovacionesAnterior),
    },
    vencidos: {
      actual: vencidosPeriodo.length,
      anterior: comparacionAnterior.vencidosAnterior,
      cambioPorc: calcularCambioPorcentual(vencidosPeriodo.length, comparacionAnterior.vencidosAnterior),
    },
    actividadTotal: {
      actual: totalActividadPeriodo,
      anterior: comparacionAnterior.actividadTotalAnterior,
      cambioPorc: calcularCambioPorcentual(totalActividadPeriodo, comparacionAnterior.actividadTotalAnterior),
    },
  };

  // Detalle para el informe nuevo: lo que está por vencer o vencido HOY (ordenado por
  // fecha) y cuántos certificados vencen en cada uno de los próximos 12 meses.
  const proximosVencimientos = vigenciaRows
    .filter((f) => f.Estado === 'Por vencer' || f.Estado === 'Vencido')
    .sort((a, b) => new Date(a.FechaFin) - new Date(b.FechaFin))
    .slice(0, 300)
    .map((f) => ({
      Id: f.Id, Estado: f.Estado, Hostname: f.Hostname, Aplicacion: f.Aplicacion, NombreComun: f.NombreComun,
      EntidadEmisora: f.EntidadEmisora, FechaFin: f.FechaFin, DiasRestantes: f.DiasRestantes, Responsable: f.Responsable,
    }));
  const calendarioVencimientos = [];
  for (let i = 0; i < 12; i++) {
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    const finMes = new Date(hoy.getFullYear(), hoy.getMonth() + i + 1, 1);
    calendarioVencimientos.push({
      etiqueta: inicioMes.toLocaleDateString('es-CO', { month: 'short', year: '2-digit' }).replace('.', ''),
      total: vigenciaRows.filter((f) => f.FechaFin && new Date(f.FechaFin) >= (i === 0 ? hoy : inicioMes) && new Date(f.FechaFin) < finMes).length,
    });
  }

  return {
    periodo: { desde, hasta },
    resumen,
    vencidosEnPeriodo: vencidosPeriodo,
    actividadEnPeriodo: actividadPeriodo,
    altasEnPeriodo,
    renovacionesEnPeriodo,
    topResponsablesCriticos: rankingPorCampo(vigenciaRows, 'Responsable'),
    topAplicacionesCriticas: rankingPorCampo(vigenciaRows, 'Aplicacion'),
    topServidoresCriticos: rankingPorCampo(vigenciaRows, 'Hostname'),
    tendencia,
    comparacion,
    totalActivos,
    tasaRenovacionPorc,
    promedioDiasParaVencer,
    proximosVencimientos,
    calendarioVencimientos,
  };
}

module.exports = { calcularRangoPeriodo, resolverRango, armarDatosInforme };
