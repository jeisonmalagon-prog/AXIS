const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { generarPdfCertificados } = require('../utils/reportesPdf');
const { calcularRangoPeriodo, resolverRango, armarDatosInforme } = require('../utils/informeCertificados');
const { enviarInformeCertificadosPorCorreo, correoAutomaticoConfigurado } = require('../utils/correoReportes');
const { generarPdfServidores } = require('../utils/reportesPdfServidores');
const { resolverRango: resolverRangoServidores, armarDatosInformeServidores } = require('../utils/informeServidores');
const { generarPdfApuntamientos } = require('../utils/reportesPdfApuntamientos');
const { resolverRango: resolverRangoApuntamientos, armarDatosInformeApuntamientos } = require('../utils/informeApuntamientos');
const { generarPdfAplicaciones } = require('../utils/reportesPdfAplicaciones');
const { resolverRango: resolverRangoAplicaciones, armarDatosInformeAplicaciones } = require('../utils/informeAplicaciones');
const { generarPdfF5 } = require('../utils/reportesPdfF5');
const { resolverRango: resolverRangoF5, armarDatosInformeF5 } = require('../utils/informeF5');
const { generarPdfGeneral } = require('../utils/reportesPdfGeneral');
const {
  seccionesPermitidas,
  parseClavesSolicitadas,
  resolverRango: resolverRangoGeneral,
  armarDatosInformeGeneral,
} = require('../utils/informeGeneral');

// ==========================================
// INFORME DE CERTIFICADOS — Fase 1 del informe general del aplicativo
// (diario/semanal/mensual). Junta en una sola respuesta lo que ya existía
// repartido en /api/dashboard y /api/certificados (VW_CertificadosVigencia)
// más HistoricoCertificados, pensado para un PERIODO en vez del snapshot
// "ahora mismo". La lógica de armado del informe vive en
// utils/informeCertificados.js para poder reutilizarla también desde el
// envío automático programado (ver el scheduler al final de este archivo).
//
// NOTA sobre alcance: por ahora este informe cubre solo Certificados —
// "todo el aplicativo" se va a ir sumando módulo por módulo en fases
// siguientes (servidores/Portainer ya tiene su propio Análisis Estadístico
// dentro de Monitoreo; certificados es el primer módulo con informe
// exportable en PDF).
// ==========================================

// Los informes (nuevos y anteriores) requieren el módulo INFORMES, además del módulo de cada tema.
router.use(verifyToken, requireModule('INFORMES'));

// GET /api/reportes/certificados?periodo=dia|semana|mes  ó  ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/certificados', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req);
    // periodoSeleccionado sólo se usa para decidir el tamaño de cubeta de la
    // tendencia histórica (ver generarBucketsTendencia en informeCertificados.js).
    // Si el usuario mandó un rango personalizado (desde/hasta) se usa 'rango'
    // (cubetas adaptativas); si no, se respeta el atajo ?periodo=dia|semana|mes
    // que ya usa resolverRango internamente para calcular las fechas.
    const periodoSeleccionado = (req.query.desde && req.query.hasta)
      ? 'rango'
      : (req.query.periodo || 'semana');
    const datos = await armarDatosInforme(desde, hasta, periodoSeleccionado);
    res.json(datos);
  } catch (err) {
    console.error('Error en GET /api/reportes/certificados:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/reportes/certificados/pdf?... — mismo dato, como PDF descargable.
router.get('/certificados/pdf', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRango(req);
    const datos = await armarDatosInforme(desde, hasta);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="informe-certificados_${desde}_a_${hasta}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    generarPdfCertificados(doc, datos);
    doc.end();
  } catch (err) {
    console.error('Error en GET /api/reportes/certificados/pdf:', err);
    // Si ya se mandaron bytes del PDF no se puede cambiar a un JSON de error.
    if (!res.headersSent) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    } else {
      res.end();
    }
  }
});

// ==========================================
// INFORME DE SERVIDORES / MONITOREO — Fase 2 del informe general del
// aplicativo. Snapshot en vivo de la flota de Portainer (mismo criterio que
// el Análisis Estadístico de Monitoreo) + tendencia real del periodo desde
// monitoreo_historico_portainer. Ver utils/informeServidores.js para el
// detalle y las limitaciones conocidas (el histórico solo existe desde que
// el snapshot automático empezó a correr).
// ==========================================

