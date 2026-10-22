import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CertificadoVigencia, ResumenDashboard } from '../models/models';

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private baseUrl = `${environment.apiUrl}/dashboard`;

  constructor(private http: HttpClient) {}

  // incluirSinUso = true cuenta también los certificados que solo están instalados en el
  // almacén de un servidor (sin uso detectado). Por defecto el backend los excluye.
  resumen(incluirSinUso = false): Observable<ResumenDashboard> {
    return this.http.get<ResumenDashboard>(`${this.baseUrl}/resumen`, {
      params: incluirSinUso ? { incluirSinUso: 1 } : {},
    });
  }

  porVencer(dias = 30, incluirSinUso = false): Observable<CertificadoVigencia[]> {
    return this.http.get<CertificadoVigencia[]>(`${this.baseUrl}/por-vencer`, {
      params: incluirSinUso ? { dias, incluirSinUso: 1 } : { dias },
    });
  }
}
