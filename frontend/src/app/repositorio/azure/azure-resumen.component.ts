import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LineChartComponent, SerieLineaChart } from '../../shared/charts/line-chart.component';
import { DonutChartComponent, SegmentoDonut } from '../../shared/charts/donut-chart.component';
import { BarListComponent, ItemBarList } from '../../shared/charts/bar-list.component';
import { StackedBarChartComponent, SerieBarrasApiladas } from '../../shared/charts/stacked-bar-chart.component';
import { HeatmapComponent } from '../../shared/charts/heatmap.component';
import { AzureBase } from './azure-base';
import { AzureFalloComponent } from './azure-fallo.component';
import { claseGrupo, claseTasa, fmtBytes, fmtDec, fmtDiaCorto, fmtDuracion, fmtNum, fmtPct, fmtRelativo, horaTexto, iniciales, textoGrupo } from './azure-utils';
import { IcoComponent } from '../../shared/ico/ico.component';

@Component({
  selector: 'app-azure-resumen',
  standalone: true,
  imports: [IcoComponent, CommonModule, LineChartComponent, DonutChartComponent, BarListComponent, StackedBarChartComponent, HeatmapComponent, AzureFalloComponent],
  templateUrl: './azure-resumen.component.html',
  styleUrl: './azure-resumen.component.scss',
})
export class AzureResumenComponent extends AzureBase {
  // Pide al módulo que cambie de pestaña (ej. "commits", "pull-requests").
  @Output() irA = new EventEmitter<string>();

  readonly opcionesDias = [7, 30, 60, 90];
  dias = 30;
  datos: any = null;

  readonly fmtNum = fmtNum; readonly fmtDec = fmtDec; readonly fmtPct = fmtPct; readonly fmtDuracion = fmtDuracion; readonly fmtRelativo = fmtRelativo;
  readonly fmtBytes = fmtBytes; readonly claseGrupo = claseGrupo; readonly textoGrupo = textoGrupo; readonly claseTasa = claseTasa; readonly iniciales = iniciales; readonly horaTexto = horaTexto;
  readonly colAutores = Array.from({ length: 24 }, (_, i) => String(i));

  commitsEtq: string[] = [];
  commitsSeries: SerieLineaChart[] = [];
  autores: ItemBarList[] = [];
  heatVals: number[][] = [];
  heatFilas: string[] = [];
  prsEtq: string[] = [];
  prsSeries: SerieBarrasApiladas[] = [];
  buildsEtq: string[] = [];
  buildsSeries: SerieBarrasApiladas[] = [];
  wiEstados: SegmentoDonut[] = [];
  wiTipos: ItemBarList[] = [];
  wiEtq: string[] = [];
  wiSeries: SerieLineaChart[] = [];

  protected alCambiarRepo(): void { this.cargar(); }

  cambiarDias(d: number): void { this.dias = d; this.cargar(); }

  actualizar(): void {
    this.cargando = true;
    this.api.refrescar().subscribe({ next: () => this.cargar(), error: () => this.cargar() });
  }

  cargar(): void {
    this.cargando = true;
    this.fallo = null;
    this.api.get('/resumen', { dias: this.dias }).subscribe({
      next: (d) => { this.datos = d; this.armar(); this.cargando = false; },
      error: (e) => this.fallar(e, 'No se pudo cargar el resumen del repositorio.'),
    });
  }

  private armar(): void {
    const d = this.datos;
    const c = d.commits?.datos?.estadisticas;
    if (c) {
      this.commitsEtq = c.porDia.map((x: any) => fmtDiaCorto(x.fecha));
      this.commitsSeries = [{ nombre: 'Commits', colorVar: 'var(--ax-chart-series-1)', valores: c.porDia.map((x: any) => x.cantidad) }];
      this.autores = c.autores.slice(0, 8).map((a: any) => ({ nombre: a.nombre, total: a.commits }));
      this.heatVals = c.heatmap.matriz;
      this.heatFilas = c.heatmap.filas;
    }
    const p = d.prs?.datos?.estadisticas;
    if (p) {
      this.prsEtq = p.porSemana.map((x: any) => fmtDiaCorto(x.semana));
      this.prsSeries = [
        { nombre: 'Creados', colorVar: 'var(--ax-chart-series-1)', valores: p.porSemana.map((x: any) => x.creados) },
        { nombre: 'Completados', colorVar: 'var(--ax-chart-ok)', valores: p.porSemana.map((x: any) => x.completados) },
      ];
    }
    const b = d.builds?.datos?.estadisticas;
    if (b) {
      this.buildsEtq = b.porDia.map((x: any) => fmtDiaCorto(x.fecha));
      this.buildsSeries = [
        { nombre: 'Exitosos', colorVar: 'var(--ax-chart-ok)', valores: b.porDia.map((x: any) => x.exitosos) },
        { nombre: 'Fallidos', colorVar: 'var(--ax-chart-danger)', valores: b.porDia.map((x: any) => x.fallidos) },
        { nombre: 'Otros', colorVar: 'var(--ax-chart-warn)', valores: b.porDia.map((x: any) => x.otros) },
      ];
    }
    const w = d.workItems?.datos?.estadisticas;
    if (w) {
      const colores = ['var(--ax-chart-series-1)', 'var(--ax-chart-series-2)', 'var(--ax-chart-ok)', 'var(--ax-chart-warn)', 'var(--ax-chart-danger)'];
      this.wiEstados = w.porEstado.slice(0, 5).map((x: any, i: number) => ({ etiqueta: x.nombre, valor: x.cantidad, colorVar: colores[i % colores.length] }));
      this.wiTipos = w.porTipo.slice(0, 8).map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
      this.wiEtq = w.porSemana.map((x: any) => fmtDiaCorto(x.semana));
      this.wiSeries = [
        { nombre: 'Creados', colorVar: 'var(--ax-chart-series-1)', valores: w.porSemana.map((x: any) => x.creados) },
        { nombre: 'Cerrados', colorVar: 'var(--ax-chart-ok)', valores: w.porSemana.map((x: any) => x.cerrados) },
      ];
    }
  }

  barraBuilds(grupos: Record<string, number>): { clase: string; n: number }[] {
    return [
      { clase: 's-ok', n: grupos['exitoso'] || 0 }, { clase: 's-aviso', n: (grupos['parcial'] || 0) + (grupos['cancelado'] || 0) },
      { clase: 's-mal', n: grupos['fallido'] || 0 }, { clase: 's-info', n: (grupos['enCurso'] || 0) + (grupos['enCola'] || 0) },
    ].filter((x) => x.n > 0);
  }
}
