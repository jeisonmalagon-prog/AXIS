import { formatearDuracion } from './flujo-layout';

// ============================================================================
// Tipos y utilidades compartidas por las pestañas de análisis de App Móvil
// (carga de productos, operaciones, latencia, errores masivos, versiones).
// Reflejan EXACTAMENTE lo que devuelve backend/routes/appMovilAnalisis.js.
// ============================================================================

export { formatearDuracion };

export type PeriodoAnalisis = 'hoy' | 'ayer' | '3d' | '7d' | 'rango';

export const PERIODOS_ANALISIS: { valor: PeriodoAnalisis; etiqueta: string }[] = [
  { valor: 'hoy', etiqueta: 'Hoy' },
  { valor: 'ayer', etiqueta: 'Ayer' },
  { valor: '3d', etiqueta: '3 días' },
  { valor: '7d', etiqueta: '7 días' },
  { valor: 'rango', etiqueta: 'Rango' }
];

/** Parámetros de periodo que entiende el backend (mismo contrato que el recorrido del cliente). */
export function paramsPeriodo(periodo: PeriodoAnalisis, desde: string, hasta: string): Record<string, string> | string {
  if (periodo === 'hoy') return { dias: '1' };
  if (periodo === 'ayer') return { dias: '1', desfase: '1' };
  if (periodo === '3d') return { dias: '3' };
  if (periodo === '7d') return { dias: '7' };
  if (!desde || !hasta || desde > hasta) return 'Elige un rango de fechas válido (la fecha inicial no puede ser posterior a la final).';
  return { fechaInicio: desde, fechaFin: hasta };
}

