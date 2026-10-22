import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CatalogoDatosService, OrigenEstado, ResultadoEjecucion } from '../../core/services/catalogo-datos.service';

// Ejecuta UNA consulta de solo lectura en el servidor elegido y muestra el resultado (máx. 200 filas).
// El backend vuelve a validar que sea un SELECT único y deja la ejecución en la auditoría.
@Component({
  selector: 'app-query-ejecucion',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './query-ejecucion.component.html',
  styleUrl: './query-ejecucion.component.scss',
})
export class QueryEjecucionComponent implements OnChanges {
  @Input() sql = '';
  @Input() origenes: OrigenEstado[] = [];
  /** Servidor sugerido (el que armó o analizó el query). */
  @Input() origenId = '';
  @Input() bd = '';
  @Input() queryId: number | null = null;
  /** Permiso de edición en el módulo (ejecutar lo exige). */
  @Input() puede = false;
  /** Motivo ya conocido por el que no se puede ejecutar (p. ej. modifica datos). */
  @Input() motivo = '';

  origenSel = '';
  ejecutando = false;
  error = '';
  resultado: ResultadoEjecucion | null = null;
  copiado = '';
  private temporizador: ReturnType<typeof setTimeout> | null = null;

  constructor(private servicio: CatalogoDatosService) {}

  ngOnChanges(c: SimpleChanges): void {
    if (c['origenId'] || c['origenes'] || c['bd']) this.elegirOrigen();
    if (c['sql'] && !c['sql'].firstChange) { this.error = ''; }
  }

  private elegirOrigen(): void {
    if (this.origenSel && this.origenes.some((o) => o.id === this.origenSel) && !this.origenId) return;
    if (this.origenId && this.origenes.some((o) => o.id === this.origenId)) { this.origenSel = this.origenId; return; }
    const porBase = this.bd ? this.origenes.find((o) => o.bases.some((b) => b.nombre.toLowerCase() === this.bd.toLowerCase())) : null;
    this.origenSel = (porBase || this.origenes[0])?.id || '';
  }

  get hayPlantilla(): boolean { return /<VALOR>|<SECRETO>/.test(this.sql); }
  get puedeEjecutar(): boolean { return this.puede && !this.motivo && !this.ejecutando && !!this.sql.trim() && !!this.origenSel && !this.hayPlantilla; }

  ejecutar(): void {
    if (!this.puedeEjecutar) return;
    this.ejecutando = true;
    this.error = '';
    this.resultado = null;
    this.servicio.ejecutarQuery({ origenId: this.origenSel, bd: this.bd || undefined, sql: this.sql, queryId: this.queryId }).subscribe({
      next: (r) => { this.resultado = r; this.ejecutando = false; },
      error: (e) => { this.error = e?.error?.error || 'No se pudo ejecutar la consulta.'; this.ejecutando = false; },
    });
  }

  celda(v: string | number | boolean | null): string { return v === null ? 'NULL' : String(v); }

  private texto(sep: string): string {
    const r = this.resultado;
    if (!r) return '';
    const limpia = (v: string | number | boolean | null) => (v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
    return [r.columnas.join(sep), ...r.filas.map((f) => f.map(limpia).join(sep))].join('\n');
  }

  private marcar(que: string): void {
    this.copiado = que;
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => { this.copiado = ''; }, 2000);
  }

  copiarTabla(): void {
    const t = this.texto('\t');
    navigator.clipboard.writeText(t).then(() => this.marcar('tabla'), () => { this.error = 'El navegador no permitió copiar.'; });
  }

  descargarCsv(): void {
    const r = this.resultado;
    if (!r) return;
    const esc = (v: string | number | boolean | null) => `"${(v === null ? '' : String(v)).replace(/"/g, '""')}"`;
    const csv = '﻿' + [r.columnas.map(esc).join(';'), ...r.filas.map((f) => f.map(esc).join(';'))].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `resultado_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  trackFila(i: number): number { return i; }
}
