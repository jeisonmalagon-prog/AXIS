export interface SistemaOperativo {
  Id: number;
  Nombre: string;
}

export interface Servidor {
  Id: number;
  IP: string;
  Hostname: string;
  SistemaOperativoId: number;
  SistemaOperativo?: string;
  Ambiente: string | null;
  Activo: boolean;
  FechaRegistro?: string;
}

export interface Aplicacion {
  Id: number;
  Nombre: string;
  ServidorId: number;
  Hostname?: string;
  IP?: string;
  Activo: boolean;
}

export interface Certificado {
  Id: number;
  // Puede venir null: desde el cambio a certificados compartidos por
  // servidor+componente, un certificado ya no pertenece obligatoriamente a
  // una única aplicación puntual (ver migracion_certificados_compartidos.sql).
  AplicacionId: number | null;
  // "Aplicación interna" (el rol/componente dentro de la app, ej. DOC_MANAGER,
  // AGIL_SOA) y el servidor donde vive ese componente. Ambos son opcionales
  // porque los certificados creados antes de este campo pueden no tenerlos.
  ServidorId?: number | null;
  Componente?: string | null;
  NombreComun: string | null;
  EntidadEmisora: string | null;
  NumeroSerie: string | null;
  Thumbprint: string | null;
  Puerto: number | null;
  FechaInicio: string;
  FechaFin: string;
  Responsable: string | null;
  Observaciones: string | null;
  Activo: boolean;
}

export interface CertificadoVigencia extends Certificado {
  Hostname: string;
  IP: string;
  SistemaOperativo: string;
  Aplicacion: string;
  DiasRestantes: number;
  Estado: 'Vigente' | 'Por vencer' | 'Vencido';
  FechaUltimaActualizacion: string;
}

export interface HistoricoCertificado {
  Id: number;
  CertificadoId: number;
  Accion: string;
  FechaInicioAnterior: string | null;
  FechaFinAnterior: string | null;
  FechaInicioNueva: string | null;
  FechaFinNueva: string | null;
  UsuarioSistema: string;
  FechaCambio: string;
  Observaciones: string | null;
  NombreComun?: string;
  Aplicacion?: string;
  Hostname?: string;
}

export interface ResumenDashboard {
  Vigente: number;
  'Por vencer': number;
  Vencido: number;
}

// ==========================================================================
// INFORME DE CERTIFICADOS (Fase 1 del informe general del aplicativo)
// Ver backend/routes/reportes.js → armarDatosInforme() — esta interfaz debe
// reflejar exactamente esa forma de respuesta.
// ==========================================================================

export interface RankingCritico {
  nombre: string;
  total: number;
}

// Estadística de los informes (tendencia por cubetas de tiempo y comparación
// contra el periodo anterior equivalente). cambioPorc = null significa "sin base
// de comparación" (el periodo anterior tuvo 0): la UI lo muestra como "—".
export interface PeriodoComparado {
  desde: string;
  hasta: string;
}

export interface MetricaComparada {
  actual: number;
  anterior: number;
  cambioPorc: number | null;
}

export interface PuntoTendenciaCertificados {
  etiqueta: string;
  desde: string;
  hasta: string;
  altas: number;
  renovaciones: number;
  vencidos: number;
}

export interface ComparacionCertificados {
  periodoAnterior: PeriodoComparado;
  altas: MetricaComparada;
  renovaciones: MetricaComparada;
  vencidos: MetricaComparada;
  actividadTotal: MetricaComparada;
}

export interface InformeCertificados {
  periodo: { desde: string; hasta: string };
  resumen: ResumenDashboard;
  vencidosEnPeriodo: CertificadoVigencia[];
  actividadEnPeriodo: HistoricoCertificado[];
  altasEnPeriodo: number;
  renovacionesEnPeriodo: number;
  topResponsablesCriticos: RankingCritico[];
  topAplicacionesCriticas: RankingCritico[];
  topServidoresCriticos: RankingCritico[];
  tendencia: PuntoTendenciaCertificados[];
  comparacion: ComparacionCertificados;
  totalActivos: number;
  tasaRenovacionPorc: number | null;
  promedioDiasParaVencer: number | null;
}

