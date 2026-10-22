import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { CatalogoUbicaciones } from '../../core/services/certificado.service';
import {
  CertificadoContenedoresService,
  EntornoEscaneado,
  EntornoPortainer,
  EstadoConciliacion,
  ConfiguracionContenedor,
  EstadoEscaneo,
  EstadoReferencia,
  EvidenciaCert,
  HallazgoCert,
  NoLegible,
  OpcionesEscaneo,
  ResultadoConciliacion,
  ResumenConciliacion,
  SinEvidencia,
  VigenciaCert,
} from '../../core/services/certificado-contenedores.service';
import { CertificadoAsistenteComponent, ModoAsistente, PrecargaCertificado } from './certificado-asistente.component';
import { GrupoCertificado, idDe } from './certificado-grupo';

type FiltroEstado = 'todos' | EstadoConciliacion;
type FiltroVigencia = 'todas' | VigenciaCert;
export type VistaHallazgos = 'hallazgos' | 'sinEvidencia' | 'noLegibles' | 'servidores' | 'configuracion';
type FiltroConfig = 'todos' | 'referencia' | 'sin_archivo' | 'protegido' | 'tls_sin_cert';

interface InfoEstado { etiqueta: string; clase: string; ayuda: string; }

const ESTADOS: Record<EstadoConciliacion, InfoEstado> = {
  conciliado: { etiqueta: 'Conciliado', clase: 'est-ok', ayuda: 'El certificado del contenedor es el mismo que está en el inventario y las fechas coinciden.' },
  fechas_distintas: { etiqueta: 'Fechas distintas', clase: 'est-aviso', ayuda: 'Es el mismo certificado, pero la fecha de vencimiento del inventario no coincide con la real.' },
  difiere: { etiqueta: 'Certificado distinto', clase: 'est-aviso', ayuda: 'En esa ubicación el inventario tiene otro certificado: probablemente se renovó y no se actualizó.' },
  ubicacion_nueva: { etiqueta: 'Ubicación nueva', clase: 'est-info', ayuda: 'El certificado está en el inventario, pero no registrado en este servidor.' },
  no_inventariado: { etiqueta: 'No inventariado', clase: 'est-alerta', ayuda: 'Este certificado no está en el inventario.' },
};

const VIGENCIA: Record<VigenciaCert, { etiqueta: string; clase: string }> = {
  vigente: { etiqueta: 'Vigente', clase: 'vig-vigente' },
  por_vencer: { etiqueta: 'Por vencer', clase: 'vig-por-vencer' },
  vencido: { etiqueta: 'Vencido', clase: 'vig-vencido' },
};

const ESTADO_REFERENCIA: Record<EstadoReferencia, { etiqueta: string; clase: string }> = {
  leido: { etiqueta: 'Leído', clase: 'est-ok' },
  protegido: { etiqueta: 'Protegido', clase: 'est-aviso' },
  sin_certificado: { etiqueta: 'Sin certificados', clase: 'est-info' },
  no_existe: { etiqueta: 'No existe en el contenedor', clase: 'est-alerta' },
  no_encontrado: { etiqueta: 'No encontrado', clase: 'est-alerta' },
  no_leido: { etiqueta: 'No se pudo comprobar', clase: 'est-aviso' },
};

@Component({
  selector: 'app-certificados-contenedores',
  standalone: true,
  imports: [CommonModule, FormsModule, CertificadoAsistenteComponent],
  templateUrl: './certificados-contenedores.component.html',
  styleUrl: './certificados-contenedores.component.scss',
})
export class CertificadosContenedoresComponent implements OnInit, OnDestroy {
  // Lo que ya tiene cargado la pantalla de Certificados (el asistente lo necesita).
  @Input() puedeEditar = false;
  @Input() grupos: GrupoCertificado[] = [];
  @Input() catalogo: CatalogoUbicaciones | null = null;
  // Avisa que se creó o cambió algo en el inventario para que la pantalla recargue su lista.
  @Output() inventarioCambio = new EventEmitter<void>();

