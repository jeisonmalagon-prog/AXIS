// Lógica de armado del informe de Balanceador F5 — mismo patrón que
// utils/informeServidores.js.
//
// El informe junta CUATRO fuentes, cada una con su alcance (todas se
// documentan en `fuentes` dentro del resultado y en las notas del informe):
//   1. Estado EN VIVO (iControl REST): Virtual Servers, pools y nodos con su
//      estado, monitor, alias... Siempre es "ahora", sin importar el periodo.
//   2. f5_historico: foto cada 10 min de cuántos Virtual Servers/nodos estaban
//      arriba (disponibilidad y tendencia). Empieza cuando se desplegó ese job.
//   3. f5_nodo_trafico: lecturas de tráfico por nodo cada 5 min (velocidad de
//      entrada/salida, conexiones, conexiones nuevas, datos transferidos).
//      Empieza cuando se desplegó el muestreo; sin la tabla vive solo en memoria.
//   4. AVR (Statistics > Analytics del propio F5): transacciones HTTP por nodo,
//      que SÍ incluye días anteriores al despliegue pero solo de Virtual Servers
//      con perfil de analítica HTTP y hasta ~30 días atrás.
// Si una fuente falla o no tiene datos, el informe se entrega igual con las
// demás y lo avisa en `fuentes`/`notas`: nunca se cae completo por una sola.
const { getPool } = require('../db');
const {
  cargarDispositivosF5,
  obtenerVirtualesConEstado,
  garantizarTablaF5Historico,
  F5_DISPOSITIVOS_CONFIGURADOS,
} = require('./f5Cliente');
const { leerFilasDispositivo } = require('./f5HistorialNodos');
const { INTERVALO_MS: INTERVALO_MUESTREO_MS, consultarActividad } = require('./f5ActividadNodos');
const { historialAvr } = require('./f5Avr');
const { agregarTrafico, claveDia } = require('./informeF5Trafico');

function formatoFechaSql(fecha) {
  return fecha.toISOString().slice(0, 10);
}

function calcularRangoPeriodo(periodo) {
  const hasta = new Date();
  const desde = new Date();
  switch (periodo) {
    case 'dia':
      desde.setDate(desde.getDate() - 1);
      break;
    case 'mes':
      desde.setMonth(desde.getMonth() - 1);
      break;
    case 'semana':
    default:
      desde.setDate(desde.getDate() - 7);
      break;
  }
  return { desde: formatoFechaSql(desde), hasta: formatoFechaSql(hasta) };
}

function resolverRango(req) {
  const { desde, hasta, periodo } = req.query;
  if (desde && hasta) return { desde, hasta };
  return calcularRangoPeriodo(periodo);
}

// ---------- Estado en vivo ----------
const RESUMEN_VACIO = {
  configurado: false,
  dispositivosTotal: 0,
  virtualesTotal: 0,
  virtualesArriba: 0,
  virtualesAbajo: 0,
  nodosTotal: 0,
  nodosArriba: 0,
  nodosAbajo: 0,
  dispositivosConError: [],
};

// Clasificación de un nodo a partir de lo que informa el F5:
//   deshabilitado = un administrador lo sacó de servicio (session user-disabled)
//   caido         = el monitor de salud lo marca "down" (o no está disponible por otra razón)
//   disponible    = en servicio y respondiendo
function estadoDeNodo(n) {
  const motivo = String(n.motivoEstado || '').toLowerCase();
  if (motivo.includes('disabled') || n.estado === 'offline') return 'deshabilitado';
  if (n.estadoMonitor === 'down') return 'caido';
  return 'disponible';
}

