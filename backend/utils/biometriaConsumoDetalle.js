// Detalle de un cliente en un día para «Consumo y reusos» (SOLO LECTURA sobre ORQBIOMETRIA).
//
// Cruza, para un cliente y una fecha: todos sus casos del día (CASO) con estado, canal y regla (CASO.idRegla = REGLA.id); las capturas y
// resultados de cada caso (CAPTURA → RESULTADO → PROVEEDOR, y RESULTADO → RESULTADOPROVEEDOR → HOMOLOGACION; tipo de captura → TIPOCAPTURA);
// de la REGLA: su producto/subproducto, su transacción (Enrolamiento/Login, que es un dato aparte), sus límites, a qué proveedor consulta
// y qué capturas pide (ver biometriaConsumoCatalogo.js); los contadores vigentes (INTENTO); el tipo de documento (CLIENTE → TIPODOCUMENTO);
// y su historial de los últimos 30 días y del mes.
// Cada consulta secundaria es opcional: si una falla, el detalle sale igual y la falla queda en `avisos`.

const cfg = require('./biometriaConsumoConfig');
const catalogo = require('./biometriaConsumoCatalogo');
const consumo = require('./biometriaConsumo');

const { PROV, DIA, RANGO, paramsRango, msDe, sumarDias, construirCalendario, nombreCanal, aTexto, n, pct, RE_FECHA } = consumo._comun;
const RE_CLIENTE = /^[A-Za-z0-9_-]{1,40}$/;
const PROVEEDORES = cfg.PROVEEDORES;
const DIAS_HISTORIAL = 30;

const hhmmss = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(11, 19) : null);
const aMs = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));

function validar({ idCliente, fecha, proveedor }) {
  const id = String(idCliente ?? '').trim();
  const f = String(fecha ?? '').trim();
  if (!RE_CLIENTE.test(id)) return { error: 'Falta el cliente a consultar.' };
  const ms = msDe(f);
  if (!RE_FECHA.test(f) || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== f) return { error: 'La fecha no es válida.' };
  const prov = PROVEEDORES.includes(proveedor) ? proveedor : null;
  return { idCliente: id, fecha: f, proveedor: prov };
}

async function opcional(nombre, q, avisos) {
  try {
    return await cfg.consultar(q.sql, q.parametros);
  } catch (error) {
    avisos.push({ seccion: nombre, error: cfg.mensajeError(error) });
    return [];
  }
}

/**
 * Resultados de cada caso por proveedor que respondió. Intenta traer también la homologación del código (RESULTADO.idResultadoProveedor →
 * RESULTADOPROVEEDOR.idHomologacion → HOMOLOGACIONRESULTADOPROVEEDOR: EXITOSO / FALLIDO / REINTENTAR / PENDIENTE); si esas tablas
 * no se pueden leer, repite la consulta sin ella para no perder los resultados.
 */
async function resultadosConHomologacion(pDia, avisos) {
  const base = `FROM dbo.CASO c JOIN dbo.CAPTURA ca ON ca.idCaso = c.id
            LEFT JOIN dbo.RESULTADO r ON r.idCaptura = ca.id LEFT JOIN dbo.PROVEEDOR pr ON pr.id = r.IdProveedor`;
  const donde = `WHERE c.idCliente = @cliente AND ${RANGO}`;
  try {
    return await cfg.consultar(
      `SELECT ca.idCaso AS caso, ISNULL(pr.nombreProveedor, 'Sin proveedor') AS respondio, r.codigoResultado AS codigo, r.descripcionResultado AS descripcion, h.homologacion AS homologacion, COUNT(*) AS total
       ${base}
       LEFT JOIN dbo.RESULTADOPROVEEDOR rp ON rp.id = r.idResultadoProveedor LEFT JOIN dbo.HOMOLOGACIONRESULTADOPROVEEDOR h ON h.id = rp.idHomologacion
       ${donde}
       GROUP BY ca.idCaso, pr.nombreProveedor, r.codigoResultado, r.descripcionResultado, h.homologacion`, pDia);
  } catch (e) {
    return opcional('resultados', {
      sql: `SELECT ca.idCaso AS caso, ISNULL(pr.nombreProveedor, 'Sin proveedor') AS respondio, r.codigoResultado AS codigo, r.descripcionResultado AS descripcion, COUNT(*) AS total
            ${base}
            ${donde}
            GROUP BY ca.idCaso, pr.nombreProveedor, r.codigoResultado, r.descripcionResultado`, parametros: pDia,
    }, avisos);
  }
}

