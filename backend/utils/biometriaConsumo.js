// Tablero «Consumo y reusos» de Biometría (SOLO LECTURA sobre ORQBIOMETRIA).
//
// Responde a: ¿cuántas veces por día se consulta a ASISA y a OLIMPIA?, ¿cuántos reusos hay?, ¿qué clientes consultan más veces de lo
// que deberían (sobrecosto)? y ¿en qué horas, con qué resultados y en qué días (hábiles o no)?
//
// Se cuenta TODA la tabla CASO (cada caso = una consulta). Cómo se reconoce cada proveedor (regla del equipo):
//   ASISA   = CASO.idRegla 1 (pide 4 imágenes) o 99 (ya tiene biometría exitosa en Olimpia: solo pide la huella en Olimpia),
//             tanto del canal 0 (flujo directo) como del canal 1 (el mismo proceso hecho desde la app: también es consulta a ASISA)
//   OLIMPIA = todo lo demás: el canal 0 (WhoisWho, el canal por defecto) es Olimpia y el canal 1 con regla 0 (proceso desde la app) también.
// La regla manda para el proveedor; el canal solo indica por dónde entró (canal 0 = WhoisWho, canal 1 = app).
// CASO.idRegla es REGLA.id: una regla = un producto/subproducto en una transacción (Enrolamiento/Login) con sus límites y su validación.
// La transacción es un dato de la regla, no la regla misma (ver biometriaConsumoCatalogo.js).
// Estados de CASO.idEstado: 1 pendiente, 2 en proceso, 3 reintento, 4 exitoso, 5 fallido, 6 fuera de línea.
//
// REUSO (cómo se calcula): para un cliente, un proveedor y un día, la primera consulta es la normal y cada una de las siguientes
// es un «reuso» (reusos = consultas − 1). De los reusos se separan dos cosas:
//   · «después de un éxito»: consultas hechas cuando el cliente YA tenía una exitosa ese mismo día con ese proveedor (evitables);
//   · «sobre el límite»: consultas por encima del límite por cliente configurado PARA ESE PROVEEDOR (es lo que genera sobrecosto).
// LÍMITES por cliente (Configuración): OLIMPIA tiene 5 intentos por día y 15 por mes por cliente y es lo que se alerta; ASISA no tiene
// sobrecosto: se monitorea igual (consumo, reusos, reintentos) pero sin límite por defecto y sin alerta. El límite mensual se cuenta por
// mes calendario (del día 1 al último día, o hasta hoy en el mes en curso) y puede ser distinto del diario.
// Días no hábiles: sábados, domingos y los festivos de la tabla DIASNOHABILES (Año, Mes, Día). Se marcan en la serie diaria y el
// consumo mensual se proyecta con el promedio de días hábiles por un lado y de no hábiles por otro.
//
// Todas las consultas las arma el backend con parámetros (no se acepta SQL del usuario) y filtran por CASO.FechaCreo.
// Aparte, el desglose «por proveedor registrado» sale de RESULTADO.IdProveedor → PROVEEDOR (nombre real que respondió).

const cfg = require('./biometriaConsumoConfig');
const catalogo = require('./biometriaConsumoCatalogo');

const MAX_DIAS = 93;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const TTL_CACHE_MS = 60 * 1000;
const TOP_CLIENTES = 50;
const TOP_RESULTADOS = 60;
const PROVEEDORES = cfg.PROVEEDORES;
const TZ = process.env.TZ_NEGOCIO || 'America/Bogota';

const ETIQUETA_ORIGEN = {
  'ASISA|0|1': 'ASISA · regla 1 (pide 4 imágenes)',
  'ASISA|0|99': 'ASISA · regla 99 (huella en Olimpia)',
  'ASISA|1|1': 'ASISA · regla 1 · desde app (canal 1)',
  'ASISA|1|99': 'ASISA · regla 99 · desde app (canal 1)',
  'OLIMPIA|0|0': 'OLIMPIA · WhoisWho (canal 0, regla 0)',
  'OLIMPIA|1|0': 'OLIMPIA · app (regla 0)',
};
const NOMBRE_CANAL = { 0: 'WhoisWho', 1: 'App Personas' };
const nombreCanal = (c) => NOMBRE_CANAL[c] || `Canal ${c}`;
const NOMBRE_DIA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------
const msDe = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoDe = (ms) => new Date(ms).toISOString().slice(0, 10);
const sumarDias = (iso, n) => isoDe(msDe(iso) + n * 86400000);

function hoyIso() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

/** { desde, hasta } (ambos días incluidos) o { error }. */
function validarRango(desde, hasta) {
  const d = String(desde ?? '').trim();
  const h = String(hasta ?? '').trim();
  if (!RE_FECHA.test(d) || !RE_FECHA.test(h)) return { error: 'Elige la fecha «Desde» y la fecha «Hasta».' };
  const fd = msDe(d);
  const fh = msDe(h);
  if (Number.isNaN(fd) || Number.isNaN(fh) || isoDe(fd) !== d || isoDe(fh) !== h) return { error: 'Alguna de las fechas no es válida.' };
  if (fh < fd) return { error: 'La fecha «Hasta» no puede ser anterior a «Desde».' };
  const dias = Math.round((fh - fd) / 86400000) + 1;
  if (dias > MAX_DIAS) return { error: `El rango máximo es de ${MAX_DIAS} días.` };
  return { desde: d, hasta: h, dias };
}

