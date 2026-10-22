const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');
const { reconstruirDescripcionServidor } = require('../utils/subaplicativosSchema');

// Encuentra (o crea) el componente de catálogo que corresponde a un rol
// dentro de un servidor. El PUERTO manda: si ya existe un componente en ese
// servidor+puerto, se reutiliza tal cual (nombre y tipo incluidos) para no
// crear un duplicado del mismo componente físico con otro nombre — esto es
// justo lo que evita que "PROXY_PSE" y "Proxy Pse" (o cualquier nombre
// distinto) terminen siendo dos filas separadas si en realidad es el mismo
// contenedor/sitio escuchando en el mismo puerto.
// Si no hay coincidencia por puerto, se busca por nombre (compatibilidad con
// componentes migrados que todavía no tienen puerto asignado); si ese
// componente existía sin puerto y ahora se le está asignando uno, se
// completa. Si no existe ninguna de las dos cosas, se crea de cero.
async function resolverComponente(pool, servidorId, rol, puerto, tipo) {
  const puertoNum = puerto !== undefined && puerto !== null && puerto !== '' ? Number(puerto) : null;

  if (puertoNum) {
    const [porPuerto] = await pool.query(
      'SELECT Id FROM Servidor_Componentes WHERE ServidorId = ? AND Puerto = ?',
      [servidorId, puertoNum]
    );
    if (porPuerto.length) return porPuerto[0].Id;
  }

  const [porNombre] = await pool.query(
    'SELECT Id, Puerto FROM Servidor_Componentes WHERE ServidorId = ? AND Rol = ?',
    [servidorId, rol]
  );
  if (porNombre.length) {
    const id = porNombre[0].Id;
    if (puertoNum && !porNombre[0].Puerto) {
      await pool.query('UPDATE Servidor_Componentes SET Puerto = ?, Tipo = COALESCE(?, Tipo) WHERE Id = ?', [puertoNum, tipo || null, id]);
    }
    return id;
  }

  const [ins] = await pool.query(
    'INSERT INTO Servidor_Componentes (ServidorId, Rol, Puerto, Tipo) VALUES (?, ?, ?, ?)',
    [servidorId, rol, puertoNum, tipo || null]
  );
  return ins.insertId;
}

// Guarda, para una aplicación ya creada, sus servidores + componentes.
// Reemplaza TODO lo que tenía (mismo criterio que ya usaba este archivo):
// se borra y se vuelve a insertar fresco a partir de lo que llega en el body.
// servidores: [{ id, roles: [{ rol, puerto, tipo }] }]
async function guardarServidoresYComponentes(pool, aplicacionId, servidores) {
  await pool.query('DELETE FROM Aplicacion_Servidor WHERE AplicacionId = ?', [aplicacionId]);
  await pool.query('DELETE FROM Aplicacion_Componente WHERE AplicacionId = ?', [aplicacionId]);

  if (!servidores || !servidores.length) return;

  for (const s of servidores) {
    const servidorId = s.id ?? s.Id;
    if (!servidorId) continue;

    const roles = (s.roles || []).filter((r) => r && (r.rol || r).toString().trim() !== '');

    // Aplicacion_Servidor.Descripcion se sigue manteniendo como texto plano
    // derivado (comas), porque el módulo de Impacto (servidoresInventario.js)
    // todavía la lee directamente con SQL crudo — no se elimina esta columna,
    // solo deja de ser la fuente de verdad.
    const descripcionDerivada = roles.map((r) => (r.rol || r).toString().trim()).join(', ');
    await pool.query(
      'INSERT INTO Aplicacion_Servidor (AplicacionId, ServidorId, Descripcion) VALUES (?, ?, ?)',
      [aplicacionId, servidorId, descripcionDerivada]
    );

    for (const r of roles) {
      const rol = (r.rol || r).toString().trim();
      const puerto = r.puerto ?? null;
      const tipo = r.tipo ?? null;
      const componenteId = await resolverComponente(pool, servidorId, rol, puerto, tipo);
      await pool.query(
        'INSERT IGNORE INTO Aplicacion_Componente (AplicacionId, ComponenteId) VALUES (?, ?)',
        [aplicacionId, componenteId]
      );
    }
  }
}

