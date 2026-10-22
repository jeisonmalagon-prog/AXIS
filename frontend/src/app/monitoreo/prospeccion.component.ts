import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, Subscription, interval } from 'rxjs';
import { BarListComponent, ItemBarList } from '../shared/charts/bar-list.component';
import { ProspeccionBloqueComponent } from './prospeccion-bloque.component';
import {
  BloqueResultado, EstadoProspeccion, FormConexion, ProspeccionService, RespuestaCargue, RespuestaCargues, RespuestaCliente,
  RespuestaEsquema, RespuestaLogs, RespuestaPagares, RespuestaProcesos, RespuestaResumen, ResultadoPrueba, TablaEsquema,
} from './prospeccion.service';

export type Pestana = 'resumen' | 'cargues' | 'cliente' | 'procesos' | 'pagares' | 'logs' | 'esquema';

interface Tarjeta { id: string; titulo: string; ayuda: string; valor: number | null; ok: boolean; error: string | null; }

const KPIS: { id: string; titulo: string }[] = [
  { id: 'kpi_cargues', titulo: 'Cargues de campaña' },
  { id: 'kpi_prospectos', titulo: 'Prospectos cargados' },
  { id: 'kpi_prospectados', titulo: 'Prospectados' },
  { id: 'kpi_prospecciones', titulo: 'Prospecciones registradas' },
  { id: 'kpi_procesos', titulo: 'Procesos aliado' },
  { id: 'kpi_analisis', titulo: 'Análisis de listas' },
  { id: 'kpi_pagares', titulo: 'Pagarés' },
  { id: 'kpi_errores', titulo: 'Errores de aliados' },
];

const PERIODOS = [
  { dias: 1, texto: 'Hoy' }, { dias: 3, texto: 'Últimos 3 días' }, { dias: 7, texto: 'Últimos 7 días' },
  { dias: 15, texto: 'Últimos 15 días' }, { dias: 30, texto: 'Últimos 30 días' }, { dias: 90, texto: 'Últimos 90 días' },
];

// ============================================================================
// Soporte Nivel 1 > Monitorear prospección (GestionCliente, esquema PD). SOLO LECTURA.
//  · Resumen del período con hallazgos, cargues de aliados con su avance, trazabilidad por documento (línea de tiempo),
//    procesos aliado, pagarés, logs de errores y el esquema que se ve.
//  · El ADMIN_POD configura la conexión (servidor, base, usuario y clave) desde esta misma pantalla.
// ============================================================================
@Component({
  selector: 'app-prospeccion',
  standalone: true,
  imports: [FormsModule, RouterLink, BarListComponent, ProspeccionBloqueComponent],
  templateUrl: './prospeccion.component.html',
  styleUrl: './prospeccion.component.scss',
})
export class ProspeccionComponent implements OnInit, OnDestroy {
  readonly periodos = PERIODOS;
  readonly pestanas: { id: Pestana; texto: string }[] = [
    { id: 'resumen', texto: 'Resumen' }, { id: 'cargues', texto: 'Cargues' }, { id: 'cliente', texto: 'Cliente' },
    { id: 'procesos', texto: 'Procesos' }, { id: 'pagares', texto: 'Pagarés' }, { id: 'logs', texto: 'Errores y logs' }, { id: 'esquema', texto: 'Esquema' },
  ];

  estado: EstadoProspeccion | null = null;
  cargandoEstado = true;
  errorEstado: string | null = null;
  pestana: Pestana = 'resumen';
  private subs: Subscription[] = [];
  private pedidos = new Map<string, Subscription>();

  // Resumen
  dias = 1;
  resumen: RespuestaResumen | null = null;
  cargandoResumen = false;
  errorResumen: string | null = null;
  auto = false;

  // Cargues
  topCargues = 50;
  cargues: RespuestaCargues | null = null;
  cargandoCargues = false;
  errorCargues: string | null = null;
  cargueSel: string | null = null;
  cargueDatos: RespuestaCargue | null = null;
  cargandoCargue = false;
  errorCargue: string | null = null;

  // Cliente
  docInput = '';
  trazaDias = 1;
  cliente: RespuestaCliente | null = null;
  cargandoCliente = false;
  errorCliente: string | null = null;

  // Procesos
  procDias = 1;
  procTop = 200;
  procEstado = '';
  procAliado = '';
  procesos: RespuestaProcesos | null = null;
  cargandoProcesos = false;
  errorProcesos: string | null = null;

  // Pagarés
  pagDias = 7;
  pagares: RespuestaPagares | null = null;
  cargandoPagares = false;
  errorPagares: string | null = null;

  // Logs
  logTabla = '';
  logDias = 1;
  logs: RespuestaLogs | null = null;
  cargandoLogs = false;
  errorLogs: string | null = null;

