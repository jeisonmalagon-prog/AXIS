import { Component, HostListener, OnInit } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import * as XLSX from 'xlsx';
import { AuthService } from '../../services/auth.service';
import {
  BiometriaConsumoService, CasoDetalle, ClienteIntentos, ConfigConsumo, DetalleClienteDia, FilaDiaria, FilaHora, FormConfigConsumo, ProveedorConsumo,
  PruebaConexion, ResultadoFrecuente, ResumenProveedor, TableroConsumo,
} from '../../core/services/biometria-consumo.service';

type Preset = 'hoy' | 'ayer' | '7' | '15' | '30' | 'mes';
type Metrica = 'total' | 'reintentos' | 'fallidos';
type FiltroOrigen = '' | ProveedorConsumo;
type Vista = 'resumen' | 'clientes' | 'reglas' | 'resultados';

const PROVEEDORES: ProveedorConsumo[] = ['ASISA', 'OLIMPIA'];
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const POR_PAGINA = 15;
const atras = (n: number): Date => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const aFecha = (d: Date): string => formatDate(d, 'yyyy-MM-dd', 'en-US');

// Geometría de los gráficos (viewBox fijo; el SVG se ajusta al ancho de la tarjeta).
export const ANCHO = 760;
export const ALTO = 250;
const MARGEN = { izq: 46, der: 18, arr: 14, aba: 30 };
const PLANO_W = ANCHO - MARGEN.izq - MARGEN.der;
const PLANO_H = ALTO - MARGEN.arr - MARGEN.aba;

interface PuntoLinea { x: number; y: number; v: number; }
interface SerieLinea { proveedor: ProveedorConsumo; puntos: PuntoLinea[]; ruta: string; cupoY: number | null; cupo: number | null; }
interface BandaNoHabil { x: number; ancho: number; texto: string; }
interface BarraHist { fecha: string; x: number; ancho: number; ya: number; ha: number; yo: number; ho: number; habil: boolean; asisa: number; olimpia: number; }
interface BarraHora { hora: number; x: number; ancho: number; xa: number; ya: number; ha: number; xo: number; yo: number; ho: number; va: number; vo: number; }

/** Número «bonito» para el tope del eje (1, 2, 5 × 10ⁿ). */
function topeBonito(max: number): number {
  if (max <= 4) return 4;
  const e = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
}

/** Consumo y reusos de Biometría: cuántas consultas por día a ASISA y OLIMPIA, reintentos y clientes que consultan de más. */
@Component({
  selector: 'app-biometria-consumo',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './biometria-consumo.component.html',
  styleUrl: './biometria-consumo.component.scss',
})
export class BiometriaConsumoComponent implements OnInit {
  readonly proveedores = PROVEEDORES;
  /** «Recordar cada…» de la alerta por correo (minutos). 0 = solo avisar cuando aparezca algo nuevo. */
  readonly recordatorios: { min: number; texto: string }[] = [
    { min: 0, texto: 'No recordar (solo avisar cuando haya algo nuevo)' },
    { min: 15, texto: 'Cada 15 minutos' }, { min: 30, texto: 'Cada 30 minutos' }, { min: 60, texto: 'Cada hora' },
    { min: 120, texto: 'Cada 2 horas' }, { min: 240, texto: 'Cada 4 horas' }, { min: 480, texto: 'Cada 8 horas' },
    { min: 720, texto: 'Cada 12 horas' }, { min: 1440, texto: 'Una vez al día' },
  ];
  readonly ancho = ANCHO;
  readonly alto = ALTO;
  readonly margen = MARGEN;
  readonly planoW = PLANO_W;
  readonly planoH = PLANO_H;

  puedeEditar = false;
  esAdmin = false;
  config: ConfigConsumo | null = null;
  cargandoConfig = true;
  errorConfig = '';

  desde = '';
  hasta = '';
  presetActivo: Preset | '' = '';
  consultando = false;
  error = '';
  sinConfiguracion = false;
  datos: TableroConsumo | null = null;
  ultimoRango = '';

  /** Pestaña visible del tablero. */
  vista: Vista = 'resumen';
  readonly vistas: { id: Vista; texto: string }[] = [
    { id: 'resumen', texto: 'Resumen y tendencia' }, { id: 'clientes', texto: 'Clientes y reusos' },
    { id: 'reglas', texto: 'Reglas y cálculo del reuso' }, { id: 'resultados', texto: 'Resultados y proveedores' },
  ];

