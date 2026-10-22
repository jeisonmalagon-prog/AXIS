const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');
const {
  garantizarEsquemaSubaplicativos,
  reconstruirDescripcionServidor,
  asegurarFicha,
} = require('../utils/subaplicativosSchema');

const ETIQUETAS_CAMPOS = {
  AplicacionId: 'Aplicación',
  ServidorId: 'Servidor',
  Componente: 'Sub-aplicativo',
  NombreComun: 'Nombre común',
  EntidadEmisora: 'Entidad emisora',
  NumeroSerie: 'Número de serie',
  Thumbprint: 'Thumbprint',
  Puerto: 'Puerto',
  FechaInicio: 'Fecha de inicio',
  FechaFin: 'Fecha de fin',
  Responsable: 'Responsable',
  Observaciones: 'Observaciones',
  Activo: 'Activo',
};
const CAMPOS_AUDITADOS = Object.keys(ETIQUETAS_CAMPOS);

// mysql2 devuelve las columnas DATE como objetos Date de JS, mientras que
// FechaInicio/FechaFin llegan del formulario como texto "YYYY-MM-DD" — sin
// normalizar esto, diffCampos() los compara con JSON.stringify() y los
// marca como "cambiados" en CADA edición aunque el usuario no haya tocado
// las fechas (un Date y un string nunca son JSON-iguales entre sí).
function aFechaSoloDia(valor) {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  // Ya es texto (ej. "2026-01-01" o "2026-01-01T00:00:00.000Z"): nos
  // quedamos solo con la parte de fecha.
  return String(valor).slice(0, 10);
}


// ¿Existe en la BD el trigger que registra solo el alta en el histórico?
// (consulta information_schema: solo requiere SELECT). Se cachea el "sí";
// el "no" se reconsulta cada minuto.
let triggerAltaConfirmado = false;
let triggerAltaRevisadoEn = 0;
let triggerAltaExiste = false;
async function existeTriggerAlta(pool) {
  if (triggerAltaConfirmado) return true;
  if (Date.now() - triggerAltaRevisadoEn < 60000) return triggerAltaExiste;
  triggerAltaRevisadoEn = Date.now();
  try {
    const [filas] = await pool.query(
      "SELECT 1 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'Certificados' AND EVENT_MANIPULATION = 'INSERT' LIMIT 1"
    );
    triggerAltaExiste = filas.length > 0;
  } catch (e) {
    triggerAltaExiste = false;
  }
  if (triggerAltaExiste) triggerAltaConfirmado = true;
  return triggerAltaExiste;
}

