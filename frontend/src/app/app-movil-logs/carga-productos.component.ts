import { Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  CargaProductos, CargaResponse, ComponenteCarga, IntentoCarga, PERIODOS_ANALISIS, PeriodoAnalisis,
  VeredictoCarga, VeredictoComponente, copiarTexto, formatearDuracion, hoyLocalYMD, paramsPeriodo
} from './analisis-comun';
import { PasosAnalisisComponent } from './pasos-analisis.component';

// ============================================================================
// Validación de la CARGA DE PRODUCTOS del cliente (GET /app-movil/carga-productos)
// ----------------------------------------------------------------------------
// Para cada vez que la app pidió los productos del cliente (cuentas, tarjetas
// débito y crédito, estado de plásticos, fidelización, mora) dice si se cargó,
// cuánto tardó y, si falló o fue lenta, la evidencia del log y -aparte, con su
// nivel de confianza- las hipótesis. Todo sale de los registros de LogApp: lo que
// el log no guarda se muestra como "sin confirmar", nunca se inventa.
// ============================================================================

@Component({
  selector: 'app-carga-productos',
  standalone: true,
  imports: [CommonModule, FormsModule, PasosAnalisisComponent],
  templateUrl: './carga-productos.component.html',
  styleUrl: './carga-productos.component.scss'
})
export class CargaProductosComponent implements OnChanges, OnDestroy {
  @Input() documentoInicial = '';

  readonly periodos = PERIODOS_ANALISIS;
  documento = '';
  periodo: PeriodoAnalisis = 'hoy';
  fechaMaxima = hoyLocalYMD();
  fechaDesde = hoyLocalYMD();
  fechaHasta = hoyLocalYMD();

  cargando = false;
  buscoAlMenosUnaVez = false;
  error: string | null = null;
  respuesta: CargaResponse | null = null;
  banner: { clase: string; titulo: string; detalle: string } | null = null;

  /** Cargas desplegadas (por id) y componentes con sus intentos desplegados. */
  abiertas = new Set<number>();
  componentesAbiertos = new Set<string>();
  verSueltos = false;
  copiadoId: number | 'todas' | null = null;
  filtroVeredicto: 'todas' | 'problemas' = 'todas';

  readonly formatearDuracion = formatearDuracion;
  private readonly apiUrl = `${environment.apiUrl}/app-movil`;
  private suscripcion?: Subscription;
  private temporizadorCopia?: ReturnType<typeof setTimeout>;

  constructor(private http: HttpClient) {}

  ngOnChanges(c: SimpleChanges): void {
    if (c['documentoInicial'] && this.documentoInicial && this.documentoInicial !== this.documento) {
      this.documento = this.documentoInicial;
      this.consultar();
    }
  }

  ngOnDestroy(): void {
    this.suscripcion?.unsubscribe();
    if (this.temporizadorCopia) clearTimeout(this.temporizadorCopia);
  }

  elegirPeriodo(p: PeriodoAnalisis): void { this.periodo = p; }

  consultar(): void {
    const documento = this.documento.trim();
    if (documento.length < 4) {
      this.error = 'Escribe el documento completo del cliente (mínimo 4 caracteres).';
      return;
    }
    const p = paramsPeriodo(this.periodo, this.fechaDesde, this.fechaHasta);
    if (typeof p === 'string') { this.error = p; return; }
    let params = new HttpParams().set('documento', documento);
    for (const [k, v] of Object.entries(p)) params = params.set(k, v);

    this.suscripcion?.unsubscribe();
    this.cargando = true;
    this.error = null;
    this.buscoAlMenosUnaVez = true;
    this.suscripcion = this.http.get<CargaResponse>(`${this.apiUrl}/carga-productos`, { params }).subscribe({
      next: (r) => {
        this.respuesta = r;
        this.banner = this.calcularBanner(r);
        this.cargando = false;
        this.abiertas = new Set<number>();
        this.componentesAbiertos = new Set<string>();
        // La más reciente primero y abierta; si hay problemas se abre también la primera con problema.
        const primera = r.cargas[0];
        if (primera) this.abiertas.add(primera.id);
        const conProblema = r.cargas.find((c) => c.veredicto === 'FALLA' || c.veredicto === 'SIN_CONFIRMAR' || c.veredicto === 'PARCIAL');
        if (conProblema) this.abiertas.add(conProblema.id);
      },
      error: (err: HttpErrorResponse) => {
        this.cargando = false;
        this.respuesta = null;
        this.error = err.error?.error || 'No se pudo validar la carga de productos. Intenta de nuevo.';
      }
    });
  }

  get cargasVisibles(): CargaProductos[] {
    const r = this.respuesta;
    if (!r) return [];
    return this.filtroVeredicto === 'problemas' ? r.cargas.filter((c) => c.veredicto !== 'COMPLETA') : r.cargas;
  }

  alternar(id: number): void {
    if (this.abiertas.has(id)) this.abiertas.delete(id); else this.abiertas.add(id);
  }

  claveComponente(c: CargaProductos, k: ComponenteCarga): string { return `${c.id}|${k.clave}`; }

  alternarComponente(c: CargaProductos, k: ComponenteCarga): void {
    const clave = this.claveComponente(c, k);
    if (this.componentesAbiertos.has(clave)) this.componentesAbiertos.delete(clave); else this.componentesAbiertos.add(clave);
  }

