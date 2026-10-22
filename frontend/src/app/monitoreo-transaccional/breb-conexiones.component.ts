import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { BrebService, ConexionApi, ConexionBd, Conexiones, Destino, FormApi, FormBd, ResultadoPrueba } from './breb.service';

interface Pestana { id: Destino; texto: string; ayuda: string; }

// ============================================================================
// Conexiones de BREB (solo ADMIN_POD): SQL Server de BreB, logs en MariaDB y servicio de llaves.
// Las claves se guardan cifradas y nunca vuelven al navegador: dejar la clave vacía conserva la guardada.
// ============================================================================
@Component({
  selector: 'app-breb-conexiones',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './breb-conexiones.component.html',
  styleUrl: './breb-conexiones.component.scss',
})
export class BrebConexionesComponent implements OnInit, OnDestroy {
  @Input({ required: true }) conexiones!: Conexiones;
  @Input() inicial: Destino = 'sql';
  @Output() cerrar = new EventEmitter<void>();
  /** Se emite con las conexiones actualizadas tras guardar o quitar. */
  @Output() cambiaron = new EventEmitter<{ conexiones: Conexiones; destino: Destino; accion: 'guardada' | 'quitada' }>();

  readonly pestanas: Pestana[] = [
    { id: 'sql', texto: 'SQL Server (BreB)', ayuda: 'Base con trx.Redeban, llaves, QR y parámetros. Usa una cuenta con permiso SELECT únicamente.' },
    { id: 'log', texto: 'Logs (MariaDB)', ayuda: 'Base LogBre_B con la tabla Log (WebApiHubBreB, gateway, correo…). Usa una cuenta de solo lectura.' },
    { id: 'api', texto: 'Servicio de llaves', ayuda: 'Servicio de BreB del que solo se usan «consultar llave» y «resolver llave». Su certificado suele no ser de una CA reconocida.' },
  ];

  actual: Destino = 'sql';
  sql: FormBd = this.formBd('BreB', 1433, true);
  log: FormBd = this.formBd('LogBre_B', 3306, false);
  api: FormApi = { url: '', validarTls: false, rutaConsultar: '', rutaResolver: '' };
  guardando = false;
  probando = false;
  error: string | null = null;
  prueba: Record<Destino, ResultadoPrueba | null> = { sql: null, log: null, api: null };
  confirmarQuitar = false;
  private subs: Subscription[] = [];

  constructor(private svc: BrebService) {}

  ngOnInit(): void {
    this.actual = this.inicial;
    this.cargarFormularios();
  }
  ngOnDestroy(): void { this.subs.forEach((s) => s.unsubscribe()); }

  private formBd(base: string, puerto: number, conEntidad: boolean): FormBd {
    return { servidor: '', puerto, base, usuario: '', clave: '', cifrado: false, confiarCertificado: true, ...(conEntidad ? { bancoPropio: '0063' } : {}) };
  }

  private cargarFormularios(): void {
    const c = this.conexiones;
    this.sql = { servidor: c.sql.servidor || '', puerto: c.sql.puerto || 1433, base: c.sql.base || 'BreB', usuario: c.sql.usuario || '', clave: '', cifrado: !!c.sql.cifrado, confiarCertificado: c.sql.confiarCertificado !== false, bancoPropio: c.sql.bancoPropio || '0063' };
    this.log = { servidor: c.log.servidor || '', puerto: c.log.puerto || 3306, base: c.log.base || 'LogBre_B', usuario: c.log.usuario || '', clave: '', cifrado: !!c.log.cifrado, confiarCertificado: c.log.confiarCertificado !== false };
    this.api = { url: c.api.url || '', validarTls: !!c.api.validarTls, rutaConsultar: c.api.guardadaEnApp ? c.api.rutaConsultar || '' : '', rutaResolver: c.api.guardadaEnApp ? c.api.rutaResolver || '' : '' };
  }

