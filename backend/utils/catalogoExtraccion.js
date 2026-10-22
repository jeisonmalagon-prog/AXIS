// ==========================================================================
// Extracción de metadatos (SOLO LECTURA) para el Catálogo de Datos.
//
// SQL Server: sys.databases / sys.objects / sys.columns / sys.indexes /
//             sys.foreign_keys / sys.extended_properties (MS_Description).
// MariaDB:    information_schema (TABLES, COLUMNS, KEY_COLUMN_USAGE).
//
// Solo se ejecutan las consultas fijas de este archivo (nada escrito por el
// usuario) y únicamente sobre catálogos del sistema. No se lee ningún dato de
// las tablas de negocio (ni siquiera COUNT(*)): las filas son estimaciones
// del propio catálogo.
//
// Modelo normalizado de salida (igual para ambos motores):
//   { bd, esquema, nombre, tipo: 'TABLA'|'VISTA', descripcion, filas,
//     columnas: [{ nombre, tipo, nulo, pk, identity, calculada, defecto, descripcion }],
//     fks: [{ nombre, columnas: [{ col, refCol }], refBd, refEsquema, refTabla }] }
// ==========================================================================

const TIEMPO_MAX_ORIGEN_MS = 5 * 60 * 1000;
const MAX_OBJETOS_ORIGEN = 30000;
const SISTEMA_MSSQL = new Set(['master', 'model', 'msdb', 'tempdb']);
const SISTEMA_MARIADB = ['information_schema', 'mysql', 'performance_schema', 'sys'];

const corchetes = (n) => `[${String(n).replace(/\]/g, ']]')}]`;
const texto = (v, max) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function cargarMssql(drivers) {
  if (drivers?.mssql) return drivers.mssql;
  // eslint-disable-next-line global-require
  return require('mssql');
}
function cargarMysql(drivers) {
  if (drivers?.mysql) return drivers.mysql;
  // eslint-disable-next-line global-require
  return require('mysql2/promise');
}

// ---------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------
// «DOMINIO\usuario» (o «usuario@dominio.local») = autenticación de dominio (NTLM con usuario y clave de red).
// Cualquier otro usuario = login de SQL Server. Así no hace falta ninguna columna nueva en la base de AXIS.
function parsearUsuarioDominio(usuario) {
  const u = String(usuario || '').trim();
  let m = u.match(/^([^\\/@\s]+)\\([^\\/@\s]+)$/);
  if (m) return { dominio: m[1], usuario: m[2] };
  m = u.match(/^([^\\/@\s]+)@([^\\/@\s]+)$/);
  if (m) return { dominio: m[2].split('.')[0].toUpperCase(), usuario: m[1] };
  return null;
}

function configMssql(origen) {
  const m = String(origen.host).match(/^([^\\]+)\\(.+)$/);
  const dom = parsearUsuarioDominio(origen.usuario);
  const config = {
    server: m ? m[1] : origen.host,
    user: dom ? dom.usuario : origen.usuario,
    password: origen.clave,
    ...(dom ? { domain: dom.dominio } : {}),
    database: 'master',
    connectionTimeout: 15000,
    requestTimeout: 90000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 10000 },
    options: {
      encrypt: !!origen.cifrado,
      trustServerCertificate: origen.confiarCertificado !== false,
      appName: 'AXIS-CatalogoDatos',
      enableArithAbort: true,
      readOnlyIntent: true,
      ...(m ? { instanceName: m[2] } : {}),
    },
  };
  if (!m && Number.isInteger(origen.puerto)) config.port = origen.puerto;
  return config;
}

function formatearTipoMssql(tipo, maxLen, precision, escala) {
  const t = String(tipo || '').toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${maxLen === -1 ? 'max' : maxLen})`;
  if (['nvarchar', 'nchar'].includes(t)) return `${t}(${maxLen === -1 ? 'max' : Math.floor(maxLen / 2)})`;
  if (['decimal', 'numeric'].includes(t)) return `${t}(${precision},${escala})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(t)) return `${t}(${escala})`;
  return t;
}

