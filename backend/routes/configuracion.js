const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken } = require('../middlewares/authMiddleware');
const {
  obtenerTema, actualizarTema, obtenerTemaUsuario, actualizarTemaUsuario,
  obtenerColorLogin, actualizarColorLogin,
} = require('../utils/configuracionSistema');

// Mismo criterio que requireAdmin en usuarios.js (copia local a propósito).
const requireAdmin = (req, res, next) => {
  if (req.user && req.user.rol === 'ADMIN_POD') {
    next();
  } else {
    res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
  }
};

// GET /api/configuracion/tema
// SIN verifyToken a propósito: el login necesita saber si pintarse en modo
// claro u oscuro ANTES de que exista una sesión.
router.get('/tema', async (req, res) => {
  try {
    const pool = await getPool();
    const tema = await obtenerTema(pool);
    res.json({ tema });
  } catch (err) {
    console.error('Error leyendo el tema global:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// PUT /api/configuracion/tema  { tema: 'claro' | 'oscuro' }
// Exclusivo ADMIN_POD: es una configuración que afecta a TODOS los usuarios.
router.put('/tema', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { tema } = req.body;
    const pool = await getPool();
    const temaGuardado = await actualizarTema(pool, tema, req.user.id);
    res.json({ tema: temaGuardado });
  } catch (err) {
    if (err.esValidacion) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Error actualizando el tema global:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});


// GET /api/configuracion/color-login
// SIN verifyToken a propósito, mismo motivo que /tema: el login necesita
// pintarse con el color de marca elegido por el admin ANTES de que exista
// una sesión.
router.get('/color-login', async (req, res) => {
  try {
    const pool = await getPool();
    const colorLogin = await obtenerColorLogin(pool);
    res.json({ colorLogin });
  } catch (err) {
    console.error('Error leyendo el color del login:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// PUT /api/configuracion/color-login  { colorLogin: '#RRGGBB' }
// Exclusivo ADMIN_POD, igual criterio que el tema global. A diferencia del
// tema, esto SOLO afecta la vista de login (el resto de AXIS sigue el tema
// claro/oscuro de arriba, no este color).
router.put('/color-login', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { colorLogin } = req.body;
    const pool = await getPool();
    const colorGuardado = await actualizarColorLogin(pool, colorLogin, req.user.id);
    res.json({ colorLogin: colorGuardado });
  } catch (err) {
    if (err.esValidacion) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Error actualizando el color del login:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});


// GET /api/configuracion/tema/mio
// Requiere sesión (cualquier rol, no solo ADMIN_POD): cada usuario consulta
// SU PROPIA preferencia, independiente del tema_global. null = no tiene una
// propia y debe usar el tema_global.
router.get('/tema/mio', verifyToken, async (req, res) => {
  try {
    const pool = await getPool();
    const temaPersonal = await obtenerTemaUsuario(pool, req.user.id);
    res.json({ temaPersonal });
  } catch (err) {
    console.error('Error leyendo el tema personal:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// PUT /api/configuracion/tema/mio  { tema: 'claro' | 'oscuro' | 'sistema' }
// 'sistema' = volver a seguir el tema_global (no se borra la fila, ver
// utils/configuracionSistema.js).
router.put('/tema/mio', verifyToken, async (req, res) => {
  try {
    const { tema } = req.body;
    const pool = await getPool();
    const temaPersonal = await actualizarTemaUsuario(pool, req.user.id, tema);
    res.json({ temaPersonal });
  } catch (err) {
    if (err.esValidacion) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Error actualizando el tema personal:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});


// ---------------------------------------------------------------------------
// Correo saliente (SMTP). Exclusivo ADMIN_POD. La contraseña se guarda cifrada y
// NUNCA se devuelve: la pantalla solo sabe si hay una guardada (tienePass).
// Ver utils/correoConfig.js.
const correoConfig = require('../utils/correoConfig');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');

function responderErrorCorreo(res, err, texto) {
  if (err instanceof correoConfig.ErrorCorreo) return res.status(err.status).json({ error: err.message, codigo: err.codigo });
  if (err && err.status && err.message) return res.status(err.status).json({ error: err.message });
  console.error(texto, err);
  return res.status(500).json({ error: mensajeErrorAmigable(err) });
}

// GET /api/configuracion/correo
router.get('/correo', verifyToken, requireAdmin, async (req, res) => {
  try {
    res.json(await correoConfig.obtener());
  } catch (err) { responderErrorCorreo(res, err, 'Error leyendo la configuración de correo:'); }
});

// PUT /api/configuracion/correo  { host, port, secure, user, pass?, from?, dominios?, tlsInseguro? }
// pass vacío = conservar la contraseña ya guardada.
router.put('/correo', verifyToken, requireAdmin, async (req, res) => {
  try {
    const antes = correoConfig.vista();
    const cfg = await correoConfig.guardar(req.body, req.user.id);
    try {
      const pool = await getPool();
      const cambios = [];
      const cmp = (campo, etiqueta, a, b) => { if (String(a) !== String(b)) cambios.push({ campo, etiqueta, anterior: String(a || '(vacío)'), nuevo: String(b || '(vacío)') }); };
      cmp('host', 'Servidor SMTP', antes.host, cfg.host); cmp('port', 'Puerto', antes.port, cfg.port);
      cmp('secure', 'Conexión SSL directa', antes.secure, cfg.secure); cmp('user', 'Usuario', antes.user, cfg.user);
      cmp('from', 'Remitente', antes.from, cfg.from); cmp('dominios', 'Dominios permitidos', antes.dominios, cfg.dominios);
      if (req.body && req.body.pass) cambios.push({ campo: 'pass', etiqueta: 'Contraseña', anterior: '(oculta)', nuevo: '(actualizada)' });
      await registrarEventoGeneral(pool, req, {
        modulo: 'CONFIGURACION', entidad: 'Correo saliente (SMTP)', entidadId: 'smtp', entidadNombre: cfg.host,
        accion: 'EDICION', detalle: `Actualizó el correo saliente: ${cfg.host}:${cfg.port} con la cuenta ${cfg.user}.`, cambios,
      });
    } catch (errAudit) { console.error('No se pudo registrar la auditoría del correo saliente:', errAudit.message); }
    res.json(cfg);
  } catch (err) { responderErrorCorreo(res, err, 'Error guardando la configuración de correo:'); }
});

// POST /api/configuracion/correo/probar  { destinatario }
router.post('/correo/probar', verifyToken, requireAdmin, async (req, res) => {
  try {
    res.json(await correoConfig.probar(req.body && req.body.destinatario));
  } catch (err) { responderErrorCorreo(res, err, 'Error enviando el correo de prueba:'); }
});

// POST /api/configuracion/correo/restablecer — vuelve a lo que diga el .env
router.post('/correo/restablecer', verifyToken, requireAdmin, async (req, res) => {
  try {
    res.json(await correoConfig.restablecer(req.user.id));
  } catch (err) { responderErrorCorreo(res, err, 'Error restableciendo la configuración de correo:'); }
});

module.exports = router;
