// Cruce entre lo que corre en Portainer (contenedores y sus puertos) y el inventario de
// sub-aplicativos (Servidor_Componentes + su ficha en inv_aplicativos).
//
// Para cada servidor que está en Portainer se empareja cada contenedor con su sub-aplicativo:
//   1. por NOMBRE (container_ms_usuarios ≈ ms-usuarios-1 ≈ ms_usuarios),
//   2. si no, por el nombre de la IMAGEN (registro/ms-usuarios:1.2 → ms_usuarios),
//   3. si no, por el PUERTO publicado (el nombre cambió pero es el mismo puerto).
// Y se señala todo lo que no cuadra (campo `hallazgos` de cada fila):
//   sin_registrar        contenedor que corre en Portainer y no está en el inventario
//   sin_contenedor       sub-aplicativo del inventario sin contenedor en Portainer
//   fuera_de_docker      sub-aplicativo que por su nombre no es de Docker (.service, dotnet…): no se espera contenedor
//   nombre_distinto      emparejado solo por puerto: el nombre del inventario no coincide
//   puerto_distinto      el puerto del inventario no es uno de los que publica el contenedor
//   sin_puerto_inventario el contenedor publica puertos y el inventario no tiene ninguno registrado
//   estado_distinto      el inventario dice Activo y el contenedor está detenido (o al revés)
//   con_problemas        contenedor reiniciándose, pausado o «unhealthy»
//   version_distinta     la versión de imagen registrada no coincide con la que corre
//   puerto_duplicado     el mismo puerto lo publican dos contenedores, un detenido lo reserva, o el inventario lo repite
//   varios_contenedores  más de un contenedor para el mismo sub-aplicativo
//   sin_servidor         el servidor de Portainer no existe en el inventario de servidores
//
// Las funciones «puro…» no tocan red ni base de datos para poder probarlas.

const { consultarEntornos, puroEmparejar } = require('./puertosPortainer');

const ESTADOS_CORRIENDO = new Set(['running']);
const ESTADOS_ACTIVOS = new Set(['Activo']);
const ESTADOS_DE_BAJA = new Set(['Inactivo', 'Deprecado']);

// ---------------------------------------------------------------- nombres
function clave(nombre) {
  return String(nombre || '')
    .trim().toLowerCase()
    .replace(/\.service$/, '').replace(/\.exe$/, '')
    .replace(/^(container|contenedor|docker|dotnet)[_\-\s.]+/, '')
    .replace(/[_\-]\d+$/, '') // réplica de compose: ms-usuarios-1
    .replace(/[^a-z0-9]/g, '');
}

/** «registro.com/grupo/ms-usuarios:1.2.3» → { nombre: 'ms-usuarios', tag: '1.2.3' } */
function partesImagen(imagen) {
  const sinDigest = String(imagen || '').split('@')[0];
  const ultimo = sinDigest.split('/').pop() || '';
  const i = ultimo.lastIndexOf(':');
  return { nombre: i >= 0 ? ultimo.slice(0, i) : ultimo, tag: i >= 0 ? ultimo.slice(i + 1) : '' };
}

/** Por su nombre, ¿se espera que este sub-aplicativo sea un contenedor? (null = no se sabe) */
function probableDocker(nombre) {
  const n = String(nombre || '').trim().toLowerCase();
  if (/^(container|contenedor|docker)[_\-\s.]/.test(n)) return true;
  if (/\.service$/.test(n) || /^dotnet[_\-\s.]/.test(n) || /\.exe$/.test(n) || /^iis[_\-\s.]/.test(n)) return false;
  return null;
}

const normVersion = (v) => String(v || '').trim().toLowerCase().replace(/^v/, '');

// ---------------------------------------------------------------- contenedores de un entorno
/** Lista simple de los contenedores de un entorno de Portainer (con todos sus puertos publicados). */
function puroContenedores(entorno) {
  const lista = entorno.todos || [];
  return lista.map((c) => ({
    ...c,
    clave: clave(c.nombre),
    claveImagen: clave(partesImagen(c.imagen).nombre),
    tag: partesImagen(c.imagen).tag,
    entorno: entorno.nombre,
    entornoId: entorno.id,
  }));
}

const puertosDe = (c) => (c.puertos || []).map((p) => p.puerto);

