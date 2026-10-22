const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { validarPassword } = require('../utils/passwordPolicy');
const { verifyToken } = require('../middlewares/authMiddleware');
const {
  garantizarAuditoriaUsuarios,
  registrarEventoUsuario,
} = require('../utils/usuariosAuditoria');
const {
  credencialesConfiguradas: credencialesADConfiguradas,
  autenticarLdap,
} = require('../utils/activeDirectory');
const router = express.Router();
const { getPool } = require('../db');

// SIN respaldo hardcodeado: si JWT_SECRET no está en el .env, el servidor
// falla al arrancar en vez de usar silenciosamente un secreto débil/expuesto.
const SECRET_KEY = process.env.JWT_SECRET;
if (!SECRET_KEY) {
  throw new Error(
    'Falta la variable de entorno JWT_SECRET. Defínela en tu archivo .env ' +
    '(ver instrucciones en el chat) antes de arrancar el servidor.'
  );
}

const { validarFotoPerfil, columnaFotoDisponible } = require('../utils/fotoPerfil');
const { cargarPermisos } = require('../utils/permisosModulos');
const {
  MENSAJE_FALTA_COLUMNAS: MENSAJE_FALTA_CONTACTO,
  contactoDisponible,
  asegurarContacto,
  normalizarCorreo,
  normalizarTelefono,
  enmascararCorreo,
  enmascararTelefono,
} = require('../utils/recuperacionPassword');
const {
  OPCIONES_MINUTOS,
  MENSAJE_FALTA_COLUMNAS,
  columnasSesionDisponibles,
  estadoSesion,
  expiracionToken,
  minutosValidos,
  etiquetaMinutos,
} = require('../utils/sesionUsuario');

// Duración del token: 2 h por defecto; para quien el ADMIN_POD habilitó a
// personalizar su sesión y eligió un tiempo, ese tiempo + un margen (el frontend
// lo renueva mientras haya actividad). Ver utils/sesionUsuario.js.

function firmarToken(user, permisos) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      rol: user.rol,
      modulos: permisos.modulos,
      // Rol del usuario en cada módulo (CONSULTA | ADMIN_MIN); el backend lo
      // vuelve a consultar en vivo al editar (ver requireEditPermission).
      modulosRoles: permisos.roles,
      // Mientras esto sea true, el middleware verifyToken bloquea el resto
      // de la API — solo se libera al cambiar la contraseña (ver
      // PUT /cambiar-password, que re-emite el token ya sin este flag).
      debeCambiarPassword: !!user.debe_cambiar_password,
    },
    SECRET_KEY,
    { expiresIn: expiracionToken(user) }
  );
}

function usuarioParaRespuesta(user, permisos) {
  const sesion = estadoSesion(user);
  return {
    id: user.id,
    username: user.username,
    nombre: user.nombre_completo,
    rol: user.rol,
    modulos: permisos.modulos,
    modulosRoles: permisos.roles,
    debeCambiarPassword: !!user.debe_cambiar_password,
    fechaUltimoCambioPassword: user.fecha_ultimo_cambio_password || null,
    // Data URI de la foto de perfil, o null (sin foto / columna aún no creada).
    fotoPerfil: user.foto_perfil || null,
    // Contacto para recuperar la contraseña con código (null si no tiene o la columna aún no existe).
    correo: user.correo || null,
    telefono: user.telefono || null,
    // Sesión: ¿puede ajustar su tiempo de inactividad? (lo decide el ADMIN_POD),
    // cuántos minutos de inactividad tolera hoy y si ese valor es elegido por él.
    sesionPersonalizable: sesion.puedePersonalizar,
    sesionMinutos: sesion.minutos,
    sesionPersonalizada: sesion.personalizada,
  };
}

// Módulos habilitados + rol del usuario en cada uno ({ modulos, roles }).
// Un ADMIN_POD ignora la tabla intermedia y tiene acceso a TODO (ver
// utils/permisosModulos.js).
async function obtenerModulosPermitidos(pool, user) {
  return cargarPermisos(pool, user);
}

