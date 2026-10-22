// «Consultar biometría» de clientes: se ejecuta un curl por cédula en el servidor de biometría
// (por SSH, una sola conexión por lote) contra su servicio ConsultarBiometria y se devuelve la respuesta a la pantalla.
//
//   ssh <usuario>@<servidor>   →   curl --location 'https://<servidor>:8080/api/Biometria/ConsultarBiometria?tipoDocumento=1&numeroDocumento=123'
//
// TODO ESTÁ PREDEFINIDO EN EL CÓDIGO: servidor 10.240.1.116, puerto SSH 22, puerto del servicio 8080, usuario SSH
// y la clave (archivo biometriaClave.js, excluido de git). Nadie escribe nada en la pantalla.
// La clave nunca vuelve al navegador ni va a la auditoría ni a los logs.
// Variable opcional (no es una credencial): BIOMETRIA_API_URL para cambiar la URL del servicio.
//
// Seguridad: el comando lo arma el backend con datos validados (solo dígitos/letras), nunca texto libre;
// la huella del servidor SSH se recuerda la primera vez y se rechaza si cambia (hasta reiniciar el backend o
// volver a escribir las credenciales).

const { Client } = require('ssh2');
const { cifrar, descifrar } = require('./catalogoOrigenes');

// Valores fijos del servidor de biometría (editables por la persona en su sesión). La clave va aparte, en biometriaClave.js.
// ignorarCertificado = true equivale al `curl -k` que se usa a mano contra ese servicio (certificado interno).
const PREDEFINIDOS = Object.freeze({ servidor: '10.240.1.116', puerto: 22, puertoApi: 8080, usuario: 'root', ignorarCertificado: true });
let CLAVE_PREDEFINIDA = '';
try { CLAVE_PREDEFINIDA = String(require('./biometriaClave').clave || ''); } catch { /* sin archivo: la clave se pide por sesión */ }
const RE_HOST = /^[A-Za-z0-9_.\-]{1,200}$/;
const RE_USUARIO = /^[A-Za-z0-9_.\-@\\]{1,64}$/;
const RE_TIPO_DOC = /^\d{1,3}$/;
const RE_NUM_DOC = /^[A-Za-z0-9]{3,25}$/;
const RE_URL = /^https?:\/\/[A-Za-z0-9_.\-]{1,200}(:\d{1,5})?(\/[A-Za-z0-9_.\-]{1,100}){0,6}$/;
const MAX_SALIDA = 1024 * 1024;
const MAX_ERROR = 20 * 1024;

const sesiones = new Map();   // usuario -> { campos: { ..., claveCifrada }, expira }
const huellas = new Map();    // "host:puerto" -> sha256 de la llave del servidor (primera vez que se vio)
const enCurso = new Set();    // usuarios con una consulta en ejecución

function horasSesion() {
  const h = parseFloat(process.env.BIOMETRIA_SESION_HORAS || '8');
  return Math.min(Math.max(Number.isFinite(h) ? h : 8, 0.25), 72);
}

function sesionDe(usuario) {
  if (!usuario) return null;
  const s = sesiones.get(usuario);
  if (!s) return null;
  if (Date.now() > s.expira) { sesiones.delete(usuario); return null; }
  return s;
}

setInterval(() => { for (const u of [...sesiones.keys()]) sesionDe(u); }, 5 * 60 * 1000).unref();

const entero = (v, def) => (v === undefined || v === null || String(v).trim() === '' ? def : parseInt(v, 10));

