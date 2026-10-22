import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AceServiciosService, PeticionGuardada } from '../../core/services/ace-servicios.service';
import { construirColeccionPostman, descargarJson, nombreSeguroArchivo } from '../../core/utils/exportar-postman';
import { descargarCsv, fechaParaArchivo } from '../../core/utils/exportar-csv';
import { compararAce, OrdenAce, OPCIONES_ORDEN_ACE } from '../../core/utils/ordenar-codigo-ace';
import { AceServicioInventario, ArchivoServicio, FilaImportacionBus10, ResultadoImportacionBus10 } from '../../core/models/models';
import { AuthService } from '../../services/auth.service';
import { ProbarServicioComponent } from './probar-servicio.component';

interface AmbienteUrl {
  clave: 'dev' | 'qa' | 'prd';
  etiqueta: string;
  claseTag: string;
  url: string;
}

type Bus = 'ACE12' | 'BUS10';

interface GrupoUrlsForm {
  bus: Bus;
  titulo: string;
  campos: { campo: 'UrlDev' | 'UrlQa' | 'UrlPrd' | 'UrlDevBus10' | 'UrlQaBus10' | 'UrlPrdBus10'; etiqueta: string }[];
}

interface FormularioServicio {
  Tipo: 'SOAP' | 'REST';
  Codigo: string;
  NombreServicio: string;
  Pod: string;
  UrlDev: string;
  UrlQa: string;
  UrlPrd: string;
  UrlDevBus10: string;
  UrlQaBus10: string;
  UrlPrdBus10: string;
  RequestEjemplo: string;
}

const FORM_VACIO = (tipo: 'SOAP' | 'REST'): FormularioServicio => ({
  Tipo: tipo, Codigo: '', NombreServicio: '', Pod: '',
  UrlDev: '', UrlQa: '', UrlPrd: '', UrlDevBus10: '', UrlQaBus10: '', UrlPrdBus10: '',
  RequestEjemplo: '',
});

@Component({
  selector: 'app-servicios-list',
  standalone: true,
  imports: [CommonModule, FormsModule, ProbarServicioComponent],
  templateUrl: './servicios-list.component.html',
  styleUrl: './servicios-list.component.scss',
})
export class ServiciosListComponent implements OnInit {
  cargando = true;
  servicios: AceServicioInventario[] = [];
  terminoBusqueda = '';

  // Bus sobre el que se listan las URLs por ambiente. El código, nombre, POD,
  // tipo y request son los mismos para ambos; solo cambian las URLs.
  readonly buses: { id: Bus; etiqueta: string }[] = [
    { id: 'ACE12', etiqueta: 'BUS ACE (12)' },
    { id: 'BUS10', etiqueta: 'BUS 10' },
  ];
  busActivo: Bus = 'ACE12';

  // División del inventario por tipo de servicio (misma información en ambas).
  readonly tipos: ('SOAP' | 'REST')[] = ['SOAP', 'REST'];
  tipoActivo: 'SOAP' | 'REST' = 'SOAP';

  // Filtro adicional por POD — 'Todos' + cada valor distinto presente en los datos.
  filtroPod = 'Todos';

  detalle: AceServicioInventario | null = null;

  // Consola «Probar servicio»: ejecuta peticiones SOAP/REST desde AXIS (como SoapUI / Postman).
  consolaAbierta = false;
  consolaServicio: AceServicioInventario | null = null;

  // URL que se acaba de copiar al portapapeles, para mostrar el feedback
  // "Copiado" solo en esa fila y solo un momento.
  urlCopiada: string | null = null;
  private timerCopiado: any = null;

  // Solo ADMIN_POD/ADMIN_MIN pueden crear/editar/borrar. BASIC = solo lectura.
  puedeEditar = false;

  mostrarForm = false;
  editando: AceServicioInventario | null = null;
  form: FormularioServicio = FORM_VACIO('SOAP');
  guardando = false;

  constructor(
    private aceServiciosService: AceServiciosService,
    private authService: AuthService,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('SERVICIOS');

    this.cargar();
  }

  readonly opcionesOrden = OPCIONES_ORDEN_ACE;
  orden: OrdenAce = 'codigo-asc';

