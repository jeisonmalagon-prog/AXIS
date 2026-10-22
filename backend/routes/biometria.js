const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { ejecutarConsulta, ultimoResultado } = require('../utils/biometriaServicio');
const remota = require('../utils/biometriaRemota');
const cliente = require('../utils/biometriaCliente');
const { mensajeErrorSql } = require('../utils/sqlServer');

// ==========================================================================
// Módulo BIOMETRIA. Pantalla principal: consulta POR CLIENTE (ver más abajo). El flujo por fechas sigue disponible (todo de SOLO LECTURA):
//   1) MotorFirma · PendienteFirma.Solicitudes con IdEstadoBiometria = 60 e IdEstadoFirma = 30,
//      filtradas SOLO por FechaModificacion (rango de fechas que elige la persona);
//   2) MotorFirma · Firma.Detalle: por los RadNumber de esas solicitudes se toman los IdCasoBiometria;
//   3) ORQBIOMETRIA: esos casos con resultado «CEDULA ORIGINAL OK» (cédula, nombre, caso, canal);
//   4) por cada cédula se consulta la biometría en el servidor de biometría (curl por SSH) y la
//      pantalla muestra la respuesta traducida (ver utils/biometriaRemota.js).
//
//  - Las credenciales (MotorFirma, ORQBIOMETRIA y el servidor de biometría) están PREDEFINIDAS en el código
//    (utils/biometriaClave.js, fuera de git): la pantalla no pide usuarios ni claves y nunca se envían al navegador.
//  - El resultado de cada consulta es personal (memoria de su sesión). Todo el módulo es de LECTURA: consultar solo requiere tener el módulo
//    habilitado, también con rol Consulta (por eso aquí no se exige permiso de edición).
// ==========================================================================

router.use(verifyToken, requireModule('BIOMETRIA'));