// Devuelve { valor } o { error }. `tieneClave`: ya hay una clave en la sesión (se conserva si no se envía otra).
function validarServidor(entrada, tieneClave) {
  const e = entrada || {};
  const v = {};
  v.servidor = String(e.servidor ?? '').trim() || PREDEFINIDOS.servidor;
  if (!RE_HOST.test(v.servidor)) return { error: 'El servidor solo puede tener letras, números, punto y guion.' };
  v.puerto = entero(e.puerto, PREDEFINIDOS.puerto);
  if (!Number.isInteger(v.puerto) || v.puerto < 1 || v.puerto > 65535) return { error: 'El puerto SSH debe estar entre 1 y 65535.' };
  v.puertoApi = entero(e.puertoApi, PREDEFINIDOS.puertoApi);
  if (!Number.isInteger(v.puertoApi) || v.puertoApi < 1 || v.puertoApi > 65535) return { error: 'El puerto del servicio debe estar entre 1 y 65535.' };
  v.usuario = String(e.usuario ?? '').trim() || PREDEFINIDOS.usuario;
  if (!RE_USUARIO.test(v.usuario)) return { error: 'El usuario tiene caracteres no válidos.' };
  const clave = e.clave === undefined || e.clave === null ? '' : String(e.clave);
  if (clave !== '') {
    if (clave.length > 256) return { error: 'La clave es demasiado larga.' };
    v.clave = clave;
  } else if (!tieneClave) {
    return { error: 'La clave es obligatoria.' };
  }
  v.ignorarCertificado = e.ignorarCertificado === undefined || e.ignorarCertificado === null ? PREDEFINIDOS.ignorarCertificado : !!e.ignorarCertificado;
  return { valor: v };
}

function definirSesion(usuario, valor) {
  if (!usuario) throw new Error('No se pudo identificar tu sesión.');
  const previa = sesionDe(usuario);
  const claveEnClaro = valor.clave !== undefined ? valor.clave : (previa?.campos.claveCifrada ? descifrar(previa.campos.claveCifrada) || '' : '');
  sesiones.set(usuario, {
    campos: {
      servidor: valor.servidor, puerto: valor.puerto, puertoApi: valor.puertoApi, usuario: valor.usuario,
      ignorarCertificado: !!valor.ignorarCertificado, claveCifrada: cifrar(String(claveEnClaro)),
    },
    expira: Date.now() + horasSesion() * 3600 * 1000,
  });
  huellas.delete(`${valor.servidor}:${valor.puerto}`); // credenciales nuevas = se vuelve a confiar en la llave del servidor
}

function quitarSesion(usuario) {
  return sesiones.delete(usuario);
}

// Campos efectivos de TU sesión (con la clave en claro: SOLO para uso interno del backend).
function camposEfectivos(usuario) {
  const s = sesionDe(usuario);
  if (s) {
    const c = s.campos;
    return {
      origen: 'sesion', servidor: c.servidor, puerto: c.puerto, puertoApi: c.puertoApi, usuario: c.usuario,
      clave: c.claveCifrada ? (descifrar(c.claveCifrada) || '') : '', ignorarCertificado: !!c.ignorarCertificado, expira: s.expira,
    };
  }
  return {
    origen: CLAVE_PREDEFINIDA ? 'predefinida' : 'ninguno', ...PREDEFINIDOS, clave: CLAVE_PREDEFINIDA, expira: null,
  };
}

// Resumen seguro para la pantalla (sin la clave).
function resumen(usuario) {
  const c = camposEfectivos(usuario);
  const faltan = [];
  if (!c.usuario) faltan.push('usuario');
  if (!c.clave) faltan.push('clave');
  return {
    configurada: faltan.length === 0, origen: c.origen, faltan,
    servidor: c.servidor || null, puerto: c.puerto, puertoApi: c.puertoApi,
    usuario: c.usuario || null,
    tieneClave: !!c.clave, claveFin: c.origen === 'sesion' && c.clave ? c.clave.slice(-2) : null,
    ignorarCertificado: c.ignorarCertificado,
    enSesion: c.origen === 'sesion', sesionExpira: c.expira ? new Date(c.expira).toISOString() : null,
  };
}

function urlServicio(c) {
  const personalizada = String(process.env.BIOMETRIA_API_URL || '').trim();
  if (personalizada) {
    if (!RE_URL.test(personalizada)) throw Object.assign(new Error('BIOMETRIA_API_URL no es una URL válida.'), { codigo: 'CONFIG' });
    return personalizada;
  }
  return `https://${c.servidor}:${c.puertoApi}/api/Biometria/ConsultarBiometria`;
}

