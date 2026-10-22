const express = require('express');
const crypto = require('crypto');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db'); // Exportamos getPool según tu db.js
const bcrypt = require('bcryptjs');
const { validarPassword } = require('../utils/passwordPolicy');
const { verifyToken } = require('../middlewares/authMiddleware');
const { columnaFotoDisponible } = require('../utils/fotoPerfil');
const {
  ROLES_MODULO,
  ROL_ADMIN_MIN,
  normalizarRolModulo,
  rolDesdeRolGlobal,
  columnaRolModuloDisponible,
  asegurarColumnaRolModulo,
  invalidarPermisos,
} = require('../utils/permisosModulos');
const {
  MENSAJE_FALTA_COLUMNAS: MENSAJE_FALTA_COLUMNAS_SESION,
  columnasSesionDisponibles,
  asegurarColumnasSesion,
} = require('../utils/sesionUsuario');
const {
  garantizarAuditoriaUsuarios,
  registrarEventoUsuario,
} = require('../utils/usuariosAuditoria');
const {
  MENSAJE_FALTA_COLUMNAS: MENSAJE_FALTA_CONTACTO,
  contactoDisponible,
  asegurarContacto,
  normalizarCorreo,
  normalizarTelefono,
  enmascararCorreo,
  enmascararTelefono,
} = require('../utils/recuperacionPassword');

// Middleware para verificar que sea ADMIN_POD
const requireAdmin = (req, res, next) => {
  if (req.user && req.user.rol === 'ADMIN_POD') {
    next();
  } else {
    res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
  }
};

// Correo y teléfono (para recuperar la contraseña con código). Devuelve { correo, telefono } normalizados,
// con undefined en lo que el cliente no envió; lanza un error 400 con mensaje claro si algo no es válido
// o si el correo ya lo usa otra cuenta.
async function leerContacto(pool, body, idActual = null) {
  const r = {};
  if (body.correo !== undefined) {
    r.correo = normalizarCorreo(body.correo);
    if (r.correo) {
      const [dup] = await pool.query('SELECT id FROM usuarios WHERE correo = ? AND id <> ? LIMIT 1', [r.correo, idActual || 0]);
      if (dup.length) throw Object.assign(new Error('Ese correo ya está registrado en otra cuenta.'), { status: 400 });
    }
  }
  if (body.telefono !== undefined) r.telefono = normalizarTelefono(body.telefono);
  return r;
}

// Lista de módulos que existen en la app (frontend + auth.js). La tabla
// `modulos` es un catálogo que se pobló a mano en la base de datos, y el
// INSERT de abajo filtra los módulos a guardar por nombre contra esa tabla
// (WHERE nombre IN (?)) — cualquier nombre que falte ahí se descarta en
// silencio, sin ningún error. Si en el futuro se agrega un módulo nuevo acá
// y a los checkboxes del frontend pero nadie lo inserta a mano en `modulos`,
// pasa exactamente eso: se marca la casilla, se guarda "sin error", y al
// reabrir el usuario aparece desmarcada otra vez.
const { MODULOS_VALIDOS } = require('../utils/modulos');

// Se asegura de que el catálogo `modulos` tenga una fila por cada módulo
// válido antes de guardar; si falta alguno, lo agrega. Así un módulo nuevo
// queda disponible solo con desplegar el código, sin depender de acordarse
// de insertarlo a mano en la base de datos.
async function garantizarCatalogoModulos(pool) {
  const [existentes] = await pool.query('SELECT nombre FROM modulos');
  const existentesSet = new Set(existentes.map(m => m.nombre));
  const faltantes = MODULOS_VALIDOS.filter(m => !existentesSet.has(m));
  if (faltantes.length > 0) {
    await pool.query(
      `INSERT INTO modulos (nombre) VALUES ${faltantes.map(() => '(?)').join(', ')}`,
      faltantes
    );
  }
}

// Compara dos listas de módulos ignorando el orden (para no marcar como
// "cambio" un simple reordenamiento que llega distinto desde el frontend).
function modulosIguales(a, b) {
  const na = [...(a || [])].sort().join(',');
  const nb = [...(b || [])].sort().join(',');
  return na === nb;
}

