import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  DatosConsumo, DatosFlota, DatosProblemas, DatosTendencia, EntornoFlota, OpcionesPortainerConsumo, OpcionesPortainerFlota,
  OpcionesPortainerProblemas, OpcionesPortainerTendencia, OpcionesWidget, TipoProblema, WidgetId,
} from '../../core/services/inicio.service';
import { InicioLineaComponent, SerieLinea } from './inicio-linea.component';
import { IdSel, InicioSelectorComponent, ItemSel } from './inicio-selector.component';

const sinTildes = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const VISIBLES_PROBLEMAS = 5;
const VISIBLES_SERVIDORES = 6;

const DEFECTOS: Record<string, OpcionesWidget> = {
  portainer_flota: { entornos: [], soloAtencion: false, orden: 'atencion' } satisfies OpcionesPortainerFlota,
  portainer_problemas: { entornos: [], tipos: ['reiniciando', 'insano'] } satisfies OpcionesPortainerProblemas,
  portainer_consumo: { entornos: [], metrica: 'cpu', cantidad: 6 } satisfies OpcionesPortainerConsumo,
  portainer_tendencia: { entornos: [], horas: 6, metrica: 'cpu', agrupar: 'total' } satisfies OpcionesPortainerTendencia,
};

// Cuadros de Portainer del Inicio: servidores (estilo consola), contenedores con problemas, mayores consumidores y tendencia.
// Cada uno tiene su propia fila de filtros; lo que elige la persona se guarda por usuario (lo hace el Inicio).
@Component({
  selector: 'app-inicio-portainer',
  standalone: true,
  imports: [CommonModule, FormsModule, InicioLineaComponent, InicioSelectorComponent],
  templateUrl: './inicio-portainer.component.html',
  styleUrl: './inicio-portainer.component.scss',
})
export class InicioPortainerComponent {
  @Input() id: WidgetId = 'portainer_flota';
  @Input() datos: unknown = null;
  @Input() opciones: OpcionesWidget | null = null;
  @Output() opcionesChange = new EventEmitter<OpcionesWidget>();
  @Output() restablecer = new EventEmitter<void>();

  busca = '';
  verTodos = false;
  verTodosServidores = false;
  readonly visiblesProblemas = VISIBLES_PROBLEMAS;
  readonly visiblesServidores = VISIBLES_SERVIDORES;

  // ---- Opciones ----
  get op(): OpcionesWidget { return { ...(DEFECTOS[this.id] ?? {}), ...(this.opciones ?? {}) }; }
  get hayFiltro(): boolean {
    const d = DEFECTOS[this.id] ?? {};
    const o = this.op as Record<string, unknown>;
    return Object.keys(d).some((k) => JSON.stringify(o[k]) !== JSON.stringify((d as Record<string, unknown>)[k]));
  }
  cambiar(parcial: OpcionesWidget): void { this.opcionesChange.emit({ ...this.op, ...parcial }); }
  elegirEntornos(ids: IdSel[]): void { this.cambiar({ entornos: ids.map(Number) }); }
  limpiar(): void { this.busca = ''; this.verTodos = false; this.verTodosServidores = false; this.restablecer.emit(); }

  // ---- Datos tipados ----
  get flota(): DatosFlota | null { return this.id === 'portainer_flota' ? (this.datos as DatosFlota | null) : null; }
  get problemas(): DatosProblemas | null { return this.id === 'portainer_problemas' ? (this.datos as DatosProblemas | null) : null; }
  get consumo(): DatosConsumo | null { return this.id === 'portainer_consumo' ? (this.datos as DatosConsumo | null) : null; }
  get tendencia(): DatosTendencia | null { return this.id === 'portainer_tendencia' ? (this.datos as DatosTendencia | null) : null; }

  get itemsEntornos(): ItemSel[] {
    const cat = (this.datos as { catalogo?: { id: number; nombre: string; estado: string }[] } | null)?.catalogo ?? [];
    return cat.map((e) => ({ id: e.id, nombre: e.nombre, apagado: e.estado !== 'up', detalle: e.estado !== 'up' ? 'sin conexión' : null }));
  }
  get entornosSel(): IdSel[] { return (this.op.entornos ?? []) as IdSel[]; }

  // ---- Flota ----
  get opFlota(): OpcionesPortainerFlota { return this.op as OpcionesPortainerFlota; }
  alternarAtencion(): void { this.cambiar({ soloAtencion: !this.opFlota.soloAtencion }); }
  cambiarOrden(v: string): void { this.cambiar({ orden: v as OpcionesPortainerFlota['orden'] }); }
  claseMedidor(p: number | null): string { return p === null ? '' : p >= 85 ? 'alto' : p >= 70 ? 'medio' : ''; }
  puntoClase(e: EntornoFlota): string { return e.estado !== 'up' || e.grave ? 'mal' : e.atencion ? 'aviso' : ''; }
  trackE = (_: number, e: EntornoFlota): number => e.id;

