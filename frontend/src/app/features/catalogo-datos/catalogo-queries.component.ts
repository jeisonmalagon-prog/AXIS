import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription, firstValueFrom, of } from 'rxjs';
import { catchError, debounceTime, switchMap } from 'rxjs/operators';
import {
  AnalisisQuery, CatalogoDatosService, ConfigConstructor, ImportArchivo, ImportItemPrevia, ImportItemsResultado, OrigenEstado, QueriesLista, QueriesResumen,
  QueryJoinCatalogo, QueryResumen, QueryTablaCatalogo, TablaRef,
} from '../../core/services/catalogo-datos.service';
import { BorradorQuery, CatalogoIaComponent } from './catalogo-ia.component';
import { CatalogoConstructorComponent, PeticionConstructor } from './catalogo-constructor.component';
import { QueryEjecucionComponent } from './query-ejecucion.component';

export type PestanaQueries = 'repositorio' | 'constructor' | 'ia';

interface FormQuery { id: number | null; titulo: string; descripcion: string; etiquetas: string; consulta: string; enmascarar: boolean; config: ConfigConstructor | null; consultaOriginal: string; }
/** Un query encontrado en los archivos, listo para revisar antes de guardar. */
export interface ItemImp extends ImportItemPrevia { incluir: boolean; k: number; }
const MAX_ITEMS_ENVIO = 100;
interface ArchivoImp { nombre: string; tam: number; contenido: string; error: string; }

const MAX_ARCHIVO = 400000;
const MAX_LOTE_ARCHIVOS = 30;
const MAX_LOTE_CARACTERES = 2500000;

