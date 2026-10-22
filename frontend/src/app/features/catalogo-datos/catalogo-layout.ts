import { Grafo, GrafoArista, GrafoNodo, Galaxia, MapaBase, OrigenEstado, Puente } from '../../core/services/catalogo-datos.service';

// ==========================================================================
// Cálculo de posiciones (funciones puras, sin DOM) para el diagrama ER y el
// mapa estelar. Todo el dibujo es SVG escrito a mano: sin librerías nuevas.
// ==========================================================================

// --------------------------------------------------------------------------
// Pan / zoom compartido por el diagrama ER y el mapa
// --------------------------------------------------------------------------
export class PanZoom {
  k = 1;
  tx = 0;
  ty = 0;
  ancho = 900;
  alto = 560;
  /** true si el último gesto fue un arrastre (para ignorar el click que le sigue). */
  movido = false;
  private arrastrando = false;
  private x0 = 0;
  private y0 = 0;
  private tx0 = 0;
  private ty0 = 0;

  get transform(): string { return `translate(${this.tx} ${this.ty}) scale(${this.k})`; }

  private punto(ev: { clientX: number; clientY: number }, el: Element): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (this.ancho / (r.width || 1)), y: (ev.clientY - r.top) * (this.alto / (r.height || 1)) };
  }

  zoomEn(px: number, py: number, factor: number): void {
    const k2 = Math.min(Math.max(this.k * factor, 0.04), 10);
    this.tx = px - (px - this.tx) * (k2 / this.k);
    this.ty = py - (py - this.ty) * (k2 / this.k);
    this.k = k2;
  }

  rueda(ev: WheelEvent, el: Element): void {
    ev.preventDefault();
    const p = this.punto(ev, el);
    this.zoomEn(p.x, p.y, Math.exp(-ev.deltaY * 0.0016));
  }

  zoomCentro(factor: number): void { this.zoomEn(this.ancho / 2, this.alto / 2, factor); }

  bajar(ev: PointerEvent, el: Element): void {
    if (ev.button !== 0) return;
    const p = this.punto(ev, el);
    this.arrastrando = true;
    this.movido = false;
    this.x0 = p.x; this.y0 = p.y; this.tx0 = this.tx; this.ty0 = this.ty;
  }

  mover(ev: PointerEvent, el: Element): void {
    if (!this.arrastrando) return;
    const p = this.punto(ev, el);
    const dx = p.x - this.x0;
    const dy = p.y - this.y0;
    if (!this.movido && Math.hypot(dx, dy) < 4) return;
    this.movido = true;
    this.tx = this.tx0 + dx;
    this.ty = this.ty0 + dy;
  }

  soltar(): void {
    this.arrastrando = false;
    // El click del nodo se dispara justo después: se limpia en el siguiente ciclo.
    setTimeout(() => { this.movido = false; }, 0);
  }

  /** Encuadra un rectángulo del mundo dentro del lienzo. */
  encuadrar(minX: number, minY: number, maxX: number, maxY: number, margen = 28): void {
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    const k = Math.min((this.ancho - margen * 2) / w, (this.alto - margen * 2) / h, 1.6);
    this.k = Math.max(k, 0.04);
    this.tx = (this.ancho - w * this.k) / 2 - minX * this.k;
    this.ty = (this.alto - h * this.k) / 2 - minY * this.k;
  }

  /** Centra el punto del mundo (x, y) con el zoom indicado. */
  centrarEn(x: number, y: number, k = this.k): void {
    this.k = k;
    this.tx = this.ancho / 2 - x * k;
    this.ty = this.alto / 2 - y * k;
  }
}

// --------------------------------------------------------------------------
// Diagrama ER
// --------------------------------------------------------------------------
export const ER_W = 250;
export const ER_CAB = 36;
export const ER_FILA = 21;
const ER_GAP_X = 130;
const ER_GAP_Y = 34;
const ER_PAD = 30;

export interface ErNodo {
  n: GrafoNodo;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cuántas filas de columnas se dibujan (más la fila «… N más», si aplica). */
  filas: number;
}

