import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NumEsPipe } from './num-es.pipe';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  EstadoTablero, LatenciaTableroResponse, PuntoSerie, RangoApp, SerieResponse, ServicioLatencia, TableroService,
  fmtCompacto, fmtFechaCorta, fmtFechaLarga, fmtSeg, paramsRango
} from './tablero.service';
import { GraficoTasaComponent, GraficoVolumenComponent, SparklineComponent } from './graficos-tablero';

// ---------------------------------------------------------------------------
// Tipos de /app-movil/analytics (se conservan: es la fuente de las vistas
// filtradas por dispositivo / cliente y de los rankings por servicio).
// ---------------------------------------------------------------------------
interface ResumenAnalitica {
  totalTransacciones: number; totalErrores: number; usuariosUnicos: number; sesionesDistintas: number; tasaExito: number;
  conteosDistintosAproximados?: boolean; tiempoPromedioLoginSegundos?: number | null;
}
interface PuntoTendencia { dia: string; total: number; errores: number; }
interface DispositivoConteo { etiqueta: string; total: number; }
interface FuncionalidadConteo {
  clase: string; metodo: string; codigoServicio?: string | null; total: number; errores: number; tasaExito: number;
  tiempoPromedioSegundos?: number | null;
}
interface TopErrorItem { clase: string; metodo: string; cantidadFallos: number; }
interface ResumenAnteriorPeriodo { totalTransacciones: number; totalErrores: number; tasaExito: number | null; fechaInicio: string; fechaFin: string; }
interface AnalyticsResponse {
  dias: number; fechaInicio: string | null; fechaFin: string | null; rangoPersonalizado: boolean;
  filtros: { canal: string | null; dispositivo: string | null; documento: string | null };
  resumen: ResumenAnalitica; resumenAnterior?: ResumenAnteriorPeriodo | null;
  tendencia: PuntoTendencia[]; porCanal: { canalCodigo: number; total: number; errores: number }[];
  porDispositivo: DispositivoConteo[]; porFuncionalidad: FuncionalidadConteo[]; topErrores: TopErrorItem[];
  desactualizado?: boolean;
}
interface ErrorDetalleItem { documento: string; fecha: string; clase: string; metodo: string; servicio: string; ip: string | null; dispositivo: string; mensaje: string; }
interface ErroresDetalleResponse { total: number; limit: number; offset: number; errores: ErrorDetalleItem[]; }
interface ServicioCatalogo { metodo: string; etiqueta: string; }
interface CatalogoLogsResponse { servicios: ServicioCatalogo[]; metodosExcluidosPorDefecto: string[]; }
interface LogClienteItem {
  fecha: string; servicio: string; clase: string; metodo: string; descripcion: string | null; dispositivo: string; ip: string | null;
  estado: 'en_curso' | 'incompleta' | 'error' | 'exito'; estadoTexto: string;
}
interface LogsResponse { total: number; limit: number; offset: number; resultados: LogClienteItem[]; }

interface BarraSimple { etiqueta: string; total: number; porcentajeAncho: number; }
interface GrupoConteo { nombre: string; clase: string; metodo: string; cantidad: number; porcentajeAncho: number; }

export type Tono = '' | 'ok' | 'warn' | 'error';
interface Kpi {
  clave: string; etiqueta: string; valor: string; pie: string; ayuda: string; tono: Tono;
  delta: string | null; claseDelta: string; spark: (number | null)[]; sparkColor: string;
}
export interface Hallazgo { nivel: 'ok' | 'info' | 'aviso' | 'critico'; titulo: string; detalle: string; tab?: string; accion?: string; }
interface BarraSemana { dia: string; promedio: number; tasaError: number | null; alto: number; max: boolean; }

type ClaveOrdenFunc = 'total' | 'errores' | 'tasaExito' | 'tiempo' | 'metodo';

@Component({
  selector: 'app-movil-resumen',
  standalone: true,
  imports: [NumEsPipe, CommonModule, FormsModule, RouterLink, SparklineComponent, GraficoVolumenComponent, GraficoTasaComponent],
  templateUrl: './app-movil-resumen.component.html',
  styleUrl: './app-movil-resumen.component.scss'
})
export class AppMovilResumenComponent implements OnInit, OnChanges, OnDestroy {
  @Input() rango: RangoApp = { dias: 7 };
  @Input() refresco = 0;
  @Input() estado: EstadoTablero | null = null;
  @Output() irA = new EventEmitter<string>();
  @Output() cargado = new EventEmitter<Date>();

