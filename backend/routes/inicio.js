const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const W = require('../utils/inicioWidgets');

// Pantalla principal (Inicio) con métricas en vivo.
//  - Cualquier usuario logueado entra, pero SOLO recibe los widgets que el
//    ADMIN_POD dejó habilitados y de módulos que él mismo tiene.
//  - La configuración (qué widgets, orden, tamaño, refresco) es exclusiva del
//    ADMIN_POD.
router.use(verifyToken);

const soloAdminPod = (req, res, next) => {
  if (W.esAdmin(req)) return next();
  return res.status(403).json({ error: 'Solo el ADMIN_POD puede configurar la pantalla de inicio.' });
};

// Widgets que debe pintar este usuario (sin datos; cada uno pide los suyos).
router.get('/widgets', async (req, res) => {
  try {
    const pool = await getPool();
    res.json({ widgets: await W.widgetsVisibles(pool, req) });
  } catch (error) {
    console.error('Error listando widgets de inicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la pantalla de inicio' }) });
  }
});

// Datos en vivo de un widget. Un fallo de Portainer/F5 NO es un 500: se
// responde 200 con "error" para que solo ese cuadro muestre el problema.
router.get('/datos/:id', async (req, res) => {
  const id = String(req.params.id);
  try {
    const w = W.POR_ID.get(id);
    if (!w) return res.status(404).json({ error: 'Widget desconocido.' });
    const pool = await getPool();
    const visibles = await W.widgetsVisibles(pool, req);
    if (!visibles.some((v) => v.id === id)) {
      return res.status(403).json({ error: 'Este widget no está habilitado para ti.' });
    }
    try {
      let opciones = {};
      if (typeof req.query.opciones === 'string' && req.query.opciones.length <= 4000) {
        try { opciones = JSON.parse(req.query.opciones); } catch (e) { opciones = {}; }
      }
      res.json(await W.datosDeWidget(id, req, opciones));
    } catch (error) {
      console.warn(`[inicio] Falló el widget ${id}: ${error.message}`);
      res.json({ id, generadoEn: new Date().toISOString(), error: mensajeErrorAmigable(error, { contexto: w.titulo }) });
    }
  } catch (error) {
    console.error('Error en datos de inicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la pantalla de inicio' }) });
  }
});

// Lista liviana de Virtual Servers de un F5 (para el selector del cuadro «tráfico en vivo»).
router.get('/f5/virtuales', async (req, res) => {
  try {
    if (!W.tieneModulo(req, 'BALANCEADOR_F5')) return res.status(403).json({ error: 'No tienes acceso al módulo Balanceador F5.' });
    const { buscarDispositivo, cargarDispositivosF5 } = require('../utils/f5Cliente');
    const M = require('../utils/inicioMonitoreo');
    const pedido = String(req.query.dispositivo || '').trim();
    const dispositivo = (pedido && buscarDispositivo(pedido)) || cargarDispositivosF5()[0];
    if (!dispositivo) return res.json({ dispositivo: null, virtuales: [] });
    res.json({ dispositivo: String(dispositivo.id), virtuales: await M.catalogoVirtuales(dispositivo) });
  } catch (error) {
    console.warn(`[inicio] No se pudo listar los Virtual Servers: ${error.message}`);
    res.json({ dispositivo: null, virtuales: [], error: mensajeErrorAmigable(error, { contexto: 'el balanceador F5' }) });
  }
});

// ---- Preferencias del usuario (filtros de cada cuadro) ----
router.get('/preferencias', async (req, res) => {
  try {
    const pool = await getPool();
    res.json(await W.leerPreferencias(pool, req.user.id));
  } catch (error) {
    console.error('Error leyendo preferencias de inicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'tus preferencias de inicio' }) });
  }
});

router.put('/preferencias/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const opciones = await W.guardarPreferencia(pool, req.user.id, String(req.params.id), req.body?.opciones);
    res.json({ ok: true, opciones });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Error guardando preferencia de inicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'tus preferencias de inicio' }) });
  }
});

router.delete('/preferencias/:id', async (req, res) => {
  try {
    const pool = await getPool();
    await W.borrarPreferencia(pool, req.user.id, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    console.error('Error borrando preferencia de inicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'tus preferencias de inicio' }) });
  }
});

// ---- Configuración (ADMIN_POD) ----
router.get('/config', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const { tabla, config } = await W.leerConfig(pool);
    const porId = new Map(config.map((c) => [c.id, c]));
    const widgets = W.CATALOGO
      .map((w) => ({ ...porId.get(w.id), titulo: w.titulo, descripcion: w.descripcion, modulo: w.modulo, grupo: w.grupo }))
      .sort((a, b) => a.orden - b.orden);
    res.json({
      tabla,
      widgets,
      anchos: W.ANCHOS_VALIDOS,
      intervaloMin: W.INTERVALO_MIN,
      intervaloMax: W.INTERVALO_MAX,
    });
  } catch (error) {
    console.error('Error leyendo la configuración de inicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la configuración de inicio' }) });
  }
});

router.put('/config', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const antes = (await W.leerConfig(pool)).config;
    const guardados = await W.guardarConfig(pool, req.body?.widgets, req.user.username);

    const previo = new Map(antes.map((c) => [c.id, c]));
    const habilitados = guardados.filter((c) => c.habilitado).map((c) => c.id);
    const cambiados = guardados.filter((c) => {
      const p = previo.get(c.id);
      return !p || p.habilitado !== c.habilitado || p.ancho !== c.ancho || p.intervaloSeg !== c.intervaloSeg
        || p.soloAdmin !== c.soloAdmin || p.orden !== c.orden;
    });
    if (cambiados.length) {
      try {
        await registrarEventoGeneral(pool, req, {
          modulo: 'INICIO',
          entidad: 'Widgets de inicio',
          entidadNombre: 'Pantalla principal',
          accion: 'EDICION',
          detalle: `Visibles: ${habilitados.join(', ') || 'ninguno'}. Modificados: ${cambiados.map((c) => c.id).join(', ')}.`,
        });
      } catch (e) {
        console.error('[inicio] No se pudo registrar la auditoría:', e.message);
      }
    }
    res.json({ ok: true, widgets: guardados });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Error guardando la configuración de inicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la configuración de inicio' }) });
  }
});

module.exports = router;
