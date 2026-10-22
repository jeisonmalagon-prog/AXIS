import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, Subscription, interval } from 'rxjs';
import { ProspeccionBloqueComponent } from '../monitoreo/prospeccion-bloque.component';
import { BrebConexionesComponent } from './breb-conexiones.component';
import { BrebDetalleComponent, ModoDetalle } from './breb-detalle.component';
import {
  BloqueResultado, BrebService, Catalogos, Conexiones, Destino, EstadoBreb, EventoLinea, FiltrosLogs, FiltrosTransacciones, Hallazgo, Origenes,
  RespuestaCliente, RespuestaErrores, RespuestaHerramientaLlave, RespuestaLlaves, RespuestaLogs, RespuestaParametros, RespuestaReconciliacion,
  RespuestaResumen, RespuestaTransacciones, UsuarioBreb,
} from './breb.service';

export type Pestana = 'resumen' | 'transacciones' | 'errores' | 'cliente' | 'llaves' | 'logs' | 'parametros' | 'herramientas';
type Tono = 'neutro' | 'ok' | 'mal' | 'pend';

interface Rango { rango: string; desde: string; hasta: string; }
interface Tarjeta { titulo: string; valor: string; sub?: string; tono: Tono; ayuda?: string; }

const RANGOS_TODOS = [
  { id: '1h', texto: 'Última hora' }, { id: '6h', texto: 'Últimas 6 horas' }, { id: '24h', texto: 'Últimas 24 horas' }, { id: 'hoy', texto: 'Hoy' }, { id: 'ayer', texto: 'Ayer' },
  { id: '3d', texto: 'Últimos 3 días' }, { id: '7d', texto: 'Últimos 7 días' }, { id: '30d', texto: 'Últimos 30 días' }, { id: '90d', texto: 'Últimos 90 días' }, { id: 'custom', texto: 'Personalizado' },
];
const RANGOS_LOGS = RANGOS_TODOS.filter((r) => ['1h', '6h', '24h', 'hoy', 'ayer', '3d', 'custom'].includes(r.id));
const RANGOS_ERRORES = RANGOS_TODOS.filter((r) => !['90d'].includes(r.id));
const RANGOS_REC = RANGOS_TODOS.filter((r) => ['1h', '6h', '24h', 'hoy', 'ayer', 'custom'].includes(r.id));

const RE_DOC = /^[A-Za-z0-9]{3,20}$/;
const RE_ALIAS = /^[A-Za-z0-9@._+\-]{1,100}$/;

// ============================================================================
// Monitoreo transaccional > BREB. SOLO LECTURA.
//  · SQL Server de BreB (trx.Redeban trae toda la información transaccional), logs de MariaDB y servicio de llaves.
//  · Resumen, transacciones con su detalle y recorrido, detección de errores, cliente 360, llaves y QR, logs, parámetros y herramientas de llaves.
//  · El ADMIN_POD configura las tres conexiones desde esta pantalla; los datos personales llegan siempre enmascarados.
// ============================================================================
@Component({
  selector: 'app-breb',
  standalone: true,
  imports: [FormsModule, ProspeccionBloqueComponent, BrebConexionesComponent, BrebDetalleComponent],
  templateUrl: './breb.component.html',
  styleUrl: './breb.component.scss',
})
export class BrebComponent implements OnInit, OnDestroy {
  readonly fuentes: { id: Destino; t: string }[] = [{ id: 'sql', t: 'SQL Server' }, { id: 'log', t: 'Logs (MariaDB)' }, { id: 'api', t: 'Servicio de llaves' }];
  readonly rangosTodos = RANGOS_TODOS;
  readonly rangosLogs = RANGOS_LOGS;
  readonly rangosErrores = RANGOS_ERRORES;
  readonly rangosRec = RANGOS_REC;
  readonly pestanas: { id: Pestana; texto: string }[] = [
    { id: 'resumen', texto: 'Resumen' }, { id: 'transacciones', texto: 'Transacciones' }, { id: 'errores', texto: 'Errores' }, { id: 'cliente', texto: 'Cliente' },
    { id: 'llaves', texto: 'Llaves y QR' }, { id: 'logs', texto: 'Logs' }, { id: 'parametros', texto: 'Parámetros' }, { id: 'herramientas', texto: 'Consultar llaves' },
  ];

