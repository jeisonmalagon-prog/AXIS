import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import * as XLSX from 'xlsx';
import { AuthService } from '../../services/auth.service';
import {
  BiometriaService, ClienteLista, CriterioCliente, DatosFila, DetalleCliente, ServicioBiometria,
} from '../../core/services/biometria.service';
import { BioInfo, bioConsultando, bioError, humanizar, respuestaCompleta, traducirRespuesta } from './biometria-respuesta';

/** Una pareja «campo: valor» ya formateada para mostrar. */
interface Campo { et: string; val: string; mono: boolean; }
interface ResultadoVista { id: string; estado: string; titulo: string; nivel: Nivel; campos: Campo[]; }
interface CapturaVista { id: string; campos: Campo[]; resultados: ResultadoVista[]; }
interface CasoVista {
  id: string; estado: string; nivel: Nivel; fecha: string; canal: string; resumenResultados: string; cedulaOk: boolean;
  campos: Campo[]; capturas: CapturaVista[];
}
interface FirmaVista {
  radNumber: string; casos: string; estadoFirma: string; estadoBiometria: string; fecha: string;
  campos: Campo[]; camposDetalle: Campo[]; sinSolicitud: boolean;
}
interface ClienteVista { id: string; campos: Campo[]; }
interface Vista {
  clientes: ClienteVista[]; casos: CasoVista[]; firmas: FirmaVista[];
}

