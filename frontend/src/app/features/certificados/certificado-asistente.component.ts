import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  CatalogoUbicaciones,
  CertificadoService,
  ComponenteCatalogo,
  ServidorCatalogo,
} from '../../core/services/certificado.service';
import { SelectorBuscableComponent, OpcionSelector } from '../../shared/selector-buscable/selector-buscable.component';
import { GrupoCertificado, idDe, soloFecha } from './certificado-grupo';

export type ModoAsistente = 'nuevo' | 'editar' | 'renovar';

// Datos que ya se conocen de antemano (por ejemplo, lo leído de un contenedor en Portainer): se vuelcan sobre el
// formulario y la persona los revisa antes de guardar. Nada se guarda por sí solo.
export interface PrecargaCertificado {
  datos?: Partial<DatosCertificado>;
  // Dónde está instalado: servidor del inventario + nombre del sub-aplicativo (si no existe, se ofrece registrarlo).
  ubicacion?: { servidorId: number; componente: string | null; puerto: number | null };
}

// Una ubicación = dónde está instalado el certificado: servidor + componente.
// rowId = fila ya guardada en la base (null = todavía no existe).
interface Ubicacion {
  rowId: number | null;
  servidorId: number | null;
  hostname: string;
  ip: string;
  componente: string | null;
  puerto: number | null;
  // Certificados de antes (solo ligados a una aplicación): sin servidor/componente.
  legadoApp: string | null;
  quitar: boolean;
  // Aplicaciones de negocio que aún se pueden asociar (se recalcula al entrar al paso 3).
  opcionesApps: OpcionSelector[];
}

export interface DatosCertificado {
  NombreComun: string;
  EntidadEmisora: string;
  NumeroSerie: string;
  Thumbprint: string;
  FechaInicio: string;
  FechaFin: string;
  Responsable: string;
  Observaciones: string;
}

@Component({
  selector: 'app-certificado-asistente',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, SelectorBuscableComponent],
  templateUrl: './certificado-asistente.component.html',
  styleUrl: './certificado-asistente.component.scss',
})
export class CertificadoAsistenteComponent implements OnInit {
  @Input() grupo: GrupoCertificado | null = null;
  @Input() modo: ModoAsistente = 'nuevo';
  @Input() catalogo: CatalogoUbicaciones | null = null;
  // Certificados ya registrados (para el atajo "agregar a uno que ya existe").
  @Input() grupos: GrupoCertificado[] = [];
  @Input() precarga: PrecargaCertificado | null = null;

  @Output() cerrar = new EventEmitter<void>();
  @Output() guardado = new EventEmitter<void>();

  readonly pasos = [
    { n: 1, titulo: 'El certificado' },
    { n: 2, titulo: '¿Dónde está instalado?' },
    { n: 3, titulo: 'Aplicaciones de negocio' },
    { n: 4, titulo: 'Revisar y guardar' },
  ];

  paso = 1;
  modoActual: ModoAsistente = 'nuevo';
  grupoOrigen: GrupoCertificado | null = null;

  datos: DatosCertificado = this.datosVacios();
  ubicaciones: Ubicacion[] = [];

  // --- paso 2: agregar ubicaciones ---
  servidorSel: number | null = null;
  seleccion: Record<number, boolean> = {};
  registrando = false;
  nuevoComp: { rol: string; puerto: number | null; tipo: string; apps: number[] } = { rol: '', puerto: null, tipo: '', apps: [] };
  ocupado = false;

  // --- mensajes ---
  errorPaso: string | null = null;
  avisoPaso: string | null = null;
  erroresGuardado: string[] = [];
  guardando = false;
  // true en cuanto algo se guardó/quitó: al cerrar, la lista debe refrescarse.
  private huboCambios = false;

  constructor(private certificadoService: CertificadoService) {}

