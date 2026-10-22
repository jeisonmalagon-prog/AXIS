import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// Inventario → Puertos. Solo lectura. La pantalla usa Portainer (sin SSH): puertos publicados por
// los contenedores de cada servidor, comparados con el inventario, y sugerencia de puertos libres.
// Los tipos y métodos de SSH/WinRM de más abajo se conservan por compatibilidad con el backend.

export type AlcancePuerto = 'todas' | 'local' | 'especifica';
export type MetodoPuertos = 'ssh' | 'winrm';

export type EstadoInventario = 'inventariado' | 'sistema' | 'no_inventariado';

/** Componente del inventario (Servidor_Componentes) que ocupa ese puerto en ese servidor. */
export interface InventarioPuerto {
  id: number;
  rol: string | null;
  tipo: string | null;
  aplicaciones: string[];
}

/** Componente registrado en el inventario con un puerto que hoy no está escuchando. */
export interface InventarioSinEscuchar extends InventarioPuerto {
  puerto: number;
}

export interface PuertoFila {
  puerto: number;
  protocolo: 'TCP' | 'UDP';
  /** todas = escucha en todas las interfaces; local = solo 127.0.0.1/::1; especifica = una IP concreta. */
  alcance: AlcancePuerto;
  direcciones: string[];
  proceso: string | null;
  pid: number | null;
  /** Contenedor Docker que publicó el puerto (solo Linux). */
  contenedor: string | null;
  /** inventariado = está en el inventario; sistema = servicio del SO; no_inventariado = hay que revisarlo. */
  estadoInventario?: EstadoInventario;
  inventario?: InventarioPuerto[];
}

export interface ResumenPuertos {
  total: number;
  tcp: number;
  udp: number;
  expuestos: number;
  soloLocal: number;
  inventariados?: number;
  delSistema?: number;
  sinInventariar?: number;
  inventarioSinEscuchar?: number;
  componentesSinPuerto?: number;
}

export interface ServidorPuertos {
  id: number;
  hostname: string;
  ip: string;
  ambiente: string | null;
  activo: boolean;
  sistemaOperativo: string | null;
  /** Solo Linux y Windows se pueden consultar. */
  consultable: boolean;
  /** Canales con los que hoy se puede consultar según la configuración del backend. */
  metodos: MetodoPuertos[];
}

export interface ListaServidoresPuertos {
  sshConfigurado: boolean;
  winrmConfigurado: boolean;
  servidores: ServidorPuertos[];
}

export interface ResultadoPuertos {
  id: number;
  hostname: string;
  ip: string;
  ambiente: string | null;
  sistemaOperativo: string | null;
  ok: boolean;
  error: string | null;
  consultadoEn: string;
  duracionMs: number;
  sistema?: string;
  /** Canal que se usó: SSH o WinRM. */
  metodo?: MetodoPuertos;
  fuente?: string;
  puertos: PuertoFila[];
  resumen: ResumenPuertos | null;
  /** false = el usuario SSH no es root: puede haber puertos sin el nombre de su proceso. */
  procesosCompletos?: boolean;
  hayDocker?: boolean;
  inventarioSinEscuchar?: InventarioSinEscuchar[];
  /** Mensaje si no se pudo leer el inventario para comparar. */
  errorInventario?: string | null;
}

// ---------------------------------------------------------------- Puertos según Portainer (sin SSH)

/** sin_servidor = el entorno de Portainer no coincide con ningún servidor del inventario (no hay con qué comparar). */
export type EstadoInventarioPortainer = EstadoInventario | 'sin_servidor';

/** Un puerto del servidor publicado por un contenedor. */
export interface PuertoPortainer {
  puerto: number;
  protocolo: 'TCP' | 'UDP';
  /** Puerto dentro del contenedor (el «-p 8080:80» → 80). */
  destino: number | null;
  alcance: AlcancePuerto;
  direcciones: string[];
  contenedor: string;
  contenedorId: string;
  imagen: string;
  /** Stack o proyecto compose, si el contenedor lo trae. */
  stack: string | null;
  estado: string;
  /** true = el contenedor está detenido: el puerto no está en uso hoy pero queda reservado. */
  reservado: boolean;
  estadoInventario: EstadoInventarioPortainer;
  inventario: InventarioPuerto[];
}

