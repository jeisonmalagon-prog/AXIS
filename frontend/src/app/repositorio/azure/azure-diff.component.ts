import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface LineaDiff { tipo: 'igual' | 'agregada' | 'quitada' | 'salto'; texto?: string; n1?: number | null; n2?: number | null; cantidad?: number; }
export interface DiffArchivo {
  ruta: string;
  binario: boolean;
  grande: boolean;
  lineas: LineaDiff[];
  resumen: { agregadas: number; quitadas: number };
  sinCambios: boolean;
  truncado: boolean;
}

// Visor de diferencias de un archivo (líneas agregadas en verde, quitadas en rojo).
@Component({
  selector: 'app-azure-diff',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="aviso" *ngIf="diff?.binario">Archivo binario: no se puede mostrar la diferencia de contenido.</div>
    <div class="aviso" *ngIf="diff?.grande">El archivo es demasiado grande para comparar aquí. Ábrelo en Azure DevOps.</div>
    <div class="aviso" *ngIf="diff?.sinCambios">No hay diferencias de contenido en este archivo.</div>
    <div class="aviso" *ngIf="diff?.truncado">El archivo es muy largo: se muestra solo una parte de las diferencias.</div>
    <ng-container *ngIf="diff && !diff.binario && !diff.grande && !diff.sinCambios">
      <div class="resumen"><span class="mas">+{{ diff.resumen.agregadas }}</span> <span class="menos">−{{ diff.resumen.quitadas }}</span></div>
      <div class="diff" role="table">
        <ng-container *ngFor="let l of diff.lineas">
          <div class="salto" *ngIf="l.tipo === 'salto'">⋯ {{ l.cantidad }} líneas sin cambios</div>
          <div class="fila" *ngIf="l.tipo !== 'salto'" [ngClass]="l.tipo">
            <span class="n">{{ l.n1 ?? '' }}</span><span class="n">{{ l.n2 ?? '' }}</span>
            <span class="s">{{ l.tipo === 'agregada' ? '+' : l.tipo === 'quitada' ? '−' : ' ' }}</span>
            <span class="t">{{ l.texto }}</span>
          </div>
        </ng-container>
      </div>
    </ng-container>`,
  styles: [`
    :host { display: block; }
    .aviso { background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 10px; padding: 10px 14px; font-size: 13px; color: var(--ax-text, #1e293b); margin-bottom: 8px; }
    .resumen { font-size: 12px; font-weight: 700; margin-bottom: 6px; }
    .resumen .mas { color: var(--ax-chart-ok, #10b981); } .resumen .menos { color: var(--ax-chart-danger, #ef4444); }
    .diff { font-family: 'JetBrains Mono', monospace; font-size: 12px; border: 1px solid var(--ax-border, #e2e8f0); border-radius: 10px; overflow: auto; max-height: 56vh; background: var(--ax-surface, #fff); }
    .fila { display: grid; grid-template-columns: 44px 44px 16px minmax(max-content, 1fr); min-width: 100%; width: max-content; line-height: 1.55; }
    .fila .n { text-align: right; padding: 0 8px; color: var(--ax-text-muted, #64748b); user-select: none; opacity: 0.8; }
    .fila .s { text-align: center; user-select: none; }
    .fila .t { white-space: pre; padding-right: 12px; color: var(--ax-text, #1e293b); }
    .fila.agregada { background: rgba(16, 185, 129, 0.14); } .fila.agregada .s { color: var(--ax-chart-ok, #10b981); font-weight: 800; }
    .fila.quitada { background: rgba(239, 68, 68, 0.13); } .fila.quitada .s { color: var(--ax-chart-danger, #ef4444); font-weight: 800; }
    .salto { padding: 4px 12px; font-size: 11px; color: var(--ax-text-muted, #64748b); background: var(--ax-surface-2, #f8fafc); border-top: 1px solid var(--ax-border, #e2e8f0); border-bottom: 1px solid var(--ax-border, #e2e8f0); }
  `],
})
export class AzureDiffComponent {
  @Input() diff: DiffArchivo | null = null;
}