/** Mismo puerto en dos contenedores del mismo servidor (los reservados por detenidos solo chocan con los que corren). */
function puroPuertosEnConflicto(contenedores) {
  const porPuerto = new Map();
  for (const c of contenedores) {
    for (const p of c.puertos || []) {
      const k = `${p.puerto}/${p.protocolo}`;
      if (!porPuerto.has(k)) porPuerto.set(k, []);
      porPuerto.get(k).push({ c, p });
    }
  }
  const conflictivos = new Map(); // id de contenedor → [{puerto, con:[nombres]}]
  for (const [k, lista] of porPuerto.entries()) {
    if (lista.length < 2) continue;
    const corriendo = lista.filter((x) => !x.p.reservado);
    const reservados = lista.filter((x) => x.p.reservado);
    const grupo = corriendo.length >= 2 ? lista : (corriendo.length === 1 && reservados.length ? lista : []);
    // Dos direcciones distintas y específicas (p. ej. 10.0.0.1:80 y 10.0.0.2:80) no chocan.
    const choca = grupo.length >= 2 && grupo.some((a, i) => grupo.some((b, j) => i < j && (
      a.p.direcciones.some((d) => b.p.direcciones.includes(d) || d === '0.0.0.0' || d === '::' || b.p.direcciones.includes('0.0.0.0') || b.p.direcciones.includes('::')))));
    if (!choca) continue;
    for (const { c, p } of grupo) {
      const otros = grupo.filter((x) => x.c !== c).map((x) => x.c.nombre);
      if (!conflictivos.has(c.id)) conflictivos.set(c.id, []);
      conflictivos.get(c.id).push({ puerto: p.puerto, protocolo: k.split('/')[1], con: [...new Set(otros)] });
    }
  }
  return conflictivos;
}

// ---------------------------------------------------------------- el cruce de un servidor (puro)
/**
 * @param {Array} contenedores   salida de puroContenedores() (todos los entornos de ese servidor)
 * @param {Array} componentes    sub-aplicativos del servidor: {id, nombre, tipo, puerto, estado, criticidad, versionImagen, responsable, aplicaciones[]}
 */
