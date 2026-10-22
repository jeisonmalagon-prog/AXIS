import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import { FlujoClienteComponent } from './flujo-cliente.component';
import { FlujoGlobalComponent } from './flujo-global.component';
import { LogDetalleComponent } from './log-detalle.component';
import { CargaProductosComponent } from './carga-productos.component';
import { OperacionesClienteComponent } from './operaciones-cliente.component';
import { SaludGlobalComponent, SubSalud } from './salud-global.component';
import { VersionesAdopcionComponent } from './versiones-adopcion.component';

// ============================================================================
// Visor interactivo de logs de App Móvil (LogApp.Log / Log_YYYYMM)
// ============================================================================
// Pantalla pensada para personal NO técnico: en vez de escribir SQL a mano
// contra LogApp (como se hacía antes en DBeaver), esta pantalla arma la
// misma búsqueda con controles -- cada filtro es independiente y se pueden
// combinar todos los que hagan falta, igual que agregar líneas a un WHERE.
// El backend (GET /api/app-movil/logs) ya se encarga de rutear la consulta
// entre LogApp.Log y las tablas Log_YYYYMM correspondientes al rango pedido,
// y de traducir cada fila a algo legible -- ver mapearLogFila en
// backend/routes/appMovil.js. El contenido de cada fila (Rq, Rs, Datos) se
// abre aparte con "Ver detalle" (GET /logs/detalle), traducido a lenguaje
// normal; no se ofusca ningún dato del log.
// ============================================================================

type VistaLogs = 'logs' | 'cliente' | 'carga' | 'operaciones' | 'global' | 'salud' | 'versiones';

interface ServicioCatalogo {
  metodo: string;
  etiqueta: string;
}

interface CatalogoLogsResponse {
  servicios: ServicioCatalogo[];
  metodosExcluidosPorDefecto: string[];
}

interface LogItem {
  codigo: number;
  documento: string;
  fecha: string;
  fechaTxt: string | null;
  clase: string;
  metodo: string;
  servicio: string;
  descripcion: string | null;
  funcionalidadCodigo: number | null;
  tipoCodigo: number | null;
  procesoCodigo: number | null;
  transaccion: string | null;
  ip: string | null;
  /** Nodo que atendió la petición (106..109), sacado del sufijo de la IP (-9:3 → 109). */
  nodo: number | null;
  dispositivo: string;
  /** Equipo legible (ej. "Infinix X6850-OP · Android 16"), null si no se pudo interpretar. */
  equipo: string | null;
  /** Versión de la app que usaba el cliente en esa fila (null si el log no la trae). */
  version: string | null;
  /** exito | error | aviso | inicio | paso | info (ver clasificarFilaLog en el backend). */
  estado: 'exito' | 'error' | 'aviso' | 'inicio' | 'paso' | 'info';
  estadoTexto: string;
  tipoFila: string;
  /** Qué clase de registro es, en palabras sencillas (ej. "Consulta al sistema del banco"). */
  tipoTexto: string;
}

interface VersionApp {
  version: string;
  /** Nombre del campo del log de donde se leyó (ej. appVersion). */
  campo: string;
  desde: string;
  hasta: string;
  registros: number;
  dispositivos: string[];
}

interface EquipoCliente {
  equipo: string | null;
  huella: string;
  plataforma: 'iOS' | 'Android' | 'Otro';
  desde: string;
  hasta: string;
  registros: number;
  instalaciones: { instalacion: string; desde: string; hasta: string }[];
  versiones: { version: string; desde: string; hasta: string; registros: number }[];
}

interface EquiposResponse {
  equipos: EquipoCliente[];
  cantidad: number;
  registrosSinEquipo: number;
}

interface VersionesResponse {
  /** Equipos (celulares) que usó el cliente en el rango, con sus instalaciones y versiones. */
  equipos?: EquiposResponse;
  disponible: boolean;
  motivo?: string;
  totalRegistros?: number;
  versiones: VersionApp[];
  actual: string | null;
  actualDesde: string | null;
  actualVistaUltimaVez: string | null;
  cambios: { de: string; a: string; fecha: string }[];
  cambioVersion: boolean;
  convivencia: boolean;
  registrosSinVersion: number;
  muestraSesion: string | null;
}

