import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NumEsPipe } from './num-es.pipe';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { AppMovilResumenComponent } from './app-movil-resumen.component';
import { TabServiciosComponent } from './tab-servicios.component';
import { TabClientesComponent } from './tab-clientes.component';
import { TabEstadoComponent } from './tab-estado.component';
import { SaludGlobalComponent } from '../app-movil-logs/salud-global.component';
import { VersionesAdopcionComponent } from '../app-movil-logs/versiones-adopcion.component';
import { EstadoTablero, RangoApp, TableroService, fmtCompacto, hace } from './tablero.service';

export type Pestana = 'resumen' | 'servicios' | 'errores' | 'versiones' | 'clientes' | 'datos';

const PESTANAS: Pestana[] = ['resumen', 'servicios', 'errores', 'versiones', 'clientes', 'datos'];

// ============================================================================
// Monitoreo de la app móvil (tablero)
// ----------------------------------------------------------------------------
// Una sola página con pestañas. Arriba, una franja «Ahora» con el semáforo del
// ETL, el tráfico de hoy y las alertas recientes (se refresca sola cada minuto,
// es barata: no toca LogApp). El rango de fechas de la cabecera lo comparten
// Resumen, Servicios y Clientes; Errores/alertas y Versiones tienen sus propios
// controles de tiempo porque trabajan sobre muestras recientes.
// ============================================================================
@Component({
  selector: 'app-app-movil',
  standalone: true,
  imports: [
    NumEsPipe, CommonModule, FormsModule, AppMovilResumenComponent, TabServiciosComponent, TabClientesComponent, TabEstadoComponent,
    SaludGlobalComponent, VersionesAdopcionComponent
  ],
  templateUrl: './app-movil.component.html',
  styleUrl: './app-movil.component.scss'
})
export class AppMovilComponent implements OnInit, OnDestroy {
  readonly pestanas: { valor: Pestana; etiqueta: string; ayuda: string; usaRango: boolean }[] = [
    { valor: 'resumen', etiqueta: 'Resumen', ayuda: 'Cómo va la app en el rango elegido', usaRango: true },
    { valor: 'servicios', etiqueta: 'Servicios y latencia', ayuda: 'Qué servicios responden lento', usaRango: true },
    { valor: 'errores', etiqueta: 'Errores y alertas', ayuda: 'Errores masivos y alertas en vivo', usaRango: false },
    { valor: 'versiones', etiqueta: 'Versiones', ayuda: 'Qué versión de la app usan los clientes', usaRango: false },
    { valor: 'clientes', etiqueta: 'Clientes', ayuda: 'Quién usa más la app y a quién le falla', usaRango: true },
    { valor: 'datos', etiqueta: 'Estado de los datos', ayuda: 'Salud del ETL que alimenta el tablero', usaRango: false }
  ];
  actual: Pestana = 'resumen';
  visitadas = new Set<Pestana>(['resumen']);
  alertaId: number | null = null;

  // Rango compartido
  readonly rangosDisponibles = [1, 7, 30, 90];
  readonly rangoDiasMaximo = 180;
  diasSeleccionados = 7;
  modoRango: 'preset' | 'personalizado' = 'preset';
  mostrandoSelectorFechas = false;
  fechaInicioInput = '';
  fechaFinInput = '';
  errorRangoPersonalizado: string | null = null;
  rango: RangoApp = { dias: 7 };
  refresco = 0;

  // Franja «Ahora»
  estado: EstadoTablero | null = null;
  estadoCargando = false;
  estadoError: string | null = null;
  estadoNoDisponible: string | null = null;
  actualizado: Date | null = null;

  readonly fmtCompacto = fmtCompacto;
  readonly hace = hace;
  private subs: Subscription[] = [];
  private sEstado?: Subscription;

  constructor(private tablero: TableroService, private ruta: ActivatedRoute, private router: Router) {}

  ngOnInit(): void {
    this.subs.push(this.ruta.queryParamMap.subscribe((q) => {
      const t = q.get('tab') as Pestana | null;
      if (t && PESTANAS.includes(t) && t !== this.actual) this.irA(t, false);
      const a = Number(q.get('alerta'));
      if (a > 0) { this.alertaId = a; this.irA('errores', false); }
    }));
    this.cargarEstado();
    // El semáforo se refresca solo, sin molestar: es una lectura barata del ETL.
    this.subs.push(interval(60_000).subscribe(() => { if (!document.hidden) this.cargarEstado(false); }));
  }

  ngOnDestroy(): void { this.subs.forEach((s) => s.unsubscribe()); this.sEstado?.unsubscribe(); }