  cargando = true;
  error: string | null = null;
  datosDesactualizados = false;

  // Filtros (el rango vive en la cabecera de la página)
  dispositivoSeleccionado = '';
  dispositivosDisponibles: string[] = [];
  documentoInput = '';
  documentoAplicado = '';
  errorDocumento: string | null = null;

  datos: AnalyticsResponse | null = null;
  resumen: ResumenAnalitica | null = null;
  serieDatos: SerieResponse | null = null;
  latenciaDatos: LatenciaTableroResponse | null = null;
  serieGrafico: PuntoSerie[] = [];
  anteriorGrafico: PuntoSerie[] | null = null;
  hoyTexto = '';

  kpis: Kpi[] = [];
  hallazgos: Hallazgo[] = [];
  semana: BarraSemana[] = [];
  topEndpoints: GrupoConteo[] = [];
  topServiciosPorVolumen: GrupoConteo[] = [];
  porDispositivoBarras: BarraSimple[] = [];
  masLentos: ServicioLatencia[] = [];

  // Tabla de funcionalidad
  filtroFuncion = '';
  ordenFunc: ClaveOrdenFunc = 'total';
  ordenFuncDesc = true;
  verTodasFunc = false;
  readonly limiteFunc = 12;

  // Logs del cliente filtrado
  readonly logsClienteLimit = 15;
  logsCliente: LogClienteItem[] = [];
  logsClienteTotal = 0;
  logsClienteCargando = false;
  logsClienteError: string | null = null;

  // Panel de detalle de errores
  detalleAbierto = false;
  detalleCargando = false;
  detalleError: string | null = null;
  detalleClase = '';
  detalleMetodo = '';
  detalleErrores: ErrorDetalleItem[] = [];
  detalleTotal = 0;
  detalleOffset = 0;
  readonly detalleLimit = 25;
  exportando = false;
  avisoExportacion: string | null = null;

  readonly fmtCompacto = fmtCompacto;
  readonly fmtSeg = fmtSeg;
  readonly fmtFechaCorta = fmtFechaCorta;
  readonly fmtFechaLarga = fmtFechaLarga;

  private readonly apiUrl = `${environment.apiUrl}/app-movil`;
  private catalogoServicios: ServicioCatalogo[] = [];
  private sAnalytics?: Subscription;
  private sSerie?: Subscription;
  private sLatencia?: Subscription;
  private sDetalle?: Subscription;
  private sLogs?: Subscription;
  private sCatalogo?: Subscription;

  constructor(private http: HttpClient, private tablero: TableroService) {}

  ngOnInit(): void {
    this.cargar();
    this.sCatalogo = this.http.get<CatalogoLogsResponse>(`${this.apiUrl}/logs/catalogo`).subscribe({
      next: (d) => { this.catalogoServicios = d.servicios || []; this.reordenarNombres(); },
      error: () => { /* los nombres técnicos humanizados bastan */ }
    });
  }

  ngOnChanges(c: SimpleChanges): void {
    if ((c['rango'] && !c['rango'].firstChange) || (c['refresco'] && !c['refresco'].firstChange)) {
      this.cargar();
      if (this.detalleAbierto && c['refresco']) this.cargarDetalle();
    }
    if (c['estado']) this.armarHallazgos();
  }

  ngOnDestroy(): void {
    [this.sAnalytics, this.sSerie, this.sLatencia, this.sDetalle, this.sLogs, this.sCatalogo].forEach((s) => s?.unsubscribe());
  }

  // --- Nombres legibles ---
  nombreServicioLegible(metodo: string): string {
    if (!metodo) return 'Servicio desconocido';
    const e = this.catalogoServicios.find((s) => s.metodo === metodo);
    return e ? e.etiqueta : this.humanizar(metodo);
  }
  private humanizar(t: string): string {
    const x = t.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
    return x.charAt(0).toUpperCase() + x.slice(1);
  }
  private reordenarNombres(): void {
    if (!this.datos) return;
    this.topEndpoints = this.calcularTopEndpoints(this.datos.topErrores || []);
    this.topServiciosPorVolumen = this.calcularTopServicios(this.datos.porFuncionalidad || []);
  }

  // --- Filtros ---
  get hayFiltrosActivos(): boolean { return !!this.dispositivoSeleccionado || !!this.documentoAplicado; }

  cambiarDispositivo(v: string): void { if (v === this.dispositivoSeleccionado) return; this.dispositivoSeleccionado = v; this.cargar(); }

