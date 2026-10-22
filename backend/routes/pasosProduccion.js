const express = require('express');
const router = express.Router();
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { getPool } = require('../db');
const { notificarVarios } = require('../utils/notificaciones');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');
const { garantizarEsquemaSubaplicativos, asegurarFicha } = require('../utils/subaplicativosSchema');
const acceso = require('../utils/bitacoraAcceso');
const { registrar: registrarAccesosBitacora } = require('./bitacoraAcceso');
const { rolEnModulo, ROL_CONSULTA } = require('../utils/permisosModulos');

// Bitácora de Pasos a Producción. El rol del módulo manda para escribir
// (requireEditPermission bloquea a quien solo consulta) y ADEMÁS cada persona tiene
// SU bitácora: un paso lo ven quienes están involucrados (lo crearon, participan o lo
// ejecutaron), quienes recibieron acceso (a la bitácora completa o a ese paso) y
// ADMIN_POD (que ve todo pero no edita pasos ajenos). Ver utils/bitacoraAcceso.js y
// routes/bitacoraAcceso.js (equipos y accesos). Un paso con varias personas es UN solo registro.
router.use(verifyToken, requireModule('PASOS_PRODUCCION'));

// El selector de "Aplicativo / Sub-aplicativo" ahora lista los sub-aplicativos
// del inventario (componentes de la pantalla Aplicaciones). Se garantiza que
// el esquema/sincronización del inventario esté listo antes de leer o guardar.
router.use(async (req, res, next) => {
  try {
    await garantizarEsquemaSubaplicativos(await getPool());
    next();
  } catch (error) {
    console.error('Error al preparar el inventario de sub-aplicativos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el inventario de sub-aplicativos' }) });
  }
});

const ENTORNOS_VALIDOS = ['DESARROLLO', 'QA', 'PRODUCCION'];
const ESTADOS_VALIDOS = ['PROGRAMADO', 'EJECUTADO', 'CANCELADO', 'REAGENDADO', 'ROLLBACK'];
// Estos tres SIEMPRE requieren un motivo -- es justo lo que pidió el usuario
// ("en caso de que se cancele o reagende... o rollback... poner el motivo").
const ESTADOS_QUE_REQUIEREN_MOTIVO = new Set(['CANCELADO', 'REAGENDADO', 'ROLLBACK']);
// Reagendar o hacer rollback implica un nuevo despliegue: exigen la NUEVA fecha/hora de despliegue.
const ESTADOS_QUE_REQUIEREN_NUEVA_FECHA = new Set(['REAGENDADO', 'ROLLBACK']);
const RE_FECHA_HORA = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

const ETIQUETAS_CAMPOS_PASO = {
  Rfc: 'RFC',
  Titulo: 'Título',
  Entorno: 'Ambiente',
  FechaHoraProgramada: 'Fecha/hora programada',
  Descripcion: 'Descripción',
  Estado: 'Estado',
  MotivoEstado: 'Motivo',
  ResultadoEjecucion: 'Resultado de la ejecución',
  AplicativoNombre: 'Aplicativo/Sub-aplicativo',
  AplicativosTexto: 'Aplicativos/servidores',
  FechaHoraEstimadaFin: 'Hora estimada de finalización',
  FechaHoraInicioReal: 'Inicio real de ejecución',
  FechaHoraFinReal: 'Fin real de ejecución',
  GoogleEventId: 'Evento de calendario vinculado',
  CommitMensaje: 'Commit asociado',
};
const CAMPOS_AUDITADOS_PASO = Object.keys(ETIQUETAS_CAMPOS_PASO);

// Adjuntos/evidencias: igual criterio que la Bitácora de Apuntamientos
// (ImagenBase64) -- el archivo se guarda codificado en base64 dentro de la
// fila, no en disco, así no hace falta ningún volumen de Docker aparte para
// no perderlos al reconstruir/recrear el contenedor. Se permite un set
// acotado de extensiones típicas de "evidencia de ejecución" (capturas,
// logs, PDFs de resultados, hojas de cálculo) -- nunca ejecutables.
const EXTENSIONES_ADJUNTO_VALIDAS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'log', 'csv', 'xlsx', 'xls', 'docx', 'doc', 'zip', 'json']);
// Evidencia de un ítem de checklist marcado desde la vista principal: el
// usuario pidió explícitamente "un pantallazo", así que acá el set de
// extensiones válidas es más estricto que el de adjuntos generales (solo
// imágenes, nada de PDFs/Office/logs).
const EXTENSIONES_EVIDENCIA_CHECKLIST = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
// ~10 MB de binario real (antes de la codificación base64, que agrega ~33%)
// -- junto con el límite de express.json subido en server.js, deja margen
// de sobra para capturas de pantalla, logs y PDFs normales.
const TAMANO_MAXIMO_ADJUNTO_BYTES = 10 * 1024 * 1024;

// ---------- Integración de solo lectura con Azure DevOps (búsqueda de
// commits para asociar al registro) ----------
// Mismas variables de entorno que backend/routes/azureRepo.js -- se repiten
// acá (en vez de importar ese archivo) para que la búsqueda de commits no
// dependa de que el usuario también tenga el módulo REPOSITORIO habilitado:
// cualquiera con PASOS_PRODUCCION puede buscar un commit para asociarlo,
// aunque no tenga acceso a navegar el repositorio completo.
const AZURE_DEVOPS_ORG = process.env.AZURE_DEVOPS_ORG || 'BancoFinandina';
const AZURE_DEVOPS_PROJECT = process.env.AZURE_DEVOPS_PROJECT || 'BusIBM';
const AZURE_DEVOPS_REPO = process.env.AZURE_DEVOPS_REPO || 'Documentos';
const AZURE_DEVOPS_BRANCH = process.env.AZURE_DEVOPS_BRANCH || 'master';
const AZURE_DEVOPS_PAT = process.env.AZURE_DEVOPS_PAT;

function authHeaderAzure() {
  return `Basic ${Buffer.from(`:${AZURE_DEVOPS_PAT}`).toString('base64')}`;
}

