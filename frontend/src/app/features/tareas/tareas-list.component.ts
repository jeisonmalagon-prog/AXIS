import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TareaService, Tarea, TareaDetalle, TareaChecklistItem } from '../../core/services/tarea.service';
import { UsuarioBasicoService, UsuarioBasico } from '../../core/services/usuario-basico.service';
import { AuthService } from '../../services/auth.service';

const HORA_INICIO_DEFECTO = '09:00';
const HORA_FIN_DEFECTO = '10:00';

// Las 4 columnas del tablero Kanban, en el orden en que se muestran --
// siempre los mismos 4 ESTADOS_VALIDOS del backend (tareas.js), así que no
// hace falta ninguna llamada nueva: el tablero es solo otra forma de ver los
// mismos datos de listar().
const COLUMNAS_TABLERO: { estado: Tarea['Estado']; etiqueta: string }[] = [
  { estado: 'PENDIENTE', etiqueta: 'Pendiente' },
  { estado: 'EN_PROGRESO', etiqueta: 'En progreso' },
  { estado: 'COMPLETADA', etiqueta: 'Completada' },
  { estado: 'CANCELADA', etiqueta: 'Cancelada' },
];

@Component({
  selector: 'app-tareas-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './tareas-list.component.html',
  styleUrl: './tareas-list.component.scss',
})
export class TareasListComponent implements OnInit {
  tareas: Tarea[] = [];
  usuarios: UsuarioBasico[] = [];
  // Fotos de perfil por id de usuario (data URI); sin foto => se muestran las iniciales.
  fotos: Record<string, string> = {};
  // Aviso no bloqueante cuando la tarea se guardó pero no se pudo agendar en Google Calendar.
  avisoCalendario: string | null = null;
  usuarioActualId: number | null = null;
  // Rol de módulo CONSULTA (asignado por el ADMIN_POD): ve sus tareas y cambia su
  // estado, pero no crea, edita ni elimina tareas (el backend lo valida igual).
  esConsulta = false;

  cargando = false;
  error: string | null = null;

  // Filtros de la lista
  filtroVista: 'todas' | 'creadas' | 'asignadas' = 'todas';
  filtroEstado = '';
  // Búsqueda de texto libre -- se aplica en el cliente sobre lo ya cargado
  // (título y descripción), igual que en el resto de pantallas de listado del
  // proyecto que tienen un buscador simple.
  terminoBusqueda = '';

  // ---------- Vista: tarjetas (grid) o tablero (Kanban) ----------
  vistaModo: 'tarjetas' | 'tablero' = 'tarjetas';
  columnasTablero = COLUMNAS_TABLERO;
  tareaArrastrando: Tarea | null = null;
  columnaResaltada: string | null = null;

  // Modal de creación/edición
  mostrarForm = false;
  guardando = false;
  form: { titulo: string; descripcion: string; prioridad: string; fechaLimite: string; horaInicio: string; horaFin: string; asignados: number[] } = this.formVacio();

  // Modal de detalle (avances + cambio de estado)
  tareaSeleccionada: TareaDetalle | null = null;
  cargandoDetalle = false;
  nuevoAvance = '';
  guardandoAvance = false;

  // Pestañas del modal de detalle -- "checklist" se carga perezosamente,
  // igual que en Pasos a Producción, para no disparar una llamada extra solo
  // por abrir el detalle.
  pestanaDetalle: 'detalle' | 'checklist' = 'detalle';
  checklist: TareaChecklistItem[] = [];
  checklistCargado = false;
  cargandoChecklist = false;
  nuevoItemChecklist = '';
  guardandoItemChecklist = false;

  // Edición de la tarea (título/descripción/prioridad/fecha límite/asignados)
  // desde el modal de detalle -- separado del form de creación para no mezclar
  // el estado de ambos modales.
  editando = false;
  formEdicion: { titulo: string; descripcion: string; prioridad: string; fechaLimite: string; horaInicio: string; horaFin: string; asignados: number[] } | null = null;
  guardandoEdicion = false;

  constructor(
    private tareaService: TareaService,
    private usuarioBasicoService: UsuarioBasicoService,
    private authService: AuthService,
  ) {}

