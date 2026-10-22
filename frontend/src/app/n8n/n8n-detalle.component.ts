import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { StackedBarChartComponent, SerieBarrasApiladas } from '../shared/charts/stacked-bar-chart.component';
import { BarListComponent, ItemBarList } from '../shared/charts/bar-list.component';
import { SparklineComponent } from '../shared/charts/sparkline.component';
import {
  EjecucionReciente, FlujoN8n, N8N_BASE_URL, PuntoSerie, claseEstado, claseTasa, etiquetaEstado, fmtDec, fmtDuracion, fmtFecha, fmtHora, fmtNum,
  fmtPct, fmtRelativo, mensajeHttp,
} from './n8n-utils';

interface ErrorFlujo { ejecucionId: string; fecha: string; estado: string; nodo: string | null; mensaje: string | null; }
interface NodoFlujo { nombre: string; tipo: string; deshabilitado: boolean; }

interface DetalleRespuesta {
  flujo: FlujoN8n;
  periodo: { dias: number; unidadSerie: 'hora' | 'dia' };
  serie: { unidad: 'hora' | 'dia'; puntos: PuntoSerie[] };
  porHora: { hora: number; exitosas: number; fallidas: number; otras: number; total: number }[];
  porModo: { modo: string; etiqueta: string; cantidad: number }[];
  ejecuciones: EjecucionReciente[];
  nodos: NodoFlujo[];
  tiposNodo: { tipo: string; cantidad: number }[];
  conexiones: number | null;
  errores: ErrorFlujo[];
  truncado: boolean;
}

// Modal con todo lo que se sabe de UN flujo: métricas, tendencia, errores con el
// nodo que falló, últimas ejecuciones y estructura (sin parámetros ni credenciales).
@Component({
  selector: 'app-n8n-detalle',
  standalone: true,
  imports: [CommonModule, StackedBarChartComponent, BarListComponent, SparklineComponent],
  templateUrl: './n8n-detalle.component.html',
  styleUrl: './n8n-detalle.component.scss',
})
export class N8nDetalleComponent implements OnChanges {
  @Input({ required: true }) flujo!: FlujoN8n;      // resumen que ya trae el listado
  @Input() dias = 7;
  @Input() puedeEditar = false;
  @Input() esAdmin = false;
  @Output() cerrar = new EventEmitter<void>();

  cargando = true;
  error: string | null = null;
  d: DetalleRespuesta | null = null;
  verNodos = false;

  etiquetasSerie: string[] = [];
  seriesSerie: SerieBarrasApiladas[] = [];
  etiquetasHora: string[] = [];
  seriesHora: SerieBarrasApiladas[] = [];
  modos: ItemBarList[] = [];
  tipos: ItemBarList[] = [];

  readonly n8nBaseUrl = N8N_BASE_URL;
  readonly fmtNum = fmtNum; readonly fmtDec = fmtDec; readonly fmtPct = fmtPct; readonly fmtDuracion = fmtDuracion;
  readonly fmtFecha = fmtFecha; readonly fmtHora = fmtHora; readonly fmtRelativo = fmtRelativo;
  readonly claseEstado = claseEstado; readonly claseTasa = claseTasa; readonly etiquetaEstado = etiquetaEstado;

  constructor(private http: HttpClient) {}

  ngOnChanges(c: SimpleChanges): void {
    if (c['flujo'] || c['dias']) this.cargar();
  }

  get f(): FlujoN8n { return this.d?.flujo || this.flujo; }

  private cargar(): void {
    this.cargando = true;
    this.error = null;
    this.d = null;
    const tz = new Date().getTimezoneOffset();
    this.http.get<DetalleRespuesta>(`${environment.apiUrl}/n8n/workflows/${encodeURIComponent(this.flujo.id)}/detalle`, { params: { dias: this.dias, tz } }).subscribe({
      next: (d) => {
        this.d = d;
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
        this.modos = d.porModo.map((m) => ({ nombre: m.etiqueta, total: m.cantidad }));
        this.tipos = d.tiposNodo.slice(0, 8).map((t) => ({ nombre: t.tipo, total: t.cantidad }));
        this.cargando = false;
      },
      error: (err) => { this.error = mensajeHttp(err, 'No se pudo cargar el detalle del flujo.'); this.cargando = false; },
    });
  }

  get unidadSerie(): string { return this.d?.serie.unidad === 'hora' ? 'por hora' : 'por día'; }
  get nodosActivos(): NodoFlujo[] { return (this.d?.nodos || []).filter((n) => !n.deshabilitado); }
  get nodosApagados(): number { return (this.d?.nodos || []).filter((n) => n.deshabilitado).length; }
  trackEj(_i: number, e: { id: string }): string { return e.id; }
}