  // Detalle de un cliente en un día
  clienteAbierto: ClienteIntentos | null = null;
  detalle: DetalleClienteDia | null = null;
  cargandoDetalle = false;
  errorDetalle = '';
  barrasHist: BarraHist[] = [];
  histMax = 0;
  readonly histAlto = 150;
  soloProveedorFoco = false;

  // Gráficos
  bandasNoHabil: BandaNoHabil[] = [];
  metrica: Metrica = 'total';
  verTabla = false;
  series: SerieLinea[] = [];
  ticksY: { y: number; v: number }[] = [];
  ticksX: { x: number; texto: string }[] = [];
  xs: number[] = [];
  hoverIdx: number | null = null;
  barrasHora: BarraHora[] = [];
  ticksYHora: { y: number; v: number }[] = [];
  hoverHora: number | null = null;

  // Tablas
  soloExceso = false;
  paginaClientes = 1;
  filtroOrigen: FiltroOrigen = '';

  // Configuración (modal del ADMIN_POD)
  mostrarConfig = false;
  form: FormConfigConsumo | null = null;
  guardando = false;
  errorForm = '';
  probando = false;
  prueba: PruebaConexion | null = null;
  probandoAlerta = false;
  mensajeAlerta: { ok: boolean; texto: string } | null = null;

  constructor(private api: BiometriaConsumoService, private auth: AuthService) {}

  ngOnInit(): void {
    // Todo el módulo es de lectura: consulta cualquiera que lo tenga habilitado (también con rol Consulta).
    this.puedeEditar = this.auth.rolEnModulo('BIOMETRIA') !== null;
    this.esAdmin = this.auth.obtenerDatosUsuario()?.rol === 'ADMIN_POD';
    this.elegirPreset('7');
    this.cargarConfig(true);
  }

  // ------------------------------------------------------------------ configuración
  cargarConfig(primera = false): void {
    this.cargandoConfig = primera;
    this.api.config().subscribe({
      next: (c) => {
        this.config = c; this.cargandoConfig = false; this.errorConfig = '';
        if (primera && c.configurada && this.puedeEditar) this.consultar();
      },
      error: (e: HttpErrorResponse) => { this.cargandoConfig = false; this.errorConfig = e.error?.error || 'No se pudo leer la configuración.'; },
    });
  }

  abrirConfig(): void {
    const c = this.config;
    if (!c || !this.esAdmin) return;
    const cupo = (p: ProveedorConsumo) => ({ dia: c.cupos[p].dia, mes: c.cupos[p].mes, valor: c.cupos[p].valor });
    this.form = {
      servidor: c.servidor ?? 'AWLPROD001', puerto: c.puerto ?? 61733, base: c.base ?? 'ORQBIOMETRIA', usuario: c.usuario ?? '', clave: '',
      cifrado: c.cifrado ?? true, confiarCertificado: c.confiarCertificado ?? true, maxPorCliente: c.maxPorCliente, alerta: c.alerta, alertaCadaMin: c.alertaCadaMin ?? 240,
      cupos: { ASISA: cupo('ASISA'), OLIMPIA: cupo('OLIMPIA') },
    };
    this.errorForm = ''; this.prueba = null; this.mensajeAlerta = null; this.mostrarConfig = true;
  }

  cerrarConfig(): void { if (!this.guardando) this.mostrarConfig = false; }

  probarConexion(): void {
    if (!this.form) return;
    this.probando = true; this.prueba = null;
    this.api.probarConexion(this.form).subscribe({
      next: (r) => { this.prueba = r; this.probando = false; },
      error: (e: HttpErrorResponse) => { this.prueba = { ok: false, error: e.error?.error || 'No se pudo probar la conexión.' }; this.probando = false; },
    });
  }

  guardarConfig(): void {
    if (!this.form) return;
    this.guardando = true; this.errorForm = '';
    this.api.guardarConfig(this.form).subscribe({
      next: (c) => {
        this.config = c; this.guardando = false; this.mostrarConfig = false;
        this.sinConfiguracion = false; this.error = '';
        if (c.configurada && this.puedeEditar) this.consultar(true);
      },
      error: (e: HttpErrorResponse) => { this.guardando = false; this.errorForm = e.error?.error || 'No se pudo guardar la configuración.'; },
    });
  }

