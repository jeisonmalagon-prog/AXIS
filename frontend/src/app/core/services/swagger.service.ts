import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// ==========================================================================
// Módulo SWAGGER: lector de Swagger/OpenAPI + consola de consumos
// ==========================================================================

export interface SwaggerEstado {
  tablasListas: boolean;
  mensaje: string | null;
}

export interface SwaggerOrigen {
  Id: number;
  Nombre: string;
  UrlSwagger: string;
  ValidarTls: boolean;
  Notas: string;
  CreadoPor: string | null;
  Consumos?: number;
  FechaActualizacion?: string;
  /** Es mío (yo lo registré). */
  Propio: boolean;
  /** No tiene dueño (registrado antes de que cada Swagger fuera privado): solo lo ve el ADMIN_POD. */
  SinDueno: boolean;
  /** Puedo modificarlo, darlo de baja, compartirlo y guardar consumos (dueño o ADMIN_POD). */
  PuedeGestionar: boolean;
  CompartidoTodos: boolean;
  /** Con cuántos usuarios concretos se compartió (solo lo ve quien lo gestiona). */
  CompartidoCon: number | null;
}

export interface SwaggerUsuarioLite {
  Id: number;
  Username: string | null;
  Nombre: string | null;
}

export interface SwaggerComparticion {
  compartidoTodos: boolean;
  usuarios: SwaggerUsuarioLite[];
  candidatos: SwaggerUsuarioLite[];
}

export interface SwaggerComparticionForm {
  compartidoTodos: boolean;
  usuarios: number[];
}

export interface SwaggerOrigenForm {
  Nombre: string;
  UrlSwagger: string;
  ValidarTls: boolean;
  Notas: string;
}

export interface SwaggerPruebaOrigen {
  ok: boolean;
  titulo?: string;
  version?: string;
  especificacion?: string;
  operaciones?: number;
  definiciones?: { indice: number; nombre: string; url: string }[];
  urlDocumento?: string;
  error?: string;
}

export interface SwaggerParametro {
  nombre: string;
  en: 'path' | 'query' | 'header';
  requerido: boolean;
  tipo: string;
  descripcion: string;
  enum: unknown[] | null;
  defecto: unknown;
  ejemplo: unknown;
  deprecado: boolean;
}

// Árbol de un esquema (vista "Modelo").
export interface SwaggerModelo {
  nombre?: string;
  requerido?: boolean;
  tipo: string | null;
  formato?: string;
  descripcion?: string;
  nullable?: boolean;
  soloLectura?: boolean;
  soloEscritura?: boolean;
  deprecado?: boolean;
  enum?: unknown[];
  defecto?: unknown;
  ejemplo?: unknown;
  restricciones?: Record<string, unknown>;
  ref?: string;
  circular?: boolean;
  truncado?: boolean;
  combinador?: 'oneOf' | 'anyOf';
  alternativas?: SwaggerModelo[];
  propiedades?: SwaggerModelo[];
  items?: SwaggerModelo;
  adicional?: SwaggerModelo;
}

export interface SwaggerCuerpo {
  requerido: boolean;
  descripcion: string;
  tipos: string[];
  ejemplos: Record<string, string>;
  esquemas: Record<string, string | null>;
  modelos?: Record<string, SwaggerModelo>;
}

export interface SwaggerRespuestaDoc {
  codigo: string;
  descripcion: string;
  tipos?: string[];
  ejemplos?: Record<string, string>;
  modelos?: Record<string, SwaggerModelo>;
  cabeceras?: { nombre: string; tipo: string; descripcion: string }[];
}

export interface SwaggerEsquemaSeguridad {
  nombre: string;
  tipo: string;
  detalle: string;
  descripcion: string;
  esquema?: string;
  en?: string;
  nombreParam?: string;
  formatoBearer?: string;
}

export interface SwaggerOperacion {
  id: string;
  metodo: string;
  ruta: string;
  resumen: string;
  descripcion: string;
  etiquetas: string[];
  deprecado: boolean;
  seguridad: boolean;
  seguridadEsquemas?: string[];
  operationId?: string;
  docExterna?: { url: string; descripcion: string } | null;
  parametros: SwaggerParametro[];
  cuerpo: SwaggerCuerpo | null;
  respuestas: SwaggerRespuestaDoc[];
}

export interface SwaggerDocumento {
  definiciones: { indice: number; nombre: string; url: string }[];
  definicion: number;
  urlDocumento: string;
  info: {
    titulo: string; version: string; descripcion: string; especificacion: string; terminos?: string;
    contacto?: { nombre: string; correo: string; url: string } | null;
    licencia?: { nombre: string; url: string } | null;
    docExterna?: { url: string; descripcion: string } | null;
  };
  servidores: string[];
  seguridad: SwaggerEsquemaSeguridad[];
  esquemas?: { nombre: string; modelo: SwaggerModelo; ejemplo: string }[];
  etiquetas: { nombre: string; cantidad: number; descripcion: string }[];
  operaciones: SwaggerOperacion[];
  totalOperaciones: number;
  truncado: boolean;
}

export interface FilaClaveValor {
  k: string;
  v: string;
  activo?: boolean;
}

export interface SwaggerPeticion {
  metodo: string;
  baseUrl: string;
  ruta: string;
  pathParams: Record<string, string>;
  query: FilaClaveValor[];
  headers: FilaClaveValor[];
  cuerpo: string;
  tipoContenido: string;
  consumoId?: number | null;
  timeoutMs?: number;
}

export interface SwaggerRespuesta {
  estado: number;
  estadoTexto: string;
  duracionMs: number;
  url: string;
  headers: Record<string, string>;
  tipoContenido: string;
  cuerpo: string | null;
  binario: boolean;
  bytes: number;
  truncado: boolean;
  historialId: number | null;
}