function puroCruzarServidor(contenedores, componentes) {
  const emparejados = new Map(); // id de componente → [{ c, por }]
  const pareja = new Map();      // id de contenedor → { comp, por }
  const unir = (c, comp, por) => {
    pareja.set(c.id, { comp, por });
    if (!emparejados.has(comp.id)) emparejados.set(comp.id, []);
    emparejados.get(comp.id).push({ c, por });
  };

  const porClave = new Map();
  for (const comp of componentes) {
    const k = clave(comp.nombre);
    if (!k) continue;
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push(comp);
  }
  const elegir = (candidatos, c) => {
    if (!candidatos || !candidatos.length) return null;
    const puertos = puertosDe(c);
    return candidatos.find((x) => puertos.includes(Number(x.puerto)))
      || candidatos.find((x) => !emparejados.has(x.id))
      || candidatos[0];
  };

  // 1) por nombre del contenedor  2) por nombre de la imagen
  for (const c of contenedores) {
    const comp = elegir(porClave.get(c.clave), c);
    if (comp) unir(c, comp, 'nombre');
  }
  for (const c of contenedores) {
    if (pareja.has(c.id) || !c.claveImagen) continue;
    const comp = elegir(porClave.get(c.claveImagen), c);
    if (comp) unir(c, comp, 'imagen');
  }
  // 3) por puerto publicado, solo con sub-aplicativos que todavía no tienen contenedor
  for (const c of contenedores) {
    if (pareja.has(c.id)) continue;
    const puertos = puertosDe(c);
    const comp = componentes.find((x) => !emparejados.has(x.id) && Number(x.puerto) > 0 && puertos.includes(Number(x.puerto)));
    if (comp) unir(c, comp, 'puerto');
  }

  const conflictos = puroPuertosEnConflicto(contenedores);
  const puertoRepetidoEnInventario = new Set();
  const vistos = new Map();
  for (const comp of componentes) {
    const p = Number(comp.puerto);
    if (!(p > 0)) continue;
    if (vistos.has(p)) { puertoRepetidoEnInventario.add(p); } else vistos.set(p, comp);
  }

  const filas = [];
  const notas = (f, texto) => { f.notas.push(texto); };

  for (const c of contenedores) {
    const par = pareja.get(c.id) || null;
    const comp = par ? par.comp : null;
    const f = { contenedor: c, subaplicativo: comp, emparejadoPor: par ? par.por : null, hallazgos: [], notas: [] };
    const puertos = puertosDe(c);
    const corriendo = ESTADOS_CORRIENDO.has(c.estado);

    if (!comp) {
      f.hallazgos.push('sin_registrar');
      if (!corriendo) notas(f, `El contenedor no está en ejecución (${c.estado || 'detenido'}).`);
    } else {
      if (par.por !== 'nombre') {
        f.hallazgos.push('nombre_distinto');
        notas(f, par.por === 'imagen'
          ? `Se emparejó por la imagen (${c.imagen}); el nombre del contenedor «${c.nombre}» no coincide con «${comp.nombre}».`
          : `Se emparejó solo por el puerto ${comp.puerto}; el nombre del contenedor «${c.nombre}» no coincide con «${comp.nombre}».`);
      }
      const puertoInv = Number(comp.puerto) > 0 ? Number(comp.puerto) : null;
      if (puertoInv && !c.redHost && !puertos.includes(puertoInv)) {
        f.hallazgos.push('puerto_distinto');
        notas(f, puertos.length
          ? `El inventario dice ${puertoInv} y el contenedor publica ${puertos.join(', ')}.`
          : `El inventario dice ${puertoInv} y el contenedor no publica ningún puerto.`);
      } else if (!puertoInv && puertos.length) {
        f.hallazgos.push('sin_puerto_inventario');
        notas(f, `El contenedor publica ${puertos.join(', ')} y el inventario no tiene puerto registrado.`);
      }
      if (ESTADOS_ACTIVOS.has(comp.estado) && !corriendo && !['restarting', 'paused'].includes(c.estado)) {
        f.hallazgos.push('estado_distinto');
        notas(f, `El inventario lo marca «${comp.estado}» y el contenedor está ${c.estado || 'detenido'}.`);
      } else if (ESTADOS_DE_BAJA.has(comp.estado) && corriendo) {
        f.hallazgos.push('estado_distinto');
        notas(f, `El inventario lo marca «${comp.estado}» pero el contenedor está en ejecución.`);
      }
      const vInv = normVersion(comp.versionImagen);
      const vRun = normVersion(c.tag);
      if (vInv && vRun && vRun !== 'latest' && vInv !== vRun && !vInv.includes(vRun) && !vRun.includes(vInv)) {
        f.hallazgos.push('version_distinta');
        notas(f, `El inventario registra la versión ${comp.versionImagen} y corre ${c.tag}.`);
      }
      if ((emparejados.get(comp.id) || []).length > 1) {
        f.hallazgos.push('varios_contenedores');
        notas(f, `Hay ${(emparejados.get(comp.id) || []).length} contenedores para este sub-aplicativo: ${(emparejados.get(comp.id) || []).map((x) => x.c.nombre).join(', ')}.`);
      }
      if (puertoInv && puertoRepetidoEnInventario.has(puertoInv)) {
        f.hallazgos.push('puerto_duplicado');
        notas(f, `El puerto ${puertoInv} está registrado en más de un sub-aplicativo de este servidor.`);
      }
    }
    if (['restarting', 'paused'].includes(c.estado) || /unhealthy/i.test(c.estadoTexto || '')) {
      f.hallazgos.push('con_problemas');
      notas(f, c.estado === 'restarting' ? 'El contenedor se está reiniciando.' : (c.estado === 'paused' ? 'El contenedor está en pausa.' : 'Docker lo marca «unhealthy».'));
    }
    const choques = conflictivos(conflictos, c);
    if (choques.length) {
      if (!f.hallazgos.includes('puerto_duplicado')) f.hallazgos.push('puerto_duplicado');
      for (const x of choques) notas(f, `El puerto ${x.puerto}/${x.protocolo} también lo usa o reserva: ${x.con.join(', ')}.`);
    }
    filas.push(f);
  }

  // Sub-aplicativos sin ningún contenedor
  for (const comp of componentes) {
    if (emparejados.has(comp.id)) continue;
    const esperado = probableDocker(comp.nombre);
    const f = { contenedor: null, subaplicativo: comp, emparejadoPor: null, hallazgos: [], notas: [] };
    if (esperado === false) {
      f.hallazgos.push('fuera_de_docker');
      notas(f, 'Por su nombre no es un contenedor (servicio o sitio del sistema operativo): Portainer no lo ve.');
    } else {
      f.hallazgos.push('sin_contenedor');
      if (ESTADOS_ACTIVOS.has(comp.estado)) notas(f, 'El inventario lo marca «Activo» pero no hay contenedor con ese nombre ni ese puerto.');
      if (esperado === null) notas(f, 'Puede ser un servicio fuera de Docker; confirma si debería tener contenedor.');
    }
    if (Number(comp.puerto) > 0 && puertoRepetidoEnInventario.has(Number(comp.puerto))) {
      f.hallazgos.push('puerto_duplicado');
      notas(f, `El puerto ${comp.puerto} está registrado en más de un sub-aplicativo de este servidor.`);
    }
    filas.push(f);
  }
  return filas;
}

