// Orden "natural" de códigos de servicio ACE: C001, C002, ... C010, ... C170,
// C170V2. Primero el número del código, luego el sufijo ("V1" < "V2").
// Los registros sin código válido van al final, ordenados por nombre.
function partesCodigo(codigo) {
  const m = /^\s*[A-Za-z]*\s*0*(\d+)\s*(.*)$/.exec(codigo || '');
  if (!m) return null;
  return { numero: parseInt(m[1], 10), sufijo: (m[2] || '').trim() };
}

function compararCodigoAce(a, b, campoNombre = 'Nombre') {
  const pa = partesCodigo(a.Codigo);
  const pb = partesCodigo(b.Codigo);
  if (pa && pb) {
    if (pa.numero !== pb.numero) return pa.numero - pb.numero;
    return pa.sufijo.localeCompare(pb.sufijo, undefined, { numeric: true, sensitivity: 'base' });
  }
  if (pa) return -1;
  if (pb) return 1;
  return String(a[campoNombre] || '').localeCompare(String(b[campoNombre] || ''));
}

module.exports = { compararCodigoAce };
