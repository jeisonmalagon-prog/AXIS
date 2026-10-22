import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription, combineLatest } from 'rxjs';
import { InformeGraficoComponent } from './informe-grafico.component';
import { InformeTablaComponent } from './informe-tabla.component';
import { InformeDialogoComponent, ModoDialogo } from './informe-dialogo.component';
import {
  CatalogoRespuesta, InfBloque, InfGrafico, InfKpi, InfTabla, InfTexto, Informe, InformeCatalogo, InformesService, ParamsInforme, fmtFechaHoraInf, fmtFechaInf, formatear
} from './informes.service';

// ============================================================================
// Visor de un informe. El periodo y las secciones viven en la URL (se puede
// compartir el enlace). PDF y Excel salen de la MISMA definición que se ve
// aquí; «Enviar por correo» y «Programar» abren el diálogo.
// ============================================================================
@Component({
  selector: 'app-informe-viewer',
  standalone: true,
  imports: [RouterLink, FormsModule, InformeGraficoComponent, InformeTablaComponent, InformeDialogoComponent],
  templateUrl: './informe-viewer.component.html',
  styleUrl: './informe-viewer.component.scss'
})
export class InformeViewerComponent implements OnInit, OnDestroy {
  clave = '';
  cat: CatalogoRespuesta | null = null;
  def: InformeCatalogo | null = null;
  informe: Informe | null = null;
  cargando = true;
  error: string | null = null;
  sinAcceso = false;
  descargando: 'pdf' | 'xlsx' | null = null;
  aviso: { texto: string; tipo: 'ok' | 'error' } | null = null;

  // Filtros (reflejados en la URL)
  periodo = 'mes';
  desde = ''; hasta = '';
  personalizado = false;
  errorFechas: string | null = null;
  seccionesSel: string[] = [];
  mostrarSecciones = false;

  dialogo: ModoDialogo | null = null;
  private subs: Subscription[] = [];
  private pedido?: Subscription;
  private avisoT: any;

  constructor(private svc: InformesService, private ruta: ActivatedRoute, private router: Router) {}

  ngOnInit(): void {
    this.subs.push(combineLatest([this.ruta.paramMap, this.ruta.queryParamMap]).subscribe(([p, q]) => {
      this.clave = p.get('clave') || '';
      const d = q.get('desde'); const h = q.get('hasta');
      if (d && h) { this.personalizado = true; this.desde = d; this.hasta = h; } else { this.personalizado = false; this.periodo = q.get('periodo') || 'mes'; }
      const s = (q.get('secciones') || '').split(',').filter(Boolean);
      this.cargarCatalogoYInforme(s);
    }));
  }
  ngOnDestroy(): void { this.subs.forEach((s) => s.unsubscribe()); this.pedido?.unsubscribe(); clearTimeout(this.avisoT); }

  private cargarCatalogoYInforme(secUrl: string[]): void {
    this.cargando = true; this.error = null;
    this.subs.push(this.svc.catalogo().subscribe({
      next: (c) => {
        this.cat = c;
        this.def = c.informes.find((i) => i.clave === this.clave) || null;
        if (!this.def) { this.sinAcceso = true; this.cargando = false; this.informe = null; return; }
        this.sinAcceso = false;
        const todas = (this.def.secciones || []).map((x) => x.clave);
        this.seccionesSel = secUrl.length ? secUrl.filter((x) => todas.includes(x)) : [...todas];
        this.cargar();
      },
      error: (e) => { this.cargando = false; this.error = e?.error?.error || 'No se pudo cargar el catálogo de informes.'; }
    }));
  }

  get params(): ParamsInforme {
    const p: ParamsInforme = this.personalizado ? { desde: this.desde, hasta: this.hasta } : { periodo: this.periodo };
    if (this.def?.clave === 'general') p.secciones = this.seccionesSel;
    return p;
  }

  cargar(): void {
    this.pedido?.unsubscribe();
    this.cargando = true; this.error = null;
    this.pedido = this.svc.obtener(this.clave, this.params).subscribe({
      next: (i) => { this.informe = i; this.cargando = false; },
      error: (e) => { this.cargando = false; this.informe = null; this.error = e?.error?.error || 'No se pudo generar el informe.'; }
    });
  }