/** Fila de la tabla ya preparada para pintar (encabezado de día y marcador de cambio de versión). */
interface FilaVista {
  r: LogItem;
  hora: string;
  /** Texto del día si esta fila es la primera de un día nuevo en la página. */
  dia: string | null;
  diaTotal: number;
  /** Si entre la fila anterior (más nueva) y esta cambió la versión: de esta (antigua) a la nueva. */
  cambioVersion: { de: string; a: string } | null;
  /** La versión de la fila difiere de la versión actual del cliente. */
  versionAnterior: boolean;
}

interface LogsResponse {
  total: number;
  limit: number;
  offset: number;
  dias: number;
  fechaInicio: string | null;
  fechaFin: string | null;
  rangoPersonalizado: boolean;
  resultados: LogItem[];
}

@Component({
  selector: 'app-app-movil-logs',
  standalone: true,
  imports: [CommonModule, FormsModule, FlujoClienteComponent, FlujoGlobalComponent, LogDetalleComponent, CargaProductosComponent, OperacionesClienteComponent, SaludGlobalComponent, VersionesAdopcionComponent],
  templateUrl: './app-movil-logs.component.html',
  styleUrl: './app-movil-logs.component.scss'
})
export class AppMovilLogsComponent implements OnInit, OnDestroy {
  // Pestañas de la pantalla: consulta de logs (tabla), recorrido de un cliente
  // (diagrama de flujo) y mapa global de servicios (diagrama agregado).
  vista: VistaLogs = 'logs';
  /** Documento con el que se abre la pestaña de recorrido, carga de productos u operaciones (desde la consulta). */
  documentoRecorrido = '';
  documentoCarga = '';
  documentoOperaciones = '';
  /** Sub-pestaña con la que se abre «Salud global» y alerta de error masivo a abrir (desde la campana). */
  subSalud: SubSalud = 'latencia';
  alertaInicial: number | null = null;

  readonly pestanasVista: { valor: VistaLogs; etiqueta: string }[] = [
    { valor: 'logs', etiqueta: 'Consulta de logs' },
    { valor: 'cliente', etiqueta: 'Recorrido del cliente' },
    { valor: 'carga', etiqueta: 'Carga de productos' },
    { valor: 'operaciones', etiqueta: 'Operaciones' },
    { valor: 'global', etiqueta: 'Mapa global' },
    { valor: 'salud', etiqueta: 'Latencia y errores' },
    { valor: 'versiones', etiqueta: 'Versiones' }
  ];

  cargando = false;
  buscoAlMenosUnaVez = false;
  error: string | null = null;

  // --- Rango de fechas -- mismo patrón que el dashboard de App Móvil
  // (presets de días + rango personalizado), para que ambas pantallas se
  // sientan consistentes. ---
  readonly rangosDisponibles = [1, 7, 30, 90];
  readonly rangoDiasMaximo = 180;
  diasSeleccionados = 7;
  modoRango: 'preset' | 'personalizado' = 'preset';
  mostrandoSelectorFechas = false;
  fechaInicioInput = '';
  fechaFinInput = '';
  private fechaInicioAplicada = '';
  private fechaFinAplicada = '';
  errorRangoPersonalizado: string | null = null;

  // --- Filtros del formulario (lo que la persona está escribiendo/marcando,
  // antes de presionar "Buscar") ---
  filtroDocumento = '';
  filtroMetodo = '';
  filtroFuncionalidad = '';
  filtroTipo = '';
  filtroProceso = '';
  filtroNodo = '';
  readonly nodosDisponibles = [106, 107, 108, 109];
  filtroTexto = '';
  filtroSoloErrores = false;
  filtroIncluirLogout = false;

  // --- Filtros realmente aplicados en la última búsqueda -- se muestran
  // como "chips" sobre los resultados para que quede claro qué se está
  // viendo, incluso si la persona sigue editando el formulario sin buscar
  // todavía. ---
  filtrosAplicados: { etiqueta: string; valor: string }[] = [];

  catalogoServicios: ServicioCatalogo[] = [];
  metodosExcluidosPorDefecto: string[] = [];

  resultados: LogItem[] = [];
  filasVista: FilaVista[] = [];
  resumenPagina = { exito: 0, error: 0, aviso: 0, otros: 0 };
  total = 0;
  offset = 0;
  limit = 25;
  readonly tamanosPagina = [25, 50, 100];
  densidad: 'comoda' | 'compacta' = 'comoda';
  /** Texto copiado hace un instante (para mostrar "Copiado" en el botón). */
  copiado: string | null = null;
  private temporizadorCopiado?: ReturnType<typeof setTimeout>;

