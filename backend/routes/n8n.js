const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const {
  ID_PRINCIPAL, NOMBRE_PRINCIPAL, listarCuentasAdmin, cuentasParaConsulta, obtenerCuenta,
  crearCuenta, filaCuenta, actualizarCuenta, quitarCuenta,
} = require('../utils/n8nCuentas');
const {
  fetchN8n, mensajeErrorN8n, recolectarCuenta, invalidarCache, obtenerFlujo, obtenerEjecucionConDatos,
} = require('../utils/n8nCliente');
const { calcular, detalleDeFlujo, errorDeEjecucion, normalizarEjecucion } = require('../utils/n8nEstadisticas');
const {
  ID_VALIDO, modoEstricto, flujosPermitidos, puedeVer, usuariosAsignables, asignacionesVigentes, conteoPorFlujo, guardarAsignacion,
} = require('../utils/n8nPermisos');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Cuenta principal (la de siempre). Puede sobrescribirse con N8N_API_KEY en el .env;
// las demás cuentas las administra el ADMIN_POD desde la pantalla (utils/n8nCuentas.js).
const N8N_API_KEY = process.env.N8N_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjMjkxZjQyZi1lZDU4LTQxMmQtOTliMS1hNjI3MDJmZDIwMTQiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiN2U1NTdhNzYtOTRmYi00YjBlLWIwYjEtOWJiMmRlZjhhOTlkIiwiaWF0IjoxNzg4NDY1NTAxfQ.UQvPp-YPH8a2R4oQ7iCMBQws82LJPPNxDrj-2mlGqVM';

// Igual que certificados.js/servidores.js, este router no tenía NINGÚN
// verifyToken antes — quedaba público sin sesión. Se cierra ese hueco aquí:
// el interceptor del frontend (auth.interceptor.ts) ya manda el JWT en TODAS
// las peticiones, así que esto es transparente para la app.
router.use(verifyToken, requireModule('ORQUESTADOR_N8N'));

const esAdminPod = (req) => req.user?.rol === 'ADMIN_POD';

const soloAdminPod = (req, res, next) => {
  if (esAdminPod(req)) return next();
  res.status(403).json({ error: 'Solo el ADMIN_POD puede administrar esto.' });
};

// ---------------------------------------------------------------------------
// Recolección: junta los flujos y ejecuciones de todas las cuentas activas.
// ---------------------------------------------------------------------------

function periodoDe(req) {
  const dias = Math.min(90, Math.max(1, parseInt(req.query.dias, 10) || 7));
  const tzCrudo = parseInt(req.query.tz, 10);
  // desfase del navegador en minutos (Date.getTimezoneOffset); límites reales: -840..+720
  const tz = Number.isFinite(tzCrudo) && tzCrudo >= -840 && tzCrudo <= 840 ? tzCrudo : 0;
  return { dias, tz };
}

// Si dos cuentas ven el mismo flujo (p. ej. una key de administrador de n8n ve
// todo) cuenta solo la primera.
async function consultarTodasLasCuentas(pool, dias) {
  const { cuentas, avisos } = await cuentasParaConsulta(pool, N8N_API_KEY);
  const resultados = await Promise.all(cuentas.map((c) => recolectarCuenta(c, dias)));

  const flujos = new Map();
  const ejecs = new Map();
  const estadoCuentas = [];
  let truncado = false;
  const avisosEjecuciones = [];
  for (const r of resultados) {
    let nuevos = 0;
    for (const wf of r.workflows) {
      if (flujos.has(wf.id)) continue;
      flujos.set(wf.id, { wf, cuenta: r.cuenta });
      nuevos++;
    }
    for (const e of r.ejecuciones) if (!ejecs.has(e.id)) ejecs.set(e.id, e);
    truncado = truncado || r.truncado;
    if (r.avisoEjecuciones) avisosEjecuciones.push(`${r.cuenta.nombre}: ${r.avisoEjecuciones}`);
    estadoCuentas.push({ id: r.cuenta.id, nombre: r.cuenta.nombre, sistema: !!r.cuenta.sistema, ok: !r.error, error: r.error, totalFlujos: nuevos });
  }
  for (const a of avisos) estadoCuentas.push({ id: a.id, nombre: a.nombre, sistema: false, ok: false, error: a.error, totalFlujos: 0 });

  return { flujos: [...flujos.values()], ejecuciones: [...ejecs.values()], cuentas: estadoCuentas, truncado, avisosEjecuciones };
}

