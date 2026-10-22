import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ArchivoCompartido, ServidorNodo, ValidacionNodosService } from '../../core/services/validacion-nodos.service';
import { AuthService } from '../../services/auth.service';
import {
  ApuntamientoDeNodo,
  DetalleValidacionNodo,
  EstadoValidacion,
  NodoValidacion,
  ResultadoValidacionNodo,
  TipoDiferenciaNodo,
  ValidacionNodoDetalle,
  ValidacionNodoResumen,
} from '../../core/models/models';

type SistemaNodo = 'WINDOWS' | 'LINUX';
type FuenteArchivo = 'COMPARTIDA' | 'OTRA';

type FormNodo = {
  Sistema: SistemaNodo;
  Nombre: string;
  Host: string;
  PuertoSsh: number | null;
  UsuarioSsh: string;
  RutaArchivo: string;
  AplicacionId: number | null;
  Componente: string;
  PatronAce: string;
  PatronBus: string;
  Activo: boolean;
  CorregirAuto: boolean;
};

const FORM_VACIO: FormNodo = {
  Sistema: 'WINDOWS',
  Nombre: '',
  Host: '',
  PuertoSsh: null,
  UsuarioSsh: '',
  RutaArchivo: '',
  AplicacionId: null,
  Componente: '',
  PatronAce: 'cp4i-ace',
  PatronBus: 'busibm,:7843',
  Activo: true,
  CorregirAuto: false,
};

// Una ruta de red (UNC) empieza con \\ o //. Es lo que decide, en el backend,
// si el archivo se lee por carpeta compartida de Windows o por SSH (Linux).
function esUnc(ruta: string): boolean {
  return /^(\\\\|\/\/)/.test(ruta.trim());
}

// "C:\inetpub\...\appsettings.json" + host => "\\host\c$\inetpub\...\appsettings.json"
function construirUnc(host: string, ruta: string): string {
  const r = ruta.trim();
  if (!r || esUnc(r)) return r;
  const m = r.match(/^([A-Za-z]):[\\/]*(.*)$/);
  if (!m) return r;
  return `\\\\${host.trim()}\\${m[1].toLowerCase()}$\\${m[2].replace(/\//g, '\\')}`;
}

// Inversa: "\\host\c$\a\b" => "C:\a\b" (si el recurso es una unidad administrativa).
function uncALocal(unc: string): string {
  const m = unc.match(/^(?:\\\\|\/\/)[^\\/]+[\\/]([A-Za-z])\$[\\/](.*)$/);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : unc;
}