const mediana = (xs) => {
  if (!xs.length) return null;
  const o = [...xs].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : Math.round((o[m - 1] + o[m]) / 2);
};

/** Detalle completo de un cliente-día. Lanza (con .codigo) si no hay conexión o los datos pedidos no son válidos. */
async function detalleClienteDia(entrada) {
  const v = validar(entrada || {});
  if (v.error) throw Object.assign(new Error(v.error), { codigo: 'VALIDACION' });
  const config = await cfg.obtenerInterna();
  const limites = config.limites;
  const limDia = (prov) => (limites[prov] && limites[prov].dia > 0 ? limites[prov].dia : 0);
  const limMes = (prov) => (limites[prov] && limites[prov].mes > 0 ? limites[prov].mes : 0);
  const dia = paramsRango(v.fecha, v.fecha);
  const cli = { nombre: 'cliente', tipo: 'varchar', valor: v.idCliente };
  const pDia = [...dia, cli];
  const mesIni = `${v.fecha.slice(0, 7)}-01`;
  const histDesde = [sumarDias(v.fecha, -(DIAS_HISTORIAL - 1)), mesIni].sort()[0];
  const pHist = [...paramsRango(histDesde, v.fecha), cli];
  const avisos = [];

  // La lista de casos es lo esencial: si falla, falla todo el detalle.
  const casosFilas = await cfg.consultar(
    `SELECT TOP 500 c.id, c.idCanal AS canal, c.idRegla AS regla, ${PROV} AS proveedor, c.idEstado AS estado, ISNULL(c.reintentos, 0) AS reintentos, c.FechaCreo AS fecha
     FROM dbo.CASO c WHERE c.idCliente = @cliente AND ${RANGO} ORDER BY c.FechaCreo, c.id`, pDia);

  const [clienteF, clienteTipoF, resultadosF, capturasTipoF, estadosF, intentoF, histF, cat, noHabF] = await Promise.all([
    opcional('cliente', { sql: 'SELECT TOP 1 cl.numeroDocumento AS documento, cl.nombre AS nombre FROM dbo.CLIENTE cl WHERE cl.id = @cliente', parametros: [cli] }, avisos),
    opcional('tipo de documento', { sql: 'SELECT TOP 1 cl.idTipoDocumento AS tipo FROM dbo.CLIENTE cl WHERE cl.id = @cliente', parametros: [cli] }, avisos),
    resultadosConHomologacion(pDia, avisos),
    opcional('tipos de captura', {
      sql: `SELECT ca.idCaso AS caso, ca.idTipoCaptura AS tipo, COUNT(*) AS total
            FROM dbo.CASO c JOIN dbo.CAPTURA ca ON ca.idCaso = c.id
            WHERE c.idCliente = @cliente AND ${RANGO} GROUP BY ca.idCaso, ca.idTipoCaptura`, parametros: pDia,
    }, avisos),
    opcional('estados', { sql: 'SELECT id, estado FROM dbo.ESTADO', parametros: [] }, avisos),
    opcional('contadores (INTENTO)', { sql: 'SELECT i.idRegla AS regla, i.intentosDia AS dia, i.intentosMes AS mes FROM dbo.INTENTO i WHERE i.idCliente = @cliente', parametros: [cli] }, avisos),
    opcional('historial', {
      sql: `SELECT ${DIA} AS dia, ${PROV} AS proveedor, c.idRegla AS regla, COUNT(*) AS total,
              SUM(CASE WHEN c.idEstado = 4 THEN 1 ELSE 0 END) AS exitosos
            FROM dbo.CASO c WHERE c.idCliente = @cliente AND ${RANGO} GROUP BY ${DIA}, ${PROV}, c.idRegla`, parametros: pHist,
    }, avisos),
    catalogo.obtener(),
    opcional('días no hábiles', { sql: 'SELECT TOP 5000 * FROM dbo.DIASNOHABILES', parametros: [] }, avisos),
  ]);
  avisos.push(...cat.avisos);

  const cal = construirCalendario(noHabF);
  const estados = Object.fromEntries(estadosF.map((e) => [String(e.id), aTexto(e.estado)]));
  const reglas = new Map(cat.reglas.map((r) => [r.id, r]));
  const tiposDoc = new Map(cat.tiposDocumento.map((t) => [t.id, t.nombre]));
  const tiposCap = new Map((cat.tiposCaptura || []).map((t) => [t.id, t.nombre]));
  const nombreTipoCaptura = (id) => tiposCap.get(id) || ({ 1: 'Frontal del documento', 2: 'Posterior del documento', 3: 'Huellas', 4: 'Rostro', 5: 'Movimiento', 6: 'Otra' }[id]) || `Tipo ${id}`;

  const resPorCaso = new Map();
  for (const f of resultadosF) {
    const k = String(f.caso);
    const l = resPorCaso.get(k) || [];
    l.push({ respondio: aTexto(f.respondio), codigo: aTexto(f.codigo), descripcion: aTexto(f.descripcion), homologacion: aTexto(f.homologacion) || null, total: n(f.total) });
    resPorCaso.set(k, l);
  }
  const capPorCaso = new Map();
  for (const f of capturasTipoF) {
    const k = String(f.caso);
    const l = capPorCaso.get(k) || [];
    l.push({ tipo: nombreTipoCaptura(n(f.tipo)), total: n(f.total) });
    capPorCaso.set(k, l);
  }

  // Línea de tiempo: numeración por proveedor y por regla dentro del día.
  const contProv = {}; const contRegla = {}; const primerExito = {}; const gaps = [];
  let previa = null;
  const casos = casosFilas.map((f) => {
    const proveedor = f.proveedor; const regla = n(f.regla); const estado = n(f.estado);
    contProv[proveedor] = (contProv[proveedor] || 0) + 1;
    contRegla[regla] = (contRegla[regla] || 0) + 1;
    const infoRegla = reglas.get(regla);
    const t = aMs(f.fecha);
    const minDesdeAnterior = previa !== null && Number.isFinite(t) ? Math.round(((t - previa) / 60000) * 10) / 10 : null;
    if (minDesdeAnterior !== null) gaps.push(minDesdeAnterior);
    if (Number.isFinite(t)) previa = t;
    const despuesExito = primerExito[proveedor] !== undefined;
    if (estado === 4 && primerExito[proveedor] === undefined) primerExito[proveedor] = contProv[proveedor];
    const numero = contProv[proveedor];
    const limReglaDia = infoRegla?.intentosDia > 0 ? infoRegla.intentosDia : null;
    const resultados = resPorCaso.get(String(f.id)) || [];
    const capturas = capPorCaso.get(String(f.id)) || [];
    return {
      id: f.id, hora: hhmmss(f.fecha), proveedor, canal: n(f.canal), canalNombre: nombreCanal(n(f.canal)), regla,
      producto: infoRegla?.producto ?? null, subproducto: infoRegla?.subproducto ?? null, descripcionRegla: infoRegla?.descripcion ?? null,
      transaccion: infoRegla?.transaccion ?? null, estado, estadoNombre: estados[String(estado)] || `Estado ${estado}`, reintentos: n(f.reintentos),
      numero, minDesdeAnterior, esReuso: numero > 1, despuesExito,
      sobreLimite: limDia(proveedor) > 0 && numero > limDia(proveedor), excedeRegla: limReglaDia !== null && contRegla[regla] > limReglaDia,
      capturas: capturas.reduce((a, c) => a + c.total, 0), tiposCaptura: capturas, resultados,
    };
  });

  const cuenta = (fn) => casos.filter(fn).length;
  const porProveedor = PROVEEDORES.map((p) => {
    const l = casos.filter((c) => c.proveedor === p);
    return {
      proveedor: p, casos: l.length, exitosos: l.filter((c) => c.estado === 4).length, fallidos: l.filter((c) => c.estado === 5).length,
      reintentos: l.filter((c) => c.estado === 3).length, reusos: Math.max(0, l.length - 1), despuesExito: l.filter((c) => c.despuesExito).length,
      sobreLimite: limDia(p) > 0 ? Math.max(0, l.length - limDia(p)) : 0,
      limiteDia: limDia(p) || null, limiteMes: limMes(p) || null, avisar: !!(limites[p] && limites[p].avisar),
    };
  }).filter((x) => x.casos > 0);

  const tiempos = casosFilas.map((f) => aMs(f.fecha)).filter(Number.isFinite);
  const horas = Array.from({ length: 24 }, () => 0);
  for (const f of casosFilas) if (f.fecha instanceof Date) horas[f.fecha.getUTCHours()] += 1;

  // Reglas que usó el cliente este día, con sus límites y contadores (INTENTO).
  const intento = new Map(intentoF.map((i) => [n(i.regla), { dia: n(i.dia), mes: n(i.mes) }]));
  const mesCont = {};
  for (const f of histF) if (aTexto(f.dia) >= mesIni) mesCont[n(f.regla)] = (mesCont[n(f.regla)] || 0) + n(f.total);
  const reglasUsadas = [...new Set(casos.map((c) => c.regla))].sort((a, b) => a - b).map((id) => {
    const r = reglas.get(id);
    const usadosHoy = contRegla[id] || 0; const usadosMes = mesCont[id] || 0;
    return {
      regla: id, descripcion: r?.descripcion ?? null, topico: r?.topico ?? null, transaccion: r?.transaccion ?? null, producto: r?.producto ?? null, subproducto: r?.subproducto ?? null, idValidacion: r?.validacion ?? null,
      clasificacion: r?.clasificacion ?? catalogo.clasificacionDe(id), consulta: r?.consulta ?? [], capturasPedidas: r?.capturas ?? [], coincide: r?.coincide ?? null,
      intentosDia: r?.intentosDia ?? null, intentosMes: r?.intentosMes ?? null, vigencia: r?.vigencia ?? null,
      usadosHoy, usadosMes, contadorDia: intento.get(id)?.dia ?? null, contadorMes: intento.get(id)?.mes ?? null,
      excedeDia: r?.intentosDia > 0 && usadosHoy > r.intentosDia, excedeMes: r?.intentosMes > 0 && usadosMes > r.intentosMes,
    };
  });

  // Historial de los últimos 30 días (con ceros) y consumo del mes.
  const hMapa = new Map();
  for (const f of histF) {
    const k = `${aTexto(f.dia)}|${f.proveedor}`;
    hMapa.set(k, (hMapa.get(k) || 0) + n(f.total));
  }
  const historial = [];
  for (let i = DIAS_HISTORIAL - 1; i >= 0; i -= 1) {
    const fecha = sumarDias(v.fecha, -i);
    historial.push({ fecha, habil: cal.esHabil(fecha), ASISA: hMapa.get(`${fecha}|ASISA`) || 0, OLIMPIA: hMapa.get(`${fecha}|OLIMPIA`) || 0 });
  }
  const mes = { periodo: mesIni.slice(0, 7), ASISA: 0, OLIMPIA: 0 };
  for (const [k, total] of hMapa) { const [d, p] = k.split('|'); if (d >= mesIni && mes[p] !== undefined) mes[p] += total; }
  const sobreLimiteMes = Object.fromEntries(PROVEEDORES.map((p) => [p, limMes(p) > 0 ? Math.max(0, (mes[p] || 0) - limMes(p)) : 0]));
  mes.sobreLimite = sobreLimiteMes;
  const diasActivos30 = historial.filter((h) => h.ASISA + h.OLIMPIA > 0).length;

  const idTipo = n(clienteTipoF[0]?.tipo);
  const total = casos.length;
  return {
    cliente: {
      idCliente: v.idCliente, documento: aTexto(clienteF[0]?.documento), nombre: aTexto(clienteF[0]?.nombre),
      tipoDocumento: idTipo !== null ? (tiposDoc.get(idTipo) || `Tipo ${idTipo}`) : null,
    },
    fecha: v.fecha, diaSemana: cal.nombreDia(v.fecha), habil: cal.esHabil(v.fecha), motivoNoHabil: cal.motivo(v.fecha), proveedorFoco: v.proveedor,
    // `limite` (número) = límite diario del proveedor en foco (o el de OLIMPIA); `limites` trae día, mes y alerta de cada proveedor.
    limite: limDia(v.proveedor || 'OLIMPIA') || null, limites,
    resumen: {
      casos: total, exitosos: cuenta((c) => c.estado === 4), fallidos: cuenta((c) => c.estado === 5), reintentos: cuenta((c) => c.estado === 3),
      otros: cuenta((c) => ![3, 4, 5].includes(c.estado)), viaApp: cuenta((c) => c.canal === 1), viaWhoisWho: cuenta((c) => c.canal === 0),
      reusos: porProveedor.reduce((a, p) => a + p.reusos, 0), despuesExito: cuenta((c) => c.despuesExito),
      sobreLimite: porProveedor.reduce((a, p) => a + p.sobreLimite, 0), tasaExito: pct(cuenta((c) => c.estado === 4), total),
      primerIntento: tiempos.length ? hhmmss(new Date(Math.min(...tiempos))) : null, ultimoIntento: tiempos.length ? hhmmss(new Date(Math.max(...tiempos))) : null,
      duracionMin: tiempos.length > 1 ? Math.round((Math.max(...tiempos) - Math.min(...tiempos)) / 60000) : 0,
      minEntreIntentosMediana: mediana(gaps), minEntreIntentosMin: gaps.length ? Math.min(...gaps) : null,
      truncado: casosFilas.length >= 500,
    },
    porProveedor, casos, horas, reglas: reglasUsadas, historial, mes, diasActivos30,
    avisos,
  };
}

module.exports = { detalleClienteDia, _prueba: { validar } };
