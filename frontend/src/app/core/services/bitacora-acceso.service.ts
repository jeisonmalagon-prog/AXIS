import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// Bitácora de Pasos a Producción: cada persona tiene la suya (pasos de aplicaciones y del BUS juntos).
// Se comparte completa o paso por paso (la otra persona acepta), se pide acceso a una persona o a un
// equipo, y ADMIN_POD crea los equipos. Un paso con varias personas es UN solo registro.

export type NivelPaso = 'PROPIETARIO' | 'EDICION' | 'LECTURA' | 'ADMIN' | null;
export type PermisoAcceso = 'LECTURA' | 'EDICION';
export type EstadoAcceso = 'PENDIENTE' | 'ACEPTADA' | 'RECHAZADA' | 'REVOCADA';
export type OrigenAcceso = 'SOLICITUD' | 'COMPARTIDA' | 'ADMIN';

export interface EstadoBitacora {
  /** false: faltan las tablas nuevas; la bitácora funciona como antes (todos ven todo). */
  disponible: boolean;
  mensaje: string | null;
  serviciosDisponible: boolean;
  esAdmin: boolean;
  yo: { id: number; nombre: string };
}

export interface PersonaBitacora {
  id: number;
  username: string;
  nombre_completo: string | null;
}

export interface PersonaVista {
  id: number;
  nombre: string;
  username: string;
  permiso: PermisoAcceso | null;
  porAdmin: boolean;
  total: number;
}

export interface EquipoVista {
  id: number;
  nombre: string;
  miembros: number;
  soyMiembro: boolean;
  total: number;
}

export interface VistasBitacora {
  yo: { id: number; nombre: string };
  esAdmin: boolean;
  mios: number;
  todo: number;
  compartidosConmigo: number;
  personas: PersonaVista[];
  equipos: EquipoVista[];
}

export interface MiembroEquipo {
  id: number;
  username: string;
  nombre: string;
}

export interface EquipoBitacora {
  id: number;
  nombre: string;
  descripcion: string | null;
  miembros: MiembroEquipo[];
  soyMiembro: boolean;
}

export interface AccesoBitacora {
  id: number;
  propietarioId: number;
  propietario: string;
  usuarioId: number;
  usuario: string;
  alcance: 'COMPLETA' | 'PASO';
  pasoId: number | null;
  paso: string | null;
  permiso: PermisoAcceso;
  estado: EstadoAcceso;
  origen: OrigenAcceso;
  fechaSolicitud: string;
  fechaRespuesta: string | null;
}

export interface AccesosBitacora {
  esAdmin: boolean;
  /** Me ofrecieron compartir conmigo: debo aceptar. */
  porAceptar: AccesoBitacora[];
  /** Piden ver lo mío: debo responder. */
  solicitudesPorResponder: AccesoBitacora[];
  /** Quién ve lo mío. */
  conAcceso: AccesoBitacora[];
  /** Lo que ofrecí y todavía no aceptaron. */
  enviadosPendientes: AccesoBitacora[];
  /** Lo de otras personas que puedo ver. */
  recibidos: AccesoBitacora[];
  /** Mis solicitudes pendientes o rechazadas. */
  misSolicitudes: AccesoBitacora[];
  /** Solo ADMIN_POD: todos los accesos vigentes y pendientes. */
  todos: AccesoBitacora[];
}

export interface AccesosPaso {
  puedeCompartir: boolean;
  participantes: { id: number; nombre: string }[];
  accesos: AccesoBitacora[];
}

export interface CuerpoCompartir {
  destinatarioIds?: number[];
  equipoId?: number | null;
  pasoId?: number | null;
  permiso: PermisoAcceso;
  /** Solo ADMIN_POD: dar acceso a la bitácora de otra persona. */
  propietarioId?: number | null;
}

export interface ResumenCompartir {
  creados: number;
  actualizados: number;
  aprobados: number;
  yaPendientes: number;
  omitidosPorParticipar: number;
  sinModulo: number;
}

export interface ResumenSolicitud {
  enviadas: number;
  yaTenias: number;
  yaPendientes: number;
  aceptadas: number;
  sinModulo: number;
}

/** Lo que la barra de vistas le pide al listado de pasos. */
export interface SeleccionBitacora {
  propietarios: string[]; // 'yo' o ids de personas
  equipos: number[];
  compartidos: boolean;
  todos: boolean;
}

@Injectable({ providedIn: 'root' })
export class BitacoraAccesoService {
  private base = `${environment.apiUrl}/pasos-produccion/bitacora`;

  constructor(private http: HttpClient) {}

  estado(): Observable<EstadoBitacora> {
    return this.http.get<EstadoBitacora>(`${this.base}/estado`);
  }

  vistas(): Observable<VistasBitacora> {
    return this.http.get<VistasBitacora>(`${this.base}/vistas`);
  }

  personas(incluirme = false): Observable<PersonaBitacora[]> {
    return this.http.get<PersonaBitacora[]>(`${this.base}/personas`, { params: incluirme ? { incluirme: '1' } : {} });
  }

  // ---- equipos ----
  equipos(): Observable<EquipoBitacora[]> {
    return this.http.get<EquipoBitacora[]>(`${this.base}/equipos`);
  }

  crearEquipo(d: { nombre: string; descripcion?: string | null; usuarioIds: number[] }): Observable<EquipoBitacora> {
    return this.http.post<EquipoBitacora>(`${this.base}/equipos`, d);
  }

  actualizarEquipo(id: number, d: { nombre: string; descripcion?: string | null; usuarioIds: number[] }): Observable<EquipoBitacora> {
    return this.http.put<EquipoBitacora>(`${this.base}/equipos/${id}`, d);
  }

  eliminarEquipo(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/equipos/${id}`);
  }

  // ---- accesos ----
  accesos(): Observable<AccesosBitacora> {
    return this.http.get<AccesosBitacora>(`${this.base}/accesos`);
  }

  accesosDePaso(pasoId: number): Observable<AccesosPaso> {
    return this.http.get<AccesosPaso>(`${this.base}/accesos/paso/${pasoId}`);
  }

  compartir(d: CuerpoCompartir): Observable<ResumenCompartir> {
    return this.http.post<ResumenCompartir>(`${this.base}/accesos/compartir`, d);
  }

  solicitar(d: { propietarioIds?: number[]; equipoId?: number | null }): Observable<ResumenSolicitud> {
    return this.http.post<ResumenSolicitud>(`${this.base}/accesos/solicitar`, d);
  }

  responder(id: number, aceptar: boolean, permiso?: PermisoAcceso): Observable<{ ok: boolean; estado: string; permiso: PermisoAcceso }> {
    return this.http.post<{ ok: boolean; estado: string; permiso: PermisoAcceso }>(`${this.base}/accesos/${id}/responder`, { aceptar, permiso });
  }

  cambiarPermiso(id: number, permiso: PermisoAcceso): Observable<{ id: number; permiso: PermisoAcceso }> {
    return this.http.put<{ id: number; permiso: PermisoAcceso }>(`${this.base}/accesos/${id}`, { permiso });
  }

  /** Une pasos duplicados (mismo RFC y ambiente) en uno solo: se conserva `conservarId` y los demás se absorben. */
  fusionar(conservarId: number, absorberIds: number[]): Observable<{ ok: boolean; conservarId: number; fusionados: number; unificados: number; movidos: number }> {
    return this.http.post<{ ok: boolean; conservarId: number; fusionados: number; unificados: number; movidos: number }>(`${this.base}/fusionar`, { conservarId, absorberIds });
  }

  quitar(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/accesos/${id}`);
  }
}
