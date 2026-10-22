import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../environments/environment';
import { IcoComponent } from '../../shared/ico/ico.component';

interface UsuarioAcc { id: number; username: string; nombre: string; rol: string; tieneModulo: boolean; }
interface SeccionAcc { id: string; nombre: string; descripcion: string; porRepo: boolean; }
interface RepoAcc { nombre: string; ramaPorDefecto: string | null; deshabilitado: boolean; huerfano?: boolean; }
interface RespuestaAccesos {
  estricto: boolean;
  usuarios: UsuarioAcc[];
  secciones: SeccionAcc[];
  repositorios: RepoAcc[];
  errorRepositorios: string | null;
  repoPorDefecto: string;
  asignaciones: Record<string, { secciones: string[]; repos: string[] }>;
}
interface Borrador { secciones: Set<string>; todosRepos: boolean; repos: Set<string>; }

type Vista = 'usuario' | 'seccion';
type FiltroUsuarios = 'todos' | 'con-modulo' | 'sin-modulo';

// Panel del ADMIN_POD: qué secciones y qué repositorios ve cada usuario de AXIS en
// el módulo Repositorio. Igual que los accesos de n8n: se trabaja por usuario
// ("¿qué ve María?") o por sección ("¿quién ve Pipelines?"), los cambios se
// acumulan en un borrador y se guardan de una vez.
@Component({
  selector: 'app-azure-accesos',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule],
  templateUrl: './azure-accesos.component.html',
  styleUrl: './azure-accesos.component.scss',
})
export class AzureAccesosComponent implements OnInit {
  @Output() cerrar = new EventEmitter<boolean>(); // true si se guardó algo

  cargando = true;
  error: string | null = null;
  estricto = false;
  usuarios: UsuarioAcc[] = [];
  secciones: SeccionAcc[] = [];
  repositorios: RepoAcc[] = [];
  errorRepositorios: string | null = null;

  vista: Vista = 'usuario';
  usuarioSel: number | null = null;
  seccionSel: string | null = null;
  busquedaUsuarios = '';
  filtroUsuarios: FiltroUsuarios = 'todos';
  busquedaRepos = '';
  copiarDeId = '';

  guardando = false;
  mensaje: string | null = null;
  errorGuardar: string | null = null;

  usuariosVisibles: UsuarioAcc[] = [];
  reposVisibles: RepoAcc[] = [];
  sucios = new Set<number>();
  sinModuloTotal = 0;

