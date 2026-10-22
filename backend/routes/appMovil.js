const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const registrarRutasFlujo = require('./appMovilFlujo');
const registrarRutasAnalisis = require('./appMovilAnalisis');
const registrarRutasTablero = require('./appMovilTablero');
const lenguaje = require('../utils/appMovilLenguaje');
const { extraerVersionApp, resumirVersiones, describirEquipo } = require('../utils/appMovilVersion');
const traza = require('../utils/appMovilTraza');
const { getLogAppPool, getPool } = require('../db'); // LogApp vive en un servidor/usuario distinto al principal (BIC_CERTI_MARIA); getPool() es BIC_CERTI_MARIA, donde vive el ETL de resúmenes diarios (ver más abajo)
// db.js carga el .env (dotenv.config()) como efecto secundario -- por eso se
// requiere ANTES que authMiddleware, que necesita JWT_SECRET ya disponible
// en process.env al momento de cargarse.
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const router = express.Router();

// Metodos que se excluyen de TODAS las metricas: el logout intencionalmente
// devuelve respuestas atipicas (ej. "Success": false con Status 200) que no
// son fallos reales de la app.
const METODOS_EXCLUIDOS = ['setLogOut', 'setLogOut_api'];
const PLACEHOLDERS_METODOS_EXCLUIDOS = METODOS_EXCLUIDOS.map(() => '?').join(', ');

// ==========================================================================
// DETECCION DE FALLOS
// ==========================================================================
// LogApp.Log no tiene una columna booleana "fue exitoso" -- hay que
// inferirlo de Rs (la respuesta) y Adicional (donde cae el error cuando la
// llamada nunca llega a completarse, ej. una excepcion antes del request).
// El propio equipo ya filtra errores en DBeaver buscando
// Rs = 'Error: ... -- STACK: ...' -- esta expresion generaliza ese mismo
// criterio real, en vez de buscar la palabra "Error" a ciegas en cualquier
// columna de texto libre (lo que antes daba falsos positivos/negativos):
//   - Rs o Adicional empiezan con "Error:"      -> la llamada fallo del todo
//   - Rs empieza con "Status: " pero NO es 2xx  -> respondio con un error
const SQL_ES_FALLO = `(
  Rs LIKE 'Error:%' OR
  Adicional LIKE 'Error:%' OR
  (Rs LIKE 'Status: %' AND Rs NOT LIKE 'Status: 2%')
)`;

// ==========================================================================
// UNA LLAMADA = DOS FILAS EN LogApp.Log
// ==========================================================================
// Confirmado con datos reales de producción: cada llamada real queda
// registrada en DOS filas -- una al ARRANCAR (Rs todavía vacío) y otra al
// TERMINAR (Rs ya con la respuesta). Ejemplo real visto en una sesión:
// "UpdateSecureDevice_api" generó una fila a las 07:31:39 (Rs vacío) y otra
// a las 07:31:55 (Rs con la respuesta) -- son la MISMA llamada, no dos
// transacciones distintas.
//
// Esto importa para dos cosas:
//   1) Contar "Transacciones" con COUNT(*) las cuenta DOBLE. Se corrige
//      contando solo las filas de ARRANQUE (SQL_ES_INICIO) -- "Errores" ya
//      estaba bien (SQL_ES_FALLO nunca es verdadero sobre una fila de
//      arranque, porque su Rs todavía está vacío).
//   2) Emparejando la fila de arranque de una llamada con su fila de fin (ver
//      calcularLatenciasDia más abajo) se puede medir cuánto se demoró esa
//      llamada en responder -- sin necesitar una columna de duración que no
//      existe en esta tabla.
const SQL_ES_INICIO = `(Rs IS NULL OR Rs = '')`;

// ==========================================================================
// DISPOSITIVO / FABRICANTE
// ==========================================================================
// La columna Sesion guarda un JSON de texto libre con el "device" real del
// cliente (ej. "HONOR/LGN-NX3/...", "iPhone15,2/..."). No hay columna
// separada para esto, asi que se clasifica con LIKE sobre ese texto -- es
// una heuristica por fabricante (no un parseo de JSON), para no depender de
// funciones JSON que este servidor (distinto al principal) podria no tener
// habilitadas.
const FABRICANTES = [
  { etiqueta: 'iPhone / iOS', patron: '%iPhone%' },
  { etiqueta: 'Samsung', patron: '%samsung%' },
  { etiqueta: 'Xiaomi / Redmi', patron: '%edmi%' },
  { etiqueta: 'Honor / Huawei', patron: '%HONOR%' },
  { etiqueta: 'Oppo', patron: '%OPPO%' },
  { etiqueta: 'Vivo', patron: '%vivo%' },
  { etiqueta: 'Motorola', patron: '%motorola%' }
];

const ETIQUETA_DISPOSITIVO_OTRO = 'Otro / no identificado';

// ==========================================================================
// NOMBRES LEGIBLES PARA SERVICIOS/MÉTODOS (visor de logs)
// ==========================================================================
// LogApp.Log guarda el nombre técnico del método (ej. "getAcctListCardInfo")
// -- útil para desarrollo, pero no dice nada a una persona de soporte u
// operaciones. Este diccionario traduce los métodos más comunes (tomados de
// la tabla "Efectividad por Funcionalidad" del propio dashboard y de los
// análisis de flujo de Login/Carga de Productos) a una descripción clara en
// español. Lo que no esté acá cae a `humanizarNombreTecnico`, que al menos
// separa el camelCase en palabras -- nunca se le oculta un método a la
// persona solo porque no está en la lista.
const SERVICIOS_LEGIBLES = {
  // --- Login / sesión ---
  login_api: 'Inicio de sesión',
  Login: 'Inicio de sesión',
  getUserInfo_api: 'Consulta de información del usuario (login)',
  getUser: 'Consulta de datos del usuario',
  getCustInfo: 'Datos demográficos del cliente',
  getCustListInfo: 'Datos de perfil del cliente',
  addDobleOTP: 'Generación de clave OTP (doble factor)',
  getValidDobleOTP: 'Validación de clave OTP (doble factor)',
  setUpdSecureDevice: 'Registro del dispositivo de confianza',
  setLogOut: 'Cierre de sesión',
  setLogOut_api: 'Cierre de sesión',
  getNotificationList: 'Listado de notificaciones',
  getUserNotificationList: 'Listado de notificaciones',

  // --- Carga de productos (Home) ---
  getBringDetailHome: 'Campañas y promociones del Home',
  SetTransactionalClientLimit: 'Topes transaccionales del cliente',
  getAcctListInfoLite: 'Listado de cuentas y tarjetas débito',
  getAccountListCardInfoLite: 'Listado de cuentas y tarjetas débito',
  getStatusMediaInfo: 'Estado de medios físicos/virtuales',
  getProductsArrears: 'Consulta de mora',
  getAcctListCardInfo: 'Tarjetas de crédito por cuenta',
  getCardsByCurrency: 'Tarjetas de crédito por moneda',
  getBlockQuery: 'Consulta de bloqueos',
  getAcctListFidInfo: 'Kilómetros ORO / fidelización',
  getParamBusinessInfo: 'Parámetros de negocio',
  getXMTAccumulated: 'Acumulado de puntos/millas',
  getKMTAccumulated: 'Kilómetros acumulados (KMT)',
  getCreditScore: 'Consulta de score crediticio',
  consultLaw: 'Consulta Ley 2300 (restricción de cobranza)',
  setScoreApp: 'Encuesta de calificación de la app',
  getPassiveTrnInfo: 'Movimientos de cuentas (pasivos)',
  getTransactionalClientLimit: 'Topes transaccionales del cliente',
  productsSignature: 'Firmas pendientes',
  UpdateSecureDevice_api: 'Actualización del dispositivo seguro',
  validateUserInfo: 'Validación de datos del usuario',
  userCardsLogin: 'Tarjetas del usuario (login)',
  userProductsLogin: 'Productos del usuario (login)',
  getVirtualCardData: 'Datos de tarjeta virtual',
  getDetailVirtualCard: 'Detalle de tarjeta virtual',
  resolveKeyBreB: 'Resolver llave Bre-B',
  generateTransfersBreb: 'Transferencia Bre-B',
  getHomologationList: 'Listas de homologación (parámetros)',
  getConfigRestrictions: 'Restricciones de configuración',
  getPaymentHistory: 'Historial de pagos',
  getAcctInq: 'Consulta de cuenta',

  // --- Pagos y trazabilidad ---
  createLogAdvance: 'Registro de avance de pago'
};

// Separa "getAcctListCardInfo" -> "Get Acct List Card Info" como respaldo
// para cualquier método que no esté en SERVICIOS_LEGIBLES -- nunca se
// esconde un método, solo se hace algo más legible que el nombre crudo.
function humanizarNombreTecnico(texto) {
  if (!texto) return '';
  const conEspacios = String(texto)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return conEspacios.charAt(0).toUpperCase() + conEspacios.slice(1);
}

function nombreServicioLegible(metodo) {
  if (!metodo) return 'Servicio desconocido';
  return SERVICIOS_LEGIBLES[metodo] || humanizarNombreTecnico(metodo);
}

// Formatea el FuncionalidadCodigo crudo (numérico, ej. 4) como el código
// "Cxxx" que el usuario reconoce del texto de detalle (ej. "C004"). Un mismo
// código de funcionalidad puede agrupar varios métodos distintos (ej. 60 y
// 61 agrupan varios métodos de AKAUNT) -- por eso se muestra junto al
// Clase.Método existente en vez de reemplazarlo, nunca en su lugar.
function formatearCodigoServicio(codigo) {
  if (codigo === null || codigo === undefined || codigo === '') return null;
  const numero = Number(codigo);
  if (!Number.isFinite(numero)) return null;
  return `C${String(numero).padStart(3, '0')}`;
}

// ==========================================================================
// RESILIENCIA DE CONSULTAS CONTRA LogApp.Log
// ==========================================================================
// LogApp.Log es una base que NO administramos (no podemos crear índices ni
// tablas ahí -- confirmado con el equipo). Es una tabla de altísimo volumen
// (500+ clientes/minuto) y sus índices son todos de una sola columna: para
// una consulta que filtra por Fecha pero necesita otras columnas (Metodo,
// CanalCodigo, Rs...), el motor tiene que "saltar" de vuelta a la tabla
// completa por cada fila que califica -- confirmado en vivo con SHOW
// PROCESSLIST: una sola consulta de /analytics tardó más de 100 segundos en
// estado "Copying to tmp table". No es un bug de esta ruta ni de índices
// faltantes en el sentido corregible por nosotros: es el costo real de leer
// esta tabla desde afuera, sin poder tocar su esquema.
//
// La estrategia para que el panel sea usable de todas formas, sin alterar
// ninguna base de datos:
//   1) Un límite duro de tiempo por consulta (MAX_STATEMENT_TIME de MariaDB)
//      -- si algo se cuelga de verdad, se corta con un error claro en vez de
//      dejar la conexión (y al usuario) esperando para siempre.
//   2) Un caché en memoria de vida larga con "stale-while-revalidate": se
//      sirve el último resultado ya calculado al instante, y si está por
//      vencer, se recalcula de fondo sin que el usuario tenga que esperar.
//   3) Un "calentador" en segundo plano que recalcula la vista por defecto
//      cada pocos minutos, para que casi nunca haya alguien esperando la
//      consulta pesada en vivo.
//   4) Deduplicación de peticiones simultáneas -- si dos personas piden lo
//      mismo mientras ya se está calculando, comparten el mismo cálculo en
//      vez de disparar dos consultas pesadas en paralelo contra LogApp.
// ==========================================================================

// Tiempo máximo que se le permite correr a una sola consulta contra
// LogApp.Log antes de cancelarla. Nginx tiene su propio proxy_read_timeout de
// 300s (frontend/nginx.conf.template) -- este valor se dejó con margen de
// sobra por debajo de eso (90s) para que, aunque una consulta individual se
// tope con el límite, el backend alcance a responder ANTES de que nginx
// corte la conexión y devuelva su propio 504 genérico. Las 6 consultas de
// /analytics corren en paralelo (Promise.all), así que este límite aplica al
// tiempo total, no se multiplica por consulta.
//
// El servidor de LogApp corre MariaDB 5.5 (confirmado con SELECT VERSION()),
// una versión anterior a MAX_STATEMENT_TIME / SET STATEMENT ... FOR (eso
// llegó en MariaDB 10.1) -- no hay forma de pedirle al propio motor que se
// autocancele. En su lugar, se toma la conexión directamente y, si se pasa
// del tiempo límite, se destruye el socket a la fuerza: MariaDB detecta la
// desconexión abrupta del cliente y aborta la consulta que tenía en curso
// del lado del servidor. Es un efecto de protocolo TCP, no una función de
// SQL, así que funciona sin importar la versión del motor.
const TIEMPO_MAXIMO_CONSULTA_SEGUNDOS = 90;
const TIEMPO_MAXIMO_CONSULTA_MS = TIEMPO_MAXIMO_CONSULTA_SEGUNDOS * 1000;

// ==========================================================================
// TIEMPO MÁXIMO SEPARADO PARA LA ETL (fondo, sin nginx de por medio)
// ==========================================================================
// El límite de arriba (90s) existe para que una petición EN VIVO (/analytics,
// /errores-detalle) alcance a responder antes de que nginx corte la conexión
// a los 300s. La ETL (ejecutarCicloEtl, corre en segundo plano cada
// ETL_INTERVALO_MS) no tiene ningún usuario ni nginx esperando su respuesta
// -- puede permitirse un límite mucho más generoso.
//
// Esto importa de verdad ahora que la ETL consulta la tabla mensual correcta
// (Log_YYYYMM) en vez de siempre Log: una tabla mensual tiene ~30x más filas
// que Log (que solo es HOY), y como no se le pueden crear índices, un filtro
// de un solo día sigue obligando a un recorrido completo de la tabla del mes
// -- confirmado en producción: con el límite de 90s, CADA día del relleno
// histórico fallaba por tiempo excedido, siempre justo en el límite (nunca se
// alcanzó a ver cuánto tardaba realmente la consulta). Con este límite más
// alto la ETL puede esperar lo que de verdad tome, y su propio candado
// (etlEnCursoDesde/ETL_TIEMPO_MAXIMO_BLOQUEO_MS más abajo) sigue protegiendo
// contra un cuelgue real.
const TIEMPO_MAXIMO_CONSULTA_ETL_SEGUNDOS = 8 * 60;
const TIEMPO_MAXIMO_CONSULTA_ETL_MS = TIEMPO_MAXIMO_CONSULTA_ETL_SEGUNDOS * 1000;

async function consultarConTiempoMaximo(pool, sql, parametros, tiempoMaximoMsPersonalizado) {
  const tiempoMaximoMs = tiempoMaximoMsPersonalizado || TIEMPO_MAXIMO_CONSULTA_MS;
  const tiempoMaximoSegundos = Math.round(tiempoMaximoMs / 1000);
  const conexion = await pool.getConnection();
  let agotado = false;
  const temporizador = setTimeout(() => {
    agotado = true;
    conexion.destroy();
  }, tiempoMaximoMs);

  // CORRECCIÓN (bug real encontrado en producción): destruir la conexión
  // (arriba) no garantiza que la promesa de conexion.query() se rechace --
  // en la práctica esto dejó la ETL colgada para siempre (ni éxito ni
  // error en los logs, etlEnCurso nunca se liberaba, ningún ciclo futuro
  // volvía a intentarlo). Por eso ahora se corre una carrera explícita
  // contra un timeout propio que SIEMPRE rechaza, sin depender de que
  // mysql2 reaccione al destroy() de la manera esperada. Se le da 2
  // segundos de margen extra para que, si mysql2 sí rechaza por su cuenta,
  // sea ese el error "limpio" que se propague.
  const promesaTiempoMaximo = new Promise((_, reject) => {
    setTimeout(() => {
      const errorTiempo = new Error(`La consulta excedió el tiempo máximo permitido (${tiempoMaximoSegundos}s).`);
      errorTiempo.esTiempoMaximoExcedido = true;
      reject(errorTiempo);
    }, tiempoMaximoMs + 2000);
  });

  try {
    return await Promise.race([conexion.query(sql, parametros), promesaTiempoMaximo]);
  } catch (err) {
    if (err && err.esTiempoMaximoExcedido) throw err;
    if (agotado) {
      const errorTiempo = new Error(`La consulta excedió el tiempo máximo permitido (${tiempoMaximoSegundos}s).`);
      errorTiempo.esTiempoMaximoExcedido = true;
      throw errorTiempo;
    }
    throw err;
  } finally {
    clearTimeout(temporizador);
    // Si se agotó el tiempo, la conexión ya fue destruida (destroy()) y no
    // debe devolverse al pool -- mysql2 la descarta sola al detectar que el
    // socket se cerró. release() puede lanzar si la conexión ya quedó en
    // mal estado (por ejemplo si ganó la carrera el timeout propio, no el
    // destroy()) -- se ignora ese caso puntual, ya se está descartando.
    if (!agotado) {
      try {
        conexion.release();
      } catch (_) {
        /* conexión ya inválida -- no hay nada que liberar */
      }
    }
  }
}

