import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReporteService, PeriodoInforme } from '../../core/services/reporte.service';
import { InformeF5, NodoInformeF5, VirtualServerInformeF5, EstadoNodoF5, PuntoTraficoDiarioF5 } from '../../core/models/models';
import { LineChartComponent, SerieLineaChart } from '../../shared/charts/line-chart.component';
import { DonutChartComponent, SegmentoDonut } from '../../shared/charts/donut-chart.component';
import { BarListComponent, ItemBarList } from '../../shared/charts/bar-list.component';

// Informe de Balanceador F5. Junta cuatro fuentes (ver backend/utils/informeF5.js):
// el estado EN VIVO del F5, la disponibilidad histórica (f5_historico), el
// tráfico por nodo que guarda el muestreo (f5_nodo_trafico) y las transacciones
// HTTP de AVR. Cada una tiene su alcance; las notas de cobertura de la pantalla
// dicen qué falta cuando una no tiene datos en el periodo.
//
// Mismo patrón visual que Certificados/Servidores (line-chart + donut-chart
// + bar-list) sobre los datos que este informe ya traía.
@Component({
  selector: 'app-reportes-f5',
  standalone: true,
  imports: [CommonModule, FormsModule, LineChartComponent, DonutChartComponent, BarListComponent],
  templateUrl: './reportes-f5.component.html',
  styleUrl: './reportes-f5.component.scss',
})
export class ReportesF5Component implements OnInit {
  periodo: PeriodoInforme = 'semana';
  desde: string = '';
  hasta: string = '';

  informe: InformeF5 | null = null;
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

