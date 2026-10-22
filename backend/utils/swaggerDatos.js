// Tablas del módulo Swagger y utilidades para NO guardar secretos.
//
// Igual que el resto del proyecto, el usuario de BD de producción puede no
// tener privilegios de DDL: primero se consulta information_schema, solo se
// intenta crear lo que falta y, sin privilegios, el módulo responde con un
// mensaje claro pidiendo ejecutar crear_tablas_swagger.sql (se vuelve a
// verificar solo cada 30 s, sin reiniciar el backend).
//
// Privacidad por usuario: cada origen es de quien lo registró (CreadoPorId) y
// solo se comparte si su dueño quiere: con todos (CompartidoTodos = 1) o con
// usuarios concretos (swagger_origenes_compartidos). Si esa parte del esquema
// falta, el módulo NO se abre (para no mostrar los orígenes de todos a todos)
// hasta ejecutar agregar_swagger_privado.sql.

const { tablaExiste, columnasFaltantes, esErrorDePrivilegios } = require('./esquemaSeguro');

const TABLAS = {
  swagger_origenes: `
    CREATE TABLE IF NOT EXISTS swagger_origenes (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      Nombre VARCHAR(100) NOT NULL,
      UrlSwagger VARCHAR(500) NOT NULL,
      ValidarTls TINYINT(1) NOT NULL DEFAULT 0,
      Notas VARCHAR(500) NULL,
      Activo TINYINT(1) NOT NULL DEFAULT 1,
      CompartidoTodos TINYINT(1) NOT NULL DEFAULT 0,
      CreadoPorId INT NULL,
      CreadoPorUsername VARCHAR(100) NULL,
      FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FechaActualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_swagger_origenes_activo (Activo)
    )`,
  swagger_origenes_compartidos: `
    CREATE TABLE IF NOT EXISTS swagger_origenes_compartidos (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      OrigenId INT NOT NULL,
      UsuarioId INT NOT NULL,
      Activo TINYINT(1) NOT NULL DEFAULT 1,
      CompartidoPorId INT NULL,
      CompartidoPorUsername VARCHAR(100) NULL,
      FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FechaActualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_swagger_comp_origen_usuario (OrigenId, UsuarioId),
      INDEX idx_swagger_comp_usuario (UsuarioId, Activo)
    )`,
  swagger_consumos: `
    CREATE TABLE IF NOT EXISTS swagger_consumos (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      OrigenId INT NOT NULL,
      Nombre VARCHAR(150) NOT NULL,
      Metodo VARCHAR(10) NOT NULL,
      Ruta VARCHAR(500) NOT NULL,
      BaseUrl VARCHAR(300) NULL,
      OperacionId VARCHAR(200) NULL,
      Grupo VARCHAR(100) NULL,
      ParametrosJson MEDIUMTEXT NULL,
      Cuerpo MEDIUMTEXT NULL,
      TipoContenido VARCHAR(100) NULL,
      Notas VARCHAR(500) NULL,
      Activo TINYINT(1) NOT NULL DEFAULT 1,
      CreadoPorId INT NULL,
      CreadoPorUsername VARCHAR(100) NULL,
      FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FechaActualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_swagger_consumos_origen (OrigenId, Activo)
    )`,
  swagger_historial: `
    CREATE TABLE IF NOT EXISTS swagger_historial (
      Id BIGINT AUTO_INCREMENT PRIMARY KEY,
      OrigenId INT NOT NULL,
      ConsumoId INT NULL,
      Metodo VARCHAR(10) NOT NULL,
      Url VARCHAR(1500) NOT NULL,
      RequestHeadersJson TEXT NULL,
      RequestBody MEDIUMTEXT NULL,
      Estado INT NULL,
      EstadoTexto VARCHAR(100) NULL,
      DuracionMs INT NULL,
      ResponseHeadersJson TEXT NULL,
      ResponseBody MEDIUMTEXT NULL,
      ResponseBytes INT NULL,
      Truncado TINYINT(1) NOT NULL DEFAULT 0,
      Error VARCHAR(500) NULL,
      UsuarioId INT NULL,
      Username VARCHAR(100) NULL,
      Fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_swagger_historial_origen (OrigenId, Fecha),
      INDEX idx_swagger_historial_usuario (UsuarioId, Fecha)
    )`,
};

const MENSAJE_SIN_TABLAS =
  'Falta parte del esquema del módulo Swagger en la base de datos (tablas o la privacidad por usuario) y el usuario de la aplicación no puede crearla. ' +
  'Ejecuta una sola vez el script agregar_swagger_privado.sql (o crear_tablas_swagger.sql en instalaciones nuevas) con una cuenta con privilegios de CREATE/ALTER.';

