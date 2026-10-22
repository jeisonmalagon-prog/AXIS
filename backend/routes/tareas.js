const express = require('express');
const router = express.Router();
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { getPool } = require('../db');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');
const { esErrorDePrivilegios, columnasFaltantes } = require('../utils/esquemaSeguro');
const { rolEnModulo, ROL_CONSULTA } = require('../utils/permisosModulos');
const { notificarVarios } = require('../utils/notificaciones');
const {
  HORA_INICIO_DEFECTO,
  HORA_FIN_DEFECTO,
  normalizarHora,
  sincronizarTarea,
  eliminarEventoDeTarea,
} = require('../utils/tareasCalendario');

// Gestor de Tareas/Pendientes: a propósito NO usa requireEditPermission acá
// (ver decisión con el usuario) -- cualquier usuario (por defecto, incluido el
// rol BASIC) puede crear una tarea y asignársela a uno o varios compañeros;
// solo un rol de módulo CONSULTA asignado explícitamente lo limita (ver abajo). El único
// control de acceso es "estar involucrado en la tarea" (haberla creado o
// estar entre los asignados). Esto vale TAMBIÉN para el ADMIN_POD: cada usuario
// ve solo lo suyo o lo que le asignen, nadie ve las tareas de los demás.
router.use(verifyToken, requireModule('TAREAS'));

// Rol por módulo (ver utils/permisosModulos.js). Con Tareas = ADMIN_MIN (o ADMIN_POD)
// el usuario gestiona sus tareas como siempre. Con Tareas = CONSULTA solo puede ver
// las tareas donde participa, cambiar su estado (y marcar ítems del checklist) y
// registrar avances; no puede crear, editar el contenido ni eliminar tareas.
const MENSAJE_CONSULTA_TAREAS =
  'Tu rol en Tareas es de Consulta: puedes ver tus tareas y cambiar su estado, pero no crearlas, editarlas ni eliminarlas.';

async function esSoloConsulta(req) {
  return (await rolEnModulo(req, 'TAREAS')) === ROL_CONSULTA;
}

// Bloquea la ruta para quien solo tiene rol de Consulta.
async function noConsulta(req, res, next) {
  try {
    if (await esSoloConsulta(req)) return res.status(403).json({ error: MENSAJE_CONSULTA_TAREAS });
    next();
  } catch (error) {
    next(error);
  }
}