export function hoyLocalYMD(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Copia texto al portapapeles (con alternativa para navegadores sin la API moderna). */
export async function copiarTexto(texto: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch { /* se intenta el método clásico */ }
  try {
    const area = document.createElement('textarea');
    area.value = texto;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function pct(v: number | null | undefined, decimales = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(decimales).replace('.', ',')}%`;
}

// ---------------------------------------------------------------- catálogo ACE
export interface CatalogoAce {
  encontrado: boolean;
  aproximado: boolean;
  codigo: string | null;
  servicio: string | null;
  operacion: string | null;
  codigoOperacion?: string | null;
  operacionBackend?: string | null;
  descripcion: string | null;
  version?: string | null;
  instancias?: number | null;
  compuestos?: number | null;
  atomicos?: number | null;
  sincrono?: boolean | null;
  asincrono?: boolean | null;
  pod?: string | null;
  veces?: number;
  errores?: number;
  maxEsperaMs?: number;
}

export interface CodigoTraducido {
  tipo: string;
  codigo: string;
  categoria: string;
  significado: string;
  fuente?: string;
}

export interface CodigosPaso {
  nivel: string;
  severidad: string | null;
  descripcionBanco: string | null;
  ace: CodigoTraducido | null;
  servidor: CodigoTraducido | null;
  http?: CodigoTraducido | null;
  negocio?: CodigoTraducido | null;
  [k: string]: unknown;
}

export interface FallaSoap {
  mensaje: string | null;
  actor: string | null;
  servicioActor: string | null;
  detalle: string | null;
  nodoIntegracion: string | null;
  segundosLimite: number | null;
  fase: 'dentro_flujo' | 'antes_flujo' | null;
  esTimeout: boolean;
}

export interface PasoAnalisis {
  tipo: string;
  titulo: string;
  nivel: string;
  texto: string;
  hora: string;
  esperaMs: number;
  lento: boolean;
  destino: string | null;
  codigoHttp?: number | string | null;
  transaccion: string | null;
  falla: FallaSoap | null;
  sinDatos?: boolean;
  manejado?: boolean;
  veces?: number;
  codigos: CodigosPaso[];
  catalogo: CatalogoAce | null;
}

// ----------------------------------------------------------- carga de productos
export type VeredictoComponente = 'OK' | 'OK_SIN_DATOS' | 'OK_LENTA' | 'ERROR' | 'AVISO' | 'SIN_CONFIRMAR' | 'NO_REGISTRADO';
export type VeredictoCarga = 'COMPLETA' | 'COMPLETA_LENTA' | 'PARCIAL' | 'FALLA' | 'SIN_CONFIRMAR';

export interface IntentoCarga {
  t: number;
  fin: number | null;
  inicio: string;
  finTexto: string | null;
  duracionMs: number | null;
  sinInicio: boolean;
  estado: string;
  resultado: string | null;
  lentitud: string | null;
  mensaje: string | null;
  pasoLento: string | null;
  nodo: number | null;
  version: string | null;
  equipo: string | null;
  pasos: PasoAnalisis[];
}

export interface ComponenteCarga {
  clave: string;
  metodo: string;
  nombre: string;
  que: string;
  requerido: boolean;
  intentos: IntentoCarga[];
  numIntentos: number;
  fallidos: number | null;
  exitosos: number;
  sinDetalle: number;
  veredicto: VeredictoComponente;
  veredictoTexto: string;
  inicio: string | null;
  fin: string | null;
  duracionMs: number | null;
  duracionMaxMs: number | null;
  duracionMinMs: number | null;
  solapados: boolean;
  ace: CatalogoAce[];
  [k: string]: unknown;
}

export interface EvidenciaCarga {
  texto: string;
  tipo: string;
  componente?: string;
}

export interface HipotesisCarga {
  texto: string;
  soporte: string[];
  confianza: 'alta' | 'media' | 'baja';
}

export interface CargaProductos {
  id: number;
  inicio: string;
  fin: string;
  duracionTotalMs: number | null;
  inicioParcial: boolean;
  tiempoProductosMs: number | null;
  alcance: string;
  alcanceTexto: string;
  disparo: string;
  disparoTexto: string;
  loginAnteriorMs: number | null;
  reintentoSesion: { hora: string; despuesMs: number } | null;
  veredicto: VeredictoCarga;
  productos: 'SI' | 'NO' | 'PARCIAL' | 'SIN_CONFIRMAR';
  veredictoTexto: string;
  componentes: ComponenteCarga[];
  evidencia: EvidenciaCarga[];
  hipotesis: HipotesisCarga[];
  resumenTexto: string;
}

export interface EventoSuelto {
  componente: string;
  clave: string;
  inicio: string;
  duracionMs: number | null;
  sinInicio: boolean;
  estado: string;
  mensaje: string | null;
  nodo: number | null;
  version: string | null;
  equipo: string | null;
}

export interface CargaResponse {
  documento: string;
  fechaInicio: string;
  fechaFin: string;
  relojBd: string;
  totalFilas: number;
  truncado: boolean;
  tablasFaltantes: string[];
  catalogoAce: { servicios: number; operaciones: number };
  resumen: {
    cargas: number;
    completas: number;
    completasLentas: number;
    parciales: number;
    conFallas: number;
    sinConfirmar: number;
    eventosSueltos: number;
    erroresSueltos: number;
    tiempoProductos: { n: number; medianaMs: number | null; p90Ms: number | null; maximoMs: number | null; minimoMs: number | null };
    productos: 'SIN_CARGAS' | 'HAY_FALLAS' | 'HAY_SIN_CONFIRMAR' | 'TODAS_OK';
  };
  umbrales: { lentaMs: number; muyLentaMs: number; huecoCargaMs: number; ventanaLoginMs: number };
  precision: string;
  cargas: CargaProductos[];
  cargasOmitidas: number;
  eventosSueltos: EventoSuelto[];
  desdeCache: boolean;
  generadoEn: string;
}

// ------------------------------------------------------------------ operaciones
export interface OperacionAnalisis {
  n: number;
  metodo: string;
  servicio: string;
  clase: string | null;
  funcionalidad: number | null;
  inicio: string;
  fin: string;
  t: number;
  duracionMs: number | null;
  sinInicio: boolean;
  estado: 'exito' | 'error' | 'advertencia' | 'sin_detalle';
  resultado: string | null;
  lentitud: 'lenta' | 'muy_lenta' | null;
  mensaje: string | null;
  pasoLento: string | null;
  ruta: string | null;
  filas: number;
  esLogout: boolean;
  nodo: number | null;
  version: string | null;
  equipo: string | null;
  repeticion: number | null;
  reintento: boolean;
  pasos: PasoAnalisis[];
}

export interface OperacionesResponse {
  documento: string;
  fechaInicio: string;
  fechaFin: string;
  totalFilas: number;
  truncado: boolean;
  tablasFaltantes: string[];
  desdeCache: boolean;
  resumen: { operaciones: number; exito: number; error: number; advertencia: number; sinDetalle: number; medibles: number; maxMs: number | null };
  metodos: string[];
  mostradas: number;
  omitidas: number;
  operaciones: OperacionAnalisis[];
  precision: string;
}

// ------------------------------------------------------- muestra global (latencia, errores)
export interface ResumenDuracion {
  n: number;
  minMs: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  promMs: number | null;
  confiable95: boolean;
}

export interface LatenciaServicio {
  metodo: string;
  servicio: string;
  llamadas: number;
  errores: number;
  sinMedir: number;
  tasaError: number;
  lentas: number;
  muyLentas: number;
  todas: ResumenDuracion;
  exitosas: ResumenDuracion;
  nodos: (ResumenDuracion & { nodo: number; errores: number })[];
}

export interface LatenciaAce extends ResumenDuracion {
  clave: string;
  codigo: string;
  servicio: string;
  operacion: string;
  descripcion: string | null;
  instancias: number | null;
  aproximado: boolean;
  llamadas: number;
  errores: number;
}

export interface MuestraInfo {
  clientes: number;
  operaciones: number;
  errores: number;
  desde: string | null;
  hasta: string | null;
}

export interface LecturaInfo {
  filasLeidas: number;
  topeFilas: number;
  truncada: boolean;
}

export interface BaseMuestra {
  modo: 'reciente' | 'historico';
  ventanaMin: number;
  fecha: string | null;
  hora: number | null;
  relojBd: string;
  lectura: LecturaInfo;
  muestra: MuestraInfo;
  desdeCache: boolean;
  generadoEn: string;
  precision: string;
}

export interface LatenciaResponse extends BaseMuestra {
  latencia: LatenciaServicio[];
  ace: LatenciaAce[];
  antiguedadMs: number;
}

export interface ConteoValor<T = string | number> { valor: T; n: number }

export interface CausaError {
  clave: string;
  tipo: string;
  categoria: string;
  titulo: string;
  codigo: string | null;
  servicioAce: { id: string; servicio: string; operacion: string } | null;
  catalogo: CatalogoAce | null;
  detalleBanco: string | null;
  falla: FallaSoap | null;
  significadoApp: string | null;
  codigos: CodigosPaso[] | null;
  errores: number;
  clientesAfectados: number;
  llamadasAfectadas: number;
  tasaError: number;
  masivo: boolean;
  primera: string;
  ultima: string;
  duracion: ResumenDuracion | null;
  metodos: ConteoValor<string>[];
  nodos: ConteoValor<number>[];
  versiones: ConteoValor<string>[];
  plataformas: ConteoValor<string>[];
  concentracionNodo: number | null;
  porMinuto: { minuto: string; n: number }[];
  muestras: { documento: string; hora: string; duracionMs: number | null; metodo: string; nodo: number | null; transaccion: string | null }[];
  clientes: string[];
}

export interface ErroresMasivosResponse extends BaseMuestra {
  umbrales: { minClientes: number; minErrores: number; minTasa: number; minLlamadas: number };
  masivas: number;
  causas: CausaError[];
}

export interface CodigoDiccionario extends CodigoTraducido { [k: string]: unknown }
export interface CodigoVisto extends CodigoTraducido {
  veces: number;
  descripciones: { texto: string; n: number }[];
}

export interface CodigosResponse {
  diccionario: CodigoDiccionario[];
  vistos: CodigoVisto[];
  muestra: MuestraInfo | null;
  aviso: string | null;
  nota: string;
}

export interface AlertaResumen {
  Id: number;
  Clave: string;
  Detectada: string;
  UltimaVista: string;
  Titulo: string;
  Tipo: string;
  Categoria: string | null;
  Errores: number;
  Clientes: number;
  TasaError: number | string;
  Servicio: string | null;
}

export interface AlertasResponse {
  disponible: boolean;
  mensaje?: string;
  alertas: AlertaResumen[];
}

export interface AlertaDetalleResponse {
  id: number;
  detectada: string;
  ultimaVista: string;
  titulo: string;
  detalle: CausaError | null;
}

// -------------------------------------------------------------- adopción de versiones
export interface VersionAdopcion {
  version: string;
  clientes: number;
  plataformas: { plataforma: string; clientes: number }[];
  porcentaje: number;
  esMasReciente: boolean;
}

export interface AdopcionResponse {
  fuente: 'tablas' | 'ventana';
  exacto: boolean;
  mensaje?: string | null;
  minutos?: number;
  dias?: number;
  desde?: string;
  totalClientes: number;
  versiones: VersionAdopcion[];
  masReciente: string | null;
  serie: { fecha: string; version: string; plataforma: string; clientes: number; logins: number }[];
  cobertura?: { dias: number; primero: string | null; ultimo: string | null; actualizado: string | null; diasPedidos: number };
  descripcion: string;
}

export interface ClienteVersion {
  documento: string;
  plataforma: string | null;
  primeraVez: string;
  ultimaVez: string;
}

export interface ClientesVersionResponse {
  version: string;
  plataforma: string | null;
  fuente: 'tablas' | 'ventana';
  total: number;
  pagina: number;
  tamano: number;
  clientes: ClienteVersion[];
}
