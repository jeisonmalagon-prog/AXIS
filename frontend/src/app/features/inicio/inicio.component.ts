import { ChangeDetectorRef, Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AuthService } from '../../services/auth.service';
import {
  DatosCertificados, DatosInventario, DatosPasos, DatosTareas, InicioService, OpcionesWidget, PreferenciasInicio, WidgetId, WidgetInicio,
} from '../../core/services/inicio.service';
import { InicioConfigComponent } from './inicio-config.component';
import { InicioPortainerComponent } from './inicio-portainer.component';
import { InicioF5Component } from './inicio-f5.component';
import { InicioF5VivoComponent } from './inicio-f5-vivo.component';
import { MasonryDirective } from './masonry.directive';

interface Estado<T> { cargando: boolean; error: string | null; datos: T | null; ts: number | null; }
type Prefs = Partial<Record<WidgetId, OpcionesWidget>>;

const RUTAS: Record<WidgetId, string> = {
  portainer_flota: '/monitoreo-servidores',
  portainer_problemas: '/monitoreo-servidores',
  portainer_consumo: '/monitoreo-servidores',
  portainer_tendencia: '/monitoreo-servidores',
  f5_vivo: '/balanceador-f5',
  f5_trafico: '/balanceador-f5',
  f5_salud: '/balanceador-f5',
  certificados: '/dashboard',
  pasos: '/pasos-produccion',
  tareas: '/tareas',
  inventario: '/servidores',
};

@Component({
  selector: 'app-inicio',
  standalone: true,
  imports: [CommonModule, RouterLink, InicioConfigComponent, InicioPortainerComponent, InicioF5Component, InicioF5VivoComponent, MasonryDirective],
  templateUrl: './inicio.component.html',
  styleUrl: './inicio.component.scss',
})
export class InicioComponent implements OnInit, OnDestroy {
  nombre = '';
  esAdmin = false;
  widgets: WidgetInicio[] = [];
  cargandoLista = true;
  errorLista = '';
  mostrarConfig = false;
  hoy = new Date();

  estados = new Map<WidgetId, Estado<unknown>>();
  private temporizadores = new Map<WidgetId, ReturnType<typeof setInterval>>();
  private enVuelo = new Set<WidgetId>();
  private version = new Map<WidgetId, number>();

  // Filtros de cada persona (se guardan en la BD; si falta la tabla, solo en este navegador).
  prefs: Prefs = {};
  avisoPrefs = '';
  private claveLocal = 'axis.inicio.filtros.v1';

  constructor(private servicio: InicioService, private auth: AuthService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    const u = this.auth.obtenerDatosUsuario();
    this.nombre = (u?.nombre || u?.username || '').split(' ')[0];
    this.esAdmin = u?.rol === 'ADMIN_POD';
    this.claveLocal = `axis.inicio.filtros.v1.${u?.id ?? u?.username ?? ''}`;
    this.cargarLista();
  }

  ngOnDestroy(): void {
    this.temporizadores.forEach((t) => clearInterval(t));
    this.temporizadores.clear();
  }

  // Al volver a la pestaña se refresca todo de una vez (los temporizadores del
  // navegador se frenan en segundo plano).
  @HostListener('document:visibilitychange')
  alCambiarVisibilidad(): void {
    if (!document.hidden) this.widgets.forEach((w) => { if (!w.propio) this.cargarDatos(w.id); });
  }

  get saludo(): string {
    const h = this.hoy.getHours();
    return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  }

