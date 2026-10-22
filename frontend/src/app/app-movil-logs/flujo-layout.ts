// ============================================================================
// Tipos y cálculo de disposición (layout) de los diagramas de flujo de
// App Móvil. Todo se dibuja a mano en SVG (sin librerías): estos helpers solo
// calculan posiciones y trazos; los componentes los pintan.
// ============================================================================

// ---------------------------------------------------------------------------
// Respuestas del backend (GET /app-movil/flujo/cliente y /flujo/global)
// ---------------------------------------------------------------------------
export type EstadoLlamada = 'exito' | 'error' | 'advertencia' | 'sin_detalle' | 'sin_respuesta' | 'en_curso';

/** Una fila interna de la traza de una operación (API, SOAP/ACE, error, paso interno). */
export interface PasoLlamada {
  tipo: 'inicio' | 'api' | 'soap' | 'error' | 'paso';
  nivel: 'ok' | 'info' | 'aviso' | 'error';
  titulo: string;
  texto: string;
  destino: string | null;
  hora: string;
  /** Fecha (AAAA-MM-DD) de la fila: junto con el código permite abrir su detalle. */
  fecha?: string;
  /** Código (clave) de la fila en el log. */
  codigo?: number;
  /** Cuánto se esperó por este paso (ms). */
  esperaMs?: number;
  lento?: boolean;
  veces: number;
}

export type Lentitud = 'lenta' | 'muy_lenta' | null;

/** Estado general de un recorrido: nunca es "ok" si hubo errores, avisos o lentitud. */
export interface SaludRecorrido {
  nivel: 'ok' | 'aviso' | 'error';
  texto: string;
}

export interface HallazgoServidor {
  nivel: 'error' | 'warn' | 'ok' | 'info';
  texto: string;
  llamadas: number[];
}

export interface FaseRecorrido {
  nombre: string;
  desde: number;
  hasta: number;
  llamadas: number;
  errores: number;
  avisos: number;
  hora: string;
  duracionMs: number;
  servicios: string[];
}

export interface LlamadaFlujo {
  n: number;
  metodo: string;
  clase: string | null;
  servicio: string;
  funcionalidad: number | null;
  inicio: string | null;
  fin: string | null;
  offsetMs: number;
  duracionMs: number | null;
  estado: EstadoLlamada;
  esLogout: boolean;
  previas: number[];
  mensaje: string | null;
  /** 'Sin datos' | 'Sin resultados' | 'Desde caché' cuando la respuesta fue correcta pero vacía. */
  resultado?: string | null;
  /** 'lenta' (≥ 5 s) o 'muy_lenta' (≥ 15 s). Lo habitual es responder en menos de 2 s. */
  lentitud?: Lentitud;
  pasoLento?: { titulo: string; esperaMs: number } | null;
  ruta?: string | null;
  repeticion?: number | null;
  reintento?: boolean;
  pasos?: PasoLlamada[];
}

export interface RecorridoFlujo {
  id: number;
  inicio: string;
  fin: string;
  duracionMs: number;
  dispositivo: string;
  ip: string | null;
  totalLlamadas: number;
  serviciosDistintos: number;
  errores: number;
  masLento: { metodo: string; servicio: string; duracionMs: number } | null;
  cierre: 'cierre_normal' | 'sin_cierre' | 'termino_con_error';
  llamadas: LlamadaFlujo[];
  advertencias?: number;
  sinDetalle?: number;
  lentas?: number;
  muyLentas?: number;
  salud?: SaludRecorrido;
  narrativa?: string;
  fases?: FaseRecorrido[];
  hallazgos?: HallazgoServidor[];
  resumenTexto?: string;
}

export interface TramoConsultado {
  tabla: string;
  desde: string;
  hasta: string;
  filas: number;
  existe: boolean;
}

export interface ServicioResumen {
  metodo: string;
  servicio: string;
  llamadas: number;
  errores: number;
  advertencias?: number;
  lentas?: number;
  duracionPromMs: number | null;
  duracionMaxMs: number | null;
}

export interface ResumenCliente {
  recorridos: number;
  llamadas: number;
  errores: number;
  advertencias?: number;
  lentas?: number;
  muyLentas?: number;
  sinDetalle?: number;
  sinRespuesta: number;
  tasaExito: number | null;
  serviciosDistintos: number;
  duracionPromMs: number | null;
  duracionP90Ms: number | null;
  masLento: { servicio: string; metodo: string; duracionMs: number } | null;
  dispositivos: { nombre: string; n: number }[];
  servicios: ServicioResumen[];
}

