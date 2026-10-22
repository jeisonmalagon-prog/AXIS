const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');

// GET /api/sistemas-operativos
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    // En MySQL, simplemente extraemos las filas con [rows]
    const [rows] = await pool.query('SELECT * FROM SistemasOperativos ORDER BY Nombre');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

module.exports = router;