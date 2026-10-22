import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, of, shareReplay } from 'rxjs';
import { environment } from '../../environments/environment';

// ============================================================================
// Informes: un informe es DATOS (KPIs, hallazgos, secciones con gráficos y
// tablas) que arma el backend (utils/informes). La pantalla, el PDF, el Excel y
// el correo salen de esa misma definición.
// ============================================================================

export type Tono = 'ok' | 'warn' | 'danger' | 'brand' | null;
export type Nivel = 'ok' | 'info' | 'aviso' | 'critico';

export interface InfKpi {
  etiqueta: string; valor: number | string | null; fmt: string; tono: Tono;
  delta: { texto: string; tono: 'ok' | 'danger' | 'neutro' } | null; nota: string | null;
}
export interface InfHallazgo { nivel: Nivel; titulo: string; detalle: string; }
export interface InfSerie { nombre: string; valores: (number | null)[]; color: string; }
export interface InfGrafico {
  tipo: 'grafico'; id: string; forma: 'linea' | 'area' | 'barras' | 'barrasH' | 'dona'; titulo: string; descripcion: string | null;
  etiquetas: string[]; fmt: string; ancho: 'medio' | null; apilado: boolean; colores: string[] | null; series: InfSerie[];
}
export interface InfColumna {
  campo: string; etiqueta: string; tipo: 'txt' | 'num' | 'fecha' | 'fechahora'; fmt?: string; peso?: number;
  tonos?: Record<string, string>; umbral?: { aviso?: number; critico?: number; mayorEsMalo?: boolean }; barra?: boolean;
}
export interface InfTabla {
  tipo: 'tabla'; id: string; titulo: string; descripcion: string | null; columnas: InfColumna[]; filas: Record<string, any>[];
  totalFilas: number; truncada: boolean; vacio: string; hoja: string;
}
export interface InfTexto { tipo: 'texto'; texto: string; }
export interface InfKpisBloque { tipo: 'kpis'; items: InfKpi[]; }
export type InfBloque = InfGrafico | InfTabla | InfTexto | InfKpisBloque;
export interface InfSeccion { id: string; titulo: string; descripcion: string | null; bloques: InfBloque[]; }
export interface Informe {
  version: number; clave: string; titulo: string; subtitulo: string; periodo: { desde: string; hasta: string } | null;
  generadoEn: string; kpis: InfKpi[]; hallazgos: InfHallazgo[]; secciones: InfSeccion[]; notas: string[];
}

export interface InformeCatalogo {
  clave: string; titulo: string; descripcion: string; categoria: string; icono: string; programable: boolean;
  secciones?: { clave: string; titulo: string }[];
}
export interface CatalogoRespuesta {
  informes: InformeCatalogo[]; periodos: { clave: string; etiqueta: string }[];
  correo: { configurado: boolean; dominios: string[] };
}
export interface ParamsInforme { periodo?: string; desde?: string; hasta?: string; secciones?: string[]; }

export interface Programado {
  id: number; nombre: string; informe: string; secciones: string[]; periodo: string; frecuencia: 'diaria' | 'semanal' | 'mensual';
  diaSemana: number | null; diaMes: number | null; hora: string; destinatarios: string[]; formatos: string[]; activo: boolean;
  ultimoEnvio: string | null; ultimoEstado: string | null; ultimoMensaje: string | null; creadoPor: string | null; propio: boolean;
}
export interface ProgramadoForm {
  nombre: string; informe: string; secciones: string[]; periodo: string; frecuencia: string; diaSemana: number | null; diaMes: number | null;
  hora: string; destinatarios: string[]; formatos: string[]; activo: boolean;
}

@Injectable({ providedIn: 'root' })
export class InformesService {
  private base = `${environment.apiUrl}/informes`;
  private catalogo$?: Observable<CatalogoRespuesta>;
  constructor(private http: HttpClient) {}

  catalogo(): Observable<CatalogoRespuesta> {
    if (!this.catalogo$) this.catalogo$ = this.http.get<CatalogoRespuesta>(`${this.base}/catalogo`).pipe(shareReplay(1));
    return this.catalogo$;
  }
  private params(p: ParamsInforme): HttpParams {
    let h = new HttpParams();
    if (p.desde && p.hasta) h = h.set('desde', p.desde).set('hasta', p.hasta);
    else if (p.periodo) h = h.set('periodo', p.periodo);
    if (p.secciones && p.secciones.length) h = h.set('secciones', p.secciones.join(','));
    return h;
  }
  obtener(clave: string, p: ParamsInforme): Observable<Informe> { return this.http.get<Informe>(`${this.base}/${clave}`, { params: this.params(p) }); }
  descargar(clave: string, formato: 'pdf' | 'xlsx', p: ParamsInforme): Observable<Blob> {
    return this.http.get(`${this.base}/${clave}/${formato}`, { params: this.params(p), responseType: 'blob' });
  }
  enviar(cuerpo: { informe: string; periodo?: string; desde?: string; hasta?: string; secciones?: string[]; destinatarios: string[]; formatos: string[]; nota?: string }) {
    return this.http.post<{ enviado: boolean; destinatarios: string[] }>(`${this.base}/enviar`, cuerpo);
  }
  programados(): Observable<{ disponible: boolean; programados: Programado[] }> { return this.http.get<{ disponible: boolean; programados: Programado[] }>(`${this.base}/programados`); }
  crearProgramado(f: ProgramadoForm) { return this.http.post<{ id: number }>(`${this.base}/programados`, f); }
  editarProgramado(id: number, f: ProgramadoForm) { return this.http.put<{ ok: boolean }>(`${this.base}/programados/${id}`, f); }
  borrarProgramado(id: number) { return this.http.delete<{ ok: boolean }>(`${this.base}/programados/${id}`); }
  enviarProgramado(id: number) { return this.http.post<{ enviado: boolean; destinatarios: string[] }>(`${this.base}/programados/${id}/enviar`, {}); }
  vacio(): Observable<null> { return of(null); }
}