const SQL_BASES_MSSQL = `
  SELECT name FROM sys.databases
   WHERE state = 0 AND source_database_id IS NULL AND HAS_DBACCESS(name) = 1
   ORDER BY name`;

// Se lee por NIVELES y cada nivel tiene alternativas: con permisos solo de lectura es normal poder ver las
// tablas pero no sus columnas, esquemas o propiedades extendidas. Lo que no se pueda leer se avisa y se sigue.

// Nivel 1: objetos (tablas y vistas). El esquema es opcional: si no es visible se usa «dbo».
const sqlObjetos = (bd) => `
  SELECT COALESCE(s.name, SCHEMA_NAME(o.schema_id), 'dbo') AS esquema, o.name AS objeto, o.type AS tipoObjeto,
         CAST(ept.value AS nvarchar(1000)) AS descripcionObjeto
    FROM ${bd}.sys.objects o
    LEFT JOIN ${bd}.sys.schemas s ON s.schema_id = o.schema_id
    LEFT JOIN ${bd}.sys.extended_properties ept
           ON ept.class = 1 AND ept.major_id = o.object_id AND ept.minor_id = 0 AND ept.name = 'MS_Description'
   WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
   ORDER BY 1, 2`;

const sqlObjetosSimple = (bd) => `
  SELECT COALESCE(s.name, SCHEMA_NAME(o.schema_id), 'dbo') AS esquema, o.name AS objeto, o.type AS tipoObjeto,
         CAST(NULL AS nvarchar(1000)) AS descripcionObjeto
    FROM ${bd}.sys.objects o
    LEFT JOIN ${bd}.sys.schemas s ON s.schema_id = o.schema_id
   WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
   ORDER BY 1, 2`;

const sqlObjetosInfoSchema = (bd) => `
  SELECT TABLE_SCHEMA AS esquema, TABLE_NAME AS objeto,
         CASE TABLE_TYPE WHEN 'VIEW' THEN 'V' ELSE 'U' END AS tipoObjeto, CAST(NULL AS nvarchar(1000)) AS descripcionObjeto
    FROM ${bd}.INFORMATION_SCHEMA.TABLES
   ORDER BY 1, 2`;

// Nivel 2: columnas (completas -> solo sys.columns -> INFORMATION_SCHEMA).
const sqlColumnas = (bd) => `
  SELECT COALESCE(s.name, SCHEMA_NAME(o.schema_id), 'dbo') AS esquema, o.name AS objeto, o.type AS tipoObjeto,
         c.column_id AS orden, c.name AS columna, t.name AS tipoDato,
         c.max_length AS longitud, c.precision AS precisionNum, c.scale AS escala,
         c.is_nullable AS nulo, c.is_identity AS esIdentity, c.is_computed AS esCalculada,
         CAST(dc.definition AS nvarchar(300)) AS defecto,
         CAST(epc.value AS nvarchar(1000)) AS descripcionColumna
    FROM ${bd}.sys.objects o
    LEFT JOIN ${bd}.sys.schemas s ON s.schema_id = o.schema_id
    JOIN ${bd}.sys.columns c ON c.object_id = o.object_id
    JOIN ${bd}.sys.types t ON t.user_type_id = c.user_type_id
    LEFT JOIN ${bd}.sys.default_constraints dc ON dc.object_id = c.default_object_id
    LEFT JOIN ${bd}.sys.extended_properties epc
           ON epc.class = 1 AND epc.major_id = o.object_id AND epc.minor_id = c.column_id AND epc.name = 'MS_Description'
   WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
   ORDER BY 1, 2, c.column_id`;

