const express = require('express');
const router = express.Router();
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const googleCalendar = require('../utils/googleCalendar');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const { getPool } = require('../db');
const { garantizarEsquemaCalendario, limpiarClaves, contextoDeUsuario } = require('../utils/calendarioPersonal');

// Todas las rutas de este módulo requieren el módulo CALENDARIO habilitado
// para el usuario (ver MODULOS_VALIDOS en routes/usuarios.js).
router.use(verifyToken, requireModule('CALENDARIO'));

// GET /api/calendario/estado -- así el frontend puede mostrar un aviso claro
// ("el calendario aún no está configurado") en vez de que cada pantalla
// reciba un 500 genérico si a alguien se le olvidó configurar las variables
// de entorno de Google.
router.get('/estado', (req, res) => {
  res.json({ configurado: googleCalendar.credencialesConfiguradas() });
});

// GET /api/calendario/eventos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Por defecto trae de 7 días atrás a 60 días adelante -- suficiente para ver
// lo reciente y lo que viene sin pedir un rango explícito cada vez.
//
// Devuelve la mezcla de DOS fuentes:
//   1) El calendario compartido "AXIS" (donde se agenda con "+ Agendar
//      Sesión") -- estos eventos son editables desde la app.
//   2) El calendario REAL de cada correo en CalendariosEquipo -- de solo
//      lectura, cada uno consultado por separado. Si alguno todavía no
//      compartió su calendario con la cuenta de servicio (o el correo está
//      mal escrito), ese calendario en particular falla pero el resto de la
//      respuesta sigue funcionando -- el error queda en "erroresCalendarios"
//      para que el frontend lo muestre como un aviso, no como una falla total.
router.get('/eventos', async (req, res) => {
  try {
    const ahora = new Date();
    const desde = req.query.desde ? new Date(`${req.query.desde}T00:00:00`) : new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
    const hasta = req.query.hasta ? new Date(`${req.query.hasta}T23:59:59`) : new Date(ahora.getTime() + 60 * 24 * 60 * 60 * 1000);

    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      return res.status(400).json({ error: 'Rango de fechas inválido.' });
    }

    // Personalización del usuario: qué tiene oculto y qué calendarios propios agregó.
    // Lo oculto ni siquiera se consulta a Google. Si faltan las tablas, todo sigue
    // como siempre (vista común para todos).
    const pool = await getPool();
    const ctx = await contextoDeUsuario(pool, req.user.id);
    const ocultos = new Set(ctx.ocultos);

    const eventosAxis = ocultos.has('axis')
      ? []
      : (await googleCalendar.listarEventos({ desde, hasta })).map((e) => ({ ...e, origen: 'axis', editable: true }));

    const [calendariosEquipo] = await pool.query('SELECT Id, Correo, Etiqueta FROM CalendariosEquipo ORDER BY Etiqueta');

    const erroresCalendarios = [];
    const leerCalendario = async (c, origen, extra, descripcion) => {
      try {
        const eventos = await googleCalendar.listarEventos({ desde, hasta, calendarioId: c.Correo });
        return eventos.map((e) => ({ ...e, origen, editable: false, etiquetaCalendario: c.Etiqueta, ...extra }));
      } catch (error) {
        console.error(`Error al leer el calendario real de ${c.Etiqueta} (${c.Correo}):`, error);
        erroresCalendarios.push(
          `No se pudo leer ${descripcion} de ${c.Etiqueta} (${c.Correo}) -- verifica que haya compartido su calendario con la cuenta de servicio.`
        );
        return [];
      }
    };

    const listasEquipo = await Promise.all([
      ...calendariosEquipo
        .filter((c) => !ocultos.has(`c:${c.Id}`))
        .map((c) => leerCalendario(c, 'equipo', { calendarioEquipoId: c.Id }, 'el calendario')),
      ...ctx.personales
        .filter((c) => !ocultos.has(`p:${c.Id}`))
        .map((c) => leerCalendario(c, 'personal', { calendarioPersonalId: c.Id }, 'tu calendario')),
    ]);

    const todos = [...eventosAxis, ...listasEquipo.flat()].sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));
    res.json({ eventos: todos, erroresCalendarios });
  } catch (error) {
    console.error('Error al listar eventos del calendario:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'los eventos del calendario' }) });
  }
});

// ---------- Personalización por usuario ----------