  probarAlerta(): void {
    this.probandoAlerta = true; this.mensajeAlerta = null;
    this.api.probarAlerta().subscribe({
      next: (r) => { this.mensajeAlerta = { ok: r.ok, texto: r.mensaje }; this.probandoAlerta = false; },
      error: (e: HttpErrorResponse) => { this.mensajeAlerta = { ok: false, texto: e.error?.error || 'No se pudo enviar la prueba.' }; this.probandoAlerta = false; },
    });
  }

  // ------------------------------------------------------------------ consulta
  elegirPreset(p: Preset): void {
    const hoy = new Date();
    switch (p) {
      case 'hoy': this.desde = aFecha(hoy); this.hasta = aFecha(hoy); break;
      case 'ayer': this.desde = aFecha(atras(1)); this.hasta = aFecha(atras(1)); break;
      case '7': this.desde = aFecha(atras(6)); this.hasta = aFecha(hoy); break;
      case '15': this.desde = aFecha(atras(14)); this.hasta = aFecha(hoy); break;
      case '30': this.desde = aFecha(atras(29)); this.hasta = aFecha(hoy); break;
      case 'mes': this.desde = `${aFecha(hoy).slice(0, 7)}-01`; this.hasta = aFecha(hoy); break;
    }
    this.presetActivo = p;
  }

  cambioManual(): void { this.presetActivo = ''; }

  get rangoValido(): boolean {
    if (!RE_FECHA.test(this.desde) || !RE_FECHA.test(this.hasta) || this.desde > this.hasta) return false;
    return (Date.parse(this.hasta) - Date.parse(this.desde)) / 86400000 < 93;
  }

  consultar(forzar = false): void {
    if (!this.rangoValido || this.consultando) return;
    const rango = `${this.desde}|${this.hasta}`;
    this.consultando = true; this.error = ''; this.sinConfiguracion = false;
    this.api.tablero(this.desde, this.hasta, forzar || rango === this.ultimoRango).subscribe({
      next: (d) => {
        this.datos = d; this.ultimoRango = rango; this.consultando = false;
        this.paginaClientes = 1; this.hoverIdx = null; this.hoverHora = null;
        this.recalcular();
      },
      error: (e: HttpErrorResponse) => {
        this.consultando = false;
        this.error = e.error?.error || 'No se pudo consultar el consumo.';
        this.sinConfiguracion = !!e.error?.sinConfiguracion;
      },
    });
  }

  // ------------------------------------------------------------------ gráficos
  cambiarMetrica(m: Metrica): void { this.metrica = m; this.hoverIdx = null; this.recalcular(); }

  private valorDia(f: FilaDiaria, p: ProveedorConsumo): number { return f[p][this.metrica]; }

  private recalcular(): void {
    const d = this.datos;
    if (!d) return;
    this.calcularTendencia(d);
    this.calcularHoras(d.horas);
  }

