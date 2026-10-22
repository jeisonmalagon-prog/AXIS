import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NumEsPipe } from './num-es.pipe';
import { EstadoTablero, TablaEtl, fmtFechaLarga, hace } from './tablero.service';

interface Celda { dia: string; estado: 'ok' | 'falta' | 'hoy'; }

// Estado de los datos: qué tan al día está el ETL que alimenta todo el tablero.
@Component({
  selector: 'app-movil-tab-estado',
  standalone: true,
  imports: [NumEsPipe, CommonModule],
  styleUrl: './tab-estado.component.scss',
  template: `
    <div class="error-banner" *ngIf="error">{{ error }}</div>
    <div class="vacio" *ngIf="noDisponible">{{ noDisponible }}</div>
    <div class="carga-inicial" *ngIf="cargando && !estado">Revisando el estado de los datos…</div>

    <ng-container *ngIf="estado">
      <section class="banner-estado banner-estado--{{ estado.semaforo }}">
        <span class="banner-estado__punto" aria-hidden="true"></span>
        <div>
          <strong>{{ titulo }}</strong>
          <span>{{ subtitulo }}</span>
        </div>
        <button type="button" class="btn-secundario btn-mini" (click)="refrescar.emit()" [disabled]="cargando">{{ cargando ? 'Revisando…' : 'Revisar ahora' }}</button>
      </section>

      <section class="rejilla-2">
        <div class="panel-diagrama">
          <div class="panel-diagrama__cabecera"><div><h2>Semáforo</h2><p class="sub">Cada pieza que necesita el tablero para estar al día</p></div></div>
          <ul class="semaforo">
            <li *ngFor="let i of estado.items">
              <span class="luz luz--{{ i.estado }}" [attr.aria-label]="i.estado"></span>
              <div><strong>{{ i.titulo }}</strong><span>{{ i.detalle }}</span></div>
            </li>
          </ul>
        </div>

        <div class="panel-diagrama">
          <div class="panel-diagrama__cabecera"><div><h2>Proceso ETL</h2><p class="sub">Calcula los resúmenes diarios a partir de los logs de la app</p></div></div>
          <dl class="datos-etl">
            <div><dt>Estado</dt><dd>{{ estado.etl.enCurso ? 'Calculando ahora' : 'En espera' }}</dd></div>
            <div><dt>Último ciclo correcto</dt><dd>{{ hace(estado.etl.ultimoOk) }}</dd></div>
            <div><dt>Frecuencia</dt><dd>Cada {{ estado.etl.intervaloMin }} min</dd></div>
            <div><dt>Ciclos desde el último reinicio</dt><dd>{{ estado.etl.ciclos }}</dd></div>
            <div><dt>Servidor iniciado</dt><dd>{{ hace(estado.etl.arrancado) }}</dd></div>
            <div><dt>Cobertura de 30 días</dt><dd>{{ estado.cobertura.conDato }} de {{ estado.cobertura.dias }}</dd></div>
          </dl>
          <p class="etl-error" *ngIf="estado.etl.ultimoError">Último error{{ estado.etl.ultimoErrorEn ? ' (' + hace(estado.etl.ultimoErrorEn) + ')' : '' }}: {{ estado.etl.ultimoError }}</p>
          <h3 class="subtit">Últimos 30 días</h3>
          <div class="calendario" role="img" aria-label="Cobertura de los últimos 30 días">
            <span *ngFor="let c of celdas" class="celda celda--{{ c.estado }}" [title]="fechaLarga(c.dia) + (c.estado === 'falta' ? ': sin datos' : (c.estado === 'hoy' ? ': hoy (parcial)' : ': completo'))"></span>
          </div>
          <div class="leyenda">
            <span><i class="punto celda--ok"></i>Con datos</span>
            <span><i class="punto celda--hoy"></i>Hoy (parcial)</span>
            <span><i class="punto celda--falta"></i>Sin datos</span>
          </div>
        </div>
      </section>

      <section class="panel-diagrama">
        <div class="panel-diagrama__cabecera"><div><h2>Tablas del ETL</h2><p class="sub">Dónde se guarda lo que ves en este tablero (base BIC_CERTI_MARIA)</p></div></div>
        <div class="tabla-scroll">
          <table>
            <thead><tr><th>Tabla</th><th>Contenido</th><th>Estado</th><th class="num">Filas (aprox.)</th><th>Datos desde – hasta</th><th class="num">Tamaño</th></tr></thead>
            <tbody>
              <tr *ngFor="let t of estado.tablas">
                <td class="mono">{{ t.tabla }}</td>
                <td>{{ t.descripcion }}</td>
                <td><span class="pill" [class.pill--ok]="t.existe" [class.pill--error]="!t.existe">{{ t.existe ? 'Creada' : 'Falta' }}</span></td>
                <td class="num">{{ t.existe ? (t.filasAprox | numEs) : '—' }}</td>
                <td class="mono">{{ corto(t.desde) }} → {{ corto(t.hasta) }}</td>
                <td class="num">{{ tamano(t) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="nota" *ngIf="faltantes.length">Faltan {{ faltantes.length }} tabla(s). Pide al administrador de base de datos que ejecute los scripts <span class="mono">crear_tablas_rollup_app_movil_BIC_CERTI_MARIA.sql</span>, <span class="mono">agregar_rollup_por_cliente_app_movil.sql</span> y <span class="mono">crear_tablas_analisis_app_movil_BIC_CERTI_MARIA.sql</span>, una sola vez.</p>
      </section>

      <section class="panel-diagrama como-funciona">
        <div class="panel-diagrama__cabecera"><div><h2>Cómo se calculan estos datos</h2></div></div>
        <ul>
          <li><strong>Hoy</strong> se recalcula cada {{ estado.etl.intervaloMin }} minutos; por eso los números del día están siempre un poco atrasados y son parciales hasta medianoche.</li>
          <li><strong>Ayer</strong> se calcula una vez y queda guardado. Si falta alguno de los últimos 180 días, el sistema rellena hasta 5 por ciclo, empezando por los más recientes.</li>
          <li>Los <strong>usuarios únicos</strong> de un día son exactos. Al sumar varios días, quien entró en varios días cuenta una vez por día.</li>
          <li>La <strong>latencia</strong> solo incluye llamadas con registro de inicio y de fin. Se promedia ponderando por el número de llamadas.</li>
          <li>Los <strong>datos por cliente</strong> se conservan 180 días y el ranking de clientes cubre como máximo 31.</li>
          <li>Este tablero nunca consulta la tabla de logs en vivo: lee solo estos resúmenes, así no le suma carga al servicio.</li>
        </ul>
      </section>
    </ng-container>
  `
})
export class TabEstadoComponent {
  @Input() estado: EstadoTablero | null = null;
  @Input() cargando = false;
  @Input() error: string | null = null;
  @Input() noDisponible: string | null = null;
  @Output() refrescar = new EventEmitter<void>();

