import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AceServicio, AceOperacion } from '../models/models';

@Injectable({ providedIn: 'root' })
export class AceCatalogoService {
  private baseUrl = `${environment.apiUrl}/ace-catalogo`;

  constructor(private http: HttpClient) {}

  listar(): Observable<AceServicio[]> {
    return this.http.get<AceServicio[]>(this.baseUrl);
  }

  // --- Servicios ---
  crearServicio(servicio: Partial<AceServicio>): Observable<AceServicio> {
    return this.http.post<AceServicio>(`${this.baseUrl}/servicios`, servicio);
  }

  actualizarServicio(id: number, servicio: Partial<AceServicio>): Observable<AceServicio> {
    return this.http.put<AceServicio>(`${this.baseUrl}/servicios/${id}`, servicio);
  }

  eliminarServicio(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/servicios/${id}`);
  }

  // --- Operaciones ---
  crearOperacion(operacion: Partial<AceOperacion>): Observable<AceOperacion> {
    return this.http.post<AceOperacion>(`${this.baseUrl}/operaciones`, operacion);
  }

  actualizarOperacion(id: number, operacion: Partial<AceOperacion>): Observable<AceOperacion> {
    return this.http.put<AceOperacion>(`${this.baseUrl}/operaciones/${id}`, operacion);
  }

  eliminarOperacion(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/operaciones/${id}`);
  }
}
