import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ManualVersion, ManualVersionMeta, ManualesService } from '../../core/services/manuales.service';
import { fechaCorta, fechaLarga, mensajeDeError, tamanoLegible } from './manuales-util';

@Component({
  selector: 'app-manual-historial',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './manual-historial.component.html',
  styleUrl: './manual-historial.component.scss',
})
export class ManualHistorialComponent implements OnInit {
  @Input({ required: true }) paginaId!: number;
  @Input() tituloPagina = '';
  @Input() puedeEditar = false;
  @Output() cerrar = new EventEmitter<void>();
  @Output() restaurada = new EventEmitter<void>();

  versiones: ManualVersionMeta[] = [];
  cargando = true;
  error = '';
  elegida: ManualVersion | null = null;
  vista: SafeHtml = '';
  cargandoVersion = false;
  restaurando = false;
  confirmando = false;
  readonly tamano = tamanoLegible;
  readonly corta = fechaCorta;
  readonly larga = fechaLarga;

  constructor(private servicio: ManualesService, private sanitizer: DomSanitizer) {}

  ngOnInit(): void {
    this.servicio.versiones(this.paginaId).subscribe({
      next: (v) => { this.versiones = v; this.cargando = false; if (v.length) this.elegir(v[0]); },
      error: async (e) => { this.error = await mensajeDeError(e, 'No se pudo cargar el historial.'); this.cargando = false; },
    });
  }

  elegir(v: ManualVersionMeta): void {
    this.cargandoVersion = true;
    this.confirmando = false;
    this.servicio.version(v.id).subscribe({
      next: (d) => {
        this.elegida = d;
        // El servidor ya limpia el HTML de cada versión antes de devolverlo.
        this.vista = this.sanitizer.bypassSecurityTrustHtml(d.html);
        this.cargandoVersion = false;
      },
      error: async (e) => { this.error = await mensajeDeError(e, 'No se pudo abrir esa versión.'); this.cargandoVersion = false; },
    });
  }

  restaurar(): void {
    if (!this.elegida) return;
    this.restaurando = true;
    this.servicio.restaurar(this.paginaId, this.elegida.id).subscribe({
      next: () => { this.restaurando = false; this.restaurada.emit(); },
      error: async (e) => { this.error = await mensajeDeError(e, 'No se pudo restaurar la versión.'); this.restaurando = false; this.confirmando = false; },
    });
  }
}
