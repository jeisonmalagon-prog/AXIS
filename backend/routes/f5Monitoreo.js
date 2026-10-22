const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const { getPool } = require('../db');
const {
  cargarDispositivosF5,
  buscarDispositivo,
  aRutaF5,
  ultimoSegmento,
  leer,
  describirErrorF5,
  obtenerMiembrosDePool,
  extraerContadores,
  extraerEstado,
  indexarStatsMiembros,
  buscarStatsMiembro,
  formatearBitsPorSegundo,
  hayMuestraReciente,
  calcularTrafico,
  esperar,
  obtenerVirtualesConEstado,
  peticionF5,
  garantizarTablaF5Historico,
  F5_DISPOSITIVOS_CONFIGURADOS,
} = require('../utils/f5Cliente');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const { registrarMuestra, iniciarMuestreoActividad, muestrearPool, INTERVALO_MS: INTERVALO_MUESTREO_MS } = require('../utils/f5ActividadNodos');
const { diagnosticoAvr, historialAvr } = require('../utils/f5Avr');
const { consultarHistorial, ultimaLecturaPool, guardarHistorial, MAX_HORAS } = require('../utils/f5HistorialNodos');

// Vista de solo lectura del/los balanceador(es) F5: solo exige sesión + el
// módulo BALANCEADOR_F5 habilitado. No hay ningún POST/PUT/DELETE hacia el
// F5 en todo este archivo — es un espejo, no un panel de administración.
//
// El cliente iControl REST (cargarDispositivosF5/peticionF5/etc.) vive en
// utils/f5Cliente.js — lo comparten esta vista en vivo, el job de captura
// histórica de más abajo y el informe de Fase 2 (utils/informeF5.js).
router.use(verifyToken, requireModule('BALANCEADOR_F5'));

// --- Alias propios (guardados en NUESTRA base de datos, nunca en el F5) ---
// Permite ponerle a cada Virtual Server un nombre para identificarlo más
// fácil que su nombre técnico (ej. "VS_API_APP_SSLTCP" -> "App móvil - pagos").
// La tabla se crea sola la primera vez que se usa, así no depende de que se
// corra a mano la migración SQL.
// errno 1142/1143 = el usuario de BD no tiene permiso CREATE/ALTER (mismo
// criterio que esErrorDePermisosDdl() en auditoriaGeneral.js/usuariosAuditoria.js).
// Si la tabla ya existe (creada antes con una cuenta con más privilegios),
// esto no es un error real — esta cuenta simplemente no puede verificarlo
// con DDL. Sin este manejo, la vista de F5 se caía entera con un 500 solo
// por intentar el CREATE TABLE IF NOT EXISTS, aunque la tabla ya existiera.
function esErrorDePermisosDdl(err) {
  return err && (err.errno === 1142 || err.errno === 1143);
}

let tablaAliasLista = false;
async function garantizarTablaAlias(pool) {
  if (tablaAliasLista) return;
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS f5_alias (
      dispositivo_id VARCHAR(64) NOT NULL,
      virtual_full_path VARCHAR(255) NOT NULL,
      alias VARCHAR(120) NOT NULL,
      actualizado_por VARCHAR(100) NULL,
      actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (dispositivo_id, virtual_full_path)
    )
    `);
  } catch (err) {
    if (!esErrorDePermisosDdl(err)) throw err;
    console.warn('No se pudo verificar/crear la tabla f5_alias (el usuario de BD no tiene permiso CREATE); se asume que ya existe:', err.sqlMessage || err.message);
  }
  tablaAliasLista = true;
}

// Devuelve un mapa fullPath -> alias para todos los Virtual Servers de un
// dispositivo. Si algo falla (ej. BD caída) no rompe la vista: simplemente
// no se muestran alias esa vez.
async function obtenerAliases(dispositivoId) {
  try {
    const pool = await getPool();
    await garantizarTablaAlias(pool);
    const [filas] = await pool.query(
      'SELECT virtual_full_path, alias FROM f5_alias WHERE dispositivo_id = ?',
      [dispositivoId]
    );
    const mapa = new Map();
    for (const fila of filas) mapa.set(fila.virtual_full_path, fila.alias);
    return mapa;
  } catch (e) {
    console.error('No se pudieron cargar los alias de F5 (se continúa sin ellos):', e.message);
    return new Map();
  }
}

async function guardarAlias(dispositivoId, fullPath, alias, usuario) {
  const pool = await getPool();
  await garantizarTablaAlias(pool);

  if (!alias) {
    await pool.query('DELETE FROM f5_alias WHERE dispositivo_id = ? AND virtual_full_path = ?', [dispositivoId, fullPath]);
    return null;
  }

  await pool.query(
    `INSERT INTO f5_alias (dispositivo_id, virtual_full_path, alias, actualizado_por)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE alias = VALUES(alias), actualizado_por = VALUES(actualizado_por)`,
    [dispositivoId, fullPath, alias, usuario || null]
  );
  return alias;
}

// --- Ocultos por usuario (guardados en NUESTRA base de datos) ---
// "Ocultar de mi vista" es una preferencia PERSONAL: cada usuario puede
// ocultar Virtual Servers que no le interesan sin afectar lo que ven los
// demás (a diferencia del alias, que es compartido). Por eso la llave incluye
// el usuario, y la tabla se crea sola la primera vez que se usa.
let tablaOcultoLista = false;
async function garantizarTablaOculto(pool) {
  if (tablaOcultoLista) return;
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS f5_oculto (
      dispositivo_id VARCHAR(64) NOT NULL,
      virtual_full_path VARCHAR(255) NOT NULL,
      usuario VARCHAR(100) NOT NULL,
      actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (dispositivo_id, virtual_full_path, usuario)
    )
    `);
  } catch (err) {
    if (!esErrorDePermisosDdl(err)) throw err;
    console.warn('No se pudo verificar/crear la tabla f5_oculto (el usuario de BD no tiene permiso CREATE); se asume que ya existe:', err.sqlMessage || err.message);
  }
  tablaOcultoLista = true;
}

