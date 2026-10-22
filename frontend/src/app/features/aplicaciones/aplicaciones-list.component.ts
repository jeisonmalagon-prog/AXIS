import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { AplicacionService } from '../../core/services/aplicacion.service';
import { CertificadoService, CatalogoUbicaciones } from '../../core/services/certificado.service';
import { AuthService } from '../../services/auth.service';
import { SelectorBuscableComponent, OpcionSelector } from '../../shared/selector-buscable/selector-buscable.component';

// ============================================================================
// APLICACIONES DE NEGOCIO
// Una aplicación de negocio (lo que ve el negocio: "APP MOVIL", "TC GARANTIZADA")
// está compuesta por SUB-APLICATIVOS (un componente en un servidor: microservicio,
// API, contenedor, sitio...). Los sub-aplicativos se crean y se editan en
// Inventario → Sub-aplicativos; aquí SOLO se elige cuáles componen la aplicación.
// Así hay un único lugar donde se define un sub-aplicativo (nombre, puerto, tipo)
// y se evitan duplicados.
// ============================================================================

interface SubSeleccionable {
  id: number;
  rol: string;
  puerto: number | null;
  tipo: string | null;
  servidorId: number;
  hostname: string;
  ip: string;
  otrasApps: string[];
}

interface GrupoServidorSel {
  servidorId: number;
  hostname: string;
  ip: string;
  subs: SubSeleccionable[];
}

@Component({
  selector: 'app-aplicaciones-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SelectorBuscableComponent],
  templateUrl: './aplicaciones-list.component.html',
  styleUrl: './aplicaciones-list.component.scss',
})
export class AplicacionesListComponent implements OnInit {
  // El Inventario escucha estos eventos para cambiar de pestaña.
  @Output() verSubaplicativo = new EventEmitter<{ servidorId: number; subId: number }>();
  @Output() irASubaplicativos = new EventEmitter<void>();

  aplicaciones: any[] = [];
  catalogo: CatalogoUbicaciones | null = null;
  opcionesServidoresFiltro: OpcionSelector[] = [];
  mostrarForm = false;
  editando: any | null = null;
  terminoBusqueda = '';
  servidorFiltroId: number | null = null;

  // Solo ADMIN_POD/ADMIN_MIN pueden crear/editar/borrar. BASIC = solo lectura.
  puedeEditar = false;

  form: { nombre: string; imagenUrl: string } = { nombre: '', imagenUrl: '' };

  // --- selector de sub-aplicativos del formulario ---
  todasSubs: SubSeleccionable[] = [];
  seleccion: Record<number, boolean> = {};
  seleccionados: SubSeleccionable[] = [];
  terminoSub = '';
  gruposSel: GrupoServidorSel[] = [];
  guardando = false;

  constructor(
    private aplicacionService: AplicacionService,
    private certificadoService: CertificadoService,
    private authService: AuthService,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('CERTIFICADOS');
    this.cargar();
    this.cargarCatalogo();
  }

  cargar(): void {
    this.aplicacionService.listar().subscribe((data) => {
      this.aplicaciones = (data as any[]).map((app: any) => {
        app.servidores = (app.servidores || []).map((s: any) => ({ ...s, roles: s.roles || [] }));
        app.totalSubs = app.servidores.reduce((n: number, s: any) => n + s.roles.length, 0);
        return app;
      });
    });
  }

  private cargarCatalogo(): void {
    this.certificadoService.catalogoUbicaciones().subscribe((c) => {
      this.catalogo = c;
      this.opcionesServidoresFiltro = c.servidores.map((s) => ({ id: s.id, nombre: s.hostname, subtitulo: s.ip }));
      this.todasSubs = c.servidores.flatMap((s) =>
        s.componentes.map((k) => ({
          id: k.id, rol: k.rol, puerto: k.puerto, tipo: k.tipo,
          servidorId: s.id, hostname: s.hostname, ip: s.ip,
          otrasApps: k.aplicaciones.map((a) => a.nombre),
        }))
      );
      this.filtrarSubs();
    });
  }

  get aplicacionesFiltradas(): any[] {
    let resultado = this.aplicaciones;
    if (this.servidorFiltroId != null) {
      resultado = resultado.filter((app) =>
        (app.servidores || []).some((s: any) => (s.id ?? s.Id) === this.servidorFiltroId)
      );
    }
    if (this.terminoBusqueda) {
      const termino = this.terminoBusqueda.toLowerCase().trim();
      resultado = resultado.filter((app) => JSON.stringify(app).toLowerCase().includes(termino));
    }
    return resultado;
  }

  // ============================================================ formulario
  abrirFormulario(): void {
    if (!this.puedeEditar) return;
    this.editando = null;
    this.form = { nombre: '', imagenUrl: '' };
    this.seleccion = {};
    this.terminoSub = '';
    this.refrescarSeleccionados();
    this.filtrarSubs();
    this.mostrarForm = true;
  }

  editar(app: any): void {
    if (!this.puedeEditar) return;
    this.editando = app;
    this.form = { nombre: app.nombre || app.Nombre, imagenUrl: app.imagenUrl || app.ImagenUrl || '' };
    this.seleccion = {};
    for (const s of app.servidores || []) {
      for (const r of s.roles || []) if (r.id) this.seleccion[r.id] = true;
    }
    this.terminoSub = '';
    this.refrescarSeleccionados();
    this.filtrarSubs();
    this.mostrarForm = true;
  }

  cerrarFormulario(): void {
    this.mostrarForm = false;
  }

  onImagenError(event: any): void {
    event.target.style.display = 'none';
  }

  private refrescarSeleccionados(): void {
    this.seleccionados = this.todasSubs.filter((s) => this.seleccion[s.id]);
  }

