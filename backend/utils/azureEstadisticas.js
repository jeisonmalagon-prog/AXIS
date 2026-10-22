// Estadísticas calculadas a partir de datos ya traídos de Azure DevOps.
// Funciones puras (sin red): reciben listas ya mapeadas por azureMapas.js.

const { DIA_MS, HORA_MS, estaTerminado } = require('./azureMapas');

const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function percentil(valores, p) {
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(v[lo] + (v[hi] - v[lo]) * (idx - lo));
}
const promedio = (v) => {
  const x = v.filter((n) => Number.isFinite(n));
  return x.length ? Math.round(x.reduce((a, b) => a + b, 0) / x.length) : null;
};
const porcentaje = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

// yyyy-mm-dd en zona Colombia (UTC-5, sin horario de verano) para agrupar por día.
const OFFSET_MS = -5 * HORA_MS;
function aLocal(fecha) {
  const t = new Date(fecha).getTime();
  return Number.isFinite(t) ? new Date(t + OFFSET_MS) : null;
}
function claveDia(fecha) {
  const d = aLocal(fecha);
  return d ? d.toISOString().substring(0, 10) : null;
}
function claveSemana(fecha) {
  const d = aLocal(fecha);
  if (!d) return null;
  const dia = (d.getUTCDay() + 6) % 7; // lunes = 0
  const lunes = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dia));
  return lunes.toISOString().substring(0, 10);
}

// Lista de los últimos N días (más antiguo primero) terminando en "hoy" (hora local).
function ultimosDias(n, ahora = Date.now()) {
  const salida = [];
  for (let i = n - 1; i >= 0; i--) salida.push(claveDia(ahora - i * DIA_MS));
  return salida;
}
function ultimasSemanas(n, ahora = Date.now()) {
  const salida = [];
  for (let i = n - 1; i >= 0; i--) salida.push(claveSemana(ahora - i * 7 * DIA_MS));
  return salida;
}

