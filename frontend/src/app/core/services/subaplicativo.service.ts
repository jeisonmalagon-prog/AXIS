import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

export interface AplicacionNegocioRef {
  id: number;
  nombre: string;
}

export interface IntegracionSub {
  id: number;
  descripcion?: string | null;
  tipo_destino: 'aplicativo' | 'servidor';
  nombre_destino: string;
  servidor_relacionado?: string | null;
}

export type BusServicio = 'ACE' | 'BUS10';

/** Servicio del inventario de Servicios que consume un sub-aplicativo, y por cuál bus. */
export interface IntegracionServicioSub {
  id: number;
  servicio_id: number;
  bus: BusServicio;
  descripcion?: string | null;
  codigo: string | null;
  nombre: string | null;
  pod?: string | null;
}

/** Servicio del inventario de Servicios, para elegirlo en el formulario. */
export interface ServicioBusOpcion {
  id: number;
  codigo: string;
  nombre: string;
  tipo: string;
  pod: string | null;
  /** Aparece en la lista del BUS ACE 12. */
  ace: boolean;
  /** Tiene URLs en el BUS 10. */
  bus10: boolean;
}

export interface IntegracionEntrante {
  id: number;
  descripcion?: string | null;
  nombre_origen: string;
  servidor_origen?: string | null;
  componente_origen_id?: number | null;
}

export interface ConexionBdSub {
  id: number;
  servidor_bd_id: number;
  motor_bd: string;
  nombre_base_datos: string;
  esquema: string | null;
  puerto: number | null;
  usuario_servicio: string | null;
  servidor_bd_hostname: string;
  servidor_bd_ip: string;
}

// Un sub-aplicativo = un componente registrado en la pantalla Aplicaciones
// (Servidor_Componentes) más su ficha técnica (inv_aplicativos).
export interface Subaplicativo {
  id: number;
  nombre: string;
  tipo: string | null;
  puerto: number | null;
  servidor_id: number;
  servidor_hostname: string;
  servidor_ip: string;
  ambiente: string;
  servidor_activo: number;
  aplicativo_id: number | null;
  aplicaciones_negocio: AplicacionNegocioRef[];

  plataforma: string | null;
  estado: string | null;
  criticidad: string | null;
  propietario: string | null;
  dev_responsable: string | null;
  fecha_ultimo_despliegue: string | null;
  responsable_ultimo_despliegue: string | null;
  version_imagen: string | null;
  repositorio_url: string | null;
  pipeline_url: string | null;
  url_salud: string | null;
  info_seguridad: string | null;
  certificado_id: number | null;
  certificado_nombre?: string | null;
  certificado_fecha_fin?: string | null;
  descripcion_uso: string | null;
  dependencias: string | null;
  puntos_integracion: string | null;
  comandos: string | null;
  configuracion: string | null;

  // Solo en la lista:
  total_integraciones?: number;
  total_conexiones_bd?: number;
  total_servicios_bus?: number;
  // Solo en la ficha:
  integraciones?: IntegracionSub[];
  integraciones_entrantes?: IntegracionEntrante[];
  conexiones_bd?: ConexionBdSub[];
  integraciones_servicios?: IntegracionServicioSub[];
  /** false si todavía no se creó la tabla inv_aplicativo_servicios_bus (script SQL pendiente). */
  integraciones_servicios_disponible?: boolean;
}

export interface ServidorOpcion {
  id: number;
  hostname: string;
  ip: string;
  ambiente: string;
  activo: number;
}

export interface SubaplicativoGuardar {
  servidor_id?: number;
  nombre: string;
  tipo: string | null;
  puerto: number | null;
  aplicaciones_negocio_ids: number[];
  plataforma: string | null;
  estado: string | null;
  criticidad: string | null;
  propietario: string | null;
  dev_responsable: string | null;
  fecha_ultimo_despliegue: string | null;
  responsable_ultimo_despliegue: string | null;
  version_imagen: string | null;
  repositorio_url: string | null;
  pipeline_url: string | null;
  url_salud: string | null;
  info_seguridad: string | null;
  certificado_id: number | null;
  descripcion_uso: string | null;
  dependencias: string | null;
  puntos_integracion: string | null;
  comandos: string | null;
  configuracion: string | null;
}

@Injectable({ providedIn: 'root' })
export class SubaplicativoService {
  private base = `${environment.apiUrl}/subaplicativos`;
  private baseInv = `${environment.apiUrl}/servidoresInventario`;

  constructor(private http: HttpClient) {}

  listar(): Observable<Subaplicativo[]> {
    return this.http.get<Subaplicativo[]>(this.base);
  }

  obtener(id: number): Observable<Subaplicativo> {
    return this.http.get<Subaplicativo>(`${this.base}/${id}`);
  }

  crear(datos: SubaplicativoGuardar): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(this.base, datos);
  }

  actualizar(id: number, datos: SubaplicativoGuardar): Observable<{ aplicativo_id: number }> {
    return this.http.put<{ aplicativo_id: number }>(`${this.base}/${id}`, datos);
  }

  eliminar(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}`);
  }

  listarServidores(): Observable<ServidorOpcion[]> {
    return this.http.get<ServidorOpcion[]>(`${this.base}/catalogos/servidores`);
  }

  agregarIntegracion(id: number, datos: { destino_componente_id?: number | null; destino_servidor_id?: number | null; descripcion?: string }): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.base}/${id}/integraciones`, datos);
  }

  eliminarIntegracion(id: number, integracionId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}/integraciones/${integracionId}`);
  }

  serviciosBus(): Observable<ServicioBusOpcion[]> {
    return this.http.get<ServicioBusOpcion[]>(`${this.base}/catalogos/servicios-bus`);
  }

  agregarIntegracionServicio(id: number, datos: { servicio_id: number; bus: BusServicio; descripcion?: string | null }): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.base}/${id}/integraciones-servicios`, datos);
  }

  eliminarIntegracionServicio(id: number, integracionId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}/integraciones-servicios/${integracionId}`);
  }

  agregarConexionBd(id: number, datos: {
    servidor_bd_id: number; motor_bd: string; nombre_base_datos: string;
    esquema?: string | null; puerto?: number | null; usuario_servicio?: string | null;
  }): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.base}/${id}/conexiones-bd`, datos);
  }

  eliminarConexionBd(id: number, conexionId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}/conexiones-bd/${conexionId}`);
  }

  // Catálogos que ya existían en el módulo de Servidores
  certificados(): Observable<{ id: number; nombre_comun: string; entidad_emisora?: string; fecha_fin?: string }[]> {
    return this.http.get<any[]>(`${this.baseInv}/catalogos/certificados`);
  }

  aplicacionesNegocio(): Observable<AplicacionNegocioRef[]> {
    return this.http.get<AplicacionNegocioRef[]>(`${this.baseInv}/catalogos/aplicaciones-negocio`);
  }

  personas(): Observable<{ id: number; nombre: string }[]> {
    return this.http.get<{ id: number; nombre: string }[]>(`${this.baseInv}/catalogos/personas`);
  }

  agregarPersona(nombre: string): Observable<{ id: number; nombre: string }> {
    return this.http.post<{ id: number; nombre: string }>(`${this.baseInv}/catalogos/personas`, { nombre });
  }

  servidoresBd(): Observable<{ id: number; nombre: string; subtitulo?: string }[]> {
    return this.http.get<any>(`${this.baseInv}/catalogos/opciones-integracion`).pipe(
      map((d) => (d.servidoresBd || []) as { id: number; nombre: string; subtitulo?: string }[])
    );
  }
}