function listaDias(desde, hasta) {
  const r = [];
  for (let ms = msDe(desde); ms <= msDe(hasta); ms += 86400000) r.push(isoDe(ms));
  return r;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
const PROV = "CASE WHEN c.idRegla IN (1, 99) THEN 'ASISA' ELSE 'OLIMPIA' END";
const RANGO = 'c.FechaCreo >= CONVERT(date, @desde, 112) AND c.FechaCreo < CONVERT(date, @hasta, 112)';
const DIA = 'CONVERT(char(10), CAST(c.FechaCreo AS date), 23)';
const CONTEOS = `COUNT(*) AS total,
  SUM(CASE WHEN c.idEstado = 4 THEN 1 ELSE 0 END) AS exitosos,
  SUM(CASE WHEN c.idEstado = 5 THEN 1 ELSE 0 END) AS fallidos,
  SUM(CASE WHEN c.idEstado = 3 THEN 1 ELSE 0 END) AS reintentos,
  SUM(CASE WHEN c.idEstado = 1 THEN 1 ELSE 0 END) AS pendientes,
  SUM(CASE WHEN c.idEstado = 2 THEN 1 ELSE 0 END) AS enProceso,
  SUM(CASE WHEN c.idEstado = 6 THEN 1 ELSE 0 END) AS fueraLinea,
  SUM(ISNULL(c.reintentos, 0)) AS reintentosAcum,
  COUNT(DISTINCT c.idCliente) AS clientes`;

const aYmd = (iso) => iso.replace(/-/g, '');
// Límite por cliente de cada proveedor: 0 = sin límite (solo monitoreo). `alias` es la tabla/CTE con la columna «proveedor».
const limDe = (lim, prov, periodo) => {
  const v = lim && lim[prov] ? lim[prov][periodo] : null;
  return Number.isInteger(v) && v > 0 ? v : 0;
};
const LIM_DIA = (alias) => `(CASE ${alias}.proveedor WHEN 'ASISA' THEN @maxA ELSE @maxO END)`;
const LIM_MES = (alias) => `(CASE ${alias}.proveedor WHEN 'ASISA' THEN @mesA ELSE @mesO END)`;
const paramsLimiteDia = (lim) => [
  { nombre: 'maxA', tipo: 'int', valor: limDe(lim, 'ASISA', 'dia') },
  { nombre: 'maxO', tipo: 'int', valor: limDe(lim, 'OLIMPIA', 'dia') },
];
const paramsLimiteMes = (lim) => [
  { nombre: 'mesA', tipo: 'int', valor: limDe(lim, 'ASISA', 'mes') },
  { nombre: 'mesO', tipo: 'int', valor: limDe(lim, 'OLIMPIA', 'mes') },
];
const hayLimite = (lim, periodo) => limDe(lim, 'ASISA', periodo) > 0 || limDe(lim, 'OLIMPIA', periodo) > 0;
const MES = 'CONVERT(char(7), c.FechaCreo, 23)';
const finDeMes = (iso) => `${iso.slice(0, 7)}-${String(new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
/** Meses calendario que toca el rango: desde el día 1 del primero hasta el fin del último (sin pasar de hoy). null si todo es futuro. */
function ventanaMeses(desde, hasta, hoy) {
  const ini = `${desde.slice(0, 7)}-01`;
  const fin0 = finDeMes(hasta);
  const fin = fin0 < hoy ? fin0 : hoy;
  return ini > fin ? null : { desde: ini, hasta: fin };
}
// Un renglón por cliente, proveedor y mes con sus consultas (y las de HOY, para saber si el exceso del mes sigue creciendo hoy).
const CTE_MES = `m AS (
      SELECT c.idCliente, ${PROV} AS proveedor, ${MES} AS mes, COUNT(*) AS intentos,
        SUM(CASE WHEN c.idEstado = 4 THEN 1 ELSE 0 END) AS exitosos,
        SUM(CASE WHEN c.idEstado = 5 THEN 1 ELSE 0 END) AS fallidos,
        SUM(CASE WHEN CAST(c.FechaCreo AS date) = CONVERT(date, @hoy, 112) THEN 1 ELSE 0 END) AS intentosHoy,
        COUNT(DISTINCT CAST(c.FechaCreo AS date)) AS diasActivo,
        MIN(c.FechaCreo) AS primerIntento, MAX(c.FechaCreo) AS ultimoIntento
      FROM dbo.CASO c WHERE c.FechaCreo >= CONVERT(date, @mdesde, 112) AND c.FechaCreo < CONVERT(date, @mhasta, 112)
      GROUP BY c.idCliente, ${PROV}, ${MES})`;
const paramsMes = (vm, hoy) => [
  { nombre: 'mdesde', tipo: 'varchar', valor: aYmd(vm.desde) },
  { nombre: 'mhasta', tipo: 'varchar', valor: aYmd(sumarDias(vm.hasta, 1)) },
  { nombre: 'hoy', tipo: 'varchar', valor: aYmd(hoy) },
];
const paramsRango = (desde, hastaIncl) => [
  { nombre: 'desde', tipo: 'varchar', valor: aYmd(desde) },
  { nombre: 'hasta', tipo: 'varchar', valor: aYmd(sumarDias(hastaIncl, 1)) },
];

/** Cada consulta: { clave, sql, parametros }. */
function consultasDe(desde, hasta, lim, hoy) {
  const p = paramsRango(desde, hasta);
  const pLim = paramsLimiteDia(lim);
  const LD = LIM_DIA('x');
  const vm = ventanaMeses(desde, hasta, hoy);
  const pMes = vm ? [...paramsMes(vm, hoy), ...paramsLimiteMes(lim)] : [];
  const LM = LIM_MES('m');
  const topN = Math.max(1, Math.min(TOP_CLIENTES, 200));
  // Un renglón por consulta (CASO) con el momento del primer éxito del cliente en el día con ese proveedor (para los reusos «después de un éxito»).
  const ctes = `b AS (
      SELECT c.id AS idCaso, c.idCliente, ${PROV} AS proveedor, ${DIA} AS dia, c.idCanal, c.idEstado, c.FechaCreo,
             MIN(CASE WHEN c.idEstado = 4 THEN c.FechaCreo END) OVER (PARTITION BY c.idCliente, ${PROV}, ${DIA}) AS primerExito
      FROM dbo.CASO c WHERE ${RANGO}),
    x AS (
      SELECT idCliente, proveedor, dia, COUNT(*) AS intentos,
        SUM(CASE WHEN idEstado = 4 THEN 1 ELSE 0 END) AS exitosos,
        SUM(CASE WHEN idEstado = 5 THEN 1 ELSE 0 END) AS fallidos,
        SUM(CASE WHEN idEstado = 3 THEN 1 ELSE 0 END) AS reintentos,
        SUM(CASE WHEN idCanal = 1 THEN 1 ELSE 0 END) AS viaApp,
        SUM(CASE WHEN idCanal = 0 THEN 1 ELSE 0 END) AS viaWhoisWho,
        MIN(idCaso) AS primerCaso, MAX(idCaso) AS ultimoCaso,
        SUM(CASE WHEN primerExito IS NOT NULL AND FechaCreo > primerExito THEN 1 ELSE 0 END) AS despuesExito,
        MIN(FechaCreo) AS primerIntento, MAX(FechaCreo) AS ultimoIntento
      FROM b GROUP BY idCliente, proveedor, dia)`;
  return {
    resumen: {
      sql: `SELECT ${PROV} AS proveedor, ${CONTEOS} FROM dbo.CASO c WHERE ${RANGO} GROUP BY ${PROV}`,
      parametros: p,
    },
    reglas: {
      sql: `SELECT ${PROV} AS proveedor, c.idCanal AS canal, c.idRegla AS regla, ${CONTEOS} FROM dbo.CASO c WHERE ${RANGO} GROUP BY ${PROV}, c.idCanal, c.idRegla`,
      parametros: p,
    },
    diaria: {
      sql: `SELECT ${DIA} AS dia, ${PROV} AS proveedor, ${CONTEOS} FROM dbo.CASO c WHERE ${RANGO} GROUP BY ${DIA}, ${PROV} ORDER BY ${DIA}`,
      parametros: p,
    },
    horas: {
      sql: `SELECT DATEPART(HOUR, c.FechaCreo) AS hora, ${PROV} AS proveedor, COUNT(*) AS total,
              SUM(CASE WHEN c.idEstado = 3 THEN 1 ELSE 0 END) AS reintentos,
              SUM(CASE WHEN c.idEstado = 5 THEN 1 ELSE 0 END) AS fallidos
            FROM dbo.CASO c WHERE ${RANGO} GROUP BY DATEPART(HOUR, c.FechaCreo), ${PROV}`,
      parametros: p,
    },
    // Clientes por encima (y justo en) el límite DIARIO de su proveedor. Sin límite configurado no se evalúa.
    exceso: hayLimite(lim, 'dia') ? {
      sql: `WITH ${ctes}
            SELECT x.dia, x.proveedor,
              SUM(CASE WHEN x.intentos > ${LD} THEN 1 ELSE 0 END) AS clientesExceden,
              SUM(CASE WHEN x.intentos > ${LD} THEN x.intentos - ${LD} ELSE 0 END) AS excedente,
              MAX(CASE WHEN x.intentos > ${LD} THEN x.intentos END) AS maxIntentos,
              SUM(CASE WHEN x.intentos = ${LD} THEN 1 ELSE 0 END) AS clientesAlLimite
            FROM x WHERE ${LD} > 0 AND x.intentos >= ${LD} GROUP BY x.dia, x.proveedor`,
      parametros: [...p, ...pLim],
    } : null,
    // Consumo por cliente en el MES calendario: resumen por mes y proveedor, y los clientes que llegaron o pasaron el límite mensual.
    mensualResumen: vm && hayLimite(lim, 'mes') ? {
      sql: `WITH ${CTE_MES}
            SELECT m.mes, m.proveedor, COUNT(*) AS clientesMes, SUM(m.intentos) AS casos,
              SUM(CASE WHEN ${LM} > 0 AND m.intentos > ${LM} THEN 1 ELSE 0 END) AS clientesExceden,
              SUM(CASE WHEN ${LM} > 0 AND m.intentos > ${LM} THEN m.intentos - ${LM} ELSE 0 END) AS excedente,
              SUM(CASE WHEN ${LM} > 0 AND m.intentos > ${LM} AND m.intentosHoy > 0 THEN 1 ELSE 0 END) AS excedenHoy,
              SUM(CASE WHEN ${LM} > 0 AND m.intentos = ${LM} THEN 1 ELSE 0 END) AS clientesAlLimite,
              MAX(CASE WHEN ${LM} > 0 AND m.intentos > ${LM} THEN m.intentos END) AS maxIntentos
            FROM m GROUP BY m.mes, m.proveedor`,
      parametros: pMes,
    } : null,
    mensualClientes: vm && hayLimite(lim, 'mes') ? {
      sql: `WITH ${CTE_MES}
            SELECT TOP ${Math.min(TOP_CLIENTES * 2, 200)} m.idCliente, m.proveedor, m.mes, m.intentos, m.exitosos, m.fallidos, m.intentosHoy, m.diasActivo, m.primerIntento, m.ultimoIntento,
                   cl.numeroDocumento AS documento, cl.nombre AS nombre
            FROM m LEFT JOIN dbo.CLIENTE cl ON cl.id = m.idCliente
            WHERE ${LM} > 0 AND m.intentos >= ${LM}
            ORDER BY m.intentos DESC, m.mes DESC, m.idCliente`,
      parametros: pMes,
    } : null,
    // REUSO por día y proveedor: consultas − 1 por cada cliente (ver cabecera del archivo).
    reusos: {
      sql: `WITH ${ctes}
            SELECT x.dia, x.proveedor, COUNT(*) AS clientesDia, SUM(x.intentos) AS casos,
              SUM(CASE WHEN x.intentos > 1 THEN 1 ELSE 0 END) AS clientesReusan,
              SUM(x.intentos - 1) AS reusos, SUM(x.despuesExito) AS despuesExito,
              SUM(CASE WHEN ${LD} > 0 AND x.intentos > ${LD} THEN x.intentos - ${LD} ELSE 0 END) AS sobreLimite
            FROM x GROUP BY x.dia, x.proveedor`,
      parametros: [...p, ...pLim],
    },
    clientes: {
      sql: `WITH ${ctes}
            SELECT TOP ${topN} x.idCliente, x.proveedor, x.dia, x.intentos, x.exitosos, x.fallidos, x.reintentos, x.viaApp, x.viaWhoisWho, x.primerCaso, x.ultimoCaso, x.despuesExito, x.primerIntento, x.ultimoIntento,
                   cl.numeroDocumento AS documento, cl.nombre AS nombre
            FROM x LEFT JOIN dbo.CLIENTE cl ON cl.id = x.idCliente
            WHERE x.intentos >= 2
            ORDER BY x.intentos DESC, x.dia DESC, x.idCliente`,
      parametros: p,
    },
    proveedoresReg: {
      sql: `SELECT ${DIA} AS dia, ISNULL(pr.nombreProveedor, 'Sin proveedor') AS proveedor, COUNT(*) AS consultas,
              COUNT(DISTINCT c.idCliente) AS clientes
            FROM dbo.CASO c
            JOIN dbo.CAPTURA ca ON ca.idCaso = c.id
            JOIN dbo.RESULTADO r ON r.idCaptura = ca.id
            LEFT JOIN dbo.PROVEEDOR pr ON pr.id = r.IdProveedor
            WHERE ${RANGO}
            GROUP BY ${DIA}, ISNULL(pr.nombreProveedor, 'Sin proveedor')`,
      parametros: p,
    },
    resultados: {
      sql: `SELECT TOP ${TOP_RESULTADOS} ISNULL(pr.nombreProveedor, 'Sin proveedor') AS proveedor, ${PROV} AS origen,
              r.codigoResultado AS codigo, r.descripcionResultado AS descripcion, COUNT(*) AS total
            FROM dbo.CASO c
            JOIN dbo.CAPTURA ca ON ca.idCaso = c.id
            JOIN dbo.RESULTADO r ON r.idCaptura = ca.id
            LEFT JOIN dbo.PROVEEDOR pr ON pr.id = r.IdProveedor
            WHERE ${RANGO}
            GROUP BY ISNULL(pr.nombreProveedor, 'Sin proveedor'), ${PROV}, r.codigoResultado, r.descripcionResultado
            ORDER BY COUNT(*) DESC`,
      parametros: p,
    },
  };
}

/**
 * Todos los clientes que en `fecha` superaron el límite DIARIO de su proveedor (para la alerta; sin tope de 50 como el tablero).
 * `lim` debe traer solo los proveedores que generan alerta (los demás van con límite 0 = no se evalúan).
 */
function consultaExcedidos(fecha, lim) {
  const p = paramsRango(fecha, fecha);
  const LD = LIM_DIA('x');
  return {
    sql: `WITH x AS (
            SELECT c.idCliente, ${PROV} AS proveedor, COUNT(*) AS intentos,
              SUM(CASE WHEN c.idCanal = 1 THEN 1 ELSE 0 END) AS viaApp,
              SUM(CASE WHEN c.idEstado = 3 THEN 1 ELSE 0 END) AS reintentos,
              MAX(c.FechaCreo) AS ultimoIntento
            FROM dbo.CASO c WHERE ${RANGO}
            GROUP BY c.idCliente, ${PROV})
          SELECT TOP 500 x.idCliente, x.proveedor, x.intentos, x.viaApp, x.reintentos, x.ultimoIntento,
                 cl.numeroDocumento AS documento, cl.nombre AS nombre
          FROM x LEFT JOIN dbo.CLIENTE cl ON cl.id = x.idCliente
          WHERE ${LD} > 0 AND x.intentos > ${LD}
          ORDER BY x.intentos DESC, x.idCliente`,
    parametros: [...p, ...paramsLimiteDia(lim)],
  };
}

/** Clientes que en el mes de `fecha` superaron el límite MENSUAL de su proveedor y siguieron consultando HOY (el exceso sigue creciendo). */
function consultaExcedidosMes(fecha, lim) {
  const vm = { desde: `${fecha.slice(0, 7)}-01`, hasta: fecha };
  const LM = LIM_MES('m');
  return {
    sql: `WITH ${CTE_MES}
          SELECT TOP 500 m.idCliente, m.proveedor, m.intentos, m.intentosHoy, m.ultimoIntento,
                 cl.numeroDocumento AS documento, cl.nombre AS nombre
          FROM m LEFT JOIN dbo.CLIENTE cl ON cl.id = m.idCliente
          WHERE ${LM} > 0 AND m.intentos > ${LM} AND m.intentosHoy > 0
          ORDER BY m.intentos DESC, m.idCliente`,
    parametros: [...paramsMes(vm, fecha), ...paramsLimiteMes(lim)],
  };
}

/** Solo los proveedores que generan alerta (los demás se monitorean pero no avisan). */
const limitesAvisables = (lim) => Object.fromEntries(Object.entries(lim || {}).map(([p, l]) => [p, l && l.avisar ? l : { dia: null, mes: null, avisar: false }]));

/** Clientes sobre el límite diario (tipo «dia») y sobre el mensual con consultas hoy (tipo «mes»), solo de los proveedores con alerta. */
async function excedidosDelDia(fecha, lim) {
  const av = limitesAvisables(lim);
  const salida = [];
  if (hayLimite(av, 'dia')) {
    const q = consultaExcedidos(fecha, av);
    const filas = await cfg.consultar(q.sql, q.parametros);
    for (const f of filas) {
      const limite = limDe(av, f.proveedor, 'dia');
      salida.push({
        tipo: 'dia', limite, idCliente: f.idCliente, proveedor: f.proveedor, documento: aTexto(f.documento), nombre: aTexto(f.nombre),
        intentos: n(f.intentos), viaApp: n(f.viaApp), reintentos: n(f.reintentos), ultimoIntento: aIso(f.ultimoIntento), exceso: Math.max(0, n(f.intentos) - limite),
      });
    }
  }
  if (hayLimite(av, 'mes')) {
    const q = consultaExcedidosMes(fecha, av);
    const filas = await cfg.consultar(q.sql, q.parametros);
    for (const f of filas) {
      const limite = limDe(av, f.proveedor, 'mes');
      salida.push({
        tipo: 'mes', limite, idCliente: f.idCliente, proveedor: f.proveedor, documento: aTexto(f.documento), nombre: aTexto(f.nombre),
        intentos: n(f.intentos), viaApp: 0, reintentos: 0, ultimoIntento: aIso(f.ultimoIntento), exceso: Math.max(0, n(f.intentos) - limite), intentosHoy: n(f.intentosHoy),
      });
    }
  }
  return salida;
}

/** Consulta de un periodo corto (solo conteos por proveedor): comparación y mes en curso. */
function consultaConteos(desde, hasta) {
  return {
    sql: `SELECT ${PROV} AS proveedor, ${CONTEOS} FROM dbo.CASO c WHERE ${RANGO} GROUP BY ${PROV}`,
    parametros: paramsRango(desde, hasta),
  };
}

/** Casos por día y proveedor de un periodo corto (el mes en curso): sirve para proyectar el mes separando días hábiles y no hábiles. */
function consultaPorDia(desde, hasta) {
  return {
    sql: `SELECT ${PROV} AS proveedor, ${DIA} AS dia, COUNT(*) AS total FROM dbo.CASO c WHERE ${RANGO} GROUP BY ${PROV}, ${DIA}`,
    parametros: paramsRango(desde, hasta),
  };
}

/**
 * Festivos y demás días no hábiles (tabla DIASNOHABILES: Año, Mes, Dia). Es una tabla pequeña: se lee completa y las columnas se buscan
 * por nombre sin importar tildes (Dia / Día, Año / Ano), así que un nombre distinto no rompe el tablero.
 */
function consultaNoHabiles() {
  return { sql: 'SELECT TOP 5000 * FROM dbo.DIASNOHABILES', parametros: [] };
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------
async function paralelo(tareas, limite) {
  const res = new Array(tareas.length);
  let i = 0;
  async function trabajador() {
    while (i < tareas.length) {
      const k = i; i += 1;
      res[k] = await tareas[k]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, tareas.length) }, trabajador));
  return res;
}

const cacheCrudo = new Map(); // clave -> { expira, datos }

async function ejecutarSeccion(nombre, q, etapas) {
  if (!q) return { nombre, ok: true, filas: [] };
  const t0 = Date.now();
  try {
    const filas = await cfg.consultar(q.sql, q.parametros);
    etapas.push({ etapa: nombre, ms: Date.now() - t0 });
    return { nombre, ok: true, filas };
  } catch (error) {
    etapas.push({ etapa: nombre, ms: Date.now() - t0, error: true });
    return { nombre, ok: false, error };
  }
}

/** Trae (o reutiliza 60 s) todos los datos crudos del rango. Si falla la conexión lanza el error; si falla una sección sola, la deja con aviso. */
async function traerCrudo(rango, lim, { forzar = false } = {}) {
  const clave = `${rango.desde}|${rango.hasta}|${JSON.stringify(lim)}`;
  const previa = cacheCrudo.get(clave);
  if (!forzar && previa && previa.expira > Date.now()) return { ...previa.datos, deCache: true };

  const etapas = [];
  const hoy = hoyIso();
  const mesIni = `${hoy.slice(0, 7)}-01`;
  const prevHasta = sumarDias(rango.desde, -1);
  const prevDesde = sumarDias(rango.desde, -rango.dias);
  const qs = consultasDe(rango.desde, rango.hasta, lim, hoy);

  // La primera consulta decide si hay conexión: si falla, el error es de TODO el tablero.
  const primera = await ejecutarSeccion('resumen', qs.resumen, etapas);
  if (!primera.ok) throw primera.error;

  const resto = [
    ['reglas', qs.reglas], ['diaria', qs.diaria], ['horas', qs.horas], ['exceso', qs.exceso], ['mensualResumen', qs.mensualResumen], ['mensualClientes', qs.mensualClientes], ['reusos', qs.reusos], ['clientes', qs.clientes],
    ['proveedoresReg', qs.proveedoresReg], ['resultados', qs.resultados],
    ['previo', consultaConteos(prevDesde, prevHasta)], ['mesActual', consultaConteos(mesIni, hoy)], ['mesDia', consultaPorDia(mesIni, hoy)],
    ['noHabiles', consultaNoHabiles(Number(prevDesde.slice(0, 4)), Math.max(Number(rango.hasta.slice(0, 4)), Number(hoy.slice(0, 4))))],
    ['estados', { sql: 'SELECT id, estado FROM dbo.ESTADO', parametros: [] }],
  ];
  const cat = await catalogo.obtener({ forzar });
  const salidas = await paralelo(resto.map(([n, q]) => () => ejecutarSeccion(n, q, etapas)), 3);

  const datos = { resumen: primera.filas, avisos: [...cat.avisos], catalogo: cat, etapas, prevDesde, prevHasta, mesIni, hoy };
  for (const s of salidas) {
    if (s.ok) datos[s.nombre] = s.filas;
    else { datos[s.nombre] = []; datos.avisos.push({ seccion: s.nombre, error: cfg.mensajeError(s.error) }); }
  }
  cacheCrudo.set(clave, { expira: Date.now() + TTL_CACHE_MS, datos });
  if (cacheCrudo.size > 20) cacheCrudo.delete(cacheCrudo.keys().next().value);
  return datos;
}

// ---------------------------------------------------------------------------
// Armado del resultado
// ---------------------------------------------------------------------------
const n = (v) => Number(v) || 0;
const vacioConteos = () => ({ total: 0, exitosos: 0, fallidos: 0, reintentos: 0, pendientes: 0, enProceso: 0, fueraLinea: 0, reintentosAcum: 0, clientes: 0 });
function conteosDe(fila) {
  if (!fila) return vacioConteos();
  return {
    total: n(fila.total), exitosos: n(fila.exitosos), fallidos: n(fila.fallidos), reintentos: n(fila.reintentos), pendientes: n(fila.pendientes),
    enProceso: n(fila.enProceso), fueraLinea: n(fila.fueraLinea), reintentosAcum: n(fila.reintentosAcum), clientes: n(fila.clientes),
  };
}
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const aTexto = (v) => (v === null || v === undefined ? null : String(v).trim());
const aIso = (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : (v ? String(v) : null));
const diasDelMes = (iso) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0)).getUTCDate();

/** Calendario de días no hábiles: sábados, domingos y los festivos de DIASNOHABILES (Año, Mes, Día). */
function construirCalendario(filas) {
  const festivos = new Set();
  const valor = (f, re) => { const k = Object.keys(f).find((c) => re.test(c)); return k === undefined ? undefined : f[k]; };
  for (const f of filas || []) {
    const a = n(valor(f, /^(a[ñn]o|anio)$/i)); const m = n(valor(f, /^mes$/i)); const d = n(valor(f, /^d[ií]a$/i));
    if (a && m && d) festivos.add(`${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  const semana = (iso) => new Date(msDe(iso)).getUTCDay();
  const motivo = (iso) => (festivos.has(iso) ? 'Festivo' : semana(iso) === 0 ? 'Domingo' : semana(iso) === 6 ? 'Sábado' : null);
  return { festivos, motivo, esHabil: (iso) => motivo(iso) === null, nombreDia: (iso) => NOMBRE_DIA[semana(iso)] };
}

/** Proyección del cierre del mes: promedio de los días hábiles × los hábiles que faltan + promedio de los no hábiles × los no hábiles que faltan. */
function proyectarMes(totalesPorDia, hoy, cal) {
  const diasMes = diasDelMes(hoy);
  const transcurridos = Math.max(1, Number(hoy.slice(8, 10)));
  const mes = hoy.slice(0, 7);
  let tH = 0; let nH = 0; let tN = 0; let nN = 0; let faltanH = 0; let faltanN = 0;
  for (let d = 1; d <= diasMes; d += 1) {
    const iso = `${mes}-${String(d).padStart(2, '0')}`;
    const habil = cal.esHabil(iso);
    if (d <= transcurridos) {
      const v = totalesPorDia.get(iso) || 0;
      if (habil) { tH += v; nH += 1; } else { tN += v; nN += 1; }
    } else if (habil) faltanH += 1; else faltanN += 1;
  }
  const total = tH + tN;
  if (nH > 0 && nN > 0) return { valor: Math.round(total + (tH / nH) * faltanH + (tN / nN) * faltanN), metodo: 'hábiles / no hábiles' };
  return { valor: Math.round((total / transcurridos) * diasMes), metodo: 'calendario' };
}

/** Cupo diario/mensual y sobrecosto de un proveedor (los cupos son opcionales: sin cupo no se evalúa). */
function evaluarCupo(prov, cupo, diariaProv, mesActual, hoy, proy) {
  const r = { dia: cupo.dia, mes: cupo.mes, valor: cupo.valor, diasExcedidos: [], excesoDia: 0, mesActual: null, excesoMes: 0, sobrecostoDia: null, sobrecostoMes: null };
  if (cupo.dia !== null) {
    for (const d of diariaProv) {
      if (d.total > cupo.dia) { r.diasExcedidos.push({ fecha: d.fecha, total: d.total, exceso: d.total - cupo.dia }); r.excesoDia += d.total - cupo.dia; }
    }
  }
  const totalMes = n(mesActual?.total);
  const transcurridos = Math.max(1, Number(hoy.slice(8, 10)));
  r.mesActual = {
    periodo: hoy.slice(0, 7), total: totalMes, clientes: n(mesActual?.clientes),
    proyeccion: proy ? proy.valor : Math.round((totalMes / transcurridos) * diasDelMes(hoy)),
    metodoProyeccion: proy ? proy.metodo : 'calendario',
    pct: cupo.mes ? pct(totalMes, cupo.mes) : null,
  };
  if (cupo.mes !== null) r.excesoMes = Math.max(0, totalMes - cupo.mes);
  if (cupo.valor !== null) {
    if (cupo.dia !== null) r.sobrecostoDia = Math.round(r.excesoDia * cupo.valor * 100) / 100;
    if (cupo.mes !== null) r.sobrecostoMes = Math.round(r.excesoMes * cupo.valor * 100) / 100;
  }
  return r;
}

/**
 * Estado de los límites por cliente de un proveedor: día y mes, cuántos clientes los superaron, cuántas consultas de más y el sobrecosto
 * estimado (solo si hay valor por consulta). Un proveedor sin límite (ASISA) queda en modo solo monitoreo.
 */
function limiteProveedor(prov, l, cupo, exc, meses, mesHoy, alLimiteHoy) {
  const valor = cupo && cupo.valor !== null && cupo.valor !== undefined ? cupo.valor : null;
  const actual = meses.find((m) => m.mes === mesHoy) || null;
  const clientesExcedenMes = meses.reduce((a, m) => a + m.clientesExceden, 0);
  const excesoMes = meses.reduce((a, m) => a + m.excedente, 0);
  const costo = (consultas) => (valor !== null ? Math.round(consultas * valor * 100) / 100 : null);
  return {
    dia: l.dia, mes: l.mes, avisar: !!l.avisar, soloMonitoreo: !l.avisar,
    clientesExcedenDia: exc.clientesDia, excesoDia: exc.excedente, alLimiteHoy: n(alLimiteHoy),
    meses, mesActual: actual, clientesExcedenMes, excesoMes,
    sobrecostoDia: l.dia ? costo(exc.excedente) : null, sobrecostoMes: l.mes ? costo(excesoMes) : null,
  };
}

function armar(crudo, rango, config) {
  const lim = config.limites;
  const dias = listaDias(rango.desde, rango.hasta);
  const porProv = (filas) => Object.fromEntries(PROVEEDORES.map((p) => [p, conteosDe(filas.find((f) => f.proveedor === p))]));
  const actual = porProv(crudo.resumen);
  const previo = porProv(crudo.previo || []);
  const mesAct = porProv(crudo.mesActual || []);

  const cal = construirCalendario(crudo.noHabiles);
  const sinFestivos = !(crudo.noHabiles || []).length;
  const mesDiaPorProv = Object.fromEntries(PROVEEDORES.map((p) => [p, new Map()]));
  for (const f of crudo.mesDia || []) if (mesDiaPorProv[f.proveedor]) mesDiaPorProv[f.proveedor].set(aTexto(f.dia), n(f.total));

  // Diaria completa (con ceros).
  const mapaDia = new Map();
  for (const f of crudo.diaria || []) mapaDia.set(`${f.dia}|${f.proveedor}`, conteosDe(f));
  const exMapa = new Map();
  for (const f of crudo.exceso || []) exMapa.set(`${f.dia}|${f.proveedor}`, { clientesExceden: n(f.clientesExceden), excedente: n(f.excedente), maxIntentos: n(f.maxIntentos), clientesAlLimite: n(f.clientesAlLimite) });
  const diaria = dias.map((fecha) => {
    const fila = { fecha, habil: cal.esHabil(fecha), motivoNoHabil: cal.motivo(fecha), diaSemana: cal.nombreDia(fecha) };
    for (const p of PROVEEDORES) fila[p] = { ...(mapaDia.get(`${fecha}|${p}`) || vacioConteos()), ...(exMapa.get(`${fecha}|${p}`) || { clientesExceden: 0, excedente: 0, maxIntentos: 0, clientesAlLimite: 0 }) };
    return fila;
  });

  // Reuso (consultas − 1 por cliente, proveedor y día) y su separación en «después de un éxito» y «sobre el límite».
  const reusoProv = Object.fromEntries(PROVEEDORES.map((p) => [p, { clientesDia: 0, clientesReusan: 0, reusos: 0, despuesExito: 0, sobreLimite: 0, casos: 0 }]));
  const reusoDia = new Map();
  for (const f of crudo.reusos || []) {
    const acc = reusoProv[f.proveedor];
    if (!acc) continue;
    acc.clientesDia += n(f.clientesDia); acc.clientesReusan += n(f.clientesReusan); acc.reusos += n(f.reusos);
    acc.despuesExito += n(f.despuesExito); acc.sobreLimite += n(f.sobreLimite); acc.casos += n(f.casos);
    reusoDia.set(`${f.dia}|${f.proveedor}`, { reusos: n(f.reusos), despuesExito: n(f.despuesExito) });
  }
  for (const d of diaria) for (const p of PROVEEDORES) Object.assign(d[p], reusoDia.get(`${d.fecha}|${p}`) || { reusos: 0, despuesExito: 0 });

  // Límite MENSUAL por cliente: resumen por mes calendario y proveedor.
  const mensualProv = Object.fromEntries(PROVEEDORES.map((p) => [p, []]));
  for (const f of crudo.mensualResumen || []) {
    if (!mensualProv[f.proveedor]) continue;
    mensualProv[f.proveedor].push({
      mes: aTexto(f.mes), clientes: n(f.clientesMes), casos: n(f.casos), clientesExceden: n(f.clientesExceden), excedente: n(f.excedente),
      excedenHoy: n(f.excedenHoy), clientesAlLimite: n(f.clientesAlLimite), maxIntentos: n(f.maxIntentos),
    });
  }
  for (const p of PROVEEDORES) mensualProv[p].sort((a, b) => (a.mes < b.mes ? 1 : -1));
  const mesHoy = String(crudo.hoy).slice(0, 7);
  const diaHoy = diaria.find((d) => d.fecha === crudo.hoy);

  const diasHabiles = diaria.filter((d) => d.habil).length;
  const diasNoHabiles = diaria.length - diasHabiles;
  const proveedores = PROVEEDORES.map((p) => {
    const c = actual[p];
    const ru = reusoProv[p];
    const sumaTipo = (habil) => diaria.filter((d) => d.habil === habil).reduce((a, d) => a + d[p].total, 0);
    const casosH = sumaTipo(true); const casosN = sumaTipo(false);
    const serie = diaria.map((d) => ({ fecha: d.fecha, total: d[p].total }));
    const pico = serie.reduce((m, d) => (d.total > m.total ? d : m), { fecha: null, total: 0 });
    const exc = diaria.reduce((a, d) => ({ clientesDia: a.clientesDia + d[p].clientesExceden, excedente: a.excedente + d[p].excedente }), { clientesDia: 0, excedente: 0 });
    return {
      proveedor: p, ...c,
      tasaExito: pct(c.exitosos, c.total), tasaFallo: pct(c.fallidos, c.total), tasaReintento: pct(c.reintentos, c.total),
      promedioDiario: dias.length ? Math.round((c.total / dias.length) * 10) / 10 : 0,
      pico, hoy: n(diaria.find((d) => d.fecha === crudo.hoy)?.[p]?.total),
      excesoClientesDia: exc.clientesDia, excesoConsultas: exc.excedente,
      limite: limiteProveedor(p, lim[p], config.cupos[p], exc, mensualProv[p], mesHoy, diaHoy ? diaHoy[p].clientesAlLimite : 0),
      previo: previo[p],
      reuso: {
        ...ru, tasa: pct(ru.reusos, c.total), tasaClientes: pct(ru.clientesReusan, ru.clientesDia),
        evitables: ru.despuesExito, tasaEvitables: pct(ru.despuesExito, c.total),
        consultasPorClienteDia: ru.clientesDia ? Math.round((ru.casos / ru.clientesDia) * 100) / 100 : 0,
      },
      habiles: { dias: diasHabiles, casos: casosH, promedio: diasHabiles ? Math.round((casosH / diasHabiles) * 10) / 10 : 0 },
      noHabiles: { dias: diasNoHabiles, casos: casosN, promedio: diasNoHabiles ? Math.round((casosN / diasNoHabiles) * 10) / 10 : 0 },
      cupo: evaluarCupo(p, config.cupos[p], serie, mesAct[p], crudo.hoy, proyectarMes(mesDiaPorProv[p], crudo.hoy, cal)),
    };
  });

  const catReglas = new Map((crudo.catalogo?.reglas || []).map((r) => [r.id, r]));
  const origenes = (crudo.reglas || []).map((f) => {
    const info = catReglas.get(n(f.regla));
    return {
      proveedor: f.proveedor, canal: n(f.canal), canalNombre: nombreCanal(n(f.canal)), regla: n(f.regla),
      etiqueta: ETIQUETA_ORIGEN[`${f.proveedor}|${n(f.canal)}|${n(f.regla)}`] || `${f.proveedor} · regla ${n(f.regla)} (${nombreCanal(n(f.canal))})`,
      descripcionRegla: info?.descripcion ?? null, transaccion: info?.transaccion ?? null, consultaA: info ? info.consulta.map((c) => c.proveedor).filter(Boolean).join(' + ') || null : null, ...conteosDe(f),
    };
  }).sort((a, b) => b.total - a.total);
  // Catálogo de reglas con el uso que tuvieron en el rango (para entender a quién consulta cada regla y con qué límites).
  const usoRegla = new Map();
  for (const o of origenes) { const u = usoRegla.get(o.regla) || { casos: 0, clientes: 0, porCanal: {} }; u.casos += o.total; u.clientes = Math.max(u.clientes, o.clientes); u.porCanal[o.canal] = (u.porCanal[o.canal] || 0) + o.total; usoRegla.set(o.regla, u); }
  const reglas = (crudo.catalogo?.reglas || []).map((r) => ({ ...r, uso: usoRegla.get(r.id) || { casos: 0, clientes: 0, porCanal: {} } }));
  for (const [id, u] of usoRegla) if (!catReglas.has(id)) reglas.push({ id, idProductoSubProducto: null, descripcion: null, idTransaccion: null, topico: null, transaccion: null, producto: null, subproducto: null, intentosDia: null, intentosMes: null, vigencia: null, validacion: null, consulta: [], capturas: [], clasificacion: catalogo.clasificacionDe(id), coincide: null, uso: u, sinCatalogo: true });
  reglas.sort((a, b) => a.id - b.id);

  const horas = Array.from({ length: 24 }, (_, hora) => {
    const fila = { hora };
    for (const p of PROVEEDORES) {
      const f = (crudo.horas || []).find((x) => n(x.hora) === hora && x.proveedor === p);
      fila[p] = { total: n(f?.total), reintentos: n(f?.reintentos), fallidos: n(f?.fallidos) };
    }
    return fila;
  });

  const topClientes = (crudo.clientes || []).map((f) => ({
    idCliente: f.idCliente, documento: aTexto(f.documento), nombre: aTexto(f.nombre), proveedor: f.proveedor, fecha: aTexto(f.dia),
    intentos: n(f.intentos), exitosos: n(f.exitosos), fallidos: n(f.fallidos), reintentos: n(f.reintentos), viaApp: n(f.viaApp), viaWhoisWho: n(f.viaWhoisWho),
    primerCaso: n(f.primerCaso) || null, ultimoCaso: n(f.ultimoCaso) || null,
    primerIntento: aIso(f.primerIntento), ultimoIntento: aIso(f.ultimoIntento),
    reusos: Math.max(0, n(f.intentos) - 1), despuesExito: n(f.despuesExito),
    habil: cal.esHabil(aTexto(f.dia)), motivoNoHabil: cal.motivo(aTexto(f.dia)),
    exceso: limDe(lim, f.proveedor, 'dia') > 0 ? Math.max(0, n(f.intentos) - limDe(lim, f.proveedor, 'dia')) : 0,
  }));

  // Clientes que llegaron o pasaron el límite del MES (los de mayor consumo primero).
  const clientesMes = (crudo.mensualClientes || []).map((f) => {
    const limite = limDe(lim, f.proveedor, 'mes');
    return {
      idCliente: f.idCliente, documento: aTexto(f.documento), nombre: aTexto(f.nombre), proveedor: f.proveedor, mes: aTexto(f.mes), limite,
      intentos: n(f.intentos), exitosos: n(f.exitosos), fallidos: n(f.fallidos), intentosHoy: n(f.intentosHoy), diasActivo: n(f.diasActivo),
      primerIntento: aIso(f.primerIntento), ultimoIntento: aIso(f.ultimoIntento), exceso: Math.max(0, n(f.intentos) - limite), alLimite: n(f.intentos) === limite,
    };
  });

  const proveedoresReg = (() => {
    const mapa = new Map();
    for (const f of crudo.proveedoresReg || []) {
      const nombre = aTexto(f.proveedor) || 'Sin proveedor';
      const x = mapa.get(nombre) || { proveedor: nombre, consultas: 0, porDia: {} };
      x.consultas += n(f.consultas);
      x.porDia[f.dia] = (x.porDia[f.dia] || 0) + n(f.consultas);
      mapa.set(nombre, x);
    }
    return [...mapa.values()].sort((a, b) => b.consultas - a.consultas).map((x) => ({
      proveedor: x.proveedor, consultas: x.consultas,
      promedioDiario: dias.length ? Math.round((x.consultas / dias.length) * 10) / 10 : 0,
      serie: dias.map((d) => x.porDia[d] || 0),
    }));
  })();

  const resultados = (crudo.resultados || []).map((f) => ({
    proveedor: aTexto(f.proveedor), origen: f.origen, codigo: aTexto(f.codigo), descripcion: aTexto(f.descripcion), total: n(f.total),
  }));

  const estados = Object.fromEntries((crudo.estados || []).map((e) => [String(e.id), aTexto(e.estado)]));

  const total = proveedores.reduce((a, p) => a + p.total, 0);
  const totalPrevio = proveedores.reduce((a, p) => a + p.previo.total, 0);
  const resumenGeneral = {
    total, previo: totalPrevio,
    reintentos: proveedores.reduce((a, p) => a + p.reintentos, 0),
    reintentosAcum: proveedores.reduce((a, p) => a + p.reintentosAcum, 0),
    exitosos: proveedores.reduce((a, p) => a + p.exitosos, 0),
    fallidos: proveedores.reduce((a, p) => a + p.fallidos, 0),
    excesoClientesDia: proveedores.reduce((a, p) => a + p.excesoClientesDia, 0),
    excesoConsultas: proveedores.reduce((a, p) => a + p.excesoConsultas, 0),
    excesoClientesMes: proveedores.reduce((a, p) => a + p.limite.clientesExcedenMes, 0),
    excesoConsultasMes: proveedores.reduce((a, p) => a + p.limite.excesoMes, 0),
    reusos: proveedores.reduce((a, p) => a + p.reuso.reusos, 0),
    reusosEvitables: proveedores.reduce((a, p) => a + p.reuso.despuesExito, 0),
    clientesReusan: proveedores.reduce((a, p) => a + p.reuso.clientesReusan, 0),
    clientesDia: proveedores.reduce((a, p) => a + p.reuso.clientesDia, 0),
    tasaReuso: pct(proveedores.reduce((a, p) => a + p.reuso.reusos, 0), total),
    casosHabiles: proveedores.reduce((a, p) => a + p.habiles.casos, 0),
    casosNoHabiles: proveedores.reduce((a, p) => a + p.noHabiles.casos, 0),
  };

  return {
    filtro: { desde: rango.desde, hasta: rango.hasta, dias: rango.dias, comparadoCon: { desde: crudo.prevDesde, hasta: crudo.prevHasta } },
    hoy: crudo.hoy, umbrales: { limites: lim, cupos: config.cupos }, estados,
    general: resumenGeneral, proveedores, origenes, reglas, diaria, horas, topClientes, clientesMes, proveedoresReg, resultados,
    calendario: {
      fuente: sinFestivos ? 'Fines de semana (DIASNOHABILES sin festivos para estos años o sin acceso)' : 'Fines de semana + festivos de DIASNOHABILES',
      diasHabiles, diasNoHabiles, festivos: diaria.filter((d) => d.motivoNoHabil === 'Festivo').map((d) => d.fecha),
    },
    tiposDocumento: crudo.catalogo?.tiposDocumento || [],
    hallazgos: hallazgos(proveedores, resumenGeneral, horas, reglas),
    avisos: crudo.avisos, etapas: crudo.etapas, deCache: !!crudo.deCache,
  };
}

function hallazgos(proveedores, general, horas, reglas = []) {
  const h = [];
  const fmt = (x) => Number(x).toLocaleString('es-CO');
  const dinero = (x) => (x !== null && x !== undefined ? ` Sobrecosto estimado: $${fmt(x)}.` : '');
  // Límites por cliente: el proveedor que genera alerta (OLIMPIA) sale como «Atención»; el que solo se monitorea (ASISA) como dato.
  for (const p of proveedores) {
    const l = p.limite;
    const nivelExceso = l.avisar ? 'alto' : 'info';
    const solo = l.avisar ? '' : ' (solo monitoreo: ASISA no tiene sobrecosto)';
    if (l.dia && l.clientesExcedenDia > 0) {
      h.push({
        nivel: nivelExceso, titulo: `${p.proveedor}: ${fmt(l.clientesExcedenDia)} cliente-día(s) superan ${fmt(l.dia)} consulta(s) por día${solo}`,
        detalle: `Son ${fmt(l.excesoDia)} consulta(s) por encima del límite diario de ${fmt(l.dia)} por cliente.${l.avisar ? ' Es lo que más probablemente genera sobrecosto.' : ''}${dinero(l.sobrecostoDia)}`,
      });
    }
    if (l.dia && l.avisar && l.alLimiteHoy > 0) {
      h.push({ nivel: 'medio', titulo: `${p.proveedor}: ${fmt(l.alLimiteHoy)} cliente(s) ya usaron sus ${fmt(l.dia)} consultas de hoy`, detalle: 'Una consulta más de estos clientes hoy ya cuenta como consulta de más.' });
    }
    if (l.mes && l.clientesExcedenMes > 0) {
      const act = l.mesActual;
      h.push({
        nivel: nivelExceso, titulo: `${p.proveedor}: ${fmt(l.clientesExcedenMes)} cliente-mes superan ${fmt(l.mes)} consulta(s) por mes${solo}`,
        detalle: `Son ${fmt(l.excesoMes)} consulta(s) por encima del límite mensual de ${fmt(l.mes)} por cliente${act && act.clientesExceden ? `; en ${act.mes} van ${fmt(act.clientesExceden)} cliente(s) (${fmt(act.excedenHoy)} de ellos siguieron consultando hoy)` : ''}.${dinero(l.sobrecostoMes)}`,
      });
    }
    if (l.mes && l.avisar && l.mesActual && l.mesActual.clientesAlLimite > 0) {
      h.push({ nivel: 'medio', titulo: `${p.proveedor}: ${fmt(l.mesActual.clientesAlLimite)} cliente(s) ya usaron sus ${fmt(l.mes)} consultas del mes`, detalle: `Corresponde a ${l.mesActual.mes}; una consulta más de estos clientes este mes ya cuenta como consulta de más.` });
    }
  }
  for (const p of proveedores) {
    const c = p.cupo;
    const nivelCupo = p.limite.avisar ? 'alto' : 'info';
    if (c.diasExcedidos.length) h.push({ nivel: nivelCupo, titulo: `${p.proveedor} superó el cupo diario (${fmt(c.dia)}) en ${c.diasExcedidos.length} día(s)`, detalle: `Exceso acumulado: ${fmt(c.excesoDia)} consulta(s).${c.sobrecostoDia !== null ? ` Sobrecosto estimado: $${fmt(c.sobrecostoDia)}.` : ''}` });
    if (c.mes !== null && c.mesActual && c.mesActual.total > c.mes) h.push({ nivel: nivelCupo, titulo: `${p.proveedor} superó el cupo mensual (${fmt(c.mes)})`, detalle: `Va ${fmt(c.mesActual.total)} en ${c.mesActual.periodo}.` });
    else if (c.mes !== null && c.mesActual && c.mesActual.proyeccion > c.mes) h.push({ nivel: p.limite.avisar ? 'medio' : 'info', titulo: `${p.proveedor} proyecta superar el cupo mensual`, detalle: `Lleva ${fmt(c.mesActual.total)} y al ritmo actual cerraría ${c.mesActual.periodo} en ~${fmt(c.mesActual.proyeccion)} (cupo ${fmt(c.mes)}).` });
    if (p.total >= 20 && p.tasaReintento >= 15) h.push({ nivel: 'medio', titulo: `${p.proveedor}: ${p.tasaReintento}% de los casos están en reintento`, detalle: `${fmt(p.reintentos)} de ${fmt(p.total)} casos. Revisa los códigos de resultado más frecuentes más abajo.` });
    if (p.previo.total > 0 && p.total > p.previo.total * 1.25 && p.total - p.previo.total >= 20) h.push({ nivel: 'info', titulo: `${p.proveedor} subió ${Math.round(((p.total - p.previo.total) / p.previo.total) * 100)}% frente al periodo anterior`, detalle: `${fmt(p.total)} casos vs ${fmt(p.previo.total)}.` });
  }
  const evitables = proveedores.filter((p) => p.reuso.despuesExito > 0);
  if (evitables.length) {
    const tot = evitables.reduce((a, p) => a + p.reuso.despuesExito, 0);
    h.push({
      nivel: tot >= 10 ? 'medio' : 'info', titulo: `${fmt(tot)} consulta(s) se repitieron después de un éxito del mismo cliente en el día`,
      detalle: `${evitables.map((p) => `${p.proveedor}: ${fmt(p.reuso.despuesExito)} (${p.reuso.tasaEvitables}% de sus casos)`).join(' · ')}. Son reusos evitables: el cliente ya estaba validado ese día.`,
    });
  }
  if (general.total > 0 && general.casosNoHabiles > 0) {
    const share = pct(general.casosNoHabiles, general.total);
    if (share >= 20) h.push({ nivel: 'info', titulo: `${share}% de los casos fueron en días no hábiles`, detalle: `${fmt(general.casosNoHabiles)} casos en sábados, domingos o festivos frente a ${fmt(general.casosHabiles)} en días hábiles.` });
  }
  const desacuerdo = reglas.filter((r) => r.coincide === false && r.uso && r.uso.casos > 0);
  if (desacuerdo.length) {
    h.push({
      nivel: 'info', titulo: `${desacuerdo.length} regla(s) con casos no coinciden con el proveedor que tienen configurado`,
      detalle: desacuerdo.map((r) => `regla ${r.id}: se cuenta como ${r.clasificacion} pero la configuración consulta a ${r.consulta.map((c) => c.proveedor).filter(Boolean).join(' + ') || '—'}`).join(' · '),
    });
  }
  const pico = horas.reduce((m, x) => { const t = x.ASISA.total + x.OLIMPIA.total; return t > m.t ? { hora: x.hora, t } : m; }, { hora: null, t: 0 });
  if (pico.hora !== null && pico.t > 0) h.push({ nivel: 'info', titulo: `Mayor concentración a las ${String(pico.hora).padStart(2, '0')}:00`, detalle: `${fmt(pico.t)} casos en esa hora dentro del rango elegido.` });
  if (!h.length) h.push({ nivel: 'info', titulo: 'Sin alertas en el rango', detalle: 'Ningún cliente supera los límites por cliente y no hay cupos superados (los cupos son opcionales: configúralos para medir el sobrecosto).' });
  return h;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
/** Tablero completo del rango. Lanza (con .codigo) si no hay conexión; las secciones sueltas que fallen quedan en `avisos`. */
async function generarTablero({ desde, hasta, forzar = false }) {
  const rango = validarRango(desde, hasta);
  if (rango.error) throw Object.assign(new Error(rango.error), { codigo: 'VALIDACION' });
  const config = await cfg.obtenerInterna();
  const t0 = Date.now();
  const crudo = await traerCrudo(rango, config.limites, { forzar });
  const salida = armar(crudo, rango, config);
  return { ...salida, generado: new Date().toISOString(), duracionMs: Date.now() - t0 };
}

module.exports = {
  generarTablero, excedidosDelDia, validarRango, hoyIso, sumarDias, evaluarCupo, limDe,
  _comun: { PROV, DIA, RANGO, paramsRango, msDe, sumarDias, construirCalendario, nombreCanal, aTexto, aIso, n, pct, RE_FECHA },
  _prueba: { consultaExcedidos, consultaExcedidosMes, ventanaMeses, limitesAvisables, consultasDe, armar, hallazgos, cacheCrudo, paralelo, ETIQUETA_ORIGEN, proyectarMes, construirCalendario },
};
