// ============================================================================
// VALIDACIÓN DE LA CARGA DE PRODUCTOS DEL CLIENTE (App Móvil)
// ============================================================================
// Módulo PURO (sin base de datos). Recibe las OPERACIONES ya interpretadas por
// utils/appMovilTraza.js (interpretarFilas) y el catálogo ACE, y responde:
//
//   ¿Se cargaron los productos del cliente? ¿cuánto tardó cada parte y el total?
//   ¿qué falló y por qué? ¿qué es dato y qué es hipótesis?
//
// QUÉ ES UNA "CARGA": la home de productos la arman estas operaciones
// (verificado con logs reales; ver COMPONENTES). Se agrupan en una carga mientras
// no pasen más de GAP_CARGA_MS (20 s) sin actividad de ninguna de ellas (la cadena
// real es secuencial: tarjetas de crédito -> KMT -> mora, así que una espera larga
// de una parte NO parte la carga en dos). Una carga necesita al menos una de las
// dos listas de productos (cuentas / crédito) con su "inicio" registrado.
//
// PRECISIÓN (se informa en pantalla):
//   * LogApp guarda la hora con resolución de 1 segundo. Toda duración es la
//     diferencia entre dos filas, con error máximo de ±1 s por duración.
//   * Una duración solo se muestra cuando el log tiene el INICIO y el FIN de la
//     operación. Operaciones con solo inicio ("sin detalle") o solo con el error
//     final (sin inicio) tienen duración DESCONOCIDA: nunca se muestra "0 s".
//   * Dos llamadas simultáneas del mismo método (p. ej. dos recargas seguidas) se
//     emparejan por orden de inserción (Codigo); si se solapan, se avisa.
//   * EVIDENCIA = lo que dicen las filas. HIPÓTESIS = interpretación, siempre
//     rotulada así y con lo que la sustenta. Nada se rellena ni se estima.
// ============================================================================

const traza = require('./appMovilTraza');
const { traducirItem, TEXTO_FASE, traducirMensajeApp } = require('./appMovilCodigos');

const GAP_CARGA_MS = 20 * 1000;
const VENTANA_LOGIN_MS = 60 * 1000;
const REINTENTO_SESION_MS = 5 * 60 * 1000;
const METODOS_LOGIN = new Set(['login_api', 'Login']);

// Componentes de la carga. `aceEsperado` solo se usa si el log no trae la fila
// ACE (p. ej. operación "sin detalle"); en ese caso se rotula como deducido.
const COMPONENTES = [
  {
    clave: 'cuentas', metodo: 'getAccountListCardInfoLite', requerido: true, orden: 1,
    nombre: 'Cuentas y tarjetas débito (lista rápida)',
    que: 'Trae la lista de productos de depósito del cliente (cuentas, tarjetas débito).',
    aceEsperado: { id: 'C004', servicio: 'AccountListInq', operacion: 'getAcctListInfoLite' }
  },
  {
    clave: 'credito', metodo: 'getAccountListCardInfo', requerido: true, orden: 2,
    nombre: 'Tarjetas de crédito',
    que: 'Trae las tarjetas de crédito del cliente. Encadena: lista de tarjetas (C004) → bloqueos de cada tarjeta (C097) → tarjetas por moneda (C091).',
    aceEsperado: { id: 'C004', servicio: 'AccountListInq', operacion: 'getAccountListCardInfo' }
  },
  {
    clave: 'estado', metodo: 'getStatusMediaInfo', requerido: false, orden: 3,
    nombre: 'Estado de las tarjetas (plásticos)',
    que: 'Consulta el estado de los medios/tarjetas del cliente (activa, bloqueada, etc.).',
    aceEsperado: { id: 'C024', servicio: 'CardInq', operacion: 'getStatusMediaInfo' }
  },
  {
    clave: 'kmt', metodo: 'getKMTAccumulated', requerido: false, orden: 4,
    nombre: 'Fidelización (KMT acumulado)',
    que: 'Consulta el acumulado del programa de fidelización del cliente.',
    aceEsperado: { id: 'C004', servicio: 'AccountListInq', operacion: 'getAcctListFidInfo' }
  },
  {
    clave: 'mora', metodo: 'getProductsArrears', requerido: false, orden: 5,
    nombre: 'Mora de productos',
    que: 'Consulta si el cliente tiene productos en mora. "Sin datos" es lo normal cuando no hay mora.',
    aceEsperado: null
  }
];
const POR_METODO = new Map(COMPONENTES.map((c) => [c.metodo, c]));
const ANCLAS = new Set(['getAccountListCardInfoLite', 'getAccountListCardInfo']);

const fmt = (ms) => traza.formatoDur(ms);
const hora = (ms) => traza.formatearNaive(ms).slice(11);

// ------------------------------------------------------------------ intentos
function pasosDe(op, catalogo) {
  const pasos = [];
  for (const it of op.items) {
    if (it.tipo !== 'soap' && it.tipo !== 'api' && it.tipo !== 'error') continue;
    const paso = {
      tipo: it.tipo,
      titulo: it.titulo,
      nivel: it.nivel,
      texto: it.texto,
      hora: it.hora,
      esperaMs: it.esperaMs || 0,
      lento: !!it.lento,
      destino: it.destino || null,
      codigoHttp: it.tipo === 'api' ? it.codigo : null,
      transaccion: it.transaccion || null,
      falla: it.falla || null,
      sinDatos: !!it.sinDatos,
      manejado: !!it.manejado,
      codigos: traducirItem(it)
    };
    if (it.servicioAce && catalogo) paso.catalogo = catalogo.describir(it.servicioAce.id, it.servicioAce.servicio, it.servicioAce.operacion);
    pasos.push(paso);
  }
  return pasos;
}