function normalizarTexto(t: string): string {
  return (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const PALABRAS_GENERICAS = new Set(['app', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'the']);

const ETIQUETA_ESTADO: Record<EstadoValidacion, string> = {
  OK: 'Sin diferencias',
  DIFERENCIAS: 'Con diferencias',
  CORREGIDO: 'Corregido',
  CORREGIDO_PARCIAL: 'Corregido (quedan diferencias)',
  ERROR: 'Error',
};

const ETIQUETA_TIPO: Record<TipoDiferenciaNodo, string> = {
  FALTANTE: 'Falta en la bitácora',
  SOBRANTE: 'Sobra en la bitácora',
  SIN_SERVICIO: 'Servicio no identificado',
  SIN_CATEGORIA: 'Categoría no identificada',
  CORREGIDO: 'Agregado a la bitácora',
};

// Pantalla "Validación de nodos": se registran los nodos (servidores) y el
// archivo de configuración donde está su apuntamiento; el backend los lee por
// SSH una vez al día, compara contra la Bitácora de Apuntamientos, agrega lo
// que falta (si el nodo tiene activada la corrección automática) y deja
// historial de cada corrida. Aquí también se puede probar / validar a demanda.
@Component({
  selector: 'app-validacion-nodos',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './validacion-nodos.component.html',
  styleUrl: './validacion-nodos.component.scss',
})
export class ValidacionNodosComponent implements OnInit {
  cargando = true;
  errorCarga: string | null = null;
  nodos: NodoValidacion[] = [];
  aplicaciones: { Id: number; Nombre: string }[] = [];
  puedeEditar = false;

  // Formulario de alta / edición
  mostrarForm = false;
  editandoId: number | null = null;
  form: FormNodo = { ...FORM_VACIO };
  guardando = false;
  errorForm: string | null = null;

  // Selector Aplicación -> Nodo -> Archivo (carpeta compartida central)
  fuenteArchivo: FuenteArchivo = 'COMPARTIDA';
  servidores: ServidorNodo[] = [];
  cargandoServidores = false;
  servidorSel: number | 'otro' | null = null;
  carpetaCompartida = '';
  archivosCompartidos: ArchivoCompartido[] = [];
  archivosSugeridos: ArchivoCompartido[] = [];
  archivosOtros: ArchivoCompartido[] = [];
  archivoSel: string | null = null;
  busquedaArchivo = '';
  cargandoArchivos = false;
  errorArchivos: string | null = null;
  listadoTruncado = false;
  private ultimoNombreAuto = '';
  private ultimoComponenteAuto = '';
  private rutaPendiente: string | null = null;

  // Resultado de "Probar" / "Validar ahora"
  nodoEnProceso: number | null = null;
  resultado: ResultadoValidacionNodo | null = null;
  resultadoNodo: NodoValidacion | null = null;
  errorResultado: string | null = null;
  aplicando = false;
  filtroTipo: TipoDiferenciaNodo | 'TODOS' = 'TODOS';

  // Historial de corridas
  historialNodo: NodoValidacion | null = null;
  historial: ValidacionNodoResumen[] = [];
  cargandoHistorial = false;
  validacionAbierta: ValidacionNodoDetalle | null = null;

  // Apuntamientos que tiene la bitácora para un nodo
  apuntamientosNodo: NodoValidacion | null = null;
  apuntamientos: ApuntamientoDeNodo[] = [];
  cargandoApuntamientos = false;
  errorApuntamientos: string | null = null;
  busquedaApuntamientos = '';

  ejecutandoTodos = false;
  mensajeGlobal: string | null = null;

  // Filtros de la lista principal
  filtroEstado: 'todos' | 'ok' | 'alerta' | 'error' | 'ninguno' = 'todos';
  busquedaNodos = '';

  constructor(
    private service: ValidacionNodosService,
    private authService: AuthService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('SERVICIOS');
    this.service.listarAplicaciones().subscribe({
      next: (apps) => (this.aplicaciones = apps),
      error: (err) => {
        console.error('No se pudieron cargar las aplicaciones:', err);
        this.errorCarga = err?.error?.error || 'No se pudo cargar la lista de aplicaciones.';
      },
    });
    this.cargar();
  }

  cargar(): void {
    this.cargando = true;
    this.errorCarga = null;
    this.service.listarNodos().subscribe({
      next: (nodos) => {
        this.nodos = nodos;
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al cargar los nodos:', err);
        this.errorCarga = err?.error?.error || 'No se pudieron cargar los nodos.';
        this.cargando = false;
      },
    });
  }

  // ---------- etiquetas ----------
  etiquetaEstado(e: EstadoValidacion | null | undefined): string {
    return e ? ETIQUETA_ESTADO[e] : 'Sin validar';
  }

  claseEstado(e: EstadoValidacion | null | undefined): string {
    switch (e) {
      case 'OK': case 'CORREGIDO': return 'estado--ok';
      case 'DIFERENCIAS': case 'CORREGIDO_PARCIAL': return 'estado--alerta';
      case 'ERROR': return 'estado--error';
      default: return 'estado--ninguno';
    }
  }

  // Agrupa el último estado en 4 grupos visuales (para colores y filtros).
  grupoEstado(e: EstadoValidacion | null | undefined): 'ok' | 'alerta' | 'error' | 'ninguno' {
    switch (e) {
      case 'OK': case 'CORREGIDO': return 'ok';
      case 'DIFERENCIAS': case 'CORREGIDO_PARCIAL': return 'alerta';
      case 'ERROR': return 'error';
      default: return 'ninguno';
    }
  }

  contarPorGrupo(grupo: 'ok' | 'alerta' | 'error' | 'ninguno'): number {
    return this.nodos.filter((n) => this.grupoEstado(n.UltimoEstado) === grupo).length;
  }

  nodosFiltrados(): NodoValidacion[] {
    const texto = this.busquedaNodos.trim().toLowerCase();
    return this.nodos.filter((n) => {
      if (this.filtroEstado !== 'todos' && this.grupoEstado(n.UltimoEstado) !== this.filtroEstado) return false;
      if (!texto) return true;
      return [n.Nombre, n.Host, n.AplicacionNombre, n.Componente, n.RutaArchivo]
        .some((v) => (v || '').toLowerCase().includes(texto));
    });
  }

  trackNodo(_i: number, n: NodoValidacion): number {
    return n.Id;
  }

  // La ruta puede ser de Windows (\\servidor\carpeta\archivo) o de Linux
  // (/ruta/archivo): se separa el nombre del archivo del resto para mostrarlo
  // destacado y no como una línea larguísima.
  nombreArchivo(ruta: string): string {
    const partes = (ruta || '').split(/[\\/]/).filter(Boolean);
    return partes.length ? partes[partes.length - 1] : (ruta || '—');
  }

  carpetaArchivo(ruta: string): string {
    const r = ruta || '';
    const indice = Math.max(r.lastIndexOf('\\'), r.lastIndexOf('/'));
    return indice > 0 ? r.slice(0, indice) : '';
  }

  etiquetaTipo(t: TipoDiferenciaNodo): string {
    return ETIQUETA_TIPO[t];
  }

  claseTipo(t: TipoDiferenciaNodo): string {
    switch (t) {
      case 'CORREGIDO': return 'estado--ok';
      case 'FALTANTE': return 'estado--alerta';
      case 'SOBRANTE': return 'tipo--sobrante';
      default: return 'estado--error';
    }
  }

  etiquetaCategoria(c: string | null): string {
    return c === 'BUS_INTEGRACION_10' ? 'Bus 10' : c === 'ACE' ? 'ACE' : '—';
  }

  formatearFecha(f: string | null): string {
    if (!f) return '—';
    const d = new Date(f);
    return isNaN(d.getTime()) ? f : d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  esVerdadero(v: boolean | number): boolean {
    return v === true || v === 1;
  }

  // ---------- formulario ----------
  abrirFormulario(nodo?: NodoValidacion): void {
    if (!this.puedeEditar) return;
    this.errorForm = null;
    if (nodo) {
      this.editandoId = nodo.Id;
      const windows = esUnc(nodo.RutaArchivo);
      this.form = {
        Sistema: windows ? 'WINDOWS' : 'LINUX',
        Nombre: nodo.Nombre,
        Host: nodo.Host,
        PuertoSsh: nodo.PuertoSsh,
        UsuarioSsh: nodo.UsuarioSsh || '',
        RutaArchivo: windows ? uncALocal(nodo.RutaArchivo) : nodo.RutaArchivo,
        AplicacionId: nodo.AplicacionId,
        Componente: nodo.Componente || '',
        PatronAce: nodo.PatronAce,
        PatronBus: nodo.PatronBus,
        Activo: this.esVerdadero(nodo.Activo),
        CorregirAuto: this.esVerdadero(nodo.CorregirAuto),
      };
    } else {
      this.editandoId = null;
      this.form = { ...FORM_VACIO };
    }
    this.reiniciarSelectores(nodo);
    this.mostrarForm = true;
  }

  cerrarFormulario(): void {
    this.mostrarForm = false;
  }

  // Ruta de red que realmente se va a leer (solo Windows), para mostrarla en el formulario.
  get rutaWindowsCalculada(): string {
    if (this.form.Sistema !== 'WINDOWS') return '';
    if (this.fuenteArchivo === 'COMPARTIDA') {
      return this.carpetaCompartida && this.archivoSel ? `${this.carpetaCompartida}\\${this.archivoSel}` : '';
    }
    return construirUnc(this.form.Host, this.form.RutaArchivo);
  }

  get usaCarpetaCompartida(): boolean {
    return this.form.Sistema === 'WINDOWS' && this.fuenteArchivo === 'COMPARTIDA';
  }

  // ---------- selector Aplicación -> Nodo -> Archivo ----------
  private reiniciarSelectores(nodo?: NodoValidacion): void {
    this.servidores = [];
    this.servidorSel = null;
    this.archivoSel = null;
    this.busquedaArchivo = '';
    this.errorArchivos = null;
    this.rutaPendiente = null;
    this.ultimoNombreAuto = '';
    this.ultimoComponenteAuto = '';
    if (nodo) {
      // Edición: se muestra como "otra ruta" hasta confirmar que el archivo está
      // en la carpeta compartida (al cargar el listado se cambia solo).
      this.fuenteArchivo = 'OTRA';
      this.rutaPendiente = esUnc(nodo.RutaArchivo) ? nodo.RutaArchivo : null;
      if (nodo.AplicacionId) this.cargarServidores(nodo.AplicacionId, nodo.Host);
    } else {
      this.fuenteArchivo = 'COMPARTIDA';
    }
    if (!nodo || this.rutaPendiente) this.cargarArchivos(false);
  }

  cambiarSistema(sistema: SistemaNodo): void {
    this.form.Sistema = sistema;
    if (sistema === 'WINDOWS' && !this.archivosCompartidos.length && !this.cargandoArchivos) this.cargarArchivos(false);
  }

  cambiarAplicacion(): void {
    this.servidorSel = null;
    this.servidores = [];
    if (this.form.AplicacionId) this.cargarServidores(this.form.AplicacionId);
    this.recalcularArchivos();
  }

  private cargarServidores(aplicacionId: number, hostActual?: string): void {
    this.cargandoServidores = true;
    this.service.listarServidoresDeAplicacion(aplicacionId).subscribe({
      next: (lista) => {
        this.servidores = lista;
        this.cargandoServidores = false;
        if (hostActual) {
          const s = lista.find((x) => x.IP === hostActual);
          this.servidorSel = s ? s.Id : 'otro';
        }
        this.recalcularArchivos();
      },
      error: () => (this.cargandoServidores = false),
    });
  }

  servidoresConApuntamientos: ServidorNodo[] = [];
  servidoresRestantes: ServidorNodo[] = [];

  elegirServidor(valor: number | 'otro' | null): void {
    this.servidorSel = valor;
    const s = typeof valor === 'number' ? this.servidores.find((x) => x.Id === valor) : null;
    if (s) {
      this.form.Host = s.IP;
      const app = this.aplicaciones.find((a) => a.Id === this.form.AplicacionId);
      const nombreAuto = `${app ? app.Nombre + ' — ' : ''}${s.Hostname}`;
      if (!this.form.Nombre.trim() || this.form.Nombre === this.ultimoNombreAuto) this.form.Nombre = nombreAuto;
      this.ultimoNombreAuto = nombreAuto;
      const compAuto = s.Componente || s.IP;
      if (!this.form.Componente.trim() || this.form.Componente === this.ultimoComponenteAuto) this.form.Componente = compAuto;
      this.ultimoComponenteAuto = compAuto;
    }
    this.recalcularArchivos();
  }

  cambiarFuente(f: FuenteArchivo): void {
    this.fuenteArchivo = f;
    if (f === 'COMPARTIDA' && !this.archivosCompartidos.length && !this.cargandoArchivos) this.cargarArchivos(false);
  }

  cargarArchivos(refrescar: boolean): void {
    this.cargandoArchivos = true;
    this.errorArchivos = null;
    this.service.listarCarpetaCompartida(refrescar).subscribe({
      next: (r) => {
        this.cargandoArchivos = false;
        this.carpetaCompartida = r.carpeta;
        this.archivosCompartidos = r.archivos;
        this.listadoTruncado = r.truncado;
        this.aplicarRutaPendiente();
        this.recalcularArchivos();
      },
      error: (err) => {
        this.cargandoArchivos = false;
        if (err?.error?.carpeta) this.carpetaCompartida = err.error.carpeta;
        this.errorArchivos = err?.error?.error || 'No se pudo leer la carpeta compartida.';
        this.aplicarRutaPendiente();
      },
    });
  }

  // Edición de un nodo: si su archivo está dentro de la carpeta compartida se
  // muestra seleccionado en la lista; si no, se queda como "otra ruta".
  private aplicarRutaPendiente(): void {
    const ruta = this.rutaPendiente;
    if (!ruta || !this.carpetaCompartida) return;
    this.rutaPendiente = null;
    const base = this.carpetaCompartida.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase() + '\\';
    const normal = ruta.replace(/\//g, '\\');
    if (!normal.toLowerCase().startsWith(base)) return;
    const relativa = normal.slice(base.length);
    if (!this.archivosCompartidos.some((a) => a.ruta.toLowerCase() === relativa.toLowerCase())) {
      this.archivosCompartidos = [...this.archivosCompartidos, { ruta: relativa, tamano: 0 }];
    }
    this.archivoSel = this.archivosCompartidos.find((a) => a.ruta.toLowerCase() === relativa.toLowerCase())!.ruta;
    this.fuenteArchivo = 'COMPARTIDA';
  }

  // Ordena los archivos: primero los que parecen de esta aplicación / nodo.
  recalcularArchivos(): void {
    const q = normalizarTexto(this.busquedaArchivo).split(/\s+/).filter(Boolean);
    const app = this.aplicaciones.find((a) => a.Id === this.form.AplicacionId);
    const tokens = app
      ? normalizarTexto(app.Nombre).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !PALABRAS_GENERICAS.has(t))
      : [];
    const srv = typeof this.servidorSel === 'number' ? this.servidores.find((x) => x.Id === this.servidorSel) : null;
    const ip = srv ? srv.IP : (this.form.Host || '').trim();
    const host = srv ? normalizarTexto(srv.Hostname) : '';
    const ultimo = ip.split('.').pop() || '';

    const puntaje = (ruta: string): number => {
      const r = normalizarTexto(ruta);
      let p = 0;
      for (const t of tokens) if (r.includes(t)) p += 2;
      if (ip && ip.includes('.') && r.includes(ip)) p += 4;
      else if (/^\d+$/.test(ultimo) && new RegExp(`(^|[^0-9])${ultimo}([^0-9]|$)`).test(r) && ip.includes('.')) p += 1;
      if (host && r.includes(host)) p += 4;
      return p;
    };

    const filtrados = this.archivosCompartidos.filter((a) => {
      const r = normalizarTexto(a.ruta);
      return q.every((w) => r.includes(w));
    });
    const conPuntaje = filtrados.map((a) => ({ a, p: puntaje(a.ruta) }));
    this.archivosSugeridos = conPuntaje.filter((x) => x.p > 0).sort((x, y) => y.p - x.p || x.a.ruta.localeCompare(y.a.ruta, 'es')).map((x) => x.a);
    this.archivosOtros = conPuntaje.filter((x) => x.p === 0).map((x) => x.a);
    this.servidoresConApuntamientos = this.servidores.filter((x) => x.Apuntamientos > 0);
    this.servidoresRestantes = this.servidores.filter((x) => !x.Apuntamientos);
  }

  elegirArchivo(ruta: string | null): void {
    this.archivoSel = ruta;
    this.errorForm = null;
  }

  etiquetaTamano(b: number): string {
    return b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`;
  }

  get rutaWindowsValida(): boolean {
    return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+[\\/].+/.test(this.rutaWindowsCalculada);
  }

  guardar(): void {
    if (!this.puedeEditar || this.guardando) return;
    const f = this.form;
    const windows = f.Sistema === 'WINDOWS';
    const sinRuta = windows && this.usaCarpetaCompartida ? !this.archivoSel : !f.RutaArchivo.trim();
    if (!f.Nombre.trim() || !f.Host.trim() || sinRuta || !f.AplicacionId) {
      this.errorForm = windows && this.usaCarpetaCompartida && !this.archivoSel && f.Nombre.trim() && f.Host.trim() && f.AplicacionId
        ? 'Elige el archivo de configuración de la lista (o cambia a "Otra ruta").'
        : 'Nombre, host, ruta del archivo y aplicación son obligatorios.';
      return;
    }
    if (windows && !this.rutaWindowsValida) {
      this.errorForm = 'La ruta debe ser como C:\\inetpub\\wwwroot\\MiApp\\appsettings.json (unidad, carpetas y archivo).';
      return;
    }
    if (!windows && !f.RutaArchivo.trim().startsWith('/')) {
      this.errorForm = 'En Linux la ruta debe empezar con / (ej. /opt/app/env_production).';
      return;
    }
    this.guardando = true;
    this.errorForm = null;
    const payload: Partial<NodoValidacion> = {
      Nombre: f.Nombre.trim(),
      Host: f.Host.trim(),
      PuertoSsh: !windows && f.PuertoSsh ? Number(f.PuertoSsh) : null,
      UsuarioSsh: !windows ? f.UsuarioSsh.trim() || null : null,
      RutaArchivo: windows ? this.rutaWindowsCalculada : f.RutaArchivo.trim(),
      AplicacionId: f.AplicacionId!,
      Componente: f.Componente.trim() || null,
      PatronAce: f.PatronAce.trim(),
      PatronBus: f.PatronBus.trim(),
      Activo: f.Activo,
      CorregirAuto: f.CorregirAuto,
    };
    const peticion = this.editandoId
      ? this.service.actualizarNodo(this.editandoId, payload)
      : this.service.crearNodo(payload);
    peticion.subscribe({
      next: () => {
        this.guardando = false;
        this.mostrarForm = false;
        this.cargar();
      },
      error: (err) => {
        this.guardando = false;
        this.errorForm = err?.error?.error || 'No se pudo guardar el nodo.';
      },
    });
  }

  eliminar(nodo: NodoValidacion): void {
    if (!this.puedeEditar) return;
    if (!confirm(`¿Eliminar el nodo "${nodo.Nombre}" y todo su historial de validaciones? Los apuntamientos de la bitácora no se tocan.`)) return;
    this.service.eliminarNodo(nodo.Id).subscribe({
      next: () => this.cargar(),
      error: (err) => (this.errorCarga = err?.error?.error || 'No se pudo eliminar el nodo.'),
    });
  }

  // ---------- probar / validar ----------
  probar(nodo: NodoValidacion): void {
    this.ejecutar(nodo, this.service.probar(nodo.Id));
  }

  validarAhora(nodo: NodoValidacion): void {
    this.ejecutar(nodo, this.service.validar(nodo.Id, false));
  }

  private ejecutar(nodo: NodoValidacion, peticion: ReturnType<ValidacionNodosService['probar']>): void {
    if (!this.puedeEditar || this.nodoEnProceso) return;
    this.nodoEnProceso = nodo.Id;
    this.errorCarga = null;
    peticion.subscribe({
      next: (r) => {
        this.nodoEnProceso = null;
        this.abrirResultado(nodo, r);
        if (r.validacionId) this.cargar();
      },
      error: (err) => {
        this.nodoEnProceso = null;
        this.errorCarga = err?.error?.error || 'No se pudo ejecutar la validación.';
      },
    });
  }

  private abrirResultado(nodo: NodoValidacion, r: ResultadoValidacionNodo): void {
    this.resultadoNodo = nodo;
    this.resultado = r;
    this.filtroTipo = 'TODOS';
    this.errorResultado = null;
  }

  cerrarResultado(): void {
    this.resultado = null;
    this.resultadoNodo = null;
  }

  get detalleFiltrado(): DetalleValidacionNodo[] {
    const d = this.resultado?.detalle || [];
    return this.filtroTipo === 'TODOS' ? d : d.filter((x) => x.Tipo === this.filtroTipo);
  }

  get tiposPresentes(): TipoDiferenciaNodo[] {
    const orden: TipoDiferenciaNodo[] = ['FALTANTE', 'CORREGIDO', 'SOBRANTE', 'SIN_SERVICIO', 'SIN_CATEGORIA'];
    const presentes = new Set((this.resultado?.detalle || []).map((d) => d.Tipo));
    return orden.filter((t) => presentes.has(t));
  }

  contarTipo(t: TipoDiferenciaNodo): number {
    return (this.resultado?.detalle || []).filter((d) => d.Tipo === t).length;
  }

  aplicarCorrecciones(): void {
    const nodo = this.resultadoNodo;
    const r = this.resultado;
    if (!nodo || !r || !this.puedeEditar || this.aplicando) return;
    if (!confirm(`Se van a AGREGAR ${r.faltantes} apuntamiento(s) a la bitácora de "${nodo.Nombre}" y quedarán registrados en el histórico. No se borra ni modifica nada existente. ¿Continuar?`)) return;
    this.aplicando = true;
    this.errorResultado = null;
    this.service.validar(nodo.Id, true).subscribe({
      next: (res) => {
        this.aplicando = false;
        this.abrirResultado(nodo, res);
        this.cargar();
      },
      error: (err) => {
        this.aplicando = false;
        this.errorResultado = err?.error?.error || 'No se pudieron aplicar las correcciones.';
      },
    });
  }

  ejecutarTodos(): void {
    if (!this.puedeEditar || this.ejecutandoTodos) return;
    if (!confirm('Se validarán ahora todos los nodos activos (los que tienen "Corregir automáticamente" también agregarán lo que falte). ¿Continuar?')) return;
    this.ejecutandoTodos = true;
    this.mensajeGlobal = null;
    this.service.ejecutarTodos().subscribe({
      next: (r) => {
        this.ejecutandoTodos = false;
        this.mensajeGlobal = r.omitido
          ? `No se ejecutó: ${r.omitido}`
          : r.error
            ? `Error: ${r.error}`
            : `Validación terminada: ${r.ejecutados?.length || 0} nodo(s) procesado(s).`;
        this.cargar();
      },
      error: (err) => {
        this.ejecutandoTodos = false;
        this.mensajeGlobal = err?.error?.error || 'No se pudo ejecutar la validación.';
      },
    });
  }

  // ---------- apuntamientos del nodo en la bitácora ----------
  verApuntamientos(nodo: NodoValidacion): void {
    this.apuntamientosNodo = nodo;
    this.apuntamientos = [];
    this.busquedaApuntamientos = '';
    this.errorApuntamientos = null;
    this.cargandoApuntamientos = true;
    this.service.listarApuntamientos(nodo.Id).subscribe({
      next: (r) => {
        this.apuntamientos = r.apuntamientos;
        this.cargandoApuntamientos = false;
      },
      error: (err) => {
        this.errorApuntamientos = err?.error?.error || 'No se pudieron cargar los apuntamientos del nodo.';
        this.cargandoApuntamientos = false;
      },
    });
  }

  cerrarApuntamientos(): void {
    this.apuntamientosNodo = null;
  }

  get apuntamientosFiltrados(): ApuntamientoDeNodo[] {
    const q = this.busquedaApuntamientos.trim().toLowerCase();
    if (!q) return this.apuntamientos;
    return this.apuntamientos.filter((a) =>
      [a.ServicioCodigo, a.ServicioNombre, a.Observaciones, this.etiquetaCategoria(a.Categoria)].some((v) => (v || '').toLowerCase().includes(q)));
  }

  irABitacora(nodo: NodoValidacion): void {
    this.router.navigate(['/apuntamientos/aplicacion', nodo.AplicacionId]);
  }

  // ---------- historial ----------
  verHistorial(nodo: NodoValidacion): void {
    this.historialNodo = nodo;
    this.historial = [];
    this.validacionAbierta = null;
    this.cargandoHistorial = true;
    this.service.listarValidaciones(nodo.Id).subscribe({
      next: (h) => {
        this.historial = h;
        this.cargandoHistorial = false;
      },
      error: () => (this.cargandoHistorial = false),
    });
  }

  abrirValidacion(v: ValidacionNodoResumen): void {
    this.service.obtenerValidacion(v.Id).subscribe({
      next: (d) => (this.validacionAbierta = d),
      error: (err) => console.error('No se pudo cargar la validación:', err),
    });
  }

  cerrarHistorial(): void {
    this.historialNodo = null;
    this.validacionAbierta = null;
  }

  irAHistoricoApuntamientos(): void {
    this.router.navigate(['/apuntamientos-historico']);
  }
}