// Para quien solo tiene Consulta, deja pasar únicamente el campo indicado del
// body (p. ej. 'estado') y descarta el resto; si ese campo no viene, rechaza.
function soloCampoSiConsulta(campo) {
  return async (req, res, next) => {
    try {
      if (await esSoloConsulta(req)) {
        const valor = req.body ? req.body[campo] : undefined;
        if (valor === undefined) return res.status(403).json({ error: MENSAJE_CONSULTA_TAREAS });
        req.body = { [campo]: valor };
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

const ESTADOS_VALIDOS = ['PENDIENTE', 'EN_PROGRESO', 'COMPLETADA', 'CANCELADA'];
const PRIORIDADES_VALIDAS = ['BAJA', 'MEDIA', 'ALTA'];

const ETIQUETAS_CAMPOS_TAREA = {
  Titulo: 'Título',
  Descripcion: 'Descripción',
  Estado: 'Estado',
  Prioridad: 'Prioridad',
  FechaLimite: 'Fecha límite',
};
const CAMPOS_AUDITADOS_TAREA = Object.keys(ETIQUETAS_CAMPOS_TAREA);

// Fecha de hoy (YYYY-MM-DD) en la zona horaria de la operación: una tarea nueva no puede tener
// fecha límite anterior a hoy.
function hoyISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ_NEGOCIO || 'America/Bogota' });
}
function fechaSolo(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return `${valor.getFullYear()}-${String(valor.getMonth() + 1).padStart(2, '0')}-${String(valor.getDate()).padStart(2, '0')}`; // DATE de MySQL = medianoche local
  return String(valor).slice(0, 10);
}
const MENSAJE_FECHA_PASADA = 'La fecha límite no puede ser anterior a la fecha actual.';

// Horario de la tarea (hora de inicio y de entrega, para agendarla en el calendario):
// columnas Tareas.HoraInicio / HoraFin. Si faltan y el usuario de BD no puede crearlas,
// las tareas siguen funcionando igual (el horario solo se usa para el calendario y no
// queda guardado) -- ver Claude outputs/agregar_horario_tareas.sql.
let horarioConfirmado = false;
let horarioProximaRevision = 0;
async function horarioDisponible(pool) {
  if (horarioConfirmado) return true;
  if (Date.now() < horarioProximaRevision) return false;
  try {
    const faltan = await columnasFaltantes(pool, 'Tareas', ['HoraInicio', 'HoraFin']);
    if (faltan.length) {
      await pool.query('ALTER TABLE Tareas ADD COLUMN HoraInicio TIME NULL, ADD COLUMN HoraFin TIME NULL');
    }
    horarioConfirmado = true;
    return true;
  } catch (error) {
    if (!esErrorDePrivilegios(error)) console.error('No se pudo verificar el horario de las tareas:', error);
    horarioProximaRevision = Date.now() + 60000;
    return false;
  }
}

// Normaliza las horas que llegan del frontend. Devuelve { horaInicio, horaFin } (null si
// no se enviaron) o { error }. Con fecha límite, el horario por defecto es 09:00 - 10:00.
function leerHorario(body, hayFecha, previo = {}) {
  const crudoInicio = body.horaInicio !== undefined ? body.horaInicio : undefined;
  const crudoFin = body.horaFin !== undefined ? body.horaFin : undefined;
  const inicioEnviado = crudoInicio !== undefined && crudoInicio !== null && crudoInicio !== '';
  const finEnviado = crudoFin !== undefined && crudoFin !== null && crudoFin !== '';
  const horaInicio = inicioEnviado ? normalizarHora(crudoInicio) : undefined;
  const horaFin = finEnviado ? normalizarHora(crudoFin) : undefined;
  if ((inicioEnviado && !horaInicio) || (finEnviado && !horaFin)) return { error: 'La hora de inicio o de entrega no es válida (usa el formato HH:MM).' };
  const inicio = horaInicio || normalizarHora(previo.HoraInicio) || (hayFecha ? HORA_INICIO_DEFECTO : null);
  const fin = horaFin || normalizarHora(previo.HoraFin) || (hayFecha ? HORA_FIN_DEFECTO : null);
  if (hayFecha && inicio && fin && fin <= inicio) return { error: 'La hora de entrega debe ser posterior a la hora de inicio.' };
  return { horaInicio: inicio, horaFin: fin };
}

// Trae una tarea con su lista de asignados (array de {id, nombreCompleto}) y
// el nombre de quien la creó -- el mismo shape para listar y para el detalle.
async function obtenerTareaCompleta(pool, tareaId) {
  const colsHorario = (await horarioDisponible(pool)) ? ', t.HoraInicio, t.HoraFin' : '';
  const [[tarea]] = await pool.query(
    `SELECT t.Id, t.Titulo, t.Descripcion, t.Estado, t.Prioridad, t.FechaLimite${colsHorario},
            t.CreadoPorId, u.nombre_completo AS CreadoPorNombre,
            t.FechaCreacion, t.FechaCompletada, t.FechaActualizacion
     FROM Tareas t
     INNER JOIN usuarios u ON u.id = t.CreadoPorId
     WHERE t.Id = ?`,
    [tareaId]
  );
  if (!tarea) return null;

  const [asignados] = await pool.query(
    `SELECT u.id, u.nombre_completo AS nombreCompleto
     FROM TareaAsignados ta
     INNER JOIN usuarios u ON u.id = ta.UsuarioId
     WHERE ta.TareaId = ?
     ORDER BY u.nombre_completo`,
    [tareaId]
  );

  return { ...tarea, ...horarioNormalizado(tarea), asignados };
}

function horarioNormalizado(tarea) {
  return { HoraInicio: normalizarHora(tarea.HoraInicio), HoraFin: normalizarHora(tarea.HoraFin) };
}

async function usuarioPuedeVerTarea(pool, req, tareaId) {
  // Sin excepción para ADMIN_POD: solo quien creó la tarea o está asignado a ella.
  const [[fila]] = await pool.query(
    `SELECT 1
     FROM Tareas t
     LEFT JOIN TareaAsignados ta ON ta.TareaId = t.Id AND ta.UsuarioId = ?
     WHERE t.Id = ? AND (t.CreadoPorId = ? OR ta.UsuarioId IS NOT NULL)`,
    [req.user.id, tareaId, req.user.id]
  );
  return !!fila;
}

// ==========================================================
// GET /api/tareas -- tareas donde el usuario es creador o asignado
// (también el ADMIN_POD: nadie ve las tareas de otros). Filtros opcionales: ?estado=, ?vista=creadas|asignadas
// ==========================================================
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const condiciones = [];
    const parametros = [];

    if (req.query.vista === 'creadas') {
      condiciones.push('t.CreadoPorId = ?');
      parametros.push(req.user.id);
    } else if (req.query.vista === 'asignadas') {
      condiciones.push('EXISTS (SELECT 1 FROM TareaAsignados ta WHERE ta.TareaId = t.Id AND ta.UsuarioId = ?)');
      parametros.push(req.user.id);
    } else {
      condiciones.push('(t.CreadoPorId = ? OR EXISTS (SELECT 1 FROM TareaAsignados ta WHERE ta.TareaId = t.Id AND ta.UsuarioId = ?))');
      parametros.push(req.user.id, req.user.id);
    }

    if (req.query.estado && ESTADOS_VALIDOS.includes(req.query.estado)) {
      condiciones.push('t.Estado = ?');
      parametros.push(req.query.estado);
    }

    const whereSql = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const colsHorario = (await horarioDisponible(pool)) ? ', t.HoraInicio, t.HoraFin' : '';
    const [tareas] = await pool.query(
      `SELECT t.Id, t.Titulo, t.Descripcion, t.Estado, t.Prioridad, t.FechaLimite${colsHorario},
              t.CreadoPorId, u.nombre_completo AS CreadoPorNombre,
              t.FechaCreacion, t.FechaCompletada, t.FechaActualizacion
       FROM Tareas t
       INNER JOIN usuarios u ON u.id = t.CreadoPorId
       ${whereSql}
       ORDER BY (t.Estado = 'COMPLETADA' OR t.Estado = 'CANCELADA') ASC, t.FechaLimite IS NULL, t.FechaLimite ASC, t.FechaCreacion DESC`,
      parametros
    );

    if (!tareas.length) return res.json([]);

    // Un solo query para los asignados de TODAS las tareas de la lista, en
    // vez de N consultas (una por tarea) -- mismo criterio de rendimiento
    // que el resto de la app.
    const ids = tareas.map((t) => t.Id);
    const [asignaciones] = await pool.query(
      `SELECT ta.TareaId, u.id, u.nombre_completo AS nombreCompleto
       FROM TareaAsignados ta
       INNER JOIN usuarios u ON u.id = ta.UsuarioId
       WHERE ta.TareaId IN (?)
       ORDER BY u.nombre_completo`,
      [ids]
    );
    const asignadosPorTarea = new Map();
    asignaciones.forEach((a) => {
      const lista = asignadosPorTarea.get(a.TareaId) || [];
      lista.push({ id: a.id, nombreCompleto: a.nombreCompleto });
      asignadosPorTarea.set(a.TareaId, lista);
    });

    res.json(tareas.map((t) => ({ ...t, ...horarioNormalizado(t), asignados: asignadosPorTarea.get(t.Id) || [] })));
  } catch (error) {
    console.error('Error al listar tareas:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'las tareas' }) });
  }
});

