import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { InformeAuditoriaGeneral, InformeAuditoriaUsuarios } from '../models/models';

@Injectable({ providedIn: 'root' })
export class AuditoriaService {
  private apiUrlUsuarios = `${environment.apiUrl}/auditoria-usuarios`;
  private apiUrlGeneral = `${environment.apiUrl}/auditoria-general`;

  constructor(private http: HttpClient) {}

  obtenerAuditoria(params: {
    periodo?: string;
    desde?: string;
    hasta?: string;
    usuarioId?: number | null;
    accion?: string | null;
  }): Observable<InformeAuditoriaUsuarios> {
    let query = '';
    const partes: string[] = [];
    if (params.periodo) partes.push(`periodo=${encodeURIComponent(params.periodo)}`);
    if (params.desde) partes.push(`desde=${encodeURIComponent(params.desde)}`);
    if (params.hasta) partes.push(`hasta=${encodeURIComponent(params.hasta)}`);
    if (params.usuarioId) partes.push(`usuarioId=${encodeURIComponent(params.usuarioId)}`);
    if (params.accion) partes.push(`accion=${encodeURIComponent(params.accion)}`);
    if (partes.length) query = `?${partes.join('&')}`;

    return this.http.get<InformeAuditoriaUsuarios>(`${this.apiUrlUsuarios}${query}`);
  }

  // Auditoría GENERAL (CRUD y operaciones de cualquier módulo, ver
  // backend/routes/auditoriaGeneral.js) — mismo patrón periodo/rango que
  // obtenerAuditoria(), más el filtro por módulo y por username realizador
  // (aquí no hay un "usuarioId" numérico como en Usuarios: RealizadoPorUsername
  // es texto libre, tomado del JWT en cada evento).
  obtenerAuditoriaGeneral(params: {
    periodo?: string;
    desde?: string;
    hasta?: string;
    modulo?: string | null;
    accion?: string | null;
    usuario?: string | null;
    /** 'consulta' = solo lo hecho con rol Consulta (auditado con más detalle). */
    rol?: string | null;
  }): Observable<InformeAuditoriaGeneral> {
    let query = '';
    const partes: string[] = [];
    if (params.periodo) partes.push(`periodo=${encodeURIComponent(params.periodo)}`);
    if (params.desde) partes.push(`desde=${encodeURIComponent(params.desde)}`);
    if (params.hasta) partes.push(`hasta=${encodeURIComponent(params.hasta)}`);
    if (params.modulo) partes.push(`modulo=${encodeURIComponent(params.modulo)}`);
    if (params.accion) partes.push(`accion=${encodeURIComponent(params.accion)}`);
    if (params.usuario) partes.push(`usuario=${encodeURIComponent(params.usuario)}`);
    if (params.rol) partes.push(`rol=${encodeURIComponent(params.rol)}`);
    if (partes.length) query = `?${partes.join('&')}`;

    return this.http.get<InformeAuditoriaGeneral>(`${this.apiUrlGeneral}${query}`);
  }
}
