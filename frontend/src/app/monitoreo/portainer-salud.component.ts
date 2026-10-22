import { Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription, interval } from 'rxjs';
import {
  AlertaPortainer, CategoriaHigiene, ContenedorSalud, PortainerSaludService, RespuestaAlertas, RespuestaHigiene, RespuestaSalud, RespuestaStacks, StackInfo
} from './portainer-salud.service';

export type VistaSalud = 'salud' | 'stacks' | 'higiene';

// ============================================================================
// Salud real, stacks y higiene de Portainer (tres vistas de un mismo componente).
// Los datos los arma el backend (utils/portainerSalud.js) con un inspect de cada
// contenedor; aquí solo se presentan. Se refresca solo cada minuto.
// ============================================================================
@Component({
  selector: 'app-portainer-salud',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './portainer-salud.component.html',
  styleUrl: './portainer-salud.component.scss'
})
export class PortainerSaludComponent implements OnInit, OnChanges, OnDestroy {
  @Input() vista: VistaSalud = 'salud';
  @Input() puedeEditar = false;

  salud: RespuestaSalud | null = null;
  stacks: RespuestaStacks | null = null;
  higiene: RespuestaHigiene | null = null;
  alertas: RespuestaAlertas | null = null;
  cargando = false;
  error: string | null = null;
  aviso: { texto: string; tipo: 'ok' | 'error' } | null = null;
  private avisoT: any;
  private subs: Subscription[] = [];
  private pedido?: Subscription;

  // Filtros
  nivel: 'todos' | 'critico' | 'aviso' = 'todos';
  entornoFiltro: number | 0 = 0;
  buscar = '';
  estadoStack: 'todos' | 'atencion' | 'ok' = 'todos';
  abiertos = new Set<string>();
  verTodoProblemas = false;
  categoriasAbiertas = new Set<string>(['volumenes_huerfanos', 'privilegiados']);
  confirmando: string | null = null;
  trabajando: string | null = null;

  constructor(private svc: PortainerSaludService) {}

  ngOnInit(): void {
    this.cargar();
    this.subs.push(interval(60_000).subscribe(() => { if (!document.hidden && !this.trabajando) this.cargar(false, true); }));
  }
  ngOnChanges(c: SimpleChanges): void { if (c['vista'] && !c['vista'].firstChange) { this.confirmando = null; this.cargar(); } }
  ngOnDestroy(): void { this.subs.forEach((s) => s.unsubscribe()); this.pedido?.unsubscribe(); clearTimeout(this.avisoT); }

  cargar(fresco = false, silencioso = false): void {
    this.pedido?.unsubscribe();
    if (!silencioso) this.cargando = true;
    const ok = () => { this.cargando = false; this.error = null; };
    const fallo = (e: any) => { this.cargando = false; this.error = e?.error?.error || 'No se pudo consultar la salud de Portainer.'; };
    if (this.vista === 'salud') {
      this.pedido = this.svc.salud(fresco).subscribe({ next: (r) => { this.salud = r; this.error = r.error || null; this.cargando = false; }, error: fallo });
      this.svc.alertas().subscribe({ next: (a) => (this.alertas = a), error: () => undefined });
    } else if (this.vista === 'stacks') {
      this.pedido = this.svc.stacks(fresco).subscribe({ next: (r) => { this.stacks = r; this.error = r.error || null; this.cargando = false; }, error: fallo });
    } else {
      this.pedido = this.svc.higiene(fresco).subscribe({ next: (r) => { this.higiene = r; this.error = r.error || null; this.cargando = false; }, error: fallo });
    }
    void ok;
  }

  get configurado(): boolean {
    const r = this.vista === 'salud' ? this.salud : this.vista === 'stacks' ? this.stacks : this.higiene;
    return r ? r.configurado : true;
  }
  get generadoEn(): string | null {
    return (this.vista === 'salud' ? this.salud : this.vista === 'stacks' ? this.stacks : this.higiene)?.generadoEn || null;
  }

  // ---------- Salud ----------
  get problemasFiltrados(): ContenedorSalud[] {
    const q = this.buscar.trim().toLowerCase();
    return (this.salud?.problemas || []).filter((c) =>
      (this.nivel === 'todos' || c.nivel === this.nivel) && (!this.entornoFiltro || c.entornoId === this.entornoFiltro)
      && (!q || `${c.nombre} ${c.entorno} ${c.imagen} ${c.problemas.map((p) => p.titulo).join(' ')}`.toLowerCase().includes(q)));
  }
  get problemasVisibles(): ContenedorSalud[] { const l = this.problemasFiltrados; return this.verTodoProblemas ? l : l.slice(0, 15); }
  elegirEntorno(id: number): void { this.entornoFiltro = this.entornoFiltro === id ? 0 : id; }
  clave(c: ContenedorSalud): string { return `${c.entornoId}:${c.id}`; }
  alternar(k: string): void { if (this.abiertos.has(k)) this.abiertos.delete(k); else this.abiertos.add(k); }
  etiquetaSemaforo(s: string | undefined): string { return s === 'ok' ? 'Todo en orden' : s === 'aviso' ? 'Hay avisos' : s === 'critico' ? 'Atención: hay problemas críticos' : '—'; }
  estadoTexto(c: ContenedorSalud): string {
    switch (c.estado) { case 'running': return 'Corriendo'; case 'restarting': return 'Reiniciando'; case 'exited': return 'Detenido'; case 'paused': return 'En pausa'; case 'dead': return 'Muerto'; case 'created': return 'Creado'; default: return c.estado; }
  }
  saludTexto(s: string): string { return s === 'healthy' ? 'Saludable' : s === 'unhealthy' ? 'Falla' : s === 'starting' ? 'Iniciando' : 'Sin healthcheck'; }
  reiniciarContenedor(c: ContenedorSalud): void {
    const k = `c:${this.clave(c)}`;
    if (this.confirmando !== k) { this.confirmando = k; setTimeout(() => { if (this.confirmando === k) this.confirmando = null; }, 4000); return; }
    this.confirmando = null; this.trabajando = k;
    this.svc.reiniciarContenedor(c.entornoId, c.id).subscribe({
      next: () => { this.trabajando = null; this.mostrar(`«${c.nombre}» se está reiniciando.`, 'ok'); setTimeout(() => this.cargar(true, true), 2500); },
      error: (e) => { this.trabajando = null; this.mostrar(e?.error?.error || 'No se pudo reiniciar el contenedor.', 'error'); }
    });
  }
  alertaIcono(a: AlertaPortainer): string { return a.nivel === 'ok' ? 'ok' : 'critico'; }

