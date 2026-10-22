const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');

// GET /api/esquemas/:appId - Obtener el diagrama de una aplicación
router.get('/:appId', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query(
      'SELECT XmlDiagrama FROM Esquemas WHERE AplicacionId = ?',
      [req.params.appId]
    );

    if (rows.length === 0) {
      return res.json({ xml: null }); // Si no existe esquema previo
    }

    res.json({ xml: rows[0].XmlDiagrama });
  } catch (err) {
    console.error("Error cargando esquema:", err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});


// POST /api/esquemas/:appId - Guardar o actualizar el diagrama
// requireEditPermission bloquea a BASIC: aunque alguien intente llamar esta
// API directo (sin pasar por la capa de solo lectura del frontend), el
// backend lo rechaza igual.
router.post('/:appId', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  const { xml } = req.body;
  const appId = req.params.appId;

  if (!xml) return res.status(400).json({ error: 'El XML es obligatorio' });

  try {
    const pool = await getPool();

    // 1. Verificamos si la aplicación ya tiene un diagrama guardado
    const [esquemaExistente] = await pool.query(
      'SELECT Id FROM Esquemas WHERE AplicacionId = ?',
      [appId]
    );

    let accion;
    if (esquemaExistente.length > 0) {
      // 2a. Si ya existe, ACTUALIZAMOS (UPDATE)
      await pool.query(
        'UPDATE Esquemas SET XmlDiagrama = ? WHERE AplicacionId = ?',
        [xml, appId]
      );
      accion = 'EDICION';
    } else {
      // 2b. Si es nuevo, INSERTAMOS enviando también un valor para la columna 'Nombre'
      const nombrePorDefecto = `Esquema App ${appId}`;
      await pool.query(
        'INSERT INTO Esquemas (Nombre, AplicacionId, XmlDiagrama) VALUES (?, ?, ?)',
        [nombrePorDefecto, appId, xml]
      );
      accion = 'CREACION';
    }

    // El XML del diagrama no se difícil de leer campo a campo, así que no se
    // usa diffCampos aquí: solo se deja constancia de que el esquema cambió.
    let nombreAplicacion = `Aplicación ${appId}`;
    try {
      const [aplicaciones] = await pool.query('SELECT Nombre FROM Aplicaciones WHERE Id = ?', [appId]);
      if (aplicaciones.length) nombreAplicacion = aplicaciones[0].Nombre;
    } catch (errNombre) {
      console.error('No se pudo obtener el nombre de la aplicación para auditoría:', errNombre);
    }

    await registrarEventoGeneral(pool, req, {
      modulo: 'CERTIFICADOS',
      entidad: 'Esquema',
      entidadId: appId,
      entidadNombre: nombreAplicacion,
      accion,
      detalle: `Diagrama de esquema ${accion === 'CREACION' ? 'creado' : 'actualizado'} para la aplicación "${nombreAplicacion}"`,
    });

    res.json({ mensaje: 'Esquema guardado exitosamente' });
  } catch (err) {
    console.error("Error guardando el esquema en MariaDB:", err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

module.exports = router;