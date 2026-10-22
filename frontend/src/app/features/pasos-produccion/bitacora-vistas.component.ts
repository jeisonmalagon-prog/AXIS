import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BitacoraAccesoService, EstadoBitacora, SeleccionBitacora, VistasBitacora } from '../../core/services/bitacora-acceso.service';
import { BitacoraAccesosComponent } from './bitacora-accesos.component';
import { BitacoraEquiposComponent } from './bitacora-equipos.component';

/**
 * Barra «De quién es la bitácora que veo»: mi bitácora, la de personas que me dieron acceso, los pasos
 * compartidos conmigo, todo lo que puedo ver y uno o varios equipos. Aloja los paneles de Accesos y Equipos.
 */
@Component({
  selector: 'app-bitacora-vistas',
  standalone: true,
  imports: [CommonModule, BitacoraAccesosComponent, BitacoraEquiposComponent],
  templateUrl: './bitacora-vistas.component.html',
  styleUrl: './bitacora-vistas.component.scss',
})
export class BitacoraVistasComponent implements OnInit, OnChanges {
  /** Abre el panel de accesos al entrar (viene de una notificación). */
  @Input() abrirAccesos = false;
  /** Cambia cuando el listado cambió (se crea o borra un paso): recarga los contadores. */
  @Input() refresco = 0;
  @Output() seleccionChange = new EventEmitter<SeleccionBitacora>();
  @Output() estadoChange = new EventEmitter<EstadoBitacora>();
  @Output() accesosAbiertos = new EventEmitter<void>();
  /** Cambió quién ve qué: el listado debe recargarse. */
  @Output() cambioDatos = new EventEmitter<void>();

  estado: EstadoBitacora | null = null;
  vistas: VistasBitacora | null = null;
  propietarios = new Set<string>(['yo']);
  equipos = new Set<number>();
  compartidos = false;
  todos = false;

  mostrarAccesos = false;
  mostrarEquipos = false;
  pendientes = 0;

  constructor(private api: BitacoraAccesoService) {}

  ngOnInit(): void {
    this.api.estado().subscribe({
      next: (e) => {
        this.estado = e;
        this.estadoChange.emit(e);
        if (e.disponible) {
          this.cargarVistas();
          this.cargarPendientes();
          // ADMIN_POD ve todo: arranca en «Todas» (puede cambiar a su propia bitácora, a una persona o a equipos).
          if (e.esAdmin) { this.todos = true; this.propietarios.clear(); this.emitir(); }
        }
        if (this.abrirAccesos && e.disponible) this.abrirPanelAccesos();
      },
      error: () => {
        // Sin saber el estado, se deja la bitácora funcionando como siempre.
        this.estado = { disponible: false, mensaje: null, serviciosDisponible: false, esAdmin: false, yo: { id: 0, nombre: '' } };
        this.estadoChange.emit(this.estado);
      },
    });
  }

  ngOnChanges(c: SimpleChanges): void {
    if (c['abrirAccesos'] && this.abrirAccesos && this.estado?.disponible) this.abrirPanelAccesos();
    if (c['refresco'] && !c['refresco'].firstChange && this.estado?.disponible) this.cargarVistas();
  }

  cargarVistas(): void {
    this.api.vistas().subscribe({ next: (v) => (this.vistas = v), error: () => {} });
  }

  private cargarPendientes(): void {
    this.api.accesos().subscribe({
      next: (d) => (this.pendientes = d.porAceptar.length + d.solicitudesPorResponder.length),
      error: () => {},
    });
  }

  get seleccion(): SeleccionBitacora {
    return { propietarios: [...this.propietarios], equipos: [...this.equipos], compartidos: this.compartidos, todos: this.todos };
  }

  private emitir(): void {
    if (!this.todos && !this.propietarios.size && !this.equipos.size && !this.compartidos) this.propietarios.add('yo');
    this.seleccionChange.emit(this.seleccion);
  }

  activa(clave: string): boolean { return !this.todos && this.propietarios.has(clave); }
  equipoActivo(id: number): boolean { return !this.todos && this.equipos.has(id); }

  alternarPropietario(clave: string): void {
    this.todos = false;
    if (this.propietarios.has(clave)) this.propietarios.delete(clave); else this.propietarios.add(clave);
    this.emitir();
  }

  alternarEquipo(id: number): void {
    this.todos = false;
    if (this.equipos.has(id)) this.equipos.delete(id);
    else {
      // Al elegir un equipo se deja de mirar «solo la mía» (puedes volver a marcarla para sumarla).
      if (!this.equipos.size && this.propietarios.size === 1 && this.propietarios.has('yo')) this.propietarios.clear();
      this.equipos.add(id);
    }
    this.emitir();
  }

  alternarCompartidos(): void {
    this.todos = false;
    this.compartidos = !this.compartidos;
    this.emitir();
  }

  elegirTodo(): void {
    this.todos = !this.todos;
    if (this.todos) { this.propietarios.clear(); this.equipos.clear(); this.compartidos = false; } else this.propietarios.add('yo');
    this.emitir();
  }

  /** Selección activa más de una cosa: botón para volver a «Mi bitácora». */
  get hayFiltroExtra(): boolean {
    return this.todos || this.equipos.size > 0 || this.compartidos || this.propietarios.size > 1 || !this.propietarios.has('yo');
  }

  soloMia(): void {
    this.todos = false; this.compartidos = false; this.equipos.clear(); this.propietarios = new Set(['yo']);
    this.emitir();
  }

  etiquetaPermiso(p: string | null): string {
    return p === 'EDICION' ? 'puede editar' : p === 'LECTURA' ? 'lectura' : '';
  }

  abrirPanelAccesos(): void {
    this.mostrarAccesos = true;
    this.accesosAbiertos.emit();
  }

  cerrarAccesos(): void {
    this.mostrarAccesos = false;
    this.cargarPendientes();
    this.cargarVistas();
  }

  alCambiarDatos(): void {
    this.cargarVistas();
    this.cambioDatos.emit();
  }
}
