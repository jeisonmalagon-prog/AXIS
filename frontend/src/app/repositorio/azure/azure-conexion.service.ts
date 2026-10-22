import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface DetalleArea { area: string; nombre: string; permiso: string; ok: boolean; codigo: string | null; }
export interface ResultadoPrueba {
  areas: Record<string, boolean>;
  detalle: DetalleArea[];
  ok: number;
  total: number;
  sinRed?: boolean;
  probadoEn: string;
}
export interface TokenAzure {
  id: number;
  nombre: string;
  ultimos4: string;
  activo: boolean;
  orden: number;
  legible: boolean;
  probadoEn: string | null;
  resultado: ResultadoPrueba | null;
  creadoEn: string | null;
  actualizadoEn: string | null;
}
export interface AjustesAzure { org: string; project: string; repo: string; branch: string; }
export interface ConexionAzure {
  tabla: boolean;
  cifradoListo: boolean;
  tokens: TokenAzure[];
  tokenEnv: { presente: boolean; ultimos4: string; enUso: boolean };
  ajustes: AjustesAzure;
  porDefecto: AjustesAzure;
  vigente: AjustesAzure;
  prueba?: ResultadoPrueba | null;
  idNuevo?: number;
  idProbado?: number | null;
}

// Administración de la conexión con Azure DevOps (solo ADMIN_POD). El valor de un token
// solo viaja del navegador al servidor al guardarlo; nunca vuelve (solo los últimos 4 caracteres).
@Injectable({ providedIn: 'root' })
export class AzureConexionService {
  private readonly base = `${environment.apiUrl}/azure-repo/conexion`;
  constructor(private http: HttpClient) {}

  obtener(): Observable<ConexionAzure> { return this.http.get<ConexionAzure>(this.base); }
  guardarAjustes(a: AjustesAzure): Observable<ConexionAzure> { return this.http.put<ConexionAzure>(`${this.base}/ajustes`, a); }
  agregar(nombre: string, token: string): Observable<ConexionAzure> { return this.http.post<ConexionAzure>(`${this.base}/tokens`, { nombre, token }); }
  actualizar(id: number, cambios: { nombre?: string; activo?: boolean; token?: string }): Observable<ConexionAzure> {
    return this.http.put<ConexionAzure>(`${this.base}/tokens/${id}`, cambios);
  }
  eliminar(id: number): Observable<ConexionAzure> { return this.http.delete<ConexionAzure>(`${this.base}/tokens/${id}`); }
  ordenar(ids: number[]): Observable<ConexionAzure> { return this.http.post<ConexionAzure>(`${this.base}/tokens/orden`, { ids }); }
  probar(id: number | 'env'): Observable<ConexionAzure & { prueba: ResultadoPrueba }> {
    return this.http.post<ConexionAzure & { prueba: ResultadoPrueba }>(`${this.base}/tokens/${id}/probar`, {});
  }
}
