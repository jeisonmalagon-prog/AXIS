// ============================================================================
// Puertos en escucha de un servidor, consultados por SSH (solo lectura).
//
// Usa la MISMA configuración SSH que el monitoreo (variables de entorno
// SSH_USERNAME, SSH_KEY_PATH y SSH_PORT), así que no hay nada nuevo que
// configurar: si el monitoreo llega a un servidor, esto también.
//
//  - Linux:   `ss -tuln` (o `netstat -tuln` si no existe ss). Con `-p` se ve el
//             proceso solo de los puertos que pertenecen al usuario SSH; para
//             verlos todos hace falta root. Si defines PUERTOS_USAR_SUDO=1 se
//             intenta `sudo -n` (sin pedir clave); si no está permitido, se usa
//             el comando normal. Por defecto NO se usa sudo.
//             Además se cruza con `docker ps` para saber qué contenedor publicó
//             cada puerto (en la máquina aparecen como "docker-proxy").
//  - Windows: PowerShell (Get-NetTCPConnection / Get-NetUDPEndpoint, con
//             `netstat -ano` de respaldo), enviado como -EncodedCommand por:
//               · WinRM (PowerShell remoto, no necesita SSH en el servidor), con
//                 una cuenta de servicio de dominio (NTLM) o local (Basic);
//               · SSH (OpenSSH de Windows), igual que el monitoreo.
//             PUERTOS_WINDOWS_METODO = auto (por defecto) | winrm | ssh.
//             En «auto» se usa WinRM si está configurado y, si el servidor no
//             responde por WinRM, se intenta por SSH.
//
// Variables de entorno de WinRM (backend/.env):
//   WINRM_USERNAME=DOMINIO\usuario   (o usuario@dominio; si es local, sin dominio)
//   WINRM_PASSWORD=...
//   WINRM_HTTPS=1            (1 = HTTPS puerto 5986, recomendado; 0 = HTTP 5985)
//   WINRM_PORT=              (opcional; por defecto 5986 con HTTPS, 5985 sin HTTPS)
//   WINRM_VERIFICAR_CERT=1   (0 si el certificado del listener es autofirmado)
//
// No modifica nada en el servidor: solo lee.
// ============================================================================
const fs = require('fs');
const { Client } = require('ssh2');

const SSH_USERNAME = process.env.SSH_USERNAME;
const SSH_KEY_PATH = process.env.SSH_KEY_PATH;
const SSH_PORT = process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22;
const USAR_SUDO = String(process.env.PUERTOS_USAR_SUDO || '') === '1';

const sshConfigurado = () => Boolean(SSH_USERNAME && SSH_KEY_PATH);

const WINRM_USERNAME = process.env.WINRM_USERNAME;
const WINRM_PASSWORD = process.env.WINRM_PASSWORD;
const WINRM_HTTPS = String(process.env.WINRM_HTTPS ?? '1') !== '0';
const WINRM_PORT = process.env.WINRM_PORT ? parseInt(process.env.WINRM_PORT, 10) : (WINRM_HTTPS ? 5986 : 5985);
const WINRM_VERIFICAR_CERT = String(process.env.WINRM_VERIFICAR_CERT ?? '1') !== '0';
const METODO_WINDOWS = ['winrm', 'ssh'].includes(String(process.env.PUERTOS_WINDOWS_METODO || '').toLowerCase())
  ? String(process.env.PUERTOS_WINDOWS_METODO).toLowerCase() : 'auto';

const winrmConfigurado = () => Boolean(WINRM_USERNAME && WINRM_PASSWORD);

// Qué canales sirven para un sistema operativo, según lo configurado.
function metodosDisponibles(sistemaOperativo) {
  const so = String(sistemaOperativo || '').toLowerCase();
  if (so === 'linux') return sshConfigurado() ? ['ssh'] : [];
  if (so !== 'windows') return [];
  const m = [];
  if (METODO_WINDOWS !== 'ssh' && winrmConfigurado()) m.push('winrm');
  if (METODO_WINDOWS !== 'winrm' && sshConfigurado()) m.push('ssh');
  return m;
}

let llave = null;
const obtenerLlave = () => {
  if (!llave && SSH_KEY_PATH) llave = fs.readFileSync(SSH_KEY_PATH);
  return llave;
};

