const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');
const { compararCodigoAce } = require('../utils/ordenarCodigoAce');
const { columnasFaltantes } = require('../utils/esquemaSeguro');
const {
  garantizarEsquemaSubaplicativos,
  reconstruirDescripcionServidor,
  asegurarFicha,
} = require('../utils/subaplicativosSchema');

// ==========================================
// INVENTARIO DE SUB-APLICATIVOS
//
// Un "sub-aplicativo" es un componente registrado en la pantalla Aplicaciones
// (Servidor_Componentes: nombre + puerto + tipo dentro de un servidor). Cada
// componente aparece aquí automáticamente; la ficha técnica de detalle vive
// en inv_aplicativos (enlazada por componente_id) y se crea la primera vez
// que alguien guarda el detalle.
//
// Las integraciones y las conexiones a base de datos siguen colgando de
// inv_aplicativos.aplicacion_id (Aplicaciones.Id de la ficha), así que esas
// pantallas/endpoints existentes (/api/servidoresInventario/aplicativos/
// :appId/...) siguen funcionando sin cambios.
// ==========================================

const ESTADOS = ['Activo', 'Inactivo', 'En mantenimiento', 'Deprecado'];
const CRITICIDADES = ['Alta', 'Media', 'Baja'];
const TIPOS = ['ms', 'api', 'gateway', 'log', 'db', 'job', 'kafka', 'suscriptor', 'orquestador', 'doc', 'balanceador', 'otro'];

// Integraciones con SERVICIOS del inventario de Servicios (BUS ACE 12 / BUS 10).
// La tabla la crea el script crear_tabla_integraciones_servicios_subaplicativos.sql;
// mientras no exista, el resto del módulo sigue funcionando y estas funciones avisan.
const T_SERVICIOS_BUS = 'inv_aplicativo_servicios_bus';
const BUSES = ['ACE', 'BUS10'];
const ETIQUETA_BUS = { ACE: 'BUS ACE 12', BUS10: 'BUS 10' };
const MENSAJE_SIN_TABLA_SERVICIOS =
  'Para registrar integraciones con servicios falta la tabla inv_aplicativo_servicios_bus en la base de datos. ' +
  'Pide al administrador de base de datos que ejecute una sola vez el script crear_tabla_integraciones_servicios_subaplicativos.sql.';
const esTablaInexistente = (e) => !!e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146);