// Lee Virtual Servers/nodos EN VIVO de todos los dispositivos configurados. Si un
// dispositivo puntual falla (F5 caído, credenciales, red), no rompe el resumen
// entero: queda listado en dispositivosConError y no aporta a los totales.
async function leerInventarioVivo() {
  if (!F5_DISPOSITIVOS_CONFIGURADOS) return { resumenActual: { ...RESUMEN_VACIO }, dispositivos: [] };

  const dispositivos = cargarDispositivosF5();
  let virtualesTotal = 0;
  let virtualesArriba = 0;
  let nodosTotal = 0;
  let nodosArriba = 0;
  const dispositivosConError = [];
  const lecturas = [];

  for (const dispositivo of dispositivos) {
    try {
      const virtuales = await obtenerVirtualesConEstado(dispositivo);
      lecturas.push({ dispositivo, virtuales });
      virtualesTotal += virtuales.length;
      virtualesArriba += virtuales.filter((v) => v.estado === 'available').length;

      const poolsUnicos = new Map();
      for (const v of virtuales) {
        if (!v.pool || v.nodosTotal === null || v.nodosTotal === undefined) continue;
        poolsUnicos.set(v.pool, { arriba: v.nodosArriba || 0, total: v.nodosTotal });
      }
      for (const { arriba, total } of poolsUnicos.values()) {
        nodosTotal += total;
        nodosArriba += arriba;
      }
    } catch (err) {
      dispositivosConError.push({ id: dispositivo.id, nombre: dispositivo.nombre, error: err.message });
      lecturas.push({ dispositivo, virtuales: [], error: err.message });
    }
  }

  return {
    resumenActual: {
      configurado: true,
      dispositivosTotal: dispositivos.length,
      virtualesTotal,
      virtualesArriba,
      virtualesAbajo: virtualesTotal - virtualesArriba,
      nodosTotal,
      nodosArriba,
      nodosAbajo: nodosTotal - nodosArriba,
      dispositivosConError,
    },
    dispositivos: lecturas,
  };
}

// Alias (nombre propio) de los Virtual Servers: "dispositivo|fullPath" -> alias.
// La tabla puede no existir todavía; sin ella simplemente no hay alias.
async function leerAliases(pool) {
  try {
    const [filas] = await pool.query('SELECT dispositivo_id, virtual_full_path, alias FROM f5_alias');
    return new Map(filas.map((f) => [`${f.dispositivo_id}|${f.virtual_full_path}`, f.alias]));
  } catch (err) {
    return new Map();
  }
}

// ---------- AVR: transacciones HTTP por nodo ----------
const AVR_MAX_HORAS = 720;
const AVR_TIMEOUT_MS = 70 * 1000;

function conTiempoLimite(promesa, ms, mensaje) {
  let t;
  const limite = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(mensaje)), ms); });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(t));
}

// Total de transacciones HTTP por nodo y por día en el periodo. `miembros`:
// [{ nombre, direccion, puerto }] ya sin repetir. Nunca lanza: devuelve
// { disponible:false, aviso } si AVR no responde o no tiene datos.
async function transaccionesAvr(dispositivo, miembros, desdeMs, hastaMs) {
  if (!miembros.length) return { disponible: false, aviso: 'El dispositivo no tiene nodos.', porMiembro: new Map(), diario: new Map() };
  const ahora = Date.now();
  const horasPedidas = Math.ceil((ahora - desdeMs) / 3600000);
  const horas = Math.min(AVR_MAX_HORAS, Math.max(1, horasPedidas));
  try {
    const datos = await conTiempoLimite(historialAvr(dispositivo, miembros, horas), AVR_TIMEOUT_MS, 'AVR tardó demasiado en responder');
    const tamMs = datos.bucketSegundos * 1000;
    const total = (p) => {
      const t = Date.parse(p.t);
      if (!(t + tamMs > desdeMs && t <= hastaMs)) return null;
      if (p.transacciones !== null && p.transacciones !== undefined) return p.transacciones;
      // Tramo en curso: solo hay velocidad; se estima con el tiempo transcurrido.
      if (p.tps !== null && p.tps !== undefined) return Math.round(p.tps * (Math.min(t + tamMs, ahora) - t) / 1000);
      return null;
    };

    const porMiembro = new Map();
    let hayDatos = false;
    for (const n of datos.nodos) {
      let suma = 0; let alguno = false;
      for (const p of n.puntos) {
        const v = total(p);
        if (v !== null) { suma += v; alguno = true; }
      }
      if (alguno) { hayDatos = true; porMiembro.set(n.miembro, suma); }
    }
    const diario = new Map();
    for (const p of datos.total) {
      const v = total(p);
      if (v === null) continue;
      const dia = claveDia(Date.parse(p.t));
      diario.set(dia, (diario.get(dia) || 0) + v);
    }
    let aviso = datos.aviso || null;
    if (horasPedidas > AVR_MAX_HORAS) {
      aviso = [aviso, 'AVR solo permite consultar los últimos 30 días; el tramo anterior no está incluido.'].filter(Boolean).join(' ');
    }
    if (!hayDatos) aviso = aviso || 'AVR no devolvió transacciones para este periodo (los Virtual Servers pueden no tener perfil de analítica HTTP).';
    return { disponible: hayDatos, aviso, porMiembro, diario, formato: datos.formatoRange || null };
  } catch (err) {
    return { disponible: false, aviso: `No se pudo leer AVR: ${String(err.message || err).slice(0, 200)}`, porMiembro: new Map(), diario: new Map() };
  }
}

