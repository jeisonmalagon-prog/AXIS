import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// ==========================================================================
// Módulo CATALOGO_DATOS: mapa de bases, tablas, columnas y llaves foráneas
// (SQL Server y MariaDB). Solo lectura sobre los catálogos del sistema.
// ==========================================================================

export type Motor = 'MSSQL' | 'MARIADB';

/** Identifica una tabla/vista dentro del catálogo. `es` va vacío en MariaDB. */
export interface TablaRef { o: string; bd: string; es: string; n: string; }

export interface TablaResumen {
  ref: TablaRef;
  origen: string;
  motor: Motor;
  bd: string;
  esquema: string | null;
  nombre: string;
  tipo: 'TABLA' | 'VISTA';
  descripcion: string | null;
  filas: number | null;
  nColumnas: number;
}

export interface BaseResumen { nombre: string; tablas: number; vistas: number; columnas: number; fks: number; error?: string; }

export interface OrigenEstado {
  id: string;
  nombre: string;
  motor: Motor;
  host: string;
  puerto: number;
  estado: 'cargando' | 'ok' | 'error' | 'sin-credenciales';
  cargando: boolean;
  progreso: string | null;
  error: string | null;
  actualizadoEn: string | null;
  duracionMs: number | null;
  advertencias: string[];
  bases: BaseResumen[];
}

export interface CatalogoTotales { origenes: number; bases: number; tablas: number; vistas: number; columnas: number; fks: number; }

/** Credenciales PERSONALES de la sesión (una por motor). La clave nunca llega al navegador. */
export interface CredencialMotor { configurada: boolean; usuario: string | null; claveFin: string | null; expira: string | null; }
export type CredencialesCatalogo = Record<Motor, CredencialMotor>;

export interface CatalogoResumen {
  tablaOrigenes: boolean;
  credenciales: CredencialesCatalogo;
  origenes: OrigenEstado[];
  totales: CatalogoTotales;
  cargando: boolean;
  sinCredenciales: number;
}

export interface BaseRef { o: string; bd: string; }
export interface Puente { a: BaseRef; b: BaseRef; comunes: number; ejemplos: string[]; }
export interface Galaxia { origenes: OrigenEstado[]; totales: CatalogoTotales; cargando: boolean; puentes: Puente[]; }

export interface ColumnaHallazgo {
  nombre: string;
  apariciones: number;
  bases: number;
  ejemplos: (TablaResumen & { tipoDato: string; pk: boolean })[];
}
export interface BusquedaResultado { tablas: TablaResumen[]; columnas: ColumnaHallazgo[]; totalTablas: number; totalColumnas: number; }

export interface LugarColumna extends TablaResumen { tipoDato: string; pk: boolean; nulo: boolean; }
export interface LugaresColumna { nombre: string; total: number; lugares: LugarColumna[]; }

export interface ColumnaFkDestino { tabla: TablaResumen; columna: string; fk?: string; }
export interface ColumnaDetalle {
  orden: number;
  nombre: string;
  tipo: string;
  nulo: boolean;
  pk: boolean;
  identity: boolean;
  calculada: boolean;
  defecto: string | null;
  descripcion: string | null;
  fk: ColumnaFkDestino[];
  referenciadaPor: ColumnaFkDestino[];
  otrasTablas: number;
}
export interface RelacionTabla { tabla: TablaResumen; fk: string; columnas: { col: string; refCol: string }[]; }
export interface TablaDetalle {
  ref: TablaRef;
  origen: { id: string; nombre: string; motor: Motor };
  bd: string;
  esquema: string | null;
  nombre: string;
  tipo: 'TABLA' | 'VISTA';
  descripcion: string | null;
  filas: number | null;
  columnas: ColumnaDetalle[];
  padres: RelacionTabla[];
  hijas: RelacionTabla[];
}

