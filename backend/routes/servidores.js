const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');

// NOTA: esta tabla (Servidores/SistemasOperativos) es la referencia de
// servidores que usan las pantallas del módulo CERTIFICADOS (servidores-list,
// certificados-por-servidor, certificados-list, aplicaciones-list — ver
// core/services/servidor.service.ts) — NO es el inventario del módulo
// SERVIDORES (ese es /api/servidoresInventario). Por eso el gate de módulo
// aquí es CERTIFICADOS y no SERVIDORES.
const ETIQUETAS_CAMPOS = {
  IP: 'IP',
  Hostname: 'Hostname',
  SistemaOperativoId: 'Sistema operativo',
  Ambiente: 'Ambiente',
  Activo: 'Activo',
};
const CAMPOS_AUDITADOS = Object.keys(ETIQUETAS_CAMPOS);

// GET /api/servidores - Leer todos
router.get('/', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query(`
      SELECT s.Id, s.IP, s.Hostname, s.SistemaOperativoId, so.Nombre AS SistemaOperativo,
             s.Ambiente, s.Activo, s.FechaRegistro
      FROM Servidores s
      INNER JOIN SistemasOperativos so ON s.SistemaOperativoId = so.Id
      ORDER BY s.Hostname
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener servidores antiguos:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/servidores/:id - Leer uno específico
router.get('/:id', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query('SELECT * FROM Servidores WHERE Id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Servidor no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// POST /api/servidores - Crear
router.post('/', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  const ip = req.body.IP || req.body.ip;
  const hostname = req.body.Hostname || req.body.hostname;
  const sistemaOperativoId = req.body.SistemaOperativoId || req.body.sistemaOperativoId;
  const ambiente = req.body.Ambiente || req.body.ambiente;

  if (!ip || !hostname || !sistemaOperativoId) {
    return res.status(400).json({ error: 'IP, Hostname y Sistema Operativo son obligatorios' });
  }

  // El Hostname siempre se guarda en MAYÚSCULAS para que el inventario quede
  // consistente sin importar cómo lo haya escrito la persona en el formulario.
  const hostnameNormalizado = hostname.trim().toUpperCase();

  try {
    const pool = await getPool();
    const [result] = await pool.query(
      'INSERT INTO Servidores (IP, Hostname, SistemaOperativoId, Ambiente) VALUES (?, ?, ?, ?)',
      [ip, hostnameNormalizado, sistemaOperativoId, ambiente || null]
    );
    const [rows] = await pool.query('SELECT * FROM Servidores WHERE Id = ?', [result.insertId]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'CERTIFICADOS',
      entidad: 'Servidor',
      entidadId: result.insertId,
      entidadNombre: hostnameNormalizado,
      accion: 'CREACION',
      detalle: `Servidor creado (IP: ${ip})`,
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error al crear servidor antiguo:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err, { contexto: 'el servidor' }) });
  }
});

// PUT /api/servidores/:id - Actualizar
router.put('/:id', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  const ip = req.body.IP || req.body.ip;
  const hostname = req.body.Hostname || req.body.hostname;
  const sistemaOperativoId = req.body.SistemaOperativoId || req.body.sistemaOperativoId;
  const ambiente = req.body.Ambiente || req.body.ambiente;
  const rawActivo = req.body.Activo !== undefined ? req.body.Activo : req.body.activo;

  const estadoActivo = rawActivo !== undefined ? (rawActivo ? 1 : 0) : 1;
  const id = req.params.id;

  // El Hostname siempre se guarda en MAYÚSCULAS para que el inventario quede
  // consistente sin importar cómo lo haya escrito la persona en el formulario.
  const hostnameNormalizado = hostname ? hostname.trim().toUpperCase() : hostname;

  try {
    const pool = await getPool();

    const [servidoresAntes] = await pool.query('SELECT * FROM Servidores WHERE Id = ?', [id]);
    if (!servidoresAntes.length) return res.status(404).json({ error: 'Servidor no encontrado' });
    const antes = servidoresAntes[0];

    const [result] = await pool.query(`
        UPDATE Servidores
        SET IP = ?, Hostname = ?, SistemaOperativoId = ?, Ambiente = ?, Activo = ?
        WHERE Id = ?
      `, [ip, hostnameNormalizado, sistemaOperativoId, ambiente || null, estadoActivo, id]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Servidor no encontrado' });

    const [rows] = await pool.query('SELECT * FROM Servidores WHERE Id = ?', [id]);

    const cambios = diffCampos(
      antes,
      { IP: ip, Hostname: hostnameNormalizado, SistemaOperativoId: sistemaOperativoId, Ambiente: ambiente || null, Activo: estadoActivo },
      CAMPOS_AUDITADOS,
      ETIQUETAS_CAMPOS
    );

    await registrarEventoGeneral(pool, req, {
      modulo: 'CERTIFICADOS',
      entidad: 'Servidor',
      entidadId: id,
      entidadNombre: hostnameNormalizado || antes.Hostname,
      accion: 'EDICION',
      cambios,
    });

    res.json(rows[0]);
  } catch (err) {
    console.error('Error al actualizar servidor antiguo:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err, { contexto: 'el servidor' }) });
  }
});

// DELETE /api/servidores/:id - Eliminar
router.delete('/:id', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [servidoresAntes] = await pool.query('SELECT * FROM Servidores WHERE Id = ?', [req.params.id]);
    const servidorBorrado = servidoresAntes[0] || null;

    const [result] = await pool.query('DELETE FROM Servidores WHERE Id = ?', [req.params.id]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Servidor no encontrado' });

    if (servidorBorrado) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'CERTIFICADOS',
        entidad: 'Servidor',
        entidadId: req.params.id,
        entidadNombre: servidorBorrado.Hostname,
        accion: 'ELIMINACION',
        detalle: `Servidor eliminado (IP: ${servidorBorrado.IP || '—'})`,
      });
    }

    res.status(204).send();
  } catch (err) {
    console.error('Error al eliminar servidor antiguo:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err, { contexto: 'el servidor' }) });
  }
});

module.exports = router;