  // ---- Problemas ----
  get opProb(): OpcionesPortainerProblemas { return this.op as OpcionesPortainerProblemas; }
  tipoActivo(t: TipoProblema): boolean { return this.opProb.tipos.includes(t); }
  alternarTipo(t: TipoProblema): void {
    const hay = this.tipoActivo(t);
    const nuevos = hay ? this.opProb.tipos.filter((x) => x !== t) : [...this.opProb.tipos, t];
    this.cambiar({ tipos: nuevos.length ? nuevos : [t] });
  }
  etiquetaTipo(t: TipoProblema): string { return t === 'detenido' ? '■ Detenido' : t === 'reiniciando' ? '↻ Reiniciando' : '⚠ Sin salud'; }
  claseTipo(t: TipoProblema): string { return t === 'detenido' ? 'est-nulo' : t === 'reiniciando' ? 'est-aviso' : 'est-mal'; }
  get filasProblemas(): NonNullable<DatosProblemas['filas']> {
    const q = sinTildes(this.busca.trim());
    const todas = this.problemas?.filas ?? [];
    return q ? todas.filter((f) => sinTildes(`${f.contenedor} ${f.imagen} ${f.entorno}`).includes(q)) : todas;
  }
  get filasVisibles(): NonNullable<DatosProblemas['filas']> { return this.verTodos ? this.filasProblemas : this.filasProblemas.slice(0, VISIBLES_PROBLEMAS); }
  alternarVerTodos(): void { this.verTodos = !this.verTodos; }
  alternarServidores(): void { this.verTodosServidores = !this.verTodosServidores; }
  get servidoresVisibles(): EntornoFlota[] { const l = this.flota?.entornos ?? []; return this.verTodosServidores ? l : l.slice(0, VISIBLES_SERVIDORES); }
  sinConexionNombres(d: DatosProblemas): string {
    const l = d.sinConexion ?? [];
    return l.slice(0, 4).map((x) => x.nombre).join(', ') + (l.length > 4 ? ` y ${l.length - 4} más` : '');
  }

  // ---- Consumo ----
  get opCons(): OpcionesPortainerConsumo { return this.op as OpcionesPortainerConsumo; }
  elegirMetrica(m: 'cpu' | 'mem'): void { this.cambiar({ metrica: m }); }
  elegirCantidad(v: number | string): void { this.cambiar({ cantidad: Number(v) as OpcionesPortainerConsumo['cantidad'] }); }
  maxCpu(): number { return Math.max(1, ...(this.consumo?.porCpu ?? []).map((c) => c.cpu)); }
  maxMem(): number { return Math.max(1, ...(this.consumo?.porMem ?? []).map((c) => c.memMb)); }

  // ---- Tendencia ----
  get opTend(): OpcionesPortainerTendencia { return this.op as OpcionesPortainerTendencia; }
  readonly rangos: { v: OpcionesPortainerTendencia['horas']; t: string }[] = [{ v: 1, t: '1 h' }, { v: 6, t: '6 h' }, { v: 24, t: '24 h' }, { v: 168, t: '7 d' }];
  private cacheSeries: { datos: unknown; metrica: string; valor: SerieLinea[] } | null = null;
  get seriesTendencia(): SerieLinea[] {
    const d = this.tendencia;
    const cpu = this.opTend.metrica === 'cpu';
    if (this.cacheSeries && this.cacheSeries.datos === d && this.cacheSeries.metrica === this.opTend.metrica) return this.cacheSeries.valor;
    let valor: SerieLinea[];
    if (d?.agrupar === 'servidor') {
      valor = (d.series ?? []).map((s, i) => ({ nombre: s.nombre, color: `var(--ix-c${(i % 8) + 1})`, puntos: s.puntos.map((p) => ({ t: p.t, v: cpu ? p.cpu : p.memGb })) }));
    } else {
      valor = [{ nombre: cpu ? 'CPU promedio de contenedores' : 'Memoria usada por contenedores', color: 'var(--ix-s1)', puntos: (d?.puntos ?? []).map((p) => ({ t: p.t, v: cpu ? p.cpu : p.memGb })) }];
    }
    this.cacheSeries = { datos: d, metrica: this.opTend.metrica, valor };
    return valor;
  }
  get fmtTend(): (v: number) => string { return this.opTend.metrica === 'cpu' ? this.fmtCpu : this.fmtGb; }
  get rangoTexto(): string { const h = this.opTend.horas; return h === 1 ? 'la última hora' : h === 168 ? 'los últimos 7 días' : `las últimas ${h} horas`; }

  // ---- Formato ----
  fmtCpu = (v: number): string => `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(v)} %`;
  fmtGb = (v: number): string => `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(v)} GB`;
  n(v: number | null | undefined): string { return v === null || v === undefined ? '—' : new Intl.NumberFormat('es-CO').format(v); }
  d1(v: number | null | undefined): string { return v === null || v === undefined ? '—' : new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(v); }
  mb(v: number): string { return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`; }
  pct(parte: number, total: number): number { return total > 0 ? Math.round((parte / total) * 100) : 0; }
}
