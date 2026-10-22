import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SubaplicativosComponent } from '../subaplicativos/subaplicativos.component';
import { ServidoresComponent } from '../servidores/servidores.component';
import { AplicacionesListComponent } from '../features/aplicaciones/aplicaciones-list.component';
import { PuertosServidoresComponent } from '../features/puertos/puertos-servidores.component';
import { CrucePortainerComponent } from '../features/cruce-portainer/cruce-portainer.component';
import { AuthService } from '../services/auth.service';

type Vista = 'subs' | 'servidores' | 'aplicaciones' | 'puertos' | 'cruce';

// Contenedor del Inventario: dos pestañas en la misma pantalla.
//  - Sub-aplicativos (vista por defecto): cada componente registrado en
//    Aplicaciones, con tabla, filtros y ficha de detalle.
//  - Aplicaciones de negocio: las aplicaciones que ve el negocio y los
//    componentes (servidor + puerto) que las hacen funcionar. Solo para quien
//    tiene el módulo Certificados (es el mismo permiso de su API).
//  - Servidores: las máquinas (alta/edición/baja) con el resumen de lo que
//    corre en cada una.
//  - Puertos: qué puertos tiene en escucha cada servidor (consulta por SSH,
//    solo lectura).
//  - Conciliación: contenedores y puertos de Portainer frente al inventario de
//    sub-aplicativos, con lo que no cuadra.
// Aquí se administra TODO lo que los certificados referencian; el módulo
// Certificados solo consulta y elige.
// El Análisis de Impacto cuelga de ambas.
@Component({
  selector: 'app-inventario',
  standalone: true,
  imports: [CommonModule, RouterLink, SubaplicativosComponent, ServidoresComponent, AplicacionesListComponent, PuertosServidoresComponent, CrucePortainerComponent],
  template: `
    <div class="inventario-wrap">
      <div class="inventario-barra">
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" [class.activa]="vista === 'servidores'" [attr.aria-selected]="vista === 'servidores'" (click)="irA('servidores')">
            Servidores
          </button>
          <button class="tab" role="tab" [class.activa]="vista === 'subs'" [attr.aria-selected]="vista === 'subs'" (click)="irA('subs')">
            Sub-aplicativos
          </button>
          <button class="tab" role="tab" [class.activa]="vista === 'puertos'" [attr.aria-selected]="vista === 'puertos'" (click)="irA('puertos')">
            Puertos
          </button>
          <button class="tab" role="tab" [class.activa]="vista === 'cruce'" [attr.aria-selected]="vista === 'cruce'" (click)="irA('cruce')">
            Conciliación
          </button>
          <button class="tab" role="tab" *ngIf="verAplicaciones" [class.activa]="vista === 'aplicaciones'" [attr.aria-selected]="vista === 'aplicaciones'" (click)="irA('aplicaciones')">
            Aplicaciones de negocio
          </button>
        </div>
        <a class="btn-impacto" routerLink="/servidores/impacto">⚠ Análisis de Impacto</a>
      </div>

      <details class="inv-relacion">
        <summary>¿Cómo se relacionan Servidores, Sub-aplicativos y Aplicaciones de negocio?</summary>
        <div class="inv-relacion__cadena">
          <div><strong>Servidor</strong><span>La máquina (IP, ambiente, sistema operativo). Es la misma que se elige al instalar un certificado.</span></div>
          <em>tiene →</em>
          <div><strong>Sub-aplicativo</strong><span>Cada componente que corre en él: microservicio, API, contenedor o sitio, con su puerto. Es lo que lleva el certificado.</span></div>
          <em>forma parte de →</em>
          <div><strong>Aplicación de negocio</strong><span>Lo que el negocio reconoce (p. ej. APP MOVIL). Agrupa varios sub-aplicativos.</span></div>
        </div>
        <p>Cada cosa se crea en <strong>un solo lugar</strong>: los servidores en «Servidores», los sub-aplicativos en «Sub-aplicativos» y las aplicaciones de negocio solo eligen cuáles sub-aplicativos las componen. El módulo Certificados ya no tiene su propia lista de servidores: usa esta, y cada servidor muestra aquí el estado de sus certificados.</p>
      </details>

      <app-subaplicativos *ngIf="vista === 'subs'" [servidorId]="servidorFiltro" [abrirId]="abrirId"></app-subaplicativos>

      <app-aplicaciones-list *ngIf="vista === 'aplicaciones' && verAplicaciones"
        (verSubaplicativo)="abrirSubaplicativo($event)"
        (irASubaplicativos)="irA('subs')"></app-aplicaciones-list>

      <app-puertos-servidores *ngIf="vista === 'puertos'"></app-puertos-servidores>

      <app-cruce-portainer *ngIf="vista === 'cruce'" (abrirSubaplicativo)="abrirSubaplicativo($event)"></app-cruce-portainer>

      <app-servidores *ngIf="vista === 'servidores'"
        (verSubaplicativos)="verSubaplicativos($event)"
        (abrirSubaplicativo)="abrirSubaplicativo($event)"></app-servidores>
    </div>
  `,
  styles: [`
    .inventario-wrap { max-width: 1500px; margin: 0 auto; }
    .inventario-barra {
      display: flex; justify-content: space-between; align-items: center;
      flex-wrap: wrap; gap: 12px;
      border-bottom: 2px solid var(--ax-border, #e2e8f0);
      margin-bottom: 20px;
    }
    .tabs { display: flex; gap: 4px; }
    .tab {
      background: none; border: none; cursor: pointer;
      padding: 12px 22px; font-size: 15px; font-weight: 700; font-family: inherit;
      color: var(--ax-text-muted, #64748b);
      border-bottom: 3px solid transparent; margin-bottom: -2px;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab:hover { color: var(--ax-text, #1e293b); }
    .tab.activa { color: var(--ax-brand-primary, #673ab7); border-bottom-color: var(--ax-brand-primary, #673ab7); }
    .btn-impacto {
      background: var(--ax-surface-2, #f1f5f9); color: var(--ax-text, #1e293b);
      padding: 8px 16px; border-radius: 8px; font-weight: 600; font-size: 13px;
      text-decoration: none; margin-bottom: 6px; white-space: nowrap;
    }
    .btn-impacto:hover { background: var(--ax-border, #e2e8f0); }
    .inv-relacion {
      background: var(--ax-surface, #fff); border: 1px solid var(--ax-border, #e2e8f0); border-radius: 14px;
      padding: 10px 16px; margin-bottom: 18px; font-size: 13px; color: var(--ax-text-muted, #64748b);
    }
    .inv-relacion summary { cursor: pointer; font-weight: 700; color: var(--ax-brand-primary, #673ab7); }
    .inv-relacion__cadena { display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; margin-top: 12px; }
    .inv-relacion__cadena div {
      flex: 1 1 200px; display: flex; flex-direction: column; gap: 3px; padding: 10px 14px; border-radius: 12px;
      background: var(--ax-surface-2, #f8fafc); border: 1px solid var(--ax-border, #e2e8f0);
    }
    .inv-relacion__cadena strong { color: var(--ax-text, #1e293b); font-size: 13.5px; }
    .inv-relacion__cadena em { align-self: center; font-style: normal; font-weight: 700; font-size: 12px; white-space: nowrap; }
    .inv-relacion p { margin: 12px 0 2px; line-height: 1.45; }
  `],
})
export class InventarioComponent {
  vista: Vista = 'subs';
  servidorFiltro: number | null = null;
  abrirId: number | null = null;