type Nivel = 'ok' | 'aviso' | 'mal' | 'nulo';
type Modo = 'bd' | 'servidor' | 'ambos';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const RE_DOC = /^[A-Za-z0-9]{3,25}$/;
const ENMASCARADO = /^[xX*#•·\-.\s]+$|[xX*#•·]{2,}/;
const RE_MONO = /(^id$|^id[A-Z_]|documento|numero|^rad|codigo|caso|captura|resultado$|cedula)/i;

/** Estados que se consideran buenos / malos por su nombre (sin tildes ni mayúsculas). */
const sinTildes = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function nivelEstado(nombre: string | null | undefined): Nivel {
  const n = sinTildes(nombre ?? '');
  if (!n) return 'nulo';
  if (/(\bno\b|fall|rechaz|error|fraud|bloquead|vencid|cancel)/.test(n)) return 'mal';
  if (/(exito|aprobad|finaliz|complet|ok\b)/.test(n)) return 'ok';
  return 'aviso';
}

const ETIQUETAS_CRITERIO: Record<CriterioCliente, { nombre: string; ayuda: string; ejemplo: string }> = {
  cc: { nombre: 'Cédula', ayuda: 'Escribe la cédula sin puntos. Se arma y se puede ejecutar el curl al servidor de biometría.', ejemplo: '1020304050' },
  nombre: { nombre: 'Nombre', ayuda: 'Basta con parte del nombre o apellido (mínimo 3 letras, sin importar tildes ni mayúsculas).', ejemplo: 'maria perez' },
  caso: { nombre: 'N.º de caso', ayuda: 'Id del caso de biometría (IdCasoBiometria). Muestra el cliente dueño de ese caso.', ejemplo: '123456' },
  radicado: { nombre: 'RadNumber', ayuda: 'Radicado de la solicitud de firma: se busca su caso en Firma.Detalle y de ahí el cliente.', ejemplo: 'RAD000123' },
};

@Component({
  selector: 'app-biometria-cliente',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './biometria-cliente.component.html',
  styleUrl: './biometria-cliente.component.scss',
})
export class BiometriaClienteComponent implements OnInit, OnDestroy {
  puedeEditar = false;
  readonly criterios = (Object.keys(ETIQUETAS_CRITERIO) as CriterioCliente[]).map((id) => ({ id, ...ETIQUETAS_CRITERIO[id] }));

  // Búsqueda
  criterio: CriterioCliente = 'cc';
  valor = '';
  tipoDocumento = 1;
  /** Dónde consultar: solo las bases de datos, solo el servidor de biometría (curl) o las dos cosas. */
  modo: Modo = 'ambos';
  buscando = false;
  errorBusqueda = '';
  clientes: ClienteLista[] | null = null;
  notaBusqueda = '';
  truncadoClientes = false;

  // Servicio / curl
  servicio: ServicioBiometria | null = null;
  errorServicio = '';
  copiadoCurl = false;
  private temporizador: ReturnType<typeof setTimeout> | null = null;

  // Cliente abierto
  ccAbierta = '';
  cargandoDetalle = false;
  errorDetalle = '';
  detalle: DetalleCliente | null = null;
  vista: Vista | null = null;
  casoAbierto: string | null = null;
  firmaAbierta: string | null = null;

  // Servidor de biometría
  consultandoServidor = false;
  errorServidor = '';
  servidorBio: BioInfo | null = null;
  servidorCurl = '';
  servidorDuracion = 0;
  servidorDoc = '';
  crudoAbierto = false;
  copiadoRespuesta = false;

  readonly modos: { id: Modo; nombre: string; ayuda: string }[] = [
    { id: 'ambos', nombre: 'Ambos', ayuda: 'Busca el cliente en las bases de datos y consulta también su biometría en el servidor.' },
    { id: 'bd', nombre: 'Solo bases de datos', ayuda: 'Solo ORQBIOMETRIA y MotorFirma: casos, resultados y firmas. No toca el servidor de biometría.' },
    { id: 'servidor', nombre: 'Solo servidor de biometría', ayuda: 'Solo el curl con la cédula al servicio de biometría. No consulta las bases de datos.' },
  ];

  constructor(private api: BiometriaService, private auth: AuthService, private ruta: ActivatedRoute) {}

  ngOnInit(): void {
    // Todo el módulo es de lectura: consulta cualquiera que lo tenga habilitado (también con rol Consulta).
    this.puedeEditar = this.auth.rolEnModulo('BIOMETRIA') !== null;
    this.api.servicio().subscribe({
      next: (s) => { this.servicio = s; this.tipoDocumento = s.tipoDocumentoPorDefecto || 1; },
      error: (err) => { this.errorServicio = err?.error?.error || 'No se pudo leer la configuración del servicio de biometría.'; },
    });
    // Enlace desde otras pantallas: /biometria?cc=123 abre directamente ese cliente (solo bases de datos).
    const cc = (this.ruta.snapshot.queryParamMap.get('cc') || '').replace(/[.,\s]/g, '');
    if (cc && RE_DOC.test(cc) && this.puedeEditar) {
      this.criterio = 'cc'; this.valor = cc; this.modo = 'bd';
      this.buscar();
    }
  }

  ngOnDestroy(): void { if (this.temporizador) clearTimeout(this.temporizador); }

  // ------------------------------------------------------------------
  // Formulario
  // ------------------------------------------------------------------
  get infoCriterio(): { nombre: string; ayuda: string; ejemplo: string } { return ETIQUETAS_CRITERIO[this.criterio]; }

  cambiarCriterio(): void { this.errorBusqueda = ''; }

  get infoModo(): { id: Modo; nombre: string; ayuda: string } { return this.modos.find((m) => m.id === this.modo) || this.modos[0]; }

  /** Solo el servidor necesita la cédula tal cual: se fija la búsqueda por cédula. */
  cambiarModo(m: Modo): void {
    this.modo = m;
    this.errorBusqueda = '';
    if (m === 'servidor') this.criterio = 'cc';
  }

  get usaServidor(): boolean { return this.modo !== 'bd'; }
  get usaBd(): boolean { return this.modo !== 'servidor'; }

  /** Valor limpio para la cédula (quita puntos, comas y espacios que se pegan al copiar). */
  private valorLimpio(): string {
    const v = this.valor.trim();
    return this.criterio === 'cc' ? v.replace(/[.,\s]/g, '') : v;
  }

  get cedulaValida(): boolean {
    const v = this.valorLimpio();
    return RE_DOC.test(v) && !ENMASCARADO.test(v);
  }

  get tipoValido(): boolean { return Number.isInteger(this.tipoDocumento) && this.tipoDocumento >= 1 && this.tipoDocumento <= 999; }

  get puedeBuscar(): boolean {
    if (!this.puedeEditar || this.buscando || this.cargandoDetalle || this.consultandoServidor) return false;
    const v = this.valorLimpio();
    if (this.modo === 'servidor') return this.cedulaValida && this.tipoValido;
    if (this.criterio === 'cc') return this.cedulaValida;
    if (this.criterio === 'nombre') return v.length >= 3;
    return v.length >= 1;
  }

  /** curl que se arma con la cédula escrita (solo cuando es una búsqueda por cédula). */
  get curlArmado(): string {
    const s = this.servicio;
    if (!s) return '';
    const doc = this.criterio === 'cc' && this.cedulaValida ? this.valorLimpio() : '<cédula>';
    return s.curlPlantilla.split('<tipoDocumento>').join(String(this.tipoValido ? this.tipoDocumento : 1)).split('<documento>').join(doc);
  }

  // ------------------------------------------------------------------
  // Búsqueda
  // ------------------------------------------------------------------
  buscar(): void {
    if (!this.puedeBuscar) return;
    const valor = this.valorLimpio();
    this.buscando = true;
    this.errorBusqueda = '';
    this.clientes = null;
    this.notaBusqueda = '';
    this.truncadoClientes = false;
    this.limpiarCliente();
    // Solo servidor: no se toca ninguna base de datos.
    if (this.modo === 'servidor') {
      this.buscando = false;
      this.consultarServidor(valor);
      return;
    }
    // Por cédula: se consulta directo el detalle (y el servidor) sin pasar por una lista.
    if (this.criterio === 'cc') {
      this.buscando = false;
      this.abrirCliente(valor);
      return;
    }
    this.api.buscarClientes(this.criterio, valor).subscribe({
      next: (r) => {
        this.buscando = false;
        this.clientes = r.clientes;
        this.notaBusqueda = r.nota || '';
        this.truncadoClientes = r.truncado;
        const docs = [...new Set(r.clientes.map((c) => c.cc).filter((c): c is string => !!c))];
        if (docs.length === 1) this.abrirCliente(docs[0]);
      },
      error: (err) => { this.buscando = false; this.errorBusqueda = err?.error?.error || 'No se pudo completar la búsqueda.'; },
    });
  }

  private limpiarCliente(): void {
    this.ccAbierta = '';
    this.detalle = null;
    this.vista = null;
    this.errorDetalle = '';
    this.casoAbierto = null;
    this.firmaAbierta = null;
    this.servidorBio = null;
    this.servidorCurl = '';
    this.errorServidor = '';
    this.crudoAbierto = false;
  }

  /** Abre un cliente por su cédula: trae su detalle y (si está marcado) consulta al servidor de biometría. */
  abrirCliente(cc: string | null): void {
    if (!cc || !this.puedeEditar) return;
    this.limpiarCliente();
    this.ccAbierta = cc;
    this.cargandoDetalle = true;
    this.api.detalleCliente(cc).subscribe({
      next: (d) => {
        this.cargandoDetalle = false;
        this.detalle = d;
        this.vista = this.armarVista(d);
        const primero = this.vista.casos[0];
        this.casoAbierto = primero ? primero.id : null;
      },
      error: (err) => { this.cargandoDetalle = false; this.errorDetalle = err?.error?.error || 'No se pudo leer el detalle del cliente.'; },
    });
    if (this.usaServidor && RE_DOC.test(cc) && !ENMASCARADO.test(cc)) this.consultarServidor(cc);
  }

  // ------------------------------------------------------------------
  // Servidor de biometría (curl por SSH)
  // ------------------------------------------------------------------
  /** Ejecuta el curl de esta cédula en el servidor de biometría. Si no se pasa cédula usa la escrita en el buscador. */
  consultarServidor(cc?: string): void {
    const doc = cc ?? (this.cedulaValida ? this.valorLimpio() : '');
    if (!doc || !this.puedeEditar || this.consultandoServidor || !this.tipoValido) return;
    this.consultandoServidor = true;
    this.errorServidor = '';
    this.servidorBio = bioConsultando();
    this.servidorDoc = doc;
    this.crudoAbierto = false;
    this.api.consultarServidor(this.tipoDocumento, doc).subscribe({
      next: (r) => {
        this.consultandoServidor = false;
        this.servidorCurl = r.curl;
        this.servidorDuracion = r.duracionMs;
        if (r.fallaConexion) this.errorServidor = r.error || 'No se pudo llegar al servidor de biometría.';
        this.servidorBio = r.resultado ? traducirRespuesta(r.resultado) : bioError(r.error || 'El servidor no devolvió respuesta.');
      },
      error: (err) => {
        this.consultandoServidor = false;
        const m = err?.error?.error || 'No se pudo consultar el servidor de biometría.';
        this.errorServidor = m;
        this.servidorBio = bioError(m);
      },
    });
  }

  respuestaCompleta(b: BioInfo): string { return respuestaCompleta(b); }

  claseNivel(n: Nivel): string { return n === 'ok' ? 'est-ok' : n === 'aviso' ? 'est-aviso' : n === 'mal' ? 'est-mal' : 'est-nulo'; }

  async copiar(texto: string, que: 'curl' | 'respuesta'): Promise<void> {
    let ok = false;
    try { await navigator.clipboard.writeText(texto); ok = true; } catch {
      const area = document.createElement('textarea');
      area.value = texto; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      document.body.removeChild(area);
    }
    if (que === 'curl') this.copiadoCurl = ok; else this.copiadoRespuesta = ok;
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => { this.copiadoCurl = false; this.copiadoRespuesta = false; }, 2200);
  }

  // ------------------------------------------------------------------
  // Vista (formateo de lo que llega del backend)
  // ------------------------------------------------------------------
  private formato(v: string | number | boolean | null): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (typeof v === 'string' && ISO.test(v)) return formatDate(v, 'dd/MM/yyyy HH:mm:ss', 'en-US', 'UTC');
    return String(v);
  }

  private campos(datos: DatosFila | null | undefined): Campo[] {
    if (!datos) return [];
    return Object.entries(datos).map(([k, v]) => ({ et: humanizar(k), val: this.formato(v), mono: RE_MONO.test(k) }));
  }

  private buscarClave(datos: DatosFila | null | undefined, re: RegExp): string {
    if (!datos) return '—';
    const k = Object.keys(datos).find((x) => re.test(x));
    return k ? this.formato(datos[k]) : '—';
  }

  private armarVista(d: DetalleCliente): Vista {
    const casos: CasoVista[] = d.casos.map((c) => {
      const capturas: CapturaVista[] = c.capturas.map((cap) => ({
        id: cap.id || '—',
        campos: this.campos(cap.datos),
        resultados: cap.resultados.map((r) => {
          const desc = this.buscarClave(r.datos, /^descripcionResultado$/i);
          return { id: r.id || '—', estado: r.estado || '—', titulo: desc !== '—' ? desc : `Resultado ${r.id ?? ''}`, nivel: nivelEstado(r.estado), campos: this.campos(r.datos) };
        }),
      }));
      const descripciones = [...new Set(capturas.flatMap((cap) => cap.resultados.map((r) => r.titulo)))];
      return {
        id: c.id, estado: c.estado || 'Sin estado', nivel: nivelEstado(c.estado),
        fecha: this.buscarClave(c.datos, /fecha|creaci|date|created/i), canal: this.buscarClave(c.datos, /^idCanal$|^canal$/i),
        resumenResultados: descripciones.length ? descripciones.join(' · ') : (capturas.length ? 'Sin resultados' : 'Sin capturas'),
        cedulaOk: descripciones.some((t) => /cedula original ok/i.test(sinTildes(t))),
        campos: this.campos(c.datos), capturas,
      };
    });
    const firmas: FirmaVista[] = d.firmas.filas.map((f) => ({
      radNumber: f.radNumber, casos: f.casos.join(', '),
      estadoFirma: this.buscarClave(f.solicitud, /^idEstadoFirma$/i), estadoBiometria: this.buscarClave(f.solicitud, /^idEstadoBiometria$/i),
      fecha: this.buscarClave(f.solicitud, /^fechaModificacion$/i),
      campos: this.campos(f.solicitud), camposDetalle: this.campos(f.detalle), sinSolicitud: !f.solicitud,
    }));
    const clientes: ClienteVista[] = d.clientes.map((c) => ({ id: c.id, campos: this.campos(c.datos) }));
    return { clientes, casos, firmas };
  }

  alternarCaso(id: string): void { this.casoAbierto = this.casoAbierto === id ? null : id; }
  alternarFirma(id: string): void { this.firmaAbierta = this.firmaAbierta === id ? null : id; }
  trackCaso = (_: number, c: CasoVista): string => c.id;
  trackFirma = (_: number, f: FirmaVista): string => f.radNumber;

  get nombreCliente(): string {
    const c = this.vista?.clientes[0];
    const f = c?.campos.find((x) => x.et.toLowerCase() === 'nombre');
    return f && f.val !== '—' ? f.val : 'Cliente';
  }

  get tiempos(): string {
    return (this.detalle?.etapas ?? []).map((e) => `${e.etapa} ${(e.ms / 1000).toFixed(1)} s`).join(' · ');
  }

  fechaHora(v: string): string { return v ? formatDate(v, 'dd/MM/yyyy HH:mm', 'en-US') : ''; }

  // ------------------------------------------------------------------
  // Excel
  // ------------------------------------------------------------------
  exportarExcel(): void {
    const d = this.detalle;
    const v = this.vista;
    if (!d || !v) return;
    const casos = v.casos.flatMap((c) => {
      const base = { 'Caso': c.id, 'Estado': c.estado, 'Fecha': c.fecha, 'Canal': c.canal };
      if (!c.capturas.length) return [{ ...base, 'Captura': '', 'Resultado': '', 'Estado del resultado': '' }];
      return c.capturas.flatMap((cap) => {
        if (!cap.resultados.length) return [{ ...base, 'Captura': cap.id, 'Resultado': '', 'Estado del resultado': '' }];
        return cap.resultados.map((r) => ({ ...base, 'Captura': cap.id, 'Resultado': r.titulo, 'Estado del resultado': r.estado }));
      });
    });
    const firmas = v.firmas.map((f) => ({ 'RadNumber': f.radNumber, 'Casos': f.casos, 'Estado de firma': f.estadoFirma, 'Estado de biometría': f.estadoBiometria, 'Modificación': f.fecha }));
    const cliente = v.clientes.flatMap((c) => c.campos.map((x) => ({ 'Cliente (id)': c.id, 'Campo': x.et, 'Valor': x.val })));
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(cliente), 'Cliente');
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(casos), 'Casos');
    if (firmas.length) XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(firmas), 'Firmas');
    XLSX.writeFile(libro, `biometria-cliente-${d.cc}.xlsx`);
  }
}
