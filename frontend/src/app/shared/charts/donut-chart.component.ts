import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

// Un segmento del donut (ver DonutChartComponent). "colorVar" es una
// variable CSS lista para usar, ej. "var(--ax-chart-ok)" -- mismo criterio
// que en LineChartComponent: el color sigue el tema claro/oscuro solo.
export interface SegmentoDonut {
  etiqueta: string;
  valor: number;
  colorVar: string;
}

interface SegmentoCalculado extends SegmentoDonut {
  porcentaje: number;
  dashArray: string;
  dashOffset: number;
}

// Donut SVG de distribución (ver skill de dataviz: forma "parte de un
// todo", máximo unos pocos segmentos, colores de ESTADO nunca reciclados
// para otra cosa, franja de 2px de separación entre segmentos, leyenda con
// etiqueta directa -- nunca solo color). Pensado sobre todo para
// distribuciones de estado (Vigente/Por vencer/Vencido y equivalentes en
// otros informes), pero sirve para cualquier reparto de pocas categorías.
@Component({
  selector: 'app-donut-chart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './donut-chart.component.html',
  styleUrl: './donut-chart.component.scss',
})
export class DonutChartComponent implements OnChanges {
  @Input() segmentos: SegmentoDonut[] = [];
  @Input() centroEtiqueta = 'Total';

  readonly radio = 60;
  readonly grosor = 22;
  readonly circunferencia = 2 * Math.PI * this.radio;

  segmentosCalculados: SegmentoCalculado[] = [];
  total = 0;

  ngOnChanges(_changes: SimpleChanges): void {
    this.total = this.segmentos.reduce((acc, s) => acc + (s.valor || 0), 0);
    let acumulado = 0;
    // Separación visual de 2px entre segmentos (ver marks-and-anatomy.md) —
    // se resta del arco de cada segmento como un pequeño hueco fijo, no
    // proporcional, así se ve igual sin importar el tamaño del segmento.
    const huecoPx = 2;
    this.segmentosCalculados = this.segmentos
      .filter((s) => s.valor > 0)
      .map((s) => {
        const porcentaje = this.total > 0 ? (s.valor / this.total) * 100 : 0;
        const largoArco = Math.max(0, (porcentaje / 100) * this.circunferencia - huecoPx);
        const dashArray = `${largoArco} ${this.circunferencia - largoArco}`;
        const dashOffset = -((acumulado / 100) * this.circunferencia);
        acumulado += porcentaje;
        return { ...s, porcentaje, dashArray, dashOffset };
      });
  }
}
