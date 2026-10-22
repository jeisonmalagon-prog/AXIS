import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CertificadoVigencia, ResumenDashboard } from '../models/models';

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private baseUrl = `${environment.apiUrl}/dashboard`;

  constructor(private http: HttpClient) {}

  resumen(): Observable<ResumenDashboard> {
    return this.http.get<ResumenDashboard>(`${this.baseUrl}/resumen`);
  }

  porVencer(dias = 30): Observable<CertificadoVigencia[]> {
    return this.http.get<CertificadoVigencia[]>(`${this.baseUrl}/por-vencer`, {
      params: { dias },
    });
  }
}
