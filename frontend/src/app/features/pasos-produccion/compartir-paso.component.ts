import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AccesoBitacora, AccesosPaso, BitacoraAccesoService, EquipoBitacora, PermisoAcceso, PersonaBitacora,
} from '../../core/services/bitacora-acceso.service';
import { SelectorPersonasComponent } from './selector-personas.component';

/** «Compartir paso»: un solo paso (sin copiarlo) con personas o un equipo; quien recibe acepta. */
@Component({
  selector: 'app-compartir-paso',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectorPersonasComponent],
  templateUrl: './compartir-paso.component.html',
  styleUrl: './compartir-paso.component.scss',
})
export class CompartirPasoComponent implements OnInit {
  @Input({ required: true }) pasoId!: number;
  @Input() titulo = '';
  @Output() cerrar = new EventEmitter<void>();

  datos: AccesosPaso | null = null;
  personas: PersonaBitacora[] = [];
  equipos: EquipoBitacora[] = [];
  cargando = true;
  trabajando = false;
  error = '';
  info = '';

  ids: number[] = [];
  equipoId: number | null = null;
  permiso: PermisoAcceso = 'LECTURA';

  constructor(private api: BitacoraAccesoService) {}

  ngOnInit(): void {
    this.api.personas().subscribe({ next: (p) => (this.personas = p), error: () => (this.personas = []) });
    this.api.equipos().subscribe({ next: (e) => (this.equipos = e), error: () => (this.equipos = []) });
    this.recargar();
  }

  recargar(): void {
    this.api.accesosDePaso(this.pasoId).subscribe({
      next: (d) => { this.datos = d; this.cargando = false; },
      error: (e) => { this.cargando = false; this.error = e?.error?.error || 'No se pudo cargar el paso.'; },
    });
  }

  /** Quien ya participa no necesita que se le comparta: no se ofrece como destinatario. */
  get candidatos(): PersonaBitacora[] {
    const part = new Set((this.datos?.participantes || []).map((p) => p.id));
    return this.personas.filter((p) => !part.has(p.id));
  }

  get puedeEnviar(): boolean {
    return this.ids.length > 0 || !!this.equipoId;
  }

  etiquetaPermiso(p: PermisoAcceso): string {
    return p === 'EDICION' ? 'Puede editar' : 'Solo lectura';
  }

  enviar(): void {
    if (!this.puedeEnviar) return;
    this.trabajando = true;
    this.error = '';
    this.api.compartir({ pasoId: this.pasoId, destinatarioIds: this.ids, equipoId: this.equipoId, permiso: this.permiso }).subscribe({
      next: (r) => {
        this.trabajando = false;
        this.ids = [];
        this.equipoId = null;
        const partes: string[] = [];
        if (r.creados) partes.push(`${r.creados} ofrecimiento(s) enviado(s); cada persona debe aceptar`);
        if (r.aprobados) partes.push(`${r.aprobados} solicitud(es) aprobada(s)`);
        if (r.actualizados) partes.push(`${r.actualizados} actualizado(s)`);
        if (r.yaPendientes) partes.push(`${r.yaPendientes} ya estaba(n) pendiente(s)`);
        if (r.omitidosPorParticipar) partes.push(`${r.omitidosPorParticipar} ya participa(n) en el paso`);
        if (r.sinModulo) partes.push(`${r.sinModulo} sin acceso al módulo`);
        this.info = partes.join('; ') || 'Sin cambios.';
        this.recargar();
      },
      error: (e) => { this.trabajando = false; this.info = ''; this.error = e?.error?.error || 'No se pudo compartir el paso.'; },
    });
  }

  cambiarPermiso(a: AccesoBitacora, permiso: PermisoAcceso): void {
    if (permiso === a.permiso) return;
    this.api.cambiarPermiso(a.id, permiso).subscribe({
      next: () => { this.info = 'Permiso actualizado.'; this.error = ''; this.recargar(); },
      error: (e) => { this.info = ''; this.error = e?.error?.error || 'No se pudo cambiar el permiso.'; },
    });
  }

  quitar(a: AccesoBitacora): void {
    this.api.quitar(a.id).subscribe({
      next: () => { this.info = 'Se quitó el acceso.'; this.error = ''; this.recargar(); },
      error: (e) => { this.info = ''; this.error = e?.error?.error || 'No se pudo quitar el acceso.'; },
    });
  }
}
