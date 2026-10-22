const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const fs = require('fs');
const { Client } = require('ssh2');
const { getPool } = require('../db');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const {
  obtenerDockerPortainer,
  listarTodosLosEntornos,
  inspeccionarContenedor,
  logsContenedor,
  ejecutarAccionContenedor,
  listarImagenes,
  eliminarImagen,
  listarRedes,
  eliminarRed,
  listarVolumenes,
  eliminarVolumen,
  listarEventos,
  obtenerInfoHost,
  estadisticasRecursosFlota,
  PORTAINER_CONFIGURADO,
} = require('../utils/portainer');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');

// ==========================================
// CONFIGURACIÓN SSH (misma llave para todos los servidores)
// ==========================================
// La llave NUNCA vive en la base de datos. Se lee de un archivo en disco,
// cuya ruta viene de una variable de entorno. Configura en tu .env:
//   SSH_USERNAME=monitor
//   SSH_KEY_PATH=/ruta/segura/a/la/llave_privada
//   SSH_PORT=22   (opcional, 22 por defecto)
//
// Para que la sección de Docker funcione, SSH_USERNAME debe poder ejecutar
// `docker` sin sudo en cada servidor (típicamente perteneciendo al grupo
// `docker`). Si no puede, o si el servidor no tiene Docker instalado, esa
// sección simplemente se marca como no disponible sin romper el resto.
const SSH_USERNAME = process.env.SSH_USERNAME;
const SSH_KEY_PATH = process.env.SSH_KEY_PATH;
const SSH_PORT = process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22;

if (!SSH_USERNAME || !SSH_KEY_PATH) {
  console.warn(
    '⚠️  SSH_USERNAME o SSH_KEY_PATH no están configurados en el .env — ' +
    'el monitoreo por SSH no va a poder conectarse a ningún servidor hasta que los definas.'
  );
}

let llavePrivada = null;
function obtenerLlavePrivada() {
  if (!llavePrivada && SSH_KEY_PATH) {
    llavePrivada = fs.readFileSync(SSH_KEY_PATH);
  }
  return llavePrivada;
}

// ==========================================
// EJECUCIÓN REMOTA POR SSH
// ==========================================
function ejecutarComandoSSH(host, comando, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const temporizador = setTimeout(() => {
      conn.end();
      reject(new Error('Timeout conectando por SSH'));
    }, timeoutMs);

    conn
      .on('ready', () => {
        conn.exec(comando, (err, stream) => {
          if (err) {
            clearTimeout(temporizador);
            conn.end();
            return reject(err);
          }
          let salida = '';
          let errorSalida = '';
          stream
            .on('close', () => {
              clearTimeout(temporizador);
              conn.end();
              if (errorSalida && !salida) return reject(new Error(errorSalida));
              resolve(salida.trim());
            })
            .on('data', (data) => { salida += data.toString(); })
            .stderr.on('data', (data) => { errorSalida += data.toString(); });
        });
      })
      .on('error', (err) => {
        clearTimeout(temporizador);
        reject(err);
      })
      .connect({
        host,
        port: SSH_PORT,
        username: SSH_USERNAME,
        privateKey: obtenerLlavePrivada(),
        readyTimeout: timeoutMs,
      });
  });
}

// ==========================================
// UN SOLO SCRIPT, UNA SOLA CONEXIÓN SSH POR SERVIDOR POR REFRESCO
// ==========================================
// Se probó separar sistema y Docker en dos conexiones SSH paralelas para
// que Docker lento no bloqueara las métricas básicas — pero abrir 2
// conexiones nuevas cada 4 segundos (30/minuto solo por este servidor)
// terminó saturando el sshd remoto (se vieron "Connection reset" incluso
// en sesiones manuales). Se vuelve a UNA sola conexión, y en su lugar se
// protege el bloque de Docker con el comando `timeout` de Linux: si Docker
// se cuelga, se lo mata a los pocos segundos y el script sigue — ya
// imprimió las métricas de sistema antes de siquiera tocar Docker, así que
// esas nunca se ven afectadas.
//
// IMPORTANTE: se quitó la bandera `-s` de `docker ps` (que calcula el
// tamaño de la capa de escritura de cada contenedor). Docker mismo advierte
// que esa bandera puede ser lenta/bloqueante con muchos contenedores —con
// ~25 contenedores llegó a colgar la respuesta varios segundos y dejaba
// toda la tarjeta en blanco. El espacio en disco de Docker se sigue viendo
// igual de bien con `docker system df` (agregado, rápido), sólo que ya no
// se muestra un tamaño individual por contenedor.
// ==========================================
const SCRIPT_LINUX = `
CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2+$4}')
MEM_USADA=$(free -m | awk '/Mem:/ {printf "%.2f", $3/1024}')
MEM_TOTAL=$(free -m | awk '/Mem:/ {printf "%.2f", $2/1024}')
UPTIME_DIAS=$(awk '{print int($1/86400)}' /proc/uptime)
USUARIO=$(whoami)
RX1=$(cat /proc/net/dev | grep -v "lo:" | awk '{rx+=$2} END{print rx}')
TX1=$(cat /proc/net/dev | grep -v "lo:" | awk '{tx+=$10} END{print tx}')
sleep 1
RX2=$(cat /proc/net/dev | grep -v "lo:" | awk '{rx+=$2} END{print rx}')
TX2=$(cat /proc/net/dev | grep -v "lo:" | awk '{tx+=$10} END{print tx}')
echo "===SISTEMA==="
echo "CPU=$CPU"
echo "MEM_USADA=$MEM_USADA"
echo "MEM_TOTAL=$MEM_TOTAL"
echo "UPTIME_DIAS=$UPTIME_DIAS"
echo "USUARIO=$USUARIO"
echo "BAJADA_BPS=$((RX2-RX1))"
echo "SUBIDA_BPS=$((TX2-TX1))"
echo "===DISCOS==="
df -h -x tmpfs -x devtmpfs -x overlay --output=target,pcent 2>/dev/null | tail -n +2 | while read -r destino porcentaje; do
  destino_seguro=$(echo "$destino" | tr '/' '_')
  echo "DISCO_$destino_seguro=$porcentaje"
done

export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
DOCKER_BIN=$(command -v docker 2>/dev/null)

# Los comandos de Docker se capturan a un ARCHIVO (no con "$(...)", que crea
# una tubería que puede quedar abierta si el proceso deja algo huérfano) y
# usan "timeout -k", que garantiza un SIGKILL si el proceso ignora la señal
# normal — así ningún cuelgue de Docker puede bloquear la conexión SSH
# completa (y con ella las métricas de CPU/memoria, que ya se mandaron).
# El formato pide los campos UNO POR UNO con un separador propio ("@@@") en
# vez de "{{json .}}": en algunos servidores esa combinación puede colgar
# el comando indefinidamente aunque el binario y el daemon respondan bien.
echo "===DOCKER_PS==="
if [ -n "$DOCKER_BIN" ]; then
  ARCHIVO_PS="/tmp/.mon_docker_ps_$$"
  timeout -k 3 8 "$DOCKER_BIN" ps -a --format '{{.ID}}@@@{{.Names}}@@@{{.Image}}@@@{{.State}}@@@{{.Status}}@@@{{.Ports}}' > "$ARCHIVO_PS" 2>&1 </dev/null
  CODIGO_PS=$?
  cat "$ARCHIVO_PS" 2>/dev/null
  rm -f "$ARCHIVO_PS" 2>/dev/null
else
  CODIGO_PS=-1
fi
echo "===DOCKER_PS_META==="
echo "CODIGO_SALIDA_PS=$CODIGO_PS"

echo "===DOCKER_STATS==="
if [ -n "$DOCKER_BIN" ]; then
  ARCHIVO_STATS="/tmp/.mon_docker_stats_$$"
  timeout -k 3 8 "$DOCKER_BIN" stats --no-stream --format '{{.ID}}@@@{{.CPUPerc}}@@@{{.MemUsage}}@@@{{.MemPerc}}@@@{{.NetIO}}@@@{{.BlockIO}}@@@{{.PIDs}}' > "$ARCHIVO_STATS" 2>&1 </dev/null
  CODIGO_STATS=$?
  cat "$ARCHIVO_STATS" 2>/dev/null
  rm -f "$ARCHIVO_STATS" 2>/dev/null
else
  CODIGO_STATS=-1
fi
echo "===DOCKER_STATS_META==="
echo "CODIGO_SALIDA_STATS=$CODIGO_STATS"

echo "===DOCKER_DF==="
if [ -n "$DOCKER_BIN" ]; then
  ARCHIVO_DF="/tmp/.mon_docker_df_$$"
  timeout -k 2 5 "$DOCKER_BIN" system df --format '{{.Type}}@@@{{.TotalCount}}@@@{{.Active}}@@@{{.Size}}@@@{{.Reclaimable}}' > "$ARCHIVO_DF" 2>&1 </dev/null
  CODIGO_DF=$?
  cat "$ARCHIVO_DF" 2>/dev/null
  rm -f "$ARCHIVO_DF" 2>/dev/null
else
  CODIGO_DF=-1
fi
echo "===DOCKER_DF_META==="
echo "CODIGO_SALIDA_DF=$CODIGO_DF"

echo "===FIN==="
`.trim();