  async copiar(c: CargaProductos): Promise<void> {
    const ok = await copiarTexto(c.resumenTexto);
    if (ok) this.marcarCopiado(c.id);
  }

  async copiarTodas(): Promise<void> {
    const r = this.respuesta;
    if (!r) return;
    const ok = await copiarTexto(r.cargas.map((c) => c.resumenTexto).join('\n\n------------------------------\n\n'));
    if (ok) this.marcarCopiado('todas');
  }

  private marcarCopiado(id: number | 'todas'): void {
    this.copiadoId = id;
    if (this.temporizadorCopia) clearTimeout(this.temporizadorCopia);
    this.temporizadorCopia = setTimeout(() => { this.copiadoId = null; }, 2000);
  }

  // -------------------------------------------------------------- etiquetas
  textoVeredicto(v: VeredictoCarga): string {
    switch (v) {
      case 'COMPLETA': return 'Carga completa';
      case 'COMPLETA_LENTA': return 'Completa, con lentitud';
      case 'PARCIAL': return 'Parcial';
      case 'FALLA': return 'Falló';
      default: return 'Sin confirmar';
    }
  }

  clasePill(v: VeredictoCarga | VeredictoComponente): string {
    switch (v) {
      case 'COMPLETA': case 'OK': case 'OK_SIN_DATOS': return 'pill--ok';
      case 'COMPLETA_LENTA': case 'OK_LENTA': case 'PARCIAL': case 'AVISO': return 'pill--warn';
      case 'FALLA': case 'ERROR': return 'pill--error';
      case 'SIN_CONFIRMAR': return 'pill--info';
      default: return '';
    }
  }

  textoComponente(v: VeredictoComponente): string {
    switch (v) {
      case 'OK': return 'OK';
      case 'OK_SIN_DATOS': return 'OK (sin datos)';
      case 'OK_LENTA': return 'OK, lenta';
      case 'ERROR': return 'Error';
      case 'AVISO': return 'Aviso';
      case 'SIN_CONFIRMAR': return 'Sin confirmar';
      default: return 'No registrado';
    }
  }

  textoProductos(p: CargaProductos['productos']): string {
    return p === 'SI' ? 'Productos cargados' : p === 'NO' ? 'Productos NO cargados' : p === 'PARCIAL' ? 'Productos cargados parcialmente' : 'No se puede confirmar';
  }

  private calcularBanner(r: CargaResponse): { clase: string; titulo: string; detalle: string } {
    switch (r.resumen.productos) {
      case 'SIN_CARGAS':
        return { clase: 'banner--neutro', titulo: 'No se encontró ninguna carga de productos en el periodo',
          detalle: 'Hay actividad del cliente en el log, pero ninguna llamada de productos que se pueda agrupar como una carga. Puede ser que no abriera la pantalla de productos o que el log no la haya registrado.' };
      case 'HAY_FALLAS':
        return { clase: 'banner--error', titulo: 'Hay cargas de productos con fallas',
          detalle: `${r.resumen.conFallas} con falla y ${r.resumen.parciales} parcial(es) de ${r.resumen.cargas}. Abre cada carga para ver el componente que falló, la evidencia y las hipótesis.` };
      case 'HAY_SIN_CONFIRMAR':
        return { clase: 'banner--aviso', titulo: 'No se puede confirmar toda la carga con el log',
          detalle: `${r.resumen.sinConfirmar} carga(s) tienen solicitudes sin respuesta registrada: el log no permite afirmar que respondieron ni descartarlo.` };
      default:
        return { clase: 'banner--ok', titulo: 'Todas las cargas de productos del periodo se completaron',
          detalle: `${r.resumen.completas} completa(s)${r.resumen.completasLentas ? ` y ${r.resumen.completasLentas} con lentitud` : ''} de ${r.resumen.cargas}.` };
    }
  }

  intentosVisibles(k: ComponenteCarga): IntentoCarga[] { return k.intentos; }

  estadoIntento(i: IntentoCarga): string {
    if (i.sinInicio) return 'Sin fila de inicio';
    return i.estado === 'exito' ? 'Correcto' : i.estado === 'error' ? 'Error' : i.estado === 'advertencia' ? 'Aviso' : i.estado === 'sin_detalle' ? 'Sin respuesta registrada' : i.estado;
  }

  claseIntento(i: IntentoCarga): string {
    return i.estado === 'exito' ? 'pill--ok' : i.estado === 'error' ? 'pill--error' : i.estado === 'advertencia' ? 'pill--warn' : 'pill--info';
  }

  textoConfianza(c: string): string { return c === 'alta' ? 'Confianza alta' : c === 'media' ? 'Confianza media' : 'Confianza baja'; }

  etiquetaEvidencia(t: string): string {
    const m: Record<string, string> = {
      productos: 'Productos', lentitud: 'Lentitud', repeticion: 'Repetición', sin_detalle: 'Sin detalle', nodo: 'Nodo',
      timeout: 'Tiempo agotado', error: 'Error', secuencia: 'Secuencia', catalogo: 'Catálogo', login: 'Sesión'
    };
    return m[t] ?? t;
  }

  trackId(_: number, c: CargaProductos): number { return c.id; }
  trackClave(_: number, k: ComponenteCarga): string { return k.clave; }
}
