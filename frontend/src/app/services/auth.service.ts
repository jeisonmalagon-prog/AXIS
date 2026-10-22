import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export type RolModulo = 'CONSULTA' | 'ADMIN_MIN';

export interface UsuarioActual {
  id: number;
  username: string;
  nombre: string;
  rol: string;
  modulos: string[];
  // Rol del usuario en cada módulo habilitado: 'CONSULTA' (solo ver) o
  // 'ADMIN_MIN' (crear/editar/borrar). Lo decide el ADMIN_POD en Gestión de
  // Usuarios. Puede faltar en sesiones guardadas antes de esta función: ver
  // AuthService.rolEnModulo(), que en ese caso deduce el rol del rol global.
  modulosRoles?: Record<string, RolModulo>;
  // true justo tras el primer login de una cuenta nueva, o después de que
  // un administrador le resetee la contraseña — mientras esto sea true, el
  // backend bloquea todo excepto /api/auth/(me|cambiar-password|perfil) y
  // el debeCambiarPasswordGuard manda al usuario a /cambiar-password.
  debeCambiarPassword: boolean;
  fechaUltimoCambioPassword: string | null;
  // Foto de perfil como data URI (base64), o null si no tiene. Ver
  // fotoPerfilValida en backend/routes/auth.js para el formato exacto.
  fotoPerfil: string | null;
  // Contacto para recuperar la contraseña con código (OTP): correo corporativo y celular (+57…).
  correo?: string | null;
  telefono?: string | null;
  // Sesión: ¿puede ajustar en Mi perfil cuánto tiempo de inactividad tolera su
  // sesión? (lo decide el ADMIN_POD por usuario), los minutos vigentes y si ese
  // valor lo eligió él. Pueden faltar en sesiones guardadas antes de esta función
  // (se asume la política por defecto: 15 min).
  sesionPersonalizable?: boolean;
  sesionMinutos?: number;
  sesionPersonalizada?: boolean;
}

// Tiempos de inactividad que un usuario habilitado puede elegir (minutos).
// Mismos valores que valida el backend (OPCIONES_MINUTOS en utils/sesionUsuario.js).
export const OPCIONES_SESION_MINUTOS = [15, 30, 60, 120, 240, 480, 720];
export const SESION_MINUTOS_POR_DEFECTO = 15;

export function etiquetaMinutosSesion(minutos: number): string {
  if (minutos >= 60 && minutos % 60 === 0) return minutos === 60 ? '1 hora' : `${minutos / 60} horas`;
  return `${minutos} minutos`;
}

export interface RespuestaSesion {
  message: string;
  token: string;
  usuario: UsuarioActual;
}

