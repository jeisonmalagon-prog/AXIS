// ==========================================================================
// Arma el texto del seguimiento que AXIS publica en el caso de GLPI a partir
// de la documentación del registro de Pasos a Producción (datos de ejecución,
// checklist marcado, resultado/observaciones). Función PURA: el usuario ve y
// edita este texto antes de publicarlo.
// ==========================================================================

const ESTADOS = { PROGRAMADO: 'Programado', EJECUTADO: 'Ejecutado', CANCELADO: 'Cancelado', REAGENDADO: 'Reagendado', ROLLBACK: 'Rollback' };
const ENTORNOS = { DESARROLLO: 'Desarrollo', QA: 'QA', PRODUCCION: 'Producción' };

const pad = (n) => String(n).padStart(2, '0');

// Fecha DATETIME de MariaDB -> "dd/mm/aaaa HH:mm" con los getters locales (la
// base guarda la hora de pared; los getters locales la devuelven tal cual).
function formatoFecha(valor) {
  if (!valor) return '';
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatoDuracion(inicio, fin) {
  const a = inicio ? new Date(inicio).getTime() : NaN;
  const b = fin ? new Date(fin).getTime() : NaN;
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return '';
  const min = Math.round((b - a) / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

function limpiar(t) { return String(t == null ? '' : t).replace(/\r/g, '').trim(); }

// paso: fila de PasosProduccion (+ EjecutadoPorNombre); servidores: [{Hostname, Rol}];
// checklist: [{Descripcion, Completado, CompletadoPorNombre, FechaCompletado, cantidadEvidencias}]
function construirTextoSeguimiento({ paso, servidores = [], checklist = [] }) {
  const L = [];
  L.push('SEGUIMIENTO DE EJECUCIÓN REGISTRADO EN AXIS');
  L.push(`Registro: ${limpiar(paso.Titulo)}`);
  const cabecera = [
    paso.Rfc ? `RFC: ${limpiar(paso.Rfc)}` : null,
    `Ambiente: ${ENTORNOS[paso.Entorno] || paso.Entorno}`,
    `Estado: ${ESTADOS[paso.Estado] || paso.Estado}`
  ].filter(Boolean);
  L.push(cabecera.join(' · '));
  if (paso.FechaHoraProgramada) L.push(`Programado: ${formatoFecha(paso.FechaHoraProgramada)}`);
  if (paso.FechaHoraInicioReal || paso.FechaHoraFinReal) {
    const partes = [];
    if (paso.FechaHoraInicioReal) partes.push(`Inicio real: ${formatoFecha(paso.FechaHoraInicioReal)}`);
    if (paso.FechaHoraFinReal) partes.push(`Fin real: ${formatoFecha(paso.FechaHoraFinReal)}`);
    const dur = formatoDuracion(paso.FechaHoraInicioReal, paso.FechaHoraFinReal);
    if (dur) partes.push(`Duración: ${dur}`);
    L.push(partes.join(' · '));
  }
  if (paso.EjecutadoPorNombre) L.push(`Ejecutado por: ${limpiar(paso.EjecutadoPorNombre)}`);
  if (servidores.length) {
    L.push(`Servidores: ${servidores.map((s) => `${s.Hostname}${s.Rol ? ` (${s.Rol})` : ''}`).join(', ')}`);
  }
  if (paso.CommitId) {
    L.push(`Commit: ${String(paso.CommitId).slice(0, 8)}${paso.CommitMensaje ? ` — ${limpiar(paso.CommitMensaje).split('\n')[0].slice(0, 160)}` : ''}${paso.CommitAutor ? ` (${limpiar(paso.CommitAutor)})` : ''}`);
  }

  if (checklist.length) {
    const hechos = checklist.filter((c) => c.Completado).length;
    L.push('');
    L.push(`CHECKLIST (${hechos} DE ${checklist.length} COMPLETADOS)`);
    for (const c of checklist) {
      let linea = `${c.Completado ? '[x]' : '[ ]'} ${limpiar(c.Descripcion)}`;
      if (c.Completado && (c.CompletadoPorNombre || c.FechaCompletado)) {
        linea += ` — ${[limpiar(c.CompletadoPorNombre), formatoFecha(c.FechaCompletado)].filter(Boolean).join(', ')}`;
      }
      if (c.cantidadEvidencias > 0) linea += ' — evidencia abajo';
      L.push(linea);
    }
  }

  if (limpiar(paso.ResultadoEjecucion)) {
    L.push('');
    L.push('RESULTADO DE LA EJECUCIÓN');
    L.push(limpiar(paso.ResultadoEjecucion));
  }
  if (limpiar(paso.MotivoEstado)) {
    L.push('');
    L.push(`MOTIVO DEL ESTADO ${String(ESTADOS[paso.Estado] || paso.Estado).toUpperCase()}`);
    L.push(limpiar(paso.MotivoEstado));
  }
  return L.join('\n');
}


// Respuesta de CIERRE (solución) del caso: la lee el solicitante, así que es un resumen
// entendible de lo que se hizo, armado SOLO con lo registrado en AXIS (datos reales de
// ejecución, actividades marcadas del checklist y sus evidencias). Función PURA: el usuario
// la revisa y edita antes de publicarla.
// adjuntos: [{ NombreOriginal, ChecklistItemId }]; checklist: [{ Id, Descripcion, Completado, ... }]
function construirTextoCierre({ paso, servidores = [], checklist = [], adjuntos = [] }) {
  const L = [];
  const titulo = limpiar(paso.Titulo);
  const ambiente = ENTORNOS[paso.Entorno] || paso.Entorno || '';
  const inicio = paso.FechaHoraInicioReal;
  const motivo = limpiar(paso.MotivoEstado);

  if (paso.Estado === 'EJECUTADO') {
    L.push(`Se ejecutó el cambio «${titulo}» en ${ambiente}${inicio ? ` el ${formatoFecha(inicio)}` : (paso.FechaHoraProgramada ? ` (programado para ${formatoFecha(paso.FechaHoraProgramada)})` : '')}.`);
  } else if (paso.Estado === 'ROLLBACK') {
    L.push(`Se ejecutó el cambio «${titulo}» en ${ambiente}, pero fue necesario hacer rollback.`);
  } else if (paso.Estado === 'CANCELADO') {
    L.push(`El cambio «${titulo}» fue cancelado.`);
  } else if (paso.Estado === 'REAGENDADO') {
    L.push(`El cambio «${titulo}» fue reagendado.`);
  } else {
    L.push(`Cambio «${titulo}» en ${ambiente}${paso.FechaHoraProgramada ? `, programado para ${formatoFecha(paso.FechaHoraProgramada)}` : ''}.`);
  }
  if (motivo && paso.Estado !== 'EJECUTADO') L.push(`Motivo: ${motivo}`);

  const resumen = [];
  if (paso.FechaHoraInicioReal) resumen.push(`Inicio: ${formatoFecha(paso.FechaHoraInicioReal)}`);
  if (paso.FechaHoraFinReal) resumen.push(`Fin: ${formatoFecha(paso.FechaHoraFinReal)}`);
  const dur = formatoDuracion(paso.FechaHoraInicioReal, paso.FechaHoraFinReal);
  if (dur) resumen.push(`Duración: ${dur}`);
  const datos = [];
  if (resumen.length) datos.push(resumen.join(' · '));
  if (paso.EjecutadoPorNombre) datos.push(`Ejecutado por: ${limpiar(paso.EjecutadoPorNombre)}`);
  if (servidores.length) datos.push(`Servidores intervenidos: ${servidores.map((s) => `${s.Hostname}${s.Rol ? ` (${s.Rol})` : ''}`).join(', ')}`);
  if (paso.CommitId) datos.push(`Versión desplegada (commit): ${String(paso.CommitId).slice(0, 8)}${paso.CommitMensaje ? ` — ${limpiar(paso.CommitMensaje).split('\n')[0].slice(0, 160)}` : ''}`);
  if (datos.length) { L.push(''); L.push('RESUMEN DE LA EJECUCIÓN'); L.push(...datos); }

  const hechos = checklist.filter((c) => c.Completado);
  const sinHacer = checklist.filter((c) => !c.Completado);
  if (hechos.length) {
    L.push('');
    L.push('ACTIVIDADES REALIZADAS');
    for (const c of hechos) {
      const quien = [limpiar(c.CompletadoPorNombre), c.FechaCompletado ? formatoFecha(c.FechaCompletado) : ''].filter(Boolean).join(', ');
      const hayEvidencia = adjuntos.some((a) => a.ChecklistItemId === c.Id);
      L.push(`- ${limpiar(c.Descripcion)}${quien ? ` (${quien})` : ''}${hayEvidencia ? ' — evidencia abajo' : ''}`);
    }
  }
  if (sinHacer.length) {
    L.push('');
    L.push('ACTIVIDADES NO COMPLETADAS');
    for (const c of sinHacer) L.push(`- ${limpiar(c.Descripcion)}`);
  }

  if (limpiar(paso.ResultadoEjecucion)) {
    L.push('');
    L.push('RESULTADO');
    L.push(limpiar(paso.ResultadoEjecucion));
  }

  if (paso.Estado === 'EJECUTADO') {
    L.push('');
    L.push('Con lo anterior se da por finalizada la solicitud. Las evidencias de cada actividad se muestran en esta respuesta.');
  }
  return L.join('\n');
}

// Nombre de archivo seguro y único dentro del envío.
function nombreArchivoUnico(nombre, usados) {
  let base = String(nombre || 'evidencia').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'evidencia';
  if (!usados.has(base.toLowerCase())) { usados.add(base.toLowerCase()); return base; }
  const punto = base.lastIndexOf('.');
  const raiz = punto > 0 ? base.slice(0, punto) : base;
  const ext = punto > 0 ? base.slice(punto) : '';
  for (let i = 2; i < 100; i++) {
    const c = `${raiz}-${i}${ext}`;
    if (!usados.has(c.toLowerCase())) { usados.add(c.toLowerCase()); return c; }
  }
  return base;
}

module.exports = { construirTextoSeguimiento, construirTextoCierre, nombreArchivoUnico, formatoFecha, formatoDuracion };
