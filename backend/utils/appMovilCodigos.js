// ============================================================================
// Diccionario de códigos de respuesta (App Móvil / ACE) -> lenguaje claro
// ============================================================================
// REGLA: cada entrada de este diccionario salió de respuestas reales de los
// logs (campo `fuente`) o de estándares (HTTP). Un código que no está aquí se
// muestra TAL CUAL, marcado "sin traducción", jamás con un significado
// inventado. La descripción que devuelve el propio banco (StatusDesc) siempre
// se muestra junto a la traducción.
//
// Estructura de una respuesta ACE (SOAP):
//   <Status>  StatusCode  ServerStatusCode  Severity  StatusDesc
//     <AdditionalStatus> ... mismo formato, con el detalle específico
// ============================================================================

const CATEGORIAS = {
  ok: 'Correcto',
  sin_datos: 'Sin datos',
  timeout: 'Tiempo agotado',
  error: 'Error',
  info: 'Informativo',
  desconocido: 'Sin traducción'
};

// StatusCode (primer nivel de ACE)
const ACE_STATUS = {
  '0': { categoria: 'ok', significado: 'Transacción exitosa en el bus de integración (ACE).', fuente: 'Observado en logs con severidad Info y descripción "Transacción Exitosa".' },
  '100': { categoria: 'error', significado: 'Error de negocio devuelto por ACE. La causa concreta la dan el ServerStatusCode y la descripción del banco que acompañan al código.', fuente: 'Observado en logs con severidad Error ("Error en la Transacción" / "No se encontraron datos…").' },
  '1': { categoria: 'info', significado: 'Código informativo dentro de una respuesta exitosa (severidad Info). No indica falla.', fuente: 'Observado en bloques adicionales con severidad Info (p. ej. setScoreApp: 0, 1, 0).' },
  '9': { categoria: 'info', significado: 'Código informativo dentro de una respuesta exitosa (severidad Info). No indica falla.', fuente: 'Observado en bloques adicionales con severidad Info.' }
};

// ServerStatusCode (código del sistema core detrás de ACE)
const ACE_SERVER = {
  '000': { categoria: 'ok', significado: 'Operación realizada con éxito en el sistema core.', fuente: 'Observado junto a "Operación Realizada con éxito".' },
  '0': { categoria: 'ok', significado: 'Operación realizada con éxito en el sistema core.', fuente: 'Observado junto a respuestas exitosas.' },
  '00': { categoria: 'ok', significado: 'Operación realizada con éxito en el sistema core.', fuente: 'Variante de formato de 0/000.' },
  '01': { categoria: 'ok', significado: 'Respuesta exitosa del sistema core (variante de formato).', fuente: 'Observado en respuestas con StatusCode 0 y "Transacción Exitosa".' },
  '200': { categoria: 'ok', significado: 'Consulta exitosa en el sistema core.', fuente: 'Observado junto a "Consulta Exitosa" y "Transacción exitosa".' },
  'OK000': { categoria: 'ok', significado: 'Transacción exitosa en el sistema de tarjetas.', fuente: 'Observado junto a "TRANSACCION EXITOSA" (servicios de tarjeta).' },
  '210': { categoria: 'error', significado: 'Cabecera de error de la transacción ("Error en la Transacción"). El detalle específico viene en el estado adicional (p. ej. no hay datos).', fuente: 'Observado en el Status principal con "Error en la Transacción" seguido de un AdditionalStatus.' },
  '100': { categoria: 'sin_datos', significado: 'No se encontraron datos para los criterios de selección (el cliente no tiene ese producto/registro).', fuente: 'Observado con la descripción del banco "No se encontraron datos para los criterios de selección".' }
};

