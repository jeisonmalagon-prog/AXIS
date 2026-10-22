import { FilaClaveValor, SwaggerOperacion } from '../../core/services/swagger.service';

// ==========================================================================
// Utilidades compartidas por la consola de Swagger
// ==========================================================================

export function claseMetodo(m: string): string {
  return `m-${(m || '').toLowerCase()}`;
}

export function claseEstado(e: number | null | undefined): string {
  if (e === null || e === undefined) return 'est-nulo';
  if (e >= 500) return 'est-mal';
  if (e >= 400) return 'est-aviso';
  if (e >= 300) return 'est-info';
  return 'est-ok';
}

export function claseCodigo(codigo: string): string {
  const n = Number(codigo);
  return Number.isFinite(n) ? claseEstado(n) : 'est-nulo';
}

export function tamano(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function hostDe(url: string): string {
  try { return new URL((url || '').trim()).host.toLowerCase(); } catch { return ''; }
}

export function escaparHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Colorea un JSON ya formateado (devuelve HTML seguro: todo el texto va escapado).
export function resaltarJson(texto: string): string {
  const seguro = escaparHtml(texto);
  return seguro.replace(
    /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let clase = 'j-num';
      if (m.startsWith('"')) clase = m.endsWith(':') ? 'j-clave' : 'j-cad';
      else if (m === 'true' || m === 'false') clase = 'j-bool';
      else if (m === 'null') clase = 'j-nulo';
      if (clase === 'j-clave') {
        const i = m.lastIndexOf('"') + 1;
        return `<span class="j-clave">${m.slice(0, i)}</span>${m.slice(i)}`;
      }
      return `<span class="${clase}">${m}</span>`;
    },
  );
}

export function pareceJson(t: string): boolean {
  const l = (t || '').trim();
  return l.startsWith('{') || l.startsWith('[');
}

export function formatearJson(t: string): string {
  if (!t || t.length > 1000000) return t;
  if (!pareceJson(t)) return t;
  try { return JSON.stringify(JSON.parse(t.trim()), null, 2); } catch { return t; }
}

export function errorDeJson(t: string): string {
  try { JSON.parse(t); return ''; } catch (e) { return e instanceof Error ? e.message.replace(/^JSON\.parse: /, '') : 'JSON no válido'; }
}

// Tabla para respuestas JSON que son una lista de objetos (o un objeto con una lista dentro).
export interface TablaJson {
  columnas: string[];
  filas: string[][];
  total: number;
  origen: string;
}

function celda(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

export function tablaDeJson(texto: string | null): TablaJson | null {
  if (!texto || !pareceJson(texto) || texto.length > 2000000) return null;
  let dato: unknown;
  try { dato = JSON.parse(texto); } catch { return null; }
  let lista: unknown = dato;
  let origen = '';
  if (dato && typeof dato === 'object' && !Array.isArray(dato)) {
    const candidatas = Object.entries(dato as Record<string, unknown>).filter(([, v]) => Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x)));
    if (candidatas.length === 1) { lista = candidatas[0][1]; origen = candidatas[0][0]; } else return null;
  }
  if (!Array.isArray(lista) || !lista.length) return null;
  if (!lista.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return null;
  const columnas: string[] = [];
  (lista as Record<string, unknown>[]).slice(0, 200).forEach((f) => Object.keys(f).forEach((k) => { if (!columnas.includes(k) && columnas.length < 24) columnas.push(k); }));
  const filas = (lista as Record<string, unknown>[]).slice(0, 200).map((f) => columnas.map((c) => celda(f[c])));
  return { columnas, filas, total: lista.length, origen };
}

export function descargarTexto(texto: string, nombre: string, mime: string): void {
  const blob = new Blob([texto], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function extensionDe(tipoContenido: string): string {
  if (/json/i.test(tipoContenido)) return 'json';
  if (/xml/i.test(tipoContenido)) return 'xml';
  if (/csv/i.test(tipoContenido)) return 'csv';
  if (/html/i.test(tipoContenido)) return 'html';
  return 'txt';
}

// Copia al portapapeles (con respaldo para contextos sin la API moderna). Devuelve una promesa con el resultado.
export function copiarTexto(texto: string): Promise<boolean> {
  const ta = document.createElement('textarea');
  ta.value = texto;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  if (ok) return Promise.resolve(true);
  if (navigator.clipboard) return navigator.clipboard.writeText(texto).then(() => true, () => false);
  return Promise.resolve(false);
}

// ---------------------------------------------------------------------------
// Autenticación (esquemas de seguridad del documento + credenciales del usuario)
// ---------------------------------------------------------------------------
export interface EsquemaSeguridad {
  nombre: string;
  tipo: string;
  detalle: string;
  descripcion: string;
  esquema?: string;
  en?: string;
  nombreParam?: string;
  formatoBearer?: string;
}

export interface Credencial {
  valor?: string;
  usuario?: string;
  clave?: string;
}

export function credencialCompleta(e: EsquemaSeguridad, c: Credencial | undefined): boolean {
  if (!c) return false;
  if (e.tipo === 'http' && e.esquema === 'basic') return !!(c.usuario || '').trim();
  return !!(c.valor || '').trim();
}

function base64Utf8(texto: string): string {
  const bytes = new TextEncoder().encode(texto);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

export interface AuthAplicada {
  headers: FilaClaveValor[];
  query: FilaClaveValor[];
  nombres: string[];
}

export function aplicarCredenciales(
  esquemas: EsquemaSeguridad[], creds: Record<string, Credencial>, op: SwaggerOperacion | null,
): AuthAplicada {
  const salida: AuthAplicada = { headers: [], query: [], nombres: [] };
  const requeridos = op?.seguridadEsquemas || [];
  const elegibles = requeridos.length ? esquemas.filter((e) => requeridos.includes(e.nombre)) : esquemas;
  elegibles.forEach((e) => {
    const c = creds[e.nombre];
    if (!credencialCompleta(e, c)) return;
    if (e.tipo === 'apiKey') {
      const nombre = e.nombreParam || 'X-Api-Key';
      const v = (c?.valor || '').trim();
      if (e.en === 'query') salida.query.push({ k: nombre, v });
      else if (e.en === 'cookie') salida.headers.push({ k: 'Cookie', v: `${nombre}=${v}` });
      else salida.headers.push({ k: nombre, v });
    } else if (e.tipo === 'http' && e.esquema === 'basic') {
      salida.headers.push({ k: 'Authorization', v: `Basic ${base64Utf8(`${c?.usuario || ''}:${c?.clave || ''}`)}` });
    } else {
      const v = (c?.valor || '').trim();
      salida.headers.push({ k: 'Authorization', v: /^(bearer|basic)\s/i.test(v) ? v : `Bearer ${v}` });
    }
    salida.nombres.push(e.nombre);
  });
  return salida;
}

export function esCampoSecreto(nombre: string): boolean {
  return /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|token|access_token|password|secret)$/i.test(nombre.trim());
}
