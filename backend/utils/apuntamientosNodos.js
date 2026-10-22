// Validación automática de apuntamientos contra los NODOS (servidores donde
// corre cada aplicación).
//
// Qué hace, una vez al día (y a demanda desde la pantalla "Validación de nodos"):
//   1. LEE (solo lectura) el archivo de configuración del nodo: por SSH en
//      servidores Linux (misma llave/usuario que el monitoreo: SSH_USERNAME /
//      SSH_KEY_PATH / SSH_PORT) o por carpeta compartida SMB en servidores
//      Windows (ruta \\host\recurso\...; SMB_USERNAME / SMB_PASSWORD).
//   2. Interpreta cada entrada "CLAVE = URL" (ej. C004_AccountListInq =
//      https://...falaappbusibmbal.finandina.corp:7843/services/...). El código
//      del servicio sale de la clave (C004) y la categoría (ACE o Bus de
//      Integración 10) sale del host de la URL — mismas reglas que se usaron
//      en la carga inicial del nodo 109.
//   3. Compara contra la bitácora (tabla Apuntamientos) de esa aplicación /
//      componente y clasifica las diferencias:
//        FALTANTE     está en el archivo del nodo y NO en la bitácora
//        SOBRANTE     está en la bitácora y NO en el archivo del nodo
//        SIN_SERVICIO el código no existe (o es ambiguo) en AceServiciosInventario
//        SIN_CATEGORIA la URL no coincide con ningún patrón ACE / Bus 10
//   4. Si el nodo tiene "Corregir automáticamente", agrega los FALTANTES (solo
//      altas: NUNCA borra ni modifica apuntamientos existentes) y deja una fila
//      ALTA en ApuntamientosHistorico por cada uno, con el usuario
//      "validacion-automatica". Los SOBRANTES solo se reportan.
//   5. Guarda el resultado de cada corrida (resumen + detalle) para consulta.
//
// Esquema: igual que el resto de módulos, primero se consulta information_schema
// y el DDL solo se intenta si falta algo; si el usuario de BD no tiene
// privilegios, se pide correr crear_tablas_validacion_nodos.sql una vez.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Client } = require('ssh2');
const { getPool } = require('../db');
const { esErrorDePrivilegios, tablaExiste, errorFaltaEsquema } = require('./esquemaSeguro');

const USUARIO_AUTOMATICO = 'validacion-automatica';
const MAX_BYTES_ARCHIVO = 2 * 1024 * 1024;
const PATRON_ACE_DEFECTO = 'cp4i-ace';
const PATRON_BUS_DEFECTO = 'busibm,:7843';

// ------------------------------------------------------------------
// Esquema
// ------------------------------------------------------------------
const DDL = [
  `CREATE TABLE IF NOT EXISTS ApuntamientosNodos (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    Nombre VARCHAR(100) NOT NULL,
    Host VARCHAR(150) NOT NULL,
    PuertoSsh INT NULL,
    UsuarioSsh VARCHAR(60) NULL,
    RutaArchivo VARCHAR(300) NOT NULL,
    AplicacionId INT NOT NULL,
    Componente VARCHAR(150) NULL,
    PatronAce VARCHAR(300) NOT NULL DEFAULT '${PATRON_ACE_DEFECTO}',
    PatronBus VARCHAR(300) NOT NULL DEFAULT '${PATRON_BUS_DEFECTO}',
    Activo TINYINT(1) NOT NULL DEFAULT 1,
    CorregirAuto TINYINT(1) NOT NULL DEFAULT 0,
    UltimaValidacion DATETIME NULL,
    UltimoEstado VARCHAR(20) NULL,
    FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_nodos_aplicacion (AplicacionId)
  )`,
  `CREATE TABLE IF NOT EXISTS ApuntamientosValidaciones (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    NodoId INT NOT NULL,
    Origen VARCHAR(10) NOT NULL,
    Modo VARCHAR(12) NOT NULL,
    Estado VARCHAR(20) NOT NULL,
    TotalConfig INT NOT NULL DEFAULT 0,
    TotalBitacora INT NOT NULL DEFAULT 0,
    Faltantes INT NOT NULL DEFAULT 0,
    Sobrantes INT NOT NULL DEFAULT 0,
    SinServicio INT NOT NULL DEFAULT 0,
    Corregidos INT NOT NULL DEFAULT 0,
    Mensaje VARCHAR(500) NULL,
    Usuario VARCHAR(100) NULL,
    DiaLocal DATE NULL,
    Fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_validaciones_nodo (NodoId, Fecha),
    KEY idx_validaciones_dia (NodoId, Origen, DiaLocal),
    CONSTRAINT fk_validaciones_nodo FOREIGN KEY (NodoId) REFERENCES ApuntamientosNodos(Id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS ApuntamientosValidacionDetalle (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    ValidacionId INT NOT NULL,
    Tipo VARCHAR(20) NOT NULL,
    Clave VARCHAR(150) NULL,
    Codigo VARCHAR(20) NULL,
    Categoria VARCHAR(20) NULL,
    Url VARCHAR(500) NULL,
    ApuntamientoId INT NULL,
    ServicioInventarioId INT NULL,
    Detalle VARCHAR(500) NULL,
    KEY idx_validacion_detalle (ValidacionId),
    CONSTRAINT fk_validacion_detalle FOREIGN KEY (ValidacionId) REFERENCES ApuntamientosValidaciones(Id) ON DELETE CASCADE
  )`,
];
const TABLAS = ['ApuntamientosNodos', 'ApuntamientosValidaciones', 'ApuntamientosValidacionDetalle'];

let esquemaListo = false;
let esquemaFallaHasta = 0;
let esquemaError = null;

