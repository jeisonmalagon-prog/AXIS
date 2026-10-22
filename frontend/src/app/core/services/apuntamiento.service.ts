import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Apuntamiento, RegistrarCambioApuntamientoPayload } from '../models/models';

@Injectable({ providedIn: 'root' })
export class ApuntamientoService {
  private baseUrl = `${environment.apiUrl}/apuntamientos`;

  constructor(private http: HttpClient) {}

  listar(): Observable<Apuntamiento[]> {
    return this.http.get<Apuntamiento[]>(this.baseUrl);
  }

  // El histórico de cambios vive en ApuntamientoHistoricoService, contra su
  // propio endpoint /api/apuntamientos-historico (pantalla dedicada, para no
  // recargar este formulario con eso — ver ese servicio).

  crear(apuntamiento: Partial<Apuntamiento>): Observable<Apuntamiento> {
    return this.http.post<Apuntamiento>(this.baseUrl, apuntamiento);
  }

  // "Editar apuntamiento" (Acción 1, PUT /:id): corrige datos estructurales
  // — Aplicación, Servidor, Componente, "sin apuntamiento". NO toca
  // Categoría/Servicio/Observaciones/fecha, y NO queda en el histórico. Para
  // eso está registrarCambio() más abajo (Acción 2).
  actualizar(id: number, apuntamiento: Partial<Apuntamiento>): Observable<Apuntamiento> {
    return this.http.put<Apuntamiento>(`${this.baseUrl}/${id}`, apuntamiento);
  }

  // "Registrar cambio" (Acción 2, POST /:id/cambios): documenta un
  // ajuste/mantenimiento/mejora — cambia Categoría/Servicio/Observaciones
  // con evidencia (TRANDID, error, imagen) y SÍ queda en el histórico
  // (Accion = 'AJUSTE').
  registrarCambio(id: number, cambio: RegistrarCambioApuntamientoPayload): Observable<Apuntamiento> {
    return this.http.post<Apuntamiento>(`${this.baseUrl}/${id}/cambios`, cambio);
  }

  eliminar(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }
}