  // --- Versión de la app del cliente (panel fijo sobre los resultados) ---
  documentoAplicado = '';
  versiones: VersionesResponse | null = null;
  cargandoVersiones = false;
  errorVersiones: string | null = null;
  versionesAbiertas = false;
  muestraSesionAbierta = false;
  cambioReciente = false;
  ultimoCambio: { de: string; a: string; fecha: string } | null = null;
  /** Versiones del cliente de la más nueva a la más antigua (primera vez vista). */
  lineaVersiones: VersionApp[] = [];
  /** Versiones distintas vistas en la página actual (cuando no hay cliente filtrado). */
  versionesEnPagina: string[] = [];
  private suscripcionVersiones?: Subscription;
  fechaInicioResultado: string | null = null;
  fechaFinResultado: string | null = null;

  exportando = false;
  avisoExportacion: string | null = null;

  /** Registro abierto en el panel de detalle (null = cerrado). */
  detalleCodigo: number | null = null;
  detalleFecha = '';

  private apiUrl = `${environment.apiUrl}/app-movil`;
  private suscripcionBusqueda?: Subscription;
  private suscripcionCatalogo?: Subscription;

  constructor(private http: HttpClient, private route: ActivatedRoute) {}

  ngOnInit(): void {
    this.cargarCatalogo();

    // Pre-llenado desde un enlace de otra pantalla (ej. "Abrir en Consulta de
    // Logs" desde el dashboard, con ?documento=... o ?metodo=...): si viene
    // alguno de estos parámetros, se aplica al formulario y se busca de una
    // vez, para que la persona no tenga que volver a escribirlo.
    const params = this.route.snapshot.queryParamMap;
    try { if (localStorage.getItem('axis.logs.densidad') === 'compacta') this.densidad = 'compacta'; } catch { /* sin almacenamiento */ }
    const vistaParam = params.get('vista');
    const vistasValidas: VistaLogs[] = ['cliente', 'carga', 'operaciones', 'global', 'salud', 'versiones'];
    if (vistaParam && (vistasValidas as string[]).includes(vistaParam)) this.vista = vistaParam as VistaLogs;
    // Enlace de la campana de notificaciones: ?vista=alertas[&alerta=<id>] abre el historial de alertas de error masivo.
    if (vistaParam === 'alertas') {
      this.vista = 'salud';
      this.subSalud = 'alertas';
      const idAlerta = parseInt(params.get('alerta') ?? '', 10);
      this.alertaInicial = Number.isInteger(idAlerta) && idAlerta > 0 ? idAlerta : null;
    }
    const documento = params.get('documento');
    const metodo = params.get('metodo');
    let debeBuscar = false;
    if (documento) {
      this.filtroDocumento = documento;
      if (this.vista === 'cliente') this.documentoRecorrido = documento;
      else if (this.vista === 'carga') this.documentoCarga = documento;
      else if (this.vista === 'operaciones') this.documentoOperaciones = documento;
      else debeBuscar = true;
    }
    if (metodo) { this.filtroMetodo = metodo; debeBuscar = true; }
    if (debeBuscar) this.buscar();
  }

  verDetalle(r: LogItem): void {
    this.detalleCodigo = r.codigo;
    this.detalleFecha = r.fechaTxt || '';
  }

  cerrarDetalle(): void {
    this.detalleCodigo = null;
  }

  etiquetaEstado(e: LogItem['estado']): string {
    const textos: Record<LogItem['estado'], string> = {
      exito: 'Exitosa', error: 'Con error', aviso: 'Con aviso', inicio: 'Inicio', paso: 'Paso interno', info: 'Informativo'
    };
    return textos[e] ?? e;
  }

  iconoEstado(e: LogItem['estado']): string {
    return e === 'exito' ? '✓' : e === 'error' ? '✕' : e === 'aviso' ? '!' : e === 'inicio' ? '▶' : '·';
  }

  cambiarVista(vista: VistaLogs): void {
    this.vista = vista;
  }

  /** Abre la validación de carga de productos con el documento de la última búsqueda. */
  verCargaProductos(): void {
    const documento = this.filtroDocumento.trim();
    if (!documento) return;
    this.documentoCarga = documento;
    this.vista = 'carga';
  }

