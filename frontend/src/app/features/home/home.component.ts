import { Component, HostBinding, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common'; // <-- IMPORTANTE: Necesario para usar *ngIf
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
// Importa el servicio (Asegúrate de que la ruta sea la correcta según tu estructura)
import { AuthService, UsuarioActual } from '../../services/auth.service';
import { ConfiguracionService, Tema } from '../../services/configuracion.service';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterLink], // <-- Agregamos CommonModule aquí
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss'
})
export class HomeComponent implements OnInit {

  // Variable para guardar los datos del usuario logueado
  usuarioActual: UsuarioActual | null = null;

  // IMPORTANTE: /Home es una ruta de nivel superior, NO un hijo de
  // ShellComponent (ver app.routes.ts) -- por eso nunca queda dentro de
  // .shell.dark-theme y no puede heredar el tema del shell. Se resuelve
  // aquí mismo, igual que en ShellComponent (global + personal, cada
  // petición atrapa su propio error), y se aplica con @HostBinding
  // directo sobre <app-home> para que sus propias variables --ax-* (y las
  // de cualquier hijo) queden dentro del alcance de .dark-theme.
  tema: Tema = 'claro';

  @HostBinding('class.dark-theme')
  get temaOscuroActivo(): boolean {
    return this.tema === 'oscuro';
  }

  // Inyectamos el servicio
  constructor(
    private authService: AuthService,
    private configuracionService: ConfiguracionService
  ) {}

  ngOnInit(): void {
    // Al cargar el Home, obtenemos quién es el usuario
    this.usuarioActual = this.authService.obtenerDatosUsuario();

    forkJoin({
      global: this.configuracionService.obtenerTema().pipe(
        catchError(() => of({ tema: 'claro' as Tema }))
      ),
      personal: this.usuarioActual
        ? this.configuracionService.obtenerTemaPersonal().pipe(
            catchError(() => of({ temaPersonal: null as Tema | null }))
          )
        : of({ temaPersonal: null as Tema | null })
    }).subscribe(({ global, personal }) => {
      this.tema = personal.temaPersonal || global.tema;
      this.configuracionService.establecerTemaActual(this.tema);
    });

    // Si el usuario cambia su tema desde /perfil sin salir de Home (o si
    // llega a Home después de haber estado en el shell), se refleja al
    // instante.
    this.configuracionService.temaActual$.subscribe((tema) => {
      this.tema = tema;
    });
  }

  // Función que el HTML usará para ocultar/mostrar las tarjetas
  tieneModulo(moduloDeseado: string): boolean {
    if (!this.usuarioActual) return false;
    
    // Si es super admin, ve todo
    if (this.usuarioActual.rol === 'ADMIN_POD') return true;

    // Si es consulta/básico, revisa su lista de módulos
    return this.usuarioActual.modulos?.includes(moduloDeseado) || false;
  }

  // Tu función original intacta
  openExternalLink(url: string): void {
    window.open(url, '_blank');
  }
}