// Devuelve el conjunto de fullPath que el usuario dado tiene ocultos en ese
// dispositivo. Si algo falla (ej. BD caída) no rompe la vista: simplemente
// no se oculta nada esa vez.
async function obtenerOcultos(dispositivoId, usuario) {
  if (!usuario) return new Set();
  try {
    const pool = await getPool();
    await garantizarTablaOculto(pool);
    const [filas] = await pool.query(
      'SELECT virtual_full_path FROM f5_oculto WHERE dispositivo_id = ? AND usuario = ?',
      [dispositivoId, usuario]
    );
    return new Set(filas.map((f) => f.virtual_full_path));
  } catch (e) {
    console.error('No se pudieron cargar los ocultos de F5 (se continúa mostrando todo):', e.message);
    return new Set();
  }
}

async function guardarOculto(dispositivoId, fullPath, usuario, oculto) {
  if (!usuario) throw new Error('No se pudo identificar el usuario de la sesión.');

  const pool = await getPool();
  await garantizarTablaOculto(pool);

  if (!oculto) {
    await pool.query(
      'DELETE FROM f5_oculto WHERE dispositivo_id = ? AND virtual_full_path = ? AND usuario = ?',
      [dispositivoId, fullPath, usuario]
    );
    return false;
  }

  await pool.query(
    `INSERT INTO f5_oculto (dispositivo_id, virtual_full_path, usuario)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE actualizado_en = CURRENT_TIMESTAMP`,
    [dispositivoId, fullPath, usuario]
  );
  return true;
}

function manejarError(res, error, contexto) {
  console.error(`Error en ${contexto}:`, error.message);
  if (error.message?.includes('no está configurado') || error.message?.includes('mal configurado')) {
    return res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
  if (error.status === 401 || error.status === 403) {
    return res.status(502).json({ error: 'El F5 rechazó las credenciales configuradas para este dispositivo.' });
  }
  if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ETIMEDOUT' || error.message?.includes('Tiempo de espera')) {
    return res.status(502).json({ error: 'No se pudo contactar al F5 (host inaccesible o fuera de línea).' });
  }
  return res.status(502).json({ error: 'No se pudo consultar el F5. Intenta de nuevo en un momento.' });
}

// GET /api/f5/dispositivos
// Lista los equipos F5 configurados (sin exponer usuario/contraseña).
router.get('/dispositivos', (req, res) => {
  const dispositivos = cargarDispositivosF5().map((d) => ({ id: d.id, nombre: d.nombre }));
  res.json({ dispositivos });
});

// GET /api/f5/:dispositivoId/virtuales
// Lista los Virtual Servers de ese F5 con su estado y métricas básicas.
router.get('/:dispositivoId/virtuales', async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });

  try {
    // La config + stats + conteo de nodos por pool viene de la función
    // compartida en utils/f5Cliente.js (la misma que usan el job de captura
    // histórica y el informe de Fase 2) — aquí solo se le suman las
    // preferencias de UI propias de esta vista (alias/ocultos), que NO
    // hacen falta para el snapshot histórico ni para el informe.
    const [virtualesBase, aliasPorPath, ocultos] = await Promise.all([
      obtenerVirtualesConEstado(dispositivo),
      obtenerAliases(dispositivo.id),
      obtenerOcultos(dispositivo.id, req.user?.username),
    ]);

    const virtuales = virtualesBase.map((v) => ({
      ...v,
      alias: aliasPorPath.get(v.fullPath) || null,
      oculto: ocultos.has(v.fullPath),
    }));

    virtuales.sort((a, b) => (a.alias || a.nombre).localeCompare(b.alias || b.nombre, 'es'));

    res.json({ dispositivoId: dispositivo.id, dispositivoNombre: dispositivo.nombre, virtuales });
  } catch (error) {
    manejarError(res, error, `GET /f5/${req.params.dispositivoId}/virtuales`);
  }
});

// PUT /api/f5/:dispositivoId/alias
// Guarda (o borra, si llega vacío) el nombre propio de un Virtual Server.
// Esto SOLO escribe en nuestra base de datos: nunca toca el F5.
// El alias lo ven todos, así que cambiarlo exige rol ADMIN_MIN en este módulo
// (con rol de Consulta solo se ve).
router.put('/:dispositivoId/alias', requireEditPermission, async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });

  const { fullPath, alias } = req.body || {};
  if (!fullPath) return res.status(400).json({ error: 'Falta el Virtual Server (fullPath).' });

  const aliasLimpio = (alias || '').toString().trim().slice(0, 120);

  try {
    const pool = await getPool();
    await garantizarTablaAlias(pool);
    const [aliasAntesFilas] = await pool.query(
      'SELECT alias FROM f5_alias WHERE dispositivo_id = ? AND virtual_full_path = ?',
      [dispositivo.id, fullPath]
    );
    const aliasAnterior = aliasAntesFilas[0]?.alias || null;

    const aliasGuardado = await guardarAlias(dispositivo.id, fullPath, aliasLimpio, req.user?.username);

    if ((aliasAnterior || null) !== (aliasGuardado || null)) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'BALANCEADOR_F5',
        entidad: 'Virtual Server (alias)',
        entidadId: `${dispositivo.id}:${fullPath}`,
        entidadNombre: fullPath,
        accion: 'EDICION',
        cambios: [{ campo: 'alias', etiqueta: 'Alias', anterior: aliasAnterior, nuevo: aliasGuardado || null }],
        detalle: `Dispositivo: ${dispositivo.nombre}`,
      });
    }

    res.json({ fullPath, alias: aliasGuardado });
  } catch (error) {
    console.error(`Error en PUT /f5/${req.params.dispositivoId}/alias:`, error.message);
    res.status(500).json({ error: 'No se pudo guardar el nombre. Intenta de nuevo.' });
  }
});