// NUEVO MODELO: una aplicación de negocio se arma ELIGIENDO sub-aplicativos que
// ya existen (Servidor_Componentes, que se crean/editan en Inventario →
// Sub-aplicativos). Aquí no se crea ni se renombra ningún componente: solo se
// reemplaza la lista de vínculos de esta aplicación y se mantiene al día
// Aplicacion_Servidor (que usan Impacto y los diagramas).
async function guardarComponentesDeAplicacion(pool, aplicacionId, componentesIds) {
  const ids = Array.from(new Set((componentesIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)));

  const [antes] = await pool.query(
    `SELECT DISTINCT sc.ServidorId
       FROM Aplicacion_Componente ac JOIN Servidor_Componentes sc ON sc.Id = ac.ComponenteId
      WHERE ac.AplicacionId = ?`,
    [aplicacionId]
  );
  const servidoresAfectados = new Set(antes.map((r) => r.ServidorId));

  let validos = [];
  if (ids.length) {
    [validos] = await pool.query('SELECT Id, ServidorId FROM Servidor_Componentes WHERE Id IN (?)', [ids]);
  }

  await pool.query('DELETE FROM Aplicacion_Componente WHERE AplicacionId = ?', [aplicacionId]);
  for (const v of validos) {
    await pool.query('INSERT IGNORE INTO Aplicacion_Componente (AplicacionId, ComponenteId) VALUES (?, ?)', [aplicacionId, v.Id]);
    servidoresAfectados.add(v.ServidorId);
  }
  for (const servidorId of servidoresAfectados) {
    await reconstruirDescripcionServidor(pool, aplicacionId, servidorId);
  }
  return validos.length;
}

