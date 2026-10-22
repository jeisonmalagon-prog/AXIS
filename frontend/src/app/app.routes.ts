import { inject } from '@angular/core';
import { Router, Routes, UrlMatchResult, UrlSegment } from '@angular/router';
import { LoginComponent } from './login/login.component';
import { authGuard } from './guards/auth.guard';
import { guestGuard } from './guards/guest.guard';
import { moduleGuard } from './guards/Module.guard';
import { debeCambiarPasswordGuard } from './guards/debe-cambiar-password.guard';

// /manuales  y  /manuales/:paginaId  (paginaId numérico) comparten la misma ruta.
export function coincideManuales(segmentos: UrlSegment[]): UrlMatchResult | null {
  if (!segmentos.length || segmentos[0].path !== 'manuales' || segmentos.length > 2) return null;
  if (segmentos.length === 1) return { consumed: segmentos };
  return /^\d+$/.test(segmentos[1].path) ? { consumed: segmentos, posParams: { paginaId: segmentos[1] } } : null;
}

export const routes: Routes = [
  // 1. REDIRECCIÓN POR DEFECTO
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full'
  },

  // 2. RUTAS PÚBLICAS
  {
    path: 'login',
    canActivate: [guestGuard],
    component: LoginComponent
  },

  // Recuperar la contraseña con un código (OTP) enviado al correo/celular de la cuenta: pública.
  {
    path: 'recuperar-password',
    canActivate: [guestGuard],
    loadComponent: () => import('./recuperar-password/recuperar-password.component').then((m) => m.RecuperarPasswordComponent),
  },

  // Pantalla obligatoria/voluntaria de cambio de contraseña — fuera del
  // shell (sin menú lateral) a propósito: si debeCambiarPassword es true el
  // backend bloquea todo lo demás, así que no tiene sentido mostrar el menú.
  {
    path: 'cambiar-password',
    canActivate: [authGuard],
    loadComponent: () => import('./cambiar-password/cambiar-password.component').then((m) => m.CambiarPasswordComponent),
  },

  // 3. RUTAS A PANTALLA COMPLETA (FUERA DEL SHELL / SIN MENÚ LATERAL)
  {
    path: 'esquema/:id',
    canActivate: [authGuard, moduleGuard, debeCambiarPasswordGuard],
    data: { modulo: 'CERTIFICADOS' },
    loadComponent: () => import('./esquema/esquema.component').then(m => m.EsquemaComponent)
  },
  // La antigua página /Home (lanzador de módulos) se reemplazó por /inicio
  // (métricas en vivo). Se conserva la ruta solo para no romper favoritos.
  { path: 'Home', redirectTo: 'inicio', pathMatch: 'full' },

  // 4. RUTAS PRIVADAS CON MENÚ LATERAL (Envueltas dentro del ShellComponent)
  {
    path: '',
    loadComponent: () => import('./shell/shell.component').then((m) => m.ShellComponent),
    canActivate: [authGuard, debeCambiarPasswordGuard],
    children: [
      {
        // Pantalla principal tras el login: métricas en vivo. Sin módulo
        // específico (cualquier usuario logueado); el backend decide qué
        // widgets le tocan según lo que el ADMIN_POD habilitó.
        path: 'inicio',
        loadComponent: () => import('./features/inicio/inicio.component').then((m) => m.InicioComponent),
      },
      {
        path: 'dashboard',
        canActivate: [moduleGuard],
        data: { modulo: 'CERTIFICADOS' },
        loadComponent: () => import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'servidores',
        canActivate: [moduleGuard],
        data: { modulo: 'SERVIDORES' },
        loadComponent: () => import('./inventario/inventario.component').then((m) => m.InventarioComponent),
      },
      {
        path: 'servidores/impacto',
        canActivate: [moduleGuard],
        data: { modulo: 'SERVIDORES' },
        loadComponent: () => import('./servidores/impacto/impacto.component').then((m) => m.ImpactoComponent),
      },
      {
        path: 'soporte-nivel-1',
        canActivate: [moduleGuard],
        data: { modulo: 'SOPORTE_N1' },
        loadComponent: () => import('./monitoreo/soporte-n1.component').then((m) => m.SoporteN1Component),
      },
      {
        path: 'soporte-nivel-1/prospeccion',
        canActivate: [moduleGuard],
        data: { modulo: 'SOPORTE_N1' },
        loadComponent: () => import('./monitoreo/prospeccion.component').then((m) => m.ProspeccionComponent),
      },
      {
        path: 'monitoreo-servidores',
        canActivate: [moduleGuard],
        data: { modulo: 'SERVIDORES' },
        loadComponent: () => import('./monitoreo/monitoreo.component').then((m) => m.MonitoreoComponent),
      },
      { path: 'reportes-servidores', redirectTo: 'informes/servidores', pathMatch: 'full' },
      {
        path: 'repositorio',
        canActivate: [moduleGuard],
        data: { modulo: 'REPOSITORIO' },
        loadComponent: () => import('./repositorio/repositorio.component').then((m) => m.RepositorioComponent),
      },
      {
        path: 'swagger',
        canActivate: [moduleGuard],
        data: { modulo: 'SWAGGER' },
        loadComponent: () => import('./features/swagger/swagger.component').then((m) => m.SwaggerComponent),
      },
      {
        path: 'catalogo-datos',
        canActivate: [moduleGuard],
        data: { modulo: 'CATALOGO_DATOS' },
        loadComponent: () => import('./features/catalogo-datos/catalogo-datos.component').then((m) => m.CatalogoDatosComponent),
      },
      {
        path: 'biometria',
        canActivate: [moduleGuard],
        data: { modulo: 'BIOMETRIA' },
        loadComponent: () => import('./features/biometria/biometria-cliente.component').then((m) => m.BiometriaClienteComponent),
      },
      {
        path: 'biometria/por-fecha',
        canActivate: [moduleGuard],
        data: { modulo: 'BIOMETRIA' },
        loadComponent: () => import('./features/biometria/biometria-general.component').then((m) => m.BiometriaGeneralComponent),
      },
      {
        path: 'biometria/consumo',
        canActivate: [moduleGuard],
        data: { modulo: 'BIOMETRIA' },
        loadComponent: () => import('./features/biometria/biometria-consumo.component').then((m) => m.BiometriaConsumoComponent),
      },
      {
        path: 'biometria/reintentos',
        canActivate: [moduleGuard],
        data: { modulo: 'BIOMETRIA' },
        loadComponent: () => import('./features/biometria/biometria.component').then((m) => m.BiometriaComponent),
      },
      {
        path: 'balanceador-f5',
        canActivate: [moduleGuard],
        data: { modulo: 'BALANCEADOR_F5' },
        loadComponent: () => import('./f5/f5.component').then((m) => m.F5Component),
      },
      { path: 'reportes-f5', redirectTo: 'informes/f5', pathMatch: 'full' },
      {
        path: 'usuarios',
        canActivate: [moduleGuard],
        data: { modulo: 'ADMIN_ONLY' },
        loadComponent: () => import('./usuarios/usuarios.component').then((m) => m.UsuariosComponent),
      },
      // Servidores y aplicaciones de negocio ya no se administran desde el módulo
      // Certificados: viven en Inventario. Estas rutas se conservan solo para que
      // los enlaces y favoritos antiguos sigan llegando al lugar correcto.
      {
        path: 'servidores-list',
        pathMatch: 'full',
        redirectTo: () => inject(Router).parseUrl('/servidores?vista=servidores'),
      },
      {
        path: 'aplicaciones',
        pathMatch: 'full',
        redirectTo: () => inject(Router).parseUrl('/servidores?vista=aplicaciones'),
      },
      {
        path: 'certificados',
        canActivate: [moduleGuard],
        data: { modulo: 'CERTIFICADOS' },
        loadComponent: () => import('./features/certificados/certificados-list.component').then((m) => m.CertificadosListComponent),
      },
      {
        // Una sola configuración para /manuales y /manuales/:paginaId: así el componente se reutiliza
        // al pasar de una página a una sección vacía (con dos rutas se destruía y volvía a la primera sección).
        matcher: coincideManuales,
        canActivate: [moduleGuard],
        data: { modulo: 'MANUALES' },
        loadComponent: () => import('./features/manuales/manuales.component').then((m) => m.ManualesComponent),
      },
      {
        path: 'historico',
        canActivate: [moduleGuard],
        data: { modulo: 'CERTIFICADOS' },
        loadComponent: () => import('./features/historico/historico-list.component').then((m) => m.HistoricoListComponent),
      },
      { path: 'reportes-certificados', redirectTo: 'informes/certificados', pathMatch: 'full' },
      { path: 'reportes-aplicaciones', redirectTo: 'informes/aplicaciones', pathMatch: 'full' },
      {
        path: 'app-movil',
        canActivate: [moduleGuard],
        data: { modulo: 'APP_MOVIL' },
        loadComponent: () => import('./app-movil/app-movil.component').then((m) => m.AppMovilComponent),
      },
      {
        path: 'app-movil-logs',
        canActivate: [moduleGuard],
        data: { modulo: 'APP_MOVIL' },
        loadComponent: () => import('./app-movil-logs/app-movil-logs.component').then((m) => m.AppMovilLogsComponent),
      },
      {
        path: 'catalogo-ace',
        canActivate: [moduleGuard],
        data: { modulo: 'SERVICIOS' },
        loadComponent: () => import('./features/catalogo-ace/catalogo-ace-list.component').then((m) => m.CatalogoAceListComponent),
      },
      {
        path: 'servicios',
        canActivate: [moduleGuard],
        data: { modulo: 'SERVICIOS' },
        loadComponent: () => import('./features/servicios/servicios-list.component').then((m) => m.ServiciosListComponent),
      },
      {
        path: 'apuntamientos',
        canActivate: [moduleGuard],
        data: { modulo: 'SERVICIOS' },
        loadComponent: () => import('./features/bitacora-apuntamientos/bitacora-apuntamientos-list.component').then((m) => m.BitacoraApuntamientosListComponent),
      },
      {
        path: 'apuntamientos/aplicacion/:aplicacionId',
        canActivate: [moduleGuard],
        data: { modulo: 'SERVICIOS' },
        loadComponent: () => import('./features/bitacora-apuntamientos/bitacora-apuntamientos-aplicacion.component').then((m) => m.BitacoraApuntamientosAplicacionComponent),
      },
      {
        path: 'apuntamientos-historico',
        canActivate: [moduleGuard],
        data: { modulo: 'SERVICIOS' },
        loadComponent: () => import('./features/apuntamientos-historico/apuntamientos-historico-list.component').then((m) => m.ApuntamientosHistoricoListComponent),
      },
      {
        path: 'validacion-nodos',
        canActivate: [moduleGuard],
        data: { modulo: 'SERVICIOS' },
        loadComponent: () => import('./features/validacion-nodos/validacion-nodos.component').then((m) => m.ValidacionNodosComponent),
      },
      { path: 'reportes-apuntamientos', redirectTo: 'informes/apuntamientos', pathMatch: 'full' },
      {
        path: 'n8n',
        canActivate: [moduleGuard],
        data: { modulo: 'ORQUESTADOR_N8N' },
        loadComponent: () => import('./n8n/n8n.component').then((m) => m.N8nComponent),
      },
      {
        path: 'asistente',
        // Sin módulo específico: cualquier usuario logueado puede usarlo
        // (coincide con que shell.component.html lo muestra sin *ngIf de módulo).
        loadComponent: () => import('./features/asistente/asistente.component').then((m) => m.AsistenteComponent),
      },
      { path: 'reportes-general', redirectTo: 'informes/general', pathMatch: 'full' },
      {
        // Hub de informes y visor. Requieren el módulo INFORMES (lo habilita el ADMIN_POD); además el
        // backend decide qué informes ve cada usuario según sus módulos (GET /api/informes/catalogo).
        path: 'informes',
        canActivate: [moduleGuard],
        data: { modulo: 'INFORMES' },
        loadComponent: () => import('./informes/informes-hub.component').then((m) => m.InformesHubComponent),
      },
      {
        path: 'informes/:clave',
        canActivate: [moduleGuard],
        data: { modulo: 'INFORMES' },
        loadComponent: () => import('./informes/informe-viewer.component').then((m) => m.InformeViewerComponent),
      },
      {
        path: 'perfil',
        // Sin módulo específico: cualquier usuario logueado tiene su propio perfil.
        loadComponent: () => import('./features/perfil/perfil.component').then((m) => m.PerfilComponent),
      },
      {
        path: 'usuarios-auditoria',
        canActivate: [moduleGuard],
        data: { modulo: 'ADMIN_ONLY' },
        loadComponent: () => import('./features/auditoria/usuarios-auditoria.component').then((m) => m.UsuariosAuditoriaComponent),
      },
      {
        path: 'configuracion',
        // Exclusivo ADMIN_POD: tema claro/oscuro global y color de marca del login.
        canActivate: [moduleGuard],
        data: { modulo: 'ADMIN_ONLY' },
        loadComponent: () => import('./features/configuracion/configuracion.component').then((m) => m.ConfiguracionComponent),
      },
      {
        // Bandeja de notificaciones: cualquier persona con sesión ve solo las suyas (sin módulo propio).
        path: 'notificaciones',
        loadComponent: () => import('./features/notificaciones/notificaciones.component').then((m) => m.NotificacionesComponent),
      },
      {
        path: 'tareas',
        canActivate: [moduleGuard],
        data: { modulo: 'TAREAS' },
        loadComponent: () => import('./features/tareas/tareas-list.component').then((m) => m.TareasListComponent),
      },
      {
        path: 'calendario',
        canActivate: [moduleGuard],
        data: { modulo: 'CALENDARIO' },
        loadComponent: () => import('./features/calendario/calendario.component').then((m) => m.CalendarioComponent),
      },
      {
        path: 'pasos-produccion',
        canActivate: [moduleGuard],
        data: { modulo: 'PASOS_PRODUCCION' },
        loadComponent: () => import('./features/pasos-produccion/pasos-produccion-list.component').then((m) => m.PasosProduccionListComponent),
      }
    ],
  },

  // 5. RUTA COMODÍN (Catch-all)
  { 
    path: '**', 
    redirectTo: 'login' 
  }
];