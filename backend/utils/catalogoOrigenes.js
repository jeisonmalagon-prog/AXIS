// ==========================================================================
// Orígenes del Catálogo de Datos (servidores SQL Server / MariaDB).
//
// Cada persona registra SUS propios orígenes desde la pantalla (no van en el .env) y solo ve y
// administra los que ella creó: el dueño de un origen es quien lo creó (CreadoPorUsername), así no
// hace falta ninguna columna nueva. Cada origen guarda SOLO host, puerto y opciones de conexión, NO
// lleva usuario ni clave: cada persona escribe SUS credenciales (utils/catalogoSesion.js, solo en
// memoria y por sesión) y con ellas se construye su catálogo. Los orígenes que existían antes quedan
// visibles solo para quien los creó. Las columnas Usuario/ClaveCifrada de la tabla quedan sin uso
// (las claves guardadas antes se pueden borrar con limpiarClavesGuardadas).
//   - el usuario de BD de producción no tiene DELETE: "quitar" un origen es un
//     UPDATE (Eliminado = 1);
//   - sin la tabla (script crear_tabla_catalogo_origenes.sql sin ejecutar) el
//     módulo avisa qué script correr; no rompe nada más.
//
// Se recomienda una cuenta de SOLO LECTURA con VIEW DEFINITION (SQL Server) o
// SELECT sobre information_schema (MariaDB). El módulo solo lee metadatos.
// ==========================================================================

const crypto = require('crypto');
const { esErrorDePrivilegios, tablaExiste, errorFaltaEsquema } = require('./esquemaSeguro');

const MOTORES = ['MSSQL', 'MARIADB'];
const PUERTO_DEFECTO = { MSSQL: 1433, MARIADB: 3306 };

// --- Cifrado ---------------------------------------------------------------
function claveCifrado() {
  const secreto = process.env.CATALOGO_SECRET || process.env.JWT_SECRET;
  if (!secreto) throw new Error('Falta CATALOGO_SECRET o JWT_SECRET para cifrar las claves de los orígenes.');
  return crypto.createHash('sha256').update(`axis-catalogo-origenes:${secreto}`).digest();
}

function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv('aes-256-gcm', claveCifrado(), iv);
  const datos = Buffer.concat([cifrador.update(String(texto), 'utf8'), cifrador.final()]);
  return ['v1', iv.toString('base64'), cifrador.getAuthTag().toString('base64'), datos.toString('base64')].join(':');
}

