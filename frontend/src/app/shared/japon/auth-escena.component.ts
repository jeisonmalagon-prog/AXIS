import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { JpIcoComponent } from './japon-ico.component';
import { HojasCayendoComponent } from './hojas-cayendo.component';

// Fondo de las pantallas de acceso (login, recuperar contraseña, cambiar contraseña): cielo, sol,
// montañas, pagoda, torii, bruma y hojas cayendo. Se pone como primer hijo de
// <div class="modern-hero-wrapper"> (que define los colores --jp-*) y no captura clics.
// Las hojas grandes que pasan por delante de la tarjeta se piden aparte con
// <app-hojas-cayendo [frente]="true"> para que queden por encima de ella.
@Component({
  selector: 'app-auth-escena',
  standalone: true,
  imports: [JpIcoComponent, HojasCayendoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './auth-escena.component.html',
  styleUrls: ['./auth-escena.component.scss'],
})
export class AuthEscenaComponent {
  @Input() oscuro = false;
  @Input() hojas = 26;

  // Estrellas del cielo nocturno (modo oscuro): posiciones fijas, parpadean con desfases distintos.
  readonly estrellas = Array.from({ length: 26 }, (_, i) => ({
    x: Math.round(((i * 37) % 97) + (i % 3)),
    y: Math.round(((i * 53) % 58) + 2),
    s: 1 + (i % 3),
    d: Math.round(((i * 7) % 13) * 0.4 * 10) / 10,
  }));
}
