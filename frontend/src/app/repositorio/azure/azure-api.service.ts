import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { RepositorioContextService } from '../repositorio-context.service';

// Cliente HTTP de las consultas de Azure DevOps (solo lectura) del backend.
// Agrega solo el repositorio seleccionado en el encabezado del módulo.
@Injectable({ providedIn: 'root' })
export class AzureApiService {
  private readonly base = `${environment.apiUrl}/azure-repo`;

  constructor(private http: HttpClient, private ctx: RepositorioContextService) {}

  get<T = any>(ruta: string, params: Record<string, string | number | boolean | null | undefined> = {}, conRepo = true): Observable<T> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    }
    if (conRepo && this.ctx.repositorioActual && !p.has('repo')) p = p.set('repo', this.ctx.repositorioActual);
    return this.http.get<T>(`${this.base}${ruta}`, { params: p });
  }

  // Vacía la caché corta del backend (60 s) para forzar datos recién leídos de Azure.
  refrescar(): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/refrescar`, {});
  }
}