  buscarPorDocumento(): void {
    const t = this.documentoInput.trim();
    this.errorDocumento = null;
    if (!t) { this.errorDocumento = 'Escribe un número de documento (CC) para buscar.'; return; }
    if (t.length > 30) { this.errorDocumento = 'El documento ingresado es demasiado largo.'; return; }
    if (t === this.documentoAplicado) return;
    this.documentoAplicado = t;
    this.cargar();
  }
  limpiarDocumento(): void {
    this.documentoInput = '';
    if (!this.documentoAplicado) return;
    this.documentoAplicado = '';
    this.errorDocumento = null;
    this.cargar();
  }
  limpiarFiltros(): void {
    if (!this.hayFiltrosActivos) return;
    this.dispositivoSeleccionado = ''; this.documentoInput = ''; this.documentoAplicado = ''; this.errorDocumento = null;
    this.cargar();
  }

  private paramsBase(): HttpParams {
    let p = paramsRango(this.rango);
    if (this.dispositivoSeleccionado) p = p.set('dispositivo', this.dispositivoSeleccionado);
    if (this.documentoAplicado) p = p.set('documento', this.documentoAplicado);
    return p;
  }

  // --- Carga ---
  cargar(): void {
    this.sAnalytics?.unsubscribe(); this.sSerie?.unsubscribe(); this.sLatencia?.unsubscribe();
    this.cargando = true; this.error = null;
    const refrescarDisp = !this.dispositivoSeleccionado;
    this.hoyTexto = this.aYmd(new Date());

    // Series ricas (sparklines, comparación, semana, latencia): solo sin filtros, vienen del ETL.
    if (!this.hayFiltrosActivos) {
      this.sSerie = this.tablero.serie(this.rango).subscribe({
        next: (r) => { this.serieDatos = r.disponible ? r : null; this.alActualizarSeries(); },
        error: () => { this.serieDatos = null; this.alActualizarSeries(); }
      });
      this.sLatencia = this.tablero.latencia(this.rango).subscribe({
        next: (r) => { this.latenciaDatos = r.disponible ? r : null; this.masLentos = this.latenciaDatos ? [...this.latenciaDatos.servicios].filter((s) => s.promedio !== null && s.llamadasMedidas >= 20).sort((a, b) => (b.promedio as number) - (a.promedio as number)).slice(0, 5) : []; this.armarHallazgos(); },
        error: () => { this.latenciaDatos = null; this.masLentos = []; this.armarHallazgos(); }
      });
    } else {
      this.serieDatos = null; this.latenciaDatos = null; this.masLentos = [];
    }

    this.sAnalytics = this.http.get<AnalyticsResponse>(`${this.apiUrl}/analytics`, { params: this.paramsBase() }).subscribe({
      next: (data) => {
        this.datos = data;
        this.resumen = data.resumen;
        this.topEndpoints = this.calcularTopEndpoints(data.topErrores || []);
        this.topServiciosPorVolumen = this.calcularTopServicios(data.porFuncionalidad || []);
        this.porDispositivoBarras = this.calcularBarras(data.porDispositivo || []);
        if (refrescarDisp) this.dispositivosDisponibles = (data.porDispositivo || []).map((d) => d.etiqueta);
        this.datosDesactualizados = !!data.desactualizado;
        this.cargando = false;
        this.cargado.emit(new Date());
        this.alActualizarSeries();
        if (this.documentoAplicado) this.cargarLogsCliente();
        else { this.logsCliente = []; this.logsClienteTotal = 0; this.logsClienteError = null; }
      },
      error: (err) => {
        console.error('Error cargando analítica de App Móvil:', err);
        this.error = err?.error?.error || 'No se pudo cargar la analítica de App Móvil.';
        this.cargando = false;
      }
    });
  }

