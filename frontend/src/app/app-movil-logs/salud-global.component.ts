import { Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  AlertaDetalleResponse, AlertasResponse, AlertaResumen, BaseMuestra, CodigoDiccionario, CodigoVisto, CodigosResponse,
  ErroresMasivosResponse, LatenciaAce, LatenciaResponse, LatenciaServicio, ResumenDuracion, formatearDuracion, hoyLocalYMD, pct
} from './analisis-comun';
import { CausaErrorComponent } from './causa-error.component';

// ============================================================================
// Salud global de App Móvil: latencia por servicio, errores masivos, alertas y
// diccionario de códigos. Todo sale de una MUESTRA acotada de LogApp (la última
// ventana de minutos o una hora histórica), no del día completo, y la pantalla lo
// dice siempre. Los percentiles se calculan solo con llamadas que tienen fila de
// inicio y de resultado; las demás se cuentan aparte ("sin medir").
// ============================================================================

export type SubSalud = 'latencia' | 'errores' | 'alertas' | 'codigos';
type ClaveOrden = 'servicio' | 'llamadas' | 'medidas' | 'p50' | 'p90' | 'p95' | 'max' | 'tasaError' | 'sinMedir';

@Component({
  selector: 'app-salud-global',
  standalone: true,
  imports: [CommonModule, FormsModule, CausaErrorComponent],
  templateUrl: './salud-global.component.html',
  styleUrl: './salud-global.component.scss'
})
export class SaludGlobalComponent implements OnInit, OnChanges, OnDestroy {
  @Input() subInicial: SubSalud = 'latencia';
  @Input() alertaInicial: number | null = null;

  readonly subs: { valor: SubSalud; etiqueta: string }[] = [
    { valor: 'latencia', etiqueta: 'Latencia por servicio' },
    { valor: 'errores', etiqueta: 'Errores masivos' },
    { valor: 'alertas', etiqueta: 'Historial de alertas' },
    { valor: 'codigos', etiqueta: 'Códigos traducidos' }
  ];
  sub: SubSalud = 'latencia';

  readonly ventanas = [5, 15, 30, 60, 120];
  ventanaMin = 15;
  modoHistorico = false;
  fechaHistorica = '';
  horaHistorica = 9;
  readonly horas = Array.from({ length: 24 }, (_, i) => i);
  fechaMaxima = hoyLocalYMD();

  cargando = false;
  error: string | null = null;

  latencia: LatenciaResponse | null = null;
  errores: ErroresMasivosResponse | null = null;
  codigos: CodigosResponse | null = null;
  alertas: AlertasResponse | null = null;
  alertaDetalle: AlertaDetalleResponse | null = null;
  alertaSeleccionada: number | null = null;
  cargandoDetalle = false;

  // Latencia
  orden: ClaveOrden = 'p95';
  ordenDesc = true;
  soloConErrores = false;
  filtroTexto = '';
  abiertos = new Set<string>();
  verAce = false;

  // Errores
  verTodasCausas = false;

  // Códigos
  verDiccionario = false;
  filtroCodigo = '';

