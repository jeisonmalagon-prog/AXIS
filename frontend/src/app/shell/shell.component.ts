import { Component, OnInit, OnDestroy, HostListener, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { Title, DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { filter } from 'rxjs/operators';
import { forkJoin, Observable, of, Subscription } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AuthService, UsuarioActual, SESION_MINUTOS_POR_DEFECTO } from '../services/auth.service';
import { ConfiguracionService, Tema } from '../services/configuracion.service';
import { Notificacion, NotificacionService } from '../core/services/notificacion.service';
import { JpIcoComponent } from '../shared/japon/japon-ico.component';
import { ManualesService } from '../core/services/manuales.service';
import { BitacoraAccesoService, PermisoAcceso } from '../core/services/bitacora-acceso.service';
import {
  AREAS, ACCIONES, EXTRAS, ICONOS, SECCIONES,
  NavArea, NavItem, NavSeccion, ModuloPermiso, puntuar,
} from './nav-catalogo';

interface EntradaIndice { item: NavItem; area: NavArea | null; }
interface SeccionVisible { seccion: NavSeccion; areas: NavArea[]; }
interface Miga { texto: string; ruta?: string; }
interface Resultado {
  clave: string;
  grupo: string;
  titulo: string;
  subtitulo: string;
  ruta?: string;
  comando?: 'logout' | 'guia';
  icono: string;
}
interface PasoGuia { titulo: string; texto: string; icono: string; }

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [CommonModule, RouterModule, JpIcoComponent],
  templateUrl: './shell.component.html',
  styleUrls: ['./shell.component.scss']
})
export class ShellComponent implements OnInit, OnDestroy {
  isCollapsed = false;
  movilAbierto = false;
  esMovil = false;

  // --- CIERRE DE SESIÓN POR INACTIVIDAD ---
  // Tiempos pensados para una herramienta que muestra credenciales y
  // datos sensibles en pantalla (certificados, claves, comandos de
  // despliegue): 15 min de inactividad real, con aviso 1 min antes.
  //
  // Los 15 min son el valor por defecto: un usuario al que el ADMIN_POD le
  // habilitó "ajustar la sesión" puede elegir otro en Mi perfil (hasta 12 h);
  // ver sesionMinutos en UsuarioActual. El aviso sale siempre 1 min antes.
  private inactividadLogoutMs = SESION_MINUTOS_POR_DEFECTO * 60 * 1000;
  private readonly AVISO_ANTES_MS = 60 * 1000;
  // Con tiempo personalizado el token del backend vence a los N min (+ margen)
  // de su ÚLTIMA renovación, así que mientras la persona esté activa se renueva
  // en silencio cada pocos minutos (GET /auth/me re-emite el token). Con la
  // política por defecto no se renueva: el token de 2 h sigue siendo el tope.
  private readonly RENOVAR_TOKEN_CADA_MS = 4 * 60 * 1000;
  private ultimaRenovacionToken = Date.now();
  private renovandoToken = false;
  private timerAviso: any = null;
  private timerLogout: any = null;
  mostrarAvisoInactividad = false;

  // Throttle del detector de actividad: mousemove/scroll pueden disparar
  // decenas de eventos por segundo; agrupar a lo sumo un reinicio cada 5 s no
  // cambia el comportamiento percibido y evita trabajo repetido.
  private ultimoReinicioInactividad = 0;
  private readonly THROTTLE_REINICIO_MS = 5000;

  // Posición vertical (px, viewport) del flyout de submenú con el riel colapsado.
  flyoutTopPx = 0;

  usuarioActual: UsuarioActual | null = null;

  // Tema EFECTIVO a pintar: preferencia personal si existe, si no el global.
  tema: Tema = 'claro';

  // --- NAVEGACIÓN ---
  secciones: SeccionVisible[] = [];
  private indice: EntradaIndice[] = [];
  openArea: string | null = null;
  paginaActual: EntradaIndice | null = null;
  migas: Miga[] = [];
  favoritos: string[] = [];
  recientes: string[] = [];
  private iconosHtml: Record<string, SafeHtml> = {};