// Todos los endpoints esperan primero a que el esquema/sincronización esté listo.
router.use(verifyToken, requireModule('SERVIDORES'), async (req, res, next) => {
  try {
    await garantizarEsquemaSubaplicativos(await getPool());
    next();
  } catch (error) {
    console.error('Error al preparar el esquema de sub-aplicativos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

const vacioANull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : v);
const textoONull = (v) => (vacioANull(v) === null ? null : String(v).trim());
const puertoONull = (v) => {
  if (vacioANull(v) === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : NaN;
};

// ------------------------------------------
// Consulta base de un sub-aplicativo (componente + servidor + ficha)
// ------------------------------------------
const SELECT_BASE = `
  SELECT
    sc.Id AS id, sc.Rol AS nombre, sc.Tipo AS tipo, sc.Puerto AS puerto,
    sc.ServidorId AS servidor_id, sc.FechaRegistro AS fecha_registro,
    s.Hostname AS servidor_hostname, s.IP AS servidor_ip, s.Ambiente AS ambiente,
    s.Activo AS servidor_activo,
    ia.id AS inv_id, ia.aplicacion_id AS aplicativo_id,
    ia.plataforma, ia.puntos_integracion, ia.fecha_ultimo_despliegue,
    ia.responsable_ultimo_despliegue, ia.descripcion_uso, ia.dependencias,
    ia.criticidad, ia.comandos, ia.configuracion, ia.info_seguridad,
    ia.certificado_id, ia.dev_responsable, ia.propietario,
    ia.estado, ia.version_imagen, ia.repositorio_url, ia.pipeline_url, ia.url_salud
  FROM Servidor_Componentes sc
  JOIN Servidores s ON s.Id = sc.ServidorId
  LEFT JOIN inv_aplicativos ia ON ia.componente_id = sc.Id
`;

async function adjuntarAplicacionesNegocio(pool, filas) {
  if (filas.length === 0) return filas;
  const [links] = await pool.query(
    `SELECT ac.ComponenteId AS componente_id, a.Id AS id, a.Nombre AS nombre
       FROM Aplicacion_Componente ac
       JOIN Aplicaciones a ON a.Id = ac.AplicacionId
      WHERE ac.ComponenteId IN (?)
      ORDER BY a.Nombre`,
    [filas.map((f) => f.id)]
  );
  const porComponente = {};
  for (const l of links) {
    (porComponente[l.componente_id] = porComponente[l.componente_id] || []).push({ id: l.id, nombre: l.nombre });
  }
  return filas.map((f) => ({ ...f, aplicaciones_negocio: porComponente[f.id] || [] }));
}

async function adjuntarConteos(pool, filas) {
  const ids = filas.map((f) => f.aplicativo_id).filter((id) => id);
  if (ids.length === 0) {
    return filas.map((f) => ({ ...f, total_integraciones: 0, total_conexiones_bd: 0, total_servicios_bus: 0 }));
  }
  const [integ] = await pool.query(
    `SELECT aplicativo_origen_id AS id, COUNT(*) AS total
       FROM inv_aplicativo_integraciones WHERE aplicativo_origen_id IN (?) GROUP BY aplicativo_origen_id`,
    [ids]
  );
  const [bd] = await pool.query(
    `SELECT aplicativo_id AS id, COUNT(*) AS total
       FROM inv_aplicativo_conexiones_bd WHERE aplicativo_id IN (?) GROUP BY aplicativo_id`,
    [ids]
  );
  let mapaServicios = {};
  try {
    const [sv] = await pool.query(
      `SELECT aplicativo_id AS id, COUNT(*) AS total
         FROM ${T_SERVICIOS_BUS} WHERE aplicativo_id IN (?) GROUP BY aplicativo_id`,
      [ids]
    );
    mapaServicios = Object.fromEntries(sv.map((r) => [r.id, Number(r.total)]));
  } catch (error) {
    if (!esTablaInexistente(error)) console.error('Error al contar integraciones con servicios:', error.message);
  }
  const mapaIntegraciones = Object.fromEntries(integ.map((r) => [r.id, Number(r.total)]));
  const mapaBd = Object.fromEntries(bd.map((r) => [r.id, Number(r.total)]));
  return filas.map((f) => ({
    ...f,
    total_integraciones: f.aplicativo_id ? (mapaIntegraciones[f.aplicativo_id] || 0) : 0,
    total_conexiones_bd: f.aplicativo_id ? (mapaBd[f.aplicativo_id] || 0) : 0,
    total_servicios_bus: f.aplicativo_id ? (mapaServicios[f.aplicativo_id] || 0) : 0,
  }));
}

// ------------------------------------------
// Catálogos para el formulario
// ------------------------------------------
// Servicios del inventario de Servicios (ACE 12 / BUS 10) para elegir en una
// integración. Se devuelve solo lo necesario (sin el request de ejemplo, que es
// pesado) y no exige el módulo SERVICIOS: basta con poder editar Servidores.
// Un servicio "es del BUS 10" si tiene alguna URL de BUS 10 y "es del ACE 12"
// si tiene URL de ACE 12 o no tiene ninguna de BUS 10 (misma regla que la
// pantalla Servicios).
router.get('/catalogos/servicios-bus', async (req, res) => {
  try {
    const pool = await getPool();
    const opcionales = ['Tipo', 'UrlDevBus10', 'UrlQaBus10', 'UrlPrdBus10'];
    const faltan = new Set(await columnasFaltantes(pool, 'AceServiciosInventario', opcionales));
    const col = (c, alias) => (faltan.has(c) ? `NULL AS ${alias || c}` : `${c} AS ${alias || c}`);
    const [filas] = await pool.query(
      `SELECT Id, Codigo, NombreServicio, Pod, UrlDev, UrlQa, UrlPrd, ${col('Tipo')},
              ${col('UrlDevBus10')}, ${col('UrlQaBus10')}, ${col('UrlPrdBus10')}
         FROM AceServiciosInventario`
    );
    const servicios = filas
      .sort((a, b) => compararCodigoAce(a, b, 'NombreServicio'))
      .map((f) => {
        const tieneBus10 = !!(f.UrlDevBus10 || f.UrlQaBus10 || f.UrlPrdBus10);
        const tieneAce = !!(f.UrlDev || f.UrlQa || f.UrlPrd);
        return {
          id: f.Id, codigo: f.Codigo || '', nombre: f.NombreServicio || '', tipo: f.Tipo || 'SOAP', pod: f.Pod || null,
          ace: tieneAce || !tieneBus10, bus10: tieneBus10,
        };
      });
    res.json(servicios);
  } catch (error) {
    console.error('Error al obtener servicios para sub-aplicativos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.get('/catalogos/servidores', async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(
      `SELECT Id AS id, Hostname AS hostname, IP AS ip, Ambiente AS ambiente, Activo AS activo
         FROM Servidores ORDER BY Hostname`
    );
    res.json(filas);
  } catch (error) {
    console.error('Error al obtener servidores para sub-aplicativos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.get('/catalogos/opciones', (req, res) => {
  res.json({ estados: ESTADOS, criticidades: CRITICIDADES, tipos: TIPOS });
});

// ------------------------------------------
// GET / — lista de todos los sub-aplicativos
// ------------------------------------------
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    let [filas] = await pool.query(`${SELECT_BASE} ORDER BY s.Hostname, sc.Rol`);
    filas = await adjuntarAplicacionesNegocio(pool, filas);
    filas = await adjuntarConteos(pool, filas);
    res.json(filas);
  } catch (error) {
    console.error('Error al listar sub-aplicativos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ------------------------------------------
// GET /:id — ficha completa
// ------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    let [filas] = await pool.query(`${SELECT_BASE} WHERE sc.Id = ?`, [req.params.id]);
    if (filas.length === 0) return res.status(404).json({ error: 'Sub-aplicativo no encontrado' });
    filas = await adjuntarAplicacionesNegocio(pool, filas);
    let ficha = filas[0];

    ficha.certificado_nombre = null;
    if (ficha.certificado_id) {
      const [cert] = await pool.query(
        'SELECT NombreComun, FechaFin FROM Certificados WHERE Id = ?',
        [ficha.certificado_id]
      );
      if (cert.length) {
        ficha.certificado_nombre = cert[0].NombreComun;
        ficha.certificado_fecha_fin = cert[0].FechaFin;
      }
    }

    ficha.integraciones = [];
    ficha.conexiones_bd = [];
    ficha.integraciones_servicios = [];
    ficha.integraciones_servicios_disponible = true;
    if (ficha.aplicativo_id) {
      const [integraciones] = await pool.query(`
        SELECT
          i.id, i.descripcion,
          CASE WHEN i.aplicativo_destino_id IS NOT NULL THEN 'aplicativo' ELSE 'servidor' END AS tipo_destino,
          COALESCE(ap.Nombre, sv.Hostname) AS nombre_destino,
          COALESCE(sv2.Hostname, sv.Hostname) AS servidor_relacionado
        FROM inv_aplicativo_integraciones i
        LEFT JOIN Aplicaciones ap ON ap.Id = i.aplicativo_destino_id
        LEFT JOIN Servidores sv2 ON sv2.Id = ap.ServidorId
        LEFT JOIN Servidores sv ON sv.Id = i.servidor_destino_id
        WHERE i.aplicativo_origen_id = ?
        ORDER BY i.id
      `, [ficha.aplicativo_id]);
      ficha.integraciones = integraciones;

      const [conexiones] = await pool.query(`
        SELECT c.id, c.servidor_bd_id, c.motor_bd, c.nombre_base_datos, c.esquema, c.puerto, c.usuario_servicio,
               sb.Hostname AS servidor_bd_hostname, sb.IP AS servidor_bd_ip
        FROM inv_aplicativo_conexiones_bd c
        INNER JOIN Servidores sb ON sb.Id = c.servidor_bd_id
        WHERE c.aplicativo_id = ?
        ORDER BY c.id
      `, [ficha.aplicativo_id]);
      ficha.conexiones_bd = conexiones;

      try {
        const [servicios] = await pool.query(`
          SELECT x.id, x.servicio_id, x.bus, x.descripcion,
                 sv.Codigo AS codigo, sv.NombreServicio AS nombre, sv.Pod AS pod
          FROM ${T_SERVICIOS_BUS} x
          LEFT JOIN AceServiciosInventario sv ON sv.Id = x.servicio_id
          WHERE x.aplicativo_id = ?
          ORDER BY x.bus, sv.Codigo, x.id
        `, [ficha.aplicativo_id]);
        ficha.integraciones_servicios = servicios.sort((a, b) => (a.bus === b.bus ? compararCodigoAce({ Codigo: a.codigo }, { Codigo: b.codigo }) : (a.bus < b.bus ? -1 : 1)));
      } catch (error) {
        if (esTablaInexistente(error)) ficha.integraciones_servicios_disponible = false;
        else throw error;
      }

      // Quién depende de este sub-aplicativo (integraciones que lo apuntan).
      const [entrantes] = await pool.query(`
        SELECT i.id, i.descripcion, ap.Nombre AS nombre_origen, sv.Hostname AS servidor_origen,
               ic.Id AS componente_origen_id
        FROM inv_aplicativo_integraciones i
        JOIN Aplicaciones ap ON ap.Id = i.aplicativo_origen_id
        LEFT JOIN Servidores sv ON sv.Id = ap.ServidorId
        LEFT JOIN inv_aplicativos ioa ON ioa.aplicacion_id = ap.Id
        LEFT JOIN Servidor_Componentes ic ON ic.Id = ioa.componente_id
        WHERE i.aplicativo_destino_id = ?
        ORDER BY i.id
      `, [ficha.aplicativo_id]);
      ficha.integraciones_entrantes = entrantes;
    } else {
      ficha.integraciones_entrantes = [];
    }

    res.json(ficha);
  } catch (error) {
    console.error(`Error al obtener sub-aplicativo ${req.params.id}:`, error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ------------------------------------------
// Validación y normalización del body (crear y editar)
// ------------------------------------------
function leerCuerpo(body) {
  const nombre = textoONull(body.nombre);
  const puerto = puertoONull(body.puerto);
  const tipo = textoONull(body.tipo);
  const estado = textoONull(body.estado) || 'Activo';
  const criticidad = textoONull(body.criticidad) || 'Media';

  let error = null;
  if (!nombre) error = 'El nombre del sub-aplicativo es obligatorio.';
  else if (Number.isNaN(puerto)) error = 'El puerto debe ser un número entre 1 y 65535.';
  else if (tipo && !TIPOS.includes(tipo)) error = 'El tipo de componente no es válido.';
  else if (!ESTADOS.includes(estado)) error = 'El estado no es válido.';
  else if (!CRITICIDADES.includes(criticidad)) error = 'La criticidad no es válida.';

  const idsNegocio = Array.isArray(body.aplicaciones_negocio_ids)
    ? [...new Set(body.aplicaciones_negocio_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];

  return {
    error,
    nombre, puerto, tipo, idsNegocio,
    ficha: {
      plataforma: textoONull(body.plataforma) || 'Docker',
      puntos_integracion: textoONull(body.puntos_integracion),
      fecha_ultimo_despliegue: vacioANull(body.fecha_ultimo_despliegue),
      responsable_ultimo_despliegue: textoONull(body.responsable_ultimo_despliegue),
      descripcion_uso: textoONull(body.descripcion_uso),
      dependencias: textoONull(body.dependencias),
      criticidad,
      comandos: vacioANull(body.comandos),
      configuracion: vacioANull(body.configuracion),
      info_seguridad: vacioANull(body.info_seguridad),
      certificado_id: vacioANull(body.certificado_id),
      dev_responsable: textoONull(body.dev_responsable),
      propietario: textoONull(body.propietario),
      estado,
      version_imagen: textoONull(body.version_imagen),
      repositorio_url: textoONull(body.repositorio_url),
      pipeline_url: textoONull(body.pipeline_url),
      url_salud: textoONull(body.url_salud),
    },
  };
}

const COLUMNAS_FICHA = [
  'plataforma', 'puntos_integracion', 'fecha_ultimo_despliegue', 'responsable_ultimo_despliegue',
  'descripcion_uso', 'dependencias', 'criticidad', 'comandos', 'configuracion', 'info_seguridad',
  'certificado_id', 'dev_responsable', 'propietario', 'estado', 'version_imagen',
  'repositorio_url', 'pipeline_url', 'url_salud',
];

async function guardarFicha(conn, invId, ficha, puerto, primerNegocioId) {
  const sets = COLUMNAS_FICHA.map((c) => `${c} = ?`).join(', ');
  await conn.query(
    // `puerto` e `aplicacion_negocio_id` de la ficha vieja se mantienen en
    // sincronía porque Impacto/reportes todavía los leen.
    `UPDATE inv_aplicativos SET ${sets}, puerto = ?, aplicacion_negocio_id = ? WHERE id = ?`,
    [...COLUMNAS_FICHA.map((c) => ficha[c]), puerto, primerNegocioId, invId]
  );
}

// Reemplaza las aplicaciones de negocio a las que pertenece el componente y
// reconstruye Aplicacion_Servidor.Descripcion de todas las afectadas.
async function guardarAplicacionesNegocio(conn, componenteId, servidorId, idsNuevos) {
  const [antes] = await conn.query(
    'SELECT AplicacionId FROM Aplicacion_Componente WHERE ComponenteId = ?',
    [componenteId]
  );
  const idsAntes = antes.map((r) => r.AplicacionId);

  await conn.query('DELETE FROM Aplicacion_Componente WHERE ComponenteId = ?', [componenteId]);
  if (idsNuevos.length) {
    // Solo ids que realmente son aplicaciones de negocio.
    const [validos] = await conn.query(
      'SELECT Id FROM Aplicaciones WHERE Id IN (?) AND ServidorId IS NULL',
      [idsNuevos]
    );
    for (const v of validos) {
      await conn.query(
        'INSERT IGNORE INTO Aplicacion_Componente (AplicacionId, ComponenteId) VALUES (?, ?)',
        [v.Id, componenteId]
      );
    }
  }
  const [despues] = await conn.query(
    'SELECT AplicacionId FROM Aplicacion_Componente WHERE ComponenteId = ?',
    [componenteId]
  );
  const idsDespues = despues.map((r) => r.AplicacionId);

  for (const id of new Set([...idsAntes, ...idsDespues])) {
    await reconstruirDescripcionServidor(conn, id, servidorId);
  }
  return { idsAntes, idsDespues };
}

function responderErrorGuardado(res, error, contexto) {
  console.error(`Error al ${contexto} sub-aplicativo:`, error);
  if (error.code === 'ER_DUP_ENTRY') {
    const m = /for key '([^']+)'/i.exec(error.sqlMessage || '');
    const clave = m ? m[1] : '';
    if (/puerto/i.test(clave)) {
      return res.status(400).json({ error: 'Ya hay otro sub-aplicativo usando ese puerto en este servidor.' });
    }
    return res.status(400).json({ error: 'Ya existe un sub-aplicativo con ese nombre en este servidor.' });
  }
  return res.status(500).json({ error: mensajeErrorAmigable(error) });
}

// ------------------------------------------
// POST / — crear sub-aplicativo
// ------------------------------------------
router.post('/', requireEditPermission, async (req, res) => {
  const servidorId = Number(req.body.servidor_id);
  if (!Number.isInteger(servidorId) || servidorId <= 0) {
    return res.status(400).json({ error: 'Debes elegir el servidor donde está desplegado.' });
  }
  const datos = leerCuerpo(req.body);
  if (datos.error) return res.status(400).json({ error: datos.error });

  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const [srv] = await conn.query('SELECT Hostname FROM Servidores WHERE Id = ?', [servidorId]);
    if (srv.length === 0) return res.status(400).json({ error: 'El servidor elegido no existe.' });

    await conn.beginTransaction();

    const [ins] = await conn.query(
      'INSERT INTO Servidor_Componentes (ServidorId, Rol, Puerto, Tipo) VALUES (?, ?, ?, ?)',
      [servidorId, datos.nombre, datos.puerto, datos.tipo]
    );
    const componenteId = ins.insertId;

    const { invId } = await asegurarFicha(conn, componenteId, servidorId, datos.nombre);
    await guardarAplicacionesNegocio(conn, componenteId, servidorId, datos.idsNegocio);
    await guardarFicha(conn, invId, datos.ficha, datos.puerto, datos.idsNegocio[0] || null);

    await conn.commit();

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Sub-aplicativo',
      entidadId: componenteId,
      entidadNombre: datos.nombre,
      accion: 'CREACION',
      detalle: `Sub-aplicativo registrado en ${srv[0].Hostname}${datos.puerto ? ` (puerto ${datos.puerto})` : ''}`,
    });

    res.status(201).json({ id: componenteId, message: 'Sub-aplicativo registrado' });
  } catch (error) {
    await conn.rollback();
    responderErrorGuardado(res, error, 'crear');
  } finally {
    conn.release();
  }
});

// ------------------------------------------
// PUT /:id — editar sub-aplicativo (componente + ficha + aplicaciones)
// El servidor no se puede cambiar: un sub-aplicativo en otro servidor es otro
// componente distinto.
// ------------------------------------------
router.put('/:id', requireEditPermission, async (req, res) => {
  const datos = leerCuerpo(req.body);
  if (datos.error) return res.status(400).json({ error: datos.error });

  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const [antesFilas] = await conn.query(`${SELECT_BASE} WHERE sc.Id = ?`, [req.params.id]);
    if (antesFilas.length === 0) return res.status(404).json({ error: 'Sub-aplicativo no encontrado' });
    const antes = antesFilas[0];

    await conn.beginTransaction();

    await conn.query(
      'UPDATE Servidor_Componentes SET Rol = ?, Puerto = ?, Tipo = ? WHERE Id = ?',
      [datos.nombre, datos.puerto, datos.tipo, antes.id]
    );

    const { aplicacionId, invId } = await asegurarFicha(conn, antes.id, antes.servidor_id, datos.nombre);
    // Si cambió el nombre, la fila "ficha" de Aplicaciones lo sigue.
    await conn.query('UPDATE Aplicaciones SET Nombre = ? WHERE Id = ?', [datos.nombre, aplicacionId]);

    const { idsAntes, idsDespues } = await guardarAplicacionesNegocio(conn, antes.id, antes.servidor_id, datos.idsNegocio);
    await guardarFicha(conn, invId, datos.ficha, datos.puerto, idsDespues[0] || null);

    // El nombre del componente cambió: las descripciones de las aplicaciones
    // a las que pertenece (lista de roles) también.
    if (antes.nombre !== datos.nombre) {
      for (const id of idsDespues) await reconstruirDescripcionServidor(conn, id, antes.servidor_id);
    }

    await conn.commit();

    const despues = { nombre: datos.nombre, puerto: datos.puerto, tipo: datos.tipo, ...datos.ficha };
    const etiquetas = {
      nombre: 'Nombre', puerto: 'Puerto', tipo: 'Tipo', plataforma: 'Plataforma', estado: 'Estado',
      criticidad: 'Criticidad', propietario: 'Propietario', dev_responsable: 'Dev responsable',
      responsable_ultimo_despliegue: 'Responsable último despliegue',
      fecha_ultimo_despliegue: 'Fecha último despliegue', version_imagen: 'Versión / imagen',
      repositorio_url: 'Repositorio', pipeline_url: 'Pipeline', url_salud: 'URL de salud',
      certificado_id: 'Certificado', descripcion_uso: 'Descripción de uso', dependencias: 'Dependencias',
    };
    const cambios = diffCampos(antes, despues, Object.keys(etiquetas), etiquetas);
    if (JSON.stringify([...idsAntes].sort()) !== JSON.stringify([...idsDespues].sort())) {
      cambios.push({
        campo: 'aplicaciones_negocio', etiqueta: 'Aplicaciones de negocio',
        anterior: idsAntes.join(', ') || null, nuevo: idsDespues.join(', ') || null,
      });
    }

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Sub-aplicativo',
      entidadId: antes.id,
      entidadNombre: datos.nombre,
      accion: 'EDICION',
      cambios,
    });

    res.json({ message: 'Sub-aplicativo actualizado correctamente', aplicativo_id: aplicacionId });
  } catch (error) {
    await conn.rollback();
    responderErrorGuardado(res, error, 'actualizar');
  } finally {
    conn.release();
  }
});

// ------------------------------------------
// DELETE /:id — elimina el componente, su ficha y sus vínculos
// ------------------------------------------
router.delete('/:id', requireEditPermission, async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const [filas] = await conn.query(`${SELECT_BASE} WHERE sc.Id = ?`, [req.params.id]);
    if (filas.length === 0) return res.status(404).json({ error: 'Sub-aplicativo no encontrado' });
    const sub = filas[0];

    await conn.beginTransaction();

    const [links] = await conn.query(
      'SELECT AplicacionId FROM Aplicacion_Componente WHERE ComponenteId = ?',
      [sub.id]
    );
    await conn.query('DELETE FROM Aplicacion_Componente WHERE ComponenteId = ?', [sub.id]);

    // La ficha (Aplicaciones con ServidorId) se lleva consigo su detalle,
    // integraciones y conexiones a BD; si tiene certificados, el FK lo impide.
    if (sub.aplicativo_id) {
      await conn.query('DELETE FROM Aplicaciones WHERE Id = ?', [sub.aplicativo_id]);
    }
    await conn.query('DELETE FROM Servidor_Componentes WHERE Id = ?', [sub.id]);

    for (const l of links) await reconstruirDescripcionServidor(conn, l.AplicacionId, sub.servidor_id);

    await conn.commit();

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Sub-aplicativo',
      entidadId: sub.id,
      entidadNombre: sub.nombre,
      accion: 'ELIMINACION',
      detalle: `Sub-aplicativo eliminado del inventario (${sub.servidor_hostname})`,
    });

    res.status(204).send();
  } catch (error) {
    await conn.rollback();
    console.error('Error al eliminar sub-aplicativo:', error);
    if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(400).json({
        error: 'No se puede eliminar: tiene certificados, pasos de producción u otros registros asociados. Elimínalos o desvincúlalos primero.',
      });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  } finally {
    conn.release();
  }
});

