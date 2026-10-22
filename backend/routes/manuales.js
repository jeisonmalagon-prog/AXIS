const express = require('express');
const router = express.Router();
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { getPool } = require('../db');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');
const { asegurarEsquemaManuales } = require('../utils/manualesEsquema');
const { sanitizar, aTexto, tieneContenido, dividirPaginas, agruparCodigo } = require('../utils/manualesHtml');
const { notificar } = require('../utils/notificaciones');

// Manuales: libretas > secciones > páginas (estilo OneNote). Mismo criterio de
// permisos que el resto de módulos: lectura para quien tenga el módulo
// habilitado y escritura según el rol del usuario EN el módulo (Consulta no
// edita). Nada se elimina físicamente: «eliminar» marca Activo = 0.
router.use(verifyToken);
// Responder o quitar una solicitud de compartir es una decisión personal: no exige tener el módulo
// (aceptar sí: sin el módulo Manuales no habría cómo ver el manual, y se explica con un mensaje claro).
const exigirModulo = requireModule('MANUALES');
router.use((req, res, next) => (req.path.startsWith('/comparticiones') ? next() : exigirModulo(req, res, next)));

router.use(async (req, res, next) => {
  try {
    const estado = await asegurarEsquemaManuales(await getPool());
    if (!estado.ok) return res.status(503).json({ error: estado.mensaje });
    next();
  } catch (error) {
    console.error('Error al preparar las tablas de Manuales:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el módulo Manuales' }) });
  }
});

const TAMANO_MAX_HTML = 12 * 1024 * 1024; // el paquete máximo de MariaDB suele ser 16 MB
const TAMANO_MAX_PDF = 14 * 1024 * 1024;
const TAMANO_MAX_IMPORTACION = '120mb';
const MAX_PAGINAS_IMPORTACION = 500;
const MINUTOS_ENTRE_VERSIONES = 10;
const PALETA = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#ca8a04', '#475569'];

const ETIQUETAS = { Nombre: 'Nombre', Descripcion: 'Descripción', Color: 'Color', Titulo: 'Título' };

// ---------- utilidades ----------

const usuario = (req) => String(req.user?.username || '').slice(0, 100) || null;

function idValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function texto(valor, max) {
  return String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function colorValido(c) {
  return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).toLowerCase() : null;
}

function manejar(contexto, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (res.headersSent) return;
      console.error(`Error en Manuales (${contexto}):`, error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto }) });
    }
  };
}

const auditar = (pool, req, datos) =>
  registrarEventoGeneral(pool, req, { modulo: 'MANUALES', ...datos }).catch((e) =>
    console.error('No se pudo registrar la auditoría de Manuales:', e.message)
  );

function nombreArchivoSeguro(base, ext) {
  const limpio = String(base || 'manual').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'manual';
  return `${limpio}.${ext}`;
}

function enviarArchivo(res, nombre, mime, buffer, descargar) {
  const ascii = nombre.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Type', mime);
  res.setHeader(
    'Content-Disposition',
    `${descargar ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`
  );
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buffer);
}

// Si una página supera el tamaño que cabe en una fila, se van quitando las
// imágenes más pesadas hasta que quepa (y se avisa).
function ajustarTamano(html, maximo) {
  let omitidas = 0;
  let salida = html;
  while (Buffer.byteLength(salida, 'utf8') > maximo) {
    let mayor = null;
    const re = /<img\b[^>]*>/gi;
    let m;
    while ((m = re.exec(salida))) if (!mayor || m[0].length > mayor[0].length) mayor = m;
    if (!mayor) break;
    salida = salida.slice(0, mayor.index) + '<p><em>[Imagen omitida: la página superaba el tamaño máximo]</em></p>' + salida.slice(mayor.index + mayor[0].length);
    omitidas += 1;
  }
  return { html: salida, omitidas };
}

async function siguienteOrden(conn, tabla, columna, valor) {
  const [[r]] = await conn.query(`SELECT COALESCE(MAX(Orden), 0) + 1 AS n FROM ${tabla} WHERE ${columna} = ? AND Activo = 1`, [valor]);
  return r.n;
}

// Guarda una copia del contenido ACTUAL de la página (antes de pisarlo) si
// pasaron 10 minutos desde la última copia o la última la hizo otra persona.
// Devuelve true si creó la copia.
async function copiarVersionSiCorresponde(conn, paginaId, req, forzar = false) {
  if (!forzar) {
    const [[ultima]] = await conn.query(
      `SELECT GuardadoPor, TIMESTAMPDIFF(SECOND, FechaGuardado, NOW()) AS seg
         FROM manuales_versiones WHERE PaginaId = ? ORDER BY Id DESC LIMIT 1`,
      [paginaId]
    );
    if (ultima && ultima.GuardadoPor === usuario(req) && ultima.seg < MINUTOS_ENTRE_VERSIONES * 60) return false;
  }
  const [r] = await conn.query(
    `INSERT INTO manuales_versiones (PaginaId, Titulo, ContenidoHtml, GuardadoPor)
       SELECT Id, Titulo, ContenidoHtml, ? FROM manuales_paginas WHERE Id = ? AND Tipo = 'RICO'`,
    [usuario(req), paginaId]
  );
  return r.affectedRows > 0;
}

function metaPagina(p) {
  return {
    id: p.Id,
    seccionId: p.SeccionId,
    titulo: p.Titulo,
    tipo: p.Tipo,
    fechaOrigen: p.FechaOrigen,
    orden: p.Orden,
    version: p.Version,
    creadoPor: p.CreadoPor,
    fechaCreacion: p.FechaCreacion,
    actualizadoPor: p.ActualizadoPor,
    fechaActualizacion: p.FechaActualizacion,
    archivoNombre: p.ArchivoNombre,
    archivoTamano: p.ArchivoTamano,
  };
}

const COLUMNAS_META =
  'p.Id, p.SeccionId, p.Titulo, p.Tipo, p.FechaOrigen, p.Orden, p.Version, p.CreadoPor, p.FechaCreacion, ' +
  'p.ActualizadoPor, p.FechaActualizacion, p.ArchivoNombre, p.ArchivoTamano';


// ---------- acceso: cada libreta es de quien la creó ----------
// Una libreta solo la ve (y edita) su dueño. Otras personas entran únicamente si el dueño la compartió
// y ellas ACEPTARON la solicitud (manuales_comparticiones). Las libretas sin dueño (CreadoPor vacío,
// anteriores a esta regla) siguen visibles para todos con permiso de edición, pero no se pueden compartir ni eliminar.
const NIVEL = { NINGUNO: 0, LECTURA: 1, EDICION: 2, PROPIETARIO: 3 };
const NOMBRE_NIVEL = ['NINGUNO', 'LECTURA', 'EDICION', 'PROPIETARIO'];
const mismoUsuario = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function accesoALibreta(pool, req, libretaId) {
  const [[l]] = await pool.query('SELECT Id, Nombre, CreadoPor FROM manuales_libretas WHERE Id = ? AND Activo = 1', [libretaId]);
  if (!l) return { existe: false, nivel: NIVEL.NINGUNO };
  const yo = usuario(req);
  if (!l.CreadoPor) return { existe: true, nivel: NIVEL.EDICION, libreta: l };
  if (mismoUsuario(l.CreadoPor, yo)) return { existe: true, nivel: NIVEL.PROPIETARIO, libreta: l };
  const [[c]] = await pool.query("SELECT Permiso FROM manuales_comparticiones WHERE LibretaId = ? AND Destinatario = ? AND Estado = 'ACEPTADA'", [libretaId, yo]);
  if (c) return { existe: true, nivel: c.Permiso === 'EDICION' ? NIVEL.EDICION : NIVEL.LECTURA, libreta: l };
  return { existe: true, nivel: NIVEL.NINGUNO, libreta: l };
}

