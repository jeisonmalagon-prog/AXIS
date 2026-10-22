import { Component, ElementRef, HostListener, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  BarraTiempo,
  LlamadaFlujo,
  ModeloLinea,
  ModeloRecorrido,
  NodoRecorrido,
  PasoLlamada,
  RecorridoFlujo,
  RecorridoResponse,
  construirLineaTiempo,
  construirModeloRecorrido,
  formatearDuracion
} from './flujo-layout';
import { LogDetalleComponent } from './log-detalle.component';

// ============================================================================
// Recorrido de un cliente (GET /app-movil/flujo/cliente). Se arma con los logs
// de la app: cada llamada es un servicio que la app consumió. Cuatro vistas del
// mismo recorrido: línea de tiempo en cascada, diagrama de flujo, tabla de
// detalle y resumen por servicio. Es el flujo de SERVICIOS, no de pantallas.
// ============================================================================

type PeriodoCliente = 'hoy' | 'ayer' | '3d' | '7d' | 'rango';
type VistaCliente = 'tiempo' | 'flujo' | 'detalle' | 'servicios';

interface Hallazgo { nivel: 'error' | 'warn' | 'ok' | 'info'; texto: string; llamadas?: number[]; }
interface TipLinea { barra: BarraTiempo; x: number; y: number; }

@Component({
  selector: 'app-flujo-cliente',
  standalone: true,
  imports: [CommonModule, FormsModule, LogDetalleComponent],
  templateUrl: './flujo-cliente.component.html',
  styleUrl: './flujo-cliente.component.scss'
})
export class FlujoClienteComponent implements OnChanges, OnDestroy {
  /** Documento con el que se abre la pestaña (ej. desde la Consulta de Logs). */
  @Input() documentoInicial = '';

  @ViewChild('lienzo') lienzo?: ElementRef<HTMLDivElement>;
  @ViewChild('cascada') cascada?: ElementRef<HTMLDivElement>;

  documento = '';
  periodo: PeriodoCliente = 'hoy';
  fechaDesde = '';
  fechaHasta = '';
  fechaMaxima = '';
  brechaMin = 30;
  readonly periodos: { valor: PeriodoCliente; etiqueta: string }[] = [
    { valor: 'hoy', etiqueta: 'Hoy' },
    { valor: 'ayer', etiqueta: 'Ayer' },
    { valor: '3d', etiqueta: '3 días' },
    { valor: '7d', etiqueta: '7 días' },
    { valor: 'rango', etiqueta: 'Rango' }
  ];
  readonly brechas = [15, 30, 60, 120];
  readonly vistas: { valor: VistaCliente; etiqueta: string }[] = [
    { valor: 'tiempo', etiqueta: 'Línea de tiempo' },
    { valor: 'flujo', etiqueta: 'Diagrama de flujo' },
    { valor: 'detalle', etiqueta: 'Detalle de llamadas' },
    { valor: 'servicios', etiqueta: 'Por servicio' }
  ];

  cargando = false;
  error: string | null = null;
  buscoAlMenosUnaVez = false;
  respuesta: RecorridoResponse | null = null;

  vista: VistaCliente = 'tiempo';
  seleccionado: RecorridoFlujo | null = null;
  hallazgos: Hallazgo[] = [];

  // Línea de tiempo
  linea: ModeloLinea | null = null;
  comprimirPausas = true;
  zoomLinea = 1;
  llamadaActiva: LlamadaFlujo | null = null;
  tip: TipLinea | null = null;

  // Diagrama de flujo
  modelo: ModeloRecorrido | null = null;
  nodoActivo: NodoRecorrido | null = null;
  aristasResaltadas = new Set<string>();
  agruparReintentos = true;
  mostrarTiempos = true;
  zoom = 1;
  anchoSvg = 0;
  altoSvg = 0;

  // Pantalla completa (para ver el recorrido completo en una pantalla grande)
  pantallaCompleta = false;
  /** En pantalla completa el resumen (KPI, narrativa, hallazgos) se puede ocultar para ganar espacio. */
  resumenOculto = false;

