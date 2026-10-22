import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface TareaAsignado {
  id: number;
  nombreCompleto: string;
}

// Resultado de agendar la tarea en el calendario de Google (solo viene al crear/editar).
export interface TareaCalendario {
  estado: 'creado' | 'actualizado' | 'eliminado' | 'sin_evento' | 'omitido' | 'error';
  error?: string;
}

export interface Tarea {
  Id: number;
  Titulo: string;
  Descripcion: string | null;
  Estado: 'PENDIENTE' | 'EN_PROGRESO' | 'COMPLETADA' | 'CANCELADA';
  Prioridad: 'BAJA' | 'MEDIA' | 'ALTA';
  FechaLimite: string | null;
  // Hora de inicio y de entrega ("HH:MM") con la que se agenda en el calendario.
  HoraInicio: string | null;
  HoraFin: string | null;
  // Solo en la respuesta de crear/actualizar.
  calendario?: TareaCalendario;
  CreadoPorId: number;
  CreadoPorNombre: string;
  FechaCreacion: string;
  FechaCompletada: string | null;
  FechaActualizacion: string;
  asignados: TareaAsignado[];
}

export interface TareaAvance {
  Id: number;
  Comentario: string;
  FechaRegistro: string;
  UsuarioId: number;
  UsuarioNombre: string;
}

export interface TareaDetalle extends Tarea {
  avances: TareaAvance[];
}

export interface TareaChecklistItem {
  Id: number;
  Descripcion: string;
  Completado: boolean;
  Orden: number;
  CompletadoPorId: number | null;
  CompletadoPorNombre: string | null;
  FechaCompletado: string | null;
  FechaCreacion: string;
}

@Injectable({ providedIn: 'root' })
export class TareaService {
  private baseUrl = `${environment.apiUrl}/tareas`;

  constructor(private http: HttpClient) {}

  listar(filtros: { vista?: 'creadas' | 'asignadas'; estado?: string } = {}): Observable<Tarea[]> {
    const params: Record<string, string> = {};
    if (filtros.vista) params['vista'] = filtros.vista;
    if (filtros.estado) params['estado'] = filtros.estado;
    return this.http.get<Tarea[]>(this.baseUrl, { params });
  }

  obtener(id: number): Observable<TareaDetalle> {
    return this.http.get<TareaDetalle>(`${this.baseUrl}/${id}`);
  }

  crear(datos: { titulo: string; descripcion?: string | null; prioridad?: string; fechaLimite?: string | null; horaInicio?: string | null; horaFin?: string | null; asignados?: number[] }): Observable<Tarea> {
    return this.http.post<Tarea>(this.baseUrl, datos);
  }

  actualizar(id: number, datos: Partial<{ titulo: string; descripcion: string | null; prioridad: string; fechaLimite: string | null; horaInicio: string | null; horaFin: string | null; estado: string; asignados: number[] }>): Observable<Tarea> {
    return this.http.put<Tarea>(`${this.baseUrl}/${id}`, datos);
  }

  agregarAvance(id: number, comentario: string): Observable<TareaAvance[]> {
    return this.http.post<TareaAvance[]>(`${this.baseUrl}/${id}/avances`, { comentario });
  }

  eliminar(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }

  // ---------- Checklist de subtareas ----------

  listarChecklist(tareaId: number): Observable<TareaChecklistItem[]> {
    return this.http.get<TareaChecklistItem[]>(`${this.baseUrl}/${tareaId}/checklist`);
  }

  agregarChecklistItem(tareaId: number, descripcion: string): Observable<TareaChecklistItem> {
    return this.http.post<TareaChecklistItem>(`${this.baseUrl}/${tareaId}/checklist`, { descripcion });
  }

  actualizarChecklistItem(tareaId: number, itemId: number, datos: Partial<{ descripcion: string; completado: boolean }>): Observable<TareaChecklistItem> {
    return this.http.put<TareaChecklistItem>(`${this.baseUrl}/${tareaId}/checklist/${itemId}`, datos);
  }

  eliminarChecklistItem(tareaId: number, itemId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${tareaId}/checklist/${itemId}`);
  }
}
