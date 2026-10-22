import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface EventoCalendario {
  id: string;
  titulo: string;
  descripcion: string | null;
  inicio: string;
  fin: string;
  todoElDia: boolean;
  ubicacion: string | null;
  enlaceGoogle: string | null;
  estado: string | null;
  // Ids de usuarios asignados a esta sesión -- se guarda en Google Calendar
  // como metadata privada (extendedProperties), no como invitados reales.
  // Solo aplica a eventos del calendario "AXIS" (origen === 'axis').
  asignados: number[];
  // 'axis': viene del calendario compartido donde se agenda desde la app
  // (editable). 'equipo': viene del calendario REAL de alguien en
  // CalendariosEquipo (común para todos). 'personal': calendario que ESTE
  // usuario agregó solo para sí. Ambos son siempre de solo lectura.
  origen: 'axis' | 'equipo' | 'personal';
  editable: boolean;
  // Solo presentes cuando origen === 'equipo' / 'personal'.
  calendarioEquipoId?: number;
  calendarioPersonalId?: number;
  etiquetaCalendario?: string;
}

export interface RespuestaEventosCalendario {
  eventos: EventoCalendario[];
  // Mensajes amigables de calendarios de CalendariosEquipo que no se
  // pudieron leer esta vez (ej. todavía no compartieron su calendario) --
  // no impiden ver el resto, solo se muestran como aviso.
  erroresCalendarios: string[];
}

// Un correo de Google Calendar que un ADMIN agregó para verse (de solo
// lectura) mezclado con el calendario "AXIS" en la misma grilla. Los nombres
// de campo van en PascalCase -- igual que como ya se maneja en Tareas/Pasos
// a Producción, para no traducir entre el nombre de columna de la BD y el
// del frontend.
export interface CalendarioEquipo {
  Id: number;
  Correo: string;
  Etiqueta: string;
}

// Calendario de Google que el propio usuario agregó (solo lo ve él).
export interface CalendarioPersonal {
  Id: number;
  Correo: string;
  Etiqueta: string;
}

// Todo lo que la pantalla necesita para los filtros de ESTE usuario. Las
// claves de "ocultos" son 'axis', 'c:<id>' (equipo), 'p:<id>' (personal) y
// 'u:<id>' (persona asignada).
export interface MisCalendarios {
  disponible: boolean;
  mensaje: string | null;
  equipo: CalendarioEquipo[];
  personales: CalendarioPersonal[];
  ocultos: string[];
}

@Injectable({ providedIn: 'root' })
export class CalendarioService {
  private baseUrl = `${environment.apiUrl}/calendario`;

  constructor(private http: HttpClient) {}

  obtenerEstado(): Observable<{ configurado: boolean }> {
    return this.http.get<{ configurado: boolean }>(`${this.baseUrl}/estado`);
  }

  listarEventos(desde?: string, hasta?: string): Observable<RespuestaEventosCalendario> {
    const params: Record<string, string> = {};
    if (desde) params['desde'] = desde;
    if (hasta) params['hasta'] = hasta;
    return this.http.get<RespuestaEventosCalendario>(`${this.baseUrl}/eventos`, { params });
  }

  crearEvento(datos: { titulo: string; descripcion?: string | null; inicio: string; fin: string; todoElDia?: boolean; asignados?: number[] }): Observable<EventoCalendario> {
    return this.http.post<EventoCalendario>(`${this.baseUrl}/eventos`, datos);
  }

  actualizarEvento(id: string, datos: Partial<{ titulo: string; descripcion: string | null; inicio: string; fin: string; todoElDia: boolean; asignados: number[] }>): Observable<EventoCalendario> {
    return this.http.put<EventoCalendario>(`${this.baseUrl}/eventos/${id}`, datos);
  }

  eliminarEvento(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/eventos/${id}`);
  }

  // ---------- Calendarios reales del equipo (lista administrable) ----------

  listarCalendariosEquipo(): Observable<CalendarioEquipo[]> {
    return this.http.get<CalendarioEquipo[]>(`${this.baseUrl}/calendarios-equipo`);
  }

  agregarCalendarioEquipo(datos: { correo: string; etiqueta: string }): Observable<CalendarioEquipo> {
    return this.http.post<CalendarioEquipo>(`${this.baseUrl}/calendarios-equipo`, datos);
  }

  eliminarCalendarioEquipo(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/calendarios-equipo/${id}`);
  }

  // ---------- Personalización por usuario ----------

  obtenerMisCalendarios(): Observable<MisCalendarios> {
    return this.http.get<MisCalendarios>(`${this.baseUrl}/mis-calendarios`);
  }

  agregarMiCalendario(datos: { correo: string; etiqueta: string }): Observable<CalendarioPersonal> {
    return this.http.post<CalendarioPersonal>(`${this.baseUrl}/mis-calendarios`, datos);
  }

  eliminarMiCalendario(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/mis-calendarios/${id}`);
  }

  guardarPreferencias(ocultos: string[]): Observable<{ ocultos: string[] }> {
    return this.http.put<{ ocultos: string[] }>(`${this.baseUrl}/preferencias`, { ocultos });
  }
}
