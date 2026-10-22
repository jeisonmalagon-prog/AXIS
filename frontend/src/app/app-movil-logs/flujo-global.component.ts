import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import { InicioLineaComponent, SerieLinea } from '../features/inicio/inicio-linea.component';
import {
  AristaMapa,
  MapaGlobalResponse,
  ModeloMapa,
  NodoGlobalApi,
  NodoMapa,
  VarianteGlobal,
  construirModeloMapa,
  formatearDuracion,
  nivelFallo
} from './flujo-layout';

// ============================================================================
// Mapa global de App Móvil: cómo se mueven TODOS los clientes entre servicios
// (GET /app-movil/flujo/global). No es un conteo exacto del día: el backend lee
// una MUESTRA acotada de la ventana elegida para no cargar la base de logs, y
// la pantalla lo dice siempre. Cuatro vistas: mapa por etapas, rutas más
// comunes, tabla de servicios y actividad en el tiempo.
// ============================================================================

type VistaGlobal = 'mapa' | 'rutas' | 'servicios' | 'actividad';
type ClaveOrden = 'servicio' | 'total' | 'clientes' | 'tasaFallo' | 'duracionMedianaMs' | 'duracionP90Ms' | 'repeticiones' | 'entradas' | 'salidas' | 'posProm';

interface Conexion {
  metodo: string;
  servicio: string;
  n: number;
  porcentaje: number;
  esperaPromMs: number;
  retorno: boolean;
}

@Component({
  selector: 'app-flujo-global',
  standalone: true,
  imports: [CommonModule, FormsModule, InicioLineaComponent],
  templateUrl: './flujo-global.component.html',
  styleUrl: './flujo-global.component.scss'
})
export class FlujoGlobalComponent implements OnInit, OnDestroy {
  @ViewChild('lienzo') lienzo?: ElementRef<HTMLDivElement>;

  readonly ventanas = [5, 15, 30, 60];
  ventanaMin = 15;
  modoHistorico = false;
  fechaHistorica = '';
  horaHistorica = 9;
  readonly horas = Array.from({ length: 24 }, (_, i) => i);
  fechaMaxima = '';

  readonly vistas: { valor: VistaGlobal; etiqueta: string }[] = [
    { valor: 'mapa', etiqueta: 'Mapa de servicios' },
    { valor: 'rutas', etiqueta: 'Rutas más comunes' },
    { valor: 'servicios', etiqueta: 'Servicios' },
    { valor: 'actividad', etiqueta: 'Actividad' }
  ];
  vista: VistaGlobal = 'mapa';

  cargando = false;
  error: string | null = null;
  respuesta: MapaGlobalResponse | null = null;
  modelo: ModeloMapa | null = null;

  /** Detalle: mostrar solo transiciones con al menos este porcentaje del camino más usado. */
  detallePorcentaje = 4;
  nodoActivo: NodoMapa | null = null;
  aristasResaltadas = new Set<string>();
  siguientes: Conexion[] = [];
  anteriores: Conexion[] = [];

  zoom = 1;
  anchoLienzo = 0;
  altoLienzo = 0;

  // Servicios (tabla)
  filtroServicio = '';
  orden: ClaveOrden = 'total';
  ordenAsc = false;

  // Actividad
  verTabla = false;
  seriesLlamadas: SerieLinea[] = [];
  seriesClientes: SerieLinea[] = [];
  seriesErrores: SerieLinea[] = [];

  readonly formatearDuracion = formatearDuracion;
  readonly fmtEntero = (v: number) => Math.round(v).toLocaleString('es-CO');