// PUT /api/f5/:dispositivoId/oculto
// Oculta o vuelve a mostrar un Virtual Server SOLO para el usuario actual
// (preferencia personal, no afecta lo que ven los demás). Igual que el
// alias, esto SOLO escribe en nuestra base de datos: nunca toca el F5.
router.put('/:dispositivoId/oculto', async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });

  const { fullPath, oculto } = req.body || {};
  if (!fullPath) return res.status(400).json({ error: 'Falta el Virtual Server (fullPath).' });

  try {
    const pool = await getPool();
    await garantizarTablaOculto(pool);
    const ocultosAntes = await obtenerOcultos(dispositivo.id, req.user?.username);
    const ocultoAnterior = ocultosAntes.has(fullPath);

    const ocultoGuardado = await guardarOculto(dispositivo.id, fullPath, req.user?.username, !!oculto);

    if (ocultoAnterior !== ocultoGuardado) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'BALANCEADOR_F5',
        entidad: 'Virtual Server (visibilidad)',
        entidadId: `${dispositivo.id}:${fullPath}`,
        entidadNombre: fullPath,
        accion: 'EDICION',
        cambios: [{ campo: 'oculto', etiqueta: 'Oculto', anterior: ocultoAnterior, nuevo: ocultoGuardado }],
        detalle: `Dispositivo: ${dispositivo.nombre} (preferencia personal de ${req.user?.username || 'usuario'})`,
      });
    }

    res.json({ fullPath, oculto: ocultoGuardado });
  } catch (error) {
    console.error(`Error en PUT /f5/${req.params.dispositivoId}/oculto:`, error.message);
    res.status(500).json({ error: 'No se pudo guardar la preferencia. Intenta de nuevo.' });
  }
});

// ---------- Helpers de detalle (todo best-effort: si el F5 no responde una
// parte, esa parte simplemente no se muestra) ----------
const sinError = (promesa) => promesa.catch((e) => {
  console.warn(`F5 (consulta opcional): ${e.message}`);
  return null;
});

// Configuración legible de un Virtual Server (protocolo, persistencia, SNAT,
// perfiles, iRules...). `v` viene de /mgmt/tm/ltm/virtual/<ruta>?expandSubcollections=true
function resumirConfigVirtual(v) {
  if (!v) return null;
  const nombres = (arr) => (Array.isArray(arr) ? arr.map((x) => (typeof x === 'string' ? ultimoSegmento(x) : x.name)).filter(Boolean) : []);
  const perfiles = (v.profilesReference?.items || []).map((p) => ({ nombre: p.name, contexto: p.context || null }));
  const snat = v.sourceAddressTranslation;
  return {
    descripcion: v.description || null,
    protocolo: v.ipProtocol || null,
    origen: v.source || null,
    mascara: v.mask || null,
    persistencia: nombres(v.persist),
    persistenciaRespaldo: v.fallbackPersistence ? ultimoSegmento(v.fallbackPersistence) : null,
    snat: snat ? (snat.type === 'snat' || snat.type === 'automap' || snat.type === 'none' ? snat.type + (snat.pool ? `: ${ultimoSegmento(snat.pool)}` : '') : snat.type) : null,
    traduceDireccion: v.translateAddress ?? null,
    traducePuerto: v.translatePort ?? null,
    reglas: nombres(v.rules),
    perfiles,
    politicas: nombres(v.policiesReference?.items),
    limiteConexiones: v.connectionLimit || null,
    habilitado: v.enabled !== false && v.disabled !== true,
  };
}

function resumirConfigPool(pool, stats) {
  if (!pool && !stats) return null;
  const c = stats ? Object.values(stats.entries || {})[0]?.nestedStats?.entries || {} : {};
  const num = (k) => { const x = leer(c[k]); return x === null || x === undefined ? null : Number(x); };
  return {
    metodo: pool?.loadBalancingMode || null,
    monitor: pool?.monitor || null,
    minimoActivos: pool?.minActiveMembers ?? null,
    rampaLenta: pool?.slowRampTime ?? null,
    descripcion: pool?.description || null,
    miembrosActivos: num('activeMemberCnt'),
    miembrosTotal: num('memberCnt'),
    conexionesActuales: num('serverside.curConns'),
    conexionesTotales: num('serverside.totConns'),
    conexionesMaximas: num('serverside.maxConns'),
    sesionesActuales: num('curSessions'),
    peticionesTotales: num('totRequests'),
  };
}