function crearIntento(op, catalogo, infoFila) {
  const sinMedicion = op.sinInicio || op.estado === 'sin_detalle';
  const fila = op.primeraFila || {};
  const info = infoFila ? infoFila(fila) : {};
  return {
    t: op.t,
    fin: op.fin,
    inicio: traza.formatearNaive(op.t),
    finTexto: traza.formatearNaive(op.fin),
    duracionMs: sinMedicion ? null : op.duracionMs,
    sinInicio: !!op.sinInicio,
    estado: op.estado,
    resultado: op.resultado || null,
    lentitud: op.lentitud || null,
    mensaje: op.mensaje || null,
    pasoLento: op.pasoLento || null,
    nodo: info.nodo || null,
    version: info.version || null,
    equipo: info.equipo || null,
    pasos: pasosDe(op, catalogo),
    _op: op
  };
}

/** Causa breve y legible de un intento con error (sin volcar el XML ni el texto técnico completo). */
function causaCorta(intento) {
  const soap = intento.pasos.find((p) => p.tipo === 'soap' && p.nivel === 'error');
  if (soap && soap.falla && soap.falla.esTimeout) {
    const f = soap.falla;
    return `ACE agotó el tiempo de espera${f.segundosLimite ? ` (${f.segundosLimite} s)` : ''}${f.servicioActor ? ` en ${f.servicioActor}` : ''}.`;
  }
  if (soap) return soap.texto.length > 200 ? `${soap.texto.slice(0, 199)}…` : soap.texto;
  const err = intento.pasos.find((p) => p.tipo === 'error' && p.nivel === 'error');
  if (err) {
    const m = traducirMensajeApp(err.texto);
    const t = m ? m.significado : err.texto;
    return t.length > 200 ? `${t.slice(0, 199)}…` : t;
  }
  return intento.mensaje ? (intento.mensaje.length > 200 ? `${intento.mensaje.slice(0, 199)}…` : intento.mensaje) : 'Terminó con error.';
}

