import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReporteService, PeriodoInforme } from '../../core/services/reporte.service';
import { InformeCertificados, RankingCritico } from '../../core/models/models';
import { LineChartComponent, SerieLineaChart } from '../../shared/charts/line-chart.component';
import { DonutChartComponent, SegmentoDonut } from '../../shared/charts/donut-chart.component';
import { BarListComponent } from '../../shared/charts/bar-list.component';

// Informe de Certificados (Fase 1 del informe general "todo el aplicativo").
// Reutiliza el vocabulario visual del "Análisis Estadístico" de Monitoreo
// (kpis-grid / kpi-card / panel-analitica / tabla-atencion) para que el
// usuario reconozca el mismo lenguaje al pasar de un módulo a otro, aunque
// este componente tiene su propio SCSS (cada componente Angular es aislado).
//
// Este es el informe "plantilla" para la mejora de estadísticas pedida por
// el usuario (tendencia histórica, comparación vs periodo anterior, más
// KPIs). El mismo patrón (line-chart + donut-chart + bar-list + pills de
// comparación) se replica luego en los demás informes.
@Component({
  selector: 'app-reportes-certificados',
  standalone: true,
  imports: [CommonModule, FormsModule, LineChartComponent, DonutChartComponent, BarListComponent],
  templateUrl: './reportes-certificados.component.html',
  styleUrl: './reportes-certificados.component.scss',
})
export class ReportesCertificadosComponent implements OnInit {
  periodo: PeriodoInforme = 'semana';
  desde: string = '';
  hasta: string = '';

  informe: InformeCertificados | null = null;
  cargando = false;
  error: string | null = null;
  generandoPdf = false;
  errorPdf: string | null = null;

  constructor(private reporteService: ReporteService) {}

  ngOnInit(): void {
    // Rango por defecto para el selector "Personalizado", por si el usuario
    // lo abre sin haber elegido fechas todavía: última semana.
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
    const parametros =
      this.periodo === 'rango'
        ? { desde: this.desde, hasta: this.hasta }
        : { periodo: this.periodo };

    this.reporteService.obtenerInformeCertificados(parametros).subscribe({
      next: (datos) => {
        this.informe = datos;
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al generar el informe de certificados', err);
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
    const parametros =
      this.periodo === 'rango'
        ? { desde: this.desde, hasta: this.hasta }
        : { periodo: this.periodo };

    this.reporteService.descargarPdfCertificados(parametros).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        const sufijo = this.informe
          ? `${this.informe.periodo.desde}_a_${this.informe.periodo.hasta}`
          : new Date().toISOString().slice(0, 10);
        enlace.href = url;
        enlace.download = `informe-certificados_${sufijo}.pdf`;
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

  claseEstado(estado: string): string {
    if (estado === 'Vigente') return 'status-vigente';
    if (estado === 'Por vencer') return 'status-por-vencer';
    return 'status-vencido';
  }

  claseAccion(accion: string): string {
    return accion === 'ALTA' ? 'accion-alta' : 'accion-renovacion';
  }

  formatoFecha(valor: string | null | undefined): string {
    if (!valor) return '-';
    const fecha = new Date(valor);
    if (isNaN(fecha.getTime())) return String(valor);
    return fecha.toLocaleDateString('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  get totalCriticos(): number {
    if (!this.informe) return 0;
    return (this.informe.resumen['Por vencer'] || 0) + (this.informe.resumen.Vencido || 0);
  }

  get etiquetaPeriodo(): string {
    if (!this.informe) return '';
    return `${this.formatoFecha(this.informe.periodo.desde)} — ${this.formatoFecha(this.informe.periodo.hasta)}`;
  }

  trackRanking(_index: number, item: RankingCritico): string {
    return item.nombre;
  }

  trackPorId(_index: number, item: { Id: number }): number {
    return item.Id;
  }

  anchoRanking(item: RankingCritico, lista: RankingCritico[]): number {
    const max = Math.max(...lista.map((i) => i.total), 1);
    return Math.round((item.total / max) * 100);
  }

  // --- Estadística: tendencia, distribución y comparación vs periodo anterior ---

  // Serie para <app-line-chart>: altas y renovaciones (ambas "buenas", tonos
  // categóricos series-1/series-2) y vencidos (estado crítico → color
  // reservado de "danger", nunca reasignado a otra serie).
  get etiquetasTendencia(): string[] {
    return this.informe?.tendencia.map((p) => p.etiqueta) ?? [];
  }

  get seriesTendencia(): SerieLineaChart[] {
    if (!this.informe) return [];
    return [
      {
        nombre: 'Altas',
        colorVar: 'var(--ax-chart-series-1)',
        valores: this.informe.tendencia.map((p) => p.altas),
      },
      {
        nombre: 'Renovaciones',
        colorVar: 'var(--ax-chart-series-2)',
        valores: this.informe.tendencia.map((p) => p.renovaciones),
      },
      {
        nombre: 'Vencidos',
        colorVar: 'var(--ax-chart-danger)',
        valores: this.informe.tendencia.map((p) => p.vencidos),
      },
    ];
  }

  // Distribución actual de estados (Vigente/Por vencer/Vencido) para
  // <app-donut-chart>. Usa los mismos 3 colores de estado que las
  // kpi-card/status-pill de este mismo informe (nunca reasignados).
  get segmentosResumen(): SegmentoDonut[] {
    if (!this.informe) return [];
    return [
      { etiqueta: 'Vigente', valor: this.informe.resumen.Vigente || 0, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Por vencer', valor: this.informe.resumen['Por vencer'] || 0, colorVar: 'var(--ax-chart-warn)' },
      { etiqueta: 'Vencido', valor: this.informe.resumen.Vencido || 0, colorVar: 'var(--ax-chart-danger)' },
    ];
  }

  // Texto de la píldora de comparación ("+15%", "-8%", "—" sin base).
  textoComparacion(cambioPorc: number | null): string {
    if (cambioPorc === null) return '—';
    if (cambioPorc === 0) return '0%';
    return cambioPorc > 0 ? `+${cambioPorc}%` : `${cambioPorc}%`;
  }

  // Clase visual de la píldora. Por defecto "subir" es bueno (más altas,
  // más renovaciones, más actividad). Para "vencidos" es al revés: subir es
  // malo, por eso ese llamado pasa invertido=true.
  claseComparacion(cambioPorc: number | null, invertido = false): string {
    if (cambioPorc === null || cambioPorc === 0) return 'pill-neutral';
    const esSubida = cambioPorc > 0;
    const esBueno = invertido ? !esSubida : esSubida;
    return esBueno ? 'pill-positiva' : 'pill-negativa';
  }
}
