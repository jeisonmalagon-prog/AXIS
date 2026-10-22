const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');

// Histórico de cambios de la Bitácora de Apuntamientos: cada fila guarda el
// valor ANTERIOR y el NUEVO de los campos relevantes (aplicación, servidor,
// componente, categoría ACE/Bus 10, servicio, observaciones), resueltos con
// el nombre real de cada uno en ese momento — así no hace falta cruzar
// listas en el frontend (ver migracion_apuntamientos_historico.sql). Las
// filas con Accion = 'AJUSTE' (ver migracion_apuntamientos_ajustes.sql)
// además traen TrandId y ErrorDescripcion.
//
// A propósito NO se incluye ImagenBase64 aquí — solo un booleano
// TieneImagen. Con potencialmente muchas filas de histórico (sobre todo en
// el listado completo), traer cada imagen (hasta ~2 MB c/u) en la misma
// respuesta puede volverla enorme y lenta. La imagen real se pide aparte,
// una por una, con GET /:apuntamientoId/../imagen/:historicoId más abajo.
//
// Mismo patrón que ya existe en este proyecto para Certificados/Histórico
// (certificados.js escribe, historico.js lee — ver ese archivo).
const SELECT_HISTORICO = `
  SELECT
    h.Id, h.ApuntamientoId, h.Accion,
    h.AplicacionIdAnterior, apA.Nombre AS AplicacionAnteriorNombre,
    h.AplicacionIdNuevo, apN.Nombre AS AplicacionNuevoNombre,
    h.ServidorIdAnterior, svA.Hostname AS ServidorAnteriorHostname, svA.IP AS ServidorAnteriorIP,
    h.ServidorIdNuevo, svN.Hostname AS ServidorNuevoHostname, svN.IP AS ServidorNuevoIP,
    h.ComponenteAnterior, h.ComponenteNuevo,
    h.SinApuntamientoAnterior, h.SinApuntamientoNuevo,
    h.CategoriaAnterior, h.CategoriaNueva,
    h.ServicioInventarioIdAnterior, siA.Codigo AS ServicioAnteriorCodigo, siA.NombreServicio AS ServicioAnteriorNombre,
    h.ServicioInventarioIdNuevo, siN.Codigo AS ServicioNuevoCodigo, siN.NombreServicio AS ServicioNuevoNombre,
    h.Observaciones, h.TrandId, h.ErrorDescripcion, (h.ImagenBase64 IS NOT NULL) AS TieneImagen,
    h.Usuario, h.FechaCambio, h.FechaActualizacionDeclarada
  FROM ApuntamientosHistorico h
  LEFT JOIN Aplicaciones apA ON apA.Id = h.AplicacionIdAnterior
  LEFT JOIN Aplicaciones apN ON apN.Id = h.AplicacionIdNuevo
  LEFT JOIN Servidores svA ON svA.Id = h.ServidorIdAnterior
  LEFT JOIN Servidores svN ON svN.Id = h.ServidorIdNuevo
  LEFT JOIN AceServiciosInventario siA ON siA.Id = h.ServicioInventarioIdAnterior
  LEFT JOIN AceServiciosInventario siN ON siN.Id = h.ServicioInventarioIdNuevo
`;

// ==========================================================
// GET /api/apuntamientos-historico - histórico completo (pantalla dedicada)
// ==========================================================
router.get('/', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(`${SELECT_HISTORICO} ORDER BY h.FechaCambio DESC, h.Id DESC`);
    res.json(filas);
  } catch (error) {
    console.error('Error al listar el histórico de apuntamientos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// GET /api/apuntamientos-historico/imagen/:historicoId - trae la imagen de
// UNA fila de histórico en particular, a pedido (ver nota de arriba sobre
// por qué no viaja en los listados).
// ==========================================================
router.get('/imagen/:historicoId', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(
      'SELECT ImagenBase64 FROM ApuntamientosHistorico WHERE Id = ?',
      [req.params.historicoId]
    );
    if (filas.length === 0 || !filas[0].ImagenBase64) {
      return res.status(404).json({ error: 'Este registro del histórico no tiene una imagen adjunta' });
    }
    res.json({ ImagenBase64: filas[0].ImagenBase64 });
  } catch (error) {
    console.error('Error al obtener la imagen del histórico:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// GET /api/apuntamientos-historico/:apuntamientoId - línea de tiempo de UNO
// en particular (para filtrar desde la Bitácora de Apuntamientos)
// ==========================================================
router.get('/:apuntamientoId', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(
      `${SELECT_HISTORICO} WHERE h.ApuntamientoId = ? ORDER BY h.FechaCambio DESC, h.Id DESC`,
      [req.params.apuntamientoId]
    );
    res.json(filas);
  } catch (error) {
    console.error('Error al listar el histórico del apuntamiento:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

module.exports = router;