  // ---------- Stacks ----------
  get stacksFiltrados(): StackInfo[] {
    const q = this.buscar.trim().toLowerCase();
    return (this.stacks?.stacks || []).filter((s) =>
      (!this.entornoFiltro || s.entornoId === this.entornoFiltro)
      && (this.estadoStack === 'todos' || (this.estadoStack === 'ok' ? s.estado === 'ok' : s.estado !== 'ok'))
      && (!q || `${s.nombre} ${s.entorno} ${s.versiones.map((v) => v.repo + ' ' + v.tags.join(' ')).join(' ')}`.toLowerCase().includes(q)));
  }
  get entornosStacks(): { id: number; nombre: string }[] {
    const m = new Map<number, string>(); (this.stacks?.stacks || []).forEach((s) => m.set(s.entornoId, s.entorno));
    return [...m.entries()].map(([id, nombre]) => ({ id, nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }
  estadoStackTexto(e: string): string { return ({ ok: 'Todo activo', avisos: 'Con avisos', parcial: 'Parcial', problemas: 'Con problemas', caido: 'Detenido' } as Record<string, string>)[e] || e; }
  repoCorto(r: string): string { const p = r.split('/'); return p[p.length - 1]; }
  reiniciarStack(s: StackInfo): void {
    const k = `s:${s.entornoId}:${s.nombre}`;
    if (this.confirmando !== k) { this.confirmando = k; setTimeout(() => { if (this.confirmando === k) this.confirmando = null; }, 5000); return; }
    this.confirmando = null; this.trabajando = k;
    this.svc.reiniciarStack(s.entornoId, s.nombre).subscribe({
      next: (r) => {
        this.trabajando = null;
        this.mostrar(r.fallidos.length ? `Stack «${s.nombre}»: ${r.reiniciados} reiniciados y ${r.fallidos.length} con error (${r.fallidos[0].nombre}).` : `Stack «${s.nombre}» reiniciado (${r.reiniciados} contenedores).`, r.fallidos.length ? 'error' : 'ok');
        setTimeout(() => this.cargar(true, true), 3000);
      },
      error: (e) => { this.trabajando = null; this.mostrar(e?.error?.error || 'No se pudo reiniciar el stack.', 'error'); }
    });
  }

  // ---------- Higiene ----------
  alternarCategoria(c: CategoriaHigiene): void { if (this.categoriasAbiertas.has(c.codigo)) this.categoriasAbiertas.delete(c.codigo); else this.categoriasAbiertas.add(c.codigo); }
  itemsDe(c: CategoriaHigiene): CategoriaHigiene['items'] { return c.items.slice(0, this.verTodasCat.has(c.codigo) ? 250 : 8); }
  verTodasCat = new Set<string>();
  alternarVerTodas(c: CategoriaHigiene): void { if (this.verTodasCat.has(c.codigo)) this.verTodasCat.delete(c.codigo); else this.verTodasCat.add(c.codigo); }
  bytesTexto(b: number): string {
    let n = b; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toLocaleString('es-CO', { maximumFractionDigits: i === 0 ? 0 : 1 })} ${u[i]}`;
  }
  colorPuntaje(p: number | null): string { return p === null ? 'var(--ax-border, #cbd5e1)' : p >= 80 ? 'var(--f-ok)' : p >= 60 ? 'var(--f-warn)' : 'var(--f-err)'; }
  limpiar(entornoId: number, nombre: string, modo: 'huerfanas' | 'antiguas'): void {
    const k = `l:${entornoId}:${modo}`;
    if (this.confirmando !== k) { this.confirmando = k; setTimeout(() => { if (this.confirmando === k) this.confirmando = null; }, 5000); return; }
    this.confirmando = null; this.trabajando = k;
    this.svc.limpiarImagenes(entornoId, modo, this.higiene?.diasImagenAntigua).subscribe({
      next: (r) => { this.trabajando = null; this.mostrar(`${nombre}: ${r.eliminadas} imagen(es) eliminadas, ${r.espacioLiberado} liberados${r.fallidas.length ? ` (${r.fallidas.length} no se pudieron borrar)` : ''}.`, 'ok'); this.cargar(true, true); },
      error: (e) => { this.trabajando = null; this.mostrar(e?.error?.error || 'No se pudo limpiar.', 'error'); }
    });
  }

  // ---------- Utilidades ----------
  hace(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso); if (Number.isNaN(t)) return '—';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'hace instantes';
    const m = Math.round(s / 60); if (m < 60) return `hace ${m} min`;
    const h = Math.round(m / 60); if (h < 48) return `hace ${h} h`;
    return `hace ${Math.round(h / 24)} días`;
  }
  fecha(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso); if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  mostrar(texto: string, tipo: 'ok' | 'error'): void { this.aviso = { texto, tipo }; clearTimeout(this.avisoT); this.avisoT = setTimeout(() => (this.aviso = null), 7000); }
}
