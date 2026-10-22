import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AceServicioInventario, ArchivoServicio, FilaImportacionBus10, ListaArchivosServicio, ResultadoImportacionBus10 } from '../models/models';

export interface PeticionConsumo {
  metodo: string;
  url: string;
  cabeceras: { nombre: string; valor: string }[];
  cuerpo: string;
  timeoutSegundos: number;
  verificarTls: boolean;
  confirmarProduccion?: boolean;
  /** Certificado de cliente (mTLS) con el que se ejecuta la petición. */
  certificadoId?: number | null;
}

/** Petición guardada de un servicio (una por operación). Nunca incluye credenciales. */
export interface PeticionGuardada {
  Id: number;
  ServicioId: number;
  Nombre: string;
  Metodo: string;
  /** Si es null se usa la URL del ambiente que se elija al probar. */
  Url: string | null;
  Cabeceras: { nombre: string; valor: string; activo: boolean }[];
  Cuerpo: string;
  CreadoPorNombre: string | null;
  FechaCreacion: string;
  FechaActualizacion: string;
}

export interface ListaPeticionesGuardadas {
  /** false = falta crear la tabla AceServiciosPeticiones en la base de datos. */
  disponible: boolean;
  mensaje: string | null;
  peticiones: PeticionGuardada[];
}

export interface PeticionAGuardar {
  nombre: string;
  metodo: string;
  url?: string | null;
  cabeceras: { nombre: string; valor: string; activo?: boolean }[];
  cuerpo: string;
}

export interface ResultadoGuardarPeticiones {
  creadas: PeticionGuardada[];
  omitidas: { nombre: string; motivo: 'NOMBRE' | 'CONTENIDO' | 'LIMITE' | 'INVALIDA'; detalle: string; existenteId?: number }[];
  cabecerasDescartadas: string[];
}

export interface CertificadoConsumo {
  Id: number;
  Nombre: string;
  /** CLIENTE: certificado + llave (mTLS). CA: entidad certificadora en la que AXIS confía. */
  Tipo: 'CLIENTE' | 'CA';
  Formato: 'PFX' | 'PEM';
  Sujeto: string | null;
  Emisor: string | null;
  Huella: string | null;
  VenceEn: string | null;
  Compartido: boolean;
  CreadoPorNombre: string | null;
  FechaCreacion: string;
  Propio: boolean;
  Vencido: boolean;
}

export interface ListaCertificadosConsumo {
  disponible: boolean;
  mensaje?: string;
  certificados: CertificadoConsumo[];
}

export interface RespuestaWsdl {
  documentos: { url: string; texto: string }[];
  avisos: string[];
  errorRed?: { codigo: string; mensaje: string };
}

export interface RespuestaConsumo {
  /** Código HTTP. Ausente cuando hubo error de red (ver errorRed). */
  estado?: number;
  estadoTexto?: string;
  duracionMs: number;
  tamanoBytes?: number;
  headers?: { nombre: string; valor: string }[];
  esTexto?: boolean;
  cuerpo?: string;
  truncado?: boolean;
  produccion?: boolean;
  destino?: string;
  errorRed?: { codigo: string; mensaje: string };
}

@Injectable({ providedIn: 'root' })
export class AceServiciosService {
  private baseUrl = `${environment.apiUrl}/ace-servicios`;

  constructor(private http: HttpClient) {}

  listar(): Observable<AceServicioInventario[]> {
    return this.http.get<AceServicioInventario[]>(this.baseUrl);
  }

  crear(servicio: Partial<AceServicioInventario>): Observable<AceServicioInventario> {
    return this.http.post<AceServicioInventario>(this.baseUrl, servicio);
  }

  actualizar(id: number, servicio: Partial<AceServicioInventario>): Observable<AceServicioInventario> {
    return this.http.put<AceServicioInventario>(`${this.baseUrl}/${id}`, servicio);
  }

