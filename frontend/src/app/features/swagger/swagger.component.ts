import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import {
  SwaggerConsumo, SwaggerDocumento, SwaggerHistorialDetalle, SwaggerHistorialItem, SwaggerOperacion, SwaggerOrigen, SwaggerService,
} from '../../core/services/swagger.service';
import { SwaggerOrigenesComponent } from './swagger-origenes.component';
import { SwaggerOperacionComponent, CargaConsumo } from './swagger-operacion.component';
import { SwaggerModeloComponent } from './swagger-modelo.component';
import {
  Credencial, EsquemaSeguridad, claseEstado, claseMetodo, copiarTexto, credencialCompleta, formatearJson, hostDe, tamano,
} from './swagger-util';

type Pestana = 'endpoints' | 'guardados' | 'historial' | 'modelos';

interface GrupoEndpoints {
  etiqueta: string;
  descripcion: string;
  operaciones: SwaggerOperacion[];
}

interface GrupoConsumos {
  nombre: string;
  consumos: SwaggerConsumo[];
}

const METODOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const ESQUEMA_MANUAL: EsquemaSeguridad = {
  nombre: '__manual', tipo: 'apiKey', en: 'header', nombreParam: 'Authorization', detalle: 'header:Authorization',
  descripcion: 'Este Swagger no declara esquemas de seguridad. Escribe el valor completo del encabezado Authorization (por ejemplo: Bearer eyJ…).',
};

@Component({
  selector: 'app-swagger',
  standalone: true,
  imports: [CommonModule, FormsModule, SwaggerOrigenesComponent, SwaggerOperacionComponent, SwaggerModeloComponent],
  templateUrl: './swagger.component.html',
  styleUrl: './swagger.component.scss',
})
export class SwaggerComponent implements OnInit {
  readonly metodos = METODOS;
  readonly claseMetodo = claseMetodo;
  readonly claseEstado = claseEstado;
  readonly tamano = tamano;
  puedeEditar = false;
  esAdminPod = false;
  /** ADMIN_POD: ver también los Swagger privados de los demás. */
  verTodos = false;

  // Estado general
  cargandoInicial = true;
  sinTablas: string | null = null;
  errorGeneral = '';

  // Orígenes y documento
  origenes: SwaggerOrigen[] = [];
  origenId: number | null = null;
  doc: SwaggerDocumento | null = null;
  cargandoDoc = false;
  errorDoc = '';
  defIdx = 0;
  mostrarOrigenes = false;
  abrirNuevoOrigen = false;
  infoExpandida = false;

  // Servidor y autenticación
  baseUrl = '';
  esquemasSeg: EsquemaSeguridad[] = [];
  credenciales: Record<string, Credencial> = {};
  mostrarAutorizar = false;
  credEdicion: Record<string, Credencial> = {};
  verSecreto = new Set<string>();

  // Vista
  pestana: Pestana = 'endpoints';
  busqueda = '';
  metodosActivos: string[] = [];
  metodosResumen: { metodo: string; n: number }[] = [];
  grupos: GrupoEndpoints[] = [];
  totalFiltrado = 0;
  private colapsados = new Set<string>();
  abiertas = new Set<string>();
  fueAbierta = new Set<string>();
  private indices = new Map<string, number>();
  manualAbierto = false;
  manualUsado = false;

  // Carga de un consumo guardado en una operación
  cargaConsumo: CargaConsumo | null = null;
  cargaOpId: string | null = null;
  private cargaNonce = 0;

  // Consumos guardados
  consumos: SwaggerConsumo[] = [];
  gruposConsumos: GrupoConsumos[] = [];
  conteoPorOp = new Map<string, number>();
  cargandoConsumos = false;
  busquedaConsumos = '';

  // Historial
  historial: SwaggerHistorialItem[] = [];
  historialFiltrado: SwaggerHistorialItem[] = [];
  filtroHistEstado = '';
  busquedaHistorial = '';
  cargandoHistorial = false;
  historialTodos = false;
  historialCargadoDe: number | null = null;
  histDetalle: SwaggerHistorialDetalle | null = null;
  errorHistorial = '';

