import { Injectable } from '@angular/core';
import { ConfiguracionService } from './configuracion.service';
import { COLOR_LOGIN_POR_DEFECTO, generarPaletaLogin } from '../shared/color-login.util';

// Aplica el color de marca elegido por ADMIN_POD (ver /configuracion) como
// variables CSS en la raíz del documento, para que TODA la app (no solo el
// login) lo use: sidebar, botones, focos de formulario, degradados, etc.
// Cualquier SCSS del proyecto que quiera seguir el color de marca referencia
// estas variables -- nunca un valor morado/magenta quemado -- con un
// fallback al morado de siempre por si la variable no está definida.
@Injectable({
  providedIn: 'root'
})
export class BrandColorService {
  constructor(private configuracionService: ConfiguracionService) {}

  // Se llama una sola vez al arrancar la app (ver AppComponent). Lee el
  // color guardado en el backend y lo aplica; si falla, aplica el morado
  // por defecto para que la app nunca se quede sin variables CSS definidas.
  inicializar(): void {
    this.configuracionService.obtenerColorLogin().subscribe({
      next: (res) => this.aplicar(res.colorLogin),
      error: () => this.aplicar(COLOR_LOGIN_POR_DEFECTO)
    });
  }

  // /configuracion la llama justo después de guardar un color nuevo, para
  // que TODA la app (incluida la sesión del propio admin) se actualice al
  // instante sin necesidad de recargar la página -- mismo criterio que
  // ConfiguracionService.establecerTemaActual() para el tema claro/oscuro.
  aplicar(color: string): void {
    const paleta = generarPaletaLogin(color);
    const raiz = document.documentElement.style;
    raiz.setProperty('--ax-brand-primary', paleta.primario);
    raiz.setProperty('--ax-brand-primary-rgb', paleta.primarioRgb);
    raiz.setProperty('--ax-brand-primary-hover', paleta.primarioHover);
    raiz.setProperty('--ax-brand-secondary', paleta.secundario);
    raiz.setProperty('--ax-brand-secondary-rgb', paleta.secundarioRgb);
    raiz.setProperty('--ax-brand-primary-claro', paleta.primarioClaro);
    raiz.setProperty('--ax-brand-secondary-claro', paleta.secundarioClaro);
    raiz.setProperty('--ax-brand-primary-claro-rgb', paleta.primarioClaroRgb);
  }
}
