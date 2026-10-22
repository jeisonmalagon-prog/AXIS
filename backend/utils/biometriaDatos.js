// Persistencia del módulo Biometría de firmas en la BD de AXIS (MariaDB):
// configuración (parámetros, sin credenciales) e historial de corridas (solo totales).
// El RESULTADO de cada consulta (con los datos de clientes) NO se guarda aquí: es personal de
// quien consulta y vive solo en la memoria de su sesión (ver biometriaServicio.js).
//
// Igual que el resto del proyecto, el usuario de BD de producción puede no
// tener DDL: se consulta information_schema, solo se crea lo que falte y, sin
// privilegios, el módulo avisa qué script ejecutar (crear_tablas_biometria.sql).
// Nunca se hace DELETE: el último resultado se REEMPLAZA (UPDATE) y el
// historial solo crece con filas pequeñas (totales, sin datos de clientes).

const { tablaExiste, esErrorDePrivilegios } = require('./esquemaSeguro');
const { IDENT } = require('./biometriaConsulta');
const { getPool } = require('../db');

const TABLAS = {
  biometria_config: `
    CREATE TABLE IF NOT EXISTS biometria_config (
      Id TINYINT NOT NULL PRIMARY KEY,
      ConfigJson TEXT NULL,
      ActualizadoPor VARCHAR(100) NULL,
      FechaActualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  biometria_estado: `
    CREATE TABLE IF NOT EXISTS biometria_estado (
      Id TINYINT NOT NULL PRIMARY KEY,
      SnapshotJson MEDIUMTEXT NULL,
      FechaCorrida DATETIME NULL,
      Origen VARCHAR(10) NULL,
      Usuario VARCHAR(100) NULL,
      TotalPendientes INT NULL,
      TotalOk INT NULL,
      DuracionMs INT NULL,
      Error VARCHAR(500) NULL,
      FechaUltimoIntento DATETIME NULL,
      EnEjecucion TINYINT(1) NOT NULL DEFAULT 0,
      InicioEjecucion DATETIME NULL
    )`,
  biometria_corridas: `
    CREATE TABLE IF NOT EXISTS biometria_corridas (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      Fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      Origen VARCHAR(10) NOT NULL,
      Usuario VARCHAR(100) NULL,
      TotalPendientes INT NULL,
      TotalOk INT NULL,
      TotalReintentoSinOk INT NULL,
      TotalOtroEstado INT NULL,
      TotalSinCaso INT NULL,
      DuracionMs INT NULL,
      Error VARCHAR(500) NULL,
      INDEX idx_biometria_corridas_fecha (Fecha)
    )`,
};

const MENSAJE_SIN_TABLAS =
  'Faltan las tablas del módulo Biometría en la base de datos y el usuario de la aplicación no puede crearlas. ' +
  'Ejecuta una sola vez el script crear_tablas_biometria.sql con una cuenta con privilegios de CREATE.';

let listas = false;
let proximaRevision = 0;
let ultimoMotivo = null;

async function tablasListas(pool) {
  if (listas) return true;
  if (Date.now() < proximaRevision) return false;
  proximaRevision = Date.now() + 30000;
  try {
    for (const [nombre, ddl] of Object.entries(TABLAS)) {
      if (await tablaExiste(pool, nombre)) continue;
      try {
        await pool.query(ddl);
      } catch (error) {
        if (esErrorDePrivilegios(error)) { ultimoMotivo = MENSAJE_SIN_TABLAS; return false; }
        throw error;
      }
    }
    await pool.query('INSERT IGNORE INTO biometria_estado (Id) VALUES (1)');
    await pool.query('INSERT IGNORE INTO biometria_config (Id) VALUES (1)');
    listas = true;
    ultimoMotivo = null;
    return true;
  } catch (error) {
    console.error('No se pudo verificar las tablas del módulo Biometría:', error.message);
    ultimoMotivo = esErrorDePrivilegios(error) ? MENSAJE_SIN_TABLAS : `No se pudo verificar las tablas del módulo Biometría: ${error.message}`;
    return false;
  }
}

function motivoNoDisponible() {
  return ultimoMotivo || MENSAJE_SIN_TABLAS;
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const CONFIG_DEFECTO = {
  automatico: true,
  intervaloMin: 30,
  idEstadoFirma: 30,
  idEstadoBiometria: 60,
  esquema: 'PendienteFirma',
  tabla: 'Solicitudes',
  columnaCliente: '',
  // DOCUMENTO: la columna trae el número de documento (se busca en dbo.CLIENTE y de ahí sus casos).
  // ID: la columna ya trae CASO.idCliente (id interno de ORQBIOMETRIA).
  cruceCliente: 'DOCUMENTO',
  columnasVisibles: [],
  estadoCasoReintento: 3,
  textosOk: ['CEDULA ORIGINAL OK', 'Validación exitosa'],
  limite: 2000,
};

const entero = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

// Devuelve { valores } o { error }. `base` es la configuración vigente (para campos no enviados).
function normalizarConfig(entrada, base = CONFIG_DEFECTO) {
  const c = { ...CONFIG_DEFECTO, ...base, ...(entrada || {}) };
  const out = {};

  out.automatico = c.automatico === true || c.automatico === 1 || c.automatico === '1' || c.automatico === 'true';

  out.intervaloMin = entero(c.intervaloMin);
  if (!Number.isInteger(out.intervaloMin) || out.intervaloMin < 5 || out.intervaloMin > 1440) {
    return { error: 'El intervalo debe ser un número entero de minutos entre 5 y 1440.' };
  }
  for (const [campo, etiqueta] of [['idEstadoFirma', 'IdEstadoFirma'], ['idEstadoBiometria', 'IdEstadoBiometria'], ['estadoCasoReintento', 'el estado de caso en reintento']]) {
    out[campo] = entero(c[campo]);
    if (!Number.isInteger(out[campo]) || out[campo] < 0 || out[campo] > 32767) return { error: `Valor no válido para ${etiqueta}.` };
  }
  out.esquema = String(c.esquema || '').trim();
  out.tabla = String(c.tabla || '').trim();
  if (!IDENT.test(out.esquema)) return { error: 'El esquema solo puede tener letras, números y «_».' };
  if (!IDENT.test(out.tabla)) return { error: 'La tabla solo puede tener letras, números y «_».' };

  out.columnaCliente = String(c.columnaCliente || '').trim();
  if (out.columnaCliente && !IDENT.test(out.columnaCliente)) return { error: 'El nombre de la columna de cliente no es válido.' };

  const cruce = String(c.cruceCliente || 'DOCUMENTO').trim().toUpperCase();
  if (cruce !== 'DOCUMENTO' && cruce !== 'ID') return { error: 'El tipo de cruce debe ser DOCUMENTO o ID.' };
  out.cruceCliente = cruce;

  const visibles = Array.isArray(c.columnasVisibles) ? c.columnasVisibles : [];
  out.columnasVisibles = [...new Set(visibles.map((x) => String(x).trim()).filter(Boolean))].slice(0, 30);
  if (out.columnasVisibles.some((x) => !IDENT.test(x))) return { error: 'Alguna columna visible tiene un nombre no válido.' };

  const textos = Array.isArray(c.textosOk) ? c.textosOk : String(c.textosOk || '').split('\n');
  out.textosOk = [...new Set(textos.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20).map((t) => t.slice(0, 120));
  if (!out.textosOk.length) return { error: 'Indica al menos un texto de resultado exitoso.' };

  out.limite = entero(c.limite);
  if (!Number.isInteger(out.limite) || out.limite < 50 || out.limite > 20000) return { error: 'El límite de filas debe estar entre 50 y 20000.' };
  return { valores: out };
}

async function cargarConfig(pool) {
  const [filas] = await pool.query('SELECT ConfigJson FROM biometria_config WHERE Id = 1');
  let guardada = {};
  try { guardada = filas[0]?.ConfigJson ? JSON.parse(filas[0].ConfigJson) : {}; } catch (_) { guardada = {}; }
  const r = normalizarConfig(guardada, CONFIG_DEFECTO);
  return r.valores || { ...CONFIG_DEFECTO };
}

// El JSON guardado puede traer además `_conexiones` (credenciales cifradas de MotorFirma / ORQBIOMETRIA,
// ver biometriaConexiones.js). No forma parte de la configuración pública y hay que conservarlo al guardar.
async function leerJsonCrudo(pool) {
  const [filas] = await pool.query('SELECT ConfigJson FROM biometria_config WHERE Id = 1');
  try { return filas[0]?.ConfigJson ? JSON.parse(filas[0].ConfigJson) : {}; } catch (_) { return {}; }
}

async function guardarConfig(pool, config, usuario) {
  const previo = await leerJsonCrudo(pool);
  const contenido = previo._conexiones ? { ...config, _conexiones: previo._conexiones } : config;
  await pool.query(
    `INSERT INTO biometria_config (Id, ConfigJson, ActualizadoPor) VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE ConfigJson = VALUES(ConfigJson), ActualizadoPor = VALUES(ActualizadoPor)`,
    [JSON.stringify(contenido), usuario || null]
  );
}

async function cargarConexiones(pool) {
  const c = (await leerJsonCrudo(pool))._conexiones;
  return c && typeof c === 'object' ? c : {};
}

async function guardarConexiones(pool, conexiones, usuario) {
  const previo = await leerJsonCrudo(pool);
  const contenido = { ...previo, _conexiones: conexiones };
  await pool.query(
    `INSERT INTO biometria_config (Id, ConfigJson, ActualizadoPor) VALUES (1, ?, ?)
     ON DUPLICATE KEY UPDATE ConfigJson = VALUES(ConfigJson), ActualizadoPor = VALUES(ActualizadoPor)`,
    [JSON.stringify(contenido), usuario || null]
  );
}

// ---------------------------------------------------------------------------
// Historial de corridas (solo totales, sin datos de clientes)
// ---------------------------------------------------------------------------
async function registrarCorridaOk(pool, resultado, origen, usuario) {
  await pool.query(
    `INSERT INTO biometria_corridas
       (Origen, Usuario, TotalPendientes, TotalOk, TotalReintentoSinOk, TotalOtroEstado, TotalSinCaso, DuracionMs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [origen, usuario || null, resultado.totalPendientes, resultado.totales.OK_REINTENTO, resultado.totales.REINTENTO_SIN_OK,
      resultado.totales.OTRO_ESTADO, resultado.totales.SIN_CASO + resultado.totales.SIN_CLIENTE, resultado.duracionMs]
  );
}

