import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { AzureBase } from './azure-base';
import { AzureFalloComponent } from './azure-fallo.component';
import { BarListComponent, ItemBarList } from '../../shared/charts/bar-list.component';
import { FalloAzure, falloDe, fmtDuracion, fmtFecha, fmtRelativo, iniciales } from './azure-utils';
import { IcoComponent } from '../../shared/ico/ico.component';

type SubVista = 'equipo' | 'politicas' | 'agentes' | 'ambientes' | 'artefactos' | 'conexiones' | 'variables' | 'permisos';

@Component({
  selector: 'app-azure-equipo',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule, AzureFalloComponent, BarListComponent],
  templateUrl: './azure-equipo.component.html',
  styleUrl: './azure-equipo.component.scss',
})
export class AzureEquipoComponent extends AzureBase implements OnInit {
  private readonly auth = inject(AuthService);
  readonly fmtFecha = fmtFecha; readonly fmtRelativo = fmtRelativo; readonly fmtDuracion = fmtDuracion; readonly iniciales = iniciales;

  esAdminPod = false;
  vista: SubVista = 'equipo';
  cargandoVista = false;
  falloVista: FalloAzure | null = null;

  proyecto: any = null;
  filtroPersona = '';
  politicas: any = null;
  ramasProtegidas: ItemBarList[] = [];
  agentes: any = null;
  ambientes: any = null;
  historial: { ambiente: any; registros: any[] } | null = null;
  feeds: any = null;
  feedAbierto: any = null;
  paquetes: any[] = [];
  textoPaquete = '';
  paquetesCargando = false;
  paquetesFallo: FalloAzure | null = null;
  conexiones: any = null;
  tiposConexion: ItemBarList[] = [];
  variables: any = null;
  permisos: any = null;

  override ngOnInit(): void {
    this.auth.usuarioLogueado$.subscribe((u) => { this.esAdminPod = u?.rol === 'ADMIN_POD'; });
    super.ngOnInit();
  }

  protected alCambiarRepo(): void {
    this.politicas = null; this.historial = null;
    this.cargarVista();
  }

  cambiarVista(v: SubVista): void { this.vista = v; this.cargarVista(); }

  cargarVista(): void {
    this.falloVista = null;
    switch (this.vista) {
      case 'equipo': if (!this.proyecto) this.pedir('/equipo/proyecto', {}, (r) => (this.proyecto = r), false); break;
      case 'politicas': if (!this.politicas) this.pedir('/equipo/politicas', {}, (r) => {
        this.politicas = r;
        this.ramasProtegidas = r.resumen.ramasProtegidas.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
      }); break;
      case 'agentes': if (!this.agentes) this.pedir('/equipo/agentes', {}, (r) => (this.agentes = r), false); break;
      case 'ambientes': if (!this.ambientes) this.pedir('/equipo/ambientes', {}, (r) => (this.ambientes = r), false); break;
      case 'artefactos': if (!this.feeds) this.pedir('/equipo/feeds', {}, (r) => (this.feeds = r), false); break;
      case 'conexiones': if (!this.conexiones) this.pedir('/equipo/conexiones', {}, (r) => {
        this.conexiones = r; this.tiposConexion = r.resumen.tipos.map((x: any) => ({ nombre: x.nombre, total: x.cantidad }));
      }, false); break;
      case 'variables': if (!this.variables) this.pedir('/equipo/variables', {}, (r) => (this.variables = r), false); break;
      case 'permisos': if (!this.permisos) this.cargarPermisos(); break;
    }
  }

  private pedir(ruta: string, params: Record<string, any>, ok: (r: any) => void, conRepo = true): void {
    this.cargandoVista = true;
    this.api.get<any>(ruta, params, conRepo).subscribe({
      next: (r) => { ok(r); this.cargandoVista = false; },
      error: (e) => { this.falloVista = falloDe(e, 'No se pudo cargar la información.'); this.cargandoVista = false; },
    });
  }

  cargarPermisos(): void {
    this.permisos = null;
    this.pedir('/permisos', {}, (r) => (this.permisos = r), false);
  }

  get personasFiltradas(): any[] {
    if (!this.proyecto) return [];
    const t = this.filtroPersona.trim().toLowerCase();
    return this.proyecto.personas.filter((p: any) => !t || p.nombre.toLowerCase().includes(t) || (p.usuario || '').toLowerCase().includes(t));
  }

  verHistorial(a: any): void {
    this.historial = { ambiente: a, registros: [] };
    this.api.get<any>(`/equipo/ambientes/${a.id}/historial`, {}, false).subscribe({
      next: (r) => { if (this.historial) this.historial.registros = r.registros; },
      error: () => { this.historial = null; },
    });
  }

  abrirFeed(f: any): void {
    this.feedAbierto = f; this.paquetes = []; this.textoPaquete = ''; this.buscarPaquetes();
  }

  buscarPaquetes(): void {
    if (!this.feedAbierto) return;
    this.paquetesCargando = true; this.paquetesFallo = null;
    this.api.get<any>(`/equipo/feeds/${this.feedAbierto.id}/paquetes`, { proyecto: this.feedAbierto.delProyecto ? 'true' : '', texto: this.textoPaquete.trim() }, false).subscribe({
      next: (r) => { this.paquetes = r.paquetes; this.paquetesCargando = false; },
      error: (e) => { this.paquetesFallo = falloDe(e, 'No se pudieron cargar los paquetes.'); this.paquetesCargando = false; },
    });
  }

  claseVoto(ok: boolean): string { return ok ? 'est-ok' : 'est-mal'; }
}