// Fragmento SQL para filtrar por libretas a las que la persona tiene acceso (alias de manuales_libretas = l). Parámetros: [yo, yo].
const FILTRO_ACCESO_SQL =
  "(l.CreadoPor IS NULL OR l.CreadoPor = ? OR EXISTS (SELECT 1 FROM manuales_comparticiones cc WHERE cc.LibretaId = l.Id AND cc.Destinatario = ? AND cc.Estado = 'ACEPTADA'))";

async function libretaDe(pool, tipo, id) {
  if (tipo === 'libretas') return id;
  const consultas = {
    secciones: 'SELECT s.LibretaId AS L FROM manuales_secciones s WHERE s.Id = ? AND s.Activo = 1',
    paginas: 'SELECT s.LibretaId AS L FROM manuales_paginas p JOIN manuales_secciones s ON s.Id = p.SeccionId WHERE p.Id = ? AND p.Activo = 1 AND s.Activo = 1',
    versiones: 'SELECT s.LibretaId AS L FROM manuales_versiones v JOIN manuales_paginas p ON p.Id = v.PaginaId JOIN manuales_secciones s ON s.Id = p.SeccionId WHERE v.Id = ?',
  };
  const [[r]] = await pool.query(consultas[tipo], [id]);
  return r ? r.L : null;
}

// Antes de cualquier ruta sobre una libreta, sección, página o versión concreta: ¿es suya o se la compartieron?
router.use(async (req, res, next) => {
  try {
    const m = req.path.match(/^\/(libretas|secciones|paginas|versiones)\/(\d+)(?:\/([a-z-]+))?/);
    if (!m) return next();
    const [, tipo, idTxt, sub] = m;
    const pool = await getPool();
    const libretaId = await libretaDe(pool, tipo, Number(idTxt));
    if (!libretaId) return res.status(404).json({ error: 'No existe o fue eliminado.' });
    const acceso = await accesoALibreta(pool, req, libretaId);
    let minimo = req.method === 'GET' ? NIVEL.LECTURA : NIVEL.EDICION;
    if (tipo === 'libretas' && (sub === 'comparticiones' || sub === 'compartir' || req.method === 'PUT' && !sub || req.method === 'DELETE' && !sub)) minimo = NIVEL.PROPIETARIO;
    if (acceso.nivel === NIVEL.NINGUNO) return res.status(404).json({ error: 'No existe o no tienes acceso: cada manual es de quien lo creó, salvo que lo comparta contigo.' });
    if (acceso.nivel < minimo) {
      return res.status(403).json({
        error: minimo === NIVEL.PROPIETARIO
          ? 'Solo quien creó este manual puede hacer esto.'
          : 'Este manual se compartió contigo solo para lectura: no puedes modificarlo.',
      });
    }
    req.accesoManual = acceso;
    req.libretaIdManual = libretaId;
    next();
  } catch (error) {
    console.error('Error al validar el acceso a Manuales:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el acceso al manual' }) });
  }
});

// Al importar sobre una libreta o sección existente se exige poder editarla.
async function permisoImportar(req, res, next) {
  try {
    const pool = await getPool();
    const seccionId = idValido(req.query.seccionId);
    const libretaId = seccionId ? await libretaDe(pool, 'secciones', seccionId) : idValido(req.query.libretaId);
    if (seccionId && !libretaId) return res.status(404).json({ error: 'La sección de destino no existe.' });
    if (libretaId) {
      const a = await accesoALibreta(pool, req, libretaId);
      if (a.nivel < NIVEL.EDICION) return res.status(a.nivel ? 403 : 404).json({ error: a.nivel ? 'Este manual se compartió contigo solo para lectura.' : 'La libreta de destino no existe o no tienes acceso.' });
    }
    next();
  } catch (error) {
    console.error('Error al validar el destino de la importación:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el destino de la importación' }) });
  }
}

// ---------- lectura ----------

router.get('/arbol', manejar('los manuales', async (req, res) => {
  const pool = await getPool();
  const yo = usuario(req);
  const [libretas] = await pool.query(
    `SELECT l.Id, l.Nombre, l.Descripcion, l.Orden, l.CreadoPor, c.Permiso AS PermisoCompartido, c.Id AS ComparticionId,
            (SELECT COUNT(*) FROM manuales_comparticiones x WHERE x.LibretaId = l.Id AND x.Estado = 'ACEPTADA') AS CompartidaCon,
            (SELECT COUNT(*) FROM manuales_comparticiones x WHERE x.LibretaId = l.Id AND x.Estado = 'PENDIENTE') AS Pendientes
       FROM manuales_libretas l
       LEFT JOIN manuales_comparticiones c ON c.LibretaId = l.Id AND c.Destinatario = ? AND c.Estado = 'ACEPTADA'
      WHERE l.Activo = 1 AND (l.CreadoPor IS NULL OR l.CreadoPor = ? OR c.Id IS NOT NULL)
      ORDER BY l.Orden, l.Id`,
    [yo, yo]
  );
  const idsVisibles = libretas.map((l) => l.Id);
  const [secciones] = idsVisibles.length
    ? await pool.query(
        `SELECT s.Id, s.LibretaId, s.Nombre, s.Color, s.Orden,
                (SELECT COUNT(*) FROM manuales_paginas p WHERE p.SeccionId = s.Id AND p.Activo = 1) AS Total
           FROM manuales_secciones s WHERE s.Activo = 1 AND s.LibretaId IN (?) ORDER BY s.Orden, s.Id`,
        [idsVisibles]
      )
    : [[]];
  res.json(
    libretas.map((l) => ({
      id: l.Id,
      nombre: l.Nombre,
      descripcion: l.Descripcion,
      orden: l.Orden,
      propietario: l.CreadoPor,
      miNivel: !l.CreadoPor ? 'EDICION' : mismoUsuario(l.CreadoPor, yo) ? 'PROPIETARIO' : l.PermisoCompartido === 'EDICION' ? 'EDICION' : 'LECTURA',
      miComparticionId: l.ComparticionId ?? null,
      compartidaCon: Number(l.CompartidaCon),
      pendientes: Number(l.Pendientes),
      secciones: secciones
        .filter((s) => s.LibretaId === l.Id)
        .map((s) => ({ id: s.Id, nombre: s.Nombre, color: s.Color, orden: s.Orden, totalPaginas: Number(s.Total) })),
    }))
  );
}));

router.get('/secciones/:id/paginas', manejar('las páginas', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Sección no válida.' });
  const pool = await getPool();
  const [filas] = await pool.query(
    `SELECT ${COLUMNAS_META} FROM manuales_paginas p WHERE p.SeccionId = ? AND p.Activo = 1 ORDER BY p.Orden, p.Id`,
    [id]
  );
  res.json(filas.map(metaPagina));
}));

router.get('/paginas/:id', manejar('la página', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Página no válida.' });
  const pool = await getPool();
  const [[p]] = await pool.query(
    `SELECT ${COLUMNAS_META}, p.ContenidoHtml, s.LibretaId, s.Nombre AS SeccionNombre, s.Color AS SeccionColor, l.Nombre AS LibretaNombre
       FROM manuales_paginas p
       JOIN manuales_secciones s ON s.Id = p.SeccionId
       JOIN manuales_libretas l ON l.Id = s.LibretaId
      WHERE p.Id = ? AND p.Activo = 1 AND s.Activo = 1 AND l.Activo = 1`,
    [id]
  );
  if (!p) return res.status(404).json({ error: 'La página no existe o fue eliminada.' });
  res.json({
    ...metaPagina(p),
    html: p.Tipo === 'RICO' ? p.ContenidoHtml || '' : '',
    libretaId: p.LibretaId,
    libretaNombre: p.LibretaNombre,
    seccionNombre: p.SeccionNombre,
    seccionColor: p.SeccionColor,
    miNivel: NOMBRE_NIVEL[req.accesoManual?.nivel ?? 1],
  });
}));

