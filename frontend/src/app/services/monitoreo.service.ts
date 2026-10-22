import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ServidorMonitoreado {
  id: number;
  hostname: string;
  ip_address: string;
  sistema_operativo: string;
  cpu?: number;
  memUsadaGb?: number;
  memTotalGb?: number;
  uptimeDias?: number;
  usuario?: string;
  subidaMbps?: string;
  bajadaMbps?: string;
  discos?: { [punto: string]: string };
  error?: string | null;
}

// ==========================================
// PORTAINER: vista directa de entornos + contenedores, sin depender del
// grupo de monitoreo por SSH (ver GET /monitoreo/portainer/entornos).
// ==========================================
export interface RecursosContenedorApi {
  cpuPorcentaje: string;
  memUso: string;
  memPorcentaje: string;
  redIO: string;
  discoIO: string;
  pids: number;
  // Versiones numéricas (sin formatear) de cpuPorcentaje/memUso, para poder
  // ordenar/sumar en el Análisis Estadístico sin tener que reparsear texto.
  cpuPorcentajeNum?: number;
  memUsoBytesNum?: number;
}

export interface ContenedorPortainer {
  id: string;
  nombre: string;
  imagen: string;
  estado: string; // running | exited | paused | restarting | dead...
  estadoTexto: string;
  puertos: string;
  recursos?: RecursosContenedorApi | null;
}

export interface EntornoPortainer {
  id: number;
  nombre: string;
  estadoConexion: 'up' | 'down';
  cpuCores: number | null;
  memoriaTotalGb: number | null;
  dockerVersion: string | null;
  contenedores: ContenedorPortainer[];
  resumenContenedores: { total: number; corriendo: number; detenidos: number };
  error: string | null;
  // Si el nombre de este entorno coincide con un servidor ya inventariado.
  servidorId: number | null;
  ipInventario: string | null;
}

export interface RespuestaEntornosPortainer {
  configurado: boolean;
  entornos: EntornoPortainer[];
  // Motivo por el que Portainer no respondió (URL/usuario/contraseña
  // incorrectos, TLS, red caída, etc.) — null cuando todo salió bien.
  error?: string | null;
}

// ==========================================
// DETALLE, LOGS Y ACCIONES SOBRE UN CONTENEDOR PUNTUAL
// ==========================================
export interface VolumenContenedorApi {
  origen: string;
  destino: string;
  modo: string;
  tipo: string;
}

export interface DetalleContenedor {
  id: string;
  nombre: string;
  imagen: string;
  comando: string;
  creadoEn: string | null;
  iniciadoEn: string | null;
  terminadoEn: string | null;
  politicaReinicio: string;
  reinicios: number | null;
  privilegiado: boolean;
  variablesEntorno: number;
  redes: string[];
  volumenes: VolumenContenedorApi[];
  etiquetas: { [clave: string]: string };
}

export type AccionContenedor = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove';

// ==========================================
// IMÁGENES, REDES Y VOLÚMENES (Fase 2 — mismas secciones que Portainer
// muestra bajo Images/Networks/Volumes de un environment).
// ==========================================
export interface ImagenPortainer {
  id: string;
  tags: string[];
  tamano: string;
  creadaEn: string | null;
  enUso: boolean;
}

export interface RedPortainer {
  id: string;
  nombre: string;
  driver: string;
  scope: string;
  interna: boolean;
  contenedoresConectados: number;
}

export interface VolumenPortainer {
  nombre: string;
  driver: string;
  puntoMontaje: string;
  creadoEn: string | null;
  enUso: boolean;
}

// ==========================================
// EVENTOS Y HOST (Fase 3)
// ==========================================
export interface EventoPortainer {
  id: string;
  tiempo: string | null;
  tipo: string;
  accion: string;
  recurso: string;
}

export interface HostInfoPortainer {
  nombreHost: string;
  sistemaOperativo: string;
  arquitectura: string;
  kernelVersion: string;
  versionDocker: string;
  cpus: number | null;
  memoriaTotalGb: number | null;
  driverAlmacenamiento: string;
  directorioRaizDocker: string;
  loggingDriver: string;
  cgroupDriver: string;
  contenedoresTotal: number | null;
  contenedoresCorriendo: number | null;
  contenedoresPausados: number | null;
  contenedoresDetenidos: number | null;
  imagenesTotal: number | null;
}

// ==========================================
// ANÁLISIS ESTADÍSTICO: agregados de TODO el parque de Portainer. El
// resumen de salud y el top de consumidores de CPU/memoria se calculan en
// el propio componente a partir de RespuestaEntornosPortainer (ya trae
// cpuPorcentajeNum/memUsoBytesNum por contenedor) — sólo imágenes/redes/
// volúmenes agregados y el histórico necesitan su propia llamada.
// ==========================================
export interface EstadisticasRecursosFlota {
  imagenesTotal: number;
  imagenesSinTag: number;
  imagenesEnUso: number;
  espacioImagenesTexto: string;
  redesTotal: number;
  redesSinUsar: number;
  volumenesTotal: number;
  volumenesSinUsar: number;
  entornosConsultados: number;
}