async function registrarCorridaError(pool, mensaje, origen, usuario, duracionMs) {
  await pool.query(
    'INSERT INTO biometria_corridas (Origen, Usuario, DuracionMs, Error) VALUES (?, ?, ?, ?)',
    [origen, usuario || null, duracionMs || null, String(mensaje).slice(0, 500)]
  );
}

// Cada persona ve solo SUS corridas.
async function listarCorridas(pool, usuario, limite = 40) {
  const [filas] = await pool.query(
    `SELECT Id, Fecha, Origen, Usuario, TotalPendientes, TotalOk, TotalReintentoSinOk, TotalOtroEstado, TotalSinCaso, DuracionMs, Error
       FROM biometria_corridas WHERE Usuario = ? ORDER BY Id DESC LIMIT ?`,
    [usuario || '', Math.max(1, Math.min(limite, 200))]
  );
  return filas;
}

// ---------------------------------------------------------------------------
// Almacén: base de datos de AXIS si las tablas están listas; si no (sin tablas,
// sin privilegios o base caída) el módulo sigue funcionando EN MEMORIA: la
// consulta a SQL Server no depende de MariaDB. Lo único que se pierde es que
// la configuración y el historial no sobreviven a un reinicio del backend.
// ---------------------------------------------------------------------------
function almacenBd(pool) {
  return {
    persistente: true,
    cargarConfig: () => cargarConfig(pool),
    guardarConfig: (c, u) => guardarConfig(pool, c, u),
    cargarConexiones: () => cargarConexiones(pool),
    guardarConexiones: (c, u) => guardarConexiones(pool, c, u),
    registrarCorridaOk: (r, o, u) => registrarCorridaOk(pool, r, o, u),
    registrarCorridaError: (m, o, u, d) => registrarCorridaError(pool, m, o, u, d),
    listarCorridas: (usuario, n) => listarCorridas(pool, usuario, n),
  };
}