router.get('/paginas/:id/archivo', manejar('el archivo', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Página no válida.' });
  const pool = await getPool();
  const [[p]] = await pool.query(
    `SELECT Titulo, ArchivoNombre, ArchivoMime, ArchivoDatos FROM manuales_paginas WHERE Id = ? AND Activo = 1 AND Tipo = 'PDF'`,
    [id]
  );
  if (!p || !p.ArchivoDatos) return res.status(404).json({ error: 'Esta página no tiene un archivo adjunto.' });
  enviarArchivo(res, p.ArchivoNombre || nombreArchivoSeguro(p.Titulo, 'pdf'), p.ArchivoMime || 'application/pdf', p.ArchivoDatos, req.query.descargar === '1');
}));

router.get('/buscar', manejar('la búsqueda', async (req, res) => {
  const fichas = String(req.query.q || '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  if (!fichas.length) return res.json([]);
  const comodin = (t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const condiciones = fichas.map(() => '(p.Titulo LIKE ? OR p.ContenidoTexto LIKE ?)').join(' AND ');
  const params = [fichas[0], comodin(fichas[0])];
  fichas.forEach((t) => params.push(comodin(t), comodin(t)));
  const libretaId = idValido(req.query.libretaId);
  const filtroLibreta = (libretaId ? ' AND s.LibretaId = ?' : '') + ` AND ${FILTRO_ACCESO_SQL}`;
  if (libretaId) params.push(libretaId);
  params.push(usuario(req), usuario(req));

  const pool = await getPool();
  const [filas] = await pool.query(
    `SELECT p.Id, p.Titulo, p.Tipo, p.SeccionId, p.FechaActualizacion, s.Nombre AS SeccionNombre, s.Color, s.LibretaId, l.Nombre AS LibretaNombre,
            SUBSTRING(p.ContenidoTexto, GREATEST(LOCATE(?, p.ContenidoTexto) - 60, 1), 220) AS Fragmento,
            (p.Titulo LIKE ?) AS EnTitulo
       FROM manuales_paginas p
       JOIN manuales_secciones s ON s.Id = p.SeccionId
       JOIN manuales_libretas l ON l.Id = s.LibretaId
      WHERE p.Activo = 1 AND s.Activo = 1 AND l.Activo = 1 AND ${condiciones}${filtroLibreta}
      ORDER BY EnTitulo DESC, p.FechaActualizacion DESC
      LIMIT 40`,
    params
  );
  res.json(
    filas.map((f) => ({
      id: f.Id,
      titulo: f.Titulo,
      tipo: f.Tipo,
      seccionId: f.SeccionId,
      seccionNombre: f.SeccionNombre,
      seccionColor: f.Color,
      libretaId: f.LibretaId,
      libretaNombre: f.LibretaNombre,
      fragmento: String(f.Fragmento || '').replace(/\s+/g, ' ').trim(),
      fechaActualizacion: f.FechaActualizacion,
    }))
  );
}));

// ---------- libretas ----------

router.post('/libretas', requireEditPermission, manejar('crear la libreta', async (req, res) => {
  const nombre = texto(req.body?.nombre, 150);
  if (!nombre) return res.status(400).json({ error: 'Escribe un nombre para la libreta.' });
  const descripcion = texto(req.body?.descripcion, 500) || null;
  const pool = await getPool();
  const orden = await siguienteOrden(pool, 'manuales_libretas', '1', 1);
  const [r] = await pool.query('INSERT INTO manuales_libretas (Nombre, Descripcion, Orden, CreadoPor) VALUES (?, ?, ?, ?)', [nombre, descripcion, orden, usuario(req)]);
  await auditar(pool, req, { entidad: 'Libreta', entidadId: r.insertId, entidadNombre: nombre, accion: 'CREACION', detalle: 'Libreta de manuales creada.' });
  res.status(201).json({ id: r.insertId, nombre, descripcion, orden, secciones: [] });
}));

router.put('/libretas/:id', requireEditPermission, manejar('editar la libreta', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Libreta no válida.' });
  const nombre = texto(req.body?.nombre, 150);
  if (!nombre) return res.status(400).json({ error: 'Escribe un nombre para la libreta.' });
  const descripcion = texto(req.body?.descripcion, 500) || null;
  const pool = await getPool();
  const [[antes]] = await pool.query('SELECT Nombre, Descripcion FROM manuales_libretas WHERE Id = ? AND Activo = 1', [id]);
  if (!antes) return res.status(404).json({ error: 'La libreta no existe.' });
  await pool.query('UPDATE manuales_libretas SET Nombre = ?, Descripcion = ? WHERE Id = ?', [nombre, descripcion, id]);
  const cambios = diffCampos(antes, { Nombre: nombre, Descripcion: descripcion }, ['Nombre', 'Descripcion'], ETIQUETAS);
  if (cambios.length) await auditar(pool, req, { entidad: 'Libreta', entidadId: id, entidadNombre: nombre, accion: 'EDICION', cambios });
  res.json({ ok: true });
}));

router.delete('/libretas/:id', requireEditPermission, manejar('eliminar la libreta', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Libreta no válida.' });
  const pool = await getPool();
  const [[l]] = await pool.query('SELECT Nombre FROM manuales_libretas WHERE Id = ? AND Activo = 1', [id]);
  if (!l) return res.status(404).json({ error: 'La libreta no existe.' });
  await pool.query('UPDATE manuales_libretas SET Activo = 0 WHERE Id = ?', [id]);
  await auditar(pool, req, { entidad: 'Libreta', entidadId: id, entidadNombre: l.Nombre, accion: 'ELIMINACION', detalle: 'Libreta oculta (borrado lógico); sus secciones y páginas se conservan en la base de datos.' });
  res.json({ ok: true });
}));

router.put('/libretas/:id/orden-secciones', requireEditPermission, manejar('ordenar las secciones', async (req, res) => {
  const id = idValido(req.params.id);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(idValido).filter(Boolean) : [];
  if (!id || !ids.length) return res.status(400).json({ error: 'Indica el orden de las secciones.' });
  const pool = await getPool();
  for (let i = 0; i < ids.length; i += 1) await pool.query('UPDATE manuales_secciones SET Orden = ? WHERE Id = ? AND LibretaId = ?', [i + 1, ids[i], id]);
  res.json({ ok: true });
}));

// ---------- secciones ----------

router.post('/libretas/:id/secciones', requireEditPermission, manejar('crear la sección', async (req, res) => {
  const libretaId = idValido(req.params.id);
  const nombre = texto(req.body?.nombre, 150);
  if (!libretaId) return res.status(400).json({ error: 'Libreta no válida.' });
  if (!nombre) return res.status(400).json({ error: 'Escribe un nombre para la sección.' });
  const pool = await getPool();
  const [[l]] = await pool.query('SELECT Id FROM manuales_libretas WHERE Id = ? AND Activo = 1', [libretaId]);
  if (!l) return res.status(404).json({ error: 'La libreta no existe.' });
  const orden = await siguienteOrden(pool, 'manuales_secciones', 'LibretaId', libretaId);
  const color = colorValido(req.body?.color) || PALETA[(orden - 1) % PALETA.length];
  const [r] = await pool.query('INSERT INTO manuales_secciones (LibretaId, Nombre, Color, Orden, CreadoPor) VALUES (?, ?, ?, ?, ?)', [libretaId, nombre, color, orden, usuario(req)]);
  await auditar(pool, req, { entidad: 'Seccion', entidadId: r.insertId, entidadNombre: nombre, accion: 'CREACION', detalle: `Sección creada en la libreta #${libretaId}.` });
  res.status(201).json({ id: r.insertId, nombre, color, orden, totalPaginas: 0 });
}));

