import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

// Protege /login en el sentido contrario a authGuard: si YA hay una sesión
// activa, no tiene sentido (ni es seguro) dejar ver el formulario de login
// otra vez -- por ejemplo al volver atrás con el botón del navegador
// después de haber iniciado sesión. En ese caso se manda directo a donde
// corresponda según el estado de la cuenta, en vez de mostrar el login.
export const guestGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.estaAutenticado()) {
    return true;
  }

  const usuario = authService.obtenerDatosUsuario();
  router.navigate([usuario?.debeCambiarPassword ? '/cambiar-password' : '/inicio']);
  return false;
};
