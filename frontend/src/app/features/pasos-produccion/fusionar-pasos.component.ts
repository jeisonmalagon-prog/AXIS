import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BitacoraAccesoService } from '../../core/services/bitacora-acceso.service';

export interface OpcionFusion {
  id: number;
  titulo: string;
  rfc: string | null;
  entorno: string;
  estado: string;
  fechaHoraProgramada: string;
  creadoPor: string;
  participantes: string;
  puedeConservar: boolean;
  puedeAbsorber: boolean;
}

const ETIQUETA_ESTADO: Record<string, string> = {
  PROGRAMADO: 'Programado', EJECUTADO: 'Ejecutado', CANCELADO: 'Cancelado', REAGENDADO: 'Reagendado', ROLLBACK: 'Rollback',
};

/** Unir pasos duplicados (mismo RFC y ambiente) en uno solo, sin perder participantes, checklist ni evidencias. */
@Component({
  selector: 'app-fusionar-pasos',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './fusionar-pasos.component.html',
  styleUrl: './fusionar-pasos.component.scss',
})
export class FusionarPasosComponent implements OnInit {
  /** Todos los pasos del grupo (el de la fila y sus duplicados). */
  @Input({ required: true }) opciones: OpcionFusion[] = [];
  /** Paso que arranca marcado como el que se conserva. */
  @Input() preseleccion: number | null = null;
  @Output() cerrar = new EventEmitter<void>();
  @Output() fusionado = new EventEmitter<void>();

  conservarId: number | null = null;
  trabajando = false;
  error = '';

  constructor(private api: BitacoraAccesoService) {}

  ngOnInit(): void {
    const pre = this.opciones.find((o) => o.id === this.preseleccion && o.puedeConservar);
    this.conservarId = (pre || this.opciones.find((o) => o.puedeConservar) || this.opciones[0] || null)?.id ?? null;
  }

  etiquetaEstado(e: string): string {
    return ETIQUETA_ESTADO[e] || e;
  }

  get aAbsorber(): OpcionFusion[] {
    return this.opciones.filter((o) => o.id !== this.conservarId);
  }

  get conservado(): OpcionFusion | undefined {
    return this.opciones.find((o) => o.id === this.conservarId);
  }

  /** Por qué no se puede fusionar con la elección actual (o vacío si se puede). */
  get impedimento(): string {
    const k = this.conservado;
    if (!k) return 'Elige el paso que se conserva.';
    if (!k.puedeConservar) return 'No puedes modificar ese paso (lo tienes solo en lectura): elige otro para conservar.';
    const ajeno = this.aAbsorber.find((o) => !o.puedeAbsorber);
    if (ajeno) return `«${ajeno.titulo}» lo creó ${ajeno.creadoPor}: solo esa persona (o un administrador) puede fusionarlo. Elígelo como el que se conserva, o pídele que lo haga.`;
    return '';
  }

  fusionar(): void {
    if (this.impedimento || this.trabajando || this.conservarId === null) return;
    this.trabajando = true;
    this.error = '';
    this.api.fusionar(this.conservarId, this.aAbsorber.map((o) => o.id)).subscribe({
      next: () => { this.trabajando = false; this.fusionado.emit(); },
      error: (e) => { this.trabajando = false; this.error = e?.error?.error || 'No se pudieron fusionar los pasos.'; },
    });
  }
}