  private borrador = new Map<number, Borrador>();
  private original = new Map<number, string>();
  private hechoAlgo = false;
  private readonly apiUrl = `${environment.apiUrl}/azure-repo`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.cargando = true;
    this.error = null;
    this.http.get<RespuestaAccesos>(`${this.apiUrl}/accesos`).subscribe({
      next: (r) => {
        this.estricto = r.estricto;
        this.usuarios = r.usuarios;
        this.secciones = r.secciones;
        this.errorRepositorios = r.errorRepositorios;
        // Repos asignados que ya no existen en Azure: se muestran igual para poder quitarlos.
        const conocidos = new Set(r.repositorios.map((x) => x.nombre));
        const huerfanos = new Set<string>();
        Object.values(r.asignaciones).forEach((a) => a.repos.forEach((n) => { if (n !== '*' && !conocidos.has(n)) huerfanos.add(n); }));
        this.repositorios = [...r.repositorios, ...[...huerfanos].sort().map((n) => ({ nombre: n, ramaPorDefecto: null, deshabilitado: false, huerfano: true }))];

        this.borrador.clear();
        this.original.clear();
        for (const u of r.usuarios) {
          const a = r.asignaciones[String(u.id)] || { secciones: [], repos: [] };
          const b: Borrador = { secciones: new Set(a.secciones), todosRepos: a.repos.includes('*'), repos: new Set(a.repos.filter((n) => n !== '*')) };
          this.borrador.set(u.id, b);
          this.original.set(u.id, this.firma(b));
        }
        if (this.usuarioSel === null || !this.usuarios.some((u) => u.id === this.usuarioSel)) this.usuarioSel = this.usuarios[0]?.id ?? null;
        if (this.seccionSel === null || !this.secciones.some((s) => s.id === this.seccionSel)) this.seccionSel = this.secciones[0]?.id ?? null;
        this.cargando = false;
        this.recalcular();
      },
      error: (err) => { this.error = err?.error?.error || 'No se pudieron cargar los accesos.'; this.cargando = false; },
    });
  }

  private firma(b: Borrador): string {
    return JSON.stringify({ s: [...b.secciones].sort(), t: b.todosRepos, r: b.todosRepos ? [] : [...b.repos].sort() });
  }

  // --- Lectura ---

  get usuario(): UsuarioAcc | null { return this.usuarios.find((u) => u.id === this.usuarioSel) || null; }
  get seccion(): SeccionAcc | null { return this.secciones.find((s) => s.id === this.seccionSel) || null; }
  get hayCambios(): boolean { return this.sucios.size > 0; }
  get hayRepos(): boolean { return this.repositorios.length > 0; }
  get seccionesPorRepo(): boolean { return this.secciones.some((s) => s.porRepo); }

  tiene(uid: number, seccionId: string): boolean { return this.borrador.get(uid)?.secciones.has(seccionId) ?? false; }
  cantSecciones(uid: number): number { return this.borrador.get(uid)?.secciones.size ?? 0; }
  todosRepos(uid: number): boolean { return this.borrador.get(uid)?.todosRepos ?? false; }
  tieneRepo(uid: number, nombre: string): boolean { return this.borrador.get(uid)?.repos.has(nombre) ?? false; }
  cantRepos(uid: number): number { return this.borrador.get(uid)?.repos.size ?? 0; }
  textoRepos(uid: number): string {
    const b = this.borrador.get(uid);
    if (!b) return '';
    if (b.todosRepos) return 'todos los repos';
    return b.repos.size ? `${b.repos.size} repo${b.repos.size === 1 ? '' : 's'}` : 'sin repos';
  }
  // Usuarios con acceso a una sección, considerando el borrador.
  conteoSeccion(seccionId: string): number {
    let n = 0;
    this.borrador.forEach((b) => { if (b.secciones.has(seccionId)) n++; });
    return n;
  }
  // Un usuario con secciones de código pero sin ningún repositorio no verá nada útil.
  sinRepos(uid: number): boolean {
    const b = this.borrador.get(uid);
    if (!b || b.todosRepos || b.repos.size) return false;
    return this.secciones.some((s) => s.porRepo && b.secciones.has(s.id));
  }

  recalcular(): void {
    const t = this.busquedaUsuarios.trim().toLowerCase();
    this.sinModuloTotal = this.usuarios.filter((u) => !u.tieneModulo).length;
    this.usuariosVisibles = this.usuarios.filter((u) => {
      if (this.filtroUsuarios === 'con-modulo' && !u.tieneModulo) return false;
      if (this.filtroUsuarios === 'sin-modulo' && u.tieneModulo) return false;
      return !t || u.nombre.toLowerCase().includes(t) || u.username.toLowerCase().includes(t);
    });
    const tr = this.busquedaRepos.trim().toLowerCase();
    this.reposVisibles = this.repositorios.filter((r) => !tr || r.nombre.toLowerCase().includes(tr));
    this.sucios = new Set<number>();
    this.borrador.forEach((b, uid) => { if (this.firma(b) !== this.original.get(uid)) this.sucios.add(uid); });
  }

  cambiarVista(v: Vista): void { this.vista = v; this.mensaje = null; this.recalcular(); }
  elegirUsuario(id: number): void { this.usuarioSel = id; this.mensaje = null; this.recalcular(); }
  elegirSeccion(id: string): void { this.seccionSel = id; this.mensaje = null; }

  // --- Edición (solo del borrador) ---

  alternarSeccion(uid: number, seccionId: string): void {
    const b = this.borrador.get(uid);
    if (!b) return;
    if (b.secciones.has(seccionId)) b.secciones.delete(seccionId); else b.secciones.add(seccionId);
    this.mensaje = null;
    this.recalcular();
  }

  marcarSecciones(uid: number, marcar: boolean): void {
    const b = this.borrador.get(uid);
    if (!b) return;
    b.secciones = marcar ? new Set(this.secciones.map((s) => s.id)) : new Set();
    this.mensaje = null;
    this.recalcular();
  }

  ponerTodosRepos(uid: number, todos: boolean): void {
    const b = this.borrador.get(uid);
    if (!b) return;
    b.todosRepos = todos;
    this.mensaje = null;
    this.recalcular();
  }

  alternarRepo(uid: number, nombre: string): void {
    const b = this.borrador.get(uid);
    if (!b) return;
    if (b.repos.has(nombre)) b.repos.delete(nombre); else b.repos.add(nombre);
    this.mensaje = null;
    this.recalcular();
  }

  marcarReposVisibles(uid: number, marcar: boolean): void {
    const b = this.borrador.get(uid);
    if (!b) return;
    for (const r of this.reposVisibles) { if (marcar) b.repos.add(r.nombre); else b.repos.delete(r.nombre); }
    this.mensaje = null;
    this.recalcular();
  }

  // Reemplaza los accesos del usuario por los de otro (útil para crear perfiles iguales).
  copiarDesde(): void {
    const otro = parseInt(this.copiarDeId, 10);
    const origen = this.borrador.get(otro);
    const destino = this.usuarioSel !== null ? this.borrador.get(this.usuarioSel) : undefined;
    if (!origen || !destino || this.usuarioSel === null) return;
    destino.secciones = new Set(origen.secciones);
    destino.todosRepos = origen.todosRepos;
    destino.repos = new Set(origen.repos);
    this.copiarDeId = '';
    this.mensaje = null;
    this.recalcular();
  }

  darSeccionATodos(seccionId: string, dar: boolean): void {
    this.borrador.forEach((b) => { if (dar) b.secciones.add(seccionId); else b.secciones.delete(seccionId); });
    this.mensaje = null;
    this.recalcular();
  }

  descartar(): void {
    this.cargar();
    this.mensaje = null;
    this.errorGuardar = null;
  }

  // --- Guardar: una petición por usuario modificado ---

  guardar(): void {
    if (!this.hayCambios || this.guardando) return;
    this.guardando = true;
    this.errorGuardar = null;
    this.mensaje = null;
    const pendientes = [...this.sucios];
    let guardados = 0;
    const siguiente = (): void => {
      const uid = pendientes.shift();
      if (uid === undefined) {
        this.guardando = false;
        this.mensaje = `Cambios guardados (${guardados} usuario${guardados === 1 ? '' : 's'}). Se aplican en la siguiente consulta del usuario.`;
        this.hechoAlgo = true;
        this.cargar();
        return;
      }
      const b = this.borrador.get(uid)!;
      const usuario = this.usuarios.find((u) => u.id === uid);
      const cuerpo = { secciones: [...b.secciones], repos: b.todosRepos ? ['*'] : [...b.repos] };
      this.http.put(`${this.apiUrl}/accesos/usuarios/${uid}`, cuerpo).subscribe({
        next: () => { guardados++; this.original.set(uid, this.firma(b)); siguiente(); },
        error: (err) => {
          this.guardando = false;
          this.errorGuardar = `No se pudo guardar a ${usuario?.nombre || uid}: ${err?.error?.error || 'error inesperado'}. ${guardados ? `Ya se guardaron ${guardados} usuario(s).` : ''}`;
          if (guardados) this.hechoAlgo = true;
          this.recalcular();
        },
      });
    };
    siguiente();
  }

  intentarCerrar(): void {
    if (this.hayCambios && !confirm('Hay cambios sin guardar. ¿Cerrar y descartarlos?')) return;
    this.cerrar.emit(this.hechoAlgo);
  }

  trackUsuario(_i: number, u: UsuarioAcc): number { return u.id; }
  trackSeccion(_i: number, s: SeccionAcc): string { return s.id; }
  trackRepo(_i: number, r: RepoAcc): string { return r.nombre; }
}
