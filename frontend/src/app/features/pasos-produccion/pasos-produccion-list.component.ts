import { Component, ElementRef, HostListener, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom, forkJoin, Observable, Subscription } from 'rxjs';
import {
  PasoProduccionService, PasoProduccion, ChecklistItem, EventoHistorial, CommitAzure, RepositorioAzure, PropuestaGlpi, PendienteGlpi,
  SeguimientoGlpiPreview, SeguimientoGlpiResultado, ArchivoSeguimientoGlpi, TipoRespuestaGlpi, EstadoCasoGlpi, ServicioPaso, PasoDuplicado,
  VistaPasos, ConteosPasos, AccionMasivaPasos, ResultadoMasivoPasos,
} from '../../core/services/paso-produccion.service';
import { EstadoBitacora, SeleccionBitacora } from '../../core/services/bitacora-acceso.service';
import { AceServiciosService } from '../../core/services/ace-servicios.service';
import { AceServicioInventario } from '../../core/models/models';
import { UsuarioBasicoService, UsuarioBasico } from '../../core/services/usuario-basico.service';
import { AplicativoInventarioService, AplicativoInventarioBasico } from '../../core/services/aplicativo-inventario.service';
import { AuthService } from '../../services/auth.service';
import { GlpiCasosEquipoComponent } from './glpi-casos-equipo.component';
import { SelectorBuscableComponent, OpcionSelector } from '../../shared/selector-buscable/selector-buscable.component';
import { BitacoraVistasComponent } from './bitacora-vistas.component';
import { CompartirPasoComponent } from './compartir-paso.component';
import { FusionarPasosComponent, OpcionFusion } from './fusionar-pasos.component';

const ESTADOS_QUE_REQUIEREN_MOTIVO = new Set(['CANCELADO', 'REAGENDADO', 'ROLLBACK']);

// Estado del selector de commit de Azure DevOps -- primero se elige el repo
// (repo), lo que trae/habilita la lista de commits de ESE repo (commits).
// Se usa dos veces (al crear y al editar), de ahí que sea su propia forma en
// vez de repetir 4 campos sueltos por cada contexto.
interface EstadoSelectorCommit {
  repo: string;
  commits: CommitAzure[];
  cargandoCommits: boolean;
  error: string | null;
}
function estadoSelectorCommitVacio(): EstadoSelectorCommit {
  return { repo: '', commits: [], cargandoCommits: false, error: null };
}

// Imagen pegada/elegida que todavía no se subió (vive solo en el navegador).
interface ImagenPendiente { archivo: File; nombre: string; previewUrl: string; }
// Imagen ya guardada de un ítem, descargada para mostrarla en la galería.
interface ImagenGaleria { id: number; nombre: string; url: string; fecha: string | null; autor: string | null; }

// Diálogo para eliminar uno o varios pasos: lógica («Eliminados», reversible) o definitiva (borra todo).
interface DialogoEliminar {
  pasos: PasoProduccion[];
  modo: 'logico' | 'definitivo';
  motivo: string;
  confirmo: boolean;
  procesando: boolean;
  error: string | null;
  /** Solo se ofrece la definitiva: el paso ya está en Eliminados o falta el script SQL de eliminación lógica. */
  soloDefinitivo: boolean;
  faltaScript: boolean;
  /** Quien consulta puede borrar definitivamente todos los elegidos (solo quien creó el paso). */
  puedeDefinitivo: boolean;
}

@Component({
  selector: 'app-pasos-produccion-list',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectorBuscableComponent, GlpiCasosEquipoComponent, BitacoraVistasComponent, CompartirPasoComponent, FusionarPasosComponent],
  templateUrl: './pasos-produccion-list.component.html',
  styleUrl: './pasos-produccion-list.component.scss',
})
export class PasosProduccionListComponent implements OnInit {
  pasos: PasoProduccion[] = [];
  usuarios: UsuarioBasico[] = [];
  aplicativos: AplicativoInventarioBasico[] = [];
  puedeEditar = false;

  cargando = false;
  error: string | null = null;

  filtroEntorno = '';
  filtroEstado = '';

  // ---------- Vistas: principal / ocultos / eliminados ----------
  // · Ocultar es PERSONAL: quita el paso de MI vista principal (los demás lo siguen viendo).
  // · «Eliminar» tiene dos formas: lógica (pasa a Eliminados, se puede restaurar) y definitiva (borra todo).
  vista: VistaPasos = 'principal';
  conteos: ConteosPasos | null = null;
  modoSeleccion = false;
  seleccionados = new Set<number>();
  dialogoEliminar: DialogoEliminar | null = null;
  resultadoAccion: { texto: string; omitidos: { id: number; titulo: string | null; motivo: string }[]; error?: boolean } | null = null;
  trabajandoMasivo = false;
  private resultadoTimer?: ReturnType<typeof setTimeout>;
  // Búsqueda de texto libre (cliente, sobre lo ya cargado) -- por RFC,
  // título o aplicativo, que son los campos por los que más se busca un
  // registro puntual de la bitácora.
  terminoBusqueda = '';

  mostrarForm = false;
  guardando = false;
  form = this.formVacio();

  // ---------- Bitácora única por persona (vistas, accesos, tipo BUS, duplicados) ----------
  /** false mientras no existan las tablas nuevas: la bitácora funciona como antes (todos ven todo). */
  bitacoraDisponible = false;
  bitacoraEstado: EstadoBitacora | null = null;
  seleccion: SeleccionBitacora = { propietarios: ['yo'], equipos: [], compartidos: false, todos: false };
  abrirAccesosPanel = false;
  refrescoVistas = 0;
  pasoCompartir: PasoProduccion | null = null;
  duplicado: PasoDuplicado | null = null;
  fusionOpciones: OpcionFusion[] | null = null;
  fusionPreseleccion: number | null = null;
  serviciosInventario: AceServicioInventario[] = [];
  opcionesServicios: OpcionSelector[] = [];
  selectorServicio: number | null = null;
  errorServicios: string | null = null;
  serviciosEditar: ServicioPaso[] = [];
  guardandoServicios = false;

  pasoSeleccionado: PasoProduccion | null = null;
  formEstado = { estado: '', motivo: '', resultadoEjecucion: '', fechaHoraInicioReal: '', fechaHoraFinReal: '', nuevaFecha: '' };
  guardandoEstado = false;

  // Hora estimada de finalización: editable aparte del resto de la bitácora
  // (no hace falta abrir un formulario completo de edición solo para ajustar
  // esta fecha).
  formEstimadoFin = '';
  guardandoEstimadoFin = false;

  // ---------- Pestañas del modal de detalle ----------
  // 'checklist'/'historial' se cargan la primera vez que se abre esa pestaña
  // (no de una, para no disparar llamadas extra solo por abrir el registro)
  // -- los *Cargado controlan eso. La pestaña "Adjuntos" (adjuntos sueltos,
  // sin asociar a nada) se quitó: la evidencia ahora siempre viaja asociada
  // a un ítem del checklist (ver verEvidenciaChecklist).
  pestanaDetalle: 'detalle' | 'checklist' | 'historial' = 'detalle';

  checklist: ChecklistItem[] = [];
  checklistCargado = false;
  cargandoChecklist = false;
  nuevoItemChecklist = '';
  guardandoItemChecklist = false;

  historial: EventoHistorial[] = [];
  historialCargado = false;
  cargandoHistorial = false;

  // ---------- Checklist "en línea" en la vista principal ----------
  // Para cada registro no culminado (ver mostrarChecklistInline) se trae su
  // checklist apenas carga la lista -- así se ve y se puede marcar sin tener
  // que abrir el detalle. Se guarda por PasoId porque la lista muestra
  // varios registros a la vez.
  checklistPorPaso: Record<number, ChecklistItem[]> = {};
  checklistInlineCargando: Record<number, boolean> = {};
  // Ítem para el que se está esperando el pantallazo de evidencia (se setea al
  // click en un checkbox sin marcar; mientras esté distinto de null se muestra
  // el modal de "pegar evidencia" -- ver onPegarEvidencia/procesarEvidenciaArchivo).
  // `marcar` = true: al guardar las imágenes el ítem queda marcado como hecho;
  // false: solo se agregan imágenes al ítem sin tocar su estado. `imagenes`
  // acumula varias capturas antes de guardar; nada se sube hasta confirmar.
  pendienteEvidencia: { paso: PasoProduccion; item: ChecklistItem; marcar: boolean; imagenes: ImagenPendiente[]; subiendo: boolean } | null = null;
  subiendoEvidenciaItemId: number | null = null;
  errorEvidencia: string | null = null;
  @ViewChild('inputEvidenciaChecklist') inputEvidenciaChecklist!: ElementRef<HTMLInputElement>;
  // Se dispara apenas el *ngIf del modal de evidencia crea la zona de pegado --
  // hace falta enfocarla a mano para que el navegador entregue el evento
  // 'paste' (si no, Ctrl+V no llega a ningún elemento de la página).
  @ViewChild('zonaPegarEvidencia') set zonaPegarEvidenciaRef(ref: ElementRef<HTMLDivElement> | undefined) {
    if (ref) setTimeout(() => ref.nativeElement.focus());
  }

  // Galería de evidencias de un ítem (reemplaza abrir el archivo en una
  // pestaña nueva): se descargan las imágenes del ítem, se arman Blob URLs y
  // se muestran acá mismo en un lightbox con navegación -- ver
  // verEvidenciaChecklist/cerrarEvidenciaPreview.
  galeria: { paso: PasoProduccion; item: ChecklistItem; imagenes: ImagenGaleria[]; indice: number } | null = null;
  cargandoEvidenciaPreview = false;
  private evidenciaPreviewSub?: Subscription;

  // ---------- Selector de commit de Azure DevOps (repo -> commits de ese repo) ----------
  // Uno para el formulario de creación, otro para el de edición (detalle) --
  // ver EstadoSelectorCommit arriba. La lista de repos es una sola, compartida
  // por ambos selectores (se carga una vez).
  reposAzure: RepositorioAzure[] = [];
  cargandoRepos = false;
  errorRepos: string | null = null;
  commitSelectorCrear: EstadoSelectorCommit = estadoSelectorCommitVacio();
  commitSelectorEditar: EstadoSelectorCommit = estadoSelectorCommitVacio();
  // Repo del que vino el commit ya elegido -- se necesita aparte porque
  // CommitAzure (lo que devuelve el backend) no trae el nombre del repo, y
  // hace falta para guardarlo junto con el commit (ver commitAPayload).
  commitRepoElegidoEditar: string | null = null;
  formCommit: CommitAzure | null = null;
  guardandoCommit = false;

  // ~10 MB -- mismo límite que valida el backend (TAMANO_MAXIMO_ADJUNTO_BYTES
  // en pasosProduccion.js); se repite acá solo para avisar antes de subir en
  // vez de esperar la respuesta del servidor.
  private static readonly TAMANO_MAXIMO_ADJUNTO_BYTES = 10 * 1024 * 1024;
  // La evidencia de un ítem de checklist SIEMPRE es una imagen (pantallazo) --
  // set más chico que el de adjuntos generales, igual al que valida el backend.
  private static readonly EXTENSIONES_EVIDENCIA_CHECKLIST = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

