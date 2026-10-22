import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { ReporteService, PeriodoInforme } from '../../core/services/reporte.service';
import { InformeGeneral, SeccionInformeGeneral } from '../../core/models/models';
import { LineChartComponent, SerieLineaChart } from '../../shared/charts/line-chart.component';
import { DonutChartComponent, SegmentoDonut } from '../../shared/charts/donut-chart.component';

interface KpiVista {
  etiqueta: string;
  valor: string;
  // Presente solo en KPI de "actividad del periodo" que tienen comparación
  // contra el periodo anterior (no todos los módulos la calculan todavía).
  cambioPorc?: number | null;
  invertido?: boolean;
}

interface TendenciaSeccion {
  etiquetas: string[];
  series: SerieLineaChart[];
}

// A qué informe individual mandar el "Ver informe completo" de cada sección.
const RUTA_POR_SECCION: Record<string, string> = {
  certificados: '/reportes-certificados',
  servidores: '/reportes-servidores',
  aplicaciones: '/reportes-aplicaciones',
  apuntamientos: '/reportes-apuntamientos',
  f5: '/reportes-f5',
};

// Informe General del Aplicativo: combina, en un solo informe (pantalla y
// PDF), las secciones que el usuario elija entre los módulos que YA tienen
// su propio informe individual (Certificados, Servidores/Monitoreo,
// Aplicaciones, Apuntamientos, Balanceador F5) — ver
// backend/utils/informeGeneral.js.
//
// El PDF combinado trae el detalle COMPLETO de cada sección (reutiliza el
// mismo generarPdf<Modulo> de cada informe individual); esta pantalla
// muestra un resumen compacto por sección (unos pocos KPI) con un enlace al
// informe individual para ver el detalle completo en pantalla.
@Component({
  selector: 'app-reportes-general',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, LineChartComponent, DonutChartComponent],
  templateUrl: './reportes-general.component.html',
  styleUrl: './reportes-general.component.scss',
})
export class ReportesGeneralComponent implements OnInit {
  periodo: PeriodoInforme = 'semana';
  desde: string = '';
  hasta: string = '';

  seccionesDisponibles: SeccionInformeGeneral[] = [];
  seleccion: Record<string, boolean> = {};
  cargandoSecciones = true;
  errorSecciones: string | null = null;

  informe: InformeGeneral | null = null;
  cargando = false;
  error: string | null = null;
  generandoPdf = false;
  errorPdf: string | null = null;

  rutaPorSeccion = RUTA_POR_SECCION;

  constructor(private reporteService: ReporteService) {}

  ngOnInit(): void {
    const hoy = new Date();
    const haceUnaSemana = new Date();
    haceUnaSemana.setDate(haceUnaSemana.getDate() - 7);
    this.hasta = this.formatoInput(hoy);
    this.desde = this.formatoInput(haceUnaSemana);

    this.reporteService.obtenerSeccionesGeneral().subscribe({
      next: (respuesta) => {
        this.seccionesDisponibles = respuesta.secciones;
        // Por defecto se marcan TODAS las secciones disponibles para este
        // usuario — la idea es que "informe general" traiga todo de una,
        // y el usuario destilde lo que no quiera en vez de tener que armar
        // la selección desde cero cada vez.
        respuesta.secciones.forEach((s) => (this.seleccion[s.clave] = true));
        this.cargandoSecciones = false;
        if (this.seccionesDisponibles.length) {
          this.generarInforme();
        }
      },
      error: (err) => {
        console.error('Error al cargar las secciones del informe general', err);
        this.errorSecciones = 'No se pudieron cargar los módulos disponibles para el informe general.';
        this.cargandoSecciones = false;
      },
    });
  }

  private formatoInput(fecha: Date): string {
    return fecha.toISOString().slice(0, 10);
  }

  get clavesSeleccionadas(): string[] {
    return Object.keys(this.seleccion).filter((clave) => this.seleccion[clave]);
  }

  get hayAlgunaSeleccionada(): boolean {
    return this.clavesSeleccionadas.length > 0;
  }

  alternarSeccion(clave: string): void {
    this.seleccion[clave] = !this.seleccion[clave];
  }

  seleccionarTodas(): void {
    this.seccionesDisponibles.forEach((s) => (this.seleccion[s.clave] = true));
  }

  quitarTodas(): void {
    this.seccionesDisponibles.forEach((s) => (this.seleccion[s.clave] = false));
  }

  seleccionarPeriodo(nuevoPeriodo: PeriodoInforme): void {
    this.periodo = nuevoPeriodo;
    if (nuevoPeriodo !== 'rango') {
      this.generarInforme();
    }
  }

