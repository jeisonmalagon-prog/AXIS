// ============================================================================
// CATÁLOGO DE NAVEGACIÓN — única fuente de verdad del menú de AXIS.
//
// De aquí salen: el menú lateral, el buscador (Ctrl+K), las migas de pan de la
// barra superior, la ayuda de cada pantalla y los favoritos/recientes. Para
// añadir una pantalla nueva basta con agregarla aquí (y su ruta en
// app.routes.ts); el permiso se resuelve con el mismo criterio de siempre
// (tieneModulo): ADMIN_POD ve todo, el resto solo lo que tiene habilitado.
//
// Los textos están pensados para personas NO técnicas: nombres claros,
// descripciones en una frase y "palabras" con los términos que la gente
// realmente escribe al buscar (sinónimos, problemas, tareas).
// ============================================================================

export type ModuloPermiso = string | 'ADMIN_ONLY' | null;

export interface NavItem {
  id: string;
  titulo: string;
  descripcion: string;
  ruta: string;
  /** Módulo que debe tener habilitado el usuario (null = cualquiera). */
  modulo: ModuloPermiso;
  /** Términos de búsqueda extra (sinónimos y frases cotidianas). */
  palabras: string[];
}

export interface NavArea {
  id: string;
  titulo: string;
  descripcion: string;
  seccion: string;
  modulo: ModuloPermiso;
  /** Marcado SVG interno (viewBox 24x24, trazo). */
  icono: string;
  items: NavItem[];
}

export interface NavSeccion {
  id: string;
  titulo: string | null;
}

export interface AccionRapida {
  id: string;
  titulo: string;
  descripcion: string;
  ruta: string;
  modulo: ModuloPermiso;
  palabras: string[];
}

export const SECCIONES: NavSeccion[] = [
  { id: 'principal', titulo: null },
  { id: 'trabajo', titulo: 'Mi trabajo' },
  { id: 'seguridad', titulo: 'Certificados y servicios' },
  { id: 'infra', titulo: 'Infraestructura' },
  { id: 'apps', titulo: 'Aplicaciones y datos' },
  { id: 'admin', titulo: 'Administración' },
];

const IC = {
  inicio: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  asistente: '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
  tareas: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  calendario: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  produccion: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>',
  manuales: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h7"/>',
  certificados: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  servicios: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  servidores: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  f5: '<path d="M4 12h4l2-7 4 14 2-7h4"/>',
  n8n: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  appMovil: '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  biometria: '<path d="M12 11c0 3.5-.5 6-2 8"/><path d="M8 11a4 4 0 0 1 8 0c0 2.5-.3 4.6-1 6.5"/><path d="M5 11a7 7 0 0 1 14 0c0 1.2 0 2.3-.2 3.4"/><path d="M3 14c.2-1 .3-2 .3-3"/><path d="M12 3a8 8 0 0 0-8 8"/>',
  datos: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><circle cx="7.5" cy="8.5" r="1.1"/><circle cx="16.5" cy="9" r="1.1"/><circle cx="15" cy="16.5" r="1.1"/><path d="M9.8 11 8.3 9.3M14 11l1.6-1.2M13.4 13.6l1 1.9"/>',
  swagger: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/>',
  repo: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  usuarios: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  soporte: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  informes: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 18v-3M12 18v-6M16 18v-4"/>',
  apariencia: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
};
export const ICONOS: Record<string, string> = { ...IC, pasos: IC.produccion, appmovil: IC.appMovil };