  filtrarSubs(): void {
    const t = this.terminoSub.toLowerCase().trim();
    const mapa = new Map<number, GrupoServidorSel>();
    for (const s of this.todasSubs) {
      if (t) {
        const texto = `${s.rol} ${s.hostname} ${s.ip} ${s.puerto ?? ''} ${s.tipo ?? ''}`.toLowerCase();
        if (!texto.includes(t)) continue;
      }
      if (!mapa.has(s.servidorId)) mapa.set(s.servidorId, { servidorId: s.servidorId, hostname: s.hostname, ip: s.ip, subs: [] });
      mapa.get(s.servidorId)!.subs.push(s);
    }
    this.gruposSel = Array.from(mapa.values());
  }

  alternarSub(s: SubSeleccionable): void {
    this.seleccion[s.id] = !this.seleccion[s.id];
    this.refrescarSeleccionados();
  }

  quitarSub(s: SubSeleccionable): void {
    this.seleccion[s.id] = false;
    this.refrescarSeleccionados();
  }

  otrasAppsDe(s: SubSeleccionable): string {
    const propia = (this.editando?.nombre || this.editando?.Nombre || '').toString();
    return s.otrasApps.filter((n) => n !== propia).join(', ');
  }

  abrirSubaplicativo(servidorId: number, subId: number): void {
    this.verSubaplicativo.emit({ servidorId, subId });
  }

  irARegistrarSub(): void {
    this.cerrarFormulario();
    this.irASubaplicativos.emit();
  }

  // --- CLASIFICACIÓN VISUAL DE CADA ROL/CHIP ---
  // Cubre los patrones reales usados en el inventario (container_*, API_URL_*, etc.)
  // y los prefijos explícitos que deja el selector de "tipo" (MS_, GATEWAY_...).
  claseRol(rol: string): string {
    const r = (rol || '').toLowerCase();

    // Prefijos explícitos asignados desde el selector de tipo (ver agregarRol) —
    // tienen prioridad sobre las coincidencias por texto libre de abajo.
    if (r.startsWith('ms_') || r.startsWith('ms-')) return 'tag-ms';
    if (r.startsWith('gateway_') || r.startsWith('gateway-')) return 'tag-gateway';

    if (r.includes('kafka')) return 'tag-kafka';
    if (r.includes('suscriptor')) return 'tag-suscriptor';
    if (r.includes('orquestador')) return 'tag-orquestador';
    if (r.includes('gateway')) return 'tag-gateway';
    if (r.includes('api') || r.includes('akaunt') || r.includes('nodo') || r.includes('mensajeria'))
      return 'tag-api';
    if (r.includes('log')) return 'tag-logs';
    if (r.includes('imagen') || r.includes('doc') || r.includes('firm')) return 'tag-docs';
    if (r.includes('balanceador') || r.includes(' lb') || r.startsWith('lb')) return 'tag-balanceador';
    if (r.includes('job') || r.includes('batch') || r.includes('cron') || r.includes('scheduler'))
      return 'tag-job';
    if (r.includes('db') || r.includes('base de datos') || r.includes('sql') || r.includes('mysql'))
      return 'tag-db';
    // Convención existente en el inventario: nombres que ya empiezan con "MS"
    // (ej. MS_ABONO_CUOTA, MS_USUARIOS) son microservicios aunque no se hayan
    // agregado con el selector de tipo.
    if (r.startsWith('ms') || r.includes('microservicio')) return 'tag-ms';

    return 'tag-otro';
  }

  // ============================================================ guardado
  guardar(): void {
    if (!this.puedeEditar || this.guardando) return;
    if (!this.form.nombre.trim()) {
      alert('Escribe el nombre de la aplicación de negocio.');
      return;
    }
    const ids = this.seleccionados.map((s) => s.id);
    if (ids.length === 0 && !confirm('No elegiste ningún sub-aplicativo. La aplicación quedará sin componentes y no se podrán ver sus certificados ni su impacto.\n\n¿Guardar de todas formas?')) return;

    const payload: any = {
      Nombre: this.form.nombre.trim(),
      ImagenUrl: this.form.imagenUrl ? this.form.imagenUrl.trim() : null,
      ComponentesIds: ids,
    };

    const idApp = this.editando?.id || this.editando?.Id;
    const accion = this.editando
      ? this.aplicacionService.actualizar(idApp, payload)
      : this.aplicacionService.crear(payload);

    this.guardando = true;
    accion.subscribe({
      next: () => {
        this.guardando = false;
        this.cargar();
        this.cargarCatalogo();
        this.cerrarFormulario();
      },
      error: (err) => {
        this.guardando = false;
        console.error('Error guardando aplicación:', err);
        alert(`❌ Error al guardar:\n${err.error?.error || 'No se pudo guardar la aplicación. Intenta de nuevo.'}`);
      },
    });
  }

  eliminar(app: any): void {
    if (!this.puedeEditar) return;
    const nombreApp = app.nombre || app.Nombre;
    const idApp = app.id || app.Id;
    if (!confirm(`¿Eliminar la aplicación de negocio ${nombreApp}?\n\nLos sub-aplicativos NO se borran: solo se quita su relación con esta aplicación.`)) return;
    if (idApp) {
      this.aplicacionService.eliminar(idApp).subscribe({
        next: () => { this.cargar(); this.cargarCatalogo(); },
        error: (err) => {
          console.error('Error eliminando aplicación:', err);
          alert(`❌ Error al eliminar:\n${err.error?.error || 'No se pudo eliminar la aplicación. Intenta de nuevo.'}`);
        },
      });
    }
  }
}
