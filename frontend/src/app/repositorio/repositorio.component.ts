import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import * as XLSX from 'xlsx';
import { Workbook, Worksheet, Cell } from 'exceljs';
import JSZip from 'jszip';
import hljs from 'highlight.js';
import { environment } from '../../environments/environment';
import { RepoWikiComponent } from './tabs/wiki.component';
import { AzureResumenComponent } from './azure/azure-resumen.component';
import { AzureCommitsComponent } from './azure/azure-commits.component';
import { AzurePrsComponent } from './azure/azure-prs.component';
import { AzureRamasComponent } from './azure/azure-ramas.component';
import { AzurePipelinesComponent } from './azure/azure-pipelines.component';
import { AzureReleasesComponent } from './azure/azure-releases.component';
import { AzureBoardsComponent } from './azure/azure-boards.component';
import { AzureEquipoComponent } from './azure/azure-equipo.component';
import { AzureBuscarComponent } from './azure/azure-buscar.component';
import { Observable, combineLatest, filter } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { AzureAccesosComponent } from './azure/azure-accesos.component';
import { AzureConexionComponent } from './azure/azure-conexion.component';
import { AzureAccesoService } from './azure/azure-acceso.service';
import { RepositorioContextService, RepositorioAzure } from './repositorio-context.service';
import { IcoComponent } from '../shared/ico/ico.component';

// Pestañas disponibles dentro del módulo Repositorio -- todas viven bajo la
// misma ruta/menú (REPOSITORIO). Todo es de solo lectura: reflejan lo que hay en
// Azure DevOps (código, PRs, pipelines, releases, boards, equipo, búsqueda).
export type PestanaRepositorio =
  | 'resumen' | 'archivos' | 'commits' | 'pull-requests' | 'ramas' | 'pipelines' | 'releases' | 'boards' | 'wiki' | 'equipo' | 'buscar';

export interface CommitInfo {
  id: string;
  idCorto: string;
  comentario: string;
  autor: string;
}

export interface ItemRepositorio {
  nombre: string;
  path: string;
  esCarpeta: boolean;
  ultimoCambio: string | null;
  commit: CommitInfo | null;
}

export interface RespuestaItems {
  organizacion: string;
  proyecto: string;
  repositorio: string;
  rama: string;
  path: string;
  items: ItemRepositorio[];
}

export interface CommitHistorial {
  id: string;
  idCorto: string;
  comentario: string;
  autor: string;
  fecha: string | null;
  url: string | null;
}

// Una hoja de un Excel/CSV ya convertida a una tabla simple de strings, sin
// ningún formato -- se usa como plan B para .xls/.csv (ExcelJS no lee esos
// formatos) y como respaldo si el parseo "con estilo" de un .xlsx falla.
export interface HojaExcel {
  nombre: string;
  filas: string[][];
}

// --- Visor "con estilo" para .xlsx/.xlsm (ver procesarExcelConEstilo) ---
// Reproduce en HTML lo más fiel posible al Excel real: color de fondo,
// negrita/cursiva/subrayado, alineación, bordes, columnas combinadas, ancho
// de columnas/filas e imágenes incrustadas (como el logo del banco).

export interface EstiloCeldaExcel {
  backgroundColor?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  fontSize?: number;
  bordes?: { top?: string; right?: string; bottom?: string; left?: string };
}

export interface CeldaExcel {
  texto: string;
  estilo: EstiloCeldaExcel;
  rowspan: number;
  colspan: number;
  // true = celda cubierta por una combinación de celdas ancladas en otra
  // celda -- no se dibuja (ver construirFilasRicas()).
  oculta: boolean;
}

export interface ImagenHojaExcel {
  dataUrl: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface FormaHojaExcel {
  tipo: 'rect' | 'ellipse';
  left: number;
  top: number;
  width: number;
  height: number;
  fill: string;
  strokeColor: string;
  strokeWidth: number;
  strokeDashed: boolean;
  texto: string;
  rounded: boolean;
  // Grados de rotación (a:xfrm rot, convertido de 60000avos de grado) -- se
  // aplica como transform: rotate() en la plantilla, ej. para las etiquetas
  // de texto verticales que traen algunos diagramas.
  rotacion: number;
}

export interface ConectorHojaExcel {
  left: number;
  top: number;
  width: number;
  height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeColor: string;
  strokeWidth: number;
  conFlecha: boolean;
}

export interface HojaExcelRica {
  nombre: string;
  filas: CeldaExcel[][];
  anchoColumnas: number[];
  anchoTotal: number;
  // Alto (px) de cada fila y su suma -- igual que anchoColumnas/anchoTotal,
  // pero para el eje vertical. Se usa tanto para el alto explícito de cada
  // <tr> como para el alto del lienzo (.tabla-excel-rica-lienzo), de forma
  // que la tabla y las imágenes/formas superpuestas (posicionadas con estas
  // mismas medidas, ver calcularAltoFilas()) queden alineadas.
  altoFilas: number[];
  altoTotal: number;
  imagenes: ImagenHojaExcel[];
  // Formas (rectangulos/ovalos) y conectores (flechas/lineas) dibujados a
  // mano en Excel -- ver extraerFormasHoja(). ExcelJS los descarta
  // silenciosamente (solo lee imagenes incrustadas); se leen aparte del XML
  // crudo del dibujo (xl/drawings/drawingN.xml) y se dibujan encima de la
  // tabla igual que las imagenes.
  formas: FormaHojaExcel[];
  conectores: ConectorHojaExcel[];
  // true solo si el dibujo trae algo que de verdad no se puede reproducir
  // aqui (ej. un grupo de formas anidado, o un grafico/SmartArt incrustado)
  // -- las formas y conectores simples ya se dibujan, asi que esto ya no se
  // activa para ellos.
  tieneFormasNoSoportadas: boolean;
}

// Qué clase de visor usar según la extensión del archivo (ver
// clasificarArchivo()) -- cada uno tiene su propio bloque en la plantilla.
type TipoVisor = 'excel' | 'imagen' | 'pdf' | 'codigo' | 'no-soportado';

// Extensiones que Excel/SheetJS puede leer directamente (incluye CSV: se
// parsea igual que una hoja de cálculo de una sola hoja).
const EXTENSIONES_EXCEL = ['.xlsx', '.xls', '.xlsm', '.csv'];
const EXTENSIONES_IMAGEN = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'];
const EXTENSIONES_PDF = ['.pdf'];
// Formatos binarios "de oficina"/comprimidos que NO tiene sentido intentar
// mostrar como texto (saldría contenido ilegible) -- para estos se ofrece
// solo la descarga.
const EXTENSIONES_SIN_PREVIEW = [
  '.doc', '.docx', '.ppt', '.pptx', '.zip', '.rar', '.7z', '.gz', '.tar',
  '.exe', '.dll', '.msi', '.bin', '.dat', '.mdb', '.accdb',
];

// Extensión -> lenguaje de highlight.js, para resaltar bien en vez de
// depender del autodetección (más rápido y más preciso). 'plaintext' cubre
// texto plano sin resaltado real.
const LENGUAJE_POR_EXTENSION: Record<string, string> = {
  '.json': 'json',
  '.xml': 'xml',
  '.config': 'xml',
  '.csproj': 'xml',
  '.html': 'xml',
  '.htm': 'xml',
  '.cs': 'csharp',
  '.js': 'javascript',
  '.ts': 'typescript',
  '.css': 'css',
  '.scss': 'scss',
  '.sql': 'sql',
  '.java': 'java',
  '.py': 'python',
  '.sh': 'bash',
  '.bat': 'dos',
  '.ps1': 'powershell',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.md': 'markdown',
  '.ini': 'ini',
  '.gitignore': 'plaintext',
  '.txt': 'plaintext',
  '.log': 'plaintext',
};

@Component({
  selector: 'app-repositorio',
  standalone: true,
  imports: [IcoComponent, 
    CommonModule,
    RouterLink,
    RepoWikiComponent,
    AzureResumenComponent,
    AzureCommitsComponent,
    AzurePrsComponent,
    AzureRamasComponent,
    AzurePipelinesComponent,
    AzureReleasesComponent,
    AzureBoardsComponent,
    AzureEquipoComponent,
    AzureBuscarComponent,
    AzureAccesosComponent,
    AzureConexionComponent,
  ],
  templateUrl: './repositorio.component.html',
  styleUrl: './repositorio.component.scss'
})
export class RepositorioComponent implements OnInit {
  pestanaActiva: PestanaRepositorio = 'resumen';

  cargando = false;
  error = '';

  respuesta: RespuestaItems | null = null;
  rutaActual = '/';
  // Rama que se está explorando en la pestaña Archivos -- vacío significa
  // "usar la rama por defecto configurada en el backend" (comportamiento
  // original, antes de que existiera la pestaña Branches). Se actualiza con
  // la rama efectiva que devuelve el backend en cada respuesta, para que
  // quede reflejada en el encabezado (badge junto al nombre del repo).
  ramaActual = '';