// Devuelve null si todo está listo; si no, un Error con mensaje accionable.
async function garantizarEsquemaNodos(pool) {
  if (esquemaListo) return null;
  if (Date.now() < esquemaFallaHasta && esquemaError) return esquemaError;

  const faltan = [];
  for (const t of TABLAS) if (!(await tablaExiste(pool, t))) faltan.push(t);
  if (!faltan.length) { esquemaListo = true; esquemaError = null; return null; }

  try {
    for (const sentencia of DDL) await pool.query(sentencia);
    esquemaListo = true;
    esquemaError = null;
    return null;
  } catch (err) {
    if (!esErrorDePrivilegios(err)) throw err;
    esquemaError = errorFaltaEsquema(`faltan las tablas ${faltan.join(', ')}`, err);
    esquemaError.message = esquemaError.message.replace(
      'migracion_esquema_sin_privilegios.sql',
      'crear_tablas_validacion_nodos.sql'
    );
    esquemaFallaHasta = Date.now() + 30000;
    return esquemaError;
  }
}

// ------------------------------------------------------------------
// Lectura remota por SSH (solo `cat` del archivo configurado)
// ------------------------------------------------------------------
let llave = null;
function obtenerLlave() {
  if (!llave && process.env.SSH_KEY_PATH) llave = fs.readFileSync(process.env.SSH_KEY_PATH);
  return llave;
}

const RUTA_VALIDA = /^\/[A-Za-z0-9_\-./ ]+$/;
// Windows por carpeta compartida: \\host\recurso\carpeta\archivo (o con "/").
// El nombre del recurso puede llevar espacios (ej. "gerencia de tecnologia").
const RUTA_SMB = /^(?:\\\\|\/\/)([A-Za-z0-9_.\-]+)[\\/]([A-Za-z0-9_.\-$ ]+)[\\/](.+)$/;
// Carpetas y archivos: letras (con acentos), números, espacios y signos comunes.
// Quedan fuera comillas dobles y ";" (separan comandos de smbclient) y "..".
const ARCHIVO_SMB_VALIDO = /^[\p{L}\p{N} _\-.()&,+#@\[\]~'$\\/]+$/u;

// Carpeta compartida donde se dejan los archivos de configuración (ecosystem,
// appsettings, etc.). Se puede cambiar con NODOS_CARPETA_COMPARTIDA.
const CARPETA_COMPARTIDA_DEFECTO =
  '\\\\192.168.60.149\\gerencia de tecnologia\\DIRECCION DE OPERACIONES TI\\SOPORTE APLICACIONES\\JEISON_INFO\\ARCHIVOS';

function esRutaSmb(ruta) {
  return typeof ruta === 'string' && /^(?:\\\\|\/\/)/.test(ruta);
}

function parsearRutaSmb(ruta) {
  const m = typeof ruta === 'string' ? ruta.match(RUTA_SMB) : null;
  if (!m) return null;
  const archivo = m[3].replace(/\//g, '\\');
  if (!ARCHIVO_SMB_VALIDO.test(archivo) || archivo.includes('..') || archivo.endsWith('\\')) return null;
  return { host: m[1], recurso: m[2], archivo };
}

function validarRutaArchivo(ruta) {
  if (esRutaSmb(ruta)) {
    return parsearRutaSmb(ruta)
      ? null
      : 'La ruta de carpeta compartida debe ser como \\\\10.254.55.108\\c$\\Apps\\config\\env_production (sin "..", comillas ni ";").';
  }
  if (typeof ruta !== 'string' || !RUTA_VALIDA.test(ruta) || ruta.includes('..') || ruta.endsWith('/')) {
    return 'La ruta debe ser absoluta en Linux (ej. /opt/app/env_production) o de carpeta compartida en Windows (ej. \\\\10.254.55.108\\c$\\Apps\\env_production).';
  }
  return null;
}

function leerArchivoSsh(nodo, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const usuario = nodo.UsuarioSsh || process.env.SSH_USERNAME;
    if (!usuario || !process.env.SSH_KEY_PATH) {
      return reject(new Error('SSH_USERNAME / SSH_KEY_PATH no están configurados en el backend.'));
    }
    const errRuta = validarRutaArchivo(nodo.RutaArchivo);
    if (errRuta) return reject(new Error(errRuta));

    let privateKey;
    try { privateKey = obtenerLlave(); } catch (e) { return reject(new Error(`No se pudo leer la llave SSH: ${e.message}`)); }

    const conn = new Client();
    let terminado = false;
    const fin = (fn, valor) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(temporizador);
      try { conn.end(); } catch (_) { /* nada */ }
      fn(valor);
    };
    const temporizador = setTimeout(() => fin(reject, new Error('Timeout conectando por SSH o leyendo el archivo')), timeoutMs);

    conn
      .on('ready', () => {
        const comando = `head -c ${MAX_BYTES_ARCHIVO + 1} '${nodo.RutaArchivo}'`;
        conn.exec(comando, (err, stream) => {
          if (err) return fin(reject, err);
          const trozos = [];
          let bytes = 0;
          let stderr = '';
          stream
            .on('data', (d) => { bytes += d.length; if (bytes <= MAX_BYTES_ARCHIVO + 1) trozos.push(d); })
            .on('close', (codigo) => {
              if (codigo && codigo !== 0) {
                return fin(reject, new Error(stderr.trim() || `No se pudo leer el archivo (código ${codigo})`));
              }
              if (bytes > MAX_BYTES_ARCHIVO) return fin(reject, new Error('El archivo supera los 2 MB; no parece un archivo de configuración.'));
              fin(resolve, Buffer.concat(trozos).toString('utf8'));
            })
            .stderr.on('data', (d) => { stderr += d.toString(); });
        });
      })
      .on('error', (err) => fin(reject, err))
      .connect({
        host: nodo.Host,
        port: nodo.PuertoSsh || (process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22),
        username: usuario,
        privateKey,
        readyTimeout: timeoutMs,
      });
  });
}