// Trae commits recientes de una rama y, opcionalmente, filtra por texto
// (mensaje, autor o hash) -- Azure DevOps no ofrece búsqueda de texto libre
// sobre el mensaje del commit en su API REST, así que se filtra acá sobre
// los últimos `top` commits de la rama.
async function buscarCommitsAzure({ repo, rama, top, buscar }) {
  if (!AZURE_DEVOPS_PAT) {
    const err = new Error(
      'Falta configurar AZURE_DEVOPS_PAT en el archivo .env del backend (ver guía de configuración).'
    );
    err.configuracionFaltante = true;
    throw err;
  }
  const repoFinal = repo || AZURE_DEVOPS_REPO;
  const ramaFinal = rama || AZURE_DEVOPS_BRANCH;
  const topFinal = Math.min(Math.max(parseInt(top, 10) || 50, 1), 100);

  const base = `https://dev.azure.com/${encodeURIComponent(AZURE_DEVOPS_ORG)}/${encodeURIComponent(AZURE_DEVOPS_PROJECT)}/_apis/git/repositories/${encodeURIComponent(repoFinal)}`;
  const params = new URLSearchParams({
    'api-version': '7.1',
    'searchCriteria.itemVersion.versionType': 'branch',
    'searchCriteria.itemVersion.version': ramaFinal,
    '$top': String(topFinal),
  });

  const resp = await fetch(`${base}/commits?${params.toString()}`, {
    headers: { Authorization: authHeaderAzure(), Accept: 'application/json' },
  });
  if (!resp.ok) {
    const cuerpo = await resp.text().catch(() => '');
    const err = new Error(`Azure DevOps respondió ${resp.status} ${resp.statusText}. ${cuerpo}`.trim());
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  let commits = (data.value || []).map((c) => ({
    id: c.commitId,
    idCorto: (c.commitId || '').substring(0, 8),
    comentario: c.comment || '',
    autor: c.author?.name || 'Desconocido',
    fecha: c.author?.date || null,
    url: c.remoteUrl || null,
  }));

  const termino = String(buscar || '').trim().toLowerCase();
  if (termino) {
    commits = commits.filter((c) =>
      c.comentario.toLowerCase().includes(termino) ||
      c.autor.toLowerCase().includes(termino) ||
      c.id.toLowerCase().includes(termino)
    );
  }
  return { repositorio: repoFinal, rama: ramaFinal, commits };
}

// Lista los repositorios del proyecto de Azure DevOps -- alimenta el
// selector de repositorio del commit asociado (ver comentario de
// buscarCommitsAzure: se repite acá en vez de depender de azureRepo.js para
// no exigir el módulo REPOSITORIO).
async function listarRepositoriosAzure() {
  if (!AZURE_DEVOPS_PAT) {
    const err = new Error(
      'Falta configurar AZURE_DEVOPS_PAT en el archivo .env del backend (ver guía de configuración).'
    );
    err.configuracionFaltante = true;
    throw err;
  }
  const base = `https://dev.azure.com/${encodeURIComponent(AZURE_DEVOPS_ORG)}/${encodeURIComponent(AZURE_DEVOPS_PROJECT)}/_apis`;
  const params = new URLSearchParams({ 'api-version': '7.1' });

  const resp = await fetch(`${base}/git/repositories?${params.toString()}`, {
    headers: { Authorization: authHeaderAzure(), Accept: 'application/json' },
  });
  if (!resp.ok) {
    const cuerpo = await resp.text().catch(() => '');
    const err = new Error(`Azure DevOps respondió ${resp.status} ${resp.statusText}. ${cuerpo}`.trim());
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const repositorios = (data.value || [])
    .map((r) => ({
      id: r.id,
      nombre: r.name,
      esPorDefecto: r.name === AZURE_DEVOPS_REPO,
      ramaPorDefecto: (r.defaultBranch || '').replace('refs/heads/', '') || null,
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return { repositorioPorDefecto: AZURE_DEVOPS_REPO, repositorios };
}

function manejarErrorAzure(res, error, contexto) {
  console.error(`Error en ${contexto}:`, error);
  if (error.configuracionFaltante) return res.status(500).json({ error: error.message });
  if (error.status === 401 || error.status === 403) {
    return res.status(502).json({ error: 'Azure DevOps rechazó las credenciales configuradas para consultar commits.' });
  }
  res.status(502).json({ error: 'No se pudo consultar Azure DevOps para buscar commits. Intenta de nuevo en un momento.' });
}

const SELECT_BASE = `
  SELECT p.Id, p.Rfc, p.Titulo, p.Entorno, p.FechaHoraProgramada, p.FechaHoraEstimadaFin,
         p.FechaHoraInicioReal, p.FechaHoraFinReal, p.GoogleEventId,
         p.Descripcion, p.Estado, p.MotivoEstado, p.ResultadoEjecucion,
         p.EjecutadoPorId, uej.nombre_completo AS EjecutadoPorNombre,
         p.CreadoPorId, ucr.nombre_completo AS CreadoPorNombre,
         p.AplicativoId, iv.componente_id AS AplicativoComponenteId,
         COALESCE(sc.Rol, ia.nombre_aplicacion) AS AplicativoNombre,
         COALESCE(sc.ServidorId, ia.servidor_id) AS AplicativoServidorId,
         sap.Hostname AS AplicativoServidorHostname,
         ia.aplicacion_negocio_id AS AplicativoNegocioId,
         COALESCE(
           (SELECT GROUP_CONCAT(an.Nombre ORDER BY an.Nombre SEPARATOR ', ')
              FROM Aplicacion_Componente acn
              JOIN Aplicaciones an ON an.Id = acn.AplicacionId
             WHERE acn.ComponenteId = sc.Id),
           apn.Nombre
         ) AS AplicativoNegocioNombre,
         p.CommitId, p.CommitRepo, p.CommitRama, p.CommitMensaje, p.CommitAutor, p.CommitFecha, p.CommitUrl,
         p.FechaCreacion, p.FechaActualizacion
  FROM PasosProduccion p
  INNER JOIN usuarios ucr ON ucr.id = p.CreadoPorId
  LEFT JOIN usuarios uej ON uej.id = p.EjecutadoPorId
  LEFT JOIN vw_inventario_aplicativos ia ON ia.id = p.AplicativoId
  LEFT JOIN inv_aplicativos iv ON iv.aplicacion_id = p.AplicativoId
  LEFT JOIN Servidor_Componentes sc ON sc.Id = iv.componente_id
  LEFT JOIN Servidores sap ON sap.Id = COALESCE(sc.ServidorId, ia.servidor_id)
  LEFT JOIN Aplicaciones apn ON apn.Id = ia.aplicacion_negocio_id
`;

// ---------- Varios servidores (sub-aplicativos) por paso ----------
// Un paso a producción de una app suele ejecutarse en varios nodos (p. ej. 3
// servidores). PasosProduccion.AplicativoId sigue guardando el PRIMERO (así
// todo lo que ya lo consume -- asistente, reportes -- sigue funcionando) y la
// tabla PasosProduccionComponentes guarda la lista completa. Si esa tabla aún
// no existe (falta correr el SQL), todo sigue funcionando con un solo servidor.
let estadoTablaComponentes = { lista: false, revisadoEn: 0 };
async function tablaComponentesLista(pool) {
  if (estadoTablaComponentes.lista) return true;
  if (Date.now() - estadoTablaComponentes.revisadoEn < 30 * 1000) return false;
  try {
    await pool.query('SELECT 1 FROM PasosProduccionComponentes LIMIT 1');
    estadoTablaComponentes = { lista: true, revisadoEn: Date.now() };
    return true;
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      estadoTablaComponentes = { lista: false, revisadoEn: Date.now() };
      return false;
    }
    throw error;
  }
}

const MENSAJE_FALTA_TABLA_COMPONENTES =
  'Para asociar más de un servidor a un paso falta crear la tabla PasosProduccionComponentes en la base de datos (ver crear_tabla_pasos_produccion_componentes.sql).';

// Normaliza lo que manda el frontend: `componenteIds` (lista) tiene prioridad;
// `componenteId` (uno solo) se conserva por compatibilidad. undefined = no tocar.
function normalizarComponenteIds({ componenteIds, componenteId }) {
  if (Array.isArray(componenteIds)) {
    return [...new Set(componenteIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
  }
  if (componenteId !== undefined) {
    return componenteId === null || componenteId === '' ? [] : [Number(componenteId)].filter((n) => Number.isInteger(n) && n > 0);
  }
  return undefined;
}

async function validarComponentesExisten(pool, ids) {
  if (!ids.length) return;
  const [filas] = await pool.query('SELECT Id FROM Servidor_Componentes WHERE Id IN (?)', [ids]);
  if (filas.length !== ids.length) {
    const err = new Error('Alguno de los sub-aplicativos/servidores seleccionados ya no existe en el inventario.');
    err.status = 400;
    throw err;
  }
}

async function guardarComponentesDelPaso(conexion, pasoId, ids) {
  await conexion.query('DELETE FROM PasosProduccionComponentes WHERE PasoId = ?', [pasoId]);
  if (ids.length) {
    await conexion.query(
      'INSERT INTO PasosProduccionComponentes (PasoId, ComponenteId, Orden) VALUES ?',
      [ids.map((id, i) => [pasoId, id, i])]
    );
  }
}

// Agrega `Aplicativos` (lista de servidores/sub-aplicativos) y `AplicativosTexto`
// a cada paso. Los pasos sin filas en la tabla nueva (anteriores a este cambio)
// muestran su único aplicativo de siempre.
async function agregarAplicativosAPasos(pool, pasos) {
  if (!pasos.length) return pasos;
  const porPaso = new Map();
  if (await tablaComponentesLista(pool)) {
    const [filas] = await pool.query(
      `SELECT pc.PasoId, sc.Id AS ComponenteId, sc.Rol AS Nombre, sc.ServidorId, s.Hostname AS ServidorHostname
         FROM PasosProduccionComponentes pc
         JOIN Servidor_Componentes sc ON sc.Id = pc.ComponenteId
         LEFT JOIN Servidores s ON s.Id = sc.ServidorId
        WHERE pc.PasoId IN (?)
        ORDER BY pc.PasoId, pc.Orden, pc.ComponenteId`,
      [pasos.map((p) => p.Id)]
    );
    filas.forEach((f) => {
      const lista = porPaso.get(f.PasoId) || [];
      lista.push({ ComponenteId: f.ComponenteId, Nombre: f.Nombre, ServidorId: f.ServidorId, ServidorHostname: f.ServidorHostname });
      porPaso.set(f.PasoId, lista);
    });
  }
  return pasos.map((p) => {
    let aplicativos = porPaso.get(p.Id);
    if (!aplicativos || !aplicativos.length) {
      aplicativos = p.AplicativoNombre
        ? [{ ComponenteId: p.AplicativoComponenteId ?? null, Nombre: p.AplicativoNombre, ServidorId: p.AplicativoServidorId ?? null, ServidorHostname: p.AplicativoServidorHostname ?? null }]
        : [];
    }
    const texto = aplicativos.map((a) => (a.ServidorHostname ? `${a.Nombre} (${a.ServidorHostname})` : a.Nombre)).join(', ');
    return { ...p, Aplicativos: aplicativos, AplicativosTexto: texto || null };
  });
}

async function obtenerEquipoPorPaso(pool, ids) {
  if (!ids.length) return new Map();
  const [filas] = await pool.query(
    `SELECT pe.PasoId, u.id, u.nombre_completo AS nombreCompleto
     FROM PasosProduccionEquipo pe
     INNER JOIN usuarios u ON u.id = pe.UsuarioId
     WHERE pe.PasoId IN (?)
     ORDER BY u.nombre_completo`,
    [ids]
  );
  const mapa = new Map();
  filas.forEach((f) => {
    const lista = mapa.get(f.PasoId) || [];
    lista.push({ id: f.id, nombreCompleto: f.nombreCompleto });
    mapa.set(f.PasoId, lista);
  });
  return mapa;
}

// ---------- Servicios del BUS por paso ----------
// Un paso puede actuar sobre uno o varios servicios del inventario (pantalla Servicios): si tiene
// servicios es un paso «BUS»; si no, es un paso de aplicación/servidores como siempre.
const MAX_SERVICIOS_POR_PASO = 60;
const MENSAJE_FALTA_TABLA_SERVICIOS =
  'Para vincular servicios del BUS a un paso falta crear la tabla PasosProduccionServicios (ver crear_tablas_bitacora_equipos_y_accesos.sql).';

async function agregarServicios(pool, pasos) {
  if (!pasos.length) return pasos;
  const porPaso = new Map();
  if (await acceso.serviciosListos(pool)) {
    const [filas] = await pool.query(
      `SELECT ps.PasoId, s.Id, s.Codigo, s.NombreServicio
         FROM PasosProduccionServicios ps
         JOIN AceServiciosInventario s ON s.Id = ps.ServicioId
        WHERE ps.PasoId IN (?) ORDER BY s.Codigo, s.NombreServicio`,
      [pasos.map((p) => p.Id)]
    );
    filas.forEach((f) => {
      const l = porPaso.get(f.PasoId) || [];
      l.push({ id: f.Id, codigo: f.Codigo, nombre: f.NombreServicio });
      porPaso.set(f.PasoId, l);
    });
  }
  return pasos.map((p) => {
    const servicios = porPaso.get(p.Id) || [];
    return { ...p, servicios, Tipo: servicios.length ? 'BUS' : 'APLICACION' };
  });
}

// undefined = no tocar; si llega, debe ser una lista de ids que existan en el inventario de servicios.
async function validarServicios(pool, servicioIds) {
  if (servicioIds === undefined) return { ids: undefined };
  if (!Array.isArray(servicioIds)) return { error: 'Los servicios deben enviarse como una lista.' };
  const ids = [...new Set(servicioIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length > MAX_SERVICIOS_POR_PASO) return { error: `Un paso admite hasta ${MAX_SERVICIOS_POR_PASO} servicios.` };
  if (ids.length) {
    if (!(await acceso.serviciosListos(pool))) return { error: MENSAJE_FALTA_TABLA_SERVICIOS };
    const [filas] = await pool.query('SELECT Id FROM AceServiciosInventario WHERE Id IN (?)', [ids]);
    if (filas.length !== ids.length) return { error: 'Alguno de los servicios elegidos ya no existe en el inventario.' };
  }
  return { ids };
}

async function guardarServicios(conexion, pasoId, ids) {
  await conexion.query('DELETE FROM PasosProduccionServicios WHERE PasoId = ?', [pasoId]);
  if (ids.length) await conexion.query('INSERT INTO PasosProduccionServicios (PasoId, ServicioId) VALUES ?', [ids.map((id) => [pasoId, id])]);
}

// Agrega a cada paso si está eliminado (y quién/cuándo/por qué) y si YO lo tengo oculto. Mientras no existan
// las columnas/tabla nuevas (script SQL) todos salen como activos y visibles.
async function agregarEstadoVista(pool, user, pasos) {
  if (!pasos.length) return pasos;
  const ids = pasos.map((p) => p.Id);
  const eliminacion = new Map();
  if (await acceso.eliminacionLista(pool)) {
    const [filas] = await pool.query(
      `SELECT p.Id, p.Eliminado, p.EliminadoEn, p.EliminadoPorId, u.nombre_completo AS EliminadoPorNombre, p.MotivoEliminacion
         FROM PasosProduccion p LEFT JOIN usuarios u ON u.id = p.EliminadoPorId WHERE p.Id IN (?)`, [ids]);
    filas.forEach((f) => eliminacion.set(f.Id, f));
  }
  const ocultos = new Set();
  if (user && await acceso.ocultosListos(pool)) {
    const [filas] = await pool.query('SELECT PasoId FROM PasosProduccionOcultos WHERE UsuarioId = ? AND PasoId IN (?)', [user.id, ids]);
    filas.forEach((f) => ocultos.add(f.PasoId));
  }
  return pasos.map((p) => {
    const e = eliminacion.get(p.Id);
    return {
      ...p,
      Eliminado: !!(e && Number(e.Eliminado) === 1),
      EliminadoEn: e && Number(e.Eliminado) === 1 ? e.EliminadoEn : null,
      EliminadoPorNombre: e && Number(e.Eliminado) === 1 ? e.EliminadoPorNombre : null,
      MotivoEliminacion: e && Number(e.Eliminado) === 1 ? e.MotivoEliminacion : null,
      Oculto: ocultos.has(p.Id),
    };
  });
}

// Agrega a cada paso el nivel de quien consulta (miNivel) y si participa (soyParticipante).
async function agregarNiveles(pool, user, pasos, equipoPorPaso) {
  if (!user) return pasos;
  const niveles = await acceso.nivelesDePasos(pool, user, pasos, equipoPorPaso);
  return pasos.map((p) => {
    const n = niveles.get(p.Id) || { nivel: null, participo: false };
    return { ...p, miNivel: n.nivel, soyParticipante: n.participo };
  });
}

// ---------- Posibles duplicados ----------
// Para cada paso, los OTROS pasos visibles con el mismo RFC y ambiente (no cancelados). Sirve para marcarlos
// en la lista y ofrecer «Fusionar». puedeConservar/puedeAbsorber dicen qué puede hacer esta persona con cada uno.
async function agregarDuplicados(pool, user, pasos) {
  const clave = (p) => `${String(p.Rfc || '').trim().toLowerCase()}|${p.Entorno}`;
  const candidatos = pasos.filter((p) => p.Rfc && String(p.Rfc).trim() && p.Estado !== 'CANCELADO');
  if (!candidatos.length) return pasos.map((p) => ({ ...p, duplicados: [] }));
  const vis = await acceso.condicionVisible(pool, 'p', user);
  const [filas] = await pool.query(
    `SELECT p.Id, p.Rfc, p.Entorno, p.Titulo, p.Estado, p.FechaHoraProgramada, p.CreadoPorId, p.EjecutadoPorId, u.nombre_completo AS CreadoPorNombre
       FROM PasosProduccion p JOIN usuarios u ON u.id = p.CreadoPorId
      WHERE p.Rfc IN (?) AND p.Estado <> 'CANCELADO' AND ${vis.sql}`,
    [[...new Set(candidatos.map((p) => p.Rfc))], ...vis.params]
  );
  const grupos = new Map();
  filas.forEach((f) => { const k = clave(f); const l = grupos.get(k) || []; l.push(f); grupos.set(k, l); });
  const repetidos = [...grupos.values()].filter((g) => g.length > 1).flat();
  if (!repetidos.length) return pasos.map((p) => ({ ...p, duplicados: [] }));
  const equipo = await obtenerEquipoPorPaso(pool, repetidos.map((f) => f.Id));
  const niveles = await acceso.nivelesDePasos(pool, user, repetidos, equipo);
  const admin = acceso.esAdmin(user);
  const resumen = new Map(repetidos.map((f) => {
    const nivel = niveles.get(f.Id)?.nivel || null;
    const gente = [f.CreadoPorNombre, ...(equipo.get(f.Id) || []).map((e) => e.nombreCompleto)].filter(Boolean);
    return [f.Id, {
      id: f.Id, titulo: f.Titulo, estado: f.Estado, fechaHoraProgramada: f.FechaHoraProgramada, creadoPor: f.CreadoPorNombre,
      participantes: [...new Set(gente)].join(', '), miNivel: nivel,
      puedeConservar: admin || acceso.puedeEditarNivel(nivel), puedeAbsorber: admin || nivel === 'PROPIETARIO',
    }];
  }));
  return pasos.map((p) => {
    if (!p.Rfc || p.Estado === 'CANCELADO') return { ...p, duplicados: [] };
    const otros = (grupos.get(clave(p)) || []).filter((f) => f.Id !== p.Id).map((f) => resumen.get(f.Id)).filter(Boolean);
    return { ...p, duplicados: otros };
  });
}

async function obtenerPasoCompleto(pool, pasoId, user = null) {
  const [[paso]] = await pool.query(`${SELECT_BASE} WHERE p.Id = ?`, [pasoId]);
  if (!paso) return null;
  const equipoPorPaso = await obtenerEquipoPorPaso(pool, [pasoId]);
  const [conAplicativos] = await agregarAplicativosAPasos(pool, [paso]);
  const [conServicios] = await agregarServicios(pool, [conAplicativos]);
  // OJO: la clave del mapa es el Id numérico del paso (pasoId puede llegar como texto desde la URL).
  const completo = { ...conServicios, equipo: equipoPorPaso.get(paso.Id) || [] };
  const [conNivel] = await agregarNiveles(pool, user, [completo], equipoPorPaso);
  const [conEstado] = await agregarEstadoVista(pool, user, [conNivel]);
  return conEstado;
}

// ---------- ¿De quién son los pasos que se listan? ----------
// Por omisión, MI bitácora. Se puede pedir también la de otras personas (?propietarios=1,2 o «yo»),
// la de uno o varios equipos (?equipos=3,4), los pasos que me compartieron uno a uno (?compartidos=1)
// o todo lo que puedo ver (?todos=1). Siempre se limita a lo que la persona puede ver (condicionVisible).
// Un paso con varias personas involucradas sale UNA sola vez (se filtra con EXISTS, no con JOIN).
async function resolverFuentes(pool, req) {
  const q = req.query;
  if (q.todos === '1') return null;
  const legacy = !(await acceso.accesosListos(pool));
  const yo = Number(req.user.id);
  const personas = new Set();
  const pedidos = String(q.propietarios || '').split(',').map((x) => x.trim()).filter(Boolean);
  pedidos.forEach((x) => { if (x === 'yo') personas.add(yo); else { const n = Number(x); if (Number.isInteger(n) && n > 0) personas.add(n); } });
  const eq = acceso.idsValidos(String(q.equipos || '').split(','));
  const compartidos = q.compartidos === '1';
  const explicito = pedidos.length > 0 || eq.length > 0 || compartidos;
  if (legacy && !explicito) return null; // sin las tablas nuevas todo sigue visible, como antes
  if (eq.length && !legacy) {
    const [m] = await pool.query('SELECT DISTINCT UsuarioId FROM BitacoraEquipoMiembros WHERE EquipoId IN (?)', [eq]);
    m.forEach((x) => personas.add(Number(x.UsuarioId)));
  }
  if (!explicito) personas.add(yo);
  const partes = [];
  const params = [];
  if (personas.size) { const inv = acceso.sqlInvolucra('p', [...personas]); partes.push(inv.sql); params.push(...inv.params); }
  if (compartidos && !legacy) {
    partes.push("EXISTS (SELECT 1 FROM BitacoraAccesos bc WHERE bc.UsuarioId = ? AND bc.Estado = 'ACEPTADA' AND bc.PasoId = p.Id)");
    params.push(yo);
  }
  return partes.length ? { sql: `(${partes.join(' OR ')})`, params } : { sql: '1=0', params: [] };
}

// ¿Ya existe un paso con ese RFC y ambiente (o ese evento de calendario)? Evita duplicar el mismo
// paso cuando varias personas participan: quien lo creó puede agregarlas como participantes.
async function buscarDuplicado(pool, user, { rfc, entorno, googleEventId, excluirId = 0 }) {
  const cond = [];
  const params = [];
  if (rfc) { cond.push("(p.Rfc = ? AND p.Entorno = ? AND p.Estado <> 'CANCELADO')"); params.push(rfc, entorno); }
  if (googleEventId) { cond.push('p.GoogleEventId = ?'); params.push(googleEventId); }
  if (!cond.length) return null;
  const activo = await acceso.sqlActivo(pool, 'p'); // un paso eliminado no cuenta como duplicado
  const [filas] = await pool.query(
    `SELECT p.Id, p.Titulo, p.Rfc, p.Entorno, p.CreadoPorId, u.nombre_completo AS CreadoPorNombre
       FROM PasosProduccion p JOIN usuarios u ON u.id = p.CreadoPorId
      WHERE (${cond.join(' OR ')}) AND ${activo} AND p.Id <> ? ORDER BY p.Id DESC LIMIT 1`,
    [...params, excluirId]
  );
  if (!filas.length) return null;
  const f = filas[0];
  const info = await acceso.nivelDePaso(pool, user, f.Id);
  return { id: f.Id, titulo: info.nivel ? f.Titulo : null, rfc: f.Rfc, entorno: f.Entorno, creadoPor: f.CreadoPorNombre, visible: !!info.nivel };
}

// Avisa a quienes acaban de quedar como participantes de un paso.
async function avisarParticipantes(pool, req, pasoId, titulo, rfc, ids) {
  try {
    await notificarVarios(pool, ids, {
      tipo: 'PASO_PARTICIPANTE', severidad: 'INFO', titulo: 'Te agregaron a un paso a producción', referencia: Number(pasoId), enlace: '/pasos-produccion',
      mensaje: `${req.user?.nombre_completo || req.user?.username || 'Alguien'} te agregó como participante de «${rfc ? `${rfc} · ` : ''}${titulo}». Aparece en tu bitácora; no hace falta crearlo de nuevo.`,
      clave: `paso-part-${pasoId}-${Date.now()}`,
    }, req.user.id);
  } catch (e) {
    console.error('No se pudo avisar a los participantes del paso:', e.message);
  }
}

// ---------- Vistas de la bitácora: principal / ocultos / eliminados ----------
//  · Eliminación LÓGICA: el paso pasa a «Eliminados» (columna Eliminado) y sale de todo lo demás (lista principal,
//    tablero, avisos, duplicados, informes); se puede restaurar. Es para todas las personas con acceso al paso.
//  · Ocultar: es PERSONAL (tabla PasosProduccionOcultos): quita el paso de MI vista principal sin afectar a nadie más.
//  · Eliminación FÍSICA (definitiva): borra el registro y todo lo que cuelga de él.
const VISTAS = ['principal', 'ocultos', 'eliminados'];

async function condicionVista(pool, vista, user) {
  if (vista === 'eliminados') {
    return (await acceso.eliminacionLista(pool)) ? { sql: 'p.Eliminado = 1', params: [] } : { vacia: true };
  }
  const listos = await acceso.ocultosListos(pool);
  if (vista === 'ocultos') {
    if (!listos) return { vacia: true };
    return { sql: 'EXISTS (SELECT 1 FROM PasosProduccionOcultos oc WHERE oc.PasoId = p.Id AND oc.UsuarioId = ?)', params: [Number(user.id)] };
  }
  if (!listos) return { sql: null, params: [] };
  return { sql: 'NOT EXISTS (SELECT 1 FROM PasosProduccionOcultos oc WHERE oc.PasoId = p.Id AND oc.UsuarioId = ?)', params: [Number(user.id)] };
}

// ==========================================================
// GET /api/pasos-produccion -- filtros: ?entorno=, ?estado=, ?desde=, ?hasta=
// ==========================================================
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const condiciones = [];
    const parametros = [];

    if (req.query.entorno && ENTORNOS_VALIDOS.includes(req.query.entorno)) {
      condiciones.push('p.Entorno = ?');
      parametros.push(req.query.entorno);
    }
    if (req.query.estado && ESTADOS_VALIDOS.includes(req.query.estado)) {
      condiciones.push('p.Estado = ?');
      parametros.push(req.query.estado);
    }
    if (req.query.desde) {
      condiciones.push('p.FechaHoraProgramada >= ?');
      parametros.push(`${req.query.desde} 00:00:00`);
    }
    if (req.query.hasta) {
      condiciones.push('p.FechaHoraProgramada <= ?');
      parametros.push(`${req.query.hasta} 23:59:59`);
    }

    // Vista: principal (por omisión: ni eliminados ni los que YO oculté), ocultos (los que oculté) o eliminados.
    const vista = VISTAS.includes(req.query.vista) ? req.query.vista : 'principal';
    const filtroVista = await condicionVista(pool, vista, req.user);
    if (filtroVista.vacia) return res.json([]);

    // Privacidad: solo lo que esta persona puede ver, y de las fuentes pedidas (por omisión, su bitácora).
    const visible = await acceso.condicionVisible(pool, 'p', req.user, { incluirEliminados: vista === 'eliminados' });
    condiciones.push(visible.sql);
    parametros.push(...visible.params);
    if (filtroVista.sql) { condiciones.push(filtroVista.sql); parametros.push(...filtroVista.params); }
    const fuente = await resolverFuentes(pool, req);
    if (fuente) { condiciones.push(fuente.sql); parametros.push(...fuente.params); }

    const whereSql = `WHERE ${condiciones.join(' AND ')}`;
    const [pasos] = await pool.query(
      `${SELECT_BASE} ${whereSql} ORDER BY ${vista === 'eliminados' ? 'p.EliminadoEn DESC, p.Id DESC' : 'p.FechaHoraProgramada DESC'}`,
      parametros
    );

    const equipoPorPaso = await obtenerEquipoPorPaso(pool, pasos.map((p) => p.Id));
    const conAplicativos = await agregarAplicativosAPasos(pool, pasos);
    const conServicios = await agregarServicios(pool, conAplicativos);
    const completos = conServicios.map((p) => ({ ...p, equipo: equipoPorPaso.get(p.Id) || [] }));
    const conNiveles = await agregarNiveles(pool, req.user, completos, equipoPorPaso);
    const conEstado = await agregarEstadoVista(pool, req.user, conNiveles);
    res.json(await agregarDuplicados(pool, req.user, conEstado));
  } catch (error) {
    console.error('Error al listar la bitácora de pasos a producción:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la bitácora de pasos a producción' }) });
  }
});

// ==========================================================
// GET /api/pasos-produccion/commits-disponibles -- búsqueda de commits de
// Azure DevOps para asociar al registro (ver buscarCommitsAzure arriba).
// Va ANTES de "/:id" a propósito: si quedara después, Express la
// interpretaría como una búsqueda de un registro con Id="commits-disponibles".
// No depende de ningún :id puntual -- sirve tanto para un registro ya
// creado como para el formulario de "Nuevo Registro" (que todavía no tiene
// Id).
// ==========================================================
// ==========================================================
// GET /api/pasos-produccion/conteos -- cuántos pasos hay en cada vista (principal / ocultos / eliminados), con las
// mismas fuentes (?propietarios=, ?equipos=, ?compartidos=, ?todos=) que la lista. Dice además si ya existen las
// columnas/tabla nuevas (script SQL), para que la pantalla avise cuando falta ejecutarlo.
// ==========================================================
router.get('/conteos', async (req, res) => {
  try {
    const pool = await getPool();
    const fuente = await resolverFuentes(pool, req);
    const eliminacionLista = await acceso.eliminacionLista(pool);
    const ocultosListos = await acceso.ocultosListos(pool);
    const contar = async (vista) => {
      const fv = await condicionVista(pool, vista, req.user);
      if (fv.vacia) return 0;
      const vis = await acceso.condicionVisible(pool, 'p', req.user, { incluirEliminados: vista === 'eliminados' });
      const cond = [vis.sql];
      const par = [...vis.params];
      if (fv.sql) { cond.push(fv.sql); par.push(...fv.params); }
      if (fuente) { cond.push(fuente.sql); par.push(...fuente.params); }
      const [[f]] = await pool.query(`SELECT COUNT(*) AS total FROM PasosProduccion p WHERE ${cond.join(' AND ')}`, par);
      return Number(f.total) || 0;
    };
    const [principal, ocultos, eliminados] = await Promise.all([contar('principal'), contar('ocultos'), contar('eliminados')]);
    res.json({
      principal, ocultos, eliminados, eliminacionLista, ocultosListos,
      aviso: eliminacionLista && ocultosListos ? null : acceso.MENSAJE_SIN_ELIMINACION,
    });
  } catch (error) {
    console.error('Error al contar los pasos por vista:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la bitácora de pasos a producción' }) });
  }
});