export const AREAS: NavArea[] = [
  // ------------------------------------------------------------ principal
  {
    id: 'inicio', titulo: 'Inicio', seccion: 'principal', modulo: null, icono: IC.inicio,
    descripcion: 'Resumen en vivo de lo que importa hoy.',
    items: [{ id: 'inicio', titulo: 'Inicio', ruta: '/inicio', modulo: null,
      descripcion: 'Resumen en vivo de lo que importa hoy: estado de los servicios, certificados y más.',
      palabras: ['resumen', 'portada', 'principal', 'home', 'metricas', 'estado general', 'tablero'] }],
  },
  {
    id: 'asistente', titulo: 'Asistente IA', seccion: 'principal', modulo: null, icono: IC.asistente,
    descripcion: 'Pregunta en lenguaje normal.',
    items: [{ id: 'asistente', titulo: 'Asistente IA', ruta: '/asistente', modulo: null,
      descripcion: 'Escribe tu pregunta como se la harías a un compañero y el asistente la busca por ti.',
      palabras: ['preguntar', 'ayuda', 'chat', 'inteligencia artificial', 'consultar', 'no se donde esta', 'bot'] }],
  },

  // ------------------------------------------------------------ mi trabajo
  {
    id: 'tareas', titulo: 'Tareas', seccion: 'trabajo', modulo: 'TAREAS', icono: IC.tareas,
    descripcion: 'Tus pendientes y los del equipo.',
    items: [{ id: 'tareas', titulo: 'Tareas', ruta: '/tareas', modulo: 'TAREAS',
      descripcion: 'Crea, asigna y marca tus pendientes y los del equipo.',
      palabras: ['pendientes', 'to do', 'checklist', 'asignar', 'responsable', 'por hacer', 'actividades'] }],
  },
  {
    id: 'calendario', titulo: 'Calendario', seccion: 'trabajo', modulo: 'CALENDARIO', icono: IC.calendario,
    descripcion: 'Sesiones y fechas del equipo.',
    items: [{ id: 'calendario', titulo: 'Calendario', ruta: '/calendario', modulo: 'CALENDARIO',
      descripcion: 'Mira y agenda las sesiones y fechas importantes del equipo.',
      palabras: ['agenda', 'reunion', 'sesion', 'fecha', 'agendar', 'cita', 'google calendar'] }],
  },
  {
    id: 'pasos', titulo: 'Pasos a Producción', seccion: 'trabajo', modulo: 'PASOS_PRODUCCION', icono: IC.produccion,
    descripcion: 'Registro de despliegues a producción.',
    items: [{ id: 'pasos', titulo: 'Pasos a Producción', ruta: '/pasos-produccion', modulo: 'PASOS_PRODUCCION',
      descripcion: 'Registra y consulta los pasos a producción: qué se desplegó, cuándo y quién lo hizo.',
      palabras: ['despliegue', 'deploy', 'paso a produccion', 'pase', 'release', 'publicar', 'bitacora', 'cambios en produccion'] }],
  },
  {
    id: 'informes', titulo: 'Informes', seccion: 'trabajo', modulo: 'INFORMES', icono: IC.informes,
    descripcion: 'PDF y Excel de cada módulo, con envío programado por correo.',
    items: [{ id: 'informes', titulo: 'Informes', ruta: '/informes', modulo: 'INFORMES',
      descripcion: 'Descarga informes en PDF y Excel (con gráficos) de certificados, servidores, balanceador, app móvil y más; o prográmalos para que lleguen al correo.',
      palabras: ['informe', 'informes', 'reporte', 'reportes', 'excel', 'pdf', 'descargar', 'exportar', 'correo', 'enviar', 'programar', 'semanal', 'mensual', 'resumen ejecutivo', 'general', 'certificados', 'servidores', 'f5', 'app movil', 'apuntamientos', 'pasos a produccion'] }],
  },
  {
    id: 'manuales', titulo: 'Manuales', seccion: 'trabajo', modulo: 'MANUALES', icono: IC.manuales,
    descripcion: 'Procedimientos y guías paso a paso del equipo.',
    items: [{ id: 'manuales', titulo: 'Manuales', ruta: '/manuales', modulo: 'MANUALES',
      descripcion: 'Consulta, escribe e importa procedimientos, comandos y guías paso a paso; busca por cualquier palabra.',
      palabras: ['manual', 'manuales', 'procedimiento', 'procedimientos', 'paso a paso', 'guia', 'instructivo', 'comandos', 'onenote', 'notas', 'documentacion', 'como se hace', 'kafka', 'soporte n1', 'soporte n2', 'word', 'pdf'] }],
  },

  // ------------------------------------------------- certificados y servicios
  {
    id: 'certificados', titulo: 'Certificados', seccion: 'seguridad', modulo: 'CERTIFICADOS', icono: IC.certificados,
    descripcion: 'Vigencia, renovaciones e histórico de certificados.',
    items: [
      { id: 'cert-panel', titulo: 'Panel de vencimientos', ruta: '/dashboard', modulo: 'CERTIFICADOS',
        descripcion: 'Ve de un vistazo cuántos certificados están vigentes, por vencer o vencidos.',
        palabras: ['vencen', 'vencimiento', 'por vencer', 'vencidos', 'vigentes', 'dashboard', 'resumen', 'alertas', 'caducan'] },
      { id: 'cert-lista', titulo: 'Certificados', ruta: '/certificados', modulo: 'CERTIFICADOS',
        descripcion: 'Cada certificado, dónde está instalado y qué aplicaciones de negocio dependen de él. Aquí se registran, se ajustan y se renuevan.',
        palabras: ['registrar', 'renovar', 'ajustar', 'nuevo certificado', 'crear', 'editar', 'ssl', 'tls', 'https', 'fecha de vencimiento', 'cn', 'donde esta instalado', 'instalar certificado', 'servidor del certificado', 'aplicaciones afectadas'] },
      { id: 'cert-historico', titulo: 'Histórico de cambios', ruta: '/historico', modulo: 'CERTIFICADOS',
        descripcion: 'Quién cambió o renovó un certificado, cuándo y qué modificó.',
        palabras: ['historial', 'quien modifico', 'auditoria', 'cambios', 'renovaciones', 'ajustes', 'quien lo hizo', 'bitacora de certificados'] },
    ],
  },
  {
    id: 'servicios', titulo: 'Servicios', seccion: 'seguridad', modulo: 'SERVICIOS', icono: IC.servicios,
    descripcion: 'Catálogo de servicios y apuntamientos a nodos.',
    items: [
      { id: 'srv-catalogo', titulo: 'Catálogo ACE', ruta: '/catalogo-ace', modulo: 'SERVICIOS',
        descripcion: 'Catálogo de servicios publicados en ACE.',
        palabras: ['ace', 'catalogo de servicios', 'endpoints', 'apis'] },
      { id: 'srv-servicios', titulo: 'Servicios', ruta: '/servicios', modulo: 'SERVICIOS',
        descripcion: 'Lista de servicios y a qué nodos apuntan.',
        palabras: ['servicio', 'rest', 'soap', 'nodos', 'url'] },
      { id: 'srv-bitacora', titulo: 'Bitácora de apuntamientos', ruta: '/apuntamientos', modulo: 'SERVICIOS',
        descripcion: 'Registro de a qué nodo apunta cada aplicación y sus cambios.',
        palabras: ['apuntar', 'apuntamiento', 'redirigir', 'cambiar nodo', 'bitacora'] },
      { id: 'srv-historico', titulo: 'Histórico de apuntamientos', ruta: '/apuntamientos-historico', modulo: 'SERVICIOS',
        descripcion: 'Historial de todos los cambios de apuntamiento.',
        palabras: ['historial', 'cambios', 'auditoria', 'quien cambio'] },
      { id: 'srv-validacion', titulo: 'Validación de nodos', ruta: '/validacion-nodos', modulo: 'SERVICIOS',
        descripcion: 'Comprueba que los nodos respondan como se espera.',
        palabras: ['validar', 'probar', 'revisar nodos', 'funciona', 'verificar'] },
    ],
  },

  // ---------------------------------------------------------- infraestructura
  {
    id: 'servidores', titulo: 'Servidores', seccion: 'infra', modulo: 'SERVIDORES', icono: IC.servidores,
    descripcion: 'Inventario y estado de los servidores.',
    items: [
      { id: 'sv-inventario', titulo: 'Inventario', ruta: '/servidores', modulo: 'SERVIDORES',
        descripcion: 'Servidores (Linux y Windows, con el estado de sus certificados), sub-aplicativos y aplicaciones de negocio: aquí se administran y se ve cómo se relacionan.',
        palabras: ['maquinas', 'hostname', 'ip', 'ambiente', 'produccion', 'qa', 'desarrollo', 'vm', 'sub-aplicativos', 'componentes', 'registrar servidor', 'nuevo servidor', 'linux', 'windows', 'sistema operativo', 'servidores con certificados', 'lista de servidores', 'certificados por servidor', 'puertos', 'puerto en uso', 'puertos abiertos', 'puertos en escucha', 'listen', 'que puerto usa un servidor'] },
      { id: 'sv-apps', titulo: 'Aplicaciones de negocio', ruta: '/aplicaciones', modulo: 'CERTIFICADOS',
        descripcion: 'Las aplicaciones de negocio y los sub-aplicativos que las componen. Los certificados se asocian a esos sub-aplicativos.',
        palabras: ['aplicaciones', 'aplicativos', 'sistemas', 'componentes', 'que certificados usa', 'aet', 'aplicacion de negocio', 'crear aplicacion'] },
      { id: 'sv-monitoreo', titulo: 'Monitoreo', ruta: '/monitoreo-servidores', modulo: 'SERVIDORES',
        descripcion: 'Estado en vivo de los servidores y contenedores: si están arriba, caídos o con problemas.',
        palabras: ['caido', 'caida', 'arriba', 'abajo', 'estado', 'salud', 'contenedores', 'docker', 'portainer', 'cpu', 'memoria', 'no responde'] },
      { id: 'sv-impacto', titulo: 'Análisis de impacto', ruta: '/servidores/impacto', modulo: 'SERVIDORES',
        descripcion: 'Qué aplicaciones se afectan si un servidor se apaga o falla.',
        palabras: ['impacto', 'que pasa si', 'afectacion', 'dependencias', 'apagar', 'mantenimiento'] },
    ],
  },
  {
    id: 'soporte', titulo: 'Soporte Nivel 1', seccion: 'infra', modulo: 'SOPORTE_N1', icono: IC.soporte,
    descripcion: 'Reinicios operativos de los monitores (con aprobación por código para el rol Consulta) y monitoreo de la prospección de aliados.',
    items: [{ id: 'soporte-n1', titulo: 'Soporte Nivel 1', ruta: '/soporte-nivel-1', modulo: 'SOPORTE_N1',
      descripcion: 'Reinicia el monitor de pagos o el monitor naranja. Con rol Consulta se pide un código que llega a los aprobadores.',
      palabras: ['reiniciar', 'reinicio', 'monitor de pagos', 'monitor naranja', 'pse', 'contenedor', 'soporte', 'nivel 1', 'otp', 'codigo', 'aprobador', 'se cayo el monitor', 'monitor colgado'] },
    { id: 'soporte-prospeccion', titulo: 'Monitorear prospección', ruta: '/soporte-nivel-1/prospeccion', modulo: 'SOPORTE_N1',
      descripcion: 'Cargues de campañas de los aliados, prospección, procesos aliado, pagarés y trazabilidad por documento (solo lectura).',
      palabras: ['prospeccion', 'prospectos', 'cargue', 'cargues', 'campana', 'campanas', 'aliado', 'aliados', 'proceso aliado', 'pagare', 'pagares', 'gestioncliente', 'trazabilidad', 'documento', 'prospectado', 'lote'] }],
  },
  {
    id: 'f5', titulo: 'Balanceador F5', seccion: 'infra', modulo: 'BALANCEADOR_F5', icono: IC.f5,
    descripcion: 'Servicios publicados y estado de sus nodos.',
    items: [
      { id: 'f5-vs', titulo: 'Servicios publicados', ruta: '/balanceador-f5', modulo: 'BALANCEADOR_F5',
        descripcion: 'Servicios publicados en el balanceador (Virtual Servers) y el estado de cada nodo.',
        palabras: ['virtual server', 'pool', 'nodos', 'trafico', 'balanceador', 'f5', 'disponibilidad', 'caido'] },
    ],
  },
  {
    id: 'n8n', titulo: 'Automatizaciones', seccion: 'infra', modulo: 'ORQUESTADOR_N8N', icono: IC.n8n,
    descripcion: 'Flujos automáticos (N8N).',
    items: [{ id: 'n8n', titulo: 'Flujos automáticos (N8N)', ruta: '/n8n', modulo: 'ORQUESTADOR_N8N',
      descripcion: 'Flujos de trabajo automáticos: cuáles existen, si están activos y cómo les ha ido.',
      palabras: ['workflow', 'workflows', 'automatizacion', 'orquestador', 'flujos', 'robot', 'n8n', 'ejecuciones'] }],
  },

  // ---------------------------------------------------------- aplicaciones y datos
  {
    id: 'appmovil', titulo: 'App Móvil', seccion: 'apps', modulo: 'APP_MOVIL', icono: IC.appMovil,
    descripcion: 'Salud de la app móvil y recorrido de clientes.',
    items: [
      { id: 'am-apm', titulo: 'Monitoreo de la app', ruta: '/app-movil', modulo: 'APP_MOVIL',
        descripcion: 'Cómo está funcionando la app móvil ahora: errores, tiempos y servicios.',
        palabras: ['apm', 'rendimiento', 'errores', 'lenta', 'caida', 'salud', 'monitoreo', 'servicios de la app'] },
      { id: 'am-logs', titulo: 'Recorrido de clientes y logs', ruta: '/app-movil-logs', modulo: 'APP_MOVIL',
        descripcion: 'Mira por qué pantallas y servicios pasó un cliente, o el mapa global del tráfico.',
        palabras: ['logs', 'cliente', 'cedula', 'documento', 'que paso con', 'recorrido', 'flujo', 'mapa', 'trazabilidad', 'consulta de logs', 'fallo del cliente'] },
    ],
  },
  {
    id: 'biometria', titulo: 'Biometría', seccion: 'apps', modulo: 'BIOMETRIA', icono: IC.biometria,
    descripcion: 'Consulta de biometría por cliente y por fecha, y consumo de proveedores.',
    items: [
      { id: 'biometria', titulo: 'Consulta de biometría', ruta: '/biometria', modulo: 'BIOMETRIA',
        descripcion: 'Busca un cliente por cédula, nombre, caso o RadNumber y consulta su biometría en el servidor (curl).',
        palabras: ['biometria', 'cedula', 'cliente', 'curl', 'servidor de biometria', 'caso', 'radicado', 'huella', 'rostro', 'validacion biometrica'] },
      { id: 'biometria-fecha', titulo: 'Biometrías por fecha', ruta: '/biometria/por-fecha', modulo: 'BIOMETRIA',
        descripcion: 'Todas las biometrías de un rango de fechas: estados, resultados y listado de clientes.',
        palabras: ['biometrias', 'por fecha', 'rango', 'estados', 'resultados', 'reporte', 'general', 'cedula original ok', 'reintentos', 'firma'] },
      { id: 'biometria-consumo', titulo: 'Consumo y reusos', ruta: '/biometria/consumo', modulo: 'BIOMETRIA',
        descripcion: 'Consultas por día a ASISA y OLIMPIA, reintentos, clientes que consultan de más y posible sobrecosto.',
        palabras: ['consumo', 'reusos', 'reintentos', 'asisa', 'olimpia', 'proveedor', 'sobrecosto', 'cupo', 'consultas por dia', 'intentos', 'costo', 'canal'] },
    ],
  },
  {
    id: 'datos', titulo: 'Catálogo de datos', seccion: 'apps', modulo: 'CATALOGO_DATOS', icono: IC.datos,
    descripcion: 'Mapa de bases de datos, tablas y relaciones.',
    items: [{ id: 'datos', titulo: 'Catálogo de datos', ruta: '/catalogo-datos', modulo: 'CATALOGO_DATOS',
      descripcion: 'Explora las bases de datos, sus tablas y cómo se relacionan.',
      palabras: ['base de datos', 'tablas', 'columnas', 'relaciones', 'sql', 'esquema', 'diccionario de datos', 'donde esta el dato'] }],
  },
  {
    id: 'swagger', titulo: 'APIs (Swagger)', seccion: 'apps', modulo: 'SWAGGER', icono: IC.swagger,
    descripcion: 'Documentación y pruebas de APIs.',
    items: [{ id: 'swagger', titulo: 'APIs (Swagger)', ruta: '/swagger', modulo: 'SWAGGER',
      descripcion: 'Lee la documentación de una API y prueba sus servicios.',
      palabras: ['api', 'openapi', 'documentacion', 'endpoints', 'probar servicio', 'consumo', 'swagger'] }],
  },
  {
    id: 'repo', titulo: 'Código (Azure DevOps)', seccion: 'apps', modulo: 'REPOSITORIO', icono: IC.repo,
    descripcion: 'Repositorios y cambios de código.',
    items: [{ id: 'repo', titulo: 'Código (Azure DevOps)', ruta: '/repositorio', modulo: 'REPOSITORIO',
      descripcion: 'Consulta repositorios, ramas y cambios de código (solo lectura).',
      palabras: ['repositorio', 'azure', 'devops', 'git', 'commits', 'ramas', 'codigo fuente', 'pull request'] }],
  },

  // ---------------------------------------------------------- administración
  {
    id: 'usuarios', titulo: 'Usuarios y accesos', seccion: 'admin', modulo: 'ADMIN_ONLY', icono: IC.usuarios,
    descripcion: 'Quién entra a AXIS y qué puede hacer.',
    items: [
      { id: 'us-admin', titulo: 'Administrar accesos', ruta: '/usuarios', modulo: 'ADMIN_ONLY',
        descripcion: 'Crea usuarios y decide a qué áreas puede entrar cada uno.',
        palabras: ['usuarios', 'permisos', 'accesos', 'roles', 'crear usuario', 'dar acceso', 'quitar acceso', 'contraseña', 'clave', 'resetear'] },
      { id: 'us-audit', titulo: 'Auditoría de usuarios', ruta: '/usuarios-auditoria', modulo: 'ADMIN_ONLY',
        descripcion: 'Quién hizo qué en el sistema y cuándo.',
        palabras: ['auditoria', 'quien hizo', 'registro de actividad', 'seguridad', 'inicios de sesion', 'logins'] },
    ],
  },
  {
    id: 'apariencia', titulo: 'Configuración', seccion: 'admin', modulo: 'ADMIN_ONLY', icono: IC.apariencia,
    descripcion: 'Tema, color de marca y correo saliente.',
    items: [{ id: 'apariencia', titulo: 'Configuración', ruta: '/configuracion', modulo: 'ADMIN_ONLY',
      descripcion: 'Tema (claro u oscuro), color de marca y el correo (SMTP) desde el que AXIS envía códigos, informes y alertas.',
      palabras: ['tema', 'oscuro', 'claro', 'colores', 'configuracion', 'personalizar', 'login', 'apariencia', 'correo', 'smtp', 'email', 'mail', 'recuperar contrasena'] }],
  },
];

