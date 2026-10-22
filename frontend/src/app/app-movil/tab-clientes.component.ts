import { Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NumEsPipe } from './num-es.pipe';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ClienteTop, ClientesTableroResponse, RangoApp, TableroService, fmtCompacto, fmtFechaCorta } from './tablero.service';

type Lista = 'activos' | 'errores' | 'tasa';

// Clientes: quién usa más la app y a quién le fallan más las cosas. Sale del
// resumen diario por cliente del ETL (no consulta LogApp). Se acota a 31 días
// para cuidar la base: es una tabla con una fila por cliente por día.
@Component({
  selector: 'app-movil-tab-clientes',
  standalone: true,
  imports: [NumEsPipe, CommonModule, RouterLink],
  styleUrl: './tab-clientes.component.scss',
  template: `
    <div class="error-banner" *ngIf="error">{{ error }}</div>
    <div class="vacio" *ngIf="noDisponible">{{ noDisponible }}</div>
    <div class="carga-inicial" *ngIf="cargando && !datos">Calculando clientes…</div>

    <ng-container *ngIf="datos">
      <div [class.atenuado]="cargando">
        <p class="aviso-rango" *ngIf="datos.recortado">Por rendimiento, esta vista cubre como máximo {{ datos.rango.dias }} días: del {{ fmtFechaCorta(datos.rango.inicio) }} al {{ fmtFechaCorta(datos.rango.fin) }}.</p>

        <section class="kpis">
          <article class="kpi">
            <div class="kpi__cab"><span class="kpi__etiqueta">Clientes activos</span></div>
            <div class="kpi__cuerpo"><span class="kpi__valor">{{ datos.resumen.clientes | numEs }}</span></div>
            <span class="kpi__pie">{{ fmtFechaCorta(datos.rango.inicio) }} – {{ fmtFechaCorta(datos.rango.fin) }}</span>
          </article>
          <article class="kpi">
            <div class="kpi__cab"><span class="kpi__etiqueta">Uso promedio</span></div>
            <div class="kpi__cuerpo"><span class="kpi__valor">{{ datos.resumen.promedioPorCliente | numEs:1 }}</span></div>
            <span class="kpi__pie">transacciones por cliente</span>
          </article>
          <article class="kpi" [class.kpi--warn]="datos.resumen.porcentajeConErrores >= 50" [class.kpi--ok]="datos.resumen.porcentajeConErrores < 20">
            <div class="kpi__cab"><span class="kpi__etiqueta">Clientes con algún error</span></div>
            <div class="kpi__cuerpo"><span class="kpi__valor">{{ datos.resumen.porcentajeConErrores | numEs:1 }}%</span></div>
            <span class="kpi__pie">{{ datos.resumen.clientesConErrores | numEs }} de {{ datos.resumen.clientes | numEs }}</span>
          </article>
          <article class="kpi" [class.kpi--warn]="datos.resumen.concentracionTop10 >= 40">
            <div class="kpi__cab"><span class="kpi__etiqueta">Concentración de errores</span></div>
            <div class="kpi__cuerpo"><span class="kpi__valor">{{ datos.resumen.concentracionTop10 | numEs:1 }}%</span></div>
            <span class="kpi__pie">de los errores vienen de 10 clientes</span>
          </article>
        </section>

        <section class="panel-diagrama">
          <div class="panel-diagrama__cabecera">
            <div>
              <h2>Ranking de clientes</h2>
              <p class="sub">{{ descripcion }}</p>
            </div>
          </div>
          <div class="subpestanas subpestanas--compactas" role="tablist">
            <button type="button" class="subpestana" role="tab" *ngFor="let l of listas" [class.activa]="lista === l.valor" [attr.aria-selected]="lista === l.valor" (click)="lista = l.valor">{{ l.etiqueta }}</button>
          </div>

          <div class="tabla-scroll" *ngIf="filas.length; else vacioLista">
            <table>
              <thead>
                <tr><th class="num">#</th><th>Documento (CC)</th><th class="num">Transacciones</th><th class="num">Errores</th><th class="num">% error</th><th class="num">Días activo</th><th></th></tr>
              </thead>
              <tbody>
                <tr *ngFor="let c of filas; let i = index">
                  <td class="num suave">{{ i + 1 }}</td>
                  <td class="mono">{{ c.documento }}</td>
                  <td class="num"><div class="celda-barra"><span>{{ c.total | numEs }}</span><i [style.width.%]="(c.total / maxTotal) * 100"></i></div></td>
                  <td class="num" [class.txt-error]="c.errores > 0">{{ c.errores | numEs }}</td>
                  <td class="num"><span class="pill" [class.pill--ok]="c.tasaError < 2" [class.pill--warn]="c.tasaError >= 2 && c.tasaError < 10" [class.pill--error]="c.tasaError >= 10">{{ c.tasaError | numEs:1 }}%</span></td>
                  <td class="num">{{ c.dias }}</td>
                  <td><a class="btn-detalle" [routerLink]="['/app-movil-logs']" [queryParams]="{ documento: c.documento }">Ver recorrido</a></td>
                </tr>
              </tbody>
            </table>
          </div>
          <ng-template #vacioLista><div class="vacio-int">No hay clientes que cumplan este criterio en el rango.</div></ng-template>
          <p class="nota">Los documentos se muestran completos; cada consulta de un cliente en «Ver recorrido» queda en la auditoría general.</p>
        </section>
      </div>
    </ng-container>
  `
})
export class TabClientesComponent implements OnInit, OnChanges, OnDestroy {
  @Input() rango: RangoApp = { dias: 7 };
  @Input() refresco = 0;

