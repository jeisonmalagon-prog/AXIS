import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const token = authService.getToken();

  const reqConToken = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(reqConToken).pipe(
    catchError((error: HttpErrorResponse) => {
      // 401 = token vencido o inválido. Si esto pasa mientras la persona
      // sigue trabajando (ej. el token de 2h expiró en medio de la sesión),
      // la sacamos al login en vez de dejarla ver errores silenciosos.
      if (error.status === 401 && authService.estaAutenticado()) {
        authService.logout();
        router.navigate(['/login'], { queryParams: { motivo: 'expirada' } });
      }
      return throwError(() => error);
    })
  );
};