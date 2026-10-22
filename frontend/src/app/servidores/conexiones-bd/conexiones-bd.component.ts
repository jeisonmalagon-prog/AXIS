import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../services/auth.service';

export interface ConexionBd {
  id: number;
  aplicativo_id: number;
  servidor_bd_id: number;
  motor_bd: string;
  nombre_base_datos: string;
  esquema: string | null;
  puerto: number | null;
  usuario_servicio: string | null;
  fecha_registro: string;
  servidor_bd_hostname: string;
  servidor_bd_ip: string;
}

export interface AplicativoConConexiones {
  id: number;
  servidor_id: number;
  nombre_aplicacion: string;
  criticidad?: string;
  plataforma?: string;
  conexionesBd: ConexionBd[];
}

export interface ServidorResumen {
  id: number;
  hostname: string;
  ip: string;
  aplicativos: AplicativoConConexiones[];
}

export interface ServidorOpcion {
  id: number;
  hostname: string;
  ip: string;
}

@Component({
  selector: 'app-conexiones-bd',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './conexiones-bd.component.html',
  styleUrl: './conexiones-bd.component.scss'
})
export class ConexionesBdComponent implements OnInit {
  servidores: ServidorResumen[] = [];
  loading = true;
  terminoBusqueda = '';
  puedeEditar = false;

  motoresDisponibles = ['MySQL', 'SQL Server', 'Oracle', 'PostgreSQL', 'MongoDB', 'Otro'];

  // Modal: agregar / editar una conexión BD
  mostrarModal = false;
  modoEdicion = false;
  aplicativoActual: AplicativoConConexiones | null = null;
  // Servidor que aloja el sub-aplicativo en edición (solo para mostrarlo en
  // el subtítulo del modal — deja clarísimo a qué sub-aplicativo, y de qué
  // servidor, pertenece la conexión que se está creando/editando).
  servidorActualHostname: string | null = null;
  conexionActual: {
    id?: number;
    servidor_bd_id: number | null;
    motor_bd: string;
    nombre_base_datos: string;
    esquema: string;
    puerto: number | null;
    usuario_servicio: string;
  } = this.crearConexionVacia();

  private endpoint = `${environment.apiUrl}/servidoresInventario`;

  constructor(private http: HttpClient, private authService: AuthService) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('SERVIDORES');
    this.cargarResumen();
  }

  cargarResumen(): void {
    this.loading = true;
    this.http.get<ServidorResumen[]>(`${this.endpoint}/conexiones-bd/resumen`).subscribe({
      next: (data) => {
        this.servidores = data;
        this.loading = false;
      },
      error: (err: any) => {
        console.error('Error cargando conexiones BD:', err);
        this.loading = false;
      }
    });
  }

  // Todos los servidores del inventario, para elegir cuál aloja la BD
  get servidoresParaSeleccionar(): ServidorOpcion[] {
    return this.servidores.map((s) => ({ id: s.id, hostname: s.hostname, ip: s.ip }));
  }

  // Solo servidores con al menos un aplicativo — son los que pueden tener
  // sub-aplicativos con conexiones BD que mostrar aquí.
  get gruposFiltrados(): ServidorResumen[] {
    const conAplicativos = this.servidores.filter((s) => s.aplicativos.length > 0);
    if (!this.terminoBusqueda) return conAplicativos;

    const termino = this.terminoBusqueda.toLowerCase().trim();
    return conAplicativos
      .map((s) => ({
        ...s,
        aplicativos: s.aplicativos.filter((a) =>
          a.nombre_aplicacion.toLowerCase().includes(termino) ||
          s.hostname.toLowerCase().includes(termino) ||
          a.conexionesBd.some((c) =>
            c.motor_bd.toLowerCase().includes(termino) ||
            c.nombre_base_datos.toLowerCase().includes(termino) ||
            c.servidor_bd_hostname.toLowerCase().includes(termino)
          )
        )
      }))
      .filter((s) => s.aplicativos.length > 0);
  }

  crearConexionVacia() {
    return { servidor_bd_id: null, motor_bd: 'MySQL', nombre_base_datos: '', esquema: '', puerto: null, usuario_servicio: '' };
  }

  abrirAgregarConexion(app: AplicativoConConexiones, hostname: string): void {
    this.aplicativoActual = app;
    this.servidorActualHostname = hostname;
    this.modoEdicion = false;
    this.conexionActual = this.crearConexionVacia();
    this.mostrarModal = true;
  }

  abrirEditarConexion(app: AplicativoConConexiones, conexion: ConexionBd, hostname: string): void {
    this.aplicativoActual = app;
    this.servidorActualHostname = hostname;
    this.modoEdicion = true;
    this.conexionActual = {
      id: conexion.id,
      servidor_bd_id: conexion.servidor_bd_id,
      motor_bd: conexion.motor_bd,
      nombre_base_datos: conexion.nombre_base_datos,
      esquema: conexion.esquema || '',
      puerto: conexion.puerto,
      usuario_servicio: conexion.usuario_servicio || ''
    };
    this.mostrarModal = true;
  }

  cerrarModal(): void {
    this.mostrarModal = false;
    this.aplicativoActual = null;
    this.servidorActualHostname = null;
  }

  guardarConexion(): void {
    if (!this.aplicativoActual) return;
    if (!this.conexionActual.servidor_bd_id || !this.conexionActual.motor_bd || !this.conexionActual.nombre_base_datos) {
      alert('El servidor de BD, el motor y el nombre de la base de datos son obligatorios.');
      return;
    }

    const payload = {
      servidor_bd_id: this.conexionActual.servidor_bd_id,
      motor_bd: this.conexionActual.motor_bd,
      nombre_base_datos: this.conexionActual.nombre_base_datos,
      esquema: this.conexionActual.esquema || null,
      puerto: this.conexionActual.puerto || null,
      usuario_servicio: this.conexionActual.usuario_servicio || null
    };

    if (this.modoEdicion && this.conexionActual.id) {
      this.http.put(`${this.endpoint}/conexiones-bd/${this.conexionActual.id}`, payload).subscribe({
        next: () => {
          this.cargarResumen();
          this.cerrarModal();
        },
        error: (err: any) => {
          const detalle = err.error?.error || 'Error desconocido';
          alert(`❌ Error al actualizar la conexión:\n${detalle}`);
        }
      });
    } else {
      this.http.post(`${this.endpoint}/aplicativos/${this.aplicativoActual.id}/conexiones-bd`, payload).subscribe({
        next: () => {
          this.cargarResumen();
          this.cerrarModal();
        },
        error: (err: any) => {
          const detalle = err.error?.error || 'Error desconocido';
          alert(`❌ Error al registrar la conexión:\n${detalle}`);
        }
      });
    }
  }

  eliminarConexion(conexionId: number): void {
    if (!confirm('¿Quitar esta conexión a base de datos?')) return;
    this.http.delete(`${this.endpoint}/conexiones-bd/${conexionId}`).subscribe({
      next: () => this.cargarResumen(),
      error: (err: any) => console.error('Error eliminando conexión BD:', err)
    });
  }
}
