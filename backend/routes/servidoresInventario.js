const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');

const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');

// ==========================================
// RUTAS PARA SERVIDORES  (sin cambios de fondo respecto a la versión anterior,
// solo se mantienen aquí para que el archivo quede completo)
// ==========================================

// Junta cada aplicativo con el nombre de su Aplicacion de negocio (si tiene
// aplicacion_negocio_id) SIN depender de que la vista vw_inventario_aplicativos
// incluya esa columna con join ya resuelto - se hace aqui mismo en JS.
async function adjuntarAplicacionNegocio(pool, aplicativos) {
  const idsNegocio = [...new Set(
    aplicativos.map(a => a.aplicacion_negocio_id).filter(id => id !== null && id !== undefined)
  )];
  if (idsNegocio.length === 0) {
    return aplicativos.map(a => ({ ...a, aplicacion_negocio_nombre: null }));
  }
  const [filas] = await pool.query(
    `SELECT Id AS id, Nombre AS nombre FROM Aplicaciones WHERE Id IN (?)`,
    [idsNegocio]
  );
  const nombrePorId = {};
  for (const f of filas) nombrePorId[f.id] = f.nombre;
  return aplicativos.map(a => ({
    ...a,
    aplicacion_negocio_nombre: a.aplicacion_negocio_id ? (nombrePorId[a.aplicacion_negocio_id] || null) : null
  }));
}

// Adjunta a cada aplicativo sus conexiones a base de datos registradas, para
// poder mostrarlas en el detalle sin pedirlas una por una desde el front.
async function adjuntarConexionesBd(pool, aplicativos) {
  const ids = aplicativos.map(a => a.id).filter(id => id !== null && id !== undefined);
  if (ids.length === 0) return aplicativos.map(a => ({ ...a, conexiones_bd: [] }));

  const [filas] = await pool.query(`
    SELECT
      c.id, c.aplicativo_id, c.motor_bd, c.nombre_base_datos, c.esquema,
      c.puerto, c.usuario_servicio,
      sb.Hostname AS servidor_bd_hostname, sb.IP AS servidor_bd_ip
    FROM inv_aplicativo_conexiones_bd c
    INNER JOIN Servidores sb ON sb.Id = c.servidor_bd_id
    WHERE c.aplicativo_id IN (?)
    ORDER BY c.id
  `, [ids]);

  const porAplicativo = {};
  for (const f of filas) {
    if (!porAplicativo[f.aplicativo_id]) porAplicativo[f.aplicativo_id] = [];
    porAplicativo[f.aplicativo_id].push(f);
  }
  return aplicativos.map(a => ({ ...a, conexiones_bd: porAplicativo[a.id] || [] }));
}

// Igual que la anterior, pero con las integraciones "normales" (relaciones con
// otros aplicativos/servidores), para que el detalle las muestre completas.
async function adjuntarIntegracionesApp(pool, aplicativos) {
  const ids = aplicativos.map(a => a.id).filter(id => id !== null && id !== undefined);
  if (ids.length === 0) return aplicativos.map(a => ({ ...a, integraciones: [] }));

  const [filas] = await pool.query(`
    SELECT
      i.id, i.aplicativo_origen_id, i.descripcion,
      CASE WHEN i.aplicativo_destino_id IS NOT NULL THEN 'aplicativo' ELSE 'servidor' END AS tipo_destino,
      COALESCE(ap.Nombre, sv.Hostname) AS nombre_destino,
      COALESCE(sv2.Hostname, sv.Hostname) AS servidor_relacionado
    FROM inv_aplicativo_integraciones i
    LEFT JOIN Aplicaciones ap ON ap.Id = i.aplicativo_destino_id
    LEFT JOIN Servidores sv2 ON sv2.Id = ap.ServidorId
    LEFT JOIN Servidores sv ON sv.Id = i.servidor_destino_id
    WHERE i.aplicativo_origen_id IN (?)
    ORDER BY i.id
  `, [ids]);

  const porAplicativo = {};
  for (const f of filas) {
    if (!porAplicativo[f.aplicativo_origen_id]) porAplicativo[f.aplicativo_origen_id] = [];
    porAplicativo[f.aplicativo_origen_id].push(f);
  }
  return aplicativos.map(a => ({ ...a, integraciones: porAplicativo[a.id] || [] }));
}

// Los Hostname siempre se guardan en MAYÚSCULAS (ver POST/PUT), pero hay
// servidores registrados antes de esa regla (p. ej. "falaappproprd"). Se
// normalizan una sola vez por proceso para que todo el inventario tenga la
// misma tipografía. Idempotente: solo toca los que difieren de su versión en
// mayúsculas (BINARY fuerza la comparación sensible a mayúsculas).
let promesaHostnames = null;
function normalizarHostnamesExistentes(pool) {
  if (!promesaHostnames) {
    promesaHostnames = pool
      .query('UPDATE Servidores SET Hostname = UPPER(TRIM(Hostname)) WHERE BINARY Hostname <> UPPER(TRIM(Hostname))')
      .then(([r]) => {
        if (r.affectedRows) console.log(`[servidores] ${r.affectedRows} hostname(s) normalizados a MAYÚSCULAS.`);
      })
      .catch((err) => {
        promesaHostnames = null; // reintenta en la siguiente petición
        console.error('No se pudieron normalizar los hostnames existentes:', err.message);
      });
  }
  return promesaHostnames;
}

// El inventario y el módulo Certificados comparten la MISMA tabla Servidores.
// La vista vw_inventario_servidores solo trae los que ya tienen ficha de
// inventario (inv_servidores); los dados de alta desde Certificados pueden no
// tenerla todavía. Para que ningún servidor "desaparezca", aquí se completan
// con los datos básicos de Servidores; al editarlos se crea su ficha.
async function servidoresSinFicha(pool, idsConFicha) {
  try {
    const filtro = idsConFicha.length ? 'WHERE s.Id NOT IN (?)' : '';
    const [filas] = await pool.query(
      `SELECT s.Id AS id, s.Hostname AS hostname, s.IP AS ip_address, s.SistemaOperativoId AS id_sistema_operativo,
              so.Nombre AS sistema_operativo, s.Ambiente AS ambiente, s.Activo AS activo
       FROM Servidores s
       LEFT JOIN SistemasOperativos so ON so.Id = s.SistemaOperativoId
       ${filtro}
       ORDER BY s.Id DESC`,
      idsConFicha.length ? [idsConFicha] : []
    );
    return filas.map((f) => ({
      id: f.id,
      hostname: f.hostname,
      ip_address: f.ip_address,
      id_sistema_operativo: f.id_sistema_operativo,
      sistema_operativo: f.sistema_operativo,
      ambiente: f.ambiente || 'PRODUCCION',
      estado: f.activo === 0 || f.activo === false ? 'INACTIVO' : 'ACTIVO',
      plataforma: null,
      criticidad: null,
      sin_ficha: true
    }));
  } catch (err) {
    console.error('No se pudieron completar los servidores sin ficha de inventario:', err.message);
    return [];
  }
}