// ------------------------------------------
// INTEGRACIONES y CONEXIONES A BD, direccionadas por el id del sub-aplicativo
// (componente). La ficha de origen —y la del destino, si se relaciona con otro
// sub-aplicativo— se crea al vuelo si todavía no existe, así se pueden
// registrar relaciones desde cualquier sub-aplicativo sin "guardar el detalle"
// primero. Las tablas son las mismas de siempre (inv_aplicativo_integraciones /
// inv_aplicativo_conexiones_bd), por lo que Impacto y la pantalla de Conexiones
// BD siguen viendo todo.
// ------------------------------------------
async function cargarComponente(pool, id) {
  const [filas] = await pool.query(
    'SELECT Id, ServidorId, Rol FROM Servidor_Componentes WHERE Id = ?',
    [id]
  );
  return filas[0] || null;
}

// POST /:id/integraciones  { destino_componente_id? | destino_servidor_id?, descripcion }
router.post('/:id/integraciones', requireEditPermission, async (req, res) => {
  const destinoComponenteId = Number(req.body.destino_componente_id) || null;
  const destinoServidorId = Number(req.body.destino_servidor_id) || null;
  const descripcion = textoONull(req.body.descripcion);
  if (!destinoComponenteId && !destinoServidorId) {
    return res.status(400).json({ error: 'Elige el sub-aplicativo o el servidor con el que se integra.' });
  }
  if (destinoComponenteId && destinoComponenteId === Number(req.params.id)) {
    return res.status(400).json({ error: 'Un sub-aplicativo no puede integrarse consigo mismo.' });
  }

  try {
    const pool = await getPool();
    const origen = await cargarComponente(pool, req.params.id);
    if (!origen) return res.status(404).json({ error: 'Sub-aplicativo no encontrado' });
    const { aplicacionId: origenAppId } = await asegurarFicha(pool, origen.Id, origen.ServidorId, origen.Rol);

    let destinoAppId = null;
    let nombreDestino = null;
    if (destinoComponenteId) {
      const destino = await cargarComponente(pool, destinoComponenteId);
      if (!destino) return res.status(400).json({ error: 'El sub-aplicativo destino no existe.' });
      ({ aplicacionId: destinoAppId } = await asegurarFicha(pool, destino.Id, destino.ServidorId, destino.Rol));
      nombreDestino = destino.Rol;
    } else {
      const [srv] = await pool.query('SELECT Hostname FROM Servidores WHERE Id = ?', [destinoServidorId]);
      if (!srv.length) return res.status(400).json({ error: 'El servidor destino no existe.' });
      nombreDestino = srv[0].Hostname;
    }

    const [result] = await pool.query(
      `INSERT INTO inv_aplicativo_integraciones (aplicativo_origen_id, aplicativo_destino_id, servidor_destino_id, descripcion)
       VALUES (?, ?, ?, ?)`,
      [origenAppId, destinoAppId, destinoAppId ? null : destinoServidorId, descripcion]
    );

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Integración de aplicativo',
      entidadId: result.insertId,
      entidadNombre: descripcion || `${origen.Rol} → ${nombreDestino}`,
      accion: 'CREACION',
      detalle: `Integración creada: ${origen.Rol} → ${nombreDestino}`,
    });

    res.status(201).json({ id: result.insertId, aplicativo_id: origenAppId });
  } catch (error) {
    console.error('Error al crear integración de sub-aplicativo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// DELETE /:id/integraciones/:integracionId
router.delete('/:id/integraciones/:integracionId', requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [result] = await pool.query(
      `DELETE i FROM inv_aplicativo_integraciones i
         JOIN inv_aplicativos ia ON ia.aplicacion_id = i.aplicativo_origen_id
        WHERE i.id = ? AND ia.componente_id = ?`,
      [req.params.integracionId, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Integración no encontrada' });

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Integración de aplicativo',
      entidadId: req.params.integracionId,
      accion: 'ELIMINACION',
      detalle: 'Integración de aplicativo eliminada',
    });
    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar integración de sub-aplicativo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// POST /:id/conexiones-bd  { servidor_bd_id, motor_bd, nombre_base_datos, esquema, puerto, usuario_servicio }
router.post('/:id/conexiones-bd', requireEditPermission, async (req, res) => {
  const servidorBdId = Number(req.body.servidor_bd_id) || null;
  const motor = textoONull(req.body.motor_bd);
  const nombreBd = textoONull(req.body.nombre_base_datos);
  const puerto = puertoONull(req.body.puerto);
  if (!servidorBdId || !motor || !nombreBd) {
    return res.status(400).json({ error: 'El servidor de BD, el motor y el nombre de la base de datos son obligatorios.' });
  }
  if (Number.isNaN(puerto)) return res.status(400).json({ error: 'El puerto debe ser un número entre 1 y 65535.' });

  try {
    const pool = await getPool();
    const origen = await cargarComponente(pool, req.params.id);
    if (!origen) return res.status(404).json({ error: 'Sub-aplicativo no encontrado' });
    const { aplicacionId } = await asegurarFicha(pool, origen.Id, origen.ServidorId, origen.Rol);

    const [result] = await pool.query(
      `INSERT INTO inv_aplicativo_conexiones_bd
         (aplicativo_id, servidor_bd_id, motor_bd, nombre_base_datos, esquema, puerto, usuario_servicio)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [aplicacionId, servidorBdId, motor, nombreBd, textoONull(req.body.esquema), puerto, textoONull(req.body.usuario_servicio)]
    );

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Conexión BD',
      entidadId: result.insertId,
      entidadNombre: nombreBd,
      accion: 'CREACION',
      detalle: `Conexión BD registrada para ${origen.Rol} (motor: ${motor})`,
    });

    res.status(201).json({ id: result.insertId, aplicativo_id: aplicacionId });
  } catch (error) {
    console.error('Error al crear conexión BD de sub-aplicativo:', error);
    if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
      return res.status(400).json({ error: 'El servidor de BD indicado no existe.' });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// DELETE /:id/conexiones-bd/:conexionId
router.delete('/:id/conexiones-bd/:conexionId', requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [antes] = await pool.query(
      `SELECT c.nombre_base_datos FROM inv_aplicativo_conexiones_bd c
         JOIN inv_aplicativos ia ON ia.aplicacion_id = c.aplicativo_id
        WHERE c.id = ? AND ia.componente_id = ?`,
      [req.params.conexionId, req.params.id]
    );
    if (antes.length === 0) return res.status(404).json({ error: 'Conexión BD no encontrada' });

    await pool.query('DELETE FROM inv_aplicativo_conexiones_bd WHERE id = ?', [req.params.conexionId]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Conexión BD',
      entidadId: req.params.conexionId,
      entidadNombre: antes[0].nombre_base_datos,
      accion: 'ELIMINACION',
      detalle: 'Conexión BD eliminada',
    });
    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar conexión BD de sub-aplicativo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// POST /:id/integraciones-servicios  { servicio_id, bus: 'ACE' | 'BUS10', descripcion? }
router.post('/:id/integraciones-servicios', requireEditPermission, async (req, res) => {
  const servicioId = Number(req.body.servicio_id) || null;
  const bus = String(req.body.bus || '').trim().toUpperCase();
  const descripcion = textoONull(req.body.descripcion);
  if (!BUSES.includes(bus)) return res.status(400).json({ error: 'Elige el bus: ACE (BUS ACE 12) o BUS 10.' });
  if (!servicioId) return res.status(400).json({ error: 'Elige el servicio con el que se integra.' });
  if (descripcion && descripcion.length > 255) return res.status(400).json({ error: 'La nota no puede superar los 255 caracteres.' });

  try {
    const pool = await getPool();
    const origen = await cargarComponente(pool, req.params.id);
    if (!origen) return res.status(404).json({ error: 'Sub-aplicativo no encontrado' });
    const [srv] = await pool.query('SELECT Id, Codigo, NombreServicio FROM AceServiciosInventario WHERE Id = ?', [servicioId]);
    if (!srv.length) return res.status(400).json({ error: 'El servicio elegido ya no existe en el inventario de Servicios.' });
    const { aplicacionId } = await asegurarFicha(pool, origen.Id, origen.ServidorId, origen.Rol);

    const [result] = await pool.query(
      `INSERT INTO ${T_SERVICIOS_BUS} (aplicativo_id, servicio_id, bus, descripcion, fecha_registro) VALUES (?, ?, ?, ?, NOW())`,
      [aplicacionId, servicioId, bus, descripcion]
    );

    const nombreServicio = `${srv[0].Codigo ? srv[0].Codigo + ' ' : ''}${srv[0].NombreServicio}`;
    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Integración con servicio',
      entidadId: result.insertId,
      entidadNombre: nombreServicio,
      accion: 'CREACION',
      detalle: `${origen.Rol} se integra con el servicio ${nombreServicio} (${ETIQUETA_BUS[bus]})`,
    });

    res.status(201).json({ id: result.insertId, aplicativo_id: aplicacionId });
  } catch (error) {
    if (esTablaInexistente(error)) return res.status(503).json({ error: MENSAJE_SIN_TABLA_SERVICIOS });
    if (error.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: `Este sub-aplicativo ya tiene registrado ese servicio en el ${ETIQUETA_BUS[bus]}.` });
    console.error('Error al crear integración con servicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// DELETE /:id/integraciones-servicios/:integracionId
router.delete('/:id/integraciones-servicios/:integracionId', requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [antes] = await pool.query(
      `SELECT x.bus, sv.Codigo, sv.NombreServicio
         FROM ${T_SERVICIOS_BUS} x
         JOIN inv_aplicativos ia ON ia.aplicacion_id = x.aplicativo_id
         LEFT JOIN AceServiciosInventario sv ON sv.Id = x.servicio_id
        WHERE x.id = ? AND ia.componente_id = ?`,
      [req.params.integracionId, req.params.id]
    );
    if (antes.length === 0) return res.status(404).json({ error: 'Integración con servicio no encontrada' });

    await pool.query(`DELETE FROM ${T_SERVICIOS_BUS} WHERE id = ?`, [req.params.integracionId]);

    const nombre = `${antes[0].Codigo ? antes[0].Codigo + ' ' : ''}${antes[0].NombreServicio || ''}`.trim();
    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Integración con servicio',
      entidadId: req.params.integracionId,
      entidadNombre: nombre || null,
      accion: 'ELIMINACION',
      detalle: `Integración con servicio eliminada${nombre ? `: ${nombre}` : ''} (${ETIQUETA_BUS[antes[0].bus] || antes[0].bus})`,
    });
    res.status(204).send();
  } catch (error) {
    if (esTablaInexistente(error)) return res.status(503).json({ error: MENSAJE_SIN_TABLA_SERVICIOS });
    console.error('Error al eliminar integración con servicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

module.exports = router;
