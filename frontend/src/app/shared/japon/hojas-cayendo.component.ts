import { ChangeDetectionStrategy, Component, Input, OnChanges, OnInit } from '@angular/core';

interface Hoja {
  x: number;      // % desde la izquierda
  s: number;      // tamaño en px
  t: number;      // segundos que tarda en caer
  d: number;      // desfase (negativo = ya va cayendo al cargar)
  b: number;      // segundos de cada vaivén
  dx: number;     // desplazamiento lateral total en px
  rot: number;    // giro total en grados
  o: number;      // opacidad
  c: number;      // variante de color 0..2
  f: number;      // forma 0 = arce · 1 = alargada
  vol: number;    // amplitud del vaivén en px
}

// Hojas cayendo (solo transform/opacity: corre en la GPU y no recalcula el layout).
// Los valores son pseudo-aleatorios pero con semilla fija: se ven distintas entre sí pero siempre igual
// al recargar. Respeta «reducir movimiento» del sistema (ahí no se muestran).
// Uso: <app-hojas-cayendo [cantidad]="22"></app-hojas-cayendo>  ·  [frente]="true" para las que pasan por delante.
const ARCE = 'M50 4 58 22 73 15 68 38 91 31 80 50 96 58 68 68 73 79 55 72 55 97 45 97 45 72 27 79 32 68 4 58 20 50 9 31 32 38 27 15 42 22Z';
const LARGA = 'M50 3C78 22 84 62 50 94 16 62 22 22 50 3ZM49 20 51 90 50 90Z';

@Component({
  selector: 'app-hojas-cayendo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.frente]': 'frente' },
  template: `
    <div class="hojas" aria-hidden="true">
      @for (h of hojas; track $index) {
        <span class="hoja" [class]="'hoja c' + h.c"
              [style.--x]="h.x + '%'" [style.--s]="h.s + 'px'" [style.--t]="h.t + 's'" [style.--d]="h.d + 's'"
              [style.--b]="h.b + 's'" [style.--dx]="h.dx + 'px'" [style.--rot]="h.rot + 'deg'" [style.--o]="h.o"
              [style.--vol]="h.vol + 'px'">
          <svg viewBox="0 0 100 100" fill="currentColor" focusable="false">
            <path [attr.d]="h.f === 0 ? arce : larga" fill-rule="evenodd"/>
          </svg>
        </span>
      }
    </div>
  `,
  styles: [`
    :host { position: absolute; inset: 0; display: block; pointer-events: none; overflow: hidden; z-index: 1; }
    :host(.frente) { z-index: 4; }
    .hojas { position: absolute; inset: 0; overflow: hidden; }
    .hoja {
      position: absolute; top: 0; left: var(--x);
      width: var(--s); height: var(--s);
      opacity: 0; will-change: transform, opacity;
      animation: caer calc(var(--t) * var(--k, 1)) linear calc(var(--d) * var(--k, 1)) infinite;
      svg { width: 100%; height: 100%; display: block; animation: vaiven calc(var(--b) * var(--k, 1)) ease-in-out infinite alternate; filter: drop-shadow(0 2px 3px rgba(0, 0, 0, .12)); }
    }
    .c0 { color: var(--ax-brand-primary, #673ab7); }
    .c1 { color: var(--ax-brand-secondary, #d81b60); }
    .c2 { color: var(--ax-brand-primary-claro, #a78bfa); }
    :host-context(.dark-theme) .c0 { color: var(--ax-brand-primary-claro, #a78bfa); }
    :host-context(.dark-theme) .c1 { color: var(--ax-brand-secondary-claro, #f472b6); }
    :host-context(.dark-theme) .c2 { color: var(--ax-brand-primary, #673ab7); }

    @keyframes caer {
      0%   { transform: translate3d(0, -14vh, 0) rotate(0deg); opacity: 0; }
      7%   { opacity: var(--o); }
      90%  { opacity: var(--o); }
      100% { transform: translate3d(var(--dx), 108vh, 0) rotate(var(--rot)); opacity: 0; }
    }
    @keyframes vaiven {
      from { transform: translateX(calc(var(--vol) * -1)) rotateY(0deg) rotateZ(-16deg); }
      to   { transform: translateX(var(--vol)) rotateY(160deg) rotateZ(16deg); }
    }
    @media (max-width: 640px) { .hoja:nth-child(n + 11) { display: none; } }
    // «Reducir movimiento» (Windows sin animaciones, escritorios virtuales…): las hojas NO se ocultan,
    // porque son lo que da vida a la pantalla; caen más despacio (x2.4), sin dar volteretas y con un giro corto.
    @media (prefers-reduced-motion: reduce) {
      :host { --k: 2.4; }
      .hoja { animation-name: caer-suave; }
      .hoja svg { animation-name: vaiven-suave; }
    }
    @keyframes caer-suave {
      0%   { transform: translate3d(0, -14vh, 0) rotate(0deg); opacity: 0; }
      7%   { opacity: var(--o); }
      90%  { opacity: var(--o); }
      100% { transform: translate3d(calc(var(--dx) * .6), 108vh, 0) rotate(calc(var(--rot) * .18)); opacity: 0; }
    }
    @keyframes vaiven-suave {
      from { transform: translateX(calc(var(--vol) * -.7)) rotateZ(-10deg); }
      to   { transform: translateX(calc(var(--vol) * .7)) rotateZ(10deg); }
    }
  `]
})
export class HojasCayendoComponent implements OnInit, OnChanges {
  @Input() cantidad = 20;
  @Input() frente = false;
  @Input() semilla = 7;
  hojas: Hoja[] = [];
  readonly arce = ARCE;
  readonly larga = LARGA;

  ngOnInit(): void { this.generar(); }
  ngOnChanges(): void { this.generar(); }

  private generar(): void {
    const rnd = mulberry32(this.semilla + (this.frente ? 99 : 0));
    const n = Math.max(0, Math.min(60, this.cantidad));
    this.hojas = Array.from({ length: n }, (_, i) => {
      const t = (this.frente ? 8 : 11) + rnd() * (this.frente ? 6 : 12);
      const grande = this.frente;
      return {
        x: Math.round((((i + rnd() * 0.8) / n) * 104 - 2) * 10) / 10,
        s: Math.round(grande ? 32 + rnd() * 24 : 18 + rnd() * 24),
        t: Math.round(t * 10) / 10,
        d: -Math.round(rnd() * t * 10) / 10,
        b: Math.round((2.2 + rnd() * 2.4) * 10) / 10,
        dx: Math.round((rnd() - 0.35) * 260),
        rot: Math.round((rnd() > 0.5 ? 1 : -1) * (200 + rnd() * 420)),
        o: Math.round((grande ? 0.6 + rnd() * 0.25 : 0.5 + rnd() * 0.4) * 100) / 100,
        c: Math.floor(rnd() * 3),
        f: rnd() > 0.45 ? 0 : 1,
        vol: Math.round(10 + rnd() * 22),
      };
    });
  }
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
