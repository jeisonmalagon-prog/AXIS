import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BitacoraAccesoService, EquipoBitacora, PersonaBitacora } from '../../core/services/bitacora-acceso.service';
import { SelectorPersonasComponent } from './selector-personas.component';

/** Equipos de la bitácora (aplicaciones, BUS, desarrollo…). ADMIN_POD los crea y asigna las personas; el resto los consulta. */
@Component({
  selector: 'app-bitacora-equipos',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectorPersonasComponent],
  templateUrl: './bitacora-equipos.component.html',
  styleUrl: './bitacora-equipos.component.scss',
})
export class BitacoraEquiposComponent implements OnInit {
  @Input() esAdmin = false;
  @Output() cerrar = new EventEmitter<void>();
  @Output() cambioDatos = new EventEmitter<void>();

  equipos: EquipoBitacora[] = [];
  personas: PersonaBitacora[] = [];
  cargando = true;
  error = '';
  info = '';
  guardando = false;

  editando: EquipoBitacora | 'nuevo' | null = null;
  nombre = '';
  descripcion = '';
  integrantes: number[] = [];

  constructor(private api: BitacoraAccesoService) {}

  ngOnInit(): void {
    if (this.esAdmin) this.api.personas(true).subscribe({ next: (p) => (this.personas = p), error: () => (this.personas = []) });
    this.recargar();
  }

  recargar(): void {
    this.api.equipos().subscribe({
      next: (e) => { this.equipos = e; this.cargando = false; },
      error: (e) => { this.cargando = false; this.error = e?.error?.error || 'No se pudieron cargar los equipos.'; },
    });
  }

  nuevo(): void {
    this.editando = 'nuevo';
    this.nombre = '';
    this.descripcion = '';
    this.integrantes = [];
    this.error = '';
    this.info = '';
  }

  editar(e: EquipoBitacora): void {
    this.editando = e;
    this.nombre = e.nombre;
    this.descripcion = e.descripcion || '';
    this.integrantes = e.miembros.map((m) => m.id);
    this.error = '';
    this.info = '';
  }

  nombres(e: EquipoBitacora): string {
    const n = e.miembros.map((m) => m.nombre || m.username);
    return n.length > 8 ? `${n.slice(0, 8).join(', ')} y ${n.length - 8} más` : n.join(', ') || 'sin integrantes';
  }

  cancelar(): void {
    this.editando = null;
  }

  guardar(): void {
    const nombre = this.nombre.trim();
    if (!nombre) { this.error = 'El equipo necesita un nombre.'; return; }
    const cuerpo = { nombre, descripcion: this.descripcion.trim() || null, usuarioIds: this.integrantes };
    this.guardando = true;
    this.error = '';
    const peticion = this.editando === 'nuevo' || !this.editando ? this.api.crearEquipo(cuerpo) : this.api.actualizarEquipo(this.editando.id, cuerpo);
    peticion.subscribe({
      next: () => {
        this.guardando = false;
        this.info = this.editando === 'nuevo' ? 'Equipo creado.' : 'Equipo actualizado.';
        this.editando = null;
        this.recargar();
        this.cambioDatos.emit();
      },
      error: (e) => { this.guardando = false; this.error = e?.error?.error || 'No se pudo guardar el equipo.'; },
    });
  }

  eliminar(e: EquipoBitacora): void {
    if (!confirm(`¿Eliminar el equipo «${e.nombre}»? Los accesos ya concedidos no cambian.`)) return;
    this.api.eliminarEquipo(e.id).subscribe({
      next: () => { this.info = 'Equipo eliminado.'; this.recargar(); this.cambioDatos.emit(); },
      error: (er) => (this.error = er?.error?.error || 'No se pudo eliminar el equipo.'),
    });
  }
}
