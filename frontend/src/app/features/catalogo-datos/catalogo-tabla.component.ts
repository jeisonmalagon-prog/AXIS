import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CatalogoDatosService, ColumnaDetalle, Grafo, LugaresColumna, MapaQueriesTablaDetalle, TablaDetalle, TablaRef, TablaResumen } from '../../core/services/catalogo-datos.service';
import { CatalogoErComponent } from './catalogo-er.component';

// Detalle de una tabla o vista: diccionario de datos (columnas, tipos, llaves,
// descripciones) y diagrama ER con sus relaciones directas.
@Component({
  selector: 'app-catalogo-tabla',
  standalone: true,
  imports: [CommonModule, FormsModule, CatalogoErComponent],
  templateUrl: './catalogo-tabla.component.html',
  styleUrl: './catalogo-tabla.component.scss',
})
export class CatalogoTablaComponent implements OnChanges {
  @Input({ required: true }) tablaRef!: TablaRef;
  /** Pestaña con la que se abre. */
  @Input() pestanaInicial: 'diccionario' | 'diagrama' = 'diccionario';
  @Output() abrir = new EventEmitter<TablaRef>();
  @Output() cerrar = new EventEmitter<void>();
  /** Abre el repositorio de queries filtrado por esta tabla. */
  @Output() verQueries = new EventEmitter<TablaRef>();
  /** Abre el constructor guiado con esta tabla como punto de partida. */
  @Output() armarQuery = new EventEmitter<TablaRef>();
  /** Abre un query concreto en el repositorio. */
  @Output() abrirQuery = new EventEmitter<number>();

  pestana: 'diccionario' | 'diagrama' | 'queries' = 'diccionario';
  detalle: TablaDetalle | null = null;
  cargando = true;
  error = '';
  filtro = '';
  soloLlaves = false;

  grafo: Grafo | null = null;
  profundidad: 1 | 2 = 1;
  cargandoGrafo = false;
  errorGrafo = '';

  // «¿Dónde más aparece esta columna?»
  columnaAbierta: string | null = null;
  lugares: LugaresColumna | null = null;
  cargandoLugares = false;

  copiado = '';

  // Queries del equipo que usan esta tabla
  qDet: MapaQueriesTablaDetalle | null = null;
  cargandoQ = false;
  errorQ = '';
  private qColumnas = new Map<string, { joins: number; filtros: number }>();

  constructor(private servicio: CatalogoDatosService) {}

  ngOnChanges(c: SimpleChanges): void {
    if (c['tablaRef']) {
      this.pestana = this.pestanaInicial;
      this.profundidad = 1;
      this.filtro = '';
      this.soloLlaves = false;
      this.columnaAbierta = null;
      this.lugares = null;
      this.grafo = null;
      this.qDet = null;
      this.errorQ = '';
      this.qColumnas = new Map();
      this.cargar();
      this.cargarQueries();
      if (this.pestana === 'diagrama') this.cargarGrafo();
    }
  }

  cargar(): void {
    this.cargando = true;
    this.error = '';
    this.servicio.tabla(this.tablaRef).subscribe({
      next: (d) => { this.detalle = d; this.cargando = false; },
      error: (e) => { this.detalle = null; this.cargando = false; this.error = e?.error?.error || 'No se pudo cargar la tabla.'; },
    });
  }

  cargarQueries(): void {
    this.cargandoQ = true;
    const ref = this.tablaRef;
    this.servicio.mapaQueriesTabla(ref).subscribe({
      next: (d) => {
        if (ref !== this.tablaRef) return;
        this.qDet = d.tabla ? d : null;
        this.qColumnas = new Map((d.columnas || []).map((c) => [c.c.toLowerCase(), { joins: c.joins, filtros: c.filtros }]));
        this.cargandoQ = false;
      },
      error: () => { this.cargandoQ = false; this.qDet = null; },   // el diccionario funciona sin queries
    });
  }

