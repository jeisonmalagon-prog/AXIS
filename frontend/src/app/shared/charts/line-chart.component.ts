import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

// Una serie de la gráfica de tendencia (ver LineChartComponent). "colorVar"
// es una variable CSS completa lista para usar en un atributo SVG, ej.
// "var(--ax-chart-series-1)" -- así el color se recalcula solo si cambia el
// tema claro/oscuro (ver :root/.dark-theme en styles.scss), sin que este
// componente tenga que saber nada de temas.
export interface SerieLineaChart {
  nombre: string;
  colorVar: string;
  valores: number[];
}

interface PuntoRuta {
  x: number;
  y: number;
  valor: number;
}

// Gráfica de líneas SVG, sin dependencias externas (ver skill de dataviz:
// forma "tendencia", color por variable CSS del sistema, marcas de 2px con
// puntos redondeados, cuadrícula recesiva, tooltip con crosshair al pasar
// el mouse). Pensada para reutilizarse en cualquier informe que tenga una
// serie temporal (Certificados, Servidores, Aplicaciones, Apuntamientos,
// F5, General) -- solo cambia qué "series" y "etiquetas" le pasa cada uno.
//
// Uso: el componente que arma el informe expone getters con la forma que
// pide este chart, ej. `get seriesTendencia(): SerieLineaChart[]`, y el
// template solo hace:
//   <app-line-chart [etiquetas]="etiquetasTendencia" [series]="seriesTendencia"></app-line-chart>
@Component({
  selector: 'app-line-chart',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './line-chart.component.html',
  styleUrl: './line-chart.component.scss',
})
export class LineChartComponent implements OnChanges {
  @Input() etiquetas: string[] = [];

  // Muestra a lo sumo ~8 etiquetas en el eje X (antes: una de cada dos), para series largas.
  get saltoEtiquetas(): number {
    return Math.max(2, Math.ceil(this.etiquetas.length / 8));
  }
  @Input() series: SerieLineaChart[] = [];

  // Viewbox fijo; el <svg> escala solo vía width:100% en el CSS, así que
  // estas unidades son "unidades de dibujo", no píxeles reales en pantalla.
  readonly ancho = 600;
  readonly alto = 220;
  readonly margen = { arriba: 16, abajo: 28, izquierda: 8, derecha: 8 };

  rutasPorSerie: { nombre: string; colorVar: string; puntos: PuntoRuta[]; d: string }[] = [];
  lineasGrid: { y: number; valor: number }[] = [];
  posicionesX: number[] = [];
  indiceHover: number | null = null;
  sinDatos = false;

  ngOnChanges(_changes: SimpleChanges): void {
    this.calcular();
  }

  private calcular(): void {
    const n = this.etiquetas.length;
    this.sinDatos = n === 0 || this.series.every((s) => s.valores.every((v) => !v));
    if (n === 0) {
      this.rutasPorSerie = [];
      this.lineasGrid = [];
      this.posicionesX = [];
      return;
    }

    const anchoUtil = this.ancho - this.margen.izquierda - this.margen.derecha;
    const altoUtil = this.alto - this.margen.arriba - this.margen.abajo;

    const maximoDatos = Math.max(1, ...this.series.flatMap((s) => s.valores));
    // Techo "redondo" para que la cuadrícula no muestre números feos tipo 7, 13...
    const maximo = this.techoRedondo(maximoDatos);

    this.posicionesX = this.etiquetas.map((_, i) =>
      n === 1 ? this.margen.izquierda + anchoUtil / 2 : this.margen.izquierda + (anchoUtil * i) / (n - 1)
    );

    const escalarY = (valor: number) => this.margen.arriba + altoUtil - (valor / maximo) * altoUtil;

    this.rutasPorSerie = this.series.map((serie) => {
      const puntos: PuntoRuta[] = serie.valores.map((valor, i) => ({
        x: this.posicionesX[i],
        y: escalarY(valor),
        valor,
      }));
      const d = puntos.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      return { nombre: serie.nombre, colorVar: serie.colorVar, puntos, d };
    });

    // 4 líneas de cuadrícula horizontales (0, 1/3, 2/3, máximo) -- recesivas,
    // ver marks-and-anatomy.md.
    const pasos = 3;
    this.lineasGrid = Array.from({ length: pasos + 1 }, (_, i) => {
      const valor = Math.round((maximo * i) / pasos);
      return { y: escalarY(valor), valor };
    });
  }

  private techoRedondo(valor: number): number {
    if (valor <= 5) return 5;
    const magnitud = Math.pow(10, Math.floor(Math.log10(valor)));
    const normalizado = valor / magnitud;
    let techo: number;
    if (normalizado <= 1) techo = 1;
    else if (normalizado <= 2) techo = 2;
    else if (normalizado <= 5) techo = 5;
    else techo = 10;
    return techo * magnitud;
  }

  alMoverMouse(evento: MouseEvent, svgEl: Element): void {
    if (!this.posicionesX.length) return;
    const rect = svgEl.getBoundingClientRect();
    const xRelativo = ((evento.clientX - rect.left) / rect.width) * this.ancho;
    let mejorIndice = 0;
    let mejorDistancia = Infinity;
    this.posicionesX.forEach((x, i) => {
      const distancia = Math.abs(x - xRelativo);
      if (distancia < mejorDistancia) {
        mejorDistancia = distancia;
        mejorIndice = i;
      }
    });
    this.indiceHover = mejorIndice;
  }

  alSalirMouse(): void {
    this.indiceHover = null;
  }

  // Posición X del tooltip en unidades del viewBox, ajustada para que la
  // caja no se salga del área de dibujo cuando el punto está muy a la
  // izquierda o muy a la derecha.
  get xTooltip(): number {
    if (this.indiceHover === null) return 0;
    const x = this.posicionesX[this.indiceHover];
    const anchoCaja = 132;
    return Math.min(Math.max(x - anchoCaja / 2, 4), this.ancho - anchoCaja - 4);
  }

  get anchoTooltip(): number {
    return 132;
  }

  get altoTooltip(): number {
    return 20 + this.series.length * 16;
  }
}
