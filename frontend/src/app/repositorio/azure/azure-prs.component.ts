import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StackedBarChartComponent, SerieBarrasApiladas } from '../../shared/charts/stacked-bar-chart.component';
import { BarListComponent, ItemBarList } from '../../shared/charts/bar-list.component';
import { AzureBase } from './azure-base';
import { AzureFalloComponent } from './azure-fallo.component';
import { AzureDiffComponent, DiffArchivo } from './azure-diff.component';
import { FalloAzure, descargarCsv, falloDe, fmtDiaCorto, fmtFecha, fmtPct, fmtRelativo, iniciales } from './azure-utils';
import { IcoComponent } from '../../shared/ico/ico.component';

type VistaPr = 'resumen' | 'archivos' | 'commits' | 'conversaciones';

@Component({
  selector: 'app-azure-prs',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule, AzureFalloComponent, AzureDiffComponent, StackedBarChartComponent, BarListComponent],
  templateUrl: './azure-prs.component.html',
  styleUrl: './azure-prs.component.scss',
})
export class AzurePrsComponent extends AzureBase {
  readonly fmtFecha = fmtFecha; readonly fmtRelativo = fmtRelativo; readonly iniciales = iniciales; readonly fmtPct = fmtPct;

  estado = 'active'; texto = ''; autor = ''; destino = ''; dias = '';
  pagina = 1;
  readonly limite = 25;
  prs: any[] = [];
  hayMas = false;
  ramas: string[] = [];

  // Estadísticas (se cargan al abrir el panel)
  verEstadisticas = false;
  estCargando = false;
  est: any = null;
  estFallo: FalloAzure | null = null;
  estEtq: string[] = [];
  estSeries: SerieBarrasApiladas[] = [];
  estAutores: ItemBarList[] = [];

  // Detalle
  abierto: any = null;
  vista: VistaPr = 'resumen';
  detalle: any = null;
  detalleCargando = false;
  detalleFallo: FalloAzure | null = null;
  archivoAbierto: string | null = null;
  diff: DiffArchivo | null = null;
  diffCargando = false;
  diffFallo: FalloAzure | null = null;

  protected alCambiarRepo(): void {
    this.pagina = 1;
    this.api.get<any>('/ramas').subscribe({ next: (r) => (this.ramas = r.ramas.map((x: any) => x.nombre)), error: () => (this.ramas = []) });
    this.cargar();
    if (this.verEstadisticas) this.cargarEstadisticas();
  }

  filtrar(): void { this.pagina = 1; this.cargar(); }
  limpiar(): void { this.texto = this.autor = this.destino = this.dias = ''; this.estado = 'active'; this.filtrar(); }
  cambiarPagina(d: number): void { this.pagina = Math.max(1, this.pagina + d); this.cargar(); }

  cargar(): void {
    this.cargando = true; this.fallo = null;
    this.api.get<any>('/prs', { estado: this.estado, texto: this.texto.trim(), autor: this.autor.trim(), destino: this.destino, dias: this.dias, pagina: this.pagina, limite: this.limite }).subscribe({
      next: (r) => { this.prs = r.prs; this.hayMas = r.hayMas; this.cargando = false; },
      error: (e) => this.fallar(e, 'No se pudieron cargar los pull requests.'),
    });
  }

  alternarEstadisticas(): void {
    this.verEstadisticas = !this.verEstadisticas;
    if (this.verEstadisticas && !this.est) this.cargarEstadisticas();
  }

  cargarEstadisticas(): void {
    this.estCargando = true; this.estFallo = null;
    this.api.get<any>('/estadisticas/codigo', { dias: 90 }).subscribe({
      next: (r) => {
        this.estCargando = false;
        if (r.prs?.error) { this.estFallo = { error: r.prs.error, codigo: r.prs.codigo, permisoRequerido: r.prs.permisoRequerido }; return; }
        this.est = r.prs.datos;
        this.estEtq = this.est.porSemana.map((x: any) => fmtDiaCorto(x.semana));
        this.estSeries = [
          { nombre: 'Creados', colorVar: 'var(--ax-chart-series-1)', valores: this.est.porSemana.map((x: any) => x.creados) },
          { nombre: 'Completados', colorVar: 'var(--ax-chart-ok)', valores: this.est.porSemana.map((x: any) => x.completados) },
        ];
        this.estAutores = this.est.porAutor.map((a: any) => ({ nombre: a.nombre, total: a.cantidad }));
      },
      error: (e) => { this.estFallo = falloDe(e, 'No se pudieron calcular las estadísticas.'); this.estCargando = false; },
    });
  }

  exportar(): void {
    descargarCsv('pull-requests.csv', [
      ['#', 'Título', 'Estado', 'Autor', 'Origen', 'Destino', 'Creado', 'Cerrado', 'Horas abierto', 'Aprobaciones', 'Revisores'],
      ...this.prs.map((p) => [p.id, p.titulo, p.estado, p.autor, p.ramaOrigen, p.ramaDestino, p.creado, p.cerrado, p.horasAbierto, p.resumenRevision.aprobados, p.resumenRevision.total]),
    ]);
  }

  abrir(p: any): void {
    this.abierto = p; this.vista = 'resumen'; this.detalle = null; this.detalleFallo = null; this.detalleCargando = true; this.archivoAbierto = null; this.diff = null;
    this.api.get<any>(`/prs/${p.id}`).subscribe({
      next: (d) => { this.detalle = d; this.detalleCargando = false; },
      error: (e) => { this.detalleFallo = falloDe(e, 'No se pudo cargar el pull request.'); this.detalleCargando = false; },
    });
  }
  cerrar(): void { this.abierto = null; this.detalle = null; this.diff = null; }

  verDiff(a: any): void {
    if (this.archivoAbierto === a.ruta) { this.archivoAbierto = null; this.diff = null; return; }
    this.archivoAbierto = a.ruta; this.diff = null; this.diffFallo = null; this.diffCargando = true;
    this.api.get<DiffArchivo>(`/prs/${this.abierto.id}/diff`, { ruta: a.ruta, rutaAnterior: a.rutaAnterior || '' }).subscribe({
      next: (d) => { this.diff = d; this.diffCargando = false; },
      error: (e) => { this.diffFallo = falloDe(e, 'No se pudo calcular la diferencia.'); this.diffCargando = false; },
    });
  }

  claseEstadoPr(p: any): string { return p.estado === 'completed' ? 'est-ok' : p.estado === 'abandoned' ? 'est-nulo' : 'est-info'; }
  textoEstadoPr(p: any): string { return p.estado === 'completed' ? 'Completado' : p.estado === 'abandoned' ? 'Abandonado' : (p.esBorrador ? 'Borrador' : 'Activo'); }
  claseVoto(v: number): string { return v >= 5 ? 'est-ok' : v <= -5 ? 'est-mal' : 'est-nulo'; }
  clasePolitica(s: string): string { return s === 'approved' ? 'est-ok' : s === 'rejected' || s === 'broken' ? 'est-mal' : s === 'running' || s === 'queued' ? 'est-info' : 'est-nulo'; }
  textoPolitica(s: string): string { return ({ approved: 'Cumplida', rejected: 'No cumplida', running: 'Evaluando', queued: 'En cola', notApplicable: 'No aplica', broken: 'Con error' } as Record<string, string>)[s] || s; }
  claseTipo(t: string): string { return t === 'agregado' ? 'chip-ok' : t === 'eliminado' ? 'chip-alta' : t === 'renombrado' ? 'chip-marca' : ''; }
  horas(h: number | null): string { if (h === null || h === undefined) return '—'; return h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; }
}