  // Detalle traducido de una fila del log (panel lateral)
  detalleCodigo: number | null = null;
  detalleFecha = '';

  // Detalle
  filtroTexto = '';
  soloErrores = false;
  /** Llamadas del "Detalle" con sus pasos internos desplegados (por número). */
  abiertas = new Set<number>();
  copiado: 'si' | 'no' | null = null;
  private temporizadorCopia?: ReturnType<typeof setTimeout>;

  readonly formatearDuracion = formatearDuracion;

  private apiUrl = `${environment.apiUrl}/app-movil`;
  private suscripcion?: Subscription;
  private temporizadorResize?: ReturnType<typeof setTimeout>;

  constructor(private http: HttpClient) {
    const hoy = new Date();
    this.fechaMaxima = this.ymd(hoy);
    this.fechaDesde = this.fechaMaxima;
    this.fechaHasta = this.fechaMaxima;
  }

  ngOnChanges(cambios: SimpleChanges): void {
    if (cambios['documentoInicial'] && this.documentoInicial && this.documentoInicial !== this.documento) {
      this.documento = this.documentoInicial;
      this.consultar();
    }
  }

  ngOnDestroy(): void {
    this.suscripcion?.unsubscribe();
    if (this.temporizadorResize) clearTimeout(this.temporizadorResize);
    if (this.temporizadorCopia) clearTimeout(this.temporizadorCopia);
    this.bloquearScroll(false);
  }

  /** Esc: si hay un detalle abierto lo cierra el propio detalle; si no, sale de pantalla completa. */
  @HostListener('document:keydown.escape')
  alEscape(): void {
    if (this.detalleCodigo !== null) return;
    if (this.pantallaCompleta) this.alternarPantallaCompleta();
  }

  @HostListener('window:resize')
  alCambiarVentana(): void {
    if (this.temporizadorResize) clearTimeout(this.temporizadorResize);
    this.temporizadorResize = setTimeout(() => this.armarLinea(), 200);
  }

  private ymd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  elegirPeriodo(p: PeriodoCliente): void { this.periodo = p; }

  // ------------------------------------------------------- pantalla completa
  alternarPantallaCompleta(): void {
    this.pantallaCompleta = !this.pantallaCompleta;
    this.resumenOculto = this.pantallaCompleta;
    this.bloquearScroll(this.pantallaCompleta);
    setTimeout(() => { this.armarLinea(); this.ajustar(); });
  }

  alternarResumen(): void {
    this.resumenOculto = !this.resumenOculto;
    setTimeout(() => { this.armarLinea(); if (this.vista === 'flujo') this.ajustar(); });
  }

  private bloquearScroll(bloquear: boolean): void {
    try { document.body.style.overflow = bloquear ? 'hidden' : ''; } catch { /* sin documento: no importa */ }
  }

  // ----------------------------------------------------- detalle de una fila
  verDetallePaso(p: PasoLlamada): void {
    if (!p.codigo || !p.fecha) return;
    this.detalleCodigo = p.codigo;
    this.detalleFecha = p.fecha;
  }

  cerrarDetalle(): void { this.detalleCodigo = null; }