  // Orden elegido por el usuario (por defecto, código de menor a mayor).
  ordenarServicios(): void {
    this.servicios = [...this.servicios].sort((a, b) =>
      compararAce(this.orden, { Codigo: a.Codigo, Nombre: a.NombreServicio }, { Codigo: b.Codigo, Nombre: b.NombreServicio }),
    );
  }

  cargar(): void {
    this.cargando = true;
    this.aceServiciosService.listar().subscribe({
      next: (servicios) => {
        this.servicios = servicios;
        this.ordenarServicios();
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al cargar el inventario de servicios:', err);
        this.cargando = false;
      },
    });
  }

  private tipoDe(s: AceServicioInventario): 'SOAP' | 'REST' {
    return s.Tipo === 'REST' ? 'REST' : 'SOAP';
  }

  // ---- Bus (ACE 12 / BUS 10) ----
  private tieneUrlsAce12(s: AceServicioInventario): boolean {
    return !!(s.UrlDev || s.UrlQa || s.UrlPrd);
  }

  private tieneUrlsBus10(s: AceServicioInventario): boolean {
    return !!(s.UrlDevBus10 || s.UrlQaBus10 || s.UrlPrdBus10);
  }

  // Un servicio sin URLs en ningún bus se muestra en ACE 12 (el inventario original).
  perteneceABus(s: AceServicioInventario, bus: Bus): boolean {
    return bus === 'BUS10' ? this.tieneUrlsBus10(s) : this.tieneUrlsAce12(s) || !this.tieneUrlsBus10(s);
  }

  urlsDe(s: AceServicioInventario, bus: Bus = this.busActivo): { dev: string | null; qa: string | null; prd: string | null } {
    return bus === 'BUS10'
      ? { dev: s.UrlDevBus10 || null, qa: s.UrlQaBus10 || null, prd: s.UrlPrdBus10 || null }
      : { dev: s.UrlDev || null, qa: s.UrlQa || null, prd: s.UrlPrd || null };
  }

  get etiquetaBus(): string {
    return this.buses.find((b) => b.id === this.busActivo)?.etiqueta || '';
  }

  cantidadPorBus(bus: Bus): number {
    return this.servicios.filter((s) => this.perteneceABus(s, bus)).length;
  }

  seleccionarBus(bus: Bus): void {
    if (this.busActivo === bus) return;
    this.busActivo = bus;
    this.filtroPod = 'Todos';
  }

  cantidadPorTipo(tipo: 'SOAP' | 'REST'): number {
    return this.servicios.filter((s) => this.perteneceABus(s, this.busActivo) && this.tipoDe(s) === tipo).length;
  }

  seleccionarTipo(tipo: 'SOAP' | 'REST'): void {
    if (this.tipoActivo === tipo) return;
    this.tipoActivo = tipo;
    // El POD elegido puede no existir en el otro tipo: se vuelve a "Todos".
    this.filtroPod = 'Todos';
  }

  // PODs distintos presentes en los datos del tipo activo, para alimentar el filtro.
  get podsDisponibles(): string[] {
    const pods = new Set<string>();
    for (const s of this.servicios) {
      if (this.tipoDe(s) !== this.tipoActivo || !this.perteneceABus(s, this.busActivo)) continue;
      if (s.Pod) pods.add(s.Pod);
    }
    return Array.from(pods).sort((a, b) => a.localeCompare(b));
  }

  get serviciosFiltrados(): AceServicioInventario[] {
    let resultado = this.servicios.filter((s) => this.tipoDe(s) === this.tipoActivo && this.perteneceABus(s, this.busActivo));

    if (this.filtroPod !== 'Todos') {
      resultado = resultado.filter((s) => s.Pod === this.filtroPod);
    }

    if (this.terminoBusqueda) {
      const termino = this.terminoBusqueda.toLowerCase().trim();
      resultado = resultado.filter((s) => JSON.stringify(s).toLowerCase().includes(termino));
    }

    return resultado;
  }

