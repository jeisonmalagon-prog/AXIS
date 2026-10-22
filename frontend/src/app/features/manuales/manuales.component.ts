import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeHtml, SafeResourceUrl } from '@angular/platform-browser';
import { Subject, Subscription, catchError, debounceTime, distinctUntilChanged, firstValueFrom, of, switchMap, tap } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../services/auth.service';
import {
  ManualComparticion, ManualConflicto, ManualLibreta, ManualPagina, ManualPaginaMeta, ManualResultadoBusqueda, ManualSeccion, ManualSolicitudPendiente, ManualesService,
} from '../../core/services/manuales.service';
import { UsuarioBasico } from '../../core/services/usuario-basico.service';
import { ManualEditorComponent } from './manual-editor.component';
import { ManualHistorialComponent } from './manual-historial.component';
import { ImportacionTerminada, ManualImportarComponent } from './manual-importar.component';
import {
  PaginaImprimible, descargarBlob, fechaCorta, fechaLarga, imprimirPaginas, mensajeDeError, nombreSeguro, tamanoLegible,
} from './manuales-util';

type EstadoGuardado = 'limpio' | 'pendiente' | 'guardando' | 'guardado' | 'error';
type Menu = '' | 'libreta' | 'seccion' | 'exportar' | 'mas';
type Dlg = '' | 'libreta' | 'seccion' | 'mover' | 'eliminar' | 'compartir';

interface ResultadoVista { r: ManualResultadoBusqueda; partes: { t: string; hit: boolean }[]; }

const COLORES_SECCION = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#ca8a04', '#475569'];

@Component({
  selector: 'app-manuales',
  standalone: true,
  imports: [CommonModule, FormsModule, ManualEditorComponent, ManualHistorialComponent, ManualImportarComponent],
  templateUrl: './manuales.component.html',
  styleUrl: './manuales.component.scss',
})
export class ManualesComponent implements OnInit, OnDestroy {
  @ViewChild('lectura') lectura?: ElementRef<HTMLElement>;
  @ViewChild('campoTitulo') campoTitulo?: ElementRef<HTMLInputElement>;
  @ViewChild('campoBusqueda') campoBusqueda?: ElementRef<HTMLInputElement>;

  /** Permiso por rol en el módulo (Consulta no edita). */
  puedeEditarRol = false;
  /** Rol de edición Y no ser un manual compartido solo para lectura. */
  get puedeEditar(): boolean { return this.puedeEditarRol && this.libreta?.miNivel !== 'LECTURA'; }
  /** El manual es mío (lo creé): puedo compartirlo, cambiarle el nombre y eliminarlo. */
  get esMia(): boolean { return this.libreta?.miNivel === 'PROPIETARIO'; }
  /** Me lo compartieron otras personas y yo lo acepté. */
  get esCompartidaConmigo(): boolean { return !!this.libreta && this.libreta.miNivel !== 'PROPIETARIO' && !!this.libreta.propietario; }

  // Solicitudes que esperan mi respuesta + diálogo de compartir
  solicitudes: ManualSolicitudPendiente[] = [];
  respondiendoSolicitud: number | null = null;
  comparticiones: ManualComparticion[] = [];
  candidatos: UsuarioBasico[] = [];
  cargandoCmp = false;
  cmpUsuarioId: number | null = null;
  cmpPermiso: 'LECTURA' | 'EDICION' = 'LECTURA';
  private usuariosBasico: UsuarioBasico[] = [];
  private readonly alCambiarManuales = (): void => { this.cargarSolicitudes(); void this.refrescarArbol(); };
  readonly colores = COLORES_SECCION;
  readonly corta = fechaCorta;
  readonly larga = fechaLarga;
  readonly tamano = tamanoLegible;

  // Árbol
  cargandoArbol = true;
  errorArbol = '';
  libretas: ManualLibreta[] = [];
  libretaId: number | null = null;
  seccionId: number | null = null;

  // Páginas
  paginas: ManualPaginaMeta[] = [];
  cargandoPaginas = false;
  pagina: ManualPagina | null = null;
  cargandoPagina = false;
  errorPagina = '';
  htmlLectura: SafeHtml = '';
  pdfUrl: SafeResourceUrl | null = null;
  private pdfObjectUrl: string | null = null;

  // Edición
  editando = false;
  claveEditor = 0;
  editorEnfocar = true;
  tituloEdicion = '';
  htmlEdicion: string | null = null;
  estadoGuardado: EstadoGuardado = 'limpio';
  errorGuardado = '';
  conflicto: ManualConflicto | null = null;
  private guardando = false;
  private reguardar = false;
  private abrirEnEdicion = false;
  private autoguardado$ = new Subject<void>();

  // Búsqueda
  q = '';
  resultados: ResultadoVista[] | null = null;
  buscando = false;
  errorBusqueda = '';
  soloLibreta = false;
  private busqueda$ = new Subject<string>();