  private calcularTendencia(d: TableroConsumo): void {
    const n = d.diaria.length;
    const cupos = this.metrica === 'total' ? PROVEEDORES.map((p) => d.umbrales.cupos[p].dia) : [null, null];
    let max = 0;
    for (const f of d.diaria) for (const p of PROVEEDORES) max = Math.max(max, this.valorDia(f, p));
    for (const c of cupos) if (c !== null && c !== undefined) max = Math.max(max, c);
    const tope = topeBonito(max);
    const x = (i: number): number => (n <= 1 ? MARGEN.izq + PLANO_W / 2 : MARGEN.izq + (i * PLANO_W) / (n - 1));
    const y = (v: number): number => MARGEN.arr + PLANO_H - (v / tope) * PLANO_H;
    this.xs = d.diaria.map((_, i) => x(i));
    const paso = n <= 1 ? PLANO_W : PLANO_W / (n - 1);
    this.bandasNoHabil = d.diaria.map((f, i) => ({ f, i })).filter(({ f }) => !f.habil).map(({ f, i }) => ({
      x: Math.max(MARGEN.izq, x(i) - paso / 2), ancho: Math.min(paso, MARGEN.izq + PLANO_W - Math.max(MARGEN.izq, x(i) - paso / 2)), texto: f.motivoNoHabil || 'No hábil',
    }));
    this.series = PROVEEDORES.map((p, k) => {
      const puntos = d.diaria.map((f, i) => ({ x: x(i), y: y(this.valorDia(f, p)), v: this.valorDia(f, p) }));
      const cupo = cupos[k] ?? null;
      return {
        proveedor: p, puntos, cupo, cupoY: cupo !== null ? y(cupo) : null,
        ruta: puntos.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' '),
      };
    });
    this.ticksY = [0, 1, 2, 3, 4].map((i) => ({ v: Math.round((tope / 4) * i * 10) / 10, y: y((tope / 4) * i) }));
    const salto = Math.max(1, Math.ceil(n / 8));
    const idx = d.diaria.map((_, i) => i).filter((i) => i % salto === 0);
    const ultimo = n - 1;
    if (n > 0 && idx[idx.length - 1] !== ultimo && ultimo - idx[idx.length - 1] >= Math.ceil(salto * 0.6)) idx.push(ultimo);
    this.ticksX = idx.map((i) => ({ x: x(i), texto: this.fechaCorta(d.diaria[i].fecha) }));
  }

  private calcularHoras(horas: FilaHora[]): void {
    let max = 0;
    for (const h of horas) max = Math.max(max, h.ASISA.total, h.OLIMPIA.total);
    const tope = topeBonito(max);
    const grupo = PLANO_W / 24;
    const ancho = Math.max(2, (grupo - 6) / 2);
    const y = (v: number): number => MARGEN.arr + PLANO_H - (v / tope) * PLANO_H;
    this.ticksYHora = [0, 1, 2, 3, 4].map((i) => ({ v: Math.round((tope / 4) * i * 10) / 10, y: y((tope / 4) * i) }));
    this.barrasHora = horas.map((h) => {
      const x0 = MARGEN.izq + h.hora * grupo + 3;
      const ha = (h.ASISA.total / tope) * PLANO_H;
      const ho = (h.OLIMPIA.total / tope) * PLANO_H;
      return {
        hora: h.hora, x: MARGEN.izq + h.hora * grupo, ancho: grupo,
        xa: x0, ya: MARGEN.arr + PLANO_H - ha, ha, xo: x0 + ancho + 1, yo: MARGEN.arr + PLANO_H - ho, ho, va: h.ASISA.total, vo: h.OLIMPIA.total,
      };
    });
  }

  moverSobreTendencia(ev: MouseEvent): void {
    const d = this.datos;
    if (!d || !d.diaria.length) return;
    const caja = (ev.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((ev.clientX - caja.left) / caja.width) * ANCHO;
    let mejor = 0; let dist = Infinity;
    this.xs.forEach((x, i) => { const dd = Math.abs(x - px); if (dd < dist) { dist = dd; mejor = i; } });
    this.hoverIdx = mejor;
  }

  salirTendencia(): void { this.hoverIdx = null; }

  moverSobreHoras(ev: MouseEvent): void {
    const caja = (ev.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((ev.clientX - caja.left) / caja.width) * ANCHO - MARGEN.izq;
    this.hoverHora = px < 0 || px > PLANO_W ? null : Math.min(23, Math.max(0, Math.floor(px / (PLANO_W / 24))));
  }

  salirHoras(): void { this.hoverHora = null; }

  get tooltipTendencia(): { left: number; fila: FilaDiaria } | null {
    if (this.hoverIdx === null || !this.datos) return null;
    const fila = this.datos.diaria[this.hoverIdx];
    return fila ? { left: Math.min(78, Math.max(2, (this.xs[this.hoverIdx] / ANCHO) * 100 - 10)), fila } : null;
  }

  get tooltipHora(): { left: number; fila: FilaHora } | null {
    if (this.hoverHora === null || !this.datos) return null;
    const b = this.barrasHora[this.hoverHora];
    return b ? { left: Math.min(78, Math.max(2, ((b.x + b.ancho / 2) / ANCHO) * 100 - 10)), fila: this.datos.horas[this.hoverHora] } : null;
  }

  get etiquetaMetrica(): string {
    return { total: 'Casos', reintentos: 'En reintento', fallidos: 'Fallidos' }[this.metrica];
  }

  // ------------------------------------------------------------------ helpers de presentación
  fechaCorta(iso: string | null | undefined): string {
    return iso && RE_FECHA.test(iso.slice(0, 10)) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '—';
  }

  fechaLarga(iso: string | null | undefined): string {
    return iso && RE_FECHA.test(iso.slice(0, 10)) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—';
  }

  hora(iso: string | null): string {
    return iso ? formatDate(iso, 'HH:mm', 'en-US', 'UTC') : '—';
  }

  /** Variación porcentual contra el periodo anterior (null si no hay base de comparación). */
  variacion(actual: number, previo: number): number | null {
    return previo > 0 ? Math.round(((actual - previo) / previo) * 1000) / 10 : null;
  }

  claseVariacion(v: number | null): string {
    if (v === null || v === 0) return 'var-igual';
    return v > 0 ? 'var-sube' : 'var-baja';
  }

  textoVariacion(v: number | null): string {
    if (v === null) return 'sin periodo anterior';
    return `${v > 0 ? '▲' : v < 0 ? '▼' : '='} ${Math.abs(v)}% vs periodo anterior`;
  }

  /** Segmentos de la barra de estados de un proveedor (suman 100 %). */
  segmentos(p: ResumenProveedor): { clase: string; etiqueta: string; valor: number; pct: number }[] {
    const otros = Math.max(0, p.total - p.exitosos - p.fallidos - p.reintentos);
    const lista = [
      { clase: 'seg-ok', etiqueta: 'Exitosos', valor: p.exitosos },
      { clase: 'seg-warn', etiqueta: 'Reintentos', valor: p.reintentos },
      { clase: 'seg-mal', etiqueta: 'Fallidos', valor: p.fallidos },
      { clase: 'seg-otro', etiqueta: 'Otros', valor: otros },
    ];
    return lista.map((s) => ({ ...s, pct: p.total > 0 ? (s.valor / p.total) * 100 : 0 }));
  }

  pctCupo(valor: number, cupo: number | null): number { return cupo && cupo > 0 ? Math.min(100, Math.round((valor / cupo) * 100)) : 0; }

  pctReal(valor: number, cupo: number | null): number { return cupo && cupo > 0 ? Math.round((valor / cupo) * 100) : 0; }

  claseCupo(valor: number, cupo: number | null): string {
    if (!cupo) return '';
    return valor > cupo ? 'cupo-mal' : valor / cupo >= 0.8 ? 'cupo-aviso' : 'cupo-ok';
  }

  /** Texto del intervalo vigente para mostrar fuera del formulario. */
  textoRecordatorio(min: number | undefined): string { return this.recordatorios.find((r) => r.min === min)?.texto.toLowerCase() ?? `cada ${min} minutos`; }

  nombreProveedor(p: ProveedorConsumo): string { return p === 'ASISA' ? 'ASISA' : 'OLIMPIA'; }

  claseSerie(p: ProveedorConsumo): string { return p === 'ASISA' ? 's1' : 's2'; }

  // ------------------------------------------------------------------ tablas
  get clientesFiltrados(): ClienteIntentos[] {
    const l = this.datos?.topClientes ?? [];
    return this.soloExceso ? l.filter((c) => c.exceso > 0) : l;
  }

  get totalPaginasClientes(): number { return Math.max(1, Math.ceil(this.clientesFiltrados.length / POR_PAGINA)); }

  get clientesPagina(): ClienteIntentos[] {
    const ini = (this.paginaClientes - 1) * POR_PAGINA;
    return this.clientesFiltrados.slice(ini, ini + POR_PAGINA);
  }

  get maxIntentos(): number { return Math.max(1, ...(this.datos?.topClientes ?? []).map((c) => c.intentos)); }

  cambiarPaginaClientes(delta: number): void {
    this.paginaClientes = Math.min(this.totalPaginasClientes, Math.max(1, this.paginaClientes + delta));
  }

  alternarExceso(): void { this.soloExceso = !this.soloExceso; this.paginaClientes = 1; }

  get resultadosFiltrados(): ResultadoFrecuente[] {
    const l = this.datos?.resultados ?? [];
    return this.filtroOrigen ? l.filter((r) => r.origen === this.filtroOrigen) : l;
  }

  get maxResultado(): number { return Math.max(1, ...this.resultadosFiltrados.map((r) => r.total)); }

  trackCliente = (_: number, c: ClienteIntentos): string => `${c.idCliente}|${c.proveedor}|${c.fecha}`;

  // ------------------------------------------------------------------ pestañas y detalle
  cambiarVista(v: Vista): void { this.vista = v; this.hoverIdx = null; this.hoverHora = null; }

  abrirDetalle(c: ClienteIntentos): void {
    if (!c.fecha) return;
    this.clienteAbierto = c; this.detalle = null; this.errorDetalle = ''; this.cargandoDetalle = true; this.soloProveedorFoco = false;
    this.api.detalleClienteDia(c.idCliente, c.fecha, c.proveedor).subscribe({
      next: (d) => { this.detalle = d; this.cargandoDetalle = false; this.calcularHistorial(d); },
      error: (e: HttpErrorResponse) => { this.cargandoDetalle = false; this.errorDetalle = e.error?.error || 'No se pudo consultar el detalle del cliente.'; },
    });
  }

  @HostListener('document:keydown.escape')
  cerrarDetalle(): void { this.clienteAbierto = null; this.detalle = null; this.errorDetalle = ''; }

  private calcularHistorial(d: DetalleClienteDia): void {
    const max = Math.max(1, ...d.historial.map((h) => h.ASISA + h.OLIMPIA));
    this.histMax = max;
    const ancho = 760 / d.historial.length;
    this.barrasHist = d.historial.map((h, i) => {
      const ha = (h.ASISA / max) * (this.histAlto - 24);
      const ho = (h.OLIMPIA / max) * (this.histAlto - 24);
      return { fecha: h.fecha, x: i * ancho, ancho, ya: this.histAlto - 18 - ha, ha, yo: this.histAlto - 18 - ha - ho, ho, habil: h.habil, asisa: h.ASISA, olimpia: h.OLIMPIA };
    });
  }

  get casosDetalle(): CasoDetalle[] {
    const d = this.detalle;
    if (!d) return [];
    return this.soloProveedorFoco && d.proveedorFoco ? d.casos.filter((c) => c.proveedor === d.proveedorFoco) : d.casos;
  }

  maxHoraDetalle(): number { return Math.max(1, ...(this.detalle?.horas ?? [0])); }

  claseEstado(estado: number): string {
    return estado === 4 ? 'est-ok' : estado === 5 ? 'est-mal' : estado === 3 ? 'est-warn' : 'est-otro';
  }

  textoMin(min: number | null | undefined): string {
    if (min === null || min === undefined) return '—';
    if (min < 1) return 'menos de 1 min';
    if (min < 60) return `${Math.round(min * 10) / 10} min`;
    const h = Math.floor(min / 60); const m = Math.round(min % 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  /** «Martes 13/10 · Festivo» para mostrar junto a una fecha. */
  textoDia(fecha: string | null | undefined, diaSemana?: string): string {
    return `${diaSemana ? diaSemana + ' ' : ''}${this.fechaLarga(fecha)}`;
  }

  hora8(h: string | null): string { return h ?? '—'; }

  porcentajeCupoRegla(usados: number, limite: number | null): number { return limite && limite > 0 ? Math.min(100, Math.round((usados / limite) * 100)) : 0; }

  textoConsulta(r: { consulta: { proveedor: string | null; servicio: string | null; peso: number | null }[] }): string {
    return r.consulta.length ? r.consulta.map((c) => `${c.proveedor ?? '—'}${c.servicio ? ' (' + c.servicio + ')' : ''}${c.peso !== null ? ' ' + c.peso + '%' : ''}`).join(' + ') : 'sin configuración';
  }

  cantidadClientesConReuso(d: TableroConsumo): number { return d.proveedores.reduce((a, p) => a + p.reuso.clientesReusan, 0); }

  claseCanal(canal: number): string { return canal === 1 ? 'canal-app' : 'canal-def'; }
  /** Color del resultado según su homologación (EXITOSO / FALLIDO / REINTENTAR / PENDIENTE). */
  claseHomologacion(h: string | null): string {
    const x = (h || '').toUpperCase();
    return x === 'EXITOSO' ? 'h-ok' : (x === 'FALLIDO' ? 'h-mal' : (x === 'REINTENTAR' ? 'h-warn' : 'h-neutro'));
  }
  /** Nombre corto de un tipo de captura: «ImagenFrontalDocumento» → «Frontal doc.». */
  capturaCorta(tipo: string): string {
    return (tipo || '').replace(/^Imagen/i, '').replace(/Documento$/i, ' doc.').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || tipo;
  }
  /** Texto corto del canal: 0 = WhoisWho, 1 = App. */
  etiquetaCanal(canal: number): string { return canal === 0 ? 'WhoisWho' : (canal === 1 ? 'App' : `Canal ${canal}`); }

  exportarDetalle(): void {
    const d = this.detalle;
    if (!d) return;
    const libro = XLSX.utils.book_new();
    const resumen = [{
      Documento: d.cliente.documento ?? '', 'Tipo de documento': d.cliente.tipoDocumento ?? '', Nombre: d.cliente.nombre ?? '', Fecha: d.fecha, Día: d.diaSemana,
      'Día hábil': d.habil ? 'Sí' : (d.motivoNoHabil ?? 'No'), Casos: d.resumen.casos, Reusos: d.resumen.reusos, 'Después de un éxito': d.resumen.despuesExito,
      'Sobre el límite': d.resumen.sobreLimite, Límite: d.limite, 'Canal 0 (WhoisWho)': d.resumen.viaWhoisWho, 'Desde app (canal 1)': d.resumen.viaApp, 'Primer intento': d.resumen.primerIntento ?? '', 'Último intento': d.resumen.ultimoIntento ?? '',
    }];
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(resumen), 'Resumen');
    const casos = d.casos.map((c) => ({
      Caso: c.id, Hora: c.hora ?? '', Proveedor: c.proveedor, 'N.º del día': c.numero, Canal: c.canalNombre, Regla: c.regla, 'Producto · subproducto de la regla': c.descripcionRegla ?? '', Transacción: c.transaccion ?? '', Estado: c.estadoNombre,
      Reintentos: c.reintentos, 'Min desde el anterior': c.minDesdeAnterior ?? '', Reuso: c.esReuso ? 'Sí' : 'No', 'Después de un éxito': c.despuesExito ? 'Sí' : 'No',
      'Sobre el límite': c.sobreLimite ? 'Sí' : 'No', 'Sobre la regla': c.excedeRegla ? 'Sí' : 'No', Capturas: c.capturas,
      Resultados: c.resultados.map((r) => `${r.respondio ?? ''} ${r.codigo ?? ''} ${r.descripcion ?? ''}${r.homologacion ? ` [${r.homologacion}]` : ''} x${r.total}`.trim()).join(' | '),
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(casos), 'Casos del día');
    const reglas = d.reglas.map((r) => ({
      Regla: r.regla, Producto: r.producto ?? '', Subproducto: r.subproducto ?? '', Transacción: r.transaccion ?? '', Validación: r.idValidacion ?? '', 'Consulta a': this.textoConsulta(r), 'Límite por día': r.intentosDia ?? '', 'Límite por mes': r.intentosMes ?? '', Vigencia: r.vigencia ?? '',
      'Usados hoy': r.usadosHoy, 'Usados en el mes': r.usadosMes, 'Contador día (INTENTO)': r.contadorDia ?? '', 'Contador mes (INTENTO)': r.contadorMes ?? '',
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(reglas), 'Reglas');
    const hist = d.historial.map((h) => ({ Fecha: h.fecha, 'Día hábil': h.habil ? 'Sí' : 'No', ASISA: h.ASISA, OLIMPIA: h.OLIMPIA }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(hist), 'Últimos 30 días');
    XLSX.writeFile(libro, `detalle-biometria_${d.cliente.documento ?? d.cliente.idCliente}_${d.fecha}.xlsx`);
  }

  // ------------------------------------------------------------------ exportar
  exportarExcel(): void {
    const d = this.datos;
    if (!d) return;
    const libro = XLSX.utils.book_new();
    const resumen = d.proveedores.map((p) => ({
      Proveedor: p.proveedor, Casos: p.total, Exitosos: p.exitosos, Fallidos: p.fallidos, 'En reintento': p.reintentos, Pendientes: p.pendientes,
      'En proceso': p.enProceso, 'Fuera de línea': p.fueraLinea, 'Reintentos acumulados': p.reintentosAcum, Clientes: p.clientes,
      'Promedio diario': p.promedioDiario, 'Casos periodo anterior': p.previo.total, 'Cliente-días sobre el límite': p.excesoClientesDia, 'Consultas sobre el límite': p.excesoConsultas,
      'Reusos (casos − clientes-día)': p.reuso.reusos, 'Tasa de reuso %': p.reuso.tasa, 'Reusos después de un éxito': p.reuso.despuesExito, 'Clientes con reuso': p.reuso.clientesReusan,
      'Prom. día hábil': p.habiles.promedio, 'Prom. día no hábil': p.noHabiles.promedio,
      'Cupo diario': p.cupo.dia ?? '', 'Días sobre cupo': p.cupo.diasExcedidos.length, 'Exceso sobre cupo diario': p.cupo.excesoDia, 'Cupo mensual': p.cupo.mes ?? '',
      'Sobrecosto estimado (día)': p.cupo.sobrecostoDia ?? '', 'Sobrecosto estimado (mes)': p.cupo.sobrecostoMes ?? '',
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(resumen), 'Resumen');
    const diaria = d.diaria.map((f) => ({
      Fecha: f.fecha, Día: f.diaSemana, 'Día hábil': f.habil ? 'Sí' : (f.motivoNoHabil ?? 'No'),
      'ASISA reusos': f.ASISA.reusos, 'OLIMPIA reusos': f.OLIMPIA.reusos,
      'ASISA casos': f.ASISA.total, 'ASISA reintentos': f.ASISA.reintentos, 'ASISA fallidos': f.ASISA.fallidos, 'ASISA clientes sobre límite': f.ASISA.clientesExceden,
      'OLIMPIA casos': f.OLIMPIA.total, 'OLIMPIA reintentos': f.OLIMPIA.reintentos, 'OLIMPIA fallidos': f.OLIMPIA.fallidos, 'OLIMPIA clientes sobre límite': f.OLIMPIA.clientesExceden,
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(diaria), 'Por día');
    const horas = d.horas.map((h) => ({ Hora: `${String(h.hora).padStart(2, '0')}:00`, 'ASISA casos': h.ASISA.total, 'ASISA reintentos': h.ASISA.reintentos, 'OLIMPIA casos': h.OLIMPIA.total, 'OLIMPIA reintentos': h.OLIMPIA.reintentos }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(horas), 'Por hora');
    const clientes = d.topClientes.map((c) => ({
      Documento: c.documento ?? '', Nombre: c.nombre ?? '', Proveedor: c.proveedor, Fecha: c.fecha ?? '', Intentos: c.intentos, Reusos: c.reusos, 'Después de un éxito': c.despuesExito, 'Día hábil': c.habil ? 'Sí' : (c.motivoNoHabil ?? 'No'), 'WhoisWho (canal 0)': c.viaWhoisWho, 'Desde app (canal 1)': c.viaApp, 'ID caso (menor)': c.primerCaso ?? '', 'ID caso (mayor)': c.ultimoCaso ?? '', 'Sobre el límite': c.exceso,
      Exitosos: c.exitosos, Fallidos: c.fallidos, Reintentos: c.reintentos, 'Primer intento': c.primerIntento ?? '', 'Último intento': c.ultimoIntento ?? '',
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(clientes), 'Clientes');
    const reglas = d.reglas.map((r) => ({
      Regla: r.id, Producto: r.producto ?? '', Subproducto: r.subproducto ?? '', Transacción: r.transaccion ?? '', Validación: r.validacion ?? '', 'Tópico (REGLA.topico)': r.topico ?? '', 'Se cuenta como': r.clasificacion, 'Consulta (configuración)': this.textoConsulta(r),
      'Capturas que pide': r.capturas.map((c) => `${c.tipo}${c.obligatorio ? '*' : ''}`).join(', '), 'Límite por día': r.intentosDia ?? '', 'Límite por mes': r.intentosMes ?? '', Vigencia: r.vigencia ?? '',
      'Casos en el rango': r.uso.casos, 'Clientes': r.uso.clientes,
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(reglas), 'Reglas');
    const resultados = d.resultados.map((r) => ({ Proveedor: r.proveedor ?? '', Origen: r.origen, Código: r.codigo ?? '', Descripción: r.descripcion ?? '', Total: r.total }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(resultados), 'Resultados');
    XLSX.writeFile(libro, `consumo-biometria_${d.filtro.desde}_a_${d.filtro.hasta}.xlsx`);
  }
}
