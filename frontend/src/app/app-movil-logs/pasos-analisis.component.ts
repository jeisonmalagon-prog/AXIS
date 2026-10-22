import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CodigoTraducido, PasoAnalisis, formatearDuracion } from './analisis-comun';

const TEXTO_FASE: Record<string, string> = {
  dentro_flujo: 'El mensaje llegó al flujo principal de ACE y se agotó el tiempo MIENTRAS lo procesaba (la espera estuvo en el procesamiento o en el sistema que ACE consulta detrás).',
  antes_flujo: 'El mensaje NO llegó a entrar al flujo principal de ACE: se agotó el tiempo antes (cola/saturación del nodo de integración o de la entrada del servicio).'
};

const ETIQUETA_CATEGORIA: Record<string, string> = {
  ok: 'Correcto', sin_datos: 'Sin datos', timeout: 'Tiempo agotado', error: 'Error', info: 'Informativo', desconocido: 'Sin traducción'
};

interface CodigoPlano extends CodigoTraducido { nivel: string; severidad: string | null; descripcionBanco: string | null }

interface PasoVista {
  p: PasoAnalisis;
  codigos: CodigoPlano[];
  fase: string | null;
}

/**
 * Lista de pasos internos de una operación (llamadas a ACE, APIs, errores) con
 * los códigos traducidos y los datos del catálogo de servicios de ACE.
 */