// ==========================================
// SCRIPT WINDOWS (PowerShell) — MISMO formato de salida que SCRIPT_LINUX
// ==========================================
// No es un archivo .ps1 que se sube al servidor: se manda como UN SOLO
// comando "powershell -EncodedCommand <base64>" por el mismo canal SSH que
// usa Linux (el servidor Windows necesita el feature opcional "OpenSSH
// Server" activado, con PowerShell alcanzable en el PATH del usuario SSH).
// Se codifica en base64 (UTF-16LE, como PowerShell espera) para no tener
// que escapar comillas ni backticks al viajar por Node -> canal SSH ->
// intérprete remoto -> PowerShell: con -Command habría que escapar cada
// comilla doble del script; con -EncodedCommand no hace falta escapar nada.
//
// Requisitos en el servidor Windows (ver instructivo):
//  - Feature "OpenSSH Server" instalado y el servicio sshd corriendo.
//  - El usuario de SSH_USERNAME existe como cuenta LOCAL de Windows (mismo
//    nombre) y pertenece al grupo Administradores — CIM/WMI y Docker
//    normalmente lo requieren.
//  - Por ser cuenta de Administrador, Win32-OpenSSH exige la llave pública
//    en C:\ProgramData\ssh\administrators_authorized_keys (un archivo del
//    sistema, no en el .ssh\authorized_keys normal del usuario).
//  - El módulo NetAdapter (Get-NetAdapterStatistics) — viene de fábrica en
//    Windows Server 2012+/Windows 8+. Si no está, sólo se pierde la
//    métrica de red; el resto del script sigue funcionando.
const SCRIPT_WINDOWS_FUENTE = `
$ErrorActionPreference = 'SilentlyContinue'

function Invoke-ConTimeout {
  param([string]$Ruta, [string]$Argumentos, [int]$SegundosLimite)
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Ruta
    $psi.Arguments = $Argumentos
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    # Se leen los streams de forma asíncrona ANTES de esperar a que termine
    # el proceso — leerlos después de WaitForExit() puede quedar en
    # deadlock si la salida es grande (buffer de .NET lleno bloqueando al
    # proceso hijo, que a su vez nunca termina). Mismo espíritu que el
    # "timeout -k" del lado Linux: garantizar que esto SIEMPRE termina.
    $tareaSalida = $proc.StandardOutput.ReadToEndAsync()
    $tareaError = $proc.StandardError.ReadToEndAsync()
    $terminado = $proc.WaitForExit($SegundosLimite * 1000)
    if (-not $terminado) {
      try { $proc.Kill() } catch {}
      return @{ Salida = ''; Codigo = 124 }
    }
    return @{ Salida = ($tareaSalida.Result + $tareaError.Result); Codigo = $proc.ExitCode }
  } catch {
    return @{ Salida = ''; Codigo = -1 }
  }
}

# ===== MÉTRICAS DE SISTEMA =====
try { $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average } catch { $cpu = 0 }
if ($null -eq $cpu) { $cpu = 0 }

try {
  $osInfo = Get-CimInstance Win32_OperatingSystem
  $memTotalGb = [math]::Round($osInfo.TotalVisibleMemorySize / 1024 / 1024, 2)
  $memUsadaGb = [math]::Round(($osInfo.TotalVisibleMemorySize - $osInfo.FreePhysicalMemory) / 1024 / 1024, 2)
  $uptimeDias = [int]((Get-Date) - $osInfo.LastBootUpTime).Days
} catch {
  $memTotalGb = 0; $memUsadaGb = 0; $uptimeDias = 0
}

$usuario = $env:USERNAME

try {
  $rx1 = (Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum
  $tx1 = (Get-NetAdapterStatistics | Measure-Object -Property SentBytes -Sum).Sum
  Start-Sleep -Seconds 1
  $rx2 = (Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum
  $tx2 = (Get-NetAdapterStatistics | Measure-Object -Property SentBytes -Sum).Sum
  $bajadaBps = $rx2 - $rx1
  $subidaBps = $tx2 - $tx1
} catch {
  $bajadaBps = 0; $subidaBps = 0
}

Write-Output "===SISTEMA==="
Write-Output "CPU=$cpu"
Write-Output "MEM_USADA=$memUsadaGb"
Write-Output "MEM_TOTAL=$memTotalGb"
Write-Output "UPTIME_DIAS=$uptimeDias"
Write-Output "USUARIO=$usuario"
Write-Output "BAJADA_BPS=$bajadaBps"
Write-Output "SUBIDA_BPS=$subidaBps"

Write-Output "===DISCOS==="
try {
  Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
    if ($_.Size -gt 0) {
      $letra = $_.DeviceID.TrimEnd(':')
      $pct = [int](100 - ($_.FreeSpace / $_.Size * 100))
      Write-Output "DISCO_$letra=$pct%"
    }
  }
} catch {}

# ===== DOCKER: mismos --format que en Linux (el CLI de docker es idéntico
# en Windows), sólo cambia cómo se invoca y se limita por tiempo =====
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue

Write-Output "===DOCKER_PS==="
if ($dockerCmd) {
  $r = Invoke-ConTimeout -Ruta $dockerCmd.Source -Argumentos 'ps -a --format "{{.ID}}@@@{{.Names}}@@@{{.Image}}@@@{{.State}}@@@{{.Status}}@@@{{.Ports}}"' -SegundosLimite 8
  Write-Output $r.Salida
  $codigoPs = $r.Codigo
} else {
  $codigoPs = -1
}
Write-Output "===DOCKER_PS_META==="
Write-Output "CODIGO_SALIDA_PS=$codigoPs"

Write-Output "===DOCKER_STATS==="
if ($dockerCmd) {
  $r = Invoke-ConTimeout -Ruta $dockerCmd.Source -Argumentos 'stats --no-stream --format "{{.ID}}@@@{{.CPUPerc}}@@@{{.MemUsage}}@@@{{.MemPerc}}@@@{{.NetIO}}@@@{{.BlockIO}}@@@{{.PIDs}}"' -SegundosLimite 8
  Write-Output $r.Salida
  $codigoStats = $r.Codigo
} else {
  $codigoStats = -1
}
Write-Output "===DOCKER_STATS_META==="
Write-Output "CODIGO_SALIDA_STATS=$codigoStats"

Write-Output "===DOCKER_DF==="
if ($dockerCmd) {
  $r = Invoke-ConTimeout -Ruta $dockerCmd.Source -Argumentos 'system df --format "{{.Type}}@@@{{.TotalCount}}@@@{{.Active}}@@@{{.Size}}@@@{{.Reclaimable}}"' -SegundosLimite 5
  Write-Output $r.Salida
  $codigoDf = $r.Codigo
} else {
  $codigoDf = -1
}
Write-Output "===DOCKER_DF_META==="
Write-Output "CODIGO_SALIDA_DF=$codigoDf"

Write-Output "===FIN==="
`.trim();

