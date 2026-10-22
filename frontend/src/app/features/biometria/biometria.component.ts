import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import { AuthService } from '../../services/auth.service';
import { BiometriaService, ClienteResultado, FilaBiometria, LoteRespuesta, ResultadoBiometria } from '../../core/services/biometria.service';
/** Una línea de la respuesta del servicio de biometría ya traducida a lenguaje normal. */
interface FilaRespuesta { etiqueta: string; valor: string; nivel: number; grupo: boolean; destacada: boolean; }

type NivelBio = 'ok' | 'aviso' | 'mal' | 'nulo';

/** Lo que dice el servidor de biometría de una cédula, ya traducido. */
interface BioInfo {
  estado: 'consultando' | 'listo' | 'error' | 'invalido';
  nivel: NivelBio;
  titular: string;
  resumen: string;
  /** true = tiene biometría vigente, false = no la tiene, null = la respuesta no lo dice. */
  vigente: boolean | null;
  httpCodigo: number | null;
  error: string | null;
  json: unknown;
  cuerpo: string;
  filas: FilaRespuesta[];
}

interface ResumenBio { vigente: number; sinVigente: number; otras: number; errores: number; pendientes: number; consultadas: number; }

const POR_PAGINA = 50;
const TANDA = 12;
const TIPO_DOCUMENTO = 1;
const MAX_FILAS_RESPUESTA = 400;
const MAX_PROFUNDIDAD = 6;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ENMASCARADO = /^[xX*#•·\-.\s]+$|[xX*#•·]{2,}/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Nombre claro de los campos conocidos de la respuesta (clave en minúsculas). */
const ETIQUETAS_CAMPO: Record<string, string> = {
  tienebiometria: 'Tiene biometría vigente',
  intentosdia: 'Intentos de hoy',
  intentosmes: 'Intentos del mes',
  ultimocaso: 'Último caso',
  idestado: 'Id del estado',
  estado: 'Estado',
  regla: 'Regla aplicada',
  mensaje: 'Mensaje',
  message: 'Mensaje',
  code: 'Código',
  codigo: 'Código',
  idcaso: 'Caso',
  fecha: 'Fecha',
  fechacreo: 'Fecha de creación',
  descripcion: 'Descripción',
};

const MESES_ATRAS = (n: number): Date => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const aFechaLocal = (d: Date): string => formatDate(d, 'yyyy-MM-dd', 'en-US');

type Preset = 'hoy' | 'ayer' | '7' | '15' | '30' | 'mes';

@Component({
  selector: 'app-biometria',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './biometria.component.html',
  styleUrl: './biometria.component.scss',
})
export class BiometriaComponent implements OnInit, OnDestroy {
  puedeEditar = false;
  cargandoInicial = true;
  errorGeneral = '';

  // Filtro: SOLO fechas (FechaModificacion)
  desde = '';
  hasta = '';
  presetActivo: Preset | '' = '';
  consultando = false;
  errorConsulta = '';
  enEjecucionServidor = false;
  resultado: ResultadoBiometria | null = null;

  // Tabla
  paginaFilas: FilaBiometria[] = [];
  pagina = 1;
  totalPaginas = 1;
  expandida: string | null = null;
  /** Sección de clientes que ya tienen una biometría exitosa (descartados de la consulta). */
  verExitosas = false;
  limiteExitosas = 50;

  // Biometría de cada cédula (servidor de biometría)
  bio: Record<string, BioInfo> = {};
  resumenBio: ResumenBio = { vigente: 0, sinVigente: 0, otras: 0, errores: 0, pendientes: 0, consultadas: 0 };
  consultandoBio = false;
  hechosBio = 0;
  totalBio = 0;
  errorBio = '';
  comandoBio = '';
  crudoAbierto = false;
  comandoAbierto = false;
  copiado = false;
  private cola: string[] = [];
  private detener = false;
  private temporizadorCopia: ReturnType<typeof setTimeout> | null = null;

  constructor(private servicio: BiometriaService, private auth: AuthService) {}

  ngOnInit(): void {
    // Todo el módulo es de lectura: consulta cualquiera que lo tenga habilitado (también con rol Consulta).
    this.puedeEditar = this.auth.rolEnModulo('BIOMETRIA') !== null;
    this.elegirPreset('7');
    this.cargarUltimo();
  }

  ngOnDestroy(): void {
    this.detener = true;
    if (this.temporizadorCopia) clearTimeout(this.temporizadorCopia);
  }

  // ------------------------------------------------------------------
  // Carga inicial: lo último que consultó ESTA persona (queda en la memoria del servidor)
  // ------------------------------------------------------------------
  private cargarUltimo(): void {
    this.servicio.resultado().subscribe({
      next: (r) => {
        this.enEjecucionServidor = r.enEjecucion;
        if (r.resultado) {
          this.aplicarResultado(r.resultado);
          this.desde = r.resultado.filtro.desde;
          this.hasta = r.resultado.filtro.hasta;
          this.presetActivo = '';
        }
        this.cargandoInicial = false;
        this.errorGeneral = '';
      },
      error: (err) => { this.cargandoInicial = false; this.errorGeneral = err?.error?.error || 'No se pudo leer el resultado.'; },
    });
  }

  // ------------------------------------------------------------------
  // Filtro de fechas
  // ------------------------------------------------------------------
  elegirPreset(p: Preset): void {
    const hoy = new Date();
    switch (p) {
      case 'hoy': this.desde = aFechaLocal(hoy); this.hasta = aFechaLocal(hoy); break;
      case 'ayer': this.desde = aFechaLocal(MESES_ATRAS(1)); this.hasta = aFechaLocal(MESES_ATRAS(1)); break;
      case '7': this.desde = aFechaLocal(MESES_ATRAS(6)); this.hasta = aFechaLocal(hoy); break;
      case '15': this.desde = aFechaLocal(MESES_ATRAS(14)); this.hasta = aFechaLocal(hoy); break;
      case '30': this.desde = aFechaLocal(MESES_ATRAS(29)); this.hasta = aFechaLocal(hoy); break;
      case 'mes': this.desde = aFechaLocal(new Date(hoy.getFullYear(), hoy.getMonth(), 1)); this.hasta = aFechaLocal(hoy); break;
    }
    this.presetActivo = p;
  }

  cambioManual(): void { this.presetActivo = ''; }

  get rangoValido(): boolean {
    return RE_FECHA.test(this.desde) && RE_FECHA.test(this.hasta) && this.desde <= this.hasta;
  }

  consultar(): void {
    if (!this.puedeEditar || this.consultando || this.consultandoBio) return;
    if (!this.rangoValido) { this.errorConsulta = 'Elige un rango de fechas válido (Desde no puede ser posterior a Hasta).'; return; }
    this.consultando = true;
    this.errorConsulta = '';
    this.servicio.consultar({ desde: this.desde, hasta: this.hasta }).subscribe({
      next: (r) => {
        this.consultando = false;
        this.aplicarResultado(r.resultado);
        // La biometría de cada cédula se consulta sola (las credenciales ya están predefinidas en el servidor).
        if (r.resultado.pasos.documentos) this.iniciarBiometria(false);
      },
      error: (err) => {
        this.consultando = false;
        this.errorConsulta = err?.error?.error || 'No se pudo completar la consulta.';
      },
    });
  }

  private aplicarResultado(r: ResultadoBiometria): void {
    this.resultado = r;
    this.bio = {};
    this.cola = [];
    this.errorBio = '';
    this.expandida = null;
    // Si no queda nada por procesar, se abre de entrada la lista de clientes que ya tienen biometría exitosa.
    this.verExitosas = !r.filas.length && !!r.descartadas?.length;
    this.limiteExitosas = 50;
    this.pagina = 1;
    this.recalcularResumen();
    this.paginar();
  }

  // ------------------------------------------------------------------
  // Tabla
  // ------------------------------------------------------------------
  private paginar(): void {
    const filas = this.resultado?.filas ?? [];
    this.totalPaginas = Math.max(1, Math.ceil(filas.length / POR_PAGINA));
    this.pagina = Math.min(this.pagina, this.totalPaginas);
    this.paginaFilas = filas.slice((this.pagina - 1) * POR_PAGINA, this.pagina * POR_PAGINA);
  }

  cambiarPagina(delta: number): void {
    this.pagina = Math.min(Math.max(1, this.pagina + delta), this.totalPaginas);
    this.paginar();
  }

  alternar(f: FilaBiometria): void {
    this.expandida = this.expandida === f.clave ? null : f.clave;
    this.crudoAbierto = false;
    this.comandoAbierto = false;
  }

  trackFila = (_: number, f: FilaBiometria): string => f.clave;

  bioDe(f: FilaBiometria): BioInfo | null {
    return f.cc ? (this.bio[f.cc] ?? null) : null;
  }

  // ------------------------------------------------------------------
  // Biometría de las cédulas (curl en el servidor de biometría, por SSH)
  // ------------------------------------------------------------------
  private cedulasConsultables(soloSinResultado: boolean, filasBase?: FilaBiometria[]): string[] {
    const set = new Set<string>();
    for (const f of filasBase ?? this.resultado?.filas ?? []) {
      if (!f.documentoValido || !f.cc) continue;
      const b = this.bio[f.cc];
      if (soloSinResultado && b && (b.estado === 'listo' || b.estado === 'consultando')) continue;
      set.add(f.cc);
    }
    return [...set];
  }

  get hayPendientesBio(): boolean { return this.resumenBio.pendientes > 0 || this.resumenBio.errores > 0; }

  /** Consulta la biometría de las cédulas que aún no tienen respuesta (o de todas si `soloLasQueFaltan` es false). */
  iniciarBiometria(soloLasQueFaltan = true): void {
    if (!this.puedeEditar || this.consultandoBio || !this.resultado) return;
    const docs = this.cedulasConsultables(soloLasQueFaltan);
    if (!docs.length) return;
    this.cola = docs;
    this.totalBio = docs.length;
    this.hechosBio = 0;
    this.errorBio = '';
    this.detener = false;
    this.consultandoBio = true;
    this.siguienteTanda();
  }

  detenerBiometria(): void { this.detener = true; }

  /** Consulta en el servidor la biometría de los clientes que ya tenían un intento exitoso (solo informativo). */
  consultarExitosas(): void {
    if (!this.puedeEditar || this.consultandoBio || !this.resultado) return;
    const docs = this.cedulasConsultables(true, this.resultado.descartadas);
    if (!docs.length) return;
    this.cola = docs;
    this.totalBio = docs.length;
    this.hechosBio = 0;
    this.errorBio = '';
    this.detener = false;
    this.consultandoBio = true;
    this.siguienteTanda();
  }

  get hayExitosasSinConsultar(): boolean {
    return (this.resultado?.descartadas ?? []).some((f) => f.documentoValido && f.cc && !this.bio[f.cc]);
  }

  private siguienteTanda(): void {
    if (this.detener || !this.cola.length) { this.finBiometria(); return; }
    const tanda = this.cola.splice(0, TANDA);
    for (const d of tanda) this.bio[d] = this.bioConsultando();
    this.recalcularResumen();
    this.servicio.consultarLote(TIPO_DOCUMENTO, tanda).subscribe({
      next: (r) => {
        this.aplicarLote(tanda, r);
        this.hechosBio += tanda.length;
        if (r.fallaConexion) {
          // Sin conexión (p. ej. clave rechazada): no se insiste, para no bloquear la cuenta del servidor.
          this.errorBio = r.error || 'No se pudo llegar al servidor de biometría.';
          this.cola = [];
        }
        this.siguienteTanda();
      },
      error: (err) => {
        for (const d of tanda) this.bio[d] = this.bioError(err?.error?.error || 'No se pudo consultar la biometría.');
        this.errorBio = err?.error?.error || 'No se pudo consultar la biometría.';
        this.cola = [];
        this.finBiometria();
      },
    });
  }

  private finBiometria(): void {
    // Lo que no se llegó a consultar vuelve a «sin consultar»
    for (const d of this.cola) delete this.bio[d];
    this.cola = [];
    this.consultandoBio = false;
    this.recalcularResumen();
  }

  private aplicarLote(tanda: string[], r: LoteRespuesta): void {
    if (r.comando) this.comandoBio = r.comando;
    const porDoc = new Map<string, ClienteResultado>();
    for (const x of r.resultados) porDoc.set(x.documento, x);
    for (const d of tanda) {
      const x = porDoc.get(d);
      this.bio[d] = x ? this.traducir(x) : this.bioError('El servidor no devolvió respuesta para esta cédula.');
    }
    this.recalcularResumen();
  }

  /** Reintenta una sola cédula (por ejemplo, si falló). */
  reconsultar(f: FilaBiometria, ev: Event): void {
    ev.stopPropagation();
    if (!this.puedeEditar || this.consultandoBio || !f.cc || !f.documentoValido) return;
    this.cola = [f.cc];
    this.totalBio = 1;
    this.hechosBio = 0;
    this.errorBio = '';
    this.detener = false;
    this.consultandoBio = true;
    this.siguienteTanda();
  }

  private bioConsultando(): BioInfo {
    return { estado: 'consultando', nivel: 'nulo', titular: 'Consultando…', resumen: '', vigente: null, httpCodigo: null, error: null, json: null, cuerpo: '', filas: [] };
  }

  private bioError(mensaje: string): BioInfo {
    return { estado: 'error', nivel: 'mal', titular: 'No se pudo consultar', resumen: mensaje, vigente: null, httpCodigo: null, error: mensaje, json: null, cuerpo: '', filas: [] };
  }

  private recalcularResumen(): void {
    const r: ResumenBio = { vigente: 0, sinVigente: 0, otras: 0, errores: 0, pendientes: 0, consultadas: 0 };
    const vistas = new Set<string>();
    for (const f of this.resultado?.filas ?? []) {
      if (!f.documentoValido || !f.cc || vistas.has(f.cc)) continue;
      vistas.add(f.cc);
      const b = this.bio[f.cc];
      if (!b || b.estado === 'consultando') { r.pendientes += 1; continue; }
      if (b.estado === 'error') { r.errores += 1; continue; }
      r.consultadas += 1;
      if (b.vigente === true) r.vigente += 1;
      else if (b.vigente === false) r.sinVigente += 1;
      else r.otras += 1;
    }
    this.resumenBio = r;
  }

  // ------------------------------------------------------------------
  // Traducción de la respuesta del servicio de biometría
  // ------------------------------------------------------------------
  private traducir(x: ClienteResultado): BioInfo {
    const base = { httpCodigo: x.httpCodigo, json: x.json, cuerpo: x.cuerpo };
    if (x.etapa === 'validacion') {
      return { ...base, estado: 'invalido', nivel: 'nulo', titular: 'No se puede consultar', resumen: x.error || 'La cédula no es válida o viene enmascarada.', vigente: null, error: x.error, filas: [] };
    }
    if (x.etapa === 'ssh' && x.error) {
      return { ...base, estado: 'error', nivel: 'mal', titular: 'No se pudo llegar al servidor de biometría', resumen: x.error, vigente: null, error: x.error, filas: [] };
    }
    if (x.httpCodigo === null) {
      return { ...base, estado: 'error', nivel: 'mal', titular: 'El servidor de biometría no pudo consultar el servicio', resumen: x.error || '', vigente: null, error: x.error, filas: [] };
    }
    const filas: FilaRespuesta[] = [];
    if (x.json !== null && x.json !== undefined) this.aplanar(x.json, '', 0, filas);
    else if (x.cuerpo.trim()) filas.push({ etiqueta: 'Respuesta', valor: x.cuerpo.trim().slice(0, 4000), nivel: 0, grupo: false, destacada: true });

    const datos = this.buscarDatos(x.json);
    const vigente = datos && typeof datos['tieneBiometria'] === 'boolean' ? (datos['tieneBiometria'] as boolean) : this.leerBooleano(datos, 'tienebiometria');
    const resumen = this.armarResumen(datos);

    if (!x.ok) {
      const mensaje = this.textoMensaje(datos) || resumen;
      return {
        ...base, estado: 'listo', nivel: x.httpCodigo >= 500 ? 'mal' : 'aviso',
        titular: `El servicio respondió con un aviso o error (código ${x.httpCodigo})`, resumen: mensaje, vigente, error: null, filas,
      };
    }
    if (vigente === true) return { ...base, estado: 'listo', nivel: 'ok', titular: 'Tiene biometría vigente', resumen, vigente, error: null, filas };
    if (vigente === false) return { ...base, estado: 'listo', nivel: 'aviso', titular: 'No tiene biometría vigente', resumen, vigente, error: null, filas };
    return { ...base, estado: 'listo', nivel: 'ok', titular: 'El servicio respondió correctamente', resumen, vigente: null, error: null, filas };
  }

  /** Busca el objeto de la respuesta que trae los datos de biometría (la raíz o uno anidado, hasta 3 niveles). */
  private buscarDatos(json: unknown, nivel = 0): Record<string, unknown> | null {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      if (Array.isArray(json) && json.length && nivel < 3) return this.buscarDatos(json[0], nivel + 1);
      return null;
    }
    const obj = json as Record<string, unknown>;
    const claves = Object.keys(obj).map((k) => k.toLowerCase());
    if (claves.includes('tienebiometria') || claves.includes('intentosdia') || claves.includes('intentosmes')) return obj;
    if (nivel >= 3) return nivel === 0 ? obj : null;
    for (const v of Object.values(obj)) {
      if (v !== null && typeof v === 'object') {
        const r = this.buscarDatos(v, nivel + 1);
        if (r) return r;
      }
    }
    return nivel === 0 ? obj : null;
  }

  private campo(datos: Record<string, unknown> | null, nombre: string): unknown {
    if (!datos) return undefined;
    const k = Object.keys(datos).find((x) => x.toLowerCase() === nombre.toLowerCase());
    return k === undefined ? undefined : datos[k];
  }

  private leerBooleano(datos: Record<string, unknown> | null, nombre: string): boolean | null {
    const v = this.campo(datos, nombre);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') { const t = v.trim().toLowerCase(); if (t === 'true') return true; if (t === 'false') return false; }
    return null;
  }

  private textoMensaje(datos: Record<string, unknown> | null): string {
    const v = this.campo(datos, 'mensaje') ?? this.campo(datos, 'message');
    return typeof v === 'string' ? v.trim() : '';
  }

  /** «Hoy: 2 intento(s) · Este mes: 5 · Último caso 123 (Reintento)» + el mensaje del servicio si lo hay. */
  private armarResumen(datos: Record<string, unknown> | null): string {
    if (!datos) return '';
    const partes: string[] = [];
    const dia = this.campo(datos, 'intentosDia');
    const mes = this.campo(datos, 'intentosMes');
    if (dia !== undefined && dia !== null) partes.push(`Hoy: ${this.textoValor(dia)} intento(s)`);
    if (mes !== undefined && mes !== null) partes.push(`Este mes: ${this.textoValor(mes)}`);
    const u = this.campo(datos, 'ultimoCaso');
    if (u !== undefined && u !== null) {
      if (typeof u === 'object' && !Array.isArray(u)) {
        const o = u as Record<string, unknown>;
        const id = this.campo(o, 'idCaso') ?? this.campo(o, 'id') ?? this.campo(o, 'caso');
        const est = this.campo(o, 'estado') ?? this.campo(o, 'nombreEstado') ?? this.campo(o, 'descripcionEstado');
        const idEst = this.campo(o, 'idEstado');
        const e = est !== undefined && est !== null ? this.textoValor(est) : (idEst !== undefined && idEst !== null ? `estado ${this.textoValor(idEst)}` : '');
        partes.push(`Último caso${id !== undefined && id !== null ? ' ' + this.textoValor(id) : ''}${e ? ` (${e})` : ''}`);
      } else {
        const est = this.campo(datos, 'estado');
        const idEst = this.campo(datos, 'idEstado');
        const e = est !== undefined && est !== null && typeof est !== 'object' ? this.textoValor(est) : (idEst !== undefined && idEst !== null && typeof idEst !== 'object' ? `estado ${this.textoValor(idEst)}` : '');
        partes.push(`Último caso ${this.textoValor(u)}${e ? ` (${e})` : ''}`);
      }
    }
    const m = this.textoMensaje(datos);
    const base = partes.join(' · ');
    return m ? (base ? `${base} — ${m}` : m) : base;
  }

  private humanizar(clave: string): string {
    const conocida = ETIQUETAS_CAMPO[clave.toLowerCase()];
    if (conocida) return conocida;
    const t = clave.replace(/[_\-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : clave;
  }

  private textoValor(v: unknown): string {
    if (v === null || v === undefined) return '(sin dato)';
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    if (typeof v === 'string') {
      const t = v.trim();
      if (t === '') return '(vacío)';
      if (t.length > 300) return `(dato largo de ${t.length} caracteres: está completo en «Ver la respuesta completa»)`;
      if (ISO.test(t)) return formatDate(t, 'dd/MM/yyyy HH:mm:ss', 'en-US', 'UTC');
      return t;
    }
    return String(v);
  }

  /** Convierte el JSON de la respuesta en líneas «etiqueta: valor» (sin ocultar nada, solo traducido y ordenado). */
  private aplanar(valor: unknown, etiqueta: string, nivel: number, filas: FilaRespuesta[]): void {
    if (filas.length >= MAX_FILAS_RESPUESTA) return;
    const importante = (e: string) => /tienebiometria|intentos|ultimo|mensaje|message|descripci|resultado|result|estado|status|exito|success|error|valid|regla/i.test(e);
    if (Array.isArray(valor)) {
      if (etiqueta) filas.push({ etiqueta, valor: `${valor.length} elemento(s)`, nivel, grupo: true, destacada: false });
      valor.forEach((x, i) => {
        if (x !== null && typeof x === 'object') this.aplanar(x, `Elemento ${i + 1}`, nivel + (etiqueta ? 1 : 0), filas);
        else filas.push({ etiqueta: `Elemento ${i + 1}`, valor: this.textoValor(x), nivel: nivel + 1, grupo: false, destacada: false });
      });
      return;
    }
    if (valor !== null && typeof valor === 'object') {
      if (nivel >= MAX_PROFUNDIDAD) { filas.push({ etiqueta, valor: '(contenido anidado: ver la respuesta completa)', nivel, grupo: false, destacada: false }); return; }
      if (etiqueta) filas.push({ etiqueta, valor: '', nivel, grupo: true, destacada: false });
      for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
        const et = this.humanizar(k);
        if (v !== null && typeof v === 'object') this.aplanar(v, et, nivel + (etiqueta ? 1 : 0), filas);
        else if (filas.length < MAX_FILAS_RESPUESTA) filas.push({ etiqueta: et, valor: this.textoValor(v), nivel: nivel + (etiqueta ? 1 : 0), grupo: false, destacada: nivel <= 1 && importante(k) });
      }
      return;
    }
    filas.push({ etiqueta: etiqueta || 'Respuesta', valor: this.textoValor(valor), nivel, grupo: false, destacada: true });
  }

  /** Comando ejecutado para ESTA cédula (el backend devuelve la plantilla con <documento>). */
  comandoDe(f: FilaBiometria): string {
    return this.comandoBio.split('<documento>').join(f.cc ?? '');
  }

  /** Respuesta completa tal como llegó (JSON ordenado si se pudo leer). */
  respuestaCompleta(b: BioInfo): string {
    if (b.json !== null && b.json !== undefined) { try { return JSON.stringify(b.json, null, 2); } catch { /* usa el texto */ } }
    return b.cuerpo;
  }

  async copiarRespuesta(b: BioInfo): Promise<void> {
    const texto = this.respuestaCompleta(b);
    let ok = false;
    try { await navigator.clipboard.writeText(texto); ok = true; } catch {
      const area = document.createElement('textarea');
      area.value = texto; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      document.body.removeChild(area);
    }
    this.copiado = ok;
    if (this.temporizadorCopia) clearTimeout(this.temporizadorCopia);
    this.temporizadorCopia = setTimeout(() => { this.copiado = false; }, 2200);
  }

  // ------------------------------------------------------------------
  // Formato y exportación
  // ------------------------------------------------------------------
  // Las fechas de SQL Server no llevan zona: se muestran tal cual (UTC = el valor guardado).
  fechaSql(v: string | null | undefined): string {
    return v ? formatDate(v, 'dd/MM/yyyy HH:mm', 'en-US', 'UTC') : '—';
  }

  fechaCorta(v: string): string {
    return RE_FECHA.test(v) ? formatDate(`${v}T00:00:00`, 'dd/MM/yyyy', 'en-US') : v;
  }

  esEnmascarada(cc: string | null): boolean { return !!cc && ENMASCARADO.test(cc); }

  claseNivel(n: NivelBio): string {
    return n === 'ok' ? 'est-ok' : n === 'aviso' ? 'est-aviso' : n === 'mal' ? 'est-mal' : 'est-nulo';
  }

  exportarExcel(): void {
    const res = this.resultado;
    if (!res || !res.filas.length) return;
    const filas = res.filas.map((f) => {
      const b = this.bioDe(f);
      return {
        'Cédula': f.cc ?? null,
        'Nombre': f.nombre ?? null,
        'RadNumber': f.radNumber,
        'Solicitud': f.idSolicitud ?? null,
        'Fecha de modificación': f.fechaModificacion ? this.fechaSql(f.fechaModificacion) : null,
        'Caso': f.idCaso,
        'Estado del caso': f.estadoCaso ?? null,
        'Canal': f.idCanal ?? null,
        'Resultado en ORQBIOMETRIA': f.descripcionResultado ?? null,
        'Estado del resultado': f.estadoResultado ?? null,
        'Código de resultado': f.codigoResultado ?? null,
        'Último intento (caso)': f.ultimoCaso ?? null,
        'Estado del último intento': f.ultimoEstado ?? null,
        'Biometría en el servidor': !f.documentoValido ? 'No se puede consultar' : b ? b.titular : 'Sin consultar',
        'Detalle': b ? b.resumen : '',
      };
    });
    const p = res.pasos;
    const resumen: (string | number)[][] = [
      ['Consulta', formatDate(res.generado, 'dd/MM/yyyy HH:mm', 'en-US')],
      ['Fecha de modificación (desde)', this.fechaCorta(res.filtro.desde)],
      ['Fecha de modificación (hasta)', this.fechaCorta(res.filtro.hasta)],
      ['Solicitudes (IdEstadoBiometria 60, IdEstadoFirma 30)', p.solicitudes],
      ['Solicitudes sin caso en Firma.Detalle', p.solicitudesSinCaso],
      ['Casos en Firma.Detalle (IdCasoBiometria)', p.casosEnDetalle],
      [`Casos con «${res.resultadoOk}»`, p.casosConResultadoOk],
      ['Descartados: el último intento del cliente ya fue exitoso', p.descartadosPorExito],
      ['Cédulas distintas a consultar', p.documentos],
      ['Con biometría vigente', this.resumenBio.vigente],
      ['Sin biometría vigente', this.resumenBio.sinVigente],
    ];
    const exitosas = (res.descartadas ?? []).map((f) => {
      const b = this.bioDe(f);
      return {
        'Cédula': f.cc ?? null, 'Nombre': f.nombre ?? null, 'RadNumber': f.radNumber, 'Solicitud': f.idSolicitud ?? null,
        'Fecha de modificación': f.fechaModificacion ? this.fechaSql(f.fechaModificacion) : null,
        'Caso': f.idCaso, 'Estado del caso': f.estadoCaso ?? null, 'Último intento (caso)': f.ultimoCaso ?? null,
        'Estado del último intento': f.ultimoEstado ?? null,
        'Biometría en el servidor': !f.documentoValido ? 'No se puede consultar' : b ? b.titular : 'Sin consultar',
        'Detalle': b ? b.resumen : '',
      };
    });
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Biometría');
    if (exitosas.length) XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(exitosas), 'Ya exitosas');
    XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');
    XLSX.writeFile(libro, `biometria-${res.filtro.desde}-a-${res.filtro.hasta}.xlsx`);
  }
}
