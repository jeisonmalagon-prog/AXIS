import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject, Subscription, concatMap, catchError, of } from 'rxjs';
import { CalendarioService, EventoCalendario, CalendarioEquipo, CalendarioPersonal } from '../../core/services/calendario.service';
import { UsuarioBasicoService, UsuarioBasico } from '../../core/services/usuario-basico.service';
import { PasoProduccionService } from '../../core/services/paso-produccion.service';
import { SelectorBuscableComponent, OpcionSelector } from '../../shared/selector-buscable/selector-buscable.component';
import { AuthService } from '../../services/auth.service';

// Paleta fija para los chips de "asignado a" -- el color de cada persona se
// calcula por su id (módulo el tamaño de la paleta), no por su posición en
// la lista de usuarios, para que no cambie si se agrega o quita gente.
const PALETA_COLORES = ['#2563eb', '#f59e0b', '#673ab7', '#10b981', '#db2777', '#0891b2', '#ef4444', '#475569'];
const COLOR_SIN_ASIGNAR = '#94a3b8';

// Un evento de la grilla semanal ya con su columna calculada -- ver
// calcularColumnas() -- para cuando se solapa en el tiempo con otro(s).
interface EventoPosicionado extends EventoCalendario {
  col: number;
  totalCols: number;
}

@Component({
  selector: 'app-calendario',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectorBuscableComponent],
  templateUrl: './calendario.component.html',
  styleUrl: './calendario.component.scss',
})
export class CalendarioComponent implements OnInit, OnDestroy {
  // Altura en píxeles de una hora en la grilla semanal -- se usa tanto para
  // calcular la posición/alto de cada evento (acá) como en el SCSS
  // (.cal-hora, .cal-hora-linea): si se cambia acá, hay que cambiarlo allá.
  private readonly ALTURA_HORA = 34; // compacto: antes 48 -- se veía muy extenso para recorrer el día completo

  @ViewChild('cuerpoGrid') cuerpoGrid?: ElementRef<HTMLDivElement>;

  configurado: boolean | null = null; // null mientras no se sabe todavía
  // Se guarda aparte del "no configurado" de siempre: así el aviso amarillo
  // de instrucciones (variables de entorno) solo aparece cuando el backend
  // de verdad respondió configurado=false, y no cuando /estado falló por
  // otra razón (módulo no habilitado, 500, red) -- antes ambos casos se
  // mostraban igual y ocultaban el error real (ej. "No tienes habilitado el
  // módulo: CALENDARIO").
  errorEstado: string | null = null;
  cargando = false;
  error: string | null = null;

  eventos: EventoCalendario[] = [];
  usuarios: UsuarioBasico[] = [];

  // Correos reales del equipo mezclados en la grilla (de solo lectura) --
  // ver CalendarioEquipo. "erroresCalendarios" son avisos de los que no se
  // pudieron leer esta vez (ej. todavía no compartieron su calendario).
  calendariosEquipo: CalendarioEquipo[] = [];
  erroresCalendarios: string[] = [];

  // Calendarios que ESTE usuario agregó solo para sí, y si la personalización
  // está disponible (si faltan las tablas en la BD, el calendario sigue como
  // siempre y esto se desactiva).
  calendariosPersonales: CalendarioPersonal[] = [];
  personalizacionDisponible = true;
  mensajePersonalizacion: string | null = null;

  // ---------- "Mis calendarios" (modal aparte, para cualquier usuario) ----------
  mostrarMisCalendarios = false;
  miCorreo = '';
  miEtiqueta = '';
  guardandoMiCalendario = false;

  // ---------- Gestionar la lista de correos (modal aparte) ----------
  mostrarGestionCorreos = false;
  nuevoCorreo = '';
  nuevaEtiqueta = '';
  guardandoCorreo = false;

  // ---------- Vista (semana con horas, o mes completo) ----------
  vista: 'semana' | 'mes' = 'semana';
  fechaReferencia = new Date();
  dias: Date[] = []; // semana visible (7 días, domingo a sábado)
  mesDias: Date[] = []; // grilla del mes visible (múltiplos de 7 días)
  horas = Array.from({ length: 24 }, (_, i) => i);

