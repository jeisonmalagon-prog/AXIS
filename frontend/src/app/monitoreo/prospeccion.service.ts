import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// ==========================================================================
// Soporte Nivel 1 > Monitorear prospección. Todo es de SOLO LECTURA sobre GestionCliente (esquema PD).
// La conexión (servidor, base, usuario y clave) la configura el ADMIN_POD desde la pantalla; la clave nunca vuelve al navegador.
// ==========================================================================

export type ValorCelda = string | number | boolean | null;
export type FilaDatos = Record<string, ValorCelda>;

export interface ColumnaBloque { clave: string; etiqueta: string; }

/** Resultado de una consulta del catálogo. Si falla o no aplica, `ok` es false y `error` explica por qué. */
export interface BloqueResultado {
  id: string;
  titulo?: string;
  ayuda: string | null;
  vista: 'tabla' | 'barras' | 'serie';
  clic: 'cargue' | null;
  columnaId: string | null;
  externa: boolean;
  vertical: boolean;
  ok: boolean;
  omitido?: boolean;
  error?: string;
  columnas: ColumnaBloque[];
  filas: FilaDatos[];
  ocultas?: string[];
  truncado?: boolean;
  ms?: number;
  /** SQL listo para pegar en SSMS (con los valores puestos). */
  sql: string | null;
}

export interface ConexionVista {
  configurada: boolean;
  origen: 'guardada' | 'env' | 'predefinida' | 'sesion' | 'pantalla' | 'ninguno';
  servidor: string | null;
  puerto: number;
  base: string;
  faltan: string[];
  guardadaEnApp: boolean;
  // Solo ADMIN_POD
  usuario?: string | null;
  tieneClave?: boolean;
  claveFin?: string | null;
  cifrado?: boolean;
  confiarCertificado?: boolean;
}

export interface EstadoProspeccion {
  rol: 'ADMIN_MIN' | 'CONSULTA' | null;
  esAdminPod: boolean;
  conexion: ConexionVista;
}

export interface FormConexion {
  servidor: string;
  puerto: number | null;
  base: string;
  usuario: string;
  clave: string;
  cifrado: boolean;
  confiarCertificado: boolean;
}

export interface ResultadoPrueba {
  ok: boolean;
  version: string | null;
  baseConectada: string | null;
  servidor: string | null;
  puerto: number | null;
  base: string | null;
  error: string | null;
}

interface Base {
  generadoEn: string;
  esquemaAviso?: string | null;
  esquemaDescubierto?: boolean;
  bloques: Record<string, BloqueResultado>;
}

export interface Hallazgo { nivel: 'alto' | 'medio' | 'info' | 'ok'; texto: string; }
export interface RespuestaResumen extends Base { dias: number; hallazgos: Hallazgo[]; }
export type RespuestaCargues = Base;
export interface RespuestaCargue extends Base { id: string; }
export interface EventoLinea { fecha: string; tipo: 'carga' | 'prospecto' | 'prospeccion' | 'listas' | 'proceso'; titulo: string; detalle: string | null; }
export interface RespuestaCliente extends Base { documento: string; trazaDias: number; lineaTiempo: EventoLinea[]; }
export interface OpcionCatalogo { Id: number; Nombre: string; }
export interface RespuestaProcesos extends Base { dias: number; catalogos: { estados: OpcionCatalogo[]; aliados: OpcionCatalogo[] }; }
export interface RespuestaPagares extends Base { dias: number; }
export interface RespuestaLogs extends Base { dias: number; tablas: string[]; tabla: string | null; }
export interface TablaEsquema { nombre: string; columnas: { nombre: string; tipo: string; largo: number | null }[]; }
export interface RespuestaEsquema { descubierto: boolean; aviso: string | null; tablas: TablaEsquema[]; generadoEn: string; }

@Injectable({ providedIn: 'root' })
export class ProspeccionService {
  private base = `${environment.apiUrl}/soporte-n1/prospeccion`;

  constructor(private http: HttpClient) {}

  private params(o: Record<string, string | number | null | undefined>): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') p = p.set(k, String(v));
    return p;
  }

  estado(): Observable<EstadoProspeccion> { return this.http.get<EstadoProspeccion>(this.base); }

  guardarConexion(f: FormConexion): Observable<ConexionVista> { return this.http.put<ConexionVista>(`${this.base}/conexion`, f); }
  quitarConexion(): Observable<ConexionVista> { return this.http.post<ConexionVista>(`${this.base}/conexion/quitar`, {}); }
  probarConexion(f: FormConexion | null): Observable<ResultadoPrueba> { return this.http.post<ResultadoPrueba>(`${this.base}/conexion/probar`, f || {}); }

  resumen(dias: number): Observable<RespuestaResumen> { return this.http.get<RespuestaResumen>(`${this.base}/resumen`, { params: this.params({ dias }) }); }
  cargues(top: number): Observable<RespuestaCargues> { return this.http.get<RespuestaCargues>(`${this.base}/cargues`, { params: this.params({ top }) }); }
  cargue(id: string | number): Observable<RespuestaCargue> { return this.http.get<RespuestaCargue>(`${this.base}/cargues/${encodeURIComponent(String(id))}`); }
  cliente(documento: string, trazaDias: number): Observable<RespuestaCliente> {
    return this.http.get<RespuestaCliente>(`${this.base}/cliente`, { params: this.params({ documento, trazaDias }) });
  }
  procesos(f: { dias: number; top: number; estado?: string | number | null; aliado?: string | number | null }): Observable<RespuestaProcesos> {
    return this.http.get<RespuestaProcesos>(`${this.base}/procesos`, { params: this.params(f) });
  }
  pagares(dias: number, top: number): Observable<RespuestaPagares> { return this.http.get<RespuestaPagares>(`${this.base}/pagares`, { params: this.params({ dias, top }) }); }
  logs(tabla: string | null, dias: number, top: number): Observable<RespuestaLogs> { return this.http.get<RespuestaLogs>(`${this.base}/logs`, { params: this.params({ tabla, dias, top }) }); }
  esquema(forzar = false): Observable<RespuestaEsquema> { return this.http.get<RespuestaEsquema>(`${this.base}/esquema`, { params: this.params({ forzar: forzar ? 1 : null }) }); }
}
