import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import { AdopcionResponse, ClienteVersion, ClientesVersionResponse, VersionAdopcion, copiarTexto, pct } from './analisis-comun';

// ============================================================================
// Adopción de versiones de la app (GET /app-movil/versiones/adopcion)
// ----------------------------------------------------------------------------
// Cuántos clientes usan cada versión. Cada cliente se cuenta UNA sola vez, en la
// versión de su último inicio de sesión del periodo. Con las tablas de análisis
// creadas el dato es exacto por día; sin ellas se muestra solo la última ventana
// de inicios de sesión y la pantalla lo dice. "Ver CC" lista los documentos.
// ============================================================================

interface SerieDia { fecha: string; total: number; partes: { version: string; clientes: number; color: string }[] }

const COLORES = ['#5b21b6', '#0f766e', '#b45309', '#1d4ed8', '#be185d'];
const COLOR_OTRAS = '#64748b';

@Component({
  selector: 'app-versiones-adopcion',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './versiones-adopcion.component.html',
  styleUrl: './versiones-adopcion.component.scss'
})
export class VersionesAdopcionComponent implements OnInit, OnDestroy {
  readonly dias = [7, 14, 30, 60, 90];
  diasSeleccionados = 30;
  readonly minutosVentana = [60, 120, 240, 360];
  minutos = 120;

  cargando = false;
  error: string | null = null;
  datos: AdopcionResponse | null = null;
  serie: SerieDia[] = [];
  leyenda: { version: string; color: string }[] = [];
  maxSerie = 1;
  readonly pct = pct;

  // Modal "Ver CC"
  modalAbierto = false;
  modalVersion: VersionAdopcion | null = null;
  modalPlataforma = '';
  cargandoClientes = false;
  errorClientes: string | null = null;
  clientes: ClientesVersionResponse | null = null;
  pagina = 1;
  copiado = false;
  descargando = false;
  private temporizador?: ReturnType<typeof setTimeout>;

