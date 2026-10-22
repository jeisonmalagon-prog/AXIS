// ============================================================================
// Salud real, stacks e higiene de la flota de Portainer.
//
// Va más allá de «running / exited»: por cada contenedor se hace un inspect
// (reinicios, OOM, healthcheck, código de salida, límites, privilegios,
// puertos publicados) y con eso se calcula:
//   · salud()   → semáforo por entorno, contenedores inestables y problemas.
//   · stacks()  → contenedores agrupados por stack/proyecto compose, versiones
//                 de imagen y desfase de versiones entre entornos.
//   · higiene() → imágenes sin uso (espacio recuperable), volúmenes huérfanos,
//                 contenedores sin límites, privilegiados, expuestos, etc.
// Además `iniciarVigilancia()` revisa la flota cada pocos minutos y avisa por
// la campana de AXIS (y correo, si se configura) cuando algo se pone crítico.
// Todo es de SOLO LECTURA salvo las acciones explícitas de abajo
// (reiniciarStack y limpiarImagenes), que exigen permiso de edición.
// ============================================================================
const crypto = require('crypto');
const P = require('./portainer');

const CACHE_MS = 60 * 1000;
const DIAS_IMAGEN_ANTIGUA = 90;
const GB = 1024 ** 3;

const ahoraMs = () => Date.now();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
async function enParalelo(items, limite, fn) {
  const resultados = new Array(items.length);
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    for (;;) {
      const i = siguiente++;
      if (i >= items.length) return;
      try { resultados[i] = await fn(items[i], i); } catch (e) { resultados[i] = { __error: e }; }
    }
  });
  await Promise.all(trabajadores);
  return resultados;
}

