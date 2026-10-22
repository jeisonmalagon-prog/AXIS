import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// ==========================================================================
// Biometría · Consumo y reusos (solo lectura sobre ORQBIOMETRIA).
// ASISA = reglas 1 y 99 (canal 0 y también canal 1, o sea hecho desde la app); OLIMPIA = todo lo demás (el canal 0 «WhoisWho» y el canal 1 con regla 0).
// Reuso = consultas repetidas de un cliente con un proveedor en un día (consultas − 1); se separan los «después de un éxito» y los «sobre el límite».
// La conexión, los umbrales y cada cuánto se recuerda la alerta los edita solo el ADMIN_POD.
// ==========================================================================

export type ProveedorConsumo = 'ASISA' | 'OLIMPIA';

export interface CupoConfig { dia: number | null; mes: number | null; valor: number | null; }

/** Límite de consultas por CLIENTE de un proveedor (null = sin límite, solo monitoreo) y si ese proveedor genera alerta por correo. */
export interface LimiteConfig { dia: number | null; mes: number | null; avisar: boolean; }

export interface ConfigConsumo {
  configurada: boolean;
  /** OLIMPIA: 5 por día y 15 por mes con alerta; ASISA: sin límite ni alerta (no tiene sobrecosto, solo se monitorea). */
  limites: Record<ProveedorConsumo, LimiteConfig>;
  alerta: boolean;
  /** Minutos entre recordatorios mientras la alerta siga activa (0 = no recordar; un caso nuevo siempre se avisa de inmediato). */
  alertaCadaMin: number;
  cupos: Record<ProveedorConsumo, CupoConfig>;
  tablaLista: boolean;
  // Solo para el ADMIN_POD (nunca viene la clave):
  servidor?: string;
  puerto?: number;
  base?: string;
  usuario?: string;
  tieneClave?: boolean;
  claveIlegible?: boolean;
  claveFin?: string | null;
  cifrado?: boolean;
  confiarCertificado?: boolean;
  windows?: boolean;
  recordatorios?: number[];
}

export interface FormConfigConsumo {
  servidor: string;
  puerto: number | null;
  base: string;
  usuario: string;
  /** Vacía = conservar la guardada. */
  clave: string;
  cifrado: boolean;
  confiarCertificado: boolean;
  limites: Record<ProveedorConsumo, { dia: number | string | null; mes: number | string | null; avisar: boolean }>;
  alerta: boolean;
  alertaCadaMin: number;
  cupos: Record<ProveedorConsumo, { dia: number | string | null; mes: number | string | null; valor: number | string | null }>;
}

export interface PruebaConexion { ok: boolean; error?: string; version?: string; base?: string; casos?: number; }

export interface Conteos {
  total: number; exitosos: number; fallidos: number; reintentos: number; pendientes: number; enProceso: number; fueraLinea: number;
  reintentosAcum: number; clientes: number;
}

export interface CupoEvaluado {
  dia: number | null; mes: number | null; valor: number | null;
  diasExcedidos: { fecha: string; total: number; exceso: number }[];
  excesoDia: number;
  mesActual: { periodo: string; total: number; clientes: number; proyeccion: number; metodoProyeccion: string; pct: number | null } | null;
  excesoMes: number;
  sobrecostoDia: number | null;
  sobrecostoMes: number | null;
}

export interface MesLimite { mes: string; clientes: number; casos: number; clientesExceden: number; excedente: number; excedenHoy: number; clientesAlLimite: number; maxIntentos: number; }
/** Estado de los límites por cliente de un proveedor (día y mes). */
export interface LimiteProveedor {
  dia: number | null; mes: number | null; avisar: boolean; soloMonitoreo: boolean;
  clientesExcedenDia: number; excesoDia: number; alLimiteHoy: number;
  meses: MesLimite[]; mesActual: MesLimite | null; clientesExcedenMes: number; excesoMes: number;
  sobrecostoDia: number | null; sobrecostoMes: number | null;
}

export interface ResumenProveedor extends Conteos {
  proveedor: ProveedorConsumo;
  tasaExito: number; tasaFallo: number; tasaReintento: number;
  promedioDiario: number;
  pico: { fecha: string | null; total: number };
  hoy: number;
  excesoClientesDia: number;
  excesoConsultas: number;
  limite: LimiteProveedor;
  previo: Conteos;
  cupo: CupoEvaluado;
  reuso: ReusoProveedor;
  habiles: PromedioDias;
  noHabiles: PromedioDias;
}

