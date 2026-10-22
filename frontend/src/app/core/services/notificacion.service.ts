import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export type SeveridadNotificacion = 'INFO' | 'AVISO' | 'ALERTA';
export type AccionNotificacion = 'PENDIENTE' | 'ACEPTADA' | 'RECHAZADA' | 'REVOCADA' | null;

export interface Notificacion {
  id: number;
  tipo: string;
  severidad: SeveridadNotificacion;
  titulo: string;
  mensaje: string | null;
  enlace: string | null;
  referencia: number | null;
  /** Solo las solicitudes que piden respuesta (compartir un manual): PENDIENTE hasta que se acepta o rechaza. */
  accion: AccionNotificacion;
  leida: boolean;
  fecha: string;
}

export interface BandejaNotificaciones {
  disponible: boolean;
  mensaje?: string;
  items: Notificacion[];
  noLeidas: number;
}

export interface ContadorNotificaciones { disponible: boolean; noLeidas: number; pendientesDeRespuesta?: number; }

// Bandeja de notificaciones de la persona (vencimiento de tareas, pasos a producción,
// solicitudes para compartir manuales…). Cada quien ve solo las suyas.
@Injectable({ providedIn: 'root' })
export class NotificacionService {
  private baseUrl = `${environment.apiUrl}/notificaciones`;

  constructor(private http: HttpClient) {}

  contador(): Observable<ContadorNotificaciones> {
    return this.http.get<ContadorNotificaciones>(`${this.baseUrl}/contador`);
  }

  listar(opciones: { soloNoLeidas?: boolean; limite?: number; actualizar?: boolean } = {}): Observable<BandejaNotificaciones> {
    const q: string[] = [];
    if (opciones.soloNoLeidas) q.push('soloNoLeidas=1');
    if (opciones.limite) q.push(`limite=${opciones.limite}`);
    if (opciones.actualizar) q.push('actualizar=1');
    return this.http.get<BandejaNotificaciones>(`${this.baseUrl}${q.length ? '?' + q.join('&') : ''}`);
  }

  leer(id: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.baseUrl}/${id}/leer`, {});
  }

  leerTodas(): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.baseUrl}/leer-todas`, {});
  }

  descartar(id: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.baseUrl}/${id}/descartar`, {});
  }
}
