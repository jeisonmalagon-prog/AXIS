// Consulta de la auditoría GENERAL del aplicativo (tabla AuditoriaGeneral):
// creación/edición/eliminación de certificados, servidores, aplicaciones,
// servicios ACE, esquemas, apuntamientos, alias/visibilidad del balanceador
// F5, y acciones operativas (contenedores Docker, workflows de n8n). Mismo
// criterio que auditoriaUsuarios.js (solo lectura, acceso ADMIN_POD, mismo
// patrón de periodo/rango) pero sobre esta tabla, y con un filtro adicional
// por Módulo.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { verifyToken } = require('../middlewares/authMiddleware');
const { garantizarTablaAuditoriaGeneral } = require('../utils/auditoriaGeneral');

// Acceso exclusivo de ADMIN_POD — copia local a propósito, mismo criterio
// que auditoriaUsuarios.js (no hay un middleware compartido de "solo admin"
// en este proyecto).
const requireAdmin = (req, res, next) => {
  if (req.user && req.user.rol === 'ADMIN_POD') {
    next();
  } else {
    res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
  }
};

// Mismo patrón día/semana/mes/rango usado en auditoriaUsuarios.js e
// informeGeneral.js, para que "Periodo" se comporte igual en toda la app.
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

// GET /api/auditoria-general
// Query params: periodo=dia|semana|mes|rango, desde, hasta (YYYY-MM-DD),
// modulo (filtra por Modulo exacto), accion (filtra por Accion exacta),
// usuario (filtra por RealizadoPorUsername exacto),
// rol=consulta (solo lo hecho con rol Consulta: esos eventos llevan el cambio `rolModulo`, ver
// utils/auditoriaConsulta.js).
router.get('/', [verifyToken, requireAdmin], async (req, res) => {
  try {
    const pool = await getPool();
    await garantizarTablaAuditoriaGeneral(pool);

    const { periodo = 'mes', desde, hasta, modulo, accion, usuario, rol } = req.query;
    const rango = calcularRangoPeriodo(periodo, desde, hasta);

    const condiciones = ['g.FechaEvento BETWEEN ? AND ?'];
    const parametros = [rango.desde, rango.hasta];

    if (modulo) {
      condiciones.push('g.Modulo = ?');
      parametros.push(modulo);
    }
    if (accion) {
      condiciones.push('g.Accion = ?');
      parametros.push(accion);
    }
    if (usuario) {
      condiciones.push('g.RealizadoPorUsername = ?');
      parametros.push(usuario);
    }
    if (String(rol || '').toLowerCase() === 'consulta') {
      condiciones.push("g.CambiosJson LIKE '%\"campo\":\"rolModulo\"%'");
    }

    const query = `
      SELECT
        g.Id, g.Modulo, g.Entidad, g.EntidadId, g.EntidadNombre, g.Accion,
        g.Detalle, g.CambiosJson,
        g.RealizadoPorId, g.RealizadoPorUsername,
        g.IP, g.UserAgent, g.FechaEvento
      FROM AuditoriaGeneral g
      WHERE ${condiciones.join(' AND ')}
      ORDER BY g.FechaEvento DESC
      LIMIT 1000
    `;

    const [filas] = await pool.query(query, parametros);

    // El frontend espera los cambios ya como array (no como texto JSON
    // crudo) — mismo criterio que resumenCambio() en Auditoría de Usuarios,
    // que trabaja con datos ya "listos para mostrar".
    const eventos = filas.map((fila) => {
      let cambios = [];
      if (fila.CambiosJson) {
        try {
          cambios = JSON.parse(fila.CambiosJson);
        } catch (e) {
          cambios = [];
        }
      }
      const { CambiosJson, ...resto } = fila;
      return { ...resto, cambios };
    });

    // Listas para poblar los filtros del frontend.
    const [usuarios] = await pool.query(
      `SELECT DISTINCT RealizadoPorUsername AS username
       FROM AuditoriaGeneral
       WHERE RealizadoPorUsername IS NOT NULL
       ORDER BY username`
    );

    res.json({
      periodo,
      desde: rango.desde,
      hasta: rango.hasta,
      eventos,
      usuarios: usuarios.map((u) => u.username),
      limitado: eventos.length >= 1000,
    });
  } catch (error) {
    console.error('Error en GET /auditoria-general:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el histórico de auditoría general' }) });
  }
});

module.exports = router;
