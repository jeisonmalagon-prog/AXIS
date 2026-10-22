import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { validarPasswordSegura, REQUISITOS_PASSWORD_TEXTO } from '../shared/password-policy.util';

export type RolModulo = 'CONSULTA' | 'ADMIN_MIN';

interface OpcionesUsuarios {
  modulos: string[];
  roles: RolModulo[];
  rolPorModuloDisponible: boolean;
  aviso: string | null;
  // ¿Ya se puede decidir quién ajusta su tiempo de sesión? (columnas
  // usuarios.sesion_personalizable / sesion_minutos; ver
  // agregar_sesion_personalizada_usuarios.sql)
  sesionPersonalizableDisponible?: boolean;
  avisoSesion?: string | null;
}

export interface UsuarioAdmin {
  id?: number;
  username: string;
  password?: string; // Opcional al editar
  nombre_completo: string;
  // Contacto para recuperar la contraseña con código (correo corporativo y celular). '' = sin dato.
  correo?: string | null;
  rol: string;
  activo: boolean;
  modulos: string[]; // Lista de nombres de módulos
  // Rol del usuario en cada módulo habilitado: 'CONSULTA' (solo ve) o
  // 'ADMIN_MIN' (crea, edita y borra en ese módulo).
  modulosRoles?: Record<string, RolModulo>;
  // true si la cuenta tiene pendiente el cambio obligatorio de contraseña
  // (recién creada, o el admin le reseteó la contraseña y aún no la cambió).
  debe_cambiar_password?: boolean;
  // 'LOCAL' (usuario/contraseña propios de AXIS) o 'AD' (se autentica contra
  // Active Directory -- la contraseña la valida el directorio, no AXIS).
  tipo_autenticacion?: 'LOCAL' | 'AD';
  // true si el usuario puede ajustar en Mi perfil el tiempo de inactividad de
  // su sesión; sesion_minutos es el que eligió (null = el de por defecto).
  sesion_personalizable?: boolean;
  sesion_minutos?: number | null;
}

@Component({
  selector: 'app-usuarios',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './usuarios.component.html',
  styleUrls: ['./usuarios.component.scss']
})
export class UsuariosComponent implements OnInit {
  usuarios: UsuarioAdmin[] = [];
  loading = true;
  terminoBusqueda = '';

  // Texto de ayuda bajo el campo de contraseña del modal (ver
  // shared/password-policy.util.ts -- mismas reglas que valida el backend).
  readonly requisitosPassword = REQUISITOS_PASSWORD_TEXTO;

  // ¿Ya se pueden guardar roles por módulo? Lo informa el backend (necesita la
  // columna usuario_modulos.rol_modulo; ver agregar_rol_por_modulo.sql). Si no,
  // la pantalla funciona como antes, con un único rol para todos los módulos.
  rolPorModuloDisponible = false;
  opcionesCargadas = false;
  avisoRolPorModulo: string | null = null;

  // ¿Ya se puede guardar el permiso "ajustar tiempo de sesión"? Si no, el
  // checkbox no se ofrece y se muestra el aviso con el script a ejecutar.
  sesionPersonalizableDisponible = false;
  avisoSesion: string | null = null;

  // Módulos que hoy no tienen nada que editar (solo se consultan): su rol es
  // siempre Consulta y no se ofrece elegir.
  readonly modulosSoloLectura = ['APP_MOVIL', 'REPOSITORIO'];

  // Lista de módulos disponibles en el sistema
  modulosDisponibles = ['CERTIFICADOS', 'SERVIDORES', 'APP_MOVIL', 'SERVICIOS', 'ORQUESTADOR_N8N', 'REPOSITORIO', 'BALANCEADOR_F5', 'TAREAS', 'CALENDARIO', 'PASOS_PRODUCCION', 'SWAGGER', 'BIOMETRIA', 'CATALOGO_DATOS', 'MANUALES', 'SOPORTE_N1', 'INFORMES'];

  // Variables para el Modal
  mostrarModal = false;
  modoEdicion = false;
  usuarioActual: UsuarioAdmin = this.crearUsuarioVacio();