  // Modelos
  busquedaModelos = '';
  modelosAbiertos = new Set<string>();
  modelosFiltrados: NonNullable<SwaggerDocumento['esquemas']> = [];

  mensajeOk = '';
  copiado = '';
  private timerMensaje: any = null;

  constructor(private swagger: SwaggerService, private auth: AuthService) {}

  ngOnInit(): void {
    this.puedeEditar = this.auth.puedeEditar('SWAGGER');
    this.esAdminPod = this.auth.obtenerDatosUsuario()?.rol === 'ADMIN_POD';
    this.swagger.estado().subscribe({
      next: (e) => {
        if (!e.tablasListas) { this.sinTablas = e.mensaje; this.cargandoInicial = false; return; }
        this.cargarOrigenes(true);
      },
      error: (err) => { this.errorGeneral = err?.error?.error || 'No se pudo consultar el estado del módulo.'; this.cargandoInicial = false; },
    });
  }

  // ------------------------------------------------------------------
  // Orígenes y documento
  // ------------------------------------------------------------------
  cargarOrigenes(primeraVez = false, seleccionar?: number | null): void {
    this.swagger.origenes(this.verTodos).subscribe({
      next: (o) => {
        this.origenes = o;
        this.cargandoInicial = false;
        let elegido = seleccionar ?? this.origenId;
        if (primeraVez && elegido === null) {
          try { elegido = Number(localStorage.getItem('swagger_origen')) || null; } catch { /* sin almacenamiento */ }
        }
        if (!elegido || !o.some((x) => x.Id === elegido)) elegido = o.length ? o[0].Id : null;
        if (elegido !== null && (elegido !== this.origenId || !this.doc)) this.cambiarOrigen(elegido);
        else if (elegido === null) { this.origenId = null; this.doc = null; }
      },
      error: (err) => { this.errorGeneral = err?.error?.error || 'No se pudieron cargar los orígenes.'; this.cargandoInicial = false; },
    });
  }

  get origenActual(): SwaggerOrigen | null {
    return this.origenes.find((o) => o.Id === this.origenId) || null;
  }

  /** Dueño o ADMIN_POD: puede guardar y eliminar consumos de este origen (además de tener permiso de edición del módulo). */
  get puedeGuardar(): boolean {
    return this.puedeEditar && !!this.origenActual?.PuedeGestionar;
  }

  get misOrigenes(): SwaggerOrigen[] { return this.origenes.filter((o) => o.Propio); }
  get origenesAjenos(): SwaggerOrigen[] { return this.origenes.filter((o) => !o.Propio); }
  /** Con ADMIN_POD y «ver todos», los ajenos pueden ser privados de otros y no compartidos con él. */
  get tituloAjenos(): string { return this.esAdminPod ? 'De otros usuarios' : 'Compartidos conmigo'; }

  textoDueno(o: SwaggerOrigen): string {
    return o.SinDueno ? 'sin dueño' : (o.CreadoPor ? `de ${o.CreadoPor}` : 'de otro usuario');
  }

  alternarVerTodos(): void {
    this.cargarOrigenes(false);
  }

  cambiarOrigen(id: number | string): void {
    const n = Number(id);
    this.origenId = n;
    try { localStorage.setItem('swagger_origen', String(n)); } catch { /* sin almacenamiento */ }
    this.doc = null;
    this.defIdx = 0;
    this.consumos = [];
    this.gruposConsumos = [];
    this.conteoPorOp = new Map();
    this.historial = [];
    this.historialFiltrado = [];
    this.historialCargadoDe = null;
    this.histDetalle = null;
    this.abiertas = new Set();
    this.fueAbierta = new Set();
    this.manualAbierto = false;
    this.manualUsado = false;
    this.cargaConsumo = null;
    this.cargaOpId = null;
    this.baseUrl = '';
    this.esquemasSeg = [];
    this.leerCredenciales();
    this.cargarDocumento();
    this.cargarConsumos();
    if (this.pestana === 'historial') this.cargarHistorial();
  }

