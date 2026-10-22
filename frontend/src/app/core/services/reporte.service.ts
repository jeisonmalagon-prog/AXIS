import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { InformeCertificados, InformeServidores, InformeApuntamientos, InformeAplicaciones, InformeF5, InformeGeneral, SeccionInformeGeneral } from '../models/models';

// Periodos predefinidos que entiende el backend (ver calcularRangoPeriodo en
// backend/routes/reportes.js). 'rango' no es un valor que se mande al
// backend: significa "el usuario eligió fechas manuales", así que en ese
// caso se mandan desde/hasta explícitos en vez de periodo.
export type PeriodoInforme = 'dia' | 'semana' | 'mes' | 'rango';

export interface ParametrosInforme {
  periodo?: Exclude<PeriodoInforme, 'rango'>;
  desde?: string; // YYYY-MM-DD
  hasta?: string; // YYYY-MM-DD
}

@Injectable({ providedIn: 'root' })
export class ReporteService {
  private baseUrl = `${environment.apiUrl}/reportes`;

  constructor(private http: HttpClient) {}

  private armarParams(parametros: ParametrosInforme): Record<string, string> {
    const params: Record<string, string> = {};
    if (parametros.desde && parametros.hasta) {
      params['desde'] = parametros.desde;
      params['hasta'] = parametros.hasta;
    } else if (parametros.periodo) {
      params['periodo'] = parametros.periodo;
    }
    return params;
  }

  // Datos del informe para pantalla (KPIs + tablas).
  obtenerInformeCertificados(parametros: ParametrosInforme): Observable<InformeCertificados> {
    return this.http.get<InformeCertificados>(`${this.baseUrl}/certificados`, {
      params: this.armarParams(parametros),
    });
  }

  // El PDF se pide como blob (no JSON) para poder generar un enlace de
  // descarga en el navegador sin depender de que el backend mande el
  // archivo por otra vía (correo, disco, etc.).
  descargarPdfCertificados(parametros: ParametrosInforme): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/certificados/pdf`, {
      params: this.armarParams(parametros),
      responseType: 'blob',
    });
  }

  // ---------- Servidores / Monitoreo (Fase 2) ----------

  obtenerInformeServidores(parametros: ParametrosInforme): Observable<InformeServidores> {
    return this.http.get<InformeServidores>(`${this.baseUrl}/servidores`, {
      params: this.armarParams(parametros),
    });
  }

  descargarPdfServidores(parametros: ParametrosInforme): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/servidores/pdf`, {
      params: this.armarParams(parametros),
      responseType: 'blob',
    });
  }

  // ---------- Bitácora de Apuntamientos (Fase 2) ----------

  obtenerInformeApuntamientos(parametros: ParametrosInforme): Observable<InformeApuntamientos> {
    return this.http.get<InformeApuntamientos>(`${this.baseUrl}/apuntamientos`, {
      params: this.armarParams(parametros),
    });
  }

  descargarPdfApuntamientos(parametros: ParametrosInforme): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/apuntamientos/pdf`, {
      params: this.armarParams(parametros),
      responseType: 'blob',
    });
  }

  // ---------- Aplicaciones e Inventario de Sub-aplicativos (Fase 2) ----------

  obtenerInformeAplicaciones(parametros: ParametrosInforme): Observable<InformeAplicaciones> {
    return this.http.get<InformeAplicaciones>(`${this.baseUrl}/aplicaciones`, {
      params: this.armarParams(parametros),
    });
  }

  descargarPdfAplicaciones(parametros: ParametrosInforme): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/aplicaciones/pdf`, {
      params: this.armarParams(parametros),
      responseType: 'blob',
    });
  }

  // ---------- Balanceador F5 (Fase 2) ----------

  obtenerInformeF5(parametros: ParametrosInforme): Observable<InformeF5> {
    return this.http.get<InformeF5>(`${this.baseUrl}/f5`, {
      params: this.armarParams(parametros),
    });
  }

  descargarPdfF5(parametros: ParametrosInforme): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/f5/pdf`, {
      params: this.armarParams(parametros),
      responseType: 'blob',
    });
  }

  // ---------- Informe General del Aplicativo ----------
  // Combina, en un solo informe, las secciones (módulos) que el usuario
  // elija — ver backend/utils/informeGeneral.js.

  // Catálogo de secciones disponibles PARA ESTE USUARIO (ya filtrado por sus
  // módulos habilitados), para armar los checkboxes de la pantalla.
  obtenerSeccionesGeneral(): Observable<{ secciones: SeccionInformeGeneral[] }> {
    return this.http.get<{ secciones: SeccionInformeGeneral[] }>(`${this.baseUrl}/general/secciones`);
  }

  private armarParamsGeneral(parametros: ParametrosInforme, secciones: string[]): Record<string, string> {
    return { ...this.armarParams(parametros), secciones: secciones.join(',') };
  }

  obtenerInformeGeneral(parametros: ParametrosInforme, secciones: string[]): Observable<InformeGeneral> {
    return this.http.get<InformeGeneral>(`${this.baseUrl}/general`, {
      params: this.armarParamsGeneral(parametros, secciones),
    });
  }

  descargarPdfGeneral(parametros: ParametrosInforme, secciones: string[]): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/general/pdf`, {
      params: this.armarParamsGeneral(parametros, secciones),
      responseType: 'blob',
    });
  }
}