// Pantallas que no están en el menú pero sí existen (migas de pan y ayuda).
export const EXTRAS: NavItem[] = [
  { id: 'perfil', titulo: 'Mi perfil', ruta: '/perfil', modulo: null,
    descripcion: 'Tus datos, tu foto, tu contraseña y cuánto tiempo puede estar inactiva tu sesión.',
    palabras: ['cuenta', 'contraseña', 'clave', 'foto', 'cambiar contraseña', 'sesion', 'mis datos', 'tema'] },
];

// Frases de lo que la gente quiere HACER, redactadas como lo diría un usuario.
// Cada una lleva a la pantalla correcta; aparecen como sugerencias en el buscador.
export const ACCIONES: AccionRapida[] = [
  { id: 'ac-manual', titulo: 'Buscar un procedimiento o manual paso a paso', descripcion: 'Manuales', ruta: '/manuales', modulo: 'MANUALES',
    palabras: ['como se hace', 'procedimiento', 'manual', 'paso a paso', 'instructivo', 'comando', 'guia', 'onenote', 'reiniciar', 'soporte'] },
  { id: 'ac-vencen', titulo: 'Ver qué certificados están por vencer', descripcion: 'Panel de vencimientos', ruta: '/dashboard', modulo: 'CERTIFICADOS',
    palabras: ['vencer', 'vencen', 'vencimiento', 'caducar', 'expirar', 'renovar a tiempo'] },
  { id: 'ac-renovar', titulo: 'Renovar o ajustar un certificado', descripcion: 'Lista de certificados', ruta: '/certificados', modulo: 'CERTIFICADOS',
    palabras: ['renovar', 'ajustar', 'actualizar fecha', 'nueva fecha', 'cambiar vigencia', 'registrar certificado'] },
  { id: 'ac-quien', titulo: 'Saber quién cambió un certificado', descripcion: 'Histórico de cambios', ruta: '/historico', modulo: 'CERTIFICADOS',
    palabras: ['quien', 'cambio', 'modifico', 'historial', 'auditoria'] },
  { id: 'ac-cliente', titulo: 'Ver qué le pasó a un cliente en la app móvil', descripcion: 'Recorrido de clientes y logs', ruta: '/app-movil-logs', modulo: 'APP_MOVIL',
    palabras: ['cliente', 'cedula', 'documento', 'fallo', 'error del cliente', 'no pudo', 'reclamo', 'queja', 'recorrido'] },
  { id: 'ac-caido', titulo: 'Revisar si un servidor está caído', descripcion: 'Monitoreo de servidores', ruta: '/monitoreo-servidores', modulo: 'SERVIDORES',
    palabras: ['caido', 'no responde', 'abajo', 'falla', 'servidor', 'estado'] },
  { id: 'ac-impacto', titulo: 'Saber qué se afecta si apago un servidor', descripcion: 'Análisis de impacto', ruta: '/servidores/impacto', modulo: 'SERVIDORES',
    palabras: ['apagar', 'mantenimiento', 'impacto', 'que pasa si', 'afectar'] },
  { id: 'ac-reiniciar-monitor', titulo: 'Reiniciar el monitor de pagos o el monitor naranja', descripcion: 'Soporte Nivel 1', ruta: '/soporte-nivel-1', modulo: 'SOPORTE_N1',
    palabras: ['reiniciar', 'monitor', 'pagos', 'naranja', 'colgado', 'no refresca', 'soporte'] },
  { id: 'ac-nodos', titulo: 'Ver el estado de los nodos del balanceador', descripcion: 'Balanceador F5', ruta: '/balanceador-f5', modulo: 'BALANCEADOR_F5',
    palabras: ['nodos', 'balanceador', 'f5', 'pool', 'caido', 'virtual server'] },
  { id: 'ac-paso', titulo: 'Registrar un paso a producción', descripcion: 'Pasos a Producción', ruta: '/pasos-produccion', modulo: 'PASOS_PRODUCCION',
    palabras: ['despliegue', 'pase', 'registrar', 'produccion', 'release'] },
  { id: 'ac-tareas', titulo: 'Ver mis tareas pendientes', descripcion: 'Tareas', ruta: '/tareas', modulo: 'TAREAS',
    palabras: ['pendientes', 'por hacer', 'mis tareas', 'asignadas'] },
  { id: 'ac-agendar', titulo: 'Agendar una sesión con el equipo', descripcion: 'Calendario', ruta: '/calendario', modulo: 'CALENDARIO',
    palabras: ['reunion', 'agendar', 'cita', 'sesion'] },
  { id: 'ac-informe', titulo: 'Descargar un informe', descripcion: 'Informes', ruta: '/informes', modulo: 'INFORMES',
    palabras: ['informe', 'reporte', 'excel', 'descargar', 'exportar'] },
  { id: 'ac-asistente', titulo: 'Preguntarle algo al asistente', descripcion: 'Asistente IA', ruta: '/asistente', modulo: null,
    palabras: ['preguntar', 'no se donde', 'ayuda', 'consultar', 'duda'] },
  { id: 'ac-clave', titulo: 'Cambiar mi contraseña', descripcion: 'Mi perfil', ruta: '/perfil', modulo: null,
    palabras: ['contraseña', 'clave', 'password', 'cambiar clave'] },
  { id: 'ac-acceso', titulo: 'Dar o quitar acceso a un usuario', descripcion: 'Administrar accesos', ruta: '/usuarios', modulo: 'ADMIN_ONLY',
    palabras: ['permiso', 'acceso', 'crear usuario', 'quitar', 'rol'] },
];

// ---------------------------------------------------------------------------
// Utilidades de búsqueda (sin tildes, sin mayúsculas, todas las palabras deben coincidir)
// ---------------------------------------------------------------------------
export function normalizar(t: string): string {
  return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export function puntuar(consulta: string, titulo: string, extra: string, palabras: string[], contexto: string): number {
  const tokens = normalizar(consulta).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const t = normalizar(titulo);
  const e = normalizar(extra);
  const p = normalizar(palabras.join(' '));
  const c = normalizar(contexto);
  let total = 0;
  for (const tok of tokens) {
    let s = 0;
    if (t.startsWith(tok)) s = 12;
    else if (t.split(/\s+/).some(w => w.startsWith(tok))) s = 9;
    else if (t.includes(tok)) s = 6;
    else if (p.split(/\s+/).some(w => w.startsWith(tok))) s = 5;
    else if (p.includes(tok)) s = 3;
    else if (e.includes(tok)) s = 2;
    else if (c.includes(tok)) s = 1;
    if (!s) return 0; // todas las palabras tienen que aparecer
    total += s;
  }
  return total;
}
