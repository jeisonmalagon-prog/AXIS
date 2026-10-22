// Cuentas (API keys) de n8n.
//
// n8n entrega por su API pública solo los flujos que ve el usuario dueño de la
// API key. Para que AXIS muestre también los flujos de OTROS usuarios de n8n,
// el ADMIN_POD registra aquí la API key de cada uno (Orquestador n8n > "API
// keys"). El módulo junta los flujos de todas las cuentas activas.
//
// - La key de siempre (la del servidor) sigue funcionando como cuenta
//   "principal": no vive en la base de datos y no se puede editar desde la UI.
// - Las demás se guardan CIFRADAS (AES-256-GCM) en la tabla n8n_cuentas. Nunca
//   se devuelven al navegador: solo se muestran los últimos 4 caracteres.
// - El usuario de BD de producción no tiene DELETE: "quitar" una cuenta es un
//   UPDATE (Eliminada = 1 y se borra la key guardada).
// - Sin la tabla (script no ejecutado) todo sigue igual que antes: solo la
//   cuenta principal.

const crypto = require('crypto');
const { esErrorDePrivilegios, tablaExiste, errorFaltaEsquema } = require('./esquemaSeguro');

const ID_PRINCIPAL = 'principal';
const NOMBRE_PRINCIPAL = 'Principal (servidor)';

// --- Cifrado ---------------------------------------------------------------

// Clave de cifrado: N8N_KEYS_SECRET si existe; si no, se deriva de JWT_SECRET
// (que el backend ya exige). Si se rota ese secreto, las keys guardadas dejan
// de poder leerse y hay que volver a ingresarlas (se avisa en pantalla).
function claveCifrado() {
  const secreto = process.env.N8N_KEYS_SECRET || process.env.JWT_SECRET;
  if (!secreto) throw new Error('Falta N8N_KEYS_SECRET o JWT_SECRET para cifrar las API keys de n8n.');
  return crypto.createHash('sha256').update(`axis-n8n-keys:${secreto}`).digest();
}

function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv('aes-256-gcm', claveCifrado(), iv);
  const datos = Buffer.concat([cifrador.update(String(texto), 'utf8'), cifrador.final()]);
  return ['v1', iv.toString('base64'), cifrador.getAuthTag().toString('base64'), datos.toString('base64')].join(':');
}

