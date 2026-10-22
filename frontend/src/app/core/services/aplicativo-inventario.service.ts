import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { OpcionSelector } from '../../shared/selector-buscable/selector-buscable.component';

// Sub-aplicativo del inventario (componente registrado en la pantalla
// Aplicaciones, ver módulo "Inventario de Sub-aplicativos"). Extiende
// OpcionSelector para pasarse directo al selector buscable: `id` es el id del
// COMPONENTE, `nombre` su rol y `subtitulo` "servidor · :puerto · aplicaciones
// de negocio" (también participa en la búsqueda).
export interface AplicativoInventarioBasico extends OpcionSelector {
  servidorId: number;
  servidorHostname: string;
  ambiente: string | null;
  puerto: number | null;
  tipo: string | null;
  criticidad: string | null;
  plataforma: string | null;
  estado: string | null;
  activo: number;
  aplicacionesNegocio: { id: number; nombre: string }[];
}

// Catálogo de sub-aplicativos usado por el selector de "qué aplicativo se va a
// pasar a producción" en la Bitácora de Pasos a Producción. Lo sirve el propio
// módulo de pasos (no exige tener también el módulo SERVIDORES).
@Injectable({ providedIn: 'root' })
export class AplicativoInventarioService {
  private baseUrl = `${environment.apiUrl}/pasos-produccion`;

  constructor(private http: HttpClient) {}

  listarBasico(): Observable<AplicativoInventarioBasico[]> {
    return this.http.get<AplicativoInventarioBasico[]>(`${this.baseUrl}/catalogos/subaplicativos`);
  }
}
