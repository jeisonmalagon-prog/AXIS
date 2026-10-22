import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../../environments/environment';

// Lo que el usuario actual puede ver del módulo Repositorio (lo decide el ADMIN_POD
// en "Accesos"). Si la consulta falla se muestra todo y es el backend, que valida
// cada petición, quien niega lo que no corresponda.
export interface MiAcceso {
  estricto: boolean;
  restringido: boolean;
  secciones: string[];
  todosRepos: boolean;
  repos: string[];
}

export const TODAS_LAS_SECCIONES = ['resumen', 'archivos', 'commits', 'pull-requests', 'ramas', 'pipelines', 'releases', 'boards', 'wiki', 'equipo', 'buscar'];

@Injectable({ providedIn: 'root' })
export class AzureAccesoService {
  private readonly url = `${environment.apiUrl}/azure-repo/mi-acceso`;
  private readonly subject = new BehaviorSubject<MiAcceso | null>(null);
  readonly acceso$ = this.subject.asObservable();
  private solicitado = false;

  constructor(private http: HttpClient) {}

  get acceso(): MiAcceso | null { return this.subject.value; }

  cargar(forzar = false): void {
    if (this.solicitado && !forzar) return;
    this.solicitado = true;
    this.http.get<MiAcceso>(this.url).subscribe({
      next: (a) => this.subject.next(a),
      error: () => this.subject.next({ estricto: false, restringido: false, secciones: TODAS_LAS_SECCIONES, todosRepos: true, repos: [] }),
    });
  }

  puede(seccion: string): boolean {
    const a = this.subject.value;
    return !a || a.secciones.includes(seccion);
  }
}
