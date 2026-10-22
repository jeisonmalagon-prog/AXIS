import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import {
  FilaClaveValor, SwaggerConsumo, SwaggerConsumoForm, SwaggerDocumento, SwaggerModelo, SwaggerOperacion, SwaggerRespuesta, SwaggerService,
} from '../../core/services/swagger.service';
import { SwaggerModeloComponent } from './swagger-modelo.component';
import {
  AuthAplicada, Credencial, EsquemaSeguridad, TablaJson, aplicarCredenciales, claseCodigo, claseEstado, claseMetodo, copiarTexto, descargarTexto,
  errorDeJson, esCampoSecreto, extensionDe, formatearJson, hostDe, pareceJson, resaltarJson, tablaDeJson, tamano,
} from './swagger-util';

// Fila editable de parámetros / encabezados (con la ayuda que trae el Swagger).
export interface FilaParam {
  k: string;
  v: string;
  requerido: boolean;
  declarado: boolean;
  error?: boolean;
  descripcion?: string;
  tipo?: string;
  opciones?: string[];
  ejemplo?: string;
}

export interface CargaConsumo {
  consumo: SwaggerConsumo;
  nonce: number;
}

interface CorridaGuardada {
  hora: Date;
  respuesta: SwaggerRespuesta;
}

const METODOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// Una operación del Swagger (o la petición manual cuando op es null): parámetros, cuerpo, ejecución y respuesta.
@Component({
  selector: 'app-swagger-operacion',
  standalone: true,
  imports: [CommonModule, FormsModule, SwaggerModeloComponent],
  templateUrl: './swagger-operacion.component.html',
  styleUrl: './swagger-operacion.component.scss',
})
export class SwaggerOperacionComponent implements OnChanges {
  @Input() op: SwaggerOperacion | null = null;
  @Input() doc: SwaggerDocumento | null = null;
  @Input({ required: true }) origenId!: number;
  @Input() baseUrl = '';
  @Input() esquemasSeg: EsquemaSeguridad[] = [];
  @Input() credenciales: Record<string, Credencial> = {};
  @Input() puedeEditar = false;
  /** Guardar/modificar consumos: solo el dueño del origen (o ADMIN_POD). Quien recibió el Swagger compartido solo ejecuta. */
  @Input() puedeGuardar = false;
  @Input() carga: CargaConsumo | null = null;
  @Input() visible = true;
  @Output() consumoGuardado = new EventEmitter<SwaggerConsumo>();
  @Output() abrirAutorizar = new EventEmitter<void>();
  @Output() servidorSugerido = new EventEmitter<string>();
  @Output() ejecutado = new EventEmitter<void>();
  @Output() aviso = new EventEmitter<string>();

  readonly metodos = METODOS;
  readonly claseMetodo = claseMetodo;
  readonly claseEstado = claseEstado;
  readonly claseCodigo = claseCodigo;
  readonly tamano = tamano;

  // Petición
  pet = { metodo: 'GET', ruta: '/', tipoContenido: 'application/json', cuerpo: '' };
  pathParams: Record<string, string> = {};
  clavesPath: string[] = [];
  errorPath = new Set<string>();
  queryFilas: FilaParam[] = [];
  headerFilas: FilaParam[] = [];
  cuerpoError = '';
  vistaPeticion: 'editar' | 'modelo' = 'editar';
  usarAuth = true;
  consumoId: number | null = null;
  consumoNombre = '';

  // Ejecución
  enviando = false;
  errorEjec = '';
  respuesta: SwaggerRespuesta | null = null;
  errorRespuesta = '';
  errorDeServidor = false;
  vistaCuerpo: 'formateado' | 'crudo' | 'tabla' = 'formateado';
  cuerpoFormateado = '';
  cuerpoHtml: SafeHtml | null = null;
  tabla: TablaJson | null = null;
  mostrarHeaders = false;
  corridas: CorridaGuardada[] = [];
  corridaVista = 0;
  urlRespuesta = '';
  copiado = '';

  // Documentación de respuestas
  respVistaDoc: Record<string, 'ejemplo' | 'modelo'> = {};
  respTipoDoc: Record<string, string> = {};

  // Guardar consumo
  mostrarGuardar = false;
  formGuardar = { Nombre: '', Grupo: '', Notas: '', actualizar: false };
  guardando = false;
  errorGuardar = '';