  // --- Filtros ---
  private url(extra: Record<string, any>): void {
    this.router.navigate([], { relativeTo: this.ruta, queryParams: { periodo: null, desde: null, hasta: null, secciones: null, ...extra }, replaceUrl: true });
  }
  elegirPeriodo(clave: string): void {
    this.errorFechas = null;
    this.url({ periodo: clave, secciones: this.def?.clave === 'general' ? this.seccionesSel.join(',') : null });
  }
  abrirPersonalizado(): void {
    if (!this.desde || !this.hasta) {
      const f = this.informe?.periodo;
      this.desde = f?.desde || ''; this.hasta = f?.hasta || '';
    }
    this.personalizado = true;
  }
  aplicarFechas(): void {
    this.errorFechas = null;
    if (!this.desde || !this.hasta) { this.errorFechas = 'Elige la fecha inicial y la final.'; return; }
    if (this.desde > this.hasta) { this.errorFechas = 'La fecha inicial debe ser anterior o igual a la final.'; return; }
    const dias = Math.round((new Date(`${this.hasta}T00:00:00`).getTime() - new Date(`${this.desde}T00:00:00`).getTime()) / 86400000) + 1;
    if (dias > 400) { this.errorFechas = 'El rango no puede superar 400 días.'; return; }
    this.url({ desde: this.desde, hasta: this.hasta, secciones: this.def?.clave === 'general' ? this.seccionesSel.join(',') : null });
  }
  alternarSeccion(c: string): void { this.seccionesSel = this.seccionesSel.includes(c) ? this.seccionesSel.filter((x) => x !== c) : [...this.seccionesSel, c]; }
  aplicarSecciones(): void {
    if (!this.seccionesSel.length) { this.error = 'Elige al menos una sección.'; return; }
    this.url({ ...(this.personalizado ? { desde: this.desde, hasta: this.hasta } : { periodo: this.periodo }), secciones: this.seccionesSel.join(',') });
    this.mostrarSecciones = false;
  }
  get todasMarcadas(): boolean { return !!this.def?.secciones && this.seccionesSel.length === this.def.secciones.length; }
  marcarTodas(): void { this.seccionesSel = this.todasMarcadas ? [] : (this.def?.secciones || []).map((s) => s.clave); }

  // --- Descargas ---
  descargar(formato: 'pdf' | 'xlsx'): void {
    if (this.descargando) return;
    this.descargando = formato;
    this.svc.descargar(this.clave, formato, this.params).subscribe({
      next: (blob) => {
        const inf = this.informe; const per = inf?.periodo;
        const nombre = `informe-${this.clave}${per ? `_${per.desde}_a_${per.hasta}` : ''}.${formato}`;
        const a = document.createElement('a'); const u = URL.createObjectURL(blob);
        a.href = u; a.download = nombre; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
        this.descargando = null;
      },
      error: async (e) => {
        this.descargando = null;
        let msg = 'No se pudo generar el archivo.';
        try { const t = e?.error instanceof Blob ? JSON.parse(await e.error.text()) : e?.error; if (t?.error) msg = t.error; } catch { /* ignora */ }
        this.mostrarAviso(msg, 'error');
      }
    });
  }

  // --- Diálogo ---
  abrirDialogo(m: ModoDialogo): void { this.dialogo = m; }
  alHecho(msg: string): void { this.dialogo = null; this.mostrarAviso(msg, 'ok'); }
  mostrarAviso(texto: string, tipo: 'ok' | 'error'): void { this.aviso = { texto, tipo }; clearTimeout(this.avisoT); this.avisoT = setTimeout(() => (this.aviso = null), 6000); }

  // --- Presentación ---
  get resumenPeriodo(): string {
    const p = this.informe?.periodo;
    if (!p) return '';
    return p.desde === p.hasta ? fmtFechaInf(p.desde) : `${fmtFechaInf(p.desde)} al ${fmtFechaInf(p.hasta)}`;
  }
  readonly fechaHora = fmtFechaHoraInf;
  kpiValor(k: InfKpi): string { return formatear(k.valor, k.fmt); }
  esGrafico(b: InfBloque): b is InfGrafico { return b.tipo === 'grafico'; }
  esTabla(b: InfBloque): b is InfTabla { return b.tipo === 'tabla'; }
  esTexto(b: InfBloque): b is InfTexto { return b.tipo === 'texto'; }
  medio(b: InfBloque): boolean { return b.tipo === 'grafico' && b.ancho === 'medio'; }
  irASeccion(id: string): void { document.getElementById('sec-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  iconoNivel(n: string): string {
    switch (n) {
      case 'critico': return 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z';
      case 'aviso': return 'M12 8v5m0 3h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z';
      case 'ok': return 'M20 6 9 17l-5-5';
      default: return 'M12 16v-5m0-3h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z';
    }
  }
  get puedeProgramar(): boolean { return !!this.def?.programable; }
}