  ngOnInit(): void {
    this.modoActual = this.modo;
    if (this.grupo) this.cargarGrupo(this.grupo, this.modo);
    this.armarOpciones();
    if (this.catalogo) this.aplicarPrecarga();
    // Si por alguna razón el catálogo no llegó, se pide aquí.
    if (!this.catalogo) {
      this.certificadoService.catalogoUbicaciones().subscribe({
        next: (c) => { this.catalogo = c; this.armarOpciones(); this.aplicarPrecarga(); },
        error: () => (this.errorPaso = 'No se pudo cargar la lista de servidores. Cierra e intenta de nuevo.'),
      });
    }
  }

  // Vuelca los datos conocidos sobre el formulario y deja lista la ubicación (servidor + sub-aplicativo).
  private aplicarPrecarga(): void {
    const p = this.precarga;
    if (!p) return;
    if (p.datos) {
      for (const k of Object.keys(p.datos) as (keyof DatosCertificado)[]) {
        const v = p.datos[k];
        if (v !== undefined && v !== null) this.datos[k] = String(v);
      }
    }
    const u = p.ubicacion;
    if (!u) return;
    const srv = (this.catalogo?.servidores || []).find((s) => s.id === u.servidorId);
    if (!srv) return;
    this.servidorSel = srv.id;
    const nombre = (u.componente || '').trim().toLowerCase();
    const comp = srv.componentes.find((c) => c.rol.toLowerCase() === nombre)
      || (u.puerto ? srv.componentes.find((c) => c.puerto === u.puerto && !nombre) : undefined);
    if (comp) {
      if (!this.yaAgregado(comp)) this.colocarUbicacion(srv, comp);
      this.avisoPaso = `Servidor y sub-aplicativo precargados: ${srv.hostname} · ${comp.rol}. Revisa los datos y continúa.`;
    } else if (u.componente) {
      // El sub-aplicativo todavía no está en el inventario: se deja el formulario de registro listo para confirmarlo.
      this.registrando = true;
      this.nuevoComp = { rol: u.componente, puerto: u.puerto ?? null, tipo: '', apps: [] };
      this.refrescarOpcionesAppsNuevo();
      this.avisoPaso = `«${u.componente}» aún no es un sub-aplicativo de ${srv.hostname}: confirma su registro en el paso 2.`;
    }
  }

  private datosVacios(): DatosCertificado {
    return {
      NombreComun: '', EntidadEmisora: '', NumeroSerie: '', Thumbprint: '',
      FechaInicio: '', FechaFin: '', Responsable: '', Observaciones: '',
    };
  }

  // Carga un certificado ya registrado (todas sus ubicaciones) para editarlo o renovarlo.
  cargarGrupo(g: GrupoCertificado, modo: ModoAsistente): void {
    this.grupoOrigen = g;
    this.modoActual = modo;
    this.paso = 1;
    this.errorPaso = null;
    this.avisoPaso = null;
    this.datos = {
      NombreComun: g.nombreComun || '',
      EntidadEmisora: g.entidadEmisora || '',
      // En una renovación lo normal es que cambien serie, thumbprint y fechas.
      NumeroSerie: modo === 'renovar' ? '' : g.numeroSerie || '',
      Thumbprint: modo === 'renovar' ? '' : g.thumbprint || '',
      FechaInicio: modo === 'renovar' ? '' : g.fechaInicio,
      FechaFin: modo === 'renovar' ? '' : g.fechaFin,
      Responsable: g.responsable || '',
      Observaciones: g.observaciones || '',
    };
    this.ubicaciones = g.filas.map((f: any) => ({
      rowId: idDe(f),
      servidorId: f.ServidorId ?? null,
      hostname: f.Hostname || '',
      ip: f.IP || '',
      componente: f.Componente || null,
      puerto: f.Puerto ?? null,
      legadoApp: !f.ServidorId || !f.Componente ? f.Aplicacion || null : null,
      quitar: false,
      opcionesApps: [],
    }));
    // Una fila a medias (sin servidor o sin componente) se trata como pendiente.
    for (const u of this.ubicaciones) {
      if (!u.servidorId || !u.componente) { u.servidorId = null; u.componente = null; }
    }
    this.armarOpciones();
  }