export interface GrafoColumna { nombre: string; tipo: string; pk: boolean; fk: boolean; nulo: boolean; }
export interface GrafoNodo {
  id: string;
  ref: TablaRef;
  nombre: string;
  esquema: string | null;
  bd: string;
  tipo: 'TABLA' | 'VISTA';
  /** 0 = tabla central; negativo = padres (a la izquierda); positivo = hijas (a la derecha). */
  nivel: number;
  nColumnas: number;
  filas: number | null;
  columnas: GrafoColumna[];
  masColumnas: number;
}
export interface GrafoArista { id: string; desde: string; hacia: string; nombre: string; columnas: { col: string; refCol: string }[]; propia: boolean; }
/** `desde` es la tabla hija (tiene la FK) y `hacia` la tabla padre (referenciada). */
export interface Grafo { centro: string; nodos: GrafoNodo[]; aristas: GrafoArista[]; truncado: boolean; }

export interface MapaTabla {
  ref: TablaRef;
  nombre: string;
  esquema: string | null;
  tipo: 'TABLA' | 'VISTA';
  nColumnas: number;
  filas: number | null;
  nPadres: number;
  nHijas: number;
  descripcion: string | null;
}
export interface MapaBase {
  origen: { id: string; nombre: string; motor: Motor };
  bd: string;
  tablas: MapaTabla[];
  /** Pares [índice de la hija, índice de la padre] dentro de `tablas`. */
  aristas: [number, number][];
}

// --- Orígenes (solo ADMIN_POD) -------------------------------------------------------
export interface OrigenAdmin {
  id: string;
  nombre: string;
  motor: Motor;
  host: string;
  puerto: number;
  /** true = quedó una clave guardada de la versión anterior (ya no se usa; el admin puede borrarla). */
  claveAntigua: boolean;
  cifrado: boolean;
  confiarCertificado: boolean;
  basesIncluidas: string[];
  activo: boolean;
  creadoPor: string | null;
  fechaCreacion: string | null;
  fechaActualizacion: string | null;
}
export interface OrigenesRespuesta { tabla: boolean; origenes: OrigenAdmin[]; }
export interface OrigenForm {
  id?: string;
  nombre: string;
  motor: Motor;
  host: string;
  puerto: number | null;
  cifrado: boolean;
  confiarCertificado: boolean;
  basesIncluidas: string;
  activo: boolean;
}
export interface PruebaOrigen { ok: boolean; version?: string; bases?: string[]; error?: string; }

export type EstadoMasivo = 'pendiente' | 'ok' | 'error' | 'invalida' | 'duplicado' | 'omitida' | 'creado';
export interface ResultadoMasivo {
  linea: number; texto: string; host: string; puerto: number; nombre: string;
  estado: EstadoMasivo; mensaje: string | null; version?: string | null; bases?: number;
}
export interface MasivoRespuesta { modo: 'probar' | 'registrar'; resultados: ResultadoMasivo[]; verificada: boolean; detenido: boolean; dominio: boolean; }
export interface MasivoPeticion { lista: string; usuario: string; clave: string; cifrado: boolean; confiarCertificado: boolean; modo: 'probar' | 'registrar'; verificada?: boolean; }