// Estado de certificados por servidor (se cruza por hostname con la vista de
// vigencia que ya usa el módulo Certificados). Si la vista no está disponible,
// simplemente no se muestra el resumen.
async function resumenCertificadosPorServidor(pool) {
  const mapa = new Map();
  try {
    const [filas] = await pool.query('SELECT Hostname, Estado, DiasRestantes FROM VW_CertificadosVigencia');
    for (const f of filas) {
      const clave = String(f.Hostname || '').trim().toUpperCase();
      if (!clave) continue;
      const r = mapa.get(clave) || { total: 0, vencidos: 0, por_vencer: 0, dias_proximo: null };
      r.total += 1;
      if (f.Estado === 'Vencido') r.vencidos += 1;
      else if (f.Estado === 'Por vencer') r.por_vencer += 1;
      const d = Number(f.DiasRestantes);
      if (Number.isFinite(d) && (r.dias_proximo === null || d < r.dias_proximo)) r.dias_proximo = d;
      mapa.set(clave, r);
    }
  } catch (err) {
    console.error('No se pudo leer el estado de certificados por servidor:', err.message);
  }
  return mapa;
}

router.get('/', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    await normalizarHostnamesExistentes(pool);
    const [conFicha] = await pool.query('SELECT * FROM vw_inventario_servidores ORDER BY id DESC');
    const sinFicha = await servidoresSinFicha(pool, conFicha.map((s) => s.id));
    const servidores = [...conFicha, ...sinFicha];
    const certificadosPorHost = await resumenCertificadosPorServidor(pool);
    let [aplicativos] = await pool.query('SELECT * FROM vw_inventario_aplicativos ORDER BY id DESC');
    aplicativos = await adjuntarAplicacionNegocio(pool, aplicativos);
    const [integraciones] = await pool.query('SELECT servidor_origen_id, COUNT(*) AS total FROM inv_servidor_integraciones GROUP BY servidor_origen_id');

    const integracionesPorServidor = {};
    for (const fila of integraciones) integracionesPorServidor[fila.servidor_origen_id] = fila.total;

    const resultado = servidores.map(servidor => {
      const appsDelServidor = aplicativos.filter(a => a.servidor_id === servidor.id);
      const totalIntegraciones = integracionesPorServidor[servidor.id] || 0;
      const cert = certificadosPorHost.get(String(servidor.hostname || '').trim().toUpperCase());
      return {
        ...servidor,
        certificados_total: cert ? cert.total : 0,
        certificados_vencidos: cert ? cert.vencidos : 0,
        certificados_por_vencer: cert ? cert.por_vencer : 0,
        certificados_dias_proximo: cert ? cert.dias_proximo : null,
        total_aplicativos: appsDelServidor.length,
        total_integraciones: totalIntegraciones,
        total_desplegado: appsDelServidor.length + totalIntegraciones,
        aplicativos: appsDelServidor
      };
    });

    res.json(resultado);
  } catch (error) {
    console.error('Error al obtener lista de servidores:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.get('/:id', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    let [servidores] = await pool.query('SELECT * FROM vw_inventario_servidores WHERE id = ?', [req.params.id]);
    if (servidores.length === 0) {
      // Servidor dado de alta desde Certificados que aún no tiene ficha de inventario.
      const todos = await servidoresSinFicha(pool, []);
      servidores = todos.filter((s) => String(s.id) === String(req.params.id));
    }
    if (servidores.length === 0) return res.status(404).json({ error: 'Servidor no encontrado' });

    let [aplicativos] = await pool.query(
      'SELECT * FROM vw_inventario_aplicativos WHERE servidor_id = ? ORDER BY id DESC',
      [req.params.id]
    );
    aplicativos = await adjuntarAplicacionNegocio(pool, aplicativos);
    aplicativos = await adjuntarConexionesBd(pool, aplicativos);
    aplicativos = await adjuntarIntegracionesApp(pool, aplicativos);

    res.json({ ...servidores[0], aplicativos });
  } catch (error) {
    console.error(`Error al obtener servidor ${req.params.id}:`, error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.post('/', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const {
    hostname, ip_address, puerto, id_sistema_operativo, plataforma, ambiente, estado,
    descripcion, puntos_integracion, fecha_ultimo_despliegue, dependencias, criticidad,
    comandos, configuracion, info_seguridad, propietario, dev, certificado_id
  } = req.body;

  if (!hostname || !ip_address) {
    return res.status(400).json({ error: 'El Hostname y la Dirección IP son obligatorios.' });
  }

  // El Hostname siempre se guarda en MAYÚSCULAS para que el inventario quede
  // consistente sin importar cómo lo haya escrito la persona en el formulario.
  const hostnameNormalizado = hostname.trim().toUpperCase();

  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [resultServidor] = await conn.query(`
      INSERT INTO Servidores (IP, Hostname, SistemaOperativoId, Ambiente, Activo)
      VALUES (?, ?, ?, ?, ?)
    `, [ip_address, hostnameNormalizado, id_sistema_operativo || 1, ambiente || 'PRODUCCION', estado ? (estado === 'ACTIVO' ? 1 : 0) : 1]);

    const servidorId = resultServidor.insertId;

    await conn.query(`
      INSERT INTO inv_servidores (
        servidor_id, puerto, plataforma, ambiente, estado, descripcion,
        puntos_integracion, fecha_ultimo_despliegue, dependencias, criticidad,
        comandos, configuracion, info_seguridad, propietario, dev, certificado_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      servidorId, puerto || null, plataforma || null, ambiente || 'PRODUCCION', estado || 'ACTIVO',
      descripcion || null, puntos_integracion || null, fecha_ultimo_despliegue || null, dependencias || null,
      criticidad || null, comandos || null, configuracion || null, info_seguridad || null, propietario || null, dev || null,
      certificado_id || null
    ]);

    await conn.commit();

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Servidor (Inventario)',
      entidadId: servidorId,
      entidadNombre: hostnameNormalizado,
      accion: 'CREACION',
      detalle: `Servidor de inventario creado (IP: ${ip_address})`,
    });

    res.status(201).json({ id: servidorId, message: 'Servidor creado exitosamente' });
  } catch (error) {
    await conn.rollback();
    console.error('Error al crear servidor:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: `El Hostname "${hostnameNormalizado}" o la IP "${ip_address}" ya existen en la base de datos.` });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  } finally {
    conn.release();
  }
});

router.put('/:id', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const { id } = req.params;
  const {
    hostname, ip_address, puerto, id_sistema_operativo, plataforma, ambiente, estado,
    descripcion, puntos_integracion, fecha_ultimo_despliegue, dependencias, criticidad,
    comandos, configuracion, info_seguridad, propietario, dev, certificado_id
  } = req.body;

  if (!hostname || !ip_address) {
    return res.status(400).json({ error: 'El Hostname y la Dirección IP son obligatorios.' });
  }

  // El Hostname siempre se guarda en MAYÚSCULAS para que el inventario quede
  // consistente sin importar cómo lo haya escrito la persona en el formulario.
  const hostnameNormalizado = hostname.trim().toUpperCase();

  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    const [servidoresAntes] = await pool.query('SELECT * FROM Servidores WHERE Id = ?', [id]);
    const [invAntes] = await pool.query('SELECT * FROM inv_servidores WHERE servidor_id = ?', [id]);
    const antesServidor = servidoresAntes[0] || {};
    const antesInv = invAntes[0] || {};

    await conn.beginTransaction();

    const estadoActivoNuevo = estado ? (estado === 'ACTIVO' ? 1 : 0) : 1;
    const [resultServidor] = await conn.query(`
      UPDATE Servidores SET IP = ?, Hostname = ?, SistemaOperativoId = ?, Ambiente = ?, Activo = ? WHERE Id = ?
    `, [ip_address, hostnameNormalizado, id_sistema_operativo || 1, ambiente || 'PRODUCCION', estadoActivoNuevo, id]);

    if (resultServidor.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Servidor no encontrado para actualizar' });
    }

    await conn.query(`
      INSERT INTO inv_servidores (
        servidor_id, puerto, plataforma, ambiente, estado, descripcion,
        puntos_integracion, fecha_ultimo_despliegue, dependencias, criticidad,
        comandos, configuracion, info_seguridad, propietario, dev, certificado_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        puerto = VALUES(puerto), plataforma = VALUES(plataforma), ambiente = VALUES(ambiente),
        estado = VALUES(estado), descripcion = VALUES(descripcion),
        puntos_integracion = VALUES(puntos_integracion), fecha_ultimo_despliegue = VALUES(fecha_ultimo_despliegue),
        dependencias = VALUES(dependencias), criticidad = VALUES(criticidad), comandos = VALUES(comandos),
        configuracion = VALUES(configuracion),
        info_seguridad = VALUES(info_seguridad), propietario = VALUES(propietario), dev = VALUES(dev),
        certificado_id = VALUES(certificado_id)
    `, [
      id, puerto || null, plataforma || null, ambiente || 'PRODUCCION', estado || 'ACTIVO',
      descripcion || null, puntos_integracion || null, fecha_ultimo_despliegue || null, dependencias || null,
      criticidad || null, comandos || null, configuracion || null, info_seguridad || null, propietario || null, dev || null,
      certificado_id || null
    ]);

    await conn.commit();

    const cambios = [
      ...diffCampos(
        antesServidor,
        { IP: ip_address, Hostname: hostnameNormalizado, SistemaOperativoId: id_sistema_operativo || 1, Ambiente: ambiente || 'PRODUCCION', Activo: estadoActivoNuevo },
        ['IP', 'Hostname', 'SistemaOperativoId', 'Ambiente', 'Activo'],
        { IP: 'IP', Hostname: 'Hostname', SistemaOperativoId: 'Sistema operativo', Ambiente: 'Ambiente', Activo: 'Activo' }
      ),
      ...diffCampos(
        antesInv,
        { puerto: puerto || null, plataforma: plataforma || null, criticidad: criticidad || 'Media', propietario: propietario || null, dev: dev || null, certificado_id: certificado_id || null },
        ['puerto', 'plataforma', 'criticidad', 'propietario', 'dev', 'certificado_id'],
        { puerto: 'Puerto', plataforma: 'Plataforma', criticidad: 'Criticidad', propietario: 'Propietario', dev: 'Dev responsable', certificado_id: 'Certificado' }
      ),
    ];

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Servidor (Inventario)',
      entidadId: id,
      entidadNombre: hostnameNormalizado || antesServidor.Hostname,
      accion: 'EDICION',
      cambios,
    });

    res.json({ message: 'Servidor actualizado correctamente' });
  } catch (error) {
    await conn.rollback();
    console.error(`Error al actualizar servidor ${id}:`, error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: `El Hostname "${hostnameNormalizado}" o la IP "${ip_address}" ya pertenecen a otro servidor.` });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  } finally {
    conn.release();
  }
});

router.delete('/:id', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [servidoresAntes] = await pool.query('SELECT * FROM Servidores WHERE Id = ?', [req.params.id]);
    const servidorBorrado = servidoresAntes[0] || null;

    const [result] = await pool.query('DELETE FROM Servidores WHERE Id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Servidor no encontrado para eliminar' });

    if (servidorBorrado) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVIDORES',
        entidad: 'Servidor (Inventario)',
        entidadId: req.params.id,
        entidadNombre: servidorBorrado.Hostname,
        accion: 'ELIMINACION',
        detalle: `Servidor de inventario eliminado (IP: ${servidorBorrado.IP || '—'})`,
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error(`Error al eliminar servidor ${req.params.id}:`, error);
    if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(400).json({ error: 'No se puede eliminar: el servidor todavía tiene aplicativos registrados. Elimínalos primero.' });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================
// CATÁLOGOS PARA LOS DESPLEGABLES DEL FRONTEND
// ==========================================

// ==========================================
// ANALISIS DE IMPACTO
// "Si este servidor se cae, que se lleva por delante"
// ==========================================
// GET /api/servidoresInventario/impacto/:servidorId
router.get('/impacto/:servidorId', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  const id = req.params.servidorId;
  try {
    const pool = await getPool();

    const [servidores] = await pool.query('SELECT * FROM vw_inventario_servidores WHERE id = ?', [id]);
    if (servidores.length === 0) return res.status(404).json({ error: 'Servidor no encontrado' });
    const servidor = servidores[0];

    // 1) Lo que vive DENTRO del servidor: se cae con el.
    let [alojados] = await pool.query(
      'SELECT * FROM vw_inventario_aplicativos WHERE servidor_id = ? ORDER BY nombre_aplicacion',
      [id]
    );
    alojados = await adjuntarAplicacionNegocio(pool, alojados);
    const idsAlojados = alojados.map(a => a.id).filter(x => x !== null && x !== undefined);

    // 2) Quien depende de las BASES DE DATOS que este servidor aloja.
    //    Son aplicativos de OTROS servidores que se conectan aqui.
    const [dependenDeSusBd] = await pool.query(`
      SELECT
        c.id, c.motor_bd, c.nombre_base_datos, c.esquema, c.puerto, c.usuario_servicio,
        a.Id AS aplicativo_id, a.Nombre AS aplicativo_nombre,
        s.Id AS servidor_id, s.Hostname AS servidor_hostname, s.IP AS servidor_ip
      FROM inv_aplicativo_conexiones_bd c
      INNER JOIN Aplicaciones a ON a.Id = c.aplicativo_id
      LEFT JOIN Servidores s ON s.Id = a.ServidorId
      WHERE c.servidor_bd_id = ?
      ORDER BY s.Hostname, a.Nombre
    `, [id]);

    // 3) De que BASES DE DATOS depende este servidor (causas externas).
    const [conexionesSalientes] = await pool.query(`
      SELECT
        c.id, c.motor_bd, c.nombre_base_datos, c.esquema, c.puerto, c.usuario_servicio,
        a.Nombre AS aplicativo_nombre,
        sb.Id AS servidor_bd_id, sb.Hostname AS servidor_bd_hostname, sb.IP AS servidor_bd_ip
      FROM inv_aplicativo_conexiones_bd c
      INNER JOIN Aplicaciones a ON a.Id = c.aplicativo_id
      INNER JOIN Servidores sb ON sb.Id = c.servidor_bd_id
      WHERE a.ServidorId = ?
      ORDER BY sb.Hostname
    `, [id]);

    // 4) Integraciones que APUNTAN aqui (entrantes), desde otros aplicativos
    //    o desde otros servidores. Se excluye lo que sale del mismo servidor.
    const [entrantesApp] = await pool.query(`
      SELECT i.id, i.descripcion, 'aplicativo' AS origen_tipo,
             ao.Nombre AS origen_nombre, so.Hostname AS origen_servidor
      FROM inv_aplicativo_integraciones i
      INNER JOIN Aplicaciones ao ON ao.Id = i.aplicativo_origen_id
      LEFT JOIN Servidores so ON so.Id = ao.ServidorId
      WHERE (i.servidor_destino_id = ?
             OR i.aplicativo_destino_id IN (SELECT Id FROM Aplicaciones WHERE ServidorId = ?))
        AND (ao.ServidorId IS NULL OR ao.ServidorId <> ?)
      ORDER BY so.Hostname, ao.Nombre
    `, [id, id, id]);

    const [entrantesSrv] = await pool.query(`
      SELECT i.id, i.descripcion, 'servidor' AS origen_tipo,
             so.Hostname AS origen_nombre, so.Hostname AS origen_servidor
      FROM inv_servidor_integraciones i
      INNER JOIN Servidores so ON so.Id = i.servidor_origen_id
      WHERE (i.servidor_destino_id = ?
             OR i.aplicativo_destino_id IN (SELECT Id FROM Aplicaciones WHERE ServidorId = ?))
        AND i.servidor_origen_id <> ?
      ORDER BY so.Hostname
    `, [id, id, id]);

    // 5) Integraciones que SALEN de aqui (de que depende este servidor).
    const [salientes] = await pool.query(`
      SELECT i.id, i.descripcion, ao.Nombre AS origen_nombre,
             CASE WHEN i.aplicativo_destino_id IS NOT NULL THEN 'aplicativo' ELSE 'servidor' END AS destino_tipo,
             COALESCE(ap.Nombre, sv.Hostname) AS destino_nombre,
             COALESCE(sv2.Hostname, sv.Hostname) AS destino_servidor
      FROM inv_aplicativo_integraciones i
      INNER JOIN Aplicaciones ao ON ao.Id = i.aplicativo_origen_id
      LEFT JOIN Aplicaciones ap ON ap.Id = i.aplicativo_destino_id
      LEFT JOIN Servidores sv2 ON sv2.Id = ap.ServidorId
      LEFT JOIN Servidores sv ON sv.Id = i.servidor_destino_id
      WHERE ao.ServidorId = ?
      ORDER BY ao.Nombre
    `, [id]);

    // 6) Aplicaciones de negocio afectadas: las que declaran este servidor en
    //    Aplicacion_Servidor, mas las de los sub-aplicativos que se caen y las
    //    de los aplicativos externos que dependen de sus bases de datos.
    const idsNegocio = new Set();
    for (const a of alojados) if (a.aplicacion_negocio_id) idsNegocio.add(a.aplicacion_negocio_id);
    const idsExternos = [...new Set(dependenDeSusBd.map(d => d.aplicativo_id))];
    if (idsExternos.length) {
      const [externos] = await pool.query(
        'SELECT id, aplicacion_negocio_id FROM vw_inventario_aplicativos WHERE id IN (?)',
        [idsExternos]
      );
      for (const e of externos) if (e.aplicacion_negocio_id) idsNegocio.add(e.aplicacion_negocio_id);
    }

    const listaNegocio = [...idsNegocio];
    const [aplicacionesNegocio] = await pool.query(`
      SELECT DISTINCT ap.Id AS id, ap.Nombre AS nombre
      FROM Aplicaciones ap
      WHERE ap.ServidorId IS NULL
        AND (ap.Id IN (SELECT AplicacionId FROM Aplicacion_Servidor WHERE ServidorId = ?)
             ${listaNegocio.length ? 'OR ap.Id IN (?)' : ''})
      ORDER BY ap.Nombre
    `, listaNegocio.length ? [id, listaNegocio] : [id]);

    // 7) Certificados involucrados (del servidor y de sus sub-aplicativos).
    const idsCert = [...new Set(
      [servidor.certificado_id, ...alojados.map(a => a.certificado_id)]
        .filter(x => x !== null && x !== undefined)
    )];
    let certificados = [];
    if (idsCert.length) {
      const [filasCert] = await pool.query(`
        SELECT Id AS id, NombreComun AS nombre_comun, EntidadEmisora AS entidad_emisora, FechaFin AS fecha_fin
        FROM Certificados WHERE Id IN (?)
      `, [idsCert]);
      certificados = filasCert;
    }

    res.json({
      servidor,
      alojados,
      dependen_de_sus_bd: dependenDeSusBd,
      conexiones_salientes: conexionesSalientes,
      entrantes: [...entrantesApp, ...entrantesSrv],
      salientes,
      aplicaciones_negocio: aplicacionesNegocio,
      certificados
    });
  } catch (error) {
    console.error(`Error al calcular impacto del servidor ${id}:`, error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// GET /api/servidoresInventario/catalogos/certificados
// Todos los certificados disponibles (para el desplegable de "Certificado SSL")
router.get('/catalogos/certificados', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    const [certificados] = await pool.query(`
      SELECT Id AS id, NombreComun AS nombre_comun, EntidadEmisora AS entidad_emisora,
             NumeroSerie AS numero_serie, FechaFin AS fecha_fin
      FROM Certificados
      WHERE Activo = 1
      ORDER BY NombreComun
    `);
    res.json(certificados);
  } catch (error) {
    console.error('Error al obtener certificados:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// GET /api/servidoresInventario/catalogos/opciones-integracion
// Lista combinada de aplicativos y servidores para elegir como "destino"
// de una integración.
// Motores reconocidos como "Plataforma" de un servidor de base de datos —
// debe reflejar la misma lista que ofrece el <select> de Plataforma en el
// formulario de servidor (servidores.component.ts: motoresBdServidor).
const MOTORES_BD_SERVIDOR = ['MySQL', 'SQL Server', 'Oracle', 'PostgreSQL', 'MongoDB'];

router.get('/catalogos/opciones-integracion', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();

    const [servidores] = await pool.query('SELECT Id AS id, Hostname AS nombre, IP AS ip FROM Servidores ORDER BY Hostname');

    // Solo los servidores cuya Plataforma (vw_inventario_servidores) es un
    // motor de base de datos reconocido — para el selector "Servidor de Base
    // de Datos" de "Integración a base de datos", que no debe mostrar
    // servidores de aplicación (Docker, Nginx, etc).
    const placeholdersBd = MOTORES_BD_SERVIDOR.map(() => '?').join(', ');
    const [servidoresBd] = await pool.query(
      `SELECT id, hostname, ip_address FROM vw_inventario_servidores WHERE plataforma IN (${placeholdersBd}) ORDER BY hostname`,
      MOTORES_BD_SERVIDOR
    );

    // El "aplicativo" a elegir sale SOLO de los nombres sueltos guardados como
    // texto en Aplicacion_Servidor.Descripcion (ej. "Api llaves, Kafka Breb, ..."),
    // no de la tabla Aplicaciones (esa trae el nombre genérico del grupo, no el
    // detalle de qué servicio específico es).
    // Se trae tambien la Aplicacion de negocio a la que pertenece cada
    // componente, para poder relacionar un sub-aplicativo del Inventario con
    // el que ya estaba registrado en el modulo de Aplicaciones.
    const [asFilas] = await pool.query(`
      SELECT aps.ServidorId AS servidor_id, aps.Descripcion AS descripcion,
             aps.AplicacionId AS aplicacion_negocio_id, ap.Nombre AS aplicacion_negocio_nombre
      FROM Aplicacion_Servidor aps
      LEFT JOIN Aplicaciones ap ON ap.Id = aps.AplicacionId
      WHERE aps.Descripcion IS NOT NULL AND aps.Descripcion <> ''
    `);

    const vistos = new Set();
    const aplicativosCombinados = [];

    for (const fila of asFilas) {
      const nombres = fila.descripcion.split(',').map(n => n.trim()).filter(Boolean);
      for (const nombre of nombres) {
        const clave = `${fila.servidor_id}::${nombre.toLowerCase()}`;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        aplicativosCombinados.push({
          id: null,
          nombre,
          servidor_id: fila.servidor_id,
          aplicacion_negocio_id: fila.aplicacion_negocio_id,
          aplicacion_negocio_nombre: fila.aplicacion_negocio_nombre
        });
      }
    }

    res.json({
      aplicativos: aplicativosCombinados,
      servidores: servidores.map(s => ({ id: s.id, nombre: s.nombre, subtitulo: s.ip })),
      servidoresBd: servidoresBd.map(s => ({ id: s.id, nombre: s.hostname, subtitulo: s.ip_address }))
    });
  } catch (error) {
    console.error('Error al obtener opciones de integración:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================
// RUTAS PARA APLICATIVOS
// ==========================================

// GET /api/servidoresInventario/catalogos/aplicaciones-negocio
// Catalogo de Aplicaciones de negocio (las de la pantalla "Aplicaciones" de
// Certificados/Bitacora: ServidorId IS NULL) para el desplegable "Aplicación
// de negocio" del formulario de aplicativo.
router.get('/catalogos/aplicaciones-negocio', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    const [aplicaciones] = await pool.query(`
      SELECT Id AS id, Nombre AS nombre
      FROM Aplicaciones
      WHERE ServidorId IS NULL
      ORDER BY Nombre
    `);
    res.json(aplicaciones);
  } catch (error) {
    console.error('Error al obtener catálogo de Aplicaciones de negocio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// GET /api/servidoresInventario/catalogos/personas
// Catálogo COMPARTIDO de personas para los desplegables de "Dev
// Responsable", "Propietario" y "Responsable de Último Despliegue" — tanto
// del servidor completo como de cada aplicativo. Es una sola lista para los
// tres campos: la misma persona puede aparecer en cualquiera de esos roles
// según el caso, así que no tiene sentido llevar catálogos separados.
router.get('/catalogos/personas', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    const [personas] = await pool.query(`
      SELECT id, nombre
      FROM personas_responsables
      ORDER BY nombre
    `);
    res.json(personas);
  } catch (error) {
    console.error('Error al obtener catálogo de personas:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// POST /api/servidoresInventario/catalogos/personas - agrega una persona
// nueva al catálogo (el "+ Agregar" de los desplegables). Si el nombre ya
// existe (comparando sin distinguir mayúsculas/minúsculas), se devuelve la
// fila que ya había en vez de crear un duplicado.
router.post('/catalogos/personas', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });

  try {
    const pool = await getPool();
    const [existente] = await pool.query(
      'SELECT id, nombre FROM personas_responsables WHERE LOWER(nombre) = LOWER(?)',
      [nombre]
    );
    if (existente.length) return res.status(200).json(existente[0]);

    const [resultado] = await pool.query(
      'INSERT INTO personas_responsables (nombre) VALUES (?)',
      [nombre]
    );
    res.status(201).json({ id: resultado.insertId, nombre });
  } catch (error) {
    console.error('Error al agregar persona al catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.post('/:id/aplicativos', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const {
    nombre_aplicacion, plataforma, puerto, puntos_integracion,
    fecha_ultimo_despliegue, responsable_ultimo_despliegue, descripcion_uso, dependencias,
    criticidad, comandos, configuracion, info_seguridad, propietario, dev_responsable, certificado_id,
    aplicacion_negocio_id
  } = req.body;

  if (!nombre_aplicacion) return res.status(400).json({ error: 'El nombre de la aplicación es obligatorio.' });

  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [resultApp] = await conn.query('INSERT INTO Aplicaciones (Nombre, ServidorId, Activo) VALUES (?, ?, 1)', [nombre_aplicacion, req.params.id]);
    const aplicacionId = resultApp.insertId;

    await conn.query(`
      INSERT INTO inv_aplicativos (
        aplicacion_id, plataforma, puerto, puntos_integracion,
        fecha_ultimo_despliegue, responsable_ultimo_despliegue, descripcion_uso, dependencias,
        criticidad, comandos, configuracion, info_seguridad, propietario, dev_responsable, certificado_id,
        aplicacion_negocio_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      aplicacionId, plataforma || 'Docker', puerto || null, puntos_integracion || null,
      fecha_ultimo_despliegue || null, responsable_ultimo_despliegue || null, descripcion_uso || null,
      dependencias || null, criticidad || 'Media', comandos || null, configuracion || null, info_seguridad || null,
      propietario || null, dev_responsable || null, certificado_id || null, aplicacion_negocio_id || null
    ]);

    await conn.commit();

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Aplicativo',
      entidadId: aplicacionId,
      entidadNombre: nombre_aplicacion,
      accion: 'CREACION',
      detalle: `Aplicativo registrado en el servidor Id ${req.params.id}`,
    });

    res.status(201).json({ id: aplicacionId, message: 'Aplicativo registrado' });
  } catch (error) {
    await conn.rollback();
    console.error('Error al agregar aplicativo:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: `Ya existe un aplicativo llamado "${nombre_aplicacion}" en este servidor.` });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  } finally {
    conn.release();
  }
});

router.put('/aplicativos/:appId', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const {
    nombre_aplicacion, plataforma, puerto, puntos_integracion,
    fecha_ultimo_despliegue, responsable_ultimo_despliegue, descripcion_uso, dependencias,
    criticidad, comandos, configuracion, info_seguridad, propietario, dev_responsable, certificado_id,
    aplicacion_negocio_id
  } = req.body;

  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    const [aplicacionesAntes] = await pool.query('SELECT Nombre FROM Aplicaciones WHERE Id = ?', [req.params.appId]);
    const [invAplicativosAntes] = await pool.query('SELECT * FROM inv_aplicativos WHERE aplicacion_id = ?', [req.params.appId]);
    const nombreAntes = aplicacionesAntes[0]?.Nombre || null;
    const antesInvApp = invAplicativosAntes[0] || {};

    await conn.beginTransaction();

    if (nombre_aplicacion) {
      const [resultApp] = await conn.query('UPDATE Aplicaciones SET Nombre = ? WHERE Id = ?', [nombre_aplicacion, req.params.appId]);
      if (resultApp.affectedRows === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'Aplicativo no encontrado' });
      }
    }

    await conn.query(`
      INSERT INTO inv_aplicativos (
        aplicacion_id, plataforma, puerto, puntos_integracion,
        fecha_ultimo_despliegue, responsable_ultimo_despliegue, descripcion_uso, dependencias,
        criticidad, comandos, configuracion, info_seguridad, propietario, dev_responsable, certificado_id,
        aplicacion_negocio_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        plataforma = VALUES(plataforma), puerto = VALUES(puerto),
        puntos_integracion = VALUES(puntos_integracion), fecha_ultimo_despliegue = VALUES(fecha_ultimo_despliegue),
        responsable_ultimo_despliegue = VALUES(responsable_ultimo_despliegue), descripcion_uso = VALUES(descripcion_uso),
        dependencias = VALUES(dependencias), criticidad = VALUES(criticidad), comandos = VALUES(comandos),
        configuracion = VALUES(configuracion),
        info_seguridad = VALUES(info_seguridad), propietario = VALUES(propietario), dev_responsable = VALUES(dev_responsable),
        certificado_id = VALUES(certificado_id), aplicacion_negocio_id = VALUES(aplicacion_negocio_id)
    `, [
      req.params.appId, plataforma || 'Docker', puerto || null, puntos_integracion || null,
      fecha_ultimo_despliegue || null, responsable_ultimo_despliegue || null, descripcion_uso || null,
      dependencias || null, criticidad || 'Media', comandos || null, configuracion || null, info_seguridad || null,
      propietario || null, dev_responsable || null, certificado_id || null, aplicacion_negocio_id || null
    ]);

    await conn.commit();

    const cambios = [
      ...diffCampos({ Nombre: nombreAntes }, { Nombre: nombre_aplicacion || nombreAntes }, ['Nombre'], { Nombre: 'Nombre' }),
      ...diffCampos(
        antesInvApp,
        { plataforma: plataforma || 'Docker', puerto: puerto || null, criticidad: criticidad || 'Media', propietario: propietario || null, dev_responsable: dev_responsable || null, certificado_id: certificado_id || null },
        ['plataforma', 'puerto', 'criticidad', 'propietario', 'dev_responsable', 'certificado_id'],
        { plataforma: 'Plataforma', puerto: 'Puerto', criticidad: 'Criticidad', propietario: 'Propietario', dev_responsable: 'Dev responsable', certificado_id: 'Certificado' }
      ),
    ];

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Aplicativo',
      entidadId: req.params.appId,
      entidadNombre: nombre_aplicacion || nombreAntes,
      accion: 'EDICION',
      cambios,
    });

    res.json({ message: 'Aplicativo actualizado correctamente' });
  } catch (error) {
    await conn.rollback();
    console.error('Error al actualizar aplicativo:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: `Ya existe un aplicativo llamado "${nombre_aplicacion}" en este servidor.` });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  } finally {
    conn.release();
  }
});

