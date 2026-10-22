import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { HistoricoCertificado } from '../models/models';

@Injectable({ providedIn: 'root' })
export class HistoricoService {
  private baseUrl = `${environment.apiUrl}/historico`;

  constructor(private http: HttpClient) {}

  listar(): Observable<HistoricoCertificado[]> {
    return this.http.get<HistoricoCertificado[]>(this.baseUrl);
  }

  porCertificado(certificadoId: number): Observable<HistoricoCertificado[]> {
    return this.http.get<HistoricoCertificado[]>(`${this.baseUrl}/${certificadoId}`);
  }
}
