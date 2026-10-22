// Cliente de "Modelos generales" -- el servidor Open WebUI de la red interna
// (por defecto http://192.168.125.130:3000) que expone varios modelos de
// lenguaje de propósito general, aparte del Ollama local que usa el
// "Asistente AXIS" con los datos del inventario.
//
// Configuración (variables de entorno del backend; NUNCA van en el código):
//   OPENWEBUI_URL        URL base del servidor (opcional; por defecto la de arriba).
//   OPENWEBUI_API_KEY    Clave de API de Open WebUI (Ajustes > Cuenta > Claves de API).
//                        Es la opción recomendada: no requiere guardar una contraseña.
//   OPENWEBUI_USER       Usuario (alternativa a la clave de API).
//   OPENWEBUI_PASSWORD   Contraseña de ese usuario.
//   OPENWEBUI_AUTH       'auto' (por defecto) | 'ldap' | 'local'. Con 'auto', si el usuario
//                        parece un correo se prueba el login local y si no el de LDAP, y
//                        si el primero falla se prueba el otro. Open WebUI usa el correo
//                        para el login local y el usuario de dominio para LDAP.
//   OPENWEBUI_TIMEOUT_MS Tiempo máximo de espera de una respuesta (por defecto 300000).
//
// Solo se hacen lecturas y envío de mensajes: no se crean ni borran chats,
// modelos ni usuarios en Open WebUI.

const URL_BASE = (process.env.OPENWEBUI_URL || 'http://192.168.125.130:3000').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.OPENWEBUI_TIMEOUT_MS) || 300000;
const TIMEOUT_LISTA_MS = 20000;

// El token de sesión se guarda en memoria y se renueva solo si el servidor
// responde 401/403 (vencido o sesión cerrada del otro lado).
let tokenSesion = null;
let loginEnCurso = null;

function configurado() {
  return Boolean(process.env.OPENWEBUI_API_KEY || (process.env.OPENWEBUI_USER && process.env.OPENWEBUI_PASSWORD));
}

class ErrorOpenWebUi extends Error {
  constructor(mensaje, { status = 502, configuracion = false } = {}) {
    super(mensaje);
    this.status = status;
    this.configuracion = configuracion;
  }
}