// ==========================================================================
// INFORME DE SERVIDORES / MONITOREO (Fase 2). Ver
// backend/utils/informeServidores.js → armarDatosInformeServidores().
// ==========================================================================

export interface ResumenActualFlota {
  configurado: boolean;
  entornosTotal: number;
  entornosArriba: number;
  contenedoresTotal: number;
  contenedoresCorriendo: number;
  contenedoresDetenidos: number;
  cpuPromedioActual: number;
  memUsadaActualGb: number;
}

export interface PuntoTendenciaServidores {
  fecha: string;
  contenedoresTotalProm: number;
  contenedoresCorriendoProm: number;
  cpuPromedio: number;
  memUsadaGb: number;
}

export interface RankingEntorno {
  entornoId: number;
  entorno: string;
  cpuPromedio: number;
  memUsadaGbProm: number;
  capturas: number;
}

export interface InformeServidores {
  periodo: { desde: string; hasta: string };
  portainerConfigurado: boolean;
  resumenActual: ResumenActualFlota;
  tendenciaDiaria: PuntoTendenciaServidores[];
  picosPeriodo: { cpuPico: number; memPico: number; totalCapturas: number };
  topEntornosPorCpu: RankingEntorno[];
  topEntornosPorMemoria: RankingEntorno[];
}

// ==========================================================================
// INFORME DE BITÁCORA DE APUNTAMIENTOS (Fase 2). Ver
// backend/utils/informeApuntamientos.js → armarDatosInformeApuntamientos().
// ==========================================================================

export interface ResumenApuntamientosActual {
  total: number;
  sinApuntamiento: number;
  ace: number;
  busIntegracion10: number;
}

export interface IncidenciaApuntamiento {
  Id: number;
  ApuntamientoId: number;
  Accion: string;
  AplicacionNuevoNombre: string | null;
  ServidorNuevoHostname: string | null;
  ComponenteNuevo: string | null;
  CategoriaNueva: string | null;
  ServicioNuevoCodigo: string | null;
  ServicioNuevoNombre: string | null;
  Observaciones: string | null;
  TrandId: string | null;
  ErrorDescripcion: string | null;
  Usuario: string;
  FechaCambio: string;
}

export interface PuntoTendenciaApuntamientos {
  etiqueta: string;
  desde: string;
  hasta: string;
  altas: number;
  ajustes: number;
  incidencias: number;
}

export interface ComparacionApuntamientos {
  periodoAnterior: PeriodoComparado;
  altas: MetricaComparada;
  ajustes: MetricaComparada;
  incidencias: MetricaComparada;
}

export interface InformeApuntamientos {
  periodo: { desde: string; hasta: string };
  resumenActual: ResumenApuntamientosActual;
  altasEnPeriodo: number;
  ajustesEnPeriodo: number;
  incidenciasEnPeriodo: IncidenciaApuntamiento[];
  topServiciosPorIncidencias: RankingCritico[];
  topAplicacionesPorIncidencias: RankingCritico[];
  // Campos de estadística: opcionales por si el backend aún no los envía.
  tendencia?: PuntoTendenciaApuntamientos[];
  comparacion?: ComparacionApuntamientos;
}

// ==========================================================================
// INFORME DE APLICACIONES E INVENTARIO DE SUB-APLICATIVOS (Fase 2). Ver
// backend/utils/informeAplicaciones.js → armarDatosInformeAplicaciones().
//
// A diferencia de los demás informes de Fase 2, este es principalmente un
// SNAPSHOT del estado actual (Aplicaciones/inv_aplicativos no tienen fecha
// de auditoría real) — lo único filtrado por periodo son las conexiones a
// bases de datos registradas.
// ==========================================================================

export interface ResumenActualAplicaciones {
  totalAplicacionesNegocio: number;
  totalSubaplicativos: number;
  totalServidores: number;
  servidoresSinAplicativos: number;
  subaplicativosSinCertificado: number;
}

export interface ServidorSinAplicativos {
  Id: number;
  Hostname: string;
  IP: string;
}

export interface SubaplicativoSinCertificado {
  Id: number;
  Nombre: string;
  Hostname: string | null;
}