// La auditoría usa la base de AXIS; si no está disponible se omite sin romper la operación.
async function auditar(req, datos) {
  try {
    await registrarEventoGeneral(await getPool(), req, datos);
  } catch (error) {
    console.error('[biometria] No se pudo registrar la auditoría:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Consulta (Solicitudes -> Detalle -> ORQBIOMETRIA). Solo lo de ESTA persona.
// ---------------------------------------------------------------------------
router.get('/resultado', (req, res) => {
  res.json(ultimoResultado(req.user.username));
});

router.post('/consultar', async (req, res) => {
  try {
    const r = await ejecutarConsulta(req.user.username, { desde: req.body?.desde, hasta: req.body?.hasta });
    if (r.enEjecucion) return res.status(409).json({ error: 'Ya hay una consulta en ejecución. Espera unos segundos y vuelve a intentar.' });
    if (r.error) return res.status(r.configuracion ? 400 : 502).json({ error: r.error });
    const p = r.resultado.pasos;
    await auditar(req, {
      modulo: 'BIOMETRIA', entidad: 'Consulta de biometría', entidadId: 1, entidadNombre: 'Firmas en reintento', accion: 'EJECUCION',
      detalle: `Fecha de modificación ${r.resultado.filtro.desde} a ${r.resultado.filtro.hasta}: ${p.solicitudes} solicitudes, ${p.casosEnDetalle} casos en Detalle, ${p.casosConResultadoOk} con «${r.resultado.resultadoOk}»`,
    });
    res.json({ resultado: r.resultado });
  } catch (error) {
    console.error('Error al consultar la biometría:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ---------------------------------------------------------------------------
// Biometría de los clientes (curl por SSH en el servidor de biometría)
// ---------------------------------------------------------------------------
// Consulta la biometría de hasta 12 documentos con una sola conexión SSH.
router.post('/consultar-lote', async (req, res) => {
  const usuarioApp = req.user.username;
  try {
    const r = await remota.consultarClientes(usuarioApp, { tipoDocumento: req.body?.tipoDocumento, documentos: req.body?.documentos });
    const n = r.resultados.length;
    const conRespuesta = r.resultados.filter((x) => x.httpCodigo !== null).length;
    // No se registran cédulas ni respuestas: solo el conteo.
    await auditar(req, {
      modulo: 'BIOMETRIA', entidad: 'Consulta de biometría de clientes', entidadId: 1, entidadNombre: `Lote de ${n} documento(s)`, accion: 'EJECUCION',
      detalle: `Consulta de biometría en ${r.servidor}: ${r.fallaConexion ? `sin conexión (${r.error})` : `${conRespuesta} de ${n} con respuesta`} en ${(r.duracionMs / 1000).toFixed(1)} s`,
    });
    res.json(r);
  } catch (error) {
    if (error.codigo === 'VALIDACION') return res.status(400).json({ error: error.message });
    if (error.codigo === 'SIN_CONFIG_SSH') return res.status(400).json({ error: error.message });
    if (error.codigo === 'EN_CURSO') return res.status(409).json({ error: error.message });
    if (error.codigo === 'CONFIG') return res.status(400).json({ error: error.message });
    console.error('Error al consultar la biometría de los clientes:', error.message);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ---------------------------------------------------------------------------
// Consulta POR CLIENTE (pantalla principal): búsqueda por cédula / nombre / caso / RadNumber,
// detalle del cliente (ORQBIOMETRIA + MotorFirma) y consulta puntual al servidor de biometría.
// En la auditoría solo queda el tipo de búsqueda y el conteo: nunca la cédula ni el nombre.
// ---------------------------------------------------------------------------
const ETIQUETA_CRITERIO = { cc: 'cédula', nombre: 'nombre', caso: 'número de caso', radicado: 'RadNumber' };

function responderErrorCliente(res, error, contexto) {
  if (error?.codigo === 'VALIDACION') return res.status(400).json({ error: error.message });
  if (['CONFIG', 'SIN_CONFIG', 'SIN_DRIVER'].includes(error?.codigo)) return res.status(400).json({ error: mensajeErrorSql(error, error?.perfil) });
  console.error(`[biometria] Error en ${contexto}:`, error?.message);
  return res.status(502).json({ error: mensajeErrorSql(error, error?.perfil) });
}

// Datos no secretos del servicio de biometría (para armar el curl en la pantalla).
router.get('/servicio', (req, res) => {
  try {
    res.json(remota.describirServicio(req.user.username));
  } catch (error) {
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.post('/clientes/buscar', async (req, res) => {
  try {
    const r = await cliente.buscarClientes({ criterio: req.body?.criterio, valor: req.body?.valor });
    await auditar(req, {
      modulo: 'BIOMETRIA', entidad: 'Búsqueda de cliente', entidadId: 1, entidadNombre: `Por ${ETIQUETA_CRITERIO[r.criterio] || r.criterio}`, accion: 'EJECUCION',
      detalle: `Búsqueda por ${ETIQUETA_CRITERIO[r.criterio] || r.criterio}: ${r.clientes.length} cliente(s) encontrados`,
    });
    res.json(r);
  } catch (error) {
    responderErrorCliente(res, error, 'la búsqueda de clientes');
  }
});

router.post('/clientes/detalle', async (req, res) => {
  try {
    const r = await cliente.detalleCliente({ cc: req.body?.cc });
    await auditar(req, {
      modulo: 'BIOMETRIA', entidad: 'Consulta de cliente', entidadId: 1, entidadNombre: 'Detalle por cédula', accion: 'EJECUCION',
      detalle: `Detalle de un cliente: ${r.encontrado ? `${r.casos.length} caso(s), ${r.firmas.filas.length} solicitud(es) de firma` : 'no encontrado en ORQBIOMETRIA'} en ${(r.duracionMs / 1000).toFixed(1)} s`,
    });
    res.json(r);
  } catch (error) {
    responderErrorCliente(res, error, 'el detalle del cliente');
  }
});

// Biometrías en general: casos de ORQBIOMETRIA en un rango de fechas (con filtros por estado y resultado).
router.post('/clientes/listado', async (req, res) => {
  try {
    const r = await cliente.listarBiometrias({ desde: req.body?.desde, hasta: req.body?.hasta, estado: req.body?.estado, resultado: req.body?.resultado });
    await auditar(req, {
      modulo: 'BIOMETRIA', entidad: 'Biometrías por fecha', entidadId: 1, entidadNombre: 'Listado general', accion: 'EJECUCION',
      detalle: `Casos del ${r.filtro.desde} al ${r.filtro.hasta}${r.filtro.estado ? ` · estado «${r.filtro.estado}»` : ''}${r.filtro.resultado ? ` · resultado «${r.filtro.resultado}»` : ''}: ${r.filas.length} listados de ${r.totalRango} en el rango`,
    });
    res.json(r);
  } catch (error) {
    responderErrorCliente(res, error, 'el listado de biometrías');
  }
});

// Consulta UNA cédula en el servidor de biometría (curl por SSH). Devuelve además el curl «manual» equivalente.
router.post('/servidor/consultar', async (req, res) => {
  try {
    const tipoDocumento = req.body?.tipoDocumento ?? 1;
    const documento = String(req.body?.documento ?? '').trim();
    const v = remota.validarCliente({ tipoDocumento, numeroDocumento: documento });
    if (v.error) return res.status(400).json({ error: v.error });
    const r = await remota.consultarClientes(req.user.username, { tipoDocumento: v.tipo, documentos: [v.numero] });
    const x = r.resultados[0] || null;
    await auditar(req, {
      modulo: 'BIOMETRIA', entidad: 'Consulta de biometría de clientes', entidadId: 1, entidadNombre: 'Un documento', accion: 'EJECUCION',
      detalle: `Consulta de biometría en ${r.servidor}: ${r.fallaConexion ? `sin conexión (${r.error})` : (x && x.httpCodigo !== null ? `respondió ${x.httpCodigo}` : 'sin respuesta')} en ${(r.duracionMs / 1000).toFixed(1)} s`,
    });
    res.json({ servidor: r.servidor, duracionMs: r.duracionMs, fallaConexion: r.fallaConexion, error: r.error, curl: remota.curlManual(req.user.username, v.tipo, v.numero), resultado: x });
  } catch (error) {
    if (['VALIDACION', 'SIN_CONFIG_SSH', 'CONFIG'].includes(error.codigo)) return res.status(400).json({ error: error.message });
    if (error.codigo === 'EN_CURSO') return res.status(409).json({ error: error.message });
    console.error('Error al consultar el servidor de biometría:', error.message);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

module.exports = router;