  private parametrosActuales() {
    return this.periodo === 'rango' ? { desde: this.desde, hasta: this.hasta } : { periodo: this.periodo };
  }

  generarInforme(): void {
    if (!this.hayAlgunaSeleccionada) {
      this.error = 'Selecciona al menos una sección para generar el informe general.';
      return;
    }
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

    this.reporteService.obtenerInformeGeneral(this.parametrosActuales(), this.clavesSeleccionadas).subscribe({
      next: (datos) => {
        this.informe = datos;
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al generar el informe general', err);
        this.error = err?.error?.error || 'No se pudo generar el informe general. Intenta de nuevo.';
        this.cargando = false;
      },
    });
  }

  descargarPdf(): void {
    if (!this.hayAlgunaSeleccionada) {
      this.errorPdf = 'Selecciona al menos una sección para descargar el PDF.';
      return;
    }
    if (this.periodo === 'rango' && (!this.desde || !this.hasta)) {
      this.errorPdf = 'Selecciona ambas fechas para un rango personalizado.';
      return;
    }

    this.generandoPdf = true;
    this.errorPdf = null;

    this.reporteService.descargarPdfGeneral(this.parametrosActuales(), this.clavesSeleccionadas).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        const sufijo = this.informe ? `${this.informe.periodo.desde}_a_${this.informe.periodo.hasta}` : new Date().toISOString().slice(0, 10);
        enlace.href = url;
        enlace.download = `informe-general_${sufijo}.pdf`;
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        window.URL.revokeObjectURL(url);
        this.generandoPdf = false;
      },
      error: (err) => {
        console.error('Error al descargar el PDF del informe general', err);
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

  tieneError(clave: string): boolean {
    return !!this.informe?.seccionesConError.some((e) => e.clave === clave);
  }

  mensajeError(clave: string): string {
    return this.informe?.seccionesConError.find((e) => e.clave === clave)?.error || '';
  }

  // KPIs compactos por sección — el detalle completo de cada módulo sigue
  // disponible en su propio informe ("Ver informe completo") y siempre en
  // el PDF combinado, que trae cada informe entero.
  kpisSeccion(clave: string): KpiVista[] {
    const secciones = this.informe?.secciones as any;
    const d = secciones ? secciones[clave] : null;
    if (!d) return [];

    switch (clave) {
      case 'certificados':
        return [
          { etiqueta: 'Vigentes', valor: String(d.resumen?.Vigente ?? 0) },
          { etiqueta: 'Por vencer', valor: String(d.resumen?.['Por vencer'] ?? 0) },
          { etiqueta: 'Vencidos', valor: String(d.resumen?.Vencido ?? 0) },
          { etiqueta: 'Altas en periodo', valor: String(d.altasEnPeriodo ?? 0), cambioPorc: d.comparacion?.altas?.cambioPorc ?? null },
          { etiqueta: 'Renovaciones en periodo', valor: String(d.renovacionesEnPeriodo ?? 0), cambioPorc: d.comparacion?.renovaciones?.cambioPorc ?? null },
        ];
      case 'servidores':
        return [
          { etiqueta: 'Entornos arriba', valor: `${d.resumenActual?.entornosArriba ?? 0}/${d.resumenActual?.entornosTotal ?? 0}` },
          { etiqueta: 'Contenedores corriendo', valor: String(d.resumenActual?.contenedoresCorriendo ?? 0) },
          { etiqueta: 'CPU en uso ahora', valor: `${d.resumenActual?.cpuPromedioActual ?? 0}%` },
          { etiqueta: 'Memoria en uso ahora', valor: `${d.resumenActual?.memUsadaActualGb ?? 0} GB` },
        ];
      case 'aplicaciones':
        return [
          { etiqueta: 'Aplicaciones de negocio', valor: String(d.resumenActual?.totalAplicacionesNegocio ?? 0) },
          { etiqueta: 'Sub-aplicativos', valor: String(d.resumenActual?.totalSubaplicativos ?? 0) },
          { etiqueta: 'Servidores sin aplicativos', valor: String(d.resumenActual?.servidoresSinAplicativos ?? 0) },
          { etiqueta: 'Sub-aplicativos sin certificado', valor: String(d.resumenActual?.subaplicativosSinCertificado ?? 0) },
          { etiqueta: 'Conexiones BD en periodo', valor: String(d.altasConexionesBdEnPeriodo ?? 0), cambioPorc: d.comparacionConexionesBd?.cambioPorc ?? null },
        ];
      case 'apuntamientos':
        return [
          { etiqueta: 'Total apuntamientos', valor: String(d.resumenActual?.total ?? 0) },
          { etiqueta: 'Sin apuntamiento', valor: String(d.resumenActual?.sinApuntamiento ?? 0) },
          { etiqueta: 'ACE', valor: String(d.resumenActual?.ace ?? 0) },
          { etiqueta: 'Bus de Integración 10', valor: String(d.resumenActual?.busIntegracion10 ?? 0) },
          { etiqueta: 'Incidencias en periodo', valor: String(d.incidenciasEnPeriodo?.length ?? 0), cambioPorc: d.comparacion?.incidencias?.cambioPorc ?? null, invertido: true },
        ];
      case 'f5':
        return [
          { etiqueta: 'Virtual Servers arriba', valor: `${d.resumenActual?.virtualesArriba ?? 0}/${d.resumenActual?.virtualesTotal ?? 0}` },
          { etiqueta: 'Nodos arriba', valor: `${d.resumenActual?.nodosArriba ?? 0}/${d.resumenActual?.nodosTotal ?? 0}` },
          { etiqueta: 'Dispositivos F5', valor: String(d.resumenActual?.dispositivosTotal ?? 0) },
        ];
      default:
        return [];
    }
  }

  textoComparacion(cambioPorc: number | null | undefined): string {
    if (cambioPorc === null || cambioPorc === undefined) return '—';
    if (cambioPorc === 0) return '0%';
    return cambioPorc > 0 ? `+${cambioPorc}%` : `${cambioPorc}%`;
  }

  claseComparacion(cambioPorc: number | null | undefined, invertido = false): string {
    if (cambioPorc === null || cambioPorc === undefined || cambioPorc === 0) return 'pill-neutral';
    const esSubida = cambioPorc > 0;
    const esBueno = invertido ? !esSubida : esSubida;
    return esBueno ? 'pill-positiva' : 'pill-negativa';
  }

  formatoFechaCorta(valor: string | null | undefined): string {
    if (!valor) return '-';
    const fecha = new Date(valor);
    if (isNaN(fecha.getTime())) return String(valor);
    return fecha.toLocaleDateString('es-CO', { month: '2-digit', day: '2-digit' });
  }

  // Distribución de estado actual por sección, para el donut compacto de
  // cada tarjeta -- null cuando la sección no trae los datos necesarios
  // (p.ej. todavía cargando, o sin permiso).
  donutSeccion(clave: string): SegmentoDonut[] | null {
    const secciones = this.informe?.secciones as any;
    const d = secciones ? secciones[clave] : null;
    if (!d) return null;

    switch (clave) {
      case 'certificados': {
        if (!d.resumen) return null;
        return [
          { etiqueta: 'Vigente', valor: d.resumen.Vigente ?? 0, colorVar: 'var(--ax-chart-ok)' },
          { etiqueta: 'Por vencer', valor: d.resumen['Por vencer'] ?? 0, colorVar: 'var(--ax-chart-warn)' },
          { etiqueta: 'Vencido', valor: d.resumen.Vencido ?? 0, colorVar: 'var(--ax-chart-danger)' },
        ];
      }
      case 'servidores': {
        if (!d.resumenActual) return null;
        return [
          { etiqueta: 'Corriendo', valor: d.resumenActual.contenedoresCorriendo ?? 0, colorVar: 'var(--ax-chart-ok)' },
          { etiqueta: 'Detenidos', valor: d.resumenActual.contenedoresDetenidos ?? 0, colorVar: 'var(--ax-chart-danger)' },
        ];
      }
      case 'aplicaciones': {
        if (!d.resumenActual) return null;
        const conAplicativos = Math.max(0, (d.resumenActual.totalServidores ?? 0) - (d.resumenActual.servidoresSinAplicativos ?? 0));
        return [
          { etiqueta: 'Con aplicativos', valor: conAplicativos, colorVar: 'var(--ax-chart-ok)' },
          { etiqueta: 'Sin aplicativos', valor: d.resumenActual.servidoresSinAplicativos ?? 0, colorVar: 'var(--ax-chart-danger)' },
        ];
      }
      case 'apuntamientos': {
        if (!d.resumenActual) return null;
        const conAsignacion = Math.max(0, (d.resumenActual.total ?? 0) - (d.resumenActual.sinApuntamiento ?? 0));
        return [
          { etiqueta: 'Con apuntamiento', valor: conAsignacion, colorVar: 'var(--ax-chart-ok)' },
          { etiqueta: 'Sin apuntamiento', valor: d.resumenActual.sinApuntamiento ?? 0, colorVar: 'var(--ax-chart-danger)' },
        ];
      }
      case 'f5': {
        if (!d.resumenActual) return null;
        const abajo = Math.max(0, (d.resumenActual.virtualesTotal ?? 0) - (d.resumenActual.virtualesArriba ?? 0));
        return [
          { etiqueta: 'Virtuales arriba', valor: d.resumenActual.virtualesArriba ?? 0, colorVar: 'var(--ax-chart-ok)' },
          { etiqueta: 'Virtuales abajo', valor: abajo, colorVar: 'var(--ax-chart-danger)' },
        ];
      }
      default:
        return null;
    }
  }

  centroEtiquetaSeccion(clave: string): string {
    switch (clave) {
      case 'certificados': return 'Certificados';
      case 'servidores': return 'Contenedores';
      case 'aplicaciones': return 'Servidores';
      case 'apuntamientos': return 'Apuntamientos';
      case 'f5': return 'Virtuales';
      default: return 'Total';
    }
  }

  // Serie de tendencia por sección para el mini line-chart de cada tarjeta
  // -- null cuando la sección no trae historial (todavía sin capturas, o
  // periodo sin datos), para que la plantilla simplemente no dibuje el
  // panel en ese caso en vez de mostrar una gráfica vacía.
  lineChartSeccion(clave: string): TendenciaSeccion | null {
    const secciones = this.informe?.secciones as any;
    const d = secciones ? secciones[clave] : null;
    if (!d) return null;

    switch (clave) {
      case 'certificados': {
        const tendencia = d.tendencia ?? [];
        if (!tendencia.length) return null;
        return {
          etiquetas: tendencia.map((p: any) => p.etiqueta),
          series: [
            { nombre: 'Altas', colorVar: 'var(--ax-chart-series-1)', valores: tendencia.map((p: any) => p.altas) },
            { nombre: 'Renovaciones', colorVar: 'var(--ax-chart-series-2)', valores: tendencia.map((p: any) => p.renovaciones) },
            { nombre: 'Vencidos', colorVar: 'var(--ax-chart-danger)', valores: tendencia.map((p: any) => p.vencidos) },
          ],
        };
      }
      case 'servidores': {
        const tendencia = d.tendenciaDiaria ?? [];
        if (!tendencia.length) return null;
        return {
          etiquetas: tendencia.map((p: any) => this.formatoFechaCorta(p.fecha)),
          series: [
            { nombre: 'Contenedores corriendo', colorVar: 'var(--ax-chart-series-2)', valores: tendencia.map((p: any) => p.contenedoresCorriendoProm) },
          ],
        };
      }
      case 'aplicaciones': {
        const tendencia = d.tendenciaConexionesBd ?? [];
        if (!tendencia.length) return null;
        return {
          etiquetas: tendencia.map((p: any) => p.etiqueta),
          series: [
            { nombre: 'Conexiones BD registradas', colorVar: 'var(--ax-chart-series-1)', valores: tendencia.map((p: any) => p.total) },
          ],
        };
      }
      case 'apuntamientos': {
        const tendencia = d.tendencia ?? [];
        if (!tendencia.length) return null;
        return {
          etiquetas: tendencia.map((p: any) => p.etiqueta),
          series: [
            { nombre: 'Altas', colorVar: 'var(--ax-chart-series-1)', valores: tendencia.map((p: any) => p.altas) },
            { nombre: 'Ajustes', colorVar: 'var(--ax-chart-series-2)', valores: tendencia.map((p: any) => p.ajustes) },
            { nombre: 'Incidencias', colorVar: 'var(--ax-chart-danger)', valores: tendencia.map((p: any) => p.incidencias) },
          ],
        };
      }
      case 'f5': {
        const tendencia = d.tendenciaDiaria ?? [];
        if (!tendencia.length) return null;
        return {
          etiquetas: tendencia.map((p: any) => this.formatoFechaCorta(p.fecha)),
          series: [
            { nombre: 'Virtual Servers arriba', colorVar: 'var(--ax-chart-series-1)', valores: tendencia.map((p: any) => p.virtualesArribaProm) },
            { nombre: 'Nodos arriba', colorVar: 'var(--ax-chart-series-2)', valores: tendencia.map((p: any) => p.nodosArribaProm) },
          ],
        };
      }
      default:
        return null;
    }
  }

  // Aviso informativo (no es un error) para secciones que son principalmente
  // "en vivo" y todavía no están configuradas en el backend.
  avisoSeccion(clave: string): string | null {
    const secciones = this.informe?.secciones as any;
    const d = secciones ? secciones[clave] : null;
    if (!d) return null;
    if (clave === 'servidores' && !d.portainerConfigurado) {
      return 'Portainer todavía no está configurado — solo se muestra la tendencia histórica guardada, sin snapshot en vivo.';
    }
    if (clave === 'f5' && !d.f5Configurado) {
      return 'El Balanceador F5 todavía no está configurado en el backend.';
    }
    return null;
  }
}