export interface ConexionBdAplicativo {
  id: number;
  motor_bd: string;
  nombre_base_datos: string;
  esquema: string | null;
  usuario_servicio: string | null;
  fecha_registro: string;
  AplicativoNombre: string | null;
  ServidorBdHostname: string | null;
}

export interface PuntoTendenciaConexionesBd {
  etiqueta: string;
  desde: string;
  hasta: string;
  total: number;
}

export interface ComparacionConexionesBd extends MetricaComparada {
  periodoAnterior: PeriodoComparado;
}

export interface InformeAplicaciones {
  periodo: { desde: string; hasta: string };
  resumenActual: ResumenActualAplicaciones;
  servidoresSinAplicativos: ServidorSinAplicativos[];
  subaplicativosSinCertificado: SubaplicativoSinCertificado[];
  criticidadSubaplicativos: RankingCritico[];
  altasConexionesBdEnPeriodo: number;
  conexionesBdEnPeriodo: ConexionBdAplicativo[];
  topMotoresBd: RankingCritico[];
  // Campos de estadística: opcionales por si el backend aún no los envía.
  tendenciaConexionesBd?: PuntoTendenciaConexionesBd[];
  comparacionConexionesBd?: ComparacionConexionesBd;
}

// ==========================================================================
// INFORME DE BALANCEADOR F5 (Fase 2). Ver backend/utils/informeF5.js →
// armarDatosInformeF5().
//
// El F5 no tenía histórico antes de esta fase — un job en segundo plano
// (capturarSnapshotHistoricoF5, en backend/routes/f5Monitoreo.js) empieza a
// llenar la tabla f5_historico cada 10 minutos desde que este código se
// despliega, así que tendenciaDiaria/picosPeriodo pueden venir vacíos para
// un periodo anterior a esa fecha, aunque el F5 sí estuviera funcionando.
// resumenActual, en cambio, SÍ es en vivo (iControl REST).
// ==========================================================================

export interface DispositivoF5ConError {
  id: string;
  nombre: string;
  error: string;
}

export interface ResumenActualF5 {
  configurado: boolean;
  dispositivosTotal: number;
  virtualesTotal: number;
  virtualesArriba: number;
  virtualesAbajo: number;
  nodosTotal: number;
  nodosArriba: number;
  nodosAbajo: number;
  dispositivosConError: DispositivoF5ConError[];
}

export interface PuntoTendenciaF5 {
  fecha: string;
  virtualesTotalProm: number;
  virtualesArribaProm: number;
  nodosTotalProm: number;
  nodosArribaProm: number;
  // Disponibilidad del día en % (promedio y mínimo de las capturas). Opcionales.
  virtualesPct?: number | null;
  nodosPct?: number | null;
  virtualesPctMin?: number | null;
  nodosPctMin?: number | null;
}

export interface PromedioDispositivoF5 {
  dispositivoId: string;
  dispositivoNombre: string;
  virtualesArribaProm: number;
  virtualesTotalProm: number;
  nodosArribaProm: number;
  nodosTotalProm: number;
  virtualesPct?: number | null;
  nodosPct?: number | null;
  capturas: number;
}

// Estado de un nodo según el F5: 'deshabilitado' = un administrador lo sacó de
// servicio; 'caido' = el monitor de salud lo marca abajo; 'disponible' = en servicio.
export type EstadoNodoF5 = 'disponible' | 'caido' | 'deshabilitado';

// Resumen del tráfico de un nodo/pool en el periodo (lecturas cada 5 min).
export interface ResumenTraficoF5 {
  muestras: number;
  entradaPromBps: number | null;
  salidaPromBps: number | null;
  entradaPicoBps: number | null;
  entradaPicoEn: string | null;
  salidaPicoBps: number | null;
  salidaPicoEn: string | null;
  conexionesProm: number | null;
  conexionesPico: number;
  conexionesPicoEn: string | null;
  conexionesNuevas: number;
  datosEntradaBytes: number;
  datosSalidaBytes: number;
  minutosConTrafico: number;
  ultimoTraficoEn: string | null;
}

