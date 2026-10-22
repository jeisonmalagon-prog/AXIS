import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// ==========================================================================
// Módulo MANUALES: libretas > secciones > páginas (estilo OneNote), con
// historial de versiones, búsqueda, importación de Word/PDF y exportación.
// ==========================================================================

export interface ManualSeccion { id: number; nombre: string; color: string | null; orden: number; totalPaginas: number; }
export type ManualNivel = 'PROPIETARIO' | 'EDICION' | 'LECTURA';
export interface ManualLibreta {
  id: number; nombre: string; descripcion: string | null; orden: number; secciones: ManualSeccion[];
  /** Usuario que creó la libreta (null = libreta anterior a la regla «cada manual es de su creador»). */
  propietario: string | null;
  /** Qué puedo hacer yo: PROPIETARIO (es mía), EDICION o LECTURA (me la compartieron y la acepté). */
  miNivel: ManualNivel;
  /** Personas con acceso aceptado y solicitudes de compartir sin responder (solo útil para el dueño). */
  compartidaCon: number;
  pendientes: number;
  /** Si me la compartieron: id de la compartición (sirve para dejar de usarla). */
  miComparticionId: number | null;
}

export type EstadoComparticion = 'PENDIENTE' | 'ACEPTADA' | 'RECHAZADA';
export interface ManualComparticion { id: number; usuario: string; nombre: string; permiso: 'LECTURA' | 'EDICION'; estado: EstadoComparticion; fechaSolicitud: string; fechaRespuesta: string | null; }
export interface ManualSolicitudPendiente { id: number; libreta: string; propietario: string; permiso: 'LECTURA' | 'EDICION'; fechaSolicitud: string; }

export interface ManualPaginaMeta {
  id: number;
  seccionId: number;
  titulo: string;
  tipo: 'RICO' | 'PDF';
  fechaOrigen: string | null;
  orden: number;
  version: number;
  creadoPor: string | null;
  fechaCreacion: string;
  actualizadoPor: string | null;
  fechaActualizacion: string;
  archivoNombre: string | null;
  archivoTamano: number | null;
}

export interface ManualPagina extends ManualPaginaMeta {
  html: string;
  libretaId: number;
  libretaNombre: string;
  seccionNombre: string;
  seccionColor: string | null;
  /** Mi nivel sobre el manual al que pertenece la página. */
  miNivel: ManualNivel;
}

export interface ManualGuardado { version: number; actualizadoPor: string; fechaActualizacion: string; }

export interface ManualConflicto { error: string; conflicto: true; version: number; actualizadoPor: string | null; fechaActualizacion: string | null; }

export interface ManualVersionMeta { id: number; titulo: string; guardadoPor: string | null; fecha: string; tamano: number; }
export interface ManualVersion { id: number; paginaId: number; titulo: string; html: string; guardadoPor: string | null; fecha: string; }

export interface ManualResultadoBusqueda {
  id: number;
  titulo: string;
  tipo: 'RICO' | 'PDF';
  seccionId: number;
  seccionNombre: string;
  seccionColor: string | null;
  libretaId: number;
  libretaNombre: string;
  fragmento: string;
  fechaActualizacion: string;
}

export type ManualModoDivision = 'auto' | 'titulo' | 'pagina' | 'una';

export interface ManualImportacionOpciones {
  modo?: ManualModoDivision;
  libretaId?: number | null;
  seccionId?: number | null;
  nombreLibreta?: string;
  nombreSeccion?: string;
}

export interface ManualImportacionResultado {
  libretaId: number;
  seccionId: number;
  primeraPaginaId: number;
  modo: string;
  paginas: number;
  avisos: string[];
}

@Injectable({ providedIn: 'root' })
export class ManualesService {
  private baseUrl = `${environment.apiUrl}/manuales`;

  constructor(private http: HttpClient) {}

  arbol(): Observable<ManualLibreta[]> {
    return this.http.get<ManualLibreta[]>(`${this.baseUrl}/arbol`);
  }

  paginasDeSeccion(seccionId: number): Observable<ManualPaginaMeta[]> {
    return this.http.get<ManualPaginaMeta[]>(`${this.baseUrl}/secciones/${seccionId}/paginas`);
  }

  pagina(id: number): Observable<ManualPagina> {
    return this.http.get<ManualPagina>(`${this.baseUrl}/paginas/${id}`);
  }

  buscar(q: string, libretaId?: number | null): Observable<ManualResultadoBusqueda[]> {
    let params = new HttpParams().set('q', q);
    if (libretaId) params = params.set('libretaId', libretaId);
    return this.http.get<ManualResultadoBusqueda[]>(`${this.baseUrl}/buscar`, { params });
  }