// ------------------------------------------------------------------
// Lectura por carpeta compartida de Windows (SMB)
// ------------------------------------------------------------------
// - En el contenedor (Linux) se usa `smbclient` (instalado en la imagen) con
//   SMB_USERNAME / SMB_PASSWORD / SMB_DOMAIN del .env. La clave va en un
//   archivo temporal 0600 (no en la línea de comandos) que se borra al terminar.
// - Si el backend corre directamente en Windows (desarrollo), se lee la ruta
//   UNC con el usuario de Windows con el que corre Node, sin smbclient.
function traducirErrorSmb(texto) {
  const t = String(texto || '');
  if (/LOGON_FAILURE|WRONG_PASSWORD|NO_SUCH_USER|ACCOUNT_DISABLED/i.test(t)) return 'Usuario o clave de Windows incorrectos (SMB_USERNAME / SMB_PASSWORD).';
  if (/ACCESS_DENIED/i.test(t)) return 'El usuario de Windows no tiene permiso sobre ese recurso o archivo.';
  if (/OBJECT_NAME_NOT_FOUND|OBJECT_PATH_NOT_FOUND|NO_SUCH_FILE/i.test(t)) return 'No existe el archivo en esa ruta del servidor.';
  if (/BAD_NETWORK_NAME/i.test(t)) return 'No existe el recurso compartido (revisa el nombre después del host, ej. c$).';
  if (/CONNECTION_REFUSED|HOST_UNREACHABLE|NETWORK_UNREACHABLE|IO_TIMEOUT|UNSUCCESSFUL/i.test(t)) return 'No se pudo conectar al puerto 445 del servidor (firewall o servidor apagado).';
  return t.trim().split('\n').slice(-1)[0] || 'Error leyendo por carpeta compartida.';
}

async function leerArchivoSmb(nodo, timeoutMs = 20000) {
  const ruta = parsearRutaSmb(nodo.RutaArchivo);
  if (!ruta) throw new Error(validarRutaArchivo(nodo.RutaArchivo));
  // La ruta debe apuntar al host del nodo, salvo que sea la carpeta compartida
  // central de archivos de configuración (que vive en otro servidor).
  const carpeta = obtenerCarpetaCompartida();
  const enCarpetaCentral = !!carpeta && ruta.host.toLowerCase() === carpeta.host.toLowerCase();
  if (!enCarpetaCentral && ruta.host.toLowerCase() !== String(nodo.Host).toLowerCase()) {
    throw new Error(`El host de la ruta (${ruta.host}) no coincide con el host del nodo (${nodo.Host}).`);
  }

  if (process.platform === 'win32') {
    const unc = `\\\\${ruta.host}\\${ruta.recurso}\\${ruta.archivo}`;
    const lectura = fs.promises.readFile(unc);
    let temporizador;
    const limite = new Promise((_, rej) => { temporizador = setTimeout(() => rej(new Error('Timeout leyendo la carpeta compartida')), timeoutMs); });
    try {
      const datos = await Promise.race([lectura, limite]);
      if (datos.length > MAX_BYTES_ARCHIVO) throw new Error('El archivo supera los 2 MB; no parece un archivo de configuración.');
      return datos.toString('utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('No existe el archivo (o el recurso compartido) en esa ruta.');
      if (err.code === 'EPERM' || err.code === 'EACCES') throw new Error('El usuario de Windows con el que corre el backend no tiene permiso sobre esa ruta.');
      throw err;
    } finally {
      clearTimeout(temporizador);
    }
  }

  const usuario = process.env.SMB_USERNAME;
  const clave = process.env.SMB_PASSWORD;
  if (!usuario || !clave) throw new Error('SMB_USERNAME / SMB_PASSWORD no están configurados en el backend.');

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'smb-'));
  const archivoAuth = path.join(dir, 'auth');
  const destino = path.join(dir, 'salida');
  try {
    const lineas = [`username = ${usuario}`, `password = ${clave}`];
    if (process.env.SMB_DOMAIN) lineas.push(`domain = ${process.env.SMB_DOMAIN}`);
    await fs.promises.writeFile(archivoAuth, lineas.join('\n') + '\n', { mode: 0o600 });

    await new Promise((resolve, reject) => {
      execFile(
        'smbclient',
        [`//${ruta.host}/${ruta.recurso}`, '-A', archivoAuth, '-m', 'SMB3', '-c', `get "${ruta.archivo}" "${destino}"`],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            if (err.code === 'ENOENT') return reject(new Error('smbclient no está instalado en el servidor del backend (reconstruye la imagen con el Dockerfile actualizado).'));
            if (err.killed) return reject(new Error('Timeout leyendo la carpeta compartida'));
            return reject(new Error(traducirErrorSmb(`${stderr}\n${stdout}`)));
          }
          if (/NT_STATUS_/i.test(`${stderr}${stdout}`) && !fs.existsSync(destino)) {
            return reject(new Error(traducirErrorSmb(`${stderr}\n${stdout}`)));
          }
          resolve();
        }
      );
    });

    const { size } = await fs.promises.stat(destino);
    if (size > MAX_BYTES_ARCHIVO) throw new Error('El archivo supera los 2 MB; no parece un archivo de configuración.');
    return (await fs.promises.readFile(destino)).toString('utf8');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------
// Carpeta compartida central de archivos de configuración
// ------------------------------------------------------------------
// Devuelve { host, recurso, subcarpeta, unc } o null si la configuración no es válida.
function obtenerCarpetaCompartida() {
  const unc = String(process.env.NODOS_CARPETA_COMPARTIDA || CARPETA_COMPARTIDA_DEFECTO).trim().replace(/[\\/]+$/, '');
  const r = parsearRutaSmb(unc);
  if (!r) return null;
  return { host: r.host, recurso: r.recurso, subcarpeta: r.archivo, unc: `\\\\${r.host}\\${r.recurso}\\${r.archivo}` };
}

