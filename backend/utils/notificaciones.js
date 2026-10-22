// Notificaciones de la aplicación (campana del encabezado).
// Tabla: notificaciones (ver «crear_tablas_notificaciones_y_comparticion_manuales.sql»).
// Nada se borra: descartar marca Activo = 0. Los recordatorios (tareas por vencer, pasos a
// producción próximos) se generan al consultar la bandeja, como mucho una vez cada 2 minutos por
// persona, y no se repiten gracias a UNIQUE (UsuarioId, ClaveUnica).

const { esErrorDePrivilegios, tablaExiste } = require('./esquemaSeguro');

const OPCIONES = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const DDL = `CREATE TABLE IF NOT EXISTS notificaciones (
  Id INT AUTO_INCREMENT PRIMARY KEY,
  UsuarioId INT NOT NULL,
  Tipo VARCHAR(40) NOT NULL,
  Severidad VARCHAR(10) NOT NULL DEFAULT 'INFO',
  Titulo VARCHAR(200) NOT NULL,
  Mensaje VARCHAR(600) NULL,
  Enlace VARCHAR(255) NULL,
  Referencia INT NULL,
  ClaveUnica VARCHAR(120) NULL,
  Accion VARCHAR(20) NULL,
  Leida TINYINT(1) NOT NULL DEFAULT 0,
  Activo TINYINT(1) NOT NULL DEFAULT 1,
  FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FechaLeida DATETIME NULL,
  UNIQUE KEY uq_notificaciones_clave (UsuarioId, ClaveUnica),
  INDEX idx_notificaciones_usuario (UsuarioId, Activo, Leida, FechaCreacion),
  INDEX idx_notificaciones_ref (Tipo, Referencia)
) ${OPCIONES}`;

const MENSAJE_FALTA_ESQUEMA =
  'Las notificaciones todavía no tienen su tabla en la base de datos. Pídele al administrador de base de datos ' +
  'que ejecute una sola vez el script crear_tablas_notificaciones_y_comparticion_manuales.sql (carpeta «Claude outputs»).';

const SEVERIDADES = new Set(['INFO', 'AVISO', 'ALERTA']);
let listo = false;
let proximoIntento = 0;

async function asegurarEsquemaNotificaciones(pool) {
  if (listo) return { ok: true };
  if (await tablaExiste(pool, 'notificaciones')) { listo = true; return { ok: true }; }
  if (Date.now() < proximoIntento) return { ok: false, mensaje: MENSAJE_FALTA_ESQUEMA };
  try {
    await pool.query(DDL);
    listo = true;
    return { ok: true };
  } catch (err) {
    if (esErrorDePrivilegios(err)) { proximoIntento = Date.now() + 60000; return { ok: false, mensaje: MENSAJE_FALTA_ESQUEMA }; }
    throw err;
  }
}

const recortar = (v, max) => (v === null || v === undefined ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);

/**
 * Crea una notificación (no falla nunca: si la tabla no existe o hay un error, solo se registra en consola).
 * `clave` (opcional) evita repetirla a la misma persona. Devuelve el id creado o null.
 */