router.delete('/aplicativos/:appId', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [aplicacionesAntes] = await pool.query('SELECT Nombre FROM Aplicaciones WHERE Id = ?', [req.params.appId]);
    const nombreBorrado = aplicacionesAntes[0]?.Nombre || null;

    const [result] = await pool.query('DELETE FROM Aplicaciones WHERE Id = ?', [req.params.appId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Aplicativo no encontrado' });

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Aplicativo',
      entidadId: req.params.appId,
      entidadNombre: nombreBorrado,
      accion: 'ELIMINACION',
      detalle: 'Aplicativo eliminado del inventario',
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar aplicativo:', error);
    if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(400).json({ error: 'No se puede eliminar: el aplicativo tiene certificados asociados. Elimínalos primero.' });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================
// INTEGRACIONES (muchos-a-muchos): origen = APLICATIVO
// ==========================================

// GET /api/servidoresInventario/aplicativos/:appId/integraciones
router.get('/aplicativos/:appId/integraciones', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(`
      SELECT
        i.id,
        i.descripcion,
        CASE WHEN i.aplicativo_destino_id IS NOT NULL THEN 'aplicativo' ELSE 'servidor' END AS tipo_destino,
        COALESCE(ap.Nombre, sv.Hostname) AS nombre_destino,
        COALESCE(sv2.Hostname, sv.Hostname) AS servidor_relacionado
      FROM inv_aplicativo_integraciones i
      LEFT JOIN Aplicaciones ap ON ap.Id = i.aplicativo_destino_id
      LEFT JOIN Servidores sv2 ON sv2.Id = ap.ServidorId
      LEFT JOIN Servidores sv ON sv.Id = i.servidor_destino_id
      WHERE i.aplicativo_origen_id = ?
      ORDER BY i.id
    `, [req.params.appId]);
    res.json(filas);
  } catch (error) {
    console.error('Error al obtener integraciones del aplicativo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// POST /api/servidoresInventario/aplicativos/:appId/integraciones
// body: { tipo: 'aplicativo' | 'servidor', destino_id, descripcion }
router.post('/aplicativos/:appId/integraciones', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const { tipo, destino_id, descripcion } = req.body;
  if (!tipo || !destino_id) return res.status(400).json({ error: 'tipo y destino_id son obligatorios.' });

  try {
    const pool = await getPool();
    const [result] = await pool.query(`
      INSERT INTO inv_aplicativo_integraciones (aplicativo_origen_id, aplicativo_destino_id, servidor_destino_id, descripcion)
      VALUES (?, ?, ?, ?)
    `, [
      req.params.appId,
      tipo === 'aplicativo' ? destino_id : null,
      tipo === 'servidor' ? destino_id : null,
      descripcion || null
    ]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Integración de aplicativo',
      entidadId: result.insertId,
      entidadNombre: descripcion || `Aplicativo ${req.params.appId} → ${tipo} ${destino_id}`,
      accion: 'CREACION',
      detalle: `Integración creada: aplicativo ${req.params.appId} → ${tipo} ${destino_id}`,
    });

    res.status(201).json({ id: result.insertId });
  } catch (error) {
    console.error('Error al crear integración:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// DELETE /api/servidoresInventario/integraciones/aplicativo/:integracionId
router.delete('/integraciones/aplicativo/:integracionId', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    await pool.query('DELETE FROM inv_aplicativo_integraciones WHERE id = ?', [req.params.integracionId]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Integración de aplicativo',
      entidadId: req.params.integracionId,
      accion: 'ELIMINACION',
      detalle: 'Integración de aplicativo eliminada',
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar integración:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================
// INTEGRACIONES (muchos-a-muchos): origen = SERVIDOR
// ==========================================

router.get('/:servidorId/integraciones', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(`
      SELECT
        i.id,
        i.descripcion,
        CASE WHEN i.aplicativo_destino_id IS NOT NULL THEN 'aplicativo' ELSE 'servidor' END AS tipo_destino,
        COALESCE(ap.Nombre, sv.Hostname) AS nombre_destino
      FROM inv_servidor_integraciones i
      LEFT JOIN Aplicaciones ap ON ap.Id = i.aplicativo_destino_id
      LEFT JOIN Servidores sv ON sv.Id = i.servidor_destino_id
      WHERE i.servidor_origen_id = ?
      ORDER BY i.id
    `, [req.params.servidorId]);
    res.json(filas);
  } catch (error) {
    console.error('Error al obtener integraciones del servidor:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.post('/:servidorId/integraciones', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const { tipo, destino_id, descripcion } = req.body;
  if (!tipo || !destino_id) return res.status(400).json({ error: 'tipo y destino_id son obligatorios.' });

  try {
    const pool = await getPool();
    const [result] = await pool.query(`
      INSERT INTO inv_servidor_integraciones (servidor_origen_id, aplicativo_destino_id, servidor_destino_id, descripcion)
      VALUES (?, ?, ?, ?)
    `, [
      req.params.servidorId,
      tipo === 'aplicativo' ? destino_id : null,
      tipo === 'servidor' ? destino_id : null,
      descripcion || null
    ]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Integración de servidor',
      entidadId: result.insertId,
      entidadNombre: descripcion || `Servidor ${req.params.servidorId} → ${tipo} ${destino_id}`,
      accion: 'CREACION',
      detalle: `Integración creada: servidor ${req.params.servidorId} → ${tipo} ${destino_id}`,
    });

    res.status(201).json({ id: result.insertId });
  } catch (error) {
    console.error('Error al crear integración:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.delete('/integraciones/servidor/:integracionId', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    await pool.query('DELETE FROM inv_servidor_integraciones WHERE id = ?', [req.params.integracionId]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Integración de servidor',
      entidadId: req.params.integracionId,
      accion: 'ELIMINACION',
      detalle: 'Integración de servidor eliminada',
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar integración:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================
// CONEXIONES A BASE DE DATOS de los Aplicativos (sub-aplicativos)
//
// Cada Aplicativo (ej. doc_manager, signature_manager) puede tener varias
// conexiones a Servidores de Base de Datos que YA existen en el Inventario
// de Servidores. La relación empieza ahí (Servidor de BD) y sobre ella se
// registran datos propios de la conexión: motor, nombre de la BD, esquema
// y puerto. Nunca se guardan credenciales.
// ==========================================

// GET /api/servidoresInventario/conexiones-bd/resumen
// Vista completa para el nuevo componente: cada Servidor con sus Aplicativos,
// y cada Aplicativo con la lista de Servidores de BD a los que se conecta.
router.get('/conexiones-bd/resumen', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();

    const [servidores] = await pool.query('SELECT Id AS id, Hostname AS hostname, IP AS ip FROM Servidores ORDER BY Hostname');
    const [aplicativos] = await pool.query('SELECT * FROM vw_inventario_aplicativos ORDER BY id');
    const [conexiones] = await pool.query(`
      SELECT
        c.id, c.aplicativo_id, c.servidor_bd_id, c.motor_bd, c.nombre_base_datos,
        c.esquema, c.puerto, c.usuario_servicio, c.fecha_registro,
        sb.Hostname AS servidor_bd_hostname, sb.IP AS servidor_bd_ip
      FROM inv_aplicativo_conexiones_bd c
      INNER JOIN Servidores sb ON sb.Id = c.servidor_bd_id
      ORDER BY c.id
    `);

    const conexionesPorAplicativo = {};
    for (const c of conexiones) {
      if (!conexionesPorAplicativo[c.aplicativo_id]) conexionesPorAplicativo[c.aplicativo_id] = [];
      conexionesPorAplicativo[c.aplicativo_id].push(c);
    }

    const aplicativosConConexiones = aplicativos.map(a => ({
      ...a,
      conexionesBd: conexionesPorAplicativo[a.id] || []
    }));

    const resultado = servidores.map(s => ({
      ...s,
      aplicativos: aplicativosConConexiones.filter(a => a.servidor_id === s.id)
    }));

    res.json(resultado);
  } catch (error) {
    console.error('Error al obtener el resumen de conexiones BD:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// GET /api/servidoresInventario/aplicativos/:appId/conexiones-bd
router.get('/aplicativos/:appId/conexiones-bd', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(`
      SELECT
        c.id, c.aplicativo_id, c.servidor_bd_id, c.motor_bd, c.nombre_base_datos,
        c.esquema, c.puerto, c.usuario_servicio, c.fecha_registro,
        sb.Hostname AS servidor_bd_hostname, sb.IP AS servidor_bd_ip
      FROM inv_aplicativo_conexiones_bd c
      INNER JOIN Servidores sb ON sb.Id = c.servidor_bd_id
      WHERE c.aplicativo_id = ?
      ORDER BY c.id
    `, [req.params.appId]);
    res.json(filas);
  } catch (error) {
    console.error('Error al obtener conexiones BD del aplicativo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// POST /api/servidoresInventario/aplicativos/:appId/conexiones-bd
// body: { servidor_bd_id, motor_bd, nombre_base_datos, esquema, puerto, usuario_servicio }
router.post('/aplicativos/:appId/conexiones-bd', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const { servidor_bd_id, motor_bd, nombre_base_datos, esquema, puerto, usuario_servicio } = req.body;

  if (!servidor_bd_id || !motor_bd || !nombre_base_datos) {
    return res.status(400).json({ error: 'El servidor de BD, el motor y el nombre de la base de datos son obligatorios.' });
  }

  try {
    const pool = await getPool();
    const [result] = await pool.query(`
      INSERT INTO inv_aplicativo_conexiones_bd
        (aplicativo_id, servidor_bd_id, motor_bd, nombre_base_datos, esquema, puerto, usuario_servicio)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [req.params.appId, servidor_bd_id, motor_bd, nombre_base_datos, esquema || null, puerto || null, usuario_servicio || null]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Conexión BD',
      entidadId: result.insertId,
      entidadNombre: nombre_base_datos,
      accion: 'CREACION',
      detalle: `Conexión BD registrada para el aplicativo ${req.params.appId} (motor: ${motor_bd})`,
    });

    res.status(201).json({ id: result.insertId, message: 'Conexión BD registrada' });
  } catch (error) {
    console.error('Error al crear conexión BD:', error);
    if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
      return res.status(400).json({ error: 'El aplicativo o el servidor de BD indicados no existen.' });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// PUT /api/servidoresInventario/conexiones-bd/:conexionId
router.put('/conexiones-bd/:conexionId', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const { servidor_bd_id, motor_bd, nombre_base_datos, esquema, puerto, usuario_servicio } = req.body;

  if (!servidor_bd_id || !motor_bd || !nombre_base_datos) {
    return res.status(400).json({ error: 'El servidor de BD, el motor y el nombre de la base de datos son obligatorios.' });
  }

  try {
    const pool = await getPool();
    const [conexionesAntes] = await pool.query('SELECT * FROM inv_aplicativo_conexiones_bd WHERE id = ?', [req.params.conexionId]);
    if (!conexionesAntes.length) return res.status(404).json({ error: 'Conexión BD no encontrada' });
    const antes = conexionesAntes[0];

    const [result] = await pool.query(`
      UPDATE inv_aplicativo_conexiones_bd
      SET servidor_bd_id = ?, motor_bd = ?, nombre_base_datos = ?, esquema = ?, puerto = ?, usuario_servicio = ?
      WHERE id = ?
    `, [servidor_bd_id, motor_bd, nombre_base_datos, esquema || null, puerto || null, usuario_servicio || null, req.params.conexionId]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Conexión BD no encontrada' });

    const cambios = diffCampos(
      antes,
      { servidor_bd_id, motor_bd, nombre_base_datos, esquema: esquema || null, puerto: puerto || null, usuario_servicio: usuario_servicio || null },
      ['servidor_bd_id', 'motor_bd', 'nombre_base_datos', 'esquema', 'puerto', 'usuario_servicio'],
      { servidor_bd_id: 'Servidor de BD', motor_bd: 'Motor', nombre_base_datos: 'Base de datos', esquema: 'Esquema', puerto: 'Puerto', usuario_servicio: 'Usuario de servicio' }
    );

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Conexión BD',
      entidadId: req.params.conexionId,
      entidadNombre: nombre_base_datos,
      accion: 'EDICION',
      cambios,
    });

    res.json({ message: 'Conexión BD actualizada' });
  } catch (error) {
    console.error('Error al actualizar conexión BD:', error);
    if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
      return res.status(400).json({ error: 'El servidor de BD indicado no existe.' });
    }
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// DELETE /api/servidoresInventario/conexiones-bd/:conexionId
router.delete('/conexiones-bd/:conexionId', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [conexionesAntes] = await pool.query('SELECT nombre_base_datos FROM inv_aplicativo_conexiones_bd WHERE id = ?', [req.params.conexionId]);
    const nombreBorrado = conexionesAntes[0]?.nombre_base_datos || null;

    const [result] = await pool.query('DELETE FROM inv_aplicativo_conexiones_bd WHERE id = ?', [req.params.conexionId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Conexión BD no encontrada' });

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVIDORES',
      entidad: 'Conexión BD',
      entidadId: req.params.conexionId,
      entidadNombre: nombreBorrado,
      accion: 'ELIMINACION',
      detalle: 'Conexión BD eliminada',
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar conexión BD:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

module.exports = router;