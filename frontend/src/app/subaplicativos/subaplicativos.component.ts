import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth.service';
import { SelectorBuscableComponent, OpcionSelector } from '../shared/selector-buscable/selector-buscable.component';
import {
  SubaplicativoService,
  Subaplicativo,
  SubaplicativoGuardar,
  ServidorOpcion,
  AplicacionNegocioRef,
  BusServicio,
  ServicioBusOpcion,
} from '../core/services/subaplicativo.service';

// Modelo del formulario: todo como texto/números editables; al guardar los
// vacíos viajan como null.
interface FormSub {
  id?: number;
  servidor_id: number | null;
  nombre: string;
  tipo: string;
  puerto: number | null;
  aplicaciones_negocio_ids: number[];
  plataforma: string;
  estado: string;
  criticidad: string;
  propietario: string;
  dev_responsable: string;
  fecha_ultimo_despliegue: string;
  responsable_ultimo_despliegue: string;
  version_imagen: string;
  repositorio_url: string;
  pipeline_url: string;
  url_salud: string;
  info_seguridad: string;
  certificado_id: number | null;
  descripcion_uso: string;
  dependencias: string;
  puntos_integracion: string;
  comandos: string;
  configuracion: string;
}

interface Filtros {
  busqueda: string;
  negocio: string;      // '' = todas, 'SIN' = sin aplicación de negocio, o el id
  servidor: string;
  tipo: string;
  plataforma: string;
  criticidad: string;
  ambiente: string;
  estado: string;
  ficha: string;        // '' | 'pendiente' | 'completa'
}

@Component({
  selector: 'app-subaplicativos',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectorBuscableComponent],
  templateUrl: './subaplicativos.component.html',
  styleUrls: ['../servidores/servidores.component.scss', './subaplicativos.component.scss'],
})
export class SubaplicativosComponent implements OnInit, OnChanges {
  // Filtro inicial por servidor (cuando se llega desde la pestaña Servidores)
  @Input() servidorId: number | null = null;
  // Abre directamente la ficha de este sub-aplicativo
  @Input() abrirId: number | null = null;
  @Output() cambioDatos = new EventEmitter<void>();

  puedeEditar = false;
  cargando = true;
  errorCarga = '';

  subs: Subaplicativo[] = [];
  filtrados: Subaplicativo[] = [];
  pagina: Subaplicativo[] = [];

  filtros: Filtros = this.filtrosVacios();
  orden: { col: string; dir: 1 | -1 } = { col: 'nombre', dir: 1 };
  paginaActual = 1;
  readonly tamanoPagina = 50;
  totalPaginas = 1;

  // Opciones de los filtros (se calculan al cargar)
  opcionesServidor: { id: number; hostname: string }[] = [];
  opcionesNegocio: AplicacionNegocioRef[] = [];
  opcionesPlataforma: string[] = [];
  opcionesAmbiente: string[] = [];

  // Indicadores
  kpi = { total: 0, sinNegocio: 0, sinFicha: 0, criticos: 0 };

  // Catálogos
  servidores: ServidorOpcion[] = [];
  certificados: { id: number; nombre_comun: string; entidad_emisora?: string; fecha_fin?: string }[] = [];
  personasOpciones: OpcionSelector[] = [];
  servidoresBd: OpcionSelector[] = [];
  opcionesServidorSelector: OpcionSelector[] = [];

  readonly tipos: { valor: string; etiqueta: string }[] = [
    { valor: 'ms', etiqueta: 'Microservicio (MS)' },
    { valor: 'api', etiqueta: 'API' },
    { valor: 'gateway', etiqueta: 'Gateway' },
    { valor: 'log', etiqueta: 'Logs' },
    { valor: 'db', etiqueta: 'Base de datos' },
    { valor: 'job', etiqueta: 'Job / Batch' },
    { valor: 'kafka', etiqueta: 'Kafka' },
    { valor: 'suscriptor', etiqueta: 'Suscriptor' },
    { valor: 'orquestador', etiqueta: 'Orquestador' },
    { valor: 'doc', etiqueta: 'Documentos' },
    { valor: 'balanceador', etiqueta: 'Balanceador (LB)' },
    { valor: 'otro', etiqueta: 'Otro' },
  ];
  readonly plataformas = ['Docker', 'Apache', 'IIS', 'Nginx', 'Tomcat', 'Node.js', 'Kafka', 'Otro'];
  readonly estados = ['Activo', 'Inactivo', 'En mantenimiento', 'Deprecado'];
  readonly criticidades = ['Alta', 'Media', 'Baja'];
  readonly motoresBd = ['MySQL', 'SQL Server', 'Oracle', 'PostgreSQL', 'MongoDB', 'Otro'];