// Interpreta la salida de `smbclient ... -c "recurse ON; ls"`. Los encabezados de
// carpeta empiezan con "\" y cada entrada con dos espacios.
function parsearListadoSmb(salida) {
  const archivos = [];
  let dir = '';
  const entrada = /^\s{2}(.+?)\s+([ADHSRNVI]*)\s+(\d+)\s+\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4}\s*$/;
  for (const linea of String(salida || '').split(/\r?\n/)) {
    if (linea.startsWith('\\')) { dir = linea.trim(); continue; }
    const m = linea.match(entrada);
    if (!m) continue;
    const [, nombre, atributos, tam] = m;
    if (nombre === '.' || nombre === '..' || atributos.includes('D')) continue;
    archivos.push({ dir, nombre, tamano: Number(tam) });
  }
  return archivos;
}

function relativoA(base, dir) {
  // base y dir con "\" inicial; dir siempre empieza por base (con -D la raíz es la carpeta)
  const b = base.replace(/^\\+|\\+$/g, '');
  const d = dir.replace(/^\\+|\\+$/g, '');
  if (!b) return d;
  if (d.toLowerCase() === b.toLowerCase()) return '';
  if (d.toLowerCase().startsWith(b.toLowerCase() + '\\')) return d.slice(b.length + 1);
  return d;
}

const MAX_ARCHIVOS_LISTADO = 3000;
let cacheListado = { clave: '', hasta: 0, datos: null };

async function listarArchivosCarpetaCompartida({ refrescar = false, timeoutMs = 45000 } = {}) {
  const carpeta = obtenerCarpetaCompartida();
  if (!carpeta) throw new Error('NODOS_CARPETA_COMPARTIDA no es una ruta de red válida (\\\\host\\recurso\\carpeta).');
  if (!refrescar && cacheListado.datos && cacheListado.clave === carpeta.unc && cacheListado.hasta > Date.now()) {
    return cacheListado.datos;
  }

  let relativos;
  if (process.platform === 'win32') {
    relativos = [];
    const recorrer = async (dir, prefijo, nivel) => {
      if (nivel > 5 || relativos.length >= MAX_ARCHIVOS_LISTADO) return;
      let items;
      try { items = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (err) {
        if (nivel === 0) {
          if (err.code === 'ENOENT') throw new Error('No existe la carpeta compartida configurada.');
          if (err.code === 'EPERM' || err.code === 'EACCES') throw new Error('El usuario de Windows con el que corre el backend no tiene permiso sobre la carpeta compartida.');
          throw err;
        }
        return;
      }
      for (const it of items) {
        if (it.isDirectory()) await recorrer(path.join(dir, it.name), prefijo + it.name + '\\', nivel + 1);
        else {
          const st = await fs.promises.stat(path.join(dir, it.name)).catch(() => null);
          relativos.push({ ruta: prefijo + it.name, tamano: st ? st.size : 0 });
        }
      }
    };
    await recorrer(carpeta.unc, '', 0);
  } else {
    const usuario = process.env.SMB_USERNAME;
    const clave = process.env.SMB_PASSWORD;
    if (!usuario || !clave) throw new Error('SMB_USERNAME / SMB_PASSWORD no están configurados en el backend.');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'smb-'));
    const archivoAuth = path.join(dir, 'auth');
    try {
      const lineas = [`username = ${usuario}`, `password = ${clave}`];
      if (process.env.SMB_DOMAIN) lineas.push(`domain = ${process.env.SMB_DOMAIN}`);
      await fs.promises.writeFile(archivoAuth, lineas.join('\n') + '\n', { mode: 0o600 });
      const salida = await new Promise((resolve, reject) => {
        execFile(
          'smbclient',
          [`//${carpeta.host}/${carpeta.recurso}`, '-A', archivoAuth, '-m', 'SMB3', '-D', carpeta.subcarpeta, '-c', 'recurse ON; ls'],
          { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              if (err.code === 'ENOENT') return reject(new Error('smbclient no está instalado en el servidor del backend (reconstruye la imagen con el Dockerfile actualizado).'));
              if (err.killed) return reject(new Error('Timeout leyendo la carpeta compartida'));
              return reject(new Error(traducirErrorSmb(`${stderr}\n${stdout}`)));
            }
            if (/NT_STATUS_/i.test(`${stderr}${stdout}`) && !/^\s{2}\.\s/m.test(stdout)) {
              return reject(new Error(traducirErrorSmb(`${stderr}\n${stdout}`)));
            }
            resolve(stdout);
          }
        );
      });
      relativos = parsearListadoSmb(salida).map((a) => {
        const rel = relativoA('\\' + carpeta.subcarpeta, a.dir);
        return { ruta: rel ? `${rel}\\${a.nombre}` : a.nombre, tamano: a.tamano };
      });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const truncado = relativos.length > MAX_ARCHIVOS_LISTADO;
  const archivos = relativos
    .filter((a) => a.tamano <= MAX_BYTES_ARCHIVO && !a.ruta.split('\\').some((t) => t.includes('..')))
    .filter((a) => parsearRutaSmb(`${carpeta.unc}\\${a.ruta}`))
    .sort((a, b) => a.ruta.localeCompare(b.ruta, 'es'))
    .slice(0, MAX_ARCHIVOS_LISTADO);
  const datos = { carpeta: carpeta.unc, archivos, truncado };
  cacheListado = { clave: carpeta.unc, hasta: Date.now() + 60 * 1000, datos };
  return datos;
}

// Lee el archivo del nodo: \\host\recurso\... => carpeta compartida (Windows);
// /ruta/... => SSH (Linux).
function leerArchivoRemoto(nodo) {
  return esRutaSmb(nodo.RutaArchivo) ? leerArchivoSmb(nodo) : leerArchivoSsh(nodo);
}

// ------------------------------------------------------------------
// Interpretación del archivo de configuración
// ------------------------------------------------------------------
function aplanarJson(obj, prefijo = '', salida = []) {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const clave = prefijo ? `${prefijo}.${k}` : k;
      if (v && typeof v === 'object') aplanarJson(v, clave, salida);
      else if (typeof v === 'string') salida.push({ clave, valor: v });
    }
  }
  return salida;
}