  cargarDocumento(refrescar = false): void {
    if (this.origenId === null) return;
    const id = this.origenId;
    this.cargandoDoc = true;
    this.errorDoc = '';
    this.swagger.documento(id, this.defIdx, refrescar).subscribe({
      next: (d) => {
        if (id !== this.origenId) return;
        const cambioDefinicion = !this.doc || this.doc.definicion !== d.definicion;
        this.doc = d;
        this.defIdx = d.definicion;
        this.cargandoDoc = false;
        this.indices = new Map(d.operaciones.map((o, i) => [o.id, i]));
        this.metodosResumen = METODOS
          .map((m) => ({ metodo: m, n: d.operaciones.filter((o) => o.metodo === m).length }))
          .filter((x) => x.n > 0);
        // Con muchos endpoints los grupos arrancan cerrados para no pintar miles de filas.
        if (cambioDefinicion) {
          this.colapsados = new Set(d.totalOperaciones > 150 ? d.etiquetas.map((t) => t.nombre) : []);
          this.abiertas = new Set();
          this.fueAbierta = new Set();
        }
        this.esquemasSeg = d.seguridad.length ? d.seguridad : [ESQUEMA_MANUAL];
        this.recalcular();
        this.recalcularModelos();
        this.recalcularConteoOps();
        this.ajustarBaseUrl();
      },
      error: (err) => {
        if (id !== this.origenId) return;
        this.cargandoDoc = false;
        this.errorDoc = err?.error?.error || 'No se pudo leer el Swagger.';
      },
    });
  }

  cambiarDefinicion(i: number | string): void {
    this.defIdx = Number(i);
    this.cargarDocumento();
  }

  abrirOrigenes(nuevo = false): void {
    this.abrirNuevoOrigen = nuevo;
    this.mostrarOrigenes = true;
  }

  cerrarOrigenes(cambio: boolean): void {
    this.mostrarOrigenes = false;
    this.abrirNuevoOrigen = false;
    if (cambio) {
      this.cargarOrigenes(false);
      if (this.origenId !== null) this.cargarDocumento(true);
    }
  }

  // ------------------------------------------------------------------
  // Servidor
  // ------------------------------------------------------------------
  private hostPermitido(url: string): boolean {
    if (!this.doc) return !!url.trim();
    const h = hostDe(url);
    return !!h && this.doc.servidores.some((s) => hostDe(s) === h);
  }

  private ajustarBaseUrl(): void {
    if (!this.doc || !this.doc.servidores.length) return;
    if (!this.baseUrl.trim() || !this.hostPermitido(this.baseUrl)) this.baseUrl = this.doc.servidores[0];
  }

  get servidorInvalido(): boolean {
    return !!this.doc && !!this.baseUrl.trim() && !this.hostPermitido(this.baseUrl);
  }

  usarServidor(url: string): void {
    this.baseUrl = url;
  }

  // ------------------------------------------------------------------
  // Autenticación (Authorize)
  // ------------------------------------------------------------------
  private leerCredenciales(): void {
    this.credenciales = {};
    if (this.origenId === null) return;
    try {
      const t = sessionStorage.getItem(`swagger_creds_${this.origenId}`);
      if (t) this.credenciales = JSON.parse(t) || {};
    } catch { this.credenciales = {}; }
  }

  private guardarCredenciales(): void {
    if (this.origenId === null) return;
    try {
      const limpio: Record<string, Credencial> = {};
      Object.entries(this.credenciales).forEach(([k, v]) => { if (v && (v.valor || v.usuario)) limpio[k] = v; });
      if (Object.keys(limpio).length) sessionStorage.setItem(`swagger_creds_${this.origenId}`, JSON.stringify(limpio));
      else sessionStorage.removeItem(`swagger_creds_${this.origenId}`);
    } catch { /* sin almacenamiento: queda solo en memoria */ }
  }

  get totalAutorizados(): number {
    return this.esquemasSeg.filter((e) => credencialCompleta(e, this.credenciales[e.nombre])).length;
  }

  estaAutorizado(e: EsquemaSeguridad): boolean {
    return credencialCompleta(e, this.credenciales[e.nombre]);
  }

  abrirAutorizar(): void {
    const copia: Record<string, Credencial> = {};
    this.esquemasSeg.forEach((e) => { copia[e.nombre] = { ...(this.credenciales[e.nombre] || {}) }; });
    this.credEdicion = copia;
    this.verSecreto = new Set();
    this.mostrarAutorizar = true;
  }