// GET /api/reportes/servidores?periodo=dia|semana|mes ó ?desde=...&hasta=...
router.get('/servidores', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRangoServidores(req);
    const datos = await armarDatosInformeServidores(desde, hasta);
    res.json(datos);
  } catch (err) {
    console.error('Error en GET /api/reportes/servidores:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/reportes/servidores/pdf?...
router.get('/servidores/pdf', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRangoServidores(req);
    const datos = await armarDatosInformeServidores(desde, hasta);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="informe-servidores_${desde}_a_${hasta}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    generarPdfServidores(doc, datos);
    doc.end();
  } catch (err) {
    console.error('Error en GET /api/reportes/servidores/pdf:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    } else {
      res.end();
    }
  }
});

// ==========================================
// INFORME DE BITÁCORA DE APUNTAMIENTOS — Fase 2 del informe general del
// aplicativo. Ver utils/informeApuntamientos.js para el detalle (criterio
// de "incidencia" y limitaciones conocidas).
// ==========================================

// GET /api/reportes/apuntamientos?periodo=dia|semana|mes ó ?desde=...&hasta=...
router.get('/apuntamientos', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRangoApuntamientos(req);
    const periodoSeleccionado = (req.query.desde && req.query.hasta)
      ? 'rango'
      : (req.query.periodo || 'semana');
    const datos = await armarDatosInformeApuntamientos(desde, hasta, periodoSeleccionado);
    res.json(datos);
  } catch (err) {
    console.error('Error en GET /api/reportes/apuntamientos:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/reportes/apuntamientos/pdf?...
router.get('/apuntamientos/pdf', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRangoApuntamientos(req);
    const datos = await armarDatosInformeApuntamientos(desde, hasta);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="informe-apuntamientos_${desde}_a_${hasta}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    generarPdfApuntamientos(doc, datos);
    doc.end();
  } catch (err) {
    console.error('Error en GET /api/reportes/apuntamientos/pdf:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    } else {
      res.end();
    }
  }
});

// ==========================================
// INFORME DE APLICACIONES E INVENTARIO — Fase 2 del informe general del
// aplicativo. Ver utils/informeAplicaciones.js para el detalle (por qué es
// sobre todo un snapshot, y qué es lo único filtrado por periodo).
// ==========================================

// GET /api/reportes/aplicaciones?periodo=dia|semana|mes ó ?desde=...&hasta=...
router.get('/aplicaciones', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRangoAplicaciones(req);
    const periodoSeleccionado = (req.query.desde && req.query.hasta)
      ? 'rango'
      : (req.query.periodo || 'semana');
    const datos = await armarDatosInformeAplicaciones(desde, hasta, periodoSeleccionado);
    res.json(datos);
  } catch (err) {
    console.error('Error en GET /api/reportes/aplicaciones:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/reportes/aplicaciones/pdf?...
router.get('/aplicaciones/pdf', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRangoAplicaciones(req);
    const datos = await armarDatosInformeAplicaciones(desde, hasta);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="informe-aplicaciones_${desde}_a_${hasta}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    generarPdfAplicaciones(doc, datos);
    doc.end();
  } catch (err) {
    console.error('Error en GET /api/reportes/aplicaciones/pdf:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    } else {
      res.end();
    }
  }
});

// ==========================================
// INFORME DE BALANCEADOR F5 — Fase 2 del informe general del aplicativo.
// Ver utils/informeF5.js para el detalle (por qué el histórico empieza
// vacío y se va llenando desde que este código se despliega).
// ==========================================

