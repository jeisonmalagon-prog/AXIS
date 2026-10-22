// Equipos y accesos de la bitácora de Pasos a Producción (se monta dentro de /api/pasos-produccion,
// bajo /bitacora/..., ver routes/pasosProduccion.js).
//
// - Equipos: los crea y administra ADMIN_POD (aplicaciones, BUS, desarrollo, ...) y asigna personas.
//   Pertenecer a un equipo NO da acceso a la bitácora de los demás: sirve para filtrar y para
//   pedir o compartir accesos a todo un equipo de una vez.
// - Accesos: se comparte la bitácora COMPLETA o un PASO concreto (la otra persona debe ACEPTAR,
//   igual que en Manuales), o se PIDE acceso a una persona o a todo un equipo (el dueño aprueba
//   con lectura o edición, o rechaza). ADMIN_POD ve todo, puede otorgar y revocar accesos y
//   responder solicitudes, pero no edita pasos ajenos.
// Tablas: crear_tablas_bitacora_equipos_y_accesos.sql.

const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { notificar } = require('../utils/notificaciones');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const acc = require('../utils/bitacoraAcceso');

const PERMISOS = new Set(['LECTURA', 'EDICION']);
const ENLACE_ACCESOS = '/pasos-produccion?accesos=1';
const ENLACE_BITACORA = '/pasos-produccion';
const MAX_DESTINATARIOS = 200;
const MAX_MIEMBROS = 200;

const idValido = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const nombreDe = (u) => u?.nombre_completo || u?.nombre || u?.username || 'Alguien';
const textoPermiso = (p) => (p === 'EDICION' ? 'edición' : 'solo lectura');
const etiquetaPaso = (f) => `${f.Rfc ? `${f.Rfc} · ` : ''}${f.Titulo || `paso #${f.PasoId}`}`;

