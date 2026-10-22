// Consulta del histórico de auditoría de usuarios y accesos
// (UsuariosHistorico): logins exitosos/fallidos, cambios de contraseña,
// ediciones de perfil propio y toda acción de administrador sobre cuentas
// (creación, edición, activar/desactivar, reset de contraseña). Solo
// lectura — la escritura la hacen auth.js y usuarios.js en el momento de
// cada evento.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { verifyToken } = require('../middlewares/authMiddleware');
const { garantizarAuditoriaUsuarios } = require('../utils/usuariosAuditoria');

// Acceso exclusivo de ADMIN_POD, igual que Gestión de Usuarios — mismo
// criterio duplicado localmente que en usuarios.js (no hay un middleware
// compartido de "solo admin" en este proyecto).
const requireAdmin = (req, res, next) => {
  if (req.user && req.user.rol === 'ADMIN_POD') {
    next();
  } else {
    res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
  }
};

// Mismo patrón día/semana/mes/rango usado en informeGeneral.js y en los
// demás informes del aplicativo, para que "Periodo" se comporte igual en
// toda la app.
function calcularRangoPeriodo(periodo, desde, hasta) {
  const ahora = new Date();
  const finDeDia = (fecha) => {
    const f = new Date(fecha);
    f.setHours(23, 59, 59, 999);
    return f;
  };
  const inicioDeDia = (fecha) => {
    const f = new Date(fecha);
    f.setHours(0, 0, 0, 0);
    return f;
  };

  if (periodo === 'dia') {
    return { desde: inicioDeDia(ahora), hasta: finDeDia(ahora) };
  }
  if (periodo === 'semana') {
    const inicio = new Date(ahora);
    const diaSemana = inicio.getDay(); // 0 = domingo
    const diff = diaSemana === 0 ? 6 : diaSemana - 1; // semana inicia en lunes
    inicio.setDate(inicio.getDate() - diff);
    return { desde: inicioDeDia(inicio), hasta: finDeDia(ahora) };
  }
  if (periodo === 'mes') {
    const inicio = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    return { desde: inicioDeDia(inicio), hasta: finDeDia(ahora) };
  }
  // 'rango' u otro valor: usar desde/hasta explícitos si vienen, si no
  // caer de vuelta al día actual.
  if (desde && hasta) {
    return { desde: inicioDeDia(new Date(desde)), hasta: finDeDia(new Date(hasta)) };
  }
  return { desde: inicioDeDia(ahora), hasta: finDeDia(ahora) };
}

// GET /api/auditoria-usuarios
// Query params: periodo=dia|semana|mes|rango, desde, hasta (YYYY-MM-DD),
// usuarioId (filtra por UsuarioId), accion (filtra por Accion exacta).
router.get('/', [verifyToken, requireAdmin], async (req, res) => {
  try {
    const pool = await getPool();
    await garantizarAuditoriaUsuarios(pool);

    const { periodo = 'mes', desde, hasta, usuarioId, accion } = req.query;
    const rango = calcularRangoPeriodo(periodo, desde, hasta);

    const condiciones = ['h.FechaEvento BETWEEN ? AND ?'];
    const parametros = [rango.desde, rango.hasta];

    if (usuarioId) {
      condiciones.push('h.UsuarioId = ?');
      parametros.push(usuarioId);
    }
    if (accion) {
      condiciones.push('h.Accion = ?');
      parametros.push(accion);
    }

    const query = `
      SELECT
        h.Id, h.UsuarioId, h.UsernameIntentado, h.Accion,
        h.NombreCompletoAnterior, h.NombreCompletoNuevo,
        h.RolAnterior, h.RolNuevo,
        h.ModulosAnterior, h.ModulosNuevo,
        h.ActivoAnterior, h.ActivoNuevo,
        h.PasswordCambiada,
        h.RealizadoPorId, h.RealizadoPorUsername,
        h.IP, h.UserAgent, h.Detalle, h.FechaEvento,
        u.nombre_completo AS UsuarioNombreActual
      FROM UsuariosHistorico h
      LEFT JOIN usuarios u ON u.id = h.UsuarioId
      WHERE ${condiciones.join(' AND ')}
      ORDER BY h.FechaEvento DESC
      LIMIT 1000
    `;

    const [eventos] = await pool.query(query, parametros);

    // Lista de usuarios para poblar los filtros del frontend (selector de
    // "usuario" y, en el futuro, chips de acción).
    const [usuarios] = await pool.query('SELECT id, username, nombre_completo FROM usuarios ORDER BY nombre_completo');

    res.json({
      periodo,
      desde: rango.desde,
      hasta: rango.hasta,
      eventos,
      usuarios,
      limitado: eventos.length >= 1000,
    });
  } catch (error) {
    console.error('Error en GET /auditoria-usuarios:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el histórico de auditoría' }) });
  }
});

module.exports = router;
