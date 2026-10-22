import { Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NumEsPipe } from './num-es.pipe';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { LatenciaTableroResponse, RangoApp, ServicioLatencia, TableroService, fmtCompacto, fmtFechaCorta, fmtSeg } from './tablero.service';
import { SparklineComponent } from './graficos-tablero';
import { SaludGlobalComponent } from '../app-movil-logs/salud-global.component';

type Filtro = 'todos' | 'lentos' | 'empeoran' | 'fallan';
type Clave = 'nombre' | 'llamadas' | 'promedio' | 'maximo' | 'delta' | 'exito' | 'total';

// Servicios y latencia: ranking de servicios por tiempo de respuesta con su
// tendencia día a día. Sale del ETL (promedio ponderado por llamadas medidas).
// Los percentiles p50/p90/p95 en vivo siguen disponibles abajo (muestra reciente de LogApp).
@Component({
  selector: 'app-movil-tab-servicios',
  standalone: true,
  imports: [NumEsPipe, CommonModule, FormsModule, RouterLink, SparklineComponent, SaludGlobalComponent],
  styleUrl: './tab-servicios.component.scss',
  template: `
    <div class="error-banner" *ngIf="error">{{ error }}</div>
    <div class="vacio" *ngIf="noDisponible">{{ noDisponible }}</div>
    <div class="carga-inicial" *ngIf="cargando && !datos">Calculando latencia…</div>

    <ng-container *ngIf="datos">
      <div [class.atenuado]="cargando">
        <section class="kpis kpis--4">
          <article class="kpi" [class.kpi--ok]="tonoGlobal === 'ok'" [class.kpi--warn]="tonoGlobal === 'warn'" [class.kpi--error]="tonoGlobal === 'error'">
            <div class="kpi__cab"><span class="kpi__etiqueta">Tiempo promedio</span></div>
            <div class="kpi__cuerpo"><span class="kpi__valor">{{ fmtSeg(datos.promedioGlobal) }}</span></div>
            <span class="kpi__pie">{{ datos.llamadasMedidas | numEs }} llamadas medidas</span>
          </article>
          <article class="kpi" [class.kpi--error]="lentos > 0" [class.kpi--ok]="lentos === 0">
            <div class="kpi__cab"><span class="kpi__etiqueta">Servicios lentos</span></div>
            <div class="kpi__cuerpo"><span class="kpi__valor">{{ lentos }}</span></div>
            <span class="kpi__pie">Más de {{ datos.umbrales.critico }} s de promedio</span>
          </article>
          <article class="kpi" [class.kpi--warn]="empeoran > 0" [class.kpi--ok]="empeoran === 0">
            <div class="kpi__cab"><span class="kpi__etiqueta">Empeorando</span></div>
            <div class="kpi__cuerpo"><span class="kpi__valor">{{ empeoran }}</span></div>
            <span class="kpi__pie">≥ 30% más lentos que antes</span>
          </article>
          <article class="kpi">
            <div class="kpi__cab"><span class="kpi__etiqueta">Servicios medidos</span></div>
            <div class="kpi__cuerpo"><span class="kpi__valor">{{ datos.servicios.length }}</span></div>
            <span class="kpi__pie">{{ fmtFechaCorta(datos.rango.inicio) }} – {{ fmtFechaCorta(datos.rango.fin) }}</span>
          </article>
        </section>

        <section class="panel-diagrama">
          <div class="panel-diagrama__cabecera">
            <div>
              <h2>Ranking de servicios</h2>
              <p class="sub">Tiempo de respuesta medido desde que arranca la llamada hasta que termina. Verde: menos de {{ datos.umbrales.aviso }} s · ámbar: hasta {{ datos.umbrales.critico }} s · rojo: más de {{ datos.umbrales.critico }} s.</p>
            </div>
          </div>

          <div class="herramientas barra-tabla">
            <div class="zoom" role="group" aria-label="Filtro de servicios">
              <button type="button" *ngFor="let f of filtros" [class.activo]="filtro === f.valor" (click)="filtro = f.valor">{{ f.etiqueta }}<span class="n" *ngIf="contar(f.valor) !== null"> {{ contar(f.valor) }}</span></button>
            </div>
            <input class="buscar" type="search" placeholder="Buscar servicio…" [(ngModel)]="texto" aria-label="Buscar servicio">
          </div>

          <div class="tabla-scroll" *ngIf="filas.length; else sinFilas">
            <table>
              <thead>
                <tr>
                  <th class="orden" (click)="ordenar('nombre')">Servicio{{ flecha('nombre') }}</th>
                  <th class="orden num" (click)="ordenar('promedio')">Promedio{{ flecha('promedio') }}</th>
                  <th class="orden num" (click)="ordenar('delta')" title="Frente al período anterior de la misma duración">Cambio{{ flecha('delta') }}</th>
                  <th>Tendencia</th>
                  <th class="orden num" (click)="ordenar('maximo')">Máximo{{ flecha('maximo') }}</th>
                  <th class="orden num" (click)="ordenar('llamadas')">Medidas{{ flecha('llamadas') }}</th>
                  <th class="orden num" (click)="ordenar('exito')">Éxito{{ flecha('exito') }}</th>
                </tr>
              </thead>
              <tbody>
                <ng-container *ngFor="let s of filas">
                  <tr class="fila-clic" (click)="alternar(s)" [class.fila-abierta]="abierto === clave(s)">
                    <td>
                      <div class="fn-nombre"><span class="chev" [class.chev--abierto]="abierto === clave(s)">›</span>{{ s.nombre }}</div>
                      <div class="mono fn-tec">{{ s.clase }}.{{ s.metodo }}</div>
                    </td>
                    <td class="num"><span class="pill" [class.pill--ok]="s.estado === 'ok'" [class.pill--warn]="s.estado === 'aviso'" [class.pill--error]="s.estado === 'critico'">{{ fmtSeg(s.promedio) }}</span></td>
                    <td class="num">
                      <span *ngIf="s.deltaPct !== null; else sinDelta" class="cambio" [class.cambio--mal]="s.empeora || (s.deltaPct > 10)" [class.cambio--bien]="s.deltaPct < -10">
                        {{ s.deltaPct > 0 ? '▲' : (s.deltaPct < 0 ? '▼' : '=') }} {{ s.deltaPct < 0 ? -s.deltaPct : s.deltaPct | numEs }}%
                      </span>
                      <ng-template #sinDelta><span class="suave">—</span></ng-template>
                    </td>
                    <td><app-sparkline [valores]="s.serie" [ancho]="110" [alto]="28" [color]="s.estado === 'critico' ? 'var(--ax-chart-danger, #ef4444)' : 'var(--ax-brand-primary, #673ab7)'"></app-sparkline></td>
                    <td class="num mono">{{ fmtSeg(s.maximo) }}</td>
                    <td class="num">{{ s.llamadasMedidas | numEs }}</td>
                    <td class="num"><span *ngIf="s.tasaExito !== null; else sinTasa" class="pill" [class.pill--ok]="(s.tasaExito || 0) >= 98" [class.pill--warn]="(s.tasaExito || 0) >= 95 && (s.tasaExito || 0) < 98" [class.pill--error]="(s.tasaExito || 0) < 95">{{ s.tasaExito }}%</span><ng-template #sinTasa><span class="suave">—</span></ng-template></td>
                  </tr>
                  <tr class="fila-detalle" *ngIf="abierto === clave(s)">
                    <td colspan="7">
                      <div class="detalle-serv">
                        <div class="detalle-serv__grafico">
                          <strong>Promedio diario</strong>
                          <app-sparkline [valores]="s.serie" [ancho]="460" [alto]="72" [color]="s.estado === 'critico' ? 'var(--ax-chart-danger, #ef4444)' : 'var(--ax-brand-primary, #673ab7)'"></app-sparkline>
                          <div class="rango-eje"><span>{{ fmtFechaCorta(datos.dias[0]) }}</span><span>{{ fmtFechaCorta(datos.dias[datos.dias.length - 1]) }}</span></div>
                        </div>
                        <dl class="datos-serv">
                          <div><dt>Mejor día</dt><dd>{{ mejorPeor(s).mejor }}</dd></div>
                          <div><dt>Peor día</dt><dd>{{ mejorPeor(s).peor }}</dd></div>
                          <div><dt>Período anterior</dt><dd>{{ fmtSeg(s.promedioAnterior) }}</dd></div>
                          <div><dt>Transacciones</dt><dd>{{ s.total | numEs }} <small>({{ s.errores | numEs }} con error)</small></dd></div>
                        </dl>
                        <div class="acciones-serv">
                          <a class="btn-secundario btn-mini" [routerLink]="['/app-movil-logs']" [queryParams]="{ metodo: s.metodo }">Ver logs de este servicio</a>
                        </div>
                      </div>
                    </td>
                  </tr>
                </ng-container>
              </tbody>
            </table>
          </div>
          <ng-template #sinFilas><div class="vacio-int">{{ datos.servicios.length ? 'Ningún servicio coincide con el filtro.' : 'Todavía no hay latencia medida para este rango.' }}</div></ng-template>
          <p class="nota">Solo se miden las llamadas que tienen fila de inicio y de fin. «Medidas» es cuántas entraron al promedio. «Cambio» compara con el período inmediatamente anterior de la misma duración.</p>
        </section>
      </div>
    </ng-container>

    <section class="panel-diagrama en-vivo">
      <div class="panel-diagrama__cabecera">
        <div>
          <h2>Medición en vivo</h2>
          <p class="sub">Percentiles p50 / p90 / p95 por servicio y nodo, sobre la última ventana de logs. Consulta la muestra reciente de LogApp, por eso solo se calcula cuando lo pides.</p>
        </div>
        <button type="button" class="btn-secundario btn-mini" (click)="verVivo = !verVivo">{{ verVivo ? 'Ocultar' : 'Mostrar medición en vivo' }}</button>
      </div>
      <app-salud-global *ngIf="verVivo" subInicial="latencia"></app-salud-global>
    </section>
  `
})
export class TabServiciosComponent implements OnInit, OnChanges, OnDestroy {
  @Input() rango: RangoApp = { dias: 7 };
  @Input() refresco = 0;