  readonly formatearDuracion = formatearDuracion;
  readonly pct = pct;
  private readonly apiUrl = `${environment.apiUrl}/app-movil`;
  private suscripcion?: Subscription;
  private suscripcionDetalle?: Subscription;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.sub = this.subInicial;
    this.cargar();
    if (this.alertaInicial) this.abrirAlerta(this.alertaInicial);
  }

  ngOnChanges(c: SimpleChanges): void {
    if (c['alertaInicial'] && !c['alertaInicial'].firstChange && this.alertaInicial) {
      this.sub = 'alertas';
      this.cargar();
      this.abrirAlerta(this.alertaInicial);
    }
  }

  ngOnDestroy(): void {
    this.suscripcion?.unsubscribe();
    this.suscripcionDetalle?.unsubscribe();
  }

  cambiarSub(s: SubSalud): void {
    this.sub = s;
    this.error = null;
    this.cargar(s === 'alertas');
  }

  elegirVentana(v: number): void { this.ventanaMin = v; this.modoHistorico = false; this.aplicarVentana(); }

  activarHistorico(): void {
    this.modoHistorico = true;
    if (!this.fechaHistorica) this.fechaHistorica = this.fechaMaxima;
  }

  private parametros(): HttpParams {
    let p = new HttpParams().set('ventana', String(this.ventanaMin));
    if (this.modoHistorico && this.fechaHistorica) p = p.set('fecha', this.fechaHistorica).set('hora', String(this.horaHistorica));
    return p;
  }

  /** Carga los datos de la sub-pestaña activa (si ya los tiene y no se pide forzar, no repite la consulta). */
  cargar(forzar = true): void {
    const s = this.sub;
    if (!forzar) {
      if ((s === 'latencia' && this.latencia) || (s === 'errores' && this.errores) || (s === 'codigos' && this.codigos) || (s === 'alertas' && this.alertas)) return;
    }
    if (this.modoHistorico && !this.fechaHistorica && s !== 'alertas') {
      this.error = 'Elige la fecha del análisis histórico.';
      return;
    }
    this.suscripcion?.unsubscribe();
    this.cargando = true;
    this.error = null;
    const manejarError = (err: HttpErrorResponse): void => {
      this.cargando = false;
      this.error = err.error?.error || 'No se pudo cargar el análisis. Intenta de nuevo.';
    };
    if (s === 'latencia') {
      this.suscripcion = this.http.get<LatenciaResponse>(`${this.apiUrl}/latencia`, { params: this.parametros() }).subscribe({
        next: (r) => { this.latencia = r; this.cargando = false; }, error: manejarError
      });
    } else if (s === 'errores') {
      let p = this.parametros();
      if (this.verTodasCausas) p = p.set('todas', '1');
      this.suscripcion = this.http.get<ErroresMasivosResponse>(`${this.apiUrl}/errores-masivos`, { params: p }).subscribe({
        next: (r) => { this.errores = r; this.cargando = false; }, error: manejarError
      });
    } else if (s === 'codigos') {
      this.suscripcion = this.http.get<CodigosResponse>(`${this.apiUrl}/codigos`, { params: this.parametros() }).subscribe({
        next: (r) => { this.codigos = r; this.cargando = false; }, error: manejarError
      });
    } else {
      this.suscripcion = this.http.get<AlertasResponse>(`${this.apiUrl}/alertas-masivas`).subscribe({
        next: (r) => { this.alertas = r; this.cargando = false; }, error: manejarError
      });
    }
  }

  /** Recarga todas las sub-pestañas con la ventana nueva (las que ya se habían abierto). */
  aplicarVentana(): void {
    this.latencia = null; this.errores = null; this.codigos = null;
    this.cargar(true);
  }

  alternarTodasCausas(): void { this.verTodasCausas = !this.verTodasCausas; this.cargar(true); }

  // ---------------------------------------------------------------- alertas
  abrirAlerta(id: number): void {
    this.alertaSeleccionada = id;
    this.alertaDetalle = null;
    this.cargandoDetalle = true;
    this.suscripcionDetalle?.unsubscribe();
    this.suscripcionDetalle = this.http.get<AlertaDetalleResponse>(`${this.apiUrl}/alertas-masivas/${id}`).subscribe({
      next: (r) => { this.alertaDetalle = r; this.cargandoDetalle = false; },
      error: (err: HttpErrorResponse) => { this.cargandoDetalle = false; this.error = err.error?.error || 'No se pudo abrir la alerta.'; }
    });
  }

  tasaAlerta(a: AlertaResumen): string { return pct(Number(a.TasaError), 0); }

  // ---------------------------------------------------------------- latencia
  ordenarPor(c: ClaveOrden): void {
    if (this.orden === c) this.ordenDesc = !this.ordenDesc; else { this.orden = c; this.ordenDesc = c !== 'servicio'; }
  }

  flecha(c: ClaveOrden): string { return this.orden === c ? (this.ordenDesc ? '▾' : '▴') : ''; }

  private valorOrden(s: LatenciaServicio, c: ClaveOrden): number | string {
    switch (c) {
      case 'servicio': return s.servicio.toLowerCase();
      case 'llamadas': return s.llamadas;
      case 'medidas': return s.todas.n;
      case 'p50': return s.todas.p50Ms ?? -1;
      case 'p90': return s.todas.p90Ms ?? -1;
      case 'p95': return s.todas.p95Ms ?? -1;
      case 'max': return s.todas.maxMs ?? -1;
      case 'tasaError': return s.tasaError;
      default: return s.sinMedir;
    }
  }

  get filasLatencia(): LatenciaServicio[] {
    const l = this.latencia;
    if (!l) return [];
    const texto = this.filtroTexto.trim().toLowerCase();
    const filtradas = l.latencia.filter((s) => (!this.soloConErrores || s.errores > 0) && (!texto || s.servicio.toLowerCase().includes(texto) || s.metodo.toLowerCase().includes(texto)));
    const dir = this.ordenDesc ? -1 : 1;
    return filtradas.sort((a, b) => {
      const va = this.valorOrden(a, this.orden); const vb = this.valorOrden(b, this.orden);
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }

  get filasAce(): LatenciaAce[] {
    return (this.latencia?.ace ?? []).slice().sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1));
  }

  alternarServicio(clave: string): void {
    if (this.abiertos.has(clave)) this.abiertos.delete(clave); else this.abiertos.add(clave);
  }

  /** Porcentaje de llamadas que no se pudieron medir: si es alto, los tiempos pueden estar sesgados. */
  sesgo(s: LatenciaServicio): number { return s.llamadas ? s.sinMedir / s.llamadas : 0; }

  claseDuracion(ms: number | null): string {
    if (ms === null) return '';
    return ms >= 15000 ? 'dur-muy-lenta' : ms >= 5000 ? 'dur-lenta' : '';
  }

  marcaConfianza(r: ResumenDuracion): string { return r.n > 0 && !r.confiable95 ? '*' : ''; }

  // ------------------------------------------------------------------ códigos
  get vistosFiltrados(): CodigoVisto[] {
    const t = this.filtroCodigo.trim().toLowerCase();
    const v = this.codigos?.vistos ?? [];
    return t ? v.filter((c) => `${c.codigo} ${c.tipo} ${c.significado}`.toLowerCase().includes(t)) : v;
  }

  get diccionarioFiltrado(): CodigoDiccionario[] {
    const t = this.filtroCodigo.trim().toLowerCase();
    const d = this.codigos?.diccionario ?? [];
    return t ? d.filter((c) => `${c.codigo} ${c.tipo} ${c.significado}`.toLowerCase().includes(t)) : d;
  }

  textoCategoria(c: string): string {
    const m: Record<string, string> = { ok: 'Correcto', sin_datos: 'Sin datos', timeout: 'Tiempo agotado', error: 'Error', info: 'Informativo', desconocido: 'Sin traducción' };
    return m[c] ?? c;
  }

  claseCategoria(c: string): string {
    return c === 'ok' ? 'pill--ok' : c === 'error' ? 'pill--error' : c === 'timeout' ? 'pill--warn' : c === 'sin_datos' ? 'pill--info' : '';
  }

  /** Encabezado común: de qué periodo es la muestra. */
  textoPeriodo(b: BaseMuestra): string {
    return b.modo === 'historico'
      ? `Hora histórica ${b.fecha} ${String(b.hora).padStart(2, '0')}:00 (ventana de ${b.ventanaMin} min)`
      : `Últimos ${b.ventanaMin} minutos (hora de la base de datos: ${b.relojBd})`;
  }

  trackClave(_: number, s: LatenciaServicio): string { return s.metodo; }
  trackCausa(_: number, c: { clave: string }): string { return c.clave; }
}
