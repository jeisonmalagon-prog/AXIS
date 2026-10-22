// ============================================================================
// Integración con Google Calendar -- UNA cuenta de servicio compartida por
// todo el equipo (no OAuth por usuario): se crea una vez en Google Cloud, se
// comparte el calendario del equipo con su correo (@...iam.gserviceaccount.com)
// y desde entonces el backend lee/escribe ese calendario sin que cada
// usuario tenga que autorizar nada. Ver instrucciones de configuración
// aparte (Claude outputs/INSTRUCCIONES_GOOGLE_CALENDAR.md).
//
// La MISMA cuenta de servicio se reutiliza también para leer, de solo
// lectura, los calendarios REALES de cada persona en CalendariosEquipo (cada
// quien comparte su calendario aparte, con permiso de solo "Ver" -- no hace
// falta una cuenta de servicio por persona ni OAuth individual). Por eso
// todas las funciones de acá aceptan opcionalmente qué calendario consultar
// en vez de asumir siempre el de "AXIS" -- ver "calendarioId" en
// listarEventos().
//
// Credenciales por variables de entorno (mismo criterio que el resto de
// integraciones de este proyecto -- Azure DevOps, F5, Portainer -- ver
// backend/.env): GOOGLE_CALENDAR_CLIENT_EMAIL, GOOGLE_CALENDAR_PRIVATE_KEY,
// GOOGLE_CALENDAR_ID. Nunca se guarda un archivo .json de credenciales
// dentro del repo/imagen Docker (backend/Dockerfile hace `COPY . .`, así que
// cualquier archivo ahí quedaría horneado en la imagen).
// ============================================================================

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function credencialesConfiguradas() {
  return !!(
    process.env.GOOGLE_CALENDAR_CLIENT_EMAIL &&
    process.env.GOOGLE_CALENDAR_PRIVATE_KEY &&
    process.env.GOOGLE_CALENDAR_ID
  );
}

let clienteCalendar = null;

function obtenerClienteCalendar() {
  if (!credencialesConfiguradas()) {
    throw new Error(
      'El calendario de Google todavía no está configurado. Faltan las variables de entorno ' +
      'GOOGLE_CALENDAR_CLIENT_EMAIL, GOOGLE_CALENDAR_PRIVATE_KEY y/o GOOGLE_CALENDAR_ID.'
    );
  }
  if (clienteCalendar) return clienteCalendar;

  // El .env guarda la llave privada con los saltos de línea escapados como
  // "\n" literales (un PEM multilínea no cabe tal cual en una sola línea de
  // .env) -- hay que des-escaparlos antes de dárselos a la librería.
  const privateKey = process.env.GOOGLE_CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CALENDAR_CLIENT_EMAIL,
    key: privateKey,
    scopes: SCOPES,
  });

  clienteCalendar = google.calendar({ version: 'v3', auth });
  return clienteCalendar;
}

function idCalendario() {
  return process.env.GOOGLE_CALENDAR_ID;
}

// Traduce un evento crudo de la API de Google al shape que espera el
// frontend -- nunca se expone el objeto completo de Google (trae mucho
// ruido: etag, organizer, reminders, etc. que no hacen falta acá).
function mapearEvento(ev) {
  const esTodoElDia = !ev.start?.dateTime;
  return {
    id: ev.id,
    titulo: ev.summary || '(Sin título)',
    descripcion: ev.description || null,
    inicio: ev.start?.dateTime || ev.start?.date || null,
    fin: ev.end?.dateTime || ev.end?.date || null,
    todoElDia: esTodoElDia,
    ubicacion: ev.location || null,
    enlaceGoogle: ev.htmlLink || null,
    estado: ev.status || null, // "confirmed" | "cancelled" | "tentative"
    asignados: parsearAsignados(ev),
  };
}

