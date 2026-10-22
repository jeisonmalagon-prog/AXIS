import { Component, Input, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SwaggerModelo } from '../../core/services/swagger.service';

// Árbol de un esquema (propiedades, tipos, restricciones). Se usa a sí mismo para los niveles internos.
@Component({
  selector: 'app-swagger-modelo',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="mod" [class.mod-raiz]="raiz">
      <div class="mod-linea" *ngIf="!raiz">
        <button type="button" class="mod-flecha" *ngIf="hijos.length" (click)="abierto = !abierto" [attr.aria-expanded]="abierto" [attr.aria-label]="abierto ? 'Contraer' : 'Expandir'">
          <span [class.abierta]="abierto">&#9656;</span>
        </button>
        <span class="mod-flecha vacia" *ngIf="!hijos.length"></span>
        <span class="mod-nombre mono" *ngIf="modelo.nombre !== undefined">{{ modelo.nombre }}<span class="req" *ngIf="modelo.requerido" title="Obligatorio">*</span></span>
        <span class="mod-tipo mono">{{ tipoTexto }}</span>
        <span class="mod-marca" *ngIf="modelo.nullable">nullable</span>
        <span class="mod-marca" *ngIf="modelo.soloLectura">solo lectura</span>
        <span class="mod-marca" *ngIf="modelo.soloEscritura">solo escritura</span>
        <span class="mod-marca mod-aviso" *ngIf="modelo.deprecado">deprecado</span>
        <span class="mod-marca" *ngIf="modelo.circular">referencia circular</span>
        <span class="mod-resumen" *ngIf="!abierto && hijos.length">{{ resumenHijos }}</span>
        <span class="mod-desc" *ngIf="modelo.descripcion">{{ modelo.descripcion }}</span>
      </div>
      <div class="mod-detalles" *ngIf="!raiz && detalles.length">
        <span class="mod-det" *ngFor="let d of detalles"><b>{{ d.k }}:</b> <span class="mono">{{ d.v }}</span></span>
      </div>
      <div class="mod-hijos" *ngIf="raiz || abierto">
        <app-swagger-modelo *ngFor="let h of hijos" [modelo]="h" [nivel]="nivel + 1"></app-swagger-modelo>
        <p class="mod-vacio" *ngIf="raiz && !hijos.length">{{ tipoTexto }}<ng-container *ngIf="detalles.length"> · <ng-container *ngFor="let d of detalles; let u = last">{{ d.k }}: {{ d.v }}<ng-container *ngIf="!u">, </ng-container></ng-container></ng-container></p>
      </div>
    </div>
  `,
  styleUrl: './swagger-modelo.component.scss',
})
export class SwaggerModeloComponent implements OnChanges {
  @Input({ required: true }) modelo!: SwaggerModelo;
  @Input() nivel = 0;
  @Input() raiz = false;

  hijos: SwaggerModelo[] = [];
  detalles: { k: string; v: string }[] = [];
  tipoTexto = '';
  resumenHijos = '';
  abierto = false;

  ngOnChanges(): void {
    const m = this.modelo;
    this.abierto = this.nivel < 2;
    this.tipoTexto = this.armarTipo(m);
    const hijos: SwaggerModelo[] = [...(m.propiedades || [])];
    if (m.items) hijos.push({ ...m.items, nombre: '[ítem]' });
    if (m.adicional) hijos.push({ ...m.adicional, nombre: '{clave}' });
    (m.alternativas || []).forEach((alt, i) => hijos.push({ ...alt, nombre: `${m.combinador === 'anyOf' ? 'cualquiera' : 'una de'} #${i + 1}` }));
    this.hijos = hijos;
    this.resumenHijos = m.propiedades ? `{ ${m.propiedades.length} propiedad(es) }` : '';
    const d: { k: string; v: string }[] = [];
    if (m.enum && m.enum.length) d.push({ k: 'valores', v: m.enum.map((x) => String(x)).join(' | ') });
    if (m.defecto !== undefined && m.defecto !== null) d.push({ k: 'por defecto', v: this.texto(m.defecto) });
    if (m.ejemplo !== undefined && m.ejemplo !== null) d.push({ k: 'ejemplo', v: this.texto(m.ejemplo) });
    const etiquetas: Record<string, string> = {
      minimum: 'mín', maximum: 'máx', minLength: 'largo mín', maxLength: 'largo máx', pattern: 'patrón', minItems: 'ítems mín', maxItems: 'ítems máx',
    };
    Object.entries(m.restricciones || {}).forEach(([k, v]) => d.push({ k: etiquetas[k] || k, v: this.texto(v) }));
    this.detalles = d;
  }

  private armarTipo(m: SwaggerModelo): string {
    let t = m.tipo || 'any';
    if (m.ref && m.tipo !== 'array') t = m.ref;
    else if (m.tipo === 'array') t = m.items ? `array<${m.items.ref || m.items.tipo || 'any'}${m.items.formato ? ` (${m.items.formato})` : ''}>` : 'array';
    else if (m.formato) t += ` (${m.formato})`;
    if (m.combinador) t = `${m.combinador}`;
    return t;
  }

  private texto(v: unknown): string {
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
    return String(v);
  }
}
