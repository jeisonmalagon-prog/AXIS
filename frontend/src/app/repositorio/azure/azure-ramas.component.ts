import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LineChartComponent, SerieLineaChart } from '../../shared/charts/line-chart.component';
import { HeatmapComponent } from '../../shared/charts/heatmap.component';
import { AzureBase } from './azure-base';
import { AzureFalloComponent } from './azure-fallo.component';
import { AzureDiffComponent, DiffArchivo } from './azure-diff.component';
import { FalloAzure, descargarCsv, falloDe, fmtDec, fmtDiaCorto, fmtFecha, fmtNum, fmtRelativo, horaTexto } from './azure-utils';
import { IcoComponent } from '../../shared/ico/ico.component';

type SubVista = 'ramas' | 'tags' | 'comparar' | 'pushes' | 'actividad';

@Component({
  selector: 'app-azure-ramas',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule, AzureFalloComponent, AzureDiffComponent, LineChartComponent, HeatmapComponent],
  templateUrl: './azure-ramas.component.html',
  styleUrl: './azure-ramas.component.scss',
})
export class AzureRamasComponent extends AzureBase {
  // Pide explorar los archivos de una rama (la pestaña Archivos de este módulo).
  @Output() ramaSeleccionada = new EventEmitter<string>();

  readonly fmtFecha = fmtFecha; readonly fmtRelativo = fmtRelativo; readonly fmtNum = fmtNum; readonly fmtDec = fmtDec; readonly horaTexto = horaTexto;
  readonly colHoras = Array.from({ length: 24 }, (_, i) => String(i));

  vista: SubVista = 'ramas';
  filtro = ''; soloAntiguas = false;

  ramas: any = null;
  tags: any = null;
  pushes: any = null;
  actividad: any = null;
  cargandoVista = false;
  falloVista: FalloAzure | null = null;

  // Comparar (valores "branch:nombre" / "tag:nombre")
  base = ''; destino = '';
  comparacion: any = null;
  compCargando = false;
  compFallo: FalloAzure | null = null;
  archivoAbierto: string | null = null;
  diff: DiffArchivo | null = null;
  diffCargando = false;
  diffFallo: FalloAzure | null = null;

  // Actividad
  dias = 30;
  actEtq: string[] = [];
  actSeries: SerieLineaChart[] = [];

  protected alCambiarRepo(): void {
    this.ramas = this.tags = this.pushes = this.actividad = this.comparacion = null;
    this.cargarVista();
  }

  cambiarVista(v: SubVista): void { this.vista = v; this.cargarVista(); }

  cargarVista(): void {
    this.falloVista = null;
    const v = this.vista;
    if (v === 'ramas' || v === 'comparar') { if (!this.ramas) this.pedir('/ramas', {}, (r) => (this.ramas = r)); }
    if (v === 'tags' || v === 'comparar') { if (!this.tags) this.pedir('/tags', {}, (r) => (this.tags = r)); }
    if (v === 'pushes' && !this.pushes) this.pedir('/pushes', { limite: 60 }, (r) => (this.pushes = r));
    if (v === 'actividad' && !this.actividad) this.cargarActividad();
  }

  private pedir(ruta: string, params: Record<string, any>, ok: (r: any) => void): void {
    this.cargandoVista = true;
    this.api.get<any>(ruta, params).subscribe({
      next: (r) => { ok(r); this.cargandoVista = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudo cargar la información.'); this.cargandoVista = false; },
    });
  }

  cambiarDias(d: number): void { this.dias = d; this.actividad = null; this.cargarActividad(); }

  cargarActividad(): void {
    this.cargandoVista = true;
    this.api.get<any>('/estadisticas/codigo', { dias: this.dias }).subscribe({
      next: (r) => {
        this.cargandoVista = false;
        if (r.commits?.error) { this.falloVista = { error: r.commits.error, codigo: r.commits.codigo, permisoRequerido: r.commits.permisoRequerido }; return; }
        this.actividad = r.commits.datos;
        this.actEtq = this.actividad.porDia.map((x: any) => fmtDiaCorto(x.fecha));
        this.actSeries = [{ nombre: 'Commits', colorVar: 'var(--ax-chart-series-1)', valores: this.actividad.porDia.map((x: any) => x.cantidad) }];
      },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudo calcular la actividad.'); this.cargandoVista = false; },
    });
  }

  get ramasFiltradas(): any[] {
    if (!this.ramas) return [];
    const t = this.filtro.trim().toLowerCase();
    return this.ramas.ramas.filter((r: any) => (!t || r.nombre.toLowerCase().includes(t)) && (!this.soloAntiguas || r.antigua));
  }

  exportarRamas(): void {
    descargarCsv('ramas.csv', [['Rama', 'Adelante', 'Atrás', 'Creador', 'Último autor', 'Último cambio', 'Días sin actividad'],
      ...this.ramasFiltradas.map((r) => [r.nombre, r.adelante, r.atras, r.creador, r.commit?.autor ?? '', r.commit?.fecha ?? '', r.diasSinActividad])]);
  }

  compararCon(rama: string): void {
    this.base = `branch:${this.ramas.ramaPorDefecto}`; this.destino = `branch:${rama}`;
    this.cambiarVista('comparar'); this.comparar();
  }

  private partir(v: string): { valor: string; tipo: string } {
    const i = v.indexOf(':');
    return { tipo: v.substring(0, i), valor: v.substring(i + 1) };
  }

  comparar(): void {
    if (!this.base || !this.destino) return;
    const b = this.partir(this.base); const d = this.partir(this.destino);
    this.compCargando = true; this.compFallo = null; this.comparacion = null; this.archivoAbierto = null; this.diff = null;
    this.api.get<any>('/comparar', { base: b.valor, baseTipo: b.tipo, destino: d.valor, destinoTipo: d.tipo }).subscribe({
      next: (r) => { this.comparacion = r; this.compCargando = false; },
      error: (e) => { this.compFallo = falloDe(e, 'No se pudo comparar.'); this.compCargando = false; },
    });
  }

  verDiff(a: any): void {
    if (this.archivoAbierto === a.ruta) { this.archivoAbierto = null; this.diff = null; return; }
    const b = this.partir(this.base); const d = this.partir(this.destino);
    this.archivoAbierto = a.ruta; this.diff = null; this.diffFallo = null; this.diffCargando = true;
    this.api.get<DiffArchivo>('/comparar/diff', { base: b.valor, baseTipo: b.tipo, destino: d.valor, destinoTipo: d.tipo, ruta: a.ruta, rutaAnterior: a.rutaAnterior || '' }).subscribe({
      next: (r) => { this.diff = r; this.diffCargando = false; },
      error: (e) => { this.diffFallo = falloDe(e, 'No se pudo calcular la diferencia.'); this.diffCargando = false; },
    });
  }

  claseTipo(t: string): string { return t === 'agregado' ? 'chip-ok' : t === 'eliminado' ? 'chip-alta' : t === 'renombrado' ? 'chip-marca' : ''; }
}