router.get('/commits-disponibles', async (req, res) => {
  try {
    const resultado = await buscarCommitsAzure({
      repo: req.query.repo,
      rama: req.query.rama,
      top: req.query.top,
      buscar: req.query.buscar,
    });
    res.json(resultado);
  } catch (error) {
    manejarErrorAzure(res, error, 'GET /pasos-produccion/commits-disponibles');
  }
});

// GET /api/pasos-produccion/repositorios-disponibles -- lista de repos del
// proyecto, para el selector "elige el repo" que habilita después el
// desplegable de commits de ESE repo (ver buscarCommitsAzure).
router.get('/repositorios-disponibles', async (req, res) => {
  try {
    const resultado = await listarRepositoriosAzure();
    res.json(resultado);
  } catch (error) {
    manejarErrorAzure(res, error, 'GET /pasos-produccion/repositorios-disponibles');
  }
});

// GET /api/pasos-produccion/catalogos/subaplicativos -- alimenta el selector
// "Aplicativo / Sub-aplicativo": todos los componentes del inventario de
// sub-aplicativos (el `id` es el id del COMPONENTE; al guardar el paso el
// backend resuelve/crea la ficha que referencia PasosProduccion.AplicativoId).
// Va ANTES de "/:id" por la misma razón que /commits-disponibles.
router.get('/catalogos/subaplicativos', async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(`
      SELECT sc.Id AS id, sc.Rol AS nombre, sc.Tipo AS tipo, sc.Puerto AS puerto,
             sc.ServidorId AS servidorId, s.Hostname AS servidorHostname, s.Ambiente AS ambiente,
             s.Activo AS servidorActivo,
             ia.criticidad, ia.plataforma, ia.estado
        FROM Servidor_Componentes sc
        JOIN Servidores s ON s.Id = sc.ServidorId
        LEFT JOIN inv_aplicativos ia ON ia.componente_id = sc.Id
       ORDER BY sc.Rol, s.Hostname
    `);

    const negociosPorComponente = new Map();
    if (filas.length) {
      const [links] = await pool.query(
        `SELECT ac.ComponenteId AS componenteId, a.Id AS id, a.Nombre AS nombre
           FROM Aplicacion_Componente ac
           JOIN Aplicaciones a ON a.Id = ac.AplicacionId
          WHERE ac.ComponenteId IN (?)
          ORDER BY a.Nombre`,
        [filas.map((f) => f.id)]
      );
      links.forEach((l) => {
        const lista = negociosPorComponente.get(l.componenteId) || [];
        lista.push({ id: l.id, nombre: l.nombre });
        negociosPorComponente.set(l.componenteId, lista);
      });
    }

    res.json(filas.map((f) => {
      const negocios = negociosPorComponente.get(f.id) || [];
      const partes = [f.servidorHostname];
      if (f.puerto) partes.push(`:${f.puerto}`);
      if (negocios.length) partes.push(negocios.map((n) => n.nombre).join(', '));
      return {
        id: f.id,
        nombre: f.nombre,
        // El texto del subtítulo también participa en la búsqueda del selector:
        // se puede buscar por nombre, servidor, puerto o aplicación de negocio.
        subtitulo: partes.join(' · '),
        servidorId: f.servidorId,
        servidorHostname: f.servidorHostname,
        ambiente: f.ambiente,
        puerto: f.puerto,
        tipo: f.tipo,
        criticidad: f.criticidad || null,
        plataforma: f.plataforma || null,
        activo: f.servidorActivo,
        estado: f.estado || null,
        aplicacionesNegocio: negocios,
      };
    }));
  } catch (error) {
    console.error('Error al listar los sub-aplicativos para pasos a producción:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el listado de sub-aplicativos' }) });
  }
});