function conflictivos(mapa, c) { return mapa.get(c.id) || []; }

const PRIORIDAD = ['sin_registrar', 'puerto_distinto', 'estado_distinto', 'con_problemas', 'sin_contenedor', 'puerto_duplicado', 'varios_contenedores', 'version_distinta', 'nombre_distinto', 'sin_puerto_inventario', 'sin_servidor', 'fuera_de_docker'];
const GRAVES = new Set(['sin_registrar', 'puerto_distinto', 'estado_distinto', 'con_problemas', 'sin_contenedor', 'puerto_duplicado', 'varios_contenedores', 'sin_servidor']);

function resumirFila(f) {
  const principal = PRIORIDAD.find((h) => f.hallazgos.includes(h)) || 'ok';
  return { ...f, estado: principal, grave: f.hallazgos.some((h) => GRAVES.has(h)) };
}

// ---------------------------------------------------------------- todo el parque (puro)
/**
 * @param {Array} entornos       entornos de Portainer con `todos` (ver consultarEntorno)
 * @param {Array} servidores     [{id, hostname, ip, ambiente}] del inventario
 * @param {Array} componentes    [{id, servidorId, nombre, tipo, puerto, estado, criticidad, versionImagen, responsable, aplicaciones[]}]
 */
function puroCruzar({ entornos, servidores, componentes }) {
  const pares = puroEmparejar(entornos, servidores);
  const compPorServidor = new Map();
  for (const c of componentes) {
    if (!compPorServidor.has(c.servidorId)) compPorServidor.set(c.servidorId, []);
    compPorServidor.get(c.servidorId).push(c);
  }

  // Varios entornos de Portainer pueden apuntar al mismo servidor del inventario: se juntan.
  const grupos = new Map();
  for (const { entorno, servidor } of pares) {
    const k = servidor ? `s${servidor.id}` : `e${entorno.id}`;
    if (!grupos.has(k)) grupos.set(k, { servidor, entornos: [] });
    grupos.get(k).entornos.push(entorno);
  }

  const secciones = [];
  const serviciosConPortainer = new Set();
  for (const { servidor, entornos: lista } of grupos.values()) {
    const ok = lista.filter((e) => e.ok);
    const base = {
      entornoIds: lista.map((e) => e.id), entorno: lista.map((e) => e.nombre).join(' + '),
      servidorId: servidor ? servidor.id : null, hostname: servidor ? servidor.hostname : null,
      ip: servidor ? servidor.ip : (lista[0].ip || null), ambiente: servidor ? (String(servidor.ambiente || '').trim() || null) : null,
      servidorInventariado: !!servidor,
    };
    if (servidor) serviciosConPortainer.add(servidor.id);
    if (!ok.length) {
      secciones.push({ ...base, ok: false, error: lista.map((e) => e.error).filter(Boolean)[0] || 'No se pudo leer este servidor en Portainer.', filas: [], contenedores: 0, subaplicativos: servidor ? (compPorServidor.get(servidor.id) || []).length : 0 });
      continue;
    }
    const contenedores = ok.flatMap(puroContenedores);
    const comps = servidor ? (compPorServidor.get(servidor.id) || []) : [];
    let filas;
    if (!servidor) {
      filas = contenedores.map((c) => ({ contenedor: c, subaplicativo: null, emparejadoPor: null, hallazgos: ['sin_servidor'], notas: ['El servidor de Portainer no está en el inventario de servidores: registra el servidor y sus sub-aplicativos.'] }));
    } else {
      filas = puroCruzarServidor(contenedores, comps);
    }
    filas = filas.map(resumirFila).sort((a, b) => Number(b.grave) - Number(a.grave)
      || PRIORIDAD.indexOf(a.estado) - PRIORIDAD.indexOf(b.estado)
      || String((a.contenedor && a.contenedor.nombre) || (a.subaplicativo && a.subaplicativo.nombre) || '').localeCompare(String((b.contenedor && b.contenedor.nombre) || (b.subaplicativo && b.subaplicativo.nombre) || '')));
    secciones.push({
      ...base, ok: true, error: null, filas,
      contenedores: contenedores.length, subaplicativos: comps.length,
      sinLeer: ok.reduce((s, e) => s + (e.reservasSinLeer || 0), 0),
      redHost: ok.flatMap((e) => e.redHost || []).length,
    });
  }
  secciones.sort((a, b) => Number(b.ok) - Number(a.ok)
    || (b.filas || []).filter((f) => f.grave).length - (a.filas || []).filter((f) => f.grave).length
    || String(a.hostname || a.entorno).localeCompare(String(b.hostname || b.entorno)));

  const servidoresSinPortainer = servidores
    .filter((s) => !serviciosConPortainer.has(s.id) && (compPorServidor.get(s.id) || []).length)
    .map((s) => ({ id: s.id, hostname: s.hostname, ip: s.ip, ambiente: String(s.ambiente || '').trim() || null, subaplicativos: compPorServidor.get(s.id).length }))
    .sort((a, b) => b.subaplicativos - a.subaplicativos || String(a.hostname).localeCompare(String(b.hostname)));

  const todasFilas = secciones.flatMap((s) => s.filas);
  const cuenta = (h) => todasFilas.filter((f) => f.hallazgos.includes(h)).length;
  const resumen = {
    servidoresConPortainer: secciones.length,
    servidoresSinLeer: secciones.filter((s) => !s.ok).length,
    servidoresSinInventario: secciones.filter((s) => !s.servidorInventariado).length,
    servidoresSinPortainer: servidoresSinPortainer.length,
    contenedores: todasFilas.filter((f) => f.contenedor).length,
    subaplicativos: componentes.length,
    subaplicativosEnPortainer: new Set(todasFilas.filter((f) => f.contenedor && f.subaplicativo).map((f) => f.subaplicativo.id)).size,
    ok: todasFilas.filter((f) => f.estado === 'ok').length,
    conHallazgos: todasFilas.filter((f) => f.estado !== 'ok').length,
    graves: todasFilas.filter((f) => f.grave).length,
    porHallazgo: Object.fromEntries(PRIORIDAD.map((h) => [h, cuenta(h)])),
  };
  return { secciones, servidoresSinPortainer, resumen };
}