/** Estado de UN componente a partir de todos sus intentos dentro de la carga. */
function evaluarComponente(def, intentos, catalogo) {
  const comp = {
    clave: def.clave, metodo: def.metodo, nombre: def.nombre, que: def.que, requerido: def.requerido,
    intentos: [], numIntentos: intentos.length
  };
  if (!intentos.length) {
    comp.veredicto = 'NO_REGISTRADO';
    comp.veredictoTexto = def.requerido
      ? 'No hay ninguna fila de esta operación dentro de la carga (el log no la registra).'
      : 'No se registró en esta carga (la app no la pidió o el log no la contiene).';
    comp.inicio = null; comp.fin = null; comp.duracionMs = null;
    comp.ace = def.aceEsperado && catalogo ? [{ deducido: true, ...catalogo.describir(def.aceEsperado.id, def.aceEsperado.servicio, def.aceEsperado.operacion) }] : [];
    return comp;
  }
  const ordenados = intentos.slice().sort((a, b) => a.t - b.t || (a._op.c || 0) - (b._op.c || 0));
  comp.intentos = ordenados.map(({ _op, ...resto }) => resto);

  // Estado final = el del último intento que sí trae un resultado; así se ve con
  // qué se quedó el cliente. Si todos son "sin detalle", queda sin confirmar.
  const decisivos = ordenados.filter((i) => i.estado !== 'sin_detalle');
  const ultimo = decisivos.length ? decisivos[decisivos.length - 1] : null;
  const falloAntes = ordenados.filter((i) => i.estado === 'error').length;
  comp.fallidos = falloAntes;
  comp.exitosos = ordenados.filter((i) => i.estado === 'exito' || (i.estado === 'advertencia' && i.resultado === 'Respuesta lenta')).length;
  comp.sinDetalle = ordenados.filter((i) => i.estado === 'sin_detalle').length;

  if (!ultimo) {
    comp.veredicto = 'SIN_CONFIRMAR';
    comp.veredictoTexto = 'El log solo registra el inicio: no guarda la respuesta, así que no se puede confirmar si respondió.';
  } else if (ultimo.estado === 'error') {
    comp.veredicto = 'ERROR';
    comp.veredictoTexto = causaCorta(ultimo);
  } else if (ultimo.estado === 'advertencia' && ultimo.resultado !== 'Respuesta lenta') {
    comp.veredicto = 'AVISO';
    comp.veredictoTexto = ultimo.mensaje || 'Respondió sin resultados.';
  } else if (ultimo.lentitud) {
    comp.veredicto = 'OK_LENTA';
    comp.veredictoTexto = ultimo.duracionMs !== null ? `Respondió correctamente pero tardó ${fmt(ultimo.duracionMs)}.` : 'Respondió correctamente, con lentitud (la duración exacta no se puede medir: falta la fila de inicio).';
  } else if (ultimo.resultado === 'Sin datos') {
    comp.veredicto = 'OK_SIN_DATOS';
    // El "sin datos" de la lista de crédito casi siempre viene de la consulta de bloqueos (C097): significa
    // que la tarjeta NO tiene bloqueos. Solo es "el cliente no tiene el producto" si la lista principal lo dice.
    const sinDatosPasos = ultimo.pasos.filter((p) => p.sinDatos || p.manejado);
    const soloBloqueos = def.clave === 'credito' && sinDatosPasos.length
      && sinDatosPasos.every((p) => p.manejado || (p.catalogo && p.catalogo.codigo === 'C097') || /\(C097\)/.test(p.titulo));
    comp.veredictoTexto = soloBloqueos
      ? 'Respondió correctamente. El único "sin datos" es el de bloqueos (C097 getBlockQuery): la tarjeta no tiene bloqueos, es una respuesta normal.'
      : 'Respondió correctamente: el sistema del banco informó que no hay datos para este cliente (no es una falla).';
  } else {
    comp.veredicto = 'OK';
    comp.veredictoTexto = 'Respondió correctamente.';
  }
  if (comp.veredicto.startsWith('OK') && falloAntes) {
    comp.veredictoTexto += ` Antes hubo ${falloAntes} intento${falloAntes === 1 ? '' : 's'} con error en esta misma carga.`;
  }

  // Lo que la operación procesó (conteos tomados de las filas del log, no del listado oficial).
  const ops = ordenados.map((i) => i._op);
  const tarjetas = Math.max(0, ...ops.map((o) => o.nPorMoneda || 0));
  const medios = new Set(ops.flatMap((o) => [...(o.mediosAcct || [])]));
  if (def.clave === 'credito') comp.tarjetasCreditoConsultadas = tarjetas;
  if (def.clave === 'cuentas') comp.cuentasConMedio = medios.size;

  comp.inicio = ordenados[0].inicio;
  const conMedida = ordenados.filter((i) => i.duracionMs !== null);
  comp.fin = ordenados.reduce((m, i) => (i.fin > m.fin ? i : m), ordenados[0]).finTexto;
  // Duración del componente = la del último intento decisivo medible (lo que vivió el cliente).
  comp.duracionMs = ultimo && ultimo.duracionMs !== null ? ultimo.duracionMs : (conMedida.length ? conMedida[conMedida.length - 1].duracionMs : null);
  comp.duracionMaxMs = conMedida.length ? Math.max(...conMedida.map((i) => i.duracionMs)) : null;
  comp.duracionMinMs = conMedida.length ? Math.min(...conMedida.map((i) => i.duracionMs)) : null;
  comp.solapados = ordenados.some((a, i) => ordenados.slice(i + 1).some((b) => b.t <= a.fin && a.t !== b.t));

  // ACE: se resumen las llamadas ACE que SÍ aparecen en el log (únicas por catálogo).
  const vistos = new Map();
  for (const i of ordenados) for (const p of i.pasos) {
    if (p.tipo !== 'soap' || !p.catalogo) continue;
    const k = `${p.catalogo.codigo}|${p.catalogo.operacion || p.titulo}`;
    const e = vistos.get(k) || { ...p.catalogo, veces: 0, errores: 0, maxEsperaMs: 0 };
    e.veces += 1;
    if (p.nivel === 'error') e.errores += 1;
    e.maxEsperaMs = Math.max(e.maxEsperaMs, p.esperaMs || 0);
    vistos.set(k, e);
  }
  comp.ace = [...vistos.values()];
  if (!comp.ace.length && def.aceEsperado && catalogo) {
    comp.ace = [{ deducido: true, ...catalogo.describir(def.aceEsperado.id, def.aceEsperado.servicio, def.aceEsperado.operacion) }];
  }
  return comp;
}

// ------------------------------------------------------------ segmentación
function segmentar(ops) {
  const candidatas = ops
    .filter((o) => POR_METODO.has(o.metodo))
    .sort((a, b) => a.t - b.t || (a.c || 0) - (b.c || 0));
  const grupos = [];
  let actual = null;
  let finMax = 0;
  for (const o of candidatas) {
    if (!actual || o.t - finMax > GAP_CARGA_MS) {
      actual = [];
      grupos.push(actual);
      finMax = o.fin;
    }
    actual.push(o);
    finMax = Math.max(finMax, o.fin);
  }
  const cargas = [];
  const sueltos = [];
  for (const g of grupos) {
    // Es una carga si una de las dos listas tiene su inicio registrado, o si aparecen las dos
    // (el log puede empezar a mitad de la carga). Una lista de crédito suelta es la pantalla de tarjetas, no la home.
    const hayAncla = g.some((o) => ANCLAS.has(o.metodo) && !o.sinInicio)
      || (g.some((o) => o.metodo === 'getAccountListCardInfoLite') && g.some((o) => o.metodo === 'getAccountListCardInfo'));
    if (hayAncla) cargas.push(g); else sueltos.push(...g);
  }
  return { cargas, sueltos };
}

// ----------------------------------------------------- evidencia e hipótesis
function conjuntoNodos(carga) {
  return [...new Set(carga.componentes.flatMap((c) => c.intentos.map((i) => i.nodo)).filter(Boolean))];
}