  // Esquema
  esquema: RespuestaEsquema | null = null;
  cargandoEsquema = false;
  errorEsquema: string | null = null;
  filtroEsquema = '';
  tablaAbierta: string | null = null;

  // Conexión (ADMIN_POD)
  mostrarConexion = false;
  form: FormConexion = this.formVacio();
  guardando = false;
  probando = false;
  errorConexion: string | null = null;
  prueba: ResultadoPrueba | null = null;
  confirmarQuitar = false;
  aviso: string | null = null;
  private avisoT: ReturnType<typeof setTimeout> | undefined;

  constructor(private svc: ProspeccionService) {}

  get esAdminPod(): boolean { return !!this.estado?.esAdminPod; }
  get configurada(): boolean { return !!this.estado?.conexion.configurada; }

  ngOnInit(): void {
    this.cargarEstado();
    this.subs.push(interval(120_000).subscribe(() => {
      if (this.auto && !document.hidden && this.pestana === 'resumen' && this.configurada && !this.mostrarConexion) this.cargarResumen(true);
    }));
  }
  ngOnDestroy(): void { this.subs.forEach((s) => s.unsubscribe()); this.pedidos.forEach((p) => p.unsubscribe()); clearTimeout(this.avisoT); }

  private formVacio(): FormConexion {
    return { servidor: '', puerto: 1433, base: 'GestionCliente', usuario: '', clave: '', cifrado: false, confiarCertificado: true };
  }