  // Panel de historial de commits (para un archivo/carpeta puntual).
  historialAbierto = false;
  historialCargando = false;
  historialPath = '';
  historialCommits: CommitHistorial[] = [];
  historialError = '';

  // Panel de "ver contenido" (visor de archivo) -- ver verContenido().
  visorAbierto = false;
  visorCargando = false;
  visorError = '';
  visorNombreArchivo = '';
  visorPath = '';
  visorTipo: TipoVisor | null = null;

  // Poblado solo cuando visorTipo === 'excel'. Para .xlsx/.xlsm se intenta
  // primero el visor "con estilo" (usaEstiloRico=true, ver visorHojasRicas);
  // si falla, o el archivo es .xls/.csv, se cae al visor simple (visorHojas,
  // solo valores) -- ver procesarExcel().
  visorHojas: HojaExcel[] = [];
  visorHojasRicas: HojaExcelRica[] = [];
  usaEstiloRico = false;
  visorHojaActivaIndice = 0;

  // Poblado solo cuando visorTipo === 'codigo'.
  visorCodigoHtml = '';

  // Poblado solo cuando visorTipo === 'imagen' | 'pdf'.
  visorUrlObjeto: string | null = null; // se revoca al cerrar (ver cerrarVisor)
  visorUrlSegura: SafeResourceUrl | null = null; // versión "confiable" para [src] de <iframe>

  // Guarda el blob ya descargado para que el botón "Descargar" no tenga que
  // volver a pedirlo al backend -- se reusa el mismo contenido que se
  // acaba de traer para previsualizar.
  private visorBlobParaDescarga: Blob | null = null;

  private endpoint = `${environment.apiUrl}/azure-repo`;

  constructor(
    private http: HttpClient,
    private sanitizer: DomSanitizer,
    private repoContext: RepositorioContextService,
    private accesoSvc: AzureAccesoService,
    private authService: AuthService
  ) {
    this.repositorios$ = this.repoContext.repositorios$;
    this.repositorioActual$ = this.repoContext.repositorioActual$;
  }

  // Observables expuestos directamente a la plantilla (selector de
  // repositorio en el encabezado) -- el servicio es singleton (providedIn
  // 'root') así que la selección queda sincronizada con las pestañas.
  // Se asignan en el constructor (no como inicializador de campo) para
  // evitar el error TS2729 "used before its initialization": con
  // useDefineForClassFields, los inicializadores de campos declarados
  // después del constructor corren antes de que este asigne los parámetros
  // (repoContext) que necesitan.
  readonly repositorios$: Observable<RepositorioAzure[]>;
  readonly repositorioActual$: Observable<string>;

  // Acceso del usuario (qué secciones y repositorios le habilitó el ADMIN_POD).
  accesoListo = false;
  sinSecciones = false;
  esAdminPod = false;
  accesosAbierto = false;
  conexionAbierta = false;
  remontando = false;

  private readonly ordenPestanas: PestanaRepositorio[] = ['resumen', 'archivos', 'commits', 'pull-requests', 'ramas', 'pipelines', 'releases', 'boards', 'wiki', 'equipo', 'buscar'];

  // ¿Se muestra esta sección? Falso mientras no se sepa el acceso, para no pedir datos que luego se nieguen.
  ver(seccion: string): boolean { return this.accesoListo && this.accesoSvc.puede(seccion); }

  get sinRepositorios(): boolean { return this.repoContext.sinRepositorios; }

  ngOnInit(): void {
    this.authService.usuarioLogueado$.subscribe((u) => { this.esAdminPod = u?.rol === 'ADMIN_POD'; });
    this.accesoSvc.acceso$.pipe(filter((a) => !!a)).subscribe(() => {
      this.accesoListo = true;
      this.ajustarPestana();
    });
    this.accesoSvc.cargar();

    // Cuando cambia el repo seleccionado (incluida la primera vez que se
    // resuelve el default), se reinicia la navegación de archivos y se
    // recarga la raíz sobre el nuevo repo (si el usuario tiene Archivos).
    combineLatest([this.repoContext.repositorioActual$, this.accesoSvc.acceso$.pipe(filter((a) => !!a))]).subscribe(([repo]) => {
      if (!repo) return;
      this.ramaActual = '';
      this.rutaActual = '/';
      if (this.accesoSvc.puede('archivos') && !this.repoContext.sinRepositorios) this.cargarCarpeta('/');
    });
    this.repoContext.cargarRepositorios();
  }

  // Si la pestaña actual no está permitida, pasa a la primera que sí lo esté.
  private ajustarPestana(): void {
    if (this.accesoSvc.puede(this.pestanaActiva)) { this.sinSecciones = false; return; }
    const primera = this.ordenPestanas.find((p) => this.accesoSvc.puede(p));
    if (primera) { this.pestanaActiva = primera; this.sinSecciones = false; } else { this.sinSecciones = true; }
  }

  abrirAccesos(): void { this.accesosAbierto = true; }
  cerrarAccesos(): void { this.accesosAbierto = false; }

  abrirConexion(): void { this.conexionAbierta = true; }
  // Si se cambiaron tokens o ajustes, se vuelve a leer todo con la conexión nueva.
  cerrarConexion(huboCambios: boolean): void {
    this.conexionAbierta = false;
    if (!huboCambios) return;
    this.remontando = true;
    this.repoContext.cargarRepositorios(true);
    this.accesoSvc.cargar(true); // al emitir, la raíz de Archivos se vuelve a leer sola
    setTimeout(() => { this.remontando = false; });
  }

  cambiarRepositorio(nombre: string): void {
    this.repoContext.seleccionarRepositorio(nombre);
  }

  // --- Pestañas ---

  cambiarPestana(pestana: PestanaRepositorio): void {
    if (!this.ver(pestana)) return;
    this.pestanaActiva = pestana;
  }

  // Los resúmenes y tarjetas de las pestañas piden ir a otra (ej. "Ver todos los PRs").
  irA(pestana: string): void {
    const validas: PestanaRepositorio[] = ['resumen', 'archivos', 'commits', 'pull-requests', 'ramas', 'pipelines', 'releases', 'boards', 'wiki', 'equipo', 'buscar'];
    if ((validas as string[]).includes(pestana) && this.ver(pestana)) this.pestanaActiva = pestana as PestanaRepositorio;
  }

  // Llamado desde la pestaña Branches (evento ramaSeleccionada) cuando el
  // usuario pide explorar los archivos de una rama distinta a la actual.
  usarRama(nombreRama: string): void {
    if (!this.ver('archivos')) return;
    this.ramaActual = nombreRama;
    this.pestanaActiva = 'archivos';
    this.cargarCarpeta('/');
  }