export interface DiagnosticoCliente {
  tramos: TramoConsultado[];
  tablasFaltantes: string[];
  tablasRevisadas: string[];
  diasConActividad: { fecha: string; registros: number }[];
  ultimaActividad: string | null;
}

export interface RecorridoResponse {
  documento: string;
  fechaInicio: string;
  fechaFin: string;
  brechaMin: number;
  relojBd: string | null;
  totalFilas: number;
  truncado: boolean;
  recorridosOmitidos: number;
  tramos: TramoConsultado[];
  tablasFaltantes: string[];
  resumen: ResumenCliente;
  recorridos: RecorridoFlujo[];
  diagnostico: DiagnosticoCliente | null;
  desdeCache: boolean;
  generadoEn: string;
}

export interface NodoGlobalApi {
  metodo: string;
  servicio: string;
  esLogout: boolean;
  total: number;
  clientes: number;
  fallos: number;
  lentas?: number;
  sinRespuesta: number;
  tasaFallo: number;
  entradas: number;
  salidas: number;
  repeticiones: number;
  posProm: number;
  duracionPromMs: number | null;
  duracionMedianaMs: number | null;
  duracionP90Ms: number | null;
}

export interface AristaGlobalApi {
  de: string;
  a: string;
  n: number;
  esperaPromMs: number;
  fallosDestino: number;
}

export interface VarianteGlobal {
  pasos: { metodo: string; servicio: string }[][];
  truncada: boolean;
  n: number;
  porcentaje: number;
  conError: number;
  duracionMedianaMs: number | null;
  llamadasProm: number;
  cierreNormal: number;
  cierreError: number;
  sinCierre: number;
}

export interface KpisGlobal {
  errores: number;
  lentas?: number;
  tasaError: number;
  llamadaMedianaMs: number | null;
  llamadaP90Ms: number | null;
  recorridoMedianaMs: number | null;
  recorridoP90Ms: number | null;
  llamadasPorRecorrido: number;
  recorridosConError: number;
  cierreNormal: number;
  cierreError: number;
  sinCierre: number;
  serviciosDistintos: number;
}