export interface ErArista {
  a: GrafoArista;
  d: string;            // curva
  pata: string;         // pata de gallo (lado «muchos»: tabla hija)
  barra: string;        // marca del lado «uno»: tabla padre
  x: number;            // punto medio (para resaltar / etiqueta)
  y: number;
  texto: string;        // columnas: col → refCol
}

export interface ErDiseno { nodos: ErNodo[]; aristas: ErArista[]; ancho: number; alto: number; }

export const alturaNodoEr = (n: GrafoNodo): number => ER_CAB + n.columnas.length * ER_FILA + (n.masColumnas > 0 ? ER_FILA : 0) + 8;

export function disenoEr(g: Grafo): ErDiseno {
  const porId = new Map<string, ErNodo>();
  for (const n of g.nodos) {
    porId.set(n.id, { n, x: 0, y: 0, w: ER_W, h: alturaNodoEr(n), filas: n.columnas.length + (n.masColumnas > 0 ? 1 : 0) });
  }
  const vecinos = new Map<string, string[]>();
  for (const a of g.aristas) {
    if (a.desde === a.hacia) continue;
    (vecinos.get(a.desde) || vecinos.set(a.desde, []).get(a.desde)!).push(a.hacia);
    (vecinos.get(a.hacia) || vecinos.set(a.hacia, []).get(a.hacia)!).push(a.desde);
  }
  const niveles = [...new Set(g.nodos.map((n) => n.nivel))].sort((a, b) => a - b);
  const colocado = new Set<string>();
  const centroY = (id: string): number => { const e = porId.get(id)!; return e.y + e.h / 2; };

  const apilar = (ids: string[]): void => {
    const ideal = new Map<string, number>();
    for (const id of ids) {
      const ys = (vecinos.get(id) || []).filter((v) => colocado.has(v)).map(centroY);
      ideal.set(id, ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : 0);
    }
    const orden = [...ids].sort((p, q) => (ideal.get(p)! - ideal.get(q)!) || (ids.indexOf(p) - ids.indexOf(q)));
    let tope = -Infinity;
    for (const id of orden) {
      const e = porId.get(id)!;
      e.y = Math.max(ideal.get(id)! - e.h / 2, tope === -Infinity ? -Infinity : tope + ER_GAP_Y);
      tope = e.y + e.h;
    }
    ids.forEach((id) => colocado.add(id));
  };

  const idsDe = (nivel: number): string[] => g.nodos.filter((n) => n.nivel === nivel).map((n) => n.id);
  apilar(idsDe(0));
  // Hacia ambos lados, empezando por el anillo más cercano al centro.
  for (const nivel of niveles.filter((x) => x < 0).reverse()) apilar(idsDe(nivel));
  for (const nivel of niveles.filter((x) => x > 0)) apilar(idsDe(nivel));

  // Un nivel con demasiadas tablas se reparte en varias sub-columnas para que el diagrama no sea una torre.
  const ALTO_MAX_COL = 1150;
  const subCols = new Map<number, string[][]>();
  for (const nivel of niveles) {
    const ids = idsDe(nivel).sort((p, q) => porId.get(p)!.y - porId.get(q)!.y);
    const total = ids.reduce((sum, id) => sum + porId.get(id)!.h + ER_GAP_Y, 0);
    const k = nivel === 0 ? 1 : Math.max(1, Math.ceil(total / ALTO_MAX_COL));
    if (k === 1) { subCols.set(nivel, [ids]); continue; }
    const objetivo = total / k;
    const grupos: string[][] = [[]];
    let acum = 0;
    for (const id of ids) {
      const h = porId.get(id)!.h + ER_GAP_Y;
      if (acum + h / 2 > objetivo * grupos.length && grupos.length < k) grupos.push([]);
      grupos[grupos.length - 1].push(id);
      acum += h;
    }
    for (const grupo of grupos) {
      let y = grupo.length ? porId.get(grupo[0])!.y : 0;
      for (const id of grupo) { const e = porId.get(id)!; e.y = y; y += e.h + ER_GAP_Y; }
    }
    subCols.set(nivel, grupos);
  }
  let cursorX = ER_PAD;
  const xDe = new Map<string, number>();
  for (const nivel of niveles) {
    for (const grupo of subCols.get(nivel)!) {
      for (const id of grupo) xDe.set(id, cursorX);
      cursorX += ER_W + ER_GAP_X;
    }
  }
  let minY = Infinity;
  let maxY = -Infinity;
  for (const e of porId.values()) {
    e.x = xDe.get(e.n.id)!;
    minY = Math.min(minY, e.y);
    maxY = Math.max(maxY, e.y + e.h);
  }
  for (const e of porId.values()) e.y = e.y - minY + ER_PAD;

  const yFila = (e: ErNodo, columna: string): number => {
    const i = e.n.columnas.findIndex((c) => c.nombre.toLowerCase() === columna.toLowerCase());
    if (i >= 0) return e.y + ER_CAB + i * ER_FILA + ER_FILA / 2;
    if (e.n.masColumnas > 0) return e.y + ER_CAB + e.n.columnas.length * ER_FILA + ER_FILA / 2;
    return e.y + ER_CAB / 2;
  };

  const aristas: ErArista[] = [];
  // Para separar visualmente varias relaciones que salen del mismo lado de una tabla.
  const usos = new Map<string, number>();
  for (const a of g.aristas) {
    const hijo = porId.get(a.desde);
    const padre = porId.get(a.hacia);
    if (!hijo || !padre) continue;
    const colHijo = a.columnas[0]?.col || '';
    const colPadre = a.columnas[0]?.refCol || '';
    const y1 = yFila(hijo, colHijo);
    const y2 = yFila(padre, colPadre);
    let x1: number; let x2: number; let d1: number; let d2: number;
    if (hijo === padre || hijo.x === padre.x) {
      x1 = hijo.x + hijo.w; x2 = padre.x + padre.w; d1 = 1; d2 = 1;
    } else if (hijo.x > padre.x) {
      x1 = hijo.x; x2 = padre.x + padre.w; d1 = -1; d2 = 1;
    } else {
      x1 = hijo.x + hijo.w; x2 = padre.x; d1 = 1; d2 = -1;
    }
    const k = `${a.desde}|${d1}`;
    const n = usos.get(k) || 0;
    usos.set(k, n + 1);
    let d: string;
    let mx: number; let my: number;
    if (d1 === d2) {
      const salida = 46 + n * 14;
      const xm = Math.max(x1, x2) + salida;
      d = `M ${x1} ${y1} C ${xm} ${y1}, ${xm} ${y2}, ${x2} ${y2}`;
      mx = xm - salida * 0.25; my = (y1 + y2) / 2;
    } else {
      const dx = Math.max(Math.abs(x2 - x1) * 0.5, 40);
      d = `M ${x1} ${y1} C ${x1 + d1 * dx} ${y1}, ${x2 + d2 * dx} ${y2}, ${x2} ${y2}`;
      mx = (x1 + x2) / 2; my = (y1 + y2) / 2;
    }
    const p = d1 === 1 ? 12 : -12;
    const pata = `M ${x1 + p} ${y1} L ${x1} ${y1 - 6} M ${x1 + p} ${y1} L ${x1} ${y1} M ${x1 + p} ${y1} L ${x1} ${y1 + 6}`;
    const q = d2 === 1 ? 9 : -9;
    const barra = `M ${x2 + q} ${y2 - 6} L ${x2 + q} ${y2 + 6} M ${x2 + q * 1.7} ${y2 - 6} L ${x2 + q * 1.7} ${y2 + 6}`;
    aristas.push({ a, d, pata, barra, x: mx, y: my, texto: a.columnas.map((c) => `${c.col} → ${c.refCol}`).join(', ') });
  }

  const nodos = [...porId.values()];
  const ancho = Math.max(...nodos.map((e) => e.x + e.w), 0) + ER_PAD + 60;
  const alto = Math.max(...nodos.map((e) => e.y + e.h), 0) + ER_PAD;
  return { nodos, aristas, ancho, alto };
}

