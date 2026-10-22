import { Component, DoCheck, EventEmitter, HostListener, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Observable, of } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { AceServiciosService, CertificadoConsumo, PeticionAGuardar, PeticionConsumo, PeticionGuardada, ResultadoGuardarPeticiones, RespuestaConsumo } from '../../core/services/ace-servicios.service';
import { ItemExportable, construirColeccionPostman, descargarJson, nombreSeguroArchivo } from '../../core/utils/exportar-postman';
import { Interpretacion, SeccionLegible, filtrarTecnicos, interpretarRespuesta, resumenATexto } from '../../core/utils/interpretar-respuesta';
import { resaltarCodigo } from '../../core/utils/resaltar-codigo';
import { AuthService } from '../../services/auth.service';
import { importarWsdl } from '../../core/utils/wsdl-importador';
import { AceServicioInventario, ArchivoServicio } from '../../core/models/models';
import {
  AutorizacionImportada, OrigenImportacion, ParClaveValor, SolicitudImportada, detectarVariables, formatearCuerpo, importarArchivoDeConsumo, importarCurl,
} from '../../core/utils/consumo-importadores';

interface Destino {
  id: string;
  etiqueta: string;
  ambiente: 'DEV' | 'QA' | 'PRD';
  bus: string;
  url: string;
}

interface OpcionUrl {
  url: string;
  ambiente: 'DEV' | 'QA' | 'PRD' | 'ARCHIVO';
  bus: string;
}

type PestanaPeticion = 'cuerpo' | 'params' | 'cabeceras' | 'auth' | 'variables' | 'opciones';
type PestanaRespuesta = 'resumen' | 'cuerpo' | 'cabeceras';

/** Por encima de este tamaño no se colorea (para no frenar el navegador con respuestas enormes). */
const MAX_RESALTADO = 300_000;

const METODOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Id del «servicio» virtual de la prueba libre (URL externa o servicio de un tercero, fuera del inventario). */
const ID_LIBRE = 0;
const CABECERAS_SECRETAS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'apikey']);
const MAX_LIBRES = 300;