// Decodifica un archivo de texto: UTF-8, UTF-16 (con o sin BOM) o Windows-1252 (los .sql de SSMS suelen venir así).
export function decodificarArchivo(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  if (u.length >= 3 && u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf) return new TextDecoder('utf-8').decode(u.subarray(3));
  if (u.length >= 2 && u[0] === 0xff && u[1] === 0xfe) return new TextDecoder('utf-16le').decode(u.subarray(2));
  if (u.length >= 2 && u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(u.subarray(2));
  const muestra = u.subarray(0, Math.min(u.length, 400));
  let nulos = 0;
  for (const b of muestra) if (b === 0) nulos += 1;
  if (muestra.length > 8 && nulos > muestra.length * 0.3) return new TextDecoder('utf-16le').decode(u);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch { return new TextDecoder('windows-1252').decode(u); }
}

// «Queries del equipo»: repositorio de scripts con búsqueda e importación, constructor guiado y asistente IA.
@Component({
  selector: 'app-catalogo-queries',
  standalone: true,
  imports: [CommonModule, FormsModule, CatalogoConstructorComponent, CatalogoIaComponent, QueryEjecucionComponent],
  templateUrl: './catalogo-queries.component.html',
  styleUrl: './catalogo-queries.component.scss',
})
export class CatalogoQueriesComponent implements OnInit, OnDestroy {
  @Input() origenes: OrigenEstado[] = [];
  @Input() puedeEditar = false;
  @Input() pestanaInicial: PestanaQueries = 'repositorio';
  /** Para «Armar query con esta tabla». */
  @Input() tablasIniciales: TablaRef[] = [];
  /** Para «Queries que usan esta tabla». */
  @Input() tablaFiltro: TablaRef | null = null;
  /** Para abrir el repositorio ya filtrado por una base (desde el mapa estelar). */
  @Input() bdFiltro = '';
  /** Para abrir directamente un query (desde la ficha de una tabla). */
  @Input() queryInicial: number | null = null;
  @Output() cerrar = new EventEmitter<void>();
  /** Abrir una tabla del catálogo (cierra esta ventana). */
  @Output() verTabla = new EventEmitter<TablaRef>();

  pestana: PestanaQueries = 'repositorio';
  visitado = { cons: false, ia: false };
  tablasConstructor: TablaRef[] = [];
  peticionConstructor: PeticionConstructor | null = null;
  private contadorPeticion = 0;

  // Repositorio
  resumen: QueriesResumen | null = null;
  lista: QueriesLista | null = null;
  cargando = true;
  error = '';
  q = '';
  bd = '';
  tipo = '';
  riesgo = '';
  tablaTxt = '';
  private tablaFiltroActual: TablaRef | null = null;
  sel: QueryResumen | null = null;
  cargandoSel = false;
  sqlEdit = '';
  similares: QueryResumen[] = [];
  copiado = '';
  quitando = false;
  // Renombrar
  renombrando = false;
  nombreEdit = '';
  descEdit = '';
  etiquetasEdit = '';
  guardandoNombre = false;
  errorNombre = '';
  sugiriendo = false;
  private temporizador: ReturnType<typeof setTimeout> | null = null;

  // Formulario
  form: FormQuery | null = null;
  analisis: AnalisisQuery | null = null;
  analizando = false;
  guardando = false;
  errorForm = '';
  duplicadoDe: number | null = null;

  // Importación (con vista previa)
  mostrarImport = false;
  archivosImp: ArchivoImp[] = [];
  dividir = true;
  enmascarar = true;
  importando = false;
  progresoImp = '';
  resultadoImp: ImportItemsResultado | null = null;
  errorImp = '';
  itemsImp: ItemImp[] | null = null;
  erroresPrevia: string[] = [];
  filtroItemsImp = '';

  private busquedaSubject = new Subject<void>();
  private analisisSubject = new Subject<void>();
  private subs = new Subscription();

  readonly tipos = ['SELECT', 'UPDATE', 'DELETE', 'INSERT', 'MERGE', 'TRUNCATE', 'DDL', 'EXEC'];

  constructor(private servicio: CatalogoDatosService) {}

  ngOnInit(): void {
    this.pestana = this.pestanaInicial;
    this.visitado.cons = this.pestana === 'constructor';
    this.visitado.ia = this.pestana === 'ia';
    this.tablasConstructor = [...this.tablasIniciales];
    if (this.tablaFiltro) { this.tablaFiltroActual = this.tablaFiltro; this.tablaTxt = this.tablaFiltro.n; }
    if (this.bdFiltro) this.bd = this.bdFiltro;

    this.subs.add(this.busquedaSubject.pipe(
      debounceTime(300),
      switchMap(() => {
        this.cargando = true;
        return this.servicio.queries({ q: this.q.trim(), bd: this.bd, tipo: this.tipo, riesgo: this.riesgo, tabla: this.tablaTxt, limite: 60 }).pipe(
          catchError((e) => { this.error = e?.error?.error || 'No se pudo consultar el repositorio.'; return of(null); }),
        );
      }),
    ).subscribe((r) => { if (r) { this.lista = r; this.error = ''; } this.cargando = false; }));

    this.subs.add(this.analisisSubject.pipe(
      debounceTime(500),
      switchMap(() => {
        if (!this.form || this.form.consulta.trim().length < 6) { this.analisis = null; return of(null); }
        this.analizando = true;
        return this.servicio.analizarQuery({ consulta: this.form.consulta, titulo: this.form.titulo || undefined, enmascarar: this.form.enmascarar }).pipe(catchError(() => of(null)));
      }),
    ).subscribe((a) => { this.analisis = a; this.analizando = false; }));

    this.servicio.queriesResumen().subscribe({
      next: (r) => { this.resumen = r; if (!r.tabla) this.cargando = false; },
      error: (e) => { this.error = e?.error?.error || 'No se pudo consultar el repositorio.'; this.cargando = false; },
    });
    this.buscar();
    if (this.queryInicial) this.abrirQuery(this.queryInicial);
  }

  ngOnDestroy(): void { this.subs.unsubscribe(); if (this.temporizador) clearTimeout(this.temporizador); }

  get sinTabla(): boolean { return !!this.resumen && !this.resumen.tabla; }

  irA(p: PestanaQueries): void {
    this.pestana = p;
    if (p === 'constructor') this.visitado.cons = true;
    if (p === 'ia') this.visitado.ia = true;
  }

  // ----- Búsqueda -----
  buscar(): void { this.busquedaSubject.next(); }
  limpiarTabla(): void { this.tablaTxt = ''; this.tablaFiltroActual = null; this.buscar(); }
  filtrarPorTabla(nombre: string): void { this.tablaTxt = nombre; this.tablaFiltroActual = null; this.buscar(); }
  get hayFiltros(): boolean { return !!(this.q || this.bd || this.tipo || this.riesgo || this.tablaTxt); }
  limpiarFiltros(): void { this.q = ''; this.bd = ''; this.tipo = ''; this.riesgo = ''; this.tablaTxt = ''; this.tablaFiltroActual = null; this.buscar(); }

  // ----- Detalle -----
  abrirQuery(id: number): void {
    this.renombrando = false;
    this.form = null;
    this.mostrarImport = false;
    this.cargandoSel = true;
    this.quitando = false;
    this.similares = [];
    this.servicio.query(id).subscribe({
      next: (q) => {
        this.sel = q;
        this.sqlEdit = q.consulta || '';
        this.cargandoSel = false;
        this.servicio.queriesSimilares(id).subscribe({ next: (r) => { this.similares = r.queries; }, error: () => { /* opcional */ } });
      },
      error: (e) => { this.error = e?.error?.error || 'No se pudo abrir el query.'; this.cargandoSel = false; },
    });
  }

  cerrarDetalle(): void { this.sel = null; this.quitando = false; }

  get motivoEjecucion(): string {
    const s = this.sel;
    if (!s) return '';
    if (s.modifica) return 'Este script modifica datos: revísalo y córrelo con tu cuenta; desde aquí solo se ejecutan consultas de lectura.';
    if (s.nivelRiesgo === 'procedimiento') return 'Ejecuta un procedimiento almacenado: no se puede correr desde aquí.';
    if (s.usaOpenquery) return 'Usa OPENQUERY (AS400): córrelo con tu cuenta en SSMS.';
    return '';
  }

  copiarSql(texto: string, que: string): void {
    navigator.clipboard.writeText(texto).then(() => {
      this.copiado = que;
      if (this.temporizador) clearTimeout(this.temporizador);
      this.temporizador = setTimeout(() => { this.copiado = ''; }, 2000);
    }, () => { this.error = 'El navegador no permitió copiar.'; });
  }

  quitar(): void {
    if (!this.sel) return;
    if (!this.quitando) { this.quitando = true; return; }
    const id = this.sel.id;
    this.servicio.quitarQuery(id).subscribe({
      next: () => { this.sel = null; this.quitando = false; this.refrescar(); },
      error: (e) => { this.error = e?.error?.error || 'No se pudo quitar el query.'; this.quitando = false; },
    });
  }

  private refrescar(): void {
    this.servicio.queriesResumen().subscribe({ next: (r) => { this.resumen = r; }, error: () => { /* no crítico */ } });
    this.buscar();
  }

  // ----- Formulario -----
  nuevo(borrador?: BorradorQuery): void {
    this.sel = null;
    this.mostrarImport = false;
    this.errorForm = '';
    this.duplicadoDe = null;
    this.analisis = null;
    this.form = { id: null, titulo: borrador?.titulo || '', descripcion: borrador?.descripcion || '', etiquetas: '', consulta: borrador?.consulta || '', enmascarar: true, config: borrador?.config || null, consultaOriginal: borrador?.consulta || '' };
    if (borrador) this.analisisSubject.next();
  }

  editar(): void {
    const s = this.sel;
    if (!s) return;
    this.errorForm = '';
    this.duplicadoDe = null;
    this.analisis = null;
    this.form = { id: s.id, titulo: s.titulo, descripcion: s.descripcion, etiquetas: s.etiquetas.join(', '), consulta: s.consulta || '', enmascarar: true, config: s.cfgConstructor || null, consultaOriginal: s.consulta || '' };
    this.sel = null;
  }

  guardarDesdeOtraPestana(b: BorradorQuery): void { this.irA('repositorio'); this.nuevo(b); }
  verDesdeConstructor(id: number): void { this.irA('repositorio'); this.abrirQuery(id); }

  alEscribirConsulta(): void { this.analisisSubject.next(); }
  cancelarForm(): void { this.form = null; this.analisis = null; this.errorForm = ''; this.duplicadoDe = null; }

  get puedeGuardar(): boolean { return !!this.form && !this.guardando && this.form.consulta.trim().length >= 6; }

  guardar(): void {
    const f = this.form;
    if (!f || !this.puedeGuardar) return;
    this.guardando = true;
    this.errorForm = '';
    this.duplicadoDe = null;
    // la configuración del constructor solo se conserva si el SQL no se tocó a mano
    const config = f.config && f.consulta.trim() === f.consultaOriginal.trim() ? f.config : null;
    const cuerpo = { titulo: f.titulo.trim() || undefined, descripcion: f.descripcion.trim(), consulta: f.consulta, etiquetas: f.etiquetas, enmascarar: f.enmascarar, ...(config ? { config } : {}) };
    const llamada = f.id ? this.servicio.editarQuery(f.id, cuerpo) : this.servicio.crearQuery(cuerpo);
    llamada.subscribe({
      next: (q) => { this.guardando = false; this.form = null; this.analisis = null; this.refrescar(); this.abrirQuery(q.id); },
      error: (e) => { this.errorForm = e?.error?.error || 'No se pudo guardar el query.'; this.duplicadoDe = e?.error?.duplicadoDe || null; this.guardando = false; },
    });
  }

  verDuplicado(): void { if (this.duplicadoDe) { const id = this.duplicadoDe; this.cancelarForm(); this.abrirQuery(id); } }

  // ----- Importación con vista previa -----
  abrirImport(): void { this.sel = null; this.form = null; this.renombrando = false; this.mostrarImport = true; this.reiniciarImport(); }
  cerrarImport(): void { this.mostrarImport = false; }
  private reiniciarImport(): void { this.archivosImp = []; this.resultadoImp = null; this.errorImp = ''; this.progresoImp = ''; this.itemsImp = null; this.erroresPrevia = []; this.filtroItemsImp = ''; }

  async alElegirArchivos(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const archivos = Array.from(input.files || []);
    input.value = '';
    this.resultadoImp = null;
    this.itemsImp = null;
    this.errorImp = '';
    const nuevos: ArchivoImp[] = [];
    for (const f of archivos) {
      const base: ArchivoImp = { nombre: f.name, tam: f.size, contenido: '', error: '' };
      if (!/\.(sql|txt)$/i.test(f.name)) base.error = 'Solo se importan .sql y .txt (copia el texto de otros formatos).';
      else if (f.size > MAX_ARCHIVO) base.error = 'Demasiado grande (máx. 400 KB).';
      else if (f.size === 0) base.error = 'Archivo vacío.';
      else {
        try { base.contenido = decodificarArchivo(await f.arrayBuffer()); } catch { base.error = 'No se pudo leer el archivo.'; }
      }
      nuevos.push(base);
    }
    const nombres = new Set(this.archivosImp.map((a) => `${a.nombre}|${a.tam}`));
    this.archivosImp = [...this.archivosImp, ...nuevos.filter((a) => !nombres.has(`${a.nombre}|${a.tam}`))];
  }

  quitarArchivo(i: number): void { this.archivosImp = this.archivosImp.filter((_, k) => k !== i); }
  get archivosValidos(): ArchivoImp[] { return this.archivosImp.filter((a) => !a.error); }

  /** Paso 1: lee los archivos y muestra qué queries se crearían, con su nombre, para que lo corrijas. */
  async previsualizar(): Promise<void> {
    const validos = this.archivosValidos;
    if (!validos.length || this.importando) return;
    this.importando = true;
    this.errorImp = '';
    this.resultadoImp = null;
    const lotes: ImportArchivo[][] = [];
    let actual: ImportArchivo[] = [];
    let caracteres = 0;
    for (const a of validos) {
      if (actual.length >= MAX_LOTE_ARCHIVOS || caracteres + a.contenido.length > MAX_LOTE_CARACTERES) { lotes.push(actual); actual = []; caracteres = 0; }
      actual.push({ nombre: a.nombre, contenido: a.contenido });
      caracteres += a.contenido.length;
    }
    if (actual.length) lotes.push(actual);
    const items: ItemImp[] = [];
    const vistas = new Set<string>();
    const errores: string[] = [];
    try {
      for (let i = 0; i < lotes.length; i++) {
        this.progresoImp = `Leyendo lote ${i + 1} de ${lotes.length}…`;
        const r = await firstValueFrom(this.servicio.previaImportacion({ archivos: lotes[i], dividir: this.dividir, enmascarar: this.enmascarar }));
        errores.push(...r.errores);
        for (const it of r.items) {
          const repetido = it.repetidoEnLote || vistas.has(it.huella);
          vistas.add(it.huella);
          items.push({ ...it, repetidoEnLote: repetido, incluir: !repetido && !it.duplicadoDe, k: items.length });
        }
      }
      this.itemsImp = items;
      this.erroresPrevia = errores;
      if (!items.length) this.errorImp = 'No encontré queries en esos archivos.';
    } catch (e) {
      this.errorImp = (e as { error?: { error?: string } })?.error?.error || 'No se pudieron leer los archivos.';
    } finally {
      this.importando = false;
      this.progresoImp = '';
    }
  }

  get itemsVisibles(): ItemImp[] {
    const q = this.filtroItemsImp.trim().toLowerCase();
    const l = this.itemsImp || [];
    return q ? l.filter((x) => `${x.titulo} ${x.archivo} ${x.tablas.join(' ')}`.toLowerCase().includes(q)) : l;
  }
  get seleccionadosImp(): ItemImp[] { return (this.itemsImp || []).filter((x) => x.incluir && !x.duplicadoDe && !x.repetidoEnLote && x.titulo.trim()); }
  get nuevosImp(): number { return (this.itemsImp || []).filter((x) => !x.duplicadoDe && !x.repetidoEnLote).length; }
  get yaExistenImp(): number { return (this.itemsImp || []).filter((x) => x.duplicadoDe || x.repetidoEnLote).length; }
  marcarTodosImp(valor: boolean): void { for (const x of this.itemsVisibles) if (!x.duplicadoDe && !x.repetidoEnLote) x.incluir = valor; }
  volverAArchivos(): void { this.itemsImp = null; this.resultadoImp = null; this.errorImp = ''; }

  /** Paso 2: guarda lo elegido con los nombres revisados. */
  async confirmarImport(): Promise<void> {
    const elegidos = this.seleccionadosImp;
    if (!elegidos.length || this.importando) return;
    this.importando = true;
    this.errorImp = '';
    const total: ImportItemsResultado = { creadas: 0, duplicadas: 0, modifican: 0, enmascaradas: 0, errores: [] };
    try {
      for (let i = 0; i < elegidos.length; i += MAX_ITEMS_ENVIO) {
        this.progresoImp = `Guardando ${Math.min(i + MAX_ITEMS_ENVIO, elegidos.length)} de ${elegidos.length}…`;
        const r = await firstValueFrom(this.servicio.importarItems({
          enmascarar: this.enmascarar,
          items: elegidos.slice(i, i + MAX_ITEMS_ENVIO).map((x) => ({
            titulo: x.titulo.trim(), descripcion: x.descripcion, consulta: x.consulta, etiquetas: x.etiquetas, archivo: x.archivo, baseDatos: x.baseDatos,
          })),
        }));
        total.creadas += r.creadas; total.duplicadas += r.duplicadas; total.modifican += r.modifican; total.enmascaradas += r.enmascaradas;
        total.errores.push(...r.errores);
      }
      this.resultadoImp = total;
      this.itemsImp = null;
      this.archivosImp = [];
      this.refrescar();
    } catch (e) {
      this.errorImp = (e as { error?: { error?: string } })?.error?.error || 'No se pudo completar la importación.';
      if (total.creadas) { this.resultadoImp = total; this.refrescar(); }
    } finally {
      this.importando = false;
      this.progresoImp = '';
    }
  }

  // ----- Nombre y alias de un query guardado -----
  iniciarRenombre(): void {
    const s = this.sel;
    if (!s) return;
    this.nombreEdit = s.titulo;
    this.descEdit = s.descripcion;
    this.etiquetasEdit = s.etiquetas.join(', ');
    this.errorNombre = '';
    this.renombrando = true;
  }
  cancelarRenombre(): void { this.renombrando = false; this.errorNombre = ''; }

  sugerirNombre(): void {
    if (!this.sqlEdit.trim() || this.sugiriendo) return;
    this.sugiriendo = true;
    this.servicio.sugerirNombre(this.sqlEdit, this.sel?.archivo).subscribe({
      next: (r) => { this.nombreEdit = r.titulo; if (!this.descEdit.trim()) this.descEdit = r.descripcion; this.sugiriendo = false; },
      error: () => { this.sugiriendo = false; },
    });
  }

  guardarRenombre(): void {
    const s = this.sel;
    if (!s || this.guardandoNombre) return;
    if (!this.nombreEdit.trim()) { this.errorNombre = 'El nombre no puede quedar vacío.'; return; }
    this.guardandoNombre = true;
    this.errorNombre = '';
    this.servicio.editarQuery(s.id, { titulo: this.nombreEdit.trim(), descripcion: this.descEdit.trim(), etiquetas: this.etiquetasEdit }).subscribe({
      next: (q) => { this.guardandoNombre = false; this.renombrando = false; this.abrirQuery(q.id); this.refrescar(); },
      error: (e) => { this.guardandoNombre = false; this.errorNombre = e?.error?.error || 'No se pudo guardar el nombre.'; },
    });
  }

  // ----- Relación con el catálogo -----
  abrirEnConstructor(): void {
    const s = this.sel;
    if (!s) return;
    const p: PeticionConstructor = { id: ++this.contadorPeticion, nombre: s.titulo, descripcion: s.descripcion };
    if (s.cfgConstructor) p.config = s.cfgConstructor;
    else if (s.sugerenciaConstructor) p.tablas = s.sugerenciaConstructor.tablas;
    else return;
    this.peticionConstructor = p;
    this.irA('constructor');
  }
  get puedeAbrirEnConstructor(): boolean { return !!this.sel && (!!this.sel.cfgConstructor || !!this.sel.sugerenciaConstructor); }

  tablaCatalogo(i: number): QueryTablaCatalogo | null {
    return this.sel?.tablasCatalogo?.[i] || null;
  }
  joinCatalogo(i: number): QueryJoinCatalogo | null { return this.sel?.joinsCatalogo?.[i] || null; }
  irATabla(i: number): void { const t = this.tablaCatalogo(i); if (t?.ref) this.verTabla.emit(t.ref); }
  get fueraDelCatalogo(): number { return (this.sel?.tablasCatalogo || []).filter((t) => !t.enCatalogo && !t.servidor).length; }

  // ----- Presentación -----
  etiquetaRiesgo(r: string): string { return r === 'modifica' ? 'Modifica datos' : r === 'procedimiento' ? 'Procedimiento' : 'Lectura'; }
  claseRiesgo(r: string): string { return r === 'modifica' ? 'chip-alta' : r === 'procedimiento' ? 'chip-media' : 'chip-ok'; }
  primeras(q: QueryResumen, n = 4): string[] { return q.tablas.slice(0, n).map((t) => t.tabla); }
  masTablas(q: QueryResumen, n = 4): number { return Math.max(q.tablas.length - n, 0); }
  nombreCompleto(t: { bd: string; esquema: string; tabla: string; servidor?: string }): string { return [t.servidor, t.bd, t.esquema, t.tabla].filter(Boolean).join('.'); }
  textoJoin(j: { a: { tabla: string; columna: string }; b: { tabla: string; columna: string } }): string { return `${j.a.tabla}.${j.a.columna} = ${j.b.tabla}.${j.b.columna}`; }
  tamKb(n: number): string { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`; }
  trackQuery(_: number, q: QueryResumen): number { return q.id; }
  trackIdx(i: number): number { return i; }
  trackItemImp(_: number, x: ItemImp): number { return x.k; }

  /** Descripción sin repetir el título (los títulos salen de los comentarios del script). */
  descripcionExtra(q: QueryResumen): string {
    let d = (q.descripcion || '').trim();
    const t = (q.titulo || '').trim();
    if (t && d.toLowerCase().startsWith(t.toLowerCase())) d = d.slice(t.length).replace(/^[\s·\-–:]+/, '');
    return d === t ? '' : d;
  }

  nombresTablas(tablas: { tabla: string }[], max: number): string {
    return tablas.slice(0, max).map((t) => t.tabla).join(', ');
  }
}