// --------------------------------------------------------------------------
// Mapa estelar
// --------------------------------------------------------------------------
export interface Circulo { x: number; y: number; r: number; }

/** Coloca círculos sin que se toquen: el mayor al centro y el resto en espiral. Devuelve el centro de cada uno. */
export function empaquetar(radios: number[], separacion = 10): { x: number; y: number }[] {
  const orden = radios.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r);
  const colocados: Circulo[] = [];
  const pos: { x: number; y: number }[] = new Array(radios.length);
  for (const { r, i } of orden) {
    if (!colocados.length) {
      colocados.push({ x: 0, y: 0, r });
      pos[i] = { x: 0, y: 0 };
      continue;
    }
    const paso = Math.max(Math.min(r, 12) / 2, 3);
    let hallado: { x: number; y: number } | null = null;
    for (let rho = 0; !hallado; rho += paso) {
      const pasos = Math.max(rho === 0 ? 1 : Math.ceil((2 * Math.PI * rho) / paso), 1);
      const desfase = rho * 0.37;
      for (let s = 0; s < pasos; s++) {
        const ang = desfase + (s / pasos) * Math.PI * 2;
        const x = Math.cos(ang) * rho;
        const y = Math.sin(ang) * rho;
        let choca = false;
        for (const c of colocados) {
          const dx = c.x - x; const dy = c.y - y;
          const minimo = c.r + r + separacion;
          if (dx * dx + dy * dy < minimo * minimo) { choca = true; break; }
        }
        if (!choca) { hallado = { x, y }; break; }
      }
      if (rho > 200000) { hallado = { x: rho, y: 0 }; }
    }
    colocados.push({ x: hallado.x, y: hallado.y, r });
    pos[i] = hallado;
  }
  return pos;
}

