import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CausaError, copiarTexto, formatearDuracion, pct } from './analisis-comun';
import { PasosAnalisisComponent } from './pasos-analisis.component';

const ETIQUETA_CATEGORIA: Record<string, string> = {
  timeout: 'Tiempo agotado', error: 'Error', sin_datos: 'Sin datos', http: 'Error HTTP', app: 'Mensaje de la app', ok: 'Correcto'
};

/**
 * Ficha de una causa de error agrupada (error masivo o alerta): qué falló, a
 * cuántos clientes, desde cuándo, en qué nodos/versiones/plataformas, línea de
 * tiempo, muestras (CC y transacción ACE) y la traducción del código.
 */
@Component({
  selector: 'app-causa-error',
  standalone: true,
  imports: [CommonModule, PasosAnalisisComponent],
  templateUrl: './causa-error.component.html',
  styleUrl: './causa-error.component.scss'
})
export class CausaErrorComponent {
  @Input({ required: true }) causa!: CausaError;
  @Input() abierta = false;

  verClientes = false;
  copiado = false;
  private temporizador?: ReturnType<typeof setTimeout>;

  readonly formatearDuracion = formatearDuracion;
  readonly pct = pct;

  alternar(): void { this.abierta = !this.abierta; }

  categoria(c: string): string { return ETIQUETA_CATEGORIA[c] ?? c; }

  get maxMinuto(): number {
    return Math.max(1, ...(this.causa.porMinuto ?? []).map((m) => m.n));
  }

  alturaBarra(n: number): number { return Math.max(6, Math.round((n / this.maxMinuto) * 100)); }

  get listaClientes(): string {
    return (this.causa.clientes ?? []).join('\n');
  }

  async copiarClientes(): Promise<void> {
    if (await copiarTexto(this.listaClientes)) {
      this.copiado = true;
      if (this.temporizador) clearTimeout(this.temporizador);
      this.temporizador = setTimeout(() => { this.copiado = false; }, 2000);
    }
  }

  async copiarResumen(): Promise<void> {
    const c = this.causa;
    const lineas = [
      `${c.masivo ? 'ERROR MASIVO — ' : ''}${c.titulo}`,
      `Primera vez: ${c.primera} · Última: ${c.ultima}`,
      `Errores: ${c.errores} · Clientes afectados: ${c.clientesAfectados} · Tasa de error del servicio: ${pct(c.tasaError, 1)} (${c.llamadasAfectadas} llamadas)`,
      c.detalleBanco ? `Detalle: ${c.detalleBanco}` : '',
      c.falla?.servicioActor ? `Servicio que no respondió: ${c.falla.servicioActor}` : '',
      c.falla?.segundosLimite ? `Límite de espera: ${c.falla.segundosLimite} s` : '',
      c.nodos.length ? `Nodos: ${c.nodos.map((n) => `${n.valor} (${n.n})`).join(', ')}` : '',
      c.versiones.length ? `Versiones: ${c.versiones.map((n) => `${n.valor} (${n.n})`).join(', ')}` : '',
      c.plataformas.length ? `Plataformas: ${c.plataformas.map((n) => `${n.valor} (${n.n})`).join(', ')}` : '',
      c.muestras.length ? `Ejemplos: ${c.muestras.slice(0, 5).map((m) => `${m.documento} ${m.hora}${m.transaccion ? ' tx ' + m.transaccion : ''}`).join(' | ')}` : ''
    ].filter(Boolean);
    if (await copiarTexto(lineas.join('\n'))) {
      this.copiado = true;
      if (this.temporizador) clearTimeout(this.temporizador);
      this.temporizador = setTimeout(() => { this.copiado = false; }, 2000);
    }
  }
}
