import { Component, ElementRef, NgZone, OnDestroy, OnInit, QueryList, ViewChildren } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { ConfiguracionService, Tema } from '../services/configuracion.service';
import { JpIcoComponent } from '../shared/japon/japon-ico.component';
import { HojasCayendoComponent } from '../shared/japon/hojas-cayendo.component';
import { AuthEscenaComponent } from '../shared/japon/auth-escena.component';
import { validarPasswordSegura } from '../shared/password-policy.util';

type Paso = 'identificar' | 'codigo' | 'password' | 'listo';

// Recuperar la contraseña con un código de un solo uso (OTP). Tres pasos:
//   1. la persona escribe su usuario (o correo) -> el backend envía el MISMO código de 6 dígitos al correo
//      y/o al celular registrados en su cuenta;
//   2. escribe el código (vence a los 10 min, 5 intentos);
//   3. fija la contraseña nueva.
// Las respuestas del backend no revelan si el usuario existe (por eso el texto habla de «si la cuenta existe»).
@Component({
  selector: 'app-recuperar-password',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, JpIcoComponent, HojasCayendoComponent, AuthEscenaComponent],
  templateUrl: './recuperar-password.component.html',
  styleUrls: ['../login/login.component.scss', './recuperar-password.component.scss'],
})
export class RecuperarPasswordComponent implements OnInit, OnDestroy {
  @ViewChildren('casilla') casillas!: QueryList<ElementRef<HTMLInputElement>>;

  paso: Paso = 'identificar';
  tema: Tema = 'claro';

  identificador = '';
  cargando = false;
  error = '';
  aviso = '';

  solicitudId = '';
  vigenciaMin = 10;
  reenvioRestante = 0;
  digitos: string[] = ['', '', '', '', '', ''];
  private temporizador: ReturnType<typeof setInterval> | null = null;

  resetToken = '';
  passwordNueva = '';
  passwordConfirmar = '';
  verPassword = false;

  canales: { correo: boolean; sms: boolean } | null = null;

  constructor(
    private authService: AuthService,
    private configuracionService: ConfiguracionService,
    private router: Router,
    private zona: NgZone
  ) {}

  ngOnInit(): void {
    this.configuracionService.obtenerTema().subscribe({
      next: (res) => { this.tema = res.tema; },
      error: () => { /* se queda en claro */ },
    });
    this.authService.recuperarCanales().subscribe({
      next: (c) => { this.canales = c; },
      error: () => { this.canales = null; },
    });
  }

  ngOnDestroy(): void {
    this.detenerTemporizador();
  }

  // ---------------------------------------------------------------- paso 1
  get textoCanales(): string {
    return 'tu correo corporativo registrado';
  }

  enviarCodigo(reenvio = false): void {
    if (this.cargando) return;
    this.error = '';
    this.aviso = '';
    const id = this.identificador.trim();
    if (!id) {
      this.error = 'Escribe tu usuario o tu correo.';
      return;
    }
    this.cargando = true;
    this.authService.recuperarSolicitar(id).subscribe({
      next: (res) => {
        this.cargando = false;
        this.solicitudId = res.solicitudId;
        this.vigenciaMin = res.vigenciaMin;
        this.iniciarTemporizador(res.reenvioSeg);
        this.limpiarDigitos();
        this.paso = 'codigo';
        this.aviso = reenvio ? 'Si la cuenta existe, te enviamos un código nuevo.' : '';
        setTimeout(() => this.enfocar(0), 60);
      },
      error: (err) => {
        this.cargando = false;
        this.error = err.error?.error || 'No pudimos procesar la solicitud. Intenta de nuevo.';
      },
    });
  }

  // ---------------------------------------------------------------- paso 2
  get codigo(): string { return this.digitos.join(''); }

  private iniciarTemporizador(seg: number): void {
    this.detenerTemporizador();
    this.reenvioRestante = Math.max(0, seg);
    if (!this.reenvioRestante) return;
    // Fuera de la zona: solo se redibuja el contador (evita comprobar toda la app cada segundo).
    this.zona.runOutsideAngular(() => {
      this.temporizador = setInterval(() => {
        this.zona.run(() => {
          this.reenvioRestante = Math.max(0, this.reenvioRestante - 1);
          if (!this.reenvioRestante) this.detenerTemporizador();
        });
      }, 1000);
    });
  }

  private detenerTemporizador(): void {
    if (this.temporizador) { clearInterval(this.temporizador); this.temporizador = null; }
  }

  private enfocar(i: number): void {
    const el = this.casillas?.get(Math.max(0, Math.min(5, i)))?.nativeElement;
    if (el) { el.focus(); el.select(); }
  }

  private limpiarDigitos(): void { this.digitos = ['', '', '', '', '', '']; }