export interface VirtualServerInformeF5 {
  dispositivoId: string;
  dispositivoNombre: string;
  nombre: string;
  alias: string | null;
  nombreMostrado: string;
  fullPath: string;
  destino: string | null;
  pool: string | null;
  // Cuántos OTROS Virtual Servers comparten su pool (el tráfico se mide en el pool).
  poolCompartidoCon: number;
  habilitado: boolean;
  estado: string;
  motivoEstado: string | null;
  nodosArriba: number | null;
  nodosTotal: number | null;
  nodosDeshabilitados: number;
  nodosCaidos: number;
  conexionesActuales: number | null;
  trafico: ResumenTraficoF5 | null;
  transacciones: number | null;
}

export interface NodoInformeF5 {
  dispositivoId: string;
  dispositivoNombre: string;
  virtuales: string[];
  virtualNombre: string;
  pool: string | null;
  miembro: string;
  direccion: string;
  puerto: number | null;
  estado: EstadoNodoF5;
  motivoEstado: string | null;
  estadoMonitor: string | null;
  ultimoTraficoEn: string | null;
  trafico: ResumenTraficoF5 | null;
  transacciones: number | null;
}

export interface PuntoTraficoDiarioF5 {
  fecha: string; // YYYY-MM-DD
  entradaPromBps: number | null;
  salidaPromBps: number | null;
  entradaPicoBps: number | null;
  salidaPicoBps: number | null;
  conexionesPico: number | null;
  conexionesNuevas: number | null;
  datosEntradaBytes: number | null;
  datosSalidaBytes: number | null;
  lecturas: number;
  transacciones: number | null;
}

export interface ResumenPeriodoF5 {
  disponibilidadVirtualesPct: number | null;
  disponibilidadNodosPct: number | null;
  entradaPromBps: number | null;
  salidaPromBps: number | null;
  entradaPicoBps: number | null;
  entradaPicoEn: string | null;
  salidaPicoBps: number | null;
  salidaPicoEn: string | null;
  conexionesPico: number | null;
  conexionesPicoEn: string | null;
  conexionesNuevas: number;
  datosEntradaBytes: number;
  datosSalidaBytes: number;
  transaccionesTotal: number | null;
}

export interface ConteosF5 {
  virtualesDeshabilitados: number;
  nodosDisponibles: number;
  nodosCaidos: number;
  nodosDeshabilitados: number;
  nodosSinTrafico: number;
}

export interface AtencionF5 {
  virtualesAbajo: VirtualServerInformeF5[];
  virtualesDeshabilitados: VirtualServerInformeF5[];
  nodosCaidos: NodoInformeF5[];
  nodosDeshabilitados: NodoInformeF5[];
  nodosSinTrafico: NodoInformeF5[];
}

export interface FuentesF5 {
  disponibilidad: { primeraCaptura: string | null; capturasEnPeriodo: number };
  trafico: { disponible: boolean; fuente: 'bd' | 'memoria' | null; primeraLectura: string | null; lecturas: number; intervaloSegundos: number };
  avr: { disponible: boolean; avisos: string[] };
}

export interface InformeF5 {
  periodo: { desde: string; hasta: string };
  f5Configurado: boolean;
  resumenActual: ResumenActualF5;
  tendenciaDiaria: PuntoTendenciaF5[];
  picosPeriodo: { virtualesAbajoPico: number | null; nodosAbajoPico: number | null; totalCapturas: number };
  porDispositivo: PromedioDispositivoF5[];
  // --- Informe ampliado (opcionales: un backend anterior no los envía) ---
  generadoEn?: string;
  conteos?: ConteosF5;
  resumenPeriodo?: ResumenPeriodoF5;
  traficoDiario?: PuntoTraficoDiarioF5[];
  virtuales?: VirtualServerInformeF5[];
  nodos?: NodoInformeF5[];
  atencion?: AtencionF5;
  fuentes?: FuentesF5;
  notas?: string[];
}

// ==========================================================================
// INFORME GENERAL DEL APLICATIVO — combina, en un solo informe (pantalla y
// PDF), las secciones que el usuario elija entre los módulos de arriba que
// ya tienen su propio informe individual. Ver
// backend/utils/informeGeneral.js → armarDatosInformeGeneral().
// ==========================================================================

export type ClaveSeccionInforme = 'certificados' | 'servidores' | 'aplicaciones' | 'apuntamientos' | 'f5';

export interface SeccionInformeGeneral {
  clave: ClaveSeccionInforme;
  etiqueta: string;
}