// ---------------------------------------------------------------------------
// Formato de valores (mismo criterio que utils/informes/formato.js)
// ---------------------------------------------------------------------------
const nf = (v: number, d: number) => v.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d });
const nf1 = (v: number) => v.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dos = (n: number) => String(n).padStart(2, '0');

export function fmtCompactoInf(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${nf1(v / 1e9)} MM`;
  if (a >= 1e6) return `${nf1(v / 1e6)} M`;
  if (a >= 1e4) return `${nf1(v / 1e3)} k`;
  return nf(v, Number.isInteger(v) ? 0 : 1);
}
function partes(v: any): { a: number; m: number; d: number; h: number | null; mi: number | null } | null {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { a: +m[1], m: +m[2], d: +m[3], h: m[4] !== undefined ? +m[4] : null, mi: m[5] !== undefined ? +m[5] : null };
}
export function fmtFechaInf(v: any): string { const p = partes(v); return p ? `${dos(p.d)}/${dos(p.m)}/${p.a}` : '—'; }
export function fmtFechaCortaInf(v: any): string { const p = partes(v); return p ? `${p.d} ${MESES[p.m - 1]}` : '—'; }
export function fmtFechaHoraInf(v: any): string { const p = partes(v); if (!p) return '—'; return p.h === null ? fmtFechaInf(v) : `${dos(p.d)}/${dos(p.m)}/${p.a} ${dos(p.h)}:${dos(p.mi || 0)}`; }
export function fmtSegInf(s: number): string {
  if (s < 1) return `${nf(s * 1000, 0)} ms`;
  if (s < 60) return `${nf(s, s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}
export function fmtBytesInf(v: number): string {
  let n = v; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${nf(n, i === 0 ? 0 : 1)} ${u[i]}`;
}
export function formatear(valor: any, fmt?: string): string {
  if (valor === null || valor === undefined || valor === '' || (typeof valor === 'number' && !Number.isFinite(valor))) return '—';
  switch (fmt) {
    case 'n': return nf(Number(valor), 0);
    case 'n1': return nf(Number(valor), 1);
    case 'n2': return nf(Number(valor), 2);
    case 'pct': return `${nf(Number(valor), 1)} %`;
    case 'pct0': return `${nf(Number(valor), 0)} %`;
    case 'seg': return fmtSegInf(Number(valor));
    case 'gb': return `${nf(Number(valor), 2)} GB`;
    case 'bytes': return fmtBytesInf(Number(valor));
    case 'compacto': return fmtCompactoInf(Number(valor));
    case 'fecha': return fmtFechaInf(valor);
    case 'fechahora': return fmtFechaHoraInf(valor);
    default: return typeof valor === 'number' ? nf(valor, Number.isInteger(valor) ? 0 : 2) : String(valor);
  }
}
export function tonoDeCelda(col: InfColumna, valor: any): string | null {
  if (valor === null || valor === undefined || valor === '') return null;
  if (col.tonos && col.tonos[valor] !== undefined) return col.tonos[valor];
  if (col.umbral && typeof valor === 'number') {
    const { aviso, critico, mayorEsMalo = true } = col.umbral;
    if (mayorEsMalo) { if (critico !== undefined && valor >= critico) return 'danger'; if (aviso !== undefined && valor >= aviso) return 'warn'; }
    else { if (critico !== undefined && valor <= critico) return 'danger'; if (aviso !== undefined && valor <= aviso) return 'warn'; }
  }
  return null;
}
// Color de serie: los colores de marca/estado siguen el tema (claro/oscuro).
export function colorSerie(hex: string | null | undefined): string {
  switch ((hex || '').toLowerCase()) {
    case '#673ab7': return 'var(--ax-brand-primary, #673ab7)';
    case '#16a34a': return 'var(--ax-chart-ok, #16a34a)';
    case '#d97706': return 'var(--ax-chart-warn, #d97706)';
    case '#dc2626': return 'var(--ax-chart-danger, #dc2626)';
    default: return hex || 'var(--ax-brand-primary, #673ab7)';
  }
}