  private static readonly ETIQUETAS_ACCION_HISTORIAL: Record<string, string> = {
    CREACION: 'Registro creado',
    ACTUALIZACION: 'Datos actualizados',
    CAMBIO_ESTADO: 'Cambio de estado',
    ELIMINACION: 'Registro eliminado definitivamente',
    ELIMINACION_LOGICA: 'Movido a Eliminados',
    RESTAURACION: 'Restaurado desde Eliminados',
    CHECKLIST_AGREGADO: 'Ítem de checklist agregado',
    CHECKLIST_COMPLETADO: 'Ítem de checklist completado',
    CHECKLIST_REABIERTO: 'Ítem de checklist reabierto',
    CHECKLIST_ELIMINADO: 'Ítem de checklist eliminado',
    ADJUNTO_AGREGADO: 'Adjunto agregado',
    ADJUNTO_ELIMINADO: 'Adjunto eliminado',
    PUBLICADO_GLPI: 'Publicado en GLPI',
    SOLUCION_GLPI: 'Solución publicada en GLPI (cierre)',
  };

  constructor(
    private pasoService: PasoProduccionService,
    private usuarioBasicoService: UsuarioBasicoService,
    private aplicativoInventarioService: AplicativoInventarioService,
    private aceServiciosService: AceServiciosService,
    private authService: AuthService,
    private route: ActivatedRoute,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('PASOS_PRODUCCION');

    this.cargar();
    this.usuarioBasicoService.listarBasico().subscribe((u) => (this.usuarios = u));
    this.aplicativoInventarioService.listarBasico().subscribe({
      next: (lista) => { this.aplicativos = lista; this.recalcularServidores('crear'); this.recalcularServidores('editar'); },
      // Silencioso: si falla, el selector simplemente queda vacío en vez de
      // romper el resto de la pantalla.
      error: () => (this.aplicativos = []),
    });
    this.cargandoRepos = true;
    this.pasoService.listarRepositorios().subscribe({
      next: (resp) => { this.reposAzure = resp.repositorios; this.cargandoRepos = false; },
      error: (err) => { this.errorRepos = err?.error?.error || 'No se pudo cargar la lista de repositorios de Azure DevOps.'; this.cargandoRepos = false; },
    });

    // Si venimos desde Calendario ("Crear bitácora" de un evento), se abre el
    // formulario de creación ya pre-cargado con esos datos.
    this.route.queryParams.subscribe((params) => {
      // Desde una notificación de la bitácora: abre el panel de accesos.
      if (params['accesos']) this.abrirAccesosPanel = true;
      if (params['googleEventId']) {
        this.form = this.formVacio();
        this.limpiarImportacion();
        this.form.googleEventId = params['googleEventId'];
        this.form.titulo = params['titulo'] || '';
        if (params['inicio']) {
          this.form.fechaHoraProgramada = this.aInputDatetime(new Date(params['inicio']));
        }
        this.mostrarForm = true;
        // Limpia los query params para que un refresh no reabra el modal.
        this.router.navigate([], { relativeTo: this.route, queryParams: {} });
      }
    });
  }

