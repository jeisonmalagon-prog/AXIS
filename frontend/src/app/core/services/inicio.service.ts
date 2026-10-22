import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// ==========================================================================
// Pantalla principal (Inicio): widgets con métricas en vivo. El ADMIN_POD
// decide cuáles se muestran; cada usuario recibe solo los habilitados de los
// módulos que tiene.
// ==========================================================================

export type WidgetId =
  | 'portainer_flota' | 'portainer_problemas' | 'portainer_consumo' | 'portainer_tendencia'
  | 'f5_vivo' | 'f5_trafico' | 'f5_salud' | 'certificados' | 'pasos' | 'tareas' | 'inventario';

export interface WidgetInicio {
  id: WidgetId;
  titulo: string;
  descripcion: string;
  modulo: string | null;
  /** Columnas de una grilla de 6 (2 = tercio, 3 = mitad, 4 = dos tercios, 6 = completo). */
  ancho: number;
  intervaloSeg: number;
  /** El usuario puede filtrarlo y se recuerda su elección. */
  filtrable: boolean;
  /** El propio cuadro se actualiza (p. ej. el F5 en vivo cada 5 s). */
  propio: boolean;
}

export interface WidgetConfig {
  id: WidgetId;
  titulo: string;
  descripcion: string;
  modulo: string | null;
  grupo: string;
  habilitado: boolean;
  orden: number;
  ancho: number;
  intervaloSeg: number;
  soloAdmin: boolean;
}

export interface ConfigInicio {
  tabla: boolean;
  widgets: WidgetConfig[];
  anchos: number[];
  intervaloMin: number;
  intervaloMax: number;
}

export interface RespuestaWidget<T = unknown> {
  id: WidgetId;
  generadoEn: string;
  datos?: T;
  error?: string;
}

// ---- Opciones (filtros) que cada usuario elige por cuadro ----
export interface OpcionesPortainerFlota { entornos: number[]; soloAtencion: boolean; orden: 'atencion' | 'nombre' | 'memoria' | 'cpu'; }
export interface OpcionesPortainerProblemas { entornos: number[]; tipos: TipoProblema[]; }
export interface OpcionesPortainerConsumo { entornos: number[]; metrica: 'cpu' | 'mem'; cantidad: 6 | 10 | 20; }
export interface OpcionesPortainerTendencia { entornos: number[]; horas: 1 | 6 | 24 | 168; metrica: 'cpu' | 'mem'; agrupar: 'total' | 'servidor'; }
export interface OpcionesF5Trafico { dispositivos: string[]; horas: 1 | 3 | 6 | 24; }
export interface OpcionesF5Salud { dispositivos: string[]; soloProblemas: boolean; }
export type MetricaVivo = 'trafico' | 'entrada' | 'salida' | 'conexiones' | 'peticiones';
export interface OpcionesF5Vivo { dispositivo: string; vs: string[]; minutos: 5 | 10 | 15; metrica: MetricaVivo; }
// Unión «suave» de todas las opciones posibles (cada cuadro usa solo las suyas).
export interface OpcionesWidget {
  entornos?: number[];
  soloAtencion?: boolean;
  orden?: OpcionesPortainerFlota['orden'];
  tipos?: TipoProblema[];
  metrica?: 'cpu' | 'mem' | MetricaVivo;
  cantidad?: 6 | 10 | 20;
  horas?: 1 | 3 | 6 | 24 | 168;
  agrupar?: 'total' | 'servidor';
  dispositivos?: string[];
  soloProblemas?: boolean;
  dispositivo?: string;
  vs?: string[];
  minutos?: 5 | 10 | 15;
}

export interface PreferenciasInicio { tabla: boolean; preferencias: Partial<Record<WidgetId, OpcionesWidget>>; }

export type TipoProblema = 'detenido' | 'reiniciando' | 'insano';
export interface ItemCatalogo { id: number; nombre: string; estado: string; }

