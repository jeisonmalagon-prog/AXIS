// Pantalla principal (Inicio): catálogo de widgets, configuración que define
// el ADMIN_POD y proveedores de datos en vivo.
//
//  - El CATÁLOGO vive aquí (en código): cada widget declara el módulo que
//    exige (null = cualquier usuario), su proveedor de datos y sus valores por
//    defecto. Agregar un widget nuevo = agregar una entrada aquí + su vista en
//    el frontend.
//  - La CONFIGURACIÓN (habilitado, orden, ancho, refresco, solo admin) se
//    guarda en la tabla inicio_widgets_config. Si la tabla no existe todavía,
//    se usan los valores por defecto del catálogo (la pantalla funciona) y
//    guardar avisa que falta ejecutar el script.
//  - Los datos se cachean pocos segundos EN EL SERVIDOR: aunque muchos
//    usuarios tengan la pantalla abierta, Portainer/F5/BD se consultan una
//    sola vez por ventana de caché.

const { getPool } = require('../db');
const { tablaExiste, esErrorDePrivilegios } = require('./esquemaSeguro');
const M = require('./inicioMonitoreo');

const TABLA = 'inicio_widgets_config';
const ANCHOS_VALIDOS = [2, 3, 4, 6]; // columnas de una grilla de 6: tercio, mitad, dos tercios, completo
const INTERVALO_MIN = 10;
const INTERVALO_MAX = 600;

const { conCache } = M;

// ---------------------------------------------------------------------------
// Proveedores de datos (los de Portainer/F5 viven en inicioMonitoreo.js)
// ---------------------------------------------------------------------------
async function datosCertificados() {
  const pool = await getPool();
  // Solo certificados en uso (los "sin uso detectado" no cuentan en el widget de Inicio).
  const filtroUso = await require('./certificadosUso').condicionEnUso(pool);
  const [conteos] = await pool.query(`SELECT Estado, COUNT(*) AS total FROM VW_CertificadosVigencia WHERE 1 = 1${filtroUso} GROUP BY Estado`);
  const resumen = { vigentes: 0, porVencer: 0, vencidos: 0 };
  for (const f of conteos) {
    if (f.Estado === 'Vigente') resumen.vigentes = Number(f.total);
    else if (f.Estado === 'Por vencer') resumen.porVencer = Number(f.total);
    else if (f.Estado === 'Vencido') resumen.vencidos = Number(f.total);
  }
  const [proximos] = await pool.query(
    `SELECT Aplicacion, Hostname, NombreComun, FechaFin, DiasRestantes, Estado
       FROM VW_CertificadosVigencia
      WHERE DiasRestantes <= 60${filtroUso}
      ORDER BY DiasRestantes ASC
      LIMIT 7`
  );
  return {
    resumen,
    proximos: proximos.map((p) => ({
      aplicacion: p.Aplicacion, servidor: p.Hostname, nombreComun: p.NombreComun,
      fechaFin: p.FechaFin, dias: Number(p.DiasRestantes), estado: p.Estado,
    })),
  };
}

async function datosPasos(req) {
  const pool = await getPool();
  // Cada persona ve los pasos de SU bitácora (los que creó, ejecutó o en los que participa).
  const bit = require('./bitacoraAcceso');
  const mia = bit.condicionMia('p', req.user);
  // Lo eliminado (lógicamente) no cuenta en el tablero.
  mia.sql = `${mia.sql} AND ${await bit.sqlActivo(pool, 'p')}`;
  const [estados] = await pool.query(
    `SELECT p.Estado, COUNT(*) AS total
       FROM PasosProduccion p
      WHERE p.FechaHoraProgramada >= (NOW() - INTERVAL 30 DAY) AND ${mia.sql}
      GROUP BY p.Estado`, mia.params
  );
  const porEstado = {};
  for (const f of estados) porEstado[f.Estado] = Number(f.total);
  const [proximos] = await pool.query(
    `SELECT p.Id, p.Rfc, p.Titulo, p.Entorno, p.FechaHoraProgramada
       FROM PasosProduccion p
      WHERE p.Estado = 'PROGRAMADO' AND p.FechaHoraProgramada >= (NOW() - INTERVAL 1 DAY) AND ${mia.sql}
      ORDER BY p.FechaHoraProgramada ASC
      LIMIT 6`, mia.params
  );
  const [[sem]] = await pool.query(
    `SELECT COUNT(*) AS total FROM PasosProduccion p
      WHERE p.Estado = 'PROGRAMADO' AND p.FechaHoraProgramada >= NOW() AND p.FechaHoraProgramada < (NOW() + INTERVAL 7 DAY) AND ${mia.sql}`, mia.params
  );
  return {
    porEstado,
    proximos7Dias: Number(sem.total) || 0,
    proximos: proximos.map((p) => ({
      id: p.Id, rfc: p.Rfc, titulo: p.Titulo, entorno: p.Entorno, fecha: p.FechaHoraProgramada,
    })),
  };
}

