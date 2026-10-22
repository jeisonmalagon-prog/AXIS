import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-historico-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './historico-list.component.html',
  styleUrl: './historico-list.component.scss',
})
export class HistoricoListComponent implements OnInit {
  historicos: any[] = [];
  cargando = true;
  errorCarga = '';
  terminoBusqueda: string = '';

  private apiUrl = `${environment.apiUrl}/historico`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando = true;
    this.errorCarga = '';
    this.http.get<any[]>(this.apiUrl).subscribe({
      next: (data) => {
        this.historicos = Array.isArray(data) ? data : [];
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al cargar el historial', err);
        const detalle = err?.error?.error || err?.message || 'Error desconocido';
        this.errorCarga = `No se pudo cargar el histórico (HTTP ${err?.status ?? '?'}): ${detalle}`;
        this.cargando = false;
      }
    });
  }

  // --- Filtro Global ---
  get historicosFiltrados(): any[] {
    if (!this.terminoBusqueda) return this.historicos;
    
    const termino = this.terminoBusqueda.toLowerCase().trim();
    return this.historicos.filter(h => {
      const datosFila = JSON.stringify(h).toLowerCase();
      return datosFila.includes(termino);
    });
  }
}