    this.reporteService.obtenerInformeF5(parametros).subscribe({
      next: (datos) => {
        this.informe = datos;
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al generar el informe de F5', err);
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

    this.reporteService.descargarPdfF5(parametros).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        const sufijo = this.informe ? `${this.informe.periodo.desde}_a_${this.informe.periodo.hasta}` : new Date().toISOString().slice(0, 10);
        enlace.href = url;
        enlace.download = `informe-f5_${sufijo}.pdf`;
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

  // --- Filtros de las tablas de detalle ---
  readonly FILAS_INICIALES = 25;
  busquedaVirtual = '';
  busquedaNodo = '';
  filtroEstadoNodo: 'todos' | EstadoNodoF5 | 'sin-trafico' = 'todos';
  verTodosVirtuales = false;
  verTodosNodos = false;

  // --- Formato de cantidades ---
  nf(n: number | null | undefined): string {
    return n === null || n === undefined ? '—' : Number(n).toLocaleString('es-CO');
  }

  bps(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    const unidades = ['bps', 'Kbps', 'Mbps', 'Gbps'];
    let v = Number(n);
    let i = 0;
    while (v >= 1000 && i < unidades.length - 1) { v /= 1000; i++; }
    return `${v.toLocaleString('es-CO', { maximumFractionDigits: 1, minimumFractionDigits: i === 0 ? 0 : 1 })} ${unidades[i]}`;
  }

  bytes(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < unidades.length - 1) { v /= 1024; i++; }
    return `${v.toLocaleString('es-CO', { maximumFractionDigits: 1, minimumFractionDigits: i === 0 ? 0 : 1 })} ${unidades[i]}`;
  }

  pct(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return `${n.toLocaleString('es-CO', { maximumFractionDigits: 2 })}%`;
  }

  fechaHora(valor: string | null | undefined): string {
    if (!valor) return '—';
    const f = new Date(valor);
    if (isNaN(f.getTime())) return '—';
    return f.toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Clave 'YYYY-MM-DD' de una fecha que puede venir pura ('2026-10-04') o como
  // ISO de una columna DATE ('2026-10-04T00:00:00.000Z'). La medianoche UTC se
  // trata como fecha pura: pasarla por Date la mostraría un día antes en Colombia.
  claveDia(valor: string | null | undefined): string | null {
    if (!valor) return null;
    const t = String(valor);
    const m = t.match(/^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z)?$/);
    if (m) return m[1];
    const f = new Date(t);
    if (isNaN(f.getTime())) return null;
    return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
  }

  // Día corto "dd/mm".
  diaCorto(valor: string | null | undefined): string {
    const c = this.claveDia(valor);
    if (!c) return valor ? String(valor) : '-';
    return `${c.slice(8, 10)}/${c.slice(5, 7)}`;
  }

  // Tráfico del día (para la tabla diaria, que se arma con la serie de disponibilidad).
  traficoDe(fecha: string): PuntoTraficoDiarioF5 | null {
    const c = this.claveDia(fecha);
    const p = this.traficoDiario.find((d) => d.fecha === c);
    return p && p.entradaPromBps !== null ? p : null;
  }

  textoEstadoNodo(e: EstadoNodoF5): string {
    return e === 'disponible' ? 'Disponible' : e === 'caido' ? 'Caído' : 'Deshabilitado';
  }

  claseEstadoNodo(e: EstadoNodoF5): string {
    return e === 'disponible' ? 'status-vigente' : e === 'caido' ? 'status-vencido' : 'status-por-vencer';
  }

  textoEstadoVirtual(v: VirtualServerInformeF5): string {
    if (!v.habilitado) return 'Deshabilitado';
    if (v.estado === 'available') return 'Disponible';
    if (v.estado === 'unknown') return 'Sin dato';
    return 'No disponible';
  }

  claseEstadoVirtual(v: VirtualServerInformeF5): string {
    if (!v.habilitado) return 'status-por-vencer';
    if (v.estado === 'available') return 'status-vigente';
    if (v.estado === 'unknown') return 'status-neutro';
    return 'status-vencido';
  }

  // --- Datos derivados del informe ampliado ---

  get virtuales(): VirtualServerInformeF5[] { return this.informe?.virtuales ?? []; }
  get nodos(): NodoInformeF5[] { return this.informe?.nodos ?? []; }
  get traficoDiario() { return this.informe?.traficoDiario ?? []; }
  get hayInformeAmpliado(): boolean { return !!this.informe?.resumenPeriodo; }

  get hayAtencion(): boolean {
    const a = this.informe?.atencion;
    if (!a) return false;
    return !!(a.virtualesAbajo.length || a.virtualesDeshabilitados.length || a.nodosCaidos.length || a.nodosDeshabilitados.length || a.nodosSinTrafico.length);
  }

  get nodosTotalDetalle(): number {
    const c = this.informe?.conteos;
    return c ? c.nodosDisponibles + c.nodosCaidos + c.nodosDeshabilitados : 0;
  }

  // Tráfico: se grafican solo los días con lecturas (un día sin datos no es un día con 0).
  private get diasConTrafico() { return this.traficoDiario.filter((d) => d.entradaPromBps !== null); }

  get escalaBps(): { div: number; unidad: string } {
    const max = Math.max(0, ...this.diasConTrafico.flatMap((d) => [d.entradaPicoBps || 0, d.salidaPicoBps || 0]));
    if (max >= 5e8) return { div: 1e9, unidad: 'Gbps' };
    if (max >= 5e5) return { div: 1e6, unidad: 'Mbps' };
    return { div: 1e3, unidad: 'Kbps' };
  }

  get etiquetasTrafico(): string[] { return this.diasConTrafico.map((d) => this.diaCorto(d.fecha)); }

  get serieTrafico(): SerieLineaChart[] {
    const { div } = this.escalaBps;
    const r = (n: number | null) => +(((n || 0) / div).toFixed(2));
    return [
      { nombre: 'Entrada (prom.)', colorVar: 'var(--ax-chart-series-1)', valores: this.diasConTrafico.map((d) => r(d.entradaPromBps)) },
      { nombre: 'Salida (prom.)', colorVar: 'var(--ax-chart-series-2)', valores: this.diasConTrafico.map((d) => r(d.salidaPromBps)) },
    ];
  }

  get etiquetasConexiones(): string[] { return this.diasConTrafico.map((d) => this.diaCorto(d.fecha)); }

  get serieConexiones(): SerieLineaChart[] {
    return [
      { nombre: 'Conexiones simultáneas (pico)', colorVar: 'var(--ax-chart-series-1)', valores: this.diasConTrafico.map((d) => d.conexionesPico || 0) },
    ];
  }

  private get diasConTransacciones() { return this.traficoDiario.filter((d) => d.transacciones !== null && d.transacciones !== undefined); }

  get etiquetasTransacciones(): string[] { return this.diasConTransacciones.map((d) => this.diaCorto(d.fecha)); }

  get unidadTransacciones(): { div: number; texto: string } {
    const max = Math.max(0, ...this.diasConTransacciones.map((d) => d.transacciones || 0));
    return max >= 10000 ? { div: 1000, texto: 'miles' } : { div: 1, texto: '' };
  }

  get serieTransacciones(): SerieLineaChart[] {
    const { div } = this.unidadTransacciones;
    return [
      { nombre: 'Transacciones HTTP', colorVar: 'var(--ax-chart-series-2)', valores: this.diasConTransacciones.map((d) => +(((d.transacciones || 0) / div).toFixed(1))) },
    ];
  }

  get etiquetasDisponibilidad(): string[] {
    return (this.informe?.tendenciaDiaria ?? []).filter((d) => d.virtualesPct !== null && d.virtualesPct !== undefined).map((d) => this.diaCorto(d.fecha));
  }

  get serieDisponibilidad(): SerieLineaChart[] {
    const dias = (this.informe?.tendenciaDiaria ?? []).filter((d) => d.virtualesPct !== null && d.virtualesPct !== undefined);
    return [
      { nombre: 'Virtual Servers (%)', colorVar: 'var(--ax-chart-series-1)', valores: dias.map((d) => d.virtualesPct ?? 0) },
      { nombre: 'Nodos (%)', colorVar: 'var(--ax-chart-series-2)', valores: dias.map((d) => d.nodosPct ?? 0) },
    ];
  }

  get segmentosNodosEstado(): SegmentoDonut[] {
    const c = this.informe?.conteos;
    if (!c) return [];
    return [
      { etiqueta: 'Disponibles', valor: c.nodosDisponibles, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Deshabilitados', valor: c.nodosDeshabilitados, colorVar: 'var(--ax-chart-warn)' },
      { etiqueta: 'Caídos', valor: c.nodosCaidos, colorVar: 'var(--ax-chart-danger)' },
    ];
  }

  // El tráfico se mide en el pool: si varios Virtual Servers comparten pool se
  // cuenta una sola vez en los rankings.
  private get virtualesPorPool() {
    const vistos = new Set<string>();
    return this.virtuales.filter((v) => {
      const k = `${v.dispositivoId}::${v.pool || v.fullPath}`;
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
  }

  private nombrePool(v: VirtualServerInformeF5): string {
    return v.poolCompartidoCon ? `${v.nombreMostrado} (+${v.poolCompartidoCon})` : v.nombreMostrado;
  }

  get rankingDatos(): ItemBarList[] {
    return this.virtualesPorPool
      .map((v) => ({ v, total: (v.trafico?.datosEntradaBytes || 0) + (v.trafico?.datosSalidaBytes || 0) }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
      .map((x) => ({ nombre: this.nombrePool(x.v), total: x.total, texto: this.bytes(x.total) }));
  }

  get rankingTransacciones(): ItemBarList[] {
    return this.virtualesPorPool
      .filter((v) => (v.transacciones || 0) > 0)
      .sort((a, b) => (b.transacciones || 0) - (a.transacciones || 0))
      .slice(0, 8)
      .map((v) => ({ nombre: this.nombrePool(v), total: v.transacciones || 0, texto: this.nf(v.transacciones) }));
  }

  get rankingConexiones(): ItemBarList[] {
    return this.virtualesPorPool
      .filter((v) => (v.trafico?.conexionesPico || 0) > 0)
      .sort((a, b) => (b.trafico?.conexionesPico || 0) - (a.trafico?.conexionesPico || 0))
      .slice(0, 8)
      .map((v) => ({ nombre: this.nombrePool(v), total: v.trafico?.conexionesPico || 0, texto: this.nf(v.trafico?.conexionesPico) }));
  }

  // --- Tablas de detalle ---

  get virtualesFiltrados(): VirtualServerInformeF5[] {
    const t = this.busquedaVirtual.trim().toLowerCase();
    if (!t) return this.virtuales;
    return this.virtuales.filter((v) => [v.nombreMostrado, v.nombre, v.alias, v.pool, v.destino, v.dispositivoNombre].some((x) => (x || '').toLowerCase().includes(t)));
  }

  get virtualesVisibles(): VirtualServerInformeF5[] {
    const l = this.virtualesFiltrados;
    return this.verTodosVirtuales ? l : l.slice(0, this.FILAS_INICIALES);
  }

  private esSinTrafico(n: NodoInformeF5): boolean {
    return n.estado === 'disponible' && !!n.trafico && n.trafico.muestras > 0 && n.trafico.minutosConTrafico === 0 && !(n.transacciones && n.transacciones > 0);
  }

  get nodosFiltrados(): NodoInformeF5[] {
    const t = this.busquedaNodo.trim().toLowerCase();
    return this.nodos.filter((n) => {
      if (this.filtroEstadoNodo === 'sin-trafico') { if (!this.esSinTrafico(n)) return false; }
      else if (this.filtroEstadoNodo !== 'todos' && n.estado !== this.filtroEstadoNodo) return false;
      if (!t) return true;
      return [n.miembro, n.virtualNombre, n.pool, n.dispositivoNombre].some((x) => (x || '').toLowerCase().includes(t));
    });
  }

  get nodosVisibles(): NodoInformeF5[] {
    const l = this.nodosFiltrados;
    return this.verTodosNodos ? l : l.slice(0, this.FILAS_INICIALES);
  }

  trackVirtual(_i: number, v: VirtualServerInformeF5): string { return `${v.dispositivoId}|${v.fullPath}`; }
  trackNodo(_i: number, n: NodoInformeF5): string { return `${n.dispositivoId}|${n.pool}|${n.miembro}`; }

  // --- Descargas CSV (todos los datos, sin el tope de filas de la pantalla) ---

  private descargarCsv(nombre: string, cabecera: string[], filas: (string | number | null | undefined)[][]): void {
    const celda = (v: string | number | null | undefined) => {
      const t = v === null || v === undefined ? '' : String(v);
      return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    // BOM + ";" para que Excel en español lo abra bien (acentos y columnas).
    const csv = '\ufeff' + [cabecera, ...filas].map((f) => f.map(celda).join(';')).join('\r\n');
    const url = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const enlace = document.createElement('a');
    const sufijo = this.informe ? `${this.informe.periodo.desde}_a_${this.informe.periodo.hasta}` : new Date().toISOString().slice(0, 10);
    enlace.href = url;
    enlace.download = `${nombre}_${sufijo}.csv`;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    window.URL.revokeObjectURL(url);
  }

  exportarCsvNodos(): void {
    this.descargarCsv('f5-nodos', [
      'Dispositivo', 'Virtual Servers', 'Pool', 'Nodo', 'Dirección', 'Puerto', 'Estado', 'Monitor', 'Último tráfico',
      'Minutos con tráfico', 'Datos entrada (bytes)', 'Datos salida (bytes)', 'Entrada prom. (bps)', 'Salida prom. (bps)',
      'Pico entrada (bps)', 'Pico salida (bps)', 'Conexiones prom.', 'Conexiones pico', 'Conexiones nuevas', 'Transacciones HTTP',
    ], this.nodos.map((n) => [
      n.dispositivoNombre, n.virtualNombre, n.pool, n.miembro, n.direccion, n.puerto, this.textoEstadoNodo(n.estado), n.estadoMonitor,
      n.ultimoTraficoEn, n.trafico?.minutosConTrafico, n.trafico?.datosEntradaBytes, n.trafico?.datosSalidaBytes,
      n.trafico?.entradaPromBps, n.trafico?.salidaPromBps, n.trafico?.entradaPicoBps, n.trafico?.salidaPicoBps,
      n.trafico?.conexionesProm, n.trafico?.conexionesPico, n.trafico?.conexionesNuevas, n.transacciones,
    ]));
  }

  exportarCsvVirtuales(): void {
    this.descargarCsv('f5-virtual-servers', [
      'Dispositivo', 'Virtual Server', 'Alias', 'Destino', 'Pool', 'Comparte pool con', 'Estado', 'Nodos arriba', 'Nodos total',
      'Nodos caídos', 'Nodos deshabilitados', 'Datos entrada (bytes)', 'Datos salida (bytes)', 'Pico entrada (bps)', 'Pico salida (bps)',
      'Conexiones pico', 'Conexiones nuevas', 'Transacciones HTTP',
    ], this.virtuales.map((v) => [
      v.dispositivoNombre, v.nombre, v.alias, v.destino, v.pool, v.poolCompartidoCon, this.textoEstadoVirtual(v), v.nodosArriba, v.nodosTotal,
      v.nodosCaidos, v.nodosDeshabilitados, v.trafico?.datosEntradaBytes, v.trafico?.datosSalidaBytes, v.trafico?.entradaPicoBps, v.trafico?.salidaPicoBps,
      v.trafico?.conexionesPico, v.trafico?.conexionesNuevas, v.transacciones,
    ]));
  }

  exportarCsvDiario(): void {
    this.descargarCsv('f5-trafico-diario', [
      'Fecha', 'Entrada prom. (bps)', 'Salida prom. (bps)', 'Pico entrada (bps)', 'Pico salida (bps)', 'Conexiones pico',
      'Conexiones nuevas', 'Datos entrada (bytes)', 'Datos salida (bytes)', 'Transacciones HTTP',
    ], this.traficoDiario.map((d) => [
      d.fecha, d.entradaPromBps, d.salidaPromBps, d.entradaPicoBps, d.salidaPicoBps, d.conexionesPico,
      d.conexionesNuevas, d.datosEntradaBytes, d.datosSalidaBytes, d.transacciones,
    ]));
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

  trackFecha(_index: number, item: { fecha: string }): string {
    return item.fecha;
  }

  trackDispositivo(_index: number, item: { dispositivoId: string }): string {
    return item.dispositivoId;
  }

  trackDispositivoError(_index: number, item: { id: string }): string {
    return item.id;
  }

  anchoBarraVirtuales(item: { virtualesArribaProm: number }): number {
    if (!this.informe) return 0;
    const max = Math.max(...this.informe.porDispositivo.map((i) => i.virtualesTotalProm), 1);
    return Math.round((item.virtualesArribaProm / max) * 100);
  }

  anchoBarraNodos(item: { nodosArribaProm: number }): number {
    if (!this.informe) return 0;
    const max = Math.max(...this.informe.porDispositivo.map((i) => i.nodosTotalProm), 1);
    return Math.round((item.nodosArribaProm / max) * 100);
  }

  // --- Estadística: tendencia, distribución y rankings como gráficas ---

  get etiquetasTendencia(): string[] {
    return this.informe?.tendenciaDiaria.map((p) => this.diaCorto(p.fecha)) ?? [];
  }

  // Virtual Servers y nodos arriba comparten unidad ("cantidad arriba"), así
  // que pueden ir en la misma gráfica sin caer en dual-axis.
  get serieArriba(): SerieLineaChart[] {
    if (!this.informe) return [];
    return [
      { nombre: 'Virtual Servers arriba', colorVar: 'var(--ax-chart-series-1)', valores: this.informe.tendenciaDiaria.map((p) => p.virtualesArribaProm) },
      { nombre: 'Nodos arriba', colorVar: 'var(--ax-chart-series-2)', valores: this.informe.tendenciaDiaria.map((p) => p.nodosArribaProm) },
    ];
  }

  get segmentosVirtuales(): SegmentoDonut[] {
    if (!this.informe) return [];
    return [
      { etiqueta: 'Arriba', valor: this.informe.resumenActual.virtualesArriba, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Abajo', valor: this.informe.resumenActual.virtualesAbajo, colorVar: 'var(--ax-chart-danger)' },
    ];
  }

  get segmentosNodos(): SegmentoDonut[] {
    if (!this.informe) return [];
    return [
      { etiqueta: 'Arriba', valor: this.informe.resumenActual.nodosArriba, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Abajo', valor: this.informe.resumenActual.nodosAbajo, colorVar: 'var(--ax-chart-danger)' },
    ];
  }

  get porDispositivoVirtualesBarList(): ItemBarList[] {
    return (this.informe?.porDispositivo ?? []).map((d) => ({ nombre: d.dispositivoNombre, total: d.virtualesArribaProm }));
  }

  get porDispositivoNodosBarList(): ItemBarList[] {
    return (this.informe?.porDispositivo ?? []).map((d) => ({ nombre: d.dispositivoNombre, total: d.nodosArribaProm }));
  }
}
