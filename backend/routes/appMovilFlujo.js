// ==========================================================================
// DIAGRAMAS DE FLUJO DE APP MÓVIL (a partir de LogApp.Log / Log_YYYYMM)
// ==========================================================================
// Dos vistas, ambas derivadas de los logs que ya existen (no se instrumenta
// nada en la app ni se escribe nada en LogApp):
//
//   GET /api/app-movil/flujo/cliente   Recorrido de UN cliente (por Documento):
//                                      la secuencia de servicios que llamó la
//                                      app, con tiempos, reintentos y fallos.
//   GET /api/app-movil/flujo/global    Mapa de proceso de TODOS los clientes
//                                      sobre una muestra acotada: qué servicio
//                                      sigue a cuál, cuántos, y dónde fallan.
//
// LIMITACIÓN IMPORTANTE (se le muestra a la persona en la pantalla): LogApp
// registra llamadas de la app al backend (Clase.Metodo), NO pantallas ni
// toques. El diagrama es el flujo de SERVICIOS, no de pantallas. Además la
// columna Sesion no es un identificador de sesión confiable, así que un
// "recorrido" se arma por Documento y se corta por inactividad o cierre de
// sesión.
//
// ----- CÓMO SE PROTEGE LogApp (no se puede tocar su esquema ni sus índices) -----
//   1. El recorrido de un cliente va SIEMPRE por el índice de Documento
//      (FORCE INDEX), con rango de fechas de máximo 7 días y tope de filas.
//   2. El mapa global lee una MUESTRA: las últimas N filas (tope duro) por el
//      índice de Fecha, jamás un día completo. El costo es el mismo sin
//      importar cuántos millones de filas tenga la tabla.
//   3. Solo se traen las columnas necesarias, con Rs/Adicional recortados en
//      SQL (LEFT) para no transferir cuerpos de respuesta.
//   4. Todo el cálculo (emparejar inicio/fin, transiciones, métricas) se hace
//      en Node, no en la base.
//   5. Caché por consulta (y single-flight: peticiones iguales simultáneas
//      comparten una sola consulta), enfriamiento mínimo entre ejecuciones
//      reales, máximo de consultas de diagrama simultáneas (global) y límite
//      por usuario por minuto.
//   6. Tiempo máximo por consulta con corte de socket (consultarConTiempoMaximo).
//   7. Interruptor de emergencia: FLUJO_LOGS_DESHABILITADO=true apaga ambas
//      rutas sin redeploy de código. FLUJO_LOGS_MAX_FILAS ajusta el tope de
//      filas del mapa global (5000 a 60000, por defecto 30000).
// ==========================================================================

const traza = require('../utils/appMovilTraza');

const FILAS_MAX_CLIENTE = 6000;
// De cada respuesta se leen el comienzo y el final: el estado (código/severidad) puede estar en cualquiera.
const RS_CABEZA_CLIENTE = 1800;
const RS_COLA_CLIENTE = 500;
const DIAS_MAX_CLIENTE = 7;
const TIEMPO_MAX_CLIENTE_MS = 30 * 1000;
const TIEMPO_MAX_GLOBAL_MS = 25 * 1000;

const VENTANAS_GLOBAL_MIN = [5, 15, 30, 60];
const VENTANA_GLOBAL_DEFECTO_MIN = 15;
const BRECHA_SESION_GLOBAL_MS = 10 * 60 * 1000;
const BRECHA_SESION_CLIENTE_DEFECTO_MIN = 30;


const CACHE_CLIENTE_TTL_MS = 60 * 1000;
const CACHE_GLOBAL_RECIENTE_TTL_MS = 2 * 60 * 1000;
const CACHE_GLOBAL_HISTORICO_TTL_MS = 30 * 60 * 1000;
const ENFRIAMIENTO_REFRESCO_MS = 30 * 1000;
const CACHE_MAX_ENTRADAS = 60;

const MAX_CONSULTAS_SIMULTANEAS = 2;
const MAX_CONSULTAS_POR_USUARIO_MINUTO = 15;

const GLOBAL_MAX_NODOS = 60;
const GLOBAL_MAX_ARISTAS = 220;

const METODOS_LOGIN = new Set(['login_api', 'Login']);

function limitar(valor, minimo, maximo) {
  return Math.min(Math.max(valor, minimo), maximo);
}

