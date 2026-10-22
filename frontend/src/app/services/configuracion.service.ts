import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export type Tema = 'claro' | 'oscuro';
export type TemaPersonalInput = Tema | 'sistema';

// Correo saliente (SMTP). La contraseña nunca viaja de vuelta: solo `tienePass`.
export interface ConfigCorreo {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  tienePass: boolean;
  passIlegible: boolean;
  from: string;
  dominios: string;
  tlsInseguro: boolean;
  configurado: boolean;
  origen: 'bd' | 'env' | 'ninguno';
  tablaLista: boolean;
}
export interface GuardarCorreo {
  host: string; port: number; secure: boolean; user: string; pass?: string;
  from?: string; dominios?: string; tlsInseguro?: boolean;
}

// Configuración GLOBAL del sistema: el tema_global, elegible únicamente por
// ADMIN_POD desde /configuracion, y leído también por el login ANTES de que
// exista una sesión (por eso el GET no requiere estar autenticado — ver
// backend/routes/configuracion.js). El mismo mecanismo se usa para el color
// de marca del login (colorLogin), que a diferencia del tema SOLO afecta la
// pantalla de login.
//
// Además, cada usuario logueado puede tener su propia preferencia (tema
// PERSONAL, ver /perfil) que sobreescribe al tema_global solo para él/ella;
// null significa "no tiene una propia, usa el tema_global".
//
// temaActual$ es el tema que REALMENTE debe pintarse en pantalla en cada
// momento (ya resuelto: personal si existe, si no el global). El shell lo
// calcula una vez al iniciar sesión y lo publica aquí; /perfil lo actualiza
// al vuelo cuando el usuario cambia su preferencia, sin necesitar recargar
// la página.
@Injectable({
  providedIn: 'root'
})
export class ConfiguracionService {
  private apiUrl = `${environment.apiUrl}/configuracion`;

  private temaActualSubject = new BehaviorSubject<Tema>('claro');
  temaActual$ = this.temaActualSubject.asObservable();

  constructor(private http: HttpClient) {}

  obtenerTema(): Observable<{ tema: Tema }> {
    return this.http.get<{ tema: Tema }>(`${this.apiUrl}/tema`);
  }

  actualizarTema(tema: Tema): Observable<{ tema: Tema }> {
    return this.http.put<{ tema: Tema }>(`${this.apiUrl}/tema`, { tema });
  }

  // Color de marca del login (degradado/botón), elegido por ADMIN_POD desde
  // /configuracion. Solo se usa en la pantalla de login.
  obtenerColorLogin(): Observable<{ colorLogin: string }> {
    return this.http.get<{ colorLogin: string }>(`${this.apiUrl}/color-login`);
  }

  actualizarColorLogin(colorLogin: string): Observable<{ colorLogin: string }> {
    return this.http.put<{ colorLogin: string }>(`${this.apiUrl}/color-login`, { colorLogin });
  }

  // Correo saliente (SMTP): solo ADMIN_POD. Se guarda en la BD, no en el .env.
  obtenerCorreo(): Observable<ConfigCorreo> {
    return this.http.get<ConfigCorreo>(`${this.apiUrl}/correo`);
  }

  guardarCorreo(datos: GuardarCorreo): Observable<ConfigCorreo> {
    return this.http.put<ConfigCorreo>(`${this.apiUrl}/correo`, datos);
  }

  probarCorreo(destinatario: string): Observable<{ enviado: boolean; destinatario: string }> {
    return this.http.post<{ enviado: boolean; destinatario: string }>(`${this.apiUrl}/correo/probar`, { destinatario });
  }

  restablecerCorreo(): Observable<ConfigCorreo> {
    return this.http.post<ConfigCorreo>(`${this.apiUrl}/correo/restablecer`, {});
  }

  // Preferencia PERSONAL del usuario logueado (independiente del global).
  obtenerTemaPersonal(): Observable<{ temaPersonal: Tema | null }> {
    return this.http.get<{ temaPersonal: Tema | null }>(`${this.apiUrl}/tema/mio`);
  }

  // tema: 'claro' | 'oscuro' para fijar una preferencia propia, o 'sistema'
  // para volver a seguir el tema_global.
  actualizarTemaPersonal(tema: TemaPersonalInput): Observable<{ temaPersonal: Tema | null }> {
    return this.http.put<{ temaPersonal: Tema | null }>(`${this.apiUrl}/tema/mio`, { tema });
  }

  // El shell (al iniciar sesión) y /perfil (al cambiar la preferencia)
  // llaman esto para que TODA la app se actualice al instante.
  establecerTemaActual(tema: Tema): void {
    this.temaActualSubject.next(tema);
  }
}