// ----- Rol por módulo -----
// Roles de los módulos de un usuario como { MODULO: 'CONSULTA' | 'ADMIN_MIN' }.
// Una fila sin rol propio (NULL) o con la columna aún sin crear hereda del rol
// global del usuario (BASIC = Consulta, ADMIN_MIN = Admin).
async function leerRolesPorModulo(pool, usuarioIds, rolGlobalPorUsuario) {
  const resultado = {};
  if (!usuarioIds.length) return resultado;
  const conColumna = await columnaRolModuloDisponible(pool);
  const [filas] = await pool.query(
    `SELECT um.usuario_id, m.nombre, ${conColumna ? 'um.rol_modulo' : 'NULL'} AS rol_modulo
     FROM usuario_modulos um
     INNER JOIN modulos m ON um.modulo_id = m.id
     WHERE um.usuario_id IN (?)`,
    [usuarioIds]
  );
  filas.forEach((f) => {
    if (!resultado[f.usuario_id]) resultado[f.usuario_id] = {};
    resultado[f.usuario_id][f.nombre] =
      normalizarRolModulo(f.rol_modulo) || rolDesdeRolGlobal(rolGlobalPorUsuario[f.usuario_id], f.nombre);
  });
  return resultado;
}

// Rol por módulo que se guardará: toma el pedido por el admin (modulosRoles) y,
// si no viene para algún módulo, el que corresponde al rol global enviado.
// Devuelve [{ nombre, rol }] solo con módulos válidos.
function resolverModulosConRol(modulos, modulosRoles, rolGlobal) {
  const lista = [];
  const vistos = new Set();
  (Array.isArray(modulos) ? modulos : []).forEach((nombre) => {
    if (!MODULOS_VALIDOS.includes(nombre) || vistos.has(nombre)) return;
    vistos.add(nombre);
    const pedido = modulosRoles && typeof modulosRoles === 'object' ? modulosRoles[nombre] : undefined;
    lista.push({ nombre, rol: normalizarRolModulo(pedido) || rolDesdeRolGlobal(rolGlobal, nombre) });
  });
  return lista;
}

// Con roles por módulo, el rol global de un usuario que no es ADMIN_POD queda
// derivado: ADMIN_MIN solo si TODOS sus módulos son de Admin; en cualquier otro
// caso BASIC (la opción más restrictiva, por si algo antiguo aún lo consulta).
function rolGlobalDerivado(modulosConRol) {
  return modulosConRol.length > 0 && modulosConRol.every((m) => m.rol === ROL_ADMIN_MIN) ? 'ADMIN_MIN' : 'BASIC';
}

// Texto para la auditoría: "CERTIFICADOS (CONSULTA)". Sin columna, solo el nombre.
function modulosParaAuditoria(modulosConRol, conRoles) {
  return modulosConRol.map((m) => (conRoles ? `${m.nombre} (${m.rol})` : m.nombre));
}

// Reemplaza los módulos del usuario guardando el rol de cada uno (si la columna existe).
async function guardarModulosDeUsuario(pool, usuarioId, modulosConRol, conColumna) {
  await pool.query('DELETE FROM usuario_modulos WHERE usuario_id = ?', [usuarioId]);
  if (!modulosConRol.length) return;
  if (conColumna) {
    for (const m of modulosConRol) {
      await pool.query(
        'INSERT INTO usuario_modulos (usuario_id, modulo_id, rol_modulo) SELECT ?, id, ? FROM modulos WHERE nombre = ?',
        [usuarioId, m.rol, m.nombre]
      );
    }
  } else {
    await pool.query(
      'INSERT INTO usuario_modulos (usuario_id, modulo_id) SELECT ?, id FROM modulos WHERE nombre IN (?)',
      [usuarioId, modulosConRol.map((m) => m.nombre)]
    );
  }
}

const MENSAJE_FALTA_COLUMNA_ROL =
  'Falta la columna rol_modulo en la base de datos y el usuario de la aplicación no puede crearla. ' +
  'Ejecuta una vez el script agregar_rol_por_modulo.sql con una cuenta con privilegios.';

