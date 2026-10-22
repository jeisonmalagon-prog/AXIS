import { Component, Input, OnChanges } from '@angular/core';
import { InfColumna, InfTabla, formatear, tonoDeCelda } from './informes.service';

// ============================================================================
// Tabla de un informe: búsqueda, orden por columna, píldoras de color según
// la regla de la columna (tonos / umbrales) y barras internas (`barra`).
// Muestra 12 filas y deja ver todas con un clic (el PDF trae las primeras; el
// Excel trae todas en su propia hoja).
// ============================================================================
@Component({
  selector: 'app-informe-tabla',
  standalone: true,
  template: `
    <section class="tab">
      <header class="tab__cab">
        <div>
          <h3>{{ t.titulo }}</h3>
          @if (t.descripcion) { <p>{{ t.descripcion }}</p> }
        </div>
        @if (t.filas.length > 8) {
          <input type="search" class="tab__buscar" placeholder="Buscar…" [value]="q" (input)="buscar($any($event.target).value)" aria-label="Buscar en la tabla" />
        }
      </header>

      @if (!t.filas.length) {
        <p class="tab__vacio">{{ t.vacio }}</p>
      } @else {
        <div class="tab__scroll">
          <table>
            <thead>
              <tr>
                @for (c of t.columnas; track c.campo) {
                  <th [class.num]="c.tipo === 'num'" [attr.aria-sort]="orden?.campo === c.campo ? (orden?.asc ? 'ascending' : 'descending') : null">
                    <button type="button" (click)="ordenar(c)">{{ c.etiqueta }}<span class="flecha">{{ orden?.campo === c.campo ? (orden?.asc ? '▲' : '▼') : '' }}</span></button>
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (f of visibles; track $index) {
                <tr>
                  @for (c of t.columnas; track c.campo) {
                    <td [class.num]="c.tipo === 'num'">
                      @if (c.barra && esNum(f[c.campo])) {
                        <span class="celda-barra"><span class="celda-barra__pista"><span class="celda-barra__fill" [style.width.%]="pctBarra(c, f[c.campo])"></span></span><span>{{ texto(c, f[c.campo]) }}</span></span>
                      } @else if (c.tonos && tono(c, f[c.campo])) {
                        <span [class]="'pill pill--' + tono(c, f[c.campo])">{{ texto(c, f[c.campo]) }}</span>
                      } @else if (c.umbral && tono(c, f[c.campo])) {
                        <span [class]="'u u--' + tono(c, f[c.campo])">{{ texto(c, f[c.campo]) }}</span>
                      } @else {
                        <span class="txt" [title]="texto(c, f[c.campo])">{{ texto(c, f[c.campo]) }}</span>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
        <footer class="tab__pie">
          <span>
            @if (filtradas.length !== t.filas.length) { {{ filtradas.length }} de {{ t.filas.length }} filas }
            @else { {{ t.filas.length }} {{ t.filas.length === 1 ? 'fila' : 'filas' }} }
            @if (t.truncada) { · se muestran las primeras {{ t.filas.length }} de {{ t.totalFilas }}; el Excel trae el detalle completo }
          </span>
          @if (filtradas.length > limite) {
            <button type="button" (click)="verTodas = !verTodas; recalcular()">{{ verTodas ? 'Ver menos' : 'Ver todas (' + filtradas.length + ')' }}</button>
          }
        </footer>
      }
    </section>
  `,
  styles: [`
    :host { display: block; min-width: 0; font-family: 'Inter', sans-serif; }
    .tab { background: var(--ax-surface, #fff); border: 1px solid var(--ax-border, #e2e8f0); border-radius: 18px; padding: 16px 18px 12px; box-shadow: 0 10px 25px rgba(var(--ax-brand-primary-rgb, 103, 58, 183), 0.04); height: 100%; box-sizing: border-box; }
    .tab__cab { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    h3 { margin: 0; font-size: 14.5px; font-weight: 800; color: var(--ax-text, #1e293b); }
    .tab__cab p { margin: 3px 0 0; font-size: 12px; color: var(--ax-text-muted, #64748b); }
    .tab__buscar { padding: 7px 12px; border-radius: 10px; border: 1px solid var(--ax-border, #e2e8f0); background: var(--ax-surface-2, #f8fafc); color: var(--ax-text, #1e293b); font-size: 12.5px; font-family: inherit; min-width: 170px; }
    .tab__vacio { text-align: center; color: var(--ax-text-muted, #64748b); font-size: 13px; padding: 22px 0; margin: 0; }
    .tab__scroll { overflow-x: auto; border: 1px solid var(--ax-border, #e2e8f0); border-radius: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    th { position: sticky; top: 0; background: var(--ax-surface-2, #f8fafc); text-align: left; padding: 0; border-bottom: 1px solid var(--ax-border, #e2e8f0); white-space: nowrap; }
    th button { border: none; background: transparent; font: inherit; font-size: 11px; font-weight: 800; color: var(--ax-text-muted, #64748b); text-transform: uppercase; letter-spacing: .3px; padding: 9px 12px; cursor: pointer; width: 100%; text-align: inherit; display: flex; gap: 4px; align-items: center; }
    th.num button { justify-content: flex-end; }
    th button:hover { color: var(--ax-text, #1e293b); }
    .flecha { font-size: 8px; color: var(--ax-brand-primary, #673ab7); }
    td { padding: 8px 12px; border-bottom: 1px solid var(--ax-border, #e2e8f0); color: var(--ax-text, #1e293b); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: rgba(var(--ax-brand-primary-rgb, 103, 58, 183), 0.05); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .txt { display: block; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .num .txt { margin-left: auto; }
    .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 700; white-space: nowrap; background: rgba(148, 163, 184, .2); color: var(--ax-text-muted, #64748b); }
    .pill--ok { background: rgba(16, 185, 129, .16); color: #047857; }
    .pill--warn { background: rgba(245, 158, 11, .2); color: #b45309; }
    .pill--danger { background: rgba(239, 68, 68, .16); color: #b91c1c; }
    .pill--brand { background: rgba(var(--ax-brand-primary-rgb, 103, 58, 183), .16); color: var(--ax-brand-primary, #673ab7); }
    :host-context(.dark-theme) .pill--ok { color: #6ee7b7; } :host-context(.dark-theme) .pill--warn { color: #fcd34d; } :host-context(.dark-theme) .pill--danger { color: #fca5a5; }
    .u { font-weight: 800; } .u--warn { color: #b45309; } .u--danger { color: #b91c1c; } .u--ok { color: #047857; }
    :host-context(.dark-theme) .u--warn { color: #fcd34d; } :host-context(.dark-theme) .u--danger { color: #fca5a5; } :host-context(.dark-theme) .u--ok { color: #6ee7b7; }
    .celda-barra { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
    .celda-barra__pista { flex: 0 1 90px; width: 90px; height: 7px; border-radius: 4px; background: var(--ax-surface-2, #f1f5f9); overflow: hidden; }
    .celda-barra__fill { display: block; height: 100%; background: var(--ax-brand-primary, #673ab7); border-radius: 0 4px 4px 0; min-width: 2px; }
    .tab__pie { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 2px 0; font-size: 11.5px; color: var(--ax-text-muted, #64748b); }
    .tab__pie button { border: none; background: transparent; color: var(--ax-brand-primary, #673ab7); font-weight: 800; font-size: 12px; cursor: pointer; font-family: inherit; }
    .tab__pie button:hover { text-decoration: underline; }
  `]
})
export class InformeTablaComponent implements OnChanges {
  @Input({ required: true }) t!: InfTabla;
  readonly limite = 12;
  q = '';
  orden: { campo: string; asc: boolean } | null = null;
  verTodas = false;
  filtradas: Record<string, any>[] = [];
  visibles: Record<string, any>[] = [];
  private maximos: Record<string, number> = {};