// GET /api/certificados
router.get('/', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query('SELECT * FROM VW_CertificadosVigencia ORDER BY DiasRestantes ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ============================================================
// CATÁLOGO PARA EL ASISTENTE DE CERTIFICADOS
// ------------------------------------------------------------
// Un certificado se instala en una UBICACIÓN = servidor + componente (en el
// Inventario el componente se ve como "Sub-aplicativo"). Las aplicaciones de
// negocio que lo usan se deducen del componente. Este catálogo junta, en una
// sola llamada, lo que el asistente necesita para elegir dónde se instala:
// servidores → componentes → aplicaciones de negocio.
// ============================================================
const TIPOS_COMPONENTE = ['ms', 'api', 'gateway', 'log', 'db', 'job', 'kafka', 'suscriptor', 'orquestador', 'doc', 'balanceador', 'otro'];

router.get('/catalogo/ubicaciones', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [servidores] = await pool.query(
      'SELECT Id, Hostname, IP, Ambiente FROM Servidores WHERE Activo = 1 ORDER BY Hostname'
    );
    const [componentes] = await pool.query(
      'SELECT Id, ServidorId, Rol, Puerto, Tipo FROM Servidor_Componentes ORDER BY Rol'
    );
    const [enlaces] = await pool.query(
      `SELECT ac.ComponenteId, a.Id, a.Nombre
         FROM Aplicacion_Componente ac
         JOIN Aplicaciones a ON a.Id = ac.AplicacionId
        WHERE a.ServidorId IS NULL AND a.Activo = 1
        ORDER BY a.Nombre`
    );
    const [aplicaciones] = await pool.query(
      'SELECT Id, Nombre FROM Aplicaciones WHERE ServidorId IS NULL AND Activo = 1 ORDER BY Nombre'
    );

    const appsPorComponente = new Map();
    for (const e of enlaces) {
      if (!appsPorComponente.has(e.ComponenteId)) appsPorComponente.set(e.ComponenteId, []);
      appsPorComponente.get(e.ComponenteId).push({ id: e.Id, nombre: e.Nombre });
    }
    const compPorServidor = new Map();
    for (const c of componentes) {
      if (!compPorServidor.has(c.ServidorId)) compPorServidor.set(c.ServidorId, []);
      compPorServidor.get(c.ServidorId).push({
        id: c.Id,
        rol: c.Rol,
        puerto: c.Puerto,
        tipo: c.Tipo,
        aplicaciones: appsPorComponente.get(c.Id) || [],
      });
    }

    res.json({
      servidores: servidores.map((s) => ({
        id: s.Id,
        hostname: s.Hostname,
        ip: s.IP,
        ambiente: s.Ambiente,
        componentes: compPorServidor.get(s.Id) || [],
      })),
      aplicaciones: aplicaciones.map((a) => ({ id: a.Id, nombre: a.Nombre })),
      tipos: TIPOS_COMPONENTE,
    });
  } catch (err) {
    console.error('Error al armar el catálogo de ubicaciones:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// POST /api/certificados/catalogo/componentes
// Registra (o reutiliza) un componente dentro de un servidor y, opcionalmente,
// lo asocia a aplicaciones de negocio — es el mismo registro que el Inventario
// llama "Sub-aplicativo", así que lo creado aquí aparece allá (y al revés).
// Solo AGREGA vínculos: nunca quita aplicaciones que ya tuviera el componente.
router.post('/catalogo/componentes', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  const servidorId = Number(req.body.ServidorId ?? req.body.servidorId);
  const rol = String(req.body.Rol ?? req.body.rol ?? '').trim();
  const puertoCrudo = req.body.Puerto ?? req.body.puerto;
  const puerto = puertoCrudo !== undefined && puertoCrudo !== null && puertoCrudo !== '' ? Number(puertoCrudo) : null;
  const tipoCrudo = String(req.body.Tipo ?? req.body.tipo ?? '').trim().toLowerCase();
  const tipo = TIPOS_COMPONENTE.includes(tipoCrudo) ? tipoCrudo : null;
  const idsApps = Array.from(new Set(
    (req.body.AplicacionesIds || req.body.aplicacionesIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  ));
  const componenteIdExistente = Number(req.body.ComponenteId ?? req.body.componenteId) || null;

  if (!Number.isInteger(servidorId) || servidorId <= 0) {
    return res.status(400).json({ error: 'Debes elegir el servidor donde está el sub-aplicativo.' });
  }
  if (!componenteIdExistente && !rol) {
    return res.status(400).json({ error: 'Escribe el nombre del sub-aplicativo.' });
  }
  if (puerto !== null && (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535)) {
    return res.status(400).json({ error: 'El puerto debe ser un número entre 1 y 65535.' });
  }

  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await garantizarEsquemaSubaplicativos(pool);

    const [srv] = await conn.query('SELECT Hostname FROM Servidores WHERE Id = ?', [servidorId]);
    if (!srv.length) return res.status(400).json({ error: 'El servidor elegido no existe.' });

    await conn.beginTransaction();

    let componenteId = componenteIdExistente;
    let nombre = rol;
    let yaExistia = false;

    if (componenteId) {
      const [c] = await conn.query('SELECT Id, Rol FROM Servidor_Componentes WHERE Id = ? AND ServidorId = ?', [componenteId, servidorId]);
      if (!c.length) { await conn.rollback(); return res.status(400).json({ error: 'El sub-aplicativo no pertenece a ese servidor.' }); }
      nombre = c[0].Rol;
      yaExistia = true;
    } else {
      // Mismo criterio que la pantalla de aplicaciones: manda el puerto; si no
      // hay coincidencia, el nombre (sin distinguir mayúsculas).
      let existente = null;
      if (puerto) {
        const [porPuerto] = await conn.query('SELECT Id, Rol FROM Servidor_Componentes WHERE ServidorId = ? AND Puerto = ?', [servidorId, puerto]);
        if (porPuerto.length) existente = porPuerto[0];
      }
      if (!existente) {
        const [porNombre] = await conn.query('SELECT Id, Rol FROM Servidor_Componentes WHERE ServidorId = ? AND LOWER(Rol) = LOWER(?)', [servidorId, rol]);
        if (porNombre.length) existente = porNombre[0];
      }
      if (existente) {
        componenteId = existente.Id;
        nombre = existente.Rol;
        yaExistia = true;
      } else {
        const [ins] = await conn.query(
          'INSERT INTO Servidor_Componentes (ServidorId, Rol, Puerto, Tipo) VALUES (?, ?, ?, ?)',
          [servidorId, rol, puerto, tipo]
        );
        componenteId = ins.insertId;
        await asegurarFicha(conn, componenteId, servidorId, rol);
      }
    }

    if (idsApps.length) {
      const [validas] = await conn.query('SELECT Id FROM Aplicaciones WHERE Id IN (?) AND ServidorId IS NULL', [idsApps]);
      for (const v of validas) {
        await conn.query('INSERT IGNORE INTO Aplicacion_Componente (AplicacionId, ComponenteId) VALUES (?, ?)', [v.Id, componenteId]);
        await reconstruirDescripcionServidor(conn, v.Id, servidorId);
      }
    }

    await conn.commit();

    const [fila] = await pool.query('SELECT Id, ServidorId, Rol, Puerto, Tipo FROM Servidor_Componentes WHERE Id = ?', [componenteId]);
    const [apps] = await pool.query(
      `SELECT a.Id, a.Nombre FROM Aplicacion_Componente ac JOIN Aplicaciones a ON a.Id = ac.AplicacionId
        WHERE ac.ComponenteId = ? AND a.ServidorId IS NULL AND a.Activo = 1 ORDER BY a.Nombre`,
      [componenteId]
    );

    if (!yaExistia || idsApps.length) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'CERTIFICADOS',
        entidad: 'Componente',
        entidadId: componenteId,
        entidadNombre: nombre,
        accion: yaExistia ? 'EDICION' : 'CREACION',
        detalle: yaExistia
          ? `Aplicaciones de negocio asociadas al componente desde el asistente de certificados (${srv[0].Hostname})`
          : `Componente registrado desde el asistente de certificados en ${srv[0].Hostname}${puerto ? ` (puerto ${puerto})` : ''}`,
      });
    }

    res.status(yaExistia ? 200 : 201).json({
      yaExistia,
      componente: {
        id: fila[0].Id,
        rol: fila[0].Rol,
        puerto: fila[0].Puerto,
        tipo: fila[0].Tipo,
        aplicaciones: apps.map((a) => ({ id: a.Id, nombre: a.Nombre })),
      },
    });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* ya cerrada */ }
    console.error('Error al registrar componente desde certificados:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Ya existe un sub-aplicativo con ese nombre o puerto en este servidor.' });
    }
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  } finally {
    conn.release();
  }
});