// OPCIONES PARA LA PANTALLA DE USUARIOS (solo ADMIN_POD): módulos, roles posibles
// y si ya se pueden guardar roles por módulo (columna creada). Intenta crear la
// columna si falta; sin privilegios de DDL responde disponible=false y la pantalla
// sigue funcionando con el rol global de siempre.
router.get('/opciones', [verifyToken, requireAdmin], async (req, res) => {
  try {
    const pool = await getPool();
    const disponible = await asegurarColumnaRolModulo(pool);
    res.json({
      modulos: MODULOS_VALIDOS,
      roles: ROLES_MODULO,
      rolPorModuloDisponible: disponible,
      aviso: disponible ? null : MENSAJE_FALTA_COLUMNA_ROL,
      // ¿Ya se puede decidir qué usuarios ajustan su tiempo de sesión?
      // (columnas usuarios.sesion_personalizable / sesion_minutos)
      sesionPersonalizableDisponible: await asegurarColumnasSesion(pool),
      avisoSesion: (await columnasSesionDisponibles(pool)) ? null : MENSAJE_FALTA_COLUMNAS_SESION,
    });
  } catch (error) {
    console.error('Error en GET /usuarios/opciones:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'las opciones de usuarios' }) });
  }
});

// LISTA BÁSICA PARA SELECTORES -- cualquier usuario autenticado (no solo
// ADMIN_POD, a diferencia de GET /). La usan Tareas (asignar a compañeros) y
// la Bitácora de Pasos a Producción (equipo/ejecutor): ninguna de las dos
// necesita ver el rol o los módulos de otro usuario para poder elegirlo en
// un selector, así que se expone lo mínimo (id, username, nombre).
// Va ANTES de GET '/' a propósito, aunque no colisionan (esta es una ruta
// fija, no ':id') -- así queda junto a los demás GET de solo lectura.
router.get('/basico', verifyToken, async (req, res) => {
  try {
    const pool = await getPool();
    const [usuarios] = await pool.query(
      'SELECT id, username, nombre_completo FROM usuarios WHERE activo = 1 ORDER BY nombre_completo'
    );
    res.json(usuarios);
  } catch (error) {
    console.error('Error en GET /usuarios/basico:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la lista de usuarios' }) });
  }
});

// Fotos de perfil de los usuarios activos, como { "<id>": "data:image/...;base64,..." }
// (solo quienes tienen foto). Va aparte de /basico a propósito: las fotos pesan
// más y solo las necesitan las pantallas que muestran avatares (Tareas); así el
// listado liviano de selectores no se infla. Cualquier usuario autenticado.
router.get('/fotos', verifyToken, async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await columnaFotoDisponible(pool))) return res.json({});
    const [filas] = await pool.query(
      'SELECT id, foto_perfil FROM usuarios WHERE activo = 1 AND foto_perfil IS NOT NULL AND foto_perfil <> \'\''
    );
    const fotos = {};
    filas.forEach((f) => { fotos[f.id] = f.foto_perfil; });
    res.json(fotos);
  } catch (error) {
    console.error('Error en GET /usuarios/fotos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'las fotos de perfil' }) });
  }
});