// ----- Repositorio de queries, constructor guiado, asistente IA y ejecución de lectura -----
export type RiesgoQuery = 'lectura' | 'procedimiento' | 'modifica';
export interface QueryTabla { servidor: string; bd: string; esquema: string; tabla: string; escribe: boolean; }
export interface QueryColumnaRef { bd: string; esquema: string; tabla: string; columna: string; }
export interface QueryJoin { a: QueryColumnaRef; b: QueryColumnaRef; }
export interface QueryResumen {
  id: number;
  titulo: string;
  descripcion: string;
  tipo: string;
  nivelRiesgo: RiesgoQuery;
  modifica: boolean;
  baseDatos: string;
  archivo: string;
  etiquetas: string[];
  tablas: QueryTabla[];
  joins: QueryJoin[];
  parametros: string[];
  procedimientos: string[];
  remoto: boolean;
  usaOpenquery: boolean;
  enmascarado: boolean;
  ejecuciones: number;
  ultimaEjecucion: string | null;
  creadoPor: string;
  fechaCreacion: string;
  fechaActualizacion: string;
  /** Solo en listados. */
  previa?: string;
  tieneConstructor?: boolean;
  /** Solo en el detalle. */
  consulta?: string;
  cfgConstructor?: ConfigConstructor | null;
  tablasCatalogo?: QueryTablaCatalogo[];
  joinsCatalogo?: QueryJoinCatalogo[];
  sugerenciaConstructor?: { origenId: string; bd: string; tablas: TablaRef[] } | null;
  tablasEnComun?: number;
  similitud?: number;
}
/** Una tabla del query contrastada con el catálogo (mapa estelar). */
export interface QueryTablaCatalogo {
  texto: string;
  servidor: string;
  enCatalogo: boolean;
  ambigua: boolean;
  ref: TablaRef | null;
  origen: string;
  bd: string;
  filas: number | null;
  nColumnas: number | null;
  tipo: string;
  escribe: boolean;
}
export interface QueryJoinCatalogo { a: QueryColumnaRef; b: QueryColumnaRef; enCatalogo: boolean; fk: boolean; columnasOk: boolean | null; }
export interface QueriesLista { total: number; desde: number; limite: number; queries: QueryResumen[]; }
export interface ConteoNombre { nombre: string; total: number; }
export interface QueriesResumen {
  tabla: boolean;
  total?: number;
  modifican?: number;
  porBase?: ConteoNombre[];
  porTipo?: ConteoNombre[];
  tablasFrecuentes?: ConteoNombre[];
  etiquetas?: ConteoNombre[];
}
export interface FiltrosQueries { q?: string; tabla?: string; bd?: string; tipo?: string; riesgo?: string; etiqueta?: string; desde?: number; limite?: number; }
export interface QueryEntrada {
  titulo?: string;
  descripcion?: string;
  consulta: string;
  etiquetas?: string | string[];
  archivo?: string;
  enmascarar?: boolean;
  permitirDuplicado?: boolean;
  /** Configuración del constructor guiado, para poder reabrir el query armado. */
  config?: ConfigConstructor | null;
}
export interface AnalisisQuery {
  titulo: string;
  descripcion: string;
  etiquetas: string[];
  tipo: string;
  nivelRiesgo: RiesgoQuery;
  modifica: boolean;
  baseDatos: string;
  tablas: QueryTabla[];
  joins: QueryJoin[];
  parametros: string[];
  procedimientos: string[];
  enmascarado: boolean;
  cambios: { secretos: number; personales: number };
  consultaFinal: string;
  ejecutable: boolean;
  motivoNoEjecutable: string;
}
export interface ImportArchivo { nombre: string; contenido: string; }
export interface ImportArchivoResultado { nombre: string; bloques: number; creadas?: number; duplicadas?: number; error?: string; }
export interface ImportResultado {
  archivos: ImportArchivoResultado[];
  creadas: number;
  duplicadas: number;
  vacias: number;
  modifican: number;
  procedimientos: number;
  enmascaradas: number;
  errores: string[];
}

export interface ImportItemPrevia {
  archivo: string;
  orden: number;
  titulo: string;
  descripcion: string;
  etiquetas: string[];
  tipo: string;
  nivelRiesgo: RiesgoQuery;
  modifica: boolean;
  baseDatos: string;
  enmascarado: boolean;
  huella: string;
  duplicadoDe: number | null;
  repetidoEnLote: boolean;
  tablas: string[];
  nTablas: number;
  previa: string;
  consulta: string;
}
export interface ImportPrevia { items: ImportItemPrevia[]; archivos: ImportArchivoResultado[]; vacias: number; errores: string[]; }
export interface ImportItemEnvio { titulo: string; descripcion: string; consulta: string; etiquetas: string[]; archivo: string; baseDatos: string; }
export interface ImportItemsResultado { creadas: number; duplicadas: number; modifican: number; enmascaradas: number; errores: string[]; }