async function datosTareas(req) {
  const pool = await getPool();
  const uid = req.user.id;
  const cond = '(t.CreadoPorId = ? OR EXISTS (SELECT 1 FROM TareaAsignados ta WHERE ta.TareaId = t.Id AND ta.UsuarioId = ?))';
  const [estados] = await pool.query(
    `SELECT t.Estado, COUNT(*) AS total FROM Tareas t WHERE ${cond} GROUP BY t.Estado`, [uid, uid]
  );
  const porEstado = {};
  for (const f of estados) porEstado[f.Estado] = Number(f.total);
  const [[venc]] = await pool.query(
    `SELECT COUNT(*) AS total FROM Tareas t
      WHERE ${cond} AND t.Estado IN ('PENDIENTE','EN_PROGRESO') AND t.FechaLimite IS NOT NULL AND t.FechaLimite < CURDATE()`,
    [uid, uid]
  );
  const [proximas] = await pool.query(
    `SELECT t.Id, t.Titulo, t.Prioridad, t.Estado, t.FechaLimite
       FROM Tareas t
      WHERE ${cond} AND t.Estado IN ('PENDIENTE','EN_PROGRESO')
      ORDER BY t.FechaLimite IS NULL, t.FechaLimite ASC, t.FechaCreacion DESC
      LIMIT 6`,
    [uid, uid]
  );
  return {
    porEstado,
    vencidas: Number(venc.total) || 0,
    proximas: proximas.map((t) => ({ id: t.Id, titulo: t.Titulo, prioridad: t.Prioridad, estado: t.Estado, fechaLimite: t.FechaLimite })),
  };
}

async function contar(pool, sql) {
  try {
    const [[f]] = await pool.query(sql);
    return Number(f.total);
  } catch (e) {
    return null;
  }
}