  // Interfaz
  vistaMovil: 'lista' | 'pagina' = 'lista';
  menu: Menu = '';
  mostrarImportar = false;
  mostrarHistorial = false;
  imagenAmpliada: string | null = null;
  aviso = '';
  avisoError = false;
  exportando = '';
  arrastrando: number | null = null;
  private avisoTimer: ReturnType<typeof setTimeout> | null = null;

  // Cuadros de diálogo (nombres, mover, confirmar eliminación)
  dlg: Dlg = '';
  dlgId: number | null = null;
  dlgNombre = '';
  dlgDescripcion = '';
  dlgColor = COLORES_SECCION[0];
  dlgDestino: number | null = null;
  dlgQue: 'libreta' | 'seccion' | 'pagina' = 'pagina';
  dlgError = '';
  dlgOcupado = false;

  private subs = new Subscription();

  constructor(
    private servicio: ManualesService,
    private auth: AuthService,
    private ruta: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private anfitrion: ElementRef<HTMLElement>,
  ) {}

  // ================== ciclo de vida ==================

  ngOnInit(): void {
    this.puedeEditarRol = this.auth.puedeEditar('MANUALES');
    this.cargarSolicitudes();
    window.addEventListener('axis:manuales', this.alCambiarManuales);

    this.subs.add(this.autoguardado$.pipe(debounceTime(1500)).subscribe(() => void this.guardarAhora()));
    this.subs.add(
      this.busqueda$.pipe(
        debounceTime(300),
        distinctUntilChanged(),
        tap((t) => { this.buscando = t.trim().length >= 2; this.errorBusqueda = ''; }),
        switchMap((t) => {
          if (t.trim().length < 2) return of(null);
          return this.servicio.buscar(t, this.soloLibreta ? this.libretaId : null).pipe(
            catchError((e: HttpErrorResponse) => { void mensajeDeError(e, 'No se pudo buscar.').then((m) => (this.errorBusqueda = m)); return of(null); }),
          );
        }),
      ).subscribe((res) => {
        this.buscando = false;
        this.resultados = res ? res.map((r) => ({ r, partes: this.resaltar(r.fragmento || r.titulo) })) : this.q.trim().length >= 2 && this.errorBusqueda ? [] : null;
      }),
    );

    this.cargarArbol(() => {
      this.subs.add(this.ruta.paramMap.subscribe((p) => {
        const id = Number(p.get('paginaId'));
        void this.alCambiarRuta(id > 0 ? id : null);
      }));
    });
  }

  ngOnDestroy(): void {
    // Mejor esfuerzo: si se sale de la pantalla con cambios sin guardar, se envían una última vez.
    if (this.editando && this.pagina && this.estadoGuardado === 'pendiente' && !this.conflicto) {
      this.servicio.guardarPagina(this.pagina.id, this.cargaGuardado()).subscribe({ error: () => undefined });
    }
    window.removeEventListener('axis:manuales', this.alCambiarManuales);
    this.liberarPdf();
    if (this.avisoTimer) clearTimeout(this.avisoTimer);
    this.subs.unsubscribe();
  }

  @HostListener('window:beforeunload', ['$event'])
  alCerrarVentana(e: BeforeUnloadEvent): void {
    if (this.editando && (this.estadoGuardado === 'pendiente' || this.estadoGuardado === 'guardando' || this.estadoGuardado === 'error')) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  @HostListener('document:keydown', ['$event'])
  alTeclear(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && this.editando) {
      e.preventDefault();
      void this.guardarAhora();
    } else if (e.key === 'Escape') {
      if (this.imagenAmpliada) this.imagenAmpliada = null;
      else if (this.dlg && !this.dlgOcupado) this.dlg = '';
      else if (this.menu) this.menu = '';
    } else if (e.key === '/' && !this.editando && !this.dlg && !this.mostrarImportar && !this.mostrarHistorial) {
      const t = e.target as HTMLElement | null;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      if (t?.isContentEditable) return;
      e.preventDefault();
      this.campoBusqueda?.nativeElement.focus();
    }
  }

  @HostListener('document:click', ['$event'])
  alClicFuera(e: MouseEvent): void {
    if (!this.menu) return;
    const t = e.target as HTMLElement;
    if (!t.closest('.menu-wrap')) this.menu = '';
  }

  // ================== utilidades ==================

  private angosto(): boolean {
    return this.anfitrion.nativeElement.offsetWidth < 900;
  }

  mostrarAviso(texto: string, error = false): void {
    this.aviso = texto;
    this.avisoError = error;
    if (this.avisoTimer) clearTimeout(this.avisoTimer);
    this.avisoTimer = setTimeout(() => (this.aviso = ''), error ? 7000 : 3500);
  }

  private async error(e: unknown, porDefecto: string): Promise<void> {
    this.mostrarAviso(await mensajeDeError(e, porDefecto), true);
  }