  estado: EstadoBreb | null = null;
  cargandoEstado = true;
  errorEstado: string | null = null;
  pestana: Pestana = 'resumen';
  private subs: Subscription[] = [];
  private pedidos = new Map<string, Subscription>();

  // ---- Resumen
  rResumen: Rango = { rango: 'hoy', desde: '', hasta: '' };
  auto = false;
  resumen: RespuestaResumen | null = null;
  cargandoResumen = false;
  errorResumen: string | null = null;
  tarjetas: Tarjeta[] = [];
  tarjetasLog: Tarjeta[] = [];
  dSerHora: BloqueResultado | undefined;
  dSerDia: BloqueResultado | undefined;
  dPorEstado: BloqueResultado | undefined;
  dPorDireccion: BloqueResultado | undefined;
  dLogErrHora: BloqueResultado | undefined;

  // ---- Transacciones
  ft: FiltrosTransacciones = { rango: 'hoy', desde: '', hasta: '', estado: '', caso: '', escenario: '', iniciador: '', entidad: '', direccion: '', montoMin: '', montoMax: '', q: '', top: 100 };
  trx: RespuestaTransacciones | null = null;
  cargandoTrx = false;
  errorTrx: string | null = null;

  // ---- Errores
  rErrores: Rango = { rango: 'hoy', desde: '', hasta: '' };
  errores: RespuestaErrores | null = null;
  cargandoErrores = false;
  errorErrores: string | null = null;
  dErrLogHora: BloqueResultado | undefined;
  rRec: Rango = { rango: 'hoy', desde: '', hasta: '' };
  rec: RespuestaReconciliacion | null = null;
  cargandoRec = false;
  errorRec: string | null = null;

  // ---- Cliente
  docInput = '';
  diasCliente = 30;
  diasLogsCliente = 3;
  cliente: RespuestaCliente | null = null;
  cargandoCliente = false;
  errorCliente: string | null = null;

  // ---- Llaves y QR
  rLlaves: Rango = { rango: '30d', desde: '', hasta: '' };
  llaves: RespuestaLlaves | null = null;
  cargandoLlaves = false;
  errorLlaves: string | null = null;

  // ---- Logs
  fl: FiltrosLogs = { rango: '1h', desde: '', hasta: '', cus: '', documento: '', clase: '', metodo: '', nivel: '', texto: '', enPayload: false, top: 100 };
  logs: RespuestaLogs | null = null;
  logsLista: BloqueResultado | undefined;
  cargandoLogs = false;
  cargandoMasLogs = false;
  errorLogs: string | null = null;

  // ---- Parámetros
  parApp = '';
  parTexto = '';
  parametros: RespuestaParametros | null = null;
  cargandoParametros = false;
  errorParametros: string | null = null;

  // ---- Herramientas de llaves
  catalogos: Catalogos | null = null;
  hCon = { idTipoPersona: null as number | null, idTipoDocumento: null as number | null, numeroDocumento: '' };
  hRes = { aliasValue: '', received: '' };
  resCon: RespuestaHerramientaLlave | null = null;
  resRes: RespuestaHerramientaLlave | null = null;
  cargandoCon = false;
  cargandoRes = false;
  errorCon: string | null = null;
  errorRes: string | null = null;
  verPayloadCon = false;
  verPayloadRes = false;

  // ---- Panel de detalle y conexiones
  detalle: { modo: ModoDetalle; id: string } | null = null;
  mostrarConexiones = false;
  destinoInicial: Destino = 'sql';
  aviso: string | null = null;
  private avisoT: ReturnType<typeof setTimeout> | undefined;

  constructor(private svc: BrebService) {}

  get esAdminPod(): boolean { return !!this.estado?.esAdminPod; }
  get con(): Conexiones | null { return this.estado?.conexiones || null; }
  get haySql(): boolean { return !!this.con?.sql.configurada; }
  get hayLog(): boolean { return !!this.con?.log.configurada; }
  get hayApi(): boolean { return !!this.con?.api.configurada; }
  get hayDatos(): boolean { return this.haySql || this.hayLog; }

  ngOnInit(): void {
    this.cargarEstado();
    this.subs.push(interval(60_000).subscribe(() => {
      if (this.auto && !document.hidden && this.pestana === 'resumen' && this.hayDatos && !this.mostrarConexiones && !this.detalle) this.cargarResumen(true);
    }));
  }
  ngOnDestroy(): void { this.subs.forEach((s) => s.unsubscribe()); this.pedidos.forEach((p) => p.unsubscribe()); clearTimeout(this.avisoT); }

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