const sqlColumnasSimple = (bd) => `
  SELECT COALESCE(s.name, SCHEMA_NAME(o.schema_id), 'dbo') AS esquema, o.name AS objeto, o.type AS tipoObjeto,
         c.column_id AS orden, c.name AS columna, t.name AS tipoDato,
         c.max_length AS longitud, c.precision AS precisionNum, c.scale AS escala,
         c.is_nullable AS nulo, c.is_identity AS esIdentity, c.is_computed AS esCalculada,
         CAST(NULL AS nvarchar(300)) AS defecto, CAST(NULL AS nvarchar(1000)) AS descripcionColumna
    FROM ${bd}.sys.objects o
    LEFT JOIN ${bd}.sys.schemas s ON s.schema_id = o.schema_id
    JOIN ${bd}.sys.columns c ON c.object_id = o.object_id
    JOIN ${bd}.sys.types t ON t.user_type_id = c.user_type_id
   WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
   ORDER BY 1, 2, c.column_id`;

const sqlColumnasInfoSchema = (bd) => `
  SELECT TABLE_SCHEMA AS esquema, TABLE_NAME AS objeto, CAST(NULL AS char(2)) AS tipoObjeto,
         ORDINAL_POSITION AS orden, COLUMN_NAME AS columna, DATA_TYPE AS tipoDato,
         CHARACTER_OCTET_LENGTH AS longitud, NUMERIC_PRECISION AS precisionNum,
         COALESCE(NUMERIC_SCALE, DATETIME_PRECISION) AS escala,
         CASE IS_NULLABLE WHEN 'YES' THEN 1 ELSE 0 END AS nulo, 0 AS esIdentity, 0 AS esCalculada,
         CAST(COLUMN_DEFAULT AS nvarchar(300)) AS defecto, CAST(NULL AS nvarchar(1000)) AS descripcionColumna
    FROM ${bd}.INFORMATION_SCHEMA.COLUMNS
   ORDER BY 1, 2, ORDINAL_POSITION`;

const sqlPk = (bd) => `
  SELECT s.name AS esquema, o.name AS objeto, c.name AS columna, ic.key_ordinal AS pos
    FROM ${bd}.sys.indexes i
    JOIN ${bd}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN ${bd}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    JOIN ${bd}.sys.objects o ON o.object_id = i.object_id
    JOIN ${bd}.sys.schemas s ON s.schema_id = o.schema_id
   WHERE i.is_primary_key = 1 AND o.type = 'U' AND o.is_ms_shipped = 0`;

const sqlFk = (bd) => `
  SELECT fk.name AS fk,
         ps.name AS esquema, po.name AS tabla, pc.name AS columna,
         rs.name AS refEsquema, ro.name AS refTabla, rc.name AS refColumna,
         fkc.constraint_column_id AS pos
    FROM ${bd}.sys.foreign_keys fk
    JOIN ${bd}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN ${bd}.sys.objects po ON po.object_id = fkc.parent_object_id
    JOIN ${bd}.sys.schemas ps ON ps.schema_id = po.schema_id
    JOIN ${bd}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN ${bd}.sys.objects ro ON ro.object_id = fkc.referenced_object_id
    JOIN ${bd}.sys.schemas rs ON rs.schema_id = ro.schema_id
    JOIN ${bd}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
   WHERE po.is_ms_shipped = 0
   ORDER BY fk.name, fkc.constraint_column_id`;

const sqlFilas = (bd) => `
  SELECT s.name AS esquema, o.name AS objeto, SUM(p.rows) AS filas
    FROM ${bd}.sys.partitions p
    JOIN ${bd}.sys.objects o ON o.object_id = p.object_id
    JOIN ${bd}.sys.schemas s ON s.schema_id = o.schema_id
   WHERE p.index_id IN (0, 1) AND o.type = 'U' AND o.is_ms_shipped = 0
   GROUP BY s.name, o.name`;

const claveObj = (esquema, nombre) => `${esquema}\u0001${nombre}`;

// Prueba las alternativas en orden y devuelve la primera que no falle. Si todas fallan devuelve el último error.
async function primeraQueFuncione(consulta, alternativas) {
  let ultimoError = null;
  for (let i = 0; i < alternativas.length; i += 1) {
    try { return { filas: await consulta(alternativas[i]), alternativa: i, error: null }; } catch (e) { ultimoError = e; }
  }
  return { filas: null, alternativa: -1, error: ultimoError };
}

