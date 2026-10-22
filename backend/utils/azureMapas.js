// Conversión de las respuestas de Azure DevOps al formato simple (en español)
// que consume el frontend. Funciones puras: no llaman a la red.

const { ocultarSecretos } = require('./ocultarSecretos');

const DIA_MS = 86400000;
const HORA_MS = 3600000;

const sinRefs = (r) => String(r || '').replace(/^refs\/(heads|tags)\//, '');
const primeraLinea = (t) => String(t || '').split(/\r?\n/)[0].trim();

function nombreDe(persona) {
  if (!persona) return null;
  if (typeof persona === 'string') return persona.replace(/\s*<[^>]*>\s*$/, '') || null;
  return persona.displayName || persona.name || persona.uniqueName || null;
}

// Quita etiquetas HTML (descripciones/comentarios de work items vienen como HTML):
// el navegador solo recibe texto plano, nunca HTML ajeno.
function htmlATexto(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const duracionMs = (inicio, fin) => {
  if (!inicio || !fin) return null;
  const d = new Date(fin).getTime() - new Date(inicio).getTime();
  return Number.isFinite(d) && d >= 0 ? d : null;
};

// ------------------------------- Git ----------------------------------------

function mapearCommit(c, web, repo) {
  const id = c.commitId || c.id || '';
  return {
    id,
    idCorto: id.substring(0, 8),
    comentario: primeraLinea(c.comment),
    comentarioCompleto: c.comment || '',
    autor: c.author?.name || c.committer?.name || 'Desconocido',
    email: c.author?.email || null,
    fecha: c.author?.date || c.committer?.date || null,
    commitador: c.committer?.name || null,
    fechaCommit: c.committer?.date || null,
    padres: Array.isArray(c.parents) ? c.parents : [],
    esMerge: Array.isArray(c.parents) && c.parents.length > 1,
    cambios: c.changeCounts ? { agregados: c.changeCounts.Add || 0, editados: c.changeCounts.Edit || 0, eliminados: c.changeCounts.Delete || 0 } : null,
    url: web && repo ? web.commit(repo, id) : null,
  };
}

const TIPO_CAMBIO = (t) => {
  const s = String(t || '').toLowerCase();
  if (s.includes('rename')) return 'renombrado';
  if (s.includes('delete')) return 'eliminado';
  if (s.includes('add')) return 'agregado';
  if (s.includes('edit')) return 'editado';
  return s || 'editado';
};

function mapearCambio(ch) {
  return {
    ruta: ch.item?.path || ch.sourceServerItem || '',
    rutaAnterior: ch.sourceServerItem && ch.sourceServerItem !== ch.item?.path ? ch.sourceServerItem : null,
    tipo: TIPO_CAMBIO(ch.changeType),
    esCarpeta: !!ch.item?.isFolder,
  };
}

function resumenCambios(archivos) {
  return {
    agregados: archivos.filter((a) => a.tipo === 'agregado').length,
    editados: archivos.filter((a) => a.tipo === 'editado').length,
    eliminados: archivos.filter((a) => a.tipo === 'eliminado').length,
    renombrados: archivos.filter((a) => a.tipo === 'renombrado').length,
    total: archivos.length,
  };
}

// ------------------------------- Pull requests ----------------------------------

const VOTOS = { 10: 'Aprobado', 5: 'Aprobado con sugerencias', 0: 'Sin voto', '-5': 'Esperando al autor', '-10': 'Rechazado' };

function mapearRevisor(r) {
  return {
    nombre: nombreDe(r) || 'Desconocido',
    voto: r.vote || 0,
    votoTexto: r.hasDeclined ? 'Declinó' : (VOTOS[String(r.vote || 0)] || 'Sin voto'),
    requerido: !!r.isRequired,
    declino: !!r.hasDeclined,
  };
}

const ESTADO_MERGE = {
  succeeded: 'Sin conflictos', conflicts: 'Con conflictos', queued: 'Verificando', rejectedByPolicy: 'Rechazado por política',
  failure: 'Falló el merge', notSet: 'Sin evaluar',
};

function mapearPR(pr, web, repo, ahora = Date.now()) {
  const creado = pr.creationDate || null;
  const cerrado = pr.closedDate || null;
  const fin = cerrado ? new Date(cerrado).getTime() : ahora;
  const revisores = (pr.reviewers || []).map(mapearRevisor);
  const aprobados = revisores.filter((r) => r.voto >= 5).length;
  const rechazos = revisores.filter((r) => r.voto <= -5).length;
  return {
    id: pr.pullRequestId,
    titulo: pr.title || '(sin título)',
    descripcion: pr.description || '',
    estado: pr.status,
    esBorrador: !!pr.isDraft,
    autor: nombreDe(pr.createdBy) || 'Desconocido',
    ramaOrigen: sinRefs(pr.sourceRefName),
    ramaDestino: sinRefs(pr.targetRefName),
    creado, cerrado,
    horasAbierto: creado ? Math.max(0, Math.round(((fin - new Date(creado).getTime()) / HORA_MS) * 10) / 10) : null,
    revisores,
    resumenRevision: { aprobados, rechazos, sinVoto: revisores.length - aprobados - rechazos, total: revisores.length },
    mergeEstado: pr.mergeStatus || null,
    mergeTexto: ESTADO_MERGE[pr.mergeStatus] || pr.mergeStatus || null,
    etiquetas: (pr.labels || []).filter((l) => l.active !== false).map((l) => l.name),
    autoCompletar: !!pr.autoCompleteSetBy,
    autoCompletarPor: nombreDe(pr.autoCompleteSetBy),
    cerradoPor: nombreDe(pr.closedBy),
    repoId: pr.repository?.id || null,
    proyectoId: pr.repository?.project?.id || null,
    url: web && repo ? web.pr(repo, pr.pullRequestId) : null,
  };
}

const ESTADO_HILO = { active: 'Activo', pending: 'Pendiente', fixed: 'Resuelto', closed: 'Cerrado', wontFix: 'No se corregirá', byDesign: 'Por diseño', unknown: 'Sin estado' };

function mapearHilos(threads) {
  const hilos = [];
  let sistema = 0;
  for (const t of threads || []) {
    if (t.isDeleted) continue;
    const comentarios = (t.comments || [])
      .filter((c) => !c.isDeleted)
      .map((c) => ({
        autor: nombreDe(c.author) || 'Desconocido',
        fecha: c.publishedDate || null,
        texto: c.content || '',
        tipo: c.commentType || 'text',
      }));
    const humanos = comentarios.filter((c) => c.tipo !== 'system' && c.texto);
    if (!humanos.length) { sistema += comentarios.length ? 1 : 0; continue; }
    const estado = t.status || 'unknown';
    hilos.push({
      id: t.id,
      estado,
      estadoTexto: ESTADO_HILO[estado] || estado,
      resuelto: ['fixed', 'closed', 'wontFix', 'byDesign'].includes(estado),
      archivo: t.threadContext?.filePath || null,
      linea: t.threadContext?.rightFileStart?.line || t.threadContext?.leftFileStart?.line || null,
      comentarios: humanos,
    });
  }
  return { hilos, eventosSistema: sistema };
}

// ------------------------------- Builds / Releases -----------------------------------

const ESTADO_BUILD = { notStarted: 'En cola', inProgress: 'En curso', completed: 'Completado', cancelling: 'Cancelando', postponed: 'Pospuesto', none: '—' };
const RESULTADO_BUILD = { succeeded: 'Exitoso', partiallySucceeded: 'Parcial', failed: 'Fallido', canceled: 'Cancelado', none: '—' };
const MOTIVO_BUILD = {
  manual: 'Manual', individualCI: 'CI (push)', batchedCI: 'CI agrupado', schedule: 'Programado', pullRequest: 'Pull Request', buildCompletion: 'Tras otro build',
  resourceTrigger: 'Recurso', triggered: 'Disparado', validateShelveset: 'Shelveset', checkInShelveset: 'Shelveset', userCreated: 'Manual', all: 'Otro',
};

// Clasifica un build en un grupo simple para estadísticas.
function grupoBuild(b) {
  if (b.status && b.status !== 'completed') return b.status === 'notStarted' || b.status === 'postponed' ? 'enCola' : 'enCurso';
  if (b.result === 'succeeded') return 'exitoso';
  if (b.result === 'partiallySucceeded') return 'parcial';
  if (b.result === 'failed') return 'fallido';
  if (b.result === 'canceled') return 'cancelado';
  return 'otro';
}

function mapearBuild(b, web) {
  const grupo = grupoBuild(b);
  return {
    id: b.id,
    numero: b.buildNumber || String(b.id),
    definicionId: b.definition?.id ?? null,
    definicion: b.definition?.name || '(sin nombre)',
    carpeta: b.definition?.path || null,
    estado: b.status || null,
    estadoTexto: ESTADO_BUILD[b.status] || b.status || null,
    resultado: b.result || null,
    resultadoTexto: RESULTADO_BUILD[b.result] || b.result || null,
    grupo,
    motivo: b.reason || null,
    motivoTexto: MOTIVO_BUILD[b.reason] || b.reason || null,
    solicitadoPor: nombreDe(b.requestedFor) || nombreDe(b.requestedBy) || 'Desconocido',
    rama: sinRefs(b.sourceBranch),
    commit: b.sourceVersion ? String(b.sourceVersion).substring(0, 8) : null,
    repositorio: b.repository?.name || null,
    encolado: b.queueTime || null,
    inicio: b.startTime || null,
    fin: b.finishTime || null,
    duracionMs: duracionMs(b.startTime, b.finishTime),
    esperaMs: duracionMs(b.queueTime, b.startTime),
    cola: b.queue?.name || b.queue?.pool?.name || null,
    url: b._links?.web?.href || (web ? web.build(b.id) : null),
  };
}

const ESTADO_RELEASE_AMBIENTE = {
  notStarted: 'Sin iniciar', inProgress: 'En curso', succeeded: 'Exitoso', canceled: 'Cancelado', rejected: 'Rechazado', queued: 'En cola',
  scheduled: 'Programado', partiallySucceeded: 'Parcial', undefined: '—',
};

function mapearRelease(r, web) {
  return {
    id: r.id,
    nombre: r.name,
    definicionId: r.releaseDefinition?.id ?? null,
    definicion: r.releaseDefinition?.name || null,
    estado: r.status || null,
    creado: r.createdOn || null,
    autor: nombreDe(r.createdBy),
    motivo: r.reason || null,
    descripcion: r.description || '',
    ambientes: (r.environments || []).map((e) => ({
      id: e.id,
      nombre: e.name,
      estado: e.status || 'notStarted',
      estadoTexto: ESTADO_RELEASE_AMBIENTE[e.status] || e.status || '—',
      ultimaModificacion: e.timeToDeploy !== undefined ? null : (e.modifiedOn || null),
    })),
    url: web ? web.release(r.id) : null,
  };
}

// ------------------------------- Work items -----------------------------------------

const CAMPOS_WORK_ITEM = [
  'System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.Reason', 'System.AssignedTo', 'System.CreatedBy', 'System.CreatedDate',
  'System.ChangedDate', 'System.Tags', 'System.IterationPath', 'System.AreaPath', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Common.Severity',
  'Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.RemainingWork', 'Microsoft.VSTS.Common.StateChangeDate',
  'Microsoft.VSTS.Common.ClosedDate', 'Microsoft.VSTS.Common.ResolvedDate', 'System.Parent',
];

function mapearWorkItem(w, web) {
  const f = w.fields || {};
  return {
    id: w.id,
    titulo: f['System.Title'] || '(sin título)',
    tipo: f['System.WorkItemType'] || null,
    estado: f['System.State'] || null,
    razon: f['System.Reason'] || null,
    asignado: nombreDe(f['System.AssignedTo']),
    creador: nombreDe(f['System.CreatedBy']),
    creado: f['System.CreatedDate'] || null,
    cambiado: f['System.ChangedDate'] || null,
    cerrado: f['Microsoft.VSTS.Common.ClosedDate'] || f['Microsoft.VSTS.Common.ResolvedDate'] || null,
    cambioEstado: f['Microsoft.VSTS.Common.StateChangeDate'] || null,
    etiquetas: String(f['System.Tags'] || '').split(';').map((t) => t.trim()).filter(Boolean),
    iteracion: f['System.IterationPath'] || null,
    area: f['System.AreaPath'] || null,
    prioridad: f['Microsoft.VSTS.Common.Priority'] ?? null,
    severidad: f['Microsoft.VSTS.Common.Severity'] || null,
    puntos: f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? null,
    restante: f['Microsoft.VSTS.Scheduling.RemainingWork'] ?? null,
    padre: f['System.Parent'] ?? null,
    url: web ? web.workItem(w.id) : null,
  };
}

// Estados que se consideran "terminados" en los procesos más comunes (Agile, Scrum, CMMI, Basic).
const ESTADOS_TERMINADOS = new Set(['closed', 'done', 'removed', 'resolved', 'completed', 'cerrado', 'terminado', 'finalizado', 'eliminado', 'resuelto']);
const estaTerminado = (estado) => ESTADOS_TERMINADOS.has(String(estado || '').toLowerCase());

// Relaciones de un work item -> { tipo legible, destino }
const TIPOS_RELACION = {
  'System.LinkTypes.Hierarchy-Forward': 'Hijo',
  'System.LinkTypes.Hierarchy-Reverse': 'Padre',
  'System.LinkTypes.Related': 'Relacionado',
  'System.LinkTypes.Dependency-Forward': 'Sucesor',
  'System.LinkTypes.Dependency-Reverse': 'Predecesor',
  'System.LinkTypes.Duplicate-Forward': 'Duplicado de',
  'System.LinkTypes.Duplicate-Reverse': 'Tiene duplicado',
  'Microsoft.VSTS.Common.TestedBy-Forward': 'Probado por',
  'Microsoft.VSTS.Common.TestedBy-Reverse': 'Prueba a',
  AttachedFile: 'Adjunto',
  Hyperlink: 'Enlace',
};

function mapearRelacion(r) {
  const url = String(r.url || '');
  const nombreAttr = r.attributes?.name || null;
  if (r.rel === 'ArtifactLink') {
    const dec = decodeURIComponent(url);
    let m;
    if ((m = /Git\/Commit\/[^/]+\/[^/]+\/([0-9a-f]{6,40})/i.exec(dec))) return { clase: 'commit', tipo: 'Commit', id: m[1].substring(0, 8), idCompleto: m[1] };
    if ((m = /Git\/PullRequestId\/[^/]+\/[^/]+\/(\d+)/i.exec(dec))) return { clase: 'pr', tipo: 'Pull Request', id: m[1] };
    if ((m = /Git\/Ref\/[^/]+\/[^/]+\/GB(.+)$/i.exec(dec))) return { clase: 'rama', tipo: 'Rama', id: m[1] };
    if ((m = /Build\/Build\/(\d+)/i.exec(dec))) return { clase: 'build', tipo: 'Build', id: m[1] };
    return { clase: 'otro', tipo: nombreAttr || 'Artefacto', id: null };
  }
  const idWi = /workItems\/(\d+)$/i.exec(url);
  if (idWi) return { clase: 'workitem', tipo: TIPOS_RELACION[r.rel] || r.rel, id: idWi[1] };
  if (r.rel === 'Hyperlink') return { clase: 'enlace', tipo: 'Enlace', id: null, url: /^https?:\/\//i.test(url) ? url : null };
  if (r.rel === 'AttachedFile') return { clase: 'adjunto', tipo: 'Adjunto', id: null, nombre: nombreAttr };
  return { clase: 'otro', tipo: TIPOS_RELACION[r.rel] || r.rel || 'Relación', id: null };
}

module.exports = {
  DIA_MS, HORA_MS, sinRefs, primeraLinea, nombreDe, htmlATexto, duracionMs, ocultarSecretos,
  mapearCommit, mapearCambio, resumenCambios, TIPO_CAMBIO,
  mapearRevisor, mapearPR, mapearHilos, VOTOS,
  grupoBuild, mapearBuild, mapearRelease, ESTADO_RELEASE_AMBIENTE, MOTIVO_BUILD,
  CAMPOS_WORK_ITEM, mapearWorkItem, estaTerminado, mapearRelacion,
};