export interface SeccionInformeConError extends SeccionInformeGeneral {
  error: string;
}

export interface InformeGeneral {
  periodo: { desde: string; hasta: string };
  seccionesIncluidas: SeccionInformeGeneral[];
  // Secciones que se pidieron pero el usuario no tiene habilitadas, o que no
  // corresponden a ninguna sección conocida — normalmente vacío, porque la
  // pantalla ya solo ofrece checkboxes de lo permitido, pero el backend
  // filtra igual por si acaso.
  seccionesSinPermiso: string[];
  seccionesDesconocidas: string[];
  // Cada llave es una ClaveSeccionInforme; el valor es null si esa sección
  // falló (ver seccionesConError) o si no se pidió.
  secciones: {
    certificados?: InformeCertificados | null;
    servidores?: InformeServidores | null;
    aplicaciones?: InformeAplicaciones | null;
    apuntamientos?: InformeApuntamientos | null;
    f5?: InformeF5 | null;
  };
  seccionesConError: SeccionInformeConError[];
}

// ==========================================================================
// MÓDULO SERVICIOS (catálogo ACE + inventario de servicios)
// ==========================================================================

export interface AceOperacion {
  Id: number;
  ServicioId: number;
  CodigoOperacion: string | null;
  Operacion: string | null;
  OperacionBackend: string | null;
  Descripcion: string | null;
  DescripcionExcel: string | null;
  Arquitectura: string | null;
  Version: string | null;
  Instancias: number | null;
  Compuestos: number | null;
  Atomicos: number | null;
  Sincrono: boolean;
  Asincrono: boolean;
}

export interface AceServicio {
  Id: number;
  Codigo: string;
  Nombre: string;
  FechaActualizacion: string;
  Operaciones: AceOperacion[];
}

export interface AceServicioInventario {
  Id: number;
  Codigo: string;
  NombreServicio: string;
  UrlDev: string | null;
  UrlQa: string | null;
  UrlPrd: string | null;
  // URLs del mismo servicio en el BUS 10 (UrlDev/UrlQa/UrlPrd son las del BUS ACE 12).
  UrlDevBus10?: string | null;
  UrlQaBus10?: string | null;
  UrlPrdBus10?: string | null;
  // Request (XML SOAP o JSON REST) con el que se consume el servicio.
  // Es el mismo para el BUS ACE 12 y para el BUS 10.
  RequestEjemplo: string | null;
  Pod: string | null;
  // Un mismo código puede existir como SOAP y como REST (filas distintas).
  Tipo: 'SOAP' | 'REST';
  FechaActualizacion: string;
  // Cantidad de archivos de consumo (proyecto SoapUI / colección) adjuntos al servicio.
  NumArchivos?: number;
  NumPeticiones?: number;
}

export interface ArchivoServicio {
  Id: number;
  ServicioId: number;
  NombreOriginal: string;
  /** SOAPUI, POSTMAN, WSDL, OPENAPI, … (lo detecta el backend al subirlo). */
  Clase: string;
  ClaseEtiqueta: string;
  MimeType: string | null;
  TamanoBytes: number;
  Descripcion: string | null;
  SubidoPorId: number | null;
  SubidoPorNombre: string | null;
  FechaSubida: string;
}

export interface ListaArchivosServicio {
  /** false = falta crear la tabla AceServiciosArchivos en la base de datos. */
  disponible: boolean;
  mensaje: string | null;
  archivos: ArchivoServicio[];
}

export interface FilaImportacionBus10 {
  Codigo?: string;
  NombreServicio?: string;
  UrlDev?: string;
  UrlQa?: string;
  UrlPrd?: string;
}

export interface ResultadoImportacionBus10 {
  creados: number;
  actualizados: number;
  sinCambios: number;
  omitidos: number;
  errores: string[];
}

// ==========================================================================
// BITÁCORA DE APUNTAMIENTOS
// ==========================================================================
// Relaciona una Aplicación (y opcionalmente uno de sus "componentes", el
// mismo concepto de rol/servidor que ya se usa en Aplicaciones → Servidores)
// con el servicio de integración al que apunta. Ambas categorías (ACE y Bus
// de Integración 10) usan el MISMO catálogo AceServiciosInventario — la
// categoría solo indica el canal, no un catálogo distinto.
export type CategoriaApuntamiento = 'ACE' | 'BUS_INTEGRACION_10';