// ----- Relación queries ↔ esquema (mapa estelar) -----
export interface MapaQueriesBase { o: string; bd: string; queries: number; modifican: number; tablas: number; }
export interface MapaQueriesPuente {
  a: BaseRef; b: BaseRef; joins: number; queries: number;
  ejemplos: { id: number; titulo: string; desde: string; hacia: string }[];
}
export interface MapaQueriesResumen {
  tabla: boolean;
  total: number;
  bases: MapaQueriesBase[];
  puentes: MapaQueriesPuente[];
  sinResolver?: { queries: number; tablas: { nombre: string; usos: number }[] };
}
export interface MapaQueriesTabla { es: string; n: string; queries: number; modifican: number; escriben: number; }
export interface MapaQueriesJoin {
  a: { es: string; n: string }; b: { es: string; n: string };
  usos: number; queries: number; fk: boolean; condiciones: { ca: string; cb: string }[];
}
export interface MapaQueriesBaseDetalle { tabla: boolean; o: string; bd: string; total: number; tablas: MapaQueriesTabla[]; joins: MapaQueriesJoin[]; }
export interface MapaQueriesRelacionada {
  tabla: { ref: TablaRef; nombre: string; esquema: string | null; bd: string; origen: string; tipo: string; nColumnas: number; filas: number | null };
  usos: number; queries: number; fk: boolean; condiciones: { ca: string; cb: string; usos: number }[];
}
export interface MapaQueriesTablaDetalle {
  tabla: boolean;
  ref?: TablaRef;
  total: number;
  queries: QueryResumen[];
  relacionadas: MapaQueriesRelacionada[];
  columnas: { c: string; joins: number; filtros: number }[];
  filtros: { c: string; usos: number; queries: number; ops: string[] }[];
}
export interface ValoresFrecuentes { columna: string; muestra: number; duracionMs: number; valores: { valor: string | null; veces: number }[]; }
export interface NombreSugerido { titulo: string; descripcion: string; etiquetas: string[]; }

export type ModoConstructor = 'detalle' | 'conteo' | 'agrupado' | 'repetidos';
export type OperadorFiltro = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'contiene' | 'nocontiene' | 'empieza' | 'termina' | 'en' | 'noen' | 'nulo' | 'nonulo' | 'vacio' | 'novacio'
  | 'entre' | 'hoy' | 'ayer' | 'ultimosDias' | 'mes' | 'mesPasado';
export type TruncFecha = 'hora' | 'dia' | 'mes' | 'anio';
export type FuncionMedida = 'count' | 'cdistinct' | 'sum' | 'avg' | 'min' | 'max';
export type TipoJoin = 'INNER' | 'LEFT' | 'RIGHT';
export interface ColumnaSel { t: number; c: string; alias?: string; trunc?: TruncFecha | ''; }
export interface MedidaConstructor { fn: FuncionMedida; t?: number; c?: string; alias?: string; }
/** `g`: los filtros con el mismo número de grupo se unen con OR; los grupos distintos con AND. */
export interface FiltroConstructor { t: number; c: string; op: OperadorFiltro; v?: string; v2?: string; g?: number; }
export type OrdenConstructor = { t: number; c: string; dir: 'asc' | 'desc' } | { m: number; dir: 'asc' | 'desc' };
export interface UnionManual { t1: number; c1: string; t2: number; c2: string; }
export interface JoinConfig { hacia: number; tipo?: TipoJoin; alt?: number; }
export interface ConfigConstructor {
  tablas: TablaRef[];
  modo?: ModoConstructor;
  columnas?: ColumnaSel[];
  agrupar?: ColumnaSel[];
  medidas?: MedidaConstructor[];
  minTotal?: number;
  filtros?: FiltroConstructor[];
  orden?: OrdenConstructor[];
  top?: number;
  tipoJoin?: 'INNER' | 'LEFT';
  nolock?: boolean;
  distinct?: boolean;
  joinsManuales?: UnionManual[];
  joinsConfig?: JoinConfig[];
  nombre?: string;
  descripcion?: string;
  /** false = no escribir el nombre como comentario al inicio del SQL. */
  comentario?: boolean;
}
export interface OpcionUnion { idx: number; condicion: string; origen: string; confianza: number; detalle: string; }
export interface UnionArmada {
  desde: string;
  hacia: string;
  desdeIdx: number;
  haciaIdx: number;
  condicion: string;
  origen: 'fk' | 'aprendida' | 'nombre' | 'manual';
  confianza: number;
  detalle: string;
  tipo: TipoJoin;
  alt: number;
  opciones: OpcionUnion[];
  alternativas: { condicion: string; origen: string; confianza: number }[];
}
export interface TablaArmada { alias: string; ref: TablaRef; nombre: string; esquema: string | null; bd: string; }
export interface ArmadoQuery {
  sql: string;
  motor: Motor;
  origenId: string;
  baseDatos: string;
  tablas: TablaArmada[];
  joins: UnionArmada[];
  advertencias: string[];
  explicacion: string[];
  modo?: ModoConstructor;
}
export interface PuenteSugerido { ref: TablaRef; nombre: string; bd?: string; esquema?: string; conecta?: string[]; }
export interface ArmadoError {
  error: string;
  sinRelacion?: { ref: TablaRef; nombre: string }[];
  puentes?: PuenteSugerido[];
}
export interface TablaRelacionada {
  tabla: { ref: TablaRef; nombre: string; esquema: string | null; bd: string; origen: string; nColumnas: number; filas: number | null; tipo: string };
  desde: string;
  tipo: 'fk' | 'aprendida' | 'nombre' | 'manual';
  confianza: number;
  usos: number;
  condicion: string;
  direccion: 'padre' | 'hija' | 'relacionada';
}
export interface RecetaQuery { id: string; titulo: string; descripcion: string; config: ConfigConstructor; sql: string; advertencias: string[]; }
export interface FiltroEquipo { c: string; usos: number; }
export interface SugerenciasQuery { relacionadas: TablaRelacionada[]; recetas: RecetaQuery[]; queries: QueryResumen[]; filtrosEquipo?: FiltroEquipo[]; repositorio: boolean; }
export interface RespuestaIa {
  sql: string;
  explicacion: string;
  modelo: string;
  origenId: string;
  baseDatos: string;
  tablasContexto: { ref: TablaRef; nombre: string; esquema: string | null; bd: string; origen: string }[];
  queriesEjemplo: { id: number; titulo: string }[];
  relaciones: string[];
  advertencias: string[];
  soloLectura: { ok: boolean; motivo: string };
}
export interface EjecucionPeticion { origenId: string; bd?: string; sql: string; queryId?: number | null; }
export interface ResultadoEjecucion {
  columnas: string[];
  filas: (string | number | boolean | null)[][];
  truncado: boolean;
  duracionMs: number;
  maxFilas: number;
  servidor: string;
  baseDatos: string;
}

