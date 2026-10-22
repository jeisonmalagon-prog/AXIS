import { HttpErrorResponse } from '@angular/common/http';

/** Texto amable para mostrar un error HTTP (también cuando la respuesta venía como Blob). */
export async function mensajeDeError(err: unknown, porDefecto = 'No se pudo completar la acción. Inténtalo de nuevo.'): Promise<string> {
  if (!(err instanceof HttpErrorResponse)) return porDefecto;
  if (err.status === 0) return 'No hay conexión con el servidor. Revisa tu red e inténtalo de nuevo.';
  let cuerpo: unknown = err.error;
  if (cuerpo instanceof Blob) {
    try { cuerpo = JSON.parse(await cuerpo.text()); } catch { cuerpo = null; }
  }
  if (cuerpo && typeof cuerpo === 'object' && 'error' in cuerpo && typeof (cuerpo as { error: unknown }).error === 'string') {
    return (cuerpo as { error: string }).error;
  }
  if (err.status === 403) return 'No tienes permiso para realizar esta acción.';
  if (err.status === 413) return 'El archivo o el contenido es demasiado grande.';
  return `${porDefecto} (HTTP ${err.status})`;
}

export function descargarBlob(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function nombreSeguro(base: string, ext: string): string {
  const limpio = (base || 'manual').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'manual';
  return `${limpio}.${ext}`;
}

export function escaparHtml(t: string): string {
  return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function tamanoLegible(bytes: number | null | undefined): string {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export interface PaginaImprimible { titulo: string; html: string; fecha?: string | null; }

const ESTILO_IMPRESION = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #111; margin: 0; }
  .pagina { page-break-after: always; }
  .pagina:last-child { page-break-after: auto; }
  h1.titulo { font-size: 20pt; margin: 0 0 4px; border-bottom: 2px solid #673ab7; padding-bottom: 6px; }
  .meta { color: #666; font-size: 9.5pt; margin: 0 0 14px; }
  h1, h2, h3, h4 { page-break-after: avoid; line-height: 1.25; }
  h1 { font-size: 17pt; } h2 { font-size: 14pt; } h3 { font-size: 12pt; }
  p { margin: 0 0 8px; }
  img { max-width: 100%; height: auto; page-break-inside: avoid; border: 1px solid #ddd; border-radius: 4px; }
  pre { background: #f4f4f6; border: 1px solid #d9d9e0; border-radius: 6px; padding: 8px 10px; font-family: Consolas, 'Courier New', monospace; font-size: 9.5pt; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; }
  code { font-family: Consolas, 'Courier New', monospace; background: #f1f1f4; padding: 0 3px; border-radius: 3px; font-size: 0.95em; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  td, th { border: 1px solid #bbb; padding: 4px 8px; vertical-align: top; }
  th { background: #f0f0f4; }
  tr { page-break-inside: avoid; }
  blockquote { margin: 8px 0; padding: 2px 12px; border-left: 4px solid #c9b8ee; color: #444; }
  mark { background: #fff59d; }
  a { color: #4527a0; }
`;

/** Abre el diálogo de impresión del navegador (ahí se elige «Guardar como PDF») con solo el contenido de las páginas. */
export function imprimirPaginas(tituloDocumento: string, paginas: PaginaImprimible[]): void {
  const cuerpo = paginas.map((p) => {
    const f = p.fecha ? new Date(p.fecha) : null;
    const meta = f && !isNaN(f.getTime()) ? `<p class="meta">${escaparHtml(f.toLocaleDateString('es-CO', { dateStyle: 'full' }))}</p>` : '';
    return `<section class="pagina"><h1 class="titulo">${escaparHtml(p.titulo)}</h1>${meta}${p.html}</section>`;
  }).join('');
  const doc = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${escaparHtml(tituloDocumento)}</title><style>${ESTILO_IMPRESION}</style></head><body>${cuerpo}</body></html>`;

  const marco = document.createElement('iframe');
  marco.setAttribute('aria-hidden', 'true');
  marco.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
  document.body.appendChild(marco);
  const limpiar = () => setTimeout(() => marco.remove(), 1500);
  const ventana = marco.contentWindow;
  const documento = marco.contentDocument;
  if (!ventana || !documento) { marco.remove(); return; }
  documento.open();
  documento.write(doc);
  documento.close();
  const lanzar = () => {
    try {
      ventana.focus();
      ventana.addEventListener('afterprint', limpiar, { once: true });
      ventana.print();
    } catch {
      limpiar();
    }
    setTimeout(limpiar, 120000);
  };
  // Las imágenes van incrustadas (data:), pero se espera igual a que terminen de decodificar.
  const imgs = Array.from(documento.images);
  Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise<void>((r) => { i.onload = () => r(); i.onerror = () => r(); }))))
    .then(() => setTimeout(lanzar, 150));
}

/** Reduce una imagen pegada/arrastrada (capturas de pantalla) para que la página no pese de más. Devuelve un data URL. */
export async function comprimirImagen(archivo: File, anchoMax = 1600): Promise<string> {
  const leer = (f: Blob) => new Promise<string>((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => mal(r.error);
    r.readAsDataURL(f);
  });
  if (archivo.type === 'image/gif' && archivo.size < 1500000) return leer(archivo);
  const url = URL.createObjectURL(archivo);
  try {
    const img = await new Promise<HTMLImageElement>((ok, mal) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => mal(new Error('No se pudo leer la imagen.'));
      i.src = url;
    });
    const escala = Math.min(1, anchoMax / img.naturalWidth);
    if (escala === 1 && archivo.size < 600000 && /^image\/(png|jpeg|webp)$/.test(archivo.type)) return leer(archivo);
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.max(1, Math.round(img.naturalWidth * escala));
    lienzo.height = Math.max(1, Math.round(img.naturalHeight * escala));
    const ctx = lienzo.getContext('2d');
    if (!ctx) return leer(archivo);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, lienzo.width, lienzo.height);
    ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
    const png = lienzo.toDataURL('image/png');
    // Una captura de consola en PNG suele pesar poco; si se pasa de ~700 KB se usa JPEG.
    return png.length < 950000 ? png : lienzo.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** «5 oct 2026» (y la hora si se pide). Se usa Intl para no depender de registrar el idioma de Angular. */
export function fechaCorta(iso: string | null | undefined, conHora = false): string {
  if (!iso) return '';
  const f = new Date(iso);
  if (isNaN(f.getTime())) return '';
  const dia = f.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\./g, '');
  return conHora ? `${dia}, ${f.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' })}` : dia;
}

export function fechaLarga(iso: string | null | undefined, conHora = false): string {
  if (!iso) return '';
  const f = new Date(iso);
  if (isNaN(f.getTime())) return '';
  const dia = f.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return conHora ? `${dia}, ${f.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' })}` : dia;
}
