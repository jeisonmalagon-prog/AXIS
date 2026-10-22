import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReporteService, PeriodoInforme } from '../../core/services/reporte.service';
import { InformeAplicaciones } from '../../core/models/models';
import { LineChartComponent, SerieLineaChart } from '../../shared/charts/line-chart.component';
import { DonutChartComponent, SegmentoDonut } from '../../shared/charts/donut-chart.component';
import { BarListComponent } from '../../shared/charts/bar-list.component';

// Informe de Aplicaciones e Inventario de Sub-aplicativos (Fase 2 del
// informe general). A diferencia de los demás informes de Fase 2, este es
// principalmente un SNAPSHOT del estado actual — Aplicaciones/inv_aplicativos
// no tienen fecha de auditoría real, así que lo único filtrado realmente por
// periodo (con tendencia y comparación) son las conexiones a bases de datos
// registradas (ver backend/utils/informeAplicaciones.js para el detalle).
//
// Mismo patrón visual que los demás informes de Fase 2 (line-chart + donut-
// chart + bar-list + pill de comparación vs periodo anterior), aplicado sobre
// los datos disponibles: las distribuciones son del snapshot actual, y la
// tendencia/comparación es sobre las conexiones BD, que es el único dato
// realmente filtrado por periodo.
@Component({
  selector: 'app-reportes-aplicaciones',
  standalone: true,
  imports: [CommonModule, FormsModule, LineChartComponent, DonutChartComponent, BarListComponent],
  templateUrl: './reportes-aplicaciones.component.html',
  styleUrl: './reportes-aplicaciones.component.scss',
})
export class ReportesAplicacionesComponent implements OnInit {
  periodo: PeriodoInforme = 'semana';
  desde: string = '';
  hasta: string = '';

  informe: InformeAplicaciones | null = null;
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

    this.reporteService.obtenerInformeAplicaciones(parametros).subscribe({
      next: (datos) => {
        this.informe = datos;
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al generar el informe de aplicaciones', err);
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

    this.reporteService.descargarPdfAplicaciones(parametros).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        const sufijo = this.informe ? `${this.informe.periodo.desde}_a_${this.informe.periodo.hasta}` : new Date().toISOString().slice(0, 10);
        enlace.href = url;
        enlace.download = `informe-aplicaciones_${sufijo}.pdf`;
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

  trackServidor(_index: number, item: { Id: number }): number {
    return item.Id;
  }

  trackSubaplicativo(_index: number, item: { Id: number }): number {
    return item.Id;
  }

  trackConexion(_index: number, item: { id: number }): number {
    return item.id;
  }

  trackRanking(_index: number, item: { nombre: string }): string {
    return item.nombre;
  }

  // --- Estadística: tendencia, distribución y comparación vs periodo anterior ---
  // (Aplica solo a conexiones BD, el único dato de este módulo con fecha de
  // auditoría real. Las distribuciones de abajo son del snapshot actual.)
  //
  // Nota defensiva: "tendenciaConexionesBd"/"comparacionConexionesBd" son
  // campos nuevos del backend. Si el backend que responde todavía no los
  // incluye, estos getters deben degradarse con seguridad (arreglos/objetos
  // vacíos) en vez de lanzar un error que rompa el resto del binding de la
  // plantilla.

  get etiquetasTendencia(): string[] {
    return this.informe?.tendenciaConexionesBd?.map((p) => p.etiqueta) ?? [];
  }

  get serieConexionesBd(): SerieLineaChart[] {
    const tendencia = this.informe?.tendenciaConexionesBd ?? [];
    return [
      { nombre: 'Conexiones BD registradas', colorVar: 'var(--ax-chart-series-1)', valores: tendencia.map((p) => p.total) },
    ];
  }

  get comparacionConexionesPeriodoAnteriorDesde(): string | null {
    return this.informe?.comparacionConexionesBd?.periodoAnterior?.desde ?? null;
  }

  get comparacionConexionesPeriodoAnteriorHasta(): string | null {
    return this.informe?.comparacionConexionesBd?.periodoAnterior?.hasta ?? null;
  }

  get cambioConexionesBd(): number | null {
    return this.informe?.comparacionConexionesBd?.cambioPorc ?? null;
  }

  // Servidores con al menos un aplicativo vs. servidores huérfanos —
  // distribución del snapshot actual.
  get segmentosServidores(): SegmentoDonut[] {
    if (!this.informe) return [];
    const conAplicativos = Math.max(0, this.informe.resumenActual.totalServidores - this.informe.resumenActual.servidoresSinAplicativos);
    return [
      { etiqueta: 'Con aplicativos', valor: conAplicativos, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Sin aplicativos', valor: this.informe.resumenActual.servidoresSinAplicativos, colorVar: 'var(--ax-chart-danger)' },
    ];
  }

  // Sub-aplicativos con certificado asociado vs. sin certificado —
  // distribución del snapshot actual.
  get segmentosCertificados(): SegmentoDonut[] {
    if (!this.informe) return [];
    const conCertificado = Math.max(0, this.informe.resumenActual.totalSubaplicativos - this.informe.resumenActual.subaplicativosSinCertificado);
    return [
      { etiqueta: 'Con certificado', valor: conCertificado, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Sin certificado', valor: this.informe.resumenActual.subaplicativosSinCertificado, colorVar: 'var(--ax-chart-danger)' },
    ];
  }

  textoComparacion(cambioPorc: number | null): string {
    if (cambioPorc === null) return '—';
    if (cambioPorc === 0) return '0%';
    return cambioPorc > 0 ? `+${cambioPorc}%` : `${cambioPorc}%`;
  }

  claseComparacion(cambioPorc: number | null, invertido = false): string {
    if (cambioPorc === null || cambioPorc === 0) return 'pill-neutral';
    const esSubida = cambioPorc > 0;
    const esBueno = invertido ? !esSubida : esSubida;
    return esBueno ? 'pill-positiva' : 'pill-negativa';
  }
}
