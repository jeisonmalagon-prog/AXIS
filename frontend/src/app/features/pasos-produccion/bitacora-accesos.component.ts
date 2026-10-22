import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AccesoBitacora, AccesosBitacora, BitacoraAccesoService, EquipoBitacora, PermisoAcceso, PersonaBitacora,
} from '../../core/services/bitacora-acceso.service';
import { SelectorPersonasComponent } from './selector-personas.component';

/**
 * Panel «Accesos» de la bitácora: aceptar lo que te comparten, responder solicitudes, compartir la tuya,
 * ver quién ve qué y pedir acceso a una persona o a un equipo. ADMIN_POD ve y gestiona todos los accesos.
 */
@Component({
  selector: 'app-bitacora-accesos',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectorPersonasComponent],
  templateUrl: './bitacora-accesos.component.html',
  styleUrl: './bitacora-accesos.component.scss',
})
export class BitacoraAccesosComponent implements OnInit {
  /** Cambió algo que afecta lo que se ve (para recargar vistas y pasos). */
  @Output() cambioDatos = new EventEmitter<void>();
  @Output() cerrar = new EventEmitter<void>();
  /** Avisa cuántas cosas esperan respuesta (para la insignia). */
  @Output() pendientes = new EventEmitter<number>();

  @Input() esAdmin = false;

  datos: AccesosBitacora | null = null;
  personas: PersonaBitacora[] = [];
  personasTodas: PersonaBitacora[] = [];
  equipos: EquipoBitacora[] = [];
  cargando = true;
  error = '';
  info = '';
  trabajando: string | null = null;
  permisos: Record<number, PermisoAcceso> = {};

  compartirIds: number[] = [];
  compartirEquipo: number | null = null;
  compartirPermiso: PermisoAcceso = 'LECTURA';

  pedirIds: number[] = [];
  pedirEquipo: number | null = null;

  adminPropietario: number | null = null;
  adminIds: number[] = [];
  adminPermiso: PermisoAcceso = 'LECTURA';

  constructor(private api: BitacoraAccesoService) {}

  ngOnInit(): void {
    this.api.personas().subscribe({ next: (p) => (this.personas = p), error: () => (this.personas = []) });
    this.api.equipos().subscribe({ next: (e) => (this.equipos = e), error: () => (this.equipos = []) });
    if (this.esAdmin) this.api.personas(true).subscribe({ next: (p) => (this.personasTodas = p), error: () => (this.personasTodas = []) });
    this.recargar();
  }

  recargar(): void {
    this.api.accesos().subscribe({
      next: (d) => {
        this.datos = d;
        this.cargando = false;
        for (const a of d.solicitudesPorResponder) if (!this.permisos[a.id]) this.permisos[a.id] = a.permiso;
        this.pendientes.emit(d.porAceptar.length + d.solicitudesPorResponder.length);
      },
      error: (e) => { this.cargando = false; this.error = e?.error?.error || 'No se pudieron cargar los accesos.'; },
    });
  }

  private hecho(mensaje: string, cambia = true): void {
    this.trabajando = null;
    this.error = '';
    this.info = mensaje;
    this.recargar();
    if (cambia) this.cambioDatos.emit();
  }

  private fallo(e: any, def: string): void {
    this.trabajando = null;
    this.info = '';
    this.error = e?.error?.error || def;
  }

  alcance(a: AccesoBitacora): string {
    return a.alcance === 'COMPLETA' ? 'bitácora completa' : `paso «${a.paso || '#' + a.pasoId}»`;
  }

  etiquetaPermiso(p: PermisoAcceso): string {
    return p === 'EDICION' ? 'Puede editar' : 'Solo lectura';
  }

  nombreOrigen(a: AccesoBitacora): string {
    return a.origen === 'ADMIN' ? 'dado por un administrador' : a.origen === 'SOLICITUD' ? 'a solicitud' : 'compartido por su dueño';
  }

  // ---- responder ----
  aceptar(a: AccesoBitacora, aceptar: boolean): void {
    this.trabajando = `r${a.id}`;
    this.api.responder(a.id, aceptar).subscribe({
      next: () => this.hecho(aceptar ? 'Aceptaste. Ya puedes ver ese contenido en tu bitácora.' : 'Rechazaste el ofrecimiento.'),
      error: (e) => this.fallo(e, 'No se pudo responder.'),
    });
  }

