import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription, of } from 'rxjs';
import { catchError, debounceTime, map, switchMap, tap } from 'rxjs/operators';
import {
  ArmadoError, ArmadoQuery, CatalogoDatosService, ColumnaDetalle, ColumnaSel, ConfigConstructor, FiltroConstructor, FuncionMedida, JoinConfig,
  MapaQueriesTablaDetalle, MedidaConstructor, ModoConstructor, OperadorFiltro, OrdenConstructor, OrigenEstado, PuenteSugerido, RecetaQuery,
  SugerenciasQuery, TablaDetalle, TablaRef, TablaRelacionada, TablaResumen, TipoJoin, TruncFecha, UnionArmada, UnionManual, ValoresFrecuentes,
} from '../../core/services/catalogo-datos.service';
import { BorradorQuery } from './catalogo-ia.component';
import { QueryEjecucionComponent } from './query-ejecucion.component';

export interface TablaSel { ref: TablaRef; nombre: string; bd: string; esquema: string | null; origen: string; }
/** Lo que se carga desde fuera: un query del repositorio o una tabla del catálogo. */
export interface PeticionConstructor { id: number; config?: ConfigConstructor | null; tablas?: TablaRef[]; nombre?: string; descripcion?: string; }

interface ColUi { t: number; c: string; alias: string; trunc: TruncFecha | ''; }
interface MedidaUi { fn: FuncionMedida; col: string; alias: string; }
interface FiltroUi { col: string; op: OperadorFiltro; v: string; v2: string; g: number; }
interface OrdenUi { key: string; dir: 'asc' | 'desc'; }
interface BorradorUnion { t1: number; c1: string; c2: string; }
interface GrupoFiltros { g: number; filas: { f: FiltroUi; i: number }[]; }
interface EstadoValores { estado: 'cargando' | 'ok' | 'error'; datos?: ValoresFrecuentes; error?: string; }
interface DefOperador { v: OperadorFiltro; n: 0 | 1 | 2; fams: Familia[] | null; }
type Familia = 'texto' | 'num' | 'fecha' | 'bit' | 'guid' | 'otro';

const MAX_TABLAS = 8;
const refKey = (r: TablaRef) => `${r.o}|${r.bd}|${r.es}|${r.n}`;
const clave = (t: number, c: string) => `${t}|${c}`;
const dividirClave = (k: string): { t: number; c: string } => { const i = k.indexOf('|'); return { t: parseInt(k.slice(0, i), 10), c: k.slice(i + 1) }; };

