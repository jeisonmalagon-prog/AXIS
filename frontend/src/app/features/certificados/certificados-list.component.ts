import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CertificadoService, CatalogoUbicaciones } from '../../core/services/certificado.service';
import { AuthService } from '../../services/auth.service';
import { CertificadoVigencia } from '../../core/models/models';
import { CertificadoAsistenteComponent, ModoAsistente } from './certificado-asistente.component';
import { CertificadosContenedoresComponent } from './certificados-contenedores.component';
import { GrupoCertificado, agruparCertificados, idDe } from './certificado-grupo';

type Filtro = 'Todos' | 'Vigente' | 'Por vencer' | 'Vencido';
type CampoOrden = 'nombre' | 'servidor' | 'vence' | 'estado';

// Un certificado (lo que la gente entiende) con lo que la tabla necesita ya calculado.
export interface GrupoVista extends GrupoCertificado {
  apps: string[];
  busqueda: string;
  primerServidor: string;
}

// Una ubicación de un certificado, lista para mostrarse en el detalle.
export interface UbicacionVista {
  componente: string | null;
  servidor: string;
  ip: string;
  puerto: number | null;
  apps: string[];
  sinDefinir: boolean;
  antes: string | null;
}

@Component({
  selector: 'app-certificados-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, CertificadoAsistenteComponent, CertificadosContenedoresComponent],
  templateUrl: './certificados-list.component.html',
  styleUrl: './certificados-list.component.scss',
})
export class CertificadosListComponent implements OnInit {
  certificados: CertificadoVigencia[] = [];
  grupos: GrupoVista[] = [];
  catalogo: CatalogoUbicaciones | null = null;

  opcionesFiltro: Filtro[] = ['Todos', 'Vigente', 'Por vencer', 'Vencido'];
  filtro: Filtro = 'Todos';

  // Orden y paginación. Por defecto: los que vencen antes primero.
  ordenCampo: CampoOrden = 'vence';
  ordenDireccion: 1 | -1 = 1;
  paginaActual = 1;
  tamanoPagina = 25;
  opcionesTamanoPagina = [10, 25, 50, 100];

  terminoBusqueda = '';

  // Solo ADMIN_POD/ADMIN_MIN pueden crear/editar/borrar. BASIC = solo lectura.
  puedeEditar = false;

  // Asistente (crear / editar / renovar).
  asistenteAbierto = false;
  asistenteModo: ModoAsistente = 'nuevo';
  asistenteGrupo: GrupoCertificado | null = null;

  // Detalle de un certificado (solo lectura).
  detalle: GrupoVista | null = null;
  ubicacionesDetalle: UbicacionVista[] = [];
  eliminando = false;

  // "¿Cómo se relacionan?" — explicación corta de la jerarquía.
  // Vista del módulo (se recuerda en la URL: ?vista=contenedores).
  vista: 'inventario' | 'contenedores' = 'inventario';

  constructor(
    private certificadoService: CertificadoService,
    private authService: AuthService,
    private ruta: ActivatedRoute,
    private router: Router,
  ) {}