export interface SwaggerConsumo {
  Id: number;
  OrigenId: number;
  Nombre: string;
  Metodo: string;
  Ruta: string;
  BaseUrl: string;
  OperacionId: string;
  Grupo: string;
  Parametros: { path: Record<string, string>; query: FilaClaveValor[]; headers: FilaClaveValor[] };
  Cuerpo: string;
  TipoContenido: string;
  Notas: string;
  CreadoPor: string | null;
  FechaCreacion: string;
  FechaActualizacion: string;
  SecretosOmitidos?: boolean;
}

export interface SwaggerConsumoForm {
  Nombre: string;
  Metodo: string;
  Ruta: string;
  BaseUrl: string;
  OperacionId: string;
  Grupo: string;
  Parametros: { path: Record<string, string>; query: FilaClaveValor[]; headers: FilaClaveValor[] };
  Cuerpo: string;
  TipoContenido: string;
  Notas: string;
}

export interface SwaggerHistorialItem {
  Id: number;
  ConsumoId: number | null;
  Metodo: string;
  Url: string;
  Estado: number | null;
  EstadoTexto: string | null;
  DuracionMs: number | null;
  ResponseBytes: number | null;
  Error: string | null;
  Username: string | null;
  Fecha: string;
}

export interface SwaggerHistorialDetalle {
  Id: number;
  OrigenId: number;
  ConsumoId: number | null;
  Metodo: string;
  Url: string;
  RequestHeaders: Record<string, string>;
  RequestBody: string;
  Estado: number | null;
  EstadoTexto: string | null;
  DuracionMs: number | null;
  ResponseHeaders: Record<string, string>;
  ResponseBody: string;
  ResponseBytes: number | null;
  Truncado: boolean;
  Error: string | null;
  Username: string | null;
  Fecha: string;
}

@Injectable({ providedIn: 'root' })
export class SwaggerService {
  private base = `${environment.apiUrl}/swagger`;

  constructor(private http: HttpClient) {}

  estado(): Observable<SwaggerEstado> {
    return this.http.get<SwaggerEstado>(`${this.base}/estado`);
  }

  // ---- Orígenes ----
  /** `todos`: solo ADMIN_POD; incluye los orígenes privados de los demás. */
  origenes(todos = false): Observable<SwaggerOrigen[]> {
    let params = new HttpParams();
    if (todos) params = params.set('todos', '1');
    return this.http.get<SwaggerOrigen[]>(`${this.base}/origenes`, { params });
  }
  comparticion(id: number): Observable<SwaggerComparticion> {
    return this.http.get<SwaggerComparticion>(`${this.base}/origenes/${id}/comparticion`);
  }
  guardarComparticion(id: number, datos: SwaggerComparticionForm): Observable<SwaggerComparticion> {
    return this.http.put<SwaggerComparticion>(`${this.base}/origenes/${id}/comparticion`, datos);
  }
  probarOrigen(datos: Pick<SwaggerOrigenForm, 'UrlSwagger' | 'ValidarTls'>): Observable<SwaggerPruebaOrigen> {
    return this.http.post<SwaggerPruebaOrigen>(`${this.base}/origenes/probar`, datos);
  }
  crearOrigen(datos: SwaggerOrigenForm): Observable<SwaggerOrigen> {
    return this.http.post<SwaggerOrigen>(`${this.base}/origenes`, datos);
  }
  actualizarOrigen(id: number, datos: SwaggerOrigenForm): Observable<SwaggerOrigen> {
    return this.http.put<SwaggerOrigen>(`${this.base}/origenes/${id}`, datos);
  }
  eliminarOrigen(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/origenes/${id}`);
  }

  // ---- Documento ----
  documento(origenId: number, definicion = 0, refrescar = false): Observable<SwaggerDocumento> {
    let params = new HttpParams().set('def', String(definicion));
    if (refrescar) params = params.set('refrescar', '1');
    return this.http.get<SwaggerDocumento>(`${this.base}/origenes/${origenId}/spec`, { params });
  }

  // ---- Ejecución ----
  ejecutar(origenId: number, peticion: SwaggerPeticion): Observable<SwaggerRespuesta> {
    return this.http.post<SwaggerRespuesta>(`${this.base}/origenes/${origenId}/ejecutar`, peticion);
  }

  // ---- Consumos guardados ----
  consumos(origenId: number): Observable<SwaggerConsumo[]> {
    return this.http.get<SwaggerConsumo[]>(`${this.base}/origenes/${origenId}/consumos`);
  }
  guardarConsumo(origenId: number, datos: SwaggerConsumoForm): Observable<SwaggerConsumo> {
    return this.http.post<SwaggerConsumo>(`${this.base}/origenes/${origenId}/consumos`, datos);
  }
  actualizarConsumo(id: number, datos: SwaggerConsumoForm): Observable<SwaggerConsumo> {
    return this.http.put<SwaggerConsumo>(`${this.base}/consumos/${id}`, datos);
  }
  eliminarConsumo(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/consumos/${id}`);
  }

  // ---- Historial ----
  historial(origenId: number, todos = false): Observable<{ items: SwaggerHistorialItem[]; todos: boolean }> {
    let params = new HttpParams();
    if (todos) params = params.set('todos', '1');
    return this.http.get<{ items: SwaggerHistorialItem[]; todos: boolean }>(`${this.base}/origenes/${origenId}/historial`, { params });
  }
  historialDetalle(id: number): Observable<SwaggerHistorialDetalle> {
    return this.http.get<SwaggerHistorialDetalle>(`${this.base}/historial/${id}`);
  }
}