  // ---------------------------------------------------------------- consulta
  consultar(): void {
    const documento = this.documento.trim();
    if (documento.length < 4) {
      this.error = 'Escribe el documento completo del cliente (mínimo 4 caracteres).';
      return;
    }

    let params = new HttpParams().set('documento', documento).set('brechaMin', String(this.brechaMin));
    if (this.periodo === 'hoy') params = params.set('dias', '1');
    // "Ayer" se pide como desfase respecto al día de la BASE DE DATOS, no al reloj de este equipo.
    else if (this.periodo === 'ayer') params = params.set('dias', '1').set('desfase', '1');
    else if (this.periodo === '3d') params = params.set('dias', '3');
    else if (this.periodo === '7d') params = params.set('dias', '7');
    else {
      if (!this.fechaDesde || !this.fechaHasta || this.fechaDesde > this.fechaHasta) {
        this.error = 'Elige un rango de fechas válido (la fecha inicial no puede ser posterior a la final).';
        return;
      }
      params = params.set('fechaInicio', this.fechaDesde).set('fechaFin', this.fechaHasta);
    }

    this.suscripcion?.unsubscribe();
    this.cargando = true;
    this.error = null;
    this.buscoAlMenosUnaVez = true;
    this.suscripcion = this.http.get<RecorridoResponse>(`${this.apiUrl}/flujo/cliente`, { params }).subscribe({
      next: (resp) => {
        this.respuesta = resp;
        this.cargando = false;
        // Diferir la selección un tick: evita ExpressionChanged al cambiar el
        // contenido del lienzo en la misma pasada de detección de cambios.
        setTimeout(() => this.seleccionarRecorrido(resp.recorridos[0] ?? null));
      },
      error: (err: HttpErrorResponse) => {
        this.cargando = false;
        this.respuesta = null;
        this.seleccionado = null;
        this.modelo = null;
        this.linea = null;
        this.error = err.error?.error || 'No se pudo armar el recorrido. Intenta de nuevo.';
      }
    });
  }

  /** Desde el diagnóstico: "este cliente sí tiene actividad el día X". */
  verDia(fecha: string): void {
    this.periodo = 'rango';
    this.fechaDesde = fecha;
    this.fechaHasta = fecha;
    this.consultar();
  }

  seleccionarRecorrido(r: RecorridoFlujo | null): void {
    this.seleccionado = r;
    this.nodoActivo = null;
    this.llamadaActiva = null;
    this.tip = null;
    this.aristasResaltadas = new Set<string>();
    this.hallazgos = r ? (r.hallazgos?.length ? r.hallazgos : this.calcularHallazgos(r)) : [];
    this.abiertas = new Set<number>();
    this.linea = null;
    setTimeout(() => this.armarLinea());
    this.reconstruir();
  }

  cambiarVista(v: VistaCliente): void {
    this.vista = v;
    setTimeout(() => { this.armarLinea(); this.ajustarInicial(); });
  }

  // ----------------------------------------------------------- línea de tiempo
  armarLinea(): void {
    if (!this.seleccionado || !this.seleccionado.llamadas.length) { this.linea = null; return; }
    const contenedor = this.cascada?.nativeElement;
    const disponible = Math.max(520, (contenedor ? contenedor.clientWidth : 980) - 400);
    this.linea = construirLineaTiempo(this.seleccionado, disponible * this.zoomLinea, this.comprimirPausas);
  }

  cambiarZoomLinea(factor: number): void {
    this.zoomLinea = Math.min(8, Math.max(0.5, this.zoomLinea * factor));
    this.armarLinea();
  }

  restablecerZoomLinea(): void { this.zoomLinea = 1; this.armarLinea(); }

  elegirLlamada(l: LlamadaFlujo): void {
    this.llamadaActiva = this.llamadaActiva === l ? null : l;
  }

  verTip(evento: MouseEvent, barra: BarraTiempo): void {
    this.tip = { barra, x: Math.min(evento.clientX + 14, window.innerWidth - 360), y: evento.clientY + 16 };
  }

  ocultarTip(): void { this.tip = null; }

  // ------------------------------------------------------------ diagrama flujo
  cambiarAgrupacion(): void {
    this.nodoActivo = null;
    this.aristasResaltadas = new Set<string>();
    this.reconstruir();
  }

  private reconstruir(): void {
    if (!this.seleccionado || !this.seleccionado.llamadas.length) {
      this.modelo = null;
      return;
    }
    this.modelo = construirModeloRecorrido(this.seleccionado, this.agruparReintentos);
    setTimeout(() => this.ajustarInicial());
  }

  acercar(): void { this.aplicarZoom(this.zoom * 1.2); }
  alejar(): void { this.aplicarZoom(this.zoom / 1.2); }
  restablecer(): void { this.aplicarZoom(1); }

  private ajustarInicial(): void { this.ajustar(); }

