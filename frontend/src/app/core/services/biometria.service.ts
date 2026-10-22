import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// ==========================================================================
// Módulo BIOMETRIA. Flujo de solo lectura:
//   1) MotorFirma · PendienteFirma.Solicitudes (IdEstadoBiometria 60, IdEstadoFirma 30), filtradas por FechaModificacion;
//   2) MotorFirma · Firma.Detalle: por RadNumber se toman los IdCasoBiometria;
//   3) ORQBIOMETRIA: esos casos con resultado «CEDULA ORIGINAL OK» (cédula, nombre, caso);
//   4) por cada cédula, el curl de ConsultarBiometria en el servidor de biometría (SSH).
// ==========================================================================

export interface FiltroFechas { desde: string; hasta: string; }

export interface PasosBiometria {
  /** Solicitudes con IdEstadoBiometria 60 e IdEstadoFirma 30 en el rango de fechas. */
  solicitudes: number;
  solicitudesLeidas: number;
  truncado: boolean;
  radNumbers: number;
  /** Solicitudes cuyo RadNumber no tiene IdCasoBiometria en Firma.Detalle. */
  solicitudesSinCaso: number;
  casosEnDetalle: number;
  casosConResultadoOk: number;
  /** Casos descartados porque el último intento del cliente ya está en un estado exitoso. */
  descartadosPorExito: number;
  documentos: number;
  sinDocumentoValido: number;
}

export interface FilaBiometria {
  clave: string;
  idSolicitud: string | null;
  radNumber: string;
  fechaModificacion: string | null;
  cc: string | null;
  nombre: string | null;
  idCaso: string;
  estadoCaso: string | null;
  idCanal: string | null;
  idResultado: string | number | null;
  estadoResultado: string | null;
  codigoResultado: string | null;
  descripcionResultado: string | null;
  /** Último intento (caso de mayor id) del cliente y su estado. */
  ultimoCaso: string | null;
  ultimoEstado: string | null;
  documentoValido: boolean;
}

export interface ResultadoBiometria {
  generado: string;
  duracionMs: number;
  filtro: FiltroFechas;
  pasos: PasosBiometria;
  resultadoOk: string;
  filas: FilaBiometria[];
  /** Clientes cuyo último intento ya fue exitoso: no se procesan, pero se muestran como información. */
  descartadas: FilaBiometria[];
  descartadasTruncado: boolean;
}

export interface RespuestaResultado {
  resultado: ResultadoBiometria | null;
  error: string | null;
  enEjecucion: boolean;
}
export interface RespuestaConsultar { resultado: ResultadoBiometria; }

export interface ClienteResultado {
  documento: string;
  ok: boolean;
  httpCodigo: number | null;
  json: unknown;
  cuerpo: string;
  error: string | null;
  etapa: 'ssh' | 'servicio' | 'validacion';
}
export interface LoteRespuesta {
  servidor: string;
  comando: string;
  duracionMs: number;
  fallaConexion: boolean;
  error: string | null;
  resultados: ClienteResultado[];
}

// ---- Consulta por cliente (pantalla principal) ----
export type CriterioCliente = 'cc' | 'nombre' | 'caso' | 'radicado';
export type DatosFila = Record<string, string | number | boolean | null>;

export interface ServicioBiometria {
  servidor: string;
  puertoApi: number;
  url: string;
  ignorarCertificado: boolean;
  tipoDocumentoPorDefecto: number;
  configurado: boolean;
  /** curl con <tipoDocumento> y <documento> por reemplazar. */
  curlPlantilla: string;
}

export interface ClienteLista { id: string | null; cc: string | null; nombre: string | null; totalCasos: number; ultimoCaso: string | null; }
export interface BusquedaClientes { criterio: CriterioCliente; valor: string; clientes: ClienteLista[]; truncado: boolean; nota: string | null; }

