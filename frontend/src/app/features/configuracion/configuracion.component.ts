import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ConfiguracionService, Tema, ConfigCorreo } from '../../services/configuracion.service';
import { AuthService } from '../../services/auth.service';
import { COLOR_LOGIN_POR_DEFECTO, generarPaletaLogin, PaletaLogin } from '../../shared/color-login.util';
import { BrandColorService } from '../../services/brand-color.service';

const PATRON_COLOR_HEX = /^#[0-9A-Fa-f]{6}$/;

@Component({
  selector: 'app-configuracion',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './configuracion.component.html',
  styleUrl: './configuracion.component.scss'
})
export class ConfiguracionComponent implements OnInit {
  cargando = true;
  guardando = false;
  tema: Tema = 'claro';
  error = '';
  mensajeOk = '';

  // --- Color de marca de AXIS (se aplica en TODA la app: sidebar,
  // botones, acentos, degradado del login, etc. -- es independiente del
  // tema claro/oscuro de arriba) ---
  colorLogin = COLOR_LOGIN_POR_DEFECTO;
  private colorLoginGuardado = COLOR_LOGIN_POR_DEFECTO;
  guardandoColor = false;
  errorColor = '';
  mensajeColorOk = '';

  // --- Correo saliente (SMTP): lo usan la recuperación de contraseña, los informes y las alertas ---
  correoCfg: ConfigCorreo | null = null;
  cHost = '';
  cPort = 587;
  cConexion: 'starttls' | 'ssl' = 'starttls';
  cUser = '';
  cPass = '';
  cFrom = '';
  cDominios = '';
  cTlsInseguro = false;
  verPass = false;
  guardandoCorreo = false;
  probandoCorreo = false;
  restableciendoCorreo = false;
  errorCorreo = '';
  mensajeCorreoOk = '';
  errorPrueba = '';
  mensajePruebaOk = '';
  destinoPrueba = '';

  constructor(
    private configuracionService: ConfiguracionService,
    private brandColorService: BrandColorService,
    private authService: AuthService
  ) {}

  ngOnInit(): void {
    this.configuracionService.obtenerTema().subscribe({
      next: (res) => {
        this.tema = res.tema;
        this.cargando = false;
      },
      error: () => {
        this.error = 'No se pudo cargar la configuración actual. Intenta recargar la página.';
        this.cargando = false;
      }
    });

    this.cargarCorreo();
    this.authService.obtenerPerfil().subscribe({
      next: (r) => { if (!this.destinoPrueba) this.destinoPrueba = r.usuario.correo || ''; },
      error: () => { /* el admin lo escribe a mano */ }
    });

    this.configuracionService.obtenerColorLogin().subscribe({
      next: (res) => {
        this.colorLogin = res.colorLogin;
        this.colorLoginGuardado = res.colorLogin;
      },
      error: () => { /* se queda en el morado por defecto */ }
    });
  }

  // ------------------------------------------------------------------ correo saliente
  private cargarCorreo(): void {
    this.configuracionService.obtenerCorreo().subscribe({
      next: (c) => this.aplicarCorreo(c),
      error: (err) => { this.errorCorreo = err.error?.error || 'No se pudo cargar la configuración del correo.'; }
    });
  }

  private aplicarCorreo(c: ConfigCorreo): void {
    this.correoCfg = c;
    this.cHost = c.host;
    this.cPort = c.port;
    this.cConexion = c.secure ? 'ssl' : 'starttls';
    this.cUser = c.user;
    this.cPass = '';
    this.cFrom = c.from;
    this.cDominios = c.dominios;
    this.cTlsInseguro = c.tlsInseguro;
  }

  // Al cambiar de tipo de conexión se sugiere el puerto habitual (solo si estaba en el del otro tipo).
  cambiarConexion(tipo: 'starttls' | 'ssl'): void {
    this.cConexion = tipo;
    if (tipo === 'ssl' && Number(this.cPort) === 587) this.cPort = 465;
    if (tipo === 'starttls' && Number(this.cPort) === 465) this.cPort = 587;
  }

  get correoValido(): boolean {
    const puerto = Number(this.cPort);
    const hayPass = !!this.cPass || !!this.correoCfg?.tienePass;
    return !!this.cHost.trim() && !!this.cUser.trim() && hayPass && Number.isInteger(puerto) && puerto >= 1 && puerto <= 65535;
  }