  // Buscador (Ctrl+K)
  paletaAbierta = false;
  consulta = '';
  resultados: Resultado[] = [];
  indiceActivo = 0;
  @ViewChild('inputPaleta') inputPaleta?: ElementRef<HTMLInputElement>;
  private elementoPrevio: HTMLElement | null = null;

  // Popovers
  ayudaAbierta = false;
  menuUsuarioAbierto = false;

  // Notificaciones (campana)
  notifAbiertas = false;
  notifNoLeidas = 0;
  notifPendientes = 0;
  notifItems: Notificacion[] = [];
  notifCargando = false;
  notifMensaje = '';
  notifRespondiendo: number | null = null;
  private timerNotif: any = null;
  private readonly alCambiarNotif = (): void => { this.cargarContadorNotif(); if (this.notifAbiertas) this.cargarItemsNotif(); };

  // Guía de bienvenida
  guiaAbierta = false;
  pasoGuia = 0;
  readonly pasosGuia: PasoGuia[] = [
    { titulo: 'Bienvenido a AXIS',
      texto: 'Aquí tienes en un solo lugar todo lo que usa el equipo. El menú de la izquierda ordena las pantallas por área de trabajo, y solo ves las que tienes habilitadas.',
      icono: ICONOS['inicio'] },
    { titulo: 'Encuentra lo que sea, escribiendo',
      texto: 'Pulsa Ctrl + K (o toca la barra de búsqueda de arriba) y escribe lo que quieres hacer, por ejemplo "certificados por vencer" o "qué pasó con un cliente". No necesitas saber en qué menú está.',
      icono: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' },
    { titulo: 'Fija tus pantallas favoritas',
      texto: 'Toca la estrella al lado de cualquier pantalla del menú, o la de la barra superior, y quedará fija arriba del menú para llegar con un solo clic. Tus favoritos son solo tuyos.',
      icono: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' },
    { titulo: 'La ayuda siempre está a mano',
      texto: 'El botón "?" de la barra superior te explica para qué sirve la pantalla en la que estás. Si no ves un área que necesitas, pídele acceso a un administrador.',
      icono: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
  ];

  constructor(
    private authService: AuthService,
    private router: Router,
    private configuracionService: ConfiguracionService,
    private notificaciones: NotificacionService,
    private manuales: ManualesService,
    private bitacoraAcceso: BitacoraAccesoService,
    private titulo: Title,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    this.usuarioActual = this.authService.obtenerDatosUsuario();
    this.inactividadLogoutMs = this.minutosSesionDe(this.usuarioActual) * 60 * 1000;
    this.esMovil = this.calcularEsMovil();
    this.isCollapsed = this.leerLS('axis.nav.colapsado') === '1' && !this.esMovil;
    this.reconstruirNavegacion();

    // Si el usuario cambia su tiempo de sesión en Mi perfil (o un admin se lo
    // habilita/quita y llega con la próxima renovación), los temporizadores se
    // ajustan al instante, sin recargar. Esta suscripción se dispara también en
    // cada renovación del token, por eso solo se reinicia si el tiempo cambió.
    this.subUsuario = this.authService.usuarioLogueado$.subscribe((u) => {
      if (!u) return;
      this.usuarioActual = u;
      this.reconstruirNavegacion();
      const nuevoMs = this.minutosSesionDe(u) * 60 * 1000;
      if (nuevoMs !== this.inactividadLogoutMs) {
        this.inactividadLogoutMs = nuevoMs;
        this.mostrarAvisoInactividad = false;
        this.reiniciarTemporizadorInactividad();
      }
    });

    // Tema efectivo al cargar el shell: la preferencia PERSONAL del usuario
    // manda si existe; si no, se usa el tema_global. forkJoin evita una carrera
    // entre ambas peticiones y cada una atrapa su propio error para que el
    // fallo de una no tumbe la otra.
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

    // /perfil puede cambiar la preferencia personal en caliente.
    this.subTema = this.configuracionService.temaActual$.subscribe((tema) => {
      this.tema = tema;
    });

    // Refresca módulos/rol contra el backend por si un admin los cambió
    // mientras esta sesión seguía activa.
    if (this.usuarioActual) {
      this.authService.obtenerPerfil().subscribe({
        next: () => {
          this.usuarioActual = this.authService.obtenerDatosUsuario();
          this.reconstruirNavegacion();
        },
        error: () => {
          // Token inválido/expirado: los guards y el interceptor de 401 se
          // encargan de sacar al usuario si aplica.
        },
      });
    }

    // Ruta inicial + cambios de navegación
    this.evaluarRuta(this.router.url);
    this.subRouter = this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd)
    ).subscribe((event: NavigationEnd) => {
      this.evaluarRuta(event.urlAfterRedirects || event.url);
    });

    // Detector de inactividad (solo si hay sesión)
    if (this.usuarioActual) {
      this.iniciarNotificaciones();
      this.reiniciarTemporizadorInactividad();
      // Guía de bienvenida: solo la primera vez que esta persona entra.
      if (!this.leerLS(this.claveUsuario('tour.v1'))) {
        this.timerGuia = setTimeout(() => this.abrirGuia(), 900);
      }
    }
  }

  ngOnDestroy(): void {
    if (this.timerNotif) clearInterval(this.timerNotif);
    window.removeEventListener('axis:notificaciones', this.alCambiarNotif);
    this.limpiarTemporizadores();
    if (this.timerGuia) clearTimeout(this.timerGuia);
    this.subUsuario?.unsubscribe();
    this.subTema?.unsubscribe();
    this.subRouter?.unsubscribe();
  }

  private subUsuario?: Subscription;
  private subTema?: Subscription;
  private subRouter?: Subscription;
  private timerGuia: any = null;

  // ======================================================================
  // Sesión / inactividad
  // ======================================================================
  private minutosSesionDe(u: UsuarioActual | null): number {
    const m = u?.sesionMinutos;
    return typeof m === 'number' && m > 0 ? m : SESION_MINUTOS_POR_DEFECTO;
  }

  // Solo los usuarios con tiempo propio renuevan el token mientras están activos.
  private renovarTokenSiHaceFalta(): void {
    if (!this.usuarioActual?.sesionPersonalizada || this.renovandoToken) return;
    if (Date.now() - this.ultimaRenovacionToken < this.RENOVAR_TOKEN_CADA_MS) return;
    this.renovandoToken = true;
    this.ultimaRenovacionToken = Date.now();
    this.authService.obtenerPerfil().subscribe({
      next: () => { this.renovandoToken = false; },
      error: () => { this.renovandoToken = false; },
    });
  }

  // Cualquier interacción del usuario reinicia el conteo de inactividad.
  @HostListener('document:mousemove')
  @HostListener('document:keydown')
  @HostListener('document:click')
  @HostListener('document:scroll')
  @HostListener('document:touchstart')
  onActividadUsuario(): void {
    if (!this.usuarioActual) return;
    // Si el aviso ya está en pantalla, cualquier interacción cuenta como
    // "seguir conectado" y lo descarta en vez de reiniciar en silencio.
    if (this.mostrarAvisoInactividad) {
      this.continuarSesion();
      return;
    }
    const ahora = Date.now();
    if (ahora - this.ultimoReinicioInactividad < this.THROTTLE_REINICIO_MS) return;
    this.ultimoReinicioInactividad = ahora;
    this.reiniciarTemporizadorInactividad();
    this.renovarTokenSiHaceFalta();
  }

  private reiniciarTemporizadorInactividad(): void {
    this.limpiarTemporizadores();

    this.timerAviso = setTimeout(() => {
      this.mostrarAvisoInactividad = true;
    }, Math.max(0, this.inactividadLogoutMs - this.AVISO_ANTES_MS));

    this.timerLogout = setTimeout(() => {
      this.cerrarSesion(true);
    }, this.inactividadLogoutMs);
  }

  private limpiarTemporizadores(): void {
    if (this.timerAviso) clearTimeout(this.timerAviso);
    if (this.timerLogout) clearTimeout(this.timerLogout);
  }

  // El usuario confirma que sigue ahí: se descarta el aviso y se reinicia el conteo
  continuarSesion(): void {
    this.mostrarAvisoInactividad = false;
    this.reiniciarTemporizadorInactividad();
    this.renovarTokenSiHaceFalta();
  }

  cerrarSesion(porInactividad: boolean = false): void {
    this.limpiarTemporizadores();
    this.mostrarAvisoInactividad = false;
    this.cerrarTodo();
    this.authService.logout();
    this.router.navigate(['/login'], {
      queryParams: porInactividad ? { motivo: 'inactividad' } : {}
    });
  }

  // ======================================================================
  // Permisos y catálogo
  // ======================================================================
  tieneModulo(moduloDeseado: string): boolean {
    if (!this.usuarioActual) return false;
    if (this.usuarioActual.rol === 'ADMIN_POD') return true;
    return this.usuarioActual.modulos?.includes(moduloDeseado) || false;
  }

  esAdmin(): boolean {
    return this.usuarioActual?.rol === 'ADMIN_POD';
  }

  private permite(modulo: ModuloPermiso): boolean {
    if (modulo === null) return true;
    if (modulo === 'ADMIN_ONLY') return this.esAdmin();
    return this.tieneModulo(modulo);
  }

  private reconstruirNavegacion(): void {
    const visibles: NavArea[] = [];
    for (const area of AREAS) {
      if (!this.permite(area.modulo)) continue;
      const items = area.items.filter(i => this.permite(i.modulo));
      if (items.length) visibles.push({ ...area, items });
    }
    this.secciones = SECCIONES
      .map(seccion => ({ seccion, areas: visibles.filter(a => a.seccion === seccion.id) }))
      .filter(s => s.areas.length);

    this.indice = [];
    for (const area of visibles) for (const item of area.items) this.indice.push({ item, area });
    for (const extra of EXTRAS) this.indice.push({ item: extra, area: null });

    this.favoritos = this.leerLista(this.claveUsuario('fav')).filter(id => this.indice.some(e => e.item.id === id));
    this.recientes = this.leerLista(this.claveUsuario('rec')).filter(id => this.indice.some(e => e.item.id === id));
    if (this.router.url) this.evaluarRuta(this.router.url, false);
  }

  /** Icono SVG (marcado interno) listo para pintar dentro de un <svg>. */
  icono(clave: string): SafeHtml {
    if (!this.iconosHtml[clave]) {
      const marcado = ICONOS[clave] ?? clave; // permite pasar el marcado directamente
      this.iconosHtml[clave] = this.sanitizer.bypassSecurityTrustHtml(marcado);
    }
    return this.iconosHtml[clave];
  }

  esGrupo(area: NavArea): boolean {
    return area.items.length > 1;
  }

  areaActiva(area: NavArea): boolean {
    return !!this.paginaActual?.area && this.paginaActual.area.id === area.id;
  }

  private entradaPorId(id: string): EntradaIndice | undefined {
    return this.indice.find(e => e.item.id === id);
  }

  get itemsFavoritos(): EntradaIndice[] {
    return this.favoritos.map(id => this.entradaPorId(id)).filter((e): e is EntradaIndice => !!e);
  }

  // ======================================================================
  // Ruta actual → migas, título, área abierta, recientes
  // ======================================================================
  private evaluarRuta(url: string, registrar = true): void {
    const ruta = '/' + url.split('?')[0].split('#')[0].replace(/^\/+/, '');
    let mejor: EntradaIndice | null = null;
    for (const e of this.indice) {
      const r = e.item.ruta;
      if (ruta === r || ruta.startsWith(r + '/')) {
        if (!mejor || r.length > mejor.item.ruta.length) mejor = e;
      }
    }
    this.paginaActual = mejor;

    const migas: Miga[] = [];
    if (mejor && mejor.item.id !== 'inicio') {
      migas.push({ texto: 'Inicio', ruta: '/inicio' });
      if (mejor.area && mejor.area.items.length > 1) {
        migas.push({ texto: mejor.area.titulo, ruta: mejor.area.items[0].ruta });
      }
      migas.push({ texto: mejor.item.titulo });
    } else if (mejor) {
      migas.push({ texto: 'Inicio' });
    }
    this.migas = migas;

    if (mejor) {
      this.titulo.setTitle(`${mejor.item.titulo} · AXIS`);
      if (mejor.area && this.esGrupo(mejor.area)) this.openArea = mejor.area.id;
      if (registrar && mejor.item.id !== 'inicio') this.registrarReciente(mejor.item.id);
    } else {
      this.titulo.setTitle('AXIS');
    }

    if (registrar) {
      this.movilAbierto = false;
      this.ayudaAbierta = false;
      this.menuUsuarioAbierto = false;
    }
  }

  private registrarReciente(id: string): void {
    this.recientes = [id, ...this.recientes.filter(r => r !== id)].slice(0, 6);
    this.guardarLista(this.claveUsuario('rec'), this.recientes);
  }

  // ======================================================================
  // Menú lateral
  // ======================================================================
  toggleSidebar(): void {
    if (this.esMovil) {
      this.movilAbierto = !this.movilAbierto;
      return;
    }
    this.isCollapsed = !this.isCollapsed;
    this.guardarLS('axis.nav.colapsado', this.isCollapsed ? '1' : '0');
  }

  cerrarMovil(): void {
    this.movilAbierto = false;
  }

  toggleArea(id: string): void {
    this.openArea = this.openArea === id ? null : id;
  }

  // Fija el "top" del flyout al mismo nivel que el grupo bajo el mouse, justo
  // antes de que el CSS (:hover) lo muestre -- solo importa con el riel colapsado.
  fijarPosicionFlyout(evento: MouseEvent | FocusEvent): void {
    if (!this.isCollapsed || this.esMovil) return;
    const el = evento.currentTarget as HTMLElement;
    this.flyoutTopPx = el.getBoundingClientRect().top;
  }

  @HostListener('window:resize')
  onResize(): void {
    const movil = this.calcularEsMovil();
    if (movil !== this.esMovil) {
      this.esMovil = movil;
      this.movilAbierto = false;
      this.isCollapsed = !movil && this.leerLS('axis.nav.colapsado') === '1';
    }
  }

  private calcularEsMovil(): boolean {
    return typeof window !== 'undefined' && window.innerWidth <= 768;
  }

  // ======================================================================
  // Favoritos
  // ======================================================================
  esFavorito(id: string): boolean {
    return this.favoritos.includes(id);
  }

  alternarFavorito(id: string, evento?: Event): void {
    evento?.preventDefault();
    evento?.stopPropagation();
    this.favoritos = this.esFavorito(id) ? this.favoritos.filter(f => f !== id) : [...this.favoritos, id];
    this.guardarLista(this.claveUsuario('fav'), this.favoritos);
  }

  // ======================================================================
  // Buscador (Ctrl+K)
  // ======================================================================
  @HostListener('document:keydown', ['$event'])
  onTeclaGlobal(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.paletaAbierta ? this.cerrarPaleta() : this.abrirPaleta();
      return;
    }
    if (e.key === 'Escape') {
      if (this.paletaAbierta) this.cerrarPaleta();
      else if (this.guiaAbierta) this.cerrarGuia();
      else if (this.ayudaAbierta || this.menuUsuarioAbierto || this.notifAbiertas) { this.ayudaAbierta = false; this.menuUsuarioAbierto = false; this.notifAbiertas = false; }
      else if (this.movilAbierto) this.movilAbierto = false;
    }
  }