  ngOnInit(): void {
    const usuario = this.authService.obtenerDatosUsuario();
    this.usuarioActualId = usuario ? usuario.id : null;
    this.esConsulta = this.authService.rolEnModulo('TAREAS') === 'CONSULTA';
    this.cargar();
    this.usuarioBasicoService.listarBasico().subscribe((u) => (this.usuarios = u));
    // Si las fotos no cargan (p. ej. sin la columna en la BD) simplemente se ven las iniciales.
    this.usuarioBasicoService.fotos().subscribe({ next: (f) => (this.fotos = f), error: () => (this.fotos = {}) });
  }

  formVacio() {
    // Horario por defecto: entrega a las 10:00, agendada desde una hora antes (09:00).
    return { titulo: '', descripcion: '', prioridad: 'MEDIA', fechaLimite: '', horaInicio: HORA_INICIO_DEFECTO, horaFin: HORA_FIN_DEFECTO, asignados: [] as number[] };
  }

  cargar(): void {
    this.cargando = true;
    this.error = null;
    const filtros: { vista?: 'creadas' | 'asignadas'; estado?: string } = {};
    if (this.filtroVista !== 'todas') filtros.vista = this.filtroVista;
    if (this.filtroEstado) filtros.estado = this.filtroEstado;

    this.tareaService.listar(filtros).subscribe({
      next: (data) => { this.tareas = data; this.cargando = false; },
      error: (err) => { this.error = err?.error?.error || 'No se pudieron cargar las tareas.'; this.cargando = false; },
    });
  }

  // ---------- Tiempo transcurrido: se calcula acá, no lo manda el backend ----------
  tiempoTranscurrido(tarea: Tarea): string {
    const inicio = new Date(tarea.FechaCreacion).getTime();
    const fin = tarea.FechaCompletada ? new Date(tarea.FechaCompletada).getTime() : Date.now();
    const minutos = Math.max(0, Math.round((fin - inicio) / 60000));
    if (minutos < 60) return `${minutos} min`;
    const horas = Math.floor(minutos / 60);
    if (horas < 24) return `${horas} h ${minutos % 60} min`;
    const dias = Math.floor(horas / 24);
    return `${dias} d ${horas % 24} h`;
  }

  esMia(tarea: Tarea): boolean {
    return tarea.CreadoPorId === this.usuarioActualId || tarea.asignados.some((a) => a.id === this.usuarioActualId);
  }

  // ---------- Indicadores (calculados de lo ya cargado, sin llamada aparte) ----------
  estaVencida(tarea: Tarea): boolean {
    if (!tarea.FechaLimite || tarea.Estado === 'COMPLETADA' || tarea.Estado === 'CANCELADA') return false;
    return new Date(tarea.FechaLimite).getTime() < Date.now();
  }

  contarPorEstado(estado: string): number {
    return this.tareas.filter((t) => t.Estado === estado).length;
  }

  contarVencidas(): number {
    return this.tareas.filter((t) => this.estaVencida(t)).length;
  }

  // Foto de perfil del usuario (data URI) o null si no tiene.
  fotoDe(usuarioId: number): string | null {
    return this.fotos[String(usuarioId)] || null;
  }