@Component({
  selector: 'app-pasos-analisis',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="pasos" *ngIf="vista.length; else sinPasos">
      <li class="paso" *ngFor="let v of vista" [ngClass]="'paso--' + v.p.nivel">
        <div class="paso__linea">
          <span class="paso__hora mono">{{ v.p.hora }}</span>
          <span class="paso__tipo">{{ etiquetaTipo(v.p.tipo) }}</span>
          <strong class="paso__titulo">{{ v.p.titulo }}</strong>
          <span class="paso__veces" *ngIf="v.p.veces && v.p.veces > 1">× {{ v.p.veces }}</span>
          <span class="pill" [ngClass]="clasePill(v.p.nivel)">{{ v.p.texto || nivelTexto(v.p.nivel) }}</span>
          <span class="paso__espera" *ngIf="v.p.esperaMs > 0" [class.paso__espera--lenta]="v.p.lento" title="Tiempo desde el paso anterior (±1 s por la resolución del log)">
            +{{ dur(v.p.esperaMs) }}
          </span>
        </div>

        <div class="paso__falla" *ngIf="v.p.falla as f">
          <div><b>{{ f.esTimeout ? 'Tiempo de espera agotado' : 'Falla' }}</b><span *ngIf="f.segundosLimite"> · límite {{ f.segundosLimite }} s</span><span *ngIf="f.nodoIntegracion"> · nodo de integración {{ f.nodoIntegracion }}</span></div>
          <div *ngIf="f.mensaje">Mensaje de ACE: <span class="mono">{{ f.mensaje }}</span></div>
          <div *ngIf="f.servicioActor">Servicio que no respondió: <span class="mono">{{ f.servicioActor }}</span></div>
          <div *ngIf="v.fase" class="paso__fase">{{ v.fase }}</div>
        </div>

        <ul class="codigos" *ngIf="v.codigos.length">
          <li *ngFor="let c of v.codigos" [ngClass]="'codigo--' + c.categoria">
            <span class="codigo__tipo">{{ c.tipo }}</span>
            <span class="codigo__valor mono">{{ c.codigo }}</span>
            <span class="codigo__cat">{{ categoria(c.categoria) }}</span>
            <span class="codigo__sig">{{ c.significado }}</span>
            <span class="codigo__banco" *ngIf="c.descripcionBanco">Texto del banco: «{{ c.descripcionBanco }}»</span>
          </li>
        </ul>

        <div class="paso__ace" *ngIf="v.p.catalogo as k">
          <span class="paso__ace-etq">Catálogo ACE</span>
          <ng-container *ngIf="k.encontrado; else sinCat">
            <span class="mono">{{ k.codigo }} {{ k.servicio }}.{{ k.operacion }}</span>
            <span class="aprox" *ngIf="k.aproximado" title="El nombre de la operación coincide de forma aproximada con el catálogo">coincidencia aproximada</span>
            <span *ngIf="k.descripcion">— {{ k.descripcion }}</span>
            <span *ngIf="k.operacionBackend"> · operación en el sistema: <span class="mono">{{ k.operacionBackend }}</span></span>
            <span *ngIf="k.instancias"> · {{ k.instancias }} instancia(s)</span>
            <span *ngIf="k.version"> · {{ k.version }}</span>
          </ng-container>
          <ng-template #sinCat><span>No está en el catálogo de servicios cargado.</span></ng-template>
        </div>

        <div class="paso__meta mono" *ngIf="v.p.transaccion">Transacción ACE: {{ v.p.transaccion }}</div>
      </li>
    </ol>
    <ng-template #sinPasos><p class="sin-pasos">No hay pasos internos registrados: solo existe la fila de resultado en el log.</p></ng-template>
  `,
  styles: [`
    :host { display: block; font-size: 12.5px; color: var(--ax-text, #1e293b); }
    .mono { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; }
    .pasos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .paso { border: 1px solid var(--ax-border, #e2e8f0); border-left-width: 4px; border-radius: 10px; padding: 8px 12px; background: var(--ax-surface, #fff); }
    .paso--ok { border-left-color: #059669; }
    .paso--error { border-left-color: #dc2626; background: rgba(239, 68, 68, 0.06); }
    .paso--aviso, .paso--warn { border-left-color: #d97706; background: rgba(245, 158, 11, 0.06); }
    .paso--info { border-left-color: #94a3b8; }
    .paso__linea { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
    .paso__hora { color: var(--ax-text-muted, #64748b); }
    .paso__tipo { font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px; color: var(--ax-text-muted, #64748b); background: var(--ax-surface-2, #f8fafc); border: 1px solid var(--ax-border, #e2e8f0); border-radius: 6px; padding: 1px 6px; }
    .paso__titulo { font-size: 13px; }
    .paso__veces { font-weight: 700; color: var(--ax-text-muted, #64748b); }
    .paso__espera { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--ax-text-muted, #64748b); font-weight: 700; }
    .paso__espera--lenta { color: #b45309; }
    .pill { display: inline-flex; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; background: #e2e8f0; color: #475569; }
    .pill--ok { background: #d1fae5; color: #047857; }
    .pill--error { background: #fee2e2; color: #b91c1c; }
    .pill--warn { background: #fef3c7; color: #b45309; }
    .paso__falla { margin-top: 6px; padding: 8px 10px; border-radius: 8px; background: rgba(239, 68, 68, 0.08); display: flex; flex-direction: column; gap: 2px; }
    .paso__fase { color: var(--ax-text-muted, #64748b); }
    .codigos { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .codigos li { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; padding: 5px 8px; border-radius: 8px; background: var(--ax-surface-2, #f8fafc); }
    .codigo__tipo { font-size: 10.5px; font-weight: 800; text-transform: uppercase; color: var(--ax-text-muted, #64748b); }
    .codigo__valor { font-weight: 800; }
    .codigo__cat { font-size: 11px; font-weight: 700; border-radius: 999px; padding: 1px 8px; background: #e2e8f0; color: #475569; }
    .codigo--ok .codigo__cat { background: #d1fae5; color: #047857; }
    .codigo--error .codigo__cat { background: #fee2e2; color: #b91c1c; }
    .codigo--timeout .codigo__cat { background: #fef3c7; color: #b45309; }
    .codigo--sin_datos .codigo__cat { background: #dbeafe; color: #1d4ed8; }
    .codigo__sig { flex: 1 1 280px; }
    .codigo__banco { flex-basis: 100%; color: var(--ax-text-muted, #64748b); }
    .paso__ace { margin-top: 6px; color: var(--ax-text-muted, #64748b); display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
    .paso__ace-etq { font-size: 10.5px; font-weight: 800; text-transform: uppercase; }
    .aprox { font-size: 10.5px; font-weight: 700; background: #fef3c7; color: #b45309; border-radius: 999px; padding: 1px 7px; }
    .paso__meta { margin-top: 4px; color: var(--ax-text-muted, #64748b); }
    .sin-pasos { color: var(--ax-text-muted, #64748b); margin: 4px 0; }
  `]
})
export class PasosAnalisisComponent {
  vista: PasoVista[] = [];

  @Input() set pasos(valor: PasoAnalisis[] | null | undefined) {
    this.vista = (valor ?? []).map((p) => ({
      p,
      codigos: this.aplanar(p),
      fase: p.falla?.fase ? TEXTO_FASE[p.falla.fase] ?? null : null
    }));
  }

  dur(ms: number): string { return formatearDuracion(ms); }

  categoria(c: string): string { return ETIQUETA_CATEGORIA[c] ?? c; }

  etiquetaTipo(t: string): string {
    return t === 'soap' ? 'ACE' : t === 'api' ? 'API' : t === 'error' ? 'Error' : t === 'inicio' ? 'Inicio' : 'Paso';
  }

  nivelTexto(n: string): string {
    return n === 'ok' ? 'Correcto' : n === 'error' ? 'Error' : n === 'aviso' ? 'Aviso' : 'Informativo';
  }

  clasePill(n: string): string {
    return n === 'ok' ? 'pill--ok' : n === 'error' ? 'pill--error' : n === 'aviso' || n === 'warn' ? 'pill--warn' : '';
  }

  private aplanar(p: PasoAnalisis): CodigoPlano[] {
    const salida: CodigoPlano[] = [];
    for (const c of p.codigos ?? []) {
      for (const clave of ['ace', 'servidor', 'http', 'mensaje'] as const) {
        const t = (c as Record<string, unknown>)[clave] as CodigoTraducido | null | undefined;
        if (t && typeof t === 'object' && 'codigo' in t) {
          salida.push({ ...t, nivel: c.nivel, severidad: c.severidad, descripcionBanco: clave === 'ace' || clave === 'http' || clave === 'mensaje' ? c.descripcionBanco : null });
        }
      }
    }
    return salida;
  }
}
