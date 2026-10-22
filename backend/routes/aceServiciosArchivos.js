// Archivos de consumo por servicio: el XML del proyecto de SoapUI (servicios SOAP) o la
// colección (Postman, Insomnia, OpenAPI…) de los servicios REST. Quien necesite consumir
// el servicio solo descarga el archivo y lo abre en la aplicación que corresponda.
//
// Se guardan en la tabla AceServiciosArchivos (base64 dentro de la fila, igual que los adjuntos
// de la bitácora de pasos a producción: no hace falta ningún volumen aparte en Docker).
// Si la tabla aún no existe (falta correr crear_tabla_aceservicios_archivos.sql) el resto de
// Servicios sigue funcionando y estas rutas responden con un mensaje claro.

const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const { detectarClase, EXTENSIONES_VALIDAS, ETIQUETAS_CLASE } = require('../utils/archivosServicio');

const TAMANO_MAXIMO_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVOS_POR_SERVICIO = 20;
const MENSAJE_SIN_TABLA =
  'Para adjuntar archivos a los servicios falta crear la tabla AceServiciosArchivos en la base de datos. ' +
  'Ejecuta una sola vez crear_tabla_aceservicios_archivos.sql.';

let estadoTabla = { lista: false, revisadoEn: 0 };
async function tablaLista(pool) {
  if (estadoTabla.lista) return true;
  if (Date.now() - estadoTabla.revisadoEn < 30 * 1000) return false;
  try {
    await pool.query('SELECT 1 FROM AceServiciosArchivos LIMIT 1');
    estadoTabla = { lista: true, revisadoEn: Date.now() };
    return true;
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      estadoTabla = { lista: false, revisadoEn: Date.now() };
      return false;
    }
    throw error;
  }
}

// Cantidad de archivos por servicio, para mostrarla en la lista. Sin la tabla: mapa vacío.
async function contarArchivosPorServicio(pool) {
  try {
    if (!(await tablaLista(pool))) return new Map();
    const [filas] = await pool.query('SELECT ServicioId, COUNT(*) AS total FROM AceServiciosArchivos GROUP BY ServicioId');
    return new Map(filas.map((f) => [f.ServicioId, Number(f.total)]));
  } catch (error) {
    console.error('No se pudo contar los archivos de los servicios:', error.message);
    return new Map();
  }
}

const COLUMNAS_META = `a.Id, a.ServicioId, a.NombreOriginal, a.Clase, a.MimeType, a.TamanoBytes, a.Descripcion,
       a.SubidoPorId, u.nombre_completo AS SubidoPorNombre, a.FechaSubida`;

function conEtiqueta(fila) {
  return { ...fila, ClaseEtiqueta: ETIQUETAS_CLASE[fila.Clase] || ETIQUETAS_CLASE.OTRO };
}

