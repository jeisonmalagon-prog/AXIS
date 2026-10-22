import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FalloAzure } from './azure-utils';

// Aviso de una sección que no se pudo cargar. Si es por permisos del token (PAT)
// de Azure DevOps, explica cuál hace falta; el resto del módulo sigue funcionando.
@Component({
  selector: 'app-azure-fallo',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fallo" *ngIf="fallo" [class.permiso]="fallo.codigo === 'SIN_PERMISO' || fallo.codigo === 'SIN_CONFIGURAR' || fallo.codigo === 'SOLO_ADMIN' || fallo.codigo === 'SIN_ACCESO' || fallo.codigo === 'SIN_ACCESO_REPO'">
      <ng-container [ngSwitch]="fallo.codigo">
        <ng-container *ngSwitchCase="'SIN_PERMISO'">
          <strong>Sección sin permiso</strong>
          <span>Ninguno de los tokens (PAT) de Azure DevOps guardados puede leer esta información.
            <ng-container *ngIf="fallo.permisoRequerido">Permiso necesario: <code>{{ fallo.permisoRequerido }}</code>.</ng-container>
            Un administrador puede agregar otro token en <strong>Repositorio → Conexión</strong>. El resto de las secciones sigue funcionando.</span>
        </ng-container>
        <ng-container *ngSwitchCase="'SIN_CONFIGURAR'">
          <strong>Falta configurar Azure DevOps</strong><span>{{ fallo.error }}</span>
        </ng-container>
        <ng-container *ngSwitchCase="'SIN_ACCESO'">
          <strong>Sin acceso</strong><span>{{ fallo.error }}</span>
        </ng-container>
        <ng-container *ngSwitchCase="'SIN_ACCESO_REPO'">
          <strong>Sin acceso al repositorio</strong><span>{{ fallo.error }}</span>
        </ng-container>
        <ng-container *ngSwitchCase="'SOLO_ADMIN'">
          <strong>Solo administrador</strong><span>{{ fallo.error }}</span>
        </ng-container>
        <ng-container *ngSwitchDefault>
          <strong>No se pudo cargar</strong><span>{{ fallo.error }}</span>
        </ng-container>
      </ng-container>
    </div>`,
  styles: [`
    .fallo { display: flex; flex-direction: column; gap: 4px; border-radius: 12px; padding: 12px 16px; font-size: 13px; line-height: 1.5; margin-bottom: 14px;
      background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.3); color: var(--ax-text, #1e293b); }
    .fallo strong { color: var(--ax-chart-danger, #ef4444); }
    .fallo.permiso { background: rgba(245, 158, 11, 0.1); border-color: rgba(245, 158, 11, 0.4); }
    .fallo.permiso strong { color: var(--ax-chart-warn, #f59e0b); }
    code { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  `],
})
export class AzureFalloComponent {
  @Input() fallo: FalloAzure | null | undefined = null;
}