async function extraerBaseMssql(pool, nombreBd, advertencias) {
  const bd = corchetes(nombreBd);
  const consulta = async (sql) => (await pool.request().query(sql)).recordset || [];
  const tablas = new Map();
  const nuevaTabla = (esquema, objeto, tipoObjeto, descripcion) => ({
    bd: nombreBd, esquema: String(esquema || 'dbo'), nombre: String(objeto),
    tipo: String(tipoObjeto || '').trim() === 'V' ? 'VISTA' : 'TABLA',
    descripcion: texto(descripcion, 1000), filas: null, columnas: [], fks: [],
  });

  // Nivel 1: tablas y vistas. Si ni esto se puede leer, la base queda como «no se pudo leer».
  const objetos = await primeraQueFuncione(consulta, [sqlObjetos(bd), sqlObjetosSimple(bd), sqlObjetosInfoSchema(bd)]);
  if (objetos.filas === null) throw objetos.error;
  for (const f of objetos.filas) tablas.set(claveObj(f.esquema, f.objeto), nuevaTabla(f.esquema, f.objeto, f.tipoObjeto, f.descripcionObjeto));

  // Nivel 2: columnas. Sin permiso se conservan solo los nombres de las tablas.
  const cols = await primeraQueFuncione(consulta, [sqlColumnas(bd), sqlColumnasSimple(bd), sqlColumnasInfoSchema(bd)]);
  if (cols.filas === null) {
    advertencias.push(`${nombreBd}: solo se pudieron leer los nombres de tablas; las columnas no son visibles con este usuario (${texto(cols.error && cols.error.message, 100)}).`);
  } else {
    for (const f of cols.filas) {
      const k = claveObj(f.esquema, f.objeto);
      let t = tablas.get(k);
      if (!t) { t = nuevaTabla(f.esquema, f.objeto, f.tipoObjeto, null); tablas.set(k, t); }
      t.columnas.push({
        nombre: String(f.columna), tipo: formatearTipoMssql(f.tipoDato, f.longitud, f.precisionNum, f.escala),
        nulo: !!f.nulo, pk: false, identity: !!f.esIdentity, calculada: !!f.esCalculada,
        defecto: texto(f.defecto, 300), descripcion: texto(f.descripcionColumna, 1000),
      });
    }
    if (tablas.size && ![...tablas.values()].some((t) => t.columnas.length)) {
      advertencias.push(`${nombreBd}: se ven ${tablas.size} tabla(s) pero ninguna columna con este usuario (permisos de solo lectura limitados).`);
    }
  }

  // Llaves primarias, llaves foráneas y filas: si alguna falla por permisos se avisa y se sigue.
  try {
    for (const f of await consulta(sqlPk(bd))) {
      const t = tablas.get(claveObj(f.esquema, f.objeto));
      const c = t && t.columnas.find((x) => x.nombre === f.columna);
      if (c) c.pk = true;
    }
  } catch (e) { advertencias.push(`${nombreBd}: no se pudieron leer las llaves primarias (${texto(e.message, 120)}).`); }

  try {
    const porFk = new Map();
    for (const f of await consulta(sqlFk(bd))) {
      const t = tablas.get(claveObj(f.esquema, f.tabla));
      if (!t) continue;
      const k = `${claveObj(f.esquema, f.tabla)}\u0001${f.fk}`;
      let fk = porFk.get(k);
      if (!fk) {
        fk = { nombre: String(f.fk), columnas: [], refBd: nombreBd, refEsquema: String(f.refEsquema), refTabla: String(f.refTabla) };
        porFk.set(k, fk);
        t.fks.push(fk);
      }
      fk.columnas.push({ col: String(f.columna), refCol: String(f.refColumna) });
    }
  } catch (e) { advertencias.push(`${nombreBd}: no se pudieron leer las llaves foráneas (${texto(e.message, 120)}).`); }

  try {
    for (const f of await consulta(sqlFilas(bd))) {
      const t = tablas.get(claveObj(f.esquema, f.objeto));
      if (t) t.filas = Number(f.filas);
    }
  } catch (e) { /* las filas son opcionales */ }

  return [...tablas.values()];
}