  private aInputDatetime(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  formVacio() {
    return {
      rfc: '', titulo: '', entorno: 'QA', componenteIds: [] as number[], fechaHoraProgramada: '',
      fechaHoraEstimadaFin: '', descripcion: '', equipo: [] as number[], googleEventId: null as string | null,
      // Checklist armado ANTES de que el registro exista (sin PasoId todavía)
      // -- se guarda como texto plano y se sube ítem por ítem recién después
      // de crear el registro (ver guardar()).
      checklistNuevo: [] as string[],
      // Paso de aplicación/servidores o paso del BUS (con servicios del inventario de Servicios).
      tipo: 'APLICACION' as 'APLICACION' | 'BUS',
      servicios: [] as ServicioPaso[],
      commit: null as CommitAzure | null,
      // Repo del que vino `commit` -- ver commitRepoElegidoEditar más abajo.
      commitRepoElegido: null as string | null,
    };
  }

  cargar(): void {
    this.cargando = true;
    this.error = null;
    this.pasoService
      .listar({ entorno: this.filtroEntorno || undefined, estado: this.filtroEstado || undefined, vista: this.vista, ...this.filtrosBitacora() })
      .subscribe({
        next: (data) => {
          this.pasos = data;
          this.cargando = false;
          // Lo que ya no está en la lista no puede seguir seleccionado.
          const vigentes = new Set(data.map((x) => x.Id));
          this.seleccionados.forEach((id) => { if (!vigentes.has(id)) this.seleccionados.delete(id); });
          this.cargarChecklistsInline(data);
        },
        error: (err) => { this.error = err?.error?.error || 'No se pudo cargar la bitácora.'; this.cargando = false; },
      });
    this.cargarConteos();
  }

  /** Cuántos pasos hay en cada pestaña (con las mismas bitácoras elegidas arriba). Silencioso si falla. */
  cargarConteos(): void {
    this.pasoService.conteos(this.filtrosBitacora()).subscribe({
      next: (c) => (this.conteos = c),
      error: () => {},
    });
  }

  cambiarVista(v: VistaPasos): void {
    if (this.vista === v) return;
    this.vista = v;
    this.pasos = [];
    this.limpiarSeleccion();
    this.modoSeleccion = false;
    this.resultadoAccion = null;
    this.cargar();
  }

  // ---------- Checklist "en línea" en la vista principal ----------
  // "todos los que tenga un estado no culminado... muestre los checklist" --
  // lo único culminado es EJECUTADO, así que cualquier otro estado (incluido
  // Rollback) trae y muestra su checklist directamente en la fila.
  mostrarChecklistInline(paso: PasoProduccion): boolean {
    return paso.Estado !== 'EJECUTADO' && !paso.Eliminado;
  }

  private cargarChecklistsInline(pasos: PasoProduccion[]): void {
    const pendientes = pasos.filter((p) => this.mostrarChecklistInline(p));
    pendientes.forEach((p) => {
      this.checklistInlineCargando[p.Id] = true;
      this.pasoService.listarChecklist(p.Id).subscribe({
        next: (items) => { this.checklistPorPaso[p.Id] = items; this.checklistInlineCargando[p.Id] = false; },
        error: () => { this.checklistInlineCargando[p.Id] = false; },
      });
    });
  }

  /** Qué bitácoras pide la barra de vistas. Sin las tablas nuevas no se manda nada (todo se ve como antes). */
  private filtrosBitacora(): { propietarios?: string; equipos?: string; compartidos?: string; todos?: string } {
    if (!this.bitacoraDisponible) return {};
    const s = this.seleccion;
    if (s.todos) return { todos: '1' };
    return {
      propietarios: s.propietarios.join(',') || undefined,
      equipos: s.equipos.join(',') || undefined,
      compartidos: s.compartidos ? '1' : undefined,
    };
  }

  alCambiarEstadoBitacora(e: EstadoBitacora): void {
    this.bitacoraEstado = e;
    this.bitacoraDisponible = e.disponible;
  }

  alCambiarSeleccion(s: SeleccionBitacora): void {
    this.seleccion = s;
    this.cargar();
  }

  accesosAbiertos(): void {
    this.abrirAccesosPanel = false;
    if (this.route.snapshot.queryParams['accesos']) this.router.navigate([], { relativeTo: this.route, queryParams: {} });
  }

  // ---------- Permisos por paso ----------
  // El rol del módulo (puedeEditar) decide si se puede escribir en general; el nivel sobre cada paso
  // decide si se puede en ESE paso: creador, participantes y quien tenga permiso de edición. Un paso
  // compartido solo para lectura (o visto como administrador) no se modifica.
  editaPaso(p: PasoProduccion | null | undefined): boolean {
    if (!p || !this.puedeEditar || p.Eliminado) return false; // un paso en «Eliminados» es de solo lectura
    return !p.miNivel || p.miNivel === 'PROPIETARIO' || p.miNivel === 'EDICION';
  }

  /** Quien puede editar el paso (creador, participante o con permiso de edición) lo mueve a Eliminados y lo restaura. */
  puedeEliminarLogico(p: PasoProduccion): boolean {
    return this.puedeEditar && (!p.miNivel || p.miNivel === 'PROPIETARIO' || p.miNivel === 'EDICION');
  }

  /** Solo quien creó el paso lo elimina definitivamente. */
  puedeEliminar(p: PasoProduccion): boolean {
    return this.puedeEditar && (!p.miNivel || p.miNivel === 'PROPIETARIO');
  }

  /** ¿Hay botón de eliminar en la fila? En «Eliminados» solo queda la eliminación definitiva. */
  puedeBorrarFila(p: PasoProduccion): boolean {
    return p.Eliminado ? this.puedeEliminar(p) : (this.puedeEliminarLogico(p) || this.puedeEliminar(p));
  }

  get puedeOcultar(): boolean {
    return !!this.conteos?.ocultosListos;
  }

  get editaDetalle(): boolean {
    return this.editaPaso(this.pasoSeleccionado);
  }

  mensajeVacio(): string {
    if (this.vista === 'ocultos') return 'No tienes pasos ocultos. Usa el ojo tachado de cualquier registro para quitarlo de tu vista principal sin borrarlo.';
    if (this.vista === 'eliminados') return 'No hay pasos en Eliminados.';
    if (!this.bitacoraDisponible) return 'No hay registros con esos filtros.';
    const s = this.seleccion;
    const soloMia = !s.todos && !s.compartidos && !s.equipos.length && s.propietarios.length === 1 && s.propietarios[0] === 'yo';
    if (soloMia && !this.filtroEntorno && !this.filtroEstado) {
      return 'Todavía no tienes pasos en tu bitácora. Crea uno con «+ Nuevo Registro» o, si participas en un paso que alguien ya creó, pídele que te agregue como participante: es un solo paso para todos.';
    }
    return 'No hay pasos en esta vista con esos filtros.';
  }

  /** Participantes (y administradores) pueden compartir el paso. */
  puedeCompartir(p: PasoProduccion): boolean {
    return this.bitacoraDisponible && !p.Eliminado && (!!p.soyParticipante || !!this.bitacoraEstado?.esAdmin);
  }

  etiquetaNivel(p: PasoProduccion): string {
    if (!this.bitacoraDisponible) return '';
    if (p.miNivel === 'LECTURA') return 'Solo lectura';
    if (p.miNivel === 'ADMIN') return 'Vista de administrador';
    if (p.miNivel === 'EDICION' && !p.soyParticipante) return 'Puedes editar';
    return '';
  }

  avisoSoloLectura(p: PasoProduccion): string {
    return p.miNivel === 'ADMIN'
      ? 'Lo ves como administrador: puedes consultarlo, pero solo quienes participan lo modifican.'
      : 'Te lo compartieron solo para lectura: puedes consultarlo, pero no modificarlo.';
  }

  // ---------- Pasos duplicados (mismo RFC y ambiente) ----------
  puedeFusionar(p: PasoProduccion): boolean {
    return this.puedeEditar && !p.Eliminado && !!p.duplicados?.length;
  }

  cantidadConDuplicados(): number {
    return this.pasos.filter((p) => !!p.duplicados?.length).length;
  }

  abrirFusion(p: PasoProduccion, evento?: Event): void {
    evento?.stopPropagation();
    const admin = !!this.bitacoraEstado?.esAdmin;
    const yo: OpcionFusion = {
      id: p.Id, titulo: p.Titulo, rfc: p.Rfc, entorno: p.Entorno, estado: p.Estado, fechaHoraProgramada: p.FechaHoraProgramada, creadoPor: p.CreadoPorNombre,
      participantes: [p.CreadoPorNombre, ...(p.equipo || []).map((e) => e.nombreCompleto)].filter((x, i, a) => !!x && a.indexOf(x) === i).join(', '),
      puedeConservar: admin || this.editaPaso(p), puedeAbsorber: admin || !p.miNivel || p.miNivel === 'PROPIETARIO',
    };
    const otros: OpcionFusion[] = (p.duplicados || []).map((d) => ({
      id: d.id, titulo: d.titulo, rfc: p.Rfc, entorno: p.Entorno, estado: d.estado, fechaHoraProgramada: d.fechaHoraProgramada, creadoPor: d.creadoPor,
      participantes: d.participantes, puedeConservar: d.puedeConservar, puedeAbsorber: d.puedeAbsorber,
    }));
    this.fusionPreseleccion = p.Id;
    this.fusionOpciones = [yo, ...otros];
  }

  alFusionar(): void {
    this.fusionOpciones = null;
    this.cerrarDetalle();
    this.refrescoVistas++;
    this.cargar();
  }

  abrirCompartir(p: PasoProduccion, evento?: Event): void {
    evento?.stopPropagation();
    this.pasoCompartir = p;
  }

  nombresParticipantes(p: PasoProduccion): string {
    return (p.equipo || []).map((e) => e.nombreCompleto).join(', ');
  }

  // ---------- Servicios del BUS ----------
  private cargarServiciosInventario(): void {
    if (this.serviciosInventario.length || !this.bitacoraEstado?.serviciosDisponible) return;
    this.aceServiciosService.listar().subscribe({
      next: (lista) => {
        this.serviciosInventario = lista;
        this.opcionesServicios = lista.map((s) => ({ id: s.Id, nombre: `${s.Codigo ? s.Codigo + ' · ' : ''}${s.NombreServicio}`, subtitulo: s.Tipo }));
      },
      error: () => { this.errorServicios = 'No se pudo cargar la lista de servicios.'; },
    });
  }

  etiquetaServicio(s: ServicioPaso): string {
    return `${s.codigo ? s.codigo + ' · ' : ''}${s.nombre}`;
  }

  private servicioDeInventario(id: number): ServicioPaso | null {
    const s = this.serviciosInventario.find((x) => x.Id === id);
    return s ? { id: s.Id, codigo: s.Codigo, nombre: s.NombreServicio } : null;
  }

  elegirTipo(tipo: 'APLICACION' | 'BUS'): void {
    this.form.tipo = tipo;
    this.duplicado = null;
    if (tipo === 'BUS') this.cargarServiciosInventario();
  }

  agregarServicio(id: number | null, contexto: 'crear' | 'editar'): void {
    if (id === null || id === undefined) return;
    const s = this.servicioDeInventario(id);
    const lista = contexto === 'crear' ? this.form.servicios : this.serviciosEditar;
    if (s && !lista.some((x) => x.id === id)) {
      if (contexto === 'crear') this.form.servicios = [...lista, s]; else this.serviciosEditar = [...lista, s];
    }
    // Deja el buscador vacío para poder agregar otro.
    this.selectorServicio = id;
    setTimeout(() => (this.selectorServicio = null));
  }

  quitarServicio(id: number, contexto: 'crear' | 'editar'): void {
    if (contexto === 'crear') this.form.servicios = this.form.servicios.filter((s) => s.id !== id);
    else this.serviciosEditar = this.serviciosEditar.filter((s) => s.id !== id);
  }

  get serviciosEditarCambiaron(): boolean {
    const actuales = (this.pasoSeleccionado?.servicios || []).map((s) => s.id).sort((a, b) => a - b).join(',');
    return actuales !== this.serviciosEditar.map((s) => s.id).sort((a, b) => a - b).join(',');
  }

  guardarServicios(): void {
    if (!this.pasoSeleccionado || this.guardandoServicios) return;
    this.guardandoServicios = true;
    this.pasoService.actualizar(this.pasoSeleccionado.Id, { servicioIds: this.serviciosEditar.map((s) => s.id) }).subscribe({
      next: (actualizado) => {
        this.guardandoServicios = false;
        this.pasoSeleccionado = actualizado;
        this.serviciosEditar = [...(actualizado.servicios || [])];
        this.cargar();
      },
      error: (err) => { this.guardandoServicios = false; this.error = err?.error?.error || 'No se pudieron guardar los servicios.'; },
    });
  }

  // ---------- Búsqueda de texto libre (cliente) ----------
  pasosFiltrados(): PasoProduccion[] {
    const termino = this.terminoBusqueda.trim().toLowerCase();
    if (!termino) return this.pasos;
    return this.pasos.filter((p) =>
      (p.Titulo || '').toLowerCase().includes(termino) ||
      (p.Rfc || '').toLowerCase().includes(termino) ||
      (p.AplicativoNombre || '').toLowerCase().includes(termino) ||
      (p.AplicativosTexto || '').toLowerCase().includes(termino) ||
      (p.servicios || []).some((s) => this.etiquetaServicio(s).toLowerCase().includes(termino)) ||
      (p.CreadoPorNombre || '').toLowerCase().includes(termino)
    );
  }

  abrirCrear(): void {
    this.duplicado = null;
    this.form = this.formVacio();
    this.limpiarImportacion();
    this.recalcularServidores('crear');
    this.nuevoItemChecklistCrear = '';
    this.commitSelectorCrear = estadoSelectorCommitVacio();
    this.mostrarForm = true;
  }

  cerrarFormulario(): void {
    this.mostrarForm = false;
    this.duplicado = null;
    this.limpiarImportacion();
  }

  // ---------- Importar desde GLPI ----------
  // Pide el número de caso, el backend lo lee de GLPI y devuelve una PROPUESTA
  // (nada se guarda). Se carga en el mismo formulario de "Nuevo Registro": lo
  // que no se encontró queda marcado como pendiente y el usuario decide si crea.
  mostrarImportar = false;
  casoGlpi = '';
  contenidoGlpi = '';
  pegarContenidoGlpi = false;
  importandoGlpi = false;
  errorImportarGlpi: string | null = null;
  glpiConfigurado: boolean | null = null;

  importacion: PropuestaGlpi | null = null;
  /** Campos pendientes que el usuario ya revisó/completó (dejan de marcarse). */
  private pendientesResueltos = new Set<string>();
  pendientesVisibles: PendienteGlpi[] = [];
  camposPendientes = new Set<string>();

  // Listado de casos del equipo en GLPI (solo lectura).
  mostrarCasosGlpi = false;

  /** Desde el listado: abre «Importar desde GLPI» con el caso elegido y lo lee de una vez. */
  importarDesdeListado(caso: string): void {
    this.mostrarCasosGlpi = false;
    this.abrirImportar();
    this.casoGlpi = caso;
    this.importarDesdeGlpi();
  }

  abrirImportar(): void {
    this.mostrarImportar = true;
    this.casoGlpi = '';
    this.contenidoGlpi = '';
    this.errorImportarGlpi = null;
    this.importandoGlpi = false;
    this.pegarContenidoGlpi = false;
    if (this.glpiConfigurado === null) {
      this.pasoService.estadoGlpi().subscribe({
        next: (r) => { this.glpiConfigurado = r.configurado; if (!r.configurado) this.pegarContenidoGlpi = true; },
        error: () => { this.glpiConfigurado = null; },
      });
    } else if (!this.glpiConfigurado) {
      this.pegarContenidoGlpi = true;
    }
  }

  cerrarImportar(): void {
    if (this.importandoGlpi) return;
    this.mostrarImportar = false;
  }

  /** Acepta el número o el link completo del caso (…ticket.form.php?id=407934). */
  private numeroCasoGlpi(): string {
    const texto = this.casoGlpi.trim();
    const m = texto.match(/[?&]id=(\d+)/i);
    return (m ? m[1] : texto.replace(/\D/g, '')).slice(0, 9);
  }

  importarDesdeGlpi(): void {
    const caso = this.numeroCasoGlpi();
    if (!caso) { this.errorImportarGlpi = 'Escribe el número del caso (ej. 407934) o pega el link del caso.'; return; }
    const contenido = this.pegarContenidoGlpi ? this.contenidoGlpi.trim() : '';
    if (this.pegarContenidoGlpi && !contenido) { this.errorImportarGlpi = 'Pega el contenido del caso, o desactiva la opción para leerlo de GLPI.'; return; }
    this.importandoGlpi = true;
    this.errorImportarGlpi = null;
    this.pasoService.previsualizarGlpi({ caso, ...(contenido ? { contenido } : {}) }).subscribe({
      next: (r) => { this.importandoGlpi = false; this.mostrarImportar = false; this.aplicarImportacion(r); },
      error: (err) => {
        this.importandoGlpi = false;
        this.errorImportarGlpi = err?.error?.error || 'No se pudo leer el caso de GLPI. Intenta de nuevo.';
        if (err?.error?.permitePegar) this.pegarContenidoGlpi = true;
      },
    });
  }

  private aplicarImportacion(r: PropuestaGlpi): void {
    const idsAplicativos = new Set(this.aplicativos.map((a) => a.id));
    const idsUsuarios = new Set(this.usuarios.map((u) => u.id));
    const p = r.propuesta;
    this.form = this.formVacio();
    this.form.rfc = p.rfc;
    this.form.titulo = p.titulo;
    this.form.entorno = p.entorno;
    this.form.componenteIds = p.componenteIds.filter((id) => idsAplicativos.has(id));
    this.form.fechaHoraProgramada = p.fechaHoraProgramada;
    this.form.fechaHoraEstimadaFin = p.fechaHoraEstimadaFin;
    this.form.descripcion = p.descripcion;
    this.form.equipo = p.equipoIds.filter((id) => idsUsuarios.has(id));
    this.form.checklistNuevo = [...p.checklist];
    this.importacion = r;
    this.pendientesResueltos = new Set<string>();
    this.actualizarPendientes();
    this.recalcularServidores('crear');
    this.nuevoItemChecklistCrear = '';
    this.commitSelectorCrear = estadoSelectorCommitVacio();
    this.mostrarForm = true;
  }

  /** El usuario revisó/modificó un campo marcado como pendiente: deja de resaltarse. */
  confirmarPendiente(campo: string): void {
    if (!this.importacion || this.pendientesResueltos.has(campo)) return;
    this.pendientesResueltos.add(campo);
    this.actualizarPendientes();
  }

  private actualizarPendientes(): void {
    const lista = this.importacion ? this.importacion.pendientes.filter((p) => !this.pendientesResueltos.has(p.campo)) : [];
    this.pendientesVisibles = lista;
    this.camposPendientes = new Set(lista.map((p) => p.campo));
  }

  private limpiarImportacion(): void {
    this.importacion = null;
    this.pendientesResueltos = new Set<string>();
    this.pendientesVisibles = [];
    this.camposPendientes = new Set<string>();
  }

  servidoresNoAsociadosGlpi(): string[] {
    if (!this.importacion) return [];
    return this.importacion.hallazgos.servidores.filter((h) => h.estado !== 'ok').map((h) => h.hostname || h.texto);
  }

  // ---------- Varios servidores / sub-aplicativos por paso ----------
  // Un paso de una app suele hacerse en varios nodos: se eligen uno a uno (o
  // todos los hermanos de golpe) y se muestran como chips. El primero queda
  // como principal en el backend. Las listas derivadas viven en propiedades
  // (no en getters) para no recrear arrays en cada ciclo de detección.
  opcionesServidoresCrear: OpcionSelector[] = [];
  opcionesServidoresEditar: OpcionSelector[] = [];
  hermanosCrear: { nombre: string; cantidad: number }[] = [];
  hermanosEditar: { nombre: string; cantidad: number }[] = [];
  valorSelectorServidorCrear: number | null = null;
  valorSelectorServidorEditar: number | null = null;
  servidoresEditar: number[] = [];
  servidoresEditarOriginal: number[] = [];
  guardandoServidores = false;

  private servidoresDe(contexto: 'crear' | 'editar'): number[] {
    return contexto === 'crear' ? this.form.componenteIds : this.servidoresEditar;
  }

  private recalcularServidores(contexto: 'crear' | 'editar'): void {
    const elegidos = new Set(this.servidoresDe(contexto));
    const disponibles = this.aplicativos.filter((a) => !elegidos.has(a.id));
    const opciones: OpcionSelector[] = disponibles.map((a) => ({ id: a.id, nombre: a.nombre, subtitulo: a.subtitulo }));
    // "Hermanos": otros servidores con el mismo nombre de sub-aplicativo y
    // ambiente que alguno ya elegido (los nodos de una misma app).
    const hermanos = new Map<string, number>();
    for (const id of elegidos) {
      const base = this.aplicativos.find((a) => a.id === id);
      if (!base || hermanos.has(base.nombre)) continue;
      const pendientes = disponibles.filter((a) => a.nombre === base.nombre && a.ambiente === base.ambiente).length;
      if (pendientes) hermanos.set(base.nombre, pendientes);
    }
    const listaHermanos = [...hermanos].map(([nombre, cantidad]) => ({ nombre, cantidad }));
    if (contexto === 'crear') { this.opcionesServidoresCrear = opciones; this.hermanosCrear = listaHermanos; }
    else { this.opcionesServidoresEditar = opciones; this.hermanosEditar = listaHermanos; }
  }

  nombreServidor(id: number): string { return this.aplicativos.find((a) => a.id === id)?.nombre || `#${id}`; }
  hostServidor(id: number): string { return this.aplicativos.find((a) => a.id === id)?.servidorHostname || ''; }

  agregarServidor(contexto: 'crear' | 'editar', id: number | null): void {
    if (id === null || id === undefined) return;
    const lista = this.servidoresDe(contexto);
    if (contexto === 'crear') this.confirmarPendiente('componenteIds');
    if (!lista.includes(id)) {
      if (contexto === 'crear') this.form.componenteIds = [...lista, id];
      else this.servidoresEditar = [...lista, id];
    }
    this.recalcularServidores(contexto);
    // Reinicia el selector para poder elegir otro servidor enseguida.
    if (contexto === 'crear') this.valorSelectorServidorCrear = id; else this.valorSelectorServidorEditar = id;
    setTimeout(() => { if (contexto === 'crear') this.valorSelectorServidorCrear = null; else this.valorSelectorServidorEditar = null; });
  }

  quitarServidor(contexto: 'crear' | 'editar', id: number): void {
    const nueva = this.servidoresDe(contexto).filter((x) => x !== id);
    if (contexto === 'crear') this.confirmarPendiente('componenteIds');
    if (contexto === 'crear') this.form.componenteIds = nueva; else this.servidoresEditar = nueva;
    this.recalcularServidores(contexto);
  }

  agregarHermanos(contexto: 'crear' | 'editar', nombre: string): void {
    const elegidos = new Set(this.servidoresDe(contexto));
    const ambientes = new Set(this.aplicativos.filter((a) => elegidos.has(a.id) && a.nombre === nombre).map((a) => a.ambiente));
    const nuevos = this.aplicativos.filter((a) => a.nombre === nombre && ambientes.has(a.ambiente) && !elegidos.has(a.id)).map((a) => a.id);
    const lista = [...this.servidoresDe(contexto), ...nuevos];
    if (contexto === 'crear') this.confirmarPendiente('componenteIds');
    if (contexto === 'crear') this.form.componenteIds = lista; else this.servidoresEditar = lista;
    this.recalcularServidores(contexto);
  }

  trackHermano(_i: number, h: { nombre: string }): string { return h.nombre; }

  get servidoresEditarCambiaron(): boolean {
    const a = this.servidoresEditar;
    const b = this.servidoresEditarOriginal;
    return a.length !== b.length || a.some((id, i) => id !== b[i]);
  }

  guardarServidores(): void {
    if (!this.pasoSeleccionado || this.guardandoServidores) return;
    this.guardandoServidores = true;
    this.pasoService.actualizar(this.pasoSeleccionado.Id, { componenteIds: this.servidoresEditar }).subscribe({
      next: (actualizado) => {
        this.guardandoServidores = false;
        this.pasoSeleccionado = actualizado;
        this.cargarServidoresEditar(actualizado);
        this.cargar();
      },
      error: (err) => { this.guardandoServidores = false; this.error = err?.error?.error || 'No se pudieron guardar los servidores del registro.'; },
    });
  }

  private cargarServidoresEditar(paso: PasoProduccion): void {
    this.servidoresEditar = (paso.Aplicativos || []).map((a) => a.ComponenteId).filter((id): id is number => typeof id === 'number');
    this.servidoresEditarOriginal = [...this.servidoresEditar];
    this.recalcularServidores('editar');
  }

  // ---------- Checklist armado al crear (ver formVacio) ----------
  nuevoItemChecklistCrear = '';

  agregarItemChecklistCrear(): void {
    const texto = this.nuevoItemChecklistCrear.trim();
    if (!texto) return;
    this.form.checklistNuevo = [...this.form.checklistNuevo, texto];
    this.nuevoItemChecklistCrear = '';
  }

  quitarItemChecklistCrear(indice: number): void {
    this.form.checklistNuevo = this.form.checklistNuevo.filter((_, i) => i !== indice);
  }

  toggleEquipo(usuarioId: number, evento: Event): void {
    this.confirmarPendiente('equipo');
    const marcado = (evento.target as HTMLInputElement).checked;
    if (marcado) {
      if (!this.form.equipo.includes(usuarioId)) this.form.equipo.push(usuarioId);
    } else {
      this.form.equipo = this.form.equipo.filter((id) => id !== usuarioId);
    }
  }

  // ---- Coherencia de fechas: la finalización no puede ser anterior al inicio ----
  // Los valores de los <input datetime-local> son «YYYY-MM-DDTHH:mm»: se comparan como texto.
  /** Crear/editar: la hora estimada de finalización es anterior a la fecha/hora programada. */
  get finEstimadoAnterior(): boolean {
    const i = this.form.fechaHoraProgramada;
    const f = this.form.fechaHoraEstimadaFin;
    return !!i && !!f && String(f).slice(0, 16) < String(i).slice(0, 16);
  }

  /** Inicio programado del paso abierto, en formato de input (tope inferior de la estimada de fin). */
  get inicioPasoSeleccionadoInput(): string {
    return this.pasoSeleccionado?.FechaHoraProgramada ? this.aInputDatetime(new Date(this.pasoSeleccionado.FechaHoraProgramada)) : '';
  }

  /** Detalle: la nueva hora estimada de finalización es anterior al inicio programado del paso. */
  get estimadoFinDetalleAnterior(): boolean {
    const i = this.inicioPasoSeleccionadoInput;
    return !!i && !!this.formEstimadoFin && this.formEstimadoFin.slice(0, 16) < i;
  }

  /** Estado «Ejecutado»: el fin real es anterior al inicio real. */
  get finRealAnterior(): boolean {
    if (this.formEstado.estado !== 'EJECUTADO') return false;
    const i = this.formEstado.fechaHoraInicioReal;
    const f = this.formEstado.fechaHoraFinReal;
    return !!i && !!f && f.slice(0, 16) < i.slice(0, 16);
  }

  guardar(confirmarDuplicado = false): void {
    if (!this.form.titulo.trim() || !this.form.fechaHoraProgramada) return;
    if (this.finEstimadoAnterior) { this.error = 'La hora estimada de finalización no puede ser anterior a la fecha/hora programada.'; return; }
    if (this.form.tipo === 'BUS' && !this.form.servicios.length) { this.error = 'Un paso del BUS necesita al menos un servicio.'; return; }
    this.error = null;
    this.duplicado = null;
    this.guardando = true;
    this.pasoService
      .crear({
        rfc: this.form.rfc.trim() || null,
        titulo: this.form.titulo.trim(),
        entorno: this.form.entorno,
        // Uno o varios sub-aplicativos/servidores (el primero es el principal).
        componenteIds: this.form.componenteIds,
        fechaHoraProgramada: this.form.fechaHoraProgramada.replace('T', ' ') + ':00',
        fechaHoraEstimadaFin: this.form.fechaHoraEstimadaFin ? this.form.fechaHoraEstimadaFin.replace('T', ' ') + ':00' : null,
        descripcion: this.form.descripcion.trim() || null,
        equipo: this.form.equipo,
        googleEventId: this.form.googleEventId,
        commit: this.commitAPayload(this.form.commit, this.form.commitRepoElegido),
        ...(this.bitacoraEstado?.serviciosDisponible ? { tipo: this.form.tipo, servicioIds: this.form.tipo === 'BUS' ? this.form.servicios.map((s) => s.id) : [] } : {}),
        ...(confirmarDuplicado ? { confirmarDuplicado: true } : {}),
      })
      .subscribe({
        next: (creado) => {
          this.refrescoVistas++;
          // El checklist armado antes de crear se sube recién ahora -- el
          // registro no tenía Id hasta este punto. Si no se agregó ningún
          // ítem, no hace falta ninguna llamada extra.
          if (!this.form.checklistNuevo.length) {
            this.guardando = false; this.mostrarForm = false; this.limpiarImportacion(); this.cargar();
            return;
          }
          forkJoin(this.form.checklistNuevo.map((descripcion) => this.pasoService.agregarChecklistItem(creado.Id, descripcion)))
            .subscribe({
              next: () => { this.guardando = false; this.mostrarForm = false; this.limpiarImportacion(); this.cargar(); },
              // El registro ya quedó creado aunque el checklist falle a mitad de
              // camino -- se avisa pero no se bloquea el cierre del modal.
              error: (err) => {
                this.guardando = false; this.mostrarForm = false; this.limpiarImportacion();
                this.error = err?.error?.error || 'El registro se creó, pero no se pudo guardar todo el checklist.';
                this.cargar();
              },
            });
        },
        error: (err) => {
          this.guardando = false;
          // Ya existe un paso igual (mismo RFC y ambiente, o mismo evento): se avisa antes de duplicarlo.
          if (err?.status === 409 && err?.error?.duplicado) { this.duplicado = err.error.duplicado; return; }
          this.error = err?.error?.error || 'No se pudo crear el registro.';
        },
      });
  }

  // ---------- Commit de Azure DevOps asociado ----------
  // Flujo: elegir repo (onCambioRepoCommit) habilita/carga el desplegable de
  // commits de ESE repo; elegir un commit ahí (elegirCommit*) completa la
  // asociación y cambia a la vista de "chip ya elegido".
  private commitAPayload(c: CommitAzure | null, repo: string | null) {
    if (!c) return null;
    return { id: c.id, repo, mensaje: c.comentario, autor: c.autor, fecha: c.fecha, url: c.url };
  }

  // Repos/commits se muestran con <app-selector-buscable> (combobox propio,
  // con su lista dentro del layout) en vez de un <select> nativo -- con
  // decenas de commits el desplegable nativo del sistema operativo se
  // dibuja fuera de cualquier control de la página (ancho/alto propios,
  // puede salirse de la pantalla).
  get opcionesRepos(): OpcionSelector[] {
    return this.reposAzure.map((r) => ({ id: r.nombre, nombre: r.nombre, subtitulo: r.esPorDefecto ? 'repositorio por defecto' : undefined }));
  }

  // Ojo: OpcionSelector.id guarda acá el objeto CommitAzure completo (no un
  // id de texto) -- misma referencia que trae estado.commits, así que
  // app-selector-buscable lo compara por igualdad de referencia (===) contra
  // form.commit/formCommit sin problema, aunque este getter arme un array
  // de opciones nuevo en cada ciclo.
  opcionesCommits(estado: EstadoSelectorCommit): OpcionSelector[] {
    return estado.commits.map((c) => ({ id: c, nombre: `${c.idCorto} — ${c.comentario || '(sin mensaje)'}`, subtitulo: c.autor }));
  }

  onCambioRepoCommit(contexto: 'crear' | 'editar', repo: string | null): void {
    const estado = contexto === 'crear' ? this.commitSelectorCrear : this.commitSelectorEditar;
    estado.repo = repo || '';
    estado.commits = [];
    estado.error = null;
    if (!estado.repo) return;
    estado.cargandoCommits = true;
    this.pasoService.buscarCommits({ repo: estado.repo }).subscribe({
      next: (resp) => { estado.commits = resp.commits; estado.cargandoCommits = false; },
      error: (err) => { estado.error = err?.error?.error || 'No se pudo cargar los commits de ese repositorio.'; estado.cargandoCommits = false; },
    });
  }

  elegirCommitCrear(c: CommitAzure | null): void {
    if (!c) return;
    this.form.commit = c;
    this.form.commitRepoElegido = this.commitSelectorCrear.repo;
  }

  quitarCommitCrear(): void {
    this.form.commit = null;
    this.form.commitRepoElegido = null;
    this.commitSelectorCrear = estadoSelectorCommitVacio();
  }

  elegirCommitEditar(c: CommitAzure | null): void {
    if (!c) return;
    this.formCommit = c;
    this.commitRepoElegidoEditar = this.commitSelectorEditar.repo;
  }

  quitarCommitEditar(): void {
    this.formCommit = null;
    this.commitRepoElegidoEditar = null;
    this.commitSelectorEditar = estadoSelectorCommitVacio();
  }

  guardarCommit(): void {
    if (!this.pasoSeleccionado) return;
    this.guardandoCommit = true;
    this.pasoService
      .actualizar(this.pasoSeleccionado.Id, { commit: this.commitAPayload(this.formCommit, this.commitRepoElegidoEditar) })
      .subscribe({
        next: (actualizado) => {
          this.guardandoCommit = false;
          this.pasoSeleccionado = actualizado;
          this.commitSelectorEditar = estadoSelectorCommitVacio();
          this.cargar();
        },
        error: (err) => { this.guardandoCommit = false; this.error = err?.error?.error || 'No se pudo guardar el commit asociado.'; },
      });
  }

  abrirDetalle(paso: PasoProduccion): void {
    this.pasoSeleccionado = paso;
    this.formEstado = this.formEstadoDesdePaso(paso);
    this.formEstimadoFin = paso.FechaHoraEstimadaFin ? this.aInputDatetime(new Date(paso.FechaHoraEstimadaFin)) : '';
    this.formCommit = paso.CommitId
      ? { id: paso.CommitId, idCorto: paso.CommitId.substring(0, 8), comentario: paso.CommitMensaje || '', autor: paso.CommitAutor || 'Desconocido', fecha: paso.CommitFecha, url: paso.CommitUrl }
      : null;
    this.commitRepoElegidoEditar = paso.CommitRepo;
    this.commitSelectorEditar = estadoSelectorCommitVacio();
    this.cargarServidoresEditar(paso);
    this.serviciosEditar = [...(paso.servicios || [])];
    this.cargarServiciosInventario();

    this.pestanaDetalle = 'detalle';
    this.checklist = []; this.checklistCargado = false;
    this.historial = []; this.historialCargado = false;
  }

  cerrarDetalle(): void {
    this.pasoSeleccionado = null;
    this.glpiPubAbierto = false;
  }

  // ---------- Publicar la documentación del registro en GLPI ----------
  // Arma un seguimiento (checklist marcado, resultado/observaciones, datos de
  // ejecución) + las imágenes elegidas y lo agrega al caso. Escribe en GLPI,
  // así que primero se muestra completo y editable: solo se publica al confirmar.
  glpiPubAbierto = false;
  glpiPubCargando = false;
  glpiPubPublicando = false;
  glpiPubError: string | null = null;
  glpiPubConfigurado = true;
  glpiPubCaso = '';
  // Tipo de respuesta: comentario del caso o solución (cierre). Cada tipo conserva su propio texto editable.
  glpiPubTipo: TipoRespuestaGlpi = 'SEGUIMIENTO';
  private glpiPubTextoSeguimiento = '';
  private glpiPubTextoCierre = '';
  glpiPubConfirmaCierre = false;
  // Estado del caso en GLPI (solo lectura). Si está Resuelto/Cerrado no se permite responder ni cerrar.
  glpiPubEstadoCaso: EstadoCasoGlpi | null = null;
  glpiPubConsultandoEstado = false;
  glpiPubEstadoAviso: string | null = null;
  private glpiPubTemporizadorEstado: ReturnType<typeof setTimeout> | null = null;
  private glpiPubCasoConsultado = '';
  glpiPubEstadoPaso: string | null = null;
  glpiPubChecklistPendientes = 0;
  glpiPubPrivado = true;
  glpiPubArchivos: (ArchivoSeguimientoGlpi & { seleccionado: boolean })[] = [];
  glpiPubYaPublicado: { fecha: string; usuario: string | null; tipo: TipoRespuestaGlpi }[] = [];
  glpiPubResultado: SeguimientoGlpiResultado | null = null;

  get glpiPubTexto(): string {
    return this.glpiPubTipo === 'SOLUCION' ? this.glpiPubTextoCierre : this.glpiPubTextoSeguimiento;
  }
  set glpiPubTexto(valor: string) {
    if (this.glpiPubTipo === 'SOLUCION') this.glpiPubTextoCierre = valor; else this.glpiPubTextoSeguimiento = valor;
  }

  get glpiPubCasoCerrado(): boolean {
    return !!this.glpiPubEstadoCaso?.cerrado;
  }

  /** Al escribir otro número de caso se descarta el estado anterior y se consulta el nuevo. */
  alCambiarCasoGlpi(): void {
    if (this.glpiPubTemporizadorEstado) clearTimeout(this.glpiPubTemporizadorEstado);
    this.glpiPubEstadoCaso = null;
    this.glpiPubEstadoAviso = null;
    this.glpiPubCasoConsultado = '';
    this.glpiPubConsultandoEstado = false;
    if (!/^\d{3,9}$/.test(this.glpiPubCaso.trim())) return;
    this.glpiPubTemporizadorEstado = setTimeout(() => this.consultarEstadoCasoGlpi(), 500);
  }

  consultarEstadoCasoGlpi(): void {
    const caso = this.glpiPubCaso.trim();
    if (!this.glpiPubConfigurado || !/^\d{3,9}$/.test(caso)) return;
    this.glpiPubConsultandoEstado = true;
    this.glpiPubEstadoAviso = null;
    this.glpiPubCasoConsultado = caso;
    this.pasoService.estadoCasoGlpi(caso).subscribe({
      next: (e) => {
        if (this.glpiPubCasoConsultado !== caso) return; // respuesta de un número anterior
        this.glpiPubConsultandoEstado = false;
        this.glpiPubEstadoCaso = e;
        if (e.cerrado) this.glpiPubConfirmaCierre = false;
      },
      error: (err) => {
        if (this.glpiPubCasoConsultado !== caso) return;
        this.glpiPubConsultandoEstado = false;
        this.glpiPubEstadoCaso = null;
        this.glpiPubEstadoAviso = `${err?.error?.error || 'No se pudo consultar el estado del caso en GLPI.'} Se verificará de nuevo al publicar.`;
      },
    });
  }

  elegirTipoGlpi(tipo: TipoRespuestaGlpi): void {
    if (this.glpiPubPublicando || this.glpiPubTipo === tipo) return;
    this.glpiPubTipo = tipo;
    this.glpiPubConfirmaCierre = false;
    this.glpiPubError = null;
  }

  /** Avisos antes de cerrar el caso (no bloquean, el usuario decide). */
  get glpiPubAvisosCierre(): string[] {
    const avisos: string[] = [];
    if (this.glpiPubEstadoPaso && this.glpiPubEstadoPaso !== 'EJECUTADO') {
      avisos.push(`El registro está en estado «${this.estadoLegibleGlpi(this.glpiPubEstadoPaso)}», no «Ejecutado». Normalmente el cierre se publica cuando el cambio ya se ejecutó.`);
    }
    if (this.glpiPubChecklistPendientes > 0) {
      avisos.push(`Hay ${this.glpiPubChecklistPendientes} actividad(es) del checklist sin completar; aparecen como «no completadas» en el texto.`);
    }
    if (!this.glpiPubArchivos.some((a) => a.seleccionado)) {
      avisos.push('No hay evidencias seleccionadas para adjuntar al caso.');
    }
    return avisos;
  }

  private estadoLegibleGlpi(estado: string): string {
    const m: Record<string, string> = { PROGRAMADO: 'Programado', EJECUTADO: 'Ejecutado', CANCELADO: 'Cancelado', REAGENDADO: 'Reagendado', ROLLBACK: 'Rollback' };
    return m[estado] || estado;
  }

  abrirPublicarGlpi(): void {
    if (!this.pasoSeleccionado) return;
    this.glpiPubAbierto = true;
    this.glpiPubCargando = true;
    this.glpiPubPublicando = false;
    this.glpiPubError = null;
    this.glpiPubResultado = null;
    this.glpiPubTextoSeguimiento = '';
    this.glpiPubTextoCierre = '';
    this.glpiPubTipo = 'SEGUIMIENTO';
    this.glpiPubConfirmaCierre = false;
    if (this.glpiPubTemporizadorEstado) clearTimeout(this.glpiPubTemporizadorEstado);
    this.glpiPubEstadoCaso = null;
    this.glpiPubEstadoAviso = null;
    this.glpiPubConsultandoEstado = false;
    this.glpiPubCasoConsultado = '';
    this.glpiPubEstadoPaso = null;
    this.glpiPubChecklistPendientes = 0;
    this.glpiPubArchivos = [];
    this.glpiPubYaPublicado = [];
    this.glpiPubPrivado = true;
    this.glpiPubCaso = '';
    this.pasoService.previsualizarSeguimientoGlpi(this.pasoSeleccionado.Id).subscribe({
      next: (r: SeguimientoGlpiPreview) => {
        this.glpiPubCargando = false;
        this.glpiPubConfigurado = r.configurado;
        this.glpiPubCaso = r.caso;
        this.glpiPubTextoSeguimiento = r.texto;
        this.glpiPubTextoCierre = r.textoCierre;
        this.glpiPubEstadoPaso = r.estadoPaso;
        this.glpiPubChecklistPendientes = r.checklistPendientes;
        this.glpiPubArchivos = r.archivos.map((a) => ({ ...a, seleccionado: a.esImagen }));
        this.glpiPubYaPublicado = r.yaPublicado;
        if (!r.configurado) this.glpiPubError = 'La conexión con GLPI aún no está configurada en el servidor (faltan los tokens de la API).';
        else if (!r.caso) this.glpiPubError = 'El RFC de este registro no tiene número de caso; escríbelo abajo.';
        if (r.configurado && r.caso) this.consultarEstadoCasoGlpi();
      },
      error: (err) => { this.glpiPubCargando = false; this.glpiPubError = err?.error?.error || 'No se pudo preparar el seguimiento.'; },
    });
  }

  cerrarPublicarGlpi(): void {
    if (this.glpiPubPublicando) return;
    if (this.glpiPubTemporizadorEstado) clearTimeout(this.glpiPubTemporizadorEstado);
    this.glpiPubAbierto = false;
  }

  get glpiPubSeleccionados(): number {
    return this.glpiPubArchivos.filter((a) => a.seleccionado).length;
  }

  get glpiPubPuedePublicar(): boolean {
    return !this.glpiPubCargando && !this.glpiPubPublicando && !this.glpiPubResultado && this.glpiPubConfigurado
      && /^\d{3,9}$/.test(this.glpiPubCaso.trim()) && !!this.glpiPubTexto.trim() && this.glpiPubSeleccionados <= 10
      && !this.glpiPubConsultandoEstado && !this.glpiPubCasoCerrado
      && (this.glpiPubTipo !== 'SOLUCION' || this.glpiPubConfirmaCierre);
  }

  tamanoLegible(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  publicarEnGlpi(): void {
    if (!this.pasoSeleccionado || !this.glpiPubPuedePublicar) return;
    const pasoId = this.pasoSeleccionado.Id;
    this.glpiPubPublicando = true;
    this.glpiPubError = null;
    this.pasoService.publicarSeguimientoGlpi(pasoId, {
      caso: this.glpiPubCaso.trim(),
      contenido: this.glpiPubTexto,
      privado: this.glpiPubPrivado,
      adjuntoIds: this.glpiPubArchivos.filter((a) => a.seleccionado).map((a) => a.id),
      tipo: this.glpiPubTipo,
      ...(this.glpiPubTipo === 'SOLUCION' ? { confirmarCierre: this.glpiPubConfirmaCierre } : {}),
    }).subscribe({
      next: (r) => {
        this.glpiPubPublicando = false;
        this.glpiPubResultado = r;
        this.consultarEstadoCasoGlpi();
        // El historial del registro ahora tiene un evento nuevo.
        this.historialCargado = false;
        if (this.pestanaDetalle === 'historial') this.cargarHistorial();
      },
      error: (err) => { this.glpiPubPublicando = false; this.glpiPubError = err?.error?.error || (this.glpiPubTipo === 'SOLUCION' ? 'No se pudo publicar la solución en GLPI. Intenta de nuevo.' : 'No se pudo publicar en GLPI. Intenta de nuevo.'); },
    });
  }

  private formEstadoDesdePaso(paso: PasoProduccion) {
    return {
      estado: paso.Estado,
      motivo: '',
      resultadoEjecucion: paso.ResultadoEjecucion || '',
      fechaHoraInicioReal: paso.FechaHoraInicioReal ? this.aInputDatetime(new Date(paso.FechaHoraInicioReal)) : '',
      fechaHoraFinReal: paso.FechaHoraFinReal ? this.aInputDatetime(new Date(paso.FechaHoraFinReal)) : '',
      nuevaFecha: '',
    };
  }

  /** Reagendar o hacer rollback implica un nuevo despliegue: se exige la nueva fecha y hora. */
  requiereNuevaFecha(): boolean {
    return this.formEstado.estado === 'REAGENDADO' || this.formEstado.estado === 'ROLLBACK';
  }

  /** Falta algo obligatorio para guardar el estado elegido. */
  estadoIncompleto(): boolean {
    return (this.requiereMotivo() && !this.formEstado.motivo.trim()) || (this.requiereNuevaFecha() && !this.formEstado.nuevaFecha) || this.finRealAnterior;
  }

  requiereMotivo(): boolean {
    return ESTADOS_QUE_REQUIEREN_MOTIVO.has(this.formEstado.estado);
  }

  // Al elegir "Ejecutado" se prellenan inicio/fin real con la hora actual
  // (editables después) -- así casi nunca hay que escribirlas a mano, pero
  // se pueden ajustar si la ejecución real empezó/terminó en otro momento.
  onCambioEstadoSeleccionado(): void {
    if (this.requiereNuevaFecha()) return;
    if (this.formEstado.estado !== 'EJECUTADO') return;
    const ahora = this.aInputDatetime(new Date());
    if (!this.formEstado.fechaHoraInicioReal) this.formEstado.fechaHoraInicioReal = ahora;
    if (!this.formEstado.fechaHoraFinReal) this.formEstado.fechaHoraFinReal = ahora;
  }

  private aFechaBackend(valorInput: string): string {
    return valorInput.replace('T', ' ') + ':00';
  }

  guardarEstado(): void {
    if (!this.pasoSeleccionado) return;
    if (this.estadoIncompleto()) return;

    this.guardandoEstado = true;
    const esEjecucion = this.formEstado.estado === 'EJECUTADO';
    this.pasoService
      .cambiarEstado(this.pasoSeleccionado.Id, {
        estado: this.formEstado.estado,
        motivo: this.formEstado.motivo.trim() || undefined,
        resultadoEjecucion: this.formEstado.resultadoEjecucion.trim() || undefined,
        fechaHoraInicioReal: esEjecucion && this.formEstado.fechaHoraInicioReal ? this.aFechaBackend(this.formEstado.fechaHoraInicioReal) : undefined,
        fechaHoraFinReal: esEjecucion && this.formEstado.fechaHoraFinReal ? this.aFechaBackend(this.formEstado.fechaHoraFinReal) : undefined,
        fechaHoraProgramada: this.requiereNuevaFecha() ? this.aFechaBackend(this.formEstado.nuevaFecha) : undefined,
      })
      .subscribe({
        next: (actualizado) => {
          this.guardandoEstado = false;
          this.pasoSeleccionado = actualizado;
          this.formEstado = this.formEstadoDesdePaso(actualizado);
          this.cargar();
        },
        error: (err) => { this.guardandoEstado = false; this.error = err?.error?.error || 'No se pudo actualizar el estado.'; },
      });
  }

  // ---------- Duración programada vs. real ----------
  minutosEntre(desde: string, hasta: string): number {
    return Math.max(0, Math.round((new Date(hasta).getTime() - new Date(desde).getTime()) / 60000));
  }

  formatoDuracion(minutos: number): string {
    if (minutos < 60) return `${minutos} min`;
    const horas = Math.floor(minutos / 60);
    if (horas < 24) return `${horas} h ${minutos % 60} min`;
    const dias = Math.floor(horas / 24);
    return `${dias} d ${horas % 24} h`;
  }

  // null = todavía no hay datos suficientes para comparar.
  estadoCumplimiento(paso: PasoProduccion): 'a-tiempo' | 'tardio' | null {
    if (!paso.FechaHoraFinReal || !paso.FechaHoraEstimadaFin) return null;
    return new Date(paso.FechaHoraFinReal).getTime() <= new Date(paso.FechaHoraEstimadaFin).getTime() ? 'a-tiempo' : 'tardio';
  }

  // ---------- Pestañas ----------
  seleccionarPestana(pestana: 'detalle' | 'checklist' | 'historial'): void {
    this.pestanaDetalle = pestana;
    if (pestana === 'checklist' && !this.checklistCargado) this.cargarChecklist();
    if (pestana === 'historial' && !this.historialCargado) this.cargarHistorial();
  }

  // ---------- Checklist ----------
  cargarChecklist(): void {
    if (!this.pasoSeleccionado) return;
    this.cargandoChecklist = true;
    this.pasoService.listarChecklist(this.pasoSeleccionado.Id).subscribe({
      next: (items) => { this.checklist = items; this.checklistCargado = true; this.cargandoChecklist = false; },
      error: (err) => { this.error = err?.error?.error || 'No se pudo cargar el checklist.'; this.cargandoChecklist = false; },
    });
  }

  progresoChecklist(): { completados: number; total: number } {
    return { completados: this.checklist.filter((i) => i.Completado).length, total: this.checklist.length };
  }

  agregarItemChecklist(): void {
    if (!this.pasoSeleccionado || !this.nuevoItemChecklist.trim()) return;
    this.guardandoItemChecklist = true;
    this.pasoService.agregarChecklistItem(this.pasoSeleccionado.Id, this.nuevoItemChecklist.trim()).subscribe({
      next: (item) => { this.checklist = [...this.checklist, item]; this.nuevoItemChecklist = ''; this.guardandoItemChecklist = false; },
      error: (err) => { this.error = err?.error?.error || 'No se pudo agregar el ítem.'; this.guardandoItemChecklist = false; },
    });
  }

  // Marcar un ítem como completado desde la pestaña Checklist del detalle usa
  // el mismo flujo que el checklist en línea de la vista principal: exige
  // pantallazo de evidencia asociado a ESE ítem (ver toggleItemChecklistInline
  // más abajo), en vez de un simple toggle sin evidencia. Desmarcar sigue
  // siendo un reabrir directo, sin pedir nada.
  toggleItemChecklist(item: ChecklistItem, evento?: Event): void {
    if (!this.pasoSeleccionado) return;
    this.toggleItemChecklistInline(this.pasoSeleccionado, item, evento);
  }

  eliminarItemChecklist(item: ChecklistItem): void {
    if (!this.pasoSeleccionado) return;
    this.pasoService.eliminarChecklistItem(this.pasoSeleccionado.Id, item.Id).subscribe({
      next: () => { this.checklist = this.checklist.filter((i) => i.Id !== item.Id); },
      error: (err) => { this.error = err?.error?.error || 'No se pudo eliminar el ítem.'; },
    });
  }

  // ---------- Checklist "en línea" (vista principal) ----------
  // Marcar: exige al menos una imagen de evidencia -- abre el modal de
  // "pegar evidencia" (Ctrl+V, se pueden juntar varias). Si el ítem YA tiene
  // evidencia guardada (p. ej. se desmarcó y se vuelve a marcar) se marca
  // directo: reabrir nunca borra las imágenes.
  // Desmarcar: no exige nada y conserva todas las evidencias del ítem.
  toggleItemChecklistInline(paso: PasoProduccion, item: ChecklistItem, evento?: Event): void {
    if (!this.editaPaso(paso)) return;
    this.errorEvidencia = null;
    // El checkbox nativo ya cambió al hacer clic; se devuelve a su valor real
    // si todavía no se confirma el cambio (modal abierto o error).
    const checkbox = evento?.target as HTMLInputElement | undefined;
    const restaurar = () => { if (checkbox) checkbox.checked = !!item.Completado; };
    if (item.Completado || this.cantidadEvidencias(item) > 0) {
      this.pasoService.actualizarChecklistItem(paso.Id, item.Id, { completado: !item.Completado }).subscribe({
        next: (actualizado) => this.reemplazarItemInline(paso.Id, actualizado),
        error: (err) => { restaurar(); this.errorEvidencia = err?.error?.error || 'No se pudo actualizar el ítem.'; },
      });
      return;
    }
    restaurar();
    this.pendienteEvidencia = { paso, item, marcar: true, imagenes: [], subiendo: false };
  }

  // Agrega más imágenes a un ítem (marcado o no) sin cambiar su estado.
  abrirAgregarEvidencias(paso: PasoProduccion, item: ChecklistItem, evento: Event): void {
    evento.stopPropagation();
    if (!this.editaPaso(paso)) return;
    this.errorEvidencia = null;
    this.pendienteEvidencia = { paso, item, marcar: false, imagenes: [], subiendo: false };
  }

  cantidadEvidencias(item: ChecklistItem): number {
    return item.Evidencias?.length ?? (item.EvidenciaAdjuntoId ? 1 : 0);
  }

  textoVerEvidencias(item: ChecklistItem): string {
    const n = this.cantidadEvidencias(item);
    return n === 1 ? 'Ver evidencia' : `Ver evidencias (${n})`;
  }

  cancelarEvidenciaPendiente(): void {
    if (this.pendienteEvidencia?.subiendo) return;
    this.pendienteEvidencia?.imagenes.forEach((i) => URL.revokeObjectURL(i.previewUrl));
    this.pendienteEvidencia = null;
    this.errorEvidencia = null;
  }

  quitarImagenPendiente(indice: number): void {
    const pendiente = this.pendienteEvidencia;
    if (!pendiente || pendiente.subiendo) return;
    const [quitada] = pendiente.imagenes.splice(indice, 1);
    if (quitada) URL.revokeObjectURL(quitada.previewUrl);
  }

  // Pega directo desde el portapapeles (p. ej. un pantallazo con Win+Shift+S).
  // Cada pegado SUMA una imagen a la lista; se pueden pegar varias seguidas.
  onPegarEvidencia(evento: ClipboardEvent): void {
    evento.preventDefault();
    if (!this.pendienteEvidencia || this.pendienteEvidencia.subiendo) return;
    const items = evento.clipboardData?.items;
    const archivos: File[] = [];
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const f = items[i].getAsFile();
          if (f) archivos.push(f);
        }
      }
    }
    if (!archivos.length) {
      this.errorEvidencia = 'El portapapeles no tiene una imagen. Copia el pantallazo (p. ej. con Win+Shift+S) y vuelve a pegar acá.';
      return;
    }
    archivos.forEach((a) => this.agregarImagenPendiente(a));
  }

  // Alternativa por si no hay nada copiado: el botón "Selecciona archivos"
  // del modal dispara el input de archivo oculto (admite varios a la vez).
  onEvidenciaSeleccionada(evento: Event): void {
    const input = evento.target as HTMLInputElement;
    const archivos = input.files ? Array.from(input.files) : [];
    input.value = ''; // permite volver a elegir la misma imagen después
    archivos.forEach((a) => this.agregarImagenPendiente(a));
  }

  private extensionDesdeMime(mime: string): string {
    const mapa: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    return mapa[mime] || '';
  }

  private static readonly MAX_IMAGENES_POR_TANDA = 10;

  // Valida y agrega la imagen a la lista de pendientes (todavía no se sube).
  private agregarImagenPendiente(archivo: File): void {
    const pendiente = this.pendienteEvidencia;
    if (!pendiente) return;
    this.errorEvidencia = null;
    const extension = archivo.name.split('.').pop()?.toLowerCase() || this.extensionDesdeMime(archivo.type);
    if (!PasosProduccionListComponent.EXTENSIONES_EVIDENCIA_CHECKLIST.includes(extension)) {
      this.errorEvidencia = `La evidencia debe ser una imagen. Extensiones válidas: ${PasosProduccionListComponent.EXTENSIONES_EVIDENCIA_CHECKLIST.join(', ')}.`;
      return;
    }
    if (archivo.size > PasosProduccionListComponent.TAMANO_MAXIMO_ADJUNTO_BYTES) {
      this.errorEvidencia = `La imagen supera el tamaño máximo permitido (${Math.round(PasosProduccionListComponent.TAMANO_MAXIMO_ADJUNTO_BYTES / (1024 * 1024))} MB).`;
      return;
    }
    if (pendiente.imagenes.length >= PasosProduccionListComponent.MAX_IMAGENES_POR_TANDA) {
      this.errorEvidencia = `Puedes agregar hasta ${PasosProduccionListComponent.MAX_IMAGENES_POR_TANDA} imágenes a la vez; guarda estas y vuelve a agregar más.`;
      return;
    }
    // Un pantallazo pegado casi siempre se llama "image.png": se le pone un nombre propio.
    const nombre = !archivo.name || /^image\.\w+$/i.test(archivo.name)
      ? `pantallazo-${pendiente.imagenes.length + 1}.${extension}`
      : archivo.name;
    pendiente.imagenes.push({ archivo, nombre, previewUrl: URL.createObjectURL(archivo) });
  }

  private leerComoDataUrl(archivo: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onload = () => resolve(lector.result as string);
      lector.onerror = () => reject(new Error('No se pudo leer la imagen seleccionada.'));
      lector.readAsDataURL(archivo);
    });
  }

  // Sube las imágenes de una en una. En modo "marcar", solo la ÚLTIMA marca el
  // ítem como completado (así, si algo falla a mitad, el ítem no queda marcado
  // sin su evidencia completa). Lo ya subido sale de la lista y el modal sigue
  // abierto con el error: nada de lo pegado se pierde.
  async confirmarEvidencias(): Promise<void> {
    const pendiente = this.pendienteEvidencia;
    if (!pendiente || pendiente.subiendo || !pendiente.imagenes.length) return;
    pendiente.subiendo = true;
    this.errorEvidencia = null;
    this.subiendoEvidenciaItemId = pendiente.item.Id;
    const total = pendiente.imagenes.length;
    try {
      for (let i = 0; i < total; i++) {
        const imagen = pendiente.imagenes[0];
        const dataUrl = await this.leerComoDataUrl(imagen.archivo);
        const { item } = await firstValueFrom(
          this.pasoService.completarChecklistItemConEvidencia(pendiente.paso.Id, pendiente.item.Id, {
            nombreOriginal: imagen.nombre,
            mimeType: imagen.archivo.type || 'image/png',
            contenidoBase64: dataUrl,
            completar: pendiente.marcar && i === total - 1,
          })
        );
        this.reemplazarItemInline(pendiente.paso.Id, item);
        pendiente.imagenes.shift();
        URL.revokeObjectURL(imagen.previewUrl);
      }
      this.pendienteEvidencia = null;
    } catch (err: any) {
      this.errorEvidencia = err?.error?.error || err?.message || 'No se pudo guardar la evidencia.';
    } finally {
      pendiente.subiendo = false;
      this.subiendoEvidenciaItemId = null;
    }
  }

  private reemplazarItemInline(pasoId: number, actualizado: ChecklistItem): void {
    const lista = this.checklistPorPaso[pasoId] || [];
    this.checklistPorPaso[pasoId] = lista.map((i) => (i.Id === actualizado.Id ? actualizado : i));
    // Si el ítem actualizado pertenece también al checklist abierto en el
    // modal de detalle, se refleja ahí también para no mostrar dos estados
    // distintos del mismo ítem.
    if (this.pasoSeleccionado?.Id === pasoId && this.checklistCargado) {
      this.checklist = this.checklist.map((i) => (i.Id === actualizado.Id ? actualizado : i));
    }
    // Y en la galería, si está abierta sobre ese mismo ítem.
    if (this.galeria && this.galeria.item.Id === actualizado.Id) this.galeria.item = actualizado;
  }

  // Muestra TODAS las evidencias del ítem en una galería dentro de la misma
  // vista (anterior/siguiente + miniaturas), en vez de abrir pestañas nuevas.
  verEvidenciaChecklist(paso: PasoProduccion, item: ChecklistItem, evento: Event): void {
    evento.stopPropagation();
    const lista = item.Evidencias && item.Evidencias.length
      ? item.Evidencias
      : (item.EvidenciaAdjuntoId ? [{ Id: item.EvidenciaAdjuntoId, NombreOriginal: item.EvidenciaNombre || 'evidencia', TamanoBytes: 0, FechaSubida: '', SubidoPorNombre: null }] : []);
    if (!lista.length) return;
    this.cargandoEvidenciaPreview = true;
    this.errorEvidencia = null;
    this.evidenciaPreviewSub?.unsubscribe();
    this.evidenciaPreviewSub = forkJoin(lista.map((e) => this.pasoService.obtenerAdjunto(paso.Id, e.Id))).subscribe({
      next: (completos) => {
        const imagenes: ImagenGaleria[] = completos.map((completo, i) => {
          const binario = atob(completo.ContenidoBase64);
          const bytes = new Uint8Array(binario.length);
          for (let k = 0; k < binario.length; k++) bytes[k] = binario.charCodeAt(k);
          const blob = new Blob([bytes], { type: completo.MimeType || 'image/png' });
          return { id: completo.Id, nombre: completo.NombreOriginal, url: URL.createObjectURL(blob), fecha: lista[i].FechaSubida || null, autor: lista[i].SubidoPorNombre };
        });
        this.liberarGaleria();
        this.galeria = { paso, item, imagenes, indice: 0 };
        this.cargandoEvidenciaPreview = false;
      },
      error: (err) => { this.errorEvidencia = err?.error?.error || 'No se pudo abrir la evidencia.'; this.cargandoEvidenciaPreview = false; },
    });
  }

  private liberarGaleria(): void {
    this.galeria?.imagenes.forEach((i) => URL.revokeObjectURL(i.url));
  }

  cerrarEvidenciaPreview(): void {
    this.evidenciaPreviewSub?.unsubscribe();
    this.cargandoEvidenciaPreview = false;
    this.liberarGaleria();
    this.galeria = null;
  }

  moverGaleria(delta: number): void {
    if (!this.galeria) return;
    const n = this.galeria.imagenes.length;
    this.galeria.indice = (this.galeria.indice + delta + n) % n;
  }

  irAImagenGaleria(indice: number): void {
    if (this.galeria) this.galeria.indice = indice;
  }

  @HostListener('document:keydown', ['$event'])
  teclaGaleria(evento: KeyboardEvent): void {
    if (!this.galeria) return;
    if (evento.key === 'Escape') this.cerrarEvidenciaPreview();
    else if (evento.key === 'ArrowRight') this.moverGaleria(1);
    else if (evento.key === 'ArrowLeft') this.moverGaleria(-1);
  }

  // Elimina UNA imagen de evidencia (la que se está viendo). Es la única forma
  // de quitar una evidencia: desmarcar el ítem nunca las borra.
  eliminarImagenGaleria(): void {
    const g = this.galeria;
    if (!g || !this.editaPaso(g.paso)) return;
    const imagen = g.imagenes[g.indice];
    if (!imagen || !confirm(`¿Eliminar la imagen "${imagen.nombre}" de la evidencia?`)) return;
    this.pasoService.eliminarAdjunto(g.paso.Id, imagen.id).subscribe({
      next: () => {
        URL.revokeObjectURL(imagen.url);
        g.imagenes.splice(g.indice, 1);
        g.indice = Math.max(0, Math.min(g.indice, g.imagenes.length - 1));
        this.pasoService.listarChecklist(g.paso.Id).subscribe((items) => {
          this.checklistPorPaso[g.paso.Id] = items;
          if (this.pasoSeleccionado?.Id === g.paso.Id && this.checklistCargado) this.checklist = items;
          const actualizado = items.find((i) => i.Id === g.item.Id);
          if (actualizado) g.item = actualizado;
        });
        if (!g.imagenes.length) this.cerrarEvidenciaPreview();
      },
      error: (err) => { this.errorEvidencia = err?.error?.error || 'No se pudo eliminar la imagen.'; },
    });
  }

  // ---------- Historial de cambios ----------
  cargarHistorial(): void {
    if (!this.pasoSeleccionado) return;
    this.cargandoHistorial = true;
    this.pasoService.listarHistorial(this.pasoSeleccionado.Id).subscribe({
      next: (eventos) => { this.historial = eventos; this.historialCargado = true; this.cargandoHistorial = false; },
      error: (err) => { this.error = err?.error?.error || 'No se pudo cargar el historial.'; this.cargandoHistorial = false; },
    });
  }

  etiquetaAccionHistorial(accion: string): string {
    return PasosProduccionListComponent.ETIQUETAS_ACCION_HISTORIAL[accion] || accion;
  }

  resumenEventoHistorial(evento: EventoHistorial): string {
    if (evento.cambios && evento.cambios.length) {
      return evento.cambios.map((c) => `${c.etiqueta}: "${c.anterior ?? '—'}" → "${c.nuevo ?? '—'}"`).join(' · ');
    }
    return evento.Detalle || '';
  }

  guardarEstimadoFin(): void {
    if (!this.pasoSeleccionado) return;
    if (this.estimadoFinDetalleAnterior) { this.error = 'La hora estimada de finalización no puede ser anterior a la fecha/hora programada.'; return; }
    this.guardandoEstimadoFin = true;
    this.pasoService
      .actualizar(this.pasoSeleccionado.Id, {
        fechaHoraEstimadaFin: this.formEstimadoFin ? this.formEstimadoFin.replace('T', ' ') + ':00' : null,
      })
      .subscribe({
        next: (actualizado) => {
          this.guardandoEstimadoFin = false;
          this.pasoSeleccionado = actualizado;
          this.cargar();
        },
        error: (err) => { this.guardandoEstimadoFin = false; this.error = err?.error?.error || 'No se pudo guardar la hora estimada.'; },
      });
  }

  // ---------- Eliminar (lógico / definitivo), restaurar y ocultar ----------

  /** Abre el diálogo de eliminación para un paso (desde su fila). */
  eliminar(paso: PasoProduccion, evento?: Event): void {
    evento?.stopPropagation();
    this.abrirDialogoEliminar([paso]);
  }

  /** Abre el diálogo de eliminación para los pasos seleccionados. */
  eliminarSeleccionados(): void {
    const elegidos = this.pasos.filter((p) => this.seleccionados.has(p.Id));
    if (elegidos.length) this.abrirDialogoEliminar(elegidos);
  }

  private abrirDialogoEliminar(pasos: PasoProduccion[]): void {
    const faltaScript = this.conteos ? !this.conteos.eliminacionLista : false;
    const yaEliminados = pasos.every((p) => !!p.Eliminado);
    const soloDefinitivo = faltaScript || yaEliminados;
    const puedeDefinitivo = pasos.every((p) => this.puedeEliminar(p));
    this.dialogoEliminar = {
      pasos, motivo: '', confirmo: false, procesando: false, error: null,
      modo: soloDefinitivo ? 'definitivo' : 'logico', soloDefinitivo, faltaScript, puedeDefinitivo,
    };
  }

  cerrarDialogoEliminar(): void {
    if (this.dialogoEliminar?.procesando) return;
    this.dialogoEliminar = null;
  }

  puedeConfirmarEliminar(d: DialogoEliminar): boolean {
    if (d.procesando) return false;
    return d.modo === 'logico' ? true : d.puedeDefinitivo && d.confirmo;
  }

  confirmarEliminar(): void {
    const d = this.dialogoEliminar;
    if (!d || !this.puedeConfirmarEliminar(d)) return;
    d.procesando = true;
    d.error = null;
    const ids = d.pasos.map((p) => p.Id);
    const definitivo = d.modo === 'definitivo';

    if (ids.length === 1) {
      const id = ids[0];
      const titulo = d.pasos[0].Titulo;
      const peticion: Observable<unknown> = definitivo ? this.pasoService.eliminar(id) : this.pasoService.eliminarLogico(id, d.motivo.trim());
      peticion.subscribe({
        next: () => {
          this.dialogoEliminar = null;
          this.cerrarDetalle();
          this.avisar(definitivo ? `«${titulo}» se eliminó definitivamente.` : `«${titulo}» se movió a Eliminados. Puedes restaurarlo desde esa pestaña.`);
          this.refrescarTrasAccion();
        },
        error: (err) => { d.procesando = false; d.error = err?.error?.error || 'No se pudo eliminar el registro.'; },
      });
      return;
    }

    this.pasoService.accionMasiva(definitivo ? 'eliminar-definitivo' : 'eliminar', ids, d.motivo.trim()).subscribe({
      next: (r) => {
        this.dialogoEliminar = null;
        this.mostrarResultadoMasivo(r, definitivo ? ['se eliminó definitivamente', 'se eliminaron definitivamente'] : ['se movió a Eliminados', 'se movieron a Eliminados']);
        this.refrescarTrasAccion();
      },
      error: (err) => { d.procesando = false; d.error = err?.error?.error || 'No se pudo completar la eliminación.'; },
    });
  }

  restaurar(paso: PasoProduccion, evento?: Event): void {
    evento?.stopPropagation();
    this.pasoService.restaurar(paso.Id).subscribe({
      next: () => { this.cerrarDetalle(); this.avisar(`«${paso.Titulo}» volvió a la bitácora principal.`); this.refrescarTrasAccion(); },
      error: (err) => this.avisar(err?.error?.error || 'No se pudo restaurar el registro.', true),
    });
  }

  ocultar(paso: PasoProduccion, evento?: Event): void {
    evento?.stopPropagation();
    this.pasoService.ocultar(paso.Id).subscribe({
      next: () => { this.avisar(`«${paso.Titulo}» quedó oculto de tu vista principal (pestaña Ocultos). Los demás lo siguen viendo.`); this.refrescarTrasAccion(); },
      error: (err) => this.avisar(err?.error?.error || 'No se pudo ocultar el registro.', true),
    });
  }

  mostrar(paso: PasoProduccion, evento?: Event): void {
    evento?.stopPropagation();
    this.pasoService.mostrar(paso.Id).subscribe({
      next: () => { this.avisar(`«${paso.Titulo}» volvió a tu vista principal.`); this.refrescarTrasAccion(); },
      error: (err) => this.avisar(err?.error?.error || 'No se pudo mostrar el registro.', true),
    });
  }

  private refrescarTrasAccion(): void {
    this.refrescoVistas++;
    this.cargar();
  }

  // ---------- Selección múltiple ----------
  alternarModoSeleccion(): void {
    this.modoSeleccion = !this.modoSeleccion;
    if (!this.modoSeleccion) this.limpiarSeleccion();
  }

  alternarSeleccion(p: PasoProduccion, evento?: Event): void {
    evento?.stopPropagation();
    if (this.seleccionados.has(p.Id)) this.seleccionados.delete(p.Id);
    else this.seleccionados.add(p.Id);
  }

  estaSeleccionado(p: PasoProduccion): boolean {
    return this.seleccionados.has(p.Id);
  }

  limpiarSeleccion(): void {
    this.seleccionados.clear();
  }

  todosSeleccionados(): boolean {
    const lista = this.pasosFiltrados();
    return lista.length > 0 && lista.every((p) => this.seleccionados.has(p.Id));
  }

  alternarTodos(): void {
    if (this.todosSeleccionados()) this.limpiarSeleccion();
    else this.pasosFiltrados().forEach((p) => this.seleccionados.add(p.Id));
  }

  /** Clic en la fila: en modo selección marca/desmarca; si no, abre el detalle. */
  clicFila(p: PasoProduccion): void {
    if (this.modoSeleccion) this.alternarSeleccion(p);
    else this.abrirDetalle(p);
  }

  /** Acción masiva simple (sin diálogo): ocultar, mostrar o restaurar los seleccionados. */
  accionSeleccionados(accion: Extract<AccionMasivaPasos, 'ocultar' | 'mostrar' | 'restaurar'>): void {
    const ids = [...this.seleccionados];
    if (!ids.length || this.trabajandoMasivo) return;
    this.trabajandoMasivo = true;
    const verbo: [string, string] = {
      ocultar: ['quedó oculto de tu vista principal', 'quedaron ocultos de tu vista principal'] as [string, string],
      mostrar: ['volvió a tu vista principal', 'volvieron a tu vista principal'] as [string, string],
      restaurar: ['se restauró', 'se restauraron'] as [string, string],
    }[accion];
    this.pasoService.accionMasiva(accion, ids).subscribe({
      next: (r) => { this.trabajandoMasivo = false; this.mostrarResultadoMasivo(r, verbo); this.refrescarTrasAccion(); },
      error: (err) => { this.trabajandoMasivo = false; this.avisar(err?.error?.error || 'No se pudo completar la acción.', true); },
    });
  }

  private mostrarResultadoMasivo(r: ResultadoMasivoPasos, verbos: [string, string]): void {
    this.limpiarSeleccion();
    const n = r.procesados;
    const texto = n
      ? `${n} registro${n === 1 ? '' : 's'}: ${n === 1 ? verbos[0] : verbos[1]}.${r.omitidos.length ? ` ${r.omitidos.length} no se pudo${r.omitidos.length === 1 ? '' : 'ieron'} procesar:` : ''}`
      : 'No se pudo procesar ningún registro:';
    this.avisar(texto, n === 0 && r.omitidos.length > 0, r.omitidos);
  }

  /** Mensaje de resultado (se oculta solo a los 8 s, salvo que traiga omitidos). */
  private avisar(texto: string, error = false, omitidos: { id: number; titulo: string | null; motivo: string }[] = []): void {
    clearTimeout(this.resultadoTimer);
    this.resultadoAccion = { texto, error, omitidos };
    if (!omitidos.length) this.resultadoTimer = setTimeout(() => (this.resultadoAccion = null), 8000);
  }

  cerrarResultado(): void {
    clearTimeout(this.resultadoTimer);
    this.resultadoAccion = null;
  }

  nombresDialogo(d: DialogoEliminar): string {
    const t = d.pasos.slice(0, 4).map((p) => `«${p.Titulo}»`).join(', ');
    return d.pasos.length > 4 ? `${t} y ${d.pasos.length - 4} más` : t;
  }

  etiquetaEstado(estado: string): string {
    const mapa: Record<string, string> = {
      PROGRAMADO: 'Programado', EJECUTADO: 'Ejecutado', CANCELADO: 'Cancelado', REAGENDADO: 'Reagendado', ROLLBACK: 'Rollback',
    };
    return mapa[estado] || estado;
  }
}
