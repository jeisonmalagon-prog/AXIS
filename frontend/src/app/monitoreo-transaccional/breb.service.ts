import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { BloqueResultado, Hallazgo } from '../monitoreo/prospeccion.service';

// ==========================================================================
// Monitoreo transaccional > BREB. TODO es de SOLO LECTURA:
//  · SQL Server de BreB (trx.Redeban, llaves, QR, parámetros) y los logs de MariaDB (LogBre_B.Log);
//  · «consultar llave» y «resolver llave» del servicio de BreB (solo esas dos operaciones).
// Las conexiones las configura el ADMIN_POD; las claves nunca vuelven al navegador y los datos personales llegan enmascarados.
// ==========================================================================

export type { BloqueResultado, Hallazgo };
export type Destino = 'sql' | 'log' | 'api';

export interface ConexionBd {
  configurada: boolean;
  origen: string;
  servidor: string | null;
  puerto: number;
  base: string;
  faltan: string[];
  guardadaEnApp: boolean;
  etiqueta: string;
  bancoPropio?: string;
  // Solo ADMIN_POD
  usuario?: string | null;
  tieneClave?: boolean;
  claveFin?: string | null;
  cifrado?: boolean;
  confiarCertificado?: boolean;
}

export interface ConexionApi {
  configurada: boolean;
  origen: string;
  url: string | null;
  validarTls: boolean;
  rutaConsultar: string | null;
  rutaResolver: string | null;
  guardadaEnApp: boolean;
  etiqueta: string;
}

export interface Conexiones { sql: ConexionBd; log: ConexionBd; api: ConexionApi; }

export interface EstadoBreb {
  rol: 'ADMIN_MIN' | 'CONSULTA' | null;
  esAdminPod: boolean;
  conexiones: Conexiones;
}

export interface FormBd {
  servidor: string; puerto: number | null; base: string; usuario: string; clave: string; cifrado: boolean; confiarCertificado: boolean; bancoPropio?: string;
}
export interface FormApi { url: string; validarTls: boolean; rutaConsultar: string; rutaResolver: string; }

export interface ResultadoPrueba {
  ok: boolean;
  version: string | null;
  baseConectada: string | null;
  servidor: string | null;
  puerto: number | null;
  base: string | null;
  url: string | null;
  error: string | null;
  aviso: string | null;
  rutaConsultar: string | null;
  rutaResolver: string | null;
}

export interface Ventana { desde: string; hasta: string; rango: string; etiqueta: string; dias: number; ahora: string; }
export interface OrigenEstado { estado: 'ok' | 'error' | 'sin_config' | 'no_usado'; error: string | null; }
export interface Origenes { sql: OrigenEstado; log: OrigenEstado; }

interface Base {
  ventana?: Ventana;
  propio?: string;
  origenes: Origenes;
  bloques: Record<string, BloqueResultado>;
  generadoEn: string;
}

export interface RespuestaResumen extends Base { hallazgos: Hallazgo[]; logsRecortados: boolean; }
export type RespuestaTransacciones = Base;
export interface RespuestaErrores extends Base { hallazgos: Hallazgo[]; logsRecortados: boolean; }
export interface RespuestaLlaves extends Base { hallazgos: Hallazgo[]; }
export type RespuestaParametros = Base;
export interface RespuestaLogs extends Base { siguiente: string | null; }

export interface ResumenReconciliacion { debitosEnLog: number; salientesEnBd: number; logSinBd: number; bdSinLog: number; coinciden: number; }
export interface RespuestaReconciliacion extends Base { hallazgos: Hallazgo[]; resumen: ResumenReconciliacion; }

export interface SeccionDetalle { titulo: string; campos: { etiqueta: string; valor: string }[]; }
export interface PasoFlujo { id: string; nombre: string; estado: 'ok' | 'error' | 'falta' | 'info'; cantidad: number; primera: string | null; detalle: string | null; }
export interface FlujoTrx { pasos: PasoFlujo[]; total: number; errores: number; tipoFlujo: string | null; gatewayRepetido: number; faltantes: string[]; evaluado: boolean; }
export interface PuntoLatencia { codigo: string; hora: string; desdeInicioMs: number; pasoMs: number; }
export interface Latencias { puntos: PuntoLatencia[]; totalMs: number; mayorTramo: { de: string; a: string; ms: number } | null; }

export interface RespuestaTransaccion extends Omit<Base, 'ventana'> {
  cus: string;
  encontrada: boolean;
  enBd: boolean;
  repeticiones: number;
  direccion: string | null;
  estado: { clase: string; codigo: string | null } | null;
  monto: number | null;
  secciones: SeccionDetalle[];
  flujo: FlujoTrx | null;
  latencias: Latencias | null;
  hallazgos: Hallazgo[];
}

export interface Payload { tipo: 'json' | 'xml' | 'texto'; texto: string; truncado: boolean; bytes: number; }
export interface RespuestaLogDetalle {
  codigo: string; fecha: string; clase: string | null; metodo: string | null; descripcion: string | null; cus: string | null; documento: string | null;
  ip: string | null; sesion: string | null; nivel: 'Error' | 'Info'; canal: number | null; funcionalidad: number | null; tipo: number | null; proceso: number | null;
  etapa: string; latencias: Latencias | null; rq: Payload | null; rs: Payload | null; adicional: Payload | null;
}