// appsettings.json de .NET admite comentarios (// y /* */) y comas sobrantes,
// que JSON.parse no acepta: se limpian respetando lo que va dentro de textos.
function limpiarJsonc(texto) {
  let sinComentarios = '';
  let enTexto = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    const n = texto[i + 1];
    if (enTexto) {
      sinComentarios += c;
      if (c === '\\') { sinComentarios += n ?? ''; i++; } else if (c === '"') enTexto = false;
    } else if (c === '"') { enTexto = true; sinComentarios += c; }
    else if (c === '/' && n === '/') { while (i < texto.length && texto[i] !== '\n') i++; sinComentarios += '\n'; }
    else if (c === '/' && n === '*') { i += 2; while (i < texto.length && !(texto[i] === '*' && texto[i + 1] === '/')) i++; i++; }
    else sinComentarios += c;
  }
  let salida = '';
  enTexto = false;
  for (let i = 0; i < sinComentarios.length; i++) {
    const c = sinComentarios[i];
    if (enTexto) {
      salida += c;
      if (c === '\\') { salida += sinComentarios[i + 1] ?? ''; i++; } else if (c === '"') enTexto = false;
    } else if (c === '"') { enTexto = true; salida += c; }
    else if (c === ',') {
      let j = i + 1;
      while (j < sinComentarios.length && /\s/.test(sinComentarios[j])) j++;
      if (sinComentarios[j] !== '}' && sinComentarios[j] !== ']') salida += c;
    } else salida += c;
  }
  return salida;
}

// En los appsettings cada cliente suele tener "BaseUrl" + "RelativePath"
// hermanos: se unen en una sola URL (clave = ruta del cliente, p. ej.
// "FinandinaApiOptions.Clients.Registraduria").
function emparejarBaseUrl(pares) {
  const porClave = new Map(pares.map((p) => [p.clave, p.valor]));
  const salida = [];
  for (const par of pares) {
    const m = par.clave.match(/^(.*?)\.?((?:base)?url)$/i);
    const esUrl = /^https?:\/\//i.test(par.valor);
    if (m && esUrl && /^base/i.test(m[2])) {
      const padre = m[1];
      const claveRel = [...porClave.keys()].find((k) => (padre ? k.toLowerCase() === `${padre}.relativepath`.toLowerCase() : k.toLowerCase() === 'relativepath'));
      const rel = claveRel ? String(porClave.get(claveRel) || '').trim() : '';
      if (rel) {
        salida.push({ clave: padre || par.clave, valor: `${par.valor.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}` });
        continue;
      }
    }
    salida.push(par);
  }
  return salida;
}

