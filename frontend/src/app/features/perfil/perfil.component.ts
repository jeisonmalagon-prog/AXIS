import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  AuthService,
  UsuarioActual,
  OPCIONES_SESION_MINUTOS,
  SESION_MINUTOS_POR_DEFECTO,
  etiquetaMinutosSesion,
} from '../../services/auth.service';
import { ConfiguracionService, Tema, TemaPersonalInput } from '../../services/configuracion.service';

@Component({
  selector: 'app-perfil',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './perfil.component.html',
  styleUrls: ['./perfil.component.scss'],
})
export class PerfilComponent implements OnInit {
  usuario: UsuarioActual | null = null;
  nombreCompleto = '';

  cargando = true;
  error = '';

  guardandoNombre = false;
  // Contacto para recuperar la contraseña con código (OTP)
  correo = '';
  guardandoContacto = false;
  mensajeContactoOk = '';
  errorContacto = '';
  mensajeNombreOk = '';
  errorNombre = '';

  // --- Foto de perfil ---
  // fotoSeleccionadaNueva: la imagen ya redimensionada (data URI), pendiente
  // de guardar -- null mientras no se haya elegido un archivo nuevo. Se
  // muestra como vista previa; el usuario debe presionar "Guardar" para que
  // realmente se envíe al backend (así puede arrepentirse con "Cancelar").
  fotoSeleccionadaNueva: string | null = null;
  guardandoFoto = false;
  procesandoFoto = false;
  mensajeFotoOk = '';
  errorFoto = '';
  private readonly FOTO_MAX_DIMENSION = 320;
  private readonly FOTO_CALIDAD_JPEG = 0.85;
  private readonly FOTO_MAX_MB_ORIGEN = 8; // límite generoso sobre el archivo ORIGINAL, antes de redimensionar

  // Preferencia de tema PERSONAL (independiente del tema_global de
  // /configuracion). 'sistema' = seguir el tema_global.
  temaSeleccionado: TemaPersonalInput = 'sistema';
  guardandoTema = false;
  errorTema = '';
  temaGlobalActual: Tema = 'claro'; // para saber qué pinta 'sistema' en la vista previa

  // --- Tiempo de sesión ---
  // Solo se ofrece si el ADMIN_POD habilitó al usuario (usuario.sesionPersonalizable).
  // Es el tiempo SIN ACTIVIDAD tras el cual se cierra la sesión; mientras la
  // persona trabaja, la sesión se renueva sola.
  readonly opcionesSesion = OPCIONES_SESION_MINUTOS.map((m) => ({ minutos: m, etiqueta: etiquetaMinutosSesion(m) }));
  readonly sesionPorDefecto = SESION_MINUTOS_POR_DEFECTO;
  guardandoSesion = false;
  mensajeSesionOk = '';
  errorSesion = '';

  get sesionMinutosActual(): number {
    return this.usuario?.sesionMinutos || SESION_MINUTOS_POR_DEFECTO;
  }

  get sesionEtiquetaActual(): string {
    return etiquetaMinutosSesion(this.sesionMinutosActual);
  }

  elegirSesion(minutos: number | null): void {
    if (this.guardandoSesion) return;
    if (minutos !== null && minutos === this.sesionMinutosActual && this.usuario?.sesionPersonalizada) return;
    this.errorSesion = '';
    this.mensajeSesionOk = '';
    this.guardandoSesion = true;
    this.authService.actualizarSesion(minutos).subscribe({
      next: (res) => {
        this.guardandoSesion = false;
        this.usuario = res.usuario;
        this.mensajeSesionOk = minutos === null
          ? `Tiempo de sesión restablecido (${etiquetaMinutosSesion(SESION_MINUTOS_POR_DEFECTO)} sin actividad).`
          : `Listo: tu sesión se cerrará tras ${etiquetaMinutosSesion(minutos)} sin actividad.`;
      },
      error: (err) => {
        this.guardandoSesion = false;
        this.errorSesion = err.error?.error || 'No se pudo actualizar el tiempo de sesión.';
      },
    });
  }

  // "CERTIFICADOS (Consulta), TAREAS (Admin)": módulos habilitados con el rol que
  // el administrador le dio al usuario en cada uno.
  get modulosConRol(): string {
    if (!this.usuario) return '—';
    if (this.usuario.rol === 'ADMIN_POD') return 'Todos (acceso total)';
    if (!this.usuario.modulos?.length) return '—';
    return this.usuario.modulos
      .map((m) => `${m} (${this.authService.rolEnModulo(m) === 'ADMIN_MIN' ? 'Admin' : 'Consulta'})`)
      .join(', ');
  }