  private ultimaCarga = 0;

  constructor(private swagger: SwaggerService, private sanitizer: DomSanitizer) {}

  get manual(): boolean {
    return !this.op;
  }

  ngOnChanges(cambios: SimpleChanges): void {
    if (cambios['op'] && (cambios['op'].firstChange || cambios['op'].previousValue?.id !== cambios['op'].currentValue?.id)) this.iniciarDesdeOperacion();
    if (cambios['carga'] && this.carga && this.carga.nonce !== this.ultimaCarga) {
      this.ultimaCarga = this.carga.nonce;
      this.aplicarConsumo(this.carga.consumo);
    }
  }

  // ------------------------------------------------------------------
  // Preparar la petición
  // ------------------------------------------------------------------
  private valorInicial(p: { ejemplo: unknown; defecto: unknown; enum: unknown[] | null }): string {
    const v = p.ejemplo ?? p.defecto ?? (p.enum && p.enum.length ? p.enum[0] : '');
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  private ejemploDe(p: { ejemplo: unknown; defecto: unknown }): string | undefined {
    const v = p.ejemplo ?? p.defecto;
    if (v === null || v === undefined || v === '') return undefined;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  private iniciarDesdeOperacion(): void {
    const op = this.op;
    this.consumoId = null;
    this.consumoNombre = '';
    this.errorPath.clear();
    this.errorEjec = '';
    if (!op) {
      this.pet = { metodo: 'GET', ruta: '/', tipoContenido: 'application/json', cuerpo: '' };
      this.pathParams = {};
      this.queryFilas = [];
      this.headerFilas = [];
      this.usarAuth = this.esquemasSeg.length > 0;
      this.actualizarClavesPath();
      this.validarCuerpo();
      return;
    }
    this.pet = { metodo: op.metodo, ruta: op.ruta, tipoContenido: 'application/json', cuerpo: '' };
    this.usarAuth = op.seguridad || this.esquemasSeg.length === 1 && this.esquemasSeg[0].nombre === '__manual';
    this.pathParams = {};
    op.parametros.filter((p) => p.en === 'path').forEach((p) => { this.pathParams[p.nombre] = this.valorInicial(p); });
    this.actualizarClavesPath();
    const aFila = (p: SwaggerOperacion['parametros'][number]): FilaParam => ({
      k: p.nombre, v: p.requerido ? this.valorInicial(p) : '', requerido: p.requerido, declarado: true,
      descripcion: p.descripcion, tipo: p.tipo, opciones: p.enum ? p.enum.map((x) => String(x)) : undefined, ejemplo: this.ejemploDe(p),
    });
    this.queryFilas = op.parametros.filter((p) => p.en === 'query').map(aFila);
    this.headerFilas = op.parametros.filter((p) => p.en === 'header').map(aFila);
    if (op.cuerpo) {
      const tipo = op.cuerpo.tipos.find((t) => /json/i.test(t)) || op.cuerpo.tipos[0];
      this.pet.tipoContenido = tipo;
      this.pet.cuerpo = op.cuerpo.ejemplos[tipo] || '';
    }
    this.validarCuerpo();
  }

  limpiar(): void {
    this.iniciarDesdeOperacion();
    this.respuesta = null;
    this.errorRespuesta = '';
    this.errorDeServidor = false;
    this.corridas = [];
  }

  actualizarClavesPath(): void {
    const claves: string[] = [];
    const re = /\{([^}/]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.pet.ruta))) if (!claves.includes(m[1])) claves.push(m[1]);
    claves.forEach((c) => { if (this.pathParams[c] === undefined) this.pathParams[c] = ''; });
    this.clavesPath = claves;
  }

  private parametroDeRuta(k: string) {
    return this.op?.parametros.find((p) => p.en === 'path' && p.nombre === k);
  }
  tipoDeRuta(k: string): string { return this.parametroDeRuta(k)?.tipo || 'string'; }
  descripcionDeRuta(k: string): string { return this.parametroDeRuta(k)?.descripcion || ''; }
  ejemploDeRuta(k: string): string | undefined {
    const p = this.parametroDeRuta(k);
    return p ? this.ejemploDe(p) : undefined;
  }
  opcionesDeRuta(k: string): string[] {
    const p = this.parametroDeRuta(k);
    return p?.enum ? p.enum.map((x) => String(x)) : [];
  }