  /** Abre la vista de operaciones agrupadas con el documento de la última búsqueda. */
  verOperacionesDelCliente(): void {
    const documento = this.filtroDocumento.trim();
    if (!documento) return;
    this.documentoOperaciones = documento;
    this.vista = 'operaciones';
  }

  equiposAbiertos = false;
  alternarEquipos(): void { this.equiposAbiertos = !this.equiposAbiertos; }

  etiquetaPlataforma(p: string): string { return p === 'iOS' ? 'iPhone' : p === 'Android' ? 'Android' : 'Otro'; }

  /** Abre el diagrama de recorrido con el documento de la última búsqueda. */
  verRecorridoDelCliente(): void {
    const documento = this.filtroDocumento.trim();
    if (!documento) return;
    this.documentoRecorrido = documento;
    this.vista = 'cliente';
  }

  ngOnDestroy(): void {
    this.suscripcionVersiones?.unsubscribe();
    if (this.temporizadorCopiado) clearTimeout(this.temporizadorCopiado);
    this.suscripcionBusqueda?.unsubscribe();
    this.suscripcionCatalogo?.unsubscribe();
  }

  private cargarCatalogo(): void {
    this.suscripcionCatalogo = this.http.get<CatalogoLogsResponse>(`${this.apiUrl}/logs/catalogo`).subscribe({
      next: (data) => {
        this.catalogoServicios = data.servicios || [];
        this.metodosExcluidosPorDefecto = data.metodosExcluidosPorDefecto || [];
      },
      error: (err) => {
        // No es crítico: el select de "Servicio" queda vacío pero el resto
        // de filtros (documento, texto libre, etc.) siguen funcionando.
        console.error('No se pudo cargar el catálogo de servicios:', err);
      }
    });
  }

  // --- Rango de fechas ---

  cambiarRango(dias: number): void {
    this.modoRango = 'preset';
    this.mostrandoSelectorFechas = false;
    this.errorRangoPersonalizado = null;
    this.diasSeleccionados = dias;
  }

  abrirSelectorFechas(): void {
    if (!this.fechaInicioInput || !this.fechaFinInput) {
      const hoy = new Date();
      const hace7Dias = new Date(hoy.getTime() - 6 * 24 * 60 * 60 * 1000);
      this.fechaFinInput = this.aFechaInput(hoy);
      this.fechaInicioInput = this.aFechaInput(hace7Dias);
    }
    this.errorRangoPersonalizado = null;
    this.mostrandoSelectorFechas = true;
  }

  cancelarSelectorFechas(): void {
    this.mostrandoSelectorFechas = false;
    this.errorRangoPersonalizado = null;
  }

