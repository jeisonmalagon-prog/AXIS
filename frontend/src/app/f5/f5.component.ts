import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';
import { F5HistorialNodosComponent } from './f5-historial-nodos.component';

export interface DispositivoF5 {
  id: string;
  nombre: string;
}

export interface NodoResumen {
  direccion: string;
  puerto?: number | null;
  estado: string;
  motivoEstado: string | null;
  estadoMonitor?: string | null;
}

// Detalle de por qué un nodo está en problema (viene de GET /f5/:id/nodo/detalle).
export interface MonitorDetalle {
  nombre: string;
  encontrado: boolean;
  tipo: string | null;
  descripcion?: string | null;
  heredaDe?: string | null;
  intervalo?: number | null;
  tiempoLimite?: number | null;
  destino?: string | null;
  envia?: string | null;
  espera?: string | null;
  esperaDeshabilitar?: string | null;
  inverso?: boolean;
  transparente?: boolean;
  usaCredenciales?: boolean;
  cifrados?: string | null;
  certificado?: string | null;
}

export interface EstadoF5Detalle {
  disponibilidad: string | null;
  habilitado: string | null;
  razon: string | null;
  monitor: string | null;
  sesion: string | null;
}

export interface NodoDetalle {
  pool: string;
  miembro: string;
  direccion: string;
  puerto: number | null;
  estadoConfig: string | null;
  sesion: string | null;
  estadoF5: EstadoF5Detalle | null;
  razonTraducida: string | null;
  nodo: (EstadoF5Detalle & { nombre: string }) | null;
  monitorMiembro: string;
  monitorPool: string | null;
  origenMonitor: 'pool' | 'miembro';
  monitores: MonitorDetalle[];
  diagnostico: { nivel: 'alto' | 'medio' | 'info'; texto: string }[];
  consultadoEn: string;
}

export interface EstadoDetalleNodo {
  abierto: boolean;
  cargando: boolean;
  error: string | null;
  datos: NodoDetalle | null;
}

// Un nodo con problema: deshabilitado en el F5 o con el monitor de salud caído.
export interface NodoProblema {
  direccion: string;
  puerto: number | null;
  pool: string;
  poolPath: string;
  virtuales: VirtualServer[];
  deshabilitado: boolean;
  monitorCaido: boolean;
  motivos: string[];
}

export interface VirtualServer {
  nombre: string;
  fullPath: string;
  destino: string | null;
  pool: string | null;
  habilitado: boolean;
  estado: string;
  motivoEstado: string | null;
  conexionesActuales: number | null;
  conexionesTotales: number | null;
  entrada: string | null;
  salida: string | null;
  alias: string | null;
  oculto: boolean;
  nodosArriba: number | null;
  nodosTotal: number | null;
  nodos: NodoResumen[];
  nodosError: string | null;
}

// Tráfico de un nodo (miembro del pool) o de un Virtual Server. La velocidad
// (entrada/salida por segundo) la calcula el backend con dos muestras de los
// contadores del F5; viene null mientras todavía no hay dos muestras.
export interface TraficoNodo {
  conexionesActuales: number | null;
  conexionesTotales: number | null;
  datosEntrada: string | null;
  datosSalida: string | null;
  entradaBps: number | null;
  salidaBps: number | null;
  entradaTexto: string | null;
  salidaTexto: string | null;
  paquetesPorSeg: number | null;
  conexionesNuevasPorSeg: number | null;
  peticionesPorSeg?: number | null;
  conexionesMaximas?: number | null;
  peticionesTotales?: number | null;
  sesiones?: number | null;
}

export interface TraficoVivo {
  fullPath: string;
  estado: string;
  motivoEstado: string | null;
  habilitado: boolean;
  trafico: TraficoNodo;
}

export interface TotalesVivo {
  conexionesActuales: number;
  entradaBps: number | null;
  salidaBps: number | null;
  entradaTexto: string | null;
  salidaTexto: string | null;
  conexionesNuevasPorSeg: number | null;
  peticionesPorSeg: number | null;
}

export interface MetricaSistema {
  nombre: string;
  actual: string | null;
  promedio: string | null;
  maximo: string | null;
}

export interface SistemaF5 {
  hostname: string | null;
  producto: string | null;
  version: string | null;
  build: string | null;
  haEstado: string | null;
  haResumen: string | null;
  rendimiento: MetricaSistema[];
}

export interface EstadoF5 {
  disponibilidad: string | null;
  habilitado: string | null;
  razon: string | null;
  monitor: string | null;
  sesion: string | null;
}

export interface ConfigVirtual {
  descripcion: string | null;
  protocolo: string | null;
  origen: string | null;
  mascara: string | null;
  persistencia: string[];
  persistenciaRespaldo: string | null;
  snat: string | null;
  traduceDireccion: string | null;
  traducePuerto: string | null;
  reglas: string[];
  perfiles: { nombre: string; contexto: string | null }[];
  politicas: string[];
  limiteConexiones: number | null;
  habilitado: boolean;
}