// GET /api/certificados/:id
router.get('/:id', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query('SELECT * FROM Certificados WHERE Id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Certificado no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// POST /api/certificados - crear
router.post('/', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  // Un certificado ya NO se cuelga de una aplicación puntual: pertenece al
  // servidor + "aplicación interna" (Componente). Si ese componente es
  // compartido por varias aplicaciones (ver módulo Aplicaciones), el MISMO
  // certificado aparece automáticamente en todas ellas — por eso ServidorId
  // y Componente son los campos obligatorios, y AplicacionId queda como
  // dato opcional que solo usan los certificados creados antes de este cambio.
  const aplicacionId = req.body.AplicacionId || req.body.aplicacionId || null;
  const servidorId = req.body.ServidorId ?? req.body.servidorId ?? null;
  const componente = req.body.Componente || req.body.componente || null;
  const nombreComun = req.body.NombreComun || req.body.nombreComun;
  const entidadEmisora = req.body.EntidadEmisora || req.body.entidadEmisora;
  const numeroSerie = req.body.NumeroSerie || req.body.numeroSerie;
  const thumbprint = req.body.Thumbprint || req.body.thumbprint;
  const puerto = req.body.Puerto || req.body.puerto;
  const fechaInicio = req.body.FechaInicio || req.body.fechaInicio;
  const fechaFin = req.body.FechaFin || req.body.fechaFin;
  const responsable = req.body.Responsable || req.body.responsable;
  const observaciones = req.body.Observaciones || req.body.observaciones;

  if (!servidorId || !componente || !fechaInicio || !fechaFin) {
    return res.status(400).json({ error: 'Servidor, sub-aplicativo, fecha inicio y fecha fin son obligatorios' });
  }

  try {
    const pool = await getPool();
    // OJO: no hay ninguna restricción de unicidad sobre (AplicacionId,
    // ServidorId, Componente) a propósito — un mismo componente puede tener
    // varios certificados (ej. vigente + el de renovación ya cargado).
    const [result] = await pool.query(`
        INSERT INTO Certificados
          (AplicacionId, ServidorId, Componente, NombreComun, EntidadEmisora, NumeroSerie, Thumbprint,
           Puerto, FechaInicio, FechaFin, Responsable, Observaciones)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        aplicacionId, servidorId, componente, nombreComun || null, entidadEmisora || null, numeroSerie || null, thumbprint || null,
        puerto || null, fechaInicio, fechaFin, responsable || null, observaciones || null
      ]);

    // Alta en el histórico. En las bases donde existe el trigger
    // TR_Certificados_Insert ya la registra solo; si no existe (producción
    // sincronizada sin triggers) la registra la aplicación para que el
    // histórico no quede sin la carga inicial.
    try {
      if (!(await existeTriggerAlta(pool))) {
        await pool.query(
          `INSERT INTO HistoricoCertificados
             (CertificadoId, Accion, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
           VALUES (?, 'ALTA', ?, ?, ?, 'Carga inicial del certificado')`,
          [result.insertId, fechaInicio, fechaFin, (req.user && req.user.username) || responsable || 'SISTEMA']
        );
      }
    } catch (errHist) {
      console.error('No se pudo registrar el alta en el histórico de certificados:', errHist.message);
    }

    const [rows] = await pool.query('SELECT * FROM Certificados WHERE Id = ?', [result.insertId]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'CERTIFICADOS',
      entidad: 'Certificado',
      entidadId: result.insertId,
      entidadNombre: nombreComun || componente,
      accion: 'CREACION',
      detalle: `Certificado creado (componente: ${componente})`,
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error al crear certificado:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// PUT /api/certificados/:id - actualizar e insertar en histórico
router.put('/:id', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  // Mismo criterio que en el POST: ServidorId + Componente son lo que
  // realmente identifica al certificado; AplicacionId es opcional (legado).
  const aplicacionId = req.body.AplicacionId || req.body.aplicacionId || null;
  const servidorId = req.body.ServidorId ?? req.body.servidorId ?? null;
  const componente = req.body.Componente || req.body.componente || null;
  const nombreComun = req.body.NombreComun || req.body.nombreComun;
  const entidadEmisora = req.body.EntidadEmisora || req.body.entidadEmisora;
  const numeroSerie = req.body.NumeroSerie || req.body.numeroSerie;
  const thumbprint = req.body.Thumbprint || req.body.thumbprint;
  const puerto = req.body.Puerto || req.body.puerto;
  const fechaInicio = req.body.FechaInicio || req.body.fechaInicio;
  const fechaFin = req.body.FechaFin || req.body.fechaFin;
  const responsable = req.body.Responsable || req.body.responsable;
  const observaciones = req.body.Observaciones || req.body.observaciones;

  if (!servidorId || !componente || !fechaInicio || !fechaFin) {
    return res.status(400).json({ error: 'Servidor, sub-aplicativo, fecha inicio y fecha fin son obligatorios' });
  }

  const rawActivo = req.body.Activo !== undefined ? req.body.Activo : req.body.activo;
  const estadoActivo = rawActivo !== undefined ? (rawActivo ? 1 : 0) : 1;

  try {
    const pool = await getPool();
    const id = req.params.id;

    // Estado ANTES del cambio, para el diff de auditoría general (no se usa
    // para HistoricoCertificados, que sigue exactamente igual que antes).
    const [certificadosAntes] = await pool.query('SELECT * FROM Certificados WHERE Id = ?', [id]);
    if (!certificadosAntes.length) return res.status(404).json({ error: 'Certificado no encontrado' });
    const antes = certificadosAntes[0];

    // Qué cambió (se usa para el histórico y para la auditoría general).
    const cambios = diffCampos(
      { ...antes, FechaInicio: aFechaSoloDia(antes.FechaInicio), FechaFin: aFechaSoloDia(antes.FechaFin) },
      {
        AplicacionId: aplicacionId, ServidorId: servidorId, Componente: componente,
        NombreComun: nombreComun || null, EntidadEmisora: entidadEmisora || null, NumeroSerie: numeroSerie || null,
        Thumbprint: thumbprint || null, Puerto: puerto || null,
        FechaInicio: aFechaSoloDia(fechaInicio), FechaFin: aFechaSoloDia(fechaFin),
        Responsable: responsable || null, Observaciones: observaciones || null, Activo: estadoActivo,
      },
      CAMPOS_AUDITADOS,
      ETIQUETAS_CAMPOS
    );

    // 1. INSERCIÓN EN HISTÓRICO: cualquier cambio queda registrado (no solo
    // las fechas), con quién lo hizo y qué campos se modificaron. Antes se
    // guardaba el "responsable" del certificado como autor, que no es quien
    // hizo el ajuste.
    const usuarioAudit = (req.user && req.user.username) || responsable || 'SISTEMA';
    const resumenCambios = cambios.length
      ? `Campos modificados: ${cambios.map((c) => c.etiqueta || c.campo).join(', ')}`.slice(0, 500)
      : null;

    if (cambios.length) {
      await pool.query(`
        INSERT INTO HistoricoCertificados
          (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
        SELECT
          Id,
          'ACTUALIZACIÓN',
          FechaInicio,
          FechaFin,
          ?,
          ?,
          ?,
          ?
        FROM Certificados WHERE Id = ?
      `, [fechaInicio, fechaFin, usuarioAudit, resumenCambios, id]);
    }

    // 2. ACTUALIZACIÓN DEL CERTIFICADO
    const [result] = await pool.query(`
        UPDATE Certificados
        SET AplicacionId = ?, ServidorId = ?, Componente = ?, NombreComun = ?, EntidadEmisora = ?, NumeroSerie = ?,
            Thumbprint = ?, Puerto = ?, FechaInicio = ?, FechaFin = ?,
            Responsable = ?, Observaciones = ?, Activo = ?
        WHERE Id = ?
      `, [
        aplicacionId, servidorId, componente, nombreComun || null, entidadEmisora || null, numeroSerie || null,
        thumbprint || null, puerto || null, fechaInicio, fechaFin,
        responsable || null, observaciones || null, estadoActivo, id
      ]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Certificado no encontrado' });

    const [rows] = await pool.query('SELECT * FROM Certificados WHERE Id = ?', [id]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'CERTIFICADOS',
      entidad: 'Certificado',
      entidadId: id,
      entidadNombre: nombreComun || componente,
      accion: 'EDICION',
      cambios,
    });

    res.json(rows[0]);
  } catch (err) {
    console.error('Error al actualizar y guardar histórico:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// DELETE /api/certificados/:id - Borrado físico definitivo
router.delete('/:id', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [certificadosAntes] = await pool.query('SELECT * FROM Certificados WHERE Id = ?', [req.params.id]);
    const certificadoBorrado = certificadosAntes[0] || null;

    // 1. Primero borramos los históricos para que no haya conflicto de llaves foráneas
    await pool.query('DELETE FROM HistoricoCertificados WHERE CertificadoId = ?', [req.params.id]);
    // 2. Luego borramos el certificado
    await pool.query('DELETE FROM Certificados WHERE Id = ?', [req.params.id]);

    if (certificadoBorrado) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'CERTIFICADOS',
        entidad: 'Certificado',
        entidadId: req.params.id,
        entidadNombre: certificadoBorrado.NombreComun || certificadoBorrado.Componente,
        accion: 'ELIMINACION',
        detalle: `Certificado eliminado (componente: ${certificadoBorrado.Componente || '—'})`,
      });
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

module.exports = router;