export interface Apuntamiento {
  Id: number;
  AplicacionId: number;
  ServidorId: number | null;
  Componente: string | null;
  SinApuntamiento: boolean;
  Categoria: CategoriaApuntamiento | null;
  ServicioInventarioId: number | null;
  Observaciones: string | null;
  FechaRegistro: string;
  FechaActualizacion: string;
  // Campos que agrega el JOIN del backend, para no tener que cruzar listas en el frontend.
  AplicacionNombre?: string;
  ServidorHostname?: string | null;
  ServidorIP?: string | null;
  ServicioCodigo?: string | null;
  ServicioNombre?: string | null;
  ServicioPod?: string | null;
}

// Una fila del histórico de cambios de un apuntamiento (ver
// migracion_apuntamientos_historico.sql): guarda el valor ANTERIOR y el
// NUEVO de cada campo relevante, ya resueltos con nombres/hostnames/códigos
// para no tener que cruzar listas en el frontend.
//
// 'AJUSTE' (ver migracion_apuntamientos_ajustes.sql) es el registro que deja
// "Registrar cambio" (POST /api/apuntamientos/:id/cambios): a diferencia de
// 'ACTUALIZACION' (que ya no se genera — "Editar apuntamiento" no escribe
// histórico), estas filas pueden traer TrandId/ErrorDescripcion/TieneImagen.
export interface ApuntamientoHistorico {
  Id: number;
  ApuntamientoId: number;
  Accion: 'ALTA' | 'ACTUALIZACION' | 'AJUSTE';

  AplicacionIdAnterior: number | null;
  AplicacionAnteriorNombre: string | null;
  AplicacionIdNuevo: number | null;
  AplicacionNuevoNombre: string | null;

  ServidorIdAnterior: number | null;
  ServidorAnteriorHostname: string | null;
  ServidorAnteriorIP: string | null;
  ServidorIdNuevo: number | null;
  ServidorNuevoHostname: string | null;
  ServidorNuevoIP: string | null;

  ComponenteAnterior: string | null;
  ComponenteNuevo: string | null;

  SinApuntamientoAnterior: boolean | null;
  SinApuntamientoNuevo: boolean | null;

  CategoriaAnterior: CategoriaApuntamiento | null;
  CategoriaNueva: CategoriaApuntamiento | null;

  ServicioInventarioIdAnterior: number | null;
  ServicioAnteriorCodigo: string | null;
  ServicioAnteriorNombre: string | null;
  ServicioInventarioIdNuevo: number | null;
  ServicioNuevoCodigo: string | null;
  ServicioNuevoNombre: string | null;

  Observaciones: string | null;
  // Solo presentes en filas 'AJUSTE' (ver nota de arriba); null en 'ALTA'.
  TrandId: string | null;
  ErrorDescripcion: string | null;
  // La imagen real NO viaja en los listados (puede pesar ~2 MB c/u) — solo
  // este booleano. El archivo se pide aparte con
  // ApuntamientoHistoricoService.imagen(historicoId).
  TieneImagen: boolean;
  Usuario: string | null;
  FechaCambio: string;
  FechaActualizacionDeclarada: string | null;
}

// ==========================================================================
// AUDITORÍA DE USUARIOS Y ACCESOS. Ver
// backend/utils/usuariosAuditoria.js (tabla UsuariosHistorico) y
// backend/routes/auditoriaUsuarios.js (GET /api/auditoria-usuarios).
// ==========================================================================

export type AccionAuditoriaUsuario =
  | 'LOGIN_EXITOSO'
  | 'LOGIN_FALLIDO'
  | 'CAMBIO_PASSWORD'
  | 'EDICION_PERFIL'
  | 'CAMBIO_SESION'
  | 'CREACION'
  | 'EDICION'
  | 'ACTIVACION'
  | 'DESACTIVACION'
  | 'RECUPERACION_SOLICITADA'
  | 'RECUPERACION_ENVIO_FALLIDO'
  | 'RECUPERACION_VERIFICADA'
  | 'RECUPERACION_FALLIDA'
  | 'RECUPERACION_BLOQUEADA'
  | 'RECUPERACION_EXITOSA';