  private endpoint = `${environment.apiUrl}/usuarios`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.cargarOpciones();
    this.cargarUsuarios();
  }

  cargarOpciones(): void {
    this.http.get<OpcionesUsuarios>(`${this.endpoint}/opciones`).subscribe({
      next: (o) => {
        this.rolPorModuloDisponible = !!o.rolPorModuloDisponible;
        this.avisoRolPorModulo = o.aviso || null;
        this.sesionPersonalizableDisponible = !!o.sesionPersonalizableDisponible;
        this.avisoSesion = o.avisoSesion || null;
        this.opcionesCargadas = true;
      },
      error: () => {
        // Backend sin este endpoint (versión anterior) o sin respuesta: se
        // sigue como antes, sin roles por módulo.
        this.rolPorModuloDisponible = false;
        this.avisoRolPorModulo = null;
        this.sesionPersonalizableDisponible = false;
        this.avisoSesion = null;
        this.opcionesCargadas = true;
      }
    });
  }

  esModuloSoloLectura(modulo: string): boolean {
    return this.modulosSoloLectura.includes(modulo);
  }

  // Rol por defecto al habilitar un módulo: Consulta (lo más restrictivo), salvo
  // Tareas, donde hasta ahora todo usuario creaba sus propios pendientes.
  rolPorDefectoModulo(modulo: string): RolModulo {
    return modulo === 'TAREAS' ? 'ADMIN_MIN' : 'CONSULTA';
  }

  // Rol efectivo de un usuario en un módulo, para mostrarlo en la tabla.
  rolDeModulo(u: UsuarioAdmin, modulo: string): RolModulo {
    if (this.esModuloSoloLectura(modulo)) return 'CONSULTA';
    return u.modulosRoles?.[modulo] === 'ADMIN_MIN' ? 'ADMIN_MIN' : 'CONSULTA';
  }

  etiquetaRolModulo(rol: RolModulo): string {
    return rol === 'ADMIN_MIN' ? 'Admin' : 'Consulta';
  }

  cambiarRolModulo(modulo: string, rol: string): void {
    if (!this.usuarioActual.modulosRoles) this.usuarioActual.modulosRoles = {};
    this.usuarioActual.modulosRoles[modulo] = rol === 'ADMIN_MIN' ? 'ADMIN_MIN' : 'CONSULTA';
  }

  cargarUsuarios(): void {
    this.loading = true;
    this.http.get<UsuarioAdmin[]>(this.endpoint).subscribe({
      next: (data) => {
        this.usuarios = data;
        this.loading = false;
      },
      error: (err) => {
        console.error('Error cargando usuarios:', err);
        this.loading = false;
      }
    });
  }

  get usuariosFiltrados(): UsuarioAdmin[] {
    if (!this.terminoBusqueda) return this.usuarios;
    const term = this.terminoBusqueda.toLowerCase().trim();
    return this.usuarios.filter(u => 
      u.username.toLowerCase().includes(term) || 
      u.nombre_completo.toLowerCase().includes(term) ||
      u.rol.toLowerCase().includes(term)
    );
  }

  crearUsuarioVacio(): UsuarioAdmin {
    return {
      username: '',
      password: '',
      nombre_completo: '',
      correo: '',
      rol: 'BASIC',
      activo: true,
      modulos: [],
      modulosRoles: {},
      tipo_autenticacion: 'LOCAL',
      sesion_personalizable: false
    };
  }

  // Atajo para la plantilla -- evita repetir la comparación de string en
  // cada *ngIf del formulario.
  get esAutenticacionAD(): boolean {
    return this.usuarioActual.tipo_autenticacion === 'AD';
  }

  abrirModalNuevo(): void {
    this.modoEdicion = false;
    this.usuarioActual = this.crearUsuarioVacio();
    this.mostrarModal = true;
  }

  abrirModalEditar(usuario: UsuarioAdmin): void {
    this.modoEdicion = true;
    // Hacemos una copia para no afectar la tabla hasta guardar
    this.usuarioActual = { ...usuario, password: '', modulosRoles: { ...(usuario.modulosRoles || {}) } };
    // Asegurarnos de que el array de módulos exista
    if (!this.usuarioActual.modulos) {
      this.usuarioActual.modulos = [];
    }
    // Con roles por módulo ya no hay "ADMIN_MIN" / "BASIC" globales: todo el que
    // no es ADMIN_POD es un "usuario" cuyo rol se define módulo a módulo.
    if (this.rolPorModuloDisponible && this.usuarioActual.rol !== 'ADMIN_POD') {
      this.usuarioActual.rol = 'BASIC';
    }
    // Cada módulo habilitado debe tener un rol elegido.
    this.usuarioActual.modulos.forEach((m) => {
      if (!this.usuarioActual.modulosRoles![m]) this.usuarioActual.modulosRoles![m] = this.rolPorDefectoModulo(m);
    });
    // Usuarios creados antes de esta funcionalidad no traen el campo -- se
    // asume LOCAL (es lo que el backend también asume por defecto).
    if (!this.usuarioActual.tipo_autenticacion) {
      this.usuarioActual.tipo_autenticacion = 'LOCAL';
    }
    this.mostrarModal = true;
  }

  cerrarModal(): void {
    this.mostrarModal = false;
  }

  // Manejo de checkboxes de módulos
  toggleModulo(modulo: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (!this.usuarioActual.modulosRoles) this.usuarioActual.modulosRoles = {};
    if (checked) {
      this.usuarioActual.modulos.push(modulo);
      this.usuarioActual.modulosRoles[modulo] = this.esModuloSoloLectura(modulo)
        ? 'CONSULTA'
        : (this.usuarioActual.modulosRoles[modulo] || this.rolPorDefectoModulo(modulo));
    } else {
      this.usuarioActual.modulos = this.usuarioActual.modulos.filter(m => m !== modulo);
      delete this.usuarioActual.modulosRoles[modulo];
    }
  }

  guardarUsuario(): void {
    if (!this.usuarioActual.username || !this.usuarioActual.nombre_completo) {
      alert('El usuario y el nombre completo son obligatorios.');
      return;
    }

    // Una cuenta de Active Directory nunca tiene contraseña local -- la
    // exigencia de contraseña (obligatoria al crear) solo aplica a LOCAL.
    if (!this.modoEdicion && !this.esAutenticacionAD && !this.usuarioActual.password) {
      alert('La contraseña es obligatoria para usuarios nuevos.');
      return;
    }

    // Se valida solo cuando efectivamente se está fijando una contraseña
    // (obligatorio al crear; opcional -- reseteo -- al editar) y el tipo es
    // LOCAL (una cuenta AD no tiene contraseña que AXIS pueda validar).
    // Mismas reglas que el backend (ver shared/password-policy.util.ts);
    // esto solo adelanta el feedback, el backend vuelve a validar igual.
    if (!this.esAutenticacionAD && this.usuarioActual.password) {
      const errores = validarPasswordSegura(this.usuarioActual.password, {
        username: this.usuarioActual.username,
        nombreCompleto: this.usuarioActual.nombre_completo,
      });
      if (errores.length) {
        alert(`La contraseña no cumple los requisitos de seguridad:\n- ${errores.join('\n- ')}`);
        return;
      }
    }

    const datos = this.datosParaGuardar();

    if (this.modoEdicion) {
      this.http.put(`${this.endpoint}/${this.usuarioActual.id}`, datos).subscribe({
        next: () => {
          this.cargarUsuarios();
          this.cerrarModal();
        },
        error: (err) => alert(err.error?.error || 'Error al actualizar el usuario.')
      });
    } else {
      this.http.post(this.endpoint, datos).subscribe({
        next: () => {
          this.cargarUsuarios();
          this.cerrarModal();
        },
        error: (err) => alert(err.error?.error || 'Error al crear el usuario.')
      });
    }
  }

  // Lo que se envía al backend. Los roles por módulo solo se mandan si ya se
  // pueden guardar (columna creada) y el usuario no es ADMIN_POD (ese tiene todo).
  private datosParaGuardar(): UsuarioAdmin {
    const datos: UsuarioAdmin = { ...this.usuarioActual };
    // '' borra el dato; el backend valida formato, dominio corporativo y que el correo no se repita.
    datos.correo = (datos.correo || '').trim();
    // El permiso de ajustar la sesión solo se envía si ya se puede guardar (así,
    // sin la columna, editar un usuario sigue funcionando igual que antes).
    if (this.sesionPersonalizableDisponible) {
      datos.sesion_personalizable = !!this.usuarioActual.sesion_personalizable;
    } else {
      delete datos.sesion_personalizable;
    }
    delete datos.sesion_minutos;
    if (this.rolPorModuloDisponible && datos.rol !== 'ADMIN_POD') {
      const roles: Record<string, RolModulo> = {};
      datos.modulos.forEach((m) => {
        roles[m] = this.esModuloSoloLectura(m) ? 'CONSULTA' : (this.usuarioActual.modulosRoles?.[m] || this.rolPorDefectoModulo(m));
      });
      datos.modulosRoles = roles;
    } else {
      delete datos.modulosRoles;
    }
    return datos;
  }

  toggleEstado(usuario: UsuarioAdmin): void {
    const nuevoEstado = !usuario.activo;
    const accion = nuevoEstado ? 'activar' : 'desactivar';
    
    if (confirm(`¿Estás seguro de que deseas ${accion} a ${usuario.username}?`)) {
      this.http.patch(`${this.endpoint}/${usuario.id}/estado`, { activo: nuevoEstado }).subscribe({
        next: () => this.cargarUsuarios(),
        error: () => alert('Error al cambiar el estado del usuario.')
      });
    }
  }
}