// Se codifica UNA sola vez (no en cada refresco de cada servidor) y se
// guarda en memoria — el script fuente es estático, no depende de nada
// por servidor.
let comandoWindowsCacheado = null;
function obtenerComandoWindows() {
  if (!comandoWindowsCacheado) {
    const base64 = Buffer.from(SCRIPT_WINDOWS_FUENTE, 'utf16le').toString('base64');
    comandoWindowsCacheado = `powershell -NoProfile -NonInteractive -EncodedCommand ${base64}`;
  }
  return comandoWindowsCacheado;
}

// Separador de campos que se le pide a docker en los --format, en vez de
// "{{json .}}" (ver comentario junto a SCRIPT_LINUX).
const SEPARADOR_CAMPOS = '@@@';

// Separa la salida del script en bloques según los marcadores "===NOMBRE===".
function dividirEnSecciones(salida) {
  const secciones = {};
  let actual = null;
  salida.split('\n').forEach((linea) => {
    const m = linea.match(/^===([A-Z_]+)===$/);
    if (m) {
      actual = m[1];
      secciones[actual] = [];
      return;
    }
    if (actual && linea.trim() !== '') {
      secciones[actual].push(linea);
    }
  });
  return secciones;
}

function parsearContenedoresDocker(lineas, metaPs) {
  const codigo = (metaPs && metaPs.CODIGO_SALIDA_PS) || '';

  if (lineas.length === 0 || lineas[0].trim() === 'SIN_DOCKER') {
    // Mensaje corto que se muestra en la tarjeta cuando Docker no responde,
    // para que se pueda diagnosticar sin tener que abrir la consola.
    let debugDocker;
    if (codigo === '' || codigo === '-1') {
      debugDocker = 'No se encontró el binario de docker (ni en PATH ni en las rutas conocidas).';
    } else if (codigo === '124' || codigo === '137') {
      debugDocker = `"docker ps -a" se colgó y hubo que matarlo por timeout (código ${codigo}).`;
    } else if (codigo !== '0') {
      debugDocker = `"docker ps -a" terminó con código de salida ${codigo} sin producir salida (revisar permisos del usuario SSH sobre /var/run/docker.sock o si el daemon está corriendo).`;
    } else {
      debugDocker = '"docker ps -a" se ejecutó correctamente (código 0) pero no devolvió ningún contenedor — probablemente no hay ninguno creado en este servidor.';
    }
    return {
      contenedores: [],
      resumenContenedores: { total: 0, corriendo: 0, detenidos: 0 },
      // Si el comando corrió bien (código 0) y de verdad no hay contenedores,
      // Docker SÍ está disponible — sólo que la lista está vacía.
      dockerDisponible: codigo === '0',
      debugDocker,
    };
  }

  // Cada línea viene como "id@@@nombre@@@imagen@@@estado@@@status@@@puertos"
  // (formato campo por campo, en vez de "{{json .}}" que hacía colgar el
  // comando en este servidor).
  const crudos = lineas
    .map((linea) => linea.split(SEPARADOR_CAMPOS))
    .filter((partes) => partes.length >= 6);

  if (crudos.length === 0) {
    // Docker existe (llegamos hasta aquí) pero ninguna línea tenía el
    // formato esperado — casi seguro es un mensaje de error real de docker
    // (permisos, daemon no corriendo, etc.) en vez de la lista. Se muestra
    // tal cual para diagnosticar en vez de fingir "no instalado" sin info.
    return {
      contenedores: [],
      resumenContenedores: { total: 0, corriendo: 0, detenidos: 0 },
      dockerDisponible: false,
      debugDocker: `docker respondió algo inesperado: ${lineas.join(' | ').slice(0, 400)}`,
    };
  }

  const contenedores = crudos.map((p) => ({
    id: (p[0] || '').trim().substring(0, 12),
    nombre: (p[1] || '').trim(),
    imagen: (p[2] || '').trim(),
    estado: (p[3] || '').trim().toLowerCase(), // running, exited, paused, restarting, dead...
    estadoTexto: (p[4] || '').trim(),
    puertos: (p[5] || '').trim(),
  }));

  const corriendo = contenedores.filter((c) => c.estado === 'running').length;

  return {
    contenedores,
    resumenContenedores: { total: contenedores.length, corriendo, detenidos: contenedores.length - corriendo },
    dockerDisponible: true,
  };
}

