import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface ItemBarList {
  nombre: string;
  total: number;
  // Texto a mostrar en lugar del número (ej. "3.5 TB"); la barra sigue usando `total`.
  texto?: string;
}

interface ItemBarListCalculado extends ItemBarList {
  porcentajeAncho: number;
}

// Ranking horizontal (ver skill de dataviz: forma "magnitud ordenada" -->
// barras horizontales, nunca un pie/donut para más de ~5 categorías
// ordenadas). Reemplaza las listas de "top responsables/aplicaciones/
// servidores críticos" que antes eran solo texto plano -- ahora cada fila
// también tiene una barra proporcional al máximo del set.
@Component({
  selector: 'app-bar-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './bar-list.component.html',
  styleUrl: './bar-list.component.scss',
})
export class BarListComponent implements OnChanges {
  @Input() items: ItemBarList[] = [];
  @Input() colorVar = 'var(--ax-chart-series-1)';
  // Ancho de la columna del valor (subir si el texto es largo, ej. "25 de 41").
  @Input() anchoValor = '34px';

  itemsCalculados: ItemBarListCalculado[] = [];

  ngOnChanges(_changes: SimpleChanges): void {
    const maximo = Math.max(1, ...this.items.map((i) => i.total));
    this.itemsCalculados = this.items.map((i) => ({
      ...i,
      porcentajeAncho: Math.max(4, Math.round((i.total / maximo) * 100)),
    }));
  }
}