  autorizar(): void {
    const nuevas: Record<string, Credencial> = {};
    Object.entries(this.credEdicion).forEach(([k, v]) => { if (v && ((v.valor || '').trim() || (v.usuario || '').trim())) nuevas[k] = { ...v }; });
    this.credenciales = nuevas;
    this.guardarCredenciales();
    this.mostrarAutorizar = false;
    this.avisar(this.totalAutorizados ? `Credenciales aplicadas (${this.totalAutorizados}). Se envían solo a los endpoints que las requieren.` : 'Sin credenciales.');
  }

  cerrarSesionEsquema(e: EsquemaSeguridad): void {
    this.credEdicion[e.nombre] = {};
  }

  cerrarSesionTodo(): void {
    this.esquemasSeg.forEach((e) => { this.credEdicion[e.nombre] = {}; });
  }

  alternarSecreto(nombre: string): void {
    if (this.verSecreto.has(nombre)) this.verSecreto.delete(nombre);
    else this.verSecreto.add(nombre);
  }

  etiquetaTipoEsquema(e: EsquemaSeguridad): string {
    if (e.tipo === 'http') return e.esquema === 'basic' ? 'HTTP Basic' : `HTTP ${e.esquema === 'bearer' ? 'Bearer' : (e.esquema || '')}${e.formatoBearer ? ` (${e.formatoBearer})` : ''}`;
    if (e.tipo === 'apiKey') return `API Key (${e.en}: ${e.nombreParam})`;
    if (e.tipo === 'oauth2') return 'OAuth2 (pega un access token)';
    if (e.tipo === 'openIdConnect') return 'OpenID Connect (pega un access token)';
    return e.tipo;
  }

  esBasic(e: EsquemaSeguridad): boolean {
    return e.tipo === 'http' && e.esquema === 'basic';
  }

  // ------------------------------------------------------------------
  // Lista de endpoints
  // ------------------------------------------------------------------
  recalcular(): void {
    if (!this.doc) { this.grupos = []; this.totalFiltrado = 0; return; }
    const t = this.busqueda.toLowerCase().trim();
    const mapa = new Map<string, SwaggerOperacion[]>();
    let total = 0;
    for (const op of this.doc.operaciones) {
      if (this.metodosActivos.length && !this.metodosActivos.includes(op.metodo)) continue;
      if (t && !`${op.ruta} ${op.resumen} ${op.id} ${op.etiquetas.join(' ')} ${op.descripcion}`.toLowerCase().includes(t)) continue;
      const etiqueta = op.etiquetas[0];
      if (!mapa.has(etiqueta)) mapa.set(etiqueta, []);
      mapa.get(etiqueta)!.push(op);
      total += 1;
    }
    const descripciones = new Map(this.doc.etiquetas.map((e) => [e.nombre, e.descripcion]));
    this.grupos = [...mapa.entries()].map(([etiqueta, operaciones]) => ({ etiqueta, descripcion: descripciones.get(etiqueta) || '', operaciones }));
    this.totalFiltrado = total;
  }

  alternarMetodo(m: string): void {
    const i = this.metodosActivos.indexOf(m);
    if (i >= 0) this.metodosActivos.splice(i, 1);
    else this.metodosActivos.push(m);
    this.recalcular();
  }

  limpiarFiltros(): void {
    this.busqueda = '';
    this.metodosActivos = [];
    this.recalcular();
  }

  get hayFiltros(): boolean {
    return !!this.busqueda.trim() || this.metodosActivos.length > 0;
  }

  grupoAbierto(g: GrupoEndpoints): boolean {
    return !!this.busqueda.trim() || !this.colapsados.has(g.etiqueta);
  }

  alternarGrupo(g: GrupoEndpoints): void {
    if (this.colapsados.has(g.etiqueta)) this.colapsados.delete(g.etiqueta);
    else this.colapsados.add(g.etiqueta);
  }

  expandirTodosGrupos(): void {
    this.colapsados.clear();
  }

