import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, NgZone, OnChanges, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface PuntoLinea { t: number; v: number | null; }
export interface SerieLinea { nombre: string; color: string; puntos: PuntoLinea[]; }

interface SerieDibujo { nombre: string; color: string; d: string; ultimo: number | null; }
interface Marca { x: number; y: number; color: string; nombre: string; valor: string; }

// Gráfica de líneas reutilizable del Inicio: una sola escala Y, rejilla
// discreta, leyenda siempre visible con el último valor, cruz + tooltip al
// pasar el cursor y huecos (línea cortada) donde no hay dato.
@Component({
  selector: 'app-inicio-linea',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="leyenda" *ngIf="series.length">
      <span class="ley" *ngFor="let s of dibujo"><i [style.background]="s.color"></i>{{ s.nombre }}<b *ngIf="s.ultimo !== null">{{ fmt(s.ultimo) }}</b></span>
    </div>
    <div class="lienzo" #lienzo>
      <svg *ngIf="ancho > 0 && hayDatos" [attr.viewBox]="'0 0 ' + ancho + ' ' + alto" [attr.width]="ancho" [attr.height]="alto"
           role="img" [attr.aria-label]="etiqueta" (mousemove)="mover($event)" (mouseleave)="salir()">
        <g class="rejilla">
          <ng-container *ngFor="let y of ticksY">
            <line [attr.x1]="mIzq" [attr.x2]="ancho - mDer" [attr.y1]="y.pos" [attr.y2]="y.pos" />
            <text [attr.x]="mIzq - 6" [attr.y]="y.pos + 3.5" text-anchor="end">{{ y.texto }}</text>
          </ng-container>
          <text *ngFor="let x of ticksX; let last = last" [attr.x]="x.pos" [attr.y]="alto - 6" [attr.text-anchor]="last ? 'end' : 'middle'">{{ x.texto }}</text>
        </g>
        <path *ngFor="let s of dibujo" [attr.d]="s.d" fill="none" [attr.stroke]="s.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <ng-container *ngIf="cruz !== null">
          <line class="cruz" [attr.x1]="cruz" [attr.x2]="cruz" [attr.y1]="mSup" [attr.y2]="alto - mInf" />
          <circle *ngFor="let m of marcas" [attr.cx]="m.x" [attr.cy]="m.y" r="4.5" [attr.fill]="m.color" class="punto" />
        </ng-container>
      </svg>
      <div class="vacio-g" *ngIf="!hayDatos">Sin datos suficientes todavía.</div>
      <div class="tip" *ngIf="cruz !== null && marcas.length" [style.left.px]="tipX" [style.top.px]="mSup">
        <strong>{{ tipTitulo }}</strong>
        <div *ngFor="let m of marcas"><i [style.background]="m.color"></i>{{ m.nombre }}: <b>{{ m.valor }}</b></div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .leyenda { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 6px; font-size: 12px; color: var(--ax-text-muted, #64748b); }
    .ley { display: inline-flex; align-items: center; gap: 6px; }
    .ley i, .tip i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .ley b { color: var(--ax-text, #1e293b); margin-left: 2px; }
    .lienzo { position: relative; width: 100%; min-height: 40px; }
    svg { display: block; overflow: visible; }
    .rejilla line { stroke: var(--ax-border, #e2e8f0); stroke-width: 1; }
    .rejilla text { fill: var(--ax-text-muted, #64748b); font-size: 10.5px; font-family: inherit; }
    .cruz { stroke: var(--ax-text-muted, #64748b); stroke-width: 1; stroke-dasharray: 3 3; }
    .punto { stroke: var(--ax-surface, #fff); stroke-width: 2; }
    .vacio-g { padding: 30px 8px; text-align: center; font-size: 12.5px; color: var(--ax-text-muted, #64748b); }
    .tip { position: absolute; z-index: 5; pointer-events: none; transform: translateX(-50%); background: var(--ax-surface, #fff); color: var(--ax-text, #1e293b);
      border: 1px solid var(--ax-border, #e2e8f0); border-radius: 8px; padding: 7px 10px; font-size: 12px; line-height: 1.5; box-shadow: 0 8px 22px rgba(0,0,0,.18); white-space: nowrap; }
    .tip strong { display: block; font-size: 11px; color: var(--ax-text-muted, #64748b); margin-bottom: 2px; }
    .tip div { display: flex; align-items: center; gap: 6px; }
  `],
})
export class InicioLineaComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() series: SerieLinea[] = [];
  @Input() fmt: (v: number) => string = (v) => String(v);
  @Input() alto = 170;
  /** Valor mínimo del eje Y (evita rejillas con decimales en conteos pequeños). */
  @Input() minMax = 0;
  @Input() etiqueta = 'Gráfica de líneas';
  @ViewChild('lienzo', { static: true }) lienzo!: ElementRef<HTMLElement>;

  mIzq = 50; mDer = 10; mSup = 8; mInf = 22;
  ancho = 0;
  hayDatos = false;
  dibujo: SerieDibujo[] = [];
  ticksY: { pos: number; texto: string }[] = [];
  ticksX: { pos: number; texto: string }[] = [];
  cruz: number | null = null;
  marcas: Marca[] = [];
  tipX = 0;
  tipTitulo = '';

  private obs?: ResizeObserver;
  private tMin = 0; private tMax = 1; private yMax = 1;
  private tiempos: number[] = [];

  constructor(private cdr: ChangeDetectorRef, private zone: NgZone) {}

  ngAfterViewInit(): void {
    // Medir en un tick aparte: cambiar el ancho dentro de la misma pasada de
    // detección dispararía NG0100.
    setTimeout(() => { this.medir(); this.calcular(); this.cdr.detectChanges(); });
    if (typeof ResizeObserver !== 'undefined') {
      this.zone.runOutsideAngular(() => {
        this.obs = new ResizeObserver(() => this.zone.run(() => {
          const w = Math.floor(this.lienzo.nativeElement.clientWidth);
          if (w && w !== this.ancho) { this.ancho = w; this.calcular(); this.cdr.markForCheck(); }
        }));
        this.obs.observe(this.lienzo.nativeElement);
      });
    }
  }

  ngOnChanges(): void {
    if (this.ancho > 0) this.calcular();
  }

  ngOnDestroy(): void { this.obs?.disconnect(); }

  private medir(): void {
    this.ancho = Math.floor(this.lienzo.nativeElement.clientWidth) || 0;
  }

  private siguienteBueno(max: number): number {
    if (max <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(max)));
    const f = max / exp;
    const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return n * exp;
  }

  private calcular(): void {
    const todos = this.series.flatMap((s) => s.puntos.filter((p) => p.v !== null));
    this.hayDatos = todos.length >= 2;
    if (!this.hayDatos || this.ancho <= 0) { this.dibujo = []; return; }

    this.tMin = Math.min(...todos.map((p) => p.t));
    this.tMax = Math.max(...todos.map((p) => p.t));
    if (this.tMax === this.tMin) this.tMax = this.tMin + 1;
    const maxV = Math.max(...todos.map((p) => p.v as number));
    this.yMax = Math.max(this.minMax, this.siguienteBueno(maxV * 1.05));
    const x = (t: number) => this.mIzq + ((t - this.tMin) / (this.tMax - this.tMin)) * (this.ancho - this.mIzq - this.mDer);
    const y = (v: number) => this.alto - this.mInf - (v / this.yMax) * (this.alto - this.mInf - this.mSup);

    this.dibujo = this.series.map((s) => {
      let d = ''; let abierto = false; let ultimo: number | null = null;
      for (const p of [...s.puntos].sort((a, b) => a.t - b.t)) {
        if (p.v === null) { abierto = false; continue; }
        d += `${abierto ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
        abierto = true; ultimo = p.v;
      }
      return { nombre: s.nombre, color: s.color, d, ultimo };
    });

    this.ticksY = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ pos: y(this.yMax * f), texto: this.fmt(this.yMax * f) }));
    const nX = Math.max(2, Math.min(6, Math.floor((this.ancho - this.mIzq) / (this.tMax - this.tMin > 30 * 3600 * 1000 ? 120 : 90))));
    this.ticksX = Array.from({ length: nX }, (_, i) => {
      const t = this.tMin + ((this.tMax - this.tMin) * i) / (nX - 1);
      return { pos: x(t), texto: this.hora(t) };
    });
    this.tiempos = [...new Set(todos.map((p) => p.t))].sort((a, b) => a - b);
  }

  private hora(t: number): string {
    const span = this.tMax - this.tMin;
    if (span > 30 * 3600 * 1000) return new Date(t).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    if (span <= 20 * 60 * 1000) return new Date(t).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return new Date(t).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  mover(ev: MouseEvent): void {
    if (!this.tiempos.length) return;
    const svg = ev.currentTarget as SVGElement;
    const caja = svg.getBoundingClientRect();
    const px = ev.clientX - caja.left;
    const t = this.tMin + ((px - this.mIzq) / (this.ancho - this.mIzq - this.mDer)) * (this.tMax - this.tMin);
    const cercano = this.tiempos.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
    const x = this.mIzq + ((cercano - this.tMin) / (this.tMax - this.tMin)) * (this.ancho - this.mIzq - this.mDer);
    const y = (v: number) => this.alto - this.mInf - (v / this.yMax) * (this.alto - this.mInf - this.mSup);
    this.marcas = this.series
      .map((s) => ({ s, p: s.puntos.find((q) => q.t === cercano) }))
      .filter((r) => r.p && r.p.v !== null)
      .map((r) => ({ x, y: y(r.p!.v as number), color: r.s.color, nombre: r.s.nombre, valor: this.fmt(r.p!.v as number) }));
    this.cruz = x;
    this.tipX = Math.min(Math.max(x, 70), this.ancho - 70);
    this.tipTitulo = new Date(cercano).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: this.tMax - this.tMin <= 20 * 60 * 1000 ? '2-digit' : undefined, hour12: false });
  }

  salir(): void { this.cruz = null; this.marcas = []; }
}