  @HostListener('document:click', ['$event'])
  onClicGlobal(e: MouseEvent): void {
    const t = e.target as HTMLElement | null;
    if (!t?.closest) return;
    if (!t.closest('.pop-host')) {
      this.ayudaAbierta = false;
      this.menuUsuarioAbierto = false;
      this.notifAbiertas = false;
    }
  }

  abrirPaleta(): void {
    if (!this.usuarioActual) return;
    this.elementoPrevio = document.activeElement as HTMLElement | null;
    this.ayudaAbierta = false;
    this.menuUsuarioAbierto = false;
    this.movilAbierto = false;
    this.consulta = '';
    this.recalcularResultados();
    this.paletaAbierta = true;
    setTimeout(() => this.inputPaleta?.nativeElement.focus(), 30);
  }

  cerrarPaleta(): void {
    this.paletaAbierta = false;
    setTimeout(() => this.elementoPrevio?.focus?.(), 0);
  }

  alEscribir(valor: string): void {
    this.consulta = valor;
    this.recalcularResultados();
  }

  private recalcularResultados(): void {
    const q = this.consulta.trim();
    const out: Resultado[] = [];
    const visto = new Set<string>();
    const push = (r: Resultado) => { if (!visto.has(r.clave)) { visto.add(r.clave); out.push(r); } };

    const iconoDe = (e: EntradaIndice | undefined, def = 'inicio') => e?.area?.id ?? def;

    if (!q) {
      this.recientes.slice(0, 4).forEach(id => {
        const e = this.entradaPorId(id);
        if (e) push({ clave: 'p:' + id, grupo: 'Visitado hace poco', titulo: e.item.titulo, subtitulo: e.area && e.area.items.length > 1 ? e.area.titulo : e.item.descripcion, ruta: e.item.ruta, icono: iconoDe(e) });
      });
      this.itemsFavoritos.slice(0, 5).forEach(e =>
        push({ clave: 'p:' + e.item.id, grupo: 'Tus favoritos', titulo: e.item.titulo, subtitulo: e.item.descripcion, ruta: e.item.ruta, icono: iconoDe(e) }));
      ACCIONES.filter(a => this.permite(a.modulo)).slice(0, 7).forEach(a =>
        push({ clave: 'a:' + a.id, grupo: '¿Qué quieres hacer?', titulo: a.titulo, subtitulo: a.descripcion, ruta: a.ruta, icono: this.iconoPorRuta(a.ruta) }));
    } else {
      const acciones = ACCIONES
        .filter(a => this.permite(a.modulo))
        .map(a => ({ a, s: puntuar(q, a.titulo, a.descripcion, a.palabras, '') }))
        .filter(x => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 4);
      acciones.forEach(({ a }) =>
        push({ clave: 'a:' + a.id, grupo: 'Lo que puedes hacer', titulo: a.titulo, subtitulo: a.descripcion, ruta: a.ruta, icono: this.iconoPorRuta(a.ruta) }));

      const paginas = this.indice
        .map(e => ({ e, s: puntuar(q, e.item.titulo, e.item.descripcion, e.item.palabras, e.area?.titulo ?? '') }))
        .filter(x => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 8);
      paginas.forEach(({ e }) =>
        push({ clave: 'p:' + e.item.id, grupo: 'Pantallas', titulo: e.item.titulo, subtitulo: (e.area && e.area.items.length > 1 ? e.area.titulo + ' · ' : '') + e.item.descripcion, ruta: e.item.ruta, icono: iconoDe(e) }));
    }

    // Comandos siempre disponibles al final
    const cmds: Resultado[] = [
      { clave: 'c:guia', grupo: 'Ayuda y sesión', titulo: 'Ver la guía de bienvenida', subtitulo: 'Un recorrido corto por AXIS', comando: 'guia', icono: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
      { clave: 'c:logout', grupo: 'Ayuda y sesión', titulo: 'Cerrar sesión', subtitulo: 'Salir de AXIS en este equipo', comando: 'logout', icono: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>' },
    ];
    cmds.filter(c => !q || puntuar(q, c.titulo, c.subtitulo, c.comando === 'logout' ? ['salir', 'logout', 'desconectar'] : ['tutorial', 'tour', 'ayuda', 'como funciona'], '') > 0)
      .forEach(push);

    this.resultados = out;
    this.indiceActivo = 0;
  }

  private iconoPorRuta(ruta: string): string {
    const e = this.indice.find(x => x.item.ruta === ruta);
    return e?.area?.id ?? 'inicio';
  }

  teclaPaleta(e: KeyboardEvent): void {
    const n = this.resultados.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) this.indiceActivo = (this.indiceActivo + 1) % n; this.asegurarVisible(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) this.indiceActivo = (this.indiceActivo - 1 + n) % n; this.asegurarVisible(); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = this.resultados[this.indiceActivo]; if (r) this.elegir(r); }
  }