const mem = { config: null, corridas: [], siguienteId: 1, conexiones: null };

function registrarMemoria(fila) {
  mem.corridas.unshift({ Id: mem.siguienteId++, Fecha: new Date(), ...fila });
  if (mem.corridas.length > 500) mem.corridas.length = 500;
}

const almacenMemoria = {
  persistente: false,
  async cargarConfig() { return mem.config ? { ...mem.config } : { ...CONFIG_DEFECTO }; },
  async guardarConfig(c) { mem.config = { ...c }; },
  async cargarConexiones() { return mem.conexiones ? JSON.parse(JSON.stringify(mem.conexiones)) : {}; },
  async guardarConexiones(c) { mem.conexiones = JSON.parse(JSON.stringify(c)); },
  async registrarCorridaOk(r, origen, usuario) {
    registrarMemoria({
      Origen: origen, Usuario: usuario || null, TotalPendientes: r.totalPendientes, TotalOk: r.totales.OK_REINTENTO,
      TotalReintentoSinOk: r.totales.REINTENTO_SIN_OK, TotalOtroEstado: r.totales.OTRO_ESTADO,
      TotalSinCaso: r.totales.SIN_CASO + r.totales.SIN_CLIENTE, DuracionMs: r.duracionMs, Error: null,
    });
  },
  async registrarCorridaError(mensaje, origen, usuario, duracionMs) {
    registrarMemoria({
      Origen: origen, Usuario: usuario || null, TotalPendientes: null, TotalOk: null, TotalReintentoSinOk: null,
      TotalOtroEstado: null, TotalSinCaso: null, DuracionMs: duracionMs || null, Error: String(mensaje).slice(0, 500),
    });
  },
  async listarCorridas(usuario, limite = 40) {
    return mem.corridas.filter((c) => c.Usuario === (usuario || '')).slice(0, Math.max(1, Math.min(limite, 200)));
  },
};

async function obtenerAlmacen() {
  try {
    const pool = await getPool();
    if (await tablasListas(pool)) return almacenBd(pool);
  } catch (error) {
    console.error('[biometria] Base de AXIS no disponible, se trabaja en memoria:', error.message);
  }
  return almacenMemoria;
}

module.exports = {
  obtenerAlmacen,
  CONFIG_DEFECTO, normalizarConfig, tablasListas, motivoNoDisponible, MENSAJE_SIN_TABLAS,
  cargarConfig, guardarConfig, cargarConexiones, guardarConexiones, registrarCorridaOk, registrarCorridaError, listarCorridas,
};
