// Lo que la configuración de un contenedor («docker run» / compose / stack) dice sobre sus certificados.
//
// Del «inspect» de Docker (que Portainer expone) se reconstruye lo que se ejecutó: imagen, comando, variables de
// entorno, montajes, puertos. De ahí salen dos cosas que los servidores no comparten (cada uno pone sus certificados
// en una ruta distinta):
//   · REFERENCIAS: rutas de certificados/keystores/carpetas que la configuración nombra (variables de entorno,
//     propiedades -D…, banderas --cert…, montajes, rutas relativas al WORKDIR, «classpath:»).
//   · CONTRASEÑAS: las del keystore que el propio contenedor usa (variables *_PASSWORD, -D…password=…, --…pass…,
//     *_FILE que apuntan a un secreto), para abrir los PFX/JKS.
//
// Todo es PURO (no toca red ni disco). Las contraseñas se devuelven aparte (`claves`) y NUNCA entran en lo que se
// muestra: el comando reconstruido sale con los secretos enmascarados.

const posix = require('path').posix;

const EXT_CERT = /\.(pem|crt|cer|cert|der|pfx|p12|jks|keystore|truststore)$/i;
const PISTA_CARPETA = /(cert|ssl|tls|pki|keystore|trust|secret|https|jks|pfx|cred)/i;
const NOMBRE_RUTA_CERT = /(cert|ssl|tls|key[-_.]?store|trust[-_.]?store|pfx|p12|pem|jks|https|kestrel|cacert)/i;
const NOMBRE_CLAVE = /(pass|pwd|secret|clave|contrase|passphrase)/i;
const NOMBRE_CLAVE_SUELTA = /(keystore|truststore|pfx|p12|jks|cert|ssl|tls|kestrel).*(key|pw|pin|code)$/i;
const NOMBRE_SECRETO = /(pass|pwd|secret|token|api[-_.]?key|credential|private[-_.]?key|auth|conn(ection)?[-_.]?str|dsn|salt)/i;
const MONTAJE_EXCLUIDO = /(^|\/)(logs?|tmp|cache|proc|sys|dev)(\/|$)|^\/var\/(lib|log)(\/|$)/i;
const SISTEMA = /^\/(etc\/ssl\/certs\/|usr\/share\/ca-certificates\/|etc\/pki\/|usr\/lib\/ssl\/certs\/|etc\/ssl\/cert\.pem$|usr\/lib\/jvm\/|opt\/java\/)/;
const VALOR_BOOLEANO = /^(true|false|yes|no|on|off|0|1|enabled|disabled)$/i;
const SIN_CAMBIO_IMAGEN = /^(PATH|HOME|HOSTNAME|TERM|LANG|LC_ALL|LANGUAGE|PWD|SHLVL|TZ|container|DEBIAN_FRONTEND)$/;

const MAX_REFERENCIAS = 40;
const MAX_CLAVES = 40;

function rutaValida(r) {
  return typeof r === 'string' && r.startsWith('/') && r.length > 1 && r.length <= 300 && !/[\0\r\n]/.test(r) && !r.split('/').includes('..');
}

/** Parte un texto en palabras respetando comillas simples y dobles (como lo haría un shell, sin expansiones). */
function puroTokenizar(texto) {
  const salida = [];
  let actual = '';
  let comilla = null;
  let hay = false;
  for (const ch of String(texto || '')) {
    if (comilla) {
      if (ch === comilla) comilla = null; else actual += ch;
    } else if (ch === '"' || ch === '\'') { comilla = ch; hay = true; }
    else if (/\s/.test(ch)) { if (hay || actual) salida.push(actual); actual = ''; hay = false; }
    else { actual += ch; hay = true; }
  }
  if (hay || actual) salida.push(actual);
  return salida;
}

/** ${VAR}, ${VAR:-valor} y $VAR → su valor en las variables del contenedor (una sola pasada). */
function expandir(valor, env) {
  return String(valor).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, defecto, b) => {
    const nombre = a || b;
    if (env.has(nombre)) return env.get(nombre);
    return defecto !== undefined ? defecto : m;
  });
}

function pareceRutaOUrl(v) {
  return /^(\/|\.\.?\/|file:|classpath:|https?:|[a-z]+:\/\/)/i.test(v) || EXT_CERT.test(v);
}

