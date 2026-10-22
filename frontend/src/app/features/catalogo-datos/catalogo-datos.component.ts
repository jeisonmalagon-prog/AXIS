import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, Subscription, catchError, debounceTime, of, switchMap, tap } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import {
  BusquedaResultado, CatalogoDatosService, CatalogoResumen, ColumnaHallazgo, LugaresColumna, OrigenEstado, TablaRef, TablaResumen,
} from '../../core/services/catalogo-datos.service';
import { CatalogoTablaComponent } from './catalogo-tabla.component';
import { CatalogoMapaComponent } from './catalogo-mapa.component';
import { CatalogoOrigenesComponent } from './catalogo-origenes.component';
import { CatalogoQueriesComponent } from './catalogo-queries.component';
import { CatalogoCredencialesComponent } from './catalogo-credenciales.component';

type Vista = 'buscar' | 'mapa';
type ItemLista = { tipo: 'tabla'; tabla: TablaResumen } | { tipo: 'columna'; col: ColumnaHallazgo };

@Component({
  selector: 'app-catalogo-datos',
  standalone: true,
  imports: [CommonModule, FormsModule, CatalogoTablaComponent, CatalogoMapaComponent, CatalogoOrigenesComponent, CatalogoQueriesComponent, CatalogoCredencialesComponent],
  templateUrl: './catalogo-datos.component.html',
  styleUrl: './catalogo-datos.component.scss',
})
export class CatalogoDatosComponent implements OnInit, OnDestroy {
  @ViewChild('entradaBusqueda') entradaBusqueda?: ElementRef<HTMLInputElement>;

  puedeEditar = false;
  esAdminPod = false;

  resumen: CatalogoResumen | null = null;
  cargandoInicial = true;
  errorGeneral = '';
  mensaje = '';
  actualizando = false;
  versionMapa = 0;

  vista: Vista = 'buscar';
  mostrarOrigenes = false;
  mostrarCredenciales = false;
  mostrarQueries = false;
  queriesPestana: 'repositorio' | 'constructor' | 'ia' = 'repositorio';
  queriesTablas: TablaRef[] = [];
  queriesFiltro: TablaRef | null = null;
  baseInicial: { o: string; bd: string } | null = null;
  queriesBase = '';
  queryInicial: number | null = null;

  // Búsqueda
  q = '';
  tipo: 'todo' | 'tabla' | 'columna' = 'todo';
  origenFiltro = '';
  bdFiltro = '';
  resultado: BusquedaResultado | null = null;
  buscando = false;
  errorBusqueda = '';
  seleccion = -1;
  columnaAbierta: string | null = null;
  lugares: LugaresColumna | null = null;
  cargandoLugares = false;

  // Tabla abierta (vive en la URL para poder compartir el enlace)
  tablaSel: TablaRef | null = null;
  pestanaTabla: 'diccionario' | 'diagrama' = 'diccionario';
  private pasosInternos = 0;

  private busqueda$ = new Subject<void>();
  private subs = new Subscription();
  private sondeo: ReturnType<typeof setTimeout> | null = null;
  private destruido = false;

  constructor(
    private servicio: CatalogoDatosService,
    private auth: AuthService,
    private ruta: ActivatedRoute,
    private router: Router,
    private ubicacion: Location,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.auth.puedeEditar('CATALOGO_DATOS');
    this.esAdminPod = this.auth.obtenerDatosUsuario()?.rol === 'ADMIN_POD';
    this.subs.add(this.ruta.queryParamMap.subscribe((p) => {
      const n = p.get('n');
      this.tablaSel = n && p.get('o') && p.get('bd') ? { o: p.get('o')!, bd: p.get('bd')!, es: p.get('es') || '', n } : null;
      this.pestanaTabla = p.get('v') === 'er' ? 'diagrama' : 'diccionario';
    }));
    this.subs.add(this.busqueda$.pipe(
      debounceTime(220),
      tap(() => { this.errorBusqueda = ''; this.buscando = this.q.trim().length >= 2; }),
      switchMap(() => (this.q.trim().length < 2 ? of(null) : this.servicio.buscar(this.q, {
        tipo: this.tipo, origen: this.origenFiltro || undefined, bd: this.bdFiltro || undefined, limite: 40,
      }).pipe(catchError((e) => { this.buscando = false; this.errorBusqueda = e?.error?.error || 'No se pudo buscar.'; return of(null); })))),
    ).subscribe((r) => { this.resultado = r; this.buscando = false; this.seleccion = r && this.items.length ? 0 : -1; this.columnaAbierta = null; this.lugares = null; }));
    this.cargarResumen(true);
  }