// OJO: estas rutas usan el parámetro `:rid` (no `:id`) a propósito: `router.param('id')` de pasosProduccion.js
// es la guarda de acceso a UN paso y no debe ejecutarse aquí.
function registrar(router, { getPool, requireEditPermission }) {
  const exigirEdicion = requireEditPermission || ((req, res, next) => next());
  // El token no trae el nombre completo: se lee una vez (y se recuerda unos minutos) para que los
  // avisos digan «Johan Pérez» y no solo el usuario.
  const nombres = new Map();
  async function asegurarNombre(req) {
    const hit = nombres.get(req.user.id);
    if (hit && Date.now() - hit.en < 5 * 60 * 1000) { req.user.nombre_completo = hit.nombre; return; }
    try {
      const [[u]] = await (await getPool()).query('SELECT nombre_completo FROM usuarios WHERE id = ?', [req.user.id]);
      if (nombres.size > 500) nombres.clear();
      nombres.set(req.user.id, { nombre: u?.nombre_completo || null, en: Date.now() });
      req.user.nombre_completo = u?.nombre_completo || null;
    } catch (e) {
      console.error('Bitácora: no se pudo leer el nombre de la persona:', e.message);
    }
  }

  const manejar = (contexto, fn, { requiereTablas = true } = {}) => async (req, res) => {
    try {
      const pool = await getPool();
      if (requiereTablas && !(await acc.accesosListos(pool))) return res.status(409).json({ error: acc.MENSAJE_SIN_TABLAS });
      await asegurarNombre(req);
      await fn(req, res, pool);
    } catch (error) {
      console.error(`Bitácora (${contexto}):`, error);
      if (!res.headersSent) res.status(500).json({ error: mensajeErrorAmigable(error, { contexto }) });
    }
  };

  const soloAdmin = (req, res) => {
    if (acc.esAdmin(req.user)) return true;
    res.status(403).json({ error: 'Solo el administrador (ADMIN_POD) puede hacer esto.' });
    return false;
  };

  const auditar = (pool, req, entidad, entidadId, nombre, accion, detalle) =>
    registrarEventoGeneral(pool, req, { modulo: 'PASOS_PRODUCCION', entidad, entidadId, entidadNombre: nombre, accion, detalle })
      .catch((e) => console.error('Bitácora: no se pudo auditar:', e.message));

  // Personas activas con el módulo (o ADMIN_POD). `ids` limita; `excluirId` omite a una persona.
  async function personasConModulo(pool, { ids = null, excluirId = null } = {}) {
    const params = [];
    let extra = '';
    if (ids) { if (!ids.length) return []; extra += ' AND u.id IN (?)'; params.push(ids); }
    if (excluirId) { extra += ' AND u.id <> ?'; params.push(excluirId); }
    const [filas] = await pool.query(
      `SELECT u.id, u.username, u.nombre_completo FROM usuarios u
        WHERE u.activo = 1 AND (u.rol = 'ADMIN_POD' OR EXISTS (SELECT 1 FROM usuario_modulos um JOIN modulos m ON m.id = um.modulo_id WHERE um.usuario_id = u.id AND m.nombre = 'PASOS_PRODUCCION'))${extra}
        ORDER BY u.nombre_completo, u.username`,
      params
    );
    return filas;
  }

  async function miembrosDeEquipo(pool, equipoId) {
    const [filas] = await pool.query('SELECT UsuarioId FROM BitacoraEquipoMiembros WHERE EquipoId = ?', [equipoId]);
    return filas.map((f) => Number(f.UsuarioId));
  }

  // ------------------------------------------------------------------ estado / personas
  router.get('/bitacora/estado', manejar('el estado de la bitácora', async (req, res, pool) => {
    const disponible = await acc.accesosListos(pool);
    res.json({
      disponible,
      mensaje: disponible ? null : acc.MENSAJE_SIN_TABLAS,
      serviciosDisponible: await acc.serviciosListos(pool),
      esAdmin: acc.esAdmin(req.user),
      yo: { id: req.user.id, nombre: nombreDe(req.user) },
    });
  }, { requiereTablas: false }));

  router.get('/bitacora/personas', manejar('las personas', async (req, res, pool) => {
    const incluirme = req.query.incluirme === '1';
    res.json(await personasConModulo(pool, { excluirId: incluirme ? null : req.user.id }));
  }, { requiereTablas: false }));

  // ------------------------------------------------------------------ vistas (de quién puedo ver)
  router.get('/bitacora/vistas', manejar('las vistas de la bitácora', async (req, res, pool) => {
    const yo = Number(req.user.id);
    const vis = await acc.condicionVisible(pool, 'p', req.user);
    const mia = acc.condicionMia('p', req.user);
    mia.sql = `${mia.sql} AND ${await acc.sqlActivo(pool, 'p')}`; // lo eliminado no cuenta

    const [[mios]] = await pool.query(`SELECT COUNT(*) AS total FROM PasosProduccion p WHERE ${mia.sql}`, mia.params);
    const [[todo]] = await pool.query(`SELECT COUNT(*) AS total FROM PasosProduccion p WHERE ${vis.sql}`, vis.params);
    const [[comp]] = await pool.query(
      `SELECT COUNT(*) AS total FROM PasosProduccion p
        WHERE EXISTS (SELECT 1 FROM BitacoraAccesos ba WHERE ba.UsuarioId = ? AND ba.Estado = 'ACEPTADA' AND ba.PasoId = p.Id) AND NOT ${mia.sql}`,
      [yo, ...mia.params]
    );

    // Personas cuya bitácora completa puedo ver (o todas, si soy ADMIN_POD).
    let idsPersonas;
    const permisoDe = new Map();
    if (acc.esAdmin(req.user)) {
      const [filas] = await pool.query(
        `SELECT DISTINCT u.id FROM usuarios u WHERE u.activo = 1 AND u.id <> ?
            AND (EXISTS (SELECT 1 FROM PasosProduccion p WHERE p.CreadoPorId = u.id OR p.EjecutadoPorId = u.id)
              OR EXISTS (SELECT 1 FROM PasosProduccionEquipo e WHERE e.UsuarioId = u.id))`, [yo]);
      idsPersonas = filas.map((f) => Number(f.id));
    } else {
      const [filas] = await pool.query(
        "SELECT PropietarioId, Permiso FROM BitacoraAccesos WHERE UsuarioId = ? AND Estado = 'ACEPTADA' AND PasoId IS NULL", [yo]);
      idsPersonas = filas.map((f) => Number(f.PropietarioId));
      filas.forEach((f) => permisoDe.set(Number(f.PropietarioId), f.Permiso));
    }
    let personas = [];
    if (idsPersonas.length) {
      const [us] = await pool.query('SELECT id, username, nombre_completo FROM usuarios WHERE id IN (?) AND activo = 1 ORDER BY nombre_completo, username', [idsPersonas]);
      const [conteos] = await pool.query(
        `SELECT x.UsuarioId AS id, COUNT(DISTINCT p.Id) AS total
           FROM (SELECT Id AS PasoId, CreadoPorId AS UsuarioId FROM PasosProduccion
                 UNION SELECT Id, EjecutadoPorId FROM PasosProduccion WHERE EjecutadoPorId IS NOT NULL
                 UNION SELECT PasoId, UsuarioId FROM PasosProduccionEquipo) x
           JOIN PasosProduccion p ON p.Id = x.PasoId
          WHERE x.UsuarioId IN (?) AND ${vis.sql}
          GROUP BY x.UsuarioId`,
        [idsPersonas, ...vis.params]
      );
      const total = new Map(conteos.map((c) => [Number(c.id), Number(c.total)]));
      personas = us.map((u) => ({
        id: Number(u.id), nombre: u.nombre_completo || u.username, username: u.username,
        permiso: permisoDe.get(Number(u.id)) || null, porAdmin: acc.esAdmin(req.user) && !permisoDe.has(Number(u.id)),
        total: total.get(Number(u.id)) || 0,
      }));
    }

    // Equipos: pasos que puedo ver de sus integrantes.
    const [equiposBd] = await pool.query('SELECT Id, Nombre FROM BitacoraEquipos ORDER BY Nombre');
    const [miemb] = await pool.query('SELECT EquipoId, UsuarioId FROM BitacoraEquipoMiembros');
    const porEquipo = new Map();
    miemb.forEach((m) => { const l = porEquipo.get(m.EquipoId) || []; l.push(Number(m.UsuarioId)); porEquipo.set(m.EquipoId, l); });
    const equipos = [];
    for (const e of equiposBd) {
      const ids = porEquipo.get(e.Id) || [];
      let total = 0;
      if (ids.length) {
        const inv = acc.sqlInvolucra('p', ids);
        const [[t]] = await pool.query(`SELECT COUNT(*) AS total FROM PasosProduccion p WHERE ${inv.sql} AND ${vis.sql}`, [...inv.params, ...vis.params]);
        total = Number(t.total);
      }
      equipos.push({ id: e.Id, nombre: e.Nombre, miembros: ids.length, soyMiembro: ids.includes(yo), total });
    }

    res.json({
      yo: { id: yo, nombre: nombreDe(req.user) }, esAdmin: acc.esAdmin(req.user),
      mios: Number(mios.total), todo: Number(todo.total), compartidosConmigo: Number(comp.total),
      personas, equipos,
    });
  }));

  // ------------------------------------------------------------------ equipos
  async function listarEquipos(pool, yo) {
    const [equipos] = await pool.query('SELECT Id, Nombre, Descripcion FROM BitacoraEquipos ORDER BY Nombre');
    const [miemb] = await pool.query(
      `SELECT m.EquipoId, u.id, u.username, u.nombre_completo FROM BitacoraEquipoMiembros m JOIN usuarios u ON u.id = m.UsuarioId AND u.activo = 1 ORDER BY u.nombre_completo, u.username`
    );
    const por = new Map();
    miemb.forEach((m) => { const l = por.get(m.EquipoId) || []; l.push({ id: Number(m.id), username: m.username, nombre: m.nombre_completo || m.username }); por.set(m.EquipoId, l); });
    return equipos.map((e) => {
      const miembros = por.get(e.Id) || [];
      return { id: e.Id, nombre: e.Nombre, descripcion: e.Descripcion, miembros, soyMiembro: miembros.some((m) => m.id === Number(yo)) };
    });
  }

  router.get('/bitacora/equipos', manejar('los equipos', async (req, res, pool) => {
    res.json(await listarEquipos(pool, req.user.id));
  }));

  async function validarEquipo(pool, { nombre, descripcion, usuarioIds }, idActual) {
    const n = String(nombre ?? '').replace(/\s+/g, ' ').trim();
    if (!n) return { error: 'El nombre del equipo es obligatorio.' };
    if (n.length > 80) return { error: 'El nombre del equipo admite hasta 80 caracteres.' };
    const [[dup]] = await pool.query('SELECT Id FROM BitacoraEquipos WHERE Nombre = ? AND Id <> ?', [n, idActual || 0]);
    if (dup) return { error: `Ya existe un equipo llamado «${n}».` };
    const d = descripcion ? String(descripcion).replace(/\s+/g, ' ').trim().slice(0, 255) : null;
    let ids;
    if (usuarioIds !== undefined) {
      if (!Array.isArray(usuarioIds)) return { error: 'Los integrantes deben enviarse como una lista.' };
      ids = acc.idsValidos(usuarioIds);
      if (ids.length > MAX_MIEMBROS) return { error: `Un equipo admite hasta ${MAX_MIEMBROS} integrantes.` };
      const validas = await personasConModulo(pool, { ids });
      if (validas.length !== ids.length) {
        const ok = new Set(validas.map((v) => Number(v.id)));
        return { error: 'Alguna de las personas elegidas no existe, está inactiva o no tiene habilitado el módulo Pasos a Producción.', faltan: ids.filter((i) => !ok.has(i)) };
      }
    }
    return { nombre: n, descripcion: d, ids };
  }

  async function avisarNuevosMiembros(pool, req, equipo, nuevos) {
    for (const id of nuevos) {
      if (Number(id) === Number(req.user.id)) continue;
      await notificar(pool, {
        usuarioId: id, tipo: 'BITACORA_EQUIPO', severidad: 'INFO', titulo: 'Te agregaron a un equipo de la bitácora', enlace: ENLACE_BITACORA, referencia: equipo.id,
        mensaje: `${nombreDe(req.user)} te agregó al equipo «${equipo.nombre}». Puedes filtrar la bitácora por este equipo y pedirle acceso a sus integrantes.`,
        clave: `bit-equipo-${equipo.id}-${id}-${Date.now()}`,
      });
    }
  }

  router.post('/bitacora/equipos', manejar('crear el equipo', async (req, res, pool) => {
    if (!soloAdmin(req, res)) return;
    const v = await validarEquipo(pool, req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const [r] = await pool.query('INSERT INTO BitacoraEquipos (Nombre, Descripcion, CreadoPorId) VALUES (?, ?, ?)', [v.nombre, v.descripcion, req.user.id]);
    if (v.ids && v.ids.length) await pool.query('INSERT INTO BitacoraEquipoMiembros (EquipoId, UsuarioId) VALUES ?', [v.ids.map((u) => [r.insertId, u])]);
    await auditar(pool, req, 'BitacoraEquipo', r.insertId, v.nombre, 'CREACION', `Equipo con ${(v.ids || []).length} integrante(s).`);
    await avisarNuevosMiembros(pool, req, { id: r.insertId, nombre: v.nombre }, v.ids || []);
    res.status(201).json((await listarEquipos(pool, req.user.id)).find((e) => e.id === r.insertId));
  }));

  router.put('/bitacora/equipos/:rid', manejar('editar el equipo', async (req, res, pool) => {
    if (!soloAdmin(req, res)) return;
    const id = idValido(req.params.rid);
    const [[actual]] = id ? await pool.query('SELECT Id, Nombre FROM BitacoraEquipos WHERE Id = ?', [id]) : [[null]];
    if (!actual) return res.status(404).json({ error: 'Ese equipo no existe.' });
    const v = await validarEquipo(pool, req.body || {}, id);
    if (v.error) return res.status(400).json({ error: v.error });
    await pool.query('UPDATE BitacoraEquipos SET Nombre = ?, Descripcion = ? WHERE Id = ?', [v.nombre, v.descripcion, id]);
    let nuevos = [];
    if (v.ids) {
      const antes = new Set(await miembrosDeEquipo(pool, id));
      nuevos = v.ids.filter((u) => !antes.has(u));
      await pool.query('DELETE FROM BitacoraEquipoMiembros WHERE EquipoId = ?', [id]);
      if (v.ids.length) await pool.query('INSERT INTO BitacoraEquipoMiembros (EquipoId, UsuarioId) VALUES ?', [v.ids.map((u) => [id, u])]);
    }
    await auditar(pool, req, 'BitacoraEquipo', id, v.nombre, 'ACTUALIZACION', v.ids ? `Equipo con ${v.ids.length} integrante(s).` : 'Datos del equipo.');
    await avisarNuevosMiembros(pool, req, { id, nombre: v.nombre }, nuevos);
    res.json((await listarEquipos(pool, req.user.id)).find((e) => e.id === id));
  }));

  router.delete('/bitacora/equipos/:rid', manejar('eliminar el equipo', async (req, res, pool) => {
    if (!soloAdmin(req, res)) return;
    const id = idValido(req.params.rid);
    const [[actual]] = id ? await pool.query('SELECT Id, Nombre FROM BitacoraEquipos WHERE Id = ?', [id]) : [[null]];
    if (!actual) return res.status(404).json({ error: 'Ese equipo no existe.' });
    await pool.query('DELETE FROM BitacoraEquipos WHERE Id = ?', [id]);
    await auditar(pool, req, 'BitacoraEquipo', id, actual.Nombre, 'ELIMINACION', 'Los accesos ya concedidos no cambian.');
    res.status(204).send();
  }));

  // ------------------------------------------------------------------ accesos
  const SELECT_ACCESO = `
    SELECT a.Id, a.PropietarioId, a.UsuarioId, a.PasoId, a.Permiso, a.Estado, a.Origen, a.FechaSolicitud, a.FechaRespuesta,
           up.nombre_completo AS PropNombre, up.username AS PropUser, uu.nombre_completo AS UsuNombre, uu.username AS UsuUser,
           p.Titulo, p.Rfc
      FROM BitacoraAccesos a
      JOIN usuarios up ON up.id = a.PropietarioId
      JOIN usuarios uu ON uu.id = a.UsuarioId
      LEFT JOIN PasosProduccion p ON p.Id = a.PasoId`;

  const mapear = (f) => ({
    id: f.Id,
    propietarioId: Number(f.PropietarioId), propietario: f.PropNombre || f.PropUser,
    usuarioId: Number(f.UsuarioId), usuario: f.UsuNombre || f.UsuUser,
    alcance: f.PasoId ? 'PASO' : 'COMPLETA', pasoId: f.PasoId ? Number(f.PasoId) : null,
    paso: f.PasoId ? etiquetaPaso({ ...f, PasoId: f.PasoId }) : null,
    permiso: f.Permiso, estado: f.Estado, origen: f.Origen, fechaSolicitud: f.FechaSolicitud, fechaRespuesta: f.FechaRespuesta,
  });

  async function accesoPorId(pool, id) {
    const [[f]] = await pool.query(`${SELECT_ACCESO} WHERE a.Id = ?`, [id]);
    return f || null;
  }

  async function cerrarNotificaciones(pool, accesoId, estado) {
    try {
      await pool.query(
        "UPDATE notificaciones SET Accion = ?, Leida = 1, FechaLeida = COALESCE(FechaLeida, NOW()) WHERE Tipo IN ('BITACORA_COMPARTIR','BITACORA_SOLICITUD') AND Referencia = ? AND Accion = 'PENDIENTE'",
        [estado, accesoId]
      );
    } catch (error) {
      console.error('Bitácora: no se pudo cerrar la notificación:', error.message);
    }
  }

  router.get('/bitacora/accesos', manejar('los accesos', async (req, res, pool) => {
    const yo = Number(req.user.id);
    const [mios] = await pool.query(`${SELECT_ACCESO} WHERE (a.PropietarioId = ? OR a.UsuarioId = ?) AND a.Estado <> 'REVOCADA' ORDER BY a.FechaSolicitud DESC, a.Id DESC`, [yo, yo]);
    const filas = mios.map(mapear);
    const salida = {
      esAdmin: acc.esAdmin(req.user),
      // Me ofrecieron compartir conmigo y debo aceptar.
      porAceptar: filas.filter((a) => a.usuarioId === yo && a.estado === 'PENDIENTE' && a.origen === 'COMPARTIDA'),
      // Pidieron ver lo mío y debo responder.
      solicitudesPorResponder: filas.filter((a) => a.propietarioId === yo && a.estado === 'PENDIENTE' && a.origen === 'SOLICITUD'),
      // Quién ve lo mío (bitácora completa o pasos concretos).
      conAcceso: filas.filter((a) => a.propietarioId === yo && a.estado === 'ACEPTADA'),
      // Lo que ofrecí y todavía no aceptaron.
      enviadosPendientes: filas.filter((a) => a.propietarioId === yo && a.estado === 'PENDIENTE' && a.origen === 'COMPARTIDA'),
      // Lo de otras personas que puedo ver.
      recibidos: filas.filter((a) => a.usuarioId === yo && a.estado === 'ACEPTADA'),
      // Mis solicitudes (pendientes o rechazadas).
      misSolicitudes: filas.filter((a) => a.usuarioId === yo && a.origen === 'SOLICITUD' && ['PENDIENTE', 'RECHAZADA'].includes(a.estado)),
      todos: [],
    };
    if (acc.esAdmin(req.user)) {
      const [todos] = await pool.query(`${SELECT_ACCESO} WHERE a.Estado IN ('PENDIENTE','ACEPTADA') ORDER BY up.nombre_completo, uu.nombre_completo, a.Id LIMIT 500`);
      salida.todos = todos.map(mapear);
    }
    res.json(salida);
  }));

  // Quién participa en un paso y con quién se compartió (para el cuadro «Compartir paso»).
  router.get('/bitacora/accesos/paso/:rid', manejar('los accesos del paso', async (req, res, pool) => {
    const id = idValido(req.params.rid);
    const info = id ? await acc.nivelDePaso(pool, req.user, id) : { existe: false };
    if (!info.existe || !info.nivel) return res.status(404).json({ error: 'Ese paso no existe o no tienes acceso a él.' });
    const [part] = await pool.query(
      'SELECT u.id, u.username, u.nombre_completo FROM usuarios u WHERE u.id IN (?) ORDER BY u.nombre_completo', [info.involucrados.length ? info.involucrados : [0]]);
    const [filas] = await pool.query(`${SELECT_ACCESO} WHERE a.PasoId = ? AND a.Estado IN ('PENDIENTE','ACEPTADA') ORDER BY uu.nombre_completo`, [id]);
    res.json({
      puedeCompartir: info.participo || acc.esAdmin(req.user),
      participantes: part.map((u) => ({ id: Number(u.id), nombre: u.nombre_completo || u.username })),
      accesos: filas.map(mapear),
    });
  }));

  // --- compartir (el dueño ofrece; quien recibe acepta). ADMIN_POD puede otorgar sin aceptación.
  router.post('/bitacora/accesos/compartir', manejar('compartir', async (req, res, pool) => {
    const { destinatarioIds, equipoId, pasoId, propietarioId: propietarioPedido } = req.body || {};
    const permiso = req.body?.permiso || 'LECTURA';
    if (!PERMISOS.has(permiso)) return res.status(400).json({ error: 'El permiso debe ser LECTURA o EDICION.' });
    const admin = acc.esAdmin(req.user);
    const yo = Number(req.user.id);

    let propietarioId = yo;
    if (propietarioPedido !== undefined && propietarioPedido !== null && Number(propietarioPedido) !== yo) {
      if (!admin) return res.status(403).json({ error: 'Solo el administrador puede dar acceso a la bitácora de otra persona.' });
      propietarioId = idValido(propietarioPedido);
      if (!propietarioId || !(await personasConModulo(pool, { ids: [propietarioId] })).length) {
        return res.status(404).json({ error: 'La persona dueña de esa bitácora no existe o no tiene el módulo.' });
      }
    }

    // Alcance: un paso o la bitácora completa.
    let alcancePaso = null;
    let excluir = new Set([propietarioId]);
    let porAdmin = admin && propietarioId !== yo;
    if (pasoId !== undefined && pasoId !== null && pasoId !== '') {
      const pid = idValido(pasoId);
      const info = pid ? await acc.nivelDePaso(pool, req.user, pid) : { existe: false };
      if (!info.existe || !info.nivel) return res.status(404).json({ error: 'Ese paso no existe o no tienes acceso a él.' });
      if (!info.participo && !admin) return res.status(403).json({ error: 'Solo quien participa en un paso puede compartirlo.' });
      const [[paso]] = await pool.query('SELECT Id, Rfc, Titulo, CreadoPorId FROM PasosProduccion WHERE Id = ?', [pid]);
      alcancePaso = paso;
      if (!info.participo) { propietarioId = Number(paso.CreadoPorId); porAdmin = true; } // el admin lo comparte «a nombre» del creador
      excluir = new Set(info.involucrados.concat([propietarioId]));
    }

    // Destinatarios: personas elegidas + integrantes del equipo elegido.
    let ids = acc.idsValidos(destinatarioIds);
    const eqId = idValido(equipoId);
    if (equipoId !== undefined && equipoId !== null && equipoId !== '') {
      if (!eqId) return res.status(400).json({ error: 'Equipo no válido.' });
      const [[eq]] = await pool.query('SELECT Id FROM BitacoraEquipos WHERE Id = ?', [eqId]);
      if (!eq) return res.status(404).json({ error: 'Ese equipo no existe.' });
      ids = ids.concat(await miembrosDeEquipo(pool, eqId));
    }
    ids = [...new Set(ids)].filter((i) => i !== yo || alcancePaso);
    if (!ids.length) return res.status(400).json({ error: 'Elige con quién compartir.' });
    if (ids.length > MAX_DESTINATARIOS) return res.status(400).json({ error: `Elige hasta ${MAX_DESTINATARIOS} personas.` });
    const omitidosPorParticipar = ids.filter((i) => excluir.has(i)).length;
    const personas = await personasConModulo(pool, { ids: ids.filter((i) => !excluir.has(i)) });
    const sinModulo = ids.filter((i) => !excluir.has(i)).length - personas.length;
    if (!personas.length) return res.status(400).json({ error: omitidosPorParticipar ? 'Esas personas ya participan en el paso.' : 'Las personas elegidas no existen o no tienen el módulo Pasos a Producción.' });

    const clave = alcancePaso ? alcancePaso.Id : 0;
    const resumen = { creados: 0, actualizados: 0, aprobados: 0, yaPendientes: 0, omitidosPorParticipar, sinModulo };
    const quien = nombreDe(req.user);
    const que = alcancePaso ? `el paso «${etiquetaPaso({ ...alcancePaso, PasoId: alcancePaso.Id })}»` : 'su bitácora';

    for (const dest of personas) {
      const [[previa]] = await pool.query('SELECT Id, Estado, Origen, Permiso FROM BitacoraAccesos WHERE PropietarioId = ? AND UsuarioId = ? AND PasoClave = ?', [propietarioId, dest.id, clave]);
      let accesoId;
      let notificarComo;
      const inmediato = porAdmin;
      if (previa && previa.Estado === 'ACEPTADA') {
        if (previa.Permiso !== permiso) {
          await pool.query('UPDATE BitacoraAccesos SET Permiso = ?, GestionadoPorId = ?, FechaRespuesta = NOW() WHERE Id = ?', [permiso, yo, previa.Id]);
          resumen.actualizados += 1;
        } else {
        }
        continue;
      }
      if (previa && previa.Estado === 'PENDIENTE' && previa.Origen === 'SOLICITUD') {
        // La otra persona ya había pedido acceso: compartirle equivale a aprobarlo.
        await pool.query("UPDATE BitacoraAccesos SET Estado = 'ACEPTADA', Permiso = ?, GestionadoPorId = ?, FechaRespuesta = NOW() WHERE Id = ?", [permiso, yo, previa.Id]);
        await cerrarNotificaciones(pool, previa.Id, 'ACEPTADA');
        accesoId = previa.Id; notificarComo = 'APROBADA'; resumen.aprobados += 1;
      } else if (previa && previa.Estado === 'PENDIENTE') {
        if (inmediato) {
          await pool.query("UPDATE BitacoraAccesos SET Estado = 'ACEPTADA', Origen = 'ADMIN', Permiso = ?, GestionadoPorId = ?, FechaRespuesta = NOW() WHERE Id = ?", [permiso, yo, previa.Id]);
          await cerrarNotificaciones(pool, previa.Id, 'ACEPTADA');
          accesoId = previa.Id; notificarComo = 'OTORGADO'; resumen.creados += 1;
        } else {
          await pool.query('UPDATE BitacoraAccesos SET Permiso = ? WHERE Id = ?', [permiso, previa.Id]);
          resumen.yaPendientes += 1;
          continue;
        }
      } else if (previa) {
        await pool.query(
          'UPDATE BitacoraAccesos SET Estado = ?, Origen = ?, Permiso = ?, GestionadoPorId = ?, FechaSolicitud = NOW(), FechaRespuesta = ? WHERE Id = ?',
          [inmediato ? 'ACEPTADA' : 'PENDIENTE', inmediato ? 'ADMIN' : 'COMPARTIDA', permiso, yo, inmediato ? new Date() : null, previa.Id]);
        accesoId = previa.Id; notificarComo = inmediato ? 'OTORGADO' : 'COMPARTIDO'; resumen.creados += 1;
      } else {
        const [r] = await pool.query(
          'INSERT INTO BitacoraAccesos (PropietarioId, UsuarioId, PasoId, Permiso, Estado, Origen, GestionadoPorId, FechaRespuesta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [propietarioId, dest.id, alcancePaso ? alcancePaso.Id : null, permiso, inmediato ? 'ACEPTADA' : 'PENDIENTE', inmediato ? 'ADMIN' : 'COMPARTIDA', yo, inmediato ? new Date() : null]);
        accesoId = r.insertId; notificarComo = inmediato ? 'OTORGADO' : 'COMPARTIDO'; resumen.creados += 1;
      }

      if (notificarComo === 'COMPARTIDO') {
        await notificar(pool, {
          usuarioId: dest.id, tipo: 'BITACORA_COMPARTIR', severidad: 'AVISO', accion: 'PENDIENTE', referencia: accesoId, enlace: ENLACE_ACCESOS,
          titulo: alcancePaso ? 'Quieren compartir un paso a producción contigo' : 'Quieren compartir una bitácora contigo',
          mensaje: `${quien} quiere compartirte ${que} con permiso de ${textoPermiso(permiso)}. Solo lo verás si lo aceptas.`,
          clave: `bit-comp-${accesoId}-${Date.now()}`,
        });
      } else if (notificarComo === 'APROBADA') {
        await notificar(pool, {
          usuarioId: dest.id, tipo: 'BITACORA_RESPUESTA', severidad: 'INFO', enlace: ENLACE_BITACORA, referencia: accesoId,
          titulo: 'Te dieron acceso a una bitácora', mensaje: `${quien} te dio acceso (${textoPermiso(permiso)}) a su bitácora.`, clave: `bit-resp-${accesoId}-${Date.now()}`,
        });
      } else if (notificarComo === 'OTORGADO') {
        await notificar(pool, {
          usuarioId: dest.id, tipo: 'BITACORA_OTORGADO', severidad: 'INFO', enlace: ENLACE_BITACORA, referencia: accesoId,
          titulo: 'Te dieron acceso a una bitácora', mensaje: `${quien} (administrador) te dio acceso de ${textoPermiso(permiso)} a ${alcancePaso ? que : 'la bitácora de ' + (await nombreUsuario(pool, propietarioId))}.`,
          clave: `bit-otorg-${accesoId}-${Date.now()}`,
        });
        if (propietarioId !== yo) {
          await notificar(pool, {
            usuarioId: propietarioId, tipo: 'BITACORA_OTORGADO', severidad: 'INFO', enlace: ENLACE_ACCESOS, referencia: accesoId,
            titulo: 'El administrador dio acceso a tu bitácora', mensaje: `${quien} le dio acceso de ${textoPermiso(permiso)} a ${nombreDe(dest)}${alcancePaso ? ` sobre ${que}` : ''}. Puedes quitarlo cuando quieras.`,
            clave: `bit-otorg-dueno-${accesoId}-${Date.now()}`,
          });
        }
      }
    }
    await auditar(pool, req, 'BitacoraAcceso', alcancePaso ? `paso-${alcancePaso.Id}` : `bitacora-${propietarioId}`, alcancePaso ? `Paso #${alcancePaso.Id}` : 'Bitácora', 'COMPARTIR',
      `${porAdmin ? 'Otorgado por el administrador' : 'Compartido'} (${permiso}) con ${personas.map((p) => p.username).join(', ')}.`);
    res.status(201).json(resumen);
  }));

  async function nombreUsuario(pool, id) {
    const [[u]] = await pool.query('SELECT username, nombre_completo FROM usuarios WHERE id = ?', [id]);
    return u ? (u.nombre_completo || u.username) : 'otra persona';
  }

  // --- pedir acceso a la bitácora de una persona o de todo un equipo (cada dueño responde por la suya)
  router.post('/bitacora/accesos/solicitar', manejar('pedir acceso', async (req, res, pool) => {
    if (acc.esAdmin(req.user)) return res.status(400).json({ error: 'Como administrador ya puedes ver todas las bitácoras.' });
    const yo = Number(req.user.id);
    let ids = acc.idsValidos(req.body?.propietarioIds ?? (req.body?.propietarioId ? [req.body.propietarioId] : []));
    const eqId = idValido(req.body?.equipoId);
    if (req.body?.equipoId !== undefined && req.body?.equipoId !== null && req.body?.equipoId !== '') {
      if (!eqId) return res.status(400).json({ error: 'Equipo no válido.' });
      const [[eq]] = await pool.query('SELECT Id FROM BitacoraEquipos WHERE Id = ?', [eqId]);
      if (!eq) return res.status(404).json({ error: 'Ese equipo no existe.' });
      ids = ids.concat(await miembrosDeEquipo(pool, eqId));
    }
    ids = [...new Set(ids)].filter((i) => i !== yo);
    if (!ids.length) return res.status(400).json({ error: 'Elige a quién pedirle acceso.' });
    if (ids.length > MAX_DESTINATARIOS) return res.status(400).json({ error: `Elige hasta ${MAX_DESTINATARIOS} personas.` });
    const duenos = await personasConModulo(pool, { ids });
    if (!duenos.length) return res.status(404).json({ error: 'Esas personas no existen o no tienen el módulo Pasos a Producción.' });

    const resumen = { enviadas: 0, yaTenias: 0, yaPendientes: 0, aceptadas: 0, sinModulo: ids.length - duenos.length };
    const quien = nombreDe(req.user);
    for (const dueno of duenos) {
      const [[previa]] = await pool.query('SELECT Id, Estado, Origen FROM BitacoraAccesos WHERE PropietarioId = ? AND UsuarioId = ? AND PasoClave = 0', [dueno.id, yo]);
      let accesoId;
      if (previa && previa.Estado === 'ACEPTADA') { resumen.yaTenias += 1; continue; }
      if (previa && previa.Estado === 'PENDIENTE' && previa.Origen === 'COMPARTIDA') {
        // Esa persona ya me había ofrecido su bitácora: pedirla equivale a aceptar.
        await pool.query("UPDATE BitacoraAccesos SET Estado = 'ACEPTADA', FechaRespuesta = NOW() WHERE Id = ?", [previa.Id]);
        await cerrarNotificaciones(pool, previa.Id, 'ACEPTADA');
        resumen.aceptadas += 1;
        continue;
      }
      if (previa && previa.Estado === 'PENDIENTE') { resumen.yaPendientes += 1; continue; }
      if (previa) {
        await pool.query("UPDATE BitacoraAccesos SET Estado = 'PENDIENTE', Origen = 'SOLICITUD', Permiso = 'LECTURA', GestionadoPorId = NULL, FechaSolicitud = NOW(), FechaRespuesta = NULL WHERE Id = ?", [previa.Id]);
        accesoId = previa.Id;
      } else {
        const [r] = await pool.query("INSERT INTO BitacoraAccesos (PropietarioId, UsuarioId, Permiso, Estado, Origen) VALUES (?, ?, 'LECTURA', 'PENDIENTE', 'SOLICITUD')", [dueno.id, yo]);
        accesoId = r.insertId;
      }
      resumen.enviadas += 1;
      await notificar(pool, {
        usuarioId: dueno.id, tipo: 'BITACORA_SOLICITUD', severidad: 'AVISO', accion: 'PENDIENTE', referencia: accesoId, enlace: ENLACE_ACCESOS,
        titulo: 'Piden acceso a tu bitácora de pasos a producción',
        mensaje: `${quien} pidió ver tu bitácora. Tú decides si la ve solo en lectura o también puede editar tus pasos.`,
        clave: `bit-sol-${accesoId}-${Date.now()}`,
      });
    }
    await auditar(pool, req, 'BitacoraAcceso', `solicitud-${yo}`, 'Bitácora', 'SOLICITUD_ACCESO', `Pidió acceso a ${duenos.map((d) => d.username).join(', ')}.`);
    res.status(201).json(resumen);
  }));

  // --- responder: la persona que recibió un ofrecimiento lo acepta; el dueño aprueba una solicitud.
  router.post('/bitacora/accesos/:rid/responder', manejar('responder', async (req, res, pool) => {
    const id = idValido(req.params.rid);
    const f = id ? await accesoPorId(pool, id) : null;
    const yo = Number(req.user.id);
    const admin = acc.esAdmin(req.user);
    const esDestinatario = f && Number(f.UsuarioId) === yo && f.Origen === 'COMPARTIDA';
    const esDueno = f && (Number(f.PropietarioId) === yo || admin) && f.Origen === 'SOLICITUD';
    if (!f || !(esDestinatario || esDueno)) return res.status(404).json({ error: 'Esa solicitud no existe o no te corresponde responderla.' });
    if (f.Estado !== 'PENDIENTE') return res.status(409).json({ error: 'Esa solicitud ya fue respondida.' });
    const aceptar = req.body?.aceptar === true || req.body?.aprobar === true;
    const permiso = esDueno ? (req.body?.permiso || f.Permiso || 'LECTURA') : f.Permiso;
    if (!PERMISOS.has(permiso)) return res.status(400).json({ error: 'El permiso debe ser LECTURA o EDICION.' });
    const estado = aceptar ? 'ACEPTADA' : 'RECHAZADA';
    await pool.query('UPDATE BitacoraAccesos SET Estado = ?, Permiso = ?, GestionadoPorId = ?, FechaRespuesta = NOW() WHERE Id = ?', [estado, permiso, yo, id]);
    await cerrarNotificaciones(pool, id, estado);
    const quien = nombreDe(req.user);
    const que = f.PasoId ? `el paso «${etiquetaPaso(f)}»` : 'la bitácora';
    if (esDestinatario) {
      await notificar(pool, {
        usuarioId: f.PropietarioId, tipo: 'BITACORA_RESPUESTA', severidad: 'INFO', enlace: ENLACE_ACCESOS, referencia: id,
        titulo: aceptar ? 'Aceptaron lo que compartiste' : 'Rechazaron lo que compartiste',
        mensaje: `${quien} ${aceptar ? 'aceptó' : 'rechazó'} ${que} que le compartiste.`, clave: `bit-resp-${id}-${Date.now()}`,
      });
    } else {
      await notificar(pool, {
        usuarioId: f.UsuarioId, tipo: 'BITACORA_RESPUESTA', severidad: aceptar ? 'INFO' : 'AVISO', enlace: aceptar ? ENLACE_BITACORA : ENLACE_ACCESOS, referencia: id,
        titulo: aceptar ? 'Te dieron acceso a una bitácora' : 'Rechazaron tu solicitud de acceso',
        mensaje: aceptar ? `${quien} aprobó tu solicitud (${textoPermiso(permiso)}) a la bitácora de ${f.PropNombre || f.PropUser}.` : `${quien} no aprobó tu solicitud de acceso a la bitácora de ${f.PropNombre || f.PropUser}.`,
        clave: `bit-resp-${id}-${Date.now()}`,
      });
    }
    await auditar(pool, req, 'BitacoraAcceso', id, 'Acceso a bitácora', 'RESPUESTA_ACCESO',
      `${quien} ${aceptar ? 'aceptó' : 'rechazó'} (${permiso}) el acceso de ${f.UsuNombre || f.UsuUser} a ${f.PasoId ? `un paso de ${f.PropUser}` : `la bitácora de ${f.PropUser}`}.`);
    res.json({ ok: true, estado, permiso });
  }));

  // --- cambiar el permiso de un acceso (dueño o ADMIN_POD)
  router.put('/bitacora/accesos/:rid', manejar('cambiar el permiso', async (req, res, pool) => {
    const id = idValido(req.params.rid);
    const f = id ? await accesoPorId(pool, id) : null;
    const yo = Number(req.user.id);
    if (!f || !(Number(f.PropietarioId) === yo || acc.esAdmin(req.user))) return res.status(404).json({ error: 'Ese acceso no existe o no te corresponde.' });
    const permiso = req.body?.permiso;
    if (!PERMISOS.has(permiso)) return res.status(400).json({ error: 'El permiso debe ser LECTURA o EDICION.' });
    if (!['ACEPTADA', 'PENDIENTE'].includes(f.Estado)) return res.status(409).json({ error: 'Ese acceso ya no está vigente.' });
    await pool.query('UPDATE BitacoraAccesos SET Permiso = ?, GestionadoPorId = ? WHERE Id = ?', [permiso, yo, id]);
    if (f.Estado === 'ACEPTADA') {
      await notificar(pool, {
        usuarioId: f.UsuarioId, tipo: 'BITACORA_RESPUESTA', severidad: 'INFO', enlace: ENLACE_BITACORA, referencia: id,
        titulo: 'Cambió tu permiso en una bitácora', mensaje: `${nombreDe(req.user)} cambió tu permiso a ${textoPermiso(permiso)} sobre ${f.PasoId ? `el paso «${etiquetaPaso(f)}»` : `la bitácora de ${f.PropNombre || f.PropUser}`}.`,
        clave: `bit-perm-${id}-${Date.now()}`,
      });
    }
    await auditar(pool, req, 'BitacoraAcceso', id, 'Acceso a bitácora', 'CAMBIO_PERMISO', `${f.UsuUser}: ${f.Permiso} -> ${permiso}.`);
    res.json({ id, permiso });
  }));

  // --- quitar un acceso: el dueño, quien lo recibió (deja de seguirlo) o ADMIN_POD. También cancela un ofrecimiento pendiente.
  router.delete('/bitacora/accesos/:rid', manejar('quitar el acceso', async (req, res, pool) => {
    const id = idValido(req.params.rid);
    const f = id ? await accesoPorId(pool, id) : null;
    const yo = Number(req.user.id);
    const esDueno = f && Number(f.PropietarioId) === yo;
    const esUsuario = f && Number(f.UsuarioId) === yo;
    if (!f || !(esDueno || esUsuario || acc.esAdmin(req.user))) return res.status(404).json({ error: 'Ese acceso no existe o no te corresponde.' });
    if (f.Estado === 'REVOCADA') return res.status(409).json({ error: 'Ese acceso ya estaba revocado.' });
    await pool.query("UPDATE BitacoraAccesos SET Estado = 'REVOCADA', GestionadoPorId = ?, FechaRespuesta = NOW() WHERE Id = ?", [yo, id]);
    await cerrarNotificaciones(pool, id, 'REVOCADA');
    const quien = nombreDe(req.user);
    const que = f.PasoId ? `el paso «${etiquetaPaso(f)}»` : `la bitácora de ${f.PropNombre || f.PropUser}`;
    if (!esUsuario) {
      await notificar(pool, {
        usuarioId: f.UsuarioId, tipo: 'BITACORA_REVOCADO', severidad: 'INFO', enlace: ENLACE_BITACORA, referencia: id,
        titulo: 'Te quitaron un acceso a la bitácora', mensaje: `${quien} dejó de compartir contigo ${que}.`, clave: `bit-rev-${id}-${Date.now()}`,
      });
    }
    if (!esDueno) {
      await notificar(pool, {
        usuarioId: f.PropietarioId, tipo: 'BITACORA_REVOCADO', severidad: 'INFO', enlace: ENLACE_ACCESOS, referencia: id,
        titulo: esUsuario ? 'Dejaron de seguir lo que compartiste' : 'Se quitó un acceso a tu bitácora',
        mensaje: esUsuario ? `${quien} dejó de usar ${f.PasoId ? `el paso «${etiquetaPaso(f)}»` : 'tu bitácora'} que le compartiste.` : `${quien} (administrador) le quitó el acceso a ${f.UsuNombre || f.UsuUser}.`,
        clave: `bit-rev-dueno-${id}-${Date.now()}`,
      });
    }
    await auditar(pool, req, 'BitacoraAcceso', id, 'Acceso a bitácora', 'REVOCAR_ACCESO', `${f.UsuUser} deja de ver ${f.PasoId ? `un paso de ${f.PropUser}` : `la bitácora de ${f.PropUser}`}.`);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ fusionar pasos duplicados
  // Un mismo paso de producción debe existir UNA sola vez. Si por error (o por datos antiguos) quedaron
  // dos registros del mismo RFC y ambiente, se unen en uno: se conserva `conservarId` y se absorben los
  // demás (participantes, checklist, evidencias, servicios, accesos e historial) antes de borrarlos.
  // Quién puede: quien creó el paso que desaparece (y puede editar el que se conserva) o ADMIN_POD.
  // Solo se fusionan pasos del mismo RFC y ambiente (o del mismo evento de calendario).
  const normaliza = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const mismoPaso = (a, b) =>
    (a.Rfc && b.Rfc && normaliza(a.Rfc) === normaliza(b.Rfc) && a.Entorno === b.Entorno) ||
    (a.GoogleEventId && b.GoogleEventId && a.GoogleEventId === b.GoogleEventId);

  async function fusionarUno(conn, K, A) {
    // 1) Participantes: quien creó, ejecutó o participaba en el duplicado pasa a participar en el que queda.
    const [eq] = await conn.query('SELECT UsuarioId FROM PasosProduccionEquipo WHERE PasoId = ?', [A.Id]);
    const personas = [A.CreadoPorId, A.EjecutadoPorId, ...eq.map((e) => e.UsuarioId)]
      .filter((u) => u !== null && u !== undefined && Number(u) !== Number(K.CreadoPorId));
    const unicas = [...new Set(personas.map(Number))];
    if (unicas.length) await conn.query('INSERT IGNORE INTO PasosProduccionEquipo (PasoId, UsuarioId) VALUES ?', [unicas.map((u) => [K.Id, u])]);

    // 2) Checklist: los ítems iguales (misma descripción) se unifican; los distintos se pasan al paso que queda.
    const [itemsK] = await conn.query('SELECT * FROM PasoProduccionChecklist WHERE PasoId = ? ORDER BY Orden, Id', [K.Id]);
    const [itemsA] = await conn.query('SELECT * FROM PasoProduccionChecklist WHERE PasoId = ? ORDER BY Orden, Id', [A.Id]);
    const porTexto = new Map(itemsK.map((i) => [normaliza(i.Descripcion), i]));
    let orden = itemsK.reduce((m, i) => Math.max(m, Number(i.Orden) || 0), 0) + 1;
    let unificados = 0;
    let movidos = 0;
    for (const it of itemsA) {
      const igual = porTexto.get(normaliza(it.Descripcion));
      if (igual) {
        if (it.Completado && !igual.Completado) {
          await conn.query('UPDATE PasoProduccionChecklist SET Completado = 1, CompletadoPorId = ?, FechaCompletado = ? WHERE Id = ?', [it.CompletadoPorId, it.FechaCompletado, igual.Id]);
          igual.Completado = 1;
        }
        await conn.query('UPDATE PasoProduccionAdjuntos SET ChecklistItemId = ?, PasoId = ? WHERE ChecklistItemId = ?', [igual.Id, K.Id, it.Id]);
        unificados += 1;
      } else {
        await conn.query('UPDATE PasoProduccionChecklist SET PasoId = ?, Orden = ? WHERE Id = ?', [K.Id, orden, it.Id]);
        await conn.query('UPDATE PasoProduccionAdjuntos SET PasoId = ? WHERE ChecklistItemId = ?', [K.Id, it.Id]);
        porTexto.set(normaliza(it.Descripcion), it);
        orden += 1;
        movidos += 1;
      }
    }
    // Evidencias sueltas (no ligadas a un ítem).
    await conn.query('UPDATE PasoProduccionAdjuntos SET PasoId = ? WHERE PasoId = ?', [K.Id, A.Id]);

    // 3) Servicios del BUS y servidores/sub-aplicativos.
    if (await acc.serviciosListos(conn)) {
      await conn.query('INSERT IGNORE INTO PasosProduccionServicios (PasoId, ServicioId) SELECT ?, ServicioId FROM PasosProduccionServicios WHERE PasoId = ?', [K.Id, A.Id]);
    }
    try {
      const [[m]] = await conn.query('SELECT COALESCE(MAX(Orden), -1) + 1 AS sig FROM PasosProduccionComponentes WHERE PasoId = ?', [K.Id]);
      await conn.query('INSERT IGNORE INTO PasosProduccionComponentes (PasoId, ComponenteId, Orden) SELECT ?, ComponenteId, Orden + ? FROM PasosProduccionComponentes WHERE PasoId = ?', [K.Id, Number(m.sig), A.Id]);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }

    // 4) Datos que el paso que queda no tenía.
    const sets = [];
    const vals = [];
    const vacio = (v) => v === null || v === undefined || v === '';
    for (const col of ['FechaHoraEstimadaFin', 'GoogleEventId', 'AplicativoId']) {
      if (vacio(K[col]) && !vacio(A[col])) { sets.push(`${col} = ?`); vals.push(A[col]); K[col] = A[col]; }
    }
    if (vacio(K.CommitId) && !vacio(A.CommitId)) {
      for (const col of ['CommitId', 'CommitRepo', 'CommitRama', 'CommitMensaje', 'CommitAutor', 'CommitFecha', 'CommitUrl']) { sets.push(`${col} = ?`); vals.push(A[col]); K[col] = A[col]; }
    }
    const dK = String(K.Descripcion || '').trim();
    const dA = String(A.Descripcion || '').trim();
    if (dA && dA !== dK) {
      const nueva = dK ? `${dK}\n\n— Del paso fusionado #${A.Id} —\n${dA}` : dA;
      sets.push('Descripcion = ?'); vals.push(nueva); K.Descripcion = nueva;
    }
    if (sets.length) await conn.query(`UPDATE PasosProduccion SET ${sets.join(', ')} WHERE Id = ?`, [...vals, K.Id]);

    // 5) Accesos concedidos sobre el duplicado, e historial.
    if (await acc.accesosListos(conn)) {
      await conn.query('UPDATE IGNORE BitacoraAccesos SET PasoId = ? WHERE PasoId = ?', [K.Id, A.Id]);
    }
    try {
      await conn.query("UPDATE AuditoriaGeneral SET EntidadId = ? WHERE Entidad = 'PasoProduccion' AND EntidadId = ?", [String(K.Id), String(A.Id)]);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }

    // 6) El duplicado desaparece (lo que quedaba ligado a él se borra en cascada).
    await conn.query('DELETE FROM PasosProduccion WHERE Id = ?', [A.Id]);
    return { unificados, movidos, personas: unicas };
  }

  router.post('/bitacora/fusionar', exigirEdicion, manejar('fusionar los pasos', async (req, res, pool) => {
    const conservarId = idValido(req.body?.conservarId);
    const absorberIds = acc.idsValidos(req.body?.absorberIds).filter((x) => x !== conservarId);
    if (!conservarId || !absorberIds.length) return res.status(400).json({ error: 'Indica el paso que se conserva y al menos un duplicado que se une a él.' });
    if (absorberIds.length > 10) return res.status(400).json({ error: 'Fusiona hasta 10 duplicados por vez.' });
    const admin = acc.esAdmin(req.user);

    const infoK = await acc.nivelDePaso(pool, req.user, conservarId);
    if (!infoK.existe || !infoK.nivel) return res.status(404).json({ error: 'El paso que querías conservar no existe o no tienes acceso a él.' });
    if (!(admin || acc.puedeEditarNivel(infoK.nivel))) {
      return res.status(403).json({ error: 'No puedes modificar el paso que quieres conservar (te lo compartieron solo para lectura).' });
    }
    const [[K]] = await pool.query('SELECT * FROM PasosProduccion WHERE Id = ?', [conservarId]);

    const duplicados = [];
    for (const id of absorberIds) {
      const info = await acc.nivelDePaso(pool, req.user, id);
      if (!info.existe || !info.nivel) return res.status(404).json({ error: `El paso #${id} no existe o no tienes acceso a él.` });
      const [[A]] = await pool.query('SELECT * FROM PasosProduccion WHERE Id = ?', [id]);
      if (!mismoPaso(K, A)) return res.status(400).json({ error: `«${A.Titulo}» no es del mismo RFC y ambiente que el paso que se conserva: solo se fusionan duplicados.` });
      if (!(admin || info.nivel === 'PROPIETARIO')) {
        return res.status(403).json({ error: `«${A.Titulo}» lo creó otra persona: solo ella (o un administrador) puede fusionarlo. Pídele que lo haga, o conserva ese paso y fusiona el tuyo.` });
      }
      duplicados.push({ A, involucrados: info.involucrados });
    }

    const conn = await pool.getConnection();
    const resumen = { unificados: 0, movidos: 0 };
    try {
      await conn.beginTransaction();
      for (const d of duplicados) {
        const r = await fusionarUno(conn, K, d.A);
        resumen.unificados += r.unificados;
        resumen.movidos += r.movidos;
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    const quien = nombreDe(req.user);
    const titulos = duplicados.map((d) => `#${d.A.Id}`).join(', ');
    await auditar(pool, req, 'PasoProduccion', conservarId, K.Titulo, 'FUSION', `Se fusionaron los duplicados ${titulos} en este paso.`);
    const avisar = new Set();
    for (const d of duplicados) d.involucrados.forEach((u) => avisar.add(Number(u)));
    avisar.delete(Number(req.user.id));
    for (const usuarioId of avisar) {
      await notificar(pool, {
        usuarioId, tipo: 'PASO_FUSIONADO', severidad: 'INFO', enlace: ENLACE_BITACORA, referencia: conservarId,
        titulo: 'Se fusionaron pasos duplicados',
        mensaje: `${quien} unió pasos duplicados de «${K.Rfc ? `${K.Rfc} · ` : ''}${K.Titulo}». Ahora es un solo paso y aparece una vez en tu bitácora.`,
        clave: `paso-fusion-${conservarId}-${usuarioId}-${Date.now()}`,
      }).catch((e) => console.error('Bitácora: no se pudo avisar de la fusión:', e.message));
    }
    res.json({ ok: true, conservarId, fusionados: duplicados.length, ...resumen });
  }, { requiereTablas: false }));
}

module.exports = { registrar };
