import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CatalogoRespuesta, InformeCatalogo, InformesService, Programado, fmtFechaHoraInf } from './informes.service';
import { InformeDialogoComponent, ModoDialogo } from './informe-dialogo.component';

const ICONOS: Record<string, string> = {
  certificado: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3zm-1 14-3-3 1.4-1.4L11 13.2l3.6-3.6L16 11l-5 5z',
  aplicacion: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  servidor: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
  balanceador: 'M12 3v6m0 0-6 5m6-5 6 5M6 14v4m12-4v4M4 21h4m8 0h4M10 21h4',
  movil: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm4 17h.01',
  apuntamiento: 'M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7zm0 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  despliegue: 'M5 15c-1 2-1 5-1 5s3 0 5-1m-4-4c0-5 4-10 11-12 1 7-4 11-9 12m2-4 3 3m1-8h.01',
  general: 'M4 20V10m6 10V4m6 16v-8m4 8H2'
};

// ============================================================================
// Hub de informes: todo lo que el usuario puede descargar, agrupado, y la
// lista de envíos programados por correo.
// ============================================================================
@Component({
  selector: 'app-informes-hub',
  standalone: true,
  imports: [RouterLink, InformeDialogoComponent],
  templateUrl: './informes-hub.component.html',
  styleUrl: './informes-hub.component.scss'
})
export class InformesHubComponent implements OnInit {
  cat: CatalogoRespuesta | null = null;
  error: string | null = null;
  cargando = true;
  tab: 'informes' | 'programados' = 'informes';

  programados: Programado[] = [];
  progCargando = false;
  progDisponible = true;
  progError: string | null = null;

  dialogo: ModoDialogo | null = null;
  editando: Programado | null = null;
  aviso: { texto: string; tipo: 'ok' | 'error' } | null = null;
  descargando: string | null = null;
  enviandoId: number | null = null;
  confirmarBorrar: number | null = null;
  private avisoT: any;

  readonly fechaHora = fmtFechaHoraInf;
  readonly diasNombre = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

  constructor(private svc: InformesService, private ruta: ActivatedRoute, private router: Router) {}

  ngOnInit(): void {
    this.ruta.queryParamMap.subscribe((q) => {
      const t = q.get('tab') === 'programados' ? 'programados' : 'informes';
      if (t !== this.tab || (t === 'programados' && !this.programados.length && !this.progCargando)) { this.tab = t; if (t === 'programados') this.cargarProgramados(); }
    });
    this.svc.catalogo().subscribe({
      next: (c) => { this.cat = c; this.cargando = false; },
      error: (e) => { this.cargando = false; this.error = e?.error?.error || 'No se pudo cargar el catálogo de informes.'; }
    });
  }

  irATab(t: 'informes' | 'programados'): void { this.router.navigate([], { queryParams: { tab: t === 'informes' ? null : t }, replaceUrl: true }); }

  get categorias(): { nombre: string; items: InformeCatalogo[] }[] {
    const m = new Map<string, InformeCatalogo[]>();
    // «Ejecutivo» (informe general) va primero: es el más completo.
    const orden = (this.cat?.informes || []).slice().sort((a, b) => (a.categoria === 'Ejecutivo' ? -1 : 0) - (b.categoria === 'Ejecutivo' ? -1 : 0));
    for (const i of orden) { if (!m.has(i.categoria)) m.set(i.categoria, []); m.get(i.categoria)!.push(i); }
    return [...m.entries()].map(([nombre, items]) => ({ nombre, items }));
  }
  icono(n: string): string { return ICONOS[n] || ICONOS['general']; }
  tituloDe(clave: string): string { return this.cat?.informes.find((i) => i.clave === clave)?.titulo || clave; }

  descargar(i: InformeCatalogo, f: 'pdf' | 'xlsx', ev: Event): void {
    ev.preventDefault(); ev.stopPropagation();
    if (this.descargando) return;
    this.descargando = `${i.clave}-${f}`;
    this.svc.descargar(i.clave, f, { periodo: 'mes' }).subscribe({
      next: (blob) => {
        const a = document.createElement('a'); const u = URL.createObjectURL(blob);
        a.href = u; a.download = `informe-${i.clave}.${f}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
        this.descargando = null;
      },
      error: () => { this.descargando = null; this.mostrarAviso('No se pudo generar el archivo.', 'error'); }
    });
  }

  // --- Envíos programados ---
  cargarProgramados(): void {
    this.progCargando = true; this.progError = null;
    this.svc.programados().subscribe({
      next: (r) => { this.programados = r.programados; this.progDisponible = r.disponible; this.progCargando = false; },
      error: (e) => {
        this.progCargando = false;
        if (e?.status === 409) { this.progDisponible = false; this.progError = e?.error?.error || null; } else this.progError = e?.error?.error || 'No se pudieron cargar los envíos programados.';
      }
    });
  }
  frecuenciaTexto(p: Programado): string {
    const h = p.hora;
    if (p.frecuencia === 'diaria') return `Todos los días a las ${h}`;
    if (p.frecuencia === 'semanal') return `Cada ${this.diasNombre[p.diaSemana ?? 1]} a las ${h}`;
    return `El día ${p.diaMes} de cada mes a las ${h}`;
  }
  periodoTexto(c: string): string { return this.cat?.periodos.find((p) => p.clave === c)?.etiqueta || c; }
  abrir(modo: ModoDialogo, p: Programado | null = null): void { this.editando = p; this.dialogo = modo; }
  alHecho(msg: string): void { this.dialogo = null; this.editando = null; this.mostrarAviso(msg, 'ok'); this.cargarProgramados(); }
  enviarAhora(p: Programado): void {
    if (this.enviandoId !== null) return;
    this.enviandoId = p.id;
    this.svc.enviarProgramado(p.id).subscribe({
      next: (r) => { this.enviandoId = null; this.mostrarAviso(`Enviado a ${r.destinatarios.length} destinatario${r.destinatarios.length === 1 ? '' : 's'}.`, 'ok'); this.cargarProgramados(); },
      error: (e) => { this.enviandoId = null; this.mostrarAviso(e?.error?.error || 'No se pudo enviar.', 'error'); this.cargarProgramados(); }
    });
  }
  alternarActivo(p: Programado): void {
    this.svc.editarProgramado(p.id, {
      nombre: p.nombre, informe: p.informe, secciones: p.secciones, periodo: p.periodo, frecuencia: p.frecuencia, diaSemana: p.diaSemana, diaMes: p.diaMes,
      hora: p.hora, destinatarios: p.destinatarios, formatos: p.formatos, activo: !p.activo
    }).subscribe({ next: () => this.cargarProgramados(), error: (e) => this.mostrarAviso(e?.error?.error || 'No se pudo cambiar el estado.', 'error') });
  }
  borrar(p: Programado): void {
    if (this.confirmarBorrar !== p.id) { this.confirmarBorrar = p.id; setTimeout(() => { if (this.confirmarBorrar === p.id) this.confirmarBorrar = null; }, 4000); return; }
    this.confirmarBorrar = null;
    this.svc.borrarProgramado(p.id).subscribe({ next: () => { this.mostrarAviso('Envío programado eliminado.', 'ok'); this.cargarProgramados(); }, error: (e) => this.mostrarAviso(e?.error?.error || 'No se pudo eliminar.', 'error') });
  }
  mostrarAviso(texto: string, tipo: 'ok' | 'error'): void { this.aviso = { texto, tipo }; clearTimeout(this.avisoT); this.avisoT = setTimeout(() => (this.aviso = null), 6000); }
}