function ejecutarSSH(host, comando, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let terminado = false;
    const fin = (fn, valor) => { if (terminado) return; terminado = true; clearTimeout(temporizador); try { conn.end(); } catch (_) { /* nada */ } fn(valor); };
    const temporizador = setTimeout(() => fin(reject, new Error('Timeout conectando por SSH')), timeoutMs);
    conn
      .on('ready', () => {
        conn.exec(comando, (err, stream) => {
          if (err) return fin(reject, err);
          let salida = '';
          let errorSalida = '';
          stream
            .on('close', () => {
              if (errorSalida && !salida) return fin(reject, new Error(errorSalida.trim()));
              fin(resolve, salida);
            })
            .on('data', (d) => { salida += d.toString(); })
            .stderr.on('data', (d) => { errorSalida += d.toString(); });
        });
      })
      .on('error', (err) => fin(reject, err))
      .connect({ host, port: SSH_PORT, username: SSH_USERNAME, privateKey: obtenerLlave(), readyTimeout: Math.min(timeoutMs, 15000) });
  });
}


// --------------------------------------------------------------- WinRM -----
// Usa la librería «winrm-client» (npm install winrm-client). Se carga solo al
// necesitarla, para que el backend arranque aunque aún no esté instalada.
function cargarWinrm() {
  try {
    // eslint-disable-next-line global-require
    return require('winrm-client');
  } catch (_) {
    const e = new Error('Falta la librería «winrm-client» en el backend (ejecuta «npm install» en la carpeta backend y reconstruye la imagen).');
    e.amigable = true;
    throw e;
  }
}

// DOMINIO\usuario o usuario@dominio → NTLM; usuario local → Basic (igual que la librería).
const metodoAuthWinrm = (usuario) => (/[\\@]/.test(usuario) ? 'ntlm' : 'basic');

async function ejecutarWinrm(host, comando, timeoutMs = 40000, lib = null) {
  const { Shell, Command } = lib || cargarWinrm();
  const params = {
    host, port: WINRM_PORT, path: '/wsman',
    username: WINRM_USERNAME, password: WINRM_PASSWORD,
    authMethod: metodoAuthWinrm(WINRM_USERNAME),
    useHttps: WINRM_HTTPS, rejectUnauthorized: WINRM_VERIFICAR_CERT,
    httpTimeout: timeoutMs,
  };
  const limite = Date.now() + timeoutMs;
  let shellId = null;
  const trabajo = (async () => {
    shellId = await Shell.doCreateShell(params);
    const base = { ...params, shellId, command: comando };
    const commandId = await Command.doExecuteCommand(base);
    let salida = '';
    // El servidor puede entregar la salida en varios trozos: se pide hasta que avise que terminó.
    for (;;) {
      const r = await Command.doReceiveOutputNonBlocking({ ...base, commandId });
      // Se decodifica la salida cruda (sin recortar espacios): la librería recorta cada
      // trozo y, si un trozo termina justo en un salto de línea, pegaría dos líneas.
      const crudo = (r.streams || [])
        .filter((x) => x.name === 'stdout' && !x.end && x.content)
        .map((x) => Buffer.from(x.content, 'base64').toString('utf8'))
        .join('');
      salida += crudo || (r.output ? `${r.output}\n` : '');
      if (r.isComplete) break;
      if (Date.now() > limite) throw new Error('Timeout esperando la respuesta de WinRM');
    }
    return salida;
  })();
  let temporizador;
  const tope = new Promise((_, rechazar) => { temporizador = setTimeout(() => rechazar(new Error('Timeout conectando por WinRM')), timeoutMs); });
  try {
    return await Promise.race([trabajo, tope]);
  } finally {
    clearTimeout(temporizador);
    trabajo.catch(() => {});
    if (shellId) { try { await Shell.doDeleteShell({ ...params, shellId }); } catch (_) { /* nada */ } }
  }
}

