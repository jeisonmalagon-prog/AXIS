// Recuperación de contraseña por código (OTP) — rutas PÚBLICAS: /api/auth/recuperar/*
// (la persona no puede iniciar sesión, por eso no llevan verifyToken). Ver utils/recuperacionPassword.js
// para el diseño completo y las variables de entorno (SMTP_* para correo, SMS_* para SMS).

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getPool } = require('../db');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { validarPassword } = require('../utils/passwordPolicy');
const { garantizarAuditoriaUsuarios, registrarEventoUsuario } = require('../utils/usuariosAuditoria');
const correo = require('../utils/informes/correo');
const R = require('../utils/recuperacionPassword');

const router = express.Router();

// Mismo mensaje exista o no la cuenta: no se revela qué usuarios existen.
const MENSAJE_ENVIO = 'Si la cuenta existe y tiene un correo o teléfono registrado, te enviamos un código de 6 dígitos.';
const ERROR_CODIGO = 'El código no es válido o ya venció. Solicita uno nuevo.';

const porIp = R.crearLimitador({ max: 15, ventanaMs: 15 * 60 * 1000 });
const porIdentificador = R.crearLimitador({ max: 12, ventanaMs: 60 * 60 * 1000 });
const porIpVerificar = R.crearLimitador({ max: 40, ventanaMs: 15 * 60 * 1000 });

function ipDe(req) {
  const f = req.headers['x-forwarded-for'];
  return (f ? String(f).split(',')[0].trim() : req.ip || req.socket?.remoteAddress || '').slice(0, 64);
}
const limpiarTexto = (v, max = 150) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

async function auditar(pool, req, datos) {
  try { await registrarEventoUsuario(pool, req, datos); } catch (e) { console.error('[recuperacion] no se pudo auditar:', e.message); }
}

// GET /api/auth/recuperar/canales — qué canales están activos (para que la pantalla lo explique).
router.get('/canales', (req, res) => {
  res.json({ correo: correo.smtpConfigurado(), sms: R.smsConfigurado(), vigenciaMin: R.VIGENCIA_CODIGO_MIN });
});