// Equipos y accesos de la bitácora (/bitacora/...). Van ANTES de "/:id" por la misma razón.
registrarAccesosBitacora(router, { getPool, requireEditPermission });

// Guarda de TODA ruta con :id (el paso, su checklist, adjuntos, historial y el seguimiento de GLPI):
// sin acceso al paso responde 404 (no revela que existe); escribir exige edición y borrar el paso
// solo lo puede hacer quien lo creó. ADMIN_POD ve todos los pasos pero no modifica los ajenos.
router.param('id', async (req, res, next, id) => {
  try {
    const pasoId = Number(id);
    if (!Number.isInteger(pasoId) || pasoId <= 0) return res.status(400).json({ error: 'Registro de bitácora no válido.' });
    const info = await acceso.nivelDePaso(await getPool(), req.user, pasoId);
    if (!info.existe) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    if (!info.nivel) return res.status(404).json({ error: 'Ese paso no existe o no tienes acceso a él.' });
    req.pasoNivel = info.nivel;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const esBorrarPaso = req.method === 'DELETE' && /^\/\d+\/?$/.test(req.path);
      // Ocultar/mostrar es PERSONAL (solo mi vista): basta con poder ver el paso, aunque sea de solo lectura.
      const esOcultar = req.method === 'POST' && /^\/\d+\/(ocultar|mostrar)\/?$/.test(req.path);
      if (esBorrarPaso && info.nivel !== 'PROPIETARIO') {
        return res.status(403).json({ error: 'Solo quien creó el paso puede eliminarlo definitivamente.' });
      }
      if (!esOcultar && !acceso.puedeEditarNivel(info.nivel)) {
        return res.status(403).json({
          error: info.nivel === 'ADMIN'
            ? 'Como administrador puedes ver todas las bitácoras, pero no modificar los pasos de otras personas.'
            : 'Este paso se compartió contigo solo para lectura: no puedes modificarlo.',
        });
      }
      // Un paso que está en «Eliminados» (eliminación lógica) es de solo lectura: para modificarlo (editar, cambiar
      // su estado, tocar el checklist o las evidencias, publicar en GLPI) primero hay que restaurarlo. Sí se puede
      // restaurar, borrar definitivamente u ocultar/mostrar.
      const accionDeVista = req.method === 'POST' && /^\/\d+\/(restaurar|eliminar|ocultar|mostrar)\/?$/.test(req.path);
      if (!esBorrarPaso && !accionDeVista) {
        const pool = await getPool();
        if (await acceso.eliminacionLista(pool)) {
          const [[fila]] = await pool.query('SELECT Eliminado FROM PasosProduccion WHERE Id = ?', [pasoId]);
          if (fila && Number(fila.Eliminado) === 1) {
            return res.status(409).json({ error: 'Este registro está en «Eliminados». Restáuralo para poder modificarlo.', codigo: 'PASO_ELIMINADO' });
          }
        }
      }
    }
    next();
  } catch (error) {
    console.error('Error al verificar el acceso al paso:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  }
});

// Importar un caso de GLPI como propuesta de registro (vista previa, no guarda
// nada). Va ANTES de "/:id" por la misma razón que /commits-disponibles.
require('./pasosProduccionGlpi')(router, { getPool, requireEditPermission, registrarEventoGeneral, mensajeErrorAmigable });

router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const paso = await obtenerPasoCompleto(pool, req.params.id, req.user);
    if (!paso) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    res.json(paso);
  } catch (error) {
    console.error('Error al obtener el registro de la bitácora:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  }
});

// El commit asociado viaja como un único objeto desde el frontend (lo que
// devuelve GET /commits-disponibles, elegido por el usuario) -- acá se
// desarma en las columnas sueltas que tiene PasosProduccion. `commit` en
// null/undefined limpia la asociación (se usa al quitar el commit elegido);
// un objeto la fija/reemplaza.
function normalizarCommit(commit) {
  if (!commit || !commit.id) {
    return { CommitId: null, CommitRepo: null, CommitRama: null, CommitMensaje: null, CommitAutor: null, CommitFecha: null, CommitUrl: null };
  }
  // Azure DevOps manda la fecha en ISO 8601 ("2024-01-15T10:30:00Z") -- MySQL
  // no acepta la 'T'/'Z' como literal de DATETIME y tira un error sin mapear
  // en mensajesError.js (de ahí el mensaje genérico al guardar el commit).
  // Se convierte a un Date real: el driver de MySQL sí sabe insertarlo bien.
  const fecha = commit.fecha ? new Date(commit.fecha) : null;
  return {
    CommitId: String(commit.id).slice(0, 64),
    CommitRepo: commit.repo ? String(commit.repo).slice(0, 200) : null,
    CommitRama: commit.rama ? String(commit.rama).slice(0, 200) : null,
    CommitMensaje: commit.mensaje ? String(commit.mensaje).slice(0, 500) : null,
    CommitAutor: commit.autor ? String(commit.autor).slice(0, 200) : null,
    CommitFecha: fecha && !isNaN(fecha.getTime()) ? fecha : null,
    CommitUrl: commit.url ? String(commit.url).slice(0, 500) : null,
  };
}

// Convierte lo que manda el frontend en el valor para PasosProduccion.AplicativoId
// (FK a la ficha, Aplicaciones.Id). Prioridad:
//   1) `componenteId` -- el sub-aplicativo elegido en el selector; se resuelve
//      (o se crea) su ficha.
//   2) `aplicativoId` -- compatibilidad con clientes viejos: se usa tal cual.
// `undefined` en ambos = no cambiar (devuelve { cambia: false }); null/'' = quitar.
// Lanza un error con `.status = 400` si el componente no existe.
async function resolverAplicativo(pool, { componenteId, aplicativoId }) {
  const vacio = (v) => v === null || v === '';
  if (componenteId !== undefined) {
    if (vacio(componenteId)) return { cambia: true, aplicativoId: null };
    const [[componente]] = await pool.query(
      'SELECT Id, ServidorId, Rol FROM Servidor_Componentes WHERE Id = ?',
      [Number(componenteId)]
    );
    if (!componente) {
      const err = new Error('El sub-aplicativo seleccionado ya no existe en el inventario.');
      err.status = 400;
      throw err;
    }
    const { aplicacionId } = await asegurarFicha(pool, componente.Id, componente.ServidorId, componente.Rol);
    return { cambia: true, aplicativoId: aplicacionId };
  }
  if (aplicativoId !== undefined) {
    return { cambia: true, aplicativoId: vacio(aplicativoId) ? null : Number(aplicativoId) };
  }
  return { cambia: false, aplicativoId: null };
}