export interface PuntoHistoricoPortainer {
  fecha: string;
  contenedoresTotal: number;
  contenedoresCorriendo: number;
  contenedoresDetenidos: number;
  cpuPromedio: number;
  memUsadaGb: number;
}

@Injectable({ providedIn: 'root' })
export class MonitoreoService {
  private apiUrl = `${environment.apiUrl}/monitoreo`;

  constructor(private http: HttpClient) {}

  listarGrupo(): Observable<ServidorMonitoreado[]> {
    return this.http.get<ServidorMonitoreado[]>(`${this.apiUrl}/servidores`);
  }

  agregarAlGrupo(servidorId: number): Observable<any> {
    return this.http.post(`${this.apiUrl}/servidores`, { servidor_id: servidorId });
  }

  quitarDelGrupo(servidorId: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/servidores/${servidorId}`);
  }

  obtenerStats(): Observable<ServidorMonitoreado[]> {
    return this.http.get<ServidorMonitoreado[]>(`${this.apiUrl}/stats`);
  }

  listarEntornosPortainer(): Observable<RespuestaEntornosPortainer> {
    return this.http.get<RespuestaEntornosPortainer>(`${this.apiUrl}/portainer/entornos`);
  }

  obtenerDetalleContenedor(entornoId: number, contenedorId: string): Observable<DetalleContenedor> {
    return this.http.get<DetalleContenedor>(
      `${this.apiUrl}/portainer/entornos/${entornoId}/contenedores/${contenedorId}`
    );
  }

  obtenerLogsContenedor(entornoId: number, contenedorId: string, tail = 200): Observable<{ texto: string }> {
    return this.http.get<{ texto: string }>(
      `${this.apiUrl}/portainer/entornos/${entornoId}/contenedores/${contenedorId}/logs?tail=${tail}`
    );
  }

  ejecutarAccionContenedor(entornoId: number, contenedorId: string, accion: AccionContenedor): Observable<any> {
    return this.http.post(
      `${this.apiUrl}/portainer/entornos/${entornoId}/contenedores/${contenedorId}/accion`,
      { accion }
    );
  }

  // ==========================================
  // IMÁGENES, REDES Y VOLÚMENES
  // ==========================================
  listarImagenes(entornoId: number): Observable<ImagenPortainer[]> {
    return this.http.get<ImagenPortainer[]>(`${this.apiUrl}/portainer/entornos/${entornoId}/imagenes`);
  }

  eliminarImagen(entornoId: number, imagenId: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/portainer/entornos/${entornoId}/imagenes/${imagenId}`);
  }

  listarRedes(entornoId: number): Observable<RedPortainer[]> {
    return this.http.get<RedPortainer[]>(`${this.apiUrl}/portainer/entornos/${entornoId}/redes`);
  }

  eliminarRed(entornoId: number, redId: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/portainer/entornos/${entornoId}/redes/${redId}`);
  }

  listarVolumenes(entornoId: number): Observable<VolumenPortainer[]> {
    return this.http.get<VolumenPortainer[]>(`${this.apiUrl}/portainer/entornos/${entornoId}/volumenes`);
  }

  eliminarVolumen(entornoId: number, nombre: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/portainer/entornos/${entornoId}/volumenes/${encodeURIComponent(nombre)}`);
  }

  // ==========================================
  // EVENTOS Y HOST
  // ==========================================
  listarEventos(entornoId: number, minutos = 60): Observable<EventoPortainer[]> {
    return this.http.get<EventoPortainer[]>(`${this.apiUrl}/portainer/entornos/${entornoId}/eventos?minutos=${minutos}`);
  }

  obtenerInfoHost(entornoId: number): Observable<HostInfoPortainer> {
    return this.http.get<HostInfoPortainer>(`${this.apiUrl}/portainer/entornos/${entornoId}/host`);
  }

  // ==========================================
  // ANÁLISIS ESTADÍSTICO
  // ==========================================
  obtenerEstadisticasFlota(): Observable<EstadisticasRecursosFlota> {
    return this.http.get<EstadisticasRecursosFlota>(`${this.apiUrl}/portainer/estadisticas`);
  }

  obtenerHistorico(horas = 24): Observable<PuntoHistoricoPortainer[]> {
    return this.http.get<PuntoHistoricoPortainer[]>(`${this.apiUrl}/portainer/historico?horas=${horas}`);
  }
}