function sinDigest(imagen) { return String(imagen || '').split('@')[0]; }
function tagDe(imagen) {
  const img = sinDigest(imagen);
  if (!img || img.startsWith('sha256:')) return '';
  const ultimo = img.split('/').pop();
  const i = ultimo.lastIndexOf(':');
  return i >= 0 ? ultimo.slice(i + 1) : 'latest';
}
function repoDe(imagen) {
  const img = sinDigest(imagen);
  if (!img || img.startsWith('sha256:')) return img;
  const partes = img.split('/');
  const ultimo = partes.pop();
  const i = ultimo.lastIndexOf(':');
  return [...partes, i >= 0 ? ultimo.slice(0, i) : ultimo].join('/');
}
const bytesTexto = (b) => {
  let n = Number(b) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('es-CO', { maximumFractionDigits: i === 0 ? 0 : 1 })} ${u[i]}`;
};

const DESCRIPCION_SALIDA = {
  1: 'error general de la aplicación', 2: 'uso incorrecto del comando', 126: 'el comando no se pudo ejecutar', 127: 'comando no encontrado',
  134: 'abortó (SIGABRT)', 137: 'lo mató el sistema (SIGKILL, a menudo falta de memoria)', 139: 'falla de segmentación (SIGSEGV)', 143: 'recibió la orden de terminar (SIGTERM)',
};

// ---------------------------------------------------------------------------
// Análisis de UN contenedor (lista de Docker + inspect)
// ---------------------------------------------------------------------------
const prob = (codigo, nivel, titulo, detalle) => ({ codigo, nivel, titulo, detalle });

function puertosDe(lista) {
  const vistos = new Set(); const salida = [];
  for (const p of lista || []) {
    if (!p.PublicPort) continue;
    const ip = p.IP || '';
    const clave = `${p.PublicPort}/${p.Type}`;
    const abierto = ip === '' || ip === '0.0.0.0' || ip === '::';
    if (vistos.has(clave)) { const e = salida.find((x) => x.clave === clave); if (e && abierto) e.abierto = true; continue; }
    vistos.add(clave);
    salida.push({ clave, ip: ip || '0.0.0.0', publico: p.PublicPort, privado: p.PrivatePort, tipo: p.Type || 'tcp', abierto });
  }
  return salida.map(({ clave, ...r }) => r);
}

function esRoot(user) {
  const u = String(user || '').trim().toLowerCase();
  return u === '' || u === '0' || u === 'root' || u.startsWith('0:') || u.startsWith('root:');
}

function problemasDe(k) {
  const p = [];
  const corriendo = k.estado === 'running';
  const autoReinicio = ['always', 'unless-stopped', 'on-failure'].includes(k.politica);
  if (k.estado === 'restarting') p.push(prob('reiniciando', 'critico', 'Reiniciándose en bucle', 'Docker lo reinicia una y otra vez: la aplicación falla al arrancar.'));
  if (k.salud === 'unhealthy') p.push(prob('no_saludable', 'critico', 'Healthcheck fallando', 'Está corriendo, pero su verificación de salud no pasa.'));
  if (k.oomKilled) p.push(prob('oom', corriendo ? 'aviso' : 'critico', 'Sin memoria (OOM)', `Docker lo terminó por pasarse de memoria${k.memLimiteMb ? ` (límite ${k.memLimiteMb} MB)` : ' (sin límite propio: la memoria del servidor se agotó)'}.`));
  if (k.reinicios !== null && k.reinicios >= 3) {
    const reciente = k.iniciadoEn && ahoraMs() - Date.parse(k.iniciadoEn) < 60 * 60 * 1000;
    p.push(prob('reinicios', reciente ? 'critico' : 'aviso', `${k.reinicios} reinicios`, reciente ? 'Arrancó hace menos de una hora: posible bucle de fallos.' : 'Acumula reinicios automáticos desde que se creó.'));
  }
  if ((k.estado === 'exited' || k.estado === 'dead') && k.codigoSalida !== null && k.codigoSalida !== 0) {
    const d = DESCRIPCION_SALIDA[k.codigoSalida];
    p.push(prob('salio_con_error', autoReinicio ? 'critico' : 'aviso', `Terminó con código ${k.codigoSalida}`, d ? `Salida ${k.codigoSalida}: ${d}.` : `Terminó con error (código ${k.codigoSalida}).`));
  } else if ((k.estado === 'exited') && ['always', 'unless-stopped'].includes(k.politica)) {
    p.push(prob('detenido', 'aviso', 'Detenido aunque debería estar activo', 'Su política es reiniciarse siempre; lo más probable es que alguien lo detuvo a mano.'));
  }
  return p;
}
const PESO = { critico: 2, aviso: 1 };
const nivelDe = (probs) => (probs.some((x) => x.nivel === 'critico') ? 'critico' : probs.length ? 'aviso' : 'ok');

function analizar(entorno, c, raw) {
  const st = (raw && raw.State) || {};
  const hc = (raw && raw.HostConfig) || {};
  const cfg = (raw && raw.Config) || {};
  const labels = c.Labels || cfg.Labels || {};
  const imagen = c.Image || cfg.Image || '';
  const nombre = ((c.Names && c.Names[0]) || (raw && raw.Name) || '').replace(/^\//, '') || String(c.Id).slice(0, 12);
  const terminado = st.FinishedAt && !String(st.FinishedAt).startsWith('0001-01-01') ? st.FinishedAt : null;
  const salud = st.Health && st.Health.Status ? st.Health.Status : (cfg.Healthcheck && cfg.Healthcheck.Test && cfg.Healthcheck.Test[0] !== 'NONE' ? 'starting' : 'sin-healthcheck');
  const memLim = num(hc.Memory) && hc.Memory > 0 ? Math.round(hc.Memory / (1024 * 1024)) : null;
  const cpuLim = num(hc.NanoCpus) && hc.NanoCpus > 0 ? +(hc.NanoCpus / 1e9).toFixed(2)
    : (num(hc.CpuQuota) && hc.CpuQuota > 0 ? +(hc.CpuQuota / (hc.CpuPeriod || 100000)).toFixed(2) : null);
  const compose = labels['com.docker.compose.project'];
  const swarm = labels['com.docker.stack.namespace'];
  const k = {
    id: String(c.Id).substring(0, 12),
    entornoId: entorno.Id, entorno: entorno.Name,
    nombre, imagen, repo: repoDe(imagen), tag: tagDe(imagen),
    estado: String(c.State || st.Status || '').toLowerCase(), estadoTexto: c.Status || '',
    salud, reinicios: raw ? (num(raw.RestartCount) ?? 0) : null, oomKilled: !!st.OOMKilled,
    codigoSalida: raw && num(st.ExitCode) !== null ? st.ExitCode : null,
    iniciadoEn: st.StartedAt && !String(st.StartedAt).startsWith('0001-01-01') ? st.StartedAt : null, terminadoEn: terminado,
    creadoEn: c.Created ? new Date(c.Created * 1000).toISOString() : (raw && raw.Created) || null,
    politica: (hc.RestartPolicy && hc.RestartPolicy.Name) || (raw ? 'no' : null),
    privilegiado: !!hc.Privileged, root: raw ? esRoot(cfg.User) : null,
    memLimiteMb: memLim, cpuLimite: cpuLim, limitesConocidos: !!raw,
    puertos: puertosDe(c.Ports),
    stack: compose || swarm || null, stackTipo: compose ? 'compose' : swarm ? 'swarm' : null,
    servicio: labels['com.docker.compose.service'] || labels['com.docker.swarm.service.name'] || null,
  };
  k.problemas = problemasDe(k);
  k.nivel = nivelDe(k.problemas);
  return k;
}

// ---------------------------------------------------------------------------
// Recolección (con caché de 60 s y una sola consulta en vuelo)
// ---------------------------------------------------------------------------
async function recolectarEntorno(ep) {
  const base = { id: ep.Id, nombre: ep.Name, conexion: ep.Status === 1 ? 'up' : 'down', error: null, contenedores: [], imagenes: [], volumenes: [], redes: [], parcial: [] };
  if (base.conexion !== 'up') { base.error = 'Entorno desconectado en Portainer.'; return base; }
  try {
    const crudos = await P.listarContenedores(ep.Id);
    const insp = await enParalelo(crudos, 8, (c) => P.peticionAutenticada(`/api/endpoints/${ep.Id}/docker/containers/${c.Id}/json`));
    base.contenedores = crudos.map((c, i) => analizar(ep, c, insp[i] && !insp[i].__error ? insp[i] : null));
    if (insp.some((x) => x && x.__error)) base.parcial.push('inspect');
  } catch (e) { base.error = e.message || 'No se pudo consultar este entorno.'; return base; }
  const [im, vo, re] = await Promise.all([
    P.listarImagenes(ep.Id).catch(() => null), P.listarVolumenes(ep.Id).catch(() => null), P.listarRedes(ep.Id).catch(() => null),
  ]);
  if (im) base.imagenes = im; else base.parcial.push('imagenes');
  if (vo) base.volumenes = vo; else base.parcial.push('volumenes');
  if (re) base.redes = re; else base.parcial.push('redes');
  return base;
}

let cache = null; let cacheEn = 0; let enVuelo = null;
async function recolectar({ fresco = false } = {}) {
  if (!P.PORTAINER_CONFIGURADO) return null;
  if (!fresco && cache && ahoraMs() - cacheEn < CACHE_MS) return cache;
  if (enVuelo) return enVuelo;
  enVuelo = (async () => {
    try {
      if (fresco) P.olvidarEndpoints();
      const endpoints = await P.listarEndpoints();
      const [entornos, stacksPortainer] = await Promise.all([
        enParalelo(endpoints, 4, recolectarEntorno),
        P.peticionAutenticada('/api/stacks').catch(() => []),
      ]);
      cache = {
        generadoEn: new Date().toISOString(),
        entornos: entornos.map((e, i) => (e && e.__error ? { id: endpoints[i].Id, nombre: endpoints[i].Name, conexion: 'down', error: e.__error.message, contenedores: [], imagenes: [], volumenes: [], redes: [], parcial: [] } : e)),
        stacksPortainer: Array.isArray(stacksPortainer) ? stacksPortainer : [],
      };
      cacheEn = ahoraMs();
      return cache;
    } finally { enVuelo = null; }
  })();
  return enVuelo;
}

// ---------------------------------------------------------------------------
// 1) SALUD
// ---------------------------------------------------------------------------
function resumenEntorno(e) {
  const cs = e.contenedores;
  const criticos = cs.filter((c) => c.nivel === 'critico').length;
  const avisos = cs.filter((c) => c.nivel === 'aviso').length;
  const corriendo = cs.filter((c) => c.estado === 'running').length;
  const semaforo = e.conexion !== 'up' || e.error ? 'critico' : criticos ? 'critico' : avisos ? 'aviso' : 'ok';
  return {
    id: e.id, nombre: e.nombre, conexion: e.conexion, error: e.error, semaforo,
    total: cs.length, corriendo, detenidos: cs.length - corriendo, criticos, avisos,
    puntaje: e.conexion !== 'up' ? 0 : Math.max(0, 100 - criticos * 25 - avisos * 8),
    reinicios: cs.reduce((a, c) => a + (c.reinicios || 0), 0),
  };
}

function salud(datos) {
  const entornos = datos.entornos.map(resumenEntorno);
  const todos = datos.entornos.flatMap((e) => e.contenedores);
  const conProblema = todos.filter((c) => c.problemas.length)
    .sort((a, b) => (PESO[b.nivel] || 0) - (PESO[a.nivel] || 0) || (b.reinicios || 0) - (a.reinicios || 0) || a.entorno.localeCompare(b.entorno));
  const arriba = entornos.filter((e) => e.conexion === 'up').length;
  const criticos = conProblema.filter((c) => c.nivel === 'critico').length;
  const avisos = conProblema.length - criticos;
  const sano = todos.length - conProblema.length;
  const resumen = {
    entornos: entornos.length, entornosArriba: arriba, entornosCaidos: entornos.length - arriba,
    contenedores: todos.length, corriendo: todos.filter((c) => c.estado === 'running').length,
    criticos, avisos, sanos: sano,
    porcentajeSano: todos.length ? +((sano / todos.length) * 100).toFixed(1) : null,
    sinHealthcheck: todos.filter((c) => c.estado === 'running' && c.salud === 'sin-healthcheck').length,
    oom: todos.filter((c) => c.oomKilled).length,
  };
  const semaforo = resumen.entornosCaidos || criticos ? 'critico' : avisos ? 'aviso' : 'ok';
  const tarjeta = (c) => ({
    id: c.id, entornoId: c.entornoId, entorno: c.entorno, nombre: c.nombre, imagen: c.imagen, estado: c.estado, estadoTexto: c.estadoTexto, salud: c.salud,
    reinicios: c.reinicios, oomKilled: c.oomKilled, codigoSalida: c.codigoSalida, iniciadoEn: c.iniciadoEn, terminadoEn: c.terminadoEn, politica: c.politica,
    nivel: c.nivel, problemas: c.problemas, stack: c.stack,
  });
  return {
    configurado: true, generadoEn: datos.generadoEn, semaforo, resumen,
    entornos: entornos.sort((a, b) => (a.semaforo === b.semaforo ? a.nombre.localeCompare(b.nombre) : (a.semaforo === 'critico' ? -1 : b.semaforo === 'critico' ? 1 : a.semaforo === 'aviso' ? -1 : 1))),
    inestables: conProblema.slice(0, 12).map(tarjeta),
    problemas: conProblema.slice(0, 400).map(tarjeta),
    truncado: conProblema.length > 400,
  };
}

// ---------------------------------------------------------------------------
// 2) STACKS y versiones
// ---------------------------------------------------------------------------
function stacks(datos) {
  const registrados = new Map();
  for (const s of datos.stacksPortainer) registrados.set(`${s.EndpointId}::${String(s.Name || '').toLowerCase()}`, s);
  const lista = [];
  const sueltos = [];
  for (const e of datos.entornos) {
    const grupos = new Map();
    let fuera = 0;
    for (const c of e.contenedores) {
      if (!c.stack) { fuera++; continue; }
      if (!grupos.has(c.stack)) grupos.set(c.stack, []);
      grupos.get(c.stack).push(c);
    }
    sueltos.push({ entornoId: e.id, entorno: e.nombre, contenedores: fuera });
    for (const [nombre, cs] of grupos) {
      const reg = registrados.get(`${e.id}::${nombre.toLowerCase()}`) || null;
      const corriendo = cs.filter((c) => c.estado === 'running').length;
      const criticos = cs.filter((c) => c.nivel === 'critico').length;
      const avisos = cs.filter((c) => c.nivel === 'aviso').length;
      const porRepo = new Map();
      for (const c of cs) { if (!porRepo.has(c.repo)) porRepo.set(c.repo, new Set()); porRepo.get(c.repo).add(c.tag || '—'); }
      const creados = cs.map((c) => c.creadoEn).filter(Boolean).sort();
      const iniciados = cs.map((c) => c.iniciadoEn).filter(Boolean).sort();
      const desplegado = reg && (reg.UpdateDate || reg.CreationDate) ? new Date((reg.UpdateDate || reg.CreationDate) * 1000).toISOString() : (creados[0] || null);
      lista.push({
        entornoId: e.id, entorno: e.nombre, nombre,
        tipo: cs[0].stackTipo, gestionadoPortainer: !!reg, stackId: reg ? reg.Id : null,
        git: reg && reg.GitConfig ? { url: reg.GitConfig.URL || null, rama: (reg.GitConfig.ReferenceName || '').replace('refs/heads/', '') || null } : null,
        total: cs.length, corriendo, criticos, avisos,
        estado: corriendo === 0 ? 'caido' : criticos ? 'problemas' : corriendo < cs.length ? 'parcial' : avisos ? 'avisos' : 'ok',
        desplegadoEn: desplegado, ultimoInicio: iniciados.length ? iniciados[iniciados.length - 1] : null,
        versiones: [...porRepo.entries()].map(([repo, tags]) => ({ repo, tags: [...tags] })),
        mezclaVersiones: [...porRepo.values()].some((t) => t.size > 1),
        contenedores: cs.map((c) => ({ id: c.id, nombre: c.nombre, servicio: c.servicio, imagen: c.imagen, tag: c.tag, estado: c.estado, estadoTexto: c.estadoTexto, salud: c.salud, nivel: c.nivel, reinicios: c.reinicios })),
      });
    }
  }
  const orden = { caido: 0, problemas: 1, parcial: 2, avisos: 3, ok: 4 };
  lista.sort((a, b) => orden[a.estado] - orden[b.estado] || a.entorno.localeCompare(b.entorno) || a.nombre.localeCompare(b.nombre));

  // Desfase de versiones: la misma imagen corriendo con etiquetas distintas en entornos distintos.
  const porRepo = new Map();
  for (const e of datos.entornos) {
    for (const c of e.contenedores) {
      if (!c.repo || c.repo.startsWith('sha256:') || c.estado !== 'running') continue;
      if (!porRepo.has(c.repo)) porRepo.set(c.repo, new Map());
      const tags = porRepo.get(c.repo);
      const t = c.tag || '—';
      if (!tags.has(t)) tags.set(t, new Set());
      tags.get(t).add(e.nombre);
    }
  }
  const desfase = [...porRepo.entries()].filter(([, tags]) => tags.size > 1)
    .map(([repo, tags]) => ({ repo, versiones: [...tags.entries()].map(([tag, ents]) => ({ tag, entornos: [...ents].sort() })).sort((a, b) => b.entornos.length - a.entornos.length) }))
    .sort((a, b) => b.versiones.length - a.versiones.length || a.repo.localeCompare(b.repo)).slice(0, 40);

  return {
    configurado: true, generadoEn: datos.generadoEn,
    resumen: {
      stacks: lista.length, conProblemas: lista.filter((s) => ['caido', 'problemas', 'parcial'].includes(s.estado)).length,
      gestionados: lista.filter((s) => s.gestionadoPortainer).length, mezclaVersiones: lista.filter((s) => s.mezclaVersiones).length,
      imagenesConDesfase: desfase.length, contenedoresSueltos: sueltos.reduce((a, s) => a + s.contenedores, 0),
    },
    stacks: lista, sueltos: sueltos.filter((s) => s.contenedores), desfase,
  };
}

// ---------------------------------------------------------------------------
// 3) HIGIENE
// ---------------------------------------------------------------------------
function higiene(datos) {
  const ahora = ahoraMs();
  const cat = {};
  const nueva = (codigo, titulo, descripcion, nivel) => { cat[codigo] = { codigo, titulo, descripcion, nivel, cantidad: 0, items: [] }; return cat[codigo]; };
  const imagenesSinUso = nueva('imagenes_sin_uso', 'Imágenes sin usar', 'Imágenes que ningún contenedor usa: ocupan disco y se pueden borrar.', 'info');
  const sinEtiqueta = nueva('imagenes_sin_etiqueta', 'Imágenes sin etiqueta', 'Capas huérfanas («<none>») sin uso: es seguro limpiarlas en bloque.', 'info');
  const antiguas = nueva('imagenes_antiguas', `Imágenes sin uso de más de ${DIAS_IMAGEN_ANTIGUA} días`, 'Versiones viejas que ya nadie usa.', 'info');
  const volumenes = nueva('volumenes_huerfanos', 'Volúmenes huérfanos', 'Volúmenes que ningún contenedor monta. Revisa antes de borrar: pueden tener datos.', 'aviso');
  const redes = nueva('redes_sin_uso', 'Redes sin uso', 'Redes personalizadas sin contenedores conectados.', 'info');
  const privilegiados = nueva('privilegiados', 'Contenedores privilegiados', 'Tienen acceso casi total al servidor: solo deberían existir si es imprescindible.', 'aviso');
  const sinMem = nueva('sin_limite_memoria', 'Sin límite de memoria', 'Si se descontrolan, pueden agotar la memoria del servidor y tumbar a los demás.', 'aviso');
  const sinCpu = nueva('sin_limite_cpu', 'Sin límite de CPU', 'Pueden acaparar el procesador del servidor.', 'info');
  const root = nueva('como_root', 'Corren como root', 'El proceso interno se ejecuta como administrador del contenedor.', 'info');
  const expuestos = nueva('puertos_expuestos', 'Puertos abiertos a toda la red', 'Publicados en 0.0.0.0: cualquiera que llegue al servidor puede conectarse.', 'info');
  const sinHc = nueva('sin_healthcheck', 'Sin healthcheck', 'Docker no puede saber si la aplicación realmente responde.', 'info');
  const sinReinicio = nueva('sin_reinicio_automatico', 'Sin reinicio automático', 'Si se cae o el servidor se reinicia, no vuelve solo.', 'info');
  const latest = nueva('imagen_latest', 'Imagen con etiqueta «latest»', 'No se sabe qué versión corre exactamente ni se puede volver atrás con certeza.', 'aviso');

  const agrega = (c, item) => { c.cantidad++; if (c.items.length < 250) c.items.push(item); };
  let bytesSinUso = 0; let bytesSinEtiqueta = 0; let bytesAntiguas = 0;
  const porEntorno = [];

  for (const e of datos.entornos) {
    const r = { id: e.id, nombre: e.nombre, conexion: e.conexion, imagenesSinUso: 0, bytesRecuperables: 0, volumenesHuerfanos: 0, redesSinUso: 0, privilegiados: 0, sinLimiteMemoria: 0, corriendo: 0, sinHealthcheck: 0, puertosExpuestos: 0, comoRoot: 0, parcial: e.parcial || [] };
    for (const img of e.imagenes) {
      if (img.enUso) continue;
      const dias = img.creadaEn ? Math.floor((ahora - Date.parse(img.creadaEn)) / 86400000) : null;
      const nombre = img.tags.length ? img.tags[0] : `<none> (${img.id})`;
      const item = { entorno: e.nombre, entornoId: e.id, nombre, extra: `${bytesTexto(img.tamanoBytes)}${dias !== null ? ` · ${dias} días` : ''}`, bytes: img.tamanoBytes };
      agrega(imagenesSinUso, item); r.imagenesSinUso++; r.bytesRecuperables += img.tamanoBytes; bytesSinUso += img.tamanoBytes;
      if (!img.tags.length) { agrega(sinEtiqueta, item); bytesSinEtiqueta += img.tamanoBytes; }
      if (dias !== null && dias >= DIAS_IMAGEN_ANTIGUA) { agrega(antiguas, item); bytesAntiguas += img.tamanoBytes; }
    }
    for (const v of e.volumenes) if (!v.enUso) { agrega(volumenes, { entorno: e.nombre, entornoId: e.id, nombre: v.nombre, extra: v.driver || '' }); r.volumenesHuerfanos++; }
    for (const n of e.redes) if (!n.contenedoresConectados && !['bridge', 'host', 'none', 'ingress'].includes(n.nombre)) { agrega(redes, { entorno: e.nombre, entornoId: e.id, nombre: n.nombre, extra: n.driver || '' }); r.redesSinUso++; }
    for (const c of e.contenedores) {
      const item = (extra) => ({ entorno: e.nombre, entornoId: e.id, nombre: c.nombre, extra: extra || c.imagen });
      if (c.privilegiado) { agrega(privilegiados, item()); r.privilegiados++; }
      if (c.estado !== 'running') continue;
      r.corriendo++;
      if (c.limitesConocidos && c.memLimiteMb === null) { agrega(sinMem, item()); r.sinLimiteMemoria++; }
      if (c.limitesConocidos && c.cpuLimite === null) agrega(sinCpu, item());
      if (c.root) { agrega(root, item()); r.comoRoot++; }
      const abiertos = c.puertos.filter((p) => p.abierto);
      if (abiertos.length) { agrega(expuestos, item(abiertos.map((p) => `${p.publico}/${p.tipo}`).join(', '))); r.puertosExpuestos++; }
      if (c.salud === 'sin-healthcheck') { agrega(sinHc, item()); r.sinHealthcheck++; }
      if (c.limitesConocidos && c.politica === 'no') agrega(sinReinicio, item());
      if (c.tag === 'latest') agrega(latest, item());
    }
    // Puntaje informativo (100 = impecable).
    const ratio = (n) => (r.corriendo ? n / r.corriendo : 0);
    r.puntaje = e.conexion !== 'up' ? null : Math.max(0, Math.round(100
      - Math.min(30, r.privilegiados * 10) - Math.min(20, r.puertosExpuestos * 2) - ratio(r.sinLimiteMemoria) * 20
      - (r.bytesRecuperables > 5 * GB ? 10 : r.bytesRecuperables > GB ? 5 : 0) - Math.min(10, r.volumenesHuerfanos)
      - ratio(r.comoRoot) * 10 - ratio(r.sinHealthcheck) * 10));
    porEntorno.push(r);
  }
  imagenesSinUso.bytes = bytesSinUso; sinEtiqueta.bytes = bytesSinEtiqueta; antiguas.bytes = bytesAntiguas;
  [imagenesSinUso, sinEtiqueta, antiguas].forEach((c) => { c.items.sort((a, b) => b.bytes - a.bytes); });
  if (bytesSinUso > 5 * GB) imagenesSinUso.nivel = 'aviso';

  const categorias = Object.values(cat);
  const conPuntaje = porEntorno.filter((p) => p.puntaje !== null);
  return {
    configurado: true, generadoEn: datos.generadoEn, diasImagenAntigua: DIAS_IMAGEN_ANTIGUA,
    resumen: {
      espacioRecuperableBytes: bytesSinUso, espacioRecuperableTexto: bytesTexto(bytesSinUso),
      espacioSinEtiquetaBytes: bytesSinEtiqueta, espacioSinEtiquetaTexto: bytesTexto(bytesSinEtiqueta),
      espacioAntiguasBytes: bytesAntiguas, espacioAntiguasTexto: bytesTexto(bytesAntiguas),
      hallazgos: categorias.filter((c) => c.nivel === 'aviso').reduce((a, c) => a + c.cantidad, 0),
      puntajePromedio: conPuntaje.length ? Math.round(conPuntaje.reduce((a, p) => a + p.puntaje, 0) / conPuntaje.length) : null,
    },
    categorias, entornos: porEntorno.sort((a, b) => (a.puntaje ?? -1) - (b.puntaje ?? -1)),
  };
}

// ---------------------------------------------------------------------------
// Acciones (con permiso de edición en la ruta)
// ---------------------------------------------------------------------------
async function reiniciarStack(entornoId, nombreStack) {
  const datos = await recolectar({ fresco: true });
  const e = datos && datos.entornos.find((x) => String(x.id) === String(entornoId));
  if (!e) throw Object.assign(new Error('Ese entorno no existe en Portainer.'), { status: 404 });
  const cs = e.contenedores.filter((c) => c.stack === nombreStack);
  if (!cs.length) throw Object.assign(new Error('Ese stack no existe en el entorno.'), { status: 404 });
  const resultados = await enParalelo(cs, 3, async (c) => {
    await P.ejecutarAccionContenedor(e.id, c.id, 'restart');
    return c.nombre;
  });
  const fallidos = [];
  resultados.forEach((r, i) => { if (r && r.__error) fallidos.push({ nombre: cs[i].nombre, error: String(r.__error.message || '').slice(0, 160) }); });
  cache = null;
  return { entorno: e.nombre, stack: nombreStack, reiniciados: cs.length - fallidos.length, fallidos };
}

async function limpiarImagenes(entornoId, modo, dias = DIAS_IMAGEN_ANTIGUA) {
  if (!['huerfanas', 'antiguas'].includes(modo)) throw Object.assign(new Error('Modo de limpieza no válido.'), { status: 400 });
  const endpoints = await P.listarEndpoints();
  const ep = endpoints.find((x) => String(x.Id) === String(entornoId));
  if (!ep) throw Object.assign(new Error('Ese entorno no existe en Portainer.'), { status: 404 });
  if (ep.Status !== 1) throw Object.assign(new Error('El entorno está desconectado.'), { status: 409 });
  let eliminadas = 0; let bytes = 0; const fallidas = [];
  if (modo === 'huerfanas') {
    const filtros = encodeURIComponent(JSON.stringify({ dangling: ['true'] }));
    const r = await P.peticionAutenticada(`/api/endpoints/${ep.Id}/docker/images/prune?filters=${filtros}`, { method: 'POST', timeoutMs: 60000 });
    eliminadas = (r.ImagesDeleted || []).length; bytes = r.SpaceReclaimed || 0;
  } else {
    const limite = Math.max(30, Math.min(3650, Number(dias) || DIAS_IMAGEN_ANTIGUA));
    const imgs = await P.listarImagenes(ep.Id);
    const objetivo = imgs.filter((i) => !i.enUso && i.creadaEn && (ahoraMs() - Date.parse(i.creadaEn)) / 86400000 >= limite);
    for (const i of objetivo) {
      try { await P.eliminarImagen(ep.Id, i.id); eliminadas++; bytes += i.tamanoBytes || 0; } catch (e) { fallidas.push(i.tags[0] || i.id); }
    }
  }
  cache = null;
  return { entorno: ep.Name, modo, eliminadas, bytesLiberados: bytes, espacioLiberado: bytesTexto(bytes), fallidas: fallidas.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Vigilancia y alertas
// ---------------------------------------------------------------------------
const recientes = []; // últimas alertas generadas (en memoria; la campana guarda el histórico)
const activas = new Map(); // clave → { titulo, desde }
const avisadas = new Map(); // clave → bucket ya notificado/enviado por correo
let ultimaVigilancia = null;
let vigilanciaEnCurso = false;

const corto = (s) => crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 10);
const numeroEnv = (n, def, min, max) => { const v = Number(process.env[n]); return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def; };

function alertasDe(datos) {
  const res = [];
  for (const e of datos.entornos) {
    if (e.conexion !== 'up' || e.error) {
      res.push({ clave: `down:${e.id}`, tipo: 'entorno', entorno: e.nombre, titulo: `Entorno ${e.nombre} sin conexión`, mensaje: e.error || 'Portainer lo reporta desconectado.' });
      continue;
    }
    const criticos = e.contenedores.filter((c) => c.nivel === 'critico');
    if (criticos.length) {
      const nombres = criticos.map((c) => c.nombre).sort();
      const detalle = criticos.slice(0, 4).map((c) => `${c.nombre}: ${c.problemas.filter((p) => p.nivel === 'critico')[0].titulo}`).join('; ');
      res.push({
        clave: `crit:${e.id}:${corto(nombres.join(','))}`, tipo: 'contenedores', entorno: e.nombre,
        titulo: `${e.nombre}: ${criticos.length} contenedor${criticos.length === 1 ? '' : 'es'} en estado crítico`,
        mensaje: `${detalle}${criticos.length > 4 ? ` y ${criticos.length - 4} más` : ''}.`,
      });
    }
  }
  return res;
}

async function destinatarios(pool) {
  const [filas] = await pool.query(
    `SELECT u.id FROM usuarios u
      WHERE u.activo = 1 AND (u.rol = 'ADMIN_POD' OR EXISTS (SELECT 1 FROM usuario_modulos um JOIN modulos m ON m.id = um.modulo_id WHERE um.usuario_id = u.id AND m.nombre = 'SERVIDORES'))`
  );
  return filas.map((f) => f.id);
}

async function cicloVigilancia({ notificarVarios, getPool, enviarCorreo } = {}) {
  if (vigilanciaEnCurso || !P.PORTAINER_CONFIGURADO) return null;
  vigilanciaEnCurso = true;
  try {
    const datos = await recolectar();
    if (!datos) return null;
    const actuales = alertasDe(datos);
    const repetirH = numeroEnv('PORTAINER_ALERTA_REPETIR_HORAS', 12, 1, 168);
    const bucket = Math.floor(ahoraMs() / (repetirH * 3600 * 1000));
    const claves = new Set(actuales.map((a) => a.clave));
    const nuevas = [];
    for (const a of actuales) {
      if (!activas.has(a.clave)) { activas.set(a.clave, { titulo: a.titulo, desde: new Date().toISOString() }); recientes.unshift({ ...a, nivel: 'critico', en: new Date().toISOString() }); }
      if (avisadas.get(a.clave) !== bucket) { avisadas.set(a.clave, bucket); nuevas.push(a); }
    }
    const resueltas = [...activas.entries()].filter(([k]) => !claves.has(k));
    for (const [k, v] of resueltas) { activas.delete(k); avisadas.delete(k); recientes.unshift({ clave: k, tipo: 'recuperado', titulo: `Recuperado: ${v.titulo}`, mensaje: 'Ya no se detecta el problema.', nivel: 'ok', en: new Date().toISOString() }); }
    recientes.splice(60);
    ultimaVigilancia = { en: new Date().toISOString(), activas: actuales.length, nuevas: nuevas.length };

    if ((nuevas.length || resueltas.length) && getPool && notificarVarios) {
      const pool = await getPool();
      const dest = await destinatarios(pool);
      for (const a of nuevas) {
        await notificarVarios(pool, dest, { tipo: 'PORTAINER_ALERTA', severidad: 'ALERTA', titulo: a.titulo.slice(0, 190), mensaje: a.mensaje, enlace: '/monitoreo-servidores?vista=salud', clave: `pt-${a.clave}-${bucket}`.slice(0, 118) });
      }
      for (const [k, v] of resueltas) {
        await notificarVarios(pool, dest, { tipo: 'PORTAINER_RECUPERADO', severidad: 'INFO', titulo: `Recuperado: ${v.titulo}`.slice(0, 190), mensaje: 'Portainer ya no reporta el problema.', enlace: '/monitoreo-servidores?vista=salud', clave: `pt-ok-${k}-${Math.floor(ahoraMs() / 600000)}`.slice(0, 118) });
      }
    }
    if (nuevas.length && enviarCorreo) {
      try { await enviarCorreo(nuevas); } catch (e) { console.error('Alerta de Portainer por correo:', e.message); }
    }
    return ultimaVigilancia;
  } catch (e) {
    console.error('Vigilancia de Portainer:', e.message);
    return null;
  } finally { vigilanciaEnCurso = false; }
}

function estadoVigilancia() {
  const deshab = String(process.env.PORTAINER_ALERTAS_DESHABILITADAS || '').toLowerCase() === 'true';
  return {
    activa: P.PORTAINER_CONFIGURADO && !deshab, cadaMin: numeroEnv('PORTAINER_VIGILANCIA_MIN', 2, 1, 60),
    repetirHoras: numeroEnv('PORTAINER_ALERTA_REPETIR_HORAS', 12, 1, 168),
    correo: Boolean((process.env.PORTAINER_ALERTA_EMAILS || '').trim()), ultima: ultimaVigilancia,
    activasAhora: [...activas.entries()].map(([clave, v]) => ({ clave, ...v })), recientes: recientes.slice(0, 30),
  };
}

let temporizador = null;
function iniciarVigilancia(deps) {
  if (temporizador || !P.PORTAINER_CONFIGURADO) return;
  if (String(process.env.PORTAINER_ALERTAS_DESHABILITADAS || '').toLowerCase() === 'true') return;
  const cada = numeroEnv('PORTAINER_VIGILANCIA_MIN', 2, 1, 60) * 60 * 1000;
  setTimeout(() => cicloVigilancia(deps), 45 * 1000).unref();
  temporizador = setInterval(() => cicloVigilancia(deps), cada);
  temporizador.unref();
}

function _reiniciarParaPruebas() { cache = null; cacheEn = 0; recientes.length = 0; activas.clear(); avisadas.clear(); }

module.exports = { recolectar, salud, stacks, higiene, reiniciarStack, limpiarImagenes, cicloVigilancia, estadoVigilancia, iniciarVigilancia, alertasDe, _reiniciarParaPruebas, tagDe, repoDe };
