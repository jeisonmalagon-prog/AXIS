import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  MonitoreoService,
  EntornoPortainer,
  ContenedorPortainer,
  DetalleContenedor,
  AccionContenedor,
  ImagenPortainer,
  RedPortainer,
  VolumenPortainer,
  EventoPortainer,
  HostInfoPortainer,
  EstadisticasRecursosFlota,
  PuntoHistoricoPortainer,
} from '../services/monitoreo.service';
import { AuthService } from '../services/auth.service';
import { PortainerSaludComponent } from './portainer-salud.component';

// Estado de carga del detalle (inspect) de un contenedor puntual — se pide
// sólo cuando el usuario abre ese contenedor, no junto con la lista.
type EstadoDetalle =
  | { estado: 'cargando' }
  | { estado: 'error'; mensaje: string }
  | { estado: 'listo'; datos: DetalleContenedor };

// Mismo patrón para los logs.
type EstadoLogs =
  | { estado: 'cargando' }
  | { estado: 'error'; mensaje: string }
  | { estado: 'listo'; texto: string };

// Mismo patrón genérico para las listas de Imágenes/Redes/Volúmenes (Fase 2).
type EstadoLista<T> =
  | { estado: 'cargando' }
  | { estado: 'error'; mensaje: string }
  | { estado: 'listo'; datos: T[] };

// Mismo patrón para el detalle de host (un solo objeto, no una lista).
type EstadoHost =
  | { estado: 'cargando' }
  | { estado: 'error'; mensaje: string }
  | { estado: 'listo'; datos: HostInfoPortainer };

type PestanaEntorno = 'contenedores' | 'imagenes' | 'redes' | 'volumenes' | 'eventos' | 'host';

// Fila de la tabla "Top consumidores" — se arma combinando un contenedor con
// el nombre de su entorno, para que la tabla no pierda de dónde viene cada uno.
interface FilaConsumo {
  nombre: string;
  entorno: string;
  cpuTexto: string;
  memTexto: string;
  cpuNum: number;
  memNum: number;
}

// Un segmento de la dona de distribución de contenedores por estado.
interface SegmentoDona {
  etiqueta: string;
  clase: string;
  color: string;
  cantidad: number;
  dasharray: string;
  dashoffset: number;
}

// Consumo de CPU/memoria de UN servidor (entorno), aproximado sumando lo que
// reportan sus contenedores corriendo contra la capacidad total del host que
// trae el snapshot de Portainer. Portainer no expone el uso real del host
// (CPU/memoria del sistema operativo) sin una extensión de pago, así que
// esto es "cuánta de la capacidad del servidor están usando sus
// contenedores" — la mejor aproximación posible con los datos disponibles.
interface UtilizacionServidor {
  id: number;
  nombre: string;
  ip: string | null;
  cpuCores: number | null;
  memoriaTotalGb: number;
  cpuUsadoPct: number;
  memUsadaGb: number;
  memUsadaPct: number;
  corriendo: number;
  total: number;
}

