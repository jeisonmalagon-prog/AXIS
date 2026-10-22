import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

interface Celda { valor: number; opacidad: number; }

// Mapa de calor (ver skill de dataviz: magnitud en dos dimensiones, UN solo
// tono de claro a oscuro). Filas = p. ej. día de la semana, columnas = hora.
@Component({
  selector: 'app-heatmap',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './heatmap.component.html',
  styleUrl: './heatmap.component.scss',
})
export class HeatmapComponent implements OnChanges {
  @Input() filas: string[] = [];
  @Input() columnas: string[] = [];
  @Input() valores: number[][] = [];
  @Input() colorVar = 'var(--ax-chart-series-1)';
  @Input() unidad = 'ejecuciones';

  celdas: Celda[][] = [];
  maximo = 0;
  sinDatos = true;
  foco: { fila: string; columna: string; valor: number } | null = null;

  ngOnChanges(_c: SimpleChanges): void {
    this.maximo = Math.max(0, ...this.valores.flat());
    this.sinDatos = this.maximo === 0;
    this.celdas = this.valores.map((fila) => fila.map((valor) => ({
      valor,
      opacidad: valor === 0 ? 0 : 0.18 + 0.82 * (valor / this.maximo),
    })));
  }

  enfocar(f: number, c: number): void { this.foco = { fila: this.filas[f], columna: this.columnas[c], valor: this.valores[f][c] }; }
  soltar(): void { this.foco = null; }

  mostrarColumna(c: number): boolean { return c % 3 === 0; }
}