// GET /api/calendario/mis-calendarios -- todo lo que la pantalla necesita para
// pintar los filtros de ESTE usuario: calendarios comunes del equipo, los suyos
// y lo que tiene oculto. "disponible=false" si faltan las tablas (el calendario
// común sigue funcionando; solo se desactiva agregar/guardar preferencias).
router.get('/mis-calendarios', async (req, res) => {
  try {
    const pool = await getPool();
    const ctx = await contextoDeUsuario(pool, req.user.id);
    const [equipo] = await pool.query('SELECT Id, Correo, Etiqueta FROM CalendariosEquipo ORDER BY Etiqueta');
    res.json({ disponible: ctx.disponible, mensaje: ctx.mensaje, equipo, personales: ctx.personales, ocultos: ctx.ocultos });
  } catch (error) {
    console.error('Error al listar los calendarios del usuario:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'tus calendarios' }) });
  }
});

// Cualquier usuario con el módulo CALENDARIO puede agregar calendarios PARA SÍ
// MISMO (no toca nada compartido), por eso no exige permiso de edición.
router.post('/mis-calendarios', async (req, res) => {
  const correoLimpio = req.body.correo ? String(req.body.correo).trim().toLowerCase() : '';
  const etiquetaLimpia = req.body.etiqueta ? String(req.body.etiqueta).trim().slice(0, 100) : '';
  if (!correoLimpio || correoLimpio.length > 255 || !/^[^\s@]+@[^\s@]+$/.test(correoLimpio)) {
    return res.status(400).json({ error: 'Ingresa un correo válido.' });
  }
  if (!etiquetaLimpia) {
    return res.status(400).json({ error: 'Ingresa un nombre para mostrar.' });
  }
  try {
    const pool = await getPool();
    const errEsquema = await garantizarEsquemaCalendario(pool);
    if (errEsquema) return res.status(409).json({ error: errEsquema.message });

    const [repetido] = await pool.query('SELECT Id FROM CalendariosUsuario WHERE UsuarioId = ? AND Correo = ?', [req.user.id, correoLimpio]);
    if (repetido.length) return res.status(409).json({ error: 'Ya agregaste ese calendario.' });

    try {
      await googleCalendar.listarEventos({
        desde: new Date(),
        hasta: new Date(Date.now() + 24 * 60 * 60 * 1000),
        calendarioId: correoLimpio,
        maxResultados: 1,
      });
    } catch (error) {
      console.error(`No se pudo verificar acceso al calendario de ${correoLimpio}:`, error);
      return res.status(400).json({
        error: `No se pudo acceder al calendario de "${correoLimpio}". Antes de agregarlo, esa persona debe compartir su calendario con la cuenta de servicio (${process.env.GOOGLE_CALENDAR_CLIENT_EMAIL || 'la cuenta de servicio'}), con permiso de al menos "Ver todos los detalles del evento".`,
      });
    }

    const [r] = await pool.query('INSERT INTO CalendariosUsuario (UsuarioId, Correo, Etiqueta) VALUES (?, ?, ?)', [req.user.id, correoLimpio, etiquetaLimpia]);
    res.status(201).json({ Id: r.insertId, Correo: correoLimpio, Etiqueta: etiquetaLimpia });
  } catch (error) {
    console.error('Error al agregar el calendario del usuario:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'tu calendario' }) });
  }
});

router.delete('/mis-calendarios/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const errEsquema = await garantizarEsquemaCalendario(pool);
    if (errEsquema) return res.status(409).json({ error: errEsquema.message });
    // Solo puede quitar los suyos.
    const [r] = await pool.query('DELETE FROM CalendariosUsuario WHERE Id = ? AND UsuarioId = ?', [req.params.id, req.user.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'No se encontró ese calendario.' });
    res.status(204).send();
  } catch (error) {
    console.error('Error al quitar el calendario del usuario:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'tu calendario' }) });
  }
});

// PUT /api/calendario/preferencias { ocultos: ['axis', 'c:3', 'p:1', 'u:7'] }
router.put('/preferencias', async (req, res) => {
  const ocultos = limpiarClaves(req.body.ocultos);
  if (!ocultos) return res.status(400).json({ error: 'La lista de calendarios ocultos no es válida.' });
  try {
    const pool = await getPool();
    const errEsquema = await garantizarEsquemaCalendario(pool);
    if (errEsquema) return res.status(409).json({ error: errEsquema.message });
    await pool.query(
      `INSERT INTO CalendariosPreferencias (UsuarioId, Ocultos) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE Ocultos = VALUES(Ocultos)`,
      [req.user.id, JSON.stringify(ocultos)]
    );
    res.json({ ocultos });
  } catch (error) {
    console.error('Error al guardar las preferencias del calendario:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'tus preferencias del calendario' }) });
  }
});

// ---------- Calendarios reales del equipo (solo lectura, gestión de la lista) ----------

// GET /api/calendario/calendarios-equipo -- lectura permitida para cualquiera
// con el módulo CALENDARIO (la necesita el propio filtro/leyenda), pero solo
// quien tiene permiso de edición puede agregar/quitar correos.
router.get('/calendarios-equipo', async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query('SELECT Id, Correo, Etiqueta FROM CalendariosEquipo ORDER BY Etiqueta');
    res.json(filas);
  } catch (error) {
    console.error('Error al listar los calendarios del equipo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'los calendarios del equipo' }) });
  }
});

router.post('/calendarios-equipo', requireEditPermission, async (req, res) => {
  const { correo, etiqueta } = req.body;
  const correoLimpio = correo ? String(correo).trim() : '';
  const etiquetaLimpia = etiqueta ? String(etiqueta).trim() : '';
  if (!correoLimpio || !correoLimpio.includes('@')) {
    return res.status(400).json({ error: 'Ingresa un correo válido.' });
  }
  if (!etiquetaLimpia) {
    return res.status(400).json({ error: 'Ingresa un nombre para mostrar (ej. el nombre de la persona).' });
  }

  // Se verifica de una vez que la cuenta de servicio ya tenga acceso --
  // mejor avisar ahora mismo con un mensaje claro que dejar guardado un
  // correo que va a fallar en cada carga del calendario.
  try {
    await googleCalendar.listarEventos({
      desde: new Date(),
      hasta: new Date(Date.now() + 24 * 60 * 60 * 1000),
      calendarioId: correoLimpio,
      maxResultados: 1,
    });
  } catch (error) {
    console.error(`No se pudo verificar acceso al calendario de ${correoLimpio}:`, error);
    return res.status(400).json({
      error: `No se pudo acceder al calendario de "${correoLimpio}". Antes de agregarlo, esa persona debe compartir su calendario con la cuenta de servicio (${process.env.GOOGLE_CALENDAR_CLIENT_EMAIL || 'la cuenta de servicio'}), con permiso de al menos "Ver todos los detalles del evento".`,
    });
  }

  try {
    const pool = await getPool();
    const [resultado] = await pool.query('INSERT INTO CalendariosEquipo (Correo, Etiqueta, CreadoPorId) VALUES (?, ?, ?)', [
      correoLimpio,
      etiquetaLimpia,
      req.user.id,
    ]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'CALENDARIO',
      entidad: 'CalendarioEquipo',
      entidadId: resultado.insertId,
      entidadNombre: etiquetaLimpia,
      accion: 'CREACION',
      detalle: `Se agregó el calendario de ${correoLimpio} a la vista del equipo.`,
    });

    res.status(201).json({ Id: resultado.insertId, Correo: correoLimpio, Etiqueta: etiquetaLimpia });
  } catch (error) {
    console.error('Error al guardar el calendario del equipo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el calendario del equipo' }) });
  }
});

