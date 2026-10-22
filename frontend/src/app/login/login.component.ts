import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { ConfiguracionService, Tema } from '../services/configuracion.service';
import { JpIcoComponent } from '../shared/japon/japon-ico.component';
import { HojasCayendoComponent } from '../shared/japon/hojas-cayendo.component';
import { AuthEscenaComponent } from '../shared/japon/auth-escena.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, JpIcoComponent, HojasCayendoComponent, AuthEscenaComponent],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent implements OnInit {
  username = '';
  password = '';
  mensajeError = '';
  mensajeInfo = '';
  verPassword = false;
  cargando = false;

  // 'claro' por defecto: si el backend tarda en responder o falla, el login
  // se ve exactamente como siempre se ha visto (nunca se queda "en blanco"
  // ni parpadea a oscuro por error).
  tema: Tema = 'claro';

  // El color de marca (degradado, botón, foco de inputs) ya NO se calcula
  // aquí: BrandColorService lo aplica de forma global apenas arranca la app
  // (ver AppComponent), usando variables CSS (--ax-brand-*) que este mismo
  // componente hereda vía el cascade normal de CSS. Así el login queda
  // consistente con el resto de AXIS sin duplicar la llamada al backend.

  constructor(
    private authService: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private configuracionService: ConfiguracionService
  ) {}

  ngOnInit(): void {
    // Si el shell (por inactividad) o el interceptor (token vencido) nos
    // mandaron aquí, mostramos por qué en vez de dejar el login "mudo".
    const motivo = this.route.snapshot.queryParamMap.get('motivo');
    if (motivo === 'inactividad') {
      this.mensajeInfo = 'Tu sesión se cerró por inactividad. Vuelve a iniciar sesión.';
    } else if (motivo === 'expirada') {
      this.mensajeInfo = 'Tu sesión expiró. Vuelve a iniciar sesión.';
    } else if (motivo === 'password-restablecida') {
      this.mensajeInfo = 'Contraseña actualizada. Inicia sesión con la nueva.';
    }

    // Tema global elegido por un ADMIN_POD (ver ConfiguracionSistema). Se
    // lee sin autenticación porque en este punto todavía no hay sesión.
    this.configuracionService.obtenerTema().subscribe({
      next: (res) => { this.tema = res.tema; },
      error: () => { /* si falla, se queda en 'claro' (valor por defecto) */ }
    });
  }

  iniciarSesion(): void {
    this.mensajeInfo = ''; // un intento nuevo de login limpia el aviso anterior
    if (!this.username || !this.password) {
      this.mensajeError = 'Por favor ingresa usuario y contraseña';
      return;
    }

    if (this.cargando) return;
    this.cargando = true;
    this.mensajeError = '';
    this.authService.login(this.username, this.password).subscribe({
      next: (res) => {
        // Primer login de una cuenta nueva, o justo después de que un admin
        // le reseteó la contraseña: debe cambiarla antes de usar el resto
        // del aplicativo (el backend ya bloquea todo lo demás igual).
        if (res.usuario?.debeCambiarPassword) {
          this.router.navigate(['/cambiar-password']);
          return;
        }
        // Login exitoso: pantalla principal con las métricas en vivo
        this.router.navigate(['/inicio']);
      },
      error: (err) => {
        this.cargando = false;
        this.mensajeError = err.error?.error || 'Credenciales incorrectas';
      }
    });
  }
}