function construirHallazgos(carga, ctx) {
  const evidencia = [];
  const hipotesis = [];
  const E = (texto, extra) => evidencia.push({ texto, ...(extra || {}) });
  const H = (texto, soporte, confianza) => hipotesis.push({ texto, soporte: soporte || [], confianza: confianza || 'media' });

  const comps = carga.componentes;
  const porClave = Object.fromEntries(comps.map((c) => [c.clave, c]));

  // 1) Fallas con su causa literal (códigos traducidos + fase del timeout).
  for (const c of comps) {
    for (const [idx, i] of c.intentos.entries()) {
      if (i.estado !== 'error') continue;
      const soap = i.pasos.find((p) => p.tipo === 'soap' && p.nivel === 'error');
      const err = i.pasos.filter((p) => p.tipo === 'error' && p.nivel === 'error');
      const dur = i.duracionMs !== null ? `tras ${fmt(i.duracionMs)}` : 'con duración desconocida (el log no tiene el inicio de esta llamada)';
      if (soap && soap.falla) {
        const f = soap.falla;
        const ace = soap.catalogo && soap.catalogo.encontrado ? ` — ${soap.catalogo.descripcion || soap.catalogo.servicio} (${soap.catalogo.codigo} ${soap.catalogo.operacion || ''}${soap.catalogo.aproximado ? ', coincidencia aproximada' : ''})` : '';
        E(`${c.nombre}: ACE devolvió "${f.mensaje}" a las ${i.inicio.slice(11)} ${dur}${f.segundosLimite ? `; límite de ACE: ${f.segundosLimite} s` : ''}${f.nodoIntegracion ? `; nodo de integración: ${f.nodoIntegracion}` : ''}${f.servicioActor ? `; servicio: ${f.servicioActor}` : ''}${ace}.`, { tipo: 'timeout', componente: c.clave, transaccion: soap.transaccion });
        if (f.fase) E(`${c.nombre}: ${TEXTO_FASE[f.fase]}`, { tipo: 'fase_timeout', componente: c.clave });
      } else if (soap) {
        const cod = soap.codigos && soap.codigos[0];
        const trad = cod && (cod.ace || cod.servidor);
        E(`${c.nombre}: ACE respondió con error ${dur}: ${soap.texto}${trad && trad.significado ? ` — significado: ${trad.significado}` : ''}`, { tipo: 'error_ace', componente: c.clave, transaccion: soap.transaccion });
      } else if (err.length) {
        const t = err.map((e) => e.texto).join(' · ');
        const m = traducirMensajeApp(t);
        E(`${c.nombre}: la app registró un error ${dur}: ${t}${m ? ` — ${m.significado}` : ''}${i.pasos.some((p) => p.tipo === 'soap') ? '' : ' (no hay fila de respuesta de ACE: el log no muestra que ACE haya contestado)'}`, { tipo: 'error_app', componente: c.clave });
      } else {
        E(`${c.nombre}: terminó con error ${dur}: ${i.mensaje || ''}`, { tipo: 'error', componente: c.clave });
      }
    }
  }

  // 2) Lentitud: qué paso concentró la espera (dato) y el catálogo de ese paso.
  for (const c of comps) {
    for (const i of c.intentos) {
      if (i.estado === 'error' || i.duracionMs === null) continue; // las fallas ya se explican arriba
      if (!i.lentitud && i.duracionMs < traza.LENTA_MS) continue;
      const pasos = i.pasos.filter((p) => p.esperaMs > 0 && p.tipo !== 'error').sort((a, b) => b.esperaMs - a.esperaMs);
      const top = pasos[0];
      if (top && top.esperaMs >= traza.LENTA_MS) {
        const cat = top.catalogo && top.catalogo.encontrado ? top.catalogo : null;
        E(`${c.nombre}: tardó ${fmt(i.duracionMs)} (${i.inicio.slice(11)}). La mayor espera (${fmt(top.esperaMs)}) fue hasta la respuesta de "${top.titulo}"${cat ? ` — ${cat.descripcion || ''}${cat.instancias !== null ? `; ${cat.instancias === 0 ? 'el catálogo no registra instancias para esa operación' : `el catálogo registra ${cat.instancias} instancia(s)`}` : ''}` : ''}.`, { tipo: 'lentitud', componente: c.clave });
        if (cat && cat.operacionBackend && top.nivel !== 'error') {
          H(`El cuello de botella de "${c.nombre}" estaría en "${top.titulo}" (sistema detrás: ${cat.operacionBackend}).`, [`Evidencia: la respuesta llegó ${fmt(top.esperaMs)} después del paso anterior.`], top.esperaMs >= 10000 ? 'media' : 'baja');
        }
      } else if (i.duracionMs !== null) {
        E(`${c.nombre}: tardó ${fmt(i.duracionMs)} (${i.inicio.slice(11)}) sin un paso individual que concentre la espera: el log no separa más el tiempo.`, { tipo: 'lentitud', componente: c.clave });
      }
    }
  }

  // 3) Hechos del catálogo que explican por qué es sensible a la espera.
  const conTimeout = comps.filter((c) => c.intentos.some((i) => i.pasos.some((p) => p.falla && p.falla.esTimeout)));
  for (const c of conTimeout) {
    const cat = (c.ace || []).find((a) => a.encontrado && !a.deducido && a.instancias !== null);
    if (cat) {
      E(`Catálogo ACE de ${cat.codigo} ${cat.operacion}: versión ${cat.version || 's/d'}, ${cat.instancias} instancia(s), ${cat.compuestos ?? 's/d'} servicio(s) compuesto(s), ${cat.atomicos ?? 's/d'} atómico(s), ${cat.asincrono ? 'asíncrono' : 'síncrono'}${cat.operacionBackend ? `; operación en el core: ${cat.operacionBackend}` : ''}.`, { tipo: 'catalogo', componente: c.clave });
      if (cat.instancias !== null && cat.instancias <= 1) {
        H(`${cat.operacion} (${cat.codigo}) figura con ${cat.instancias} instancia(s) en el catálogo: si varias consultas llegan juntas, no hay otra instancia que las absorba y puede agotarse el tiempo (30 s).`, ['Dato: catálogo ACE (columna Instancias).', 'Dato: timeout registrado en este recorrido.'], 'baja');
      }
    }
  }
  const primerTimeout = conTimeout.length ? conTimeout[0] : null;
  if (primerTimeout) {
    const fases = new Set();
    for (const i of primerTimeout.intentos) for (const p of i.pasos) if (p.falla && p.falla.fase) fases.add(p.falla.fase);
    if (fases.has('dentro_flujo')) H('El tiempo se agotó con el mensaje ya dentro de ACE: lo más probable es que el sistema que ACE consulta detrás (core de tarjetas) no respondió en 30 s, no que la app o la red tengan el problema.', ['Dato: texto de ACE "reached the main flow, but timed out during processing".'], 'media');
    if (fases.has('antes_flujo')) H('El tiempo se agotó antes de entrar al flujo de ACE: apunta a saturación/cola del nodo de integración o de la entrada del servicio.', ['Dato: texto de ACE "timed out before it reached the main flow".'], 'media');
  }

  // 3b) Qué productos procesó el backend (conteos desde las filas del log).
  const cr = porClave.credito, cu = porClave.cuentas;
  if (cu && cu.cuentasConMedio) E(`Cuentas/productos con tarjeta o medio encontrados por el servicio de cuentas: ${cu.cuentasConMedio} (filas "Medios encontrados con AcctID" del log).`, { tipo: 'productos' });
  if (cr && cr.tarjetasCreditoConsultadas) E(`Tarjetas de crédito procesadas: ${cr.tarjetasCreditoConsultadas} (una consulta de bloqueos y una de tarjetas por moneda por cada tarjeta).`, { tipo: 'productos' });

  // 4) Repeticiones: la app pidió lo mismo varias veces en la misma carga.
  for (const c of comps) {
    if (c.numIntentos >= 3 || (c.numIntentos >= 2 && c.fallidos > 0)) {
      const horas = c.intentos.map((i) => i.inicio.slice(11)).join(', ');
      E(`${c.nombre}: se solicitó ${c.numIntentos} veces en esta carga (${horas}).`, { tipo: 'repeticion', componente: c.clave });
    }
  }
  const repetidos = comps.filter((c) => c.numIntentos >= 2 && c.fallidos > 0);
  if (repetidos.length) {
    H('Las solicitudes repetidas parecen reintentos de la app/cliente mientras la primera no respondía (cada intento extra suma carga al mismo servicio).', repetidos.map((c) => `Dato: ${c.nombre} se pidió ${c.numIntentos} veces y ${c.fallidos} fallaron.`), 'media');
  }

  // 5) Encadenamiento: KMT/mora arrancan cuando termina la anterior.
  const cred = porClave.credito, kmt = porClave.kmt;
  if (cred && kmt && cred.intentos.length && kmt.intentos.length) {
    const finCred = Math.max(...cred.intentos.map((i) => i.fin));
    const primerKmt = Math.min(...kmt.intentos.map((i) => i.t));
    const dif = primerKmt - finCred;
    if (dif >= 0 && dif <= 2000 && cred.duracionMs !== null && cred.duracionMs >= traza.LENTA_MS) {
      E(`El acumulado KMT empezó ${dif < 1000 ? 'en el mismo segundo' : `${fmt(dif)} después`} de terminar la carga de tarjetas de crédito (${hora(finCred)}).`, { tipo: 'secuencia' });
      H('KMT parece esperar a que termine la lista de tarjetas de crédito: una espera larga en crédito retrasa también KMT y mora (tiempo total de la carga).', ['Dato: horas de fin de crédito e inicio de KMT casi iguales.'], 'media');
    }
  }

  // 6) Sin detalle: no se puede afirmar nada.
  for (const c of comps) {
    if (c.sinDetalle) {
      E(`${c.nombre}: ${c.sinDetalle} solicitud(es) con solo la fila de inicio (${c.intentos.filter((i) => i.estado === 'sin_detalle').map((i) => i.inicio.slice(11)).join(', ')}). El log no guarda la respuesta de esas llamadas; no se puede confirmar ni descartar que hayan respondido.`, { tipo: 'sin_detalle', componente: c.clave });
    }
  }

  if (carga.inicioParcial) {
    E('El log de este cliente empieza a mitad de esta carga (alguna lista no tiene su fila de inicio): los tiempos de esa parte son parciales o no se pueden medir.', { tipo: 'parcial' });
  }

  // 7) Dónde ocurrió (nodo).
  const nodos = conjuntoNodos(carga);
  if (nodos.length) E(`Atendida por ${nodos.length === 1 ? 'el nodo' : 'los nodos'} ${nodos.join(', ')}.`, { tipo: 'nodo' });

  // 8) Reintento de sesión tras fallo.
  if (carga.reintentoSesion) {
    E(`Nuevo inicio de sesión del cliente ${fmt(carga.reintentoSesion.despuesMs)} después de esta carga (${carga.reintentoSesion.hora}).`, { tipo: 'sesion' });
    if (carga.veredicto === 'FALLA' || carga.veredicto === 'PARCIAL') H('El cliente volvió a iniciar sesión poco después de una carga con fallas: es consistente con que no logró ver sus productos y reintentó (no se puede saber su intención con el log).', ['Dato: login exitoso posterior dentro de 5 min.'], 'baja');
  }
  if (ctx && ctx.posiblesRespuestas && ctx.posiblesRespuestas.length) {
    for (const p of ctx.posiblesRespuestas) H(p.texto, p.soporte, 'baja');
  }
  const unicos = (lista) => {
    const vistos = new Set();
    return lista.filter((x) => (vistos.has(x.texto) ? false : (vistos.add(x.texto), true)));
  };
  return { evidencia: unicos(evidencia), hipotesis: unicos(hipotesis) };
}