  /** Hoy (YYYY-MM-DD, hora local): tope inferior de la fecha límite. */
  get hoy(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Crear: la fecha límite no puede ser anterior a hoy. */
  fechaLimitePasadaCrear(): boolean {
    return !!this.form.fechaLimite && this.form.fechaLimite < this.hoy;
  }

  /** Editar: no se puede poner una fecha anterior a hoy, pero una tarea ya vencida conserva su fecha si no la cambias. */
  fechaLimitePasadaEdicion(): boolean {
    const f = this.formEdicion?.fechaLimite;
    if (!f || f >= this.hoy) return false;
    const original = this.tareaSeleccionada?.FechaLimite ? String(this.tareaSeleccionada.FechaLimite).substring(0, 10) : '';
    return f !== original;
  }

  // Valida el horario del formulario: con fecha límite, la entrega debe ser después del inicio.
  horarioInvalido(f: { fechaLimite: string; horaInicio: string; horaFin: string } | null): boolean {
    if (!f || !f.fechaLimite) return false;
    return !f.horaInicio || !f.horaFin || f.horaFin <= f.horaInicio;
  }

  private mostrarAvisoCalendario(t: Tarea | undefined | null): void {
    this.avisoCalendario = t?.calendario?.estado === 'error' ? (t.calendario.error || 'No se pudo agendar en el calendario de Google.') : null;
  }

  // ---------- Iniciales para el avatar circular de cada asignado ----------
  iniciales(nombreCompleto: string): string {
    const partes = nombreCompleto.trim().split(/\s+/);
    const letras = partes.length > 1 ? [partes[0][0], partes[partes.length - 1][0]] : [partes[0]?.[0] || '?'];
    return letras.join('').toUpperCase();
  }

  // ---------- Vista de tablero (Kanban) ----------
  cambiarVista(modo: 'tarjetas' | 'tablero'): void {
    this.vistaModo = modo;
  }

  // ---------- Búsqueda de texto libre (cliente) ----------
  // Se aplica sobre título y descripción, tanto en la vista de tarjetas como
  // en cada columna del tablero Kanban, para que ambas vistas se mantengan
  // consistentes al escribir en el buscador.
  private coincideBusqueda(t: Tarea): boolean {
    const termino = this.terminoBusqueda.trim().toLowerCase();
    if (!termino) return true;
    return (
      t.Titulo.toLowerCase().includes(termino) ||
      (t.Descripcion || '').toLowerCase().includes(termino)
    );
  }

  tareasFiltradas(): Tarea[] {
    return this.tareas.filter((t) => this.coincideBusqueda(t));
  }

  tareasPorEstado(estado: string): Tarea[] {
    return this.tareas.filter((t) => t.Estado === estado && this.coincideBusqueda(t));
  }

  iniciarArrastre(tarea: Tarea): void {
    this.tareaArrastrando = tarea;
  }

  terminarArrastre(): void {
    this.tareaArrastrando = null;
    this.columnaResaltada = null;
  }

  permitirSoltar(evento: DragEvent, estado: string): void {
    evento.preventDefault();
    this.columnaResaltada = estado;
  }

  soltarEnColumna(evento: DragEvent, nuevoEstado: string): void {
    evento.preventDefault();
    this.columnaResaltada = null;
    const tarea = this.tareaArrastrando;
    this.tareaArrastrando = null;
    if (!tarea || tarea.Estado === nuevoEstado) return;

    // Optimista: se actualiza en memoria de una vez para que la tarjeta se
    // sienta "soltada" al instante, y se corrige sola si el backend rechaza
    // el cambio (p. ej. ya no tiene acceso a esa tarea).
    const estadoAnterior = tarea.Estado;
    tarea.Estado = nuevoEstado as Tarea['Estado'];
    this.tareaService.actualizar(tarea.Id, { estado: nuevoEstado }).subscribe({
      next: () => this.cargar(),
      error: (err) => {
        tarea.Estado = estadoAnterior;
        this.error = err?.error?.error || 'No se pudo mover la tarea.';
      },
    });
  }

  puedeEliminar(tarea: Tarea): boolean {
    if (this.esConsulta) return false;
    // Solo quien creó la tarea (ni siquiera el ADMIN_POD ve ni gestiona las tareas de otros).
    return tarea.CreadoPorId === this.usuarioActualId;
  }

  // Quién puede editar título/descripción/prioridad/fecha límite/asignados:
  // el creador (mismo criterio que para eliminar).
  puedeEditar(tarea: Tarea): boolean {
    return this.puedeEliminar(tarea);
  }

  // Quién puede tocar el checklist: el mismo criterio que el backend usa en
  // usuarioPuedeVerTarea() -- creador o asignado. Es más amplio
  // que puedeEditar() a propósito, porque cualquier asignado (no solo el
  // creador) puede marcar sus propios pendientes.
  // Agregar o eliminar ítems del checklist no está permitido con rol de Consulta
  // (marcarlos como hechos sí).
  puedeGestionarItemsChecklist(tarea: Tarea): boolean {
    return !this.esConsulta && this.puedeEditarChecklist(tarea);
  }

  puedeEditarChecklist(tarea: Tarea): boolean {
    return this.esMia(tarea);
  }

  // ---------- Crear ----------
  abrirCrear(): void {
    this.form = this.formVacio();
    this.mostrarForm = true;
  }

  cerrarFormulario(): void {
    this.mostrarForm = false;
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
    if (!this.form.titulo.trim() || this.horarioInvalido(this.form) || this.fechaLimitePasadaCrear()) return;
    this.guardando = true;
    this.tareaService
      .crear({
        titulo: this.form.titulo.trim(),
        descripcion: this.form.descripcion.trim() || null,
        prioridad: this.form.prioridad,
        fechaLimite: this.form.fechaLimite || null,
        horaInicio: this.form.fechaLimite ? this.form.horaInicio : null,
        horaFin: this.form.fechaLimite ? this.form.horaFin : null,
        asignados: this.form.asignados,
      })
      .subscribe({
        next: (creada) => { this.guardando = false; this.mostrarForm = false; this.mostrarAvisoCalendario(creada); this.cargar(); },
        error: (err) => { this.guardando = false; this.error = err?.error?.error || 'No se pudo crear la tarea.'; },
      });
  }

  // ---------- Detalle / avances / estado ----------
  abrirDetalle(tarea: Tarea): void {
    this.cargandoDetalle = true;
    this.nuevoAvance = '';
    this.editando = false;
    this.formEdicion = null;
    this.pestanaDetalle = 'detalle';
    this.checklist = [];
    this.checklistCargado = false;
    this.nuevoItemChecklist = '';
    this.tareaService.obtener(tarea.Id).subscribe({
      next: (detalle) => { this.tareaSeleccionada = detalle; this.cargandoDetalle = false; },
      error: (err) => { this.error = err?.error?.error || 'No se pudo abrir la tarea.'; this.cargandoDetalle = false; },
    });
  }

  cerrarDetalle(): void {
    this.tareaSeleccionada = null;
    this.editando = false;
    this.formEdicion = null;
  }

  // ---------- Pestañas del detalle ----------
  seleccionarPestana(pestana: 'detalle' | 'checklist'): void {
    this.pestanaDetalle = pestana;
    if (pestana === 'checklist' && !this.checklistCargado) this.cargarChecklist();
  }

  // ---------- Checklist de subtareas ----------
  cargarChecklist(): void {
    if (!this.tareaSeleccionada) return;
    this.cargandoChecklist = true;
    this.tareaService.listarChecklist(this.tareaSeleccionada.Id).subscribe({
      next: (items) => { this.checklist = items; this.checklistCargado = true; this.cargandoChecklist = false; },
      error: (err) => { this.error = err?.error?.error || 'No se pudo cargar el checklist.'; this.cargandoChecklist = false; },
    });
  }

  progresoChecklist(): { completados: number; total: number } {
    return { completados: this.checklist.filter((i) => i.Completado).length, total: this.checklist.length };
  }

  agregarItemChecklist(): void {
    if (!this.tareaSeleccionada || !this.nuevoItemChecklist.trim()) return;
    this.guardandoItemChecklist = true;
    this.tareaService.agregarChecklistItem(this.tareaSeleccionada.Id, this.nuevoItemChecklist.trim()).subscribe({
      next: (item) => { this.checklist = [...this.checklist, item]; this.nuevoItemChecklist = ''; this.guardandoItemChecklist = false; },
      error: (err) => { this.error = err?.error?.error || 'No se pudo agregar el ítem.'; this.guardandoItemChecklist = false; },
    });
  }

  toggleItemChecklist(item: TareaChecklistItem): void {
    if (!this.tareaSeleccionada) return;
    const completado = !item.Completado;
    this.tareaService.actualizarChecklistItem(this.tareaSeleccionada.Id, item.Id, { completado }).subscribe({
      next: (actualizado) => { this.checklist = this.checklist.map((i) => (i.Id === item.Id ? actualizado : i)); },
      error: (err) => { this.error = err?.error?.error || 'No se pudo actualizar el ítem.'; },
    });
  }

  eliminarItemChecklist(item: TareaChecklistItem): void {
    if (!this.tareaSeleccionada) return;
    this.tareaService.eliminarChecklistItem(this.tareaSeleccionada.Id, item.Id).subscribe({
      next: () => { this.checklist = this.checklist.filter((i) => i.Id !== item.Id); },
      error: (err) => { this.error = err?.error?.error || 'No se pudo eliminar el ítem.'; },
    });
  }

  // ---------- Edición ----------
  abrirEdicion(): void {
    if (!this.tareaSeleccionada) return;
    this.formEdicion = {
      titulo: this.tareaSeleccionada.Titulo,
      descripcion: this.tareaSeleccionada.Descripcion || '',
      prioridad: this.tareaSeleccionada.Prioridad,
      fechaLimite: this.tareaSeleccionada.FechaLimite ? this.tareaSeleccionada.FechaLimite.substring(0, 10) : '',
      horaInicio: this.tareaSeleccionada.HoraInicio || HORA_INICIO_DEFECTO,
      horaFin: this.tareaSeleccionada.HoraFin || HORA_FIN_DEFECTO,
      asignados: this.tareaSeleccionada.asignados.map((a) => a.id),
    };
    this.editando = true;
  }

  cancelarEdicion(): void {
    this.editando = false;
    this.formEdicion = null;
  }

  toggleAsignadoEdicion(usuarioId: number, evento: Event): void {
    if (!this.formEdicion) return;
    const marcado = (evento.target as HTMLInputElement).checked;
    if (marcado) {
      if (!this.formEdicion.asignados.includes(usuarioId)) this.formEdicion.asignados.push(usuarioId);
    } else {
      this.formEdicion.asignados = this.formEdicion.asignados.filter((id) => id !== usuarioId);
    }
  }

  guardarEdicion(): void {
    if (!this.tareaSeleccionada || !this.formEdicion || !this.formEdicion.titulo.trim() || this.horarioInvalido(this.formEdicion) || this.fechaLimitePasadaEdicion()) return;
    this.guardandoEdicion = true;
    this.tareaService
      .actualizar(this.tareaSeleccionada.Id, {
        titulo: this.formEdicion.titulo.trim(),
        descripcion: this.formEdicion.descripcion.trim() || null,
        prioridad: this.formEdicion.prioridad,
        fechaLimite: this.formEdicion.fechaLimite || null,
        horaInicio: this.formEdicion.fechaLimite ? this.formEdicion.horaInicio : null,
        horaFin: this.formEdicion.fechaLimite ? this.formEdicion.horaFin : null,
        asignados: this.formEdicion.asignados,
      })
      .subscribe({
        next: (actualizada) => {
          this.mostrarAvisoCalendario(actualizada);
          this.guardandoEdicion = false;
          this.editando = false;
          this.formEdicion = null;
          this.tareaSeleccionada = { ...this.tareaSeleccionada!, ...actualizada };
          this.cargar();
        },
        error: (err) => { this.guardandoEdicion = false; this.error = err?.error?.error || 'No se pudo guardar los cambios.'; },
      });
  }

  cambiarEstado(nuevoEstado: string): void {
    if (!this.tareaSeleccionada) return;
    this.tareaService.actualizar(this.tareaSeleccionada.Id, { estado: nuevoEstado }).subscribe({
      next: (actualizada) => {
        this.tareaSeleccionada = { ...this.tareaSeleccionada!, ...actualizada };
        this.cargar();
      },
      error: (err) => { this.error = err?.error?.error || 'No se pudo actualizar el estado.'; },
    });
  }

  agregarAvance(): void {
    if (!this.tareaSeleccionada || !this.nuevoAvance.trim()) return;
    this.guardandoAvance = true;
    this.tareaService.agregarAvance(this.tareaSeleccionada.Id, this.nuevoAvance.trim()).subscribe({
      next: (avances) => {
        this.tareaSeleccionada = { ...this.tareaSeleccionada!, avances };
        this.nuevoAvance = '';
        this.guardandoAvance = false;
      },
      error: (err) => { this.error = err?.error?.error || 'No se pudo registrar el avance.'; this.guardandoAvance = false; },
    });
  }

  eliminar(tarea: Tarea): void {
    if (!confirm(`¿Eliminar la tarea "${tarea.Titulo}"?`)) return;
    this.tareaService.eliminar(tarea.Id).subscribe({
      next: () => this.cargar(),
      error: (err) => { this.error = err?.error?.error || 'No se pudo eliminar la tarea.'; },
    });
  }

  etiquetaEstado(estado: string): string {
    const mapa: Record<string, string> = {
      PENDIENTE: 'Pendiente', EN_PROGRESO: 'En progreso', COMPLETADA: 'Completada', CANCELADA: 'Cancelada',
    };
    return mapa[estado] || estado;
  }
}