const ANGULO_ORO = 2.399963229728653;
/** Disposición en girasol: n puntos repartidos en un disco. */
export function girasol(n: number, espacio: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = espacio * Math.sqrt(i + 0.5);
    pts.push({ x: Math.cos(i * ANGULO_ORO) * r, y: Math.sin(i * ANGULO_ORO) * r });
  }
  return pts;
}

export interface EstrellaTabla {
  i: number;               // índice dentro de MapaBase.tablas
  x: number;
  y: number;
  r: number;
}
export interface EnlaceTabla { a: number; b: number; }   // a = hija, b = padre (índices de estrellas)
export interface MapaDiseno {
  estrellas: EstrellaTabla[];
  enlaces: EnlaceTabla[];
  /** Círculos tenues alrededor de cada grupo de tablas relacionadas (constelaciones). */
  halos: Circulo[];
  minX: number; minY: number; maxX: number; maxY: number;
}

const radioTabla = (nColumnas: number, grado: number): number =>
  Math.min(Math.max(3.5 + Math.sqrt(nColumnas) * 0.85, 4), 10) + Math.min(grado * 0.35, 4);

export function disenoMapaBase(m: MapaBase): MapaDiseno {
  const n = m.tablas.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  const enlaces: EnlaceTabla[] = [];
  for (const [h, p] of m.aristas) {
    if (h === p) continue;
    adj[h].push(p); adj[p].push(h);
    enlaces.push({ a: h, b: p });
  }
  const radios = m.tablas.map((t, i) => radioTabla(t.nColumnas, adj[i].length));

  // Componentes conectados por llaves foráneas.
  const comp = new Array<number>(n).fill(-1);
  const comps: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1 || !adj[s].length) continue;
    const lista: number[] = [];
    const cola = [s];
    comp[s] = comps.length;
    while (cola.length) {
      const u = cola.shift()!;
      lista.push(u);
      for (const v of adj[u]) if (comp[v] === -1) { comp[v] = comps.length; cola.push(v); }
    }
    comps.push(lista);
  }
  const aislados = Array.from({ length: n }, (_, i) => i).filter((i) => comp[i] === -1);

  // Cada bloque: posiciones locales (respecto a su centro) y radio que lo contiene.
  interface Bloque { idx: number[]; loc: { x: number; y: number }[]; r: number; halo: boolean; }
  const bloques: Bloque[] = [];

  for (const lista of comps) {
    const raiz = lista.reduce((mejor, u) => (adj[u].length > adj[mejor].length ? u : mejor), lista[0]);
    const prof = new Map<number, number>([[raiz, 0]]);
    const padre = new Map<number, number>();
    const hijos = new Map<number, number[]>();
    const orden: number[] = [raiz];
    for (let q = 0; q < orden.length; q++) {
      const u = orden[q];
      for (const v of adj[u]) {
        if (prof.has(v)) continue;
        prof.set(v, prof.get(u)! + 1);
        padre.set(v, u);
        (hijos.get(u) || hijos.set(u, []).get(u)!).push(v);
        orden.push(v);
      }
    }
    const hojas = new Map<number, number>();
    for (let q = orden.length - 1; q >= 0; q--) {
      const u = orden[q];
      const hs = hijos.get(u) || [];
      hojas.set(u, hs.length ? hs.reduce((s, h) => s + hojas.get(h)!, 0) : 1);
    }
    const nPorProf = new Map<number, number>();
    for (const u of orden) nPorProf.set(prof.get(u)!, (nPorProf.get(prof.get(u)!) || 0) + 1);
    const maxProf = Math.max(...prof.values());
    const radioAnillo: number[] = [0];
    for (let d = 1; d <= maxProf; d++) {
      radioAnillo.push(Math.max(radioAnillo[d - 1] + 54, ((nPorProf.get(d) || 1) * 26) / (2 * Math.PI)));
    }
    const ang = new Map<number, number>();
    const reparto = (u: number, desde: number, hasta: number): void => {
      ang.set(u, (desde + hasta) / 2);
      const hs = hijos.get(u) || [];
      const total = hs.reduce((s, h) => s + hojas.get(h)!, 0) || 1;
      let cursor = desde;
      for (const h of hs) {
        const span = ((hasta - desde) * hojas.get(h)!) / total;
        reparto(h, cursor, cursor + span);
        cursor += span;
      }
    };
    reparto(raiz, 0, Math.PI * 2);
    const loc = lista.map((u) => {
      const r = radioAnillo[prof.get(u)!];
      return { x: Math.cos(ang.get(u)!) * r, y: Math.sin(ang.get(u)!) * r };
    });
    const rBloque = radioAnillo[maxProf] + Math.max(...lista.map((u) => radios[u])) + 14;
    bloques.push({ idx: lista, loc, r: rBloque, halo: lista.length > 2 });
  }

  if (aislados.length) {
    const espacio = aislados.length > 900 ? 15 : 20;
    const loc = girasol(aislados.length, espacio);
    const rBloque = Math.max(...loc.map((p) => Math.hypot(p.x, p.y))) + 16;
    bloques.push({ idx: aislados, loc, r: rBloque, halo: false });
  }

  const centros = empaquetar(bloques.map((b) => b.r), 22);
  const estrellas: EstrellaTabla[] = [];
  const halos: Circulo[] = [];
  bloques.forEach((b, bi) => {
    b.idx.forEach((u, k) => estrellas.push({ i: u, x: centros[bi].x + b.loc[k].x, y: centros[bi].y + b.loc[k].y, r: radios[u] }));
    if (b.halo) halos.push({ x: centros[bi].x, y: centros[bi].y, r: b.r });
  });
  const pos = new Map(estrellas.map((e) => [e.i, e]));
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const e of estrellas) {
    minX = Math.min(minX, e.x - e.r); minY = Math.min(minY, e.y - e.r);
    maxX = Math.max(maxX, e.x + e.r); maxY = Math.max(maxY, e.y + e.r);
  }
  if (!estrellas.length) { minX = minY = -50; maxX = maxY = 50; }
  void pos;
  return { estrellas, enlaces, halos, minX, minY, maxX, maxY };
}

