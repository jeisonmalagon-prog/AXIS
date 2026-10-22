import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReporteService, PeriodoInforme } from '../../core/services/reporte.service';
import { InformeServidores, RankingEntorno } from '../../core/models/models';
import { LineChartComponent, SerieLineaChart } from '../../shared/charts/line-chart.component';
import { DonutChartComponent, SegmentoDonut } from '../../shared/charts/donut-chart.component';
import { BarListComponent, ItemBarList } from '../../shared/charts/bar-list.component';

// Informe de Servidores/Monitoreo (Fase 2 del informe general). A
// diferencia de Certificados, la tendencia del periodo depende de
// monitoreo_historico_portainer — puede venir vacía si el backend lleva
// poco tiempo corriendo con la captura automática activa (ver
// backend/utils/informeServidores.js). El resumen actual sí es en vivo.
//
// Mismo patrón visual que Certificados (line-chart + donut-chart +
// bar-list), aplicado sobre los datos que este informe YA traía —
// tendenciaDiaria/topEntornosPorCpu/topEntornosPorMemoria no cambiaron en
// el backend, solo se re-presentan con los componentes compartidos.
@Component({
  selector: 'app-reportes-servidores',
  standalone: true,
  imports: [CommonModule, FormsModule, LineChartComponent, DonutChartComponent, BarListComponent],
  templateUrl: './reportes-servidores.component.html',
  styleUrl: './reportes-servidores.component.scss',
})
export class ReportesServidoresComponent implements OnInit {
  periodo: PeriodoInforme = 'semana';
  desde: string = '';
  hasta: string = '';

  informe: InformeServidores | null = null;
  cargando = false;
  error: string | null = null;
  generandoPdf = false;
  errorPdf: string | null = null;

  constructor(private reporteService: ReporteService) {}

  ngOnInit(): void {
    const hoy = new Date();
    const haceUnaSemana = new Date();
    haceUnaSemana.setDate(haceUnaSemana.getDate() - 7);
    this.hasta = this.formatoInput(hoy);
    this.desde = this.formatoInput(haceUnaSemana);

    this.generarInforme();
  }

  private formatoInput(fecha: Date): string {
    return fecha.toISOString().slice(0, 10);
  }

  seleccionarPeriodo(nuevoPeriodo: PeriodoInforme): void {
    this.periodo = nuevoPeriodo;
    if (nuevoPeriodo !== 'rango') {
      this.generarInforme();
    }
  }

  generarInforme(): void {
    if (this.periodo === 'rango' && (!this.desde || !this.hasta)) {
      this.error = 'Selecciona ambas fechas para un rango personalizado.';
      return;
    }
    if (this.periodo === 'rango' && this.desde > this.hasta) {
      this.error = 'La fecha "desde" no puede ser posterior a la fecha "hasta".';
      return;
    }

    this.cargando = true;
    this.error = null;
    const parametros = this.periodo === 'rango' ? { desde: this.desde, hasta: this.hasta } : { periodo: this.periodo };

    this.reporteService.obtenerInformeServidores(parametros).subscribe({
      next: (datos) => {
        this.informe = datos;
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al generar el informe de servidores', err);
        this.error = err?.error?.error || 'No se pudo generar el informe. Intenta de nuevo.';
        this.cargando = false;
      },
    });
  }