  verAplicaciones = false;

  constructor(route: ActivatedRoute, auth: AuthService) {
    this.verAplicaciones = auth.rolEnModulo('CERTIFICADOS') !== null;
    // Permite enlazar directo: /servidores?vista=servidores | ?vista=aplicaciones | ?vista=puertos | ?vista=cruce
    const q = route.snapshot.queryParamMap;
    if (q.get('vista') === 'servidores') this.vista = 'servidores';
    if (q.get('vista') === 'puertos') this.vista = 'puertos';
    if (q.get('vista') === 'cruce') this.vista = 'cruce';
    if (q.get('vista') === 'aplicaciones' && this.verAplicaciones) this.vista = 'aplicaciones';
    const srv = Number(q.get('servidor'));
    if (srv) this.servidorFiltro = srv;
  }

  irA(v: Vista): void {
    this.vista = v;
    if (v === 'subs') {
      // Entrar "limpio" desde la pestaña, sin arrastrar un filtro anterior
      this.servidorFiltro = null;
      this.abrirId = null;
    }
  }

  verSubaplicativos(servidorId: number): void {
    this.servidorFiltro = servidorId;
    this.abrirId = null;
    this.vista = 'subs';
  }

  abrirSubaplicativo(ev: { servidorId: number; subId: number }): void {
    this.servidorFiltro = ev.servidorId;
    this.abrirId = ev.subId;
    this.vista = 'subs';
  }
}