  // --- libretas / secciones ---
  crearLibreta(nombre: string, descripcion?: string): Observable<ManualLibreta> {
    return this.http.post<ManualLibreta>(`${this.baseUrl}/libretas`, { nombre, descripcion });
  }
  editarLibreta(id: number, nombre: string, descripcion?: string | null): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.baseUrl}/libretas/${id}`, { nombre, descripcion });
  }
  eliminarLibreta(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.baseUrl}/libretas/${id}`);
  }
  crearSeccion(libretaId: number, nombre: string, color?: string | null): Observable<ManualSeccion> {
    return this.http.post<ManualSeccion>(`${this.baseUrl}/libretas/${libretaId}/secciones`, { nombre, color });
  }
  editarSeccion(id: number, nombre: string, color?: string | null): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.baseUrl}/secciones/${id}`, { nombre, color });
  }
  eliminarSeccion(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.baseUrl}/secciones/${id}`);
  }
  ordenarPaginas(seccionId: number, ids: number[]): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.baseUrl}/secciones/${seccionId}/orden-paginas`, { ids });
  }

  // --- páginas ---
  crearPagina(seccionId: number, titulo: string, html = ''): Observable<{ id: number; seccionId: number; titulo: string; version: number }> {
    return this.http.post<{ id: number; seccionId: number; titulo: string; version: number }>(`${this.baseUrl}/secciones/${seccionId}/paginas`, { titulo, html });
  }
  guardarPagina(id: number, datos: { titulo: string; html?: string; version: number; forzar?: boolean }): Observable<ManualGuardado> {
    return this.http.put<ManualGuardado>(`${this.baseUrl}/paginas/${id}`, datos);
  }
  moverPagina(id: number, seccionId: number): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.baseUrl}/paginas/${id}/mover`, { seccionId });
  }
  eliminarPagina(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.baseUrl}/paginas/${id}`);
  }

  // --- versiones ---
  versiones(paginaId: number): Observable<ManualVersionMeta[]> {
    return this.http.get<ManualVersionMeta[]>(`${this.baseUrl}/paginas/${paginaId}/versiones`);
  }
  version(id: number): Observable<ManualVersion> {
    return this.http.get<ManualVersion>(`${this.baseUrl}/versiones/${id}`);
  }
  restaurar(paginaId: number, versionId: number): Observable<{ version: number }> {
    return this.http.post<{ version: number }>(`${this.baseUrl}/paginas/${paginaId}/restaurar`, { versionId });
  }

  // --- compartir (la otra persona debe aceptar) ---
  comparticiones(libretaId: number): Observable<ManualComparticion[]> {
    return this.http.get<ManualComparticion[]>(`${this.baseUrl}/libretas/${libretaId}/comparticiones`);
  }
  compartir(libretaId: number, destinatarioId: number, permiso: 'LECTURA' | 'EDICION'): Observable<{ id: number; estado: string; permiso: string }> {
    return this.http.post<{ id: number; estado: string; permiso: string }>(`${this.baseUrl}/libretas/${libretaId}/compartir`, { destinatarioId, permiso });
  }
  /** Personas activas con el módulo Manuales (las únicas a las que se puede compartir). */
  usuariosParaCompartir(): Observable<{ id: number; username: string; nombre_completo: string }[]> {
    return this.http.get<{ id: number; username: string; nombre_completo: string }[]>(`${this.baseUrl}/usuarios-compartir`);
  }
  solicitudesPendientes(): Observable<ManualSolicitudPendiente[]> {
    return this.http.get<ManualSolicitudPendiente[]>(`${this.baseUrl}/comparticiones/pendientes`);
  }
  responderSolicitud(id: number, aceptar: boolean): Observable<{ ok: boolean; estado: string; libretaId: number }> {
    return this.http.post<{ ok: boolean; estado: string; libretaId: number }>(`${this.baseUrl}/comparticiones/${id}/responder`, { aceptar });
  }
  quitarAcceso(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.baseUrl}/comparticiones/${id}`);
  }

  // --- archivos ---
  importar(archivo: File, opciones: ManualImportacionOpciones): Observable<ManualImportacionResultado> {
    let params = new HttpParams().set('modo', opciones.modo || 'auto');
    if (opciones.seccionId) params = params.set('seccionId', opciones.seccionId);
    else if (opciones.libretaId) params = params.set('libretaId', opciones.libretaId);
    if (opciones.nombreLibreta) params = params.set('nombreLibreta', opciones.nombreLibreta);
    if (opciones.nombreSeccion) params = params.set('nombreSeccion', opciones.nombreSeccion);
    const headers = new HttpHeaders({
      'Content-Type': 'application/octet-stream',
      'X-Nombre-Archivo': encodeURIComponent(archivo.name),
    });
    return this.http.post<ManualImportacionResultado>(`${this.baseUrl}/importar`, archivo, { params, headers });
  }
  archivoPdf(paginaId: number): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/paginas/${paginaId}/archivo`, { responseType: 'blob' });
  }
  exportarPaginaDocx(paginaId: number): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/paginas/${paginaId}/exportar/docx`, { responseType: 'blob' });
  }
  exportarSeccionDocx(seccionId: number): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/secciones/${seccionId}/exportar/docx`, { responseType: 'blob' });
  }
}