// GET /api/f5/:dispositivoId/pool/miembros?pool=/Common/pool_api_app&virtual=/Common/VS_API
// Detalle de un Virtual Server: sus nodos (miembros del pool) con estado,
// monitor y TRÁFICO (velocidad de entrada/salida, conexiones, peticiones y
// paquetes por nodo), más la configuración del pool y del virtual. El F5 solo
// entrega contadores acumulados, así que la velocidad se calcula con dos
// muestras: la primera vez que se consulta un pool se toma una segunda muestra
// 1 s después (para no mostrar "sin datos"); las siguientes consultas comparan
// contra la anterior (la pantalla refresca cada pocos segundos).
router.get('/:dispositivoId/pool/miembros', async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });

  const poolPath = req.query.pool;
  if (!poolPath) return res.status(400).json({ error: 'Falta el parámetro pool.' });
  const virtualPath = req.query.virtual ? String(req.query.virtual) : null;

  try {
    const rutaF5 = aRutaF5(poolPath);
    const claveBase = `${dispositivo.id}|${poolPath}`;

    // Contadores actuales de cada miembro y, si se pidió, del Virtual Server.
    const leerContadoresActuales = async () => {
      const [statsMiembros, statsVirtual] = await Promise.all([
        peticionF5(dispositivo, `/mgmt/tm/ltm/pool/${rutaF5}/members/stats`),
        virtualPath
          ? sinError(peticionF5(dispositivo, `/mgmt/tm/ltm/virtual/${aRutaF5(virtualPath)}/stats`))
          : Promise.resolve(null),
      ]);
      let delVirtual = null;
      let estadoVirtual = null;
      if (statsVirtual) {
        const primera = Object.values(statsVirtual.entries || {})[0];
        const campos = primera?.nestedStats?.entries || {};
        if (primera) {
          delVirtual = extraerContadores(campos, 'clientside');
          estadoVirtual = extraerEstado(campos);
        }
      }
      return { indice: indexarStatsMiembros(statsMiembros), delVirtual, estadoVirtual };
    };

    const claveDe = (nombre) => `${claveBase}|m|${nombre}`;
    const claveVirtual = `${dispositivo.id}|virt|${virtualPath}`;

    const [miembrosBase, configPool, statsPool, configVirtual] = await Promise.all([
      obtenerMiembrosDePool(dispositivo, poolPath),
      sinError(peticionF5(dispositivo, `/mgmt/tm/ltm/pool/${rutaF5}`)),
      sinError(peticionF5(dispositivo, `/mgmt/tm/ltm/pool/${rutaF5}/stats`)),
      virtualPath
        ? sinError(peticionF5(dispositivo, `/mgmt/tm/ltm/virtual/${aRutaF5(virtualPath)}?expandSubcollections=true`))
          .then((r) => r || sinError(peticionF5(dispositivo, `/mgmt/tm/ltm/virtual/${aRutaF5(virtualPath)}`)))
        : Promise.resolve(null),
    ]);
    let { indice, delVirtual, estadoVirtual } = await leerContadoresActuales();

    const faltaMuestra = miembrosBase.some((m) => !hayMuestraReciente(claveDe(m.nombre)))
      || (virtualPath && delVirtual && !hayMuestraReciente(claveVirtual));
    if (faltaMuestra) {
      // Guarda la primera muestra, espera 1 s y toma la segunda para tener velocidad ya.
      miembrosBase.forEach((m) => {
        const campos = buscarStatsMiembro(indice, m);
        if (campos) calcularTrafico(claveDe(m.nombre), extraerContadores(campos, 'serverside'));
      });
      if (delVirtual) calcularTrafico(claveVirtual, delVirtual);
      await esperar(1100);
      ({ indice, delVirtual, estadoVirtual } = await leerContadoresActuales());
    }

    const miembros = miembrosBase.map((m) => {
      const campos = buscarStatsMiembro(indice, m);
      const trafico = campos ? calcularTrafico(claveDe(m.nombre), extraerContadores(campos, 'serverside')) : null;
      const estadoF5 = campos ? extraerEstado(campos) : null;
      // "Último tráfico" del nodo: se alimenta con esta misma lectura (ver utils/f5ActividadNodos.js).
      const actividad = campos
        ? registrarMuestra(dispositivo.id, poolPath, m.nombre, extraerContadores(campos, 'serverside'))
        : null;
      return {
        ...m,
        conexionesActuales: trafico ? trafico.conexionesActuales : null,
        trafico,
        estadoF5,
        actividad,
      };
    });

    miembros.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));

    res.json({
      pool: poolPath,
      miembros,
      traficoVirtual: delVirtual ? calcularTrafico(claveVirtual, delVirtual) : null,
      estadoVirtual,
      configVirtual: resumirConfigVirtual(configVirtual),
      configPool: resumirConfigPool(configPool, statsPool),
      muestreadoEn: new Date().toISOString(),
    });
  } catch (error) {
    manejarError(res, error, `GET /f5/${req.params.dispositivoId}/pool/miembros (pool=${poolPath})`);
  }
});

// ---------- Diagnóstico de un nodo (por qué el monitor lo marca caído) ----------
// Tipos de monitor LTM que se prueban, en orden, para encontrar la
// configuración de un monitor por nombre (la API del F5 exige el tipo en la ruta).
const TIPOS_MONITOR = ['http', 'https', 'tcp', 'tcp-half-open', 'icmp', 'gateway-icmp', 'udp', 'external', 'ftp', 'smtp', 'ldap', 'mysql', 'mssql', 'oracle', 'postgresql', 'dns', 'inband', 'sip', 'radius', 'diameter', 'firepass', 'imap', 'pop3', 'nntp', 'scripted', 'snmp-dca', 'wmi', 'real-server', 'soap', 'module-score', 'virtual-location'];

// "/Common/http and /Common/tcp", "min 1 of { /Common/a /Common/b }", "default", "none"
function extraerNombresMonitor(texto) {
  if (!texto || typeof texto !== 'string') return [];
  const rutas = texto.match(/\/[\w.\-]+\/[\w.\-]+/g);
  return rutas ? [...new Set(rutas)] : [];
}

// Busca un monitor por nombre probando los tipos (primero el que coincide con el nombre).
async function leerConfigMonitor(dispositivo, nombreCompleto) {
  const base = ultimoSegmento(nombreCompleto);
  const orden = [...new Set([base.split('_')[0], base, ...TIPOS_MONITOR])].filter((t) => TIPOS_MONITOR.includes(t));
  for (const tipo of orden) {
    try {
      const m = await peticionF5(dispositivo, `/mgmt/tm/ltm/monitor/${tipo}/${aRutaF5(nombreCompleto)}`);
      if (m && m.name) return { tipo, m };
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      // 404 / tipo equivocado: se prueba el siguiente
    }
  }
  return null;
}

// Resume un monitor sin exponer credenciales (usuario/contraseña del monitor no se devuelven).
function resumirMonitor(nombreCompleto, hallado) {
  if (!hallado) return { nombre: nombreCompleto, tipo: null, encontrado: false };
  const { tipo, m } = hallado;
  const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
  return {
    nombre: nombreCompleto,
    encontrado: true,
    tipo,
    descripcion: m.description || null,
    heredaDe: m.defaultsFrom ? ultimoSegmento(m.defaultsFrom) : null,
    intervalo: num(m.interval),
    tiempoLimite: num(m.timeout),
    destino: m.destination || null,
    envia: m.send || null,
    espera: m.recv || null,
    esperaDeshabilitar: m.recvDisable || null,
    inverso: m.reverse === 'enabled',
    transparente: m.transparent === 'enabled',
    usaCredenciales: !!m.username,
    cifrados: m.cipherlist || null,
    certificado: m.cert ? ultimoSegmento(m.cert) : null,
  };
}

