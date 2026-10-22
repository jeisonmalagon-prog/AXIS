import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject } from 'rxjs';
import { environment } from '../../environments/environment';

export interface RepositorioAzure {
  id: string;
  nombre: string;
  esPorDefecto: boolean;
  ramaPorDefecto: string | null;
}

// Servicio compartido (singleton, providedIn 'root') entre el componente
// principal de Repositorio y sus pestañas (Branches, Pull Requests, ...).
// Antes cada componente llamaba directo a /azure-repo asumiendo siempre el
// repositorio fijo configurado por variable de entorno en el backend
// (AZURE_DEVOPS_REPO); ahora el usuario puede elegir entre TODOS los repos
// del proyecto desde el selector del encabezado, y este servicio centraliza
// cuál está seleccionado para que todas las pestañas queden sincronizadas.
@Injectable({ providedIn: 'root' })
export class RepositorioContextService {
  private readonly endpoint = `${environment.apiUrl}/azure-repo`;

  private readonly repositoriosSubject = new BehaviorSubject<RepositorioAzure[]>([]);
  readonly repositorios$ = this.repositoriosSubject.asObservable();

  // Nombre del repo actualmente seleccionado. Vacío hasta que
  // cargarRepositorios() resuelve la lista y fija el default -- los
  // consumidores deben ignorar el valor vacío inicial.
  private readonly repositorioActualSubject = new BehaviorSubject<string>('');
  readonly repositorioActual$ = this.repositorioActualSubject.asObservable();

  cargando = false;
  error = '';
  // true cuando el usuario no tiene ningún repositorio habilitado (ver Accesos del ADMIN_POD).
  sinRepositorios = false;
  private yaSolicitado = false;

  constructor(private http: HttpClient) {}

  get repositorioActual(): string {
    return this.repositorioActualSubject.value;
  }

  // Trae la lista de repos del proyecto. Es seguro llamarla varias veces
  // (ej. una vez por cada pestaña que se monta) -- solo dispara la petición
  // HTTP la primera vez; usar forzar=true para refrescar explícitamente.
  cargarRepositorios(forzar = false): void {
    if (this.yaSolicitado && !forzar) return;
    this.yaSolicitado = true;
    this.cargando = true;
    this.error = '';

    this.http
      .get<{ repositorioPorDefecto: string; repositorios: RepositorioAzure[] }>(`${this.endpoint}/repositorios`)
      .subscribe({
        next: (data: any) => {
          const repos: RepositorioAzure[] = data.repositorios || [];
          this.repositoriosSubject.next(repos);
          const actualYaNoExiste = repos.length > 0 && !!this.repositorioActual && !repos.some((r) => r.nombre === this.repositorioActual);
          if (!this.repositorioActual || actualYaNoExiste) {
            const porDefecto =
              repos.find((r) => r.esPorDefecto)?.nombre || repos[0]?.nombre || data.repositorioPorDefecto || '';
            if (porDefecto) this.repositorioActualSubject.next(porDefecto);
          }
          this.sinRepositorios = repos.length === 0;
          // Sin repositorios las secciones del proyecto (pipelines, boards...) deben poder cargar igual:
          // se fija un valor que el backend rechaza solo para las secciones de código.
          if (this.sinRepositorios && !this.repositorioActual) this.repositorioActualSubject.next('_sin_acceso_');
          this.cargando = false;
        },
        error: (err) => {
          this.error = err.error?.error || 'No se pudo cargar la lista de repositorios de Azure DevOps.';
          this.cargando = false;
        },
      });
  }

  seleccionarRepositorio(nombre: string): void {
    if (nombre && nombre !== this.repositorioActual) {
      this.repositorioActualSubject.next(nombre);
    }
  }
}