// ---- Formas de los datos de cada widget ----
export interface EntornoFlota {
  id: number; nombre: string; estado: string; ip: string | null; dockerVersion: string | null; error: string | null;
  cores: number | null; memTotalGb: number | null;
  total: number; corriendo: number; detenidos: number; reiniciando: number; insanos: number; medidos: number;
  cpuSumaPct: number | null; cpuHostPct: number | null; memUsadaGb: number | null; memHostPct: number | null;
  atencion: boolean; grave: boolean;
}
export interface DatosFlota {
  configurado: boolean;
  catalogo?: ItemCatalogo[];
  totales?: {
    entornos: number; arriba: number; caidos: number; contenedores: number; corriendo: number; detenidos: number; conProblemas: number;
    memUsadaGb: number | null; memTotalGb: number | null; memHostPct: number | null; conAtencion: number;
  };
  entornos?: EntornoFlota[];
  hayMas?: number;
}
export interface DatosProblemas {
  configurado: boolean;
  catalogo?: ItemCatalogo[];
  cuentas?: Record<TipoProblema, number>;
  total?: number;
  filas?: { entornoId: number; entorno: string; contenedor: string; imagen: string; tipo: TipoProblema; salud: string | null; estado: string; detalle: string }[];
  sinConexion?: { id: number; nombre: string; error: string }[];
}
export interface DatosConsumo {
  configurado: boolean;
  catalogo?: ItemCatalogo[];
  totalMedidos?: number;
  porCpu?: { entorno: string; nombre: string; imagen: string; cpu: number; memMb: number }[];
  porMem?: { entorno: string; nombre: string; imagen: string; cpu: number; memMb: number }[];
}
export interface DatosTendencia {
  configurado: boolean;
  catalogo?: ItemCatalogo[];
  horas?: number;
  agrupar?: 'total' | 'servidor';
  puntos?: { t: number; cpu: number; memGb: number; corriendo: number }[];
  series?: { id: number; nombre: string; puntos: { t: number; cpu: number; memGb: number }[] }[];
  hayMasServidores?: number;
}
export interface DatosF5Trafico {
  configurado: boolean;
  fuente?: string;
  horas?: number;
  catalogo?: { id: string; nombre: string }[];
  dispositivos?: string[];
  puntos?: { t: number; inBps: number; outBps: number; conn: number }[];
  ultimo?: { t: number; inBps: number; outBps: number; conn: number } | null;
  picos?: { inBps: number; outBps: number; conn: number } | null;
  topNodos?: { dispositivo: string; pool: string; miembro: string; bps: number; inBps: number; outBps: number; conn: number | null }[];
}
export interface VirtualSalud {
  dispositivo: string; nombre: string; destino: string | null; clase: 'disponible' | 'offline' | 'desconocido' | 'deshabilitado';
  estado: string; motivo: string | null; nodosArriba: number | null; nodosTotal: number | null; conexiones: number | null; problema: boolean;
}
export interface DatosF5Salud {
  configurado: boolean;
  catalogo?: { id: string; nombre: string }[];
  totales?: { disponibles: number; noDisponibles: number; deshabilitados: number; desconocidos: number; nodosArriba: number; nodosTotal: number };
  problemas?: number;
  virtuales?: VirtualSalud[];
  errores?: { dispositivo: string; error: string }[];
}
/** [t, entradaBps, salidaBps, conexiones, peticionesPorSeg, conexionesNuevasPorSeg] */
export type PuntoVivo = [number, number | null, number | null, number | null, number | null, number | null];
export interface VirtualVivo {
  fullPath: string; nombre: string; estado: string; motivo: string | null; habilitado: boolean;
  actual: { entradaBps: number | null; salidaBps: number | null; conexiones: number | null; conexionesNuevasPorSeg: number | null; peticionesPorSeg: number | null; conexionesMaximas: number | null };
  historia: PuntoVivo[];
}
export interface DatosF5Vivo {
  configurado: boolean;
  dispositivos?: { id: string; nombre: string }[];
  dispositivo?: string;
  dispositivoNombre?: string;
  muestreadoEn?: number;
  totalVirtuales?: number;
  automatico?: boolean;
  noEncontrados?: string[];
  seleccion?: VirtualVivo[];
}
export interface ItemVirtual { fullPath: string; nombre: string; estado: string; habilitado: boolean; }
export interface DatosCertificados {
  resumen: { vigentes: number; porVencer: number; vencidos: number };
  proximos: { aplicacion: string; servidor: string; nombreComun: string | null; fechaFin: string; dias: number; estado: string }[];
}
export interface DatosPasos {
  porEstado: Record<string, number>;
  proximos7Dias: number;
  proximos: { id: number; rfc: string | null; titulo: string; entorno: string | null; fecha: string }[];
}
export interface DatosTareas {
  porEstado: Record<string, number>;
  vencidas: number;
  proximas: { id: number; titulo: string; prioridad: string | null; estado: string; fechaLimite: string | null }[];
}
export interface DatosInventario {
  servidores: number | null;
  servidoresActivos: number | null;
  aplicaciones: number | null;
  certificados: number | null;
  porSo: { nombre: string; total: number }[];
}

@Injectable({ providedIn: 'root' })
export class InicioService {
  private url = `${environment.apiUrl}/inicio`;
  constructor(private http: HttpClient) {}

  widgets(): Observable<{ widgets: WidgetInicio[] }> {
    return this.http.get<{ widgets: WidgetInicio[] }>(`${this.url}/widgets`);
  }

  datos<T>(id: WidgetId, opciones?: OpcionesWidget | null): Observable<RespuestaWidget<T>> {
    const params = opciones && Object.keys(opciones).length ? { opciones: JSON.stringify(opciones) } : undefined;
    return this.http.get<RespuestaWidget<T>>(`${this.url}/datos/${id}`, params ? { params } : {});
  }

  preferencias(): Observable<PreferenciasInicio> {
    return this.http.get<PreferenciasInicio>(`${this.url}/preferencias`);
  }

  guardarPreferencia(id: WidgetId, opciones: OpcionesWidget): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.url}/preferencias/${id}`, { opciones });
  }

  borrarPreferencia(id: WidgetId): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.url}/preferencias/${id}`);
  }

  /** Virtual Servers de un F5 (para elegir cuáles ver en vivo). */
  f5Virtuales(dispositivo: string): Observable<{ dispositivo: string | null; virtuales: ItemVirtual[]; error?: string }> {
    return this.http.get<{ dispositivo: string | null; virtuales: ItemVirtual[]; error?: string }>(`${this.url}/f5/virtuales`, { params: { dispositivo } });
  }

  config(): Observable<ConfigInicio> {
    return this.http.get<ConfigInicio>(`${this.url}/config`);
  }

  guardarConfig(widgets: Pick<WidgetConfig, 'id' | 'habilitado' | 'orden' | 'ancho' | 'intervaloSeg' | 'soloAdmin'>[]): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.url}/config`, { widgets });
  }
}
