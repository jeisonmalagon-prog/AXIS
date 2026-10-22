import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ConfigInicio, InicioService, WidgetConfig } from '../../core/services/inicio.service';

// Ventana del ADMIN_POD para elegir qué métricas ve la gente en la pantalla de
// inicio: visibilidad, orden, tamaño, refresco y «solo admin». Los usuarios
// siempre ven, además, únicamente los widgets de módulos que ya tienen.
@Component({
  selector: 'app-inicio-config',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="modal-overlay" (click)="cerrar.emit(huboCambios)">
      <div class="modal-card modal-config" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" aria-label="Personalizar pantalla de inicio">
        <div class="cab-modal">
          <div>
            <h2>Personalizar pantalla de inicio</h2>
            <p class="sub">Elige qué cuadros ven los usuarios al iniciar sesión. Cada usuario solo recibe los de módulos que ya tiene habilitados.</p>
          </div>
          <button type="button" class="close-btn" (click)="cerrar.emit(huboCambios)" aria-label="Cerrar">✕</button>
        </div>

        <div class="cargando" *ngIf="cargando"><div class="spinner"></div></div>
        <div class="error-state" *ngIf="error">{{ error }}</div>
        <div class="aviso-aviso" *ngIf="cfg && !cfg.tabla">
          La tabla <code>inicio_widgets_config</code> aún no existe. Si el usuario de la aplicación no puede crearla, ejecuta una vez el script
          <code>crear_tabla_inicio_widgets.sql</code>. Mientras tanto se muestran todos los cuadros.
        </div>

        <ng-container *ngIf="cfg">
          <ul class="lista-cfg">
            <li *ngFor="let w of cfg.widgets; let i = index" [class.apagado]="!w.habilitado">
              <div class="orden">
                <button type="button" class="btn-mini" (click)="mover(i, -1)" [disabled]="i === 0" [attr.aria-label]="'Subir ' + w.titulo">▲</button>
                <button type="button" class="btn-mini" (click)="mover(i, 1)" [disabled]="i === cfg.widgets.length - 1" [attr.aria-label]="'Bajar ' + w.titulo">▼</button>
              </div>
              <div class="info">
                <label class="check">
                  <input type="checkbox" [(ngModel)]="w.habilitado" />
                  <span><strong>{{ w.titulo }}</strong><small>{{ w.descripcion }}</small></span>
                </label>
                <div class="chips">
                  <span class="chip chip-marca">{{ w.grupo }}</span>
                  <span class="chip">{{ w.modulo ? 'Requiere módulo ' + etiquetaModulo(w.modulo) : 'Todos los usuarios' }}</span>
                </div>
              </div>
              <div class="ajustes">
                <label class="campo">Ancho
                  <select [(ngModel)]="w.ancho">
                    <option *ngFor="let a of cfg.anchos" [ngValue]="a">{{ nombreAncho(a) }}</option>
                  </select>
                </label>
                <label class="campo">Refresco (s)
                  <input type="number" [min]="cfg.intervaloMin" [max]="cfg.intervaloMax" step="5" [(ngModel)]="w.intervaloSeg" />
                </label>
                <label class="campo check-pequeno"><input type="checkbox" [(ngModel)]="w.soloAdmin" /> Solo ADMIN_POD</label>
              </div>
            </li>
          </ul>
          <div class="error-state" *ngIf="errorGuardar">{{ errorGuardar }}</div>
          <div class="aviso-ok" *ngIf="guardado">Cambios guardados. Los usuarios los verán al abrir o recargar Inicio.</div>
          <div class="pie-form">
            <span class="resumen">{{ activos }} de {{ cfg.widgets.length }} cuadros visibles</span>
            <span class="espacio"></span>
            <button type="button" class="btn btn-ghost" (click)="cerrar.emit(huboCambios)">Cerrar</button>
            <button type="button" class="btn btn-purple" (click)="guardar()" [disabled]="guardando">{{ guardando ? 'Guardando…' : 'Guardar cambios' }}</button>
          </div>
        </ng-container>
      </div>
    </div>
  `,
  styleUrl: './inicio-config.component.scss',
})
export class InicioConfigComponent implements OnInit {
  /** true si se guardó algo (para que Inicio recargue su lista). */
  @Output() cerrar = new EventEmitter<boolean>();

  cfg: ConfigInicio | null = null;
  cargando = true;
  error = '';
  guardando = false;
  guardado = false;
  errorGuardar = '';
  huboCambios = false;

  constructor(private servicio: InicioService) {}

  ngOnInit(): void {
    this.servicio.config().subscribe({
      next: (c) => { this.cfg = c; this.cargando = false; },
      error: (e) => { this.error = e?.error?.error || 'No se pudo cargar la configuración.'; this.cargando = false; },
    });
  }

  get activos(): number { return this.cfg?.widgets.filter((w) => w.habilitado).length || 0; }

  nombreAncho(a: number): string { return a === 2 ? 'Tercio' : a === 3 ? 'Mitad' : a === 4 ? 'Dos tercios' : 'Completo'; }

  etiquetaModulo(m: string): string {
    const mapa: Record<string, string> = {
      SERVIDORES: 'Servidores', BALANCEADOR_F5: 'Balanceador F5', CERTIFICADOS: 'Certificados',
      PASOS_PRODUCCION: 'Pasos a producción', TAREAS: 'Tareas',
    };
    return mapa[m] || m;
  }

  mover(i: number, d: number): void {
    if (!this.cfg) return;
    const j = i + d;
    if (j < 0 || j >= this.cfg.widgets.length) return;
    const l = this.cfg.widgets;
    [l[i], l[j]] = [l[j], l[i]];
    this.guardado = false;
  }

  guardar(): void {
    if (!this.cfg) return;
    this.guardando = true; this.guardado = false; this.errorGuardar = '';
    const lista: WidgetConfig[] = this.cfg.widgets;
    const payload = lista.map((w, i) => ({
      id: w.id, habilitado: !!w.habilitado, orden: (i + 1) * 10, ancho: Number(w.ancho),
      intervaloSeg: Number(w.intervaloSeg) || 30, soloAdmin: !!w.soloAdmin,
    }));
    this.servicio.guardarConfig(payload).subscribe({
      next: () => { this.guardando = false; this.guardado = true; this.huboCambios = true; if (this.cfg) this.cfg.tabla = true; },
      error: (e) => { this.guardando = false; this.errorGuardar = e?.error?.error || 'No se pudo guardar la configuración.'; },
    });
  }
}