function esErrorPorTiempoMaximo(err) {
  return !!(err && err.esTiempoMaximoExcedido);
}

// ==========================================================================
// HELPERS DE FECHAS Y FILTROS
// ==========================================================================

// Acota cuántos días de la tabla puede tocar una sola consulta -- con 500+
// clientes/minuto y varias operaciones por cliente, LogApp.Log crece varios
// millones de filas por día, así que un rango sin tope podría escanear cientos
// de millones de filas en una sola petición.
const RANGO_DIAS_MAXIMO = 180;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Fecha -> 'YYYY-MM-DD HH:mm:ss' en la hora local del proceso Node, para
// pasarla como parámetro de un BETWEEN (evita construir el literal a mano en
// el SQL y con eso el riesgo de inyección).
function formatearFechaSql(fecha) {
  return `${fecha.getFullYear()}-${pad2(fecha.getMonth() + 1)}-${pad2(fecha.getDate())} ${pad2(fecha.getHours())}:${pad2(fecha.getMinutes())}:${pad2(fecha.getSeconds())}`;
}

// ==========================================================================
// LogApp NO es una sola tabla -- confirmado directamente con el usuario:
//   - `Log`        : SIEMPRE el día de HOY (se vacía y rota a medianoche;
//                    mañana será el día siguiente, y así cada noche).
//   - `Log_YYYYMM` : un mes YA CERRADO tiene el mes completo (día 1 al
//                    último); el mes EN CURSO solo tiene del día 1 hasta
//                    AYER (hoy todavía vive en `Log`, no se ha movido ahí).
// Antes de esto, TODAS las consultas (ETL y en vivo) apuntaban siempre a
// `LogApp.Log` sin importar la fecha pedida -- cualquier día que no fuera
// hoy devolvía 0 filas en silencio (esos datos viven en la tabla del mes,
// no en `Log`), y el ETL guardaba resúmenes en cero para todo el histórico
// creyendo que había tenido éxito.
// ==========================================================================

// Nombre de la tabla mensual (Log_YYYYMM) para una fecha dada. Solo válido
// para fechas que NO sean hoy -- para eso ver nombreTablaLogParaUnDia.
function nombreTablaLogMensual(fecha) {
  return `Log_${fecha.getFullYear()}${pad2(fecha.getMonth() + 1)}`;
}

// Para una consulta de UN solo día calendario (como usa el ETL): 'Log' si
// ese día es hoy, o la tabla del mes correspondiente en cualquier otro caso.
function nombreTablaLogParaUnDia(fecha) {
  const hoy = inicioDelDia(new Date());
  return inicioDelDia(fecha).getTime() === hoy.getTime() ? 'Log' : nombreTablaLogMensual(fecha);
}