  private asegurarVisible(): void {
    setTimeout(() => document.querySelector('.paleta-item.activo')?.scrollIntoView({ block: 'nearest' }), 0);
  }

  elegir(r: Resultado): void {
    this.paletaAbierta = false;
    if (r.comando === 'logout') { this.cerrarSesion(); return; }
    if (r.comando === 'guia') { this.abrirGuia(); return; }
    if (r.ruta) this.router.navigateByUrl(r.ruta);
  }

  mostrarGrupo(i: number): boolean {
    return i === 0 || this.resultados[i - 1].grupo !== this.resultados[i].grupo;
  }

  get sugerenciasVacias(): boolean {
    return this.consulta.trim().length > 0 && this.resultados.filter(r => !r.comando).length === 0;
  }

  // ======================================================================
  // Barra superior: ayuda, favorito de la página, menú de usuario
  // ======================================================================
  alternarAyuda(): void {
    this.ayudaAbierta = !this.ayudaAbierta;
    this.menuUsuarioAbierto = false;
    this.notifAbiertas = false;
  }

  alternarMenuUsuario(): void {
    this.menuUsuarioAbierto = !this.menuUsuarioAbierto;
    this.ayudaAbierta = false;
    this.notifAbiertas = false;
  }

  // ======================================================================
  // Notificaciones (campana): el número se consulta cada minuto; al abrir se trae la lista
  // ======================================================================
  private iniciarNotificaciones(): void {
    this.cargarContadorNotif();
    this.timerNotif = setInterval(() => { if (!document.hidden) this.cargarContadorNotif(); }, 60 * 1000);
    window.addEventListener('axis:notificaciones', this.alCambiarNotif);
  }

