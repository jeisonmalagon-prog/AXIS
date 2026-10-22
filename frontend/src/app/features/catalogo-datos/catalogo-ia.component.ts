import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CatalogoDatosService, ConfigConstructor, OrigenEstado, RespuestaIa, TablaRef } from '../../core/services/catalogo-datos.service';
import { QueryEjecucionComponent } from './query-ejecucion.component';

export interface BorradorQuery { consulta: string; titulo: string; descripcion: string; config?: ConfigConstructor | null; }

const CLAVE_PREGUNTA = 'axis.catalogo.queries.ia.pregunta';

// Asistente de lenguaje natural: la IA recibe solo las tablas del catálogo y los queries del equipo que
// encajan con la petición, y devuelve un SELECT que se valida (solo lectura, tablas y columnas existentes).
@Component({
  selector: 'app-catalogo-ia',
  standalone: true,
  imports: [CommonModule, FormsModule, QueryEjecucionComponent],
  templateUrl: './catalogo-ia.component.html',
  styleUrl: './catalogo-ia.component.scss',
})
export class CatalogoIaComponent implements OnInit {
  @Input() origenes: OrigenEstado[] = [];
  @Input() puedeEditar = false;
  /** Tablas elegidas en el constructor (opcional, orientan a la IA). */
  @Input() tablasElegidas: TablaRef[] = [];
  @Output() guardar = new EventEmitter<BorradorQuery>();

  pregunta = '';
  usarTablas = false;
  cargando = false;
  error = '';
  respuesta: RespuestaIa | null = null;
  sqlEditable = '';
  copiado = false;
  private temporizador: ReturnType<typeof setTimeout> | null = null;

  readonly ejemplos = [
    'Trazas de un documento con el método y el mensaje',
    'Flujos de LP que están detenidos en una etapa',
    'Cuántas solicitudes se radicaron por día esta semana',
    'Transacciones PSE con error en los últimos 3 días',
  ];

  constructor(private servicio: CatalogoDatosService) {}

  ngOnInit(): void {
    try { this.pregunta = localStorage.getItem(CLAVE_PREGUNTA) || ''; } catch { /* sin almacenamiento */ }
    this.usarTablas = this.tablasElegidas.length > 0;
  }

  get puedePreguntar(): boolean { return !this.cargando && this.pregunta.trim().length >= 8; }

  usarEjemplo(e: string): void { this.pregunta = e; }

  preguntar(): void {
    if (!this.puedePreguntar) return;
    this.cargando = true;
    this.error = '';
    this.respuesta = null;
    try { localStorage.setItem(CLAVE_PREGUNTA, this.pregunta.trim()); } catch { /* sin almacenamiento */ }
    this.servicio.preguntarIa({ pregunta: this.pregunta.trim(), tablas: this.usarTablas ? this.tablasElegidas : [] }).subscribe({
      next: (r) => { this.respuesta = r; this.sqlEditable = r.sql; this.cargando = false; },
      error: (e) => { this.error = e?.error?.error || 'No se pudo consultar a la IA.'; this.cargando = false; },
    });
  }

  copiar(): void {
    navigator.clipboard.writeText(this.sqlEditable).then(() => {
      this.copiado = true;
      if (this.temporizador) clearTimeout(this.temporizador);
      this.temporizador = setTimeout(() => { this.copiado = false; }, 2000);
    }, () => { this.error = 'El navegador no permitió copiar.'; });
  }

  guardarEnRepositorio(): void {
    if (!this.respuesta) return;
    this.guardar.emit({ consulta: this.sqlEditable, titulo: this.pregunta.trim().slice(0, 120), descripcion: this.respuesta.explicacion });
  }

  get motivoBloqueo(): string {
    const r = this.respuesta;
    return r && !r.soloLectura.ok ? r.soloLectura.motivo : '';
  }
}