/** ¿Este valor puede ser una contraseña (y no una ruta, un booleano o una URL)? */
function valorComoClave(v) {
  const t = String(v ?? '');
  if (!t || t.length > 128 || VALOR_BOOLEANO.test(t) || /\s/.test(t) && t.length > 64) return false;
  if (pareceRutaOUrl(t) || /^\$\{?[A-Za-z_]/.test(t)) return false;
  return true;
}

function nombreEsClave(nombre) {
  const n = String(nombre || '');
  return NOMBRE_CLAVE.test(n) || NOMBRE_CLAVE_SUELTA.test(n);
}

/** Enmascara el valor si el nombre o el contenido parecen un secreto; deja visibles las rutas y valores comunes. */
function puroEnmascarar(nombre, valor) {
  const v = String(valor ?? '');
  const MASCARA = '••••••';
  if (/:\/\/[^/\s:@]+:[^/\s@]+@/.test(v)) return v.replace(/(:\/\/[^/\s:@]+:)[^/\s@]+@/g, `$1${MASCARA}@`);
  if (!nombre) return v;
  if (nombreEsClave(nombre) || NOMBRE_SECRETO.test(nombre)) {
    if (/(path|file|dir|location|folder|ruta)$/i.test(nombre) && pareceRutaOUrl(v)) return v;
    if (!nombreEsClave(nombre) && pareceRutaOUrl(v) && !/(token|secret|key)/i.test(nombre)) return v;
    if (/\.(pfx|p12|jks|pem|crt|cer)$/i.test(v) || v.startsWith('/')) return v;
    return v ? MASCARA : v;
  }
  return v;
}

function escaparShell(t) {
  const s = String(t);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Reconstruye el «docker run» equivalente, con secretos enmascarados. `imagenInspect` (opcional) permite mostrar solo
 * las variables, el entrypoint y el comando que el contenedor cambió respecto a su imagen.
 */
function puroComandoDockerRun(inspect, imagenInspect = null) {
  const c = (inspect && inspect.Config) || {};
  const h = (inspect && inspect.HostConfig) || {};
  const nombre = String((inspect && inspect.Name) || '').replace(/^\//, '');
  const partes = ['docker run -d'];
  if (nombre) partes.push(`--name ${escaparShell(nombre)}`);
  if (h.RestartPolicy && h.RestartPolicy.Name && h.RestartPolicy.Name !== 'no') {
    partes.push(`--restart ${h.RestartPolicy.Name}${h.RestartPolicy.MaximumRetryCount ? `:${h.RestartPolicy.MaximumRetryCount}` : ''}`);
  }
  if (h.NetworkMode && !['default', 'bridge'].includes(h.NetworkMode)) partes.push(`--network ${escaparShell(h.NetworkMode)}`);
  if (h.Privileged) partes.push('--privileged');
  if (c.User) partes.push(`-u ${escaparShell(c.User)}`);
  if (c.WorkingDir && !(imagenInspect && imagenInspect.Config && imagenInspect.Config.WorkingDir === c.WorkingDir)) partes.push(`-w ${escaparShell(c.WorkingDir)}`);
  for (const [clave, lista] of Object.entries(h.PortBindings || {})) {
    for (const b of lista || []) {
      const [pc, proto] = clave.split('/');
      partes.push(`-p ${b.HostIp ? `${b.HostIp}:` : ''}${b.HostPort || ''}:${pc}${proto && proto !== 'tcp' ? `/${proto}` : ''}`);
    }
  }
  const binds = Array.isArray(h.Binds) && h.Binds.length ? h.Binds
    : ((inspect && inspect.Mounts) || []).map((m) => `${m.Source || m.Name || ''}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
  for (const b of binds) partes.push(`-v ${escaparShell(b)}`);
  const envImagen = new Set(((imagenInspect && imagenInspect.Config && imagenInspect.Config.Env) || []).map(String));
  for (const e of c.Env || []) {
    const i = String(e).indexOf('=');
    if (i < 0) continue;
    const k = String(e).slice(0, i);
    if (envImagen.has(String(e)) || (!imagenInspect && SIN_CAMBIO_IMAGEN.test(k))) continue;
    if (imagenInspect && SIN_CAMBIO_IMAGEN.test(k)) continue;
    partes.push(`-e ${escaparShell(`${k}=${puroEnmascarar(k, String(e).slice(i + 1))}`)}`);
  }
  const igual = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  const ic = (imagenInspect && imagenInspect.Config) || null;
  if (c.Entrypoint && c.Entrypoint.length && !(ic && igual(c.Entrypoint, ic.Entrypoint))) partes.push(`--entrypoint ${escaparShell(c.Entrypoint[0])}`);
  partes.push(escaparShell(c.Image || 'imagen'));
  const resto = [];
  if (c.Entrypoint && c.Entrypoint.length > 1 && !(ic && igual(c.Entrypoint, ic.Entrypoint))) resto.push(...c.Entrypoint.slice(1));
  if (c.Cmd && c.Cmd.length && !(ic && igual(c.Cmd, ic.Cmd))) resto.push(...c.Cmd);
  // Banderas de contraseña en el comando: el valor se enmascara (--pass x, --pass=x, -Dalgo.password=x, -storepass x).
  for (let i = 0; i < resto.length; i += 1) {
    const t = String(resto[i]);
    const eq = t.indexOf('=');
    if (eq > 0 && /^-/.test(t) && nombreEsClave(t.slice(0, eq))) { partes.push(escaparShell(`${t.slice(0, eq + 1)}${puroEnmascarar(t.slice(0, eq), t.slice(eq + 1))}`)); continue; }
    if (/^-{1,2}[A-Za-z][\w.-]*$/.test(t) && nombreEsClave(t) && i + 1 < resto.length && !String(resto[i + 1]).startsWith('-')) {
      partes.push(escaparShell(t), escaparShell('••••••')); i += 1; continue;
    }
    partes.push(escaparShell(t.length > 400 ? `${t.slice(0, 400)}…` : puroEnmascarar('', t)));
  }
  return partes.join(' \\\n  ');
}

/**
 * @param {object} inspect  «inspect» de Docker
 * @returns {{
 *   imagen:string, workdir:string, usaTls:boolean,
 *   referencias:{ruta:string, original:string, tipo:'archivo'|'carpeta'|'classpath', origen:string}[],
 *   claves:{valor:string, origen:string}[],
 *   archivosClave:{ruta:string, origen:string}[],
 *   montajes:{origen:string, destino:string, tipo:string}[]
 * }}  `claves` es SOLO para uso interno (abrir PFX): no se muestra ni se guarda.
 */
function puroAnalizarConfiguracion(inspect) {
  const config = (inspect && inspect.Config) || {};
  const workdir = rutaValida(config.WorkingDir) ? config.WorkingDir.replace(/\/+$/, '') || '/' : '';
  const env = new Map();
  for (const e of config.Env || []) {
    const i = String(e).indexOf('=');
    if (i > 0) env.set(String(e).slice(0, i), String(e).slice(i + 1));
  }

  const referencias = [];
  const vistasRef = new Set();
  const claves = [];
  const vistasClave = new Set();
  const archivosClave = [];
  let usaTls = false;

  const agregarRef = (ruta, original, tipo, origen) => {
    if (referencias.length >= MAX_REFERENCIAS) return;
    if (tipo !== 'classpath' && (!rutaValida(ruta) || SISTEMA.test(ruta))) return;
    const k = `${tipo}|${ruta}`;
    if (vistasRef.has(k)) return;
    vistasRef.add(k);
    referencias.push({ ruta: tipo === 'carpeta' ? (ruta.replace(/\/+$/, '') || '/') : ruta, original, tipo, origen });
  };
  const agregarClave = (valor, origen) => {
    if (claves.length >= MAX_CLAVES || !valorComoClave(valor) || vistasClave.has(valor)) return;
    vistasClave.add(valor);
    claves.push({ valor: String(valor), origen });
  };

  /** Una ruta que la configuración nombra bajo un nombre de variable/propiedad/bandera (o sin nombre). */
  const considerarValor = (nombre, crudo, origen) => {
    const valor = expandir(crudo, env).trim();
    if (!valor) return;
    for (const trozo of valor.split(/[,;]/)) {
      let v = trozo.trim().replace(/^["']|["']$/g, '');
      if (!v || /\s/.test(v) || v.startsWith('-')) continue;
      v = v.replace(/^(pkcs12|jks|pem|jceks):/i, '');
      let classpath = false;
      if (/^classpath:/i.test(v)) { classpath = true; v = v.replace(/^classpath:/i, '').replace(/^\/+/, ''); }
      else if (/^file:\/\//i.test(v)) v = v.replace(/^file:\/\//i, '');
      else if (/^file:/i.test(v)) v = v.replace(/^file:/i, '');
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) continue; // URL, no es un archivo del contenedor
      const pista = NOMBRE_RUTA_CERT.test(nombre || '') && !nombreEsClave(nombre || '');
      if (classpath) {
        if (EXT_CERT.test(v)) agregarRef(v, trozo.trim(), 'classpath', origen);
        continue;
      }
      let abs = null;
      if (v.startsWith('/')) abs = posix.normalize(v);
      else if ((v.startsWith('./') || v.startsWith('../') || EXT_CERT.test(v) || (pista && v.includes('/'))) && !v.includes('..')) abs = posix.resolve(workdir || '/', v);
      if (!abs) continue;
      if (EXT_CERT.test(abs)) agregarRef(abs, trozo.trim(), 'archivo', origen);
      else if (pista && /^(\/|\.\/)/.test(v) && abs.split('/').length <= 8 && !/\.[a-z0-9]{1,5}$/i.test(abs)) agregarRef(abs, trozo.trim(), 'carpeta', origen);
      else if (!pista && v.startsWith('/') && PISTA_CARPETA.test(abs) && abs.split('/').length <= 8 && !/\.[a-z0-9]{1,5}$/i.test(abs)) agregarRef(abs, trozo.trim(), 'carpeta', origen);
    }
  };

  // ---- Variables de entorno
  for (const [k, v] of env) {
    const origen = `variable ${k}`;
    if (/_FILE$/i.test(k) && rutaValida(v) && nombreEsClave(k)) { archivosClave.push({ ruta: v, origen }); continue; }
    if (nombreEsClave(k)) { const vv = expandir(v, env); if (valorComoClave(vv)) agregarClave(vv, origen); else considerarValor(k, v, origen); continue; }
    if (!/\s/.test(v) && !/^-/.test(v)) considerarValor(k, v, origen);
    if (/(^|_)(SSL|TLS|HTTPS|KEYSTORE|KESTREL|CERT)/i.test(k) && v && !/^(false|0|no|off|disabled?)$/i.test(v)) usaTls = true;
    if (/URLS?$/i.test(k) && /https:\/\//i.test(v)) usaTls = true;
  }

  // ---- Palabras de un comando: propiedades -D…, banderas --x=y, --x y, KEY=valor de un «sh -c»
  const procesarPalabras = (palabras, prefijo) => {
    for (let i = 0; i < palabras.length; i += 1) {
      const t = palabras[i];
      const eq = t.indexOf('=');
      if (eq > 0) {
        const nombre = t.slice(0, eq).replace(/^-+(D)?/, '');
        const valor = t.slice(eq + 1);
        const origen = `${prefijo} ${t.slice(0, eq)}`;
        if (nombreEsClave(nombre)) { const vv = expandir(valor, env); if (valorComoClave(vv)) agregarClave(vv, origen); else considerarValor(nombre, valor, origen); continue; }
        considerarValor(nombre, valor, origen);
        if (NOMBRE_RUTA_CERT.test(nombre) && /(enabled|ssl|tls)/i.test(nombre) && /^true$/i.test(valor)) usaTls = true;
        continue;
      }
      if (/^-{1,2}[A-Za-z][\w.-]*$/.test(t)) {
        const sig = palabras[i + 1];
        if (sig !== undefined && !sig.startsWith('-')) {
          if (nombreEsClave(t)) { agregarClave(expandir(sig, env), `${prefijo} ${t}`); i += 1; continue; }
          if (NOMBRE_RUTA_CERT.test(t)) { considerarValor(t, sig, `${prefijo} ${t}`); i += 1; continue; }
        }
        continue;
      }
      if (EXT_CERT.test(t) || (t.startsWith('/') && PISTA_CARPETA.test(t) && !/\s/.test(t))) considerarValor('', t, prefijo);
    }
  };
  const argumentos = [...(config.Entrypoint || []), ...(config.Cmd || [])].map(String);
  const palabras = [];
  for (const a of argumentos) {
    if (/\s/.test(a) && a.length < 4000) palabras.push(...puroTokenizar(a)); else palabras.push(a);
  }
  procesarPalabras(palabras, 'comando');
  // Variables con opciones dentro (JAVA_OPTS, JAVA_TOOL_OPTIONS, CATALINA_OPTS, NODE_OPTIONS…)
  for (const [k, v] of env) {
    if ((/\s/.test(v) || /^-/.test(v)) && v.length < 4000 && !nombreEsClave(k)) procesarPalabras(puroTokenizar(expandir(v, env)), `variable ${k}`);
  }

  // ---- Montajes (los -v / volúmenes del docker run)
  const montajes = [];
  for (const m of (inspect && inspect.Mounts) || []) {
    const destino = m.Destination || '';
    if (!rutaValida(destino) || /\.sock$/.test(destino)) continue;
    const tipo = m.Type || (m.Source && m.Source.startsWith('/') ? 'bind' : 'volume');
    montajes.push({ origen: m.Source || m.Name || '', destino, tipo });
    if (EXT_CERT.test(destino) || EXT_CERT.test(m.Source || '')) agregarRef(destino, destino, 'archivo', 'montaje (-v)');
    else if (PISTA_CARPETA.test(destino) || PISTA_CARPETA.test(m.Source || '')) agregarRef(destino, destino, 'carpeta', 'montaje (-v)');
  }
  if (referencias.length || claves.length) usaTls = true;

  return {
    imagen: config.Image || '', workdir, usaTls,
    referencias, claves, archivosClave, montajes,
  };
}

module.exports = {
  puroAnalizarConfiguracion, puroComandoDockerRun, puroEnmascarar, puroTokenizar, nombreEsClave, valorComoClave,
  EXT_CERT, PISTA_CARPETA, MONTAJE_EXCLUIDO, rutaValida, SISTEMA,
};
