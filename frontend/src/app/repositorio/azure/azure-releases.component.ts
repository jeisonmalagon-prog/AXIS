import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StackedBarChartComponent, SerieBarrasApiladas } from '../../shared/charts/stacked-bar-chart.component';
import { BarListComponent, ItemBarList } from '../../shared/charts/bar-list.component';
import { AzureBase } from './azure-base';
import { AzureFalloComponent } from './azure-fallo.component';
import { FalloAzure, claseAmbiente, claseTasa, descargarCsv, falloDe, fmtDiaCorto, fmtDuracion, fmtFecha, fmtNum, fmtPct, fmtRelativo } from './azure-utils';
import { IcoComponent } from '../../shared/ico/ico.component';

type SubVista = 'releases' | 'definiciones' | 'despliegues' | 'estadisticas';

@Component({
  selector: 'app-azure-releases',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule, AzureFalloComponent, StackedBarChartComponent, BarListComponent],
  templateUrl: './azure-releases.component.html',
  styleUrl: './azure-releases.component.scss',
})
export class AzureReleasesComponent extends AzureBase {
  readonly fmtFecha = fmtFecha; readonly fmtRelativo = fmtRelativo; readonly fmtDuracion = fmtDuracion; readonly fmtNum = fmtNum; readonly fmtPct = fmtPct;
  readonly claseAmbiente = claseAmbiente; readonly claseTasa = claseTasa;

  vista: SubVista = 'releases';
  cargandoVista = false;
  falloVista: FalloAzure | null = null;

  definiciones: any[] | null = null;
  releases: any[] = [];
  despliegues: any[] = [];
  est: any = null;

  dias = 60; definicion = ''; estadoDespliegue = '';
  diasEst = 60;
  estEtq: string[] = [];
  estSeries: SerieBarrasApiladas[] = [];
  estDefs: ItemBarList[] = [];
  estAutores: ItemBarList[] = [];

  abierto: any = null;
  det: any = null;
  detCargando = false;
  detFallo: FalloAzure | null = null;

  protected alCambiarRepo(): void { this.definiciones = null; this.est = null; this.cargarVista(); }

  cambiarVista(v: SubVista): void { this.vista = v; this.cargarVista(); }

  cargarVista(): void {
    this.falloVista = null;
    if (!this.definiciones) this.pedirDefiniciones();
    if (this.vista === 'releases') this.cargarReleases();
    if (this.vista === 'despliegues') this.cargarDespliegues();
    if (this.vista === 'estadisticas' && !this.est) this.cargarEstadisticas();
  }

  private pedirDefiniciones(): void {
    this.api.get<any>('/releases/definiciones', {}, false).subscribe({
      next: (r) => (this.definiciones = r.definiciones),
      error: (e) => { this.definiciones = []; if (this.vista === 'definiciones') this.falloVista = falloDe(e, 'No se pudieron cargar las definiciones.'); },
    });
  }

  filtrar(): void { this.cargarVista(); }

  cargarReleases(): void {
    this.cargandoVista = true;
    this.api.get<any>('/releases', { dias: this.dias, definicion: this.definicion, limite: 100 }, false).subscribe({
      next: (r) => { this.releases = r.releases; this.cargandoVista = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudieron cargar los releases.'); this.cargandoVista = false; },
    });
  }

  cargarDespliegues(): void {
    this.cargandoVista = true;
    this.api.get<any>('/releases/despliegues', { dias: this.dias, definicion: this.definicion, estado: this.estadoDespliegue, limite: 150 }, false).subscribe({
      next: (r) => { this.despliegues = r.despliegues; this.cargandoVista = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudieron cargar los despliegues.'); this.cargandoVista = false; },
    });
  }

  cambiarDiasEst(d: number): void { this.diasEst = d; this.est = null; this.cargarEstadisticas(); }

  cargarEstadisticas(): void {
    this.cargandoVista = true;
    this.api.get<any>('/releases/estadisticas', { dias: this.diasEst }, false).subscribe({
      next: (r) => {
        this.est = r; this.cargandoVista = false;
        if (r.despliegues?.datos) {
          const d = r.despliegues.datos;
          this.estEtq = d.porDia.map((x: any) => fmtDiaCorto(x.fecha));
          this.estSeries = [
            { nombre: 'Exitosos', colorVar: 'var(--ax-chart-ok)', valores: d.porDia.map((x: any) => x.exitosos) },
            { nombre: 'Fallidos', colorVar: 'var(--ax-chart-danger)', valores: d.porDia.map((x: any) => x.fallidos) },
          ];
        }
        if (r.releases?.datos) {
          this.estDefs = r.releases.datos.porDefinicion.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
          this.estAutores = r.releases.datos.porAutor.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
        }
      },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudieron calcular las estadísticas.'); this.cargandoVista = false; },
    });
  }

  exportar(): void {
    descargarCsv('despliegues.csv', [['Release', 'Pipeline', 'Ambiente', 'Estado', 'Inicio', 'Duración (s)', 'Solicitó'],
      ...this.despliegues.map((d) => [d.release, d.definicion, d.ambiente, d.estadoTexto, d.inicio, d.duracionMs !== null ? Math.round(d.duracionMs / 1000) : '', d.solicitadoPor])]);
  }

  abrir(r: any): void {
    this.abierto = r; this.det = null; this.detFallo = null; this.detCargando = true;
    this.api.get<any>(`/releases/${r.id}`, {}, false).subscribe({
      next: (d) => { this.det = d; this.detCargando = false; },
      error: (e) => { this.detFallo = falloDe(e, 'No se pudo cargar el release.'); this.detCargando = false; },
    });
  }
  cerrar(): void { this.abierto = null; this.det = null; }

  claseAprobacion(e: string): string { return e === 'approved' ? 'est-ok' : e === 'rejected' ? 'est-mal' : e === 'pending' ? 'est-aviso' : 'est-nulo'; }
  claseTarea(e: string): string { return e === 'succeeded' ? 'est-ok' : e === 'failed' || e === 'rejected' ? 'est-mal' : e === 'inProgress' ? 'est-info' : 'est-nulo'; }
}