router.put('/secciones/:id', requireEditPermission, manejar('editar la sección', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Sección no válida.' });
  const nombre = texto(req.body?.nombre, 150);
  if (!nombre) return res.status(400).json({ error: 'Escribe un nombre para la sección.' });
  const pool = await getPool();
  const [[antes]] = await pool.query('SELECT Nombre, Color FROM manuales_secciones WHERE Id = ? AND Activo = 1', [id]);
  if (!antes) return res.status(404).json({ error: 'La sección no existe.' });
  const color = colorValido(req.body?.color) || antes.Color;
  await pool.query('UPDATE manuales_secciones SET Nombre = ?, Color = ? WHERE Id = ?', [nombre, color, id]);
  const cambios = diffCampos(antes, { Nombre: nombre, Color: color }, ['Nombre', 'Color'], ETIQUETAS);
  if (cambios.length) await auditar(pool, req, { entidad: 'Seccion', entidadId: id, entidadNombre: nombre, accion: 'EDICION', cambios });
  res.json({ ok: true });
}));

router.delete('/secciones/:id', requireEditPermission, manejar('eliminar la sección', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Sección no válida.' });
  const pool = await getPool();
  const [[s]] = await pool.query('SELECT Nombre FROM manuales_secciones WHERE Id = ? AND Activo = 1', [id]);
  if (!s) return res.status(404).json({ error: 'La sección no existe.' });
  await pool.query('UPDATE manuales_secciones SET Activo = 0 WHERE Id = ?', [id]);
  await auditar(pool, req, { entidad: 'Seccion', entidadId: id, entidadNombre: s.Nombre, accion: 'ELIMINACION', detalle: 'Sección oculta (borrado lógico); sus páginas se conservan en la base de datos.' });
  res.json({ ok: true });
}));

router.put('/secciones/:id/orden-paginas', requireEditPermission, manejar('ordenar las páginas', async (req, res) => {
  const id = idValido(req.params.id);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(idValido).filter(Boolean) : [];
  if (!id || !ids.length) return res.status(400).json({ error: 'Indica el orden de las páginas.' });
  const pool = await getPool();
  for (let i = 0; i < ids.length; i += 1) await pool.query('UPDATE manuales_paginas SET Orden = ? WHERE Id = ? AND SeccionId = ?', [i + 1, ids[i], id]);
  res.json({ ok: true });
}));

// ---------- páginas ----------

router.post('/secciones/:id/paginas', requireEditPermission, manejar('crear la página', async (req, res) => {
  const seccionId = idValido(req.params.id);
  if (!seccionId) return res.status(400).json({ error: 'Sección no válida.' });
  const titulo = texto(req.body?.titulo, 255) || 'Página sin título';
  const html = sanitizar(req.body?.html || '');
  if (Buffer.byteLength(html, 'utf8') > TAMANO_MAX_HTML) return res.status(413).json({ error: 'El contenido es demasiado grande (máximo 12 MB por página).' });
  const pool = await getPool();
  const [[s]] = await pool.query('SELECT Id FROM manuales_secciones WHERE Id = ? AND Activo = 1', [seccionId]);
  if (!s) return res.status(404).json({ error: 'La sección no existe.' });
  const orden = await siguienteOrden(pool, 'manuales_paginas', 'SeccionId', seccionId);
  const [r] = await pool.query(
    `INSERT INTO manuales_paginas (SeccionId, Titulo, Tipo, ContenidoHtml, ContenidoTexto, Orden, CreadoPor, ActualizadoPor)
     VALUES (?, ?, 'RICO', ?, ?, ?, ?, ?)`,
    [seccionId, titulo, html, aTexto(html), orden, usuario(req), usuario(req)]
  );
  await auditar(pool, req, { entidad: 'Pagina', entidadId: r.insertId, entidadNombre: titulo, accion: 'CREACION', detalle: `Página creada en la sección #${seccionId}.` });
  res.status(201).json({ id: r.insertId, seccionId, titulo, tipo: 'RICO', orden, version: 1 });
}));

router.put('/paginas/:id', requireEditPermission, manejar('guardar la página', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Página no válida.' });
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT Titulo, Tipo, Version, ActualizadoPor, FechaActualizacion FROM manuales_paginas WHERE Id = ? AND Activo = 1 FOR UPDATE', [id]);
    if (!p) {
      await conn.rollback();
      return res.status(404).json({ error: 'La página no existe o fue eliminada.' });
    }
    if (!req.body?.forzar && Number(req.body?.version) !== p.Version) {
      await conn.rollback();
      return res.status(409).json({
        error: `${p.ActualizadoPor || 'Otra persona'} guardó cambios en esta página mientras la editabas.`,
        conflicto: true,
        version: p.Version,
        actualizadoPor: p.ActualizadoPor,
        fechaActualizacion: p.FechaActualizacion,
      });
    }
    const titulo = texto(req.body?.titulo, 255) || p.Titulo;
    let versionCreada = false;
    if (p.Tipo === 'RICO' && typeof req.body?.html === 'string') {
      const html = sanitizar(req.body.html);
      if (Buffer.byteLength(html, 'utf8') > TAMANO_MAX_HTML) {
        await conn.rollback();
        return res.status(413).json({ error: 'La página es demasiado grande (máximo 12 MB). Quita o reduce algunas imágenes.' });
      }
      versionCreada = await copiarVersionSiCorresponde(conn, id, req);
      await conn.query(
        'UPDATE manuales_paginas SET Titulo = ?, ContenidoHtml = ?, ContenidoTexto = ?, Version = Version + 1, ActualizadoPor = ?, FechaActualizacion = NOW() WHERE Id = ?',
        [titulo, html, aTexto(html), usuario(req), id]
      );
    } else {
      await conn.query('UPDATE manuales_paginas SET Titulo = ?, Version = Version + 1, ActualizadoPor = ?, FechaActualizacion = NOW() WHERE Id = ?', [titulo, usuario(req), id]);
    }
    const [[nuevo]] = await conn.query('SELECT Version, ActualizadoPor, FechaActualizacion FROM manuales_paginas WHERE Id = ?', [id]);
    await conn.commit();
    if (versionCreada || titulo !== p.Titulo) {
      const cambios = diffCampos({ Titulo: p.Titulo }, { Titulo: titulo }, ['Titulo'], ETIQUETAS);
      await auditar(pool, req, { entidad: 'Pagina', entidadId: id, entidadNombre: titulo, accion: 'EDICION', detalle: cambios.length ? null : 'Contenido de la página actualizado.', cambios });
    }
    res.json({ version: nuevo.Version, actualizadoPor: nuevo.ActualizadoPor, fechaActualizacion: nuevo.FechaActualizacion });
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}));

router.put('/paginas/:id/mover', requireEditPermission, manejar('mover la página', async (req, res) => {
  const id = idValido(req.params.id);
  const seccionId = idValido(req.body?.seccionId);
  if (!id || !seccionId) return res.status(400).json({ error: 'Indica la sección de destino.' });
  const pool = await getPool();
  const [[p]] = await pool.query('SELECT Titulo, SeccionId FROM manuales_paginas WHERE Id = ? AND Activo = 1', [id]);
  const [[s]] = await pool.query('SELECT Nombre FROM manuales_secciones WHERE Id = ? AND Activo = 1', [seccionId]);
  if (!p || !s) return res.status(404).json({ error: 'La página o la sección de destino no existe.' });
  if (p.SeccionId === seccionId) return res.json({ ok: true });
  const libretaDestino = await libretaDe(pool, 'secciones', seccionId);
  const accesoDestino = await accesoALibreta(pool, req, libretaDestino);
  if (accesoDestino.nivel < NIVEL.EDICION) return res.status(403).json({ error: 'No puedes mover páginas a un manual donde no tienes permiso de edición.' });
  const orden = await siguienteOrden(pool, 'manuales_paginas', 'SeccionId', seccionId);
  await pool.query('UPDATE manuales_paginas SET SeccionId = ?, Orden = ? WHERE Id = ?', [seccionId, orden, id]);
  await auditar(pool, req, { entidad: 'Pagina', entidadId: id, entidadNombre: p.Titulo, accion: 'EDICION', detalle: `Página movida a la sección «${s.Nombre}».` });
  res.json({ ok: true });
}));