  // Arma los query params de las llamadas a /items, /historial y /contenido,
  // agregando "rama" solo cuando se está explorando una distinta a la que
  // trae el backend por defecto (mantiene las URLs limpias en el caso normal).
  // Iniciales (hasta 2 letras) para el "avatar" de texto junto al nombre
  // del autor en la lista de archivos -- ej. "Jeison Malagon" -> "JM".
  inicialesAutor(nombre: string): string {
    const partes = (nombre || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '?';
    const primeras = partes.slice(0, 2).map((p) => p[0]?.toUpperCase() || '');
    return primeras.join('') || '?';
  }

  private paramsConRama(base: Record<string, string>): Record<string, string> {
    const conRepo = this.repoContext.repositorioActual
      ? { ...base, repo: this.repoContext.repositorioActual }
      : base;
    return this.ramaActual ? { ...conRepo, rama: this.ramaActual } : conRepo;
  }

  // --- Navegación de carpetas ---

  cargarCarpeta(path: string): void {
    this.cargando = true;
    this.error = '';
    this.rutaActual = path;

    this.http
      .get<RespuestaItems>(`${this.endpoint}/items`, { params: this.paramsConRama({ path }) })
      .subscribe({
        next: (data) => {
          this.respuesta = data;
          this.ramaActual = data.rama;
          this.cargando = false;
        },
        error: (err) => {
          this.error = err.error?.error || 'No se pudo cargar el contenido del repositorio.';
          this.cargando = false;
        }
      });
  }

  // Clic en una fila: carpeta navega, archivo abre el visor de contenido
  // (antes abría el historial -- ahora el historial es una acción aparte,
  // ver verHistorial()/el botón del reloj de cada fila).
  abrirItem(item: ItemRepositorio): void {
    if (item.esCarpeta) {
      this.cargarCarpeta(item.path);
    } else {
      this.verContenido(item);
    }
  }

  recargar(): void {
    this.cargarCarpeta(this.rutaActual);
  }

  // Migas de pan a partir de la ruta actual (ej. "/Servicios/C001 Foo" ->
  // ["Servicios", "C001 Foo"], cada una navegable a su ruta acumulada).
  get migasDePan(): { nombre: string; path: string }[] {
    const partes = this.rutaActual.split('/').filter(Boolean);
    let acumulado = '';
    return partes.map((nombre) => {
      acumulado += '/' + nombre;
      return { nombre, path: acumulado };
    });
  }

  // --- Historial de commits de un archivo/carpeta puntual ---

  verHistorial(item: ItemRepositorio): void {
    this.historialAbierto = true;
    this.historialCargando = true;
    this.historialError = '';
    this.historialPath = item.path;
    this.historialCommits = [];

    this.http
      .get<{ path: string; commits: CommitHistorial[] }>(`${this.endpoint}/historial`, {
        params: this.paramsConRama({ path: item.path })
      })
      .subscribe({
        next: (data) => {
          this.historialCommits = data.commits || [];
          this.historialCargando = false;
        },
        error: (err) => {
          this.historialError = err.error?.error || 'No se pudo cargar el historial de commits.';
          this.historialCargando = false;
        }
      });
  }

  cerrarHistorial(): void {
    this.historialAbierto = false;
  }

  // --- Visor de contenido (Excel/CSV, texto/código/XML, imagen, PDF) ---

  private extensionDe(nombre: string): string {
    const punto = nombre.lastIndexOf('.');
    return punto >= 0 ? nombre.slice(punto).toLowerCase() : '';
  }

  private clasificarArchivo(extension: string): TipoVisor {
    if (EXTENSIONES_EXCEL.includes(extension)) return 'excel';
    if (EXTENSIONES_IMAGEN.includes(extension)) return 'imagen';
    if (EXTENSIONES_PDF.includes(extension)) return 'pdf';
    if (EXTENSIONES_SIN_PREVIEW.includes(extension)) return 'no-soportado';
    // Cualquier otra extensión (o sin extensión) se intenta como texto/código
    // -- cubre "etc" (config, csproj, gitignore, y cualquier lenguaje que no
    // esté en el mapa de arriba cae a autodetección de highlight.js).
    return 'codigo';
  }

  verContenido(item: ItemRepositorio): void {
    this.visorAbierto = true;
    this.visorCargando = true;
    this.visorError = '';
    this.visorPath = item.path;
    this.visorNombreArchivo = item.nombre;
    this.visorTipo = null;
    this.visorHojas = [];
    this.visorHojasRicas = [];
    this.usaEstiloRico = false;
    this.visorHojaActivaIndice = 0;
    this.visorCodigoHtml = '';
    this.liberarUrlObjeto();
    this.visorBlobParaDescarga = null;

    const extension = this.extensionDe(item.nombre);
    const tipo = this.clasificarArchivo(extension);
    this.visorTipo = tipo;

    // Incluso para tipos "sin preview" se trae el contenido -- así el botón
    // Descargar no depende de un segundo viaje al backend. Solo se salta la
    // parte de renderizar una vista previa (ver procesarContenido()). Si el
    // archivo es muy grande, el backend responde con error (límite 20MB) y
    // ese mensaje se muestra tal cual, sugiriendo abrirlo en Azure DevOps.
    this.http
      .get(`${this.endpoint}/contenido`, {
        params: this.paramsConRama({ path: item.path }),
        responseType: 'arraybuffer'
      })
      .subscribe({
        next: (buffer) => {
          // El Excel "con estilo" se procesa aparte porque ExcelJS lee de
          // forma asíncrona (ver procesarExcel) -- todos los demás tipos
          // siguen el camino síncrono de siempre.
          if (tipo === 'excel') {
            this.procesarExcel(buffer, extension);
            return;
          }
          try {
            this.procesarContenido(buffer, extension, tipo);
          } catch (e) {
            console.error('Error al procesar el contenido del archivo', e);
            this.visorError = 'No se pudo interpretar el contenido de este archivo.';
          }
          this.visorCargando = false;
        },
        error: (err) => {
          // El backend devuelve el error como ArrayBuffer también (mismo
          // responseType de la petición) -- hay que decodificarlo para leer
          // el mensaje real en vez de mostrar "[object ArrayBuffer]".
          this.visorError = this.decodificarMensajeError(err) || 'No se pudo cargar el contenido de este archivo.';
          this.visorCargando = false;
        }
      });
  }

  private decodificarMensajeError(err: any): string | null {
    try {
      const cuerpo = err?.error;
      if (cuerpo instanceof ArrayBuffer) {
        const texto = new TextDecoder('utf-8').decode(cuerpo);
        const json = JSON.parse(texto);
        return json?.error || null;
      }
      return err?.error?.error || null;
    } catch {
      return null;
    }
  }

  private procesarContenido(buffer: ArrayBuffer, extension: string, tipo: TipoVisor): void {
    const nombreArchivo = this.visorNombreArchivo;

    if (tipo === 'no-soportado') {
      // No se intenta ninguna vista previa (sería contenido binario
      // ilegible) -- solo se deja lista la descarga.
      this.visorBlobParaDescarga = new Blob([buffer], { type: 'application/octet-stream' });
      return;
    }

    if (tipo === 'imagen') {
      const blob = new Blob([buffer], { type: this.mimePorExtension(extension) });
      this.visorBlobParaDescarga = blob;
      this.visorUrlObjeto = URL.createObjectURL(blob);
      return;
    }

    if (tipo === 'pdf') {
      const blob = new Blob([buffer], { type: 'application/pdf' });
      this.visorBlobParaDescarga = blob;
      this.visorUrlObjeto = URL.createObjectURL(blob);
      this.visorUrlSegura = this.sanitizer.bypassSecurityTrustResourceUrl(this.visorUrlObjeto);
      return;
    }

    // 'codigo': texto plano, XML, JSON, y cualquier lenguaje de código.
    const texto = new TextDecoder('utf-8').decode(buffer);
    this.visorBlobParaDescarga = new Blob([buffer], { type: 'text/plain;charset=utf-8' });
    const lenguaje = LENGUAJE_POR_EXTENSION[extension];
    const resultado = lenguaje && hljs.getLanguage(lenguaje)
      ? hljs.highlight(texto, { language: lenguaje })
      : hljs.highlightAuto(texto);
    this.visorCodigoHtml = resultado.value;
    void nombreArchivo; // (solo se usa en el mensaje de descarga, ver plantilla)
  }

  // --- Excel: enrutador entre visor "con estilo" (.xlsx/.xlsm) y simple (.xls/.csv) ---

  private async procesarExcel(buffer: ArrayBuffer, extension: string): Promise<void> {
    this.usaEstiloRico = false;
    this.visorHojasRicas = [];
    this.visorHojas = [];

    try {
      if (extension === '.xlsx' || extension === '.xlsm') {
        await this.procesarExcelConEstilo(buffer);
      } else {
        this.procesarExcelSimple(buffer);
      }
    } catch (e) {
      // Defensivo: si ExcelJS no puede leer el archivo (protegido, corrupto,
      // una variante rara del formato, etc.) no se rompe el visor -- se cae
      // a la tabla simple de solo valores (SheetJS), que es más tolerante.
      console.error('No se pudo leer el formato/estilo del Excel, se muestra la vista simple', e);
      try {
        this.procesarExcelSimple(buffer);
      } catch (e2) {
        console.error('Tampoco se pudo leer este archivo como Excel/CSV', e2);
        this.visorError = 'No se pudo interpretar el contenido de este archivo.';
      }
    } finally {
      this.visorBlobParaDescarga = new Blob([buffer], { type: this.mimePorExtension(extension) });
      this.visorCargando = false;
    }
  }

  // Plan B (y único camino para .xls/.csv, que ExcelJS no lee): solo
  // valores, sin ningún formato -- ver HojaExcel.
  private procesarExcelSimple(buffer: ArrayBuffer): void {
    const libro = XLSX.read(buffer, { type: 'array' });
    this.visorHojas = libro.SheetNames.map((nombreHoja) => {
      const hoja = libro.Sheets[nombreHoja];
      const filas = XLSX.utils.sheet_to_json<string[]>(hoja, { header: 1, defval: '', raw: false });
      return { nombre: nombreHoja, filas: filas.map((fila) => fila.map((celda) => String(celda ?? ''))) };
    });
  }

  // Visor "con estilo" para .xlsx/.xlsm -- usa ExcelJS (a diferencia de
  // SheetJS/xlsx, sí expone color de fondo, fuente, bordes, alineación,
  // celdas combinadas, ancho de columnas/filas e imágenes incrustadas).
  private async procesarExcelConEstilo(buffer: ArrayBuffer): Promise<void> {
    const libro = new Workbook();
    await libro.xlsx.load(buffer as any);

    // ExcelJS descarta silenciosamente las formas/conectores dibujados a mano
    // (xdr:sp/xdr:cxnSp) al leer un .xlsx -- solo entiende imágenes
    // incrustadas (xdr:pic). Para poder dibujarlas de todos modos (ver
    // extraerFormasHoja()) se lee también el XML crudo del dibujo de cada
    // hoja analizando el archivo como ZIP -- ver obtenerDrawingXmlPorHoja().
    const drawingXmlPorHoja = await this.obtenerDrawingXmlPorHoja(buffer);

    const hojasRicas: HojaExcelRica[] = [];
    let indiceHoja = 0;
    libro.eachSheet((hoja) => {
      const anchoColumnas = this.calcularAnchoColumnas(hoja);
      const altoFilas = this.calcularAltoFilas(hoja);
      const { imagenes, ultimaColumnaImagen, ultimaFilaImagen } = this.extraerImagenesHoja(libro, hoja, anchoColumnas, altoFilas);

      const drawingXml = drawingXmlPorHoja[indiceHoja];
      const { formas, conectores, ultimaColumnaForma, ultimaFilaForma, huboNoSoportado } = drawingXml
        ? this.extraerFormasHoja(drawingXml, anchoColumnas, altoFilas)
        : { formas: [] as FormaHojaExcel[], conectores: [] as ConectorHojaExcel[], ultimaColumnaForma: -1, ultimaFilaForma: -1, huboNoSoportado: false };

      const filas = this.construirFilasRicas(hoja);
      // El recorte de filas/columnas vacías no debe cortar el área donde cae
      // una imagen o una forma/diagrama (ej. un flowchart) aunque las celdas
      // debajo estén sin texto/formato -- si no, queda posicionado fuera del
      // ancho visible de la tabla (hay que hacer scroll horizontal para
      // "encontrarlo", como se reportó).
      const recortada = this.recortarAlContenidoUtil(
        filas,
        anchoColumnas,
        altoFilas,
        Math.max(ultimaColumnaImagen, ultimaColumnaForma),
        Math.max(ultimaFilaImagen, ultimaFilaForma)
      );
      hojasRicas.push({
        nombre: hoja.name,
        filas: recortada.filas,
        anchoColumnas: recortada.anchoColumnas,
        anchoTotal: recortada.anchoColumnas.reduce((suma, ancho) => suma + ancho, 0),
        altoFilas: recortada.altoFilas,
        altoTotal: recortada.altoFilas.reduce((suma, alto) => suma + alto, 0),
        imagenes,
        formas,
        conectores,
        tieneFormasNoSoportadas: huboNoSoportado
      });
      indiceHoja++;
    });

    if (!hojasRicas.length) {
      throw new Error('El libro de Excel no tiene hojas.');
    }

    this.visorHojasRicas = hojasRicas;
    this.usaEstiloRico = true;
  }

  // Aproximación del tema de colores por defecto de Office -- DrawingML puede
  // referenciar un color por nombre de esquema (a:schemeClr, ej. "accent1")
  // en vez de un valor RGB directo (a:srgbClr). Sin parsear también
  // xl/theme/theme1.xml esto es solo una aproximación razonable (el tema por
  // defecto de Office "Office"), suficiente para que el diagrama se vea
  // similar sin agregar otro archivo XML a analizar.
  private readonly TEMA_COLORES_APROXIMADOS: Record<string, string> = {
    dk1: '000000', tx1: '000000', lt1: 'FFFFFF', bg1: 'FFFFFF',
    dk2: '44546A', tx2: '44546A', lt2: 'E7E6E6', bg2: 'E7E6E6',
    accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5',
    accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47',
    hlink: '0563C1', folHlink: '954F72'
  };

  // Analiza el .xlsx como archivo ZIP (JSZip) para obtener, hoja por hoja, el
  // XML crudo de su dibujo (xl/drawings/drawingN.xml) -- ExcelJS no expone
  // las formas/conectores dibujados a mano (xdr:sp/xdr:cxnSp) en su modelo
  // público (ni siquiera getImages() los refleja), así que es la única forma
  // de leerlos: ver extraerFormasHoja(), que interpreta este XML. Devuelve un
  // array alineado por orden de hoja (0 = primera hoja del libro, igual que
  // libro.eachSheet()); null si esa hoja no tiene dibujo.
  private async obtenerDrawingXmlPorHoja(buffer: ArrayBuffer): Promise<(string | null)[]> {
    const resultado: (string | null)[] = [];
    try {
      const zip = await JSZip.loadAsync(buffer);
      const cacheDrawing = new Map<string, string>();

      for (let i = 1; i <= 500; i++) {
        const hojaXmlPath = `xl/worksheets/sheet${i}.xml`;
        if (!zip.file(hojaXmlPath)) break; // no hay más hojas físicas en el archivo

        let drawingXml: string | null = null;
        const relsFile = zip.file(`xl/worksheets/_rels/sheet${i}.xml.rels`);
        if (relsFile) {
          const relsXml = await relsFile.async('text');
          const match = /Target="([^"]*drawings\/drawing\d+\.xml)"/i.exec(relsXml);
          if (match) {
            const drawingPath = `xl/${match[1].replace(/^(\.\.\/)+/, '')}`;
            let contenido = cacheDrawing.get(drawingPath);
            if (contenido === undefined) {
              const drawingFile = zip.file(drawingPath);
              contenido = drawingFile ? await drawingFile.async('text') : '';
              cacheDrawing.set(drawingPath, contenido);
            }
            drawingXml = contenido || null;
          }
        }
        resultado.push(drawingXml);
      }
    } catch (e) {
      console.error('No se pudo analizar el archivo para leer los dibujos de sus hojas', e);
    }
    return resultado;
  }

