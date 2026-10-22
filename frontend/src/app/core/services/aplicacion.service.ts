import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Aplicacion } from '../models/models';

@Injectable({ providedIn: 'root' })
export class AplicacionService {
  private baseUrl = `${environment.apiUrl}/aplicaciones`;

  constructor(private http: HttpClient) {}

  listar(): Observable<Aplicacion[]> {
    return this.http.get<Aplicacion[]>(this.baseUrl);
  }

  obtener(id: number): Observable<Aplicacion> {
    return this.http.get<Aplicacion>(`${this.baseUrl}/${id}`);
  }

  crear(app: Partial<Aplicacion>): Observable<Aplicacion> {
    return this.http.post<Aplicacion>(this.baseUrl, app);
  }

  actualizar(id: number, app: Partial<Aplicacion>): Observable<Aplicacion> {
    return this.http.put<Aplicacion>(`${this.baseUrl}/${id}`, app);
  }

  eliminar(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }
}