export interface ResultadoCaptura { id: string | null; estado: string | null; datos: DatosFila; }
export interface CapturaCliente { id: string | null; datos: DatosFila; resultados: ResultadoCaptura[]; }
export interface CasoCliente { id: string; estado: string | null; datos: DatosFila; capturas: CapturaCliente[]; }
export interface FirmaCliente {
  radNumber: string; casos: string[]; detalle: DatosFila; filasDetalle: number; solicitud: DatosFila | null;
}
export interface ResumenCliente {
  totalCasos: number;
  ultimoCaso: { id: string; estado: string | null; exitoso: boolean } | null;
  casosExitosos: number;
  conCedulaOk: number;
  porEstado: { estado: string; total: number }[];
}
export interface DetalleCliente {
  generado: string;
  duracionMs: number;
  cc: string;
  encontrado: boolean;
  clientes: { id: string; datos: DatosFila }[];
  casos: CasoCliente[];
  resumen: ResumenCliente;
  firmas: { disponible: boolean; error: string | null; filas: FirmaCliente[]; truncado: boolean };
  advertencias: string[];
  /** Cuánto tardó cada consulta (para ubicar la lenta). */
  etapas: { etapa: string; ms: number }[];
}

export interface FilaListado {
  idCaso: string; cc: string | null; nombre: string | null; fecha: string | null; estado: string | null; idCanal: string | null; resultado: string | null;
}
export interface ListadoBiometrias {
  generado: string;
  duracionMs: number;
  filtro: { desde: string; hasta: string; estado: string | null; resultado: string | null };
  columnaFecha: string;
  totalRango: number;
  porEstado: { estado: string; total: number }[];
  porResultado: { resultado: string; total: number }[];
  truncado: boolean;
  filas: FilaListado[];
  etapas: { etapa: string; ms: number }[];
}

export interface ConsultaServidor {
  servidor: string;
  duracionMs: number;
  fallaConexion: boolean;
  error: string | null;
  /** curl «manual» equivalente, para ejecutarlo a mano en el servidor. */
  curl: string;
  resultado: ClienteResultado | null;
}

@Injectable({ providedIn: 'root' })
export class BiometriaService {
  private base = `${environment.apiUrl}/biometria`;

  constructor(private http: HttpClient) {}

  resultado(): Observable<RespuestaResultado> {
    return this.http.get<RespuestaResultado>(`${this.base}/resultado`);
  }
  consultar(filtro: FiltroFechas): Observable<RespuestaConsultar> {
    return this.http.post<RespuestaConsultar>(`${this.base}/consultar`, filtro);
  }
  /** Ejecuta el curl de ConsultarBiometria por cada documento (hasta 12), con una sola conexión SSH. */
  consultarLote(tipoDocumento: number, documentos: string[]): Observable<LoteRespuesta> {
    return this.http.post<LoteRespuesta>(`${this.base}/consultar-lote`, { tipoDocumento, documentos });
  }

  /** Datos no secretos del servicio de biometría (para armar el curl en pantalla). */
  servicio(): Observable<ServicioBiometria> {
    return this.http.get<ServicioBiometria>(`${this.base}/servicio`);
  }
  buscarClientes(criterio: CriterioCliente, valor: string): Observable<BusquedaClientes> {
    return this.http.post<BusquedaClientes>(`${this.base}/clientes/buscar`, { criterio, valor });
  }
  detalleCliente(cc: string): Observable<DetalleCliente> {
    return this.http.post<DetalleCliente>(`${this.base}/clientes/detalle`, { cc });
  }
  /** Biometrías en general: casos de ORQBIOMETRIA en un rango de fechas (filtros opcionales por estado y resultado). */
  listado(filtro: { desde: string; hasta: string; estado?: string; resultado?: string }): Observable<ListadoBiometrias> {
    return this.http.post<ListadoBiometrias>(`${this.base}/clientes/listado`, filtro);
  }
  /** Ejecuta el curl de UNA cédula en el servidor de biometría (SSH) y devuelve la respuesta + el curl manual. */
  consultarServidor(tipoDocumento: number, documento: string): Observable<ConsultaServidor> {
    return this.http.post<ConsultaServidor>(`${this.base}/servidor/consultar`, { tipoDocumento, documento });
  }
}
