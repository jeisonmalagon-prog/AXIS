import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

export interface UsuarioBasico {
  id: number;
  username: string;
  nombre_completo: string;
}

// Lista mínima de usuarios activos (id, username, nombre) para selectores de
// "asignar a" / "equipo" -- a diferencia de UsuariosComponent, cualquier
// usuario autenticado puede pedirla (GET /api/usuarios/basico no exige
// ADMIN_POD), porque Tareas y la Bitácora de Pasos a Producción la necesitan
// para que cualquiera pueda elegir compañeros.
@Injectable({ providedIn: 'root' })
export class UsuarioBasicoService {
  private baseUrl = `${environment.apiUrl}/usuarios`;

  private fotos$?: Observable<Record<string, string>>;

  constructor(private http: HttpClient) {}

  listarBasico(): Observable<UsuarioBasico[]> {
    return this.http.get<UsuarioBasico[]>(`${this.baseUrl}/basico`);
  }

  // Fotos de perfil de los usuarios que tienen una, como { "<id>": data URI }. Se pide
  // una sola vez por sesión (pesan más que el listado básico); "refrescar" la vuelve
  // a pedir, p. ej. tras cambiar la propia foto.
  fotos(refrescar = false): Observable<Record<string, string>> {
    if (!this.fotos$ || refrescar) {
      this.fotos$ = this.http.get<Record<string, string>>(`${this.baseUrl}/fotos`).pipe(shareReplay(1));
    }
    return this.fotos$;
  }
}