  cargando = false;
  error: string | null = null;
  noDisponible: string | null = null;
  datos: ClientesTableroResponse | null = null;
  lista: Lista = 'errores';
  readonly listas: { valor: Lista; etiqueta: string }[] = [
    { valor: 'activos', etiqueta: 'Más activos' },
    { valor: 'errores', etiqueta: 'Más errores' },
    { valor: 'tasa', etiqueta: 'Mayor % de error' }
  ];
  readonly fmtCompacto = fmtCompacto;
  readonly fmtFechaCorta = fmtFechaCorta;
  private s?: Subscription;

  constructor(private tablero: TableroService) {}

  ngOnInit(): void { this.cargar(); }
  ngOnChanges(c: SimpleChanges): void {
    if ((c['rango'] && !c['rango'].firstChange) || (c['refresco'] && !c['refresco'].firstChange)) this.cargar();
  }
  ngOnDestroy(): void { this.s?.unsubscribe(); }

  cargar(): void {
    this.s?.unsubscribe();
    this.cargando = true; this.error = null; this.noDisponible = null;
    this.s = this.tablero.clientes(this.rango, 20).subscribe({
      next: (r) => { if (r.disponible) this.datos = r; else { this.datos = null; this.noDisponible = r.mensaje; } this.cargando = false; },
      error: (e) => { this.error = e?.error?.error || 'No se pudo calcular la actividad por cliente.'; this.cargando = false; }
    });
  }

  get filas(): ClienteTop[] {
    if (!this.datos) return [];
    return this.lista === 'activos' ? this.datos.masActivos : this.lista === 'errores' ? this.datos.masErrores : this.datos.mayorTasaError;
  }
  get maxTotal(): number { return Math.max(1, ...this.filas.map((c) => c.total)); }
  get descripcion(): string {
    return this.lista === 'activos' ? 'Los clientes con más transacciones en el rango.'
      : this.lista === 'errores' ? 'Los clientes a los que más les fallaron las llamadas, en cantidad de errores.'
      : 'Los clientes con mayor proporción de errores (mínimo 20 transacciones, para evitar casos sin significado).';
  }
}
