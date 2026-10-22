import { Component, EventEmitter, HostListener, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DatosF5Vivo, InicioService, ItemVirtual, MetricaVivo, OpcionesF5Vivo, OpcionesWidget, PuntoVivo, VirtualVivo } from '../../core/services/inicio.service';
import { InicioLineaComponent, SerieLinea } from './inicio-linea.component';
import { IdSel, InicioSelectorComponent, ItemSel } from './inicio-selector.component';

const DEFECTO: OpcionesF5Vivo = { dispositivo: '', vs: [], minutos: 10, metrica: 'trafico' };
const CADA_MS = 5000;
const MAX_VS = 8;

// F5 en vivo: la persona elige uno o varios Virtual Servers y los ve moverse (cada 5 s) con los últimos minutos de historia.
// Este cuadro se actualiza solo (no usa el temporizador general del Inicio). El servidor lee el F5 como mucho cada 3 s
// aunque haya muchas personas mirando.
@Component({
  selector: 'app-inicio-f5-vivo',
  standalone: true,
  imports: [CommonModule, InicioLineaComponent, InicioSelectorComponent],
  templateUrl: './inicio-f5-vivo.component.html',
  styleUrl: './inicio-f5-vivo.component.scss',
})
export class InicioF5VivoComponent implements OnInit, OnChanges, OnDestroy {
  @Input() opciones: OpcionesWidget | null = null;
  @Output() opcionesChange = new EventEmitter<OpcionesWidget>();
  @Output() restablecer = new EventEmitter<void>();

  datos: DatosF5Vivo | null = null;
  error = '';
  cargando = true;
  pausado = false;
  actualizadoEn: number | null = null;
  virtuales: ItemVirtual[] = [];
  errorVirtuales = '';
  private virtualesDe = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private enVuelo = false;
  private listo = false;

  constructor(private servicio: InicioService) {}

  get op(): OpcionesF5Vivo { return { ...DEFECTO, ...(this.opciones ?? {}) } as OpcionesF5Vivo; }
  get hayFiltro(): boolean { return JSON.stringify(this.op) !== JSON.stringify(DEFECTO); }

  ngOnInit(): void {
    this.listo = true;
    this.cargar();
    this.timer = setInterval(() => { if (!this.pausado && !document.hidden) this.cargar(); }, CADA_MS);
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (this.listo && ch['opciones'] && !ch['opciones'].firstChange) this.cargar();
  }

  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  @HostListener('document:visibilitychange')
  alVolver(): void { if (!document.hidden && !this.pausado) this.cargar(); }

  cargar(): void {
    if (this.enVuelo) return;
    this.enVuelo = true;
    this.servicio.datos<DatosF5Vivo>('f5_vivo', this.op).subscribe({
      next: (r) => {
        this.enVuelo = false;
        this.cargando = false;
        if (r.error) { this.error = r.error; return; }
        this.error = '';
        this.datos = r.datos ?? null;
        this.actualizadoEn = Date.parse(r.generadoEn) || Date.now();
        const disp = this.datos?.dispositivo;
        if (disp && disp !== this.virtualesDe) this.cargarVirtuales(disp);
      },
      error: (e) => {
        this.enVuelo = false;
        this.cargando = false;
        this.error = e?.error?.error || 'No se pudo actualizar el tráfico en vivo.';
      },
    });
  }

  private cargarVirtuales(disp: string): void {
    this.virtualesDe = disp;
    this.errorVirtuales = '';
    this.servicio.f5Virtuales(disp).subscribe({
      next: (r) => { this.virtuales = r.virtuales ?? []; this.errorVirtuales = r.error ?? ''; },
      error: () => { this.virtualesDe = ''; this.errorVirtuales = 'No se pudo cargar la lista de Virtual Servers.'; },
    });
  }

  // ---- Cambios de filtros ----
  cambiar(parcial: Partial<OpcionesF5Vivo>): void { this.opcionesChange.emit({ ...this.op, ...parcial }); }
  elegirDispositivo(ids: IdSel[]): void {
    const id = String(ids[0] ?? '');
    if (id && id !== this.op.dispositivo) { this.virtuales = []; this.virtualesDe = ''; this.cambiar({ dispositivo: id, vs: [] }); }
  }
  elegirVs(ids: IdSel[]): void { this.cambiar({ vs: ids.map(String).slice(0, MAX_VS) }); }
  quitarVs(fullPath: string): void { this.cambiar({ vs: this.vsActuales.filter((x) => x !== fullPath) }); }
  alternarPausa(): void { this.pausado = !this.pausado; if (!this.pausado) this.cargar(); }
  limpiar(): void { this.virtualesDe = ''; this.restablecer.emit(); }