  private readonly coloresTipo: Record<string, { fg: string; bg: string }> = {
    ms: { fg: '#3f6212', bg: '#ecfccb' },
    api: { fg: '#0369a1', bg: '#e0f2fe' },
    gateway: { fg: '#c2410c', bg: '#ffedd5' },
    log: { fg: '#b91c1c', bg: '#fee2e2' },
    db: { fg: '#0e7490', bg: '#cffafe' },
    job: { fg: '#4338ca', bg: '#e0e7ff' },
    kafka: { fg: '#7e22ce', bg: '#f3e8ff' },
    suscriptor: { fg: '#15803d', bg: '#dcfce7' },
    orquestador: { fg: '#b45309', bg: '#fef3c7' },
    doc: { fg: '#be185d', bg: '#fce7f3' },
    balanceador: { fg: '#be123c', bg: '#ffe4e6' },
    otro: { fg: '#475569', bg: '#f1f5f9' },
  };

  // Ficha de detalle (solo lectura)
  detalle: Subaplicativo | null = null;
  cargandoDetalle = false;

  // Crear / editar
  mostrarForm = false;
  modoEdicion = false;
  form: FormSub = this.formVacio();
  guardando = false;
  errorForm = '';
  avisoForm = '';
  volverAlDetalle = false;
  fichaEdicion: Subaplicativo | null = null; // relaciones del sub-aplicativo en edición

  // Paneles de relaciones (modo edición)
  nuevaIntegracion: { tipo: 'sub' | 'servidor'; servidorFiltro: number | null; destinoCompId: number | null; destinoServidorId: number | null; descripcion: string } =
    { tipo: 'sub', servidorFiltro: null, destinoCompId: null, destinoServidorId: null, descripcion: '' };
  nuevaConexionBd = this.conexionBdVacia();
  nuevaIntegracionServicio: { bus: BusServicio; servicioId: number | null; descripcion: string } = { bus: 'ACE', servicioId: null, descripcion: '' };
  /** Servicios del inventario de Servicios (se cargan una vez). */
  serviciosCatalogo: ServicioBusOpcion[] = [];
  cargandoServicios = false;
  errorServicios = '';
  /** Opciones del selector según el bus elegido (campo, no getter: el selector necesita la misma referencia). */
  opcionesServicio: OpcionSelector[] = [];
  readonly etiquetaBus: Record<BusServicio, string> = { ACE: 'BUS ACE 12', BUS10: 'BUS 10' };
  errorRelacion = '';

  // Visor de código
  codigoVisualizado: { titulo: string; contenido: string } | null = null;
  copiadoOk = false;

  constructor(private api: SubaplicativoService, private auth: AuthService) {}

  ngOnInit(): void {
    this.puedeEditar = this.auth.puedeEditar('SERVIDORES');

    if (this.servidorId) this.filtros.servidor = String(this.servidorId);
    this.cargarCatalogos();
    this.cargar(() => {
      if (this.abrirId) this.verFicha(this.abrirId);
    });
  }

  ngOnChanges(cambios: SimpleChanges): void {
    if (cambios['servidorId'] && !cambios['servidorId'].firstChange) {
      this.filtros.servidor = this.servidorId ? String(this.servidorId) : '';
      this.aplicarFiltros();
    }
    if (cambios['abrirId'] && !cambios['abrirId'].firstChange && this.abrirId) {
      this.verFicha(this.abrirId);
    }
  }

  // ------------------------------------------
  // Carga
  // ------------------------------------------
  cargar(alTerminar?: () => void): void {
    this.cargando = true;
    this.errorCarga = '';
    this.api.listar().subscribe({
      next: (data) => {
        this.subs = data;
        this.prepararOpcionesFiltro();
        this.aplicarFiltros();
        this.cargando = false;
        if (alTerminar) alTerminar();
      },
      error: (err) => {
        console.error('Error cargando sub-aplicativos:', err);
        this.errorCarga = err.error?.error || 'No se pudo cargar el inventario de sub-aplicativos.';
        this.cargando = false;
      },
    });
  }