  get llevaCuerpo(): boolean {
    return !['GET', 'HEAD'].includes(this.pet.metodo);
  }

  get tiposDeCuerpo(): string[] {
    return this.op?.cuerpo?.tipos || [];
  }

  get modeloCuerpo(): SwaggerModelo | null {
    return this.op?.cuerpo?.modelos?.[this.pet.tipoContenido] || null;
  }

  get esMultipart(): boolean {
    return /multipart/i.test(this.pet.tipoContenido);
  }

  cambiarTipoContenido(nuevo: string): void {
    const ej = this.op?.cuerpo?.ejemplos;
    if (ej && ej[nuevo] !== undefined) {
      const previo = ej[this.pet.tipoContenido];
      if (!this.pet.cuerpo.trim() || this.pet.cuerpo === previo) this.pet.cuerpo = ej[nuevo];
    }
    this.pet.tipoContenido = nuevo;
    this.validarCuerpo();
  }

  restaurarEjemplo(): void {
    const ej = this.op?.cuerpo?.ejemplos[this.pet.tipoContenido];
    if (ej !== undefined) { this.pet.cuerpo = ej; this.validarCuerpo(); }
  }

  validarCuerpo(): void {
    const t = this.pet.cuerpo.trim();
    if (!t || !/json/i.test(this.pet.tipoContenido)) { this.cuerpoError = ''; return; }
    this.cuerpoError = errorDeJson(t);
  }

  formatearCuerpo(): void {
    try { this.pet.cuerpo = JSON.stringify(JSON.parse(this.pet.cuerpo), null, 2); this.validarCuerpo(); } catch { /* ya se avisa que no es JSON válido */ }
  }

  minificarCuerpo(): void {
    try { this.pet.cuerpo = JSON.stringify(JSON.parse(this.pet.cuerpo)); this.validarCuerpo(); } catch { /* idem */ }
  }

  agregarFila(lista: FilaParam[]): void {
    lista.push({ k: '', v: '', requerido: false, declarado: false });
  }

  quitarFila(lista: FilaParam[], i: number): void {
    lista.splice(i, 1);
  }

  usarEjemplo(f: FilaParam): void {
    if (f.ejemplo !== undefined) { f.v = f.ejemplo; f.error = false; }
  }

  // Un parámetro opcional sin valor no se envía (igual que en Swagger UI); los agregados a mano sí, si tienen nombre.
  private filasActivas(filas: FilaParam[]): FilaClaveValor[] {
    return filas
      .filter((f) => f.k.trim() && (f.requerido || !f.declarado || f.v !== ''))
      .map((f) => ({ k: f.k.trim(), v: f.v }));
  }

  get authAplicada(): AuthAplicada {
    return this.usarAuth ? aplicarCredenciales(this.esquemasSeg, this.credenciales, this.op) : { headers: [], query: [], nombres: [] };
  }

  get urlResultante(): string {
    let ruta = this.pet.ruta;
    this.clavesPath.forEach((k) => { ruta = ruta.split(`{${k}}`).join(encodeURIComponent(this.pathParams[k] || `{${k}}`)); });
    const consulta = [...this.filasActivas(this.queryFilas), ...this.authAplicada.query]
      .map((f) => `${encodeURIComponent(f.k)}=${encodeURIComponent(esCampoSecreto(f.k) || this.esApiKeyQuery(f.k) ? '***' : f.v)}`).join('&');
    return `${this.baseUrl.replace(/\/+$/, '')}${ruta}${consulta ? `?${consulta}` : ''}`;
  }

  private esApiKeyQuery(k: string): boolean {
    return this.esquemasSeg.some((e) => e.tipo === 'apiKey' && e.en === 'query' && e.nombreParam === k);
  }

  get authResumen(): string {
    return this.authAplicada.nombres.join(', ');
  }

  get faltaAutenticacion(): boolean {
    return !!this.op?.seguridad && this.authAplicada.nombres.length === 0;
  }

  // ------------------------------------------------------------------
  // Ejecutar
  // ------------------------------------------------------------------
  private encabezadosFinales(): FilaClaveValor[] {
    const headers = this.filasActivas(this.headerFilas);
    this.authAplicada.headers.forEach((h) => {
      if (!headers.some((x) => x.k.toLowerCase() === h.k.toLowerCase())) headers.push(h);
    });
    return headers;
  }