const RAZONES_F5 = [
  [/marked down by a monitor/i, 'El monitor de salud lo marcó caído porque no respondió como se esperaba'],
  [/forced down/i, 'Fue forzado a "caído" manualmente en el F5'],
  [/node address .*marked down|node .*down/i, 'El nodo completo (la IP) está caído, no solo este puerto'],
  [/parent.*(down|disabled)/i, 'Está caído o deshabilitado un elemento del que depende'],
  [/unavailable|no monitor|unknown|not checked/i, 'El F5 todavía no tiene resultado del monitor (o no tiene monitor asignado)'],
];
const traducirRazon = (t) => {
  if (!t) return null;
  const r = RAZONES_F5.find(([re]) => re.test(t));
  return r ? r[1] : null;
};

// Genera las pistas en lenguaje claro según el tipo de monitor y lo que reporta el F5.
function armarDiagnostico({ miembro, estadoF5, nodoEstado, monitoresResumen, monitorEfectivo }) {
  const pistas = [];
  const add = (nivel, texto) => pistas.push({ nivel, texto });
  const sesion = String(miembro?.sesion || estadoF5?.sesion || '').toLowerCase();
  const habilitado = String(estadoF5?.habilitado || '').toLowerCase();
  const estadoMon = String(miembro?.estadoMonitor || '').toLowerCase();

  if (sesion.includes('user-disabled') || habilitado === 'disabled') {
    add('info', 'Un administrador lo deshabilitó en el F5: no recibe tráfico nuevo aunque el servidor esté bien. Se rehabilita desde el F5 (Pool > Members > Enable).');
  }
  if (nodoEstado && /offline|unavailable/i.test(nodoEstado.disponibilidad || '') && /down|monitor/i.test((nodoEstado.razon || '') + ' ' + (nodoEstado.monitor || ''))) {
    add('alto', 'El nodo completo (la IP) aparece caído en el F5, así que afecta a todos los pools donde esté. Revisa que el servidor esté encendido y alcance la red del F5.');
  }
  if (estadoMon === 'down') {
    if (!monitorEfectivo.length) {
      add('medio', 'El F5 reporta el monitor caído pero no se pudo identificar cuál está aplicado; revísalo en el F5.');
    }
    for (const mon of monitoresResumen) {
      if (!mon.encontrado) {
        add('medio', `Monitor ${mon.nombre}: no se pudo leer su configuración (puede estar en otra partición o ser de un tipo poco común).`);
        continue;
      }
      const t = mon.tipo;
      const cuando = mon.intervalo && mon.tiempoLimite
        ? ` El F5 lo prueba cada ${mon.intervalo} s y lo marca caído si pasan ${mon.tiempoLimite} s sin una respuesta válida.`
        : '';
      if (t === 'http' || t === 'https') {
        add('alto', `Monitor ${ultimoSegmento(mon.nombre)} (${t.toUpperCase()}): el F5 envía ${mon.envia ? '"' + mon.envia.replace(/\\r\\n|\r?\n/g, ' ').slice(0, 120) + '"' : 'una petición'}${mon.espera ? ' y espera que la respuesta contenga "' + mon.espera.slice(0, 80) + '"' : ' y espera una respuesta válida'}. Si la aplicación responde otro código/contenido, tarda más del límite o no responde, el nodo se marca caído.${cuando}`);
        if (t === 'https') add('medio', 'En HTTPS también puede fallar por TLS entre el F5 y el servidor (certificado vencido, protocolo o cifrados no compatibles).');
        add('info', `Prueba desde el F5 (o una máquina en su misma red): curl -v${t === 'https' ? 'k' : ''} ${t}://IP:PUERTO/ruta y compara con lo que espera el monitor.`);
      } else if (t === 'tcp' || t === 'tcp-half-open') {
        add('alto', `Monitor ${ultimoSegmento(mon.nombre)} (${t.toUpperCase()}): el F5 no logra abrir la conexión al puerto del nodo. Causas típicas: el servicio/aplicación está detenido, el puerto es otro, o un firewall bloquea desde el F5.${cuando}`);
        add('info', 'Verifica en el servidor que el puerto esté escuchando (netstat -an) y que el firewall permita las IP del F5.');
      } else if (t === 'icmp' || t === 'gateway-icmp') {
        add('alto', `Monitor ${ultimoSegmento(mon.nombre)} (ICMP): el servidor no responde ping desde el F5. Está apagado, sin red o ICMP bloqueado.${cuando}`);
      } else if (t === 'udp') {
        add('alto', `Monitor ${ultimoSegmento(mon.nombre)} (UDP): el servicio no devolvió la respuesta esperada.${cuando}`);
      } else {
        add('alto', `Monitor ${ultimoSegmento(mon.nombre)} (${t}): la verificación configurada falla contra este nodo.${cuando}`);
      }
      if (mon.inverso) add('info', 'Este monitor es de tipo inverso: marca caído al nodo cuando SÍ recibe la respuesta esperada.');
    }
  } else if (estadoMon === 'unchecked' && !sesion.includes('user-disabled')) {
    add('info', monitorEfectivo.length
      ? 'El monitor todavía no ha dado un resultado para este nodo (recién agregado o el F5 aún no lo evalúa).'
      : 'No hay monitor de salud asignado, por eso el F5 no puede saber si está sano.');
  }
  if (!pistas.length) add('info', 'El F5 no reporta una causa específica para este nodo en este momento. Revisa el detalle en el F5.');
  return pistas;
}

