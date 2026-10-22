// Peticiones guardadas por servicio (una por operación). Reemplaza al único «Request de ejemplo»:
// un servicio puede tener varias operaciones y cada una necesita su propio request.
//
//  - Se guardan en AceServiciosPeticiones (tabla creada con crear_tabla_aceservicios_peticiones.sql).
//    Si la tabla aún no existe el resto de Servicios sigue funcionando y estas rutas responden con un mensaje claro.
//  - Nunca se guardan credenciales: las cabeceras Authorization, Cookie y similares se descartan.
//  - No se repite el nombre ni el mismo contenido (método + URL + cuerpo) dentro de un servicio.
//  - Cada petición es ÚNICA de quien la guardó: solo su dueño la ve, la edita y la borra. Cualquier usuario del módulo
//    puede guardar las suyas, también con rol Consulta (queda auditado con más detalle, ver utils/auditoriaConsulta.js).
//    El nombre y el contenido no se repiten dentro del servicio PARA ESA PERSONA. Para que dos personas puedan usar el
//    mismo nombre hay que ejecutar una vez ajustar_peticiones_por_usuario.sql (cambia la clave única); mientras tanto,
//    si el nombre ya lo usa otra persona se avisa y se pide otro.

const crypto = require('crypto');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { auditarServicios, sanitizarCuerpo } = require('../utils/auditoriaConsulta');

const METODOS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_PETICIONES_POR_SERVICIO = 100;
const MAX_POR_LLAMADA = 100;
const MAX_CUERPO = 500 * 1000;
const MAX_CABECERAS = 40;
const CABECERAS_SECRETAS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'apikey']);
const MENSAJE_SIN_TABLA =
  'Para guardar peticiones por servicio falta crear la tabla AceServiciosPeticiones en la base de datos. ' +
  'Ejecuta una sola vez crear_tabla_aceservicios_peticiones.sql.';

let estadoTabla = { lista: false, revisadoEn: 0 };
async function tablaLista(pool) {
  if (estadoTabla.lista) return true;
  if (Date.now() - estadoTabla.revisadoEn < 30 * 1000) return false;
  try {
    await pool.query('SELECT 1 FROM AceServiciosPeticiones LIMIT 1');
    estadoTabla = { lista: true, revisadoEn: Date.now() };
    return true;
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') { estadoTabla = { lista: false, revisadoEn: Date.now() }; return false; }
    throw error;
  }
}

// Cantidad de peticiones por servicio, para la lista. Sin la tabla: mapa vacío.
async function contarPeticionesPorServicio(pool, usuarioId) {
  try {
    if (!(await tablaLista(pool))) return new Map();
    // Solo cuentan las peticiones del propio usuario (cada una es única de su dueño).
    const [filas] = await pool.query('SELECT ServicioId, COUNT(*) AS total FROM AceServiciosPeticiones WHERE CreadoPorId = ? GROUP BY ServicioId', [usuarioId]);
    return new Map(filas.map((f) => [f.ServicioId, Number(f.total)]));
  } catch (error) {
    console.error('No se pudo contar las peticiones de los servicios:', error.message);
    return new Map();
  }
}

const huellaDe = (metodo, url, cuerpo) =>
  crypto.createHash('sha256').update(`${metodo}|${url || ''}|${String(cuerpo || '').trim()}`).digest('hex');

