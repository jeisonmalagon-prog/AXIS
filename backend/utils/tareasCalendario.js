// Sincroniza las tareas (Gestor de Tareas) con el calendario compartido AXIS de
// Google. Cada tarea CON fecha límite genera un evento ese día, de hora de inicio
// a hora de entrega (por defecto 09:00 - 10:00: una hora antes de la entrega). Los
// asignados de la tarea quedan marcados en el evento (extendedProperties.private
// .asignados, el mismo mecanismo de las sesiones agendadas), así cada usuario la
// ve en su vista del Calendario. El evento se identifica por la propiedad privada
// "tareaId", por eso no hace falta guardar el id de Google en la base de datos.
//
// Un fallo del calendario NUNCA debe impedir guardar la tarea: todas las
// funciones devuelven { estado, error? } en vez de lanzar.

const googleCalendar = require('./googleCalendar');

const HORA_INICIO_DEFECTO = '09:00';
const HORA_FIN_DEFECTO = '10:00';

function zonaHoraria() {
  return process.env.CALENDARIO_ZONA_HORARIA || 'America/Bogota';
}

// "9:5", "09:00", "09:00:00" -> "09:00" (o null si no es una hora válida).
function normalizarHora(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const m = String(valor).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Fecha de la tarea como "YYYY-MM-DD", venga como texto, ISO o Date de MySQL.
function fechaComoTexto(valor) {
  if (!valor) return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${valor.getFullYear()}-${p(valor.getMonth() + 1)}-${p(valor.getDate())}`;
  }
  const m = String(valor).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

const ETIQUETA_ESTADO = { PENDIENTE: 'Pendiente', EN_PROGRESO: 'En progreso', COMPLETADA: 'Completada', CANCELADA: 'Cancelada' };

// tarea: { Id, Titulo, Descripcion, Estado, Prioridad, FechaLimite, HoraInicio, HoraFin,
//          CreadoPorNombre, asignados: [{ id, nombreCompleto }] }
function construirEvento(tarea) {
  const fecha = fechaComoTexto(tarea.FechaLimite);
  const horaInicio = normalizarHora(tarea.HoraInicio) || HORA_INICIO_DEFECTO;
  const horaFin = normalizarHora(tarea.HoraFin) || HORA_FIN_DEFECTO;
  const prefijo = tarea.Estado === 'COMPLETADA' ? '[Completada] ' : '';
  const lineas = [];
  if (tarea.Descripcion) lineas.push(tarea.Descripcion, '');
  lineas.push(
    `Asignada a: ${(tarea.asignados || []).map((a) => a.nombreCompleto).join(', ') || '—'}`,
    `Creada por: ${tarea.CreadoPorNombre || '—'}`,
    `Prioridad: ${tarea.Prioridad}`,
    `Estado: ${ETIQUETA_ESTADO[tarea.Estado] || tarea.Estado}`,
    '',
    'Evento generado automáticamente desde el Gestor de Tareas de AXIS.'
  );
  const tz = zonaHoraria();
  return {
    summary: `${prefijo}Tarea: ${tarea.Titulo}`,
    description: lineas.join('\n'),
    start: { dateTime: `${fecha}T${horaInicio}:00`, timeZone: tz },
    end: { dateTime: `${fecha}T${horaFin}:00`, timeZone: tz },
    extendedProperties: {
      private: {
        tareaId: String(tarea.Id),
        asignados: JSON.stringify((tarea.asignados || []).map((a) => a.id)),
      },
    },
  };
}

async function buscarEventoDeTarea(calendar, tareaId) {
  const { data } = await calendar.events.list({
    calendarId: googleCalendar.idCalendario(),
    privateExtendedProperty: `tareaId=${tareaId}`,
    showDeleted: false,
    maxResults: 10,
  });
  return (data.items || []).filter((e) => e.status !== 'cancelled');
}

// Crea, actualiza o elimina el evento según el estado actual de la tarea.
async function sincronizarTarea(tarea) {
  if (!googleCalendar.credencialesConfiguradas()) return { estado: 'omitido', motivo: 'El calendario de Google no está configurado.' };
  try {
    const calendar = googleCalendar.obtenerClienteCalendar();
    const existentes = await buscarEventoDeTarea(calendar, tarea.Id);
    const debeTenerEvento = !!fechaComoTexto(tarea.FechaLimite) && tarea.Estado !== 'CANCELADA';

    if (!debeTenerEvento) {
      for (const e of existentes) await calendar.events.delete({ calendarId: googleCalendar.idCalendario(), eventId: e.id });
      return { estado: existentes.length ? 'eliminado' : 'sin_evento' };
    }

    // Sin hora guardada para la tarea (p. ej. tareas anteriores o columnas aún no
    // creadas): se conserva la hora que ya tiene el evento en vez de pisarla.
    if (existentes.length && (!normalizarHora(tarea.HoraInicio) || !normalizarHora(tarea.HoraFin))) {
      const previo = existentes[0];
      tarea = {
        ...tarea,
        HoraInicio: normalizarHora(tarea.HoraInicio) || previo.start?.dateTime?.slice(11, 16) || null,
        HoraFin: normalizarHora(tarea.HoraFin) || previo.end?.dateTime?.slice(11, 16) || null,
      };
    }

    const recurso = construirEvento(tarea);
    if (existentes.length) {
      const [principal, ...sobrantes] = existentes;
      await calendar.events.patch({ calendarId: googleCalendar.idCalendario(), eventId: principal.id, requestBody: recurso });
      for (const e of sobrantes) await calendar.events.delete({ calendarId: googleCalendar.idCalendario(), eventId: e.id });
      return { estado: 'actualizado', eventoId: principal.id };
    }
    const { data } = await calendar.events.insert({ calendarId: googleCalendar.idCalendario(), requestBody: recurso });
    return { estado: 'creado', eventoId: data.id };
  } catch (error) {
    console.error(`No se pudo sincronizar la tarea ${tarea.Id} con el calendario:`, error);
    return { estado: 'error', error: 'La tarea se guardó, pero no se pudo agendar en el calendario de Google.' };
  }
}

async function eliminarEventoDeTarea(tareaId) {
  if (!googleCalendar.credencialesConfiguradas()) return { estado: 'omitido' };
  try {
    const calendar = googleCalendar.obtenerClienteCalendar();
    const existentes = await buscarEventoDeTarea(calendar, tareaId);
    for (const e of existentes) await calendar.events.delete({ calendarId: googleCalendar.idCalendario(), eventId: e.id });
    return { estado: existentes.length ? 'eliminado' : 'sin_evento' };
  } catch (error) {
    console.error(`No se pudo quitar del calendario el evento de la tarea ${tareaId}:`, error);
    return { estado: 'error', error: 'La tarea se eliminó, pero no se pudo quitar su evento del calendario de Google.' };
  }
}

module.exports = {
  HORA_INICIO_DEFECTO,
  HORA_FIN_DEFECTO,
  normalizarHora,
  fechaComoTexto,
  construirEvento,
  sincronizarTarea,
  eliminarEventoDeTarea,
};