// Variantes de HTTP (estándar). Solo se listan las que la app maneja.
const HTTP = {
  200: { categoria: 'ok', significado: 'Respuesta correcta.' },
  201: { categoria: 'ok', significado: 'Recurso creado correctamente.' },
  204: { categoria: 'ok', significado: 'Correcto, sin contenido.' },
  400: { categoria: 'error', significado: 'Solicitud inválida: el servicio rechazó los datos enviados por la app.' },
  401: { categoria: 'error', significado: 'No autorizado: token o sesión del cliente vencido o inválido.' },
  403: { categoria: 'error', significado: 'Acceso denegado al recurso.' },
  404: { categoria: 'error', significado: 'Recurso no encontrado.' },
  408: { categoria: 'timeout', significado: 'Tiempo de espera agotado.' },
  429: { categoria: 'error', significado: 'Demasiadas solicitudes en poco tiempo.' },
  500: { categoria: 'error', significado: 'Error interno del servicio.' },
  502: { categoria: 'error', significado: 'Puerta de enlace recibió una respuesta inválida del servicio.' },
  503: { categoria: 'error', significado: 'Servicio no disponible.' },
  504: { categoria: 'timeout', significado: 'La puerta de enlace no recibió respuesta a tiempo (Gateway Timeout).' }
};

function tradHttp(n) {
  const e = HTTP[n];
  if (e) return { codigo: String(n), tipo: 'HTTP', categoria: e.categoria, significado: e.significado, fuente: 'Estándar HTTP.' };
  if (n >= 500 && n < 600) return { codigo: String(n), tipo: 'HTTP', categoria: 'error', significado: 'Error interno del servicio (5xx).', fuente: 'Estándar HTTP.' };
  if (n >= 400 && n < 500) return { codigo: String(n), tipo: 'HTTP', categoria: 'error', significado: 'Solicitud rechazada por el servicio (4xx).', fuente: 'Estándar HTTP.' };
  if (n >= 200 && n < 300) return { codigo: String(n), tipo: 'HTTP', categoria: 'ok', significado: 'Respuesta correcta (2xx).', fuente: 'Estándar HTTP.' };
  return null;
}

/** Traduce un código suelto. tipo: 'http' | 'ace' | 'aceServer'. */
function traducirCodigo(tipo, valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const v = String(valor).trim();
  if (tipo === 'http') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? tradHttp(n) : null;
  }
  const tabla = tipo === 'ace' ? ACE_STATUS : ACE_SERVER;
  const etiqueta = tipo === 'ace' ? 'ACE StatusCode' : 'ACE ServerStatusCode';
  const e = tabla[v] || tabla[v.toUpperCase()];
  if (e) return { codigo: v, tipo: etiqueta, categoria: e.categoria, significado: e.significado, fuente: e.fuente };
  return { codigo: v, tipo: etiqueta, categoria: 'desconocido', significado: 'Código sin traducción en el diccionario: se muestra tal cual lo devolvió el sistema (usar la descripción del banco como referencia).', fuente: null };
}

// ------------------------------------------------------------ fallas de transporte
/**
 * Lee una falla SOAP (faultstring/faultactor/detail) y dice DÓNDE se agotó el
 * tiempo, sin suponer más de lo que el texto dice.
 */
function leerFallaSoap(rs) {
  const t = String(rs || '');
  const fault = /<(?:\w+:)?faultstring>([^<]*)</i.exec(t);
  if (!fault) return null;
  const actor = (/<(?:\w+:)?faultactor>([^<]*)</i.exec(t) || [])[1] || null;
  const detalle = (/<(?:\w+:)?detail>([\s\S]*?)<\/(?:\w+:)?detail>/i.exec(t) || [])[1];
  const detalleTxt = detalle ? detalle.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
  const nodo = detalleTxt && (/Integration node\s+(\S+)/i.exec(detalleTxt) || /Broker\s+(\S+)/i.exec(detalleTxt));
  const seg = detalleTxt && /\((\d+)\s*seconds?\)/i.exec(detalleTxt);
  let fase = null;
  if (detalleTxt) {
    if (/reached the main flow, but timed out during processing/i.test(detalleTxt)) fase = 'dentro_flujo';
    else if (/timed out before it reached the main flow/i.test(detalleTxt)) fase = 'antes_flujo';
  }
  const servicioActor = actor ? actor.replace(/^https?:\/\/[^/]+/i, '') : null;
  return {
    mensaje: fault[1].trim(),
    actor,
    servicioActor,
    detalle: detalleTxt,
    nodoIntegracion: nodo ? nodo[1] : null,
    segundosLimite: seg ? parseInt(seg[1], 10) : null,
    fase,
    esTimeout: /timeout|timed out/i.test(`${fault[1]} ${detalleTxt || ''}`)
  };
}