  private consultaFinal(): FilaClaveValor[] {
    const q = this.filasActivas(this.queryFilas);
    this.authAplicada.query.forEach((a) => { if (!q.some((x) => x.k === a.k)) q.push(a); });
    return q;
  }

  enviar(): void {
    if (this.enviando || !this.puedeEditar) return;
    this.errorEjec = '';
    this.errorPath.clear();
    [...this.queryFilas, ...this.headerFilas].forEach((f) => { f.error = false; });
    const faltantes: string[] = [];
    this.clavesPath.forEach((k) => {
      if (!(this.pathParams[k] || '').trim()) { this.errorPath.add(k); faltantes.push(k); }
    });
    [...this.queryFilas, ...this.headerFilas].forEach((f) => {
      if (f.requerido && f.k.trim() && !f.v.trim()) { f.error = true; faltantes.push(f.k); }
    });
    if (this.llevaCuerpo && this.op?.cuerpo?.requerido && !this.pet.cuerpo.trim()) faltantes.push('cuerpo');
    if (faltantes.length) {
      this.errorEjec = `Completa los campos obligatorios: ${faltantes.join(', ')}.`;
      return;
    }
    if (!this.baseUrl.trim()) { this.errorEjec = 'Elige o escribe el servidor al que se va a llamar.'; return; }
    if (!this.pet.ruta.startsWith('/')) { this.errorEjec = 'La ruta debe empezar por «/».'; return; }
    if (this.pet.metodo === 'DELETE' && !confirm(`¿Ejecutar DELETE sobre ${this.pet.ruta}? Esto puede borrar datos del servicio.`)) return;

    this.enviando = true;
    this.respuesta = null;
    this.errorRespuesta = '';
    this.errorDeServidor = false;
    this.swagger.ejecutar(this.origenId, {
      metodo: this.pet.metodo,
      baseUrl: this.baseUrl.trim(),
      ruta: this.pet.ruta.trim(),
      pathParams: { ...this.pathParams },
      query: this.consultaFinal(),
      headers: this.encabezadosFinales(),
      cuerpo: this.llevaCuerpo ? this.pet.cuerpo : '',
      tipoContenido: this.pet.tipoContenido,
      consumoId: this.consumoId,
    }).subscribe({
      next: (r) => {
        this.enviando = false;
        this.mostrarRespuesta(r);
        this.corridas = [{ hora: new Date(), respuesta: r }, ...this.corridas].slice(0, 6);
        this.corridaVista = 0;
        this.ejecutado.emit();
        this.irARespuesta();
      },
      error: (err) => {
        this.enviando = false;
        this.errorRespuesta = err?.error?.error || 'No se pudo ejecutar la petición.';
        this.errorDeServidor = /no pertenece/i.test(this.errorRespuesta);
        this.ejecutado.emit();
        this.irARespuesta();
      },
    });
  }

  private mostrarRespuesta(r: SwaggerRespuesta): void {
    this.respuesta = r;
    this.urlRespuesta = this.ocultarSecretosUrl(r.url);
    this.mostrarHeaders = false;
    this.cuerpoFormateado = formatearJson(r.cuerpo || '');
    this.tabla = tablaDeJson(r.cuerpo);
    this.vistaCuerpo = 'formateado';
    this.actualizarHtml();
  }

  private ocultarSecretosUrl(url: string): string {
    try {
      const u = new URL(url);
      const nombres = Array.from(new Set(Array.from(u.searchParams.keys())));
      nombres.forEach((k) => { if (esCampoSecreto(k) || this.esApiKeyQuery(k)) u.searchParams.set(k, '***'); });
      return u.toString();
    } catch { return url; }
  }

  cambiarVistaCuerpo(v: 'formateado' | 'crudo' | 'tabla'): void {
    this.vistaCuerpo = v;
    this.actualizarHtml();
  }

  private actualizarHtml(): void {
    const t = this.cuerpoMostrado;
    // El resaltado solo se aplica a JSON de tamaño razonable; el texto se escapa por completo.
    this.cuerpoHtml = this.respuesta && !this.respuesta.binario && this.vistaCuerpo === 'formateado' && pareceJson(t) && t.length <= 300000
      ? this.sanitizer.bypassSecurityTrustHtml(resaltarJson(t))
      : null;
  }

