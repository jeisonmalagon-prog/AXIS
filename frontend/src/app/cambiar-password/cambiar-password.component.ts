import { Component, HostBinding, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';
import { ConfiguracionService, Tema } from '../services/configuracion.service';
import { validarPasswordSegura, REQUISITOS_PASSWORD_TEXTO } from '../shared/password-policy.util';
import { JpIcoComponent } from '../shared/japon/japon-ico.component';
import { HojasCayendoComponent } from '../shared/japon/hojas-cayendo.component';
import { AuthEscenaComponent } from '../shared/japon/auth-escena.component';

@Component({
  selector: 'app-cambiar-password',
  standalone: true,
  imports: [CommonModule, FormsModule, JpIcoComponent, HojasCayendoComponent, AuthEscenaComponent],
  templateUrl: './cambiar-password.component.html',
  // login.component.scss aporta la escena, la tarjeta, los campos y el botón: así las tres pantallas de acceso se ven igual.
  styleUrls: ['../login/login.component.scss', './cambiar-password.component.scss'],
})
export class CambiarPasswordComponent implements OnInit {
  passwordActual = '';
  passwordNueva = '';
  passwordConfirmar = '';
  mensajeError = '';
  guardando = false;
  verPassword = false;

  // Texto de ayuda fijo bajo el campo de contraseña nueva (ver
  // shared/password-policy.util.ts -- mismas reglas que valida el backend).
  readonly requisitosPassword = REQUISITOS_PASSWORD_TEXTO;

  // Distingue el flujo obligatorio (primer login / tras reset del admin) del
  // cambio voluntario que alguien puede hacer luego desde "Mi perfil" — solo
  // cambia el texto de la cabecera y el botón de "Cancelar".
  get esObligatorio(): boolean {
    return !!this.authService.obtenerDatosUsuario()?.debeCambiarPassword;
  }

  // Esta pantalla vive FUERA del ShellComponent a propósito (ver
  // app.routes.ts: "pantalla completa sin menú lateral"), así que nunca
  // queda dentro de .shell.dark-theme y no puede heredar el tema del shell.
  // Se resuelve aquí mismo (mismo patrón que ShellComponent/HomeComponent)
  // y se aplica directo sobre el host con @HostBinding.
  tema: Tema = 'claro';

  @HostBinding('class.dark-theme')
  get temaOscuroActivo(): boolean {
    return this.tema === 'oscuro';
  }

  constructor(
    private authService: AuthService,
    private router: Router,
    private configuracionService: ConfiguracionService
  ) {}

  ngOnInit(): void {
    const usuarioActual = this.authService.obtenerDatosUsuario();

    forkJoin({
      global: this.configuracionService.obtenerTema().pipe(
        catchError(() => of({ tema: 'claro' as Tema }))
      ),
      personal: usuarioActual
        ? this.configuracionService.obtenerTemaPersonal().pipe(
            catchError(() => of({ temaPersonal: null as Tema | null }))
          )
        : of({ temaPersonal: null as Tema | null })
    }).subscribe(({ global, personal }) => {
      this.tema = personal.temaPersonal || global.tema;
      this.configuracionService.establecerTemaActual(this.tema);
    });

    this.configuracionService.temaActual$.subscribe((tema) => {
      this.tema = tema;
    });
  }

  guardar(): void {
    this.mensajeError = '';

    if (!this.passwordActual || !this.passwordNueva || !this.passwordConfirmar) {
      this.mensajeError = 'Completa todos los campos.';
      return;
    }
    if (this.passwordNueva !== this.passwordConfirmar) {
      this.mensajeError = 'La confirmación no coincide con la nueva contraseña.';
      return;
    }

    if (this.passwordNueva === this.passwordActual) {
      this.mensajeError = 'La nueva contraseña no puede ser igual a la contraseña actual. Elige una diferente.';
      return;
    }

    // Mismas reglas que el backend (ver shared/password-policy.util.ts) --
    // esto solo adelanta el feedback; el backend vuelve a validar igual.
    const usuarioActual = this.authService.obtenerDatosUsuario();
    const errores = validarPasswordSegura(this.passwordNueva, {
      username: usuarioActual?.username,
      nombreCompleto: usuarioActual?.nombre,
    });
    if (errores.length) {
      this.mensajeError = errores.join(' ');
      return;
    }

    this.guardando = true;
    this.authService.cambiarPassword(this.passwordActual, this.passwordNueva).subscribe({
      next: () => {
        this.guardando = false;
        this.router.navigate(['/inicio']);
      },
      error: (err) => {
        this.guardando = false;
        this.mensajeError = err.error?.error || 'No se pudo actualizar la contraseña.';
      },
    });
  }

  cancelar(): void {
    this.router.navigate(['/inicio']);
  }
}