@Injectable({ providedIn: 'root' })
export class CatalogoDatosService {
  private base = `${environment.apiUrl}/catalogo-datos`;

  constructor(private http: HttpClient) {}

  resumen(): Observable<CatalogoResumen> {
    return this.http.get<CatalogoResumen>(`${this.base}/resumen`);
  }

  galaxia(): Observable<Galaxia> {
    return this.http.get<Galaxia>(`${this.base}/galaxia`);
  }

  buscar(q: string, opciones: { tipo?: 'todo' | 'tabla' | 'columna'; origen?: string; bd?: string; limite?: number } = {}): Observable<BusquedaResultado> {
    let p = new HttpParams().set('q', q);
    if (opciones.tipo) p = p.set('tipo', opciones.tipo);
    if (opciones.origen) p = p.set('origen', opciones.origen);
    if (opciones.bd) p = p.set('bd', opciones.bd);
    if (opciones.limite) p = p.set('limite', String(opciones.limite));
    return this.http.get<BusquedaResultado>(`${this.base}/buscar`, { params: p });
  }

  lugaresDeColumna(nombre: string, opciones: { origen?: string; bd?: string; desde?: number; limite?: number } = {}): Observable<LugaresColumna> {
    let p = new HttpParams().set('nombre', nombre);
    if (opciones.origen) p = p.set('origen', opciones.origen);
    if (opciones.bd) p = p.set('bd', opciones.bd);
    if (opciones.desde) p = p.set('desde', String(opciones.desde));
    if (opciones.limite) p = p.set('limite', String(opciones.limite));
    return this.http.get<LugaresColumna>(`${this.base}/columna`, { params: p });
  }

  tabla(ref: TablaRef): Observable<TablaDetalle> {
    return this.http.get<TablaDetalle>(`${this.base}/tabla`, { params: this.paramsRef(ref) });
  }

  grafo(ref: TablaRef, profundidad: 1 | 2 = 1): Observable<Grafo> {
    return this.http.get<Grafo>(`${this.base}/grafo`, { params: this.paramsRef(ref).set('profundidad', String(profundidad)) });
  }