async function pedirJson(ruta, { method = 'GET', cuerpo, token, timeout = TIMEOUT_LISTA_MS } = {}) {
  const headers = { Accept: 'application/json' };
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let resp;
  try {
    resp = await fetch(`${URL_BASE}${ruta}`, {
      method,
      headers,
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const porTiempo = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ErrorOpenWebUi(
      porTiempo
        ? 'El servidor de modelos generales tardó demasiado en responder. Intenta con una pregunta más corta o con otro modelo.'
        : 'No se pudo conectar con el servidor de modelos generales. Revisa que esté encendido y accesible desde el backend.',
      { status: 504 }
    );
  }

  let datos = null;
  const texto = await resp.text();
  try { datos = texto ? JSON.parse(texto) : null; } catch (e) { datos = null; }
  return { ok: resp.ok, status: resp.status, datos, texto };
}

async function iniciarSesion() {
  if (process.env.OPENWEBUI_API_KEY) return process.env.OPENWEBUI_API_KEY;

  const usuario = process.env.OPENWEBUI_USER;
  const clave = process.env.OPENWEBUI_PASSWORD;
  if (!usuario || !clave) {
    throw new ErrorOpenWebUi(
      'Falta configurar el acceso a los modelos generales: define OPENWEBUI_API_KEY (o OPENWEBUI_USER y OPENWEBUI_PASSWORD) en las variables de entorno del backend.',
      { status: 500, configuracion: true }
    );
  }

  const modo = (process.env.OPENWEBUI_AUTH || 'auto').toLowerCase();
  const intentos = [];
  if (modo === 'ldap') intentos.push('ldap');
  else if (modo === 'local') intentos.push('local');
  else intentos.push(...(usuario.includes('@') ? ['local', 'ldap'] : ['ldap', 'local']));

  let ultimo = null;
  for (const intento of intentos) {
    const r = intento === 'ldap'
      ? await pedirJson('/api/v1/auths/ldap', { method: 'POST', cuerpo: { user: usuario, password: clave } })
      : await pedirJson('/api/v1/auths/signin', { method: 'POST', cuerpo: { email: usuario, password: clave } });
    if (r.ok && r.datos && r.datos.token) return r.datos.token;
    ultimo = r;
  }

  const rechazo = ultimo && [400, 401, 403].includes(ultimo.status);
  throw new ErrorOpenWebUi(
    rechazo
      ? 'El servidor de modelos generales rechazó las credenciales configuradas (OPENWEBUI_USER / OPENWEBUI_PASSWORD). Si el usuario es de dominio prueba OPENWEBUI_AUTH=ldap; si es una cuenta local usa su correo.'
      : 'No se pudo iniciar sesión en el servidor de modelos generales.',
    { status: rechazo ? 502 : (ultimo ? 502 : 504), configuracion: rechazo }
  );
}

async function obtenerToken(forzar = false) {
  if (!forzar && tokenSesion) return tokenSesion;
  // Varias peticiones simultáneas comparten un solo login.
  if (!loginEnCurso) {
    loginEnCurso = iniciarSesion()
      .then((t) => { tokenSesion = t; return t; })
      .finally(() => { loginEnCurso = null; });
  }
  return loginEnCurso;
}

// Llama a Open WebUI autenticado; si responde 401/403 renueva la sesión y
// repite UNA vez.
async function llamar(ruta, opciones = {}) {
  let token = await obtenerToken();
  let r = await pedirJson(ruta, { ...opciones, token });
  if ((r.status === 401 || r.status === 403) && !process.env.OPENWEBUI_API_KEY) {
    token = await obtenerToken(true);
    r = await pedirJson(ruta, { ...opciones, token });
  }
  if (r.status === 401 || r.status === 403) {
    throw new ErrorOpenWebUi('El servidor de modelos generales rechazó la sesión configurada.', { status: 502, configuracion: true });
  }
  return r;
}

// Lista de modelos disponibles: [{ id, nombre }]
async function listarModelos() {
  let r = await llamar('/api/models');
  let lista = [];
  if (r.ok && r.datos) {
    const crudos = Array.isArray(r.datos) ? r.datos : (r.datos.data || r.datos.models || []);
    lista = crudos
      .filter((m) => m && (m.id || m.name) && !(m.info && m.info.meta && m.info.meta.hidden))
      .map((m) => ({ id: m.id || m.name, nombre: m.name || m.id }));
  }
  if (lista.length === 0) {
    // Respaldo: lo que expone Ollama detrás de Open WebUI.
    r = await llamar('/ollama/api/tags');
    if (r.ok && r.datos && Array.isArray(r.datos.models)) {
      lista = r.datos.models.map((m) => ({ id: m.name || m.model, nombre: m.name || m.model }));
    }
  }
  if (lista.length === 0 && !r.ok) {
    throw new ErrorOpenWebUi('No se pudo obtener la lista de modelos del servidor de modelos generales.', { status: 502 });
  }
  return lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

// Envía una conversación al modelo y devuelve el texto de la respuesta.
async function conversar(modelo, mensajes) {
  const cuerpo = { model: modelo, messages: mensajes, stream: false };
  let r = await llamar('/api/chat/completions', { method: 'POST', cuerpo, timeout: TIMEOUT_MS });
  if (r.status === 404 || r.status === 405) {
    r = await llamar('/ollama/v1/chat/completions', { method: 'POST', cuerpo, timeout: TIMEOUT_MS });
  }
  if (!r.ok) {
    const detalle = r.datos && (r.datos.detail || (r.datos.error && (r.datos.error.message || r.datos.error))) || '';
    throw new ErrorOpenWebUi(
      `El modelo no pudo responder${detalle ? `: ${typeof detalle === 'string' ? detalle : 'error del servidor'}` : '.'}`.slice(0, 300),
      { status: 502 }
    );
  }
  const texto = r.datos && r.datos.choices && r.datos.choices[0] && r.datos.choices[0].message
    ? r.datos.choices[0].message.content
    : null;
  if (!texto || !String(texto).trim()) {
    throw new ErrorOpenWebUi('El modelo respondió vacío. Prueba de nuevo o elige otro modelo.', { status: 502 });
  }
  return String(texto).trim();
}

module.exports = { URL_BASE, configurado, listarModelos, conversar, ErrorOpenWebUi };