  /**
   * Ajusta el zoom al espacio disponible. En pantalla completa se ajusta a
   * ancho y alto (para ver todo el recorrido de una vez) y puede ampliar hasta
   * el doble; en la vista normal se ajusta al ancho.
   */
  ajustar(): void {
    if (!this.modelo) return;
    const contenedor = this.lienzo?.nativeElement;
    const ancho = contenedor ? contenedor.clientWidth - 12 : this.modelo.ancho;
    if (this.pantallaCompleta) {
      const alto = contenedor ? contenedor.clientHeight - 12 : this.modelo.alto;
      this.aplicarZoom(Math.max(0.4, Math.min(2, ancho / this.modelo.ancho, alto / this.modelo.alto)));
    } else {
      this.aplicarZoom(Math.max(0.7, Math.min(1.25, ancho / this.modelo.ancho)));
    }
  }

  private aplicarZoom(valor: number): void {
    if (!this.modelo) return;
    this.zoom = Math.min(3, Math.max(0.2, valor));
    this.anchoSvg = Math.round(this.modelo.ancho * this.zoom);
    this.altoSvg = Math.round(this.modelo.alto * this.zoom);
  }

  elegirNodo(nodo: NodoRecorrido): void {
    if (this.nodoActivo === nodo) {
      this.nodoActivo = null;
      this.aristasResaltadas = new Set<string>();
      return;
    }
    this.nodoActivo = nodo;
    const resaltadas = new Set<string>();
    if (this.modelo) {
      for (const a of this.modelo.aristas) {
        if (a.desde === nodo.id || a.hacia === nodo.id) resaltadas.add(a.id);
      }
    }
    this.aristasResaltadas = resaltadas;
  }

  // ------------------------------------------------------------------ detalle
  get llamadasFiltradas(): LlamadaFlujo[] {
    if (!this.seleccionado) return [];
    const q = this.filtroTexto.trim().toLowerCase();
    return this.seleccionado.llamadas.filter((l) => {
      if (this.soloErrores && l.estado !== 'error' && l.estado !== 'advertencia' && l.estado !== 'sin_respuesta' && !l.lentitud) return false;
      if (!q) return true;
      return `${l.servicio} ${l.metodo} ${l.clase ?? ''} ${l.mensaje ?? ''} ${l.resultado ?? ''}`.toLowerCase().includes(q);
    });
  }

