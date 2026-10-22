import { CertificadoVigencia } from '../../core/models/models';

// ============================================================================
// Un CERTIFICADO (lo que la gente entiende) puede estar instalado en varias
// UBICACIONES (servidor + componente). En la base de datos cada ubicación es
// una fila de la tabla Certificados; aquí se juntan las filas que son el mismo
// certificado (mismo nombre común, emisor, serie, thumbprint y vencimiento)
// para mostrarlas como un solo certificado "instalado en N ubicaciones".
// ============================================================================

export type EstadoCertificado = 'Vigente' | 'Por vencer' | 'Vencido';

export interface GrupoCertificado {
  clave: string;
  nombreComun: string | null;
  entidadEmisora: string | null;
  numeroSerie: string | null;
  thumbprint: string | null;
  fechaInicio: string;
  fechaFin: string;
  responsable: string | null;
  observaciones: string | null;
  estado: EstadoCertificado;
  diasRestantes: number;
  filas: CertificadoVigencia[];
}

export function idDe(c: any): number {
  return Number(c?.Id ?? c?.id ?? c?.CertificadoId ?? c?.ID ?? 0);
}

export function soloFecha(f: any): string {
  if (!f) return '';
  const t = String(f);
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  try {
    return new Date(f).toISOString().split('T')[0];
  } catch (e) {
    return t.slice(0, 10);
  }
}

function norm(v: any): string {
  return (v ?? '').toString().trim().toLowerCase();
}

export function claveGrupo(c: CertificadoVigencia): string {
  return [c.NombreComun, c.EntidadEmisora, c.NumeroSerie, c.Thumbprint, soloFecha(c.FechaFin)].map(norm).join('|');
}

export function agruparCertificados(lista: CertificadoVigencia[]): GrupoCertificado[] {
  const mapa = new Map<string, GrupoCertificado>();
  for (const c of lista) {
    const clave = claveGrupo(c);
    let g = mapa.get(clave);
    if (!g) {
      g = {
        clave,
        nombreComun: c.NombreComun,
        entidadEmisora: c.EntidadEmisora,
        numeroSerie: c.NumeroSerie,
        thumbprint: c.Thumbprint,
        fechaInicio: soloFecha(c.FechaInicio),
        fechaFin: soloFecha(c.FechaFin),
        responsable: c.Responsable,
        observaciones: c.Observaciones,
        estado: c.Estado,
        diasRestantes: c.DiasRestantes,
        filas: [],
      };
      mapa.set(clave, g);
    }
    g.filas.push(c);
    // Datos "de cabecera": si la primera fila no los tenía, se toman de otra.
    if (!g.responsable && c.Responsable) g.responsable = c.Responsable;
    if (!g.observaciones && c.Observaciones) g.observaciones = c.Observaciones;
  }
  return Array.from(mapa.values());
}