// ==========================================================
// GET /api/tareas/:id -- detalle + avances
// ==========================================================
router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await usuarioPuedeVerTarea(pool, req, req.params.id))) {
      return res.status(403).json({ error: 'No tienes acceso a esta tarea.' });
    }
    const tarea = await obtenerTareaCompleta(pool, req.params.id);
    if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada.' });

    const [avances] = await pool.query(
      `SELECT ta.Id, ta.Comentario, ta.FechaRegistro, u.id AS UsuarioId, u.nombre_completo AS UsuarioNombre
       FROM TareaAvances ta
       INNER JOIN usuarios u ON u.id = ta.UsuarioId
       WHERE ta.TareaId = ?
       ORDER BY ta.FechaRegistro DESC`,
      [req.params.id]
    );

    res.json({ ...tarea, avances });
  } catch (error) {
    console.error('Error al obtener la tarea:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la tarea' }) });
  }
});

// ==========================================================
// POST /api/tareas -- crear (y asignar a uno o varios usuarios)
// ==========================================================
router.post('/', noConsulta, async (req, res) => {
  const { titulo, descripcion, prioridad, fechaLimite, asignados } = req.body;

  if (!titulo || !String(titulo).trim()) {
    return res.status(400).json({ error: 'El título de la tarea es obligatorio.' });
  }
  const prioridadFinal = PRIORIDADES_VALIDAS.includes(prioridad) ? prioridad : 'MEDIA';
  if (fechaLimite && fechaSolo(fechaLimite) < hoyISO()) return res.status(400).json({ error: MENSAJE_FECHA_PASADA });
  const horario = leerHorario(req.body, !!fechaLimite);
  if (horario.error) return res.status(400).json({ error: horario.error });

  // Sin asignados explícitos -> la tarea queda asignada a quien la crea (un
  // pendiente propio), en vez de quedar "en el aire" sin ningún responsable.
  let listaAsignados = Array.isArray(asignados) ? [...new Set(asignados.map(Number).filter(Boolean))] : [];
  if (!listaAsignados.length) listaAsignados = [req.user.id];

  const conexion = await (await getPool()).getConnection();
  try {
    await conexion.beginTransaction();

    const conHorario = await horarioDisponible(await getPool());
    const [resultado] = await conexion.query(
      conHorario
        ? `INSERT INTO Tareas (Titulo, Descripcion, Estado, Prioridad, FechaLimite, CreadoPorId, HoraInicio, HoraFin)
           VALUES (?, ?, 'PENDIENTE', ?, ?, ?, ?, ?)`
        : `INSERT INTO Tareas (Titulo, Descripcion, Estado, Prioridad, FechaLimite, CreadoPorId)
           VALUES (?, ?, 'PENDIENTE', ?, ?, ?)`,
      [
        String(titulo).trim(), descripcion ? String(descripcion).trim() : null, prioridadFinal, fechaLimite || null, req.user.id,
        ...(conHorario ? [horario.horaInicio, horario.horaFin] : []),
      ]
    );
    const tareaId = resultado.insertId;

    await conexion.query(
      `INSERT INTO TareaAsignados (TareaId, UsuarioId) VALUES ?`,
      [listaAsignados.map((usuarioId) => [tareaId, usuarioId])]
    );

    await conexion.commit();

    const pool = await getPool();
    await registrarEventoGeneral(pool, req, {
      modulo: 'TAREAS',
      entidad: 'Tarea',
      entidadId: tareaId,
      entidadNombre: String(titulo).trim(),
      accion: 'CREACION',
      detalle: `Asignada a ${listaAsignados.length} usuario(s).`,
    });

    // Avisa a quienes recibieron la tarea (menos a quien la creó).
    await notificarVarios(pool, listaAsignados, {
      tipo: 'TAREA_ASIGNADA', severidad: 'INFO', titulo: 'Te asignaron una tarea', referencia: tareaId, enlace: '/tareas',
      mensaje: `${req.user?.nombre_completo || req.user?.username || 'Alguien'} te asignó «${String(titulo).trim()}»${fechaLimite ? ` (fecha límite ${String(fechaLimite).slice(0, 10)})` : ''}.`,
      clave: `tarea-asignada-${tareaId}`,
    }, req.user.id);

    const tarea = await obtenerTareaCompleta(pool, tareaId);
    // Agenda la tarea en el calendario (si tiene fecha límite). Si falla, la tarea ya quedó
    // guardada: se avisa en "calendario" sin romper la respuesta.
    const calendario = await sincronizarTarea({ ...tarea, HoraInicio: horario.horaInicio, HoraFin: horario.horaFin });
    res.status(201).json({ ...tarea, calendario });
  } catch (error) {
    await conexion.rollback();
    console.error('Error al crear la tarea:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la tarea' }) });
  } finally {
    conexion.release();
  }
});