  readonly hace = hace;
  readonly fechaLarga = fmtFechaLarga;

  get titulo(): string {
    switch (this.estado?.semaforo) {
      case 'ok': return 'Todo al día';
      case 'aviso': return 'Hay avisos para revisar';
      default: return 'Hay datos con problemas';
    }
  }
  get subtitulo(): string {
    const n = (this.estado?.items || []).filter((i) => i.estado !== 'ok');
    if (!n.length) return 'El ETL está calculando con normalidad y todas las tablas tienen datos recientes.';
    return n.map((i) => i.titulo).join(' · ');
  }
  get faltantes(): TablaEtl[] { return (this.estado?.tablas || []).filter((t) => !t.existe); }

  get celdas(): Celda[] {
    if (!this.estado) return [];
    const faltan = new Set(this.estado.cobertura.faltantes);
    const out: Celda[] = [];
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const p = (n: number) => String(n).padStart(2, '0');
    const ymd = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    for (let i = this.estado.cobertura.dias - 1; i >= 0; i--) {
      const d = new Date(hoy.getTime() - i * 86400000);
      const k = ymd(d);
      out.push({ dia: k, estado: i === 0 ? 'hoy' : faltan.has(k) ? 'falta' : 'ok' });
    }
    return out;
  }

  corto(v: string | null | undefined): string { return v ? v.slice(0, 16).replace('T', ' ').replace(/ 00:00$/, '') : '—'; }
  tamano(t: TablaEtl): string {
    if (!t.existe || t.bytes === undefined) return '—';
    const b = t.bytes;
    if (b >= 1048576) return `${(b / 1048576).toLocaleString('es-CO', { maximumFractionDigits: 1 })} MB`;
    return `${Math.max(1, Math.round(b / 1024)).toLocaleString('es-CO')} KB`;
  }
}