  mapaBase(origen: string, bd: string): Observable<MapaBase> {
    return this.http.get<MapaBase>(`${this.base}/mapa-base`, { params: new HttpParams().set('o', origen).set('bd', bd) });
  }

  actualizar(origenId?: string): Observable<{ iniciado: boolean; origenes: number; sinCredenciales: number }> {
    return this.http.post<{ iniciado: boolean; origenes: number; sinCredenciales: number }>(`${this.base}/actualizar`, origenId ? { origen: origenId } : {});
  }

  // --- Mis credenciales (de cada persona, solo en la memoria del servidor durante su sesión) ---
  credenciales(): Observable<{ credenciales: CredencialesCatalogo; horas: number }> {
    return this.http.get<{ credenciales: CredencialesCatalogo; horas: number }>(`${this.base}/credenciales`);
  }
  /** `clave` vacía = conservar la que ya tiene la sesión (solo si ya había una). */
  guardarCredenciales(motor: Motor, c: { usuario: string; clave: string }): Observable<{ credenciales: CredencialesCatalogo; iniciados: number }> {
    const cuerpo: Record<string, string> = { usuario: c.usuario };
    if (c.clave) cuerpo['clave'] = c.clave;
    return this.http.put<{ credenciales: CredencialesCatalogo; iniciados: number }>(`${this.base}/credenciales/${motor}`, cuerpo);
  }
  quitarCredenciales(motor: Motor): Observable<{ credenciales: CredencialesCatalogo }> {
    return this.http.delete<{ credenciales: CredencialesCatalogo }>(`${this.base}/credenciales/${motor}`);
  }
  limpiarClaves(): Observable<{ ok: boolean; limpiados: number }> {
    return this.http.post<{ ok: boolean; limpiados: number }>(`${this.base}/origenes/limpiar-claves`, {});
  }