async function conectarMssql(origen, drivers) {
  const m = cargarMssql(drivers);
  const pool = new m.ConnectionPool(configMssql(origen));
  if (typeof pool.on === 'function') pool.on('error', () => {});
  await pool.connect();
  return pool;
}

async function listarBasesMssql(pool, origen) {
  const todas = ((await pool.request().query(SQL_BASES_MSSQL)).recordset || []).map((f) => String(f.name));
  if (origen.basesIncluidas && origen.basesIncluidas.length) {
    const quiero = new Set(origen.basesIncluidas.map((b) => b.toLowerCase()));
    return todas.filter((b) => quiero.has(b.toLowerCase()));
  }
  return todas.filter((b) => !SISTEMA_MSSQL.has(b.toLowerCase()));
}

async function extraerMssql(origen, drivers, onProgreso) {
  const pool = await conectarMssql(origen, drivers);
  const advertencias = [];
  const inicio = Date.now();
  try {
    const bases = await listarBasesMssql(pool, origen);
    const salida = [];
    let objetos = 0;
    for (const nombre of bases) {
      if (Date.now() - inicio > TIEMPO_MAX_ORIGEN_MS) { advertencias.push(`Se agotó el tiempo: faltaron las bases desde «${nombre}».`); break; }
      if (objetos >= MAX_OBJETOS_ORIGEN) { advertencias.push(`Se alcanzó el tope de ${MAX_OBJETOS_ORIGEN} objetos: faltaron las bases desde «${nombre}».`); break; }
      if (onProgreso) onProgreso(`Leyendo ${nombre}…`);
      try {
        const tablas = await extraerBaseMssql(pool, nombre, advertencias);
        objetos += tablas.length;
        salida.push({ nombre, tablas });
      } catch (e) {
        advertencias.push(`${nombre}: no se pudo leer (${texto(e.message, 160)}).`);
        salida.push({ nombre, tablas: [], error: texto(e.message, 160) });
      }
    }
    const tope = 40;
    if (advertencias.length > tope) { const extra = advertencias.length - tope; advertencias.length = tope; advertencias.push(`…y ${extra} aviso(s) más.`); }
    return { bases: salida, advertencias };
  } finally {
    try { await pool.close(); } catch (_) { /* ya cerrada */ }
  }
}

// ---------------------------------------------------------------------------
// MariaDB / MySQL
// ---------------------------------------------------------------------------
async function conectarMysql(origen, drivers) {
  const m = cargarMysql(drivers);
  const conexion = await m.createConnection({
    host: origen.host, port: origen.puerto, user: origen.usuario, password: origen.clave,
    connectTimeout: 15000, dateStrings: true,
    ...(origen.cifrado ? { ssl: { rejectUnauthorized: origen.confiarCertificado === false } } : {}),
  });
  try { await conexion.query('SET SESSION TRANSACTION READ ONLY'); } catch (_) { /* MariaDB < 5.6 no lo soporta */ }
  return conexion;
}