// GET /api/aplicaciones - lista todas las apps con sus múltiples servidores y roles/puertos
router.get('/', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const pool = await getPool();

    const [apps] = await pool.query(
      `SELECT Id, Nombre, Activo, ImagenUrl FROM Aplicaciones WHERE ServidorId IS NULL ORDER BY Nombre`
    );

    const [servidoresFilas] = await pool.query(`
      SELECT aps.AplicacionId, s.Id AS ServidorId, s.Hostname, s.IP
      FROM Aplicacion_Servidor aps
      JOIN Servidores s ON s.Id = aps.ServidorId
    `);

    const [componentesFilas] = await pool.query(`
      SELECT ac.AplicacionId, sc.ServidorId, sc.Id AS ComponenteId, sc.Rol, sc.Puerto, sc.Tipo
      FROM Aplicacion_Componente ac
      JOIN Servidor_Componentes sc ON sc.Id = ac.ComponenteId
    `);

    // Mapa AplicacionId -> ServidorId -> [{ id, rol, puerto, tipo }]
    const rolesPorAppServidor = new Map();
    for (const c of componentesFilas) {
      const clave = `${c.AplicacionId}-${c.ServidorId}`;
      if (!rolesPorAppServidor.has(clave)) rolesPorAppServidor.set(clave, []);
      rolesPorAppServidor.get(clave).push({
        id: c.ComponenteId,
        rol: c.Rol,
        puerto: c.Puerto,
        tipo: c.Tipo,
      });
    }

    // Mapa AplicacionId -> [{ id, hostname, ip, roles }]
    const servidoresPorApp = new Map();
    for (const s of servidoresFilas) {
      if (!servidoresPorApp.has(s.AplicacionId)) servidoresPorApp.set(s.AplicacionId, []);
      const clave = `${s.AplicacionId}-${s.ServidorId}`;
      servidoresPorApp.get(s.AplicacionId).push({
        id: s.ServidorId,
        hostname: s.Hostname,
        ip: s.IP,
        roles: rolesPorAppServidor.get(clave) || [],
      });
    }

    const aplicaciones = apps.map((app) => ({
      id: app.Id,
      nombre: app.Nombre,
      activo: app.Activo,
      imagenUrl: app.ImagenUrl || null,
      servidores: servidoresPorApp.get(app.Id) || [],
    }));

    res.json(aplicaciones);
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// POST /api/aplicaciones - crear app con varios servidores y sus componentes (rol + puerto + tipo)
router.post('/', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  const nombre = req.body.Nombre || req.body.nombre;
  const servidores = req.body.Servidores || req.body.servidores;
  const componentesIds = req.body.ComponentesIds || req.body.componentesIds;
  const imagenUrl = req.body.ImagenUrl || req.body.imagenUrl || null;

  if (!nombre) {
    return res.status(400).json({ error: 'El nombre de la aplicación es obligatorio' });
  }

  try {
    const pool = await getPool();

    const [result] = await pool.query(
      'INSERT INTO Aplicaciones (Nombre, ImagenUrl) VALUES (?, ?)',
      [nombre, imagenUrl]
    );
    const nuevaAppId = result.insertId;

    let detalle;
    if (Array.isArray(componentesIds)) {
      const total = await guardarComponentesDeAplicacion(pool, nuevaAppId, componentesIds);
      detalle = `Aplicación de negocio creada con ${total} sub-aplicativo(s)`;
    } else {
      await guardarServidoresYComponentes(pool, nuevaAppId, servidores);
      detalle = `Aplicación creada con ${(servidores || []).length} servidor(es) asociado(s)`;
    }

    await registrarEventoGeneral(pool, req, {
      modulo: 'CERTIFICADOS',
      entidad: 'Aplicación',
      entidadId: nuevaAppId,
      entidadNombre: nombre,
      accion: 'CREACION',
      detalle,
    });

    res.status(201).json({ id: nuevaAppId, mensaje: 'Aplicación creada exitosamente' });
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// PUT /api/aplicaciones/:id - actualizar
router.put('/:id', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  const id = req.params.id;
  const nombre = req.body.Nombre || req.body.nombre;
  const servidores = req.body.Servidores || req.body.servidores;
  const componentesIds = req.body.ComponentesIds || req.body.componentesIds;
  const activo = req.body.Activo !== undefined ? req.body.Activo : req.body.activo;
  const estadoActivo = activo !== undefined ? (activo ? 1 : 0) : 1;
  const imagenUrl = req.body.ImagenUrl || req.body.imagenUrl || null;

  try {
    const pool = await getPool();

    const [appsAntes] = await pool.query('SELECT Nombre, Activo, ImagenUrl FROM Aplicaciones WHERE Id = ?', [id]);
    if (!appsAntes.length) return res.status(404).json({ error: 'Aplicación no encontrada' });
    const antes = appsAntes[0];

    const [result] = await pool.query(
      'UPDATE Aplicaciones SET Nombre = ?, Activo = ?, ImagenUrl = ? WHERE Id = ?',
      [nombre, estadoActivo, imagenUrl, id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Aplicación no encontrada' });

    let detalleCambio;
    if (Array.isArray(componentesIds)) {
      const total = await guardarComponentesDeAplicacion(pool, id, componentesIds);
      detalleCambio = `Sub-aplicativos reasignados (${total} sub-aplicativo(s))`;
    } else {
      await guardarServidoresYComponentes(pool, id, servidores);
      detalleCambio = `Servidores/roles reasignados (${(servidores || []).length} servidor(es))`;
    }

    const cambios = diffCampos(
      antes,
      { Nombre: nombre, Activo: estadoActivo, ImagenUrl: imagenUrl },
      ['Nombre', 'Activo', 'ImagenUrl'],
      { Nombre: 'Nombre', Activo: 'Activo', ImagenUrl: 'Imagen' }
    );

    await registrarEventoGeneral(pool, req, {
      modulo: 'CERTIFICADOS',
      entidad: 'Aplicación',
      entidadId: id,
      entidadNombre: nombre || antes.Nombre,
      accion: 'EDICION',
      cambios,
      detalle: detalleCambio,
    });

    res.json({ mensaje: 'Aplicación actualizada' });
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

router.delete('/:id', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const appId = req.params.id;

    const [appsAntes] = await pool.query('SELECT Nombre FROM Aplicaciones WHERE Id = ?', [appId]);
    const nombreBorrado = appsAntes[0]?.Nombre || null;

    // 1. DESVINCULAR CERTIFICADOS:
    // Ponemos en NULL el AplicacionId de los certificados asociados para no perderlos
    await pool.query('UPDATE Certificados SET AplicacionId = NULL WHERE AplicacionId = ?', [appId]);

    // NOTA: Si prefieres que al borrar la app también se borren sus certificados,
    // comenta la línea de arriba y descomenta la siguiente:
    // await pool.query('DELETE FROM Certificados WHERE AplicacionId = ?', [appId]);

    // 2. BORRAR ENLACES CON COMPONENTES Y SERVIDORES:
    // Los componentes del catálogo (Servidor_Componentes) NO se borran — pueden
    // seguir en uso por otra aplicación que comparta el mismo puerto/servidor.
    await pool.query('DELETE FROM Aplicacion_Componente WHERE AplicacionId = ?', [appId]);
    await pool.query('DELETE FROM Aplicacion_Servidor WHERE AplicacionId = ?', [appId]);

    // 3. BORRAR LA APLICACIÓN:
    // Ahora que la aplicación ya no tiene dependencias, MySQL nos dejará borrarla
    await pool.query('DELETE FROM Aplicaciones WHERE Id = ?', [appId]);

    if (nombreBorrado !== null) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'CERTIFICADOS',
        entidad: 'Aplicación',
        entidadId: appId,
        entidadNombre: nombreBorrado,
        accion: 'ELIMINACION',
        detalle: 'Aplicación eliminada (certificados asociados desvinculados, no borrados)',
      });
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

module.exports = router;