// Todos los datos que entran al comando ya fueron validados (sin comillas ni espacios).
function armarComando(url, tipoDocumento, numeroDocumento, ignorarCertificado, maxTiempo = 30) {
  return `curl --location -sS${ignorarCertificado ? ' -k' : ''} --max-time ${Number(maxTiempo) || 30} -w '\\n__HTTP__%{http_code}' '${url}?tipoDocumento=${tipoDocumento}&numeroDocumento=${numeroDocumento}'`;
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------
// Mensaje entendible. Nunca incluye credenciales.
function mensajeErrorSsh(error, c) {
  const codigo = error?.codigo || error?.code;
  const texto = String(error?.message || error || '');
  const destino = `${c.servidor}:${c.puerto}`;
  if (codigo === 'TIMEOUT') return `El servidor ${destino} no respondió a tiempo.`;
  if (codigo === 'HUELLA') return `La llave SSH del servidor ${destino} cambió desde la última vez. Si el cambio es esperado, vuelve a ingresar las credenciales (o reinicia el backend) para confiar en la nueva.`;
  if (error?.level === 'client-authentication' || /authentication methods failed|all configured authentication/i.test(texto)) {
    return `El servidor ${destino} rechazó el usuario o la contraseña (o el usuario no puede entrar por SSH con clave).`;
  }
  if (codigo === 'ECONNREFUSED') return `El servidor ${destino} rechazó la conexión: revisa que el SSH esté activo y el puerto sea el correcto.`;
  if (codigo === 'ETIMEDOUT' || /timed out/i.test(texto)) return `Tiempo de espera agotado conectando a ${destino}: revisa la red o el firewall entre AXIS y ese servidor.`;
  if (['ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN'].includes(codigo)) return `No se pudo llegar al servidor ${destino} (${codigo}).`;
  if (/handshake/i.test(texto)) return `No se pudo negociar la conexión SSH con ${destino}.`;
  return `No se pudo ejecutar el comando en ${destino}: ${texto.slice(0, 200)}`;
}

const ERRORES_CURL = {
  6: 'El servidor de biometría no pudo resolver el nombre del servicio.',
  7: 'El servidor de biometría no pudo conectarse al servicio (puerto cerrado o servicio detenido).',
  28: 'El servicio de biometría no respondió a tiempo (más de 30 s).',
  35: 'Falló la negociación segura (TLS) con el servicio.',
  51: 'El certificado del servicio no coincide con su dirección.',
  58: 'El certificado del servicio no es válido.',
  60: 'El certificado HTTPS del servicio no es de confianza (es autofirmado o está vencido). Activa «Ignorar el certificado» en las credenciales del servidor para equivaler a curl -k.',
  77: 'El servidor de biometría no pudo leer los certificados de confianza.',
};

function mensajeCurl(codigo, errores) {
  const base = ERRORES_CURL[codigo] || `El comando curl terminó con el código ${codigo}.`;
  const detalle = String(errores || '').trim().split('\n').slice(-1)[0].slice(0, 200);
  return detalle && !ERRORES_CURL[codigo] ? `${base} ${detalle}` : base;
}

function validarCliente({ tipoDocumento, numeroDocumento }) {
  const tipo = String(tipoDocumento ?? '1').trim();
  const numero = String(numeroDocumento ?? '').trim();
  if (!RE_TIPO_DOC.test(tipo)) return { error: 'El tipo de documento debe ser un número (por ejemplo 1).' };
  if (!numero) return { error: 'Falta el número de documento del cliente.' };
  if (!RE_NUM_DOC.test(numero)) return { error: 'El número de documento solo puede tener letras y números (3 a 25 caracteres). Si viene enmascarado (xxxx) no se puede consultar.' };
  if (/[xX]{2,}/.test(numero)) return { error: 'El número de documento viene enmascarado (por ejemplo 1XXXXXXXX2): no se puede consultar.' };
  return { tipo, numero };
}

// ---------------------------------------------------------------------------
// Lote: varios documentos por UNA conexión SSH (cada uno en su propio canal, pocos a la vez).
// ---------------------------------------------------------------------------
const MAX_DOCUMENTOS_LOTE = 12;
const CONCURRENCIA = 6;
const MAX_TIEMPO_CURL = 20;
const TIEMPO_LOTE_MS = 55000;

function ejecutarSshVarios({ servidor, puerto, usuario, clave }, comandos) {
  return new Promise((resolve, reject) => {
    const conexion = new Client();
    const resultados = new Array(comandos.length).fill(null);
    let terminado = false;
    let huellaCambio = false;
    let pendientes = comandos.length;
    const fin = (error) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(reloj);
      try { conexion.end(); } catch (_) { /* nada */ }
      if (error) reject(error); else resolve(resultados);
    };
    const reloj = setTimeout(() => {
      // Lo que ya respondió se conserva; el resto se marca como sin respuesta.
      for (let i = 0; i < resultados.length; i += 1) if (!resultados[i]) resultados[i] = { error: 'sin-respuesta' };
      fin(null);
    }, TIEMPO_LOTE_MS);

    conexion.on('error', (e) => fin(huellaCambio ? Object.assign(new Error('La llave del servidor cambió.'), { codigo: 'HUELLA' }) : e));
    conexion.on('keyboard-interactive', (_n, _i, _l, preguntas, listo) => listo(preguntas.map(() => clave)));
    conexion.on('ready', () => {
      let siguiente = 0;
      const lanzar = () => {
        if (terminado) return;
        if (siguiente >= comandos.length) return;
        const i = siguiente; siguiente += 1;
        conexion.exec(comandos[i], (error, flujo) => {
          if (error) { resultados[i] = { error: String(error.message || error) }; listo(); return; }
          let salida = '';
          let errores = '';
          let truncado = false;
          flujo.on('data', (d) => { if (salida.length < MAX_SALIDA) salida += d.toString('utf8'); else truncado = true; });
          flujo.stderr.on('data', (d) => { if (errores.length < MAX_ERROR) errores += d.toString('utf8'); });
          flujo.on('close', (codigo) => {
            resultados[i] = { codigoSalida: codigo === undefined || codigo === null ? null : codigo, salida, errores, truncado };
            listo();
          });
        });
      };
      const listo = () => {
        pendientes -= 1;
        if (pendientes <= 0) fin(null); else lanzar();
      };
      if (!comandos.length) { fin(null); return; }
      for (let k = 0; k < Math.min(CONCURRENCIA, comandos.length); k += 1) lanzar();
    });
    try {
      conexion.connect({
        host: servidor, port: puerto, username: usuario, password: clave,
        readyTimeout: 15000, tryKeyboard: true, hostHash: 'sha256',
        hostVerifier: (hash) => {
          const k = `${servidor}:${puerto}`;
          const previa = huellas.get(k);
          if (previa && previa !== hash) { huellaCambio = true; return false; }
          huellas.set(k, hash);
          return true;
        },
      });
    } catch (e) {
      fin(e);
    }
  });
}