// Un usuario sin permiso sobre un flujo lo ve igual que si no existiera.
const filtrarPermitidos = (flujos, permitidos) => (permitidos === null ? flujos : flujos.filter(({ wf }) => puedeVer(permitidos, wf.id)));

// ---------------------------------------------------------------------------
// 1. Panel: estadísticas completas
// ---------------------------------------------------------------------------
router.get('/analytics', async (req, res) => {
  try {
    const pool = await getPool();
    const { dias, tz } = periodoDe(req);
    const permitidos = await flujosPermitidos(pool, req.user);
    const recolectado = await consultarTodasLasCuentas(pool, dias);

    // Si NINGUNA cuenta respondió, es una falla real (igual que antes).
    if (recolectado.cuentas.length && recolectado.cuentas.every((c) => !c.ok)) {
      throw new Error(recolectado.cuentas[0].error || 'No se pudo consultar n8n.');
    }

    const visibles = filtrarPermitidos(recolectado.flujos, permitidos);
    const est = calcular({ flujos: visibles, ejecuciones: recolectado.ejecuciones, dias, tz });

    const admin = esAdminPod(req);
    const estricto = await modoEstricto(pool);
    let conteo = {};
    if (admin && estricto) {
      try { conteo = await conteoPorFlujo(pool); } catch (e) { console.error('n8n: no se pudo contar accesos:', e.message); }
    }
    const flujos = est.flujos.map((f) => (admin && estricto ? { ...f, usuariosConAcceso: conteo[f.id] || 0 } : f));

    // Un usuario normal solo ve las cuentas de las que tiene algún flujo.
    const cuentasConFlujo = new Set(flujos.map((f) => f.cuentaId));
    const cuentas = admin ? recolectado.cuentas : recolectado.cuentas.filter((c) => cuentasConFlujo.has(c.id)).map((c) => ({ ...c, totalFlujos: flujos.filter((f) => f.cuentaId === c.id).length }));

    const g = est.global;
    res.json({
      // --- Claves históricas (las usaba la pantalla anterior) ---
      resumen: {
        totales: g.flujosTotal,
        activos: g.activos,
        detenidos: g.detenidos,
        ejecucionesTotales: g.ejecuciones,
        ejecucionesExitosas: g.exitosas,
        ejecucionesFallidas: g.fallidas,
      },
      cuentas,
      workflows: flujos,
      // --- Estadísticas ampliadas ---
      periodo: est.periodo,
      global: g,
      serie: est.serie,
      porHora: est.porHora,
      mapaCalor: est.mapaCalor,
      porModo: est.porModo,
      porCuenta: est.porCuenta,
      porEtiqueta: est.porEtiqueta,
      atencion: est.atencion,
      recientes: est.recientes,
      cobertura: {
        ...est.cobertura,
        truncado: recolectado.truncado,
        avisos: admin ? recolectado.avisosEjecuciones : [],
      },
      acceso: {
        esAdmin: admin,
        estricto, // true = cada usuario ve solo los flujos que se le asignaron
        restringido: permitidos !== null,
        sinAsignar: admin && estricto ? flujos.filter((f) => !f.usuariosConAcceso).length : null,
      },
    });
  } catch (err) {
    console.error('Error en analíticas n8n:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2. Detalle de un flujo
// ---------------------------------------------------------------------------
router.get('/workflows/:id/detalle', async (req, res) => {
  try {
    const pool = await getPool();
    const { dias, tz } = periodoDe(req);
    const id = String(req.params.id);
    const permitidos = await flujosPermitidos(pool, req.user);
    // Mismo mensaje exista o no el flujo: no se revela que existe.
    if (!puedeVer(permitidos, id)) return res.status(404).json({ error: 'Flujo no encontrado.' });

    const recolectado = await consultarTodasLasCuentas(pool, dias);
    const item = recolectado.flujos.find(({ wf }) => String(wf.id) === id);
    if (!item) return res.status(404).json({ error: 'Flujo no encontrado.' });

    const completo = await obtenerFlujo(item.cuenta, id).catch(() => null);
    const propias = recolectado.ejecuciones.filter((e) => String(e.workflowId) === id);
    const detalle = detalleDeFlujo({ wf: item.wf, cuenta: item.cuenta, wfCompleto: completo, ejecuciones: propias, dias, tz });

    // Últimos fallos con su mensaje de error (se leen aparte: pesan más).
    const fallos = propias.map(normalizarEjecucion).filter((e) => e.grupo === 'fallida').sort((a, b) => b.inicio - a.inicio).slice(0, 5);
    const errores = (await Promise.all(fallos.map(async (f) => {
      const ejec = await obtenerEjecucionConDatos(item.cuenta, f.id);
      const err = ejec ? errorDeEjecucion(ejec) : null;
      return { ejecucionId: f.id, fecha: new Date(f.inicio).toISOString(), estado: f.status, nodo: err?.nodo || null, mensaje: err?.mensaje || null };
    })));

    res.json({ ...detalle, errores, truncado: recolectado.truncado });
  } catch (err) {
    console.error('Error en el detalle de flujo n8n:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 3. Encender / apagar
// ---------------------------------------------------------------------------

// Enciende/apaga un flujo con la key de la cuenta que lo ve.
async function cambiarEstadoFlujo(cuenta, id, activar, nombreConocido) {
  const accion = activar ? 'activate' : 'deactivate';

  // Se intenta traer el nombre del workflow solo para que la auditoría
  // quede legible (si esto falla, se audita igual usando el id).
  let nombreWorkflow = nombreConocido || `Workflow ${id}`;
  if (!nombreConocido) {
    try {
      const resWf = await fetchN8n(cuenta, `/workflows/${encodeURIComponent(id)}`);
      if (resWf.ok) {
        const dataWf = await resWf.json();
        if (dataWf?.name) nombreWorkflow = dataWf.name;
      }
    } catch (errNombre) {
      console.error('No se pudo obtener el nombre del workflow n8n para auditoría:', errNombre);
    }
  }

  const response = await fetchN8n(cuenta, `/workflows/${encodeURIComponent(id)}/${accion}`, { method: 'POST' });
  if (!response.ok) throw new Error(`Error al ejecutar ${accion}`);
  invalidarCache();
  return nombreWorkflow;
}

async function auditarFlujo(pool, req, cuenta, id, nombreWorkflow, activar) {
  try {
    const propietario = cuenta.id === ID_PRINCIPAL ? '' : ` (cuenta ${cuenta.nombre})`;
    await registrarEventoGeneral(pool, req, {
      modulo: 'ORQUESTADOR_N8N',
      entidad: 'Workflow n8n',
      entidadId: id,
      entidadNombre: nombreWorkflow,
      accion: activar ? 'HABILITACION' : 'DESHABILITACION',
      detalle: `Workflow ${activar ? 'activado' : 'desactivado'}: ${nombreWorkflow}${propietario}`,
    });
  } catch (errAudit) {
    console.error('No se pudo registrar la auditoría del toggle de n8n:', errAudit);
  }
}

router.post('/workflows/:id/toggle', requireEditPermission, async (req, res) => {
  const { id } = req.params;
  const { activar, cuentaId } = req.body;
  try {
    const pool = await getPool();
    // Tener rol de edición no basta: además hay que tener acceso a ESE flujo.
    const permitidos = await flujosPermitidos(pool, req.user);
    if (!puedeVer(permitidos, id)) return res.status(403).json({ error: 'No tienes acceso a este flujo.' });

    const cuenta = await obtenerCuenta(pool, cuentaId, N8N_API_KEY);
    if (!cuenta) return res.status(404).json({ error: 'La cuenta de n8n de este flujo ya no está disponible.' });

    const nombre = await cambiarEstadoFlujo(cuenta, id, !!activar);
    await auditarFlujo(pool, req, cuenta, id, nombre, !!activar);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Encender / apagar todos (opcionalmente solo los de una cuenta). Solo actúa
// sobre los flujos a los que el usuario tiene acceso.
router.post('/workflows/bulk-toggle', requireEditPermission, async (req, res) => {
  const activar = !!req.body?.activar;
  const cuentaId = req.body?.cuentaId ? String(req.body.cuentaId) : null;
  try {
    const pool = await getPool();
    const permitidos = await flujosPermitidos(pool, req.user);
    const { flujos } = await consultarTodasLasCuentas(pool, 1);
    const objetivo = filtrarPermitidos(flujos, permitidos)
      .filter(({ wf, cuenta }) => !!wf.active !== activar && (!cuentaId || cuenta.id === cuentaId));

    let cambiados = 0;
    let fallidos = 0;
    const cola = [...objetivo];
    const trabajador = async () => {
      while (cola.length) {
        const { wf, cuenta } = cola.shift();
        try {
          await cambiarEstadoFlujo(cuenta, wf.id, activar, wf.name);
          cambiados++;
        } catch (err) {
          fallidos++;
          console.error(`bulk-toggle n8n: falló ${wf.id}:`, err.message);
        }
      }
    };
    await Promise.all([trabajador(), trabajador(), trabajador(), trabajador()]);

    try {
      const alcance = cuentaId ? ` de la cuenta ${(await obtenerCuenta(pool, cuentaId, N8N_API_KEY))?.nombre || cuentaId}` : '';
      await registrarEventoGeneral(pool, req, {
        modulo: 'ORQUESTADOR_N8N',
        entidad: 'Workflow n8n',
        entidadId: null,
        entidadNombre: `${cambiados} workflows`,
        accion: activar ? 'HABILITACION' : 'DESHABILITACION',
        detalle: `${activar ? 'Activación' : 'Desactivación'} masiva${alcance}: ${cambiados} workflows${fallidos ? `, ${fallidos} con error` : ''}`,
      });
    } catch (errAudit) {
      console.error('No se pudo registrar la auditoría de la acción masiva de n8n:', errAudit);
    }

    if (fallidos && !cambiados) return res.status(502).json({ error: 'No se pudo cambiar ningún workflow.', cambiados, fallidos });
    res.json({ ok: true, cambiados, fallidos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 4. ACCESOS: qué flujos ve cada usuario de AXIS (solo ADMIN_POD)
// ---------------------------------------------------------------------------

router.get('/accesos', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const estricto = await modoEstricto(pool);
    const { flujos, cuentas } = await consultarTodasLasCuentas(pool, 1);
    const listaFlujos = flujos
      .map(({ wf, cuenta }) => ({
        id: String(wf.id),
        nombre: wf.name,
        activo: !!wf.active,
        cuentaId: cuenta.id,
        cuentaNombre: cuenta.nombre,
        etiquetas: (wf.tags || []).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean),
      }))
      .sort((a, b) => a.cuentaNombre.localeCompare(b.cuentaNombre) || String(a.nombre).localeCompare(String(b.nombre)));

    if (!estricto) {
      return res.json({ estricto: false, usuarios: [], flujos: listaFlujos, asignaciones: {}, conteo: {}, cuentasConError: cuentas.filter((c) => !c.ok) });
    }
    const [usuarios, asignaciones, conteo] = await Promise.all([usuariosAsignables(pool), asignacionesVigentes(pool), conteoPorFlujo(pool)]);
    res.json({ estricto: true, usuarios, flujos: listaFlujos, asignaciones, conteo, cuentasConError: cuentas.filter((c) => !c.ok) });
  } catch (err) {
    console.error('Error en accesos n8n:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/accesos/usuarios/:usuarioId', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await modoEstricto(pool))) {
      return res.status(503).json({ error: 'Falta crear la tabla de permisos. Ejecuta una sola vez el script crear_tabla_n8n_permisos.sql.' });
    }
    const usuarioId = parseInt(req.params.usuarioId, 10);
    const usuarios = await usuariosAsignables(pool);
    const usuario = usuarios.find((u) => u.id === usuarioId);
    if (!usuario) return res.status(404).json({ error: 'El usuario no existe, está inactivo o es ADMIN_POD (que ve todo).' });

    const pedidos = req.body?.flujos;
    if (!Array.isArray(pedidos) || pedidos.length > 5000 || pedidos.some((id) => typeof id !== 'string' || !ID_VALIDO.test(id))) {
      return res.status(400).json({ error: 'La lista de flujos no es válida.' });
    }

    const { flujos } = await consultarTodasLasCuentas(pool, 1);
    const conocidos = new Map(flujos.map(({ wf }) => [String(wf.id), wf.name]));
    const vigentes = (await asignacionesVigentes(pool))[usuarioId] || [];
    // Solo se tocan los flujos que hoy existen en n8n: una asignación a un flujo
    // que no aparece (cuenta caída, flujo borrado) se conserva tal cual.
    const finales = [...new Set([...pedidos.filter((id) => conocidos.has(id)), ...vigentes.filter((id) => !conocidos.has(id))])];
    const nombres = Object.fromEntries(conocidos);

    const { agregados, quitados } = await guardarAsignacion(pool, req, usuarioId, finales, nombres);

    if (agregados.length || quitados.length) {
      const lista = (ids) => ids.slice(0, 5).map((id) => nombres[id] || id).join(', ') + (ids.length > 5 ? `… (+${ids.length - 5})` : '');
      const partes = [];
      if (agregados.length) partes.push(`+${agregados.length}: ${lista(agregados)}`);
      if (quitados.length) partes.push(`-${quitados.length}: ${lista(quitados)}`);
      try {
        await registrarEventoGeneral(pool, req, {
          modulo: 'ORQUESTADOR_N8N',
          entidad: 'Acceso a flujos de n8n',
          entidadId: usuarioId,
          entidadNombre: usuario.username,
          accion: 'EDICION',
          detalle: `Accesos de ${usuario.username} (${finales.length} flujos): ${partes.join(' | ')}`.slice(0, 500),
          cambios: [{ campo: 'flujos', etiqueta: 'Flujos con acceso', anterior: String(vigentes.length), nuevo: String(finales.length) }],
        });
      } catch (errAudit) {
        console.error('No se pudo registrar la auditoría de accesos n8n:', errAudit);
      }
    }
    res.json({ ok: true, agregados: agregados.length, quitados: quitados.length, total: finales.length });
  } catch (err) {
    console.error('Error guardando accesos n8n:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ADMINISTRACIÓN DE API KEYS (solo ADMIN_POD)
// ---------------------------------------------------------------------------

// Normaliza lo que el admin pega: sin espacios y sin el prefijo "Bearer ".
function limpiarApiKey(valor) {
  return String(valor ?? '').trim().replace(/^bearer\s+/i, '').replace(/\s+/g, '');
}

function validarNombre(valor) {
  const nombre = String(valor ?? '').trim();
  if (!nombre) return { error: 'El nombre es obligatorio.' };
  if (nombre.length > 100) return { error: 'El nombre no puede pasar de 100 caracteres.' };
  return { nombre };
}

function validarFormatoApiKey(apiKey) {
  if (apiKey.length < 20) return 'La API key es demasiado corta.';
  if (apiKey.length > 2000) return 'La API key es demasiado larga.';
  if (!/^[\x21-\x7e]+$/.test(apiKey)) return 'La API key tiene caracteres no válidos.';
  return null;
}

// Prueba la key contra n8n antes de guardarla.
async function probarApiKey(apiKey) {
  try {
    const r = await fetchN8n({ apiKey }, '/workflows?limit=1');
    if (!r.ok) return { ok: false, error: mensajeErrorN8n(null, r.status) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: mensajeErrorN8n(err) };
  }
}

async function nombreRepetido(pool, nombre, exceptoId = null) {
  if (nombre.toLowerCase() === NOMBRE_PRINCIPAL.toLowerCase()) return true;
  const { cuentas } = await listarCuentasAdmin(pool);
  return cuentas.some((c) => c.nombre.toLowerCase() === nombre.toLowerCase() && c.id !== String(exceptoId));
}

async function auditarCuenta(pool, req, accion, id, nombre, detalle) {
  try {
    await registrarEventoGeneral(pool, req, {
      modulo: 'ORQUESTADOR_N8N',
      entidad: 'API key de n8n',
      entidadId: id,
      entidadNombre: nombre,
      accion,
      detalle, // nunca incluye la key
    });
  } catch (errAudit) {
    console.error('No se pudo registrar la auditoría de la API key de n8n:', errAudit);
  }
}

function responderError(res, err) {
  console.error('Error en cuentas n8n:', err);
  res.status(err.causa === 'n8n_cuentas' ? 503 : 500).json({ error: err.message });
}

router.get('/cuentas', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const { tabla, cuentas } = await listarCuentasAdmin(pool);
    res.json({
      tabla, // false = falta ejecutar el script SQL
      principal: { id: ID_PRINCIPAL, nombre: NOMBRE_PRINCIPAL, sistema: true, activo: true },
      cuentas,
    });
  } catch (err) {
    responderError(res, err);
  }
});

router.post('/cuentas', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const v = validarNombre(req.body?.nombre);
    if (v.error) return res.status(400).json({ error: v.error });
    const apiKey = limpiarApiKey(req.body?.apiKey);
    const errFormato = validarFormatoApiKey(apiKey);
    if (errFormato) return res.status(400).json({ error: errFormato });
    if (await nombreRepetido(pool, v.nombre)) return res.status(409).json({ error: 'Ya existe una cuenta con ese nombre.' });

    const prueba = await probarApiKey(apiKey);
    if (!prueba.ok) return res.status(400).json({ error: `No se guardó: ${prueba.error}` });

    const id = await crearCuenta(pool, req, { nombre: v.nombre, apiKey });
    invalidarCache();
    await auditarCuenta(pool, req, 'CREACION', id, v.nombre, `API key de n8n agregada: ${v.nombre} (termina en ${apiKey.slice(-4)})`);
    res.status(201).json({ ok: true, id });
  } catch (err) {
    responderError(res, err);
  }
});

router.put('/cuentas/:id', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const actual = await filaCuenta(pool, req.params.id);
    if (!actual) return res.status(404).json({ error: 'La cuenta no existe.' });

    const cambios = {};
    const acciones = [];
    if (req.body?.nombre !== undefined) {
      const v = validarNombre(req.body.nombre);
      if (v.error) return res.status(400).json({ error: v.error });
      if (v.nombre !== actual.Nombre) {
        if (await nombreRepetido(pool, v.nombre, actual.Id)) return res.status(409).json({ error: 'Ya existe una cuenta con ese nombre.' });
        cambios.nombre = v.nombre;
        acciones.push({ accion: 'EDICION', detalle: `Cuenta n8n renombrada de ${actual.Nombre} a ${v.nombre}` });
      }
    }
    if (req.body?.apiKey !== undefined && String(req.body.apiKey).trim() !== '') {
      const apiKey = limpiarApiKey(req.body.apiKey);
      const errFormato = validarFormatoApiKey(apiKey);
      if (errFormato) return res.status(400).json({ error: errFormato });
      const prueba = await probarApiKey(apiKey);
      if (!prueba.ok) return res.status(400).json({ error: `No se guardó: ${prueba.error}` });
      cambios.apiKey = apiKey;
      acciones.push({ accion: 'EDICION', detalle: `API key reemplazada (ahora termina en ${apiKey.slice(-4)})` });
    }
    if (req.body?.activo !== undefined) {
      const activo = !!req.body.activo;
      if (activo !== !!actual.Activo) {
        cambios.activo = activo;
        acciones.push({ accion: activo ? 'HABILITACION' : 'DESHABILITACION', detalle: `Cuenta n8n ${activo ? 'habilitada' : 'deshabilitada'}` });
      }
    }

    if (!acciones.length) return res.json({ ok: true, sinCambios: true });
    await actualizarCuenta(pool, actual.Id, cambios);
    invalidarCache();
    const nombre = cambios.nombre || actual.Nombre;
    for (const a of acciones) await auditarCuenta(pool, req, a.accion, String(actual.Id), nombre, `${a.detalle} — ${nombre}`);
    res.json({ ok: true });
  } catch (err) {
    responderError(res, err);
  }
});

router.post('/cuentas/:id/probar', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const cuenta = await obtenerCuenta(pool, req.params.id, N8N_API_KEY);
    if (!cuenta) return res.status(404).json({ error: 'La cuenta no existe o su API key no se puede leer.' });
    const r = await recolectarCuenta(cuenta, 1);
    if (r.error) return res.json({ ok: false, error: r.error });
    res.json({ ok: true, totalFlujos: r.workflows.length });
  } catch (err) {
    responderError(res, err);
  }
});

// "Quitar" no borra la fila (el usuario de BD no tiene DELETE): la marca y
// borra la key guardada.
router.delete('/cuentas/:id', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const actual = await filaCuenta(pool, req.params.id);
    if (!actual) return res.status(404).json({ error: 'La cuenta no existe.' });
    await quitarCuenta(pool, actual.Id);
    invalidarCache();
    await auditarCuenta(pool, req, 'ELIMINACION', String(actual.Id), actual.Nombre, `API key de n8n quitada: ${actual.Nombre}`);
    res.json({ ok: true });
  } catch (err) {
    responderError(res, err);
  }
});

// Resumen para el Asistente IA (utils/asistenteTemas.js): mismos datos que el
// panel pero sin pasar por HTTP, y SOLO de los flujos a los que ese usuario
// tiene acceso. Solo lectura. Devuelve null si n8n no responde, para que el
// asistente siga funcionando sin este dato.
router.resumenParaAsistente = async (user) => {
  const pool = await getPool();
  const permitidos = await flujosPermitidos(pool, user);
  const recolectado = await consultarTodasLasCuentas(pool, 7);
  if (recolectado.cuentas.length && recolectado.cuentas.every((c) => !c.ok)) return null;

  const visibles = filtrarPermitidos(recolectado.flujos, permitidos);
  const est = calcular({ flujos: visibles, ejecuciones: recolectado.ejecuciones, dias: 7 });
  const g = est.global;
  const variasCuentas = new Set(visibles.map((f) => f.cuenta.id)).size > 1;
  const seg = (ms) => (ms === null || ms === undefined ? undefined : Math.round(ms / 100) / 10);
  return {
    resumen: {
      periodo: 'ultimos 7 dias',
      workflows_total: g.flujosTotal,
      activos: g.activos,
      detenidos: g.detenidos,
      ejecuciones_periodo: g.ejecuciones,
      ejecuciones_fallidas: g.fallidas,
      tasa_exito_pct: g.tasaExito,
      duracion_promedio_seg: seg(g.duracion.prom),
      flujos_que_requieren_atencion: g.conAtencion,
    },
    workflows: est.flujos.map((f) => ({
      workflow: f.nombre,
      ...(variasCuentas ? { propietario: f.cuentaNombre } : {}),
      activo: f.activo,
      ejecuciones: f.totalEjecuciones,
      fallidas: f.fallidas,
      tasa_exito_pct: f.tasaExito,
      duracion_promedio_seg: seg(f.duracion.prom),
      ultimo_estado: f.ultimoEstado,
      ultima_ejecucion: f.ultimaEjecucion,
      alertas: f.motivos.length ? f.motivos.map((m) => m.texto).join('; ') : undefined,
    })),
  };
};

module.exports = router;
