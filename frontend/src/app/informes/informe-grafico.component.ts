import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, NgZone, OnChanges, OnDestroy } from '@angular/core';
import { InfGrafico, colorSerie, fmtCompactoInf, fmtFechaCortaInf, formatear } from './informes.service';

interface SerieLinea { nombre: string; color: string; d: string; area: string; puntos: { x: number; y: number }[]; ultimo: { x: number; y: number } | null; }
interface Barra { x: number; w: number; path: string; color: string; }
interface Tick { y: number; texto: string; }
interface Dona { color: string; dash: string; off: number; etiqueta: string; valor: number; pct: number; }

const PALETA = ['#673ab7', '#0ea5e9', '#16a34a', '#d97706', '#dc2626', '#0d9488', '#db2777', '#64748b'];

function bonito(v: number, redondeaArriba = true): number {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  const n = redondeaArriba ? (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) : (f >= 5 ? 5 : f >= 2 ? 2 : 1);
  return n * e;
}

// ============================================================================
// Gráfico de un informe. Se dibuja en SVG propio (sin librerías) y es
// interactivo: cruz + tooltip en líneas/áreas, tooltip por categoría en barras
// y resaltado al pasar por la dona. Siempre hay vista de tabla (accesibilidad).
// ============================================================================
@Component({
  selector: 'app-informe-grafico',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <figure class="graf" [class.graf--medio]="g.ancho === 'medio'">
      <figcaption class="graf__cab">
        <div>
          <h3>{{ g.titulo }}</h3>
          @if (g.descripcion) { <p>{{ g.descripcion }}</p> }
        </div>
        <button type="button" class="graf__vista" (click)="vistaTabla = !vistaTabla" [attr.aria-pressed]="vistaTabla">{{ vistaTabla ? 'Ver gráfico' : 'Ver tabla' }}</button>
      </figcaption>

      @if (g.series.length > 1 && !vistaTabla && g.forma !== 'dona') {
        <ul class="graf__leyenda">
          @for (s of g.series; track s.nombre) { <li><i [style.background]="color(s.color)"></i>{{ s.nombre }}</li> }
        </ul>
      }

      @if (vistaTabla) {
        <div class="graf__tabla">
          <table>
            <thead><tr><th></th>@for (s of g.series; track s.nombre) { <th>{{ g.forma === 'dona' ? 'Valor' : s.nombre }}</th> }@if (g.forma === 'dona') { <th>%</th> }</tr></thead>
            <tbody>
              @for (e of g.etiquetas; track $index; let fi = $index) {
                <tr><th>{{ etq(e) }}</th>@for (s of g.series; track s.nombre) { <td>{{ val(s.valores[fi]) }}</td> }@if (g.forma === 'dona') { <td>{{ dona[fi] ? dona[fi].pct.toLocaleString('es-CO', {maximumFractionDigits: 1}) + ' %' : '' }}</td> }</tr>
              }
            </tbody>
          </table>
        </div>
      } @else if (!hayDatos) {
        <p class="graf__vacio">Sin datos para graficar en este periodo.</p>
      } @else {
        @switch (g.forma) {
          @case ('barrasH') {
            <ul class="hbar">
              @for (e of g.etiquetas; track $index) {
                <li>
                  <span class="hbar__nombre" [title]="e">{{ e }}</span>
                  <span class="hbar__pista"><span class="hbar__fill" [style.width.%]="hPct[$index]" [style.background]="colorH($index)"></span></span>
                  <span class="hbar__valor">{{ val(g.series[0].valores[$index]) }}</span>
                </li>
              }
            </ul>
          }
          @case ('dona') {
            <div class="dona">
              <div class="dona__svg">
                <svg viewBox="0 0 180 180" role="img" [attr.aria-label]="g.titulo">
                  <circle cx="90" cy="90" r="67" fill="none" stroke="var(--ax-border, #e2e8f0)" stroke-width="26" opacity=".35" />
                  @for (d of dona; track $index) {
                    <circle cx="90" cy="90" r="67" fill="none" [attr.stroke]="d.color" stroke-width="26" [attr.stroke-dasharray]="d.dash" [attr.stroke-dashoffset]="d.off"
                      transform="rotate(-90 90 90)" [class.dim]="hover !== null && hover !== $index" (mouseenter)="hover = $index" (mouseleave)="hover = null" />
                  }
                </svg>
                <div class="dona__centro">
                  <strong [style.font-size.px]="centroFuente">{{ centroValor }}</strong>
                  <span>{{ centroTexto }}</span>
                </div>
              </div>
              <ul class="dona__leyenda">
                @for (d of dona; track $index) {
                  <li [class.sel]="hover === $index" (mouseenter)="hover = $index" (mouseleave)="hover = null">
                    <i [style.background]="d.color"></i><span class="n" [title]="d.etiqueta">{{ d.etiqueta }}</span>
                    <b>{{ val(d.valor) }}</b><em>{{ d.pct.toLocaleString('es-CO', {maximumFractionDigits: 1}) }} %</em>
                  </li>
                }
              </ul>
            </div>
          }
          @default {
            <div class="lienzo">
              <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="g.titulo" preserveAspectRatio="xMidYMid meet"
                (mousemove)="mover($event)" (mouseleave)="hover = null">
                @for (t of ticks; track t.y) {
                  <line [attr.x1]="ML" [attr.x2]="W - MR" [attr.y1]="t.y" [attr.y2]="t.y" class="grid" />
                  <text [attr.x]="ML - 8" [attr.y]="t.y + 3.5" text-anchor="end" class="eje">{{ t.texto }}</text>
                }
                @for (t of xTicks; track t.x) { <text [attr.x]="t.x" [attr.y]="H - 8" text-anchor="middle" class="eje">{{ t.texto }}</text> }

                @if (esBarras) {
                  @for (b of barras; track $index; let bi = $index) {
                    @for (r of b; track $index) { <path [attr.d]="r.path" [attr.fill]="r.color" [class.dim]="hover !== null && hover !== bi" /> }
                  }
                } @else {
                  @for (s of lineas; track s.nombre) {
                    @if (s.area) { <path [attr.d]="s.area" [attr.fill]="s.color" opacity="0.10" /> }
                    <path [attr.d]="s.d" fill="none" [attr.stroke]="s.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
                    @if (s.puntos.length <= 14) { @for (p of s.puntos; track $index) { <circle [attr.cx]="p.x" [attr.cy]="p.y" r="3" [attr.fill]="s.color" class="anillo" /> } }
                    @else if (s.ultimo) { <circle [attr.cx]="s.ultimo.x" [attr.cy]="s.ultimo.y" r="3.5" [attr.fill]="s.color" class="anillo" /> }
                  }
                  @if (hover !== null) {
                    <line [attr.x1]="xAt(hover)" [attr.x2]="xAt(hover)" [attr.y1]="MT" [attr.y2]="H - MB" class="cruz" />
                    @for (s of lineas; track s.nombre) { @if (puntoEn(s, hover); as p) { <circle [attr.cx]="p.x" [attr.cy]="p.y" r="4.5" [attr.fill]="s.color" class="anillo" /> } }
                  }
                }
                @if (esBarras && hover !== null) { <rect [attr.x]="bandaX(hover)" [attr.y]="MT" [attr.width]="banda" [attr.height]="H - MT - MB" class="resalte" /> }
              </svg>
              @if (hover !== null) {
                <div class="tip" [class.tip--der]="tipDerecha" [style.left.%]="tipX">
                  <b>{{ etq(g.etiquetas[hover]) }}</b>
                  @for (s of g.series; track s.nombre) { <span><i [style.background]="color(s.color)"></i>{{ s.nombre }}<em>{{ val(s.valores[hover]) }}</em></span> }
                  @if (g.apilado && g.series.length > 1) { <span class="tot">Total<em>{{ val(totalEn(hover)) }}</em></span> }
                </div>
              }
            </div>
          }
        }
      }
    </figure>
  `,
  styles: [`
    :host { display: block; min-width: 0; font-family: 'Inter', sans-serif; }
    .graf { margin: 0; background: var(--ax-surface, #fff); border: 1px solid var(--ax-border, #e2e8f0); border-radius: 18px; padding: 16px 18px 14px; height: 100%; box-sizing: border-box; box-shadow: 0 10px 25px rgba(var(--ax-brand-primary-rgb, 103, 58, 183), 0.04); }
    .graf__cab { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
    h3 { margin: 0; font-size: 14.5px; font-weight: 800; color: var(--ax-text, #1e293b); }
    .graf__cab p { margin: 3px 0 0; font-size: 12px; color: var(--ax-text-muted, #64748b); }
    .graf__vista { border: 1px solid var(--ax-border, #e2e8f0); background: transparent; color: var(--ax-text-muted, #64748b); font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 8px; cursor: pointer; font-family: inherit; white-space: nowrap; opacity: 0; transition: opacity .15s; }
    .graf:hover .graf__vista, .graf__vista:focus-visible { opacity: 1; }
    @media (hover: none) { .graf__vista { opacity: 1; } }
    .graf__leyenda { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 4px; padding: 0; font-size: 12px; color: var(--ax-text-muted, #64748b); font-weight: 600; }
    .graf__leyenda li { display: inline-flex; align-items: center; gap: 6px; }
    .graf__leyenda i, .tip i, .dona__leyenda i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex-shrink: 0; }
    .graf__vacio { text-align: center; color: var(--ax-text-muted, #64748b); font-size: 13px; padding: 30px 0; margin: 0; }
    .lienzo { position: relative; }
    svg { width: 100%; height: auto; display: block; overflow: visible; }
    .grid { stroke: var(--ax-chart-grid, #e2e8f0); stroke-width: 1; stroke-dasharray: 3 4; }
    .eje { fill: var(--ax-text-muted, #64748b); font-size: 11px; font-family: 'Inter', sans-serif; font-variant-numeric: tabular-nums; }
    .cruz { stroke: var(--ax-text-muted, #64748b); stroke-width: 1; stroke-dasharray: 3 3; opacity: .6; }
    .anillo { stroke: var(--ax-surface, #fff); stroke-width: 2; }
    .resalte { fill: var(--ax-text, #1e293b); opacity: .05; pointer-events: none; }
    .dim { opacity: .4; }
    .tip { position: absolute; top: 4px; transform: translateX(14px); background: var(--ax-surface, #fff); color: var(--ax-text, #1e293b); border: 1px solid var(--ax-border, #e2e8f0); border-radius: 10px; padding: 8px 11px; font-size: 12px; box-shadow: 0 8px 22px rgba(15, 23, 42, .18); pointer-events: none; display: flex; flex-direction: column; gap: 3px; min-width: 130px; z-index: 3; }
    .tip--der { transform: translateX(calc(-100% - 14px)); }
    .tip b { font-size: 12px; margin-bottom: 2px; }
    .tip span { display: flex; align-items: center; gap: 6px; color: var(--ax-text-muted, #64748b); }
    .tip em { margin-left: auto; padding-left: 14px; font-style: normal; font-weight: 800; color: var(--ax-text, #1e293b); font-variant-numeric: tabular-nums; }
    .tip .tot { border-top: 1px solid var(--ax-border, #e2e8f0); padding-top: 3px; margin-top: 2px; }

    .hbar { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
    .hbar li { display: grid; grid-template-columns: minmax(90px, 34%) 1fr auto; align-items: center; gap: 10px; font-size: 12.5px; }
    .hbar__nombre { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ax-text, #1e293b); font-weight: 600; }
    .hbar__pista { height: 10px; background: var(--ax-surface-2, #f1f5f9); border-radius: 6px; overflow: hidden; }
    .hbar__fill { display: block; height: 100%; border-radius: 0 6px 6px 0; min-width: 3px; transition: width .4s ease; }
    .hbar__valor { font-weight: 800; font-variant-numeric: tabular-nums; min-width: 44px; text-align: right; color: var(--ax-text, #1e293b); }

    .dona { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; justify-content: center; }
    .dona__svg { position: relative; width: 168px; height: 168px; flex-shrink: 0; }
    .dona__svg svg circle { transition: opacity .15s; cursor: default; }
    .dona__centro { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; text-align: center; padding: 0 34px; }
    .dona__centro strong { font-weight: 800; letter-spacing: -.5px; color: var(--ax-text, #1e293b); line-height: 1.05; white-space: nowrap; }
    .dona__centro span { font-size: 10.5px; color: var(--ax-text-muted, #64748b); font-weight: 700; text-transform: uppercase; letter-spacing: .4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dona__leyenda { list-style: none; margin: 0; padding: 0; flex: 1 1 170px; min-width: 150px; display: flex; flex-direction: column; gap: 2px; }
    .dona__leyenda li { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto 46px; align-items: center; gap: 8px; font-size: 12.5px; padding: 4px 6px; border-radius: 8px; }
    .dona__leyenda li.sel { background: var(--ax-surface-2, #f1f5f9); }
    .dona__leyenda .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ax-text, #1e293b); font-weight: 600; }
    .dona__leyenda b { font-variant-numeric: tabular-nums; }
    .dona__leyenda em { font-style: normal; color: var(--ax-text-muted, #64748b); text-align: right; font-variant-numeric: tabular-nums; font-size: 11.5px; }

    .graf__tabla { max-height: 260px; overflow: auto; border: 1px solid var(--ax-border, #e2e8f0); border-radius: 10px; }
    .graf__tabla table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .graf__tabla th, .graf__tabla td { padding: 6px 10px; text-align: right; border-bottom: 1px solid var(--ax-border, #e2e8f0); font-variant-numeric: tabular-nums; color: var(--ax-text, #1e293b); }
    .graf__tabla thead th { position: sticky; top: 0; background: var(--ax-surface-2, #f8fafc); font-size: 11px; color: var(--ax-text-muted, #64748b); text-transform: uppercase; }
    .graf__tabla tbody th { text-align: left; font-weight: 600; }
  `]
})
export class InformeGraficoComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input({ required: true }) g!: InfGrafico;

  readonly ML = 52; readonly MR = 12; readonly MT = 10; readonly MB = 26;
  W = 860; H = 240;
  vistaTabla = false;
  hover: number | null = null;

  hayDatos = false;
  ticks: Tick[] = [];
  xTicks: { x: number; texto: string }[] = [];
  lineas: SerieLinea[] = [];
  barras: Barra[][] = [];
  banda = 0;
  hPct: number[] = [];
  dona: Dona[] = [];
  private centroBase = '';
  get centroFuente(): number { const l = this.centroValor.length; return l > 9 ? 17 : l > 6 ? 21 : 26; }
  get centroValor(): string { return this.hover !== null && this.dona[this.hover] ? this.val(this.dona[this.hover].valor) : this.centroBase; }
  get centroTexto(): string { return this.hover !== null && this.dona[this.hover] ? this.dona[this.hover].etiqueta : 'Total'; }

  private lo = 0; private hi = 1;
  private ancho = 0;
  private ro?: ResizeObserver;
  constructor(private cd: ChangeDetectorRef, private el: ElementRef<HTMLElement>, private zone: NgZone) {}

  // El lienzo se dibuja a escala 1:1 con el ancho real de la tarjeta: así los
  // textos del eje no se encogen en el celular.
  ngAfterViewInit(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.ro = new ResizeObserver(() => {
      const w = Math.round(this.el.nativeElement.getBoundingClientRect().width);
      if (w > 0 && Math.abs(w - this.ancho) > 6) this.zone.run(() => { this.ancho = w; this.ngOnChanges(); this.cd.markForCheck(); });
    });
    this.ro.observe(this.el.nativeElement);
  }
  ngOnDestroy(): void { this.ro?.disconnect(); }

  get esBarras(): boolean { return this.g.forma === 'barras'; }
  get innerW(): number { return this.W - this.ML - this.MR; }
  get innerH(): number { return this.H - this.MT - this.MB; }
  get tipX(): number { return this.hover === null ? 0 : (this.esBarras ? (this.bandaX(this.hover) + this.banda / 2) : this.xAt(this.hover)) / this.W * 100; }
  get tipDerecha(): boolean { return this.tipX > 58; }

  ngOnChanges(): void {
    this.hover = null;
    const g = this.g;
    const util = this.ancho ? Math.max(260, Math.min(900, this.ancho - 38)) : (g.ancho === 'medio' ? 440 : 860);
    this.W = util;
    this.H = util < 420 ? 210 : (g.ancho === 'medio' ? 230 : 250);
    this.hayDatos = g.series.some((s) => s.valores.some((v) => v !== null && v !== undefined)) && g.etiquetas.length > 0;
    if (!this.hayDatos) return;
    if (g.forma === 'barrasH') this.armarH();
    else if (g.forma === 'dona') this.armarDona();
    else this.armarEjes();
  }

  // ---------- utilidades ----------
  color(c: string): string { return colorSerie(c); }
  colorH(i: number): string { return this.color(this.g.colores?.[i] || this.g.series[0].color); }
  etq(e: string): string { return /^\d{4}-\d{2}-\d{2}$/.test(e) ? fmtFechaCortaInf(e) : e; }
  val(v: number | null | undefined): string { return v === null || v === undefined ? '—' : formatear(v, this.g.fmt); }
  private eje(v: number): string {
    switch (this.g.fmt) {
      case 'pct': case 'pct0': return `${v.toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`;
      case 'n': case 'compacto': return fmtCompactoInf(v);
      default: return formatear(v, this.g.fmt);
    }
  }
  totalEn(i: number): number { return this.g.series.reduce((a, s) => a + (s.valores[i] || 0), 0); }

  // ---------- barras horizontales ----------
  private armarH(): void {
    const v = this.g.series[0].valores.map((x) => x || 0);
    const max = Math.max(...v, 0) || 1;
    this.hPct = v.map((x) => (x / max) * 100);
  }

  // ---------- dona ----------
  private armarDona(): void {
    const g = this.g; const v = g.series[0].valores.map((x) => Math.max(0, x || 0));
    const total = v.reduce((a, b) => a + b, 0);
    const circ = 2 * Math.PI * 67;
    let acc = 0;
    this.dona = v.map((x, i) => {
      const len = total ? (x / total) * circ : 0;
      const d: Dona = {
        color: this.color(g.colores?.[i] || PALETA[i % PALETA.length]), dash: `${Math.max(0, len - (v.length > 1 ? 1.5 : 0))} ${circ}`, off: -acc,
        etiqueta: this.etq(g.etiquetas[i]), valor: x, pct: total ? (x / total) * 100 : 0
      };
      acc += len; return d;
    });
    const t = total; this.centroBase = g.fmt === 'pct' || g.fmt === 'pct0' ? this.val(t) : (t >= 10000 ? fmtCompactoInf(t) : formatear(t, g.fmt === 'n1' ? 'n1' : 'n'));
  }

  // ---------- ejes (líneas / barras) ----------
  private armarEjes(): void {
    const g = this.g; const n = g.etiquetas.length;
    const vals = g.series.flatMap((s) => s.valores).filter((v): v is number => v !== null && v !== undefined);
    let min = Math.min(...vals); let max = Math.max(...vals);
    if (g.apilado && this.esBarras) max = Math.max(...g.etiquetas.map((_, i) => this.totalEn(i)));
    const pct = g.fmt === 'pct' || g.fmt === 'pct0';
    let lo = 0; let hi: number; let paso: number;
    if (pct && !this.esBarras && min >= 50) {
      hi = max > 90 ? 100 : Math.ceil(max / 4) * 4;
      lo = Math.max(0, Math.floor((min - 2) / 4) * 4);
      if (hi - lo < 4) lo = hi - 4;
      paso = (hi - lo) / 4;
    } else {
      lo = !this.esBarras && min < 0 ? -bonito(-min) : 0;
      const alto = max <= 0 ? 1 : max;
      const aprox = bonito(alto / 4, true);
      paso = aprox; hi = Math.ceil(alto / paso - 1e-9) * paso;
      if (!Number.isInteger(paso) && vals.every(Number.isInteger) && paso < 1) { paso = 1; hi = Math.ceil(alto); }
      if (hi === lo) hi = lo + paso;
    }
    this.lo = lo; this.hi = hi;
    const t: Tick[] = [];
    for (let v = lo; v <= hi + paso * 1e-6; v += paso) t.push({ y: this.yAt(v), texto: this.eje(Math.round(v * 1000) / 1000) });
    this.ticks = t;

    const maxEtq = Math.max(3, Math.floor(this.innerW / (this.esBarras ? 46 : 70))); const paso2 = Math.max(1, Math.ceil(n / maxEtq));
    this.xTicks = [];
    if (this.esBarras) {
      this.banda = this.innerW / n;
      for (let i = 0; i < n; i += paso2) this.xTicks.push({ x: this.bandaX(i) + this.banda / 2, texto: this.recorta(this.etq(g.etiquetas[i]), Math.floor(this.banda * paso2 / 6.2)) });
      this.armarBarras();
    } else {
      for (let i = 0; i < n; i += paso2) this.xTicks.push({ x: this.xAt(i), texto: this.etq(g.etiquetas[i]) });
      if ((n - 1) % paso2 !== 0 && n > 1 && this.xAt(n - 1) - this.xTicks[this.xTicks.length - 1].x > 52) this.xTicks.push({ x: this.xAt(n - 1), texto: this.etq(g.etiquetas[n - 1]) });
      this.armarLineas();
    }
  }
  private recorta(s: string, max: number): string { return s.length > max && max > 3 ? s.slice(0, max - 1) + '…' : s; }
  yAt(v: number): number { return this.MT + this.innerH * (1 - (v - this.lo) / (this.hi - this.lo)); }
  xAt(i: number): number { const n = this.g.etiquetas.length; return n === 1 ? this.ML + this.innerW / 2 : this.ML + (this.innerW * i) / (n - 1); }
  bandaX(i: number): number { return this.ML + this.banda * i; }

  private armarLineas(): void {
    const g = this.g; const base = this.yAt(Math.max(this.lo, 0));
    this.lineas = g.series.map((s) => {
      const puntos: { x: number; y: number }[] = []; const segs: { x: number; y: number }[][] = []; let cur: { x: number; y: number }[] = [];
      s.valores.forEach((v, i) => {
        if (v === null || v === undefined) { if (cur.length) { segs.push(cur); cur = []; } return; }
        const p = { x: this.xAt(i), y: this.yAt(Math.max(this.lo, Math.min(this.hi, v))) }; cur.push(p); puntos.push(p);
      });
      if (cur.length) segs.push(cur);
      const d = segs.map((sg) => (sg.length === 1 ? `M${sg[0].x - 0.01},${sg[0].y} L${sg[0].x + 0.01},${sg[0].y}` : 'M' + sg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L'))).join(' ');
      const conArea = g.forma === 'area' || g.series.length === 1;
      const area = conArea ? segs.filter((sg) => sg.length > 1).map((sg) => `M${sg[0].x.toFixed(1)},${base} L` + sg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L') + ` L${sg[sg.length - 1].x.toFixed(1)},${base} Z`).join(' ') : '';
      return { nombre: s.nombre, color: this.color(s.color), d, area, puntos, ultimo: puntos.length ? puntos[puntos.length - 1] : null };
    });
  }
  puntoEn(s: SerieLinea, i: number): { x: number; y: number } | null {
    const v = this.g.series.find((x) => x.nombre === s.nombre)?.valores[i];
    if (v === null || v === undefined) return null;
    return { x: this.xAt(i), y: this.yAt(Math.max(this.lo, Math.min(this.hi, v))) };
  }

  private armarBarras(): void {
    const g = this.g; const n = g.etiquetas.length; const k = g.series.length;
    const ancho = Math.min(46, this.banda * 0.72);
    this.barras = [];
    for (let i = 0; i < n; i++) {
      const fila: Barra[] = [];
      if (g.apilado && k > 1) {
        const x = this.bandaX(i) + (this.banda - ancho) / 2; let acum = 0;
        const activas = g.series.map((s, si) => ({ s, si, v: s.valores[i] || 0 })).filter((a) => a.v > 0);
        activas.forEach((a, idx) => {
          const y0 = this.yAt(acum); acum += a.v; const y1 = this.yAt(acum);
          const h = Math.max(1, y0 - y1 - (idx < activas.length - 1 ? 1.5 : 0));
          fila.push({ x, w: ancho, path: this.pathBarra(x, y0 - h, ancho, h, idx === activas.length - 1), color: this.color(a.s.color) });
        });
      } else {
        const gap = k > 1 ? 3 : 0; const w = Math.min(ancho / k - gap, 40); const total = w * k + gap * (k - 1);
        const x0 = this.bandaX(i) + (this.banda - total) / 2;
        g.series.forEach((s, si) => {
          const v = s.valores[i]; if (v === null || v === undefined || v <= 0) return;
          const y = this.yAt(v); const h = Math.max(1.5, this.yAt(0) - y); const x = x0 + si * (w + gap);
          fila.push({ x, w, path: this.pathBarra(x, this.yAt(0) - h, w, h, true), color: this.color(s.color) });
        });
      }
      this.barras.push(fila);
    }
  }
  private pathBarra(x: number, y: number, w: number, h: number, redondea: boolean): string {
    const r = redondea ? Math.min(4, w / 2, h) : 0;
    return r ? `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z` : `M${x},${y} h${w} v${h} h${-w} Z`;
  }

  // ---------- hover ----------
  mover(ev: MouseEvent): void {
    const svg = ev.currentTarget as SVGSVGElement; const r = svg.getBoundingClientRect(); if (!r.width) return;
    const x = ((ev.clientX - r.left) / r.width) * this.W; const n = this.g.etiquetas.length;
    let i: number;
    if (this.esBarras) i = Math.floor((x - this.ML) / this.banda);
    else i = n === 1 ? 0 : Math.round(((x - this.ML) / this.innerW) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    if (i !== this.hover) { this.hover = i; this.cd.markForCheck(); }
  }
}