  private cargarContadorNotif(): void {
    this.notificaciones.contador().subscribe({
      next: (c) => { this.notifNoLeidas = c.noLeidas; this.notifPendientes = c.pendientesDeRespuesta || 0; },
      error: () => { /* la campana no es crítica: se reintenta en un minuto */ },
    });
  }

  alternarNotificaciones(): void {
    this.notifAbiertas = !this.notifAbiertas;
    this.ayudaAbierta = false;
    this.menuUsuarioAbierto = false;
    if (this.notifAbiertas) this.cargarItemsNotif();
  }

  private cargarItemsNotif(): void {
    this.notifCargando = true;
    this.notificaciones.listar({ limite: 8 }).subscribe({
      next: (b) => {
        this.notifCargando = false;
        this.notifItems = b.items;
        this.notifNoLeidas = b.noLeidas;
        this.notifMensaje = b.disponible ? '' : (b.mensaje || '');
      },
      error: () => { this.notifCargando = false; this.notifMensaje = 'No se pudieron cargar las notificaciones.'; },
    });
  }

  abrirNotificacion(n: Notificacion): void {
    if (n.accion === 'PENDIENTE') return; // se responde con los botones
    if (!n.leida) {
      n.leida = true;
      this.notifNoLeidas = Math.max(0, this.notifNoLeidas - 1);
      this.notificaciones.leer(n.id).subscribe({ error: () => { /* no crítico */ } });
    }
    this.notifAbiertas = false;
    if (n.enlace) this.router.navigateByUrl(n.enlace);
  }