router.delete('/paginas/:id', requireEditPermission, manejar('eliminar la página', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Página no válida.' });
  const pool = await getPool();
  const [[p]] = await pool.query('SELECT Titulo FROM manuales_paginas WHERE Id = ? AND Activo = 1', [id]);
  if (!p) return res.status(404).json({ error: 'La página no existe.' });
  await pool.query('UPDATE manuales_paginas SET Activo = 0, ActualizadoPor = ?, FechaActualizacion = NOW() WHERE Id = ?', [usuario(req), id]);
  await auditar(pool, req, { entidad: 'Pagina', entidadId: id, entidadNombre: p.Titulo, accion: 'ELIMINACION', detalle: 'Página oculta (borrado lógico); se conserva en la base de datos.' });
  res.json({ ok: true });
}));

// ---------- versiones ----------

router.get('/paginas/:id/versiones', manejar('el historial', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Página no válida.' });
  const pool = await getPool();
  const [filas] = await pool.query(
    'SELECT Id, Titulo, GuardadoPor, FechaGuardado, LENGTH(ContenidoHtml) AS Tamano FROM manuales_versiones WHERE PaginaId = ? ORDER BY Id DESC LIMIT 100',
    [id]
  );
  res.json(filas.map((v) => ({ id: v.Id, titulo: v.Titulo, guardadoPor: v.GuardadoPor, fecha: v.FechaGuardado, tamano: Number(v.Tamano || 0) })));
}));

router.get('/versiones/:id', manejar('la versión', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Versión no válida.' });
  const pool = await getPool();
  const [[v]] = await pool.query('SELECT Id, PaginaId, Titulo, ContenidoHtml, GuardadoPor, FechaGuardado FROM manuales_versiones WHERE Id = ?', [id]);
  if (!v) return res.status(404).json({ error: 'La versión no existe.' });
  res.json({ id: v.Id, paginaId: v.PaginaId, titulo: v.Titulo, html: sanitizar(v.ContenidoHtml || ''), guardadoPor: v.GuardadoPor, fecha: v.FechaGuardado });
}));

router.post('/paginas/:id/restaurar', requireEditPermission, manejar('restaurar la versión', async (req, res) => {
  const id = idValido(req.params.id);
  const versionId = idValido(req.body?.versionId);
  if (!id || !versionId) return res.status(400).json({ error: 'Indica la versión a restaurar.' });
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query("SELECT Titulo FROM manuales_paginas WHERE Id = ? AND Activo = 1 AND Tipo = 'RICO' FOR UPDATE", [id]);
    const [[v]] = await conn.query('SELECT Titulo, ContenidoHtml, FechaGuardado FROM manuales_versiones WHERE Id = ? AND PaginaId = ?', [versionId, id]);
    if (!p || !v) {
      await conn.rollback();
      return res.status(404).json({ error: 'La página o la versión no existe.' });
    }
    await copiarVersionSiCorresponde(conn, id, req, true);
    const html = sanitizar(v.ContenidoHtml || '');
    await conn.query(
      'UPDATE manuales_paginas SET Titulo = ?, ContenidoHtml = ?, ContenidoTexto = ?, Version = Version + 1, ActualizadoPor = ?, FechaActualizacion = NOW() WHERE Id = ?',
      [v.Titulo, html, aTexto(html), usuario(req), id]
    );
    const [[nuevo]] = await conn.query('SELECT Version FROM manuales_paginas WHERE Id = ?', [id]);
    await conn.commit();
    await auditar(pool, req, { entidad: 'Pagina', entidadId: id, entidadNombre: v.Titulo, accion: 'EDICION', detalle: `Versión anterior restaurada (guardada el ${new Date(v.FechaGuardado).toISOString().slice(0, 16).replace('T', ' ')}).` });
    res.json({ version: nuevo.Version });
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}));

// ---------- importar ----------

// Marca como «AxisCode» las ejecuciones de texto con fuente de ancho fijo para
// que mammoth las convierta en <code> (Word no tiene bloques de código).
const RE_FUENTE_FIJA = /<w:rFonts\b[^>]*w:(?:ascii|hAnsi|cs)="(?:Consolas|Courier New|Courier|Lucida Console|Lucida Sans Typewriter|Monaco|Menlo|Cascadia[^"]*|Source Code Pro|DejaVu Sans Mono|Liberation Mono|Fira Code)"/i;

async function marcarCodigoEnWord(buffer) {
  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const archivoDoc = zip.file('word/document.xml');
    const archivoEstilos = zip.file('word/styles.xml');
    if (!archivoDoc || !archivoEstilos) return buffer;
    let xml = await archivoDoc.async('string');
    let estilos = await archivoEstilos.async('string');
    let cambios = 0;
    xml = xml.replace(/<w:r(\s[^>]*)?>([\s\S]*?)<\/w:r>/g, (m, attrs, interior) => {
      if (!RE_FUENTE_FIJA.test(interior) || /<w:rStyle\b/.test(interior)) return m;
      cambios += 1;
      const marca = '<w:rStyle w:val="AxisCode"/>';
      const nuevo = /<w:rPr>/.test(interior) ? interior.replace('<w:rPr>', `<w:rPr>${marca}`) : `<w:rPr>${marca}</w:rPr>${interior}`;
      return `<w:r${attrs || ''}>${nuevo}</w:r>`;
    });
    if (!cambios) return buffer;
    estilos = estilos.replace('</w:styles>', '<w:style w:type="character" w:styleId="AxisCode"><w:name w:val="AxisCode"/></w:style></w:styles>');
    zip.file('word/document.xml', xml);
    zip.file('word/styles.xml', estilos);
    return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch (error) {
    console.error('No se pudo detectar el código del Word:', error.message);
    return buffer;
  }
}

async function convertirWord(bufferOriginal) {
  const mammoth = require('mammoth');
  const buffer = await marcarCodigoEnWord(bufferOriginal);
  const { value, messages } = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Título'] => h1:fresh",
        "p[style-name='Titulo'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
        "p[style-name='Subtítulo'] => h2:fresh",
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Título 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Título 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Título 3'] => h3:fresh",
        "p[style-name='Code'] => pre:fresh",
        "p[style-name='Código'] => pre:fresh",
        "r[style-name='AxisCode'] => code",
        "br[type='page'] => hr.page-break",
      ],
      convertImage: mammoth.images.imgElement(async (imagen) => {
        const base64 = await imagen.read('base64');
        return { src: `data:${imagen.contentType};base64,${base64}` };
      }),
    }
  );
  const imagenesNoSoportadas = (value.match(/<img\b[^>]*src="data:(?!image\/(png|jpe?g|gif|webp|bmp);base64,)/gi) || []).length;
  return { html: agruparCodigo(value), imagenesNoSoportadas, mensajes: messages };
}

async function extraerTextoPdf(buffer) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  // pdf-parse trae varias versiones de pdf.js; algunos PDF que una no lee los abre otra.
  let ultimoError = null;
  for (const version of ['v1.10.100', 'v2.0.550']) {
    try {
      const datos = await pdfParse(buffer, { version });
      return String(datos.text || '').replace(/\s+\n/g, '\n').slice(0, 2000000);
    } catch (error) {
      ultimoError = error;
    }
  }
  throw ultimoError;
}

