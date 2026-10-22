const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');

const ETIQUETAS_CAMPOS_APUNTAMIENTO = {
  AplicacionId: 'Aplicación',
  ServidorId: 'Servidor',
  Componente: 'Aplicación interna (componente)',
  SinApuntamiento: 'Sin apuntamiento a servicios',
  Categoria: 'Categoría',
  ServicioInventarioId: 'Servicio',
};
const CAMPOS_AUDITADOS_APUNTAMIENTO = Object.keys(ETIQUETAS_CAMPOS_APUNTAMIENTO);

// Trae cada apuntamiento ya "resuelto" con el nombre de la aplicación y los
// datos del servicio real al que apunta (cuando aplica), para que el
// frontend no tenga que cruzar listas por separado.
const SELECT_CON_JOIN = `
  SELECT
    a.Id, a.AplicacionId, a.ServidorId, a.Componente, a.SinApuntamiento, a.Categoria,
    a.ServicioInventarioId, a.Observaciones, a.FechaRegistro, a.FechaActualizacion,
    ap.Nombre AS AplicacionNombre,
    sv.Hostname AS ServidorHostname, sv.IP AS ServidorIP,
    si.Codigo AS ServicioCodigo, si.NombreServicio AS ServicioNombre, si.Pod AS ServicioPod
  FROM Apuntamientos a
  INNER JOIN Aplicaciones ap ON ap.Id = a.AplicacionId
  LEFT JOIN Servidores sv ON sv.Id = a.ServidorId
  LEFT JOIN AceServiciosInventario si ON si.Id = a.ServicioInventarioId
`;

// El histórico de cambios (ApuntamientosHistorico) vive en su propio router
// (routes/apuntamientosHistorico.js, montado en /api/apuntamientos-historico)
// — mismo patrón que ya existe en este proyecto para Certificados/Histórico
// (certificados.js + historico.js), en vez de anidarlo aquí.