export function familiaTipo(tipo: string): Familia {
  const b = String(tipo || '').toLowerCase().replace(/\(.*\)/, '').trim();
  if (['int', 'integer', 'bigint', 'smallint', 'tinyint', 'mediumint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney', 'double'].includes(b)) return 'num';
  if (b === 'bit') return 'bit';
  if (['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time', 'timestamp', 'year'].includes(b)) return 'fecha';
  if (b === 'uniqueidentifier') return 'guid';
  if (['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'longtext', 'mediumtext', 'tinytext', 'enum'].includes(b)) return 'texto';
  return 'otro';
}

const OPERADORES: DefOperador[] = [
  { v: 'eq', n: 1, fams: ['texto', 'num', 'guid', 'bit', 'otro'] },
  { v: 'ne', n: 1, fams: ['texto', 'num', 'guid', 'bit', 'otro'] },
  { v: 'contiene', n: 1, fams: ['texto'] },
  { v: 'nocontiene', n: 1, fams: ['texto'] },
  { v: 'empieza', n: 1, fams: ['texto'] },
  { v: 'termina', n: 1, fams: ['texto'] },
  { v: 'en', n: 1, fams: ['texto', 'num', 'guid'] },
  { v: 'noen', n: 1, fams: ['texto', 'num', 'guid'] },
  { v: 'gt', n: 1, fams: ['num', 'texto'] },
  { v: 'ge', n: 1, fams: ['num', 'texto', 'fecha'] },
  { v: 'lt', n: 1, fams: ['num', 'texto', 'fecha'] },
  { v: 'le', n: 1, fams: ['num', 'texto'] },
  { v: 'entre', n: 2, fams: ['num', 'fecha', 'texto'] },
  { v: 'hoy', n: 0, fams: ['fecha'] },
  { v: 'ayer', n: 0, fams: ['fecha'] },
  { v: 'ultimosDias', n: 1, fams: ['fecha'] },
  { v: 'mes', n: 0, fams: ['fecha'] },
  { v: 'mesPasado', n: 0, fams: ['fecha'] },
  { v: 'vacio', n: 0, fams: ['texto'] },
  { v: 'novacio', n: 0, fams: ['texto'] },
  { v: 'nulo', n: 0, fams: null },
  { v: 'nonulo', n: 0, fams: null },
];

const TEXTO_OP: Record<string, string> = {
  eq: 'es igual a', ne: 'es distinto de', contiene: 'contiene', nocontiene: 'no contiene', empieza: 'empieza por', termina: 'termina en',
  en: 'está en la lista', noen: 'no está en la lista', gt: 'mayor que', ge: 'mayor o igual que', lt: 'menor que', le: 'menor o igual que',
  entre: 'está entre', hoy: 'es de hoy', ayer: 'es de ayer', ultimosDias: 'de los últimos N días', mes: 'es de este mes', mesPasado: 'es del mes pasado',
  vacio: 'está vacío o sin valor', novacio: 'tiene algún valor', nulo: 'es NULL', nonulo: 'no es NULL',
};
const TEXTO_OP_FECHA: Record<string, string> = { ge: 'desde (incluye)', lt: 'antes de', entre: 'entre estas fechas (inclusive)' };

export const FUNCIONES: { v: FuncionMedida; t: string; numerica: boolean; conColumna: boolean }[] = [
  { v: 'count', t: 'Contar filas', numerica: false, conColumna: false },
  { v: 'cdistinct', t: 'Contar valores distintos de', numerica: false, conColumna: true },
  { v: 'sum', t: 'Sumar', numerica: true, conColumna: true },
  { v: 'avg', t: 'Promediar', numerica: true, conColumna: true },
  { v: 'min', t: 'Mínimo de', numerica: false, conColumna: true },
  { v: 'max', t: 'Máximo de', numerica: false, conColumna: true },
];

export const TRUNCS: { v: TruncFecha | ''; t: string }[] = [
  { v: '', t: 'Fecha y hora completas' }, { v: 'dia', t: 'Por día' }, { v: 'mes', t: 'Por mes' }, { v: 'anio', t: 'Por año' }, { v: 'hora', t: 'Por hora' },
];

// Constructor guiado: eliges tablas del catálogo y AXIS encuentra cómo unirlas (llaves foráneas, JOIN que ya
// usa el equipo en el repositorio, nombres de columna) y arma el SELECT: columnas con alias, resúmenes por
// día/mes con sumas y promedios, filtros con Y/O, valores frecuentes y uniones editables.
@Component({
  selector: 'app-catalogo-constructor',
  standalone: true,
  imports: [CommonModule, FormsModule, QueryEjecucionComponent],
  templateUrl: './catalogo-constructor.component.html',
  styleUrl: './catalogo-constructor.component.scss',
})
export class CatalogoConstructorComponent implements OnInit, OnChanges, OnDestroy {
  @Input() origenes: OrigenEstado[] = [];
  @Input() puedeEditar = false;
  @Input() tablasIniciales: TablaRef[] = [];
  /** Abre un query del repositorio (o una tabla) en el constructor. Cada petición trae un id nuevo. */
  @Input() peticion: PeticionConstructor | null = null;
  @Output() guardar = new EventEmitter<BorradorQuery>();
  @Output() tablasCambian = new EventEmitter<TablaRef[]>();
  @Output() verQuery = new EventEmitter<number>();

  // Tablas
  busqueda = '';
  resultadosBusqueda: TablaResumen[] = [];
  buscando = false;
  tablas: TablaSel[] = [];
  detalles = new Map<string, TablaDetalle>();
  usoEquipo = new Map<string, MapaQueriesTablaDetalle>();
  mensaje = '';
  sugerencias: SugerenciasQuery | null = null;
  cargandoSug = false;

  // Qué obtener
  modo: ModoConstructor = 'detalle';
  cols: ColUi[] = [];
  grupos: ColUi[] = [];
  medidas: MedidaUi[] = [];
  minTotal: number | null = null;
  tablaActiva = 0;
  filtroCols = '';

  // Filtros y orden
  filtros: FiltroUi[] = [];
  gruposF: GrupoFiltros[] = [];
  valores = new Map<string, EstadoValores>();
  orden: OrdenUi[] = [];
  top = 100;
  tipoJoin: 'INNER' | 'LEFT' = 'INNER';
  nolock = true;
  distinct = false;

  // Uniones
  joinsManuales: UnionManual[] = [];
  joinsConfig: JoinConfig[] = [];
  nuevaUnion: { t1: number; c1: string; t2: number; c2: string } = { t1: 0, c1: '', t2: 1, c2: '' };
  borradores: Record<string, BorradorUnion> = {};

  // Nombre
  nombre = '';
  descripcion = '';
  comentarioSql = true;

  // Resultado
  armado: ArmadoQuery | null = null;
  errorArmado: ArmadoError | null = null;
  armando = false;
  copiado = false;
  verExplicacion = false;
  private temporizador: ReturnType<typeof setTimeout> | null = null;

  readonly modos: { v: ModoConstructor; t: string; ayuda: string; icono: string }[] = [
    { v: 'detalle', t: 'Ver filas', ayuda: 'Lista los registros con las columnas que elijas.', icono: '☰' },
    { v: 'agrupado', t: 'Resumir', ayuda: 'Agrupa (por valor, día, mes…) y calcula: contar, sumar, promediar.', icono: 'Σ' },
    { v: 'repetidos', t: 'Buscar repetidos', ayuda: 'Valores que aparecen más de una vez.', icono: '⧉' },
    { v: 'conteo', t: 'Solo contar', ayuda: 'Cuántas filas cumplen los filtros.', icono: '#' },
  ];
  readonly funciones = FUNCIONES;
  readonly truncs = TRUNCS;
  readonly topes = [10, 50, 100, 500, 1000, 5000];
  readonly tiposJoin: TipoJoin[] = ['INNER', 'LEFT', 'RIGHT'];

  private busquedaSubject = new Subject<string>();
  private armarSubject = new Subject<void>();
  private subs = new Subscription();
  private iniciado = false;

  constructor(private servicio: CatalogoDatosService) {}

  ngOnInit(): void {
    this.subs.add(this.busquedaSubject.pipe(
      debounceTime(300),
      tap(() => { this.buscando = true; }),
      switchMap((q) => (q.trim().length < 2 ? of(null) : this.servicio.buscar(q.trim(), { tipo: 'tabla', limite: 12, origen: this.origenFiltro || undefined }).pipe(catchError(() => of(null))))),
    ).subscribe((r) => { this.resultadosBusqueda = r ? r.tablas : []; this.buscando = false; }));

    this.subs.add(this.armarSubject.pipe(
      debounceTime(350),
      tap(() => { this.armando = true; }),
      switchMap(() => {
        const cfg = this.configActual();
        if (!cfg.tablas.length) return of({ ok: null as ArmadoQuery | null, err: null as ArmadoError | null });
        return this.servicio.armarQuery(cfg).pipe(
          map((ok) => ({ ok: ok as ArmadoQuery | null, err: null as ArmadoError | null })),
          catchError((e) => of({ ok: null as ArmadoQuery | null, err: { error: e?.error?.error || 'No se pudo armar la consulta.', sinRelacion: e?.error?.sinRelacion, puentes: e?.error?.puentes } as ArmadoError })),
        );
      }),
    ).subscribe(({ ok, err }) => { this.armado = ok; this.errorArmado = err; this.armando = false; }));

    this.iniciado = true;
    if (this.peticion) this.aplicarPeticion(this.peticion);
    else for (const ref of this.tablasIniciales) this.agregarPorRef(ref);
  }

  ngOnChanges(c: SimpleChanges): void {
    if (this.iniciado && c['peticion'] && this.peticion) this.aplicarPeticion(this.peticion);
  }

  ngOnDestroy(): void { this.subs.unsubscribe(); if (this.temporizador) clearTimeout(this.temporizador); }

  get origenFiltro(): string { return this.tablas[0]?.ref.o || ''; }
  get ayudaModo(): string { return this.modos.find((m) => m.v === this.modo)?.ayuda || ''; }
  get usaGrupos(): boolean { return this.modo === 'agrupado' || this.modo === 'repetidos'; }
  get seleccionadas(): ColUi[] { return this.usaGrupos ? this.grupos : this.cols; }

  // ======================= Tablas =======================
  buscar(): void { this.busquedaSubject.next(this.busqueda); }
  yaElegida(ref: TablaRef): boolean { return this.tablas.some((t) => refKey(t.ref) === refKey(ref)); }
  agregarResumen(t: TablaResumen): void { this.agregar({ ref: t.ref, nombre: t.nombre, bd: t.bd, esquema: t.esquema, origen: t.origen }); }
  agregarRelacionada(r: TablaRelacionada): void { this.agregar({ ref: r.tabla.ref, nombre: r.tabla.nombre, bd: r.tabla.bd, esquema: r.tabla.esquema, origen: r.tabla.origen }); }
  agregarPuente(p: PuenteSugerido): void { this.agregar({ ref: p.ref, nombre: p.nombre, bd: p.bd || p.ref.bd, esquema: p.esquema ?? (p.ref.es || null), origen: '' }); }
  private agregarPorRef(ref: TablaRef): void { this.agregar({ ref, nombre: ref.n, bd: ref.bd, esquema: ref.es || null, origen: '' }); }

  private agregar(t: TablaSel): void {
    this.mensaje = '';
    if (this.yaElegida(t.ref)) return;
    if (this.tablas.length >= MAX_TABLAS) { this.mensaje = `Máximo ${MAX_TABLAS} tablas por consulta.`; return; }
    if (this.tablas.length && t.ref.o !== this.tablas[0].ref.o) { this.mensaje = 'Esa tabla está en otro servidor: un query solo puede unir tablas del mismo servidor.'; return; }
    this.tablas = [...this.tablas, t];
    this.busqueda = '';
    this.resultadosBusqueda = [];
    this.cargarDetalle(t.ref);
    this.alCambiarTablas();
  }

  quitar(i: number): void {
    this.tablas = this.tablas.filter((_, k) => k !== i);
    const re = (k: string): string | null => { const { t, c } = dividirClave(k); if (t === i) return null; return clave(t > i ? t - 1 : t, c); };
    const reCol = (x: ColUi): ColUi | null => (x.t === i ? null : { ...x, t: x.t > i ? x.t - 1 : x.t });
    this.cols = this.cols.map(reCol).filter((x): x is ColUi => !!x);
    this.grupos = this.grupos.map(reCol).filter((x): x is ColUi => !!x);
    this.medidas = this.medidas.map((m) => ({ ...m, col: m.col ? (re(m.col) || '') : '' })).filter((m) => m.fn === 'count' || m.col);
    this.filtros = this.filtros.filter((f) => !f.col || re(f.col) !== null).map((f) => ({ ...f, col: f.col ? (re(f.col) as string) : '' }));
    this.orden = this.orden.map((o) => (o.key.startsWith('c:') ? { ...o, key: `c:${re(o.key.slice(2)) || ''}` } : o)).filter((o) => o.key !== 'c:');
    this.joinsManuales = this.joinsManuales.filter((j) => j.t1 !== i && j.t2 !== i).map((j) => ({ ...j, t1: j.t1 > i ? j.t1 - 1 : j.t1, t2: j.t2 > i ? j.t2 - 1 : j.t2 }));
    this.joinsConfig = [];
    this.tablaActiva = Math.min(this.tablaActiva, Math.max(this.tablas.length - 1, 0));
    this.nuevaUnion = { t1: 0, c1: '', t2: Math.min(1, Math.max(this.tablas.length - 1, 0)), c2: '' };
    this.alCambiarTablas();
  }

  private alCambiarTablas(): void {
    this.tablasCambian.emit(this.tablas.map((t) => t.ref));
    this.sugerencias = null;
    if (!this.tablas.length) { this.armado = null; this.errorArmado = null; this.refrescarGrupos(); return; }
    this.cargandoSug = true;
    this.servicio.sugerirQueries(this.tablas.map((t) => t.ref)).subscribe({
      next: (s) => { this.sugerencias = s; this.cargandoSug = false; },
      error: () => { this.cargandoSug = false; },
    });
    this.programar();
  }

  private cargarDetalle(ref: TablaRef): void {
    const k = refKey(ref);
    if (!this.detalles.has(k)) {
      this.servicio.tabla(ref).subscribe({
        next: (d) => {
          this.detalles.set(k, d);
          const t = this.tablas.find((x) => refKey(x.ref) === k);
          if (t) { t.nombre = d.nombre; t.bd = d.bd; t.esquema = d.esquema; t.origen = d.origen.nombre; }
        },
        error: () => { /* sin columnas: el armado funciona igual, solo no se pueden elegir columnas */ },
      });
    }
    if (!this.usoEquipo.has(k)) {
      this.servicio.mapaQueriesTabla(ref).subscribe({
        next: (u) => { if (u.tabla) this.usoEquipo.set(k, u); },
        error: () => { /* el repositorio es opcional */ },
      });
    }
  }

  columnasDe(i: number): ColumnaDetalle[] {
    const t = this.tablas[i];
    return t ? (this.detalles.get(refKey(t.ref))?.columnas || []) : [];
  }

  columnaInfo(i: number, c: string): ColumnaDetalle | null {
    return this.columnasDe(i).find((x) => x.nombre.toLowerCase() === c.toLowerCase()) || null;
  }

  familiaDe(key: string): Familia {
    if (!key) return 'otro';
    const { t, c } = dividirClave(key);
    const info = this.columnaInfo(t, c);
    return info ? familiaTipo(info.tipo) : 'otro';
  }

  get opcionesColumna(): { valor: string; texto: string }[] {
    const res: { valor: string; texto: string }[] = [];
    this.tablas.forEach((t, i) => { for (const c of this.columnasDe(i)) res.push({ valor: clave(i, c.nombre), texto: `${t.nombre}.${c.nombre}` }); });
    return res;
  }

  textoClave(k: string): string {
    const { t, c } = dividirClave(k);
    return `${this.tablas[t]?.nombre || '?'}.${c}`;
  }

  usoColumna(i: number, c: string): { joins: number; filtros: number } | null {
    const t = this.tablas[i];
    const u = t ? this.usoEquipo.get(refKey(t.ref)) : null;
    const e = u?.columnas.find((x) => x.c.toLowerCase() === c.toLowerCase());
    return e && (e.joins || e.filtros) ? { joins: e.joins, filtros: e.filtros } : null;
  }

  tituloUso(i: number, c: string): string {
    const u = this.usoColumna(i, c);
    return u ? `El equipo la usa en ${u.filtros} filtro(s) y ${u.joins} unión(es) de sus queries.` : '';
  }

  /** Filtros que el equipo ya usa en las tablas elegidas (para agregarlos con un clic). */
  get filtrosEquipo(): { key: string; texto: string; usos: number }[] {
    const res: { key: string; texto: string; usos: number }[] = [];
    this.tablas.forEach((t, i) => {
      const u = this.usoEquipo.get(refKey(t.ref));
      for (const f of (u?.filtros || []).slice(0, 5)) {
        const info = this.columnaInfo(i, f.c);
        if (info) res.push({ key: clave(i, info.nombre), texto: this.tablas.length > 1 ? `${t.nombre}.${info.nombre}` : info.nombre, usos: f.usos });
      }
    });
    return res.sort((a, b) => b.usos - a.usos).slice(0, 8);
  }

  // ======================= Columnas =======================
  coincideColumna(c: ColumnaDetalle): boolean {
    const q = this.filtroCols.trim().toLowerCase();
    return !q || c.nombre.toLowerCase().includes(q);
  }

  indiceSel(i: number, c: string): number {
    return this.seleccionadas.findIndex((x) => x.t === i && x.c.toLowerCase() === c.toLowerCase());
  }

  alternarColumna(i: number, c: ColumnaDetalle): void {
    const lista = this.seleccionadas;
    const k = this.indiceSel(i, c.nombre);
    if (k >= 0) lista.splice(k, 1);
    else if (this.usaGrupos && lista.length >= 6) { this.mensaje = 'Agrupa por 6 columnas como máximo.'; return; } else lista.push({ t: i, c: c.nombre, alias: '', trunc: '' });
    this.alCambiarSeleccion();
  }

  agregarTodasDe(i: number): void {
    const lista = this.seleccionadas;
    for (const c of this.columnasDe(i)) if (this.coincideColumna(c) && this.indiceSel(i, c.nombre) < 0 && lista.length < (this.usaGrupos ? 6 : 60)) lista.push({ t: i, c: c.nombre, alias: '', trunc: '' });
    this.alCambiarSeleccion();
  }

  quitarSel(k: number): void { this.seleccionadas.splice(k, 1); this.alCambiarSeleccion(); }
  vaciarSel(): void { this.seleccionadas.length = 0; this.alCambiarSeleccion(); }
  moverSel(k: number, d: number): void {
    const l = this.seleccionadas;
    const j = k + d;
    if (j < 0 || j >= l.length) return;
    [l[k], l[j]] = [l[j], l[k]];
    this.programar();
  }
  private alCambiarSeleccion(): void { this.limpiarOrden(); this.programar(); }

  esFecha(x: ColUi): boolean { return this.familiaDe(clave(x.t, x.c)) === 'fecha'; }
  fkTexto(c: ColumnaDetalle): string { return c.fk.length ? `FK → ${c.fk[0].tabla.nombre}` : ''; }
  conteoSel(i: number): number { return this.seleccionadas.filter((x) => x.t === i).length; }

  // ======================= Cálculos (resumir) =======================
  agregarMedida(): void {
    if (this.medidas.length >= 6) return;
    this.medidas = [...this.medidas, { fn: this.medidas.length ? 'sum' : 'count', col: '', alias: '' }];
    this.programar();
  }
  quitarMedida(k: number): void { this.medidas = this.medidas.filter((_, i) => i !== k); this.limpiarOrden(); this.programar(); }
  defFuncion(fn: FuncionMedida): { v: FuncionMedida; t: string; numerica: boolean; conColumna: boolean } { return this.funciones.find((f) => f.v === fn) || this.funciones[0]; }
  cambioFuncion(m: MedidaUi): void { if (!this.defFuncion(m.fn).conColumna) m.col = ''; this.programar(); }

  columnasParaMedida(fn: FuncionMedida): { valor: string; texto: string }[] {
    const num = this.defFuncion(fn).numerica;
    const res: { valor: string; texto: string }[] = [];
    this.tablas.forEach((t, i) => {
      for (const c of this.columnasDe(i)) {
        const fam = familiaTipo(c.tipo);
        if (num && fam !== 'num') continue;
        if ((fn === 'min' || fn === 'max') && fam === 'bit') continue;
        res.push({ valor: clave(i, c.nombre), texto: `${t.nombre}.${c.nombre}` });
      }
    });
    return res;
  }

  nombreMedida(m: MedidaUi): string {
    if (m.alias.trim()) return m.alias.trim();
    const f = this.defFuncion(m.fn);
    if (!f.conColumna) return 'Total';
    return `${f.t} ${m.col ? this.textoClave(m.col) : '…'}`;
  }

  // ======================= Filtros =======================
  operadoresPara(col: string): { v: OperadorFiltro; t: string }[] {
    const fam = col ? this.familiaDe(col) : 'texto';
    return OPERADORES.filter((o) => !o.fams || o.fams.includes(fam)).map((o) => ({ v: o.v, t: (fam === 'fecha' && TEXTO_OP_FECHA[o.v]) || TEXTO_OP[o.v] }));
  }
  nValores(op: OperadorFiltro): 0 | 1 | 2 { return OPERADORES.find((o) => o.v === op)?.n ?? 1; }
  esFechaFiltro(f: FiltroUi): boolean { return !!f.col && this.familiaDe(f.col) === 'fecha'; }
  tipoEntrada(f: FiltroUi): string {
    if (this.esFechaFiltro(f) && ['ge', 'lt', 'entre'].includes(f.op)) return 'date';
    return 'text';
  }
  placeholderValor(f: FiltroUi): string {
    if (f.op === 'en' || f.op === 'noen') return 'valores separados por coma';
    if (f.op === 'ultimosDias') return 'N° de días';
    if (f.op === 'entre') return this.esFechaFiltro(f) ? 'desde' : 'desde (valor)';
    return 'valor';
  }

  private opPorDefecto(col: string): OperadorFiltro { return this.familiaDe(col) === 'fecha' ? 'ultimosDias' : 'eq'; }
  private nuevoGrupo(): number { return this.filtros.reduce((m, f) => Math.max(m, f.g), -1) + 1; }

  agregarFiltro(col = ''): void {
    const op = col ? this.opPorDefecto(col) : 'eq';
    this.filtros = [...this.filtros, { col, op, v: op === 'ultimosDias' ? '7' : '', v2: '', g: this.nuevoGrupo() }];
    this.programar();
  }

  agregarOr(g: number): void {
    const filas = this.filtros.filter((f) => f.g === g);
    const previa = filas[filas.length - 1];
    const nuevo: FiltroUi = { col: previa ? previa.col : '', op: previa ? previa.op : 'eq', v: '', v2: '', g };
    const ultimo = previa ? this.filtros.lastIndexOf(previa) : -1;
    this.filtros = ultimo >= 0 ? [...this.filtros.slice(0, ultimo + 1), nuevo, ...this.filtros.slice(ultimo + 1)] : [...this.filtros, nuevo];
    this.programar();
  }

  quitarFiltro(i: number): void { this.filtros = this.filtros.filter((_, k) => k !== i); this.programar(); }

  cambioColumnaFiltro(f: FiltroUi): void {
    const permitidos = this.operadoresPara(f.col).map((o) => o.v);
    if (!permitidos.includes(f.op)) { f.op = this.opPorDefecto(f.col); f.v = f.op === 'ultimosDias' ? '7' : ''; f.v2 = ''; }
    this.programar();
  }

  cambioOperador(f: FiltroUi): void {
    if (f.op === 'ultimosDias' && !f.v) f.v = '7';
    this.programar();
  }

  fijarPlantilla(f: FiltroUi): void { f.v = '<VALOR>'; if (this.nValores(f.op) === 2) f.v2 = '<VALOR>'; this.programar(); }

  private refrescarGrupos(): void {
    const mapa = new Map<number, GrupoFiltros>();
    this.filtros.forEach((f, i) => {
      let g = mapa.get(f.g);
      if (!g) { g = { g: f.g, filas: [] }; mapa.set(f.g, g); }
      g.filas.push({ f, i });
    });
    this.gruposF = [...mapa.values()].sort((a, b) => a.g - b.g);
  }

  private filtroCompleto(f: FiltroUi): boolean {
    if (!f.col) return false;
    const n = this.nValores(f.op);
    if (n === 0) return true;
    if (!f.v.trim()) return false;
    return n === 1 || !!f.v2.trim();
  }

  get filtrosPendientes(): number { return this.filtros.filter((f) => !this.filtroCompleto(f)).length; }

  // ----- valores frecuentes -----
  private claveValores(f: FiltroUi): string {
    const { t, c } = dividirClave(f.col);
    const tabla = this.tablas[t];
    return tabla ? `${refKey(tabla.ref)}|${c}` : '';
  }

  puedeVerValores(f: FiltroUi): boolean {
    if (!this.puedeEditar || !f.col) return false;
    const fam = this.familiaDe(f.col);
    return fam === 'texto' || fam === 'num' || fam === 'bit' || fam === 'guid';
  }

  estadoValores(f: FiltroUi): EstadoValores | null { return this.valores.get(this.claveValores(f)) || null; }

  cargarValores(f: FiltroUi): void {
    const k = this.claveValores(f);
    if (!k) return;
    const actual = this.valores.get(k);
    if (actual && actual.estado === 'ok') { this.valores.delete(k); return; }
    const { t, c } = dividirClave(f.col);
    this.valores.set(k, { estado: 'cargando' });
    this.servicio.valoresFrecuentes(this.tablas[t].ref, c).subscribe({
      next: (d) => this.valores.set(k, { estado: 'ok', datos: d }),
      error: (e) => this.valores.set(k, { estado: 'error', error: e?.error?.error || 'No se pudieron leer los valores.' }),
    });
  }

  valorUsado(f: FiltroUi, valor: string | null): boolean {
    if (valor === null) return f.op === 'nulo';
    if (f.op === 'en' || f.op === 'noen') return this.listaDe(f.v).includes(valor);
    return f.v === valor;
  }

  private listaDe(v: string): string[] { return v.split(',').map((x) => x.trim()).filter(Boolean); }

  usarValor(f: FiltroUi, valor: string | null): void {
    if (valor === null) { f.op = 'nulo'; f.v = ''; this.programar(); return; }
    if (f.op === 'en' || f.op === 'noen') {
      const l = this.listaDe(f.v);
      const k = l.indexOf(valor);
      if (k >= 0) l.splice(k, 1); else l.push(valor);
      f.v = l.join(', ');
    } else {
      if (!['eq', 'ne'].includes(f.op)) f.op = 'eq';
      f.v = valor;
    }
    this.programar();
  }

  // ======================= Orden =======================
  agregarOrden(): void {
    if (this.orden.length >= 3) return;
    this.orden = [...this.orden, { key: '', dir: 'desc' }];
  }
  quitarOrden(k: number): void { this.orden = this.orden.filter((_, i) => i !== k); this.programar(); }

  get opcionesOrden(): { valor: string; texto: string }[] {
    if (this.modo === 'conteo') return [];
    if (this.usaGrupos) {
      const res = this.grupos.map((g) => ({ valor: `c:${clave(g.t, g.c)}`, texto: this.textoClave(clave(g.t, g.c)) }));
      if (this.modo === 'repetidos') return [{ valor: 'm:0', texto: 'Cuántas veces se repite' }, ...res];
      this.medidas.forEach((m, k) => res.push({ valor: `m:${k}`, texto: this.nombreMedida(m) }));
      return res;
    }
    return this.opcionesColumna.map((o) => ({ valor: `c:${o.valor}`, texto: o.texto }));
  }

  private limpiarOrden(): void {
    const validas = new Set(this.opcionesOrden.map((o) => o.valor));
    this.orden = this.orden.filter((o) => !o.key || validas.has(o.key));
  }

  // ======================= Modo =======================
  cambioModo(m: ModoConstructor): void {
    if (this.modo === m) return;
    this.modo = m;
    if (m === 'agrupado' && !this.medidas.length) this.medidas = [{ fn: 'count', col: '', alias: '' }];
    this.filtroCols = '';
    this.limpiarOrden();
    this.programar();
  }

  programar(): void {
    this.refrescarGrupos();
    this.armarSubject.next();
  }

  // ======================= Config =======================
  configActual(): ConfigConstructor {
    const aCol = (x: ColUi): ColumnaSel => ({ t: x.t, c: x.c, ...(x.alias.trim() ? { alias: x.alias.trim() } : {}), ...(x.trunc && this.esFecha(x) ? { trunc: x.trunc } : {}) });
    const filtros: FiltroConstructor[] = this.filtros.filter((f) => this.filtroCompleto(f)).map((f) => {
      const { t, c } = dividirClave(f.col);
      const n = this.nValores(f.op);
      return { t, c, op: f.op, g: f.g, ...(n >= 1 ? { v: f.v.trim() } : {}), ...(n === 2 ? { v2: f.v2.trim() } : {}) };
    });
    const medidas: MedidaConstructor[] = this.medidas.filter((m) => !this.defFuncion(m.fn).conColumna || m.col).map((m) => {
      const base: MedidaConstructor = { fn: m.fn, ...(m.alias.trim() ? { alias: m.alias.trim() } : {}) };
      if (m.col) { const { t, c } = dividirClave(m.col); base.t = t; base.c = c; }
      return base;
    });
    const orden: OrdenConstructor[] = [];
    for (const o of this.orden) {
      if (!o.key) continue;
      if (o.key.startsWith('m:')) orden.push({ m: parseInt(o.key.slice(2), 10), dir: o.dir });
      else { const { t, c } = dividirClave(o.key.slice(2)); orden.push({ t, c, dir: o.dir }); }
    }
    const cfg: ConfigConstructor = {
      tablas: this.tablas.map((t) => t.ref),
      modo: this.modo,
      columnas: this.modo === 'detalle' ? this.cols.map(aCol) : [],
      agrupar: this.usaGrupos ? this.grupos.map(aCol) : [],
      medidas: this.modo === 'agrupado' ? medidas : [],
      filtros,
      orden,
      top: this.top,
      tipoJoin: this.tipoJoin,
      nolock: this.nolock,
      distinct: this.distinct,
      joinsManuales: this.joinsManuales,
      joinsConfig: this.joinsConfig,
      comentario: this.comentarioSql,
    };
    if (this.modo === 'agrupado' && this.minTotal && this.minTotal >= 2) cfg.minTotal = this.minTotal;
    if (this.nombre.trim()) cfg.nombre = this.nombre.trim();
    if (this.descripcion.trim()) cfg.descripcion = this.descripcion.trim();
    return cfg;
  }

  /** Reemplaza todo el estado por una configuración (receta o query guardado). */
  cargarConfig(c: ConfigConstructor, opciones: { nombre?: string; descripcion?: string } = {}): void {
    const nuevas: TablaSel[] = c.tablas.map((ref) => this.tablas.find((t) => refKey(t.ref) === refKey(ref)) || { ref, nombre: ref.n, bd: ref.bd, esquema: ref.es || null, origen: '' });
    const cambiaron = nuevas.length !== this.tablas.length || nuevas.some((t, i) => refKey(t.ref) !== refKey(this.tablas[i].ref));
    this.tablas = nuevas;
    this.modo = c.modo || 'detalle';
    const aUi = (x: ColumnaSel): ColUi => ({ t: x.t, c: x.c, alias: x.alias || '', trunc: x.trunc || '' });
    this.cols = (c.columnas || []).map(aUi);
    this.grupos = (c.agrupar || []).map(aUi);
    this.medidas = (c.medidas || []).map((m) => ({ fn: m.fn, col: m.c !== undefined && m.c !== null && m.c !== '' ? clave(m.t ?? 0, m.c) : '', alias: m.alias || '' }));
    if (this.modo === 'agrupado' && !this.medidas.length) this.medidas = [{ fn: 'count', col: '', alias: '' }];
    this.minTotal = c.minTotal && c.minTotal >= 2 ? c.minTotal : null;
    const gids = new Map<number, number>();
    this.filtros = (c.filtros || []).map((f, i) => {
      const bruto = Number.isInteger(f.g) ? (f.g as number) : 1000 + i;
      if (!gids.has(bruto)) gids.set(bruto, gids.size);
      return { col: clave(f.t, f.c), op: f.op, v: f.v === undefined || f.v === null ? '' : String(f.v), v2: f.v2 === undefined || f.v2 === null ? '' : String(f.v2), g: gids.get(bruto) as number };
    });
    this.orden = (c.orden || []).map((o) => ('m' in o ? { key: `m:${o.m}`, dir: o.dir } : { key: `c:${clave(o.t, o.c)}`, dir: o.dir }));
    this.top = c.top || 100;
    this.tipoJoin = c.tipoJoin === 'LEFT' ? 'LEFT' : 'INNER';
    this.nolock = c.nolock !== false;
    this.distinct = !!c.distinct;
    this.joinsManuales = c.joinsManuales || [];
    this.joinsConfig = c.joinsConfig || [];
    this.comentarioSql = c.comentario !== false;
    this.nombre = opciones.nombre ?? c.nombre ?? '';
    this.descripcion = opciones.descripcion ?? c.descripcion ?? '';
    this.tablaActiva = 0;
    this.filtroCols = '';
    this.valores.clear();
    for (const t of this.tablas) this.cargarDetalle(t.ref);
    if (cambiaron) this.alCambiarTablas(); else this.programar();
  }

  private aplicarPeticion(p: PeticionConstructor): void {
    if (p.config && p.config.tablas?.length) { this.cargarConfig(p.config, { nombre: p.nombre, descripcion: p.descripcion }); return; }
    this.limpiar();
    for (const ref of p.tablas || []) this.agregarPorRef(ref);
    if (p.nombre) this.nombre = p.nombre;
    if (p.descripcion) this.descripcion = p.descripcion;
  }

  limpiar(): void {
    this.tablas = [];
    this.cols = []; this.grupos = []; this.medidas = []; this.filtros = []; this.orden = []; this.minTotal = null;
    this.joinsManuales = []; this.joinsConfig = []; this.modo = 'detalle'; this.top = 100; this.tipoJoin = 'INNER'; this.distinct = false;
    this.nombre = ''; this.descripcion = ''; this.mensaje = ''; this.filtroCols = ''; this.tablaActiva = 0; this.valores.clear();
    this.armado = null; this.errorArmado = null;
    this.alCambiarTablas();
  }

  usarReceta(r: RecetaQuery): void { this.cargarConfig(r.config, { nombre: this.nombre.trim() ? this.nombre : r.titulo }); }

  // ======================= Uniones =======================
  private fijarJoin(hacia: number, cambio: Partial<JoinConfig>): void {
    const previo = this.joinsConfig.find((x) => x.hacia === hacia);
    const nuevo: JoinConfig = { ...(previo || { hacia }), ...cambio, hacia };
    this.joinsConfig = [...this.joinsConfig.filter((x) => x.hacia !== hacia), nuevo];
    this.programar();
  }
  cambioTipoJoin(j: UnionArmada, tipo: string): void { this.fijarJoin(j.haciaIdx, { tipo: tipo as TipoJoin }); }
  cambioAltJoin(j: UnionArmada, alt: string | number): void { this.fijarJoin(j.haciaIdx, { alt: Number(alt) }); }
  todasLas(tipo: 'INNER' | 'LEFT'): void {
    this.tipoJoin = tipo;
    this.joinsConfig = this.joinsConfig.map((x) => ({ hacia: x.hacia, ...(x.alt !== undefined ? { alt: x.alt } : {}) }));
    this.programar();
  }

  borrador(ref: TablaRef): BorradorUnion {
    const k = refKey(ref);
    if (!this.borradores[k]) this.borradores[k] = { t1: 0, c1: '', c2: '' };
    return this.borradores[k];
  }
  indiceDe(ref: TablaRef): number { return this.tablas.findIndex((t) => refKey(t.ref) === refKey(ref)); }
  agregarUnion(ref: TablaRef): void {
    const b = this.borrador(ref);
    const t2 = this.indiceDe(ref);
    if (t2 < 0 || !b.c1 || !b.c2) return;
    this.joinsManuales = [...this.joinsManuales, { t1: b.t1, c1: b.c1, t2, c2: b.c2 }];
    this.borradores[refKey(ref)] = { t1: 0, c1: '', c2: '' };
    this.programar();
  }
  get unionValida(): boolean { const u = this.nuevaUnion; return u.t1 !== u.t2 && !!u.c1 && !!u.c2 && !!this.tablas[u.t1] && !!this.tablas[u.t2]; }
  agregarUnionLibre(): void {
    if (!this.unionValida) return;
    this.joinsManuales = [...this.joinsManuales, { ...this.nuevaUnion }];
    this.nuevaUnion = { ...this.nuevaUnion, c1: '', c2: '' };
    this.programar();
  }
  quitarUnion(i: number): void { this.joinsManuales = this.joinsManuales.filter((_, k) => k !== i); this.programar(); }
  textoUnion(j: UnionManual): string { return `${this.tablas[j.t1]?.nombre}.${j.c1} = ${this.tablas[j.t2]?.nombre}.${j.c2}`; }

  // ======================= Nombre y salida =======================
  nombreAutomatico(): string {
    const nombres = this.tablas.map((t) => t.nombre);
    if (!nombres.length) return '';
    const base = nombres.length > 2 ? `${nombres[0]} y ${nombres.length - 1} tablas más` : nombres.join(' + ');
    const g = this.grupos.map((x) => x.c).slice(0, 2).join(' y ');
    if (this.modo === 'conteo') return `Cuántos registros de ${base}`.slice(0, 120);
    if (this.modo === 'repetidos') return `Repetidos en ${base}${g ? ` por ${g}` : ''}`.slice(0, 120);
    if (this.modo === 'agrupado') {
      const f = this.grupos.find((x) => x.trunc);
      const nombresTrunc: Record<string, string> = { dia: 'día', mes: 'mes', anio: 'año', hora: 'hora' };
      const por = f && f.trunc ? ` por ${nombresTrunc[f.trunc]}` : '';
      return `Resumen de ${base}${g ? ` por ${g}` : ''}${por}`.slice(0, 120);
    }
    const w = this.filtros.find((f) => this.filtroCompleto(f));
    return `Consulta de ${base}${w ? ` filtrada por ${this.textoClave(w.col).split('.').pop()}` : ''}`.slice(0, 120);
  }

  usarNombreAutomatico(): void { this.nombre = this.nombreAutomatico(); this.programar(); }

  copiar(): void {
    if (!this.armado) return;
    navigator.clipboard.writeText(this.armado.sql).then(() => {
      this.copiado = true;
      if (this.temporizador) clearTimeout(this.temporizador);
      this.temporizador = setTimeout(() => { this.copiado = false; }, 2000);
    }, () => { this.mensaje = 'El navegador no permitió copiar.'; });
  }

  guardarEnRepositorio(): void {
    if (!this.armado) return;
    this.guardar.emit({
      consulta: this.armado.sql,
      titulo: (this.nombre.trim() || this.nombreAutomatico()).slice(0, 200),
      descripcion: this.descripcion.trim() || this.armado.explicacion.slice(1, 3).join(' '),
      config: this.configActual(),
    });
  }

  get resumenConfig(): string {
    const p: string[] = [`${this.tablas.length} tabla(s)`];
    if (this.armado && this.armado.joins.length) p.push(`${this.armado.joins.length} unión(es)`);
    const f = this.filtros.filter((x) => this.filtroCompleto(x)).length;
    if (f) p.push(`${f} filtro(s)`);
    p.push(this.modos.find((m) => m.v === this.modo)?.t || '');
    return p.join(' · ');
  }

  etiquetaOrigen(o: string): string {
    return o === 'fk' ? 'Llave foránea' : o === 'aprendida' ? 'La usa el equipo' : o === 'manual' ? 'La elegiste tú' : 'Deducida por nombres';
  }
  claseOrigen(o: string): string { return o === 'fk' || o === 'manual' ? 'chip-ok' : o === 'aprendida' ? 'chip-marca' : 'chip-media'; }
  trackIdx(i: number): number { return i; }
  trackGrupo(_: number, g: GrupoFiltros): number { return g.g; }
  trackFila(_: number, x: { f: FiltroUi; i: number }): number { return x.i; }
}