// Interpreta la salida de un curl: { ok, httpCodigo, cuerpo, json, error, truncado }.
function interpretarSalida(salida) {
  if (!salida || salida.error) {
    return { ok: false, httpCodigo: null, cuerpo: '', json: null, error: 'El servidor de biometría no devolvió ninguna respuesta a tiempo.', truncado: false, etapa: 'servicio' };
  }
  const marca = salida.salida.lastIndexOf('__HTTP__');
  const cuerpo = (marca >= 0 ? salida.salida.slice(0, marca) : salida.salida).replace(/\n$/, '');
  const http = marca >= 0 ? parseInt(salida.salida.slice(marca + 8).trim(), 10) : null;
  let json = null;
  if (cuerpo.trim()) { try { json = JSON.parse(cuerpo); } catch (_) { json = null; } }
  const respondio = Number.isInteger(http) && http > 0;
  let error = null;
  if (salida.codigoSalida && !respondio) error = mensajeCurl(salida.codigoSalida, salida.errores);
  else if (!respondio) error = 'El servidor de biometría no devolvió ninguna respuesta.';
  return {
    ok: respondio && http >= 200 && http < 300,
    httpCodigo: respondio ? http : null,
    cuerpo: cuerpo.length > 20000 ? `${cuerpo.slice(0, 20000)}…` : cuerpo,
    json, error, truncado: salida.truncado, etapa: 'servicio',
  };
}