  contraerTodosGrupos(): void {
    this.colapsados = new Set(this.grupos.map((g) => g.etiqueta));
    this.busqueda = '';
    this.recalcular();
  }

  cerrarOperaciones(): void {
    this.abiertas = new Set();
  }

  trackGrupo = (_: number, g: GrupoEndpoints): string => g.etiqueta;
  trackOperacion = (_: number, o: SwaggerOperacion): string => o.id;
  trackConsumo = (_: number, c: SwaggerConsumo): number => c.Id;

  esAbierta(op: SwaggerOperacion): boolean {
    return this.abiertas.has(op.id);
  }

  alternarOperacion(op: SwaggerOperacion): void {
    if (this.abiertas.has(op.id)) { this.abiertas.delete(op.id); return; }
    this.abiertas.add(op.id);
    this.fueAbierta.add(op.id);
  }

  idDom(op: SwaggerOperacion): string {
    return `op-${this.indices.get(op.id) ?? 0}`;
  }

  cargaPara(id: string): CargaConsumo | null {
    return this.cargaOpId === id ? this.cargaConsumo : null;
  }

  // ------------------------------------------------------------------
  // Consumos guardados
  // ------------------------------------------------------------------
  cargarConsumos(): void {
    if (this.origenId === null) return;
    const id = this.origenId;
    this.cargandoConsumos = true;
    this.swagger.consumos(id).subscribe({
      next: (c) => { if (id === this.origenId) { this.consumos = c; this.cargandoConsumos = false; this.recalcularConsumos(); this.recalcularConteoOps(); } },
      error: () => { if (id === this.origenId) this.cargandoConsumos = false; },
    });
  }

  recalcularConsumos(): void {
    const t = this.busquedaConsumos.toLowerCase().trim();
    const lista = t ? this.consumos.filter((c) => `${c.Nombre} ${c.Ruta} ${c.Metodo} ${c.Grupo} ${c.Notas}`.toLowerCase().includes(t)) : this.consumos;
    const mapa = new Map<string, SwaggerConsumo[]>();
    lista.forEach((c) => {
      const g = c.Grupo || 'Sin grupo';
      if (!mapa.has(g)) mapa.set(g, []);
      mapa.get(g)!.push(c);
    });
    this.gruposConsumos = [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([nombre, consumos]) => ({ nombre, consumos }));
  }

  private recalcularConteoOps(): void {
    const m = new Map<string, number>();
    if (this.doc) {
      this.consumos.forEach((c) => {
        const op = this.buscarOperacion(c.OperacionId, c.Metodo, c.Ruta);
        if (op) m.set(op.id, (m.get(op.id) || 0) + 1);
      });
    }
    this.conteoPorOp = m;
  }

  private buscarOperacion(id: string, metodo: string, ruta: string): SwaggerOperacion | null {
    if (!this.doc) return null;
    return this.doc.operaciones.find((o) => (id && o.id === id)) ||
      this.doc.operaciones.find((o) => o.metodo === metodo && o.ruta === ruta) || null;
  }

