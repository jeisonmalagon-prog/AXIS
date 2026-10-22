import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatosF5Salud, DatosF5Trafico, OpcionesF5Salud, OpcionesF5Trafico, OpcionesWidget, VirtualSalud, WidgetId } from '../../core/services/inicio.service';
import { InicioLineaComponent, SerieLinea } from './inicio-linea.component';
import { IdSel, InicioSelectorComponent, ItemSel } from './inicio-selector.component';

const sinTildes = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const DEFECTOS: Record<string, OpcionesWidget> = {
  f5_trafico: { dispositivos: [], horas: 3 } satisfies OpcionesF5Trafico,
  f5_salud: { dispositivos: [], soloProblemas: false } satisfies OpcionesF5Salud,
};

// Cuadros de F5 del Inicio: tráfico de nodos (rango y equipo elegibles) y salud de Virtual Servers (búsqueda y filtro).
@Component({
  selector: 'app-inicio-f5',
  standalone: true,
  imports: [CommonModule, FormsModule, InicioLineaComponent, InicioSelectorComponent],
  templateUrl: './inicio-f5.component.html',
  styleUrl: './inicio-f5.component.scss',
})
export class InicioF5Component {
  @Input() id: WidgetId = 'f5_trafico';
  @Input() datos: unknown = null;
  @Input() opciones: OpcionesWidget | null = null;
  @Output() opcionesChange = new EventEmitter<OpcionesWidget>();
  @Output() restablecer = new EventEmitter<void>();

  busca = '';
  verTodos = false;

  get op(): OpcionesWidget { return { ...(DEFECTOS[this.id] ?? {}), ...(this.opciones ?? {}) }; }
  get hayFiltro(): boolean {
    const d = DEFECTOS[this.id] ?? {};
    const o = this.op as Record<string, unknown>;
    return Object.keys(d).some((k) => JSON.stringify(o[k]) !== JSON.stringify((d as Record<string, unknown>)[k]));
  }
  cambiar(parcial: OpcionesWidget): void { this.opcionesChange.emit({ ...this.op, ...parcial }); }
  elegirDispositivos(ids: IdSel[]): void { this.cambiar({ dispositivos: ids.map(String) }); }
  limpiar(): void { this.busca = ''; this.verTodos = false; this.restablecer.emit(); }
  get dispSel(): IdSel[] { return (this.op.dispositivos ?? []) as IdSel[]; }

  get trafico(): DatosF5Trafico | null { return this.id === 'f5_trafico' ? (this.datos as DatosF5Trafico | null) : null; }
  get salud(): DatosF5Salud | null { return this.id === 'f5_salud' ? (this.datos as DatosF5Salud | null) : null; }
  get itemsDisp(): ItemSel[] {
    const cat = (this.datos as { catalogo?: { id: string; nombre: string }[] } | null)?.catalogo ?? [];
    return cat.map((d) => ({ id: d.id, nombre: d.nombre }));
  }

  // ---- Tráfico ----
  get opTraf(): OpcionesF5Trafico { return this.op as OpcionesF5Trafico; }
  readonly rangos: { v: OpcionesF5Trafico['horas']; t: string }[] = [{ v: 1, t: '1 h' }, { v: 3, t: '3 h' }, { v: 6, t: '6 h' }, { v: 24, t: '24 h' }];
  private cache: { datos: unknown; valor: SerieLinea[] } | null = null;
  get series(): SerieLinea[] {
    const d = this.trafico;
    if (this.cache && this.cache.datos === d) return this.cache.valor;
    const valor: SerieLinea[] = [
      { nombre: 'Entrada', color: 'var(--ix-s1)', puntos: (d?.puntos ?? []).map((p) => ({ t: p.t, v: p.inBps })) },
      { nombre: 'Salida', color: 'var(--ix-s2)', puntos: (d?.puntos ?? []).map((p) => ({ t: p.t, v: p.outBps })) },
    ];
    this.cache = { datos: d, valor };
    return valor;
  }
  maxNodo(): number { return Math.max(1, ...(this.trafico?.topNodos ?? []).map((c) => c.bps)); }
  get rangoTexto(): string { const h = this.opTraf.horas; return h === 1 ? 'la última hora' : `las últimas ${h} horas`; }

  // ---- Salud ----
  get opSalud(): OpcionesF5Salud { return this.op as OpcionesF5Salud; }
  alternarProblemas(): void { this.cambiar({ soloProblemas: !this.opSalud.soloProblemas }); }
  alternarVerTodos(): void { this.verTodos = !this.verTodos; }
  get listaVs(): VirtualSalud[] {
    const q = sinTildes(this.busca.trim());
    const todos = this.salud?.virtuales ?? [];
    return q ? todos.filter((v) => sinTildes(`${v.nombre} ${v.destino ?? ''} ${v.dispositivo}`).includes(q)) : todos;
  }
  get listaVisible(): VirtualSalud[] { return this.verTodos ? this.listaVs : this.listaVs.slice(0, 8); }
  etiquetaVs(v: VirtualSalud): string {
    if (v.clase === 'offline') return 'Sin servicio';
    if (v.clase === 'deshabilitado') return 'Deshabilitado';
    if (v.clase === 'desconocido') return 'Desconocido';
    return v.problema ? 'Nodos caídos' : 'Disponible';
  }
  claseVs(v: VirtualSalud): string {
    return v.clase === 'offline' ? 'est-mal' : v.clase === 'desconocido' || v.problema ? 'est-aviso' : v.clase === 'deshabilitado' ? 'est-nulo' : 'est-ok';
  }

  // ---- Formato ----
  fmtBps = (bps: number): string => {
    const u = ['b/s', 'Kb/s', 'Mb/s', 'Gb/s'];
    let v = bps; let i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: v >= 100 ? 0 : 1 }).format(v)} ${u[i]}`;
  };
  n(v: number | null | undefined): string { return v === null || v === undefined ? '—' : new Intl.NumberFormat('es-CO').format(v); }
  pct(parte: number, total: number): number { return total > 0 ? Math.round((parte / total) * 100) : 0; }
}