  // Elimina filas/columnas finales sin ningún contenido ni formato visible
  // -- muchas hojas de Excel acumulan un rango "usado" (rowCount/columnCount)
  // bastante más grande que el contenido real (por selecciones de formato
  // antiguas, o el área en blanco detrás de un diagrama de formas), lo que
  // sin este recorte se veía como filas/columnas vacías y gigantes al final
  // de la tabla. Nunca recorta nada que tenga texto o estilo -- solo el
  // sobrante realmente en blanco.
  private recortarAlContenidoUtil(filas: CeldaExcel[][], anchoColumnas: number[], altoFilas: number[], ultimaColumnaImagen = -1, ultimaFilaImagen = -1): { filas: CeldaExcel[][]; anchoColumnas: number[]; altoFilas: number[] } {
    const celdaTieneContenido = (c: CeldaExcel): boolean => {
      if (!c.texto && !c.oculta) {
        const e = c.estilo;
        return !!(e.backgroundColor || e.color || e.bold || e.italic || e.underline || e.bordes);
      }
      return !!c.texto;
    };

    let ultimaFila = -1;
    let ultimaColumna = -1;
    filas.forEach((fila, f) => {
      fila.forEach((celda, c) => {
        if (celdaTieneContenido(celda)) {
          if (f > ultimaFila) ultimaFila = f;
          if (c > ultimaColumna) ultimaColumna = c;
        }
      });
    });

    // Nunca recorta más allá de donde llega una imagen incrustada.
    ultimaFila = Math.max(ultimaFila, ultimaFilaImagen);
    ultimaColumna = Math.max(ultimaColumna, ultimaColumnaImagen);

    if (ultimaFila === -1 || ultimaColumna === -1) {
      return { filas: [], anchoColumnas: [], altoFilas: [] };
    }

    const filasRecortadas = filas.slice(0, ultimaFila + 1).map((fila) =>
      fila.slice(0, ultimaColumna + 1).map((celda, c) => ({
        ...celda,
        rowspan: Math.min(celda.rowspan, filas.length - 0), // se ajusta abajo por fila
        colspan: Math.min(celda.colspan, ultimaColumna + 1 - c)
      }))
    );
    // Ajusta rowspan para que ninguna celda combinada se extienda más allá
    // de la última fila recortada (se hace en un segundo paso porque
    // necesita el índice de fila, no solo el de columna).
    filasRecortadas.forEach((fila, f) => {
      fila.forEach((celda) => {
        celda.rowspan = Math.min(celda.rowspan, ultimaFila + 1 - f);
      });
    });

    const anchoColumnasFinal = anchoColumnas.length > ultimaColumna
      ? anchoColumnas.slice(0, ultimaColumna + 1)
      : anchoColumnas.concat(new Array(ultimaColumna + 1 - anchoColumnas.length).fill(64));

    const altoFilasFinal = altoFilas.length > ultimaFila
      ? altoFilas.slice(0, ultimaFila + 1)
      : altoFilas.concat(new Array(ultimaFila + 1 - altoFilas.length).fill(20));

    return {
      filas: filasRecortadas,
      anchoColumnas: anchoColumnasFinal,
      altoFilas: altoFilasFinal
    };
  }

  private contarColumnasMaximas(hoja: Worksheet): number {
    let maximo = hoja.columnCount || 0;
    hoja.eachRow((fila) => {
      maximo = Math.max(maximo, fila.cellCount);
    });
    return Math.max(maximo, 1);
  }