  cambiarVista(v: 'inventario' | 'contenedores'): void {
    if (this.vista === v) return;
    this.vista = v;
    this.router.navigate([], { relativeTo: this.ruta, queryParams: { vista: v === 'inventario' ? null : v }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  // La pestaña de contenedores creó o cambió algo en el inventario: se recarga la lista y el catálogo.
  refrescarInventario(): void {
    this.cargar();
    this.cargarCatalogo();
  }

  ngOnInit(): void {
    this.vista = this.ruta.snapshot.queryParamMap.get('vista') === 'contenedores' ? 'contenedores' : 'inventario';
    this.puedeEditar = this.authService.puedeEditar('CERTIFICADOS');
    this.cargar();
    this.cargarCatalogo();
  }

  cargar(): void {
    this.certificadoService.listar().subscribe((data) => {
      this.certificados = data;
      this.reconstruir();
      this.paginaActual = 1;
    });
  }

  private cargarCatalogo(): void {
    this.certificadoService.catalogoUbicaciones().subscribe({
      next: (c) => {
        this.catalogo = c;
        this.reconstruir();
      },
      error: () => { /* la lista funciona sin catálogo; solo faltarán las aplicaciones de negocio */ },
    });
  }

  // ============================================================ agrupación
  // Aplicaciones de negocio de una ubicación (servidor + componente), tomadas del catálogo.
  private appsDeFila(f: CertificadoVigencia): string[] {
    if (f.ServidorId != null && f.Componente && this.catalogo) {
      const srv = this.catalogo.servidores.find((s) => s.id === f.ServidorId);
      const clave = f.Componente.toLowerCase();
      const comp = srv?.componentes.find((c) => c.rol.toLowerCase() === clave);
      if (comp) return comp.aplicaciones.map((a) => a.nombre);
      return [];
    }
    // Certificados de antes: solo se sabe la aplicación a la que estaban ligados.
    return f.Aplicacion ? [f.Aplicacion] : [];
  }

  private reconstruir(): void {
    this.grupos = agruparCertificados(this.certificados).map((g) => {
      const apps = Array.from(new Set(g.filas.flatMap((f) => this.appsDeFila(f)))).sort((a, b) => a.localeCompare(b));
      const primera = g.filas[0];
      const busqueda = [
        g.nombreComun, g.entidadEmisora, g.numeroSerie, g.thumbprint, g.responsable, g.observaciones, g.estado,
        ...g.filas.map((f) => `${f.Hostname || ''} ${f.IP || ''} ${f.Componente || ''}`),
        ...apps,
      ].join(' ').toLowerCase();
      return {
        ...g,
        apps,
        busqueda,
        primerServidor: (primera?.Hostname || '').toLowerCase(),
      } as GrupoVista;
    });
    // Si había un detalle abierto, se refresca con los datos nuevos.
    if (this.detalle) {
      const actual = this.grupos.find((g) => g.clave === this.detalle!.clave);
      if (actual) this.abrirDetalle(actual);
      else this.cerrarDetalle();
    }
  }

  // ============================================================ filtros / orden
  elegirFiltro(f: Filtro): void {
    this.filtro = f;
    this.paginaActual = 1;
  }

  filtrados(): GrupoVista[] {
    let resultado = this.grupos;
    if (this.filtro !== 'Todos') resultado = resultado.filter((g) => g.estado === this.filtro);
    const termino = this.terminoBusqueda.toLowerCase().trim();
    if (termino) resultado = resultado.filter((g) => g.busqueda.includes(termino));
    return resultado;
  }

  ordenarPor(campo: CampoOrden): void {
    if (this.ordenCampo === campo) {
      this.ordenDireccion = this.ordenDireccion === 1 ? -1 : 1;
    } else {
      this.ordenCampo = campo;
      this.ordenDireccion = 1;
    }
    this.paginaActual = 1;
  }

  private valorOrden(g: GrupoVista, campo: CampoOrden): string | number {
    switch (campo) {
      case 'nombre': return (g.nombreComun || '').toLowerCase();
      case 'servidor': return g.primerServidor;
      case 'estado': return ({ Vencido: 0, 'Por vencer': 1, Vigente: 2 } as Record<string, number>)[g.estado] ?? 9;
      case 'vence':
      default: return g.diasRestantes ?? 0;
    }
  }

  filtradosOrdenados(): GrupoVista[] {
    const campo = this.ordenCampo;
    const dir = this.ordenDireccion;
    return [...this.filtrados()].sort((a, b) => {
      const va = this.valorOrden(a, campo);
      const vb = this.valorOrden(b, campo);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  // ============================================================ paginación
  get totalFiltrados(): number { return this.filtradosOrdenados().length; }
  get totalPaginas(): number { return Math.max(1, Math.ceil(this.totalFiltrados / this.tamanoPagina)); }
  get paginaActualValida(): number { return Math.min(Math.max(1, this.paginaActual), this.totalPaginas); }

  get paginaItems(): GrupoVista[] {
    const inicio = (this.paginaActualValida - 1) * this.tamanoPagina;
    return this.filtradosOrdenados().slice(inicio, inicio + this.tamanoPagina);
  }

  get rangoDesde(): number { return this.totalFiltrados === 0 ? 0 : (this.paginaActualValida - 1) * this.tamanoPagina + 1; }
  get rangoHasta(): number { return Math.min(this.paginaActualValida * this.tamanoPagina, this.totalFiltrados); }

  irAPagina(n: number): void { this.paginaActual = Math.min(Math.max(1, n), this.totalPaginas); }

  // ============================================================ presentación
  estadoClase(estado: string): string {
    if (estado === 'Vigente') return 'status-vigente';
    if (estado === 'Por vencer') return 'status-por-vencer';
    return 'status-vencido';
  }

  bordeClase(estado: string): string {
    if (estado === 'Vigente') return 'borde-vigente';
    if (estado === 'Por vencer') return 'borde-por-vencer';
    return 'borde-vencido';
  }

  contarPorEstado(estado: 'Vigente' | 'Por vencer' | 'Vencido'): number {
    return this.grupos.filter((g) => g.estado === estado).length;
  }

  // Texto corto de "dónde está instalado" para la tabla.
  ubicacionResumen(g: GrupoVista): string {
    const f: any = g.filas[0];
    if (!f) return '—';
    if (!f.ServidorId || !f.Componente) return 'Sin ubicación definida';
    return `${f.Componente} · ${f.Hostname}`;
  }

  appsResumen(g: GrupoVista): { visibles: string[]; extra: number } {
    return { visibles: g.apps.slice(0, 2), extra: Math.max(0, g.apps.length - 2) };
  }

  // ============================================================ detalle
  abrirDetalle(g: GrupoVista): void {
    this.detalle = g;
    this.ubicacionesDetalle = g.filas.map((f: any) => {
      const sinDefinir = !f.ServidorId || !f.Componente;
      return {
        componente: f.Componente || null,
        servidor: f.Hostname || '',
        ip: f.IP || '',
        puerto: f.Puerto ?? null,
        apps: this.appsDeFila(f),
        sinDefinir,
        antes: sinDefinir ? f.Aplicacion || null : null,
      };
    });
  }

  cerrarDetalle(): void {
    this.detalle = null;
    this.ubicacionesDetalle = [];
  }

  // ============================================================ asistente
  nuevoCertificado(): void {
    if (!this.puedeEditar) return;
    this.asistenteGrupo = null;
    this.asistenteModo = 'nuevo';
    this.asistenteAbierto = true;
  }

  editarCertificado(g: GrupoVista): void {
    if (!this.puedeEditar) return;
    this.cerrarDetalle();
    this.asistenteGrupo = g;
    this.asistenteModo = 'editar';
    this.asistenteAbierto = true;
  }

  renovarCertificado(g: GrupoVista): void {
    if (!this.puedeEditar) return;
    this.cerrarDetalle();
    this.asistenteGrupo = g;
    this.asistenteModo = 'renovar';
    this.asistenteAbierto = true;
  }

  cerrarAsistente(): void {
    this.asistenteAbierto = false;
    this.asistenteGrupo = null;
  }

  asistenteGuardado(): void {
    this.cerrarAsistente();
    this.cargar();
    this.cargarCatalogo();
  }

  // ============================================================ eliminar
  async eliminarCertificado(g: GrupoVista): Promise<void> {
    if (!this.puedeEditar || this.eliminando) return;
    const n = g.filas.length;
    const texto = n > 1
      ? `¿Eliminar el certificado "${g.nombreComun || 'sin nombre'}" de sus ${n} ubicaciones?\n\nEsta acción no se puede deshacer.`
      : `¿Eliminar el certificado "${g.nombreComun || 'sin nombre'}"?\n\nEsta acción no se puede deshacer.`;
    if (!confirm(texto)) return;

    this.eliminando = true;
    const fallos: string[] = [];
    for (const f of g.filas) {
      const id = idDe(f);
      if (!id) { fallos.push('Un registro no tiene "Id" y no se pudo eliminar.'); continue; }
      try {
        await firstValueFrom(this.certificadoService.eliminar(id));
      } catch (err: any) {
        fallos.push(err?.error?.error || 'No se pudo eliminar una de las ubicaciones.');
      }
    }
    this.eliminando = false;
    if (fallos.length) alert(`❌ Algunas ubicaciones no se pudieron eliminar:\n${fallos.join('\n')}`);
    this.cargar();
  }
}