  private apiUrl = `${environment.apiUrl}/app-movil`;
  private suscripcion?: Subscription;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    const hoy = new Date();
    this.fechaMaxima = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
    this.fechaHistorica = this.fechaMaxima;
    this.horaHistorica = Math.max(0, hoy.getHours() - 1);
    this.consultar(false);
  }

  ngOnDestroy(): void {
    this.suscripcion?.unsubscribe();
  }

  elegirVentana(v: number): void {
    this.ventanaMin = v;
    this.consultar(false);
  }

  cambiarModo(historico: boolean): void {
    this.modoHistorico = historico;
    this.consultar(false);
  }

  cambiarVista(v: VistaGlobal): void {
    this.vista = v;
    if (v === 'mapa') setTimeout(() => this.ajustarInicial());
  }

  consultar(refrescar: boolean): void {
    let params = new HttpParams().set('ventana', String(this.ventanaMin));
    if (this.modoHistorico) {
      if (!this.fechaHistorica) {
        this.error = 'Elige la fecha que quieres revisar.';
        return;
      }
      params = params.set('fecha', this.fechaHistorica).set('hora', String(this.horaHistorica));
    }
    if (refrescar) params = params.set('refrescar', '1');

    this.suscripcion?.unsubscribe();
    this.cargando = true;
    this.error = null;
    this.suscripcion = this.http.get<MapaGlobalResponse>(`${this.apiUrl}/flujo/global`, { params }).subscribe({
      next: (resp) => {
        this.cargando = false;
        // Diferido un tick: evita ExpressionChanged al reemplazar el lienzo.
        setTimeout(() => {
          this.respuesta = resp;
          this.nodoActivo = null;
          this.aristasResaltadas = new Set<string>();
          this.siguientes = [];
          this.anteriores = [];
          this.armarSeries();
          this.reconstruir();
        });
      },
      error: (err: HttpErrorResponse) => {
        this.cargando = false;
        this.error = err.error?.error || 'No se pudo armar el mapa. Intenta de nuevo.';
      }
    });
  }

  cambiarDetalle(): void {
    this.nodoActivo = null;
    this.aristasResaltadas = new Set<string>();
    this.reconstruir();
  }

  private reconstruir(): void {
    if (!this.respuesta || !this.respuesta.nodos.length) {
      this.modelo = null;
      return;
    }
    const maxN = Math.max(1, ...this.respuesta.aristas.map((a) => a.n));
    const umbral = Math.max(1, Math.ceil(maxN * (this.detallePorcentaje / 100)));
    this.modelo = construirModeloMapa(this.respuesta, umbral);
    setTimeout(() => this.ajustarInicial());
  }

  private armarSeries(): void {
    const act = this.respuesta?.actividad.puntos ?? [];
    const serie = (nombre: string, color: string, clave: 'llamadas' | 'clientes' | 'errores'): SerieLinea[] => [{
      nombre, color, puntos: act.map((p) => ({ t: new Date(p.t).getTime(), v: p[clave] }))
    }];
    this.seriesLlamadas = serie('Llamadas', 'var(--ax-brand-primary)', 'llamadas');
    this.seriesClientes = serie('Clientes activos', '#0ea5e9', 'clientes');
    this.seriesErrores = serie('Llamadas con error', '#ef4444', 'errores');
  }

  // --- Zoom ---
  acercar(): void { this.aplicarZoom(this.zoom * 1.2); }
  alejar(): void { this.aplicarZoom(this.zoom / 1.2); }
  restablecer(): void { this.aplicarZoom(1); }

  private ajustarInicial(): void {
    if (!this.modelo) return;
    const contenedor = this.lienzo?.nativeElement;
    const disponible = contenedor ? contenedor.clientWidth - 12 : this.modelo.ancho;
    this.aplicarZoom(Math.max(0.8, Math.min(1, disponible / this.modelo.ancho)));
  }

  ajustar(): void {
    if (!this.modelo) return;
    const contenedor = this.lienzo?.nativeElement;
    const disponible = contenedor ? contenedor.clientWidth - 12 : this.modelo.ancho;
    this.aplicarZoom(Math.min(1, disponible / this.modelo.ancho));
  }

  private aplicarZoom(valor: number): void {
    if (!this.modelo) return;
    this.zoom = Math.min(2, Math.max(0.3, valor));
    this.anchoLienzo = Math.round(this.modelo.ancho * this.zoom);
    this.altoLienzo = Math.round(this.modelo.alto * this.zoom);
  }

  // --- Interacción con el mapa ---
  elegirNodo(nodo: NodoMapa): void {
    if (this.nodoActivo === nodo) {
      this.limpiarSeleccion();
      return;
    }
    this.nodoActivo = nodo;
    const resaltadas = new Set<string>();
    if (this.modelo) {
      for (const a of this.modelo.aristas) {
        if (a.de === nodo.id || a.a === nodo.id) resaltadas.add(a.id);
      }
    }
    this.aristasResaltadas = resaltadas;

    // Las listas salen de TODAS las transiciones del backend, incluidas las
    // que vuelven a una etapa anterior (el mapa no las dibuja).
    const resp = this.respuesta;
    if (!resp) return;
    const nombre = (id: string) => resp.nodos.find((n) => n.metodo === id)?.servicio ?? id;
    const posDe = (id: string) => resp.nodos.find((n) => n.metodo === id)?.posProm ?? 0;
    const sal = resp.aristas.filter((a) => a.de === nodo.id);
    const ent = resp.aristas.filter((a) => a.a === nodo.id);
    const totalSal = sal.reduce((s, a) => s + a.n, 0) || 1;
    const totalEnt = ent.reduce((s, a) => s + a.n, 0) || 1;
    this.siguientes = sal.sort((a, b) => b.n - a.n).slice(0, 8).map((a) => ({
      metodo: a.a, servicio: nombre(a.a), n: a.n, porcentaje: Math.round((a.n / totalSal) * 100), esperaPromMs: a.esperaPromMs, retorno: posDe(a.a) < posDe(a.de)
    }));
    this.anteriores = ent.sort((a, b) => b.n - a.n).slice(0, 8).map((a) => ({
      metodo: a.de, servicio: nombre(a.de), n: a.n, porcentaje: Math.round((a.n / totalEnt) * 100), esperaPromMs: a.esperaPromMs, retorno: posDe(a.de) > posDe(a.a)
    }));
  }

  limpiarSeleccion(): void {
    this.nodoActivo = null;
    this.aristasResaltadas = new Set<string>();
    this.siguientes = [];
    this.anteriores = [];
  }

  esAtenuado(nodo: NodoMapa): boolean {
    if (!this.nodoActivo || this.nodoActivo === nodo) return false;
    for (const id of this.aristasResaltadas) {
      const [de, a] = id.split('>');
      if ((de === this.nodoActivo.id && a === nodo.id) || (a === this.nodoActivo.id && de === nodo.id)) return false;
    }
    return true;
  }

  /** Desde la tabla: abre el servicio elegido en el mapa. */
  verEnMapa(n: NodoGlobalApi): void {
    this.vista = 'mapa';
    setTimeout(() => {
      this.ajustarInicial();
      const nodo = this.modelo?.nodos.find((x) => x.id === n.metodo);
      if (nodo) this.elegirNodo(nodo);
    });
  }

  // --- Tabla de servicios ---
  get serviciosFiltrados(): NodoGlobalApi[] {
    const q = this.filtroServicio.trim().toLowerCase();
    const lista = (this.respuesta?.nodos ?? []).filter((n) => !q || `${n.servicio} ${n.metodo}`.toLowerCase().includes(q));
    const dir = this.ordenAsc ? 1 : -1;
    const clave = this.orden;
    return lista.slice().sort((a, b) => {
      if (clave === 'servicio') return dir * a.servicio.localeCompare(b.servicio, 'es');
      const va = (a[clave] as number | null) ?? -1;
      const vb = (b[clave] as number | null) ?? -1;
      return dir * (va - vb);
    });
  }

  ordenarPor(clave: ClaveOrden): void {
    if (this.orden === clave) this.ordenAsc = !this.ordenAsc;
    else { this.orden = clave; this.ordenAsc = clave === 'servicio'; }
  }

  indicadorOrden(clave: ClaveOrden): string {
    return this.orden === clave ? (this.ordenAsc ? '▲' : '▼') : '';
  }

  get maxTotalServicios(): number {
    return Math.max(1, ...(this.respuesta?.nodos ?? []).map((n) => n.total));
  }

  // --- Textos ---
  porcentajeFallo(n: { tasaFallo: number }): string {
    return this.pct(n.tasaFallo);
  }

  pct(v: number): string {
    const p = v * 100;
    return p === 0 ? '0 %' : (p < 1 ? '< 1 %' : `${p.toFixed(p < 10 ? 1 : 0).replace('.', ',')} %`);
  }

  nivelDe(n: { tasaFallo: number }): 'ok' | 'aviso' | 'critico' { return nivelFallo(n.tasaFallo); }

  horaCorta(iso: string | null): string {
    return iso ? new Date(iso).toLocaleTimeString('es-CO', { hour12: false }) : '—';
  }

  minutosMuestra(): number {
    const m = this.respuesta?.muestra;
    if (!m || !m.desde || !m.hasta) return 0;
    return Math.max(1, Math.round((new Date(m.hasta).getTime() - new Date(m.desde).getTime()) / 60000));
  }

  compacto(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`;
    if (n >= 10_000) return `${Math.round(n / 1000)} mil`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',')} mil`;
    return String(n);
  }

  porcentajeVariante(v: VarianteGlobal, parte: number): number {
    return v.n ? (parte / v.n) * 100 : 0;
  }

  porcentajeDominante(v: VarianteGlobal): number {
    return v.n ? Math.max(v.cierreNormal, v.cierreError, v.sinCierre) / v.n : 0;
  }

  textoCierreDominante(v: VarianteGlobal): string {
    const max = Math.max(v.cierreNormal, v.cierreError, v.sinCierre);
    if (max === v.cierreNormal) return 'cierran sesión';
    if (max === v.cierreError) return 'terminan con error';
    return 'no cierran sesión';
  }

  etiquetaColumna(i: number): string { return this.modelo?.columnas[i]?.etiqueta ?? ''; }

  horaPunto(iso: string): string {
    return new Date(iso).toLocaleTimeString('es-CO', { hour12: false });
  }

  trackNodo(_: number, n: NodoMapa): string { return n.id; }
  trackArista(_: number, a: AristaMapa): string { return a.id; }
  trackVariante(i: number): number { return i; }
}