router.put('/calendarios-equipo/:id', requireEditPermission, async (req, res) => {
  const { correo, etiqueta } = req.body;
  const cambios = [];
  const valores = [];
  if (correo !== undefined) {
    const correoLimpio = String(correo).trim();
    if (!correoLimpio || !correoLimpio.includes('@')) {
      return res.status(400).json({ error: 'Ingresa un correo válido.' });
    }
    cambios.push('Correo = ?');
    valores.push(correoLimpio);
  }
  if (etiqueta !== undefined) {
    const etiquetaLimpia = String(etiqueta).trim();
    if (!etiquetaLimpia) {
      return res.status(400).json({ error: 'Ingresa un nombre para mostrar.' });
    }
    cambios.push('Etiqueta = ?');
    valores.push(etiquetaLimpia);
  }
  if (!cambios.length) {
    return res.status(400).json({ error: 'No hay ningún cambio para guardar.' });
  }

  try {
    const pool = await getPool();
    valores.push(req.params.id);
    await pool.query(`UPDATE CalendariosEquipo SET ${cambios.join(', ')} WHERE Id = ?`, valores);

    const [filas] = await pool.query('SELECT Id, Correo, Etiqueta FROM CalendariosEquipo WHERE Id = ?', [req.params.id]);
    if (!filas.length) return res.status(404).json({ error: 'No se encontró ese calendario.' });

    await registrarEventoGeneral(pool, req, {
      modulo: 'CALENDARIO',
      entidad: 'CalendarioEquipo',
      entidadId: req.params.id,
      entidadNombre: filas[0].Etiqueta,
      accion: 'ACTUALIZACION',
      detalle: 'Se editó un calendario de la vista del equipo.',
    });

    res.json(filas[0]);
  } catch (error) {
    console.error('Error al actualizar el calendario del equipo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el calendario del equipo' }) });
  }
});

