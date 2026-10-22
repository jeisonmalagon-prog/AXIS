const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { rolEnModulo, ROL_CONSULTA } = require('../utils/permisosModulos');
const { obtenerIp } = require('../utils/auditoriaGeneral');
const S = require('../utils/soporteN1');

// ==========================================================================
// Monitoreo > Soporte Nivel 1 (se monta en /api/soporte-n1).
//  · Lo ve quien tenga el módulo SOPORTE_N1 (se asigna por usuario en Usuarios y accesos, con rol Consulta o Admin).
//  · Rol de administración (ADMIN_MIN / ADMIN_POD): reinicia directo.
//  · Rol Consulta: pide un código (OTP) que llega por correo a los aprobadores; con el código correcto se reinicia.
//  · Solo el ADMIN_POD configura aprobadores, vigencia del código y contenedor de cada acción.
//  · En la auditoría queda quién pidió el código, los fallos, y quién reinició y por qué vía. Nunca el código.
// ==========================================================================

router.use(verifyToken, requireModule('SOPORTE_N1'));

const soloAdmin = (req, res, next) => {
  if (req.user && req.user.rol === 'ADMIN_POD') return next();
  return res.status(403).json({ error: 'Solo el ADMIN_POD puede cambiar la configuración de Soporte Nivel 1.' });
};

async function usuarioActual(req) {
  let nombre = null;
  let correoUsuario = null;
  try {
    const [f] = await (await getPool()).query('SELECT nombre_completo, correo FROM usuarios WHERE id = ?', [req.user.id]);
    nombre = f[0] && f[0].nombre_completo;
    correoUsuario = (f[0] && f[0].correo) || null;
  } catch (e) { /* se usa el username */ }
  return { id: req.user.id, username: req.user.username, nombre: nombre || req.user.username, correo: correoUsuario };
}

function responderError(res, err, contexto) {
  if (err instanceof S.ErrorSoporte) {
    const { codigo, intentosRestantes, esperaSeg, solicitudId, expiraEn } = err;
    return res.status(err.status || 400).json({ error: err.message, codigo, intentosRestantes, esperaSeg, solicitudId, expiraEn });
  }
  console.error(`[soporte-n1] Error en ${contexto}:`, err && err.message);
  return res.status(500).json({ error: 'No se pudo completar la operación de Soporte Nivel 1.' });
}

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const admin = req.user.rol === 'ADMIN_POD';
    const rol = await rolEnModulo(req, 'SOPORTE_N1');
    const [acciones, config, actividad] = await Promise.all([S.estadoAcciones(), S.configPublica({ admin }), S.actividad(15)]);
    res.json({ rol, requiereOtp: rol === ROL_CONSULTA, esAdminPod: admin, acciones, config, actividad });
  } catch (err) { responderError(res, err, 'GET /'); }
});

