import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApuntamientoHistorico } from '../models/models';

// Servicio separado de ApuntamientoService a propósito — mismo patrón que
// ya existe en este proyecto para Certificados (certificados.service.ts +
// historico.service.ts, cada uno contra su propio router en el backend).
@Injectable({ providedIn: 'root' })
export class ApuntamientoHistoricoService {
  private baseUrl = `${environment.apiUrl}/apuntamientos-historico`;

  constructor(private http: HttpClient) {}

  // Histórico completo (pantalla dedicada, para no recargar/saturar el
  // formulario de edición de la Bitácora con esto).
  listar(): Observable<ApuntamientoHistorico[]> {
    return this.http.get<ApuntamientoHistorico[]>(this.baseUrl);
  }

  // Histórico de un apuntamiento en particular (cuando se llega filtrando
  // desde la Bitácora de Apuntamientos).
  porApuntamiento(apuntamientoId: number): Observable<ApuntamientoHistorico[]> {
    return this.http.get<ApuntamientoHistorico[]>(`${this.baseUrl}/${apuntamientoId}`);
  }

  // Trae la imagen (data URI base64) de UNA fila de histórico en particular,
  // a pedido — a propósito no viaja en listar()/porApuntamiento() (ver nota
  // en ese endpoint del backend sobre por qué).
  imagen(historicoId: number): Observable<{ ImagenBase64: string }> {
    return this.http.get<{ ImagenBase64: string }>(`${this.baseUrl}/imagen/${historicoId}`);
  }
}
