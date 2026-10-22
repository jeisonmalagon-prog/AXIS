import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AzureBase } from './azure-base';
import { AzureFalloComponent } from './azure-fallo.component';
import { AzureDiffComponent, DiffArchivo } from './azure-diff.component';
import { FalloAzure, descargarCsv, falloDe, fmtFecha, fmtRelativo, iniciales } from './azure-utils';
import { IcoComponent } from '../../shared/ico/ico.component';

@Component({
  selector: 'app-azure-commits',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule, AzureFalloComponent, AzureDiffComponent],
  templateUrl: './azure-commits.component.html',
  styleUrl: './azure-commits.component.scss',
})
export class AzureCommitsComponent extends AzureBase {
  readonly fmtFecha = fmtFecha; readonly fmtRelativo = fmtRelativo; readonly iniciales = iniciales;

  // Filtros
  texto = ''; autor = ''; ruta = ''; desde = ''; hasta = ''; rama = '';
  ramas: string[] = [];
  pagina = 1;
  readonly limite = 30;

  commits: any[] = [];
  hayMas = false;
  ramaUsada = '';

  // Detalle
  abierto: any = null;
  detalle: any = null;
  detalleCargando = false;
  detalleFallo: FalloAzure | null = null;
  archivoAbierto: string | null = null;
  diff: DiffArchivo | null = null;
  diffCargando = false;
  diffFallo: FalloAzure | null = null;

  protected alCambiarRepo(): void {
    this.rama = ''; this.pagina = 1;
    this.api.get<any>('/ramas').subscribe({ next: (r) => (this.ramas = r.ramas.map((x: any) => x.nombre)), error: () => (this.ramas = []) });
    this.cargar();
  }

  filtrar(): void { this.pagina = 1; this.cargar(); }

  limpiar(): void { this.texto = this.autor = this.ruta = this.desde = this.hasta = ''; this.filtrar(); }

  cambiarPagina(delta: number): void { this.pagina = Math.max(1, this.pagina + delta); this.cargar(); }

  cargar(): void {
    this.cargando = true; this.fallo = null;
    this.api.get<any>('/commits', {
      texto: this.texto.trim(), autor: this.autor.trim(), ruta: this.ruta.trim(), rama: this.rama, pagina: this.pagina, limite: this.limite,
      desde: this.desde ? new Date(this.desde + 'T00:00:00').toISOString() : '',
      hasta: this.hasta ? new Date(this.hasta + 'T23:59:59').toISOString() : '',
    }).subscribe({
      next: (r) => { this.commits = r.commits; this.hayMas = r.hayMas; this.ramaUsada = r.rama; this.cargando = false; },
      error: (e) => this.fallar(e, 'No se pudieron cargar los commits.'),
    });
  }

  exportar(): void {
    descargarCsv(`commits-${this.ramaUsada}.csv`, [
      ['Commit', 'Mensaje', 'Autor', 'Fecha', 'Agregados', 'Editados', 'Eliminados'],
      ...this.commits.map((c) => [c.id, c.comentario, c.autor, c.fecha, c.cambios?.agregados ?? '', c.cambios?.editados ?? '', c.cambios?.eliminados ?? '']),
    ]);
  }

  abrir(c: any): void {
    this.abierto = c; this.detalle = null; this.detalleFallo = null; this.detalleCargando = true; this.archivoAbierto = null; this.diff = null;
    this.api.get<any>(`/commits/${c.id}`).subscribe({
      next: (d) => { this.detalle = d; this.detalleCargando = false; },
      error: (e) => { this.detalleFallo = falloDe(e, 'No se pudo cargar el commit.'); this.detalleCargando = false; },
    });
  }

  cerrar(): void { this.abierto = null; this.detalle = null; this.diff = null; }

  verDiff(a: any): void {
    if (this.archivoAbierto === a.ruta) { this.archivoAbierto = null; this.diff = null; return; }
    this.archivoAbierto = a.ruta; this.diff = null; this.diffFallo = null; this.diffCargando = true;
    this.api.get<DiffArchivo>(`/commits/${this.abierto.id}/diff`, { ruta: a.ruta, rutaAnterior: a.rutaAnterior || '' }).subscribe({
      next: (d) => { this.diff = d; this.diffCargando = false; },
      error: (e) => { this.diffFallo = falloDe(e, 'No se pudo calcular la diferencia.'); this.diffCargando = false; },
    });
  }

  claseTipo(t: string): string { return t === 'agregado' ? 'chip-ok' : t === 'eliminado' ? 'chip-alta' : t === 'renombrado' ? 'chip-marca' : ''; }
}
