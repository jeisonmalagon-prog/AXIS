// Utilidades y tipos compartidos por las pantallas del módulo Orquestador n8n.

export const N8N_BASE_URL = 'https://10.254.55.157:5678';

export interface DuracionResumen { n: number; prom: number | null; p50: number | null; p95: number | null; max: number | null; min?: number | null; total?: number; }

export interface FlujoN8n {
  id: string;
  nombre: string;
  activo: boolean;
  cuentaId: string;
  cuentaNombre: string;
  etiquetas: string[];
  nodos: number | null;
  disparadores: string[];
  creado: string | null;
  actualizado: string | null;
  totalEjecuciones: number;
  exitosas: number;
  fallidas: number;
  canceladas: number;
  enCurso: number;
  esperando: number;
  tasaExito: number | null;
  duracion: DuracionResumen;
  ultimaEjecucion: string | null;
  ultimoEstado: string;
  ultimaExitosa: string | null;
  ultimaFallida: string | null;
  racha: number;
  modos: Record<string, number>;
  spark: number[];
  sparkFallos: number[];
  sinEjecutar: boolean;
  enCursoMasLargaMs: number | null;
  motivos: MotivoAtencion[];
  // Solo para ADMIN_POD con el control de acceso activado.
  usuariosConAcceso?: number;
}

export interface MotivoAtencion { codigo: string; severidad: 'alta' | 'media' | 'baja'; texto: string; }

export interface PuntoSerie {
  clave: string; etiqueta: string; fecha?: string; hora?: number | null;
  exitosas: number; fallidas: number; otras: number; total: number; durProm: number | null;
}

export interface EjecucionReciente {
  id: string; workflowId: string; flujo: string; cuentaNombre: string | null;
  estado: string; grupo: string; modo: string; inicio: string; duracion: number | null;
}

// --- Formato ---------------------------------------------------------------

const NUM = new Intl.NumberFormat('es-CO');
const NUM1 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });

export function fmtNum(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : NUM.format(v);
}

export function fmtDec(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : NUM1.format(v);
}

export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${NUM1.format(v)}%`;
}

// ms -> "850 ms", "12,3 s", "2 min 5 s", "1 h 3 min"
export function fmtDuracion(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${NUM1.format(s)} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ${Math.round(s - min * 60)} s`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min - h * 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// "hace 5 min", "hace 3 h", "hace 2 d"
export function fmtRelativo(iso: string | null | undefined, ahora = Date.now()): string {
  if (!iso) return 'Nunca';
  const diff = ahora - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '—';
  if (diff < 45000) return 'hace instantes';
  const min = Math.round(diff / 60000);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 60) return `hace ${d} d`;
  return `hace ${Math.round(d / 30)} meses`;
}

export function fmtFecha(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtHora(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const ETIQUETA_ESTADO: Record<string, string> = {
  success: 'Exitosa', error: 'Fallida', crashed: 'Caída', canceled: 'Cancelada', running: 'En curso',
  new: 'En cola', waiting: 'En espera', sin_datos: 'Sin datos', unknown: 'Desconocido',
};

export function etiquetaEstado(estado: string): string { return ETIQUETA_ESTADO[estado] || estado; }

// Clase de color para un estado crudo de n8n.
export function claseEstado(estado: string): 'ok' | 'mal' | 'aviso' | 'info' | 'nulo' {
  if (estado === 'success') return 'ok';
  if (estado === 'error' || estado === 'crashed') return 'mal';
  if (estado === 'canceled') return 'aviso';
  if (estado === 'running' || estado === 'new' || estado === 'waiting') return 'info';
  return 'nulo';
}

export function claseTasa(t: number | null | undefined): 'ok' | 'aviso' | 'mal' | 'nulo' {
  if (t === null || t === undefined) return 'nulo';
  return t >= 90 ? 'ok' : t >= 70 ? 'aviso' : 'mal';
}

export function mensajeHttp(err: any, porDefecto: string): string {
  return err?.error?.error || porDefecto;
}

export function descargarCsv(nombre: string, filas: (string | number | null)[][]): void {
  const esc = (v: string | number | null) => {
    const t = v === null || v === undefined ? '' : String(v);
    // Evita que Excel interprete una celda como fórmula.
    const seguro = /^[=+\-@]/.test(t) ? `'${t}` : t;
    return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
  };
  const texto = '﻿' + filas.map((f) => f.map(esc).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
