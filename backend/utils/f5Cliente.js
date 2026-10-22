// Cliente compartido hacia los balanceadores F5 (iControl REST) + tabla de
// histórico (Fase 2 del informe general).
//
// Extraído de routes/f5Monitoreo.js para que TANTO la vista en vivo (esa
// misma ruta) COMO el job de captura histórica y el informe de Fase 2
// (utils/informeF5.js) usen exactamente la misma lógica de conexión/estado
// hacia el F5, sin duplicar el cliente HTTP. A diferencia de Servidores/
// Apuntamientos (donde SÍ se duplicó `calcularRangoPeriodo`/`garantizarTabla*`
// a propósito para evitar una dependencia routes→utils→routes), aquí no hay
// ese riesgo: este archivo es un utils puro que no depende de ningún route,
// así que routes/f5Monitoreo.js y utils/informeF5.js pueden requerirlo los
// dos sin ciclo.
const https = require('https');
const { URL } = require('url');

// --- Configuración de dispositivos F5 (variables de entorno) ---
// Ver el comentario original en routes/f5Monitoreo.js para el formato de
// las variables F5_DEVICE_<n>_*.
function cargarDispositivosF5() {
  const dispositivos = [];
  for (let i = 1; ; i++) {
    const host = process.env[`F5_DEVICE_${i}_HOST`];
    if (!host) break;
    dispositivos.push({
      id: process.env[`F5_DEVICE_${i}_ID`] || `f5-${i}`,
      nombre: process.env[`F5_DEVICE_${i}_NOMBRE`] || host,
      host,
      usuario: process.env[`F5_DEVICE_${i}_USER`],
      password: process.env[`F5_DEVICE_${i}_PASS`],
      validarTLS: process.env[`F5_DEVICE_${i}_TLS_INSECURE`] !== 'true',
    });
  }
  return dispositivos;
}

function buscarDispositivo(id) {
  return cargarDispositivosF5().find((d) => d.id === id);
}

// --- Cliente HTTPS mínimo hacia el F5 (Basic Auth, iControl REST) ---
function peticionF5(dispositivo, path) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(path, dispositivo.host);
    } catch (e) {
      return reject(new Error(`Host de F5 mal configurado: ${dispositivo.host}`));
    }

    const auth = Buffer.from(`${dispositivo.usuario}:${dispositivo.password}`).toString('base64');

    const opciones = {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
      rejectUnauthorized: dispositivo.validarTLS,
      timeout: 8000,
    };

    const req = https.request(url, opciones, (res) => {
      let datos = '';
      res.on('data', (chunk) => { datos += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`El F5 respondió ${res.statusCode}. ${datos}`.slice(0, 400));
          err.status = res.statusCode;
          return reject(err);
        }
        try {
          resolve(datos ? JSON.parse(datos) : {});
        } catch (e) {
          reject(new Error('La respuesta del F5 no es JSON válido.'));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado contactando al F5.')));
    req.on('error', (e) => reject(e));
    req.end();
  });
}

function aRutaF5(fullPath) {
  const partes = (fullPath || '').split('/').filter(Boolean);
  return '~' + partes.join('~');
}

function ultimoSegmento(path) {
  const partes = (path || '').split('/').filter(Boolean);
  return partes[partes.length - 1] || '';
}

function leer(campo) {
  if (campo === undefined || campo === null) return null;
  if (typeof campo.value !== 'undefined') return campo.value;
  if (typeof campo.description !== 'undefined') return campo.description;
  return null;
}

