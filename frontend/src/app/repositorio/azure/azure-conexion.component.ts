import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IcoComponent } from '../../shared/ico/ico.component';
import { AjustesAzure, AzureConexionService, ConexionAzure, ResultadoPrueba, TokenAzure } from './azure-conexion.service';

// Panel del ADMIN_POD: tokens de acceso (PAT) de Azure DevOps y datos de la conexión.
// Varios tokens se complementan: para cada sección el servidor usa el que tiene permiso.
@Component({
  selector: 'app-azure-conexion',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule],
  templateUrl: './azure-conexion.component.html',
  styleUrl: './azure-conexion.component.scss',
})
export class AzureConexionComponent implements OnInit {
  @Output() cerrar = new EventEmitter<boolean>(); // true si se cambió algo

  cargando = true;
  error: string | null = null;
  datos: ConexionAzure | null = null;
  huboCambios = false;

  // Alta
  nuevoNombre = '';
  nuevoToken = '';
  verNuevo = false;
  agregando = false;
  errorAlta: string | null = null;

  // Edición en línea
  editandoId: number | null = null;
  editNombre = '';
  reemplazandoId: number | null = null;
  reemplazoToken = '';
  confirmarEliminarId: number | null = null;
  trabajandoId: number | 'env' | null = null;
  errorFila: { id: number | 'env'; texto: string } | null = null;

  // Resultado de pruebas recién hechas (se muestran abiertos)
  pruebas: Record<string, ResultadoPrueba> = {};
  abiertos = new Set<string>();

  // Ajustes
  aj: AjustesAzure = { org: '', project: '', repo: '', branch: '' };
  guardandoAj = false;
  mensajeAj: string | null = null;
  errorAj: string | null = null;

  constructor(private api: AzureConexionService) {}

  ngOnInit(): void {
    this.api.obtener().subscribe({
      next: (d) => { this.aplicar(d); this.cargando = false; },
      error: (e) => { this.error = e?.error?.error || 'No se pudo leer la configuración de Azure DevOps.'; this.cargando = false; },
    });
  }

  private aplicar(d: ConexionAzure): void {
    this.datos = d;
    this.aj = { ...d.ajustes };
  }

  get tokens(): TokenAzure[] { return this.datos?.tokens ?? []; }
  get puedeEscribir(): boolean { return !!this.datos && this.datos.cifradoListo; }

  intentarCerrar(): void { this.cerrar.emit(this.huboCambios); }

  /** Texto del estado de un token: qué tan completo es lo que puede leer. */
  resumenPrueba(r: ResultadoPrueba | null): string {
    if (!r) return 'Sin probar';
    return `Lee ${r.ok} de ${r.total} secciones`;
  }
  claseResumen(r: ResultadoPrueba | null): string {
    if (!r) return 'nulo';
    if (r.ok === 0) return 'mal';
    return r.ok === r.total ? 'ok' : 'aviso';
  }
  resultadoDe(t: TokenAzure): ResultadoPrueba | null { return this.pruebas[String(t.id)] ?? t.resultado; }
  alternarDetalle(clave: string): void { if (this.abiertos.has(clave)) this.abiertos.delete(clave); else this.abiertos.add(clave); }

  fecha(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  }

  private fallo(e: any, porDefecto: string): string { return e?.error?.error || porDefecto; }

  // --- Alta ---
  agregar(): void {
    if (this.agregando || !this.nuevoNombre.trim() || !this.nuevoToken.trim()) return;
    this.agregando = true; this.errorAlta = null;
    this.api.agregar(this.nuevoNombre.trim(), this.nuevoToken.trim()).subscribe({
      next: (d) => {
        this.nuevoNombre = ''; this.nuevoToken = ''; this.verNuevo = false; this.agregando = false; this.huboCambios = true;
        this.aplicar(d);
        if (d.idNuevo && d.prueba) { this.pruebas[String(d.idNuevo)] = d.prueba; this.abiertos.add(String(d.idNuevo)); }
      },
      error: (e) => { this.errorAlta = this.fallo(e, 'No se pudo guardar el token.'); this.agregando = false; },
    });
  }