export interface ConfigPool {
  metodo: string | null;
  monitor: string | null;
  minimoActivos: number | null;
  rampaLenta: number | null;
  descripcion: string | null;
  miembrosActivos: number | null;
  miembrosTotal: number | null;
  conexionesActuales: number | null;
  conexionesTotales: number | null;
  conexionesMaximas: number | null;
  sesionesActuales: number | null;
  peticionesTotales: number | null;
}

// Un punto del historial en pantalla (últimos minutos), para las gráficas chicas.
export interface PuntoTrafico {
  t: number;
  entrada: number;
  salida: number;
  conexiones: number;
}

export interface ResumenGeneral {
  virtualesTotal: number;
  arriba: number;
  abajo: number;
  desconocido: number;
  nodosArriba: number;
  nodosTotal: number;
  conexiones: number;
}

export interface ItemTop {
  v: VirtualServer;
  valor: number;
  texto: string;
  porcentaje: number;
}

export type OrdenVirtuales = 'nombre' | 'conexiones' | 'trafico' | 'estado';
export type FiltroEstado = 'todos' | 'arriba' | 'abajo' | 'desconocido';

// Cuándo tuvo tráfico por última vez un nodo, deducido por el backend al
// comparar lecturas sucesivas de los contadores del F5 (ISO 8601).
export interface ActividadNodo {
  ultimoTraficoEn: string | null;
  monitoreandoDesde: string;
  ultimaLecturaEn: string;
}

export interface ResumenActividad {
  clase: 'act-ahora' | 'act-reciente' | 'act-inactivo' | 'act-sin-dato';
  texto: string;
  detalle: string;
}

export interface MiembroPool {
  nombre: string;
  direccion: string | null;
  sesion: string | null;
  proporcion: number | null;
  estado: string;
  motivoEstado: string | null;
  conexionesActuales: number | null;
  trafico: TraficoNodo | null;
  puerto?: number | null;
  prioridad?: number | null;
  limiteConexiones?: number | null;
  monitor?: string | null;
  estadoMonitor?: string | null;
  estadoF5?: EstadoF5 | null;
  actividad?: ActividadNodo | null;
}

@Component({
  selector: 'app-f5',
  standalone: true,
  imports: [CommonModule, FormsModule, F5HistorialNodosComponent],
  templateUrl: './f5.component.html',
  styleUrl: './f5.component.scss'
})
export class F5Component implements OnInit, OnDestroy {
  dispositivos: DispositivoF5[] = [];
  dispositivoId: string | null = null;

  cargando = false;
  error = '';
  virtuales: VirtualServer[] = [];
  dispositivoNombre = '';

  // Panel de detalle de un Virtual Server puntual: destino, pool, conexiones
  // y (si tiene pool asignado) sus miembros.
  detalleAbierto = false;
  detalleVirtual: VirtualServer | null = null;
  poolCargando = false;
  poolError = '';
  miembros: MiembroPool[] = [];

  // Datos en vivo de TODO el F5 (una consulta liviana cada VIVO_MS): tráfico
  // de cada Virtual Server, totales y "los que más tráfico llevan".
  enVivo = true;
  traficoVivo = new Map<string, TraficoVivo>();
  totalesVivo: TotalesVivo | null = null;
  ultimaVivo: Date | null = null;
  errorVivo = '';
  resumen: ResumenGeneral = { virtualesTotal: 0, arriba: 0, abajo: 0, desconocido: 0, nodosArriba: 0, nodosTotal: 0, conexiones: 0 };
  topTrafico: ItemTop[] = [];
  topConexiones: ItemTop[] = [];
  sistema: SistemaF5 | null = null;
  mostrarRendimiento = false;
  filtroEstado: FiltroEstado = 'todos';
  orden: OrdenVirtuales = 'nombre';
  private temporizadorVivo: ReturnType<typeof setInterval> | null = null;
  private temporizadorSistema: ReturnType<typeof setInterval> | null = null;
  private vivoEnCurso = false;
  private readonly VIVO_MS = 10000;
  private readonly SISTEMA_MS = 30000;

  // Detalle: configuración, estado y gráficas de los últimos minutos.
  configVirtual: ConfigVirtual | null = null;
  configPool: ConfigPool | null = null;
  estadoVirtual: EstadoF5 | null = null;
  historialVirtual: PuntoTrafico[] = [];
  historialMiembros = new Map<string, PuntoTrafico[]>();
  private readonly MAX_PUNTOS = 60;

  // Tráfico en vivo: el detalle se refresca solo cada INTERVALO_REFRESCO_MS
  // mientras está abierto (la velocidad sale de comparar contra la muestra
  // anterior, así que necesita refrescos periódicos).
  traficoVirtual: TraficoNodo | null = null;
  autoActualizar = true;
  refrescandoTrafico = false;
  errorRefresco = '';
  ultimaMuestra: Date | null = null;
  private temporizador: ReturnType<typeof setInterval> | null = null;
  private readonly INTERVALO_REFRESCO_MS = 5000;

  // Edición del alias (nombre propio para identificar el Virtual Server;
  // se guarda en nuestra propia base de datos, nunca se toca el F5).
  editandoAliasDe: string | null = null;
  aliasBorrador = '';
  guardandoAlias = false;