  // Carga masiva de URLs del BUS 10 (completa servicios existentes o crea los que faltan).
  importarBus10(tipo: 'SOAP' | 'REST', filas: FilaImportacionBus10[]): Observable<ResultadoImportacionBus10> {
    return this.http.post<ResultadoImportacionBus10>(`${this.baseUrl}/importar-bus10`, { Tipo: tipo, filas });
  }

  eliminar(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }

  // ---- Archivos de consumo (proyecto XML de SoapUI / colección REST) ----
  listarArchivos(id: number): Observable<ListaArchivosServicio> {
    return this.http.get<ListaArchivosServicio>(`${this.baseUrl}/${id}/archivos`);
  }

  subirArchivo(id: number, nombreOriginal: string, contenidoBase64: string, descripcion?: string): Observable<ArchivoServicio> {
    return this.http.post<ArchivoServicio>(`${this.baseUrl}/${id}/archivos`, { nombreOriginal, contenidoBase64, descripcion });
  }

  descargarArchivo(id: number, archivoId: number): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/${id}/archivos/${archivoId}/descargar`, { responseType: 'blob' });
  }

  // ---- Probar servicio: el backend ejecuta la petición SOAP/REST y devuelve la respuesta ----
  consumir(id: number, peticion: PeticionConsumo): Observable<RespuestaConsumo> {
    return this.http.post<RespuestaConsumo>(`${this.baseUrl}/${id}/consumir`, peticion);
  }

  /** Prueba libre: URL externa o servicio de un tercero (no está en el inventario). Exige permiso de edición. */
  consumirLibre(peticion: PeticionConsumo): Observable<RespuestaConsumo> {
    return this.http.post<RespuestaConsumo>(`${this.baseUrl}/consumo/libre/consumir`, peticion);
  }

  // ---- Peticiones guardadas por servicio ----
  listarPeticiones(id: number): Observable<ListaPeticionesGuardadas> {
    return this.http.get<ListaPeticionesGuardadas>(`${this.baseUrl}/${id}/peticiones`);
  }

  guardarPeticiones(id: number, peticiones: PeticionAGuardar[]): Observable<ResultadoGuardarPeticiones> {
    return this.http.post<ResultadoGuardarPeticiones>(`${this.baseUrl}/${id}/peticiones`, { peticiones });
  }

  actualizarPeticion(id: number, peticionId: number, datos: Partial<PeticionAGuardar>): Observable<{ peticion: PeticionGuardada; cabecerasDescartadas: string[] }> {
    return this.http.put<{ peticion: PeticionGuardada; cabecerasDescartadas: string[] }>(`${this.baseUrl}/${id}/peticiones/${peticionId}`, datos);
  }

  eliminarPeticion(id: number, peticionId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}/peticiones/${peticionId}`);
  }

  // ---- Certificados de consumo (cliente / CA) ----
  listarCertificados(): Observable<ListaCertificadosConsumo> {
    return this.http.get<ListaCertificadosConsumo>(`${this.baseUrl}/consumo/certificados`);
  }

  subirCertificado(datos: { nombre: string; clave: string; archivos: { nombreOriginal: string; contenidoBase64: string }[] }): Observable<CertificadoConsumo> {
    return this.http.post<CertificadoConsumo>(`${this.baseUrl}/consumo/certificados`, datos);
  }

  eliminarCertificado(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/consumo/certificados/${id}`);
  }

  // ---- WSDL: el backend lo descarga (y sus esquemas) y la pantalla arma las peticiones ----
  leerWsdl(id: number, datos: { url: string; certificadoId?: number | null; verificarTls: boolean; cabeceras: { nombre: string; valor: string }[] }): Observable<RespuestaWsdl> {
    return this.http.post<RespuestaWsdl>(`${this.baseUrl}/${id}/wsdl`, datos);
  }

  leerWsdlLibre(datos: { url: string; certificadoId?: number | null; verificarTls: boolean; cabeceras: { nombre: string; valor: string }[] }): Observable<RespuestaWsdl> {
    return this.http.post<RespuestaWsdl>(`${this.baseUrl}/consumo/libre/wsdl`, datos);
  }

  eliminarArchivo(id: number, archivoId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}/archivos/${archivoId}`);
  }
}
