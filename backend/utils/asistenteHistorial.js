// Historial de conversaciones del Asistente IA -- guarda cada mensaje
// (pregunta del usuario y respuesta del asistente), agrupado por
// ConversacionId para poder tener VARIAS conversaciones separadas por
// usuario (como una lista de chats), no un solo hilo infinito.
//
// Mismo patron que ya usa este proyecto en utils/auditoriaGeneral.js: la
// tabla se garantiza en tiempo de ejecucion con CREATE TABLE IF NOT EXISTS.
// Si la cuenta de BD no tiene permiso CREATE (errno 1142/1143), se asume
// que alguien con mas privilegios ya la creo antes y se sigue normal -- si
// nadie la ha creado todavia, guardarMensaje() simplemente no persiste nada
// (el chat sigue funcionando, solo que sin historial) hasta que se cree la
// tabla una vez.

let tablaHistorialLista = false;

function esErrorDePermisosDdl(err) {
  return err && (err.errno === 1142 || err.errno === 1143);
}

async function garantizarTablaAsistenteHistorial(pool) {
  if (tablaHistorialLista) return;
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS AsistenteHistorial (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      UsuarioId INT NOT NULL,
      ConversacionId BIGINT NOT NULL,
      Rol VARCHAR(20) NOT NULL,
      Mensaje TEXT NOT NULL,
      FechaMensaje DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_asistentehistorial_usuario_conv (UsuarioId, ConversacionId, Id),
      CONSTRAINT fk_asistentehistorial_usuario FOREIGN KEY (UsuarioId) REFERENCES usuarios(id) ON DELETE CASCADE
    )
    `);
  } catch (err) {
    if (!esErrorDePermisosDdl(err)) throw err;
    console.warn('No se pudo verificar/crear la tabla AsistenteHistorial (el usuario de BD no tiene permiso CREATE); se asume que ya existe o que aun no se ha creado:', err.sqlMessage || err.message);
  }

  // Auto-reparacion: la tabla ya existia de una version anterior de este
  // archivo (sin la columna ConversacionId) -- CREATE TABLE IF NOT EXISTS de
  // arriba NO le agrega columnas nuevas a una tabla que ya existe, solo la
  // crea si no existe en absoluto. Sin esto, cada INSERT/SELECT que use
  // ConversacionId falla en silencio (columna desconocida) y el historial
  // queda "guardando" sin guardar nada de verdad. ADD COLUMN IF NOT EXISTS
  // es una extension de MariaDB (10.0.2+): si la columna ya existe, no hace
  // nada; si la cuenta de BD no tiene permiso ALTER, se captura igual que
  // arriba y se sigue sin romper el chat.
  try {
    await pool.query(`
      ALTER TABLE AsistenteHistorial
      ADD COLUMN IF NOT EXISTS ConversacionId BIGINT NOT NULL DEFAULT 0 AFTER UsuarioId
    `);
  } catch (err) {
    if (!esErrorDePermisosDdl(err)) throw err;
    console.warn('No se pudo agregar la columna ConversacionId a AsistenteHistorial (el usuario de BD no tiene permiso ALTER); el historial de conversaciones no funcionara hasta que alguien con mas privilegios la agregue:', err.sqlMessage || err.message);
  }

  tablaHistorialLista = true;
}

// Cuantos mensajes se devuelven al abrir UNA conversacion puntual.
const MAX_MENSAJES_POR_CONVERSACION = 200;
// Cuantas conversaciones distintas se listan en el panel lateral.
const MAX_CONVERSACIONES_LISTADAS = 50;
// Cuantos caracteres del primer mensaje se usan como "titulo" de la
// conversacion en el listado (igual que hacen ChatGPT/Claude).
const LARGO_TITULO = 60;

// Genera un id de conversacion nuevo. No hace falta una tabla/secuencia
// aparte: un timestamp en milisegundos es unico de sobra para el volumen de
// uso de este asistente (una persona no abre 2 conversaciones nuevas en el
// mismo milisegundo).
function nuevoIdConversacion() {
  return Date.now();
}

async function guardarMensaje(pool, usuarioId, conversacionId, rol, mensaje) {
  try {
    await garantizarTablaAsistenteHistorial(pool);
    await pool.query(
      'INSERT INTO AsistenteHistorial (UsuarioId, ConversacionId, Rol, Mensaje) VALUES (?, ?, ?, ?)',
      [usuarioId, conversacionId, rol, mensaje]
    );
  } catch (err) {
    // Nunca se debe romper el chat por no poder guardar el historial (ej. la
    // tabla todavia no existe en este ambiente) -- solo se avisa en el log.
    console.warn('Aviso: no se pudo guardar un mensaje del historial del asistente:', err.message);
  }
}

// Lista de conversaciones del usuario (para el panel lateral tipo "chats"),
// con un titulo derivado de su primer mensaje y la fecha del mas reciente.
// Se arma en JS a partir de todas las filas (en vez de con funciones de
// ventana SQL) para no depender de una version puntual de MariaDB.
async function obtenerConversaciones(pool, usuarioId) {
  try {
    await garantizarTablaAsistenteHistorial(pool);
    const [filas] = await pool.query(
      `SELECT ConversacionId, Rol, Mensaje, FechaMensaje
       FROM AsistenteHistorial
       WHERE UsuarioId = ?
       ORDER BY Id ASC`,
      [usuarioId]
    );

    const conversaciones = new Map();
    for (const fila of filas) {
      const id = fila.ConversacionId;
      if (!conversaciones.has(id)) {
        conversaciones.set(id, { conversacionId: id, titulo: null, fechaUltimoMensaje: fila.FechaMensaje });
      }
      const conv = conversaciones.get(id);
      if (!conv.titulo && fila.Rol === 'user') {
        conv.titulo = fila.Mensaje.length > LARGO_TITULO
          ? fila.Mensaje.slice(0, LARGO_TITULO) + '…'
          : fila.Mensaje;
      }
      conv.fechaUltimoMensaje = fila.FechaMensaje; // las filas vienen en orden ASC, la ultima que pise gana
    }

    return [...conversaciones.values()]
      .filter((c) => c.titulo) // descarta conversaciones sin ningun mensaje de usuario (no deberia pasar, por seguridad)
      .reverse() // la mas reciente primero
      .slice(0, MAX_CONVERSACIONES_LISTADAS);
  } catch (err) {
    console.warn('Aviso: no se pudo listar las conversaciones del asistente:', err.message);
    return [];
  }
}

async function obtenerHistorialConversacion(pool, usuarioId, conversacionId) {
  try {
    await garantizarTablaAsistenteHistorial(pool);
    const [filas] = await pool.query(
      `SELECT Rol, Mensaje, FechaMensaje FROM AsistenteHistorial
       WHERE UsuarioId = ? AND ConversacionId = ?
       ORDER BY Id ASC
       LIMIT ${MAX_MENSAJES_POR_CONVERSACION}`,
      [usuarioId, conversacionId]
    );
    return filas;
  } catch (err) {
    console.warn('Aviso: no se pudo leer una conversacion del asistente:', err.message);
    return [];
  }
}

module.exports = {
  nuevoIdConversacion,
  guardarMensaje,
  obtenerConversaciones,
  obtenerHistorialConversacion
};
