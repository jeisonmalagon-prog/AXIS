import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

// Torii y pagoda dibujados como siluetas (usan «currentColor»: toman el color del texto
// o de la marca). Sirven igual de chicos (menú lateral) que enormes (escena del login).
// Uso: <app-jp-ico tipo="torii"></app-jp-ico>  ·  <app-jp-ico tipo="pagoda"></app-jp-ico>
const PAGODA = 'M12 150V146H88V150ZM18 146V142H82V146ZM50 118Q30.3 129 3 123L10 133H90L97 123Q69.7 129 50 118ZM29 133H71V142H29ZM47.8 134.2h4.4v5.2h-4.4ZM50 94Q33.2 105 10 99L17 109H83L90 99Q66.8 105 50 94ZM32.6 109H67.4V118H32.6ZM47.8 110.2h4.4v4.6h-4.4ZM50 70Q36.1 81 17 75L24 85H76L83 75Q63.9 81 50 70ZM36.2 85H63.8V94H36.2ZM47.8 86.2h4.4v4.6h-4.4ZM50 46Q39.1 57 24 51L31 61H69L76 51Q60.9 57 50 46ZM39.8 61H60.2V70H39.8ZM47.8 62.2h4.4v4.6h-4.4ZM50 22Q42 33 31 27L38 37H62L69 27Q58 33 50 22ZM43.4 37H56.6V46H43.4ZM48.2 38.2h3.6v4.6h-3.6Z';
// Aguja con anillos: va aparte (relleno normal) porque sus piezas se superponen.
const AGUJA = 'M49.2 4H50.8V24H49.2ZM46.6 8H53.4V9.4H46.6ZM46.6 12H53.4V13.4H46.6ZM46.6 16H53.4V17.4H46.6ZM50 .6A1.9 1.9 0 1 1 50 4.4A1.9 1.9 0 1 1 50 .6Z';
const TORII = 'M0 7Q60 27 120 7L115 19Q60 37 5 19ZM13 27Q60 41 107 27V32Q60 46 13 32ZM15 42H105V48H15ZM55 30H65V41H55ZM26 28H33.5L31 104H22.5ZM86.5 28H94L97.5 104H89ZM18 94H35V104H18ZM85 94H102V104H85Z';

@Component({
  selector: 'app-jp-ico',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tipo === 'pagoda') {
      <svg viewBox="0 0 100 150" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path [attr.d]="pagoda"/><path [attr.d]="aguja" fill-rule="nonzero"/></svg>
    } @else {
      <svg viewBox="0 0 120 104" fill="currentColor" aria-hidden="true" focusable="false"><path [attr.d]="torii"/></svg>
    }
  `,
  styles: [`
    :host { display: inline-block; line-height: 0; color: inherit; }
    svg { width: 100%; height: 100%; display: block; overflow: visible; }
  `]
})
export class JpIcoComponent {
  @Input() tipo: 'torii' | 'pagoda' = 'torii';
  readonly pagoda = PAGODA;
  readonly aguja = AGUJA;
  readonly torii = TORII;
}
