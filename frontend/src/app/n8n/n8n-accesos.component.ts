import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { environment } from '../../environments/environment';
import { mensajeHttp } from './n8n-utils';

interface UsuarioAsignable { id: number; username: string; nombre: string; rol: string; tieneModulo: boolean; }
interface FlujoAcceso { id: string; nombre: string; activo: boolean; cuentaId: string; cuentaNombre: string; etiquetas: string[]; }
interface GrupoFlujos { cuentaId: string; nombre: string; flujos: FlujoAcceso[]; marcados: number; }

interface RespuestaAccesos {
  estricto: boolean;
  usuarios: UsuarioAsignable[];
  flujos: FlujoAcceso[];
  asignaciones: Record<string, string[]>;
  conteo: Record<string, number>;
  cuentasConError: { id: string; nombre: string; error: string }[];
}

type Vista = 'usuario' | 'flujo';
type FiltroUsuarios = 'todos' | 'con-modulo' | 'sin-modulo';
type FiltroFlujos = 'todos' | 'marcados' | 'sin-marcar' | 'sin-asignar';

// Panel del ADMIN_POD: qué flujos de n8n ve cada usuario de AXIS. Se puede
// trabajar por usuario ("¿qué ve María?") o por flujo ("¿quién ve este flujo?").
// Los cambios se acumulan en un borrador y se guardan de una vez.
@Component({
  selector: 'app-n8n-accesos',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './n8n-accesos.component.html',
  styleUrl: './n8n-accesos.component.scss',
})
export class N8nAccesosComponent implements OnInit {
  @Output() cerrar = new EventEmitter<boolean>(); // true si se guardó algo

  cargando = true;
  error: string | null = null;
  estricto = false;
  usuarios: UsuarioAsignable[] = [];
  flujos: FlujoAcceso[] = [];
  cuentasConError: { id: string; nombre: string; error: string }[] = [];
  cuentas: { id: string; nombre: string }[] = [];

  vista: Vista = 'usuario';
  usuarioSel: number | null = null;
  flujoSel: string | null = null;

  busquedaUsuarios = '';
  filtroUsuarios: FiltroUsuarios = 'todos';
  sinModuloTotal = 0;
  busquedaFlujos = '';
  filtroFlujos: FiltroFlujos = 'todos';
  filtroCuenta = 'todas';
  copiarDeId = '';

  guardando = false;
  mensaje: string | null = null;
  errorGuardar: string | null = null;

  // Listas ya filtradas (se recalculan en recalcular(): no son getters para no
  // generar objetos nuevos en cada ciclo de detección de cambios).
  usuariosVisibles: UsuarioAsignable[] = [];
  flujosVisibles: FlujoAcceso[] = [];
  grupos: GrupoFlujos[] = [];
  sucios = new Set<number>();
  sinAsignarTotal = 0;