  aprobar(a: AccesoBitacora, aprobar: boolean): void {
    this.trabajando = `r${a.id}`;
    this.api.responder(a.id, aprobar, this.permisos[a.id] || a.permiso).subscribe({
      next: () => this.hecho(aprobar ? `Aprobaste la solicitud de ${a.usuario}.` : 'Rechazaste la solicitud.'),
      error: (e) => this.fallo(e, 'No se pudo responder.'),
    });
  }

  cambiarPermiso(a: AccesoBitacora, permiso: PermisoAcceso): void {
    if (permiso === a.permiso) return;
    this.trabajando = `p${a.id}`;
    this.api.cambiarPermiso(a.id, permiso).subscribe({
      next: () => this.hecho('Permiso actualizado.'),
      error: (e) => this.fallo(e, 'No se pudo cambiar el permiso.'),
    });
  }

  quitar(a: AccesoBitacora, texto = 'Se quitó el acceso.'): void {
    this.trabajando = `q${a.id}`;
    this.api.quitar(a.id).subscribe({
      next: () => this.hecho(texto),
      error: (e) => this.fallo(e, 'No se pudo quitar el acceso.'),
    });
  }

  // ---- compartir mi bitácora ----
  get puedeCompartir(): boolean {
    return this.compartirIds.length > 0 || !!this.compartirEquipo;
  }

  compartirCompleta(): void {
    if (!this.puedeCompartir) return;
    this.trabajando = 'compartir';
    this.api.compartir({ destinatarioIds: this.compartirIds, equipoId: this.compartirEquipo, permiso: this.compartirPermiso }).subscribe({
      next: (r) => {
        this.compartirIds = [];
        this.compartirEquipo = null;
        const partes: string[] = [];
        if (r.creados) partes.push(`${r.creados} ofrecimiento(s) enviado(s) (cada persona debe aceptar)`);
        if (r.aprobados) partes.push(`${r.aprobados} solicitud(es) aprobada(s)`);
        if (r.actualizados) partes.push(`${r.actualizados} actualizado(s)`);
        if (r.yaPendientes) partes.push(`${r.yaPendientes} ya estaba(n) pendiente(s)`);
        if (r.omitidosPorParticipar) partes.push(`${r.omitidosPorParticipar} ya participa(n) en tus pasos`);
        if (r.sinModulo) partes.push(`${r.sinModulo} sin acceso al módulo`);
        this.hecho(partes.join('; ') || 'Sin cambios.');
      },
      error: (e) => this.fallo(e, 'No se pudo compartir.'),
    });
  }

  // ---- pedir acceso ----
  get puedePedir(): boolean {
    return this.pedirIds.length > 0 || !!this.pedirEquipo;
  }

  solicitar(): void {
    if (!this.puedePedir) return;
    this.trabajando = 'pedir';
    this.api.solicitar({ propietarioIds: this.pedirIds, equipoId: this.pedirEquipo }).subscribe({
      next: (r) => {
        this.pedirIds = [];
        this.pedirEquipo = null;
        const partes: string[] = [];
        if (r.enviadas) partes.push(`${r.enviadas} solicitud(es) enviada(s)`);
        if (r.aceptadas) partes.push(`${r.aceptadas} ya te habían ofrecido: quedó aceptada`);
        if (r.yaTenias) partes.push(`${r.yaTenias} ya tenías acceso`);
        if (r.yaPendientes) partes.push(`${r.yaPendientes} ya estaba(n) pendiente(s)`);
        if (r.sinModulo) partes.push(`${r.sinModulo} sin acceso al módulo`);
        this.hecho(partes.join('; ') || 'Sin cambios.');
      },
      error: (e) => this.fallo(e, 'No se pudo enviar la solicitud.'),
    });
  }

  // ---- administrador ----
  darAcceso(): void {
    if (!this.adminPropietario || !this.adminIds.length) return;
    this.trabajando = 'admin';
    this.api.compartir({ destinatarioIds: this.adminIds, permiso: this.adminPermiso, propietarioId: this.adminPropietario }).subscribe({
      next: () => { this.adminIds = []; this.hecho('Acceso otorgado.'); },
      error: (e) => this.fallo(e, 'No se pudo otorgar el acceso.'),
    });
  }

  nombrePersona(p: PersonaBitacora): string {
    return p.nombre_completo || p.username;
  }

  trackAcceso = (_: number, a: AccesoBitacora) => a.id;
}
