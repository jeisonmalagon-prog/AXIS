import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { environment } from '../../../environments/environment';
import { IcoComponent } from '../../shared/ico/ico.component';

export interface BuildAzure {
  id: number;
  numero: string;
  definicion: string;
  estado: string | null; // notStarted | inProgress | completed
  resultado: string | null; // succeeded | partiallySucceeded | failed | canceled
  solicitadoPor: string;
  rama: string;
  encolado: string | null;
  inicio: string | null;
  fin: string | null;
  url: string;
}

@Component({
  selector: 'app-repo-pipelines',
  standalone: true,
  imports: [IcoComponent, CommonModule],
  templateUrl: './pipelines.component.html',
  styleUrl: './pipelines.component.scss',
})
export class RepoPipelinesComponent implements OnInit {
  cargando = false;
  error = '';
  builds: BuildAzure[] = [];

  private endpoint = `${environment.apiUrl}/azure-repo`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando = true;
    this.error = '';

    this.http.get<{ builds: BuildAzure[] }>(`${this.endpoint}/pipelines`).subscribe({
      next: (data) => {
        this.builds = data.builds || [];
        this.cargando = false;
      },
      error: (err) => {
        this.error = err.error?.error || 'No se pudo cargar el historial de pipelines.';
        this.cargando = false;
      },
    });
  }

  // Clase + texto de la insignia de estado -- combina "estado" (en curso /
  // en cola) y "resultado" (éxito / fallo) en una sola insignia, porque
  // Azure DevOps los maneja como dos campos separados pero para el usuario
  // es un solo semáforo.
  claseInsignia(build: BuildAzure): string {
    if (build.estado === 'inProgress') return 'en-curso';
    if (build.estado === 'notStarted') return 'en-cola';
    switch (build.resultado) {
      case 'succeeded': return 'exito';
      case 'partiallySucceeded': return 'parcial';
      case 'failed': return 'fallo';
      case 'canceled': return 'cancelado';
      default: return 'desconocido';
    }
  }

  textoInsignia(build: BuildAzure): string {
    if (build.estado === 'inProgress') return 'En curso';
    if (build.estado === 'notStarted') return 'En cola';
    switch (build.resultado) {
      case 'succeeded': return 'Éxito';
      case 'partiallySucceeded': return 'Parcial';
      case 'failed': return 'Falló';
      case 'canceled': return 'Cancelado';
      default: return build.resultado || build.estado || 'Desconocido';
    }
  }

  // Duración legible ("3m 12s") a partir de inicio/fin -- null si el build
  // no ha terminado o no tiene ambas marcas de tiempo.
  duracion(build: BuildAzure): string | null {
    if (!build.inicio || !build.fin) return null;
    const ms = new Date(build.fin).getTime() - new Date(build.inicio).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const totalSegundos = Math.round(ms / 1000);
    const minutos = Math.floor(totalSegundos / 60);
    const segundos = totalSegundos % 60;
    return minutos > 0 ? `${minutos}m ${segundos}s` : `${segundos}s`;
  }
}