  cargarCatalogos(): void {
    this.api.listarServidores().subscribe({
      next: (d) => {
        this.servidores = d;
        this.opcionesServidorSelector = d.map((s) => ({ id: s.id, nombre: s.hostname, subtitulo: [s.ip, s.ambiente].filter(Boolean).join(' · ') }));
      },
      error: (e) => console.error('Error cargando servidores:', e),
    });
    this.cargandoServicios = true;
    this.api.serviciosBus().subscribe({
      next: (d) => { this.serviciosCatalogo = d; this.cargandoServicios = false; this.recalcularOpcionesServicio(); },
      error: (e) => {
        console.error('Error cargando servicios:', e);
        this.cargandoServicios = false;
        this.errorServicios = e.error?.error || 'No se pudo cargar la lista de servicios.';
      },
    });
    this.api.aplicacionesNegocio().subscribe({
      next: (d) => (this.opcionesNegocio = d),
      error: (e) => console.error('Error cargando aplicaciones de negocio:', e),
    });
    this.api.certificados().subscribe({
      next: (d) => (this.certificados = d),
      error: (e) => console.error('Error cargando certificados:', e),
    });
    this.api.personas().subscribe({
      next: (d) => (this.personasOpciones = d.map((p) => ({ id: p.nombre, nombre: p.nombre }))),
      error: (e) => console.error('Error cargando personas:', e),
    });
    this.api.servidoresBd().subscribe({
      next: (d) => (this.servidoresBd = d.map((s) => ({ id: s.id, nombre: s.nombre, subtitulo: s.subtitulo }))),
      error: (e) => console.error('Error cargando servidores de BD:', e),
    });
  }

  onAgregarPersona(nombre: string): void {
    if (this.personasOpciones.some((p) => String(p.id).toLowerCase() === nombre.toLowerCase())) return;
    this.api.agregarPersona(nombre).subscribe({
      next: (p) => {
        this.personasOpciones = [...this.personasOpciones, { id: p.nombre, nombre: p.nombre }]
          .sort((a, b) => a.nombre.localeCompare(b.nombre));
      },
      error: (e) => console.error('Error agregando persona:', e),
    });
  }