export interface UsuarioBreb { idTipoPersona: number | null; idTipoDocumento: number | null; persona: string | null; tipoDocumento: string | null; }
export interface EventoLinea { fecha: string; tipo: 'trx' | 'trx_mal' | 'llave' | 'error' | 'qr'; titulo: string; detalle: string | null; cus: string | null; }
export interface RespuestaCliente extends Base {
  enmascarado: string; dias: number; diasLogs: number; encontrado: boolean; usuarios: UsuarioBreb[]; lineaTiempo: EventoLinea[]; hallazgos: Hallazgo[];
}

export interface Catalogos {
  propio: string;
  personas: { id: number; nombre: string }[];
  documentos: { id: number; nombre: string }[];
  disponible: boolean;
  error: string | null;
}

export interface CampoRespuesta { Campo: string; Valor: string | null; }
export interface CruceLlaves {
  usuario?: BloqueResultado;
  llaves?: BloqueResultado;
  // «resolver»: viene el bloque tal cual
  ok?: boolean;
  columnas?: { clave: string; etiqueta: string }[];
  filas?: Record<string, string | number | boolean | null>[];
  error?: string;
  titulo?: string;
  ayuda?: string | null;
}
export interface RespuestaHerramientaLlave {
  operacion: 'consultar' | 'resolver';
  ruta: string;
  http: number;
  ms: number;
  ok: boolean;
  recibido?: string;
  campos: CampoRespuesta[];
  payload: Payload | null;
  cruce: CruceLlaves | null;
}

export interface FiltrosTransacciones {
  rango: string; desde?: string; hasta?: string; estado?: string; caso?: string; escenario?: string; iniciador?: string; entidad?: string;
  direccion?: string; montoMin?: string | number | null; montoMax?: string | number | null; q?: string; top?: number;
}
export interface FiltrosLogs {
  rango: string; desde?: string; hasta?: string; cus?: string; documento?: string; clase?: string; metodo?: string; nivel?: string; texto?: string;
  enPayload?: boolean; antes?: string | null; top?: number;
}

@Injectable({ providedIn: 'root' })
export class BrebService {
  private base = `${environment.apiUrl}/monitoreo-transaccional/breb`;

  constructor(private http: HttpClient) {}

  private params(o: object): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined || v === '' || v === false) continue;
      p = p.set(k, v === true ? '1' : String(v));
    }
    return p;
  }

  estado(): Observable<EstadoBreb> { return this.http.get<EstadoBreb>(this.base); }

  // Conexiones (solo ADMIN_POD)
  guardarConexion(d: Destino, f: FormBd | FormApi): Observable<ConexionBd | ConexionApi> { return this.http.put<ConexionBd | ConexionApi>(`${this.base}/conexion/${d}`, f); }
  quitarConexion(d: Destino): Observable<ConexionBd | ConexionApi> { return this.http.post<ConexionBd | ConexionApi>(`${this.base}/conexion/${d}/quitar`, {}); }
  probarConexion(d: Destino, f: FormBd | FormApi | null): Observable<ResultadoPrueba> { return this.http.post<ResultadoPrueba>(`${this.base}/conexion/${d}/probar`, f || {}); }

  // Consultas
  resumen(f: { rango: string; desde?: string; hasta?: string }): Observable<RespuestaResumen> { return this.http.get<RespuestaResumen>(`${this.base}/resumen`, { params: this.params(f) }); }
  transacciones(f: FiltrosTransacciones): Observable<RespuestaTransacciones> { return this.http.get<RespuestaTransacciones>(`${this.base}/transacciones`, { params: this.params(f) }); }
  transaccion(cus: string): Observable<RespuestaTransaccion> { return this.http.get<RespuestaTransaccion>(`${this.base}/transaccion/${encodeURIComponent(cus)}`); }
  errores(f: { rango: string; desde?: string; hasta?: string }): Observable<RespuestaErrores> { return this.http.get<RespuestaErrores>(`${this.base}/errores`, { params: this.params(f) }); }
  reconciliacion(f: { rango: string; desde?: string; hasta?: string }): Observable<RespuestaReconciliacion> { return this.http.get<RespuestaReconciliacion>(`${this.base}/reconciliacion`, { params: this.params(f) }); }
  cliente(documento: string, dias: number, diasLogs: number): Observable<RespuestaCliente> { return this.http.get<RespuestaCliente>(`${this.base}/cliente`, { params: this.params({ documento, dias, diasLogs }) }); }
  llaves(f: { rango: string; desde?: string; hasta?: string }): Observable<RespuestaLlaves> { return this.http.get<RespuestaLlaves>(`${this.base}/llaves-qr`, { params: this.params(f) }); }
  parametros(f: { app?: string; texto?: string }): Observable<RespuestaParametros> { return this.http.get<RespuestaParametros>(`${this.base}/parametros`, { params: this.params(f) }); }
  logs(f: FiltrosLogs): Observable<RespuestaLogs> { return this.http.get<RespuestaLogs>(`${this.base}/logs`, { params: this.params(f) }); }
  logDetalle(codigo: string): Observable<RespuestaLogDetalle> { return this.http.get<RespuestaLogDetalle>(`${this.base}/logs/${encodeURIComponent(codigo)}`); }
  catalogos(): Observable<Catalogos> { return this.http.get<Catalogos>(`${this.base}/catalogos`); }

  // Servicio de llaves de BreB (solo lectura)
  consultarLlave(f: { idTipoPersona: number; idTipoDocumento: number; numeroDocumento: string }): Observable<RespuestaHerramientaLlave> {
    return this.http.post<RespuestaHerramientaLlave>(`${this.base}/llaves/consultar`, f);
  }
  resolverLlave(f: { aliasValue: string; received?: string }): Observable<RespuestaHerramientaLlave> {
    return this.http.post<RespuestaHerramientaLlave>(`${this.base}/llaves/resolver`, f);
  }
}
