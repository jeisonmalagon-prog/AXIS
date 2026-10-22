// Orden "natural" de códigos de servicio ACE: C001, C002, ... C010, ... C170,
// C170V2. Compara primero el número del código (así C9 va antes que C10, cosa
// que un orden alfabético no hace) y luego el sufijo ("V1" < "V2"). Los
// servicios sin código válido van al final, ordenados por nombre.
function partesCodigo(codigo: string | null | undefined): { numero: number; sufijo: string } | null {
  const m = /^\s*[A-Za-z]*\s*0*(\d+)\s*(.*)$/.exec(codigo || '');
  if (!m) return null;
  return { numero: parseInt(m[1], 10), sufijo: (m[2] || '').trim() };
}

export function compararCodigoAce(
  a: { Codigo?: string | null; Nombre?: string | null },
  b: { Codigo?: string | null; Nombre?: string | null },
): number {
  const pa = partesCodigo(a.Codigo);
  const pb = partesCodigo(b.Codigo);
  if (pa && pb) {
    if (pa.numero !== pb.numero) return pa.numero - pb.numero;
    return pa.sufijo.localeCompare(pb.sufijo, undefined, { numeric: true, sensitivity: 'base' });
  }
  if (pa) return -1;
  if (pb) return 1;
  return (a.Nombre || '').localeCompare(b.Nombre || '');
}

// Opciones del selector "Ordenar por" de las vistas de servicios ACE.
export type OrdenAce = 'codigo-asc' | 'codigo-desc' | 'nombre-asc' | 'nombre-desc';

export const OPCIONES_ORDEN_ACE: { valor: OrdenAce; etiqueta: string }[] = [
  { valor: 'codigo-asc', etiqueta: 'Código: menor a mayor (C001 → C165)' },
  { valor: 'codigo-desc', etiqueta: 'Código: mayor a menor (C165 → C001)' },
  { valor: 'nombre-asc', etiqueta: 'Nombre: A → Z' },
  { valor: 'nombre-desc', etiqueta: 'Nombre: Z → A' },
];

// Comparador según la opción elegida. En descendente se invierte el mismo
// criterio, así los empates se desempatan igual en ambos sentidos.
export function compararAce(
  orden: OrdenAce,
  a: { Codigo?: string | null; Nombre?: string | null },
  b: { Codigo?: string | null; Nombre?: string | null },
): number {
  const porNombre = (a.Nombre || '').localeCompare(b.Nombre || '', undefined, { sensitivity: 'base' });
  switch (orden) {
    case 'codigo-desc':
      return compararCodigoAce(b, a);
    case 'nombre-asc':
      return porNombre || compararCodigoAce(a, b);
    case 'nombre-desc':
      return -porNombre || compararCodigoAce(a, b);
    default:
      return compararCodigoAce(a, b);
  }
}
