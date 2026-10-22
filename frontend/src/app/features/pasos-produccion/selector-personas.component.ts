import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EquipoBitacora, PersonaBitacora } from '../../core/services/bitacora-acceso.service';

/**
 * Elegir varias personas: buscador + casillas, y «agregar un equipo» para marcar de una vez a todos
 * sus integrantes. Devuelve los ids elegidos (enlace en los dos sentidos con `seleccion`).
 */
@Component({
  selector: 'app-selector-personas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './selector-personas.component.html',
  styleUrl: './selector-personas.component.scss',
})
export class SelectorPersonasComponent {
  @Input() personas: PersonaBitacora[] = [];
  @Input() equipos: EquipoBitacora[] = [];
  @Input() seleccion: number[] = [];
  @Input() placeholder = 'Buscar persona…';
  @Input() deshabilitado = false;
  @Output() seleccionChange = new EventEmitter<number[]>();

  texto = '';
  equipoElegido: number | null = null;

  nombre(p: PersonaBitacora): string {
    return p.nombre_completo || p.username;
  }

  get filtradas(): PersonaBitacora[] {
    const t = this.texto.trim().toLowerCase();
    if (!t) return this.personas;
    return this.personas.filter((p) => `${p.nombre_completo || ''} ${p.username}`.toLowerCase().includes(t));
  }

  get elegidas(): PersonaBitacora[] {
    const set = new Set(this.seleccion);
    return this.personas.filter((p) => set.has(p.id));
  }

  marcada(id: number): boolean {
    return this.seleccion.includes(id);
  }

  alternar(id: number, evento: Event): void {
    const marcar = (evento.target as HTMLInputElement).checked;
    const sin = this.seleccion.filter((x) => x !== id);
    this.emitir(marcar ? [...sin, id] : sin);
  }

  quitar(id: number): void {
    this.emitir(this.seleccion.filter((x) => x !== id));
  }

  agregarEquipo(): void {
    const eq = this.equipos.find((e) => e.id === Number(this.equipoElegido));
    this.equipoElegido = null;
    if (!eq) return;
    const validos = new Set(this.personas.map((p) => p.id));
    const nuevos = eq.miembros.map((m) => m.id).filter((id) => validos.has(id));
    this.emitir([...new Set([...this.seleccion, ...nuevos])]);
  }

  limpiar(): void {
    this.emitir([]);
  }

  private emitir(ids: number[]): void {
    this.seleccion = ids;
    this.seleccionChange.emit(ids);
  }
}
