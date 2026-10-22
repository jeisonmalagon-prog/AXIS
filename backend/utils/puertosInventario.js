// Cruce de los puertos en escucha de un servidor con lo que dice el inventario.
// Funciones puras (sin base de datos) para poder probarlas: la ruta les pasa los
// componentes que el inventario tiene registrados en ese servidor
// (Servidor_Componentes + las aplicaciones de negocio que los usan).
//
// Estado de cada puerto detectado:
//   inventariado    -> hay un componente del inventario con ese puerto en ese servidor.
//   sistema         -> no está en el inventario, pero es un servicio del propio sistema
//                      operativo (SSH, RPC, DNS, RDP, WinRM…): no es una aplicación y no se
//                      cuenta como «sin inventariar». Es una heurística por nombre de
//                      proceso y por puertos bien conocidos.
//   no_inventariado -> escucha algo y el inventario no sabe qué es. Es lo que hay que revisar.

// Procesos que son del sistema operativo y no una aplicación del negocio.
const PROCESOS_SISTEMA = new Set([
  // Linux
  'sshd', 'systemd', 'systemd-resolve', 'systemd-resolved', 'systemd-network', 'systemd-networkd', 'chronyd', 'ntpd', 'rpcbind', 'rpc.statd',
  'rpc.mountd', 'avahi-daemon', 'cupsd', 'dhclient', 'dhcpcd', 'dnsmasq', 'crond', 'master', 'postfix', 'snmpd', 'named', 'irqbalance', 'chronyd.service',
  // Windows
  'system', 'svchost', 'svchost.exe', 'lsass', 'lsass.exe', 'wininit', 'wininit.exe', 'services', 'services.exe', 'spoolsv', 'spoolsv.exe',
  'dns', 'dns.exe', 'winlogon', 'winlogon.exe', 'dasHost', 'dashost.exe', 'wsmprovhost', 'wmiprvse', 'wmiprvse.exe', 'sqlbrowser', 'sqlbrowser.exe',
  'termservice', 'msdtc', 'msdtc.exe', 'vmms', 'vmms.exe', 'lsm', 'lsm.exe', 'ntoskrnl', 'ntoskrnl.exe',
].map((p) => p.toLowerCase()));

// Puertos de servicios del sistema que no tienen ningún aplicativo de negocio detrás.
const PUERTOS_SISTEMA = new Set([22, 53, 67, 68, 111, 123, 135, 137, 138, 139, 161, 445, 546, 547, 631, 3389, 5353, 5355, 5985, 5986, 47001]);

function normalizarProceso(nombre) {
  return String(nombre || '').trim().toLowerCase();
}

function esDelSistema(fila) {
  const proc = normalizarProceso(fila.proceso);
  if (proc && PROCESOS_SISTEMA.has(proc)) return true;
  if (proc && PROCESOS_SISTEMA.has(proc.replace(/\.exe$/, ''))) return true;
  // Sin proceso conocido: solo se confía en puertos bien conocidos del sistema.
  if (!proc && PUERTOS_SISTEMA.has(fila.puerto)) return true;
  // Con proceso conocido que NO es del sistema, el puerto no basta (p. ej. 3389 usado por otra cosa).
  return false;
}

/**
 * @param {Array} puertos        filas de consolidar(): {puerto, protocolo, proceso, ...}
 * @param {Array} componentes    [{id, rol, puerto, tipo, aplicaciones: ['App A', ...]}] del inventario del servidor
 * @returns {{puertos: Array, inventarioSinEscuchar: Array, resumen: object}}
 */
function cruzarConInventario(puertos, componentes) {
  const porPuerto = new Map();
  const sinPuerto = [];
  for (const c of componentes || []) {
    const n = Number(c.puerto);
    if (!Number.isInteger(n) || n <= 0) { sinPuerto.push(c); continue; }
    if (!porPuerto.has(n)) porPuerto.set(n, []);
    porPuerto.get(n).push(c);
  }

  const escuchando = new Set();
  const cruzados = (puertos || []).map((f) => {
    escuchando.add(f.puerto);
    const coincidencias = porPuerto.get(f.puerto) || [];
    if (coincidencias.length) {
      return {
        ...f,
        estadoInventario: 'inventariado',
        inventario: coincidencias.map((c) => ({
          id: c.id, rol: c.rol || null, tipo: c.tipo || null, aplicaciones: Array.isArray(c.aplicaciones) ? c.aplicaciones : [],
        })),
      };
    }
    return { ...f, estadoInventario: esDelSistema(f) ? 'sistema' : 'no_inventariado', inventario: [] };
  });

  // Registrados en el inventario con puerto, pero que hoy no están escuchando.
  const inventarioSinEscuchar = [];
  for (const [n, lista] of porPuerto.entries()) {
    if (escuchando.has(n)) continue;
    for (const c of lista) {
      inventarioSinEscuchar.push({
        id: c.id, puerto: n, rol: c.rol || null, tipo: c.tipo || null, aplicaciones: Array.isArray(c.aplicaciones) ? c.aplicaciones : [],
      });
    }
  }
  inventarioSinEscuchar.sort((a, b) => a.puerto - b.puerto);

  const cuenta = (e) => cruzados.filter((f) => f.estadoInventario === e).length;
  return {
    puertos: cruzados,
    inventarioSinEscuchar,
    resumen: {
      inventariados: cuenta('inventariado'),
      delSistema: cuenta('sistema'),
      sinInventariar: cuenta('no_inventariado'),
      inventarioSinEscuchar: inventarioSinEscuchar.length,
      componentesSinPuerto: sinPuerto.length,
    },
  };
}

// Lo que el inventario sabe de un servidor: sus componentes (rol, puerto, tipo) y las
// aplicaciones de negocio que los usan. Es la misma relación que usa la pantalla Aplicaciones.
async function componentesDelServidor(pool, servidorId) {
  const [filas] = await pool.query(`
    SELECT sc.Id AS id, sc.Rol AS rol, sc.Puerto AS puerto, sc.Tipo AS tipo,
           GROUP_CONCAT(DISTINCT a.Nombre ORDER BY a.Nombre SEPARATOR '||') AS aplicaciones
    FROM Servidor_Componentes sc
    LEFT JOIN Aplicacion_Componente ac ON ac.ComponenteId = sc.Id
    LEFT JOIN Aplicaciones a ON a.Id = ac.AplicacionId
    WHERE sc.ServidorId = ?
    GROUP BY sc.Id, sc.Rol, sc.Puerto, sc.Tipo
    ORDER BY sc.Puerto, sc.Rol
  `, [servidorId]);
  return filas.map((f) => ({
    id: f.id, rol: f.rol, puerto: f.puerto, tipo: f.tipo,
    aplicaciones: f.aplicaciones ? String(f.aplicaciones).split('||').filter(Boolean) : [],
  }));
}

module.exports = { cruzarConInventario, componentesDelServidor, esDelSistema };
