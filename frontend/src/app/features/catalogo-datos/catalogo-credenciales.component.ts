import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CatalogoDatosService, CredencialesCatalogo, Motor } from '../../core/services/catalogo-datos.service';

interface FormCredencial { usuario: string; clave: string; }

// «Mis credenciales» del Catálogo de datos. Cada persona escribe SU usuario y SU clave (una por motor);
// el servidor las guarda solo en memoria, ligadas a su sesión, y con ellas arma SU catálogo y SU mapa estelar.
// La clave nunca vuelve al navegador (solo se muestra el usuario y los 2 últimos caracteres).
@Component({
  selector: 'app-catalogo-credenciales',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './catalogo-credenciales.component.html',
  styleUrl: './catalogo-credenciales.component.scss',
})
export class CatalogoCredencialesComponent implements OnInit {
  @Input() credenciales: CredencialesCatalogo | null = null;
  /** true si se guardó o quitó algo (hay que releer el catálogo). */
  @Output() cerrar = new EventEmitter<boolean>();

  readonly motores: Motor[] = ['MSSQL', 'MARIADB'];
  actuales: CredencialesCatalogo = this.vacias();
  horas = 8;
  cargando = false;
  hubo = false;

  form: Record<Motor, FormCredencial> = { MSSQL: { usuario: '', clave: '' }, MARIADB: { usuario: '', clave: '' } };
  trabajando: Record<Motor, boolean> = { MSSQL: false, MARIADB: false };
  errores: Record<Motor, string> = { MSSQL: '', MARIADB: '' };
  avisos: Record<Motor, string> = { MSSQL: '', MARIADB: '' };
  confirmaQuitar: Motor | null = null;

  constructor(private servicio: CatalogoDatosService) {}

  ngOnInit(): void {
    if (this.credenciales) this.aplicar(this.credenciales);
    this.cargando = true;
    this.servicio.credenciales().subscribe({
      next: (r) => { this.horas = r.horas; this.aplicar(r.credenciales); this.cargando = false; },
      error: () => { this.cargando = false; },
    });
  }

  private vacias(): CredencialesCatalogo {
    const v = { configurada: false, usuario: null, claveFin: null, expira: null };
    return { MSSQL: { ...v }, MARIADB: { ...v } };
  }

  private aplicar(c: CredencialesCatalogo): void {
    this.actuales = c;
    for (const m of this.motores) {
      if (c[m].configurada && !this.form[m].usuario) this.form[m].usuario = c[m].usuario || '';
    }
  }

  etiqueta(m: Motor): string { return m === 'MSSQL' ? 'SQL Server' : 'MariaDB / MySQL'; }
  ejemploUsuario(m: Motor): string { return m === 'MSSQL' ? 'FINANDINA\\tu.usuario  ó  login_sql' : 'tu_usuario'; }

  puedeGuardar(m: Motor): boolean {
    const f = this.form[m];
    return !this.trabajando[m] && !!f.usuario.trim() && (!!f.clave || this.actuales[m].configurada);
  }

  expiraTxt(m: Motor): string {
    const e = this.actuales[m].expira;
    return e ? new Date(e).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '';
  }

  guardar(m: Motor): void {
    if (!this.puedeGuardar(m)) return;
    this.trabajando[m] = true;
    this.errores[m] = '';
    this.avisos[m] = '';
    this.servicio.guardarCredenciales(m, { usuario: this.form[m].usuario.trim(), clave: this.form[m].clave }).subscribe({
      next: (r) => {
        this.trabajando[m] = false;
        this.form[m].clave = '';
        this.actuales = r.credenciales;
        this.hubo = true;
        this.avisos[m] = 'Listo. Estoy leyendo los servidores con tus credenciales; el catálogo se irá llenando solo.';
      },
      error: (e) => { this.trabajando[m] = false; this.errores[m] = e?.error?.error || 'No se pudieron guardar tus credenciales.'; },
    });
  }

  quitar(m: Motor): void {
    if (this.confirmaQuitar !== m) { this.confirmaQuitar = m; return; }   // primer clic = pedir confirmación
    this.confirmaQuitar = null;
    this.trabajando[m] = true;
    this.errores[m] = '';
    this.servicio.quitarCredenciales(m).subscribe({
      next: (r) => {
        this.trabajando[m] = false;
        this.actuales = r.credenciales;
        this.form[m] = { usuario: '', clave: '' };
        this.hubo = true;
        this.avisos[m] = 'Quitadas. Lo que habías leído con esas credenciales salió de tu catálogo.';
      },
      error: (e) => { this.trabajando[m] = false; this.errores[m] = e?.error?.error || 'No se pudieron quitar.'; },
    });
  }

  cerrarModal(): void {
    if (this.motores.some((m) => this.trabajando[m])) return;
    for (const m of this.motores) this.form[m].clave = '';
    this.cerrar.emit(this.hubo);
  }
}
