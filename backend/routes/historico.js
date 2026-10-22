const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');

router.use(verifyToken, requireModule('CERTIFICADOS'));

// Un certificado se identifica por Servidor + Componente (AplicacionId es un
// dato heredado y puede venir vacío). El histórico antes usaba INNER JOIN con
// Aplicaciones/Servidores a través de AplicacionId, así que los movimientos de
// certificados sin aplicación (los de ahora) desaparecían del listado.
const SELECT_HISTORICO = `
  SELECT h.*,
         c.NombreComun,
         c.EntidadEmisora,
         COALESCE(NULLIF(TRIM(c.Componente), ''), a.Nombre) AS Aplicacion,
         COALESCE(sc.Hostname, s.Hostname) AS Hostname,
         COALESCE(sc.IP, s.IP) AS IP
  FROM HistoricoCertificados h
  LEFT JOIN Certificados c ON c.Id = h.CertificadoId
  LEFT JOIN Aplicaciones a ON a.Id = c.AplicacionId
  LEFT JOIN Servidores s ON s.Id = a.ServidorId
  LEFT JOIN Servidores sc ON sc.Id = c.ServidorId
`;

// GET /api/historico
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query(`${SELECT_HISTORICO} ORDER BY h.FechaCambio DESC, h.Id DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/historico/:certificadoId
router.get('/:certificadoId', async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query(
      `${SELECT_HISTORICO} WHERE h.CertificadoId = ? ORDER BY h.FechaCambio DESC, h.Id DESC`,
      [req.params.certificadoId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

module.exports = router;