router.post(
  '/importar',
  requireEditPermission,
  permisoImportar,
  express.raw({ type: () => true, limit: TAMANO_MAX_IMPORTACION }),
  manejar('importar el archivo', async (req, res) => {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || !buffer.length) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

    let nombreArchivo = '';
    try { nombreArchivo = decodeURIComponent(String(req.headers['x-nombre-archivo'] || '')); } catch { nombreArchivo = ''; }
    nombreArchivo = nombreArchivo.replace(/[\\/]/g, '_').slice(0, 255) || 'Documento';
    const tituloBase = texto(nombreArchivo.replace(/\.[a-z0-9]{2,5}$/i, ''), 200) || 'Documento';

    const esDocx = buffer.slice(0, 2).toString('latin1') === 'PK' && /\.docx$/i.test(nombreArchivo);
    const esPdf = buffer.slice(0, 5).toString('latin1') === '%PDF-';
    if (!esDocx && !esPdf) {
      return res.status(400).json({ error: 'Solo se pueden importar archivos Word (.docx) o PDF. Si tu archivo es .doc, ábrelo en Word y guárdalo como .docx.' });
    }

    const modo = String(req.query.modo || 'auto');
    const avisos = [];
    let paginas = [];
    let modoUsado = 'una';

    if (esDocx) {
      let conv;
      try {
        conv = await convertirWord(buffer);
      } catch (error) {
        console.error('Error al leer el Word:', error);
        return res.status(422).json({ error: 'No se pudo leer el archivo Word. Verifica que no esté dañado ni protegido con contraseña.' });
      }
      if (conv.imagenesNoSoportadas) avisos.push(`${conv.imagenesNoSoportadas} imagen(es) en un formato que el navegador no muestra (por ejemplo EMF/WMF) se omitieron.`);
      const dividido = dividirPaginas(conv.html, modo, tituloBase);
      modoUsado = dividido.modo;
      paginas = dividido.paginas.slice(0, MAX_PAGINAS_IMPORTACION).map((pg) => ({ ...pg, tipo: 'RICO', html: sanitizar(pg.html) }));
      if (dividido.paginas.length > MAX_PAGINAS_IMPORTACION) avisos.push(`El archivo tenía ${dividido.paginas.length} páginas; se importaron las primeras ${MAX_PAGINAS_IMPORTACION}.`);
      let omitidas = 0;
      for (const pg of paginas) {
        const aj = ajustarTamano(pg.html, TAMANO_MAX_HTML);
        pg.html = aj.html;
        omitidas += aj.omitidas;
      }
      if (omitidas) avisos.push(`${omitidas} imagen(es) muy pesadas se omitieron para que las páginas quepan en la base de datos.`);
      paginas = paginas.filter((pg) => tieneContenido(pg.html) || pg.titulo);
      if (!paginas.length) return res.status(422).json({ error: 'El archivo Word no tiene contenido para importar.' });
    } else {
      if (buffer.length > TAMANO_MAX_PDF) {
        return res.status(413).json({ error: `El PDF pesa ${(buffer.length / 1048576).toFixed(1)} MB y el máximo es 14 MB. Comprímelo o divídelo e inténtalo de nuevo.` });
      }
      let textoPdf = '';
      try {
        textoPdf = await extraerTextoPdf(buffer);
      } catch (error) {
        console.error('No se pudo extraer el texto del PDF:', error.message);
      }
      if (!textoPdf.trim()) avisos.push('No se pudo extraer texto del PDF (puede ser un documento escaneado), por lo que no aparecerá en las búsquedas por contenido.');
      paginas = [{ titulo: tituloBase, tipo: 'PDF', html: '', texto: textoPdf, fechaOrigen: null }];
      modoUsado = 'pdf';
    }

    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let libretaId = idValido(req.query.libretaId);
      let seccionId = idValido(req.query.seccionId);
      let seccionNombre = null;

      if (seccionId) {
        const [[s]] = await conn.query('SELECT s.LibretaId, s.Nombre FROM manuales_secciones s JOIN manuales_libretas l ON l.Id = s.LibretaId WHERE s.Id = ? AND s.Activo = 1 AND l.Activo = 1', [seccionId]);
        if (!s) { await conn.rollback(); return res.status(404).json({ error: 'La sección de destino no existe.' }); }
        libretaId = s.LibretaId;
        seccionNombre = s.Nombre;
      } else {
        if (libretaId) {
          const [[l]] = await conn.query('SELECT Id FROM manuales_libretas WHERE Id = ? AND Activo = 1', [libretaId]);
          if (!l) { await conn.rollback(); return res.status(404).json({ error: 'La libreta de destino no existe.' }); }
        } else {
          const nombreLibreta = texto(req.query.nombreLibreta, 150) || tituloBase;
          const ordenL = await siguienteOrden(conn, 'manuales_libretas', '1', 1);
          const [rl] = await conn.query('INSERT INTO manuales_libretas (Nombre, Orden, CreadoPor) VALUES (?, ?, ?)', [nombreLibreta, ordenL, usuario(req)]);
          libretaId = rl.insertId;
        }
        seccionNombre = texto(req.query.nombreSeccion, 150) || tituloBase;
        const ordenS = await siguienteOrden(conn, 'manuales_secciones', 'LibretaId', libretaId);
        const [rs] = await conn.query('INSERT INTO manuales_secciones (LibretaId, Nombre, Color, Orden, CreadoPor) VALUES (?, ?, ?, ?, ?)', [libretaId, seccionNombre, PALETA[(ordenS - 1) % PALETA.length], ordenS, usuario(req)]);
        seccionId = rs.insertId;
      }

      let orden = await siguienteOrden(conn, 'manuales_paginas', 'SeccionId', seccionId);
      let primera = null;
      for (const pg of paginas) {
        const titulo = texto(pg.titulo, 255) || tituloBase;
        let r;
        if (pg.tipo === 'PDF') {
          [r] = await conn.query(
            `INSERT INTO manuales_paginas (SeccionId, Titulo, Tipo, ContenidoTexto, ArchivoNombre, ArchivoMime, ArchivoTamano, ArchivoDatos, Orden, CreadoPor, ActualizadoPor)
             VALUES (?, ?, 'PDF', ?, ?, 'application/pdf', ?, ?, ?, ?, ?)`,
            [seccionId, titulo, pg.texto || '', nombreArchivo, buffer.length, buffer, orden, usuario(req), usuario(req)]
          );
        } else {
          [r] = await conn.query(
            `INSERT INTO manuales_paginas (SeccionId, Titulo, Tipo, ContenidoHtml, ContenidoTexto, FechaOrigen, Orden, CreadoPor, ActualizadoPor)
             VALUES (?, ?, 'RICO', ?, ?, ?, ?, ?, ?)`,
            [seccionId, titulo, pg.html, aTexto(pg.html), pg.fechaOrigen || null, orden, usuario(req), usuario(req)]
          );
        }
        if (!primera) primera = r.insertId;
        orden += 1;
      }
      await conn.commit();
      await auditar(pool, req, {
        entidad: 'Seccion',
        entidadId: seccionId,
        entidadNombre: seccionNombre,
        accion: 'CREACION',
        detalle: `Importado «${nombreArchivo}»: ${paginas.length} página(s).`,
      });
      res.status(201).json({ libretaId, seccionId, primeraPaginaId: primera, modo: modoUsado, paginas: paginas.length, avisos });
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  })
);

router.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El archivo supera el máximo permitido (120 MB).' });
  }
  next(err);
});

// ---------- exportar a Word ----------