router.put('/config', soloAdmin, async (req, res) => {
  try {
    const antes = await S.obtenerConfig({ force: true });
    const v = S.validarConfig(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    await S.guardarConfig(v.valor, req.user.id);

    const cambios = [];
    const cmp = (campo, etiqueta, a, b) => { if (String(a ?? '') !== String(b ?? '')) cambios.push({ campo, etiqueta, anterior: String(a ?? '') || '(vacío)', nuevo: String(b ?? '') || '(vacío)' }); };
    cmp('aprobadores', 'Correos aprobadores', antes.aprobadores.join(', '), v.valor.aprobadores.join(', '));
    cmp('vigencia', 'Vigencia del código (min)', antes.vigencia, v.valor.vigencia);
    for (const k of S.CLAVES_ACCION) {
      cmp(`${k}_entorno`, `${S.ACCIONES[k].corto}: entorno`, antes.destinos[k].entorno, v.valor.destinos[k].entorno);
      cmp(`${k}_contenedor`, `${S.ACCIONES[k].corto}: contenedor`, antes.destinos[k].contenedor, v.valor.destinos[k].contenedor);
    }
    await S.auditar(req, { entidadId: 'config', entidadNombre: 'Configuración', accion: 'EDICION', detalle: cambios.length ? 'Configuración de Soporte Nivel 1 actualizada.' : 'Configuración de Soporte Nivel 1 guardada sin cambios.', cambios });
    res.json(await S.configPublica({ admin: true }));
  } catch (err) { responderError(res, err, 'PUT /config'); }
});

router.post('/config/probar-correo', soloAdmin, async (req, res) => {
  try {
    const r = await S.probarCorreo({ usuario: await usuarioActual(req) });
    await S.auditar(req, { entidadId: 'config', entidadNombre: 'Configuración', accion: 'PRUEBA_CORREO', detalle: `Correo de prueba enviado a ${r.enviadoA} aprobador(es).` });
    res.json({ ok: true, mensaje: `Correo de prueba enviado a ${r.enviadoA} aprobador(es).` });
  } catch (err) { responderError(res, err, 'probar-correo'); }
});

// ---------------------------------------------------------------------------
// OTP (solo rol Consulta) y reinicio
// ---------------------------------------------------------------------------
router.post('/:accion/solicitar-otp', async (req, res) => {
  const clave = req.params.accion;
  try {
    if (!S.ACCIONES[clave]) return res.status(404).json({ error: 'Acción de soporte no reconocida.' });
    const rol = await rolEnModulo(req, 'SOPORTE_N1');
    if (rol !== ROL_CONSULTA) return res.status(400).json({ error: 'Con tu rol puedes reiniciar directamente, no necesitas un código.', codigo: 'SIN_OTP' });
    const usuario = await usuarioActual(req);
    const r = await S.solicitarOtp({ clave, usuario, ip: obtenerIp(req) });
    await S.auditar(req, { entidadId: clave, entidadNombre: S.ACCIONES[clave].titulo, accion: 'SOLICITUD_OTP', detalle: `Solicitó código de aprobación para «${S.ACCIONES[clave].titulo}»; enviado a ${r.aprobadores} aprobador(es). Vigencia ${r.vigenciaMin} min.` });
    res.json(r);
  } catch (err) {
    if (err instanceof S.ErrorSoporte && ['SIN_APROBADORES', 'SIN_SMTP', 'ENVIO', 'LIMITE_HORA'].includes(err.codigo)) {
      await S.auditar(req, { entidadId: clave, entidadNombre: S.ACCIONES[clave]?.titulo, accion: 'SOLICITUD_OTP_FALLIDA', detalle: `No se pudo enviar el código para «${S.ACCIONES[clave]?.titulo}»: ${err.message}` });
    }
    responderError(res, err, 'solicitar-otp');
  }
});

router.post('/:accion/reiniciar', async (req, res) => {
  const clave = req.params.accion;
  try {
    if (!S.ACCIONES[clave]) return res.status(404).json({ error: 'Acción de soporte no reconocida.' });
    const titulo = S.ACCIONES[clave].titulo;
    const rol = await rolEnModulo(req, 'SOPORTE_N1');
    if (rol === null) return res.status(403).json({ error: 'No tienes habilitado el módulo SOPORTE_N1.' });

    let via = 'directo';
    if (rol === ROL_CONSULTA) {
      via = 'otp';
      const usuario = await usuarioActual(req);
      try {
        S.consumirOtp({ clave, solicitudId: req.body && req.body.solicitudId, codigo: req.body && req.body.codigo, usuario });
      } catch (err) {
        if (err.auditoria) await S.auditar(req, { entidadId: clave, entidadNombre: titulo, accion: err.auditoria, detalle: `${err.auditoria === 'OTP_INCORRECTA' ? 'Código incorrecto' : err.auditoria === 'OTP_VENCIDA' ? 'Código vencido' : 'Código bloqueado por intentos'} al intentar «${titulo}».` });
        throw err;
      }
    }

    const usuario = await usuarioActual(req);
    let resultado;
    try {
      resultado = await S.reiniciar(clave);
    } catch (err) {
      await S.auditar(req, { entidadId: clave, entidadNombre: titulo, accion: 'REINICIO_FALLIDO', detalle: `Falló «${titulo}» (${via === 'otp' ? 'con código de aprobación' : 'directo'}): ${err.message}` });
      throw err;
    }
    await S.auditar(req, {
      entidadId: clave, entidadNombre: titulo, accion: 'REINICIO',
      detalle: `«${titulo}»: reinició ${resultado.contenedor} en ${resultado.entorno} (${via === 'otp' ? 'con código de aprobación' : 'directo, rol de administración'}). Estado tras el reinicio: ${resultado.arriba ? 'en ejecución' : (resultado.estado || 'sin confirmar')}.`,
    });
    S.avisarReinicio({ clave, usuario, via, resultado });
    res.json({ ok: true, via, ...resultado });
  } catch (err) { responderError(res, err, 'reiniciar'); }
});

module.exports = router;