// `docker stats --no-stream` sólo reporta contenedores CORRIENDO (a
// diferencia de `docker ps -a`, que incluye los detenidos) — es lo
// esperado, un contenedor parado no consume CPU/memoria en vivo.
function parsearStatsDocker(lineas) {
  const porId = new Map();
  lineas.forEach((linea) => {
    // "id@@@cpu%@@@memUso@@@mem%@@@redIO@@@discoIO@@@pids"
    const p = linea.split(SEPARADOR_CAMPOS);
    if (p.length < 7) return;
    const id = (p[0] || '').trim().substring(0, 12);
    if (!id) return;
    porId.set(id, {
      cpuPorcentaje: (p[1] || '0.00%').trim(),
      memUso: (p[2] || '').trim(),          // ej. "70.51MiB / 7.474GiB"
      memPorcentaje: (p[3] || '0.00%').trim(),
      redIO: (p[4] || '').trim(),           // ej. "591kB / 196kB"
      discoIO: (p[5] || '').trim(),         // ej. "2.11MB / 238kB"
      pids: parseInt((p[6] || '0').trim(), 10) || 0,
    });
  });
  return porId;
}

function parsearEspacioDocker(lineas) {
  // "tipo@@@total@@@activos@@@tamaño@@@recuperable"
  return lineas
    .map((linea) => linea.split(SEPARADOR_CAMPOS))
    .filter((p) => p.length >= 5)
    .map((p) => ({
      tipo: (p[0] || '').trim(),
      total: parseInt((p[1] || '0').trim(), 10) || 0,
      activos: parseInt((p[2] || '0').trim(), 10) || 0,
      tamano: (p[3] || '0B').trim(),
      recuperable: (p[4] || '0B').trim(),
    }));
}

// Parsea la salida de SCRIPT_SISTEMA (CPU/memoria/red/uptime/usuario/discos).
function parsearSistema(salida) {
  const secciones = dividirEnSecciones(salida);

  const datos = {};
  (secciones.SISTEMA || []).forEach((linea) => {
    const idx = linea.indexOf('=');
    if (idx === -1) return;
    datos[linea.substring(0, idx).trim()] = linea.substring(idx + 1).trim();
  });

  const discos = {};
  (secciones.DISCOS || []).forEach((linea) => {
    const idx = linea.indexOf('=');
    if (idx === -1) return;
    const clave = linea.substring(0, idx).trim();
    const valor = linea.substring(idx + 1).trim();
    if (!clave.startsWith('DISCO_')) return;
    let punto = clave.replace('DISCO_', '').replace(/_/g, '/');
    if (punto === '') punto = '/';
    discos[punto] = valor;
  });

  const bpsAMbps = (bytesPorSeg) => ((parseInt(bytesPorSeg || '0', 10) * 8) / 1_000_000).toFixed(2);

  return {
    cpu: Math.round(parseFloat(datos.CPU || '0')),
    memUsadaGb: parseFloat(datos.MEM_USADA || '0'),
    memTotalGb: parseFloat(datos.MEM_TOTAL || '0'),
    uptimeDias: parseInt(datos.UPTIME_DIAS || '0', 10),
    usuario: datos.USUARIO || '',
    subidaMbps: bpsAMbps(datos.SUBIDA_BPS),
    bajadaMbps: bpsAMbps(datos.BAJADA_BPS),
    discos,
  };
}

// Convierte una sección de líneas "CLAVE=valor" en un objeto — se usa para
// leer los códigos de salida de los comandos de Docker (DOCKER_PS_META, etc).
function parsearClaveValor(lineas) {
  const datos = {};
  (lineas || []).forEach((linea) => {
    const idx = linea.indexOf('=');
    if (idx === -1) return;
    datos[linea.substring(0, idx).trim()] = linea.substring(idx + 1).trim();
  });
  return datos;
}

// Parsea la salida del bloque Docker (contenedores + recursos + espacio en disco).
function parsearDocker(salida) {
  const secciones = dividirEnSecciones(salida);
  const metaPs = parsearClaveValor(secciones.DOCKER_PS_META || []);
  const resultado = parsearContenedoresDocker(secciones.DOCKER_PS || [], metaPs);
  const statsPorId = parsearStatsDocker(secciones.DOCKER_STATS || []);

  // Cada contenedor se completa con sus recursos en vivo (CPU/mem/red/disco/
  // PIDs) cuando está corriendo; los detenidos quedan con recursos: null.
  const contenedores = resultado.contenedores.map((c) => ({
    ...c,
    recursos: statsPorId.get(c.id) || null,
  }));

  const espacioDocker = parsearEspacioDocker(secciones.DOCKER_DF || []);
  return { ...resultado, contenedores, espacioDocker };
}

// ==========================================
// RUTAS: GRUPO DE MONITOREO (elegido a mano)
// ==========================================