function registrar(router, { getPool }) {
  async function servicioDe(pool, id) {
    const [[s]] = await pool.query('SELECT Id, NombreServicio, Tipo FROM AceServiciosInventario WHERE Id = ?', [id]).catch(async () => {
      // Instalaciones sin la columna Tipo.
      return pool.query('SELECT Id, NombreServicio FROM AceServiciosInventario WHERE Id = ?', [id]);
    });
    return s || null;
  }

  // GET /api/ace-servicios/:id/archivos - solo metadatos (nunca el contenido)
  router.get('/:id/archivos', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.json({ disponible: false, mensaje: MENSAJE_SIN_TABLA, archivos: [] });
      const [filas] = await pool.query(
        `SELECT ${COLUMNAS_META}
           FROM AceServiciosArchivos a
           LEFT JOIN usuarios u ON u.id = a.SubidoPorId
          WHERE a.ServicioId = ?
          ORDER BY a.FechaSubida DESC, a.Id DESC`,
        [req.params.id]
      );
      res.json({ disponible: true, mensaje: null, archivos: filas.map(conEtiqueta) });
    } catch (error) {
      console.error('Error al listar los archivos del servicio:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'los archivos del servicio' }) });
    }
  });

  // POST /api/ace-servicios/:id/archivos - subir (body: nombreOriginal, contenidoBase64, descripcion?)
  router.post('/:id/archivos', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
    const { nombreOriginal, contenidoBase64, descripcion } = req.body || {};
    const nombre = String(nombreOriginal || '').trim().replace(/[\\/]+/g, '_');
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre del archivo.' });
    const extension = nombre.includes('.') ? nombre.split('.').pop().toLowerCase() : '';
    if (!EXTENSIONES_VALIDAS.has(extension)) {
      return res.status(400).json({ error: `Tipo de archivo no permitido. Extensiones válidas: ${[...EXTENSIONES_VALIDAS].join(', ')}.` });
    }
    if (!contenidoBase64 || typeof contenidoBase64 !== 'string') return res.status(400).json({ error: 'Falta el contenido del archivo.' });

    const coincidencia = contenidoBase64.match(/^data:([^;]*);base64,(.+)$/s);
    const base64Puro = coincidencia ? coincidencia[2] : contenidoBase64;
    const buffer = Buffer.from(base64Puro, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'El archivo está vacío.' });
    if (buffer.length > TAMANO_MAXIMO_BYTES) {
      return res.status(400).json({ error: `El archivo supera el tamaño máximo permitido (${Math.round(TAMANO_MAXIMO_BYTES / (1024 * 1024))} MB).` });
    }
    const analisis = detectarClase(nombre, buffer);
    if (analisis.error) return res.status(400).json({ error: analisis.error });

    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.status(409).json({ error: MENSAJE_SIN_TABLA });
      const servicio = await servicioDe(pool, req.params.id);
      if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado.' });
      const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM AceServiciosArchivos WHERE ServicioId = ?', [servicio.Id]);
      if (Number(total) >= MAX_ARCHIVOS_POR_SERVICIO) {
        return res.status(400).json({ error: `Un servicio puede tener hasta ${MAX_ARCHIVOS_POR_SERVICIO} archivos. Elimina alguno antes de subir otro.` });
      }

      const [r] = await pool.query(
        `INSERT INTO AceServiciosArchivos (ServicioId, NombreOriginal, Clase, MimeType, TamanoBytes, Descripcion, ContenidoBase64, SubidoPorId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          servicio.Id, nombre.slice(0, 255), analisis.clase, analisis.mime, buffer.length,
          descripcion ? String(descripcion).trim().slice(0, 300) || null : null, buffer.toString('base64'), req.user.id,
        ]
      );
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVICIOS', entidad: 'Servicio ACE', entidadId: servicio.Id, entidadNombre: servicio.NombreServicio,
        accion: 'ARCHIVO_AGREGADO',
        detalle: `Archivo "${nombre}" (${ETIQUETAS_CLASE[analisis.clase]}, ${Math.max(1, Math.round(buffer.length / 1024))} KB).`,
      });
      const [[fila]] = await pool.query(
        `SELECT ${COLUMNAS_META} FROM AceServiciosArchivos a LEFT JOIN usuarios u ON u.id = a.SubidoPorId WHERE a.Id = ?`, [r.insertId]);
      res.status(201).json(conEtiqueta(fila));
    } catch (error) {
      console.error('Error al subir el archivo del servicio:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el archivo del servicio' }) });
    }
  });

  // GET /api/ace-servicios/:id/archivos/:archivoId/descargar - el archivo tal cual se subió
  router.get('/:id/archivos/:archivoId/descargar', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.status(409).json({ error: MENSAJE_SIN_TABLA });
      const [[a]] = await pool.query(
        'SELECT NombreOriginal, MimeType, ContenidoBase64 FROM AceServiciosArchivos WHERE Id = ? AND ServicioId = ?',
        [req.params.archivoId, req.params.id]
      );
      if (!a) return res.status(404).json({ error: 'Archivo no encontrado.' });
      const contenido = Buffer.from(a.ContenidoBase64, 'base64');
      const nombreSeguro = a.NombreOriginal.replace(/[^\w.\- ()áéíóúÁÉÍÓÚñÑ]/g, '_');
      res.setHeader('Content-Type', a.MimeType || 'application/octet-stream');
      res.setHeader('Content-Length', contenido.length);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nombreSeguro)}"; filename*=UTF-8''${encodeURIComponent(nombreSeguro)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(contenido);
    } catch (error) {
      console.error('Error al descargar el archivo del servicio:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el archivo del servicio' }) });
    }
  });

  // DELETE /api/ace-servicios/:id/archivos/:archivoId
  router.delete('/:id/archivos/:archivoId', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.status(409).json({ error: MENSAJE_SIN_TABLA });
      const [[a]] = await pool.query(
        'SELECT Id, NombreOriginal FROM AceServiciosArchivos WHERE Id = ? AND ServicioId = ?', [req.params.archivoId, req.params.id]);
      if (!a) return res.status(404).json({ error: 'Archivo no encontrado.' });
      await pool.query('DELETE FROM AceServiciosArchivos WHERE Id = ?', [a.Id]);
      const servicio = await servicioDe(pool, req.params.id);
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVICIOS', entidad: 'Servicio ACE', entidadId: req.params.id, entidadNombre: servicio ? servicio.NombreServicio : null,
        accion: 'ARCHIVO_ELIMINADO', detalle: `Archivo eliminado: "${a.NombreOriginal}".`,
      });
      res.status(204).send();
    } catch (error) {
      console.error('Error al eliminar el archivo del servicio:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el archivo del servicio' }) });
    }
  });
}

module.exports = { registrar, contarArchivosPorServicio };