  configurado = true;
  entornos: EntornoPortainer[] = [];
  estado: EstadoEscaneo = { estado: 'nunca', progreso: null };
  resultado: ResultadoConciliacion | null = null;
  cargandoResultado = false;
  error: string | null = null;
  lanzando = false;

  // Opciones del escaneo (las contraseñas viajan una sola vez y no se guardan en ningún lado).
  opciones: OpcionesEscaneo = { profundo: false, incluirDetenidos: false, sondeoTls: true, archivos: true, rutas: '', claves: '', entornoIds: [] };
  opcionesAbiertas = false;

  // Vista y filtros
  vista: VistaHallazgos = 'hallazgos';
  filtroEstado: FiltroEstado = 'todos';
  filtroVigencia: FiltroVigencia = 'todas';
  filtroServidor = '';
  busqueda = '';
  verAutoridades = false;
  paginaActual = 1;
  tamanoPagina = 25;
  opcionesTamanoPagina = [10, 25, 50, 100];
  filtrados: HallazgoCert[] = [];
  servidoresEnResultado: string[] = [];

  detalle: HallazgoCert | null = null;

  // Configuración (docker run)
  cfgFiltro: FiltroConfig = 'referencia';
  cfgBusqueda = '';
  cfgDetalle: ConfiguracionContenedor | null = null;
  cfgPaginaActual = 1;
  cfgTamano = 25;
  private cfgCache: { clave: string; lista: ConfiguracionContenedor[] } | null = null;

  // Asistente (crear / actualizar / agregar ubicación) con los datos ya precargados.
  asistenteAbierto = false;
  asistenteModo: ModoAsistente = 'nuevo';
  asistenteGrupo: GrupoCertificado | null = null;
  asistentePrecarga: PrecargaCertificado | null = null;
  avisoAccion: string | null = null;

  private temporizador: ReturnType<typeof setTimeout> | null = null;
  private destruido = false;

  constructor(private servicio: CertificadoContenedoresService) {}

  ngOnInit(): void {
    this.servicio.entornos().subscribe({
      next: (r) => { this.configurado = r.configurado; this.entornos = r.entornos; if (r.error) this.error = r.error; },
      error: () => { /* el escaneo avisará si Portainer no responde */ },
    });
    this.refrescarEstado();
    this.cargarResultado();
  }

  ngOnDestroy(): void {
    this.destruido = true;
    if (this.temporizador) clearTimeout(this.temporizador);
  }

  // ============================================================ escaneo
  get corriendo(): boolean { return this.estado.estado === 'corriendo'; }
  get resumen(): ResumenConciliacion | null { return this.resultado?.resumen ?? null; }
  get listaSinEvidencia(): SinEvidencia[] { return this.resultado?.sinEvidencia ?? []; }
  get listaNoLegibles(): NoLegible[] { return this.resultado?.noLegibles ?? []; }
  get listaConfiguraciones(): ConfiguracionContenedor[] { return this.resultado?.configuraciones ?? []; }
  get listaEntornos(): EntornoEscaneado[] { return this.resultado?.escaneo?.entornos ?? []; }

  get porcentaje(): number {
    const p = this.estado.progreso;
    if (!p) return 0;
    const total = Math.max(p.contenedoresTotal, 1);
    const base = p.entornosTotal ? (p.entornosHechos / p.entornosTotal) * 100 : 0;
    const fino = p.contenedoresTotal ? (p.contenedoresHechos / total) * 100 : 0;
    // Mientras se descubren los contenedores de los siguientes servidores el total crece: se muestra el mayor de los dos.
    return Math.min(99, Math.round(Math.max(base, fino)));
  }