// GET /api/f5/:dispositivoId/nodo/detalle?pool=/Common/pool_api_app&miembro=10.0.0.1:443
// Detalle de un nodo con problema: estado y razón que informa el F5, qué
// monitor(es) se le aplican con su configuración (qué envía, qué espera,
// intervalo y tiempo límite) y pistas en lenguaje claro. Todo es de solo lectura.
router.get('/:dispositivoId/nodo/detalle', async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });

  const poolPath = String(req.query.pool || '');
  const nombreMiembro = String(req.query.miembro || '');
  if (!/^\/[\w.\-]+(\/[\w.\-]+)+$/.test(poolPath)) return res.status(400).json({ error: 'Parámetro pool inválido.' });
  if (!nombreMiembro || nombreMiembro.length > 200) return res.status(400).json({ error: 'Falta el parámetro miembro.' });

  try {
    const rutaF5 = aRutaF5(poolPath);
    const [miembros, configPool, statsMiembros] = await Promise.all([
      obtenerMiembrosDePool(dispositivo, poolPath),
      sinError(peticionF5(dispositivo, `/mgmt/tm/ltm/pool/${rutaF5}`)),
      sinError(peticionF5(dispositivo, `/mgmt/tm/ltm/pool/${rutaF5}/members/stats`)),
    ]);
    const miembro = miembros.find((m) => m.nombre === nombreMiembro || ultimoSegmento(m.nombre) === ultimoSegmento(nombreMiembro)
      || (m.puerto !== null && `${m.direccion}:${m.puerto}` === nombreMiembro));
    if (!miembro) return res.status(404).json({ error: 'El nodo ya no es miembro de ese pool en el F5.' });

    const campos = statsMiembros ? buscarStatsMiembro(indexarStatsMiembros(statsMiembros), miembro) : null;
    const estadoF5 = campos ? extraerEstado(campos) : null;

    // Estado del nodo (la IP) por sí solo: si el nodo entero está caído afecta a todos sus pools.
    let nodo = null;
    const nombreNodo = campos ? leer(campos.nodeName) : null;
    if (nombreNodo && /^\/[\w.\-]+\/[\w.\-:%]+$/.test(nombreNodo)) {
      const statsNodo = await sinError(peticionF5(dispositivo, `/mgmt/tm/ltm/node/${aRutaF5(nombreNodo)}/stats`));
      const c = statsNodo ? Object.values(statsNodo.entries || {})[0]?.nestedStats?.entries : null;
      if (c) nodo = { nombre: nombreNodo, ...extraerEstado(c) };
    }

    // Monitor efectivo: el del miembro, o el del pool si el miembro usa "default".
    const monitorMiembro = miembro.monitor || 'default';
    const monitorPool = configPool?.monitor || null;
    const usaDelPool = !miembro.monitor || /^default$/i.test(String(miembro.monitor).trim());
    const textoEfectivo = usaDelPool ? monitorPool : miembro.monitor;
    const nombresMonitor = /^none$/i.test(String(textoEfectivo || '').trim()) ? [] : extraerNombresMonitor(textoEfectivo);

    const monitoresResumen = [];
    for (const nombre of nombresMonitor.slice(0, 5)) {
      let hallado = null;
      try { hallado = await leerConfigMonitor(dispositivo, nombre); } catch (e) { console.warn(`F5 (monitor ${nombre}): ${e.message}`); }
      monitoresResumen.push(resumirMonitor(nombre, hallado));
    }

    res.json({
      pool: poolPath,
      miembro: miembro.nombre,
      direccion: miembro.direccion,
      puerto: miembro.puerto,
      estadoConfig: miembro.estadoMonitor,
      sesion: miembro.sesion,
      estadoF5,
      razonTraducida: traducirRazon(estadoF5?.razon),
      nodo,
      monitorMiembro,
      monitorPool,
      origenMonitor: usaDelPool ? 'pool' : 'miembro',
      monitores: monitoresResumen,
      diagnostico: armarDiagnostico({ miembro, estadoF5, nodoEstado: nodo, monitoresResumen, monitorEfectivo: nombresMonitor }),
      consultadoEn: new Date().toISOString(),
    });
  } catch (error) {
    manejarError(res, error, `GET /f5/${req.params.dispositivoId}/nodo/detalle (pool=${poolPath}, miembro=${nombreMiembro})`);
  }
});

// GET /api/f5/:dispositivoId/pool/historial?pool=/Common/pool_api_app&horas=24
// Histórico de tráfico POR NODO de un pool: velocidad de entrada/salida,
// conexiones abiertas y nuevas, picos con su hora y totales, en cubetas de
// tiempo (la resolución se ajusta al rango pedido). Los datos los genera el
// muestreo en segundo plano (utils/f5ActividadNodos.js); si la última lectura
// del pool es vieja se toma una lectura nueva antes de responder, así la
// gráfica siempre llega hasta "ahora".
const muestreosHistorialEnCurso = new Map();
router.get('/:dispositivoId/pool/historial', async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });

  const poolPath = req.query.pool ? String(req.query.pool) : '';
  if (!poolPath) return res.status(400).json({ error: 'Falta el parámetro pool.' });
  const horas = Math.min(MAX_HORAS, Math.max(1, Number(req.query.horas) || 24));

  try {
    const clave = `${dispositivo.id}|${poolPath}`;
    let miembrosActuales = [];
    let avisoLectura = null;
    // Lectura nueva si la última tiene más de 2 min (sin duplicar lecturas simultáneas).
    if (Date.now() - ultimaLecturaPool(dispositivo.id, poolPath) > 120 * 1000) {
      try {
        let p = muestreosHistorialEnCurso.get(clave);
        if (!p) {
          p = muestrearPool(dispositivo, poolPath).finally(() => muestreosHistorialEnCurso.delete(clave));
          muestreosHistorialEnCurso.set(clave, p);
        }
        miembrosActuales = (await p).map((m) => m.nombre);
        await guardarHistorial();
      } catch (err) {
        avisoLectura = 'No se pudo leer el F5 en este momento; se muestra lo ya registrado.';
        console.warn(`F5: lectura puntual del histórico falló (${poolPath}): ${err.message}`);
      }
    } else {
      miembrosActuales = (await sinError(obtenerMiembrosDePool(dispositivo, poolPath)) || []).map((m) => m.nombre);
    }
    const datos = await consultarHistorial(dispositivo.id, poolPath, horas, INTERVALO_MUESTREO_MS, miembrosActuales);
    res.json({ ...datos, aviso: avisoLectura });
  } catch (error) {
    manejarError(res, error, `GET /f5/${req.params.dispositivoId}/pool/historial (pool=${poolPath})`);
  }
});