  ngOnDestroy(): void {
    this.destruido = true;
    this.subs.unsubscribe();
    if (this.sondeo) clearTimeout(this.sondeo);
  }

  // --- Estado del catálogo -------------------------------------------------------------
  cargarResumen(primera = false): void {
    this.servicio.resumen().subscribe({
      next: (r) => {
        const estabaCargando = this.resumen?.cargando;
        this.resumen = r;
        this.cargandoInicial = false;
        this.errorGeneral = '';
        if (estabaCargando && !r.cargando) this.versionMapa++;
        if (primera && !r.cargando) this.versionMapa++;
        this.programarSondeo(r.cargando);
      },
      error: (e) => {
        this.cargandoInicial = false;
        this.errorGeneral = e?.error?.error || 'No se pudo cargar el catálogo.';
      },
    });
  }

  private programarSondeo(activo: boolean): void {
    if (this.sondeo) { clearTimeout(this.sondeo); this.sondeo = null; }
    if (activo && !this.destruido) this.sondeo = setTimeout(() => this.cargarResumen(), 2000);
  }

  actualizar(): void {
    this.actualizando = true;
    this.mensaje = '';
    this.servicio.actualizar().subscribe({
      next: () => { this.actualizando = false; this.mensaje = 'Leyendo los servidores… el catálogo se irá llenando solo.'; this.cargarResumen(); },
      error: (e) => { this.actualizando = false; this.errorGeneral = e?.error?.error || 'No se pudo actualizar.'; },
    });
  }

  abrirQueries(pestana: 'repositorio' | 'constructor' | 'ia' = 'repositorio', tablas: TablaRef[] = [], filtro: TablaRef | null = null, bd = '', queryId: number | null = null): void {
    this.queriesPestana = pestana;
    this.queriesTablas = tablas;
    this.queriesFiltro = filtro;
    this.queriesBase = bd;
    this.queryInicial = queryId;
    // se recrea el componente para que tome los nuevos valores iniciales
    this.mostrarQueries = false;
    setTimeout(() => { this.mostrarQueries = true; });
  }

  cerrarQueries(): void { this.mostrarQueries = false; this.queriesBase = ''; this.queryInicial = null; }

  /** Desde «Queries»: ir a la ficha de una tabla del catálogo. */
  verTablaDesdeQueries(ref: TablaRef): void { this.cerrarQueries(); this.abrirTabla(ref); }

  /** «Mis credenciales»: usuario y clave PROPIOS (una por motor) con los que se arma tu catálogo y tu mapa. */
  cerrarCredenciales(huboCambios: boolean): void {
    this.mostrarCredenciales = false;
    if (huboCambios) { this.mensaje = 'Credenciales actualizadas. Se está armando tu catálogo con ellas.'; this.cargarResumen(); }
  }

  cerrarOrigenes(huboCambios: boolean): void {
    this.mostrarOrigenes = false;
    if (huboCambios) { this.mensaje = 'Origen guardado. El catálogo se está actualizando.'; this.actualizar(); }
  }

  get totalTablas(): number { return this.resumen?.totales.tablas || 0; }
  get hayOrigenes(): boolean { return !!this.resumen && this.resumen.origenes.length > 0; }
  get enLectura(): OrigenEstado[] { return (this.resumen?.origenes || []).filter((o) => o.cargando); }
  get conError(): OrigenEstado[] { return (this.resumen?.origenes || []).filter((o) => o.estado !== 'sin-credenciales' && (o.estado === 'error' || (o.error && !o.cargando))); }
  /** Motores con servidores en la lista para los que aún no tienes usuario y clave, p. ej. «SQL Server y MariaDB». */
  get motoresSinCredenciales(): string {
    const r = this.resumen;
    if (!r || !r.credenciales) return '';
    const nombres: string[] = [];
    for (const m of ['MSSQL', 'MARIADB'] as const) {
      if (!r.credenciales[m].configurada && r.origenes.some((o) => o.motor === m)) nombres.push(this.etiquetaMotor(m));
    }
    return nombres.join(' y ');
  }
  get credencialesConfiguradas(): number {
    const c = this.resumen?.credenciales;
    return c ? (c.MSSQL.configurada ? 1 : 0) + (c.MARIADB.configurada ? 1 : 0) : 0;
  }
  get advertencias(): { origen: string; texto: string }[] {
    const r: { origen: string; texto: string }[] = [];
    for (const o of this.resumen?.origenes || []) for (const a of o.advertencias || []) r.push({ origen: o.nombre, texto: a });
    return r.slice(0, 6);
  }
  get basesFiltro(): string[] {
    const lista = (this.resumen?.origenes || []).filter((o) => !this.origenFiltro || o.id === this.origenFiltro);
    return [...new Set(lista.flatMap((o) => o.bases.filter((b) => b.tablas + b.vistas > 0).map((b) => b.nombre)))].sort((a, b) => a.localeCompare(b));
  }

