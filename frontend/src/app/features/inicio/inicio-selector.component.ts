import { Component, ElementRef, EventEmitter, HostListener, Input, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';

export type IdSel = string | number;
export interface ItemSel { id: IdSel; nombre: string; detalle?: string | null; apagado?: boolean; }

const sinTildes = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Selector con búsqueda para los filtros de los cuadros del Inicio: varios elementos (casillas) o uno solo.
// Lista vacía = «todos». El panel se posiciona con «fixed» para que ninguna tarjeta lo recorte.
@Component({
  selector: 'app-inicio-selector',
  standalone: true,
  imports: [CommonModule],
  template: `
    <button type="button" #boton class="sel-btn" [class.activo]="seleccion.length > 0" (click)="alternar()" [attr.aria-expanded]="abierto" aria-haspopup="listbox">
      <span class="sel-eti">{{ etiqueta }}</span><b class="sel-val">{{ resumen }}</b><span class="sel-flecha">▾</span>
    </button>
    <div class="sel-panel" *ngIf="abierto" [style.left.px]="x" [style.top.px]="y" role="listbox" (click)="$event.stopPropagation()">
      <input class="sel-buscar" type="search" placeholder="Buscar…" [value]="texto" (input)="escribir($event)" *ngIf="items.length > 7" />
      <div class="sel-acc" *ngIf="!unico">
        <button type="button" (click)="todos()">{{ todosTexto }}</button>
        <button type="button" (click)="visibles()" *ngIf="texto">Elegir los {{ filtrados.length }} visibles</button>
      </div>
      <ul>
        <li *ngIf="unico && !sinTodos"><label class="fila"><input type="radio" name="sel-unico" [checked]="seleccion.length === 0" (change)="elegirUno(null)" /> <span>{{ todosTexto }}</span></label></li>
        <li *ngFor="let it of filtrados; trackBy: trackIt">
          <label class="fila" [class.apagado]="it.apagado">
            <input *ngIf="!unico" type="checkbox" [checked]="esta(it.id)" (change)="marcar(it.id)" />
            <input *ngIf="unico" type="radio" name="sel-unico" [checked]="esta(it.id)" (change)="elegirUno(it.id)" />
            <span class="nom">{{ it.nombre }}</span><small *ngIf="it.detalle">{{ it.detalle }}</small>
          </label>
        </li>
        <li class="vacio-sel" *ngIf="!filtrados.length">Sin resultados</li>
      </ul>
    </div>
  `,
  styles: [`
    :host { display: inline-block; position: relative; font-family: inherit; }
    .sel-btn { font-family: inherit; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
      background: var(--ax-surface-2, #f8fafc); color: var(--ax-text, #1e293b); border: 1px solid var(--ax-border, #e2e8f0); max-width: 260px; }
    .sel-btn:hover { border-color: var(--ax-brand-primary, #673ab7); }
    .sel-btn.activo { border-color: var(--ax-brand-primary, #673ab7); background: rgba(var(--ax-brand-primary-rgb, 103, 58, 183), 0.1); }
    .sel-btn:focus-visible { outline: 2px solid var(--ax-brand-primary, #673ab7); outline-offset: 1px; }
    .sel-eti { color: var(--ax-text-muted, #64748b); font-weight: 600; }
    .sel-val { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
    .sel-flecha { color: var(--ax-text-muted, #64748b); font-size: 10px; }
    .sel-panel { position: fixed; z-index: 1000; width: 280px; max-width: calc(100vw - 16px); background: var(--ax-surface, #fff); color: var(--ax-text, #1e293b);
      border: 1px solid var(--ax-border, #e2e8f0); border-radius: 12px; box-shadow: 0 14px 38px rgba(0, 0, 0, 0.22); padding: 10px; }
    .sel-buscar { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 12.5px; padding: 7px 10px; border: 1px solid var(--ax-border, #e2e8f0); border-radius: 8px;
      background: var(--ax-surface-2, #f8fafc); color: inherit; margin-bottom: 6px; }
    .sel-acc { display: flex; gap: 10px; margin-bottom: 4px; }
    .sel-acc button { font-family: inherit; font-size: 11.5px; font-weight: 600; background: transparent; border: 0; color: var(--ax-brand-primary, #673ab7); cursor: pointer; padding: 3px 2px; }
    .sel-acc button:hover { text-decoration: underline; }
    ul { list-style: none; margin: 0; padding: 0; max-height: 252px; overflow-y: auto; }
    .fila { display: flex; align-items: center; gap: 8px; padding: 6px 6px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
    .fila:hover { background: var(--ax-surface-2, #f8fafc); }
    .fila.apagado .nom { color: var(--ax-text-muted, #64748b); }
    .nom { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    small { color: var(--ax-text-muted, #64748b); font-size: 11px; white-space: nowrap; }
    .vacio-sel { padding: 10px 6px; font-size: 12px; color: var(--ax-text-muted, #64748b); }
  `],
})
export class InicioSelectorComponent {
  @Input() etiqueta = '';
  @Input() items: ItemSel[] = [];
  @Input() seleccion: IdSel[] = [];
  @Input() todosTexto = 'Todos';
  @Input() unico = false;
  /** Con «unico»: oculta la opción «todos» (siempre hay un elemento elegido). */
  @Input() sinTodos = false;
  @Output() cambio = new EventEmitter<IdSel[]>();
  @ViewChild('boton', { static: true }) boton!: ElementRef<HTMLElement>;

  abierto = false;
  texto = '';
  x = 0;
  y = 0;

  constructor(private host: ElementRef<HTMLElement>) {}

  get filtrados(): ItemSel[] {
    const q = sinTildes(this.texto.trim());
    return q ? this.items.filter((i) => sinTildes(`${i.nombre} ${i.detalle ?? ''}`).includes(q)) : this.items;
  }

  get resumen(): string {
    const n = this.seleccion.length;
    if (!n) return this.todosTexto;
    if (n === 1) return this.items.find((i) => i.id === this.seleccion[0])?.nombre ?? String(this.seleccion[0]);
    return `${n} de ${this.items.length}`;
  }

  esta(id: IdSel): boolean { return this.seleccion.includes(id); }
  trackIt = (_: number, i: ItemSel): IdSel => i.id;

  alternar(): void {
    if (this.abierto) { this.cerrar(); return; }
    const r = this.boton.nativeElement.getBoundingClientRect();
    const ancho = 280;
    this.x = Math.max(8, Math.min(r.left, window.innerWidth - ancho - 8));
    const hueco = window.innerHeight - r.bottom;
    this.y = hueco > 330 ? r.bottom + 4 : Math.max(8, r.top - 4 - Math.min(330, r.top - 8));
    this.texto = '';
    this.abierto = true;
  }

  cerrar(): void { this.abierto = false; }
  escribir(ev: Event): void { this.texto = (ev.target as HTMLInputElement).value; }

  marcar(id: IdSel): void {
    const sel = this.esta(id) ? this.seleccion.filter((x) => x !== id) : [...this.seleccion, id];
    this.cambio.emit(sel);
  }
  elegirUno(id: IdSel | null): void { this.cambio.emit(id === null ? [] : [id]); this.cerrar(); }
  todos(): void { this.cambio.emit([]); }
  visibles(): void { this.cambio.emit(this.filtrados.map((i) => i.id)); }

  @HostListener('document:click', ['$event'])
  fuera(ev: MouseEvent): void {
    if (this.abierto && !this.host.nativeElement.contains(ev.target as Node)) this.cerrar();
  }
  @HostListener('document:keydown.escape')
  escape(): void { this.cerrar(); }
  @HostListener('window:resize')
  alRedimensionar(): void { this.cerrar(); }
}
