// ==========================================================================
// ANÁLISIS DE APP MÓVIL SOBRE LogApp (carga de productos, operaciones,
// versiones y equipos, latencia, códigos y errores masivos)
// ==========================================================================
//   GET /carga-productos     ¿Se cargaron los productos del cliente? tiempos, causa raíz / hipótesis
//   GET /operaciones         Operaciones completas de un cliente (filas agrupadas, tiempos reales)
//   GET /versiones/adopcion  Cuántos clientes usan cada versión de la app
//   GET /versiones/clientes  CC de los clientes de una versión (JSON o CSV)
//   GET /latencia            p50/p90/p95/p99/máx por servicio, nodo y llamada ACE
//   GET /errores-masivos     Causas de error con su alcance; marca las MASIVAS
//   GET /codigos             Diccionario de códigos traducidos + códigos vistos ahora
//   GET /alertas-masivas     Historial de alertas de error masivo (y /:id con el detalle)
//
// Cómo se protege LogApp (igual que el diagrama de flujo, ver appMovilFlujo.js):
//   * Por cliente: siempre por el índice de Documento, máximo 7 días, tope de filas.
//   * Global: MUESTRA reciente por el índice de Fecha con tope de filas (nunca un día
//     completo), caché, single-flight, tope de consultas simultáneas y límite por usuario.
//   * Versiones: se calculan en segundo plano (una consulta por día, con pausa) y se
//     guardan en tablas propias de BIC_CERTI_MARIA (script manual); la pantalla lee ESAS
//     tablas, no LogApp.
//   * Interruptores: FLUJO_LOGS_DESHABILITADO (todo), ERROR_MASIVO_DESHABILITADO
//     (vigilancia), VERSIONES_ETL_DESHABILITADO (cálculo de versiones).
// Nada se oculta: los CC se muestran completos (decisión del negocio); cada consulta de
// CC queda en la auditoría general.
// ==========================================================================

const crypto = require('crypto');
const traza = require('../utils/appMovilTraza');
const { analizarCargas, textoCarga } = require('../utils/appMovilCarga');
const { cargarCatalogoAce } = require('../utils/appMovilAce');
const { analizarMuestra } = require('../utils/appMovilAnalitica');
const { diccionario, traducirItem } = require('../utils/appMovilCodigos');
const { extraerVersionApp, describirEquipo, valorPareceVersion } = require('../utils/appMovilVersion');
const { notificarVarios } = require('../utils/notificaciones');

const VENTANAS_MUESTRA_MIN = [5, 15, 30, 60, 120];
const CACHE_MUESTRA_TTL_MS = 2 * 60 * 1000;
const PAUSA_RELLENO_MS = 8000;

function numeroEnv(nombre, defecto, minimo, maximo) {
  const v = Number(process.env[nombre]);
  const n = Number.isFinite(v) ? v : defecto;
  return Math.min(maximo, Math.max(minimo, n));
}

/** Compara versiones "9.0.5" / "9.0.10": devuelve <0, 0, >0. */
function compararVersiones(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return String(a).localeCompare(String(b));
}