  // --- Acciones por token ---
  probar(id: number | 'env'): void {
    this.trabajandoId = id; this.errorFila = null;
    this.api.probar(id).subscribe({
      next: (d) => {
        this.trabajandoId = null;
        this.pruebas[String(id)] = d.prueba; this.abiertos.add(String(id));
        if (id !== 'env') { this.aplicar({ ...d }); }
      },
      error: (e) => { this.trabajandoId = null; this.errorFila = { id, texto: this.fallo(e, 'No se pudo probar el token.') }; },
    });
  }

  empezarRenombrar(t: TokenAzure): void { this.editandoId = t.id; this.editNombre = t.nombre; this.errorFila = null; }
  guardarNombre(t: TokenAzure): void {
    if (!this.editNombre.trim() || this.editNombre.trim() === t.nombre) { this.editandoId = null; return; }
    this.cambiar(t.id, { nombre: this.editNombre.trim() }, () => { this.editandoId = null; });
  }

  alternarActivo(t: TokenAzure): void { this.cambiar(t.id, { activo: !t.activo }); }

  empezarReemplazo(t: TokenAzure): void { this.reemplazandoId = t.id; this.reemplazoToken = ''; this.errorFila = null; }
  guardarReemplazo(t: TokenAzure): void {
    if (!this.reemplazoToken.trim()) return;
    this.cambiar(t.id, { token: this.reemplazoToken.trim() }, () => { this.reemplazandoId = null; this.reemplazoToken = ''; });
  }

  private cambiar(id: number, cambios: { nombre?: string; activo?: boolean; token?: string }, fin?: () => void): void {
    this.trabajandoId = id; this.errorFila = null;
    this.api.actualizar(id, cambios).subscribe({
      next: (d) => {
        this.trabajandoId = null; this.huboCambios = true; this.aplicar(d);
        if (d.prueba) { this.pruebas[String(id)] = d.prueba; this.abiertos.add(String(id)); }
        else if (cambios.token) delete this.pruebas[String(id)];
        fin?.();
      },
      error: (e) => { this.trabajandoId = null; this.errorFila = { id, texto: this.fallo(e, 'No se pudo guardar el cambio.') }; },
    });
  }

  mover(t: TokenAzure, delta: -1 | 1): void {
    const ids = this.tokens.map((x) => x.id);
    const i = ids.indexOf(t.id); const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.trabajandoId = t.id; this.errorFila = null;
    this.api.ordenar(ids).subscribe({
      next: (d) => { this.trabajandoId = null; this.huboCambios = true; this.aplicar(d); },
      error: (e) => { this.trabajandoId = null; this.errorFila = { id: t.id, texto: this.fallo(e, 'No se pudo cambiar el orden.') }; },
    });
  }

  eliminar(t: TokenAzure): void {
    this.trabajandoId = t.id; this.errorFila = null;
    this.api.eliminar(t.id).subscribe({
      next: (d) => { this.trabajandoId = null; this.confirmarEliminarId = null; this.huboCambios = true; this.aplicar(d); delete this.pruebas[String(t.id)]; },
      error: (e) => { this.trabajandoId = null; this.errorFila = { id: t.id, texto: this.fallo(e, 'No se pudo eliminar el token.') }; },
    });
  }

  // --- Ajustes ---
  get ajustesCambiaron(): boolean {
    const a = this.datos?.ajustes; if (!a) return false;
    return a.org !== this.aj.org.trim() || a.project !== this.aj.project.trim() || a.repo !== this.aj.repo.trim() || a.branch !== this.aj.branch.trim();
  }
  guardarAjustes(): void {
    if (this.guardandoAj || !this.ajustesCambiaron) return;
    this.guardandoAj = true; this.errorAj = null; this.mensajeAj = null;
    this.api.guardarAjustes({ org: this.aj.org.trim(), project: this.aj.project.trim(), repo: this.aj.repo.trim(), branch: this.aj.branch.trim() }).subscribe({
      next: (d) => { this.guardandoAj = false; this.huboCambios = true; this.aplicar(d); this.mensajeAj = 'Ajustes guardados.'; },
      error: (e) => { this.guardandoAj = false; this.errorAj = this.fallo(e, 'No se pudieron guardar los ajustes.'); },
    });
  }
  restablecerAjustes(): void { this.aj = { org: '', project: '', repo: '', branch: '' }; this.mensajeAj = null; }

  trackId = (_: number, t: TokenAzure): number => t.id;
}
