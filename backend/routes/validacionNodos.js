const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const {
  garantizarEsquemaNodos,
  validarRutaArchivo,
  listarArchivosCarpetaCompartida,
  obtenerCarpetaCompartida,
  validarNodo,
  ejecutarValidacionDiaria,
  PATRON_ACE_DEFECTO,
  PATRON_BUS_DEFECTO,
} = require('../utils/apuntamientosNodos');

// Validación automática de apuntamientos contra los nodos. Mismo módulo que
// la bitácora de apuntamientos (SERVICIOS); crear/editar/ejecutar exige
// permiso de edición porque "ejecutar" puede escribir en la bitácora.
router.use(verifyToken, requireModule('SERVICIOS'));

// Si faltan tablas y no hay privilegios, todo responde 409 con el mensaje de qué script correr.
router.use(async (req, res, next) => {
  try {
    const pool = await getPool();
    const err = await garantizarEsquemaNodos(pool);
    if (err) return res.status(409).json({ error: err.message });
    req.pool = pool;
    next();
  } catch (error) {
    console.error('Error verificando el esquema de validación de nodos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

const SELECT_NODO = `
  SELECT n.*, ap.Nombre AS AplicacionNombre
  FROM ApuntamientosNodos n
  LEFT JOIN Aplicaciones ap ON ap.Id = n.AplicacionId
`;

function normalizarNodo(body) {
  const nombre = String(body.Nombre || '').trim();
  const host = String(body.Host || '').trim();
  const ruta = String(body.RutaArchivo || '').trim();
  if (!nombre) return { error: 'El nombre es obligatorio.' };
  if (!host || !/^[A-Za-z0-9_.\-]+$/.test(host)) return { error: 'El host/IP no es válido (solo letras, números, ".", "-" y "_").' };
  const errRuta = validarRutaArchivo(ruta);
  if (errRuta) return { error: errRuta };
  if (!body.AplicacionId) return { error: 'Selecciona la aplicación a la que pertenecen los apuntamientos de este nodo.' };

  const puerto = body.PuertoSsh ? parseInt(body.PuertoSsh, 10) : null;
  if (puerto !== null && (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535)) return { error: 'El puerto SSH no es válido.' };
  const usuario = String(body.UsuarioSsh || '').trim() || null;
  if (usuario && !/^[A-Za-z0-9_.\-]+$/.test(usuario)) return { error: 'El usuario SSH no es válido.' };

  return {
    valores: {
      Nombre: nombre.slice(0, 100),
      Host: host,
      PuertoSsh: puerto,
      UsuarioSsh: usuario,
      RutaArchivo: ruta,
      AplicacionId: Number(body.AplicacionId),
      // Componente: por convención el IP del nodo (igual que la carga inicial del nodo 109).
      Componente: String(body.Componente || '').trim().slice(0, 150) || host,
      PatronAce: String(body.PatronAce || '').trim().slice(0, 300) || PATRON_ACE_DEFECTO,
      PatronBus: String(body.PatronBus || '').trim().slice(0, 300) || PATRON_BUS_DEFECTO,
      Activo: body.Activo === false || body.Activo === 0 ? 0 : 1,
      CorregirAuto: body.CorregirAuto ? 1 : 0,
    },
  };
}

// Aplicaciones para el selector del formulario. Endpoint propio (módulo
// SERVICIOS) para no exigir el módulo CERTIFICADOS de /api/aplicaciones.
// Mismo criterio que ese listado: solo las aplicaciones "padre".
router.get('/aplicaciones', async (req, res) => {
  try {
    const [filas] = await req.pool.query(
      'SELECT Id, Nombre FROM Aplicaciones WHERE ServidorId IS NULL ORDER BY Nombre'
    );
    res.json(filas);
  } catch (error) {
    console.error('Error al listar aplicaciones:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// Nodos (servidores) para el selector del formulario: los que ya tienen
// apuntamientos en la bitácora de esa aplicación van primero, con el
// "Componente" que usa la bitácora para ese servidor.
router.get('/aplicaciones/:id/servidores', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Aplicación no válida' });
    const [filas] = await req.pool.query(
      `SELECT s.Id, s.IP, s.Hostname, s.Ambiente,
              (SELECT COUNT(*) FROM Apuntamientos a WHERE a.AplicacionId = ? AND a.ServidorId = s.Id) AS Apuntamientos,
              (SELECT a.Componente FROM Apuntamientos a
                WHERE a.AplicacionId = ? AND a.ServidorId = s.Id AND a.Componente IS NOT NULL
                GROUP BY a.Componente ORDER BY COUNT(*) DESC LIMIT 1) AS Componente
       FROM Servidores s
       WHERE s.Activo = 1 OR EXISTS (SELECT 1 FROM Apuntamientos a WHERE a.AplicacionId = ? AND a.ServidorId = s.Id)
       ORDER BY Apuntamientos DESC, s.Hostname`,
      [id, id, id]
    );
    res.json(filas);
  } catch (error) {
    console.error('Error al listar servidores de la aplicación:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// Archivos de configuración de la carpeta compartida central (recursivo).
router.get('/carpeta-compartida', requireEditPermission, async (req, res) => {
  try {
    const carpeta = obtenerCarpetaCompartida();
    if (!carpeta) return res.status(500).json({ error: 'NODOS_CARPETA_COMPARTIDA no es una ruta de red válida.' });
    res.json(await listarArchivosCarpetaCompartida({ refrescar: req.query.refrescar === '1' }));
  } catch (error) {
    console.error('Error al listar la carpeta compartida:', error.message);
    // Mensaje claro (SMB_*, permisos, red); no pasa por mensajeErrorAmigable.
    res.status(502).json({ error: error.message || 'No se pudo leer la carpeta compartida.', carpeta: obtenerCarpetaCompartida()?.unc || null });
  }
});

// --- Nodos ---
router.get('/nodos', async (req, res) => {
  try {
    const [filas] = await req.pool.query(`${SELECT_NODO} ORDER BY n.Nombre`);
    res.json(filas);
  } catch (error) {
    console.error('Error al listar nodos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.post('/nodos', requireEditPermission, async (req, res) => {
  const n = normalizarNodo(req.body);
  if (n.error) return res.status(400).json({ error: n.error });
  try {
    const v = n.valores;
    const [r] = await req.pool.query(
      `INSERT INTO ApuntamientosNodos (Nombre, Host, PuertoSsh, UsuarioSsh, RutaArchivo, AplicacionId, Componente, PatronAce, PatronBus, Activo, CorregirAuto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [v.Nombre, v.Host, v.PuertoSsh, v.UsuarioSsh, v.RutaArchivo, v.AplicacionId, v.Componente, v.PatronAce, v.PatronBus, v.Activo, v.CorregirAuto]
    );
    const [filas] = await req.pool.query(`${SELECT_NODO} WHERE n.Id = ?`, [r.insertId]);
    res.status(201).json(filas[0]);
  } catch (error) {
    console.error('Error al crear nodo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.put('/nodos/:id', requireEditPermission, async (req, res) => {
  const n = normalizarNodo(req.body);
  if (n.error) return res.status(400).json({ error: n.error });
  try {
    const v = n.valores;
    const [r] = await req.pool.query(
      `UPDATE ApuntamientosNodos SET Nombre=?, Host=?, PuertoSsh=?, UsuarioSsh=?, RutaArchivo=?, AplicacionId=?, Componente=?,
         PatronAce=?, PatronBus=?, Activo=?, CorregirAuto=? WHERE Id=?`,
      [v.Nombre, v.Host, v.PuertoSsh, v.UsuarioSsh, v.RutaArchivo, v.AplicacionId, v.Componente, v.PatronAce, v.PatronBus, v.Activo, v.CorregirAuto, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Nodo no encontrado' });
    const [filas] = await req.pool.query(`${SELECT_NODO} WHERE n.Id = ?`, [req.params.id]);
    res.json(filas[0]);
  } catch (error) {
    console.error('Error al actualizar nodo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.delete('/nodos/:id', requireEditPermission, async (req, res) => {
  try {
    const [r] = await req.pool.query('DELETE FROM ApuntamientosNodos WHERE Id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Nodo no encontrado' });
    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar nodo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

async function obtenerNodo(pool, id) {
  const [filas] = await pool.query('SELECT * FROM ApuntamientosNodos WHERE Id = ?', [id]);
  return filas[0] || null;
}

// Apuntamientos que la bitácora tiene hoy para este nodo (misma aplicación y
// mismo componente que usa la validación): sirve para ver el "En la bitácora".
router.get('/nodos/:id/apuntamientos', async (req, res) => {
  try {
    const nodo = await obtenerNodo(req.pool, req.params.id);
    if (!nodo) return res.status(404).json({ error: 'Nodo no encontrado' });
    const componente = nodo.Componente || null;
    const [filas] = await req.pool.query(
      `SELECT a.Id, a.SinApuntamiento, a.Categoria, a.ServicioInventarioId, a.Observaciones, a.FechaActualizacion,
              si.Codigo AS ServicioCodigo, si.NombreServicio AS ServicioNombre
       FROM Apuntamientos a
       LEFT JOIN AceServiciosInventario si ON si.Id = a.ServicioInventarioId
       WHERE a.AplicacionId = ? AND ((? IS NULL AND a.Componente IS NULL) OR a.Componente = ?)
       ORDER BY a.Categoria, si.Codigo, a.Id`,
      [nodo.AplicacionId, componente, componente]
    );
    res.json({ nodo: { Id: nodo.Id, Nombre: nodo.Nombre, AplicacionId: nodo.AplicacionId, Componente: componente }, apuntamientos: filas });
  } catch (error) {
    console.error('Error al listar los apuntamientos del nodo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// "Probar": lee el archivo y compara, SIN escribir nada y sin guardar la corrida.
router.post('/nodos/:id/probar', requireEditPermission, async (req, res) => {
  try {
    const nodo = await obtenerNodo(req.pool, req.params.id);
    if (!nodo) return res.status(404).json({ error: 'Nodo no encontrado' });
    const r = await validarNodo(req.pool, nodo, { origen: 'MANUAL', aplicar: false, guardar: false, usuario: req.user?.username });
    res.json(r);
  } catch (error) {
    console.error('Error al probar nodo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// "Validar ahora": guarda la corrida; aplica correcciones solo si se pide
// explícitamente (aplicar=true) — independiente del check automático del nodo.
router.post('/nodos/:id/validar', requireEditPermission, async (req, res) => {
  try {
    const nodo = await obtenerNodo(req.pool, req.params.id);
    if (!nodo) return res.status(404).json({ error: 'Nodo no encontrado' });
    const r = await validarNodo(req.pool, nodo, {
      origen: 'MANUAL', aplicar: !!req.body?.aplicar, guardar: true, usuario: req.user?.username,
    });
    res.json(r);
  } catch (error) {
    console.error('Error al validar nodo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// Dispara ahora la misma corrida que el programador diario (todos los nodos activos).
router.post('/ejecutar-todos', requireEditPermission, async (req, res) => {
  try {
    res.json(await ejecutarValidacionDiaria({ forzar: true }));
  } catch (error) {
    console.error('Error al ejecutar la validación de todos los nodos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// --- Historial de corridas ---
router.get('/validaciones', async (req, res) => {
  try {
    const nodoId = req.query.nodoId ? Number(req.query.nodoId) : null;
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 100, 1), 500);
    const [filas] = await req.pool.query(
      `SELECT v.*, n.Nombre AS NodoNombre
       FROM ApuntamientosValidaciones v
       INNER JOIN ApuntamientosNodos n ON n.Id = v.NodoId
       ${nodoId ? 'WHERE v.NodoId = ?' : ''}
       ORDER BY v.Fecha DESC, v.Id DESC LIMIT ${limite}`,
      nodoId ? [nodoId] : []
    );
    res.json(filas);
  } catch (error) {
    console.error('Error al listar validaciones:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

router.get('/validaciones/:id', async (req, res) => {
  try {
    const [cab] = await req.pool.query(
      `SELECT v.*, n.Nombre AS NodoNombre FROM ApuntamientosValidaciones v
       INNER JOIN ApuntamientosNodos n ON n.Id = v.NodoId WHERE v.Id = ?`, [req.params.id]);
    if (!cab.length) return res.status(404).json({ error: 'Validación no encontrada' });
    const [detalle] = await req.pool.query(
      `SELECT d.*, si.Codigo AS ServicioCodigo, si.NombreServicio AS ServicioNombre
       FROM ApuntamientosValidacionDetalle d
       LEFT JOIN AceServiciosInventario si ON si.Id = d.ServicioInventarioId
       WHERE d.ValidacionId = ? ORDER BY d.Tipo, d.Codigo, d.Clave`, [req.params.id]);
    res.json({ ...cab[0], detalle });
  } catch (error) {
    console.error('Error al obtener validación:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

module.exports = router;