export interface MapaGlobalResponse {
  modo: 'reciente' | 'historico';
  tabla: string;
  tablaFaltante: boolean;
  ventanaMin: number;
  fecha: string | null;
  hora: number | null;
  relojBd: string | null;
  muestra: {
    filasLeidas: number;
    topeFilas: number;
    truncada: boolean;
    clientes: number;
    recorridos: number;
    llamadas: number;
    desde: string | null;
    hasta: string | null;
  };
  kpis: KpisGlobal;
  actividad: { bucketMs: number; puntos: { t: string; llamadas: number; errores: number; clientes: number }[] };
  variantes: VarianteGlobal[];
  nodosOmitidos: number;
  nodos: NodoGlobalApi[];
  aristas: AristaGlobalApi[];
  desdeCache: boolean;
  antiguedadMs: number;
  generadoEn: string;
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------
export function formatearDuracion(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return ms <= 0 ? '< 1 s' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const seg = Math.round(ms / 1000);
  if (seg < 60) return `${seg} s`;
  const min = Math.floor(seg / 60);
  const resto = seg % 60;
  if (min < 60) return resto ? `${min} min ${resto} s` : `${min} min`;
  const horas = Math.floor(min / 60);
  return `${horas} h ${min % 60} min`;
}

export function recortarTexto(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
}

// ---------------------------------------------------------------------------
// RECORRIDO DE UN CLIENTE
// ---------------------------------------------------------------------------
export type TipoNodoRecorrido = 'inicio' | 'fin' | 'llamada';

export interface NodoRecorrido {
  id: string;
  tipo: TipoNodoRecorrido;
  x: number;
  y: number;
  w: number;
  h: number;
  titulo: string;
  tituloCorto: string;
  metodo: string;
  linea2: string;
  estado: EstadoLlamada | 'neutro';
  /** Intentos agrupados (reintentos de la misma llamada), en orden. */
  intentos: LlamadaFlujo[];
  fallosPrevios: number;
  /** Para inicio/fin: etiqueta de estado del cierre. */
  cierre?: RecorridoFlujo['cierre'];
  /** Número de la llamada (o de la última del grupo de reintentos). */
  paso: number;
  /** Duración relativa a la llamada más lenta del recorrido (0 a 1). */
  ratioDuracion: number;
  /** Lentitud de la última llamada del grupo (null si respondió con normalidad). */
  lentitud: Lentitud;
}

export interface AristaRecorrido {
  id: string;
  d: string;
  etiqueta: string | null;
  lx: number;
  ly: number;
  hacia: string;
  desde: string;
  esperaMs: number;
}

export interface ModeloRecorrido {
  nodos: NodoRecorrido[];
  aristas: AristaRecorrido[];
  ancho: number;
  alto: number;
}

const R_W = 244;
const R_H = 76;
const R_EVENTO = 46;
const R_GAP_X = 74;
const R_GAP_Y = 24;
const R_PAD = 28;
const UMBRAL_ETIQUETA_ESPERA_MS = 3000;

function curvaHorizontal(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(36, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

export function construirModeloRecorrido(recorrido: RecorridoFlujo, agruparReintentos: boolean): ModeloRecorrido {
  const llamadas = recorrido.llamadas;
  const porN = new Map<number, LlamadaFlujo>(llamadas.map((l) => [l.n, l]));

  const sucesores = new Map<number, number[]>();
  for (const l of llamadas) sucesores.set(l.n, []);
  for (const l of llamadas) for (const p of l.previas) sucesores.get(p)?.push(l.n);

  // --- 1) Agrupar reintentos: cadena A -> A donde A solo tiene un sucesor ---
  const cabeza = new Map<number, number>(); // n -> n de la cabeza de su grupo
  for (const l of llamadas) {
    let jefe = l.n;
    if (agruparReintentos && l.previas.length === 1) {
      const previa = porN.get(l.previas[0]);
      if (previa && previa.metodo === l.metodo && (sucesores.get(previa.n)?.length ?? 0) === 1) {
        jefe = cabeza.get(previa.n) ?? previa.n;
      }
    }
    cabeza.set(l.n, jefe);
  }
  const miembros = new Map<number, LlamadaFlujo[]>();
  for (const l of llamadas) {
    const jefe = cabeza.get(l.n)!;
    if (!miembros.has(jefe)) miembros.set(jefe, []);
    miembros.get(jefe)!.push(l);
  }
  const jefes = [...miembros.keys()].sort((a, b) => a - b);

  // Aristas entre grupos
  const aristasGrupo = new Map<string, { de: number; a: number; esperaMs: number }>();
  for (const l of llamadas) {
    for (const p of l.previas) {
      const gDe = cabeza.get(p)!;
      const gA = cabeza.get(l.n)!;
      if (gDe === gA) continue;
      const previa = porN.get(p)!;
      const finPrevia = previa.fin ?? previa.inicio;
      const inicioActual = l.inicio ?? l.fin;
      let esperaMs = 0;
      if (finPrevia && inicioActual) esperaMs = Math.max(0, new Date(inicioActual).getTime() - new Date(finPrevia).getTime());
      const clave = `${gDe}>${gA}`;
      const existente = aristasGrupo.get(clave);
      if (!existente || esperaMs < existente.esperaMs) aristasGrupo.set(clave, { de: gDe, a: gA, esperaMs });
    }
  }

  // --- 2) Capas (camino más largo desde el inicio) ---
  const capa = new Map<number, number>();
  const previasDeGrupo = new Map<number, number[]>();
  for (const j of jefes) previasDeGrupo.set(j, []);
  for (const e of aristasGrupo.values()) previasDeGrupo.get(e.a)!.push(e.de);
  for (const j of jefes) {
    const previas = previasDeGrupo.get(j)!;
    capa.set(j, previas.length ? Math.max(...previas.map((p) => capa.get(p) ?? 0)) + 1 : 1);
  }
  const maxCapa = Math.max(1, ...jefes.map((j) => capa.get(j)!));
  const sucesoresDeGrupo = new Map<number, number[]>();
  for (const j of jefes) sucesoresDeGrupo.set(j, []);
  for (const e of aristasGrupo.values()) sucesoresDeGrupo.get(e.de)!.push(e.a);

  // --- 3) Posiciones ---
  const porCapa = new Map<number, number[]>();
  for (const j of jefes) {
    const c = capa.get(j)!;
    if (!porCapa.has(c)) porCapa.set(c, []);
    porCapa.get(c)!.push(j);
  }
  const alturaCapa = (cantidad: number) => cantidad * R_H + (cantidad - 1) * R_GAP_Y;
  const maxFilas = Math.max(1, ...[...porCapa.values()].map((v) => v.length));
  const altoContenido = Math.max(alturaCapa(maxFilas), R_EVENTO);
  const colX = (c: number) => R_PAD + c * (R_W + R_GAP_X) - (c > 0 ? 0 : 0);
  // Capa 0 = evento de inicio (más angosta)
  const xInicio = R_PAD;
  const xCapa = (c: number) => R_PAD + R_EVENTO + R_GAP_X + (c - 1) * (R_W + R_GAP_X);
  const xFin = xCapa(maxCapa + 1);
  void colX;

  const nodos: NodoRecorrido[] = [];
  const posicion = new Map<string, NodoRecorrido>();

  const centroY = R_PAD + altoContenido / 2;
  const maxDuracion = Math.max(1, ...llamadas.map((l) => l.duracionMs ?? 0));

  const nodoInicio: NodoRecorrido = {
    id: 'inicio', tipo: 'inicio', x: xInicio, y: centroY - R_EVENTO / 2, w: R_EVENTO, h: R_EVENTO,
    titulo: 'Inicio del recorrido', tituloCorto: 'Inicio', metodo: '', linea2: '', estado: 'neutro', intentos: [], fallosPrevios: 0, paso: 0, ratioDuracion: 0, lentitud: null
  };
  nodos.push(nodoInicio);
  posicion.set('inicio', nodoInicio);

  for (const [c, lista] of porCapa) {
    const alto = alturaCapa(lista.length);
    let y = centroY - alto / 2;
    for (const j of lista) {
      const grupo = miembros.get(j)!;
      const ultimo = grupo[grupo.length - 1];
      const fallosPrevios = grupo.slice(0, -1).filter((g) => g.estado === 'error').length;
      const hora = (ultimo.inicio ?? ultimo.fin) ? new Date((ultimo.inicio ?? ultimo.fin)!).toLocaleTimeString('es-CO', { hour12: false }) : '';
      let linea2 = hora;
      if (ultimo.estado === 'sin_respuesta') linea2 = `${hora} · sin respuesta`;
      else if (ultimo.estado === 'en_curso') linea2 = `${hora} · en curso`;
      else if (ultimo.estado === 'sin_detalle') linea2 = `${hora} · solo inicio`;
      else if (ultimo.estado === 'advertencia' && ultimo.lentitud) linea2 = `${hora} · ⏱ ${formatearDuracion(ultimo.duracionMs)}`;
      else if (ultimo.estado === 'advertencia') linea2 = `${hora} · ${ultimo.resultado ?? 'aviso'}`;
      else if (ultimo.duracionMs !== null) linea2 = `${hora} · ${ultimo.lentitud ? '⏱ ' : ''}${formatearDuracion(ultimo.duracionMs)}`;
      const nodo: NodoRecorrido = {
        id: `n${j}`, tipo: 'llamada', x: xCapa(c), y, w: R_W, h: R_H,
        titulo: ultimo.servicio, tituloCorto: recortarTexto(ultimo.servicio, 30), metodo: ultimo.metodo,
        linea2, estado: ultimo.estado, intentos: grupo, fallosPrevios,
        paso: ultimo.n, ratioDuracion: Math.min(1, (ultimo.duracionMs ?? 0) / maxDuracion),
        lentitud: grupo.reduce<Lentitud>((peor, g) => (g.lentitud === 'muy_lenta' || peor === 'muy_lenta') ? 'muy_lenta' : (g.lentitud === 'lenta' || peor === 'lenta') ? 'lenta' : null, null)
      };
      nodos.push(nodo);
      posicion.set(nodo.id, nodo);
      y += R_H + R_GAP_Y;
    }
  }

  // Evento de fin
  const ultimaLlamada = llamadas[llamadas.length - 1];
  const nodoFin: NodoRecorrido = {
    id: 'fin', tipo: 'fin', x: xFin, y: centroY - R_EVENTO / 2, w: R_EVENTO, h: R_EVENTO,
    titulo: recorrido.cierre === 'cierre_normal' ? 'Cierre de sesión' : (recorrido.cierre === 'termino_con_error' ? 'Terminó con error' : 'Sin cierre de sesión (abandono)'),
    tituloCorto: recorrido.cierre === 'cierre_normal' ? 'Cierre' : (recorrido.cierre === 'termino_con_error' ? 'Error' : 'Sin cierre'),
    metodo: '', linea2: '', estado: recorrido.cierre === 'termino_con_error' ? 'error' : (recorrido.cierre === 'cierre_normal' ? 'exito' : 'neutro'),
    intentos: ultimaLlamada ? [ultimaLlamada] : [], fallosPrevios: 0, cierre: recorrido.cierre, paso: 0, ratioDuracion: 0, lentitud: null
  };
  nodos.push(nodoFin);
  posicion.set('fin', nodoFin);

  // --- 4) Aristas ---
  const aristas: AristaRecorrido[] = [];
  const agregarArista = (idDe: string, idA: string, esperaMs: number) => {
    const de = posicion.get(idDe)!;
    const a = posicion.get(idA)!;
    const x1 = de.x + de.w;
    const y1 = de.y + de.h / 2;
    const x2 = a.x;
    const y2 = a.y + a.h / 2;
    aristas.push({
      id: `${idDe}>${idA}`,
      d: curvaHorizontal(x1, y1, x2 - 2, y2),
      etiqueta: esperaMs >= UMBRAL_ETIQUETA_ESPERA_MS ? `+${formatearDuracion(esperaMs)}` : null,
      lx: (x1 + x2) / 2,
      ly: (y1 + y2) / 2 - 7,
      desde: idDe,
      hacia: idA,
      esperaMs
    });
  };

  for (const j of jefes) {
    if (!previasDeGrupo.get(j)!.length) agregarArista('inicio', `n${j}`, 0);
  }
  for (const e of aristasGrupo.values()) agregarArista(`n${e.de}`, `n${e.a}`, e.esperaMs);
  for (const j of jefes) {
    if (!sucesoresDeGrupo.get(j)!.length) agregarArista(`n${j}`, 'fin', 0);
  }

  return {
    nodos,
    aristas,
    ancho: xFin + R_EVENTO + R_PAD,
    alto: R_PAD * 2 + altoContenido
  };
}

// ---------------------------------------------------------------------------
// LÍNEA DE TIEMPO DEL RECORRIDO (cascada)
// ---------------------------------------------------------------------------
export interface BarraTiempo {
  llamada: LlamadaFlujo;
  x: number;
  w: number;
  /** true si la barra es solo un punto (llamada sin fin o sin inicio registrado). */
  puntual: boolean;
  esperaPrevMs: number | null;
}

export interface MarcaEje { x: number; texto: string; }
export interface PausaTiempo { x: number; w: number; ms: number; texto: string; }

export interface ModeloLinea {
  barras: BarraTiempo[];
  marcas: MarcaEje[];
  pausas: PausaTiempo[];
  ancho: number;
  activoMs: number;
  totalMs: number;
}

const PAUSA_PX = 56;
const MIN_BARRA_PX = 5;

function formatearOffset(ms: number): string {
  if (ms <= 0) return '0 s';
  const s = ms / 1000;
  if (s < 60) return s < 10 && s % 1 !== 0 ? `${s.toFixed(1).replace('.', ',')} s` : `${Math.round(s)} s`;
  const min = Math.floor(s / 60);
  const resto = Math.round(s % 60);
  return resto ? `${min}:${String(resto).padStart(2, '0')} min` : `${min} min`;
}

export function construirLineaTiempo(recorrido: RecorridoFlujo, anchoObjetivo: number, comprimir: boolean): ModeloLinea {
  const ll = recorrido.llamadas;
  type Seg = { ini: number; fin: number };
  const intervalos: Seg[] = ll.map((l) => {
    const dur = l.duracionMs ?? 0;
    return { ini: l.offsetMs, fin: l.offsetMs + dur };
  });
  const totalMs = Math.max(1, ...intervalos.map((s) => s.fin));

  // Unir intervalos solapados -> segmentos de actividad
  const ordenados = intervalos.slice().sort((a, b) => a.ini - b.ini);
  const segmentos: Seg[] = [];
  for (const s of ordenados) {
    const ultimo = segmentos[segmentos.length - 1];
    if (ultimo && s.ini <= ultimo.fin) ultimo.fin = Math.max(ultimo.fin, s.fin);
    else segmentos.push({ ini: s.ini, fin: s.fin });
  }

  // Pausas: huecos largos entre segmentos que se comprimen a un ancho fijo
  const umbralPausa = Math.max(8000, totalMs * 0.06);
  const huecos: { desde: number; hasta: number; comprimido: boolean }[] = [];
  for (let i = 0; i < segmentos.length - 1; i++) {
    const ms = segmentos[i + 1].ini - segmentos[i].fin;
    huecos.push({ desde: segmentos[i].fin, hasta: segmentos[i + 1].ini, comprimido: comprimir && ms > umbralPausa });
  }
  const comprimidos = huecos.filter((h) => h.comprimido);
  const msVisibles = Math.max(1, totalMs - comprimidos.reduce((s, h) => s + (h.hasta - h.desde), 0));
  const pxPorMs = Math.max(0.004, (anchoObjetivo - comprimidos.length * PAUSA_PX) / msVisibles);

  // t (ms desde el inicio) -> x (px)
  const aX = (t: number): number => {
    let x = 0;
    let previo = 0;
    for (const h of comprimidos) {
      if (t <= h.desde) break;
      x += (h.desde - previo) * pxPorMs;
      if (t >= h.hasta) {
        x += PAUSA_PX;
        previo = h.hasta;
      } else {
        return x + ((t - h.desde) / (h.hasta - h.desde)) * PAUSA_PX;
      }
    }
    return x + (t - previo) * pxPorMs;
  };

  const barras: BarraTiempo[] = ll.map((l, i) => {
    const ini = intervalos[i].ini;
    const x = aX(ini);
    const xFin = aX(intervalos[i].fin);
    const puntual = l.duracionMs === null;
    let espera: number | null = null;
    if (i > 0) {
      const finPrev = intervalos[i - 1].fin;
      espera = Math.max(0, ini - finPrev);
    }
    return { llamada: l, x, w: puntual ? MIN_BARRA_PX : Math.max(MIN_BARRA_PX, xFin - x), puntual, esperaPrevMs: espera };
  });

  const pausas: PausaTiempo[] = comprimidos.map((h) => ({
    x: aX(h.desde),
    w: PAUSA_PX,
    ms: h.hasta - h.desde,
    texto: formatearDuracion(h.hasta - h.desde)
  }));

  // Eje: marcas "agradables" dentro de cada segmento de actividad
  const pasos = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000];
  const pasoMs = pasos.find((p) => p * pxPorMs >= 78) ?? pasos[pasos.length - 1];
  const marcas: MarcaEje[] = [];
  const agregarMarca = (t: number) => {
    const x = aX(t);
    if (!marcas.length || x - marcas[marcas.length - 1].x >= 60) marcas.push({ x, texto: t === 0 ? '0 s' : `+${formatearOffset(t)}` });
  };
  agregarMarca(0);
  for (let t = pasoMs; t <= totalMs; t += pasoMs) {
    const enPausa = comprimidos.some((h) => t > h.desde && t < h.hasta);
    if (!enPausa) agregarMarca(t);
  }
  const ancho = Math.ceil(aX(totalMs)) + 24;

  return { barras, marcas, pausas, ancho, activoMs: msVisibles, totalMs };
}

// ---------------------------------------------------------------------------
// MAPA GLOBAL (proceso agregado, de izquierda a derecha por etapas)
// ---------------------------------------------------------------------------
export interface NodoMapa extends NodoGlobalApi {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  col: number;
  nivel: 'ok' | 'aviso' | 'critico';
  /** Volumen relativo al servicio más usado (0 a 1). */
  volumen: number;
}

export interface AristaMapa {
  id: string;
  de: string;
  a: string;
  n: number;
  esperaPromMs: number;
  fallosDestino: number;
  nivel: 'ok' | 'aviso' | 'critico';
  d: string;
  grosor: number;
  lx: number;
  ly: number;
  mostrarEtiqueta: boolean;
}

export interface ColumnaMapa { indice: number; x: number; w: number; etiqueta: string; cantidad: number; }

export interface ModeloMapa {
  nodos: NodoMapa[];
  aristas: AristaMapa[];
  columnas: ColumnaMapa[];
  ancho: number;
  alto: number;
  maxN: number;
  /** Transiciones que vuelven a una etapa anterior (no se dibujan; salen en el detalle del servicio). */
  retornosOcultos: number;
}

const M_W = 244;
const M_H = 104;
const M_GAP_X = 96;
const M_GAP_Y = 16;
const M_PAD = 24;
const M_CABECERA = 40;
const M_MAX_COLUMNAS = 11;

export function nivelFallo(tasa: number): 'ok' | 'aviso' | 'critico' {
  if (tasa >= 0.1) return 'critico';
  if (tasa >= 0.02) return 'aviso';
  return 'ok';
}

export function construirModeloMapa(resp: MapaGlobalResponse, umbralMinN: number): ModeloMapa {
  const nodosApi = resp.nodos;
  const orden = nodosApi.slice().sort((a, b) => (a.posProm - b.posProm) || (b.total - a.total));
  const idxOrden = new Map(orden.map((n, i) => [n.metodo, i] as [string, number]));
  const porMetodo = new Map(nodosApi.map((n) => [n.metodo, n] as [string, NodoGlobalApi]));

  const validas = resp.aristas.filter((a) => a.n >= umbralMinN && idxOrden.has(a.de) && idxOrden.has(a.a) && a.de !== a.a);
  const adelante = validas.filter((a) => idxOrden.get(a.de)! < idxOrden.get(a.a)!);
  const retornosOcultos = validas.length - adelante.length;

  // --- Etapas (columnas): por posición promedio dentro del recorrido, y empujadas
  // a la derecha de su origen cuando un camino principal lo exige ---
  const cuantas = orden.length;
  const nCols = Math.max(1, Math.min(7, Math.ceil(Math.sqrt(cuantas) * 1.5)));
  const tamGrupo = Math.max(1, Math.ceil(cuantas / nCols));
  const col = new Map<string, number>();
  orden.forEach((n, i) => col.set(n.metodo, Math.floor(i / tamGrupo)));

  const entrantesPorNodo = new Map<string, typeof adelante>();
  for (const a of adelante) {
    if (!entrantesPorNodo.has(a.a)) entrantesPorNodo.set(a.a, []);
    entrantesPorNodo.get(a.a)!.push(a);
  }
  for (const n of orden) {
    const ent = entrantesPorNodo.get(n.metodo) ?? [];
    const total = ent.reduce((s, a) => s + a.n, 0) || 1;
    let c = col.get(n.metodo)!;
    for (const a of ent) {
      if (a.n / total >= 0.2) c = Math.max(c, Math.min(M_MAX_COLUMNAS - 1, col.get(a.de)! + 1));
    }
    col.set(n.metodo, c);
  }
  // Compactar columnas vacías
  const usadas = [...new Set(col.values())].sort((a, b) => a - b);
  const renum = new Map(usadas.map((c, i) => [c, i] as [number, number]));
  for (const [k, v] of col) col.set(k, renum.get(v)!);
  const totalCols = Math.max(1, usadas.length);

  const columnasNodos: string[][] = Array.from({ length: totalCols }, () => []);
  for (const n of nodosApi.slice().sort((a, b) => b.total - a.total)) columnasNodos[col.get(n.metodo)!].push(n.metodo);

  // --- Reducir cruces: promedio de la posición de los vecinos ---
  const pos = new Map<string, number>();
  const reindexar = () => columnasNodos.forEach((lista) => lista.forEach((id, i) => pos.set(id, i)));
  reindexar();
  const salientesPorNodo = new Map<string, typeof adelante>();
  for (const a of adelante) {
    if (!salientesPorNodo.has(a.de)) salientesPorNodo.set(a.de, []);
    salientesPorNodo.get(a.de)!.push(a);
  }
  const centro = (id: string, vecinos: { id: string; n: number }[]) => {
    if (!vecinos.length) return pos.get(id)!;
    const total = vecinos.reduce((s, v) => s + v.n, 0);
    return vecinos.reduce((s, v) => s + (pos.get(v.id) ?? 0) * v.n, 0) / total;
  };
  for (let barrido = 0; barrido < 4; barrido++) {
    if (barrido % 2 === 0) {
      for (let c = 1; c < totalCols; c++) {
        const peso = new Map(columnasNodos[c].map((id) => [id, centro(id, (entrantesPorNodo.get(id) ?? []).map((a) => ({ id: a.de, n: a.n })))] as [string, number]));
        columnasNodos[c].sort((x, y) => peso.get(x)! - peso.get(y)!);
        columnasNodos[c].forEach((id, i) => pos.set(id, i));
      }
    } else {
      for (let c = totalCols - 2; c >= 0; c--) {
        const peso = new Map(columnasNodos[c].map((id) => [id, centro(id, (salientesPorNodo.get(id) ?? []).map((a) => ({ id: a.a, n: a.n })))] as [string, number]));
        columnasNodos[c].sort((x, y) => peso.get(x)! - peso.get(y)!);
        columnasNodos[c].forEach((id, i) => pos.set(id, i));
      }
    }
  }

  // --- Posiciones ---
  const alturaCol = (k: number) => k * M_H + Math.max(0, k - 1) * M_GAP_Y;
  const altoMax = Math.max(M_H, ...columnasNodos.map((c) => alturaCol(c.length)));
  const maxTotal = Math.max(1, ...nodosApi.map((n) => n.total));
  const nodos: NodoMapa[] = [];
  const porId = new Map<string, NodoMapa>();
  columnasNodos.forEach((lista, c) => {
    let y = M_PAD + M_CABECERA + (altoMax - alturaCol(lista.length)) / 2;
    for (const id of lista) {
      const api = porMetodo.get(id)!;
      const nodo: NodoMapa = {
        ...api, id, x: M_PAD + c * (M_W + M_GAP_X), y, w: M_W, h: M_H, col: c,
        nivel: nivelFallo(api.tasaFallo), volumen: api.total / maxTotal
      };
      nodos.push(nodo);
      porId.set(id, nodo);
      y += M_H + M_GAP_Y;
    }
  });

  // --- Aristas: los puntos de anclaje se reparten por el costado de la caja ---
  const maxN = Math.max(1, ...adelante.map((a) => a.n));
  const salidasDe = new Map<string, typeof adelante>();
  const entradasA = new Map<string, typeof adelante>();
  for (const a of adelante) {
    if (!salidasDe.has(a.de)) salidasDe.set(a.de, []);
    if (!entradasA.has(a.a)) entradasA.set(a.a, []);
    salidasDe.get(a.de)!.push(a);
    entradasA.get(a.a)!.push(a);
  }
  const anclaSalida = new Map<string, number>();
  const anclaEntrada = new Map<string, number>();
  for (const [id, lista] of salidasDe) {
    lista.sort((p, q) => porId.get(p.a)!.y - porId.get(q.a)!.y);
    lista.forEach((a, i) => anclaSalida.set(`${a.de}>${a.a}`, (lista.length === 1 ? 0.5 : 0.22 + (0.56 * i) / (lista.length - 1))));
    void id;
  }
  for (const [id, lista] of entradasA) {
    lista.sort((p, q) => porId.get(p.de)!.y - porId.get(q.de)!.y);
    lista.forEach((a, i) => anclaEntrada.set(`${a.de}>${a.a}`, (lista.length === 1 ? 0.5 : 0.22 + (0.56 * i) / (lista.length - 1))));
    void id;
  }

  const aristas: AristaMapa[] = adelante.map((a) => {
    const de = porId.get(a.de)!;
    const hacia = porId.get(a.a)!;
    const clave = `${a.de}>${a.a}`;
    const x1 = de.x + de.w;
    const y1 = de.y + de.h * (anclaSalida.get(clave) ?? 0.5);
    const x2 = hacia.x - 2;
    const y2 = hacia.y + hacia.h * (anclaEntrada.get(clave) ?? 0.5);
    const dx = Math.max(40, (x2 - x1) * 0.5);
    return {
      id: clave,
      de: a.de,
      a: a.a,
      n: a.n,
      esperaPromMs: a.esperaPromMs,
      fallosDestino: a.fallosDestino,
      nivel: nivelFallo(a.n ? a.fallosDestino / a.n : 0),
      d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
      grosor: 1.4 + 7 * Math.sqrt(a.n / maxN),
      lx: (x1 + x2) / 2,
      ly: (y1 + y2) / 2 - 5,
      mostrarEtiqueta: a.n / maxN >= 0.14
    };
  });

  const columnas: ColumnaMapa[] = columnasNodos.map((lista, c) => ({
    indice: c,
    x: M_PAD + c * (M_W + M_GAP_X),
    w: M_W,
    cantidad: lista.length,
    etiqueta: totalCols === 1 ? 'Servicios' : c === 0 ? 'Arranque' : c === totalCols - 1 ? 'Cierre y salida' : `Etapa ${c + 1}`
  }));

  return {
    nodos,
    aristas,
    columnas,
    ancho: M_PAD * 2 + totalCols * M_W + (totalCols - 1) * M_GAP_X,
    alto: M_PAD * 2 + M_CABECERA + altoMax,
    maxN,
    retornosOcultos
  };
}