  verTodasNotificaciones(): void {
    this.notifAbiertas = false;
    this.router.navigateByUrl('/notificaciones');
  }

  responderNotificacion(n: Notificacion, aceptar: boolean, ev: Event, permiso?: PermisoAcceso): void {
    ev.stopPropagation();
    if (this.notifRespondiendo || n.referencia === null) return;
    this.notifRespondiendo = n.id;
    // Bitácora de pasos a producción: aceptar un ofrecimiento o aprobar una solicitud (con su permiso).
    const llamada: Observable<{ estado: string }> = n.tipo.startsWith('BITACORA_')
      ? this.bitacoraAcceso.responder(n.referencia, aceptar, permiso)
      : this.manuales.responderSolicitud(n.referencia, aceptar);
    llamada.subscribe({
      next: () => { this.notifRespondiendo = null; this.cargarItemsNotif(); this.cargarContadorNotif(); window.dispatchEvent(new CustomEvent(n.tipo.startsWith('BITACORA_') ? 'axis:bitacora' : 'axis:manuales')); },
      error: (err) => { this.notifRespondiendo = null; this.notifMensaje = err?.error?.error || 'No se pudo responder la solicitud.'; this.cargarItemsNotif(); },
    });
  }

  trackNotif = (_: number, n: Notificacion): number => n.id;