  get fechaTexto(): string {
    return this.hoy.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  cargarLista(): void {
    this.cargandoLista = true;
    this.errorLista = '';
    this.servicio.widgets().subscribe({
      next: (r) => {
        // Primero los filtros de la persona, para pedir cada cuadro ya filtrado (si fallan, se usan los del navegador).
        this.servicio.preferencias().pipe(catchError(() => of({ tabla: false, preferencias: {} } as PreferenciasInicio))).subscribe((p) => {
          this.prefs = { ...this.leerLocal(), ...(p.preferencias || {}) };
          this.iniciarWidgets(r.widgets);
        });
      },
      error: (e) => {
        this.errorLista = e?.error?.error || 'No se pudo cargar la pantalla de inicio.';
        this.cargandoLista = false;
      },
    });
  }

  private iniciarWidgets(lista: WidgetInicio[]): void {
    this.temporizadoresLimpiar();
    this.widgets = lista;
    this.cargandoLista = false;
    for (const w of this.widgets) {
      if (w.propio) {
        // El cuadro se actualiza solo (p. ej. F5 en vivo): no necesita el temporizador general.
        this.estados.set(w.id, { cargando: false, error: null, datos: null, ts: null });
        continue;
      }
      this.estados.set(w.id, { cargando: true, error: null, datos: null, ts: null });
      this.cargarDatos(w.id);
      this.temporizadores.set(w.id, setInterval(() => { if (!document.hidden) this.cargarDatos(w.id); }, w.intervaloSeg * 1000));
    }
    this.cdr.markForCheck();
  }

  private temporizadoresLimpiar(): void {
    this.temporizadores.forEach((t) => clearInterval(t));
    this.temporizadores.clear();
  }

  cargarDatos(id: WidgetId, forzar = false): void {
    if (this.enVuelo.has(id) && !forzar) return;
    this.enVuelo.add(id);
    // Si cambian los filtros con una petición en curso, la respuesta vieja se descarta.
    const v = (this.version.get(id) ?? 0) + (forzar ? 1 : 0);
    this.version.set(id, v);
    this.servicio.datos<unknown>(id, this.prefs[id]).subscribe({
      next: (r) => {
        if (this.version.get(id) !== v) return;
        this.enVuelo.delete(id);
        const prev = this.estados.get(id);
        if (r.error) {
          // Si ya había datos, se conservan y solo se marca el aviso.
          this.estados.set(id, { cargando: false, error: r.error, datos: prev?.datos ?? null, ts: prev?.ts ?? null });
        } else {
          this.estados.set(id, { cargando: false, error: null, datos: r.datos ?? null, ts: Date.parse(r.generadoEn) || Date.now() });
        }
        this.cdr.markForCheck();
      },
      error: (e) => {
        if (this.version.get(id) !== v) return;
        this.enVuelo.delete(id);
        const prev = this.estados.get(id);
        this.estados.set(id, { cargando: false, error: e?.error?.error || 'No se pudo actualizar.', datos: prev?.datos ?? null, ts: prev?.ts ?? null });
        this.cdr.markForCheck();
      },
    });
  }

  actualizarTodo(): void {
    this.hoy = new Date();
    this.widgets.forEach((w) => { if (!w.propio) this.cargarDatos(w.id); });
  }

  alCerrarConfig(cambio: boolean): void {
    this.mostrarConfig = false;
    if (cambio) this.cargarLista();
  }

  // ---- Filtros por persona ----
  opcionesDe(id: WidgetId): OpcionesWidget | null { return this.prefs[id] ?? null; }

  guardarOpciones(id: WidgetId, op: OpcionesWidget): void {
    this.prefs = { ...this.prefs, [id]: op };
    this.guardarLocal();
    const w = this.widgets.find((x) => x.id === id);
    if (w && !w.propio) this.cargarDatos(id, true);
    this.servicio.guardarPreferencia(id, op).subscribe({
      next: () => { this.avisoPrefs = ''; this.cdr.markForCheck(); },
      error: (e) => {
        this.avisoPrefs = e?.error?.error || 'No se pudieron guardar tus filtros en el servidor; quedan guardados en este navegador.';
        this.cdr.markForCheck();
      },
    });
  }

  restablecerOpciones(id: WidgetId): void {
    const { [id]: _quitar, ...resto } = this.prefs;
    this.prefs = resto;
    this.guardarLocal();
    const w = this.widgets.find((x) => x.id === id);
    if (w && !w.propio) this.cargarDatos(id, true);
    this.servicio.borrarPreferencia(id).subscribe({ next: () => undefined, error: () => undefined });
  }

  private leerLocal(): Prefs {
    try { return JSON.parse(localStorage.getItem(this.claveLocal) || '{}') as Prefs; } catch { return {}; }
  }
  private guardarLocal(): void {
    try { localStorage.setItem(this.claveLocal, JSON.stringify(this.prefs)); } catch { /* sin almacenamiento local */ }
  }

  // ---- Acceso tipado a cada widget ----
  est(id: WidgetId): Estado<unknown> { return this.estados.get(id) || { cargando: true, error: null, datos: null, ts: null }; }
  get certs(): DatosCertificados | null { return this.est('certificados').datos as DatosCertificados | null; }
  get pasos(): DatosPasos | null { return this.est('pasos').datos as DatosPasos | null; }
  get tareas(): DatosTareas | null { return this.est('tareas').datos as DatosTareas | null; }
  get inventario(): DatosInventario | null { return this.est('inventario').datos as DatosInventario | null; }

  ruta(id: WidgetId): string { return RUTAS[id]; }
  trackWidget = (_: number, w: WidgetInicio) => w.id;

  // ---- Formato ----
  n(v: number | null | undefined): string { return v === null || v === undefined ? '—' : new Intl.NumberFormat('es-CO').format(v); }
  pct(parte: number, total: number): number { return total > 0 ? Math.round((parte / total) * 100) : 0; }

  fecha(f: string | null): string {
    if (!f) return 'Sin fecha';
    const d = new Date(f);
    return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }) + (/T\d\d:\d\d/.test(f) && !f.endsWith('T00:00:00.000Z')
      ? ' ' + d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
  }
  diasTexto(d: number): string {
    if (d < 0) return `Vencido hace ${-d} d`;
    if (d === 0) return 'Vence hoy';
    return `${d} d`;
  }
  clasePrioridad(p: string | null): string {
    const v = (p || '').toUpperCase();
    return v === 'ALTA' || v === 'URGENTE' ? 'est-mal' : v === 'MEDIA' ? 'est-aviso' : 'est-nulo';
  }
  haceCuanto(ts: number | null): string {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `hace ${s} s`;
    return `hace ${Math.round(s / 60)} min`;
  }
  get estadosPasos(): { clave: string; etiqueta: string; valor: number }[] {
    const e = this.pasos?.porEstado || {};
    return [
      { clave: 'PROGRAMADO', etiqueta: 'Programados', valor: e['PROGRAMADO'] || 0 },
      { clave: 'EJECUTADO', etiqueta: 'Ejecutados', valor: e['EJECUTADO'] || 0 },
      { clave: 'REAGENDADO', etiqueta: 'Reagendados', valor: e['REAGENDADO'] || 0 },
      { clave: 'ROLLBACK', etiqueta: 'Rollback', valor: e['ROLLBACK'] || 0 },
      { clave: 'CANCELADO', etiqueta: 'Cancelados', valor: e['CANCELADO'] || 0 },
    ];
  }
  get estadosTareas(): { etiqueta: string; valor: number }[] {
    const e = this.tareas?.porEstado || {};
    return [
      { etiqueta: 'Pendientes', valor: e['PENDIENTE'] || 0 },
      { etiqueta: 'En progreso', valor: e['EN_PROGRESO'] || 0 },
      { etiqueta: 'Completadas', valor: e['COMPLETADA'] || 0 },
    ];
  }
}
