// ============================================================================
// ANALÍTICA SOBRE UNA MUESTRA DE LogApp (App Móvil): latencia por servicio y
// errores masivos
// ============================================================================
// Módulo PURO (sin base de datos). Recibe las filas de una muestra reciente
// (agrupadas por cliente), las interpreta con utils/appMovilTraza.js y calcula:
//
//   * Latencia por servicio (p50 / p90 / p95 / p99 / máx), por nodo y por llamada ACE.
//   * Causas de error con su alcance (clientes distintos, nodos, versiones,
//     plataformas, ventana de tiempo) y si el error es MASIVO.
//   * Los códigos de respuesta vistos, ya traducidos.
//
// REGLAS DE EXACTITUD (se informan en pantalla):
//   * Percentil = método del rango más cercano sobre las duraciones MEDIDAS.
//     Con menos de 20 llamadas el p95/p99 no es confiable y se marca así.
//   * Solo se mide una duración cuando el log tiene el inicio y el resultado de
//     la operación. Las operaciones "sin detalle" o sin inicio se cuentan
//     aparte (`sinMedir`), nunca como 0 s.
//   * La hora del log tiene resolución de 1 s: cada duración puede variar ±1 s.
//   * Los errores se agrupan por su CAUSA literal (servicio ACE + código o
//     timeout; HTTP + ruta; mensaje de la app), no por el texto aproximado.
// ============================================================================

const traza = require('./appMovilTraza');
const { traducirItem, traducirMensajeApp } = require('./appMovilCodigos');

// -------------------------------------------------------------- estadística
/** Percentil por rango más cercano (p entre 0 y 1) sobre un arreglo ORDENADO. */
function percentilRango(ordenado, p) {
  if (!ordenado.length) return null;
  const idx = Math.min(ordenado.length - 1, Math.max(0, Math.ceil(p * ordenado.length) - 1));
  return ordenado[idx];
}

function resumirDuraciones(valores) {
  const o = valores.slice().sort((a, b) => a - b);
  if (!o.length) return { n: 0, minMs: null, p50Ms: null, p90Ms: null, p95Ms: null, p99Ms: null, maxMs: null, promMs: null, confiable95: false };
  return {
    n: o.length,
    minMs: o[0],
    p50Ms: percentilRango(o, 0.5),
    p90Ms: percentilRango(o, 0.9),
    p95Ms: percentilRango(o, 0.95),
    p99Ms: percentilRango(o, 0.99),
    maxMs: o[o.length - 1],
    promMs: Math.round(o.reduce((s, v) => s + v, 0) / o.length),
    confiable95: o.length >= 20
  };
}

const MUESTRA_MIN_P95 = 20;

// ------------------------------------------------------------ causas de error
function normalizarMensaje(t) {
  return String(t || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '‹id›')
    .replace(/\d{5,}/g, '‹n›')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
}

/** Causa de un error de una operación: clave estable + descripción legible + código. */
function causaDeOperacion(op) {
  const errores = op.items.filter((it) => it.nivel === 'error');
  if (!errores.length) return null;
  // Prioridad: la falla SOAP / error ACE (es la más específica), luego API, luego error de la app.
  const soap = errores.find((it) => it.tipo === 'soap');
  if (soap) {
    const a = soap.servicioAce || { id: '?', servicio: '', operacion: soap.titulo };
    const base = `${a.id} ${a.operacion}`;
    if (soap.falla && soap.falla.esTimeout) {
      const fase = soap.falla.fase === 'dentro_flujo' ? ' (dentro del flujo)' : soap.falla.fase === 'antes_flujo' ? ' (antes del flujo)' : '';
      return {
        clave: `ACE|${base}|TIMEOUT|${soap.falla.fase || ''}`,
        tipo: 'ACE', categoria: 'timeout',
        titulo: `ACE ${base}: tiempo de espera agotado${fase}`,
        servicioAce: a, codigo: 'timeout', detalleBanco: soap.falla.detalle || soap.falla.mensaje,
        falla: soap.falla, transaccion: soap.transaccion || null
      };
    }
    const bloque = soap.codigos && soap.codigos.bloques && (soap.codigos.bloques.find((b) => b.adicional) || soap.codigos.bloques[0]);
    const cod = bloque ? `${bloque.codigo || ''}/${bloque.serverCodigo || ''}` : (soap.codigo !== null ? String(soap.codigo) : '');
    return {
      clave: `ACE|${base}|${cod}`,
      tipo: 'ACE', categoria: 'error',
      titulo: `ACE ${base}: error ${cod ? `(código ${cod})` : ''}${bloque && bloque.desc ? ` — ${bloque.desc}` : ''}`.trim(),
      servicioAce: a, codigo: cod, detalleBanco: bloque ? bloque.desc : soap.texto,
      codigos: traducirItem(soap), transaccion: soap.transaccion || null
    };
  }
  const api = errores.find((it) => it.tipo === 'api');
  if (api) {
    const http = api.codigo !== null && api.codigo !== undefined ? `HTTP ${api.codigo}` : 'sin respuesta';
    return {
      clave: `API|${api.destino || ''}|${api.titulo}|${http}`,
      tipo: 'API', categoria: api.codigo >= 500 || api.codigo === null ? 'error' : 'error',
      titulo: `${api.titulo}${api.destino ? ` en ${api.destino}` : ''}: ${http}`,
      codigo: http, detalleBanco: api.codigos && api.codigos.desc ? api.codigos.desc : api.texto,
      codigos: traducirItem(api)
    };
  }
  const err = errores[0];
  const m = traducirMensajeApp(err.texto);
  const norm = normalizarMensaje(err.texto);
  return {
    clave: `APP|${op.metodo}|${err.titulo}|${norm}`,
    tipo: 'APP', categoria: m ? m.categoria : 'error',
    titulo: `${op.servicio || op.metodo}: ${m ? m.significado : (err.texto || err.titulo)}`.slice(0, 200),
    codigo: err.titulo, detalleBanco: err.texto, significadoApp: m ? m.significado : null
  };
}