// GET /api/monitoreo/servidores - servidores actualmente en el grupo
router.get('/servidores', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query(`
      SELECT sv.Id AS id, sv.Hostname AS hostname, sv.IP AS ip_address, so.Nombre AS sistema_operativo
      FROM monitoreo_servidores ms
      JOIN Servidores sv ON sv.Id = ms.servidor_id
      LEFT JOIN SistemasOperativos so ON so.Id = sv.SistemaOperativoId
      ORDER BY sv.Hostname
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// POST /api/monitoreo/servidores - agregar un servidor al grupo
router.post('/servidores', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  const { servidor_id } = req.body;
  if (!servidor_id) return res.status(400).json({ error: 'servidor_id es obligatorio' });

  try {
    const pool = await getPool();
    await pool.query(
      'INSERT INTO monitoreo_servidores (servidor_id) VALUES (?) ON DUPLICATE KEY UPDATE servidor_id = servidor_id',
      [servidor_id]
    );

    try {
      const [servidorFilas] = await pool.query('SELECT Hostname FROM Servidores WHERE Id = ?', [servidor_id]);
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVIDORES',
        entidad: 'Grupo de monitoreo',
        entidadId: servidor_id,
        entidadNombre: servidorFilas[0]?.Hostname || `Servidor ${servidor_id}`,
        accion: 'CREACION',
        detalle: 'Servidor agregado al grupo de monitoreo',
      });
    } catch (errAudit) {
      console.error('No se pudo registrar la auditoría de alta en grupo de monitoreo:', errAudit);
    }

    res.status(201).json({ mensaje: 'Servidor agregado al monitoreo' });
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// DELETE /api/monitoreo/servidores/:servidorId - quitar del grupo
router.delete('/servidores/:servidorId', verifyToken, requireModule('SERVIDORES'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [servidorFilas] = await pool.query('SELECT Hostname FROM Servidores WHERE Id = ?', [req.params.servidorId]);

    await pool.query('DELETE FROM monitoreo_servidores WHERE servidor_id = ?', [req.params.servidorId]);

    try {
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVIDORES',
        entidad: 'Grupo de monitoreo',
        entidadId: req.params.servidorId,
        entidadNombre: servidorFilas[0]?.Hostname || `Servidor ${req.params.servidorId}`,
        accion: 'ELIMINACION',
        detalle: 'Servidor quitado del grupo de monitoreo',
      });
    } catch (errAudit) {
      console.error('No se pudo registrar la auditoría de baja en grupo de monitoreo:', errAudit);
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ==========================================
// RUTA: ESTADÍSTICAS EN VIVO
// ==========================================

// GET /api/monitoreo/stats - se conecta por SSH a cada servidor del grupo
// y trae sus métricas actuales, incluyendo contenedores Docker y espacio en
// disco usado por Docker. El frontend llama esto cada pocos segundos.
router.get('/stats', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    const [servidores] = await pool.query(`
      SELECT sv.Id AS id, sv.Hostname AS hostname, sv.IP AS ip_address, so.Nombre AS sistema_operativo
      FROM monitoreo_servidores ms
      JOIN Servidores sv ON sv.Id = ms.servidor_id
      LEFT JOIN SistemasOperativos so ON so.Id = sv.SistemaOperativoId
    `);

    const resultados = await Promise.all(
      servidores.map(async (sv) => {
        const sistemaOperativo = (sv.sistema_operativo || '').toLowerCase();

        // Linux y Windows usan el MISMO canal SSH y el MISMO parser de
        // salida (parsearSistema/parsearDocker) — sólo cambia qué script se
        // manda a ejecutar. Cualquier otro sistema operativo (o uno sin
        // definir en la base de datos) se marca como no soportado en vez de
        // intentar algo que probablemente no funcione.
        if (sistemaOperativo !== 'linux' && sistemaOperativo !== 'windows') {
          return {
            ...sv,
            error: `Sistema operativo "${sv.sistema_operativo || 'sin definir'}" no soportado para monitoreo por SSH.`,
          };
        }

        try {
          // Una sola conexión SSH; dentro del script, cada comando de Docker
          // va acotado por tiempo (bash: "timeout -k"; PowerShell:
          // Invoke-ConTimeout), así que el peor caso del script es ~34s
          // (8s+3s ps, 8s+3s stats, 5s+2s df, más las métricas de sistema).
          // Este límite general de 45s queda por encima de ese peor caso
          // con margen; en el caso normal responde en 2-3 segundos.
          const comando = sistemaOperativo === 'linux' ? SCRIPT_LINUX : obtenerComandoWindows();
          const salida = await ejecutarComandoSSH(sv.ip_address, comando, 45000);
          const sistema = parsearSistema(salida);
          let docker = parsearDocker(salida);
          let origenDocker = 'ssh';

          // Si Portainer tiene un environment cuyo nombre coincide con el
          // hostname de este servidor, se usa esa información para la
          // sección de Docker en vez de la que se acaba de parsear por SSH
          // — trae más detalle por contenedor (comando, redes, volúmenes) y
          // no depende de parsear texto de `docker ps`/`docker stats`. Las
          // métricas del HOST (CPU/memoria/disco/uptime) siguen viniendo
          // siempre por SSH, eso no lo toca Portainer. Si Portainer no está
          // configurado, no tiene environment para este hostname, o la
          // consulta falla por cualquier motivo, se conserva tal cual lo
          // que ya se sacó por SSH arriba — nunca rompe el resto.
          try {
            const dockerPortainer = await obtenerDockerPortainer(sv.hostname);
            if (dockerPortainer) {
              docker = dockerPortainer;
              origenDocker = 'portainer';
            }
          } catch (e) {
            console.warn(`Portainer no disponible para ${sv.hostname}: ${e.message}`);
          }

          return {
            ...sv,
            ...sistema,
            ...docker,
            origenDocker,
            error: null,
          };
        } catch (e) {
          return { ...sv, error: e.message || 'No se pudo conectar por SSH' };
        }
      })
    );

    res.json(resultados);
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// ==========================================
// RUTA: ENTORNOS DE PORTAINER (vista directa, sin grupo de monitoreo)
// ==========================================

// GET /api/monitoreo/portainer/entornos - todos los entornos que Portainer
// conoce, con su lista de contenedores. A diferencia de /stats, esto NO
// depende de que el servidor esté agregado al grupo de monitoreo por SSH —
// es la misma vista que se ve al entrar directamente a Portainer. Si el
// nombre del entorno coincide con el hostname de un servidor ya
// inventariado, se agrega esa referencia (servidorId/ipInventario) para
// poder enlazar a Inventario DB; si no hay coincidencia, el entorno se
// muestra igual (puede ser un Docker que ni siquiera está en el inventario).
router.get('/portainer/entornos', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  if (!PORTAINER_CONFIGURADO) {
    return res.json({ configurado: false, entornos: [], error: null });
  }

  // Paso 1: consultar Portainer. Si Portainer está caído, mal configurado
  // (URL/usuario/contraseña equivocados, certificado TLS, red), esto NO debe
  // tumbar toda la pantalla con un 500 genérico — se responde 200 igual,
  // con el motivo en "error", para que el frontend muestre un mensaje claro
  // en vez del error genérico de la aplicación.
  let entornos;
  try {
    entornos = await listarTodosLosEntornos();
  } catch (err) {
    console.warn(`No se pudo consultar Portainer: ${err.message}`);
    return res.json({ configurado: true, entornos: [], error: mensajeErrorAmigable(err) });
  }

  // Paso 2: cruzar con Inventario DB para enlazar servidorId/ipInventario.
  // Si esto falla, se muestran los entornos igual, sólo sin ese enlace —
  // el detalle de Portainer ya se obtuvo y es lo importante.
  try {
    const pool = await getPool();
    const [servidores] = await pool.query('SELECT Id AS id, Hostname AS hostname, IP AS ip_address FROM Servidores');

    // Coincidencia exacta (nombre completo, sin mayúsculas/espacios) no
    // alcanza en la práctica: algunos hostnames en Inventario traen sufijo
    // de dominio ("FABOGDOCK09.bancofinandina.local") o separadores que el
    // nombre del entorno en Portainer no tiene ("FABOG-DOCK-09"), y la
    // tarjeta se queda sin enlazar aunque el servidor sí esté inventariado.
    // Se prueban 3 variantes, de más estricta a más laxa, y sólo se usa una
    // variante laxa si el resultado es único (si dos servidores distintos
    // normalizan igual, se descarta esa clave para no inventar un enlace
    // equivocado).
    // "FABOGDOCK014" (Portainer) vs "FABOGDOCK14" (Inventario, sin cero a la
    // izquierda) es otra variación real de numeración — se normaliza también
    // quitando los ceros a la izquierda del número final del nombre.
    const sinCerosDelNumeroFinal = (texto) => {
      const m = texto.match(/^(.*?)(\d+)$/);
      if (!m) return texto;
      const numeroSinCeros = m[2].replace(/^0+(?=\d)/, '');
      return m[1] + numeroSinCeros;
    };

    const normalizar = (valor) => {
      const base = (valor || '').trim().toLowerCase();
      const soloAlfanumerico = base.replace(/[^a-z0-9]/g, '');
      return {
        base,
        sinDominio: base.split('.')[0],
        soloAlfanumerico,
        sinCerosIniciales: sinCerosDelNumeroFinal(soloAlfanumerico),
      };
    };

    const construirMapa = (variante) => {
      const mapa = new Map();
      const ambiguos = new Set();
      for (const s of servidores) {
        const clave = normalizar(s.hostname)[variante];
        if (!clave) continue;
        const existente = mapa.get(clave);
        if (existente && existente.id !== s.id) {
          ambiguos.add(clave);
          continue;
        }
        mapa.set(clave, s);
      }
      ambiguos.forEach((clave) => mapa.delete(clave));
      return mapa;
    };

    const mapaExacto = construirMapa('base');
    const mapaSinDominio = construirMapa('sinDominio');
    const mapaAlfanumerico = construirMapa('soloAlfanumerico');
    const mapaSinCerosIniciales = construirMapa('sinCerosIniciales');

    // La IP mostrada prioriza Inventario DB (la fuente "oficial") pero, si el
    // servidor todavía no está dado de alta ahí, se usa la IP que ya trae el
    // propio entorno de Portainer (ipPortainer, tomada de la URL de conexión
    // del agente) — así una tarjeta no se queda sin IP sólo porque a alguien
    // se le pasó agregar ese servidor a Inventario.
    entornos = entornos.map((e) => {
      const n = normalizar(e.nombre);
      const servidor =
        mapaExacto.get(n.base) ||
        mapaSinDominio.get(n.sinDominio) ||
        mapaAlfanumerico.get(n.soloAlfanumerico) ||
        mapaSinCerosIniciales.get(n.sinCerosIniciales) ||
        null;
      return {
        ...e,
        servidorId: servidor ? servidor.id : null,
        ipInventario: servidor ? servidor.ip_address : (e.ipPortainer || null),
      };
    });
  } catch (err) {
    console.warn(`No se pudo cruzar entornos de Portainer con Inventario DB: ${err.message}`);
    // Aunque falle el cruce con Inventario DB, la IP que trae Portainer
    // directamente sigue sirviendo — no dejar las tarjetas sin nada.
    entornos = entornos.map((e) => ({ ...e, ipInventario: e.ipPortainer || null }));
  }

  res.json({ configurado: true, entornos, error: null });
});

// ==========================================
// RUTAS: DETALLE, LOGS Y ACCIONES SOBRE UN CONTENEDOR PUNTUAL
// ==========================================
// No se traen junto con la lista de /portainer/entornos para no pagar ese
// costo extra (un "inspect" y hasta 200 líneas de log) en CADA refresco
// automático de TODOS los contenedores de TODOS los entornos — sólo se
// piden cuando el usuario abre el detalle de uno puntual.

// GET .../contenedores/:contenedorId - inspect resumido (comando, fechas,
// política de reinicio, redes, volúmenes, etiquetas).
router.get(
  '/portainer/entornos/:entornoId/contenedores/:contenedorId',
  verifyToken,
  requireModule('SERVIDORES'),
  async (req, res) => {
    try {
      const detalle = await inspeccionarContenedor(req.params.entornoId, req.params.contenedorId);
      res.json(detalle);
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// GET .../contenedores/:contenedorId/logs?tail=200 - últimas N líneas.
router.get(
  '/portainer/entornos/:entornoId/contenedores/:contenedorId/logs',
  verifyToken,
  requireModule('SERVIDORES'),
  async (req, res) => {
    try {
      const tail = parseInt(req.query.tail, 10) || 200;
      const texto = await logsContenedor(req.params.entornoId, req.params.contenedorId, tail);
      res.json({ texto });
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// POST .../contenedores/:contenedorId/accion { accion } - start/stop/
// restart/pause/unpause/kill/remove. Sólo administradores
// (requireEditPermission, el mismo criterio que ya usan otras rutas de este
// archivo para agregar/quitar servidores del grupo de monitoreo): un
// usuario BASIC puede ver todo el detalle de arriba, pero no puede operar
// contenedores.
router.post(
  '/portainer/entornos/:entornoId/contenedores/:contenedorId/accion',
  verifyToken,
  requireModule('SERVIDORES'),
  requireEditPermission,
  async (req, res) => {
    const { accion } = req.body;
    const { entornoId, contenedorId } = req.params;

    // Se intenta traer el nombre del contenedor solo para que la auditoría
    // quede legible (si esto falla, se audita igual usando el id).
    let nombreContenedor = contenedorId;
    try {
      const detalle = await inspeccionarContenedor(entornoId, contenedorId);
      if (detalle?.nombre) nombreContenedor = detalle.nombre;
    } catch (errNombre) {
      console.error('No se pudo obtener el nombre del contenedor para auditoría:', errNombre.message);
    }

    try {
      await ejecutarAccionContenedor(entornoId, contenedorId, accion);

      try {
        const pool = await getPool();
        await registrarEventoGeneral(pool, req, {
          modulo: 'SERVIDORES',
          entidad: 'Contenedor Docker',
          entidadId: `${entornoId}:${contenedorId}`,
          entidadNombre: nombreContenedor,
          accion: 'ACCION_CONTENEDOR',
          detalle: `Acción "${accion}" aplicada al contenedor "${nombreContenedor}" (entorno ${entornoId})`,
        });
      } catch (errAudit) {
        console.error('No se pudo registrar la auditoría de la acción sobre el contenedor:', errAudit);
      }

      res.json({ mensaje: `Acción "${accion}" aplicada correctamente.` });
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// ==========================================
// RUTAS: IMÁGENES, REDES Y VOLÚMENES DE UN ENTORNO (Fase 2 — misma idea que
// las secciones Images/Networks/Volumes de Portainer). Ver detalle/logs/
// acción arriba: mismo criterio de permisos (lectura para todos, eliminar
// sólo con requireEditPermission).
// ==========================================

// GET .../imagenes - lista de imágenes Docker del entorno.
router.get(
  '/portainer/entornos/:entornoId/imagenes',
  verifyToken,
  requireModule('SERVIDORES'),
  async (req, res) => {
    try {
      const imagenes = await listarImagenes(req.params.entornoId);
      res.json(imagenes);
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// DELETE .../imagenes/:imagenId
router.delete(
  '/portainer/entornos/:entornoId/imagenes/:imagenId',
  verifyToken,
  requireModule('SERVIDORES'),
  requireEditPermission,
  async (req, res) => {
    const { entornoId, imagenId } = req.params;

    // Best-effort: se busca el tag de la imagen en la lista del entorno
    // solo para que la auditoría quede legible (si falla, se audita con el id).
    let nombreImagen = imagenId;
    try {
      const imagenes = await listarImagenes(entornoId);
      const encontrada = imagenes.find((img) => img.id === imagenId);
      if (encontrada?.tags?.length) nombreImagen = encontrada.tags.join(', ');
    } catch (errNombre) {
      console.error('No se pudo obtener el tag de la imagen para auditoría:', errNombre.message);
    }

    try {
      await eliminarImagen(entornoId, imagenId);

      try {
        const pool = await getPool();
        await registrarEventoGeneral(pool, req, {
          modulo: 'SERVIDORES',
          entidad: 'Imagen Docker',
          entidadId: `${entornoId}:${imagenId}`,
          entidadNombre: nombreImagen,
          accion: 'ELIMINACION',
          detalle: `Imagen eliminada (entorno ${entornoId})`,
        });
      } catch (errAudit) {
        console.error('No se pudo registrar la auditoría de la eliminación de imagen:', errAudit);
      }

      res.json({ mensaje: 'Imagen eliminada correctamente.' });
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// GET .../redes - lista de redes Docker del entorno.
router.get(
  '/portainer/entornos/:entornoId/redes',
  verifyToken,
  requireModule('SERVIDORES'),
  async (req, res) => {
    try {
      const redes = await listarRedes(req.params.entornoId);
      res.json(redes);
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// DELETE .../redes/:redId
router.delete(
  '/portainer/entornos/:entornoId/redes/:redId',
  verifyToken,
  requireModule('SERVIDORES'),
  requireEditPermission,
  async (req, res) => {
    const { entornoId, redId } = req.params;

    // Best-effort: se busca el nombre de la red en la lista del entorno
    // solo para que la auditoría quede legible (si falla, se audita con el id).
    let nombreRed = redId;
    try {
      const redes = await listarRedes(entornoId);
      const encontrada = redes.find((r) => r.id === redId);
      if (encontrada?.nombre) nombreRed = encontrada.nombre;
    } catch (errNombre) {
      console.error('No se pudo obtener el nombre de la red para auditoría:', errNombre.message);
    }

    try {
      await eliminarRed(entornoId, redId);

      try {
        const pool = await getPool();
        await registrarEventoGeneral(pool, req, {
          modulo: 'SERVIDORES',
          entidad: 'Red Docker',
          entidadId: `${entornoId}:${redId}`,
          entidadNombre: nombreRed,
          accion: 'ELIMINACION',
          detalle: `Red eliminada (entorno ${entornoId})`,
        });
      } catch (errAudit) {
        console.error('No se pudo registrar la auditoría de la eliminación de red:', errAudit);
      }

      res.json({ mensaje: 'Red eliminada correctamente.' });
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// GET .../volumenes - lista de volúmenes Docker del entorno.
router.get(
  '/portainer/entornos/:entornoId/volumenes',
  verifyToken,
  requireModule('SERVIDORES'),
  async (req, res) => {
    try {
      const volumenes = await listarVolumenes(req.params.entornoId);
      res.json(volumenes);
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// DELETE .../volumenes/:nombre
router.delete(
  '/portainer/entornos/:entornoId/volumenes/:nombre',
  verifyToken,
  requireModule('SERVIDORES'),
  requireEditPermission,
  async (req, res) => {
    const { entornoId, nombre } = req.params;
    try {
      await eliminarVolumen(entornoId, nombre);

      try {
        const pool = await getPool();
        await registrarEventoGeneral(pool, req, {
          modulo: 'SERVIDORES',
          entidad: 'Volumen Docker',
          entidadId: `${entornoId}:${nombre}`,
          entidadNombre: nombre,
          accion: 'ELIMINACION',
          detalle: `Volumen eliminado (entorno ${entornoId})`,
        });
      } catch (errAudit) {
        console.error('No se pudo registrar la auditoría de la eliminación de volumen:', errAudit);
      }

      res.json({ mensaje: 'Volumen eliminado correctamente.' });
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// ==========================================
// RUTAS: EVENTOS Y HOST DE UN ENTORNO (Fase 3 — última fase, sólo lectura,
// no hay acción de admin que ejecutar sobre ninguna de las dos).
// ==========================================

// GET .../eventos?minutos=60 - eventos de Docker (start/stop/create/destroy/
// pull, etc.) del entorno en el rango de tiempo pedido.
router.get(
  '/portainer/entornos/:entornoId/eventos',
  verifyToken,
  requireModule('SERVIDORES'),
  async (req, res) => {
    try {
      const minutos = parseInt(req.query.minutos, 10) || 60;
      const eventos = await listarEventos(req.params.entornoId, minutos);
      res.json(eventos);
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// GET .../host - datos en vivo del host Docker de este entorno.
router.get(
  '/portainer/entornos/:entornoId/host',
  verifyToken,
  requireModule('SERVIDORES'),
  async (req, res) => {
    try {
      const host = await obtenerInfoHost(req.params.entornoId);
      res.json(host);
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// ==========================================
// ANÁLISIS ESTADÍSTICO: vista agregada de TODO el parque de Portainer —
// resumen de salud, top de consumidores de CPU/memoria e imágenes/redes/
// volúmenes se piden aparte (ver rutas de abajo) porque son más pesados
// que el poll normal de 6s y sólo hacen falta cuando el usuario entra a
// esta sección, no en cada refresco de la grilla de entornos.
// ==========================================

// GET /portainer/estadisticas - imágenes/redes/volúmenes de TODOS los
// entornos activos, ya agregados (conteos y espacio total). El resumen de
// salud y el top de consumidores NO necesitan ruta propia: se calculan en
// el frontend a partir de lo que ya trae /portainer/entornos.
router.get(
  '/portainer/estadisticas',
  verifyToken,
  requireModule('SERVIDORES'),
  async (req, res) => {
    try {
      const estadisticas = await estadisticasRecursosFlota();
      res.json(estadisticas);
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

// ==========================================
// HISTÓRICO DE CPU/MEMORIA DE LA FLOTA (para la gráfica de tendencia del
// Análisis Estadístico). La tabla se crea sola la primera vez que se usa
// (mismo criterio que f5_alias/f5_oculto en f5Monitoreo.js), así no
// depende de correr una migración a mano. Un job en segundo plano guarda
// una fila por entorno activo cada 10 minutos; no hay historial antes de
// que el backend empiece a correr con este código, así que la gráfica
// arranca vacía y se va llenando sola con el tiempo.
// ==========================================
// errno 1142/1143 = el usuario de BD no tiene permiso CREATE/ALTER (mismo
// criterio que esErrorDePermisosDdl() en auditoriaGeneral.js/usuariosAuditoria.js).
// Si la tabla ya existe (creada antes con una cuenta con más privilegios),
// esto no es un error real — esta cuenta simplemente no puede verificarlo
// con DDL. Sin este manejo, la captura periódica del histórico (y cualquier
// pantalla que dependa de ella) se caía por intentar el CREATE TABLE IF NOT
// EXISTS, aunque la tabla ya existiera.
function esErrorDePermisosDdl(err) {
  return err && (err.errno === 1142 || err.errno === 1143);
}

let tablaHistoricoLista = false;
async function garantizarTablaHistorico(pool) {
  if (tablaHistoricoLista) return;
  try {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS monitoreo_historico_portainer (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      Fecha DATETIME NOT NULL,
      EntornoId INT NOT NULL,
      EntornoNombre VARCHAR(255) NULL,
      ContenedoresTotal INT NOT NULL DEFAULT 0,
      ContenedoresCorriendo INT NOT NULL DEFAULT 0,
      ContenedoresDetenidos INT NOT NULL DEFAULT 0,
      CpuPromedioPct DECIMAL(6,2) NOT NULL DEFAULT 0,
      MemUsadaGb DECIMAL(10,2) NOT NULL DEFAULT 0,
      INDEX idx_historico_fecha (Fecha),
      INDEX idx_historico_entorno (EntornoId, Fecha)
    )
    `);
  } catch (err) {
    if (!esErrorDePermisosDdl(err)) throw err;
    console.warn('No se pudo verificar/crear la tabla monitoreo_historico_portainer (el usuario de BD no tiene permiso CREATE); se asume que ya existe:', err.sqlMessage || err.message);
  }
  tablaHistoricoLista = true;
}