  private refrescarEstado(): void {
    this.servicio.estado().subscribe({
      next: (e) => {
        const antes = this.estado.estado;
        this.estado = e;
        if (typeof e.configurado === 'boolean') this.configurado = e.configurado;
        if (e.estado === 'corriendo') this.programarSondeo();
        else if (antes === 'corriendo') this.cargarResultado(); // terminó mientras se miraba: se trae la conciliación
      },
      error: () => { if (this.corriendo) this.programarSondeo(); },
    });
  }

  private programarSondeo(): void {
    if (this.destruido) return;
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => this.refrescarEstado(), 1500);
  }

  escanear(): void {
    if (!this.puedeEditar || this.lanzando || this.corriendo) return;
    this.lanzando = true;
    this.error = null;
    this.servicio.escanear(this.opciones).subscribe({
      next: (e) => {
        this.lanzando = false;
        this.estado = e;
        this.opciones = { ...this.opciones, claves: '' }; // las contraseñas no se quedan en pantalla
        this.programarSondeo();
      },
      error: (err) => {
        this.lanzando = false;
        this.error = err?.error?.error || 'No se pudo iniciar el escaneo.';
      },
    });
  }

  cancelar(): void {
    if (!this.puedeEditar || !this.corriendo) return;
    this.servicio.cancelar().subscribe({ next: (e) => { this.estado = e; }, error: () => { /* se verá en el siguiente sondeo */ } });
  }

  cargarResultado(): void {
    this.cargandoResultado = true;
    this.servicio.resultado().subscribe({
      next: (r) => {
        this.cargandoResultado = false;
        this.resultado = r.disponible ? r : null;
        this.reconstruirFiltros();
      },
      error: (err) => {
        this.cargandoResultado = false;
        this.error = err?.error?.error || 'No se pudo calcular la conciliación.';
      },
    });
  }

  alternarEntorno(id: number): void {
    const ids = new Set(this.opciones.entornoIds);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    this.opciones = { ...this.opciones, entornoIds: [...ids] };
  }

  entornoMarcado(id: number): boolean { return this.opciones.entornoIds.includes(id); }

  get alcanceTexto(): string {
    const n = this.opciones.entornoIds.length;
    return n ? `${n} servidor${n > 1 ? 'es' : ''} elegido${n > 1 ? 's' : ''}` : 'Todos los servidores de Portainer';
  }

  // ============================================================ filtros
  private reconstruirFiltros(): void {
    const hs = this.resultado?.hallazgos || [];
    this.servidoresEnResultado = Array.from(new Set(hs.map((h) => this.nombreServidor(h)))).sort((a, b) => a.localeCompare(b));
    if (this.filtroServidor && !this.servidoresEnResultado.includes(this.filtroServidor)) this.filtroServidor = '';
    this.aplicarFiltros();
  }

  aplicarFiltros(): void {
    const termino = this.busqueda.toLowerCase().trim();
    let lista = (this.resultado?.hallazgos || []).filter((h) => this.verAutoridades || !h.certificado.esAutoridad);
    if (this.filtroEstado !== 'todos') lista = lista.filter((h) => h.estado === this.filtroEstado);
    if (this.filtroVigencia !== 'todas') lista = lista.filter((h) => h.vigencia === this.filtroVigencia);
    if (this.filtroServidor) lista = lista.filter((h) => this.nombreServidor(h) === this.filtroServidor);
    if (termino) {
      lista = lista.filter((h) => [
        h.certificado.nombreComun, h.certificado.emisor, h.certificado.serie, h.certificado.thumbprint, h.certificado.sha256,
        this.nombreServidor(h), h.servidor.ip, ...h.contenedores, ...h.certificado.san,
        ...h.evidencias.map((e) => `${e.ruta || ''} ${e.imagen} ${e.puerto || ''}`),
        h.inventario ? `${h.inventario.componente} ${h.inventario.hostname}` : '',
      ].join(' ').toLowerCase().includes(termino));
    }
    // Lo que requiere atención primero: sin inventariar, certificado distinto, fechas, y por fecha de vencimiento.
    const peso: Record<EstadoConciliacion, number> = { no_inventariado: 0, difiere: 1, fechas_distintas: 2, ubicacion_nueva: 3, conciliado: 4 };
    this.filtrados = [...lista].sort((a, b) => peso[a.estado] - peso[b.estado] || a.dias - b.dias);
    this.paginaActual = 1;
  }

  elegirEstado(e: FiltroEstado): void {
    this.vista = 'hallazgos';
    this.filtroEstado = this.filtroEstado === e ? 'todos' : e;
    this.aplicarFiltros();
  }

  elegirVigencia(v: FiltroVigencia): void {
    this.vista = 'hallazgos';
    this.filtroVigencia = this.filtroVigencia === v ? 'todas' : v;
    this.aplicarFiltros();
  }

  limpiarFiltros(): void {
    this.filtroEstado = 'todos';
    this.filtroVigencia = 'todas';
    this.filtroServidor = '';
    this.busqueda = '';
    this.aplicarFiltros();
  }

  get hayFiltros(): boolean {
    return this.filtroEstado !== 'todos' || this.filtroVigencia !== 'todas' || !!this.filtroServidor || !!this.busqueda.trim();
  }

  get totalPaginas(): number { return Math.max(1, Math.ceil(this.filtrados.length / this.tamanoPagina)); }
  get paginaValida(): number { return Math.min(Math.max(1, this.paginaActual), this.totalPaginas); }
  get paginaItems(): HallazgoCert[] {
    const ini = (this.paginaValida - 1) * this.tamanoPagina;
    return this.filtrados.slice(ini, ini + this.tamanoPagina);
  }
  get rangoDesde(): number { return this.filtrados.length ? (this.paginaValida - 1) * this.tamanoPagina + 1 : 0; }
  get rangoHasta(): number { return Math.min(this.paginaValida * this.tamanoPagina, this.filtrados.length); }
  irAPagina(n: number): void { this.paginaActual = Math.min(Math.max(1, n), this.totalPaginas); }

  // ============================================================ configuración (docker run)
  infoReferencia(e: EstadoReferencia): { etiqueta: string; clase: string } { return ESTADO_REFERENCIA[e]; }

  private cfgCumple(c: ConfiguracionContenedor, f: FiltroConfig): boolean {
    switch (f) {
      case 'referencia': return c.referencias.length > 0;
      case 'sin_archivo': return c.referencias.some((r) => r.estado === 'no_existe' || r.estado === 'no_encontrado' || r.estado === 'no_leido');
      case 'protegido': return c.referencias.some((r) => r.estado === 'protegido');
      case 'tls_sin_cert': return c.usaTls && c.certificados === 0;
      default: return true;
    }
  }

  cuentaConfig(f: FiltroConfig): number { return this.listaConfiguraciones.filter((c) => this.cfgCumple(c, f)).length; }

  get cfgFiltradas(): ConfiguracionContenedor[] {
    const clave = `${this.cfgFiltro}|${this.cfgBusqueda}|${this.resultado?.escaneo?.id}|${this.listaConfiguraciones.length}`;
    if (this.cfgCache && this.cfgCache.clave === clave) return this.cfgCache.lista;
    const t = this.cfgBusqueda.toLowerCase().trim();
    const lista = this.listaConfiguraciones.filter((c) => this.cfgCumple(c, this.cfgFiltro)
      && (!t || [c.contenedor, c.imagen, c.hostname, c.entornoNombre, c.stack, ...c.referencias.map((r) => `${r.ruta} ${r.origen}`)].join(' ').toLowerCase().includes(t)))
      .sort((a, b) => (a.hostname || a.entornoNombre).localeCompare(b.hostname || b.entornoNombre) || a.contenedor.localeCompare(b.contenedor));
    this.cfgCache = { clave, lista };
    return lista;
  }

  elegirFiltroConfig(f: FiltroConfig): void { this.cfgFiltro = f; this.cfgPaginaActual = 1; }
  buscarConfig(): void { this.cfgPaginaActual = 1; }
  get cfgTotalPaginas(): number { return Math.max(1, Math.ceil(this.cfgFiltradas.length / this.cfgTamano)); }
  get cfgPaginaValida(): number { return Math.min(Math.max(1, this.cfgPaginaActual), this.cfgTotalPaginas); }
  get cfgItems(): ConfiguracionContenedor[] {
    const ini = (this.cfgPaginaValida - 1) * this.cfgTamano;
    return this.cfgFiltradas.slice(ini, ini + this.cfgTamano);
  }
  get cfgRangoDesde(): number { return this.cfgFiltradas.length ? (this.cfgPaginaValida - 1) * this.cfgTamano + 1 : 0; }
  get cfgRangoHasta(): number { return Math.min(this.cfgPaginaValida * this.cfgTamano, this.cfgFiltradas.length); }
  cfgIrAPagina(n: number): void { this.cfgPaginaActual = Math.min(Math.max(1, n), this.cfgTotalPaginas); }
  abrirConfig(c: ConfiguracionContenedor): void { this.cfgDetalle = c; }
  cerrarConfig(): void { this.cfgDetalle = null; }

  nombreServidorCfg(c: ConfiguracionContenedor): string { return c.hostname || c.entornoNombre; }

  /** Resumen de una línea de las referencias de un contenedor (para la tabla). */
  resumenReferencias(c: ConfiguracionContenedor): { texto: string; clase: string }[] {
    const por = new Map<EstadoReferencia, number>();
    for (const r of c.referencias) por.set(r.estado, (por.get(r.estado) || 0) + 1);
    return [...por.entries()].map(([e, n]) => ({ texto: `${n} ${ESTADO_REFERENCIA[e].etiqueta.toLowerCase()}`, clase: ESTADO_REFERENCIA[e].clase }));
  }

  copiarComando(c: ConfiguracionContenedor): void {
    try { void navigator.clipboard.writeText(c.comando); } catch { /* sin portapapeles: se puede seleccionar el texto */ }
  }

  // ============================================================ presentación
  infoEstado(e: EstadoConciliacion): InfoEstado { return ESTADOS[e]; }
  infoVigencia(v: VigenciaCert): { etiqueta: string; clase: string } { return VIGENCIA[v]; }

  nombreServidor(h: HallazgoCert): string {
    return h.servidor.hostname || h.servidor.entornoNombre;
  }

  donde(h: HallazgoCert): { contenedores: string[]; extra: number; puertos: number[]; archivos: number } {
    const nombres = h.contenedores;
    return {
      contenedores: nombres.slice(0, 2),
      extra: Math.max(0, nombres.length - 2),
      puertos: h.puertos,
      archivos: h.evidencias.filter((e) => e.origen === 'archivo').length,
    };
  }

  textoEvidencia(e: EvidenciaCert): string {
    return e.origen === 'puerto'
      ? `Puerto TLS ${e.puerto} publicado por el contenedor`
      : `Archivo ${e.formato || ''} dentro del contenedor`.replace('  ', ' ');
  }

  etiquetaAccion(h: HallazgoCert): string {
    if (h.accion === 'crear') return 'Crear en inventario';
    if (h.accion === 'actualizar') return 'Actualizar inventario';
    if (h.accion === 'agregar_ubicacion') return 'Agregar ubicación';
    return '';
  }

  get ultimoEscaneoTexto(): string {
    const e = this.resultado?.escaneo;
    if (!e) return '';
    const ms = Date.parse(e.fin) - Date.parse(e.inicio);
    const seg = Math.max(1, Math.round(ms / 1000));
    return `${seg >= 90 ? Math.round(seg / 60) + ' min' : seg + ' s'}`;
  }

  get entornosConProblema(): number {
    return (this.resultado?.escaneo?.entornos || []).filter((e) => !e.ok).length;
  }

  // ============================================================ detalle
  abrirDetalle(h: HallazgoCert): void { this.detalle = h; }
  cerrarDetalle(): void { this.detalle = null; }

  // ============================================================ crear / actualizar con datos precargados
  abrirAsistente(h: HallazgoCert): void {
    this.avisoAccion = null;
    if (!this.puedeEditar || !h.accion) return;
    if (!h.servidor.id) {
      this.avisoAccion = `El servidor «${h.servidor.entornoNombre}» de Portainer no está en el inventario. Regístralo primero en Inventario → Servidores.`;
      return;
    }
    const c = h.certificado;
    const datosCert = {
      NombreComun: c.nombreComun || '', EntidadEmisora: c.emisor || '', NumeroSerie: c.serie, Thumbprint: c.thumbprint,
      FechaInicio: c.desde, FechaFin: c.hasta,
    };
    const ubicacion = { servidorId: h.servidor.id, componente: h.componenteSugerido, puerto: h.puertoSugerido };

    if (h.accion === 'crear') {
      this.asistenteGrupo = null;
      this.asistenteModo = 'nuevo';
      this.asistentePrecarga = { datos: { ...datosCert, Observaciones: h.observacionesSugeridas }, ubicacion };
    } else {
      const filaId = h.inventario?.id;
      const grupo = this.grupos.find((g) => g.filas.some((f) => idDe(f) === filaId));
      const fila = grupo?.filas.find((f) => idDe(f) === filaId);
      if (!grupo || !fila) {
        this.avisoAccion = 'No se encontró el certificado del inventario (puede haber cambiado). Actualiza la pantalla e inténtalo de nuevo.';
        return;
      }
      if (h.accion === 'actualizar') {
        // Solo se corrige ESA ubicación: se deja un grupo de una sola fila para no tocar otros servidores.
        this.asistenteGrupo = { ...grupo, filas: [fila] };
        this.asistenteModo = 'editar';
        this.asistentePrecarga = { datos: datosCert };
      } else {
        this.asistenteGrupo = grupo;
        this.asistenteModo = 'editar';
        this.asistentePrecarga = { ubicacion };
      }
    }
    this.detalle = null;
    this.asistenteAbierto = true;
  }

  cerrarAsistente(): void {
    this.asistenteAbierto = false;
    this.asistenteGrupo = null;
    this.asistentePrecarga = null;
  }

  asistenteGuardado(): void {
    this.cerrarAsistente();
    this.inventarioCambio.emit();
    this.cargarResultado();
  }

  // ============================================================ Excel
  exportarExcel(): void {
    const r = this.resultado;
    if (!r || !r.hallazgos) return;
    const libro = XLSX.utils.book_new();
    const t = (v: unknown) => (v === null || v === undefined ? '' : v);
    const hallazgos = (this.verAutoridades ? r.hallazgos : r.hallazgos.filter((h) => !h.certificado.esAutoridad)).map((h) => ({
      'Conciliación': ESTADOS[h.estado].etiqueta,
      'Vigencia': VIGENCIA[h.vigencia].etiqueta,
      'Días restantes': h.dias,
      'Servidor': this.nombreServidor(h),
      'Servidor en inventario': h.servidorInventariado ? 'Sí' : 'No',
      'IP': t(h.servidor.ip),
      'Nombre común': t(h.certificado.nombreComun),
      'Entidad emisora': t(h.certificado.emisor),
      'Número de serie': h.certificado.serie,
      'Thumbprint (SHA-1)': h.certificado.thumbprint,
      'SHA-256': h.certificado.sha256,
      'Válido desde': h.certificado.desde,
      'Vence el': h.certificado.hasta,
      'Algoritmo': t(h.certificado.algoritmo),
      'Autofirmado': h.certificado.autofirmado ? 'Sí' : 'No',
      'SAN': h.certificado.san.join(', '),
      'Contenedores': h.contenedores.join(', '),
      'Puertos TLS': h.puertos.join(', '),
      'Archivos': h.evidencias.filter((e) => e.ruta).map((e) => `${e.ruta} (${e.contenedor})${e.config ? ` · declarado en ${e.config}` : ''}${e.claveOrigen ? ` · clave de ${e.claveOrigen}` : ''}`).join('; '),
      'Sub-aplicativo sugerido': t(h.componenteSugerido),
      'Inventario: id': h.inventario ? h.inventario.id : '',
      'Inventario: sub-aplicativo': h.inventario ? t(h.inventario.componente) : '',
      'Inventario: servidor': h.inventario ? t(h.inventario.hostname) : '',
      'Inventario: vence': h.inventario ? t(h.inventario.hasta) : '',
      'Diferencias': h.diferencias.join(' | '),
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(hallazgos), 'Certificados en contenedores');

    const sin = (r.sinEvidencia || []).map((f) => ({
      'Servidor': t(f.hostname), 'Sub-aplicativo': t(f.componente), 'Contenedor probable': f.contenedor, 'Nombre común': t(f.nombreComun),
      'Puerto': t(f.puerto), 'Vence el': t(f.hasta), 'Días restantes': t(f.dias), 'Responsable': t(f.responsable), 'Inventario: id': f.id,
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(sin), 'Inventario sin evidencia');

    const no = (r.noLegibles || []).map((n) => ({
      'Servidor': n.hostname || n.entornoNombre, 'Contenedor': n.contenedor, 'Imagen': n.imagen, 'Archivo': n.ruta, 'Formato': n.formato, 'Motivo': n.motivo,
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(no), 'No legibles');

    const srv = (r.escaneo?.entornos || []).map((e) => ({
      'Entorno Portainer': e.nombre, 'Servidor en inventario': t(e.hostname), 'IP': t(e.ip), 'Estado': e.ok ? 'Consultado' : 'Sin datos',
      'Detalle': t(e.error), 'Contenedores': e.contenedores, 'Contenedores escaneados': e.escaneados, 'Puertos sondeados': e.puertosSondeados,
      'Puertos con TLS': e.puertosConTls, 'Archivos leídos': e.archivosLeidos, 'Carpetas truncadas': e.rutasTruncadas, 'Avisos': e.avisos.join(' | '),
    }));
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(srv), 'Servidores escaneados');

    const cfgFilas: Record<string, unknown>[] = [];
    for (const c of r.configuraciones || []) {
      const base = {
        'Servidor': this.nombreServidorCfg(c), 'Contenedor': c.contenedor, 'Imagen': c.imagen, 'Stack': t(c.stack),
        'Configurado para TLS': c.usaTls ? 'Sí' : 'No', 'Certificados leídos': c.certificados, 'Archivos leídos': c.archivos, '.jar/.war abiertos': c.jars,
        'Claves probadas (origen)': c.claves.map((k) => `${k.origen}${k.abrio ? ' ✔' : ''}`).join('; '),
      };
      if (!c.referencias.length) cfgFilas.push({ ...base, 'Referencia': '', 'Tipo': '', 'Dónde se declara': '', 'Estado': '', 'Detalle': '' });
      for (const ref of c.referencias) {
        cfgFilas.push({ ...base, 'Referencia': ref.ruta, 'Tipo': ref.tipo, 'Dónde se declara': ref.origen, 'Estado': ESTADO_REFERENCIA[ref.estado].etiqueta, 'Detalle': ref.detalle });
      }
    }
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(cfgFilas), 'Configuración (docker run)');

    const fecha = (r.escaneo?.fin || new Date().toISOString()).slice(0, 10);
    XLSX.writeFile(libro, `certificados-contenedores_${fecha}.xlsx`);
  }
}
