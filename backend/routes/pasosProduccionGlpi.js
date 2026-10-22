// ==========================================================================
// Pasos a Producción: importar un caso de GLPI como propuesta de registro.
//
//   GET  /pasos-produccion/glpi/estado        -> ¿está configurada la API de GLPI?
//   POST /pasos-produccion/glpi/previsualizar -> { caso, contenido?, titulo? }
//   GET  /pasos-produccion/glpi/caso/:caso     -> estado actual del caso en GLPI (solo lectura)
//   GET  /pasos-produccion/glpi/filtros        -> usuario de la API, grupos (equipos) de GLPI
//   GET  /pasos-produccion/glpi/casos          -> listado de casos con filtros (solo lectura)
//   GET  /pasos-produccion/:id/glpi/seguimiento -> texto propuesto + archivos candidatos
//   POST /pasos-produccion/:id/glpi/seguimiento -> PUBLICA en el caso (escribe en GLPI): tipo 'SEGUIMIENTO'
//        (comentario, por defecto) o 'SOLUCION' (respuesta de cierre; exige confirmarCierre: true)
//
// NO crea nada: devuelve una propuesta (RFC, título, fechas, servidores,
// equipo, descripción y checklist) y la lista de datos PENDIENTES. El
// frontend la carga en el formulario de "Nuevo Registro" y el usuario decide
// si crea el paso (el registro real sigue siendo POST /pasos-produccion).
//
// Se monta desde pasosProduccion.js ANTES de las rutas "/:id".
// ==========================================================================

const { glpiConfigurado, listarCasos, obtenerFiltros, obtenerCaso, obtenerEstadoCaso, publicarSeguimiento, urlCaso, GlpiError } = require('../utils/glpiCliente');
const { construirPropuesta } = require('../utils/glpiParser');
const { construirTextoSeguimiento, construirTextoCierre, nombreArchivoUnico } = require('../utils/glpiSeguimiento');
const acceso = require('../utils/bitacoraAcceso');

const MAX_CONTENIDO = 60000;
const LIMITE_POR_MINUTO = 15;
const consultasPorUsuario = new Map(); // userId -> [timestamps]
const publicacionesPorUsuario = new Map();
const estadosPorUsuario = new Map();

function excedeLimite(userId, mapa = consultasPorUsuario, limite = LIMITE_POR_MINUTO) {
  const ahora = Date.now();
  const recientes = (mapa.get(userId) || []).filter((t) => ahora - t < 60000);
  if (recientes.length >= limite) { mapa.set(userId, recientes); return true; }
  recientes.push(ahora);
  mapa.set(userId, recientes);
  return false;
}

// Publicación (escritura): topes para no saturar GLPI ni la memoria.
const MAX_ARCHIVOS = 10;
const MAX_BYTES_TOTAL = 25 * 1024 * 1024;
const MAX_CONTENIDO_SEGUIMIENTO = 20000;
const EXT_IMAGEN = /\.(png|jpe?g|gif|webp)$/i;

// El RFC del registro suele ser el número del caso ("405428" o "RFC 405428").
function casoDesdeRfc(rfc) {
  const m = String(rfc || '').match(/\d{3,9}/);
  return m ? m[0] : '';
}