  // --- Orígenes (ADMIN_POD) ---
  origenes(): Observable<OrigenesRespuesta> {
    return this.http.get<OrigenesRespuesta>(`${this.base}/origenes`);
  }
  crearOrigen(f: OrigenForm): Observable<OrigenAdmin> {
    return this.http.post<OrigenAdmin>(`${this.base}/origenes`, this.cuerpoOrigen(f));
  }
  editarOrigen(id: string, f: OrigenForm): Observable<OrigenAdmin> {
    return this.http.put<OrigenAdmin>(`${this.base}/origenes/${encodeURIComponent(id)}`, this.cuerpoOrigen(f));
  }
  quitarOrigen(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/origenes/${encodeURIComponent(id)}`);
  }
  probarOrigen(f: OrigenForm): Observable<PruebaOrigen> {
    return this.http.post<PruebaOrigen>(`${this.base}/origenes/probar`, this.cuerpoOrigen(f));
  }

  masivoOrigenes(p: MasivoPeticion): Observable<MasivoRespuesta> {
    return this.http.post<MasivoRespuesta>(`${this.base}/origenes/masivo`, p);
  }

  // ----- Queries -----
  queriesResumen(): Observable<QueriesResumen> {
    return this.http.get<QueriesResumen>(`${this.base}/queries/resumen`);
  }

  queries(f: FiltrosQueries = {}): Observable<QueriesLista> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && String(v) !== '') params = params.set(k, String(v));
    return this.http.get<QueriesLista>(`${this.base}/queries`, { params });
  }

  query(id: number): Observable<QueryResumen> {
    return this.http.get<QueryResumen>(`${this.base}/queries/${id}`);
  }

  queriesSimilares(id: number): Observable<{ queries: QueryResumen[] }> {
    return this.http.get<{ queries: QueryResumen[] }>(`${this.base}/queries/${id}/similares`);
  }

  queriesDeTabla(ref: TablaRef): Observable<{ queries: QueryResumen[] }> {
    return this.http.get<{ queries: QueryResumen[] }>(`${this.base}/queries/de-tabla`, { params: this.paramsRef(ref) });
  }

  analizarQuery(cuerpo: { consulta: string; titulo?: string; descripcion?: string; archivo?: string; enmascarar?: boolean }): Observable<AnalisisQuery> {
    return this.http.post<AnalisisQuery>(`${this.base}/queries/analizar`, cuerpo);
  }

  crearQuery(q: QueryEntrada): Observable<QueryResumen> {
    return this.http.post<QueryResumen>(`${this.base}/queries`, q);
  }

  editarQuery(id: number, q: Partial<QueryEntrada>): Observable<QueryResumen> {
    return this.http.put<QueryResumen>(`${this.base}/queries/${id}`, q);
  }

  quitarQuery(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/queries/${id}`);
  }

  importarQueries(cuerpo: { archivos: ImportArchivo[]; dividir: boolean; enmascarar: boolean }): Observable<ImportResultado> {
    return this.http.post<ImportResultado>(`${this.base}/queries/importar`, cuerpo);
  }

  previaImportacion(cuerpo: { archivos: ImportArchivo[]; dividir: boolean; enmascarar: boolean }): Observable<ImportPrevia> {
    return this.http.post<ImportPrevia>(`${this.base}/queries/importar/previa`, cuerpo);
  }

  importarItems(cuerpo: { items: ImportItemEnvio[]; enmascarar: boolean }): Observable<ImportItemsResultado> {
    return this.http.post<ImportItemsResultado>(`${this.base}/queries/importar/items`, cuerpo);
  }

  sugerirNombre(consulta: string, archivo?: string): Observable<NombreSugerido> {
    return this.http.post<NombreSugerido>(`${this.base}/queries/sugerir-nombre`, { consulta, archivo });
  }

  valoresFrecuentes(tabla: TablaRef, columna: string): Observable<ValoresFrecuentes> {
    return this.http.post<ValoresFrecuentes>(`${this.base}/queries/constructor/valores`, { tabla, columna });
  }

  mapaQueriesResumen(): Observable<MapaQueriesResumen> {
    return this.http.get<MapaQueriesResumen>(`${this.base}/queries/mapa/resumen`);
  }

  mapaQueriesBase(origen: string, bd: string): Observable<MapaQueriesBaseDetalle> {
    return this.http.get<MapaQueriesBaseDetalle>(`${this.base}/queries/mapa/base`, { params: new HttpParams().set('o', origen).set('bd', bd) });
  }

  mapaQueriesTabla(ref: TablaRef): Observable<MapaQueriesTablaDetalle> {
    return this.http.get<MapaQueriesTablaDetalle>(`${this.base}/queries/mapa/tabla`, { params: this.paramsRef(ref) });
  }

  sugerirQueries(tablas: TablaRef[]): Observable<SugerenciasQuery> {
    return this.http.post<SugerenciasQuery>(`${this.base}/queries/constructor/sugerir`, { tablas });
  }

  armarQuery(config: ConfigConstructor): Observable<ArmadoQuery> {
    return this.http.post<ArmadoQuery>(`${this.base}/queries/constructor/armar`, { config });
  }

  preguntarIa(cuerpo: { pregunta: string; origenId?: string | null; tablas?: TablaRef[] }): Observable<RespuestaIa> {
    return this.http.post<RespuestaIa>(`${this.base}/queries/constructor/ia`, cuerpo);
  }

  ejecutarQuery(p: EjecucionPeticion): Observable<ResultadoEjecucion> {
    return this.http.post<ResultadoEjecucion>(`${this.base}/queries/ejecutar`, p);
  }

  private paramsRef(ref: TablaRef): HttpParams {
    return new HttpParams().set('o', ref.o).set('bd', ref.bd).set('es', ref.es || '').set('n', ref.n);
  }

  private cuerpoOrigen(f: OrigenForm): Record<string, unknown> {
    const cuerpo: Record<string, unknown> = {
      nombre: f.nombre, motor: f.motor, host: f.host,
      cifrado: f.cifrado, confiarCertificado: f.confiarCertificado, activo: f.activo,
      basesIncluidas: f.basesIncluidas.split(/[,\n;]/).map((b) => b.trim()).filter(Boolean),
    };
    if (f.puerto) cuerpo['puerto'] = f.puerto;
    if (f.id) cuerpo['id'] = f.id;
    return cuerpo;
  }
}
