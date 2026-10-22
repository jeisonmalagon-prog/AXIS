import { Observable } from 'rxjs';
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Notificacion, NotificacionService } from '../../core/services/notificacion.service';
import { ManualesService } from '../../core/services/manuales.service';
import { BitacoraAccesoService, PermisoAcceso } from '../../core/services/bitacora-acceso.service';

type Filtro = 'todas' | 'sinLeer';

const ETIQUETA_TIPO: Record<string, string> = {
  TAREA_VENCIDA: 'Tareas', TAREA_HOY: 'Tareas', TAREA_PROXIMA: 'Tareas', TAREA_ASIGNADA: 'Tareas',
  PASO_PROXIMO: 'Pasos a producción', PASO_SIN_CERRAR: 'Pasos a producción', PASO_ESTADO: 'Pasos a producción',
  MANUAL_COMPARTIR: 'Manuales', MANUAL_RESPUESTA: 'Manuales', MANUAL_REVOCADO: 'Manuales', MANUAL_PERMISO: 'Manuales',
  PASO_PARTICIPANTE: 'Pasos a producción', PASO_FUSIONADO: 'Pasos a producción',
  BITACORA_COMPARTIR: 'Bitácora', BITACORA_SOLICITUD: 'Bitácora', BITACORA_RESPUESTA: 'Bitácora', BITACORA_OTORGADO: 'Bitácora',
  BITACORA_REVOCADO: 'Bitácora', BITACORA_EQUIPO: 'Bitácora',
};

@Component({
  selector: 'app-notificaciones',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notificaciones.component.html',
  styleUrl: './notificaciones.component.scss',
})
export class NotificacionesComponent implements OnInit {
  cargando = true;
  error = '';
  noDisponible = '';
  filtro: Filtro = 'todas';
  items: Notificacion[] = [];
  noLeidas = 0;
  respondiendo: number | null = null;

  constructor(private servicio: NotificacionService, private manuales: ManualesService, private bitacora: BitacoraAccesoService, private router: Router) {}

  ngOnInit(): void { this.cargar(true); }

  cargar(actualizar = false): void {
    this.cargando = true;
    this.servicio.listar({ soloNoLeidas: this.filtro === 'sinLeer', limite: 200, actualizar }).subscribe({
      next: (b) => {
        this.cargando = false;
        this.error = '';
        this.noDisponible = b.disponible ? '' : (b.mensaje || 'Las notificaciones no están disponibles todavía.');
        this.items = b.items;
        this.noLeidas = b.noLeidas;
      },
      error: (err) => { this.cargando = false; this.error = err?.error?.error || 'No se pudieron cargar las notificaciones.'; },
    });
  }

  cambiarFiltro(f: Filtro): void { if (this.filtro !== f) { this.filtro = f; this.cargar(); } }

  trackId = (_: number, n: Notificacion): number => n.id;

  etiqueta(n: Notificacion): string { return ETIQUETA_TIPO[n.tipo] || 'Aviso'; }

  abrir(n: Notificacion): void {
    if (!n.leida && n.accion !== 'PENDIENTE') this.marcarLeida(n);
    if (n.enlace) this.router.navigateByUrl(n.enlace);
  }

  marcarLeida(n: Notificacion): void {
    if (n.leida) return;
    this.servicio.leer(n.id).subscribe({ next: () => { n.leida = true; this.noLeidas = Math.max(0, this.noLeidas - 1); this.avisarCambio(); } });
  }

  marcarTodas(): void {
    this.servicio.leerTodas().subscribe({ next: () => this.cargar() });
  }

  descartar(n: Notificacion): void {
    this.servicio.descartar(n.id).subscribe({
      next: () => { this.items = this.items.filter((x) => x.id !== n.id); if (!n.leida) this.noLeidas = Math.max(0, this.noLeidas - 1); this.avisarCambio(); },
      error: (err) => { this.error = err?.error?.error || 'No se pudo descartar.'; },
    });
  }

  responder(n: Notificacion, aceptar: boolean, permiso?: PermisoAcceso): void {
    if (this.respondiendo || n.referencia === null) return;
    this.respondiendo = n.id;
    const llamada: Observable<{ estado: string }> = n.tipo.startsWith('BITACORA_')
      ? this.bitacora.responder(n.referencia, aceptar, permiso)
      : this.manuales.responderSolicitud(n.referencia, aceptar);
    llamada.subscribe({
      next: (r) => {
        this.respondiendo = null;
        n.accion = r.estado === 'ACEPTADA' ? 'ACEPTADA' : 'RECHAZADA';
        n.leida = true;
        this.avisarCambio();
        this.cargar();
      },
      error: (err) => { this.respondiendo = null; this.error = err?.error?.error || 'No se pudo responder la solicitud.'; this.cargar(); },
    });
  }

  /** Avisa al encabezado para que refresque el número de la campana. */
  private avisarCambio(): void { window.dispatchEvent(new CustomEvent('axis:notificaciones')); }
}