  guardarCorreo(): void {
    if (!this.correoValido || this.guardandoCorreo) return;
    this.errorCorreo = '';
    this.mensajeCorreoOk = '';
    this.guardandoCorreo = true;
    this.configuracionService.guardarCorreo({
      host: this.cHost.trim(),
      port: Number(this.cPort),
      secure: this.cConexion === 'ssl',
      user: this.cUser.trim(),
      pass: this.cPass || undefined,
      from: this.cFrom.trim(),
      dominios: this.cDominios.trim(),
      tlsInseguro: this.cTlsInseguro
    }).subscribe({
      next: (c) => {
        this.guardandoCorreo = false;
        this.aplicarCorreo(c);
        this.mensajeCorreoOk = 'Correo guardado. Ya se usa en la recuperación de contraseña, los informes y las alertas; envía uno de prueba para confirmarlo.';
      },
      error: (err) => {
        this.guardandoCorreo = false;
        this.errorCorreo = err.error?.error || 'No se pudo guardar la configuración del correo.';
      }
    });
  }

  probarCorreo(): void {
    if (this.probandoCorreo || !this.destinoPrueba.trim()) return;
    this.errorPrueba = '';
    this.mensajePruebaOk = '';
    this.probandoCorreo = true;
    this.configuracionService.probarCorreo(this.destinoPrueba.trim()).subscribe({
      next: (r) => {
        this.probandoCorreo = false;
        this.mensajePruebaOk = `Correo de prueba enviado a ${r.destinatario}. Revisa la bandeja (y el spam).`;
      },
      error: (err) => {
        this.probandoCorreo = false;
        this.errorPrueba = err.error?.error || 'No se pudo enviar el correo de prueba.';
      }
    });
  }

  restablecerCorreo(): void {
    if (this.restableciendoCorreo || !confirm('Se borra lo guardado aquí y el backend vuelve a usar solo el archivo .env (si no tiene correo, la recuperación de contraseña queda desactivada). ¿Continuar?')) return;
    this.errorCorreo = '';
    this.mensajeCorreoOk = '';
    this.restableciendoCorreo = true;
    this.configuracionService.restablecerCorreo().subscribe({
      next: (c) => {
        this.restableciendoCorreo = false;
        this.aplicarCorreo(c);
        this.mensajeCorreoOk = 'Se quitó la configuración guardada.';
      },
      error: (err) => {
        this.restableciendoCorreo = false;
        this.errorCorreo = err.error?.error || 'No se pudo restablecer.';
      }
    });
  }

  elegirTema(nuevoTema: Tema): void {
    if (nuevoTema === this.tema || this.guardando) return;

    this.error = '';
    this.mensajeOk = '';
    this.guardando = true;
    const temaAnterior = this.tema;
    this.tema = nuevoTema; // feedback visual inmediato

    this.configuracionService.actualizarTema(nuevoTema).subscribe({
      next: (res) => {
        this.tema = res.tema;
        this.guardando = false;
        this.mensajeOk = 'Tema actualizado. Todos los usuarios lo verán reflejado al recargar la página.';
      },
      error: (err) => {
        this.tema = temaAnterior; // revierte el feedback visual si falló
        this.guardando = false;
        this.error = err.error?.error || 'No se pudo actualizar el tema. Intenta de nuevo.';
      }
    });
  }

  // Paleta calculada en vivo mientras el admin mueve el selector, para la
  // vista previa de la tarjeta de login (misma función pura que usa el
  // login real -- ver color-login.util.ts).
  get paletaPreview(): PaletaLogin {
    return generarPaletaLogin(this.colorLogin);
  }

  get colorLoginValido(): boolean {
    return PATRON_COLOR_HEX.test(this.colorLogin || '');
  }

  get colorLoginModificado(): boolean {
    return this.colorLoginValido && this.colorLogin.toLowerCase() !== this.colorLoginGuardado.toLowerCase();
  }

  guardarColorLogin(): void {
    if (!this.colorLoginModificado || this.guardandoColor) return;

    this.errorColor = '';
    this.mensajeColorOk = '';
    this.guardandoColor = true;

    this.configuracionService.actualizarColorLogin(this.colorLogin).subscribe({
      next: (res) => {
        this.colorLogin = res.colorLogin;
        this.colorLoginGuardado = res.colorLogin;
        this.guardandoColor = false;
        this.mensajeColorOk = 'Color de marca actualizado en toda la aplicación.';
        // Repinta TODA la app (incluida esta misma sesión del admin) al
        // instante, sin recargar -- mismo criterio que elegirTema() usa
        // para el tema claro/oscuro.
        this.brandColorService.aplicar(res.colorLogin);
      },
      error: (err) => {
        this.guardandoColor = false;
        this.errorColor = err.error?.error || 'No se pudo actualizar el color de marca.';
      }
    });
  }

  restablecerColorLogin(): void {
    if (this.guardandoColor) return;
    this.errorColor = '';
    this.mensajeColorOk = '';
    this.colorLogin = COLOR_LOGIN_POR_DEFECTO;
  }
}