// La sesión (token + usuario) se guarda en sessionStorage, NO localStorage:
// sessionStorage se borra automáticamente al cerrar la pestaña/ventana, así
// que cerrar el navegador termina la sesión de inmediato en vez de dejarla
// viva hasta que el JWT expire por su cuenta (hasta 2h, ver TOKEN_EXPIRES_IN
// en backend/routes/auth.js). Efecto secundario esperado: una pestaña nueva
// (abierta escribiendo la URL, no con un link/target=_blank desde una
// pestaña ya logueada) no hereda la sesión -- hay que loguearse otra vez.
// Eso es exactamente el comportamiento de seguridad que se buscaba.
@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private authUrl = `${environment.apiUrl}/auth`;

  // Esto avisa a toda la app si hay alguien conectado
  private usuarioLogueadoSubject = new BehaviorSubject<UsuarioActual | null>(this.obtenerUsuarioDeStorage());
  public usuarioLogueado$ = this.usuarioLogueadoSubject.asObservable();

  constructor(private http: HttpClient) {}

  login(username: string, password: string): Observable<RespuestaSesion> {
    return this.http.post<RespuestaSesion>(`${this.authUrl}/login`, { username, password }).pipe(
      tap(respuesta => {
        if (respuesta.token) {
          this.guardarSesion(respuesta.token, respuesta.usuario);
        }
      })
    );
  }

  // Cambia la contraseña del usuario autenticado (exige la actual). El
  // backend re-emite el token ya sin debeCambiarPassword=true, así que acá
  // también se vuelve a guardar la sesión con ese token nuevo.
  cambiarPassword(passwordActual: string, passwordNueva: string): Observable<RespuestaSesion> {
    return this.http.put<RespuestaSesion>(`${this.authUrl}/cambiar-password`, { passwordActual, passwordNueva }).pipe(
      tap(respuesta => {
        if (respuesta.token) {
          this.guardarSesion(respuesta.token, respuesta.usuario);
        }
      })
    );
  }

  // Edita el nombre completo del propio usuario y, opcionalmente, su foto de
  // perfil. No devuelve un token nuevo (el rol/módulos no cambian), así que
  // solo se actualiza el usuario en memoria/sessionStorage.
  //
  // fotoPerfil es opcional a propósito: si no se pasa este argumento, la
  // clave "fotoPerfil" ni siquiera se incluye en el body, y el backend deja
  // la foto actual intacta (así un guardado de solo-nombre no la toca). Para
  // borrar la foto, pasar explícitamente null.
  actualizarPerfil(nombreCompleto: string, fotoPerfil?: string | null, contacto?: { correo?: string | null; telefono?: string | null }): Observable<{ message: string; usuario: UsuarioActual }> {
    const body: { nombreCompleto: string; fotoPerfil?: string | null; correo?: string | null; telefono?: string | null } = { nombreCompleto };
    if (fotoPerfil !== undefined) {
      body.fotoPerfil = fotoPerfil;
    }
    // Igual que la foto: lo que no se pase no se envía y el backend lo deja como está ('' o null = borrar).
    if (contacto?.correo !== undefined) body.correo = contacto.correo;
    if (contacto?.telefono !== undefined) body.telefono = contacto.telefono;
    return this.http.put<{ message: string; usuario: UsuarioActual }>(`${this.authUrl}/perfil`, body).pipe(
      tap(respuesta => {
        if (respuesta.usuario) {
          sessionStorage.setItem('usuario', JSON.stringify(respuesta.usuario));
          this.usuarioLogueadoSubject.next(respuesta.usuario);
        }
      })
    );
  }

  // Ajusta el tiempo de inactividad de la sesión del propio usuario (solo si el
  // ADMIN_POD se lo habilitó). null = volver al valor por defecto. El backend
  // reemite el token con la nueva duración, así que se vuelve a guardar la sesión.
  actualizarSesion(minutos: number | null): Observable<RespuestaSesion> {
    return this.http.put<RespuestaSesion>(`${this.authUrl}/sesion`, { minutos }).pipe(
      tap(respuesta => {
        if (respuesta.token) {
          this.guardarSesion(respuesta.token, respuesta.usuario);
        }
      })
    );
  }

  // Refresca el perfil desde el backend (por si otro admin cambió algo, o
  // simplemente para no depender solo de lo que quedó en sessionStorage).
  // /me ahora también reemite token+usuario frescos (igual que login/cambiar
  // password), así que guardamos la sesión de nuevo para que el resto de la
  // app (sidebar, guards, llamadas a la API) vea los módulos al día.
  obtenerPerfil(): Observable<RespuestaSesion> {
    return this.http.get<RespuestaSesion>(`${this.authUrl}/me`).pipe(
      tap(respuesta => {
        if (respuesta.token) {
          this.guardarSesion(respuesta.token, respuesta.usuario);
        }
      })
    );
  }

  // ---- Recuperar contraseña con código (OTP). Rutas públicas: no llevan token. ----
  recuperarCanales(): Observable<{ correo: boolean; sms: boolean; vigenciaMin: number }> {
    return this.http.get<{ correo: boolean; sms: boolean; vigenciaMin: number }>(`${this.authUrl}/recuperar/canales`);
  }

  recuperarSolicitar(identificador: string): Observable<{ mensaje: string; solicitudId: string; vigenciaMin: number; reenvioSeg: number }> {
    return this.http.post<{ mensaje: string; solicitudId: string; vigenciaMin: number; reenvioSeg: number }>(`${this.authUrl}/recuperar/solicitar`, { identificador });
  }

  recuperarVerificar(solicitudId: string, codigo: string): Observable<{ resetToken: string; vigenciaMin: number }> {
    return this.http.post<{ resetToken: string; vigenciaMin: number }>(`${this.authUrl}/recuperar/verificar`, { solicitudId, codigo });
  }

  recuperarRestablecer(resetToken: string, passwordNueva: string): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(`${this.authUrl}/recuperar/restablecer`, { resetToken, passwordNueva });
  }

  logout(): void {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('usuario');
    this.usuarioLogueadoSubject.next(null);
  }

  private guardarSesion(token: string, usuario: UsuarioActual): void {
    sessionStorage.setItem('token', token);
    sessionStorage.setItem('usuario', JSON.stringify(usuario));
    this.usuarioLogueadoSubject.next(usuario);
  }

  private obtenerUsuarioDeStorage(): UsuarioActual | null {
    const usuarioStr = sessionStorage.getItem('usuario');
    return usuarioStr ? JSON.parse(usuarioStr) : null;
  }

  getToken(): string | null {
    return sessionStorage.getItem('token');
  }
  estaAutenticado(): boolean {
    return !!this.getToken(); // Devuelve true si hay token, false si no hay
  }

  obtenerDatosUsuario(): UsuarioActual | null {
    return this.usuarioLogueadoSubject.value;
  }

  // Rol del usuario actual en un módulo: 'ADMIN_MIN', 'CONSULTA' o null si el
  // módulo no está habilitado para él. ADMIN_POD es ADMIN_MIN en todos.
  // Mismo criterio que el backend (utils/permisosModulos.js): si no hay rol
  // propio para el módulo se deduce del rol global (BASIC = consulta), salvo
  // Tareas, donde todos pueden gestionar lo suyo mientras no se les asigne
  // Consulta explícitamente.
  rolEnModulo(modulo: string): RolModulo | null {
    const usuario = this.obtenerDatosUsuario();
    if (!usuario) return null;
    if (usuario.rol === 'ADMIN_POD') return 'ADMIN_MIN';
    if (!usuario.modulos?.includes(modulo)) return null;
    const propio = usuario.modulosRoles?.[modulo];
    if (propio === 'CONSULTA' || propio === 'ADMIN_MIN') return propio;
    if (modulo === 'TAREAS') return 'ADMIN_MIN';
    return usuario.rol === 'BASIC' ? 'CONSULTA' : 'ADMIN_MIN';
  }

  // ¿Puede crear/editar/borrar en este módulo? (la pantalla oculta botones; el
  // backend vuelve a validarlo en cada petición).
  puedeEditar(modulo: string): boolean {
    return this.rolEnModulo(modulo) === 'ADMIN_MIN';
  }
}