async function notificar(pool, { usuarioId, tipo, severidad = 'INFO', titulo, mensaje = null, enlace = null, referencia = null, clave = null, accion = null }) {
  try {
    if (!Number.isInteger(Number(usuarioId)) || Number(usuarioId) <= 0 || !tipo || !titulo) return null;
    const estado = await asegurarEsquemaNotificaciones(pool);
    if (!estado.ok) return null;
    const [r] = await pool.query(
      `INSERT IGNORE INTO notificaciones (UsuarioId, Tipo, Severidad, Titulo, Mensaje, Enlace, Referencia, ClaveUnica, Accion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Number(usuarioId), String(tipo).slice(0, 40), SEVERIDADES.has(severidad) ? severidad : 'INFO', recortar(titulo, 200), recortar(mensaje, 600),
        recortar(enlace, 255), referencia === null || referencia === undefined ? null : Number(referencia), recortar(clave, 120), recortar(accion, 20)]
    );
    return r.insertId || null;
  } catch (error) {
    console.error('No se pudo crear la notificación:', error.message);
    return null;
  }
}

/** Notifica a varias personas (omite a `excluirId`, normalmente quien hizo la acción). */
async function notificarVarios(pool, usuarioIds, datos, excluirId = null) {
  const ids = [...new Set((usuarioIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== Number(excluirId)))];
  for (const id of ids) await notificar(pool, { ...datos, usuarioId: id });
}

const ultimaGeneracion = new Map();
const CADA_MS = 2 * 60 * 1000;
const fechaCorta = (d) => {
  const f = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(f.getDate())}/${p(f.getMonth() + 1)}/${f.getFullYear()} ${p(f.getHours())}:${p(f.getMinutes())}`;
};

async function tablaOk(pool, nombre) {
  try { return await tablaExiste(pool, nombre); } catch { return false; }
}

/**
 * Recordatorios de la persona: tareas vencidas / por vencer y pasos a producción próximos o sin cerrar.
 * También cierra (Activo = 0) los de tareas y pasos que ya no aplican (tarea terminada, paso ejecutado…).
 */
async function generarRecordatorios(pool, usuarioId, forzar = false) {
  const ahora = Date.now();
  if (!forzar && ahora - (ultimaGeneracion.get(usuarioId) || 0) < CADA_MS) return;
  ultimaGeneracion.set(usuarioId, ahora);
  if (ultimaGeneracion.size > 2000) ultimaGeneracion.clear();

  try {
    if (await tablaOk(pool, 'Tareas') && await tablaOk(pool, 'TareaAsignados')) {
      await pool.query(
        `UPDATE notificaciones n JOIN Tareas t ON t.Id = n.Referencia
            SET n.Activo = 0
          WHERE n.UsuarioId = ? AND n.Activo = 1 AND n.Tipo IN ('TAREA_VENCIDA','TAREA_HOY','TAREA_PROXIMA','TAREA_ASIGNADA')
            AND t.Estado IN ('COMPLETADA','CANCELADA')`,
        [usuarioId]
      );
      const [tareas] = await pool.query(
        `SELECT t.Id, t.Titulo, t.FechaLimite, DATEDIFF(DATE(t.FechaLimite), CURDATE()) AS Dias
           FROM Tareas t JOIN TareaAsignados ta ON ta.TareaId = t.Id
          WHERE ta.UsuarioId = ? AND t.Estado IN ('PENDIENTE','EN_PROGRESO') AND t.FechaLimite IS NOT NULL
            AND DATE(t.FechaLimite) <= DATE_ADD(CURDATE(), INTERVAL 2 DAY)`,
        [usuarioId]
      );
      for (const t of tareas) {
        const dias = Number(t.Dias);
        const limite = String(t.FechaLimite instanceof Date ? t.FechaLimite.toISOString().slice(0, 10) : t.FechaLimite).slice(0, 10);
        if (dias < 0) {
          await notificar(pool, { usuarioId, tipo: 'TAREA_VENCIDA', severidad: 'ALERTA', titulo: 'Tarea vencida', referencia: t.Id, enlace: '/tareas', clave: `tarea-vencida-${t.Id}-${limite}`,
            mensaje: `«${t.Titulo}» venció hace ${-dias} día(s) (fecha límite ${limite}).` });
        } else if (dias === 0) {
          await notificar(pool, { usuarioId, tipo: 'TAREA_HOY', severidad: 'AVISO', titulo: 'Una tarea vence hoy', referencia: t.Id, enlace: '/tareas', clave: `tarea-hoy-${t.Id}-${limite}`,
            mensaje: `«${t.Titulo}» vence hoy.` });
        } else {
          await notificar(pool, { usuarioId, tipo: 'TAREA_PROXIMA', severidad: 'INFO', titulo: 'Una tarea vence pronto', referencia: t.Id, enlace: '/tareas', clave: `tarea-prox-${t.Id}-${limite}`,
            mensaje: `«${t.Titulo}» vence en ${dias} día(s) (${limite}).` });
        }
      }
    }
  } catch (error) {
    console.error('Recordatorios de tareas:', error.message);
  }

  try {
    if (await tablaOk(pool, 'PasosProduccion') && await tablaOk(pool, 'PasosProduccionEquipo')) {
      // Un paso eliminado (lógicamente) deja de avisar: se apagan sus avisos y no se generan nuevos.
      const activo = await require('./bitacoraAcceso').sqlActivo(pool, 'p');
      await pool.query(
        `UPDATE notificaciones n JOIN PasosProduccion p ON p.Id = n.Referencia
            SET n.Activo = 0
          WHERE n.UsuarioId = ? AND n.Activo = 1 AND n.Tipo IN ('PASO_PROXIMO','PASO_SIN_CERRAR') AND (p.Estado <> 'PROGRAMADO' OR NOT (${activo}))`,
        [usuarioId]
      );
      const [pasos] = await pool.query(
        `SELECT p.Id, p.Titulo, p.Rfc, p.Entorno, p.FechaHoraProgramada, TIMESTAMPDIFF(MINUTE, NOW(), p.FechaHoraProgramada) AS Min
           FROM PasosProduccion p
          WHERE p.Estado = 'PROGRAMADO' AND ${activo}
            AND p.FechaHoraProgramada <= DATE_ADD(NOW(), INTERVAL 24 HOUR) AND p.FechaHoraProgramada >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            AND (p.CreadoPorId = ? OR EXISTS (SELECT 1 FROM PasosProduccionEquipo e WHERE e.PasoId = p.Id AND e.UsuarioId = ?))`,
        [usuarioId, usuarioId]
      );
      for (const p of pasos) {
        const etiqueta = `${p.Rfc ? `${p.Rfc} · ` : ''}${p.Titulo}`;
        const sello = new Date(p.FechaHoraProgramada).getTime();
        if (Number(p.Min) >= 0) {
          await notificar(pool, { usuarioId, tipo: 'PASO_PROXIMO', severidad: 'AVISO', titulo: 'Paso a producción en las próximas 24 horas', referencia: p.Id, enlace: '/pasos-produccion', clave: `paso-prox-${p.Id}-${sello}`,
            mensaje: `«${etiqueta}» (${p.Entorno || 'sin ambiente'}) está programado para el ${fechaCorta(p.FechaHoraProgramada)}.` });
        } else {
          await notificar(pool, { usuarioId, tipo: 'PASO_SIN_CERRAR', severidad: 'ALERTA', titulo: 'Paso a producción sin cerrar', referencia: p.Id, enlace: '/pasos-produccion', clave: `paso-pend-${p.Id}-${sello}`,
            mensaje: `«${etiqueta}» estaba programado para el ${fechaCorta(p.FechaHoraProgramada)} y sigue en «Programado». Márcalo como ejecutado, reagendado, rollback o cancelado.` });
        }
      }
    }
  } catch (error) {
    console.error('Recordatorios de pasos a producción:', error.message);
  }
}

module.exports = { asegurarEsquemaNotificaciones, notificar, notificarVarios, generarRecordatorios, MENSAJE_FALTA_ESQUEMA };
