import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth.service';
import { environment } from '../../environments/environment';
import { DonutChartComponent, SegmentoDonut } from '../shared/charts/donut-chart.component';
import { BarListComponent, ItemBarList } from '../shared/charts/bar-list.component';
import { StackedBarChartComponent, SerieBarrasApiladas } from '../shared/charts/stacked-bar-chart.component';
import { HeatmapComponent } from '../shared/charts/heatmap.component';
import { SparklineComponent } from '../shared/charts/sparkline.component';
import { N8nCuentasComponent } from './n8n-cuentas.component';
import { N8nDetalleComponent } from './n8n-detalle.component';
import { N8nAccesosComponent } from './n8n-accesos.component';
import {
  EjecucionReciente, FlujoN8n, MotivoAtencion, PuntoSerie, claseEstado, claseTasa, descargarCsv, etiquetaEstado, fmtDec, fmtDuracion, fmtFecha, fmtHora,
  fmtNum, fmtPct, fmtRelativo, mensajeHttp,
} from './n8n-utils';

// Estado de cada cuenta (API key) en la última consulta: una cuenta que falla
// no tumba a las demás, solo se avisa.
interface CuentaN8nEstado { id: string; nombre: string; sistema: boolean; ok: boolean; error: string | null; totalFlujos: number; }

interface Analitica {
  periodo: { dias: number; desde: string; hasta: string; unidadSerie: 'hora' | 'dia' };
  global: {
    flujosTotal: number; activos: number; detenidos: number; sinEjecutar: number; conAtencion: number; ejecuciones: number;
    exitosas: number; fallidas: number; canceladas: number; enCurso: number; esperando: number; tasaExito: number | null;
    duracion: { n: number; prom: number | null; p50: number | null; p95: number | null; max: number | null };
    tiempoTotalMs: number; ejecucionesPorDiaProm: number | null;
  };
  serie: { unidad: 'hora' | 'dia'; puntos: PuntoSerie[] };
  porHora: { hora: number; exitosas: number; fallidas: number; otras: number; total: number }[];
  mapaCalor: number[][];
  porModo: { modo: string; etiqueta: string; cantidad: number }[];
  porCuenta: { cuentaId: string; cuentaNombre: string; flujos: number; activos: number; ejecuciones: number; exitosas: number; fallidas: number; tasaExito: number | null }[];
  porEtiqueta: { etiqueta: string; flujos: number; ejecuciones: number; fallidas: number }[];
  atencion: { workflowId: string; nombre: string; cuentaNombre: string; activo: boolean; motivos: MotivoAtencion[] }[];
  recientes: EjecucionReciente[];
  cobertura: { ejecucionesAnalizadas: number; primeraEjecucion: string | null; ultimaEjecucion: string | null; truncado: boolean; avisos: string[] };
  cuentas: CuentaN8nEstado[];
  workflows: FlujoN8n[];
  acceso: { esAdmin: boolean; estricto: boolean; restringido: boolean; sinAsignar: number | null };
}

type Pestana = 'resumen' | 'flujos' | 'ejecuciones';
type OrdenFlujos = 'nombre' | 'ejecuciones' | 'fallos' | 'tasa' | 'lentos' | 'reciente' | 'atencion';
type FiltroEstadoFlujo = 'todos' | 'activos' | 'detenidos' | 'atencion' | 'fallos' | 'sin-ejecutar' | 'sin-asignar';

const DIAS_DISPONIBLES = [
  { dias: 1, etiqueta: '24 h' },
  { dias: 7, etiqueta: '7 días' },
  { dias: 30, etiqueta: '30 días' },
  { dias: 90, etiqueta: '90 días' },
];

const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const LIMITE_INICIAL = 60;

