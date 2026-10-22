import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CatalogoDatosService, EstadoMasivo, MasivoRespuesta, Motor, OrigenAdmin, OrigenForm, PruebaOrigen, ResultadoMasivo } from '../../core/services/catalogo-datos.service';
import { AuthService } from '../../services/auth.service';

const TANDA_MASIVA = 25;
const MAX_LINEAS_MASIVO = 300;

export interface FilaMasiva {
  texto: string;
  estado: EstadoMasivo;
  mensaje: string | null;
  version: string | null;
  bases: number;
}

// Administración de los orígenes (servidores SQL Server / MariaDB que se leen).
// Cada persona administra SUS orígenes (solo ve los que creó); el backend lo valida igual. Los orígenes NO llevan usuario ni clave:
// cada persona usa las suyas («Mis credenciales» del catálogo). Probar la conexión usa las de quien prueba.
@Component({
  selector: 'app-catalogo-origenes',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './catalogo-origenes.component.html',
  styleUrl: './catalogo-origenes.component.scss',
})
export class CatalogoOrigenesComponent implements OnInit {
  /** true si hubo cambios que obligan a releer el catálogo. */
  @Output() cerrar = new EventEmitter<boolean>();

  origenes: OrigenAdmin[] = [];
  tablaLista = true;
  cargando = true;
  error = '';
  huboCambios = false;

  mostrarForm = false;
  editando: OrigenAdmin | null = null;
  form: OrigenForm = this.vacio();
  guardando = false;
  errorForm = '';
  probando = false;
  prueba: PruebaOrigen | null = null;
  quitando: string | null = null;
  confirmandoLimpieza = false;
  aviso = '';

  // Carga masiva: pegar una lista de servidores. El usuario/clave de aquí solo sirven para PROBAR la conexión (no se guardan).
  mostrarMasivo = false;
  masivo = { lista: '', usuario: '', clave: '', cifrado: true, confiarCertificado: true };
  filasMasivo: FilaMasiva[] = [];
  masivoTrabajando = false;
  masivoFase: 'probar' | 'registrar' | null = null;
  masivoProgreso = '';
  masivoError = '';
  masivoDetenido = false;
  masivoRegistrado = false;

  /** Solo el ADMIN_POD puede borrar las claves antiguas que una versión anterior dejó guardadas en la base. */
  esAdminPod = false;

  constructor(private servicio: CatalogoDatosService, private auth: AuthService) {
    this.esAdminPod = this.auth.obtenerDatosUsuario()?.rol === 'ADMIN_POD';
  }

  ngOnInit(): void { this.cargar(); }

  private vacio(): OrigenForm {
    return { nombre: '', motor: 'MSSQL', host: '', puerto: 1433, cifrado: false, confiarCertificado: true, basesIncluidas: '', activo: true };
  }

  cargar(): void {
    this.cargando = true;
    this.servicio.origenes().subscribe({
      next: (r) => { this.origenes = r.origenes; this.tablaLista = r.tabla; this.cargando = false; },
      error: (e) => { this.error = e?.error?.error || 'No se pudieron cargar los orígenes.'; this.cargando = false; },
    });
  }

  nuevo(): void {
    this.editando = null;
    this.form = this.vacio();
    this.prueba = null;
    this.errorForm = '';
    this.mostrarForm = true;
  }

  editar(o: OrigenAdmin): void {
    this.editando = o;
    this.form = {
      id: o.id, nombre: o.nombre, motor: o.motor, host: o.host, puerto: o.puerto,
      cifrado: o.cifrado, confiarCertificado: o.confiarCertificado, basesIncluidas: o.basesIncluidas.join(', '), activo: o.activo,
    };
    this.prueba = null;
    this.errorForm = '';
    this.mostrarForm = true;
  }

  cancelarForm(): void { this.mostrarForm = false; this.editando = null; }

  cambiarMotor(m: Motor): void {
    const defecto = this.form.motor === 'MSSQL' ? 1433 : 3306;
    this.form.motor = m;
    if (!this.form.puerto || this.form.puerto === defecto) this.form.puerto = m === 'MSSQL' ? 1433 : 3306;
    this.prueba = null;
  }

  get formValido(): boolean {
    const f = this.form;
    return !!(f.nombre.trim() && f.host.trim());
  }