  get iniciales(): string {
    const n = (this.usuarioActual?.nombre || this.usuarioActual?.username || '?').trim();
    const p = n.split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() || '?';
  }

  get etiquetaRol(): string {
    switch (this.usuarioActual?.rol) {
      case 'ADMIN_POD': return 'Administrador';
      case 'ADMIN_MIN': return 'Gestor';
      case 'BASIC': return 'Consulta';
      default: return this.usuarioActual?.rol || '';
    }
  }

  // ======================================================================
  // Guía de bienvenida
  // ======================================================================
  abrirGuia(): void {
    this.pasoGuia = 0;
    this.guiaAbierta = true;
    this.ayudaAbierta = false;
    this.menuUsuarioAbierto = false;
  }

  siguienteGuia(): void {
    if (this.pasoGuia < this.pasosGuia.length - 1) this.pasoGuia++;
    else this.cerrarGuia();
  }

  anteriorGuia(): void {
    if (this.pasoGuia > 0) this.pasoGuia--;
  }

  cerrarGuia(): void {
    this.guiaAbierta = false;
    this.guardarLS(this.claveUsuario('tour.v1'), '1');
  }

  private cerrarTodo(): void {
    this.paletaAbierta = false;
    this.guiaAbierta = false;
    this.ayudaAbierta = false;
    this.menuUsuarioAbierto = false;
  }

  // ======================================================================
  // Almacenamiento local (por usuario; nunca debe romper la pantalla)
  // ======================================================================
  private claveUsuario(sufijo: string): string {
    return `axis.nav.${sufijo}.${this.usuarioActual?.username ?? 'anon'}`;
  }

  private leerLS(clave: string): string | null {
    try { return localStorage.getItem(clave); } catch { return null; }
  }

  private guardarLS(clave: string, valor: string): void {
    try { localStorage.setItem(clave, valor); } catch { /* sin almacenamiento: se ignora */ }
  }

  private leerLista(clave: string): string[] {
    try {
      const v = JSON.parse(this.leerLS(clave) || '[]');
      return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
    } catch { return []; }
  }

  private guardarLista(clave: string, lista: string[]): void {
    this.guardarLS(clave, JSON.stringify(lista));
  }
}