const INTERVALO_HISTORICO_MS = 10 * 60 * 1000; // cada 10 minutos

async function capturarSnapshotHistorico() {
  if (!PORTAINER_CONFIGURADO) return;
  try {
    const pool = await getPool();
    await garantizarTablaHistorico(pool);

    const entornos = await listarTodosLosEntornos();
    const fecha = new Date();
    const filas = entornos
      .filter((e) => e.estadoConexion === 'up')
      .map((e) => {
        const corriendoConRecursos = e.contenedores.filter((c) => c.estado === 'running' && c.recursos);
        const cpuPromedio = corriendoConRecursos.length
          ? corriendoConRecursos.reduce((acc, c) => acc + (c.recursos.cpuPorcentajeNum || 0), 0) / corriendoConRecursos.length
          : 0;
        const memUsadaGb = corriendoConRecursos.reduce((acc, c) => acc + (c.recursos.memUsoBytesNum || 0), 0) / (1024 ** 3);
        return [
          fecha,
          e.id,
          e.nombre,
          e.resumenContenedores.total,
          e.resumenContenedores.corriendo,
          e.resumenContenedores.detenidos,
          +cpuPromedio.toFixed(2),
          +memUsadaGb.toFixed(2),
        ];
      });

    if (!filas.length) return;
    await pool.query(
      `INSERT INTO monitoreo_historico_portainer
        (Fecha, EntornoId, EntornoNombre, ContenedoresTotal, ContenedoresCorriendo, ContenedoresDetenidos, CpuPromedioPct, MemUsadaGb)
       VALUES ?`,
      [filas]
    );
  } catch (err) {
    // Un fallo puntual (Portainer caído, BD ocupada) no debe tumbar el
    // backend ni detener las próximas capturas — se reintenta solo en el
    // siguiente ciclo del intervalo.
    console.warn(`No se pudo guardar el snapshot histórico de Portainer: ${err.message}`);
  }
}