  private rango(r: Rango): { rango: string; desde?: string; hasta?: string } {
    return r.rango === 'custom' ? { rango: 'custom', desde: r.desde, hasta: r.hasta } : { rango: r.rango };
  }

  // ---------------------------------------------------------------- estado y pestañas
  cargarEstado(): void {
    this.cargandoEstado = true;
    this.pedir('estado', this.svc.estado(), (r) => { this.estado = r; this.errorEstado = null; if (this.hayDatos) this.cargarPestana(); },
      (m) => { this.errorEstado = m; }, () => { this.cargandoEstado = false; });
  }

  irA(p: Pestana): void { this.pestana = p; if (this.hayDatos || p === 'herramientas') this.cargarPestana(); }

  cargarPestana(forzar = false): void {
    switch (this.pestana) {
      case 'resumen': if (forzar || !this.resumen) this.cargarResumen(); break;
      case 'transacciones': if (forzar || !this.trx) this.cargarTransacciones(); break;
      case 'errores': if (forzar || !this.errores) this.cargarErrores(); break;
      case 'llaves': if (forzar || !this.llaves) this.cargarLlaves(); break;
      case 'logs': if (forzar || !this.logs) this.cargarLogs(); break;
      case 'parametros': if (forzar || !this.parametros) this.cargarParametros(); break;
      case 'herramientas': if (!this.catalogos && this.haySql) this.cargarCatalogos(); break;
      case 'cliente': break;
    }
  }

  actualizar(): void {
    if (this.pestana === 'cliente') { if (this.cliente && RE_DOC.test(this.docInput)) this.buscarCliente(); return; }
    if (this.pestana === 'herramientas') return;
    this.cargarPestana(true);
  }

  get cargandoActual(): boolean {
    switch (this.pestana) {
      case 'resumen': return this.cargandoResumen;
      case 'transacciones': return this.cargandoTrx;
      case 'errores': return this.cargandoErrores || this.cargandoRec;
      case 'cliente': return this.cargandoCliente;
      case 'llaves': return this.cargandoLlaves;
      case 'logs': return this.cargandoLogs;
      case 'parametros': return this.cargandoParametros;
      default: return false;
    }
  }

  /** Avisos de las fuentes que no respondieron o no están configuradas. */
  avisosOrigen(o: Origenes | undefined): string[] {
    if (!o) return [];
    const a: string[] = [];
    if (o.sql.estado === 'sin_config') a.push('La base SQL Server de BreB no está configurada: solo se muestra lo que sale de los logs.');
    if (o.log.estado === 'sin_config') a.push('Los logs de MariaDB no están configurados: solo se muestra lo que sale de SQL Server.');
    if (o.sql.estado === 'error') a.push(`No se pudo leer la base SQL Server: ${o.sql.error}`);
    if (o.log.estado === 'error') a.push(`No se pudieron leer los logs: ${o.log.error}`);
    return a;
  }

  nivelTexto(n: Hallazgo['nivel']): string { return ({ alto: 'Atención', medio: 'Revisar', info: 'Info', ok: 'Todo bien' } as Record<string, string>)[n] || n; }

  // ---------------------------------------------------------------- auxiliares de bloques
  private fila0(b: BloqueResultado | undefined): Record<string, string | number | boolean | null> | null { return b?.ok && b.filas.length ? b.filas[0] : null; }
  private n(v: unknown): number | null { return v === null || v === undefined || v === '' ? null : Number(v); }
  private fmtN(v: unknown): string { const x = this.n(v); return x === null || Number.isNaN(x) ? '—' : x.toLocaleString('es-CO'); }
  private fmtM(v: unknown): string { const x = this.n(v); return x === null || Number.isNaN(x) ? '—' : `$${Math.round(x).toLocaleString('es-CO')}`; }
  private pct(a: unknown, t: unknown): string { const x = this.n(a); const y = this.n(t); return x === null || !y ? '' : `${(x / y * 100).toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`; }

  /** Copia de un bloque con solo algunas columnas (y las horas como «15:00») para graficarlo. */
  private sub(b: BloqueResultado | undefined, cols: string[]): BloqueResultado | undefined {
    if (!b) return undefined;
    return {
      ...b,
      columnas: cols.map((c) => b.columnas.find((x) => x.clave === c) || { clave: c, etiqueta: c }),
      filas: b.filas.map((f) => {
        const o: Record<string, string | number | boolean | null> = {};
        for (const c of cols) o[c] = c === 'Hora' && typeof f[c] === 'number' ? `${String(f[c]).padStart(2, '0')}:00` : f[c] ?? null;
        return o;
      }),
    };
  }