/** Valida y limpia una petición. Devuelve {error} o {valor, omitidas}. */
function normalizar(p) {
  if (!p || typeof p !== 'object') return { error: 'Petición no válida.' };
  const nombre = String(p.nombre || '').trim().slice(0, 200);
  if (!nombre) return { error: 'Ponle un nombre a la petición.' };
  const metodo = String(p.metodo || 'POST').toUpperCase();
  if (!METODOS.has(metodo)) return { error: `Método HTTP no válido: ${metodo}.` };
  let url = p.url === undefined || p.url === null ? '' : String(p.url).trim();
  if (url.length > 2000) return { error: 'La URL supera los 2000 caracteres.' };
  if (url && !/^(https?:\/\/|\{\{)/i.test(url)) return { error: 'La URL debe empezar con http:// o https://' };
  if (!url) url = null;
  const cuerpo = p.cuerpo === undefined || p.cuerpo === null ? '' : String(p.cuerpo);
  if (cuerpo.length > MAX_CUERPO) return { error: `El cuerpo supera los ${Math.round(MAX_CUERPO / 1000)} mil caracteres.` };

  const omitidas = [];
  const cabeceras = [];
  for (const c of Array.isArray(p.cabeceras) ? p.cabeceras : []) {
    const n = String((c && c.nombre) || '').trim().slice(0, 200);
    if (!n) continue;
    if (CABECERAS_SECRETAS.has(n.toLowerCase())) { omitidas.push(n); continue; }
    if (cabeceras.length >= MAX_CABECERAS) break;
    cabeceras.push({ nombre: n, valor: String((c && c.valor) ?? '').slice(0, 2000), activo: c.activo !== false });
  }
  return { valor: { nombre, metodo, url, cabeceras, cuerpo }, omitidas };
}

function aFila(r) {
  let cabeceras = [];
  try { cabeceras = r.Cabeceras ? JSON.parse(r.Cabeceras) : []; } catch { cabeceras = []; }
  return {
    Id: r.Id, ServicioId: r.ServicioId, Nombre: r.Nombre, Metodo: r.Metodo, Url: r.Url || null,
    Cabeceras: cabeceras, Cuerpo: r.Cuerpo || '',
    CreadoPorNombre: r.CreadoPorNombre || null, FechaCreacion: r.FechaCreacion, FechaActualizacion: r.FechaActualizacion,
  };
}

const SELECCION = `SELECT p.*, u.nombre_completo AS CreadoPorNombre
                     FROM AceServiciosPeticiones p LEFT JOIN usuarios u ON u.id = p.CreadoPorId`;

function registrar(router, { getPool }) {
  async function servicioDe(pool, id) {
    const [[s]] = await pool.query('SELECT Id, NombreServicio FROM AceServiciosInventario WHERE Id = ?', [id]);
    return s || null;
  }
  const auditar = (pool, req, servicio, accion, detalle, extra = []) =>
    auditarServicios(pool, req, {
      entidad: 'Servicio ACE', entidadId: servicio.Id, entidadNombre: servicio.NombreServicio, accion, detalle: String(detalle).slice(0, 480),
    }, extra);
  const choqueDeNombre = (e) => e && e.code === 'ER_DUP_ENTRY';
  const MSG_NOMBRE_OTRA_PERSONA = 'Ese nombre ya lo usa otra persona en este servicio. Ponle otro nombre (o pide que se ejecute ajustar_peticiones_por_usuario.sql para poder repetirlo).';

  // GET /:id/peticiones
  router.get('/:id/peticiones', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.json({ disponible: false, mensaje: MENSAJE_SIN_TABLA, peticiones: [] });
      const [filas] = await pool.query(`${SELECCION} WHERE p.ServicioId = ? AND p.CreadoPorId = ? ORDER BY p.Nombre`, [req.params.id, req.user.id]);
      return res.json({ disponible: true, mensaje: null, peticiones: filas.map(aFila) });
    } catch (error) {
      console.error('Error al listar las peticiones del servicio:', error);
      return res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'las peticiones del servicio' }) });
    }
  });

  // POST /:id/peticiones  body: { peticiones: [{nombre, metodo, url?, cabeceras, cuerpo}] }  (una o varias)
  router.post('/:id/peticiones', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.status(409).json({ error: MENSAJE_SIN_TABLA });
      const servicio = await servicioDe(pool, req.params.id);
      if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado.' });

      const entrada = Array.isArray(req.body?.peticiones) ? req.body.peticiones : [];
      if (!entrada.length) return res.status(400).json({ error: 'No hay peticiones para guardar.' });
      if (entrada.length > MAX_POR_LLAMADA) return res.status(400).json({ error: `Máximo ${MAX_POR_LLAMADA} peticiones por vez.` });

      const [existentes] = await pool.query('SELECT Id, Nombre, Huella FROM AceServiciosPeticiones WHERE ServicioId = ? AND CreadoPorId = ?', [servicio.Id, req.user.id]);
      const porNombre = new Map(existentes.map((e) => [e.Nombre.toLowerCase(), e]));
      const porHuella = new Map(existentes.map((e) => [e.Huella, e]));
      let total = existentes.length;

      const creadas = [];
      const omitidas = [];
      const cabecerasDescartadas = new Set();
      for (const bruto of entrada) {
        const n = normalizar(bruto);
        if (n.error) { omitidas.push({ nombre: String(bruto?.nombre || ''), motivo: 'INVALIDA', detalle: n.error }); continue; }
        const v = n.valor;
        n.omitidas.forEach((h) => cabecerasDescartadas.add(h));
        const huella = huellaDe(v.metodo, v.url, v.cuerpo);
        const mismoNombre = porNombre.get(v.nombre.toLowerCase());
        if (mismoNombre) { omitidas.push({ nombre: v.nombre, motivo: 'NOMBRE', detalle: 'Ya existe una petición con ese nombre.', existenteId: mismoNombre.Id }); continue; }
        const mismoContenido = porHuella.get(huella);
        if (mismoContenido) { omitidas.push({ nombre: v.nombre, motivo: 'CONTENIDO', detalle: `Ya está guardada como «${mismoContenido.Nombre}».`, existenteId: mismoContenido.Id }); continue; }
        if (total >= MAX_PETICIONES_POR_SERVICIO) { omitidas.push({ nombre: v.nombre, motivo: 'LIMITE', detalle: `Un servicio admite hasta ${MAX_PETICIONES_POR_SERVICIO} peticiones guardadas.` }); continue; }

        let r;
        try {
          [r] = await pool.query(
            `INSERT INTO AceServiciosPeticiones (ServicioId, Nombre, Metodo, Url, Cabeceras, Cuerpo, Huella, CreadoPorId) VALUES (?,?,?,?,?,?,?,?)`,
            [servicio.Id, v.nombre, v.metodo, v.url, JSON.stringify(v.cabeceras), v.cuerpo, huella, req.user.id]);
        } catch (e) {
          if (choqueDeNombre(e)) { omitidas.push({ nombre: v.nombre, motivo: 'NOMBRE', detalle: MSG_NOMBRE_OTRA_PERSONA }); continue; }
          throw e;
        }
        total += 1;
        const marca = { Id: r.insertId, Nombre: v.nombre, Huella: huella };
        porNombre.set(v.nombre.toLowerCase(), marca);
        porHuella.set(huella, marca);
        creadas.push(r.insertId);
      }

      if (creadas.length) {
        const [filas] = await pool.query(`${SELECCION} WHERE p.Id IN (?)`, [creadas]);
        await auditar(pool, req, servicio, 'PETICION_GUARDADA', `${creadas.length} petición(es): ${filas.map((f) => f.Nombre).join(', ')}`,
          filas.slice(0, 10).map((f) => ({ campo: `peticion_${f.Id}`, etiqueta: `Petición «${f.Nombre}»`, nuevo: `${f.Metodo} ${f.Url || '(URL del ambiente)'}${f.Cuerpo ? ` · cuerpo: ${sanitizarCuerpo(f.Cuerpo, 300)}` : ''}` })));
        return res.status(201).json({ creadas: filas.map(aFila), omitidas, cabecerasDescartadas: [...cabecerasDescartadas] });
      }
      return res.status(200).json({ creadas: [], omitidas, cabecerasDescartadas: [...cabecerasDescartadas] });
    } catch (error) {
      console.error('Error al guardar las peticiones del servicio:', error);
      return res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'las peticiones del servicio' }) });
    }
  });

  // PUT /:id/peticiones/:pid  body: {nombre, metodo, url?, cabeceras, cuerpo}  (reemplaza el contenido)
  router.put('/:id/peticiones/:pid', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.status(409).json({ error: MENSAJE_SIN_TABLA });
      const [[actual]] = await pool.query('SELECT * FROM AceServiciosPeticiones WHERE Id = ? AND ServicioId = ? AND CreadoPorId = ?', [req.params.pid, req.params.id, req.user.id]);
      if (!actual) return res.status(404).json({ error: 'La petición no existe.' });
      const servicio = await servicioDe(pool, req.params.id);

      // Permite mandar solo el nombre (renombrar): lo demás se conserva.
      let cabecerasActuales = [];
      try { cabecerasActuales = actual.Cabeceras ? JSON.parse(actual.Cabeceras) : []; } catch { /* nada */ }
      const base = {
        nombre: actual.Nombre, metodo: actual.Metodo, url: actual.Url, cabeceras: cabecerasActuales, cuerpo: actual.Cuerpo,
      };
      const n = normalizar({ ...base, ...(req.body || {}) });
      if (n.error) return res.status(400).json({ error: n.error });
      const v = n.valor;
      const [[choque]] = await pool.query('SELECT Id FROM AceServiciosPeticiones WHERE ServicioId = ? AND CreadoPorId = ? AND Nombre = ? AND Id <> ?', [actual.ServicioId, req.user.id, v.nombre, actual.Id]);
      if (choque) return res.status(409).json({ error: 'Ya existe otra petición con ese nombre en este servicio.' });
      const huella = huellaDe(v.metodo, v.url, v.cuerpo);
      const [[igual]] = await pool.query('SELECT Nombre FROM AceServiciosPeticiones WHERE ServicioId = ? AND CreadoPorId = ? AND Huella = ? AND Id <> ?', [actual.ServicioId, req.user.id, huella, actual.Id]);
      if (igual) return res.status(409).json({ error: `Ese contenido ya está guardado en «${igual.Nombre}».` });

      try {
        await pool.query(
          `UPDATE AceServiciosPeticiones SET Nombre = ?, Metodo = ?, Url = ?, Cabeceras = ?, Cuerpo = ?, Huella = ?, ActualizadoPorId = ? WHERE Id = ?`,
          [v.nombre, v.metodo, v.url, JSON.stringify(v.cabeceras), v.cuerpo, huella, req.user.id, actual.Id]);
      } catch (e) {
        if (choqueDeNombre(e)) return res.status(409).json({ error: MSG_NOMBRE_OTRA_PERSONA });
        throw e;
      }
      if (servicio) {
        await auditar(pool, req, servicio, 'PETICION_ACTUALIZADA', v.nombre === actual.Nombre ? `Petición «${v.nombre}» actualizada.` : `Petición «${actual.Nombre}» → «${v.nombre}».`, [
          { campo: 'peticion', etiqueta: 'Petición', nuevo: `${v.metodo} ${v.url || '(URL del ambiente)'}` },
          { campo: 'cuerpo', etiqueta: 'Cuerpo (recortado, sin secretos)', nuevo: sanitizarCuerpo(v.cuerpo, 800) },
        ]);
      }
      const [[fila]] = await pool.query(`${SELECCION} WHERE p.Id = ?`, [actual.Id]);
      return res.json({ peticion: aFila(fila), cabecerasDescartadas: n.omitidas });
    } catch (error) {
      console.error('Error al actualizar la petición del servicio:', error);
      return res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la petición del servicio' }) });
    }
  });

  // DELETE /:id/peticiones/:pid
  router.delete('/:id/peticiones/:pid', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.status(409).json({ error: MENSAJE_SIN_TABLA });
      const [[p]] = await pool.query('SELECT Id, Nombre FROM AceServiciosPeticiones WHERE Id = ? AND ServicioId = ? AND CreadoPorId = ?', [req.params.pid, req.params.id, req.user.id]);
      if (!p) return res.status(404).json({ error: 'La petición no existe.' });
      await pool.query('DELETE FROM AceServiciosPeticiones WHERE Id = ?', [p.Id]);
      const servicio = await servicioDe(pool, req.params.id);
      if (servicio) await auditar(pool, req, servicio, 'PETICION_ELIMINADA', `Petición eliminada: «${p.Nombre}».`);
      return res.status(204).send();
    } catch (error) {
      console.error('Error al eliminar la petición del servicio:', error);
      return res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la petición del servicio' }) });
    }
  });
}

module.exports = { registrar, contarPeticionesPorServicio, _prueba: { normalizar, huellaDe } };