function contar(lista, clave, tope = null) {
  const m = new Map();
  for (const x of lista) {
    const k = clave(x);
    if (k === null || k === undefined || k === '') continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  const arr = [...m.entries()].map(([nombre, cantidad]) => ({ nombre, cantidad })).sort((a, b) => b.cantidad - a.cantidad || String(a.nombre).localeCompare(String(b.nombre), 'es'));
  return tope ? arr.slice(0, tope) : arr;
}

// ------------------------------- Commits -------------------------------------------

function estadisticasCommits(commits, dias = 30, ahora = Date.now()) {
  const eje = ultimosDias(dias, ahora);
  const porDiaMap = new Map(eje.map((d) => [d, 0]));
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const porHora = Array(24).fill(0);
  const porDiaSemana = Array(7).fill(0);
  const autores = new Map();
  let merges = 0;

  for (const c of commits) {
    const d = aLocal(c.fecha);
    if (!d) continue;
    const k = d.toISOString().substring(0, 10);
    if (porDiaMap.has(k)) porDiaMap.set(k, porDiaMap.get(k) + 1);
    const hora = d.getUTCHours();
    const dsem = (d.getUTCDay() + 6) % 7;
    heat[dsem][hora]++;
    porHora[hora]++;
    porDiaSemana[dsem]++;
    if (c.esMerge) merges++;
    const a = autores.get(c.autor) || { nombre: c.autor, commits: 0, ultimo: null, primero: null, dias: new Set() };
    a.commits++;
    a.dias.add(k);
    if (!a.ultimo || c.fecha > a.ultimo) a.ultimo = c.fecha;
    if (!a.primero || c.fecha < a.primero) a.primero = c.fecha;
    autores.set(c.autor, a);
  }

  const porDia = eje.map((d) => ({ fecha: d, cantidad: porDiaMap.get(d) }));
  const diasActivos = porDia.filter((x) => x.cantidad > 0).length;
  const maxDia = porDia.reduce((m, x) => (x.cantidad > (m?.cantidad ?? -1) ? x : m), null);
  const horaPico = porHora.indexOf(Math.max(...porHora));
  const diaPico = porDiaSemana.indexOf(Math.max(...porDiaSemana));

  return {
    total: commits.length,
    merges,
    diasActivos,
    promedioPorDia: dias ? Math.round((commits.length / dias) * 10) / 10 : 0,
    diaMasActivo: maxDia && maxDia.cantidad > 0 ? maxDia : null,
    horaPico: commits.length ? horaPico : null,
    diaSemanaPico: commits.length ? DIAS_SEMANA[diaPico] : null,
    porDia,
    porHora,
    porDiaSemana: DIAS_SEMANA.map((nombre, i) => ({ nombre, cantidad: porDiaSemana[i] })),
    heatmap: { filas: DIAS_SEMANA, matriz: heat },
    autores: [...autores.values()]
      .map((a) => ({ nombre: a.nombre, commits: a.commits, diasActivos: a.dias.size, primero: a.primero, ultimo: a.ultimo }))
      .sort((a, b) => b.commits - a.commits),
  };
}

// ------------------------------- Pull requests ---------------------------------------

function estadisticasPR(prs, semanas = 12, ahora = Date.now()) {
  const porEstado = { active: 0, completed: 0, abandoned: 0 };
  for (const p of prs) porEstado[p.estado] = (porEstado[p.estado] || 0) + 1;
  const completados = prs.filter((p) => p.estado === 'completed' && p.horasAbierto !== null);
  const ciclo = completados.map((p) => p.horasAbierto);
  const activos = prs.filter((p) => p.estado === 'active');

  const eje = ultimasSemanas(semanas, ahora);
  const creados = new Map(eje.map((s) => [s, 0]));
  const cerrados = new Map(eje.map((s) => [s, 0]));
  for (const p of prs) {
    const sc = claveSemana(p.creado);
    if (creados.has(sc)) creados.set(sc, creados.get(sc) + 1);
    if (p.estado === 'completed' && p.cerrado) {
      const sf = claveSemana(p.cerrado);
      if (cerrados.has(sf)) cerrados.set(sf, cerrados.get(sf) + 1);
    }
  }

  const porRevisor = new Map();
  for (const p of prs) {
    for (const r of p.revisores) {
      const x = porRevisor.get(r.nombre) || { nombre: r.nombre, asignados: 0, aprobados: 0, rechazados: 0 };
      x.asignados++;
      if (r.voto >= 5) x.aprobados++;
      if (r.voto <= -5) x.rechazados++;
      porRevisor.set(r.nombre, x);
    }
  }

  return {
    total: prs.length,
    porEstado,
    tasaCompletados: porcentaje(porEstado.completed, porEstado.completed + porEstado.abandoned),
    cicloHoras: { p50: percentil(ciclo, 0.5), p90: percentil(ciclo, 0.9), promedio: promedio(ciclo) },
    activosSinRevisor: activos.filter((p) => p.resumenRevision.total === 0).length,
    activosAntiguos: activos.filter((p) => (p.horasAbierto || 0) > 24 * 7).length,
    borradores: activos.filter((p) => p.esBorrador).length,
    conConflictos: activos.filter((p) => p.mergeEstado === 'conflicts').length,
    porSemana: eje.map((s) => ({ semana: s, creados: creados.get(s), completados: cerrados.get(s) })),
    porAutor: contar(prs, (p) => p.autor, 10),
    porRevisor: [...porRevisor.values()].sort((a, b) => b.asignados - a.asignados).slice(0, 10),
    porRamaDestino: contar(prs, (p) => p.ramaDestino, 8),
  };
}

// ------------------------------- Builds ------------------------------------------------

function estadisticasBuilds(builds, dias = 30, ahora = Date.now()) {
  const grupos = { exitoso: 0, parcial: 0, fallido: 0, cancelado: 0, enCurso: 0, enCola: 0, otro: 0 };
  for (const b of builds) grupos[b.grupo] = (grupos[b.grupo] || 0) + 1;
  const terminados = grupos.exitoso + grupos.parcial + grupos.fallido;

  const eje = ultimosDias(dias, ahora);
  const diaMap = new Map(eje.map((d) => [d, { fecha: d, exitosos: 0, fallidos: 0, otros: 0 }]));
  for (const b of builds) {
    const x = diaMap.get(claveDia(b.encolado || b.inicio));
    if (!x) continue;
    if (b.grupo === 'exitoso') x.exitosos++;
    else if (b.grupo === 'fallido') x.fallidos++;
    else x.otros++;
  }

  const duraciones = builds.filter((b) => b.duracionMs !== null).map((b) => b.duracionMs);
  const esperas = builds.filter((b) => b.esperaMs !== null).map((b) => b.esperaMs);

  const defs = new Map();
  const orden = [...builds].sort((a, b) => new Date(a.encolado || 0) - new Date(b.encolado || 0));
  for (const b of orden) {
    const k = b.definicionId ?? b.definicion;
    const d = defs.get(k) || {
      definicionId: b.definicionId, nombre: b.definicion, total: 0, exitosos: 0, fallidos: 0, parciales: 0, cancelados: 0, duraciones: [], ultimo: null, cambios: 0, _prev: null,
    };
    d.total++;
    if (b.grupo === 'exitoso') d.exitosos++;
    if (b.grupo === 'fallido') d.fallidos++;
    if (b.grupo === 'parcial') d.parciales++;
    if (b.grupo === 'cancelado') d.cancelados++;
    if (b.duracionMs !== null) d.duraciones.push(b.duracionMs);
    if (b.grupo === 'exitoso' || b.grupo === 'fallido') {
      if (d._prev && d._prev !== b.grupo) d.cambios++; // alternancia éxito<->fallo
      d._prev = b.grupo;
    }
    d.ultimo = { id: b.id, grupo: b.grupo, resultadoTexto: b.resultadoTexto || b.estadoTexto, fecha: b.encolado, rama: b.rama };
    defs.set(k, d);
  }
  const porDefinicion = [...defs.values()].map((d) => {
    const term = d.exitosos + d.fallidos + d.parciales;
    return {
      definicionId: d.definicionId, nombre: d.nombre, total: d.total, exitosos: d.exitosos, fallidos: d.fallidos, parciales: d.parciales, cancelados: d.cancelados,
      tasaExito: porcentaje(d.exitosos, term), duracionMediaMs: promedio(d.duraciones), duracionP95Ms: percentil(d.duraciones, 0.95),
      inestable: d.cambios >= 3 && d.total >= 5, ultimo: d.ultimo,
    };
  }).sort((a, b) => b.total - a.total);

  return {
    total: builds.length,
    grupos,
    tasaExito: porcentaje(grupos.exitoso, terminados),
    duracionMs: { p50: percentil(duraciones, 0.5), p95: percentil(duraciones, 0.95), promedio: promedio(duraciones) },
    esperaMs: { p50: percentil(esperas, 0.5), p95: percentil(esperas, 0.95) },
    porDia: eje.map((d) => diaMap.get(d)),
    porDefinicion,
    porRama: contar(builds, (b) => b.rama, 8),
    porMotivo: contar(builds, (b) => b.motivoTexto, 8),
    porSolicitante: contar(builds, (b) => b.solicitadoPor, 8),
    fallosRecientes: builds.filter((b) => b.grupo === 'fallido').sort((a, b) => new Date(b.encolado || 0) - new Date(a.encolado || 0)).slice(0, 8),
  };
}

// ------------------------------- Releases --------------------------------------------

function estadisticasReleases(releases, dias = 60, ahora = Date.now()) {
  const eje = ultimosDias(dias, ahora);
  const diaMap = new Map(eje.map((d) => [d, 0]));
  const porAmbiente = new Map();
  for (const r of releases) {
    const k = claveDia(r.creado);
    if (diaMap.has(k)) diaMap.set(k, diaMap.get(k) + 1);
    for (const e of r.ambientes) {
      const a = porAmbiente.get(e.nombre) || { nombre: e.nombre, exitosos: 0, fallidos: 0, enCurso: 0, sinIniciar: 0 };
      if (e.estado === 'succeeded') a.exitosos++;
      else if (['rejected', 'canceled'].includes(e.estado)) a.fallidos++;
      else if (['inProgress', 'queued', 'scheduled'].includes(e.estado)) a.enCurso++;
      else a.sinIniciar++;
      porAmbiente.set(e.nombre, a);
    }
  }
  return {
    total: releases.length,
    porDia: eje.map((d) => ({ fecha: d, cantidad: diaMap.get(d) })),
    porDefinicion: contar(releases, (r) => r.definicion, 10),
    porAutor: contar(releases, (r) => r.autor, 8),
    porAmbiente: [...porAmbiente.values()].map((a) => ({ ...a, tasaExito: porcentaje(a.exitosos, a.exitosos + a.fallidos) })),
  };
}

// ------------------------------- Work items ---------------------------------------------

function estadisticasWorkItems(items, semanas = 12, ahora = Date.now()) {
  const abiertos = items.filter((i) => !estaTerminado(i.estado));
  const terminados = items.filter((i) => estaTerminado(i.estado));
  const eje = ultimasSemanas(semanas, ahora);
  const creados = new Map(eje.map((s) => [s, 0]));
  const cerrados = new Map(eje.map((s) => [s, 0]));
  for (const i of items) {
    const sc = claveSemana(i.creado);
    if (creados.has(sc)) creados.set(sc, creados.get(sc) + 1);
    if (estaTerminado(i.estado)) {
      const sf = claveSemana(i.cerrado || i.cambioEstado || i.cambiado);
      if (cerrados.has(sf)) cerrados.set(sf, cerrados.get(sf) + 1);
    }
  }
  const edades = abiertos.filter((i) => i.creado).map((i) => (ahora - new Date(i.creado).getTime()) / DIA_MS);
  const leadDias = terminados
    .filter((i) => i.creado && (i.cerrado || i.cambioEstado))
    .map((i) => (new Date(i.cerrado || i.cambioEstado).getTime() - new Date(i.creado).getTime()) / DIA_MS)
    .filter((d) => d >= 0);

  const puntosPorEstado = new Map();
  for (const i of items) if (i.puntos) puntosPorEstado.set(i.estado, (puntosPorEstado.get(i.estado) || 0) + i.puntos);

  return {
    total: items.length,
    abiertos: abiertos.length,
    terminados: terminados.length,
    sinAsignar: abiertos.filter((i) => !i.asignado).length,
    antiguosMas30Dias: edades.filter((d) => d > 30).length,
    edadDias: { p50: percentil(edades, 0.5), p90: percentil(edades, 0.9) },
    leadTimeDias: { p50: percentil(leadDias, 0.5), p90: percentil(leadDias, 0.9) },
    porTipo: contar(items, (i) => i.tipo),
    porEstado: contar(items, (i) => i.estado),
    porAsignado: contar(abiertos, (i) => i.asignado || 'Sin asignar', 10),
    porPrioridad: contar(abiertos, (i) => (i.prioridad ? `P${i.prioridad}` : 'Sin prioridad')),
    porIteracion: contar(items, (i) => (i.iteracion ? i.iteracion.split('\\').slice(-1)[0] : null), 10),
    porSemana: eje.map((s) => ({ semana: s, creados: creados.get(s), cerrados: cerrados.get(s) })),
    puntosPorEstado: [...puntosPorEstado.entries()].map(([nombre, puntos]) => ({ nombre, puntos })),
  };
}

// ------------------------------- Despliegues (por ambiente) ---------------------------------

function estadisticasDespliegues(despliegues, dias = 60, ahora = Date.now()) {
  const eje = ultimosDias(dias, ahora);
  const diaMap = new Map(eje.map((d) => [d, { fecha: d, exitosos: 0, fallidos: 0 }]));
  const amb = new Map();
  for (const d of despliegues) {
    const x = diaMap.get(claveDia(d.inicio));
    if (x) { if (d.estado === 'succeeded') x.exitosos++; else if (d.estado === 'failed') x.fallidos++; }
    const k = d.ambiente || '—';
    const a = amb.get(k) || { nombre: k, total: 0, exitosos: 0, fallidos: 0, duraciones: [], ultimo: null };
    a.total++;
    if (d.estado === 'succeeded') a.exitosos++;
    if (d.estado === 'failed') a.fallidos++;
    if (d.duracionMs !== null) a.duraciones.push(d.duracionMs);
    if (!a.ultimo || (d.inicio && d.inicio > a.ultimo.inicio)) a.ultimo = { release: d.release, estado: d.estado, estadoTexto: d.estadoTexto, inicio: d.inicio };
    amb.set(k, a);
  }
  const terminados = despliegues.filter((d) => d.estado === 'succeeded' || d.estado === 'failed');
  return {
    total: despliegues.length,
    tasaExito: porcentaje(terminados.filter((d) => d.estado === 'succeeded').length, terminados.length),
    duracionMs: { p50: percentil(despliegues.map((d) => d.duracionMs), 0.5), p95: percentil(despliegues.map((d) => d.duracionMs), 0.95) },
    porDia: eje.map((d) => diaMap.get(d)),
    porAmbiente: [...amb.values()].map((a) => ({
      nombre: a.nombre, total: a.total, exitosos: a.exitosos, fallidos: a.fallidos,
      tasaExito: porcentaje(a.exitosos, a.exitosos + a.fallidos), duracionMediaMs: promedio(a.duraciones), ultimo: a.ultimo,
    })).sort((x, y) => y.total - x.total),
    porDefinicion: contar(despliegues, (d) => d.definicion, 10),
  };
}

module.exports = {
  estadisticasDespliegues,
  percentil, promedio, porcentaje, claveDia, claveSemana, ultimosDias, ultimasSemanas, contar, DIAS_SEMANA,
  estadisticasCommits, estadisticasPR, estadisticasBuilds, estadisticasReleases, estadisticasWorkItems,
};