function htmlParaWord(titulo, bloques) {
  const cuerpo = bloques
    .map((b, i) => {
      const f = b.fecha ? new Date(b.fecha) : null;
      const sinHora = f && f.getHours() === 0 && f.getMinutes() === 0;
      const fecha = f ? `<p><em>${f.toLocaleString('es-CO', sinHora ? { dateStyle: 'full' } : { dateStyle: 'full', timeStyle: 'short' })}</em></p>` : '';
      const salto = i > 0 ? '<div class="page-break" style="page-break-after: always"></div>' : '';
      return `${salto}<h1>${escaparHtml(b.titulo)}</h1>${fecha}${b.html}`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escaparHtml(titulo)}</title></head><body>${cuerpo}</body></html>`;
}

function escaparHtml(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function generarDocx(titulo, bloques) {
  const HTMLtoDOCX = require('html-to-docx');
  const salida = await HTMLtoDOCX(htmlParaWord(titulo, bloques), null, {
    title: titulo,
    font: 'Calibri',
    fontSize: 22,
    table: { row: { cantSplit: true } },
    footer: false,
    pageNumber: false,
  });
  return Buffer.isBuffer(salida) ? salida : Buffer.from(await salida.arrayBuffer());
}

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

router.get('/paginas/:id/exportar/docx', manejar('exportar a Word', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Página no válida.' });
  const pool = await getPool();
  const [[p]] = await pool.query("SELECT Titulo, ContenidoHtml, FechaOrigen FROM manuales_paginas WHERE Id = ? AND Activo = 1 AND Tipo = 'RICO'", [id]);
  if (!p) return res.status(404).json({ error: 'La página no existe o es un PDF (descárgalo directamente).' });
  const buffer = await generarDocx(p.Titulo, [{ titulo: p.Titulo, html: sanitizar(p.ContenidoHtml || ''), fecha: p.FechaOrigen }]);
  enviarArchivo(res, nombreArchivoSeguro(p.Titulo, 'docx'), MIME_DOCX, buffer, true);
}));

router.get('/secciones/:id/exportar/docx', manejar('exportar a Word', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Sección no válida.' });
  const pool = await getPool();
  const [[s]] = await pool.query('SELECT Nombre FROM manuales_secciones WHERE Id = ? AND Activo = 1', [id]);
  if (!s) return res.status(404).json({ error: 'La sección no existe.' });
  const [paginas] = await pool.query("SELECT Titulo, ContenidoHtml, FechaOrigen FROM manuales_paginas WHERE SeccionId = ? AND Activo = 1 AND Tipo = 'RICO' ORDER BY Orden, Id", [id]);
  if (!paginas.length) return res.status(404).json({ error: 'La sección no tiene páginas de texto para exportar.' });
  const buffer = await generarDocx(s.Nombre, paginas.map((p) => ({ titulo: p.Titulo, html: sanitizar(p.ContenidoHtml || ''), fecha: p.FechaOrigen })));
  enviarArchivo(res, nombreArchivoSeguro(s.Nombre, 'docx'), MIME_DOCX, buffer, true);
}));

// ---------- compartir una libreta con otras personas (la otra persona debe aceptar) ----------

const PERMISOS = new Set(['LECTURA', 'EDICION']);
const nombreDe = (u) => u?.nombre_completo || u?.username || 'Alguien';

// ¿La persona tiene el módulo Manuales (o es ADMIN_POD)? Sin él no podría abrir el manual compartido.
async function tieneModuloManuales(pool, usuarioId) {
  const [[r]] = await pool.query(
    `SELECT u.rol, EXISTS (SELECT 1 FROM usuario_modulos um JOIN modulos m ON m.id = um.modulo_id WHERE um.usuario_id = u.id AND m.nombre = 'MANUALES') AS tiene
       FROM usuarios u WHERE u.id = ? AND u.activo = 1`,
    [usuarioId]
  );
  return !!r && (r.rol === 'ADMIN_POD' || Number(r.tiene) === 1);
}

// Personas a las que se puede compartir: activas y con el módulo Manuales.
router.get('/usuarios-compartir', manejar('las personas', async (req, res) => {
  const pool = await getPool();
  const [filas] = await pool.query(
    `SELECT u.id, u.username, u.nombre_completo FROM usuarios u
      WHERE u.activo = 1 AND (u.rol = 'ADMIN_POD' OR EXISTS (SELECT 1 FROM usuario_modulos um JOIN modulos m ON m.id = um.modulo_id WHERE um.usuario_id = u.id AND m.nombre = 'MANUALES'))
      ORDER BY u.nombre_completo`
  );
  res.json(filas);
}));

async function usuarioPorUsername(pool, username) {
  const [[u]] = await pool.query('SELECT id, username, nombre_completo FROM usuarios WHERE username = ? AND activo = 1', [username]);
  return u || null;
}

// Cierra (marca con el resultado) las notificaciones de esa solicitud que seguían esperando respuesta.
async function cerrarNotificaciones(pool, comparticionId, estado) {
  try {
    await pool.query(
      "UPDATE notificaciones SET Accion = ?, Leida = 1, FechaLeida = COALESCE(FechaLeida, NOW()) WHERE Tipo = 'MANUAL_COMPARTIR' AND Referencia = ? AND Accion = 'PENDIENTE'",
      [estado, comparticionId]
    );
  } catch (error) {
    console.error('No se pudo cerrar la notificación de compartir:', error.message);
  }
}

router.get('/libretas/:id/comparticiones', manejar('las personas con acceso', async (req, res) => {
  const pool = await getPool();
  const [filas] = await pool.query(
    `SELECT c.Id, c.Destinatario, u.nombre_completo, c.Permiso, c.Estado, c.FechaSolicitud, c.FechaRespuesta
       FROM manuales_comparticiones c LEFT JOIN usuarios u ON u.username COLLATE utf8mb4_unicode_ci = c.Destinatario
      WHERE c.LibretaId = ? AND c.Estado IN ('PENDIENTE', 'ACEPTADA', 'RECHAZADA')
      ORDER BY FIELD(c.Estado, 'ACEPTADA', 'PENDIENTE', 'RECHAZADA'), c.FechaSolicitud DESC`,
    [req.libretaIdManual]
  );
  res.json(filas.map((c) => ({
    id: c.Id, usuario: c.Destinatario, nombre: c.nombre_completo || c.Destinatario, permiso: c.Permiso, estado: c.Estado,
    fechaSolicitud: c.FechaSolicitud, fechaRespuesta: c.FechaRespuesta,
  })));
}));

router.post('/libretas/:id/compartir', requireEditPermission, manejar('compartir la libreta', async (req, res) => {
  const pool = await getPool();
  const destinatarioId = idValido(req.body?.destinatarioId);
  const permiso = String(req.body?.permiso || 'LECTURA').toUpperCase();
  if (!destinatarioId) return res.status(400).json({ error: 'Elige con quién compartir.' });
  if (!PERMISOS.has(permiso)) return res.status(400).json({ error: 'El permiso debe ser Lectura o Edición.' });
  const [[dest]] = await pool.query('SELECT id, username, nombre_completo FROM usuarios WHERE id = ? AND activo = 1', [destinatarioId]);
  if (!dest) return res.status(404).json({ error: 'Esa persona no existe o está inactiva.' });
  if (mismoUsuario(dest.username, usuario(req))) return res.status(400).json({ error: 'El manual ya es tuyo.' });
  if (!(await tieneModuloManuales(pool, dest.id))) {
    return res.status(400).json({ error: `${nombreDe(dest)} no tiene habilitado el módulo Manuales. Pídele a un administrador que se lo habilite y luego compártelo.` });
  }

  const libretaId = req.libretaIdManual;
  const libreta = req.accesoManual.libreta;
  const [[previa]] = await pool.query('SELECT Id, Estado, Permiso FROM manuales_comparticiones WHERE LibretaId = ? AND Destinatario = ?', [libretaId, dest.username]);
  let comparticionId;
  if (previa && previa.Estado === 'PENDIENTE') return res.status(409).json({ error: `Ya hay una solicitud pendiente para ${nombreDe(dest)}.` });
  if (previa && previa.Estado === 'ACEPTADA') {
    if (previa.Permiso === permiso) return res.status(409).json({ error: `${nombreDe(dest)} ya tiene este permiso sobre el manual.` });
    await pool.query('UPDATE manuales_comparticiones SET Permiso = ? WHERE Id = ?', [permiso, previa.Id]);
    await notificar(pool, {
      usuarioId: dest.id, tipo: 'MANUAL_PERMISO', severidad: 'INFO', titulo: 'Cambió tu permiso en un manual', referencia: previa.Id, enlace: '/manuales',
      mensaje: `${nombreDe(req.user)} cambió tu permiso en «${libreta.Nombre}»: ahora es ${permiso === 'EDICION' ? 'edición' : 'solo lectura'}.`, clave: `manual-permiso-${previa.Id}-${Date.now()}`,
    });
    await auditar(pool, req, { entidad: 'Libreta', entidadId: libretaId, entidadNombre: libreta.Nombre, accion: 'EDICION', detalle: `Permiso de ${dest.username} cambiado a ${permiso}.` });
    return res.json({ id: previa.Id, estado: 'ACEPTADA', permiso });
  }
  if (previa) {
    await pool.query("UPDATE manuales_comparticiones SET Estado = 'PENDIENTE', Permiso = ?, Propietario = ?, FechaSolicitud = NOW(), FechaRespuesta = NULL WHERE Id = ?", [permiso, usuario(req), previa.Id]);
    comparticionId = previa.Id;
  } else {
    const [r] = await pool.query('INSERT INTO manuales_comparticiones (LibretaId, Propietario, Destinatario, Permiso) VALUES (?, ?, ?, ?)', [libretaId, usuario(req), dest.username, permiso]);
    comparticionId = r.insertId;
  }
  await notificar(pool, {
    usuarioId: dest.id, tipo: 'MANUAL_COMPARTIR', severidad: 'AVISO', titulo: 'Quieren compartir un manual contigo', referencia: comparticionId, enlace: '/manuales', accion: 'PENDIENTE',
    mensaje: `${nombreDe(req.user)} quiere compartirte el manual «${libreta.Nombre}» con permiso de ${permiso === 'EDICION' ? 'edición' : 'solo lectura'}. Solo lo verás si lo aceptas.`,
    clave: `manual-comp-${comparticionId}-${Date.now()}`,
  });
  await auditar(pool, req, { entidad: 'Libreta', entidadId: libretaId, entidadNombre: libreta.Nombre, accion: 'EDICION', detalle: `Solicitud para compartir con ${dest.username} (${permiso}).` });
  res.status(201).json({ id: comparticionId, estado: 'PENDIENTE', permiso });
}));

// Solicitudes que esperan MI respuesta (también llegan como notificación).
router.get('/comparticiones/pendientes', manejar('las solicitudes pendientes', async (req, res) => {
  const pool = await getPool();
  const [filas] = await pool.query(
    `SELECT c.Id, c.Permiso, c.FechaSolicitud, c.Propietario, u.nombre_completo, l.Nombre AS Libreta
       FROM manuales_comparticiones c
       JOIN manuales_libretas l ON l.Id = c.LibretaId AND l.Activo = 1
       LEFT JOIN usuarios u ON u.username COLLATE utf8mb4_unicode_ci = c.Propietario
      WHERE c.Destinatario = ? AND c.Estado = 'PENDIENTE' ORDER BY c.FechaSolicitud DESC`,
    [usuario(req)]
  );
  res.json(filas.map((c) => ({
    id: c.Id, libreta: c.Libreta, propietario: c.nombre_completo || c.Propietario, permiso: c.Permiso, fechaSolicitud: c.FechaSolicitud,
  })));
}));

// La persona destinataria acepta o rechaza (no requiere permiso de edición: es una decisión personal).
router.post('/comparticiones/:id/responder', manejar('responder la solicitud', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Solicitud no válida.' });
  const aceptar = req.body?.aceptar === true;
  const pool = await getPool();
  if (aceptar && req.user.rol !== 'ADMIN_POD' && !(req.user.modulos || []).includes('MANUALES') && !(await tieneModuloManuales(pool, req.user.id))) {
    return res.status(403).json({ error: 'Para aceptar un manual compartido necesitas el módulo Manuales. Pídele a un administrador que te lo habilite y vuelve a intentarlo (puedes rechazar la solicitud si no la quieres).' });
  }
  const [[c]] = await pool.query(
    `SELECT c.Id, c.LibretaId, c.Propietario, c.Destinatario, c.Permiso, c.Estado, l.Nombre AS Libreta
       FROM manuales_comparticiones c JOIN manuales_libretas l ON l.Id = c.LibretaId AND l.Activo = 1 WHERE c.Id = ?`,
    [id]
  );
  if (!c || !mismoUsuario(c.Destinatario, usuario(req))) return res.status(404).json({ error: 'La solicitud no existe.' });
  if (c.Estado !== 'PENDIENTE') return res.status(409).json({ error: 'Esta solicitud ya fue respondida o el dueño la canceló.' });
  const estado = aceptar ? 'ACEPTADA' : 'RECHAZADA';
  await pool.query('UPDATE manuales_comparticiones SET Estado = ?, FechaRespuesta = NOW() WHERE Id = ?', [estado, id]);
  await cerrarNotificaciones(pool, id, estado);
  const dueno = await usuarioPorUsername(pool, c.Propietario);
  if (dueno) {
    await notificar(pool, {
      usuarioId: dueno.id, tipo: 'MANUAL_RESPUESTA', severidad: 'INFO', titulo: aceptar ? 'Aceptaron tu manual compartido' : 'Rechazaron tu manual compartido',
      referencia: id, enlace: '/manuales', clave: `manual-resp-${id}-${Date.now()}`,
      mensaje: `${nombreDe(req.user)} ${aceptar ? 'aceptó' : 'rechazó'} el manual «${c.Libreta}»${aceptar ? ` (${c.Permiso === 'EDICION' ? 'edición' : 'solo lectura'})` : ''}.`,
    });
  }
  await auditar(pool, req, { entidad: 'Libreta', entidadId: c.LibretaId, entidadNombre: c.Libreta, accion: 'EDICION', detalle: `${usuario(req)} ${aceptar ? 'aceptó' : 'rechazó'} el manual compartido por ${c.Propietario}.` });
  res.json({ ok: true, estado, libretaId: c.LibretaId });
}));

// Quita el acceso: lo hace el dueño (revoca o cancela la solicitud) o la persona que lo recibió (deja de seguirlo).
router.delete('/comparticiones/:id', manejar('quitar el acceso', async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: 'Solicitud no válida.' });
  const pool = await getPool();
  const [[c]] = await pool.query(
    `SELECT c.Id, c.LibretaId, c.Propietario, c.Destinatario, c.Estado, l.Nombre AS Libreta
       FROM manuales_comparticiones c JOIN manuales_libretas l ON l.Id = c.LibretaId WHERE c.Id = ?`,
    [id]
  );
  const yo = usuario(req);
  const esDueno = !!c && mismoUsuario(c.Propietario, yo);
  const esDestinatario = !!c && mismoUsuario(c.Destinatario, yo);
  if (!c || (!esDueno && !esDestinatario)) return res.status(404).json({ error: 'La solicitud no existe.' });
  if (!['PENDIENTE', 'ACEPTADA'].includes(c.Estado)) return res.json({ ok: true });
  await pool.query("UPDATE manuales_comparticiones SET Estado = 'REVOCADA', FechaRespuesta = NOW() WHERE Id = ?", [id]);
  await cerrarNotificaciones(pool, id, 'REVOCADA');
  const otro = await usuarioPorUsername(pool, esDueno ? c.Destinatario : c.Propietario);
  if (otro) {
    await notificar(pool, {
      usuarioId: otro.id, tipo: 'MANUAL_REVOCADO', severidad: 'INFO', referencia: id, enlace: '/manuales', clave: `manual-rev-${id}-${Date.now()}`,
      titulo: esDueno ? 'Te quitaron el acceso a un manual' : 'Dejaron de seguir tu manual compartido',
      mensaje: esDueno ? `${nombreDe(req.user)} dejó de compartir contigo «${c.Libreta}».` : `${nombreDe(req.user)} dejó de usar tu manual compartido «${c.Libreta}».`,
    });
  }
  await auditar(pool, req, { entidad: 'Libreta', entidadId: c.LibretaId, entidadNombre: c.Libreta, accion: 'EDICION', detalle: `Acceso de ${c.Destinatario} ${esDueno ? 'revocado' : 'abandonado por la persona'}.` });
  res.json({ ok: true });
}));

module.exports = router;