  private aYmd(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Combina serie del ETL (si hay) o la tendencia de /analytics (vista filtrada) para los gráficos y KPIs.
  private alActualizarSeries(): void {
    if (this.serieDatos) {
      this.serieGrafico = this.serieDatos.serie;
      this.anteriorGrafico = this.serieDatos.anterior;
      this.armarSemana(this.serieDatos);
    } else if (this.datos) {
      this.serieGrafico = (this.datos.tendencia || []).map((p) => ({
        dia: p.dia, sinDato: false, total: p.total, errores: p.errores, exitosas: Math.max(0, p.total - p.errores),
        tasaExito: p.total > 0 ? Number((((p.total - p.errores) / p.total) * 100).toFixed(2)) : null,
        usuarios: 0, sesiones: 0, latenciaPromedio: null, latenciaMaxima: null, loginPromedio: null, actualizado: null
      }));
      this.anteriorGrafico = null;
      this.semana = [];
    }
    this.armarKpis();
    this.armarHallazgos();
  }

  // --- KPIs ---
  private claseDelta(v: number | null, subirEsBueno: boolean): string {
    if (v === null || v === 0) return 'delta delta--neutro';
    return (v > 0) === subirEsBueno ? 'delta delta--ok' : 'delta delta--mal';
  }
  private txtDelta(v: number | null, sufijo = '%'): string | null {
    if (v === null) return null;
    if (v === 0) return '= igual';
    return `${v > 0 ? '▲' : '▼'} ${Math.abs(v).toLocaleString('es-CO', { maximumFractionDigits: 1 })}${sufijo}`;
  }
  private tonoTasa(t: number | null): Tono {
    if (t === null) return '';
    return t >= 98 ? 'ok' : t >= 95 ? 'warn' : 'error';
  }

  private armarKpis(): void {
    const sd = this.serieDatos;
    const r = this.resumen;
    if (!r) { this.kpis = []; return; }
    const verde = 'var(--ax-chart-ok, #10b981)'; const rojo = 'var(--ax-chart-danger, #ef4444)'; const marca = 'var(--ax-brand-primary, #673ab7)';
    if (sd) {
      const s = sd.resumen; const d = sd.deltas;
      const serie = sd.serie.map((p) => (p.sinDato ? null : p));
      const prom = s.diasConDato ? Math.round(s.total / s.diasConDato) : 0;
      const nuevos: Kpi[] = [
        { clave: 'total', etiqueta: 'Transacciones', valor: s.total.toLocaleString('es-CO'), pie: `${fmtCompacto(prom)} por día · ${s.diasConDato} de ${s.diasTotales} días`, ayuda: 'Total de llamadas registradas en el rango.', tono: '', delta: this.txtDelta(d.total), claseDelta: this.claseDelta(d.total, true), spark: serie.map((p) => (p ? p.total : null)), sparkColor: marca },
        { clave: 'tasa', etiqueta: 'Efectividad', valor: s.tasaExito === null ? '—' : `${s.tasaExito.toLocaleString('es-CO')}%`, pie: 'Objetivo: 98% o más', ayuda: 'Porcentaje de transacciones sin error.', tono: this.tonoTasa(s.tasaExito), delta: this.txtDelta(d.tasaExitoPuntos, ' pts'), claseDelta: this.claseDelta(d.tasaExitoPuntos, true), spark: serie.map((p) => (p ? p.tasaExito : null)), sparkColor: this.tonoTasa(s.tasaExito) === 'error' ? rojo : verde },
        { clave: 'errores', etiqueta: 'Errores', valor: s.errores.toLocaleString('es-CO'), pie: s.total ? `${((s.errores / s.total) * 100).toLocaleString('es-CO', { maximumFractionDigits: 2 })}% de las transacciones` : 'Sin tráfico', ayuda: 'Llamadas que terminaron en error o excepción.', tono: '', delta: this.txtDelta(d.errores), claseDelta: this.claseDelta(d.errores, false), spark: serie.map((p) => (p ? p.errores : null)), sparkColor: rojo },
        { clave: 'usuarios', etiqueta: 'Usuarios por día', valor: s.usuariosPromedio.toLocaleString('es-CO'), pie: `Pico: ${s.usuariosPico.toLocaleString('es-CO')} en un día`, ayuda: 'Promedio de clientes distintos por día. Cada día se cuenta por separado, así que es exacto.', tono: '', delta: this.txtDelta(d.usuarios), claseDelta: this.claseDelta(d.usuarios, true), spark: serie.map((p) => (p ? p.usuarios : null)), sparkColor: marca },
        { clave: 'latencia', etiqueta: 'Tiempo de respuesta', valor: fmtSeg(s.latenciaPromedio), pie: 'Promedio entre todos los servicios', ayuda: 'Promedio de cuánto tardan las llamadas medidas (inicio → fin).', tono: s.latenciaPromedio === null ? '' : s.latenciaPromedio >= 5 ? 'error' : s.latenciaPromedio >= 2.5 ? 'warn' : 'ok', delta: this.txtDelta(d.latencia), claseDelta: this.claseDelta(d.latencia, false), spark: serie.map((p) => (p ? p.latenciaPromedio : null)), sparkColor: marca },
        { clave: 'login', etiqueta: 'Tiempo de login', valor: fmtSeg(s.loginPromedio), pie: 'UsersService.login_api', ayuda: 'Cuánto tarda en responder el inicio de sesión.', tono: s.loginPromedio === null ? '' : s.loginPromedio >= 4 ? 'error' : s.loginPromedio >= 2 ? 'warn' : 'ok', delta: this.txtDelta(d.login), claseDelta: this.claseDelta(d.login, false), spark: serie.map((p) => (p ? p.loginPromedio : null)), sparkColor: marca }
      ];
      this.kpis = nuevos;
      return;
    }
    // Vista filtrada: solo lo que entrega /analytics
    const ant = this.datos?.resumenAnterior || null;
    const dl = (a: number, b: number): number | null => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
    this.kpis = [
      { clave: 'total', etiqueta: 'Transacciones', valor: r.totalTransacciones.toLocaleString('es-CO'), pie: this.documentoAplicado ? 'De este cliente' : 'Con el filtro aplicado', ayuda: '', tono: '', delta: ant ? this.txtDelta(dl(r.totalTransacciones, ant.totalTransacciones)) : null, claseDelta: this.claseDelta(ant ? dl(r.totalTransacciones, ant.totalTransacciones) : null, true), spark: this.serieGrafico.map((p) => p.total), sparkColor: marca },
      { clave: 'tasa', etiqueta: 'Efectividad', valor: `${r.tasaExito}%`, pie: 'Objetivo: 98% o más', ayuda: '', tono: this.tonoTasa(r.tasaExito), delta: null, claseDelta: 'delta delta--neutro', spark: this.serieGrafico.map((p) => p.tasaExito), sparkColor: verde },
      { clave: 'errores', etiqueta: 'Errores', valor: r.totalErrores.toLocaleString('es-CO'), pie: 'Errores y excepciones', ayuda: '', tono: '', delta: ant ? this.txtDelta(dl(r.totalErrores, ant.totalErrores)) : null, claseDelta: this.claseDelta(ant ? dl(r.totalErrores, ant.totalErrores) : null, false), spark: this.serieGrafico.map((p) => p.errores), sparkColor: rojo },
      { clave: 'usuarios', etiqueta: this.documentoAplicado ? 'Sesiones' : 'Usuarios únicos', valor: (this.documentoAplicado ? r.sesionesDistintas : r.usuariosUnicos).toLocaleString('es-CO'), pie: r.conteosDistintosAproximados ? 'Aproximado: suma de usuarios por día' : 'Distintos en el rango', ayuda: '', tono: '', delta: null, claseDelta: 'delta delta--neutro', spark: [], sparkColor: marca }
    ];
    if (r.tiempoPromedioLoginSegundos !== null && r.tiempoPromedioLoginSegundos !== undefined) {
      this.kpis.push({ clave: 'login', etiqueta: 'Tiempo de login', valor: fmtSeg(r.tiempoPromedioLoginSegundos), pie: 'UsersService.login_api', ayuda: '', tono: '', delta: null, claseDelta: 'delta delta--neutro', spark: [], sparkColor: marca });
    }
  }

  // --- Día de la semana ---
  private armarSemana(sd: SerieResponse): void {
    const max = Math.max(1, ...sd.semana.map((d) => d.promedio));
    const top = sd.semana.reduce((m, d) => (d.promedio > m ? d.promedio : m), 0);
    this.semana = sd.semana.map((d) => ({ dia: d.dia, promedio: d.promedio, tasaError: d.tasaError, alto: Math.round((d.promedio / max) * 100), max: d.promedio === top && top > 0 }));
  }

  // --- Hallazgos automáticos ---
  armarHallazgos(): void {
    const h: Hallazgo[] = [];
    const sd = this.serieDatos;
    const r = this.resumen;
    if (!r) { this.hallazgos = []; return; }

    if (this.documentoAplicado) {
      h.push({ nivel: 'info', titulo: `Estás viendo solo al cliente ${this.documentoAplicado}`, detalle: 'Los hallazgos automáticos comparan el agregado general; quita el filtro para verlos.' });
      this.hallazgos = h; return;
    }

    const tasa = sd ? sd.resumen.tasaExito : r.tasaExito;
    if (tasa !== null && tasa !== undefined) {
      const pts = sd ? sd.deltas.tasaExitoPuntos : null;
      const compar = pts === null || pts === 0 ? '' : ` (${pts > 0 ? '+' : ''}${pts.toLocaleString('es-CO')} pts frente al período anterior)`;
      if (tasa < 95) h.push({ nivel: 'critico', titulo: `Efectividad baja: ${tasa.toLocaleString('es-CO')}%`, detalle: `Está por debajo del 95%${compar}. Revisa los servicios con más fallos más abajo.`, tab: 'errores', accion: 'Ver errores masivos' });
      else if (tasa < 98) h.push({ nivel: 'aviso', titulo: `Efectividad de ${tasa.toLocaleString('es-CO')}%, por debajo del objetivo (98%)`, detalle: `Hay margen de mejora${compar}.` });
      else h.push({ nivel: 'ok', titulo: `Efectividad saludable: ${tasa.toLocaleString('es-CO')}%`, detalle: `Cumple el objetivo de 98%${compar}.` });
    }

    if (sd) {
      const d = sd.deltas;
      if (d.total !== null && Math.abs(d.total) >= 15) {
        h.push({ nivel: 'info', titulo: `El tráfico ${d.total > 0 ? 'subió' : 'bajó'} ${Math.abs(d.total).toLocaleString('es-CO', { maximumFractionDigits: 0 })}% frente al período anterior`, detalle: `${sd.resumen.total.toLocaleString('es-CO')} transacciones contra ${sd.resumenAnterior.total.toLocaleString('es-CO')}.` });
      }
      if (d.errores !== null && d.errores >= 25 && sd.resumen.errores >= 50) {
        h.push({ nivel: 'aviso', titulo: `Los errores aumentaron ${Math.round(d.errores)}%`, detalle: `${sd.resumen.errores.toLocaleString('es-CO')} errores contra ${sd.resumenAnterior.errores.toLocaleString('es-CO')} del período anterior.` });
      }
      // Día con la peor tasa de error
      const dias = sd.serie.filter((p) => !p.sinDato && p.total >= 500 && p.dia !== this.hoyTexto);
      if (dias.length >= 4) {
        const tasasE = dias.map((p) => (p.errores / p.total) * 100);
        const media = tasasE.reduce((a, b) => a + b, 0) / tasasE.length;
        const idx = tasasE.indexOf(Math.max(...tasasE));
        if (tasasE[idx] >= media * 1.5 && tasasE[idx] - media >= 1.5) {
          h.push({ nivel: 'aviso', titulo: `Pico de errores el ${fmtFechaLarga(dias[idx].dia)}`, detalle: `Ese día fallaron ${tasasE[idx].toLocaleString('es-CO', { maximumFractionDigits: 1 })}% de las llamadas, frente a ${media.toLocaleString('es-CO', { maximumFractionDigits: 1 })}% en promedio.` });
        }
      }
      if (d.login !== null && d.login >= 30 && sd.resumen.loginPromedio !== null && sd.resumen.loginPromedio >= 1.5) {
        h.push({ nivel: 'aviso', titulo: `El login está ${Math.round(d.login)}% más lento`, detalle: `Promedio de ${fmtSeg(sd.resumen.loginPromedio)} en el rango.` });
      }
      if (sd.resumen.diasConDato < sd.resumen.diasTotales) {
        const faltan = sd.resumen.diasTotales - sd.resumen.diasConDato;
        h.push({ nivel: 'info', titulo: `Faltan ${faltan} día(s) del ETL en este rango`, detalle: 'Los totales solo suman los días que ya se calcularon; el relleno avanza solo.', tab: 'datos', accion: 'Ver estado de los datos' });
      }
    }

    // Servicios lentos que empeoran
    const empeoran = (this.latenciaDatos?.servicios || []).filter((s) => s.empeora).sort((a, b) => (b.deltaPct as number) - (a.deltaPct as number));
    if (empeoran.length) {
      const s = empeoran[0];
      h.push({ nivel: s.estado === 'critico' ? 'critico' : 'aviso', titulo: `${this.nombreServicioLegible(s.metodo)} se está poniendo más lento (+${Math.round(s.deltaPct as number)}%)`, detalle: `Pasó de ${fmtSeg(s.promedioAnterior)} a ${fmtSeg(s.promedio)} de promedio${empeoran.length > 1 ? `; hay ${empeoran.length - 1} servicio(s) más con la misma tendencia` : ''}.`, tab: 'servicios', accion: 'Ver servicios y latencia' });
    } else {
      const lento = (this.latenciaDatos?.servicios || []).filter((s) => s.estado === 'critico' && s.llamadasMedidas >= 50)[0];
      if (lento) h.push({ nivel: 'aviso', titulo: `${this.nombreServicioLegible(lento.metodo)} es lento: ${fmtSeg(lento.promedio)} de promedio`, detalle: `Supera los ${this.latenciaDatos?.umbrales.critico} s en ${lento.llamadasMedidas.toLocaleString('es-CO')} llamadas medidas.`, tab: 'servicios', accion: 'Ver servicios y latencia' });
    }

    // Servicio con más fallos
    const topE = this.datos?.topErrores?.[0];
    if (topE && topE.cantidadFallos >= 20 && r.totalErrores > 0) {
      const parte = Math.round((topE.cantidadFallos / r.totalErrores) * 100);
      if (parte >= 20) h.push({ nivel: 'info', titulo: `${this.nombreServicioLegible(topE.metodo)} concentra el ${parte}% de los errores`, detalle: `${topE.cantidadFallos.toLocaleString('es-CO')} fallos en el rango. Haz clic en «Servicios con más fallos» para ver el detalle.` });
    }

    // Alertas masivas
    const a = this.estado?.alertas;
    if (a && a.ultimas24h > 0) {
      const ult = a.recientes[0];
      h.push({ nivel: 'critico', titulo: `${a.ultimas24h} alerta(s) de error masivo en las últimas 24 horas`, detalle: ult ? `La más reciente: ${ult.titulo} (${ult.errores.toLocaleString('es-CO')} errores, ${ult.clientes.toLocaleString('es-CO')} clientes).` : 'Revisa el historial.', tab: 'errores', accion: 'Ver alertas' });
    }

    const orden = { critico: 0, aviso: 1, info: 2, ok: 3 };
    h.sort((x, y) => orden[x.nivel] - orden[y.nivel]);
    this.hallazgos = h.slice(0, 6);
  }

  // --- Rankings ---
  private calcularTopEndpoints(items: TopErrorItem[]): GrupoConteo[] {
    const max = items.length ? items[0].cantidadFallos : 1;
    return items.map((i) => ({ nombre: this.nombreServicioLegible(i.metodo), clase: i.clase, metodo: i.metodo, cantidad: i.cantidadFallos, porcentajeAncho: Math.round((i.cantidadFallos / (max || 1)) * 100) }));
  }
  private calcularTopServicios(items: FuncionalidadConteo[]): GrupoConteo[] {
    const p = items.slice(0, 6);
    const max = p.length ? p[0].total : 1;
    return p.map((i) => ({ nombre: this.nombreServicioLegible(i.metodo), clase: i.clase, metodo: i.metodo, cantidad: i.total, porcentajeAncho: Math.round((i.total / (max || 1)) * 100) }));
  }
  private calcularBarras(items: { etiqueta: string; total: number }[]): BarraSimple[] {
    const max = items.length ? Math.max(...items.map((i) => i.total)) : 1;
    return items.map((i) => ({ etiqueta: i.etiqueta, total: i.total, porcentajeAncho: Math.round((i.total / (max || 1)) * 100) }));
  }
  porcentajeDeTotal(total: number): number {
    const s = (this.datos?.porDispositivo || []).reduce((a, i) => a + i.total, 0) || 1;
    return Math.round((total / s) * 100);
  }

  // --- Tabla de funcionalidad ---
  get funcionesFiltradas(): FuncionalidadConteo[] {
    let l = [...(this.datos?.porFuncionalidad || [])];
    const q = this.filtroFuncion.trim().toLowerCase();
    if (q) l = l.filter((f) => `${f.clase} ${f.metodo} ${f.codigoServicio || ''} ${this.nombreServicioLegible(f.metodo)}`.toLowerCase().includes(q));
    const dir = this.ordenFuncDesc ? -1 : 1;
    const val = (f: FuncionalidadConteo): number | string => {
      switch (this.ordenFunc) {
        case 'errores': return f.errores;
        case 'tasaExito': return f.tasaExito;
        case 'tiempo': return f.tiempoPromedioSegundos ?? -1;
        case 'metodo': return this.nombreServicioLegible(f.metodo).toLowerCase();
        default: return f.total;
      }
    };
    l.sort((a, b) => { const x = val(a); const y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    return l;
  }
  get funcionesVisibles(): FuncionalidadConteo[] { const l = this.funcionesFiltradas; return this.verTodasFunc || this.filtroFuncion ? l : l.slice(0, this.limiteFunc); }
  get maxTotalFunc(): number { return Math.max(1, ...(this.datos?.porFuncionalidad || []).map((f) => f.total)); }
  ordenarFunc(c: ClaveOrdenFunc): void {
    if (this.ordenFunc === c) this.ordenFuncDesc = !this.ordenFuncDesc;
    else { this.ordenFunc = c; this.ordenFuncDesc = c !== 'metodo'; }
  }
  flecha(c: ClaveOrdenFunc): string { return this.ordenFunc === c ? (this.ordenFuncDesc ? ' ↓' : ' ↑') : ''; }

  // --- Logs del cliente ---
  private cargarLogsCliente(): void {
    this.sLogs?.unsubscribe();
    this.logsClienteCargando = true; this.logsClienteError = null;
    const params = this.paramsBase().set('limit', this.logsClienteLimit).set('offset', 0);
    this.sLogs = this.http.get<LogsResponse>(`${this.apiUrl}/logs`, { params }).subscribe({
      next: (d) => { this.logsCliente = d.resultados || []; this.logsClienteTotal = d.total || 0; this.logsClienteCargando = false; },
      error: (err) => { this.logsClienteError = err?.error?.error || 'No se pudieron cargar los logs de este cliente.'; this.logsCliente = []; this.logsClienteTotal = 0; this.logsClienteCargando = false; }
    });
  }

  // --- Detalle de errores ---
  abrirDetalle(clase: string, metodo: string): void {
    this.detalleAbierto = true; this.detalleClase = clase; this.detalleMetodo = metodo; this.detalleOffset = 0; this.detalleError = null; this.avisoExportacion = null;
    this.cargarDetalle();
  }
  cerrarDetalle(): void { this.detalleAbierto = false; this.detalleErrores = []; this.detalleError = null; this.avisoExportacion = null; }
  cargarDetalle(): void {
    this.sDetalle?.unsubscribe();
    this.detalleCargando = true; this.detalleError = null;
    const params = this.paramsBase().set('clase', this.detalleClase).set('metodo', this.detalleMetodo).set('limit', this.detalleLimit).set('offset', this.detalleOffset);
    this.sDetalle = this.http.get<ErroresDetalleResponse>(`${this.apiUrl}/errores-detalle`, { params }).subscribe({
      next: (d) => { this.detalleErrores = d.errores; this.detalleTotal = d.total; this.detalleCargando = false; },
      error: (err) => {
        this.detalleError = err?.error?.error || 'No se pudo cargar el detalle de errores. Intenta con un rango de fechas más corto.';
        this.detalleErrores = []; this.detalleTotal = 0; this.detalleCargando = false;
      }
    });
  }
  siguientePaginaDetalle(): void { if (this.detalleOffset + this.detalleLimit >= this.detalleTotal) return; this.detalleOffset += this.detalleLimit; this.cargarDetalle(); }
  anteriorPaginaDetalle(): void { if (this.detalleOffset === 0) return; this.detalleOffset = Math.max(0, this.detalleOffset - this.detalleLimit); this.cargarDetalle(); }
  get detallePaginaActual(): number { return Math.floor(this.detalleOffset / this.detalleLimit) + 1; }
  get detalleTotalPaginas(): number { return Math.max(1, Math.ceil(this.detalleTotal / this.detalleLimit)); }

  exportarErrores(): void {
    if (this.exportando) return;
    this.exportando = true; this.avisoExportacion = null;
    const params = this.paramsBase().set('clase', this.detalleClase).set('metodo', this.detalleMetodo);
    this.http.get(`${this.apiUrl}/errores-detalle/exportar`, { params, responseType: 'blob', observe: 'response' }).subscribe({
      next: (resp) => {
        const blob = resp.body;
        if (!blob) { this.avisoExportacion = 'No se pudo generar el archivo de exportación.'; this.exportando = false; return; }
        const disp = resp.headers.get('Content-Disposition') || '';
        const m = disp.match(/filename="?([^";]+)"?/);
        const nombre = m ? m[1] : 'errores_app_movil.csv';
        const truncado = resp.headers.get('X-Exportacion-Truncada') === 'true';
        const filas = resp.headers.get('X-Exportacion-Total-Filas');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        this.avisoExportacion = truncado ? `El archivo incluye las ${filas} filas más recientes (se alcanzó el límite de exportación). Ajusta los filtros o el rango de fechas para acotar el resultado.` : null;
        this.exportando = false;
      },
      error: () => { this.avisoExportacion = 'No se pudo generar el archivo de exportación.'; this.exportando = false; }
    });
  }
}