function mensajeErrorWinrm(err) {
  const m = String((err && err.message) || err || '');
  if (/Timeout/i.test(m)) return `WinRM no respondió a tiempo (sin conexión o puerto ${WINRM_PORT} bloqueado).`;
  if (/ECONNREFUSED/i.test(m)) return `WinRM no está habilitado en el servidor (puerto ${WINRM_PORT} cerrado).`;
  if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i.test(m)) return 'No hay ruta hasta el servidor (IP inalcanzable o nombre no resuelto).';
  if (/self.signed|SELF_SIGNED|UNABLE_TO_VERIFY|CERT_|certificate/i.test(m)) return 'El certificado de WinRM del servidor no es de confianza (si es autofirmado, define WINRM_VERIFICAR_CERT=0 en el .env).';
  if (/401|Unauthorized|logon failure|authentication/i.test(m)) return 'El servidor rechazó la cuenta de WinRM (usuario o clave incorrectos, o sin permiso de acceso remoto).';
  if (/Access is denied|denied/i.test(m)) return 'La cuenta de WinRM no tiene permiso para ejecutar comandos remotos en ese servidor.';
  if (/ECONNRESET|socket hang up|EPIPE/i.test(m)) return 'La conexión WinRM se cortó (¿el servidor espera HTTP en lugar de HTTPS, o al revés? Revisa WINRM_HTTPS y WINRM_PORT).';
  return `No se pudo consultar por WinRM: ${m.slice(0, 200) || 'error desconocido'}`;
}

// ---------------------------------------------------------------- scripts --
const SCRIPT_LINUX = `
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
USAR_SUDO=${USAR_SUDO ? 1 : 0}
echo "===PUERTOS==="
SALIDA=""
FUENTE="ninguna"
if command -v ss >/dev/null 2>&1; then
  if [ "$USAR_SUDO" = "1" ]; then
    SALIDA=$(sudo -n ss -tulnp 2>/dev/null </dev/null)
    [ -n "$SALIDA" ] && FUENTE="ss+sudo"
  fi
  if [ -z "$SALIDA" ]; then SALIDA=$(ss -tulnp 2>/dev/null </dev/null); FUENTE="ss"; fi
elif command -v netstat >/dev/null 2>&1; then
  if [ "$USAR_SUDO" = "1" ]; then
    SALIDA=$(sudo -n netstat -tulnp 2>/dev/null </dev/null)
    [ -n "$SALIDA" ] && FUENTE="netstat+sudo"
  fi
  if [ -z "$SALIDA" ]; then SALIDA=$(netstat -tulnp 2>/dev/null </dev/null); FUENTE="netstat"; fi
fi
echo "FUENTE=$FUENTE"
echo "ROOT=$(id -u)"
echo "$SALIDA"
echo "===DOCKER==="
DOCKER_BIN=$(command -v docker 2>/dev/null)
if [ -n "$DOCKER_BIN" ]; then
  ARCH="/tmp/.puertos_docker_$$"
  timeout -k 2 6 "$DOCKER_BIN" ps --format '{{.Names}}@@@{{.Ports}}' > "$ARCH" 2>/dev/null </dev/null
  cat "$ARCH" 2>/dev/null
  rm -f "$ARCH" 2>/dev/null
fi
echo "===FIN==="
`.trim();

const SCRIPT_WINDOWS_FUENTE = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$procs = @{}
Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_.ProcessName }
$lineas = New-Object System.Collections.Generic.List[string]
$fuente = 'cmdlets'
try {
  Get-NetTCPConnection -State Listen | ForEach-Object {
    $p = [int]$_.OwningProcess
    $lineas.Add("tcp|$($_.LocalAddress)|$($_.LocalPort)|$p|$($procs[$p])")
  }
  Get-NetUDPEndpoint | ForEach-Object {
    $p = [int]$_.OwningProcess
    $lineas.Add("udp|$($_.LocalAddress)|$($_.LocalPort)|$p|$($procs[$p])")
  }
} catch {}
if ($lineas.Count -eq 0) {
  $fuente = 'netstat'
  foreach ($l in (netstat -ano)) {
    if ($l -match '^\\s*(TCP)\\s+(\\S+):(\\d+)\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$') {
      $p = [int]$Matches[4]; $lineas.Add("tcp|$($Matches[2])|$($Matches[3])|$p|$($procs[$p])")
    } elseif ($l -match '^\\s*(UDP)\\s+(\\S+):(\\d+)\\s+\\*:\\*\\s+(\\d+)\\s*$') {
      $p = [int]$Matches[4]; $lineas.Add("udp|$($Matches[2])|$($Matches[3])|$p|$($procs[$p])")
    }
  }
}
Write-Output "===PUERTOS==="
Write-Output "FUENTE=$fuente"
$lineas | ForEach-Object { Write-Output $_ }
Write-Output "===FIN==="
`.trim();

let comandoWindows = null;
const obtenerComandoWindows = () => {
  if (!comandoWindows) {
    const b64 = Buffer.from(SCRIPT_WINDOWS_FUENTE, 'utf16le').toString('base64');
    comandoWindows = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`;
  }
  return comandoWindows;
};