  get pestana(): Pestana { return this.pestanas.find((p) => p.id === this.actual) as Pestana; }
  get bd(): ConexionBd | null { return this.actual === 'api' ? null : this.conexiones[this.actual]; }
  get cApi(): ConexionApi { return this.conexiones.api; }
  get formBdActual(): FormBd { return this.actual === 'log' ? this.log : this.sql; }
  get guardadaEnApp(): boolean { return this.actual === 'api' ? this.cApi.guardadaEnApp : !!this.bd?.guardadaEnApp; }
  get tieneClave(): boolean { return !!this.bd?.tieneClave; }
  get claveFin(): string | null { return this.bd?.claveFin || null; }
  get placeholderClave(): string {
    return this.tieneClave ? `•••••• (vacía = conservar la actual${this.claveFin ? `, termina en «${this.claveFin}»` : ''})` : '';
  }
  get puedeGuardar(): boolean {
    if (this.guardando || this.probando) return false;
    if (this.actual === 'api') return !!this.api.url.trim();
    const f = this.formBdActual;
    return !!f.servidor.trim() && !!f.usuario.trim();
  }
  get origenTexto(): string {
    const origen = this.actual === 'api' ? this.cApi.origen : this.bd?.origen;
    const conf = this.actual === 'api' ? this.cApi.configurada : this.bd?.configurada;
    if (!conf) return 'Sin configurar';
    return ({ guardada: 'Guardada en la aplicación', env: 'Variables de entorno del servidor (.env)', predefinida: 'Predefinida en el servidor' } as Record<string, string>)[origen || ''] || origen || '';
  }

  irA(d: Destino): void { this.actual = d; this.error = null; this.confirmarQuitar = false; }

  private msg(e: unknown): string {
    if (e instanceof HttpErrorResponse) return e.status === 0 ? 'No hay respuesta del servidor de AXIS.' : e.error?.error || 'No se pudo completar la operación.';
    return 'No se pudo completar la operación.';
  }

  private cuerpo(): FormBd | FormApi { return this.actual === 'api' ? this.api : this.formBdActual; }

  probar(): void {
    this.error = null;
    this.probando = true;
    const d = this.actual;
    const hayBorrador = d === 'api' ? !!this.api.url.trim() : !!this.formBdActual.servidor.trim();
    this.subs.push(this.svc.probarConexion(d, hayBorrador ? this.cuerpo() : null).subscribe({
      next: (r) => { this.prueba[d] = r; this.probando = false; },
      error: (e) => { this.error = this.msg(e); this.probando = false; },
    }));
  }

  guardar(): void {
    this.error = null;
    this.guardando = true;
    const d = this.actual;
    this.subs.push(this.svc.guardarConexion(d, this.cuerpo()).subscribe({
      next: (r) => {
        this.guardando = false;
        this.conexiones = { ...this.conexiones, [d]: r } as Conexiones;
        this.cambiaron.emit({ conexiones: this.conexiones, destino: d, accion: 'guardada' });
        this.cargarFormularios();
      },
      error: (e) => { this.error = this.msg(e); this.guardando = false; },
    }));
  }

  quitar(): void {
    if (!this.confirmarQuitar) { this.confirmarQuitar = true; return; }
    this.guardando = true;
    const d = this.actual;
    this.subs.push(this.svc.quitarConexion(d).subscribe({
      next: (r) => {
        this.guardando = false;
        this.confirmarQuitar = false;
        this.prueba[d] = null;
        this.conexiones = { ...this.conexiones, [d]: r } as Conexiones;
        this.cambiaron.emit({ conexiones: this.conexiones, destino: d, accion: 'quitada' });
        this.cargarFormularios();
      },
      error: (e) => { this.error = this.msg(e); this.guardando = false; this.confirmarQuitar = false; },
    }));
  }

  cerrarSiLibre(): void { if (!this.guardando) this.cerrar.emit(); }
}