// ---------- Armado ----------
const num = (v) => (v === null || v === undefined ? null : Number(v));
const pct = (v) => (v === null || v === undefined ? null : +Number(v).toFixed(2));

async function armarDatosInformeF5(desde, hasta) {
  const pool = await getPool();
  await garantizarTablaF5Historico(pool);

  const ahora = Date.now();
  const desdeMs = new Date(`${desde}T00:00:00`).getTime();
  const hastaMs = Math.min(ahora, new Date(`${hasta}T23:59:59.999`).getTime());
  const rangoValido = Number.isFinite(desdeMs) && Number.isFinite(hastaMs) && hastaMs > desdeMs;

  const notas = [];

  const inventario = await leerInventarioVivo();
  const resumenActual = inventario.resumenActual;

  // ---------- Disponibilidad (f5_historico) ----------
  const rango = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
  const [tendenciaFilas] = await pool.query(
    `SELECT DATE(agregadoPorInstante.Fecha) AS fecha,
            AVG(agregadoPorInstante.VirtualesTotal) AS virtualesTotalProm,
            AVG(agregadoPorInstante.VirtualesArriba) AS virtualesArribaProm,
            AVG(agregadoPorInstante.NodosTotal) AS nodosTotalProm,
            AVG(agregadoPorInstante.NodosArriba) AS nodosArribaProm,
            AVG(agregadoPorInstante.VirtualesArriba / NULLIF(agregadoPorInstante.VirtualesTotal, 0)) * 100 AS virtualesPct,
            AVG(agregadoPorInstante.NodosArriba / NULLIF(agregadoPorInstante.NodosTotal, 0)) * 100 AS nodosPct,
            MIN(agregadoPorInstante.VirtualesArriba / NULLIF(agregadoPorInstante.VirtualesTotal, 0)) * 100 AS virtualesPctMin,
            MIN(agregadoPorInstante.NodosArriba / NULLIF(agregadoPorInstante.NodosTotal, 0)) * 100 AS nodosPctMin
     FROM (
       SELECT Fecha,
              SUM(VirtualesTotal) AS VirtualesTotal, SUM(VirtualesArriba) AS VirtualesArriba,
              SUM(NodosTotal) AS NodosTotal, SUM(NodosArriba) AS NodosArriba
       FROM f5_historico
       WHERE Fecha BETWEEN ? AND ?
       GROUP BY Fecha
     ) AS agregadoPorInstante
     GROUP BY DATE(agregadoPorInstante.Fecha)
     ORDER BY fecha ASC`,
    rango
  );

  // "Pico" aquí = el peor momento del periodo (más virtuales/nodos caídos a la
  // vez), mismo criterio de "picos = lo más crítico" que usa Servidores.
  const [picosFilas] = await pool.query(
    `SELECT MAX(porInstante.VirtualesTotalSuma - porInstante.VirtualesArribaSuma) AS virtualesAbajoPico,
            MAX(porInstante.NodosTotalSuma - porInstante.NodosArribaSuma) AS nodosAbajoPico,
            AVG(porInstante.VirtualesArribaSuma / NULLIF(porInstante.VirtualesTotalSuma, 0)) * 100 AS virtualesPct,
            AVG(porInstante.NodosArribaSuma / NULLIF(porInstante.NodosTotalSuma, 0)) * 100 AS nodosPct,
            COUNT(*) AS totalCapturas
     FROM (
       SELECT Fecha,
              SUM(VirtualesTotal) AS VirtualesTotalSuma, SUM(VirtualesArriba) AS VirtualesArribaSuma,
              SUM(NodosTotal) AS NodosTotalSuma, SUM(NodosArriba) AS NodosArribaSuma
       FROM f5_historico
       WHERE Fecha BETWEEN ? AND ?
       GROUP BY Fecha
     ) AS porInstante`,
    rango
  );

  const [porDispositivoFilas] = await pool.query(
    `SELECT DispositivoId, DispositivoNombre,
            AVG(VirtualesArriba) AS virtualesArribaProm, AVG(VirtualesTotal) AS virtualesTotalProm,
            AVG(NodosArriba) AS nodosArribaProm, AVG(NodosTotal) AS nodosTotalProm,
            AVG(VirtualesArriba / NULLIF(VirtualesTotal, 0)) * 100 AS virtualesPct,
            AVG(NodosArriba / NULLIF(NodosTotal, 0)) * 100 AS nodosPct,
            COUNT(*) AS capturas
     FROM f5_historico
     WHERE Fecha BETWEEN ? AND ?
     GROUP BY DispositivoId, DispositivoNombre
     ORDER BY DispositivoNombre ASC`,
    rango
  );

  let primeraCapturaDisponibilidad = null;
  try {
    const [m] = await pool.query('SELECT MIN(Fecha) AS primera FROM f5_historico');
    primeraCapturaDisponibilidad = m[0]?.primera ? new Date(m[0].primera).toISOString() : null;
  } catch (err) { /* informativo */ }

  const picos = picosFilas[0] || {};
  const aliases = await leerAliases(pool);

  // ---------- Tráfico por nodo (f5_nodo_trafico / memoria) ----------
  const dispositivosVivos = inventario.dispositivos;
  const todasFilas = [];
  let fuenteTrafico = null;
  let traficoLimitado = false;
  if (rangoValido) {
    const dispositivosConfig = F5_DISPOSITIVOS_CONFIGURADOS ? cargarDispositivosF5() : [];
    for (const d of dispositivosConfig) {
      try {
        const r = await leerFilasDispositivo(d.id, desdeMs, hastaMs);
        fuenteTrafico = fuenteTrafico === 'memoria' || r.fuente === 'memoria' ? 'memoria' : r.fuente;
        traficoLimitado = traficoLimitado || r.limitada;
        for (const f of r.filas) todasFilas.push({ ...f, pool: `${d.id}::${f.pool}` });
      } catch (err) {
        notas.push(`No se pudo leer el histórico de tráfico de "${d.nombre || d.id}": ${String(err.message || err).slice(0, 160)}`);
      }
    }
  }
  const intervaloSeg = Math.round(INTERVALO_MUESTREO_MS / 1000);
  const trafico = agregarTrafico(todasFilas, intervaloSeg);
  const hayTrafico = trafico.totalLecturas > 0;

  // ---------- AVR: transacciones HTTP por nodo ----------
  const avrPorDispositivo = new Map();
  if (rangoValido) {
    await Promise.all(dispositivosVivos.map(async ({ dispositivo, virtuales }) => {
      const unicos = new Map();
      for (const v of virtuales) {
        for (const n of v.nodos || []) {
          const nombre = n.nombre || `${n.direccion}:${n.puerto}`;
          if (!unicos.has(nombre)) unicos.set(nombre, { nombre, direccion: n.direccion, puerto: n.puerto });
        }
      }
      avrPorDispositivo.set(dispositivo.id, await transaccionesAvr(dispositivo, [...unicos.values()], desdeMs, hastaMs));
    }));
  }
  const avrDisponible = [...avrPorDispositivo.values()].some((a) => a.disponible);
  const avrAvisos = [...avrPorDispositivo.values()].map((a) => a.aviso).filter(Boolean);

  // ---------- Virtual Servers y nodos (detalle) ----------
  const gruposPool = new Map(); // "dispositivo::pool" -> { virtuales: [...] } para marcar pools compartidos
  for (const { dispositivo, virtuales } of dispositivosVivos) {
    for (const v of virtuales) {
      if (!v.pool) continue;
      const k = `${dispositivo.id}::${v.pool}`;
      if (!gruposPool.has(k)) gruposPool.set(k, []);
      gruposPool.get(k).push(v);
    }
  }

  const virtualesDetalle = [];
  // Un nodo (miembro de un pool) se lista UNA vez aunque varios Virtual Servers
  // compartan ese pool; `virtuales` dice cuáles lo usan.
  const nodosPorClave = new Map();
  for (const { dispositivo, virtuales } of dispositivosVivos) {
    const avr = avrPorDispositivo.get(dispositivo.id);
    for (const v of virtuales) {
      const clavePool = v.pool ? `${dispositivo.id}::${v.pool}` : null;
      const alias = aliases.get(`${dispositivo.id}|${v.fullPath}`) || null;
      const nombreMostrado = alias || v.nombre;
      const resumenPool = clavePool ? trafico.porPool.get(clavePool) || null : null;

      let transaccionesVirtual = null;
      let deshabilitados = 0;
      let caidos = 0;
      for (const n of v.nodos || []) {
        const nombre = n.nombre || `${n.direccion}:${n.puerto}`;
        const estado = estadoDeNodo(n);
        if (estado === 'deshabilitado') deshabilitados++;
        if (estado === 'caido') caidos++;
        const trans = avr && avr.porMiembro.has(nombre) ? avr.porMiembro.get(nombre) : null;
        if (trans !== null) transaccionesVirtual = (transaccionesVirtual || 0) + trans;

        const claveNodo = `${clavePool}|${nombre}`;
        const existente = nodosPorClave.get(claveNodo);
        if (existente) { existente.virtuales.push(nombreMostrado); continue; }
        const resumen = clavePool ? trafico.porNodo.get(claveNodo) || null : null;
        const actividad = v.pool ? consultarActividad(dispositivo.id, v.pool, nombre) : null;
        nodosPorClave.set(claveNodo, {
          dispositivoId: dispositivo.id,
          dispositivoNombre: dispositivo.nombre,
          virtuales: [nombreMostrado],
          pool: v.pool,
          miembro: nombre,
          direccion: n.direccion,
          puerto: n.puerto ?? null,
          estado,
          estadoF5: n.estado,
          motivoEstado: n.motivoEstado || null,
          estadoMonitor: n.estadoMonitor || null,
          ultimoTraficoEn: actividad?.ultimoTraficoEn || resumen?.ultimoTraficoEn || null,
          trafico: resumen,
          transacciones: trans,
        });
      }

      virtualesDetalle.push({
        dispositivoId: dispositivo.id,
        dispositivoNombre: dispositivo.nombre,
        nombre: v.nombre,
        alias,
        nombreMostrado,
        fullPath: v.fullPath,
        destino: v.destino,
        pool: v.pool,
        poolCompartidoCon: clavePool ? gruposPool.get(clavePool).length - 1 : 0,
        habilitado: v.habilitado,
        estado: v.estado,
        motivoEstado: v.motivoEstado,
        nodosArriba: v.nodosArriba,
        nodosTotal: v.nodosTotal,
        nodosDeshabilitados: deshabilitados,
        nodosCaidos: caidos,
        conexionesActuales: num(v.conexionesActuales),
        trafico: resumenPool,
        transacciones: transaccionesVirtual,
      });
    }
  }
  const nodosDetalle = [...nodosPorClave.values()].map((n) => ({ ...n, virtualNombre: n.virtuales.join(' · ') }));

  const hayLecturaNodo = (n) => n.trafico && n.trafico.muestras > 0;
  const ordenTrafico = (a, b) => ((b.trafico?.datosEntradaBytes || 0) + (b.trafico?.datosSalidaBytes || 0)) - ((a.trafico?.datosEntradaBytes || 0) + (a.trafico?.datosSalidaBytes || 0));
  virtualesDetalle.sort((a, b) => (b.transacciones || 0) - (a.transacciones || 0) || ordenTrafico(a, b) || a.nombreMostrado.localeCompare(b.nombreMostrado, 'es'));
  nodosDetalle.sort((a, b) => (b.transacciones || 0) - (a.transacciones || 0) || ordenTrafico(a, b) || a.virtualNombre.localeCompare(b.virtualNombre, 'es') || a.miembro.localeCompare(b.miembro, 'es', { numeric: true }));

  // ---------- Requiere atención ----------
  const LIMITE_LISTA = 200;
  const sinTrafico = nodosDetalle.filter((n) =>
    n.estado === 'disponible'
    && ((hayTrafico && hayLecturaNodo(n) && n.trafico.minutosConTrafico === 0) || (!hayTrafico && avrDisponible && n.transacciones === 0))
    && !(n.transacciones > 0)
  );
  const atencion = {
    virtualesAbajo: virtualesDetalle.filter((v) => v.habilitado && v.estado !== 'available').slice(0, LIMITE_LISTA),
    virtualesDeshabilitados: virtualesDetalle.filter((v) => !v.habilitado).slice(0, LIMITE_LISTA),
    nodosCaidos: nodosDetalle.filter((n) => n.estado === 'caido').slice(0, LIMITE_LISTA),
    nodosDeshabilitados: nodosDetalle.filter((n) => n.estado === 'deshabilitado').slice(0, LIMITE_LISTA),
    nodosSinTrafico: sinTrafico.slice(0, LIMITE_LISTA),
  };
  const conteos = {
    virtualesDeshabilitados: virtualesDetalle.filter((v) => !v.habilitado).length,
    nodosDisponibles: nodosDetalle.filter((n) => n.estado === 'disponible').length,
    nodosCaidos: nodosDetalle.filter((n) => n.estado === 'caido').length,
    nodosDeshabilitados: nodosDetalle.filter((n) => n.estado === 'deshabilitado').length,
    nodosSinTrafico: sinTrafico.length,
  };

  // ---------- Serie diaria combinada (tráfico propio + transacciones AVR) ----------
  const avrDiario = new Map();
  for (const a of avrPorDispositivo.values()) {
    for (const [dia, n] of a.diario) avrDiario.set(dia, (avrDiario.get(dia) || 0) + n);
  }
  const diarioPorFecha = new Map(trafico.diario.map((d) => [d.fecha, { ...d, transacciones: null }]));
  for (const [dia, n] of avrDiario) {
    const d = diarioPorFecha.get(dia) || {
      fecha: dia, entradaPromBps: null, salidaPromBps: null, entradaPicoBps: null, salidaPicoBps: null,
      conexionesPico: null, conexionesNuevas: null, datosEntradaBytes: null, datosSalidaBytes: null, lecturas: 0,
    };
    d.transacciones = n;
    diarioPorFecha.set(dia, d);
  }
  const traficoDiario = [...diarioPorFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));

  let transaccionesTotal = null;
  if (avrDisponible) {
    transaccionesTotal = 0;
    for (const a of avrPorDispositivo.values()) for (const n of a.diario.values()) transaccionesTotal += n;
  }

  // ---------- Notas de cobertura ----------
  if (!F5_DISPOSITIVOS_CONFIGURADOS) notas.push('No hay ningún dispositivo F5 configurado en el backend (variables F5_DEVICE_*).');
  if (rangoValido && !hayTrafico && F5_DISPOSITIVOS_CONFIGURADOS) {
    notas.push('No hay lecturas de tráfico por nodo guardadas en este periodo: el muestreo (cada 5 min) empieza cuando se despliega el backend con esta función.');
  }
  if (hayTrafico && fuenteTrafico === 'memoria') {
    notas.push('El histórico de tráfico por nodo está solo en memoria (falta la tabla f5_nodo_trafico): se pierde al reiniciar el backend. Ejecuta crear_tabla_f5_nodo_trafico.sql para conservarlo.');
  }
  if (traficoLimitado) notas.push('El periodo tiene tantas lecturas que se cortó el análisis de tráfico; usa un rango menor para ver todo.');
  if (hayTrafico && trafico.primeraLectura && Date.parse(trafico.primeraLectura) > desdeMs + 24 * 3600 * 1000) {
    notas.push(`El tráfico propio solo tiene lecturas desde ${trafico.primeraLectura.slice(0, 10)}; antes de esa fecha solo se muestran las transacciones HTTP de AVR (si están disponibles).`);
  }
  avrAvisos.forEach((a) => notas.push(`AVR: ${a}`));
  if (picos.totalCapturas === 0 && F5_DISPOSITIVOS_CONFIGURADOS) {
    notas.push('No hay capturas de disponibilidad (cada 10 min) en este periodo: puede ser anterior a la activación del informe aunque el F5 sí estuviera funcionando.');
  }

  return {
    generadoEn: new Date(ahora).toISOString(),
    periodo: { desde, hasta },
    f5Configurado: F5_DISPOSITIVOS_CONFIGURADOS,
    resumenActual,
    conteos,
    resumenPeriodo: {
      disponibilidadVirtualesPct: pct(picos.virtualesPct),
      disponibilidadNodosPct: pct(picos.nodosPct),
      ...trafico.resumenPeriodo,
      transaccionesTotal,
    },
    tendenciaDiaria: tendenciaFilas.map((f) => ({
      fecha: f.fecha,
      virtualesTotalProm: +Number(f.virtualesTotalProm || 0).toFixed(1),
      virtualesArribaProm: +Number(f.virtualesArribaProm || 0).toFixed(1),
      nodosTotalProm: +Number(f.nodosTotalProm || 0).toFixed(1),
      nodosArribaProm: +Number(f.nodosArribaProm || 0).toFixed(1),
      virtualesPct: pct(f.virtualesPct),
      nodosPct: pct(f.nodosPct),
      virtualesPctMin: pct(f.virtualesPctMin),
      nodosPctMin: pct(f.nodosPctMin),
    })),
    picosPeriodo: {
      virtualesAbajoPico: picos.virtualesAbajoPico !== null && picos.virtualesAbajoPico !== undefined ? Number(picos.virtualesAbajoPico) : null,
      nodosAbajoPico: picos.nodosAbajoPico !== null && picos.nodosAbajoPico !== undefined ? Number(picos.nodosAbajoPico) : null,
      totalCapturas: Number(picos.totalCapturas || 0),
    },
    porDispositivo: porDispositivoFilas.map((f) => ({
      dispositivoId: f.DispositivoId,
      dispositivoNombre: f.DispositivoNombre,
      virtualesArribaProm: +Number(f.virtualesArribaProm || 0).toFixed(1),
      virtualesTotalProm: +Number(f.virtualesTotalProm || 0).toFixed(1),
      nodosArribaProm: +Number(f.nodosArribaProm || 0).toFixed(1),
      nodosTotalProm: +Number(f.nodosTotalProm || 0).toFixed(1),
      virtualesPct: pct(f.virtualesPct),
      nodosPct: pct(f.nodosPct),
      capturas: Number(f.capturas || 0),
    })),
    traficoDiario,
    virtuales: virtualesDetalle,
    nodos: nodosDetalle,
    atencion,
    fuentes: {
      disponibilidad: { primeraCaptura: primeraCapturaDisponibilidad, capturasEnPeriodo: Number(picos.totalCapturas || 0) },
      trafico: {
        disponible: hayTrafico,
        fuente: fuenteTrafico,
        primeraLectura: trafico.primeraLectura,
        lecturas: trafico.totalLecturas,
        intervaloSegundos: intervaloSeg,
      },
      avr: { disponible: avrDisponible, avisos: avrAvisos },
    },
    notas,
  };
}

module.exports = { calcularRangoPeriodo, resolverRango, armarDatosInformeF5 };