// 1. OBTENER TODOS LOS USUARIOS
router.get('/', [verifyToken, requireAdmin], async (req, res) => {
  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);
    const conSesion = await columnasSesionDisponibles(pool);
    const conContacto = await contactoDisponible(pool);
    const query = `
      SELECT u.id, u.username, u.nombre_completo, u.rol, u.activo,
             u.tipo_autenticacion,
             ${conContacto ? 'u.correo, u.telefono,' : ''}
             u.debe_cambiar_password, u.fecha_ultimo_cambio_password,
             ${conSesion ? 'u.sesion_personalizable, u.sesion_minutos,' : ''}
             GROUP_CONCAT(m.nombre) as modulos
      FROM usuarios u
      LEFT JOIN usuario_modulos um ON u.id = um.usuario_id
      LEFT JOIN modulos m ON um.modulo_id = m.id
      GROUP BY u.id
    `;

    const [rows] = await pool.query(query);

    const rolGlobalPorUsuario = {};
    rows.forEach((u) => { rolGlobalPorUsuario[u.id] = u.rol; });
    const rolesPorUsuario = await leerRolesPorModulo(pool, rows.map((u) => u.id), rolGlobalPorUsuario);

    // Formateamos para Angular
    const usuarios = rows.map(u => ({
      ...u,
      activo: u.activo === 1,
      correo: conContacto ? (u.correo || null) : null,
      telefono: conContacto ? (u.telefono || null) : null,
      debe_cambiar_password: u.debe_cambiar_password === 1,
      // Puede ajustar el tiempo de inactividad de su sesión en Mi perfil.
      sesion_personalizable: conSesion && Number(u.sesion_personalizable) === 1,
      sesion_minutos: conSesion && u.sesion_minutos != null ? Number(u.sesion_minutos) : null,
      modulos: u.modulos ? u.modulos.split(',') : [],
      // Rol del usuario en cada uno de sus módulos (CONSULTA | ADMIN_MIN).
      modulosRoles: rolesPorUsuario[u.id] || {},
    }));

    res.json(usuarios);
  } catch (error) {
    console.error('Error en GET /usuarios:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'los usuarios' }) });
  }
});

// 2. CREAR USUARIO
router.post('/', [verifyToken, requireAdmin], async (req, res) => {
  const { username, password, nombre_completo, rol, modulos, modulosRoles, tipo_autenticacion, sesion_personalizable } = req.body;
  const tipoAuth = tipo_autenticacion === 'AD' ? 'AD' : 'LOCAL';

  // Una cuenta de Active Directory nunca tiene contraseña local -- se
  // autentica siempre contra el directorio (ver backend/routes/auth.js), así
  // que la política de contraseñas solo aplica a cuentas LOCAL.
  if (tipoAuth === 'LOCAL') {
    // Política de contraseñas seguras (ver utils/passwordPolicy.js) — antes
    // no se validaba nada acá, así que un admin podía crear una cuenta con
    // "123456" sin ningún aviso.
    const { valido, errores } = validarPassword(password, { username, nombreCompleto: nombre_completo });
    if (!valido) {
      return res.status(400).json({ error: `La contraseña no cumple los requisitos de seguridad: ${errores.join(' ')}` });
    }
  }

  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);
    await garantizarCatalogoModulos(pool);

    // Correo / teléfono (opcionales): se validan ANTES de crear el usuario para no dejarlo a medias.
    const contacto = await leerContacto(pool, req.body);
    const guardaContacto = !!(contacto.correo || contacto.telefono);
    if (guardaContacto && !(await asegurarContacto(pool))) return res.status(409).json({ error: MENSAJE_FALTA_CONTACTO });

    // Rol por módulo: si el admin lo envía, la columna rol_modulo debe existir.
    const conColumna = modulosRoles !== undefined
      ? await asegurarColumnaRolModulo(pool)
      : await columnaRolModuloDisponible(pool);
    if (modulosRoles !== undefined && !conColumna) {
      return res.status(409).json({ error: MENSAJE_FALTA_COLUMNA_ROL });
    }
    // Permiso de personalizar la sesión: solo se guarda si se pidió activarlo.
    const pideSesion = sesion_personalizable === true;
    if (pideSesion && !(await asegurarColumnasSesion(pool))) {
      return res.status(409).json({ error: MENSAJE_FALTA_COLUMNAS_SESION });
    }
    const modulosConRol = rol === 'ADMIN_POD' ? [] : resolverModulosConRol(modulos, modulosRoles, rol);
    // Con roles por módulo el rol global queda derivado (ver rolGlobalDerivado).
    const rolFinal = rol !== 'ADMIN_POD' && modulosRoles !== undefined ? rolGlobalDerivado(modulosConRol) : rol;

    let passwordHash;
    if (tipoAuth === 'AD') {
      // Nunca se usa para iniciar sesión (ver backend/routes/auth.js) -- la
      // columna es NOT NULL, así que se guarda un hash aleatorio e
      // inservible, nunca una contraseña real.
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), salt);
    } else {
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(password, salt);
    }

    // Las cuentas AD no tienen contraseña local que "cambiar" -- el flujo de
    // debe_cambiar_password=1 del primer login solo aplica a cuentas LOCAL.
    const debeCambiarPassword = tipoAuth === 'AD' ? 0 : 1;

    const insertUserQuery = `INSERT INTO usuarios (username, password, nombre_completo, rol, tipo_autenticacion, debe_cambiar_password) VALUES (?, ?, ?, ?, ?, ?)`;
    const [result] = await pool.query(insertUserQuery, [username, passwordHash, nombre_completo, rolFinal, tipoAuth, debeCambiarPassword]);
    const usuarioId = result.insertId;

    if (modulosConRol.length > 0) {
      await guardarModulosDeUsuario(pool, usuarioId, modulosConRol, conColumna);
    }
    if (pideSesion) {
      await pool.query('UPDATE usuarios SET sesion_personalizable = 1 WHERE id = ?', [usuarioId]);
    }
    if (guardaContacto) {
      await pool.query('UPDATE usuarios SET correo = ?, telefono = ? WHERE id = ?', [contacto.correo || null, contacto.telefono || null, usuarioId]);
    }

    await registrarEventoUsuario(pool, req, {
      usuarioId,
      usernameIntentado: username,
      accion: 'CREACION',
      nombreCompletoNuevo: nombre_completo,
      rolNuevo: rolFinal,
      modulosNuevo: rol !== 'ADMIN_POD' ? modulosParaAuditoria(modulosConRol, conColumna) : null,
      tipoAutenticacionNuevo: tipoAuth,
      detalle: [
        pideSesion ? 'Usuario creado por administrador — puede ajustar el tiempo de su sesión' : 'Usuario creado por administrador',
        guardaContacto ? `contacto de recuperación: ${[contacto.correo ? enmascararCorreo(contacto.correo) : null, contacto.telefono ? enmascararTelefono(contacto.telefono) : null].filter(Boolean).join(', ')}` : null,
      ].filter(Boolean).join(' — '),
    });

    res.status(201).json({ mensaje: 'Usuario creado exitosamente' });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('Error en POST /usuarios:', error);
    if (error.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Ya existe un usuario con ese nombre de usuario.' });
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el usuario' }) });
  }
});