// POST /api/auth/recuperar/solicitar  { identificador }  (usuario o correo)
router.post('/solicitar', async (req, res) => {
  const identificador = limpiarTexto(req.body?.identificador).toLowerCase();
  if (!identificador) return res.status(400).json({ error: 'Escribe tu usuario o tu correo.' });
  const ip = ipDe(req);
  if (!porIp.permitir(ip) || !porIdentificador.permitir(identificador)) {
    return res.status(429).json({ error: 'Hiciste demasiadas solicitudes. Espera un rato e intenta de nuevo.' });
  }
  if (!correo.smtpConfigurado() && !R.smsConfigurado()) {
    return res.status(503).json({ error: 'La recuperación por código no está disponible en este momento. Contacta al administrador de AXIS.' });
  }

  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);
    if (!(await R.esquemaListo(pool))) return res.status(503).json({ error: R.MENSAJE_FALTA_ESQUEMA });

    // Respuesta base idéntica para cuentas inexistentes (token falso que nunca verifica).
    const respuesta = (token, restante = R.REENVIO_SEG) => ({ mensaje: MENSAJE_ENVIO, solicitudId: token, vigenciaMin: R.VIGENCIA_CODIGO_MIN, reenvioSeg: restante });

    const [filas] = await pool.query(
      identificador.includes('@')
        ? 'SELECT id, username, nombre_completo, activo, tipo_autenticacion, correo, telefono FROM usuarios WHERE correo = ? LIMIT 2'
        : 'SELECT id, username, nombre_completo, activo, tipo_autenticacion, correo, telefono FROM usuarios WHERE username = ? LIMIT 2',
      [identificador]
    );
    const usuario = filas.length === 1 ? filas[0] : null;
    if (!usuario) {
      await auditar(pool, req, { usernameIntentado: identificador.slice(0, 100), accion: 'RECUPERACION_SOLICITADA', detalle: 'Solicitud de código para una cuenta inexistente o ambigua' });
      return res.json(respuesta(R.generarToken()));
    }

    const elegible = !!usuario.activo && usuario.tipo_autenticacion !== 'AD' && !!(usuario.correo || usuario.telefono);
    if (!elegible) {
      const motivo = !usuario.activo ? 'cuenta inactiva' : usuario.tipo_autenticacion === 'AD' ? 'cuenta de Active Directory (la contraseña se gestiona en el directorio)' : 'sin correo ni teléfono registrados';
      await auditar(pool, req, { usuarioId: usuario.id, usernameIntentado: usuario.username, accion: 'RECUPERACION_SOLICITADA', detalle: `Solicitud rechazada: ${motivo}` });
      return res.json(respuesta(R.generarToken()));
    }

    // Enfriamiento: no se reenvía antes de REENVIO_SEG (se reusa la solicitud vigente).
    const [recientes] = await pool.query(
      `SELECT Token, TIMESTAMPDIFF(SECOND, CreadoEn, NOW()) AS seg FROM RecuperacionPassword
       WHERE UsuarioId = ? AND Estado = 'PENDIENTE' AND ExpiraEn > NOW() ORDER BY Id DESC LIMIT 1`,
      [usuario.id]
    );
    if (recientes.length && recientes[0].seg < R.REENVIO_SEG) {
      return res.json(respuesta(recientes[0].Token, R.REENVIO_SEG - recientes[0].seg));
    }
    const [[{ n: ultimaHora }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM RecuperacionPassword WHERE UsuarioId = ? AND CreadoEn > DATE_SUB(NOW(), INTERVAL 1 HOUR)',
      [usuario.id]
    );
    if (ultimaHora >= 5) {
      await auditar(pool, req, { usuarioId: usuario.id, usernameIntentado: usuario.username, accion: 'RECUPERACION_BLOQUEADA', detalle: 'Más de 5 códigos solicitados en la última hora' });
      return res.status(429).json({ error: 'Esta cuenta ya solicitó varios códigos. Espera un rato e intenta de nuevo.' });
    }

    const canales = [];
    if (usuario.correo && correo.smtpConfigurado()) canales.push('correo');
    if (usuario.telefono && R.smsConfigurado()) canales.push('sms');
    if (!canales.length) {
      await auditar(pool, req, { usuarioId: usuario.id, usernameIntentado: usuario.username, accion: 'RECUPERACION_SOLICITADA', detalle: 'Solicitud sin canal de envío disponible (el canal de sus datos no está configurado en el servidor)' });
      return res.json(respuesta(R.generarToken()));
    }

    const codigo = R.generarCodigo();
    const token = R.generarToken();
    await pool.query("UPDATE RecuperacionPassword SET Estado = 'REEMPLAZADA' WHERE UsuarioId = ? AND Estado IN ('PENDIENTE','VERIFICADA')", [usuario.id]);
    await pool.query(
      `INSERT INTO RecuperacionPassword (Token, UsuarioId, CodigoHash, Canales, IP, ExpiraEn)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [token, usuario.id, R.hashCodigo(token, codigo), canales.join(','), ip, R.VIGENCIA_CODIGO_MIN]
    );

    // El MISMO código por todos los canales disponibles; basta con que llegue por uno.
    const envios = [];
    if (canales.includes('correo')) {
      const m = R.correoCodigo({ nombre: usuario.nombre_completo || usuario.username, codigo });
      envios.push(correo.enviarTexto({ destinatarios: [usuario.correo], asunto: m.asunto, html: m.html, texto: m.texto }).then(() => 'correo'));
    }
    if (canales.includes('sms')) envios.push(R.enviarSms(usuario.telefono, R.textoSms(codigo)).then(() => 'sms'));
    const resultados = await Promise.allSettled(envios);
    const ok = resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const fallos = resultados.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason).slice(0, 120));
    fallos.forEach((f) => console.error('[recuperacion] fallo al enviar el código:', f));

    // Si no salió por ningún canal la solicitud no sirve (y no cuenta contra el límite por hora; la auditoría conserva el rastro).
    if (!ok.length) await pool.query('DELETE FROM RecuperacionPassword WHERE Token = ?', [token]);
    await auditar(pool, req, {
      usuarioId: usuario.id, usernameIntentado: usuario.username,
      accion: ok.length ? 'RECUPERACION_SOLICITADA' : 'RECUPERACION_ENVIO_FALLIDO',
      detalle: ok.length
        ? `Código enviado por ${ok.join(' y ')} (${[usuario.correo && ok.includes('correo') ? R.enmascararCorreo(usuario.correo) : null, usuario.telefono && ok.includes('sms') ? R.enmascararTelefono(usuario.telefono) : null].filter(Boolean).join(', ')})`
        : `No se pudo enviar el código: ${fallos.join(' | ')}`,
    });

    return res.json(respuesta(token));
  } catch (error) {
    console.error('Error en POST /auth/recuperar/solicitar:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// POST /api/auth/recuperar/verificar  { solicitudId, codigo }  ->  { resetToken }
router.post('/verificar', async (req, res) => {
  const solicitudId = limpiarTexto(req.body?.solicitudId, 64);
  const codigo = limpiarTexto(req.body?.codigo, 12).replace(/\s/g, '');
  if (!solicitudId || !/^\d{6}$/.test(codigo)) return res.status(400).json({ error: 'Escribe el código de 6 dígitos.' });
  if (!porIpVerificar.permitir(ipDe(req))) return res.status(429).json({ error: 'Demasiados intentos. Espera un rato e intenta de nuevo.' });

  try {
    const pool = await getPool();
    if (!(await R.esquemaListo(pool))) return res.status(503).json({ error: R.MENSAJE_FALTA_ESQUEMA });
    const [filas] = await pool.query(
      `SELECT r.Id, r.UsuarioId, r.CodigoHash, r.Intentos, u.username
       FROM RecuperacionPassword r JOIN usuarios u ON u.id = r.UsuarioId
       WHERE r.Token = ? AND r.Estado = 'PENDIENTE' AND r.ExpiraEn > NOW() LIMIT 1`,
      [solicitudId]
    );
    if (!filas.length) return res.status(400).json({ error: ERROR_CODIGO, solicitarNuevo: true });
    const sol = filas[0];

    if (!R.hashIgual(R.hashCodigo(solicitudId, codigo), sol.CodigoHash)) {
      const intentos = sol.Intentos + 1;
      const bloqueada = intentos >= R.MAX_INTENTOS;
      await pool.query('UPDATE RecuperacionPassword SET Intentos = ?, Estado = ? WHERE Id = ?', [intentos, bloqueada ? 'BLOQUEADA' : 'PENDIENTE', sol.Id]);
      await auditar(pool, req, { usuarioId: sol.UsuarioId, usernameIntentado: sol.username, accion: bloqueada ? 'RECUPERACION_BLOQUEADA' : 'RECUPERACION_FALLIDA', detalle: bloqueada ? 'Código incorrecto: se agotaron los intentos y la solicitud se bloqueó' : `Código incorrecto (intento ${intentos} de ${R.MAX_INTENTOS})` });
      if (bloqueada) return res.status(400).json({ error: 'Superaste los intentos permitidos. Solicita un código nuevo.', solicitarNuevo: true });
      const restantes = R.MAX_INTENTOS - intentos;
      return res.status(400).json({ error: `Código incorrecto. Te ${restantes === 1 ? 'queda 1 intento' : `quedan ${restantes} intentos`}.`, intentosRestantes: restantes });
    }

    // Marca verificada (solo una vez: la condición Estado='PENDIENTE' evita carreras de doble verificación).
    const [upd] = await pool.query("UPDATE RecuperacionPassword SET Estado = 'VERIFICADA', VerificadaEn = NOW() WHERE Id = ? AND Estado = 'PENDIENTE'", [sol.Id]);
    if (!upd.affectedRows) return res.status(400).json({ error: ERROR_CODIGO, solicitarNuevo: true });
    await auditar(pool, req, { usuarioId: sol.UsuarioId, usernameIntentado: sol.username, accion: 'RECUPERACION_VERIFICADA', detalle: 'Código verificado correctamente' });

    const resetToken = jwt.sign({ tipo: 'reset', rid: sol.Id, uid: sol.UsuarioId }, R.secretoReset(), { expiresIn: `${R.VIGENCIA_RESET_MIN}m` });
    res.json({ resetToken, vigenciaMin: R.VIGENCIA_RESET_MIN });
  } catch (error) {
    console.error('Error en POST /auth/recuperar/verificar:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// POST /api/auth/recuperar/restablecer  { resetToken, passwordNueva }
router.post('/restablecer', async (req, res) => {
  const { resetToken, passwordNueva } = req.body || {};
  if (!resetToken || !passwordNueva) return res.status(400).json({ error: 'Faltan datos para restablecer la contraseña.' });

  let datos;
  try { datos = jwt.verify(String(resetToken), R.secretoReset()); } catch (_) {
    return res.status(400).json({ error: 'El permiso para cambiar la contraseña venció. Empieza de nuevo.', solicitarNuevo: true });
  }
  if (datos.tipo !== 'reset') return res.status(400).json({ error: 'Solicitud no válida.', solicitarNuevo: true });

  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);
    if (!(await R.esquemaListo(pool))) return res.status(503).json({ error: R.MENSAJE_FALTA_ESQUEMA });

    const [filas] = await pool.query(
      `SELECT r.Id, u.id AS usuarioId, u.username, u.nombre_completo, u.password, u.activo, u.tipo_autenticacion, u.correo
       FROM RecuperacionPassword r JOIN usuarios u ON u.id = r.UsuarioId
       WHERE r.Id = ? AND r.UsuarioId = ? AND r.Estado = 'VERIFICADA'
         AND r.VerificadaEn > DATE_SUB(NOW(), INTERVAL ? MINUTE) LIMIT 1`,
      [datos.rid, datos.uid, R.VIGENCIA_RESET_MIN]
    );
    if (!filas.length) return res.status(400).json({ error: 'El permiso para cambiar la contraseña ya se usó o venció. Empieza de nuevo.', solicitarNuevo: true });
    const u = filas[0];
    if (!u.activo || u.tipo_autenticacion === 'AD') return res.status(400).json({ error: 'Esta cuenta no puede restablecer su contraseña aquí.', solicitarNuevo: true });

    const { valido, errores } = validarPassword(passwordNueva, { username: u.username, nombreCompleto: u.nombre_completo });
    if (!valido) return res.status(400).json({ error: `La contraseña no cumple los requisitos de seguridad: ${errores.join(' ')}`, politica: true });
    if (await bcrypt.compare(passwordNueva, u.password)) {
      return res.status(400).json({ error: 'La contraseña nueva no puede ser igual a la actual. Elige una diferente.', politica: true });
    }

    const hash = await bcrypt.hash(passwordNueva, await bcrypt.genSalt(10));
    // Un solo uso: la condición Estado='VERIFICADA' evita que dos peticiones simultáneas la consuman.
    const [usada] = await pool.query("UPDATE RecuperacionPassword SET Estado = 'USADA' WHERE Id = ? AND Estado = 'VERIFICADA'", [u.Id]);
    if (!usada.affectedRows) return res.status(400).json({ error: 'El permiso para cambiar la contraseña ya se usó. Empieza de nuevo.', solicitarNuevo: true });

    await pool.query(
      'UPDATE usuarios SET password = ?, debe_cambiar_password = 0, fecha_ultimo_cambio_password = NOW() WHERE id = ?',
      [hash, u.usuarioId]
    );
    await pool.query("UPDATE RecuperacionPassword SET Estado = 'REEMPLAZADA' WHERE UsuarioId = ? AND Estado IN ('PENDIENTE','VERIFICADA')", [u.usuarioId]);
    await auditar(pool, req, {
      usuarioId: u.usuarioId, usernameIntentado: u.username, accion: 'RECUPERACION_EXITOSA', passwordCambiada: true,
      detalle: 'Contraseña restablecida por la propia persona con un código de recuperación',
    });

    // Aviso de seguridad al correo de la cuenta (si falla no afecta el cambio).
    if (u.correo && correo.smtpConfigurado()) {
      const m = R.correoAvisoCambio({ nombre: u.nombre_completo || u.username });
      correo.enviarTexto({ destinatarios: [u.correo], asunto: m.asunto, html: m.html, texto: m.texto }).catch((e) => console.error('[recuperacion] aviso de cambio no enviado:', e.message));
    }

    res.json({ mensaje: 'Contraseña actualizada. Ya puedes iniciar sesión con la nueva.' });
  } catch (error) {
    console.error('Error en POST /auth/recuperar/restablecer:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

module.exports = router;
