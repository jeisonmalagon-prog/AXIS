// Certificados de los contenedores (vía Portainer) y conciliación con el inventario de Certificados.
//
// Qué hace, en dos métodos que se complementan:
//   1. SONDEO TLS: se conecta a cada puerto TCP que los contenedores en ejecución tienen publicado en su servidor
//      y, si responde TLS, lee el certificado que presenta (el que realmente está sirviendo).
//   2. ARCHIVOS: pide a Portainer (API de Docker, «archive») los archivos de certificados que hay dentro de cada
//      contenedor — .pem .crt .cer .der .pfx .p12 .jks — en rutas probables (variables de entorno, montajes con
//      nombre de certificados, carpetas habituales) y los lee en el backend. Los PFX se abren con contraseña vacía,
//      con las variables de entorno del MISMO contenedor que parezcan contraseña, o con las que el usuario escriba
//      al lanzar el escaneo.
// Luego agrupa lo encontrado por servidor + certificado y lo compara, en vivo, con la tabla Certificados.
//
// SEGURIDAD: solo lectura. Nunca se extraen llaves privadas (los «.key» ni se descargan; de PFX/JKS solo se toman los
// certificados). Las contraseñas viven en memoria durante el escaneo: no se guardan, no se registran, no se auditan
// ni se devuelven. Solo se sondean puertos que Portainer informa como publicados por un contenedor en ejecución.
//
// Las funciones con prefijo «puro» no tocan red ni base de datos para poder probarlas.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const posix = require('path').posix;
const portainer = require('./portainer');
const { consultarEntornos, puroEmparejar } = require('./puertosPortainer');
const { leerArchivoCertificados, nombreInteresa, infoCertificado, aHex } = require('./certParseo');
const { LectorTar } = require('./tarLector');
const { leerZip } = require('./zipLector');
const { puroAnalizarConfiguracion, puroComandoDockerRun, nombreEsClave, valorComoClave, SISTEMA: SISTEMA_RUTA } = require('./certConfigContenedor');

// ---------------------------------------------------------------- límites (protegen a Portainer, a los servidores y al backend)
const MAX_ARCHIVO_BYTES = 2 * 1024 * 1024;         // un certificado/keystore real pesa KB
const MAX_BYTES_CARPETA = 32 * 1024 * 1024;        // por carpeta pedida (búsqueda normal)
const MAX_BYTES_CARPETA_PROFUNDA = 128 * 1024 * 1024;
const MAX_BYTES_BIND = 16 * 1024 * 1024;           // carpetas montadas desde el servidor (pueden ser datos enormes)
const MAX_BYTES_APP = 256 * 1024 * 1024;           // /app y WORKDIR: ahí vive la aplicación (un .jar solo pesa 100 MB)
const MAX_BYTES_APP_PROFUNDA = 512 * 1024 * 1024;
const MAX_JAR_BYTES = 150 * 1024 * 1024;           // .jar/.war que se abre en memoria para buscar el keystore
const MAX_JAR_MEMORIA = 300 * 1024 * 1024;         // tope de .jar en memoria entre todos los contenedores a la vez
const MAX_CLAVES_TOTAL = 40;
const MAX_ENTRADAS_TAR = 50000;
const MAX_RUTAS_POR_CONTENEDOR = 40;
const MAX_ARCHIVOS_POR_CONTENEDOR = 80;
const MAX_CLAVES = 12;
const SIMULTANEOS_CONTENEDORES = 4;
const SIMULTANEOS_SONDEOS = 10;
const MAX_PUERTOS_SONDEO_POR_ENTORNO = 300;
const TIEMPO_SONDEO_MS = 3000;
const DIAS_POR_VENCER = 30;                         // igual que la vista de Certificados
const TOLERANCIA_DIAS = 1;                          // las fechas del inventario se escriben a mano: ±1 día no es diferencia
const MAX_DURACION_MS = 45 * 60 * 1000;

// Carpetas donde es habitual dejar certificados (cada una cuesta una petición pequeña; si no existe, Docker responde 404).
const RUTAS_HABITUALES = [
  '/certs', '/certificates', '/certificados', '/cert', '/ssl', '/tls', '/pki', '/https', '/keystore', '/keystores', '/secrets', '/run/secrets',
  '/app/certs', '/app/certificates', '/app/cert', '/app/ssl', '/app/https', '/app/keystore', '/app/security', '/app/config/certs', '/app/config/ssl',
  '/etc/nginx/ssl', '/etc/nginx/certs', '/etc/letsencrypt', '/etc/traefik/certs', '/etc/haproxy/certs', '/etc/apache2/ssl', '/etc/httpd/ssl',
  '/usr/local/share/ca-certificates', '/usr/share/nginx/certs', '/opt/certs', '/data/certs', '/root/.aspnet/https', '/home/app/.aspnet/https',
];
// Búsqueda profunda: además, las carpetas donde suele vivir la aplicación.
const RUTAS_PROFUNDAS = ['/app', '/usr/src/app', '/opt', '/srv', '/data', '/config', '/etc/nginx', '/etc/apache2', '/etc/httpd', '/etc/haproxy', '/etc/traefik'];

const EXT_CERT = /\.(pem|crt|cer|cert|der|pfx|p12|jks|keystore|truststore)$/i;
const PISTA_CARPETA = /(cert|ssl|tls|pki|keystore|trust|secret|https|jks|pfx|cred)/i;
const MONTAJE_EXCLUIDO = /(^|\/)(logs?|tmp|cache|proc|sys|dev)(\/|$)|^\/var\/(lib|log)(\/|$)/i;
const EXT_JAR = /\.(jar|war|ear)$/i;
// Librerías y runtimes: no son «la aplicación» y no vale la pena traerlos a memoria.
const JAR_EXCLUIDO = /(^|\/)(lib|libs|jre|jdk|ext|endorsed|\.m2|node_modules|gradle|webapps\/ROOT\/WEB-INF)\/|^\/usr\/(lib|share|local\/lib)\//i;
const NOMBRE_CLAVE_PASS = /(pass|pwd|secret|clave|keystore|pfx|p12|cert|jks)/i;
// Bundles de CA del sistema y dependencias: ruido que no es «un certificado del contenedor».
const ARCHIVO_EXCLUIDO = /^\/(etc\/ssl\/certs\/|usr\/share\/ca-certificates\/|etc\/pki\/|usr\/lib\/ssl\/certs\/|etc\/ssl\/cert\.pem$|usr\/lib\/jvm\/|opt\/java\/|usr\/lib\/python|usr\/local\/lib\/python|usr\/lib\/node_modules\/|usr\/local\/lib\/node_modules\/)|\/(node_modules|site-packages|dist-packages|\.git)\//;
const ARCHIVO_DE_LLAVE = /(^|\/)(privkey|private|private[-_]key|.*[-_.]key)\.pem$/i;

