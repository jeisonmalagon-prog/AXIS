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
//   · «sobre el límite»: consultas por encima del máximo por cliente y día configurado (es lo que genera sobrecosto).
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
const paramsRango = (desde, hastaIncl) => [
  { nombre: 'desde', tipo: 'varchar', valor: aYmd(desde) },
  { nombre: 'hasta', tipo: 'varchar', valor: aYmd(sumarDias(hastaIncl, 1)) },
];

/** Cada consulta: { clave, sql, parametros }. */
function consultasDe(desde, hasta, max) {
  const p = paramsRango(desde, hasta);
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
    exceso: max > 0 ? {
      sql: `WITH ${ctes}
            SELECT dia, proveedor, COUNT(*) AS clientesExceden, SUM(intentos - @max) AS excedente, MAX(intentos) AS maxIntentos
            FROM x WHERE intentos > @max GROUP BY dia, proveedor`,
      parametros: [...p, { nombre: 'max', tipo: 'int', valor: max }],
    } : null,
    // REUSO por día y proveedor: consultas − 1 por cada cliente (ver cabecera del archivo).
    reusos: {
      sql: `WITH ${ctes}
            SELECT x.dia, x.proveedor, COUNT(*) AS clientesDia, SUM(x.intentos) AS casos,
              SUM(CASE WHEN x.intentos > 1 THEN 1 ELSE 0 END) AS clientesReusan,
              SUM(x.intentos - 1) AS reusos, SUM(x.despuesExito) AS despuesExito,
              SUM(CASE WHEN @max > 0 AND x.intentos > @max THEN x.intentos - @max ELSE 0 END) AS sobreLimite
            FROM x GROUP BY x.dia, x.proveedor`,
      parametros: [...p, { nombre: 'max', tipo: 'int', valor: max }],
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

/** Todos los clientes que en `fecha` superaron `max` consultas (para la alerta; sin tope de 50 como el tablero). */
function consultaExcedidos(fecha, max) {
  const p = paramsRango(fecha, fecha);
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
          WHERE x.intentos > @max
          ORDER BY x.intentos DESC, x.idCliente`,
    parametros: [...p, { nombre: 'max', tipo: 'int', valor: max }],
  };
}

async function excedidosDelDia(fecha, max) {
  if (!(max > 0)) return [];
  const q = consultaExcedidos(fecha, max);
  const filas = await cfg.consultar(q.sql, q.parametros);
  return filas.map((f) => ({
    idCliente: f.idCliente, proveedor: f.proveedor, documento: aTexto(f.documento), nombre: aTexto(f.nombre),
    intentos: n(f.intentos), viaApp: n(f.viaApp), reintentos: n(f.reintentos), ultimoIntento: aIso(f.ultimoIntento), exceso: Math.max(0, n(f.intentos) - max),
  }));
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
async function traerCrudo(rango, max, { forzar = false } = {}) {
  const clave = `${rango.desde}|${rango.hasta}|${max}`;
  const previa = cacheCrudo.get(clave);
  if (!forzar && previa && previa.expira > Date.now()) return { ...previa.datos, deCache: true };

  const etapas = [];
  const hoy = hoyIso();
  const mesIni = `${hoy.slice(0, 7)}-01`;
  const prevHasta = sumarDias(rango.desde, -1);
  const prevDesde = sumarDias(rango.desde, -rango.dias);
  const qs = consultasDe(rango.desde, rango.hasta, max);

  // La primera consulta decide si hay conexión: si falla, el error es de TODO el tablero.
  const primera = await ejecutarSeccion('resumen', qs.resumen, etapas);
  if (!primera.ok) throw primera.error;

  const resto = [
    ['reglas', qs.reglas], ['diaria', qs.diaria], ['horas', qs.horas], ['exceso', qs.exceso], ['reusos', qs.reusos], ['clientes', qs.clientes],
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

function armar(crudo, rango, config) {
  const max = config.maxPorCliente;
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
  for (const f of crudo.exceso || []) exMapa.set(`${f.dia}|${f.proveedor}`, { clientesExceden: n(f.clientesExceden), excedente: n(f.excedente), maxIntentos: n(f.maxIntentos) });
  const diaria = dias.map((fecha) => {
    const fila = { fecha, habil: cal.esHabil(fecha), motivoNoHabil: cal.motivo(fecha), diaSemana: cal.nombreDia(fecha) };
    for (const p of PROVEEDORES) fila[p] = { ...(mapaDia.get(`${fecha}|${p}`) || vacioConteos()), ...(exMapa.get(`${fecha}|${p}`) || { clientesExceden: 0, excedente: 0, maxIntentos: 0 }) };
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
    exceso: max > 0 ? Math.max(0, n(f.intentos) - max) : 0,
  }));

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
    hoy: crudo.hoy, umbrales: { maxPorCliente: max, cupos: config.cupos }, estados,
    general: resumenGeneral, proveedores, origenes, reglas, diaria, horas, topClientes, proveedoresReg, resultados,
    calendario: {
      fuente: sinFestivos ? 'Fines de semana (DIASNOHABILES sin festivos para estos años o sin acceso)' : 'Fines de semana + festivos de DIASNOHABILES',
      diasHabiles, diasNoHabiles, festivos: diaria.filter((d) => d.motivoNoHabil === 'Festivo').map((d) => d.fecha),
    },
    tiposDocumento: crudo.catalogo?.tiposDocumento || [],
    hallazgos: hallazgos(proveedores, resumenGeneral, horas, max, reglas),
    avisos: crudo.avisos, etapas: crudo.etapas, deCache: !!crudo.deCache,
  };
}

function hallazgos(proveedores, general, horas, max, reglas = []) {
  const h = [];
  const fmt = (x) => Number(x).toLocaleString('es-CO');
  if (max > 0 && general.excesoClientesDia > 0) {
    h.push({
      nivel: 'alto', titulo: `${fmt(general.excesoClientesDia)} caso(s) de cliente-día superan ${max} consulta(s)`,
      detalle: `Son ${fmt(general.excesoConsultas)} consulta(s) por encima del límite de ${max} por cliente y día: es lo que más probablemente genera sobrecosto.`,
    });
  }
  for (const p of proveedores) {
    const c = p.cupo;
    if (c.diasExcedidos.length) h.push({ nivel: 'alto', titulo: `${p.proveedor} superó el cupo diario (${fmt(c.dia)}) en ${c.diasExcedidos.length} día(s)`, detalle: `Exceso acumulado: ${fmt(c.excesoDia)} consulta(s).${c.sobrecostoDia !== null ? ` Sobrecosto estimado: $${fmt(c.sobrecostoDia)}.` : ''}` });
    if (c.mes !== null && c.mesActual && c.mesActual.total > c.mes) h.push({ nivel: 'alto', titulo: `${p.proveedor} superó el cupo mensual (${fmt(c.mes)})`, detalle: `Va ${fmt(c.mesActual.total)} en ${c.mesActual.periodo}.` });
    else if (c.mes !== null && c.mesActual && c.mesActual.proyeccion > c.mes) h.push({ nivel: 'medio', titulo: `${p.proveedor} proyecta superar el cupo mensual`, detalle: `Lleva ${fmt(c.mesActual.total)} y al ritmo actual cerraría ${c.mesActual.periodo} en ~${fmt(c.mesActual.proyeccion)} (cupo ${fmt(c.mes)}).` });
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
  if (!h.length) h.push({ nivel: 'info', titulo: 'Sin alertas en el rango', detalle: 'Ningún cliente supera el límite y no hay cupos superados (los cupos son opcionales: configúralos para medir el sobrecosto).' });
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
  const crudo = await traerCrudo(rango, config.maxPorCliente, { forzar });
  const salida = armar(crudo, rango, config);
  return { ...salida, generado: new Date().toISOString(), duracionMs: Date.now() - t0 };
}

module.exports = {
  generarTablero, excedidosDelDia, validarRango, hoyIso, sumarDias, evaluarCupo,
  _comun: { PROV, DIA, RANGO, paramsRango, msDe, sumarDias, construirCalendario, nombreCanal, aTexto, aIso, n, pct, RE_FECHA },
  _prueba: { consultaExcedidos, consultasDe, armar, hallazgos, cacheCrudo, paralelo, ETIQUETA_ORIGEN, proyectarMes, construirCalendario },
};
