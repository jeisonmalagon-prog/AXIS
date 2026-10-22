import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Tipos y llamadas del tablero de monitoreo (GET /api/app-movil/tablero/...).
// Todo sale de las tablas de resumen del ETL: ninguna consulta toca LogApp.

export type Semaforo = 'ok' | 'aviso' | 'critico';

export interface RangoApp {
  dias: number;
  fechaInicio?: string;
  fechaFin?: string;
}

export interface NoDisponible { disponible: false; mensaje: string; }

export interface PuntoSerie {
  dia: string;
  sinDato: boolean;
  total: number;
  errores: number;
  exitosas: number;
  tasaExito: number | null;
  usuarios: number;
  sesiones: number;
  latenciaPromedio: number | null;
  latenciaMaxima: number | null;
  loginPromedio: number | null;
  actualizado: string | null;
}

export interface ResumenSerie {
  total: number;
  errores: number;
  tasaExito: number | null;
  usuariosPico: number;
  usuariosPromedio: number;
  diasConDato: number;
  diasTotales: number;
  latenciaPromedio: number | null;
  loginPromedio: number | null;
}

export interface DiaSemana { dia: string; diasMedidos: number; promedio: number; tasaError: number | null; }

export interface SerieResponse {
  disponible: true;
  rango: { inicio: string; fin: string; dias: number };
  rangoAnterior: { inicio: string; fin: string };
  serie: PuntoSerie[];
  anterior: PuntoSerie[];
  resumen: ResumenSerie;
  resumenAnterior: ResumenSerie;
  deltas: {
    total: number | null; errores: number | null; usuarios: number | null; latencia: number | null; login: number | null;
    tasaExitoPuntos: number | null;
  };
  semana: DiaSemana[];
  generado: string;
}

export interface ServicioLatencia {
  clase: string;
  metodo: string;
  nombre: string;
  llamadasMedidas: number;
  promedio: number | null;
  maximo: number | null;
  promedioAnterior: number | null;
  deltaPct: number | null;
  empeora: boolean;
  estado: Semaforo;
  total: number;
  errores: number;
  tasaExito: number | null;
  serie: (number | null)[];
}

export interface LatenciaTableroResponse {
  disponible: true;
  rango: { inicio: string; fin: string; dias: number };
  dias: string[];
  umbrales: { aviso: number; critico: number };
  promedioGlobal: number | null;
  llamadasMedidas: number;
  servicios: ServicioLatencia[];
}

export interface ClienteTop { documento: string; total: number; errores: number; dias: number; tasaError: number; }

export interface ClientesTableroResponse {
  disponible: true;
  rango: { inicio: string; fin: string; dias: number };
  recortado: boolean;
  resumen: {
    clientes: number; clientesConErrores: number; porcentajeConErrores: number; transacciones: number;
    errores: number; promedioPorCliente: number; concentracionTop10: number;
  };
  masActivos: ClienteTop[];
  masErrores: ClienteTop[];
  mayorTasaError: ClienteTop[];
}

export interface ItemSemaforo { clave: string; titulo: string; estado: Semaforo; detalle: string; }

export interface TablaEtl {
  tabla: string; etiqueta: string; descripcion: string; existe: boolean;
  filasAprox?: number; bytes?: number; desde?: string | null; hasta?: string | null;
}

export interface AlertaReciente {
  Id: number; detectada: string; ultimaVista: string; titulo: string; tipo: string; categoria: string | null;
  errores: number; clientes: number; tasaError: number; servicio: string | null;
}

export interface EstadoTablero {
  disponible: true;
  generado: string;
  semaforo: Semaforo;
  items: ItemSemaforo[];
  etl: {
    enCurso: boolean; enCursoDesde: number | null; ultimoInicio: number | null; ultimoFin: number | null;
    ultimoOk: number | null; ultimoError: string | null; ultimoErrorEn: number | null; ciclos: number;
    arrancado: number | null; intervaloMin: number;
  };
  hoy: { total: number; errores: number; usuarios: number; tasaExito: number | null; actualizado: string; tasaSemanaAnterior: number | null } | null;
  cobertura: { dias: number; conDato: number; faltantes: string[] };
  tablas: TablaEtl[];
  alertas: { disponible: boolean; ultimas24h: number; ultimos7d: number; recientes: AlertaReciente[] };
}

export function paramsRango(r: RangoApp): HttpParams {
  let p = new HttpParams();
  if (r.fechaInicio && r.fechaFin) p = p.set('fechaInicio', r.fechaInicio).set('fechaFin', r.fechaFin);
  else p = p.set('dias', String(r.dias));
  return p;
}

export function fmtCompacto(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} M`;
  if (a >= 10_000) return `${Math.round(n / 1000).toLocaleString('es-CO')} k`;
  if (a >= 1_000) return `${(n / 1000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} k`;
  return n.toLocaleString('es-CO');
}

export function fmtSeg(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${n.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} s`;
}

export function fmtFechaCorta(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }).replace('.', '');
}

export function fmtFechaLarga(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  return d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '');
}

export function hace(ms: number | null | undefined): string {
  if (!ms) return '—';
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 1) return 'hace instantes';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h ${min % 60} min`;
  return `hace ${Math.floor(h / 24)} d`;
}

@Injectable({ providedIn: 'root' })
export class TableroService {
  private readonly api = `${environment.apiUrl}/app-movil/tablero`;
  constructor(private http: HttpClient) {}

  estado(): Observable<EstadoTablero | NoDisponible> { return this.http.get<EstadoTablero | NoDisponible>(`${this.api}/estado`); }
  serie(r: RangoApp): Observable<SerieResponse | NoDisponible> { return this.http.get<SerieResponse | NoDisponible>(`${this.api}/serie`, { params: paramsRango(r) }); }
  latencia(r: RangoApp): Observable<LatenciaTableroResponse | NoDisponible> { return this.http.get<LatenciaTableroResponse | NoDisponible>(`${this.api}/latencia`, { params: paramsRango(r) }); }
  clientes(r: RangoApp, limite = 15): Observable<ClientesTableroResponse | NoDisponible> {
    return this.http.get<ClientesTableroResponse | NoDisponible>(`${this.api}/clientes`, { params: paramsRango(r).set('limite', String(limite)) });
  }
}
