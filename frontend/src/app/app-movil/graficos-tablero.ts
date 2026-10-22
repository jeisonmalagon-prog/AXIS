import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NumEsPipe } from './num-es.pipe';
import { PuntoSerie, fmtCompacto, fmtFechaCorta, fmtFechaLarga } from './tablero.service';

// ============================================================================
// Gráficos SVG propios del tablero (sin librerías): sparkline, volumen apilado
// con comparación contra el período anterior, y línea de efectividad.
// Una sola escala por gráfico (nunca doble eje), marcas finas, cuadrícula suave
// y capa de hover con tooltip. Los colores salen de variables CSS (modo oscuro).
// ============================================================================

function techoLindo(max: number): number {
  if (max <= 0) return 10;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / exp;
  const paso = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return paso * exp;
}

// --- Sparkline --------------------------------------------------------------
@Component({
  selector: 'app-sparkline',
  standalone: true,
  imports: [CommonModule, NumEsPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg class="spark" [attr.viewBox]="'0 0 ' + ancho + ' ' + alto" [style.width.px]="ancho" [style.height.px]="alto" aria-hidden="true">
      <path *ngIf="area" [attr.d]="area" [attr.fill]="color" fill-opacity="0.13" />
      <path *ngIf="linea" [attr.d]="linea" fill="none" [attr.stroke]="color" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />
      <circle *ngIf="ultimo" [attr.cx]="ultimo.x" [attr.cy]="ultimo.y" r="2.7" [attr.fill]="color" stroke="var(--ax-surface, #fff)" stroke-width="1.5" />
    </svg>`,
  styles: [':host{display:inline-block;line-height:0}']
})
export class SparklineComponent implements OnChanges {
  @Input() valores: (number | null)[] = [];
  @Input() color = 'var(--ax-brand-primary, #673ab7)';
  @Input() ancho = 96;
  @Input() alto = 30;
  @Input() baseCero = false;
  linea = '';
  area = '';
  ultimo: { x: number; y: number } | null = null;

  ngOnChanges(): void {
    const v = this.valores || [];
    const num = v.filter((x): x is number => x !== null && x !== undefined);
    this.linea = ''; this.area = ''; this.ultimo = null;
    if (num.length < 2) return;
    let min = Math.min(...num); let max = Math.max(...num);
    if (this.baseCero) min = Math.min(0, min);
    if (max === min) { max += 1; min -= 1; }
    const pad = 3;
    const w = this.ancho - pad * 2; const h = this.alto - pad * 2;
    const x = (i: number) => pad + (v.length === 1 ? 0 : (i / (v.length - 1)) * w);
    const y = (val: number) => pad + h - ((val - min) / (max - min)) * h;
    let d = ''; let ult: { x: number; y: number } | null = null; let inicioSeg = -1; let areaTotal = '';
    for (let i = 0; i < v.length; i++) {
      const val = v[i];
      if (val === null || val === undefined) { inicioSeg = -1; continue; }
      const px = x(i); const py = y(val);
      d += (inicioSeg < 0 ? `M${px.toFixed(1)},${py.toFixed(1)}` : `L${px.toFixed(1)},${py.toFixed(1)}`);
      inicioSeg = i; ult = { x: px, y: py };
    }
    this.linea = d; this.ultimo = ult;
    // Área solo si la serie es continua (sin huecos).
    if (v.every((q) => q !== null && q !== undefined)) {
      areaTotal = `${d}L${x(v.length - 1).toFixed(1)},${(this.alto - pad).toFixed(1)}L${x(0).toFixed(1)},${(this.alto - pad).toFixed(1)}Z`;
      this.area = areaTotal;
    }
  }
}

// --- Volumen apilado + período anterior ------------------------------------
interface BarraVol {
  i: number; x: number; w: number; cx: number;
  yExito: number; hExito: number; yError: number; hError: number;
  sinDato: boolean; parcial: boolean; punto: PuntoSerie; ant: PuntoSerie | null;
}
interface Marca { y: number; texto: string; }
interface EtiquetaX { x: number; texto: string; }

@Component({
  selector: 'app-grafico-volumen',
  standalone: true,
  imports: [CommonModule, NumEsPipe],
  template: `
    <div class="gv">
      <div class="gv__leyenda">
        <span><i class="sw sw--ok"></i>Exitosas</span>
        <span><i class="sw sw--err"></i>Con error</span>
        <span *ngIf="hayAnterior"><i class="sw sw--ant"></i>Período anterior (total)</span>
      </div>
      <div class="gv__lienzo" (mouseleave)="activo = null">
        <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="'Transacciones por día, ' + barras.length + ' días'">
          <g class="rejilla">
            <ng-container *ngFor="let m of marcas">
              <line [attr.x1]="ml" [attr.x2]="W - mr" [attr.y1]="m.y" [attr.y2]="m.y" />
              <text [attr.x]="ml - 8" [attr.y]="m.y + 4" text-anchor="end">{{ m.texto }}</text>
            </ng-container>
          </g>
          <rect *ngIf="activo !== null && barras[activo]" class="banda" [attr.x]="ml + paso * activo" [attr.y]="mt" [attr.width]="paso" [attr.height]="alto"></rect>
          <ng-container *ngFor="let b of barras">
            <rect *ngIf="b.sinDato" class="vacio" [attr.x]="b.x" [attr.y]="mt + alto - 3" [attr.width]="b.w" height="3" rx="1.5"></rect>
            <ng-container *ngIf="!b.sinDato">
              <rect class="ok" [class.parcial]="b.parcial" [attr.x]="b.x" [attr.y]="b.yExito" [attr.width]="b.w" [attr.height]="b.hExito" rx="2.5"></rect>
              <rect *ngIf="b.hError > 0" class="err" [class.parcial]="b.parcial" [attr.x]="b.x" [attr.y]="b.yError" [attr.width]="b.w" [attr.height]="b.hError" rx="2.5"></rect>
            </ng-container>
          </ng-container>
          <path *ngIf="lineaAnterior" class="ant" [attr.d]="lineaAnterior" fill="none"></path>
          <g class="ejex">
            <text *ngFor="let e of etiquetasX" [attr.x]="e.x" [attr.y]="H - 8" text-anchor="middle">{{ e.texto }}</text>
          </g>
          <rect *ngFor="let b of barras" class="hit" [attr.x]="ml + paso * b.i" [attr.y]="mt" [attr.width]="paso" [attr.height]="alto" (mouseenter)="activo = b.i" (focus)="activo = b.i" tabindex="-1"></rect>
        </svg>
        <div class="tip" *ngIf="activo !== null && barras[activo] as b" [style.left.%]="posTip(b.cx)" [class.tip--der]="b.cx > W * 0.66" [class.tip--izq]="b.cx < W * 0.34">
          <strong>{{ fechaLarga(b.punto.dia) }}<em *ngIf="b.parcial"> · parcial</em></strong>
          <ng-container *ngIf="!b.sinDato; else sinD">
            <div class="l"><span>Transacciones</span><b>{{ b.punto.total | numEs }}</b></div>
            <div class="l"><span><i class="sw sw--ok"></i>Exitosas</span><b>{{ b.punto.exitosas | numEs }}</b></div>
            <div class="l"><span><i class="sw sw--err"></i>Con error</span><b>{{ b.punto.errores | numEs }}<small *ngIf="b.punto.total"> ({{ tasaError(b.punto) }}%)</small></b></div>
            <div class="l" *ngIf="b.ant && !b.ant.sinDato"><span>Período anterior</span><b>{{ b.ant.total | numEs }}<small> ({{ variacion(b.punto.total, b.ant.total) }})</small></b></div>
          </ng-container>
          <ng-template #sinD><div class="l"><span>Sin datos del ETL para este día</span></div></ng-template>
        </div>
      </div>
    </div>`,
  styles: [`
    :host { display: block; }
    .gv__leyenda { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; color: var(--ax-text-muted, #64748b); margin-bottom: 6px; }
    .gv__leyenda span { display: inline-flex; align-items: center; gap: 6px; }
    .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; }
    .sw--ok { background: var(--ax-brand-primary, #673ab7); }
    .sw--err { background: var(--ax-chart-danger, #ef4444); }
    .sw--ant { width: 16px; height: 0; border-top: 2px dashed var(--ax-text-muted, #64748b); border-radius: 0; background: none; }
    .gv__lienzo { position: relative; }
    svg { width: 100%; height: auto; display: block; overflow: visible; }
    .rejilla line { stroke: var(--ax-chart-grid, #e2e8f0); stroke-width: 1; }
    .rejilla text, .ejex text { fill: var(--ax-text-muted, #64748b); font-size: 11px; font-family: inherit; }
    .banda { fill: var(--ax-brand-primary, #673ab7); opacity: 0.07; }
    .ok { fill: var(--ax-brand-primary, #673ab7); }
    .err { fill: var(--ax-chart-danger, #ef4444); }
    .ok.parcial, .err.parcial { opacity: 0.55; }
    .vacio { fill: var(--ax-chart-grid, #cbd5e1); }
    .ant { stroke: var(--ax-text-muted, #64748b); stroke-width: 2; stroke-dasharray: 5 4; stroke-linejoin: round; opacity: 0.9; }
    .hit { fill: transparent; cursor: crosshair; }
    .tip { position: absolute; top: 4px; transform: translateX(-50%); z-index: 5; pointer-events: none; min-width: 190px; background: var(--ax-surface, #fff); color: var(--ax-text, #1e293b); border: 1px solid var(--ax-border, #e2e8f0); border-radius: 10px; padding: 9px 12px; font-size: 12px; box-shadow: 0 10px 28px rgba(0,0,0,.2); }
    .tip--der { transform: translateX(-100%); }
    .tip--izq { transform: translateX(0); }
    .tip strong { display: block; font-size: 12.5px; margin-bottom: 4px; text-transform: capitalize; }
    .tip em { font-style: normal; font-weight: 600; color: var(--ax-text-muted, #64748b); text-transform: none; }
    .tip .l { display: flex; justify-content: space-between; gap: 14px; color: var(--ax-text-muted, #64748b); line-height: 1.6; }
    .tip .l b { color: var(--ax-text, #1e293b); font-variant-numeric: tabular-nums; }
    .tip .l small { font-weight: 600; color: var(--ax-text-muted, #64748b); }
    .tip .l span { display: inline-flex; align-items: center; gap: 6px; }
  `]
})
export class GraficoVolumenComponent implements OnChanges {
  @Input() serie: PuntoSerie[] = [];
  @Input() anterior: PuntoSerie[] | null = null;
  @Input() hoy = '';

  readonly W = 760; readonly H = 250; readonly ml = 46; readonly mr = 10; readonly mt = 12; readonly mb = 28;
  readonly alto = this.H - this.mt - this.mb;
  paso = 1;
  barras: BarraVol[] = [];
  marcas: Marca[] = [];
  etiquetasX: EtiquetaX[] = [];
  lineaAnterior = '';
  hayAnterior = false;
  activo: number | null = null;

  readonly fechaLarga = fmtFechaLarga;

  ngOnChanges(): void {
    const s = this.serie || [];
    const n = s.length;
    this.activo = null;
    if (!n) { this.barras = []; this.marcas = []; this.etiquetasX = []; this.lineaAnterior = ''; return; }
    const ant = this.anterior && this.anterior.length === n ? this.anterior : null;
    this.hayAnterior = !!ant && ant.some((p) => !p.sinDato);
    const plotW = this.W - this.ml - this.mr;
    this.paso = plotW / n;
    const maxDato = Math.max(1, ...s.map((p) => p.total), ...(ant ? ant.map((p) => p.total) : [0]));
    const techo = techoLindo(maxDato * 1.04);
    const base = this.mt + this.alto;
    const w = Math.max(2, Math.min(30, this.paso * 0.66));

    this.marcas = [0, 1, 2, 3, 4].map((k) => {
      const v = (techo / 4) * k;
      return { y: base - (v / techo) * this.alto, texto: fmtCompacto(v) };
    });

    this.barras = s.map((p, i) => {
      const x = this.ml + this.paso * i + (this.paso - w) / 2;
      const hE = (p.exitosas / techo) * this.alto;
      const hX = p.errores > 0 ? Math.max(2.5, (p.errores / techo) * this.alto) : 0;
      const gap = hE > 0 && hX > 0 ? 2 : 0;
      return {
        i, x, w, cx: x + w / 2,
        yExito: base - hE, hExito: Math.max(hE, p.total > 0 ? 1 : 0),
        yError: base - hE - gap - hX, hError: hX,
        sinDato: p.sinDato, parcial: p.dia === this.hoy, punto: p, ant: ant ? ant[i] : null
      };
    });

    // Línea del período anterior (alineada por posición), cortada en los días sin dato.
    let d = ''; let abierto = false;
    if (ant) {
      for (let i = 0; i < n; i++) {
        if (ant[i].sinDato) { abierto = false; continue; }
        const cx = this.ml + this.paso * i + this.paso / 2;
        const cy = base - (ant[i].total / techo) * this.alto;
        d += `${abierto ? 'L' : 'M'}${cx.toFixed(1)},${cy.toFixed(1)}`;
        abierto = true;
      }
    }
    this.lineaAnterior = d;

    const cada = Math.max(1, Math.ceil(n / 9));
    this.etiquetasX = [];
    for (let i = 0; i < n; i += cada) this.etiquetasX.push({ x: this.ml + this.paso * i + this.paso / 2, texto: fmtFechaCorta(s[i].dia) });
  }

  posTip(cx: number): number { return (cx / this.W) * 100; }
  tasaError(p: PuntoSerie): string { return p.total > 0 ? ((p.errores / p.total) * 100).toLocaleString('es-CO', { maximumFractionDigits: 2 }) : '0'; }
  variacion(a: number, b: number): string {
    if (!b) return '—';
    const v = Math.round(((a - b) / b) * 100);
    return `${v > 0 ? '+' : ''}${v}%`;
  }
}

// --- Efectividad (línea) -----------------------------------------------------
interface PuntoLinea { i: number; x: number; y: number; p: PuntoSerie; malo: boolean; }

@Component({
  selector: 'app-grafico-tasa',
  standalone: true,
  imports: [CommonModule, NumEsPipe],
  template: `
    <div class="gt">
      <div class="gt__leyenda">
        <span><i class="sw sw--lin"></i>Tasa de éxito diaria</span>
        <span><i class="sw sw--obj"></i>Objetivo {{ objetivo }}%</span>
        <span *ngIf="hayCritico"><i class="sw sw--bad"></i>Bajo {{ critico }}%</span>
      </div>
      <div class="gt__lienzo" (mouseleave)="activo = null">
        <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" aria-label="Tasa de éxito por día">
          <g class="rejilla">
            <ng-container *ngFor="let m of marcas">
              <line [attr.x1]="ml" [attr.x2]="W - mr" [attr.y1]="m.y" [attr.y2]="m.y" />
              <text [attr.x]="ml - 8" [attr.y]="m.y + 4" text-anchor="end">{{ m.texto }}</text>
            </ng-container>
          </g>
          <line *ngIf="yObjetivo !== null" class="obj" [attr.x1]="ml" [attr.x2]="W - mr" [attr.y1]="yObjetivo" [attr.y2]="yObjetivo"></line>
          <line *ngIf="activo !== null && puntos[activo]" class="cruz" [attr.x1]="puntos[activo].x" [attr.x2]="puntos[activo].x" [attr.y1]="mt" [attr.y2]="mt + alto"></line>
          <path *ngIf="area" class="area" [attr.d]="area"></path>
          <path *ngIf="linea" class="lin" [attr.d]="linea" fill="none"></path>
          <ng-container *ngFor="let q of puntos">
            <circle *ngIf="q.malo || activo === q.i || puntos.length <= 16" [attr.cx]="q.x" [attr.cy]="q.y" [attr.r]="activo === q.i ? 5 : 3.5" class="pt" [class.pt--bad]="q.malo"></circle>
          </ng-container>
          <g class="ejex">
            <text *ngFor="let e of etiquetasX" [attr.x]="e.x" [attr.y]="H - 8" text-anchor="middle">{{ e.texto }}</text>
          </g>
          <rect *ngFor="let p of serie; let i = index" class="hit" [attr.x]="ml + paso * i" [attr.y]="mt" [attr.width]="paso" [attr.height]="alto" (mouseenter)="activo = indicePunto(i)"></rect>
        </svg>
        <div class="tip" *ngIf="activo !== null && puntos[activo] as q" [style.left.%]="(q.x / W) * 100" [class.tip--der]="q.x > W * 0.66" [class.tip--izq]="q.x < W * 0.34">
          <strong>{{ fechaLarga(q.p.dia) }}</strong>
          <div class="l"><span>Tasa de éxito</span><b>{{ q.p.tasaExito }}%</b></div>
          <div class="l"><span>Transacciones</span><b>{{ q.p.total | numEs }}</b></div>
          <div class="l"><span>Errores</span><b>{{ q.p.errores | numEs }}</b></div>
        </div>
      </div>
    </div>`,
  styles: [`
    :host { display: block; }
    .gt__leyenda { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; color: var(--ax-text-muted, #64748b); margin-bottom: 6px; }
    .gt__leyenda span { display: inline-flex; align-items: center; gap: 6px; }
    .sw { display: inline-block; }
    .sw--lin { width: 16px; height: 0; border-top: 2.5px solid var(--ax-brand-primary, #673ab7); }
    .sw--obj { width: 16px; height: 0; border-top: 2px dashed var(--ax-chart-ok, #10b981); }
    .sw--bad { width: 9px; height: 9px; border-radius: 50%; background: var(--ax-chart-danger, #ef4444); }
    .gt__lienzo { position: relative; }
    svg { width: 100%; height: auto; display: block; overflow: visible; }
    .rejilla line { stroke: var(--ax-chart-grid, #e2e8f0); stroke-width: 1; }
    .rejilla text, .ejex text { fill: var(--ax-text-muted, #64748b); font-size: 11px; font-family: inherit; }
    .obj { stroke: var(--ax-chart-ok, #10b981); stroke-width: 1.6; stroke-dasharray: 5 4; }
    .cruz { stroke: var(--ax-text-muted, #64748b); stroke-width: 1; opacity: 0.5; }
    .lin { stroke: var(--ax-brand-primary, #673ab7); stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; }
    .area { fill: var(--ax-brand-primary, #673ab7); opacity: 0.08; }
    .pt { fill: var(--ax-brand-primary, #673ab7); stroke: var(--ax-surface, #fff); stroke-width: 2; }
    .pt--bad { fill: var(--ax-chart-danger, #ef4444); }
    .hit { fill: transparent; cursor: crosshair; }
    .tip { position: absolute; top: 4px; transform: translateX(-50%); z-index: 5; pointer-events: none; min-width: 180px; background: var(--ax-surface, #fff); color: var(--ax-text, #1e293b); border: 1px solid var(--ax-border, #e2e8f0); border-radius: 10px; padding: 9px 12px; font-size: 12px; box-shadow: 0 10px 28px rgba(0,0,0,.2); }
    .tip--der { transform: translateX(-100%); }
    .tip--izq { transform: translateX(0); }
    .tip strong { display: block; font-size: 12.5px; margin-bottom: 4px; text-transform: capitalize; }
    .tip .l { display: flex; justify-content: space-between; gap: 14px; color: var(--ax-text-muted, #64748b); line-height: 1.6; }
    .tip .l b { color: var(--ax-text, #1e293b); font-variant-numeric: tabular-nums; }
  `]
})
export class GraficoTasaComponent implements OnChanges {
  @Input() serie: PuntoSerie[] = [];
  readonly objetivo = 98;
  readonly critico = 95;
  readonly W = 760; readonly H = 210; readonly ml = 46; readonly mr = 10; readonly mt = 12; readonly mb = 28;
  readonly alto = this.H - this.mt - this.mb;
  paso = 1;
  puntos: PuntoLinea[] = [];
  marcas: Marca[] = [];
  etiquetasX: EtiquetaX[] = [];
  linea = '';
  area = '';
  yObjetivo: number | null = null;
  hayCritico = false;
  activo: number | null = null;
  private indiceDePunto = new Map<number, number>();
  readonly fechaLarga = fmtFechaLarga;

  ngOnChanges(): void {
    const s = this.serie || [];
    const n = s.length;
    this.activo = null;
    this.puntos = []; this.linea = ''; this.area = ''; this.marcas = []; this.etiquetasX = []; this.indiceDePunto.clear();
    if (!n) return;
    const plotW = this.W - this.ml - this.mr;
    this.paso = plotW / n;
    const valores = s.filter((p) => p.tasaExito !== null).map((p) => p.tasaExito as number);
    if (!valores.length) return;
    const min = Math.min(...valores);
    // Dominio adaptable: nunca por debajo de 0 ni por encima de 100.
    let piso = Math.floor(Math.min(min, this.objetivo) - 1);
    piso = Math.max(0, Math.min(piso, 96));
    const techo = 100;
    const base = this.mt + this.alto;
    const y = (v: number) => base - ((v - piso) / (techo - piso)) * this.alto;
    const pasoTick = (techo - piso) <= 6 ? 1 : (techo - piso) <= 12 ? 2 : (techo - piso) <= 30 ? 5 : 10;
    for (let v = techo; v >= piso; v -= pasoTick) this.marcas.push({ y: y(v), texto: `${v}%` });
    this.yObjetivo = this.objetivo >= piso ? y(this.objetivo) : null;

    let d = ''; let abierto = false; let primero: PuntoLinea | null = null; let ultimo: PuntoLinea | null = null;
    s.forEach((p, i) => {
      if (p.tasaExito === null || p.sinDato) { abierto = false; return; }
      const x = this.ml + this.paso * i + this.paso / 2;
      const yy = y(p.tasaExito);
      const pt: PuntoLinea = { i: this.puntos.length, x, y: yy, p, malo: p.tasaExito < this.critico };
      this.indiceDePunto.set(i, pt.i);
      this.puntos.push(pt);
      d += `${abierto ? 'L' : 'M'}${x.toFixed(1)},${yy.toFixed(1)}`;
      abierto = true;
      if (!primero) primero = pt; ultimo = pt;
    });
    this.linea = d;
    this.hayCritico = this.puntos.some((q) => q.malo);
    const p1 = primero as PuntoLinea | null; const p2 = ultimo as PuntoLinea | null;
    if (p1 && p2 && this.puntos.length === s.filter((p) => !p.sinDato).length && this.puntos.length > 1) {
      this.area = `${d}L${p2.x.toFixed(1)},${base}L${p1.x.toFixed(1)},${base}Z`;
    }
    const cada = Math.max(1, Math.ceil(n / 9));
    for (let i = 0; i < n; i += cada) this.etiquetasX.push({ x: this.ml + this.paso * i + this.paso / 2, texto: fmtFechaCorta(s[i].dia) });
  }

  indicePunto(i: number): number | null { return this.indiceDePunto.has(i) ? (this.indiceDePunto.get(i) as number) : null; }
}
