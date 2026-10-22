import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// Certificados que usan los contenedores (vía Portainer) y su conciliación con el inventario.
// Ver backend/utils/certContenedores.js y backend/routes/certificadosContenedores.js.

export type EstadoConciliacion = 'conciliado' | 'fechas_distintas' | 'difiere' | 'ubicacion_nueva' | 'no_inventariado';
export type VigenciaCert = 'vigente' | 'por_vencer' | 'vencido';
export type AccionConciliacion = 'crear' | 'actualizar' | 'agregar_ubicacion' | null;

export interface EntornoPortainer { id: number; nombre: string; conexion: 'up' | 'down'; }
export interface EntornosRespuesta { configurado: boolean; entornos: EntornoPortainer[]; error?: string; }

export interface ProgresoEscaneo {
  fase: string;
  entornosTotal: number;
  entornosHechos: number;
  contenedoresTotal: number;
  contenedoresHechos: number;
}

export interface OpcionesEscaneoPublicas {
  profundo: boolean;
  incluirDetenidos: boolean;
  sondeoTls: boolean;
  archivos: boolean;
  rutasExtra: string[];
  clavesExtra: number;
  entornoIds: number[];
}

export interface EstadoEscaneo {
  configurado?: boolean;
  estado: 'nunca' | 'corriendo' | 'terminado' | 'cancelado' | 'error';
  id?: string;
  inicio?: string;
  fin?: string | null;
  opciones?: OpcionesEscaneoPublicas;
  progreso: ProgresoEscaneo | null;
  error?: string | null;
  yaEnCurso?: boolean;
}

export interface OpcionesEscaneo {
  profundo: boolean;
  incluirDetenidos: boolean;
  sondeoTls: boolean;
  archivos: boolean;
  rutas: string;
  claves: string;
  entornoIds: number[];
}

export interface EvidenciaCert {
  origen: 'puerto' | 'archivo';
  contenedor: string;
  contenedorId: string;
  imagen: string;
  stack: string | null;
  puerto: number | null;
  ruta: string | null;
  formato: string | null;
  tieneLlave: boolean;
  autoridad: boolean;
  /** De dónde salió la contraseña que abrió el PFX (nunca la contraseña). */
  claveOrigen: string | null;
  /** Qué parte de la configuración del contenedor (docker run) nombra este archivo. */
  config: string | null;
}

export interface InfoCertificado {
  nombreComun: string | null;
  emisor: string | null;
  emisorCompleto: string | null;
  sujeto: string | null;
  serie: string;
  thumbprint: string;
  sha256: string;
  desde: string;
  hasta: string;
  san: string[];
  algoritmo: string | null;
  esCA: boolean;
  esAutoridad: boolean;
  autofirmado: boolean;
}

export interface FilaInventarioCoincidente {
  id: number;
  servidorId: number | null;
  hostname: string | null;
  componente: string | null;
  nombreComun: string | null;
  emisor: string | null;
  serie: string;
  thumbprint: string;
  puerto: number | null;
  desde: string | null;
  hasta: string | null;
  responsable: string | null;
}

export interface HallazgoCert {
  id: string;
  estado: EstadoConciliacion;
  accion: AccionConciliacion;
  vigencia: VigenciaCert;
  dias: number;
  servidor: { id: number | null; hostname: string | null; entornoId: number; entornoNombre: string; ip: string | null };
  servidorInventariado: boolean;
  certificado: InfoCertificado;
  evidencias: EvidenciaCert[];
  puertos: number[];
  contenedores: string[];
  componenteSugerido: string | null;
  puertoSugerido: number | null;
  observacionesSugeridas: string;
  inventario: FilaInventarioCoincidente | null;
  diferencias: string[];
}

export interface SinEvidencia extends FilaInventarioCoincidente {
  contenedor: string;
  vigencia: VigenciaCert | null;
  dias: number | null;
}