  private prepararOpcionesFiltro(): void {
    const srv = new Map<number, string>();
    const negocios = new Map<number, string>();
    const plataformas = new Set<string>();
    const ambientes = new Set<string>();
    for (const s of this.subs) {
      srv.set(s.servidor_id, s.servidor_hostname);
      for (const n of s.aplicaciones_negocio) negocios.set(n.id, n.nombre);
      if (s.plataforma) plataformas.add(s.plataforma);
      if (s.ambiente) ambientes.add(s.ambiente);
    }
    this.opcionesServidor = [...srv.entries()].map(([id, hostname]) => ({ id, hostname }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
    if (!this.opcionesNegocio.length) {
      this.opcionesNegocio = [...negocios.entries()].map(([id, nombre]) => ({ id, nombre }));
    }
    this.opcionesPlataforma = [...plataformas].sort();
    this.opcionesAmbiente = [...ambientes].sort();
  }

  // ------------------------------------------
  // Filtros, orden y paginación
  // ------------------------------------------
  filtrosVacios(): Filtros {
    return { busqueda: '', negocio: '', servidor: '', tipo: '', plataforma: '', criticidad: '', ambiente: '', estado: '', ficha: '' };
  }

  get hayFiltros(): boolean {
    return JSON.stringify(this.filtros) !== JSON.stringify(this.filtrosVacios());
  }

  limpiarFiltros(): void {
    this.filtros = this.filtrosVacios();
    this.aplicarFiltros();
  }

  aplicarFiltros(): void {
    const f = this.filtros;
    const q = f.busqueda.toLowerCase().trim();

    let lista = this.subs.filter((s) => {
      if (f.servidor && String(s.servidor_id) !== f.servidor) return false;
      if (f.negocio === 'SIN' && s.aplicaciones_negocio.length) return false;
      if (f.negocio && f.negocio !== 'SIN' && !s.aplicaciones_negocio.some((n) => String(n.id) === f.negocio)) return false;
      if (f.tipo && this.tipoEfectivo(s) !== f.tipo) return false;
      if (f.plataforma && s.plataforma !== f.plataforma) return false;
      if (f.criticidad && (s.criticidad || '') !== f.criticidad) return false;
      if (f.ambiente && s.ambiente !== f.ambiente) return false;
      if (f.estado && (s.estado || 'Activo') !== f.estado) return false;
      if (f.ficha === 'pendiente' && s.aplicativo_id) return false;
      if (f.ficha === 'completa' && !s.aplicativo_id) return false;
      if (q) {
        const texto = [
          s.nombre, s.servidor_hostname, s.servidor_ip, s.puerto, s.plataforma, s.propietario,
          s.dev_responsable, s.version_imagen, s.descripcion_uso,
          s.aplicaciones_negocio.map((n) => n.nombre).join(' '),
        ].join(' ').toLowerCase();
        if (!texto.includes(q)) return false;
      }
      return true;
    });

    lista = this.ordenar(lista);
    this.filtrados = lista;
    this.calcularKpi();
    this.paginaActual = 1;
    this.actualizarPagina();
  }

  private calcularKpi(): void {
    this.kpi = {
      total: this.filtrados.length,
      sinNegocio: this.filtrados.filter((s) => !s.aplicaciones_negocio.length).length,
      sinFicha: this.filtrados.filter((s) => !s.aplicativo_id).length,
      criticos: this.filtrados.filter((s) => s.criticidad === 'Alta').length,
    };
  }

  cambiarOrden(col: string): void {
    this.orden = this.orden.col === col ? { col, dir: this.orden.dir === 1 ? -1 : 1 } : { col, dir: 1 };
    this.filtrados = this.ordenar([...this.filtrados]);
    this.paginaActual = 1;
    this.actualizarPagina();
  }

  flechaOrden(col: string): string {
    if (this.orden.col !== col) return '';
    return this.orden.dir === 1 ? '▲' : '▼';
  }

  private valorOrden(s: Subaplicativo, col: string): string | number {
    switch (col) {
      case 'nombre': return s.nombre.toLowerCase();
      case 'negocio': return (s.aplicaciones_negocio[0]?.nombre || 'zzz').toLowerCase();
      case 'servidor': return s.servidor_hostname.toLowerCase();
      case 'puerto': return s.puerto ?? 999999;
      case 'plataforma': return (s.plataforma || 'zzz').toLowerCase();
      case 'ambiente': return (s.ambiente || '').toLowerCase();
      case 'criticidad': return { Alta: 1, Media: 2, Baja: 3 }[s.criticidad || ''] ?? 4;
      case 'estado': return (s.estado || 'Activo').toLowerCase();
      case 'propietario': return (s.propietario || 'zzz').toLowerCase();
      case 'despliegue': return s.fecha_ultimo_despliegue || '';
      default: return s.nombre.toLowerCase();
    }
  }

  private ordenar(lista: Subaplicativo[]): Subaplicativo[] {
    const { col, dir } = this.orden;
    return lista.sort((a, b) => {
      const va = this.valorOrden(a, col);
      const vb = this.valorOrden(b, col);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return a.nombre.localeCompare(b.nombre);
    });
  }

  actualizarPagina(): void {
    this.totalPaginas = Math.max(1, Math.ceil(this.filtrados.length / this.tamanoPagina));
    if (this.paginaActual > this.totalPaginas) this.paginaActual = this.totalPaginas;
    const ini = (this.paginaActual - 1) * this.tamanoPagina;
    this.pagina = this.filtrados.slice(ini, ini + this.tamanoPagina);
  }

  irAPagina(n: number): void {
    this.paginaActual = n;
    this.actualizarPagina();
  }

  trackSub = (_: number, s: Subaplicativo) => s.id;

  // ------------------------------------------
  // Presentación
  // ------------------------------------------
  inferirTipo(nombre: string): string {
    const r = (nombre || '').toLowerCase();
    if (r.startsWith('ms_') || r.startsWith('ms-')) return 'ms';
    if (r.startsWith('gateway_') || r.startsWith('gateway-')) return 'gateway';
    if (r.includes('kafka')) return 'kafka';
    if (r.includes('suscriptor')) return 'suscriptor';
    if (r.includes('orquestador')) return 'orquestador';
    if (r.includes('gateway')) return 'gateway';
    if (r.includes('api') || r.includes('akaunt') || r.includes('nodo') || r.includes('mensajeria')) return 'api';
    if (r.includes('log')) return 'log';
    if (r.includes('imagen') || r.includes('doc') || r.includes('firm')) return 'doc';
    if (r.includes('balanceador') || r.includes(' lb') || r.startsWith('lb')) return 'balanceador';
    if (r.includes('job') || r.includes('batch') || r.includes('cron') || r.includes('scheduler')) return 'job';
    if (r.includes('db') || r.includes('base de datos') || r.includes('sql') || r.includes('mysql')) return 'db';
    if (r.startsWith('ms') || r.includes('microservicio')) return 'ms';
    return 'otro';
  }

  tipoEfectivo(s: { tipo: string | null; nombre: string }): string {
    return s.tipo || this.inferirTipo(s.nombre);
  }

  etiquetaTipo(valor: string): string {
    return this.tipos.find((t) => t.valor === valor)?.etiqueta || 'Otro';
  }

  colorTipo(valor: string): { fg: string; bg: string } {
    return this.coloresTipo[valor] || this.coloresTipo['otro'];
  }

  claseEstado(estado: string | null): string {
    const e = (estado || 'Activo').toLowerCase();
    if (e.startsWith('mant')) return 'mantenimiento';
    return e;
  }

  claseCriticidad(c: string | null): string {
    return 'criticidad-' + (c || 'nd').toLowerCase();
  }

  nombresNegocio(s: Subaplicativo): string {
    return s.aplicaciones_negocio.map((n) => n.nombre).join(', ');
  }

  // ------------------------------------------
  // Ficha de detalle
  // ------------------------------------------
  verFicha(id: number): void {
    this.cargandoDetalle = true;
    this.api.obtener(id).subscribe({
      next: (d) => {
        this.detalle = d;
        this.cargandoDetalle = false;
      },
      error: (err) => {
        console.error('Error obteniendo ficha:', err);
        this.cargandoDetalle = false;
        alert(err.error?.error || 'No se pudo abrir la ficha del sub-aplicativo.');
      },
    });
  }

  cerrarFicha(): void {
    this.detalle = null;
  }

  abrirVisorCodigo(titulo: string, contenido?: string | null): void {
    if (!contenido) return;
    this.codigoVisualizado = { titulo, contenido };
    this.copiadoOk = false;
  }

  cerrarVisorCodigo(): void {
    this.codigoVisualizado = null;
  }

  copiarCodigo(): void {
    if (!this.codigoVisualizado) return;
    navigator.clipboard.writeText(this.codigoVisualizado.contenido).then(() => {
      this.copiadoOk = true;
      setTimeout(() => (this.copiadoOk = false), 1500);
    });
  }

  // ------------------------------------------
  // Formulario crear / editar
  // ------------------------------------------
  formVacio(): FormSub {
    return {
      servidor_id: null, nombre: '', tipo: '', puerto: null, aplicaciones_negocio_ids: [],
      plataforma: 'Docker', estado: 'Activo', criticidad: 'Media',
      propietario: '', dev_responsable: '', fecha_ultimo_despliegue: '', responsable_ultimo_despliegue: '',
      version_imagen: '', repositorio_url: '', pipeline_url: '', url_salud: '',
      info_seguridad: 'Ninguna', certificado_id: null,
      descripcion_uso: '', dependencias: '', puntos_integracion: '', comandos: '', configuracion: '',
    };
  }

  conexionBdVacia() {
    return {
      servidor_bd_id: null as number | null,
      motor_bd: 'MySQL',
      puerto: null as number | null,
      nombre_base_datos: '',
      esquema: '',
      usuario_servicio: '',
    };
  }

  private reiniciarPaneles(): void {
    this.nuevaIntegracion = { tipo: 'sub', servidorFiltro: null, destinoCompId: null, destinoServidorId: null, descripcion: '' };
    this.nuevaConexionBd = this.conexionBdVacia();
    this.nuevaIntegracionServicio = { bus: 'ACE', servicioId: null, descripcion: '' };
    this.recalcularOpcionesServicio();
    this.errorRelacion = '';
  }

  abrirNuevo(): void {
    this.modoEdicion = false;
    this.form = this.formVacio();
    // Si hay un servidor filtrado, se propone como ubicación
    if (this.filtros.servidor) this.form.servidor_id = Number(this.filtros.servidor);
    this.fichaEdicion = null;
    this.errorForm = '';
    this.avisoForm = '';
    this.volverAlDetalle = false;
    this.reiniciarPaneles();
    this.recalcularOpcionesDestino();
    this.mostrarForm = true;
  }

  abrirEditar(s: Subaplicativo, desdeDetalle = false): void {
    this.modoEdicion = true;
    this.volverAlDetalle = desdeDetalle;
    this.errorForm = '';
    this.avisoForm = '';
    this.reiniciarPaneles();
    // Se pide la ficha completa para tener comandos/config, relaciones, etc.
    this.api.obtener(s.id).subscribe({
      next: (d) => {
        this.fichaEdicion = d;
        this.form = this.formDesde(d);
        this.detalle = null;
        this.recalcularOpcionesDestino();
        this.recalcularOpcionesServicio();
        this.mostrarForm = true;
      },
      error: (err) => alert(err.error?.error || 'No se pudo abrir el sub-aplicativo para editar.'),
    });
  }

  private formDesde(d: Subaplicativo): FormSub {
    const fecha = d.fecha_ultimo_despliegue ? new Date(d.fecha_ultimo_despliegue).toISOString().split('T')[0] : '';
    return {
      id: d.id,
      servidor_id: d.servidor_id,
      nombre: d.nombre,
      tipo: d.tipo || '',
      puerto: d.puerto,
      aplicaciones_negocio_ids: d.aplicaciones_negocio.map((n) => n.id),
      plataforma: d.plataforma || 'Docker',
      estado: d.estado || 'Activo',
      criticidad: d.criticidad || 'Media',
      propietario: d.propietario || '',
      dev_responsable: d.dev_responsable || '',
      fecha_ultimo_despliegue: fecha,
      responsable_ultimo_despliegue: d.responsable_ultimo_despliegue || '',
      version_imagen: d.version_imagen || '',
      repositorio_url: d.repositorio_url || '',
      pipeline_url: d.pipeline_url || '',
      url_salud: d.url_salud || '',
      info_seguridad: d.info_seguridad || 'Ninguna',
      certificado_id: d.certificado_id,
      descripcion_uso: d.descripcion_uso || '',
      dependencias: d.dependencias || '',
      puntos_integracion: d.puntos_integracion || '',
      comandos: d.comandos || '',
      configuracion: d.configuracion || '',
    };
  }

  cerrarForm(): void {
    const id = this.form.id;
    this.mostrarForm = false;
    this.fichaEdicion = null;
    // Los contadores de la tabla pueden haber cambiado desde los paneles
    this.cargar(() => {
      if (this.volverAlDetalle && id) this.verFicha(id);
    });
    this.cambioDatos.emit();
  }

  // --- Aplicaciones de negocio (varias) ---
  nombreNegocio(id: number): string {
    return this.opcionesNegocio.find((n) => n.id === id)?.nombre || `#${id}`;
  }

  get negociosDisponibles(): AplicacionNegocioRef[] {
    return this.opcionesNegocio.filter((n) => !this.form.aplicaciones_negocio_ids.includes(n.id));
  }

  agregarNegocio(valor: string | number | null): void {
    const id = Number(valor);
    if (!valor || !Number.isInteger(id) || id <= 0) return;
    if (!this.form.aplicaciones_negocio_ids.includes(id)) {
      this.form.aplicaciones_negocio_ids = [...this.form.aplicaciones_negocio_ids, id];
    }
  }

  quitarNegocio(id: number): void {
    this.form.aplicaciones_negocio_ids = this.form.aplicaciones_negocio_ids.filter((x) => x !== id);
  }

  private aTextoONull(v: string | null | undefined): string | null {
    const t = (v ?? '').toString().trim();
    return t === '' ? null : t;
  }

  private armarPayload(): SubaplicativoGuardar {
    const f = this.form;
    return {
      ...(f.id ? {} : { servidor_id: f.servidor_id as number }),
      nombre: f.nombre.trim(),
      tipo: this.aTextoONull(f.tipo),
      puerto: f.puerto === null || (f.puerto as any) === '' ? null : Number(f.puerto),
      aplicaciones_negocio_ids: f.aplicaciones_negocio_ids,
      plataforma: this.aTextoONull(f.plataforma),
      estado: this.aTextoONull(f.estado),
      criticidad: this.aTextoONull(f.criticidad),
      propietario: this.aTextoONull(f.propietario),
      dev_responsable: this.aTextoONull(f.dev_responsable),
      fecha_ultimo_despliegue: this.aTextoONull(f.fecha_ultimo_despliegue),
      responsable_ultimo_despliegue: this.aTextoONull(f.responsable_ultimo_despliegue),
      version_imagen: this.aTextoONull(f.version_imagen),
      repositorio_url: this.aTextoONull(f.repositorio_url),
      pipeline_url: this.aTextoONull(f.pipeline_url),
      url_salud: this.aTextoONull(f.url_salud),
      info_seguridad: this.aTextoONull(f.info_seguridad),
      certificado_id: f.info_seguridad === 'Certificado SSl' ? f.certificado_id : null,
      descripcion_uso: this.aTextoONull(f.descripcion_uso),
      dependencias: this.aTextoONull(f.dependencias),
      puntos_integracion: this.aTextoONull(f.puntos_integracion),
      comandos: f.comandos && f.comandos.trim() ? f.comandos : null,
      configuracion: f.configuracion && f.configuracion.trim() ? f.configuracion : null,
    };
  }

  private validarForm(): string {
    const f = this.form;
    if (!f.nombre.trim()) return 'El nombre del sub-aplicativo es obligatorio.';
    if (!f.id && !f.servidor_id) return 'Elige el servidor donde está desplegado.';
    if (f.puerto !== null && (f.puerto as any) !== '') {
      const n = Number(f.puerto);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return 'El puerto debe ser un número entre 1 y 65535.';
    }
    return '';
  }

  guardar(): void {
    if (this.guardando) return;
    this.errorForm = '';
    this.avisoForm = '';
    const problema = this.validarForm();
    if (problema) {
      this.errorForm = problema;
      return;
    }

    this.guardando = true;
    const payload = this.armarPayload();

    if (this.form.id) {
      this.api.actualizar(this.form.id, payload).subscribe({
        next: () => {
          this.guardando = false;
          this.cerrarForm();
        },
        error: (err) => {
          this.guardando = false;
          this.errorForm = err.error?.error || 'No se pudo guardar el sub-aplicativo.';
        },
      });
    } else {
      this.api.crear(payload).subscribe({
        next: (resp) => {
          this.guardando = false;
          // Se queda en el mismo formulario, ya en modo edición, para poder
          // registrar de una vez sus integraciones y conexiones a BD.
          this.form.id = resp.id;
          this.modoEdicion = true;
          this.recalcularOpcionesDestino();
          this.avisoForm = 'Sub-aplicativo creado. Ya puedes registrar sus integraciones (sub-aplicativos, servicios ACE / BUS 10) y conexiones a base de datos aquí mismo.';
          this.recargarRelaciones();
          this.cargar();
          this.cambioDatos.emit();
        },
        error: (err) => {
          this.guardando = false;
          this.errorForm = err.error?.error || 'No se pudo crear el sub-aplicativo.';
        },
      });
    }
  }

  eliminar(s: Subaplicativo, event?: Event): void {
    if (event) event.stopPropagation();
    const extra = s.total_integraciones || s.total_conexiones_bd
      ? `\n\nSe perderán también sus ${s.total_integraciones || 0} integración(es) y ${s.total_conexiones_bd || 0} conexión(es) a BD.`
      : '';
    if (!confirm(`¿Eliminar el sub-aplicativo "${s.nombre}" de ${s.servidor_hostname}?\n\nTambién se quita de sus aplicaciones de negocio.${extra}`)) return;
    this.api.eliminar(s.id).subscribe({
      next: () => {
        if (this.detalle?.id === s.id) this.detalle = null;
        this.cargar();
        this.cambioDatos.emit();
      },
      error: (err) => alert(err.error?.error || 'No se pudo eliminar el sub-aplicativo.'),
    });
  }

  // ------------------------------------------
  // Relaciones en modo edición
  // ------------------------------------------
  private recargarRelaciones(): void {
    if (!this.form.id) return;
    this.api.obtener(this.form.id).subscribe({
      next: (d) => { this.fichaEdicion = d; this.recalcularOpcionesServicio(); },
      error: (e) => console.error('Error recargando relaciones:', e),
    });
  }

  // Sub-aplicativos que se pueden elegir como destino de una integración
  // (opcionalmente acotados a un servidor), sin incluirse a sí mismo. Es un
  // campo (no un getter) para que el selector reciba siempre la misma
  // referencia mientras nada cambie.
  opcionesDestino: OpcionSelector[] = [];

  recalcularOpcionesDestino(): void {
    this.opcionesDestino = this.subs
      .filter((s) => s.id !== this.form.id)
      .filter((s) => !this.nuevaIntegracion.servidorFiltro || s.servidor_id === this.nuevaIntegracion.servidorFiltro)
      .map((s) => ({
        id: s.id,
        nombre: s.nombre,
        // El selector busca en nombre + subtítulo: así se encuentra por servidor, IP, puerto, tipo, ambiente o aplicación de negocio.
        subtitulo: [
          `${s.servidor_hostname}${s.servidor_ip ? ' (' + s.servidor_ip + ')' : ''}${s.puerto ? ' :' + s.puerto : ''}`,
          s.tipo,
          s.ambiente,
          (s.aplicaciones_negocio || []).map((a) => a.nombre).join(', '),
        ].filter(Boolean).join(' · '),
      }));
  }

  agregarIntegracion(): void {
    if (!this.form.id) return;
    this.errorRelacion = '';
    const n = this.nuevaIntegracion;
    const datos = n.tipo === 'sub'
      ? { destino_componente_id: n.destinoCompId, descripcion: n.descripcion }
      : { destino_servidor_id: n.destinoServidorId, descripcion: n.descripcion };
    if (n.tipo === 'sub' && !n.destinoCompId) { this.errorRelacion = 'Elige el sub-aplicativo con el que se integra.'; return; }
    if (n.tipo === 'servidor' && !n.destinoServidorId) { this.errorRelacion = 'Elige el servidor con el que se integra.'; return; }

    this.api.agregarIntegracion(this.form.id, datos).subscribe({
      next: () => {
        this.nuevaIntegracion = { tipo: n.tipo, servidorFiltro: n.servidorFiltro, destinoCompId: null, destinoServidorId: null, descripcion: '' };
        this.recargarRelaciones();
      },
      error: (err) => (this.errorRelacion = err.error?.error || 'No se pudo agregar la integración.'),
    });
  }

  quitarIntegracion(integracionId: number): void {
    if (!this.form.id) return;
    this.api.eliminarIntegracion(this.form.id, integracionId).subscribe({
      next: () => this.recargarRelaciones(),
      error: (err) => (this.errorRelacion = err.error?.error || 'No se pudo quitar la integración.'),
    });
  }

  // ---- Integraciones con servicios (ACE / BUS 10) ----
  /** Servicios del bus elegido, menos los que ya tiene registrados en ese bus. */
  recalcularOpcionesServicio(): void {
    const bus = this.nuevaIntegracionServicio.bus;
    const yaRegistrados = new Set(
      (this.fichaEdicion?.integraciones_servicios ?? []).filter((x) => x.bus === bus).map((x) => x.servicio_id)
    );
    this.opcionesServicio = this.serviciosCatalogo
      .filter((s) => (bus === 'BUS10' ? s.bus10 : s.ace) && !yaRegistrados.has(s.id))
      .map((s) => ({
        id: s.id,
        nombre: `${s.codigo ? s.codigo + ' · ' : ''}${s.nombre}`,
        subtitulo: `${s.tipo}${s.pod ? ' · ' + s.pod : ''}`,
      }));
  }

  cambiarBusServicio(bus: BusServicio): void {
    this.nuevaIntegracionServicio = { ...this.nuevaIntegracionServicio, bus, servicioId: null };
    this.recalcularOpcionesServicio();
  }

  agregarIntegracionServicio(): void {
    if (!this.form.id) return;
    this.errorRelacion = '';
    const n = this.nuevaIntegracionServicio;
    if (!n.servicioId) { this.errorRelacion = 'Elige el servicio con el que se integra.'; return; }
    this.api.agregarIntegracionServicio(this.form.id, { servicio_id: n.servicioId, bus: n.bus, descripcion: this.aTextoONull(n.descripcion) }).subscribe({
      next: () => {
        this.nuevaIntegracionServicio = { bus: n.bus, servicioId: null, descripcion: '' };
        this.recargarRelaciones();
      },
      error: (err) => (this.errorRelacion = err.error?.error || 'No se pudo agregar la integración con el servicio.'),
    });
  }

  quitarIntegracionServicio(integracionId: number): void {
    if (!this.form.id) return;
    this.api.eliminarIntegracionServicio(this.form.id, integracionId).subscribe({
      next: () => this.recargarRelaciones(),
      error: (err) => (this.errorRelacion = err.error?.error || 'No se pudo quitar la integración con el servicio.'),
    });
  }

  agregarConexionBd(): void {
    if (!this.form.id) return;
    this.errorRelacion = '';
    const c = this.nuevaConexionBd;
    if (!c.servidor_bd_id || !c.motor_bd || !c.nombre_base_datos.trim()) {
      this.errorRelacion = 'El servidor de BD, el motor y el nombre de la base de datos son obligatorios.';
      return;
    }
    this.api.agregarConexionBd(this.form.id, {
      servidor_bd_id: c.servidor_bd_id,
      motor_bd: c.motor_bd,
      nombre_base_datos: c.nombre_base_datos.trim(),
      esquema: this.aTextoONull(c.esquema),
      puerto: c.puerto || null,
      usuario_servicio: this.aTextoONull(c.usuario_servicio),
    }).subscribe({
      next: () => {
        this.nuevaConexionBd = this.conexionBdVacia();
        this.recargarRelaciones();
      },
      error: (err) => (this.errorRelacion = err.error?.error || 'No se pudo registrar la conexión a base de datos.'),
    });
  }

  quitarConexionBd(conexionId: number): void {
    if (!this.form.id) return;
    if (!confirm('¿Quitar esta integración a base de datos?')) return;
    this.api.eliminarConexionBd(this.form.id, conexionId).subscribe({
      next: () => this.recargarRelaciones(),
      error: (err) => (this.errorRelacion = err.error?.error || 'No se pudo quitar la conexión.'),
    });
  }
}
