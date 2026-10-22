import { formatDate } from '@angular/common';
import type { ClienteResultado } from '../../core/services/biometria.service';

// Traducción a lenguaje normal de la respuesta del servicio ConsultarBiometria del servidor de biometría.
// (Misma lógica que usa el reporte por fechas; aquí como funciones puras para la consulta por cliente.)

/** Una línea de la respuesta ya traducida. */
export interface FilaRespuesta { etiqueta: string; valor: string; nivel: number; grupo: boolean; destacada: boolean; }

export type NivelBio = 'ok' | 'aviso' | 'mal' | 'nulo';

export interface BioInfo {
  estado: 'consultando' | 'listo' | 'error' | 'invalido';
  nivel: NivelBio;
  titular: string;
  resumen: string;
  /** true = tiene biometría vigente, false = no la tiene, null = la respuesta no lo dice. */
  vigente: boolean | null;
  httpCodigo: number | null;
  error: string | null;
  json: unknown;
  cuerpo: string;
  filas: FilaRespuesta[];
}

const MAX_FILAS_RESPUESTA = 400;
const MAX_PROFUNDIDAD = 6;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Nombre claro de los campos conocidos de la respuesta (clave en minúsculas). */
const ETIQUETAS_CAMPO: Record<string, string> = {
  tienebiometria: 'Tiene biometría vigente',
  intentosdia: 'Intentos de hoy',
  intentosmes: 'Intentos del mes',
  ultimocaso: 'Último caso',
  idestado: 'Id del estado',
  estado: 'Estado',
  regla: 'Regla aplicada',
  mensaje: 'Mensaje',
  message: 'Mensaje',
  code: 'Código',
  codigo: 'Código',
  idcaso: 'Caso',
  fecha: 'Fecha',
  fechacreo: 'Fecha de creación',
  descripcion: 'Descripción',
};

export function bioError(mensaje: string): BioInfo {
  return { estado: 'error', nivel: 'mal', titular: 'No se pudo consultar', resumen: mensaje, vigente: null, httpCodigo: null, error: mensaje, json: null, cuerpo: '', filas: [] };
}

export function bioConsultando(): BioInfo {
  return { estado: 'consultando', nivel: 'nulo', titular: 'Consultando…', resumen: '', vigente: null, httpCodigo: null, error: null, json: null, cuerpo: '', filas: [] };
}

export function traducirRespuesta(x: ClienteResultado): BioInfo {
  const base = { httpCodigo: x.httpCodigo, json: x.json, cuerpo: x.cuerpo };
  if (x.etapa === 'validacion') {
    return { ...base, estado: 'invalido', nivel: 'nulo', titular: 'No se puede consultar', resumen: x.error || 'La cédula no es válida o viene enmascarada.', vigente: null, error: x.error, filas: [] };
  }
  if (x.etapa === 'ssh' && x.error) {
    return { ...base, estado: 'error', nivel: 'mal', titular: 'No se pudo llegar al servidor de biometría', resumen: x.error, vigente: null, error: x.error, filas: [] };
  }
  if (x.httpCodigo === null) {
    return { ...base, estado: 'error', nivel: 'mal', titular: 'El servidor de biometría no pudo consultar el servicio', resumen: x.error || '', vigente: null, error: x.error, filas: [] };
  }
  const filas: FilaRespuesta[] = [];
  if (x.json !== null && x.json !== undefined) aplanar(x.json, '', 0, filas);
  else if (x.cuerpo.trim()) filas.push({ etiqueta: 'Respuesta', valor: x.cuerpo.trim().slice(0, 4000), nivel: 0, grupo: false, destacada: true });

  const datos = buscarDatos(x.json);
  const vigente = datos && typeof datos['tieneBiometria'] === 'boolean' ? (datos['tieneBiometria'] as boolean) : leerBooleano(datos, 'tienebiometria');
  const resumen = armarResumen(datos);

  if (!x.ok) {
    const mensaje = textoMensaje(datos) || resumen;
    return {
      ...base, estado: 'listo', nivel: x.httpCodigo >= 500 ? 'mal' : 'aviso',
      titular: `El servicio respondió con un aviso o error (código ${x.httpCodigo})`, resumen: mensaje, vigente, error: null, filas,
    };
  }
  if (vigente === true) return { ...base, estado: 'listo', nivel: 'ok', titular: 'Tiene biometría vigente', resumen, vigente, error: null, filas };
  if (vigente === false) return { ...base, estado: 'listo', nivel: 'aviso', titular: 'No tiene biometría vigente', resumen, vigente, error: null, filas };
  return { ...base, estado: 'listo', nivel: 'ok', titular: 'El servicio respondió correctamente', resumen, vigente: null, error: null, filas };
}

/** Respuesta completa tal como llegó (JSON ordenado si se pudo leer). */
export function respuestaCompleta(b: BioInfo): string {
  if (b.json !== null && b.json !== undefined) { try { return JSON.stringify(b.json, null, 2); } catch { /* usa el texto */ } }
  return b.cuerpo;
}

/** Busca el objeto de la respuesta que trae los datos de biometría (la raíz o uno anidado, hasta 3 niveles). */
function buscarDatos(json: unknown, nivel = 0): Record<string, unknown> | null {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    if (Array.isArray(json) && json.length && nivel < 3) return buscarDatos(json[0], nivel + 1);
    return null;
  }
  const obj = json as Record<string, unknown>;
  const claves = Object.keys(obj).map((k) => k.toLowerCase());
  if (claves.includes('tienebiometria') || claves.includes('intentosdia') || claves.includes('intentosmes')) return obj;
  if (nivel >= 3) return nivel === 0 ? obj : null;
  for (const v of Object.values(obj)) {
    if (v !== null && typeof v === 'object') {
      const r = buscarDatos(v, nivel + 1);
      if (r) return r;
    }
  }
  return nivel === 0 ? obj : null;
}