// ---------------------------------------------------------------- parsers --
function dividirSecciones(texto) {
  const secciones = {};
  let actual = null;
  for (const linea of String(texto).replace(/\r/g, '').split('\n')) {
    const m = linea.match(/^===([A-Z_]+)===$/);
    if (m) { actual = m[1]; secciones[actual] = []; continue; }
    if (actual && linea.trim() !== '') secciones[actual].push(linea);
  }
  return secciones;
}

// "0.0.0.0:22" | "[::]:22" | ":::22" | "*:22" | "127.0.0.53%lo:53" → { direccion, puerto }
function separarDireccionPuerto(local) {
  const i = local.lastIndexOf(':');
  if (i < 0) return null;
  const puerto = parseInt(local.slice(i + 1), 10);
  if (!Number.isInteger(puerto) || puerto < 0 || puerto > 65535) return null;
  let direccion = local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (direccion === '' || direccion === '*') direccion = '::';
  return { direccion, puerto };
}

function parsearSsNetstatLinux(lineas) {
  const out = [];
  for (const linea of lineas) {
    const t = linea.trim().split(/\s+/);
    if (!t.length || /^(Netid|Proto|Active|State)/i.test(t[0])) continue;
    const proto = (t[0] || '').toLowerCase();
    if (!/^(tcp|udp)/.test(proto)) continue;
    const protocolo = proto.startsWith('tcp') ? 'TCP' : 'UDP';

    let local; let resto;
    if (/^(LISTEN|UNCONN|ESTAB|[A-Z-]+)$/.test(t[1] || '') && t.length >= 6 && /^\d+$/.test(t[2])) {
      // ss: netid state recvq sendq local peer [users:(...)]
      if (protocolo === 'TCP' && t[1] !== 'LISTEN') continue;
      local = t[4]; resto = t.slice(6).join(' ');
    } else if (/^\d+$/.test(t[1]) && /^\d+$/.test(t[2])) {
      // netstat: proto recvq sendq local foreign [state] [pid/prog]
      local = t[3];
      const estado = protocolo === 'TCP' ? t[5] : '';
      if (protocolo === 'TCP' && estado !== 'LISTEN') continue;
      resto = t.slice(protocolo === 'TCP' ? 6 : 5).join(' ');
    } else continue;

    const dp = separarDireccionPuerto(local);
    if (!dp) continue;

    let procesos = [];
    for (const m of resto.matchAll(/\("([^"]+)",pid=(\d+)/g)) procesos.push({ nombre: m[1], pid: parseInt(m[2], 10) });
    if (!procesos.length) {
      const n = resto.match(/(\d+)\/(\S+)/);
      if (n) procesos = [{ nombre: n[2], pid: parseInt(n[1], 10) }];
    }
    out.push({ protocolo, direccion: dp.direccion, puerto: dp.puerto, procesos });
  }
  return out;
}

function parsearWindows(lineas) {
  const out = [];
  for (const linea of lineas) {
    const p = linea.trim().split('|');
    if (p.length < 4 || !/^(tcp|udp)$/.test(p[0])) continue;
    const puerto = parseInt(p[2], 10);
    if (!Number.isInteger(puerto)) continue;
    const pid = parseInt(p[3], 10);
    const nombre = (p[4] || '').trim();
    out.push({
      protocolo: p[0].toUpperCase(),
      direccion: (p[1] || '::').replace(/%.*$/, ''),
      puerto,
      procesos: nombre || pid ? [{ nombre: nombre || (pid === 4 ? 'System' : ''), pid: pid || null }] : [],
    });
  }
  return out;
}

// "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 9000/tcp, 0.0.0.0:8000-8002->8000-8002/tcp"
function parsearDocker(lineas) {
  const mapa = new Map(); // "TCP:8080" -> Set(nombres)
  for (const linea of lineas) {
    const [nombre, puertos] = linea.split('@@@');
    if (!nombre || !puertos) continue;
    for (const seg of puertos.split(',')) {
      const m = seg.trim().match(/:(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/(tcp|udp)/i);
      if (!m) continue;
      const ini = parseInt(m[1], 10);
      const fin = m[2] ? parseInt(m[2], 10) : ini;
      for (let p = ini; p <= Math.min(fin, ini + 2000); p += 1) {
        const k = `${m[3].toUpperCase()}:${p}`;
        if (!mapa.has(k)) mapa.set(k, new Set());
        mapa.get(k).add(nombre.trim());
      }
    }
  }
  return mapa;
}

const esTodas = (d) => d === '::' || d === '0.0.0.0' || d === '*';
const esLocal = (d) => d === '::1' || /^127\./.test(d);

// Une IPv4/IPv6 del mismo puerto y protocolo en una sola fila.
function consolidar(crudos, contenedores) {
  const porClave = new Map();
  for (const c of crudos) {
    const k = `${c.protocolo}:${c.puerto}`;
    if (!porClave.has(k)) porClave.set(k, { protocolo: c.protocolo, puerto: c.puerto, direcciones: new Set(), procesos: new Map() });
    const f = porClave.get(k);
    f.direcciones.add(c.direccion);
    for (const p of c.procesos) if (p.nombre) f.procesos.set(`${p.nombre}:${p.pid}`, p);
  }
  const filas = [];
  for (const f of porClave.values()) {
    const dirs = [...f.direcciones];
    const alcance = dirs.some(esTodas) ? 'todas' : dirs.every(esLocal) ? 'local' : 'especifica';
    const procs = [...f.procesos.values()];
    const nombres = [...new Set(procs.map((p) => p.nombre))];
    const cont = contenedores.get(`${f.protocolo}:${f.puerto}`);
    filas.push({
      puerto: f.puerto,
      protocolo: f.protocolo,
      alcance,
      direcciones: dirs.sort(),
      proceso: nombres.length ? nombres.join(', ') : null,
      pid: procs.length ? procs[0].pid : null,
      contenedor: cont && cont.size ? [...cont].sort().join(', ') : null,
    });
  }
  filas.sort((a, b) => a.puerto - b.puerto || a.protocolo.localeCompare(b.protocolo));
  return filas;
}

function resumir(filas) {
  return {
    total: filas.length,
    tcp: filas.filter((f) => f.protocolo === 'TCP').length,
    udp: filas.filter((f) => f.protocolo === 'UDP').length,
    expuestos: filas.filter((f) => f.alcance !== 'local').length,
    soloLocal: filas.filter((f) => f.alcance === 'local').length,
  };
}

function interpretarSalida(sistema, texto) {
  const sec = dividirSecciones(texto);
  const puertosLineas = sec.PUERTOS || [];
  const meta = {};
  const datos = [];
  for (const l of puertosLineas) {
    const m = l.match(/^(FUENTE|ROOT)=(.*)$/);
    if (m) meta[m[1]] = m[2].trim(); else datos.push(l);
  }
  const crudos = sistema === 'windows' ? parsearWindows(datos) : parsearSsNetstatLinux(datos);
  const contenedores = sistema === 'windows' ? new Map() : parsearDocker(sec.DOCKER || []);
  const puertos = consolidar(crudos, contenedores);
  const fuente = meta.FUENTE || (sistema === 'windows' ? 'cmdlets' : 'ninguna');
  const conPermisosTotales = sistema === 'windows' ? true : (meta.ROOT === '0' || /sudo/.test(fuente));
  return { fuente, puertos, resumen: resumir(puertos), procesosCompletos: conPermisosTotales, hayDocker: contenedores.size > 0 };
}

function mensajeErrorSsh(err) {
  const m = String((err && err.message) || err || '');
  if (/Timeout/i.test(m)) return 'El servidor no respondió por SSH a tiempo (sin conexión o puerto 22 bloqueado).';
  if (/ECONNREFUSED/i.test(m)) return 'El servidor rechazó la conexión SSH (el servicio SSH no está activo o el puerto está cerrado).';
  if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i.test(m)) return 'No hay ruta hasta el servidor (IP inalcanzable o nombre no resuelto).';
  if (/authentication/i.test(m)) return 'El servidor rechazó la llave SSH del sistema (usuario o llave no autorizados en ese servidor).';
  if (/ECONNRESET|socket hang up|Connection lost|closed/i.test(m)) return 'La conexión SSH se cortó. Intenta de nuevo en unos segundos.';
  if (/ENOENT/i.test(m) && /key|pem|llave/i.test(m)) return 'No se encontró el archivo de la llave SSH configurada en el servidor de la aplicación.';
  return `No se pudo consultar por SSH: ${m.slice(0, 200) || 'error desconocido'}`;
}

async function porSsh(host, so, comando) {
  try {
    return { salida: await ejecutarSSH(host, comando, so === 'linux' ? 25000 : 40000), metodo: 'ssh' };
  } catch (err) {
    const e = new Error(mensajeErrorSsh(err));
    e.amigable = true;
    throw e;
  }
}

async function porWinrm(host, comando, lib) {
  try {
    return { salida: await ejecutarWinrm(host, comando, 40000, lib), metodo: 'winrm' };
  } catch (err) {
    if (err && err.amigable) throw err;
    const e = new Error(mensajeErrorWinrm(err));
    e.amigable = true;
    throw e;
  }
}

// Obtiene el texto del script por el canal que corresponda. En Windows con
// método «auto»: WinRM primero y, si falla, SSH (si está configurado).
async function obtenerSalida(host, so, lib) {
  if (so === 'linux') {
    if (!sshConfigurado()) {
      const e = new Error('El acceso SSH no está configurado en el servidor de la aplicación (faltan SSH_USERNAME y SSH_KEY_PATH en el .env).');
      e.amigable = true;
      throw e;
    }
    return porSsh(host, so, SCRIPT_LINUX);
  }
  const comando = obtenerComandoWindows();
  const metodos = metodosDisponibles('windows');
  if (!metodos.length) {
    const e = new Error('No hay cómo conectar a un Windows: configura WinRM (WINRM_USERNAME y WINRM_PASSWORD) o SSH (SSH_USERNAME y SSH_KEY_PATH) en el .env.');
    e.amigable = true;
    throw e;
  }
  const errores = [];
  for (const m of metodos) {
    try {
      return m === 'winrm' ? await porWinrm(host, comando, lib) : await porSsh(host, so, comando);
    } catch (err) {
      errores.push(`${m === 'winrm' ? 'WinRM' : 'SSH'}: ${err.message}`);
    }
  }
  const e = new Error(errores.join(' · '));
  e.amigable = true;
  throw e;
}

async function consultarPuertos(host, sistemaOperativo, lib = null) {
  const so = String(sistemaOperativo || '').toLowerCase();
  if (so !== 'linux' && so !== 'windows') {
    const e = new Error(`Sistema operativo «${sistemaOperativo || 'sin definir'}» no soportado: solo Linux y Windows.`);
    e.amigable = true;
    throw e;
  }
  const { salida, metodo } = await obtenerSalida(host, so, lib);
  if (!/===PUERTOS===/.test(salida)) {
    const e = new Error(`El servidor respondió por ${metodo === 'winrm' ? 'WinRM' : 'SSH'}, pero no con el formato esperado (revisa que la cuenta pueda ejecutar ${so === 'windows' ? 'PowerShell' : 'comandos de shell'}).`);
    e.amigable = true;
    throw e;
  }
  return { sistema: so, metodo, ...interpretarSalida(so, salida) };
}

module.exports = { consultarPuertos, sshConfigurado, winrmConfigurado, metodosDisponibles, ejecutarWinrm, mensajeErrorWinrm, metodoAuthWinrm, interpretarSalida, parsearSsNetstatLinux, parsearWindows, parsearDocker, separarDireccionPuerto, consolidar, mensajeErrorSsh };
