// "Último tráfico" por nodo (miembro de pool) del balanceador F5.
//
// El F5 solo entrega contadores ACUMULADOS (conexiones totales, bits de
// entrada/salida) y conexiones abiertas; no guarda CUÁNDO fue la última vez
// que un nodo atendió tráfico. Para poder responder "¿hace cuánto este nodo
// no recibe tráfico?" se comparan lecturas sucesivas de esos contadores:
// si subieron (o hay conexiones abiertas) entre dos lecturas, el nodo tuvo
// tráfico en ese intervalo y se guarda la hora de la lectura.
//
// Las lecturas vienen de dos fuentes que comparten el mismo estado:
//   - la vista en vivo (GET /api/f5/:id/pool/miembros), cada pocos segundos
//     mientras alguien tiene abierto el detalle de un Virtual Server;
//   - un job en segundo plano (muestrearActividadNodos, cada
//     F5_ACTIVIDAD_INTERVALO_MS, 5 min por defecto) que recorre todos los
//     pools, para que el dato siga corriendo aunque nadie esté mirando.
//
// Persistencia: tabla f5_nodo_actividad. El usuario de BD de producción no
// tiene DDL, así que la tabla se crea con el script
// "Claude outputs/crear_tabla_f5_nodo_actividad.sql" (el backend también
// intenta crearla, pero si no puede NO falla): sin la tabla el dato vive solo
// en memoria y se pierde al reiniciar el backend.
//
// Precisión: la hora es la de la lectura en la que se VIO el cambio de los
// contadores, así que puede ir atrasada hasta un intervalo del job (5 min).
// Si el backend estuvo apagado entre dos lecturas, lo ocurrido en ese hueco
// se atribuye a la primera lectura tras el reinicio.

const {
  cargarDispositivosF5,
  peticionF5,
  aRutaF5,
  obtenerMiembrosDePool,
  extraerContadores,
  indexarStatsMiembros,
  buscarStatsMiembro,
  conLimiteDeConcurrencia,
  F5_DISPOSITIVOS_CONFIGURADOS,
} = require('./f5Cliente');
const { getPool } = require('../db');
const { registrarHistorial, guardarHistorial } = require('./f5HistorialNodos');

const INTERVALO_MS = Math.max(60 * 1000, Number(process.env.F5_ACTIVIDAD_INTERVALO_MS) || 5 * 60 * 1000);
const LATIDO_PERSISTENCIA_MS = 30 * 60 * 1000; // aunque no cambie nada, se refresca la fila cada 30 min
const DEMORA_GUARDADO_MS = 5000;
const REINTENTO_BD_MS = 30 * 60 * 1000;

const estado = new Map(); // clave -> { primera, ultimaMuestra, ultimoTrafico, c, persistidoEn, sucio }

const claveDe = (dispositivoId, poolPath, miembro) => `${dispositivoId}|${poolPath}|${miembro}`;

// ---------- Base de datos ----------
const esErrorDePermisos = (err) => err && [1142, 1143, 1044, 1227, 1045].includes(err.errno);

let bd = { lista: false, disponible: false, proximoIntento: 0, cargada: false };
let avisoSinTabla = false;

