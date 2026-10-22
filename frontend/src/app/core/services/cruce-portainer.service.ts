import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// Conciliación: contenedores de Portainer frente al inventario de sub-aplicativos.
// Solo lectura. El backend (GET /api/puertos/cruce) empareja cada contenedor con su
// sub-aplicativo por nombre, imagen o puerto y marca lo que no cuadra (`hallazgos`).

export type Hallazgo =
  | 'sin_registrar' | 'sin_contenedor' | 'puerto_distinto' | 'estado_distinto' | 'con_problemas'
  | 'puerto_duplicado' | 'varios_contenedores' | 'version_distinta' | 'nombre_distinto'
  | 'sin_puerto_inventario' | 'fuera_de_docker' | 'sin_servidor';

export interface CrucePuerto {
  puerto: number;
  protocolo: string;
  destino: number | null;
  direcciones: string[];
  alcance: 'todas' | 'local' | 'especifica';
  reservado: boolean;
}

export interface CruceContenedor {
  id: string;
  nombre: string;
  imagen: string;
  tag: string;
  stack: string | null;
  estado: string;
  estadoTexto: string;
  redHost: boolean;
  puertos: CrucePuerto[];
  entorno: string;
  entornoId: number;
}

export interface CruceSubaplicativo {
  id: number;
  servidorId: number;
  nombre: string;
  tipo: string | null;
  puerto: number | null;
  estado: string | null;
  criticidad: string | null;
  versionImagen: string | null;
  responsable: string | null;
  aplicaciones: string[];
}

export interface CruceFila {
  contenedor: CruceContenedor | null;
  subaplicativo: CruceSubaplicativo | null;
  emparejadoPor: 'nombre' | 'imagen' | 'puerto' | null;
  hallazgos: Hallazgo[];
  notas: string[];
  estado: Hallazgo | 'ok';
  grave: boolean;
}

export interface CruceSeccion {
  entornoIds: number[];
  entorno: string;
  servidorId: number | null;
  hostname: string | null;
  ip: string | null;
  ambiente: string | null;
  servidorInventariado: boolean;
  ok: boolean;
  error: string | null;
  filas: CruceFila[];
  contenedores: number;
  subaplicativos: number;
  sinLeer?: number;
  redHost?: number;
}

export interface ServidorSinPortainer {
  id: number;
  hostname: string;
  ip: string | null;
  ambiente: string | null;
  subaplicativos: number;
}

export interface ResumenCruce {
  servidoresConPortainer: number;
  servidoresSinLeer: number;
  servidoresSinInventario: number;
  servidoresSinPortainer: number;
  contenedores: number;
  subaplicativos: number;
  subaplicativosEnPortainer: number;
  ok: number;
  conHallazgos: number;
  graves: number;
  porHallazgo: Record<Hallazgo, number>;
}

export interface RespuestaCruce {
  configurado: boolean;
  consultadoEn: string | null;
  secciones: CruceSeccion[];
  servidoresSinPortainer: ServidorSinPortainer[];
  resumen: ResumenCruce | null;
  error: string | null;
}

@Injectable({ providedIn: 'root' })
export class CrucePortainerService {
  private base = `${environment.apiUrl}/puertos`;

  constructor(private http: HttpClient) {}

  cruce(forzar = false): Observable<RespuestaCruce> {
    return this.http.get<RespuestaCruce>(`${this.base}/cruce${forzar ? '?forzar=1' : ''}`);
  }
}
