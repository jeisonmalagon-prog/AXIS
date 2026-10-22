import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  ApuntamientosDeNodoRespuesta,
  NodoValidacion,
  ResultadoValidacionNodo,
  ValidacionNodoDetalle,
  ValidacionNodoResumen,
} from '../models/models';

export interface ServidorNodo {
  Id: number;
  IP: string;
  Hostname: string;
  Ambiente: string | null;
  Apuntamientos: number;
  Componente: string | null;
}

export interface ArchivoCompartido {
  ruta: string;
  tamano: number;
}

export interface CarpetaCompartida {
  carpeta: string;
  archivos: ArchivoCompartido[];
  truncado: boolean;
}

@Injectable({ providedIn: 'root' })
export class ValidacionNodosService {
  private baseUrl = `${environment.apiUrl}/validacion-nodos`;

  constructor(private http: HttpClient) {}

  listarAplicaciones(): Observable<{ Id: number; Nombre: string }[]> {
    return this.http.get<{ Id: number; Nombre: string }[]>(`${this.baseUrl}/aplicaciones`);
  }

  // Servidores para el selector de nodo (primero los que ya tienen apuntamientos de la aplicación).
  listarServidoresDeAplicacion(aplicacionId: number): Observable<ServidorNodo[]> {
    return this.http.get<ServidorNodo[]>(`${this.baseUrl}/aplicaciones/${aplicacionId}/servidores`);
  }

  // Archivos de configuración de la carpeta compartida central.
  listarCarpetaCompartida(refrescar = false): Observable<CarpetaCompartida> {
    return this.http.get<CarpetaCompartida>(`${this.baseUrl}/carpeta-compartida${refrescar ? '?refrescar=1' : ''}`);
  }

  listarNodos(): Observable<NodoValidacion[]> {
    return this.http.get<NodoValidacion[]>(`${this.baseUrl}/nodos`);
  }

  crearNodo(nodo: Partial<NodoValidacion>): Observable<NodoValidacion> {
    return this.http.post<NodoValidacion>(`${this.baseUrl}/nodos`, nodo);
  }

  actualizarNodo(id: number, nodo: Partial<NodoValidacion>): Observable<NodoValidacion> {
    return this.http.put<NodoValidacion>(`${this.baseUrl}/nodos/${id}`, nodo);
  }

  eliminarNodo(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/nodos/${id}`);
  }

  // Apuntamientos que hoy tiene la bitácora para el nodo.
  listarApuntamientos(id: number): Observable<ApuntamientosDeNodoRespuesta> {
    return this.http.get<ApuntamientosDeNodoRespuesta>(`${this.baseUrl}/nodos/${id}/apuntamientos`);
  }

  // Lee el archivo del nodo y compara, sin escribir nada ni guardar la corrida.
  probar(id: number): Observable<ResultadoValidacionNodo> {
    return this.http.post<ResultadoValidacionNodo>(`${this.baseUrl}/nodos/${id}/probar`, {});
  }

  // Guarda la corrida; con aplicar=true agrega a la bitácora los faltantes.
  validar(id: number, aplicar: boolean): Observable<ResultadoValidacionNodo> {
    return this.http.post<ResultadoValidacionNodo>(`${this.baseUrl}/nodos/${id}/validar`, { aplicar });
  }

  // Misma corrida que hace el programador diario, sobre todos los nodos activos.
  ejecutarTodos(): Observable<{ ejecutados?: unknown[]; omitido?: string; error?: string }> {
    return this.http.post<{ ejecutados?: unknown[]; omitido?: string; error?: string }>(`${this.baseUrl}/ejecutar-todos`, {});
  }

  listarValidaciones(nodoId?: number): Observable<ValidacionNodoResumen[]> {
    const url = nodoId ? `${this.baseUrl}/validaciones?nodoId=${nodoId}` : `${this.baseUrl}/validaciones`;
    return this.http.get<ValidacionNodoResumen[]>(url);
  }

  obtenerValidacion(id: number): Observable<ValidacionNodoDetalle> {
    return this.http.get<ValidacionNodoDetalle>(`${this.baseUrl}/validaciones/${id}`);
  }
}