export interface EventoAuditoriaUsuario {
  Id: number;
  UsuarioId: number | null;
  UsernameIntentado: string | null;
  Accion: AccionAuditoriaUsuario;
  NombreCompletoAnterior: string | null;
  NombreCompletoNuevo: string | null;
  RolAnterior: string | null;
  RolNuevo: string | null;
  ModulosAnterior: string | null;
  ModulosNuevo: string | null;
  ActivoAnterior: boolean | null;
  ActivoNuevo: boolean | null;
  PasswordCambiada: boolean;
  RealizadoPorId: number | null;
  RealizadoPorUsername: string | null;
  IP: string | null;
  UserAgent: string | null;
  Detalle: string | null;
  FechaEvento: string;
  UsuarioNombreActual: string | null;
}

export interface UsuarioBasico {
  id: number;
  username: string;
  nombre_completo: string;
}

export interface InformeAuditoriaUsuarios {
  periodo: string;
  desde: string;
  hasta: string;
  eventos: EventoAuditoriaUsuario[];
  usuarios: UsuarioBasico[];
  limitado: boolean;
}

// ==========================================================================
// AUDITORÍA GENERAL DEL APLICATIVO. Ver backend/utils/auditoriaGeneral.js
// (tabla AuditoriaGeneral) y backend/routes/auditoriaGeneral.js (GET
// /api/auditoria-general). A diferencia de la Auditoría de Usuarios y
// Accesos (arriba), esto cubre CRUD y acciones operativas de CUALQUIER
// módulo: Certificados, Servidores, Servicios/ACE, Balanceador F5,
// Orquestador n8n, etc. — con los cambios de cada evento como un arreglo
// genérico [{campo, etiqueta, anterior, nuevo}] en vez de columnas fijas.
// ==========================================================================

export type ModuloAuditoriaGeneral =
  | 'CERTIFICADOS'
  | 'SERVIDORES'
  | 'APP_MOVIL'
  | 'SERVICIOS'
  | 'ORQUESTADOR_N8N'
  | 'REPOSITORIO'
  | 'BALANCEADOR_F5'
  | 'SWAGGER'
  | 'BIOMETRIA'
  | 'CATALOGO_DATOS'
  | 'MANUALES'
  | 'SOPORTE_N1'
  | 'INFORMES'
  | 'MONITOREO_TRANSACCIONAL'
  | 'INICIO';

export type AccionAuditoriaGeneral =
  | 'CREACION'
  | 'EDICION'
  | 'ELIMINACION'
  | 'ELIMINACION_LOGICA'
  | 'CONSULTA'
  | 'PRUEBA_CONEXION'
  | 'RESTAURACION'
  | 'ACCION_CONTENEDOR'
  | 'HABILITACION'
  | 'DESHABILITACION'
  | 'EJECUCION'
  | 'CONSUMO'
  | 'CONSUMO_BLOQUEADO'
  | 'CERTIFICADO_AGREGADO'
  | 'CERTIFICADO_ELIMINADO'
  | 'PETICION_GUARDADA'
  | 'PETICION_ACTUALIZADA'
  | 'PETICION_ELIMINADA';

export interface CambioAuditoriaGeneral {
  campo: string;
  etiqueta: string;
  anterior: any;
  nuevo: any;
}

export interface EventoAuditoriaGeneral {
  Id: number;
  Modulo: ModuloAuditoriaGeneral;
  Entidad: string;
  EntidadId: string | null;
  EntidadNombre: string | null;
  Accion: AccionAuditoriaGeneral;
  Detalle: string | null;
  cambios: CambioAuditoriaGeneral[];
  RealizadoPorId: number | null;
  RealizadoPorUsername: string | null;
  IP: string | null;
  UserAgent: string | null;
  FechaEvento: string;
}

export interface InformeAuditoriaGeneral {
  periodo: string;
  desde: string;
  hasta: string;
  eventos: EventoAuditoriaGeneral[];
  usuarios: string[];
  limitado: boolean;
}

