// ==========================================================================
// INTÉRPRETE DE LA TRAZA DE LogApp (App Móvil)
// ==========================================================================
// Módulo PURO (sin base de datos): recibe filas de LogApp.Log de UN cliente y
// las convierte en "operaciones" con su resultado real.
//
// Cómo está escrito el log (verificado con exportaciones reales):
//   * Una operación de negocio (Metodo) NO es "una fila de inicio + una fila de
//     fin". Genera varias filas con el mismo Metodo:
//       - "Inicia flujo - <ruta>"          (Rs vacío; Adicional = lo que envió la app)
//       - "API-<verbo>-<url>"              (Rs = "Status: NNN - <json>")
//       - "ERROR-API-<verbo>-<url>"        (Rs = "Error: ... -- STACK ...")
//       - "Cnnn-<servicio>-<operación>"    (llamada SOAP a ACE; Rs = XML con
//                                           bloques Status: código + severidad)
//       - filas internas ("Mapeo de ...", "Respuesta despues de mappers", ...)
//       - TipoCodigo 3 = error registrado (puede ser inofensivo: p. ej. el
//         mapper que usa un valor por defecto cuando ACE responde "sin datos").
//   * Codigo es autoincremental GLOBAL: ordena las filas y permite saber qué
//     operaciones se solaparon (sus rangos de Codigo se entrelazan).
//   * Fecha viene en hora local de Colombia, con resolución de segundos.
//   * Clave NO es un id de flujo (es una marca de tiempo local).
//
// La lectura de cada fila (¿error?, ¿sin datos?, ¿timeout?) vive en
// appMovilLenguaje.js, para que el recorrido y el visor de logs digan lo mismo.
//
// Estados de una operación:
//   exito        todas sus respuestas fueron correctas (puede tener notas)
//   advertencia  respondió, pero con algo a revisar: sin resultados, valor por
//                defecto inesperado o una respuesta MUY lenta
//   error        al menos una llamada falló (HTTP >= 400, código de error,
//                timeout, excepción de red, URL base sin configurar...)
//   sin_detalle  solo se registró el inicio: el log no muestra el resultado
//                (NO significa que la app se haya quedado sin respuesta)
//
// Lentitud (independiente del estado): una operación que tarda >= 5 s se marca
// "lenta" y >= 15 s "muy lenta". El log mide en segundos, así que la duración
// tiene ±1 s de precisión. Una operación puede estar "OK" y aun así ser lenta:
// por eso el recorrido NUNCA se declara "sin problemas" si hubo lentitud.
//
// Privacidad: este módulo NO oculta datos (decisión del negocio). El request
// de "Inicia flujo" se usa además como huella para detectar llamadas repetidas.
// ==========================================================================

const L = require('./appMovilLenguaje');

const { RE_SIN_DATOS, limpiarTexto, interpretarApi, interpretarSoap, interpretarError, clasificar } = L;

const MAX_PASOS_POR_OPERACION = 14;
// Una fila solo se asocia a una operación del mismo Metodo si ocurrió hasta
// este tiempo después de su última fila (evita mezclar sesiones distintas).
const ITERACION_MS = 3000;
const VENTANA_ASOCIAR_MS = 60 * 1000;
// Las filas internas ("Mapeo...", "Respuesta...") son inmediatas: ventana corta.
const VENTANA_PASOS_MS = 15 * 1000;
// Una operación "huérfana" (solo filas internas, sin "Inicia flujo") solo recibe
// un resultado que llegue casi pegado a ella.
const VENTANA_HUERFANA_MS = 5 * 1000;
// Dos llamadas idénticas dentro de este tiempo se consideran un doble disparo.
const VENTANA_REPETIDA_MS = 3 * 1000;
// Umbrales de lentitud (ms). Lo habitual en este sistema es responder en < 2 s.
const LENTA_MS = 5 * 1000;
const MUY_LENTA_MS = 15 * 1000;
const HABITUAL_TEXTO = 'lo habitual es menos de 2 s';

