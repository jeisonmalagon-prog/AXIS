import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReporteService, PeriodoInforme } from '../../core/services/reporte.service';
import { InformeApuntamientos } from '../../core/models/models';
import { LineChartComponent, SerieLineaChart } from '../../shared/charts/line-chart.component';
import { DonutChartComponent, SegmentoDonut } from '../../shared/charts/donut-chart.component';
import { BarListComponent } from '../../shared/charts/bar-list.component';

// Informe de Bitácora de Apuntamientos (Fase 2 del informe general).
// "Incidencia" = un ajuste con TRANDID y/o descripción de error — ver
// backend/utils/informeApuntamientos.js para el criterio exacto.
//
// Mismo patrón visual que Certificados (line-chart + donut-chart + bar-list
// + pills de comparación vs periodo anterior).
@Component({
  selector: 'app-reportes-apuntamientos',
  standalone: true,
  imports: [CommonModule, FormsModule, LineChartComponent, DonutChartComponent, BarListComponent],
  templateUrl: './reportes-apuntamientos.component.html',
  styleUrl: './reportes-apuntamientos.component.scss',
})
export class ReportesApuntamientosComponent implements OnInit {
  periodo: PeriodoInforme = 'semana';
  desde: string = '';
  hasta: string = '';

  informe: InformeApuntamientos | null = null;
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

    this.reporteService.obtenerInformeApuntamientos(parametros).subscribe({
      next: (datos) => {
        this.informe = datos;
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al generar el informe de apuntamientos', err);
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

    this.reporteService.descargarPdfApuntamientos(parametros).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        const sufijo = this.informe ? `${this.informe.periodo.desde}_a_${this.informe.periodo.hasta}` : new Date().toISOString().slice(0, 10);
        enlace.href = url;
        enlace.download = `informe-apuntamientos_${sufijo}.pdf`;
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

  get etiquetaPeriodo(): string {
    if (!this.informe) return '';
    return `${this.formatoFecha(this.informe.periodo.desde)} — ${this.formatoFecha(this.informe.periodo.hasta)}`;
  }

  trackIncidencia(_index: number, item: { Id: number }): number {
    return item.Id;
  }

  // --- Estadística: tendencia, distribución y comparación vs periodo anterior ---
  //
  // Nota defensiva: "tendencia"/"comparacion" son campos nuevos del backend.
  // Si el backend que responde todavía no los incluye (por ejemplo, justo
  // después de desplegar el cambio pero antes de reiniciar el proceso), estos
  // getters deben degradarse con seguridad (arreglos/objetos vacíos) en vez
  // de lanzar un error que rompa el resto del binding de la plantilla.

  get etiquetasTendencia(): string[] {
    return this.informe?.tendencia?.map((p) => p.etiqueta) ?? [];
  }

  get seriesTendencia(): SerieLineaChart[] {
    const tendencia = this.informe?.tendencia ?? [];
    return [
      { nombre: 'Altas', colorVar: 'var(--ax-chart-series-1)', valores: tendencia.map((p) => p.altas) },
      { nombre: 'Ajustes', colorVar: 'var(--ax-chart-series-2)', valores: tendencia.map((p) => p.ajustes) },
      { nombre: 'Incidencias', colorVar: 'var(--ax-chart-danger)', valores: tendencia.map((p) => p.incidencias) },
    ];
  }

  get comparacionPeriodoAnteriorDesde(): string | null {
    return this.informe?.comparacion?.periodoAnterior?.desde ?? null;
  }

  get comparacionPeriodoAnteriorHasta(): string | null {
    return this.informe?.comparacion?.periodoAnterior?.hasta ?? null;
  }

  get cambioAltas(): number | null {
    return this.informe?.comparacion?.altas?.cambioPorc ?? null;
  }

  get cambioAjustes(): number | null {
    return this.informe?.comparacion?.ajustes?.cambioPorc ?? null;
  }

  get cambioIncidencias(): number | null {
    return this.informe?.comparacion?.incidencias?.cambioPorc ?? null;
  }

  // Con apuntamiento asignado vs. sin apuntamiento -- distribución del
  // snapshot actual (no depende del periodo).
  get segmentosApuntamiento(): SegmentoDonut[] {
    if (!this.informe) return [];
    const conAsignacion = Math.max(0, this.informe.resumenActual.total - this.informe.resumenActual.sinApuntamiento);
    return [
      { etiqueta: 'Con apuntamiento', valor: conAsignacion, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Sin apuntamiento', valor: this.informe.resumenActual.sinApuntamiento, colorVar: 'var(--ax-chart-danger)' },
    ];
  }

  // Distribución por categoría (ACE / Bus de Integración 10 / otras) --
  // igual que arriba, snapshot actual.
  get segmentosCategoria(): SegmentoDonut[] {
    if (!this.informe) return [];
    const otras = Math.max(0, this.informe.resumenActual.total - this.informe.resumenActual.ace - this.informe.resumenActual.busIntegracion10);
    return [
      { etiqueta: 'ACE', valor: this.informe.resumenActual.ace, colorVar: 'var(--ax-chart-series-1)' },
      { etiqueta: 'Bus de Integración 10', valor: this.informe.resumenActual.busIntegracion10, colorVar: 'var(--ax-chart-series-2)' },
      { etiqueta: 'Otras', valor: otras, colorVar: 'var(--ax-chart-warn)' },
    ];
  }

  textoComparacion(cambioPorc: number | null): string {
    if (cambioPorc === null) return '—';
    if (cambioPorc === 0) return '0%';
    return cambioPorc > 0 ? `+${cambioPorc}%` : `${cambioPorc}%`;
  }

  // Por defecto "subir" es bueno (más altas, más ajustes gestionados). Para
  // "incidencias" es al revés: subir es malo, por eso ese llamado pasa
  // invertido=true.
  claseComparacion(cambioPorc: number | null, invertido = false): string {
    if (cambioPorc === null || cambioPorc === 0) return 'pill-neutral';
    const esSubida = cambioPorc > 0;
    const esBueno = invertido ? !esSubida : esSubida;
    return esBueno ? 'pill-positiva' : 'pill-negativa';
  }
}