  // Ancho de columna de Excel ("caracteres") a píxeles -- fórmula estándar
  // (~7px por caracter + 5px de margen) que aproxima bien el ancho real que
  // Excel dibuja con la fuente por defecto.
  private calcularAnchoColumnas(hoja: Worksheet): number[] {
    const numColumnas = this.contarColumnasMaximas(hoja);
    const anchos: number[] = [];
    for (let i = 1; i <= numColumnas; i++) {
      const anchoExcel = hoja.getColumn(i).width ?? 8.43;
      anchos.push(Math.round(anchoExcel * 7 + 5));
    }
    return anchos;
  }

  // Alto de fila de Excel (puntos) a píxeles (96/72 dpi).
  private calcularAltoFilas(hoja: Worksheet): number[] {
    const numFilas = hoja.rowCount || 0;
    const alturas: number[] = [];
    for (let i = 1; i <= numFilas; i++) {
      const alturaPuntos = hoja.getRow(i).height ?? 15;
      alturas.push(Math.round(alturaPuntos * 1.333));
    }
    return alturas;
  }

  // "B2:E2" -> {filaIni, colIni, filaFin, colFin} (1-based, como el resto de
  // la API de ExcelJS) -- se usa para resolver las celdas combinadas.
  private decodificarCeldaA1(ref: string): { fila: number; col: number } {
    const match = /^([A-Z]+)(\d+)$/.exec(ref.trim());
    if (!match) return { fila: 1, col: 1 };
    let col = 0;
    for (const letra of match[1]) {
      col = col * 26 + (letra.charCodeAt(0) - 64);
    }
    return { fila: parseInt(match[2], 10), col };
  }

  private decodificarRangoA1(rango: string): { filaIni: number; colIni: number; filaFin: number; colFin: number } {
    const [inicio, fin] = rango.split(':');
    const a = this.decodificarCeldaA1(inicio);
    const b = fin ? this.decodificarCeldaA1(fin) : a;
    return {
      filaIni: Math.min(a.fila, b.fila),
      colIni: Math.min(a.col, b.col),
      filaFin: Math.max(a.fila, b.fila),
      colFin: Math.max(a.col, b.col)
    };
  }

  // Arma la matriz de celdas de la hoja resolviendo las combinaciones: la
  // celda ancla (arriba-izquierda) recibe rowspan/colspan y el resto de las
  // celdas cubiertas se marcan oculta=true (la plantilla no las dibuja, ver
  // repositorio.component.html).
  private construirFilasRicas(hoja: Worksheet): CeldaExcel[][] {
    const numFilas = hoja.rowCount || 0;
    const numColumnas = this.contarColumnasMaximas(hoja);

    const anclasMerge = new Map<string, { rowspan: number; colspan: number }>();
    const celdasCubiertas = new Set<string>();

    (hoja.model.merges || []).forEach((rango) => {
      const { filaIni, colIni, filaFin, colFin } = this.decodificarRangoA1(rango);
      anclasMerge.set(`${filaIni},${colIni}`, { rowspan: filaFin - filaIni + 1, colspan: colFin - colIni + 1 });
      for (let f = filaIni; f <= filaFin; f++) {
        for (let c = colIni; c <= colFin; c++) {
          if (f === filaIni && c === colIni) continue;
          celdasCubiertas.add(`${f},${c}`);
        }
      }
    });

    const filas: CeldaExcel[][] = [];
    for (let f = 1; f <= numFilas; f++) {
      const filaExcel = hoja.getRow(f);
      const filaCeldas: CeldaExcel[] = [];
      for (let c = 1; c <= numColumnas; c++) {
        const clave = `${f},${c}`;
        if (celdasCubiertas.has(clave)) {
          filaCeldas.push({ texto: '', estilo: {}, rowspan: 1, colspan: 1, oculta: true });
          continue;
        }
        const celdaExcel = filaExcel.getCell(c);
        const ancla = anclasMerge.get(clave);
        filaCeldas.push({
          texto: this.valorLegibleCelda(celdaExcel),
          estilo: this.estiloDeCelda(celdaExcel),
          rowspan: ancla?.rowspan ?? 1,
          colspan: ancla?.colspan ?? 1,
          oculta: false
        });
      }
      filas.push(filaCeldas);
    }
    return filas;
  }

  // Convierte el "value" de una celda de ExcelJS (que puede ser texto plano,
  // número, fecha, fórmula {formula,result}, texto enriquecido {richText},
  // hipervínculo {text,hyperlink} o error {error}) a un string mostrable.
  private valorLegibleCelda(celda: Cell): string {
    const valor: any = celda.value;
    if (valor === null || valor === undefined) return '';

    if (typeof valor === 'object') {
      if (Array.isArray(valor.richText)) {
        return valor.richText.map((tramo: any) => tramo.text || '').join('');
      }
      if (valor.error) return String(valor.error);
      if (valor.result !== undefined) return this.formatearValorPlano(valor.result);
      if (valor.text !== undefined) return String(valor.text);
      if (valor instanceof Date) return this.formatearValorPlano(valor);
      return '';
    }

    return this.formatearValorPlano(valor);
  }

  private formatearValorPlano(valor: any): string {
    if (valor instanceof Date) {
      // Fechas "puras" (sin hora real, es decir medianoche) se muestran solo
      // como fecha -- si trae hora se muestra completa.
      const esSoloFecha = valor.getHours() === 0 && valor.getMinutes() === 0 && valor.getSeconds() === 0;
      return esSoloFecha ? valor.toLocaleDateString('es-CO') : valor.toLocaleString('es-CO');
    }
    return String(valor);
  }

  // Colores por defecto del tema estándar de Office -- aproximación para
  // cuando una celda referencia un color de "tema" (theme+tint) en vez de
  // un ARGB explícito, que es habitual en encabezados con la paleta del
  // archivo (no hay forma barata de leer la paleta real del archivo sin
  // parsear el XML del tema a mano).
  private static readonly COLORES_TEMA_OFFICE = [
    '#FFFFFF', '#000000', '#E7E6E6', '#44546A',
    '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000',
    '#5B9BD5', '#70AD47'
  ];

  private colorArgbACss(color: any): string | null {
    if (!color) return null;
    if (color.argb) {
      const argb = String(color.argb);
      const rgb = argb.length === 8 ? argb.slice(2) : argb;
      return `#${rgb}`;
    }
    if (typeof color.theme === 'number') {
      const base = RepositorioComponent.COLORES_TEMA_OFFICE[color.theme] || '#666666';
      return this.aplicarTintHex(base, color.tint);
    }
    return null;
  }