// ------------------------------------------------------------- veredicto
function veredictoCarga(comps) {
  const requeridos = comps.filter((c) => c.requerido);
  const opcionales = comps.filter((c) => !c.requerido);
  const malos = (lista) => lista.filter((c) => c.veredicto === 'ERROR');
  const fallasReq = malos(requeridos);
  const fallasOpc = malos(opcionales);
  const sinConfirmarReq = requeridos.filter((c) => c.veredicto === 'SIN_CONFIRMAR' || c.veredicto === 'NO_REGISTRADO');
  const lentos = comps.filter((c) => c.veredicto === 'OK_LENTA' || (c.veredicto.startsWith('OK') && c.duracionMs !== null && c.duracionMs >= traza.LENTA_MS));
  const lista = (cs) => cs.map((c) => c.nombre).join(', ');

  if (fallasReq.length) {
    return { veredicto: 'FALLA', productos: fallasReq.length === requeridos.length ? 'NO' : 'PARCIAL', texto: `No se cargaron todos los productos: falló ${lista(fallasReq)}.` };
  }
  if (sinConfirmarReq.length) {
    return { veredicto: 'SIN_CONFIRMAR', productos: 'SIN_CONFIRMAR', texto: `No se puede confirmar: ${lista(sinConfirmarReq)} no tiene respuesta registrada en el log.` };
  }
  if (fallasOpc.length) {
    return { veredicto: 'PARCIAL', productos: 'SI', texto: `Los productos se cargaron; falló información complementaria: ${lista(fallasOpc)}.` };
  }
  if (lentos.length) {
    return { veredicto: 'COMPLETA_LENTA', productos: 'SI', texto: `Los productos se cargaron, con lentitud en ${lista(lentos)}.` };
  }
  return { veredicto: 'COMPLETA', productos: 'SI', texto: 'Los productos se cargaron correctamente.' };
}

