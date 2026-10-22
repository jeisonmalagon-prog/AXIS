const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const cfg = require('../utils/biometriaConsumoConfig');
const consumo = require('../utils/biometriaConsumo');
const detalle = require('../utils/biometriaConsumoDetalle');
const alertas = require('../utils/biometriaConsumoAlertas');

// ==========================================================================
// Biometría · Consumo y reusos (solo lectura sobre ORQBIOMETRIA).
//  · El tablero lo ve quien tenga el módulo BIOMETRIA, también con rol Consulta (solo lectura).
//  · La conexión (servidor, usuario, clave) y los umbrales los edita SOLO el ADMIN_POD; la clave se guarda cifrada y nunca se devuelve.
//  · En la auditoría queda quién consultó/configuró y el rango; nunca cédulas, nombres ni claves.
// ==========================================================================

router.use(verifyToken, requireModule('BIOMETRIA'));

const soloAdmin = (req, res, next) => {
  if (req.user && req.user.rol === 'ADMIN_POD') return next();
  return res.status(403).json({ error: 'Solo el ADMIN_POD puede cambiar la configuración del consumo de biometría.' });
};

async function auditar(req, datos) {
  try {
    await registrarEventoGeneral(await getPool(), req, { modulo: 'BIOMETRIA', ...datos });
  } catch (error) {
    console.error('[biometria-consumo] No se pudo registrar la auditoría:', error.message);
  }
}

