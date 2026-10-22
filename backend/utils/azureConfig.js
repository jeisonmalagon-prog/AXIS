// Configuración de Azure DevOps administrable desde la aplicación (solo ADMIN_POD):
//  - Tokens de acceso (PAT): uno o varios, guardados CIFRADOS (AES-256-GCM) en la BD.
//    Para cada sección se usa el que sí tenga permiso (ver candidatos()).
//  - Organización, proyecto, repositorio y rama por defecto (ConfiguracionSistema).
//
// El .env sigue funcionando como respaldo: si no hay nada guardado en la BD se usan
// AZURE_DEVOPS_ORG/PROJECT/REPO/BRANCH/PAT, así nada se rompe durante la transición.
//
// El token en claro NUNCA sale del backend: al navegador solo llegan los últimos 4 caracteres.
// La cuenta de BD de la app no tiene DELETE, por eso "eliminar" un token borra su valor y lo
// marca como eliminado (no queda ningún secreto en la fila).

const crypto = require('crypto');
const { getPool } = require('../db');
const { tablaExiste, esErrorDePrivilegios } = require('./esquemaSeguro');

const TABLA = 'azure_devops_tokens';
const TABLA_AJUSTES = 'ConfiguracionSistema';
const CLAVES_AJUSTES = { org: 'azure_org', project: 'azure_proyecto', repo: 'azure_repo', branch: 'azure_rama' };

const SQL_CREAR = `CREATE TABLE IF NOT EXISTS ${TABLA} (
  Id                INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  Nombre            VARCHAR(80)   NOT NULL,
  TokenCifrado      VARCHAR(1000) NOT NULL,
  Ultimos4          VARCHAR(8)    NOT NULL DEFAULT '',
  Activo            TINYINT(1)    NOT NULL DEFAULT 1,
  Eliminado         TINYINT(1)    NOT NULL DEFAULT 0,
  Orden             INT           NOT NULL DEFAULT 0,
  ResultadoPrueba   TEXT          NULL,
  ProbadoEn         DATETIME      NULL,
  CreadoPorId       INT           NULL,
  CreadoEn          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ActualizadoPorId  INT           NULL,
  ActualizadoEn     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`;