  verCorrida(i: number): void {
    this.corridaVista = i;
    this.mostrarRespuesta(this.corridas[i].respuesta);
  }

  private irARespuesta(): void {
    setTimeout(() => this.seccionResp?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }), 80);
  }

  private get seccionResp(): HTMLElement | null {
    return document.getElementById(`resp-${this.idUnico}`);
  }

  readonly idUnico = Math.random().toString(36).slice(2, 9);

  get cuerpoMostrado(): string {
    if (!this.respuesta) return '';
    return this.vistaCuerpo === 'crudo' ? (this.respuesta.cuerpo || '') : this.cuerpoFormateado;
  }

  get headersRespuesta(): { k: string; v: string }[] {
    return this.respuesta ? Object.entries(this.respuesta.headers).map(([k, v]) => ({ k, v })) : [];
  }

  descargarRespuesta(): void {
    const r = this.respuesta;
    if (!r || r.binario) return;
    const ext = extensionDe(r.tipoContenido || '');
    descargarTexto(r.cuerpo || '', `respuesta-${this.pet.metodo.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, r.tipoContenido || 'text/plain');
  }

  usarServidorDelSwagger(): void {
    const s = this.doc?.servidores?.[0];
    if (s) { this.servidorSugerido.emit(s); this.errorRespuesta = ''; this.errorDeServidor = false; }
  }

  // Código de la respuesta documentada que coincide con la ejecución actual (para resaltarla)
  coincideCodigo(codigo: string): boolean {
    const e = this.respuesta?.estado;
    if (!e) return false;
    return codigo === String(e) || codigo.toUpperCase() === `${String(e)[0]}XX` || (codigo === 'default' && !this.op?.respuestas.some((r) => r.codigo === String(e)));
  }

  // ------------------------------------------------------------------
  // Documentación de las respuestas
  // ------------------------------------------------------------------
  tipoDocResp(r: { codigo: string; tipos?: string[] }): string {
    return this.respTipoDoc[r.codigo] || (r.tipos && r.tipos[0]) || '';
  }

  vistaDocResp(codigo: string): 'ejemplo' | 'modelo' {
    return this.respVistaDoc[codigo] || 'ejemplo';
  }

  // ------------------------------------------------------------------
  // cURL y copiado
  // ------------------------------------------------------------------
  curl(): string {
    const comilla = (t: string) => `'${t.replace(/'/g, `'\\''`)}'`;
    const partes = [`curl -X ${this.pet.metodo} ${comilla(this.urlResultante)}`];
    this.encabezadosFinales().forEach((h) => {
      const v = esCampoSecreto(h.k) ? '***' : h.v;
      partes.push(`-H ${comilla(`${h.k}: ${v}`)}`);
    });
    if (this.llevaCuerpo && this.pet.cuerpo.trim()) {
      partes.push(`-H ${comilla(`Content-Type: ${this.pet.tipoContenido}`)}`);
      partes.push(`--data ${comilla(this.pet.cuerpo)}`);
    }
    return partes.join(' \\\n  ');
  }

  copiar(texto: string, etiqueta: string): void {
    copiarTexto(texto).then((ok) => {
      if (!ok) { window.prompt('Copia con Ctrl+C:', texto); return; }
      this.copiado = etiqueta;
      setTimeout(() => { if (this.copiado === etiqueta) this.copiado = ''; }, 1500);
    });
  }

  // ------------------------------------------------------------------
  // Consumos guardados
  // ------------------------------------------------------------------
  private aplicarConsumo(c: SwaggerConsumo): void {
    this.consumoId = c.Id;
    this.consumoNombre = c.Nombre;
    this.pet.metodo = this.op ? this.op.metodo : c.Metodo;
    this.pet.ruta = c.Ruta;
    if (c.BaseUrl && this.doc && this.doc.servidores.some((s) => hostDe(s) === hostDe(c.BaseUrl))) this.despues(() => this.servidorSugerido.emit(c.BaseUrl));
    this.pet.tipoContenido = c.TipoContenido || 'application/json';
    this.pet.cuerpo = c.Cuerpo || '';
    this.pathParams = { ...(c.Parametros.path || {}) };
    this.actualizarClavesPath();
    const ayudas = new Map((this.op?.parametros || []).map((p) => [`${p.en}:${p.nombre}`, p]));
    const aFila = (en: string) => (f: FilaClaveValor): FilaParam => {
      const p = ayudas.get(`${en}:${f.k}`);
      return {
        k: f.k, v: f.v, requerido: !!p?.requerido, declarado: !!p, descripcion: p?.descripcion, tipo: p?.tipo,
        opciones: p?.enum ? p.enum.map((x) => String(x)) : undefined, ejemplo: p ? this.ejemploDe(p) : undefined,
      };
    };
    // Los parámetros declarados que el consumo no trae se conservan vacíos.
    const completar = (en: string, guardados: FilaParam[]): FilaParam[] => {
      const faltan = (this.op?.parametros || []).filter((p) => p.en === en && !guardados.some((g) => g.k === p.nombre)).map((p): FilaParam => ({
        k: p.nombre, v: '', requerido: p.requerido, declarado: true, descripcion: p.descripcion, tipo: p.tipo,
        opciones: p.enum ? p.enum.map((x) => String(x)) : undefined, ejemplo: this.ejemploDe(p),
      }));
      return [...guardados, ...faltan];
    };
    this.queryFilas = completar('query', (c.Parametros.query || []).map(aFila('query')));
    this.headerFilas = completar('header', (c.Parametros.headers || []).map(aFila('header')));
    this.validarCuerpo();
    this.errorEjec = '';
    this.respuesta = null;
    this.errorRespuesta = '';
    this.despues(() => this.aviso.emit(`Consumo «${c.Nombre}» cargado. Los valores sensibles (tokens, contraseñas) no se guardan: completa los que falten antes de ejecutar.`));
  }

  // Las notificaciones al padre desde ngOnChanges se difieren para no cambiar su estado en pleno ciclo de detección.
  private despues(f: () => void): void {
    setTimeout(f, 0);
  }

  abrirGuardar(): void {
    if (!this.puedeEditar || !this.puedeGuardar) return;
    this.errorGuardar = '';
    const op = this.op;
    this.formGuardar = {
      Nombre: this.consumoNombre || (op ? (op.resumen || `${op.metodo} ${op.ruta}`) : `${this.pet.metodo} ${this.pet.ruta}`),
      Grupo: op ? op.etiquetas[0] : '',
      Notas: '',
      actualizar: this.consumoId !== null,
    };
    this.mostrarGuardar = true;
  }

  guardarConsumo(): void {
    if (this.guardando) return;
    const datos: SwaggerConsumoForm = {
      Nombre: this.formGuardar.Nombre.trim(),
      Metodo: this.pet.metodo,
      Ruta: this.pet.ruta.trim(),
      BaseUrl: this.baseUrl.trim(),
      OperacionId: this.op?.id || '',
      Grupo: this.formGuardar.Grupo.trim(),
      Parametros: { path: { ...this.pathParams }, query: this.filasActivas(this.queryFilas), headers: this.filasActivas(this.headerFilas) },
      Cuerpo: this.llevaCuerpo ? this.pet.cuerpo : '',
      TipoContenido: this.pet.tipoContenido,
      Notas: this.formGuardar.Notas.trim(),
    };
    if (!datos.Nombre) { this.errorGuardar = 'Ponle un nombre al consumo.'; return; }
    this.guardando = true;
    this.errorGuardar = '';
    const accion = this.formGuardar.actualizar && this.consumoId !== null
      ? this.swagger.actualizarConsumo(this.consumoId, datos)
      : this.swagger.guardarConsumo(this.origenId, datos);
    accion.subscribe({
      next: (c) => {
        this.guardando = false;
        this.mostrarGuardar = false;
        this.consumoId = c.Id;
        this.consumoNombre = c.Nombre;
        this.consumoGuardado.emit(c);
        this.aviso.emit(`Consumo «${c.Nombre}» guardado.` + (c.SecretosOmitidos ? ' Se guardó SIN los valores sensibles (tokens/contraseñas): habrá que escribirlos de nuevo al usarlo.' : ''));
      },
      error: (err) => {
        this.guardando = false;
        this.errorGuardar = err?.error?.error || 'No se pudo guardar el consumo.';
      },
    });
  }

  trackIndice = (i: number): number => i;
}