  get titulo(): string {
    if (this.modoActual === 'renovar') return 'Renovar certificado';
    if (this.modoActual === 'editar') return 'Editar certificado';
    return 'Nuevo certificado';
  }

  // ======================================================== atajo: ya existe
  // Las listas de opciones se arman una sola vez (y se rehacen solo cuando
  // cambian los datos): si fueran getters devolverían un arreglo nuevo en cada
  // ciclo de detección de cambios y los selectores se reiniciarían sin parar.
  opcionesGruposExistentes: OpcionSelector[] = [];
  opcionesServidores: OpcionSelector[] = [];
  opcionesAplicaciones: OpcionSelector[] = [];
  opcionesAppsNuevo: OpcionSelector[] = [];

  private armarOpciones(): void {
    this.opcionesGruposExistentes = this.grupos.map((g) => ({
      id: g.clave,
      nombre: g.nombreComun || '(sin nombre común)',
      subtitulo: `${g.entidadEmisora || 'Emisor desconocido'} · vence ${g.fechaFin || 'sin fecha'} · ${g.filas.length} ubicación(es)`,
    }));
    this.opcionesServidores = (this.catalogo?.servidores || []).map((s) => ({
      id: s.id,
      nombre: s.hostname,
      subtitulo: `${s.ip}${s.ambiente ? ' · ' + s.ambiente : ''}`,
    }));
    this.opcionesAplicaciones = (this.catalogo?.aplicaciones || []).map((a) => ({ id: a.id, nombre: a.nombre }));
    this.refrescarOpcionesAppsNuevo();
    this.refrescarOpcionesApps();
  }

  private refrescarOpcionesAppsNuevo(): void {
    this.opcionesAppsNuevo = this.opcionesAplicaciones.filter((o) => !this.nuevoComp.apps.includes(o.id));
  }

  private refrescarOpcionesApps(): void {
    for (const u of this.ubicaciones) {
      const ya = new Set(this.appsDe(u).map((a) => a.id));
      u.opcionesApps = this.opcionesAplicaciones.filter((o) => !ya.has(o.id));
    }
  }

  agregarAExistente(clave: any): void {
    if (clave == null) return;
    const g = this.grupos.find((x) => x.clave === clave);
    if (g) this.cargarGrupo(g, 'editar');
  }

  // ====================================================== catálogo / búsquedas
  get servidorCat(): ServidorCatalogo | undefined {
    return (this.catalogo?.servidores || []).find((s) => s.id === this.servidorSel);
  }

  componenteDe(u: Ubicacion): ComponenteCatalogo | undefined {
    if (!u.servidorId || !u.componente) return undefined;
    const srv = (this.catalogo?.servidores || []).find((s) => s.id === u.servidorId);
    const clave = u.componente.toLowerCase();
    return srv?.componentes.find((c) => c.rol.toLowerCase() === clave);
  }

  appsDe(u: Ubicacion): { id: number; nombre: string }[] {
    return this.componenteDe(u)?.aplicaciones || [];
  }

  get activas(): Ubicacion[] {
    return this.ubicaciones.filter((u) => !u.quitar && u.servidorId && u.componente);
  }

  get pendientesLegado(): Ubicacion[] {
    return this.ubicaciones.filter((u) => !u.quitar && (!u.servidorId || !u.componente));
  }

  get quitadas(): Ubicacion[] {
    return this.ubicaciones.filter((u) => u.quitar && u.rowId);
  }

  get nuevas(): Ubicacion[] {
    return this.activas.filter((u) => !u.rowId);
  }

