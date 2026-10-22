import {
  ChangeDetectorRef, Component, ElementRef, Input, NgZone, OnChanges, OnDestroy, SimpleChanges, ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';

interface PuntoHistorial {
  t: string;
  entradaBps: number | null;
  salidaBps: number | null;
  entradaPicoBps?: number | null;
  salidaPicoBps?: number | null;
  conexiones: number | null;
  nuevasPorSeg: number | null;
}

interface ResumenHistorial {
  muestras: number;
  entradaPromBps: number | null;
  salidaPromBps: number | null;
  entradaPicoBps: number;
  entradaPicoEn: string | null;
  salidaPicoBps: number;
  salidaPicoEn: string | null;
  conexionesProm: number | null;
  conexionesPico: number;
  conexionesPicoEn: string | null;
  conexionesNuevas: number;
  datosEntradaBytes: number;
  datosSalidaBytes: number;
  minutosConTrafico: number;
  ultimoTraficoEn: string | null;
}

interface NodoHistorial {
  miembro: string;
  direccion: string;
  puerto: number | null;
  resumen: ResumenHistorial;
  puntos: PuntoHistorial[];
}

interface RespuestaHistorial {
  pool: string;
  desde: string;
  hasta: string;
  horas: number;
  bucketSegundos: number;
  intervaloMuestreoSegundos: number;
  fuente: 'bd' | 'memoria';
  nodos: NodoHistorial[];
  total: PuntoHistorial[];
  aviso?: string | null;
}

type MetricaId = 'entradaBps' | 'salidaBps' | 'conexiones' | 'nuevasPorSeg' | 'transacciones' | 'tps';

interface Metrica {
  id: MetricaId;
  nombre: string;
  titulo: string;
  tipo: 'bps' | 'num' | 'dec';
  fuente?: 'avr'; // viene de AVR del F5 (incluye días anteriores al despliegue)
}

interface PuntoAvr { t: string; transacciones: number | null; tps: number | null }
interface RespuestaAvr {
  desde: string;
  hasta: string;
  horas: number;
  bucketSegundos: number;
  formatoRange: string;
  nodos: { miembro: string; puntos: PuntoAvr[] }[];
  total: PuntoAvr[];
  aviso?: string | null;
}

// Lo que la gráfica dibuja: una rejilla de tiempos y los valores por nodo.
interface Vista { t: string[]; nodos: Map<string, (number | null)[]>; total: (number | null)[] }

interface SerieDibujada {
  clave: string;       // nombre del nodo o '__total__'
  nombre: string;
  slot: number;        // 0..5 para nodos; -1 para el total
  valores: (number | null)[];
  segmentos: string[]; // path "M x y L x y ..." por tramo continuo
  aislados: { x: number; y: number }[];
  etiquetaY: number | null; // y del último valor, para la etiqueta directa
}

const MAX_NODOS_GRAFICA = 6;
const MARGEN = { izq: 58, der: 12, arriba: 10, abajo: 26 };
const ALTO = 250;

@Component({
  selector: 'app-f5-historial-nodos',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './f5-historial-nodos.component.html',
  styleUrls: ['./f5-historial-nodos.component.scss'],
})
export class F5HistorialNodosComponent implements OnChanges, OnDestroy {
  @Input() dispositivoId: string | null = null;
  @Input() pool: string | null = null;

  readonly rangos = [
    { horas: 1, texto: '1 h' },
    { horas: 6, texto: '6 h' },
    { horas: 24, texto: '24 h' },
    { horas: 168, texto: '7 días' },
    { horas: 720, texto: '30 días' },
  ];
  readonly metricas: Metrica[] = [
    { id: 'entradaBps', nombre: 'Entrada ↓', titulo: 'Velocidad de entrada', tipo: 'bps' },
    { id: 'salidaBps', nombre: 'Salida ↑', titulo: 'Velocidad de salida', tipo: 'bps' },
    { id: 'conexiones', nombre: 'Conexiones', titulo: 'Conexiones abiertas', tipo: 'num' },
    { id: 'nuevasPorSeg', nombre: 'Nuevas / s', titulo: 'Conexiones nuevas por segundo', tipo: 'dec' },
    { id: 'transacciones', nombre: 'Transacciones (F5)', titulo: 'Transacciones HTTP por tramo — AVR del F5', tipo: 'num', fuente: 'avr' },
    { id: 'tps', nombre: 'Trans./s (F5)', titulo: 'Transacciones HTTP por segundo — AVR del F5', tipo: 'dec', fuente: 'avr' },
  ];
  alto = ALTO; // se ajusta al ancho disponible (gráfica más alta en pantallas grandes)

  horas = 24;
  metricaId: MetricaId = 'entradaBps';
  verTabla = false;
  mostrarTotal = false;

  cargando = false;
  error: string | null = null;
  datos: RespuestaHistorial | null = null;
  actualizadoEn: Date | null = null;
  avisoSeleccion: string | null = null;

  // Histórico traído de AVR (Statistics > Analytics del F5)
  avrDatos: RespuestaAvr | null = null;
  avrHistCargando = false;
  avrHistError: string | null = null;
  private avrHistHoras = 0;
  private subAvr?: Subscription;
  vista: Vista = { t: [], nodos: new Map(), total: [] };

  // Diagnóstico de AVR (histórico guardado en el propio F5)
  avrAbierto = false;
  avrCargando = false;
  avrError: string | null = null;
  avrTexto = '';
  avrCopiado = false;

  seleccion: string[] = [];
  private slots = new Map<string, number>();

  ancho = 600;
  series: SerieDibujada[] = [];
  ejeY: { y: number; texto: string }[] = [];
  ejeX: { x: number; texto: string; ancla: string }[] = [];
  hayDatosGrafica = false;
  etiquetasDirectas = false;

  // Hover
  indiceHover: number | null = null;
  xHover = 0;
  tooltipIzquierda = false;

  private max = 1;
  private sub?: Subscription;
  private observador?: ResizeObserver;
  private lienzoEl?: ElementRef<HTMLElement>;

  @ViewChild('lienzo') set lienzo(el: ElementRef<HTMLElement> | undefined) {
    if (el === this.lienzoEl) return;
    this.observador?.disconnect();
    this.lienzoEl = el;
    if (!el || typeof ResizeObserver === 'undefined') return;
    this.observador = new ResizeObserver((entradas) => {
      const w = Math.floor(entradas[0].contentRect.width);
      if (w > 0 && Math.abs(w - this.ancho) > 1) {
        this.zone.run(() => { this.ancho = w; this.recalcular(); this.cdr.markForCheck(); });
      }
    });
    this.observador.observe(el.nativeElement);
  }

  constructor(private http: HttpClient, private zone: NgZone, private cdr: ChangeDetectorRef) {}

  ngOnChanges(cambios: SimpleChanges): void {
    if (cambios['pool'] || cambios['dispositivoId']) {
      this.datos = null;
      this.avrDatos = null;
      this.avrHistHoras = 0;
      this.seleccion = [];
      this.slots.clear();
      this.cargar();
    }
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.subAvr?.unsubscribe();
    this.observador?.disconnect();
  }

  get metrica(): Metrica { return this.metricas.find((m) => m.id === this.metricaId)!; }
  get nodos(): NodoHistorial[] { return this.datos?.nodos || []; }
  get esAvr(): boolean { return !!this.metrica.fuente; }
  get bucketTexto(): string { return this.duracion((this.esAvr ? this.avrDatos?.bucketSegundos : this.datos?.bucketSegundos) || 0); }
  get seleccionSinAvr(): string[] {
    const a = this.avrDatos;
    return this.esAvr && a ? this.seleccion.filter((n) => !a.nodos.some((x) => x.miembro === n)) : [];
  }
  get totalTransacciones(): number { return this.avrDatos ? this.avrDatos.total.reduce((a, p) => a + (p.transacciones || 0), 0) : 0; }
  transDe(nombre: string): number | null {
    const n = this.avrDatos?.nodos.find((x) => x.miembro === nombre);
    return n ? n.puntos.reduce((a, p) => a + (p.transacciones || 0), 0) : null;
  }
  get intervaloTexto(): string { return this.duracion(this.datos?.intervaloMuestreoSegundos || 0); }
  // Primera lectura que hay en el rango (para avisar cuando el histórico es más corto que el rango pedido).
  get datosDesde(): string | null {
    let min: string | null = null;
    for (const n of this.nodos) for (const p of n.puntos) {
      if (p.entradaBps !== null || p.conexiones !== null) { if (min === null || p.t < min) min = p.t; break; }
    }
    return min;
  }
  get historiaCorta(): boolean {
    const d = this.datosDesde;
    return !!d && !!this.datos && (new Date(d).getTime() - new Date(this.datos.desde).getTime()) > (this.datos.bucketSegundos * 1000 * 2);
  }
  get totalMuestras(): number { return this.nodos.reduce((a, n) => a + n.resumen.muestras, 0); }

  // ---------- Carga ----------
  cambiarRango(horas: number): void {
    if (horas === this.horas) return;
    this.horas = horas;
    this.cargar();
    if (this.esAvr) this.cargarAvrHistorial();
  }

  cargar(): void {
    if (!this.dispositivoId || !this.pool) return;
    this.sub?.unsubscribe();
    this.cargando = true;
    this.error = null;
    const url = `${environment.apiUrl}/f5/${this.dispositivoId}/pool/historial`;
    this.sub = this.http.get<RespuestaHistorial>(url, { params: { pool: this.pool, horas: String(this.horas) } }).subscribe({
      next: (d) => {
        this.datos = d;
        this.actualizadoEn = new Date();
        this.cargando = false;
        this.ajustarSeleccion();
        if (this.esAvr) this.cargarAvrHistorial(); else this.recalcular();
      },
      error: (err) => {
        this.cargando = false;
        this.error = err?.error?.error || 'No se pudo cargar el histórico de tráfico.';
      },
    });
  }

  cargarAvrHistorial(): void {
    if (!this.dispositivoId || !this.pool) return;
    if (this.avrDatos && this.avrHistHoras === this.horas) { this.recalcular(); return; }
    this.subAvr?.unsubscribe();
    this.avrHistCargando = true;
    this.avrHistError = null;
    const horas = this.horas;
    const url = `${environment.apiUrl}/f5/${this.dispositivoId}/pool/historial-avr`;
    this.subAvr = this.http.get<RespuestaAvr>(url, { params: { pool: this.pool, horas: String(horas) } }).subscribe({
      next: (d) => {
        this.avrDatos = d;
        this.avrHistHoras = horas;
        this.avrHistCargando = false;
        this.recalcular();
      },
      error: (err) => {
        this.avrHistCargando = false;
        this.avrDatos = null;
        this.avrHistError = err?.error?.error || 'No se pudo leer el histórico de AVR del F5.';
        this.recalcular();
      },
    });
  }

  private ajustarSeleccion(): void {
    const nombres = new Set(this.nodos.map((n) => n.miembro));
    this.seleccion = this.seleccion.filter((n) => nombres.has(n));
    for (const k of [...this.slots.keys()]) if (!nombres.has(k)) this.slots.delete(k);
    if (!this.seleccion.length) this.seleccionarTop();
    else this.seleccion.forEach((n) => this.asignarSlot(n));
  }

  private asignarSlot(nombre: string): void {
    if (this.slots.has(nombre)) return;
    const usados = new Set(this.slots.values());
    for (let i = 0; i < MAX_NODOS_GRAFICA; i++) if (!usados.has(i)) { this.slots.set(nombre, i); return; }
  }

  seleccionarTop(): void {
    const peso = (n: NodoHistorial) => (n.resumen.entradaPromBps || 0) + (n.resumen.salidaPromBps || 0);
    const orden = [...this.nodos].sort((a, b) => peso(b) - peso(a) || a.miembro.localeCompare(b.miembro, 'es', { numeric: true }));
    this.slots.clear();
    this.seleccion = orden.slice(0, 4).map((n) => n.miembro);
    this.seleccion.forEach((n) => this.asignarSlot(n));
    this.avisoSeleccion = null;
    this.recalcular();
  }

  ninguno(): void {
    this.seleccion = [];
    this.slots.clear();
    this.avisoSeleccion = null;
    this.recalcular();
  }

  estaSeleccionado(nombre: string): boolean { return this.seleccion.includes(nombre); }
  slotDe(nombre: string): number { return this.slots.get(nombre) ?? -1; }

  alternarNodo(nombre: string): void {
    if (this.estaSeleccionado(nombre)) {
      this.seleccion = this.seleccion.filter((n) => n !== nombre);
      this.slots.delete(nombre);
      this.avisoSeleccion = null;
    } else {
      if (this.seleccion.length >= MAX_NODOS_GRAFICA) {
        this.avisoSeleccion = `La gráfica muestra hasta ${MAX_NODOS_GRAFICA} nodos a la vez; quita uno para agregar otro.`;
        return;
      }
      this.seleccion = [...this.seleccion, nombre];
      this.asignarSlot(nombre);
      this.avisoSeleccion = null;
    }
    this.recalcular();
  }

  cambiarMetrica(id: MetricaId): void {
    this.metricaId = id;
    this.indiceHover = null;
    if (this.esAvr) this.cargarAvrHistorial(); else this.recalcular();
  }
  alternarTotal(): void { this.mostrarTotal = !this.mostrarTotal; this.recalcular(); }
  alternarTabla(): void { this.verTabla = !this.verTabla; }

  // ---------- Geometría de la gráfica ----------
  private get anchoPlot(): number { return Math.max(40, this.ancho - MARGEN.izq - this.margenDer); }
  private get margenDer(): number { return this.etiquetasDirectas ? 132 : MARGEN.der; }
  private get altoPlot(): number { return this.alto - MARGEN.arriba - MARGEN.abajo; }
  private xDe(i: number, n: number): number {
    return MARGEN.izq + (n <= 1 ? this.anchoPlot / 2 : (i * this.anchoPlot) / (n - 1));
  }
  private yDe(v: number): number {
    return MARGEN.arriba + this.altoPlot - (v / this.max) * this.altoPlot;
  }

  // Arma lo que se dibuja según la métrica: lecturas propias o AVR del F5.
  private construirVista(): Vista {
    const m = this.metricaId;
    if (this.esAvr) {
      const a = this.avrDatos;
      const campo = m === 'tps' ? 'tps' : 'transacciones';
      if (!a) return { t: [], nodos: new Map(), total: [] };
      return {
        t: a.total.map((p) => p.t),
        nodos: new Map(a.nodos.map((n) => [n.miembro, n.puntos.map((p) => p[campo])] as [string, (number | null)[]])),
        total: a.total.map((p) => p[campo]),
      };
    }
    const d = this.datos;
    if (!d) return { t: [], nodos: new Map(), total: [] };
    const campo = m as 'entradaBps' | 'salidaBps' | 'conexiones' | 'nuevasPorSeg';
    const base = d.nodos[0]?.puntos || d.total;
    return {
      t: base.map((p) => p.t),
      nodos: new Map(d.nodos.map((n) => [n.miembro, n.puntos.map((p) => p[campo])] as [string, (number | null)[]])),
      total: d.total.map((p) => p[campo]),
    };
  }

  recalcular(): void {
    this.alto = this.ancho >= 1000 ? 380 : this.ancho >= 700 ? 320 : ALTO;
    this.vista = this.construirVista();
    const v = this.vista;
    if (!this.datos) { this.series = []; this.ejeX = []; this.ejeY = []; this.hayDatosGrafica = false; return; }
    const origen: { clave: string; nombre: string; slot: number; valores: (number | null)[] }[] = [];
    for (const nombre of this.seleccion) {
      const valores = v.nodos.get(nombre);
      if (valores) origen.push({ clave: nombre, nombre, slot: this.slotDe(nombre), valores });
    }
    if (this.mostrarTotal) origen.push({ clave: '__total__', nombre: 'Total del pool', slot: -1, valores: v.total });

    const n = v.t.length;
    let maxV = 0;
    let alguno = false;
    for (const s of origen) for (const x of s.valores) { if (x !== null) { alguno = true; if (x > maxV) maxV = x; } }
    this.hayDatosGrafica = alguno;
    const ticks = this.ticksBonitos(maxV);
    this.max = ticks[ticks.length - 1] || 1;

    this.etiquetasDirectas = this.ancho >= 620 && origen.filter((s) => s.slot >= 0).length <= 4 && origen.length > 0;
    this.series = origen.map((s) => this.dibujarSerie(s, n));
    if (this.etiquetasDirectas) this.separarEtiquetas();
    this.ejeY = ticks.map((x) => ({ y: this.yDe(x), texto: this.formatearValor(x, this.metrica.tipo, true) }));
    this.ejeX = this.ticksTiempo(n);
  }

  private dibujarSerie(s: { clave: string; nombre: string; slot: number; valores: (number | null)[] }, n: number): SerieDibujada {
    const segmentos: string[] = [];
    const aislados: { x: number; y: number }[] = [];
    let tramo: { x: number; y: number }[] = [];
    const cerrar = () => {
      if (tramo.length === 1) aislados.push(tramo[0]);
      else if (tramo.length > 1) segmentos.push(tramo.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '));
      tramo = [];
    };
    let ultimo: number | null = null;
    s.valores.forEach((v, i) => {
      if (v === null) { cerrar(); return; }
      tramo.push({ x: this.xDe(i, n), y: this.yDe(v) });
      ultimo = this.yDe(v);
    });
    cerrar();
    return { clave: s.clave, nombre: s.nombre, slot: s.slot, valores: s.valores, segmentos, aislados, etiquetaY: ultimo };
  }

  // Evita que las etiquetas directas se encimen (mínimo 13 px entre ellas).
  private separarEtiquetas(): void {
    const con = this.series.filter((s) => s.etiquetaY !== null).sort((a, b) => a.etiquetaY! - b.etiquetaY!);
    for (let i = 1; i < con.length; i++) {
      if (con[i].etiquetaY! - con[i - 1].etiquetaY! < 13) con[i].etiquetaY = con[i - 1].etiquetaY! + 13;
    }
  }

  private ticksBonitos(maxV: number): number[] {
    if (!(maxV > 0)) return [0, 1];
    const bruto = maxV / 4;
    const mag = 10 ** Math.floor(Math.log10(bruto));
    const frac = bruto / mag;
    const paso = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10) * mag;
    const res: number[] = [];
    for (let v = 0; v < maxV + paso * 0.999; v += paso) res.push(Math.round(v * 1e6) / 1e6);
    return res;
  }

  private ticksTiempo(n: number): { x: number; texto: string; ancla: string }[] {
    const tiempos = this.vista.t;
    if (!tiempos.length) return [];
    const cuantos = Math.max(2, Math.min(7, Math.floor(this.anchoPlot / 90)));
    const idx = new Set<number>();
    for (let k = 0; k < cuantos; k++) idx.add(Math.round((k * (n - 1)) / (cuantos - 1)));
    const largo = this.horas > 24;
    return [...idx].sort((a, b) => a - b).map((i, k, arr) => ({
      x: this.xDe(i, n),
      texto: this.formatearFechaCorta(tiempos[i], largo),
      ancla: k === 0 ? 'start' : k === arr.length - 1 ? 'end' : 'middle',
    }));
  }

  // ---------- Hover ----------
  moverPuntero(ev: PointerEvent | MouseEvent): void {
    const n = this.vista.t.length;
    if (!n || !this.lienzoEl) return;
    const caja = this.lienzoEl.nativeElement.getBoundingClientRect();
    const x = ev.clientX - caja.left;
    const frac = (x - MARGEN.izq) / this.anchoPlot;
    const i = Math.min(n - 1, Math.max(0, Math.round(frac * (n - 1))));
    this.indiceHover = i;
    this.xHover = this.xDe(i, n);
    this.tooltipIzquierda = this.xHover > this.ancho / 2;
  }

  salirPuntero(): void { this.indiceHover = null; }

  get tiempoHover(): string {
    const t = this.vista.t[this.indiceHover ?? -1];
    return t ? this.formatearFechaLarga(t) : '';
  }

  get filasHover(): { nombre: string; slot: number; texto: string }[] {
    if (this.indiceHover === null) return [];
    const i = this.indiceHover;
    return this.series.map((s) => {
      const v = s.valores[i];
      return { nombre: s.nombre, slot: s.slot, texto: v === null ? 'sin lectura' : this.formatearValor(v, this.metrica.tipo) };
    });
  }

  yHoverDe(s: SerieDibujada): number | null {
    if (this.indiceHover === null) return null;
    const v = s.valores[this.indiceHover];
    return v === null ? null : this.yDe(v);
  }

  // ---------- Tabla ----------
  get filasTabla(): { t: string; valores: (number | null)[] }[] {
    const filas = this.vista.t.map((t, i) => ({ t, valores: this.series.map((s) => s.valores[i]) }));
    return filas.reverse();
  }

  // ---------- Diagnóstico AVR ----------
  probarAvr(): void {
    if (!this.dispositivoId) return;
    this.avrAbierto = true;
    this.avrCargando = true;
    this.avrError = null;
    this.avrTexto = '';
    this.avrCopiado = false;
    this.http.get<{ dispositivo: string; generadoEn: string; resumen?: string; resultados: { ruta: string; ok: boolean; respuesta: string }[] }>(
      `${environment.apiUrl}/f5/${this.dispositivoId}/avr/diagnostico`
    ).subscribe({
      next: (d) => {
        this.avrCargando = false;
        this.avrTexto = (d.resumen ? d.resumen + '\n\n' : '') + d.resultados.map((r) => `${r.ok ? 'OK  ' : 'FALLO'} ${r.ruta}\n${r.respuesta}`).join('\n\n');
      },
      error: (err) => {
        this.avrCargando = false;
        this.avrError = err?.error?.error || 'No se pudo ejecutar el diagnóstico.';
      },
    });
  }

  async copiarAvr(): Promise<void> {
    try { await navigator.clipboard.writeText(this.avrTexto); this.avrCopiado = true; } catch { this.avrCopiado = false; }
  }

  // ---------- CSV ----------
  exportarCsv(): void {
    if (this.esAvr) { this.exportarCsvAvr(); return; }
    const d = this.datos;
    if (!d) return;
    const celda = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lineas = [['fecha_utc', 'nodo', 'entrada_bps', 'salida_bps', 'entrada_pico_bps', 'salida_pico_bps', 'conexiones_abiertas', 'conexiones_nuevas_por_seg'].join(',')];
    for (const nodo of d.nodos) {
      for (const p of nodo.puntos) {
        if (p.entradaBps === null && p.conexiones === null) continue;
        lineas.push([p.t, nodo.miembro, p.entradaBps, p.salidaBps, p.entradaPicoBps, p.salidaPicoBps, p.conexiones, p.nuevasPorSeg].map(celda).join(','));
      }
    }
    const blob = new Blob(['﻿' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const nombrePool = (this.pool || 'pool').split('/').pop();
    a.href = url;
    a.download = `historial_trafico_${nombrePool}_${this.horas}h.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private exportarCsvAvr(): void {
    const a = this.avrDatos;
    if (!a) return;
    const lineas = ['fecha_utc,nodo,transacciones,transacciones_por_seg'];
    for (const n of a.nodos) for (const p of n.puntos) {
      if (p.transacciones === null) continue;
      lineas.push([p.t, `"${n.miembro}"`, p.transacciones, p.tps].join(','));
    }
    const blob = new Blob(['\ufeff' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = `historial_avr_${(this.pool || 'pool').split('/').pop()}_${this.horas}h.csv`;
    document.body.appendChild(el);
    el.click();
    el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Formato ----------
  formatearValor(v: number, tipo: 'bps' | 'num' | 'dec', eje = false): string {
    if (tipo === 'bps') return this.formatearBps(v);
    if (tipo === 'dec') return v >= 100 || eje ? this.formatearNumero(v, eje && v < 10 ? 1 : 0) : this.formatearNumero(v, 2);
    return this.formatearNumero(v, 0);
  }

  formatearBps(bps: number | null | undefined): string {
    if (bps === null || bps === undefined) return '—';
    const unidades = ['bps', 'Kbps', 'Mbps', 'Gbps'];
    let n = bps;
    let i = 0;
    while (n >= 1000 && i < unidades.length - 1) { n /= 1000; i++; }
    const dec = n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2;
    return `${n.toLocaleString('es-CO', { maximumFractionDigits: dec })} ${unidades[i]}`;
  }

  formatearBytes(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined) return '—';
    const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < unidades.length - 1) { n /= 1024; i++; }
    return `${n.toLocaleString('es-CO', { maximumFractionDigits: n >= 100 || i === 0 ? 0 : 1 })} ${unidades[i]}`;
  }

  formatearNumero(n: number | null | undefined, dec = 0): string {
    if (n === null || n === undefined) return '—';
    return n.toLocaleString('es-CO', { maximumFractionDigits: dec });
  }

  private dos(n: number): string { return String(n).padStart(2, '0'); }

  formatearFechaCorta(iso: string, conDia: boolean): string {
    const f = new Date(iso);
    const hora = `${this.dos(f.getHours())}:${this.dos(f.getMinutes())}`;
    return conDia ? `${this.dos(f.getDate())}/${this.dos(f.getMonth() + 1)} ${hora}` : hora;
  }

  formatearFechaLarga(iso: string | null): string {
    if (!iso) return '—';
    const f = new Date(iso);
    return `${this.dos(f.getDate())}/${this.dos(f.getMonth() + 1)}/${f.getFullYear()} ${this.dos(f.getHours())}:${this.dos(f.getMinutes())}`;
  }

  duracion(seg: number): string {
    if (!seg) return '';
    if (seg < 3600) return `${Math.round(seg / 60)} min`;
    const h = seg / 3600;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
  }

  textoMinutos(min: number): string {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  estadoNodo(n: NodoHistorial): { texto: string; clase: string } {
    if (!n.resumen.muestras) return { texto: 'Sin lecturas', clase: 'est-sin' };
    if (!n.resumen.minutosConTrafico) return { texto: 'Sin tráfico', clase: 'est-inactivo' };
    return { texto: 'Con tráfico', clase: 'est-activo' };
  }

  etiquetaCorta(nombre: string): string {
    return nombre.length > 18 ? nombre.slice(0, 17) + '…' : nombre;
  }

  trackNodo = (_: number, n: NodoHistorial) => n.miembro;
  trackSerie = (_: number, s: SerieDibujada) => s.clave;
  trackIdx = (i: number) => i;
}