// Para un RANGO de fechas (puede cruzar varios meses, y puede incluir hoy
// junto con días anteriores): devuelve la lista de tramos
// {tabla, desde, hasta} (fechas 'YYYY-MM-DD') que hay que consultar por
// separado contra cada tabla y sumar en Node -- una sola tabla nunca
// alcanza para cubrir un rango así.
function tablasLogParaRango(fechaInicioTexto, fechaFinTexto) {
  const hoy = inicioDelDia(new Date());
  const hoyTexto = formatearFechaCorta(hoy);
  const ayerTexto = formatearFechaCorta(new Date(hoy.getTime() - 24 * 60 * 60 * 1000));

  const tramos = [];

  // Tramo de HOY -- vive solo en `Log`, nunca en una tabla mensual.
  if (fechaInicioTexto <= hoyTexto && fechaFinTexto >= hoyTexto) {
    tramos.push({ tabla: 'Log', desde: hoyTexto, hasta: hoyTexto });
  }

  // Resto del rango (todo lo que sea hasta ayer, nunca hoy), repartido por
  // mes calendario -- cada mes cerrado o en curso vive en su propia tabla.
  const finSinHoy = fechaFinTexto > ayerTexto ? ayerTexto : fechaFinTexto;
  if (fechaInicioTexto <= finSinHoy) {
    let cursor = new Date(`${fechaInicioTexto}T00:00:00`);
    const limite = new Date(`${finSinHoy}T00:00:00`);
    while (cursor <= limite) {
      const finDeMes = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      const finTramo = finDeMes < limite ? finDeMes : limite;
      tramos.push({
        tabla: nombreTablaLogMensual(cursor),
        desde: formatearFechaCorta(cursor),
        hasta: formatearFechaCorta(finTramo),
      });
      cursor = new Date(finTramo.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  return tramos;
}

// Resuelve el rango de fechas a consultar. Admite dos formas, sin romper la
// que ya existía:
//   - ?dias=N (como antes): se sigue traduciendo a
//     "Fecha >= DATE_SUB(NOW(), INTERVAL N DAY)" tal cual estaba, calculado
//     por el propio motor de base de datos (no por el reloj de Node, para no
//     introducir un desfase si los relojes de app y BD no están sincronizados).
//   - ?fechaInicio=YYYY-MM-DD&fechaFin=YYYY-MM-DD (selector de rango
//     personalizado del frontend): usa un BETWEEN explícito. Si el rango es
//     inválido (fechas mal formadas, inicio > fin) o supera el máximo
//     permitido, se descarta silenciosamente y se cae al comportamiento de
//     "últimos N días" -- nunca se deja pasar una consulta sin acotar.
function resolverRangoFechas(query) {
  const fechaInicioTexto = (query.fechaInicio || '').trim();
  const fechaFinTexto = (query.fechaFin || '').trim();

  if (fechaInicioTexto && fechaFinTexto) {
    const desde = new Date(`${fechaInicioTexto}T00:00:00`);
    const hasta = new Date(`${fechaFinTexto}T23:59:59`);
    if (!Number.isNaN(desde.getTime()) && !Number.isNaN(hasta.getTime()) && desde <= hasta) {
      const diasSolicitados = Math.max(1, Math.ceil((hasta.getTime() - desde.getTime()) / (1000 * 60 * 60 * 24)));
      if (diasSolicitados <= RANGO_DIAS_MAXIMO) {
        return {
          dias: diasSolicitados,
          rangoPersonalizado: true,
          fechaInicio: fechaInicioTexto,
          fechaFin: fechaFinTexto,
          whereFecha: 'Fecha BETWEEN ? AND ?',
          parametrosFecha: [formatearFechaSql(desde), formatearFechaSql(hasta)],
          // Límites en 'YYYY-MM-DD' (sin hora), calculados en Node -- los usa
          // tablasLogParaRango (ver arriba) para decidir qué tabla(s) de
          // LogApp consultar. whereFecha/parametrosFecha de arriba solo
          // sirven contra BIC_CERTI_MARIA (rollup), que no está particionado
          // por mes y por eso no necesita esto.
          fechaInicioTexto,
          fechaFinTexto
        };
      }
    }
  }

  const dias = Math.min(Math.max(parseInt(query.dias, 10) || 7, 1), RANGO_DIAS_MAXIMO);
  // Mismo cálculo (hoy y los dias-1 días anteriores) que ya usaba
  // calcularAnalyticsDesdeRollup para su propio fechaInicioTexto/fechaFinTexto
  // -- se centraliza acá para que la vista con filtro (LogApp en vivo) cuente
  // exactamente los mismos días calendario que la vista sin filtro (rollup)
  // al pedir, por ejemplo, "últimos 7 días".
  const hoy = inicioDelDia(new Date());
  const desdeCalculado = new Date(hoy.getTime() - (dias - 1) * 24 * 60 * 60 * 1000);
  return {
    dias,
    rangoPersonalizado: false,
    fechaInicio: null,
    fechaFin: null,
    whereFecha: 'Fecha >= DATE_SUB(NOW(), INTERVAL ? DAY)',
    parametrosFecha: [dias],
    fechaInicioTexto: formatearFechaCorta(desdeCalculado),
    fechaFinTexto: formatearFechaCorta(hoy)
  };
}

// Filtros opcionales de canal y dispositivo -- se centralizan acá porque
// /analytics y /errores-detalle (y su exportación) necesitan aplicar
// exactamente el mismo criterio para que los números de todas las vistas
// coincidan entre sí.
// Documento (CC/NIT) de un cliente puntual -- se acepta tal cual lo escriba
// la persona (dígitos, y ocasionalmente letras/guión en NITs), solo se
// recorta espacios y se acota el largo. Al ir siempre como parámetro (?)
// nunca hay riesgo de inyección; la validación acá es solo para descartar
// basura evidente (vacío, absurdamente largo) antes de mandarla a LogApp.
function documentoValido(query) {
  const texto = (query.documento || '').trim();
  if (!texto || texto.length > 30) return null;
  return texto;
}

function condicionesFiltros(query) {
  const condiciones = [];
  const parametros = [];

  const canalTexto = (query.canal || '').trim();
  if (canalTexto !== '' && !Number.isNaN(Number(canalTexto))) {
    condiciones.push('CanalCodigo = ?');
    parametros.push(Number(canalTexto));
  }

  const dispositivo = (query.dispositivo || '').trim();
  if (dispositivo) {
    const fabricante = FABRICANTES.find((f) => f.etiqueta === dispositivo);
    if (fabricante) {
      condiciones.push('Sesion LIKE ?');
      parametros.push(fabricante.patron);
    } else if (dispositivo === ETIQUETA_DISPOSITIVO_OTRO) {
      // Ningún patrón de fabricante conocido coincide con la sesión.
      condiciones.push(`(${FABRICANTES.map(() => 'Sesion NOT LIKE ?').join(' AND ')})`);
      parametros.push(...FABRICANTES.map((f) => f.patron));
    }
  }

  // Filtro por Documento (CC) -- permite ver la analítica/errores de UN
  // cliente puntual en vez del agregado general. Como cualquier otro filtro
  // de esta función, activarlo hace que /analytics rutee a LogApp en vivo
  // (ver calcularAnalytics) en vez del resumen diario pre-agregado: aunque
  // AppMovilPorClienteDiario (ver TABLA_POR_CLIENTE_DIARIO) ya guarda
  // Total/Errores por cliente por día, esa tabla no tiene el desglose por
  // canal/dispositivo/funcionalidad ni la tendencia diaria que esta vista
  // necesita -- solo sirve para reportes agregados por cliente, no para
  // reconstruir la respuesta completa de /analytics.
  const documento = documentoValido(query);
  if (documento) {
    condiciones.push('Documento = ?');
    parametros.push(documento);
  }

  return { condiciones, parametros };
}

// Documento enmascarado (ej. "*******0164"). Las vistas de logs ya NO lo usan
// (decisión del negocio: se muestra la información tal como está en el log);
// queda solo para la bitácora de auditoría, que no necesita guardar el
// documento completo.
function enmascararDocumento(doc) {
  const texto = String(doc == null ? '' : doc);
  if (texto.length <= 4) return texto;
  return '*'.repeat(texto.length - 4) + texto.slice(-4);
}

// Resume el mensaje de error SIN exponer el cuerpo completo de la
// respuesta (que puede traer saldos, numeros de cuenta u otros datos de la
// transaccion del cliente). Para un fallo total ("Error: ...") se recorta
// antes del stack tecnico; para una respuesta con codigo de error
// ("Status: 500 - {...}") solo se conserva el codigo, nunca el cuerpo.
function resumirMensajeError(rs, adicional) {
  const texto = (rs && rs.trim()) || (adicional && adicional.trim()) || '';
  if (texto.startsWith('Error:')) {
    return texto.split('-- STACK:')[0].trim().slice(0, 200);
  }
  if (texto.startsWith('Status:')) {
    const match = texto.match(/^Status:\s*(\d+)/);
    return match ? `Respondio con estado ${match[1]}` : 'Respondio con un estado no exitoso';
  }
  return texto.slice(0, 200) || 'Fallo sin mensaje registrado';
}

// Misma regla que SQL_ES_FALLO (arriba) pero evaluada en Node sobre una fila
// ya traída -- se usa en el visor de logs, donde cada fila puede ser un
// éxito, un fallo, o un "arranque" (todavía sin Rs) y no solo el caso de
// error que ya cubre mapearErrorFila/resumirMensajeError.
function esFilaFallida(rs, adicional) {
  const textoRs = rs == null ? '' : String(rs);
  const textoAdicional = adicional == null ? '' : String(adicional);
  if (textoRs.startsWith('Error:') || textoAdicional.startsWith('Error:')) return true;
  if (textoRs.startsWith('Status: ') && !textoRs.startsWith('Status: 2')) return true;
  return false;
}

// Cuánto tiempo (minutos) una fila de "arranque" sin Rs todavía puede
// razonablemente seguir en curso de verdad. Pasado esto, ya no tiene
// sentido mostrarla como "en curso" -- ver Tiempo de Login (~3s) y las
// latencias reales que calcula calcularLatenciasDia: ninguna llamada
// legítima tarda minutos en responder. Si después de este umbral sigue sin
// Rs, es casi seguro que nunca va a llegar su fila de fin (la app se
// cerró, perdió conexión, o el usuario simplemente dejó de interactuar) --
// mostrarla como "en curso" horas (o días) después confunde a quien esté
// mirando el panel, dándole la impresión de que el cliente sigue activo.
const MINUTOS_LIMITE_LLAMADA_EN_CURSO = 5;

// Antes en 15: el usuario reportó que la lista de métodos en "Efectividad
// por Funcionalidad" se sentía muy corta ("son muy pococo") -- se sube a 30
// para mostrar más servicios sin volver la tabla inmanejable.
const LIMITE_FUNCIONALIDADES_MOSTRADAS = 30;

// Estado legible de una fila para el visor de logs. La lectura vive en
// utils/appMovilLenguaje.js (la misma que usa el recorrido del cliente), y
// distingue: exito | error | aviso | inicio | paso | info.
// IMPORTANTE: una fila sin Rs/Rq/Datos NO es una "llamada sin respuesta": el
// inicio de una operación y los pasos internos no guardan respuesta por diseño.
function estadoLegibleFila(f) {
  const c = lenguaje.clasificarFilaLog(f);
  return { estado: c.estado, etiqueta: c.estadoTexto, tipo: c.tipo, tipoTexto: c.tipoTexto };
}

// La columna Ip guarda "<ip>-9:3" (la IP real seguida de un sufijo interno
// de la app). Nos quedamos solo con la IP para mostrarla.
function extraerIp(valor) {
  if (!valor) return null;
  return String(valor).split('-')[0];
}

// El sufijo de Ip ("<ip>-9:3") indica el nodo que atendió la petición: 9 -> nodo 109,
// 8 -> 108, 7 -> 107, 6 -> 106 (el número tras los dos puntos es otro dato interno de la app).
function extraerNodo(valor) {
  const m = /-(\d{1,3}):(\d+)\s*$/.exec(String(valor || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n < 100 ? 100 + n : n;
}

// Clasifica el dispositivo real a partir del JSON de Sesion, para mostrar
// un ejemplo legible en el detalle de errores (no se usa para las
// estadisticas agregadas, que ya se calculan con LIKE directo en SQL).
function clasificarDispositivo(sesionTexto) {
  if (!sesionTexto) return 'Desconocido';
  const encontrado = FABRICANTES.find((f) => sesionTexto.toLowerCase().includes(f.patron.replace(/%/g, '').toLowerCase()));
  return encontrado ? encontrado.etiqueta : 'Otro';
}

// Convierte una fila cruda de LogApp.Log en el objeto que consume el
// frontend -- compartido entre /errores-detalle y su exportación en CSV
// para que ambas vistas muestren exactamente lo mismo.
function mapearErrorFila(f) {
  return {
    documento: f.Documento == null ? null : String(f.Documento),
    fecha: f.Fecha,
    clase: f.Clase,
    metodo: f.Metodo,
    // Nombre legible del servicio (mismo diccionario que el visor de logs) --
    // antes solo se veía el nombre técnico del método, que no dice nada a
    // alguien de soporte/operaciones. Se quitó CanalCodigo de esta vista: en
    // la práctica solo existe un canal (la app móvil), así que esa columna
    // nunca aportaba información (mismo criterio ya aplicado al desglose
    // "por canal" del panel principal).
    servicio: nombreServicioLegible(f.Metodo),
    ip: extraerIp(f.Ip),
    dispositivo: clasificarDispositivo(f.Sesion),
    mensaje: resumirMensajeError(f.Rs, f.Adicional)
  };
}

// Misma idea que mapearErrorFila, pero para el visor de logs general (no
// solo errores): cada fila -- éxito, fallo, inicio o paso interno -- se traduce
// a algo legible para una persona no técnica. NO se oculta información: el
// documento se muestra completo y el contenido (Rq/Rs/Datos) se consulta,
// ya traducido, con /logs/detalle.
function mapearLogFila(f) {
  const estado = estadoLegibleFila(f);
  return {
    codigo: f.Codigo,
    documento: f.Documento == null ? null : String(f.Documento),
    fecha: f.Fecha,
    fechaTxt: f.FechaTxt || null,
    clase: f.Clase,
    metodo: f.Metodo,
    servicio: nombreServicioLegible(f.Metodo),
    descripcion: f.Descripcion || null,
    canalCodigo: f.CanalCodigo,
    funcionalidadCodigo: f.FuncionalidadCodigo,
    tipoCodigo: f.TipoCodigo,
    procesoCodigo: f.ProcesoCodigo,
    transaccion: f.Transaccion,
    ip: extraerIp(f.Ip),
    nodo: extraerNodo(f.Ip),
    dispositivo: clasificarDispositivo(f.Sesion),
    equipo: describirEquipo(f.Sesion),
    version: (extraerVersionApp(f.Sesion, f.Adicional) || {}).version || null,
    estado: estado.estado,
    estadoTexto: estado.etiqueta,
    tipoFila: estado.tipo,
    tipoTexto: estado.tipoTexto
  };
}

// ==========================================================================
// CACHÉ EN MEMORIA DE /analytics -- "stale-while-revalidate" + single-flight
// ==========================================================================
// - CACHE_TTL_MS: mientras el resultado tenga menos de esta antigüedad, se
//   sirve tal cual, sin ni siquiera pensar en refrescar.
// - CACHE_MARGEN_OBSOLETO_MS: pasado el TTL pero dentro de este margen, se
//   sigue sirviendo ese resultado (ya "obsoleto") al instante, mientras se
//   dispara un recálculo de fondo que actualiza el caché para la próxima
//   vez. El usuario nunca espera la consulta pesada mientras haya algo
//   servible en caché, aunque tenga unos minutos de rezago.
// - Pasado ese margen sin nadie haberlo pedido (caché realmente frío, ej.
//   recién reiniciado el servidor), sí hay que esperar el cálculo -- eso solo
//   debería pasar en el peor de los casos gracias al precalentamiento de
//   abajo.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MARGEN_OBSOLETO_MS = 20 * 60 * 1000;
const LIMITE_ENTRADAS_CACHE = 200;
const cacheAnalytics = new Map();
// Peticiones de cálculo en curso, por clave -- evita que dos usuarios (o el
// precalentador y un usuario) disparen la misma consulta pesada al mismo
// tiempo. El segundo que llega simplemente espera el mismo resultado.
const calculosEnVuelo = new Map();

function claveCacheAnalytics(rango, query) {
  return JSON.stringify({
    dias: rango.dias,
    rangoPersonalizado: rango.rangoPersonalizado,
    fechaInicio: rango.fechaInicio,
    fechaFin: rango.fechaFin,
    canal: (query.canal || '').trim(),
    dispositivo: (query.dispositivo || '').trim(),
    // BUG corregido: faltaba acá. Sin esto, filtrar por un cliente (CC)
    // devolvía del caché el mismo resultado ya guardado para la vista
    // GENERAL (mismo dias/canal/dispositivo, documento vacío en ambos casos
    // si no se incluye), así que las tarjetas de resumen nunca cambiaban al
    // buscar un cliente puntual -- se seguía viendo el agregado de todos.
    documento: documentoValido(query) || ''
  });
}

function leerEstadoCacheAnalytics(clave) {
  const entrada = cacheAnalytics.get(clave);
  if (!entrada) return { datos: null, fresco: false, servible: false };

  const antiguedad = Date.now() - entrada.generadoEn;
  if (antiguedad <= CACHE_TTL_MS) return { datos: entrada.datos, fresco: true, servible: true };
  if (antiguedad <= CACHE_TTL_MS + CACHE_MARGEN_OBSOLETO_MS) return { datos: entrada.datos, fresco: false, servible: true };
  return { datos: null, fresco: false, servible: false };
}

function guardarCacheAnalytics(clave, datos) {
  // Límite defensivo: si llegaran demasiadas combinaciones distintas de
  // filtros a la vez, se vacía entera en vez de crecer sin control -- el
  // costo es, a lo sumo, algunas consultas de más hasta que se repuebla.
  if (cacheAnalytics.size >= LIMITE_ENTRADAS_CACHE) cacheAnalytics.clear();
  cacheAnalytics.set(clave, { datos, generadoEn: Date.now() });
}

// Ejecuta (o reutiliza, si ya hay una en curso) el cálculo pesado de
// analítica para una clave dada, y lo deja guardado en caché al terminar.
function calcularYCachear(clave, rango, query) {
  if (calculosEnVuelo.has(clave)) return calculosEnVuelo.get(clave);

  const promesa = calcularAnalytics(rango, query)
    .then((datos) => {
      guardarCacheAnalytics(clave, datos);
      return datos;
    })
    .finally(() => {
      calculosEnVuelo.delete(clave);
    });

  calculosEnVuelo.set(clave, promesa);
  return promesa;
}

// ==========================================================================
// PRECALENTAMIENTO EN SEGUNDO PLANO
// ==========================================================================
// Recalcula periódicamente la vista por defecto (7 días, sin filtros -- la
// que ve cualquiera que abra el panel por primera vez) para que casi nunca
// haya un usuario real esperando la consulta pesada en vivo. Corre una vez
// apenas arranca el proceso (con un pequeño respiro para no competir con el
// resto del arranque del backend) y luego cada PRECALENTAMIENTO_INTERVALO_MS.
const PRECALENTAMIENTO_INTERVALO_MS = 5 * 60 * 1000;
const RANGO_POR_DEFECTO = resolverRangoFechas({});
const CLAVE_CACHE_POR_DEFECTO = claveCacheAnalytics(RANGO_POR_DEFECTO, {});

function precalentarCacheAnalytics() {
  calcularYCachear(CLAVE_CACHE_POR_DEFECTO, RANGO_POR_DEFECTO, {}).catch((err) => {
    console.error('Precalentamiento de /analytics (App Móvil) falló:', err.message || err);
  });
}

setTimeout(precalentarCacheAnalytics, 5000);
setInterval(precalentarCacheAnalytics, PRECALENTAMIENTO_INTERVALO_MS);

// ==========================================================================
// ETL DE RESÚMENES DIARIOS EN BIC_CERTI_MARIA
// ==========================================================================
// El caché y el precalentamiento de arriba evitan que un USUARIO espere la
// consulta pesada, pero no cambian el costo real de esa consulta -- alguien
// (el precalentador, o un usuario con caché frío) sigue teniendo que barrer
// LogApp.Log completo tarde o temprano. Esto sí lo cambia:
//
// Las mismas consultas de resumen/por-canal/por-dispositivo/por-funcionalidad
// se pueden acotar a UN SOLO DÍA en vez de a un rango de hasta 180 -- eso
// reduce las filas que el motor tiene que tocar en la misma proporción (1
// día en vez de hasta 180), así que corren en segundos en vez de minutos.
// El resultado de cada día se guarda en BIC_CERTI_MARIA (que sí
// administramos) en 4 tablas pequeñas -- nunca se toca el esquema de LogApp
// ni se altera esa base ni sus datos.
//
// Con esos resúmenes diarios ya calculados, CUALQUIER rango que pida el
// usuario (7/30/90 días o uno personalizado) se resuelve SUMANDO filas de
// nuestras propias tablas -- milisegundos, sin tocar LogApp.Log en el
// momento de la petición. Esto solo cubre la vista SIN filtro de
// canal/dispositivo (con filtro no está pre-agregado -- cubrir todas las
// combinaciones posibles infla demasiado el número de filas para el
// beneficio que da --, así que esa vista sigue consultando LogApp.Log en
// vivo, con las mismas protecciones de siempre).
//
// LIMITACIÓN CONOCIDA Y ACEPTADA: usuariosUnicos y sesionesDistintas son
// COUNT(DISTINCT ...) -- sumar el valor ya calculado de cada día no da el
// distinto real de un rango de varios días (alguien activo en dos días
// distintos cuenta dos veces). Para un panel operativo es una aproximación
// razonable; el resto de métricas (transacciones, errores, por canal, por
// funcionalidad) SÍ son exactas al sumarse día a día. La respuesta marca
// `resumen.conteosDistintosAproximados: true` cuando el rango pedido cubre
// más de un día, para que el frontend lo indique.
//
// Las 4 tablas las crea `crear_tablas_rollup_app_movil_BIC_CERTI_MARIA.sql`
// (requiere privilegios de DBA, una sola vez -- la cuenta de la app no tiene
// CREATE TABLE). Mientras no exista, este ETL simplemente registra el error
// en el log cada ciclo y /analytics sigue funcionando como antes (en vivo
// contra LogApp) -- ver el catch de ER_NO_SUCH_TABLE en calcularAnalytics.
const TABLA_RESUMEN_DIARIO = 'AppMovilResumenDiario';
const TABLA_POR_CANAL_DIARIO = 'AppMovilPorCanalDiario';
const TABLA_POR_DISPOSITIVO_DIARIO = 'AppMovilPorDispositivoDiario';
const TABLA_POR_FUNCIONALIDAD_DIARIO = 'AppMovilPorFuncionalidadDiario';
const TABLA_LATENCIA_DIARIA = 'AppMovilLatenciaDiaria';
// Totales y errores por Documento (CC), por día -- igual que las otras
// tablas de rollup, pero con una fila por cliente en vez de un puñado de
// canales/dispositivos/funcionalidades. Se creó aparte (no en el script
// original) porque necesita su propio índice para buscar por Documento
// across muchos días, y porque crece MUCHO más rápido que el resto (un
// cliente por fila, no una categoría) -- ver purgarClientesAntiguos más
// abajo, que la mantiene acotada a ETL_DIAS_RETENCION días igual que el
// resto del panel. La crea agregar_rollup_por_cliente_app_movil.sql.
const TABLA_POR_CLIENTE_DIARIO = 'AppMovilPorClienteDiario';

// Nombre exacto de la llamada de login, para el indicador de "Tiempo de
// Login" en el panel -- si el equipo cambia el nombre del método algún día,
// solo hay que actualizar esta constante.
const CLASE_LOGIN = 'UsersService';
const METODO_LOGIN = 'login_api';

// Cuántos días hacia atrás mantiene poblados el ETL -- cubre el rango máximo
// que el panel permite pedir.
const ETL_DIAS_RETENCION = RANGO_DIAS_MAXIMO;

// Pausa entre cada día procesado durante el relleno histórico inicial --
// para no disparar decenas de consultas pesadas contra LogApp.Log una tras
// otra apenas arranca el proceso.
const ETL_PAUSA_ENTRE_DIAS_MS = 3000;

// Cada cuánto se refresca HOY/AYER y se revisa si falta algún día por
// rellenar.
const ETL_INTERVALO_MS = 5 * 60 * 1000;

function formatearFechaCorta(fecha) {
  return `${fecha.getFullYear()}-${pad2(fecha.getMonth() + 1)}-${pad2(fecha.getDate())}`;
}

function inicioDelDia(fecha) {
  const d = new Date(fecha);
  d.setHours(0, 0, 0, 0);
  return d;
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describirErrorEtl(err) {
  if (err && err.code === 'ER_NO_SUCH_TABLE') {
    return 'las tablas de rollup aún no existen en BIC_CERTI_MARIA -- ejecuta crear_tablas_rollup_app_movil_BIC_CERTI_MARIA.sql (una sola vez, con una cuenta con privilegios de CREATE TABLE)';
  }
  return (err && err.message) || String(err);
}

// ==========================================================================
// LATENCIA POR EMPAREJAMIENTO DE FILAS (arranque -> fin de la misma llamada)
// ==========================================================================
// MariaDB 5.5 no tiene funciones de ventana (LAG/ROW_NUMBER llegaron en
// 10.2), y hacer el emparejamiento con un self-join en SQL arriesgaría el
// mismo problema de fondo que todo este ETL existe para evitar. En su lugar:
// se traen SOLO columnas livianas (nada de Rq/Rs completos, que pueden pesar
// varios KB cada uno) para el día, y el emparejamiento se hace en Node.
//
// LIMITACIÓN ACEPTADA: Fecha solo tiene resolución de 1 segundo (sin
// milisegundos) -- sirve para detectar llamadas que tardan varios segundos
// (justo lo que interesa para un panel operativo), no para distinguir
// 200ms de 800ms.
async function calcularLatenciasDia(inicio, fin) {
  const poolLogApp = await getLogAppPool();
  // inicio/fin siempre acotan UN solo día calendario -- una sola tabla
  // alcanza (ver nombreTablaLogParaUnDia arriba).
  const tablaLog = nombreTablaLogParaUnDia(inicio);

  const [filas] = await consultarConTiempoMaximo(
    poolLogApp,
    `SELECT
      Sesion,
      Clase,
      Metodo,
      Fecha,
      Codigo,
      (${SQL_ES_INICIO}) AS EsInicio
    FROM LogApp.${tablaLog}
    WHERE Metodo NOT IN (${PLACEHOLDERS_METODOS_EXCLUIDOS}) AND Fecha BETWEEN ? AND ?`,
    // Sin ORDER BY a propósito -- con potencialmente millones de filas en un
    // solo día, pedirle a MariaDB que las ordene aquí es exactamente el tipo
    // de "Copying to tmp table" que causó el problema original. El orden
    // (por Sesion+Clase+Metodo+Codigo) se hace abajo en Node, donde cada
    // grupo es pequeño (un puñado de llamadas por dispositivo/método/día).
    [...METODOS_EXCLUIDOS, formatearFechaSql(inicio), formatearFechaSql(fin)],
    // Consulta de la ETL (fondo, sin nginx de por medio) -- ver
    // TIEMPO_MAXIMO_CONSULTA_ETL_MS arriba.
    TIEMPO_MAXIMO_CONSULTA_ETL_MS
  );

  // Agrupar por Sesion+Clase+Metodo (una "Sesion" es, en la práctica, el
  // dispositivo -- ver nota en clasificarDispositivo/FABRICANTES -- así que
  // esto empareja llamadas del MISMO dispositivo al MISMO método).
  const grupos = new Map();
  for (const f of filas) {
    const clave = `${f.Sesion || ''}\u0000${f.Clase}\u0000${f.Metodo}`;
    let arr = grupos.get(clave);
    if (!arr) {
      arr = [];
      grupos.set(clave, arr);
    }
    arr.push(f);
  }

  // Acumuladores por Clase+Metodo (sin Sesion -- ya cumplió su propósito de
  // agrupar cada llamada con su propio par).
  const acumuladores = new Map();
  function registrarLatencia(clase, metodo, segundos) {
    const clave = `${clase}\u0000${metodo}`;
    let acc = acumuladores.get(clave);
    if (!acc) {
      acc = { clase, metodo, llamadasMedidas: 0, sumaSegundos: 0, maxSegundos: 0 };
      acumuladores.set(clave, acc);
    }
    acc.llamadasMedidas += 1;
    acc.sumaSegundos += segundos;
    if (segundos > acc.maxSegundos) acc.maxSegundos = segundos;
  }

  for (const arr of grupos.values()) {
    arr.sort((a, b) => a.Codigo - b.Codigo);
    let inicioPendiente = null;
    for (const fila of arr) {
      if (fila.EsInicio) {
        // Un arranque sin cierre previo simplemente se descarta como
        // "pendiente" (nunca se le vio una fila de fin en la ventana del
        // día) -- no se puede medir su latencia, así que no suma nada;
        // arrancar el conteo de "Total" ya lo cubre la consulta agregada de
        // calcularYGuardarRollupDia, esta función solo mide tiempos.
        inicioPendiente = fila;
      } else if (inicioPendiente) {
        const segundos = Math.max(
          0,
          Math.round((new Date(fila.Fecha).getTime() - new Date(inicioPendiente.Fecha).getTime()) / 1000)
        );
        registrarLatencia(fila.Clase, fila.Metodo, segundos);
        inicioPendiente = null;
      }
      // Una fila de "fin" sin arranque previo (arrancó fuera de la ventana
      // del día, ej. justo antes de medianoche) se ignora para latencia --
      // no se puede saber cuánto duró sin su arranque real.
    }
  }

  return Array.from(acumuladores.values()).map((a) => ({
    clase: a.clase,
    metodo: a.metodo,
    llamadasMedidas: a.llamadasMedidas,
    tiempoPromedioSegundos: Number((a.sumaSegundos / a.llamadasMedidas).toFixed(2)),
    tiempoMaximoSegundos: a.maxSegundos
  }));
}

// Calcula y guarda el resumen de UN día calendario (local) contra
// LogApp.Log, sin ningún filtro de canal/dispositivo (ver limitación arriba
// sobre por qué el ETL solo cubre la vista general).
async function calcularYGuardarRollupDia(fechaDia) {
  const poolLogApp = await getLogAppPool();
  const poolPrincipal = await getPool();

  const inicio = inicioDelDia(fechaDia);
  const fin = new Date(inicio.getTime() + 24 * 60 * 60 * 1000 - 1000); // 23:59:59 del mismo día
  const fechaTexto = formatearFechaCorta(inicio);
  // Un solo día calendario -- una sola tabla alcanza (Log si es hoy,
  // Log_YYYYMM del mes correspondiente en cualquier otro caso).
  const tablaLog = nombreTablaLogParaUnDia(inicio);

  const whereSql = `Metodo NOT IN (${PLACEHOLDERS_METODOS_EXCLUIDOS}) AND Fecha BETWEEN ? AND ?`;
  const parametrosBase = [...METODOS_EXCLUIDOS, formatearFechaSql(inicio), formatearFechaSql(fin)];

  // SUM(CASE WHEN SQL_ES_INICIO ...) en vez de COUNT(*): cada llamada real
  // deja 2 filas (arranque + fin), así que COUNT(*) las contaría doble. Se
  // cuenta 1 por llamada usando solo la fila de arranque -- "Errores" no
  // necesita el mismo ajuste porque SQL_ES_FALLO nunca es verdadero sobre
  // una fila de arranque (su Rs todavía está vacío).
  //
  // Cada fabricante aporta DOS columnas (total + errores), cada una con su
  // propio placeholder para el patrón LIKE -- por eso los parámetros de esta
  // consulta repiten cada patrón dos veces (uno para la columna de total,
  // otro para la de errores), en el mismo orden en que aparecen abajo.
  const columnasFabricante = FABRICANTES.map(
    (f, i) => `SUM(CASE WHEN Sesion LIKE ? AND ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS f${i}_total,
        SUM(CASE WHEN Sesion LIKE ? AND ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS f${i}_errores`
  ).join(',\n        ');

  const [
    [resumenFilas],
    [porCanalCrudo],
    [dispositivoFilas],
    [porFuncionalidadCrudo],
    [porClienteCrudo],
    latenciasPorMetodo
  ] = await Promise.all([
    consultarConTiempoMaximo(
      poolLogApp,
      `SELECT
        SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total_transacciones,
        SUM(CASE WHEN ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS total_errores,
        COUNT(DISTINCT Documento) AS usuarios_unicos,
        COUNT(DISTINCT Sesion) AS sesiones_distintas
      FROM LogApp.${tablaLog}
      WHERE ${whereSql}`,
      parametrosBase,
      TIEMPO_MAXIMO_CONSULTA_ETL_MS
    ),
    consultarConTiempoMaximo(
      poolLogApp,
      `SELECT
        CanalCodigo AS canal_codigo,
        SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS errores
      FROM LogApp.${tablaLog}
      WHERE ${whereSql}
      GROUP BY CanalCodigo`,
      parametrosBase,
      TIEMPO_MAXIMO_CONSULTA_ETL_MS
    ),
    consultarConTiempoMaximo(
      poolLogApp,
      `SELECT
        ${columnasFabricante},
        SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS errores
      FROM LogApp.${tablaLog}
      WHERE ${whereSql}`,
      [...FABRICANTES.flatMap((f) => [f.patron, f.patron]), ...parametrosBase],
      TIEMPO_MAXIMO_CONSULTA_ETL_MS
    ),
    consultarConTiempoMaximo(
      poolLogApp,
      `SELECT
        Clase AS clase,
        Metodo AS metodo,
        MAX(FuncionalidadCodigo) AS funcionalidad_codigo,
        SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS errores
      FROM LogApp.${tablaLog}
      WHERE ${whereSql}
      GROUP BY Clase, Metodo`,
      parametrosBase,
      TIEMPO_MAXIMO_CONSULTA_ETL_MS
    ),
    // 5. Totales y errores por cliente (Documento), por día -- alimenta
    // AppMovilPorClienteDiario (ver comentario junto a TABLA_POR_CLIENTE_DIARIO).
    consultarConTiempoMaximo(
      poolLogApp,
      `SELECT
        Documento AS documento,
        SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS errores
      FROM LogApp.${tablaLog}
      WHERE ${whereSql}
      GROUP BY Documento`,
      parametrosBase,
      TIEMPO_MAXIMO_CONSULTA_ETL_MS
    ),
    // 6. Latencia por método (emparejando fila de arranque con fila de fin
    // de la misma llamada) -- ver calcularLatenciasDia arriba.
    calcularLatenciasDia(inicio, fin)
  ]);

  const resumen = resumenFilas[0];

  const filaDispositivos = dispositivoFilas[0];
  let sumaClasificados = 0;
  let sumaErroresClasificados = 0;
  const porDispositivo = FABRICANTES.map((f, i) => {
    const cantidad = filaDispositivos[`f${i}_total`] || 0;
    const errores = filaDispositivos[`f${i}_errores`] || 0;
    sumaClasificados += cantidad;
    sumaErroresClasificados += errores;
    return { etiqueta: f.etiqueta, total: cantidad, errores };
  }).filter((d) => d.total > 0);
  const totalGeneralDispositivos = filaDispositivos.total || 0;
  const totalErroresGeneralDispositivos = filaDispositivos.errores || 0;
  const otros = totalGeneralDispositivos - sumaClasificados;
  const erroresOtros = Math.max(0, totalErroresGeneralDispositivos - sumaErroresClasificados);
  if (otros > 0) porDispositivo.push({ etiqueta: ETIQUETA_DISPOSITIVO_OTRO, total: otros, errores: erroresOtros });

  // Persistencia en BIC_CERTI_MARIA. Por canal/dispositivo/funcionalidad se
  // borran las filas del día y se reinsertan -- más simple que un upsert por
  // cada combinación individual, y el volumen (un puñado de canales/
  // fabricantes/funcionalidades por día) lo hace igual de barato.
  await poolPrincipal.query(
    `INSERT INTO ${TABLA_RESUMEN_DIARIO}
      (Fecha, TotalTransacciones, TotalErrores, UsuariosUnicos, SesionesDistintas)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       TotalTransacciones = VALUES(TotalTransacciones),
       TotalErrores = VALUES(TotalErrores),
       UsuariosUnicos = VALUES(UsuariosUnicos),
       SesionesDistintas = VALUES(SesionesDistintas)`,
    [fechaTexto, resumen.total_transacciones || 0, resumen.total_errores || 0, resumen.usuarios_unicos || 0, resumen.sesiones_distintas || 0]
  );

  await poolPrincipal.query(`DELETE FROM ${TABLA_POR_CANAL_DIARIO} WHERE Fecha = ?`, [fechaTexto]);
  if (porCanalCrudo.length) {
    await poolPrincipal.query(
      `INSERT INTO ${TABLA_POR_CANAL_DIARIO} (Fecha, CanalCodigo, Total, Errores) VALUES ?`,
      [porCanalCrudo.map((c) => [fechaTexto, c.canal_codigo, c.total, c.errores || 0])]
    );
  }

  await poolPrincipal.query(`DELETE FROM ${TABLA_POR_DISPOSITIVO_DIARIO} WHERE Fecha = ?`, [fechaTexto]);
  if (porDispositivo.length) {
    await poolPrincipal.query(
      `INSERT INTO ${TABLA_POR_DISPOSITIVO_DIARIO} (Fecha, Dispositivo, Total, Errores) VALUES ?`,
      [porDispositivo.map((d) => [fechaTexto, d.etiqueta, d.total, d.errores || 0])]
    );
  }

  await poolPrincipal.query(`DELETE FROM ${TABLA_POR_FUNCIONALIDAD_DIARIO} WHERE Fecha = ?`, [fechaTexto]);
  if (porFuncionalidadCrudo.length) {
    await poolPrincipal.query(
      `INSERT INTO ${TABLA_POR_FUNCIONALIDAD_DIARIO} (Fecha, Clase, Metodo, FuncionalidadCodigo, Total, Errores) VALUES ?`,
      [porFuncionalidadCrudo.map((f) => [fechaTexto, f.clase, f.metodo, f.funcionalidad_codigo ?? null, f.total, f.errores || 0])]
    );
  }

  // Aislado en su propio try/catch: si AppMovilLatenciaDiaria todavía no
  // existe (por ejemplo, alguien corrió una copia vieja de
  // crear_tablas_rollup_app_movil_BIC_CERTI_MARIA.sql que no la incluía),
  // que falte SOLO esta tabla no debe tirar por la borda el resto del
  // rollup del día (resumen/canal/dispositivo/funcionalidad), que ya se
  // guardó bien arriba. Una vez se cree la tabla, HOY y AYER se recalculan
  // solos en el próximo ciclo del ETL (línea ~742) y quedan al día. Los
  // días HISTÓRICOS que ya hubieran quedado guardados en
  // AppMovilResumenDiario antes de crear esta tabla NO se reintentan solos
  // (el relleno histórico de abajo salta cualquier día que ya tenga fila en
  // AppMovilResumenDiario) -- si eso llegara a pasar, basta con borrar esas
  // filas de AppMovilResumenDiario (o simplemente esperar a que salgan de
  // la ventana de retención) para que se vuelvan a calcular completas. En
  // la práctica esto no debería pasar: crear_tablas_rollup_..._MARIA.sql
  // crea las 5 tablas juntas desde el primer despliegue.
  try {
    await poolPrincipal.query(`DELETE FROM ${TABLA_LATENCIA_DIARIA} WHERE Fecha = ?`, [fechaTexto]);
    if (latenciasPorMetodo.length) {
      await poolPrincipal.query(
        `INSERT INTO ${TABLA_LATENCIA_DIARIA} (Fecha, Clase, Metodo, LlamadasMedidas, TiempoPromedioSegundos, TiempoMaximoSegundos) VALUES ?`,
        [latenciasPorMetodo.map((l) => [fechaTexto, l.clase, l.metodo, l.llamadasMedidas, l.tiempoPromedioSegundos, l.tiempoMaximoSegundos])]
      );
    }
  } catch (err) {
    console.error(`ETL App Móvil: no se pudo guardar la latencia del ${fechaTexto} --`, describirErrorEtl(err));
  }

  // Igual de aislado que el bloque de Latencia de arriba, y por la misma
  // razón: AppMovilPorClienteDiario es una tabla nueva (no está en el script
  // original de las 4 tablas, requiere agregar_rollup_por_cliente_app_movil.sql
  // aparte) -- mientras no exista, el resto del rollup del día ya se guardó
  // bien arriba y no debe verse afectado.
  try {
    await poolPrincipal.query(`DELETE FROM ${TABLA_POR_CLIENTE_DIARIO} WHERE Fecha = ?`, [fechaTexto]);
    if (porClienteCrudo.length) {
      await poolPrincipal.query(
        `INSERT INTO ${TABLA_POR_CLIENTE_DIARIO} (Fecha, Documento, Total, Errores) VALUES ?`,
        [porClienteCrudo.map((c) => [fechaTexto, c.documento, c.total, c.errores || 0])]
      );
    }
  } catch (err) {
    console.error(`ETL App Móvil: no se pudo guardar el rollup por cliente del ${fechaTexto} --`, describirErrorEtl(err));
  }

  return fechaTexto;
}

let etlEnCurso = false;
let etlEnCursoDesde = null;

// Estado observable de la ETL (solo lectura para el tablero de monitoreo,
// GET /tablero/estado en appMovilTablero.js). Vive en memoria de ESTE proceso:
// tras un reinicio empieza vacío hasta que termina el primer ciclo.
const estadoEtl = {
  arrancado: Date.now(),
  ciclos: 0,
  ultimoInicio: null,
  ultimoFin: null,
  ultimoOk: null,
  ultimoError: null,
  ultimoErrorEn: null,
  errorEnCiclo: null,
  intervaloMin: Math.round(ETL_INTERVALO_MS / 60000)
};

function registrarErrorEtl(err) {
  const texto = String((err && err.message) || err || 'error desconocido').slice(0, 300);
  estadoEtl.errorEnCiclo = estadoEtl.errorEnCiclo || texto;
}

// Segunda red de seguridad, independiente de la de consultarConTiempoMaximo:
// si por CUALQUIER motivo no anticipado un ciclo se queda colgado (nunca
// resuelve ni rechaza), esto evita que etlEnCurso quede en true para
// siempre y mate la ETL en silencio -- justo lo que pasó en producción.
//
// Se subió de 6 a 60 minutos al pasar la ETL a TIEMPO_MAXIMO_CONSULTA_ETL_MS
// (8 min por consulta, ver más arriba): un ciclo ahora puede legítimamente
// incluir AYER (hasta 8 min si toca recalcularlo) más hasta
// ETL_MAX_DIAS_POR_CICLO días de relleno histórico (hasta 8 min cada uno) --
// el peor caso teórico ronda los 48 minutos, así que 60 deja margen sin
// dejar de detectar un cuelgue real.
const ETL_TIEMPO_MAXIMO_BLOQUEO_MS = 60 * 60 * 1000;

// Cuántos días NUEVOS (que aún no tienen fila en AppMovilResumenDiario) se
// procesan como máximo en un solo ciclo del relleno histórico. Antes no
// tenía tope -- con LogApp.Log siempre vacío para fechas pasadas (el bug de
// ruteo de tablas), cada día "fallaba" casi al instante y daba igual cuántos
// se intentaran. Ahora que cada día realmente escanea la tabla mensual
// correcta (sin índice utilizable, ver TIEMPO_MAXIMO_CONSULTA_ETL_MS), un
// ciclo sin tope podría intentar backfillear los ETL_DIAS_RETENCION (180)
// días de una sola vez y tardar horas en una sola invocación -- este tope
// deja que el relleno avance de a poco, en varios ciclos sucesivos, sin
// arriesgar una corrida colgada ni saturar la conexión a LogApp.
const ETL_MAX_DIAS_POR_CICLO = 5;

async function ejecutarCicloEtl() {
  // Evita solapar corridas si una tarda más que el intervalo (típicamente
  // solo pasa durante el relleno histórico inicial, que puede tardar varios
  // minutos la primera vez que arranca el proceso).
  if (etlEnCurso) {
    // Cerrojo trabado más tiempo del razonable -- probablemente un ciclo
    // anterior se quedó colgado (ver el comentario junto a
    // ETL_TIEMPO_MAXIMO_BLOQUEO_MS). Se libera solo y se reintenta, en vez
    // de dejar la ETL muerta en silencio para siempre.
    if (etlEnCursoDesde && (Date.now() - etlEnCursoDesde) > ETL_TIEMPO_MAXIMO_BLOQUEO_MS) {
      console.error(`ETL App Móvil: el ciclo anterior llevaba bloqueado más de ${Math.round(ETL_TIEMPO_MAXIMO_BLOQUEO_MS / 1000)}s sin terminar -- se libera el cerrojo y se reintenta.`);
    } else {
      return;
    }
  }
  etlEnCurso = true;
  etlEnCursoDesde = Date.now();
  estadoEtl.ultimoInicio = etlEnCursoDesde;
  estadoEtl.errorEnCiclo = null;

  try {
    const poolPrincipal = await getPool();
    const hoy = inicioDelDia(new Date());
    const ayer = new Date(hoy.getTime() - 24 * 60 * 60 * 1000);

    // Se revisa qué días YA tienen fila antes de decidir qué recalcular --
    // antes esta consulta solo se hacía para el relleno histórico, así que
    // AYER se recalculaba sin condición en TODOS los ciclos (cada 5 min).
    // Eso era barato cuando AYER vivía en la tabla pequeña de un solo día,
    // pero ahora que un día que no es hoy vive en la tabla del MES completo
    // (~30x más filas, sin índice utilizable), recalcular AYER a cada rato
    // es un escaneo completo de esa tabla una y otra vez para nada, una vez
    // que ya quedó bien guardado la primera vez.
    let diasExistentes;
    try {
      const [filas] = await poolPrincipal.query(
        `SELECT Fecha FROM ${TABLA_RESUMEN_DIARIO} WHERE Fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
        [ETL_DIAS_RETENCION]
      );
      diasExistentes = new Set(filas.map((f) => formatearFechaCorta(new Date(f.Fecha))));
    } catch (err) {
      console.error('ETL App Móvil: no se pudo revisar el relleno histórico --', describirErrorEtl(err));
      registrarErrorEtl(err);
      return;
    }

    // HOY siempre se recalcula (sigue acumulando datos todo el día, y vive
    // en LogApp.Log -- una tabla pequeña, así que recalcularlo seguido es
    // barato). AYER solo se recalcula si TODAVÍA no tiene fila (ej. el
    // proceso arrancó o se reinició a mitad de ese día) -- una vez que ya
    // quedó guardado correctamente, no hace falta volver a escanear la
    // tabla del mes por él en cada ciclo.
    await calcularYGuardarRollupDia(hoy).catch((err) => {
      console.error('ETL App Móvil: falló el rollup de HOY --', describirErrorEtl(err));
      registrarErrorEtl(err);
    });
    const ayerTexto = formatearFechaCorta(ayer);
    if (!diasExistentes.has(ayerTexto)) {
      await calcularYGuardarRollupDia(ayer).catch((err) => {
        console.error('ETL App Móvil: falló el rollup de AYER --', describirErrorEtl(err));
        registrarErrorEtl(err);
      });
    }

    // Relleno histórico: solo los días de la ventana de retención que aún no
    // tengan fila, empezando por los más recientes (para que los rangos
    // cortos -- 7/30 días, los más usados -- queden completos primero), y
    // como mucho ETL_MAX_DIAS_POR_CICLO días NUEVOS por ciclo (ver arriba) --
    // los que sobren quedan para el próximo ciclo (5 min después), o antes si
    // este mismo termina rápido.
    let diasProcesadosEnEsteCiclo = 0;
    for (let i = 2; i <= ETL_DIAS_RETENCION && diasProcesadosEnEsteCiclo < ETL_MAX_DIAS_POR_CICLO; i++) {
      const dia = new Date(hoy.getTime() - i * 24 * 60 * 60 * 1000);
      const fechaTexto = formatearFechaCorta(dia);
      if (diasExistentes.has(fechaTexto)) continue;

      diasProcesadosEnEsteCiclo++;
      try {
        await calcularYGuardarRollupDia(dia);
        console.log(`ETL App Móvil: día ${fechaTexto} calculado.`);
      } catch (err) {
        console.error(`ETL App Móvil: falló el rollup del ${fechaTexto} --`, describirErrorEtl(err));
        registrarErrorEtl(err);
        // Un día fallido no debe bloquear el relleno del resto.
      }
      await esperar(ETL_PAUSA_ENTRE_DIAS_MS);
    }

    // Purga de AppMovilPorClienteDiario más allá de la ventana de retención.
    // A diferencia del resto de tablas de rollup (un puñado de categorías
    // por día -- canal, dispositivo, funcionalidad -- que nunca se purgan y
    // crecen despacio), esta tiene una fila POR CLIENTE por día, así que sin
    // esto crecería sin límite. Se corre una vez por ciclo (cada 5 min); el
    // DELETE usa la columna líder de la PRIMARY KEY (Fecha, Documento), así
    // que es barato incluso si no hay nada que borrar. Aislada en su propio
    // try/catch: si la tabla todavía no existe, no debe tirar por la borda
    // el resto del ciclo (que ya corrió bien arriba).
    try {
      const [resultadoPurga] = await poolPrincipal.query(
        `DELETE FROM ${TABLA_POR_CLIENTE_DIARIO} WHERE Fecha < DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
        [ETL_DIAS_RETENCION]
      );
      if (resultadoPurga.affectedRows > 0) {
        console.log(`ETL App Móvil: purgadas ${resultadoPurga.affectedRows} fila(s) de ${TABLA_POR_CLIENTE_DIARIO} fuera de la ventana de ${ETL_DIAS_RETENCION} días.`);
      }
    } catch (err) {
      console.error('ETL App Móvil: no se pudo purgar el rollup por cliente antiguo --', describirErrorEtl(err));
      registrarErrorEtl(err);
    }
  } finally {
    etlEnCurso = false;
    etlEnCursoDesde = null;
    estadoEtl.ultimoFin = Date.now();
    estadoEtl.ciclos += 1;
    if (estadoEtl.errorEnCiclo) {
      estadoEtl.ultimoError = estadoEtl.errorEnCiclo;
      estadoEtl.ultimoErrorEn = estadoEtl.ultimoFin;
    } else {
      estadoEtl.ultimoOk = estadoEtl.ultimoFin;
      estadoEtl.ultimoError = null;
    }
  }
}

setTimeout(ejecutarCicloEtl, 8000);
setInterval(ejecutarCicloEtl, ETL_INTERVALO_MS);

// ==========================================================================
// EXPORTACIÓN A CSV
// ==========================================================================
function escaparCsv(valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  if (/["\n;,]/.test(texto)) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

function construirCsv(encabezados, filas) {
  const lineas = [encabezados.map(escaparCsv).join(',')];
  filas.forEach((fila) => lineas.push(fila.map(escaparCsv).join(',')));
  return lineas.join('\r\n');
}

// ==========================================================================
// CÁLCULO PESADO DE /analytics CONTRA LogApp.Log EN VIVO -- ahora solo se usa
// cuando hay filtro de canal o dispositivo (no cubierto por el ETL de
// arriba); la vista sin filtro se resuelve con calcularAnalyticsDesdeRollup.
// ==========================================================================
async function calcularAnalyticsDesdeLogApp(rango, query) {
  const pool = await getLogAppPool();
  const { condiciones: condicionesFiltro, parametros: parametrosFiltro } = condicionesFiltros(query);

  // LogApp NO es una sola tabla (ver nombreTablaLogParaUnDia/tablasLogParaRango
  // arriba) -- el rango pedido puede caer en 'Log' (hoy), en una o varias
  // 'Log_YYYYMM', o en una mezcla de ambas. En vez de una sola consulta contra
  // un nombre de tabla fijo, se corren las MISMAS 6 consultas (ya agregadas,
  // nunca fila cruda) UNA VEZ POR CADA TABLA involucrada, y los resultados se
  // SUMAN/COMBINAN en Node -- el mismo patrón que ya usa este archivo para
  // combinar fuentes (ej. porDispositivo, latenciaPorClaveFuncionalidad en
  // calcularAnalyticsDesdeRollup) en vez de intentar una sola consulta SQL
  // contra tablas con nombres distintos.
  const tramos = tablasLogParaRango(rango.fechaInicioTexto, rango.fechaFinTexto);

  const columnasFabricante = FABRICANTES.map(
    (f, i) => `SUM(CASE WHEN Sesion LIKE ? AND ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS f${i}`
  ).join(',\n        ');

  // Las consultas de un mismo tramo son independientes entre sí, y los
  // tramos entre ellos también -- todo se lanza en paralelo (Promise.all
  // anidado) por la misma razón de siempre: en fila, el tiempo total sería
  // la SUMA de todas las consultas (arriesgando el proxy_read_timeout de
  // nginx); en paralelo, el tiempo total es el de la más lenta.
  const resultadosPorTramo = await Promise.all(tramos.map(async ({ tabla, desde, hasta }) => {
    const whereSql = [
      `Metodo NOT IN (${PLACEHOLDERS_METODOS_EXCLUIDOS})`,
      'Fecha >= ? AND Fecha <= ?',
      ...condicionesFiltro
    ].join(' AND ');
    const parametrosBase = [...METODOS_EXCLUIDOS, `${desde} 00:00:00`, `${hasta} 23:59:59`, ...parametrosFiltro];

    const [
      [resumenFilas],
      [tendencia],
      [porCanalCrudo],
      [dispositivoFilas],
      [porFuncionalidadCrudo],
      [topErroresCrudo]
    ] = await Promise.all([
      // 1. Resumen general del tramo
      consultarConTiempoMaximo(
        pool,
        `SELECT
          SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total_transacciones,
          SUM(CASE WHEN ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS total_errores,
          COUNT(DISTINCT Documento) AS usuarios_unicos,
          COUNT(DISTINCT Sesion) AS sesiones_distintas
        FROM LogApp.${tabla}
        WHERE ${whereSql}`,
        parametrosBase
      ),
      // 2. Tendencia dia a dia (para la grafica de barras)
      //
      // DATE_FORMAT(..., '%Y-%m-%d') en vez de DATE(Fecha): mysql2 devuelve
      // una columna DATE como objeto Date de JS (no como texto), y el
      // frontend hace `new Date(p.dia + 'T00:00:00')` -- concatenar un Date
      // con un string produce "Invalid Date" (confirmado en producción, ver
      // "Transacciones y Errores por Día"). Forzar el formato acá evita esa
      // ambigüedad de una vez por todas, sin depender de cómo el driver
      // decida castear el tipo.
      consultarConTiempoMaximo(
        pool,
        `SELECT
          DATE_FORMAT(Fecha, '%Y-%m-%d') AS dia,
          SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS errores
        FROM LogApp.${tabla}
        WHERE ${whereSql}
        GROUP BY DATE_FORMAT(Fecha, '%Y-%m-%d')`,
        parametrosBase
      ),
      // 3. Por canal -- sin ORDER BY en SQL a propósito (máximo ~17 canales,
      // se ordenan en Node en vez de pedirle a MariaDB un "Copying to tmp
      // table" solo para ordenar un puñado de filas).
      consultarConTiempoMaximo(
        pool,
        `SELECT
          CanalCodigo AS canal_codigo,
          SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS errores
        FROM LogApp.${tabla}
        WHERE ${whereSql}
        GROUP BY CanalCodigo`,
        parametrosBase
      ),
      // 4. Por dispositivo/fabricante (heuristica LIKE sobre Sesion)
      consultarConTiempoMaximo(
        pool,
        `SELECT
          ${columnasFabricante},
          SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total
        FROM LogApp.${tabla}
        WHERE ${whereSql}`,
        [...FABRICANTES.map((f) => f.patron), ...parametrosBase]
      ),
      // 5. Efectividad por funcionalidad (Clase + Metodo) -- sin ORDER BY/LIMIT
      // en SQL por la misma razón que el punto 3. MAX(FuncionalidadCodigo):
      // un mismo Clase+Metodo siempre dispara el mismo código de
      // funcionalidad, así que MAX solo sirve para colapsar la columna a un
      // único valor por grupo (no es un promedio ni sugiere variación real).
      consultarConTiempoMaximo(
        pool,
        `SELECT
          Clase AS clase,
          Metodo AS metodo,
          MAX(FuncionalidadCodigo) AS funcionalidad_codigo,
          SUM(CASE WHEN ${SQL_ES_INICIO} THEN 1 ELSE 0 END) AS total,
          SUM(CASE WHEN ${SQL_ES_FALLO} THEN 1 ELSE 0 END) AS errores
        FROM LogApp.${tabla}
        WHERE ${whereSql}
        GROUP BY Clase, Metodo`,
        parametrosBase
      ),
      // 6. Top metodos con mas fallos (para la lista de "revision requerida")
      consultarConTiempoMaximo(
        pool,
        `SELECT
          Clase AS clase,
          Metodo AS metodo,
          COUNT(*) AS cantidad_fallos
        FROM LogApp.${tabla}
        WHERE ${SQL_ES_FALLO}
          AND ${whereSql}
        GROUP BY Clase, Metodo`,
        parametrosBase
      )
    ]);

    return {
      resumen: resumenFilas[0] || {},
      tendencia,
      porCanal: porCanalCrudo,
      dispositivos: dispositivoFilas[0] || {},
      porFuncionalidad: porFuncionalidadCrudo,
      topErrores: topErroresCrudo
    };
  }));

  // --- Combinar (sumar) los resultados de todos los tramos en Node ---

  const resumen = resultadosPorTramo.reduce((acc, r) => {
    acc.total_transacciones += Number(r.resumen.total_transacciones) || 0;
    acc.total_errores += Number(r.resumen.total_errores) || 0;
    // usuarios_unicos/sesiones_distintas: un COUNT(DISTINCT ...) por tramo no
    // se puede sumar sin riesgo de contar dos veces al mismo Documento/Sesion
    // si aparece en más de un tramo -- se deja como aproximación (igual que
    // ya hace calcularAnalyticsDesdeRollup para rangos de más de un día, ver
    // conteosDistintosAproximados abajo).
    acc.usuarios_unicos += Number(r.resumen.usuarios_unicos) || 0;
    acc.sesiones_distintas += Number(r.resumen.sesiones_distintas) || 0;
    return acc;
  }, { total_transacciones: 0, total_errores: 0, usuarios_unicos: 0, sesiones_distintas: 0 });

  const tendenciaPorDia = new Map();
  resultadosPorTramo.forEach((r) => {
    r.tendencia.forEach((t) => {
      const dia = String(t.dia);
      const acc = tendenciaPorDia.get(dia) || { dia, total: 0, errores: 0 };
      acc.total += Number(t.total) || 0;
      acc.errores += Number(t.errores) || 0;
      tendenciaPorDia.set(dia, acc);
    });
  });
  const tendencia = [...tendenciaPorDia.values()].sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));

  const porCanalPorCodigo = new Map();
  resultadosPorTramo.forEach((r) => {
    r.porCanal.forEach((c) => {
      const acc = porCanalPorCodigo.get(c.canal_codigo) || { canal_codigo: c.canal_codigo, total: 0, errores: 0 };
      acc.total += Number(c.total) || 0;
      acc.errores += Number(c.errores) || 0;
      porCanalPorCodigo.set(c.canal_codigo, acc);
    });
  });
  const porCanal = [...porCanalPorCodigo.values()].sort((a, b) => b.total - a.total);

  const dispositivoTotales = FABRICANTES.map(() => 0);
  let totalGeneralDispositivos = 0;
  resultadosPorTramo.forEach((r) => {
    FABRICANTES.forEach((f, i) => {
      dispositivoTotales[i] += Number(r.dispositivos[`f${i}`]) || 0;
    });
    totalGeneralDispositivos += Number(r.dispositivos.total) || 0;
  });
  let sumaClasificados = 0;
  const porDispositivo = FABRICANTES.map((f, i) => {
    sumaClasificados += dispositivoTotales[i];
    return { etiqueta: f.etiqueta, total: dispositivoTotales[i] };
  }).filter((d) => d.total > 0);
  const otrosDispositivos = totalGeneralDispositivos - sumaClasificados;
  if (otrosDispositivos > 0) porDispositivo.push({ etiqueta: ETIQUETA_DISPOSITIVO_OTRO, total: otrosDispositivos });
  porDispositivo.sort((a, b) => b.total - a.total);

  const porFuncionalidadPorClave = new Map();
  resultadosPorTramo.forEach((r) => {
    r.porFuncionalidad.forEach((f) => {
      const clave = `${f.clase}\u0000${f.metodo}`;
      const acc = porFuncionalidadPorClave.get(clave) || { clase: f.clase, metodo: f.metodo, total: 0, errores: 0, codigo: null };
      acc.total += Number(f.total) || 0;
      acc.errores += Number(f.errores) || 0;
      // Un mismo Clase+Metodo debería traer siempre el mismo código -- si
      // algún tramo no lo trajo (NULL), se conserva el que sí se encontró.
      if (acc.codigo === null && f.funcionalidad_codigo !== null && f.funcionalidad_codigo !== undefined) {
        acc.codigo = f.funcionalidad_codigo;
      }
      porFuncionalidadPorClave.set(clave, acc);
    });
  });
  const porFuncionalidad = [...porFuncionalidadPorClave.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, LIMITE_FUNCIONALIDADES_MOSTRADAS);

  const topErroresPorClave = new Map();
  resultadosPorTramo.forEach((r) => {
    r.topErrores.forEach((e) => {
      const clave = `${e.clase}\u0000${e.metodo}`;
      const acc = topErroresPorClave.get(clave) || { clase: e.clase, metodo: e.metodo, cantidad_fallos: 0 };
      acc.cantidad_fallos += Number(e.cantidad_fallos) || 0;
      topErroresPorClave.set(clave, acc);
    });
  });
  const topErrores = [...topErroresPorClave.values()]
    .sort((a, b) => b.cantidad_fallos - a.cantidad_fallos)
    .slice(0, 8);

  const totalTransacciones = resumen.total_transacciones;
  const totalErrores = resumen.total_errores;
  const tasaExito = totalTransacciones > 0
    ? Math.max(0, Number(((1 - totalErrores / totalTransacciones) * 100).toFixed(2)))
    : 100;

  return {
    dias: rango.dias,
    fechaInicio: rango.fechaInicio,
    fechaFin: rango.fechaFin,
    rangoPersonalizado: rango.rangoPersonalizado,
    filtros: {
      canal: (query.canal || '').trim() || null,
      dispositivo: (query.dispositivo || '').trim() || null,
      documento: documentoValido(query)
    },
    resumen: {
      totalTransacciones,
      totalErrores,
      usuariosUnicos: resumen.usuarios_unicos,
      sesionesDistintas: resumen.sesiones_distintas,
      tasaExito,
      // Con más de un tramo (rango que cruza tabla mensual y/o incluye hoy)
      // los DISTINCT ya no son exactos -- se suman por tramo, así que un
      // mismo Documento/Sesion activo en dos tramos se cuenta dos veces. Se
      // marca aproximado igual que en calcularAnalyticsDesdeRollup.
      conteosDistintosAproximados: tramos.length > 1,
      // La latencia (login y por servicio) solo está disponible en la vista
      // SIN filtro, calculada por el ETL (ver calcularAnalyticsDesdeRollup)
      // -- medirla en vivo aquí repetiría el mismo riesgo de rendimiento que
      // todo este archivo existe para evitar.
      tiempoPromedioLoginSegundos: null
    },
    // La comparación contra el período anterior solo está disponible en la
    // vista SIN filtro (ver el comentario junto a resumenAnterior en
    // calcularAnalyticsDesdeRollup) -- acá siempre va null.
    resumenAnterior: null,
    tendencia: tendencia.map((t) => ({
      dia: t.dia,
      total: t.total,
      errores: t.errores
    })),
    porCanal: porCanal.map((c) => ({
      canalCodigo: c.canal_codigo,
      total: c.total,
      errores: c.errores
    })),
    porDispositivo,
    porFuncionalidad: porFuncionalidad.map((f) => {
      const tasa = f.total > 0 ? Math.max(0, Number(((1 - f.errores / f.total) * 100).toFixed(2))) : 100;
      return {
        clase: f.clase,
        metodo: f.metodo,
        codigoServicio: formatearCodigoServicio(f.codigo),
        total: f.total,
        errores: f.errores,
        tasaExito: tasa,
        tiempoPromedioSegundos: null
      };
    }),
    topErrores: topErrores.map((e) => ({
      clase: e.clase,
      metodo: e.metodo,
      cantidadFallos: e.cantidad_fallos
    }))
  };
}

// ==========================================================================
// CÁLCULO RÁPIDO DE /analytics DESDE LOS RESÚMENES DIARIOS (BIC_CERTI_MARIA)
// -- usado para la vista SIN filtro de canal/dispositivo. Nunca toca
// LogApp.Log; solo suma filas ya calculadas por el ETL de arriba.
// ==========================================================================
async function calcularAnalyticsDesdeRollup(rango) {
  const poolPrincipal = await getPool();

  let fechaInicioTexto;
  let fechaFinTexto;
  if (rango.rangoPersonalizado) {
    fechaInicioTexto = rango.fechaInicio;
    fechaFinTexto = rango.fechaFin;
  } else {
    const hoy = inicioDelDia(new Date());
    const desde = new Date(hoy.getTime() - (rango.dias - 1) * 24 * 60 * 60 * 1000);
    fechaInicioTexto = formatearFechaCorta(desde);
    fechaFinTexto = formatearFechaCorta(hoy);
  }

  const [
    [resumenFilas],
    [tendenciaCrudo],
    [porCanalCrudo],
    [porDispositivoCrudo],
    [porFuncionalidadCrudo],
    [latenciaLoginFilas],
    [latenciaPorFuncionalidadCrudo]
  ] = await Promise.all([
    poolPrincipal.query(
      `SELECT
        COALESCE(SUM(TotalTransacciones), 0) AS total_transacciones,
        COALESCE(SUM(TotalErrores), 0) AS total_errores,
        COALESCE(SUM(UsuariosUnicos), 0) AS usuarios_unicos,
        COALESCE(SUM(SesionesDistintas), 0) AS sesiones_distintas
      FROM ${TABLA_RESUMEN_DIARIO}
      WHERE Fecha BETWEEN ? AND ?`,
      [fechaInicioTexto, fechaFinTexto]
    ),
    poolPrincipal.query(
      // DATE_FORMAT en vez de "Fecha AS dia" tal cual -- ver el comentario
      // igual de arriba en calcularAnalyticsDesdeLogApp: mysql2 devuelve una
      // columna DATE como objeto Date de JS, y el frontend arma
      // `new Date(p.dia + 'T00:00:00')`, que con un Date en vez de texto da
      // "Invalid Date" (visto en producción en la gráfica de tendencia).
      `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d') AS dia, TotalTransacciones AS total, TotalErrores AS errores
      FROM ${TABLA_RESUMEN_DIARIO}
      WHERE Fecha BETWEEN ? AND ?
      ORDER BY Fecha ASC`,
      [fechaInicioTexto, fechaFinTexto]
    ),
    poolPrincipal.query(
      `SELECT CanalCodigo AS canal_codigo, SUM(Total) AS total, SUM(Errores) AS errores
      FROM ${TABLA_POR_CANAL_DIARIO}
      WHERE Fecha BETWEEN ? AND ?
      GROUP BY CanalCodigo`,
      [fechaInicioTexto, fechaFinTexto]
    ),
    poolPrincipal.query(
      `SELECT Dispositivo AS dispositivo, SUM(Total) AS total
      FROM ${TABLA_POR_DISPOSITIVO_DIARIO}
      WHERE Fecha BETWEEN ? AND ?
      GROUP BY Dispositivo`,
      [fechaInicioTexto, fechaFinTexto]
    ),
    poolPrincipal.query(
      `SELECT Clase AS clase, Metodo AS metodo, MAX(FuncionalidadCodigo) AS funcionalidad_codigo,
        SUM(Total) AS total, SUM(Errores) AS errores
      FROM ${TABLA_POR_FUNCIONALIDAD_DIARIO}
      WHERE Fecha BETWEEN ? AND ?
      GROUP BY Clase, Metodo`,
      [fechaInicioTexto, fechaFinTexto]
    ),
    // Tiempo de login: promedio ponderado por cantidad de llamadas medidas
    // cada día (un día con más tráfico pesa más que uno con poco).
    poolPrincipal.query(
      `SELECT
        SUM(LlamadasMedidas) AS llamadas_medidas,
        SUM(TiempoPromedioSegundos * LlamadasMedidas) AS suma_ponderada,
        MAX(TiempoMaximoSegundos) AS maximo
      FROM ${TABLA_LATENCIA_DIARIA}
      WHERE Fecha BETWEEN ? AND ? AND Clase = ? AND Metodo = ?`,
      [fechaInicioTexto, fechaFinTexto, CLASE_LOGIN, METODO_LOGIN]
    ),
    // Tiempo de respuesta por servicio, mismo promedio ponderado, para
    // sumarlo a la tabla de "Efectividad por Funcionalidad".
    poolPrincipal.query(
      `SELECT
        Clase AS clase,
        Metodo AS metodo,
        SUM(LlamadasMedidas) AS llamadas_medidas,
        SUM(TiempoPromedioSegundos * LlamadasMedidas) AS suma_ponderada
      FROM ${TABLA_LATENCIA_DIARIA}
      WHERE Fecha BETWEEN ? AND ?
      GROUP BY Clase, Metodo`,
      [fechaInicioTexto, fechaFinTexto]
    )
  ]);

  const resumen = resumenFilas[0] || {};
  const totalTransacciones = Number(resumen.total_transacciones) || 0;
  const totalErrores = Number(resumen.total_errores) || 0;
  const tasaExito = totalTransacciones > 0
    ? Math.max(0, Number(((1 - totalErrores / totalTransacciones) * 100).toFixed(2)))
    : 100;

  const porCanal = porCanalCrudo
    .map((c) => ({ canalCodigo: c.canal_codigo, total: Number(c.total) || 0, errores: Number(c.errores) || 0 }))
    .sort((a, b) => b.total - a.total);

  const porDispositivo = porDispositivoCrudo
    .map((d) => ({ etiqueta: d.dispositivo, total: Number(d.total) || 0 }))
    .sort((a, b) => b.total - a.total);

  // Mapa clase.metodo -> tiempo promedio de respuesta, para sumarlo a
  // "Efectividad por Funcionalidad" (ver calcularLatenciasDia -- solo cubre
  // la vista sin filtro, igual que el resto del rollup).
  const latenciaPorClaveFuncionalidad = new Map();
  latenciaPorFuncionalidadCrudo.forEach((l) => {
    const llamadas = Number(l.llamadas_medidas) || 0;
    if (llamadas <= 0) return;
    latenciaPorClaveFuncionalidad.set(
      `${l.clase}\u0000${l.metodo}`,
      Number((Number(l.suma_ponderada) / llamadas).toFixed(2))
    );
  });

  const porFuncionalidad = porFuncionalidadCrudo
    .map((f) => {
      const total = Number(f.total) || 0;
      const errores = Number(f.errores) || 0;
      const tasa = total > 0 ? Math.max(0, Number(((1 - errores / total) * 100).toFixed(2))) : 100;
      const tiempoPromedioSegundos = latenciaPorClaveFuncionalidad.get(`${f.clase}\u0000${f.metodo}`) ?? null;
      return {
        clase: f.clase,
        metodo: f.metodo,
        codigoServicio: formatearCodigoServicio(f.funcionalidad_codigo),
        total,
        errores,
        tasaExito: tasa,
        tiempoPromedioSegundos
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, LIMITE_FUNCIONALIDADES_MOSTRADAS);

  const latenciaLoginFila = latenciaLoginFilas[0] || {};
  const llamadasLoginMedidas = Number(latenciaLoginFila.llamadas_medidas) || 0;
  const tiempoPromedioLoginSegundos = llamadasLoginMedidas > 0
    ? Number((Number(latenciaLoginFila.suma_ponderada) / llamadasLoginMedidas).toFixed(2))
    : null;

  const topErrores = porFuncionalidadCrudo
    .map((f) => ({ clase: f.clase, metodo: f.metodo, cantidadFallos: Number(f.errores) || 0 }))
    .filter((e) => e.cantidadFallos > 0)
    .sort((a, b) => b.cantidadFallos - a.cantidadFallos)
    .slice(0, 8);

  // Más de un día en el rango -> usuariosUnicos/sesionesDistintas quedan
  // marcados como aproximados (ver la nota grande junto al ETL, arriba).
  const diasEnRango = Math.max(
    1,
    Math.round(
      (new Date(`${fechaFinTexto}T00:00:00`) - new Date(`${fechaInicioTexto}T00:00:00`)) / (24 * 60 * 60 * 1000)
    ) + 1
  );

  // ==========================================================================
  // COMPARACIÓN CONTRA EL PERÍODO ANTERIOR (mismo número de días,
  // inmediatamente antes del rango pedido) -- solo se calcula acá (vista SIN
  // filtro) porque AppMovilResumenDiario es una tabla pequeña ya agregada;
  // repetir esto contra LogApp.Log en vivo (calcularAnalyticsDesdeLogApp)
  // duplicaría el costo de una consulta ya de por sí pesada contra una tabla
  // sin índices propios, así que esa vista simplemente no ofrece esta
  // comparación (ver resumenAnterior: null allá).
  // ==========================================================================
  const finAnterior = new Date(`${fechaInicioTexto}T00:00:00`);
  finAnterior.setDate(finAnterior.getDate() - 1);
  const inicioAnterior = new Date(finAnterior);
  inicioAnterior.setDate(inicioAnterior.getDate() - (diasEnRango - 1));
  const fechaInicioAnteriorTexto = formatearFechaCorta(inicioAnterior);
  const fechaFinAnteriorTexto = formatearFechaCorta(finAnterior);

  const [resumenAnteriorFilas] = await poolPrincipal.query(
    `SELECT
      COALESCE(SUM(TotalTransacciones), 0) AS total_transacciones,
      COALESCE(SUM(TotalErrores), 0) AS total_errores
    FROM ${TABLA_RESUMEN_DIARIO}
    WHERE Fecha BETWEEN ? AND ?`,
    [fechaInicioAnteriorTexto, fechaFinAnteriorTexto]
  );
  const resumenAnteriorFila = resumenAnteriorFilas[0] || {};
  const totalTransaccionesAnterior = Number(resumenAnteriorFila.total_transacciones) || 0;
  const totalErroresAnterior = Number(resumenAnteriorFila.total_errores) || 0;
  const tasaExitoAnterior = totalTransaccionesAnterior > 0
    ? Math.max(0, Number(((1 - totalErroresAnterior / totalTransaccionesAnterior) * 100).toFixed(2)))
    : null;

  return {
    dias: rango.dias,
    fechaInicio: rango.fechaInicio,
    fechaFin: rango.fechaFin,
    rangoPersonalizado: rango.rangoPersonalizado,
    filtros: { canal: null, dispositivo: null, documento: null },
    resumen: {
      totalTransacciones,
      totalErrores,
      usuariosUnicos: Number(resumen.usuarios_unicos) || 0,
      sesionesDistintas: Number(resumen.sesiones_distintas) || 0,
      tasaExito,
      conteosDistintosAproximados: diasEnRango > 1,
      // Promedio ponderado de cuánto tarda UsersService.login_api en
      // responder (arranque -> fin de la misma llamada, ver
      // calcularLatenciasDia). null cuando el ETL todavía no ha medido
      // ninguna llamada de login en el rango pedido (recién desplegado, o
      // sin tráfico de login ese día).
      tiempoPromedioLoginSegundos
    },
    // Mismo número de días, inmediatamente antes del rango actual -- null
    // significa "sin datos históricos suficientes para comparar" (ej. app
    // recién desplegada), no un error.
    resumenAnterior: {
      totalTransacciones: totalTransaccionesAnterior,
      totalErrores: totalErroresAnterior,
      tasaExito: tasaExitoAnterior,
      fechaInicio: fechaInicioAnteriorTexto,
      fechaFin: fechaFinAnteriorTexto
    },
    tendencia: tendenciaCrudo.map((t) => ({
      dia: t.dia,
      total: Number(t.total) || 0,
      errores: Number(t.errores) || 0
    })),
    porCanal,
    porDispositivo,
    porFuncionalidad,
    topErrores
  };
}

// ==========================================================================
// DESPACHADOR DE /analytics -- sin filtro usa los resúmenes diarios (rápido);
// con filtro de canal/dispositivo usa LogApp.Log en vivo (no está
// pre-agregado). Si las tablas de rollup todavía no existen (falta correr
// crear_tablas_rollup_app_movil_BIC_CERTI_MARIA.sql), cae a LogApp.Log en
// vivo también para la vista sin filtro, para que el panel nunca se rompa
// por esto -- simplemente no se acelera hasta que se cree la tabla.
// ==========================================================================
async function calcularAnalytics(rango, query) {
  const { condiciones: condicionesFiltro } = condicionesFiltros(query);
  if (condicionesFiltro.length > 0) {
    return calcularAnalyticsDesdeLogApp(rango, query);
  }

  try {
    return await calcularAnalyticsDesdeRollup(rango);
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') {
      console.error('/analytics (App Móvil):', describirErrorEtl(err));
      return calcularAnalyticsDesdeLogApp(rango, query);
    }
    throw err;
  }
}

// ==========================================================================
// GET /api/app-movil/analytics?dias=7
// GET /api/app-movil/analytics?fechaInicio=2026-01-01&fechaFin=2026-01-31
// (+ opcional: canal=<CanalCodigo>, dispositivo=<etiqueta de fabricante>)
// ==========================================================================
router.get('/analytics', verifyToken, requireModule('APP_MOVIL'), async (req, res) => {
  try {
    const rango = resolverRangoFechas(req.query);
    const clave = claveCacheAnalytics(rango, req.query);
    const estado = leerEstadoCacheAnalytics(clave);

    if (estado.servible) {
      // Hay algo para servir YA -- si ya venció el TTL "fresco", se dispara
      // un recálculo de fondo (sin bloquear esta respuesta) para la próxima
      // vez, pero el usuario actual nunca espera la consulta pesada.
      if (!estado.fresco) calcularYCachear(clave, rango, req.query);
      return res.json({ ...estado.datos, desactualizado: !estado.fresco });
    }

    // Caché realmente frío (nunca calculado, o ya pasó el margen de gracia)
    // -- acá sí hay que esperar el cálculo. calcularYCachear deduplica si
    // ya hay otra petición idéntica en curso.
    const datos = await calcularYCachear(clave, rango, req.query);
    res.json({ ...datos, desactualizado: false });
  } catch (err) {
    if (esErrorPorTiempoMaximo(err)) {
      console.error('Consulta de /analytics (App Móvil) excedió el tiempo máximo permitido:', err.message);
      return res.status(504).json({
        error: `La consulta tardó demasiado (más de ${TIEMPO_MAXIMO_CONSULTA_SEGUNDOS}s) y se canceló. Intenta con un rango de fechas más corto o vuelve a intentar en unos minutos.`
      });
    }
    console.error('Error leyendo LogApp.Log (analytics):', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ==========================================================================
// Consulta de errores contra LogApp para un rango que puede caer en varias
// tablas (ver tablasLogParaRango) -- usada por /errores-detalle y su
// exportación, que comparten exactamente el mismo criterio salvo cuántas
// filas necesitan al final. SQL no puede hacer el ORDER BY/LIMIT/OFFSET final
// por sí solo cuando las filas vienen de tablas con nombres dinámicos, así
// que cada tabla trae sus propias `limiteFilasPorTabla` filas ya ordenadas
// (lo máximo que ese tramo podría necesitar aportar) y el orden final /
// recorte a la página o el tope de exportación se hace en Node, fusionando
// los tramos -- mismo patrón que calcularAnalyticsDesdeLogApp usa para las
// métricas agregadas, aplicado acá a una lista de filas.
async function consultarErroresLogApp(pool, rango, condicionesExtra, parametrosExtra, limiteFilasPorTabla) {
  const tramos = tablasLogParaRango(rango.fechaInicioTexto, rango.fechaFinTexto);

  const resultadosPorTramo = await Promise.all(tramos.map(async ({ tabla, desde, hasta }) => {
    const condiciones = [
      SQL_ES_FALLO,
      `Metodo NOT IN (${PLACEHOLDERS_METODOS_EXCLUIDOS})`,
      'Fecha >= ? AND Fecha <= ?',
      ...condicionesExtra
    ];
    const parametros = [...METODOS_EXCLUIDOS, `${desde} 00:00:00`, `${hasta} 23:59:59`, ...parametrosExtra];
    const whereSql = condiciones.join(' AND ');

    const [[totalFilas], [filas]] = await Promise.all([
      consultarConTiempoMaximo(
        pool,
        `SELECT COUNT(*) AS total FROM LogApp.${tabla} WHERE ${whereSql}`,
        parametros
      ),
      consultarConTiempoMaximo(
        pool,
        `SELECT Documento, Fecha, Clase, Metodo, CanalCodigo, Ip, Rs, Adicional, Sesion
         FROM LogApp.${tabla}
         WHERE ${whereSql}
         ORDER BY Fecha DESC
         LIMIT ?`,
        [...parametros, limiteFilasPorTabla]
      )
    ]);
    return { total: Number(totalFilas[0].total) || 0, filas };
  }));

  const total = resultadosPorTramo.reduce((suma, r) => suma + r.total, 0);
  const filas = resultadosPorTramo
    .flatMap((r) => r.filas)
    .sort((a, b) => new Date(b.Fecha).getTime() - new Date(a.Fecha).getTime());

  return { total, filas };
}

// ==========================================================================
// GET /api/app-movil/errores-detalle?dias=7&metodo=&clase=&canal=&dispositivo=&limit=&offset=
// ==========================================================================
// Detalle de errores individuales, para investigar un metodo puntual desde
// el "Top Metodos con Errores". El documento del cliente se enmascara y
// NUNCA se devuelve el cuerpo crudo de Rq/Rs (puede traer saldos, cuentas u
// otros datos de la transaccion) -- solo un resumen corto del error.
// ==========================================================================
router.get('/errores-detalle', verifyToken, requireModule('APP_MOVIL'), async (req, res) => {
  try {
    const pool = await getLogAppPool();
    const rango = resolverRangoFechas(req.query);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { condiciones: condicionesFiltro, parametros: parametrosFiltro } = condicionesFiltros(req.query);
    const condicionesExtra = [...condicionesFiltro];
    const parametrosExtra = [...parametrosFiltro];

    if (req.query.metodo) {
      condicionesExtra.push('Metodo = ?');
      parametrosExtra.push(req.query.metodo);
    }
    if (req.query.clase) {
      condicionesExtra.push('Clase = ?');
      parametrosExtra.push(req.query.clase);
    }

    // Cada tabla involucrada solo necesita traer, como mucho, offset+limit
    // filas (ya ordenadas) para poder armar la página pedida tras fusionar en
    // Node -- nunca hace falta traer más que eso de ninguna tabla individual.
    const { total, filas: filasCombinadas } = await consultarErroresLogApp(
      pool, rango, condicionesExtra, parametrosExtra, offset + limit
    );
    const filas = filasCombinadas.slice(offset, offset + limit);

    res.json({
      total,
      limit,
      offset,
      errores: filas.map(mapearErrorFila)
    });
  } catch (err) {
    if (esErrorPorTiempoMaximo(err)) {
      console.error('Consulta de /errores-detalle (App Móvil) excedió el tiempo máximo permitido:', err.message);
      return res.status(504).json({
        error: `La consulta tardó demasiado (más de ${TIEMPO_MAXIMO_CONSULTA_SEGUNDOS}s) y se canceló. Intenta con un rango de fechas más corto.`
      });
    }
    console.error('Error leyendo LogApp.Log (errores-detalle):', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ==========================================================================
// GET /api/app-movil/errores-detalle/exportar?dias=7&metodo=&clase=&canal=&dispositivo=
// ==========================================================================
// Mismos filtros que /errores-detalle, pero sin paginar -- devuelve un CSV
// listo para descargar. Se acota a LIMITE_EXPORTACION filas (no toda la
// tabla) para no arriesgar la memoria del backend ni una consulta eterna
// contra una tabla de este tamaño; si el resultado real es más grande, el
// CSV viene con las más recientes y un encabezado avisando que se recortó.
// ==========================================================================
const LIMITE_EXPORTACION = 5000;

router.get('/errores-detalle/exportar', verifyToken, requireModule('APP_MOVIL'), async (req, res) => {
  try {
    const pool = await getLogAppPool();
    const rango = resolverRangoFechas(req.query);

    const { condiciones: condicionesFiltro, parametros: parametrosFiltro } = condicionesFiltros(req.query);
    const condicionesExtra = [...condicionesFiltro];
    const parametrosExtra = [...parametrosFiltro];

    if (req.query.metodo) {
      condicionesExtra.push('Metodo = ?');
      parametrosExtra.push(req.query.metodo);
    }
    if (req.query.clase) {
      condicionesExtra.push('Clase = ?');
      parametrosExtra.push(req.query.clase);
    }

    const { filas: filasCombinadas } = await consultarErroresLogApp(
      pool, rango, condicionesExtra, parametrosExtra, LIMITE_EXPORTACION + 1
    );
    const filas = filasCombinadas.slice(0, LIMITE_EXPORTACION + 1);

    const truncado = filas.length > LIMITE_EXPORTACION;
    const errores = (truncado ? filas.slice(0, LIMITE_EXPORTACION) : filas).map(mapearErrorFila);

    const encabezados = ['Fecha', 'Clase', 'Metodo', 'Documento', 'CanalCodigo', 'Dispositivo', 'IP', 'Mensaje'];
    const filasCsv = errores.map((e) => [
      e.fecha ? new Date(e.fecha).toISOString() : '',
      e.clase,
      e.metodo,
      e.documento,
      e.canalCodigo,
      e.dispositivo,
      e.ip || '',
      e.mensaje
    ]);

    const csv = construirCsv(encabezados, filasCsv);
    const nombreArchivo = `errores_app_movil_${new Date().toISOString().slice(0, 10)}.csv`;

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    res.set('X-Exportacion-Truncada', truncado ? 'true' : 'false');
    res.set('X-Exportacion-Total-Filas', String(errores.length));
    // BOM al inicio para que Excel detecte UTF-8 y no arruine tildes/eñes.
    res.send(`﻿${csv}`);
  } catch (err) {
    if (esErrorPorTiempoMaximo(err)) {
      console.error('Exportación de /errores-detalle (App Móvil) excedió el tiempo máximo permitido:', err.message);
      return res.status(504).json({
        error: `La exportación tardó demasiado (más de ${TIEMPO_MAXIMO_CONSULTA_SEGUNDOS}s) y se canceló. Intenta con un rango de fechas más corto.`
      });
    }
    console.error('Error exportando errores de App Móvil:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ==========================================================================
// VISOR DE LOGS INTERACTIVO -- búsqueda libre sobre LogApp.Log/Log_YYYYMM
// ==========================================================================
// A diferencia de condicionesFiltros (fija: canal/dispositivo/documento, para
// /analytics), esta acepta cualquier combinación de filtros que la persona
// quiera ir agregando en el visor -- equivalente a la consulta manual que
// hoy se arma a mano en DBeaver, pero con botones en vez de editar SQL:
//
//   SELECT ... FROM LogApp.Log WHERE Documento = ? AND FuncionalidadCodigo = ?
//   AND Metodo NOT IN (...) ORDER BY Fecha DESC
//
// Cada filtro es opcional e independiente -- se combinan todos los que
// vengan con AND, igual que agregar líneas al WHERE de la consulta original.
function condicionesLogs(query) {
  const condiciones = [];
  const parametros = [];

  const documento = documentoValido(query);
  if (documento) {
    condiciones.push('Documento = ?');
    parametros.push(documento);
  }

  const metodo = (query.metodo || '').trim();
  if (metodo) {
    condiciones.push('Metodo = ?');
    parametros.push(metodo);
  }

  const clase = (query.clase || '').trim();
  if (clase) {
    condiciones.push('Clase = ?');
    parametros.push(clase);
  }

  const funcionalidad = (query.funcionalidad || '').trim();
  if (funcionalidad !== '' && !Number.isNaN(Number(funcionalidad))) {
    condiciones.push('FuncionalidadCodigo = ?');
    parametros.push(Number(funcionalidad));
  }

  // Nodo (106..109): el sufijo de Ip es "-<n>:<x>" con n = nodo - 100.
  const nodoTexto = String(query.nodo || '').trim();
  if (/^\d{1,3}$/.test(nodoTexto)) {
    const n = Number(nodoTexto) >= 100 ? Number(nodoTexto) - 100 : Number(nodoTexto);
    condiciones.push('Ip LIKE ?');
    parametros.push(`%-${n}:%`);
  }

  const canalTexto = (query.canal || '').trim();
  if (canalTexto !== '' && !Number.isNaN(Number(canalTexto))) {
    condiciones.push('CanalCodigo = ?');
    parametros.push(Number(canalTexto));
  }

  const tipo = (query.tipo || '').trim();
  if (tipo !== '' && !Number.isNaN(Number(tipo))) {
    condiciones.push('TipoCodigo = ?');
    parametros.push(Number(tipo));
  }

  const proceso = (query.proceso || '').trim();
  if (proceso !== '' && !Number.isNaN(Number(proceso))) {
    condiciones.push('ProcesoCodigo = ?');
    parametros.push(Number(proceso));
  }

  // Búsqueda libre -- cubre "buscar un servicio" sin que la persona tenga
  // que saber el nombre técnico exacto del método.
  const texto = (query.texto || '').trim().slice(0, 100);
  if (texto) {
    const patron = `%${texto}%`;
    condiciones.push('(Metodo LIKE ? OR Clase LIKE ? OR Descripcion LIKE ?)');
    parametros.push(patron, patron, patron);
  }

  if (query.soloErrores === 'true' || query.soloErrores === '1') {
    // Además de respuestas con error, incluye los errores que registra la propia
    // app como fila aparte ("Error Service", "Error Controller", "ERROR-API-...").
    condiciones.push(`(${SQL_ES_FALLO} OR Descripcion LIKE 'Error %' OR Descripcion LIKE 'ERROR-API-%')`);
  }

  // Igual que en /errores-detalle: por defecto se excluye el logout (no es
  // un fallo real ni algo relevante para soporte), con opción de incluirlo
  // explícitamente si hace falta.
  if (query.incluirLogout !== 'true' && query.incluirLogout !== '1') {
    condiciones.push(`Metodo NOT IN (${PLACEHOLDERS_METODOS_EXCLUIDOS})`);
    parametros.push(...METODOS_EXCLUIDOS);
  }

  return { condiciones, parametros };
}

// Igual patrón que consultarErroresLogApp (arriba): cada tabla involucrada
// (ver tablasLogParaRango) aporta como mucho `limiteFilasPorTabla` filas ya
// ordenadas, y el orden/paginación final se hace en Node fusionando los
// tramos -- SQL no puede hacer ORDER BY/LIMIT entre tablas con nombres
// dinámicos por sí solo. De Rs/Adicional se trae solo lo necesario para
// calcular el estado de cada fila (comienzo y final); el contenido completo
// de una fila (Rq, Rs y Datos, traducido) se pide aparte con /logs/detalle.
async function buscarLogsLogApp(pool, rango, condicionesExtra, parametrosExtra, limiteFilasPorTabla) {
  const tramos = tablasLogParaRango(rango.fechaInicioTexto, rango.fechaFinTexto);

  const resultadosPorTramo = await Promise.all(tramos.map(async ({ tabla, desde, hasta }) => {
    const condiciones = ['Fecha >= ? AND Fecha <= ?', ...condicionesExtra];
    const parametros = [`${desde} 00:00:00`, `${hasta} 23:59:59`, ...parametrosExtra];
    const whereSql = condiciones.join(' AND ');

    const [[totalFilas], [filas]] = await Promise.all([
      consultarConTiempoMaximo(
        pool,
        `SELECT COUNT(*) AS total FROM LogApp.${tabla} WHERE ${whereSql}`,
        parametros
      ),
      consultarConTiempoMaximo(
        pool,
        `SELECT Codigo, Documento, Fecha, DATE_FORMAT(Fecha, '%Y-%m-%d %H:%i:%s') AS FechaTxt, Metodo, Descripcion,
                LEFT(Rs, 1800) AS Rs,
                IF(CHAR_LENGTH(Rs) > 1800, SUBSTRING(Rs, -500), NULL) AS RsFin,
                LEFT(Adicional, 600) AS Adicional, CanalCodigo,
                FuncionalidadCodigo, TipoCodigo, ProcesoCodigo, Clase, Transaccion, Ip, LEFT(Sesion, 1500) AS Sesion
         FROM LogApp.${tabla}
         WHERE ${whereSql}
         ORDER BY Fecha DESC
         LIMIT ?`,
        [...parametros, limiteFilasPorTabla]
      )
    ]);
    return { total: Number(totalFilas[0].total) || 0, filas };
  }));

  const total = resultadosPorTramo.reduce((suma, r) => suma + r.total, 0);
  const filas = resultadosPorTramo
    .flatMap((r) => r.filas)
    .sort((a, b) => new Date(b.Fecha).getTime() - new Date(a.Fecha).getTime());

  return { total, filas };
}

// ==========================================================================
// GET /api/app-movil/logs/catalogo
// ==========================================================================
// Lista de servicios conocidos (para el desplegable/autocompletar del
// visor) -- se expone desde el mismo diccionario que traduce los nombres en
// los resultados, para que nunca queden desincronizados entre sí.
// ==========================================================================
router.get('/logs/catalogo', verifyToken, requireModule('APP_MOVIL'), (req, res) => {
  res.json({
    servicios: Object.entries(SERVICIOS_LEGIBLES)
      .map(([metodo, etiqueta]) => ({ metodo, etiqueta }))
      .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es')),
    metodosExcluidosPorDefecto: METODOS_EXCLUIDOS
  });
});

// ==========================================================================
// GET /api/app-movil/logs?documento=&metodo=&clase=&funcionalidad=&canal=&tipo=&proceso=&texto=&soloErrores=&incluirLogout=&dias=&fechaInicio=&fechaFin=&limit=&offset=
// ==========================================================================
// Visor interactivo de logs para personal no técnico: busca en LogApp.Log y
// las tablas mensuales correspondientes con cualquier combinación de los
// filtros de arriba, y devuelve filas ya traducidas (ver mapearLogFila). El
// contenido de cada fila (Rq, Rs, Datos) se consulta con /logs/detalle.
// ==========================================================================
router.get('/logs', verifyToken, requireModule('APP_MOVIL'), async (req, res) => {
  try {
    const pool = await getLogAppPool();
    const rango = resolverRangoFechas(req.query);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { condiciones, parametros } = condicionesLogs(req.query);

    const { total, filas: filasCombinadas } = await buscarLogsLogApp(
      pool, rango, condiciones, parametros, offset + limit
    );
    const filas = filasCombinadas.slice(offset, offset + limit);

    res.json({
      total,
      limit,
      offset,
      dias: rango.dias,
      fechaInicio: rango.fechaInicio,
      fechaFin: rango.fechaFin,
      rangoPersonalizado: rango.rangoPersonalizado,
      resultados: filas.map(mapearLogFila)
    });
  } catch (err) {
    if (esErrorPorTiempoMaximo(err)) {
      console.error('Consulta de /logs (App Móvil) excedió el tiempo máximo permitido:', err.message);
      return res.status(504).json({
        error: `La consulta tardó demasiado (más de ${TIEMPO_MAXIMO_CONSULTA_SEGUNDOS}s) y se canceló. Intenta con un rango de fechas más corto o filtros más específicos.`
      });
    }
    console.error('Error leyendo LogApp (visor de logs):', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ==========================================================================
// GET /api/app-movil/logs/versiones?documento=&...mismos filtros que /logs...
// ==========================================================================
// Línea de tiempo de la VERSIÓN DE LA APP que usó el cliente en toda la
// consulta (no solo en la página que se ve): agrupa por el texto de Sesion
// (que es donde viaja el dato) para no traer miles de filas, y deja ver de un
// vistazo la versión actual, desde cuándo, y si el cliente actualizó (o usó
// varias versiones a la vez, p. ej. dos equipos). Solo con documento: sin
// cliente la pregunta "qué versión usa" no tiene sentido.
// ==========================================================================
router.get('/logs/versiones', verifyToken, requireModule('APP_MOVIL'), async (req, res) => {
  try {
    if (!documentoValido(req.query)) return res.json({ disponible: false, motivo: 'sin_documento' });
    const pool = await getLogAppPool();
    const rango = resolverRangoFechas(req.query);
    // Solo cliente + rango de fechas: otros filtros (solo errores, un servicio…) sesgarían la versión.
    const { condiciones, parametros } = condicionesLogs({ documento: req.query.documento });
    const tramos = tablasLogParaRango(rango.fechaInicioTexto, rango.fechaFinTexto);

    const porTramo = await Promise.all(tramos.map(async ({ tabla, desde, hasta }) => {
      const where = ['Fecha >= ? AND Fecha <= ?', ...condiciones].join(' AND ');
      const [filas] = await consultarConTiempoMaximo(
        pool,
        `SELECT LEFT(Sesion, 1500) AS Sesion,
                DATE_FORMAT(MIN(Fecha), '%Y-%m-%d %H:%i:%s') AS Desde,
                DATE_FORMAT(MAX(Fecha), '%Y-%m-%d %H:%i:%s') AS Hasta,
                COUNT(*) AS N
         FROM LogApp.${tabla}
         WHERE ${where}
         GROUP BY LEFT(Sesion, 1500)
         ORDER BY MAX(Fecha) DESC
         LIMIT 300`,
        [`${desde} 00:00:00`, `${hasta} 23:59:59`, ...parametros]
      );
      return filas;
    }));

    const grupos = porTramo.flat().map((g) => ({ sesion: g.Sesion || '', desde: g.Desde, hasta: g.Hasta, n: Number(g.N) || 0 }));
    const resumen = resumirVersiones(grupos, clasificarDispositivo);
    res.json({
      disponible: true,
      fechaInicio: rango.fechaInicio,
      fechaFin: rango.fechaFin,
      totalRegistros: grupos.reduce((a, g) => a + g.n, 0),
      ...resumen
    });
  } catch (err) {
    if (esErrorPorTiempoMaximo(err)) {
      return res.status(504).json({ error: 'La consulta de versiones tardó demasiado y se canceló.' });
    }
    console.error('Error calculando versiones de la app (visor de logs):', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ==========================================================================
// GET /api/app-movil/logs/detalle?codigo=<Codigo>&fecha=YYYY-MM-DD
// ==========================================================================
// Detalle de UNA fila del log, pensado para personas no técnicas: lo que la
// app pidió (RQ), lo que respondió el servicio (RS) y los datos adicionales,
// traducidos a campos con nombre en español (ver utils/appMovilLenguaje.js),
// más el texto original completo y las filas cercanas del mismo servicio.
// NO se oculta información. Se audita quién consulta (dato personal).
// ==========================================================================
async function leerFilaPorCodigo(pool, tablas, codigo) {
  for (const tabla of tablas) {
    try {
      const [filas] = await consultarConTiempoMaximo(
        pool,
        `SELECT Codigo, Documento, DATE_FORMAT(Fecha, '%Y-%m-%d %H:%i:%s') AS FechaTxt, Metodo, Descripcion,
                LEFT(Rq, 200000) AS Rq, LEFT(Rs, 200000) AS Rs, LEFT(Adicional, 200000) AS Adicional,
                CanalCodigo, FuncionalidadCodigo, TipoCodigo, ProcesoCodigo, Clase, Transaccion, Ip, LEFT(Sesion, 4000) AS Sesion
         FROM LogApp.${tabla}
         WHERE Codigo = ?
         LIMIT 1`,
        [codigo]
      );
      if (filas.length) return { fila: filas[0], tabla };
    } catch (err) {
      // Un mes sin tabla no es un error para el usuario: se prueba la siguiente.
      if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146)) continue;
      throw err;
    }
  }
  return null;
}

router.get('/logs/detalle', verifyToken, requireModule('APP_MOVIL'), async (req, res) => {
  try {
    const codigo = parseInt(req.query.codigo, 10);
    const fechaTxt = String(req.query.fecha || '').slice(0, 10);
    if (!Number.isFinite(codigo) || codigo <= 0) return res.status(400).json({ error: 'Falta el código del registro.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaTxt)) return res.status(400).json({ error: 'Falta la fecha del registro (AAAA-MM-DD).' });

    const pool = await getLogAppPool();
    const fechaDia = new Date(`${fechaTxt}T00:00:00`);
    const tablas = nombreTablaLogParaUnDia(fechaDia) === 'Log' ? ['Log'] : [nombreTablaLogParaUnDia(fechaDia), 'Log'];
    const hallado = await leerFilaPorCodigo(pool, tablas, codigo);
    if (!hallado) return res.status(404).json({ error: 'No se encontró ese registro (puede haber sido archivado).' });
    const f = hallado.fila;

    // Filas cercanas del mismo servicio y cliente (±90 s): dan el contexto
    // "inicio -> llamada -> respuesta" sin tener que adivinar.
    let relacionadas = [];
    try {
      const t = traza.parseNaive(f.FechaTxt);
      if (Number.isFinite(t) && f.Documento && f.Metodo) {
        const desde = traza.formatearNaive(t - 90 * 1000).replace('T', ' ');
        const hasta = traza.formatearNaive(t + 90 * 1000).replace('T', ' ');
        const [cerca] = await consultarConTiempoMaximo(
          pool,
          `SELECT Codigo, DATE_FORMAT(Fecha, '%Y-%m-%d %H:%i:%s') AS FechaTxt, TipoCodigo, Metodo, Descripcion,
                  LEFT(Rs, 1800) AS Rs, IF(CHAR_LENGTH(Rs) > 1800, SUBSTRING(Rs, -500), NULL) AS RsFin,
                  LEFT(Adicional, 300) AS Adicional
           FROM LogApp.${hallado.tabla}
           WHERE Documento = ? AND Fecha >= ? AND Fecha <= ? AND Metodo = ?
           ORDER BY Codigo ASC
           LIMIT 40`,
          [f.Documento, desde, hasta, f.Metodo]
        );
        relacionadas = cerca.map((r) => {
          const c = lenguaje.clasificarFilaLog(r);
          return {
            codigo: r.Codigo,
            fechaTxt: r.FechaTxt,
            hora: String(r.FechaTxt).slice(11),
            descripcion: r.Descripcion || null,
            tipoTexto: c.tipoTexto,
            estado: c.estado,
            estadoTexto: c.estadoTexto,
            actual: Number(r.Codigo) === Number(f.Codigo)
          };
        });
      }
    } catch (err) {
      console.error('No se pudieron leer las filas cercanas del detalle de log:', err.message);
    }

    const traduccion = lenguaje.traducirFila(f);
    const sesion = f.Sesion ? lenguaje.traducirSeccion('datos', f.Sesion, f) : null;

    Promise.resolve()
      .then(async () => {
        const poolPrincipal = await getPool();
        await registrarEventoGeneral(poolPrincipal, req, {
          modulo: 'APP_MOVIL',
          entidad: 'Detalle de log',
          entidadNombre: `Registro ${codigo}`,
          accion: 'CONSULTA',
          detalle: `Detalle del registro ${codigo} (${f.Metodo || 'sin método'}) del cliente ${enmascararDocumento(f.Documento)}`
        });
      })
      .catch((e) => console.error('No se pudo auditar la consulta de detalle de log:', e.message));

    res.json({
      codigo: f.Codigo,
      fechaTxt: f.FechaTxt,
      documento: f.Documento == null ? null : String(f.Documento),
      servicio: nombreServicioLegible(f.Metodo),
      metodo: f.Metodo,
      clase: f.Clase,
      descripcion: f.Descripcion || null,
      canalCodigo: f.CanalCodigo,
      funcionalidadCodigo: f.FuncionalidadCodigo,
      tipoCodigo: f.TipoCodigo,
      procesoCodigo: f.ProcesoCodigo,
      transaccion: f.Transaccion || null,
      ip: extraerIp(f.Ip),
      nodo: extraerNodo(f.Ip),
      dispositivo: clasificarDispositivo(f.Sesion),
      equipo: describirEquipo(f.Sesion),
      version: (extraerVersionApp(f.Sesion, f.Adicional, f.Rq) || {}).version || null,
      sesion,
      traduccion,
      relacionadas,
      original: {
        rq: f.Rq || '',
        rs: f.Rs || '',
        adicional: f.Adicional || '',
        sesion: f.Sesion || ''
      }
    });
  } catch (err) {
    if (esErrorPorTiempoMaximo(err)) {
      return res.status(504).json({ error: 'La consulta del detalle tardó demasiado y se canceló. Intenta de nuevo.' });
    }
    console.error('Error leyendo el detalle de un log de App Móvil:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ==========================================================================
// GET /api/app-movil/logs/exportar?...mismos filtros que /logs...
// ==========================================================================
const LIMITE_EXPORTACION_LOGS = 5000;

router.get('/logs/exportar', verifyToken, requireModule('APP_MOVIL'), async (req, res) => {
  try {
    const pool = await getLogAppPool();
    const rango = resolverRangoFechas(req.query);
    const { condiciones, parametros } = condicionesLogs(req.query);

    const { filas: filasCombinadas } = await buscarLogsLogApp(
      pool, rango, condiciones, parametros, LIMITE_EXPORTACION_LOGS + 1
    );
    const filas = filasCombinadas.slice(0, LIMITE_EXPORTACION_LOGS + 1);
    const truncado = filas.length > LIMITE_EXPORTACION_LOGS;
    const resultados = (truncado ? filas.slice(0, LIMITE_EXPORTACION_LOGS) : filas).map(mapearLogFila);

    const etiquetaEstado = { exito: 'Exitosa', error: 'Con error', aviso: 'Con aviso', inicio: 'Inicio de operación', paso: 'Paso interno', info: 'Informativo' };
    const encabezados = ['Fecha', 'Estado', 'Tipo de registro', 'Servicio', 'Clase', 'Metodo', 'Descripcion', 'Documento', 'CanalCodigo', 'Funcionalidad', 'Dispositivo', 'Versión app', 'IP', 'Nodo', 'Detalle'];
    const filasCsv = resultados.map((r) => [
      r.fechaTxt || (r.fecha ? new Date(r.fecha).toISOString() : ''),
      etiquetaEstado[r.estado] || r.estado,
      r.tipoTexto || '',
      r.servicio,
      r.clase,
      r.metodo,
      r.descripcion || '',
      r.documento,
      r.canalCodigo,
      r.funcionalidadCodigo,
      r.equipo || r.dispositivo,
      r.version || '',
      r.ip || '',
      r.nodo || '',
      r.estadoTexto
    ]);

    const csv = construirCsv(encabezados, filasCsv);
    const nombreArchivo = `logs_app_movil_${new Date().toISOString().slice(0, 10)}.csv`;

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    res.set('X-Exportacion-Truncada', truncado ? 'true' : 'false');
    res.set('X-Exportacion-Total-Filas', String(resultados.length));
    // BOM al inicio para que Excel detecte UTF-8 y no arruine tildes/eñes.
    res.send(`﻿${csv}`);
  } catch (err) {
    if (esErrorPorTiempoMaximo(err)) {
      console.error('Exportación de /logs (App Móvil) excedió el tiempo máximo permitido:', err.message);
      return res.status(504).json({
        error: `La exportación tardó demasiado (más de ${TIEMPO_MAXIMO_CONSULTA_SEGUNDOS}s) y se canceló. Intenta con un rango de fechas más corto o filtros más específicos.`
      });
    }
    console.error('Error exportando logs de App Móvil:', err);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ==========================================================================
// DIAGRAMAS DE FLUJO (recorrido de un cliente y mapa global) -- ver
// appMovilFlujo.js. Reutiliza los helpers de arriba (protección de LogApp,
// detección de fallos, enmascarado de documento) para que se comporten igual
// que el resto del panel.
// ==========================================================================
const ayudasFlujo = registrarRutasFlujo(router, {
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
  extraerNodo,
  metodosExcluidos: METODOS_EXCLUIDOS,
  registrarEventoGeneral
});

// Análisis (carga de productos, operaciones, versiones, latencia, códigos y errores masivos):
// comparten el control de carga sobre LogApp del diagrama de flujo (ayudasFlujo).
registrarRutasAnalisis(router, {
  verifyToken,
  requireModule,
  getLogAppPool,
  getPool,
  consultarConTiempoMaximo,
  esErrorPorTiempoMaximo,
  nombreServicioLegible,
  documentoValido,
  enmascararDocumento,
  extraerNodo,
  registrarEventoGeneral,
  metodosExcluidos: METODOS_EXCLUIDOS
}, ayudasFlujo);

// Tablero de monitoreo: lee solo las tablas del ETL (no toca LogApp).
registrarRutasTablero(router, {
  verifyToken,
  requireModule,
  getPool,
  resolverRango: resolverRangoFechas,
  estadoEtl: () => ({ ...estadoEtl, enCurso: etlEnCurso, enCursoDesde: etlEnCursoDesde }),
  nombreServicioLegible
});

// Lo usa el módulo de informes (utils/informes/builders/appmovil.js).
router.nombreServicioLegible = nombreServicioLegible;

// Resumen cacheado para el asistente (chat): no consulta LogApp, solo lee el cache ya calculado.
router.resumenParaAsistente = async () => {
  const rango = resolverRangoFechas({});
  const estado = leerEstadoCacheAnalytics(claveCacheAnalytics(rango, {}));
  return estado.servible ? estado.datos : null;
};

module.exports = router;
