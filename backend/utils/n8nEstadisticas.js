// Estadísticas del módulo Orquestador n8n. Funciones PURAS (sin red ni BD):
// reciben los flujos y las ejecuciones ya recolectados y calculan todo lo que
// muestra la pantalla. Así se pueden probar con datos de ejemplo.
//
// Zona horaria: el servidor puede estar en UTC y el usuario en Colombia, así
// que los cortes por día y por hora se hacen con el desfase del navegador
// (`tz` = minutos que devuelve Date.getTimezoneOffset(), p. ej. 300 para UTC-5).

const DIA_MS = 86400000;
const HORA_MS = 3600000;

// Estados de ejecución de n8n agrupados.
function grupoDeEstado(status) {
  switch (status) {
    case 'success': return 'exitosa';
    case 'error':
    case 'crashed': return 'fallida';
    case 'canceled': return 'cancelada';
    case 'running':
    case 'new': return 'enCurso';
    case 'waiting': return 'esperando';
    default: return 'otra';
  }
}

function normalizarEjecucion(e) {
  // Versiones viejas de la API no traen "status": se deduce.
  const status = e.status || (e.finished ? 'success' : (e.stoppedAt ? 'error' : 'running'));
  const inicio = Date.parse(e.startedAt || '');
  const fin = e.stoppedAt ? Date.parse(e.stoppedAt) : NaN;
  const grupo = grupoDeEstado(status);
  const terminada = grupo === 'exitosa' || grupo === 'fallida' || grupo === 'cancelada';
  return {
    id: String(e.id),
    workflowId: String(e.workflowId),
    status,
    grupo,
    modo: e.mode || 'desconocido',
    inicio: Number.isNaN(inicio) ? null : inicio,
    fin: Number.isNaN(fin) ? null : fin,
    dur: terminada && !Number.isNaN(inicio) && !Number.isNaN(fin) && fin >= inicio ? fin - inicio : null,
  };
}

// --- Utilidades numéricas ---

function percentil(ordenado, p) {
  if (!ordenado.length) return null;
  const i = Math.min(ordenado.length - 1, Math.max(0, Math.ceil((p / 100) * ordenado.length) - 1));
  return ordenado[i];
}

function resumenDuraciones(valores) {
  const v = valores.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return { n: 0, prom: null, p50: null, p95: null, max: null, min: null, total: 0 };
  const total = v.reduce((s, x) => s + x, 0);
  return { n: v.length, prom: Math.round(total / v.length), p50: percentil(v, 50), p95: percentil(v, 95), max: v[v.length - 1], min: v[0], total };
}

function tasaDeExito(exitosas, fallidas) {
  const base = exitosas + fallidas;
  return base ? Math.round((exitosas / base) * 1000) / 10 : null;
}

// --- Tiempo local ---

const aLocal = (ms, tz) => new Date(ms - tz * 60000); // usar getUTC* sobre el resultado
const pad = (n) => String(n).padStart(2, '0');