// ==========================================================
// POST /api/pasos-produccion -- crear (a partir de un evento del calendario
// o manual -- googleEventId es opcional en ambos casos).
// ==========================================================
// ---- Coherencia de fechas: la finalización nunca puede ser anterior al inicio ----
// Acepta Date (lo que devuelve MySQL) o texto «YYYY-MM-DD HH:MM[:SS]» / «YYYY-MM-DDTHH:MM» (lo que manda la pantalla).
function fechaAMs(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.getTime();
  const t = new Date(String(valor).trim().replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? null : t;
}
const MSG_FIN_ESTIMADO_ANTERIOR = 'La hora estimada de finalización no puede ser anterior a la fecha/hora programada.';
const MSG_FIN_REAL_ANTERIOR = 'El fin real no puede ser anterior al inicio real.';
/** Devuelve un mensaje de error si `fin` es anterior a `inicio` (ambos con valor); si no, null. */
function errorSiFinAnterior(inicio, fin, mensaje) {
  const a = fechaAMs(inicio);
  const b = fechaAMs(fin);
  return a !== null && b !== null && b < a ? mensaje : null;
}

router.post('/', requireEditPermission, async (req, res) => {
  const { rfc, titulo, entorno, fechaHoraProgramada, fechaHoraEstimadaFin, googleEventId, descripcion, equipo, aplicativoId, componenteId, componenteIds, commit, servicioIds, tipo, confirmarDuplicado } = req.body;

  if (!titulo || !String(titulo).trim()) {
    return res.status(400).json({ error: 'El título del paso a producción es obligatorio.' });
  }
  if (!ENTORNOS_VALIDOS.includes(entorno)) {
    return res.status(400).json({ error: `El ambiente debe ser uno de: ${ENTORNOS_VALIDOS.join(', ')}.` });
  }
  if (!fechaHoraProgramada) {
    return res.status(400).json({ error: 'La fecha/hora programada es obligatoria.' });
  }
  const errorFechas = errorSiFinAnterior(fechaHoraProgramada, fechaHoraEstimadaFin, MSG_FIN_ESTIMADO_ANTERIOR);
  if (errorFechas) return res.status(400).json({ error: errorFechas });

  // El creador ya es parte del paso: no se repite como participante.
  const listaEquipo = Array.isArray(equipo) ? [...new Set(equipo.map(Number).filter((n) => n && n !== Number(req.user.id)))] : [];
  let aplicativoIdNormalizado = null;
  const idsComponentes = normalizarComponenteIds({ componenteIds, componenteId });
  let idsServicios;
  try {
    const poolInicial = await getPool();
    const vs = await validarServicios(poolInicial, servicioIds);
    if (vs.error) return res.status(400).json({ error: vs.error });
    idsServicios = vs.ids;
    if (tipo === 'BUS' && !(idsServicios && idsServicios.length)) {
      return res.status(400).json({ error: 'Un paso del BUS necesita al menos un servicio del inventario.' });
    }
    // Evita duplicar el mismo paso (mismo RFC y ambiente, o mismo evento de calendario).
    if (!confirmarDuplicado) {
      const dup = await buscarDuplicado(poolInicial, req.user, {
        rfc: rfc ? String(rfc).trim() : null, entorno, googleEventId: googleEventId || null,
      });
      if (dup) {
        return res.status(409).json({
          duplicado: dup,
          error: dup.visible
            ? `Ya existe el paso «${dup.titulo}» con ese RFC y ambiente (lo creó ${dup.creadoPor}). Ábrelo y agrega a quien participe en vez de crear otro.`
            : `Ya existe un paso con ese RFC y ambiente, creado por ${dup.creadoPor}. Pídele que te agregue como participante para no duplicarlo.`,
        });
      }
    }
    if (idsComponentes && idsComponentes.length > 1 && !(await tablaComponentesLista(poolInicial))) {
      return res.status(400).json({ error: MENSAJE_FALTA_TABLA_COMPONENTES });
    }
    if (idsComponentes) await validarComponentesExisten(poolInicial, idsComponentes);
    // El primero de la lista es el aplicativo "principal" del paso.
    const resuelto = await resolverAplicativo(poolInicial, {
      componenteId: idsComponentes ? (idsComponentes[0] ?? null) : componenteId,
      aplicativoId,
    });
    aplicativoIdNormalizado = resuelto.aplicativoId;
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('Error al resolver el sub-aplicativo del registro de la bitácora:', error);
    return res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  }
  const c = normalizarCommit(commit);

  const conexion = await (await getPool()).getConnection();
  try {
    await conexion.beginTransaction();

    const [resultado] = await conexion.query(
      `INSERT INTO PasosProduccion
        (Rfc, Titulo, Entorno, AplicativoId, FechaHoraProgramada, FechaHoraEstimadaFin, GoogleEventId, Descripcion, Estado, CreadoPorId,
         CommitId, CommitRepo, CommitRama, CommitMensaje, CommitAutor, CommitFecha, CommitUrl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROGRAMADO', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rfc ? String(rfc).trim() : null,
        String(titulo).trim(),
        entorno,
        aplicativoIdNormalizado,
        fechaHoraProgramada,
        fechaHoraEstimadaFin || null,
        googleEventId || null,
        descripcion ? String(descripcion).trim() : null,
        req.user.id,
        c.CommitId, c.CommitRepo, c.CommitRama, c.CommitMensaje, c.CommitAutor, c.CommitFecha, c.CommitUrl,
      ]
    );
    const pasoId = resultado.insertId;

    if (listaEquipo.length) {
      await conexion.query(
        `INSERT INTO PasosProduccionEquipo (PasoId, UsuarioId) VALUES ?`,
        [listaEquipo.map((usuarioId) => [pasoId, usuarioId])]
      );
    }

    if (idsComponentes && idsComponentes.length && await tablaComponentesLista(conexion)) {
      await guardarComponentesDelPaso(conexion, pasoId, idsComponentes);
    }
    if (idsServicios && idsServicios.length) await guardarServicios(conexion, pasoId, idsServicios);

    await conexion.commit();

    const pool = await getPool();
    await registrarEventoGeneral(pool, req, {
      modulo: 'PASOS_PRODUCCION',
      entidad: 'PasoProduccion',
      entidadId: pasoId,
      entidadNombre: String(titulo).trim(),
      accion: 'CREACION',
      detalle: `Ambiente ${entorno}, programado ${fechaHoraProgramada}.`,
    });
    await avisarParticipantes(pool, req, pasoId, String(titulo).trim(), rfc ? String(rfc).trim() : null, listaEquipo);

    res.status(201).json(await obtenerPasoCompleto(pool, pasoId, req.user));
  } catch (error) {
    await conexion.rollback();
    console.error('Error al crear el registro de la bitácora:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  } finally {
    conexion.release();
  }
});

// ==========================================================
// PUT /api/pasos-produccion/:id -- editar datos generales y/o equipo
// (para cambiar el Estado, ver PATCH /:id/estado, que exige el motivo).
// ==========================================================
router.put('/:id', requireEditPermission, async (req, res) => {
  const {
    rfc, titulo, entorno, fechaHoraProgramada, fechaHoraEstimadaFin, descripcion, equipo, aplicativoId, componenteId, componenteIds, googleEventId, servicioIds,
    // Corrección manual de la duración real -- normalmente se fijan solas al
    // marcar el estado como EJECUTADO (ver PATCH /:id/estado), pero se dejan
    // editables acá por si hay que ajustarlas después.
    fechaHoraInicioReal, fechaHoraFinReal,
    // Commit asociado -- undefined deja el que ya estaba, null lo quita, un
    // objeto lo fija/reemplaza (ver normalizarCommit).
    commit,
  } = req.body;
  try {
    const pool = await getPool();
    const antes = await obtenerPasoCompleto(pool, req.params.id, req.user);
    if (!antes) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });

    const vs = await validarServicios(pool, servicioIds);
    if (vs.error) return res.status(400).json({ error: vs.error });

    if (entorno !== undefined && !ENTORNOS_VALIDOS.includes(entorno)) {
      return res.status(400).json({ error: `El ambiente debe ser uno de: ${ENTORNOS_VALIDOS.join(', ')}.` });
    }

    // La finalización (estimada o real) no puede ser anterior al inicio. Se valida con los valores resultantes
    // (lo enviado o, si no se envió, lo que ya tenía el paso), solo cuando se toca alguna de esas fechas.
    {
      const programada = fechaHoraProgramada !== undefined ? fechaHoraProgramada : antes.FechaHoraProgramada;
      const estimadaFin = fechaHoraEstimadaFin !== undefined ? (fechaHoraEstimadaFin || null) : antes.FechaHoraEstimadaFin;
      const inicioReal = fechaHoraInicioReal !== undefined ? (fechaHoraInicioReal || null) : antes.FechaHoraInicioReal;
      const finReal = fechaHoraFinReal !== undefined ? (fechaHoraFinReal || null) : antes.FechaHoraFinReal;
      const errorFechas = (fechaHoraProgramada !== undefined || fechaHoraEstimadaFin !== undefined
        ? errorSiFinAnterior(programada, estimadaFin, MSG_FIN_ESTIMADO_ANTERIOR) : null)
        || (fechaHoraInicioReal !== undefined || fechaHoraFinReal !== undefined
          ? errorSiFinAnterior(inicioReal, finReal, MSG_FIN_REAL_ANTERIOR) : null);
      if (errorFechas) return res.status(400).json({ error: errorFechas });
    }

    // Cambiar el RFC o el ambiente no debe dejar este paso repetido con otro ya existente.
    const rfcNuevo = rfc !== undefined ? (rfc ? String(rfc).trim() : null) : antes.Rfc;
    const entornoNuevo = entorno !== undefined ? entorno : antes.Entorno;
    const cambioClave = (rfcNuevo || '').toLowerCase() !== (antes.Rfc || '').toLowerCase() || entornoNuevo !== antes.Entorno;
    if (cambioClave && rfcNuevo && !req.body.confirmarDuplicado) {
      const dup = await buscarDuplicado(pool, req.user, { rfc: rfcNuevo, entorno: entornoNuevo, googleEventId: null, excluirId: Number(req.params.id) });
      if (dup) {
        return res.status(409).json({
          duplicado: dup,
          error: dup.visible
            ? `Ya existe el paso «${dup.titulo}» con ese RFC y ambiente (lo creó ${dup.creadoPor}). Si es el mismo, fusiónalos en vez de repetirlo.`
            : `Ya existe un paso con ese RFC y ambiente, creado por ${dup.creadoPor}. Pídele que te agregue como participante para no duplicarlo.`,
        });
      }
    }

    // componenteId (sub-aplicativo elegido) tiene prioridad; aplicativoId se
    // conserva por compatibilidad. Sin ninguno de los dos se deja el actual.
    let aplicativoIdNormalizado = antes.AplicativoId;
    const idsComponentes = normalizarComponenteIds({ componenteIds, componenteId });
    try {
      if (idsComponentes && idsComponentes.length > 1 && !(await tablaComponentesLista(pool))) {
        return res.status(400).json({ error: MENSAJE_FALTA_TABLA_COMPONENTES });
      }
      if (idsComponentes) await validarComponentesExisten(pool, idsComponentes);
      const resuelto = await resolverAplicativo(pool, {
        componenteId: idsComponentes ? (idsComponentes[0] ?? null) : componenteId,
        aplicativoId,
      });
      if (resuelto.cambia) aplicativoIdNormalizado = resuelto.aplicativoId;
    } catch (errorAplicativo) {
      if (errorAplicativo.status === 400) return res.status(400).json({ error: errorAplicativo.message });
      throw errorAplicativo;
    }
    const c = commit !== undefined
      ? normalizarCommit(commit)
      : { CommitId: antes.CommitId, CommitRepo: antes.CommitRepo, CommitRama: antes.CommitRama, CommitMensaje: antes.CommitMensaje, CommitAutor: antes.CommitAutor, CommitFecha: antes.CommitFecha, CommitUrl: antes.CommitUrl };

    await pool.query(
      `UPDATE PasosProduccion
       SET Rfc = ?, Titulo = ?, Entorno = ?, AplicativoId = ?, FechaHoraProgramada = ?, FechaHoraEstimadaFin = ?,
           FechaHoraInicioReal = ?, FechaHoraFinReal = ?, Descripcion = ?, GoogleEventId = ?,
           CommitId = ?, CommitRepo = ?, CommitRama = ?, CommitMensaje = ?, CommitAutor = ?, CommitFecha = ?, CommitUrl = ?
       WHERE Id = ?`,
      [
        rfc !== undefined ? (rfc ? String(rfc).trim() : null) : antes.Rfc,
        titulo !== undefined && String(titulo).trim() ? String(titulo).trim() : antes.Titulo,
        entorno !== undefined ? entorno : antes.Entorno,
        aplicativoIdNormalizado,
        fechaHoraProgramada !== undefined ? fechaHoraProgramada : antes.FechaHoraProgramada,
        fechaHoraEstimadaFin !== undefined ? (fechaHoraEstimadaFin || null) : antes.FechaHoraEstimadaFin,
        fechaHoraInicioReal !== undefined ? (fechaHoraInicioReal || null) : antes.FechaHoraInicioReal,
        fechaHoraFinReal !== undefined ? (fechaHoraFinReal || null) : antes.FechaHoraFinReal,
        descripcion !== undefined ? (descripcion ? String(descripcion).trim() : null) : antes.Descripcion,
        // googleEventId: permite vincular (o quitar, mandando null/'') un evento de
        // calendario ya existente a un registro de la bitácora que ya existía --
        // el flujo de "crear bitácora desde el evento" lo manda al crear en vez de
        // acá, así que en la práctica este campo casi siempre llega en un PUT aparte.
        googleEventId !== undefined ? (googleEventId || null) : antes.GoogleEventId,
        c.CommitId, c.CommitRepo, c.CommitRama, c.CommitMensaje, c.CommitAutor, c.CommitFecha, c.CommitUrl,
        req.params.id,
      ]
    );

    // Lista completa de servidores del paso (solo si el cliente la mandó).
    if (idsComponentes && await tablaComponentesLista(pool)) {
      await guardarComponentesDelPaso(pool, req.params.id, idsComponentes);
    }
    // Servicios del BUS (solo si el cliente los mandó).
    if (vs.ids !== undefined && (vs.ids.length || await acceso.serviciosListos(pool))) {
      await guardarServicios(pool, req.params.id, vs.ids);
    }

    let nuevosParticipantes = [];
    if (Array.isArray(equipo)) {
      // Quien creó el paso ya es parte del mismo: no se repite como participante.
      const listaEquipo = [...new Set(equipo.map(Number).filter((n) => n && n !== Number(antes.CreadoPorId)))];
      const previos = new Set((antes.equipo || []).map((e) => Number(e.id)));
      nuevosParticipantes = listaEquipo.filter((u) => !previos.has(u));
      await pool.query('DELETE FROM PasosProduccionEquipo WHERE PasoId = ?', [req.params.id]);
      if (listaEquipo.length) {
        await pool.query(
          `INSERT INTO PasosProduccionEquipo (PasoId, UsuarioId) VALUES ?`,
          [listaEquipo.map((usuarioId) => [req.params.id, usuarioId])]
        );
      }
    }

    const despues = await obtenerPasoCompleto(pool, req.params.id, req.user);
    const cambios = diffCampos(antes, despues, CAMPOS_AUDITADOS_PASO, ETIQUETAS_CAMPOS_PASO);
    await registrarEventoGeneral(pool, req, {
      modulo: 'PASOS_PRODUCCION',
      entidad: 'PasoProduccion',
      entidadId: req.params.id,
      entidadNombre: despues.Titulo,
      accion: 'ACTUALIZACION',
      cambios,
    });
    await avisarParticipantes(pool, req, req.params.id, despues.Titulo, despues.Rfc, nuevosParticipantes);

    res.json(despues);
  } catch (error) {
    console.error('Error al actualizar el registro de la bitácora:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  }
});

// ==========================================================
// PATCH /api/pasos-produccion/:id/estado -- documentar la ejecución, o
// cancelar/reagendar/rollback (estos tres exigen `motivo`).
// ==========================================================
router.patch('/:id/estado', requireEditPermission, async (req, res) => {
  const { estado, motivo, resultadoEjecucion, fechaHoraInicioReal, fechaHoraFinReal } = req.body;
  let nuevaFecha = null;

  if (!ESTADOS_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: `El estado debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}.` });
  }
  if (ESTADOS_QUE_REQUIEREN_MOTIVO.has(estado) && (!motivo || !String(motivo).trim())) {
    return res.status(400).json({
      error: `Para marcar el paso como ${estado.toLowerCase()} debes indicar el motivo.`,
    });
  }

  if (ESTADOS_QUE_REQUIEREN_NUEVA_FECHA.has(estado)) {
    const f = String(req.body.fechaHoraProgramada || '').trim();
    if (!f) {
      return res.status(400).json({ error: `Para marcar el paso como ${estado.toLowerCase()} debes indicar la nueva fecha y hora de despliegue.` });
    }
    if (!RE_FECHA_HORA.test(f) || Number.isNaN(new Date(f.replace(' ', 'T')).getTime())) {
      return res.status(400).json({ error: 'La nueva fecha de despliegue no es válida.' });
    }
    nuevaFecha = f.replace('T', ' ').length === 16 ? `${f.replace('T', ' ')}:00` : f.replace('T', ' ');
  }

  try {
    const pool = await getPool();
    const antes = await obtenerPasoCompleto(pool, req.params.id, req.user);
    if (!antes) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });

    const esEjecucion = estado === 'EJECUTADO';
    // Duración real: si el frontend manda explícitamente las fechas (lo hace
    // al marcar EJECUTADO, prellenadas con "ahora" pero editables), se usan
    // tal cual. Si no las manda, se completan solas la primera vez que el
    // registro pasa a EJECUTADO (igual criterio que FechaCompletada en
    // Tareas) -- así nunca queda en blanco por olvido, pero tampoco se pisa
    // un valor ya guardado antes.
    const inicioReal = fechaHoraInicioReal !== undefined
      ? (fechaHoraInicioReal || null)
      : (esEjecucion ? (antes.FechaHoraInicioReal || new Date()) : antes.FechaHoraInicioReal);
    const finReal = fechaHoraFinReal !== undefined
      ? (fechaHoraFinReal || null)
      : (esEjecucion ? new Date() : antes.FechaHoraFinReal);
    if (esEjecucion) {
      const errorFechas = errorSiFinAnterior(inicioReal, finReal, MSG_FIN_REAL_ANTERIOR);
      if (errorFechas) return res.status(400).json({ error: errorFechas });
    }

    await pool.query(
      `UPDATE PasosProduccion
       SET Estado = ?,
           MotivoEstado = ?,
           ResultadoEjecucion = ?,
           EjecutadoPorId = ?,
           FechaHoraInicioReal = ?,
           FechaHoraFinReal = ?,
           FechaHoraEstimadaFin = IF(? IS NULL OR FechaHoraEstimadaFin IS NULL OR FechaHoraProgramada IS NULL, FechaHoraEstimadaFin,
                                     DATE_ADD(FechaHoraEstimadaFin, INTERVAL TIMESTAMPDIFF(SECOND, FechaHoraProgramada, ?) SECOND)),
           FechaHoraProgramada = COALESCE(?, FechaHoraProgramada)
       WHERE Id = ?`,
      [
        estado,
        ESTADOS_QUE_REQUIEREN_MOTIVO.has(estado) ? String(motivo).trim() : null,
        resultadoEjecucion !== undefined ? (resultadoEjecucion ? String(resultadoEjecucion).trim() : null) : antes.ResultadoEjecucion,
        esEjecucion ? req.user.id : antes.EjecutadoPorId,
        inicioReal,
        finReal,
        nuevaFecha,
        nuevaFecha,
        nuevaFecha,
        req.params.id,
      ]
    );

    const despues = await obtenerPasoCompleto(pool, req.params.id, req.user);
    const cambios = diffCampos(antes, despues, CAMPOS_AUDITADOS_PASO, ETIQUETAS_CAMPOS_PASO);
    await registrarEventoGeneral(pool, req, {
      modulo: 'PASOS_PRODUCCION',
      entidad: 'PasoProduccion',
      entidadId: req.params.id,
      entidadNombre: despues.Titulo,
      accion: 'CAMBIO_ESTADO',
      detalle: nuevaFecha ? `Nuevo estado: ${estado}. Nueva fecha de despliegue: ${nuevaFecha}.` : `Nuevo estado: ${estado}.`,
      cambios,
    });

    // Avisa al resto del equipo (y a quien lo creó) del cambio de estado.
    if (estado !== antes.Estado && estado !== 'PROGRAMADO') {
      try {
        const [equipo] = await pool.query('SELECT UsuarioId FROM PasosProduccionEquipo WHERE PasoId = ?', [req.params.id]);
        const etiquetas = { EJECUTADO: 'ejecutado', CANCELADO: 'cancelado', REAGENDADO: 'reagendado', ROLLBACK: 'en rollback' };
        const quien = req.user?.nombre_completo || req.user?.username || 'Alguien';
        await notificarVarios(pool, [despues.CreadoPorId, ...equipo.map((e) => e.UsuarioId)], {
          tipo: 'PASO_ESTADO', severidad: estado === 'EJECUTADO' ? 'INFO' : 'AVISO',
          titulo: `Paso a producción ${etiquetas[estado] || estado.toLowerCase()}`, referencia: Number(req.params.id), enlace: '/pasos-produccion',
          mensaje: `${quien} marcó «${despues.Rfc ? `${despues.Rfc} · ` : ''}${despues.Titulo}» como ${etiquetas[estado] || estado.toLowerCase()}${nuevaFecha ? `; nueva fecha de despliegue: ${nuevaFecha.slice(0, 16)}` : ''}.`,
        }, req.user.id);
      } catch (e) {
        console.error('No se pudo avisar el cambio de estado del paso:', e.message);
      }
    }

    res.json(despues);
  } catch (error) {
    console.error('Error al cambiar el estado del paso a producción:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el estado del paso a producción' }) });
  }
});

// ==========================================================
// Eliminar (lógico o definitivo), restaurar y ocultar
//  · POST   /:id/eliminar     -> eliminación LÓGICA: pasa a «Eliminados» (se puede restaurar).
//  · POST   /:id/restaurar    -> lo saca de «Eliminados».
//  · DELETE /:id              -> eliminación FÍSICA (definitiva): borra el registro y TODO lo que cuelga de él
//                                (checklist, evidencias/adjuntos, participantes, servidores, servicios, accesos
//                                compartidos y sus avisos). Queda un único evento en la auditoría general.
//  · POST   /:id/ocultar|mostrar -> oculta/muestra el paso SOLO en mi vista principal.
//  · POST   /acciones-masivas -> lo mismo sobre varios pasos a la vez.
// ==========================================================
const MAX_MASIVAS = 200;
const etiquetaPaso = (f) => `${f.Rfc ? `${f.Rfc} · ` : ''}${f.Titulo}`;
const falla = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

async function cargarParaAccion(pool, req, id) {
  const info = await acceso.nivelDePaso(pool, req.user, id);
  if (!info.existe || !info.nivel) return { error: falla(404, 'Registro de bitácora no encontrado.') };
  const lista = await acceso.eliminacionLista(pool);
  const [[fila]] = await pool.query(`SELECT Id, Titulo, Rfc${lista ? ', Eliminado' : ''} FROM PasosProduccion WHERE Id = ?`, [id]);
  return { info, paso: fila, eliminado: lista && Number(fila.Eliminado) === 1 };
}

async function opEliminarLogico(pool, req, id, motivo) {
  if (!(await acceso.eliminacionLista(pool))) return falla(409, acceso.MENSAJE_SIN_ELIMINACION, { codigo: 'SIN_ESQUEMA' });
  const c = await cargarParaAccion(pool, req, id);
  if (c.error) return c.error;
  const titulo = etiquetaPaso(c.paso);
  if (!acceso.puedeEditarNivel(c.info.nivel)) {
    return falla(403, 'Solo quien creó el paso, quien participa en él o tiene permiso de edición puede eliminarlo.', { titulo });
  }
  if (c.eliminado) return { ok: true, sinCambios: true, titulo };
  const razon = String(motivo || '').trim().slice(0, 500) || null;
  await pool.query(
    'UPDATE PasosProduccion SET Eliminado = 1, EliminadoEn = NOW(), EliminadoPorId = ?, MotivoEliminacion = ? WHERE Id = ?',
    [req.user.id, razon, id]
  );
  try {
    await pool.query("UPDATE notificaciones SET Activo = 0 WHERE Referencia = ? AND Tipo IN ('PASO_PROXIMO','PASO_SIN_CERRAR')", [id]);
  } catch (e) { console.error('No se pudieron apagar los avisos del paso eliminado:', e.message); }
  await registrarEventoGeneral(pool, req, {
    modulo: 'PASOS_PRODUCCION', entidad: 'PasoProduccion', entidadId: id, entidadNombre: c.paso.Titulo, accion: 'ELIMINACION_LOGICA',
    detalle: `Movido a «Eliminados»${razon ? `. Motivo: ${razon}` : ''}.`,
  });
  return { ok: true, titulo };
}

async function opRestaurar(pool, req, id) {
  if (!(await acceso.eliminacionLista(pool))) return falla(409, acceso.MENSAJE_SIN_ELIMINACION, { codigo: 'SIN_ESQUEMA' });
  const c = await cargarParaAccion(pool, req, id);
  if (c.error) return c.error;
  const titulo = etiquetaPaso(c.paso);
  if (!acceso.puedeEditarNivel(c.info.nivel)) {
    return falla(403, 'Solo quien creó el paso, quien participa en él o tiene permiso de edición puede restaurarlo.', { titulo });
  }
  if (!c.eliminado) return { ok: true, sinCambios: true, titulo };
  await pool.query('UPDATE PasosProduccion SET Eliminado = 0, EliminadoEn = NULL, EliminadoPorId = NULL, MotivoEliminacion = NULL WHERE Id = ?', [id]);
  await registrarEventoGeneral(pool, req, {
    modulo: 'PASOS_PRODUCCION', entidad: 'PasoProduccion', entidadId: id, entidadNombre: c.paso.Titulo, accion: 'RESTAURACION',
    detalle: 'Restaurado desde «Eliminados» a la bitácora principal.',
  });
  return { ok: true, titulo };
}

async function contarSeguro(pool, sql, params) {
  try { const [[f]] = await pool.query(sql, params); return Number(f.total) || 0; } catch (e) { return 0; }
}

async function opEliminarDefinitivo(pool, req, id) {
  const c = await cargarParaAccion(pool, req, id);
  if (c.error) return c.error;
  const titulo = etiquetaPaso(c.paso);
  if (c.info.nivel !== 'PROPIETARIO') {
    return falla(403, 'Solo quien creó el paso puede eliminarlo definitivamente.', { titulo });
  }
  const nCheck = await contarSeguro(pool, 'SELECT COUNT(*) AS total FROM PasoProduccionChecklist WHERE PasoId = ?', [id]);
  const nAdj = await contarSeguro(pool, 'SELECT COUNT(*) AS total FROM PasoProduccionAdjuntos WHERE PasoId = ?', [id]);
  const nEq = await contarSeguro(pool, 'SELECT COUNT(*) AS total FROM PasosProduccionEquipo WHERE PasoId = ?', [id]);
  const nAcc = (await acceso.accesosListos(pool)) ? await contarSeguro(pool, 'SELECT COUNT(*) AS total FROM BitacoraAccesos WHERE PasoId = ?', [id]) : 0;

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    // Avisos que apuntan a este paso (no hay FK): se borran para no dejar enlaces rotos.
    try { await conexion.query("DELETE FROM notificaciones WHERE Referencia = ? AND Tipo LIKE 'PASO\\_%'", [id]); } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    // Las tablas hijas (checklist, adjuntos, equipo, servidores, servicios, ocultos, accesos) tienen ON DELETE CASCADE.
    await conexion.query('DELETE FROM PasosProduccion WHERE Id = ?', [id]);
    await conexion.commit();
  } catch (error) {
    await conexion.rollback().catch(() => {});
    throw error;
  } finally {
    conexion.release();
  }
  await registrarEventoGeneral(pool, req, {
    modulo: 'PASOS_PRODUCCION', entidad: 'PasoProduccion', entidadId: id, entidadNombre: c.paso.Titulo, accion: 'ELIMINACION',
    detalle: `Eliminación definitiva${c.eliminado ? ' (desde «Eliminados»)' : ''}: se borró el registro con ${nCheck} ítem(s) de checklist, ${nAdj} adjunto(s)/evidencia(s), ${nEq} participante(s) y ${nAcc} acceso(s) compartido(s).`,
  });
  return { ok: true, titulo };
}

async function opOcultar(pool, req, id, ocultar) {
  if (!(await acceso.ocultosListos(pool))) return falla(409, acceso.MENSAJE_SIN_ELIMINACION, { codigo: 'SIN_ESQUEMA' });
  const c = await cargarParaAccion(pool, req, id);
  if (c.error) return c.error;
  const titulo = etiquetaPaso(c.paso);
  if (ocultar) await pool.query('INSERT IGNORE INTO PasosProduccionOcultos (PasoId, UsuarioId) VALUES (?, ?)', [id, req.user.id]);
  else await pool.query('DELETE FROM PasosProduccionOcultos WHERE PasoId = ? AND UsuarioId = ?', [id, req.user.id]);
  return { ok: true, titulo };
}

function responderOp(res, r, exito = 200) {
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error, codigo: r.codigo });
  return exito === 204 ? res.status(204).send() : res.json({ ok: true, sinCambios: !!r.sinCambios });
}

const idValido = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

router.post('/acciones-masivas', async (req, res) => {
  try {
    const pool = await getPool();
    const accion = String((req.body && req.body.accion) || '');
    const ACCIONES = ['ocultar', 'mostrar', 'eliminar', 'restaurar', 'eliminar-definitivo'];
    if (!ACCIONES.includes(accion)) return res.status(400).json({ error: `La acción debe ser una de: ${ACCIONES.join(', ')}.` });
    const ids = [...new Set((Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(idValido).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ error: 'Elige al menos un registro.' });
    if (ids.length > MAX_MASIVAS) return res.status(400).json({ error: `Puedes procesar hasta ${MAX_MASIVAS} registros a la vez.` });
    // Ocultar/mostrar es personal; el resto requiere poder escribir en el módulo (como los botones individuales).
    if (accion !== 'ocultar' && accion !== 'mostrar' && req.user.rol !== 'ADMIN_POD') {
      const rol = await rolEnModulo(req, 'PASOS_PRODUCCION');
      if (rol === null || rol === ROL_CONSULTA) {
        return res.status(403).json({ error: 'Tu rol en este módulo es de Consulta (solo lectura). Contacta al ADMIN_POD.' });
      }
    }
    const motivo = req.body && req.body.motivo;
    let procesados = 0;
    const omitidos = [];
    for (const id of ids) {
      let r;
      try {
        if (accion === 'ocultar') r = await opOcultar(pool, req, id, true);
        else if (accion === 'mostrar') r = await opOcultar(pool, req, id, false);
        else if (accion === 'eliminar') r = await opEliminarLogico(pool, req, id, motivo);
        else if (accion === 'restaurar') r = await opRestaurar(pool, req, id);
        else r = await opEliminarDefinitivo(pool, req, id);
      } catch (e) {
        console.error(`Acción masiva «${accion}» sobre el paso ${id}:`, e);
        r = falla(500, 'No se pudo completar.');
      }
      if (r.ok) procesados += 1;
      else {
        if (r.codigo === 'SIN_ESQUEMA') return res.status(409).json({ error: r.error, codigo: r.codigo });
        omitidos.push({ id, titulo: r.titulo || null, motivo: r.error });
      }
    }
    res.json({ accion, procesados, omitidos });
  } catch (error) {
    console.error('Error en la acción masiva sobre pasos a producción:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la bitácora de pasos a producción' }) });
  }
});

router.post('/:id/eliminar', requireEditPermission, async (req, res) => {
  try {
    const id = idValido(req.params.id);
    if (!id) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    responderOp(res, await opEliminarLogico(await getPool(), req, id, req.body && req.body.motivo));
  } catch (error) {
    console.error('Error al mover el registro a Eliminados:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  }
});

router.post('/:id/restaurar', requireEditPermission, async (req, res) => {
  try {
    const id = idValido(req.params.id);
    if (!id) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    responderOp(res, await opRestaurar(await getPool(), req, id));
  } catch (error) {
    console.error('Error al restaurar el registro:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  }
});

router.delete('/:id', requireEditPermission, async (req, res) => {
  try {
    const id = idValido(req.params.id);
    if (!id) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    responderOp(res, await opEliminarDefinitivo(await getPool(), req, id), 204);
  } catch (error) {
    console.error('Error al eliminar el registro de la bitácora:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  }
});

router.post('/:id/ocultar', async (req, res) => {
  try {
    const id = idValido(req.params.id);
    if (!id) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    responderOp(res, await opOcultar(await getPool(), req, id, true));
  } catch (error) {
    console.error('Error al ocultar el registro:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  }
});

router.post('/:id/mostrar', async (req, res) => {
  try {
    const id = idValido(req.params.id);
    if (!id) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    responderOp(res, await opOcultar(await getPool(), req, id, false));
  } catch (error) {
    console.error('Error al mostrar el registro:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el registro de la bitácora' }) });
  }
});

// Chequeo liviano de existencia -- lo usan los tres bloques de abajo
// (checklist, adjuntos, historial) sin tener que traer el registro completo
// con sus joins cada vez.
async function pasoExiste(pool, pasoId) {
  const [[fila]] = await pool.query('SELECT Id, Titulo FROM PasosProduccion WHERE Id = ?', [pasoId]);
  return fila || null;
}

// Select compartido para un ítem de checklist -- incluye, vía subconsulta,
// el último adjunto (si lo hay) marcado como evidencia de ESE ítem
// (PasoProduccionAdjuntos.ChecklistItemId). Se usa en los cuatro endpoints
// de abajo para que el frontend siempre reciba el mismo shape, tenga o no
// evidencia el ítem.
const SELECT_CHECKLIST_ITEM = `
  SELECT c.Id, c.Descripcion, c.Completado, c.Orden,
         c.CompletadoPorId, uc.nombre_completo AS CompletadoPorNombre, c.FechaCompletado, c.FechaCreacion,
         ev.Id AS EvidenciaAdjuntoId, ev.NombreOriginal AS EvidenciaNombre
  FROM PasoProduccionChecklist c
  LEFT JOIN usuarios uc ON uc.id = c.CompletadoPorId
  LEFT JOIN PasoProduccionAdjuntos ev ON ev.Id = (
    SELECT a.Id FROM PasoProduccionAdjuntos a WHERE a.ChecklistItemId = c.Id ORDER BY a.FechaSubida DESC LIMIT 1
  )
`;

// Agrega a cada ítem la lista COMPLETA de evidencias (imágenes) que tiene, no
// solo la última: un ítem puede tener varias y se conservan aunque el ítem se
// desmarque (reabrir nunca borra evidencias). Sin contenido, solo metadatos.
async function agregarEvidencias(pool, items) {
  const lista = Array.isArray(items) ? items : [items];
  const ids = lista.map((i) => i.Id);
  const porItem = new Map();
  if (ids.length) {
    const [filas] = await pool.query(
      `SELECT a.Id, a.ChecklistItemId, a.NombreOriginal, a.TamanoBytes, a.FechaSubida, us.nombre_completo AS SubidoPorNombre
         FROM PasoProduccionAdjuntos a
         LEFT JOIN usuarios us ON us.id = a.SubidoPorId
        WHERE a.ChecklistItemId IN (?)
        ORDER BY a.FechaSubida ASC, a.Id ASC`,
      [ids]
    );
    filas.forEach((f) => {
      const l = porItem.get(f.ChecklistItemId) || [];
      l.push({ Id: f.Id, NombreOriginal: f.NombreOriginal, TamanoBytes: f.TamanoBytes, FechaSubida: f.FechaSubida, SubidoPorNombre: f.SubidoPorNombre });
      porItem.set(f.ChecklistItemId, l);
    });
  }
  const conEvidencias = lista.map((i) => ({ ...i, Evidencias: porItem.get(i.Id) || [] }));
  return Array.isArray(items) ? conEvidencias : conEvidencias[0];
}

// ==========================================================
// Checklist de sub-pasos -- mismo criterio de permisos que el resto del
// registro: cualquiera con el módulo puede ver, solo ADMIN_POD/ADMIN_MIN
// puede agregar/marcar/eliminar ítems (requireEditPermission).
// ==========================================================
router.get('/:id/checklist', async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await pasoExiste(pool, req.params.id))) {
      return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    }
    const [items] = await pool.query(
      `${SELECT_CHECKLIST_ITEM} WHERE c.PasoId = ? ORDER BY c.Orden ASC, c.Id ASC`,
      [req.params.id]
    );
    res.json(await agregarEvidencias(pool, items));
  } catch (error) {
    console.error('Error al listar el checklist:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el checklist del registro' }) });
  }
});

router.post('/:id/checklist', requireEditPermission, async (req, res) => {
  const { descripcion } = req.body;
  if (!descripcion || !String(descripcion).trim()) {
    return res.status(400).json({ error: 'La descripción del ítem del checklist es obligatoria.' });
  }
  try {
    const pool = await getPool();
    const paso = await pasoExiste(pool, req.params.id);
    if (!paso) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });

    const [[{ siguienteOrden }]] = await pool.query(
      'SELECT COALESCE(MAX(Orden), -1) + 1 AS siguienteOrden FROM PasoProduccionChecklist WHERE PasoId = ?',
      [req.params.id]
    );
    const [resultado] = await pool.query(
      `INSERT INTO PasoProduccionChecklist (PasoId, Descripcion, Orden, CreadoPorId) VALUES (?, ?, ?, ?)`,
      [req.params.id, String(descripcion).trim().slice(0, 255), siguienteOrden, req.user.id]
    );

    await registrarEventoGeneral(pool, req, {
      modulo: 'PASOS_PRODUCCION',
      entidad: 'PasoProduccion',
      entidadId: req.params.id,
      entidadNombre: paso.Titulo,
      accion: 'CHECKLIST_AGREGADO',
      detalle: `Ítem de checklist agregado: "${String(descripcion).trim()}".`,
    });

    const [[item]] = await pool.query(`${SELECT_CHECKLIST_ITEM} WHERE c.Id = ?`, [resultado.insertId]);
    res.status(201).json(await agregarEvidencias(pool, item));
  } catch (error) {
    console.error('Error al agregar el ítem del checklist:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el ítem del checklist' }) });
  }
});

router.put('/:id/checklist/:itemId', requireEditPermission, async (req, res) => {
  const { descripcion, completado } = req.body;
  try {
    const pool = await getPool();
    const paso = await pasoExiste(pool, req.params.id);
    if (!paso) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });

    const [[antes]] = await pool.query(
      'SELECT Id, Descripcion, Completado FROM PasoProduccionChecklist WHERE Id = ? AND PasoId = ?',
      [req.params.itemId, req.params.id]
    );
    if (!antes) return res.status(404).json({ error: 'Ítem de checklist no encontrado.' });

    const nuevoCompletado = completado !== undefined ? !!completado : !!antes.Completado;
    const cambioEstado = nuevoCompletado !== !!antes.Completado;

    await pool.query(
      `UPDATE PasoProduccionChecklist
       SET Descripcion = ?, Completado = ?,
           CompletadoPorId = ?, FechaCompletado = ?
       WHERE Id = ?`,
      [
        descripcion !== undefined && String(descripcion).trim() ? String(descripcion).trim().slice(0, 255) : antes.Descripcion,
        nuevoCompletado ? 1 : 0,
        nuevoCompletado ? req.user.id : null,
        nuevoCompletado ? new Date() : null,
        req.params.itemId,
      ]
    );

    if (cambioEstado) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'PASOS_PRODUCCION',
        entidad: 'PasoProduccion',
        entidadId: req.params.id,
        entidadNombre: paso.Titulo,
        accion: nuevoCompletado ? 'CHECKLIST_COMPLETADO' : 'CHECKLIST_REABIERTO',
        detalle: `"${antes.Descripcion}"`,
      });
    }

    const [[item]] = await pool.query(`${SELECT_CHECKLIST_ITEM} WHERE c.Id = ?`, [req.params.itemId]);
    res.json(await agregarEvidencias(pool, item));
  } catch (error) {
    console.error('Error al actualizar el ítem del checklist:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el ítem del checklist' }) });
  }
});

// POST /api/pasos-produccion/:id/checklist/:itemId/evidencia
// Marca el ítem como completado Y adjunta de una sola vez el pantallazo de
// evidencia -- pensado para el marcado "en línea" desde la vista principal
// (ver el pedido del usuario: "que permita marcarlo y que deba agregar un
// pantallazo de la evidencia"), donde no tiene sentido dejar el ítem
// completado sin su evidencia ni viceversa. Todo en una transacción: si el
// adjunto no se puede guardar, el ítem tampoco queda marcado.
// (El checkbox simple del detalle del registro, PUT de arriba, se deja tal
// cual -- sigue sin exigir evidencia, no se le cambia su comportamiento ya
// existente.)
router.post('/:id/checklist/:itemId/evidencia', requireEditPermission, async (req, res) => {
  const { nombreOriginal, mimeType, contenidoBase64 } = req.body;
  // `completar: false` solo agrega la imagen al ítem (para subir varias, o
  // sumar más a un ítem ya marcado o desmarcado) sin cambiar su estado. Por
  // defecto sigue marcando el ítem como completado, como siempre.
  const completar = req.body.completar !== false;

  if (!nombreOriginal || !String(nombreOriginal).trim()) {
    return res.status(400).json({ error: 'Falta el nombre del archivo de evidencia.' });
  }
  const extension = String(nombreOriginal).trim().split('.').pop()?.toLowerCase();
  if (!extension || !EXTENSIONES_EVIDENCIA_CHECKLIST.has(extension)) {
    return res.status(400).json({
      error: `La evidencia debe ser una imagen (pantallazo). Extensiones válidas: ${[...EXTENSIONES_EVIDENCIA_CHECKLIST].join(', ')}.`,
    });
  }
  if (!contenidoBase64 || typeof contenidoBase64 !== 'string') {
    return res.status(400).json({ error: 'Falta el contenido de la imagen de evidencia.' });
  }
  const coincidencia = contenidoBase64.match(/^data:([^;]+);base64,(.+)$/s);
  const base64Puro = coincidencia ? coincidencia[2] : contenidoBase64;
  const mimeTypeFinal = mimeType || (coincidencia ? coincidencia[1] : 'application/octet-stream');
  const tamanoBytes = Math.floor((base64Puro.length * 3) / 4);
  if (tamanoBytes > TAMANO_MAXIMO_ADJUNTO_BYTES) {
    return res.status(400).json({
      error: `La imagen supera el tamaño máximo permitido (${Math.round(TAMANO_MAXIMO_ADJUNTO_BYTES / (1024 * 1024))} MB).`,
    });
  }

  const conexion = await (await getPool()).getConnection();
  try {
    await conexion.beginTransaction();

    const [[paso]] = await conexion.query('SELECT Id, Titulo FROM PasosProduccion WHERE Id = ?', [req.params.id]);
    if (!paso) { await conexion.rollback(); return res.status(404).json({ error: 'Registro de bitácora no encontrado.' }); }

    const [[antes]] = await conexion.query(
      'SELECT Id, Descripcion, Completado FROM PasoProduccionChecklist WHERE Id = ? AND PasoId = ?',
      [req.params.itemId, req.params.id]
    );
    if (!antes) { await conexion.rollback(); return res.status(404).json({ error: 'Ítem de checklist no encontrado.' }); }

    const [resultadoAdjunto] = await conexion.query(
      `INSERT INTO PasoProduccionAdjuntos (PasoId, ChecklistItemId, NombreOriginal, MimeType, TamanoBytes, ContenidoBase64, SubidoPorId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, req.params.itemId, String(nombreOriginal).trim().slice(0, 255), mimeTypeFinal.slice(0, 100), tamanoBytes, base64Puro, req.user.id]
    );

    if (completar) {
      await conexion.query(
        `UPDATE PasoProduccionChecklist SET Completado = 1, CompletadoPorId = ?, FechaCompletado = ? WHERE Id = ?`,
        [req.user.id, new Date(), req.params.itemId]
      );
    }

    await conexion.commit();

    const pool = await getPool();
    if (!completar) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'PASOS_PRODUCCION',
        entidad: 'PasoProduccion',
        entidadId: req.params.id,
        entidadNombre: paso.Titulo,
        accion: 'ADJUNTO_AGREGADO',
        detalle: `Evidencia agregada al ítem "${antes.Descripcion}": "${String(nombreOriginal).trim()}".`,
      });
    } else if (!antes.Completado) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'PASOS_PRODUCCION',
        entidad: 'PasoProduccion',
        entidadId: req.params.id,
        entidadNombre: paso.Titulo,
        accion: 'CHECKLIST_COMPLETADO',
        detalle: `"${antes.Descripcion}" (con evidencia: "${String(nombreOriginal).trim()}").`,
      });
    }

    const [[itemBase]] = await pool.query(`${SELECT_CHECKLIST_ITEM} WHERE c.Id = ?`, [req.params.itemId]);
    const item = await agregarEvidencias(pool, itemBase);
    const [[adjunto]] = await pool.query(
      `SELECT a.Id, a.NombreOriginal, a.MimeType, a.TamanoBytes, a.SubidoPorId, us.nombre_completo AS SubidoPorNombre, a.FechaSubida
       FROM PasoProduccionAdjuntos a LEFT JOIN usuarios us ON us.id = a.SubidoPorId WHERE a.Id = ?`,
      [resultadoAdjunto.insertId]
    );
    res.status(201).json({ item, adjunto });
  } catch (error) {
    await conexion.rollback();
    console.error('Error al completar el ítem del checklist con evidencia:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la evidencia del ítem del checklist' }) });
  } finally {
    conexion.release();
  }
});