if (PORTAINER_CONFIGURADO) {
  // Primera captura a los 30s de arrancar (no de una vez, para no competir
  // con el resto de rutas durante el arranque del servidor), y de ahí en
  // adelante cada INTERVALO_HISTORICO_MS.
  setTimeout(capturarSnapshotHistorico, 30000);
  setInterval(capturarSnapshotHistorico, INTERVALO_HISTORICO_MS);
}

// GET /portainer/historico?horas=24 - serie de tiempo agregada de TODA la
// flota (suma/promedio de todos los entornos por cada momento capturado),
// para la gráfica de tendencia. Puede devolver muy pocos puntos (o
// ninguno) si el backend lleva poco tiempo corriendo con esta versión —
// eso no es un error, el frontend lo maneja mostrando un aviso.
router.get(
  '/portainer/historico',
  verifyToken,
  requireModule('SERVIDORES'),
  async (req, res) => {
    try {
      const horas = parseInt(req.query.horas, 10) || 24;
      const pool = await getPool();
      await garantizarTablaHistorico(pool);

      const [filas] = await pool.query(
        `SELECT
           Fecha AS fecha,
           SUM(ContenedoresTotal) AS contenedoresTotal,
           SUM(ContenedoresCorriendo) AS contenedoresCorriendo,
           SUM(ContenedoresDetenidos) AS contenedoresDetenidos,
           AVG(CpuPromedioPct) AS cpuPromedio,
           SUM(MemUsadaGb) AS memUsadaGb
         FROM monitoreo_historico_portainer
         WHERE Fecha >= (NOW() - INTERVAL ? HOUR)
         GROUP BY Fecha
         ORDER BY Fecha ASC`,
        [horas]
      );

      res.json(
        filas.map((f) => ({
          fecha: f.fecha,
          contenedoresTotal: Number(f.contenedoresTotal) || 0,
          contenedoresCorriendo: Number(f.contenedoresCorriendo) || 0,
          contenedoresDetenidos: Number(f.contenedoresDetenidos) || 0,
          cpuPromedio: +Number(f.cpuPromedio || 0).toFixed(2),
          memUsadaGb: +Number(f.memUsadaGb || 0).toFixed(2),
        }))
      );
    } catch (err) {
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  }
);

module.exports = router;