export interface ReusoProveedor {
  clientesDia: number; clientesReusan: number; reusos: number; despuesExito: number; sobreLimite: number; casos: number;
  tasa: number; tasaClientes: number; evitables: number; tasaEvitables: number; consultasPorClienteDia: number;
}
export interface PromedioDias { dias: number; casos: number; promedio: number; }

export interface FilaOrigen extends Conteos {
  proveedor: ProveedorConsumo; /** 0 = WhoisWho, 1 = app */ canal: number; canalNombre: string; regla: number; etiqueta: string;
  descripcionRegla: string | null; transaccion: string | null; consultaA: string | null;
}

export interface DiaConsumo extends Conteos { clientesExceden: number; excedente: number; maxIntentos: number; clientesAlLimite: number; reusos: number; despuesExito: number; }
export interface FilaDiaria { fecha: string; habil: boolean; motivoNoHabil: string | null; diaSemana: string; ASISA: DiaConsumo; OLIMPIA: DiaConsumo; }

export interface ConsultaRegla { proveedor: string | null; servicio: string | null; peso: number | null; }
export interface CapturaPedida { tipo: string; obligatorio: boolean; }
/**
 * REGLA (CASO.idRegla = REGLA.id): un producto/subproducto en una transacción. La transacción (Enrolamiento / Login) es un dato de la regla,
 * no su nombre; `topico` es un texto técnico de la tabla y no se usa como nombre.
 */
export interface ReglaCatalogo {
  id: number; idProductoSubProducto: number | null; producto: string | null; subproducto: string | null; descripcion: string | null;
  idTransaccion: number | null; transaccion: string | null; topico: string | null;
  intentosDia: number | null; intentosMes: number | null; vigencia: number | null; validacion: number | null;
  consulta: ConsultaRegla[]; capturas: CapturaPedida[]; clasificacion: ProveedorConsumo; coincide: boolean | null;
  uso: { casos: number; clientes: number; porCanal: Record<string, number> }; sinCatalogo?: boolean;
}

export interface HoraConsumo { total: number; reintentos: number; fallidos: number; }
export interface FilaHora { hora: number; ASISA: HoraConsumo; OLIMPIA: HoraConsumo; }

export interface ClienteIntentos {
  idCliente: number | string; documento: string | null; nombre: string | null; proveedor: ProveedorConsumo; fecha: string | null;
  intentos: number; exitosos: number; fallidos: number; reintentos: number; /** Intentos hechos desde la app (canal 1). */ viaApp: number; /** Intentos del canal 0 (WhoisWho). */ viaWhoisWho: number; /** Menor y mayor ID de caso del cliente-día. */ primerCaso: number | null; ultimoCaso: number | null; primerIntento: string | null; ultimoIntento: string | null; exceso: number;
  reusos: number; despuesExito: number; habil: boolean; motivoNoHabil: string | null;
}

export interface ClienteMes {
  idCliente: number | string; documento: string | null; nombre: string | null; proveedor: ProveedorConsumo; mes: string; limite: number;
  intentos: number; exitosos: number; fallidos: number; intentosHoy: number; diasActivo: number; primerIntento: string | null; ultimoIntento: string | null;
  exceso: number; alLimite: boolean;
}

export interface ProveedorRegistrado { proveedor: string; consultas: number; promedioDiario: number; serie: number[]; }
export interface ResultadoFrecuente { proveedor: string | null; origen: ProveedorConsumo; codigo: string | null; descripcion: string | null; total: number; }
export interface Hallazgo { nivel: 'alto' | 'medio' | 'info'; titulo: string; detalle: string; }

export interface TableroConsumo {
  generado: string;
  duracionMs: number;
  deCache: boolean;
  hoy: string;
  filtro: { desde: string; hasta: string; dias: number; comparadoCon: { desde: string; hasta: string } };
  umbrales: { limites: Record<ProveedorConsumo, LimiteConfig>; cupos: Record<ProveedorConsumo, CupoConfig> };
  estados: Record<string, string | null>;
  general: {
    total: number; previo: number; reintentos: number; reintentosAcum: number; exitosos: number; fallidos: number; excesoClientesDia: number; excesoConsultas: number; excesoClientesMes: number; excesoConsultasMes: number;
    reusos: number; reusosEvitables: number; clientesReusan: number; clientesDia: number; tasaReuso: number; casosHabiles: number; casosNoHabiles: number;
  };
  proveedores: ResumenProveedor[];
  origenes: FilaOrigen[];
  reglas: ReglaCatalogo[];
  calendario: { fuente: string; diasHabiles: number; diasNoHabiles: number; festivos: string[] };
  tiposDocumento: { id: number | null; nombre: string | null }[];
  diaria: FilaDiaria[];
  horas: FilaHora[];
  topClientes: ClienteIntentos[];
  /** Clientes que llegaron o pasaron el límite MENSUAL de su proveedor. */
  clientesMes: ClienteMes[];
  proveedoresReg: ProveedorRegistrado[];
  resultados: ResultadoFrecuente[];
  hallazgos: Hallazgo[];
  avisos: { seccion: string; error: string }[];
}