// Cierra un login ya verificado (local o AD): emite el token, audita
// LOGIN_EXITOSO y responde -- compartido por las dos ramas de abajo para no
// duplicar esta parte en cada una.
async function completarLoginExitoso(pool, req, res, user) {
  const permisos = await obtenerModulosPermitidos(pool, user);
  const token = firmarToken(user, permisos);

  await registrarEventoUsuario(pool, req, {
    usuarioId: user.id,
    usernameIntentado: user.username,
    accion: 'LOGIN_EXITOSO',
    // Sin esto, la columna "Detalle/Cambios" de la auditoría queda vacía
    // para el tipo de evento más frecuente de todos (cada login exitoso).
    detalle: 'Inicio de sesión exitoso',
  });

  res.json({
    message: 'Login exitoso',
    token,
    usuario: usuarioParaRespuesta(user, permisos),
  });
}

// Si Active Directory está configurado y `username`/`password` autentican
// correctamente ahí, crea su fila en `usuarios` (rol BASIC, sin módulos,
// tipo AD) y la devuelve. Si AD no está configurado, el bind falla, o
// ocurre cualquier otro problema, devuelve null -- el llamador lo trata
// igual que "usuario inexistente" (mismo mensaje genérico al cliente, sin
// revelar si el problema fue de AD o de la base local).
async function intentarAutoProvisionAD(pool, req, username, password) {
  if (!credencialesADConfiguradas()) return null;

  let autenticado = false;
  try {
    autenticado = await autenticarLdap(username, password);
  } catch (err) {
    console.error('Error consultando Active Directory en /api/auth/login (usuario nuevo):', err);
    return null;
  }
  if (!autenticado) return null;

  // Esta columna nunca se usa para iniciar sesión (tipo_autenticacion = 'AD'
  // hace que el login siempre valide contra el directorio, ver más abajo),
  // pero es NOT NULL -- se guarda un hash aleatorio e inservible, nunca la
  // contraseña real de AD de la persona.
  const salt = await bcrypt.genSalt(10);
  const passwordInservible = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), salt);

  // Al autenticar por bind simple (sin búsqueda LDAP) no tenemos el nombre
  // real de la persona -- se usa el username como nombre completo inicial y
  // un ADMIN_POD lo corrige después desde Gestión de Usuarios si hace falta.
  const [result] = await pool.query(
    `INSERT INTO usuarios (username, password, nombre_completo, rol, tipo_autenticacion, debe_cambiar_password)
     VALUES (?, ?, ?, 'BASIC', 'AD', 0)`,
    [username, passwordInservible, username]
  );

  await registrarEventoUsuario(pool, req, {
    usuarioId: result.insertId,
    usernameIntentado: username,
    accion: 'CREACION',
    rolNuevo: 'BASIC',
    tipoAutenticacionNuevo: 'AD',
    detalle: 'Cuenta creada automáticamente al autenticar por primera vez contra Active Directory',
  });

  const [usuariosNuevos] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [result.insertId]);
  return usuariosNuevos[0];
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);

    // Se consulta por username solamente (sin "AND activo = TRUE" en el
    // WHERE) para poder distinguir en el log de auditoría "no existe" de
    // "existe pero está inactiva" — al cliente, en todos los casos posibles
    // de fallo, se le devuelve siempre el mismo mensaje genérico para no
    // revelar si un username existe o no.
    const [users] = await pool.query('SELECT * FROM usuarios WHERE username = ?', [username]);

    if (users.length === 0) {
      // No tiene fila en la base local -- si Active Directory está
      // configurado, se intenta un bind LDAP antes de rendirse: el username
      // de la app es el mismo usuario de red, así que cualquier persona
      // válida del directorio que todavía no tenga cuenta en AXIS puede
      // entrar directo, y se le crea la cuenta automáticamente (rol BASIC,
      // sin módulos -- un ADMIN_POD se los asigna después).
      const usuarioNuevo = await intentarAutoProvisionAD(pool, req, username, password);
      if (!usuarioNuevo) {
        await registrarEventoUsuario(pool, req, {
          usernameIntentado: username,
          accion: 'LOGIN_FALLIDO',
          detalle: 'Usuario inexistente',
        });
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
      return completarLoginExitoso(pool, req, res, usuarioNuevo);
    }

    const user = users[0];

    if (!user.activo) {
      await registrarEventoUsuario(pool, req, {
        usuarioId: user.id,
        usernameIntentado: username,
        accion: 'LOGIN_FALLIDO',
        detalle: 'Cuenta inactiva',
      });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (user.tipo_autenticacion === 'AD') {
      // Cuenta marcada por un ADMIN_POD como "Directorio Activo" -- se
      // valida siempre contra AD, nunca contra el hash local (que ni
      // siquiera corresponde a una contraseña real, ver
      // intentarAutoProvisionAD y usuarios.js).
      let autenticado = false;
      try {
        autenticado = await autenticarLdap(username, password);
      } catch (err) {
        console.error('Error consultando Active Directory en /api/auth/login:', err);
        // Directorio inalcanzable: no hay un "respaldo" con la contraseña
        // local para una cuenta marcada como AD, así que esto también
        // termina en el mismo mensaje genérico de credenciales inválidas.
      }
      if (!autenticado) {
        await registrarEventoUsuario(pool, req, {
          usuarioId: user.id,
          usernameIntentado: username,
          accion: 'LOGIN_FALLIDO',
          detalle: 'Credenciales de Active Directory incorrectas',
        });
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
    } else {
      // Verificar contraseña local con bcrypt
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        await registrarEventoUsuario(pool, req, {
          usuarioId: user.id,
          usernameIntentado: username,
          accion: 'LOGIN_FALLIDO',
          detalle: 'Contraseña incorrecta',
        });
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
    }

    return completarLoginExitoso(pool, req, res, user);
  } catch (error) {
    // Antes este catch no dejaba rastro en los logs del contenedor, así que
    // un 500 acá era imposible de diagnosticar desde `docker logs`.
    console.error('Error en /api/auth/login:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// GET /api/auth/me — perfil del usuario autenticado (refresca lo que
// muestra "Mi perfil" sin depender solo de lo guardado en localStorage).
router.get('/me', verifyToken, async (req, res) => {
  try {
    const pool = await getPool();
    const colFoto = (await columnaFotoDisponible(pool)) ? ', foto_perfil' : '';
    const colSesion = (await columnasSesionDisponibles(pool)) ? ', sesion_personalizable, sesion_minutos' : '';
    const colContacto = (await contactoDisponible(pool)) ? ', correo, telefono' : '';
    const [users] = await pool.query(
      `SELECT id, username, nombre_completo, rol, activo, debe_cambiar_password, fecha_ultimo_cambio_password${colFoto}${colSesion}${colContacto} FROM usuarios WHERE id = ?`,
      [req.user.id]
    );
    if (users.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Antes se usaba req.user.modulos (la lista congelada en el JWT del
    // login), por lo que un módulo nuevo que un admin le habilitara a un
    // usuario con sesión activa nunca se reflejaba hasta volver a loguearse.
    // Se consulta fresco y se reemite el token (mismo patrón que
    // /cambiar-password) para que requireModule() también lo vea al tiro.
    const permisos = await obtenerModulosPermitidos(pool, users[0]);
    const token = firmarToken(users[0], permisos);

    res.json({
      message: 'Perfil actualizado',
      token,
      usuario: usuarioParaRespuesta(users[0], permisos),
    });
  } catch (error) {
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// PUT /api/auth/cambiar-password — usado tanto en el flujo obligatorio
// (primer login / tras un reset del admin) como en el cambio voluntario
// desde "Mi perfil". Siempre exige la contraseña actual.
router.put('/cambiar-password', verifyToken, async (req, res) => {
  const { passwordActual, passwordNueva } = req.body;
  if (!passwordActual || !passwordNueva) {
    return res.status(400).json({ error: 'Debes indicar la contraseña actual y la nueva.' });
  }

  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);

    const [users] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [req.user.id]);
    if (users.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = users[0];

    const validPassword = await bcrypt.compare(passwordActual, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta.' });
    }

    // La nueva no puede ser igual a la actual (en el cambio obligatorio tras un
    // reset, la "actual" es la contraseña temporal / anterior).
    if (passwordNueva === passwordActual) {
      return res.status(400).json({ error: 'La nueva contraseña no puede ser igual a la contraseña actual. Elige una diferente.' });
    }

    // Política de contraseñas seguras (ver utils/passwordPolicy.js) — se
    // valida DESPUÉS de confirmar la actual para no gastarle el intento a
    // alguien que ni siquiera puso bien su contraseña de hoy.
    const { valido, errores } = validarPassword(passwordNueva, {
      username: user.username,
      nombreCompleto: user.nombre_completo,
    });
    if (!valido) {
      return res.status(400).json({ error: `La nueva contraseña no cumple los requisitos de seguridad: ${errores.join(' ')}` });
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(passwordNueva, salt);

    await pool.query(
      'UPDATE usuarios SET password = ?, debe_cambiar_password = 0, fecha_ultimo_cambio_password = NOW() WHERE id = ?',
      [hash, user.id]
    );

    await registrarEventoUsuario(pool, req, {
      usuarioId: user.id,
      usernameIntentado: user.username,
      accion: 'CAMBIO_PASSWORD',
      passwordCambiada: true,
      detalle: 'Cambio de contraseña realizado por el propio usuario',
    });

    // Se re-emite el token ya sin el flag debeCambiarPassword, para que el
    // usuario pueda seguir navegando sin tener que volver a loguearse.
    user.debe_cambiar_password = 0;
    user.fecha_ultimo_cambio_password = new Date();
    const permisos = await obtenerModulosPermitidos(pool, user);
    const token = firmarToken(user, permisos);

    res.json({
      message: 'Contraseña actualizada correctamente',
      token,
      usuario: usuarioParaRespuesta(user, permisos),
    });
  } catch (error) {
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// PUT /api/auth/perfil — edición del propio perfil (nombre completo y foto). El
// username y el rol/módulos no son editables por el propio usuario, eso
// sigue siendo exclusivo de Gestión de Usuarios (ADMIN_POD).
// "fotoPerfil" es opcional: si NO viene en el body, la foto actual no se toca;
// con un data URI se reemplaza; con null se borra.
router.put('/perfil', verifyToken, async (req, res) => {
  const { nombreCompleto, fotoPerfil } = req.body;
  if (!nombreCompleto || !nombreCompleto.trim()) {
    return res.status(400).json({ error: 'El nombre completo no puede estar vacío.' });
  }
  // Correo y teléfono (opcionales; undefined = no tocar, '' = borrar). Sirven para recuperar la contraseña.
  let correoNuevoPedido;
  let telefonoNuevoPedido;
  try {
    if (req.body.correo !== undefined) correoNuevoPedido = normalizarCorreo(req.body.correo);
    if (req.body.telefono !== undefined) telefonoNuevoPedido = normalizarTelefono(req.body.telefono);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const cambiaContactoPedido = correoNuevoPedido !== undefined || telefonoNuevoPedido !== undefined;
  const cambiaFoto = fotoPerfil !== undefined;
  if (cambiaFoto && fotoPerfil !== null) {
    const errorFoto = validarFotoPerfil(fotoPerfil);
    if (errorFoto) return res.status(400).json({ error: errorFoto });
  }

  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);

    if (cambiaFoto && !(await columnaFotoDisponible(pool))) {
      return res.status(409).json({
        error: 'Falta la columna foto_perfil en la base de datos. Ejecuta una vez el script agregar_foto_perfil_usuarios.sql con una cuenta con privilegios.',
      });
    }

    if (cambiaContactoPedido && !(await asegurarContacto(pool))) {
      return res.status(409).json({ error: MENSAJE_FALTA_CONTACTO });
    }

    const [users] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [req.user.id]);
    if (users.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = users[0];

    const correoAntes = user.correo || null;
    const telefonoAntes = user.telefono || null;
    const correoNuevo = correoNuevoPedido !== undefined ? correoNuevoPedido : correoAntes;
    const telefonoNuevo = telefonoNuevoPedido !== undefined ? telefonoNuevoPedido : telefonoAntes;
    const cambiaContacto = correoNuevo !== correoAntes || telefonoNuevo !== telefonoAntes;
    if (cambiaContacto && correoNuevo) {
      const [dup] = await pool.query('SELECT id FROM usuarios WHERE correo = ? AND id <> ? LIMIT 1', [correoNuevo, user.id]);
      if (dup.length) return res.status(400).json({ error: 'Ese correo ya está registrado en otra cuenta.' });
    }

    const nombreAnterior = user.nombre_completo;
    const nombreNuevo = nombreCompleto.trim();
    const cambiaNombre = nombreNuevo !== nombreAnterior;
    const fotoNueva = cambiaFoto ? fotoPerfil : undefined;
    const fotoCambio = cambiaFoto && (fotoNueva || null) !== (user.foto_perfil || null);

    if (!cambiaNombre && !fotoCambio && !cambiaContacto) {
      const permisosSinCambio = await obtenerModulosPermitidos(pool, user);
      return res.json({ message: 'Sin cambios', usuario: usuarioParaRespuesta(user, permisosSinCambio) });
    }

    if (cambiaNombre) await pool.query('UPDATE usuarios SET nombre_completo = ? WHERE id = ?', [nombreNuevo, user.id]);
    if (fotoCambio) await pool.query('UPDATE usuarios SET foto_perfil = ? WHERE id = ?', [fotoNueva || null, user.id]);
    if (cambiaContacto) await pool.query('UPDATE usuarios SET correo = ?, telefono = ? WHERE id = ?', [correoNuevo, telefonoNuevo, user.id]);

    await registrarEventoUsuario(pool, req, {
      usuarioId: user.id,
      usernameIntentado: user.username,
      accion: 'EDICION_PERFIL',
      nombreCompletoAnterior: nombreAnterior,
      nombreCompletoNuevo: nombreNuevo,
      detalle: [
        'Edición de perfil realizada por el propio usuario',
        fotoCambio ? (fotoNueva ? 'cambió su foto de perfil' : 'quitó su foto de perfil') : null,
        cambiaContacto ? `actualizó su contacto de recuperación: correo ${correoNuevo ? enmascararCorreo(correoNuevo) : '(sin correo)'}, teléfono ${telefonoNuevo ? enmascararTelefono(telefonoNuevo) : '(sin teléfono)'}` : null,
      ].filter(Boolean).join(' — '),
    });

    user.nombre_completo = nombreNuevo;
    if (fotoCambio) user.foto_perfil = fotoNueva || null;
    if (cambiaContacto) { user.correo = correoNuevo; user.telefono = telefonoNuevo; }
    const permisos = await obtenerModulosPermitidos(pool, user);
    res.json({ message: 'Perfil actualizado correctamente', usuario: usuarioParaRespuesta(user, permisos) });
  } catch (error) {
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

const descripcionSesion = (e) => (e.personalizada ? etiquetaMinutos(e.minutos) : `${etiquetaMinutos(e.minutos)} (por defecto)`);

// PUT /api/auth/sesion — el propio usuario ajusta cuánto tiempo de inactividad
// tolera su sesión. Solo si el ADMIN_POD se lo habilitó (o si es ADMIN_POD).
// body: { minutos: 15|30|60|120|240|480|720 } o { minutos: null } para volver al
// valor por defecto. Reemite el token con la nueva duración.
router.put('/sesion', verifyToken, async (req, res) => {
  const { minutos } = req.body || {};
  const restablecer = minutos === null;
  if (!restablecer && !minutosValidos(Number(minutos))) {
    return res.status(400).json({ error: `Elige un tiempo válido (${OPCIONES_MINUTOS.map(etiquetaMinutos).join(', ')}).` });
  }

  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);

    if (!(await columnasSesionDisponibles(pool))) {
      return res.status(409).json({ error: MENSAJE_FALTA_COLUMNAS });
    }

    const [users] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [req.user.id]);
    if (users.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = users[0];

    const antes = estadoSesion(user);
    if (!antes.puedePersonalizar) {
      return res.status(403).json({ error: 'Tu cuenta no tiene habilitado ajustar el tiempo de sesión. Solicítalo a un administrador.' });
    }

    const nuevo = restablecer ? null : Number(minutos);
    await pool.query('UPDATE usuarios SET sesion_minutos = ? WHERE id = ?', [nuevo, user.id]);
    user.sesion_minutos = nuevo;
    const despues = estadoSesion(user);

    if (despues.minutos !== antes.minutos || despues.personalizada !== antes.personalizada) {
      await registrarEventoUsuario(pool, req, {
        usuarioId: user.id,
        usernameIntentado: user.username,
        accion: 'CAMBIO_SESION',
        detalle: `Tiempo de inactividad de la sesión: ${descripcionSesion(antes)} → ${descripcionSesion(despues)}`,
      });
    }

    const permisos = await obtenerModulosPermitidos(pool, user);
    const token = firmarToken(user, permisos);
    res.json({
      message: 'Tiempo de sesión actualizado',
      token,
      usuario: usuarioParaRespuesta(user, permisos),
    });
  } catch (error) {
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

module.exports = router;