// Consulta la biometría de varios documentos (máx. MAX_DOCUMENTOS_LOTE) con UNA conexión SSH.
// Devuelve { servidor, comando (plantilla), duracionMs, fallaConexion, error, resultados: [{ documento, ok, httpCodigo, json, cuerpo, error, etapa }] }.
// Lanza Error con `codigo`: 'VALIDACION' | 'SIN_CONFIG_SSH' | 'EN_CURSO' | 'CONFIG'.
async function consultarClientes(usuarioApp, { tipoDocumento, documentos }) {
  const tipo = String(tipoDocumento ?? '1').trim();
  if (!RE_TIPO_DOC.test(tipo)) throw Object.assign(new Error('El tipo de documento debe ser un número (por ejemplo 1).'), { codigo: 'VALIDACION' });
  if (!Array.isArray(documentos) || !documentos.length) throw Object.assign(new Error('No hay documentos para consultar.'), { codigo: 'VALIDACION' });
  if (documentos.length > MAX_DOCUMENTOS_LOTE) throw Object.assign(new Error(`Máximo ${MAX_DOCUMENTOS_LOTE} documentos por consulta.`), { codigo: 'VALIDACION' });
  const r = resumen(usuarioApp);
  if (!r.configurada) {
    throw Object.assign(new Error(
      'Falta la clave predefinida del servidor de biometría: revisa el archivo backend/utils/biometriaClave.js en el servidor de AXIS.'
    ), { codigo: 'SIN_CONFIG_SSH' });
  }
  const c = camposEfectivos(usuarioApp);
  if (enCurso.has(usuarioApp)) throw Object.assign(new Error('Ya tienes una consulta en curso. Espera a que termine.'), { codigo: 'EN_CURSO' });
  const url = urlServicio(c);

  // Cada documento se valida; los inválidos no llegan al servidor.
  const unicos = [...new Set(documentos.map((d) => String(d ?? '').trim()))];
  const resultados = [];
  const validos = [];
  for (const d of unicos) {
    const v = validarCliente({ tipoDocumento: tipo, numeroDocumento: d });
    if (v.error) resultados.push({ documento: d, ok: false, httpCodigo: null, json: null, cuerpo: '', error: v.error, etapa: 'validacion' });
    else validos.push(v.numero);
  }
  const plantilla = armarComando(url, tipo, '<documento>', c.ignorarCertificado, MAX_TIEMPO_CURL);
  const inicio = Date.now();
  if (!validos.length) return { servidor: c.servidor, comando: plantilla, duracionMs: 0, fallaConexion: false, error: null, resultados };

  enCurso.add(usuarioApp);
  try {
    let salidas;
    try {
      salidas = await ejecutarSshVarios(c, validos.map((d) => armarComando(url, tipo, d, c.ignorarCertificado, MAX_TIEMPO_CURL)));
    } catch (error) {
      const mensaje = mensajeErrorSsh(error, c);
      return {
        servidor: c.servidor, comando: plantilla, duracionMs: Date.now() - inicio, fallaConexion: true, error: mensaje,
        resultados: [...resultados, ...validos.map((d) => ({ documento: d, ok: false, httpCodigo: null, json: null, cuerpo: '', error: mensaje, etapa: 'ssh' }))],
      };
    }
    validos.forEach((d, i) => resultados.push({ documento: d, ...interpretarSalida(salidas[i]) }));
    return { servidor: c.servidor, comando: plantilla, duracionMs: Date.now() - inicio, fallaConexion: false, error: null, resultados };
  } finally {
    enCurso.delete(usuarioApp);
  }
}

// El curl tal como se ejecutaría A MANO en el servidor de biometría (sin las opciones internas -sS/-w/--max-time).
// `tipoDocumento` y `numeroDocumento` deben venir validados.
function curlManual(usuarioApp, tipoDocumento, numeroDocumento) {
  const c = camposEfectivos(usuarioApp);
  const url = urlServicio(c);
  return `curl --location${c.ignorarCertificado ? ' -k' : ''} '${url}?tipoDocumento=${tipoDocumento}&numeroDocumento=${numeroDocumento}'`;
}

// Datos NO secretos del servicio para que la pantalla arme el curl al escribir la cédula (nunca la clave ni el usuario SSH).
function describirServicio(usuarioApp) {
  const c = camposEfectivos(usuarioApp);
  const url = urlServicio(c);
  return {
    servidor: c.servidor, puertoApi: c.puertoApi, url, ignorarCertificado: !!c.ignorarCertificado,
    tipoDocumentoPorDefecto: 1, configurado: !!resumen(usuarioApp).configurada,
    curlPlantilla: `curl --location${c.ignorarCertificado ? ' -k' : ''} '${url}?tipoDocumento=<tipoDocumento>&numeroDocumento=<documento>'`,
  };
}

module.exports = {
  validarServidor, definirSesion, quitarSesion, resumen, consultarClientes, curlManual, describirServicio,
  // para pruebas
  armarComando, validarCliente, interpretarSalida, PREDEFINIDOS, MAX_DOCUMENTOS_LOTE,
};