  exportarCsv(): void {
    if (!this.seleccionado) return;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const filas = [['n', 'inicio', 'fin', 'duracion_ms', 'servicio', 'metodo', 'clase', 'funcionalidad', 'estado', 'lentitud', 'resultado', 'detalle', 'pasos']];
    for (const l of this.seleccionado.llamadas) {
      filas.push([String(l.n), l.inicio ?? '', l.fin ?? '', String(l.duracionMs ?? ''), l.servicio, l.metodo, l.clase ?? '', String(l.funcionalidad ?? ''), l.estado, l.lentitud === 'muy_lenta' ? 'muy lenta' : (l.lentitud === 'lenta' ? 'lenta' : ''), l.resultado ?? '', l.mensaje ?? '',
        (l.pasos ?? []).map((p) => `${p.hora} ${p.titulo}${p.texto ? ': ' + p.texto : ''}`).join(' | ')]);
    }
    const csv = '﻿' + filas.map((f) => f.map(esc).join(';')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recorrido_${this.respuesta?.documento ?? 'cliente'}_${this.seleccionado.inicio.slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ------------------------------------------------------- diagnóstico y copia
  /** Copia al portapapeles un resumen en texto plano del recorrido (para pegarlo en un ticket o chat). */
  async copiarResumen(): Promise<void> {
    const texto = this.seleccionado?.resumenTexto;
    if (!texto) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(texto);
      ok = true;
    } catch {
      const area = document.createElement('textarea');
      area.value = texto;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      document.body.removeChild(area);
    }
    this.copiado = ok ? 'si' : 'no';
    if (this.temporizadorCopia) clearTimeout(this.temporizadorCopia);
    this.temporizadorCopia = setTimeout(() => { this.copiado = null; }, 2500);
  }

  /** Desde un hallazgo: abre en la línea de tiempo la llamada indicada. */
  verLlamadaNumero(n: number): void {
    const l = this.seleccionado?.llamadas.find((x) => x.n === n);
    if (!l) return;
    this.vista = 'tiempo';
    this.llamadaActiva = l;
    setTimeout(() => this.armarLinea());
  }

  alternarPasos(n: number): void {
    const copia = new Set(this.abiertas);
    if (copia.has(n)) copia.delete(n); else copia.add(n);
    this.abiertas = copia;
  }

  etiquetaPaso(tipo: string): string {
    if (tipo === 'inicio') return 'Inicio';
    if (tipo === 'api') return 'API';
    if (tipo === 'soap') return 'ACE';
    if (tipo === 'error') return 'Error';
    return 'Paso';
  }

  iconoPaso(nivel: string): string {
    return nivel === 'ok' ? '✓' : nivel === 'error' ? '✕' : nivel === 'aviso' ? '!' : 'i';
  }

  /** Estado general del recorrido (nunca "sin errores" si hubo lentitud o avisos). */
  claseSalud(r: RecorridoFlujo): string {
    const nivel = r.salud?.nivel ?? (r.errores > 0 ? 'error' : ((r.advertencias ?? 0) > 0 || (r.lentas ?? 0) > 0 ? 'aviso' : 'ok'));
    return nivel === 'error' ? 'pill pill--error' : nivel === 'aviso' ? 'pill pill--warn' : 'pill pill--ok';
  }

  textoSalud(r: RecorridoFlujo): string {
    if (r.salud?.texto) return `${r.salud.nivel === 'ok' ? '✓' : r.salud.nivel === 'error' ? '✕' : '!'} ${r.salud.texto}`;
    if (r.errores > 0) return `✕ ${r.errores} error(es)`;
    if ((r.lentas ?? 0) > 0) return `! ${r.lentas} lenta(s)`;
    if ((r.advertencias ?? 0) > 0) return `! ${r.advertencias} aviso(s)`;
    return '✓ Sin errores ni lentitud';
  }

  /** Texto corto de lentitud de una llamada ("Muy lenta · 1 min"), o cadena vacía. */
  textoLentitud(l: LlamadaFlujo): string {
    if (!l.lentitud) return '';
    return `${l.lentitud === 'muy_lenta' ? 'Muy lenta' : 'Lenta'} · ${formatearDuracion(l.duracionMs)}`;
  }

  /** Clase de color de la pastilla de estado. */
  clasePill(estado: string): string {
    if (estado === 'exito') return 'pill pill--ok';
    if (estado === 'error') return 'pill pill--error';
    if (estado === 'advertencia' || estado === 'sin_respuesta' || estado === 'lenta') return 'pill pill--warn';
    if (estado === 'en_curso') return 'pill pill--info';
    return 'pill';
  }

  // ---------------------------------------------------------------- hallazgos
  private calcularHallazgos(r: RecorridoFlujo): Hallazgo[] {
    const h: Hallazgo[] = [];
    const ll = r.llamadas;

    const fallidas = ll.filter((l) => l.estado === 'error');
    if (fallidas.length) {
      const nombres = [...new Set(fallidas.map((l) => l.servicio))];
      const lista = nombres.slice(0, 3).join(', ') + (nombres.length > 3 ? ` y ${nombres.length - 3} más` : '');
      h.push({ nivel: 'error', texto: `${fallidas.length} llamada(s) fallaron: ${lista}.` });
    }
    const sinResp = ll.filter((l) => l.estado === 'sin_respuesta');
    if (sinResp.length) h.push({ nivel: 'warn', texto: `${sinResp.length} llamada(s) quedaron sin respuesta registrada (la app se cerró o perdió conexión).` });

    // Reintentos: la misma llamada repetida de forma consecutiva
    let reintentos = 0;
    let servicioReint = '';
    for (let i = 1; i < ll.length; i++) {
      if (ll[i].metodo === ll[i - 1].metodo) { reintentos += 1; servicioReint = ll[i].servicio; }
    }
    if (reintentos) h.push({ nivel: 'warn', texto: `${reintentos} reintento(s) seguidos${reintentos === 1 ? ` de ${servicioReint}` : ''}: el cliente repitió la misma operación.` });

    const lenta = r.masLento;
    if (lenta && (lenta.duracionMs >= 3000 || (r.duracionMs > 0 && lenta.duracionMs / r.duracionMs >= 0.4 && lenta.duracionMs >= 1500))) {
      h.push({ nivel: 'warn', texto: `La llamada más lenta fue ${lenta.servicio}: ${formatearDuracion(lenta.duracionMs)}.` });
    }

    // Pausa más larga entre llamadas
    let pausaMax = 0;
    let tras = '';
    for (let i = 1; i < ll.length; i++) {
      const prev = ll[i - 1];
      const finPrev = prev.offsetMs + (prev.duracionMs ?? 0);
      const espera = ll[i].offsetMs - finPrev;
      if (espera > pausaMax) { pausaMax = espera; tras = prev.servicio; }
    }
    if (pausaMax >= 60000) h.push({ nivel: 'info', texto: `Pausa más larga: ${formatearDuracion(pausaMax)} después de ${tras}.` });

    if (r.cierre === 'sin_cierre') h.push({ nivel: 'info', texto: 'No hay cierre de sesión: el cliente abandonó o la app se cerró.' });
    else if (r.cierre === 'termino_con_error') h.push({ nivel: 'error', texto: 'El recorrido terminó con una llamada fallida.' });
    else h.push({ nivel: 'ok', texto: 'El cliente cerró sesión con normalidad.' });

    const lentasLl = ll.filter((l) => l.lentitud);
    if (lentasLl.length) h.push({ nivel: 'warn', texto: `${lentasLl.length} llamada(s) fueron lentas (lo habitual es menos de 2 s).`, llamadas: lentasLl.map((l) => l.n) });
    if (!fallidas.length && !sinResp.length && !lentasLl.length) h.unshift({ nivel: 'ok', texto: 'Todas las llamadas respondieron correctamente.' });
    return h;
  }

  // ------------------------------------------------------------------ textos
  etiquetaCierre(c: RecorridoFlujo['cierre']): string {
    if (c === 'cierre_normal') return 'Cerró sesión';
    if (c === 'termino_con_error') return 'Terminó con error';
    return 'Sin cierre de sesión';
  }

  etiquetaEstado(l: LlamadaFlujo): string {
    if (l.estado === 'exito') {
      const base = l.resultado ? `Exitosa · ${l.resultado.toLowerCase()}` : 'Exitosa';
      return l.lentitud ? `${base} · pero lenta` : base;
    }
    if (l.estado === 'error') return l.lentitud ? 'Con error (y lenta)' : 'Con error';
    if (l.estado === 'advertencia') return l.resultado ? l.resultado : 'Con aviso';
    if (l.estado === 'sin_detalle') return 'Solo inicio (el log no registra el resultado)';
    if (l.estado === 'sin_respuesta') return 'Sin respuesta registrada';
    return 'En curso';
  }

  iconoEstado(e: string): string {
    if (e === 'exito') return '✓';
    if (e === 'error') return '✕';
    if (e === 'advertencia') return '!';
    if (e === 'sin_detalle') return '–';
    if (e === 'sin_respuesta') return '?';
    return '…';
  }

  horaCorta(iso: string | null): string {
    return iso ? new Date(iso).toLocaleTimeString('es-CO', { hour12: false }) : '—';
  }

  porcentaje(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    const p = v * 100;
    return `${p >= 99.95 ? '100' : p.toFixed(p < 10 ? 1 : 0).replace('.', ',')} %`;
  }

  /** Servicios que concentran la mayor parte del tiempo del recorrido (para la vista por servicio). */
  get maxLlamadasServicio(): number {
    return Math.max(1, ...(this.respuesta?.resumen.servicios ?? []).map((s) => s.llamadas));
  }

  trackRecorrido(_: number, r: RecorridoFlujo): number { return r.id; }
  trackNodo(_: number, n: NodoRecorrido): string { return n.id; }
  trackArista(_: number, a: { id: string }): string { return a.id; }
  trackBarra(_: number, b: BarraTiempo): number { return b.llamada.n; }
}