  alEscribirDigito(i: number, ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const soloNumeros = input.value.replace(/\D/g, '');
    if (!soloNumeros) { this.digitos[i] = ''; input.value = ''; return; }
    // Varios dígitos de golpe (autocompletado del teléfono/teclado): se reparten desde esta casilla.
    if (soloNumeros.length > 1) { this.repartir(soloNumeros, i); return; }
    this.digitos[i] = soloNumeros;
    input.value = soloNumeros;
    this.error = '';
    if (i < 5) this.enfocar(i + 1);
    this.verificarSiCompleto();
  }

  alTeclear(i: number, ev: KeyboardEvent): void {
    if (ev.key === 'Backspace' && !this.digitos[i] && i > 0) { this.digitos[i - 1] = ''; this.enfocar(i - 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowLeft' && i > 0) { this.enfocar(i - 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowRight' && i < 5) { this.enfocar(i + 1); ev.preventDefault(); }
    else if (ev.key === 'Enter') { this.verificar(); }
  }

  alPegar(ev: ClipboardEvent): void {
    const texto = (ev.clipboardData?.getData('text') || '').replace(/\D/g, '');
    if (!texto) return;
    ev.preventDefault();
    this.repartir(texto, 0);
  }

  private repartir(numeros: string, desde: number): void {
    const lista = [...this.digitos];
    numeros.slice(0, 6 - desde).split('').forEach((d, k) => { lista[desde + k] = d; });
    this.digitos = lista;
    this.error = '';
    this.enfocar(Math.min(5, desde + numeros.length));
    this.verificarSiCompleto();
  }

  private verificarSiCompleto(): void {
    if (this.codigo.length === 6 && !this.cargando) setTimeout(() => this.verificar(), 120);
  }

  verificar(): void {
    if (this.cargando) return;
    this.error = '';
    if (this.codigo.length !== 6) { this.error = 'Escribe los 6 dígitos del código.'; return; }
    this.cargando = true;
    this.authService.recuperarVerificar(this.solicitudId, this.codigo).subscribe({
      next: (res) => {
        this.cargando = false;
        this.resetToken = res.resetToken;
        this.detenerTemporizador();
        this.paso = 'password';
        this.aviso = '';
      },
      error: (err) => {
        this.cargando = false;
        this.error = err.error?.error || 'No pudimos verificar el código.';
        if (err.error?.solicitarNuevo) {
          // Código vencido o bloqueado: se pide uno nuevo desde el paso 1.
          this.paso = 'identificar';
          this.limpiarDigitos();
        } else {
          this.limpiarDigitos();
          setTimeout(() => this.enfocar(0), 60);
        }
      },
    });
  }

  // ---------------------------------------------------------------- paso 3
  get reglas(): { texto: string; ok: boolean }[] {
    const p = this.passwordNueva;
    return [
      { texto: 'Mínimo 8 caracteres', ok: p.length >= 8 },
      { texto: 'Una mayúscula', ok: /[A-Z]/.test(p) },
      { texto: 'Una minúscula', ok: /[a-z]/.test(p) },
      { texto: 'Un número', ok: /[0-9]/.test(p) },
    ];
  }

  get coinciden(): boolean { return !!this.passwordConfirmar && this.passwordNueva === this.passwordConfirmar; }

  guardarPassword(): void {
    if (this.cargando) return;
    this.error = '';
    if (!this.passwordNueva || !this.passwordConfirmar) { this.error = 'Completa los dos campos.'; return; }
    if (this.passwordNueva !== this.passwordConfirmar) { this.error = 'La confirmación no coincide con la contraseña nueva.'; return; }
    const usuario = this.identificador.includes('@') ? undefined : this.identificador.trim();
    const errores = validarPasswordSegura(this.passwordNueva, { username: usuario });
    if (errores.length) { this.error = errores.join(' '); return; }

    this.cargando = true;
    this.authService.recuperarRestablecer(this.resetToken, this.passwordNueva).subscribe({
      next: () => {
        this.cargando = false;
        this.passwordNueva = '';
        this.passwordConfirmar = '';
        this.paso = 'listo';
      },
      error: (err) => {
        this.cargando = false;
        this.error = err.error?.error || 'No pudimos cambiar la contraseña.';
        if (err.error?.solicitarNuevo) { this.paso = 'identificar'; this.limpiarDigitos(); }
      },
    });
  }

  irAlLogin(): void {
    this.router.navigate(['/login'], { queryParams: { motivo: 'password-restablecida' } });
  }

  volverAlInicio(): void {
    this.paso = 'identificar';
    this.error = '';
    this.aviso = '';
    this.limpiarDigitos();
    this.detenerTemporizador();
  }

  get numeroPaso(): number { return { identificar: 1, codigo: 2, password: 3, listo: 3 }[this.paso]; }
}