  // Quiénes/qué calendario está oculto del calendario ahora mismo -- vacío
  // significa "se ve todo". Un evento "axis" se sigue mostrando mientras al
  // menos una de las personas asignadas no esté oculta; un evento "equipo"
  // se oculta si su calendario de origen está oculto. Las claves llevan un
  // prefijo ('u:' para usuario interno, 'c:' para CalendarioEquipo, 'p:' para
  // un calendario personal, 'axis' para todo el calendario AXIS) porque son
  // secuencias de ids distintas que podrían coincidir por casualidad. Se
  // guarda por usuario en el backend: cada quien ve lo que eligió.
  filtroOcultos = new Set<string>();
  private cambiosPreferencias$ = new Subject<{ ocultos: string[]; recargar: boolean }>();
  private suscripcionPreferencias?: Subscription;

  puedeEditar = false;

  mostrarForm = false;
  guardando = false;
  form = this.formVacio();
  // Cuando no es null, el modal de "Agendar Sesión" está editando este
  // evento en vez de crear uno nuevo -- así se puede asignar equipo (y
  // corregir título/fecha) tanto a sesiones creadas desde la app como a las
  // que alguien ya había agendado directamente en Google Calendar.
  eventoEditando: EventoCalendario | null = null;

  // ---------- Detalle de un evento (al hacer clic en la grilla) ----------
  mostrarDetalle = false;
  eventoDetalle: EventoCalendario | null = null;

  // ---------- Arrastrar y soltar para reagendar ----------
  eventoArrastrando: EventoCalendario | null = null;

  // ---------- Vincular a la Bitácora de Pasos a Producción ----------
  mostrarVincular = false;
  eventoVinculando: EventoCalendario | null = null;
  pasosDisponibles: OpcionSelector[] = [];
  pasoElegidoId: number | null = null;
  guardandoVinculo = false;

  constructor(
    private calendarioService: CalendarioService,
    private usuarioBasicoService: UsuarioBasicoService,
    private pasoProduccionService: PasoProduccionService,
    private authService: AuthService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.recalcularRango();

    this.puedeEditar = this.authService.puedeEditar('CALENDARIO');
    this.usuarioBasicoService.listarBasico().subscribe((u) => (this.usuarios = u));

    // Guarda las preferencias en orden (una petición a la vez) y, si el cambio
    // afecta qué calendarios se consultan, vuelve a cargar los eventos.
    this.suscripcionPreferencias = this.cambiosPreferencias$
      .pipe(
        concatMap((c) =>
          this.calendarioService.guardarPreferencias(c.ocultos).pipe(
            catchError((err) => {
              this.error = err?.error?.error || 'No se pudo guardar tu selección de calendarios.';
              return of(null);
            }),
            concatMap(() => of(c)),
          ),
        ),
      )
      .subscribe((c) => { if (c.recargar) this.cargar(); });

    this.calendarioService.obtenerEstado().subscribe({
      next: (r) => {
        this.configurado = r.configurado;
        this.errorEstado = null;
        if (r.configurado) {
          this.cargar();
          this.cargarMisCalendarios(true);
        }
      },
      error: (err) => {
        this.configurado = false;
        this.errorEstado = err?.error?.error || 'No se pudo verificar el estado del calendario. Intenta de nuevo.';
      },
    });
  }

  // Desplaza la grilla semanal hasta la hora donde empieza lo agendado esa
  // semana (con un pequeño margen arriba), en vez de abrir siempre en la
  // medianoche con un bloque enorme de horas vacías antes de la primera
  // reunión. Antes esto se intentaba UNA sola vez en ngAfterViewInit con una
  // hora fija (7 a.m.) -- pero <div #cuerpoGrid> vive dentro de
  // *ngIf="configurado", y "configurado" solo se confirma después de que
  // responde /estado (asíncrono). Para cuando esa respuesta llegaba,
  // ngAfterViewInit ya había corrido y encontrado cuerpoGrid inexistente
  // (el *ngIf aún no pintaba nada), así que el ajuste nunca se aplicaba y la
  // vista se quedaba en 0:00. Ahora se llama después de cada carga de
  // eventos (carga inicial, cambio de semana, "Hoy"), que es cuando de
  // verdad hay datos para decidir dónde centrar la vista.
  private centrarVistaEnEventos(): void {
    if (this.vista !== 'semana') return;

    const HORA_POR_DEFECTO = 7; // sin nada agendado esa semana: abre a media mañana, no en 0:00
    const MARGEN_HORAS = 1; // un poco de contexto antes de la primera reunión, no pegado al borde

    const conHora = this.eventos.filter((e) => !e.todoElDia && this.eventoVisible(e));
    let horaObjetivo = HORA_POR_DEFECTO;
    if (conHora.length) {
      const horaMasTemprana = Math.min(
        ...conHora.map((e) => {
          const inicio = new Date(e.inicio);
          return inicio.getHours() + inicio.getMinutes() / 60;
        }),
      );
      horaObjetivo = Math.max(0, horaMasTemprana - MARGEN_HORAS);
    }

    // Espera al siguiente ciclo para que Angular ya haya pintado la grilla
    // con los eventos recién cargados (o recién mostrada por el *ngIf).
    setTimeout(() => {
      if (this.cuerpoGrid) this.cuerpoGrid.nativeElement.scrollTop = horaObjetivo * this.ALTURA_HORA;
    });
  }

