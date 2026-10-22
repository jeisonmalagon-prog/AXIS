import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SwaggerComparticion, SwaggerOrigen, SwaggerOrigenForm, SwaggerPruebaOrigen, SwaggerService, SwaggerUsuarioLite } from '../../core/services/swagger.service';

// Modal de administración de los orígenes (Swagger registrados). Solo se abre
// para quien tiene permiso de edición del módulo; el backend lo valida igual.
// Cada origen es privado de quien lo registró: aquí su dueño lo comparte (con todos o con usuarios concretos).
// Los que le compartieron otros se listan aparte, sin acciones de modificar.
@Component({
  selector: 'app-swagger-origenes',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './swagger-origenes.component.html',
  styleUrl: './swagger-origenes.component.scss',
})
export class SwaggerOrigenesComponent implements OnInit {
  // Origen que se estaba usando: al cerrar se le avisa al padre si cambió algo.
  @Input() origenActualId: number | null = null;
  @Input() abrirNuevo = false;
  /** ADMIN_POD con «ver todos»: la lista incluye los privados de los demás. */
  @Input() verTodos = false;
  @Output() cerrar = new EventEmitter<boolean>();

  origenes: SwaggerOrigen[] = [];
  cargando = true;
  error = '';
  huboCambios = false;

  // Formulario (alta o edición)
  editandoId: number | null = null;
  mostrarForm = false;
  form: SwaggerOrigenForm = this.vacio();
  guardando = false;
  errorForm = '';

  probando = false;
  prueba: SwaggerPruebaOrigen | null = null;

  // Compartir
  compartiendo: SwaggerOrigen | null = null;
  cargandoComp = false;
  guardandoComp = false;
  errorComp = '';
  avisoOk = '';
  compTodos = false;
  seleccion = new Set<number>();
  busqueda = '';
  listaComp: (SwaggerUsuarioLite & { sinAcceso?: boolean })[] = [];

  constructor(private swagger: SwaggerService) {}

  ngOnInit(): void {
    this.cargar();
    if (this.abrirNuevo) this.nuevo();
  }

  private vacio(): SwaggerOrigenForm {
    return { Nombre: '', UrlSwagger: '', ValidarTls: false, Notas: '' };
  }

  cargar(): void {
    this.cargando = true;
    this.swagger.origenes(this.verTodos).subscribe({
      next: (o) => { this.origenes = o; this.cargando = false; },
      error: (e) => { this.error = e?.error?.error || 'No se pudieron cargar los orígenes.'; this.cargando = false; },
    });
  }

  nuevo(): void {
    this.editandoId = null;
    this.form = this.vacio();
    this.prueba = null;
    this.errorForm = '';
    this.mostrarForm = true;
  }

  editar(o: SwaggerOrigen): void {
    this.editandoId = o.Id;
    this.form = { Nombre: o.Nombre, UrlSwagger: o.UrlSwagger, ValidarTls: o.ValidarTls, Notas: o.Notas || '' };
    this.prueba = null;
    this.errorForm = '';
    this.mostrarForm = true;
  }

  cancelarForm(): void {
    this.mostrarForm = false;
    this.editandoId = null;
  }

  probar(): void {
    if (!this.form.UrlSwagger.trim() || this.probando) return;
    this.probando = true;
    this.prueba = null;
    this.swagger.probarOrigen({ UrlSwagger: this.form.UrlSwagger.trim(), ValidarTls: this.form.ValidarTls }).subscribe({
      next: (r) => { this.prueba = r; this.probando = false; },
      error: (e) => {
        this.prueba = { ok: false, error: e?.error?.error || 'No se pudo probar la conexión.' };
        this.probando = false;
      },
    });
  }

  guardar(): void {
    if (this.guardando) return;
    this.errorForm = '';
    this.guardando = true;
    const datos: SwaggerOrigenForm = {
      Nombre: this.form.Nombre.trim(),
      UrlSwagger: this.form.UrlSwagger.trim(),
      ValidarTls: this.form.ValidarTls,
      Notas: this.form.Notas.trim(),
    };
    const accion = this.editandoId ? this.swagger.actualizarOrigen(this.editandoId, datos) : this.swagger.crearOrigen(datos);
    accion.subscribe({
      next: () => {
        this.guardando = false;
        this.huboCambios = true;
        this.mostrarForm = false;
        this.editandoId = null;
        this.cargar();
      },
      error: (e) => {
        this.guardando = false;
        this.errorForm = e?.error?.error || 'No se pudo guardar el origen.';
      },
    });
  }