  constructor(
    private authService: AuthService,
    private router: Router,
    private configuracionService: ConfiguracionService
  ) {}

  ngOnInit(): void {
    // Se pide /me en vez de confiar solo en localStorage, por si otro admin
    // cambió algo (rol, módulos) desde el último login de esta persona.
    this.authService.obtenerPerfil().subscribe({
      next: (respuesta) => {
        this.usuario = respuesta.usuario;
        this.nombreCompleto = respuesta.usuario.nombre;
        this.correo = respuesta.usuario.correo || '';
        this.cargando = false;
      },
      error: (err) => {
        this.error = err.error?.error || 'No se pudo cargar tu perfil.';
        this.cargando = false;
        // Si igual ya teníamos algo en memoria (login reciente), lo mostramos.
        this.usuario = this.authService.obtenerDatosUsuario();
        if (this.usuario) {
          this.nombreCompleto = this.usuario.nombre;
          this.correo = this.usuario.correo || '';
          this.error = '';
        }
      },
    });

    this.configuracionService.obtenerTema().subscribe({
      next: (res) => { this.temaGlobalActual = res.tema; },
      error: () => { /* se queda en 'claro' por defecto */ }
    });

    this.configuracionService.obtenerTemaPersonal().subscribe({
      next: (res) => { this.temaSeleccionado = res.temaPersonal || 'sistema'; },
      error: () => { /* se queda en 'sistema' por defecto */ }
    });
  }

  elegirTema(tema: TemaPersonalInput): void {
    if (tema === this.temaSeleccionado || this.guardandoTema) return;

    this.errorTema = '';
    const anterior = this.temaSeleccionado;
    this.temaSeleccionado = tema; // feedback visual inmediato
    this.guardandoTema = true;

    this.configuracionService.actualizarTemaPersonal(tema).subscribe({
      next: (res) => {
        this.guardandoTema = false;
        this.temaSeleccionado = res.temaPersonal || 'sistema';
        // Aplica el cambio de inmediato en toda la app (sidebar, tarjetas,
        // etc.) sin necesidad de recargar la página.
        this.configuracionService.establecerTemaActual(res.temaPersonal || this.temaGlobalActual);
      },
      error: (err) => {
        this.guardandoTema = false;
        this.temaSeleccionado = anterior;
        this.errorTema = err.error?.error || 'No se pudo actualizar el tema.';
      },
    });
  }

  guardarNombre(): void {
    this.errorNombre = '';
    this.mensajeNombreOk = '';

    if (!this.nombreCompleto.trim()) {
      this.errorNombre = 'El nombre completo no puede estar vacío.';
      return;
    }

    this.guardandoNombre = true;
    this.authService.actualizarPerfil(this.nombreCompleto.trim()).subscribe({
      next: (res) => {
        this.guardandoNombre = false;
        this.usuario = res.usuario;
        this.mensajeNombreOk = 'Nombre actualizado correctamente.';
      },
      error: (err) => {
        this.guardandoNombre = false;
        this.errorNombre = err.error?.error || 'No se pudo actualizar el nombre.';
      },
    });
  }

  // Guarda el correo y el celular donde llegará el código si olvidas tu contraseña.
  guardarContacto(): void {
    this.errorContacto = '';
    this.mensajeContactoOk = '';
    if (!this.usuario) return;
    this.guardandoContacto = true;
    // PUT /perfil exige el nombre; se reenvía el actual (sin tocarlo) junto con el contacto.
    this.authService.actualizarPerfil(this.usuario.nombre, undefined, { correo: this.correo.trim() }).subscribe({
      next: (res) => {
        this.guardandoContacto = false;
        this.usuario = res.usuario;
        this.correo = res.usuario.correo || '';
        this.mensajeContactoOk = this.correo ? 'Contacto actualizado. Si olvidas tu contraseña, enviaremos el código a tu correo.' : 'Sin correo registrado no podrás recuperar tu contraseña por tu cuenta.';
      },
      error: (err) => {
        this.guardandoContacto = false;
        this.errorContacto = err.error?.error || 'No se pudo guardar el contacto.';
      },
    });
  }

  get contactoSinCambios(): boolean {
    return (this.correo.trim() === (this.usuario?.correo || ''));
  }

  irACambiarPassword(): void {
    this.router.navigate(['/cambiar-password']);
  }

  // --- Foto de perfil ---