@Component({
  selector: 'app-n8n',
  standalone: true,
  imports: [
    CommonModule, FormsModule, DonutChartComponent, BarListComponent, StackedBarChartComponent, HeatmapComponent, SparklineComponent,
    N8nCuentasComponent, N8nDetalleComponent, N8nAccesosComponent,
  ],
  templateUrl: './n8n.component.html',
  styleUrl: './n8n.component.scss',
})
export class N8nComponent implements OnInit, OnDestroy {
  cargando = true;
  procesandoAccion = false;
  errorCarga: string | null = null;
  datos: Analitica | null = null;
  actualizadoEn: Date | null = null;

  // Solo ADMIN_POD/ADMIN_MIN pueden encender/apagar workflows. BASIC = solo lectura.
  puedeEditar = false;
  esAdminPod = false;

  pestana: Pestana = 'resumen';
  dias = 7;
  readonly opcionesDias = DIAS_DISPONIBLES;
  autoActualizar = false;
  private temporizador: ReturnType<typeof setInterval> | null = null;

  // Derivados para las gráficas (se calculan al cargar)
  etiquetasSerie: string[] = [];
  seriesSerie: SerieBarrasApiladas[] = [];
  etiquetasHora: string[] = [];
  seriesHora: SerieBarrasApiladas[] = [];
  readonly diasSemana = DIAS_SEMANA;
  readonly horas = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  donutEjecuciones: SegmentoDonut[] = [];
  donutFlujos: SegmentoDonut[] = [];
  rankEjecutados: ItemBarList[] = [];
  rankFallos: ItemBarList[] = [];
  rankLentos: ItemBarList[] = [];
  rankTasa: ItemBarList[] = [];
  rankModos: ItemBarList[] = [];

  // Filtros del listado de flujos
  busqueda = '';
  filtroEstado: FiltroEstadoFlujo = 'todos';
  filtroCuenta = 'todas';
  filtroEtiqueta = 'todas';
  orden: OrdenFlujos = 'atencion';
  vistaFlujos: 'tarjetas' | 'tabla' = 'tarjetas';
  limite = LIMITE_INICIAL;
  flujosFiltrados: FlujoN8n[] = [];

  // Filtros de ejecuciones
  busquedaEj = '';
  filtroEstadoEj: 'todas' | 'exitosa' | 'fallida' | 'otras' = 'todas';
  ejecucionesFiltradas: EjecucionReciente[] = [];

  // Modales
  flujoSeleccionado: FlujoN8n | null = null;
  panelCuentasAbierto = false;
  panelAccesosAbierto = false;

  readonly fmtNum = fmtNum; readonly fmtDec = fmtDec; readonly fmtPct = fmtPct; readonly fmtDuracion = fmtDuracion;
  readonly fmtFecha = fmtFecha; readonly fmtHora = fmtHora; readonly fmtRelativo = fmtRelativo;
  readonly claseEstado = claseEstado; readonly claseTasa = claseTasa; readonly etiquetaEstado = etiquetaEstado;

  private apiUrl = `${environment.apiUrl}/n8n`;

