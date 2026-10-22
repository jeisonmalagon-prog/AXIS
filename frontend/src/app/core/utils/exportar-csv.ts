// Descarga de datos en CSV desde el navegador, sin pasar por el backend: sirve
// para exportar exactamente lo que el usuario está viendo (con su búsqueda,
// filtros y orden). Usa ";" como separador y BOM UTF-8 para que Excel en
// español lo abra directo, con columnas separadas y tildes bien.
const SEPARADOR = ';';

function celda(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  let texto = typeof valor === 'boolean' ? (valor ? 'Sí' : 'No') : String(valor);
  // Evita que Excel interprete como fórmula un texto que empiece con = + @ o "- ".
  if (/^[=+@]/.test(texto) || /^-(?!\d)/.test(texto)) texto = "'" + texto;
  if (/[";\r\n]/.test(texto)) texto = '"' + texto.replace(/"/g, '""') + '"';
  return texto;
}

export function fechaParaArchivo(): string {
  const d = new Date();
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

export function descargarCsv(nombreArchivo: string, encabezados: string[], filas: unknown[][]): void {
  const lineas = [encabezados.map(celda).join(SEPARADOR)];
  filas.forEach((fila) => lineas.push(fila.map(celda).join(SEPARADOR)));
  const contenido = '﻿' + lineas.join('\r\n');

  const url = URL.createObjectURL(new Blob([contenido], { type: 'text/csv;charset=utf-8;' }));
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombreArchivo;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}
