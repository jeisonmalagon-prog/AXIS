import { AfterViewInit, Directive, ElementRef, NgZone, OnDestroy } from '@angular/core';

// Acomoda las tarjetas del Inicio como «ladrillos»: cada una ocupa solo la altura que necesita y
// la siguiente se coloca en el primer hueco disponible, sin dejar espacios en blanco al lado de
// una tarjeta más alta. Funciona con una cuadrícula de filas finas (ver .grilla-w): se mide cada
// tarjeta y se le asigna cuántas filas ocupa. Se vuelve a medir sola cuando una tarjeta cambia de
// tamaño (carga de datos, filtros, cambio de ancho de la ventana).
@Directive({ selector: '[axMasonry]', standalone: true })
export class MasonryDirective implements AfterViewInit, OnDestroy {
  private readonly fila = 6;     // px de cada fila de la cuadrícula (debe coincidir con grid-auto-rows)
  private readonly espacio = 16; // px entre tarjetas
  private ro?: ResizeObserver;
  private mo?: MutationObserver;
  private visto = new Set<Element>();
  private pendiente = 0;

  constructor(private el: ElementRef<HTMLElement>, private zone: NgZone) {}

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      if (typeof ResizeObserver === 'undefined') return;
      this.ro = new ResizeObserver(() => this.programar());
      this.mo = new MutationObserver(() => this.observarHijos());
      this.mo.observe(this.el.nativeElement, { childList: true });
      this.observarHijos();
    });
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.mo?.disconnect();
    if (this.pendiente) cancelAnimationFrame(this.pendiente);
  }

  private observarHijos(): void {
    const hijos = Array.from(this.el.nativeElement.children);
    for (const h of this.visto) if (!hijos.includes(h)) { this.ro?.unobserve(h); this.visto.delete(h); }
    for (const h of hijos) if (!this.visto.has(h)) { this.ro?.observe(h); this.visto.add(h); }
    this.programar();
  }

  private programar(): void {
    if (this.pendiente) return;
    this.pendiente = requestAnimationFrame(() => { this.pendiente = 0; this.acomodar(); });
  }

  private acomodar(): void {
    for (const h of Array.from(this.el.nativeElement.children) as HTMLElement[]) {
      const alto = h.getBoundingClientRect().height;
      const filas = Math.max(1, Math.ceil((alto + this.espacio) / this.fila));
      const valor = `span ${filas}`;
      if (h.style.gridRowEnd !== valor) h.style.gridRowEnd = valor;
    }
  }
}