// GET /api/f5/:dispositivoId/pool/historial-avr?pool=/Common/pool_x&horas=24
// Histórico por nodo traído de AVR (Statistics > Analytics del propio F5):
// transacciones HTTP por tramo de tiempo. A diferencia de /pool/historial, esto
// SÍ incluye días anteriores al despliegue de la app. Solo cubre nodos de
// Virtual Servers con perfil de analítica HTTP.
router.get('/:dispositivoId/pool/historial-avr', async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });
  const poolPath = req.query.pool ? String(req.query.pool) : '';
  if (!poolPath) return res.status(400).json({ error: 'Falta el parámetro pool.' });
  const horas = Math.min(MAX_HORAS, Math.max(1, Number(req.query.horas) || 24));
  try {
    const miembros = await obtenerMiembrosDePool(dispositivo, poolPath);
    const datos = await historialAvr(dispositivo, miembros, horas);
    res.json(datos);
  } catch (error) {
    console.warn(`F5: histórico AVR falló (${poolPath}): ${error.message}`);
    res.status(502).json({ error: `No se pudo leer el histórico de AVR del F5. ${String(error.message || error).slice(0, 500)}` });
  }
});

// GET /api/f5/:dispositivoId/avr/diagnostico
// Prueba (solo lectura) qué rutas de AVR/Analytics responde este F5, para
// saber si el histórico de "Statistics > Analytics" se puede traer por API.
router.get('/:dispositivoId/avr/diagnostico', async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });
  try {
    res.json(await diagnosticoAvr(dispositivo));
  } catch (error) {
    manejarError(res, error, `GET /f5/${req.params.dispositivoId}/avr/diagnostico`);
  }
});

// GET /api/f5/:dispositivoId/trafico-virtuales
// Tráfico en vivo de TODOS los Virtual Servers con UNA sola consulta al F5
// (/virtual/stats): conexiones abiertas, velocidad ↓/↑, conexiones nuevas y
// peticiones por segundo. Es liviano a propósito: la pantalla lo consulta cada
// pocos segundos para refrescar tarjetas, totales y "los que más tráfico llevan".
router.get('/:dispositivoId/trafico-virtuales', async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });

  try {
    const leerTodos = async () => {
      const data = await peticionF5(dispositivo, '/mgmt/tm/ltm/virtual/stats');
      const lista = [];
      for (const entrada of Object.values(data.entries || {})) {
        const campos = entrada.nestedStats?.entries || {};
        const fullPath = leer(campos.tmName);
        if (!fullPath) continue;
        lista.push({ fullPath, contadores: extraerContadores(campos, 'clientside'), estado: extraerEstado(campos) });
      }
      return lista;
    };
    const clave = (fullPath) => `${dispositivo.id}|virt|${fullPath}`;

    let lista = await leerTodos();
    const sinMuestra = lista.filter((x) => !hayMuestraReciente(clave(x.fullPath)));
    if (sinMuestra.length) {
      // Primera lectura de esos Virtual Servers: se guarda y se toma otra 1 s después.
      sinMuestra.forEach((x) => calcularTrafico(clave(x.fullPath), x.contadores));
      await esperar(1100);
      lista = await leerTodos();
    }

    const virtuales = lista.map((x) => ({
      fullPath: x.fullPath,
      estado: x.estado.disponibilidad || 'unknown',
      motivoEstado: x.estado.razon || null,
      habilitado: (x.estado.habilitado || 'enabled') !== 'disabled',
      trafico: calcularTrafico(clave(x.fullPath), x.contadores),
    }));

    const suma = (f) => virtuales.reduce((acc, v) => acc + (f(v.trafico) || 0), 0);
    const hayTasa = virtuales.some((v) => v.trafico.entradaBps !== null);
    const entradaBps = hayTasa ? suma((t) => t.entradaBps) : null;
    const salidaBps = hayTasa ? suma((t) => t.salidaBps) : null;

    res.json({
      virtuales,
      totales: {
        conexionesActuales: suma((t) => t.conexionesActuales),
        entradaBps,
        salidaBps,
        entradaTexto: entradaBps === null ? null : formatearBitsPorSegundo(entradaBps),
        salidaTexto: salidaBps === null ? null : formatearBitsPorSegundo(salidaBps),
        conexionesNuevasPorSeg: hayTasa ? suma((t) => t.conexionesNuevasPorSeg) : null,
        peticionesPorSeg: hayTasa ? suma((t) => t.peticionesPorSeg) : null,
      },
      muestreadoEn: new Date().toISOString(),
    });
  } catch (error) {
    manejarError(res, error, `GET /f5/${req.params.dispositivoId}/trafico-virtuales`);
  }
});

// GET /api/f5/:dispositivoId/sistema
// Datos del propio equipo (versión, hostname, estado de alta disponibilidad y
// el rendimiento que reporta el F5: CPU, memoria, throughput, conexiones...).
// Todo opcional: si la cuenta del F5 no tiene permiso para alguna consulta, esa
// parte no aparece. Se guarda 10 s en memoria para no repetir consultas.
const cacheSistema = new Map(); // dispositivoId -> { hasta, datos }