  // Exporta a CSV lo que se está viendo (tipo, POD, búsqueda y orden actuales).
  exportar(): void {
    const filas = this.serviciosFiltrados.map((s) => {
      const u = this.urlsDe(s);
      return [s.Codigo, s.NombreServicio, s.Pod, u.dev, u.qa, u.prd, this.numPeticiones(s), s.RequestEjemplo];
    });
    descargarCsv(
      `servicios_${this.busActivo === 'BUS10' ? 'bus10' : 'ace12'}_${this.tipoActivo.toLowerCase()}_${fechaParaArchivo()}.csv`,
      ['Código', 'Servicio', 'POD', 'URL DEV', 'URL QA', 'URL PRD', 'Peticiones guardadas', 'Request'],
      filas,
    );
  }

  abrirDetalle(s: AceServicioInventario): void {
    this.detalle = s;
    this.cargarArchivos(s);
    this.cargarPeticionesDetalle(s);
  }

  // ---- Peticiones guardadas: una por operación del servicio ----
  peticiones: PeticionGuardada[] = [];
  peticionesDisponibles = true;
  peticionesMensaje = '';
  cargandoPeticiones = false;
  peticionCopiada: number | null = null;
  ambienteExport = '';
  private timerPeticion: any = null;

  /** Cantidad de peticiones guardadas; cuenta el request antiguo si todavía no se pasó a peticiones. */
  numPeticiones(s: AceServicioInventario): number {
    return s.NumPeticiones || (s.RequestEjemplo ? 1 : 0);
  }

  private cargarPeticionesDetalle(s: AceServicioInventario): void {
    this.peticiones = [];
    this.peticionesDisponibles = true;
    this.peticionesMensaje = '';
    this.cargandoPeticiones = true;
    this.aceServiciosService.listarPeticiones(s.Id).subscribe({
      next: (r) => {
        if (this.detalle?.Id !== s.Id) return;
        this.peticiones = r.peticiones;
        this.peticionesDisponibles = r.disponible;
        this.peticionesMensaje = r.mensaje || '';
        this.cargandoPeticiones = false;
        const amb = this.ambientesDelDetalle;
        const sugerida = amb.find((a) => a.clave === 'qa') || amb.find((a) => a.clave === 'dev') || amb[0];
        this.ambienteExport = sugerida ? sugerida.clave : '';
      },
      error: () => {
        if (this.detalle?.Id !== s.Id) return;
        this.cargandoPeticiones = false;
        this.peticionesMensaje = 'No se pudieron consultar las peticiones guardadas.';
      },
    });
  }

  tipoCuerpo(cuerpo: string): string {
    const t = (cuerpo || '').trim();
    return !t ? 'sin cuerpo' : t.startsWith('<') ? 'XML' : t.startsWith('{') || t.startsWith('[') ? 'JSON' : 'TEXTO';
  }

  copiarPeticion(p: PeticionGuardada, evento: Event): void {
    evento.stopPropagation();
    this.copiarAlPortapapeles(p.Cuerpo || '').then((exito) => {
      if (!exito) { window.prompt('No se pudo copiar automáticamente. Copia el cuerpo con Ctrl+C:', p.Cuerpo || ''); return; }
      this.peticionCopiada = p.Id;
      if (this.timerPeticion) clearTimeout(this.timerPeticion);
      this.timerPeticion = setTimeout(() => { this.peticionCopiada = null; }, 1500);
    });
  }

  eliminarPeticion(p: PeticionGuardada, evento: Event): void {
    evento.stopPropagation();
    const servicio = this.detalle;
    if (!servicio || !confirm(`¿Eliminar la petición guardada «${p.Nombre}»?`)) return;
    this.aceServiciosService.eliminarPeticion(servicio.Id, p.Id).subscribe({
      next: () => {
        this.peticiones = this.peticiones.filter((x) => x.Id !== p.Id);
        servicio.NumPeticiones = this.peticiones.length;
      },
      error: (err) => { this.errorArchivo = err?.error?.error || 'No se pudo eliminar la petición.'; },
    });
  }

