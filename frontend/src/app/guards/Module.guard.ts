import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

// Uso en las rutas:
//   data: { modulo: 'SERVIDORES' }        -> exige que el usuario tenga ese módulo habilitado
//   data: { modulo: 'ADMIN_ONLY' }        -> exige que el rol sea exactamente ADMIN_POD
//
// ADMIN_POD siempre pasa cualquier chequeo de módulo (tiene acceso a todo, igual
// que ya asume shell.component.ts en tieneModulo()).
export const moduleGuard: CanActivateFn = (route) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const moduloRequerido = route.data?.['modulo'] as string | undefined;
  const usuario = authService.obtenerDatosUsuario();

  // Sin sesión: el authGuard ya se encarga de esto, pero por si acaso.
  if (!usuario) {
    router.navigate(['/login']);
    return false;
  }

  // Ruta sin módulo específico (ej. /asistente): solo requiere estar logueado.
  if (!moduloRequerido) return true;

  // ADMIN_POD tiene acceso a todo.
  if (usuario.rol === 'ADMIN_POD') return true;

  if (moduloRequerido === 'ADMIN_ONLY') {
    // Gestión de Usuarios: exclusivo de ADMIN_POD, ni siquiera ADMIN_MIN entra.
    alert('No tienes permiso para acceder a esta sección.');
    router.navigate(['/inicio']);
    return false;
  }

  if (!usuario.modulos?.includes(moduloRequerido)) {
    alert(`No tienes habilitado el módulo: ${moduloRequerido}`);
    router.navigate(['/inicio']);
    return false;
  }

  return true;
};