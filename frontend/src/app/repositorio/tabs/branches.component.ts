import { Component, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { RepositorioContextService } from '../repositorio-context.service';
import { IcoComponent } from '../../shared/ico/ico.component';

export interface CommitRama {
  id: string;
  idCorto: string;
  comentario: string;
  autor: string;
  fecha: string | null;
}

export interface RamaAzure {
  nombre: string;
  esRamaPorDefecto: boolean;
  aheadCount: number | null;
  behindCount: number | null;
  commit: CommitRama | null;
  url: string;
}

@Component({
  selector: 'app-repo-branches',
  standalone: true,
  imports: [IcoComponent, CommonModule],
  templateUrl: './branches.component.html',
  styleUrl: './branches.component.scss',
})
export class RepoBranchesComponent implements OnInit, OnDestroy {
  cargando = false;
  error = '';
  ramas: RamaAzure[] = [];
  ramaPorDefecto = '';

  // Se emite cuando el usuario pide explorar los archivos de una rama
  // distinta -- el componente padre (RepositorioComponent) es quien sabe
  // cómo cambiar de pestaña y recargar el explorador con esa rama.
  @Output() ramaSeleccionada = new EventEmitter<string>();

  private endpoint = `${environment.apiUrl}/azure-repo`;
  private suscripcionRepo?: Subscription;

  constructor(private http: HttpClient, private repoContext: RepositorioContextService) {}

  ngOnInit(): void {
    // Recarga las ramas cada vez que cambia el repositorio seleccionado en
    // el encabezado (incluida la primera resolución del repo por defecto).
    this.suscripcionRepo = this.repoContext.repositorioActual$.subscribe((repo) => {
      if (repo) this.cargar();
    });
  }

  ngOnDestroy(): void {
    this.suscripcionRepo?.unsubscribe();
  }

  cargar(): void {
    this.cargando = true;
    this.error = '';
    const repo = this.repoContext.repositorioActual;

    this.http
      .get<{ ramaPorDefecto: string; ramas: RamaAzure[] }>(`${this.endpoint}/branches`, {
        params: repo ? { repo } : {}
      })
      .subscribe({
        next: (data) => {
          this.ramas = data.ramas || [];
          this.ramaPorDefecto = data.ramaPorDefecto || '';
          this.cargando = false;
        },
        error: (err) => {
          this.error = err.error?.error || 'No se pudieron cargar las ramas del repositorio.';
          this.cargando = false;
        },
      });
  }

  explorar(nombreRama: string): void {
    this.ramaSeleccionada.emit(nombreRama);
  }
}
