// Lógica de armado del informe de Servidores/Monitoreo (Fase 2 del informe
// general del aplicativo) — mismo patrón que utils/informeCertificados.js.
//
// A diferencia de Certificados, aquí la única fuente de tendencia REAL en
// base de datos es la tabla monitoreo_historico_portainer (snapshot cada 10
// minutos, ver capturarSnapshotHistorico() en routes/monitoreo.js). Todo lo
// demás de Portainer (detalle de contenedores, imágenes, redes, volúmenes)
// solo existe EN VIVO vía su API — por eso el "resumen actual" de este
// informe se arma consultando Portainer en el momento, igual que hace la
// pantalla de Monitoreo, mientras que la "tendencia del periodo" sale de la
// tabla histórica y puede venir vacía si el backend lleva poco tiempo
// corriendo con esa captura activa (se documenta como limitación conocida,
// igual que ya se hace en informeCertificados.js).

const { getPool } = require('../db');
const { listarTodosLosEntornos, PORTAINER_CONFIGURADO } = require('./portainer');

function formatoFechaSql(fecha) {
  return fecha.toISOString().slice(0, 10);
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

// Misma definición que garantizarTablaHistorico() en routes/monitoreo.js —
// duplicada a propósito (en vez de importarla desde un archivo de rutas)
// para no crear una dependencia routes -> utils -> routes. CREATE TABLE IF
// NOT EXISTS es idempotente, así que no hay riesgo de correrla dos veces.
//
// errno 1142/1143 = el usuario de BD no tiene permiso CREATE/ALTER (mismo
// criterio que esErrorDePermisosDdl() en auditoriaGeneral.js/usuariosAuditoria.js
// y que garantizarTablaHistorico() en routes/monitoreo.js). Si la tabla ya
// existe, esto no es un error real. También se agrega el flag de "ya
// verificada" que faltaba aquí, para no reintentar el CREATE en cada
// llamada al informe.
function esErrorDePermisosDdl(err) {
  return err && (err.errno === 1142 || err.errno === 1143);
}

let tablaHistoricoVerificada = false;
async function garantizarTablaHistorico(pool) {
  if (tablaHistoricoVerificada) return;
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS monitoreo_historico_portainer (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      Fecha DATETIME NOT NULL,
      EntornoId INT NOT NULL,
      EntornoNombre VARCHAR(255) NULL,
      ContenedoresTotal INT NOT NULL DEFAULT 0,
      ContenedoresCorriendo INT NOT NULL DEFAULT 0,
      ContenedoresDetenidos INT NOT NULL DEFAULT 0,
      CpuPromedioPct DECIMAL(6,2) NOT NULL DEFAULT 0,
      MemUsadaGb DECIMAL(10,2) NOT NULL DEFAULT 0,
      INDEX idx_historico_fecha (Fecha),
      INDEX idx_historico_entorno (EntornoId, Fecha)
    )
    `);
  } catch (err) {
    if (!esErrorDePermisosDdl(err)) throw err;
    console.warn('No se pudo verificar/crear la tabla monitoreo_historico_portainer (el usuario de BD no tiene permiso CREATE); se asume que ya existe:', err.sqlMessage || err.message);
  }
  tablaHistoricoVerificada = true;
}

// Snapshot EN VIVO de la flota (mismo criterio que el Análisis Estadístico
// de Monitoreo): cuántos entornos están arriba, contenedores corriendo, y
// CPU/memoria en uso ahora mismo entre todos los contenedores corriendo.
async function resumenActualFlota() {
  if (!PORTAINER_CONFIGURADO) {
    return {
      configurado: false,
      entornosTotal: 0,
      entornosArriba: 0,
      contenedoresTotal: 0,
      contenedoresCorriendo: 0,
      contenedoresDetenidos: 0,
      cpuPromedioActual: 0,
      memUsadaActualGb: 0,
    };
  }

  const entornos = await listarTodosLosEntornos();
  const entornosArriba = entornos.filter((e) => e.estadoConexion === 'up');
  const contenedoresTotal = entornos.reduce((acc, e) => acc + e.resumenContenedores.total, 0);
  const contenedoresCorriendo = entornos.reduce((acc, e) => acc + e.resumenContenedores.corriendo, 0);
  const contenedoresDetenidos = entornos.reduce((acc, e) => acc + e.resumenContenedores.detenidos, 0);

  const corriendoConRecursos = entornos.flatMap((e) => e.contenedores.filter((c) => c.estado === 'running' && c.recursos));
  const cpuPromedioActual = corriendoConRecursos.length
    ? corriendoConRecursos.reduce((acc, c) => acc + (c.recursos.cpuPorcentajeNum || 0), 0) / corriendoConRecursos.length
    : 0;
  const memUsadaActualGb = corriendoConRecursos.reduce((acc, c) => acc + (c.recursos.memUsoBytesNum || 0), 0) / (1024 ** 3);

  return {
    configurado: true,
    entornosTotal: entornos.length,
    entornosArriba: entornosArriba.length,
    contenedoresTotal,
    contenedoresCorriendo,
    contenedoresDetenidos,
    cpuPromedioActual: +cpuPromedioActual.toFixed(2),
    memUsadaActualGb: +memUsadaActualGb.toFixed(2),
  };
}

async function armarDatosInformeServidores(desde, hasta) {
  const pool = await getPool();
  await garantizarTablaHistorico(pool);

  const resumenActual = await resumenActualFlota();

  // Tendencia diaria: primero agrega TODOS los entornos por instante de
  // captura (igual que /portainer/historico), y sobre eso agrupa por día —
  // así un periodo de varias semanas no devuelve un punto cada 10 minutos.
  const [tendenciaDiaria] = await pool.query(
    `SELECT
       DATE(agregadoPorInstante.Fecha) AS fecha,
       AVG(agregadoPorInstante.contenedoresTotal) AS contenedoresTotalProm,
       AVG(agregadoPorInstante.contenedoresCorriendo) AS contenedoresCorriendoProm,
       AVG(agregadoPorInstante.cpuPromedio) AS cpuPromedio,
       AVG(agregadoPorInstante.memUsadaGb) AS memUsadaGb
     FROM (
       SELECT Fecha,
              SUM(ContenedoresTotal) AS contenedoresTotal,
              SUM(ContenedoresCorriendo) AS contenedoresCorriendo,
              AVG(CpuPromedioPct) AS cpuPromedio,
              SUM(MemUsadaGb) AS memUsadaGb
       FROM monitoreo_historico_portainer
       WHERE Fecha BETWEEN ? AND ?
       GROUP BY Fecha
     ) AS agregadoPorInstante
     GROUP BY DATE(agregadoPorInstante.Fecha)
     ORDER BY fecha ASC`,
    [`${desde} 00:00:00`, `${hasta} 23:59:59`]
  );

  const [[picos]] = await pool.query(
    `SELECT
       MAX(agregadoPorInstante.cpuPromedio) AS cpuPico,
       MAX(agregadoPorInstante.memUsadaGb) AS memPico,
       COUNT(*) AS totalCapturas
     FROM (
       SELECT Fecha, AVG(CpuPromedioPct) AS cpuPromedio, SUM(MemUsadaGb) AS memUsadaGb
       FROM monitoreo_historico_portainer
       WHERE Fecha BETWEEN ? AND ?
       GROUP BY Fecha
     ) AS agregadoPorInstante`,
    [`${desde} 00:00:00`, `${hasta} 23:59:59`]
  );

  const [porEntorno] = await pool.query(
    `SELECT EntornoId, EntornoNombre,
            AVG(CpuPromedioPct) AS cpuPromedio,
            AVG(MemUsadaGb) AS memUsadaGbProm,
            COUNT(*) AS capturas
     FROM monitoreo_historico_portainer
     WHERE Fecha BETWEEN ? AND ?
     GROUP BY EntornoId, EntornoNombre`,
    [`${desde} 00:00:00`, `${hasta} 23:59:59`]
  );

  const normalizarEntorno = (fila) => ({
    entornoId: fila.EntornoId,
    entorno: fila.EntornoNombre || `Entorno ${fila.EntornoId}`,
    cpuPromedio: +Number(fila.cpuPromedio || 0).toFixed(2),
    memUsadaGbProm: +Number(fila.memUsadaGbProm || 0).toFixed(2),
    capturas: fila.capturas,
  });

  const entornosNormalizados = porEntorno.map(normalizarEntorno);

  return {
    periodo: { desde, hasta },
    portainerConfigurado: resumenActual.configurado,
    resumenActual,
    tendenciaDiaria: tendenciaDiaria.map((fila) => ({
      fecha: fila.fecha,
      contenedoresTotalProm: +Number(fila.contenedoresTotalProm || 0).toFixed(1),
      contenedoresCorriendoProm: +Number(fila.contenedoresCorriendoProm || 0).toFixed(1),
      cpuPromedio: +Number(fila.cpuPromedio || 0).toFixed(2),
      memUsadaGb: +Number(fila.memUsadaGb || 0).toFixed(2),
    })),
    picosPeriodo: {
      cpuPico: +Number(picos?.cpuPico || 0).toFixed(2),
      memPico: +Number(picos?.memPico || 0).toFixed(2),
      totalCapturas: picos?.totalCapturas || 0,
    },
    topEntornosPorCpu: [...entornosNormalizados].sort((a, b) => b.cpuPromedio - a.cpuPromedio).slice(0, 8),
    topEntornosPorMemoria: [...entornosNormalizados].sort((a, b) => b.memUsadaGbProm - a.memUsadaGbProm).slice(0, 8),
  };
}

module.exports = { calcularRangoPeriodo, resolverRango, armarDatosInformeServidores };
