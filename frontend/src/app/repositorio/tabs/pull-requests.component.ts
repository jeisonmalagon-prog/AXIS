import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { RepositorioContextService } from '../repositorio-context.service';
import { IcoComponent } from '../../shared/ico/ico.component';

export interface PullRequestAzure {
  id: number;
  titulo: string;
  descripcion: string;
  estado: string; // active | completed | abandoned
  esBorrador: boolean;
  autor: string;
  ramaOrigen: string;
  ramaDestino: string;
  creado: string | null;
  cerrado: string | null;
  url: string;
}

type FiltroEstado = 'active' | 'completed' | 'abandoned' | 'all';

const ETIQUETAS_FILTRO: { valor: FiltroEstado; texto: string }[] = [
  { valor: 'active', texto: 'Activos' },
  { valor: 'completed', texto: 'Completados' },
  { valor: 'abandoned', texto: 'Abandonados' },
  { valor: 'all', texto: 'Todos' },
];

@Component({
  selector: 'app-repo-pull-requests',
  standalone: true,
  imports: [IcoComponent, CommonModule],
  templateUrl: './pull-requests.component.html',
  styleUrl: './pull-requests.component.scss',
})
export class RepoPullRequestsComponent implements OnInit, OnDestroy {
  cargando = false;
  error = '';
  pullRequests: PullRequestAzure[] = [];
  filtroActivo: FiltroEstado = 'active';
  readonly filtros = ETIQUETAS_FILTRO;

  private endpoint = `${environment.apiUrl}/azure-repo`;
  private suscripcionRepo?: Subscription;

  constructor(private http: HttpClient, private repoContext: RepositorioContextService) {}

  ngOnInit(): void {
    // Recarga los pull requests cada vez que cambia el repositorio
    // seleccionado en el encabezado (incluida la primera resolución del
    // repo por defecto).
    this.suscripcionRepo = this.repoContext.repositorioActual$.subscribe((repo) => {
      if (repo) this.cargar(this.filtroActivo);
    });
  }

  ngOnDestroy(): void {
    this.suscripcionRepo?.unsubscribe();
  }

  cargar(estado: FiltroEstado): void {
    this.filtroActivo = estado;
    this.cargando = true;
    this.error = '';
    const repo = this.repoContext.repositorioActual;

    this.http
      .get<{ estado: string; pullRequests: PullRequestAzure[] }>(`${this.endpoint}/pull-requests`, {
        params: repo ? { estado, repo } : { estado },
      })
      .subscribe({
        next: (data) => {
          this.pullRequests = data.pullRequests || [];
          this.cargando = false;
        },
        error: (err) => {
          this.error = err.error?.error || 'No se pudieron cargar los pull requests.';
          this.cargando = false;
        },
      });
  }

  etiquetaEstado(estado: string): string {
    if (estado === 'active') return 'Activo';
    if (estado === 'completed') return 'Completado';
    if (estado === 'abandoned') return 'Abandonado';
    return estado;
  }
}