  abrirConsumo(c: SwaggerConsumo): void {
    const op = this.buscarOperacion(c.OperacionId, c.Metodo, c.Ruta);
    this.cargaNonce += 1;
    this.cargaOpId = op ? op.id : '__manual__';
    this.cargaConsumo = { consumo: c, nonce: this.cargaNonce };
    this.pestana = 'endpoints';
    if (op) {
      this.busqueda = '';
      this.metodosActivos = [];
      this.recalcular();
      this.colapsados.delete(op.etiquetas[0]);
      this.abiertas.add(op.id);
      this.fueAbierta.add(op.id);
      setTimeout(() => document.getElementById(this.idDom(op))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    } else {
      this.manualAbierto = true;
      this.manualUsado = true;
      setTimeout(() => document.getElementById('op-manual')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    }
  }

  alternarManual(): void {
    this.manualAbierto = !this.manualAbierto;
    if (this.manualAbierto) this.manualUsado = true;
  }

  copiarTextoPlano(texto: string, etiqueta: string): void {
    copiarTexto(texto).then((ok) => { if (ok) { this.copiado = etiqueta; setTimeout(() => { if (this.copiado === etiqueta) this.copiado = ''; }, 1500); } });
  }

  eliminarConsumo(c: SwaggerConsumo): void {
    if (!confirm(`¿Eliminar el consumo guardado "${c.Nombre}"?`)) return;
    this.swagger.eliminarConsumo(c.Id).subscribe({
      next: () => {
        this.cargarConsumos();
        this.cargarOrigenesSilencioso();
      },
      error: (err) => alert(err?.error?.error || 'No se pudo eliminar el consumo.'),
    });
  }

  private cargarOrigenesSilencioso(): void {
    this.swagger.origenes(this.verTodos).subscribe({ next: (o) => { this.origenes = o; } });
  }

  alGuardarConsumo(): void {
    this.cargarConsumos();
    this.cargarOrigenesSilencioso();
  }

  avisar(texto: string): void {
    this.mensajeOk = texto;
    if (this.timerMensaje) clearTimeout(this.timerMensaje);
    this.timerMensaje = setTimeout(() => { this.mensajeOk = ''; }, 7000);
  }

  // ------------------------------------------------------------------
  // Historial
  // ------------------------------------------------------------------
  seleccionarPestana(p: Pestana): void {
    this.pestana = p;
    if (p === 'historial' && this.historialCargadoDe !== this.origenId) this.cargarHistorial();
  }

  cargarHistorial(): void {
    if (this.origenId === null) return;
    const id = this.origenId;
    this.cargandoHistorial = true;
    this.errorHistorial = '';
    this.swagger.historial(id, this.historialTodos).subscribe({
      next: (r) => {
        if (id !== this.origenId) return;
        this.historial = r.items;
        this.historialCargadoDe = id;
        this.cargandoHistorial = false;
        this.recalcularHistorial();
      },
      error: (err) => {
        if (id !== this.origenId) return;
        this.cargandoHistorial = false;
        this.errorHistorial = err?.error?.error || 'No se pudo cargar el historial.';
      },
    });
  }

  recalcularHistorial(): void {
    const t = this.busquedaHistorial.toLowerCase().trim();
    this.historialFiltrado = this.historial.filter((h) => {
      if (this.filtroHistEstado === 'ok' && !(h.Estado !== null && h.Estado < 400)) return false;
      if (this.filtroHistEstado === '4xx' && !(h.Estado !== null && h.Estado >= 400 && h.Estado < 500)) return false;
      if (this.filtroHistEstado === '5xx' && !(h.Estado !== null && h.Estado >= 500)) return false;
      if (this.filtroHistEstado === 'error' && h.Estado !== null) return false;
      if (t && !`${h.Url} ${h.Metodo} ${h.Username || ''}`.toLowerCase().includes(t)) return false;
      return true;
    });
  }

  refrescarHistorialSiAbierto(): void {
    if (this.historialCargadoDe === this.origenId) this.cargarHistorial();
  }

  verHistorial(h: SwaggerHistorialItem): void {
    this.swagger.historialDetalle(h.Id).subscribe({
      next: (d) => { this.histDetalle = d; },
      error: (err) => alert(err?.error?.error || 'No se pudo abrir el registro.'),
    });
  }

  cuerpoHistorial(texto: string): string {
    return formatearJson(texto || '');
  }

  entradas(obj: Record<string, string> | undefined): { k: string; v: string }[] {
    return Object.entries(obj || {}).map(([k, v]) => ({ k, v }));
  }

  // ------------------------------------------------------------------
  // Modelos
  // ------------------------------------------------------------------
  recalcularModelos(): void {
    const t = this.busquedaModelos.toLowerCase().trim();
    const todos = this.doc?.esquemas || [];
    this.modelosFiltrados = t ? todos.filter((m) => m.nombre.toLowerCase().includes(t)) : todos;
  }

  alternarModelo(nombre: string): void {
    if (this.modelosAbiertos.has(nombre)) this.modelosAbiertos.delete(nombre);
    else this.modelosAbiertos.add(nombre);
  }

  get totalModelos(): number {
    return this.doc?.esquemas?.length || 0;
  }

  trackModelo = (_: number, m: { nombre: string }): string => m.nombre;
  trackHist = (_: number, h: SwaggerHistorialItem): number => h.Id;
}