  // --- Pestañas ---
  irA(p: string, actualizarUrl = true): void {
    if (!PESTANAS.includes(p as Pestana)) return;
    this.actual = p as Pestana;
    this.visitadas.add(this.actual);
    if (actualizarUrl) this.router.navigate([], { queryParams: { tab: this.actual === 'resumen' ? null : this.actual, alerta: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }
  get usaRango(): boolean { return (this.pestanas.find((x) => x.valor === this.actual) || this.pestanas[0]).usaRango; }
  teclas(ev: KeyboardEvent): void {
    const i = PESTANAS.indexOf(this.actual);
    if (ev.key === 'ArrowRight') { this.irA(PESTANAS[(i + 1) % PESTANAS.length]); ev.preventDefault(); }
    if (ev.key === 'ArrowLeft') { this.irA(PESTANAS[(i + PESTANAS.length - 1) % PESTANAS.length]); ev.preventDefault(); }
  }

  // --- Estado (franja Ahora) ---
  cargarEstado(mostrar = true): void {
    this.sEstado?.unsubscribe();
    if (mostrar) this.estadoCargando = true;
    this.sEstado = this.tablero.estado().subscribe({
      next: (r) => {
        if (r.disponible) { this.estado = r; this.estadoNoDisponible = null; } else { this.estado = null; this.estadoNoDisponible = r.mensaje; }
        this.estadoError = null; this.estadoCargando = false;
        this.actualizado = new Date();
      },
      error: (e) => { this.estadoError = e?.error?.error || 'No se pudo leer el estado del ETL.'; this.estadoCargando = false; }
    });
  }

  get etiquetaSemaforo(): string {
    switch (this.estado?.semaforo) {
      case 'ok': return 'Todo al día';
      case 'aviso': return 'Hay avisos';
      case 'critico': return 'Hay problemas';
      default: return '—';
    }
  }
  get minutosDatosHoy(): number | null {
    const a = this.estado?.hoy?.actualizado;
    if (!a) return null;
    return Math.max(0, Math.round((Date.now() - new Date(a.replace(' ', 'T')).getTime()) / 60000));
  }
  get tendenciaHoy(): { texto: string; clase: string } | null {
    const h = this.estado?.hoy;
    if (!h || h.tasaExito === null || h.tasaSemanaAnterior === null) return null;
    const d = Number((h.tasaExito - h.tasaSemanaAnterior).toFixed(2));
    if (Math.abs(d) < 0.05) return { texto: 'igual que la última semana', clase: 'neutro' };
    return { texto: `${d > 0 ? '+' : ''}${d.toLocaleString('es-CO')} pts vs. 7 d`, clase: d > 0 ? 'ok' : 'mal' };
  }
  verAlertas(): void { const id = this.estado?.alertas.recientes[0]?.Id ?? null; this.alertaId = id; this.irA('errores'); }

  // --- Rango ---
  cambiarRango(dias: number): void {
    const yaEraPreset = this.modoRango === 'preset';
    this.modoRango = 'preset'; this.mostrandoSelectorFechas = false; this.errorRangoPersonalizado = null;
    if (yaEraPreset && dias === this.diasSeleccionados) return;
    this.diasSeleccionados = dias;
    this.rango = { dias };
  }
  abrirSelectorFechas(): void {
    if (!this.fechaInicioInput || !this.fechaFinInput) {
      const hoy = new Date();
      this.fechaFinInput = this.aInput(hoy);
      this.fechaInicioInput = this.aInput(new Date(hoy.getTime() - 6 * 86400000));
    }
    this.errorRangoPersonalizado = null; this.mostrandoSelectorFechas = true;
  }
  cancelarSelectorFechas(): void { this.mostrandoSelectorFechas = false; this.errorRangoPersonalizado = null; }
  aplicarRangoPersonalizado(): void {
    this.errorRangoPersonalizado = null;
    if (!this.fechaInicioInput || !this.fechaFinInput) { this.errorRangoPersonalizado = 'Selecciona la fecha inicial y la fecha final.'; return; }
    if (this.fechaInicioInput > this.fechaFinInput) { this.errorRangoPersonalizado = 'La fecha inicial debe ser anterior o igual a la fecha final.'; return; }
    const dias = Math.round((new Date(`${this.fechaFinInput}T00:00:00`).getTime() - new Date(`${this.fechaInicioInput}T00:00:00`).getTime()) / 86400000) + 1;
    if (dias > this.rangoDiasMaximo) { this.errorRangoPersonalizado = `El rango no puede superar ${this.rangoDiasMaximo} días.`; return; }
    this.modoRango = 'personalizado';
    this.mostrandoSelectorFechas = false;
    this.rango = { dias, fechaInicio: this.fechaInicioInput, fechaFin: this.fechaFinInput };
  }
  private aInput(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  actualizarAhora(): void { this.refresco++; this.cargarEstado(); }
  alCargarResumen(f: Date): void { this.actualizado = f; }
}