// ---------------------------------------------------------------- principal
/**
 * @param {Map<string,Array>} porCliente Documento -> filas (con Codigo, FechaTxt, Metodo, Descripcion, Rs, RsFin, Ip, Sesion…)
 * @param {{esLogout:Function, nombreServicioLegible:Function, extraerNodo:(ip)=>number|null, extraerVersion:(fila)=>string|null, plataformaDe:(fila)=>string|null,
 *          catalogo?:object, umbrales?:object}} opc
 */
function analizarMuestra(porCliente, opc) {
  const u = Object.assign({ minClientes: 8, minErrores: 15, minTasa: 0.15, minLlamadas: 10 }, (opc && opc.umbrales) || {});
  const catalogo = opc && opc.catalogo;

  const porMetodo = new Map();     // metodo -> acumulador de latencia
  const porAce = new Map();        // 'C024 getStatusMediaInfo' -> acumulador
  const causas = new Map();        // clave -> acumulador
  const llamadasPorMetodo = new Map();
  const codigosVistos = new Map(); // 'tipo|codigo' -> {…}
  let totalOps = 0, totalErrores = 0, tMin = Infinity, tMax = -Infinity;
  const clientesTotales = new Set();

  const acumMetodo = (metodo, servicio) => {
    let a = porMetodo.get(metodo);
    if (!a) { a = { metodo, servicio, n: 0, errores: 0, sinMedir: 0, todas: [], validas: [], lentas: 0, muyLentas: 0, nodos: new Map() }; porMetodo.set(metodo, a); }
    return a;
  };

  for (const [doc, filas] of porCliente) {
    const ops = traza.interpretarFilas(filas, { esLogout: opc.esLogout, nombreServicioLegible: opc.nombreServicioLegible });
    for (const op of ops) {
      if (op.esLogout) continue;
      totalOps += 1;
      clientesTotales.add(doc);
      if (op.t < tMin) tMin = op.t;
      if (op.fin > tMax) tMax = op.fin;
      const fila = op.primeraFila || {};
      const nodo = opc.extraerNodo ? opc.extraerNodo(fila.Ip) : null;
      llamadasPorMetodo.set(op.metodo, (llamadasPorMetodo.get(op.metodo) || 0) + 1);

      const a = acumMetodo(op.metodo, op.servicio);
      a.n += 1;
      const medible = !op.sinInicio && op.estado !== 'sin_detalle';
      const fallo = op.estado === 'error';
      if (fallo) { a.errores += 1; totalErrores += 1; }
      if (!medible) a.sinMedir += 1;
      else {
        a.todas.push(op.duracionMs);
        if (!fallo) a.validas.push(op.duracionMs);
        if (op.lentitud) a.lentas += 1;
        if (op.lentitud === 'muy_lenta') a.muyLentas += 1;
        if (nodo) {
          let nd = a.nodos.get(nodo);
          if (!nd) { nd = { nodo, n: 0, errores: 0, duraciones: [] }; a.nodos.set(nodo, nd); }
          nd.n += 1; if (fallo) nd.errores += 1;
          nd.duraciones.push(op.duracionMs);
        }
      } if (!medible && nodo) {
        let nd = a.nodos.get(nodo);
        if (!nd) { nd = { nodo, n: 0, errores: 0, duraciones: [] }; a.nodos.set(nodo, nd); }
        nd.n += 1; if (fallo) nd.errores += 1;
      }

      // ACE: solo si la operación tuvo UNA llamada ACE y ninguna API -> el tiempo es atribuible a ese servicio.
      const soaps = op.items.filter((it) => it.tipo === 'soap');
      const apis = op.items.filter((it) => it.tipo === 'api');
      if (medible && soaps.length === 1 && !apis.length && soaps[0].servicioAce) {
        const s = soaps[0];
        const k = `${s.servicioAce.id} ${s.servicioAce.operacion}`;
        let x = porAce.get(k);
        if (!x) { x = { clave: k, servicioAce: s.servicioAce, n: 0, errores: 0, duraciones: [] }; porAce.set(k, x); }
        x.n += 1;
        if (s.nivel === 'error') x.errores += 1; else x.duraciones.push(s.esperaMs || 0);
      }

      // Códigos vistos
      for (const it of op.items) {
        if (it.tipo !== 'soap' && it.tipo !== 'api') continue;
        for (const t of traducirItem(it)) {
          for (const piece of [t.ace, t.servidor, t.http]) {
            if (!piece) continue;
            const k = `${piece.tipo}|${piece.codigo}`;
            const c = codigosVistos.get(k) || { tipo: piece.tipo, codigo: piece.codigo, categoria: piece.categoria, significado: piece.significado, fuente: piece.fuente, veces: 0, descripciones: new Map() };
            c.veces += 1;
            if (t.descripcionBanco) c.descripciones.set(t.descripcionBanco, (c.descripciones.get(t.descripcionBanco) || 0) + 1);
            codigosVistos.set(k, c);
          }
        }
        if (it.falla && it.falla.esTimeout) {
          const k = `Falla SOAP|timeout${it.falla.fase ? ` · ${it.falla.fase === 'dentro_flujo' ? 'dentro del flujo' : 'antes del flujo'}` : ''}`;
          const c = codigosVistos.get(k) || { tipo: 'Falla SOAP', codigo: k.split('|')[1], categoria: 'timeout', significado: 'ACE agotó el tiempo de espera (30 s).', fuente: 'Observado en logs.', veces: 0, descripciones: new Map() };
          c.veces += 1;
          codigosVistos.set(k, c);
        }
      }

      // Causas de error
      if (fallo) {
        const causa = causaDeOperacion(op);
        if (causa) {
          let c = causas.get(causa.clave);
          if (!c) {
            c = {
              ...causa, errores: 0, clientes: new Set(), nodos: new Map(), versiones: new Map(), plataformas: new Map(),
              metodos: new Map(), primera: op.t, ultima: op.fin, muestras: [], porMinuto: new Map(), duraciones: []
            };
            causas.set(causa.clave, c);
          }
          c.errores += 1;
          c.clientes.add(doc);
          if (nodo) c.nodos.set(nodo, (c.nodos.get(nodo) || 0) + 1);
          const ver = opc.extraerVersion ? opc.extraerVersion(fila) : null;
          if (ver) c.versiones.set(ver, (c.versiones.get(ver) || 0) + 1);
          const plat = opc.plataformaDe ? opc.plataformaDe(fila) : null;
          if (plat) c.plataformas.set(plat, (c.plataformas.get(plat) || 0) + 1);
          c.metodos.set(op.metodo, (c.metodos.get(op.metodo) || 0) + 1);
          if (op.t < c.primera) c.primera = op.t;
          if (op.fin > c.ultima) c.ultima = op.fin;
          if (medible) c.duraciones.push(op.duracionMs);
          const minuto = traza.formatearNaive(Math.floor(op.fin / 60000) * 60000).slice(0, 16);
          c.porMinuto.set(minuto, (c.porMinuto.get(minuto) || 0) + 1);
          if (c.muestras.length < 12) {
            const it = op.items.find((x) => x.nivel === 'error');
            c.muestras.push({ documento: doc, hora: traza.formatearNaive(op.fin), duracionMs: medible ? op.duracionMs : null, metodo: op.metodo, nodo: nodo || null, transaccion: causa.transaccion || (it && it.transaccion) || null });
          }
        }
      }
    }
  }

  // ---- latencia
  const latencia = [...porMetodo.values()].map((a) => {
    const nodos = [...a.nodos.values()].map((nd) => ({ nodo: nd.nodo, n: nd.n, errores: nd.errores, ...resumirDuraciones(nd.duraciones) })).sort((x, y) => x.nodo - y.nodo);
    return {
      metodo: a.metodo, servicio: a.servicio, llamadas: a.n, errores: a.errores, sinMedir: a.sinMedir,
      tasaError: a.n ? a.errores / a.n : 0, lentas: a.lentas, muyLentas: a.muyLentas,
      todas: resumirDuraciones(a.todas), exitosas: resumirDuraciones(a.validas), nodos
    };
  }).sort((x, y) => y.llamadas - x.llamadas);

  const ace = [...porAce.values()].map((x) => {
    const cat = catalogo ? catalogo.describir(x.servicioAce.id, x.servicioAce.servicio, x.servicioAce.operacion) : null;
    return {
      clave: x.clave, codigo: x.servicioAce.id, servicio: x.servicioAce.servicio, operacion: x.servicioAce.operacion,
      descripcion: cat && cat.encontrado ? cat.descripcion : null, instancias: cat && cat.encontrado ? cat.instancias : null,
      aproximado: !!(cat && cat.aproximado), llamadas: x.n, errores: x.errores, ...resumirDuraciones(x.duraciones)
    };
  }).sort((p, q) => q.llamadas - p.llamadas);

  // ---- causas / masivo
  const lista = [...causas.values()].map((c) => {
    const llamadasAfectadas = [...c.metodos.keys()].reduce((s, m) => s + (llamadasPorMetodo.get(m) || 0), 0);
    const tasa = llamadasAfectadas ? c.errores / llamadasAfectadas : 0;
    const masivo = c.clientes.size >= u.minClientes && c.errores >= u.minErrores && llamadasAfectadas >= u.minLlamadas && tasa >= u.minTasa;
    const topN = (m) => [...m.entries()].map(([k, v]) => ({ valor: k, n: v })).sort((x, y) => y.n - x.n);
    const totalNodos = [...c.nodos.values()].reduce((s, v) => s + v, 0);
    const nodosOrden = topN(c.nodos);
    return {
      clave: c.clave, tipo: c.tipo, categoria: c.categoria, titulo: c.titulo, codigo: c.codigo,
      servicioAce: c.servicioAce || null,
      catalogo: c.servicioAce && catalogo ? catalogo.describir(c.servicioAce.id, c.servicioAce.servicio, c.servicioAce.operacion) : null,
      detalleBanco: c.detalleBanco || null, falla: c.falla || null, significadoApp: c.significadoApp || null,
      codigos: c.codigos || null,
      errores: c.errores, clientesAfectados: c.clientes.size, llamadasAfectadas, tasaError: tasa, masivo,
      primera: traza.formatearNaive(c.primera), ultima: traza.formatearNaive(c.ultima),
      duracion: resumirDuraciones(c.duraciones),
      metodos: topN(c.metodos), nodos: nodosOrden, versiones: topN(c.versiones), plataformas: topN(c.plataformas),
      concentracionNodo: totalNodos && nodosOrden.length ? nodosOrden[0].n / totalNodos : null,
      porMinuto: [...c.porMinuto.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([minuto, n]) => ({ minuto, n })),
      muestras: c.muestras,
      clientes: [...c.clientes].slice(0, 500)
    };
  }).sort((x, y) => Number(y.masivo) - Number(x.masivo) || y.clientesAfectados - x.clientesAfectados || y.errores - x.errores);

  const codigos = [...codigosVistos.values()].map((c) => ({
    tipo: c.tipo, codigo: c.codigo, categoria: c.categoria, significado: c.significado, fuente: c.fuente, veces: c.veces,
    descripciones: [...c.descripciones.entries()].map(([texto, n]) => ({ texto, n })).sort((a, b) => b.n - a.n).slice(0, 3)
  })).sort((a, b) => b.veces - a.veces);

  return {
    muestra: {
      clientes: clientesTotales.size, operaciones: totalOps, errores: totalErrores,
      desde: Number.isFinite(tMin) ? traza.formatearNaive(tMin) : null, hasta: Number.isFinite(tMax) ? traza.formatearNaive(tMax) : null
    },
    umbrales: u,
    latencia, ace, causas: lista, codigos
  };
}

module.exports = { analizarMuestra, resumirDuraciones, percentilRango, causaDeOperacion, MUESTRA_MIN_P95 };