  // Iniciales como respaldo cuando no hay foto (ej. "Jeison Malagón" -> "JM").
  get inicialesUsuario(): string {
    const nombre = (this.usuario?.nombre || '').trim();
    if (!nombre) return '?';
    const partes = nombre.split(/\s+/).filter(Boolean);
    const primera = partes[0]?.[0] || '';
    const segunda = partes.length > 1 ? partes[partes.length - 1][0] : '';
    return (primera + segunda).toUpperCase();
  }

  // Lo que se debe mostrar en el avatar ahora mismo: la vista previa de una
  // foto recién elegida (si hay una pendiente de guardar), si no la foto ya
  // guardada, si no null (y entonces se muestran las iniciales).
  get fotoParaMostrar(): string | null {
    return this.fotoSeleccionadaNueva ?? this.usuario?.fotoPerfil ?? null;
  }

  async onFotoSeleccionada(event: Event): Promise<void> {
    this.errorFoto = '';
    this.mensajeFotoOk = '';

    const input = event.target as HTMLInputElement;
    const archivo = input.files?.[0] || null;
    input.value = ''; // permite volver a elegir el mismo archivo si se cancela después

    if (!archivo) return;

    if (!/^image\/(png|jpe?g|webp)$/.test(archivo.type)) {
      this.errorFoto = 'Elige una imagen en formato JPG, PNG o WEBP.';
      return;
    }
    if (archivo.size > this.FOTO_MAX_MB_ORIGEN * 1024 * 1024) {
      this.errorFoto = `La imagen es demasiado pesada (máximo ${this.FOTO_MAX_MB_ORIGEN} MB antes de redimensionar).`;
      return;
    }

    this.procesandoFoto = true;
    try {
      this.fotoSeleccionadaNueva = await this.redimensionarImagen(archivo);
    } catch (err) {
      console.error('Error preparando la foto de perfil:', err);
      this.errorFoto = 'No se pudo procesar esa imagen. Intenta con otro archivo.';
    } finally {
      this.procesandoFoto = false;
    }
  }

  // Redimensiona la imagen en el navegador (sin subir el archivo original al
  // servidor) a un cuadrado de hasta 320px de lado, recortando al centro, y
  // la devuelve como JPEG en base64 -- así el data URI final queda bien por
  // debajo del límite de 2,000,000 caracteres que valida el backend
  // (MAX_FOTO_PERFIL_BASE64_CHARS en auth.js), sin importar cuán grande sea
  // la foto original.
  private redimensionarImagen(archivo: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onerror = () => reject(lector.error || new Error('No se pudo leer el archivo.'));
      lector.onload = () => {
        const imagen = new Image();
        imagen.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
        imagen.onload = () => {
          const lado = Math.min(imagen.width, imagen.height);
          const origenX = (imagen.width - lado) / 2;
          const origenY = (imagen.height - lado) / 2;
          const destino = Math.min(this.FOTO_MAX_DIMENSION, lado);

          const canvas = document.createElement('canvas');
          canvas.width = destino;
          canvas.height = destino;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('No se pudo preparar la imagen.')); return; }
          ctx.drawImage(imagen, origenX, origenY, lado, lado, 0, 0, destino, destino);

          resolve(canvas.toDataURL('image/jpeg', this.FOTO_CALIDAD_JPEG));
        };
        imagen.src = lector.result as string;
      };
      lector.readAsDataURL(archivo);
    });
  }

  guardarFoto(): void {
    if (!this.fotoSeleccionadaNueva || !this.usuario) return;
    this.guardarFotoConValor(this.fotoSeleccionadaNueva);
  }

  cancelarFoto(): void {
    this.fotoSeleccionadaNueva = null;
    this.errorFoto = '';
  }

  eliminarFoto(): void {
    if (!this.usuario?.fotoPerfil && !this.fotoSeleccionadaNueva) return;
    this.guardarFotoConValor(null);
  }

  private guardarFotoConValor(fotoPerfil: string | null): void {
    if (!this.usuario) return;
    this.errorFoto = '';
    this.mensajeFotoOk = '';
    this.guardandoFoto = true;

    // Se reenvía el nombre actual tal cual porque el backend exige
    // nombreCompleto en cada PUT /perfil, aunque en este caso lo único que
    // cambia sea la foto.
    this.authService.actualizarPerfil(this.usuario.nombre, fotoPerfil).subscribe({
      next: (res) => {
        this.guardandoFoto = false;
        this.usuario = res.usuario;
        this.fotoSeleccionadaNueva = null;
        this.mensajeFotoOk = fotoPerfil ? 'Foto de perfil actualizada.' : 'Foto de perfil eliminada.';
      },
      error: (err) => {
        this.guardandoFoto = false;
        this.errorFoto = err.error?.error || 'No se pudo guardar la foto de perfil.';
      },
    });
  }
}