function campo(datos: Record<string, unknown> | null, nombre: string): unknown {
  if (!datos) return undefined;
  const k = Object.keys(datos).find((x) => x.toLowerCase() === nombre.toLowerCase());
  return k === undefined ? undefined : datos[k];
}

function leerBooleano(datos: Record<string, unknown> | null, nombre: string): boolean | null {
  const v = campo(datos, nombre);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') { const t = v.trim().toLowerCase(); if (t === 'true') return true; if (t === 'false') return false; }
  return null;
}

function textoMensaje(datos: Record<string, unknown> | null): string {
  const v = campo(datos, 'mensaje') ?? campo(datos, 'message');
  return typeof v === 'string' ? v.trim() : '';
}

/** «Hoy: 2 intento(s) · Este mes: 5 · Último caso 123 (Reintento)» + el mensaje del servicio si lo hay. */
function armarResumen(datos: Record<string, unknown> | null): string {
  if (!datos) return '';
  const partes: string[] = [];
  const dia = campo(datos, 'intentosDia');
  const mes = campo(datos, 'intentosMes');
  if (dia !== undefined && dia !== null) partes.push(`Hoy: ${textoValor(dia)} intento(s)`);
  if (mes !== undefined && mes !== null) partes.push(`Este mes: ${textoValor(mes)}`);
  const u = campo(datos, 'ultimoCaso');
  if (u !== undefined && u !== null) {
    if (typeof u === 'object' && !Array.isArray(u)) {
      const o = u as Record<string, unknown>;
      const id = campo(o, 'idCaso') ?? campo(o, 'id') ?? campo(o, 'caso');
      const est = campo(o, 'estado') ?? campo(o, 'nombreEstado') ?? campo(o, 'descripcionEstado');
      const idEst = campo(o, 'idEstado');
      const e = est !== undefined && est !== null ? textoValor(est) : (idEst !== undefined && idEst !== null ? `estado ${textoValor(idEst)}` : '');
      partes.push(`Último caso${id !== undefined && id !== null ? ' ' + textoValor(id) : ''}${e ? ` (${e})` : ''}`);
    } else {
      const est = campo(datos, 'estado');
      const idEst = campo(datos, 'idEstado');
      const e = est !== undefined && est !== null && typeof est !== 'object' ? textoValor(est) : (idEst !== undefined && idEst !== null && typeof idEst !== 'object' ? `estado ${textoValor(idEst)}` : '');
      partes.push(`Último caso ${textoValor(u)}${e ? ` (${e})` : ''}`);
    }
  }
  const m = textoMensaje(datos);
  const base = partes.join(' · ');
  return m ? (base ? `${base} — ${m}` : m) : base;
}

export function humanizar(clave: string): string {
  const conocida = ETIQUETAS_CAMPO[clave.toLowerCase()];
  if (conocida) return conocida;
  const t = clave.replace(/[_\-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : clave;
}

function textoValor(v: unknown): string {
  if (v === null || v === undefined) return '(sin dato)';
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return '(vacío)';
    if (t.length > 300) return `(dato largo de ${t.length} caracteres: está completo en «Ver la respuesta completa»)`;
    if (ISO.test(t)) return formatDate(t, 'dd/MM/yyyy HH:mm:ss', 'en-US', 'UTC');
    return t;
  }
  return String(v);
}

/** Convierte el JSON de la respuesta en líneas «etiqueta: valor» (sin ocultar nada, solo traducido y ordenado). */
function aplanar(valor: unknown, etiqueta: string, nivel: number, filas: FilaRespuesta[]): void {
  if (filas.length >= MAX_FILAS_RESPUESTA) return;
  const importante = (e: string) => /tienebiometria|intentos|ultimo|mensaje|message|descripci|resultado|result|estado|status|exito|success|error|valid|regla/i.test(e);
  if (Array.isArray(valor)) {
    if (etiqueta) filas.push({ etiqueta, valor: `${valor.length} elemento(s)`, nivel, grupo: true, destacada: false });
    valor.forEach((x, i) => {
      if (x !== null && typeof x === 'object') aplanar(x, `Elemento ${i + 1}`, nivel + (etiqueta ? 1 : 0), filas);
      else filas.push({ etiqueta: `Elemento ${i + 1}`, valor: textoValor(x), nivel: nivel + 1, grupo: false, destacada: false });
    });
    return;
  }
  if (valor !== null && typeof valor === 'object') {
    if (nivel >= MAX_PROFUNDIDAD) { filas.push({ etiqueta, valor: '(contenido anidado: ver la respuesta completa)', nivel, grupo: false, destacada: false }); return; }
    if (etiqueta) filas.push({ etiqueta, valor: '', nivel, grupo: true, destacada: false });
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      const et = humanizar(k);
      if (v !== null && typeof v === 'object') aplanar(v, et, nivel + (etiqueta ? 1 : 0), filas);
      else if (filas.length < MAX_FILAS_RESPUESTA) filas.push({ etiqueta: et, valor: textoValor(v), nivel: nivel + (etiqueta ? 1 : 0), grupo: false, destacada: nivel <= 1 && importante(k) });
    }
    return;
  }
  filas.push({ etiqueta: etiqueta || 'Respuesta', valor: textoValor(valor), nivel, grupo: false, destacada: true });
}
