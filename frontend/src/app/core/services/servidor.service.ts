import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Servidor } from '../models/models';

@Injectable({ providedIn: 'root' })
export class ServidorService {
  private baseUrl = `${environment.apiUrl}/servidores`;

  constructor(private http: HttpClient) {}

  listar(): Observable<Servidor[]> {
    return this.http.get<Servidor[]>(this.baseUrl);
  }

  obtener(id: number): Observable<Servidor> {
    return this.http.get<Servidor>(`${this.baseUrl}/${id}`);
  }

  crear(servidor: Partial<Servidor>): Observable<Servidor> {
    return this.http.post<Servidor>(this.baseUrl, servidor);
  }

  actualizar(id: number, servidor: Partial<Servidor>): Observable<Servidor> {
    return this.http.put<Servidor>(`${this.baseUrl}/${id}`, servidor);
  }

  eliminar(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }
}