// ---------------------------------------------------------------- principal
/**
 * @param {Array} operaciones salida de traza.interpretarFilas (de UN cliente)
 * @param {{catalogo?:object, infoFila?:(fila)=>{nodo,version,equipo}}} opc
 */
function analizarCargas(operaciones, opc) {
  const catalogo = opc && opc.catalogo;
  const infoFila = opc && opc.infoFila;
  const ops = operaciones.slice().sort((a, b) => a.t - b.t || (a.c || 0) - (b.c || 0));
  const logins = ops.filter((o) => METODOS_LOGIN.has(o.metodo) && o.estado === 'exito');
  const { cargas: grupos, sueltos } = segmentar(ops);

  const cargas = grupos.map((g, idx) => {
    const t0 = Math.min(...g.map((o) => o.t));
    const tFin = Math.max(...g.map((o) => o.fin));
    const intentosPorMetodo = new Map();
    for (const o of g) {
      if (!intentosPorMetodo.has(o.metodo)) intentosPorMetodo.set(o.metodo, []);
      intentosPorMetodo.get(o.metodo).push(crearIntento(o, catalogo, infoFila));
    }
    // La home pide las dos listas a la vez. Si solo aparece la de cuentas es una actualización de
    // cuentas (no se exige la de crédito); si solo aparece la de crédito, es la pantalla de tarjetas.
    const hayCuentas = intentosPorMetodo.has('getAccountListCardInfoLite');
    const hayCredito = intentosPorMetodo.has('getAccountListCardInfo');
    const alcance = hayCuentas && hayCredito ? 'home' : hayCuentas ? 'cuentas' : 'credito';
    const componentes = COMPONENTES.map((def) => {
      const d = { ...def };
      if (alcance === 'cuentas' && d.metodo === 'getAccountListCardInfo') d.requerido = false;
      if (alcance === 'credito' && d.metodo === 'getAccountListCardInfoLite') d.requerido = false;
      return evaluarComponente(d, intentosPorMetodo.get(def.metodo) || [], catalogo);
    });
    const v = veredictoCarga(componentes);

    const login = logins.filter((l) => l.fin <= t0 + 2000 && t0 - l.fin <= VENTANA_LOGIN_MS).pop() || null;
    const siguienteLogin = logins.find((l) => l.t > tFin && l.t - tFin <= REINTENTO_SESION_MS && !g.includes(l)) || null;

    // Tiempo hasta ver productos: primer momento en que cada lista tuvo una respuesta correcta
    // (lo más pronto que el cliente pudo ver su pantalla), medido desde el inicio de la carga.
    const primerExito = (metodo) => {
      const fines = g
        .filter((o) => o.metodo === metodo && !o.sinInicio && (o.estado === 'exito' || (o.estado === 'advertencia' && o.resultado === 'Respuesta lenta')))
        .map((o) => o.fin);
      return fines.length ? Math.min(...fines) : null;
    };
    const fCuentas = primerExito('getAccountListCardInfoLite');
    const fCredito = primerExito('getAccountListCardInfo');
    const listasNecesarias = alcance === 'home' ? [fCuentas, fCredito] : alcance === 'cuentas' ? [fCuentas] : [fCredito];
    const hayListasOk = listasNecesarias.every((x) => x !== null);
    const finListas = hayListasOk ? listasNecesarias : [];
    const inicioParcial = g.some((o) => ANCLAS.has(o.metodo) && o.sinInicio);

    const carga = {
      id: idx + 1,
      inicio: traza.formatearNaive(t0),
      fin: traza.formatearNaive(tFin),
      duracionTotalMs: tFin - t0,
      inicioParcial,
      tiempoProductosMs: hayListasOk && finListas.length ? Math.max(...finListas) - t0 : null,
      alcance,
      alcanceTexto: alcance === 'home' ? 'Carga completa de productos (cuentas + tarjetas de crédito)' : alcance === 'cuentas' ? 'Actualización de cuentas (sin consultar tarjetas de crédito)' : 'Consulta de tarjetas de crédito',
      disparo: login ? 'login' : 'recarga',
      disparoTexto: login ? `Después de iniciar sesión (login ${hora(login.t)}${login.duracionMs > 0 ? `, ${fmt(login.duracionMs)}` : ''})` : 'Recarga o navegación (sin inicio de sesión inmediato)',
      loginAnteriorMs: login ? t0 - login.fin : null,
      reintentoSesion: siguienteLogin ? { hora: hora(siguienteLogin.t), despuesMs: siguienteLogin.t - tFin } : null,
      veredicto: v.veredicto,
      productos: v.productos,
      veredictoTexto: v.texto,
      componentes
    };
    const hall = construirHallazgos(carga, null);
    carga.evidencia = hall.evidencia;
    carga.hipotesis = hall.hipotesis;
    return carga;
  });

  // Errores de estas operaciones fuera de una carga (p. ej. el error final sin inicio registrado).
  const eventosSueltos = sueltos.map((o) => {
    const def = POR_METODO.get(o.metodo);
    const it = crearIntento(o, catalogo, infoFila);
    const { _op, ...resto } = it;
    return { componente: def.nombre, clave: def.clave, ...resto };
  });

  // Hipótesis de pareo. LogApp no trae un identificador que una el INICIO de una llamada con su
  // RESPUESTA, y la respuesta puede registrarse mucho después (hasta ~1 min o más en las llamadas
  // lentas). Cuando hay un inicio sin respuesta y, después, una respuesta del mismo método sin su
  // fila de inicio, se SUGIERE el pareo como hipótesis (nunca se usa para medir tiempos).
  // Cada inicio solo puede explicar UNA respuesta (la más cercana, en orden de llegada).
  const MAX_PAREO_MS = 4 * 60 * 1000;
  const porClave = new Map();
  const agregarCand = (clave, nombre, intento, cargaId) => {
    if (!porClave.has(clave)) porClave.set(clave, []);
    porClave.get(clave).push({ nombre, intento, cargaId });
  };
  for (const c of cargas) for (const comp of c.componentes) for (const i of comp.intentos) agregarCand(comp.clave, comp.nombre, i, c.id);
  for (const e of eventosSueltos) agregarCand(e.clave, e.componente, e, null);
  for (const [clave, lista] of porClave) {
    lista.sort((x, y) => x.intento.t - y.intento.t);
    const usados = new Set();
    for (const huerfano of lista) {
      const h = huerfano.intento;
      if (!h.sinInicio || h.estado === 'sin_detalle') continue;
      let mejor = null;
      for (const cand of lista) {
        const i = cand.intento;
        if (i.estado !== 'sin_detalle' || usados.has(i) || i.t >= h.t) continue;
        const dif = h.t - i.t;
        if (dif <= MAX_PAREO_MS && (!mejor || dif < mejor.dif)) mejor = { dif, cand };
      }
      if (!mejor) continue;
      usados.add(mejor.cand.intento);
      h.posibleInicio = { desde: mejor.cand.intento.inicio.slice(11), esperaMs: mejor.dif, carga: mejor.cand.cargaId };
      mejor.cand.intento.posibleRespuesta = { hora: h.inicio.slice(11), esperaMs: mejor.dif, estado: h.estado };
      const dueña = cargas.find((x) => x.id === mejor.cand.cargaId);
      if (dueña) {
        const que = h.estado === 'error' ? 'el error' : 'la respuesta';
        dueña.hipotesis.push({
          texto: `${que} de ${huerfano.nombre} de las ${h.inicio.slice(11)} (sin fila de inicio) podría corresponder a la solicitud iniciada a las ${mejor.cand.intento.inicio.slice(11)}: habría tardado ${fmt(mejor.dif)} en responder. No hay un identificador común que lo confirme.`,
          soporte: ['Dato: inicio sin respuesta registrada.', `Dato: ${que} del mismo método sin fila de inicio, ${fmt(mejor.dif)} después.`],
          confianza: 'baja'
        });
      }
    }
  }

  const cont = (v) => cargas.filter((c) => c.veredicto === v).length;
  const resumen = {
    cargas: cargas.length,
    completas: cont('COMPLETA'),
    completasLentas: cont('COMPLETA_LENTA'),
    parciales: cont('PARCIAL'),
    conFallas: cont('FALLA'),
    sinConfirmar: cont('SIN_CONFIRMAR'),
    eventosSueltos: eventosSueltos.length,
    erroresSueltos: eventosSueltos.filter((e) => e.estado === 'error').length
  };
  const medibles = cargas.filter((c) => c.tiempoProductosMs !== null).map((c) => c.tiempoProductosMs).sort((a, b) => a - b);
  const pct = (p) => (medibles.length ? medibles[Math.min(medibles.length - 1, Math.floor(p * medibles.length))] : null);
  resumen.tiempoProductos = medibles.length ? { n: medibles.length, medianaMs: pct(0.5), p90Ms: pct(0.9), maximoMs: medibles[medibles.length - 1], minimoMs: medibles[0] } : null;
  resumen.productos = !cargas.length ? 'SIN_CARGAS'
    : resumen.conFallas ? 'HAY_FALLAS'
      : resumen.sinConfirmar ? 'HAY_SIN_CONFIRMAR'
        : 'TODAS_OK';

  cargas.sort((a, b) => traza.parseNaive(b.inicio) - traza.parseNaive(a.inicio));
  return {
    cargas,
    eventosSueltos,
    resumen,
    umbrales: { lentaMs: traza.LENTA_MS, muyLentaMs: traza.MUY_LENTA_MS, huecoCargaMs: GAP_CARGA_MS, ventanaLoginMs: VENTANA_LOGIN_MS },
    precision: 'Las horas del log tienen resolución de 1 segundo: cada duración es la diferencia entre dos filas y puede variar ±1 s. No se muestra duración cuando el log no tiene el inicio o el fin de la llamada. Evidencia = lo que dicen las filas; hipótesis = interpretación sustentada en esas filas.'
  };
}