// ==========================================================
// PUT /api/tareas/:id -- editar datos y/o reasignar
// ==========================================================
router.put('/:id', soloCampoSiConsulta('estado'), async (req, res) => {
  const { titulo, descripcion, prioridad, fechaLimite, estado, asignados } = req.body;

  try {
    const pool = await getPool();
    if (!(await usuarioPuedeVerTarea(pool, req, req.params.id))) {
      return res.status(403).json({ error: 'No tienes acceso a esta tarea.' });
    }
    const antes = await obtenerTareaCompleta(pool, req.params.id);
    if (!antes) return res.status(404).json({ error: 'Tarea no encontrada.' });

    const fechaFinal = fechaLimite !== undefined ? (fechaLimite || null) : antes.FechaLimite;
    // Una fecha límite NUEVA no puede ser anterior a hoy. Si no cambió (p. ej. una tarea ya vencida a la que solo
    // se le cambia el estado o el título) se respeta tal cual.
    if (fechaFinal && fechaSolo(fechaFinal) !== fechaSolo(antes.FechaLimite) && fechaSolo(fechaFinal) < hoyISO()) {
      return res.status(400).json({ error: MENSAJE_FECHA_PASADA });
    }
    const horario = leerHorario(req.body, !!fechaFinal, antes);
    if (horario.error) return res.status(400).json({ error: horario.error });
    const conHorario = await horarioDisponible(pool);

    const estadoFinal = ESTADOS_VALIDOS.includes(estado) ? estado : antes.Estado;
    const prioridadFinal = PRIORIDADES_VALIDAS.includes(prioridad) ? prioridad : antes.Prioridad;
    // FechaCompletada se fija sola al pasar a COMPLETADA y se limpia si se
    // revierte -- así el "tiempo que llevó" (FechaCompletada - FechaCreacion)
    // siempre refleja el último cierre real, sin que el usuario tenga que
    // tocar una fecha a mano.
    let fechaCompletadaSql = antes.FechaCompletada;
    if (estadoFinal === 'COMPLETADA' && antes.Estado !== 'COMPLETADA') {
      fechaCompletadaSql = new Date();
    } else if (estadoFinal !== 'COMPLETADA') {
      fechaCompletadaSql = null;
    }

    await pool.query(
      `UPDATE Tareas
       SET Titulo = ?, Descripcion = ?, Estado = ?, Prioridad = ?, FechaLimite = ?, FechaCompletada = ?${conHorario ? ', HoraInicio = ?, HoraFin = ?' : ''}
       WHERE Id = ?`,
      [
        titulo !== undefined && String(titulo).trim() ? String(titulo).trim() : antes.Titulo,
        descripcion !== undefined ? (descripcion ? String(descripcion).trim() : null) : antes.Descripcion,
        estadoFinal,
        prioridadFinal,
        fechaFinal,
        fechaCompletadaSql,
        ...(conHorario ? [fechaFinal ? horario.horaInicio : null, fechaFinal ? horario.horaFin : null] : []),
        req.params.id,
      ]
    );

    if (Array.isArray(asignados)) {
      const listaAsignados = [...new Set(asignados.map(Number).filter(Boolean))];
      if (listaAsignados.length) {
        await pool.query('DELETE FROM TareaAsignados WHERE TareaId = ?', [req.params.id]);
        await pool.query(
          `INSERT INTO TareaAsignados (TareaId, UsuarioId) VALUES ?`,
          [listaAsignados.map((usuarioId) => [req.params.id, usuarioId])]
        );
      }
    }

    const despues = await obtenerTareaCompleta(pool, req.params.id);
    const cambios = diffCampos(antes, despues, CAMPOS_AUDITADOS_TAREA, ETIQUETAS_CAMPOS_TAREA);
    await registrarEventoGeneral(pool, req, {
      modulo: 'TAREAS',
      entidad: 'Tarea',
      entidadId: req.params.id,
      entidadNombre: despues.Titulo,
      accion: 'ACTUALIZACION',
      cambios,
    });

    // Mantiene el evento del calendario al día (título, fecha/hora, asignados, estado).
    // Sin columnas de horario, se usan las horas enviadas (o las del evento existente).
    const calendario = await sincronizarTarea({
      ...despues,
      HoraInicio: conHorario ? despues.HoraInicio : (req.body.horaInicio !== undefined ? horario.horaInicio : null),
      HoraFin: conHorario ? despues.HoraFin : (req.body.horaFin !== undefined ? horario.horaFin : null),
    });
    res.json({ ...despues, calendario });
  } catch (error) {
    console.error('Error al actualizar la tarea:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la tarea' }) });
  }
});

