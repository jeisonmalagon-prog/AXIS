const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');
const { compararCodigoAce } = require('../utils/ordenarCodigoAce');

const CAMPOS_OPERACION = [
  'CodigoOperacion', 'Operacion', 'OperacionBackend', 'Descripcion',
  'Arquitectura', 'Version', 'Instancias', 'Compuestos', 'Atomicos', 'Sincrono', 'Asincrono',
];
const ETIQUETAS_OPERACION = {
  CodigoOperacion: 'Código', Operacion: 'Operación', OperacionBackend: 'Operación backend',
  Descripcion: 'Descripción', Arquitectura: 'Arquitectura', Version: 'Versión',
  Instancias: 'Instancias', Compuestos: 'Compuestos', Atomicos: 'Atómicos',
  Sincrono: 'Síncrono', Asincrono: 'Asíncrono',
};

// ==========================================================
// GET /api/ace-catalogo - árbol Servicio -> Operaciones
// ==========================================================
// La carga inicial se hizo por SQL (ver
// documentacion/migracion_ace_servicios.sql) a partir de CatalogoAce.xlsx;
// a partir de aquí el CRUD de abajo permite mantenerlo al día desde la app.
router.get('/', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [servicios] = await pool.query('SELECT * FROM AceServicios');
    const [operaciones] = await pool.query('SELECT * FROM AceOperaciones ORDER BY Id');

    servicios.sort((a, b) => compararCodigoAce(a, b, 'Nombre'));

    const resultado = servicios.map((s) => ({
      ...s,
      Operaciones: operaciones.filter((o) => o.ServicioId === s.Id),
    }));

    res.json(resultado);
  } catch (error) {
    console.error('Error al listar el catálogo ACE:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// SERVICIOS (AceServicios)
// ==========================================================

router.post('/servicios', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  const { Codigo, Nombre } = req.body;

  if (!Nombre || !Nombre.trim()) {
    return res.status(400).json({ error: 'El nombre del servicio es obligatorio' });
  }

  try {
    const pool = await getPool();
    const [resultado] = await pool.query(
      'INSERT INTO AceServicios (Codigo, Nombre, FechaActualizacion) VALUES (?, ?, NOW())',
      [Codigo?.trim() || null, Nombre.trim()]
    );

    const [filas] = await pool.query('SELECT * FROM AceServicios WHERE Id = ?', [resultado.insertId]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVICIOS',
      entidad: 'Servicio ACE',
      entidadId: resultado.insertId,
      entidadNombre: Nombre.trim(),
      accion: 'CREACION',
      detalle: `Servicio ACE creado (código: ${Codigo?.trim() || '—'})`,
    });

    res.status(201).json({ ...filas[0], Operaciones: [] });
  } catch (error) {
    console.error('Error al crear el servicio ACE:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.put('/servicios/:id', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  const { id } = req.params;
  const { Codigo, Nombre } = req.body;

  if (!Nombre || !Nombre.trim()) {
    return res.status(400).json({ error: 'El nombre del servicio es obligatorio' });
  }

  try {
    const pool = await getPool();
    const [serviciosAntes] = await pool.query('SELECT Codigo, Nombre FROM AceServicios WHERE Id = ?', [id]);
    if (!serviciosAntes.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const antes = serviciosAntes[0];

    const [resultado] = await pool.query(
      'UPDATE AceServicios SET Codigo = ?, Nombre = ?, FechaActualizacion = NOW() WHERE Id = ?',
      [Codigo?.trim() || null, Nombre.trim(), id]
    );

    if (resultado.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    const [filas] = await pool.query('SELECT * FROM AceServicios WHERE Id = ?', [id]);

    const cambios = diffCampos(
      antes,
      { Codigo: Codigo?.trim() || null, Nombre: Nombre.trim() },
      ['Codigo', 'Nombre'],
      { Codigo: 'Código', Nombre: 'Nombre' }
    );

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVICIOS',
      entidad: 'Servicio ACE',
      entidadId: id,
      entidadNombre: Nombre.trim(),
      accion: 'EDICION',
      cambios,
    });

    res.json(filas[0]);
  } catch (error) {
    console.error('Error al actualizar el servicio ACE:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.delete('/servicios/:id', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [serviciosAntes] = await pool.query('SELECT Nombre FROM AceServicios WHERE Id = ?', [req.params.id]);
    const nombreBorrado = serviciosAntes[0]?.Nombre || null;

    // AceOperaciones tiene ON DELETE CASCADE hacia AceServicios (ver
    // migracion_ace_servicios.sql), así que sus operaciones se borran solas.
    const [resultado] = await pool.query('DELETE FROM AceServicios WHERE Id = ?', [req.params.id]);

    if (resultado.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    if (nombreBorrado !== null) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVICIOS',
        entidad: 'Servicio ACE',
        entidadId: req.params.id,
        entidadNombre: nombreBorrado,
        accion: 'ELIMINACION',
        detalle: 'Servicio ACE eliminado (sus operaciones se eliminaron en cascada)',
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar el servicio ACE:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// OPERACIONES (AceOperaciones)
// ==========================================================
// Nota: DescripcionExcel guarda el texto original importado del Excel y no
// se toca desde este CRUD (solo se rellena, como null, al crear una
// operación nueva) para no perder ese dato en las que sí vinieron del
// archivo original.

router.post('/operaciones', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  const {
    ServicioId,
    CodigoOperacion,
    Operacion,
    OperacionBackend,
    Descripcion,
    Arquitectura,
    Version,
    Instancias,
    Compuestos,
    Atomicos,
    Sincrono,
    Asincrono,
  } = req.body;

  if (!ServicioId) {
    return res.status(400).json({ error: 'ServicioId es obligatorio' });
  }
  if (!Operacion || !Operacion.trim()) {
    return res.status(400).json({ error: 'El nombre de la operación es obligatorio' });
  }

  try {
    const pool = await getPool();
    const [resultado] = await pool.query(
      `INSERT INTO AceOperaciones
        (ServicioId, CodigoOperacion, Operacion, OperacionBackend, Descripcion, DescripcionExcel,
         Arquitectura, Version, Instancias, Compuestos, Atomicos, Sincrono, Asincrono)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ServicioId,
        CodigoOperacion?.trim() || null,
        Operacion.trim(),
        OperacionBackend?.trim() || null,
        Descripcion?.trim() || null,
        Arquitectura?.trim() || null,
        Version?.trim() || null,
        Instancias ?? null,
        Compuestos ?? null,
        Atomicos ?? null,
        Sincrono ? 1 : 0,
        Asincrono ? 1 : 0,
      ]
    );

    const [filas] = await pool.query('SELECT * FROM AceOperaciones WHERE Id = ?', [resultado.insertId]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVICIOS',
      entidad: 'Operación ACE',
      entidadId: resultado.insertId,
      entidadNombre: Operacion.trim(),
      accion: 'CREACION',
      detalle: `Operación ACE creada en el servicio Id ${ServicioId}`,
    });

    res.status(201).json(filas[0]);
  } catch (error) {
    console.error('Error al crear la operación ACE:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.put('/operaciones/:id', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  const { id } = req.params;
  const {
    CodigoOperacion,
    Operacion,
    OperacionBackend,
    Descripcion,
    Arquitectura,
    Version,
    Instancias,
    Compuestos,
    Atomicos,
    Sincrono,
    Asincrono,
  } = req.body;

  if (!Operacion || !Operacion.trim()) {
    return res.status(400).json({ error: 'El nombre de la operación es obligatorio' });
  }

  try {
    const pool = await getPool();
    const [operacionesAntes] = await pool.query('SELECT * FROM AceOperaciones WHERE Id = ?', [id]);
    if (!operacionesAntes.length) return res.status(404).json({ error: 'Operación no encontrada' });
    const antes = operacionesAntes[0];

    // No se incluye DescripcionExcel aquí a propósito: se conserva el valor
    // original del Excel aunque se edite el resto de la operación.
    const [resultado] = await pool.query(
      `UPDATE AceOperaciones SET
        CodigoOperacion = ?, Operacion = ?, OperacionBackend = ?, Descripcion = ?,
        Arquitectura = ?, Version = ?, Instancias = ?, Compuestos = ?, Atomicos = ?,
        Sincrono = ?, Asincrono = ?
       WHERE Id = ?`,
      [
        CodigoOperacion?.trim() || null,
        Operacion.trim(),
        OperacionBackend?.trim() || null,
        Descripcion?.trim() || null,
        Arquitectura?.trim() || null,
        Version?.trim() || null,
        Instancias ?? null,
        Compuestos ?? null,
        Atomicos ?? null,
        Sincrono ? 1 : 0,
        Asincrono ? 1 : 0,
        id,
      ]
    );

    if (resultado.affectedRows === 0) {
      return res.status(404).json({ error: 'Operación no encontrada' });
    }

    const [filas] = await pool.query('SELECT * FROM AceOperaciones WHERE Id = ?', [id]);

    const cambios = diffCampos(
      antes,
      {
        CodigoOperacion: CodigoOperacion?.trim() || null, Operacion: Operacion.trim(),
        OperacionBackend: OperacionBackend?.trim() || null, Descripcion: Descripcion?.trim() || null,
        Arquitectura: Arquitectura?.trim() || null, Version: Version?.trim() || null,
        Instancias: Instancias ?? null, Compuestos: Compuestos ?? null, Atomicos: Atomicos ?? null,
        Sincrono: Sincrono ? 1 : 0, Asincrono: Asincrono ? 1 : 0,
      },
      CAMPOS_OPERACION,
      ETIQUETAS_OPERACION
    );

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVICIOS',
      entidad: 'Operación ACE',
      entidadId: id,
      entidadNombre: Operacion.trim(),
      accion: 'EDICION',
      cambios,
    });

    res.json(filas[0]);
  } catch (error) {
    console.error('Error al actualizar la operación ACE:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.delete('/operaciones/:id', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [operacionesAntes] = await pool.query('SELECT Operacion FROM AceOperaciones WHERE Id = ?', [req.params.id]);
    const nombreBorrado = operacionesAntes[0]?.Operacion || null;

    const [resultado] = await pool.query('DELETE FROM AceOperaciones WHERE Id = ?', [req.params.id]);

    if (resultado.affectedRows === 0) {
      return res.status(404).json({ error: 'Operación no encontrada' });
    }

    if (nombreBorrado !== null) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVICIOS',
        entidad: 'Operación ACE',
        entidadId: req.params.id,
        entidadNombre: nombreBorrado,
        accion: 'ELIMINACION',
        detalle: 'Operación ACE eliminada',
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar la operación ACE:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

module.exports = router;