// ---------------------------------------------------------------- con base de datos
async function leerInventario(pool) {
  const [servidores] = await pool.query('SELECT Id AS id, Hostname AS hostname, IP AS ip, Ambiente AS ambiente FROM Servidores');
  const [filas] = await pool.query(`
    SELECT sc.Id AS id, sc.ServidorId AS servidorId, sc.Rol AS nombre, sc.Tipo AS tipo, sc.Puerto AS puerto,
           ia.estado AS estado, ia.criticidad AS criticidad, ia.version_imagen AS versionImagen, ia.dev_responsable AS responsable
      FROM Servidor_Componentes sc
      LEFT JOIN inv_aplicativos ia ON ia.componente_id = sc.Id`);
  const aplicaciones = new Map();
  if (filas.length) {
    const [links] = await pool.query(`
      SELECT ac.ComponenteId AS componenteId, a.Nombre AS nombre
        FROM Aplicacion_Componente ac JOIN Aplicaciones a ON a.Id = ac.AplicacionId ORDER BY a.Nombre`);
    for (const l of links) {
      if (!aplicaciones.has(l.componenteId)) aplicaciones.set(l.componenteId, []);
      aplicaciones.get(l.componenteId).push(l.nombre);
    }
  }
  const componentes = filas.map((f) => ({ ...f, aplicaciones: aplicaciones.get(f.id) || [] }));
  return { servidores, componentes };
}

async function cruzarPortainerConInventario(pool, { forzar = false } = {}) {
  const base = await consultarEntornos({ forzar });
  if (!base.configurado) return { configurado: false, consultadoEn: null, secciones: [], servidoresSinPortainer: [], resumen: null };
  const { servidores, componentes } = await leerInventario(pool);
  const r = puroCruzar({ entornos: base.entornos, servidores, componentes });
  return { configurado: true, consultadoEn: base.consultadoEn, ...r };
}

module.exports = {
  cruzarPortainerConInventario, leerInventario,
  _prueba: { clave, partesImagen, probableDocker, puroCruzar, puroCruzarServidor, puroPuertosEnConflicto, puroContenedores },
};
