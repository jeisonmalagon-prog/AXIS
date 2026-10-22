import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LineChartComponent, SerieLineaChart } from '../../shared/charts/line-chart.component';
import { DonutChartComponent, SegmentoDonut } from '../../shared/charts/donut-chart.component';
import { BarListComponent, ItemBarList } from '../../shared/charts/bar-list.component';
import { AzureBase } from './azure-base';
import { AzureFalloComponent } from './azure-fallo.component';
import { FalloAzure, descargarCsv, falloDe, fmtDec, fmtDiaCorto, fmtFecha, fmtNum, fmtPct, fmtRelativo, iniciales } from './azure-utils';
import { IcoComponent } from '../../shared/ico/ico.component';

type SubVista = 'resumen' | 'items' | 'sprints' | 'consultas';

@Component({
  selector: 'app-azure-boards',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule, AzureFalloComponent, LineChartComponent, DonutChartComponent, BarListComponent],
  templateUrl: './azure-boards.component.html',
  styleUrl: './azure-boards.component.scss',
})
export class AzureBoardsComponent extends AzureBase {
  readonly fmtFecha = fmtFecha; readonly fmtRelativo = fmtRelativo; readonly fmtNum = fmtNum; readonly fmtPct = fmtPct; readonly fmtDec = fmtDec; readonly iniciales = iniciales;

  vista: SubVista = 'resumen';
  cargandoVista = false;
  falloVista: FalloAzure | null = null;

  // Resumen
  dias = 30;
  resumen: any = null;
  estados: SegmentoDonut[] = [];
  tipos: ItemBarList[] = [];
  asignados: ItemBarList[] = [];
  prioridades: ItemBarList[] = [];
  semEtq: string[] = [];
  semSeries: SerieLineaChart[] = [];

  // Work items
  fTipo = ''; fEstado = ''; fAsignado = ''; fIteracion = ''; fTexto = ''; fEtiqueta = ''; fAbiertos = false; fDias = '';
  items: any[] = [];
  totalItems = 0;
  limitado = false;

  // Detalle de work item
  abierto: any = null;
  det: any = null;
  detCargando = false;
  detFallo: FalloAzure | null = null;

  // Sprints
  sprints: any = null;
  sprint: any = null;
  sprintDet: any = null;
  sprintCargando = false;
  sprintFallo: FalloAzure | null = null;
  filtroSprint: 'todos' | 'actual' | 'futuro' | 'pasado' = 'todos';

  // Consultas
  consultas: any[] | null = null;
  consultaAbierta: any = null;
  consultaItems: any[] = [];
  consultaCargando = false;

  private readonly colores = ['var(--ax-chart-series-1)', 'var(--ax-chart-series-2)', 'var(--ax-chart-ok)', 'var(--ax-chart-warn)', 'var(--ax-chart-danger)'];

  protected alCambiarRepo(): void { this.resumen = null; this.sprints = null; this.consultas = null; this.cargarVista(); }

  cambiarVista(v: SubVista): void { this.vista = v; this.cargarVista(); }

  cargarVista(): void {
    this.falloVista = null;
    if (!this.resumen) this.cargarResumen(this.vista === 'resumen');
    if (this.vista === 'items') this.cargarItems();
    if (this.vista === 'sprints' && !this.sprints) this.cargarSprints();
    if (this.vista === 'consultas' && !this.consultas) this.cargarConsultas();
  }

  cambiarDias(d: number): void { this.dias = d; this.cargarResumen(true); }

  cargarResumen(mostrar: boolean): void {
    if (mostrar) this.cargandoVista = true;
    this.api.get<any>('/boards/resumen', { dias: this.dias }, false).subscribe({
      next: (r) => {
        this.resumen = r; this.cargandoVista = false;
        const e = r.estadisticas;
        this.estados = e.porEstado.slice(0, 5).map((x: any, i: number) => ({ etiqueta: x.nombre, valor: x.cantidad, colorVar: this.colores[i % this.colores.length] }));
        this.tipos = e.porTipo.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
        this.asignados = e.porAsignado.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
        this.prioridades = e.porPrioridad.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
        this.semEtq = e.porSemana.map((x: any) => fmtDiaCorto(x.semana));
        this.semSeries = [
          { nombre: 'Creados', colorVar: 'var(--ax-chart-series-1)', valores: e.porSemana.map((x: any) => x.creados) },
          { nombre: 'Cerrados', colorVar: 'var(--ax-chart-ok)', valores: e.porSemana.map((x: any) => x.cerrados) },
        ];
      },
      error: (e) => { this.cargandoVista = false; if (mostrar) this.falloVista = falloDe(e, 'No se pudieron cargar los work items.'); },
    });
  }

  // ---- Work items
  get opcionesTipo(): string[] { return (this.resumen?.estadisticas.porTipo || []).map((x: any) => x.nombre); }
  get opcionesEstado(): string[] { return (this.resumen?.estadisticas.porEstado || []).map((x: any) => x.nombre); }
  get opcionesAsignado(): string[] { return (this.resumen?.estadisticas.porAsignado || []).map((x: any) => x.nombre).filter((n: string) => n !== 'Sin asignar'); }
  get opcionesIteracion(): string[] { return (this.sprints?.iteraciones || []).map((x: any) => x.ruta); }