router.delete('/:id/checklist/:itemId', requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const paso = await pasoExiste(pool, req.params.id);
    if (!paso) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });

    const [[item]] = await pool.query(
      'SELECT Id, Descripcion FROM PasoProduccionChecklist WHERE Id = ? AND PasoId = ?',
      [req.params.itemId, req.params.id]
    );
    if (!item) return res.status(404).json({ error: 'Ítem de checklist no encontrado.' });

    await pool.query('DELETE FROM PasoProduccionChecklist WHERE Id = ?', [req.params.itemId]);
    await registrarEventoGeneral(pool, req, {
      modulo: 'PASOS_PRODUCCION',
      entidad: 'PasoProduccion',
      entidadId: req.params.id,
      entidadNombre: paso.Titulo,
      accion: 'CHECKLIST_ELIMINADO',
      detalle: `"${item.Descripcion}"`,
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar el ítem del checklist:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el ítem del checklist' }) });
  }
});

// ==========================================================
// Adjuntos/evidencias -- igual criterio de permisos que el checklist. El
// contenido viaja en base64 (ver nota de EXTENSIONES_ADJUNTO_VALIDAS arriba)
// -- el listado NUNCA incluye el contenido, solo metadatos, para que abrir
// el registro no descargue de una vez todos los archivos adjuntos.
// ==========================================================
router.get('/:id/adjuntos', async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await pasoExiste(pool, req.params.id))) {
      return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    }
    const [adjuntos] = await pool.query(
      `SELECT a.Id, a.NombreOriginal, a.MimeType, a.TamanoBytes, a.ChecklistItemId,
              a.SubidoPorId, us.nombre_completo AS SubidoPorNombre, a.FechaSubida
       FROM PasoProduccionAdjuntos a
       LEFT JOIN usuarios us ON us.id = a.SubidoPorId
       WHERE a.PasoId = ?
       ORDER BY a.FechaSubida DESC`,
      [req.params.id]
    );
    res.json(adjuntos);
  } catch (error) {
    console.error('Error al listar los adjuntos:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'los adjuntos del registro' }) });
  }
});