function claveDia(ms, tz) {
  const d = aLocal(ms, tz);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function claveHora(ms, tz) {
  const d = aLocal(ms, tz);
  return `${claveDia(ms, tz)}T${pad(d.getUTCHours())}`;
}

// Cubetas de la serie temporal: por hora si el periodo es de 24 h; por día si es mayor.
// El periodo analizado empieza donde empieza la primera cubeta, así la serie,
// el mapa de calor y los totales siempre cuentan lo mismo.
function crearCubetas(dias, ahoraMs, tz) {
  const cubetas = [];
  if (dias <= 1) {
    for (let i = 23; i >= 0; i--) {
      const t = ahoraMs - i * HORA_MS;
      const d = aLocal(t, tz);
      cubetas.push({ clave: claveHora(t, tz), etiqueta: `${pad(d.getUTCHours())}:00`, fecha: claveDia(t, tz), hora: d.getUTCHours(), inicioMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()) + tz * 60000 });
    }
    return { unidad: 'hora', cubetas };
  }
  for (let i = dias - 1; i >= 0; i--) {
    const t = ahoraMs - i * DIA_MS;
    const d = aLocal(t, tz);
    cubetas.push({ clave: claveDia(t, tz), etiqueta: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`, fecha: claveDia(t, tz), hora: null, inicioMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + tz * 60000 });
  }
  return { unidad: 'dia', cubetas };
}

// --- Flujos ---

// Qué desencadena un flujo, según el tipo de sus nodos.
function disparadoresDe(nodos) {
  const encontrados = new Set();
  for (const n of nodos || []) {
    const tipo = String(n.type || '').toLowerCase();
    const corto = tipo.split('.').pop();
    if (n.disabled) continue;
    if (corto === 'webhook') encontrados.add('Webhook');
    else if (corto === 'scheduletrigger' || corto === 'cron' || corto === 'interval') encontrados.add('Programado');
    else if (corto === 'manualtrigger') encontrados.add('Manual');
    else if (corto === 'errortrigger') encontrados.add('Error de otro flujo');
    else if (corto === 'executeworkflowtrigger') encontrados.add('Sub-flujo');
    else if (corto === 'formtrigger') encontrados.add('Formulario');
    else if (corto === 'chattrigger') encontrados.add('Chat');
    else if (corto.endsWith('trigger')) encontrados.add('Evento');
  }
  return [...encontrados];
}

const etiquetasDe = (wf) => (wf.tags || []).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean);

// Racha de fallos: cuántas ejecuciones terminadas seguidas fallaron, de la más reciente hacia atrás.
function rachaDeFallos(ejecsRecientesPrimero) {
  let n = 0;
  for (const e of ejecsRecientesPrimero) {
    if (e.grupo === 'fallida') n++;
    else if (e.grupo === 'exitosa') break;
  }
  return n;
}

const MODOS_ETIQUETA = {
  trigger: 'Disparador', webhook: 'Webhook', manual: 'Manual', retry: 'Reintento', error: 'Flujo de error',
  cli: 'Línea de comandos', integrated: 'Integrado', evaluation: 'Evaluación', internal: 'Interno', desconocido: 'Desconocido',
};

function contarPor(lista, fn) {
  const m = {};
  for (const x of lista) { const k = fn(x); m[k] = (m[k] || 0) + 1; }
  return m;
}

function acumularEnCubetas(ejecs, cubetas, tz, unidad) {
  const idx = new Map(cubetas.map((c, i) => [c.clave, i]));
  const puntos = cubetas.map((c) => ({ clave: c.clave, etiqueta: c.etiqueta, fecha: c.fecha, hora: c.hora, exitosas: 0, fallidas: 0, otras: 0, durSuma: 0, durN: 0 }));
  for (const e of ejecs) {
    if (e.inicio === null) continue;
    const i = idx.get(unidad === 'hora' ? claveHora(e.inicio, tz) : claveDia(e.inicio, tz));
    if (i === undefined) continue;
    const p = puntos[i];
    if (e.grupo === 'exitosa') p.exitosas++;
    else if (e.grupo === 'fallida') p.fallidas++;
    else p.otras++;
    if (e.dur !== null) { p.durSuma += e.dur; p.durN++; }
  }
  return puntos.map(({ durSuma, durN, ...p }) => ({ ...p, total: p.exitosas + p.fallidas + p.otras, durProm: durN ? Math.round(durSuma / durN) : null }));
}

function porHoraDelDia(ejecs, tz) {
  const horas = Array.from({ length: 24 }, (_, h) => ({ hora: h, exitosas: 0, fallidas: 0, otras: 0, total: 0 }));
  for (const e of ejecs) {
    if (e.inicio === null) continue;
    const h = aLocal(e.inicio, tz).getUTCHours();
    const c = horas[h];
    if (e.grupo === 'exitosa') c.exitosas++; else if (e.grupo === 'fallida') c.fallidas++; else c.otras++;
    c.total++;
  }
  return horas;
}

// Mapa de calor: filas = día de la semana (0 = lunes ... 6 = domingo), columnas = hora.
function mapaDeCalor(ejecs, tz) {
  const m = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const e of ejecs) {
    if (e.inicio === null) continue;
    const d = aLocal(e.inicio, tz);
    m[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++;
  }
  return m;
}

function resumirFlujo({ wf, cuenta }, ejecs, ctx) {
  const ordenadas = [...ejecs].sort((a, b) => (b.inicio || 0) - (a.inicio || 0));
  const por = (g) => ordenadas.filter((e) => e.grupo === g);
  const exitosas = por('exitosa').length;
  const fallidas = por('fallida').length;
  const canceladas = por('cancelada').length;
  const enCurso = por('enCurso');
  const esperando = por('esperando').length;
  const ultima = ordenadas[0] || null;
  const ultimaExitosa = ordenadas.find((e) => e.grupo === 'exitosa') || null;
  const ultimaFallida = ordenadas.find((e) => e.grupo === 'fallida') || null;
  const iso = (e) => (e && e.inicio !== null ? new Date(e.inicio).toISOString() : null);
  const enCursoMasLarga = enCurso.reduce((m, e) => Math.max(m, e.inicio !== null ? ctx.ahoraMs - e.inicio : 0), 0);

  const puntos = acumularEnCubetas(ordenadas, ctx.cubetas, ctx.tz, ctx.unidad);
  const nodos = wf.nodes || [];

  return {
    id: String(wf.id),
    nombre: wf.name,
    activo: !!wf.active,
    cuentaId: cuenta.id,
    cuentaNombre: cuenta.nombre,
    etiquetas: etiquetasDe(wf),
    nodos: nodos.length || null,
    disparadores: disparadoresDe(nodos),
    creado: wf.createdAt || null,
    actualizado: wf.updatedAt || null,
    totalEjecuciones: ordenadas.length,
    exitosas,
    fallidas,
    canceladas,
    enCurso: enCurso.length,
    esperando,
    tasaExito: tasaDeExito(exitosas, fallidas),
    duracion: resumenDuraciones(ordenadas.map((e) => e.dur)),
    ultimaEjecucion: iso(ultima),
    ultimoEstado: ultima ? ultima.status : 'sin_datos',
    ultimaExitosa: iso(ultimaExitosa),
    ultimaFallida: iso(ultimaFallida),
    racha: rachaDeFallos(ordenadas),
    modos: contarPor(ordenadas, (e) => e.modo),
    spark: puntos.map((p) => p.total),
    sparkFallos: puntos.map((p) => p.fallidas),
    sinEjecutar: !!wf.active && ordenadas.length === 0,
    enCursoMasLargaMs: enCursoMasLarga || null,
  };
}

// Motivos por los que un flujo requiere atención (severidad: alta | media | baja).
function motivosDeAtencion(f) {
  const motivos = [];
  if (f.racha >= 3) motivos.push({ codigo: 'racha', severidad: 'alta', texto: `${f.racha} fallos consecutivos` });
  else if (f.activo && f.ultimoEstado === 'error') motivos.push({ codigo: 'ultimo-fallo', severidad: 'media', texto: 'La última ejecución falló' });
  if (f.tasaExito !== null && f.exitosas + f.fallidas >= 5 && f.tasaExito < 80) {
    motivos.push({ codigo: 'tasa', severidad: f.tasaExito < 50 ? 'alta' : 'media', texto: `Tasa de éxito ${String(f.tasaExito).replace('.', ',')}%` });
  }
  if (f.enCursoMasLargaMs && f.enCursoMasLargaMs > HORA_MS) {
    motivos.push({ codigo: 'larga', severidad: 'media', texto: `Ejecución en curso hace ${Math.round(f.enCursoMasLargaMs / HORA_MS)} h` });
  }
  if (f.sinEjecutar) motivos.push({ codigo: 'sin-ejecuciones', severidad: 'baja', texto: 'Activo sin ejecuciones en el periodo' });
  return motivos;
}

const PESO_SEVERIDAD = { alta: 0, media: 1, baja: 2 };

// Cálculo completo para el panel. `flujos` = [{ wf, cuenta }] ya filtrados por permisos;
// `ejecuciones` = ejecuciones crudas de n8n (se descartan las de flujos no incluidos).
function calcular({ flujos, ejecuciones, dias, tz = 0, ahoraMs = Date.now() }) {
  const { unidad, cubetas } = crearCubetas(dias, ahoraMs, tz);
  const desdeMs = cubetas[0].inicioMs;
  const ids = new Set(flujos.map((f) => String(f.wf.id)));

  const todas = ejecuciones
    .map(normalizarEjecucion)
    .filter((e) => ids.has(e.workflowId) && e.inicio !== null && e.inicio >= desdeMs && e.inicio <= ahoraMs + HORA_MS);

  const porFlujo = new Map();
  for (const e of todas) {
    if (!porFlujo.has(e.workflowId)) porFlujo.set(e.workflowId, []);
    porFlujo.get(e.workflowId).push(e);
  }

  const ctx = { ahoraMs, tz, unidad, cubetas };

  const resumenes = flujos.map((f) => {
    const r = resumirFlujo(f, porFlujo.get(String(f.wf.id)) || [], ctx);
    r.motivos = motivosDeAtencion(r);
    return r;
  });

  const exitosas = todas.filter((e) => e.grupo === 'exitosa').length;
  const fallidas = todas.filter((e) => e.grupo === 'fallida').length;
  const canceladas = todas.filter((e) => e.grupo === 'cancelada').length;
  const enCurso = todas.filter((e) => e.grupo === 'enCurso').length;
  const esperando = todas.filter((e) => e.grupo === 'esperando').length;
  const duracion = resumenDuraciones(todas.map((e) => e.dur));

  const nombrePorId = new Map(flujos.map((f) => [String(f.wf.id), f]));
  const recientes = [...todas].sort((a, b) => b.inicio - a.inicio).slice(0, 100).map((e) => {
    const f = nombrePorId.get(e.workflowId);
    return {
      id: e.id,
      workflowId: e.workflowId,
      flujo: f?.wf.name || e.workflowId,
      cuentaNombre: f?.cuenta.nombre || null,
      estado: e.status,
      grupo: e.grupo,
      modo: e.modo,
      inicio: new Date(e.inicio).toISOString(),
      duracion: e.dur,
    };
  });

  // Por propietario (cuenta de n8n)
  const cuentas = new Map();
  for (const r of resumenes) {
    if (!cuentas.has(r.cuentaId)) cuentas.set(r.cuentaId, { cuentaId: r.cuentaId, cuentaNombre: r.cuentaNombre, flujos: 0, activos: 0, ejecuciones: 0, exitosas: 0, fallidas: 0 });
    const c = cuentas.get(r.cuentaId);
    c.flujos++; if (r.activo) c.activos++;
    c.ejecuciones += r.totalEjecuciones; c.exitosas += r.exitosas; c.fallidas += r.fallidas;
  }
  const porCuenta = [...cuentas.values()].map((c) => ({ ...c, tasaExito: tasaDeExito(c.exitosas, c.fallidas) }));

  // Por etiqueta
  const etiquetas = new Map();
  for (const r of resumenes) {
    for (const t of r.etiquetas) {
      if (!etiquetas.has(t)) etiquetas.set(t, { etiqueta: t, flujos: 0, ejecuciones: 0, fallidas: 0 });
      const x = etiquetas.get(t);
      x.flujos++; x.ejecuciones += r.totalEjecuciones; x.fallidas += r.fallidas;
    }
  }

  const atencion = resumenes
    .filter((r) => r.motivos.length)
    .map((r) => ({ workflowId: r.id, nombre: r.nombre, cuentaNombre: r.cuentaNombre, activo: r.activo, motivos: r.motivos }))
    .sort((a, b) => {
      const pa = Math.min(...a.motivos.map((m) => PESO_SEVERIDAD[m.severidad]));
      const pb = Math.min(...b.motivos.map((m) => PESO_SEVERIDAD[m.severidad]));
      return pa - pb || String(a.nombre).localeCompare(String(b.nombre));
    });

  const primera = todas.reduce((m, e) => (m === null || e.inicio < m ? e.inicio : m), null);
  const ultima = todas.reduce((m, e) => (m === null || e.inicio > m ? e.inicio : m), null);

  return {
    periodo: { dias, desde: new Date(desdeMs).toISOString(), hasta: new Date(ahoraMs).toISOString(), unidadSerie: unidad },
    flujos: resumenes,
    global: {
      flujosTotal: resumenes.length,
      activos: resumenes.filter((r) => r.activo).length,
      detenidos: resumenes.filter((r) => !r.activo).length,
      sinEjecutar: resumenes.filter((r) => r.sinEjecutar).length,
      conAtencion: atencion.length,
      ejecuciones: todas.length,
      exitosas, fallidas, canceladas, enCurso, esperando,
      tasaExito: tasaDeExito(exitosas, fallidas),
      duracion: { n: duracion.n, prom: duracion.prom, p50: duracion.p50, p95: duracion.p95, max: duracion.max },
      tiempoTotalMs: duracion.total,
      ejecucionesPorDiaProm: dias >= 1 ? Math.round((todas.length / dias) * 10) / 10 : null,
    },
    serie: { unidad, puntos: acumularEnCubetas(todas, cubetas, tz, unidad) },
    porHora: porHoraDelDia(todas, tz),
    mapaCalor: mapaDeCalor(todas, tz),
    porModo: Object.entries(contarPor(todas, (e) => e.modo)).map(([modo, cantidad]) => ({ modo, etiqueta: MODOS_ETIQUETA[modo] || modo, cantidad })).sort((a, b) => b.cantidad - a.cantidad),
    porCuenta,
    porEtiqueta: [...etiquetas.values()].sort((a, b) => b.ejecuciones - a.ejecuciones),
    atencion,
    recientes,
    cobertura: {
      ejecucionesAnalizadas: todas.length,
      primeraEjecucion: primera !== null ? new Date(primera).toISOString() : null,
      ultimaEjecucion: ultima !== null ? new Date(ultima).toISOString() : null,
    },
  };
}

// Detalle de UN flujo: mismas métricas pero con más profundidad.
function detalleDeFlujo({ wf, cuenta, wfCompleto = null, ejecuciones, dias, tz = 0, ahoraMs = Date.now() }) {
  const base = calcular({ flujos: [{ wf: wfCompleto || wf, cuenta }], ejecuciones, dias, tz, ahoraMs });
  const flujo = base.flujos[0];
  const nodos = (wfCompleto?.nodes || []).map((n) => ({ nombre: n.name, tipo: String(n.type || '').replace(/^n8n-nodes-base\./, '').replace(/^@n8n\/n8n-nodes-langchain\./, 'ia:'), deshabilitado: !!n.disabled }));
  const tiposNodo = Object.entries(contarPor(nodos, (n) => n.tipo)).map(([tipo, cantidad]) => ({ tipo, cantidad })).sort((a, b) => b.cantidad - a.cantidad);
  return {
    flujo,
    periodo: base.periodo,
    serie: base.serie,
    porHora: base.porHora,
    mapaCalor: base.mapaCalor,
    porModo: base.porModo,
    ejecuciones: base.recientes.slice(0, 50),
    nodos,
    tiposNodo,
    conexiones: wfCompleto?.connections ? Object.keys(wfCompleto.connections).length : null,
  };
}

// Los mensajes de error de n8n pueden traer URLs con tokens o cabeceras con
// credenciales (p. ej. "Request failed ... https://api/x?token=abc"). Antes de
// mostrarlos se tapan esos valores.
function ocultarSecretos(texto) {
  return String(texto)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{6,}/gi, '$1 ***')
    .replace(/([?&;\s"'](?:[\w.-]*(?:token|key|secret|password|passwd|pwd|auth|signature|sig|credential)[\w.-]*)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"',;]+)/gi, '$1***')
    .replace(/(:\/\/[^\/\s:@]+:)[^\/\s@]+@/g, '$1***@')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***');
}

// Extrae el error legible de una ejecución con datos (includeData=true).
function errorDeEjecucion(ejecucion) {
  const rd = ejecucion?.data?.resultData;
  const err = rd?.error;
  if (!err && !rd?.lastNodeExecuted) return null;
  const mensaje = ocultarSecretos(String(err?.message || err?.description || 'Error sin mensaje')).replace(/\s+/g, ' ').trim();
  return {
    nodo: err?.node?.name || rd?.lastNodeExecuted || null,
    mensaje: mensaje.length > 300 ? `${mensaje.slice(0, 297)}...` : mensaje,
  };
}

module.exports = {
  grupoDeEstado, normalizarEjecucion, calcular, detalleDeFlujo, errorDeEjecucion, ocultarSecretos, disparadoresDe,
  resumenDuraciones, tasaDeExito, claveDia, MODOS_ETIQUETA,
};
