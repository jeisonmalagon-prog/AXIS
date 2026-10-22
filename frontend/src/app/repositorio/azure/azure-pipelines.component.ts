import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StackedBarChartComponent, SerieBarrasApiladas } from '../../shared/charts/stacked-bar-chart.component';
import { BarListComponent, ItemBarList } from '../../shared/charts/bar-list.component';
import { AzureBase } from './azure-base';
import { AzureFalloComponent } from './azure-fallo.component';
import {
  FalloAzure, claseGrupo, claseTasa, claseTimeline, descargarCsv, falloDe, fmtDiaCorto, fmtDuracion, fmtFecha, fmtBytes, fmtNum, fmtPct, fmtRelativo, iniciales, textoGrupo, textoTimeline,
} from './azure-utils';
import { IcoComponent } from '../../shared/ico/ico.component';

type SubVista = 'ejecuciones' | 'pipelines' | 'estadisticas' | 'pruebas';

interface PasoTimeline { nodo: any; nivel: number; }

@Component({
  selector: 'app-azure-pipelines',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule, AzureFalloComponent, StackedBarChartComponent, BarListComponent],
  templateUrl: './azure-pipelines.component.html',
  styleUrl: './azure-pipelines.component.scss',
})
export class AzurePipelinesComponent extends AzureBase {
  readonly fmtFecha = fmtFecha; readonly fmtRelativo = fmtRelativo; readonly fmtDuracion = fmtDuracion; readonly fmtNum = fmtNum; readonly fmtPct = fmtPct; readonly fmtBytes = fmtBytes;
  readonly claseGrupo = claseGrupo; readonly textoGrupo = textoGrupo; readonly claseTasa = claseTasa; readonly iniciales = iniciales;
  readonly claseTimeline = claseTimeline; readonly textoTimeline = textoTimeline;

  vista: SubVista = 'ejecuciones';
  cargandoVista = false;
  falloVista: FalloAzure | null = null;

  // --- Ejecuciones
  dias = 30; resultado = ''; estado = ''; motivo = ''; definicion = ''; rama = ''; solicitante = '';
  ejecuciones: any[] = [];
  continuacion: string | null = null;
  masCargando = false;
  definiciones: any[] | null = null;

  // --- Detalle de una ejecución
  abierta: any = null;
  det: any = null;
  detCargando = false;
  detFallo: FalloAzure | null = null;
  pasos: PasoTimeline[] = [];
  logAbierto: { id: number; nombre: string } | null = null;
  logTexto = '';
  logInfo = '';
  logCargando = false;
  logFallo: FalloAzure | null = null;

  // --- Detalle de definición
  defAbierta: any = null;
  defDet: any = null;
  defCargando = false;
  defFallo: FalloAzure | null = null;

  // --- Estadísticas
  diasEst = 30;
  est: any = null;
  estEtq: string[] = [];
  estSeries: SerieBarrasApiladas[] = [];
  estRamas: ItemBarList[] = [];
  estMotivos: ItemBarList[] = [];
  estSolicitantes: ItemBarList[] = [];

  // --- Pruebas
  pruebas: any = null;
  runAbierto: number | null = null;
  runDet: any = null;
  runCargando = false;

  protected alCambiarRepo(): void {
    this.definiciones = null; this.est = null; this.pruebas = null;
    this.cargarDefiniciones();
    this.cargarVista();
  }

  cambiarVista(v: SubVista): void { this.vista = v; this.cargarVista(); }

  cargarVista(): void {
    this.falloVista = null;
    if (this.vista === 'ejecuciones') this.cargarEjecuciones(true);
    if (this.vista === 'pipelines' && !this.definiciones) this.cargarDefiniciones(true);
    if (this.vista === 'estadisticas' && !this.est) this.cargarEstadisticas();
    if (this.vista === 'pruebas' && !this.pruebas) this.cargarPruebas();
  }

  private cargarDefiniciones(mostrarError = false): void {
    this.api.get<any>('/pipelines/definiciones', {}, false).subscribe({
      next: (r) => (this.definiciones = r.definiciones),
      error: (e) => { this.definiciones = []; if (mostrarError) this.falloVista = falloDe(e, 'No se pudieron cargar los pipelines.'); },
    });
  }

  // ---- Ejecuciones
  filtrar(): void { this.cargarEjecuciones(true); }
  limpiar(): void { this.resultado = this.estado = this.motivo = this.definicion = this.rama = this.solicitante = ''; this.dias = 30; this.filtrar(); }

