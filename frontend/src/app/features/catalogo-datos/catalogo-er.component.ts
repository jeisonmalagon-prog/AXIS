import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Grafo, TablaRef } from '../../core/services/catalogo-datos.service';
import { ER_CAB, ER_FILA, ER_W, ErArista, ErDiseno, ErNodo, PanZoom, disenoEr } from './catalogo-layout';

// Diagrama ER interactivo (SVG): la tabla elegida en el centro, sus padres a la
// izquierda y sus hijas a la derecha. Rueda = zoom, arrastrar = mover, clic en una
// tabla = abrirla.
@Component({
  selector: 'app-catalogo-er',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './catalogo-er.component.html',
  styleUrl: './catalogo-er.component.scss',
})
export class CatalogoErComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input({ required: true }) grafo!: Grafo;
  @Input() profundidad: 1 | 2 = 1;
  @Output() abrir = new EventEmitter<TablaRef>();
  @Output() cambiarProfundidad = new EventEmitter<1 | 2>();

  @ViewChild('lienzo', { static: true }) lienzo!: ElementRef<HTMLElement>;
  @ViewChild('svg', { static: true }) svg!: ElementRef<SVGSVGElement>;

  readonly W = ER_W;
  readonly CAB = ER_CAB;
  readonly FILA = ER_FILA;
  pz = new PanZoom();
  diseno: ErDiseno = { nodos: [], aristas: [], ancho: 0, alto: 0 };
  aristaActiva: ErArista | null = null;
  nodoActivo: string | null = null;
  private observador?: ResizeObserver;

  ngAfterViewInit(): void {
    setTimeout(() => { this.medir(); this.ajustar(); });
    if (typeof ResizeObserver !== 'undefined') {
      this.observador = new ResizeObserver(() => this.medir());
      this.observador.observe(this.lienzo.nativeElement);
    }
  }

  ngOnDestroy(): void { this.observador?.disconnect(); }

  ngOnChanges(c: SimpleChanges): void {
    if (c['grafo'] && this.grafo) {
      this.diseno = disenoEr(this.grafo);
      this.aristaActiva = null;
      this.nodoActivo = null;
      this.ajustar();
    }
  }

  private medir(): void {
    const r = this.lienzo.nativeElement.getBoundingClientRect();
    if (r.width > 0) { this.pz.ancho = r.width; this.pz.alto = r.height; }
  }

  /** Encuadra todo el diagrama; si queda demasiado pequeño para leerse, se enfoca la tabla central. */
  ajustar(): void {
    this.medir();
    const d = this.diseno;
    if (!d.nodos.length) return;
    this.pz.encuadrar(0, 0, d.ancho, d.alto, 20);
    if (this.pz.k < 0.62) this.centrar();
  }

  verTodo(): void {
    this.medir();
    const d = this.diseno;
    if (d.nodos.length) this.pz.encuadrar(0, 0, d.ancho, d.alto, 20);
  }

  centrar(): void {
    this.medir();
    const c = this.diseno.nodos.find((n) => n.n.id === this.grafo.centro);
    if (c) this.pz.centrarEn(c.x + c.w / 2, c.y + Math.min(c.h / 2, 160), 0.85);
  }

  // Aristas conectadas al nodo activo (se resaltan; el resto se atenúa).
  esVecina(a: ErArista): boolean { return !!this.nodoActivo && (a.a.desde === this.nodoActivo || a.a.hacia === this.nodoActivo); }

  esCentro(n: ErNodo): boolean { return n.n.id === this.grafo.centro; }

  nombreCompleto(n: ErNodo): string { return n.n.esquema ? `${n.n.esquema}.${n.n.nombre}` : n.n.nombre; }
  recortar(t: string, max: number): string { return t.length > max ? `${t.slice(0, max - 1)}…` : t; }
  fkInfo(a: ErArista): string {
    const hijo = this.diseno.nodos.find((x) => x.n.id === a.a.desde);
    const padre = this.diseno.nodos.find((x) => x.n.id === a.a.hacia);
    return `${hijo ? this.nombreCompleto(hijo) : ''} → ${padre ? this.nombreCompleto(padre) : ''}  ·  ${a.texto}  ·  ${a.a.nombre}`;
  }

  clicNodo(n: ErNodo): void {
    if (this.pz.movido) return;
    if (this.esCentro(n)) return;
    this.abrir.emit(n.n.ref);
  }

  teclaNodo(ev: KeyboardEvent, n: ErNodo): void {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.clicNodo(n); }
  }

  @HostListener('window:resize') onResize(): void { this.medir(); }
}