  /** Cómo usa el equipo una columna en sus queries (null si no aparece). */
  usoColumna(nombre: string): { joins: number; filtros: number } | null { return this.qColumnas.get(nombre.toLowerCase()) || null; }
  textoUsoColumna(nombre: string): string {
    const u = this.usoColumna(nombre);
    if (!u) return '';
    const p: string[] = [];
    if (u.joins) p.push(`unida en ${u.joins} query(s)`);
    if (u.filtros) p.push(`filtrada en ${u.filtros} query(s)`);
    return `El equipo la usa: ${p.join(' y ')}`;
  }
  get totalQueriesTabla(): number { return this.qDet?.total || 0; }
  etiquetaOps(ops: string[]): string { return ops.slice(0, 3).join(', '); }

  cargarGrafo(): void {
    this.cargandoGrafo = true;
    this.errorGrafo = '';
    this.servicio.grafo(this.tablaRef, this.profundidad).subscribe({
      next: (g) => { this.grafo = g; this.cargandoGrafo = false; },
      error: (e) => { this.cargandoGrafo = false; this.errorGrafo = e?.error?.error || 'No se pudo armar el diagrama.'; },
    });
  }

  irA(p: 'diccionario' | 'diagrama' | 'queries'): void {
    this.pestana = p;
    if (p === 'diagrama' && !this.grafo && !this.cargandoGrafo) this.cargarGrafo();
  }

  cambiarProfundidad(p: 1 | 2): void {
    if (p === this.profundidad) return;
    this.profundidad = p;
    this.cargarGrafo();
  }

  get columnasFiltradas(): ColumnaDetalle[] {
    if (!this.detalle) return [];
    const q = this.filtro.trim().toLowerCase();
    return this.detalle.columnas.filter((c) => {
      if (this.soloLlaves && !c.pk && !c.fk.length && !c.referenciadaPor.length) return false;
      if (!q) return true;
      return c.nombre.toLowerCase().includes(q) || c.tipo.toLowerCase().includes(q) || (c.descripcion || '').toLowerCase().includes(q);
    });
  }

  get nombreCompleto(): string {
    const d = this.detalle;
    if (!d) return '';
    return d.esquema ? `${d.bd}.${d.esquema}.${d.nombre}` : `${d.bd}.${d.nombre}`;
  }

  /** Nombre listo para pegar en una consulta, con el estilo de cada motor. */
  get nombreSql(): string {
    const d = this.detalle;
    if (!d) return '';
    if (d.origen.motor === 'MSSQL') return `[${d.bd}].[${d.esquema || 'dbo'}].[${d.nombre}]`;
    return `\`${d.bd}\`.\`${d.nombre}\``;
  }

  etiquetaTabla(t: { bd: string; esquema: string | null; nombre: string }): string { return t.esquema ? `${t.bd}.${t.esquema}.${t.nombre}` : `${t.bd}.${t.nombre}`; }

  copiar(texto: string, marca: string): void {
    const listo = () => { this.copiado = marca; setTimeout(() => { if (this.copiado === marca) this.copiado = ''; }, 1600); };
    try {
      if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(texto).then(listo, () => this.copiaManual(texto, listo)); return; }
    } catch { /* se intenta el método antiguo */ }
    this.copiaManual(texto, listo);
  }

  private copiaManual(texto: string, listo: () => void): void {
    const ta = document.createElement('textarea');
    ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); listo(); } catch { /* sin permiso para copiar */ }
    document.body.removeChild(ta);
  }

  copiarColumnas(): void {
    if (!this.detalle) return;
    this.copiar(this.detalle.columnas.map((c) => c.nombre).join(',\n'), 'columnas');
  }

  verLugares(c: ColumnaDetalle): void {
    if (this.columnaAbierta === c.nombre) { this.columnaAbierta = null; this.lugares = null; return; }
    this.columnaAbierta = c.nombre;
    this.lugares = null;
    this.cargandoLugares = true;
    this.servicio.lugaresDeColumna(c.nombre, { limite: 60 }).subscribe({
      next: (l) => { this.lugares = l; this.cargandoLugares = false; },
      error: () => { this.cargandoLugares = false; },
    });
  }

  esEsta(l: TablaResumen): boolean {
    const r = this.tablaRef;
    return l.ref.o === r.o && l.ref.bd === r.bd && l.ref.es === r.es && l.ref.n === r.n;
  }

  formatoFilas(n: number | null): string { return n === null || n === undefined ? '—' : n.toLocaleString('es-CO'); }

  trackColumna = (_: number, c: ColumnaDetalle): string => c.nombre;
}