  cargarEjecuciones(reiniciar: boolean): void {
    if (reiniciar) { this.cargandoVista = true; this.falloVista = null; this.ejecuciones = []; this.continuacion = null; } else { this.masCargando = true; }
    this.api.get<any>('/pipelines/ejecuciones', {
      dias: this.dias, resultado: this.resultado, estado: this.estado, motivo: this.motivo, definicion: this.definicion, rama: this.rama.trim(), solicitante: this.solicitante.trim(),
      limite: 50, continuacion: reiniciar ? '' : this.continuacion,
    }, false).subscribe({
      next: (r) => { this.ejecuciones = reiniciar ? r.ejecuciones : [...this.ejecuciones, ...r.ejecuciones]; this.continuacion = r.continuacion; this.cargandoVista = false; this.masCargando = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudieron cargar las ejecuciones.'); this.cargandoVista = false; this.masCargando = false; },
    });
  }

  exportar(): void {
    descargarCsv('ejecuciones-pipelines.csv', [['Número', 'Pipeline', 'Resultado', 'Rama', 'Commit', 'Motivo', 'Solicitado por', 'Inicio', 'Duración (s)', 'Espera (s)'],
      ...this.ejecuciones.map((b) => [b.numero, b.definicion, b.resultadoTexto || b.estadoTexto, b.rama, b.commit, b.motivoTexto, b.solicitadoPor, b.inicio, b.duracionMs !== null ? Math.round(b.duracionMs / 1000) : '', b.esperaMs !== null ? Math.round(b.esperaMs / 1000) : ''])]);
  }

  abrir(b: any): void {
    this.abierta = b; this.det = null; this.detFallo = null; this.detCargando = true; this.pasos = []; this.logAbierto = null; this.logTexto = '';
    this.api.get<any>(`/pipelines/ejecuciones/${b.id}`, {}, false).subscribe({
      next: (d) => { this.det = d; this.pasos = this.aplanar(d.etapas || [], 0, []); this.detCargando = false; },
      error: (e) => { this.detFallo = falloDe(e, 'No se pudo cargar la ejecución.'); this.detCargando = false; },
    });
  }
  cerrar(): void { this.abierta = null; this.det = null; this.logAbierto = null; }

  private aplanar(nodos: any[], nivel: number, salida: PasoTimeline[]): PasoTimeline[] {
    for (const n of nodos) { salida.push({ nodo: n, nivel }); this.aplanar(n.hijos || [], nivel + 1, salida); }
    return salida;
  }

  verLog(n: any, ultimas = 3000): void {
    if (!this.abierta || n.logId === null) return;
    if (this.logAbierto?.id === n.logId && ultimas === 3000) { this.logAbierto = null; return; }
    this.logAbierto = { id: n.logId, nombre: n.nombre }; this.logTexto = ''; this.logInfo = ''; this.logFallo = null; this.logCargando = true;
    this.api.get<any>(`/pipelines/ejecuciones/${this.abierta.id}/logs/${n.logId}`, { ultimas }, false).subscribe({
      next: (r) => { this.logTexto = r.texto; this.logInfo = r.truncado ? `Mostrando las últimas ${fmtNum(r.lineasMostradas)} de ${fmtNum(r.lineasTotales)} líneas.` : `${fmtNum(r.lineasTotales)} líneas.`; this.logCargando = false; },
      error: (e) => { this.logFallo = falloDe(e, 'No se pudo leer el registro.'); this.logCargando = false; },
    });
  }

  masLog(): void {
    const l = this.logAbierto;
    if (!l) return;
    this.verLog({ logId: l.id, nombre: l.nombre }, 10000);
  }

  abrirPorId(id: number): void {
    this.abrir({ id, numero: String(id), definicion: 'Ejecución', grupo: 'otro', rama: '', solicitadoPor: '', url: null });
  }

  // ---- Definiciones
  abrirDef(d: any): void {
    this.defAbierta = d; this.defDet = null; this.defFallo = null; this.defCargando = true;
    this.api.get<any>(`/pipelines/definiciones/${d.id}`, {}, false).subscribe({
      next: (r) => { this.defDet = r; this.defCargando = false; },
      error: (e) => { this.defFallo = falloDe(e, 'No se pudo cargar el pipeline.'); this.defCargando = false; },
    });
  }
  cerrarDef(): void { this.defAbierta = null; this.defDet = null; }

  verEjecucionesDe(d: any): void { this.definicion = String(d.id); this.cerrarDef(); this.vista = 'ejecuciones'; this.filtrar(); }

  // ---- Estadísticas
  cambiarDiasEst(d: number): void { this.diasEst = d; this.est = null; this.cargarEstadisticas(); }

  cargarEstadisticas(): void {
    this.cargandoVista = true; this.falloVista = null;
    this.api.get<any>('/pipelines/estadisticas', { dias: this.diasEst }, false).subscribe({
      next: (r) => {
        this.est = r;
        const e = r.estadisticas;
        this.estEtq = e.porDia.map((x: any) => fmtDiaCorto(x.fecha));
        this.estSeries = [
          { nombre: 'Exitosos', colorVar: 'var(--ax-chart-ok)', valores: e.porDia.map((x: any) => x.exitosos) },
          { nombre: 'Fallidos', colorVar: 'var(--ax-chart-danger)', valores: e.porDia.map((x: any) => x.fallidos) },
          { nombre: 'Otros', colorVar: 'var(--ax-chart-warn)', valores: e.porDia.map((x: any) => x.otros) },
        ];
        this.estRamas = e.porRama.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
        this.estMotivos = e.porMotivo.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
        this.estSolicitantes = e.porSolicitante.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
        this.cargandoVista = false;
      },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudieron calcular las estadísticas.'); this.cargandoVista = false; },
    });
  }

  // ---- Pruebas
  cargarPruebas(): void {
    this.cargandoVista = true; this.falloVista = null;
    this.api.get<any>('/pipelines/pruebas', {}, false).subscribe({
      next: (r) => { this.pruebas = r; this.cargandoVista = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudieron cargar las pruebas.'); this.cargandoVista = false; },
    });
  }

  verRun(r: any): void {
    if (this.runAbierto === r.id) { this.runAbierto = null; return; }
    this.runAbierto = r.id; this.runDet = null; this.runCargando = true;
    this.api.get<any>(`/pipelines/pruebas/${r.id}`, {}, false).subscribe({
      next: (d) => { this.runDet = d; this.runCargando = false; },
      error: (e) => { this.runDet = { fallos: [], errorFallos: falloDe(e, 'No se pudo cargar.').error }; this.runCargando = false; },
    });
  }

  duracion(ms: number | null): string { return fmtDuracion(ms); }
  tipoPaso(t: string): string { return ({ Stage: 'Etapa', Job: 'Trabajo', Task: 'Paso' } as Record<string, string>)[t] || t; }
}
