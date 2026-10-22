import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// ==========================================================================
// Soporte Nivel 1 (sección propia del menú): reinicio de los monitores de pagos y naranja.
// Rol de administración: reinicia directo. Rol Consulta: pide un código (OTP) que llega
// a los aprobadores que configura el ADMIN_POD y con él completa el reinicio.
// ==========================================================================

export type AccionSoporte = 'monitor_pagos' | 'monitor_naranja';

export interface AccionEstado {
  clave: AccionSoporte;
  titulo: string;
  corto: string;
  descripcion: string;
  puerto: number;
  entorno: string;
  contenedor: string;
  encontrado: boolean;
  error: string | null;
  estado: string | null;
  estadoTexto: string | null;
  imagen: string | null;
  puertos: number[];
  enfriamientoSeg: number;
}

export interface DestinoAccion { entorno: string; contenedor: string; }

export interface ConfigSoporte {
  vigenciaMin: number;
  maxIntentos: number;
  aprobadoresTotal: number;
  smtpListo: boolean;
  dominios: string[];
  acciones: Record<AccionSoporte, DestinoAccion & { defecto: DestinoAccion }>;
  /** Solo ADMIN_POD: correos completos. */
  aprobadores?: string[];
  /** Solo ADMIN_POD: cuenta SMTP con la que se envía (la de Configuración → Correo saliente). */
  correo?: { configurado: boolean; host: string; port: number; usuario: string; remitente: string };
  /** Resto de usuarios: correos enmascarados. */
  aprobadoresEnmascarados?: string[];
}

export interface EventoSoporte { fecha: string; accion: string; entidad: string | null; detalle: string | null; usuario: string | null; }

export interface PantallaSoporte {
  rol: 'ADMIN_MIN' | 'CONSULTA' | null;
  requiereOtp: boolean;
  esAdminPod: boolean;
  acciones: AccionEstado[];
  config: ConfigSoporte;
  actividad: EventoSoporte[];
}

export interface FormConfigSoporte {
  aprobadores: string;
  vigenciaMin: number | null;
  acciones: Record<AccionSoporte, DestinoAccion>;
}

export interface SolicitudOtp {
  solicitudId: string;
  expiraEn: string;
  vigenciaMin: number;
  reenvioSeg: number;
  enviadoA: string[];
  aprobadores: number;
  maxIntentos: number;
}

export interface ResultadoReinicio {
  ok: boolean;
  via: 'directo' | 'otp';
  titulo: string;
  entorno: string;
  contenedor: string;
  estado: string | null;
  estadoTexto: string | null;
  arriba: boolean;
  duracionMs: number;
}

@Injectable({ providedIn: 'root' })
export class SoporteN1Service {
  private base = `${environment.apiUrl}/soporte-n1`;

  constructor(private http: HttpClient) {}

  pantalla(): Observable<PantallaSoporte> {
    return this.http.get<PantallaSoporte>(this.base);
  }

  guardarConfig(form: FormConfigSoporte): Observable<ConfigSoporte> {
    return this.http.put<ConfigSoporte>(`${this.base}/config`, form);
  }

  probarCorreo(): Observable<{ ok: boolean; mensaje: string }> {
    return this.http.post<{ ok: boolean; mensaje: string }>(`${this.base}/config/probar-correo`, {});
  }

  solicitarOtp(accion: AccionSoporte): Observable<SolicitudOtp> {
    return this.http.post<SolicitudOtp>(`${this.base}/${accion}/solicitar-otp`, {});
  }

  reiniciar(accion: AccionSoporte, solicitudId?: string, codigo?: string): Observable<ResultadoReinicio> {
    return this.http.post<ResultadoReinicio>(`${this.base}/${accion}/reiniciar`, solicitudId ? { solicitudId, codigo } : {});
  }
}