  ngOnChanges(): void {
    this.q = ''; this.orden = null; this.verTodas = false;
    this.maximos = {};
    for (const c of this.t.columnas) if (c.barra) this.maximos[c.campo] = Math.max(0, ...this.t.filas.map((f) => Number(f[c.campo]) || 0));
    this.recalcular();
  }
  buscar(v: string): void { this.q = v; this.recalcular(); }
  ordenar(c: InfColumna): void {
    if (this.orden?.campo === c.campo) this.orden = this.orden.asc ? { campo: c.campo, asc: false } : null;
    else this.orden = { campo: c.campo, asc: c.tipo !== 'num' };
    this.recalcular();
  }
  recalcular(): void {
    const q = this.q.trim().toLowerCase();
    let r = this.t.filas;
    if (q) r = r.filter((f) => this.t.columnas.some((c) => this.texto(c, f[c.campo]).toLowerCase().includes(q)));
    if (this.orden) {
      const { campo, asc } = this.orden;
      r = [...r].sort((a, b) => {
        const x = a[campo]; const y = b[campo];
        if (x === null || x === undefined || x === '') return 1;
        if (y === null || y === undefined || y === '') return -1;
        const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true });
        return asc ? d : -d;
      });
    }
    this.filtradas = r;
    this.visibles = this.verTodas || q ? r : r.slice(0, this.limite);
  }
  esNum(v: any): boolean { return typeof v === 'number' && Number.isFinite(v); }
  pctBarra(c: InfColumna, v: number): number { const m = this.maximos[c.campo] || 1; return Math.max(0, Math.min(100, (v / m) * 100)); }
  tono(c: InfColumna, v: any): string | null { return tonoDeCelda(c, v); }
  texto(c: InfColumna, v: any): string {
    if (v === null || v === undefined || v === '') return '—';
    if (c.tipo === 'fecha') return formatear(v, 'fecha');
    if (c.tipo === 'fechahora') return formatear(v, 'fechahora');
    if (c.tipo === 'num') return formatear(v, c.fmt || 'n');
    return c.fmt ? formatear(v, c.fmt) : String(v);
  }
}