  private aplicarTintHex(hex: string, tint?: number): string {
    if (!tint) return hex;
    const num = parseInt(hex.replace('#', ''), 16);
    const canal = (valor: number) => (tint < 0 ? valor * (1 + tint) : valor * (1 - tint) + 255 * tint);
    const r = Math.min(255, Math.max(0, Math.round(canal((num >> 16) & 0xff))));
    const g = Math.min(255, Math.max(0, Math.round(canal((num >> 8) & 0xff))));
    const b = Math.min(255, Math.max(0, Math.round(canal(num & 0xff))));
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  private estiloBordeCss(estiloExcel: string, color: string): string {
    const grosor = estiloExcel === 'thick' ? '2.5px' : estiloExcel === 'medium' ? '1.5px' : '1px';
    const tipo = estiloExcel === 'double' ? 'double' : estiloExcel === 'dashed' || estiloExcel === 'dashDot' ? 'dashed' : estiloExcel === 'dotted' || estiloExcel === 'hair' ? 'dotted' : 'solid';
    return `${grosor} ${tipo} ${color}`;
  }

  private estiloDeCelda(celda: Cell): EstiloCeldaExcel {
    const estilo: EstiloCeldaExcel = {};

    const relleno: any = celda.fill;
    if (relleno && relleno.type === 'pattern' && relleno.pattern === 'solid') {
      const color = this.colorArgbACss(relleno.fgColor);
      if (color) estilo.backgroundColor = color;
    }

    const fuente: any = celda.font;
    if (fuente) {
      if (fuente.bold) estilo.bold = true;
      if (fuente.italic) estilo.italic = true;
      if (fuente.underline) estilo.underline = true;
      if (fuente.size) estilo.fontSize = fuente.size;
      const colorFuente = this.colorArgbACss(fuente.color);
      if (colorFuente) estilo.color = colorFuente;
    }

    const alineacion: any = celda.alignment;
    if (alineacion) {
      if (alineacion.horizontal) {
        estilo.align = alineacion.horizontal === 'center' || alineacion.horizontal === 'centerContinuous'
          ? 'center'
          : alineacion.horizontal === 'right'
            ? 'right'
            : 'left';
      }
      if (alineacion.vertical) {
        estilo.valign = alineacion.vertical === 'middle' ? 'middle' : alineacion.vertical === 'bottom' ? 'bottom' : 'top';
      }
    }

    const borde: any = celda.border;
    if (borde) {
      const bordes: EstiloCeldaExcel['bordes'] = {};
      (['top', 'right', 'bottom', 'left'] as const).forEach((lado) => {
        const b = borde[lado];
        if (b && b.style) {
          bordes[lado] = this.estiloBordeCss(b.style, this.colorArgbACss(b.color) || '#94a3b8');
        }
      });
      if (Object.keys(bordes).length) estilo.bordes = bordes;
    }

    return estilo;
  }

  // Convierte bytes crudos (Uint8Array/ArrayBuffer, lo que devuelva ExcelJS
  // para una imagen incrustada) a base64 -- se arma el data: URL a mano
  // porque ExcelJS en navegador no siempre rellena "image.base64".
  private bufferABase64(buffer: any): string {
    const bytes: Uint8Array = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binario = '';
    for (let i = 0; i < bytes.length; i++) binario += String.fromCharCode(bytes[i]);
    return btoa(binario);
  }

  // Posición en píxeles de un "ancla" de imagen de ExcelJS (col/row
  // fraccionarios, 0-based) usando los anchos/altos ya calculados de la hoja.
  private posicionPixelDeAncla(ancla: { col: number; row: number; nativeCol?: number; nativeColOff?: number; nativeRow?: number; nativeRowOff?: number }, anchoColumnas: number[], altoFilas: number[]): { x: number; y: number } {
    // ExcelJS también expone .col/.row (fracción de columna/fila) en cada
    // esquina de una imagen, pero su cálculo interno mezcla EMU
    // (nativeColOff/nativeRowOff) con un pseudo-valor "caracteres x 10000"
    // (colWidth/rowHeight) -- unidades incompatibles que, en cuanto el
    // desplazamiento real supera ese denominador (algo común en cualquier
    // imagen de tamaño normal), se saturan a ~1.0 tanto para la esquina
    // superior izquierda como para la inferior derecha, colapsando el
    // ancho/alto calculado a casi cero (la imagen "desaparece"). Por eso se
    // usan los valores nativos (EMU crudos, iguales a los que trae el XML)
    // con la misma fórmula que ya se usa para las formas -- ver
    // posicionPixelDesdeAncla().
    if (ancla.nativeCol !== undefined && ancla.nativeColOff !== undefined) {
      return this.posicionPixelDesdeAncla(
        ancla.nativeCol,
        ancla.nativeColOff,
        ancla.nativeRow ?? 0,
        ancla.nativeRowOff ?? 0,
        anchoColumnas,
        altoFilas
      );
    }

    // Respaldo (no debería pasar en la práctica): si por algún motivo faltan
    // los campos nativos, se usa la fracción col/row de ExcelJS aunque su
    // cálculo pueda saturarse como se explicó arriba.
    const colEntera = Math.floor(ancla.col);
    const colFraccion = ancla.col - colEntera;
    let x = 0;
    for (let i = 0; i < colEntera; i++) x += anchoColumnas[i] ?? 64;
    x += colFraccion * (anchoColumnas[colEntera] ?? 64);

    const filaEntera = Math.floor(ancla.row);
    const filaFraccion = ancla.row - filaEntera;
    let y = 0;
    for (let i = 0; i < filaEntera; i++) y += altoFilas[i] ?? 20;
    y += filaFraccion * (altoFilas[filaEntera] ?? 20);

    return { x, y };
  }

  // Extrae las imágenes incrustadas de la hoja (ej. el logo del banco en la
  // Portada) y calcula su posición/tamaño aproximados en píxeles a partir de
  // su ancla (rango de celdas que cubren). ExcelJS solo puede leer imágenes
  // insertadas como "Imagen" (xdr:pic) -- si la hoja trae un diagrama hecho
  // con formas/conectores dibujados a mano en Excel (xdr:sp/xdr:cxnSp,
  // ej. un flowchart), esos NO se leen aquí (ver detectarFormasPorHoja(),
  // que analiza el .xlsx aparte como ZIP para detectar ese caso).
  private extraerImagenesHoja(libro: Workbook, hoja: Worksheet, anchoColumnas: number[], altoFilas: number[]): { imagenes: ImagenHojaExcel[]; ultimaColumnaImagen: number; ultimaFilaImagen: number } {
    const imagenes: ImagenHojaExcel[] = [];
    let ultimaColumnaImagen = -1;
    let ultimaFilaImagen = -1;
    let listaImagenes: Array<{ imageId: string; range: any }> = [];
    try {
      listaImagenes = hoja.getImages() as any;
    } catch {
      return { imagenes, ultimaColumnaImagen, ultimaFilaImagen };
    }

    listaImagenes.forEach((item) => {
      // Se registra el rango de la imagen aunque más abajo falle su
      // extracción (dataUrl) -- el espacio que ocupa igual debe respetarse
      // al recortar filas/columnas vacías. Se usa indiceDesdePixel() sobre
      // la posición ya corregida (ver FIX en posicionPixelDeAncla) en vez
      // del getter .col/.row de ExcelJS, que puede saturarse y subestimar
      // dónde termina la imagen.
      const posFin = this.posicionPixelDeAncla(item.range.br, anchoColumnas, altoFilas);
      const colHastaImagen = this.indiceDesdePixel(posFin.x, anchoColumnas, 64);
      const filaHastaImagen = this.indiceDesdePixel(posFin.y, altoFilas, 20);
      if (colHastaImagen > ultimaColumnaImagen) ultimaColumnaImagen = colHastaImagen;
      if (filaHastaImagen > ultimaFilaImagen) ultimaFilaImagen = filaHastaImagen;
      try {
        const imagen: any = libro.getImage(Number(item.imageId));
        if (!imagen) return;

        let dataUrl: string;
        if (imagen.base64) {
          dataUrl = imagen.base64.startsWith('data:') ? imagen.base64 : `data:image/${imagen.extension};base64,${imagen.base64}`;
        } else if (imagen.buffer) {
          dataUrl = `data:image/${imagen.extension};base64,${this.bufferABase64(imagen.buffer)}`;
        } else {
          return;
        }

        const posInicio = this.posicionPixelDeAncla(item.range.tl, anchoColumnas, altoFilas);

        imagenes.push({
          dataUrl,
          left: posInicio.x,
          top: posInicio.y,
          width: Math.max(1, Math.round(posFin.x - posInicio.x)),
          height: Math.max(1, Math.round(posFin.y - posInicio.y))
        });
      } catch (e) {
        console.error('No se pudo posicionar una imagen incrustada del Excel', e);
      }
    });

    return { imagenes, ultimaColumnaImagen, ultimaFilaImagen };
  }

  // Convierte EMU (unidad de medida de OOXML) a píxeles -- 914400 EMU = 1
  // pulgada = 96px (dpi estándar de pantalla), o de forma equivalente 9525
  // EMU = 1px.
  private emuAPixeles(emu: number): number {
    return Math.round(emu / 9525);
  }

  // Busca el primer hijo DIRECTO (no cualquier descendiente) con ese nombre
  // de etiqueta -- necesario porque, por ejemplo, tanto la forma como su
  // borde (a:ln) pueden traer su propio a:solidFill, y hay que distinguir
  // cuál es cuál sin usar getElementsByTagName (que trae todos los niveles).
  private primerHijoDirecto(nodo: Element, nombreEtiqueta: string): Element | null {
    for (let i = 0; i < nodo.children.length; i++) {
      if (nodo.children[i].tagName === nombreEtiqueta) return nodo.children[i];
    }
    return null;
  }

  // Color (formato "#RRGGBB") a partir de un nodo a:solidFill/a:noFill --
  // soporta color directo (a:srgbClr) y color de tema (a:schemeClr, ver
  // TEMA_COLORES_APROXIMADOS). Devuelve undefined si no hay relleno (a:noFill
  // o el nodo no trae ninguno de los dos).
  private colorDesdeFill(fillNode: Element | null): string | undefined {
    if (!fillNode || fillNode.tagName === 'a:noFill') return undefined;
    const srgb = this.primerHijoDirecto(fillNode, 'a:srgbClr');
    if (srgb) return '#' + (srgb.getAttribute('val') || '000000');
    const scheme = this.primerHijoDirecto(fillNode, 'a:schemeClr');
    if (scheme) {
      const val = scheme.getAttribute('val') || '';
      return '#' + (this.TEMA_COLORES_APROXIMADOS[val] || 'CBD5E1');
    }
    return undefined;
  }

  // Posición en píxeles de un ancla cruda del XML del dibujo (índice de
  // columna/fila 0-based + desplazamiento en EMU dentro de esa celda) --
  // misma idea que posicionPixelDeAncla() pero para este XML, donde el
  // desplazamiento viene en EMU en vez de fracción de celda.
  private posicionPixelDesdeAncla(colIdx: number, colOffEmu: number, filaIdx: number, rowOffEmu: number, anchoColumnas: number[], altoFilas: number[]): { x: number; y: number } {
    let x = 0;
    for (let i = 0; i < colIdx; i++) x += anchoColumnas[i] ?? 64;
    x += this.emuAPixeles(colOffEmu);

    let y = 0;
    for (let i = 0; i < filaIdx; i++) y += altoFilas[i] ?? 20;
    y += this.emuAPixeles(rowOffEmu);

    return { x, y };
  }

  // Índice de columna/fila (0-based) donde cae una posición en píxeles --
  // usado para saber cuánto ocupa una forma en términos de celdas, igual que
  // se hace con las imágenes, para no recortarla al limpiar filas/columnas
  // vacías (ver recortarAlContenidoUtil()).
  private indiceDesdePixel(pixel: number, medidas: number[], porDefecto: number): number {
    // Sigue sumando más allá del arreglo conocido (con el tamaño por
    // defecto) en vez de detenerse en su último índice real -- una imagen o
    // forma puede anclarse con un desplazamiento mayor que las columnas/
    // filas realmente declaradas en la hoja (ver nota arriba).
    const LIMITE_INDICES_EXTRA = 4000; // salvaguarda contra offsets absurdos/corruptos
    const totalIndices = Math.max(medidas.length, LIMITE_INDICES_EXTRA);
    let acumulado = 0;
    for (let i = 0; i < totalIndices; i++) {
      acumulado += medidas[i] ?? porDefecto;
      if (acumulado >= pixel) return i;
    }
    return totalIndices - 1;
  }

  private leerAnclaXY(nodo: Element, anchoColumnas: number[], altoFilas: number[]): { x: number; y: number } {
    const col = parseInt(nodo.getElementsByTagName('xdr:col')[0]?.textContent || '0', 10);
    const colOff = parseInt(nodo.getElementsByTagName('xdr:colOff')[0]?.textContent || '0', 10);
    const fila = parseInt(nodo.getElementsByTagName('xdr:row')[0]?.textContent || '0', 10);
    const rowOff = parseInt(nodo.getElementsByTagName('xdr:rowOff')[0]?.textContent || '0', 10);
    return this.posicionPixelDesdeAncla(col, colOff, fila, rowOff, anchoColumnas, altoFilas);
  }

  // Lee la posición/tamaño (a:off/a:ext, en unidades EMU-locales) de un
  // a:xfrm -- usado tanto para la posición de una forma DENTRO de un grupo
  // (relativa al espacio de coordenadas del grupo) como para el chOff/chExt
  // del propio grupo (ver leerChOffExt()).
  private leerXfrmOffExt(xfrm: Element | null): { offX: number; offY: number; extX: number; extY: number } {
    const off = xfrm ? this.primerHijoDirecto(xfrm, 'a:off') : null;
    const ext = xfrm ? this.primerHijoDirecto(xfrm, 'a:ext') : null;
    return {
      offX: off ? parseInt(off.getAttribute('x') || '0', 10) : 0,
      offY: off ? parseInt(off.getAttribute('y') || '0', 10) : 0,
      extX: ext ? parseInt(ext.getAttribute('cx') || '0', 10) : 0,
      extY: ext ? parseInt(ext.getAttribute('cy') || '0', 10) : 0
    };
  }

  // a:chOff/a:chExt de un grupo (xdr:grpSpPr > a:xfrm) -- define el espacio
  // de coordenadas "lógico" en el que están expresadas las posiciones de sus
  // hijos directos (no necesariamente en EMU reales, así que hay que
  // reescalarlo contra el recuadro en píxeles que sí conocemos por el ancla).
  private leerChOffExt(xfrm: Element | null): { offX: number; offY: number; extX: number; extY: number } {
    const chOff = xfrm ? this.primerHijoDirecto(xfrm, 'a:chOff') : null;
    const chExt = xfrm ? this.primerHijoDirecto(xfrm, 'a:chExt') : null;
    return {
      offX: chOff ? parseInt(chOff.getAttribute('x') || '0', 10) : 0,
      offY: chOff ? parseInt(chOff.getAttribute('y') || '0', 10) : 0,
      extX: chExt ? (parseInt(chExt.getAttribute('cx') || '0', 10) || 1) : 1,
      extY: chExt ? (parseInt(chExt.getAttribute('cy') || '0', 10) || 1) : 1
    };
  }

  // Procesa un nodo de dibujo (xdr:sp / xdr:cxnSp / xdr:grpSp / xdr:pic /
  // xdr:graphicFrame) ya posicionado en píxeles (cajaPx) -- si es un grupo
  // (xdr:grpSp), estos diagramas de flujo casi siempre agrupan sus formas
  // para poder moverlas juntas, así que hay que RECORRER sus hijos: cada uno
  // trae su posición en el "espacio de coordenadas hijo" del grupo
  // (a:xfrm/a:off + a:ext, relativo a chOff/chExt del grupo), que se reescala
  // linealmente contra cajaPx (el recuadro real en píxeles que ya conocemos
  // por el ancla o por el grupo padre) para ubicar cada hijo -- funciona de
  // igual manera con grupos anidados dentro de grupos.
  private procesarNodoDibujo(nodo: Element, cajaPx: { left: number; top: number; width: number; height: number }, formas: FormaHojaExcel[], conectores: ConectorHojaExcel[], marcarNoSoportado: () => void): void {
    if (nodo.tagName === 'xdr:pic') {
      // Una imagen anidada DENTRO de un grupo no la lee ExcelJS (su
      // getImages() solo ve anclas de primer nivel) -- se avisa que falta
      // algo, pero no se bloquea el resto del diagrama.
      marcarNoSoportado();
      return;
    }

    if (nodo.tagName === 'xdr:graphicFrame') {
      marcarNoSoportado(); // gráfico/SmartArt incrustado -- fuera de alcance
      return;
    }

    if (nodo.tagName === 'xdr:grpSp') {
      const grpSpPr = nodo.getElementsByTagName('xdr:grpSpPr')[0] || null;
      const xfrmGrupo = grpSpPr ? this.primerHijoDirecto(grpSpPr, 'a:xfrm') : null;
      const ch = this.leerChOffExt(xfrmGrupo);
      const escalaX = cajaPx.width / ch.extX;
      const escalaY = cajaPx.height / ch.extY;

      for (let i = 0; i < nodo.children.length; i++) {
        const hijo = nodo.children[i];
        if (hijo.tagName !== 'xdr:sp' && hijo.tagName !== 'xdr:cxnSp' && hijo.tagName !== 'xdr:grpSp' && hijo.tagName !== 'xdr:pic' && hijo.tagName !== 'xdr:graphicFrame') continue;

        const spPrHijo = hijo.tagName === 'xdr:grpSp'
          ? hijo.getElementsByTagName('xdr:grpSpPr')[0]
          : hijo.getElementsByTagName('xdr:spPr')[0];
        const xfrmHijo = spPrHijo ? this.primerHijoDirecto(spPrHijo, 'a:xfrm') : null;
        const posHijo = this.leerXfrmOffExt(xfrmHijo);

        const cajaHijoPx = {
          left: cajaPx.left + (posHijo.offX - ch.offX) * escalaX,
          top: cajaPx.top + (posHijo.offY - ch.offY) * escalaY,
          width: Math.max(1, posHijo.extX * escalaX),
          height: Math.max(1, posHijo.extY * escalaY)
        };

        this.procesarNodoDibujo(hijo, cajaHijoPx, formas, conectores, marcarNoSoportado);
      }
      return;
    }

    // A partir de aquí, nodo es xdr:sp o xdr:cxnSp -- la posición/tamaño ya
    // viene resuelta en cajaPx (del ancla si es de primer nivel, o del
    // grupo padre si está anidado); del propio a:xfrm de la forma solo
    // interesan flipH/flipV/rot (nunca su off/ext, que para una forma de
    // primer nivel no define su posición -- eso lo hace el ancla).
    const spPr = nodo.getElementsByTagName('xdr:spPr')[0] || null;
    const xfrm = spPr ? this.primerHijoDirecto(spPr, 'a:xfrm') : null;
    const flipH = xfrm?.getAttribute('flipH') === '1';
    const flipV = xfrm?.getAttribute('flipV') === '1';
    const rotRaw = xfrm?.getAttribute('rot');
    const rotacion = rotRaw ? Math.round(parseInt(rotRaw, 10) / 60000) : 0;
    const geom = spPr?.getElementsByTagName('a:prstGeom')[0];
    const prst = geom?.getAttribute('prst') || '';

    const fillNode = spPr ? (this.primerHijoDirecto(spPr, 'a:solidFill') || this.primerHijoDirecto(spPr, 'a:noFill')) : null;
    const esConector = nodo.tagName === 'xdr:cxnSp';
    const relleno = this.colorDesdeFill(fillNode) ?? (esConector ? 'transparent' : '#eef2f7');

    const lnNode = spPr ? this.primerHijoDirecto(spPr, 'a:ln') : null;
    const lnFillNode = lnNode ? (this.primerHijoDirecto(lnNode, 'a:solidFill') || this.primerHijoDirecto(lnNode, 'a:noFill')) : null;
    const colorTrazo = this.colorDesdeFill(lnFillNode) ?? (esConector ? '#64748b' : '#94a3b8');
    const anchoTrazoEmu = lnNode?.getAttribute('w');
    const anchoTrazo = anchoTrazoEmu ? Math.max(1, this.emuAPixeles(parseInt(anchoTrazoEmu, 10))) : (esConector ? 2 : 1);
    const dashNode = lnNode ? this.primerHijoDirecto(lnNode, 'a:prstDash') : null;
    const strokeDashed = !!dashNode && (dashNode.getAttribute('val') || 'solid') !== 'solid';

    const { left, top, width, height } = cajaPx;

    if (esConector) {
      const tailEnd = lnNode ? this.primerHijoDirecto(lnNode, 'a:tailEnd') : null;
      const headEnd = lnNode ? this.primerHijoDirecto(lnNode, 'a:headEnd') : null;
      const tieneFlechaFinal = !tailEnd || (tailEnd.getAttribute('type') || 'none') !== 'none';
      const tieneFlechaInicial = !!headEnd && (headEnd.getAttribute('type') || 'none') !== 'none';
      let x1 = 0;
      let y1 = 0;
      let x2 = width;
      let y2 = height;
      if (flipH) { x1 = width; x2 = 0; }
      if (flipV) { y1 = height; y2 = 0; }
      conectores.push({
        left, top, width, height,
        x1, y1, x2, y2,
        strokeColor: colorTrazo,
        strokeWidth: anchoTrazo,
        conFlecha: tieneFlechaFinal || tieneFlechaInicial
      });
    } else {
      const esOvalo = /ellipse|circle|flowChartConnector/i.test(prst);
      const redondeada = /round|flowChartTerminal|flowChartAlternateProcess/i.test(prst);
      let texto = '';
      const txBody = nodo.getElementsByTagName('xdr:txBody')[0];
      if (txBody) {
        const parrafos = Array.from(txBody.getElementsByTagName('a:p')).map((p) =>
          Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent || '').join('')
        );
        texto = parrafos.join('\n').trim();
      }
      formas.push({
        tipo: esOvalo ? 'ellipse' : 'rect',
        left, top, width, height,
        fill: relleno,
        strokeColor: colorTrazo,
        strokeWidth: anchoTrazo,
        strokeDashed,
        texto,
        rounded: redondeada,
        rotacion
      });
    }
  }