// --- Galaxia: orígenes → bases → mapa de puentes -------------------------------------
export interface EstrellaBase {
  o: string;
  origenNombre: string;
  motor: string;
  bd: string;
  tablas: number;
  vistas: number;
  fks: number;
  error: boolean;
  x: number;
  y: number;
  r: number;
  color: number;                         // índice de color del origen
  polvo: { x: number; y: number }[];     // «estrellitas» dentro de la base (decorativas)
}
export interface Cumulo { o: string; nombre: string; motor: string; estado: string; x: number; y: number; r: number; color: number; }
export interface PuenteDibujo { p: Puente; x1: number; y1: number; x2: number; y2: number; grosor: number; }
export interface GalaxiaDiseno { bases: EstrellaBase[]; cumulos: Cumulo[]; puentes: PuenteDibujo[]; minX: number; minY: number; maxX: number; maxY: number; }

export function disenoGalaxia(g: Galaxia): GalaxiaDiseno {
  const origenes: OrigenEstado[] = g.origenes;
  interface Grupo { o: OrigenEstado; color: number; bases: { nombre: string; tablas: number; vistas: number; fks: number; error: boolean; r: number }[]; loc: { x: number; y: number }[]; r: number; }
  const grupos: Grupo[] = origenes.map((o, i) => {
    const bases = o.bases.map((b) => ({
      nombre: b.nombre, tablas: b.tablas, vistas: b.vistas, fks: b.fks, error: !!b.error,
      r: Math.min(Math.max(16 + Math.sqrt(b.tablas + b.vistas) * 2.6, 18), 64),
    }));
    const loc = empaquetar(bases.map((b) => b.r), 24);
    let r = 40;
    bases.forEach((b, k) => { r = Math.max(r, Math.hypot(loc[k].x, loc[k].y) + b.r + 30); });
    return { o, color: i, bases, loc, r };
  });
  const centros = empaquetar(grupos.map((x) => x.r), 60);
  const bases: EstrellaBase[] = [];
  const cumulos: Cumulo[] = [];
  const posBase = new Map<string, EstrellaBase>();
  grupos.forEach((gr, gi) => {
    cumulos.push({ o: gr.o.id, nombre: gr.o.nombre, motor: gr.o.motor, estado: gr.o.estado, x: centros[gi].x, y: centros[gi].y, r: gr.r, color: gr.color });
    gr.bases.forEach((b, k) => {
      const n = Math.min(b.tablas + b.vistas, 36);
      const polvo = girasol(n, Math.max(b.r * 0.9 / Math.sqrt(Math.max(n, 1)), 3));
      const e: EstrellaBase = {
        o: gr.o.id, origenNombre: gr.o.nombre, motor: gr.o.motor, bd: b.nombre, tablas: b.tablas, vistas: b.vistas, fks: b.fks, error: b.error,
        x: centros[gi].x + gr.loc[k].x, y: centros[gi].y + gr.loc[k].y, r: b.r, color: gr.color, polvo,
      };
      bases.push(e);
      posBase.set(`${e.o}\u0001${e.bd}`, e);
    });
  });
  const puentes: PuenteDibujo[] = [];
  const maxComunes = Math.max(...g.puentes.map((p) => p.comunes), 1);
  for (const p of g.puentes) {
    const a = posBase.get(`${p.a.o}\u0001${p.a.bd}`);
    const b = posBase.get(`${p.b.o}\u0001${p.b.bd}`);
    if (!a || !b) continue;
    puentes.push({ p, x1: a.x, y1: a.y, x2: b.x, y2: b.y, grosor: 1 + (p.comunes / maxComunes) * 3.5 });
  }
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const c of cumulos) { minX = Math.min(minX, c.x - c.r); minY = Math.min(minY, c.y - c.r - 40); maxX = Math.max(maxX, c.x + c.r); maxY = Math.max(maxY, c.y + c.r); }
  if (!cumulos.length) { minX = minY = -50; maxX = maxY = 50; }
  return { bases, cumulos, puentes, minX, minY, maxX, maxY };
}