// ==========================================================
// POST /api/tareas/:id/avances -- registrar un avance/comentario
// ==========================================================
router.post('/:id/avances', async (req, res) => {
  const { comentario } = req.body;
  if (!comentario || !String(comentario).trim()) {
    return res.status(400).json({ error: 'El comentario de avance no puede estar vacío.' });
  }
  try {
    const pool = await getPool();
    if (!(await usuarioPuedeVerTarea(pool, req, req.params.id))) {
      return res.status(403).json({ error: 'No tienes acceso a esta tarea.' });
    }
    await pool.query(
      `INSERT INTO TareaAvances (TareaId, UsuarioId, Comentario) VALUES (?, ?, ?)`,
      [req.params.id, req.user.id, String(comentario).trim().slice(0, 1000)]
    );
    const [avances] = await pool.query(
      `SELECT ta.Id, ta.Comentario, ta.FechaRegistro, u.id AS UsuarioId, u.nombre_completo AS UsuarioNombre
       FROM TareaAvances ta
       INNER JOIN usuarios u ON u.id = ta.UsuarioId
       WHERE ta.TareaId = ?
       ORDER BY ta.FechaRegistro DESC`,
      [req.params.id]
    );
    res.status(201).json(avances);
  } catch (error) {
    console.error('Error al registrar el avance de la tarea:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el avance de la tarea' }) });
  }
});

