import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { environment } from '../../environments/environment';
import { mensajeHttp } from './n8n-utils';

// Cuenta tal como la ve el ADMIN_POD al administrar las API keys. La key nunca
// llega al navegador: solo sus últimos 4 caracteres.
interface CuentaN8nAdmin {
  id: string;
  nombre: string;
  activo: boolean;
  apiKeyFin?: string | null;
  legible?: boolean;
  creadoPor?: string | null;
  fechaCreacion?: string;
}

// Modal de API keys de n8n (solo ADMIN_POD): cada key da acceso a los flujos de
// su dueño en n8n.
@Component({
  selector: 'app-n8n-cuentas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './n8n-cuentas.component.html',
  styleUrl: './n8n-cuentas.component.scss',
})
export class N8nCuentasComponent implements OnInit {
  @Output() cerrar = new EventEmitter<void>();

  cuentasCargando = false;
  cuentasTablaLista = true;
  cuentasAdmin: CuentaN8nAdmin[] = [];
  cuentaNueva = { nombre: '', apiKey: '' };
  cuentaEditandoId: string | null = null;
  cuentaEdicion = { nombre: '', apiKey: '' };
  cuentasGuardando = false;
  cuentasError: string | null = null;
  cuentasMensaje: string | null = null;
  pruebasCuenta: Record<string, { cargando: boolean; ok?: boolean; texto?: string }> = {};

  private apiUrl = `${environment.apiUrl}/n8n`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.cargarCuentasAdmin(); }

  cargarCuentasAdmin(): void {
    this.cuentasCargando = true;
    this.http.get<{ tabla: boolean; cuentas: CuentaN8nAdmin[] }>(`${this.apiUrl}/cuentas`).subscribe({
      next: (r) => { this.cuentasTablaLista = r.tabla; this.cuentasAdmin = r.cuentas; this.cuentasCargando = false; },
      error: (err) => { this.cuentasError = mensajeHttp(err, 'No se pudieron cargar las API keys.'); this.cuentasCargando = false; },
    });
  }

  agregarCuenta(): void {
    this.cuentasError = null;
    this.cuentasMensaje = null;
    const nombre = this.cuentaNueva.nombre.trim();
    const apiKey = this.cuentaNueva.apiKey.trim();
    if (!nombre || !apiKey) { this.cuentasError = 'Escribe el nombre del propietario y pega su API key.'; return; }

    this.cuentasGuardando = true;
    this.http.post(`${this.apiUrl}/cuentas`, { nombre, apiKey }).subscribe({
      next: () => {
        this.cuentasGuardando = false;
        this.cuentaNueva = { nombre: '', apiKey: '' };
        this.cuentasMensaje = `Cuenta "${nombre}" agregada. Sus flujos ya aparecen en el módulo (asígnalos en "Accesos" si el control de acceso está activo).`;
        this.cargarCuentasAdmin();
      },
      error: (err) => { this.cuentasGuardando = false; this.cuentasError = mensajeHttp(err, 'No se pudo guardar la API key.'); },
    });
  }

  editarCuenta(c: CuentaN8nAdmin): void {
    this.cuentaEditandoId = c.id;
    this.cuentaEdicion = { nombre: c.nombre, apiKey: '' };
    this.cuentasError = null;
    this.cuentasMensaje = null;
  }

  cancelarEdicion(): void { this.cuentaEditandoId = null; }

  guardarEdicion(c: CuentaN8nAdmin): void {
    this.cuentasError = null;
    this.cuentasMensaje = null;
    const cuerpo: { nombre: string; apiKey?: string } = { nombre: this.cuentaEdicion.nombre.trim() };
    if (this.cuentaEdicion.apiKey.trim()) cuerpo.apiKey = this.cuentaEdicion.apiKey.trim();
    this.cuentasGuardando = true;
    this.http.put(`${this.apiUrl}/cuentas/${c.id}`, cuerpo).subscribe({
      next: () => { this.cuentasGuardando = false; this.cuentaEditandoId = null; this.cuentasMensaje = 'Cuenta actualizada.'; this.cargarCuentasAdmin(); },
      error: (err) => { this.cuentasGuardando = false; this.cuentasError = mensajeHttp(err, 'No se pudo actualizar la cuenta.'); },
    });
  }

  alternarCuenta(c: CuentaN8nAdmin): void {
    this.cuentasError = null;
    this.cuentasMensaje = null;
    this.http.put(`${this.apiUrl}/cuentas/${c.id}`, { activo: !c.activo }).subscribe({
      next: () => this.cargarCuentasAdmin(),
      error: (err) => { this.cuentasError = mensajeHttp(err, 'No se pudo cambiar el estado de la cuenta.'); },
    });
  }

  quitarCuenta(c: CuentaN8nAdmin): void {
    if (!confirm(`¿Quitar la API key de "${c.nombre}"? Sus flujos dejarán de verse en AXIS (en n8n no cambia nada).`)) return;
    this.cuentasError = null;
    this.cuentasMensaje = null;
    this.http.delete(`${this.apiUrl}/cuentas/${c.id}`).subscribe({
      next: () => { this.cuentasMensaje = `Cuenta "${c.nombre}" quitada.`; this.cargarCuentasAdmin(); },
      error: (err) => { this.cuentasError = mensajeHttp(err, 'No se pudo quitar la cuenta.'); },
    });
  }

  probarCuenta(c: CuentaN8nAdmin): void {
    this.pruebasCuenta[c.id] = { cargando: true };
    this.http.post<{ ok: boolean; error?: string; totalFlujos?: number }>(`${this.apiUrl}/cuentas/${c.id}/probar`, {}).subscribe({
      next: (r) => {
        this.pruebasCuenta[c.id] = r.ok
          ? { cargando: false, ok: true, texto: `Conexión correcta: ${r.totalFlujos} flujos visibles.` }
          : { cargando: false, ok: false, texto: r.error || 'No se pudo conectar.' };
      },
      error: (err) => { this.pruebasCuenta[c.id] = { cargando: false, ok: false, texto: mensajeHttp(err, 'No se pudo probar la cuenta.') }; },
    });
  }

  trackCuenta(_i: number, c: { id: string }): string { return c.id; }
}
