import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { ProspeccionBloqueComponent } from '../monitoreo/prospeccion-bloque.component';
import { BrebService, Hallazgo, Latencias, PasoFlujo, RespuestaLogDetalle, RespuestaTransaccion } from './breb.service';

export type ModoDetalle = 'trx' | 'log';

interface TramoVista { codigo: string; hora: string; pasoMs: number; desdeInicioMs: number; ancho: number; inicio: number; lento: boolean; }

// ============================================================================
// Detalle en un panel lateral: una transacción (SQL Server + recorrido en logs + latencias) o un registro de log (Rq/Rs limpios).
// Todo llega con los datos personales ocultos; aquí solo se muestra.
// ============================================================================
@Component({
  selector: 'app-breb-detalle',
  standalone: true,
  imports: [ProspeccionBloqueComponent],
  templateUrl: './breb-detalle.component.html',
  styleUrl: './breb-detalle.component.scss',
})
export class BrebDetalleComponent implements OnChanges, OnDestroy {
  @Input() modo: ModoDetalle = 'trx';
  /** CUS (modo trx) o código de registro (modo log). */
  @Input() id: string | null = null;
  @Output() cerrar = new EventEmitter<void>();
  @Output() verLog = new EventEmitter<string>();
  @Output() verTransaccion = new EventEmitter<string>();

  trx: RespuestaTransaccion | null = null;
  log: RespuestaLogDetalle | null = null;
  cargando = false;
  error: string | null = null;
  copiado = false;
  private sub: Subscription | undefined;
  private copiadoT: ReturnType<typeof setTimeout> | undefined;

  constructor(private svc: BrebService) {}

  ngOnChanges(c: SimpleChanges): void {
    if (c['id'] || c['modo']) this.cargar();
  }
  ngOnDestroy(): void { this.sub?.unsubscribe(); clearTimeout(this.copiadoT); }

  private msg(e: unknown): string {
    if (e instanceof HttpErrorResponse) return e.status === 0 ? 'No hay respuesta del servidor de AXIS.' : e.error?.error || 'No se pudo consultar el detalle.';
    return 'No se pudo consultar el detalle.';
  }

  private cargar(): void {
    this.sub?.unsubscribe();
    this.trx = null;
    this.log = null;
    this.error = null;
    if (!this.id) return;
    this.cargando = true;
    const fin = () => { this.cargando = false; };
    if (this.modo === 'trx') {
      this.sub = this.svc.transaccion(this.id).subscribe({ next: (r) => { this.trx = r; fin(); }, error: (e) => { this.error = this.msg(e); fin(); } });
    } else {
      this.sub = this.svc.logDetalle(this.id).subscribe({ next: (r) => { this.log = r; fin(); }, error: (e) => { this.error = this.msg(e); fin(); } });
    }
  }

  async copiar(texto: string | null | undefined): Promise<void> {
    if (!texto) return;
    try { await navigator.clipboard.writeText(texto); this.copiado = true; } catch { this.copiado = false; }
    clearTimeout(this.copiadoT);
    this.copiadoT = setTimeout(() => { this.copiado = false; }, 2000);
  }

  nivelTexto(n: Hallazgo['nivel']): string { return ({ alto: 'Atención', medio: 'Revisar', info: 'Info', ok: 'Todo bien' } as Record<string, string>)[n] || n; }

  estadoPaso(p: PasoFlujo): string {
    return ({ ok: 'Correcto', error: 'Con error', falta: 'No aparece', info: 'Sin registros' } as Record<string, string>)[p.estado] || p.estado;
  }

  claseEstadoTrx(): string {
    const c = this.trx?.estado?.clase;
    return c === 'Aprobada' ? 'ok' : c === 'Rechazada' ? 'mal' : c === 'Pendiente' ? 'pend' : 'neutro';
  }

  duracion(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} s`;
    return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
  }

  /** Línea de tiempo T110…T540: cada tramo se dibuja con el ancho proporcional a su duración. */
  tramos(l: Latencias | null | undefined): TramoVista[] {
    if (!l || !l.puntos.length || l.totalMs <= 0) return [];
    return l.puntos.map((p) => ({
      codigo: p.codigo, hora: p.hora, pasoMs: p.pasoMs, desdeInicioMs: p.desdeInicioMs,
      inicio: Math.max(0, (p.desdeInicioMs - p.pasoMs) / l.totalMs * 100), ancho: Math.max(1.2, p.pasoMs / l.totalMs * 100),
      lento: !!l.mayorTramo && l.mayorTramo.a === p.codigo && l.mayorTramo.ms >= 1000,
    }));
  }

  get monto(): string | null {
    const m = this.trx?.monto;
    return m === null || m === undefined ? null : `$${Math.round(m).toLocaleString('es-CO')}`;
  }
}