// ---- Detalle de un cliente en un día ----
export interface ResultadoCaso { respondio: string | null; codigo: string | null; descripcion: string | null; /** EXITOSO / FALLIDO / REINTENTAR / PENDIENTE */ homologacion: string | null; total: number; }
export interface CasoDetalle {
  id: number | string; hora: string | null; proveedor: ProveedorConsumo; canal: number; canalNombre: string; regla: number;
  producto: string | null; subproducto: string | null; descripcionRegla: string | null; transaccion: string | null;
  estado: number; estadoNombre: string; reintentos: number; numero: number; minDesdeAnterior: number | null;
  esReuso: boolean; despuesExito: boolean; sobreLimite: boolean; excedeRegla: boolean;
  capturas: number; tiposCaptura: { tipo: string; total: number }[]; resultados: ResultadoCaso[];
}
export interface ReglaDetalle {
  regla: number; descripcion: string | null; idValidacion: number | null; transaccion: string | null; producto: string | null; subproducto: string | null; topico: string | null; clasificacion: ProveedorConsumo;
  consulta: ConsultaRegla[]; capturasPedidas: CapturaPedida[]; coincide: boolean | null;
  intentosDia: number | null; intentosMes: number | null; vigencia: number | null;
  usadosHoy: number; usadosMes: number; contadorDia: number | null; contadorMes: number | null; excedeDia: boolean; excedeMes: boolean;
}
export interface DetalleClienteDia {
  cliente: { idCliente: string; documento: string | null; nombre: string | null; tipoDocumento: string | null };
  fecha: string; diaSemana: string; habil: boolean; motivoNoHabil: string | null; proveedorFoco: ProveedorConsumo | null; limite: number | null; limites: Record<ProveedorConsumo, LimiteConfig>;
  resumen: {
    casos: number; exitosos: number; fallidos: number; reintentos: number; otros: number; viaApp: number; viaWhoisWho: number; reusos: number; despuesExito: number; sobreLimite: number;
    tasaExito: number; primerIntento: string | null; ultimoIntento: string | null; duracionMin: number; minEntreIntentosMediana: number | null; minEntreIntentosMin: number | null; truncado: boolean;
  };
  porProveedor: { proveedor: ProveedorConsumo; casos: number; exitosos: number; fallidos: number; reintentos: number; reusos: number; despuesExito: number; sobreLimite: number; limiteDia: number | null; limiteMes: number | null; avisar: boolean }[];
  casos: CasoDetalle[];
  horas: number[];
  reglas: ReglaDetalle[];
  historial: { fecha: string; habil: boolean; ASISA: number; OLIMPIA: number }[];
  mes: { periodo: string; ASISA: number; OLIMPIA: number; sobreLimite: Record<ProveedorConsumo, number> };
  diasActivos30: number;
  avisos: { seccion: string; error: string }[];
}

@Injectable({ providedIn: 'root' })
export class BiometriaConsumoService {
  private base = `${environment.apiUrl}/biometria-consumo`;

  constructor(private http: HttpClient) {}

  config(): Observable<ConfigConsumo> {
    return this.http.get<ConfigConsumo>(`${this.base}/config`);
  }

  guardarConfig(form: FormConfigConsumo): Observable<ConfigConsumo> {
    return this.http.put<ConfigConsumo>(`${this.base}/config`, form);
  }

  /** Sin cuerpo: prueba lo guardado. Con el formulario: prueba el borrador sin guardarlo. */
  probarConexion(form?: FormConfigConsumo): Observable<PruebaConexion> {
    return this.http.post<PruebaConexion>(`${this.base}/config/probar`, form ?? {});
  }

  probarAlerta(): Observable<{ ok: boolean; mensaje: string }> {
    return this.http.post<{ ok: boolean; mensaje: string }>(`${this.base}/config/probar-alerta`, {});
  }

  tablero(desde: string, hasta: string, forzar = false): Observable<TableroConsumo> {
    return this.http.post<TableroConsumo>(`${this.base}/tablero`, { desde, hasta, forzar });
  }

  detalleClienteDia(idCliente: number | string, fecha: string, proveedor: ProveedorConsumo | null): Observable<DetalleClienteDia> {
    return this.http.post<DetalleClienteDia>(`${this.base}/cliente-dia`, { idCliente, fecha, proveedor });
  }
}
