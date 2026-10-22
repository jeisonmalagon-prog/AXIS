import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = (route, state) => {
  // Inyectamos el servicio de auth y el enrutador
  const authService = inject(AuthService);
  const router = inject(Router);

  // Si tiene token, lo dejamos pasar
  if (authService.estaAutenticado()) {
    return true;
  }

  // Si no tiene token, lo mandamos directo al login
  router.navigate(['/login']);
  return false;
};