  cargando = false;
  error: string | null = null;
  noDisponible: string | null = null;
  datos: LatenciaTableroResponse | null = null;
  filtro: Filtro = 'todos';
  texto = '';
  orden: Clave = 'promedio';
  desc = true;
  abierto: string | null = null;
  verVivo = false;

  readonly filtros: { valor: Filtro; etiqueta: string }[] = [
    { valor: 'todos', etiqueta: 'Todos' }, { valor: 'lentos', etiqueta: 'Sobre el umbral' },
    { valor: 'empeoran', etiqueta: 'Empeoran' }, { valor: 'fallan', etiqueta: 'Con más errores' }
  ];
  readonly fmtSeg = fmtSeg;
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
    this.s = this.tablero.latencia(this.rango).subscribe({
      next: (r) => {
        if (r.disponible) this.datos = r; else { this.datos = null; this.noDisponible = r.mensaje; }
        this.cargando = false;
      },
      error: (e) => { this.error = e?.error?.error || 'No se pudo calcular la latencia.'; this.cargando = false; }
    });
  }

  get lentos(): number { return (this.datos?.servicios || []).filter((s) => s.estado === 'critico').length; }
  get empeoran(): number { return (this.datos?.servicios || []).filter((s) => s.empeora).length; }
  get tonoGlobal(): 'ok' | 'warn' | 'error' | '' {
    const g = this.datos?.promedioGlobal;
    if (g === null || g === undefined) return '';
    return g >= (this.datos as LatenciaTableroResponse).umbrales.critico ? 'error' : g >= (this.datos as LatenciaTableroResponse).umbrales.aviso ? 'warn' : 'ok';
  }

  contar(f: Filtro): number | null {
    const l = this.datos?.servicios || [];
    if (f === 'lentos') return l.filter((s) => s.estado !== 'ok').length;
    if (f === 'empeoran') return l.filter((s) => s.empeora).length;
    if (f === 'fallan') return l.filter((s) => s.tasaExito !== null && s.tasaExito < 95).length;
    return l.length;
  }

  get filas(): ServicioLatencia[] {
    let l = [...(this.datos?.servicios || [])];
    if (this.filtro === 'lentos') l = l.filter((s) => s.estado !== 'ok');
    else if (this.filtro === 'empeoran') l = l.filter((s) => s.empeora);
    else if (this.filtro === 'fallan') l = l.filter((s) => s.tasaExito !== null && s.tasaExito < 95);
    const q = this.texto.trim().toLowerCase();
    if (q) l = l.filter((s) => `${s.nombre} ${s.clase} ${s.metodo}`.toLowerCase().includes(q));
    const dir = this.desc ? -1 : 1;
    const v = (s: ServicioLatencia): number | string => {
      switch (this.orden) {
        case 'nombre': return s.nombre.toLowerCase();
        case 'llamadas': return s.llamadasMedidas;
        case 'maximo': return s.maximo ?? -1;
        case 'delta': return s.deltaPct ?? -9999;
        case 'exito': return s.tasaExito ?? 101;
        case 'total': return s.total;
        default: return s.promedio ?? -1;
      }
    };
    l.sort((a, b) => { const x = v(a); const y = v(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    return l;
  }

  ordenar(c: Clave): void {
    if (this.orden === c) this.desc = !this.desc;
    else { this.orden = c; this.desc = c !== 'nombre' && c !== 'exito'; }
  }
  flecha(c: Clave): string { return this.orden === c ? (this.desc ? ' ↓' : ' ↑') : ''; }
  clave(s: ServicioLatencia): string { return `${s.clase}.${s.metodo}`; }
  alternar(s: ServicioLatencia): void { this.abierto = this.abierto === this.clave(s) ? null : this.clave(s); }

  mejorPeor(s: ServicioLatencia): { mejor: string; peor: string } {
    const dias = this.datos?.dias || [];
    let mi = -1; let ma = -1;
    s.serie.forEach((v, i) => {
      if (v === null) return;
      if (mi < 0 || v < (s.serie[mi] as number)) mi = i;
      if (ma < 0 || v > (s.serie[ma] as number)) ma = i;
    });
    const f = (i: number) => (i < 0 ? '—' : `${fmtFechaCorta(dias[i])}: ${fmtSeg(s.serie[i])}`);
    return { mejor: f(mi), peor: f(ma) };
  }
}