// --------------------------------------------------------------- utilidades
function parseNaive(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(texto || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function dos(n) { return String(n).padStart(2, '0'); }

/** ms "naive" -> 'YYYY-MM-DDTHH:mm:ss' SIN zona (el navegador lo muestra tal cual, hora Colombia). */
function formatearNaive(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())}T${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())}:${dos(d.getUTCSeconds())}`;
}

function horaDe(ms) {
  const d = new Date(ms);
  return `${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())}:${dos(d.getUTCSeconds())}`;
}

function huella(texto) {
  // FNV-1a de 32 bits: suficiente para comparar requests iguales.
  let h = 0x811c9dc5;
  const s = String(texto || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

// --------------------------------------------------------- armado de operaciones
/**
 * @param {Array} filas  filas de LogApp.Log ya con FechaTxt ('YYYY-MM-DD HH:MM:SS'), en cualquier orden
 * @param {{esLogout:(metodo:string)=>boolean}} opc
 * @returns {Array} operaciones ordenadas por su primer Codigo
 */
function construirOperaciones(filas, opc) {
  const esLogout = (opc && opc.esLogout) || (() => false);
  const lista = filas
    .map((f) => ({ f, t: parseNaive(f.FechaTxt), c: Number(f.Codigo) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => (Number.isFinite(a.c) && Number.isFinite(b.c) && a.c !== b.c ? a.c - b.c : a.t - b.t));

  const operaciones = [];
  const porMetodo = new Map(); // metodo -> [operaciones] (en orden de creación)
  const ultimaPorMetodoFila = new Map(); // metodo -> { t, c, op } de la última fila asignada

  function nueva(x, metodo) {
    const op = {
      metodo,
      clase: x.f.Clase || null,
      funcionalidad: x.f.FuncionalidadCodigo === undefined ? null : x.f.FuncionalidadCodigo,
      t: x.t, fin: x.t, c: x.c, cFin: x.c,
      ruta: null,
      items: [],
      sinInicio: true,
      huellaRq: null,
      primeraFila: x.f,
      filas: 0
    };
    operaciones.push(op);
    if (!porMetodo.has(metodo)) porMetodo.set(metodo, []);
    porMetodo.get(metodo).push(op);
    return op;
  }

  const esResultado = (it) => it.tipo === 'api' || it.tipo === 'soap' || it.tipo === 'error';
  const tieneResultado = (op) => op.items.some(esResultado);

  function agregar(op, x, item) {
    // Cuánto pasó desde la fila anterior de esta operación: es lo que tardó ESTE paso.
    const espera = op.filas > 0 ? Math.max(0, x.t - op.fin) : 0;
    op.filas += 1;
    // Conteos de productos que la operación procesó (no dependen del recorte de pasos):
    // "Medios encontrados con AcctID: N" (una por cuenta con tarjeta/medio) y, por cada tarjeta
    // de crédito, una consulta de bloqueos (C097) y una de tarjetas por moneda (C091).
    const dsc = x.f.Descripcion ? String(x.f.Descripcion) : '';
    const mm = /^Medios encontrados con AcctID:\s*(\S+)/.exec(dsc);
    if (mm && mm[1] !== '0') { if (!op.mediosAcct) op.mediosAcct = new Set(); op.mediosAcct.add(mm[1]); }
    if (/^C097-/.test(dsc)) op.nBloqueos = (op.nBloqueos || 0) + 1;
    if (/^C091-/.test(dsc)) op.nPorMoneda = (op.nPorMoneda || 0) + 1;
    op.fin = Math.max(op.fin, x.t);
    op.cFin = Math.max(op.cFin, Number.isFinite(x.c) ? x.c : op.cFin);
    if (item) {
      item.hora = horaDe(x.t);
      item.fecha = formatearNaive(x.t);
      item.c = x.c;
      item.esperaMs = espera;
      op.items.push(item);
    }
  }

  for (const x of lista) {
    const metodo = x.f.Metodo || '(sin método)';
    const cls = clasificar(x.f);
    const ops = porMetodo.get(metodo) || [];

    if (cls.tipo === 'inicio') {
      // Algunos flujos registran filas internas ANTES de su "Inicia flujo": si
      // hay una operación huérfana reciente de ese Metodo (solo pasos), es suya.
      const previa = ops[ops.length - 1];
      const reutiliza = previa && previa.sinInicio && !tieneResultado(previa) && x.t - previa.fin <= 5000;
      const op = reutiliza ? previa : nueva(x, metodo);
      op.sinInicio = false;
      op.ruta = cls.ruta || null;
      op.huellaRq = huella(x.f.Adicional);
      // El inicio también es una fila consultable (su Adicional es lo que envió la app).
      agregar(op, x, { tipo: 'inicio', titulo: 'Inicio de la operación', destino: null, nivel: 'info', texto: cls.ruta ? `Ruta: ${cls.ruta}` : '', codigo: null });
      if (reutiliza) {
        op.c = Math.min(op.c, x.c); op.t = Math.min(op.t, x.t);
        op.items.sort((a, b) => (a.c || 0) - (b.c || 0));
      }
      continue;
    }

    let item;
    if (cls.tipo === 'api') item = interpretarApi(x.f, cls.m);
    else if (cls.tipo === 'soap') item = interpretarSoap(x.f, cls.m);
    else if (cls.tipo === 'error') item = interpretarError(x.f);
    else item = { tipo: 'paso', titulo: limpiarTexto(x.f.Descripcion, 120), destino: null, nivel: 'info', texto: '', codigo: null };

    let op = null;
    // Las filas de UN mismo fallo se escriben juntas (p. ej. "Error Service", la
    // respuesta SOAP y "Error Controller" en el mismo segundo, con Codigo seguido).
    // Si la anterior de este Metodo quedó en una operación en ese mismo instante,
    // esta pertenece a la misma operación: NO a la siguiente sin resultado.
    const previaFila = ultimaPorMetodoFila.get(metodo);
    if ((cls.tipo === 'error' || cls.tipo === 'soap') && previaFila && previaFila.t === x.t
      && Number.isFinite(x.c) && Number.isFinite(previaFila.c) && x.c - previaFila.c <= 6) {
      const ult = previaFila.op;
      const itemsMismoSegundo = ult.items.filter((it) => it.fecha === formatearNaive(x.t));
      const hayError = itemsMismoSegundo.some((it) => it.nivel === 'error');
      const hayMismoTipo = itemsMismoSegundo.some((it) => it.tipo === cls.tipo && it.tipo === 'soap');
      if (hayError && !hayMismoTipo) op = ult;
    }
    if (op) {
      // asignada por contigüidad
    } else if (cls.tipo === 'paso') {
      op = ops.length && x.t - ops[ops.length - 1].fin <= VENTANA_PASOS_MS ? ops[ops.length - 1] : null;
    } else if (cls.tipo === 'error' && !ops.length) {
      // Error con otro Metodo (p. ej. un mapper): pertenece a la operación de la
      // misma clase que terminó hace instantes.
      for (let i = operaciones.length - 1; i >= 0 && !op; i--) {
        const cand = operaciones[i];
        if (cand.clase === x.f.Clase && x.t - cand.fin <= 3000) op = cand;
        if (x.t - cand.fin > 3000 && operaciones.length - i > 40) break;
      }
    } else {
      // api / soap / error con Metodo conocido: la primera operación (más
      // antigua) de ese Metodo que aún no tiene resultado (las llamadas
      // paralelas terminan en el mismo orden en que empezaron); si no hay,
      // la última, salvo que este mismo resultado ya esté en ella (repetición).
      op = ops.find((o) => !tieneResultado(o) && x.t - o.fin <= (o.sinInicio ? VENTANA_HUERFANA_MS : VENTANA_ASOCIAR_MS)) || null;
      if (!op && ops.length) {
        const ultimo = ops[ops.length - 1];
        const repetido = ultimo.items.some((it) => it.tipo === item.tipo && it.titulo === item.titulo);
        // Una misma llamada ACE puede repetirse DENTRO de una operación (p. ej. bloqueos y tarjetas
        // por moneda, una vez por cada tarjeta de crédito): si llega pegada (<= 3 s) a la última
        // fila de la operación es una iteración de ella, no una operación nueva.
        const iteracion = repetido && item.tipo === 'soap' && x.t - ultimo.fin <= ITERACION_MS;
        op = (!repetido || iteracion) && x.t - ultimo.fin <= VENTANA_ASOCIAR_MS ? ultimo : null;
      }
    }
    if (!op) op = nueva(x, metodo);
    agregar(op, x, item);
    ultimaPorMetodoFila.set(metodo, { t: x.t, c: x.c, op });
  }
  return operaciones;
}

// ----------------------------------------------------- resultado de una operación
function cerrarOperaciones(operaciones, opc) {
  const esLogout = (opc && opc.esLogout) || (() => false);
  const nombre = (opc && opc.nombreServicioLegible) || ((m) => m);

  for (const op of operaciones) {
    op.esLogout = esLogout(op.metodo);
    op.servicio = nombre(op.metodo);
    // Fusionar excepciones idénticas consecutivas ("Error Controller" + "Error Service").
    const vistos = new Map();
    op.items = op.items.filter((it) => {
      if (it.tipo !== 'error') return true;
      const k = `${it.nivel}|${it.texto}`;
      if (vistos.has(k)) { vistos.get(k).repeticiones = (vistos.get(k).repeticiones || 1) + 1; return false; }
      vistos.set(k, it);
      return true;
    });
    if (op.items.length > MAX_PASOS_POR_OPERACION) {
      const importantes = op.items.filter((it) => it.tipo !== 'paso');
      const pasos = op.items.filter((it) => it.tipo === 'paso').slice(0, Math.max(0, MAX_PASOS_POR_OPERACION - importantes.length));
      op.items = op.items.filter((it) => it.tipo !== 'paso' || pasos.includes(it));
    }

    const resultados = op.items.filter((it) => it.tipo === 'api' || it.tipo === 'soap' || it.tipo === 'error');
    const pasosInternos = op.items.filter((it) => it.tipo === 'paso');
    const errores = resultados.filter((it) => it.nivel === 'error');
    const avisos = resultados.filter((it) => it.nivel === 'aviso');
    let sinDatos = resultados.filter((it) => it.sinDatos || (it.tipo === 'error' && it.manejado));
    // Si el mapper ya explicó que usó un valor por defecto, no repetir el "sin datos" de ACE.
    if (sinDatos.some((it) => it.manejado)) sinDatos = sinDatos.filter((it) => it.manejado || it.tipo !== 'soap');
    const desdeCache = pasosInternos.some((it) => /\ben cach[eé]\b/i.test(it.titulo));

    op.duracionMs = Math.max(0, op.fin - op.t);
    // Lentitud: se mide sobre toda la operación (de su primera a su última fila)
    // y se señala qué paso concentró la espera.
    op.lentitud = null;
    op.pasoLento = null;
    if (!op.esLogout && resultados.length && op.duracionMs >= LENTA_MS) {
      op.lentitud = op.duracionMs >= MUY_LENTA_MS ? 'muy_lenta' : 'lenta';
      const masEspera = resultados.slice().sort((a, b) => (b.esperaMs || 0) - (a.esperaMs || 0))[0];
      if (masEspera && masEspera.esperaMs >= LENTA_MS) op.pasoLento = { titulo: masEspera.titulo, esperaMs: masEspera.esperaMs };
      for (const it of resultados) if ((it.esperaMs || 0) >= LENTA_MS) it.lento = true;
    }
    const notaLentitud = op.lentitud
      ? `Tardó ${formatoDur(op.duracionMs)} en responder (${HABITUAL_TEXTO})${op.pasoLento ? `. Donde más esperó: ${op.pasoLento.titulo}` : ''}.`
      : null;

    op.resultado = null;
    if (op.esLogout) {
      // El cierre de sesión devuelve respuestas atípicas a propósito: nunca es fallo.
      op.estado = 'exito';
      op.mensaje = null;
    } else if (errores.length) {
      op.estado = 'error';
      op.mensaje = errores.map((e) => `${e.titulo}: ${e.texto}`).join(' · ');
      if (notaLentitud) op.mensaje += ` — ${notaLentitud}`;
    } else if (avisos.length) {
      op.estado = 'advertencia';
      op.resultado = 'Sin resultados';
      op.mensaje = avisos.map((e) => e.texto).join(' · ');
      if (notaLentitud) op.mensaje += ` — ${notaLentitud}`;
    } else if (resultados.length) {
      op.estado = 'exito';
      if (sinDatos.length) {
        op.resultado = 'Sin datos';
        op.mensaje = sinDatos.map((e) => e.texto).join(' · ');
      }
      if (op.lentitud === 'muy_lenta') {
        // Respondió bien pero tardó demasiado: no se puede mostrar como "todo bien".
        op.estado = 'advertencia';
        op.resultado = 'Respuesta lenta';
      }
      if (notaLentitud) op.mensaje = op.mensaje ? `${notaLentitud} ${op.mensaje}` : notaLentitud;
    } else if (pasosInternos.length) {
      // Sin llamada externa registrada pero con filas internas: la operación se completó.
      op.estado = 'exito';
      if (desdeCache) { op.resultado = 'Desde caché'; op.mensaje = 'Se resolvió con datos en caché (no hubo llamada externa).'; }
    } else {
      op.estado = 'sin_detalle';
      op.mensaje = 'El log solo registra el inicio de esta operación. Esa fila no guarda la respuesta: no significa que el servicio no haya respondido, solo que el log no la muestra.';
    }
  }

  // Llamadas repetidas con el mismo request (p. ej. 4 veces getParamBusinessInfo
  // en el mismo segundo) y reintentos tras un error.
  const ultimaPorHuella = new Map();
  const ultimaPorMetodo = new Map();
  for (const op of operaciones) {
    const previaMetodo = ultimaPorMetodo.get(op.metodo);
    if (previaMetodo && previaMetodo.estado === 'error') op.reintentoTrasError = true;
    ultimaPorMetodo.set(op.metodo, op);
    if (!op.huellaRq) continue;
    const clave = `${op.metodo}|${op.huellaRq}`;
    const previa = ultimaPorHuella.get(clave);
    if (previa && op.t - previa.fin <= VENTANA_REPETIDA_MS) {
      op.repeticion = (previa.repeticion || 1) + 1;
      op.primeraRepeticion = previa.primeraRepeticion || previa;
      op.primeraRepeticion.repeticiones = op.repeticion;
    }
    ultimaPorHuella.set(clave, op);
  }
  return operaciones;
}

function interpretarFilas(filas, opc) {
  return cerrarOperaciones(construirOperaciones(filas, opc), opc);
}

// ----------------------------------------------------------------- recorridos
const CATEGORIAS = [
  [/login|logout|sesion|session|SecureDevice|otp|token|authent/i, 'Inicio de sesión y seguridad'],
  [/notif/i, 'Notificaciones'],
  [/breb|transfer/i, 'Transferencias'],
  [/virtualcard|creditcard|card|kmt|tarjeta|credit/i, 'Tarjetas'],
  [/product|account|arrears|balance|limit|param|signature|passive/i, 'Productos y saldos'],
  [/user|akaunt|law|score|homolog/i, 'Datos del cliente']
];

function categoriaDe(op) {
  const texto = `${op.metodo} ${op.clase || ''}`;
  for (const [re, nombre] of CATEGORIAS) if (re.test(texto)) return nombre;
  return 'Otros servicios';
}

function listaCorta(nombres, max = 3) {
  const unicos = [...new Set(nombres)];
  if (unicos.length <= max) return unicos.join(', ');
  return `${unicos.slice(0, max).join(', ')} y ${unicos.length - max} más`;
}

function formatoDur(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return '<1 s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  const resto = s % 60;
  return resto ? `${min} min ${resto} s` : `${min} min`;
}

/**
 * Hallazgos, fases y narrativa de UN recorrido.
 * @param {Array} grupo  operaciones del recorrido, con `n` (1..N) ya asignado
 */
function analizarRecorrido(grupo) {
  const hallazgos = [];
  const total = grupo.length;
  const por = (estado) => grupo.filter((o) => o.estado === estado);
  const errores = por('error');
  const avisos = por('advertencia');
  const sinDetalle = por('sin_detalle');
  const lentas = grupo.filter((o) => o.lentitud);
  const muyLentas = grupo.filter((o) => o.lentitud === 'muy_lenta');

  // 1) Errores: uno por causa distinta
  const gruposError = new Map();
  for (const o of errores) {
    const causa = o.items.filter((i) => i.nivel === 'error').map((i) => i.texto)[0] || o.mensaje || 'Error';
    const k = `${o.metodo}|${causa}`;
    if (!gruposError.has(k)) gruposError.set(k, { o, causa, n: [] });
    gruposError.get(k).n.push(o.n);
  }
  for (const g of gruposError.values()) {
    const veces = g.n.length > 1 ? ` (${g.n.length} veces)` : '';
    const tardo = g.o.lentitud ? ` Tardó ${formatoDur(g.o.duracionMs)} antes de fallar.` : '';
    hallazgos.push({ nivel: 'error', texto: `${g.o.servicio} falló${veces}: ${g.causa}${tardo}`, llamadas: g.n });
  }

  // 2) Lentitud: un hallazgo por servicio (el peor caso), con el paso donde más esperó
  const porServicioLento = new Map();
  for (const o of lentas) {
    if (!porServicioLento.has(o.metodo)) porServicioLento.set(o.metodo, []);
    porServicioLento.get(o.metodo).push(o);
  }
  for (const ops of porServicioLento.values()) {
    const peor = ops.slice().sort((a, b) => b.duracionMs - a.duracionMs)[0];
    const veces = ops.length > 1 ? ` (${ops.length} veces)` : '';
    const donde = peor.pasoLento ? ` Donde más esperó: ${peor.pasoLento.titulo}.` : '';
    const fallo = peor.estado === 'error' ? ' Terminó en error.' : '';
    hallazgos.push({
      nivel: 'warn',
      texto: `${peor.servicio} tardó mucho en responder${veces}: hasta ${formatoDur(peor.duracionMs)} (${HABITUAL_TEXTO}).${donde}${fallo}`,
      llamadas: ops.map((o) => o.n)
    });
  }

  // 3) Avisos (sin resultados, valores por defecto...). La lentitud ya tiene su hallazgo.
  for (const o of avisos) {
    if (o.resultado === 'Respuesta lenta') continue;
    hallazgos.push({ nivel: 'warn', texto: `${o.servicio}: ${o.mensaje}`, llamadas: [o.n] });
  }

  // 4) Repetidas (mismo request) y reintentos
  const repetidas = grupo.filter((o) => o.repeticiones && o.repeticiones > 1 && !o.primeraRepeticion);
  for (const o of repetidas) {
    const ns = grupo.filter((x) => x === o || x.primeraRepeticion === o).map((x) => x.n);
    const span = Math.max(...grupo.filter((x) => ns.includes(x.n)).map((x) => x.t)) - o.t;
    hallazgos.push({ nivel: o.repeticiones >= 3 ? 'warn' : 'info', texto: `${o.servicio} se llamó ${o.repeticiones} veces seguidas con los mismos datos (en ${formatoDur(span)}): posible doble disparo de la app o de la pantalla.`, llamadas: ns });
  }
  const reintentos = grupo.filter((o) => o.reintentoTrasError);
  if (reintentos.length) {
    hallazgos.push({ nivel: 'warn', texto: `${reintentos.length} reintento(s) después de un error: ${listaCorta(reintentos.map((o) => o.servicio))}.`, llamadas: reintentos.map((o) => o.n) });
  }

  // 5) Pausa más larga entre operaciones consecutivas
  let pausaMax = 0; let tras = null;
  for (let i = 1; i < grupo.length; i++) {
    const espera = grupo[i].t - Math.max(...grupo.slice(0, i).map((o) => o.fin));
    if (espera > pausaMax) { pausaMax = espera; tras = grupo[i - 1]; }
  }
  if (pausaMax >= 60000 && tras) hallazgos.push({ nivel: 'info', texto: `Pausa más larga: ${formatoDur(pausaMax)} después de ${tras.servicio}.`, llamadas: [tras.n] });

  // 6) Operaciones sin resultado en el log
  if (sinDetalle.length) {
    hallazgos.push({ nivel: 'info', texto: `${sinDetalle.length} operación(es) solo muestran su inicio en el log (esa fila no guarda la respuesta, no significa que el servicio no respondió): ${listaCorta(sinDetalle.map((o) => o.servicio))}.`, llamadas: sinDetalle.map((o) => o.n) });
  }

  // 7) Notas informativas (sin datos / valores por defecto)
  const conNota = grupo.filter((o) => (o.estado === 'exito' || o.estado === 'advertencia') && o.resultado === 'Sin datos');
  if (conNota.length) {
    hallazgos.push({ nivel: 'info', texto: `${conNota.length} consulta(s) respondieron sin datos (normal si el cliente no tiene ese producto): ${listaCorta(conNota.map((o) => o.servicio))}.`, llamadas: conNota.map((o) => o.n) });
  }

  // 8) Cierre
  const ultimo = grupo[grupo.length - 1];
  let cierre = 'sin_cierre';
  if (ultimo.esLogout) cierre = 'cierre_normal';
  else if (ultimo.estado === 'error') cierre = 'termino_con_error';
  if (cierre === 'cierre_normal') hallazgos.push({ nivel: 'ok', texto: 'El cliente cerró sesión con normalidad.', llamadas: [ultimo.n] });
  else if (cierre === 'termino_con_error') hallazgos.push({ nivel: 'error', texto: 'El recorrido terminó con una operación fallida.', llamadas: [ultimo.n] });
  else hallazgos.push({ nivel: 'info', texto: 'No hay cierre de sesión registrado: el cliente salió de la app o la dejó en segundo plano.', llamadas: [] });

  // Salud general: "sin problemas" SOLO si no hubo errores, avisos ni lentitud.
  const avisosReales = avisos.filter((o) => o.resultado !== 'Respuesta lenta');
  let salud;
  if (errores.length) {
    salud = { nivel: 'error', texto: `${errores.length} operación(es) con error${lentas.length ? ` y ${lentas.length} lenta(s)` : ''}` };
  } else if (lentas.length || avisosReales.length) {
    const partes = [];
    if (lentas.length) partes.push(`${lentas.length} operación(es) lenta(s)${muyLentas.length ? ` (${muyLentas.length} muy lenta(s))` : ''}`);
    if (avisosReales.length) partes.push(`${avisosReales.length} con aviso`);
    salud = { nivel: 'aviso', texto: `Sin errores, pero con ${partes.join(' y ')}` };
  } else {
    salud = { nivel: 'ok', texto: 'Sin errores ni lentitud' };
  }
  if (salud.nivel === 'ok') hallazgos.unshift({ nivel: 'ok', texto: 'No se registraron errores, avisos ni lentitud en este recorrido.', llamadas: [] });

  const orden = { error: 0, warn: 1, info: 2, ok: 3 };
  hallazgos.sort((a, b) => orden[a.nivel] - orden[b.nivel]);

  // Fases ("momentos"): ráfagas de operaciones separadas por una pausa de
  // más de 3 s. Una ráfaga grande es la carga de la pantalla de inicio; una
  // pequeña es una acción del usuario (se nombra por sus servicios).
  const fases = [];
  let finRafaga = -Infinity;
  for (const o of grupo) {
    const f = fases[fases.length - 1];
    if (f && o.t - finRafaga <= 3000) {
      f.ops.push(o);
      finRafaga = Math.max(finRafaga, o.fin);
    } else {
      fases.push({ ops: [o] });
      finRafaga = o.fin;
    }
  }
  const fasesSalida = fases.map((f) => {
    const ops = f.ops;
    const metodos = ops.map((o) => o.metodo);
    const categorias = [...new Set(ops.map(categoriaDe))];
    let nombre;
    if (metodos.some((m) => /^login/i.test(m))) nombre = 'Inicio de sesión y carga inicial';
    else if (ops.length >= 8) nombre = 'Carga de la pantalla de inicio';
    else if (categorias.includes('Transferencias')) nombre = 'Transferencia';
    else if (categorias.length <= 2) nombre = categorias.join(' + ');
    else nombre = 'Acción del cliente';
    return {
      nombre,
      desde: ops[0].n,
      hasta: ops[ops.length - 1].n,
      llamadas: ops.length,
      errores: ops.filter((o) => o.estado === 'error').length,
      avisos: ops.filter((o) => o.estado === 'advertencia' && o.resultado !== 'Respuesta lenta').length,
      lentas: ops.filter((o) => o.lentitud).length,
      hora: horaDe(ops[0].t),
      duracionMs: Math.max(...ops.map((o) => o.fin)) - ops[0].t,
      servicios: [...new Set(ops.map((o) => o.servicio))].slice(0, 6)
    };
  });

  const ok = grupo.filter((o) => o.estado === 'exito').length;
  const partes = [`${total} operaciones: ${ok} correctas`];
  if (errores.length) partes.push(`${errores.length} con error`);
  if (avisosReales.length) partes.push(`${avisosReales.length} con aviso`);
  if (lentas.length) partes.push(`${lentas.length} lenta(s)`);
  if (sinDetalle.length) partes.push(`${sinDetalle.length} solo con su inicio en el log`);
  const secuencia = fasesSalida
    .map((f) => `${f.hora} ${f.nombre} (${f.llamadas}${f.errores ? `, ${f.errores} con error` : ''}${f.lentas ? `, ${f.lentas} lenta(s)` : ''}${f.llamadas < 8 ? `: ${listaCorta(f.servicios, 4)}` : ''})`)
    .join(' → ');
  const narrativa = `${partes.join(', ')}. Secuencia: ${secuencia}.`;

  return { hallazgos, fases: fasesSalida, narrativa, cierre, salud, lentas: lentas.length, muyLentas: muyLentas.length };
}


const ETIQUETA_ESTADO = { exito: 'OK', error: 'ERROR', advertencia: 'AVISO', sin_detalle: 'SOLO INICIO' };
const ETIQUETA_NIVEL = { error: 'ERROR', warn: 'AVISO', info: 'INFO', ok: 'OK' };

/**
 * Texto plano y copiable de un recorrido ya armado (el que sale en la
 * respuesta): sirve para pegarlo en un ticket o en una conversación y que
 * quien lo lea entienda qué pasó sin abrir la pantalla.
 */
function textoResumenRecorrido(rec, ctx) {
  const doc = (ctx && ctx.documento) || '';
  const l = [];
  const d = (iso) => String(iso).replace('T', ' ');
  l.push(`RECORRIDO DEL CLIENTE ${doc} — ${d(rec.inicio)} a ${String(rec.fin).slice(11)} (hora Colombia, duración ${formatoDur(rec.duracionMs)})`);
  l.push(`Dispositivo: ${rec.dispositivo}${rec.ip ? ` · IP ${rec.ip}` : ''}`);
  if (rec.salud) l.push(`Estado general: ${rec.salud.texto}`);
  l.push(`Resumen: ${rec.narrativa}`);
  l.push('');
  l.push('HALLAZGOS');
  for (const h of rec.hallazgos) {
    const ns = h.llamadas && h.llamadas.length ? ` [#${h.llamadas.slice(0, 8).join(', #')}${h.llamadas.length > 8 ? '…' : ''}]` : '';
    l.push(`- ${ETIQUETA_NIVEL[h.nivel] || h.nivel}: ${h.texto}${ns}`);
  }
  l.push('');
  l.push('OPERACIONES (n · hora · estado · duración · servicio [método])');
  for (const c of rec.llamadas.slice(0, 120)) {
    const lento = c.lentitud ? (c.lentitud === 'muy_lenta' ? ' · MUY LENTA' : ' · LENTA') : '';
    const base = `#${c.n} · ${String(c.inicio).slice(11)} · ${ETIQUETA_ESTADO[c.estado] || c.estado}${c.resultado ? ` (${c.resultado})` : ''} · ${formatoDur(c.duracionMs)}${lento} · ${c.servicio} [${c.metodo}]`;
    l.push(base);
    if ((c.estado === 'error' || c.estado === 'advertencia' || c.resultado || c.lentitud) && c.mensaje) l.push(`    ${c.mensaje}`);
  }
  if (rec.llamadas.length > 120) l.push(`… y ${rec.llamadas.length - 120} operaciones más.`);
  l.push('');
  l.push('Nota: LogApp registra la hora en segundos (las duraciones tienen ±1 s) y llamadas de la app al backend (no pantallas ni toques).');
  return l.join('\n');
}

module.exports = {
  textoResumenRecorrido,
  parseNaive,
  formatearNaive,
  horaDe,
  formatoDur,
  interpretarFilas,
  analizarRecorrido,
  listaCorta,
  RE_SIN_DATOS,
  LENTA_MS,
  MUY_LENTA_MS
};