// Quién del equipo está asignado a esta sesión -- se guarda en
// extendedProperties.private (metadata invisible en la UI de Google, no
// manda invitaciones ni aparece como "invitado") en vez de usar attendees
// reales, porque estos eventos los crea siempre la cuenta de servicio y no
// queremos que Google le mande un correo de invitación a cada persona cada
// vez que se asigna o reasigna el equipo. Así funciona igual para eventos
// creados desde la app como para los que alguien ya había creado a mano en
// Google Calendar -- basta con editarlos una vez desde acá para asignarles
// equipo.
function parsearAsignados(ev) {
  const crudo = ev.extendedProperties?.private?.asignados;
  if (!crudo) return [];
  try {
    const lista = JSON.parse(crudo);
    return Array.isArray(lista) ? lista.map(Number).filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

// "calendarioId" es opcional -- por defecto consulta el calendario
// compartido "AXIS" (idCalendario()), pero se le puede pasar cualquier otro
// ID de calendario (normalmente el correo de una persona) para leer, de
// solo lectura, su calendario real -- ver CalendariosEquipo / GET /eventos
// en routes/calendario.js, que llama esto una vez por cada correo agregado
// además de la llamada de siempre para el calendario "AXIS".
async function listarEventos({ desde, hasta, maxResultados = 250, calendarioId }) {
  const calendar = obtenerClienteCalendar();
  const { data } = await calendar.events.list({
    calendarId: calendarioId || idCalendario(),
    timeMin: desde.toISOString(),
    timeMax: hasta.toISOString(),
    singleEvents: true, // expande eventos recurrentes en instancias individuales
    orderBy: 'startTime',
    maxResults: maxResultados,
  });
  return (data.items || []).map(mapearEvento);
}

async function obtenerEvento(eventId) {
  const calendar = obtenerClienteCalendar();
  const { data } = await calendar.events.get({ calendarId: idCalendario(), eventId });
  return mapearEvento(data);
}

async function crearEvento({ titulo, descripcion, inicio, fin, todoElDia, asignados }) {
  const calendar = obtenerClienteCalendar();
  const recurso = {
    summary: titulo,
    description: descripcion || undefined,
    start: todoElDia ? { date: inicio } : { dateTime: inicio },
    end: todoElDia ? { date: fin } : { dateTime: fin },
    extendedProperties: { private: { asignados: JSON.stringify(Array.isArray(asignados) ? asignados : []) } },
  };
  const { data } = await calendar.events.insert({ calendarId: idCalendario(), requestBody: recurso });
  return mapearEvento(data);
}

async function actualizarEvento(eventId, cambios) {
  const calendar = obtenerClienteCalendar();
  const recurso = {};
  if (cambios.titulo !== undefined) recurso.summary = cambios.titulo;
  if (cambios.descripcion !== undefined) recurso.description = cambios.descripcion;
  if (cambios.inicio !== undefined) {
    recurso.start = cambios.todoElDia ? { date: cambios.inicio } : { dateTime: cambios.inicio };
  }
  if (cambios.fin !== undefined) {
    recurso.end = cambios.todoElDia ? { date: cambios.fin } : { dateTime: cambios.fin };
  }
  if (cambios.asignados !== undefined) {
    // events.patch reemplaza el mapa "private" completo (no lo mezcla campo
    // por campo): se lee el actual y se conservan las demás propiedades
    // (p. ej. "tareaId" en los eventos que vienen de una tarea).
    const { data: actual } = await calendar.events.get({ calendarId: idCalendario(), eventId });
    recurso.extendedProperties = {
      private: {
        ...(actual.extendedProperties?.private || {}),
        asignados: JSON.stringify(Array.isArray(cambios.asignados) ? cambios.asignados : []),
      },
    };
  }
  const { data } = await calendar.events.patch({ calendarId: idCalendario(), eventId, requestBody: recurso });
  return mapearEvento(data);
}

async function eliminarEvento(eventId) {
  const calendar = obtenerClienteCalendar();
  await calendar.events.delete({ calendarId: idCalendario(), eventId });
}

module.exports = {
  obtenerClienteCalendar,
  idCalendario,
  mapearEvento,
  credencialesConfiguradas,
  listarEventos,
  obtenerEvento,
  crearEvento,
  actualizarEvento,
  eliminarEvento,
};