@Component({
  selector: 'app-monitoreo',
  standalone: true,
  imports: [CommonModule, FormsModule, PortainerSaludComponent],
  templateUrl: './monitoreo.component.html',
  styleUrl: './monitoreo.component.scss',
})
export class MonitoreoComponent implements OnInit, OnDestroy {
  // Pestañas de la pantalla: «Entornos» es la vista de siempre; las otras tres
  // las dibuja <app-portainer-salud> (salud real, stacks e higiene).
  vistaMonitoreo: 'entornos' | 'salud' | 'stacks' | 'higiene' = 'entornos';
  readonly vistasMonitoreo: { valor: 'entornos' | 'salud' | 'stacks' | 'higiene'; etiqueta: string }[] = [
    { valor: 'entornos', etiqueta: 'Entornos' },
    { valor: 'salud', etiqueta: 'Salud y alertas' },
    { valor: 'stacks', etiqueta: 'Stacks y versiones' },
    { valor: 'higiene', etiqueta: 'Higiene' },
  ];
  cambiarVistaMonitoreo(v: 'entornos' | 'salud' | 'stacks' | 'higiene'): void {
    this.vistaMonitoreo = v;
    this.router.navigate([], { queryParams: { vista: v === 'entornos' ? null : v }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  // ==========================================
  // PORTAINER: vista directa de entornos + contenedores — no depende de
  // agregar servidores a ningún grupo, es la vista completa de lo que hay
  // en Portainer (ver GET /monitoreo/portainer/entornos).
  // ==========================================
  entornosPortainer: EntornoPortainer[] = [];
  portainerConfigurado = true; // se ajusta con la primera respuesta del backend
  cargandoPortainer = true;
  // Motivo por el que Portainer no respondió en el último refresco (se
  // limpia solo en cuanto vuelve a responder bien) — distinto de "Portainer
  // sí respondió pero no tiene entornos", que no es un error.
  errorPortainer: string | null = null;

  // Sólo ADMIN_POD/ADMIN_MIN pueden ejecutar acciones sobre contenedores
  // (start/stop/restart/pause/kill/remove). Cualquiera que entre a
  // Monitoreo puede ver el detalle completo, incluido BASIC.
  puedeEditar = false;

  private destruido = false;
  private timerPortainer: any = null;
  private readonly INTERVALO_PORTAINER_MS = 6000;

  mostrarSoloActivosEntorno: { [id: number]: boolean } = {};

  // ==========================================
  // FILTROS DE BÚSQUEDA — grilla de entornos
  // ==========================================
  filtroTextoEntorno = '';
  filtroEstadoEntorno: 'todos' | 'conectados' | 'caidos' = 'todos';
  filtroSoloConDetenidos = false;

  // Búsqueda de contenedores dentro de la pestaña "Contenedores" de cada
  // tarjeta — por entorno, para que buscar en una tarjeta no afecte a las
  // demás (mismo criterio que mostrarSoloActivosEntorno).
  private busquedaContenedorPorEntorno = new Map<number, string>();

  // Contenedor actualmente abierto en el modal de detalle (o null si está
  // cerrado). Se guarda sólo por ID a propósito — nunca el objeto completo
  // congelado — para que el modal siga leyendo datos en vivo de
  // entornosPortainer aunque el refresco automático reemplace el array.
  seleccion: { entornoId: number; contenedorId: string } | null = null;

  // Detalle/logs por contenedor, cacheados por clave "entorno:ID::contenedorID"
  // — se piden sólo la primera vez que se abre cada uno.
  private detalleContenedores = new Map<string, EstadoDetalle>();
  private logsContenedores = new Map<string, EstadoLogs>();
  private pestanaContenedor = new Map<string, 'detalle' | 'logs'>();

  // Contenedores con una acción en curso (deshabilita sus botones mientras
  // se espera la respuesta, para que no se pueda hacer doble clic).
  private accionEnCurso = new Set<string>();

  // ==========================================
  // FASE 2: IMÁGENES, REDES Y VOLÚMENES POR ENTORNO
  // ==========================================
  // Pestaña activa dentro de la sección "Docker" de cada tarjeta de entorno
  // (antes sólo mostraba Contenedores; ahora es un selector). Se guarda por
  // entorno porque cada tarjeta navega su propia pestaña de forma
  // independiente.
  private pestanaEntorno = new Map<number, PestanaEntorno>();

  // Cacheados por entorno, igual que detalle/logs de contenedores — se piden
  // sólo la primera vez que se abre cada pestaña, no junto con el poll de
  // contenedores (que sigue siendo lo único que se refresca solo cada 6s).
  private imagenesPorEntorno = new Map<number, EstadoLista<ImagenPortainer>>();
  private redesPorEntorno = new Map<number, EstadoLista<RedPortainer>>();
  private volumenesPorEntorno = new Map<number, EstadoLista<VolumenPortainer>>();

  // Igual que accionEnCurso pero para acciones sobre imágenes/redes/volúmenes
  // (todas son "eliminar" por ahora), con clave "tipo:entorno:id".
  private accionRecursoEnCurso = new Set<string>();

  // ==========================================
  // FASE 3: EVENTOS Y HOST POR ENTORNO (sólo lectura, sin acciones de admin)
  // ==========================================
  private eventosPorEntorno = new Map<number, EstadoLista<EventoPortainer>>();
  // Rango de tiempo elegido para los eventos de cada entorno, en minutos
  // (60 = última hora) — se guarda por entorno para que cambiar el rango en
  // una tarjeta no afecte a las demás.
  private minutosEventosPorEntorno = new Map<number, number>();
  private hostPorEntorno = new Map<number, EstadoHost>();

  // Redes que Docker crea solas en cada environment y no se pueden eliminar
  // — se ocultan del botón "Eliminar" para no ofrecer una acción que siempre
  // va a fallar.
  private readonly REDES_PREDETERMINADAS = ['bridge', 'host', 'none'];

  // ==========================================
  // ANÁLISIS ESTADÍSTICO: sección siempre visible entre los chips de resumen
  // y la grilla de tarjetas. El resumen de salud y los top consumidores se
  // calculan al vuelo desde entornosPortainer (ya viaja con cpuPorcentajeNum/
  // memUsoBytesNum); imágenes/redes/volúmenes agregados e histórico vienen
  // de su propio endpoint y se piden una sola vez (no junto con el poll de 6s).
  // ==========================================
  estadisticasFlota: EstadisticasRecursosFlota | null = null;
  cargandoEstadisticas = false;
  errorEstadisticas: string | null = null;

  historicoPortainer: PuntoHistoricoPortainer[] = [];
  cargandoHistorico = false;
  errorHistorico: string | null = null;

  private readonly RADIO_DONA = 70;
  private readonly CIRCUNFERENCIA_DONA = 2 * Math.PI * 70;

  constructor(
    private monitoreoService: MonitoreoService,
    private authService: AuthService,
    private router: Router,
    private ruta: ActivatedRoute,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('SERVIDORES');
    const v = this.ruta.snapshot.queryParamMap.get('vista');
    if (v === 'salud' || v === 'stacks' || v === 'higiene') this.vistaMonitoreo = v;

    this.refrescarEntornosPortainer();
    this.cargarEstadisticasFlota();
    this.cargarHistorico();
  }

  ngOnDestroy(): void {
    this.destruido = true;
    if (this.timerPortainer) clearTimeout(this.timerPortainer);
  }

  // Refresca la lista de entornos de Portainer y se vuelve a programar sola
  // — nunca dos peticiones en paralelo, y se detiene sola si el componente
  // ya se destruyó.
  private refrescarEntornosPortainer(): void {
    if (this.destruido) return;
    this.monitoreoService.listarEntornosPortainer().subscribe({
      next: (resp) => {
        this.portainerConfigurado = resp.configurado;
        this.entornosPortainer = resp.entornos;
        this.errorPortainer = resp.error ?? null;
        this.cargandoPortainer = false;
        if (!this.destruido) {
          this.timerPortainer = setTimeout(() => this.refrescarEntornosPortainer(), this.INTERVALO_PORTAINER_MS);
        }
      },
      error: (err) => {
        // Esto sólo pasa si ni siquiera se pudo llamar al backend (backend
        // caído, sesión vencida, etc.) — un problema de Portainer en sí ya
        // viene como respuesta 200 con "error" adentro (ver next arriba).
        this.errorPortainer = err.error?.error || 'No se pudo conectar con el backend para consultar Portainer.';
        this.cargandoPortainer = false;
        if (!this.destruido) {
          this.timerPortainer = setTimeout(() => this.refrescarEntornosPortainer(), this.INTERVALO_PORTAINER_MS);
        }
      },
    });
  }

  // Cancela el refresco automático programado y dispara uno inmediato — se
  // usa después de ejecutar una acción, para ver el cambio de estado al
  // toque en vez de esperar hasta 6s. Sin cancelar el timer pendiente antes,
  // quedarían dos cadenas de refresco corriendo en paralelo.
  private refrescarYaMismo(): void {
    if (this.timerPortainer) {
      clearTimeout(this.timerPortainer);
      this.timerPortainer = null;
    }
    this.refrescarEntornosPortainer();
  }

  // ==========================================
  // CONTENEDORES POR ENTORNO: expandir/colapsar, filtro "solo activos"
  // ==========================================

  toggleSoloActivosEntorno(entornoId: number): void {
    this.mostrarSoloActivosEntorno[entornoId] = !this.mostrarSoloActivosEntorno[entornoId];
  }

  // ---------- Filtros de la grilla de entornos ----------

  // Entornos que coinciden con la búsqueda de texto (nombre del entorno, IP
  // del inventario, o nombre/imagen de cualquiera de sus contenedores) y con
  // los chips de estado/detenidos activos. Se calcula sobre entornosPortainer
  // en cada acceso — no hace falta cachear, la lista rara vez pasa de unas
  // pocas decenas de entornos.
  get entornosFiltrados(): EntornoPortainer[] {
    const texto = this.filtroTextoEntorno.trim().toLowerCase();
    return this.entornosPortainer.filter((e) => {
      if (texto && !this.entornoCoincideBusqueda(e, texto)) return false;
      if (this.filtroEstadoEntorno === 'conectados' && e.estadoConexion !== 'up') return false;
      if (this.filtroEstadoEntorno === 'caidos' && e.estadoConexion === 'up') return false;
      if (this.filtroSoloConDetenidos && !(e.resumenContenedores?.detenidos > 0)) return false;
      return true;
    });
  }

  private entornoCoincideBusqueda(e: EntornoPortainer, texto: string): boolean {
    if (e.nombre.toLowerCase().includes(texto)) return true;
    if (e.ipInventario && e.ipInventario.toLowerCase().includes(texto)) return true;
    return (e.contenedores || []).some(
      (c) => c.nombre.toLowerCase().includes(texto) || c.imagen.toLowerCase().includes(texto)
    );
  }

  // Cuando la búsqueda global viene de un contenedor (no del nombre/IP del
  // propio entorno), conviene saberlo para poder avisarlo en la tarjeta.
  entornoCoincidePorContenedor(e: EntornoPortainer): boolean {
    const texto = this.filtroTextoEntorno.trim().toLowerCase();
    if (!texto) return false;
    const coincideDirecto =
      e.nombre.toLowerCase().includes(texto) || (!!e.ipInventario && e.ipInventario.toLowerCase().includes(texto));
    if (coincideDirecto) return false;
    return (e.contenedores || []).some(
      (c) => c.nombre.toLowerCase().includes(texto) || c.imagen.toLowerCase().includes(texto)
    );
  }

  get entornosSinIpInventario(): number {
    return this.entornosPortainer.filter((e) => e.estadoConexion === 'up' && !e.ipInventario).length;
  }

  get entornosConDetenidos(): number {
    return this.entornosPortainer.filter((e) => e.resumenContenedores?.detenidos > 0).length;
  }

  // Clic sobre un chip de estado: alternar (mismo chip otra vez -> "todos").
  alternarFiltroEstadoEntorno(valor: 'conectados' | 'caidos'): void {
    this.filtroEstadoEntorno = this.filtroEstadoEntorno === valor ? 'todos' : valor;
  }

  toggleFiltroSoloConDetenidos(): void {
    this.filtroSoloConDetenidos = !this.filtroSoloConDetenidos;
  }

  limpiarFiltrosEntorno(): void {
    this.filtroTextoEntorno = '';
    this.filtroEstadoEntorno = 'todos';
    this.filtroSoloConDetenidos = false;
  }

  get hayFiltrosEntornoActivos(): boolean {
    return !!this.filtroTextoEntorno || this.filtroEstadoEntorno !== 'todos' || this.filtroSoloConDetenidos;
  }

  // ---------- Búsqueda de contenedores dentro de cada tarjeta ----------

  textoBusquedaContenedor(entornoId: number): string {
    return this.busquedaContenedorPorEntorno.get(entornoId) || '';
  }

  actualizarBusquedaContenedor(entornoId: number, valor: string): void {
    this.busquedaContenedorPorEntorno.set(entornoId, valor);
  }

  limpiarBusquedaContenedor(entornoId: number): void {
    this.busquedaContenedorPorEntorno.delete(entornoId);
  }

  private claveEntorno(entornoId: number, contenedorId: string): string {
    return `entorno:${entornoId}::${contenedorId}`;
  }

  trackEntorno(_indice: number, e: EntornoPortainer): number {
    return e.id;
  }

  trackContenedor(_indice: number, c: ContenedorPortainer): string {
    return c.id;
  }

  // Abre el modal de detalle para un contenedor puntual. Se identifica sólo
  // por IDs (ver "seleccion" arriba), así el modal queda desacoplado del
  // *ngFor con poll de la grilla de entornos y nunca se resetea con él.
  abrirDetalle(entornoId: number, contenedorId: string): void {
    this.seleccion = { entornoId, contenedorId };
    const clave = this.claveEntorno(entornoId, contenedorId);
    if (!this.pestanaContenedor.has(clave)) this.pestanaContenedor.set(clave, 'detalle');
    // Al abrir por primera vez, se carga la pestaña "Detalle" de una vez.
    if (this.pestanaActiva(entornoId, contenedorId) === 'detalle' && !this.detalleContenedores.has(clave)) {
      this.cargarDetalle(entornoId, contenedorId);
    }
  }

  cerrarDetalle(): void {
    this.seleccion = null;
  }

  // El entorno/contenedor seleccionados se buscan siempre por ID sobre el
  // array vivo (nunca se guarda la referencia congelada) — así el modal
  // muestra datos actualizados aunque el poll reemplace entornosPortainer
  // mientras está abierto.
  get entornoSeleccionado(): EntornoPortainer | null {
    if (!this.seleccion) return null;
    return this.entornosPortainer.find((e) => e.id === this.seleccion!.entornoId) || null;
  }

  get contenedorSeleccionado(): ContenedorPortainer | null {
    const entorno = this.entornoSeleccionado;
    if (!entorno || !this.seleccion) return null;
    return entorno.contenedores.find((c) => c.id === this.seleccion!.contenedorId) || null;
  }

  // Corriendo primero, luego el resto alfabético por nombre. Si el filtro
  // "solo activos" está prendido para ese entorno, se descartan los detenidos.
  contenedoresOrdenadosEntorno(entornoId: number, contenedores?: ContenedorPortainer[]): ContenedorPortainer[] {
    if (!contenedores) return [];
    let filtrados = this.mostrarSoloActivosEntorno[entornoId]
      ? contenedores.filter((c) => c.estado === 'running')
      : contenedores;

    const texto = this.textoBusquedaContenedor(entornoId).trim().toLowerCase();
    if (texto) {
      filtrados = filtrados.filter(
        (c) => c.nombre.toLowerCase().includes(texto) || c.imagen.toLowerCase().includes(texto)
      );
    }

    return [...filtrados].sort((a, b) => {
      if (a.estado === 'running' && b.estado !== 'running') return -1;
      if (a.estado !== 'running' && b.estado === 'running') return 1;
      return a.nombre.localeCompare(b.nombre);
    });
  }

  claseEstadoContenedor(estado: string): string {
    switch (estado) {
      case 'running': return 'contenedor-ok';
      case 'restarting':
      case 'paused': return 'contenedor-warn';
      case 'exited':
      case 'dead': return 'contenedor-danger';
      default: return 'contenedor-neutro';
    }
  }

  // "0.0.0.0:3030->443/tcp, 8080/tcp, [::]:3030->443/tcp" -> se acorta para
  // que quepa en la fila de la tarjeta; el texto completo queda en el title.
  resumenPuertos(puertos: string): string {
    if (!puertos) return '';
    const partes = puertos.split(',').map((p) => p.trim());
    if (partes.length <= 2) return puertos;
    return `${partes[0]}, +${partes.length - 1} más`;
  }

  // Contenedores corriendo/detenidos sumados de TODOS los entornos de
  // Portainer, para el resumen del encabezado de la sección.
  get resumenPortainerGlobal(): { corriendo: number; detenidos: number; total: number; entornosArriba: number; entornosTotal: number } {
    let corriendo = 0;
    let detenidos = 0;
    let total = 0;
    let entornosArriba = 0;
    for (const e of this.entornosPortainer) {
      corriendo += e.resumenContenedores?.corriendo ?? 0;
      detenidos += e.resumenContenedores?.detenidos ?? 0;
      total += e.resumenContenedores?.total ?? 0;
      if (e.estadoConexion === 'up') entornosArriba++;
    }
    return { corriendo, detenidos, total, entornosArriba, entornosTotal: this.entornosPortainer.length };
  }

  // ==========================================
  // PESTAÑAS "Detalle" / "Logs" dentro del panel expandido de un contenedor
  // ==========================================

  pestanaActiva(entornoId: number, contenedorId: string): 'detalle' | 'logs' {
    return this.pestanaContenedor.get(this.claveEntorno(entornoId, contenedorId)) || 'detalle';
  }

  cambiarPestana(entornoId: number, contenedorId: string, pestana: 'detalle' | 'logs'): void {
    const clave = this.claveEntorno(entornoId, contenedorId);
    this.pestanaContenedor.set(clave, pestana);
    if (pestana === 'detalle' && !this.detalleContenedores.has(clave)) {
      this.cargarDetalle(entornoId, contenedorId);
    } else if (pestana === 'logs' && !this.logsContenedores.has(clave)) {
      this.cargarLogs(entornoId, contenedorId);
    }
  }

  private cargarDetalle(entornoId: number, contenedorId: string): void {
    const clave = this.claveEntorno(entornoId, contenedorId);
    this.detalleContenedores.set(clave, { estado: 'cargando' });
    this.monitoreoService.obtenerDetalleContenedor(entornoId, contenedorId).subscribe({
      next: (datos) => this.detalleContenedores.set(clave, { estado: 'listo', datos }),
      error: (err) => this.detalleContenedores.set(clave, {
        estado: 'error',
        mensaje: err.error?.error || 'No se pudo obtener el detalle de este contenedor.',
      }),
    });
  }

  private cargarLogs(entornoId: number, contenedorId: string): void {
    const clave = this.claveEntorno(entornoId, contenedorId);
    this.logsContenedores.set(clave, { estado: 'cargando' });
    this.monitoreoService.obtenerLogsContenedor(entornoId, contenedorId).subscribe({
      next: (resp) => this.logsContenedores.set(clave, { estado: 'listo', texto: resp.texto }),
      error: (err) => this.logsContenedores.set(clave, {
        estado: 'error',
        mensaje: err.error?.error || 'No se pudieron obtener los logs de este contenedor.',
      }),
    });
  }

  recargarLogs(entornoId: number, contenedorId: string): void {
    this.cargarLogs(entornoId, contenedorId);
  }

  estadoDetalle(entornoId: number, contenedorId: string): 'cargando' | 'error' | 'listo' | 'ninguno' {
    const d = this.detalleContenedores.get(this.claveEntorno(entornoId, contenedorId));
    return d ? d.estado : 'ninguno';
  }

  datosDetalle(entornoId: number, contenedorId: string): DetalleContenedor | null {
    const d = this.detalleContenedores.get(this.claveEntorno(entornoId, contenedorId));
    return d && d.estado === 'listo' ? d.datos : null;
  }

  mensajeErrorDetalle(entornoId: number, contenedorId: string): string {
    const d = this.detalleContenedores.get(this.claveEntorno(entornoId, contenedorId));
    return d && d.estado === 'error' ? d.mensaje : '';
  }

  estadoLogs(entornoId: number, contenedorId: string): 'cargando' | 'error' | 'listo' | 'ninguno' {
    const l = this.logsContenedores.get(this.claveEntorno(entornoId, contenedorId));
    return l ? l.estado : 'ninguno';
  }

  textoLogs(entornoId: number, contenedorId: string): string {
    const l = this.logsContenedores.get(this.claveEntorno(entornoId, contenedorId));
    return l && l.estado === 'listo' ? l.texto : '';
  }

  mensajeErrorLogs(entornoId: number, contenedorId: string): string {
    const l = this.logsContenedores.get(this.claveEntorno(entornoId, contenedorId));
    return l && l.estado === 'error' ? l.mensaje : '';
  }

  // Object.keys() no se puede llamar directo desde una plantilla de Angular.
  objectKeys(obj: { [clave: string]: string } | undefined | null): string[] {
    return obj ? Object.keys(obj) : [];
  }

  // ==========================================
  // ACCIONES SOBRE UN CONTENEDOR (sólo admins — puedeEditar)
  // ==========================================

  // Qué botones tiene sentido mostrar según el estado actual del
  // contenedor — igual que Portainer deshabilita "Start" si ya está
  // corriendo, aquí directamente no se muestra.
  accionesDisponibles(estado: string): AccionContenedor[] {
    switch (estado) {
      case 'running':
        return ['stop', 'restart', 'pause', 'kill'];
      case 'paused':
        return ['unpause', 'stop', 'kill'];
      case 'exited':
      case 'created':
      case 'dead':
        return ['start', 'remove'];
      default:
        return ['start', 'stop', 'restart', 'remove'];
    }
  }

  etiquetaAccion(accion: AccionContenedor): string {
    switch (accion) {
      case 'start': return 'Iniciar';
      case 'stop': return 'Detener';
      case 'restart': return 'Reiniciar';
      case 'pause': return 'Pausar';
      case 'unpause': return 'Reanudar';
      case 'kill': return 'Forzar detención';
      case 'remove': return 'Eliminar';
    }
  }

  accionEnCursoPara(entornoId: number, contenedorId: string): boolean {
    return this.accionEnCurso.has(this.claveEntorno(entornoId, contenedorId));
  }

  ejecutarAccion(entornoId: number, contenedorId: string, nombreContenedor: string, accion: AccionContenedor): void {
    if (!this.puedeEditar) return;

    if (accion === 'kill' || accion === 'remove') {
      const pregunta = accion === 'remove'
        ? `¿Eliminar el contenedor "${nombreContenedor}"? Esta acción no se puede deshacer.`
        : `¿Forzar la detención de "${nombreContenedor}"? A diferencia de "Detener", no le da tiempo de cerrar en orden y puede provocar pérdida de datos no guardados.`;
      if (!confirm(pregunta)) return;
    }

    const clave = this.claveEntorno(entornoId, contenedorId);
    this.accionEnCurso.add(clave);
    this.monitoreoService.ejecutarAccionContenedor(entornoId, contenedorId, accion).subscribe({
      next: () => {
        this.accionEnCurso.delete(clave);
        if (accion === 'remove') {
          this.detalleContenedores.delete(clave);
          this.logsContenedores.delete(clave);
          if (this.seleccion && this.claveEntorno(this.seleccion.entornoId, this.seleccion.contenedorId) === clave) {
            this.cerrarDetalle();
          }
        } else {
          // El inspect cambió (estado, StartedAt/FinishedAt, reinicios...):
          // se descarta el que estaba cacheado para que se vuelva a pedir
          // la próxima vez que se mire esa pestaña.
          this.detalleContenedores.delete(clave);
        }
        this.refrescarYaMismo();
      },
      error: (err) => {
        this.accionEnCurso.delete(clave);
        alert(err.error?.error || `No se pudo ejecutar la acción "${this.etiquetaAccion(accion)}".`);
      },
    });
  }

  // ==========================================
  // FASE 2: IMÁGENES, REDES Y VOLÚMENES POR ENTORNO
  // ==========================================

  trackImagen(_indice: number, img: ImagenPortainer): string {
    return img.id;
  }

  trackRed(_indice: number, r: RedPortainer): string {
    return r.id;
  }

  trackVolumen(_indice: number, v: VolumenPortainer): string {
    return v.nombre;
  }

  pestanaEntornoActiva(entornoId: number): PestanaEntorno {
    return this.pestanaEntorno.get(entornoId) || 'contenedores';
  }

  // Cambia de pestaña dentro de la sección Docker de un entorno y, la
  // primera vez que se abre Imágenes/Redes/Volúmenes, dispara la carga
  // (nunca se piden junto con la lista de contenedores del poll de 6s).
  cambiarPestanaEntorno(entornoId: number, pestana: PestanaEntorno): void {
    this.pestanaEntorno.set(entornoId, pestana);
    if (pestana === 'imagenes' && !this.imagenesPorEntorno.has(entornoId)) this.cargarImagenes(entornoId);
    if (pestana === 'redes' && !this.redesPorEntorno.has(entornoId)) this.cargarRedes(entornoId);
    if (pestana === 'volumenes' && !this.volumenesPorEntorno.has(entornoId)) this.cargarVolumenes(entornoId);
    if (pestana === 'eventos' && !this.eventosPorEntorno.has(entornoId)) this.cargarEventos(entornoId);
    if (pestana === 'host' && !this.hostPorEntorno.has(entornoId)) this.cargarHost(entornoId);
  }

  redEsPredeterminada(nombre: string): boolean {
    return this.REDES_PREDETERMINADAS.includes(nombre);
  }

  private claveRecurso(tipo: string, entornoId: number, id: string): string {
    return `${tipo}:${entornoId}::${id}`;
  }

  recursoEnCurso(tipo: string, entornoId: number, id: string): boolean {
    return this.accionRecursoEnCurso.has(this.claveRecurso(tipo, entornoId, id));
  }

  // ---------- IMÁGENES ----------

  cargarImagenes(entornoId: number): void {
    this.imagenesPorEntorno.set(entornoId, { estado: 'cargando' });
    this.monitoreoService.listarImagenes(entornoId).subscribe({
      next: (datos) => this.imagenesPorEntorno.set(entornoId, { estado: 'listo', datos }),
      error: (err) => this.imagenesPorEntorno.set(entornoId, {
        estado: 'error',
        mensaje: err.error?.error || 'No se pudieron obtener las imágenes de este entorno.',
      }),
    });
  }

  estadoImagenes(entornoId: number): 'cargando' | 'error' | 'listo' | 'ninguno' {
    const r = this.imagenesPorEntorno.get(entornoId);
    return r ? r.estado : 'ninguno';
  }

  datosImagenes(entornoId: number): ImagenPortainer[] {
    const r = this.imagenesPorEntorno.get(entornoId);
    return r && r.estado === 'listo' ? r.datos : [];
  }

  mensajeErrorImagenes(entornoId: number): string {
    const r = this.imagenesPorEntorno.get(entornoId);
    return r && r.estado === 'error' ? r.mensaje : '';
  }

  eliminarImagenAccion(entornoId: number, imagen: ImagenPortainer): void {
    if (!this.puedeEditar) return;
    const etiqueta = imagen.tags.length ? imagen.tags.join(', ') : imagen.id;
    if (!confirm(`¿Eliminar la imagen "${etiqueta}"? Esta acción no se puede deshacer.`)) return;

    const clave = this.claveRecurso('imagen', entornoId, imagen.id);
    this.accionRecursoEnCurso.add(clave);
    this.monitoreoService.eliminarImagen(entornoId, imagen.id).subscribe({
      next: () => {
        this.accionRecursoEnCurso.delete(clave);
        this.cargarImagenes(entornoId);
      },
      error: (err) => {
        this.accionRecursoEnCurso.delete(clave);
        alert(err.error?.error || 'No se pudo eliminar la imagen.');
      },
    });
  }

  // ---------- REDES ----------

  cargarRedes(entornoId: number): void {
    this.redesPorEntorno.set(entornoId, { estado: 'cargando' });
    this.monitoreoService.listarRedes(entornoId).subscribe({
      next: (datos) => this.redesPorEntorno.set(entornoId, { estado: 'listo', datos }),
      error: (err) => this.redesPorEntorno.set(entornoId, {
        estado: 'error',
        mensaje: err.error?.error || 'No se pudieron obtener las redes de este entorno.',
      }),
    });
  }

  estadoRedes(entornoId: number): 'cargando' | 'error' | 'listo' | 'ninguno' {
    const r = this.redesPorEntorno.get(entornoId);
    return r ? r.estado : 'ninguno';
  }

  datosRedes(entornoId: number): RedPortainer[] {
    const r = this.redesPorEntorno.get(entornoId);
    return r && r.estado === 'listo' ? r.datos : [];
  }

  mensajeErrorRedes(entornoId: number): string {
    const r = this.redesPorEntorno.get(entornoId);
    return r && r.estado === 'error' ? r.mensaje : '';
  }

  eliminarRedAccion(entornoId: number, red: RedPortainer): void {
    if (!this.puedeEditar) return;
    if (!confirm(`¿Eliminar la red "${red.nombre}"? Esta acción no se puede deshacer.`)) return;

    const clave = this.claveRecurso('red', entornoId, red.id);
    this.accionRecursoEnCurso.add(clave);
    this.monitoreoService.eliminarRed(entornoId, red.id).subscribe({
      next: () => {
        this.accionRecursoEnCurso.delete(clave);
        this.cargarRedes(entornoId);
      },
      error: (err) => {
        this.accionRecursoEnCurso.delete(clave);
        alert(err.error?.error || 'No se pudo eliminar la red.');
      },
    });
  }

  // ---------- VOLÚMENES ----------

  cargarVolumenes(entornoId: number): void {
    this.volumenesPorEntorno.set(entornoId, { estado: 'cargando' });
    this.monitoreoService.listarVolumenes(entornoId).subscribe({
      next: (datos) => this.volumenesPorEntorno.set(entornoId, { estado: 'listo', datos }),
      error: (err) => this.volumenesPorEntorno.set(entornoId, {
        estado: 'error',
        mensaje: err.error?.error || 'No se pudieron obtener los volúmenes de este entorno.',
      }),
    });
  }

  estadoVolumenes(entornoId: number): 'cargando' | 'error' | 'listo' | 'ninguno' {
    const r = this.volumenesPorEntorno.get(entornoId);
    return r ? r.estado : 'ninguno';
  }

  datosVolumenes(entornoId: number): VolumenPortainer[] {
    const r = this.volumenesPorEntorno.get(entornoId);
    return r && r.estado === 'listo' ? r.datos : [];
  }

  mensajeErrorVolumenes(entornoId: number): string {
    const r = this.volumenesPorEntorno.get(entornoId);
    return r && r.estado === 'error' ? r.mensaje : '';
  }

  eliminarVolumenAccion(entornoId: number, volumen: VolumenPortainer): void {
    if (!this.puedeEditar) return;
    if (!confirm(`¿Eliminar el volumen "${volumen.nombre}"? Esta acción no se puede deshacer.`)) return;

    const clave = this.claveRecurso('volumen', entornoId, volumen.nombre);
    this.accionRecursoEnCurso.add(clave);
    this.monitoreoService.eliminarVolumen(entornoId, volumen.nombre).subscribe({
      next: () => {
        this.accionRecursoEnCurso.delete(clave);
        this.cargarVolumenes(entornoId);
      },
      error: (err) => {
        this.accionRecursoEnCurso.delete(clave);
        alert(err.error?.error || 'No se pudo eliminar el volumen.');
      },
    });
  }

  // ==========================================
  // FASE 3: EVENTOS Y HOST POR ENTORNO
  // ==========================================

  trackEvento(_indice: number, ev: EventoPortainer): string {
    return ev.id;
  }

  minutosEventosActivo(entornoId: number): number {
    return this.minutosEventosPorEntorno.get(entornoId) || 60;
  }

  cambiarRangoEventos(entornoId: number, minutos: number | string): void {
    this.minutosEventosPorEntorno.set(entornoId, +minutos);
    this.cargarEventos(entornoId);
  }

  cargarEventos(entornoId: number): void {
    this.eventosPorEntorno.set(entornoId, { estado: 'cargando' });
    this.monitoreoService.listarEventos(entornoId, this.minutosEventosActivo(entornoId)).subscribe({
      next: (datos) => this.eventosPorEntorno.set(entornoId, { estado: 'listo', datos }),
      error: (err) => this.eventosPorEntorno.set(entornoId, {
        estado: 'error',
        mensaje: err.error?.error || 'No se pudieron obtener los eventos de este entorno.',
      }),
    });
  }

  estadoEventos(entornoId: number): 'cargando' | 'error' | 'listo' | 'ninguno' {
    const r = this.eventosPorEntorno.get(entornoId);
    return r ? r.estado : 'ninguno';
  }

  datosEventos(entornoId: number): EventoPortainer[] {
    const r = this.eventosPorEntorno.get(entornoId);
    return r && r.estado === 'listo' ? r.datos : [];
  }

  mensajeErrorEventos(entornoId: number): string {
    const r = this.eventosPorEntorno.get(entornoId);
    return r && r.estado === 'error' ? r.mensaje : '';
  }

  cargarHost(entornoId: number): void {
    this.hostPorEntorno.set(entornoId, { estado: 'cargando' });
    this.monitoreoService.obtenerInfoHost(entornoId).subscribe({
      next: (datos) => this.hostPorEntorno.set(entornoId, { estado: 'listo', datos }),
      error: (err) => this.hostPorEntorno.set(entornoId, {
        estado: 'error',
        mensaje: err.error?.error || 'No se pudieron obtener los datos del host de este entorno.',
      }),
    });
  }

  estadoHost(entornoId: number): 'cargando' | 'error' | 'listo' | 'ninguno' {
    const r = this.hostPorEntorno.get(entornoId);
    return r ? r.estado : 'ninguno';
  }

  datosHost(entornoId: number): HostInfoPortainer | null {
    const r = this.hostPorEntorno.get(entornoId);
    return r && r.estado === 'listo' ? r.datos : null;
  }

  mensajeErrorHost(entornoId: number): string {
    const r = this.hostPorEntorno.get(entornoId);
    return r && r.estado === 'error' ? r.mensaje : '';
  }

  // ==========================================
  // ANÁLISIS ESTADÍSTICO
  // ==========================================

  cargarEstadisticasFlota(): void {
    this.cargandoEstadisticas = true;
    this.errorEstadisticas = null;
    this.monitoreoService.obtenerEstadisticasFlota().subscribe({
      next: (datos) => {
        this.estadisticasFlota = datos;
        this.cargandoEstadisticas = false;
      },
      error: (err) => {
        this.errorEstadisticas = err.error?.error || 'No se pudieron obtener las estadísticas agregadas de Portainer.';
        this.cargandoEstadisticas = false;
      },
    });
  }

  cargarHistorico(horas = 24): void {
    this.cargandoHistorico = true;
    this.errorHistorico = null;
    this.monitoreoService.obtenerHistorico(horas).subscribe({
      next: (datos) => {
        this.historicoPortainer = datos;
        this.cargandoHistorico = false;
      },
      error: (err) => {
        this.errorHistorico = err.error?.error || 'No se pudo obtener el histórico de Portainer.';
        this.cargandoHistorico = false;
      },
    });
  }

  // Botón "Actualizar análisis" — vuelve a pedir todo lo que no viaja con el
  // poll automático de 6s (ese sigue solo su propio ciclo).
  actualizarAnalisis(): void {
    this.cargarEstadisticasFlota();
    this.cargarHistorico();
  }

  // ---------- Resumen de salud de la flota (calculado en el cliente) ----------

  get saludFlota(): {
    cpuTotal: number;
    memoriaTotalGb: number;
    entornosArriba: number;
    entornosTotal: number;
    corriendo: number;
    detenidos: number;
    porcentajeSalud: number;
  } {
    let cpuTotal = 0;
    let memoriaTotalGb = 0;
    for (const e of this.entornosPortainer) {
      if (e.estadoConexion !== 'up') continue;
      cpuTotal += e.cpuCores || 0;
      memoriaTotalGb += e.memoriaTotalGb || 0;
    }
    const r = this.resumenPortainerGlobal;
    const porcentajeSalud = r.total > 0 ? Math.round((r.corriendo / r.total) * 100) : 0;
    return {
      cpuTotal,
      memoriaTotalGb: Math.round(memoriaTotalGb * 10) / 10,
      entornosArriba: r.entornosArriba,
      entornosTotal: r.entornosTotal,
      corriendo: r.corriendo,
      detenidos: r.detenidos,
      porcentajeSalud,
    };
  }

  // Color del número de "Salud de la flota" — mismos umbrales/colores que
  // el resto del panel usa para sano/riesgo/crítico.
  colorSaludFlota(): string {
    const pct = this.saludFlota.porcentajeSalud;
    if (pct >= 90) return '#16a34a';
    if (pct >= 70) return '#d97706';
    return '#dc2626';
  }

  // ---------- Distribución de contenedores por estado (dona) ----------

  get distribucionEstadosFlota(): SegmentoDona[] {
    let corriendo = 0;
    let pausados = 0;
    let detenidos = 0;
    let otros = 0;

    for (const e of this.entornosPortainer) {
      for (const c of e.contenedores || []) {
        switch (c.estado) {
          case 'running': corriendo++; break;
          case 'paused':
          case 'restarting': pausados++; break;
          case 'exited':
          case 'dead': detenidos++; break;
          default: otros++;
        }
      }
    }

    const total = corriendo + pausados + detenidos + otros;
    const categorias = [
      { etiqueta: 'Corriendo', clase: 'punto-sano', color: '#16a34a', cantidad: corriendo },
      { etiqueta: 'Pausados/reiniciando', clase: 'punto-riesgo', color: '#d97706', cantidad: pausados },
      { etiqueta: 'Detenidos', clase: 'punto-critico', color: '#dc2626', cantidad: detenidos },
      { etiqueta: 'Otros', clase: 'punto-sinconexion', color: '#64748b', cantidad: otros },
    ];

    let acumulado = 0;
    const segmentos: SegmentoDona[] = [];
    for (const cat of categorias) {
      if (cat.cantidad <= 0 || total <= 0) continue;
      const largo = (cat.cantidad / total) * this.CIRCUNFERENCIA_DONA;
      segmentos.push({
        etiqueta: cat.etiqueta,
        clase: cat.clase,
        color: cat.color,
        cantidad: cat.cantidad,
        dasharray: `${largo} ${this.CIRCUNFERENCIA_DONA - largo}`,
        dashoffset: -acumulado,
      });
      acumulado += largo;
    }
    return segmentos;
  }

  get totalContenedoresFlota(): number {
    return this.distribucionEstadosFlota.reduce((suma, s) => suma + s.cantidad, 0);
  }

  // ---------- Top consumidores de CPU / memoria ----------

  private parsearPorcentaje(texto?: string | null): number {
    if (!texto) return 0;
    const n = parseFloat(texto);
    return isNaN(n) ? 0 : n;
  }

  private todasFilasConsumo(): FilaConsumo[] {
    const filas: FilaConsumo[] = [];
    for (const e of this.entornosPortainer) {
      for (const c of e.contenedores || []) {
        if (c.estado !== 'running' || !c.recursos) continue;
        filas.push({
          nombre: c.nombre,
          entorno: e.nombre,
          cpuTexto: c.recursos.cpuPorcentaje,
          memTexto: c.recursos.memUso,
          cpuNum: c.recursos.cpuPorcentajeNum ?? this.parsearPorcentaje(c.recursos.cpuPorcentaje),
          memNum: c.recursos.memUsoBytesNum ?? this.parsearPorcentaje(c.recursos.memPorcentaje),
        });
      }
    }
    return filas;
  }

  get topConsumidoresCpu(): FilaConsumo[] {
    return this.todasFilasConsumo().sort((a, b) => b.cpuNum - a.cpuNum).slice(0, 6);
  }

  get topConsumidoresMemoria(): FilaConsumo[] {
    return this.todasFilasConsumo().sort((a, b) => b.memNum - a.memNum).slice(0, 6);
  }

  trackFilaConsumo(_indice: number, fila: FilaConsumo): string {
    return `${fila.entorno}::${fila.nombre}`;
  }

  // ---------- Consumo de CPU/memoria POR SERVIDOR ----------
  // Complementa el "top consumidores" de arriba (por contenedor) con la
  // misma cuenta pero agregada por servidor — para cada tarjeta y para el
  // panel general de "Consumo por servidor".

  // Docker reporta el % de CPU de un contenedor multiplicado por el número
  // de núcleos (ver calcularCpuPorcentaje en el backend), así que la
  // "capacidad" comparable de un host con N cores es N*100.
  utilizacionDeEntorno(e: EntornoPortainer): { cpuUsadoPct: number; memUsadaGb: number; memUsadaPct: number } {
    const corriendoConRecursos = (e.contenedores || []).filter((c) => c.estado === 'running' && c.recursos);
    const cpuUsadoSuma = corriendoConRecursos.reduce((acc, c) => acc + (c.recursos!.cpuPorcentajeNum ?? 0), 0);
    const memUsadaBytes = corriendoConRecursos.reduce((acc, c) => acc + (c.recursos!.memUsoBytesNum ?? 0), 0);
    const memUsadaGb = memUsadaBytes / 1024 ** 3;

    const capacidadCpuPct = (e.cpuCores || 0) * 100;
    const cpuUsadoPct = capacidadCpuPct > 0 ? Math.min((cpuUsadoSuma / capacidadCpuPct) * 100, 100) : 0;
    const memUsadaPct = e.memoriaTotalGb ? Math.min((memUsadaGb / e.memoriaTotalGb) * 100, 100) : 0;

    return {
      cpuUsadoPct: +cpuUsadoPct.toFixed(1),
      memUsadaGb: +memUsadaGb.toFixed(2),
      memUsadaPct: +memUsadaPct.toFixed(1),
    };
  }

  // Umbrales compartidos por las barras de las tarjetas y la tabla general —
  // mismos colores que ya usa el resto del panel (verde/ámbar/rojo).
  claseNivelUso(pct: number): 'valor-ok' | 'valor-warn' | 'valor-danger' {
    if (pct >= 85) return 'valor-danger';
    if (pct >= 65) return 'valor-warn';
    return 'valor-ok';
  }

  claseKpiUso(pct: number): 'kpi-sano' | 'kpi-riesgo' | 'kpi-critico' {
    if (pct >= 85) return 'kpi-critico';
    if (pct >= 65) return 'kpi-riesgo';
    return 'kpi-sano';
  }

  get consumoServidores(): UtilizacionServidor[] {
    return this.entornosPortainer
      .filter((e) => e.estadoConexion === 'up')
      .map((e) => {
        const u = this.utilizacionDeEntorno(e);
        return {
          id: e.id,
          nombre: e.nombre,
          ip: e.ipInventario,
          cpuCores: e.cpuCores,
          memoriaTotalGb: e.memoriaTotalGb || 0,
          ...u,
          corriendo: e.resumenContenedores?.corriendo ?? 0,
          total: e.resumenContenedores?.total ?? 0,
        };
      });
  }

  // Todos los servidores activos, del que más recursos consume al que menos
  // (por el mayor de CPU%/memoria%) — se muestran todos, no sólo un "top",
  // en una tabla con scroll propio.
  get consumoServidoresOrdenados(): UtilizacionServidor[] {
    return [...this.consumoServidores].sort(
      (a, b) => Math.max(b.cpuUsadoPct, b.memUsadaPct) - Math.max(a.cpuUsadoPct, a.memUsadaPct)
    );
  }

  trackServidorConsumo(_indice: number, s: UtilizacionServidor): number {
    return s.id;
  }

  // Consumo agregado de TODA la flota — mismo cálculo que utilizacionDeEntorno
  // pero sumando capacidad y uso de todos los servidores activos antes de
  // sacar el porcentaje (no promedia porcentajes ya calculados, para no
  // distorsionar el resultado con servidores muy chicos o muy grandes).
  get usoFlota(): { cpuUsadoPct: number; memUsadaGb: number; memUsadaPct: number } {
    let capacidadCpuTotal = 0;
    let usadoCpuTotal = 0;
    let memUsadaTotal = 0;
    let capacidadMemTotal = 0;

    for (const e of this.entornosPortainer) {
      if (e.estadoConexion !== 'up') continue;
      const u = this.utilizacionDeEntorno(e);
      const cores = e.cpuCores || 0;
      capacidadCpuTotal += cores;
      usadoCpuTotal += (u.cpuUsadoPct / 100) * cores;
      memUsadaTotal += u.memUsadaGb;
      capacidadMemTotal += e.memoriaTotalGb || 0;
    }

    return {
      cpuUsadoPct: capacidadCpuTotal > 0 ? +((usadoCpuTotal / capacidadCpuTotal) * 100).toFixed(1) : 0,
      memUsadaGb: +memUsadaTotal.toFixed(1),
      memUsadaPct: capacidadMemTotal > 0 ? +((memUsadaTotal / capacidadMemTotal) * 100).toFixed(1) : 0,
    };
  }

  // ---------- Histórico (sparklines de CPU/memoria) ----------

  get haySuficienteHistorico(): boolean {
    return this.historicoPortainer.length >= 2;
  }

  private serieHistorico(campo: 'cpuPromedio' | 'memUsadaGb'): number[] {
    return this.historicoPortainer.map((p) => p[campo] || 0);
  }

  // Convierte una serie de valores en el atributo "points" de un <polyline>
  // dentro de un viewBox de 300x44 (mismo tamaño que .sparkline-svg).
  rutaSparkline(campo: 'cpuPromedio' | 'memUsadaGb'): string {
    const valores = this.serieHistorico(campo);
    if (valores.length === 0) return '';
    if (valores.length === 1) return `0,22 300,22`;

    const minimo = Math.min(...valores);
    const maximo = Math.max(...valores);
    const rango = maximo - minimo || 1;
    const paso = 300 / (valores.length - 1);

    return valores
      .map((v, i) => {
        const x = Math.round(i * paso);
        const y = Math.round(40 - ((v - minimo) / rango) * 36 + 2);
        return `${x},${y}`;
      })
      .join(' ');
  }

  ultimoValorHistorico(campo: 'cpuPromedio' | 'memUsadaGb'): number {
    const valores = this.serieHistorico(campo);
    return valores.length ? valores[valores.length - 1] : 0;
  }

  tendenciaHistorico(campo: 'cpuPromedio' | 'memUsadaGb'): 'subiendo' | 'bajando' | 'estable' {
    const valores = this.serieHistorico(campo);
    if (valores.length < 2) return 'estable';
    const diferencia = valores[valores.length - 1] - valores[0];
    const umbral = campo === 'cpuPromedio' ? 2 : 0.5;
    if (diferencia > umbral) return 'subiendo';
    if (diferencia < -umbral) return 'bajando';
    return 'estable';
  }
}