// Trae UN adjunto completo (con su contenido en base64) -- el frontend lo usa
// para armar la descarga (Blob) en el navegador, sin necesitar una ruta de
// streaming aparte.
router.get('/:id/adjuntos/:adjId', async (req, res) => {
  try {
    const pool = await getPool();
    const [[adjunto]] = await pool.query(
      `SELECT Id, PasoId, NombreOriginal, MimeType, TamanoBytes, ContenidoBase64, FechaSubida
       FROM PasoProduccionAdjuntos WHERE Id = ? AND PasoId = ?`,
      [req.params.adjId, req.params.id]
    );
    if (!adjunto) return res.status(404).json({ error: 'Adjunto no encontrado.' });
    res.json(adjunto);
  } catch (error) {
    console.error('Error al obtener el adjunto:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el adjunto' }) });
  }
});

router.post('/:id/adjuntos', requireEditPermission, async (req, res) => {
  const { nombreOriginal, mimeType, contenidoBase64 } = req.body;

  if (!nombreOriginal || !String(nombreOriginal).trim()) {
    return res.status(400).json({ error: 'Falta el nombre del archivo.' });
  }
  const extension = String(nombreOriginal).trim().split('.').pop()?.toLowerCase();
  if (!extension || !EXTENSIONES_ADJUNTO_VALIDAS.has(extension)) {
    return res.status(400).json({
      error: `Tipo de archivo no permitido. Extensiones válidas: ${[...EXTENSIONES_ADJUNTO_VALIDAS].join(', ')}.`,
    });
  }
  if (!contenidoBase64 || typeof contenidoBase64 !== 'string') {
    return res.status(400).json({ error: 'Falta el contenido del archivo.' });
  }
  // Acepta tanto un data URI completo ("data:...;base64,xxx") como el base64
  // puro -- el frontend arma el data URI con FileReader.readAsDataURL().
  const coincidencia = contenidoBase64.match(/^data:([^;]+);base64,(.+)$/s);
  const base64Puro = coincidencia ? coincidencia[2] : contenidoBase64;
  const mimeTypeFinal = mimeType || (coincidencia ? coincidencia[1] : 'application/octet-stream');

  const tamanoBytes = Math.floor((base64Puro.length * 3) / 4);
  if (tamanoBytes > TAMANO_MAXIMO_ADJUNTO_BYTES) {
    return res.status(400).json({
      error: `El archivo supera el tamaño máximo permitido (${Math.round(TAMANO_MAXIMO_ADJUNTO_BYTES / (1024 * 1024))} MB).`,
    });
  }

  try {
    const pool = await getPool();
    const paso = await pasoExiste(pool, req.params.id);
    if (!paso) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });

    const [resultado] = await pool.query(
      `INSERT INTO PasoProduccionAdjuntos (PasoId, NombreOriginal, MimeType, TamanoBytes, ContenidoBase64, SubidoPorId)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, String(nombreOriginal).trim().slice(0, 255), mimeTypeFinal.slice(0, 100), tamanoBytes, base64Puro, req.user.id]
    );

    await registrarEventoGeneral(pool, req, {
      modulo: 'PASOS_PRODUCCION',
      entidad: 'PasoProduccion',
      entidadId: req.params.id,
      entidadNombre: paso.Titulo,
      accion: 'ADJUNTO_AGREGADO',
      detalle: `Archivo adjunto: "${String(nombreOriginal).trim()}" (${Math.round(tamanoBytes / 1024)} KB).`,
    });

    const [[adjunto]] = await pool.query(
      `SELECT a.Id, a.NombreOriginal, a.MimeType, a.TamanoBytes,
              a.SubidoPorId, us.nombre_completo AS SubidoPorNombre, a.FechaSubida
       FROM PasoProduccionAdjuntos a
       LEFT JOIN usuarios us ON us.id = a.SubidoPorId
       WHERE a.Id = ?`,
      [resultado.insertId]
    );
    res.status(201).json(adjunto);
  } catch (error) {
    console.error('Error al subir el adjunto:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el adjunto' }) });
  }
});

router.delete('/:id/adjuntos/:adjId', requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const paso = await pasoExiste(pool, req.params.id);
    if (!paso) return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });

    const [[adjunto]] = await pool.query(
      'SELECT Id, NombreOriginal FROM PasoProduccionAdjuntos WHERE Id = ? AND PasoId = ?',
      [req.params.adjId, req.params.id]
    );
    if (!adjunto) return res.status(404).json({ error: 'Adjunto no encontrado.' });

    await pool.query('DELETE FROM PasoProduccionAdjuntos WHERE Id = ?', [req.params.adjId]);
    await registrarEventoGeneral(pool, req, {
      modulo: 'PASOS_PRODUCCION',
      entidad: 'PasoProduccion',
      entidadId: req.params.id,
      entidadNombre: paso.Titulo,
      accion: 'ADJUNTO_ELIMINADO',
      detalle: `"${adjunto.NombreOriginal}"`,
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar el adjunto:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el adjunto' }) });
  }
});

// ==========================================================
// Historial de cambios -- NO es una tabla propia: reutiliza AuditoriaGeneral
// (ver backend/utils/auditoriaGeneral.js), que ya registra cada creación,
// edición, cambio de estado, ítem de checklist y adjunto de este registro.
// Lectura abierta a cualquiera con el módulo habilitado (no solo ADMIN_POD
// como la pantalla de Auditoría general) -- es el mismo criterio de lectura
// que el resto de la bitácora.
// ==========================================================
router.get('/:id/historial', async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await pasoExiste(pool, req.params.id))) {
      return res.status(404).json({ error: 'Registro de bitácora no encontrado.' });
    }
    const [filas] = await pool.query(
      `SELECT Id, Accion, Detalle, CambiosJson, RealizadoPorUsername, FechaEvento
       FROM AuditoriaGeneral
       WHERE Entidad = 'PasoProduccion' AND EntidadId = ?
       ORDER BY FechaEvento DESC
       LIMIT 200`,
      [String(req.params.id)]
    );
    const eventos = filas.map((fila) => {
      let cambios = [];
      if (fila.CambiosJson) {
        try { cambios = JSON.parse(fila.CambiosJson); } catch (e) { cambios = []; }
      }
      const { CambiosJson, ...resto } = fila;
      return { ...resto, cambios };
    });
    res.json(eventos);
  } catch (error) {
    console.error('Error al obtener el historial del registro:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el historial del registro' }) });
  }
});

module.exports = router;