// 3. ACTUALIZAR USUARIO
router.put('/:id', [verifyToken, requireAdmin], async (req, res) => {
  const { id } = req.params;
  const { password, nombre_completo, rol, modulos, modulosRoles, tipo_autenticacion, sesion_personalizable } = req.body;
  const tipoAuth = tipo_autenticacion === 'AD' ? 'AD' : 'LOCAL';

  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);
    await garantizarCatalogoModulos(pool);

    // Correo / teléfono: solo se tocan si el cliente los envía; se validan antes de cambiar nada.
    const contacto = await leerContacto(pool, req.body, Number(id));
    const tocaContacto = contacto.correo !== undefined || contacto.telefono !== undefined;
    const conContacto = tocaContacto ? await asegurarContacto(pool) : await contactoDisponible(pool);

    // Permiso de personalizar la sesión: solo si el cliente lo envía (boolean).
    // Si las columnas no existen y se pide un cambio, se avisa con instrucciones.
    const tocaSesion = typeof sesion_personalizable === 'boolean';
    const conSesion = tocaSesion ? await asegurarColumnasSesion(pool) : await columnasSesionDisponibles(pool);

    const conColumna = modulosRoles !== undefined
      ? await asegurarColumnaRolModulo(pool)
      : await columnaRolModuloDisponible(pool);
    if (modulosRoles !== undefined && !conColumna) {
      return res.status(409).json({ error: MENSAJE_FALTA_COLUMNA_ROL });
    }
    const modulosConRol = rol === 'ADMIN_POD' ? [] : resolverModulosConRol(modulos, modulosRoles, rol);
    const rolFinal = rol !== 'ADMIN_POD' && modulosRoles !== undefined ? rolGlobalDerivado(modulosConRol) : rol;

    // Estado ANTES del cambio, para poder auditar solo lo que realmente
    // cambió (y para saber a quién referirse en el log si el usuario
    // llegara a borrarse después).
    const [usuariosAntes] = await pool.query(
      `SELECT username, nombre_completo, rol, tipo_autenticacion${conSesion ? ', sesion_personalizable' : ''}${conContacto ? ', correo, telefono' : ''} FROM usuarios WHERE id = ?`, [id]
    );
    if (usuariosAntes.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const antes = usuariosAntes[0];

    // ¿Cambia realmente el permiso? (si las columnas faltan y el admin no lo
    // tocó, no se bloquea el resto de la edición).
    const sesionAntes = conSesion && Number(antes.sesion_personalizable) === 1;
    if (tocaSesion && !conSesion && sesion_personalizable !== sesionAntes) {
      return res.status(409).json({ error: MENSAJE_FALTA_COLUMNAS_SESION });
    }
    const huboCambioSesion = tocaSesion && conSesion && sesion_personalizable !== sesionAntes;

    // ¿Cambia realmente el contacto? (si faltan las columnas y no cambia nada, no se bloquea la edición)
    const correoAntes = conContacto ? (antes.correo || null) : null;
    const telefonoAntes = conContacto ? (antes.telefono || null) : null;
    const correoNuevo = contacto.correo !== undefined ? contacto.correo : correoAntes;
    const telefonoNuevo = contacto.telefono !== undefined ? contacto.telefono : telefonoAntes;
    const huboCambioContacto = correoNuevo !== correoAntes || telefonoNuevo !== telefonoAntes;
    if (huboCambioContacto && !conContacto) return res.status(409).json({ error: MENSAJE_FALTA_CONTACTO });

    // El reseteo de contraseña solo aplica a cuentas LOCAL -- una cuenta AD
    // se autentica siempre contra el directorio, así que cualquier
    // contraseña que llegue en el body para ese caso se ignora (la pantalla
    // de edición ya oculta ese campo cuando el tipo es AD).
    const seReseteoPassword = tipoAuth === 'LOCAL' && !!password;

    // Solo se valida cuando el admin efectivamente está reseteando la
    // contraseña (campo opcional en este endpoint) -- ver
    // utils/passwordPolicy.js, mismas reglas que al crear el usuario.
    if (seReseteoPassword) {
      const { valido, errores } = validarPassword(password, { username: antes.username, nombreCompleto: nombre_completo });
      if (!valido) {
        return res.status(400).json({ error: `La contraseña no cumple los requisitos de seguridad: ${errores.join(' ')}` });
      }
    }

    const [modulosAntesFilas] = await pool.query(`
      SELECT m.nombre FROM usuario_modulos um
      INNER JOIN modulos m ON um.modulo_id = m.id
      WHERE um.usuario_id = ?
    `, [id]);
    const rolesAntes = await leerRolesPorModulo(pool, [Number(id)], { [Number(id)]: antes.rol });
    const modulosConRolAntes = modulosAntesFilas.map((m) => ({
      nombre: m.nombre,
      rol: (rolesAntes[Number(id)] || {})[m.nombre] || rolDesdeRolGlobal(antes.rol, m.nombre),
    }));
    const modulosAntes = modulosParaAuditoria(modulosConRolAntes, conColumna);

    let updateQuery = `UPDATE usuarios SET nombre_completo = ?, rol = ?, tipo_autenticacion = ? WHERE id = ?`;
    let params = [nombre_completo, rolFinal, tipoAuth, id];

    if (seReseteoPassword) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      // Un reset de contraseña por el admin también obliga a la persona a
      // cambiarla en su próximo login.
      updateQuery = `UPDATE usuarios SET nombre_completo = ?, rol = ?, tipo_autenticacion = ?, password = ?, debe_cambiar_password = 1 WHERE id = ?`;
      params = [nombre_completo, rolFinal, tipoAuth, passwordHash, id];
    }

    await pool.query(updateQuery, params);

    // Quitar el permiso también borra el tiempo elegido: vuelve al valor por
    // defecto (15 min) y, si se lo vuelven a dar, parte de cero.
    if (huboCambioSesion) {
      await pool.query(
        'UPDATE usuarios SET sesion_personalizable = ?, sesion_minutos = NULL WHERE id = ?',
        [sesion_personalizable ? 1 : 0, id]
      );
    }

    if (huboCambioContacto) {
      await pool.query('UPDATE usuarios SET correo = ?, telefono = ? WHERE id = ?', [correoNuevo, telefonoNuevo, id]);
    }

    // Actualizar módulos (y el rol del usuario en cada uno)
    await guardarModulosDeUsuario(pool, id, modulosConRol, conColumna);
    // Que el cambio de permisos rija ya (sin esperar a que caduque la caché).
    invalidarPermisos(id);

    // Solo se registran en el histórico los campos que efectivamente
    // cambiaron — el resto queda en null para que la auditoría muestre
    // exactamente lo que pasó, no un volcado completo de todos los campos.
    const huboCambioNombre = nombre_completo !== antes.nombre_completo;
    const huboCambioRol = rolFinal !== antes.rol;
    const modulosNuevos = modulosParaAuditoria(modulosConRol, conColumna);
    const huboCambioModulos = !modulosIguales(modulosNuevos, modulosAntes);
    const huboCambioTipoAuth = tipoAuth !== antes.tipo_autenticacion;

    await registrarEventoUsuario(pool, req, {
      usuarioId: Number(id),
      usernameIntentado: antes.username,
      accion: 'EDICION',
      nombreCompletoAnterior: huboCambioNombre ? antes.nombre_completo : null,
      nombreCompletoNuevo: huboCambioNombre ? nombre_completo : null,
      rolAnterior: huboCambioRol ? antes.rol : null,
      rolNuevo: huboCambioRol ? rolFinal : null,
      tipoAutenticacionAnterior: huboCambioTipoAuth ? antes.tipo_autenticacion : null,
      tipoAutenticacionNuevo: huboCambioTipoAuth ? tipoAuth : null,
      modulosAnterior: huboCambioModulos ? modulosAntes : null,
      modulosNuevo: huboCambioModulos ? modulosNuevos : null,
      passwordCambiada: seReseteoPassword,
      detalle: [
        seReseteoPassword ? 'Edición con reseteo de contraseña por administrador' : 'Edición realizada por administrador',
        huboCambioSesion
          ? (sesion_personalizable ? 'habilitó ajustar el tiempo de sesión' : 'quitó el permiso de ajustar el tiempo de sesión')
          : null,
        huboCambioContacto
          ? `contacto de recuperación: correo ${correoNuevo ? enmascararCorreo(correoNuevo) : '(sin correo)'}, teléfono ${telefonoNuevo ? enmascararTelefono(telefonoNuevo) : '(sin teléfono)'}`
          : null,
      ].filter(Boolean).join(' — '),
    });

    res.json({ mensaje: 'Usuario actualizado' });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('Error en PUT /usuarios:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el usuario' }) });
  }
});

// 4. CAMBIAR ESTADO (Activar/Desactivar)
router.patch('/:id/estado', [verifyToken, requireAdmin], async (req, res) => {
  const { id } = req.params;
  const { activo } = req.body;
  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);

    const [usuariosAntes] = await pool.query('SELECT username, activo FROM usuarios WHERE id = ?', [id]);
    if (usuariosAntes.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const antes = usuariosAntes[0];

    await pool.query(`UPDATE usuarios SET activo = ? WHERE id = ?`, [activo ? 1 : 0, id]);

    await registrarEventoUsuario(pool, req, {
      usuarioId: Number(id),
      usernameIntentado: antes.username,
      accion: activo ? 'ACTIVACION' : 'DESACTIVACION',
      activoAnterior: antes.activo === 1,
      activoNuevo: !!activo,
      detalle: activo ? 'Cuenta activada por administrador' : 'Cuenta desactivada por administrador',
    });

    res.json({ mensaje: 'Estado actualizado' });
  } catch (error) {
    console.error('Error en PATCH /usuarios/estado:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el estado del usuario' }) });
  }
});

module.exports = router;