router.get('/:dispositivoId/sistema', async (req, res) => {
  const dispositivo = buscarDispositivo(req.params.dispositivoId);
  if (!dispositivo) return res.status(404).json({ error: 'Dispositivo F5 no configurado.' });

  const enCache = cacheSistema.get(dispositivo.id);
  if (enCache && enCache.hasta > Date.now()) return res.json(enCache.datos);

  try {
    const [version, failover, rendimiento, global] = await Promise.all([
      sinError(peticionF5(dispositivo, '/mgmt/tm/sys/version')),
      sinError(peticionF5(dispositivo, '/mgmt/tm/cm/failover-status')),
      sinError(peticionF5(dispositivo, '/mgmt/tm/sys/performance/all-stats')),
      sinError(peticionF5(dispositivo, '/mgmt/tm/sys/global-settings')),
    ]);

    const primeraEntrada = (d) => Object.values(d?.entries || {})[0]?.nestedStats?.entries || null;
    const v = primeraEntrada(version);
    const f = primeraEntrada(failover);

    // Rendimiento: una fila por métrica con Actual / Promedio / Máximo tal
    // como los reporta el F5 (texto), sin interpretar unidades.
    const metricas = [];
    for (const [llave, entrada] of Object.entries(rendimiento?.entries || {})) {
      const campos = entrada.nestedStats?.entries || {};
      const nombre = decodeURIComponent(String(llave).split('/').pop() || '');
      const buscar = (re) => {
        const k = Object.keys(campos).find((x) => re.test(x));
        return k ? leer(campos[k]) : null;
      };
      const fila = { nombre, actual: buscar(/^current$/i), promedio: buscar(/^average$/i), maximo: buscar(/^max/i) };
      if (fila.actual !== null || fila.promedio !== null || fila.maximo !== null) metricas.push(fila);
    }

    const datos = {
      hostname: global?.hostname || null,
      producto: v ? leer(v.Product) : null,
      version: v ? leer(v.Version) : null,
      build: v ? leer(v.Build) : null,
      haEstado: f ? leer(f.status) : null,
      haResumen: f ? leer(f.summary) : null,
      rendimiento: metricas,
      muestreadoEn: new Date().toISOString(),
    };
    cacheSistema.set(dispositivo.id, { hasta: Date.now() + 10000, datos });
    res.json(datos);
  } catch (error) {
    manejarError(res, error, `GET /f5/${req.params.dispositivoId}/sistema`);
  }
});

// ==========================================
// HISTÓRICO DE VIRTUAL SERVERS / NODOS DEL F5 (Fase 2 del informe general).
// El F5 no tiene ninguna tabla de histórico propia — solo se puede
// consultar su estado EN VIVO por iControl REST. Igual que
// monitoreo_historico_portainer (ver routes/monitoreo.js), la tabla
// f5_historico se crea sola la primera vez que se usa y un job en segundo
// plano guarda una fila por dispositivo F5 cada 10 minutos; no hay
// histórico antes de que el backend empiece a correr con este código, así
// que el informe de F5 por periodo arranca vacío y se va llenando solo.
// ==========================================
const INTERVALO_HISTORICO_F5_MS = 10 * 60 * 1000; // cada 10 minutos, mismo intervalo que Portainer

async function capturarSnapshotHistoricoF5() {
  if (!F5_DISPOSITIVOS_CONFIGURADOS) return;

  const dispositivos = cargarDispositivosF5();
  const fecha = new Date();
  const filas = [];

  for (const dispositivo of dispositivos) {
    try {
      const virtuales = await obtenerVirtualesConEstado(dispositivo);
      const virtualesTotal = virtuales.length;
      const virtualesArriba = virtuales.filter((v) => v.estado === 'available').length;

      // Nodos: se agregan por POOL ÚNICO (no por Virtual Server) para no
      // contar dos veces los nodos de un pool que varios virtuales comparten.
      const poolsUnicos = new Map();
      for (const v of virtuales) {
        if (!v.pool || v.nodosTotal === null || v.nodosTotal === undefined) continue;
        poolsUnicos.set(v.pool, { arriba: v.nodosArriba || 0, total: v.nodosTotal });
      }
      let nodosTotal = 0;
      let nodosArriba = 0;
      for (const { arriba, total } of poolsUnicos.values()) {
        nodosTotal += total;
        nodosArriba += arriba;
      }

      filas.push([fecha, dispositivo.id, dispositivo.nombre, virtualesTotal, virtualesArriba, nodosTotal, nodosArriba]);
    } catch (err) {
      // Un F5 puntual caído/inaccesible no debe impedir capturar los demás
      // dispositivos configurados, ni tumbar el backend — se reintenta solo
      // en el siguiente ciclo del intervalo.
      console.warn(`No se pudo capturar el snapshot histórico de F5 "${dispositivo.id}": ${err.message}`);
    }
  }

  if (!filas.length) return;

  try {
    const pool = await getPool();
    await garantizarTablaF5Historico(pool);
    await pool.query(
      `INSERT INTO f5_historico
        (Fecha, DispositivoId, DispositivoNombre, VirtualesTotal, VirtualesArriba, NodosTotal, NodosArriba)
       VALUES ?`,
      [filas]
    );
  } catch (err) {
    console.warn(`No se pudo guardar el snapshot histórico de F5: ${err.message}`);
  }
}

if (F5_DISPOSITIVOS_CONFIGURADOS) {
  // Primera captura a los 45s de arrancar (decalada de los 30s de Portainer
  // para no competir con esa durante el arranque del servidor), y de ahí en
  // adelante cada INTERVALO_HISTORICO_F5_MS.
  setTimeout(capturarSnapshotHistoricoF5, 45000);
  setInterval(capturarSnapshotHistoricoF5, INTERVALO_HISTORICO_F5_MS);
}

// Lectura periódica de los contadores de todos los nodos para saber cuándo fue
// su último tráfico aunque nadie tenga abierta la pantalla (utils/f5ActividadNodos.js).
iniciarMuestreoActividad();

module.exports = router;