async function extraerMysql(origen, drivers, onProgreso) {
  const conexion = await conectarMysql(origen, drivers);
  const advertencias = [];
  try {
    const [esquemas] = await conexion.query(
      'SELECT SCHEMA_NAME AS nombre FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (?) ORDER BY SCHEMA_NAME',
      [SISTEMA_MARIADB]
    );
    let nombres = esquemas.map((e) => String(e.nombre));
    if (origen.basesIncluidas && origen.basesIncluidas.length) {
      const quiero = new Set(origen.basesIncluidas.map((b) => b.toLowerCase()));
      nombres = nombres.filter((n) => quiero.has(n.toLowerCase()));
    }
    if (!nombres.length) return { bases: [], advertencias };
    if (onProgreso) onProgreso('Leyendo information_schema…');

    const [objetos] = await conexion.query(
      `SELECT TABLE_SCHEMA AS bd, TABLE_NAME AS nombre, TABLE_TYPE AS tipo, TABLE_COMMENT AS comentario, TABLE_ROWS AS filas
         FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME`, [nombres]);
    const [columnas] = await conexion.query(
      `SELECT TABLE_SCHEMA AS bd, TABLE_NAME AS tabla, COLUMN_NAME AS columna, COLUMN_TYPE AS tipo,
              IS_NULLABLE AS nulo, COLUMN_KEY AS llave, EXTRA AS extra, COLUMN_DEFAULT AS defecto, COLUMN_COMMENT AS comentario
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`, [nombres]);
    let fks = [];
    try {
      [fks] = await conexion.query(
        `SELECT CONSTRAINT_NAME AS fk, TABLE_SCHEMA AS bd, TABLE_NAME AS tabla, COLUMN_NAME AS columna,
                REFERENCED_TABLE_SCHEMA AS refBd, REFERENCED_TABLE_NAME AS refTabla, REFERENCED_COLUMN_NAME AS refColumna,
                ORDINAL_POSITION AS pos
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_SCHEMA IN (?)
          ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, [nombres]);
    } catch (e) { advertencias.push(`No se pudieron leer las llaves foráneas (${texto(e.message, 120)}).`); }

    const mapa = new Map();
    const salidaPorBd = new Map(nombres.map((n) => [n, []]));
    for (const o of objetos) {
      const t = {
        bd: String(o.bd), esquema: null, nombre: String(o.nombre), tipo: /VIEW/i.test(String(o.tipo)) ? 'VISTA' : 'TABLA',
        descripcion: texto(o.comentario, 1000), filas: o.filas === null || o.filas === undefined ? null : Number(o.filas),
        columnas: [], fks: [],
      };
      mapa.set(`${t.bd}\u0001${t.nombre}`, t);
      (salidaPorBd.get(t.bd) || []).push(t);
    }
    for (const c of columnas) {
      const t = mapa.get(`${c.bd}\u0001${c.tabla}`);
      if (!t) continue;
      t.columnas.push({
        nombre: String(c.columna), tipo: String(c.tipo), nulo: String(c.nulo).toUpperCase() === 'YES', pk: c.llave === 'PRI',
        identity: /auto_increment/i.test(String(c.extra || '')), calculada: /generated/i.test(String(c.extra || '')),
        defecto: String(c.defecto) === 'NULL' ? null : texto(c.defecto, 300), descripcion: texto(c.comentario, 1000),
      });
    }
    const porFk = new Map();
    for (const f of fks) {
      const t = mapa.get(`${f.bd}\u0001${f.tabla}`);
      if (!t) continue;
      const k = `${f.bd}\u0001${f.tabla}\u0001${f.fk}`;
      let fk = porFk.get(k);
      if (!fk) {
        fk = { nombre: String(f.fk), columnas: [], refBd: String(f.refBd || f.bd), refEsquema: null, refTabla: String(f.refTabla) };
        porFk.set(k, fk);
        t.fks.push(fk);
      }
      fk.columnas.push({ col: String(f.columna), refCol: String(f.refColumna) });
    }
    const bases = nombres.map((n) => ({ nombre: n, tablas: salidaPorBd.get(n) || [] }));
    return { bases, advertencias };
  } finally {
    try { await conexion.end(); } catch (_) { /* ya cerrada */ }
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function extraerOrigen(origen, { drivers, onProgreso } = {}) {
  if (!origen.clave) {
    const err = new Error('No se pudo leer la clave guardada de este origen: vuelve a ingresarla.');
    err.codigo = 'CLAVE_ILEGIBLE';
    throw err;
  }
  return origen.motor === 'MSSQL' ? extraerMssql(origen, drivers, onProgreso) : extraerMysql(origen, drivers, onProgreso);
}

// Conecta, lee la versión y lista las bases visibles (no extrae tablas).
async function probarOrigen(origen, { drivers } = {}) {
  if (origen.motor === 'MSSQL') {
    const pool = await conectarMssql(origen, drivers);
    try {
      const v = (await pool.request().query('SELECT @@VERSION AS version')).recordset?.[0]?.version;
      const bases = await listarBasesMssql(pool, origen);
      return { ok: true, version: texto(String(v || '').split('\n')[0], 120), bases };
    } finally { try { await pool.close(); } catch (_) { /* nada */ } }
  }
  const conexion = await conectarMysql(origen, drivers);
  try {
    const [[v]] = await conexion.query('SELECT VERSION() AS version');
    const [esq] = await conexion.query('SELECT SCHEMA_NAME AS nombre FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (?) ORDER BY SCHEMA_NAME', [SISTEMA_MARIADB]);
    let bases = esq.map((e) => String(e.nombre));
    if (origen.basesIncluidas && origen.basesIncluidas.length) {
      const quiero = new Set(origen.basesIncluidas.map((b) => b.toLowerCase()));
      bases = bases.filter((b) => quiero.has(b.toLowerCase()));
    }
    return { ok: true, version: texto(v?.version, 120), bases };
  } finally { try { await conexion.end(); } catch (_) { /* nada */ } }
}

// Mensaje entendible a partir de un error de driver. Nunca incluye credenciales.
function mensajeErrorOrigen(error, origen) {
  const nombre = origen?.nombre ? `«${origen.nombre}»` : 'el origen';
  const codigo = error?.codigo || error?.code;
  const t = String(error?.message || error || '');
  if (codigo === 'CLAVE_ILEGIBLE') return t;
  if (codigo === 'MODULE_NOT_FOUND') return "Falta un paquete del driver en el backend (mssql/mysql2): reconstruye la imagen.";
  if (['ELOGIN', 'ER_ACCESS_DENIED_ERROR'].includes(codigo) || error?.errno === 1045) {
    return parsearUsuarioDominio(origen?.usuario)
      ? `Inicio de sesión rechazado en ${nombre}: revisa la clave de red del usuario ${origen.usuario} y que tenga acceso a ese servidor. Un intento con clave incorrecta cuenta para el bloqueo de la cuenta de dominio.`
      : `Inicio de sesión rechazado en ${nombre}: revisa usuario y clave.`;
  }
  if (['ETIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(codigo)) return `Tiempo de espera agotado con ${nombre}: revisa host, puerto y firewall.`;
  if (['ESOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'EINSTLOOKUP', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(codigo)) {
    return `No se pudo conectar con ${nombre}: revisa host, puerto y que el servidor de AXIS tenga ruta hacia él.`;
  }
  if (/self.signed|certificate/i.test(t)) return `El certificado de ${nombre} no es de confianza: activa «Confiar en el certificado» o desactiva el cifrado.`;
  return `Error con ${nombre}: ${t.slice(0, 220)}`;
}


// ---------------------------------------------------------------------------
// Ejecución de UNA consulta de lectura (constructor de queries)
// ---------------------------------------------------------------------------
// El texto ya fue validado como SELECT único (queriesAnalisis.validarSoloLectura). Aquí además:
//  - SQL Server: conexión con ApplicationIntent=ReadOnly, tiempo máximo y corte de lectura al llegar al
//    máximo de filas (se cancela la consulta, no se descarga el resto);
//  - MariaDB: transacción de solo lectura y max_statement_time.
function formatearValor(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().replace('T', ' ').replace(/Z$/, '').replace(/\.000$/, '');
  if (Buffer.isBuffer(v)) return `0x${v.subarray(0, 32).toString('hex')}${v.length > 32 ? '…' : ''}`;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return v.length > 4000 ? `${v.slice(0, 4000)}…` : v;
  if (typeof v === 'object') { try { return JSON.stringify(v).slice(0, 1000); } catch { return String(v); } }
  return v;
}

async function ejecutarLecturaMssql(origen, { bd, sql, maxFilas, timeoutMs }, drivers) {
  const m = cargarMssql(drivers);
  const cfg = configMssql(origen);
  cfg.database = bd || 'master';
  cfg.requestTimeout = timeoutMs;
  const pool = new m.ConnectionPool(cfg);
  if (typeof pool.on === 'function') pool.on('error', () => {});
  await pool.connect();
  try {
    const request = pool.request();
    request.stream = true;
    request.arrayRowMode = true;
    return await new Promise((resolve, reject) => {
      let columnas = [];
      const filas = [];
      let truncado = false;
      let cancelado = false;
      let cerrado = false;
      const cerrar = (fn, valor) => { if (cerrado) return; cerrado = true; fn(valor); };
      request.on('recordset', (cols) => {
        if (columnas.length) return;
        columnas = Array.isArray(cols) ? cols.map((c) => String(c.name || '')) : Object.keys(cols || {});
      });
      request.on('row', (fila) => {
        if (cancelado) return;
        if (filas.length >= maxFilas) {
          truncado = true;
          cancelado = true;
          try { request.cancel(); } catch (_) { /* nada */ }
          setTimeout(() => cerrar(resolve, { columnas, filas, truncado }), 2500).unref?.();
          return;
        }
        const valores = Array.isArray(fila) ? fila : columnas.map((c) => fila[c]);
        filas.push(valores.map(formatearValor));
      });
      request.on('error', (err) => { if (cancelado) return; cerrar(reject, err); });
      request.on('done', () => cerrar(resolve, { columnas, filas, truncado }));
      request.query(sql);
    });
  } finally { try { await pool.close(); } catch (_) { /* nada */ } }
}

async function ejecutarLecturaMysql(origen, { bd, sql, maxFilas, timeoutMs }, drivers) {
  const conexion = await conectarMysql(origen, drivers);
  try {
    if (bd) await conexion.changeUser({ database: bd });
    try { await conexion.query('SET SESSION max_statement_time = ?', [Math.ceil(timeoutMs / 1000)]); } catch (_) { /* MySQL no lo tiene */ }
    const [filas, campos] = await conexion.query({ sql, rowsAsArray: true, timeout: timeoutMs });
    const lista = Array.isArray(filas) ? filas : [];
    return {
      columnas: (campos || []).map((c) => String(c.name)),
      filas: lista.slice(0, maxFilas).map((f) => f.map(formatearValor)),
      truncado: lista.length > maxFilas,
    };
  } finally { try { await conexion.end(); } catch (_) { /* nada */ } }
}

async function ejecutarLectura(origen, { bd = '', sql, maxFilas = 200, timeoutMs = 20000, drivers } = {}) {
  if (!origen.clave) {
    const err = new Error('No se pudo leer la clave guardada de este origen: vuelve a ingresarla.');
    err.codigo = 'CLAVE_ILEGIBLE';
    throw err;
  }
  const inicio = Date.now();
  const r = origen.motor === 'MSSQL'
    ? await ejecutarLecturaMssql(origen, { bd, sql, maxFilas, timeoutMs }, drivers)
    : await ejecutarLecturaMysql(origen, { bd, sql, maxFilas, timeoutMs }, drivers);
  return { ...r, duracionMs: Date.now() - inicio, motor: origen.motor };
}

// Mensaje entendible cuando falla la consulta (distingue el rechazo del servidor de un fallo de conexión).
function mensajeErrorConsulta(error, origen, timeoutMs = 20000) {
  const codigo = error?.code || error?.codigo;
  const t = String(error?.message || error || '');
  if (['ETIMEOUT', 'ESOCKETTIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT'].includes(codigo) || /timeout|max_statement_time|time.?out/i.test(t)) {
    return `La consulta superó el tiempo máximo (${Math.round(timeoutMs / 1000)} s). Agrega filtros (fechas, documento) o reduce las tablas.`;
  }
  if (codigo === 'EREQUEST' || error?.number || error?.sqlState) {
    return `El servidor rechazó la consulta: ${t.replace(/\s+/g, ' ').slice(0, 300)}`;
  }
  return mensajeErrorOrigen(error, origen);
}

module.exports = { ejecutarLectura, mensajeErrorConsulta, extraerOrigen, probarOrigen, mensajeErrorOrigen, parsearUsuarioDominio, formatearTipoMssql, configMssql, sqlColumnas, sqlPk, sqlFk, sqlFilas, SQL_BASES_MSSQL };