export interface NoLegible {
  entornoId: number;
  entornoNombre: string;
  servidorId: number | null;
  hostname: string | null;
  contenedor: string;
  contenedorId: string;
  imagen: string;
  ruta: string;
  formato: string;
  motivo: string;
}

export interface EntornoEscaneado {
  id: number;
  nombre: string;
  ip: string | null;
  hostname: string | null;
  servidorId: number | null;
  ok: boolean;
  error: string | null;
  contenedores: number;
  escaneados: number;
  archivosLeidos: number;
  rutasConsultadas: number;
  rutasTruncadas: number;
  clavesProbadas: number;
  puertosSondeados: number;
  puertosConTls: number;
  jarsLeidos?: number;
  avisos: string[];
}

export interface ResumenConciliacion {
  certificados: number;
  autoridades: number;
  conciliado: number;
  fechas_distintas: number;
  difiere: number;
  ubicacion_nueva: number;
  no_inventariado: number;
  sinEvidencia: number;
  noLegibles: number;
  vencidos: number;
  porVencer: number;
  vigentes: number;
  cfgContenedores: number;
  cfgConReferencias: number;
  cfgSinArchivo: number;
  cfgProtegidos: number;
  cfgTlsSinCertificado: number;
}

export type EstadoReferencia = 'leido' | 'protegido' | 'sin_certificado' | 'no_existe' | 'no_encontrado' | 'no_leido';

export interface ReferenciaConfig {
  ruta: string;
  original: string;
  tipo: 'archivo' | 'carpeta' | 'classpath';
  origen: string;
  estado: EstadoReferencia;
  detalle: string;
}

/** Lo que el «docker run» de un contenedor dice sobre sus certificados, contrastado con lo que se pudo leer. */
export interface ConfiguracionContenedor {
  entornoId: number;
  entornoNombre: string;
  servidorId: number | null;
  hostname: string | null;
  ip: string | null;
  contenedor: string;
  contenedorId: string;
  imagen: string;
  estado: string;
  stack: string | null;
  workdir: string;
  usaTls: boolean;
  /** «docker run» equivalente, con los secretos enmascarados. */
  comando: string;
  referencias: ReferenciaConfig[];
  claves: { origen: string; abrio: boolean }[];
  montajes: { origen: string; destino: string; tipo: string }[];
  archivos: number;
  certificados: number;
  jars: number;
  jarsOmitidos: number;
  lecturaParcial: boolean;
  rutasConsultadas: string[];
}

export interface ResultadoConciliacion {
  disponible: boolean;
  escaneo?: {
    id: string;
    inicio: string;
    fin: string;
    estadoFinal: string;
    opciones: OpcionesEscaneoPublicas;
    entornos: EntornoEscaneado[];
  };
  resumen?: ResumenConciliacion;
  hallazgos?: HallazgoCert[];
  sinEvidencia?: SinEvidencia[];
  noLegibles?: NoLegible[];
  configuraciones?: ConfiguracionContenedor[];
}

@Injectable({ providedIn: 'root' })
export class CertificadoContenedoresService {
  private baseUrl = `${environment.apiUrl}/certificados-contenedores`;

  constructor(private http: HttpClient) {}

  entornos(): Observable<EntornosRespuesta> {
    return this.http.get<EntornosRespuesta>(`${this.baseUrl}/entornos`);
  }

  estado(): Observable<EstadoEscaneo> {
    return this.http.get<EstadoEscaneo>(`${this.baseUrl}/estado`);
  }

  escanear(opciones: OpcionesEscaneo): Observable<EstadoEscaneo> {
    return this.http.post<EstadoEscaneo>(`${this.baseUrl}/escanear`, opciones);
  }

  cancelar(): Observable<EstadoEscaneo> {
    return this.http.post<EstadoEscaneo>(`${this.baseUrl}/cancelar`, {});
  }

  resultado(): Observable<ResultadoConciliacion> {
    return this.http.get<ResultadoConciliacion>(`${this.baseUrl}/resultado`);
  }
}
