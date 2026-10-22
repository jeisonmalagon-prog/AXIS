import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Certificado, CertificadoVigencia } from '../models/models';

// ---- Catálogo del asistente: servidor → componente → aplicaciones de negocio ----
export interface AppNegocioRef { id: number; nombre: string; }

export interface ComponenteCatalogo {
  id: number;
  rol: string;
  puerto: number | null;
  tipo: string | null;
  aplicaciones: AppNegocioRef[];
}

export interface ServidorCatalogo {
  id: number;
  hostname: string;
  ip: string;
  ambiente: string | null;
  componentes: ComponenteCatalogo[];
}

export interface CatalogoUbicaciones {
  servidores: ServidorCatalogo[];
  aplicaciones: AppNegocioRef[];
  tipos: string[];
}

export interface RegistrarComponenteBody {
  ServidorId: number;
  Rol?: string;
  Puerto?: number | null;
  Tipo?: string | null;
  AplicacionesIds?: number[];
  ComponenteId?: number;
}

@Injectable({ providedIn: 'root' })
export class CertificadoService {
  private baseUrl = `${environment.apiUrl}/certificados`;

  constructor(private http: HttpClient) {}

  // Lista con estado de vigencia (Vigente / Por vencer / Vencido) calculado en la vista SQL
  listar(): Observable<CertificadoVigencia[]> {
    return this.http.get<CertificadoVigencia[]>(this.baseUrl);
  }

  // Servidores con sus componentes y las aplicaciones de negocio de cada uno.
  catalogoUbicaciones(): Observable<CatalogoUbicaciones> {
    return this.http.get<CatalogoUbicaciones>(`${this.baseUrl}/catalogo/ubicaciones`);
  }

  // Registra (o reutiliza) un componente en un servidor; puede asociarle aplicaciones de negocio.
  registrarComponente(body: RegistrarComponenteBody): Observable<{ yaExistia: boolean; componente: ComponenteCatalogo }> {
    return this.http.post<{ yaExistia: boolean; componente: ComponenteCatalogo }>(`${this.baseUrl}/catalogo/componentes`, body);
  }

  obtener(id: number): Observable<Certificado> {
    return this.http.get<Certificado>(`${this.baseUrl}/${id}`);
  }

  crear(cert: Partial<Certificado>): Observable<Certificado> {
    return this.http.post<Certificado>(this.baseUrl, cert);
  }

  actualizar(id: number, cert: Partial<Certificado>): Observable<Certificado> {
    return this.http.put<Certificado>(`${this.baseUrl}/${id}`, cert);
  }

  eliminar(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }
}