function describirErrorF5(e) {
  if (e.status === 401 || e.status === 403) return 'El F5 rechazó las credenciales para este pool';
  if (typeof e.status === 'number') return `El F5 respondió ${e.status}`;
  if (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH') return 'Host inaccesible';
  if (e.code === 'ETIMEDOUT' || e.message?.includes('Tiempo de espera')) return 'Tiempo de espera agotado';
  return (e.message || 'Error desconocido').slice(0, 150);
}

function estadoDesdeSesion(session) {
  const s = (session || '').toLowerCase();
  return s.includes('disabled') ? 'offline' : 'available';
}

function formatearBitsPorSegundo(valor) {
  if (valor === null || valor === undefined) return null;
  const unidades = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let n = Number(valor);
  let i = 0;
  while (n >= 1000 && i < unidades.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(1)} ${unidades[i]}`;
}

async function conLimiteDeConcurrencia(items, limite, fn) {
  const resultados = new Array(items.length);
  let siguiente = 0;

  async function trabajador() {
    while (siguiente < items.length) {
      const indice = siguiente++;
      resultados[indice] = await fn(items[indice], indice);
    }
  }

  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, () => trabajador());
  await Promise.all(trabajadores);
  return resultados;
}

// ---------- Tráfico (velocidad) por Virtual Server / nodo ----------
// El F5 solo entrega contadores ACUMULADOS (bits, paquetes y conexiones desde
// que se encendió o se reseteó el equipo), no una velocidad. Para mostrar
// "cuánto tráfico lleva ahora" se guarda la última muestra de cada elemento
// y la velocidad sale de la diferencia entre dos muestras / segundos.
function formatearBytes(bytes) {
  if (bytes === null || bytes === undefined || isNaN(bytes)) return null;
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes);
  let i = 0;
  while (n >= 1024 && i < unidades.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${unidades[i]}`;
}

function numero(campo) {
  const v = leer(campo);
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Contadores de un elemento a partir de sus "nestedStats.entries".
// lado = 'serverside' (miembros de pool) o 'clientside' (virtual server).
function extraerContadores(campos, lado) {
  return {
    bitsIn: numero(campos[`${lado}.bitsIn`]),
    bitsOut: numero(campos[`${lado}.bitsOut`]),
    pktsIn: numero(campos[`${lado}.pktsIn`]),
    pktsOut: numero(campos[`${lado}.pktsOut`]),
    curConns: numero(campos[`${lado}.curConns`]),
    totConns: numero(campos[`${lado}.totConns`]),
    maxConns: numero(campos[`${lado}.maxConns`]),
    totRequests: numero(campos.totRequests),
    curSessions: numero(campos.curSessions),
  };
}

// Estado que reporta el F5 de un miembro / virtual (texto tal cual, para mostrarlo).
function extraerEstado(campos) {
  return {
    disponibilidad: leer(campos['status.availabilityState']),
    habilitado: leer(campos['status.enabledState']),
    razon: leer(campos['status.statusReason']),
    monitor: leer(campos.monitorStatus),
    sesion: leer(campos.sessionStatus),
  };
}

// Las estadísticas de los miembros de un pool NO siempre traen "tmName":
// traen addr / port / nodeName y la ruta del miembro en la llave de cada
// entrada. Se indexa por todas las formas posibles para poder cruzarlas con
// la configuración del miembro ("10.0.0.1:443").
function indexarStatsMiembros(statsData) {
  const mapa = new Map();
  const guardar = (clave, campos) => { if (clave && !mapa.has(clave)) mapa.set(clave, campos); };
  const limpiar = (t) => String(t || '').split('/').filter(Boolean).pop() || '';
  for (const [llave, entrada] of Object.entries(statsData.entries || {})) {
    const campos = entrada.nestedStats?.entries || {};
    const tm = leer(campos.tmName);
    if (tm) guardar(ultimoSegmento(tm), campos);
    // .../members/~Common~10.0.0.1:443/~Common~10.0.0.1:443/stats
    const partes = String(llave).replace(/\/stats$/, '').split('/');
    const deLlave = decodeURIComponent(partes[partes.length - 1] || '').split('~').pop();
    guardar(deLlave, campos);
    const addr = leer(campos.addr);
    const puerto = leer(campos.port);
    if (addr && puerto !== null) guardar(`${addr}:${puerto}`, campos);
    const nodo = limpiar(leer(campos.nodeName));
    if (nodo && puerto !== null) guardar(`${nodo}:${puerto}`, campos);
  }
  return mapa;
}

function buscarStatsMiembro(mapa, miembro) {
  const candidatos = [
    ultimoSegmento(miembro.nombre),
    miembro.nombre,
    miembro.direccion && miembro.puerto !== null && miembro.puerto !== undefined ? `${miembro.direccion}:${miembro.puerto}` : null,
  ];
  for (const c of candidatos) if (c && mapa.has(c)) return mapa.get(c);
  return null;
}

const muestrasTrafico = new Map(); // clave -> { t, c, tasa }
const VIGENCIA_MUESTRA_MS = 60 * 1000;   // pasado este tiempo la muestra anterior ya no sirve
const SEPARACION_MINIMA_MS = 800;        // consultas más seguidas reusan la última velocidad calculada

function hayMuestraReciente(clave, ahora = Date.now()) {
  const m = muestrasTrafico.get(clave);
  return !!m && ahora - m.t <= VIGENCIA_MUESTRA_MS;
}

function limpiarMuestrasViejas(ahora) {
  if (muestrasTrafico.size < 500) return;
  for (const [k, m] of muestrasTrafico) if (ahora - m.t > 10 * 60 * 1000) muestrasTrafico.delete(k);
}

// Devuelve el tráfico del elemento: acumulados + velocidad (null si todavía
// no hay dos muestras). `contadores` viene de extraerContadores().
function calcularTrafico(clave, contadores, ahora = Date.now()) {
  const previa = muestrasTrafico.get(clave);
  let tasa = null;

  if (previa && ahora - previa.t <= VIGENCIA_MUESTRA_MS) {
    const dt = (ahora - previa.t) / 1000;
    if (ahora - previa.t < SEPARACION_MINIMA_MS) {
      tasa = previa.tasa; // consulta demasiado seguida: se reutiliza lo ya calculado
    } else {
      const delta = (a, b) => (a === null || b === null || a < b ? null : (a - b) / dt);
      const c = contadores;
      const p = previa.c;
      const entrada = delta(c.bitsIn, p.bitsIn);
      const salida = delta(c.bitsOut, p.bitsOut);
      tasa = entrada === null && salida === null ? null : {
        entradaBps: entrada,
        salidaBps: salida,
        paquetesPorSeg: delta(c.pktsIn, p.pktsIn) !== null && delta(c.pktsOut, p.pktsOut) !== null
          ? delta(c.pktsIn, p.pktsIn) + delta(c.pktsOut, p.pktsOut) : null,
        conexionesNuevasPorSeg: delta(c.totConns, p.totConns),
        peticionesPorSeg: delta(c.totRequests, p.totRequests),
      };
      muestrasTrafico.set(clave, { t: ahora, c: contadores, tasa });
    }
  } else {
    muestrasTrafico.set(clave, { t: ahora, c: contadores, tasa: null });
  }
  limpiarMuestrasViejas(ahora);

  return {
    conexionesActuales: contadores.curConns,
    conexionesTotales: contadores.totConns,
    datosEntrada: formatearBytes(contadores.bitsIn === null ? null : contadores.bitsIn / 8),
    datosSalida: formatearBytes(contadores.bitsOut === null ? null : contadores.bitsOut / 8),
    entradaBps: tasa ? tasa.entradaBps : null,
    salidaBps: tasa ? tasa.salidaBps : null,
    entradaTexto: tasa && tasa.entradaBps !== null ? formatearBitsPorSegundo(tasa.entradaBps) : null,
    salidaTexto: tasa && tasa.salidaBps !== null ? formatearBitsPorSegundo(tasa.salidaBps) : null,
    paquetesPorSeg: tasa ? tasa.paquetesPorSeg : null,
    conexionesNuevasPorSeg: tasa ? tasa.conexionesNuevasPorSeg : null,
    conexionesMaximas: contadores.maxConns,
    peticionesTotales: contadores.totRequests,
    peticionesPorSeg: tasa ? tasa.peticionesPorSeg : null,
    sesiones: contadores.curSessions,
  };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// "10.254.55.106:333" -> 333 ; "[fe80::1]:80" -> 80 ; sin puerto -> null.
function puertoDeMiembro(nombre) {
  const m = String(nombre || '').match(/:(\d{1,5})$/);
  return m ? Number(m[1]) : null;
}

async function obtenerMiembrosDePool(dispositivo, poolPath) {
  const rutaF5 = aRutaF5(poolPath);
  const configData = await peticionF5(dispositivo, `/mgmt/tm/ltm/pool/${rutaF5}/members`);
  const items = configData.items || [];
  return items.map((m) => ({
    nombre: m.name,
    direccion: m.address || m.name,
    puerto: puertoDeMiembro(m.name),
    sesion: m.session || null,
    proporcion: m.ratio ?? null,
    prioridad: m.priorityGroup ?? null,
    limiteConexiones: m.connectionLimit ?? null,
    monitor: m.monitor || null,
    estadoMonitor: m.state || null, // up / down / unchecked (resultado del monitor de salud)
    estado: estadoDesdeSesion(m.session),
    motivoEstado: m.session || null,
  }));
}

// Concurrencia baja (2) a propósito — ver comentario original en
// routes/f5Monitoreo.js sobre por qué el F5 puede rechazar en bloque muchas
// autenticaciones Basic Auth concurrentes del mismo usuario.
async function obtenerConteoNodosPorPool(dispositivo, poolPaths) {
  const unicos = [...new Set(poolPaths.filter(Boolean))];
  const mapa = new Map();

  await conLimiteDeConcurrencia(unicos, 2, async (poolPath) => {
    try {
      const miembros = await obtenerMiembrosDePool(dispositivo, poolPath);
      const total = miembros.length;
      const arriba = miembros.filter((m) => m.estado === 'available').length;
      mapa.set(poolPath, {
        arriba,
        total,
        miembros: miembros.map((m) => ({
          // Nombre tal como lo conoce el F5 ("host:puerto"): lo usan el histórico de
          // tráfico (f5_nodo_trafico.miembro) y el informe para cruzar datos.
          nombre: m.nombre,
          direccion: m.direccion,
          puerto: m.puerto,
          estado: m.estado,
          motivoEstado: m.motivoEstado,
          // Resultado del monitor de salud (up / down / unchecked): un nodo puede
          // estar habilitado y aun así caído; sin esto no se vería en la lista.
          estadoMonitor: m.estadoMonitor,
        })),
      });
    } catch (e) {
      const motivo = describirErrorF5(e);
      console.error(`No se pudo consultar el pool ${poolPath} para el conteo de nodos: ${e.message} (status=${e.status ?? 'n/a'}, code=${e.code ?? 'n/a'})`);
      mapa.set(poolPath, { error: motivo });
    }
  });

  return mapa;
}

// Virtual Servers de un dispositivo con su estado agregado (config + stats +
// conteo de nodos por pool), SIN alias/ocultos — eso es preferencia de UI y
// sigue viviendo solo en routes/f5Monitoreo.js (tablas f5_alias/f5_oculto),
// no hace falta para el snapshot histórico ni para el informe.
async function obtenerVirtualesConEstado(dispositivo) {
  const [configData, statsData] = await Promise.all([
    peticionF5(dispositivo, '/mgmt/tm/ltm/virtual'),
    peticionF5(dispositivo, '/mgmt/tm/ltm/virtual/stats'),
  ]);

  const statsPorPath = {};
  for (const entrada of Object.values(statsData.entries || {})) {
    const campos = entrada.nestedStats?.entries || {};
    const nombreCompleto = leer(campos.tmName) || null;
    if (nombreCompleto) statsPorPath[nombreCompleto] = campos;
  }

  const virtualesBase = (configData.items || []).map((v) => {
    const campos = statsPorPath[v.fullPath] || {};
    return {
      nombre: v.name,
      fullPath: v.fullPath,
      destino: v.destination || null,
      pool: v.pool || null,
      habilitado: v.enabled !== false,
      estado: leer(campos['status.availabilityState']) || 'unknown',
      motivoEstado: leer(campos['status.statusReason']) || null,
      conexionesActuales: leer(campos['clientside.curConns']),
      conexionesTotales: leer(campos['clientside.totConns']),
      entrada: formatearBitsPorSegundo(leer(campos['clientside.bitsIn'])),
      salida: formatearBitsPorSegundo(leer(campos['clientside.bitsOut'])),
    };
  });

  const nodosPorPool = await obtenerConteoNodosPorPool(dispositivo, virtualesBase.map((v) => v.pool));

  return virtualesBase.map((v) => {
    const conteoNodos = v.pool ? nodosPorPool.get(v.pool) : null;
    return {
      ...v,
      nodosArriba: conteoNodos?.arriba ?? null,
      nodosTotal: conteoNodos?.total ?? null,
      nodos: conteoNodos?.miembros || [],
      nodosError: conteoNodos?.error || null,
    };
  });
}

// ---------- Histórico (tabla compartida entre el job de captura y el informe) ----------
// errno 1142/1143 = el usuario de BD no tiene permiso CREATE/ALTER (mismo
// criterio que esErrorDePermisosDdl() en auditoriaGeneral.js/usuariosAuditoria.js).
// Si la tabla ya existe (creada antes con una cuenta con más privilegios),
// esto no es un error real — esta cuenta simplemente no puede verificarlo
// con DDL. Sin este manejo, el Informe de Balanceador F5 se caía entero con
// un 500 solo por intentar el CREATE TABLE IF NOT EXISTS, aunque
// f5_historico ya existiera.
function esErrorDePermisosDdl(err) {
  return err && (err.errno === 1142 || err.errno === 1143);
}

let tablaF5HistoricoLista = false;
async function garantizarTablaF5Historico(pool) {
  if (tablaF5HistoricoLista) return;
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS f5_historico (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      Fecha DATETIME NOT NULL,
      DispositivoId VARCHAR(64) NOT NULL,
      DispositivoNombre VARCHAR(255) NULL,
      VirtualesTotal INT NOT NULL DEFAULT 0,
      VirtualesArriba INT NOT NULL DEFAULT 0,
      NodosTotal INT NOT NULL DEFAULT 0,
      NodosArriba INT NOT NULL DEFAULT 0,
      INDEX idx_f5historico_fecha (Fecha),
      INDEX idx_f5historico_dispositivo (DispositivoId, Fecha)
    )
    `);
  } catch (err) {
    if (!esErrorDePermisosDdl(err)) throw err;
    console.warn('No se pudo verificar/crear la tabla f5_historico (el usuario de BD no tiene permiso CREATE); se asume que ya existe:', err.sqlMessage || err.message);
  }
  tablaF5HistoricoLista = true;
}

// Calculado UNA vez al cargar el módulo (igual que PORTAINER_CONFIGURADO):
// las variables F5_DEVICE_* no cambian mientras el backend está corriendo.
const F5_DISPOSITIVOS_CONFIGURADOS = cargarDispositivosF5().length > 0;

module.exports = {
  cargarDispositivosF5,
  buscarDispositivo,
  peticionF5,
  aRutaF5,
  ultimoSegmento,
  leer,
  describirErrorF5,
  estadoDesdeSesion,
  formatearBitsPorSegundo,
  conLimiteDeConcurrencia,
  obtenerMiembrosDePool,
  formatearBytes,
  extraerContadores,
  extraerEstado,
  indexarStatsMiembros,
  buscarStatsMiembro,
  puertoDeMiembro,
  hayMuestraReciente,
  calcularTrafico,
  esperar,
  obtenerConteoNodosPorPool,
  obtenerVirtualesConEstado,
  garantizarTablaF5Historico,
  F5_DISPOSITIVOS_CONFIGURADOS,
};