  get libreta(): ManualLibreta | null {
    return this.libretas.find((l) => l.id === this.libretaId) ?? null;
  }

  get seccion(): ManualSeccion | null {
    return this.libreta?.secciones.find((s) => s.id === this.seccionId) ?? null;
  }

  private llaveLibreta(): string {
    return `axis.manuales.libreta.${this.auth.obtenerDatosUsuario()?.username ?? ''}`;
  }

  private resaltar(texto: string): { t: string; hit: boolean }[] {
    const fichas = this.q.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2);
    if (!fichas.length) return [{ t: texto, hit: false }];
    const re = new RegExp(`(${fichas.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return texto.split(re).map((t, i) => ({ t, hit: i % 2 === 1 })).filter((x) => x.t !== '');
  }

  // ================== árbol ==================

  private cargarArbol(despues?: () => void, mantener = true): void {
    this.servicio.arbol().subscribe({
      next: (arbol) => {
        this.libretas = arbol;
        this.cargandoArbol = false;
        this.errorArbol = '';
        if (!mantener || !this.libreta) {
          let guardada: number | null = null;
          try { guardada = Number(localStorage.getItem(this.llaveLibreta())) || null; } catch { guardada = null; }
          this.libretaId = arbol.find((l) => l.id === guardada)?.id ?? arbol[0]?.id ?? null;
          this.seccionId = this.libreta?.secciones[0]?.id ?? null;
        } else if (!this.seccion) {
          this.seccionId = this.libreta?.secciones[0]?.id ?? null;
        }
        despues?.();
      },
      error: async (e) => {
        this.cargandoArbol = false;
        this.errorArbol = await mensajeDeError(e, 'No se pudieron cargar los manuales.');
      },
    });
  }

  private async refrescarArbol(): Promise<void> {
    try { this.libretas = await firstValueFrom(this.servicio.arbol()); } catch { /* se conserva el árbol actual */ }
  }

  async elegirLibreta(id: number): Promise<void> {
    if (id === this.libretaId || !(await this.asegurarGuardado())) return;
    this.libretaId = id;
    try { localStorage.setItem(this.llaveLibreta(), String(id)); } catch { /* sin almacenamiento */ }
    const primera = this.libreta?.secciones[0]?.id ?? null;
    this.menu = '';
    if (this.soloLibreta && this.q.trim().length >= 2) this.busqueda$.next(this.q + ' ');
    await this.elegirSeccion(primera);
  }

  async elegirSeccion(id: number | null, abrirPrimera = true): Promise<void> {
    if (id !== this.seccionId && !(await this.asegurarGuardado())) return;
    this.seccionId = id;
    this.menu = '';
    this.pagina = null;
    this.liberarPdf();
    this.vistaMovil = 'lista';
    this.paginas = [];
    if (id === null) { void this.router.navigate(['/manuales']); return; }
    await this.cargarPaginas(id);
    if (abrirPrimera && !this.angosto() && this.paginas.length) void this.router.navigate(['/manuales', this.paginas[0].id]);
    else void this.router.navigate(['/manuales']);
  }

  private async cargarPaginas(seccionId: number): Promise<void> {
    this.cargandoPaginas = true;
    try {
      const lista = await firstValueFrom(this.servicio.paginasDeSeccion(seccionId));
      if (this.seccionId === seccionId) this.paginas = lista;
    } catch (e) {
      await this.error(e, 'No se pudieron cargar las páginas.');
    } finally {
      this.cargandoPaginas = false;
    }
  }

  // ================== páginas ==================

  private async alCambiarRuta(id: number | null): Promise<void> {
    if (id === null) {
      if (!this.pagina && this.seccionId !== null && !this.paginas.length) {
        await this.cargarPaginas(this.seccionId);
        if (!this.angosto() && this.paginas.length) void this.router.navigate(['/manuales', this.paginas[0].id], { replaceUrl: true });
      }
      return;
    }
    if (this.pagina?.id === id) return;
    await this.cargarPagina(id);
  }

  private liberarPdf(): void {
    if (this.pdfObjectUrl) URL.revokeObjectURL(this.pdfObjectUrl);
    this.pdfObjectUrl = null;
    this.pdfUrl = null;
  }

  private async cargarPagina(id: number): Promise<void> {
    this.cargandoPagina = true;
    this.errorPagina = '';
    this.editando = false;
    this.conflicto = null;
    this.estadoGuardado = 'limpio';
    this.liberarPdf();
    try {
      const p = await firstValueFrom(this.servicio.pagina(id));
      this.pagina = p;
      this.tituloEdicion = p.titulo;
      this.htmlEdicion = null;
      this.htmlLectura = this.sanitizer.bypassSecurityTrustHtml(p.html);
      this.vistaMovil = 'pagina';
      if (this.libretaId !== p.libretaId) {
        this.libretaId = p.libretaId;
        try { localStorage.setItem(this.llaveLibreta(), String(p.libretaId)); } catch { /* sin almacenamiento */ }
      }
      if (this.seccionId !== p.seccionId || !this.paginas.length) {
        this.seccionId = p.seccionId;
        await this.cargarPaginas(p.seccionId);
      }
      if (p.tipo === 'PDF') await this.cargarPdf(p);
      if (this.abrirEnEdicion) { this.abrirEnEdicion = false; this.editarPagina(true); }
      setTimeout(() => this.prepararLectura(), 0);
    } catch (e) {
      this.pagina = null;
      this.errorPagina = await mensajeDeError(e, 'No se pudo abrir la página.');
    } finally {
      this.cargandoPagina = false;
    }
  }

  private async cargarPdf(p: ManualPagina): Promise<void> {
    try {
      const blob = await firstValueFrom(this.servicio.archivoPdf(p.id));
      this.pdfObjectUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      this.pdfUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.pdfObjectUrl);
    } catch (e) {
      await this.error(e, 'No se pudo cargar el PDF.');
    }
  }

  async abrirPagina(p: ManualPaginaMeta): Promise<void> {
    if (this.pagina?.id === p.id) { this.vistaMovil = 'pagina'; return; }
    if (!(await this.asegurarGuardado())) return;
    void this.router.navigate(['/manuales', p.id]);
  }

  volverALista(): void {
    this.vistaMovil = 'lista';
  }

  async nuevaPagina(): Promise<void> {
    if (!this.seccionId || !(await this.asegurarGuardado())) return;
    try {
      const creada = await firstValueFrom(this.servicio.crearPagina(this.seccionId, 'Página sin título'));
      await this.refrescarArbol();
      await this.cargarPaginas(this.seccionId);
      this.abrirEnEdicion = true;
      void this.router.navigate(['/manuales', creada.id]);
    } catch (e) {
      await this.error(e, 'No se pudo crear la página.');
    }
  }

  // ---------- lectura: botón copiar y ampliar imágenes ----------

  private prepararLectura(): void {
    const raiz = this.lectura?.nativeElement;
    if (!raiz) return;
    raiz.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.man-copiar')) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'man-copiar';
      b.textContent = 'Copiar';
      b.setAttribute('aria-label', 'Copiar el comando');
      pre.appendChild(b);
    });
  }

  alClicLectura(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.classList.contains('man-copiar')) {
      const pre = t.closest('pre');
      const texto = pre?.querySelector('code')?.textContent ?? (pre ? Array.from(pre.childNodes).filter((n) => n !== t).map((n) => n.textContent).join('') : '');
      void this.copiar(texto ?? '').then((ok) => {
        t.textContent = ok ? 'Copiado' : 'No se pudo';
        t.classList.toggle('hecho', ok);
        setTimeout(() => { t.textContent = 'Copiar'; t.classList.remove('hecho'); }, 1600);
      });
    } else if (t.tagName === 'IMG') {
      this.imagenAmpliada = (t as HTMLImageElement).src;
    }
  }

  private async copiar(texto: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = texto;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
  }

  async copiarEnlace(): Promise<void> {
    const ok = await this.copiar(window.location.href);
    this.mostrarAviso(ok ? 'Enlace copiado. Solo lo podrá abrir quien tenga acceso a este manual (su dueño o con quien lo comparta).' : 'No se pudo copiar el enlace.', !ok);
  }

  // ================== edición y guardado ==================

  editarPagina(esNueva = false): void {
    if (!this.pagina || !this.puedeEditar) return;
    this.tituloEdicion = this.pagina.titulo;
    this.htmlEdicion = null;
    this.claveEditor += 1;
    this.editorEnfocar = !esNueva;
    this.editando = true;
    this.estadoGuardado = 'limpio';
    this.menu = '';
    setTimeout(() => {
      const c = this.campoTitulo?.nativeElement;
      if (c && esNueva) { c.focus(); c.select(); }
    }, 60);
  }

  alCambiarContenido(html: string): void {
    this.htmlEdicion = html;
    this.marcarPendiente();
  }

  alCambiarTitulo(): void {
    this.marcarPendiente();
  }

  private marcarPendiente(): void {
    if (!this.editando) return;
    this.estadoGuardado = 'pendiente';
    this.errorGuardado = '';
    if (!this.conflicto) this.autoguardado$.next();
  }

  private cargaGuardado(forzar = false): { titulo: string; html?: string; version: number; forzar?: boolean } {
    const carga: { titulo: string; html?: string; version: number; forzar?: boolean } = {
      titulo: this.tituloEdicion.trim() || 'Página sin título',
      version: this.pagina?.version ?? 0,
    };
    if (this.htmlEdicion !== null) carga.html = this.htmlEdicion;
    if (forzar) carga.forzar = true;
    return carga;
  }

  async guardarAhora(forzar = false): Promise<boolean> {
    const p = this.pagina;
    if (!p || !this.editando) return true;
    if (this.estadoGuardado !== 'pendiente' && this.estadoGuardado !== 'error' && !forzar) return true;
    if (this.conflicto && !forzar) return false;
    if (this.guardando) { this.reguardar = true; return true; }
    this.guardando = true;
    this.estadoGuardado = 'guardando';
    const carga = this.cargaGuardado(forzar);
    try {
      const r = await firstValueFrom(this.servicio.guardarPagina(p.id, carga));
      p.version = r.version;
      p.titulo = carga.titulo;
      p.actualizadoPor = r.actualizadoPor;
      p.fechaActualizacion = r.fechaActualizacion;
      const meta = this.paginas.find((x) => x.id === p.id);
      if (meta) { meta.titulo = carga.titulo; meta.version = r.version; meta.actualizadoPor = r.actualizadoPor; meta.fechaActualizacion = r.fechaActualizacion; }
      this.conflicto = null;
      this.errorGuardado = '';
      this.estadoGuardado = this.reguardar ? 'pendiente' : 'guardado';
      return true;
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 409 && e.error?.conflicto) {
        this.conflicto = e.error as ManualConflicto;
        this.estadoGuardado = 'error';
        this.errorGuardado = this.conflicto.error;
      } else {
        this.estadoGuardado = 'error';
        this.errorGuardado = await mensajeDeError(e, 'No se pudo guardar.');
      }
      return false;
    } finally {
      this.guardando = false;
      if (this.reguardar) { this.reguardar = false; if (!this.conflicto) void this.guardarAhora(); }
    }
  }

  /** Antes de cambiar de página/sección se guarda lo pendiente; si no se puede, se queda en la página actual. */
  private async asegurarGuardado(): Promise<boolean> {
    if (!this.editando) return true;
    if (this.estadoGuardado === 'pendiente' || this.estadoGuardado === 'error') {
      const ok = await this.guardarAhora();
      if (!ok) {
        this.mostrarAviso('Hay cambios sin guardar en esta página. Resuelve el aviso de guardado antes de salir.', true);
        return false;
      }
    }
    while (this.guardando) await new Promise((r) => setTimeout(r, 80));
    return this.estadoGuardado !== 'error';
  }

  async terminarEdicion(): Promise<void> {
    if (!this.pagina) return;
    if (!(await this.asegurarGuardado())) return;
    const id = this.pagina.id;
    await this.cargarPagina(id);
    await this.cargarPaginas(this.pagina?.seccionId ?? this.seccionId ?? 0);
  }

  guardarLosMios(): void {
    void this.guardarAhora(true);
  }

  async descartarMisCambios(): Promise<void> {
    if (!this.pagina) return;
    this.conflicto = null;
    this.estadoGuardado = 'limpio';
    await this.cargarPagina(this.pagina.id);
    this.mostrarAviso('Se cargó la versión más reciente de la página.');
  }

  reintentarGuardado(): void {
    void this.guardarAhora();
  }

  get textoGuardado(): string {
    switch (this.estadoGuardado) {
      case 'pendiente': return 'Cambios sin guardar…';
      case 'guardando': return 'Guardando…';
      case 'guardado': return 'Guardado';
      case 'error': return this.conflicto ? 'Conflicto de edición' : 'No se pudo guardar';
      default: return 'Se guarda automáticamente';
    }
  }

  avisoEditor(texto: string): void {
    this.mostrarAviso(texto, true);
  }

  // ================== historial ==================

  abrirHistorial(): void {
    this.menu = '';
    this.mostrarHistorial = true;
  }

  async alRestaurar(): Promise<void> {
    this.mostrarHistorial = false;
    if (!this.pagina) return;
    this.mostrarAviso('Versión restaurada.');
    await this.cargarPagina(this.pagina.id);
  }

  // ================== exportar ==================

  async exportarPdf(): Promise<void> {
    const p = this.pagina;
    if (!p) return;
    this.menu = '';
    if (p.tipo === 'PDF') {
      try { descargarBlob(await firstValueFrom(this.servicio.archivoPdf(p.id)), p.archivoNombre || nombreSeguro(p.titulo, 'pdf')); } catch (e) { await this.error(e, 'No se pudo descargar el PDF.'); }
      return;
    }
    if (this.editando && !(await this.asegurarGuardado())) return;
    imprimirPaginas(p.titulo, [{ titulo: p.titulo, html: this.htmlSeguro(p), fecha: p.fechaOrigen }]);
    this.mostrarAviso('Se abrió la ventana de impresión: elige «Guardar como PDF» como destino.');
  }

  private htmlSeguro(p: ManualPagina): string {
    return p.html;
  }

  async exportarWord(): Promise<void> {
    const p = this.pagina;
    if (!p || p.tipo !== 'RICO') return;
    this.menu = '';
    if (this.editando && !(await this.asegurarGuardado())) return;
    this.exportando = 'Preparando el documento Word…';
    try {
      descargarBlob(await firstValueFrom(this.servicio.exportarPaginaDocx(p.id)), nombreSeguro(p.titulo, 'docx'));
    } catch (e) {
      await this.error(e, 'No se pudo exportar a Word.');
    } finally {
      this.exportando = '';
    }
  }

  async exportarSeccionWord(): Promise<void> {
    const s = this.seccion;
    if (!s) return;
    this.menu = '';
    this.exportando = `Preparando «${s.nombre}» en Word…`;
    try {
      descargarBlob(await firstValueFrom(this.servicio.exportarSeccionDocx(s.id)), nombreSeguro(s.nombre, 'docx'));
    } catch (e) {
      await this.error(e, 'No se pudo exportar la sección a Word.');
    } finally {
      this.exportando = '';
    }
  }

  async exportarSeccionPdf(): Promise<void> {
    const s = this.seccion;
    if (!s) return;
    this.menu = '';
    const textos = this.paginas.filter((p) => p.tipo === 'RICO');
    if (!textos.length) { this.mostrarAviso('Esta sección no tiene páginas de texto para exportar.', true); return; }
    const lista: PaginaImprimible[] = [];
    try {
      for (let i = 0; i < textos.length; i += 1) {
        this.exportando = `Preparando el PDF… página ${i + 1} de ${textos.length}`;
        const p = await firstValueFrom(this.servicio.pagina(textos[i].id));
        lista.push({ titulo: p.titulo, html: p.html, fecha: p.fechaOrigen });
      }
      imprimirPaginas(s.nombre, lista);
      this.mostrarAviso('Se abrió la ventana de impresión: elige «Guardar como PDF» como destino.');
    } catch (e) {
      await this.error(e, 'No se pudo preparar el PDF.');
    } finally {
      this.exportando = '';
    }
  }

  // ================== búsqueda ==================

  alEscribirBusqueda(): void {
    if (this.q.trim().length < 2) { this.resultados = null; this.buscando = false; }
    this.busqueda$.next(this.q);
  }

  alCambiarAlcance(): void {
    this.busqueda$.next(this.q + ' ');
    setTimeout(() => this.busqueda$.next(this.q), 0);
  }

  limpiarBusqueda(): void {
    this.q = '';
    this.resultados = null;
    this.busqueda$.next('');
  }

  async abrirResultado(r: ManualResultadoBusqueda): Promise<void> {
    if (!(await this.asegurarGuardado())) return;
    void this.router.navigate(['/manuales', r.id]);
  }

  // ================== diálogos ==================

  private abrirDlg(d: Dlg): void {
    this.dlg = d;
    this.dlgError = '';
    this.dlgOcupado = false;
    this.menu = '';
  }

  // ================== compartir (la otra persona debe aceptar) ==================

  private cargarSolicitudes(): void {
    this.servicio.solicitudesPendientes().subscribe({ next: (r) => (this.solicitudes = r), error: () => { /* no crítico */ } });
  }

  responderSolicitud(s: ManualSolicitudPendiente, aceptar: boolean): void {
    if (this.respondiendoSolicitud) return;
    this.respondiendoSolicitud = s.id;
    this.servicio.responderSolicitud(s.id, aceptar).subscribe({
      next: (r) => {
        this.respondiendoSolicitud = null;
        this.mostrarAviso(aceptar ? `Listo: «${s.libreta}» ya aparece en tus manuales.` : 'Solicitud rechazada: el manual no se agregó a tu cuenta.');
        this.cargarSolicitudes();
        window.dispatchEvent(new CustomEvent('axis:notificaciones'));
        if (aceptar) this.cargarArbol(() => { void this.elegirLibreta(r.libretaId); });
      },
      error: async (e) => { this.respondiendoSolicitud = null; await this.error(e, 'No se pudo responder la solicitud.'); this.cargarSolicitudes(); },
    });
  }

  abrirCompartir(): void {
    if (!this.esMia || !this.libreta) return;
    this.cmpUsuarioId = null;
    this.cmpPermiso = 'LECTURA';
    this.comparticiones = [];
    this.abrirDlg('compartir');
    this.cargandoCmp = true;
    if (!this.usuariosBasico.length) {
      this.servicio.usuariosParaCompartir().subscribe({ next: (u) => { this.usuariosBasico = u; this.recalcularCandidatos(); }, error: () => { /* se muestra vacío */ } });
    }
    this.recargarComparticiones();
  }

  private recargarComparticiones(): void {
    const l = this.libreta;
    if (!l) return;
    this.servicio.comparticiones(l.id).subscribe({
      next: (c) => { this.comparticiones = c; this.cargandoCmp = false; this.recalcularCandidatos(); },
      error: async (e) => { this.cargandoCmp = false; this.dlgError = await mensajeDeError(e, 'No se pudo leer con quién está compartido.'); },
    });
  }

  private recalcularCandidatos(): void {
    const yo = (this.auth.obtenerDatosUsuario()?.username ?? '').toLowerCase();
    const ocupados = new Set(this.comparticiones.filter((c) => c.estado !== 'RECHAZADA').map((c) => c.usuario.toLowerCase()));
    this.candidatos = this.usuariosBasico.filter((u) => u.username.toLowerCase() !== yo && !ocupados.has(u.username.toLowerCase()));
  }

  enviarComparticion(): void {
    const l = this.libreta;
    if (!l || this.dlgOcupado) return;
    if (!this.cmpUsuarioId) { this.dlgError = 'Elige con quién compartir.'; return; }
    this.dlgError = '';
    this.dlgOcupado = true;
    this.servicio.compartir(l.id, this.cmpUsuarioId, this.cmpPermiso).subscribe({
      next: () => {
        this.dlgOcupado = false;
        this.cmpUsuarioId = null;
        this.mostrarAviso('Solicitud enviada: la otra persona recibe una notificación y solo verá el manual si lo acepta.');
        this.recargarComparticiones();
        void this.refrescarArbol();
      },
      error: async (e) => { this.dlgOcupado = false; this.dlgError = await mensajeDeError(e, 'No se pudo compartir el manual.'); },
    });
  }

  quitarComparticion(c: ManualComparticion): void {
    this.servicio.quitarAcceso(c.id).subscribe({
      next: () => { this.mostrarAviso(c.estado === 'ACEPTADA' ? `${c.nombre} ya no tiene acceso al manual.` : 'Solicitud cancelada.'); this.recargarComparticiones(); void this.refrescarArbol(); },
      error: async (e) => { this.dlgError = await mensajeDeError(e, 'No se pudo quitar el acceso.'); },
    });
  }

  /** Para quien recibió el manual: dejar de verlo en su cuenta (el dueño conserva todo). */
  dejarDeUsar(): void {
    const id = this.libreta?.miComparticionId;
    if (!id) return;
    this.menu = '';
    this.servicio.quitarAcceso(id).subscribe({
      next: () => { this.mostrarAviso('Dejaste de usar este manual compartido.'); this.cargarArbol(undefined, false); },
      error: async (e) => { await this.error(e, 'No se pudo dejar de usar el manual.'); },
    });
  }

  etiquetaPermiso(p: string): string { return p === 'EDICION' ? 'Puede editar' : 'Solo lectura'; }

  nuevaLibreta(): void { this.dlgId = null; this.dlgNombre = ''; this.dlgDescripcion = ''; this.abrirDlg('libreta'); }
  editarLibreta(): void { const l = this.libreta; if (!l) return; this.dlgId = l.id; this.dlgNombre = l.nombre; this.dlgDescripcion = l.descripcion || ''; this.abrirDlg('libreta'); }
  nuevaSeccion(): void { this.dlgId = null; this.dlgNombre = ''; this.dlgColor = COLORES_SECCION[(this.libreta?.secciones.length ?? 0) % COLORES_SECCION.length]; this.abrirDlg('seccion'); }
  editarSeccion(): void { const s = this.seccion; if (!s) return; this.dlgId = s.id; this.dlgNombre = s.nombre; this.dlgColor = s.color || COLORES_SECCION[0]; this.abrirDlg('seccion'); }

  moverPagina(): void {
    this.dlgDestino = null;
    this.abrirDlg('mover');
  }

  pedirEliminar(que: 'libreta' | 'seccion' | 'pagina'): void {
    this.dlgQue = que;
    if (que === 'libreta') { this.dlgId = this.libreta?.id ?? null; this.dlgNombre = this.libreta?.nombre ?? ''; }
    else if (que === 'seccion') { this.dlgId = this.seccion?.id ?? null; this.dlgNombre = this.seccion?.nombre ?? ''; }
    else { this.dlgId = this.pagina?.id ?? null; this.dlgNombre = this.pagina?.titulo ?? ''; }
    this.abrirDlg('eliminar');
  }

  cerrarDlg(): void {
    if (!this.dlgOcupado) this.dlg = '';
  }

  get seccionesParaMover(): ManualSeccion[] {
    return (this.libreta?.secciones ?? []).filter((s) => s.id !== this.pagina?.seccionId);
  }

  async confirmarDlg(): Promise<void> {
    this.dlgError = '';
    const nombre = this.dlgNombre.trim();
    if ((this.dlg === 'libreta' || this.dlg === 'seccion') && !nombre) { this.dlgError = 'Escribe un nombre.'; return; }
    this.dlgOcupado = true;
    try {
      if (this.dlg === 'libreta') {
        if (this.dlgId) {
          await firstValueFrom(this.servicio.editarLibreta(this.dlgId, nombre, this.dlgDescripcion.trim() || null));
          await this.refrescarArbol();
        } else {
          const l = await firstValueFrom(this.servicio.crearLibreta(nombre, this.dlgDescripcion.trim()));
          await this.refrescarArbol();
          this.dlg = '';
          await this.elegirLibreta(l.id);
          return;
        }
      } else if (this.dlg === 'seccion') {
        if (this.dlgId) {
          await firstValueFrom(this.servicio.editarSeccion(this.dlgId, nombre, this.dlgColor));
          await this.refrescarArbol();
        } else if (this.libretaId) {
          const s = await firstValueFrom(this.servicio.crearSeccion(this.libretaId, nombre, this.dlgColor));
          await this.refrescarArbol();
          this.dlg = '';
          await this.elegirSeccion(s.id, false);
          return;
        }
      } else if (this.dlg === 'mover') {
        if (!this.dlgDestino || !this.pagina) { this.dlgError = 'Elige la sección de destino.'; this.dlgOcupado = false; return; }
        const destino = this.dlgDestino;
        await firstValueFrom(this.servicio.moverPagina(this.pagina.id, destino));
        await this.refrescarArbol();
        this.dlg = '';
        this.mostrarAviso('Página movida.');
        await this.elegirSeccion(destino, false);
        return;
      } else if (this.dlg === 'eliminar' && this.dlgId) {
        await this.ejecutarEliminar();
        return;
      }
      this.dlg = '';
    } catch (e) {
      this.dlgError = await mensajeDeError(e, 'No se pudo completar la acción.');
    } finally {
      this.dlgOcupado = false;
    }
  }

  private async ejecutarEliminar(): Promise<void> {
    const id = this.dlgId as number;
    if (this.dlgQue === 'pagina') {
      const indice = this.paginas.findIndex((p) => p.id === id);
      await firstValueFrom(this.servicio.eliminarPagina(id));
      this.editando = false;
      this.estadoGuardado = 'limpio';
      this.pagina = null;
      this.paginas = this.paginas.filter((p) => p.id !== id);
      await this.refrescarArbol();
      this.dlg = '';
      this.mostrarAviso('Página eliminada.');
      const siguiente = this.paginas[Math.min(indice, this.paginas.length - 1)];
      if (siguiente && !this.angosto()) void this.router.navigate(['/manuales', siguiente.id]);
      else { this.vistaMovil = 'lista'; void this.router.navigate(['/manuales']); }
    } else if (this.dlgQue === 'seccion') {
      await firstValueFrom(this.servicio.eliminarSeccion(id));
      await this.refrescarArbol();
      this.dlg = '';
      this.mostrarAviso('Sección eliminada.');
      this.seccionId = null;
      await this.elegirSeccion(this.libreta?.secciones[0]?.id ?? null);
    } else {
      await firstValueFrom(this.servicio.eliminarLibreta(id));
      this.dlg = '';
      this.mostrarAviso('Libreta eliminada.');
      this.pagina = null;
      this.cargarArbol(() => void this.elegirSeccion(this.seccionId), false);
    }
  }

  // ================== importar ==================

  abrirImportar(): void {
    this.menu = '';
    this.mostrarImportar = true;
  }

  alImportar(r: ImportacionTerminada): void {
    this.mostrarImportar = false;
    this.cargarArbol(() => {
      this.libretaId = r.libretaId;
      this.seccionId = r.seccionId;
      try { localStorage.setItem(this.llaveLibreta(), String(r.libretaId)); } catch { /* sin almacenamiento */ }
      void this.cargarPaginas(r.seccionId).then(() => {
        if (this.angosto()) { this.vistaMovil = 'lista'; this.pagina = null; void this.router.navigate(['/manuales']); }
        else void this.router.navigate(['/manuales', r.paginaId]);
      });
    });
  }

  // ================== orden por arrastre ==================

  iniciarArrastre(i: number, e: DragEvent): void {
    if (!this.puedeEditar) return;
    this.arrastrando = i;
    e.dataTransfer?.setData('text/plain', String(i));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  soltarEn(destino: number, e: DragEvent): void {
    e.preventDefault();
    const origen = this.arrastrando;
    this.arrastrando = null;
    if (origen === null || origen === destino || !this.seccionId) return;
    const copia = [...this.paginas];
    const [mov] = copia.splice(origen, 1);
    copia.splice(destino, 0, mov);
    this.paginas = copia;
    this.servicio.ordenarPaginas(this.seccionId, copia.map((p) => p.id)).subscribe({ error: (er) => void this.error(er, 'No se pudo guardar el orden.') });
  }

  trackId(_i: number, x: { id: number }): number { return x.id; }

  get nombreUsuarioConflicto(): string {
    return this.conflicto?.actualizadoPor || 'Otra persona';
  }

  get seccionesColoreadas(): ManualSeccion[] {
    return this.libreta?.secciones ?? [];
  }
}
