const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');

// GET /api/dashboard/resumen
router.get('/resumen', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query('SELECT Estado, COUNT(*) AS Total FROM VW_CertificadosVigencia GROUP BY Estado');

    const resumen = { Vigente: 0, 'Por vencer': 0, Vencido: 0 };
    rows.forEach((row) => {
      resumen[row.Estado] = row.Total;
    });
    res.json(resumen);
  } catch (err) {
    console.error("Error en /api/dashboard/resumen:", err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/dashboard/por-vencer?dias=365
router.get('/por-vencer', async (req, res) => {
  const dias = parseInt(req.query.dias, 10) || 30;
  
  try {
    const pool = await getPool();
    
    // En lugar del Stored Procedure, consultamos la vista directamente.
    // Esto garantiza que podamos pedir 30, 365 o 1000 días sin que la BD se queje.
    const query = `
      SELECT * 
      FROM VW_CertificadosVigencia 
      WHERE DiasRestantes <= ? 
      ORDER BY DiasRestantes ASC
    `;
    
    const [rows] = await pool.query(query, [dias]);
    
    res.json(rows); 
  } catch (err) {
    // Ahora sí verás el error real en tu terminal si algo falla
    console.error(`Error en /api/dashboard/por-vencer pidiendo ${dias} días:`, err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

module.exports = router;