function registrarRutasAnalisis(router, deps, ayudas) {
  const {
    verifyToken, requireModule, getLogAppPool, getPool, consultarConTiempoMaximo, esErrorPorTiempoMaximo,
    nombreServicioLegible, documentoValido, enmascararDocumento, extraerNodo, registrarEventoGeneral, metodosExcluidos
  } = deps;
  const {
    ejecutarControlado, verificarLimiteUsuario, leerCache, guardarCache, relojBd, rangoCliente, tramosParaRango,
    consultarPreferenteIndice, responderError, flujoDeshabilitado, crearErrorHttp, leerFilasCliente, esTablaInexistente,
    topeFilasGlobal, normalizarFechaYMD, limitar, sumarDias, tablaMensual, diferenciaDias, TIEMPO_MAX_GLOBAL_MS,
    BRECHA_SESION_CLIENTE_DEFECTO_MIN
  } = ayudas;

  const metodosLogout = new Set(metodosExcluidos);
  const esLogout = (m) => metodosLogout.has(m);

  const infoFila = (fila) => {
    const v = extraerVersionApp(fila.Sesion);
    return { nodo: extraerNodo ? extraerNodo(fila.Ip) : null, version: v ? v.version : null, equipo: describirEquipo(fila.Sesion) };
  };

  function auditar(req, entidad, nombre, detalle) {
    Promise.resolve().then(async () => {
      const pool = await getPool();
      await registrarEventoGeneral(pool, req, { modulo: 'APP_MOVIL', entidad, entidadNombre: nombre, accion: 'CONSULTA', detalle });
    }).catch((e) => console.error(`No se pudo auditar (${entidad}):`, e.message));
  }

  const envolver = (contexto, fn) => async (req, res) => {
    try {
      if (flujoDeshabilitado()) throw crearErrorHttp(503, 'El análisis de logs está deshabilitado temporalmente por el administrador.');
      await fn(req, res);
    } catch (err) {
      responderError(res, err, contexto);
    }
  };

  // ========================================================================
  // Por cliente: carga de productos y operaciones
  // ========================================================================
  async function filasDeCliente(req) {
    const documento = documentoValido(req.query);
    if (!documento || documento.length < 4) throw crearErrorHttp(400, 'Escribe el documento completo del cliente (mínimo 4 caracteres).');
    verificarLimiteUsuario(req);
    const pool = await getLogAppPool();
    const reloj = await relojBd(pool);
    const rango = rangoCliente(req.query, reloj.hoy);
    return { documento, pool, reloj, rango };
  }

  router.get('/carga-productos', verifyToken, requireModule('APP_MOVIL'), envolver('carga-productos', async (req, res) => {
    const { documento, pool, reloj, rango } = await filasDeCliente(req);
    const clave = `carga|${documento}|${rango.fechaInicioTexto}|${rango.fechaFinTexto}`;
    let datos; let desdeCache = false;
    const enCache = leerCache(clave);
    if (enCache && enCache.vigente) { datos = enCache.datos; desdeCache = true; }
    else {
      datos = await ejecutarControlado(clave, async () => {
        const leidas = await leerFilasCliente(pool, documento, rango, reloj);
        const catalogo = await cargarCatalogoAce(getPool);
        const ops = traza.interpretarFilas(leidas.filas, { esLogout, nombreServicioLegible });
        const analisis = analizarCargas(ops, { catalogo, infoFila });
        const MAX = 30;
        const cargas = analisis.cargas.slice(0, MAX).map((c) => ({ ...c, resumenTexto: textoCarga(c, { documento }) }));
        const respuesta = {
          documento, fechaInicio: rango.fechaInicioTexto, fechaFin: rango.fechaFinTexto, relojBd: reloj.ahoraTexto,
          totalFilas: leidas.filas.length, truncado: leidas.truncado, tablasFaltantes: leidas.tablasFaltantes,
          catalogoAce: { servicios: catalogo.servicios, operaciones: catalogo.operaciones },
          resumen: analisis.resumen, umbrales: analisis.umbrales, precision: analisis.precision,
          cargas, cargasOmitidas: Math.max(0, analisis.cargas.length - MAX), eventosSueltos: analisis.eventosSueltos.slice(0, 60)
        };
        guardarCache(clave, respuesta, 60 * 1000);
        return respuesta;
      });
    }
    auditar(req, 'Carga de productos', enmascararDocumento(documento), `Validación de carga de productos (${rango.fechaInicioTexto} a ${rango.fechaFinTexto})`);
    res.json({ ...datos, desdeCache, generadoEn: new Date().toISOString() });
  }));

  router.get('/operaciones', verifyToken, requireModule('APP_MOVIL'), envolver('operaciones', async (req, res) => {
    const { documento, pool, reloj, rango } = await filasDeCliente(req);
    const filtroEstado = ['exito', 'error', 'advertencia', 'sin_detalle'].includes(req.query.estado) ? req.query.estado : null;
    const filtroMetodo = req.query.metodo ? String(req.query.metodo).slice(0, 80) : null;
    const clave = `ops|${documento}|${rango.fechaInicioTexto}|${rango.fechaFinTexto}`;
    let base; let desdeCache = false;
    const enCache = leerCache(clave);
    if (enCache && enCache.vigente) { base = enCache.datos; desdeCache = true; }
    else {
      base = await ejecutarControlado(clave, async () => {
        const leidas = await leerFilasCliente(pool, documento, rango, reloj);
        const catalogo = await cargarCatalogoAce(getPool);
        const ops = traza.interpretarFilas(leidas.filas, { esLogout, nombreServicioLegible });
        const operaciones = ops.slice().sort((a, b) => b.t - a.t || (b.c || 0) - (a.c || 0)).map((o, i) => {
          const medible = !o.sinInicio && o.estado !== 'sin_detalle';
          const info = infoFila(o.primeraFila || {});
          return {
            n: i + 1, metodo: o.metodo, servicio: o.servicio, clase: o.clase, funcionalidad: o.funcionalidad,
            inicio: traza.formatearNaive(o.t), fin: traza.formatearNaive(o.fin), t: o.t,
            duracionMs: medible ? o.duracionMs : null, sinInicio: !!o.sinInicio,
            estado: o.estado, resultado: o.resultado || null, lentitud: o.lentitud || null, mensaje: o.mensaje || null,
            pasoLento: o.pasoLento || null, ruta: o.ruta || null, filas: o.filas, esLogout: !!o.esLogout,
            nodo: info.nodo, version: info.version, equipo: info.equipo,
            repeticion: o.repeticion || null, reintento: !!o.reintentoTrasError,
            pasos: o.items.map((it) => ({
              tipo: it.tipo, nivel: it.nivel, titulo: it.titulo, texto: it.texto, hora: it.hora, esperaMs: it.esperaMs || 0,
              lento: !!it.lento, destino: it.destino || null, transaccion: it.transaccion || null, veces: it.repeticiones || 1,
              falla: it.falla || null, codigos: traducirItem(it),
              catalogo: it.servicioAce ? catalogo.describir(it.servicioAce.id, it.servicioAce.servicio, it.servicioAce.operacion) : null
            }))
          };
        });
        const respuesta = { documento, fechaInicio: rango.fechaInicioTexto, fechaFin: rango.fechaFinTexto, totalFilas: leidas.filas.length, truncado: leidas.truncado, tablasFaltantes: leidas.tablasFaltantes, operaciones };
        guardarCache(clave, respuesta, 60 * 1000);
        return respuesta;
      });
    }
    const MAX = 400;
    const todas = base.operaciones;
    let lista = todas;
    if (filtroEstado) lista = lista.filter((o) => o.estado === filtroEstado);
    if (filtroMetodo) lista = lista.filter((o) => o.metodo === filtroMetodo);
    const cont = (f) => todas.filter(f).length;
    const metodos = [...new Set(todas.map((o) => o.metodo))].sort();
    const medidas = todas.filter((o) => o.duracionMs !== null).map((o) => o.duracionMs);
    auditar(req, 'Operaciones cliente', enmascararDocumento(documento), `Operaciones agrupadas (${base.fechaInicio} a ${base.fechaFin})`);
    res.json({
      documento: base.documento, fechaInicio: base.fechaInicio, fechaFin: base.fechaFin, totalFilas: base.totalFilas, truncado: base.truncado,
      tablasFaltantes: base.tablasFaltantes, desdeCache,
      resumen: { operaciones: todas.length, exito: cont((o) => o.estado === 'exito'), error: cont((o) => o.estado === 'error'), advertencia: cont((o) => o.estado === 'advertencia'), sinDetalle: cont((o) => o.estado === 'sin_detalle'), medibles: medidas.length, maxMs: medidas.length ? Math.max(...medidas) : null },
      metodos, mostradas: Math.min(MAX, lista.length), omitidas: Math.max(0, lista.length - MAX), operaciones: lista.slice(0, MAX),
      precision: 'Las horas del log tienen resolución de 1 segundo (±1 s por duración). La duración solo se muestra si el log tiene el inicio y el resultado de la operación.'
    });
  }));

  // ========================================================================
  // Muestra global reciente: latencia, errores masivos, códigos
  // ========================================================================
  async function leerMuestra(pool, parametros, reloj) {
    const topeFilas = topeFilasGlobal();
    let tabla; let sqlDonde; let paramsFecha; let orden;
    if (parametros.modo === 'reciente') {
      tabla = 'Log'; sqlDonde = 'Fecha >= DATE_SUB(NOW(), INTERVAL ? MINUTE)'; paramsFecha = [parametros.ventanaMin]; orden = 'DESC';
    } else {
      tabla = parametros.fecha === reloj.hoy ? 'Log' : tablaMensual(parametros.fecha);
      const dos = (n) => String(n).padStart(2, '0');
      const finMin = parametros.hora * 60 + parametros.ventanaMin;
      const finTexto = finMin >= 1440 ? `${sumarDias(parametros.fecha, 1)} 00:00:00` : `${parametros.fecha} ${dos(Math.floor(finMin / 60))}:${dos(finMin % 60)}:00`;
      sqlDonde = 'Fecha >= ? AND Fecha < ?'; paramsFecha = [`${parametros.fecha} ${dos(parametros.hora)}:00:00`, finTexto]; orden = 'ASC';
    }
    let filasSql = []; let tablaFaltante = false;
    try {
      [filasSql] = await consultarPreferenteIndice(
        pool, `Fecha:${tabla}`,
        (conIndice) => `SELECT Codigo, Documento, DATE_FORMAT(Fecha, '%Y-%m-%d %H:%i:%s') AS FechaTxt, TipoCodigo, Clase, Metodo,
                LEFT(Descripcion, 90) AS Descripcion, LEFT(Rs, 220) AS Rs,
                IF(LOCATE('Status>', Rs) > 0, SUBSTRING(Rs, GREATEST(LOCATE('Status>', Rs) - 8, 1), 700), NULL) AS RsEstado,
                IF(LOCATE('faultstring>', Rs) > 0, SUBSTRING(Rs, GREATEST(LOCATE('faultstring>', Rs) - 2, 1), 560), NULL) AS RsFalla,
                LEFT(Adicional, 140) AS Adicional, Ip, Transaccion,
                IF(LOCATE('deviceVersion', Sesion) > 0, SUBSTRING(Sesion, GREATEST(LOCATE('deviceVersion', Sesion) - 1, 1), 40), NULL) AS Sesion,
                CASE WHEN Sesion LIKE '%iPhone%' OR Sesion LIKE '%iPad%' THEN 'iOS' WHEN Sesion LIKE '%release-keys%' THEN 'Android' ELSE NULL END AS Plat
         FROM LogApp.${tabla}${conIndice ? ' FORCE INDEX (Index_Log_Fecha)' : ''}
         WHERE ${sqlDonde} AND Documento IS NOT NULL AND Documento <> ''
         ORDER BY Fecha ${orden}
         LIMIT ?`,
        [...paramsFecha, topeFilas], TIEMPO_MAX_GLOBAL_MS
      );
    } catch (err) {
      if (!esTablaInexistente(err)) throw err;
      tablaFaltante = true;
    }
    const porCliente = new Map();
    for (const f of filasSql) {
      if (f.RsEstado || f.RsFalla) f.RsFin = [f.RsEstado, f.RsFalla].filter(Boolean).join(' ');
      let l = porCliente.get(f.Documento);
      if (!l) { l = []; porCliente.set(f.Documento, l); }
      l.push(f);
    }
    return { porCliente, filasLeidas: filasSql.length, topeFilas, truncada: filasSql.length >= topeFilas, tabla, tablaFaltante };
  }

  function umbralesMasivo() {
    return {
      minClientes: numeroEnv('ERROR_MASIVO_MIN_CLIENTES', 8, 2, 10000),
      minErrores: numeroEnv('ERROR_MASIVO_MIN_ERRORES', 15, 2, 100000),
      minTasa: numeroEnv('ERROR_MASIVO_MIN_TASA', 0.15, 0.01, 1),
      minLlamadas: numeroEnv('ERROR_MASIVO_MIN_LLAMADAS', 10, 2, 100000)
    };
  }

  /** Muestra analizada (compartida por latencia, errores masivos, códigos y la vigilancia). */
  async function obtenerAnalisis(pool, parametros, reloj, { ignorarCache = false } = {}) {
    const clave = parametros.modo === 'reciente' ? `analisis|r|${parametros.ventanaMin}` : `analisis|h|${parametros.fecha}|${parametros.hora}|${parametros.ventanaMin}`;
    const enCache = leerCache(clave);
    if (!ignorarCache && enCache && enCache.vigente) return { ...enCache.datos, desdeCache: true, antiguedadMs: enCache.antiguedadMs };
    const datos = await ejecutarControlado(clave, async () => {
      const muestra = await leerMuestra(pool, parametros, reloj);
      const catalogo = await cargarCatalogoAce(getPool);
      const analisis = analizarMuestra(muestra.porCliente, {
        esLogout, nombreServicioLegible,
        extraerNodo: (ip) => (extraerNodo ? extraerNodo(ip) : null),
        extraerVersion: (f) => { const v = extraerVersionApp(f.Sesion); return v ? v.version : null; },
        plataformaDe: (f) => f.Plat || null,
        catalogo, umbrales: umbralesMasivo()
      });
      const r = {
        modo: parametros.modo, ventanaMin: parametros.ventanaMin, fecha: parametros.fecha || null, hora: parametros.hora ?? null,
        tabla: muestra.tabla, tablaFaltante: muestra.tablaFaltante, relojBd: reloj.ahoraTexto,
        lectura: { filasLeidas: muestra.filasLeidas, topeFilas: muestra.topeFilas, truncada: muestra.truncada },
        ...analisis
      };
      guardarCache(clave, r, CACHE_MUESTRA_TTL_MS);
      return r;
    });
    return { ...datos, desdeCache: false, antiguedadMs: 0 };
  }

  async function parametrosMuestra(req, pool) {
    const ventanaPedida = parseInt(req.query.ventana, 10);
    const ventanaMin = VENTANAS_MUESTRA_MIN.includes(ventanaPedida) ? ventanaPedida : 15;
    const fecha = normalizarFechaYMD(req.query.fecha);
    const horaPedida = parseInt(req.query.hora, 10);
    const hora = Number.isFinite(horaPedida) ? limitar(horaPedida, 0, 23) : null;
    const reloj = await relojBd(pool);
    const historico = !!fecha && hora !== null && !(fecha === reloj.hoy && hora >= reloj.hora);
    if (fecha && fecha > reloj.hoy) throw crearErrorHttp(400, 'La fecha no puede ser futura.');
    if (historico && diferenciaDias(fecha, reloj.hoy) > 180) throw crearErrorHttp(400, 'Solo se puede consultar hasta 180 días atrás.');
    return { reloj, parametros: historico ? { modo: 'historico', fecha, hora, ventanaMin } : { modo: 'reciente', ventanaMin } };
  }

  const PRECISION_MUESTRA = 'Muestra acotada de LogApp (no el día completo). Percentil por rango más cercano sobre duraciones medidas (inicio y resultado en el log); con menos de 20 llamadas el p95/p99 no es confiable. Las horas tienen resolución de 1 s (±1 s por duración). Las llamadas sin inicio o sin resultado en el log se cuentan aparte y no entran al cálculo: si son muchas, los tiempos pueden estar sesgados.';

  router.get('/latencia', verifyToken, requireModule('APP_MOVIL'), envolver('latencia', async (req, res) => {
    verificarLimiteUsuario(req);
    const pool = await getLogAppPool();
    const { reloj, parametros } = await parametrosMuestra(req, pool);
    const a = await obtenerAnalisis(pool, parametros, reloj);
    res.json({ modo: a.modo, ventanaMin: a.ventanaMin, fecha: a.fecha, hora: a.hora, relojBd: a.relojBd, lectura: a.lectura, muestra: a.muestra, latencia: a.latencia, ace: a.ace, desdeCache: a.desdeCache, antiguedadMs: a.antiguedadMs, precision: PRECISION_MUESTRA, generadoEn: new Date().toISOString() });
  }));

  router.get('/errores-masivos', verifyToken, requireModule('APP_MOVIL'), envolver('errores-masivos', async (req, res) => {
    verificarLimiteUsuario(req);
    const pool = await getLogAppPool();
    const { reloj, parametros } = await parametrosMuestra(req, pool);
    const a = await obtenerAnalisis(pool, parametros, reloj);
    const verTodas = req.query.todas === '1';
    const causas = a.causas.filter((c) => verTodas || c.masivo || c.clientesAfectados >= 2).slice(0, 40);
    if (causas.length) auditar(req, 'Errores masivos', 'App Móvil', `Consulta de causas de error (${a.muestra.clientes} clientes en la muestra)`);
    res.json({ modo: a.modo, ventanaMin: a.ventanaMin, fecha: a.fecha, hora: a.hora, relojBd: a.relojBd, lectura: a.lectura, muestra: a.muestra, umbrales: a.umbrales, masivas: a.causas.filter((c) => c.masivo).length, causas, desdeCache: a.desdeCache, generadoEn: new Date().toISOString(),
      precision: 'Un error es MASIVO cuando afecta a muchos clientes distintos a la vez: se compara contra los umbrales mostrados (clientes distintos, cantidad de errores y % de las llamadas del servicio). Las causas se agrupan por el código/servicio literal del error. Los CC listados son los de la muestra (hasta 500 por causa).' });
  }));

  router.get('/codigos', verifyToken, requireModule('APP_MOVIL'), envolver('codigos', async (req, res) => {
    verificarLimiteUsuario(req);
    const pool = await getLogAppPool();
    const { reloj, parametros } = await parametrosMuestra(req, pool);
    let vistos = []; let muestra = null; let aviso = null;
    try { const a = await obtenerAnalisis(pool, parametros, reloj); vistos = a.codigos; muestra = a.muestra; }
    catch (e) { aviso = 'No se pudo leer la muestra reciente; se muestra solo el diccionario.'; }
    res.json({ diccionario: diccionario(), vistos, muestra, aviso, nota: 'Un código que no está en el diccionario se muestra tal cual, sin traducción: no se inventan significados.' });
  }));

  // ========================================================================
  // Alertas de error masivo: historial persistente (opcional) + vigilancia
  // ========================================================================
  let tablaAlertasLista = null;
  async function alertasDisponibles() {
    if (tablaAlertasLista !== null) return tablaAlertasLista;
    try {
      const pool = await getPool();
      await pool.query('SELECT 1 FROM AppMovilAlertaMasiva LIMIT 1');
      tablaAlertasLista = true;
    } catch (e) {
      if (esTablaInexistente(e)) tablaAlertasLista = false; else return false;
    }
    return tablaAlertasLista;
  }
  setInterval(() => { if (tablaAlertasLista === false) tablaAlertasLista = null; }, 10 * 60 * 1000).unref();

  router.get('/alertas-masivas', verifyToken, requireModule('APP_MOVIL'), envolver('alertas', async (req, res) => {
    if (!(await alertasDisponibles())) {
      return res.json({ disponible: false, mensaje: 'El historial de alertas necesita la tabla AppMovilAlertaMasiva: pídele al administrador de base de datos que ejecute el script crear_tablas_analisis_app_movil_BIC_CERTI_MARIA.sql una sola vez. Las alertas en vivo (pestaña Errores masivos) funcionan sin ella.', alertas: [] });
    }
    const pool = await getPool();
    const [filas] = await pool.query(
      `SELECT Id, Clave, DATE_FORMAT(Detectada, '%Y-%m-%d %H:%i:%s') AS Detectada, DATE_FORMAT(UltimaVista, '%Y-%m-%d %H:%i:%s') AS UltimaVista,
              Titulo, Tipo, Categoria, Errores, Clientes, TasaError, Servicio
         FROM AppMovilAlertaMasiva ORDER BY Id DESC LIMIT 60`
    );
    res.json({ disponible: true, alertas: filas });
  }));

  router.get('/alertas-masivas/:id', verifyToken, requireModule('APP_MOVIL'), envolver('alerta', async (req, res) => {
    if (!(await alertasDisponibles())) throw crearErrorHttp(503, 'El historial de alertas no está disponible (falta la tabla AppMovilAlertaMasiva).');
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) throw crearErrorHttp(400, 'Alerta inválida.');
    const pool = await getPool();
    const [[f]] = await pool.query('SELECT Id, DATE_FORMAT(Detectada, \'%Y-%m-%d %H:%i:%s\') AS Detectada, DATE_FORMAT(UltimaVista, \'%Y-%m-%d %H:%i:%s\') AS UltimaVista, Titulo, DetalleJson FROM AppMovilAlertaMasiva WHERE Id = ?', [id]);
    if (!f) throw crearErrorHttp(404, 'No se encontró esa alerta.');
    let detalle = null;
    try { detalle = JSON.parse(f.DetalleJson); } catch (e) { detalle = null; }
    auditar(req, 'Alerta de error masivo', `#${id}`, 'Detalle de alerta de error masivo');
    res.json({ id: f.Id, detectada: f.Detectada, ultimaVista: f.UltimaVista, titulo: f.Titulo, detalle });
  }));

  async function destinatariosAlerta(pool) {
    const [filas] = await pool.query(
      `SELECT u.id FROM usuarios u
        WHERE u.activo = 1 AND (u.rol = 'ADMIN_POD' OR EXISTS (SELECT 1 FROM usuario_modulos um JOIN modulos m ON m.id = um.modulo_id WHERE um.usuario_id = u.id AND m.nombre = 'APP_MOVIL'))`
    );
    return filas.map((f) => f.id);
  }

  function textoAlerta(c) {
    const pct = `${(c.tasaError * 100).toFixed(0)}%`;
    const nodos = c.nodos.length ? ` Nodos: ${c.nodos.slice(0, 4).map((n) => `${n.valor} (${n.n})`).join(', ')}.` : '';
    const vers = c.versiones.length ? ` Versiones: ${c.versiones.slice(0, 3).map((n) => `${n.valor} (${n.n})`).join(', ')}.` : '';
    const sig = (c.falla && c.falla.fase) ? '' : '';
    return `${c.errores} errores en ${c.clientesAfectados} clientes distintos (${pct} de las llamadas de ${c.metodos.slice(0, 2).map((m) => m.valor).join(', ')}). Entre ${c.primera.slice(11)} y ${c.ultima.slice(11)}.${nodos}${vers}${sig}`;
  }

  async function guardarYNotificarMasivas(analisis) {
    const masivas = analisis.causas.filter((c) => c.masivo);
    if (!masivas.length) return 0;
    const poolPrincipal = await getPool();
    const repetirMin = numeroEnv('ERROR_MASIVO_REPETIR_MIN', 60, 5, 1440);
    const bucket = Math.floor(Date.now() / (repetirMin * 60 * 1000));
    const hayTabla = await alertasDisponibles();
    const destinatarios = await destinatariosAlerta(poolPrincipal);
    let nuevas = 0;
    for (const c of masivas) {
      const claveUnica = `em-${crypto.createHash('md5').update(c.clave).digest('hex').slice(0, 16)}-${bucket}`;
      const detalle = { ...c, clientes: c.clientes.slice(0, 200), muestraAnalizada: analisis.muestra, umbrales: analisis.umbrales, ventanaMin: analisis.ventanaMin, generadoEn: new Date().toISOString() };
      let alertaId = null;
      if (hayTabla) {
        try {
          const [r] = await poolPrincipal.query(
            `INSERT INTO AppMovilAlertaMasiva (Clave, Bucket, Detectada, UltimaVista, Titulo, Tipo, Categoria, Errores, Clientes, TasaError, Servicio, DetalleJson)
             VALUES (?, ?, NOW(), NOW(), ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE UltimaVista = NOW(), Errores = VALUES(Errores), Clientes = VALUES(Clientes), TasaError = VALUES(TasaError), DetalleJson = VALUES(DetalleJson), Id = LAST_INSERT_ID(Id)`,
            [c.clave.slice(0, 150), bucket, c.titulo.slice(0, 250), c.tipo, c.categoria, c.errores, c.clientesAfectados, c.tasaError,
              c.servicioAce ? `${c.servicioAce.id} ${c.servicioAce.operacion}`.slice(0, 120) : (c.metodos[0] ? c.metodos[0].valor.slice(0, 120) : null), JSON.stringify(detalle).slice(0, 4000000)]
          );
          alertaId = r.insertId || null;
          if (r.affectedRows === 1) nuevas += 1; // 1 = insertada; 2 = actualizada
        } catch (e) { console.error('No se pudo guardar la alerta masiva:', e.message); }
      } else nuevas += 1;
      const enlace = alertaId ? `/app-movil-logs?vista=alertas&alerta=${alertaId}` : '/app-movil-logs?vista=alertas';
      await notificarVarios(poolPrincipal, destinatarios, {
        tipo: 'ERROR_MASIVO', severidad: 'ALERTA', titulo: `Error masivo en App Móvil: ${c.titulo}`.slice(0, 190),
        mensaje: textoAlerta(c), enlace, referencia: alertaId, clave: claveUnica
      });
    }
    return nuevas;
  }

  let vigilanciaEnCurso = false;
  async function cicloVigilancia() {
    if (vigilanciaEnCurso) return;
    if (String(process.env.ERROR_MASIVO_DESHABILITADO || '').toLowerCase() === 'true' || flujoDeshabilitado()) return;
    vigilanciaEnCurso = true;
    try {
      const pool = await getLogAppPool();
      const reloj = await relojBd(pool);
      const ventanaMin = numeroEnv('ERROR_MASIVO_VENTANA_MIN', 15, 5, 60);
      const analisis = await obtenerAnalisis(pool, { modo: 'reciente', ventanaMin: VENTANAS_MUESTRA_MIN.includes(ventanaMin) ? ventanaMin : 15 }, reloj, { ignorarCache: true });
      const n = await guardarYNotificarMasivas(analisis);
      if (n) console.log(`Vigilancia de errores masivos: ${n} alerta(s) nueva(s).`);
    } catch (err) {
      if (!(err && err.statusHttp === 429)) console.error('Vigilancia de errores masivos:', err && err.message);
    } finally { vigilanciaEnCurso = false; }
  }
  const intervaloVigilanciaMs = numeroEnv('ERROR_MASIVO_INTERVALO_MIN', 5, 2, 60) * 60 * 1000;
  setTimeout(cicloVigilancia, 90 * 1000).unref();
  setInterval(cicloVigilancia, intervaloVigilanciaMs).unref();

  // ========================================================================
  // Versiones de la app: ETL diario + consultas
  // ========================================================================
  const T_DIARIA = 'AppMovilVersionDiaria';
  const T_CLIENTE = 'AppMovilVersionCliente';
  let versionesListas = null;
  async function versionesDisponibles() {
    if (versionesListas !== null) return versionesListas;
    try {
      const pool = await getPool();
      await pool.query(`SELECT 1 FROM ${T_DIARIA} LIMIT 1`);
      await pool.query(`SELECT 1 FROM ${T_CLIENTE} LIMIT 1`);
      versionesListas = true;
    } catch (e) {
      if (esTablaInexistente(e)) versionesListas = false; else return false;
    }
    return versionesListas;
  }
  setInterval(() => { if (versionesListas === false) versionesListas = null; }, 10 * 60 * 1000).unref();

  const SQL_VERSION = `SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(Sesion, CHAR(92), ''), 'deviceVersion":"', -1), '"', 1)`;
  const SQL_PLATAFORMA = `CASE WHEN Sesion LIKE '%iPhone%' OR Sesion LIKE '%iPad%' THEN 'iOS' WHEN Sesion LIKE '%release-keys%' THEN 'Android' ELSE 'Otro' END`;
  const SQL_ES_LOGIN = `Descripcion LIKE 'Login exitoso%' AND REPLACE(Sesion, CHAR(92), '') LIKE '%deviceVersion":"%'`;

  async function calcularVersionesDia(fechaTexto, hoy) {
    const poolLog = await getLogAppPool();
    const poolPrincipal = await getPool();
    const tabla = fechaTexto === hoy ? 'Log' : tablaMensual(fechaTexto);
    const [filas] = await consultarConTiempoMaximo(
      poolLog,
      `SELECT Documento AS documento, ${SQL_VERSION} AS version, ${SQL_PLATAFORMA} AS plataforma,
              COUNT(*) AS logins, DATE_FORMAT(MIN(Fecha), '%Y-%m-%d %H:%i:%s') AS primera, DATE_FORMAT(MAX(Fecha), '%Y-%m-%d %H:%i:%s') AS ultima
         FROM LogApp.${tabla}
        WHERE Fecha >= ? AND Fecha <= ? AND ${SQL_ES_LOGIN} AND Documento IS NOT NULL AND Documento <> ''
        GROUP BY Documento, version, plataforma`,
      [`${fechaTexto} 00:00:00`, `${fechaTexto} 23:59:59`],
      8 * 60 * 1000
    );
    const buenas = filas.filter((f) => valorPareceVersion(f.version));
    // Clientes y logins por versión y plataforma (idempotente: se reescribe el día completo).
    const agreg = new Map();
    const totales = { clientes: new Set(), logins: 0 };
    for (const f of buenas) {
      const k = `${f.version}\u0000${f.plataforma}`;
      const a = agreg.get(k) || { version: f.version, plataforma: f.plataforma, clientes: new Set(), logins: 0 };
      a.clientes.add(f.documento); a.logins += Number(f.logins) || 0;
      agreg.set(k, a);
      totales.clientes.add(f.documento); totales.logins += Number(f.logins) || 0;
    }
    for (const a of agreg.values()) {
      await poolPrincipal.query(
        `INSERT INTO ${T_DIARIA} (Fecha, Version, Plataforma, Clientes, Logins, Calculado) VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE Clientes = VALUES(Clientes), Logins = VALUES(Logins), Calculado = NOW()`,
        [fechaTexto, a.version.slice(0, 40), a.plataforma, a.clientes.size, a.logins]
      );
    }
    // Por cliente: primera/última vez que usó esa versión (se mantiene el mínimo y el máximo).
    const LOTE = 400;
    for (let i = 0; i < buenas.length; i += LOTE) {
      const lote = buenas.slice(i, i + LOTE);
      const marcas = lote.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const valores = lote.flatMap((f) => [String(f.documento).slice(0, 30), f.version.slice(0, 40), f.plataforma, f.primera, f.ultima]);
      await poolPrincipal.query(
        `INSERT INTO ${T_CLIENTE} (Documento, Version, Plataforma, PrimeraVez, UltimaVez) VALUES ${marcas}
         ON DUPLICATE KEY UPDATE PrimeraVez = LEAST(PrimeraVez, VALUES(PrimeraVez)), UltimaVez = GREATEST(UltimaVez, VALUES(UltimaVez)), Plataforma = VALUES(Plataforma)`,
        valores
      );
    }
    // Marca de "día calculado".
    await poolPrincipal.query(
      `INSERT INTO ${T_DIARIA} (Fecha, Version, Plataforma, Clientes, Logins, Calculado) VALUES (?, '*', '*', ?, ?, NOW())
       ON DUPLICATE KEY UPDATE Clientes = VALUES(Clientes), Logins = VALUES(Logins), Calculado = NOW()`,
      [fechaTexto, totales.clientes.size, totales.logins]
    );
    return { dias: fechaTexto, clientes: totales.clientes.size, versiones: agreg.size };
  }

  let versionesEnCurso = false;
  async function cicloVersiones() {
    if (versionesEnCurso) return;
    if (String(process.env.VERSIONES_ETL_DESHABILITADO || '').toLowerCase() === 'true' || flujoDeshabilitado()) return;
    versionesEnCurso = true;
    try {
      if (!(await versionesDisponibles())) return;
      const poolLog = await getLogAppPool();
      const reloj = await relojBd(poolLog);
      const poolPrincipal = await getPool();
      const rellenoDias = numeroEnv('VERSIONES_DIAS_RELLENO', 14, 1, 90);
      const [marcas] = await poolPrincipal.query(
        `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d') AS dia, (Calculado >= DATE_ADD(Fecha, INTERVAL 1 DAY)) AS cerrado, TIMESTAMPDIFF(MINUTE, Calculado, NOW()) AS minutos
           FROM ${T_DIARIA} WHERE Version = '*' AND Fecha >= ?`,
        [sumarDias(reloj.hoy, -rellenoDias)]
      );
      const porDia = new Map(marcas.map((m) => [m.dia, m]));
      const pendientes = [];
      for (let d = 0; d <= rellenoDias; d++) {
        const dia = sumarDias(reloj.hoy, -d);
        const m = porDia.get(dia);
        if (!m) pendientes.push(dia);
        else if (dia === reloj.hoy ? Number(m.minutos) >= 30 : !Number(m.cerrado)) pendientes.push(dia);
      }
      // Hoy primero; máximo 2 días por ciclo (el relleno histórico avanza de a poco para no cargar LogApp).
      let procesados = 0;
      for (const dia of pendientes) {
        if (procesados >= 2) break;
        try {
          await calcularVersionesDia(dia, reloj.hoy);
          procesados += 1;
        } catch (err) {
          if (esErrorPorTiempoMaximo(err)) console.error(`Versiones de la app (${dia}): excedió el tiempo máximo.`);
          else console.error(`Versiones de la app (${dia}):`, err.message);
        }
        if (procesados < 2 && pendientes.length > procesados) await new Promise((r) => setTimeout(r, PAUSA_RELLENO_MS));
      }
    } catch (err) {
      console.error('ETL de versiones de la app:', err && err.message);
    } finally { versionesEnCurso = false; }
  }
  setTimeout(cicloVersiones, 120 * 1000).unref();
  setInterval(cicloVersiones, 10 * 60 * 1000).unref();

  const MENSAJE_FALTA_VERSIONES = 'La adopción de versiones necesita dos tablas en BIC_CERTI_MARIA (AppMovilVersionDiaria y AppMovilVersionCliente). Pídele al administrador de base de datos que ejecute una sola vez el script crear_tablas_analisis_app_movil_BIC_CERTI_MARIA.sql. Mientras tanto se muestra la vista rápida de la última ventana de tiempo.';

  /** Vista rápida sin tablas: inicios de sesión exitosos de los últimos N minutos (cifras exactas de esa ventana). */
  async function adopcionVentana(minutos) {
    const pool = await getLogAppPool();
    const [filas] = await consultarConTiempoMaximo(
      pool,
      `SELECT Documento AS documento, ${SQL_VERSION} AS version, ${SQL_PLATAFORMA} AS plataforma, COUNT(*) AS logins,
              DATE_FORMAT(MIN(Fecha), '%Y-%m-%d %H:%i:%s') AS primera, DATE_FORMAT(MAX(Fecha), '%Y-%m-%d %H:%i:%s') AS ultima
         FROM LogApp.Log FORCE INDEX (Index_Log_Fecha)
        WHERE Fecha >= DATE_SUB(NOW(), INTERVAL ? MINUTE) AND ${SQL_ES_LOGIN} AND Documento IS NOT NULL AND Documento <> ''
        GROUP BY Documento, version, plataforma LIMIT 60000`,
      [minutos], 25 * 1000
    );
    return filas.filter((f) => valorPareceVersion(f.version));
  }

  function resumirAdopcion(filas) {
    // Cada cliente cuenta UNA vez, en la versión que usó por última vez.
    const ultimaPorCliente = new Map();
    for (const f of filas) {
      const a = ultimaPorCliente.get(f.documento);
      if (!a || String(f.ultima) > String(a.ultima)) ultimaPorCliente.set(f.documento, f);
    }
    const por = new Map();
    for (const f of ultimaPorCliente.values()) {
      const k = `${f.version}\u0000${f.plataforma}`;
      const a = por.get(k) || { version: f.version, plataforma: f.plataforma, clientes: 0 };
      a.clientes += 1; por.set(k, a);
    }
    return { total: ultimaPorCliente.size, por: [...por.values()] };
  }

  router.get('/versiones/adopcion', verifyToken, requireModule('APP_MOVIL'), envolver('versiones', async (req, res) => {
    verificarLimiteUsuario(req);
    const dias = limitar(parseInt(req.query.dias, 10) || 30, 1, 90);
    const forzarVentana = req.query.modo === 'ventana';
    const disponible = !forzarVentana && (await versionesDisponibles());
    if (!disponible) {
      const minutos = limitar(parseInt(req.query.minutos, 10) || 120, 15, 360);
      const filas = await adopcionVentana(minutos);
      const r = resumirAdopcion(filas);
      const versiones = aVersiones(r.por, r.total);
      return res.json({
        fuente: 'ventana', exacto: false, mensaje: forzarVentana ? null : MENSAJE_FALTA_VERSIONES, minutos,
        totalClientes: r.total, versiones, masReciente: versiones.length ? versiones[0].version : null,
        serie: [], descripcion: `Clientes distintos que iniciaron sesión en los últimos ${minutos} minutos, contados en la versión de su último inicio de sesión.`
      });
    }
    const pool = await getPool();
    const desde = sumarDias((await relojBd(await getLogAppPool())).hoy, -(dias - 1));
    // Versión ACTUAL de cada cliente = la de su último uso dentro del período.
    const [porVersion] = await pool.query(
      `SELECT c.Version AS version, c.Plataforma AS plataforma, COUNT(*) AS clientes
         FROM ${T_CLIENTE} c
         JOIN (SELECT Documento, MAX(UltimaVez) AS maxima FROM ${T_CLIENTE} WHERE UltimaVez >= ? GROUP BY Documento) x
           ON x.Documento = c.Documento AND x.maxima = c.UltimaVez
        GROUP BY c.Version, c.Plataforma`,
      [`${desde} 00:00:00`]
    );
    const total = porVersion.reduce((s, f) => s + Number(f.clientes), 0);
    const versiones = aVersiones(porVersion.map((f) => ({ version: f.version, plataforma: f.plataforma, clientes: Number(f.clientes) })), total);
    const [serie] = await pool.query(
      `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d') AS fecha, Version AS version, Plataforma AS plataforma, Clientes AS clientes, Logins AS logins
         FROM ${T_DIARIA} WHERE Fecha >= ? AND Version <> '*' ORDER BY Fecha, Version`,
      [desde]
    );
    const [[cobertura]] = await pool.query(
      `SELECT COUNT(*) AS dias, DATE_FORMAT(MIN(Fecha), '%Y-%m-%d') AS primero, DATE_FORMAT(MAX(Fecha), '%Y-%m-%d') AS ultimo, DATE_FORMAT(MAX(Calculado), '%Y-%m-%d %H:%i:%s') AS actualizado
         FROM ${T_DIARIA} WHERE Version = '*' AND Fecha >= ?`,
      [desde]
    );
    res.json({
      fuente: 'tablas', exacto: true, dias, desde, totalClientes: total, versiones,
      masReciente: versiones.length ? versiones[0].version : null,
      serie: serie.map((f) => ({ ...f, clientes: Number(f.clientes), logins: Number(f.logins) })),
      cobertura: { dias: Number(cobertura.dias), primero: cobertura.primero, ultimo: cobertura.ultimo, actualizado: cobertura.actualizado, diasPedidos: dias },
      descripcion: `Clientes distintos que iniciaron sesión en los últimos ${dias} días, contados UNA vez, en la versión de su último inicio de sesión (fuente: inicios de sesión exitosos de LogApp, calculados por día).`
    });
  }));

  function aVersiones(por, total) {
    const mapa = new Map();
    for (const f of por) {
      const v = mapa.get(f.version) || { version: f.version, clientes: 0, plataformas: [] };
      v.clientes += f.clientes; v.plataformas.push({ plataforma: f.plataforma, clientes: f.clientes });
      mapa.set(f.version, v);
    }
    return [...mapa.values()]
      .sort((a, b) => compararVersiones(b.version, a.version))
      .map((v, i) => ({ ...v, porcentaje: total ? v.clientes / total : 0, esMasReciente: i === 0, plataformas: v.plataformas.sort((a, b) => b.clientes - a.clientes) }));
  }

  router.get('/versiones/clientes', verifyToken, requireModule('APP_MOVIL'), envolver('versiones-clientes', async (req, res) => {
    verificarLimiteUsuario(req);
    const version = String(req.query.version || '').slice(0, 40);
    if (!valorPareceVersion(version)) throw crearErrorHttp(400, 'Indica una versión válida (ej. 9.0.5).');
    const plataforma = ['iOS', 'Android', 'Otro'].includes(req.query.plataforma) ? req.query.plataforma : null;
    const dias = limitar(parseInt(req.query.dias, 10) || 30, 1, 90);
    const csv = req.query.formato === 'csv';
    const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
    const TAM = csv ? 50000 : 100;
    let filas; let total; let fuente;
    if ((req.query.modo !== 'ventana') && (await versionesDisponibles())) {
      fuente = 'tablas';
      const pool = await getPool();
      const desde = sumarDias((await relojBd(await getLogAppPool())).hoy, -(dias - 1));
      const cond = plataforma ? 'AND c.Plataforma = ?' : '';
      const pars = [`${desde} 00:00:00`, version, ...(plataforma ? [plataforma] : [])];
      const base = `FROM ${T_CLIENTE} c
         JOIN (SELECT Documento, MAX(UltimaVez) AS maxima FROM ${T_CLIENTE} WHERE UltimaVez >= ? GROUP BY Documento) x
           ON x.Documento = c.Documento AND x.maxima = c.UltimaVez
        WHERE c.Version = ? ${cond}`;
      const [[t]] = await pool.query(`SELECT COUNT(*) AS n ${base}`, pars);
      total = Number(t.n);
      const [r] = await pool.query(
        `SELECT c.Documento AS documento, c.Plataforma AS plataforma, DATE_FORMAT(c.PrimeraVez, '%Y-%m-%d %H:%i:%s') AS primeraVez, DATE_FORMAT(c.UltimaVez, '%Y-%m-%d %H:%i:%s') AS ultimaVez
           ${base} ORDER BY c.UltimaVez DESC LIMIT ? OFFSET ?`,
        [...pars, TAM, (pagina - 1) * TAM]
      );
      filas = r;
    } else {
      fuente = 'ventana';
      const minutos = limitar(parseInt(req.query.minutos, 10) || 120, 15, 360);
      const todas = await adopcionVentana(minutos);
      const ult = new Map();
      for (const f of todas) { const a = ult.get(f.documento); if (!a || String(f.ultima) > String(a.ultima)) ult.set(f.documento, f); }
      let l = [...ult.values()].filter((f) => f.version === version && (!plataforma || f.plataforma === plataforma));
      l.sort((a, b) => (a.ultima < b.ultima ? 1 : -1));
      total = l.length;
      filas = l.slice((pagina - 1) * TAM, pagina * TAM).map((f) => ({ documento: f.documento, plataforma: f.plataforma, primeraVez: f.primera, ultimaVez: f.ultima }));
    }
    auditar(req, 'Clientes por versión', `Versión ${version}`, `Listado de ${total} CC de la versión ${version}${csv ? ' (CSV)' : ''}`);
    if (csv) {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const cuerpo = ['Documento,Plataforma,Primera vez,Última vez', ...filas.map((f) => [f.documento, f.plataforma, f.primeraVez, f.ultimaVez].map(esc).join(','))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="clientes_version_${version.replace(/[^0-9A-Za-z._-]/g, '_')}.csv"`);
      return res.send(`﻿${cuerpo}`);
    }
    res.json({ version, plataforma, fuente, total, pagina, tamano: TAM, clientes: filas });
  }));

  // Se devuelven para las pruebas automáticas (no se usan en producción).
  return { cicloVigilancia, guardarYNotificarMasivas, cicloVersiones, calcularVersionesDia };
}

module.exports = registrarRutasAnalisis;
module.exports.compararVersiones = compararVersiones;