  constructor(private http: HttpClient, private authService: AuthService) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('ORQUESTADOR_N8N');
    this.authService.usuarioLogueado$.subscribe((u) => { this.esAdminPod = u?.rol === 'ADMIN_POD'; });
    this.cargar();
  }

  ngOnDestroy(): void { this.detenerTemporizador(); }

  // ---------------- Carga ----------------

  cargar(silencioso = false): void {
    if (!silencioso) this.cargando = true;
    this.errorCarga = null;
    const tz = new Date().getTimezoneOffset();
    this.http.get<Analitica>(`${this.apiUrl}/analytics`, { params: { dias: this.dias, tz } }).subscribe({
      next: (d) => {
        this.datos = d;
        this.actualizadoEn = new Date();
        if (this.filtroCuenta !== 'todas' && !d.cuentas.some((c) => c.id === this.filtroCuenta)) this.filtroCuenta = 'todas';
        if (this.filtroEtiqueta !== 'todas' && !d.porEtiqueta.some((e) => e.etiqueta === this.filtroEtiqueta)) this.filtroEtiqueta = 'todas';
        this.prepararGraficas(d);
        this.aplicarFiltros();
        this.aplicarFiltrosEj();
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error cargando analíticas de n8n', err);
        this.errorCarga = mensajeHttp(err, 'No se pudo consultar n8n.');
        if (!silencioso) this.datos = null;
        this.cargando = false;
      },
    });
  }

  cambiarDias(d: number): void {
    if (d === this.dias) return;
    this.dias = d;
    this.cargar();
  }

  alternarAuto(): void {
    this.detenerTemporizador();
    if (this.autoActualizar) this.temporizador = setInterval(() => { if (!document.hidden && !this.cargando) this.cargar(true); }, 60000);
  }

  private detenerTemporizador(): void {
    if (this.temporizador) { clearInterval(this.temporizador); this.temporizador = null; }
  }

  private prepararGraficas(d: Analitica): void {
    this.etiquetasSerie = d.serie.puntos.map((p) => p.etiqueta);
    this.seriesSerie = [
      { nombre: 'Exitosas', colorVar: 'var(--ax-chart-ok)', valores: d.serie.puntos.map((p) => p.exitosas) },
      { nombre: 'Fallidas', colorVar: 'var(--ax-chart-danger)', valores: d.serie.puntos.map((p) => p.fallidas) },
      { nombre: 'Otras', colorVar: 'var(--ax-border-2, #94a3b8)', valores: d.serie.puntos.map((p) => p.otras) },
    ];
    this.etiquetasHora = d.porHora.map((h) => String(h.hora).padStart(2, '0'));
    this.seriesHora = [
      { nombre: 'Exitosas', colorVar: 'var(--ax-chart-ok)', valores: d.porHora.map((h) => h.exitosas) },
      { nombre: 'Fallidas', colorVar: 'var(--ax-chart-danger)', valores: d.porHora.map((h) => h.fallidas) },
      { nombre: 'Otras', colorVar: 'var(--ax-border-2, #94a3b8)', valores: d.porHora.map((h) => h.otras) },
    ];

    const g = d.global;
    this.donutEjecuciones = [
      { etiqueta: 'Exitosas', valor: g.exitosas, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Fallidas', valor: g.fallidas, colorVar: 'var(--ax-chart-danger)' },
      { etiqueta: 'Canceladas', valor: g.canceladas, colorVar: 'var(--ax-chart-warn)' },
      { etiqueta: 'En curso / espera', valor: g.enCurso + g.esperando, colorVar: 'var(--ax-chart-series-1)' },
    ];

    const wf = d.workflows;
    const activosConAtencion = wf.filter((f) => f.activo && f.motivos.length).length;
    this.donutFlujos = [
      { etiqueta: 'Activos sin alertas', valor: wf.filter((f) => f.activo).length - activosConAtencion, colorVar: 'var(--ax-chart-ok)' },
      { etiqueta: 'Activos con alertas', valor: activosConAtencion, colorVar: 'var(--ax-chart-warn)' },
      { etiqueta: 'Detenidos', valor: wf.filter((f) => !f.activo).length, colorVar: 'var(--ax-text-muted, #94a3b8)' },
    ];

    const top = <T>(lista: T[], n = 7): T[] => lista.slice(0, n);
    this.rankEjecutados = top([...wf].filter((f) => f.totalEjecuciones > 0).sort((a, b) => b.totalEjecuciones - a.totalEjecuciones))
      .map((f) => ({ nombre: f.nombre, total: f.totalEjecuciones, texto: fmtNum(f.totalEjecuciones) }));
    this.rankFallos = top([...wf].filter((f) => f.fallidas > 0).sort((a, b) => b.fallidas - a.fallidas))
      .map((f) => ({ nombre: f.nombre, total: f.fallidas, texto: `${fmtNum(f.fallidas)} de ${fmtNum(f.totalEjecuciones)}` }));
    this.rankLentos = top([...wf].filter((f) => f.duracion.prom !== null && f.duracion.n >= 2).sort((a, b) => (b.duracion.prom || 0) - (a.duracion.prom || 0)))
      .map((f) => ({ nombre: f.nombre, total: f.duracion.prom || 0, texto: fmtDuracion(f.duracion.prom) }));
    // Menor tasa de éxito (con base suficiente): la barra mide el % de fallo para que lo peor sea lo más largo.
    this.rankTasa = top([...wf].filter((f) => f.tasaExito !== null && f.exitosas + f.fallidas >= 3 && f.tasaExito < 100).sort((a, b) => (a.tasaExito as number) - (b.tasaExito as number)))
      .map((f) => ({ nombre: f.nombre, total: 100 - (f.tasaExito as number), texto: `${fmtPct(f.tasaExito)} éxito` }));
    this.rankModos = d.porModo.map((m) => ({ nombre: m.etiqueta, total: m.cantidad, texto: fmtNum(m.cantidad) }));
  }

  // ---------------- Datos derivados ----------------

  get g() { return this.datos!.global; }
  get workflows(): FlujoN8n[] { return this.datos?.workflows || []; }
  get cuentas(): CuentaN8nEstado[] { return this.datos?.cuentas || []; }
  get variasCuentas(): boolean { return this.cuentas.length > 1; }
  get cuentasConError(): CuentaN8nEstado[] { return this.cuentas.filter((c) => !c.ok); }
  get acceso() { return this.datos?.acceso; }
  get etiquetasDisponibles(): string[] { return (this.datos?.porEtiqueta || []).map((e) => e.etiqueta).sort((a, b) => a.localeCompare(b)); }
  get textoPeriodo(): string { return this.dias === 1 ? 'últimas 24 horas' : `últimos ${this.dias} días`; }
  get unidadSerieTexto(): string { return this.datos?.serie.unidad === 'hora' ? 'por hora' : 'por día'; }

  // Salud global: tasa de éxito del periodo (100 si no hubo ejecuciones).
  get salud(): number { return this.datos?.global.tasaExito ?? 100; }
  get claseSalud(): string { return this.salud >= 90 ? 'ok' : this.salud >= 70 ? 'aviso' : 'mal'; }

  get totalEjecucionesFlujos(): number { return this.workflows.reduce((s, f) => s + f.totalEjecuciones, 0); }

  get sinFlujos(): boolean { return !!this.datos && this.workflows.length === 0; }

  // ---------------- Pestañas ----------------

  irA(p: Pestana): void { this.pestana = p; }

  verAtencion(): void {
    this.filtroEstado = 'atencion';
    this.orden = 'atencion';
    this.pestana = 'flujos';
    this.aplicarFiltros();
  }

  // ---------------- Filtros de flujos ----------------

  private ordenarClave(f: FlujoN8n): number {
    switch (this.orden) {
      case 'ejecuciones': return -f.totalEjecuciones;
      case 'fallos': return -f.fallidas;
      case 'tasa': return f.tasaExito === null ? 101 : f.tasaExito;
      case 'lentos': return -(f.duracion.prom || 0);
      case 'reciente': return f.ultimaEjecucion ? -new Date(f.ultimaEjecucion).getTime() : Infinity;
      case 'atencion': {
        const peso = f.motivos.some((m) => m.severidad === 'alta') ? 0 : f.motivos.some((m) => m.severidad === 'media') ? 1 : f.motivos.length ? 2 : 3;
        return peso;
      }
      default: return 0;
    }
  }

  aplicarFiltros(): void {
    this.limite = LIMITE_INICIAL;
    const t = this.busqueda.trim().toLowerCase();
    const lista = this.workflows.filter((f) => {
      if (this.filtroCuenta !== 'todas' && f.cuentaId !== this.filtroCuenta) return false;
      if (this.filtroEtiqueta !== 'todas' && !f.etiquetas.includes(this.filtroEtiqueta)) return false;
      if (t && !f.nombre.toLowerCase().includes(t) && !f.id.toLowerCase().includes(t) && !(f.cuentaNombre || '').toLowerCase().includes(t)
        && !f.etiquetas.some((e) => e.toLowerCase().includes(t))) return false;
      switch (this.filtroEstado) {
        case 'activos': return f.activo;
        case 'detenidos': return !f.activo;
        case 'atencion': return f.motivos.length > 0;
        case 'fallos': return f.fallidas > 0;
        case 'sin-ejecutar': return f.totalEjecuciones === 0;
        case 'sin-asignar': return f.usuariosConAcceso === 0;
        default: return true;
      }
    });
    this.flujosFiltrados = lista
      .map((f) => ({ f, k: this.ordenarClave(f) }))
      .sort((a, b) => a.k - b.k || a.f.nombre.localeCompare(b.f.nombre))
      .map((x) => x.f);
  }

  get flujosMostrados(): FlujoN8n[] { return this.flujosFiltrados.slice(0, this.limite); }
  verMas(): void { this.limite += LIMITE_INICIAL; }

  contarEstado(e: FiltroEstadoFlujo): number {
    const base = this.workflows.filter((f) => this.filtroCuenta === 'todas' || f.cuentaId === this.filtroCuenta);
    switch (e) {
      case 'activos': return base.filter((f) => f.activo).length;
      case 'detenidos': return base.filter((f) => !f.activo).length;
      case 'atencion': return base.filter((f) => f.motivos.length).length;
      case 'fallos': return base.filter((f) => f.fallidas > 0).length;
      case 'sin-ejecutar': return base.filter((f) => f.totalEjecuciones === 0).length;
      case 'sin-asignar': return base.filter((f) => f.usuariosConAcceso === 0).length;
      default: return base.length;
    }
  }

  limpiarFiltros(): void {
    this.busqueda = ''; this.filtroEstado = 'todos'; this.filtroCuenta = 'todas'; this.filtroEtiqueta = 'todas';
    this.aplicarFiltros();
  }

  get hayFiltros(): boolean { return !!this.busqueda || this.filtroEstado !== 'todos' || this.filtroCuenta !== 'todas' || this.filtroEtiqueta !== 'todas'; }

  // ---------------- Filtros de ejecuciones ----------------

  aplicarFiltrosEj(): void {
    const t = this.busquedaEj.trim().toLowerCase();
    this.ejecucionesFiltradas = (this.datos?.recientes || []).filter((e) => {
      if (this.filtroEstadoEj === 'exitosa' && e.grupo !== 'exitosa') return false;
      if (this.filtroEstadoEj === 'fallida' && e.grupo !== 'fallida') return false;
      if (this.filtroEstadoEj === 'otras' && (e.grupo === 'exitosa' || e.grupo === 'fallida')) return false;
      return !t || e.flujo.toLowerCase().includes(t) || e.id.toLowerCase().includes(t) || (e.cuentaNombre || '').toLowerCase().includes(t);
    });
  }

  abrirEjecucion(e: EjecucionReciente): void {
    const f = this.workflows.find((w) => w.id === e.workflowId);
    if (f) this.abrirDetalle(f);
  }

  // ---------------- Acciones sobre flujos ----------------

  toggleEstado(wf: FlujoN8n, event: Event): void {
    event.stopPropagation();
    if (!this.puedeEditar) return; // BASIC: solo lectura, no puede encender/apagar

    const nuevoEstado = !wf.activo;
    wf.activo = nuevoEstado;

    this.http.post(`${this.apiUrl}/workflows/${wf.id}/toggle`, { activar: nuevoEstado, cuentaId: wf.cuentaId }).subscribe({
      next: () => { if (this.datos) this.prepararGraficas(this.datos); },
      error: () => { wf.activo = !nuevoEstado; },
    });
  }

  cambiarEstadoTodos(activar: boolean): void {
    if (!this.puedeEditar) return; // BASIC: solo lectura

    const accion = activar ? 'ACTIVAR' : 'DESACTIVAR';
    const cuentaSel = this.filtroCuenta !== 'todas' ? this.cuentas.find((c) => c.id === this.filtroCuenta) : null;
    const alcance = cuentaSel ? `todos los workflows de "${cuentaSel.nombre}"` : (this.variasCuentas ? 'todos los workflows de TODAS las cuentas' : 'todos los workflows');
    if (!confirm(`¿Estás seguro de que deseas ${accion} ${alcance}?`)) return;

    this.procesandoAccion = true;
    this.http.post(`${this.apiUrl}/workflows/bulk-toggle`, { activar, cuentaId: cuentaSel?.id }).subscribe({
      next: () => { this.procesandoAccion = false; this.cargar(); },
      error: () => { alert('Error ejecutando la acción masiva.'); this.procesandoAccion = false; },
    });
  }

  abrirDetalle(wf: FlujoN8n): void { this.flujoSeleccionado = wf; }
  cerrarDetalle(): void { this.flujoSeleccionado = null; }

  abrirDetalleAtencion(workflowId: string): void {
    const f = this.workflows.find((w) => w.id === workflowId);
    if (f) this.abrirDetalle(f);
  }

  // ---------------- Paneles de administración ----------------

  abrirCuentas(): void { if (this.esAdminPod) this.panelCuentasAbierto = true; }
  cerrarCuentas(): void { this.panelCuentasAbierto = false; this.cargar(true); } // pudo cambiar qué cuentas se consultan
  abrirAccesos(): void { if (this.esAdminPod) this.panelAccesosAbierto = true; }
  cerrarAccesos(huboCambios: boolean): void { this.panelAccesosAbierto = false; if (huboCambios) this.cargar(true); }

  // ---------------- Exportar ----------------

  exportarFlujosCsv(): void {
    const filas: (string | number | null)[][] = [[
      'ID', 'Flujo', 'Propietario', 'Activo', 'Etiquetas', 'Se dispara por', 'Ejecuciones', 'Exitosas', 'Fallidas', 'Tasa de exito %',
      'Duracion prom (ms)', 'P95 (ms)', 'Racha de fallos', 'Ultima ejecucion', 'Ultimo estado', 'Alertas',
    ]];
    for (const f of this.flujosFiltrados) {
      filas.push([
        f.id, f.nombre, f.cuentaNombre, f.activo ? 'Si' : 'No', f.etiquetas.join(', '), (f.disparadores || []).join(', '), f.totalEjecuciones, f.exitosas, f.fallidas,
        f.tasaExito, f.duracion.prom, f.duracion.p95, f.racha, f.ultimaEjecucion, etiquetaEstado(f.ultimoEstado), f.motivos.map((m) => m.texto).join(' | '),
      ]);
    }
    descargarCsv(`n8n-flujos-${this.dias}d-${new Date().toISOString().slice(0, 10)}.csv`, filas);
  }

  exportarEjecucionesCsv(): void {
    const filas: (string | number | null)[][] = [['ID ejecucion', 'Flujo', 'Propietario', 'Estado', 'Modo', 'Inicio', 'Duracion (ms)']];
    for (const e of this.ejecucionesFiltradas) filas.push([e.id, e.flujo, e.cuentaNombre, etiquetaEstado(e.estado), e.modo, e.inicio, e.duracion]);
    descargarCsv(`n8n-ejecuciones-${new Date().toISOString().slice(0, 10)}.csv`, filas);
  }

  trackFlujo(_i: number, f: { id: string }): string { return f.id; }
  trackCuenta(_i: number, c: { id: string }): string { return c.id; }
  trackEj(_i: number, e: { id: string }): string { return e.id; }
}