module.exports = function registrarRutasGlpi(router, { getPool, requireEditPermission, registrarEventoGeneral, mensajeErrorAmigable }) {
  router.get('/glpi/estado', (req, res) => {
    res.json({ configurado: glpiConfigurado() });
  });

  // Filtros del listado de casos (usuario de la API y grupos/equipos de GLPI).
  router.get('/glpi/filtros', requireEditPermission, async (req, res) => {
    if (excedeLimite(req.user.id, estadosPorUsuario, 30)) return res.status(429).json({ error: 'Demasiadas consultas a GLPI seguidas. Espera un minuto e intenta de nuevo.' });
    try {
      res.json(await obtenerFiltros());
    } catch (error) {
      if (error instanceof GlpiError) return res.status(error.http).json({ error: error.message, codigo: error.codigo });
      console.error('Error al leer los filtros de GLPI:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la consulta de filtros en GLPI' }) });
    }
  });

  // Listado de casos del equipo (solo lectura). Marca cuáles ya tienen registro en AXIS (por RFC).
  router.get('/glpi/casos', requireEditPermission, async (req, res) => {
    if (excedeLimite(req.user.id, consultasPorUsuario, 20)) return res.status(429).json({ error: 'Demasiadas consultas a GLPI seguidas. Espera un minuto e intenta de nuevo.' });
    const q = req.query || {};
    const filtros = {
      alcance: ['yo', 'grupo', 'tecnico', 'todos'].includes(q.alcance) ? q.alcance : 'yo',
      grupoId: String(q.grupoId || '').replace(/\D/g, ''),
      tecnico: String(q.tecnico || '').trim(),
      tecnicoId: String(q.tecnicoId || '').replace(/\D/g, ''),
      solicitante: String(q.solicitante || '').trim(),
      estado: String(q.estado || 'notold'),
      texto: String(q.texto || '').trim(),
      desde: String(q.desde || ''), hasta: String(q.hasta || ''),
      soloVencidos: q.soloVencidos === '1' || q.soloVencidos === 'true',
      orden: String(q.orden || 'apertura'),
      descendente: q.sentido !== 'asc',
      limite: q.limite,
    };
    if (filtros.alcance === 'grupo' && !filtros.grupoId) return res.status(400).json({ error: 'Elige el equipo (grupo) de GLPI.' });
    if (filtros.alcance === 'tecnico' && !filtros.tecnico && !filtros.tecnicoId) return res.status(400).json({ error: 'Elige el técnico.' });
    try {
      const r = await listarCasos(filtros);
      let registrados = {};
      try {
        const pool = await getPool();
        const ids = r.casos.map((c) => String(c.id));
        if (ids.length) {
          const marcas = ids.flatMap((id) => [id, `RFC ${id}`]);
          // Solo los pasos que esta persona puede ver (la bitácora de cada quien es privada).
          const vis = await acceso.condicionVisible(pool, 'p', req.user);
          const [filas] = await pool.query(`SELECT p.Id, p.Rfc, p.Estado FROM PasosProduccion p WHERE p.Rfc IN (${marcas.map(() => '?').join(',')}) AND ${vis.sql} ORDER BY p.Id DESC`, [...marcas, ...vis.params]);
          filas.forEach((f) => {
            const m = String(f.Rfc || '').match(/\d{3,9}/);
            if (m && !registrados[m[0]]) registrados[m[0]] = { pasoId: f.Id, estado: f.Estado };
          });
        }
      } catch (e) { registrados = {}; }
      const casos = r.casos.map((c) => ({ ...c, registroAxis: registrados[String(c.id)] || null }));
      try {
        const pool = await getPool();
        await registrarEventoGeneral(pool, req, {
          modulo: 'PASOS_PRODUCCION', entidad: 'GLPI', entidadId: 'listado', entidadNombre: 'Listado de casos GLPI',
          accion: 'CONSULTA_GLPI', detalle: `Listado de casos (${filtros.alcance}, estado ${filtros.estado}): ${casos.length} de ${r.total}.`
        });
      } catch (e) { /* la auditoría nunca debe romper la consulta */ }
      res.json({ ...r, casos });
    } catch (error) {
      if (error instanceof GlpiError) return res.status(error.http).json({ error: error.message, codigo: error.codigo });
      console.error('Error al listar casos de GLPI:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el listado de casos en GLPI' }) });
    }
  });

  // Estado actual de un caso en GLPI (solo lectura): lo usa el modal «Publicar en GLPI».
  router.get('/glpi/caso/:caso', requireEditPermission, async (req, res) => {
    const caso = String(req.params.caso || '').replace(/\D/g, '');
    if (!caso || caso.length > 9) return res.status(400).json({ error: 'Número de caso inválido.' });
    if (excedeLimite(req.user.id, estadosPorUsuario, 30)) {
      return res.status(429).json({ error: 'Demasiadas consultas a GLPI seguidas. Espera un minuto e intenta de nuevo.' });
    }
    try {
      res.json(await obtenerEstadoCaso(caso));
    } catch (error) {
      if (error instanceof GlpiError) return res.status(error.http).json({ error: error.message, codigo: error.codigo });
      console.error('Error al consultar el estado del caso en GLPI:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la consulta del caso en GLPI' }) });
    }
  });

  router.post('/glpi/previsualizar', requireEditPermission, async (req, res) => {
    const idCaso = String((req.body && req.body.caso) || '').replace(/\D/g, '');
    if (!idCaso || idCaso.length > 9) {
      return res.status(400).json({ error: 'Escribe el número del caso de GLPI (solo dígitos, ej. 407934).' });
    }
    const contenidoManual = typeof req.body.contenido === 'string' ? req.body.contenido.trim() : '';
    if (contenidoManual.length > MAX_CONTENIDO) {
      return res.status(400).json({ error: 'El contenido pegado es demasiado largo.' });
    }
    if (excedeLimite(req.user.id)) {
      return res.status(429).json({ error: 'Demasiadas consultas a GLPI seguidas. Espera un minuto e intenta de nuevo.' });
    }

    try {
      // 1) Datos del caso: API de GLPI o, de respaldo, el contenido pegado a mano.
      let entrada;
      let origen = 'api';
      if (contenidoManual) {
        origen = 'manual';
        entrada = {
          ticket: {
            id: Number(idCaso), name: String(req.body.titulo || '').slice(0, 200), content: contenidoManual,
            date: null, status: null, categoria: null, url: urlCaso(idCaso)
          },
          actores: []
        };
      } else {
        entrada = await obtenerCaso(idCaso);
      }

      // 2) Catálogos de AXIS para relacionar servidores y personas.
      const pool = await getPool();
      const [servidores] = await pool.query('SELECT Id, IP, Hostname, Ambiente FROM Servidores WHERE Activo = 1');
      const [componentes] = await pool.query('SELECT Id, ServidorId, Rol FROM Servidor_Componentes');
      const [usuarios] = await pool.query('SELECT id, username, nombre_completo FROM usuarios WHERE activo = 1');

      const resultado = construirPropuesta(entrada, { servidores, componentes, usuarios });

      // 3) ¿Ya hay un registro con este RFC?
      const visDup = await acceso.condicionVisible(pool, 'p', req.user);
      const [existentes] = await pool.query(
        `SELECT p.Id, p.Titulo, p.Estado, p.FechaHoraProgramada FROM PasosProduccion p WHERE p.Rfc IN (?, ?) AND ${visDup.sql} ORDER BY p.Id DESC LIMIT 5`,
        [idCaso, `RFC ${idCaso}`, ...visDup.params]
      );

      try {
        await registrarEventoGeneral(pool, req, {
          modulo: 'PASOS_PRODUCCION', entidad: 'GLPI', entidadId: idCaso, entidadNombre: `Caso GLPI #${idCaso}`,
          accion: 'CONSULTA_GLPI', detalle: `Vista previa de importación desde GLPI (${origen}).`
        });
      } catch (e) { /* la auditoría nunca debe romper la consulta */ }

      res.json({ ...resultado, origen, duplicados: existentes.map((e) => ({ id: e.Id, titulo: e.Titulo, estado: e.Estado, fechaHoraProgramada: e.FechaHoraProgramada })) });
    } catch (error) {
      if (error instanceof GlpiError) {
        return res.status(error.http).json({ error: error.message, codigo: error.codigo, permitePegar: error.codigo !== 'CASO_INVALIDO' });
      }
      console.error('Error al importar el caso desde GLPI:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la importación del caso de GLPI' }) });
    }
  });

  // ---------------------------------------------------------------------
  // Publicar la documentación del registro como seguimiento del caso GLPI
  // ---------------------------------------------------------------------
  async function cargarPaso(pool, id) {
    const [[paso]] = await pool.query(
      `SELECT p.Id, p.Rfc, p.Titulo, p.Entorno, p.Estado, p.MotivoEstado, p.ResultadoEjecucion,
              p.FechaHoraProgramada, p.FechaHoraInicioReal, p.FechaHoraFinReal,
              p.CommitId, p.CommitMensaje, p.CommitAutor, uej.nombre_completo AS EjecutadoPorNombre
         FROM PasosProduccion p
         LEFT JOIN usuarios uej ON uej.id = p.EjecutadoPorId
        WHERE p.Id = ?`, [id]);
    return paso || null;
  }

  async function cargarServidores(pool, id) {
    try {
      const [filas] = await pool.query(
        `SELECT s.Hostname, sc.Rol
           FROM PasosProduccionComponentes pc
           JOIN Servidor_Componentes sc ON sc.Id = pc.ComponenteId
           JOIN Servidores s ON s.Id = sc.ServidorId
          WHERE pc.PasoId = ? ORDER BY pc.Orden, pc.ComponenteId`, [id]);
      if (filas.length) return filas;
    } catch (e) { /* tabla de varios servidores aún no creada: se intenta con el principal */ }
    try {
      const [filas] = await pool.query(
        `SELECT s.Hostname, sc.Rol
           FROM PasosProduccion p
           JOIN inv_aplicativos iv ON iv.aplicacion_id = p.AplicativoId
           JOIN Servidor_Componentes sc ON sc.Id = iv.componente_id
           JOIN Servidores s ON s.Id = sc.ServidorId
          WHERE p.Id = ?`, [id]);
      return filas;
    } catch (e) { return []; }
  }

  router.get('/:id/glpi/seguimiento', async (req, res) => {
    try {
      const pool = await getPool();
      const paso = await cargarPaso(pool, req.params.id);
      if (!paso) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });

      const [items] = await pool.query(
        `SELECT c.Id, c.Descripcion, c.Completado, uc.nombre_completo AS CompletadoPorNombre, c.FechaCompletado
           FROM PasoProduccionChecklist c
           LEFT JOIN usuarios uc ON uc.id = c.CompletadoPorId
          WHERE c.PasoId = ? ORDER BY c.Orden ASC, c.Id ASC`, [paso.Id]);
      const [adjuntos] = await pool.query(
        `SELECT Id, NombreOriginal, MimeType, TamanoBytes, ChecklistItemId
           FROM PasoProduccionAdjuntos WHERE PasoId = ? ORDER BY FechaSubida ASC, Id ASC`, [paso.Id]);
      const evidenciasPorItem = new Map();
      adjuntos.forEach((a) => { if (a.ChecklistItemId) evidenciasPorItem.set(a.ChecklistItemId, (evidenciasPorItem.get(a.ChecklistItemId) || 0) + 1); });
      const checklist = items.map((i) => ({ ...i, Completado: !!i.Completado, cantidadEvidencias: evidenciasPorItem.get(i.Id) || 0 }));
      const itemPorId = new Map(items.map((i) => [i.Id, i.Descripcion]));

      let yaPublicado = [];
      try {
        const [filas] = await pool.query(
          `SELECT FechaEvento, RealizadoPorUsername, Accion FROM AuditoriaGeneral
            WHERE Entidad = 'PasoProduccion' AND EntidadId = ? AND Accion IN ('PUBLICADO_GLPI', 'SOLUCION_GLPI')
            ORDER BY FechaEvento DESC LIMIT 5`, [String(paso.Id)]);
        yaPublicado = filas.map((f) => ({ fecha: f.FechaEvento, usuario: f.RealizadoPorUsername, tipo: f.Accion === 'SOLUCION_GLPI' ? 'SOLUCION' : 'SEGUIMIENTO' }));
      } catch (e) { /* sin auditoría disponible: no se avisa de publicaciones previas */ }
      const servidoresPaso = await cargarServidores(pool, paso.Id);

      res.json({
        configurado: glpiConfigurado(),
        caso: casoDesdeRfc(paso.Rfc),
        rfc: paso.Rfc || null,
        texto: construirTextoSeguimiento({ paso, servidores: servidoresPaso, checklist }),
        textoCierre: construirTextoCierre({ paso, servidores: servidoresPaso, checklist, adjuntos }),
        estadoPaso: paso.Estado,
        checklistPendientes: checklist.filter((c) => !c.Completado).length,
        archivos: adjuntos.map((a) => {
          const esImagen = EXT_IMAGEN.test(a.NombreOriginal || '') || /^image\//i.test(a.MimeType || '');
          return {
            id: a.Id, nombre: a.NombreOriginal, tipo: a.MimeType, tamano: a.TamanoBytes, esImagen,
            item: a.ChecklistItemId ? (itemPorId.get(a.ChecklistItemId) || null) : null
          };
        }),
        yaPublicado
      });
    } catch (error) {
      console.error('Error al preparar el seguimiento para GLPI:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el seguimiento para GLPI' }) });
    }
  });

  router.post('/:id/glpi/seguimiento', requireEditPermission, async (req, res) => {
    const caso = String((req.body && req.body.caso) || '').replace(/\D/g, '');
    const contenido = typeof req.body.contenido === 'string' ? req.body.contenido.trim() : '';
    const tipo = req.body && req.body.tipo === 'SOLUCION' ? 'SOLUCION' : 'SEGUIMIENTO';
    const esSolucion = tipo === 'SOLUCION';
    // La solución es pública (la ve el solicitante) y deja el caso Resuelto: nunca privada.
    const privado = esSolucion ? false : req.body.privado !== false;
    const ids = Array.isArray(req.body.adjuntoIds) ? [...new Set(req.body.adjuntoIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];

    if (!caso || caso.length > 9) return res.status(400).json({ error: 'Indica el número del caso de GLPI (solo dígitos).' });
    if (esSolucion && req.body.confirmarCierre !== true) {
      return res.status(400).json({ error: 'Para publicar la solución debes confirmar que entiendes que el caso quedará resuelto en GLPI.' });
    }
    if (!contenido) return res.status(400).json({ error: esSolucion ? 'La solución no puede estar vacía.' : 'El seguimiento no puede estar vacío.' });
    if (contenido.length > MAX_CONTENIDO_SEGUIMIENTO) return res.status(400).json({ error: 'El seguimiento es demasiado largo.' });
    if (ids.length > MAX_ARCHIVOS) return res.status(400).json({ error: `Máximo ${MAX_ARCHIVOS} archivos por seguimiento.` });
    if (excedeLimite(req.user.id, publicacionesPorUsuario, 5)) {
      return res.status(429).json({ error: 'Demasiadas publicaciones seguidas. Espera un minuto e intenta de nuevo.' });
    }

    try {
      const pool = await getPool();
      const paso = await cargarPaso(pool, req.params.id);
      if (!paso) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });

      let archivos = [];
      if (ids.length) {
        const [filas] = await pool.query(
          `SELECT a.Id, a.NombreOriginal, a.MimeType, a.TamanoBytes, a.ContenidoBase64, c.Descripcion AS ItemDescripcion
             FROM PasoProduccionAdjuntos a
             LEFT JOIN PasoProduccionChecklist c ON c.Id = a.ChecklistItemId
            WHERE a.PasoId = ? AND a.Id IN (?)
            ORDER BY a.FechaSubida ASC, a.Id ASC`, [paso.Id, ids]);
        const usados = new Set();
        let total = 0;
        for (const f of filas) {
          const base64 = String(f.ContenidoBase64 || '').replace(/^data:[^;]+;base64,/, '');
          const buffer = Buffer.from(base64, 'base64');
          total += buffer.length;
          archivos.push({ nombre: nombreArchivoUnico(f.NombreOriginal, usados), mime: f.MimeType, buffer, ancla: f.ItemDescripcion || null });
        }
        if (total > MAX_BYTES_TOTAL) return res.status(400).json({ error: 'Los archivos seleccionados pesan demasiado (máximo 25 MB en total).' });
      }

      const resultado = await publicarSeguimiento(caso, { contenido, privado, archivos, tipo });

      const fallidos = resultado.archivos.filter((a) => !a.ok).length;
      try {
        await registrarEventoGeneral(pool, req, {
          modulo: 'PASOS_PRODUCCION', entidad: 'PasoProduccion', entidadId: paso.Id, entidadNombre: paso.Titulo,
          accion: esSolucion ? 'SOLUCION_GLPI' : 'PUBLICADO_GLPI',
          detalle: esSolucion
            ? `Solución (cierre) publicada en el caso GLPI #${caso} (${resultado.archivos.length - fallidos} de ${resultado.archivos.length} archivo(s) adjuntos).`
            : `Seguimiento publicado en el caso GLPI #${caso} (${privado ? 'privado' : 'público'}, ${resultado.archivos.length - fallidos} de ${resultado.archivos.length} archivo(s) adjuntos).`
        });
      } catch (e) { /* la auditoría nunca debe ocultar que ya se publicó */ }

      res.json({ ok: true, ...resultado, caso, privado, tipo });
    } catch (error) {
      if (error instanceof GlpiError) {
        return res.status(error.http).json({ error: error.message, codigo: error.codigo });
      }
      console.error('Error al publicar el seguimiento en GLPI:', error);
      res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la publicación en GLPI' }) });
    }
  });
};