// Devuelve null si no se puede descifrar (secreto distinto, dato dañado).
function descifrar(valor) {
  try {
    const [version, iv, tag, datos] = String(valor || '').split(':');
    if (version !== 'v1' || !iv || !tag || !datos) return null;
    const descifrador = crypto.createDecipheriv('aes-256-gcm', claveCifrado(), Buffer.from(iv, 'base64'));
    descifrador.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([descifrador.update(Buffer.from(datos, 'base64')), descifrador.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// --- Tabla -------------------------------------------------------------------

let tablaLista = false;
let proximaRevision = 0;
let sinPrivilegios = false;

const SQL_CREAR_TABLA = `
  CREATE TABLE IF NOT EXISTS n8n_cuentas (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    Nombre VARCHAR(100) NOT NULL,
    ApiKeyCifrada TEXT NULL,
    ApiKeyFin VARCHAR(8) NULL,
    Activo TINYINT(1) NOT NULL DEFAULT 1,
    Eliminada TINYINT(1) NOT NULL DEFAULT 0,
    CreadoPorId INT NULL,
    CreadoPorUsername VARCHAR(100) NULL,
    FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FechaActualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_n8ncuentas_estado (Eliminada, Activo)
  )`;

// true si la tabla existe. Con permiso de DDL la crea; sin él solo consulta
// (information_schema pide SELECT) y reintenta cada minuto por si ya corrieron
// el script.
async function tablaDisponible(pool) {
  if (tablaLista) return true;
  if (Date.now() < proximaRevision) return false;
  if (await tablaExiste(pool, 'n8n_cuentas')) { tablaLista = true; return true; }
  if (!sinPrivilegios) {
    try {
      await pool.query(SQL_CREAR_TABLA);
      tablaLista = true;
      return true;
    } catch (err) {
      if (!esErrorDePrivilegios(err)) throw err;
      sinPrivilegios = true;
    }
  }
  proximaRevision = Date.now() + 60000;
  return false;
}

function errorSinTabla() {
  return errorFaltaEsquema('tabla n8n_cuentas', 'n8n_cuentas');
}

// --- Consultas -----------------------------------------------------------------

// Cuentas "de la base" para la pantalla de administración (sin la key).
async function listarCuentasAdmin(pool) {
  if (!(await tablaDisponible(pool))) return { tabla: false, cuentas: [] };
  const [filas] = await pool.query(
    `SELECT Id, Nombre, ApiKeyCifrada, ApiKeyFin, Activo, CreadoPorUsername, FechaCreacion, FechaActualizacion
       FROM n8n_cuentas WHERE Eliminada = 0 ORDER BY Nombre`
  );
  return {
    tabla: true,
    cuentas: filas.map((f) => ({
      id: String(f.Id),
      nombre: f.Nombre,
      apiKeyFin: f.ApiKeyFin,
      activo: !!f.Activo,
      // false = la key guardada ya no se puede descifrar (cambió el secreto del servidor).
      legible: descifrar(f.ApiKeyCifrada) !== null,
      creadoPor: f.CreadoPorUsername,
      fechaCreacion: f.FechaCreacion,
      fechaActualizacion: f.FechaActualizacion,
    })),
  };
}

// Cuentas con las que se consulta n8n: la principal + las activas de la base.
// Cada una trae la key en claro, SOLO para uso interno del backend.
async function cuentasParaConsulta(pool, apiKeyPrincipal) {
  const cuentas = [{ id: ID_PRINCIPAL, nombre: NOMBRE_PRINCIPAL, apiKey: apiKeyPrincipal, sistema: true }];
  try {
    if (!(await tablaDisponible(pool))) return { cuentas, avisos: [] };
    const [filas] = await pool.query(
      'SELECT Id, Nombre, ApiKeyCifrada FROM n8n_cuentas WHERE Eliminada = 0 AND Activo = 1 ORDER BY Nombre'
    );
    const avisos = [];
    for (const f of filas) {
      const apiKey = descifrar(f.ApiKeyCifrada);
      if (!apiKey) {
        avisos.push({ id: String(f.Id), nombre: f.Nombre, error: 'No se pudo leer la API key guardada: vuelve a ingresarla.' });
        continue;
      }
      cuentas.push({ id: String(f.Id), nombre: f.Nombre, apiKey, sistema: false });
    }
    return { cuentas, avisos };
  } catch (err) {
    console.error('No se pudieron leer las cuentas de n8n; se usa solo la principal:', err.message);
    return { cuentas, avisos: [] };
  }
}

async function obtenerCuenta(pool, id, apiKeyPrincipal) {
  if (!id || id === ID_PRINCIPAL) return { id: ID_PRINCIPAL, nombre: NOMBRE_PRINCIPAL, apiKey: apiKeyPrincipal, sistema: true };
  if (!(await tablaDisponible(pool))) return null;
  const [filas] = await pool.query(
    'SELECT Id, Nombre, ApiKeyCifrada, Activo FROM n8n_cuentas WHERE Id = ? AND Eliminada = 0 LIMIT 1',
    [id]
  );
  if (!filas.length) return null;
  const apiKey = descifrar(filas[0].ApiKeyCifrada);
  if (!apiKey) return null;
  return { id: String(filas[0].Id), nombre: filas[0].Nombre, apiKey, activo: !!filas[0].Activo, sistema: false };
}

async function crearCuenta(pool, req, { nombre, apiKey }) {
  if (!(await tablaDisponible(pool))) throw errorSinTabla();
  const [r] = await pool.query(
    `INSERT INTO n8n_cuentas (Nombre, ApiKeyCifrada, ApiKeyFin, CreadoPorId, CreadoPorUsername) VALUES (?, ?, ?, ?, ?)`,
    [nombre, cifrar(apiKey), apiKey.slice(-4), req.user?.id ?? null, req.user?.username ?? null]
  );
  return String(r.insertId);
}

async function filaCuenta(pool, id) {
  if (!(await tablaDisponible(pool))) throw errorSinTabla();
  const [filas] = await pool.query(
    'SELECT Id, Nombre, ApiKeyFin, Activo FROM n8n_cuentas WHERE Id = ? AND Eliminada = 0 LIMIT 1',
    [id]
  );
  return filas[0] || null;
}

async function actualizarCuenta(pool, id, { nombre, apiKey, activo }) {
  const sets = [];
  const valores = [];
  if (nombre !== undefined) { sets.push('Nombre = ?'); valores.push(nombre); }
  if (apiKey !== undefined) { sets.push('ApiKeyCifrada = ?', 'ApiKeyFin = ?'); valores.push(cifrar(apiKey), apiKey.slice(-4)); }
  if (activo !== undefined) { sets.push('Activo = ?'); valores.push(activo ? 1 : 0); }
  if (!sets.length) return;
  await pool.query(`UPDATE n8n_cuentas SET ${sets.join(', ')} WHERE Id = ? AND Eliminada = 0`, [...valores, id]);
}

// "Quitar": sin DELETE en producción. Se marca y se borra la key guardada.
async function quitarCuenta(pool, id) {
  await pool.query(
    'UPDATE n8n_cuentas SET Eliminada = 1, Activo = 0, ApiKeyCifrada = NULL, ApiKeyFin = NULL WHERE Id = ? AND Eliminada = 0',
    [id]
  );
}

module.exports = {
  ID_PRINCIPAL,
  NOMBRE_PRINCIPAL,
  cifrar,
  descifrar,
  listarCuentasAdmin,
  cuentasParaConsulta,
  obtenerCuenta,
  crearCuenta,
  filaCuenta,
  actualizarCuenta,
  quitarCuenta,
};