  private msg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      if (e.status === 0) return 'No hay respuesta del servidor de AXIS.';
      return e.error?.error || 'No se pudo completar la consulta.';
    }
    return 'No se pudo completar la consulta.';
  }

  private pedir<T>(clave: string, obs: Observable<T>, ok: (r: T) => void, mal: (m: string) => void, fin: () => void): void {
    this.pedidos.get(clave)?.unsubscribe();
    this.pedidos.set(clave, obs.subscribe({ next: (r) => { ok(r); fin(); }, error: (e) => { mal(this.msg(e)); fin(); } }));
  }

  private avisar(texto: string): void {
    this.aviso = texto;
    clearTimeout(this.avisoT);
    this.avisoT = setTimeout(() => { this.aviso = null; }, 4500);
  }

  // ---------------------------------------------------------------- estado / pestañas
  cargarEstado(): void {
    this.cargandoEstado = true;
    this.pedir('estado', this.svc.estado(), (r) => { this.estado = r; this.errorEstado = null; if (r.conexion.configurada) this.cargarPestana(); },
      (m) => { this.errorEstado = m; }, () => { this.cargandoEstado = false; });
  }

  irA(p: Pestana): void { this.pestana = p; if (this.configurada) this.cargarPestana(); }

  cargarPestana(forzar = false): void {
    switch (this.pestana) {
      case 'resumen': if (forzar || !this.resumen) this.cargarResumen(); break;
      case 'cargues': if (forzar || !this.cargues) this.cargarCargues(); break;
      case 'procesos': if (forzar || !this.procesos) this.cargarProcesos(); break;
      case 'pagares': if (forzar || !this.pagares) this.cargarPagares(); break;
      case 'logs': if (forzar || !this.logs) this.cargarLogs(); break;
      case 'esquema': if (forzar || !this.esquema) this.cargarEsquema(forzar); break;
      case 'cliente': break;
    }
  }

  actualizar(): void {
    if (this.pestana === 'cliente') { if (this.cliente) this.buscar(this.cliente.documento); return; }
    this.cargarPestana(true);
  }

  get cargandoActual(): boolean {
    switch (this.pestana) {
      case 'resumen': return this.cargandoResumen;
      case 'cargues': return this.cargandoCargues;
      case 'cliente': return this.cargandoCliente;
      case 'procesos': return this.cargandoProcesos;
      case 'pagares': return this.cargandoPagares;
      case 'logs': return this.cargandoLogs;
      default: return this.cargandoEsquema;
    }
  }

  // ---------------------------------------------------------------- resumen
  cargarResumen(silencioso = false): void {
    if (!silencioso) this.cargandoResumen = true;
    this.pedir('resumen', this.svc.resumen(this.dias), (r) => { this.resumen = r; this.errorResumen = null; },
      (m) => { this.errorResumen = m; }, () => { this.cargandoResumen = false; });
  }
  cambiarDias(): void { this.resumen = null; this.cargarResumen(); }

  get tarjetas(): Tarjeta[] {
    const b = this.resumen?.bloques;
    return KPIS.map((k) => {
      const bl = b?.[k.id];
      const fila = bl?.ok ? bl.filas[0] : undefined;
      return { id: k.id, titulo: k.titulo, ayuda: bl?.ayuda || '', valor: fila ? Number(fila['valor']) : null, ok: !!bl?.ok, error: bl && !bl.ok ? (bl.error || null) : null };
    });
  }

  get flujo(): ItemBarList[] {
    const t = Object.fromEntries(this.tarjetas.map((x) => [x.id, x]));
    return ['kpi_prospectos', 'kpi_prospectados', 'kpi_prospecciones', 'kpi_procesos', 'kpi_analisis', 'kpi_pagares']
      .filter((id) => t[id].ok && t[id].valor !== null)
      .map((id) => ({ nombre: t[id].titulo, total: t[id].valor as number, texto: (t[id].valor as number).toLocaleString('es-CO') }));
  }

  get porcentajeProspectado(): number | null {
    const t = Object.fromEntries(this.tarjetas.map((x) => [x.id, x]));
    const c = t['kpi_prospectos'].valor;
    const p = t['kpi_prospectados'].valor;
    return c && c > 0 && p !== null ? Math.round((p / c) * 100) : null;
  }

  claveNivel(n: string): string { return `h-${n}`; }
  textoNivel(n: string): string { return ({ alto: 'Atención', medio: 'Revisar', info: 'Info', ok: 'Todo bien' } as Record<string, string>)[n] || n; }
  textoPeriodo(): string { return this.periodos.find((p) => p.dias === this.dias)?.texto.toLowerCase() || `${this.dias} días`; }

  // ---------------------------------------------------------------- cargues
  cargarCargues(): void {
    this.cargandoCargues = true;
    this.pedir('cargues', this.svc.cargues(this.topCargues), (r) => { this.cargues = r; this.errorCargues = null; },
      (m) => { this.errorCargues = m; }, () => { this.cargandoCargues = false; });
  }

  abrirCargue(id: string): void {
    this.cargueSel = id;
    this.cargueDatos = null;
    this.errorCargue = null;
    this.cargandoCargue = true;
    this.pedir('cargue', this.svc.cargue(id), (r) => { this.cargueDatos = r; }, (m) => { this.errorCargue = m; }, () => { this.cargandoCargue = false; });
  }
  cerrarCargue(): void { this.pedidos.get('cargue')?.unsubscribe(); this.cargueSel = null; this.cargueDatos = null; }

  get resumenCargue(): { etiqueta: string; valor: string }[] {
    const b: BloqueResultado | undefined = this.cargueDatos?.bloques['cd_resumen'];
    const f = b?.ok ? b.filas[0] : undefined;
    if (!f) return [];
    const nombres: Record<string, string> = { Total: 'Prospectos', Prospectados: 'Prospectados', Pendientes: 'Sin prospectar', PrimeraCarga: 'Primera carga', UltimaModificacion: 'Última modificación' };
    return Object.keys(f).map((k) => ({ etiqueta: nombres[k] || k, valor: typeof f[k] === 'number' ? (f[k] as number).toLocaleString('es-CO') : String(f[k] ?? '—') }));
  }

  // ---------------------------------------------------------------- cliente
  /** Va a la pestaña Cliente y busca el documento (desde cualquier tabla). */
  verCliente(doc: string): void {
    this.cerrarCargue();
    this.docInput = doc;
    this.pestana = 'cliente';
    this.buscar(doc);
  }

  buscarDesdeFormulario(): void { this.buscar(this.docInput); }

  buscar(doc: string): void {
    const d = String(doc || '').trim();
    this.errorCliente = null;
    if (!/^[A-Za-z0-9]{3,20}$/.test(d)) { this.errorCliente = 'Escribe un documento de 3 a 20 letras o números, sin espacios ni símbolos.'; return; }
    this.docInput = d;
    this.cargandoCliente = true;
    this.pedir('cliente', this.svc.cliente(d, this.trazaDias), (r) => { this.cliente = r; }, (m) => { this.errorCliente = m; }, () => { this.cargandoCliente = false; });
  }

  get resumenCliente(): { etiqueta: string; n: number }[] {
    const b = this.cliente?.bloques;
    if (!b) return [];
    const n = (id: string) => (b[id]?.ok ? b[id].filas.length : 0);
    return [
      { etiqueta: 'Cargues', n: n('cl_cargues') }, { etiqueta: 'Prospecciones', n: n('cl_prospeccion') }, { etiqueta: 'Campañas', n: n('cl_detalle') },
      { etiqueta: 'Procesos aliado', n: n('cl_procesos') }, { etiqueta: 'Análisis de listas', n: n('cl_analisis') }, { etiqueta: 'Pagarés', n: n('cl_pagares') },
      { etiqueta: 'Errores', n: n('cl_errores') }, { etiqueta: 'Traza', n: n('cl_traza') },
    ];
  }

  etiquetaTipo(t: string): string {
    return ({ carga: 'Cargue', prospecto: 'Prospectado', prospeccion: 'Prospección', listas: 'Listas', proceso: 'Proceso' } as Record<string, string>)[t] || t;
  }

  // ---------------------------------------------------------------- procesos / pagarés / logs / esquema
  cargarProcesos(): void {
    this.cargandoProcesos = true;
    this.pedir('procesos', this.svc.procesos({ dias: this.procDias, top: this.procTop, estado: this.procEstado, aliado: this.procAliado }),
      (r) => { this.procesos = r; this.errorProcesos = null; }, (m) => { this.errorProcesos = m; }, () => { this.cargandoProcesos = false; });
  }
  limpiarProcesos(): void { this.procEstado = ''; this.procAliado = ''; this.cargarProcesos(); }

  cargarPagares(): void {
    this.cargandoPagares = true;
    this.pedir('pagares', this.svc.pagares(this.pagDias, 200), (r) => { this.pagares = r; this.errorPagares = null; },
      (m) => { this.errorPagares = m; }, () => { this.cargandoPagares = false; });
  }

  cargarLogs(): void {
    this.cargandoLogs = true;
    this.pedir('logs', this.svc.logs(this.logTabla || null, this.logDias, 200), (r) => { this.logs = r; this.logTabla = r.tabla || ''; this.errorLogs = null; },
      (m) => { this.errorLogs = m; }, () => { this.cargandoLogs = false; });
  }

  cargarEsquema(forzar = false): void {
    this.cargandoEsquema = true;
    this.pedir('esquema', this.svc.esquema(forzar), (r) => { this.esquema = r; this.errorEsquema = null; },
      (m) => { this.errorEsquema = m; }, () => { this.cargandoEsquema = false; });
  }

  get tablasEsquema(): TablaEsquema[] {
    const t = this.filtroEsquema.trim().toLowerCase();
    const todas = this.esquema?.tablas || [];
    return t ? todas.filter((x) => x.nombre.toLowerCase().includes(t) || x.columnas.some((c) => c.nombre.toLowerCase().includes(t))) : todas;
  }
  alternarTabla(n: string): void { this.tablaAbierta = this.tablaAbierta === n ? null : n; }

  // ---------------------------------------------------------------- conexión (ADMIN_POD)
  get origenTexto(): string {
    const c = this.estado?.conexion;
    if (!c || !c.configurada) return 'Sin configurar';
    return ({ guardada: 'Guardada en la aplicación', env: 'Variables de entorno del servidor (.env)', predefinida: 'Predefinida en el servidor', sesion: 'Sesión', pantalla: 'Pantalla' } as Record<string, string>)[c.origen] || c.origen;
  }

  abrirConexion(): void {
    const c = this.estado?.conexion;
    this.form = {
      servidor: c?.servidor || '', puerto: c?.puerto || 1433, base: c?.base || 'GestionCliente', usuario: c?.usuario || '', clave: '',
      cifrado: !!c?.cifrado, confiarCertificado: c?.confiarCertificado !== false,
    };
    this.errorConexion = null;
    this.prueba = null;
    this.confirmarQuitar = false;
    this.mostrarConexion = true;
  }
  cerrarConexion(): void { if (!this.guardando) this.mostrarConexion = false; }

  probarConexion(): void {
    this.errorConexion = null;
    this.prueba = null;
    this.probando = true;
    const usarBorrador = !!this.form.servidor.trim();
    this.pedir('probar', this.svc.probarConexion(usarBorrador ? this.form : null), (r) => { this.prueba = r; },
      (m) => { this.errorConexion = m; }, () => { this.probando = false; });
  }

  guardarConexion(): void {
    this.errorConexion = null;
    this.guardando = true;
    this.pedir('guardar', this.svc.guardarConexion(this.form), (r) => {
      if (this.estado) this.estado = { ...this.estado, conexion: r };
      this.mostrarConexion = false;
      this.avisar('Conexión guardada.');
      this.resumen = null; this.cargues = null; this.procesos = null; this.pagares = null; this.logs = null; this.esquema = null;
      this.cargarPestana(true);
    }, (m) => { this.errorConexion = m; }, () => { this.guardando = false; });
  }

  quitarConexion(): void {
    if (!this.confirmarQuitar) { this.confirmarQuitar = true; return; }
    this.guardando = true;
    this.pedir('quitar', this.svc.quitarConexion(), (r) => {
      if (this.estado) this.estado = { ...this.estado, conexion: r };
      this.mostrarConexion = false;
      this.avisar('Se quitó la conexión guardada.');
      this.resumen = null; this.cargues = null; this.procesos = null; this.pagares = null; this.logs = null; this.esquema = null; this.cliente = null;
    }, (m) => { this.errorConexion = m; }, () => { this.guardando = false; this.confirmarQuitar = false; });
  }
}