function limpiarValor(v) {
  return v.trim().replace(/[,;]+$/, '').trim().replace(/^["']|["']$/g, '').trim();
}

// Devuelve [{ clave, valor }] sin interpretar todavía.
function extraerParesClaveValor(texto) {
  const t = texto.replace(/^﻿/, '');
  const abre = t.trimStart()[0];
  if (abre === '{' || abre === '[') {
    try { return emparejarBaseUrl(aplanarJson(JSON.parse(limpiarJsonc(t)))); } catch (_) { /* no era JSON: se sigue como texto */ }
  }
  const pares = [];
  for (const crudo of t.split(/\r?\n/)) {
    let linea = crudo.trim();
    if (!linea || linea.startsWith('#') || linea.startsWith('//') || linea.startsWith(';')) continue;
    linea = linea.replace(/^export\s+/i, '');
    let m = linea.match(/^([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/);
    if (!m) m = linea.match(/^["']?([A-Za-z0-9_.\-]+)["']?\s*:\s*(.*)$/);
    if (!m) continue;
    pares.push({ clave: m[1], valor: limpiarValor(m[2]) });
  }
  return pares;
}

function coincideAlgunPatron(texto, patrones) {
  const t = texto.toLowerCase();
  return String(patrones || '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean).some((p) => t.includes(p));
}

function categoriaDesdeUrl(url, nodo) {
  const ace = coincideAlgunPatron(url, nodo.PatronAce ?? PATRON_ACE_DEFECTO);
  const bus = coincideAlgunPatron(url, nodo.PatronBus ?? PATRON_BUS_DEFECTO);
  if (ace && !bus) return 'ACE';
  if (bus && !ace) return 'BUS_INTEGRACION_10';
  return null; // ninguno o ambos: ambiguo, se reporta
}

// Entradas válidas = valor con aspecto de URL http/https y un código de
// servicio C### en la clave (p. ej. "C004_AccountListInq", o la ruta completa
// en un appsettings.json: "Services.C004_AccountListInq") o, si la clave no lo
// trae, en la propia URL (".../C004_AccountListInq...").
const CODIGO_EN_CLAVE = /(?:^|[^A-Za-z0-9])(C\d{3})(?!\d)/i;
const CODIGO_EN_URL = /(?:^|[^A-Za-z0-9])(C\d{3})(?=[_A-Za-z])/;

function parsearConfig(texto, nodo) {
  const entradas = [];
  const ignoradas = [];
  for (const { clave, valor } of extraerParesClaveValor(texto)) {
    if (!/^https?:\/\//i.test(valor)) { ignoradas.push(clave); continue; }
    const m = clave.match(CODIGO_EN_CLAVE) || valor.match(CODIGO_EN_URL);
    // Una URL sin ruta (solo host) es una dirección base, no un servicio.
    if (!m && (!rutaDeUrl(valor) || rutaDeUrl(valor) === '/')) { ignoradas.push(clave); continue; }
    entradas.push({
      clave: clave.slice(0, 150),
      codigo: m ? m[1].toUpperCase() : null, // sin código => se identifica por la URL
      url: valor,
      categoria: categoriaDesdeUrl(valor, nodo),
    });
  }
  return { entradas, ignoradas, conUrlSinCodigo: [] };
}

// ------------------------------------------------------------------
// Comparación (función pura: fácil de probar)
// ------------------------------------------------------------------
function serviciosDeCodigo(codigo, servicios) {
  const re = new RegExp(`^${codigo}([^0-9]|$)`, 'i');
  return servicios.filter((s) => re.test(String(s.Codigo || '')));
}

// host + ruta, en minúsculas y sin "/" final ni query, para comparar URLs.
function normalizarUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url).trim());
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch (_) {
    return String(url).trim().replace(/\/+$/, '').toLowerCase();
  }
}

// Solo la ruta (sin host ni query), en minúsculas y sin "/" final. Los hosts
// cambian según el ambiente/nodo (p. ej. falabusibqa vs falaappbusibmbal), la
// ruta del servicio no.
function rutaDeUrl(url) {
  if (!url) return '';
  let ruta;
  try { ruta = new URL(String(url).trim()).pathname; } catch (_) { ruta = String(url).trim().replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0]; }
  try { ruta = decodeURIComponent(ruta); } catch (_) { /* se deja tal cual */ }
  return ruta.replace(/\/+$/, '').toLowerCase();
}

// 1) URL completa igual (host + ruta); 2) si no, misma ruta en Dev/QA/Prd.
function serviciosDeUrl(url, servicios) {
  const objetivo = normalizarUrl(url);
  if (!objetivo) return [];
  const exactos = servicios.filter((s) => [s.UrlDev, s.UrlQa, s.UrlPrd].some((u) => u && normalizarUrl(u) === objetivo));
  if (exactos.length) return exactos;
  const ruta = rutaDeUrl(url);
  if (!ruta || ruta === '/') return [];
  return servicios.filter((s) => [s.UrlDev, s.UrlQa, s.UrlPrd].some((u) => u && rutaDeUrl(u) === ruta));
}

function codigoBaseDeServicio(codigoServicio) {
  const m = String(codigoServicio || '').match(/^(C\d{3})(?!\d)/i);
  return m ? m[1].toUpperCase() : null;
}

// entradas: salida de parsearConfig. existentes: filas de Apuntamientos del
// nodo. servicios: AceServiciosInventario (Id, Codigo, UrlDev/Qa/Prd).
// Cada entrada se identifica por su código C### (si lo trae) o, si no, por la
// URL completa (base + ruta) contra las URLs del inventario.
function compararConfigConBitacora(entradas, existentes, servicios) {
  const detalle = [];
  const esperados = new Map(); // "idServicio|ACE" -> entrada (primera)
  let omitidas = 0; // URLs sin código, fuera del inventario y que no son ACE ni Bus (p. ej. un microservicio externo)

  for (const e of entradas) {
    const porCodigo = !!e.codigo;
    if (porCodigo && !e.categoria) {
      detalle.push({ Tipo: 'SIN_CATEGORIA', Clave: e.clave, Codigo: e.codigo, Categoria: null, Url: e.url,
        Detalle: 'La URL no coincide con ningún patrón de ACE ni de Bus 10 (o coincide con ambos).' });
      continue;
    }
    const candidatos = porCodigo ? serviciosDeCodigo(e.codigo, servicios) : serviciosDeUrl(e.url, servicios);
    if (!porCodigo && candidatos.length === 0 && !e.categoria) { omitidas++; continue; }
    if (candidatos.length !== 1) {
      const codigoMostrado = e.codigo || null;
      let texto;
      if (porCodigo) {
        texto = candidatos.length === 0
          ? `El código ${e.codigo} no existe en el inventario de servicios.`
          : `El código ${e.codigo} coincide con ${candidatos.length} servicios (${candidatos.map((c) => c.Codigo).join(', ')}); no se puede elegir uno solo.`;
      } else {
        texto = candidatos.length === 0
          ? 'La ruta de esta URL no está en el inventario de servicios (Dev, QA o Prd).'
          : `La URL coincide con ${candidatos.length} servicios (${candidatos.map((c) => c.Codigo).join(', ')}); no se puede elegir uno solo.`;
      }
      detalle.push({ Tipo: 'SIN_SERVICIO', Clave: e.clave, Codigo: codigoMostrado, Categoria: e.categoria, Url: e.url, Detalle: texto });
      continue;
    }
    if (!e.categoria) {
      detalle.push({ Tipo: 'SIN_CATEGORIA', Clave: e.clave, Codigo: candidatos[0].Codigo, Categoria: null, Url: e.url,
        ServicioInventarioId: candidatos[0].Id,
        Detalle: 'La URL no coincide con ningún patrón de ACE ni de Bus 10 (o coincide con ambos).' });
      continue;
    }
    const llaveEntrada = `${candidatos[0].Id}|${e.categoria}`;
    if (!esperados.has(llaveEntrada)) esperados.set(llaveEntrada, { ...e, servicio: candidatos[0] });
  }

  const enBitacora = new Map(); // "idServicio|ACE" -> [filas]
  for (const a of existentes) {
    if (a.SinApuntamiento || !a.Categoria || !a.ServicioInventarioId) continue;
    const k = `${a.ServicioInventarioId}|${a.Categoria}`;
    if (!enBitacora.has(k)) enBitacora.set(k, []);
    enBitacora.get(k).push(a);
  }

  for (const [k, e] of esperados) {
    if (!enBitacora.has(k)) {
      detalle.push({ Tipo: 'FALTANTE', Clave: e.clave, Codigo: e.servicio.Codigo, Categoria: e.categoria, Url: e.url,
        ServicioInventarioId: e.servicio.Id,
        Detalle: `Está en el archivo del nodo (${e.categoria}) y no en la bitácora.` });
    }
  }
  for (const [k, filas] of enBitacora) {
    if (!esperados.has(k)) {
      const categoria = k.split('|')[1];
      for (const a of filas) {
        detalle.push({ Tipo: 'SOBRANTE', Clave: null, Codigo: codigoBaseDeServicio(a.ServicioCodigo) || a.ServicioCodigo || null,
          Categoria: categoria, Url: null, ApuntamientoId: a.Id, ServicioInventarioId: a.ServicioInventarioId,
          Detalle: 'Está en la bitácora y no en el archivo del nodo (no se borra automáticamente).' });
      }
    }
  }

  return { detalle, omitidas, totalConfig: esperados.size, totalBitacora: existentes.filter((a) => !a.SinApuntamiento && a.Categoria).length };
}

// ------------------------------------------------------------------
// Validación de un nodo
// ------------------------------------------------------------------
function formatoFechaMysql(fecha) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())} ${pad(fecha.getHours())}:${pad(fecha.getMinutes())}:${pad(fecha.getSeconds())}`;
}

function diaLocal(zona = process.env.VALIDACION_NODOS_TZ || 'America/Bogota', fecha = new Date()) {
  // en-CA entrega YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
}

async function cargarApuntamientosDelNodo(pool, nodo) {
  const [filas] = await pool.query(
    `SELECT a.Id, a.SinApuntamiento, a.Categoria, a.ServicioInventarioId, si.Codigo AS ServicioCodigo
     FROM Apuntamientos a
     LEFT JOIN AceServiciosInventario si ON si.Id = a.ServicioInventarioId
     WHERE a.AplicacionId = ? AND ((? IS NULL AND a.Componente IS NULL) OR a.Componente = ?)`,
    [nodo.AplicacionId, nodo.Componente || null, nodo.Componente || null]
  );
  return filas;
}

async function registrarCorreccion(conexion, nodo, d, usuario, fechaTexto) {
  const observaciones = `Alta por validación de nodo ${nodo.Nombre} - clave: ${d.Clave}`.slice(0, 500);
  const [r] = await conexion.query(
    `INSERT INTO Apuntamientos (AplicacionId, Componente, SinApuntamiento, Categoria, ServicioInventarioId, Observaciones, FechaActualizacion)
     VALUES (?, ?, 0, ?, ?, ?, ?)`,
    [nodo.AplicacionId, nodo.Componente || null, d.Categoria, d.ServicioInventarioId, observaciones, fechaTexto]
  );
  await conexion.query(
    `INSERT INTO ApuntamientosHistorico
       (ApuntamientoId, Accion, AplicacionIdNuevo, ComponenteNuevo, SinApuntamientoNuevo, CategoriaNueva,
        ServicioInventarioIdNuevo, Observaciones, Usuario, FechaActualizacionDeclarada)
     VALUES (?, 'ALTA', ?, ?, 0, ?, ?, ?, ?, ?)`,
    [r.insertId, nodo.AplicacionId, nodo.Componente || null, d.Categoria, d.ServicioInventarioId, observaciones, usuario, fechaTexto]
  );
  return r.insertId;
}

// opciones: { origen: 'AUTO'|'MANUAL', aplicar: bool, usuario, lector, guardar: bool }
//  - aplicar=false => simulación: no escribe en Apuntamientos.
//  - guardar=false => ni siquiera guarda la corrida (vista previa "Probar").
async function validarNodo(pool, nodo, opciones = {}) {
  const origen = opciones.origen || 'MANUAL';
  const aplicar = !!opciones.aplicar;
  const guardar = opciones.guardar !== false;
  const usuario = opciones.usuario || USUARIO_AUTOMATICO;
  const lector = opciones.lector || leerArchivoRemoto;

  const resultado = {
    estado: 'OK', modo: aplicar ? 'APLICADO' : 'SIMULACION', origen, mensaje: null,
    totalConfig: 0, totalBitacora: 0, faltantes: 0, sobrantes: 0, sinServicio: 0, corregidos: 0,
    ignoradas: 0, detalle: [],
  };

  try {
    const texto = await lector(nodo);
    const { entradas, ignoradas } = parsearConfig(texto, nodo);
    resultado.ignoradas = ignoradas.length;
    if (!entradas.length) {
      throw new Error('No se encontró ninguna URL http/https en el archivo. Revisa que la ruta apunte al archivo de configuración correcto.');
    }

    const [servicios] = await pool.query('SELECT Id, Codigo, UrlDev, UrlQa, UrlPrd FROM AceServiciosInventario');
    const existentes = await cargarApuntamientosDelNodo(pool, nodo);
    const cmp = compararConfigConBitacora(entradas, existentes, servicios);
    resultado.ignoradas += cmp.omitidas || 0;
    resultado.detalle = cmp.detalle;
    resultado.totalConfig = cmp.totalConfig;
    resultado.totalBitacora = cmp.totalBitacora;

    const cuenta = (t) => cmp.detalle.filter((d) => d.Tipo === t).length;
    resultado.faltantes = cuenta('FALTANTE');
    resultado.sobrantes = cuenta('SOBRANTE');
    resultado.sinServicio = cuenta('SIN_SERVICIO') + cuenta('SIN_CATEGORIA');

    if (aplicar && resultado.faltantes > 0) {
      const conexion = await pool.getConnection();
      try {
        await conexion.beginTransaction();
        const fechaTexto = formatoFechaMysql(new Date());
        for (const d of cmp.detalle.filter((x) => x.Tipo === 'FALTANTE')) {
          d.ApuntamientoId = await registrarCorreccion(conexion, nodo, d, usuario, fechaTexto);
          d.Tipo = 'CORREGIDO';
          d.Detalle = 'Apuntamiento agregado a la bitácora (queda registrado en el histórico).';
          resultado.corregidos += 1;
        }
        await conexion.commit();
      } catch (err) {
        await conexion.rollback();
        throw err;
      } finally {
        conexion.release();
      }
      resultado.faltantes = 0;
      resultado.totalBitacora += resultado.corregidos;
    }

    resultado.estado = (resultado.faltantes + resultado.sobrantes + resultado.sinServicio) > 0 ? 'DIFERENCIAS' : 'OK';
    if (resultado.corregidos && resultado.estado === 'OK') resultado.estado = 'CORREGIDO';
    if (resultado.corregidos && resultado.estado === 'DIFERENCIAS') resultado.estado = 'CORREGIDO_PARCIAL';
  } catch (err) {
    resultado.estado = 'ERROR';
    resultado.mensaje = String(err.message || err).slice(0, 500);
    resultado.corregidos = 0;
  }

  if (guardar) {
    resultado.validacionId = await guardarValidacion(pool, nodo, resultado, usuario);
  }
  return resultado;
}

async function guardarValidacion(pool, nodo, r, usuario) {
  const [ins] = await pool.query(
    `INSERT INTO ApuntamientosValidaciones
       (NodoId, Origen, Modo, Estado, TotalConfig, TotalBitacora, Faltantes, Sobrantes, SinServicio, Corregidos, Mensaje, Usuario, DiaLocal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [nodo.Id, r.origen, r.modo, r.estado, r.totalConfig, r.totalBitacora, r.faltantes, r.sobrantes, r.sinServicio,
      r.corregidos, r.mensaje, usuario, r.origen === 'AUTO' ? diaLocal() : null]
  );
  for (const d of r.detalle) {
    await pool.query(
      `INSERT INTO ApuntamientosValidacionDetalle
         (ValidacionId, Tipo, Clave, Codigo, Categoria, Url, ApuntamientoId, ServicioInventarioId, Detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ins.insertId, d.Tipo, d.Clave || null, d.Codigo || null, d.Categoria || null,
        d.Url ? String(d.Url).slice(0, 500) : null, d.ApuntamientoId || null, d.ServicioInventarioId || null,
        d.Detalle ? String(d.Detalle).slice(0, 500) : null]
    );
  }
  await pool.query('UPDATE ApuntamientosNodos SET UltimaValidacion = NOW(), UltimoEstado = ? WHERE Id = ?', [r.estado, nodo.Id]);
  return ins.insertId;
}

// ------------------------------------------------------------------
// Corrida diaria
// ------------------------------------------------------------------
let corriendo = false;

async function ejecutarValidacionDiaria({ forzar = false } = {}) {
  if (corriendo) return { omitido: 'ya hay una corrida en curso' };
  corriendo = true;
  try {
    const pool = await getPool();
    const errEsquema = await garantizarEsquemaNodos(pool);
    if (errEsquema) return { omitido: errEsquema.message };

    const hoy = diaLocal();
    const [nodos] = await pool.query('SELECT * FROM ApuntamientosNodos WHERE Activo = 1 ORDER BY Id');
    const resumen = [];
    for (const nodo of nodos) {
      if (!forzar) {
        // Ya hecha hoy = hay una corrida automática sin error. Si fallaron (nodo
        // caído, SSH), se reintenta cada 30 min como máximo 3 veces en el día.
        const [hist] = await pool.query(
          `SELECT SUM(Estado <> 'ERROR') AS buenas, SUM(Estado = 'ERROR') AS fallidas,
                  MAX(Fecha) AS ultima
           FROM ApuntamientosValidaciones WHERE NodoId = ? AND Origen = 'AUTO' AND DiaLocal = ?`,
          [nodo.Id, hoy]
        );
        const h = hist[0] || {};
        if (Number(h.buenas) > 0) continue;
        if (Number(h.fallidas) >= 3) continue;
        if (h.ultima && Date.now() - new Date(h.ultima).getTime() < 30 * 60 * 1000) continue;
      }
      const r = await validarNodo(pool, nodo, { origen: 'AUTO', aplicar: !!nodo.CorregirAuto });
      resumen.push({ nodo: nodo.Nombre, estado: r.estado, corregidos: r.corregidos, faltantes: r.faltantes, sobrantes: r.sobrantes });
      console.log(`[validacion-nodos] ${nodo.Nombre}: ${r.estado} (config ${r.totalConfig}, bitácora ${r.totalBitacora}, ` +
        `faltantes ${r.faltantes}, sobrantes ${r.sobrantes}, corregidos ${r.corregidos})${r.mensaje ? ' - ' + r.mensaje : ''}`);
    }
    return { ejecutados: resumen };
  } catch (err) {
    console.error('[validacion-nodos] Error en la corrida diaria:', err.message);
    return { error: err.message };
  } finally {
    corriendo = false;
  }
}

// Revisa cada 5 minutos si ya llegó la hora configurada (por defecto 02:00,
// hora de Bogotá) y alguna corrida automática de hoy está pendiente. Como
// cada nodo registra su corrida con DiaLocal, reinicios del contenedor no
// duplican la validación del día; y si el contenedor estuvo apagado a la hora
// programada, se ejecuta en cuanto vuelva a estar arriba ese mismo día.
function iniciarProgramadorValidacionNodos() {
  if (String(process.env.VALIDACION_NODOS_ACTIVA || 'true').toLowerCase() === 'false') {
    console.log('[validacion-nodos] Programador desactivado (VALIDACION_NODOS_ACTIVA=false).');
    return;
  }
  const hora = process.env.VALIDACION_NODOS_HORA || '02:00';
  const m = hora.match(/^(\d{1,2}):(\d{2})$/);
  const minutosObjetivo = m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 120;
  const zona = process.env.VALIDACION_NODOS_TZ || 'America/Bogota';

  const revisar = async () => {
    const partes = new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const h = +partes.find((p) => p.type === 'hour').value;
    const mi = +partes.find((p) => p.type === 'minute').value;
    if ((h % 24) * 60 + mi < minutosObjetivo) return;
    await ejecutarValidacionDiaria();
  };
  setTimeout(revisar, 60000);
  setInterval(revisar, 5 * 60 * 1000);
  console.log(`[validacion-nodos] Programador activo: una vez al día desde las ${hora} (${zona}).`);
}

module.exports = {
  DDL, TABLAS, PATRON_ACE_DEFECTO, PATRON_BUS_DEFECTO,
  garantizarEsquemaNodos, validarRutaArchivo, leerArchivoRemoto, leerArchivoSmb, parsearRutaSmb,
  obtenerCarpetaCompartida, listarArchivosCarpetaCompartida, parsearListadoSmb,
  parsearConfig, categoriaDesdeUrl, compararConfigConBitacora,
  validarNodo, ejecutarValidacionDiaria, iniciarProgramadorValidacionNodos, diaLocal,
};
