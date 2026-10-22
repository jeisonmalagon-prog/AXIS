import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

interface Barra { alto: number; pctFallo: number; titulo: string; }

// Mini barras de actividad (una por intervalo); la parte roja son los fallos.
// Sirve para ver de un vistazo el ritmo de un flujo dentro de una tarjeta.
@Component({
  selector: 'app-sparkline',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="sp" [style.height.px]="alto" role="img" [attr.aria-label]="descripcion">
      <span class="sp-b" *ngFor="let b of barras" [title]="b.titulo">
        <span class="sp-p" [style.height.%]="b.alto"><span class="sp-f" *ngIf="b.pctFallo" [style.height.%]="b.pctFallo"></span></span>
      </span>
    </div>`,
  styles: [`
    :host { display: block; }
    .sp { display: flex; align-items: flex-end; gap: 2px; width: 100%; }
    .sp-b { flex: 1 1 0; min-width: 2px; height: 100%; display: flex; align-items: flex-end; background: var(--ax-surface-2, #f8fafc); border-radius: 2px 2px 0 0; }
    .sp-p { width: 100%; min-height: 0; background: var(--ax-chart-ok, #10b981); border-radius: 2px 2px 0 0; display: flex; align-items: flex-end; overflow: hidden; }
    .sp-f { width: 100%; background: var(--ax-chart-danger, #ef4444); }
  `],
})
export class SparklineComponent implements OnChanges {
  @Input() valores: number[] = [];
  @Input() fallos: number[] = [];
  @Input() alto = 34;

  barras: Barra[] = [];
  descripcion = '';

  ngOnChanges(_c: SimpleChanges): void {
    const max = Math.max(1, ...this.valores);
    this.barras = this.valores.map((v, i) => {
      const f = Math.min(this.fallos[i] || 0, v);
      return {
        alto: v ? Math.max(8, (v / max) * 100) : 0,
        pctFallo: v && f ? Math.max(15, (f / v) * 100) : 0,
        titulo: `${v} ejecuciones${f ? `, ${f} fallidas` : ''}`,
      };
    });
    const total = this.valores.reduce((s, v) => s + v, 0);
    this.descripcion = `Actividad: ${total} ejecuciones en el periodo`;
  }
}