const TEXTO_FASE = {
  dentro_flujo: 'El mensaje llegó al flujo principal de ACE y se agotó el tiempo MIENTRAS lo procesaba (la espera estuvo en el procesamiento o en el sistema que ACE consulta detrás).',
  antes_flujo: 'El mensaje NO llegó a entrar al flujo principal de ACE: se agotó el tiempo antes (cola/saturación del nodo de integración o de la entrada del servicio).'
};

// Mensajes que muestra la app al cliente / excepciones del backend de la app.
const MENSAJES_APP = [
  { re: /Estamos teniendo problemas conect[aá]ndonos con el Banco/i, categoria: 'timeout', significado: 'Mensaje que vio el cliente en la app: el backend no obtuvo respuesta del banco a tiempo.' },
  { re: /GatewayTimeoutException/i, categoria: 'timeout', significado: 'Excepción del backend de la app: la puerta de enlace no recibió respuesta a tiempo.' },
  { re: /A timeout occurred during processing/i, categoria: 'timeout', significado: 'Falla SOAP de ACE: "se agotó el tiempo durante el procesamiento".' },
  { re: /Error:\s*undefined\s*--\s*STACK:\s*undefined/i, categoria: 'error', significado: 'El backend registró una excepción sin mensaje ni traza (error no controlado). No trae causa en el log.' }
];

function traducirMensajeApp(texto) {
  const t = String(texto || '');
  for (const m of MENSAJES_APP) if (m.re.test(t)) return { categoria: m.categoria, significado: m.significado };
  return null;
}

/** Códigos de un ítem de la traza (soap/api/error) ya traducidos. */
function traducirItem(item) {
  const salida = [];
  const x = item && item.codigos;
  if (x) {
    for (const b of x.bloques || []) {
      const a = traducirCodigo('ace', b.codigo);
      const s = traducirCodigo('aceServer', b.serverCodigo);
      if (a || s) salida.push({ nivel: b.adicional ? 'detalle' : 'principal', severidad: b.severidad || null, descripcionBanco: b.desc || null, ace: a, servidor: s });
    }
  }
  if (item && item.codigo !== null && item.codigo !== undefined && item.tipo === 'api') {
    const h = traducirCodigo('http', item.codigo);
    if (h) salida.push({ nivel: 'principal', severidad: null, descripcionBanco: item.codigos && item.codigos.desc ? item.codigos.desc : null, http: h });
  }
  return salida;
}

/** Catálogo completo para mostrar el "diccionario" en pantalla. */
function diccionario() {
  const lista = [];
  for (const [k, v] of Object.entries(ACE_STATUS)) lista.push({ tipo: 'ACE StatusCode', codigo: k, ...v });
  for (const [k, v] of Object.entries(ACE_SERVER)) lista.push({ tipo: 'ACE ServerStatusCode', codigo: k, ...v });
  for (const k of Object.keys(HTTP)) lista.push({ tipo: 'HTTP', codigo: k, ...HTTP[k], fuente: 'Estándar HTTP.' });
  for (const m of MENSAJES_APP) lista.push({ tipo: 'Mensaje', codigo: m.re.source.replace(/\\/g, '').slice(0, 60), categoria: m.categoria, significado: m.significado, fuente: 'Observado en logs.' });
  lista.push({ tipo: 'Falla SOAP', codigo: 'timeout · dentro del flujo', categoria: 'timeout', significado: TEXTO_FASE.dentro_flujo, fuente: 'Observado: "The message reached the main flow, but timed out during processing".' });
  lista.push({ tipo: 'Falla SOAP', codigo: 'timeout · antes del flujo', categoria: 'timeout', significado: TEXTO_FASE.antes_flujo, fuente: 'Observado: "The message timed out before it reached the main flow".' });
  return lista;
}

module.exports = { CATEGORIAS, traducirCodigo, traducirItem, traducirMensajeApp, leerFallaSoap, TEXTO_FASE, diccionario };
