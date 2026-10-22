import { Component, EventEmitter, Input, Output } from '@angular/core';
import { BarListComponent, ItemBarList } from '../shared/charts/bar-list.component';
import { LineChartComponent, SerieLineaChart } from '../shared/charts/line-chart.component';
import { BloqueResultado, FilaDatos, ValorCelda } from './prospeccion.service';

const RE_NUMERICA = /^(Ax|Cantidad|Total|Prospect|Pendient|Cargados|Registros|Prospecciones|Monto)/i;
const RE_DOCUMENTO = /documento/i;
const PASO = 50;

interface ColumnaVista { clave: string; etiqueta: string; numerica: boolean; documento: boolean; }

// ============================================================================
// Un bloque de resultados de «Monitorear prospección»: título, ayuda, estado (filas / milisegundos), tabla con filtro y
// «mostrar más», y el SQL exacto que se ejecutó (para pegarlo en SSMS). Si la consulta falla o no aplica, muestra el motivo
// sin romper el resto de la pantalla. Los documentos son enlaces a la búsqueda por cliente.
// ============================================================================
@Component({
  selector: 'app-prospeccion-bloque',
  standalone: true,
  imports: [BarListComponent, LineChartComponent],
  templateUrl: './prospeccion-bloque.component.html',
  styleUrl: './prospeccion-bloque.component.scss',
})
export class ProspeccionBloqueComponent {
  @Input() bloque: BloqueResultado | undefined;
  @Input() titulo = '';
  @Input() plegable = false;
  @Input() abierto = true;
  /** Texto cuando la consulta no devuelve filas. */
  @Input() vacio = 'Sin registros para este filtro.';
  @Output() documento = new EventEmitter<string>();
  @Output() cargue = new EventEmitter<string>();

  filtro = '';
  limite = PASO;
  verSql = false;
  copiado = false;
  private copiadoT: ReturnType<typeof setTimeout> | undefined;

  get conAvance(): boolean {
    const c = this.bloque?.columnas.map((x) => x.clave) || [];
    return c.includes('AxTotal') && c.includes('AxProspectados');
  }

  get columnas(): ColumnaVista[] {
    const cols = (this.bloque?.columnas || []).map((c) => ({
      clave: c.clave, etiqueta: this.humanizar(c.etiqueta), numerica: RE_NUMERICA.test(c.clave), documento: RE_DOCUMENTO.test(c.clave),
    }));
    return cols;
  }

  /** «NumeroDocumento» → «Número documento» no se puede inferir; se separa en palabras: «Numero Documento». */
  private humanizar(n: string): string {
    return n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^Id /, 'Id ').replace(/\bID\b/, 'ID');
  }

  get filasFiltradas(): FilaDatos[] {
    const filas = this.bloque?.filas || [];
    const t = this.filtro.trim().toLowerCase();
    if (!t) return filas;
    return filas.filter((f) => Object.values(f).some((v) => v !== null && String(v).toLowerCase().includes(t)));
  }

  get filasVisibles(): FilaDatos[] { return this.filasFiltradas.slice(0, this.limite); }
  get hayMas(): boolean { return this.filasFiltradas.length > this.limite; }
  get mostrarFiltro(): boolean { return (this.bloque?.filas.length || 0) > 10; }
  get abre(): boolean { return !this.plegable || this.abierto; }

  /** Gráfica de barras: primera columna = nombre, última = valor (la hora se muestra como «15:00»). */
  get itemsBarras(): ItemBarList[] {
    const cols = this.bloque?.columnas || [];
    if (cols.length < 2) return [];
    const nombre = cols[0].clave;
    const valor = cols[cols.length - 1].clave;
    return (this.bloque?.filas || []).map((f) => ({
      nombre: nombre === 'Hora' ? `${String(f[nombre]).padStart(2, '0')}:00` : this.fmt(f[nombre], nombre),
      total: Number(f[valor] || 0),
      texto: Number(f[valor] || 0).toLocaleString('es-CO'),
    }));
  }

  /** Serie diaria: primera columna = etiqueta (día), las demás son series. */
  get serieLineas(): { etiquetas: string[]; series: SerieLineaChart[] } {
    const cols = this.bloque?.columnas || [];
    const filas = this.bloque?.filas || [];
    const colores = ['var(--ax-chart-series-1)', 'var(--ax-chart-series-2)', 'var(--ax-chart-series-3)', 'var(--ax-chart-series-4)'];
    return {
      etiquetas: filas.map((f) => String(f[cols[0]?.clave] ?? '').slice(5)),
      series: cols.slice(1).map((c, i) => ({ nombre: c.etiqueta, colorVar: colores[i % colores.length], valores: filas.map((f) => Number(f[c.clave] || 0)) })),
    };
  }

  get comoGrafica(): 'barras' | 'serie' | null {
    if (!this.bloque?.ok || !this.bloque.filas.length) return null;
    if (this.bloque.vista === 'barras' && this.bloque.columnas.length >= 2) return 'barras';
    if (this.bloque.vista === 'serie' && this.bloque.filas.length >= 2 && this.bloque.columnas.length >= 2) return 'serie';
    return null;
  }

  alternar(): void { if (this.plegable) this.abierto = !this.abierto; }
  masFilas(): void { this.limite += PASO; }
  filtrar(valor: string): void { this.filtro = valor; this.limite = PASO; }

  fmt(v: ValorCelda | undefined, clave: string): string {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (typeof v === 'number' && RE_NUMERICA.test(clave)) return v.toLocaleString('es-CO');
    return String(v);
  }

  avance(f: FilaDatos): number {
    const total = Number(f['AxTotal'] || 0);
    const hechos = Number(f['AxProspectados'] || 0);
    return total > 0 ? Math.min(100, Math.round((hechos / total) * 100)) : 0;
  }

  idFila(f: FilaDatos): string | null {
    const c = this.bloque?.columnaId;
    const v = c ? f[c] : null;
    return v === null || v === undefined ? null : String(v);
  }

  abrirFila(f: FilaDatos): void {
    const id = this.idFila(f);
    if (this.bloque?.clic === 'cargue' && id) this.cargue.emit(id);
  }

  abrirDocumento(ev: Event, f: FilaDatos, clave: string): void {
    ev.stopPropagation();
    const v = f[clave];
    if (v !== null && v !== undefined && /^[A-Za-z0-9]{3,20}$/.test(String(v))) this.documento.emit(String(v));
  }

  esEnlace(clave: string, v: ValorCelda | undefined): boolean {
    return RE_DOCUMENTO.test(clave) && v !== null && v !== undefined && /^[A-Za-z0-9]{3,20}$/.test(String(v));
  }

  async copiar(): Promise<void> {
    const sql = this.bloque?.sql;
    if (!sql) return;
    try { await navigator.clipboard.writeText(sql); this.copiado = true; } catch { this.copiado = false; }
    clearTimeout(this.copiadoT);
    this.copiadoT = setTimeout(() => { this.copiado = false; }, 2500);
  }

  trackFila = (i: number): number => i;
}