function descifrar(valor) {
  try {
    const [version, iv, tag, datos] = String(valor || '').split(':');
    if (version !== 'v1' || !iv || !tag || !datos) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', claveCifrado(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(datos, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// --- Tabla -------------------------------------------------------------------
let tablaLista = false;
let proximaRevision = 0;
let sinPrivilegios = false;

const SQL_CREAR_TABLA = `
  CREATE TABLE IF NOT EXISTS catalogo_origenes (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    Nombre VARCHAR(100) NOT NULL,
    Motor VARCHAR(10) NOT NULL,
    Host VARCHAR(200) NOT NULL,
    Puerto INT NOT NULL,
    Usuario VARCHAR(128) NOT NULL,
    ClaveCifrada TEXT NULL,
    ClaveFin VARCHAR(4) NULL,
    Cifrado TINYINT(1) NOT NULL DEFAULT 0,
    ConfiarCertificado TINYINT(1) NOT NULL DEFAULT 1,
    BasesIncluidas VARCHAR(1000) NULL,
    Activo TINYINT(1) NOT NULL DEFAULT 1,
    Eliminado TINYINT(1) NOT NULL DEFAULT 0,
    CreadoPorId INT NULL,
    CreadoPorUsername VARCHAR(100) NULL,
    FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FechaActualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_catalogoorigenes_estado (Eliminado, Activo)
  )`;

async function tablaDisponible(pool) {
  if (tablaLista) return true;
  if (Date.now() < proximaRevision) return false;
  if (await tablaExiste(pool, 'catalogo_origenes')) { tablaLista = true; return true; }
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
  return errorFaltaEsquema('tabla catalogo_origenes', 'catalogo_origenes');
}

// Dueño de los orígenes: la persona en cuyo nombre corre la petición (catalogoSesion.ejecutarComo).
// Se pide perezosamente porque catalogoSesion también importa este módulo. Sin dueño no se ve ningún origen.
function duenio(explicito) {
  const u = explicito !== undefined ? explicito : require('./catalogoSesion').usuarioActual();
  return u ? String(u) : null;
}

// --- Validación ----------------------------------------------------------------
const RE_HOST = /^[A-Za-z0-9_.\-\\]{1,200}$/;
const RE_IDENT = /^[A-Za-z0-9_$\- .]{1,128}$/;

// Devuelve { error } o { valor } con los campos normalizados. `parcial`: en
// una edición solo se validan los campos presentes.
function validarOrigen(entrada, { parcial = false } = {}) {
  const e = entrada || {};
  const out = {};
  const requerido = (campo, etiqueta) => (!parcial && (e[campo] === undefined || e[campo] === null || String(e[campo]).trim() === '')
    ? `${etiqueta} es obligatorio.` : null);

  for (const [campo, etiqueta] of [['nombre', 'El nombre'], ['motor', 'El motor'], ['host', 'El servidor']]) {
    const falta = requerido(campo, etiqueta);
    if (falta) return { error: falta };
  }
  if (e.nombre !== undefined) {
    out.nombre = String(e.nombre).trim();
    if (!out.nombre || out.nombre.length > 100) return { error: 'El nombre debe tener entre 1 y 100 caracteres.' };
  }
  if (e.motor !== undefined) {
    out.motor = String(e.motor).trim().toUpperCase();
    if (!MOTORES.includes(out.motor)) return { error: `El motor debe ser uno de: ${MOTORES.join(', ')}.` };
  }
  if (e.host !== undefined) {
    out.host = String(e.host).trim();
    if (!RE_HOST.test(out.host)) return { error: 'El servidor solo puede tener letras, números, punto, guion y «\\» (instancia).' };
  }
  if (e.puerto !== undefined && e.puerto !== null && String(e.puerto).trim() !== '') {
    out.puerto = parseInt(e.puerto, 10);
    if (!Number.isInteger(out.puerto) || out.puerto < 1 || out.puerto > 65535) return { error: 'El puerto debe estar entre 1 y 65535.' };
  }
  // Usuario/clave ya no son parte del origen: se ignoran si llegan (cada persona usa los suyos).
  if (e.cifrado !== undefined) out.cifrado = !!e.cifrado;
  if (e.confiarCertificado !== undefined) out.confiarCertificado = !!e.confiarCertificado;
  if (e.activo !== undefined) out.activo = !!e.activo;
  if (e.basesIncluidas !== undefined) {
    const lista = (Array.isArray(e.basesIncluidas) ? e.basesIncluidas : String(e.basesIncluidas || '').split(/[,;\n]/))
      .map((b) => String(b).trim()).filter(Boolean);
    if (lista.length > 100 || lista.some((b) => !RE_IDENT.test(b))) return { error: 'Revisa la lista de bases: nombres simples separados por coma.' };
    out.basesIncluidas = [...new Set(lista)];
  }
  if (!parcial && out.puerto === undefined && out.motor) out.puerto = PUERTO_DEFECTO[out.motor];
  return { valor: out };
}

// --- Consultas -----------------------------------------------------------------
const COLUMNAS = `Id, Nombre, Motor, Host, Puerto, Usuario, ClaveCifrada, ClaveFin, Cifrado, ConfiarCertificado,
                  BasesIncluidas, Activo, CreadoPorUsername, FechaCreacion, FechaActualizacion`;

// Sin usuario ni clave: se completan con las credenciales de la persona (catalogoSesion.conCredenciales).
function aOrigenInterno(f) {
  return {
    id: String(f.Id), nombre: f.Nombre, motor: f.Motor, host: f.Host, puerto: f.Puerto, cifrado: !!f.Cifrado, confiarCertificado: !!f.ConfiarCertificado,
    basesIncluidas: f.BasesIncluidas ? String(f.BasesIncluidas).split(',').map((s) => s.trim()).filter(Boolean) : [],
    activo: !!f.Activo,
  };
}

// Versión segura para la pantalla (sin clave).
function aOrigenPublico(f) {
  return {
    id: String(f.Id), nombre: f.Nombre, motor: f.Motor, host: f.Host, puerto: f.Puerto,
    // true = quedó una clave guardada de la versión anterior (ya no se usa): el admin puede borrarla.
    claveAntigua: !!f.ClaveCifrada,
    cifrado: !!f.Cifrado, confiarCertificado: !!f.ConfiarCertificado,
    basesIncluidas: f.BasesIncluidas ? String(f.BasesIncluidas).split(',').map((s) => s.trim()).filter(Boolean) : [],
    activo: !!f.Activo, creadoPor: f.CreadoPorUsername, fechaCreacion: f.FechaCreacion, fechaActualizacion: f.FechaActualizacion,
  };
}


// --- Carga masiva: una línea por servidor ------------------------------------------
// Formatos aceptados por línea (el nombre es opcional, tras «|», «;» o tabulación):
//   192.168.118.95,60791        host,puerto (como en SSMS)
//   192.168.118.95:60791        host:puerto
//   SRVSQL01\INSTANCIA          instancia con nombre (necesita SQL Browser; mejor con el puerto)
//   SRVSQL01                    puerto por defecto (1433)
//   192.168.118.95,60791 | Originación
// Las líneas vacías y las que empiezan con # se ignoran.
const MAX_LINEAS_MASIVO = 300;

function parsearListaServidores(texto) {
  const salida = [];
  const vistos = new Set();
  const lineas = String(texto || '').replace(/\r/g, '').split('\n');
  lineas.forEach((cruda, i) => {
    const original = cruda.trim();
    if (!original || original.startsWith('#')) return;
    const [servidorTxt, ...resto] = original.split(/\s*[|;\t]\s*/);
    const nombreTxt = resto.join(' ').trim();
    const item = { linea: i + 1, texto: original, host: '', puerto: PUERTO_DEFECTO.MSSQL, nombre: '', error: null };
    let host = servidorTxt.trim();
    let puerto = null;
    const m = host.match(/^(.+?)[,:]\s*(\d{1,5})$/);
    if (m) { host = m[1].trim(); puerto = parseInt(m[2], 10); }
    if (!RE_HOST.test(host)) item.error = 'El servidor solo puede tener letras, números, punto, guion y «\\» (instancia).';
    else if (puerto !== null && (puerto < 1 || puerto > 65535)) item.error = 'El puerto debe estar entre 1 y 65535.';
    item.host = host;
    if (puerto !== null) item.puerto = puerto;
    item.nombre = (nombreTxt || `${host}${item.puerto !== PUERTO_DEFECTO.MSSQL && !host.includes('\\') ? ` (${item.puerto})` : ''}`).slice(0, 100);
    const clave = `${host.toLowerCase()}|${host.includes('\\') ? '' : item.puerto}`;
    if (!item.error && vistos.has(clave)) item.error = 'Repetido en la lista.';
    vistos.add(clave);
    salida.push(item);
  });
  return salida;
}

// ¿Ya existe un origen con el mismo servidor y puerto? (comparación sin mayúsculas)
function claveServidor(host, puerto) {
  const h = String(host || '').toLowerCase();
  return `${h}|${h.includes('\\') ? '' : puerto}`;
}

async function listarOrigenesAdmin(pool) {
  if (!(await tablaDisponible(pool))) return { tabla: false, origenes: [] };
  const yo = duenio();
  if (!yo) return { tabla: true, origenes: [] };
  const [filas] = await pool.query(`SELECT ${COLUMNAS} FROM catalogo_origenes WHERE Eliminado = 0 AND CreadoPorUsername = ? ORDER BY Nombre`, [yo]);
  return { tabla: true, origenes: filas.map(aOrigenPublico) };
}

// Orígenes activos (sin credenciales): el llamador les agrega las de la persona.
async function origenesParaExtraccion(pool) {
  if (!(await tablaDisponible(pool))) return { tabla: false, origenes: [] };
  const yo = duenio();
  if (!yo) return { tabla: true, origenes: [] };
  const [filas] = await pool.query(`SELECT ${COLUMNAS} FROM catalogo_origenes WHERE Eliminado = 0 AND Activo = 1 AND CreadoPorUsername = ? ORDER BY Nombre`, [yo]);
  return { tabla: true, origenes: filas.map(aOrigenInterno) };
}

async function obtenerOrigenInterno(pool, id) {
  if (!(await tablaDisponible(pool))) return null;
  const yo = duenio();
  if (!yo) return null;
  const [filas] = await pool.query(`SELECT ${COLUMNAS} FROM catalogo_origenes WHERE Id = ? AND Eliminado = 0 AND CreadoPorUsername = ? LIMIT 1`, [id, yo]);
  return filas.length ? aOrigenInterno(filas[0]) : null;
}

async function obtenerOrigenPublico(pool, id) {
  if (!(await tablaDisponible(pool))) throw errorSinTabla();
  const yo = duenio();
  if (!yo) return null;
  const [filas] = await pool.query(`SELECT ${COLUMNAS} FROM catalogo_origenes WHERE Id = ? AND Eliminado = 0 AND CreadoPorUsername = ? LIMIT 1`, [id, yo]);
  return filas.length ? aOrigenPublico(filas[0]) : null;
}

async function crearOrigen(pool, req, v) {
  if (!(await tablaDisponible(pool))) throw errorSinTabla();
  if (!req.user?.username) throw Object.assign(new Error('No se pudo identificar tu sesión.'), { status: 400 });
  const [r] = await pool.query(
    `INSERT INTO catalogo_origenes
       (Nombre, Motor, Host, Puerto, Usuario, ClaveCifrada, ClaveFin, Cifrado, ConfiarCertificado, BasesIncluidas, Activo, CreadoPorId, CreadoPorUsername)
     VALUES (?, ?, ?, ?, '', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    [v.nombre, v.motor, v.host, v.puerto, v.cifrado ? 1 : 0,
      v.confiarCertificado === false ? 0 : 1, (v.basesIncluidas || []).join(',') || null, v.activo === false ? 0 : 1,
      req.user?.id ?? null, req.user?.username ?? null]
  );
  return String(r.insertId);
}

async function actualizarOrigen(pool, id, v) {
  if (!(await tablaDisponible(pool))) throw errorSinTabla();
  const sets = [];
  const valores = [];
  const poner = (col, val) => { sets.push(`${col} = ?`); valores.push(val); };
  if (v.nombre !== undefined) poner('Nombre', v.nombre);
  if (v.motor !== undefined) poner('Motor', v.motor);
  if (v.host !== undefined) poner('Host', v.host);
  if (v.puerto !== undefined) poner('Puerto', v.puerto);
  if (v.cifrado !== undefined) poner('Cifrado', v.cifrado ? 1 : 0);
  if (v.confiarCertificado !== undefined) poner('ConfiarCertificado', v.confiarCertificado ? 1 : 0);
  if (v.basesIncluidas !== undefined) poner('BasesIncluidas', v.basesIncluidas.join(',') || null);
  if (v.activo !== undefined) poner('Activo', v.activo ? 1 : 0);
  if (!sets.length) return;
  await pool.query(`UPDATE catalogo_origenes SET ${sets.join(', ')} WHERE Id = ? AND Eliminado = 0 AND CreadoPorUsername = ?`, [...valores, id, duenio()]);
}

// Borra las claves que quedaron guardadas de la versión anterior (ya no se usan). Devuelve cuántos orígenes tenían clave.
async function limpiarClavesGuardadas(pool) {
  if (!(await tablaDisponible(pool))) throw errorSinTabla();
  const [r] = await pool.query("UPDATE catalogo_origenes SET ClaveCifrada = NULL, ClaveFin = NULL, Usuario = '' WHERE ClaveCifrada IS NOT NULL OR ClaveFin IS NOT NULL OR Usuario <> ''");
  return r.affectedRows || 0;
}

// "Quitar": sin DELETE en producción. Se marca el origen como eliminado.
async function quitarOrigen(pool, id) {
  if (!(await tablaDisponible(pool))) throw errorSinTabla();
  await pool.query(
    'UPDATE catalogo_origenes SET Eliminado = 1, Activo = 0, ClaveCifrada = NULL, ClaveFin = NULL WHERE Id = ? AND Eliminado = 0 AND CreadoPorUsername = ?',
    [id, duenio()]
  );
}

module.exports = {
  MOTORES, PUERTO_DEFECTO, MAX_LINEAS_MASIVO, cifrar, descifrar, validarOrigen, parsearListaServidores, claveServidor,
  listarOrigenesAdmin, origenesParaExtraccion, obtenerOrigenInterno, obtenerOrigenPublico,
  crearOrigen, actualizarOrigen, quitarOrigen, limpiarClavesGuardadas, tablaDisponible,
};
