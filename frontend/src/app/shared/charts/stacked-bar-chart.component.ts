import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface SerieBarrasApiladas {
  nombre: string;
  // Variable CSS completa, ej. "var(--ax-chart-ok)": se recalcula sola con el tema.
  colorVar: string;
  valores: number[];
}

interface Segmento { color: string; valor: number; nombre: string; }
interface Columna { etiqueta: string; total: number; pctAlto: number; segmentos: Segmento[]; }

// Barras apiladas (ver skill de dataviz: forma "composición de una magnitud en
// el tiempo"). Marcas finas con 2 px de separación entre segmentos, extremo
// superior redondeado, cuadrícula recesiva y tooltip al pasar el mouse. Se
// dibuja con HTML/CSS (no SVG escalado) para que el texto no se deforme.
//
//   <app-stacked-bar-chart [etiquetas]="..." [series]="[{nombre, colorVar, valores}]"></app-stacked-bar-chart>
@Component({
  selector: 'app-stacked-bar-chart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './stacked-bar-chart.component.html',
  styleUrl: './stacked-bar-chart.component.scss',
})
export class StackedBarChartComponent implements OnChanges {
  @Input() etiquetas: string[] = [];
  @Input() series: SerieBarrasApiladas[] = [];
  @Input() alto = 190;
  // Texto bajo el tooltip (ej. "ejecuciones")
  @Input() unidad = '';

  columnas: Columna[] = [];
  grid: { valor: number; pct: number }[] = [];
  sinDatos = true;
  hover: number | null = null;

  ngOnChanges(_c: SimpleChanges): void {
    const n = this.etiquetas.length;
    const totales = this.etiquetas.map((_, i) => this.series.reduce((s, x) => s + (x.valores[i] || 0), 0));
    this.sinDatos = n === 0 || totales.every((t) => !t);
    const maximo = this.techo(Math.max(1, ...totales));
    this.columnas = this.etiquetas.map((etiqueta, i) => ({
      etiqueta,
      total: totales[i],
      pctAlto: (totales[i] / maximo) * 100,
      segmentos: this.series.map((s) => ({ color: s.colorVar, valor: s.valores[i] || 0, nombre: s.nombre })).filter((s) => s.valor > 0),
    }));
    const pasos = 4;
    this.grid = Array.from({ length: pasos + 1 }, (_, k) => ({ valor: Math.round((maximo * k) / pasos), pct: (k / pasos) * 100 }));
  }

  // Techo "redondo" divisible por 4 para que la cuadrícula no muestre números feos.
  private techo(v: number): number {
    if (v <= 4) return 4;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    const t = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 4 ? 4 : norm <= 8 ? 8 : 10;
    return t * mag;
  }

  mostrarEtiqueta(i: number): boolean {
    const n = this.etiquetas.length;
    if (n <= 12) return true;
    const salto = Math.ceil(n / 12);
    return i % salto === 0 || i === n - 1;
  }

  // Tooltip a la izquierda en la segunda mitad para que no se salga del área.
  get tooltipALaIzquierda(): boolean {
    return this.hover !== null && this.hover > this.columnas.length / 2;
  }
}