// ---------------------------------------------------------------- rutas candidatas (puro)
function puroRutaValida(r) {
  return typeof r === 'string' && r.startsWith('/') && r.length > 1 && r.length <= 300 && !/[\0\r\n]/.test(r) && !r.split('/').includes('..');
}

function puroRutasEnTexto(valor) {
  const salida = [];
  for (const trozo of String(valor || '').split(/[,;]/)) {
    const v = trozo.trim().replace(/^file:\/\//i, '');
    if (!puroRutaValida(v) || /\s/.test(v)) continue;
    if (EXT_CERT.test(v)) salida.push({ ruta: v, tipo: 'archivo' });
    else if (PISTA_CARPETA.test(v) && v.split('/').length <= 8) salida.push({ ruta: v.replace(/\/+$/, ''), tipo: 'carpeta' });
  }
  return salida;
}

/**
 * Rutas del contenedor donde buscar certificados, de las más precisas a las más generales:
 *   1. lo que su configuración («docker run») nombra: variables, propiedades -D, banderas --cert…, montajes -v
 *   2. las que indique el usuario
 *   3. carpetas montadas desde el servidor (bind mounts)
 *   4. la carpeta de la aplicación (WORKDIR y /app): ahí es donde suelen quedar keystore.pfx / *.p12 / *.jks
 *   5. carpetas habituales (y, en búsqueda profunda, más)
 * @param {object} inspect  «inspect» crudo de Docker
 */
function puroRutasCandidatas(inspect, { profundo = false, rutasExtra = [] } = {}) {
  const an = puroAnalizarConfiguracion(inspect);
  const capCarpeta = profundo ? MAX_BYTES_CARPETA_PROFUNDA : MAX_BYTES_CARPETA;
  const capApp = profundo ? MAX_BYTES_APP_PROFUNDA : MAX_BYTES_APP;
  const capBind = profundo ? MAX_BYTES_CARPETA_PROFUNDA : MAX_BYTES_BIND;
  const candidatas = [];
  const agregar = (ruta, tipo, origen, max, general = false) => {
    if (!puroRutaValida(ruta)) return;
    candidatas.push({ ruta: ruta.replace(/\/+$/, '') || '/', tipo, origen, max: max || capCarpeta, general });
  };

  for (const r of an.referencias) {
    if (r.tipo === 'classpath') continue; // vive dentro del .jar o en la carpeta de la aplicación: se busca allí
    agregar(r.ruta, r.tipo, r.origen);
  }
  for (const r of rutasExtra || []) agregar(String(r).trim(), EXT_CERT.test(String(r)) ? 'archivo' : 'carpeta', 'indicada por el usuario');
  for (const m of an.montajes) {
    if (EXT_CERT.test(m.destino)) continue; // ya es una referencia
    if (m.tipo === 'bind' && !MONTAJE_EXCLUIDO.test(m.destino)) agregar(m.destino, 'carpeta', 'montaje (-v) desde el servidor', capBind);
    else if (profundo && !MONTAJE_EXCLUIDO.test(m.destino)) agregar(m.destino, 'carpeta', 'montaje', capBind);
  }
  if (an.workdir && an.workdir !== '/' && !SISTEMA_RUTA.test(`${an.workdir}/`) && !/^\/(usr|bin|sbin|lib|lib64|var|proc|sys|dev|tmp|root)(\/|$)/.test(an.workdir)) {
    agregar(an.workdir, 'carpeta', 'carpeta de trabajo (WORKDIR)', capApp);
  }
  agregar('/app', 'carpeta', 'carpeta de la aplicación', capApp);
  for (const r of RUTAS_HABITUALES) agregar(r, 'carpeta', 'ruta habitual', capCarpeta, true);
  if (profundo) for (const r of RUTAS_PROFUNDAS) agregar(r, 'carpeta', 'búsqueda profunda', capCarpeta, true);

  const vistas = new Set();
  const unicas = [];
  for (const c of candidatas) {
    if (vistas.has(c.ruta)) continue;
    vistas.add(c.ruta);
    unicas.push(c);
  }
  // Las carpetas «genéricas» (habituales/profundas) ya cubiertas por otra más general no se piden dos veces. Lo que
  // dice la configuración y los archivos concretos SIEMPRE se piden (son pequeños y lo leído no se repite).
  const carpetas = unicas.filter((c) => c.tipo === 'carpeta').map((c) => c.ruta);
  const utiles = unicas.filter((c) => !c.general || !carpetas.some((d) => d !== c.ruta && (d === '/' || c.ruta.startsWith(`${d}/`))));
  return utiles.slice(0, MAX_RUTAS_POR_CONTENEDOR);
}

/**
 * Contraseñas probables de los PFX/JKS de ESTE contenedor, cada una con su origen (solo el origen se muestra):
 * su configuración («docker run»), sus secretos leídos y las que escriba el usuario al lanzar el escaneo.
 */
function puroClavesConOrigen(inspect, { clavesExtra = [], secretos = [] } = {}) {
  const vistas = new Set();
  const lista = [];
  const agregar = (valor, origen) => {
    const t = String(valor ?? '');
    if (!t || t.length > 128 || vistas.has(t)) return;
    vistas.add(t);
    lista.push({ valor: t, origen });
  };
  const an = puroAnalizarConfiguracion(inspect);
  for (const c of an.claves) agregar(c.valor, c.origen);
  for (const s of secretos) agregar(s.valor, s.origen);
  for (const e of ((inspect && inspect.Config && inspect.Config.Env) || [])) {
    const i = String(e).indexOf('=');
    if (i < 0) continue;
    const nombre = String(e).slice(0, i);
    const valor = String(e).slice(i + 1);
    if (NOMBRE_CLAVE_PASS.test(nombre) && valorComoClave(valor)) agregar(valor, `variable ${nombre}`);
  }
  for (const c of clavesExtra || []) agregar(c, 'indicada al escanear');
  return lista.slice(0, MAX_CLAVES_TOTAL);
}

function puroClavesDelContenedor(inspect, clavesExtra = []) {
  return puroClavesConOrigen(inspect, { clavesExtra }).map((c) => c.valor);
}

/**
 * Estado de cada referencia de la configuración contra lo que realmente se leyó.
 *  leido · protegido · sin_certificado · no_existe · no_encontrado · no_leido
 */
function puroEstadoReferencias(referencias, archivos, candidatas) {
  const halladoEn = (pred) => archivos.filter((a) => pred(a.ruta));
  const resumenArchivos = (lista) => {
    const certs = lista.reduce((n, a) => n + a.certificados.length, 0);
    if (certs) return { estado: 'leido', detalle: `${certs} certificado${certs === 1 ? '' : 's'}` };
    if (lista.some((a) => a.protegido)) return { estado: 'protegido', detalle: 'Protegido con una contraseña que no se encontró' };
    return { estado: 'sin_certificado', detalle: lista.find((a) => a.error)?.error || 'El archivo no contiene certificados' };
  };
  return referencias.map((r) => {
    const base = { ruta: r.ruta, original: r.original, tipo: r.tipo, origen: r.origen };
    if (r.tipo === 'archivo') {
      const f = halladoEn((p) => p === r.ruta || p.startsWith(`${r.ruta}!/`));
      if (f.length) return { ...base, ...resumenArchivos(f) };
    } else if (r.tipo === 'classpath') {
      const f = halladoEn((p) => p.endsWith(`/${r.ruta}`) || p.endsWith(`!/${r.ruta}`) || p.endsWith(`!/BOOT-INF/classes/${r.ruta}`) || posix.basename(p) === posix.basename(r.ruta));
      if (f.length) return { ...base, ...resumenArchivos(f) };
      return { ...base, estado: 'no_encontrado', detalle: 'No está en la carpeta de la aplicación ni dentro de los .jar/.war leídos' };
    } else {
      const f = halladoEn((p) => p.startsWith(`${r.ruta}/`));
      if (f.length) return { ...base, ...resumenArchivos(f) };
    }
    const propia = candidatas.find((c) => c.ruta === r.ruta);
    if (propia && propia.existe === false) return { ...base, estado: 'no_existe', detalle: 'La ruta no existe dentro del contenedor (puede estar solo en el servidor o montarse al arrancar)' };
    if (propia && propia.existe && !propia.truncado) return { ...base, estado: r.tipo === 'archivo' ? 'no_leido' : 'sin_certificado', detalle: r.tipo === 'archivo' ? 'Existe pero no se pudo leer (tamaño o formato)' : 'La carpeta no contiene archivos de certificados' };
    const madre = candidatas.filter((c) => c.tipo === 'carpeta' && c.existe && r.ruta.startsWith(`${c.ruta}/`)).sort((a, b) => b.ruta.length - a.ruta.length)[0];
    if (madre && !madre.truncado) return { ...base, estado: 'no_existe', detalle: `No está dentro de ${madre.ruta}` };
    return { ...base, estado: 'no_leido', detalle: 'No se pudo comprobar (lectura parcial o sin permiso)' };
  });
}

// ---------------------------------------------------------------- lectura de archivos de un contenedor
async function enLotes(lista, n, tarea) {
  const salida = [];
  let i = 0;
  const trabajador = async () => {
    while (i < lista.length) {
      const k = i; i += 1;
      salida[k] = await tarea(lista[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, trabajador));
  return salida;
}

let jarEnMemoria = 0; // bytes de .jar/.war que se están sosteniendo en memoria (entre todos los contenedores)

/** Lee, por Portainer (solo lectura), archivos de texto pequeños — las contraseñas que el contenedor guarda en secretos. */
async function leerSecretosDelContenedor(descargar, endpointId, containerId, analisis) {
  const encontrados = [];
  const pedir = async (ruta, filtro, origenDe) => {
    const base = posix.dirname(ruta);
    const lector = new LectorTar({
      maxEntradas: 500,
      quiere: ({ nombre, tamano }) => tamano > 0 && tamano <= 512 && filtro(posix.basename(nombre)),
      alArchivo: ({ nombre }, datos) => {
        const t = datos.toString('utf8').split(/\r?\n/)[0].trim();
        if (valorComoClave(t)) encontrados.push({ valor: t, origen: origenDe(posix.basename(nombre)) });
      },
    });
    try { await descargar(endpointId, containerId, ruta, { maxBytes: 256 * 1024, alTrozo: (t) => lector.escribir(t), totalMs: 15000 }); } catch { /* sin secretos: normal */ }
  };
  for (const f of analisis.archivosClave.slice(0, 6)) await pedir(f.ruta, () => true, () => `${f.origen} (archivo de secreto)`);
  await pedir('/run/secrets', (n) => nombreEsClave(n) || /(key|pfx|p12|jks|cert)/i.test(n), (n) => `secreto ${n}`);
  return encontrados;
}

/**
 * Trae de un contenedor (solo lectura) los archivos de certificados de las rutas candidatas y los lee. Los .jar/.war se
 * abren en memoria para sacar el keystore que llevan dentro (Spring «classpath:»).
 * @param {object} deps  { descargar } para poder probarlo sin Portainer (por defecto, el real)
 */
async function leerArchivosDelContenedor(endpointId, containerId, inspect, { profundo, rutasExtra, clavesExtra }, deps = {}) {
  const descargar = deps.descargar || portainer.descargarArchivoContenedor;
  const analisis = puroAnalizarConfiguracion(inspect);
  const rutas = puroRutasCandidatas(inspect, { profundo, rutasExtra });
  const secretos = await leerSecretosDelContenedor(descargar, endpointId, containerId, analisis);
  const clavesO = puroClavesConOrigen(inspect, { clavesExtra, secretos });
  const claves = clavesO.map((c) => c.valor);
  const archivos = [];
  const errores = [];
  const vistos = new Set();
  const candidatas = [];
  let consultadas = 0;
  let truncadas = 0;
  let ignorados = 0;
  let jarsLeidos = 0;
  let jarsOmitidos = 0;

  const procesar = (completa, datos) => {
    if (archivos.length >= MAX_ARCHIVOS_POR_CONTENEDOR) return;
    const r = leerArchivoCertificados(completa, datos, claves);
    if (!r.certificados.length && !r.protegido && !(r.error && r.formato !== '?')) { ignorados += 1; return; }
    let certificados = r.certificados;
    let bundle = false;
    if (certificados.length > 25) { certificados = certificados.filter((c) => !c.info.esCA); bundle = true; }
    let claveOrigen = null;
    if (r.formato === 'PFX' && certificados.length) {
      if (r.claveIndice >= 0 && clavesO[r.claveIndice]) claveOrigen = clavesO[r.claveIndice].origen;
      else if (!r.claveUsada) claveOrigen = 'sin contraseña';
    }
    archivos.push({
      ruta: completa, formato: r.formato, tieneLlave: r.tieneLlave, protegido: r.protegido, error: r.error, bundle, claveOrigen,
      certificados: certificados.map((c) => ({ info: c.info, alias: c.nombre || null, hoja: !!c.hoja })),
    });
  };

  for (const cand of rutas) {
    if (archivos.length >= MAX_ARCHIVOS_POR_CONTENEDOR) break;
    const base = posix.dirname(cand.ruta);
    let reservado = 0;
    const lector = new LectorTar({
      maxEntradas: MAX_ENTRADAS_TAR,
      quiere: ({ nombre, tamano }) => {
        const completa = posix.join(base, nombre.replace(/^\.\//, ''));
        if (vistos.has(completa) || ARCHIVO_EXCLUIDO.test(completa) || tamano <= 0) return false;
        if (nombreInteresa(nombre) && tamano <= MAX_ARCHIVO_BYTES && !ARCHIVO_DE_LLAVE.test(completa)) return true;
        if (EXT_JAR.test(nombre) && !JAR_EXCLUIDO.test(completa)) {
          if (tamano > MAX_JAR_BYTES || jarEnMemoria + tamano > MAX_JAR_MEMORIA) { jarsOmitidos += 1; return false; }
          jarEnMemoria += tamano; reservado += tamano;
          return true;
        }
        return false;
      },
      alArchivo: ({ nombre }, datos) => {
        const completa = posix.join(base, nombre.replace(/^\.\//, ''));
        vistos.add(completa);
        if (EXT_JAR.test(nombre) && !nombreInteresa(nombre)) {
          jarsLeidos += 1;
          const z = leerZip(datos, {
            maxBytesEntrada: MAX_ARCHIVO_BYTES,
            quiere: (n) => nombreInteresa(n) && !/^META-INF\//i.test(n) && !ARCHIVO_DE_LLAVE.test(`/${n}`),
          });
          for (const e of z.entradas) procesar(`${completa}!/${e.nombre}`, e.datos);
          return;
        }
        procesar(completa, datos);
      },
    });
    consultadas += 1;
    const estado = { ruta: cand.ruta, tipo: cand.tipo, origen: cand.origen, existe: null, truncado: false };
    candidatas.push(estado);
    try {
      const r = await descargar(endpointId, containerId, cand.ruta, {
        maxBytes: cand.max,
        totalMs: 180000,
        alTrozo: (trozo) => lector.escribir(trozo),
      });
      estado.existe = r.existe !== false;
      estado.truncado = !!(r.truncado || lector.excedido);
      if (estado.truncado) truncadas += 1;
    } catch (e) {
      if (errores.length < 5) errores.push(`${cand.ruta}: ${e.message}`);
      if (e.status === 401 || e.status === 403) break; // sin permiso: no tiene caso seguir con este contenedor
    } finally {
      jarEnMemoria = Math.max(0, jarEnMemoria - reservado);
    }
  }
  const referencias = puroEstadoReferencias(analisis.referencias, archivos, candidatas);
  const usadas = new Set(archivos.map((a) => a.claveOrigen).filter(Boolean));
  return {
    archivos, errores, consultadas, truncadas, ignorados, jarsLeidos, jarsOmitidos, clavesProbadas: claves.length,
    candidatas, analisis: { imagen: analisis.imagen, workdir: analisis.workdir, usaTls: analisis.usaTls, montajes: analisis.montajes.slice(0, 30) },
    referencias,
    claves: clavesO.map((c) => ({ origen: c.origen, abrio: usadas.has(c.origen) })),
  };
}

// ---------------------------------------------------------------- sondeo TLS
function sondearTls({ host, puerto, servername, timeoutMs = TIEMPO_SONDEO_MS }) {
  return new Promise((resolve) => {
    let listo = false;
    let sock;
    const fin = (v) => { if (listo) return; listo = true; try { if (sock) sock.destroy(); } catch { /* nada */ } resolve(v); };
    const opciones = { host, port: puerto, rejectUnauthorized: false, timeout: timeoutMs };
    if (servername && !net.isIP(servername)) opciones.servername = servername;
    try {
      sock = tls.connect(opciones, () => {
        try {
          const c = sock.getPeerCertificate(false);
          const info = c && c.raw ? infoCertificado(c.raw) : null;
          fin(info ? { info, protocolo: sock.getProtocol() } : null);
        } catch { fin(null); }
      });
    } catch { return resolve(null); }
    sock.on('error', () => fin(null));
    sock.on('timeout', () => fin(null));
    return undefined;
  });
}

// ---------------------------------------------------------------- hallazgos (puro)
const claveServidor = (e) => (e.servidorId ? `s${e.servidorId}` : `e${e.entornoId}`);

/** Junta las evidencias en «certificado X en servidor Y» (una fila por servidor + certificado). */
function puroAgruparHallazgos(evidencias) {
  const mapa = new Map();
  for (const ev of evidencias) {
    const clave = `${claveServidor(ev)}|${ev.cert.sha256}`;
    if (!mapa.has(clave)) {
      mapa.set(clave, {
        id: crypto.createHash('sha1').update(clave).digest('hex').slice(0, 12),
        servidor: { id: ev.servidorId || null, hostname: ev.hostname || null, entornoId: ev.entornoId, entornoNombre: ev.entornoNombre, ip: ev.ip || null },
        cert: ev.cert,
        evidencias: [],
      });
    }
    const h = mapa.get(clave);
    const repetida = h.evidencias.some((x) => x.origen === ev.origen && x.contenedorId === ev.contenedorId && x.puerto === ev.puerto && x.ruta === ev.ruta);
    if (!repetida) {
      h.evidencias.push({
        origen: ev.origen, contenedor: ev.contenedor, contenedorId: ev.contenedorId, imagen: ev.imagen, stack: ev.stack || null,
        puerto: ev.puerto || null, ruta: ev.ruta || null, formato: ev.formato || null, tieneLlave: !!ev.tieneLlave, autoridad: !!ev.autoridad,
        claveOrigen: ev.claveOrigen || null, config: ev.config || null,
      });
    }
  }
  return [...mapa.values()];
}

// ---------------------------------------------------------------- conciliación con el inventario (puro)
const normNombre = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function aDia(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return valor.getHours() === 0 && valor.getMinutes() === 0
      ? `${valor.getFullYear()}-${p(valor.getMonth() + 1)}-${p(valor.getDate())}`
      : valor.toISOString().slice(0, 10);
  }
  const m = String(valor).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

const diasEntre = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

function puroNormalizarFilaInventario(f) {
  return {
    id: f.Id ?? f.id,
    servidorId: f.ServidorId ?? f.servidorId ?? null,
    hostname: f.Hostname ?? f.hostname ?? null,
    componente: f.Componente ?? f.componente ?? null,
    nombreComun: f.NombreComun ?? f.nombreComun ?? null,
    emisor: f.EntidadEmisora ?? f.emisor ?? null,
    serie: aHex(f.NumeroSerie ?? f.serie).replace(/^0+(?=.)/, ''),
    thumbprint: aHex(f.Thumbprint ?? f.thumbprint),
    puerto: f.Puerto ?? f.puerto ?? null,
    desde: aDia(f.FechaInicio ?? f.desde),
    hasta: aDia(f.FechaFin ?? f.hasta),
    responsable: f.Responsable ?? f.responsable ?? null,
  };
}

function puroVigencia(hasta, hoy) {
  const dias = diasEntre(hasta, hoy);
  return { dias, vigencia: dias < 0 ? 'vencido' : dias <= DIAS_POR_VENCER ? 'por_vencer' : 'vigente' };
}

const mismoNombre = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * @param {object[]} hallazgos         de puroAgruparHallazgos()
 * @param {object[]} filasInventario   filas de Certificados (cualquier mayúscula de columnas)
 * @param {object}   o
 * @param {string}   o.hoy             'YYYY-MM-DD'
 * @param {Map<number,{contenedores:{nombre:string,puertos:number[]}[]}>} o.escaneados  servidores del inventario cuyo entorno se escaneó bien
 */
function puroConciliar(hallazgos, filasInventario, { hoy, escaneados = new Map() }) {
  const inventario = filasInventario.map(puroNormalizarFilaInventario);
  const porHuella = new Map();
  const porSerie = new Map();
  const empujar = (m, k, v) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const f of inventario) { empujar(porHuella, f.thumbprint, f); empujar(porSerie, f.serie, f); }
  const usadas = new Set();

  const salida = hallazgos.map((h) => {
    const c = h.cert;
    const puertos = [...new Set(h.evidencias.map((e) => e.puerto).filter(Boolean))].sort((a, b) => a - b);
    const contenedores = [...new Set(h.evidencias.map((e) => e.contenedor))].sort();
    const servidorId = h.servidor.id;

    // 1) Mismo certificado (huella o serie) en el inventario.
    const exactas = new Map();
    for (const f of [...(porHuella.get(c.thumbprint) || []), ...(porHuella.get(c.sha256) || [])]) exactas.set(f.id, f);
    if (c.serie && c.serie.length >= 8) {
      for (const f of porSerie.get(c.serie) || []) {
        if (!f.thumbprint || f.thumbprint === c.thumbprint || f.thumbprint === c.sha256) exactas.set(f.id, f);
      }
    }
    const exactasLista = [...exactas.values()];
    const exactaAqui = exactasLista.find((f) => servidorId && f.servidorId === servidorId);

    // 2) Misma ubicación (servidor + puerto, o nombre común, o componente = contenedor) con otro certificado.
    let enUbicacion = [];
    if (servidorId) {
      enUbicacion = inventario.filter((f) => f.servidorId === servidorId
        && ((f.puerto && puertos.includes(Number(f.puerto)))
          || mismoNombre(f.nombreComun, c.cn)
          || (f.componente && contenedores.some((n) => normNombre(n) === normNombre(f.componente)))));
    }

    let estado;
    let fila = null;
    const diferencias = [];
    let accion = null;
    if (exactaAqui) {
      fila = exactaAqui;
      const difFin = fila.hasta ? Math.abs(diasEntre(c.hasta, fila.hasta)) : null;
      if (difFin === null || difFin > TOLERANCIA_DIAS) {
        estado = 'fechas_distintas';
        diferencias.push(`Vence el ${c.hasta} en el contenedor y ${fila.hasta ? `el ${fila.hasta}` : 'sin fecha'} en el inventario`);
        if (fila.desde && Math.abs(diasEntre(c.desde, fila.desde)) > TOLERANCIA_DIAS) diferencias.push(`Inicia el ${c.desde} en el contenedor y el ${fila.desde} en el inventario`);
        accion = 'actualizar';
      } else {
        estado = 'conciliado';
      }
      usadas.add(fila.id);
    } else if (exactasLista.length) {
      fila = exactasLista[0];
      estado = 'ubicacion_nueva';
      diferencias.push(`El certificado está en el inventario en ${fila.hostname || 'otro servidor'}${fila.componente ? ` (${fila.componente})` : ''}, pero no en este servidor`);
      accion = servidorId ? 'agregar_ubicacion' : null;
      usadas.add(fila.id);
    } else if (enUbicacion.length) {
      fila = enUbicacion[0];
      estado = 'difiere';
      diferencias.push(`En esa ubicación el inventario tiene otro certificado (serie ${fila.serie || '—'}, vence ${fila.hasta || '—'}); el del contenedor tiene serie ${c.serie}, vence ${c.hasta}`);
      accion = 'actualizar';
      for (const f of enUbicacion) usadas.add(f.id);
    } else {
      estado = 'no_inventariado';
      accion = servidorId ? 'crear' : null;
    }

    const v = puroVigencia(c.hasta, hoy);
    const tlsEv = h.evidencias.find((e) => e.origen === 'puerto');
    const archEv = h.evidencias.find((e) => e.origen === 'archivo');
    const nombreContenedor = (tlsEv || archEv || {}).contenedor || null;
    const obs = [
      `Detectado en ${contenedores.length > 1 ? `los contenedores ${contenedores.join(', ')}` : `el contenedor ${contenedores[0]}`}`,
      puertos.length ? `puerto${puertos.length > 1 ? 's' : ''} TLS ${puertos.join(', ')}` : null,
      archEv && archEv.ruta ? `archivo ${archEv.ruta}` : null,
      c.san && c.san.length ? `SAN: ${c.san.slice(0, 6).join(', ')}${c.san.length > 6 ? '…' : ''}` : null,
    ].filter(Boolean).join(' · ');

    return {
      id: h.id,
      estado,
      accion,
      vigencia: v.vigencia,
      dias: v.dias,
      servidor: h.servidor,
      servidorInventariado: !!servidorId,
      certificado: {
        nombreComun: c.cn, emisor: c.emisorCn, emisorCompleto: c.emisor, sujeto: c.sujeto, serie: c.serie, thumbprint: c.thumbprint, sha256: c.sha256,
        desde: c.desde, hasta: c.hasta, san: c.san || [], algoritmo: c.algoritmo, esCA: c.esCA, autofirmado: c.autofirmado,
        esAutoridad: h.evidencias.every((e) => e.autoridad),
      },
      evidencias: h.evidencias,
      puertos,
      contenedores,
      componenteSugerido: nombreContenedor,
      puertoSugerido: puertos.length ? puertos[0] : null,
      observacionesSugeridas: obs.slice(0, 500),
      inventario: fila ? { ...fila } : null,
      diferencias,
    };
  });

  // Inventario SIN evidencia: solo filas de servidores que SÍ se escanearon y que parecen ser de un contenedor
  // (el componente se llama como un contenedor, o el puerto es uno que un contenedor publica).
  const sinEvidencia = [];
  for (const f of inventario) {
    if (usadas.has(f.id) || !f.servidorId || !escaneados.has(f.servidorId)) continue;
    const { contenedores } = escaneados.get(f.servidorId);
    const nombre = normNombre(f.componente);
    const coincide = contenedores.find((ct) => (nombre && normNombre(ct.nombre) === nombre) || (f.puerto && ct.puertos.includes(Number(f.puerto))));
    if (!coincide) continue;
    const v = f.hasta ? puroVigencia(f.hasta, hoy) : { dias: null, vigencia: null };
    sinEvidencia.push({ ...f, contenedor: coincide.nombre, vigencia: v.vigencia, dias: v.dias });
  }

  const nuevosServidores = salida.filter((h) => !h.certificado.esAutoridad);
  const cuenta = (fn) => nuevosServidores.filter(fn).length;
  const resumen = {
    certificados: nuevosServidores.length,
    autoridades: salida.length - nuevosServidores.length,
    conciliado: cuenta((h) => h.estado === 'conciliado'),
    fechas_distintas: cuenta((h) => h.estado === 'fechas_distintas'),
    difiere: cuenta((h) => h.estado === 'difiere'),
    ubicacion_nueva: cuenta((h) => h.estado === 'ubicacion_nueva'),
    no_inventariado: cuenta((h) => h.estado === 'no_inventariado'),
    sinEvidencia: sinEvidencia.length,
    vencidos: cuenta((h) => h.vigencia === 'vencido'),
    porVencer: cuenta((h) => h.vigencia === 'por_vencer'),
    vigentes: cuenta((h) => h.vigencia === 'vigente'),
  };
  return { hallazgos: salida, sinEvidencia, resumen };
}

// ================================================================ ESCANEO (trabajo en segundo plano)
// Un solo escaneo a la vez. El resultado crudo (qué certificados hay en cada servidor) queda en memoria; la
// conciliación contra el inventario se calcula cada vez que se consulta, así que al crear o corregir un certificado
// en el inventario basta con refrescar: no hace falta volver a escanear.

let trabajo = null;     // escaneo en curso o el último terminado
let ultimo = null;      // resultado crudo del último escaneo terminado

function snapshotTrabajo() {
  if (!trabajo) return { estado: 'nunca', progreso: null };
  return {
    id: trabajo.id,
    estado: trabajo.estado,
    inicio: trabajo.inicio,
    fin: trabajo.fin || null,
    opciones: trabajo.opciones,
    progreso: { ...trabajo.progreso },
    error: trabajo.error || null,
  };
}

function limpiarOpciones(o = {}) {
  const rutasExtra = (Array.isArray(o.rutas) ? o.rutas : String(o.rutas || '').split(/[\n,;]+/))
    .map((r) => String(r).trim()).filter(puroRutaValida).slice(0, 20);
  const clavesExtra = (Array.isArray(o.claves) ? o.claves : String(o.claves || '').split(/\r?\n/))
    .map((c) => String(c)).filter((c) => c && c.length <= 128).slice(0, MAX_CLAVES);
  const entornoIds = (Array.isArray(o.entornoIds) ? o.entornoIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return {
    profundo: !!o.profundo,
    incluirDetenidos: !!o.incluirDetenidos,
    sondeoTls: o.sondeoTls !== false,
    archivos: o.archivos !== false,
    rutasExtra, clavesExtra, entornoIds,
  };
}

async function escanearEntorno(entorno, servidor, op, ctx) {
  const resumen = {
    id: entorno.id, nombre: entorno.nombre, ip: entorno.ip || (servidor && servidor.ip) || null,
    hostname: servidor ? servidor.hostname : null, servidorId: servidor ? servidor.id : null,
    ok: entorno.ok, error: entorno.error || null,
    contenedores: 0, escaneados: 0, archivosLeidos: 0, rutasConsultadas: 0, rutasTruncadas: 0, clavesProbadas: 0,
    puertosSondeados: 0, puertosConTls: 0, jarsLeidos: 0, avisos: [],
    contenedoresInfo: [],
  };
  if (!entorno.ok) return { resumen, evidencias: [], noLegibles: [], configuraciones: [] };

  const todos = entorno.todos || [];
  resumen.contenedores = todos.length;
  resumen.contenedoresInfo = todos.map((c) => ({ nombre: c.nombre, puertos: c.puertos.map((p) => p.puerto) }));
  const base = {
    entornoId: entorno.id, entornoNombre: entorno.nombre, servidorId: servidor ? servidor.id : null,
    hostname: servidor ? servidor.hostname : null, ip: resumen.ip,
  };
  const evidencias = [];
  const noLegibles = [];
  const configuraciones = [];
  const elegibles = todos.filter((c) => op.incluirDetenidos || c.estado === 'running' || c.estado === 'paused' || c.estado === 'restarting');
  ctx.progreso.contenedoresTotal += elegibles.length;

  // ---- 1) Sondeo TLS de los puertos publicados
  if (op.sondeoTls) {
    const host = resumen.ip;
    const objetivos = new Map();
    for (const c of elegibles) {
      if (c.estado !== 'running') continue;
      for (const p of c.puertos) {
        if (p.reservado || String(p.protocolo).toUpperCase() !== 'TCP' || p.alcance === 'local') continue;
        if (!objetivos.has(p.puerto)) objetivos.set(p.puerto, []);
        objetivos.get(p.puerto).push(c);
      }
    }
    if (!host) {
      if (objetivos.size) resumen.avisos.push('No se conoce la IP del servidor: no se sondearon los puertos TLS.');
    } else {
      let lista = [...objetivos.entries()];
      if (lista.length > MAX_PUERTOS_SONDEO_POR_ENTORNO) {
        resumen.avisos.push(`Solo se sondearon ${MAX_PUERTOS_SONDEO_POR_ENTORNO} de ${lista.length} puertos.`);
        lista = lista.slice(0, MAX_PUERTOS_SONDEO_POR_ENTORNO);
      }
      resumen.puertosSondeados = lista.length;
      ctx.progreso.fase = `Sondeando puertos TLS de ${entorno.nombre}`;
      const sondeo = ctx.sondear || sondearTls;
      await enLotes(lista, SIMULTANEOS_SONDEOS, async ([puerto, cts]) => {
        if (ctx.cancelado()) return;
        const r = await sondeo({ host, puerto, servername: servidor ? servidor.hostname : entorno.nombre });
        if (!r) return;
        resumen.puertosConTls += 1;
        for (const c of cts) {
          evidencias.push({ ...base, origen: 'puerto', contenedor: c.nombre, contenedorId: c.id, imagen: c.imagen, stack: c.stack, puerto, ruta: null, formato: null, tieneLlave: false, cert: r.info });
        }
      });
    }
  }

  // ---- 2) Archivos dentro de los contenedores
  if (op.archivos) {
    await enLotes(elegibles, SIMULTANEOS_CONTENEDORES, async (c) => {
      if (ctx.cancelado()) return;
      ctx.progreso.fase = `Leyendo archivos de ${entorno.nombre} · ${c.nombre}`;
      try {
        const inspect = await portainer.peticionAutenticada(`/api/endpoints/${entorno.id}/docker/containers/${c.id}/json`);
        const r = await (ctx.leerArchivos || leerArchivosDelContenedor)(entorno.id, c.id, inspect, { profundo: op.profundo, rutasExtra: op.rutasExtra, clavesExtra: ctx.clavesExtra });
        r.referencias = r.referencias || [];
        // El «docker run» equivalente (secretos enmascarados). La imagen se consulta una sola vez por servidor (solo lectura).
        let imagenInspect = null;
        if (inspect && inspect.Image) {
          ctx.imagenes = ctx.imagenes || new Map();
          const k = `${entorno.id}|${inspect.Image}`;
          if (!ctx.imagenes.has(k)) ctx.imagenes.set(k, Promise.resolve().then(() => portainer.peticionAutenticada(`/api/endpoints/${entorno.id}/docker/images/${encodeURIComponent(inspect.Image)}/json`)).catch(() => null));
          const im = await ctx.imagenes.get(k);
          imagenInspect = im && im.Config ? im : null;
        }
        let comando = '';
        try { comando = puroComandoDockerRun(inspect, imagenInspect); } catch { comando = ''; }
        if (comando.length > 8000) comando = `${comando.slice(0, 8000)}…`;
        resumen.jarsLeidos += r.jarsLeidos || 0;
        const analisisR = r.analisis || {};
        configuraciones.push({
          ...base, contenedor: c.nombre, contenedorId: c.id, imagen: c.imagen, estado: c.estado, stack: c.stack || null,
          workdir: analisisR.workdir || '', usaTls: !!analisisR.usaTls, comando,
          referencias: r.referencias, claves: r.claves || [], montajes: analisisR.montajes || [],
          archivos: r.archivos.length, certificados: r.archivos.reduce((n, a) => n + a.certificados.length, 0),
          jars: r.jarsLeidos || 0, jarsOmitidos: r.jarsOmitidos || 0, lecturaParcial: (r.truncadas || 0) > 0,
          rutasConsultadas: (r.candidatas || []).filter((x) => x.existe).map((x) => x.ruta).slice(0, 30),
        });
        resumen.escaneados += 1;
        resumen.rutasConsultadas += r.consultadas;
        resumen.rutasTruncadas += r.truncadas;
        resumen.clavesProbadas = Math.max(resumen.clavesProbadas, r.clavesProbadas);
        resumen.archivosLeidos += r.archivos.length;
        if (r.errores.length && resumen.avisos.length < 5) resumen.avisos.push(`${c.nombre}: ${r.errores[0]}`);
        for (const a of r.archivos) {
          if (a.protegido || (a.error && !a.certificados.length)) {
            noLegibles.push({
              entornoId: entorno.id, entornoNombre: entorno.nombre, servidorId: base.servidorId, hostname: base.hostname,
              contenedor: c.nombre, contenedorId: c.id, imagen: c.imagen, ruta: a.ruta, formato: a.formato,
              motivo: a.protegido
                ? `Protegido: no lo abrió ninguna de las ${r.clavesProbadas || 0} contraseñas probadas (vacía, las de la configuración del contenedor y las indicadas).`
                : a.error,
            });
          }
          const hayDeServidor = a.certificados.some((x) => x.hoja || !x.info.esCA);
          const nombreSugiereCa = /(^|[/_.-])(ca|root|chain|bundle|intermedi|trust|cacert)/i.test(a.ruta);
          for (const ce of a.certificados) {
            // «Autoridad»: certificado de CA que acompaña a otro (cadena) o que está en un archivo con nombre de CA/trust.
            // Un certificado autofirmado suelto (CA:true por defecto en muchos openssl) se trata como del servidor.
            const autoridad = ce.info.esCA && !ce.hoja && (hayDeServidor || nombreSugiereCa);
            const ref = r.referencias.find((x) => (x.tipo === 'archivo' ? (a.ruta === x.ruta || a.ruta.startsWith(`${x.ruta}!/`)) : x.tipo === 'classpath' ? a.ruta.endsWith(`/${x.ruta}`) : a.ruta.startsWith(`${x.ruta}/`)));
            evidencias.push({ ...base, autoridad, claveOrigen: a.claveOrigen || null, config: ref ? ref.origen : null, origen: 'archivo', contenedor: c.nombre, contenedorId: c.id, imagen: c.imagen, stack: c.stack, puerto: null, ruta: a.ruta, formato: a.formato, tieneLlave: a.formato === 'PFX' || a.formato === 'JKS' ? !!(ce.hoja || a.tieneLlave) : a.tieneLlave, cert: ce.info });
          }
        }
      } catch (e) {
        if (resumen.avisos.length < 5) resumen.avisos.push(`${c.nombre}: ${e.message}`);
      } finally {
        ctx.progreso.contenedoresHechos += 1;
      }
    });
  } else {
    ctx.progreso.contenedoresHechos += elegibles.length;
  }
  return { resumen, evidencias, noLegibles, configuraciones };
}

/**
 * Lanza el escaneo en segundo plano y devuelve de inmediato su estado.
 * Las contraseñas (opciones.claves) solo se usan dentro de esta llamada: no se guardan en el estado ni en el resultado.
 */
async function iniciarEscaneo(pool, opcionesCrudas = {}, deps = {}) {
  if (!portainer.PORTAINER_CONFIGURADO && !deps.consultarEntornos) throw Object.assign(new Error('Portainer no está configurado en el backend.'), { codigo: 400 });
  if (trabajo && trabajo.estado === 'corriendo') return { yaEnCurso: true, ...snapshotTrabajo() };

  const op = limpiarOpciones(opcionesCrudas);
  let claves = op.clavesExtra;
  const publicas = { profundo: op.profundo, incluirDetenidos: op.incluirDetenidos, sondeoTls: op.sondeoTls, archivos: op.archivos, rutasExtra: op.rutasExtra, clavesExtra: op.clavesExtra.length, entornoIds: op.entornoIds };
  const opSinClaves = { ...op, clavesExtra: [] };
  const t = {
    id: crypto.randomBytes(6).toString('hex'), estado: 'corriendo', inicio: new Date().toISOString(), fin: null,
    opciones: publicas, error: null, cancelar: false,
    progreso: { fase: 'Consultando Portainer', entornosTotal: 0, entornosHechos: 0, contenedoresTotal: 0, contenedoresHechos: 0 },
  };
  trabajo = t;

  const ctx = {
    progreso: t.progreso,
    cancelado: () => t.cancelar || Date.now() - Date.parse(t.inicio) > MAX_DURACION_MS,
    clavesExtra: claves,
    sondear: deps.sondear, leerArchivos: deps.leerArchivos,
  };

  (async () => {
    try {
      const datos = await (deps.consultarEntornos || consultarEntornos)({ forzar: true });
      let servidores = [];
      try { [servidores] = await pool.query('SELECT Id AS id, Hostname AS hostname, IP AS ip, Ambiente AS ambiente FROM Servidores'); } catch (e) { console.warn(`Certificados/Portainer: no se pudo leer Servidores: ${e.message}`); }
      let entornos = datos.entornos || [];
      if (op.entornoIds.length) entornos = entornos.filter((e) => op.entornoIds.includes(e.id));
      const pares = puroEmparejar(entornos, servidores);
      t.progreso.entornosTotal = pares.length;

      const evidencias = [];
      const noLegibles = [];
      const configuraciones = [];
      const resumenes = [];
      for (const { entorno, servidor } of pares) {
        if (ctx.cancelado()) break;
        const r = await escanearEntorno(entorno, servidor, opSinClaves, ctx);
        evidencias.push(...r.evidencias);
        noLegibles.push(...r.noLegibles);
        configuraciones.push(...(r.configuraciones || []));
        resumenes.push(r.resumen);
        t.progreso.entornosHechos += 1;
      }
      t.estado = t.cancelar ? 'cancelado' : 'terminado';
      t.fin = new Date().toISOString();
      t.progreso.fase = t.cancelar ? 'Cancelado' : 'Terminado';
      ultimo = { id: t.id, inicio: t.inicio, fin: t.fin, opciones: publicas, estadoFinal: t.estado, entornos: resumenes, evidencias, noLegibles, configuraciones, consultadoEn: datos.consultadoEn || null };
    } catch (e) {
      t.estado = 'error';
      t.error = e.message || 'No se pudo completar el escaneo.';
      t.fin = new Date().toISOString();
      console.error(`Certificados/Portainer: escaneo fallido: ${t.error}`);
    } finally {
      claves = null; ctx.clavesExtra = null; // las contraseñas no sobreviven al escaneo
    }
  })();

  return { yaEnCurso: false, ...snapshotTrabajo() };
}

function cancelarEscaneo() {
  if (trabajo && trabajo.estado === 'corriendo') { trabajo.cancelar = true; return true; }
  return false;
}

const SQL_INVENTARIO = `SELECT c.Id, c.ServidorId, c.Componente, c.NombreComun, c.EntidadEmisora, c.NumeroSerie, c.Thumbprint,
       c.Puerto, c.FechaInicio, c.FechaFin, c.Responsable, s.Hostname
  FROM Certificados c LEFT JOIN Servidores s ON s.Id = c.ServidorId
 WHERE c.Activo = 1`;

/** Conciliación del último escaneo contra el inventario VIGENTE (se recalcula en cada consulta). */
async function resultadoConciliado(pool, { hoy = new Date().toISOString().slice(0, 10) } = {}) {
  if (!ultimo) return { disponible: false };
  const filas = (await pool.query(SQL_INVENTARIO))[0];
  const escaneados = new Map();
  for (const e of ultimo.entornos) {
    if (e.ok && e.servidorId && e.escaneados > 0) escaneados.set(e.servidorId, { contenedores: e.contenedoresInfo });
  }
  const hallazgos = puroAgruparHallazgos(ultimo.evidencias);
  const c = puroConciliar(hallazgos, filas, { hoy, escaneados });
  return {
    disponible: true,
    escaneo: {
      id: ultimo.id, inicio: ultimo.inicio, fin: ultimo.fin, estadoFinal: ultimo.estadoFinal, opciones: ultimo.opciones,
      entornos: ultimo.entornos.map(({ contenedoresInfo, ...resto }) => resto),
    },
    resumen: { ...c.resumen, noLegibles: ultimo.noLegibles.length, ...puroResumenConfiguraciones(ultimo.configuraciones || []) },
    hallazgos: c.hallazgos,
    sinEvidencia: c.sinEvidencia,
    noLegibles: ultimo.noLegibles,
    configuraciones: ultimo.configuraciones || [],
  };
}

function puroResumenConfiguraciones(cfgs) {
  const conRef = cfgs.filter((c) => c.referencias.length);
  return {
    cfgContenedores: cfgs.length,
    cfgConReferencias: conRef.length,
    cfgSinArchivo: cfgs.filter((c) => c.referencias.some((r) => ['no_existe', 'no_encontrado', 'no_leido'].includes(r.estado))).length,
    cfgProtegidos: cfgs.filter((c) => c.referencias.some((r) => r.estado === 'protegido')).length,
    cfgTlsSinCertificado: cfgs.filter((c) => c.usaTls && c.certificados === 0).length,
  };
}

function olvidarEscaneo() { trabajo = null; ultimo = null; }

module.exports = {
  iniciarEscaneo, cancelarEscaneo, estadoEscaneo: snapshotTrabajo, resultadoConciliado, olvidarEscaneo,
  _prueba: {
    puroRutasCandidatas, puroClavesDelContenedor, puroRutasEnTexto, puroAgruparHallazgos, puroConciliar, puroNormalizarFilaInventario,
    leerArchivosDelContenedor, puroClavesConOrigen, puroEstadoReferencias, puroResumenConfiguraciones, sondearTls, limpiarOpciones, aDia, escanearEntorno, ARCHIVO_EXCLUIDO, ARCHIVO_DE_LLAVE,
  },
};