// Payload de "Registrar cambio" (POST /api/apuntamientos/:id/cambios, Acción
// 2): documenta un ajuste/mantenimiento/mejora sobre un apuntamiento que ya
// existe — cambia Categoría/Servicio/Observaciones y queda en el histórico
// con evidencia (TRANDID, descripción del error, imagen). Distinto de
// Partial<Apuntamiento> porque además de renombrar "Error" (así lo espera el
// backend) NO incluye los campos estructurales de "Editar apuntamiento"
// (Aplicación, Servidor, Componente, SinApuntamiento) — esos van por
// ApuntamientoService.actualizar().
export interface RegistrarCambioApuntamientoPayload {
  Categoria: CategoriaApuntamiento;
  ServicioInventarioId: number;
  Observaciones?: string;
  TrandId?: string;
  Error?: string;
  // Data URI base64 (ej. "data:image/png;base64,..."), o undefined si no se
  // adjunta imagen. Validado también en el backend (~2 MB, PNG/JPG/GIF/WEBP).
  Imagen?: string;
  // Igual que en Apuntamiento: formato "YYYY-MM-DD HH:MM:SS"; si se omite,
  // el backend usa la fecha/hora actual del servidor.
  FechaActualizacion?: string;
}
// ==========================================
// Validación automática de apuntamientos contra los nodos
// ==========================================
export interface NodoValidacion {
  Id: number;
  Nombre: string;
  Host: string;
  PuertoSsh: number | null;
  UsuarioSsh: string | null;
  RutaArchivo: string;
  AplicacionId: number;
  AplicacionNombre?: string | null;
  Componente: string | null;
  PatronAce: string;
  PatronBus: string;
  Activo: boolean | number;
  CorregirAuto: boolean | number;
  UltimaValidacion: string | null;
  UltimoEstado: EstadoValidacion | null;
}

export type EstadoValidacion = 'OK' | 'DIFERENCIAS' | 'CORREGIDO' | 'CORREGIDO_PARCIAL' | 'ERROR';
export type TipoDiferenciaNodo = 'FALTANTE' | 'SOBRANTE' | 'SIN_SERVICIO' | 'SIN_CATEGORIA' | 'CORREGIDO';

export interface DetalleValidacionNodo {
  Tipo: TipoDiferenciaNodo;
  Clave: string | null;
  Codigo: string | null;
  Categoria: string | null;
  Url: string | null;
  ApuntamientoId?: number | null;
  ServicioInventarioId?: number | null;
  ServicioCodigo?: string | null;
  ServicioNombre?: string | null;
  Detalle: string | null;
}

export interface ApuntamientoDeNodo {
  Id: number;
  SinApuntamiento: boolean | number;
  Categoria: string | null;
  ServicioInventarioId: number | null;
  ServicioCodigo: string | null;
  ServicioNombre: string | null;
  Observaciones: string | null;
  FechaActualizacion: string | null;
}

export interface ApuntamientosDeNodoRespuesta {
  nodo: { Id: number; Nombre: string; AplicacionId: number; Componente: string | null };
  apuntamientos: ApuntamientoDeNodo[];
}

// Resultado de "Probar" / "Validar ahora" (el backend responde en minúsculas).
export interface ResultadoValidacionNodo {
  estado: EstadoValidacion;
  modo: 'SIMULACION' | 'APLICADO';
  origen: 'AUTO' | 'MANUAL';
  mensaje: string | null;
  totalConfig: number;
  totalBitacora: number;
  faltantes: number;
  sobrantes: number;
  sinServicio: number;
  corregidos: number;
  ignoradas: number;
  detalle: DetalleValidacionNodo[];
  validacionId?: number;
}

export interface ValidacionNodoResumen {
  Id: number;
  NodoId: number;
  NodoNombre: string;
  Origen: 'AUTO' | 'MANUAL';
  Modo: 'SIMULACION' | 'APLICADO';
  Estado: EstadoValidacion;
  TotalConfig: number;
  TotalBitacora: number;
  Faltantes: number;
  Sobrantes: number;
  SinServicio: number;
  Corregidos: number;
  Mensaje: string | null;
  Usuario: string | null;
  Fecha: string;
}

export interface ValidacionNodoDetalle extends ValidacionNodoResumen {
  detalle: DetalleValidacionNodo[];
}