  get vsActuales(): string[] { return (this.datos?.seleccion ?? []).map((v) => v.fullPath); }
  get itemsDisp(): ItemSel[] { return (this.datos?.dispositivos ?? []).map((d) => ({ id: d.id, nombre: d.nombre })); }
  get dispSel(): IdSel[] { return this.datos?.dispositivo ? [this.datos.dispositivo] : []; }
  get itemsVs(): ItemSel[] {
    return this.virtuales.map((v) => ({ id: v.fullPath, nombre: v.nombre, apagado: !v.habilitado, detalle: !v.habilitado ? 'deshabilitado' : v.estado === 'available' ? null : 'sin servicio' }));
  }
  get vsSel(): IdSel[] { return this.datos?.automatico ? [] : this.vsActuales; }

  // ---- Gráfica ----
  readonly metricas: { v: MetricaVivo; t: string }[] = [
    { v: 'trafico', t: 'Tráfico' }, { v: 'entrada', t: 'Entrada' }, { v: 'salida', t: 'Salida' }, { v: 'conexiones', t: 'Conexiones' }, { v: 'peticiones', t: 'Peticiones/s' },
  ];
  readonly rangos: { v: OpcionesF5Vivo['minutos']; t: string }[] = [{ v: 5, t: '5 min' }, { v: 10, t: '10 min' }, { v: 15, t: '15 min' }];

  private valor(p: PuntoVivo, m: MetricaVivo): number | null {
    switch (m) {
      case 'trafico': return p[1] === null && p[2] === null ? null : (p[1] ?? 0) + (p[2] ?? 0);
      case 'entrada': return p[1];
      case 'salida': return p[2];
      case 'conexiones': return p[3];
      default: return p[4];
    }
  }
  private cache: { datos: unknown; metrica: string; valor: SerieLinea[] } | null = null;
  get series(): SerieLinea[] {
    const d = this.datos;
    const m = this.op.metrica;
    if (this.cache && this.cache.datos === d && this.cache.metrica === m) return this.cache.valor;
    const valor = (d?.seleccion ?? []).map((v, i) => ({
      nombre: v.nombre, color: this.color(i), puntos: v.historia.map((p) => ({ t: p[0], v: this.valor(p, m) })),
    }));
    this.cache = { datos: d, metrica: m, valor };
    return valor;
  }
  get hayHistoria(): boolean { return (this.datos?.seleccion ?? []).some((v) => v.historia.length >= 2); }
  color(i: number): string { return `var(--ix-c${(i % 8) + 1})`; }
  get esBps(): boolean { return ['trafico', 'entrada', 'salida'].includes(this.op.metrica); }
  get fmt(): (v: number) => string { return this.esBps ? this.fmtBps : this.fmtNum; }
  get tituloMetrica(): string { return this.metricas.find((m) => m.v === this.op.metrica)?.t ?? ''; }

  claseEstado(v: VirtualVivo): string { return !v.habilitado ? 'est-nulo' : v.estado === 'available' ? 'est-ok' : v.estado === 'offline' ? 'est-mal' : 'est-aviso'; }
  textoEstado(v: VirtualVivo): string { return !v.habilitado ? 'Deshabilitado' : v.estado === 'available' ? 'Disponible' : v.estado === 'offline' ? 'Sin servicio' : 'Desconocido'; }
  get horaActualizado(): string { return this.actualizadoEn ? new Date(this.actualizadoEn).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : ''; }

  fmtBps = (bps: number): string => {
    const u = ['b/s', 'Kb/s', 'Mb/s', 'Gb/s'];
    let v = bps; let i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: v >= 100 ? 0 : 1 }).format(v)} ${u[i]}`;
  };
  fmtNum = (v: number): string => new Intl.NumberFormat('es-CO', { maximumFractionDigits: v >= 100 ? 0 : 1 }).format(v);
  bps(v: number | null): string { return v === null ? '—' : this.fmtBps(v); }
  num(v: number | null): string { return v === null ? '—' : this.fmtNum(v); }
  trackV = (_: number, v: VirtualVivo): string => v.fullPath;
}
