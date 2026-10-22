const express = require('express');
const router = express.Router();
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { verifyToken } = require('../middlewares/authMiddleware');
const { getPool } = require('../db');
const { asegurarEsquemaNotificaciones, generarRecordatorios } = require('../utils/notificaciones');

// Bandeja de notificaciones de la persona que inició sesión. No depende de ningún módulo:
// cualquier usuario autenticado ve SOLO las suyas. Nada se borra: «descartar» marca Activo = 0.
router.use(verifyToken);

function manejar(contexto, fn) {
  return async (req, res) => {
    try {
      const pool = await getPool();
      const estado = await asegurarEsquemaNotificaciones(pool);
      if (!estado.ok) return res.json({ disponible: false, mensaje: estado.mensaje, items: [], noLeidas: 0 });
      await fn(req, res, pool);
    } catch (error) {
      if (res.headersSent) return;
      console.error(`Error en notificaciones (${contexto}):`, error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto }) });
    }
  };
}

const formatear = (n) => ({
  id: n.Id,
  tipo: n.Tipo,
  severidad: n.Severidad,
  titulo: n.Titulo,
  mensaje: n.Mensaje,
  enlace: n.Enlace,
  referencia: n.Referencia,
  accion: n.Accion,
  leida: !!n.Leida,
  fecha: n.FechaCreacion,
});

// Cantidad sin leer (la consulta la hace el encabezado cada minuto; aprovecha para generar recordatorios).
router.get('/contador', manejar('las notificaciones', async (req, res, pool) => {
  await generarRecordatorios(pool, req.user.id);
  const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM notificaciones WHERE UsuarioId = ? AND Activo = 1 AND Leida = 0', [req.user.id]);
  const [[p]] = await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE UsuarioId = ? AND Activo = 1 AND Accion = 'PENDIENTE'", [req.user.id]);
  res.json({ disponible: true, noLeidas: Number(r.n), pendientesDeRespuesta: Number(p.n) });
}));

router.get('/', manejar('las notificaciones', async (req, res, pool) => {
  await generarRecordatorios(pool, req.user.id, req.query.actualizar === '1');
  const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 50, 1), 200);
  const soloNoLeidas = req.query.soloNoLeidas === '1';
  const [filas] = await pool.query(
    `SELECT Id, Tipo, Severidad, Titulo, Mensaje, Enlace, Referencia, Accion, Leida, FechaCreacion
       FROM notificaciones WHERE UsuarioId = ? AND Activo = 1${soloNoLeidas ? ' AND Leida = 0' : ''}
      ORDER BY (Accion = 'PENDIENTE') DESC, Leida ASC, FechaCreacion DESC, Id DESC LIMIT ?`,
    [req.user.id, limite]
  );
  const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM notificaciones WHERE UsuarioId = ? AND Activo = 1 AND Leida = 0', [req.user.id]);
  res.json({ disponible: true, items: filas.map(formatear), noLeidas: Number(r.n) });
}));

router.post('/leer-todas', manejar('marcar como leídas', async (req, res, pool) => {
  // Las que esperan una respuesta (solicitudes de compartir) se quedan sin leer hasta responderlas.
  await pool.query("UPDATE notificaciones SET Leida = 1, FechaLeida = NOW() WHERE UsuarioId = ? AND Activo = 1 AND Leida = 0 AND (Accion IS NULL OR Accion <> 'PENDIENTE')", [req.user.id]);
  res.json({ ok: true });
}));

router.post('/:id/leer', manejar('marcar como leída', async (req, res, pool) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Notificación no válida.' });
  await pool.query('UPDATE notificaciones SET Leida = 1, FechaLeida = COALESCE(FechaLeida, NOW()) WHERE Id = ? AND UsuarioId = ?', [id, req.user.id]);
  res.json({ ok: true });
}));

router.post('/:id/descartar', manejar('descartar la notificación', async (req, res, pool) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Notificación no válida.' });
  const [[n]] = await pool.query('SELECT Accion FROM notificaciones WHERE Id = ? AND UsuarioId = ? AND Activo = 1', [id, req.user.id]);
  if (!n) return res.status(404).json({ error: 'La notificación no existe.' });
  if (n.Accion === 'PENDIENTE') return res.status(409).json({ error: 'Esta solicitud espera tu respuesta: acepta o rechaza antes de descartarla.' });
  await pool.query('UPDATE notificaciones SET Activo = 0, Leida = 1, FechaLeida = COALESCE(FechaLeida, NOW()) WHERE Id = ? AND UsuarioId = ?', [id, req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