// ==========================================================
// DELETE /api/tareas/:id -- solo quien la creó
// ==========================================================
router.delete('/:id', noConsulta, async (req, res) => {
  try {
    const pool = await getPool();
    const tarea = await obtenerTareaCompleta(pool, req.params.id);
    if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada.' });
    if (tarea.CreadoPorId !== req.user.id) {
      return res.status(403).json({ error: 'Solo quien creó la tarea puede eliminarla.' });
    }

    await pool.query('DELETE FROM Tareas WHERE Id = ?', [req.params.id]);
    await eliminarEventoDeTarea(tarea.Id);
    await registrarEventoGeneral(pool, req, {
      modulo: 'TAREAS',
      entidad: 'Tarea',
      entidadId: req.params.id,
      entidadNombre: tarea.Titulo,
      accion: 'ELIMINACION',
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar la tarea:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la tarea' }) });
  }
});

// ==========================================================
// Checklist de subtareas -- mismo criterio de acceso que el resto de Tareas
// (NO requireEditPermission): puede agregar/marcar/eliminar ítems cualquiera
// que esté involucrado en la tarea (creador o asignado) -- ver
// usuarioPuedeVerTarea().
// ==========================================================
router.get('/:id/checklist', async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await usuarioPuedeVerTarea(pool, req, req.params.id))) {
      return res.status(403).json({ error: 'No tienes acceso a esta tarea.' });
    }
    const [items] = await pool.query(
      `SELECT c.Id, c.Descripcion, c.Completado, c.Orden,
              c.CompletadoPorId, uc.nombre_completo AS CompletadoPorNombre, c.FechaCompletado, c.FechaCreacion
       FROM TareaChecklist c
       LEFT JOIN usuarios uc ON uc.id = c.CompletadoPorId
       WHERE c.TareaId = ?
       ORDER BY c.Orden ASC, c.Id ASC`,
      [req.params.id]
    );
    res.json(items);
  } catch (error) {
    console.error('Error al listar el checklist de la tarea:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el checklist de la tarea' }) });
  }
});