  // Aplicaciones de negocio afectadas (sin repetir) y en cuántas ubicaciones aparece cada una.
  get appsAfectadas(): { nombre: string; ubicaciones: number }[] {
    const mapa = new Map<number, { nombre: string; ubicaciones: number }>();
    for (const u of this.activas) {
      for (const a of this.appsDe(u)) {
        const e = mapa.get(a.id) || { nombre: a.nombre, ubicaciones: 0 };
        e.ubicaciones++;
        mapa.set(a.id, e);
      }
    }
    return Array.from(mapa.values()).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  get ubicacionesSinApp(): Ubicacion[] {
    return this.activas.filter((u) => this.appsDe(u).length === 0);
  }

  // ====================================================== paso 2: ubicaciones
  onServidorChange(id: any): void {
    this.servidorSel = id != null && id !== '' ? Number(id) : null;
    this.seleccion = {};
    this.registrando = false;
    this.errorPaso = null;
    this.avisoPaso = null;
    const comps = this.servidorCat?.componentes || [];
    // Si el servidor tiene un único componente que aún no se agregó, queda marcado.
    if (comps.length === 1 && !this.yaAgregado(comps[0])) this.seleccion[comps[0].id] = true;
  }

  yaAgregado(c: ComponenteCatalogo): boolean {
    const clave = c.rol.toLowerCase();
    return this.ubicaciones.some(
      (u) => !u.quitar && u.servidorId === this.servidorSel && (u.componente || '').toLowerCase() === clave
    );
  }

  get totalSeleccionados(): number {
    return Object.keys(this.seleccion).filter((k) => this.seleccion[Number(k)]).length;
  }

  alternarSeleccion(c: ComponenteCatalogo): void {
    if (this.yaAgregado(c)) return;
    this.seleccion[c.id] = !this.seleccion[c.id];
  }

  agregarSeleccionados(): void {
    const srv = this.servidorCat;
    if (!srv) return;
    for (const c of srv.componentes) {
      if (this.seleccion[c.id] && !this.yaAgregado(c)) this.colocarUbicacion(srv, c);
    }
    this.seleccion = {};
    this.errorPaso = null;
    this.avisoPaso = null;
  }

  private colocarUbicacion(srv: ServidorCatalogo, c: ComponenteCatalogo): void {
    const clave = c.rol.toLowerCase();
    // 1) Si esa ubicación ya existía y se había quitado, solo se "des-quita".
    const quitada = this.ubicaciones.find(
      (u) => u.quitar && u.servidorId === srv.id && (u.componente || '').toLowerCase() === clave
    );
    if (quitada) { quitada.quitar = false; return; }
    // 2) Si hay una fila de antes sin ubicación definida, esta ubicación la completa.
    const huerfana = this.ubicaciones.find((u) => !u.quitar && u.rowId && (!u.servidorId || !u.componente));
    if (huerfana) {
      huerfana.servidorId = srv.id;
      huerfana.hostname = srv.hostname;
      huerfana.ip = srv.ip;
      huerfana.componente = c.rol;
      huerfana.puerto = c.puerto;
      return;
    }
    this.ubicaciones.push({
      rowId: null, servidorId: srv.id, hostname: srv.hostname, ip: srv.ip,
      componente: c.rol, puerto: c.puerto, legadoApp: null, quitar: false, opcionesApps: [],
    });
  }

  quitarUbicacion(u: Ubicacion): void {
    if (u.rowId) {
      u.quitar = true; // se borra de verdad al guardar (se puede deshacer antes)
    } else {
      this.ubicaciones = this.ubicaciones.filter((x) => x !== u);
    }
  }

  deshacerQuitar(u: Ubicacion): void {
    u.quitar = false;
  }

  // ---- registrar un componente nuevo en el servidor elegido
  abrirRegistro(): void {
    this.registrando = true;
    this.nuevoComp = { rol: '', puerto: null, tipo: '', apps: [] };
    this.refrescarOpcionesAppsNuevo();
    this.errorPaso = null;
    this.avisoPaso = null;
  }

  agregarAppNueva(id: any): void {
    if (id == null) return;
    const n = Number(id);
    if (!this.nuevoComp.apps.includes(n)) this.nuevoComp.apps.push(n);
    this.refrescarOpcionesAppsNuevo();
  }

  quitarAppNueva(id: number): void {
    this.nuevoComp.apps = this.nuevoComp.apps.filter((x) => x !== id);
    this.refrescarOpcionesAppsNuevo();
  }

  nombreApp(id: number): string {
    return (this.catalogo?.aplicaciones || []).find((a) => a.id === id)?.nombre || `#${id}`;
  }

  async registrarComponenteNuevo(): Promise<void> {
    const srv = this.servidorCat;
    if (!srv) return;
    const rol = this.nuevoComp.rol.trim();
    if (!rol) { this.errorPaso = 'Escribe el nombre del sub-aplicativo.'; return; }
    this.ocupado = true;
    this.errorPaso = null;
    try {
      const r = await firstValueFrom(
        this.certificadoService.registrarComponente({
          ServidorId: srv.id,
          Rol: rol,
          Puerto: this.nuevoComp.puerto ? Number(this.nuevoComp.puerto) : null,
          Tipo: this.nuevoComp.tipo || null,
          AplicacionesIds: this.nuevoComp.apps,
        })
      );
      const comp = r.componente;
      const existente = srv.componentes.find((c) => c.id === comp.id);
      if (existente) {
        existente.aplicaciones = comp.aplicaciones;
        existente.puerto = comp.puerto;
        existente.tipo = comp.tipo;
      } else {
        srv.componentes.push(comp);
        srv.componentes.sort((a, b) => a.rol.localeCompare(b.rol));
      }
      this.registrando = false;
      this.seleccion[comp.id] = true;
      this.avisoPaso = r.yaExistia
        ? `«${comp.rol}» ya estaba registrado en este servidor; se usará ese. Márcalo y pulsa "Agregar".`
        : `Sub-aplicativo «${comp.rol}» registrado. Ya aparece también en Inventario → Sub-aplicativos. Márcalo y pulsa "Agregar".`;
    } catch (err: any) {
      this.errorPaso = err?.error?.error || 'No se pudo registrar el sub-aplicativo. Intenta de nuevo.';
    } finally {
      this.ocupado = false;
    }
  }

  // ====================================== paso 3: asociar aplicación de negocio
  async asociarApp(u: Ubicacion, appId: any): Promise<void> {
    if (appId == null || appId === '' || !u.servidorId) return;
    const comp = this.componenteDe(u);
    if (!comp) return;
    this.ocupado = true;
    this.errorPaso = null;
    try {
      const r = await firstValueFrom(
        this.certificadoService.registrarComponente({
          ServidorId: u.servidorId,
          ComponenteId: comp.id,
          AplicacionesIds: [Number(appId)],
        })
      );
      comp.aplicaciones = r.componente.aplicaciones;
      this.refrescarOpcionesApps();
    } catch (err: any) {
      this.errorPaso = err?.error?.error || 'No se pudo asociar la aplicación de negocio.';
    } finally {
      this.ocupado = false;
    }
  }

  // ============================================================= navegación
  private validarPaso(n: number): string | null {
    if (n === 1) {
      if (this.modoActual !== 'editar' && !this.datos.NombreComun.trim()) {
        return 'Escribe el nombre común (CN) del certificado: es la forma de reconocerlo.';
      }
      if (!this.datos.FechaInicio || !this.datos.FechaFin) return 'Indica desde cuándo y hasta cuándo es válido el certificado.';
      if (this.datos.FechaFin < this.datos.FechaInicio) return 'La fecha de vencimiento no puede ser anterior a la fecha de inicio.';
    }
    if (n === 2) {
      if (this.pendientesLegado.length) {
        return 'Hay una fila antigua sin ubicación. Elige el servidor y el sub-aplicativo donde está instalada (o quítala).';
      }
      if (this.activas.length === 0) return 'Agrega al menos una ubicación: el servidor y el sub-aplicativo donde está instalado el certificado.';
    }
    return null;
  }

  siguiente(): void {
    const e = this.validarPaso(this.paso);
    if (e) { this.errorPaso = e; return; }
    this.errorPaso = null;
    this.avisoPaso = null;
    if (this.paso < 4) this.paso++;
    if (this.paso === 3) this.refrescarOpcionesApps();
  }

  anterior(): void {
    this.errorPaso = null;
    this.avisoPaso = null;
    if (this.paso > 1) this.paso--;
  }

  irAPaso(n: number): void {
    // Solo hacia atrás libremente; hacia adelante se valida cada paso intermedio.
    if (n <= this.paso) { this.paso = n; this.errorPaso = null; return; }
    for (let i = this.paso; i < n; i++) {
      const e = this.validarPaso(i);
      if (e) { this.paso = i; this.errorPaso = e; return; }
    }
    this.errorPaso = null;
    this.paso = n;
    if (n === 3) this.refrescarOpcionesApps();
  }

  // ================================================================ guardado
  async guardar(): Promise<void> {
    const e = this.validarPaso(1) || this.validarPaso(2);
    if (e) { this.errorPaso = e; this.paso = this.validarPaso(1) ? 1 : 2; return; }

    this.guardando = true;
    this.errorPaso = null;
    this.erroresGuardado = [];

    const compartidos = {
      NombreComun: this.datos.NombreComun.trim() || null,
      EntidadEmisora: this.datos.EntidadEmisora.trim() || null,
      NumeroSerie: this.datos.NumeroSerie.trim() || null,
      Thumbprint: this.datos.Thumbprint.trim() || null,
      FechaInicio: this.datos.FechaInicio,
      FechaFin: this.datos.FechaFin,
      Responsable: this.datos.Responsable.trim() || null,
      Observaciones: this.datos.Observaciones.trim() || null,
    };

    // 1) Quitar las ubicaciones que se marcaron para quitar.
    for (const u of [...this.ubicaciones]) {
      if (!u.quitar || !u.rowId) continue;
      try {
        await firstValueFrom(this.certificadoService.eliminar(u.rowId));
        this.huboCambios = true;
        this.ubicaciones = this.ubicaciones.filter((x) => x !== u);
      } catch (err: any) {
        this.erroresGuardado.push(`No se pudo quitar ${u.hostname} · ${u.componente}: ${err?.error?.error || 'error desconocido'}`);
      }
    }

    // 2) Crear / actualizar las ubicaciones. Si una falla, las demás siguen; lo ya
    //    guardado queda marcado con su id para no duplicarlo al reintentar.
    for (const u of this.activas) {
      const cuerpo: any = {
        ...compartidos,
        AplicacionId: null,
        ServidorId: u.servidorId,
        Componente: u.componente,
        Puerto: u.puerto ? Number(u.puerto) : null,
      };
      try {
        if (u.rowId) {
          await firstValueFrom(this.certificadoService.actualizar(u.rowId, cuerpo));
          this.huboCambios = true;
        } else {
          const creado: any = await firstValueFrom(this.certificadoService.crear(cuerpo));
          u.rowId = idDe(creado) || null;
          this.huboCambios = true;
        }
      } catch (err: any) {
        this.erroresGuardado.push(`${u.hostname} · ${u.componente}: ${err?.error?.error || 'no se pudo guardar'}`);
      }
    }

    this.guardando = false;
    if (this.erroresGuardado.length === 0) this.guardado.emit();
  }

  cerrarAsistente(): void {
    if (this.huboCambios) this.guardado.emit();
    else this.cerrar.emit();
  }

  fechaCorta(f: string): string {
    return soloFecha(f);
  }
}