// GET /api/reportes/f5?periodo=dia|semana|mes ó ?desde=...&hasta=...
router.get('/f5', verifyToken, requireModule('BALANCEADOR_F5'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRangoF5(req);
    const datos = await armarDatosInformeF5(desde, hasta);
    res.json(datos);
  } catch (err) {
    console.error('Error en GET /api/reportes/f5:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/reportes/f5/pdf?...
router.get('/f5/pdf', verifyToken, requireModule('BALANCEADOR_F5'), async (req, res) => {
  try {
    const { desde, hasta } = resolverRangoF5(req);
    const datos = await armarDatosInformeF5(desde, hasta);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="informe-f5_${desde}_a_${hasta}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    generarPdfF5(doc, datos);
    doc.end();
  } catch (err) {
    console.error('Error en GET /api/reportes/f5/pdf:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    } else {
      res.end();
    }
  }
});

// ==========================================
// INFORME GENERAL DEL APLICATIVO — combina, en un solo informe (pantalla y
// PDF), las secciones que el usuario elija entre los módulos que ya tienen
// su propio informe individual. Ver utils/informeGeneral.js para el
// catálogo de secciones y cómo se arma cada una (en paralelo, sin que una
// sección caída tumbe a las demás).
//
// No se protege con un único requireModule() porque puede pedir varios
// módulos a la vez: cada sección se filtra dentro del handler contra
// req.user.modulos (mismo criterio que requireModule usa por separado para
// cada informe individual).
// ==========================================

// GET /api/reportes/general/secciones — catálogo de secciones disponibles
// PARA ESTE USUARIO (ya filtrado por los módulos que tiene habilitados), así
// el frontend arma los checkboxes sin duplicar esa lista de módulos.
router.get('/general/secciones', verifyToken, (req, res) => {
  const secciones = seccionesPermitidas(req.user.modulos).map((s) => ({ clave: s.clave, etiqueta: s.etiqueta }));
  res.json({ secciones });
});

// GET /api/reportes/general?periodo=dia|semana|mes&secciones=certificados,servidores,...
//   ó ?desde=...&hasta=...&secciones=...
router.get('/general', verifyToken, async (req, res) => {
  try {
    const claves = parseClavesSolicitadas(req);
    if (!claves.length) {
      return res.status(400).json({ error: 'Selecciona al menos una sección para el informe general.' });
    }
    const { desde, hasta } = resolverRangoGeneral(req);
    const datos = await armarDatosInformeGeneral(desde, hasta, claves, req.user.modulos);
    res.json(datos);
  } catch (err) {
    console.error('Error en GET /api/reportes/general:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/reportes/general/pdf?...
router.get('/general/pdf', verifyToken, async (req, res) => {
  try {
    const claves = parseClavesSolicitadas(req);
    if (!claves.length) {
      return res.status(400).json({ error: 'Selecciona al menos una sección para el informe general.' });
    }
    const { desde, hasta } = resolverRangoGeneral(req);
    const datos = await armarDatosInformeGeneral(desde, hasta, claves, req.user.modulos);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="informe-general_${desde}_a_${hasta}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    generarPdfGeneral(doc, datos);
    doc.end();
  } catch (err) {
    console.error('Error en GET /api/reportes/general/pdf:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    } else {
      res.end();
    }
  }
});

// ==========================================
// ENVÍO AUTOMÁTICO PROGRAMADO POR CORREO — Fase 3 de este informe.
// Mismo patrón de "revisar cada N minutos con setInterval" que ya usa el
// snapshot histórico de Monitoreo (ver capturarSnapshotHistorico en
// routes/monitoreo.js): no depende de un cron externo ni de que el proceso
// nunca se caiga, solo de que el backend esté corriendo en el momento del
// disparo configurado.
//
// Variables de entorno (agregar al .env del backend; ver
// documentacion/conexion_powerbi_certificados.md para el resto del informe
// y backend/utils/correoReportes.js para el detalle de cada una):
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS  (credenciales del correo corporativo)
//   REPORTE_EMAIL_FROM              (remitente que ve el destinatario; si se omite, se usa SMTP_USER)
//   REPORTE_EMAIL_DESTINATARIOS     (lista de correos separados por coma)
//   REPORTE_EMAIL_FRECUENCIA        (diario | semanal | mensual — por defecto "diario")
//   REPORTE_EMAIL_HORA              (HH:mm en la hora local del servidor — por defecto "06:00")
//   REPORTE_EMAIL_DIA_SEMANA        (0=domingo..6=sábado, solo si FRECUENCIA=semanal — por defecto 1=lunes)
//   REPORTE_EMAIL_DIA_MES           (1-28, solo si FRECUENCIA=mensual — por defecto 1)
// Si SMTP_HOST/SMTP_USER/SMTP_PASS o REPORTE_EMAIL_DESTINATARIOS no están
// configurados, el scheduler ni siquiera arranca (mismo criterio que
// PORTAINER_CONFIGURADO en Monitoreo) — no hace falta "apagar" nada a mano
// en un ambiente donde este envío no aplica (ej. QA).
// ==========================================

const INTERVALO_CHEQUEO_CORREO_MS = 5 * 60 * 1000; // revisa cada 5 minutos si toca enviar

// Devuelve el número de semana ISO (1-53) — usado solo para no reenviar dos
// veces el informe semanal si el servidor se reinicia justo el día objetivo.
function numeroSemanaIso(fecha) {
  const copia = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
  const diaIso = copia.getUTCDay() || 7;
  copia.setUTCDate(copia.getUTCDate() + 4 - diaIso);
  const inicioAnio = new Date(Date.UTC(copia.getUTCFullYear(), 0, 1));
  return Math.ceil(((copia - inicioAnio) / 86400000 + 1) / 7);
}

let ultimaClavePeriodoEnviada = null;

// Decide si en ESTE chequeo (cada 5 min) toca disparar el envío. Devuelve
// el "periodo" (dia/semana/mes) a usar con calcularRangoPeriodo si toca
// enviar, o null si no.
function resolverSiTocaEnviar(ahora) {
  const frecuencia = (process.env.REPORTE_EMAIL_FRECUENCIA || 'diario').toLowerCase();
  const [horaObjetivo, minObjetivoStr] = (process.env.REPORTE_EMAIL_HORA || '06:00').split(':');
  const minObjetivo = Number(minObjetivoStr) || 0;

  if (ahora.getHours() !== Number(horaObjetivo)) return null;
  // Ventana de tolerancia: el intervalo revisa cada 5 min, así que basta con
  // que el minuto actual esté dentro de +/-4 del objetivo para no depender
  // de que el setInterval caiga justo en el minuto exacto.
  if (Math.abs(ahora.getMinutes() - minObjetivo) > 4) return null;

  let periodo = 'dia';
  let clavePeriodo = `${ahora.getFullYear()}-${ahora.getMonth()}-${ahora.getDate()}`;

  if (frecuencia === 'semanal') {
    const diaSemanaObjetivo = Number(process.env.REPORTE_EMAIL_DIA_SEMANA ?? 1); // 1 = lunes
    if (ahora.getDay() !== diaSemanaObjetivo) return null;
    periodo = 'semana';
    clavePeriodo = `semana-${ahora.getFullYear()}-${numeroSemanaIso(ahora)}`;
  } else if (frecuencia === 'mensual') {
    const diaMesObjetivo = Number(process.env.REPORTE_EMAIL_DIA_MES ?? 1);
    if (ahora.getDate() !== diaMesObjetivo) return null;
    periodo = 'mes';
    clavePeriodo = `mes-${ahora.getFullYear()}-${ahora.getMonth()}`;
  } else {
    clavePeriodo = `dia-${clavePeriodo}`;
  }

  if (clavePeriodo === ultimaClavePeriodoEnviada) return null; // ya se mandó en este periodo
  return { periodo, clavePeriodo };
}

async function chequearEnvioAutomatico() {
  try {
    const resultado = resolverSiTocaEnviar(new Date());
    if (!resultado) return;

    const { desde, hasta } = calcularRangoPeriodo(resultado.periodo);
    const datos = await armarDatosInforme(desde, hasta);
    const envio = await enviarInformeCertificadosPorCorreo(datos);

    if (envio.enviado) {
      ultimaClavePeriodoEnviada = resultado.clavePeriodo;
      console.log(`Informe de Certificados enviado por correo a: ${envio.destinatarios.join(', ')} (periodo ${desde} a ${hasta}).`);
    }
  } catch (err) {
    // Un fallo puntual (SMTP caído, BD ocupada) no debe tumbar el backend —
    // se reintenta solo en el siguiente chequeo del intervalo.
    console.warn(`No se pudo enviar el informe automático de Certificados por correo: ${err.message}`);
  }
}

if (correoAutomaticoConfigurado()) {
  setInterval(chequearEnvioAutomatico, INTERVALO_CHEQUEO_CORREO_MS);
  console.log('Envío automático del informe de Certificados por correo: activo.');
} else {
  console.log('Envío automático del informe de Certificados por correo: inactivo (faltan variables SMTP_*/REPORTE_EMAIL_* en el .env).');
}

module.exports = router;