// Columnas que se agregaron después de la primera versión de cada tabla.
const COLUMNAS_NUEVAS = {
  swagger_origenes: [
    { nombre: 'CompartidoTodos', ddl: 'ALTER TABLE swagger_origenes ADD COLUMN CompartidoTodos TINYINT(1) NOT NULL DEFAULT 0 AFTER Activo' },
  ],
};

let listas = false;
let proximaRevision = 0;
let ultimoMotivo = null;

// true si las tres tablas existen (las crea si puede). Cachea el resultado.
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
    for (const [tabla, columnas] of Object.entries(COLUMNAS_NUEVAS)) {
      const faltan = await columnasFaltantes(pool, tabla, columnas.map((c) => c.nombre));
      for (const c of columnas.filter((x) => faltan.includes(x.nombre))) {
        try {
          await pool.query(c.ddl);
        } catch (error) {
          if (esErrorDePrivilegios(error)) { ultimoMotivo = MENSAJE_SIN_TABLAS; return false; }
          throw error;
        }
      }
    }
    listas = true;
    ultimoMotivo = null;
    return true;
  } catch (error) {
    console.error('No se pudo verificar las tablas del módulo Swagger:', error.message);
    ultimoMotivo = `No se pudo verificar las tablas del módulo Swagger: ${error.message}`;
    return false;
  }
}

function motivoNoDisponible() {
  return ultimoMotivo || MENSAJE_SIN_TABLAS;
}

// ---------------------------------------------------------------------------
// Secretos: nunca se guardan en consumos ni en el historial.
// ---------------------------------------------------------------------------
const ENCABEZADO_SECRETO = /authorization|api[-_]?key|apikey|token|cookie|secret|passw|x-auth|bearer|credential/i;
const CLAVE_SECRETA = /pass(word)?|contrase|clave|secret|token|\bpin\b|cvv|api[-_]?key|authorization|credential/i;
const MARCA = '***';

function esEncabezadoSecreto(nombre) {
  return ENCABEZADO_SECRETO.test(String(nombre || ''));
}

function esClaveSecreta(nombre) {
  return CLAVE_SECRETA.test(String(nombre || ''));
}

// Lista [{k,v}] o mapa {k:v} de encabezados -> con los secretos reemplazados por `reemplazo`.
function ocultarEncabezados(encabezados, reemplazo = MARCA) {
  if (Array.isArray(encabezados)) {
    return encabezados.map((h) => ({ ...h, v: esEncabezadoSecreto(h.k) ? reemplazo : h.v }));
  }
  const salida = {};
  Object.entries(encabezados || {}).forEach(([k, v]) => { salida[k] = esEncabezadoSecreto(k) ? reemplazo : v; });
  return salida;
}

function recorrer(valor, reemplazo) {
  if (Array.isArray(valor)) return valor.map((x) => recorrer(x, reemplazo));
  if (valor && typeof valor === 'object') {
    const salida = {};
    Object.entries(valor).forEach(([k, v]) => {
      salida[k] = esClaveSecreta(k) && (typeof v === 'string' || typeof v === 'number') ? reemplazo : recorrer(v, reemplazo);
    });
    return salida;
  }
  return valor;
}

// Cuerpo JSON -> mismo JSON con los valores de claves secretas reemplazados.
// Si no es JSON (XML, texto) se deja igual: no hay forma fiable de saber qué es secreto.
function ocultarCuerpo(texto, reemplazo = MARCA) {
  if (texto === null || texto === undefined || texto === '') return texto;
  const t = String(texto);
  const limpio = t.trim();
  if (!(limpio.startsWith('{') || limpio.startsWith('['))) return t;
  try {
    return JSON.stringify(recorrer(JSON.parse(limpio), reemplazo), null, 2);
  } catch (_) {
    return t;
  }
}

// Query string de una URL: oculta el valor de parámetros con nombre secreto.
function ocultarUrl(urlTexto) {
  try {
    const u = new URL(urlTexto);
    [...u.searchParams.keys()].forEach((k) => { if (esClaveSecreta(k)) u.searchParams.set(k, MARCA); });
    return u.toString().replace(/%2A%2A%2A/g, MARCA);
  } catch (_) {
    return urlTexto;
  }
}

function recortar(texto, max) {
  if (texto === null || texto === undefined) return null;
  const t = String(texto);
  return t.length > max ? t.slice(0, max) : t;
}

module.exports = {
  tablasListas, motivoNoDisponible, MENSAJE_SIN_TABLAS,
  esEncabezadoSecreto, esClaveSecreta, ocultarEncabezados, ocultarCuerpo, ocultarUrl, recortar, MARCA,
};
