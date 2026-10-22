import { Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  OperacionAnalisis, OperacionesResponse, PERIODOS_ANALISIS, PeriodoAnalisis, formatearDuracion, hoyLocalYMD, paramsPeriodo
} from './analisis-comun';
import { PasosAnalisisComponent } from './pasos-analisis.component';

// ============================================================================
// Vista de OPERACIONES de un cliente (GET /app-movil/operaciones)
// ----------------------------------------------------------------------------
// El log guarda varias filas por cada cosa que hace la app (inicio, llamada a ACE,
// respuesta, errores). Aquí las filas se agrupan en UNA operación con su duración
// real (de la fila de inicio a la de resultado, ±1 s), su estado y sus pasos con
// los códigos traducidos y el servicio ACE del catálogo.
// ============================================================================

type EstadoFiltro = '' | 'exito' | 'error' | 'advertencia' | 'sin_detalle';

@Component({
  selector: 'app-operaciones-cliente',
  standalone: true,
  imports: [CommonModule, FormsModule, PasosAnalisisComponent],
  templateUrl: './operaciones-cliente.component.html',
  styleUrl: './operaciones-cliente.component.scss'
})
export class OperacionesClienteComponent implements OnChanges, OnDestroy {
  @Input() documentoInicial = '';

  readonly periodos = PERIODOS_ANALISIS;
  readonly estados: { valor: EstadoFiltro; etiqueta: string }[] = [
    { valor: '', etiqueta: 'Todas' },
    { valor: 'error', etiqueta: 'Con error' },
    { valor: 'advertencia', etiqueta: 'Con aviso' },
    { valor: 'sin_detalle', etiqueta: 'Sin respuesta registrada' },
    { valor: 'exito', etiqueta: 'Correctas' }
  ];

  documento = '';
  periodo: PeriodoAnalisis = 'hoy';
  fechaMaxima = hoyLocalYMD();
  fechaDesde = hoyLocalYMD();
  fechaHasta = hoyLocalYMD();
  filtroEstado: EstadoFiltro = '';
  filtroMetodo = '';
  soloLentas = false;
  /** Métodos presentes en el periodo (se conserva aunque se filtre, para no vaciar el selector). */
  metodos: string[] = [];

  cargando = false;
  buscoAlMenosUnaVez = false;
  error: string | null = null;
  respuesta: OperacionesResponse | null = null;
  abiertas = new Set<number>();

  readonly formatearDuracion = formatearDuracion;
  private readonly apiUrl = `${environment.apiUrl}/app-movil`;
  private suscripcion?: Subscription;

  constructor(private http: HttpClient) {}

  ngOnChanges(c: SimpleChanges): void {
    if (c['documentoInicial'] && this.documentoInicial && this.documentoInicial !== this.documento) {
      this.documento = this.documentoInicial;
      this.consultar(true);
    }
  }

  ngOnDestroy(): void { this.suscripcion?.unsubscribe(); }

  elegirPeriodo(p: PeriodoAnalisis): void { this.periodo = p; }

  elegirEstado(e: EstadoFiltro): void {
    this.filtroEstado = e;
    if (this.respuesta) this.consultar(false);
  }

  consultar(reiniciarFiltros = true): void {
    const documento = this.documento.trim();
    if (documento.length < 4) {
      this.error = 'Escribe el documento completo del cliente (mínimo 4 caracteres).';
      return;
    }
    const p = paramsPeriodo(this.periodo, this.fechaDesde, this.fechaHasta);
    if (typeof p === 'string') { this.error = p; return; }
    if (reiniciarFiltros) { this.filtroEstado = ''; this.filtroMetodo = ''; }
    let params = new HttpParams().set('documento', documento);
    for (const [k, v] of Object.entries(p)) params = params.set(k, v);
    if (this.filtroEstado) params = params.set('estado', this.filtroEstado);
    if (this.filtroMetodo) params = params.set('metodo', this.filtroMetodo);

    this.suscripcion?.unsubscribe();
    this.cargando = true;
    this.error = null;
    this.buscoAlMenosUnaVez = true;
    this.suscripcion = this.http.get<OperacionesResponse>(`${this.apiUrl}/operaciones`, { params }).subscribe({
      next: (r) => {
        this.respuesta = r;
        if (!this.filtroEstado && !this.filtroMetodo) this.metodos = r.metodos;
        else if (!this.metodos.length) this.metodos = r.metodos;
        this.cargando = false;
        this.abiertas = new Set<number>();
      },
      error: (err: HttpErrorResponse) => {
        this.cargando = false;
        this.respuesta = null;
        this.error = err.error?.error || 'No se pudieron armar las operaciones. Intenta de nuevo.';
      }
    });
  }

  get operaciones(): OperacionAnalisis[] {
    const r = this.respuesta;
    if (!r) return [];
    return this.soloLentas ? r.operaciones.filter((o) => !!o.lentitud) : r.operaciones;
  }

  alternar(n: number): void {
    if (this.abiertas.has(n)) this.abiertas.delete(n); else this.abiertas.add(n);
  }

  textoEstado(o: OperacionAnalisis): string {
    switch (o.estado) {
      case 'exito': return 'Correcta';
      case 'error': return 'Con error';
      case 'advertencia': return 'Con aviso';
      default: return 'Sin respuesta registrada';
    }
  }

  clasePill(o: OperacionAnalisis): string {
    return o.estado === 'exito' ? 'pill--ok' : o.estado === 'error' ? 'pill--error' : o.estado === 'advertencia' ? 'pill--warn' : 'pill--info';
  }

  textoDuracion(o: OperacionAnalisis): string {
    if (o.duracionMs !== null) return formatearDuracion(o.duracionMs);
    return o.sinInicio ? 'sin inicio' : 'no medible';
  }

  trackN(_: number, o: OperacionAnalisis): number { return o.n; }
}