  aplicarRangoPersonalizado(): void {
    this.errorRangoPersonalizado = null;

    if (!this.fechaInicioInput || !this.fechaFinInput) {
      this.errorRangoPersonalizado = 'Selecciona la fecha inicial y la fecha final.';
      return;
    }
    if (this.fechaInicioInput > this.fechaFinInput) {
      this.errorRangoPersonalizado = 'La fecha inicial debe ser anterior o igual a la fecha final.';
      return;
    }

    const desde = new Date(`${this.fechaInicioInput}T00:00:00`);
    const hasta = new Date(`${this.fechaFinInput}T00:00:00`);
    const diasSolicitados = Math.round((hasta.getTime() - desde.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (diasSolicitados > this.rangoDiasMaximo) {
      this.errorRangoPersonalizado = `El rango no puede superar ${this.rangoDiasMaximo} días.`;
      return;
    }

    this.modoRango = 'personalizado';
    this.fechaInicioAplicada = this.fechaInicioInput;
    this.fechaFinAplicada = this.fechaFinInput;
    this.mostrandoSelectorFechas = false;
  }

  private aFechaInput(fecha: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())}`;
  }

  // --- Búsqueda ---

  get hayFiltrosEnFormulario(): boolean {
    return !!(
      this.filtroDocumento || this.filtroMetodo || this.filtroFuncionalidad ||
      this.filtroTipo || this.filtroProceso || this.filtroNodo || this.filtroTexto ||
      this.filtroSoloErrores || this.filtroIncluirLogout
    );
  }

  limpiarFiltros(): void {
    this.filtroDocumento = '';
    this.filtroMetodo = '';
    this.filtroFuncionalidad = '';
    this.filtroTipo = '';
    this.filtroProceso = '';
    this.filtroNodo = '';
    this.filtroTexto = '';
    this.filtroSoloErrores = false;
    this.filtroIncluirLogout = false;
  }

  private construirParams(offset: number): HttpParams {
    let params = new HttpParams();
    if (this.modoRango === 'personalizado' && this.fechaInicioAplicada && this.fechaFinAplicada) {
      params = params.set('fechaInicio', this.fechaInicioAplicada).set('fechaFin', this.fechaFinAplicada);
    } else {
      params = params.set('dias', this.diasSeleccionados);
    }
    if (this.filtroDocumento.trim()) params = params.set('documento', this.filtroDocumento.trim());
    if (this.filtroMetodo) params = params.set('metodo', this.filtroMetodo);
    if (this.filtroFuncionalidad.trim()) params = params.set('funcionalidad', this.filtroFuncionalidad.trim());
    if (this.filtroTipo.trim()) params = params.set('tipo', this.filtroTipo.trim());
    if (this.filtroProceso.trim()) params = params.set('proceso', this.filtroProceso.trim());
    if (this.filtroNodo) params = params.set('nodo', this.filtroNodo);
    if (this.filtroTexto.trim()) params = params.set('texto', this.filtroTexto.trim());
    if (this.filtroSoloErrores) params = params.set('soloErrores', 'true');
    if (this.filtroIncluirLogout) params = params.set('incluirLogout', 'true');
    params = params.set('limit', this.limit).set('offset', offset);
    return params;
  }

  private etiquetaServicio(metodo: string): string {
    const encontrado = this.catalogoServicios.find((s) => s.metodo === metodo);
    return encontrado ? encontrado.etiqueta : metodo;
  }

  private construirChipsFiltros(): { etiqueta: string; valor: string }[] {
    const chips: { etiqueta: string; valor: string }[] = [];
    if (this.filtroDocumento.trim()) chips.push({ etiqueta: 'Documento (CC)', valor: this.filtroDocumento.trim() });
    if (this.filtroMetodo) chips.push({ etiqueta: 'Servicio', valor: this.etiquetaServicio(this.filtroMetodo) });
    if (this.filtroFuncionalidad.trim()) chips.push({ etiqueta: 'Funcionalidad', valor: this.filtroFuncionalidad.trim() });
    if (this.filtroTipo.trim()) chips.push({ etiqueta: 'Tipo', valor: this.filtroTipo.trim() });
    if (this.filtroProceso.trim()) chips.push({ etiqueta: 'Proceso', valor: this.filtroProceso.trim() });
    if (this.filtroNodo) chips.push({ etiqueta: 'Nodo', valor: this.filtroNodo });
    if (this.filtroTexto.trim()) chips.push({ etiqueta: 'Texto', valor: this.filtroTexto.trim() });
    if (this.filtroSoloErrores) chips.push({ etiqueta: 'Solo errores', valor: 'Sí' });
    if (this.filtroIncluirLogout) chips.push({ etiqueta: 'Incluye cierre de sesión', valor: 'Sí' });
    return chips;
  }

  buscar(): void {
    this.suscripcionBusqueda?.unsubscribe();
    this.cargando = true;
    this.error = null;
    this.avisoExportacion = null;
    this.offset = 0;
    this.filtrosAplicados = this.construirChipsFiltros();

    const params = this.construirParams(0);
    this.suscripcionBusqueda = this.http.get<LogsResponse>(`${this.apiUrl}/logs`, { params }).subscribe({
      next: (data) => this.procesarRespuesta(data),
      error: (err) => this.procesarError(err)
    });
    this.cargarVersiones();
  }

  /** Cambia el tamaño de página y repite la búsqueda desde la primera. */
  cambiarTamanoPagina(valor: number | string): void {
    this.limit = Number(valor) || 25;
    this.buscar();
  }

  /** Línea de tiempo de versiones del cliente en TODA la consulta (no solo la página visible). */
  private cargarVersiones(): void {
    this.suscripcionVersiones?.unsubscribe();
    this.versiones = null;
    this.errorVersiones = null;
    this.versionesAbiertas = false;
    this.equiposAbiertos = false;
    this.muestraSesionAbierta = false;
    this.cambioReciente = false;
    this.ultimoCambio = null;
    this.lineaVersiones = [];
    this.documentoAplicado = this.filtroDocumento.trim();
    if (!this.documentoAplicado) { this.cargandoVersiones = false; return; }

    let params = new HttpParams().set('documento', this.documentoAplicado);
    if (this.modoRango === 'personalizado' && this.fechaInicioAplicada && this.fechaFinAplicada) {
      params = params.set('fechaInicio', this.fechaInicioAplicada).set('fechaFin', this.fechaFinAplicada);
    } else {
      params = params.set('dias', this.diasSeleccionados);
    }
    this.cargandoVersiones = true;
    this.suscripcionVersiones = this.http.get<VersionesResponse>(`${this.apiUrl}/logs/versiones`, { params }).subscribe({
      next: (data) => {
        this.versiones = data;
        this.cargandoVersiones = false;
        this.lineaVersiones = [...(data.versiones || [])].reverse();
        const ultimo = data.cambios && data.cambios.length ? data.cambios[data.cambios.length - 1] : null;
        this.ultimoCambio = ultimo;
        if (ultimo) {
          const t = new Date(ultimo.fecha.replace(' ', 'T')).getTime();
          this.cambioReciente = Number.isFinite(t) && Date.now() - t < 14 * 24 * 60 * 60 * 1000;
        }
        this.marcarVersionesAnteriores();
      },
      error: (err) => {
        this.errorVersiones = err?.error?.error || 'No se pudo consultar la versión de la app.';
        this.cargandoVersiones = false;
      }
    });
  }

  alternarVersiones(): void { this.versionesAbiertas = !this.versionesAbiertas; }
  alternarMuestraSesion(): void { this.muestraSesionAbierta = !this.muestraSesionAbierta; }

  /** Última versión conocida del cliente: la de toda la consulta o, si no hay, la de la página. */
  get versionActual(): string | null {
    return this.versiones?.actual ?? null;
  }

  private marcarVersionesAnteriores(): void {
    const actual = this.versionActual;
    for (const f of this.filasVista) f.versionAnterior = !!(actual && f.r.version && f.r.version !== actual);
  }

  // --- Lectura de la tabla ---

  alternarDensidad(): void {
    this.densidad = this.densidad === 'comoda' ? 'compacta' : 'comoda';
    try { localStorage.setItem('axis.logs.densidad', this.densidad); } catch { /* sin almacenamiento */ }
  }

  copiar(texto: string | null | undefined, evento?: Event): void {
    evento?.stopPropagation();
    if (!texto) return;
    const listo = () => {
      this.copiado = texto;
      if (this.temporizadorCopiado) clearTimeout(this.temporizadorCopiado);
      this.temporizadorCopiado = setTimeout(() => { this.copiado = null; }, 1400);
    };
    try {
      navigator.clipboard.writeText(texto).then(listo, () => this.copiarRespaldo(texto, listo));
    } catch {
      this.copiarRespaldo(texto, listo);
    }
  }

  private copiarRespaldo(texto: string, listo: () => void): void {
    const area = document.createElement('textarea');
    area.value = texto;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); listo(); } catch { /* sin permiso */ }
    area.remove();
  }

  /** Filtra por el cliente de una fila y vuelve a buscar. */
  filtrarPorCliente(documento: string | null, evento: Event): void {
    evento.stopPropagation();
    if (!documento) return;
    this.filtroDocumento = documento;
    this.buscar();
  }

  /** Filtra por el servicio de una fila y vuelve a buscar. */
  filtrarPorServicio(metodo: string, evento: Event): void {
    evento.stopPropagation();
    this.filtroMetodo = metodo;
    this.buscar();
  }

  /** Filtra por el nodo de una fila y vuelve a buscar. */
  filtrarPorNodo(nodo: number | null, evento: Event): void {
    evento.stopPropagation();
    if (!nodo) return;
    this.filtroNodo = String(nodo);
    this.buscar();
  }

  soloErroresRapido(): void {
    this.filtroSoloErrores = !this.filtroSoloErrores;
    this.buscar();
  }

  textoDia(fechaTxt: string): string {
    const [y, m, d] = fechaTxt.slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return fechaTxt.slice(0, 10);
    const t = new Date(y, m - 1, d).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /** Prepara las filas de la página: separadores de día, marcador de cambio de versión y totales. */
  private prepararFilas(): void {
    const filas: FilaVista[] = [];
    const resumen = { exito: 0, error: 0, aviso: 0, otros: 0 };
    const versionesPagina = new Set<string>();
    let diaActual = '';
    let ultimaVersion: string | null = null;
    let primeraDelDia: FilaVista | null = null;
    for (const r of this.resultados) {
      const fecha = r.fechaTxt || '';
      const dia = fecha.slice(0, 10);
      const fila: FilaVista = { r, hora: fecha.slice(11) || '', dia: null, diaTotal: 0, cambioVersion: null, versionAnterior: false };
      if (dia && dia !== diaActual) {
        diaActual = dia;
        fila.dia = this.textoDia(fecha);
        primeraDelDia = fila;
      }
      if (primeraDelDia) primeraDelDia.diaTotal++;
      if (r.version) {
        versionesPagina.add(r.version);
        if (ultimaVersion && ultimaVersion !== r.version) fila.cambioVersion = { de: r.version, a: ultimaVersion };
        ultimaVersion = r.version;
      }
      if (r.estado === 'exito') resumen.exito++;
      else if (r.estado === 'error') resumen.error++;
      else if (r.estado === 'aviso') resumen.aviso++;
      else resumen.otros++;
      filas.push(fila);
    }
    this.filasVista = filas;
    this.resumenPagina = resumen;
    this.versionesEnPagina = [...versionesPagina];
    this.marcarVersionesAnteriores();
  }

  private procesarRespuesta(data: LogsResponse): void {
    this.resultados = data.resultados || [];
    this.prepararFilas();
    this.total = data.total || 0;
    this.offset = data.offset || 0;
    this.fechaInicioResultado = data.fechaInicio;
    this.fechaFinResultado = data.fechaFin;
    this.buscoAlMenosUnaVez = true;
    this.cargando = false;
  }

  private procesarError(err: any): void {
    console.error('Error buscando logs de App Móvil:', err);
    this.error = err?.error?.error || 'No se pudo completar la búsqueda. Intenta con un rango de fechas más corto o filtros más específicos.';
    this.resultados = [];
    this.filasVista = [];
    this.total = 0;
    this.cargando = false;
    this.buscoAlMenosUnaVez = true;
  }

  siguientePagina(): void {
    if (this.offset + this.limit >= this.total) return;
    this.cargarPagina(this.offset + this.limit);
  }

  anteriorPagina(): void {
    if (this.offset === 0) return;
    this.cargarPagina(Math.max(0, this.offset - this.limit));
  }

  private cargarPagina(nuevoOffset: number): void {
    this.suscripcionBusqueda?.unsubscribe();
    this.cargando = true;
    this.error = null;
    const params = this.construirParams(nuevoOffset);
    this.suscripcionBusqueda = this.http.get<LogsResponse>(`${this.apiUrl}/logs`, { params }).subscribe({
      next: (data) => this.procesarRespuesta(data),
      error: (err) => this.procesarError(err)
    });
  }

  get paginaActual(): number {
    return Math.floor(this.offset / this.limit) + 1;
  }

  get totalPaginas(): number {
    return Math.max(1, Math.ceil(this.total / this.limit));
  }

  // --- Exportación a CSV ---

  exportar(): void {
    if (this.exportando) return;
    this.exportando = true;
    this.avisoExportacion = null;

    const params = this.construirParams(0);
    this.http.get(`${this.apiUrl}/logs/exportar`, {
      params,
      responseType: 'blob',
      observe: 'response'
    }).subscribe({
      next: (resp) => {
        const blob = resp.body;
        if (!blob) {
          this.avisoExportacion = 'No se pudo generar el archivo de exportación.';
          this.exportando = false;
          return;
        }

        const disposicion = resp.headers.get('Content-Disposition') || '';
        const coincidencia = disposicion.match(/filename="?([^";]+)"?/);
        const nombreArchivo = coincidencia ? coincidencia[1] : 'logs_app_movil.csv';
        const truncado = resp.headers.get('X-Exportacion-Truncada') === 'true';
        const totalFilas = resp.headers.get('X-Exportacion-Total-Filas');

        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = nombreArchivo;
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        URL.revokeObjectURL(url);

        this.avisoExportacion = truncado
          ? `El archivo incluye las ${totalFilas} filas más recientes (se alcanzó el límite de exportación). Ajusta los filtros o el rango de fechas para acotar el resultado.`
          : null;
        this.exportando = false;
      },
      error: (err) => {
        console.error('Error exportando logs de App Móvil:', err);
        this.avisoExportacion = 'No se pudo generar el archivo de exportación.';
        this.exportando = false;
      }
    });
  }
}