  buscarItems(): void { this.cargarItems(); }
  limpiarItems(): void { this.fTipo = this.fEstado = this.fAsignado = this.fIteracion = this.fTexto = this.fEtiqueta = this.fDias = ''; this.fAbiertos = false; this.cargarItems(); }

  cargarItems(): void {
    if (!this.sprints) this.api.get<any>('/boards/sprints', {}, false).subscribe({ next: (r) => (this.sprints = r), error: () => {} });
    this.cargandoVista = true; this.falloVista = null;
    this.api.get<any>('/boards/items', {
      tipo: this.fTipo, estado: this.fEstado, asignado: this.fAsignado, iteracion: this.fIteracion, texto: this.fTexto.trim(), etiqueta: this.fEtiqueta.trim(),
      abiertos: this.fAbiertos ? 'true' : '', dias: this.fDias, limite: 100,
    }, false).subscribe({
      next: (r) => { this.items = r.items; this.totalItems = r.total; this.limitado = r.limitado; this.cargandoVista = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudieron cargar los work items.'); this.cargandoVista = false; },
    });
  }

  exportar(): void {
    descargarCsv('work-items.csv', [['Id', 'Título', 'Tipo', 'Estado', 'Asignado', 'Prioridad', 'Puntos', 'Iteración', 'Creado', 'Cambiado'],
      ...this.items.map((i) => [i.id, i.titulo, i.tipo, i.estado, i.asignado, i.prioridad, i.puntos, i.iteracion, i.creado, i.cambiado])]);
  }

  abrir(i: any): void {
    this.abierto = i; this.det = null; this.detFallo = null; this.detCargando = true;
    this.api.get<any>(`/boards/items/${i.id}`, {}, false).subscribe({
      next: (d) => { this.det = d; this.detCargando = false; },
      error: (e) => { this.detFallo = falloDe(e, 'No se pudo cargar el work item.'); this.detCargando = false; },
    });
  }
  cerrar(): void { this.abierto = null; this.det = null; }

  abrirRelacionado(r: any): void { if (r.clase === 'workitem') this.abrir({ id: Number(r.id), titulo: r.titulo || `#${r.id}`, tipo: r.tipoItem, estado: r.estado, url: r.url }); }

  // ---- Sprints
  cargarSprints(): void {
    this.cargandoVista = true;
    this.api.get<any>('/boards/sprints', {}, false).subscribe({
      next: (r) => { this.sprints = r; this.cargandoVista = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudieron cargar los sprints.'); this.cargandoVista = false; },
    });
  }

  get sprintsFiltrados(): any[] {
    if (!this.sprints) return [];
    return this.sprints.iteraciones.filter((s: any) => this.filtroSprint === 'todos' || s.estado === this.filtroSprint);
  }

  abrirSprint(s: any): void {
    this.sprint = s; this.sprintDet = null; this.sprintFallo = null; this.sprintCargando = true;
    this.api.get<any>('/boards/sprints/detalle', { ruta: s.ruta }, false).subscribe({
      next: (r) => { this.sprintDet = r; this.sprintCargando = false; },
      error: (e) => { this.sprintFallo = falloDe(e, 'No se pudo cargar el sprint.'); this.sprintCargando = false; },
    });
  }
  cerrarSprint(): void { this.sprint = null; this.sprintDet = null; }

  progresoTiempo(s: any): number | null {
    if (!s?.inicio || !s?.fin) return null;
    const ini = new Date(s.inicio).getTime(); const fin = new Date(s.fin).getTime();
    return Math.max(0, Math.min(100, Math.round(((Date.now() - ini) / (fin - ini)) * 100)));
  }

  // ---- Consultas guardadas
  cargarConsultas(): void {
    this.cargandoVista = true;
    this.api.get<any>('/boards/consultas', {}, false).subscribe({
      next: (r) => { this.consultas = r.consultas; this.cargandoVista = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudieron cargar las consultas.'); this.cargandoVista = false; },
    });
  }

  ejecutarConsulta(c: any): void {
    this.consultaAbierta = c; this.consultaItems = []; this.consultaCargando = true;
    this.api.get<any>(`/boards/consultas/${c.id}`, {}, false).subscribe({
      next: (r) => { this.consultaItems = r.items; this.consultaCargando = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudo ejecutar la consulta.'); this.consultaCargando = false; },
    });
  }

  claseEstadoItem(e: string | null): string {
    const s = (e || '').toLowerCase();
    if (['closed', 'done', 'completed', 'resolved', 'cerrado', 'terminado'].includes(s)) return 'est-ok';
    if (['active', 'doing', 'in progress', 'committed', 'activo', 'en curso'].includes(s)) return 'est-info';
    if (['removed', 'eliminado'].includes(s)) return 'est-nulo';
    return 'est-aviso';
  }
  clasePrioridad(p: number | null): string { return p === 1 ? 'chip-alta' : p === 2 ? 'chip-media' : ''; }
  claseSprint(e: string): string { return e === 'actual' ? 'est-info' : e === 'futuro' ? 'est-aviso' : 'est-nulo'; }
  textoSprint(e: string): string { return ({ actual: 'En curso', futuro: 'Próximo', pasado: 'Terminado', sinFechas: 'Sin fechas' } as Record<string, string>)[e] || e; }
}
