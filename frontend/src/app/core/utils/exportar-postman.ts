// Arma una colección de Postman (v2.1) con las peticiones elegidas, lista para importar
// (Postman → Import → arrastrar el archivo). Todo ocurre en el navegador.

export interface ItemExportable {
  nombre: string;
  metodo: string;
  /** URL completa, o vacía para usar la variable {{url}} de la colección. */
  url: string;
  cabeceras: { nombre: string; valor: string; activo?: boolean }[];
  cuerpo: string;
}

function uuid(): string {
  const b = Array.from(crypto.getRandomValues(new Uint8Array(16)));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Lo de SoapUI que Postman sí sabe hacer se traduce a su equivalente; el resto queda como está. */
function aPostman(texto: string): string {
  return texto.replace(/\$\{=\s*(?:java\.util\.)?UUID\.randomUUID\(\)(?:\.toString\(\))?\s*;?\s*\}/g, '{{$guid}}');
}

function urlDePostman(texto: string): Record<string, unknown> {
  const raw = aPostman(texto.trim());
  if (!raw || raw.includes('{{')) return { raw };
  try {
    const u = new URL(raw);
    const consulta = [...u.searchParams.entries()].map(([key, value]) => ({ key, value }));
    return {
      raw,
      protocol: u.protocol.replace(':', ''),
      host: u.hostname.split('.'),
      ...(u.port ? { port: u.port } : {}),
      path: u.pathname.split('/').filter(Boolean),
      ...(consulta.length ? { query: consulta } : {}),
    };
  } catch {
    return { raw };
  }
}

function lenguaje(cuerpo: string): 'xml' | 'json' | 'text' {
  const t = cuerpo.trim();
  return t.startsWith('<') ? 'xml' : t.startsWith('{') || t.startsWith('[') ? 'json' : 'text';
}

export function construirColeccionPostman(
  nombre: string,
  descripcion: string,
  items: ItemExportable[],
  valoresVariables: { nombre: string; valor: string }[] = [],
): Record<string, unknown> {
  const usadas = new Set<string>();
  const cuenta = (t: string): void => { for (const m of t.matchAll(/\{\{\s*([^{}\s$][^{}\s]*)\s*\}\}/g)) usadas.add(m[1]); };

  const item = items.map((i) => {
    const metodo = i.metodo.toUpperCase();
    const url = i.url.trim() || '{{url}}';
    const cabeceras = i.cabeceras.filter((c) => c.nombre.trim());
    [url, i.cuerpo, ...cabeceras.map((c) => c.valor)].forEach(cuenta);
    const lleva = !!i.cuerpo.trim() && metodo !== 'GET' && metodo !== 'HEAD';
    return {
      name: i.nombre,
      request: {
        method: metodo,
        header: cabeceras.map((c) => ({ key: c.nombre.trim(), value: aPostman(c.valor), type: 'text', ...(c.activo === false ? { disabled: true } : {}) })),
        ...(lleva ? { body: { mode: 'raw', raw: aPostman(i.cuerpo), options: { raw: { language: lenguaje(i.cuerpo) } } } } : {}),
        url: urlDePostman(url),
      },
      response: [],
    };
  });

  const variable = [...usadas].map((key) => ({ key, value: valoresVariables.find((v) => v.nombre === key)?.valor ?? '' }));
  return {
    info: {
      _postman_id: uuid(),
      name: nombre,
      description: descripcion,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item,
    variable,
  };
}

export function nombreSeguroArchivo(texto: string): string {
  return texto.replace(/[^\w.\- ()áéíóúÁÉÍÓÚñÑ]+/g, '_').trim().replace(/\s+/g, '_').slice(0, 80) || 'coleccion';
}

export function descargarJson(nombreArchivo: string, objeto: unknown): void {
  const blob = new Blob([JSON.stringify(objeto, null, 2)], { type: 'application/json;charset=utf-8' });
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(blob);
  enlace.download = nombreArchivo;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(enlace.href), 2000);
}