async function prepararBD() {
  const ahora = Date.now();
  if (bd.disponible) return true;
  if (ahora < bd.proximoIntento) return false;

  try {
    const pool = await getPool();
    const [existe] = await pool.query(
      "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'f5_nodo_actividad' LIMIT 1"
    );
    if (!existe.length) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS f5_nodo_actividad (
          dispositivo_id VARCHAR(64) NOT NULL,
          pool_path VARCHAR(255) NOT NULL,
          miembro VARCHAR(120) NOT NULL,
          primera_muestra DATETIME NOT NULL,
          ultima_muestra DATETIME NOT NULL,
          ultimo_trafico DATETIME NULL,
          tot_conns DOUBLE NULL,
          bits_in DOUBLE NULL,
          bits_out DOUBLE NULL,
          PRIMARY KEY (dispositivo_id, pool_path, miembro)
        )
      `);
    }
    bd.disponible = true;
  } catch (err) {
    bd.proximoIntento = ahora + REINTENTO_BD_MS;
    if (!avisoSinTabla) {
      avisoSinTabla = true;
      console.warn(
        'F5: no hay tabla f5_nodo_actividad y no se pudo crear' +
        (esErrorDePermisos(err) ? ' (el usuario de BD no tiene permiso CREATE)' : ` (${err.message})`) +
        '. El "último tráfico" de los nodos se guardará solo en memoria; ejecuta ' +
        'crear_tabla_f5_nodo_actividad.sql para que sobreviva a los reinicios.'
      );
    }
    return false;
  }

  if (!bd.cargada) {
    try {
      const pool = await getPool();
      const [filas] = await pool.query(
        'SELECT dispositivo_id, pool_path, miembro, primera_muestra, ultima_muestra, ultimo_trafico, tot_conns, bits_in, bits_out FROM f5_nodo_actividad'
      );
      for (const f of filas) {
        const k = claveDe(f.dispositivo_id, f.pool_path, f.miembro);
        // Lo ya medido en memoria desde el arranque manda sobre lo guardado.
        if (estado.has(k)) continue;
        estado.set(k, {
          primera: new Date(f.primera_muestra).getTime(),
          ultimaMuestra: new Date(f.ultima_muestra).getTime(),
          ultimoTrafico: f.ultimo_trafico ? new Date(f.ultimo_trafico).getTime() : null,
          c: {
            totConns: f.tot_conns === null ? null : Number(f.tot_conns),
            bitsIn: f.bits_in === null ? null : Number(f.bits_in),
            bitsOut: f.bits_out === null ? null : Number(f.bits_out),
            bits: f.bits_in === null && f.bits_out === null ? null : Number(f.bits_in || 0) + Number(f.bits_out || 0),
          },
          persistidoEn: Date.now(),
          sucio: false,
        });
      }
      bd.cargada = true;
    } catch (err) {
      console.warn(`F5: no se pudo cargar el último tráfico guardado de los nodos: ${err.message}`);
    }
  }
  return true;
}

let guardadoProgramado = null;
function programarGuardado() {
  if (guardadoProgramado) return;
  guardadoProgramado = setTimeout(async () => {
    guardadoProgramado = null;
    try { await guardarPendientes(); } catch (e) { console.warn(`F5: no se pudo guardar el último tráfico de los nodos: ${e.message}`); }
  }, DEMORA_GUARDADO_MS);
  if (guardadoProgramado.unref) guardadoProgramado.unref();
}

async function guardarPendientes() {
  if (!(await prepararBD())) return;
  const filas = [];
  const claves = [];
  for (const [k, s] of estado) {
    if (!s.sucio) continue;
    const [dispositivoId, poolPath, ...resto] = k.split('|');
    filas.push([
      dispositivoId, poolPath, resto.join('|'),
      new Date(s.primera), new Date(s.ultimaMuestra),
      s.ultimoTrafico ? new Date(s.ultimoTrafico) : null,
      s.c.totConns, s.c.bitsIn ?? null, s.c.bitsOut ?? null,
    ]);
    claves.push(k);
  }
  if (!filas.length) return;

  const pool = await getPool();
  await pool.query(
    `INSERT INTO f5_nodo_actividad
       (dispositivo_id, pool_path, miembro, primera_muestra, ultima_muestra, ultimo_trafico, tot_conns, bits_in, bits_out)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       ultima_muestra = VALUES(ultima_muestra),
       ultimo_trafico = VALUES(ultimo_trafico),
       tot_conns = VALUES(tot_conns),
       bits_in = VALUES(bits_in),
       bits_out = VALUES(bits_out)`,
    [filas]
  );
  const ahora = Date.now();
  for (const k of claves) {
    const s = estado.get(k);
    if (s) { s.sucio = false; s.persistidoEn = ahora; }
  }
}

// ---------- Registro de lecturas ----------
function descripcion(s) {
  return {
    ultimoTraficoEn: s.ultimoTrafico ? new Date(s.ultimoTrafico).toISOString() : null,
    monitoreandoDesde: new Date(s.primera).toISOString(),
    ultimaLecturaEn: new Date(s.ultimaMuestra).toISOString(),
  };
}

// `contadores` viene de extraerContadores(campos, 'serverside'). Devuelve
// { ultimoTraficoEn, monitoreandoDesde, ultimaLecturaEn } (ISO o null).
function registrarMuestra(dispositivoId, poolPath, miembro, contadores, ahora = Date.now()) {
  const k = claveDe(dispositivoId, poolPath, miembro);
  const bitsIn = contadores.bitsIn;
  const bitsOut = contadores.bitsOut;
  const actual = {
    totConns: contadores.totConns,
    bitsIn, bitsOut,
    bits: bitsIn === null && bitsOut === null ? null : (bitsIn || 0) + (bitsOut || 0),
  };
  const conConexionesAbiertas = (contadores.curConns || 0) > 0;

  let s = estado.get(k);
  let cambio = false;

  if (!s) {
    s = { primera: ahora, ultimaMuestra: ahora, ultimoTrafico: null, c: actual, persistidoEn: 0, sucio: true };
    if (conConexionesAbiertas) s.ultimoTrafico = ahora;
    estado.set(k, s);
    cambio = true;
  } else {
    const previo = s.c;
    // Si un contador BAJA, el F5 se reinició o reseteó sus estadísticas: no se
    // puede comparar con la lectura anterior, solo se toma la nueva como base.
    const bajo = (a, b) => a !== null && b !== null && a < b;
    const reinicio = bajo(actual.totConns, previo.totConns) || bajo(actual.bits, previo.bits);
    const subio = (a, b) => a !== null && b !== null && a > b;
    const huboTrafico = !reinicio && (subio(actual.totConns, previo.totConns) || subio(actual.bits, previo.bits));

    if ((huboTrafico || conConexionesAbiertas) && s.ultimoTrafico !== ahora) {
      s.ultimoTrafico = ahora;
      cambio = true;
    }
    s.ultimaMuestra = ahora;
    s.c = {
      // Un contador sin dato no borra la última base conocida.
      totConns: actual.totConns ?? previo.totConns ?? null,
      bitsIn: actual.bitsIn ?? previo.bitsIn ?? null,
      bitsOut: actual.bitsOut ?? previo.bitsOut ?? null,
      bits: actual.bits ?? previo.bits ?? null,
    };
    if (cambio || ahora - s.persistidoEn > LATIDO_PERSISTENCIA_MS) s.sucio = true;
  }

  if (s.sucio) programarGuardado();
  return descripcion(s);
}

// Lo ya registrado de un nodo, sin tomar una lectura nueva (null si no hay).
function consultarActividad(dispositivoId, poolPath, miembro) {
  const s = estado.get(claveDe(dispositivoId, poolPath, miembro));
  return s ? descripcion(s) : null;
}

// ---------- Job en segundo plano ----------
let muestreando = false;

// Lee los contadores de todos los nodos de un pool y alimenta tanto el
// "último tráfico" como el histórico de tráfico por nodo (f5HistorialNodos).
// Solo la usan el muestreo en segundo plano y la consulta del histórico
// (cuando la última lectura es vieja): la vista en vivo NO alimenta el histórico.
async function muestrearPool(dispositivo, poolPath, ahora = Date.now()) {
  const rutaF5 = aRutaF5(poolPath);
  const [miembros, stats] = await Promise.all([
    obtenerMiembrosDePool(dispositivo, poolPath),
    peticionF5(dispositivo, `/mgmt/tm/ltm/pool/${rutaF5}/members/stats`),
  ]);
  const indice = indexarStatsMiembros(stats);
  for (const m of miembros) {
    const campos = buscarStatsMiembro(indice, m);
    if (!campos) continue;
    const contadores = extraerContadores(campos, 'serverside');
    registrarMuestra(dispositivo.id, poolPath, m.nombre, contadores, ahora);
    registrarHistorial(dispositivo.id, poolPath, m.nombre, contadores, ahora, INTERVALO_MS);
  }
  return miembros;
}

async function muestrearActividadNodos() {
  if (!F5_DISPOSITIVOS_CONFIGURADOS || muestreando) return;
  muestreando = true;
  try {
    await prepararBD();
    for (const dispositivo of cargarDispositivosF5()) {
      try {
        const virtuales = await peticionF5(dispositivo, '/mgmt/tm/ltm/virtual');
        const pools = [...new Set((virtuales.items || []).map((v) => v.pool).filter(Boolean))];

        // Concurrencia baja (2): mismo motivo que obtenerConteoNodosPorPool.
        await conLimiteDeConcurrencia(pools, 2, async (poolPath) => {
          try {
            await muestrearPool(dispositivo, poolPath);
          } catch (err) {
            console.warn(`F5: no se pudo leer el tráfico del pool ${poolPath} para el último tráfico de los nodos: ${err.message}`);
          }
        });
      } catch (err) {
        console.warn(`F5: no se pudo muestrear la actividad de nodos de "${dispositivo.id}": ${err.message}`);
      }
    }
    await guardarPendientes();
    await guardarHistorial();
  } catch (err) {
    console.warn(`F5: falló el muestreo de actividad de nodos: ${err.message}`);
  } finally {
    muestreando = false;
  }
}

function iniciarMuestreoActividad() {
  if (!F5_DISPOSITIVOS_CONFIGURADOS) return;
  // Primera lectura a los 60 s de arrancar (decalada de Portainer a 30 s y del
  // snapshot histórico de F5 a 45 s), luego cada INTERVALO_MS.
  const t = setTimeout(muestrearActividadNodos, 60000);
  const i = setInterval(muestrearActividadNodos, INTERVALO_MS);
  if (t.unref) t.unref();
  if (i.unref) i.unref();
}

module.exports = {
  INTERVALO_MS,
  muestrearPool,
  registrarMuestra,
  consultarActividad,
  muestrearActividadNodos,
  iniciarMuestreoActividad,
  guardarPendientes,
};
