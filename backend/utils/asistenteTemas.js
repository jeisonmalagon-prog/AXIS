// Temas (fuentes de datos) del Asistente IA de AXIS.
//
// Cada tema pertenece a UNO O VARIOS módulos de la aplicación (`modulos`: basta
// con tener cualquiera de ellos). El asistente solo consulta y responde con los
// temas cuyos módulos tiene habilitados el usuario que pregunta -- igual que
// las pantallas, donde `requireModule(...)` bloquea el acceso. Un tema con
// `modulos: null` es general (no requiere ningún módulo).
//
// Regla de este proyecto: "nunca borrar, solo leer" -- todo lo de este archivo
// es SELECT (o lectura de APIs externas); el asistente no modifica nada.
//
// Los temas con `soloManual: true` no traen datos: sirven para activar la
// explicación del módulo (cómo se usa, qué hace cada pantalla).

const CACHE_TTL_MS = 60 * 1000; // 60 segundos por tema (+ filtros de la pregunta)
const MAX_FILAS_POR_TEMA = 40; // límite de filas por tema (prompt chico = respuesta rápida)
const MAX_TEXTO_CAMPO = 250; // valores de texto más largos que esto se descartan

// ==========================================================================
// Utilidades de texto
// ==========================================================================
function quitarTildes(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Texto "comparable": minúsculas y sin tildes, para que "conexión" y
// "conexion" disparen el mismo tema.
function normalizar(texto) {
  return quitarTildes(texto).toLowerCase();
}

// Quita campos de texto muy largos (comandos, manuales, imágenes en base64...)
// y los vacíos, sin tener que conocer el nombre exacto de cada columna.
function limpiarFilas(filas) {
  return filas.map((fila) => {
    const limpia = {};
    for (const [clave, valor] of Object.entries(fila)) {
      if (typeof valor === 'string' && valor.length > MAX_TEXTO_CAMPO) continue;
      if (valor === null || valor === undefined || valor === '') continue;
      limpia[clave] = valor instanceof Date ? valor.toISOString().slice(0, 16).replace('T', ' ') : valor;
    }
    return limpia;
  });
}

// Un modelo chico en CPU lee mucho mejor "campo: valor, campo: valor" que
// JSON anidado: cada fila pasa a una línea de texto simple.
function valorATexto(valor) {
  if (Array.isArray(valor)) {
    if (valor.length === 0) return 'ninguno';
    return valor.map((v) => (typeof v === 'object' && v !== null ? filaATexto(v) : v)).join(' | ');
  }
  if (typeof valor === 'object' && valor !== null) return filaATexto(valor);
  return String(valor);
}

function filaATexto(fila) {
  return Object.entries(fila)
    .map(([clave, valor]) => `${clave}=${valorATexto(valor)}`)
    .join(', ');
}

function bloqueATexto(datos) {
  if (!Array.isArray(datos) || datos.length === 0) return '(sin registros para este tema)';
  return datos.map((fila, i) => `${i + 1}. ${filaATexto(fila)}`).join('\n');
}

// ==========================================================================
// Búsqueda por palabras: orden por coincidencias y aviso cuando no hay ninguna
// ==========================================================================
const LIMITE_BUSQUEDA = 150; // filas que se traen cuando hay filtro, para ordenarlas por relevancia

// Ordena las filas poniendo primero las que contienen MÁS de las palabras
// buscadas ("TC GARANTIZADA" antes que "API GARANTIZADA" si se preguntó por
// "tc garantizada") y se queda con las primeras MAX_FILAS_POR_TEMA.
function rankear(filas, palabras) {
  const puntaje = (fila) => {
    const texto = normalizar(Object.values(fila).filter((v) => typeof v === 'string').join(' '));
    return palabras.reduce((n, p) => n + (texto.includes(p) ? 1 : 0), 0);
  };
  return filas
    .map((fila, i) => ({ fila, i, n: puntaje(fila) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, MAX_FILAS_POR_TEMA)
    .map((x) => x.fila);
}

// Fila de advertencia: sin esto, cuando el filtro no encuentra nada y se manda
// una muestra general, el modelo tiende a presentar esa muestra como respuesta.
function avisoSinCoincidencias(buscar) {
  return {
    aviso: `Ningun registro coincide por nombre con "${buscar.join(' ')}". Las filas siguientes son una muestra general. ` +
      'Si el usuario preguntaba por un nombre concreto: di que no esta registrado (puedes citar nombres parecidos) y NO presentes ' +
      'la muestra como respuesta. Si la pregunta era general (conteos, estados, listados), ignora este aviso y usa las filas.',
  };
}

// Consulta con filtro por palabras: ordena por relevancia; si no hay
// coincidencias, devuelve una muestra general precedida del aviso.
// sqlFn(where, limite) arma el SELECT completo.
async function consultarFiltrado(pool, sqlFn, where, params, buscar) {
  if (!buscar.length) {
    const [filas] = await pool.query(sqlFn('', MAX_FILAS_POR_TEMA));
    return limpiarFilas(filas);
  }
  const [filtradas] = await pool.query(sqlFn(where, LIMITE_BUSQUEDA), params);
  if (filtradas.length > 0) return limpiarFilas(rankear(filtradas, buscar));
  const [muestra] = await pool.query(sqlFn('', MAX_FILAS_POR_TEMA));
  return [avisoSinCoincidencias(buscar), ...limpiarFilas(muestra)];
}

// ==========================================================================
// Palabras distintivas de la pregunta (nombres, hostnames, códigos) e IPs.
// Sirven para FILTRAR los temas grandes (hay 200+ sub-aplicativos: traer solo
// los primeros 40 no responde preguntas sobre uno puntual).
// ==========================================================================
const PALABRAS_COMUNES = new Set([
  'para', 'esta', 'esto', 'estos', 'estas', 'todo', 'toda', 'todos', 'todas',
  'dame', 'como', 'cual', 'cuales', 'donde', 'cuando', 'porque', 'sobre',
  'desde', 'hasta', 'entre', 'tiene', 'tienen', 'estan', 'este', 'esos',
  'esas', 'sera', 'seran', 'quiero', 'necesito', 'puedes', 'podrias', 'dime',
  'cuentame', 'funcionamiento', 'esquema', 'informacion', 'servicio',
  'servicios', 'servidor', 'servidores', 'aplicacion', 'aplicaciones',
  'certificado', 'certificados', 'cuantos', 'cuantas', 'hay', 'existen',
  'listar', 'lista', 'muestrame', 'mostrar', 'dato', 'datos', 'estado',
  'tengo', 'tengas', 'mios', 'mias', 'pendientes', 'tarea', 'tareas',
  'nodo', 'nodos', 'que', 'quien', 'quienes', 'cual', 'puerto', 'puertos',
  'sub', 'aplicativo', 'aplicativos', 'subaplicativo', 'subaplicativos',
  'componente', 'componentes', 'contenedor', 'contenedores', 'paso', 'pasos',
  'produccion', 'hoy', 'ayer', 'ultimo', 'ultimos', 'ultima', 'ultimas',
  'workflow', 'workflows', 'flujo', 'flujos', 'virtual', 'balanceador',
  // Verbos, tiempos y saludos que no son nombres de nada.
  'hola', 'buenas', 'buenos', 'gracias', 'ayuda', 'favor', 'porfa', 'resumen', 'total', 'cantidad', 'numero',
  'general', 'ahora', 'actual', 'actuales', 'usa', 'usan', 'usar', 'corre', 'corren', 'funciona', 'funcionan',
  'existe', 'hace', 'hacen', 'hacer', 'vence', 'vencen', 'vencer', 'vencido', 'vencidos', 'vencimiento',
  'dias', 'dia', 'semana', 'semanas', 'mes', 'meses', 'proximo', 'proximos', 'proxima', 'proximas',
  'activo', 'activos', 'activa', 'activas', 'inactivo', 'inactivos', 'alta', 'alto', 'media', 'medio', 'baja', 'bajo',
  'critica', 'criticas', 'critico', 'criticos', 'caido', 'caidos', 'arriba', 'abajo',
  // Ambientes (no están en hostname/IP: se resuelven con las columnas del inventario).
  'criticidad', 'ambiente', 'ambientes', 'plataforma', 'imagen', 'version', 'versiones', 'pipeline', 'responsable', 'propietario',
  'desarrollo', 'pruebas', 'calidad', 'dev', 'prd', 'prod', 'uat', 'qas'
]);

// Palabras cortas (2-3 letras) que NO sirven para buscar. Las demás ("tc", "bus",
// "api", "n8n"...) sí cuentan: suelen ser siglas de aplicaciones o servicios.
const PALABRAS_CORTAS_COMUNES = new Set([
  'el', 'la', 'lo', 'los', 'las', 'un', 'una', 'uno', 'de', 'del', 'en', 'es', 'se', 'su', 'sus', 'mi', 'mis',
  'me', 'te', 'tu', 'tus', 'al', 'no', 'si', 'ya', 'yo', 'por', 'con', 'sin', 'que', 'hay', 'ver', 'ser', 'son',
  'mas', 'muy', 'dos', 'tres', 'fue', 'era', 'han', 'nos', 'hoy', 'ese', 'esa', 'eso', 'ahi', 'aca', 'sub',
  'ip', 'ips', 'cual', 'del', 'les', 'ha', 'he', 'o', 'y', 'a', 'e', 'u', 'dar', 'dame', 'dime', 'pon', 'cuando',
]);

function extraerPalabrasClave(pregunta) {
  const texto = normalizar(pregunta);
  const largas = (texto.match(/[a-z0-9_]{4,}/g) || []).filter((p) => !PALABRAS_COMUNES.has(p));
  const cortas = (texto.match(/\b[a-z0-9_]{2,3}\b/g) || []).filter((p) => !PALABRAS_CORTAS_COMUNES.has(p) && !PALABRAS_COMUNES.has(p) && !/^\d+$/.test(p));
  // Primero las largas (más distintivas), y las siglas cortas completan hasta 3.
  return [...new Set([...largas, ...cortas])].slice(0, 3);
}

function extraerIps(pregunta) {
  return [...new Set(String(pregunta || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [])].slice(0, 3);
}

// ==========================================================================
// MÓDULOS: nombre legible, resumen de una línea y explicación detallada. Es el
// "manual de la app" dividido por módulo: al asistente solo se le cuenta de los
// módulos que el usuario tiene habilitados.
// ==========================================================================
const MODULOS_INFO = {
  CERTIFICADOS: {
    nombre: 'Certificados',
    resumen: 'certificados SSL/TLS (vigencia, vencimientos, histórico), servidores y aplicaciones de negocio',
    detalle:
      'Módulo Certificados: Dashboard con los certificados por vencer; Certificados (alta/edición con servidor, aplicación, fechas de ' +
      'vigencia y días restantes; un certificado puede compartirse entre varios servidores/componentes); Servidores (lista básica con hostname, ' +
      'IP, sistema operativo y ambiente); Aplicaciones (sistemas de negocio y en qué servidores corren); Histórico de renovaciones; y reportes ' +
      '(PDF/correo) de certificados y de aplicaciones.',
  },
  SERVIDORES: {
    nombre: 'Servidores',
    resumen: 'inventario de infraestructura: servidores, sub-aplicativos, conexiones a BD, integraciones, impacto y monitoreo',
    detalle:
      'Módulo Servidores: Inventario de servidores (hostname, IP, SO, ambiente, criticidad, plataforma) y, por servidor, los aplicativos y ' +
      'componentes desplegados; Sub-aplicativos (cada contenedor/sitio/servicio con su puerto, plataforma, criticidad, estado, versión de ' +
      'imagen, repositorio, pipeline y ficha técnica); Conexiones a bases de datos e Integraciones entre aplicativos/servidores; Análisis de ' +
      'Impacto (qué se afecta si cae un servidor); Monitoreo de servidores (contenedores de Portainer, CPU y memoria) y Reportes.',
  },
  APP_MOVIL: {
    nombre: 'App Móvil',
    resumen: 'analítica de la app móvil: transacciones, errores, tasa de éxito, canales y dispositivos (LogApp)',
    detalle:
      'Módulo App Móvil: panel de analítica con transacciones totales, errores, tasa de éxito, usuarios únicos, tendencia diaria, canales, ' +
      'fabricantes de dispositivo, funcionalidades y top de métodos con errores; y un detalle de errores individuales exportable. Los datos ' +
      'salen de la base LogApp y se filtran por rango de fechas, canal y dispositivo.',
  },
  SERVICIOS: {
    nombre: 'Servicios',
    resumen: 'catálogo ACE/Bus, bitácora de apuntamientos (quién consume qué servicio), histórico y validación de nodos',
    detalle:
      'Módulo Servicios: Catálogo ACE (servicios con código, nombre, URLs por ambiente y pod; operaciones por servicio); Bitácora de ' +
      'Apuntamientos (a qué servicio ACE o BUS está apuntado cada aplicación/servidor/componente hoy; Categoría ACE o BUS_INTEGRACION_10); ' +
      'Histórico de apuntamientos (quién cambió qué y cuándo, con comparación entre nodos); Validación de nodos (lee el archivo de ' +
      'configuración de cada nodo —por SSH o carpeta compartida— y lo compara con la bitácora: faltantes, sobrantes y sin servicio; corre ' +
      'sola una vez al día y también bajo demanda) y reportes de apuntamientos.',
  },
  ORQUESTADOR_N8N: {
    nombre: 'Orquestador N8N',
    resumen: 'workflows de n8n: activos/detenidos, ejecuciones, éxito y fallas',
    detalle:
      'Módulo Orquestador N8N: lista los workflows de n8n con su estado (activo/detenido), total de ejecuciones, exitosas, fallidas, tasa de ' +
      'éxito y última ejecución; con rol de administración se pueden activar o desactivar workflows.',
  },
  REPOSITORIO: {
    nombre: 'Repositorio',
    resumen: 'espejo de solo lectura del repositorio de Azure DevOps (documentos de servicios y carpetas)',
    detalle:
      'Módulo Repositorio: explorador de solo lectura del repositorio de Azure DevOps (carpetas y archivos de documentación de los ' +
      'servicios, con su último commit). No modifica nada del repositorio.',
  },
  BALANCEADOR_F5: {
    nombre: 'Balanceador F5',
    resumen: 'Virtual Servers y nodos del F5: estado, conexiones, tráfico, configuración y rendimiento del equipo',
    detalle:
      'Módulo Balanceador F5 (solo lectura): tarjetas por Virtual Server con estado, conexiones abiertas y tráfico entrada/salida; detalle ' +
      'con pool, método de balanceo, monitor de salud y, por cada nodo, estado, conexiones, tráfico y % del reparto; resumen general, top de ' +
      'tráfico y conexiones, rendimiento del equipo y alias propios por Virtual Server. El F5 no identifica usuarios: mide conexiones, ' +
      'sesiones y peticiones. Hay también un informe histórico.',
  },
  TAREAS: {
    nombre: 'Tareas',
    resumen: 'tareas propias y asignadas, con estado, prioridad, fecha límite, checklist y avances',
    detalle:
      'Módulo Tareas: cada usuario ve las tareas que creó o que le asignaron (el administrador ve todas), con estado (PENDIENTE, EN_PROGRESO, ' +
      'COMPLETADA, CANCELADA...), prioridad, fecha y hora límite, asignados, checklist y avances/comentarios.',
  },
  CALENDARIO: {
    nombre: 'Calendario',
    resumen: 'calendario personal y de equipo (se integra con Google Calendar)',
    detalle:
      'Módulo Calendario: calendario personal y de equipo integrado con Google Calendar; muestra eventos propios, de equipo y las tareas con ' +
      'fecha límite.',
  },
  PASOS_PRODUCCION: {
    nombre: 'Pasos a Producción',
    resumen: 'bitácora de pasos/despliegues a producción: RFC, aplicativo, ventana, checklist, evidencias y commit',
    detalle:
      'Módulo Pasos a Producción: bitácora de cada paso a producción con RFC, título, entorno, aplicativo y servidor, ventana programada y ' +
      'real, estado (programado, en ejecución, exitoso, fallido, revertido...), equipo, checklist con evidencias adjuntas, commit del repositorio y ' +
      'registro de eventos.',
  },
  SWAGGER: {
    nombre: 'Swagger',
    resumen: 'lector de documentos Swagger/OpenAPI de servicios internos, con consola para consumirlos y guardar consumos',
    detalle:
      'Módulo Swagger: lee el documento Swagger/OpenAPI de los servicios registrados (endpoints, parámetros y cuerpos de ejemplo), permite ' +
      'ejecutar consumos desde AXIS, guardarlos con nombre para repetirlos y consultar el historial de ejecuciones. Los secretos (tokens, ' +
      'contraseñas) no se guardan. Cada Swagger es PRIVADO de quien lo registró: nadie más lo ve hasta que su dueño lo comparte (con todos ' +
      'o con usuarios concretos, desde el botón Orígenes > Compartir); quien lo recibe puede verlo y consumirlo, pero no modificarlo.',
  },
  BIOMETRIA: {
    nombre: 'Biometría de firmas',
    resumen: 'firmas en reintento (MotorFirma) cuyo caso en ORQBIOMETRIA ya tiene biometría exitosa',
    detalle:
      'Módulo Biometría de firmas: cruza las solicitudes de MotorFirma en reintento (IdEstadoFirma 30 e IdEstadoBiometria 60) con los casos, ' +
      'capturas y resultados de ORQBIOMETRIA. Marca como candidatas las firmas cuyo caso está en reintento y que ya tienen un resultado ' +
      '«CEDULA ORIGINAL OK» o «Validación exitosa». Es de solo lectura, consulta cada cierto tiempo y permite exportar a Excel.',
  },
};

const ADMIN_ONLY_INFO =
  'Administración (solo ADMIN_POD): Gestión de usuarios (roles por módulo CONSULTA o ADMIN_MIN), auditoría de usuarios y de eventos, y ' +
  'configuración del sistema.';

// ==========================================================================
// TEMAS
// ==========================================================================
// obtener(pool, ctx): ctx = { user, modulos, palabras, ips, pregunta }
const TEMAS = [
  {
    clave: 'aplicaciones',
    modulos: ['CERTIFICADOS', 'SERVIDORES'],
    patrones: /aplicaci|\bapp\b(?! movil)|aplicativo|sistema de negocio|negocio/,
    async obtener(pool, ctx) {
      const filtrar = ctx.palabras.length > 0;
      const params = [];
      let condicion = 'ServidorId IS NULL';
      if (filtrar) {
        condicion += ` AND (${ctx.palabras.map(() => 'Nombre LIKE ?').join(' OR ')})`;
        ctx.palabras.forEach((p) => params.push(`%${p}%`));
      }
      let aviso = null;
      let [apps] = await pool.query(
        `SELECT Id, Nombre, Activo FROM Aplicaciones WHERE ${condicion} ORDER BY Nombre LIMIT ${filtrar ? LIMITE_BUSQUEDA : MAX_FILAS_POR_TEMA}`,
        params
      );
      if (filtrar && apps.length > 0) {
        apps = rankear(apps, ctx.palabras);
      } else if (filtrar && apps.length === 0) {
        aviso = avisoSinCoincidencias(ctx.palabras);
        [apps] = await pool.query(
          `SELECT Id, Nombre, Activo FROM Aplicaciones WHERE ServidorId IS NULL ORDER BY Nombre LIMIT ${MAX_FILAS_POR_TEMA}`
        );
      }
      if (apps.length === 0) return [];
      const [servidoresFilas] = await pool.query(
        `SELECT aps.AplicacionId, s.Hostname, s.IP, aps.Descripcion
           FROM Aplicacion_Servidor aps
           JOIN Servidores s ON s.Id = aps.ServidorId
          WHERE aps.AplicacionId IN (?)`,
        [apps.map((a) => a.Id)]
      );
      const servidoresPorApp = new Map();
      for (const s of servidoresFilas) {
        if (!servidoresPorApp.has(s.AplicacionId)) servidoresPorApp.set(s.AplicacionId, []);
        // Descripcion trae, separados por coma, los sub-aplicativos que corren
        // en ese servidor para esta aplicación.
        const componentes = (s.Descripcion || '').split(',').map((c) => c.trim()).filter(Boolean);
        servidoresPorApp.get(s.AplicacionId).push({ hostname: s.Hostname, ip: s.IP, componentes });
      }
      const resultado = apps.map((app) => ({
        nombre: app.Nombre,
        activo: !!app.Activo,
        servidores: servidoresPorApp.get(app.Id) || [],
      }));
      return aviso ? [aviso, ...resultado] : resultado;
    },
  },
  {
    clave: 'servidores',
    modulos: ['SERVIDORES', 'CERTIFICADOS'],
    patrones: /servidor|\bhost\b|hostname|\bip\b|infraestructura|ambiente|criticidad|sistema operativo|\bso\b|linux|windows/,
    async obtener(pool, ctx) {
      // Con el módulo SERVIDORES: vista completa del inventario. Solo con
      // CERTIFICADOS: la lista básica (hostname, IP, ambiente), igual que su pantalla.
      if (!ctx.modulos.includes('SERVIDORES')) {
        const [filas] = await pool.query(
          `SELECT Hostname AS hostname, IP AS ip, Ambiente AS ambiente FROM Servidores ORDER BY Hostname LIMIT ${MAX_FILAS_POR_TEMA}`
        );
        return limpiarFilas(filas);
      }
      const buscar = [...ctx.ips, ...ctx.palabras];
      if (buscar.length) {
        try {
          const cond = buscar.map(() => '(hostname LIKE ? OR ip_address LIKE ?)').join(' OR ');
          const params = buscar.flatMap((b) => [`%${b}%`, `%${b}%`]);
          const [filtradas] = await pool.query(
            `SELECT * FROM vw_inventario_servidores WHERE ${cond} ORDER BY id LIMIT ${MAX_FILAS_POR_TEMA}`,
            params
          );
          if (filtradas.length) return limpiarFilas(filtradas);
          const [muestra] = await pool.query(`SELECT * FROM vw_inventario_servidores ORDER BY id LIMIT ${MAX_FILAS_POR_TEMA}`);
          return [avisoSinCoincidencias(buscar), ...limpiarFilas(muestra)];
        } catch (err) {
          /* si la vista no tiene esas columnas se cae al listado general */
        }
      }
      const [filas] = await pool.query(`SELECT * FROM vw_inventario_servidores ORDER BY id LIMIT ${MAX_FILAS_POR_TEMA}`);
      return limpiarFilas(filas);
    },
  },
  {
    clave: 'subaplicativos',
    modulos: ['SERVIDORES'],
    patrones: /sub.?aplicativ|componente|contenedor|docker|microservicio|\bapi\b|puerto|plataforma|version de imagen|pipeline|despliegue|desplegad|apache|tomcat|iis\b|nginx/,
    async obtener(pool, ctx) {
      const buscar = [...ctx.ips, ...ctx.palabras];
      const params = [];
      let where = '';
      if (buscar.length) {
        where = `WHERE ${buscar.map(() => '(sc.Rol LIKE ? OR s.Hostname LIKE ? OR s.IP LIKE ?)').join(' OR ')}`;
        buscar.forEach((b) => params.push(`%${b}%`, `%${b}%`, `%${b}%`));
      }
      const sql = (w, lim = MAX_FILAS_POR_TEMA) => `
        SELECT sc.Rol AS nombre, sc.Tipo AS tipo, sc.Puerto AS puerto,
               s.Hostname AS servidor, s.IP AS ip, s.Ambiente AS ambiente,
               ia.plataforma, ia.criticidad, ia.estado, ia.version_imagen,
               ia.dev_responsable, ia.propietario, ia.fecha_ultimo_despliegue,
               (SELECT GROUP_CONCAT(a.Nombre ORDER BY a.Nombre SEPARATOR ', ')
                  FROM Aplicacion_Componente ac JOIN Aplicaciones a ON a.Id = ac.AplicacionId
                 WHERE ac.ComponenteId = sc.Id) AS aplicaciones_de_negocio
          FROM Servidor_Componentes sc
          JOIN Servidores s ON s.Id = sc.ServidorId
          LEFT JOIN inv_aplicativos ia ON ia.componente_id = sc.Id
          ${w}
         ORDER BY sc.Rol, s.Hostname LIMIT ${lim}`;
      return consultarFiltrado(pool, sql, where, params, buscar);
    },
  },
  {
    clave: 'monitoreo_servidores',
    modulos: ['SERVIDORES'],
    patrones: /monitoreo|portainer|contenedores? (corriendo|detenid)|\bcpu\b|memoria|\bram\b|consumo/,
    async obtener(pool) {
      const [filas] = await pool.query(`
        SELECT h.EntornoNombre AS entorno, h.Fecha AS ultima_lectura, h.ContenedoresTotal AS contenedores,
               h.ContenedoresCorriendo AS corriendo, h.ContenedoresDetenidos AS detenidos,
               h.CpuPromedioPct AS cpu_promedio_pct, h.MemUsadaGb AS memoria_usada_gb
          FROM monitoreo_historico_portainer h
          JOIN (SELECT EntornoId, MAX(Fecha) AS f FROM monitoreo_historico_portainer GROUP BY EntornoId) u
            ON u.EntornoId = h.EntornoId AND u.f = h.Fecha
         ORDER BY h.EntornoNombre LIMIT ${MAX_FILAS_POR_TEMA}`);
      return limpiarFilas(filas);
    },
  },
  {
    clave: 'certificados',
    modulos: ['CERTIFICADOS'],
    patrones: /certificad|\bssl\b|\btls\b|vence|vencimiento|expira|caduca|vigencia|renov/,
    async obtener(pool, ctx) {
      const buscar = ctx.palabras;
      const params = [];
      let where = '';
      if (buscar.length) {
        // Se filtra en JS sobre columnas de texto de la vista sin depender de sus nombres exactos.
        where = '';
      }
      const [filas] = await pool.query(
        `SELECT * FROM VW_CertificadosVigencia ${where} ORDER BY DiasRestantes ASC LIMIT 400`,
        params
      );
      let resultado = filas;
      if (buscar.length) {
        const coincide = filas.filter((f) => {
          const texto = normalizar(Object.values(f).filter((v) => typeof v === 'string').join(' '));
          return buscar.some((p) => texto.includes(p));
        });
        if (coincide.length) return limpiarFilas(rankear(coincide, buscar));
        return [avisoSinCoincidencias(buscar), ...limpiarFilas(resultado.slice(0, MAX_FILAS_POR_TEMA - 1))];
      }
      return limpiarFilas(resultado.slice(0, MAX_FILAS_POR_TEMA));
    },
  },
  {
    clave: 'ace_servicios',
    modulos: ['SERVICIOS'],
    patrones: /\bace\b|servicio|\bpod\b|endpoint|url (dev|qa|prd)|operacion/,
    async obtener(pool, ctx) {
      const buscar = ctx.palabras;
      const params = [];
      let where = '';
      if (buscar.length) {
        where = `WHERE ${buscar.map(() => '(NombreServicio LIKE ? OR Codigo LIKE ?)').join(' OR ')}`;
        buscar.forEach((p) => params.push(`%${p}%`, `%${p}%`));
      }
      const sql = (w, lim = MAX_FILAS_POR_TEMA) =>
        `SELECT * FROM AceServiciosInventario ${w} ORDER BY NombreServicio LIMIT ${lim}`;
      return consultarFiltrado(pool, sql, where, params, buscar);
    },
  },
  {
    clave: 'conexiones_bd',
    modulos: ['SERVIDORES'],
    patrones: /conexion|base de datos|motor de bd|esquema de bd|cadena de conexi|\bbd\b|oracle|sql server|postgres|mysql|mariadb/,
    async obtener(pool, ctx) {
      const buscar = ctx.palabras;
      const params = [];
      let where = '';
      if (buscar.length) {
        where = `WHERE ${buscar.map(() => '(ap.nombre_aplicacion LIKE ? OR c.nombre_base_datos LIKE ? OR sb.Hostname LIKE ?)').join(' OR ')}`;
        buscar.forEach((p) => params.push(`%${p}%`, `%${p}%`, `%${p}%`));
      }
      const sql = (w, lim = MAX_FILAS_POR_TEMA) => `
        SELECT ap.nombre_aplicacion AS aplicativo, c.motor_bd, c.nombre_base_datos,
               c.esquema, c.puerto, sb.Hostname AS servidor_bd, sb.IP AS servidor_bd_ip
          FROM inv_aplicativo_conexiones_bd c
          INNER JOIN Servidores sb ON sb.Id = c.servidor_bd_id
          LEFT JOIN vw_inventario_aplicativos ap ON ap.id = c.aplicativo_id
          ${w}
         ORDER BY c.id LIMIT ${lim}`;
      return consultarFiltrado(pool, sql, where, params, buscar);
    },
  },
  {
    clave: 'integraciones',
    modulos: ['SERVIDORES'],
    patrones: /integraci|depende de|dependencia|se comunica con|consume a|llama a|impacto/,
    async obtener(pool) {
      const [porServidor] = await pool.query(`
        SELECT sv.Hostname AS origen, i.descripcion,
               CASE WHEN i.aplicativo_destino_id IS NOT NULL THEN 'aplicativo' ELSE 'servidor' END AS tipo_destino,
               COALESCE(ap.Nombre, dest.Hostname) AS destino
          FROM inv_servidor_integraciones i
          JOIN Servidores sv ON sv.Id = i.servidor_origen_id
          LEFT JOIN Aplicaciones ap ON ap.Id = i.aplicativo_destino_id
          LEFT JOIN Servidores dest ON dest.Id = i.servidor_destino_id
         ORDER BY i.id LIMIT ${MAX_FILAS_POR_TEMA}`);
      const [porAplicativo] = await pool.query(`
        SELECT origen.Nombre AS origen, i.descripcion,
               CASE WHEN i.aplicativo_destino_id IS NOT NULL THEN 'aplicativo' ELSE 'servidor' END AS tipo_destino,
               COALESCE(destApp.Nombre, destSrv.Hostname) AS destino
          FROM inv_aplicativo_integraciones i
          JOIN Aplicaciones origen ON origen.Id = i.aplicativo_origen_id
          LEFT JOIN Aplicaciones destApp ON destApp.Id = i.aplicativo_destino_id
          LEFT JOIN Servidores destSrv ON destSrv.Id = i.servidor_destino_id
         ORDER BY i.id LIMIT ${MAX_FILAS_POR_TEMA}`);
      return limpiarFilas([...porServidor, ...porAplicativo]);
    },
  },
  {
    // Estado ACTUAL de la bitácora: qué aplicación/servidor/componente está
    // apuntado (suscrito) a qué servicio ACE/BUS ahora mismo.
    clave: 'suscriptores_servicios',
    modulos: ['SERVICIOS'],
    patrones: /suscri|consum[ei]|apuntamient|asignad[oa] a|\bbus\b|categoria|bitacora/,
    async obtener(pool, ctx) {
      const buscar = ctx.palabras;
      const params = [];
      let where = '';
      if (buscar.length) {
        where = `WHERE ${buscar.map(() => '(ap.Nombre LIKE ? OR si.Codigo LIKE ? OR si.NombreServicio LIKE ? OR sv.Hostname LIKE ? OR a.Componente LIKE ?)').join(' OR ')}`;
        buscar.forEach((p) => params.push(`%${p}%`, `%${p}%`, `%${p}%`, `%${p}%`, `%${p}%`));
      }
      const sql = (w, lim = MAX_FILAS_POR_TEMA) => `
        SELECT ap.Nombre AS aplicacion, sv.Hostname AS servidor, a.Componente AS componente,
               a.Categoria AS categoria, a.SinApuntamiento AS sin_apuntamiento,
               si.Codigo AS servicio_codigo, si.NombreServicio AS servicio_nombre, si.Pod AS servicio_pod
          FROM Apuntamientos a
          INNER JOIN Aplicaciones ap ON ap.Id = a.AplicacionId
          LEFT JOIN Servidores sv ON sv.Id = a.ServidorId
          LEFT JOIN AceServiciosInventario si ON si.Id = a.ServicioInventarioId
          ${w}
         ORDER BY ap.Nombre, a.Componente LIMIT ${lim}`;
      return consultarFiltrado(pool, sql, where, params, buscar);
    },
  },
  {
    // HISTÓRICO de cambios (quién cambió qué apuntamiento y cuándo).
    clave: 'historico_cambios',
    modulos: ['SERVICIOS'],
    patrones: /historico de (cambios|apuntamientos)|historial de (cambios|apuntamientos)|migracion de servidor|quien cambio|ultimos cambios/,
    async obtener(pool) {
      const [filas] = await pool.query(`
        SELECT h.Accion, apA.Nombre AS aplicacion_anterior, apN.Nombre AS aplicacion_nueva,
               svA.Hostname AS servidor_anterior, svN.Hostname AS servidor_nuevo,
               h.Usuario, h.FechaCambio
          FROM ApuntamientosHistorico h
          LEFT JOIN Aplicaciones apA ON apA.Id = h.AplicacionIdAnterior
          LEFT JOIN Aplicaciones apN ON apN.Id = h.AplicacionIdNuevo
          LEFT JOIN Servidores svA ON svA.Id = h.ServidorIdAnterior
          LEFT JOIN Servidores svN ON svN.Id = h.ServidorIdNuevo
         ORDER BY h.FechaCambio DESC LIMIT ${MAX_FILAS_POR_TEMA}`);
      return limpiarFilas(filas);
    },
  },
  {
    // Nodos de la Validación de nodos y el resultado de su última validación.
    clave: 'validacion_nodos',
    modulos: ['SERVICIOS'],
    patrones: /validaci|validar|\bnodos?\b|ecosystem|config\.js|archivo de configuracion|faltantes|sobrantes|diferencias/,
    async obtener(pool) {
      const [filas] = await pool.query(`
        SELECT n.Nombre AS nodo, n.Host AS host, ap.Nombre AS aplicacion, n.Componente AS componente,
               n.Activo AS activo, n.CorregirAuto AS corregir_automaticamente,
               n.UltimoEstado AS ultimo_estado, n.UltimaValidacion AS ultima_validacion,
               v.TotalConfig AS en_archivo, v.TotalBitacora AS en_bitacora, v.Faltantes AS faltantes,
               v.Sobrantes AS sobrantes, v.SinServicio AS sin_servicio, v.Mensaje AS mensaje
          FROM ApuntamientosNodos n
          LEFT JOIN Aplicaciones ap ON ap.Id = n.AplicacionId
          LEFT JOIN ApuntamientosValidaciones v
                 ON v.Id = (SELECT MAX(v2.Id) FROM ApuntamientosValidaciones v2 WHERE v2.NodoId = n.Id)
         ORDER BY n.Nombre LIMIT ${MAX_FILAS_POR_TEMA}`);
      return limpiarFilas(filas);
    },
  },
  {
    // Tareas: cada usuario solo ve las suyas (creadas o asignadas), también
    // el ADMIN_POD, igual que la pantalla de Tareas.
    clave: 'tareas',
    modulos: ['TAREAS'],
    patrones: /tarea|pendiente|por hacer|checklist|fecha limite|vencid[ao]s?\b.*tarea|mis asignaciones/,
    async obtener(pool, ctx) {
      // Cada usuario ve solo sus tareas (creadas o asignadas), también el ADMIN_POD.
      const params = [ctx.user.id, ctx.user.id];
      const where = 'WHERE (t.CreadoPorId = ? OR EXISTS (SELECT 1 FROM TareaAsignados ta WHERE ta.TareaId = t.Id AND ta.UsuarioId = ?))';
      const [filas] = await pool.query(
        `SELECT t.Titulo AS titulo, t.Estado AS estado, t.Prioridad AS prioridad, t.FechaLimite AS fecha_limite,
                u.nombre_completo AS creada_por,
                (SELECT GROUP_CONCAT(ua.nombre_completo ORDER BY ua.nombre_completo SEPARATOR ', ')
                   FROM TareaAsignados ta2 JOIN usuarios ua ON ua.id = ta2.UsuarioId
                  WHERE ta2.TareaId = t.Id) AS asignados,
                (SELECT COUNT(*) FROM TareaChecklist c WHERE c.TareaId = t.Id) AS items_checklist,
                (SELECT COUNT(*) FROM TareaChecklist c WHERE c.TareaId = t.Id AND c.Completado = 1) AS items_completados
           FROM Tareas t
           INNER JOIN usuarios u ON u.id = t.CreadoPorId
           ${where}
          ORDER BY (t.Estado = 'COMPLETADA' OR t.Estado = 'CANCELADA') ASC, t.FechaLimite IS NULL, t.FechaLimite ASC
          LIMIT ${MAX_FILAS_POR_TEMA}`,
        params
      );
      return limpiarFilas(filas);
    },
  },
  {
    clave: 'pasos_produccion',
    modulos: ['PASOS_PRODUCCION'],
    patrones: /paso a produccion|pasos a produccion|\bpasos?\b|\brfc\b|\bpase\b|release|despliegue a produccion|ventana|commit|rollback|revertid/,
    async obtener(pool, ctx) {
      const buscar = ctx.palabras;
      // La bitácora es privada: el asistente solo cuenta pasos que esta persona puede ver
      // (el id del usuario viene del token y es numérico: se incrusta ya formateado).
      const visible = await require('./bitacoraAcceso').condicionVisible(pool, 'p', ctx.user);
      const visibleSql = pool.format(visible.sql, visible.params);
      const params = [];
      let where = '';
      if (buscar.length) {
        where = `WHERE (${buscar.map(() => '(p.Rfc LIKE ? OR p.Titulo LIKE ? OR ia.nombre_aplicacion LIKE ?)').join(' OR ')})`;
        buscar.forEach((p) => params.push(`%${p}%`, `%${p}%`, `%${p}%`));
      }
      const sql = (w, lim = MAX_FILAS_POR_TEMA) => `
        SELECT p.Rfc AS rfc, p.Titulo AS titulo, p.Entorno AS entorno, p.Estado AS estado,
               p.FechaHoraProgramada AS programado, p.FechaHoraInicioReal AS inicio_real, p.FechaHoraFinReal AS fin_real,
               ia.nombre_aplicacion AS aplicativo, ucr.nombre_completo AS creado_por, uej.nombre_completo AS ejecutado_por,
               p.CommitRepo AS repo, p.CommitRama AS rama
          FROM PasosProduccion p
          INNER JOIN usuarios ucr ON ucr.id = p.CreadoPorId
          LEFT JOIN usuarios uej ON uej.id = p.EjecutadoPorId
          LEFT JOIN vw_inventario_aplicativos ia ON ia.id = p.AplicativoId
          ${w ? `${w} AND ${visibleSql}` : `WHERE ${visibleSql}`}
         ORDER BY p.FechaHoraProgramada DESC LIMIT ${lim}`;
      return consultarFiltrado(pool, sql, where, params, buscar);
    },
  },
  {
    clave: 'calendario',
    modulos: ['CALENDARIO'],
    soloManual: true,
    patrones: /calendario|agenda|reunion|evento|google calendar/,
    async obtener() { return []; },
  },
  {
    clave: 'swagger',
    modulos: ['SWAGGER'],
    soloManual: true,
    patrones: /swagger|openapi|consumo de servicio|consumos guardados/,
    async obtener() { return []; },
  },
  {
    clave: 'biometria',
    modulos: ['BIOMETRIA'],
    soloManual: true,
    patrones: /biometr[ií]a|firmas? en reintento|motorfirma|orqbiometria|pendiente de firma/,
    async obtener() { return []; },
  },
  {
    clave: 'repositorio',
    modulos: ['REPOSITORIO'],
    soloManual: true,
    patrones: /repositorio|azure|devops|carpeta de servicio|documentacion de servicio/,
    async obtener() { return []; },
  },
  {
    clave: 'app_movil',
    modulos: ['APP_MOVIL'],
    patrones: /app movil|movil|logapp|transaccion|canal|tasa de exito|usuarios unicos|dispositivo|fabricante|errores de la app/,
    async obtener(pool, ctx) {
      const datos = ctx.proveedores.appMovil ? await ctx.proveedores.appMovil() : null;
      if (!datos) return [{ nota: 'Los datos de App Móvil todavía no están calculados; el usuario puede abrir la pantalla App Móvil para verlos.' }];
      return limpiarFilas([
        { periodo: `ultimos ${datos.dias} dias`, ...datos.resumen },
        ...(datos.porCanal || []).slice(0, 8).map((c) => ({ canal: c.canalCodigo, transacciones: c.total, errores: c.errores })),
        ...(datos.porDispositivo || []).slice(0, 6).map((d) => ({ dispositivo: d.etiqueta, transacciones: d.total })),
        ...(datos.topErrores || []).slice(0, 8).map((e) => ({ metodo_con_errores: `${e.clase}.${e.metodo}`, fallos: e.cantidadFallos })),
      ]);
    },
  },
  {
    clave: 'balanceador_f5',
    modulos: ['BALANCEADOR_F5'],
    patrones: /\bf5\b|balanceador|virtual server|\bvip\b|\bpool\b|miembros? del pool|trafico|conexiones abiertas/,
    async obtener(pool, ctx) {
      const datos = ctx.proveedores.f5 ? await ctx.proveedores.f5() : null;
      if (!datos || datos.length === 0) return [{ nota: 'No se pudo consultar el F5 en este momento (o no hay equipos configurados).' }];
      return limpiarFilas(datos.slice(0, MAX_FILAS_POR_TEMA));
    },
  },
  {
    clave: 'n8n',
    modulos: ['ORQUESTADOR_N8N'],
    patrones: /n8n|workflow|flujo|orquestador|automatizacion|ejecuciones/,
    async obtener(pool, ctx) {
      const datos = ctx.proveedores.n8n ? await ctx.proveedores.n8n(ctx.user) : null;
      if (!datos) return [{ nota: 'No se pudo consultar n8n en este momento.' }];
      return limpiarFilas([datos.resumen, ...datos.workflows.slice(0, MAX_FILAS_POR_TEMA - 1)]);
    },
  },
  {
    // Tema por defecto: si la pregunta no calza con ningún otro, se manda un
    // resumen de números solo de los módulos que el usuario tiene habilitados.
    clave: 'resumen',
    modulos: null,
    patrones: null,
    esDefault: true,
    async obtener(pool, ctx) {
      const r = {};
      const tiene = (m) => ctx.modulos.includes(m);
      if (tiene('SERVIDORES') || tiene('CERTIFICADOS')) {
        const [[s]] = await pool.query('SELECT COUNT(*) AS total FROM Servidores');
        r.total_servidores = s.total;
        const [[a]] = await pool.query('SELECT COUNT(*) AS total FROM Aplicaciones WHERE ServidorId IS NULL');
        r.total_aplicaciones_de_negocio = a.total;
      }
      if (tiene('SERVIDORES')) {
        const [[c]] = await pool.query('SELECT COUNT(*) AS total FROM Servidor_Componentes');
        r.total_sub_aplicativos = c.total;
      }
      if (tiene('CERTIFICADOS')) {
        const [[c]] = await pool.query(
          'SELECT COUNT(*) AS total, SUM(CASE WHEN DiasRestantes <= 30 THEN 1 ELSE 0 END) AS por_vencer FROM VW_CertificadosVigencia'
        );
        r.total_certificados = c.total;
        r.certificados_por_vencer_30_dias = c.por_vencer || 0;
      }
      if (tiene('SERVICIOS')) {
        const [[c]] = await pool.query('SELECT COUNT(*) AS total FROM AceServiciosInventario');
        r.total_servicios_ace = c.total;
        const [[p]] = await pool.query('SELECT COUNT(*) AS total FROM Apuntamientos');
        r.total_apuntamientos = p.total;
      }
      if (tiene('TAREAS')) {
        const [[t]] = await pool.query(
          `SELECT COUNT(*) AS total FROM Tareas t
            WHERE t.Estado NOT IN ('COMPLETADA','CANCELADA')
              AND (t.CreadoPorId = ? OR EXISTS (SELECT 1 FROM TareaAsignados ta WHERE ta.TareaId = t.Id AND ta.UsuarioId = ?))`,
          [ctx.user.id, ctx.user.id]
        );
        r.tareas_abiertas = t.total;
      }
      return [r];
    },
  },
];

// ==========================================================================
// Detección y permisos
// ==========================================================================
// Devuelve los temas que calzan con el texto (en orden de definición), cada
// uno marcado como permitido o no según los módulos del usuario.
function detectarTemas(pregunta, modulosUsuario) {
  const texto = normalizar(pregunta);
  const calzan = TEMAS.filter((t) => t.patrones && t.patrones.test(texto));
  const permitidos = [];
  const denegados = [];
  for (const t of calzan) {
    const ok = !t.modulos || t.modulos.some((m) => modulosUsuario.includes(m));
    (ok ? permitidos : denegados).push(t);
  }
  return { permitidos, denegados };
}

function nombresDeModulos(temasDenegados) {
  const nombres = new Set();
  for (const t of temasDenegados) {
    // Si el tema sirve a varios módulos, se nombra el primero (el "dueño").
    const modulo = (t.modulos || [])[0];
    if (modulo && MODULOS_INFO[modulo]) nombres.add(MODULOS_INFO[modulo].nombre);
  }
  return [...nombres];
}

// ==========================================================================
// Cache por tema + filtros (evita re-consultar en cada mensaje del chat)
// ==========================================================================
const cache = new Map();

async function obtenerDatosDeTema(tema, pool, ctx) {
  // Los temas por usuario (tareas, resumen, n8n: cada quien ve solo sus flujos) o por filtro se cachean aparte.
  const sufijo = ['tareas', 'resumen', 'n8n', 'pasos_produccion'].includes(tema.clave) ? `|u${ctx.user.id}|${ctx.modulos.join(',')}` : '';
  const clave = `${tema.clave}|${ctx.palabras.join(',')}|${ctx.ips.join(',')}${sufijo}`;
  const guardada = cache.get(clave);
  if (guardada && Date.now() - guardada.t < CACHE_TTL_MS) return guardada.datos;

  let datos;
  try {
    datos = await tema.obtener(pool, ctx);
  } catch (err) {
    // Si UN tema falla (vista/columna que cambió), no se cae el chat entero.
    console.warn(`Aviso: el tema "${tema.clave}" del asistente fallo:`, err.message);
    datos = [{
      nota: 'ERROR: no se pudieron leer estos datos de la base de datos en este momento. No inventes nada: ' +
        'di que no pudiste consultarlos y que revise la pantalla correspondiente o intente de nuevo.',
    }];
  }
  if (cache.size > 300) cache.clear();
  cache.set(clave, { datos, t: Date.now() });
  return datos;
}

module.exports = {
  TEMAS,
  MODULOS_INFO,
  ADMIN_ONLY_INFO,
  MAX_FILAS_POR_TEMA,
  quitarTildes,
  normalizar,
  limpiarFilas,
  bloqueATexto,
  extraerPalabrasClave,
  extraerIps,
  detectarTemas,
  nombresDeModulos,
  obtenerDatosDeTema,
};