  private readonly apiUrl = `${environment.apiUrl}/app-movil`;
  private suscripcion?: Subscription;
  private suscripcionClientes?: Subscription;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.cargar(); }

  ngOnDestroy(): void {
    this.suscripcion?.unsubscribe();
    this.suscripcionClientes?.unsubscribe();
    if (this.temporizador) clearTimeout(this.temporizador);
  }

  elegirDias(d: number): void { this.diasSeleccionados = d; this.cargar(); }

  cargar(): void {
    this.suscripcion?.unsubscribe();
    this.cargando = true;
    this.error = null;
    const params = new HttpParams().set('dias', String(this.diasSeleccionados)).set('minutos', String(this.minutos));
    this.suscripcion = this.http.get<AdopcionResponse>(`${this.apiUrl}/versiones/adopcion`, { params }).subscribe({
      next: (r) => { this.datos = r; this.armarSerie(r); this.cargando = false; },
      error: (err: HttpErrorResponse) => { this.cargando = false; this.error = err.error?.error || 'No se pudo calcular la adopción de versiones.'; }
    });
  }

  private armarSerie(r: AdopcionResponse): void {
    const totales = new Map<string, number>();
    for (const f of r.serie) totales.set(f.version, (totales.get(f.version) ?? 0) + f.clientes);
    const principales = [...totales.entries()].sort((a, b) => b[1] - a[1]).slice(0, COLORES.length).map(([v]) => v);
    const color = new Map(principales.map((v, i) => [v, COLORES[i]] as [string, string]));
    this.leyenda = principales.map((v) => ({ version: v, color: color.get(v) as string }));
    const hayOtras = [...totales.keys()].some((v) => !color.has(v));
    if (hayOtras) this.leyenda.push({ version: 'Otras', color: COLOR_OTRAS });

    const porDia = new Map<string, Map<string, number>>();
    for (const f of r.serie) {
      const clave = color.has(f.version) ? f.version : 'Otras';
      const dia = porDia.get(f.fecha) ?? new Map<string, number>();
      dia.set(clave, (dia.get(clave) ?? 0) + f.clientes);
      porDia.set(f.fecha, dia);
    }
    this.serie = [...porDia.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([fecha, m]) => {
      const partes = this.leyenda.filter((l) => m.has(l.version)).map((l) => ({ version: l.version, clientes: m.get(l.version) as number, color: l.color }));
      return { fecha, total: partes.reduce((s, p) => s + p.clientes, 0), partes };
    });
    this.maxSerie = Math.max(1, ...this.serie.map((d) => d.total));
  }

  alto(n: number): number { return (n / this.maxSerie) * 100; }

  textoDia(d: SerieDia): string {
    return `${d.fecha}: ${d.partes.map((p) => `${p.version} ${p.clientes}`).join(' · ')} (clientes que iniciaron sesión)`;
  }

  textoPlataformas(v: VersionAdopcion): string {
    return v.plataformas.map((p) => `${p.plataforma} ${p.clientes}`).join(' · ');
  }

  // --------------------------------------------------------------- Ver CC
  verClientes(v: VersionAdopcion, plataforma = ''): void {
    this.modalAbierto = true;
    this.modalVersion = v;
    this.modalPlataforma = plataforma;
    this.pagina = 1;
    this.cargarClientes();
  }

  cerrarModal(): void {
    this.modalAbierto = false;
    this.clientes = null;
    this.suscripcionClientes?.unsubscribe();
  }

  private paramsClientes(extra: Record<string, string> = {}): HttpParams {
    let p = new HttpParams().set('version', this.modalVersion?.version ?? '').set('dias', String(this.diasSeleccionados)).set('minutos', String(this.minutos));
    if (this.datos?.fuente === 'ventana') p = p.set('modo', 'ventana');
    if (this.modalPlataforma) p = p.set('plataforma', this.modalPlataforma);
    for (const [k, v] of Object.entries(extra)) p = p.set(k, v);
    return p;
  }

  cargarClientes(): void {
    this.suscripcionClientes?.unsubscribe();
    this.cargandoClientes = true;
    this.errorClientes = null;
    this.suscripcionClientes = this.http.get<ClientesVersionResponse>(`${this.apiUrl}/versiones/clientes`, { params: this.paramsClientes({ pagina: String(this.pagina) }) }).subscribe({
      next: (r) => { this.clientes = r; this.cargandoClientes = false; },
      error: (err: HttpErrorResponse) => { this.cargandoClientes = false; this.errorClientes = err.error?.error || 'No se pudo listar los clientes.'; }
    });
  }

  cambiarPlataforma(p: string): void { this.modalPlataforma = p; this.pagina = 1; this.cargarClientes(); }

  get totalPaginas(): number {
    const c = this.clientes;
    return c ? Math.max(1, Math.ceil(c.total / c.tamano)) : 1;
  }

  irPagina(n: number): void {
    if (n < 1 || n > this.totalPaginas) return;
    this.pagina = n;
    this.cargarClientes();
  }

  async copiarPagina(): Promise<void> {
    const lista = (this.clientes?.clientes ?? []).map((c: ClienteVersion) => c.documento).join('\n');
    if (lista && await copiarTexto(lista)) {
      this.copiado = true;
      if (this.temporizador) clearTimeout(this.temporizador);
      this.temporizador = setTimeout(() => { this.copiado = false; }, 2000);
    }
  }

  /** Descarga el CSV completo (con el token de sesión: no se puede abrir como enlace directo). */
  descargarCsv(): void {
    if (!this.modalVersion) return;
    this.descargando = true;
    this.http.get(`${this.apiUrl}/versiones/clientes`, { params: this.paramsClientes({ formato: 'csv' }), responseType: 'blob' }).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `clientes_version_${(this.modalVersion?.version ?? '').replace(/[^0-9A-Za-z._-]/g, '_')}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.descargando = false;
      },
      error: () => { this.descargando = false; this.errorClientes = 'No se pudo descargar el CSV.'; }
    });
  }

  trackVersion(_: number, v: VersionAdopcion): string { return v.version; }
}