  /** Descarga todas las peticiones guardadas del servicio como colección de Postman. */
  exportarPostman(): void {
    const s = this.detalle;
    if (!s) return;
    const amb = this.ambientesDelDetalle.find((a) => a.clave === this.ambienteExport);
    const base = s.RequestEjemplo && !this.peticiones.length
      ? [{ nombre: 'Request de ejemplo', metodo: 'POST', url: '', cabeceras: [] as { nombre: string; valor: string; activo?: boolean }[], cuerpo: s.RequestEjemplo }]
      : [];
    const items = [
      ...base,
      ...this.peticiones.map((p) => ({ nombre: p.Nombre, metodo: p.Metodo, url: p.Url || '', cabeceras: p.Cabeceras, cuerpo: p.Cuerpo })),
    ].map((i) => ({ ...i, url: i.url || (amb ? amb.url : '') }));
    if (!items.length) return;
    const nombre = `${s.Codigo} ${s.NombreServicio}`.trim();
    descargarJson(
      `${nombreSeguroArchivo(nombre)}.postman_collection.json`,
      construirColeccionPostman(nombre, `Peticiones del servicio ${nombre} (${s.Tipo}) exportadas desde AXIS.`, items),
    );
  }

  get puedeExportarPostman(): boolean {
    return !!this.detalle && (this.peticiones.length > 0 || !!this.detalle.RequestEjemplo);
  }

  // ---- Archivos de consumo: proyecto XML de SoapUI (SOAP) o colección (REST) ----
  archivos: ArchivoServicio[] = [];
  archivosDisponibles = true;
  archivosMensaje = '';
  cargandoArchivos = false;
  subiendoArchivo = false;
  errorArchivo = '';
  descargandoArchivo: number | null = null;
  readonly extensionesArchivo = '.xml,.json,.wsdl,.xsd,.yaml,.yml,.zip,.txt';
  private readonly maxArchivoBytes = 8 * 1024 * 1024;

  private cargarArchivos(s: AceServicioInventario): void {
    this.archivos = [];
    this.archivosDisponibles = true;
    this.archivosMensaje = '';
    this.errorArchivo = '';
    this.cargandoArchivos = true;
    this.aceServiciosService.listarArchivos(s.Id).subscribe({
      next: (r) => {
        if (this.detalle?.Id !== s.Id) return;
        this.archivos = r.archivos;
        this.archivosDisponibles = r.disponible;
        this.archivosMensaje = r.mensaje || '';
        this.cargandoArchivos = false;
      },
      error: (err) => {
        if (this.detalle?.Id !== s.Id) return;
        this.cargandoArchivos = false;
        this.errorArchivo = err?.error?.error || 'No se pudieron cargar los archivos del servicio.';
      },
    });
  }

  /** Para qué sirven los documentos adjuntos (texto de ayuda en el detalle). */
  get ayudaArchivo(): string {
    return this.detalle?.Tipo === 'REST'
      ? 'Opcional: guarda aquí el archivo original (colección de Postman u OpenAPI) como respaldo o para compartirlo tal cual. Para consumir el servicio no hace falta: usa «Probar» y guarda las peticiones.'
      : 'Opcional: guarda aquí el archivo original (proyecto de SoapUI o WSDL) como respaldo o para compartirlo tal cual. Para consumir el servicio no hace falta: usa «Probar», carga el archivo y guarda las operaciones que necesites.';
  }