// ==========================================================
// GET /api/apuntamientos - bitácora completa
// ==========================================================
router.get('/', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(`${SELECT_CON_JOIN} ORDER BY ap.Nombre, a.Componente`);
    res.json(filas);
  } catch (error) {
    console.error('Error al listar la bitácora de apuntamientos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// FechaActualizacion ya no se recalcula sola con ON UPDATE CURRENT_TIMESTAMP
// (ver migracion_apuntamientos_fecha_manual.sql) — el flujo de "registrar
// cambio" (más abajo) la fija explícitamente: si manda una fecha válida
// ("YYYY-MM-DD HH:MM:SS", el formato que entrega el frontend desde su
// <input type="datetime-local">), se usa esa; si no, la fecha/hora actual
// del servidor.
const FORMATO_FECHA_MYSQL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function formatoFechaMysql(fecha) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())} ${pad(fecha.getHours())}:${pad(fecha.getMinutes())}:${pad(fecha.getSeconds())}`;
}

function resolverFechaActualizacion(valor) {
  if (typeof valor === 'string' && FORMATO_FECHA_MYSQL.test(valor.trim())) {
    return valor.trim();
  }
  return formatoFechaMysql(new Date());
}

// Límite de tamaño para la imagen adjunta (data URI base64). ~2 MB de
// binario ⇒ un poco más en base64 por el overhead de esa codificación
// (~37%); dejamos margen. Se valida también en el frontend, pero nunca hay
// que confiar solo en eso.
const MAX_IMAGEN_BASE64_CHARS = 2.8 * 1024 * 1024;
const FORMATO_IMAGEN_DATA_URI = /^data:image\/(png|jpe?g|gif|webp);base64,/;

function validarImagen(valor) {
  if (!valor) return { ok: true, valor: null };
  if (typeof valor !== 'string' || !FORMATO_IMAGEN_DATA_URI.test(valor)) {
    return { ok: false, error: 'La imagen debe ser un archivo PNG, JPG, GIF o WEBP.' };
  }
  if (valor.length > MAX_IMAGEN_BASE64_CHARS) {
    return { ok: false, error: 'La imagen es muy grande (máximo ~2 MB).' };
  }
  return { ok: true, valor };
}

// ============================================================
// Validación para CREAR (POST): el registro es nuevo, así que necesita
// todos los datos completos de una vez — o dice explícitamente "sin
// apuntamiento a servicios", o trae categoría + servicio completos. Nunca
// una mezcla a medias (ver nota en migracion_apuntamientos.sql sobre por
// qué esto se valida aquí y no con un CHECK en la base de datos).
// ============================================================
function validarPayloadCreacion(body) {
  const { AplicacionId, SinApuntamiento, Categoria, ServicioInventarioId } = body;

  if (!AplicacionId) return 'AplicacionId es obligatorio';

  if (SinApuntamiento) return null;

  if (!Categoria || !['ACE', 'BUS_INTEGRACION_10'].includes(Categoria)) {
    return 'La categoría debe ser ACE o BUS_INTEGRACION_10 (o marcar "sin apuntamiento a servicios")';
  }
  if (!ServicioInventarioId) {
    return 'Debes seleccionar el servicio al que apunta (o marcar "sin apuntamiento a servicios")';
  }
  return null;
}

// ==========================================================
// POST /api/apuntamientos - crear
// ==========================================================
router.post('/', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  const errorValidacion = validarPayloadCreacion(req.body);
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });

  const { AplicacionId, Componente, ServidorId, Observaciones } = req.body;
  const sinApuntamiento = !!req.body.SinApuntamiento;
  // Si es "sin apuntamiento", Categoria/ServicioInventarioId se fuerzan a
  // NULL sin importar lo que haya llegado en el body.
  const categoria = sinApuntamiento ? null : req.body.Categoria;
  const servicioInventarioId = sinApuntamiento ? null : req.body.ServicioInventarioId;
  const fechaActualizacion = resolverFechaActualizacion(req.body.FechaActualizacion);
  const componenteNuevo = Componente?.trim() || null;
  const observacionesNuevo = Observaciones?.trim() || null;

  try {
    const pool = await getPool();
    const [resultado] = await pool.query(
      `INSERT INTO Apuntamientos
        (AplicacionId, ServidorId, Componente, SinApuntamiento, Categoria, ServicioInventarioId, Observaciones, FechaActualizacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [AplicacionId, ServidorId || null, componenteNuevo, sinApuntamiento ? 1 : 0, categoria, servicioInventarioId, observacionesNuevo, fechaActualizacion]
    );

    // Deja constancia del alta en el histórico (ver
    // migracion_apuntamientos_historico.sql). req.user viene del JWT
    // (verifyToken), así que siempre hay username disponible aquí.
    await pool.query(
      `INSERT INTO ApuntamientosHistorico
        (ApuntamientoId, Accion, AplicacionIdNuevo, ServidorIdNuevo, ComponenteNuevo, SinApuntamientoNuevo,
         CategoriaNueva, ServicioInventarioIdNuevo, Observaciones, Usuario, FechaActualizacionDeclarada)
       VALUES (?, 'ALTA', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [resultado.insertId, AplicacionId, ServidorId || null, componenteNuevo, sinApuntamiento ? 1 : 0, categoria, servicioInventarioId, observacionesNuevo, req.user?.username || null, fechaActualizacion]
    );

    const [filas] = await pool.query(`${SELECT_CON_JOIN} WHERE a.Id = ?`, [resultado.insertId]);
    res.status(201).json(filas[0]);
  } catch (error) {
    console.error('Error al crear el apuntamiento:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// PUT /api/apuntamientos/:id - "Editar apuntamiento" (Acción 1)
// ==========================================================
// Corrige datos ESTRUCTURALES de un apuntamiento que ya existe: Aplicación,
// Servidor, Componente, "sin apuntamiento a servicios". A propósito NO
// toca Categoría, Servicio, Observaciones ni la fecha de última
// actualización — esos son del flujo de "Registrar cambio" (más abajo) — y
// a propósito NO deja registro en el histórico: es una corrección de
// datos, no un cambio operativo que haya que auditar.
//
// Si se marca "sin apuntamiento a servicios" aquí, se limpia Categoría y
// Servicio como efecto de esa regla de negocio (un apuntamiento sin
// servicio no puede tener categoría/servicio), pero sigue sin generar
// histórico — para eso está "Registrar cambio".
router.put('/:id', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  const { id } = req.params;
  const { AplicacionId, Componente, ServidorId } = req.body;
  const sinApuntamiento = !!req.body.SinApuntamiento;
  const componenteNuevo = Componente?.trim() || null;

  if (!AplicacionId) {
    return res.status(400).json({ error: 'AplicacionId es obligatorio' });
  }

  try {
    const pool = await getPool();

    const [antesFilas] = await pool.query(
      'SELECT AplicacionId, ServidorId, Componente, SinApuntamiento, Categoria, ServicioInventarioId FROM Apuntamientos WHERE Id = ?',
      [id]
    );
    if (!antesFilas.length) return res.status(404).json({ error: 'Apuntamiento no encontrado' });
    const antes = antesFilas[0];

    const campos = ['AplicacionId = ?', 'ServidorId = ?', 'Componente = ?', 'SinApuntamiento = ?'];
    const valores = [AplicacionId, ServidorId || null, componenteNuevo, sinApuntamiento ? 1 : 0];

    // Un apuntamiento marcado "sin apuntamiento a servicios" no puede tener
    // categoría/servicio — se limpian aquí mismo si se activa ese check.
    if (sinApuntamiento) {
      campos.push('Categoria = NULL', 'ServicioInventarioId = NULL');
    }

    const [resultado] = await pool.query(
      `UPDATE Apuntamientos SET ${campos.join(', ')} WHERE Id = ?`,
      [...valores, id]
    );

    if (resultado.affectedRows === 0) {
      return res.status(404).json({ error: 'Apuntamiento no encontrado' });
    }

    const [filas] = await pool.query(`${SELECT_CON_JOIN} WHERE a.Id = ?`, [id]);
    const apuntamiento = filas[0];

    const despues = {
      AplicacionId,
      ServidorId: ServidorId || null,
      Componente: componenteNuevo,
      SinApuntamiento: sinApuntamiento ? 1 : 0,
      Categoria: sinApuntamiento ? null : antes.Categoria,
      ServicioInventarioId: sinApuntamiento ? null : antes.ServicioInventarioId,
    };
    const cambios = diffCampos(antes, despues, CAMPOS_AUDITADOS_APUNTAMIENTO, ETIQUETAS_CAMPOS_APUNTAMIENTO);

    if (cambios.length) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVICIOS',
        entidad: 'Apuntamiento',
        entidadId: id,
        entidadNombre: `${apuntamiento?.AplicacionNombre || ''}${componenteNuevo ? ' - ' + componenteNuevo : ''}`.trim() || `Apuntamiento ${id}`,
        accion: 'EDICION',
        cambios,
      });
    }

    res.json(apuntamiento);
  } catch (error) {
    console.error('Error al actualizar el apuntamiento:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// POST /api/apuntamientos/:id/cambios - "Registrar cambio" (Acción 2:
// ajuste, mantenimiento o mejora)
// ==========================================================
// Documenta un cambio OPERATIVO sobre un apuntamiento que ya existe:
// cambiar su Categoría (ACE ↔ Bus de Integración 10) y/o el Servicio al
// que apunta, con Observaciones, TRANDID y una descripción del error (y
// opcionalmente una imagen). A diferencia de PUT /:id, esto SÍ actualiza el
// apuntamiento (Categoría, Servicio, Observaciones, fecha de última
// actualización) Y SÍ deja registro en el histórico con Accion = 'AJUSTE'.
router.post('/:id/cambios', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  const { id } = req.params;
  const { Categoria, ServicioInventarioId, Observaciones, TrandId } = req.body;
  const errorDescripcion = req.body.Error ?? req.body.ErrorDescripcion ?? null;

  if (!Categoria || !['ACE', 'BUS_INTEGRACION_10'].includes(Categoria)) {
    return res.status(400).json({ error: 'La categoría debe ser ACE o BUS_INTEGRACION_10' });
  }
  if (!ServicioInventarioId) {
    return res.status(400).json({ error: 'Debes seleccionar el servicio al que apunta' });
  }

  const imagenValidada = validarImagen(req.body.Imagen);
  if (!imagenValidada.ok) {
    return res.status(400).json({ error: imagenValidada.error });
  }

  const observacionesNuevo = Observaciones?.trim() || null;
  const trandIdNuevo = TrandId?.trim() || null;
  const errorDescripcionNuevo = errorDescripcion?.trim ? errorDescripcion.trim() || null : errorDescripcion;
  const fechaActualizacion = resolverFechaActualizacion(req.body.FechaActualizacion);

  try {
    const pool = await getPool();

    const [actuales] = await pool.query(
      `SELECT AplicacionId, ServidorId, Componente, SinApuntamiento, Categoria, ServicioInventarioId
       FROM Apuntamientos WHERE Id = ?`,
      [id]
    );
    if (actuales.length === 0) {
      return res.status(404).json({ error: 'Apuntamiento no encontrado' });
    }
    const anterior = actuales[0];

    if (anterior.SinApuntamiento) {
      return res.status(400).json({
        error: 'Este apuntamiento está marcado como "sin apuntamiento a servicios". Edítalo primero (Editar apuntamiento) para quitar esa marca antes de registrar un cambio de categoría/servicio.',
      });
    }

    const [resultado] = await pool.query(
      `UPDATE Apuntamientos
       SET Categoria = ?, ServicioInventarioId = ?, Observaciones = ?, FechaActualizacion = ?
       WHERE Id = ?`,
      [Categoria, ServicioInventarioId, observacionesNuevo, fechaActualizacion, id]
    );
    if (resultado.affectedRows === 0) {
      return res.status(404).json({ error: 'Apuntamiento no encontrado' });
    }

    // AplicacionId/ServidorId/Componente/SinApuntamiento no cambian en este
    // flujo — se guardan iguales en "anterior" y "nuevo" (describirCambios
    // en el frontend ya omite los campos que no variaron).
    await pool.query(
      `INSERT INTO ApuntamientosHistorico
        (ApuntamientoId, Accion,
         AplicacionIdAnterior, AplicacionIdNuevo,
         ServidorIdAnterior, ServidorIdNuevo,
         ComponenteAnterior, ComponenteNuevo,
         SinApuntamientoAnterior, SinApuntamientoNuevo,
         CategoriaAnterior, CategoriaNueva,
         ServicioInventarioIdAnterior, ServicioInventarioIdNuevo,
         Observaciones, TrandId, ErrorDescripcion, ImagenBase64, Usuario,
         FechaActualizacionDeclarada)
       VALUES (?, 'AJUSTE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        anterior.AplicacionId, anterior.AplicacionId,
        anterior.ServidorId, anterior.ServidorId,
        anterior.Componente, anterior.Componente,
        anterior.SinApuntamiento ? 1 : 0, anterior.SinApuntamiento ? 1 : 0,
        anterior.Categoria, Categoria,
        anterior.ServicioInventarioId, ServicioInventarioId,
        observacionesNuevo, trandIdNuevo, errorDescripcionNuevo, imagenValidada.valor,
        req.user?.username || null, fechaActualizacion,
      ]
    );

    const [filas] = await pool.query(`${SELECT_CON_JOIN} WHERE a.Id = ?`, [id]);
    res.json(filas[0]);
  } catch (error) {
    console.error('Error al registrar el cambio del apuntamiento:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// DELETE /api/apuntamientos/:id - eliminar
// ==========================================================
router.delete('/:id', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [antesFilas] = await pool.query(`${SELECT_CON_JOIN} WHERE a.Id = ?`, [req.params.id]);
    const apuntamientoBorrado = antesFilas[0] || null;

    const [resultado] = await pool.query('DELETE FROM Apuntamientos WHERE Id = ?', [req.params.id]);

    if (resultado.affectedRows === 0) {
      return res.status(404).json({ error: 'Apuntamiento no encontrado' });
    }

    if (apuntamientoBorrado) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVICIOS',
        entidad: 'Apuntamiento',
        entidadId: req.params.id,
        entidadNombre: `${apuntamientoBorrado.AplicacionNombre || ''}${apuntamientoBorrado.Componente ? ' - ' + apuntamientoBorrado.Componente : ''}`.trim() || `Apuntamiento ${req.params.id}`,
        accion: 'ELIMINACION',
        detalle: `Apuntamiento eliminado (aplicación: ${apuntamientoBorrado.AplicacionNombre || '—'})`,
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar el apuntamiento:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

module.exports = router;