router.delete('/calendarios-equipo/:id', requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query('SELECT Etiqueta FROM CalendariosEquipo WHERE Id = ?', [req.params.id]);
    await pool.query('DELETE FROM CalendariosEquipo WHERE Id = ?', [req.params.id]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'CALENDARIO',
      entidad: 'CalendarioEquipo',
      entidadId: req.params.id,
      entidadNombre: filas[0]?.Etiqueta,
      accion: 'ELIMINACION',
      detalle: 'Se quitó un calendario de la vista del equipo.',
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar el calendario del equipo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el calendario del equipo' }) });
  }
});

router.get('/eventos/:id', async (req, res) => {
  try {
    const evento = await googleCalendar.obtenerEvento(req.params.id);
    res.json({ ...evento, origen: 'axis', editable: true });
  } catch (error) {
    console.error('Error al obtener el evento del calendario:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el evento del calendario' }) });
  }
});

router.post('/eventos', requireEditPermission, async (req, res) => {
  const { titulo, descripcion, inicio, fin, todoElDia, asignados } = req.body;
  if (!titulo || !String(titulo).trim()) {
    return res.status(400).json({ error: 'El título del evento es obligatorio.' });
  }
  if (!inicio || !fin) {
    return res.status(400).json({ error: 'La fecha/hora de inicio y fin son obligatorias.' });
  }
  const listaAsignados = Array.isArray(asignados) ? [...new Set(asignados.map(Number).filter(Boolean))] : [];
  try {
    const evento = await googleCalendar.crearEvento({
      titulo: String(titulo).trim(),
      descripcion: descripcion ? String(descripcion).trim() : null,
      inicio,
      fin,
      todoElDia: !!todoElDia,
      asignados: listaAsignados,
    });

    const pool = await getPool();
    await registrarEventoGeneral(pool, req, {
      modulo: 'CALENDARIO',
      entidad: 'EventoCalendario',
      entidadId: evento.id,
      entidadNombre: evento.titulo,
      accion: 'CREACION',
      detalle: `Sesión agendada para ${evento.inicio}.`,
    });

    res.status(201).json({ ...evento, origen: 'axis', editable: true });
  } catch (error) {
    console.error('Error al crear el evento del calendario:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el evento del calendario' }) });
  }
});

router.put('/eventos/:id', requireEditPermission, async (req, res) => {
  const { titulo, descripcion, inicio, fin, todoElDia, asignados } = req.body;
  try {
    const evento = await googleCalendar.actualizarEvento(req.params.id, {
      titulo: titulo !== undefined ? String(titulo).trim() : undefined,
      descripcion: descripcion !== undefined ? (descripcion ? String(descripcion).trim() : null) : undefined,
      inicio,
      fin,
      todoElDia: !!todoElDia,
      asignados: Array.isArray(asignados) ? [...new Set(asignados.map(Number).filter(Boolean))] : undefined,
    });

    const pool = await getPool();
    await registrarEventoGeneral(pool, req, {
      modulo: 'CALENDARIO',
      entidad: 'EventoCalendario',
      entidadId: evento.id,
      entidadNombre: evento.titulo,
      accion: 'ACTUALIZACION',
      detalle: 'Se reagendó/editó la sesión en el calendario.',
    });

    res.json({ ...evento, origen: 'axis', editable: true });
  } catch (error) {
    console.error('Error al actualizar el evento del calendario:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el evento del calendario' }) });
  }
});

router.delete('/eventos/:id', requireEditPermission, async (req, res) => {
  try {
    await googleCalendar.eliminarEvento(req.params.id);

    const pool = await getPool();
    await registrarEventoGeneral(pool, req, {
      modulo: 'CALENDARIO',
      entidad: 'EventoCalendario',
      entidadId: req.params.id,
      accion: 'ELIMINACION',
      detalle: 'Se eliminó la sesión del calendario.',
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar el evento del calendario:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el evento del calendario' }) });
  }
});

module.exports = router;