function responderError(res, error, contexto) {
  const codigo = error?.codigo;
  if (codigo === 'VALIDACION') return res.status(400).json({ error: error.message });
  if (['SIN_CONFIG', 'SIN_DRIVER', 'CLAVE_ILEGIBLE'].includes(codigo)) return res.status(400).json({ error: cfg.mensajeError(error), sinConfiguracion: codigo === 'SIN_CONFIG' });
  console.error(`[biometria-consumo] Error en ${contexto}:`, error?.message);
  return res.status(502).json({ error: cfg.mensajeError(error) });
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
router.get('/config', async (req, res) => {
  try {
    res.json(await cfg.obtenerPublica({ admin: req.user.rol === 'ADMIN_POD' }));
  } catch (error) {
    console.error('[biometria-consumo] Error leyendo la configuración:', error.message);
    res.status(500).json({ error: 'No se pudo leer la configuración del consumo de biometría.' });
  }
});

router.put('/config', soloAdmin, async (req, res) => {
  try {
    const antes = await cfg.obtenerInterna({ force: true });
    const v = cfg.validar(req.body, !!antes.clave);
    if (v.error) return res.status(400).json({ error: v.error });
    await cfg.guardar(v.valor, req.user.id);

    const cambios = [];
    const cmp = (campo, etiqueta, a, b) => { if (String(a ?? '') !== String(b ?? '')) cambios.push({ campo, etiqueta, anterior: String(a ?? '') || '(vacío)', nuevo: String(b ?? '') || '(vacío)' }); };
    cmp('servidor', 'Servidor', antes.servidor, v.valor.servidor); cmp('puerto', 'Puerto', antes.puerto, v.valor.puerto);
    cmp('base', 'Base de datos', antes.base, v.valor.base); cmp('usuario', 'Usuario', antes.usuario, v.valor.usuario);
    cmp('cifrado', 'Cifrado', antes.cifrado, v.valor.cifrado); cmp('confiar', 'Confiar en el certificado', antes.confiarCertificado, v.valor.confiarCertificado);
    cmp('maxPorCliente', 'Máx. consultas por cliente y día', antes.maxPorCliente, v.valor.maxPorCliente); cmp('alerta', 'Alerta por correo', antes.alerta, v.valor.alerta);
    cmp('alertaCadaMin', 'Recordar la alerta cada (min; 0 = no recordar)', antes.alertaCadaMin, v.valor.alertaCadaMin);
    for (const p of cfg.PROVEEDORES) {
      cmp(`cupoDia${p}`, `Cupo diario ${p}`, antes.cupos[p].dia, v.valor.cupos[p].dia);
      cmp(`cupoMes${p}`, `Cupo mensual ${p}`, antes.cupos[p].mes, v.valor.cupos[p].mes);
      cmp(`valor${p}`, `Valor por consulta ${p}`, antes.cupos[p].valor, v.valor.cupos[p].valor);
    }
    if (v.valor.clave !== undefined) cambios.push({ campo: 'clave', etiqueta: 'Clave de SQL Server', anterior: '(oculta)', nuevo: '(actualizada)' });
    await auditar(req, {
      entidad: 'Consumo de biometría (configuración)', entidadId: 'consumo', entidadNombre: `${v.valor.servidor}:${v.valor.puerto}`, accion: 'EDICION',
      detalle: `Actualizó la conexión y los umbrales del tablero de consumo (${v.valor.servidor}:${v.valor.puerto}, base ${v.valor.base}).`, cambios,
    });
    res.json(await cfg.obtenerPublica({ admin: true }));
  } catch (error) {
    if (error instanceof cfg.ErrorConfig) return res.status(error.status).json({ error: error.message });
    console.error('[biometria-consumo] Error guardando la configuración:', error.message);
    res.status(500).json({ error: 'No se pudo guardar la configuración del consumo de biometría.' });
  }
});

// Prueba la conexión: con lo que viene en el formulario (borrador, sin guardar) o, si no viene nada, con lo guardado.
router.post('/config/probar', soloAdmin, async (req, res) => {
  try {
    const hayBorrador = req.body && (req.body.usuario || req.body.servidor);
    if (!hayBorrador) return res.json(await cfg.probarGuardada());
    const antes = await cfg.obtenerInterna();
    const v = cfg.validar(req.body, !!antes.clave);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    res.json(await cfg.probarBorrador(v.valor));
  } catch (error) {
    console.error('[biometria-consumo] Error probando la conexión:', error.message);
    res.status(500).json({ ok: false, error: cfg.mensajeError(error) });
  }
});

// Evalúa HOY y manda el correo de alerta ahora mismo (ignora lo ya avisado y no cambia el estado de los avisos programados), para comprobar que llega.
router.post('/config/probar-alerta', soloAdmin, async (req, res) => {
  const r = await alertas.evaluar({ forzar: true });
  if (r.enviado) return res.json({ ok: true, mensaje: `Correo de prueba enviado a ${r.destinatarios} administrador(es) con ${r.alertas.length} alerta(s) activa(s).` });
  const motivo = { 'sin alertas': 'Hoy no hay nada que avisar (nadie supera el límite ni hay cupos superados).', error: r.error }[r.omitido] || `No se envió: ${r.omitido}.`;
  res.json({ ok: false, mensaje: motivo });
});

// ---------------------------------------------------------------------------
// Tablero
// ---------------------------------------------------------------------------
router.post('/tablero', async (req, res) => {
  try {
    const r = await consumo.generarTablero({ desde: req.body?.desde, hasta: req.body?.hasta, forzar: !!req.body?.forzar });
    await auditar(req, {
      entidad: 'Consumo de biometría', entidadId: 1, entidadNombre: 'Tablero de consumo y reusos', accion: 'EJECUCION',
      detalle: `Consumo del ${r.filtro.desde} al ${r.filtro.hasta}: ASISA ${r.proveedores[0].total}, OLIMPIA ${r.proveedores[1].total} casos, ${r.general.reintentos} en reintento${r.avisos.length ? `, ${r.avisos.length} sección(es) con aviso` : ''} (${(r.duracionMs / 1000).toFixed(1)} s)`,
    });
    res.json(r);
  } catch (error) {
    responderError(res, error, 'el tablero de consumo');
  }
});

// Detalle de un cliente en un día (al hacer clic en una fila de «Clientes con más intentos»). En la auditoría queda el id interno y la fecha, nunca cédula ni nombre.
router.post('/cliente-dia', async (req, res) => {
  try {
    const r = await detalle.detalleClienteDia({ idCliente: req.body?.idCliente, fecha: req.body?.fecha, proveedor: req.body?.proveedor });
    await auditar(req, {
      entidad: 'Consumo de biometría (detalle)', entidadId: String(r.cliente.idCliente), entidadNombre: 'Detalle de cliente en un día', accion: 'EJECUCION',
      detalle: `Consultó el detalle del cliente interno ${r.cliente.idCliente} el ${r.fecha}: ${r.resumen.casos} caso(s), ${r.resumen.reusos} reuso(s).`,
    });
    res.json(r);
  } catch (error) {
    responderError(res, error, 'el detalle del cliente');
  }
});

module.exports = router;