  formVacio() {
    const ahora = new Date();
    const enUnaHora = new Date(ahora.getTime() + 60 * 60 * 1000);
    return {
      titulo: '',
      descripcion: '',
      inicio: this.aInputDatetime(ahora),
      fin: this.aInputDatetime(enUnaHora),
      asignados: [] as number[],
    };
  }

  private aInputDatetime(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private aFechaSimple(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ---------- Navegación semana / mes ----------
  private calcularSemana(): void {
    const inicioSemana = new Date(this.fechaReferencia);
    inicioSemana.setHours(0, 0, 0, 0);
    inicioSemana.setDate(inicioSemana.getDate() - inicioSemana.getDay()); // retrocede al domingo
    this.dias = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(inicioSemana);
      d.setDate(inicioSemana.getDate() + i);
      return d;
    });
  }

  private calcularMes(): void {
    const primerDiaMes = new Date(this.fechaReferencia.getFullYear(), this.fechaReferencia.getMonth(), 1);
    const inicio = new Date(primerDiaMes);
    inicio.setDate(inicio.getDate() - inicio.getDay());

    const ultimoDiaMes = new Date(this.fechaReferencia.getFullYear(), this.fechaReferencia.getMonth() + 1, 0);
    const fin = new Date(ultimoDiaMes);
    fin.setDate(fin.getDate() + (6 - fin.getDay()));

    const dias: Date[] = [];
    const cursor = new Date(inicio);
    while (cursor <= fin) {
      dias.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    this.mesDias = dias;
  }

  get semanasMes(): Date[][] {
    const semanas: Date[][] = [];
    for (let i = 0; i < this.mesDias.length; i += 7) semanas.push(this.mesDias.slice(i, i + 7));
    return semanas;
  }

  private recalcularRango(): void {
    if (this.vista === 'semana') this.calcularSemana();
    else this.calcularMes();
  }

  cambiarVista(v: 'semana' | 'mes'): void {
    if (this.vista === v) return;
    this.vista = v;
    this.recalcularRango();
    this.cargar();
  }

  anterior(): void {
    this.fechaReferencia = new Date(this.fechaReferencia);
    if (this.vista === 'semana') this.fechaReferencia.setDate(this.fechaReferencia.getDate() - 7);
    else this.fechaReferencia.setMonth(this.fechaReferencia.getMonth() - 1);
    this.recalcularRango();
    this.cargar();
  }

  siguiente(): void {
    this.fechaReferencia = new Date(this.fechaReferencia);
    if (this.vista === 'semana') this.fechaReferencia.setDate(this.fechaReferencia.getDate() + 7);
    else this.fechaReferencia.setMonth(this.fechaReferencia.getMonth() + 1);
    this.recalcularRango();
    this.cargar();
  }

  irAHoy(): void {
    this.fechaReferencia = new Date();
    this.recalcularRango();
    this.cargar();
  }

  esHoy(d: Date): boolean {
    const hoy = new Date();
    return d.getFullYear() === hoy.getFullYear() && d.getMonth() === hoy.getMonth() && d.getDate() === hoy.getDate();
  }

  esOtroMes(d: Date): boolean {
    return d.getMonth() !== this.fechaReferencia.getMonth();
  }

  cargar(): void {
    const inicioRango = this.vista === 'semana' ? this.dias[0] : this.mesDias[0];
    const finRango = this.vista === 'semana' ? this.dias[6] : this.mesDias[this.mesDias.length - 1];
    if (!inicioRango || !finRango) return;

    this.cargando = true;
    this.error = null;
    this.calendarioService.listarEventos(this.aFechaSimple(inicioRango), this.aFechaSimple(finRango)).subscribe({
      next: (resp) => {
        this.eventos = resp.eventos.filter((e) => e.estado !== 'cancelled');
        this.erroresCalendarios = resp.erroresCalendarios || [];
        this.cargando = false;
        this.centrarVistaEnEventos();
      },
      error: (err) => { this.error = err?.error?.error || 'No se pudieron cargar los eventos del calendario.'; this.cargando = false; },
    });
  }

  ngOnDestroy(): void {
    this.suscripcionPreferencias?.unsubscribe();
  }

  // Carga los calendarios comunes del equipo, los propios del usuario y (solo la
  // primera vez) lo que tenía oculto, para no pisar cambios hechos en pantalla.
  private cargarMisCalendarios(primeraVez = false): void {
    this.calendarioService.obtenerMisCalendarios().subscribe({
      next: (r) => {
        this.calendariosEquipo = r.equipo;
        this.calendariosPersonales = r.personales;
        this.personalizacionDisponible = r.disponible;
        this.mensajePersonalizacion = r.mensaje;
        if (primeraVez) this.filtroOcultos = new Set(r.ocultos);
      },
      error: (err) => { this.error = err?.error?.error || 'No se pudo cargar la lista de calendarios.'; },
    });
  }

  // ---------- Filtro por persona / por calendario ----------
  private claveUsuario(id: number): string { return 'u:' + id; }
  private claveCalendario(id: number): string { return 'c:' + id; }

  private clavePersonal(id: number): string { return 'p:' + id; }

  // Cambia una clave y la guarda para este usuario. Los calendarios ocultos no se
  // consultan a Google, así que al mostrar/ocultar uno (no una persona) se
  // recargan los eventos. Si la personalización no está disponible, todo se
  // queda en pantalla (el filtro sigue funcionando, solo no se recuerda).
  private toggleClave(clave: string): void {
    if (this.filtroOcultos.has(clave)) this.filtroOcultos.delete(clave);
    else this.filtroOcultos.add(clave);
    if (this.personalizacionDisponible) {
      this.cambiosPreferencias$.next({ ocultos: [...this.filtroOcultos], recargar: !clave.startsWith('u:') });
    }
  }

  toggleFiltroPersona(usuarioId: number): void {
    this.toggleClave(this.claveUsuario(usuarioId));
  }

  toggleFiltroCalendario(calendarioEquipoId: number): void {
    this.toggleClave(this.claveCalendario(calendarioEquipoId));
  }

  toggleFiltroPersonal(calendarioPersonalId: number): void {
    this.toggleClave(this.clavePersonal(calendarioPersonalId));
  }

  toggleFiltroAxis(): void {
    this.toggleClave('axis');
  }

  filtroPersonalOculto(calendarioPersonalId: number): boolean {
    return this.filtroOcultos.has(this.clavePersonal(calendarioPersonalId));
  }

  filtroAxisOculto(): boolean {
    return this.filtroOcultos.has('axis');
  }

  filtroPersonaOculto(usuarioId: number): boolean {
    return this.filtroOcultos.has(this.claveUsuario(usuarioId));
  }

  filtroCalendarioOculto(calendarioEquipoId: number): boolean {
    return this.filtroOcultos.has(this.claveCalendario(calendarioEquipoId));
  }

  eventoVisible(e: EventoCalendario): boolean {
    if (e.origen === 'equipo') {
      return e.calendarioEquipoId === undefined || !this.filtroCalendarioOculto(e.calendarioEquipoId);
    }
    if (e.origen === 'personal') {
      return e.calendarioPersonalId === undefined || !this.filtroPersonalOculto(e.calendarioPersonalId);
    }
    if (this.filtroAxisOculto()) return false;
    if (!e.asignados?.length) return true;
    return e.asignados.some((id) => !this.filtroPersonaOculto(id));
  }

  // ---------- Eventos por día / posición en la grilla ----------
  private eventosDelDia(d: Date): EventoCalendario[] {
    return this.eventos.filter((e) => {
      const fechaEvento = new Date(e.inicio);
      return fechaEvento.getFullYear() === d.getFullYear() && fechaEvento.getMonth() === d.getMonth() && fechaEvento.getDate() === d.getDate();
    });
  }

  eventosTodoElDiaDelDia(d: Date): EventoCalendario[] {
    return this.eventosDelDia(d).filter((e) => e.todoElDia && this.eventoVisible(e));
  }

  eventosConHoraDelDia(d: Date): EventoCalendario[] {
    return this.eventosDelDia(d).filter((e) => !e.todoElDia && this.eventoVisible(e));
  }

  // Igual que eventosConHoraDelDia(), pero además calcula en qué "columna"
  // va cada evento cuando dos o más se superponen en el tiempo -- si no, se
  // dibujaban todos con el mismo left/right y quedaban encimados e
  // ilegibles. Se llama una vez por día (no por evento) para que todos los
  // eventos de ese día se repartan las columnas entre sí de forma consistente.
  eventosConHoraDelDiaPosicionados(d: Date): EventoPosicionado[] {
    const eventos = this.eventosConHoraDelDia(d);
    const layout = this.calcularColumnas(eventos);
    return eventos.map((e) => ({ ...e, ...(layout.get(e.id) || { col: 0, totalCols: 1 }) }));
  }

  // Algoritmo estándar de "día con eventos solapados" (el mismo criterio que
  // usa Google Calendar): agrupa los eventos en "racimos" que se traslapan
  // entre sí en el tiempo, y dentro de cada racimo reparte columnas de
  // izquierda a derecha -- un evento entra en la primera columna donde el
  // anterior ya terminó; si no cabe en ninguna, abre una columna nueva. El
  // ancho de cada evento se calcula después como 1/totalCols de su racimo
  // (no de todo el día), así un evento que no se cruza con nadie sigue
  // ocupando el ancho completo.
  private calcularColumnas(eventos: EventoCalendario[]): Map<string, { col: number; totalCols: number }> {
    const resultado = new Map<string, { col: number; totalCols: number }>();

    const ordenados = [...eventos].sort((a, b) => {
      const inicioA = new Date(a.inicio).getTime();
      const inicioB = new Date(b.inicio).getTime();
      if (inicioA !== inicioB) return inicioA - inicioB;
      // A igual inicio, el más largo primero -- así queda en la primera
      // columna y los cortos se acomodan alrededor de él.
      const duracionA = new Date(a.fin).getTime() - inicioA;
      const duracionB = new Date(b.fin).getTime() - inicioB;
      return duracionB - duracionA;
    });

    let racimo: EventoCalendario[] = [];
    let finRacimo = 0;

    const cerrarRacimo = () => {
      if (!racimo.length) return;
      const columnas: EventoCalendario[][] = [];
      racimo.forEach((ev) => {
        const inicioEv = new Date(ev.inicio).getTime();
        const columna = columnas.find((c) => new Date(c[c.length - 1].fin).getTime() <= inicioEv);
        if (columna) columna.push(ev);
        else columnas.push([ev]);
      });
      const totalCols = columnas.length;
      columnas.forEach((columna, col) => {
        columna.forEach((ev) => resultado.set(ev.id, { col, totalCols }));
      });
      racimo = [];
      finRacimo = 0;
    };

    ordenados.forEach((ev) => {
      const inicioEv = new Date(ev.inicio).getTime();
      const finEv = new Date(ev.fin).getTime();
      if (racimo.length && inicioEv >= finRacimo) cerrarRacimo();
      racimo.push(ev);
      finRacimo = Math.max(finRacimo, finEv);
    });
    cerrarRacimo();

    return resultado;
  }

  // Posición horizontal de un evento ya posicionado -- un pequeño margen fijo
  // (vía calc()) separa columnas vecinas sin depender de que el porcentaje
  // caiga en un número redondo.
  posicionLeft(e: EventoPosicionado): string {
    const pct = (e.col / e.totalCols) * 100;
    return `calc(${pct}% + 2px)`;
  }

  anchoEvento(e: EventoPosicionado): string {
    const pct = 100 / e.totalCols;
    return `calc(${pct}% - 4px)`;
  }

  eventosDelDiaMes(d: Date): EventoCalendario[] {
    return this.eventosDelDia(d)
      .filter((e) => this.eventoVisible(e))
      .sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));
  }

  hayEventosTodoElDia(): boolean {
    return this.eventos.some((e) => e.todoElDia && this.eventoVisible(e));
  }

  posicionTop(e: EventoCalendario): number {
    const inicio = new Date(e.inicio);
    return (inicio.getHours() + inicio.getMinutes() / 60) * this.ALTURA_HORA;
  }

  alturaEvento(e: EventoCalendario): number {
    const inicio = new Date(e.inicio);
    const fin = new Date(e.fin);
    const minutos = Math.max(20, (fin.getTime() - inicio.getTime()) / 60000); // alto mínimo para que siga siendo clicable
    return (minutos / 60) * this.ALTURA_HORA;
  }

  lineaAhora(): number {
    const ahora = new Date();
    return (ahora.getHours() + ahora.getMinutes() / 60) * this.ALTURA_HORA;
  }

  // ---------- Color / nombre por persona asignada ----------
  colorParaUsuario(usuarioId: number): string {
    return PALETA_COLORES[usuarioId % PALETA_COLORES.length];
  }

  // Un evento "equipo" se colorea por su calendario de origen (cada correo
  // agregado en CalendariosEquipo tiene su propio color, igual de
  // determinístico que colorParaUsuario); uno "axis" sigue coloreándose por
  // el primer asignado interno, como antes.
  colorParaCalendario(calendarioEquipoId: number): string {
    return PALETA_COLORES[calendarioEquipoId % PALETA_COLORES.length];
  }

  // Los calendarios propios arrancan unas posiciones más adelante en la paleta
  // para no parecerse tanto a los del equipo.
  colorParaPersonal(calendarioPersonalId: number): string {
    return PALETA_COLORES[(calendarioPersonalId + 3) % PALETA_COLORES.length];
  }

  colorAxis(): string {
    return COLOR_SIN_ASIGNAR;
  }

  colorPrimeraPersona(e: EventoCalendario): string {
    if (e.origen === 'equipo') {
      return e.calendarioEquipoId !== undefined ? this.colorParaCalendario(e.calendarioEquipoId) : COLOR_SIN_ASIGNAR;
    }
    if (e.origen === 'personal') {
      return e.calendarioPersonalId !== undefined ? this.colorParaPersonal(e.calendarioPersonalId) : COLOR_SIN_ASIGNAR;
    }
    return e.asignados?.length ? this.colorParaUsuario(e.asignados[0]) : COLOR_SIN_ASIGNAR;
  }

  nombreUsuario(usuarioId: number): string {
    const u = this.usuarios.find((x) => x.id === usuarioId);
    return u ? u.nombre_completo : `Usuario #${usuarioId}`;
  }

  // Un evento "equipo" es siempre de solo lectura -- viene del calendario
  // real de alguien, no de la app, así que ni un ADMIN puede editarlo/
  // moverlo/borrarlo desde acá aunque tenga permiso de edición en general.
  puedeEditarEvento(e: EventoCalendario): boolean {
    return this.puedeEditar && e.origen === 'axis';
  }

  // ---------- Arrastrar y soltar para reagendar ----------
  iniciarArrastre(e: EventoCalendario, ev: DragEvent): void {
    if (!this.puedeEditarEvento(e)) { ev.preventDefault(); return; }
    this.eventoArrastrando = e;
    ev.dataTransfer?.setData('text/plain', e.id);
  }

  permitirSoltar(ev: DragEvent): void {
    ev.preventDefault();
  }

  // Soltar en la grilla semanal (columna de un día, en una hora concreta) --
  // la posición Y del cursor dentro de la columna define la nueva hora,
  // redondeada a los 15 minutos más cercanos.
  soltarEnColumnaHora(d: Date, ev: DragEvent): void {
    ev.preventDefault();
    const evento = this.eventoArrastrando;
    this.eventoArrastrando = null;
    if (!evento) return;

    const columna = ev.currentTarget as HTMLElement;
    const rect = columna.getBoundingClientRect();
    const offsetY = ev.clientY - rect.top;
    const minutosCrudos = (offsetY / this.ALTURA_HORA) * 60;
    const minutos = Math.max(0, Math.min(23 * 60 + 45, Math.round(minutosCrudos / 15) * 15));

    const nuevoInicio = new Date(d);
    nuevoInicio.setHours(Math.floor(minutos / 60), minutos % 60, 0, 0);
    const duracionMs = new Date(evento.fin).getTime() - new Date(evento.inicio).getTime();
    const nuevoFin = new Date(nuevoInicio.getTime() + duracionMs);

    this.reagendar(evento.id, nuevoInicio.toISOString(), nuevoFin.toISOString(), false);
  }

  // Soltar en una celda del mes -- solo cambia el día, conserva la hora
  // original (o, si es un evento de todo el día, solo mueve la fecha).
  soltarEnDiaMes(d: Date, ev: DragEvent): void {
    ev.preventDefault();
    const evento = this.eventoArrastrando;
    this.eventoArrastrando = null;
    if (!evento) return;

    if (evento.todoElDia) {
      const finExclusivo = new Date(d);
      finExclusivo.setDate(finExclusivo.getDate() + 1);
      this.reagendar(evento.id, this.aFechaSimple(d), this.aFechaSimple(finExclusivo), true);
      return;
    }

    const original = new Date(evento.inicio);
    const nuevoInicio = new Date(d);
    nuevoInicio.setHours(original.getHours(), original.getMinutes(), 0, 0);
    const duracionMs = new Date(evento.fin).getTime() - new Date(evento.inicio).getTime();
    const nuevoFin = new Date(nuevoInicio.getTime() + duracionMs);

    this.reagendar(evento.id, nuevoInicio.toISOString(), nuevoFin.toISOString(), false);
  }

  private reagendar(id: string, inicio: string, fin: string, todoElDia: boolean): void {
    this.calendarioService.actualizarEvento(id, { inicio, fin, todoElDia }).subscribe({
      next: () => this.cargar(),
      error: (err) => { this.error = err?.error?.error || 'No se pudo reagendar la sesión.'; },
    });
  }

  // ---------- Detalle (clic en un evento de la grilla) ----------
  abrirDetalleEvento(evento: EventoCalendario): void {
    this.eventoDetalle = evento;
    this.mostrarDetalle = true;
  }

  cerrarDetalle(): void {
    this.mostrarDetalle = false;
    this.eventoDetalle = null;
  }

  editarDesdeDetalle(): void {
    if (!this.eventoDetalle) return;
    const evento = this.eventoDetalle;
    this.cerrarDetalle();
    this.abrirEditar(evento);
  }

  vincularDesdeDetalle(): void {
    if (!this.eventoDetalle) return;
    const evento = this.eventoDetalle;
    this.cerrarDetalle();
    this.abrirVincular(evento);
  }

  eliminarDesdeDetalle(): void {
    if (!this.eventoDetalle) return;
    const evento = this.eventoDetalle;
    this.cerrarDetalle();
    this.eliminar(evento);
  }

  // ---------- Crear / editar ----------
  abrirCrear(): void {
    this.eventoEditando = null;
    this.form = this.formVacio();
    this.mostrarForm = true;
  }

  abrirEditar(evento: EventoCalendario): void {
    this.eventoEditando = evento;
    this.form = {
      titulo: evento.titulo,
      descripcion: evento.descripcion || '',
      inicio: this.aInputDatetime(new Date(evento.inicio)),
      fin: this.aInputDatetime(new Date(evento.fin)),
      asignados: [...(evento.asignados || [])],
    };
    this.mostrarForm = true;
  }

  cerrarFormulario(): void {
    this.mostrarForm = false;
    this.eventoEditando = null;
  }

  toggleAsignado(usuarioId: number, evento: Event): void {
    const marcado = (evento.target as HTMLInputElement).checked;
    if (marcado) {
      if (!this.form.asignados.includes(usuarioId)) this.form.asignados.push(usuarioId);
    } else {
      this.form.asignados = this.form.asignados.filter((id) => id !== usuarioId);
    }
  }

  guardar(): void {
    if (!this.form.titulo.trim()) return;
    this.guardando = true;

    const datos = {
      titulo: this.form.titulo.trim(),
      descripcion: this.form.descripcion.trim() || null,
      inicio: new Date(this.form.inicio).toISOString(),
      fin: new Date(this.form.fin).toISOString(),
      asignados: this.form.asignados,
    };

    const solicitud = this.eventoEditando
      ? this.calendarioService.actualizarEvento(this.eventoEditando.id, datos)
      : this.calendarioService.crearEvento(datos);

    solicitud.subscribe({
      next: () => { this.guardando = false; this.mostrarForm = false; this.eventoEditando = null; this.cargar(); },
      error: (err) => {
        this.guardando = false;
        this.error = err?.error?.error || (this.eventoEditando ? 'No se pudo guardar la sesión.' : 'No se pudo crear el evento.');
      },
    });
  }

  eliminar(evento: EventoCalendario): void {
    if (!confirm(`¿Eliminar la sesión "${evento.titulo}" del calendario?`)) return;
    this.calendarioService.eliminarEvento(evento.id).subscribe({
      next: () => this.cargar(),
      error: (err) => { this.error = err?.error?.error || 'No se pudo eliminar el evento.'; },
    });
  }

  // Lleva a la Bitácora de Pasos a Producción con este evento pre-cargado
  // (ver PasosProduccionListComponent, que lee estos query params al abrir),
  // para crear un registro NUEVO a partir de la sesión.
  crearBitacoraDesdeEvento(evento: EventoCalendario): void {
    this.router.navigate(['/pasos-produccion'], {
      queryParams: {
        googleEventId: evento.id,
        titulo: evento.titulo,
        inicio: evento.inicio,
      },
    });
  }

  // ---------- Vincular a un registro YA EXISTENTE de la bitácora ----------
  abrirVincular(evento: EventoCalendario): void {
    this.eventoVinculando = evento;
    this.pasoElegidoId = null;
    this.mostrarVincular = true;
    // Solo se ofrecen los registros que todavía no tienen un evento
    // vinculado, para no invitar a pisar por accidente un vínculo que ya
    // funciona.
    this.pasoProduccionService.listar().subscribe({
      next: (pasos) => {
        this.pasosDisponibles = pasos
          .filter((p) => !p.GoogleEventId)
          .map((p) => ({
            id: p.Id,
            nombre: p.Rfc ? `${p.Titulo} — RFC ${p.Rfc}` : p.Titulo,
            subtitulo: new Date(p.FechaHoraProgramada).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }),
          }));
      },
      error: (err) => { this.error = err?.error?.error || 'No se pudo cargar la lista de la bitácora.'; },
    });
  }

  cerrarVincular(): void {
    this.mostrarVincular = false;
    this.eventoVinculando = null;
    this.pasoElegidoId = null;
  }

  crearNuevoDesdeVincular(): void {
    if (!this.eventoVinculando) return;
    const evento = this.eventoVinculando;
    this.cerrarVincular();
    this.crearBitacoraDesdeEvento(evento);
  }

  confirmarVincular(): void {
    if (!this.eventoVinculando || !this.pasoElegidoId) return;
    this.guardandoVinculo = true;
    this.pasoProduccionService.actualizar(this.pasoElegidoId, { googleEventId: this.eventoVinculando.id }).subscribe({
      next: () => { this.guardandoVinculo = false; this.cerrarVincular(); },
      error: (err) => { this.guardandoVinculo = false; this.error = err?.error?.error || 'No se pudo vincular el evento a la bitácora.'; },
    });
  }

  // ---------- Gestionar la lista de correos del equipo (agregar/quitar) ----------
  abrirGestionCorreos(): void {
    this.nuevoCorreo = '';
    this.nuevaEtiqueta = '';
    this.mostrarGestionCorreos = true;
    this.cargarMisCalendarios();
  }

  cerrarGestionCorreos(): void {
    this.mostrarGestionCorreos = false;
  }

  agregarCorreo(): void {
    const correo = this.nuevoCorreo.trim();
    const etiqueta = this.nuevaEtiqueta.trim();
    if (!correo || !etiqueta) return;
    this.guardandoCorreo = true;
    this.calendarioService.agregarCalendarioEquipo({ correo, etiqueta }).subscribe({
      next: () => {
        this.guardandoCorreo = false;
        this.nuevoCorreo = '';
        this.nuevaEtiqueta = '';
        this.cargarMisCalendarios();
        this.cargar();
      },
      error: (err) => {
        this.guardandoCorreo = false;
        this.error = err?.error?.error || 'No se pudo agregar el correo.';
      },
    });
  }

  eliminarCorreo(c: CalendarioEquipo): void {
    if (!confirm(`¿Quitar el calendario de "${c.Etiqueta}" (${c.Correo}) de la vista del equipo?`)) return;
    this.calendarioService.eliminarCalendarioEquipo(c.Id).subscribe({
      next: () => {
        this.cargarMisCalendarios();
        this.cargar();
      },
      error: (err) => { this.error = err?.error?.error || 'No se pudo quitar el correo.'; },
    });
  }

  // ---------- Mis calendarios (agregar/quitar calendarios propios) ----------
  abrirMisCalendarios(): void {
    this.miCorreo = '';
    this.miEtiqueta = '';
    this.mostrarMisCalendarios = true;
    this.cargarMisCalendarios();
  }

  cerrarMisCalendarios(): void {
    this.mostrarMisCalendarios = false;
  }

  agregarMiCalendario(): void {
    const correo = this.miCorreo.trim();
    const etiqueta = this.miEtiqueta.trim();
    if (!correo || !etiqueta || this.guardandoMiCalendario) return;
    this.guardandoMiCalendario = true;
    this.error = null;
    this.calendarioService.agregarMiCalendario({ correo, etiqueta }).subscribe({
      next: () => {
        this.guardandoMiCalendario = false;
        this.miCorreo = '';
        this.miEtiqueta = '';
        this.cargarMisCalendarios();
        this.cargar();
      },
      error: (err) => {
        this.guardandoMiCalendario = false;
        this.error = err?.error?.error || 'No se pudo agregar el calendario.';
      },
    });
  }

  quitarMiCalendario(c: CalendarioPersonal): void {
    if (!confirm(`¿Quitar tu calendario "${c.Etiqueta}" (${c.Correo})? Solo deja de verse para ti.`)) return;
    this.calendarioService.eliminarMiCalendario(c.Id).subscribe({
      next: () => {
        this.filtroOcultos.delete(this.clavePersonal(c.Id));
        this.cargarMisCalendarios();
        this.cargar();
      },
      error: (err) => { this.error = err?.error?.error || 'No se pudo quitar el calendario.'; },
    });
  }
}