  // ---------------------------------------------------------------- resumen
  cargarResumen(silencioso = false): void {
    if (!silencioso) this.cargandoResumen = true;
    this.pedir('resumen', this.svc.resumen(this.rango(this.rResumen)), (r) => {
      this.resumen = r;
      this.errorResumen = null;
      this.armarResumen(r);
    }, (m) => { this.errorResumen = m; }, () => { this.cargandoResumen = false; });
  }

  cambiarRangoResumen(): void { if (this.rResumen.rango !== 'custom') { this.resumen = null; this.cargarResumen(); } }

  private armarResumen(r: RespuestaResumen): void {
    const b = r.bloques;
    const k = this.fila0(b['kpis']);
    const t: Tarjeta[] = [];
    if (k) {
      const mal = this.n(k['Rechazadas']) || 0;
      t.push({ titulo: 'Transacciones', valor: this.fmtN(k['Total']), sub: k['Primera'] ? `desde ${String(k['Primera']).slice(0, 16)}` : undefined, tono: 'neutro', ayuda: 'Filas de trx.Redeban en el rango.' });
      t.push({ titulo: 'Aprobadas', valor: this.fmtN(k['Aprobadas']), sub: this.pct(k['Aprobadas'], k['Total']), tono: 'ok' });
      t.push({ titulo: 'Rechazadas', valor: this.fmtN(k['Rechazadas']), sub: this.pct(k['Rechazadas'], k['Total']), tono: mal > 0 ? 'mal' : 'neutro' });
      t.push({ titulo: 'Pendientes', valor: this.fmtN(k['Pendientes']), sub: 'ACSP, ACTC, PDNG…', tono: (this.n(k['Pendientes']) || 0) > 0 ? 'pend' : 'neutro' });
      t.push({ titulo: 'Sin estado', valor: this.fmtN(k['SinEstado']), sub: 'sin estado global', tono: (this.n(k['SinEstado']) || 0) > 0 ? 'pend' : 'neutro' });
      t.push({ titulo: 'Monto aprobado', valor: this.fmtM(k['MontoAprobado']), sub: `de ${this.fmtM(k['MontoTotal'])} intentados`, tono: 'neutro' });
      t.push({ titulo: 'Ticket promedio', valor: this.fmtM(k['TicketPromedio']), sub: `máximo ${this.fmtM(k['MontoMaximo'])}`, tono: 'neutro' });
      t.push({ titulo: 'Tiempo de ejecución', valor: k['EjecucionPromedio'] === null ? '—' : (this.n(k['EjecucionPromedio']) || 0).toLocaleString('es-CO', { maximumFractionDigits: 1 }), sub: `máximo ${this.fmtN(k['EjecucionMaxima'])}`, tono: 'neutro', ayuda: 'Campo ExecutionTime que reporta Redeban.' });
      t.push({ titulo: 'Clientes que pagan', valor: this.fmtN(k['ClientesDebito']), sub: 'documentos distintos (débito)', tono: 'neutro' });
      t.push({ titulo: 'Salientes', valor: this.fmtN(k['Salientes']), sub: 'el banco paga o envía', tono: 'neutro' });
      t.push({ titulo: 'Entrantes', valor: this.fmtN(k['Entrantes']), sub: 'el banco recibe', tono: 'neutro' });
      t.push({ titulo: 'Internas (OnUs)', valor: this.fmtN(k['Internas']), sub: 'entre clientes del banco', tono: 'neutro' });
      const min = this.n(k['MinDesdeUltima']);
      t.push({ titulo: 'Última transacción', valor: min === null ? '—' : min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.floor(min / 60)} h ${min % 60} min` : `hace ${Math.floor(min / 1440)} d`, sub: k['Ultima'] ? String(k['Ultima']).slice(0, 19) : undefined, tono: 'neutro' });
    }
    const inc = this.fila0(b['inconsistentes']);
    if (inc) t.push({ titulo: 'Débitos sin crédito', valor: this.fmtN(inc['Casos']), sub: 'débito aceptado, crédito no', tono: (this.n(inc['Casos']) || 0) > 0 ? 'mal' : 'neutro', ayuda: 'Posible reverso al cliente.' });
    this.tarjetas = t;

    const lk = this.fila0(b['log_kpis']);
    this.tarjetasLog = lk ? [
      { titulo: 'Registros en logs', valor: this.fmtN(lk['Registros']), tono: 'neutro' },
      { titulo: 'Con error', valor: this.fmtN(lk['Errores']), sub: this.pct(lk['Errores'], lk['Registros']), tono: (this.n(lk['Errores']) || 0) > 0 ? 'mal' : 'neutro' },
      { titulo: 'Débitos (PAIN 008)', valor: this.fmtN(lk['Debitos']), tono: 'neutro' },
      { titulo: 'Transacciones vistas', valor: this.fmtN(lk['Transacciones']), tono: 'neutro' },
      { titulo: 'Clientes en logs', valor: this.fmtN(lk['Clientes']), tono: 'neutro' },
      { titulo: 'Último registro', valor: lk['UltimoRegistro'] ? String(lk['UltimoRegistro']).slice(0, 19) : '—', tono: 'neutro' },
    ] : [];

    this.dSerHora = this.sub(b['ser_hora'], ['Hora', 'Total', 'Aprobadas', 'Rechazadas']);
    this.dSerDia = this.sub(b['ser_dia'], ['Dia', 'Total', 'Aprobadas', 'Rechazadas']);
    this.dPorEstado = this.sub(b['por_estado'], ['Estado', 'Total']);
    this.dPorDireccion = this.sub(b['por_direccion'], ['Dirección', 'Total']);
    this.dLogErrHora = this.sub(b['log_err_hora'], ['Hora', 'Errores', 'Debitos']);
  }

  // ---------------------------------------------------------------- transacciones
  cargarTransacciones(): void {
    this.cargandoTrx = true;
    const f = { ...this.ft };
    if (f.rango !== 'custom') { f.desde = ''; f.hasta = ''; }
    this.pedir('trx', this.svc.transacciones(f), (r) => { this.trx = r; this.errorTrx = null; }, (m) => { this.errorTrx = m; }, () => { this.cargandoTrx = false; });
  }

  limpiarTransacciones(): void {
    this.ft = { rango: 'hoy', desde: '', hasta: '', estado: '', caso: '', escenario: '', iniciador: '', entidad: '', direccion: '', montoMin: '', montoMax: '', q: '', top: 100 };
    this.cargarTransacciones();
  }

  /** Atajo: abre la lista de transacciones ya filtrada (por ejemplo, solo las rechazadas del rango del resumen). */
  verTransacciones(estado: string): void {
    this.ft = { ...this.ft, rango: this.rResumen.rango, desde: this.rResumen.desde, hasta: this.rResumen.hasta, estado };
    this.pestana = 'transacciones';
    this.cargarTransacciones();
  }

  // ---------------------------------------------------------------- errores y reconciliación
  cargarErrores(): void {
    this.cargandoErrores = true;
    this.pedir('errores', this.svc.errores(this.rango(this.rErrores)), (r) => {
      this.errores = r;
      this.errorErrores = null;
      this.dErrLogHora = this.sub(r.bloques['log_err_hora'], ['Hora', 'Errores', 'Debitos']);
    }, (m) => { this.errorErrores = m; }, () => { this.cargandoErrores = false; });
  }
  cambiarRangoErrores(): void { if (this.rErrores.rango !== 'custom') { this.errores = null; this.cargarErrores(); } }

  cargarReconciliacion(): void {
    this.cargandoRec = true;
    this.rec = null;
    this.errorRec = null;
    this.pedir('rec', this.svc.reconciliacion(this.rango(this.rRec)), (r) => { this.rec = r; }, (m) => { this.errorRec = m; }, () => { this.cargandoRec = false; });
  }

  // ---------------------------------------------------------------- cliente
  buscarCliente(): void {
    const d = this.docInput.trim();
    this.errorCliente = null;
    if (!RE_DOC.test(d)) { this.errorCliente = 'Escribe un documento de 3 a 20 letras o números, sin espacios ni símbolos.'; return; }
    this.docInput = d;
    this.cargandoCliente = true;
    this.pedir('cliente', this.svc.cliente(d, this.diasCliente, this.diasLogsCliente), (r) => { this.cliente = r; }, (m) => { this.errorCliente = m; }, () => { this.cargandoCliente = false; });
  }

  get resumenCliente(): { etiqueta: string; n: number }[] {
    const b = this.cliente?.bloques;
    if (!b) return [];
    const n = (id: string) => (b[id]?.ok ? b[id].filas.length : 0);
    return [
      { etiqueta: 'Llaves', n: n('cl_llaves') }, { etiqueta: 'Cambios de llave', n: n('cl_historico') }, { etiqueta: 'QR', n: n('cl_qr') },
      { etiqueta: 'Transacciones', n: n('cl_trx') }, { etiqueta: 'En logs', n: n('cl_log_trx') }, { etiqueta: 'Errores en logs', n: n('cl_log_errores') },
    ];
  }

  etiquetaEvento(t: EventoLinea['tipo']): string {
    return ({ trx: 'Transacción', trx_mal: 'No aprobada', llave: 'Llave', error: 'Error', qr: 'QR' } as Record<string, string>)[t] || t;
  }

  get usuarioCliente(): UsuarioBreb | null { return this.cliente?.usuarios?.[0] || null; }

  /** Lleva a «Consultar llaves» con el documento y los tipos que ya conoce la base de BreB. */
  consultarLlavesDelCliente(): void {
    const u = this.usuarioCliente;
    this.hCon = { idTipoPersona: u?.idTipoPersona ?? this.hCon.idTipoPersona, idTipoDocumento: u?.idTipoDocumento ?? this.hCon.idTipoDocumento, numeroDocumento: this.docInput.trim() };
    this.resCon = null;
    this.errorCon = null;
    this.pestana = 'herramientas';
    this.cargarPestana();
  }

  // ---------------------------------------------------------------- llaves y QR
  cargarLlaves(): void {
    this.cargandoLlaves = true;
    this.pedir('llaves', this.svc.llaves(this.rango(this.rLlaves)), (r) => { this.llaves = r; this.errorLlaves = null; }, (m) => { this.errorLlaves = m; }, () => { this.cargandoLlaves = false; });
  }
  cambiarRangoLlaves(): void { if (this.rLlaves.rango !== 'custom') { this.llaves = null; this.cargarLlaves(); } }

  // ---------------------------------------------------------------- logs
  cargarLogs(): void {
    this.cargandoLogs = true;
    const f = { ...this.fl, antes: null };
    if (f.rango !== 'custom') { f.desde = ''; f.hasta = ''; }
    this.pedir('logs', this.svc.logs(f), (r) => { this.logs = r; this.logsLista = r.bloques['lista']; this.errorLogs = null; }, (m) => { this.errorLogs = m; }, () => { this.cargandoLogs = false; });
  }

  limpiarLogs(): void {
    this.fl = { rango: '1h', desde: '', hasta: '', cus: '', documento: '', clase: '', metodo: '', nivel: '', texto: '', enPayload: false, top: 100 };
    this.cargarLogs();
  }

  /** Pide la página siguiente (registros más antiguos) y la agrega a la lista. */
  masLogs(): void {
    const sig = this.logs?.siguiente;
    if (!sig || !this.logsLista) return;
    this.cargandoMasLogs = true;
    const f = { ...this.fl, antes: sig };
    if (f.rango !== 'custom') { f.desde = ''; f.hasta = ''; }
    this.pedir('logs-mas', this.svc.logs(f), (r) => {
      const nuevo = r.bloques['lista'];
      if (this.logsLista && nuevo?.ok) {
        this.logsLista = { ...this.logsLista, filas: [...this.logsLista.filas, ...nuevo.filas], truncado: nuevo.truncado };
        if (this.logs) this.logs = { ...this.logs, siguiente: r.siguiente };
      }
      this.errorLogs = null;
    }, (m) => { this.errorLogs = m; }, () => { this.cargandoMasLogs = false; });
  }

  verLogsDe(cus: string): void {
    this.fl = { ...this.fl, cus, documento: '', rango: '3d', desde: '', hasta: '' };
    this.pestana = 'logs';
    this.detalle = null;
    this.cargarLogs();
  }

  // ---------------------------------------------------------------- parámetros
  cargarParametros(): void {
    this.cargandoParametros = true;
    this.pedir('parametros', this.svc.parametros({ app: this.parApp.trim(), texto: this.parTexto.trim() }), (r) => { this.parametros = r; this.errorParametros = null; },
      (m) => { this.errorParametros = m; }, () => { this.cargandoParametros = false; });
  }

  // ---------------------------------------------------------------- herramientas de llaves
  cargarCatalogos(): void {
    this.pedir('catalogos', this.svc.catalogos(), (c) => {
      this.catalogos = c;
      if (this.hCon.idTipoPersona === null && c.personas.length) this.hCon.idTipoPersona = c.personas[0].id;
      if (this.hCon.idTipoDocumento === null && c.documentos.length) this.hCon.idTipoDocumento = c.documentos[0].id;
    }, () => { this.catalogos = null; }, () => { /* sin estado de carga */ });
  }

  get tiposDisponibles(): boolean { return !!this.catalogos?.disponible && !!this.catalogos.personas.length && !!this.catalogos.documentos.length; }

  consultarLlave(): void {
    this.errorCon = null;
    const d = this.hCon.numeroDocumento.trim();
    if (!RE_DOC.test(d)) { this.errorCon = 'El documento debe tener entre 3 y 20 letras o números, sin espacios ni símbolos.'; return; }
    if (this.hCon.idTipoPersona === null || this.hCon.idTipoDocumento === null) { this.errorCon = 'Indica el tipo de persona y el tipo de documento.'; return; }
    this.cargandoCon = true;
    this.resCon = null;
    this.pedir('consultar', this.svc.consultarLlave({ idTipoPersona: Number(this.hCon.idTipoPersona), idTipoDocumento: Number(this.hCon.idTipoDocumento), numeroDocumento: d }),
      (r) => { this.resCon = r; }, (m) => { this.errorCon = m; }, () => { this.cargandoCon = false; });
  }

  resolverLlave(): void {
    this.errorRes = null;
    const a = this.hRes.aliasValue.trim();
    if (!RE_ALIAS.test(a)) { this.errorRes = 'La llave debe tener entre 1 y 100 caracteres (letras, números y @ . _ + -), sin espacios.'; return; }
    this.cargandoRes = true;
    this.resRes = null;
    this.pedir('resolver', this.svc.resolverLlave({ aliasValue: a, received: this.hRes.received.trim() || undefined }),
      (r) => { this.resRes = r; }, (m) => { this.errorRes = m; }, () => { this.cargandoRes = false; });
  }

  /** El «cruce» de «resolver» llega como un bloque suelto: se muestra con el mismo componente de tablas. */
  get cruceResolver(): BloqueResultado | undefined { return (this.resRes?.cruce as unknown as BloqueResultado | null) || undefined; }

  claseHttp(h: number): string { return h >= 200 && h < 300 ? 'ok' : h >= 500 ? 'mal' : 'pend'; }

  // ---------------------------------------------------------------- detalle (transacción o registro de log)
  abrir(b: BloqueResultado | undefined, id: string): void {
    this.detalle = { modo: b?.columnaId === 'Codigo' ? 'log' : 'trx', id };
  }
  abrirTrx(id: string): void { this.detalle = { modo: 'trx', id }; }
  abrirLog(id: string): void { this.detalle = { modo: 'log', id }; }
  cerrarDetalle(): void { this.detalle = null; }

  abrirPorCus(cus: string): void { if (/^[A-Za-z0-9._-]{6,80}$/.test(cus)) this.abrirTrx(cus); }

  // ---------------------------------------------------------------- conexiones (ADMIN_POD)
  abrirConexiones(d: Destino = 'sql'): void { this.destinoInicial = d; this.mostrarConexiones = true; }
  cerrarConexiones(): void { this.mostrarConexiones = false; }

  conexionesCambiaron(e: { conexiones: Conexiones; destino: Destino; accion: 'guardada' | 'quitada' }): void {
    if (this.estado) this.estado = { ...this.estado, conexiones: e.conexiones };
    this.avisar(e.accion === 'guardada' ? 'Conexión guardada.' : 'Se quitó la conexión guardada (si hay variables BREB_* en el servidor, se usan).');
    this.resumen = null; this.trx = null; this.errores = null; this.llaves = null; this.logs = null; this.logsLista = undefined; this.parametros = null; this.cliente = null; this.catalogos = null; this.rec = null;
    if (this.hayDatos) this.cargarPestana(true);
  }

  textoConexion(d: Destino): string {
    const c = this.con;
    if (!c) return '';
    if (d === 'api') return c.api.configurada ? (c.api.url || '') : 'Sin configurar';
    const x = c[d];
    return x.configurada ? `${x.servidor} · ${x.base}` : 'Sin configurar';
  }
}
