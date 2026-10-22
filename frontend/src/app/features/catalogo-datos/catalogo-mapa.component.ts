import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription, debounceTime, distinctUntilChanged, switchMap, of } from 'rxjs';
import { CatalogoDatosService, Galaxia, MapaBase, MapaQueriesBaseDetalle, MapaQueriesResumen, TablaRef } from '../../core/services/catalogo-datos.service';
import { EstrellaBase, GalaxiaDiseno, MapaDiseno, PanZoom, disenoGalaxia, disenoMapaBase } from './catalogo-layout';

// Colores por origen (identidad). Validados para fondo oscuro; además cada origen se
// rotula con su nombre y motor, así que el color nunca es la única pista.
export const COLORES_ORIGEN = ['#8f81f5', '#10a898', '#cc7a00', '#e5509a', '#3a8fe0', '#6fa812'];

interface Tip { x: number; y: number; titulo: string; sub: string; lineas: string[]; }

// Mapa estelar: nivel 1 = «galaxia» (orígenes → bases, con puentes entre bases que
// comparten columnas); nivel 2 = «constelación» (las tablas de una base unidas por FK).
@Component({
  selector: 'app-catalogo-mapa',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './catalogo-mapa.component.html',
  styleUrl: './catalogo-mapa.component.scss',
})
export class CatalogoMapaComponent implements OnInit, AfterViewInit, OnChanges, OnDestroy {
  /** Cambia cada vez que el catálogo se vuelve a leer: el mapa se recarga. */
  @Input() version = 0;
  /** Si viene, el mapa abre directamente esa base. */
  @Input() baseInicial: { o: string; bd: string } | null = null;
  @Output() abrirTabla = new EventEmitter<TablaRef>();
  /** Abrir el repositorio de queries filtrado por una base. */
  @Output() verQueries = new EventEmitter<{ o: string; bd: string }>();

  @ViewChild('lienzo', { static: true }) lienzo!: ElementRef<HTMLElement>;
  @ViewChild('svg', { static: true }) svg!: ElementRef<SVGSVGElement>;

  readonly colores = COLORES_ORIGEN;
  pz = new PanZoom();
  galaxia: Galaxia | null = null;
  dg: GalaxiaDiseno | null = null;
  cargando = true;
  error = '';

  // Nivel 2
  base: { o: string; bd: string } | null = null;
  mapa: MapaBase | null = null;
  dm: MapaDiseno | null = null;
  cargandoBase = false;
  lineas: { a: number; b: number; x1: number; y1: number; x2: number; y2: number }[] = [];

  filtro = '';
  coincidenciasBase = new Map<string, number>();   // `${o}\u0001${bd}` → tablas que coinciden
  buscando = false;
  tip: Tip | null = null;
  hoverEstrella: number | null = null;
  mostrarPuentes = true;

  // Queries del equipo sobre el mapa
  qResumen: MapaQueriesResumen | null = null;
  qBase: MapaQueriesBaseDetalle | null = null;
  mostrarQueries = true;
  soloConQueries = false;
  /** Puentes que dibujan los queries entre bases (JOIN reales del equipo). */
  puentesQ: { x1: number; y1: number; x2: number; y2: number; grosor: number; queries: number; joins: number; texto: string }[] = [];
  /** Uniones entre tablas de la base según los queries (punteadas). */
  lineasQ: { x1: number; y1: number; x2: number; y2: number; fk: boolean; a: number; b: number; texto: string; queries: number }[] = [];
  private qPorTabla = new Map<string, number>();

  private busqueda$ = new Subject<string>();
  private sub?: Subscription;
  private observador?: ResizeObserver;

  constructor(private servicio: CatalogoDatosService) {}