export interface ResumenEntornoPuertos {
  total: number;
  enUso: number;
  reservados: number;
  contenedoresConPuertos: number;
  sinInventariar: number;
  inventariados: number;
  inventarioSinEscuchar: number;
  componentesSinPuerto: number;
}

/** Un servidor Docker (environment de Portainer). */
export interface EntornoPuertos {
  id: number;
  nombre: string;
  conexion: 'up' | 'down';
  ip: string | null;
  ok: boolean;
  error: string | null;
  contenedores: number;
  puertos: PuertoPortainer[];
  /** Contenedores con red «host»: Docker no informa sus puertos. */
  redHost: { contenedor: string; imagen: string }[];
  /** Contenedores detenidos cuyos puertos reservados no se leyeron (límite por servidor). */
  reservasSinLeer: number;
  inventarioSinEscuchar: InventarioSinEscuchar[];
  puertosInventario: number[];
  servidorId: number | null;
  hostname: string | null;
  ipInventario: string | null;
  ambiente: string | null;
  servidorInventariado: boolean;
  resumen: ResumenEntornoPuertos;
}

export interface RespuestaPuertosPortainer {
  configurado: boolean;
  entornos: EntornoPuertos[];
  consultadoEn: string | null;
  error: string | null;
  errorInventario?: string | null;
}

export interface NormaPuerto {
  id: string;
  nombre: string;
  desde: number;
  hasta: number;
  descripcion: string;
}

export interface NormasPuertos {
  tipos: NormaPuerto[];
  reservados: number[];
  /** archivo = backend/config/puertos-normas.json; por_defecto = rangos propuestos que trae la aplicación. */
  origen: 'archivo' | 'por_defecto';
  aviso: string | null;
}

export interface PuertoSugerido {
  puerto: number;
  /** true = no lo usa ningún servidor: sirve en cualquiera. */
  libreEnTodos: boolean;
  /** Servidores que lo usan (si no es libre en todos). */
  usadoEn: string[];
}

export interface SugerenciaPuertos {
  tipo: NormaPuerto;
  destino: string;
  cantidadPedida: number;
  sugeridos: PuertoSugerido[];
  ocupadosEnRango: number;
  tamanoRango: number;
  mensaje: string | null;
  consultadoEn: string | null;
  normasOrigen: 'archivo' | 'por_defecto';
}

@Injectable({ providedIn: 'root' })
export class PuertosService {
  private base = `${environment.apiUrl}/puertos`;

  constructor(private http: HttpClient) {}

  servidores(): Observable<ListaServidoresPuertos> {
    return this.http.get<ListaServidoresPuertos>(`${this.base}/servidores`);
  }

  consultar(id: number): Observable<ResultadoPuertos> {
    return this.http.get<ResultadoPuertos>(`${this.base}/servidor/${id}`);
  }

  /** Puertos publicados por los contenedores de todos los servidores, según Portainer (sin SSH). */
  portainer(forzar = false): Observable<RespuestaPuertosPortainer> {
    return this.http.get<RespuestaPuertosPortainer>(`${this.base}/portainer${forzar ? '?forzar=1' : ''}`);
  }

  normas(): Observable<NormasPuertos> {
    return this.http.get<NormasPuertos>(`${this.base}/normas`);
  }

  sugerir(tipo: string, entorno: number | 'todos', cantidad: number): Observable<SugerenciaPuertos> {
    return this.http.get<SugerenciaPuertos>(`${this.base}/sugerir`, { params: { tipo, entorno: String(entorno), cantidad: String(cantidad) } });
  }
}