router.post('/:id/checklist', noConsulta, async (req, res) => {
  const { descripcion } = req.body;
  if (!descripcion || !String(descripcion).trim()) {
    return res.status(400).json({ error: 'La descripción del ítem del checklist es obligatoria.' });
  }
  try {
    const pool = await getPool();
    if (!(await usuarioPuedeVerTarea(pool, req, req.params.id))) {
      return res.status(403).json({ error: 'No tienes acceso a esta tarea.' });
    }
    const [[{ siguienteOrden }]] = await pool.query(
      'SELECT COALESCE(MAX(Orden), -1) + 1 AS siguienteOrden FROM TareaChecklist WHERE TareaId = ?',
      [req.params.id]
    );
    const [resultado] = await pool.query(
      `INSERT INTO TareaChecklist (TareaId, Descripcion, Orden, CreadoPorId) VALUES (?, ?, ?, ?)`,
      [req.params.id, String(descripcion).trim().slice(0, 255), siguienteOrden, req.user.id]
    );
    const [[item]] = await pool.query(
      `SELECT c.Id, c.Descripcion, c.Completado, c.Orden, c.CompletadoPorId, NULL AS CompletadoPorNombre, c.FechaCompletado, c.FechaCreacion
       FROM TareaChecklist c WHERE c.Id = ?`,
      [resultado.insertId]
    );
    res.status(201).json(item);
  } catch (error) {
    console.error('Error al agregar el ítem del checklist:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el ítem del checklist' }) });
  }
});

router.put('/:id/checklist/:itemId', soloCampoSiConsulta('completado'), async (req, res) => {
  const { descripcion, completado } = req.body;
  try {
    const pool = await getPool();
    if (!(await usuarioPuedeVerTarea(pool, req, req.params.id))) {
      return res.status(403).json({ error: 'No tienes acceso a esta tarea.' });
    }
    const [[antes]] = await pool.query(
      'SELECT Id, Descripcion, Completado FROM TareaChecklist WHERE Id = ? AND TareaId = ?',
      [req.params.itemId, req.params.id]
    );
    if (!antes) return res.status(404).json({ error: 'Ítem de checklist no encontrado.' });

    const nuevoCompletado = completado !== undefined ? !!completado : !!antes.Completado;
    await pool.query(
      `UPDATE TareaChecklist
       SET Descripcion = ?, Completado = ?, CompletadoPorId = ?, FechaCompletado = ?
       WHERE Id = ?`,
      [
        descripcion !== undefined && String(descripcion).trim() ? String(descripcion).trim().slice(0, 255) : antes.Descripcion,
        nuevoCompletado ? 1 : 0,
        nuevoCompletado ? req.user.id : null,
        nuevoCompletado ? new Date() : null,
        req.params.itemId,
      ]
    );

    const [[item]] = await pool.query(
      `SELECT c.Id, c.Descripcion, c.Completado, c.Orden,
              c.CompletadoPorId, uc.nombre_completo AS CompletadoPorNombre, c.FechaCompletado, c.FechaCreacion
       FROM TareaChecklist c
       LEFT JOIN usuarios uc ON uc.id = c.CompletadoPorId
       WHERE c.Id = ?`,
      [req.params.itemId]
    );
    res.json(item);
  } catch (error) {
    console.error('Error al actualizar el ítem del checklist:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el ítem del checklist' }) });
  }
});

router.delete('/:id/checklist/:itemId', noConsulta, async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await usuarioPuedeVerTarea(pool, req, req.params.id))) {
      return res.status(403).json({ error: 'No tienes acceso a esta tarea.' });
    }
    const [[item]] = await pool.query(
      'SELECT Id FROM TareaChecklist WHERE Id = ? AND TareaId = ?',
      [req.params.itemId, req.params.id]
    );
    if (!item) return res.status(404).json({ error: 'Ítem de checklist no encontrado.' });

    await pool.query('DELETE FROM TareaChecklist WHERE Id = ?', [req.params.itemId]);
    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar el ítem del checklist:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el ítem del checklist' }) });
  }
});

module.exports = router;