  descargarPdf(): void {
    if (this.periodo === 'rango' && (!this.desde || !this.hasta)) {
      this.errorPdf = 'Selecciona ambas fechas para un rango personalizado.';
      return;
    }

    this.generandoPdf = true;
    this.errorPdf = null;
    const parametros = this.periodo === 'rango' ? { desde: this.desde, hasta: this.hasta } : { periodo: this.periodo };

    this.reporteService.descargarPdfServidores(parametros).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        const sufijo = this.informe ? `${this.informe.periodo.desde}_a_${this.informe.periodo.hasta}` : new Date().toISOString().slice(0, 10);
        enlace.href = url;
        enlace.download = `informe-servidores_${sufijo}.pdf`;
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        window.URL.revokeObjectURL(url);
        this.generandoPdf = false;
      },
      error: (err) => {
        console.error('Error al descargar el PDF del informe', err);
        this.errorPdf = 'No se pudo generar el PDF. Intenta de nuevo.';
        this.generandoPdf = false;
      },
    });
  }

  // --- Helpers de presentación ---

  formatoFecha(valor: string | null | undefined): string {
    if (!valor) return '-';
    const fecha = new Date(valor);
    if (isNaN(fecha.getTime())) return String(valor);
    return fecha.toLocaleDateString('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  formatoFechaCorta(valor: string | null | undefined): string {
    if (!valor) return '-';
    const fecha = new Date(valor);
    if (isNaN(fecha.getTime())) return String(valor);
    return fecha.toLocaleDateString('es-CO', { month: '2-digit', day: '2-digit' });
  }

  get etiquetaPeriodo(): string {
    if (!this.informe) return '';
    return `${this.formatoFecha(this.informe.periodo.desde)} — ${this.formatoFecha(this.informe.periodo.hasta)}`;
  }

  claseNivelUso(pct: number): string {
    if (pct >= 80) return 'kpi-critico';
    if (pct >= 50) return 'kpi-riesgo';
    return 'kpi-sano';
  }

  trackTendencia(_index: number, item: { fecha: string }): string {
    return item.fecha;
  }

  trackRanking(_index: number, item: RankingEntorno): number {
    return item.entornoId;
  }

  anchoBarraCpu(item: RankingEntorno): number {
    if (!this.informe) return 0;
    const max = Math.max(...this.informe.topEntornosPorCpu.map((i) => i.cpuPromedio), 1);
    return Math.round((item.cpuPromedio / max) * 100);
  }

  anchoBarraMemoria(item: RankingEntorno): number {
    if (!this.informe) return 0;
    const max = Math.max(...this.informe.topEntornosPorMemoria.map((i) => i.memUsadaGbProm), 1);
    return Math.round((item.memUsadaGbProm / max) * 100);
  }

  // --- Estadística: tendencia, distribución y rankings como gráficas ---

  // Etiquetas de fecha corta para el eje X de las 3 gráficas de tendencia
  // (todas comparten el mismo eje, porque vienen del mismo tendenciaDiaria).
  get etiquetasTendencia(): string[] {
    return this.informe?.tendenciaDiaria.map((p) => this.formatoFechaCorta(p.fecha)) ?? [];
  }

  // Contenedores totales vs. corriendo -- mismo unidad (conteo), por eso
  // pueden compartir un solo eje (nunca dual-axis, ver skill de dataviz).
  get serieContenedores(): SerieLineaChart[] {
    if (!this.informe) return [];
    return [
      { nombre: 'Total', colorVar: 'var(--ax-chart-series-1)', valores: this.informe.tendenciaDiaria.map((p) => p.contenedoresTotalProm) },
      { nombre: 'Corriendo', colorVar: 'var(--ax-chart-series-2)', valores: this.informe.tendenciaDiaria.map((p) => p.contenedoresCorriendoProm) },
    ];
  }

  // CPU (%) y memoria (GB) van en gráficas SEPARADAS -- unidades distintas,
  // así que combinarlas en un solo eje sería un dual-axis (prohibido).
  get serieCpu(): SerieLineaChart[] {
    if (!this.informe) return [];
    return [{ nombre: 'CPU promedio', colorVar: 'var(--ax-chart-series-1)', valores: this.informe.tendenciaDiaria.map((p) => p.cpuPromedio) }];
  }

  get serieMemoria(): SerieLineaChart[] {
    if (!this.informe) return [];
    return [{ nombre: 'Memoria (GB)', colorVar: 'var(--ax-chart-series-2)', valores: this.informe.tendenciaDiaria.map((p) => p.memUsadaGb) }];
  }

  // Promedios del periodo (derivados en el frontend a partir de
  // tendenciaDiaria) -- complementan los "picos" que ya trae el backend,
  // para dar contexto de "lo normal" además de "lo peor".
  get promedioCpuPeriodo(): number | null {
    const puntos = this.informe?.tendenciaDiaria ?? [];
    if (!puntos.length) return null;
    return +(puntos.reduce((acc, p) => acc + p.cpuPromedio, 0) / puntos.length).toFixed(2);
  }

  get promedioMemPeriodo(): number | null {
    const puntos = this.informe?.tendenciaDiaria ?? [];
    if (!puntos.length) return null;
    return +(puntos.reduce((acc, p) => acc + p.memUsadaGb, 0) / puntos.length).toFixed(2);
  }

  // Distribución de contenedores (corriendo vs. detenidos) y de entornos
  // (arriba vs. abajo) -- mismos colores de estado que las kpi-card de
  // arriba (ok = corriendo/arriba, danger = detenido/abajo).
  get segmentosContenedores(): SegmentoDonut[] {
    if (!this.informe) return [];
    return [
      { etiqueta: 'Corriendo', valor: this.informe.resumenActual.contenedoresCorriendo, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Detenidos', valor: this.informe.resumenActual.contenedoresDetenidos, colorVar: 'var(--ax-chart-danger)' },
    ];
  }

  get segmentosEntornos(): SegmentoDonut[] {
    if (!this.informe) return [];
    const abajo = Math.max(0, this.informe.resumenActual.entornosTotal - this.informe.resumenActual.entornosArriba);
    return [
      { etiqueta: 'Arriba', valor: this.informe.resumenActual.entornosArriba, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Abajo', valor: abajo, colorVar: 'var(--ax-chart-danger)' },
    ];
  }

  // Rankings ya existentes, re-empacados a la forma {nombre,total} que pide
  // <app-bar-list> -- misma data que antes, solo cambia cómo se dibuja.
  get topEntornosPorCpuBarList(): ItemBarList[] {
    return (this.informe?.topEntornosPorCpu ?? []).map((e) => ({ nombre: e.entorno, total: e.cpuPromedio }));
  }

  get topEntornosPorMemoriaBarList(): ItemBarList[] {
    return (this.informe?.topEntornosPorMemoria ?? []).map((e) => ({ nombre: e.entorno, total: e.memUsadaGbProm }));
  }
}