  private borrador = new Map<number, Set<string>>();
  private original = new Map<number, Set<string>>();
  private conteoServidor: Record<string, number> = {};
  private apiUrl = `${environment.apiUrl}/n8n`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.cargando = true;
    this.error = null;
    this.http.get<RespuestaAccesos>(`${this.apiUrl}/accesos`).subscribe({
      next: (r) => {
        this.estricto = r.estricto;
        this.usuarios = r.usuarios;
        this.flujos = r.flujos;
        this.cuentasConError = r.cuentasConError || [];
        this.conteoServidor = r.conteo || {};
        this.cuentas = [...new Map(r.flujos.map((f) => [f.cuentaId, { id: f.cuentaId, nombre: f.cuentaNombre }])).values()];
        this.borrador.clear();
        this.original.clear();
        for (const u of r.usuarios) {
          const ids = r.asignaciones[String(u.id)] || [];
          this.borrador.set(u.id, new Set(ids));
          this.original.set(u.id, new Set(ids));
        }
        if (this.usuarioSel === null || !this.usuarios.some((u) => u.id === this.usuarioSel)) this.usuarioSel = this.usuarios[0]?.id ?? null;
        if (this.flujoSel === null || !this.flujos.some((f) => f.id === this.flujoSel)) this.flujoSel = this.flujos[0]?.id ?? null;
        this.cargando = false;
        this.recalcular();
      },
      error: (err) => { this.error = mensajeHttp(err, 'No se pudieron cargar los accesos.'); this.cargando = false; },
    });
  }

  // --- Lectura del borrador ---

  tiene(usuarioId: number, flujoId: string): boolean { return this.borrador.get(usuarioId)?.has(flujoId) ?? false; }
  cantidadDe(usuarioId: number): number {
    const s = this.borrador.get(usuarioId);
    if (!s) return 0;
    const conocidos = new Set(this.flujos.map((f) => f.id));
    let n = 0;
    s.forEach((id) => { if (conocidos.has(id)) n++; });
    return n;
  }

  // Usuarios con acceso a un flujo, considerando el borrador.
  conteoDe(flujoId: string): number {
    let n = this.conteoServidor[flujoId] || 0;
    this.borrador.forEach((set, uid) => {
      const antes = this.original.get(uid)?.has(flujoId) ?? false;
      const ahora = set.has(flujoId);
      if (ahora && !antes) n++;
      if (!ahora && antes) n--;
    });
    return Math.max(0, n);
  }

  get usuario(): UsuarioAsignable | null { return this.usuarios.find((u) => u.id === this.usuarioSel) || null; }
  get flujo(): FlujoAcceso | null { return this.flujos.find((f) => f.id === this.flujoSel) || null; }
  get hayCambios(): boolean { return this.sucios.size > 0; }

  // --- Filtros ---

  recalcular(): void {
    const tu = this.busquedaUsuarios.trim().toLowerCase();
    this.sinModuloTotal = this.usuarios.filter((u) => !u.tieneModulo).length;
    this.usuariosVisibles = this.usuarios.filter((u) => {
      if (this.filtroUsuarios === 'con-modulo' && !u.tieneModulo) return false;
      if (this.filtroUsuarios === 'sin-modulo' && u.tieneModulo) return false;
      return !tu || u.nombre.toLowerCase().includes(tu) || u.username.toLowerCase().includes(tu);
    });

    const tf = this.busquedaFlujos.trim().toLowerCase();
    this.flujosVisibles = this.flujos.filter((f) => {
      if (this.filtroCuenta !== 'todas' && f.cuentaId !== this.filtroCuenta) return false;
      if (tf && !f.nombre.toLowerCase().includes(tf) && !f.id.toLowerCase().includes(tf) && !f.etiquetas.some((t) => t.toLowerCase().includes(tf))) return false;
      switch (this.filtroFlujos) {
        case 'marcados': return this.vista === 'usuario' && this.usuarioSel !== null ? this.tiene(this.usuarioSel, f.id) : this.conteoDe(f.id) > 0;
        case 'sin-marcar': return this.vista === 'usuario' && this.usuarioSel !== null ? !this.tiene(this.usuarioSel, f.id) : this.conteoDe(f.id) === 0;
        case 'sin-asignar': return this.conteoDe(f.id) === 0;
        default: return true;
      }
    });

    const porCuenta = new Map<string, GrupoFlujos>();
    for (const f of this.flujosVisibles) {
      if (!porCuenta.has(f.cuentaId)) porCuenta.set(f.cuentaId, { cuentaId: f.cuentaId, nombre: f.cuentaNombre, flujos: [], marcados: 0 });
      const g = porCuenta.get(f.cuentaId)!;
      g.flujos.push(f);
      if (this.usuarioSel !== null && this.tiene(this.usuarioSel, f.id)) g.marcados++;
    }
    this.grupos = [...porCuenta.values()];

    this.sucios = new Set<number>();
    this.borrador.forEach((set, uid) => { if (!this.iguales(set, this.original.get(uid))) this.sucios.add(uid); });
    this.sinAsignarTotal = this.flujos.filter((f) => this.conteoDe(f.id) === 0).length;
  }

  private iguales(a: Set<string>, b?: Set<string>): boolean {
    if (!b || a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  cambiarVista(v: Vista): void { this.vista = v; this.filtroFlujos = 'todos'; this.busquedaFlujos = ''; this.recalcular(); }
  elegirUsuario(id: number): void { this.usuarioSel = id; this.mensaje = null; this.recalcular(); }
  elegirFlujo(id: string): void { this.flujoSel = id; this.mensaje = null; }

  // --- Edición (solo del borrador) ---

  alternar(usuarioId: number, flujoId: string): void {
    const s = this.borrador.get(usuarioId);
    if (!s) return;
    if (s.has(flujoId)) s.delete(flujoId); else s.add(flujoId);
    this.mensaje = null;
    this.recalcular();
  }

  marcarVisibles(marcar: boolean): void {
    if (this.usuarioSel === null) return;
    const s = this.borrador.get(this.usuarioSel);
    if (!s) return;
    for (const f of this.flujosVisibles) { if (marcar) s.add(f.id); else s.delete(f.id); }
    this.mensaje = null;
    this.recalcular();
  }

  marcarGrupo(g: GrupoFlujos, marcar: boolean): void {
    if (this.usuarioSel === null) return;
    const s = this.borrador.get(this.usuarioSel);
    if (!s) return;
    for (const f of g.flujos) { if (marcar) s.add(f.id); else s.delete(f.id); }
    this.recalcular();
  }

  // Suma los flujos que ya tiene otro usuario (no quita los que ya tenía).
  copiarDesde(): void {
    const otro = parseInt(this.copiarDeId, 10);
    if (this.usuarioSel === null || !Number.isFinite(otro)) return;
    const origen = this.borrador.get(otro);
    const destino = this.borrador.get(this.usuarioSel);
    if (!origen || !destino) return;
    origen.forEach((id) => destino.add(id));
    this.copiarDeId = '';
    this.mensaje = null;
    this.recalcular();
  }

  darAccesoATodos(flujoId: string, dar: boolean): void {
    this.borrador.forEach((s) => { if (dar) s.add(flujoId); else s.delete(flujoId); });
    this.mensaje = null;
    this.recalcular();
  }

  descartar(): void {
    this.original.forEach((set, uid) => this.borrador.set(uid, new Set(set)));
    this.mensaje = null;
    this.errorGuardar = null;
    this.recalcular();
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
        this.mensaje = `Cambios guardados (${guardados} usuario${guardados === 1 ? '' : 's'}).`;
        this.hechoAlgo = true;
        this.cargar();
        return;
      }
      const usuario = this.usuarios.find((u) => u.id === uid);
      this.http.put(`${this.apiUrl}/accesos/usuarios/${uid}`, { flujos: [...(this.borrador.get(uid) || [])] }).subscribe({
        next: () => {
          guardados++;
          this.original.set(uid, new Set(this.borrador.get(uid)));
          siguiente();
        },
        error: (err) => {
          this.guardando = false;
          this.errorGuardar = `No se pudo guardar a ${usuario?.nombre || uid}: ${mensajeHttp(err, 'error inesperado')}. ${guardados ? `Ya se guardaron ${guardados} usuario(s).` : ''}`;
          if (guardados) this.hechoAlgo = true;
          this.recalcular();
        },
      });
    };
    siguiente();
  }

  private hechoAlgo = false;

  intentarCerrar(): void {
    if (this.hayCambios && !confirm('Hay cambios sin guardar. ¿Cerrar y descartarlos?')) return;
    this.cerrar.emit(this.hechoAlgo);
  }

  trackUsuario(_i: number, u: UsuarioAsignable): number { return u.id; }
  trackFlujo(_i: number, f: { id: string }): string { return f.id; }
  trackGrupo(_i: number, g: GrupoFlujos): string { return g.cuentaId; }
}