  formatoTamano(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  elegirArchivo(evento: Event): void {
    const entrada = evento.target as HTMLInputElement;
    const archivo = entrada.files?.[0];
    entrada.value = '';
    const servicio = this.detalle;
    if (!archivo || !servicio || !this.puedeEditar) return;
    this.errorArchivo = '';
    if (archivo.size > this.maxArchivoBytes) {
      this.errorArchivo = `El archivo pesa ${this.formatoTamano(archivo.size)} y el máximo es 8 MB.`;
      return;
    }
    const lector = new FileReader();
    lector.onerror = () => { this.errorArchivo = 'No se pudo leer el archivo.'; };
    lector.onload = () => {
      this.subiendoArchivo = true;
      this.aceServiciosService.subirArchivo(servicio.Id, archivo.name, String(lector.result)).subscribe({
        next: () => {
          this.subiendoArchivo = false;
          this.cargarArchivos(servicio);
          this.cargar();
        },
        error: (err) => {
          this.subiendoArchivo = false;
          this.errorArchivo = err?.error?.error || 'No se pudo subir el archivo. Intenta de nuevo.';
        },
      });
    };
    lector.readAsDataURL(archivo);
  }

  descargarArchivo(a: ArchivoServicio): void {
    if (!this.detalle || this.descargandoArchivo !== null) return;
    this.descargandoArchivo = a.Id;
    this.errorArchivo = '';
    this.aceServiciosService.descargarArchivo(a.ServicioId, a.Id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = a.NombreOriginal;
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        this.descargandoArchivo = null;
      },
      error: () => {
        this.descargandoArchivo = null;
        this.errorArchivo = 'No se pudo descargar el archivo. Intenta de nuevo.';
      },
    });
  }

  eliminarArchivo(a: ArchivoServicio): void {
    if (!this.puedeEditar || !this.detalle) return;
    if (!confirm(`¿Eliminar el archivo "${a.NombreOriginal}"?`)) return;
    const servicio = this.detalle;
    this.aceServiciosService.eliminarArchivo(a.ServicioId, a.Id).subscribe({
      next: () => { this.cargarArchivos(servicio); this.cargar(); },
      error: (err) => { this.errorArchivo = err?.error?.error || 'No se pudo eliminar el archivo.'; },
    });
  }

  // Ambientes con URL del servicio en detalle, listos para pintar con *ngFor
  // (evita repetir el mismo bloque de plantilla tres veces para DEV/QA/PRD).
  get ambientesDelDetalle(): AmbienteUrl[] {
    if (!this.detalle) return [];
    const ambientes: AmbienteUrl[] = [];
    const u = this.urlsDe(this.detalle);
    if (u.dev) ambientes.push({ clave: 'dev', etiqueta: 'DEV', claseTag: 'tag-dev', url: u.dev });
    if (u.qa) ambientes.push({ clave: 'qa', etiqueta: 'QA', claseTag: 'tag-qa', url: u.qa });
    if (u.prd) ambientes.push({ clave: 'prd', etiqueta: 'PRD', claseTag: 'tag-prd', url: u.prd });
    return ambientes;
  }

  // Aviso en el detalle: el servicio también tiene URLs en el otro bus.
  get otroBusDelDetalle(): { id: Bus; etiqueta: string } | null {
    if (!this.detalle) return null;
    const otro = this.buses.find((b) => b.id !== this.busActivo)!;
    const u = this.urlsDe(this.detalle, otro.id);
    return u.dev || u.qa || u.prd ? otro : null;
  }

  verEnOtroBus(bus: Bus): void {
    this.seleccionarBus(bus);
  }

  cerrarDetalle(): void {
    this.detalle = null;
  }

  /** Abre la consola con un servicio ya elegido (desde su detalle o desde su fila). */
  abrirPrueba(servicio: AceServicioInventario | null = this.detalle, evento?: Event): void {
    evento?.stopPropagation();
    this.consolaServicio = servicio;
    this.consolaAbierta = true;
  }

  /** Abre la consola sin servicio: se elige dentro de ella. */
  abrirConsola(): void {
    this.abrirPrueba(null);
  }

  cerrarConsola(): void {
    this.consolaAbierta = false;
    this.consolaServicio = null;
    // Se pudieron guardar o borrar peticiones dentro de la consola: se refrescan las cuentas y el detalle.
    this.cargar();
    if (this.detalle) this.cargarPeticionesDetalle(this.detalle);
  }

  /** Se puede probar si el servicio tiene alguna URL (en cualquiera de los dos buses). */
  get puedeProbarDetalle(): boolean {
    const s = this.detalle;
    return !!s && !!(s.UrlDev || s.UrlQa || s.UrlPrd || s.UrlDevBus10 || s.UrlQaBus10 || s.UrlPrdBus10);
  }

  // Bug preexistente (no relacionado con la auditoría): el botón "Editar"
  // del modal de detalle llamaba a un método que nunca se había definido.
  // Simplemente abre el formulario de edición con el servicio que está en
  // detalle y cierra ese modal.
  editarDesdeDetalle(): void {
    if (!this.detalle) return;
    const servicio = this.detalle;
    this.cerrarDetalle();
    this.editar(servicio);
  }

  // ============================================================
  // COPIAR URL AL PORTAPAPELES (clic sobre la URL, dentro del detalle)
  // ============================================================
  copiarUrl(url: string, evento: Event): void {
    evento.stopPropagation();
    this.copiarAlPortapapeles(url).then((exito) => {
      if (!exito) {
        // Último recurso: un prompt() deja el texto ya seleccionado, así que
        // basta con Ctrl+C manual. Esto funciona incluso si el navegador (o
        // una política corporativa) bloquea el acceso al portapapeles desde
        // JavaScript, porque ahí ya es el usuario quien copia, no la página.
        window.prompt('No se pudo copiar automáticamente. Copia la URL con Ctrl+C:', url);
        return;
      }
      this.urlCopiada = url;
      if (this.timerCopiado) clearTimeout(this.timerCopiado);
      this.timerCopiado = setTimeout(() => {
        this.urlCopiada = null;
      }, 1500);
    });
  }

  // ============================================================
  // REQUEST DE EJEMPLO POR SERVICIO (columna "Request" y detalle)
  // ============================================================
  // Id del servicio cuyo request se acaba de copiar (feedback "Copiado").
  requestCopiado: number | null = null;
  private timerRequest: any = null;

  // Etiqueta según el contenido: XML (SOAP), JSON (REST) o texto plano.
  tipoRequest(s: AceServicioInventario): 'XML' | 'JSON' | 'TEXTO' {
    const t = (s.RequestEjemplo || '').trim();
    if (t.startsWith('<')) return 'XML';
    if (t.startsWith('{') || t.startsWith('[')) return 'JSON';
    return 'TEXTO';
  }

  copiarRequest(s: AceServicioInventario, evento: Event): void {
    evento.stopPropagation();
    const texto = s.RequestEjemplo || '';
    if (!texto) return;
    this.copiarAlPortapapeles(texto).then((exito) => {
      if (!exito) {
        window.prompt('No se pudo copiar automáticamente. Copia el request con Ctrl+C:', texto);
        return;
      }
      this.requestCopiado = s.Id;
      if (this.timerRequest) clearTimeout(this.timerRequest);
      this.timerRequest = setTimeout(() => {
        this.requestCopiado = null;
      }, 1500);
    });
  }

  // Atajo de la columna: abre el formulario de edición directo en el campo Request.
  agregarRequest(s: AceServicioInventario, evento: Event): void {
    evento.stopPropagation();
    this.editar(s);
    setTimeout(() => document.getElementById('form-request')?.focus(), 50);
  }

  // navigator.clipboard.writeText() es async y Chrome la rechaza si el
  // documento no tiene foco en ese instante exacto (por ejemplo, si el
  // usuario tenía el mouse o el foco en otra ventana un instante antes del
  // clic) — eso explica que "a veces sí, a veces no" e incluso que haga
  // falta hacer clic varias veces hasta que coincida con el documento
  // enfocado. document.execCommand('copy') es síncrono y no tiene ese
  // problema, así que se prueba primero; navigator.clipboard queda solo
  // como respaldo por si el navegador no soporta execCommand en el futuro.
  private async copiarAlPortapapeles(texto: string): Promise<boolean> {
    if (this.copiarConExecCommand(texto)) return true;

    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(texto);
        return true;
      } catch (err) {
        console.warn('navigator.clipboard.writeText también falló:', err);
      }
    } else {
      console.warn('navigator.clipboard no disponible (¿contexto no seguro?): isSecureContext =', window.isSecureContext);
    }
    return false;
  }

  private copiarConExecCommand(texto: string): boolean {
    const textarea = document.createElement('textarea');
    textarea.value = texto;
    // Fuera de la vista, pero seleccionable.
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    let exito = false;
    try {
      exito = document.execCommand('copy');
      if (!exito) console.warn('document.execCommand("copy") devolvió false');
    } catch (err) {
      console.warn('document.execCommand("copy") lanzó un error:', err);
      exito = false;
    }

    document.body.removeChild(textarea);
    return exito;
  }

  abrirUrl(url: string, evento: Event): void {
    evento.stopPropagation();
    window.open(url, '_blank', 'noopener');
  }

  // ============================================================
  // CRUD — alta, edición y borrado del inventario
  // ============================================================
  abrirFormulario(): void {
    if (!this.puedeEditar) return;
    this.editando = null;
    this.form = FORM_VACIO(this.tipoActivo);
    this.mostrarForm = true;
  }

  // Grupos de URLs del formulario: primero el del bus que se está viendo.
  // Son constantes (no se crean en cada ciclo de detección) para que *ngFor no
  // vuelva a construir los campos —y sus ngModel— en cada cambio.
  private readonly grupoAce12: GrupoUrlsForm = {
    bus: 'ACE12', titulo: 'URLs en el BUS ACE (12)',
    campos: [{ campo: 'UrlDev', etiqueta: 'URL DEV' }, { campo: 'UrlQa', etiqueta: 'URL QA' }, { campo: 'UrlPrd', etiqueta: 'URL PRD' }],
  };
  private readonly grupoBus10: GrupoUrlsForm = {
    bus: 'BUS10', titulo: 'URLs en el BUS 10',
    campos: [{ campo: 'UrlDevBus10', etiqueta: 'URL DEV' }, { campo: 'UrlQaBus10', etiqueta: 'URL QA' }, { campo: 'UrlPrdBus10', etiqueta: 'URL PRD' }],
  };
  private readonly ordenAce12Primero = [this.grupoAce12, this.grupoBus10];
  private readonly ordenBus10Primero = [this.grupoBus10, this.grupoAce12];

  trackGrupo = (_: number, g: GrupoUrlsForm): Bus => g.bus;

  get gruposUrlsForm(): GrupoUrlsForm[] {
    return this.busActivo === 'BUS10' ? this.ordenBus10Primero : this.ordenAce12Primero;
  }

  editar(s: AceServicioInventario): void {
    if (!this.puedeEditar) return;
    this.editando = s;
    this.form = {
      Tipo: s.Tipo === 'REST' ? 'REST' : 'SOAP',
      Codigo: s.Codigo || '',
      NombreServicio: s.NombreServicio || '',
      Pod: s.Pod || '',
      UrlDev: s.UrlDev || '',
      UrlQa: s.UrlQa || '',
      UrlPrd: s.UrlPrd || '',
      UrlDevBus10: s.UrlDevBus10 || '',
      UrlQaBus10: s.UrlQaBus10 || '',
      UrlPrdBus10: s.UrlPrdBus10 || '',
      RequestEjemplo: s.RequestEjemplo || '',
    };
    this.mostrarForm = true;
  }

  cerrarFormulario(): void {
    this.mostrarForm = false;
    this.editando = null;
  }

  guardar(): void {
    if (!this.puedeEditar || this.guardando) return;

    if (!this.form.NombreServicio || !this.form.NombreServicio.trim()) {
      alert('El nombre del servicio es obligatorio');
      return;
    }

    const payload: Partial<AceServicioInventario> = {
      Tipo: this.form.Tipo,
      Codigo: this.form.Codigo.trim() || undefined,
      NombreServicio: this.form.NombreServicio.trim(),
      Pod: this.form.Pod.trim() || undefined,
      UrlDev: this.form.UrlDev.trim() || undefined,
      UrlQa: this.form.UrlQa.trim() || undefined,
      UrlPrd: this.form.UrlPrd.trim() || undefined,
      // Las del BUS 10 se envían siempre (vacías = borrar): el backend conserva el valor si no llegan.
      UrlDevBus10: this.form.UrlDevBus10.trim(),
      UrlQaBus10: this.form.UrlQaBus10.trim(),
      UrlPrdBus10: this.form.UrlPrdBus10.trim(),
      // Se envía sin recortar saltos internos; el backend solo quita el espacio de los extremos.
      RequestEjemplo: this.form.RequestEjemplo.trim() || undefined,
    };

    this.guardando = true;
    const accion = this.editando
      ? this.aceServiciosService.actualizar(this.editando.Id, payload)
      : this.aceServiciosService.crear(payload);

    accion.subscribe({
      next: () => {
        this.guardando = false;
        // Se muestra la pestaña (bus y tipo) del servicio recién guardado para ver el resultado.
        const f = this.form;
        const tieneAce = !!(f.UrlDev.trim() || f.UrlQa.trim() || f.UrlPrd.trim());
        const tieneBus10 = !!(f.UrlDevBus10.trim() || f.UrlQaBus10.trim() || f.UrlPrdBus10.trim());
        if (tieneBus10 && !tieneAce) this.seleccionarBus('BUS10');
        else if (!tieneBus10) this.seleccionarBus('ACE12');
        this.seleccionarTipo(this.form.Tipo);
        this.cargar();
        this.cerrarFormulario();
      },
      error: (err) => {
        this.guardando = false;
        console.error('Error al guardar el servicio:', err);
        alert(err?.error?.error || 'No se pudo guardar el servicio. Intenta de nuevo.');
      },
    });
  }

  // ============================================================
  // IMPORTAR URLs DEL BUS 10 (pegando desde Excel)
  // ============================================================
  mostrarImport = false;
  textoImport = '';
  importando = false;
  errorImport = '';
  resultadoImport: ResultadoImportacionBus10 | null = null;

  abrirImportacion(): void {
    if (!this.puedeEditar) return;
    this.textoImport = '';
    this.errorImport = '';
    this.resultadoImport = null;
    this.mostrarImport = true;
  }

  cerrarImportacion(): void {
    if (this.importando) return;
    this.mostrarImport = false;
  }

  // Columnas esperadas: Código, Servicio, URL DEV, URL QA, URL PRD (separadas por
  // tabulador —lo que da Excel al pegar—, punto y coma, barra vertical o coma).
  // Las líneas sin ninguna URL (por ejemplo el encabezado) se ignoran.
  get filasImport(): FilaImportacionBus10[] {
    const filas: FilaImportacionBus10[] = [];
    for (const linea of this.textoImport.split(/\r?\n/)) {
      if (!linea.trim()) continue;
      const separador = linea.includes('\t') ? '\t' : linea.includes(';') ? ';' : linea.includes('|') ? '|' : ',';
      const c = linea.split(separador).map((x) => x.trim().replace(/^"(.*)"$/, '$1').trim());
      // Una celda cuenta como URL solo si parece una (lleva "/" o ":"): así el encabezado
      // "DEV / QA / PRD" que viene al copiar desde Excel no se importa como si fueran URLs.
      const url = (v: string | undefined) => (v && /[\/:]/.test(v) ? v : undefined);
      const fila: FilaImportacionBus10 = { Codigo: c[0], NombreServicio: c[1], UrlDev: url(c[2]), UrlQa: url(c[3]), UrlPrd: url(c[4]) };
      if (!fila.UrlDev && !fila.UrlQa && !fila.UrlPrd) continue;
      if (!fila.Codigo && !fila.NombreServicio) continue;
      filas.push(fila);
    }
    return filas;
  }

  importar(): void {
    if (!this.puedeEditar || this.importando) return;
    const filas = this.filasImport;
    if (!filas.length) return;
    this.importando = true;
    this.errorImport = '';
    this.resultadoImport = null;
    this.aceServiciosService.importarBus10(this.tipoActivo, filas).subscribe({
      next: (r) => {
        this.importando = false;
        this.resultadoImport = r;
        this.cargar();
      },
      error: (err) => {
        this.importando = false;
        this.errorImport = err?.error?.error || 'No se pudo importar. Intenta de nuevo.';
      },
    });
  }

  eliminar(s: AceServicioInventario): void {
    if (!this.puedeEditar) return;
    if (!confirm(`¿Eliminar el servicio "${s.NombreServicio}"? Esta acción no se puede deshacer.`)) return;

    this.aceServiciosService.eliminar(s.Id).subscribe({
      next: () => {
        if (this.detalle?.Id === s.Id) this.detalle = null;
        this.cargar();
      },
      error: (err) => {
        console.error('Error al eliminar el servicio:', err);
        alert(err?.error?.error || 'No se pudo eliminar el servicio. Intenta de nuevo.');
      },
    });
  }
}
