import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

// Complementa el bloqueo real (que hace el backend en verifyToken): acá
// solo evitamos que alguien con debeCambiarPassword=true vea pantallas del
// aplicativo antes de resolver el cambio — si de todos modos llegara a
// hacer una petición, el backend la rechaza igual.
export const debeCambiarPasswordGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const usuario = authService.obtenerDatosUsuario();

  if (usuario?.debeCambiarPassword && state.url !== '/cambiar-password') {
    router.navigate(['/cambiar-password']);
    return false;
  }

  return true;
};