  // Búsqueda y ocultos: filtros de la vista, no afectan lo que devuelve el
  // backend — se aplican en el navegador sobre la lista ya cargada.
  filtroTexto = '';
  mostrarOcultos = false;
  guardandoOculto: string | null = null;

  private endpoint = `${environment.apiUrl}/f5`;

  // Solo ADMIN_POD / rol ADMIN_MIN en este módulo pueden poner alias; con rol de
  // Consulta se ve todo (y se pueden ocultar tarjetas de la propia vista).
  puedeEditar = false;

  constructor(private http: HttpClient, private authService: AuthService) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('BALANCEADOR_F5');
    this.http.get<{ dispositivos: DispositivoF5[] }>(`${this.endpoint}/dispositivos`).subscribe({
      next: (data) => {
        this.dispositivos = data.dispositivos || [];
        if (this.dispositivos.length === 1) {
          // Con un solo equipo configurado no tiene sentido obligar a elegirlo.
          this.dispositivoId = this.dispositivos[0].id;
          this.cargarVirtuales();
        }
      },
      error: (err) => {
        this.error = err.error?.error || 'No se pudo cargar la lista de equipos F5.';
      }
    });
  }

  cambiarDispositivo(id: string | null): void {
    this.cerrarDetalle();
    this.detenerVivo();
    this.dispositivoId = id;
    this.virtuales = [];
    this.traficoVivo = new Map();
    this.totalesVivo = null;
    this.sistema = null;
    this.filtroTexto = '';
    this.filtroEstado = 'todos';
    this.mostrarOcultos = false;
    this.recalcularResumen();
    if (id) this.cargarVirtuales();
  }

  cargarVirtuales(): void {
    if (!this.dispositivoId) return;
    this.cargando = true;
    this.error = '';

    this.http
      .get<{ dispositivoNombre: string; virtuales: VirtualServer[] }>(`${this.endpoint}/${this.dispositivoId}/virtuales`)
      .subscribe({
        next: (data) => {
          this.dispositivoNombre = data.dispositivoNombre;
          this.virtuales = data.virtuales || [];
          this.cargando = false;
          this.aplicarVivoAVirtuales();
          this.recalcularResumen();
          this.iniciarVivo();
        },
        error: (err) => {
          this.error = err.error?.error || 'No se pudo consultar el F5.';
          this.cargando = false;
        }
      });
  }

  recargar(): void {
    this.cargarVirtuales();
    this.cargarSistema();
  }

  // Abre el detalle de un Virtual Server (destino, pool, conexiones y, si
  // tiene pool asignado, la lista de sus miembros con su estado y tráfico).
  abrirDetalle(v: VirtualServer): void {
    if (this.editandoAliasDe) return; // no abrir detalle mientras se edita el nombre

    this.detenerRefresco();
    this.detalleAbierto = true;
    this.detalleVirtual = v;
    this.miembros = [];
    this.traficoVirtual = null;
    this.ultimaMuestra = null;
    this.poolError = '';
    this.errorRefresco = '';
    this.configVirtual = null;
    this.configPool = null;
    this.estadoVirtual = null;
    this.historialVirtual = [];
    this.historialMiembros = new Map();

    if (!v.pool) {
      this.poolCargando = false;
      return;
    }

    this.poolCargando = true;
    this.cargarMiembros(true);
    this.programarRefresco();
  }

  private cargarMiembros(inicial: boolean): void {
    const v = this.detalleVirtual;
    if (!v || !v.pool || !this.dispositivoId || this.refrescandoTrafico) return;

    this.refrescandoTrafico = true;
    this.http
      .get<{
        miembros: MiembroPool[];
        traficoVirtual: TraficoNodo | null;
        estadoVirtual: EstadoF5 | null;
        configVirtual: ConfigVirtual | null;
        configPool: ConfigPool | null;
        muestreadoEn: string;
      }>(
        `${this.endpoint}/${this.dispositivoId}/pool/miembros`,
        { params: { pool: v.pool, virtual: v.fullPath } }
      )
      .subscribe({
        next: (data) => {
          // Si mientras tanto se cerró o se abrió otro detalle, se descarta.
          if (this.detalleVirtual !== v) return;
          this.miembros = data.miembros || [];
          this.traficoVirtual = data.traficoVirtual || null;
          this.estadoVirtual = data.estadoVirtual || this.estadoVirtual;
          this.configVirtual = data.configVirtual || this.configVirtual;
          this.configPool = data.configPool || this.configPool;
          this.ultimaMuestra = data.muestreadoEn ? new Date(data.muestreadoEn) : new Date();
          this.registrarHistorial();
          this.poolCargando = false;
          this.poolError = '';
          this.errorRefresco = '';
          this.refrescandoTrafico = false;
        },
        error: (err) => {
          if (this.detalleVirtual !== v) return;
          const mensaje = err.error?.error || 'No se pudo consultar los miembros del pool.';
          // En un refresco automático se conserva lo que ya se veía.
          if (inicial || !this.miembros.length) this.poolError = mensaje;
          else this.errorRefresco = mensaje;
          this.poolCargando = false;
          this.refrescandoTrafico = false;
        }
      });
  }

  private programarRefresco(): void {
    this.detenerRefresco();
    if (!this.autoActualizar) return;
    this.temporizador = setInterval(() => this.cargarMiembros(false), this.INTERVALO_REFRESCO_MS);
  }

  private detenerRefresco(): void {
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
  }

  alternarAutoActualizar(): void {
    this.autoActualizar = !this.autoActualizar;
    if (this.autoActualizar) {
      this.cargarMiembros(false);
      this.programarRefresco();
    } else {
      this.detenerRefresco();
    }
  }

  actualizarTrafico(): void {
    this.cargarMiembros(false);
  }

  cerrarDetalle(): void {
    this.detenerRefresco();
    this.detalleAbierto = false;
    this.detalleVirtual = null;
    this.refrescandoTrafico = false;
  }

  ngOnDestroy(): void {
    this.detenerRefresco();
    this.detenerVivo();
  }

  // Porcentaje del tráfico del pool que lleva un nodo: por velocidad
  // (entrada + salida) y, mientras no haya velocidad, por conexiones actuales.
  porcentajeTrafico(m: MiembroPool): number {
    const bps = (x: MiembroPool) => (x.trafico?.entradaBps || 0) + (x.trafico?.salidaBps || 0);
    const totalBps = this.miembros.reduce((acc, x) => acc + bps(x), 0);
    if (totalBps > 0) return Math.round((bps(m) / totalBps) * 100);
    const conns = (x: MiembroPool) => x.trafico?.conexionesActuales || 0;
    const totalConns = this.miembros.reduce((acc, x) => acc + conns(x), 0);
    return totalConns > 0 ? Math.round((conns(m) / totalConns) * 100) : 0;
  }

  baseReparto(): string {
    const hayVelocidad = this.miembros.some((x) => (x.trafico?.entradaBps || 0) + (x.trafico?.salidaBps || 0) > 0);
    return hayVelocidad ? 'del tráfico del pool' : 'de las conexiones del pool';
  }

  formatearNumero(n: number | null | undefined, decimales = 0): string {
    if (n === null || n === undefined) return '—';
    return n.toLocaleString('es-CO', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
  }

  trackMiembro(_i: number, m: MiembroPool): string {
    return m.nombre;
  }

  // --- Alias (nombre propio) ---
  iniciarEdicionAlias(v: VirtualServer, evento: Event): void {
    evento.stopPropagation();
    this.editandoAliasDe = v.fullPath;
    this.aliasBorrador = v.alias || '';
  }

  cancelarEdicionAlias(evento?: Event): void {
    evento?.stopPropagation();
    this.editandoAliasDe = null;
    this.aliasBorrador = '';
  }

  confirmarAlias(v: VirtualServer, evento?: Event): void {
    evento?.stopPropagation();
    if (this.guardandoAlias || !this.dispositivoId) return;

    const nuevoAlias = this.aliasBorrador.trim();
    this.guardandoAlias = true;

    this.http
      .put<{ alias: string | null }>(`${this.endpoint}/${this.dispositivoId}/alias`, {
        fullPath: v.fullPath,
        alias: nuevoAlias
      })
      .subscribe({
        next: () => {
          v.alias = nuevoAlias || null;
          this.editandoAliasDe = null;
          this.guardandoAlias = false;
        },
        error: (err) => {
          alert(err.error?.error || 'No se pudo guardar el nombre.');
          this.guardandoAlias = false;
        }
      });
  }

  // --- Búsqueda + ocultar de mi vista ---
  // Ambas cosas se resuelven sobre la lista ya cargada (this.virtuales), sin
  // volver a pedirle nada al F5: la búsqueda es puramente visual, y "ocultos"
  // combina el filtro de texto con la preferencia guardada por el usuario.
  virtualesFiltrados(): VirtualServer[] {
    const texto = this.filtroTexto.trim().toLowerCase();

    const lista = this.virtuales.filter((v) => {
      if (v.oculto && !this.mostrarOcultos) return false;
      if (this.filtroEstado !== 'todos' && this.grupoEstado(v.estado) !== this.filtroEstado) return false;
      if (!texto) return true;

      const enNombre = v.nombre.toLowerCase().includes(texto);
      const enAlias = (v.alias || '').toLowerCase().includes(texto);
      const enPool = (v.pool || '').toLowerCase().includes(texto);
      const enDestino = (v.destino || '').toLowerCase().includes(texto);
      const enNodos = v.nodos.some((n) => n.direccion.toLowerCase().includes(texto));

      return enNombre || enAlias || enPool || enDestino || enNodos;
    });

    if (this.orden === 'nombre') return lista;
    const clave = (v: VirtualServer): number => {
      if (this.orden === 'conexiones') return this.conexionesDe(v);
      if (this.orden === 'trafico') return this.bpsDe(v);
      return { abajo: 0, desconocido: 1, arriba: 2 }[this.grupoEstado(v.estado)];
    };
    return [...lista].sort((a, b) => (this.orden === 'estado' ? clave(a) - clave(b) : clave(b) - clave(a)));
  }

  grupoEstado(estado: string): 'arriba' | 'abajo' | 'desconocido' {
    const e = (estado || '').toLowerCase();
    if (e.includes('available')) return 'arriba';
    if (e.includes('offline')) return 'abajo';
    return 'desconocido';
  }

  // ---------- Tráfico en vivo de todos los Virtual Servers ----------
  traficoDe(v: VirtualServer): TraficoNodo | null {
    return this.traficoVivo.get(v.fullPath)?.trafico || null;
  }

  conexionesDe(v: VirtualServer): number {
    return this.traficoDe(v)?.conexionesActuales ?? v.conexionesActuales ?? 0;
  }

  bpsDe(v: VirtualServer): number {
    const t = this.traficoDe(v);
    return (t?.entradaBps || 0) + (t?.salidaBps || 0);
  }

  private iniciarVivo(): void {
    this.detenerVivo();
    this.cargarVivo();
    this.cargarSistema();
    if (this.enVivo) this.programarVivo();
    this.temporizadorSistema = setInterval(() => { if (!document.hidden) this.cargarSistema(); }, this.SISTEMA_MS);
  }

  private programarVivo(): void {
    if (this.temporizadorVivo) clearInterval(this.temporizadorVivo);
    this.temporizadorVivo = setInterval(() => { if (!document.hidden) this.cargarVivo(); }, this.VIVO_MS);
  }

  private detenerVivo(): void {
    if (this.temporizadorVivo) clearInterval(this.temporizadorVivo);
    if (this.temporizadorSistema) clearInterval(this.temporizadorSistema);
    this.temporizadorVivo = null;
    this.temporizadorSistema = null;
  }

  alternarVivo(): void {
    this.enVivo = !this.enVivo;
    if (this.enVivo) {
      this.cargarVivo();
      this.programarVivo();
    } else if (this.temporizadorVivo) {
      clearInterval(this.temporizadorVivo);
      this.temporizadorVivo = null;
    }
  }

  cargarVivo(): void {
    const id = this.dispositivoId;
    if (!id || this.vivoEnCurso) return;
    this.vivoEnCurso = true;
    this.http
      .get<{ virtuales: TraficoVivo[]; totales: TotalesVivo; muestreadoEn: string }>(`${this.endpoint}/${id}/trafico-virtuales`)
      .subscribe({
        next: (data) => {
          this.vivoEnCurso = false;
          if (id !== this.dispositivoId) return;
          this.traficoVivo = new Map((data.virtuales || []).map((x) => [x.fullPath, x]));
          this.totalesVivo = data.totales || null;
          this.ultimaVivo = data.muestreadoEn ? new Date(data.muestreadoEn) : new Date();
          this.errorVivo = '';
          this.aplicarVivoAVirtuales();
          this.recalcularResumen();
        },
        error: (err) => {
          this.vivoEnCurso = false;
          this.errorVivo = err.error?.error || 'No se pudo actualizar el tráfico en vivo.';
        }
      });
  }

  cargarSistema(): void {
    const id = this.dispositivoId;
    if (!id) return;
    this.http.get<SistemaF5>(`${this.endpoint}/${id}/sistema`).subscribe({
      next: (data) => { if (id === this.dispositivoId) this.sistema = data; },
      error: () => { /* información opcional: si falla, simplemente no se muestra */ }
    });
  }

  // El estado en vivo (arriba/abajo) y las conexiones también se refrescan en
  // las tarjetas, no solo el tráfico.
  private aplicarVivoAVirtuales(): void {
    for (const v of this.virtuales) {
      const vivo = this.traficoVivo.get(v.fullPath);
      if (!vivo) continue;
      v.estado = vivo.estado || v.estado;
      v.motivoEstado = vivo.motivoEstado ?? v.motivoEstado;
      v.conexionesActuales = vivo.trafico.conexionesActuales ?? v.conexionesActuales;
      v.conexionesTotales = vivo.trafico.conexionesTotales ?? v.conexionesTotales;
    }
  }

  // Panel "nodos con problema" (se abre desde el KPI de Nodos habilitados).
  nodosProblema: NodoProblema[] = [];
  verProblemas = false;

  // Recorre los pools (uno por pool, aunque varios virtuales lo compartan) y
  // junta los nodos deshabilitados o con el monitor caído, con los Virtual
  // Servers que dependen de cada uno y el motivo en palabras.
  private calcularNodosProblema(vs: VirtualServer[]): NodoProblema[] {
    const porPool = new Map<string, VirtualServer[]>();
    for (const v of vs) {
      if (!v.pool || !v.nodos || !v.nodos.length) continue;
      porPool.set(v.pool, [...(porPool.get(v.pool) || []), v]);
    }
    const lista: NodoProblema[] = [];
    for (const [pool, virtuales] of porPool) {
      for (const n of virtuales[0].nodos) {
        const deshabilitado = this.grupoEstado(n.estado) === 'abajo';
        const monitorCaido = (n.estadoMonitor || '').toLowerCase() === 'down';
        if (!deshabilitado && !monitorCaido) continue;
        const motivos: string[] = [];
        if (deshabilitado) {
          const sesion = (n.motivoEstado || '').toLowerCase();
          motivos.push(sesion.includes('user')
            ? 'Deshabilitado manualmente en el F5 (no recibe tráfico nuevo)'
            : `Deshabilitado en el F5${n.motivoEstado ? ' (sesión: ' + n.motivoEstado + ')' : ''}`);
        }
        if (monitorCaido) motivos.push('El monitor de salud del F5 lo marca caído (no responde a la verificación)');
        lista.push({
          direccion: n.direccion,
          puerto: n.puerto ?? null,
          pool: pool.split('/').filter(Boolean).pop() || pool,
          poolPath: pool,
          virtuales,
          deshabilitado,
          monitorCaido,
          motivos,
        });
      }
    }
    // Primero los caídos por monitor (más graves), luego por dirección.
    return lista.sort((a, b) => Number(b.monitorCaido) - Number(a.monitorCaido) || a.direccion.localeCompare(b.direccion, 'es', { numeric: true }));
  }

  // Chip de cada nodo en la lista: rojo si está deshabilitado o su monitor lo
  // marca caído (antes solo se miraba si estaba deshabilitado).
  claseChipNodo(n: NodoResumen): string {
    if ((n.estadoMonitor || '').toLowerCase() === 'down') return 'estado-abajo';
    return this.claseEstado(n.estado);
  }

  tituloChipNodo(n: NodoResumen): string {
    const partes = [this.textoNodo(n.estado) + (n.motivoEstado ? ' — sesión: ' + n.motivoEstado : '')];
    if ((n.estadoMonitor || '').toLowerCase() === 'down') partes.push('monitor de salud: caído');
    return partes.join(' · ');
  }

  get problemasDeshabilitados(): number { return this.nodosProblema.filter((n) => n.deshabilitado).length; }
  get problemasMonitor(): number { return this.nodosProblema.filter((n) => n.monitorCaido).length; }

  alternarProblemas(): void {
    if (this.nodosProblema.length) this.verProblemas = !this.verProblemas;
  }

  trackProblema(_i: number, n: NodoProblema): string { return `${n.pool}|${n.direccion}|${n.puerto}`; }

  // Detalle por nodo (por qué el monitor lo marca caído). Se guarda aparte, por
  // clave, para que no se pierda cuando la lista se recalcula cada 10 s.
  private detallesNodo = new Map<string, EstadoDetalleNodo>();
  private claveNodo(n: NodoProblema): string { return `${this.dispositivoId}|${n.poolPath}|${n.direccion}|${n.puerto}`; }

  detalleDe(n: NodoProblema): EstadoDetalleNodo | null { return this.detallesNodo.get(this.claveNodo(n)) || null; }

  alternarDetalleNodo(n: NodoProblema): void {
    const clave = this.claveNodo(n);
    const actual = this.detallesNodo.get(clave);
    if (actual && actual.abierto) { actual.abierto = false; return; }
    if (actual && actual.datos) { actual.abierto = true; this.cargarDetalleNodo(n); return; }
    this.detallesNodo.set(clave, { abierto: true, cargando: false, error: null, datos: null });
    this.cargarDetalleNodo(n);
  }

  cargarDetalleNodo(n: NodoProblema): void {
    const clave = this.claveNodo(n);
    const estado = this.detallesNodo.get(clave);
    const id = this.dispositivoId;
    if (!estado || !id || estado.cargando) return;
    estado.cargando = true;
    estado.error = null;
    const miembro = n.puerto !== null && n.puerto !== undefined ? `${n.direccion}:${n.puerto}` : n.direccion;
    this.http
      .get<NodoDetalle>(`${this.endpoint}/${id}/nodo/detalle`, { params: { pool: n.poolPath, miembro } })
      .subscribe({
        next: (d) => { estado.cargando = false; estado.datos = d; },
        error: (e) => {
          estado.cargando = false;
          estado.error = e?.error?.error || 'No se pudo consultar el detalle en el F5. Intenta de nuevo.';
        },
      });
  }

  textoMonitor(m: MonitorDetalle): string {
    return (m.tipo || 'desconocido').toUpperCase();
  }

  textoDisponibilidad(v: string | null | undefined): string {
    const t = (v || '').toLowerCase();
    if (t === 'available') return 'Disponible';
    if (t === 'offline') return 'Fuera de línea';
    if (t === 'unknown') return 'Desconocido';
    return v || '—';
  }

  // Abre el detalle del Virtual Server desde el panel de problemas, mostrándolo
  // aunque el filtro/búsqueda de la lista lo esté ocultando.
  abrirDesdeProblema(v: VirtualServer): void { this.abrirDetalle(v); }

  recalcularResumen(): void {
    const vs = this.virtuales;
    const r: ResumenGeneral = { virtualesTotal: vs.length, arriba: 0, abajo: 0, desconocido: 0, nodosArriba: 0, nodosTotal: 0, conexiones: 0 };
    const poolsVistos = new Set<string>();
    for (const v of vs) {
      r[this.grupoEstado(v.estado)]++;
      r.conexiones += this.conexionesDe(v);
      // Los nodos se cuentan por pool único (varios virtuales pueden compartir pool).
      if (v.pool && v.nodosTotal !== null && !poolsVistos.has(v.pool)) {
        poolsVistos.add(v.pool);
        r.nodosArriba += v.nodosArriba || 0;
        r.nodosTotal += v.nodosTotal || 0;
      }
    }
    this.resumen = r;
    this.nodosProblema = this.calcularNodosProblema(vs);
    if (!this.nodosProblema.length) this.verProblemas = false;

    const construir = (valor: (v: VirtualServer) => number, texto: (v: VirtualServer) => string): ItemTop[] => {
      const items = vs
        .filter((v) => !v.oculto)
        .map((v) => ({ v, valor: valor(v) }))
        .filter((x) => x.valor > 0)
        .sort((a, b) => b.valor - a.valor)
        .slice(0, 5);
      const max = items.length ? items[0].valor : 0;
      return items.map((x) => ({ v: x.v, valor: x.valor, texto: texto(x.v), porcentaje: max ? Math.max(3, Math.round((x.valor / max) * 100)) : 0 }));
    };
    this.topTrafico = construir(
      (v) => this.bpsDe(v),
      (v) => { const t = this.traficoDe(v); return `↓ ${t?.entradaTexto || '—'}  ↑ ${t?.salidaTexto || '—'}`; },
    );
    this.topConexiones = construir(
      (v) => this.conexionesDe(v),
      (v) => `${this.formatearNumero(this.conexionesDe(v))} conexiones`,
    );
  }

  nombreVirtual(v: VirtualServer): string {
    return v.alias || v.nombre;
  }

  // ---------- Historial en pantalla (gráficas de los últimos minutos) ----------
  private registrarHistorial(): void {
    const t = Date.now();
    const v = this.traficoVirtual;
    if (v) {
      this.historialVirtual = [...this.historialVirtual, { t, entrada: v.entradaBps || 0, salida: v.salidaBps || 0, conexiones: v.conexionesActuales || 0 }].slice(-this.MAX_PUNTOS);
    }
    for (const m of this.miembros) {
      const tr = m.trafico;
      if (!tr) continue;
      const previo = this.historialMiembros.get(m.nombre) || [];
      this.historialMiembros.set(m.nombre, [...previo, { t, entrada: tr.entradaBps || 0, salida: tr.salidaBps || 0, conexiones: tr.conexionesActuales || 0 }].slice(-this.MAX_PUNTOS));
    }
  }

  historialDe(m: MiembroPool): PuntoTrafico[] {
    return this.historialMiembros.get(m.nombre) || [];
  }

  // Puntos "x,y" para un <polyline> dentro de un viewBox 0 0 w h. `max` común
  // a las series de una misma gráfica para que sean comparables entre sí.
  puntosLinea(serie: PuntoTrafico[], campo: 'entrada' | 'salida' | 'conexiones', max: number, w = 220, h = 44): string {
    if (serie.length < 2 || max <= 0) return '';
    // Con pocas lecturas la línea ocupa solo el ancho necesario (mínimo 12
    // puntos) y a partir de ahí se va comprimiendo hasta MAX_PUNTOS.
    const paso = w / (Math.max(serie.length, 12) - 1);
    return serie
      .map((p, i) => `${(paso * i).toFixed(1)},${(h - 3 - (p[campo] / max) * (h - 6)).toFixed(1)}`)
      .join(' ');
  }

  maximoSerie(serie: PuntoTrafico[], campos: ('entrada' | 'salida' | 'conexiones')[]): number {
    let max = 0;
    for (const p of serie) for (const c of campos) if (p[c] > max) max = p[c];
    return max;
  }

  textoBps(bps: number): string {
    const unidades = ['bps', 'Kbps', 'Mbps', 'Gbps'];
    let n = bps;
    let i = 0;
    while (n >= 1000 && i < unidades.length - 1) { n /= 1000; i++; }
    return `${n.toFixed(1)} ${unidades[i]}`;
  }

  // "hace 2 h 15 min" a partir de una fecha ISO.
  textoHace(iso: string | null | undefined): string {
    if (!iso) return '';
    const seg = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seg < 60) return 'hace unos segundos';
    const min = Math.floor(seg / 60);
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return min % 60 ? `hace ${h} h ${min % 60} min` : `hace ${h} h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `hace ${d} d ${h % 24} h` : `hace ${d} d`;
  }

  private fechaCorta(iso: string): string {
    return new Date(iso).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Resumen para la tarjeta del nodo: si tiene tráfico ahora o hace cuánto fue
  // el último. Devuelve null cuando el F5 no reportó estadísticas del nodo.
  resumenActividad(m: MiembroPool): ResumenActividad | null {
    const t = m.trafico;
    if (!t) return null;
    const ahora = (t.conexionesActuales || 0) > 0
      || (t.entradaBps || 0) + (t.salidaBps || 0) > 0
      || (t.conexionesNuevasPorSeg || 0) > 0;
    if (ahora) return { clase: 'act-ahora', texto: 'Con tráfico ahora', detalle: '' };

    const a = m.actividad;
    if (a?.ultimoTraficoEn) {
      const min = (Date.now() - new Date(a.ultimoTraficoEn).getTime()) / 60000;
      return {
        clase: min < 60 ? 'act-reciente' : 'act-inactivo',
        texto: `Sin tráfico ahora · último tráfico ${this.textoHace(a.ultimoTraficoEn)}`,
        detalle: this.fechaCorta(a.ultimoTraficoEn),
      };
    }
    if (a) {
      return {
        clase: 'act-sin-dato',
        texto: `Sin tráfico desde que se empezó a monitorear (${this.textoHace(a.monitoreandoDesde)})`,
        detalle: this.fechaCorta(a.monitoreandoDesde),
      };
    }
    return null;
  }

  textoEstadoMonitor(m: MiembroPool): string {
    const e = (m.estadoMonitor || m.estadoF5?.monitor || '').toLowerCase();
    if (e === 'up') return 'Monitor: OK';
    if (e === 'down') return 'Monitor: caído';
    if (e === 'unchecked') return 'Sin monitorear';
    return e ? `Monitor: ${e}` : '';
  }

  claseMonitor(m: MiembroPool): string {
    const e = (m.estadoMonitor || m.estadoF5?.monitor || '').toLowerCase();
    if (e === 'up') return 'estado-arriba';
    if (e === 'down') return 'estado-abajo';
    return 'estado-desconocido';
  }

  // Estado de alta disponibilidad (activo / en espera) tal como lo reporta el F5.
  textoHa(e: string | null): string {
    const x = (e || '').toLowerCase();
    if (x === 'active') return 'Activo';
    if (x === 'standby') return 'En espera';
    if (x.includes('offline')) return 'Fuera de línea';
    return e || '—';
  }

  claseHa(e: string | null): string {
    const x = (e || '').toLowerCase();
    if (x === 'active') return 'chip-ok';
    if (x === 'standby') return 'chip-info-azul';
    return 'chip-mal';
  }

  etiquetaMetodo(m: string | null): string {
    const mapa: Record<string, string> = {
      'round-robin': 'Round robin',
      'least-connections-member': 'Menos conexiones (miembro)',
      'least-connections-node': 'Menos conexiones (nodo)',
      'ratio-member': 'Ratio (miembro)',
      'ratio-node': 'Ratio (nodo)',
      'fastest-node': 'Nodo más rápido',
      'observed-member': 'Observado (miembro)',
      'predictive-member': 'Predictivo (miembro)',
      'dynamic-ratio-member': 'Ratio dinámico (miembro)',
    };
    return m ? (mapa[m] || m) : '—';
  }

  contarOcultos(): number {
    return this.virtuales.filter((v) => v.oculto).length;
  }

  alternarOculto(v: VirtualServer, evento: Event): void {
    evento.stopPropagation();
    if (this.guardandoOculto || !this.dispositivoId) return;

    const nuevoOculto = !v.oculto;
    this.guardandoOculto = v.fullPath;

    this.http
      .put<{ oculto: boolean }>(`${this.endpoint}/${this.dispositivoId}/oculto`, {
        fullPath: v.fullPath,
        oculto: nuevoOculto
      })
      .subscribe({
        next: () => {
          v.oculto = nuevoOculto;
          this.guardandoOculto = null;
        },
        error: (err) => {
          alert(err.error?.error || 'No se pudo guardar la preferencia.');
          this.guardandoOculto = null;
        }
      });
  }

  // --- Resumen de nodos (miembros del pool) para la lista principal ---
  // Texto corto tipo "2/3 habilitados" para acompañar los chips de IP de
  // cada nodo (los chips ya muestran individualmente cuál está habilitado
  // -verde- y cuál deshabilitado -rojo-; esto es solo el resumen en número).
  textoNodos(v: VirtualServer): string {
    if (!v.nodosTotal) return '';
    return `${v.nodosArriba ?? 0}/${v.nodosTotal} habilitados`;
  }

  // Clasifica cualquier availabilityState de F5 en 3 grupos visuales; F5
  // puede devolver variantes como "available"/"offline"/"unknown" pero
  // también combinaciones menos comunes, así que se resuelve por inclusión.
  claseEstado(estado: string): string {
    const e = (estado || '').toLowerCase();
    if (e.includes('available')) return 'estado-arriba';
    if (e.includes('offline')) return 'estado-abajo';
    return 'estado-desconocido';
  }

  textoEstado(estado: string): string {
    const e = (estado || '').toLowerCase();
    if (e.includes('available')) return 'Arriba';
    if (e.includes('offline')) return 'Abajo';
    return 'Desconocido';
  }

  // Para los MIEMBROS de un pool el estado sale de su sesión (habilitado por
  // un admin o deshabilitado a mano), no de un chequeo de salud real — por
  // eso usan su propio texto ("Habilitado"/"Deshabilitado") en vez de
  // "Arriba"/"Abajo", que sí describe disponibilidad real (Virtual Server).
  textoNodo(estado: string): string {
    const e = (estado || '').toLowerCase();
    if (e.includes('available')) return 'Habilitado';
    if (e.includes('offline')) return 'Deshabilitado';
    return 'Desconocido';
  }
}