  get puedeProbar(): boolean {
    const f = this.form;
    return !!f.host.trim();
  }

  probar(): void {
    this.probando = true;
    this.prueba = null;
    this.servicio.probarOrigen({ ...this.form, nombre: this.form.nombre.trim() || 'prueba' }).subscribe({
      next: (r) => { this.prueba = r; this.probando = false; },
      error: (e) => { this.prueba = { ok: false, error: e?.error?.error || 'No se pudo probar la conexión.' }; this.probando = false; },
    });
  }

  guardar(): void {
    this.guardando = true;
    this.errorForm = '';
    const f = { ...this.form, nombre: this.form.nombre.trim(), host: this.form.host.trim() };
    const obs = this.editando ? this.servicio.editarOrigen(this.editando.id, f) : this.servicio.crearOrigen(f);
    obs.subscribe({
      next: () => { this.guardando = false; this.mostrarForm = false; this.editando = null; this.huboCambios = true; this.cargar(); },
      error: (e) => { this.guardando = false; this.errorForm = e?.error?.error || 'No se pudo guardar el origen.'; },
    });
  }

  get hayClavesAntiguas(): boolean { return this.origenes.some((o) => o.claveAntigua); }

  /** Borra las claves que la versión anterior dejó guardadas en la base (ya no se usan). */
  limpiarClaves(): void {
    if (!this.confirmandoLimpieza) { this.confirmandoLimpieza = true; return; }   // primer clic = pedir confirmación
    this.confirmandoLimpieza = false;
    this.servicio.limpiarClaves().subscribe({
      next: (r) => { this.aviso = `Se borraron las claves guardadas de ${r.limpiados} servidor(es).`; this.cargar(); },
      error: (e) => { this.error = e?.error?.error || 'No se pudieron borrar las claves guardadas.'; },
    });
  }

  quitar(o: OrigenAdmin): void {
    if (this.quitando !== o.id) { this.quitando = o.id; return; }   // primer clic = pedir confirmación
    this.servicio.quitarOrigen(o.id).subscribe({
      next: () => { this.quitando = null; this.huboCambios = true; this.cargar(); },
      error: (e) => { this.quitando = null; this.error = e?.error?.error || 'No se pudo quitar el origen.'; },
    });
  }

  // ===== Carga masiva =====
  abrirMasivo(): void {
    this.masivo = { lista: '', usuario: '', clave: '', cifrado: true, confiarCertificado: true };
    this.filasMasivo = [];
    this.masivoError = '';
    this.masivoDetenido = false;
    this.masivoRegistrado = false;
    this.masivoProgreso = '';
    this.mostrarMasivo = true;
  }

  cerrarMasivo(): void {
    if (this.masivoTrabajando) return;
    this.masivo.clave = '';
    this.mostrarMasivo = false;
    if (this.masivoRegistrado) this.cargar();
  }

  get lineasMasivo(): string[] {
    return this.masivo.lista.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }

  get masivoEsDominio(): boolean {
    const u = this.masivo.usuario.trim();
    return /^[^\\\s@]+\\[^\\\s]+$/.test(u) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u);
  }

  get masivoPuedeProbar(): boolean {
    const n = this.lineasMasivo.length;
    return !this.masivoTrabajando && n > 0 && n <= MAX_LINEAS_MASIVO && !!this.masivo.usuario.trim() && !!this.masivo.clave;
  }

  get masivoConectaron(): FilaMasiva[] { return this.filasMasivo.filter((f) => f.estado === 'ok'); }
  conteoMasivo(e: EstadoMasivo): number { return this.filasMasivo.filter((f) => f.estado === e).length; }

  private aplicarResultados(inicio: number, enviadas: number, r: MasivoRespuesta): void {
    // El backend ignora líneas vacías/comentarios; aquí solo enviamos líneas útiles, así que el orden coincide.
    r.resultados.slice(0, enviadas).forEach((x: ResultadoMasivo, i: number) => {
      const fila = this.filasMasivo[inicio + i];
      if (!fila) return;
      fila.estado = x.estado;
      fila.mensaje = x.mensaje;
      fila.version = x.version || null;
      fila.bases = x.bases || 0;
    });
  }

  probarMasivo(): void {
    if (!this.masivoPuedeProbar) return;
    const lineas = this.lineasMasivo;
    this.filasMasivo = lineas.map((texto) => ({ texto, estado: 'pendiente' as EstadoMasivo, mensaje: null, version: null, bases: 0 }));
    this.masivoError = '';
    this.masivoDetenido = false;
    this.masivoRegistrado = false;
    this.masivoTrabajando = true;
    this.masivoFase = 'probar';
    this.probarTanda(0, false);
  }

  private probarTanda(inicio: number, verificada: boolean): void {
    if (inicio >= this.filasMasivo.length) { this.finalizarMasivo(); return; }
    const lote = this.filasMasivo.slice(inicio, inicio + TANDA_MASIVA);
    this.masivoProgreso = `Probando ${Math.min(inicio + lote.length, this.filasMasivo.length)} de ${this.filasMasivo.length}…`;
    this.servicio.masivoOrigenes({
      lista: lote.map((f) => f.texto).join('\n'), usuario: this.masivo.usuario.trim(), clave: this.masivo.clave,
      cifrado: this.masivo.cifrado, confiarCertificado: this.masivo.confiarCertificado, modo: 'probar', verificada,
    }).subscribe({
      next: (r) => {
        this.aplicarResultados(inicio, lote.length, r);
        if (r.detenido) {
          this.masivoDetenido = true;
          this.filasMasivo.slice(inicio + lote.length).forEach((f) => { f.estado = 'omitida'; f.mensaje = 'No se probó para no bloquear la cuenta de red.'; });
          this.finalizarMasivo();
          return;
        }
        this.probarTanda(inicio + lote.length, r.verificada);
      },
      error: (e) => { this.masivoError = e?.error?.error || 'No se pudo completar la prueba.'; this.finalizarMasivo(); },
    });
  }

  registrarMasivo(): void {
    const ok = this.masivoConectaron;
    if (this.masivoTrabajando || !ok.length) return;
    this.masivoError = '';
    this.masivoTrabajando = true;
    this.masivoFase = 'registrar';
    this.registrarTanda(ok, 0);
  }

  private registrarTanda(ok: FilaMasiva[], inicio: number): void {
    if (inicio >= ok.length) { this.masivoRegistrado = this.filasMasivo.some((f) => f.estado === 'creado'); if (this.masivoRegistrado) this.huboCambios = true; this.finalizarMasivo(); return; }
    const lote = ok.slice(inicio, inicio + TANDA_MASIVA);
    this.masivoProgreso = `Registrando ${Math.min(inicio + lote.length, ok.length)} de ${ok.length}…`;
    this.servicio.masivoOrigenes({
      lista: lote.map((f) => f.texto).join('\n'), usuario: '', clave: '',   // registrar no lleva credenciales
      cifrado: this.masivo.cifrado, confiarCertificado: this.masivo.confiarCertificado, modo: 'registrar',
    }).subscribe({
      next: (r) => {
        r.resultados.slice(0, lote.length).forEach((x, i) => { lote[i].estado = x.estado; lote[i].mensaje = x.mensaje; });
        this.registrarTanda(ok, inicio + lote.length);
      },
      error: (e) => {
        this.masivoError = e?.error?.error || 'No se pudieron registrar los servidores.';
        this.masivoRegistrado = this.filasMasivo.some((f) => f.estado === 'creado');
        if (this.masivoRegistrado) this.huboCambios = true;
        this.finalizarMasivo();
      },
    });
  }

  private finalizarMasivo(): void {
    this.masivoTrabajando = false;
    this.masivoFase = null;
    this.masivoProgreso = '';
  }

  etiquetaEstadoMasivo(e: EstadoMasivo): string {
    const m: Record<EstadoMasivo, string> = { pendiente: 'En espera', ok: 'Conecta', error: 'Falló', invalida: 'Línea inválida', duplicado: 'Ya registrado', omitida: 'Omitido', creado: 'Registrado' };
    return m[e];
  }

  claseEstadoMasivo(e: EstadoMasivo): string {
    return e === 'ok' || e === 'creado' ? 'chip-ok' : (e === 'error' || e === 'invalida') ? 'chip-alta' : 'chip-media';
  }

  cerrarModal(): void { if (this.masivoTrabajando) return; this.cerrar.emit(this.huboCambios); }

  etiquetaMotor(m: Motor): string { return m === 'MSSQL' ? 'SQL Server' : 'MariaDB'; }
}