  // Lee las formas (rectángulos, óvalos, etc.) y conectores (flechas/líneas)
  // dibujados a mano en una hoja a partir del XML crudo de su dibujo
  // (xl/drawings/drawingN.xml, ver obtenerDrawingXmlPorHoja()) -- ExcelJS no
  // expone esto en absoluto (ver nota en obtenerDrawingXmlPorHoja()). Es una
  // aproximación visual (colores de tema aproximados, un conector se dibuja
  // como una línea recta entre esquinas opuestas de su recuadro) -- suficiente
  // para reconocer la forma del diagrama, no una reproducción exacta de
  // Excel. Los diagramas de flujo casi siempre agrupan sus formas (xdr:grpSp)
  // para poder moverlas juntas, así que se recorren recursivamente (ver
  // procesarNodoDibujo()); solo un gráfico/SmartArt incrustado
  // (a:graphicFrame), o una imagen anidada dentro de un grupo, quedan sin
  // reconstruir -- ahí sí se marca huboNoSoportado para mostrar el aviso.
  private extraerFormasHoja(drawingXml: string, anchoColumnas: number[], altoFilas: number[]): { formas: FormaHojaExcel[]; conectores: ConectorHojaExcel[]; ultimaColumnaForma: number; ultimaFilaForma: number; huboNoSoportado: boolean } {
    const formas: FormaHojaExcel[] = [];
    const conectores: ConectorHojaExcel[] = [];
    let ultimaColumnaForma = -1;
    let ultimaFilaForma = -1;
    let huboNoSoportado = false;

    const registrarLimite = (x2: number, y2: number) => {
      const col = this.indiceDesdePixel(x2, anchoColumnas, 64);
      const fila = this.indiceDesdePixel(y2, altoFilas, 20);
      if (col > ultimaColumnaForma) ultimaColumnaForma = col;
      if (fila > ultimaFilaForma) ultimaFilaForma = fila;
    };

    try {
      const doc = new DOMParser().parseFromString(drawingXml, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) {
        return { formas, conectores, ultimaColumnaForma, ultimaFilaForma, huboNoSoportado };
      }

      const anclas: Element[] = [
        ...Array.from(doc.getElementsByTagName('xdr:twoCellAnchor')),
        ...Array.from(doc.getElementsByTagName('xdr:oneCellAnchor'))
      ];

      anclas.forEach((ancla) => {
        const fromNode = ancla.getElementsByTagName('xdr:from')[0];
        if (!fromNode) return;
        const inicio = this.leerAnclaXY(fromNode, anchoColumnas, altoFilas);

        let fin: { x: number; y: number };
        const toNode = ancla.getElementsByTagName('xdr:to')[0];
        if (toNode) {
          fin = this.leerAnclaXY(toNode, anchoColumnas, altoFilas);
        } else {
          const extNode = ancla.getElementsByTagName('xdr:ext')[0];
          const cx = parseInt(extNode?.getAttribute('cx') || '0', 10);
          const cy = parseInt(extNode?.getAttribute('cy') || '0', 10);
          fin = { x: inicio.x + this.emuAPixeles(cx), y: inicio.y + this.emuAPixeles(cy) };
        }

        const left = Math.min(inicio.x, fin.x);
        const top = Math.min(inicio.y, fin.y);
        const width = Math.max(1, Math.abs(fin.x - inicio.x));
        const height = Math.max(1, Math.abs(fin.y - inicio.y));

        // El primer hijo "de contenido" del ancla (después de from/to/ext)
        // dice qué clase de objeto es -- xdr:pic de PRIMER NIVEL ya se lee
        // aparte con ExcelJS (extraerImagenesHoja), así que aquí se ignora
        // para no duplicarlo (una imagen anidada DENTRO de un grupo sí se
        // marca como no soportada, ver procesarNodoDibujo()).
        let nodoContenido: Element | null = null;
        for (let i = 0; i < ancla.children.length; i++) {
          const tag = ancla.children[i].tagName;
          if (tag === 'xdr:sp' || tag === 'xdr:cxnSp' || tag === 'xdr:pic' || tag === 'xdr:grpSp' || tag === 'xdr:graphicFrame') {
            nodoContenido = ancla.children[i];
            break;
          }
        }
        if (!nodoContenido) return;

        if (nodoContenido.tagName === 'xdr:pic') return; // ya se lee vía ExcelJS

        this.procesarNodoDibujo(nodoContenido, { left, top, width, height }, formas, conectores, () => { huboNoSoportado = true; });
        registrarLimite(fin.x, fin.y);
      });
    } catch (e) {
      console.error('No se pudieron leer las formas del dibujo de la hoja', e);
    }

    return { formas, conectores, ultimaColumnaForma, ultimaFilaForma, huboNoSoportado };
  }