  darDeBaja(o: SwaggerOrigen): void {
    if (!confirm(`¿Dar de baja el origen "${o.Nombre}"? Sus consumos guardados se conservan en la base, pero dejarán de verse.`)) return;
    this.swagger.eliminarOrigen(o.Id).subscribe({
      next: () => { this.huboCambios = true; this.cargar(); },
      error: (e) => { this.error = e?.error?.error || 'No se pudo dar de baja el origen.'; },
    });
  }

  get misOrigenes(): SwaggerOrigen[] { return this.origenes.filter((o) => o.Propio); }
  get origenesAjenos(): SwaggerOrigen[] { return this.origenes.filter((o) => !o.Propio); }

  textoCompartido(o: SwaggerOrigen): string {
    if (o.CompartidoTodos) return 'Compartido con todos';
    if (o.CompartidoCon) return `Compartido con ${o.CompartidoCon} usuario(s)`;
    return 'Privado';
  }

  // ---------------------------------------------------------------- compartir
  abrirCompartir(o: SwaggerOrigen): void {
    this.compartiendo = o;
    this.cargandoComp = true;
    this.errorComp = '';
    this.avisoOk = '';
    this.busqueda = '';
    this.listaComp = [];
    this.seleccion = new Set<number>();
    this.compTodos = o.CompartidoTodos;
    this.swagger.comparticion(o.Id).subscribe({
      next: (c) => { this.aplicarComparticion(c); this.cargandoComp = false; },
      error: (e) => { this.errorComp = e?.error?.error || 'No se pudo leer con quién se comparte.'; this.cargandoComp = false; },
    });
  }

  private aplicarComparticion(c: SwaggerComparticion): void {
    this.compTodos = c.compartidoTodos;
    this.seleccion = new Set(c.usuarios.map((u) => u.Id));
    const ids = new Set(c.candidatos.map((u) => u.Id));
    // Quien ya tenía acceso pero hoy no puede usar el módulo (o está inactivo) se muestra marcado, para poder quitarlo.
    const extra = c.usuarios.filter((u) => !ids.has(u.Id)).map((u) => ({ ...u, sinAcceso: true }));
    this.listaComp = [...c.candidatos, ...extra];
  }

  get listaFiltrada(): (SwaggerUsuarioLite & { sinAcceso?: boolean })[] {
    const q = this.busqueda.trim().toLowerCase();
    if (!q) return this.listaComp;
    return this.listaComp.filter((u) => `${u.Nombre || ''} ${u.Username || ''}`.toLowerCase().includes(q));
  }

  nombreUsuario(u: SwaggerUsuarioLite): string {
    return u.Nombre || u.Username || `Usuario #${u.Id}`;
  }

  marcado(id: number): boolean { return this.seleccion.has(id); }

  alternarUsuario(id: number): void {
    const s = new Set(this.seleccion);
    if (s.has(id)) s.delete(id); else s.add(id);
    this.seleccion = s;
  }

  marcarVisibles(marcar: boolean): void {
    const s = new Set(this.seleccion);
    for (const u of this.listaFiltrada) { if (marcar) s.add(u.Id); else s.delete(u.Id); }
    this.seleccion = s;
  }

  cancelarCompartir(): void {
    this.compartiendo = null;
  }

  guardarComparticion(): void {
    if (!this.compartiendo || this.guardandoComp) return;
    const o = this.compartiendo;
    this.guardandoComp = true;
    this.errorComp = '';
    this.swagger.guardarComparticion(o.Id, { compartidoTodos: this.compTodos, usuarios: [...this.seleccion] }).subscribe({
      next: () => {
        this.guardandoComp = false;
        this.huboCambios = true;
        this.compartiendo = null;
        this.avisoOk = this.compTodos
          ? `«${o.Nombre}» ahora lo ven todos los usuarios con el módulo Swagger.`
          : (this.seleccion.size ? `«${o.Nombre}» quedó compartido con ${this.seleccion.size} usuario(s).` : `«${o.Nombre}» quedó privado: solo tú lo ves.`);
        this.cargar();
      },
      error: (e) => { this.guardandoComp = false; this.errorComp = e?.error?.error || 'No se pudo guardar con quién se comparte.'; },
    });
  }

  cerrarModal(): void {
    this.cerrar.emit(this.huboCambios);
  }
}