function claveHost(texto: string): string | null {
  try {
    const u = new URL(texto.trim());
    const puerto = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname.toLowerCase()}:${puerto}`;
  } catch { return null; }
}

@Component({
  selector: 'app-probar-servicio',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './probar-servicio.component.html',
  styleUrl: './probar-servicio.component.scss',
})
export class ProbarServicioComponent implements OnInit, DoCheck {
  /** Todos los servicios del inventario: de aquí se elige cuál consumir. */
  @Input() servicios: AceServicioInventario[] = [];
  /** Servicio con el que se abre la consola (si se abrió desde su detalle o su fila). */
  @Input() servicioInicial: AceServicioInventario | null = null;
  /** Con qué tipo de servicios se abre el selector (la lista de Servicios lo manda según su pestaña SOAP/REST). */
  @Input() tipoInicial: 'SOAP' | 'REST' | 'todos' = 'todos';
  @Output() cerrar = new EventEmitter<void>();

  /** Servicio elegido. Solo se usa cuando haySeleccion es true. */
  servicio!: AceServicioInventario;
  haySeleccion = false;
  eligiendo = false;

  // ---- selector de servicio ----
  busqueda = '';
  /** SOAP y REST se trabajan por separado: el modo decide qué servicios se ofrecen y cómo se ve el editor. */
  modo: 'SOAP' | 'REST' = 'SOAP';
  soloConPeticiones = false;
  get esLibre(): boolean { return this.haySeleccion && this.servicio.Id === ID_LIBRE; }
  /** La prueba libre necesita permiso de edición (el backend también lo exige). */
  get libreDisponible(): boolean { return this.puedeEditar; }
  get iconoModo(): string { return this.modo === 'REST' ? '{ }' : '</>'; }
  listaServicios: AceServicioInventario[] = [];
  totalCoincidencias = 0;
  readonly maxFilasSelector = 150;

  // ---- lo que el servicio tiene guardado ----
  archivos: ArchivoServicio[] = [];
  archivosDisponibles = true;
  archivosMensaje = '';
  cargandoArchivosServicio = false;

  readonly metodos = METODOS;
  destinos: Destino[] = [];

  // ---- petición en edición ----
  metodo = 'POST';
  url = '';
  cabeceras: ParClaveValor[] = [];
  cuerpo = '';
  auth: AutorizacionImportada = { tipo: 'ninguna' };
  variables: ParClaveValor[] = [];
  timeoutSegundos = 30;
  /** Como SoapUI/Postman: por defecto se confía en el certificado del servidor; se puede activar la validación. */
  verificarTls = false;
  pestana: PestanaPeticion = 'cuerpo';
  nombreSolicitud = '';

  // ---- lista de URLs del campo ----
  listaUrlsAbierta = false;
  dialogoImportar = false;
  /** URLs que traen el WSDL o el archivo cargado. */
  urlsArchivo: OpcionUrl[] = [];
  gruposUrls: { titulo: string; items: OpcionUrl[] }[] = [];

  // ---- peticiones disponibles para cargar ----
  solicitudes: SolicitudImportada[] = [];
  archivoCargado: ArchivoServicio | null = null;
  origenCargado = '';
  cargandoArchivo: number | null = null;
  errorImportacion = '';
  avisosImportacion: string[] = [];
  filtro = '';

  // ---- envío y respuesta ----
  enviando = false;
  pidiendoConfirmacion = false;
  errorEnvio = '';
  respuesta: RespuestaConsumo | null = null;
  cuerpoFormateado = '';
  tipoCuerpoRespuesta: 'JSON' | 'XML' | 'TEXTO' = 'TEXTO';
  verFormateado = true;
  pestanaRespuesta: PestanaRespuesta = 'cuerpo';
  copiado = false;
  // Resumen para personas no técnicas + colores del cuerpo
  interpretacion: Interpretacion | null = null;
  vistaResumen: SeccionLegible | null = null;
  mostrarTecnicos = false;
  resumenCopiado = false;
  private htmlFormateado: string | null = null;
  private htmlCrudo: string | null = null;
  private memoPeticion = { texto: '\u0000', html: '' };

  // ---- peticiones guardadas del servicio ----
  guardadas: PeticionGuardada[] = [];
  guardadasDisponibles = true;
  guardadasMensaje = '';
  cargandoGuardadas = false;
  /** Petición guardada que está cargada en el editor (para «Actualizar»). */
  peticionActual: PeticionGuardada | null = null;
  avisoGuardado = '';
  private avisoGuardadoTimer: ReturnType<typeof setTimeout> | null = null;
  dialogoGuardar = false;
  guardarNombre = '';
  guardarConUrl = false;
  guardarError = '';
  guardandoPeticion = false;

  // ---- exportar a Postman ----
  dialogoExportar = false;
  exportNombre = '';
  exportUrlId = '';
  exportGrupos: { titulo: string; items: { nombre: string; marcado: boolean; dato: ItemExportable }[] }[] = [];

  // ---- fuentes de peticiones ----
  fuente: '' | 'archivos' | 'wsdl' | 'curl' = '';
  curlTexto = '';
  avisoFormato = '';

  // ---- WSDL ----
  wsdlUrl = '';
  leyendoWsdl = false;

  // ---- certificados ----
  puedeEditar = false;
  /** Guardar peticiones y cargar certificados es propio de cada usuario: también lo puede hacer el rol Consulta (queda auditado). */
  readonly puedeGuardarPropios = true;
  certificados: CertificadoConsumo[] = [];
  certificadosDisponibles = true;
  certificadosMensaje = '';
  certificadoId: number | null = null;
  panelCertificados = false;
  certNombre = '';
  certClave = '';
  certArchivos: { nombreOriginal: string; contenidoBase64: string }[] = [];
  guardandoCert = false;
  errorCert = '';
  avisoCert = '';
  arrastrando = false;
  private certAutoAplicado = false;
  private avisoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private aceServiciosService: AceServiciosService, private authService: AuthService) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('SERVICIOS');
    this.cargarCertificados();
    this.modo = this.servicioInicial ? (this.servicioInicial.Tipo === 'REST' ? 'REST' : 'SOAP') : (this.tipoInicial === 'REST' ? 'REST' : 'SOAP');
    this.recalcularServicios();
    if (this.servicioInicial) this.seleccionar(this.servicioInicial);
    else this.eligiendo = true;
  }

  // ---------------------------------------------------------------- selector de servicio
  get cantidades(): { todos: number; peticiones: number; SOAP: number; REST: number } {
    const l = this.servicios;
    const delModo = l.filter((x) => (this.modo === 'REST') === (x.Tipo === 'REST'));
    return {
      todos: delModo.length,
      peticiones: delModo.filter((x) => this.numPeticiones(x) > 0).length,
      SOAP: l.filter((x) => x.Tipo !== 'REST').length,
      REST: l.filter((x) => x.Tipo === 'REST').length,
    };
  }

  /** Filtra el inventario por texto y por lo que tiene guardado. Se guarda en un campo (no en un getter) para no recalcular en cada ciclo. */
  recalcularServicios(): void {
    const q = this.busqueda.trim().toLowerCase();
    const coincide = this.servicios.filter((x) => {
      if ((this.modo === 'REST') !== (x.Tipo === 'REST')) return false;
      if (this.soloConPeticiones && this.numPeticiones(x) === 0) return false;
      return !q || `${x.Codigo} ${x.NombreServicio} ${x.Pod || ''}`.toLowerCase().includes(q);
    });
    this.cantidadLibres = this.leerLibres(this.modo).length;
    this.totalCoincidencias = coincide.length;
    this.listaServicios = coincide.slice(0, this.maxFilasSelector);
  }

  elegirFiltro(soloConPeticiones: boolean): void {
    this.soloConPeticiones = soloConPeticiones;
    this.recalcularServicios();
  }

  /** Cambia entre SOAP y REST: se muestran los servicios del otro tipo y se parte de una pantalla limpia. */
  cambiarModo(m: 'SOAP' | 'REST'): void {
    if (m === this.modo) return;
    this.modo = m;
    this.soloConPeticiones = false;
    this.busqueda = '';
    this.haySeleccion = false;
    this.eligiendo = true;
    this.dialogoGuardar = false;
    this.dialogoExportar = false;
    this.recalcularServicios();
  }

  /** «Servicio» virtual de la prueba libre: no tiene URLs ni archivos; las peticiones se guardan en este navegador. */
  servicioLibre(modo: 'SOAP' | 'REST' = this.modo): AceServicioInventario {
    return {
      Id: ID_LIBRE, Codigo: 'LIBRE', NombreServicio: modo === 'REST' ? 'Prueba libre · API externa' : 'Prueba libre · SOAP externo',
      UrlDev: null, UrlQa: null, UrlPrd: null, RequestEjemplo: null, Pod: null, Tipo: modo, FechaActualizacion: '',
      NumArchivos: 0, NumPeticiones: 0,
    };
  }

  /** Peticiones libres guardadas en este navegador para el modo actual (se calcula al abrir el selector). */
  cantidadLibres = 0;

  abrirLibre(): void {
    this.seleccionar(this.servicioLibre());
  }

  // ---- peticiones de la prueba libre: se guardan en este navegador (no en la base de datos) ----
  private claveLibres(modo: 'SOAP' | 'REST'): string {
    return `axis.consumo.libre.v1.${modo}`;
  }

  private leerLibres(modo: 'SOAP' | 'REST'): PeticionGuardada[] {
    try {
      const lista = JSON.parse(localStorage.getItem(this.claveLibres(modo)) || '[]');
      return Array.isArray(lista) ? lista : [];
    } catch { return []; }
  }

  private escribirLibres(modo: 'SOAP' | 'REST', lista: PeticionGuardada[]): boolean {
    try { localStorage.setItem(this.claveLibres(modo), JSON.stringify(lista)); return true; } catch { return false; }
  }

  private limpiarCabecerasLibres(cabeceras: { nombre: string; valor: string; activo?: boolean }[]): { limpias: { nombre: string; valor: string; activo: boolean }[]; descartadas: string[] } {
    const descartadas: string[] = [];
    const limpias: { nombre: string; valor: string; activo: boolean }[] = [];
    for (const c of cabeceras || []) {
      if (CABECERAS_SECRETAS.has((c.nombre || '').trim().toLowerCase())) { descartadas.push(c.nombre); continue; }
      limpias.push({ nombre: c.nombre, valor: c.valor, activo: c.activo !== false });
    }
    return { limpias, descartadas: [...new Set(descartadas)] };
  }

  private guardarLibres(peticiones: PeticionAGuardar[]): ResultadoGuardarPeticiones {
    const modo = this.modo;
    const actuales = this.leerLibres(modo);
    const resultado: ResultadoGuardarPeticiones = { creadas: [], omitidas: [], cabecerasDescartadas: [] };
    const ahora = new Date().toISOString();
    let siguiente = actuales.reduce((m, p) => Math.max(m, p.Id), 0) + 1;
    for (const p of peticiones) {
      const nombre = (p.nombre || '').trim();
      if (!nombre) { resultado.omitidas.push({ nombre: '', motivo: 'INVALIDA', detalle: 'La petición necesita un nombre.' }); continue; }
      const dup = actuales.find((x) => x.Nombre.toLowerCase() === nombre.toLowerCase());
      if (dup) { resultado.omitidas.push({ nombre, motivo: 'NOMBRE', detalle: `Ya hay una petición llamada «${nombre}».`, existenteId: dup.Id }); continue; }
      if (actuales.length >= MAX_LIBRES) { resultado.omitidas.push({ nombre, motivo: 'LIMITE', detalle: `Máximo ${MAX_LIBRES} peticiones libres guardadas.` }); continue; }
      const { limpias, descartadas } = this.limpiarCabecerasLibres(p.cabeceras);
      resultado.cabecerasDescartadas.push(...descartadas);
      const nueva: PeticionGuardada = {
        Id: siguiente++, ServicioId: ID_LIBRE, Nombre: nombre, Metodo: p.metodo, Url: p.url ? p.url : null,
        Cabeceras: limpias, Cuerpo: p.cuerpo || '', CreadoPorNombre: null, FechaCreacion: ahora, FechaActualizacion: ahora,
      };
      actuales.push(nueva);
      resultado.creadas.push(nueva);
    }
    resultado.cabecerasDescartadas = [...new Set(resultado.cabecerasDescartadas)];
    if (resultado.creadas.length && !this.escribirLibres(modo, actuales)) {
      return { creadas: [], omitidas: resultado.creadas.map((c) => ({ nombre: c.Nombre, motivo: 'INVALIDA' as const, detalle: 'El navegador no permitió guardar (almacenamiento bloqueado o lleno).' })), cabecerasDescartadas: [] };
    }
    return resultado;
  }

  // Los mismos pasos para un servicio del inventario (base de datos) y para la prueba libre (navegador).
  private apiGuardar(peticiones: PeticionAGuardar[]): Observable<ResultadoGuardarPeticiones> {
    return this.esLibre ? of(this.guardarLibres(peticiones)) : this.aceServiciosService.guardarPeticiones(this.servicio.Id, peticiones);
  }

  private apiActualizar(act: PeticionGuardada, datos: PeticionAGuardar): Observable<{ peticion: PeticionGuardada; cabecerasDescartadas: string[] }> {
    if (!this.esLibre) return this.aceServiciosService.actualizarPeticion(this.servicio.Id, act.Id, datos);
    const lista = this.leerLibres(this.modo);
    const otra = lista.find((x) => x.Id !== act.Id && x.Nombre.toLowerCase() === datos.nombre.toLowerCase());
    if (otra) return new Observable((o) => o.error({ error: { error: `Ya hay una petición llamada «${datos.nombre}».` } }));
    const { limpias, descartadas } = this.limpiarCabecerasLibres(datos.cabeceras);
    const nueva: PeticionGuardada = { ...act, Nombre: datos.nombre, Metodo: datos.metodo, Url: datos.url ? datos.url : null, Cabeceras: limpias, Cuerpo: datos.cuerpo || '', FechaActualizacion: new Date().toISOString() };
    const ok = this.escribirLibres(this.modo, lista.map((x) => (x.Id === act.Id ? nueva : x)));
    if (!ok) return new Observable((o) => o.error({ error: { error: 'El navegador no permitió guardar (almacenamiento bloqueado o lleno).' } }));
    return of({ peticion: nueva, cabecerasDescartadas: descartadas });
  }

  private apiEliminar(p: PeticionGuardada): Observable<void> {
    if (!this.esLibre) return this.aceServiciosService.eliminarPeticion(this.servicio.Id, p.Id);
    this.escribirLibres(this.modo, this.leerLibres(this.modo).filter((x) => x.Id !== p.Id));
    return of(undefined);
  }

  abrirSelector(): void {
    this.eligiendo = true;
    this.recalcularServicios();
  }

  /** Peticiones guardadas del servicio (o el único request antiguo, si todavía no se pasó a peticiones). */
  numPeticiones(s: AceServicioInventario): number {
    return s.NumPeticiones || (s.RequestEjemplo ? 1 : 0);
  }

  tipoRequestDe(s: AceServicioInventario): string {
    const t = (s.RequestEjemplo || '').trim();
    return t.startsWith('<') ? 'XML' : t.startsWith('{') || t.startsWith('[') ? 'JSON' : 'TEXTO';
  }

  /** Cambia de servicio: se limpia todo lo que dependía del anterior (petición, variables, archivos leídos y respuesta). */
  seleccionar(s: AceServicioInventario): void {
    this.servicio = s;
    this.modo = s.Tipo === 'REST' ? 'REST' : 'SOAP';
    this.haySeleccion = true;
    this.eligiendo = false;

    const lista: Destino[] = [];
    const agregar = (ambiente: 'DEV' | 'QA' | 'PRD', bus: string, url: string | null | undefined): void => {
      if (url) lista.push({ id: `${bus}-${ambiente}`, etiqueta: `${ambiente} · ${bus}`, ambiente, bus, url });
    };
    agregar('DEV', 'BUS ACE 12', s.UrlDev); agregar('QA', 'BUS ACE 12', s.UrlQa); agregar('PRD', 'BUS ACE 12', s.UrlPrd);
    agregar('DEV', 'BUS 10', s.UrlDevBus10); agregar('QA', 'BUS 10', s.UrlQaBus10); agregar('PRD', 'BUS 10', s.UrlPrdBus10);
    this.destinos = lista;

    this.cabeceras = this.cabecerasPorDefecto();
    this.metodo = s.Tipo === 'REST' ? (s.RequestEjemplo ? 'POST' : 'GET') : 'POST';
    this.cuerpo = s.RequestEjemplo || '';
    this.auth = { tipo: 'ninguna' };
    this.variables = [];
    this.pestana = s.Tipo === 'REST' && this.metodo === 'GET' ? 'params' : 'cuerpo';
    if (s.Id === ID_LIBRE && s.Tipo === 'REST') { this.metodo = 'GET'; this.pestana = 'params'; }
    this.timeoutSegundos = 30;
    this.verificarTls = false;
    // Con una sola URL se usa esa; con varias, se elige de la lista (no se deja ningún ambiente por defecto).
    this.url = lista.length === 1 ? lista[0].url : '';
    this.urlsArchivo = [];
    this.recalcularGruposUrls();
    this.abrirListaUrls(lista.length > 1);
    this.nombreSolicitud = s.RequestEjemplo ? 'Request de ejemplo del servicio' : 'Petición nueva';

    this.solicitudes = [];
    this.grupos = [];
    this.archivoCargado = null;
    this.origenCargado = '';
    this.errorImportacion = '';
    this.avisosImportacion = [];
    this.filtro = '';
    this.respuesta = null;
    this.errorEnvio = '';
    this.ignorarSinResolver = false;
    this.pidiendoConfirmacion = false;
    this.wsdlUrl = s.Tipo === 'REST' ? '' : this.wsdlSugerida();
    this.fuente = '';
    this.curlTexto = '';
    this.avisoFormato = '';
    this.parametros = [];
    this.urlDeParametros = null;
    this.peticionActual = null;
    this.dialogoGuardar = false;
    this.dialogoExportar = false;
    this.avisoGuardado = '';
    this.sincronizarVariables();
    if (s.Id === ID_LIBRE) {
      this.archivos = []; this.archivosDisponibles = true; this.archivosMensaje = ''; this.cargandoArchivosServicio = false;
      this.guardadas = this.leerLibres(this.modo).sort((a, b) => a.Nombre.localeCompare(b.Nombre));
      this.guardadasDisponibles = true; this.guardadasMensaje = ''; this.cargandoGuardadas = false;
      return;
    }
    this.cargarArchivosDelServicio(s);
    this.cargarGuardadas(s);
  }

  private cargarArchivosDelServicio(s: AceServicioInventario): void {
    this.archivos = [];
    this.archivosDisponibles = true;
    this.archivosMensaje = '';
    this.cargandoArchivosServicio = true;
    this.aceServiciosService.listarArchivos(s.Id).subscribe({
      next: (r) => {
        if (!this.haySeleccion || this.servicio.Id !== s.Id) return;
        this.archivos = r.archivos;
        this.archivosDisponibles = r.disponible;
        this.archivosMensaje = r.mensaje || '';
        this.cargandoArchivosServicio = false;
      },
      error: () => {
        if (!this.haySeleccion || this.servicio.Id !== s.Id) return;
        this.cargandoArchivosServicio = false;
        this.archivosMensaje = 'No se pudieron consultar los archivos guardados de este servicio.';
      },
    });
  }

  /** Clases de archivo que la consola sabe leer. */
  esLegible(a: ArchivoServicio): boolean {
    return ['SOAPUI', 'POSTMAN', 'OPENAPI', 'JSON', 'XML', 'WSDL'].includes(a.Clase);
  }

  // ---------------------------------------------------------------- cabeceras por defecto
  private cabecerasPorDefecto(): ParClaveValor[] {
    if (this.servicio.Tipo === 'REST') {
      return [{ nombre: 'Content-Type', valor: 'application/json', activo: true }, { nombre: 'Accept', valor: 'application/json', activo: true }];
    }
    return [{ nombre: 'Content-Type', valor: 'text/xml;charset=UTF-8', activo: true }, { nombre: 'SOAPAction', valor: '""', activo: true }];
  }

  restaurarCabeceras(): void {
    this.cabeceras = this.cabecerasPorDefecto();
  }

  // ---------------------------------------------------------------- destino / producción
  private static readonly TITULOS_AMBIENTE: Record<string, string> = {
    DEV: 'Desarrollo (DEV)', QA: 'Pruebas (QA)', PRD: 'Producción (PRD)', ARCHIVO: 'Del archivo o WSDL cargado',
  };

  /** Agrupa por ambiente las URLs registradas del servicio y las que trae el archivo cargado. */
  recalcularGruposUrls(): void {
    const opciones: OpcionUrl[] = this.destinos.map((d) => ({ url: d.url, ambiente: d.ambiente, bus: d.bus }));
    for (const u of this.urlsArchivo) if (!opciones.some((o) => o.url === u.url)) opciones.push(u);
    this.gruposUrls = (['DEV', 'QA', 'PRD', 'ARCHIVO'] as const)
      .map((amb) => ({ titulo: ProbarServicioComponent.TITULOS_AMBIENTE[amb], items: opciones.filter((o) => o.ambiente === amb) }))
      .filter((g) => g.items.length);
  }

  /** Se abre en el siguiente ciclo para que el clic que la provocó no la cierre (el clic fuera del campo cierra la lista). */
  private abrirListaUrls(abrir: boolean): void {
    if (!abrir) { this.listaUrlsAbierta = false; return; }
    this.recalcularGruposUrls();
    setTimeout(() => { this.listaUrlsAbierta = this.gruposUrls.length > 0; }, 0);
  }

  alternarListaUrls(): void {
    this.recalcularGruposUrls();
    this.listaUrlsAbierta = !this.listaUrlsAbierta;
  }

  abrirListaUrlsSiVacia(): void {
    if (!this.url.trim()) { this.recalcularGruposUrls(); this.listaUrlsAbierta = this.gruposUrls.length > 0; }
  }

  alEscribirUrl(): void {
    this.pidiendoConfirmacion = false;
    this.listaUrlsAbierta = false;
  }

  elegirUrl(o: OpcionUrl): void {
    this.url = o.url;
    this.listaUrlsAbierta = false;
    this.pidiendoConfirmacion = false;
    this.errorEnvio = '';
    this.sincronizarVariables();
  }

  @HostListener('document:click', ['$event'])
  alHacerClicFuera(e: Event): void {
    if (!this.listaUrlsAbierta) return;
    const destino = e.target as HTMLElement | null;
    if (!destino || !destino.closest || !destino.closest('.url-combo')) this.listaUrlsAbierta = false;
  }

  /** Producción si la URL coincide (servidor y puerto) con alguna URL PRD del servicio. */
  get esProduccion(): boolean {
    const clave = claveHost(this.sustituir(this.url));
    if (!clave) return false;
    return this.destinos.some((d) => d.ambiente === 'PRD' && claveHost(d.url) === clave);
  }

  /** Ambiente de la URL escrita: por coincidencia exacta con las URLs registradas y, si no, por servidor y puerto. */
  get ambienteActual(): string {
    const texto = this.url.trim();
    if (!texto) return '';
    const exacta = this.destinos.find((x) => x.url === texto);
    if (exacta) return exacta.ambiente;
    const clave = claveHost(this.sustituir(texto));
    return (clave && this.destinos.find((x) => claveHost(x.url) === clave)?.ambiente) || '';
  }

  // ---------------------------------------------------------------- variables {{nombre}}
  private textosConVariables(): string[] {
    return [
      this.url, this.cuerpo, this.auth.usuario || '', this.auth.clave || '', this.auth.token || '',
      ...this.cabeceras.filter((c) => c.activo).map((c) => `${c.nombre} ${c.valor}`),
    ];
  }

  /** Agrega a la tabla las variables que aparecen en la petición y aún no están definidas. */
  sincronizarVariables(): void {
    for (const nombre of detectarVariables(this.textosConVariables())) {
      if (!this.variables.some((v) => v.nombre === nombre)) this.variables = [...this.variables, { nombre, valor: '', activo: true }];
    }
  }

  /** Valores que se generan al enviar, como en SoapUI (${=java.util.UUID.randomUUID()}) y Postman ({{$guid}}). */
  private expandirDinamicos(texto: string): string {
    const aleatorios = (n: number): number[] => Array.from(crypto.getRandomValues(new Uint8Array(n)));
    const uuid = (): string => {
      const b = aleatorios(16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
    const dos = (n: number): string => String(n).padStart(2, '0');
    const formatear = (f: string): string => {
      const d = new Date();
      return f.replace(/yyyy|MM|dd|HH|mm|ss|SSS/g, (t) => ({
        yyyy: String(d.getFullYear()), MM: dos(d.getMonth() + 1), dd: dos(d.getDate()), HH: dos(d.getHours()),
        mm: dos(d.getMinutes()), ss: dos(d.getSeconds()), SSS: String(d.getMilliseconds()).padStart(3, '0'),
      }[t] as string));
    };
    return texto
      .replace(/\$\{=\s*(?:java\.util\.)?UUID\.randomUUID\(\)(?:\.toString\(\))?\s*;?\s*\}/g, uuid)
      .replace(/\$\{=\s*System\.currentTimeMillis\(\)\s*;?\s*\}/g, () => String(Date.now()))
      .replace(/\$\{=\s*new Date\(\)\.format\(\s*(?:"([^"]*)"|'([^']*)')\s*\)\s*;?\s*\}/g, (_t, a: string, b: string) => formatear(a ?? b))
      .replace(/\{\{\s*\$(?:guid|randomUUID)\s*\}\}/g, uuid)
      .replace(/\{\{\s*\$timestamp\s*\}\}/g, () => String(Math.floor(Date.now() / 1000)))
      .replace(/\{\{\s*\$isoTimestamp\s*\}\}/g, () => new Date().toISOString())
      .replace(/\{\{\s*\$randomInt\s*\}\}/g, () => String(aleatorios(1)[0] * 4));
  }

  private sustituir(texto: string): string {
    return this.expandirDinamicos(texto).replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (todo, nombre: string) => {
      const v = this.variables.find((x) => x.activo && x.nombre === nombre);
      return v ? v.valor : todo;
    });
  }

  /** Variables usadas en la petición que no existen en la tabla o tienen el valor vacío. */
  get variablesSinValor(): string[] {
    return detectarVariables(this.textosConVariables()).filter((nombre) => {
      const v = this.variables.find((x) => x.activo && x.nombre === nombre);
      return !v || v.valor === '';
    });
  }

  agregarVariable(): void {
    this.variables = [...this.variables, { nombre: '', valor: '', activo: true }];
  }

  quitarVariable(i: number): void {
    this.variables = this.variables.filter((_, k) => k !== i);
  }

  agregarCabecera(): void {
    this.cabeceras = [...this.cabeceras, { nombre: '', valor: '', activo: true }];
  }

  quitarCabecera(i: number): void {
    this.cabeceras = this.cabeceras.filter((_, k) => k !== i);
  }

  // ---------------------------------------------------------------- cargar peticiones desde los archivos adjuntos
  usarRequestDelServicio(): void {
    this.metodo = 'POST';
    this.cuerpo = this.servicio.RequestEjemplo || '';
    this.cabeceras = this.cabecerasPorDefecto();
    this.nombreSolicitud = 'Request de ejemplo del servicio';
    this.peticionActual = null;
    this.ignorarSinResolver = false;
    this.sincronizarVariables();
  }

  cargarArchivo(a: ArchivoServicio): void {
    if (this.cargandoArchivo !== null) return;
    this.cargandoArchivo = a.Id;
    this.errorImportacion = '';
    this.avisosImportacion = [];
    this.aceServiciosService.descargarArchivo(a.ServicioId, a.Id).subscribe({
      next: async (blob) => {
        try {
          const r = importarArchivoDeConsumo(a.NombreOriginal, await blob.text());
          if (r.origen === 'OPENAPI') throw new Error('Los archivos Swagger / OpenAPI no se importan aquí.');
          this.solicitudes = r.solicitudes;
          this.archivoCargado = a;
          this.origenCargado = this.etiquetaOrigen(r.origen);
          this.fuente = '';
          this.registrarUrlsDelArchivo(r.solicitudes);
          this.avisosImportacion = r.avisos;
          this.filtro = '';
          this.recalcularGrupos();
          for (const v of r.variables) {
            if (!this.variables.some((x) => x.nombre === v.nombre)) this.variables = [...this.variables, v];
          }
          if (r.solicitudes.length === 1) this.aplicarSolicitud(r.solicitudes[0]);
        } catch (e) {
          this.solicitudes = [];
          this.recalcularGrupos();
          this.archivoCargado = null;
          this.errorImportacion = e instanceof Error ? e.message : 'No se pudo leer el archivo.';
        }
        this.cargandoArchivo = null;
      },
      error: () => {
        this.cargandoArchivo = null;
        this.errorImportacion = 'No se pudo descargar el archivo para leerlo.';
      },
    });
  }

  grupos: { nombre: string; items: SolicitudImportada[] }[] = [];

  /** Agrupa (y filtra) las peticiones importadas. Se guarda en un campo para que la lista no se redibuje en cada ciclo. */
  recalcularGrupos(): void {
    const f = this.filtro.trim().toLowerCase();
    const visibles = f ? this.solicitudes.filter((s) => `${s.nombre} ${s.grupo} ${s.url}`.toLowerCase().includes(f)) : this.solicitudes;
    const mapa = new Map<string, SolicitudImportada[]>();
    for (const s of visibles) mapa.set(s.grupo, [...(mapa.get(s.grupo) || []), s]);
    this.grupos = [...mapa.entries()].map(([nombre, items]) => ({ nombre, items }));
  }

  aplicarSolicitud(s: SolicitudImportada): void {
    this.metodo = s.metodo;
    // Las peticiones generadas desde un WSDL traen la dirección interna del WSDL: no cambian la URL, quedan en la lista de URLs.
    if (!s.urlDelWsdl && s.url) this.url = s.url;
    if (!this.url.trim()) this.abrirListaUrls(true);
    this.cabeceras = s.cabeceras.length ? s.cabeceras.map((c) => ({ ...c })) : this.cabecerasPorDefecto();
    this.cuerpo = s.cuerpo;
    this.auth = { ...s.auth };
    this.nombreSolicitud = s.nombre;
    this.peticionActual = null;
    this.ignorarSinResolver = false;
    this.pidiendoConfirmacion = false;
    this.errorEnvio = '';
    this.sincronizarVariables();
  }

  // ---------------------------------------------------------------- peticiones guardadas
  private cargarGuardadas(s: AceServicioInventario): void {
    this.guardadas = [];
    this.guardadasDisponibles = true;
    this.guardadasMensaje = '';
    this.cargandoGuardadas = true;
    this.aceServiciosService.listarPeticiones(s.Id).subscribe({
      next: (r) => {
        if (!this.haySeleccion || this.servicio.Id !== s.Id) return;
        this.guardadas = r.peticiones;
        this.guardadasDisponibles = r.disponible;
        this.guardadasMensaje = r.mensaje || '';
        this.cargandoGuardadas = false;
      },
      error: () => {
        if (!this.haySeleccion || this.servicio.Id !== s.Id) return;
        this.cargandoGuardadas = false;
        this.guardadasMensaje = 'No se pudieron consultar las peticiones guardadas de este servicio.';
      },
    });
  }

  aplicarGuardada(p: PeticionGuardada): void {
    this.metodo = p.Metodo;
    if (p.Url) this.url = p.Url;
    this.cabeceras = p.Cabeceras.length ? p.Cabeceras.map((c) => ({ nombre: c.nombre, valor: c.valor, activo: c.activo !== false })) : this.cabecerasPorDefecto();
    this.cuerpo = p.Cuerpo;
    this.nombreSolicitud = p.Nombre;
    this.peticionActual = p;
    this.ignorarSinResolver = false;
    this.pidiendoConfirmacion = false;
    this.errorEnvio = '';
    this.dialogoGuardar = false;
    this.sincronizarVariables();
    if (!this.url.trim()) this.abrirListaUrls(true);
  }

  esGuardadaActiva(p: PeticionGuardada): boolean {
    return this.peticionActual?.Id === p.Id;
  }

  /** La petición cargada de un archivo ya está guardada si hay una guardada con el mismo nombre. */
  yaGuardada(s: SolicitudImportada): boolean {
    return this.guardadas.some((g) => g.Nombre.toLowerCase() === s.nombre.toLowerCase());
  }

  private mostrarAvisoGuardado(texto: string): void {
    this.avisoGuardado = texto;
    if (this.avisoGuardadoTimer) clearTimeout(this.avisoGuardadoTimer);
    this.avisoGuardadoTimer = setTimeout(() => { this.avisoGuardado = ''; }, 7000);
  }

  private integrarResultado(r: ResultadoGuardarPeticiones): string {
    this.guardadas = [...this.guardadas, ...r.creadas].sort((a, b) => a.Nombre.localeCompare(b.Nombre));
    const partes: string[] = [];
    if (r.creadas.length) partes.push(r.creadas.length === 1 ? `Guardada «${r.creadas[0].Nombre}».` : `${r.creadas.length} peticiones guardadas.`);
    if (r.omitidas.length) {
      partes.push(r.omitidas.length === 1 ? r.omitidas[0].detalle : `${r.omitidas.length} no se guardaron (ya existían o no eran válidas).`);
    }
    if (r.cabecerasDescartadas.length) partes.push(`No se guarda ${r.cabecerasDescartadas.join(', ')} (las credenciales nunca se guardan).`);
    return partes.join(' ');
  }

  private aGuardar(s: SolicitudImportada): PeticionAGuardar {
    return {
      nombre: s.nombre, metodo: s.metodo, url: s.url && !s.urlDelWsdl ? s.url : null,
      cabeceras: s.cabeceras.map((c) => ({ nombre: c.nombre, valor: c.valor, activo: c.activo })), cuerpo: s.cuerpo,
    };
  }

  /** Guarda solo una de las peticiones cargadas del archivo o WSDL. */
  guardarCargada(s: SolicitudImportada, evento: Event): void {
    evento.stopPropagation();
    if (!this.puedeGuardarPropios || this.yaGuardada(s)) return;
    this.apiGuardar([this.aGuardar(s)]).subscribe({
      next: (r) => this.mostrarAvisoGuardado(this.integrarResultado(r)),
      error: (err) => this.mostrarAvisoGuardado(err?.error?.error || 'No se pudo guardar la petición.'),
    });
  }

  get cargadasSinGuardar(): SolicitudImportada[] {
    return this.solicitudes.filter((s) => !this.yaGuardada(s));
  }

  guardarTodasLasCargadas(): void {
    const lista = this.cargadasSinGuardar;
    if (!this.puedeGuardarPropios || !lista.length) return;
    this.apiGuardar(lista.slice(0, 100).map((s) => this.aGuardar(s))).subscribe({
      next: (r) => this.mostrarAvisoGuardado(this.integrarResultado(r)),
      error: (err) => this.mostrarAvisoGuardado(err?.error?.error || 'No se pudieron guardar las peticiones.'),
    });
  }

  abrirDialogoGuardar(): void {
    if (!this.haySeleccion) return;
    const act = this.peticionActual;
    const generico = /^(Petición nueva|Request de ejemplo del servicio)$/;
    this.guardarNombre = act ? act.Nombre : (generico.test(this.nombreSolicitud) ? '' : this.nombreSolicitud);
    this.guardarConUrl = this.esLibre ? true : act ? !!act.Url : !!this.url.trim() && !this.destinos.some((d) => d.url === this.url.trim());
    this.guardarError = '';
    this.dialogoGuardar = true;
  }

  private cargaActual(): PeticionAGuardar {
    return {
      nombre: this.guardarNombre.trim(), metodo: this.metodo, url: this.guardarConUrl ? this.url.trim() : null,
      cabeceras: this.cabeceras.map((c) => ({ nombre: c.nombre, valor: c.valor, activo: c.activo })), cuerpo: this.cuerpo,
    };
  }

  guardarComoNueva(): void {
    if (this.guardandoPeticion) return;
    this.guardarError = '';
    if (!this.guardarNombre.trim()) { this.guardarError = 'Ponle un nombre a la petición (por ejemplo, el de la operación).'; return; }
    this.guardandoPeticion = true;
    this.apiGuardar([this.cargaActual()]).subscribe({
      next: (r) => {
        this.guardandoPeticion = false;
        if (!r.creadas.length) { this.guardarError = r.omitidas[0]?.detalle || 'No se pudo guardar.'; return; }
        const texto = this.integrarResultado(r);
        this.peticionActual = r.creadas[0];
        this.nombreSolicitud = r.creadas[0].Nombre;
        this.dialogoGuardar = false;
        this.mostrarAvisoGuardado(texto);
      },
      error: (err) => { this.guardandoPeticion = false; this.guardarError = err?.error?.error || 'No se pudo guardar la petición.'; },
    });
  }

  actualizarActual(): void {
    const act = this.peticionActual;
    if (!act || this.guardandoPeticion) return;
    this.guardarError = '';
    if (!this.guardarNombre.trim()) { this.guardarError = 'La petición necesita un nombre.'; return; }
    this.guardandoPeticion = true;
    this.apiActualizar(act, this.cargaActual()).subscribe({
      next: (r) => {
        this.guardandoPeticion = false;
        this.guardadas = this.guardadas.map((g) => (g.Id === r.peticion.Id ? r.peticion : g)).sort((a, b) => a.Nombre.localeCompare(b.Nombre));
        this.peticionActual = r.peticion;
        this.nombreSolicitud = r.peticion.Nombre;
        this.dialogoGuardar = false;
        this.mostrarAvisoGuardado(`Petición «${r.peticion.Nombre}» actualizada.${r.cabecerasDescartadas.length ? ` No se guarda ${r.cabecerasDescartadas.join(', ')}.` : ''}`);
      },
      error: (err) => { this.guardandoPeticion = false; this.guardarError = err?.error?.error || 'No se pudo actualizar la petición.'; },
    });
  }

  eliminarGuardada(p: PeticionGuardada, evento: Event): void {
    evento.stopPropagation();
    if (!confirm(`¿Eliminar la petición guardada «${p.Nombre}»?`)) return;
    this.apiEliminar(p).subscribe({
      next: () => {
        this.guardadas = this.guardadas.filter((g) => g.Id !== p.Id);
        if (this.peticionActual?.Id === p.Id) this.peticionActual = null;
      },
      error: (err) => this.mostrarAvisoGuardado(err?.error?.error || 'No se pudo eliminar la petición.'),
    });
  }

  // ---------------------------------------------------------------- exportar colección de Postman
  abrirExportar(): void {
    if (!this.haySeleccion) return;
    const grupos: typeof this.exportGrupos = [];
    const deGuardada = (p: PeticionGuardada): ItemExportable => ({ nombre: p.Nombre, metodo: p.Metodo, url: p.Url || '', cabeceras: p.Cabeceras, cuerpo: p.Cuerpo });
    if (this.guardadas.length) {
      grupos.push({ titulo: 'Guardadas en el servicio', items: this.guardadas.map((p) => ({ nombre: p.Nombre, marcado: true, dato: deGuardada(p) })) });
    } else if (this.servicio.RequestEjemplo) {
      grupos.push({ titulo: 'Guardadas en el servicio', items: [{ nombre: 'Request de ejemplo', marcado: true, dato: { nombre: 'Request de ejemplo', metodo: 'POST', url: '', cabeceras: this.cabecerasPorDefecto(), cuerpo: this.servicio.RequestEjemplo } }] });
    }
    if (this.solicitudes.length) {
      grupos.push({
        titulo: `Cargadas de ${this.origenCargado || 'un archivo'}`,
        items: this.solicitudes.map((s) => ({ nombre: s.nombre, marcado: false, dato: { nombre: s.nombre, metodo: s.metodo, url: s.url && !s.urlDelWsdl ? s.url : '', cabeceras: s.cabeceras, cuerpo: s.cuerpo } })),
      });
    }
    const enEditor = !this.destinos.some((d) => d.url === this.url.trim()) ? this.url.trim() : '';
    grupos.push({
      titulo: 'Lo que tengo en el editor ahora',
      items: [{
        nombre: this.nombreSolicitud || 'Petición actual', marcado: !grupos.length,
        dato: { nombre: this.nombreSolicitud || 'Petición actual', metodo: this.metodo, url: enEditor, cabeceras: this.cabeceras, cuerpo: this.cuerpo },
      }],
    });
    this.exportGrupos = grupos;
    this.exportNombre = this.esLibre ? `Pruebas libres ${this.modo}` : `${this.servicio.Codigo} ${this.servicio.NombreServicio}`.trim();
    const sugerida = this.destinos.find((d) => d.ambiente === 'QA') || this.destinos.find((d) => d.ambiente === 'DEV') || this.destinos[0];
    this.exportUrlId = sugerida ? sugerida.id : '';
    this.dialogoExportar = true;
  }

  get exportMarcadas(): number {
    return this.exportGrupos.reduce((n, g) => n + g.items.filter((i) => i.marcado).length, 0);
  }

  marcarGrupo(g: { items: { marcado: boolean }[] }, valor: boolean): void {
    g.items.forEach((i) => (i.marcado = valor));
  }

  descargarColeccion(): void {
    const destino = this.destinos.find((d) => d.id === this.exportUrlId);
    const items = this.exportGrupos.flatMap((g) => g.items.filter((i) => i.marcado).map((i) => ({ ...i.dato, url: i.dato.url || (destino ? destino.url : '') })));
    if (!items.length) return;
    const nombre = this.exportNombre.trim() || 'Colección';
    const descripcion = this.esLibre ? `Peticiones de prueba libre (${this.modo}) exportadas desde AXIS.` : `Peticiones del servicio ${this.servicio.Codigo} ${this.servicio.NombreServicio} (${this.servicio.Tipo}) exportadas desde AXIS.`;
    descargarJson(`${nombreSeguroArchivo(nombre)}.postman_collection.json`, construirColeccionPostman(nombre, descripcion, items));
    this.dialogoExportar = false;
  }

  private registrarUrlsDelArchivo(solicitudes: SolicitudImportada[]): void {
    const vistas = new Set<string>();
    const lista: OpcionUrl[] = [];
    for (const s of solicitudes) {
      const u = (s.url || '').trim();
      if (!/^https?:\/\//i.test(u) || vistas.has(u)) continue;
      vistas.add(u);
      lista.push({ url: u, ambiente: 'ARCHIVO', bus: s.urlDelWsdl ? 'Dirección que indica el WSDL' : 'Indicada en el archivo' });
      if (lista.length >= 12) break;
    }
    this.urlsArchivo = lista;
    this.recalcularGruposUrls();
  }

  /** Cierra la ventana si se hizo clic en el fondo. Debe devolver void: si devolviera false Angular cancelaría el clic de los controles de adentro (selector de archivos, casillas). */
  cerrarSiFondo(e: Event, cual: 'importar' | 'exportar'): void {
    if (e.target !== e.currentTarget) return;
    if (cual === 'importar') this.dialogoImportar = false; else this.dialogoExportar = false;
  }

  abrirImportar(): void {
    this.dialogoGuardar = false;
    this.errorImportacion = '';
    this.archivosMensaje = '';
    this.fuente = '';
    this.dialogoImportar = true;
  }

  alternarFuente(f: 'archivos' | 'wsdl' | 'curl'): void {
    this.fuente = this.fuente === f ? '' : f;
  }

  esActiva(s: SolicitudImportada): boolean {
    return this.nombreSolicitud === s.nombre && (this.url === s.url || !!s.urlDelWsdl);
  }

  private etiquetaOrigen(origen: OrigenImportacion): string {
    return { SOAPUI: 'Proyecto SoapUI', POSTMAN: 'Colección Postman', OPENAPI: 'OpenAPI', WSDL: 'WSDL', CURL: 'cURL' }[origen];
  }

  private nombreCorto(nombre: string): string {
    try {
      const u = new URL(nombre);
      const ultimo = u.pathname.split('/').filter(Boolean).pop() || u.host;
      return `${ultimo}${u.search}`;
    } catch { return nombre; }
  }

  /** WSDL probable del servicio: la URL del ambiente elegido terminada en ?wsdl. */
  private wsdlSugerida(): string {
    const preferida = this.destinos.find((d) => d.ambiente === 'QA') || this.destinos.find((d) => d.ambiente === 'DEV') || this.destinos[0];
    const base = this.url.trim() || preferida?.url || '';
    if (!base) return '';
    return /wsdl/i.test(base) ? base : `${base.split('?')[0]}?wsdl`;
  }

  private aplicarResultado(r: { origen: OrigenImportacion; solicitudes: SolicitudImportada[]; variables: ParClaveValor[]; avisos: string[] }, nombre: string): void {
    if (r.origen === 'OPENAPI') throw new Error('Los archivos Swagger / OpenAPI no se importan aquí. Usa una colección de Postman, un comando cURL o el WSDL.');
    this.solicitudes = r.solicitudes;
    this.dialogoImportar = false;
    this.eligiendo = false;
    this.origenCargado = r.origen === 'POSTMAN' && !r.solicitudes.length ? 'Variables de Postman' : `${this.etiquetaOrigen(r.origen)} · ${this.nombreCorto(nombre)}`;
    this.fuente = '';
    this.registrarUrlsDelArchivo(r.solicitudes);
    this.avisosImportacion = r.avisos;
    this.filtro = '';
    this.recalcularGrupos();
    for (const v of r.variables) {
      if (!this.variables.some((x) => x.nombre === v.nombre)) this.variables = [...this.variables, v];
    }
    if (r.solicitudes.length === 1) this.aplicarSolicitud(r.solicitudes[0]);
  }

  /** Lee un archivo del equipo (proyecto SoapUI, colección Postman, OpenAPI o WSDL) sin guardarlo en AXIS. */
  abrirArchivoLocal(evento: Event): void {
    const entrada = evento.target as HTMLInputElement;
    const archivo = entrada.files?.[0];
    entrada.value = '';
    if (!archivo) return;
    this.errorImportacion = '';
    this.avisosImportacion = [];
    if (archivo.size > 8 * 1024 * 1024) { this.errorImportacion = 'El archivo supera 8 MB.'; return; }
    archivo.text().then((texto) => {
      try {
        this.archivoCargado = null;
        this.aplicarResultado(importarArchivoDeConsumo(archivo.name, texto), archivo.name);
      } catch (e) {
        this.solicitudes = [];
        this.origenCargado = '';
        this.recalcularGrupos();
        this.errorImportacion = e instanceof Error ? e.message : 'No se pudo leer el archivo.';
      }
    });
  }

  /** El backend descarga el WSDL y los esquemas que importa; aquí se generan las peticiones. */
  leerWsdlDesdeUrl(): void {
    const url = this.sustituir(this.wsdlUrl).trim();
    if (!url || this.leyendoWsdl) return;
    this.leyendoWsdl = true;
    this.errorImportacion = '';
    this.avisosImportacion = [];
    const autorizacion = this.cabecerasParaEnviar().filter((c) => c.nombre.toLowerCase() === 'authorization');
    (this.esLibre ? this.aceServiciosService.leerWsdlLibre({ url, certificadoId: this.certificadoId, verificarTls: this.verificarTls, cabeceras: autorizacion }) : this.aceServiciosService.leerWsdl(this.servicio.Id, { url, certificadoId: this.certificadoId, verificarTls: this.verificarTls, cabeceras: autorizacion })).subscribe({
      next: (r) => {
        this.leyendoWsdl = false;
        if (r.errorRed) { this.errorImportacion = r.errorRed.mensaje; return; }
        try {
          this.archivoCargado = null;
          const primero = (r.documentos[0]?.texto || '').trim();
          // WSDL (XML) o definición de una API REST (OpenAPI/Swagger en JSON).
          const res = primero.startsWith('<') ? importarWsdl(r.documentos) : importarArchivoDeConsumo(url, primero);
          res.avisos.push(...r.avisos);
          this.aplicarResultado(res, url);
        } catch (e) {
          this.errorImportacion = e instanceof Error ? e.message : 'No se pudo leer la definición del servicio.';
        }
      },
      error: (err) => {
        this.leyendoWsdl = false;
        this.errorImportacion = err?.error?.error || 'No se pudo descargar la definición del servicio.';
      },
    });
  }

  /** Importa un comando cURL pegado (se arma la petición y se carga en el editor). */
  leerCurl(): void {
    this.errorImportacion = '';
    this.avisosImportacion = [];
    try {
      this.archivoCargado = null;
      this.aplicarResultado(importarCurl(this.curlTexto), 'comando cURL');
      this.curlTexto = '';
    } catch (e) {
      this.errorImportacion = e instanceof Error ? e.message : 'No se pudo leer el comando cURL.';
    }
  }

  // ---------------------------------------------------------------- REST: parámetros de la URL y formato del cuerpo
  get esRest(): boolean {
    return this.haySeleccion && this.servicio.Tipo === 'REST';
  }

  parametros: ParClaveValor[] = [];
  private urlDeParametros: string | null = null;

  ngDoCheck(): void {
    if (this.pestana === 'params' && this.url !== this.urlDeParametros) this.leerParametros();
  }

  /** La tabla de parámetros se lee de la propia URL (lo que va después del «?»); editar la tabla reescribe la URL. */
  private leerParametros(): void {
    const i = this.url.indexOf('?');
    const q = i < 0 ? '' : this.url.slice(i + 1);
    this.parametros = q.split('&').filter(Boolean).map((p) => {
      const k = p.indexOf('=');
      return { nombre: k < 0 ? p : p.slice(0, k), valor: k < 0 ? '' : p.slice(k + 1), activo: true };
    });
    this.urlDeParametros = this.url;
  }

  alCambiarParametros(): void {
    const base = this.url.split('?')[0];
    const q = this.parametros.filter((p) => p.activo && p.nombre.trim()).map((p) => `${p.nombre.trim()}=${p.valor}`).join('&');
    this.url = q ? `${base}?${q}` : base;
    this.urlDeParametros = this.url;
  }

  agregarParametro(): void {
    this.parametros = [...this.parametros, { nombre: '', valor: '', activo: true }];
  }

  quitarParametro(i: number): void {
    this.parametros = this.parametros.filter((_, k) => k !== i);
    this.alCambiarParametros();
  }

  readonly tiposCuerpo = [
    { id: 'json', etiqueta: 'JSON', contentType: 'application/json' },
    { id: 'xml', etiqueta: 'XML', contentType: 'application/xml' },
    { id: 'form', etiqueta: 'Formulario (x-www-form-urlencoded)', contentType: 'application/x-www-form-urlencoded' },
    { id: 'texto', etiqueta: 'Texto', contentType: 'text/plain' },
  ];

  /** Tipo de cuerpo según la cabecera Content-Type (se cambia desde el selector, sin tocar la tabla de cabeceras a mano). */
  get tipoCuerpoActual(): string {
    const ct = (this.cabeceras.find((c) => c.activo && c.nombre.toLowerCase() === 'content-type')?.valor || '').toLowerCase();
    if (ct.includes('json')) return 'json';
    if (ct.includes('xml')) return 'xml';
    if (ct.includes('urlencoded')) return 'form';
    return ct ? 'texto' : 'json';
  }

  cambiarTipoCuerpo(id: string): void {
    const t = this.tiposCuerpo.find((x) => x.id === id);
    if (!t) return;
    const c = this.cabeceras.find((x) => x.nombre.toLowerCase() === 'content-type');
    if (c) { c.valor = t.contentType; c.activo = true; }
    else this.cabeceras = [...this.cabeceras, { nombre: 'Content-Type', valor: t.contentType, activo: true }];
  }

  /** Ordena el JSON o XML del cuerpo para leerlo mejor. */
  darFormatoCuerpo(): void {
    this.avisoFormato = '';
    const t = this.cuerpo.trim();
    if (!t) return;
    const f = formatearCuerpo(t, '');
    if (f.tipo === 'TEXTO') {
      this.avisoFormato = 'No se pudo dar formato: el texto no es un JSON válido (si tiene {{variables}} sin comillas, es normal) ni un XML.';
      return;
    }
    this.cuerpo = f.texto;
  }

  // ---------------------------------------------------------------- certificados
  get certificadosCliente(): CertificadoConsumo[] {
    return this.certificados.filter((c) => c.Tipo === 'CLIENTE' && !c.Vencido);
  }

  /** Incluye los vencidos, para poder verlos y borrarlos en el panel. */
  get certificadosClienteTodos(): CertificadoConsumo[] {
    return this.certificados.filter((c) => c.Tipo === 'CLIENTE');
  }

  get certificadosCa(): CertificadoConsumo[] {
    return this.certificados.filter((c) => c.Tipo === 'CA');
  }

  cargarCertificados(): void {
    this.aceServiciosService.listarCertificados().subscribe({
      next: (r) => {
        this.certificados = r.certificados;
        this.certificadosDisponibles = r.disponible;
        this.certificadosMensaje = r.mensaje || '';
        if (this.certificadoId !== null && !r.certificados.some((c) => c.Id === this.certificadoId && c.Tipo === 'CLIENTE')) this.certificadoId = null;
        this.preseleccionarCertificado();
      },
      error: () => { this.certificadosMensaje = 'No se pudieron consultar los certificados.'; },
    });
  }

  private static readonly CLAVE_CERT = 'axis.consumo.certificado';

  /** La primera vez que se cargan los certificados se vuelve a elegir el último usado (o el único que haya). */
  private preseleccionarCertificado(): void {
    if (this.certAutoAplicado || this.certificadoId !== null) return;
    const clientes = this.certificadosCliente;
    if (!clientes.length) return;
    this.certAutoAplicado = true;
    let guardado: number | null = null;
    try { guardado = Number(localStorage.getItem(ProbarServicioComponent.CLAVE_CERT)) || null; } catch { /* sin almacenamiento */ }
    const elegido = clientes.find((c) => c.Id === guardado) || (clientes.length === 1 ? clientes[0] : null);
    if (elegido) this.certificadoId = elegido.Id;
  }

  alElegirCertificado(id: number | null): void {
    this.certificadoId = id;
    this.certAutoAplicado = true;
    try {
      if (id === null) localStorage.removeItem(ProbarServicioComponent.CLAVE_CERT);
      else localStorage.setItem(ProbarServicioComponent.CLAVE_CERT, String(id));
    } catch { /* sin almacenamiento */ }
  }

  usarCertificado(c: CertificadoConsumo): void {
    this.alElegirCertificado(c.Id);
    this.panelCertificados = false;
    this.mostrarAvisoCert(`Se usará «${c.Nombre}»`);
  }

  private mostrarAvisoCert(texto: string): void {
    this.avisoCert = texto;
    if (this.avisoTimer) clearTimeout(this.avisoTimer);
    this.avisoTimer = setTimeout(() => { this.avisoCert = ''; }, 5000);
  }

  cerrarPanelSiFondo(e: Event): void {
    if (e.target === e.currentTarget) this.panelCertificados = false;
  }

  abrirPanelCertificados(): void {
    this.panelCertificados = true;
    this.errorCert = '';
    this.cargarCertificados();
  }

  elegirArchivosCert(evento: Event): void {
    const entrada = evento.target as HTMLInputElement;
    const lista = Array.from(entrada.files || []);
    entrada.value = '';
    this.leerArchivosCert(lista);
  }

  alArrastrar(e: DragEvent, sobre: boolean): void {
    e.preventDefault();
    this.arrastrando = sobre;
  }

  alSoltar(e: DragEvent): void {
    e.preventDefault();
    this.arrastrando = false;
    this.leerArchivosCert(Array.from(e.dataTransfer?.files || []));
  }

  private leerArchivosCert(lista: File[]): void {
    this.errorCert = '';
    if (!lista.length) return;
    if (lista.some((f) => f.size > 1024 * 1024)) { this.errorCert = 'Cada archivo debe pesar menos de 1 MB.'; return; }
    Promise.all(lista.map((f) => new Promise<{ nombreOriginal: string; contenidoBase64: string }>((resolver, rechazar) => {
      const lector = new FileReader();
      lector.onload = () => resolver({ nombreOriginal: f.name, contenidoBase64: String(lector.result).split(',')[1] || '' });
      lector.onerror = () => rechazar(new Error('lectura'));
      lector.readAsDataURL(f);
    }))).then((leidos) => {
      this.certArchivos = [...this.certArchivos, ...leidos];
      if (!this.certNombre && leidos[0]) this.certNombre = leidos[0].nombreOriginal.replace(/\.[^.]+$/, '');
    }).catch(() => { this.errorCert = 'No se pudo leer el archivo.'; });
  }

  quitarArchivoCert(i: number): void {
    this.certArchivos = this.certArchivos.filter((_, k) => k !== i);
  }

  guardarCertificado(): void {
    if (this.guardandoCert) return;
    this.errorCert = '';
    if (!this.certNombre.trim()) { this.errorCert = 'Ponle un nombre al certificado.'; return; }
    if (!this.certArchivos.length) { this.errorCert = 'Adjunta el archivo del certificado.'; return; }
    this.guardandoCert = true;
    this.aceServiciosService.subirCertificado({ nombre: this.certNombre.trim(), clave: this.certClave, archivos: this.certArchivos }).subscribe({
      next: (c) => {
        this.guardandoCert = false;
        this.certNombre = ''; this.certClave = ''; this.certArchivos = [];
        if (c.Tipo === 'CLIENTE') {
          this.alElegirCertificado(c.Id);
          this.mostrarAvisoCert(`«${c.Nombre}» guardado y seleccionado`);
        } else {
          this.mostrarAvisoCert(`CA «${c.Nombre}» registrada: AXIS confiará en ella`);
        }
        this.panelCertificados = false;
        this.cargarCertificados();
      },
      error: (err) => {
        this.guardandoCert = false;
        this.errorCert = err?.error?.error || 'No se pudo guardar el certificado.';
      },
    });
  }

  eliminarCertificado(c: CertificadoConsumo): void {
    if (!confirm(`¿Eliminar el certificado «${c.Nombre}»?`)) return;
    this.aceServiciosService.eliminarCertificado(c.Id).subscribe({
      next: () => { if (this.certificadoId === c.Id) this.alElegirCertificado(null); this.cargarCertificados(); },
      error: (err) => { this.errorCert = err?.error?.error || 'No se pudo eliminar el certificado.'; },
    });
  }

  /** Nombre común (CN=…) de un sujeto o emisor; si no trae, el texto completo. */
  cn(texto: string | null | undefined): string {
    const t = texto || '';
    return (t.match(/(?:^|,\s*)CN=([^,]+)/) || [])[1]?.trim() || t;
  }

  venceProximo(c: CertificadoConsumo): boolean {
    if (!c.VenceEn || c.Vencido) return false;
    return new Date(c.VenceEn).getTime() - Date.now() < 30 * 24 * 3600 * 1000;
  }

  /** El error de TLS más común en ambientes internos: ofrece confiar en el servidor y reintentar (en producción se vuelve a pedir confirmación). */
  get errorEsDeCertificado(): boolean {
    return !!this.respuesta?.errorRed && /no es de confianza|no corresponde al nombre/i.test(this.respuesta.errorRed.mensaje) && this.verificarTls;
  }

  reintentarSinVerificar(): void {
    this.verificarTls = false;
    this.enviar();
  }

  // ---------------------------------------------------------------- enviar
  ignorarSinResolver = false;

  /** Expresiones ${…} de SoapUI que quedan sin valor (propiedades del proyecto, Groovy distinto de los casos comunes…). */
  private valoresSinResolver(): string[] {
    const textos = [this.sustituir(this.url), this.sinCuerpo ? '' : this.sustituir(this.cuerpo), ...this.cabeceras.filter((c) => c.activo).map((c) => this.sustituir(c.valor))];
    const hallados = new Set<string>();
    for (const t of textos) for (const m of t.matchAll(/\$\{[^{}]{1,80}\}/g)) hallados.add(m[0]);
    return [...hallados].slice(0, 5);
  }

  get sinCuerpo(): boolean {
    return this.metodo === 'GET' || this.metodo === 'HEAD';
  }

  get placeholderCuerpo(): string {
    return this.servicio.Tipo === 'REST' ? '{ "campo": "valor" }' : '<soapenv:Envelope>…</soapenv:Envelope>';
  }

  get puedeEnviar(): boolean {
    return !this.enviando && !!this.url.trim();
  }

  enviar(): void {
    this.errorEnvio = '';
    this.sincronizarVariables();
    const faltan = this.variablesSinValor;
    if (faltan.length) {
      this.pestana = 'variables';
      this.errorEnvio = `Completa el valor de: ${faltan.map((f) => `{{${f}}}`).join(', ')}`;
      return;
    }
    const sinResolver = this.valoresSinResolver();
    if (sinResolver.length && !this.ignorarSinResolver) {
      this.ignorarSinResolver = true;
      this.errorEnvio = `La petición tiene valores de SoapUI que no se pueden resolver aquí: ${sinResolver.join(', ')}. Cámbialos por su valor (o por una {{variable}}). Si quieres enviarlos tal cual, pulsa Enviar de nuevo.`;
      return;
    }
    if (!/^https?:\/\//i.test(this.sustituir(this.url).trim())) {
      this.errorEnvio = 'La URL debe empezar con http:// o https://';
      return;
    }
    this.ejecutar(this.esProduccion);
  }

  confirmarProduccion(): void {
    this.ejecutar(true);
  }

  cancelarConfirmacion(): void {
    this.pidiendoConfirmacion = false;
  }

  private cabecerasParaEnviar(): { nombre: string; valor: string }[] {
    const lista = this.cabeceras
      .filter((c) => c.activo && c.nombre.trim())
      .map((c) => ({ nombre: c.nombre.trim(), valor: this.sustituir(c.valor) }));
    const tiene = (n: string) => lista.some((c) => c.nombre.toLowerCase() === n);
    if (this.auth.tipo === 'basic' && !tiene('authorization')) {
      const par = `${this.sustituir(this.auth.usuario || '')}:${this.sustituir(this.auth.clave || '')}`;
      const bytes = new TextEncoder().encode(par);
      let binario = '';
      bytes.forEach((b) => (binario += String.fromCharCode(b)));
      lista.push({ nombre: 'Authorization', valor: `Basic ${btoa(binario)}` });
    } else if (this.auth.tipo === 'apikey' && (this.auth.claveNombre || '').trim() && !tiene((this.auth.claveNombre || '').trim().toLowerCase())) {
      lista.push({ nombre: (this.auth.claveNombre || '').trim(), valor: this.sustituir(this.auth.claveValor || '') });
    } else if (this.auth.tipo === 'bearer' && !tiene('authorization')) {
      lista.push({ nombre: 'Authorization', valor: `Bearer ${this.sustituir(this.auth.token || '')}` });
    }
    return lista;
  }

  private ejecutar(confirmarProduccion: boolean): void {
    if (this.enviando) return;
    this.enviando = true;
    this.pidiendoConfirmacion = false;
    this.errorEnvio = '';
    const peticion: PeticionConsumo = {
      metodo: this.metodo,
      url: this.sustituir(this.url).trim(),
      cabeceras: this.cabecerasParaEnviar(),
      cuerpo: this.sinCuerpo ? '' : this.sustituir(this.cuerpo),
      timeoutSegundos: this.timeoutSegundos,
      verificarTls: this.verificarTls,
      confirmarProduccion,
      certificadoId: this.certificadoId,
    };
    (this.esLibre ? this.aceServiciosService.consumirLibre(peticion) : this.aceServiciosService.consumir(this.servicio.Id, peticion)).subscribe({
      next: (r) => {
        this.enviando = false;
        this.mostrarRespuesta(r);
      },
      error: (err) => {
        this.enviando = false;
        if (err?.status === 409 && err?.error?.requiereConfirmarProduccion && !confirmarProduccion) {
          this.ejecutar(true);
          return;
        }
        this.errorEnvio = err?.error?.error || 'No se pudo ejecutar la petición. Intenta de nuevo.';
      },
    });
  }

  private mostrarRespuesta(r: RespuestaConsumo): void {
    this.respuesta = r;
    const tipo = (r.headers || []).find((h) => h.nombre.toLowerCase() === 'content-type')?.valor || '';
    const f = formatearCuerpo(r.cuerpo || '', tipo);
    this.cuerpoFormateado = f.texto;
    this.tipoCuerpoRespuesta = f.tipo;
    this.htmlFormateado = null;
    this.htmlCrudo = null;
    this.interpretacion = null;
    this.vistaResumen = null;
    this.resumenCopiado = false;
    if (!r.errorRed) {
      try {
        this.interpretacion = interpretarRespuesta(r);
        this.vistaResumen = this.interpretacion.raiz ? filtrarTecnicos(this.interpretacion.raiz, this.mostrarTecnicos) : null;
      } catch {
        this.interpretacion = null;
      }
    }
    // Con datos estructurados se abre el resumen; con texto suelto, el cuerpo.
    this.pestanaRespuesta = this.interpretacion && (this.interpretacion.raiz || r.estado === undefined || r.estado >= 300) ? 'resumen' : 'cuerpo';
  }

  alternarTecnicos(): void {
    this.mostrarTecnicos = !this.mostrarTecnicos;
    const i = this.interpretacion;
    this.vistaResumen = i && i.raiz ? filtrarTecnicos(i.raiz, this.mostrarTecnicos) : null;
  }

  async copiarResumen(): Promise<void> {
    if (!this.interpretacion) return;
    try {
      await navigator.clipboard.writeText(resumenATexto(this.interpretacion, this.mostrarTecnicos));
      this.resumenCopiado = true;
      setTimeout(() => (this.resumenCopiado = false), 1500);
    } catch { /* sin permiso de portapapeles */ }
  }

  /** Cuerpo de la respuesta ya coloreado (HTML escapado, solo <span class="tk-…">). */
  get cuerpoRespuestaHtml(): string | null {
    const texto = this.cuerpoRespuestaMostrado;
    if (texto.length > MAX_RESALTADO || this.tipoCuerpoRespuesta === 'TEXTO') return null;
    if (this.verFormateado) return (this.htmlFormateado ??= resaltarCodigo(texto));
    return (this.htmlCrudo ??= resaltarCodigo(texto));
  }

  /** Capa de colores bajo el editor de la petición (se recalcula solo cuando cambia el texto). */
  get cuerpoPeticionHtml(): string | null {
    const t = this.cuerpo || '';
    if (t.length > 150_000) return null;
    if (this.memoPeticion.texto !== t) this.memoPeticion = { texto: t, html: resaltarCodigo(t) };
    return this.memoPeticion.html + '\n';
  }

  sincronizarScroll(evento: Event, capa: HTMLElement): void {
    const ta = evento.target as HTMLTextAreaElement;
    capa.scrollTop = ta.scrollTop;
    capa.scrollLeft = ta.scrollLeft;
  }

  // ---------------------------------------------------------------- respuesta
  get claseEstado(): string {
    const r = this.respuesta;
    if (!r || r.estado === undefined) return 'estado--error';
    if (r.estado < 300) return 'estado--ok';
    if (r.estado < 400) return 'estado--info';
    if (r.estado < 500) return 'estado--aviso';
    return 'estado--error';
  }

  get cuerpoRespuestaMostrado(): string {
    return this.verFormateado ? this.cuerpoFormateado : (this.respuesta?.cuerpo || '');
  }

  formatoTamano(bytes?: number): string {
    if (bytes === undefined) return '';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  async copiarRespuesta(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.cuerpoRespuestaMostrado);
      this.copiado = true;
      setTimeout(() => (this.copiado = false), 1500);
    } catch { /* sin permiso de portapapeles */ }
  }

  descargarRespuesta(): void {
    const extension = this.tipoCuerpoRespuesta === 'JSON' ? 'json' : this.tipoCuerpoRespuesta === 'XML' ? 'xml' : 'txt';
    const blob = new Blob([this.cuerpoRespuestaMostrado], { type: 'text/plain;charset=utf-8' });
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = `respuesta-${this.servicio.Codigo || this.servicio.Id}.${extension}`;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(enlace.href), 2000);
  }

  cerrarModal(): void {
    this.cerrar.emit();
  }
}