  ngOnInit(): void {
    this.sub = this.busqueda$.pipe(
      debounceTime(250), distinctUntilChanged(),
      switchMap((q) => {
        if (this.base || q.trim().length < 2) { this.coincidenciasBase = new Map(); this.buscando = false; return of(null); }
        this.buscando = true;
        return this.servicio.buscar(q, { limite: 100 });
      }),
    ).subscribe({
      next: (r) => {
        this.buscando = false;
        const m = new Map<string, number>();
        if (r) {
          for (const t of r.tablas) { const k = `${t.ref.o}\u0001${t.bd}`; m.set(k, (m.get(k) || 0) + 1); }
          for (const c of r.columnas) for (const e of c.ejemplos) { const k = `${e.ref.o}\u0001${e.bd}`; m.set(k, (m.get(k) || 0) + 1); }
        }
        this.coincidenciasBase = m;
      },
      error: () => { this.buscando = false; },
    });
    this.cargarGalaxia();
    if (this.baseInicial) this.entrarBase(this.baseInicial.o, this.baseInicial.bd);
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.medir());
    if (typeof ResizeObserver !== 'undefined') {
      this.observador = new ResizeObserver(() => this.medir());
      this.observador.observe(this.lienzo.nativeElement);
    }
  }

  ngOnDestroy(): void { this.sub?.unsubscribe(); this.observador?.disconnect(); }

  ngOnChanges(c: SimpleChanges): void {
    if (c['version'] && !c['version'].firstChange) {
      this.cargarGalaxia();
      if (this.base) this.entrarBase(this.base.o, this.base.bd, true);
    }
  }

  private medir(): void {
    const r = this.lienzo.nativeElement.getBoundingClientRect();
    if (r.width > 0) { this.pz.ancho = r.width; this.pz.alto = r.height; }
  }

  get colorBase(): string {
    const idx = Math.max((this.galaxia?.origenes || []).findIndex((x) => x.id === this.base?.o), 0);
    return this.colorDe(idx);
  }

  colorDe(i: number): string { return this.colores[i % this.colores.length]; }

  cargarGalaxia(): void {
    this.cargando = !this.galaxia;
    this.servicio.galaxia().subscribe({
      next: (g) => {
        const primera = !this.galaxia;
        this.galaxia = g;
        this.dg = disenoGalaxia(g);
        this.cargarQueriesGalaxia();
        this.cargando = false;
        this.error = '';
        if (primera && !this.base) setTimeout(() => this.ajustar());
      },
      error: (e) => { this.cargando = false; this.error = e?.error?.error || 'No se pudo cargar el mapa.'; },
    });
  }

  private cargarQueriesGalaxia(): void {
    this.servicio.mapaQueriesResumen().subscribe({
      next: (r) => { this.qResumen = r.tabla ? r : null; this.armarPuentesQ(); },
      error: () => { this.qResumen = null; this.puentesQ = []; },   // opcional: el mapa funciona sin queries
    });
  }

  private armarPuentesQ(): void {
    this.puentesQ = [];
    if (!this.qResumen || !this.dg) return;
    const pos = new Map(this.dg.bases.map((b) => [`${b.o}\u0001${b.bd}`, b]));
    const max = Math.max(...this.qResumen.puentes.map((p) => p.queries), 1);
    for (const p of this.qResumen.puentes) {
      const a = pos.get(`${p.a.o}\u0001${p.a.bd}`);
      const b = pos.get(`${p.b.o}\u0001${p.b.bd}`);
      if (!a || !b) continue;
      this.puentesQ.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, grosor: 1.2 + (p.queries / max) * 3, queries: p.queries, joins: p.joins,
        texto: `${p.a.bd} ↔ ${p.b.bd}: ${p.queries} query(s) unen tablas de las dos bases` });
    }
  }

  /** Queries que tocan cada base (para la insignia «Q n»). */
  queriesDeBase(b: { o: string; bd: string }): number {
    return this.qResumen?.bases.find((x) => x.o === b.o && x.bd === b.bd)?.queries || 0;
  }
  get totalQueriesMapa(): number { return this.qResumen?.total || 0; }
  get hayQueriesMapa(): boolean { return !!this.qResumen && this.qResumen.bases.length > 0; }

  queriesDeTabla(i: number): number {
    if (!this.mapa) return 0;
    const r = this.mapa.tablas[i].ref;
    return this.qPorTabla.get(`${r.es || ''}\u0001${r.n}`) || 0;
  }
  tablaApagadaQ(i: number): boolean { return this.base !== null && this.mostrarQueries && this.soloConQueries && !this.queriesDeTabla(i); }
  radioAroQ(i: number, r: number): number { return r + 4; }
  grosorAroQ(i: number): number { return Math.min(1.2 + Math.log2(this.queriesDeTabla(i) + 1) * 0.9, 4.5); }
  get tablasConQueries(): number { return this.qBase?.tablas.length || 0; }
  get ayudaQueries(): string { return this.qResumen ? `${this.qResumen.total} queries guardados` : ''; }

  abrirQueriesBase(o: string, bd: string, ev?: Event): void { ev?.stopPropagation(); this.verQueries.emit({ o, bd }); }

  private cargarQueriesBase(o: string, bd: string): void {
    this.qBase = null; this.lineasQ = []; this.qPorTabla = new Map();
    this.servicio.mapaQueriesBase(o, bd).subscribe({
      next: (d) => {
        if (!d.tabla || !this.base || this.base.o !== o || this.base.bd !== bd) return;
        this.qBase = d;
        this.qPorTabla = new Map(d.tablas.map((t) => [`${t.es || ''}\u0001${t.n}`, t.queries]));
        this.armarLineasQ();
      },
      error: () => { this.qBase = null; },
    });
  }

  private armarLineasQ(): void {
    this.lineasQ = [];
    if (!this.qBase || !this.mapa || !this.dm) return;
    const idx = new Map(this.mapa.tablas.map((t, i) => [`${t.ref.es || ''}\u0001${t.ref.n}`, i]));
    const pos = new Map(this.dm.estrellas.map((e) => [e.i, e]));
    for (const j of this.qBase.joins) {
      const ia = idx.get(`${j.a.es || ''}\u0001${j.a.n}`);
      const ib = idx.get(`${j.b.es || ''}\u0001${j.b.n}`);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      const pa = pos.get(ia); const pb = pos.get(ib);
      if (!pa || !pb) continue;
      this.lineasQ.push({ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, fk: j.fk, a: ia, b: ib, queries: j.queries,
        texto: `${j.a.n} ↔ ${j.b.n}: unidas en ${j.queries} query(s)${j.fk ? ' · coincide con una llave foránea' : ' · relación que la base no define (sin FK)'}${j.condiciones.length ? ` · ${j.condiciones.slice(0, 2).map((c) => `${c.ca} = ${c.cb}`).join('; ')}` : ''}` });
    }
  }

  enlaceQVivo(a: number, b: number): boolean { return this.hoverEstrella !== null && (a === this.hoverEstrella || b === this.hoverEstrella); }

  buscar(v: string): void {
    this.filtro = v;
    this.busqueda$.next(v);
  }

  limpiarFiltro(): void { this.buscar(''); }

  // --- Navegación entre niveles ---
  entrarBase(o: string, bd: string, silencioso = false): void {
    if (this.pz.movido) return;
    this.tip = null;
    this.base = { o, bd };
    if (!silencioso) { this.mapa = null; this.dm = null; this.cargandoBase = true; }
    this.servicio.mapaBase(o, bd).subscribe({
      next: (m) => {
        this.mapa = m;
        this.dm = disenoMapaBase(m);
        const pos = new Map(this.dm.estrellas.map((s) => [s.i, s]));
        this.lineas = this.dm.enlaces.filter((e) => pos.has(e.a) && pos.has(e.b)).map((e) => ({ a: e.a, b: e.b, x1: pos.get(e.a)!.x, y1: pos.get(e.a)!.y, x2: pos.get(e.b)!.x, y2: pos.get(e.b)!.y }));
        this.cargandoBase = false;
        this.cargarQueriesBase(o, bd);
        if (!silencioso) setTimeout(() => this.ajustar());
      },
      error: (e) => { this.cargandoBase = false; this.error = e?.error?.error || 'No se pudo cargar la base.'; this.volver(); },
    });
  }

  volver(): void {
    this.base = null; this.mapa = null; this.dm = null; this.tip = null; this.hoverEstrella = null; this.qBase = null; this.lineasQ = []; this.soloConQueries = false;
    setTimeout(() => this.ajustar());
  }

  ajustar(): void {
    this.medir();
    if (this.base && this.dm) this.pz.encuadrar(this.dm.minX, this.dm.minY, this.dm.maxX, this.dm.maxY, 44);
    else if (this.dg) this.pz.encuadrar(this.dg.minX, this.dg.minY, this.dg.maxX, this.dg.maxY, 44);
  }

  // --- Coincidencias ---
  filtroNorm(): string { return this.filtro.trim().toLowerCase(); }
  conBusqueda(): boolean { return this.filtroNorm().length >= 2; }

  baseCoincide(b: EstrellaBase): number { return this.coincidenciasBase.get(`${b.o}\u0001${b.bd}`) || 0; }
  baseApagada(b: EstrellaBase): boolean { return this.conBusqueda() && !this.buscando && !this.baseCoincide(b) && !b.bd.toLowerCase().includes(this.filtroNorm()); }

  tablaCoincide(i: number): boolean {
    if (!this.mapa || !this.conBusqueda()) return false;
    const t = this.mapa.tablas[i];
    const q = this.filtroNorm();
    return t.nombre.toLowerCase().includes(q) || (t.descripcion || '').toLowerCase().includes(q);
  }
  get totalCoincidenciasTablas(): number {
    if (!this.mapa || !this.conBusqueda()) return 0;
    return this.mapa.tablas.reduce((s, _t, i) => s + (this.tablaCoincide(i) ? 1 : 0), 0);
  }

  // --- Tooltips ---
  private posTip(ev: MouseEvent): { x: number; y: number } {
    const r = this.lienzo.nativeElement.getBoundingClientRect();
    return { x: Math.min(ev.clientX - r.left + 14, r.width - 250), y: Math.min(ev.clientY - r.top + 14, r.height - 120) };
  }

  tipBase(ev: MouseEvent, b: EstrellaBase): void {
    const p = this.posTip(ev);
    const coinc = this.baseCoincide(b);
    this.tip = {
      ...p, titulo: b.bd, sub: `${b.origenNombre} · ${b.motor === 'MSSQL' ? 'SQL Server' : 'MariaDB'}`,
      lineas: [`${b.tablas} tabla(s) · ${b.vistas} vista(s)`, `${b.fks} llave(s) foránea(s)`, ...(this.queriesDeBase(b) ? [`${this.queriesDeBase(b)} query(s) del equipo la usan`] : []), ...(coinc ? [`${coinc} coincidencia(s) con «${this.filtro.trim()}»`] : []), ...(b.error ? ['No se pudo leer esta base'] : [])],
    };
  }

  tipTabla(ev: MouseEvent, i: number): void {
    if (!this.mapa) return;
    const t = this.mapa.tablas[i];
    const p = this.posTip(ev);
    this.hoverEstrella = i;
    this.tip = {
      ...p, titulo: t.esquema ? `${t.esquema}.${t.nombre}` : t.nombre, sub: t.tipo === 'VISTA' ? 'Vista' : 'Tabla',
      lineas: [`${t.nColumnas} columna(s)${t.filas !== null ? ` · ~${t.filas.toLocaleString('es-CO')} fila(s)` : ''}`,
        `Depende de ${t.nPadres} · la usan ${t.nHijas}`, ...(this.queriesDeTabla(i) ? [`${this.queriesDeTabla(i)} query(s) del equipo la usan`] : []), ...(t.descripcion ? [t.descripcion.length > 90 ? `${t.descripcion.slice(0, 89)}…` : t.descripcion] : [])],
    };
  }

  recortar(t: string, max: number): string { return t.length > max ? `${t.slice(0, max - 1)}…` : t; }

  // Las etiquetas solo se dibujan cuando hay espacio: con zoom, en coincidencias o al pasar el mouse.
  mostrarEtiqueta(i: number): boolean {
    if (!this.mapa) return false;
    if (this.hoverEstrella === i || this.tablaCoincide(i)) return true;
    if (this.conBusqueda()) return false;
    const t = this.mapa.tablas[i];
    const n = this.mapa.tablas.length;
    // Con muchas tablas hace falta más zoom para que las etiquetas no se encimen.
    const umbral = n <= 45 ? 0.55 : n <= 120 ? 1.3 : 3;
    if (this.pz.k >= umbral) return true;
    return t.nPadres + t.nHijas >= 3 && this.pz.k >= 0.6;
  }

  ocultarTip(): void { this.tip = null; this.hoverEstrella = null; }

  clicTabla(i: number): void {
    if (this.pz.movido || !this.mapa) return;
    this.abrirTabla.emit(this.mapa.tablas[i].ref);
  }

  enlaceVivo(a: number, b: number): boolean { return this.hoverEstrella !== null && (a === this.hoverEstrella || b === this.hoverEstrella); }

  teclaBase(ev: KeyboardEvent, b: EstrellaBase): void { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.entrarBase(b.o, b.bd); } }
  teclaTabla(ev: KeyboardEvent, i: number): void { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.clicTabla(i); } }

  get hayDatos(): boolean { return !!this.galaxia && this.galaxia.origenes.some((o) => o.bases.length > 0); }

  @HostListener('window:resize') onResize(): void { this.medir(); }
}