  private mimePorExtension(extension: string): string {
    const mapa: Record<string, string> = {
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
      '.xls': 'application/vnd.ms-excel',
      '.csv': 'text/csv',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
    };
    return mapa[extension] || 'application/octet-stream';
  }

  seleccionarHoja(indice: number): void {
    this.visorHojaActivaIndice = indice;
  }

  get hojaActiva(): HojaExcel | null {
    return this.visorHojas[this.visorHojaActivaIndice] || null;
  }

  get hojaRicaActiva(): HojaExcelRica | null {
    return this.visorHojasRicas[this.visorHojaActivaIndice] || null;
  }

  // Unifica visorHojas/visorHojasRicas en un solo tipo para el *ngFor de las
  // pestañas de hojas -- evita que Angular tenga que inferir un tipo unión
  // (HojaExcelRica[] | HojaExcel[]) en la plantilla, que falla la
  // verificación estricta de tipos de NgFor (error NG2).
  get hojasParaPestanas(): Array<{ nombre: string }> {
    return this.usaEstiloRico ? this.visorHojasRicas : this.visorHojas;
  }

  descargarArchivoActual(): void {
    if (!this.visorBlobParaDescarga) return;
    const url = URL.createObjectURL(this.visorBlobParaDescarga);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = this.visorNombreArchivo || 'archivo';
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);
  }

  private liberarUrlObjeto(): void {
    if (this.visorUrlObjeto) {
      URL.revokeObjectURL(this.visorUrlObjeto);
    }
    this.visorUrlObjeto = null;
    this.visorUrlSegura = null;
  }

  cerrarVisor(): void {
    this.visorAbierto = false;
    this.liberarUrlObjeto();
    this.visorBlobParaDescarga = null;
  }
}
