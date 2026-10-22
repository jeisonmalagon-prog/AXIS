import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { marked } from 'marked';
import { environment } from '../../../environments/environment';
import { IcoComponent } from '../../shared/ico/ico.component';

export interface PaginaWiki {
  path: string;
  nombre: string;
  nivel: number;
  tieneHijas: boolean;
}

export interface ContenidoWiki {
  path: string;
  titulo: string;
  contenido: string;
  url: string;
}

@Component({
  selector: 'app-repo-wiki',
  standalone: true,
  imports: [IcoComponent, CommonModule],
  templateUrl: './wiki.component.html',
  styleUrl: './wiki.component.scss',
})
export class RepoWikiComponent implements OnInit {
  cargandoArbol = false;
  errorArbol = '';
  nombreWiki = '';
  paginas: PaginaWiki[] = [];

  cargandoContenido = false;
  errorContenido = '';
  pathActivo: string | null = null;
  contenido: ContenidoWiki | null = null;
  contenidoHtml = '';

  private endpoint = `${environment.apiUrl}/azure-repo`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.cargarArbol();
  }

  cargarArbol(): void {
    this.cargandoArbol = true;
    this.errorArbol = '';

    this.http
      .get<{ wiki: string; paginas: PaginaWiki[] }>(`${this.endpoint}/wiki/estructura`)
      .subscribe({
        next: (data) => {
          this.nombreWiki = data.wiki || 'Wiki';
          this.paginas = data.paginas || [];
          this.cargandoArbol = false;
          // Abre automáticamente la primera página (usualmente "Home") para
          // que el panel de contenido no arranque vacío.
          if (this.paginas.length) {
            this.abrirPagina(this.paginas[0].path);
          }
        },
        error: (err) => {
          this.errorArbol = err.error?.error || 'No se pudo cargar el wiki del proyecto.';
          this.cargandoArbol = false;
        },
      });
  }

  abrirPagina(path: string): void {
    this.pathActivo = path;
    this.cargandoContenido = true;
    this.errorContenido = '';
    this.contenido = null;
    this.contenidoHtml = '';

    this.http
      .get<ContenidoWiki>(`${this.endpoint}/wiki/contenido`, { params: { path } })
      .subscribe({
        next: (data) => {
          this.contenido = data;
          try {
            this.contenidoHtml = marked.parse(data.contenido || '', { async: false }) as string;
          } catch (e) {
            console.error('Error al interpretar el markdown del wiki', e);
            this.contenidoHtml = '';
            this.errorContenido = 'No se pudo interpretar el contenido de esta página.';
          }
          this.cargandoContenido = false;
        },
        error: (err) => {
          this.errorContenido = err.error?.error || 'No se pudo cargar esta página del wiki.';
          this.cargandoContenido = false;
        },
      });
  }
}