function registrarRutasFlujo(router, deps) {
  const {
    verifyToken,
    requireModule,
    getLogAppPool,
    getPool,
    consultarConTiempoMaximo,
    esErrorPorTiempoMaximo,
    mensajeErrorAmigable,
    nombreServicioLegible,
    enmascararDocumento,
    documentoValido,
    resolverRangoFechas,
    tablasLogParaRango,
    nombreTablaLogParaUnDia,
    esFilaFallida,
    resumirMensajeError,
    clasificarDispositivo,
    extraerIp,
    metodosExcluidos,
    registrarEventoGeneral
  } = deps;

  const metodosLogout = new Set(metodosExcluidos);

  // ------------------------------------------------------------------------
  // Control de carga
  // ------------------------------------------------------------------------
  let consultasEnCurso = 0;
  const enVuelo = new Map(); // clave -> promesa (single-flight)
  const cache = new Map(); // clave -> { datos, generadoEn, ttl }
  const consultasPorUsuario = new Map(); // userId -> [timestamps]
  const indicesNoDisponibles = new Set();

  function flujoDeshabilitado() {
    return String(process.env.FLUJO_LOGS_DESHABILITADO || '').toLowerCase() === 'true';
  }

  function topeFilasGlobal() {
    const valor = parseInt(process.env.FLUJO_LOGS_MAX_FILAS, 10);
    return limitar(Number.isFinite(valor) ? valor : 30000, 5000, 60000);
  }

  function crearErrorHttp(status, mensaje) {
    const err = new Error(mensaje);
    err.statusHttp = status;
    return err;
  }

  function verificarLimiteUsuario(req) {
    const id = req.user && (req.user.id || req.user.username) ? String(req.user.id || req.user.username) : 'anon';
    const ahora = Date.now();
    const recientes = (consultasPorUsuario.get(id) || []).filter((t) => ahora - t < 60 * 1000);
    if (recientes.length >= MAX_CONSULTAS_POR_USUARIO_MINUTO) {
      throw crearErrorHttp(429, 'Demasiadas consultas de diagrama en el último minuto. Espera unos segundos e intenta de nuevo.');
    }
    recientes.push(ahora);
    consultasPorUsuario.set(id, recientes);
    if (consultasPorUsuario.size > 500) consultasPorUsuario.clear();
  }

  function leerCache(clave) {
    const entrada = cache.get(clave);
    if (!entrada) return null;
    const antiguedad = Date.now() - entrada.generadoEn;
    return { datos: entrada.datos, antiguedadMs: antiguedad, vigente: antiguedad <= entrada.ttl };
  }

  function guardarCache(clave, datos, ttl) {
    if (cache.size >= CACHE_MAX_ENTRADAS) cache.clear();
    cache.set(clave, { datos, generadoEn: Date.now(), ttl });
  }

  // Ejecuta `calculo` respetando: single-flight por clave y tope de consultas
  // simultáneas. Si hay demasiadas en curso devuelve 429 en vez de encolar,
  // para que nunca se acumule trabajo sobre LogApp.
  async function ejecutarControlado(clave, calculo) {
    if (enVuelo.has(clave)) return enVuelo.get(clave);
    if (consultasEnCurso >= MAX_CONSULTAS_SIMULTANEAS) {
      throw crearErrorHttp(429, 'Hay otros diagramas calculándose en este momento. Intenta de nuevo en unos segundos.');
    }
    consultasEnCurso += 1;
    const promesa = Promise.resolve()
      .then(calculo)
      .finally(() => {
        consultasEnCurso -= 1;
        enVuelo.delete(clave);
      });
    enVuelo.set(clave, promesa);
    return promesa;
  }

  // Intenta la consulta forzando el índice (evita que el optimizador de
  // MariaDB 5.5 elija un plan que recorra la tabla); si esa tabla no tiene un
  // índice con ese nombre, lo recuerda y reintenta una vez sin FORCE INDEX.
  async function consultarPreferenteIndice(pool, claveIndice, construirSql, parametros, tiempoMaxMs) {
    if (!indicesNoDisponibles.has(claveIndice)) {
      try {
        return await consultarConTiempoMaximo(pool, construirSql(true), parametros, tiempoMaxMs);
      } catch (err) {
        const indiceInexistente = err && (err.errno === 1176 || err.code === 'ER_KEY_DOES_NOT_EXIST');
        if (!indiceInexistente) throw err;
        indicesNoDisponibles.add(claveIndice);
      }
    }
    return consultarConTiempoMaximo(pool, construirSql(false), parametros, tiempoMaxMs);
  }

  function responderError(res, err, contexto) {
    if (err && err.statusHttp) return res.status(err.statusHttp).json({ error: err.message });
    if (esErrorPorTiempoMaximo(err)) {
      console.error(`Diagrama de flujo (${contexto}) excedió el tiempo máximo:`, err.message);
      return res.status(504).json({
        error: 'La consulta tardó demasiado y se canceló para no afectar la base de logs. Intenta con un rango más corto.'
      });
    }
    console.error(`Error en diagrama de flujo (${contexto}):`, err);
    return res.status(500).json({ error: mensajeErrorAmigable(err) });
  }

  // La traza de LogApp se interpreta en utils/appMovilTraza.js: una operación
  // (Metodo) agrupa todas sus filas y su estado sale de las respuestas reales.

  // Corta una lista de llamadas (de un mismo cliente, ya ordenada) en
  // recorridos: por inactividad mayor a `brechaMs`, o cuando la anterior fue
  // un cierre de sesión.
  function partirEnRecorridos(llamadas, brechaMs) {
    const recorridos = [];
    let actual = null;
    for (const l of llamadas) {
      if (actual) {
        const previa = actual[actual.length - 1];
        const finPrevia = previa.fin !== null ? previa.fin : previa.inicio;
        if (l.t - finPrevia > brechaMs || previa.esLogout) {
          recorridos.push(actual);
          actual = null;
        }
      }
      if (!actual) actual = [];
      actual.push(l);
    }
    if (actual) recorridos.push(actual);
    return recorridos;
  }

  // Precedencias de OPERACIONES (utils/appMovilTraza.js) usando Codigo, que es
  // autoincremental y conserva el orden real de inserción aun dentro del mismo
  // segundo: B sigue a A si el primer Codigo de B es posterior al último de A;
  // si los rangos se entrelazan, son paralelas y comparten las mismas previas.
  function construirPrecedenciasPorCodigo(grupo) {
    let frontera = [];
    const previasPorIndice = [];
    grupo.forEach((l, i) => {
      const terminadas = frontera.filter((j) => grupo[j].cFin < l.c);
      const enCurso = frontera.filter((j) => grupo[j].cFin >= l.c);
      const previas = terminadas.length
        ? terminadas
        : [...new Set(enCurso.flatMap((j) => previasPorIndice[j]))];
      previasPorIndice.push(previas);
      frontera = [...enCurso, i];
    });
    return { previasPorIndice, finales: frontera };
  }

  function percentil(valoresOrdenados, p) {
    if (!valoresOrdenados.length) return null;
    const indice = Math.min(valoresOrdenados.length - 1, Math.floor(p * valoresOrdenados.length));
    return valoresOrdenados[indice];
  }

  function normalizarFechaYMD(texto) {
    return /^\d{4}-\d{2}-\d{2}$/.test(texto || '') ? texto : null;
  }

  // ========================================================================
  // Reloj y calendario BASADOS EN LA BASE DE DATOS
  // ========================================================================
  // "Hoy" para LogApp es el día que dice el reloj de la propia BD (es el que
  // decide en qué tabla vive cada fila: Log = hoy, Log_YYYYMM = hasta ayer).
  // Usar el reloj de Node (que en Docker suele ir en UTC) hacía que, pasadas
  // las 7 p. m. hora Colombia, "hoy" apuntara a mañana y las consultas fueran
  // a la tabla equivocada devolviendo vacío sin avisar.
  function dos(n) { return String(n).padStart(2, '0'); }
  function ymdUtc(d) { return `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())}`; }
  function sumarDias(texto, dias) {
    const d = new Date(`${texto}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return ymdUtc(d);
  }
  function diferenciaDias(desde, hasta) {
    return Math.round((new Date(`${hasta}T00:00:00Z`).getTime() - new Date(`${desde}T00:00:00Z`).getTime()) / 86400000);
  }
  function tablaMensual(textoFecha) { return `Log_${textoFecha.slice(0, 4)}${textoFecha.slice(5, 7)}`; }

  async function relojBd(pool) {
    try {
      const [filas] = await consultarConTiempoMaximo(pool, "SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS ahora", [], 5000);
      const texto = filas && filas[0] ? String(filas[0].ahora) : '';
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(texto)) {
        return { hoy: texto.slice(0, 10), hora: parseInt(texto.slice(11, 13), 10), ahoraTexto: texto, ahoraMs: new Date(texto.replace(' ', 'T')).getTime() };
      }
    } catch (e) {
      console.error('No se pudo leer el reloj de LogApp, se usa el de Node:', e.message);
    }
    const n = new Date();
    return { hoy: `${n.getFullYear()}-${dos(n.getMonth() + 1)}-${dos(n.getDate())}`, hora: n.getHours(), ahoraTexto: null, ahoraMs: n.getTime() };
  }

  // Tablas a consultar para un rango de días (mismo criterio que
  // tablasLogParaRango de appMovil.js, pero con "hoy" de la BD).
  function tramosParaRango(inicio, fin, hoy) {
    const ayer = sumarDias(hoy, -1);
    const tramos = [];
    if (inicio <= hoy && fin >= hoy) tramos.push({ tabla: 'Log', desde: hoy, hasta: hoy });
    const finSinHoy = fin > ayer ? ayer : fin;
    let cursor = inicio;
    while (cursor <= finSinHoy) {
      const anio = parseInt(cursor.slice(0, 4), 10);
      const mes = parseInt(cursor.slice(5, 7), 10);
      const finMes = `${anio}-${dos(mes)}-${dos(new Date(Date.UTC(anio, mes, 0)).getUTCDate())}`;
      const finTramo = finMes < finSinHoy ? finMes : finSinHoy;
      tramos.push({ tabla: tablaMensual(cursor), desde: cursor, hasta: finTramo });
      cursor = sumarDias(finTramo, 1);
    }
    return tramos;
  }

  function esTablaInexistente(err) {
    return !!err && (err.errno === 1146 || err.code === 'ER_NO_SUCH_TABLE');
  }

  function rangoCliente(query, hoy) {
    const ini = normalizarFechaYMD((query.fechaInicio || '').trim());
    const finPedido = normalizarFechaYMD((query.fechaFin || '').trim());
    if (ini && finPedido) {
      const fin = finPedido > hoy ? hoy : finPedido;
      if (ini > fin) throw crearErrorHttp(400, 'La fecha inicial no puede ser posterior a la final (ni futura).');
      const dias = diferenciaDias(ini, fin) + 1;
      if (dias > DIAS_MAX_CLIENTE) throw crearErrorHttp(400, `Para el recorrido de un cliente elige máximo ${DIAS_MAX_CLIENTE} días.`);
      return { fechaInicioTexto: ini, fechaFinTexto: fin, dias };
    }
    const dias = limitar(parseInt(query.dias, 10) || 1, 1, DIAS_MAX_CLIENTE);
    const desfase = limitar(parseInt(query.desfase, 10) || 0, 0, 180);
    const fin = sumarDias(hoy, -desfase);
    return { fechaInicioTexto: sumarDias(fin, -(dias - 1)), fechaFinTexto: fin, dias };
  }

  function resumirDuraciones(valores) {
    const ordenadas = valores.slice().sort((a, b) => a - b);
    if (!ordenadas.length) return { promedioMs: null, medianaMs: null, p90Ms: null, maximoMs: null };
    const suma = ordenadas.reduce((s, v) => s + v, 0);
    return {
      promedioMs: Math.round(suma / ordenadas.length),
      medianaMs: percentil(ordenadas, 0.5),
      p90Ms: percentil(ordenadas, 0.9),
      maximoMs: ordenadas[ordenadas.length - 1]
    };
  }

  // Cuando un cliente no tiene actividad en el rango pedido, en vez de un
  // "no hay datos" mudo se le explica por qué: qué tablas se consultaron y en
  // qué días SÍ tiene registros (últimos días, mes actual y anterior).
  async function diagnosticarCliente(pool, documento, reloj, tramosConsultados, tablasFaltantes) {
    const mesActual = tablaMensual(reloj.hoy);
    const mesAnterior = tablaMensual(sumarDias(`${reloj.hoy.slice(0, 7)}-01`, -1));
    const candidatas = [...new Set(['Log', mesActual, mesAnterior])];
    const dias = new Map();
    const faltantes = new Set(tablasFaltantes);
    for (const tabla of candidatas) {
      try {
        const [filas] = await consultarPreferenteIndice(
          pool,
          `DiagDoc:${tabla}`,
          (conIndice) => `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d') AS dia, COUNT(*) AS n
             FROM LogApp.${tabla}${conIndice ? ' FORCE INDEX (Index_Log_Documento)' : ''}
             WHERE Documento = ?
             GROUP BY dia ORDER BY dia DESC LIMIT 12`,
          [documento],
          15 * 1000
        );
        for (const f of filas) dias.set(f.dia, (dias.get(f.dia) || 0) + Number(f.n));
      } catch (err) {
        if (esTablaInexistente(err)) faltantes.add(tabla);
        else if (!esErrorPorTiempoMaximo(err)) console.error(`Diagnóstico de cliente (${tabla}):`, err.message);
      }
    }
    const diasConActividad = [...dias.entries()]
      .map(([fecha, registros]) => ({ fecha, registros }))
      .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))
      .slice(0, 10);
    return {
      tramos: tramosConsultados,
      tablasFaltantes: [...faltantes],
      tablasRevisadas: candidatas,
      diasConActividad,
      ultimaActividad: diasConActividad.length ? diasConActividad[0].fecha : null
    };
  }

  // ========================================================================
  // GET /flujo/cliente?documento=&dias=1..7[&desfase=N] | fechaInicio=&fechaFin=&brechaMin=
  // ========================================================================
  // Lee las filas del cliente (por Documento, con tope de filas y de días). Lo usan el recorrido y los
  // análisis de carga de productos / operaciones.
  async function leerFilasCliente(pool, documento, rango, reloj) {
    const tramos = tramosParaRango(rango.fechaInicioTexto, rango.fechaFinTexto, reloj.hoy);

    const filas = [];
    const tramosInfo = [];
    const tablasFaltantes = [];
    let truncado = false;
    // Los tramos se consultan EN SERIE (una sola conexión a la vez por
    // petición) para no abrir varias consultas simultáneas contra LogApp.
    for (const { tabla, desde, hasta } of tramos) {
      const restante = FILAS_MAX_CLIENTE - filas.length;
      if (restante <= 0) { truncado = true; break; }
      let resultado = [];
      try {
        [resultado] = await consultarPreferenteIndice(
          pool,
          `Documento:${tabla}`,
          (conIndice) => `SELECT Codigo, DATE_FORMAT(Fecha, '%Y-%m-%d %H:%i:%s') AS FechaTxt, TipoCodigo, Clase, Metodo,
                  FuncionalidadCodigo, Descripcion,
                  LEFT(Rs, ${RS_CABEZA_CLIENTE}) AS Rs,
                  IF(CHAR_LENGTH(Rs) > ${RS_CABEZA_CLIENTE}, SUBSTRING(Rs, -${RS_COLA_CLIENTE}), NULL) AS RsFin,
                  LEFT(Adicional, 600) AS Adicional, Ip, LEFT(Sesion, 300) AS Sesion, Transaccion
           FROM LogApp.${tabla}${conIndice ? ' FORCE INDEX (Index_Log_Documento)' : ''}
           WHERE Documento = ? AND Fecha >= ? AND Fecha <= ?
           ORDER BY Fecha ASC
           LIMIT ?`,
          [documento, `${desde} 00:00:00`, `${hasta} 23:59:59`, restante + 1],
          TIEMPO_MAX_CLIENTE_MS
        );
      } catch (err) {
        // Un mes sin tabla no debe tumbar toda la consulta: se informa.
        if (!esTablaInexistente(err)) throw err;
        tablasFaltantes.push(tabla);
        tramosInfo.push({ tabla, desde, hasta, filas: 0, existe: false });
        continue;
      }
      tramosInfo.push({ tabla, desde, hasta, filas: Math.min(resultado.length, restante), existe: true });
      if (resultado.length > restante) {
        truncado = true;
        filas.push(...resultado.slice(0, restante));
      } else {
        filas.push(...resultado);
      }
    }
    return { filas, tramosInfo, tablasFaltantes, truncado };
  }

  async function calcularRecorridoCliente(pool, documento, rango, brechaMin, reloj) {
    const { filas, tramosInfo, tablasFaltantes, truncado } = await leerFilasCliente(pool, documento, rango, reloj);

    // Interpretación de la traza real de LogApp (ver utils/appMovilTraza.js):
    // una "llamada" es una OPERACIÓN (un Metodo con todas sus filas: inicio,
    // API, SOAP, errores, pasos internos) y su estado sale de las respuestas.
    const llamadas = traza.interpretarFilas(filas, {
      esLogout: (metodo) => metodosLogout.has(metodo),
      nombreServicioLegible
    });
    const grupos = partirEnRecorridos(llamadas, brechaMin * 60 * 1000);

    const todasDuraciones = [];
    const porServicio = new Map();
    const dispositivos = new Map();

    const recorridos = grupos.map((grupo, indice) => {
      grupo.forEach((l, i) => { l.n = i + 1; });
      const { previasPorIndice } = construirPrecedenciasPorCodigo(grupo);
      const t0 = Math.min(...grupo.map((l) => l.t));
      const tFin = Math.max(...grupo.map((l) => l.fin));
      const analisis = traza.analizarRecorrido(grupo);
      const primeraFila = grupo.map((l) => l.primeraFila).find((f) => f && f.Sesion) || grupo[0].primeraFila || {};
      const errores = grupo.filter((l) => l.estado === 'error').length;
      const advertencias = grupo.filter((l) => l.estado === 'advertencia' && l.resultado !== 'Respuesta lenta').length;
      const sinDetalle = grupo.filter((l) => l.estado === 'sin_detalle').length;

      let masLento = null;
      const servicios = new Set();
      for (const l of grupo) {
        servicios.add(l.metodo);
        if (l.duracionMs > 0) {
          todasDuraciones.push(l.duracionMs);
          if (!masLento || l.duracionMs > masLento.duracionMs) masLento = { metodo: l.metodo, servicio: l.servicio, duracionMs: l.duracionMs };
        }
        let s = porServicio.get(l.metodo);
        if (!s) { s = { metodo: l.metodo, servicio: l.servicio, llamadas: 0, errores: 0, advertencias: 0, lentas: 0, duraciones: [] }; porServicio.set(l.metodo, s); }
        if (l.lentitud) s.lentas += 1;
        s.llamadas += 1;
        if (l.estado === 'error') s.errores += 1;
        if (l.estado === 'advertencia' && l.resultado !== 'Respuesta lenta') s.advertencias += 1;
        if (l.duracionMs > 0) s.duraciones.push(l.duracionMs);
      }
      const dispositivo = clasificarDispositivo(primeraFila.Sesion);
      dispositivos.set(dispositivo, (dispositivos.get(dispositivo) || 0) + 1);

      const recorrido = {
        id: indice + 1,
        inicio: traza.formatearNaive(t0),
        fin: traza.formatearNaive(tFin),
        duracionMs: tFin - t0,
        dispositivo,
        ip: extraerIp(primeraFila.Ip),
        totalLlamadas: grupo.length,
        serviciosDistintos: servicios.size,
        errores,
        advertencias,
        sinDetalle,
        masLento,
        lentas: analisis.lentas,
        muyLentas: analisis.muyLentas,
        salud: analisis.salud,
        cierre: analisis.cierre,
        narrativa: analisis.narrativa,
        fases: analisis.fases,
        hallazgos: analisis.hallazgos,
        llamadas: grupo.map((l, i) => ({
          n: l.n,
          metodo: l.metodo,
          clase: l.clase,
          servicio: l.servicio,
          funcionalidad: l.funcionalidad,
          inicio: traza.formatearNaive(l.t),
          fin: traza.formatearNaive(l.fin),
          offsetMs: l.t - t0,
          duracionMs: l.duracionMs,
          estado: l.estado,
          resultado: l.resultado,
          lentitud: l.lentitud || null,
          pasoLento: l.pasoLento || null,
          esLogout: l.esLogout,
          previas: previasPorIndice[i].map((j) => j + 1),
          mensaje: l.mensaje,
          ruta: l.ruta,
          repeticion: l.repeticion || null,
          reintento: !!l.reintentoTrasError,
          pasos: l.items.map((it) => ({
            tipo: it.tipo,
            nivel: it.nivel,
            titulo: it.titulo,
            texto: it.texto,
            destino: it.destino,
            hora: it.hora,
            fecha: it.fecha,
            codigo: it.c,
            esperaMs: it.esperaMs || 0,
            lento: !!it.lento,
            veces: it.repeticiones || 1
          }))
        }))
      };
      recorrido.resumenTexto = traza.textoResumenRecorrido(recorrido, { documento });
      return recorrido;
    });

    // Los más recientes primero (lo que normalmente se quiere mirar).
    recorridos.sort((a, b) => new Date(b.inicio).getTime() - new Date(a.inicio).getTime());
    const MAX_RECORRIDOS = 40;

    const totalLlamadas = llamadas.length;
    const totalErrores = llamadas.filter((l) => l.estado === 'error').length;
    const totalAdvertencias = llamadas.filter((l) => l.estado === 'advertencia' && l.resultado !== 'Respuesta lenta').length;
    const resumenDur = resumirDuraciones(todasDuraciones);
    const resumen = {
      recorridos: recorridos.length,
      llamadas: totalLlamadas,
      errores: totalErrores,
      advertencias: totalAdvertencias,
      lentas: llamadas.filter((l) => l.lentitud).length,
      muyLentas: llamadas.filter((l) => l.lentitud === 'muy_lenta').length,
      sinDetalle: llamadas.filter((l) => l.estado === 'sin_detalle').length,
      sinRespuesta: 0,
      tasaExito: totalLlamadas ? 1 - totalErrores / totalLlamadas : null,
      serviciosDistintos: porServicio.size,
      duracionPromMs: resumenDur.promedioMs,
      duracionP90Ms: resumenDur.p90Ms,
      masLento: [...porServicio.values()]
        .filter((s) => s.duraciones.length)
        .map((s) => ({ servicio: s.servicio, metodo: s.metodo, duracionMs: Math.max(...s.duraciones) }))
        .sort((a, b) => b.duracionMs - a.duracionMs)[0] || null,
      dispositivos: [...dispositivos.entries()].map(([nombre, n]) => ({ nombre, n })).sort((a, b) => b.n - a.n),
      servicios: [...porServicio.values()]
        .map((s) => ({
          metodo: s.metodo,
          servicio: s.servicio,
          llamadas: s.llamadas,
          errores: s.errores,
          advertencias: s.advertencias,
          lentas: s.lentas,
          duracionPromMs: s.duraciones.length ? Math.round(s.duraciones.reduce((a, b) => a + b, 0) / s.duraciones.length) : null,
          duracionMaxMs: s.duraciones.length ? Math.max(...s.duraciones) : null
        }))
        .sort((a, b) => b.llamadas - a.llamadas)
        .slice(0, 40)
    };

    const respuesta = {
      documento,
      fechaInicio: rango.fechaInicioTexto,
      fechaFin: rango.fechaFinTexto,
      brechaMin,
      relojBd: reloj.ahoraTexto,
      totalFilas: filas.length,
      truncado,
      recorridosOmitidos: Math.max(0, recorridos.length - MAX_RECORRIDOS),
      tramos: tramosInfo,
      tablasFaltantes,
      resumen,
      recorridos: recorridos.slice(0, MAX_RECORRIDOS),
      diagnostico: null
    };

    if (!recorridos.length) {
      respuesta.diagnostico = await diagnosticarCliente(pool, documento, reloj, tramosInfo, tablasFaltantes);
    }
    return respuesta;
  }

  router.get('/flujo/cliente', verifyToken, requireModule('APP_MOVIL'), async (req, res) => {
    try {
      if (flujoDeshabilitado()) throw crearErrorHttp(503, 'El diagrama de flujo está deshabilitado temporalmente por el administrador.');

      const documento = documentoValido(req.query);
      if (!documento || documento.length < 4) {
        throw crearErrorHttp(400, 'Escribe el documento completo del cliente (mínimo 4 caracteres).');
      }
      const brechaMin = limitar(parseInt(req.query.brechaMin, 10) || BRECHA_SESION_CLIENTE_DEFECTO_MIN, 5, 180);

      verificarLimiteUsuario(req);

      const pool = await getLogAppPool();
      const reloj = await relojBd(pool);
      const rango = rangoCliente(req.query, reloj.hoy);

      const clave = `cliente|${documento}|${rango.fechaInicioTexto}|${rango.fechaFinTexto}|${brechaMin}`;
      let datos;
      let desdeCache = false;
      const enCache = leerCache(clave);
      if (enCache && enCache.vigente) {
        datos = enCache.datos;
        desdeCache = true;
      } else {
        datos = await ejecutarControlado(clave, async () => {
          const resultado = await calcularRecorridoCliente(pool, documento, rango, brechaMin, reloj);
          guardarCache(clave, resultado, CACHE_CLIENTE_TTL_MS);
          return resultado;
        });
      }

      // Auditoría: quién miró el recorrido de qué cliente (dato personal).
      // No bloquea ni rompe la respuesta si la auditoría falla.
      Promise.resolve()
        .then(async () => {
          const poolPrincipal = await getPool();
          await registrarEventoGeneral(poolPrincipal, req, {
            modulo: 'APP_MOVIL',
            entidad: 'Recorrido cliente',
            entidadNombre: enmascararDocumento(documento),
            accion: 'CONSULTA',
            detalle: `Diagrama de recorrido del cliente (${rango.fechaInicioTexto} a ${rango.fechaFinTexto})`
          });
        })
        .catch((e) => console.error('No se pudo auditar la consulta de recorrido:', e.message));

      res.json({ ...datos, desdeCache, generadoEn: new Date().toISOString() });
    } catch (err) {
      responderError(res, err, 'cliente');
    }
  });

  // ========================================================================
  // GET /flujo/global?ventana=5|15|30|60 [&fecha=YYYY-MM-DD&hora=0..23] [&refrescar=1]
  // ========================================================================
  // Pasos de un recorrido como "olas": las llamadas que se solapan en el
  // tiempo (carga paralela del Home, por ejemplo) forman UN paso. Dos
  // clientes que hicieron lo mismo en distinto orden de milisegundos quedan
  // con la misma firma, y las repeticiones seguidas (reintentos) se colapsan.
  function pasosDeRecorrido(recorrido) {
    // Se solapan si el rango de Codigo de una operación se entrelaza con el de
    // la ola en curso (Codigo conserva el orden real aun dentro del mismo segundo).
    const olas = [];
    let actual = null;
    let finOla = -Infinity;
    for (const l of recorrido) {
      if (actual && l.c < finOla) {
        actual.push(l.metodo);
        finOla = Math.max(finOla, l.cFin);
      } else {
        actual = [l.metodo];
        olas.push(actual);
        finOla = l.cFin;
      }
    }
    const pasos = [];
    let previa = null;
    for (const ola of olas) {
      const paso = [...new Set(ola)].sort();
      const firma = paso.join('+');
      if (firma === previa) continue;
      pasos.push(paso);
      previa = firma;
    }
    return pasos;
  }

  async function calcularMapaGlobal(pool, parametros, reloj) {
    const { fecha, hora, ventanaMin } = parametros;
    const topeFilas = topeFilasGlobal();

    let tabla;
    let sqlDonde;
    let paramsFecha;
    let orden;

    if (parametros.modo === 'reciente') {
      // Hoy vive en `Log`. La ventana se calcula con el reloj de la propia BD.
      tabla = 'Log';
      sqlDonde = 'Fecha >= DATE_SUB(NOW(), INTERVAL ? MINUTE)';
      paramsFecha = [ventanaMin];
      orden = 'DESC';
    } else {
      tabla = fecha === reloj.hoy ? 'Log' : tablaMensual(fecha);
      const finMin = hora * 60 + ventanaMin;
      const finTexto = finMin >= 1440 ? `${sumarDias(fecha, 1)} 00:00:00` : `${fecha} ${dos(Math.floor(finMin / 60))}:${dos(finMin % 60)}:00`;
      sqlDonde = 'Fecha >= ? AND Fecha < ?';
      paramsFecha = [`${fecha} ${dos(hora)}:00:00`, finTexto];
      orden = 'ASC';
    }

    let filasSql = [];
    let tablaFaltante = false;
    try {
      [filasSql] = await consultarPreferenteIndice(
        pool,
        `Fecha:${tabla}`,
        (conIndice) => `SELECT Codigo, Documento, DATE_FORMAT(Fecha, '%Y-%m-%d %H:%i:%s') AS FechaTxt, TipoCodigo, Clase, Metodo,
                  LEFT(Descripcion, 60) AS Descripcion, LEFT(Rs, 220) AS Rs,
                  IF(LOCATE('Status>', Rs) > 0, SUBSTRING(Rs, GREATEST(LOCATE('Status>', Rs) - 8, 1), 700), NULL) AS RsEstado,
                  IF(LOCATE('faultstring>', Rs) > 0, SUBSTRING(Rs, GREATEST(LOCATE('faultstring>', Rs) - 2, 1), 260), NULL) AS RsFalla,
                  LEFT(Adicional, 60) AS Adicional
           FROM LogApp.${tabla}${conIndice ? ' FORCE INDEX (Index_Log_Fecha)' : ''}
           WHERE ${sqlDonde} AND Documento IS NOT NULL AND Documento <> ''
           ORDER BY Fecha ${orden}
           LIMIT ?`,
        [...paramsFecha, topeFilas],
        TIEMPO_MAX_GLOBAL_MS
      );
    } catch (err) {
      if (!esTablaInexistente(err)) throw err;
      tablaFaltante = true;
    }

    const muestraTruncada = filasSql.length >= topeFilas;

    // Agrupar por cliente (Documento) -- nunca sale del backend.
    const porCliente = new Map();
    let fechaMin = Infinity;
    let fechaMax = -Infinity;
    for (const f of filasSql) {
      const t = traza.parseNaive(f.FechaTxt);
      if (!Number.isFinite(t)) continue;
      if (t < fechaMin) fechaMin = t;
      if (t > fechaMax) fechaMax = t;
      // El estado de una respuesta SOAP vive lejos del comienzo: se une lo leído aparte.
      if (f.RsEstado || f.RsFalla) f.RsFin = [f.RsEstado, f.RsFalla].filter(Boolean).join(' ');
      let lista = porCliente.get(f.Documento);
      if (!lista) { lista = []; porCliente.set(f.Documento, lista); }
      lista.push(f);
    }

    const nodos = new Map();
    const aristas = new Map();
    const variantes = new Map();
    const VARIANTES_MAX_FIRMAS = 4000;
    const PASOS_MAX_VARIANTE = 12;

    // Serie de actividad (llamadas, errores y clientes por intervalo).
    const spanMs = Number.isFinite(fechaMin) ? Math.max(1000, fechaMax - fechaMin) : 1000;
    const bucketMs = Math.max(5000, Math.ceil(spanMs / 45 / 1000) * 1000);
    const buckets = new Map();

    let totalLlamadas = 0;
    let totalErrores = 0;
    let totalLentas = 0;
    let totalRecorridos = 0;
    let recorridosConError = 0;
    let cierreNormal = 0;
    let cierreError = 0;
    let sinCierre = 0;
    const duracionesRecorrido = [];
    const duracionesLlamada = [];
    let indiceCliente = 0;

    const nodo = (metodo) => {
      let n = nodos.get(metodo);
      if (!n) {
        n = { metodo, total: 0, fallos: 0, lentas: 0, sinRespuesta: 0, entradas: 0, salidas: 0, repeticiones: 0, duraciones: [], posSuma: 0, posN: 0, clientes: new Set() };
        nodos.set(metodo, n);
      }
      return n;
    };

    for (const filasCliente of porCliente.values()) {
      indiceCliente += 1;
      const llamadas = traza.interpretarFilas(filasCliente, { esLogout: (metodo) => metodosLogout.has(metodo), nombreServicioLegible });
      const recorridos = partirEnRecorridos(llamadas, BRECHA_SESION_GLOBAL_MS);
      for (const recorrido of recorridos) {
        totalRecorridos += 1;
        const { previasPorIndice, finales } = construirPrecedenciasPorCodigo(recorrido);
        const largo = recorrido.length;
        let hayError = false;

        const tIni = recorrido[0].t;
        const ultimo = recorrido[largo - 1];
        const tFinRec = Math.max(...recorrido.map((l) => (l.fin !== null ? l.fin : l.inicio !== null ? l.inicio : l.t)));
        duracionesRecorrido.push(tFinRec - tIni);
        if (ultimo.esLogout) cierreNormal += 1;
        else if (ultimo.estado === 'error') cierreError += 1;
        else sinCierre += 1;

        recorrido.forEach((l, i) => {
          totalLlamadas += 1;
          const n = nodo(l.metodo);
          n.total += 1;
          n.clientes.add(indiceCliente);
          if (largo > 1) { n.posSuma += i / (largo - 1); n.posN += 1; }
          if (l.estado === 'error') { n.fallos += 1; totalErrores += 1; hayError = true; }
          if (l.lentitud) { n.lentas += 1; totalLentas += 1; }
          if (l.estado === 'sin_respuesta') n.sinRespuesta += 1;
          if (l.duracionMs !== null) { n.duraciones.push(l.duracionMs); duracionesLlamada.push(l.duracionMs); }

          const clave = Math.floor((l.t - fechaMin) / bucketMs);
          let b = buckets.get(clave);
          if (!b) { b = { llamadas: 0, errores: 0, clientes: new Set() }; buckets.set(clave, b); }
          b.llamadas += 1;
          if (l.estado === 'error') b.errores += 1;
          b.clientes.add(indiceCliente);

          const previas = previasPorIndice[i];
          if (!previas.length) n.entradas += 1;
          let esReintento = false;
          for (const j of previas) {
            const previa = recorrido[j];
            if (previa.metodo === l.metodo) { esReintento = true; continue; }
            const claveArista = `${previa.metodo}\u0000${l.metodo}`;
            let a = aristas.get(claveArista);
            if (!a) { a = { de: previa.metodo, a: l.metodo, n: 0, sumaEsperaMs: 0, fallosDestino: 0 }; aristas.set(claveArista, a); }
            a.n += 1;
            if (l.estado === 'error') a.fallosDestino += 1;
            const finPrevia = previa.fin !== null ? previa.fin : previa.inicio;
            a.sumaEsperaMs += Math.max(0, l.t - finPrevia);
          }
          if (esReintento) n.repeticiones += 1;
        });
        for (const j of finales) nodo(recorrido[j].metodo).salidas += 1;
        if (hayError) recorridosConError += 1;

        // Variante (ruta) del recorrido
        const pasos = pasosDeRecorrido(recorrido);
        const firma = pasos.slice(0, PASOS_MAX_VARIANTE).map((p) => p.join('+')).join('>') + (pasos.length > PASOS_MAX_VARIANTE ? '>…' : '');
        let v = variantes.get(firma);
        if (!v && variantes.size < VARIANTES_MAX_FIRMAS) {
          v = { pasos: pasos.slice(0, PASOS_MAX_VARIANTE), truncada: pasos.length > PASOS_MAX_VARIANTE, n: 0, conError: 0, duraciones: [], llamadas: 0, cierres: { normal: 0, error: 0, sin: 0 } };
          variantes.set(firma, v);
        }
        if (v) {
          v.n += 1;
          if (hayError) v.conError += 1;
          v.duraciones.push(tFinRec - tIni);
          v.llamadas += largo;
          if (ultimo.esLogout) v.cierres.normal += 1;
          else if (ultimo.estado === 'error') v.cierres.error += 1;
          else v.cierres.sin += 1;
        }
      }
    }

    // Poda: solo los servicios más usados y las transiciones relevantes, para
    // que el diagrama sea legible (y la respuesta liviana).
    const todosNodos = [...nodos.values()].sort((a, b) => b.total - a.total);
    const conservados = todosNodos.slice(0, GLOBAL_MAX_NODOS);
    const claves = new Set(conservados.map((n) => n.metodo));
    const totalTransiciones = [...aristas.values()].reduce((s, a) => s + a.n, 0);
    const umbralArista = Math.max(2, Math.ceil(totalTransiciones * 0.0004));
    const validas = [...aristas.values()].filter((a) => claves.has(a.de) && claves.has(a.a));
    const elegidas = new Map();
    for (const a of validas) if (a.n >= umbralArista) elegidas.set(`${a.de}\u0000${a.a}`, a);
    // Cada servicio conserva siempre sus 2 caminos más usados de entrada y de
    // salida, aunque estén bajo el umbral: el mapa nunca deja servicios sueltos.
    const salientes = new Map();
    const entrantes = new Map();
    for (const a of validas) {
      if (!salientes.has(a.de)) salientes.set(a.de, []);
      if (!entrantes.has(a.a)) entrantes.set(a.a, []);
      salientes.get(a.de).push(a);
      entrantes.get(a.a).push(a);
    }
    for (const lista of [...salientes.values(), ...entrantes.values()]) {
      lista.sort((x, y) => y.n - x.n).slice(0, 2).forEach((a) => elegidas.set(`${a.de}\u0000${a.a}`, a));
    }
    const aristasConservadas = [...elegidas.values()].sort((a, b) => b.n - a.n).slice(0, GLOBAL_MAX_ARISTAS);

    const resumenLlamadas = resumirDuraciones(duracionesLlamada);
    const resumenRecorrido = resumirDuraciones(duracionesRecorrido);

    // Serie de actividad completa (rellena intervalos vacíos con 0)
    const puntos = [];
    if (Number.isFinite(fechaMin)) {
      const total = Math.floor((fechaMax - fechaMin) / bucketMs) + 1;
      for (let i = 0; i < total; i++) {
        const b = buckets.get(i);
        puntos.push({
          t: traza.formatearNaive(fechaMin + i * bucketMs),
          llamadas: b ? b.llamadas : 0,
          errores: b ? b.errores : 0,
          clientes: b ? b.clientes.size : 0
        });
      }
    }

    const variantesSalida = [...variantes.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 15)
      .map((v) => {
        const r = resumirDuraciones(v.duraciones);
        return {
          pasos: v.pasos.map((paso) => paso.map((metodo) => ({ metodo, servicio: nombreServicioLegible(metodo) }))),
          truncada: v.truncada,
          n: v.n,
          porcentaje: totalRecorridos ? v.n / totalRecorridos : 0,
          conError: v.conError,
          duracionMedianaMs: r.medianaMs,
          llamadasProm: v.n ? v.llamadas / v.n : 0,
          cierreNormal: v.cierres.normal,
          cierreError: v.cierres.error,
          sinCierre: v.cierres.sin
        };
      });

    return {
      modo: parametros.modo,
      tabla,
      tablaFaltante,
      ventanaMin,
      fecha: parametros.modo === 'reciente' ? reloj.hoy : fecha,
      hora: parametros.modo === 'reciente' ? null : hora,
      relojBd: reloj.ahoraTexto,
      muestra: {
        filasLeidas: filasSql.length,
        topeFilas,
        truncada: muestraTruncada,
        clientes: porCliente.size,
        recorridos: totalRecorridos,
        llamadas: totalLlamadas,
        desde: Number.isFinite(fechaMin) ? traza.formatearNaive(fechaMin) : null,
        hasta: Number.isFinite(fechaMax) ? traza.formatearNaive(fechaMax) : null
      },
      kpis: {
        errores: totalErrores,
        lentas: totalLentas,
        tasaError: totalLlamadas ? totalErrores / totalLlamadas : 0,
        llamadaMedianaMs: resumenLlamadas.medianaMs,
        llamadaP90Ms: resumenLlamadas.p90Ms,
        recorridoMedianaMs: resumenRecorrido.medianaMs,
        recorridoP90Ms: resumenRecorrido.p90Ms,
        llamadasPorRecorrido: totalRecorridos ? totalLlamadas / totalRecorridos : 0,
        recorridosConError,
        cierreNormal,
        cierreError,
        sinCierre,
        serviciosDistintos: nodos.size
      },
      actividad: { bucketMs, puntos },
      variantes: variantesSalida,
      nodosOmitidos: Math.max(0, todosNodos.length - conservados.length),
      nodos: conservados.map((n) => {
        const ordenadas = n.duraciones.slice().sort((a, b) => a - b);
        const promedio = ordenadas.length ? Math.round(ordenadas.reduce((s, v) => s + v, 0) / ordenadas.length) : null;
        return {
          metodo: n.metodo,
          servicio: nombreServicioLegible(n.metodo),
          esLogout: metodosLogout.has(n.metodo),
          total: n.total,
          clientes: n.clientes.size,
          fallos: n.fallos,
          lentas: n.lentas,
          sinRespuesta: n.sinRespuesta,
          tasaFallo: n.total ? n.fallos / n.total : 0,
          entradas: n.entradas,
          salidas: n.salidas,
          repeticiones: n.repeticiones,
          posProm: n.posN ? n.posSuma / n.posN : (n.entradas > 0 ? 0 : 0.5),
          duracionPromMs: promedio,
          duracionMedianaMs: percentil(ordenadas, 0.5),
          duracionP90Ms: percentil(ordenadas, 0.9)
        };
      }),
      aristas: aristasConservadas.map((a) => ({
        de: a.de,
        a: a.a,
        n: a.n,
        esperaPromMs: Math.round(a.sumaEsperaMs / a.n),
        fallosDestino: a.fallosDestino
      }))
    };
  }

  router.get('/flujo/global', verifyToken, requireModule('APP_MOVIL'), async (req, res) => {
    try {
      if (flujoDeshabilitado()) throw crearErrorHttp(503, 'El diagrama de flujo está deshabilitado temporalmente por el administrador.');

      const ventanaPedida = parseInt(req.query.ventana, 10);
      const ventanaMin = VENTANAS_GLOBAL_MIN.includes(ventanaPedida) ? ventanaPedida : VENTANA_GLOBAL_DEFECTO_MIN;

      const fecha = normalizarFechaYMD(req.query.fecha);
      const horaPedida = parseInt(req.query.hora, 10);
      const hora = Number.isFinite(horaPedida) ? limitar(horaPedida, 0, 23) : null;

      verificarLimiteUsuario(req);

      const pool = await getLogAppPool();
      const reloj = await relojBd(pool);

      const historico = !!fecha && hora !== null && !(fecha === reloj.hoy && hora >= reloj.hora);
      if (fecha && fecha > reloj.hoy) throw crearErrorHttp(400, 'La fecha no puede ser futura.');
      if (historico && diferenciaDias(fecha, reloj.hoy) > 180) throw crearErrorHttp(400, 'Solo se puede consultar hasta 180 días atrás.');

      const parametros = historico
        ? { modo: 'historico', fecha, hora, ventanaMin }
        : { modo: 'reciente', fecha: null, hora: null, ventanaMin };

      const clave = historico ? `global|h|${fecha}|${hora}|${ventanaMin}` : `global|r|${ventanaMin}`;
      const ttl = historico ? CACHE_GLOBAL_HISTORICO_TTL_MS : CACHE_GLOBAL_RECIENTE_TTL_MS;
      const forzar = req.query.refrescar === '1' || req.query.refrescar === 'true';

      const enCache = leerCache(clave);
      // "Actualizar" solo vuelve a consultar si el dato tiene más de
      // ENFRIAMIENTO_REFRESCO_MS: apretar el botón en bucle no llega a LogApp.
      const usarCache = enCache && (forzar ? enCache.antiguedadMs < ENFRIAMIENTO_REFRESCO_MS : enCache.vigente);

      let datos;
      let desdeCache = false;
      let antiguedadMs = 0;
      if (usarCache) {
        datos = enCache.datos;
        desdeCache = true;
        antiguedadMs = enCache.antiguedadMs;
      } else {
        datos = await ejecutarControlado(clave, async () => {
          const resultado = await calcularMapaGlobal(pool, parametros, reloj);
          guardarCache(clave, resultado, ttl);
          return resultado;
        });
      }

      res.json({ ...datos, desdeCache, antiguedadMs, generadoEn: new Date().toISOString() });
    } catch (err) {
      responderError(res, err, 'global');
    }
  });

  // Ayudas compartidas con las rutas de análisis (appMovilAnalisis.js): mismo control de carga sobre LogApp.
  return {
    ejecutarControlado, verificarLimiteUsuario, leerCache, guardarCache, relojBd, rangoCliente, tramosParaRango,
    consultarPreferenteIndice, responderError, flujoDeshabilitado, crearErrorHttp, leerFilasCliente,
    esTablaInexistente, topeFilasGlobal, normalizarFechaYMD, limitar, sumarDias, tablaMensual, diferenciaDias,
    TIEMPO_MAX_GLOBAL_MS, BRECHA_SESION_CLIENTE_DEFECTO_MIN
  };
}

module.exports = registrarRutasFlujo;