const PAT_VALIDO = /^[A-Za-z0-9+/=_.\-]{20,300}$/;
const ORG_VALIDA = /^[A-Za-z0-9][\w.\-]{0,99}$/;
const NOMBRE_VALIDO = /^[\p{L}\p{N} .()\-_]{1,80}$/u;
const REPO_VALIDO = /^[\w .()\-]{1,120}$/;
const RAMA_VALIDA = /^[\w./()#+@\- ]{1,250}$/;

class ErrorConfig extends Error {
  constructor(mensaje, status = 400, codigo = 'VALIDACION') { super(mensaje); this.status = status; this.codigo = codigo; }
}

// --- Cifrado --------------------------------------------------------------------------

let claveCache = { secreto: null, clave: null };
function clave() {
  const secreto = process.env.AZURE_TOKENS_KEY || process.env.JWT_SECRET;
  if (!secreto) throw new ErrorConfig('No hay clave para cifrar los tokens (falta JWT_SECRET o AZURE_TOKENS_KEY en el .env del backend).', 500, 'SIN_CLAVE');
  if (claveCache.secreto !== secreto) claveCache = { secreto, clave: crypto.scryptSync(secreto, 'axis-azure-tokens-v1', 32) };
  return claveCache.clave;
}

function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave(), iv);
  const enc = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function descifrar(valor) {
  const [v, iv, tag, enc] = String(valor || '').split(':');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('formato');
  const d = crypto.createDecipheriv('aes-256-gcm', clave(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// --- Estado en memoria (se recarga de la BD cada 20 s o cuando cambia algo) ----------------

const defectosEnv = () => ({
  org: process.env.AZURE_DEVOPS_ORG || 'BancoFinandina',
  project: process.env.AZURE_DEVOPS_PROJECT || 'BusIBM',
  repo: process.env.AZURE_DEVOPS_REPO || 'Documentos',
  branch: process.env.AZURE_DEVOPS_BRANCH || 'master',
});

let estado = { ...defectosEnv(), tokens: [], cargadoEn: 0, tabla: false, ajustesGuardados: {} };
let cargando = null;
const TTL_MS = 20000;

// Marcas por (token, área): lo aprendido en uso real o en la última prueba.
const marcas = new Map(); // `${id}|${area}` -> { ok, hasta }
const MARCA_OK_MS = 30 * 60 * 1000;
const MARCA_MAL_MS = 5 * 60 * 1000;

async function leerAjustes(pool) {
  const guardados = {};
  try {
    const [filas] = await pool.query(`SELECT Clave, Valor FROM ${TABLA_AJUSTES} WHERE Clave IN (?, ?, ?, ?)`, Object.values(CLAVES_AJUSTES));
    for (const f of filas) {
      const campo = Object.keys(CLAVES_AJUSTES).find((k) => CLAVES_AJUSTES[k] === f.Clave);
      if (campo && String(f.Valor || '').trim()) guardados[campo] = String(f.Valor).trim();
    }
  } catch (err) {
    if (err.errno !== 1146) console.error('[azure] No se pudieron leer los ajustes de Azure DevOps:', err.message);
  }
  return guardados;
}

async function leerFilasTokens(pool) {
  try {
    if (!(await tablaExiste(pool, TABLA))) return { tabla: false, filas: [] };
    const [filas] = await pool.query(`SELECT * FROM ${TABLA} WHERE Eliminado = 0 ORDER BY Orden, Id`);
    return { tabla: true, filas };
  } catch (err) {
    console.error('[azure] No se pudieron leer los tokens de Azure DevOps:', err.message);
    return { tabla: false, filas: [], error: err.message };
  }
}

function parseResultado(texto) {
  try { const r = JSON.parse(texto); return r && typeof r === 'object' ? r : null; } catch { return null; }
}

async function cargar() {
  const pool = await getPool();
  const [guardados, { tabla, filas }] = await Promise.all([leerAjustes(pool), leerFilasTokens(pool)]);
  const base = { ...defectosEnv(), ...guardados };
  const tokens = [];
  for (const f of filas) {
    if (!f.Activo) continue;
    let valor = null;
    try { valor = descifrar(f.TokenCifrado); } catch { valor = null; }
    if (!valor) continue;
    tokens.push({ id: f.Id, nombre: f.Nombre, valor, orden: f.Orden, areas: (parseResultado(f.ResultadoPrueba) || {}).areas || {}, origen: 'bd' });
  }
  if (!tokens.length && process.env.AZURE_DEVOPS_PAT) {
    tokens.push({ id: 0, nombre: 'Token del .env (respaldo)', valor: process.env.AZURE_DEVOPS_PAT, orden: 0, areas: {}, origen: 'env' });
  }
  estado = { ...base, tokens, cargadoEn: Date.now(), tabla, ajustesGuardados: guardados };
  return estado;
}

async function asegurar(forzar = false) {
  if (!forzar && Date.now() - estado.cargadoEn < TTL_MS) return estado;
  if (!cargando) {
    cargando = cargar().catch((err) => {
      console.error('[azure] No se pudo cargar la configuración de Azure DevOps (se usa la última conocida o el .env):', err.message);
      estado = { ...estado, cargadoEn: Date.now() - TTL_MS + 3000 }; // reintenta en 3 s
      return estado;
    }).finally(() => { cargando = null; });
  }
  return cargando;
}

function invalidar() { estado = { ...estado, cargadoEn: 0 }; marcas.clear(); }

// Valores vigentes (síncrono; refrescado por asegurar()).
const cfg = () => estado;

function marcar(id, area, ok) {
  marcas.set(`${id}|${area}`, { ok, hasta: Date.now() + (ok ? MARCA_OK_MS : MARCA_MAL_MS) });
}

// Tokens a probar para un área, el más prometedor primero. Los que acaban de fallar en esa área se omiten.
function candidatos(area) {
  const ahora = Date.now();
  const lista = estado.tokens;
  const puntuados = [];
  for (const t of lista) {
    const m = marcas.get(`${t.id}|${area}`);
    if (m && m.hasta > ahora && !m.ok) continue;
    let puntos = 0;
    if (m && m.hasta > ahora && m.ok) puntos = 3;
    else if (t.areas[area] === true) puntos = 2;
    else if (t.areas[area] === false) puntos = -1;
    puntuados.push({ t, puntos });
  }
  puntuados.sort((a, b) => b.puntos - a.puntos || a.t.orden - b.t.orden || a.t.id - b.t.id);
  return { hayTokens: lista.length > 0, candidatos: puntuados.map((x) => x.t) };
}

// --- Tabla -----------------------------------------------------------------------------------

async function garantizarTabla(pool) {
  if (await tablaExiste(pool, TABLA)) return;
  try {
    await pool.query(SQL_CREAR);
  } catch (err) {
    if (esErrorDePrivilegios(err)) {
      throw new ErrorConfig(`Falta la tabla ${TABLA} y el usuario de la aplicación no puede crearla. Ejecuta una sola vez el script crear_tabla_azure_devops_tokens.sql con una cuenta con privilegios.`, 409, 'SIN_TABLA');
    }
    throw err;
  }
}

function vistaToken(f) {
  let legible = true;
  try { descifrar(f.TokenCifrado); } catch { legible = false; }
  const r = parseResultado(f.ResultadoPrueba);
  return {
    id: f.Id, nombre: f.Nombre, ultimos4: f.Ultimos4 || '', activo: !!f.Activo, orden: f.Orden, legible,
    probadoEn: f.ProbadoEn || null, resultado: r, creadoEn: f.CreadoEn || null, actualizadoEn: f.ActualizadoEn || null,
  };
}

async function listar(pool) {
  const { tabla, filas } = await leerFilasTokens(pool);
  let cifradoListo = true;
  try { clave(); } catch { cifradoListo = false; }
  const guardados = await leerAjustes(pool);
  const env = defectosEnv();
  const patEnv = process.env.AZURE_DEVOPS_PAT || '';
  return {
    tabla, cifradoListo,
    tokens: filas.map(vistaToken),
    tokenEnv: patEnv ? { presente: true, ultimos4: patEnv.slice(-4), enUso: !filas.some((f) => f.Activo) } : { presente: false, ultimos4: '', enUso: false },
    ajustes: { org: guardados.org || '', project: guardados.project || '', repo: guardados.repo || '', branch: guardados.branch || '' },
    porDefecto: env,
    vigente: { org: guardados.org || env.org, project: guardados.project || env.project, repo: guardados.repo || env.repo, branch: guardados.branch || env.branch },
  };
}

function validarNombre(nombre) {
  const n = String(nombre ?? '').trim();
  if (!n) throw new ErrorConfig('Ponle un nombre al token (por ejemplo «Lectura de código» o «Pipelines y releases»).');
  if (!NOMBRE_VALIDO.test(n)) throw new ErrorConfig('El nombre solo puede tener letras, números, espacios y . ( ) - _ (máximo 80 caracteres).');
  return n.slice(0, 80);
}

function validarToken(token) {
  const t = String(token ?? '').trim();
  if (!PAT_VALIDO.test(t)) throw new ErrorConfig('El token no parece válido. Copia el PAT completo desde Azure DevOps (sin espacios).');
  return t;
}

async function crear(pool, { nombre, token }, usuarioId) {
  const n = validarNombre(nombre);
  const t = validarToken(token);
  await garantizarTabla(pool);
  const cifrado = cifrar(t);
  const [[max]] = await pool.query(`SELECT COALESCE(MAX(Orden), 0) AS m FROM ${TABLA} WHERE Eliminado = 0`);
  const [r] = await pool.query(
    `INSERT INTO ${TABLA} (Nombre, TokenCifrado, Ultimos4, Activo, Orden, CreadoPorId, ActualizadoPorId) VALUES (?, ?, ?, 1, ?, ?, ?)`,
    [n, cifrado, t.slice(-4), Number(max.m) + 1, usuarioId || null, usuarioId || null],
  );
  invalidar();
  return { id: r.insertId, nombre: n, ultimos4: t.slice(-4) };
}

async function filaPorId(pool, id) {
  const [filas] = await pool.query(`SELECT * FROM ${TABLA} WHERE Id = ? AND Eliminado = 0`, [id]);
  if (!filas.length) throw new ErrorConfig('Ese token no existe.', 404, 'NO_ENCONTRADO');
  return filas[0];
}

async function actualizar(pool, id, { nombre, activo, token }, usuarioId) {
  await garantizarTabla(pool);
  const fila = await filaPorId(pool, id);
  const sets = []; const vals = [];
  if (nombre !== undefined) { sets.push('Nombre = ?'); vals.push(validarNombre(nombre)); }
  if (activo !== undefined) { sets.push('Activo = ?'); vals.push(activo ? 1 : 0); }
  if (token !== undefined && String(token).trim() !== '') {
    const t = validarToken(token);
    sets.push('TokenCifrado = ?', 'Ultimos4 = ?', 'ResultadoPrueba = NULL', 'ProbadoEn = NULL');
    vals.push(cifrar(t), t.slice(-4));
  }
  if (!sets.length) return { id: fila.Id };
  sets.push('ActualizadoPorId = ?'); vals.push(usuarioId || null);
  await pool.query(`UPDATE ${TABLA} SET ${sets.join(', ')} WHERE Id = ?`, [...vals, id]);
  invalidar();
  return { id: fila.Id };
}

async function eliminar(pool, id, usuarioId) {
  await garantizarTabla(pool);
  const fila = await filaPorId(pool, id);
  await pool.query(
    `UPDATE ${TABLA} SET Eliminado = 1, Activo = 0, TokenCifrado = '', Ultimos4 = '', ResultadoPrueba = NULL, ActualizadoPorId = ? WHERE Id = ?`,
    [usuarioId || null, id],
  );
  invalidar();
  return { id: fila.Id, nombre: fila.Nombre };
}

async function reordenar(pool, ids, usuarioId) {
  await garantizarTabla(pool);
  if (!Array.isArray(ids) || ids.length > 100 || ids.some((i) => !Number.isInteger(i))) throw new ErrorConfig('El orden no es válido.');
  let n = 1;
  for (const id of ids) {
    await pool.query(`UPDATE ${TABLA} SET Orden = ?, ActualizadoPorId = ? WHERE Id = ? AND Eliminado = 0`, [n++, usuarioId || null, id]);
  }
  invalidar();
}

// Token en claro de uno guardado (uso interno: probar su alcance).
async function valorDe(pool, id) {
  const fila = await filaPorId(pool, id);
  try { return { id: fila.Id, nombre: fila.Nombre, valor: descifrar(fila.TokenCifrado) }; } catch {
    throw new ErrorConfig('No se pudo descifrar este token (cambió la clave del servidor). Vuelve a pegarlo.', 409, 'ILEGIBLE');
  }
}

async function guardarResultadoPrueba(pool, id, resultado) {
  await pool.query(`UPDATE ${TABLA} SET ResultadoPrueba = ?, ProbadoEn = NOW() WHERE Id = ?`, [JSON.stringify(resultado), id]);
  invalidar();
}

// --- Ajustes (organización, proyecto, repositorio, rama) -------------------------------------

async function garantizarTablaAjustes(pool) {
  if (await tablaExiste(pool, TABLA_AJUSTES)) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLA_AJUSTES} (
      Clave VARCHAR(50) NOT NULL PRIMARY KEY,
      Valor VARCHAR(255) NOT NULL,
      ActualizadoPorId INT NULL,
      ActualizadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
  } catch (err) {
    if (esErrorDePrivilegios(err)) throw new ErrorConfig('Falta la tabla ConfiguracionSistema. Ejecuta crear_tabla_configuracion_sistema_BIC_CERTI_MARIA.sql.', 409, 'SIN_TABLA');
    throw err;
  }
}

async function guardarAjustes(pool, entrada, usuarioId) {
  const limpio = {};
  const reglas = { org: [ORG_VALIDA, 'La organización solo puede tener letras, números, punto, guion y guion bajo.'],
    project: [REPO_VALIDO, 'El nombre del proyecto no es válido.'],
    repo: [REPO_VALIDO, 'El nombre del repositorio no es válido.'],
    branch: [RAMA_VALIDA, 'El nombre de la rama no es válido.'] };
  for (const [campo, [patron, mensaje]] of Object.entries(reglas)) {
    const v = String(entrada?.[campo] ?? '').trim();
    if (v && (!patron.test(v) || v.includes('..'))) throw new ErrorConfig(mensaje);
    limpio[campo] = v; // '' = volver al valor del .env
  }
  await garantizarTablaAjustes(pool);
  for (const [campo, claveBd] of Object.entries(CLAVES_AJUSTES)) {
    await pool.query(
      `INSERT INTO ${TABLA_AJUSTES} (Clave, Valor, ActualizadoPorId) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE Valor = VALUES(Valor), ActualizadoPorId = VALUES(ActualizadoPorId)`,
      [claveBd, limpio[campo], usuarioId || null],
    );
  }
  invalidar();
  return limpio;
}

module.exports = {
  TABLA, SQL_CREAR, ErrorConfig, asegurar, invalidar, cfg, candidatos, marcar,
  listar, crear, actualizar, eliminar, reordenar, valorDe, guardarResultadoPrueba, guardarAjustes,
  _prueba: { cifrar, descifrar },
};