// ------------------------------------------------------- texto copiable
const ICONO = { OK: 'OK', OK_SIN_DATOS: 'OK (sin datos)', OK_LENTA: 'OK LENTA', ERROR: 'ERROR', AVISO: 'AVISO', SIN_CONFIRMAR: 'SIN CONFIRMAR', NO_REGISTRADO: 'NO REGISTRADO' };
const TITULO_VEREDICTO = { COMPLETA: 'CARGA COMPLETA', COMPLETA_LENTA: 'CARGA COMPLETA CON LENTITUD', PARCIAL: 'CARGA PARCIAL (falló información complementaria)', FALLA: 'CARGA CON FALLAS', SIN_CONFIRMAR: 'CARGA SIN CONFIRMAR' };

function textoCarga(carga, ctx) {
  const L = [];
  const doc = ctx && ctx.documento ? ` — documento ${ctx.documento}` : '';
  L.push(`Carga de productos${doc}`);
  L.push(`${carga.inicio} → ${carga.fin.slice(11)} · duración total ${fmt(carga.duracionTotalMs)}${carga.tiempoProductosMs !== null ? ` · listas de productos disponibles a los ${fmt(carga.tiempoProductosMs)}` : ''}`);
  L.push(`${TITULO_VEREDICTO[carga.veredicto] || carga.veredicto}: ${carga.veredictoTexto}`);
  L.push(`${carga.alcanceTexto} · ${carga.disparoTexto}`);
  L.push('');
  L.push('Componentes:');
  for (const c of carga.componentes) {
    const dur = c.duracionMs !== null ? ` · ${fmt(c.duracionMs)}${c.duracionMaxMs !== null && c.duracionMaxMs > c.duracionMs ? ` (máx ${fmt(c.duracionMaxMs)})` : ''}` : '';
    const veces = c.numIntentos > 1 ? ` · ${c.numIntentos} solicitudes` : '';
    L.push(`- ${c.nombre}: ${ICONO[c.veredicto] || c.veredicto}${dur}${veces}${c.veredicto === 'NO_REGISTRADO' ? '' : ` — ${c.veredictoTexto}`}`);
  }
  if (carga.evidencia.length) { L.push(''); L.push('Evidencia (dato del log):'); for (const e of carga.evidencia) L.push(`- ${e.texto}`); }
  if (carga.hipotesis.length) { L.push(''); L.push('Hipótesis (interpretación, no confirmada):'); for (const h of carga.hipotesis) L.push(`- [${h.confianza}] ${h.texto}`); }
  return L.join('\n');
}

module.exports = { analizarCargas, textoCarga, COMPONENTES, GAP_CARGA_MS };