async function datosInventario() {
  const pool = await getPool();
  const [servidores, activos, aplicaciones, certificados] = await Promise.all([
    contar(pool, 'SELECT COUNT(*) AS total FROM Servidores'),
    contar(pool, 'SELECT COUNT(*) AS total FROM Servidores WHERE Activo = 1'),
    contar(pool, 'SELECT COUNT(*) AS total FROM Aplicaciones'),
    contar(pool, 'SELECT COUNT(*) AS total FROM VW_CertificadosVigencia'),
  ]);
  let porSo = [];
  try {
    const [filas] = await pool.query(
      `SELECT so.Nombre AS nombre, COUNT(*) AS total
         FROM Servidores s JOIN SistemasOperativos so ON so.Id = s.SistemaOperativoId
        WHERE s.Activo = 1 GROUP BY so.Nombre ORDER BY total DESC`
    );
    porSo = filas.map((f) => ({ nombre: f.nombre, total: Number(f.total) }));
  } catch (e) { /* opcional */ }
  return { servidores, servidoresActivos: activos, aplicaciones, certificados, porSo };
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------
// ttl: segundos de caché en servidor. porUsuario: el dato depende de quién lo pide.
const CATALOGO = [
  { id: 'portainer_flota', anchoMin: 6, titulo: 'Portainer: servidores Docker', descripcion: 'Cada servidor con sus contenedores, salud y uso de CPU/memoria frente a su capacidad. Filtrable por servidor.', modulo: 'SERVIDORES', grupo: 'Monitoreo', ancho: 6, intervalo: 20, ttl: 15, filtrable: true, proveedor: M.PROVEEDORES.portainer_flota },
  { id: 'portainer_problemas', titulo: 'Portainer: contenedores con problemas', descripcion: 'Detenidos, reiniciándose o con chequeo de salud fallido, con su servidor. Filtrable.', modulo: 'SERVIDORES', grupo: 'Monitoreo', ancho: 3, intervalo: 20, ttl: 15, filtrable: true, proveedor: M.PROVEEDORES.portainer_problemas },
  { id: 'portainer_consumo', titulo: 'Portainer: mayores consumidores', descripcion: 'Contenedores con más CPU y memoria ahora; filtrable por servidor y cantidad.', modulo: 'SERVIDORES', grupo: 'Monitoreo', ancho: 3, intervalo: 20, ttl: 15, filtrable: true, proveedor: M.PROVEEDORES.portainer_consumo },
  { id: 'portainer_tendencia', anchoMin: 4, titulo: 'Portainer: tendencia de la flota', descripcion: 'CPU y memoria de los contenedores en 1 h, 6 h, 24 h o 7 días; total o por servidor.', modulo: 'SERVIDORES', grupo: 'Monitoreo', ancho: 6, intervalo: 120, ttl: 60, filtrable: true, proveedor: M.PROVEEDORES.portainer_tendencia },
  { id: 'f5_vivo', anchoMin: 6, titulo: 'F5: tráfico en vivo por Virtual Server', descripcion: 'Elige uno o varios Virtual Servers y míralos en vivo (se actualiza cada 5 s).', modulo: 'BALANCEADOR_F5', grupo: 'Monitoreo', ancho: 6, intervalo: 10, ttl: 0, propio: true, filtrable: true, proveedor: M.PROVEEDORES.f5_vivo },
  { id: 'f5_trafico', anchoMin: 4, titulo: 'F5: tráfico de nodos', descripcion: 'Entrada/salida total, conexiones y nodos con más tráfico; filtrable por equipo y rango.', modulo: 'BALANCEADOR_F5', grupo: 'Monitoreo', ancho: 6, intervalo: 60, ttl: 30, filtrable: true, proveedor: M.PROVEEDORES.f5_trafico },
  { id: 'f5_salud', titulo: 'F5: salud de Virtual Servers', descripcion: 'Disponibilidad de virtuales y nodos; busca y filtra por estado.', modulo: 'BALANCEADOR_F5', grupo: 'Monitoreo', ancho: 3, intervalo: 60, ttl: 45, filtrable: true, proveedor: M.PROVEEDORES.f5_salud },
  { id: 'certificados', titulo: 'Certificados por vencer', descripcion: 'Vigentes, por vencer y vencidos, con los más próximos.', modulo: 'CERTIFICADOS', grupo: 'Gestión', ancho: 3, intervalo: 120, ttl: 60, proveedor: datosCertificados },
  { id: 'pasos', titulo: 'Pasos a producción', descripcion: 'Próximos pasos programados de tu bitácora y resumen de los últimos 30 días.', modulo: 'PASOS_PRODUCCION', grupo: 'Gestión', ancho: 3, intervalo: 120, ttl: 0, porUsuario: true, proveedor: datosPasos },
  { id: 'tareas', titulo: 'Mis tareas', descripcion: 'Tareas pendientes del usuario que ve la pantalla.', modulo: 'TAREAS', grupo: 'Gestión', ancho: 3, intervalo: 60, ttl: 0, porUsuario: true, proveedor: datosTareas },
  { id: 'inventario', titulo: 'Inventario', descripcion: 'Servidores, aplicaciones y certificados registrados.', modulo: 'SERVIDORES', grupo: 'Gestión', ancho: 3, intervalo: 300, ttl: 120, proveedor: datosInventario },
];

const POR_ID = new Map(CATALOGO.map((w) => [w.id, w]));

// ---------------------------------------------------------------------------
// Configuración (tabla inicio_widgets_config)
// ---------------------------------------------------------------------------
function configPorDefecto(w, indice) {
  return { id: w.id, habilitado: true, orden: (indice + 1) * 10, ancho: w.ancho, intervaloSeg: w.intervalo, soloAdmin: false };
}

async function leerConfig(pool) {
  const base = new Map(CATALOGO.map((w, i) => [w.id, configPorDefecto(w, i)]));
  let tabla = false;
  try {
    tabla = await tablaExiste(pool, TABLA);
    if (tabla) {
      const [filas] = await pool.query(
        `SELECT WidgetId, Habilitado, Orden, Ancho, IntervaloSeg, SoloAdmin FROM ${TABLA}`
      );
      for (const f of filas) {
        if (!base.has(f.WidgetId)) continue;
        base.set(f.WidgetId, {
          id: f.WidgetId,
          habilitado: !!f.Habilitado,
          orden: Number(f.Orden),
          ancho: ANCHOS_VALIDOS.includes(Number(f.Ancho)) ? Number(f.Ancho) : POR_ID.get(f.WidgetId).ancho,
          intervaloSeg: Math.min(INTERVALO_MAX, Math.max(INTERVALO_MIN, Number(f.IntervaloSeg) || POR_ID.get(f.WidgetId).intervalo)),
          soloAdmin: !!f.SoloAdmin,
        });
      }
    }
  } catch (err) {
    console.error('[inicio] No se pudo leer la configuración de widgets, se usan los valores por defecto:', err.message);
  }
  return { tabla, config: [...base.values()] };
}

function limpiarEntrada(e) {
  const w = POR_ID.get(String(e.id));
  if (!w) return null;
  return {
    id: w.id,
    habilitado: e.habilitado === true || e.habilitado === 1,
    orden: Math.max(0, Math.min(9999, parseInt(e.orden, 10) || 0)),
    ancho: ANCHOS_VALIDOS.includes(Number(e.ancho)) ? Number(e.ancho) : w.ancho,
    intervaloSeg: Math.min(INTERVALO_MAX, Math.max(INTERVALO_MIN, parseInt(e.intervaloSeg, 10) || w.intervalo)),
    soloAdmin: e.soloAdmin === true || e.soloAdmin === 1,
  };
}

const SQL_CREAR = `CREATE TABLE IF NOT EXISTS ${TABLA} (
  WidgetId       VARCHAR(40)  NOT NULL PRIMARY KEY,
  Habilitado     TINYINT(1)   NOT NULL DEFAULT 1,
  Orden          INT          NOT NULL DEFAULT 0,
  Ancho          TINYINT      NOT NULL DEFAULT 3,
  IntervaloSeg   INT          NOT NULL DEFAULT 30,
  SoloAdmin      TINYINT(1)   NOT NULL DEFAULT 0,
  ActualizadoPor VARCHAR(100) NULL,
  ActualizadoEn  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`;

// Guarda la configuración (upsert; nunca borra filas: "quitar" un widget es
// deshabilitarlo). Devuelve la lista normalizada que se guardó.
async function guardarConfig(pool, entradas, username) {
  const limpias = (entradas || []).map(limpiarEntrada).filter(Boolean);
  if (!limpias.length) {
    const err = new Error('No llegó ningún widget válido para guardar.');
    err.status = 400;
    throw err;
  }
  if (!(await tablaExiste(pool, TABLA))) {
    try {
      await pool.query(SQL_CREAR);
    } catch (err) {
      if (esErrorDePrivilegios(err)) {
        const e = new Error(`Falta la tabla ${TABLA} y el usuario de la aplicación no puede crearla. Ejecuta una sola vez el script crear_tabla_inicio_widgets.sql con una cuenta con privilegios.`);
        e.status = 409;
        throw e;
      }
      throw err;
    }
  }
  const valores = limpias.map((c) => [c.id, c.habilitado ? 1 : 0, c.orden, c.ancho, c.intervaloSeg, c.soloAdmin ? 1 : 0, username || null]);
  await pool.query(
    `INSERT INTO ${TABLA} (WidgetId, Habilitado, Orden, Ancho, IntervaloSeg, SoloAdmin, ActualizadoPor)
     VALUES ?
     ON DUPLICATE KEY UPDATE Habilitado = VALUES(Habilitado), Orden = VALUES(Orden), Ancho = VALUES(Ancho),
       IntervaloSeg = VALUES(IntervaloSeg), SoloAdmin = VALUES(SoloAdmin), ActualizadoPor = VALUES(ActualizadoPor)`,
    [valores]
  );
  return limpias;
}

// ---------------------------------------------------------------------------
// Permisos
// ---------------------------------------------------------------------------
const esAdmin = (req) => req.user?.rol === 'ADMIN_POD';
const tieneModulo = (req, modulo) => !modulo || esAdmin(req) || (req.user?.modulos || []).includes(modulo);

// Widgets que ESTE usuario ve: habilitados por el admin + módulo permitido.
async function widgetsVisibles(pool, req) {
  const { config } = await leerConfig(pool);
  return config
    .filter((c) => c.habilitado && (!c.soloAdmin || esAdmin(req)) && tieneModulo(req, POR_ID.get(c.id).modulo))
    .sort((a, b) => a.orden - b.orden)
    .map((c) => {
      const w = POR_ID.get(c.id);
      return { id: c.id, titulo: w.titulo, descripcion: w.descripcion, modulo: w.modulo, ancho: Math.max(c.ancho, w.anchoMin || 0), intervaloSeg: c.intervaloSeg, filtrable: !!w.filtrable, propio: !!w.propio };
    });
}

// opcionesCrudas: lo que eligió el usuario en los filtros del cuadro (se limpia aquí; lo desconocido se descarta).
async function datosDeWidget(id, req, opcionesCrudas) {
  const w = POR_ID.get(id);
  const opciones = M.NORMALIZAR[id] ? M.NORMALIZAR[id](opcionesCrudas || {}) : {};
  const generar = () => w.proveedor(req, opciones);
  const clave = `w:${id}:${JSON.stringify(opciones)}`;
  const datos = w.porUsuario || !w.ttl ? await generar() : await conCache(clave, w.ttl * 1000, generar);
  return { id, generadoEn: new Date().toISOString(), datos };
}

// ---------------------------------------------------------------------------
// Preferencias POR USUARIO (filtros que cada persona elige en sus cuadros)
// ---------------------------------------------------------------------------
const TABLA_PREFS = 'inicio_preferencias';
const SQL_CREAR_PREFS = `CREATE TABLE IF NOT EXISTS ${TABLA_PREFS} (
  UsuarioId      INT          NOT NULL,
  WidgetId       VARCHAR(40)  NOT NULL,
  Opciones       TEXT         NOT NULL,
  ActualizadoEn  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (UsuarioId, WidgetId)
)`;

async function leerPreferencias(pool, usuarioId) {
  let tabla = false;
  const preferencias = {};
  try {
    tabla = await tablaExiste(pool, TABLA_PREFS);
    if (tabla) {
      const [filas] = await pool.query(`SELECT WidgetId, Opciones FROM ${TABLA_PREFS} WHERE UsuarioId = ?`, [usuarioId]);
      for (const f of filas) {
        if (!M.NORMALIZAR[f.WidgetId]) continue;
        try { preferencias[f.WidgetId] = M.NORMALIZAR[f.WidgetId](JSON.parse(f.Opciones)); } catch (e) { /* fila dañada: se ignora */ }
      }
    }
  } catch (err) {
    console.error('[inicio] No se pudieron leer las preferencias del usuario:', err.message);
  }
  return { tabla, preferencias };
}

async function asegurarTablaPrefs(pool) {
  if (await tablaExiste(pool, TABLA_PREFS)) return;
  try {
    await pool.query(SQL_CREAR_PREFS);
  } catch (err) {
    if (esErrorDePrivilegios(err)) {
      const e = new Error(`Falta la tabla ${TABLA_PREFS} y el usuario de la aplicación no puede crearla. Ejecuta una sola vez crear_tabla_inicio_preferencias.sql con una cuenta con privilegios. Mientras tanto tus filtros se guardan solo en este navegador.`);
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

async function guardarPreferencia(pool, usuarioId, id, opcionesCrudas) {
  if (!M.NORMALIZAR[id]) { const e = new Error('Widget desconocido.'); e.status = 404; throw e; }
  const limpias = M.NORMALIZAR[id](opcionesCrudas || {});
  await asegurarTablaPrefs(pool);
  await pool.query(
    `INSERT INTO ${TABLA_PREFS} (UsuarioId, WidgetId, Opciones) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE Opciones = VALUES(Opciones)`,
    [usuarioId, id, JSON.stringify(limpias)]
  );
  return limpias;
}

async function borrarPreferencia(pool, usuarioId, id) {
  if (!(await tablaExiste(pool, TABLA_PREFS))) return;
  await pool.query(`DELETE FROM ${TABLA_PREFS} WHERE UsuarioId = ? AND WidgetId = ?`, [usuarioId, id]);
}

module.exports = { leerPreferencias, guardarPreferencia, borrarPreferencia, TABLA_PREFS, SQL_CREAR_PREFS, NORMALIZAR: M.NORMALIZAR, CATALOGO, POR_ID, ANCHOS_VALIDOS, INTERVALO_MIN, INTERVALO_MAX, TABLA, leerConfig, guardarConfig, widgetsVisibles, datosDeWidget, esAdmin, tieneModulo, SQL_CREAR };