  ultimaActualizacion(): string | null {
    const f = (this.resumen?.origenes || []).map((o) => o.actualizadoEn).filter((x): x is string => !!x).sort().pop();
    return f ? new Date(f).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : null;
  }

  // --- Búsqueda ------------------------------------------------------------------------
  escribir(v: string): void {
    this.q = v;
    this.busqueda$.next();
    if (!v.trim()) { this.resultado = null; this.seleccion = -1; this.buscando = false; }
  }

  cambiarFiltros(): void {
    if (this.bdFiltro && !this.basesFiltro.includes(this.bdFiltro)) this.bdFiltro = '';
    if (this.q.trim().length >= 2) this.busqueda$.next();
  }

  get items(): ItemLista[] {
    if (!this.resultado) return [];
    return [
      ...this.resultado.tablas.map((tabla): ItemLista => ({ tipo: 'tabla', tabla })),
      ...this.resultado.columnas.map((col): ItemLista => ({ tipo: 'columna', col })),
    ];
  }

  teclaBusqueda(ev: KeyboardEvent): void {
    const n = this.items.length;
    if (ev.key === 'ArrowDown' && n) { ev.preventDefault(); this.seleccion = (this.seleccion + 1) % n; this.verSeleccion(); }
    else if (ev.key === 'ArrowUp' && n) { ev.preventDefault(); this.seleccion = (this.seleccion - 1 + n) % n; this.verSeleccion(); }
    else if (ev.key === 'Enter' && this.seleccion >= 0 && this.seleccion < n) { ev.preventDefault(); this.activar(this.items[this.seleccion]); }
    else if (ev.key === 'Escape') { this.escribir(''); }
  }

  private verSeleccion(): void {
    setTimeout(() => document.querySelector('.res-item.sel')?.scrollIntoView({ block: 'nearest' }));
  }

  activar(it: ItemLista): void {
    if (it.tipo === 'tabla') this.abrirTabla(it.tabla.ref);
    else this.verColumna(it.col);
  }

  verColumna(c: ColumnaHallazgo): void {
    if (this.columnaAbierta === c.nombre) { this.columnaAbierta = null; this.lugares = null; return; }
    this.columnaAbierta = c.nombre;
    this.lugares = null;
    this.cargandoLugares = true;
    this.servicio.lugaresDeColumna(c.nombre, { origen: this.origenFiltro || undefined, bd: this.bdFiltro || undefined, limite: 80 }).subscribe({
      next: (l) => { this.lugares = l; this.cargandoLugares = false; },
      error: () => { this.cargandoLugares = false; },
    });
  }

  indiceItem(tipo: 'tabla' | 'columna', i: number): number { return tipo === 'tabla' ? i : (this.resultado?.tablas.length || 0) + i; }

  etiquetaTabla(t: TablaResumen): string { return t.esquema ? `${t.bd}.${t.esquema}` : t.bd; }
  etiquetaMotor(m: string): string { return m === 'MSSQL' ? 'SQL Server' : 'MariaDB'; }

  // --- Navegación ----------------------------------------------------------------------
  abrirTabla(ref: TablaRef, pestana: 'diccionario' | 'diagrama' = 'diccionario'): void {
    this.pasosInternos++;
    this.router.navigate([], { relativeTo: this.ruta, queryParams: { o: ref.o, bd: ref.bd, es: ref.es || null, n: ref.n, v: pestana === 'diagrama' ? 'er' : null } });
    window.scrollTo({ top: 0 });
  }

  cerrarTabla(): void {
    if (this.pasosInternos > 0) { this.pasosInternos--; this.ubicacion.back(); return; }
    this.router.navigate([], { relativeTo: this.ruta, queryParams: {} });
  }

  verBaseEnMapa(o: string, bd: string): void {
    this.baseInicial = { o, bd };
    this.vista = 'mapa';
  }

  cambiarVista(v: Vista): void {
    if (v === 'buscar') this.baseInicial = null;
    this.vista = v;
  }

  // Atajo «/»: enfoca el buscador (como Spotlight).
  @HostListener('document:keydown', ['$event'])
  atajo(ev: KeyboardEvent): void {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const el = ev.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    if (this.tablaSel || this.vista !== 'buscar' || !this.entradaBusqueda) return;
    ev.preventDefault();
    this.entradaBusqueda.nativeElement.focus();
  }
}
