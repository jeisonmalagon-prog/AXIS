// Utilidades y tipos comunes de las pestañas de Azure DevOps (Repositorio).
import { HttpErrorResponse } from '@angular/common/http';
export { fmtNum, fmtDec, fmtPct, fmtDuracion, fmtRelativo, fmtFecha, descargarCsv } from '../../n8n/n8n-utils';

// Fallo de una sección o de una petición. Cuando el token (PAT) de Azure DevOps no
// tiene un permiso, el backend lo indica en `codigo` y `permisoRequerido`.
export interface FalloAzure {
  error: string;
  codigo?: string | null;
  permisoRequerido?: string | null;
  area?: string | null;
}

// Una sección de una respuesta compuesta (ej. el Resumen): datos o fallo, nunca ambos.
export interface Seccion<T> extends Partial<FalloAzure> {
  datos?: T;
}

export function falloDe(err: any, porDefecto: string): FalloAzure {
  const e = err as HttpErrorResponse;
  const cuerpo = e?.error;
  return {
    error: (cuerpo && typeof cuerpo === 'object' && cuerpo.error) || porDefecto,
    codigo: cuerpo?.codigo ?? null,
    permisoRequerido: cuerpo?.permisoRequerido ?? null,
    area: cuerpo?.area ?? null,
  };
}

export type ClaseEstado = 'ok' | 'mal' | 'aviso' | 'info' | 'nulo';

// Grupo de build (exitoso / fallido / ...) -> color.
export function claseGrupo(g: string | null | undefined): ClaseEstado {
  switch (g) {
    case 'exitoso': return 'ok';
    case 'fallido': return 'mal';
    case 'parcial': return 'aviso';
    case 'cancelado': return 'nulo';
    case 'enCurso': case 'enCola': return 'info';
    default: return 'nulo';
  }
}

export function textoGrupo(g: string | null | undefined): string {
  return ({ exitoso: 'Exitoso', fallido: 'Fallido', parcial: 'Parcial', cancelado: 'Cancelado', enCurso: 'En curso', enCola: 'En cola', otro: '—' } as Record<string, string>)[g || ''] || '—';
}

// Resultado de un paso del timeline de un build.
export function claseTimeline(estado: string | null, resultado: string | null): ClaseEstado {
  if (estado === 'inProgress') return 'info';
  if (estado === 'pending' || estado === 'notStarted') return 'nulo';
  switch (resultado) {
    case 'succeeded': return 'ok';
    case 'succeededWithIssues': return 'aviso';
    case 'failed': return 'mal';
    case 'canceled': case 'abandoned': case 'skipped': return 'nulo';
    default: return 'nulo';
  }
}

export function textoTimeline(estado: string | null, resultado: string | null): string {
  if (estado === 'inProgress') return 'En curso';
  if (estado === 'pending') return 'Pendiente';
  return ({ succeeded: 'Exitoso', succeededWithIssues: 'Con avisos', failed: 'Fallido', canceled: 'Cancelado', skipped: 'Omitido', abandoned: 'Abandonado' } as Record<string, string>)[resultado || ''] || (estado === 'completed' ? 'Completado' : '—');
}

export function claseAmbiente(estado: string | null | undefined): ClaseEstado {
  switch (estado) {
    case 'succeeded': return 'ok';
    case 'rejected': case 'failed': return 'mal';
    case 'partiallySucceeded': case 'canceled': return 'aviso';
    case 'inProgress': case 'queued': case 'scheduled': return 'info';
    default: return 'nulo';
  }
}

export function iniciales(nombre: string | null | undefined): string {
  const partes = (nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  return partes.slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

export function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

// "2026-10-05" -> "05 oct"
export function fmtDiaCorto(clave: string): string {
  const [a, m, d] = clave.split('-').map(Number);
  if (!a || !m || !d) return clave;
  return new Date(a, m - 1, d).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }).replace('.', '');
}

export function claseTasa(t: number | null | undefined): ClaseEstado {
  if (t === null || t === undefined) return 'nulo';
  return t >= 90 ? 'ok' : t >= 70 ? 'aviso' : 'mal';
}

export function horaTexto(h: number | null | undefined): string {
  return h === null || h === undefined ? '—' : `${String(h).padStart(2, '0')}:00`;
}

export interface PersonaConteo { nombre: string; cantidad: number; }
