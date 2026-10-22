import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuditoriaService } from '../../core/services/auditoria.service';
import {
  AccionAuditoriaGeneral,
  AccionAuditoriaUsuario,
  EventoAuditoriaGeneral,
  EventoAuditoriaUsuario,
  ModuloAuditoriaGeneral,
  UsuarioBasico,
} from '../../core/models/models';

const ETIQUETAS_ACCION: Record<AccionAuditoriaUsuario, string> = {
  LOGIN_EXITOSO: 'Login exitoso',
  LOGIN_FALLIDO: 'Login fallido',
  CAMBIO_PASSWORD: 'Cambio de contraseña',
  EDICION_PERFIL: 'Edición de perfil propio',
  CAMBIO_SESION: 'Cambio de tiempo de sesión',
  CREACION: 'Creación de usuario',
  EDICION: 'Edición de usuario',
  ACTIVACION: 'Activación de cuenta',
  DESACTIVACION: 'Desactivación de cuenta',
  RECUPERACION_SOLICITADA: 'Recuperación: código solicitado',
  RECUPERACION_ENVIO_FALLIDO: 'Recuperación: envío fallido',
  RECUPERACION_VERIFICADA: 'Recuperación: código verificado',
  RECUPERACION_FALLIDA: 'Recuperación: código incorrecto',
  RECUPERACION_BLOQUEADA: 'Recuperación: bloqueada',
  RECUPERACION_EXITOSA: 'Recuperación: contraseña restablecida',
};

// Auditoría GENERAL (CRUD y operaciones de cualquier módulo) — ver
// backend/utils/auditoriaGeneral.js para el detalle de qué genera cada una.
const ETIQUETAS_MODULO: Record<ModuloAuditoriaGeneral, string> = {
  CERTIFICADOS: 'Certificados',
  SERVIDORES: 'Servidores',
  APP_MOVIL: 'App móvil',
  SERVICIOS: 'Servicios / ACE',
  ORQUESTADOR_N8N: 'Orquestador n8n',
  REPOSITORIO: 'Repositorio',
  BALANCEADOR_F5: 'Balanceador F5',
  SWAGGER: 'Swagger',
  BIOMETRIA: 'Biometría de firmas',
  CATALOGO_DATOS: 'Catálogo de datos',
  MANUALES: 'Manuales',
  SOPORTE_N1: 'Soporte Nivel 1',
  INFORMES: 'Informes',
  INICIO: 'Pantalla de inicio',
};

const ETIQUETAS_ACCION_GENERAL: Record<AccionAuditoriaGeneral, string> = {
  CREACION: 'Creación',
  EDICION: 'Edición',
  ELIMINACION: 'Eliminación',
  ELIMINACION_LOGICA: 'Movido a Eliminados',
  RESTAURACION: 'Restauración',
  ACCION_CONTENEDOR: 'Acción sobre contenedor',
  HABILITACION: 'Habilitación',
  DESHABILITACION: 'Deshabilitación',
  EJECUCION: 'Ejecución',
  CONSUMO: 'Prueba de servicio',
  CONSUMO_BLOQUEADO: 'Prueba bloqueada (límite)',
  CERTIFICADO_AGREGADO: 'Certificado cargado',
  CERTIFICADO_ELIMINADO: 'Certificado eliminado',
  PETICION_GUARDADA: 'Petición guardada',
  PETICION_ACTUALIZADA: 'Petición actualizada',
  PETICION_ELIMINADA: 'Petición eliminada',
};

@Component({
  selector: 'app-usuarios-auditoria',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './usuarios-auditoria.component.html',
  styleUrls: ['./usuarios-auditoria.component.scss'],
})
export class UsuariosAuditoriaComponent implements OnInit {
  // 'usuarios' = pantalla original (logins, cambios de contraseña, cuentas);
  // 'general' = CRUD y operaciones de cualquier otro módulo (Certificados,
  // Servidores, Servicios, F5, n8n, etc. — ver auditoriaGeneral.js).
  vista: 'usuarios' | 'general' = 'usuarios';

  periodo: 'dia' | 'semana' | 'mes' | 'rango' = 'semana';
  desde = '';
  hasta = '';

  // --- Filtros de la vista "Usuarios y Accesos" ---
  usuarioIdFiltro: number | null = null;
  accionFiltro: AccionAuditoriaUsuario | null = null;

  usuarios: UsuarioBasico[] = [];
  eventos: EventoAuditoriaUsuario[] = [];
  limitado = false;

  // --- Filtros y datos de la vista "General" ---
  moduloFiltro: ModuloAuditoriaGeneral | null = null;
  accionGeneralFiltro: AccionAuditoriaGeneral | null = null;
  usuarioGeneralFiltro: string | null = null;
  /** Solo los eventos hechos con rol Consulta (se auditan con más detalle). */
  soloConsulta = false;

  usuariosGeneral: string[] = [];
  eventosGeneral: EventoAuditoriaGeneral[] = [];
  limitadoGeneral = false;

  // Búsqueda de texto libre (cliente, sobre lo ya cargado) -- un solo campo
  // para ambas vistas, cada una busca en sus propias columnas de texto.
  terminoBusqueda = '';

  cargando = true;
  error = '';

  readonly acciones = Object.keys(ETIQUETAS_ACCION) as AccionAuditoriaUsuario[];
  readonly modulos = Object.keys(ETIQUETAS_MODULO) as ModuloAuditoriaGeneral[];
  readonly accionesGeneral = Object.keys(ETIQUETAS_ACCION_GENERAL) as AccionAuditoriaGeneral[];

  constructor(private auditoriaService: AuditoriaService) {}

  ngOnInit(): void {
    this.cargar();
  }

  seleccionarVista(v: 'usuarios' | 'general'): void {
    if (this.vista === v) return;
    this.vista = v;
    this.cargar();
  }

  seleccionarPeriodo(p: 'dia' | 'semana' | 'mes' | 'rango'): void {
    this.periodo = p;
    if (p !== 'rango') this.cargar();
  }

  cargar(): void {
    if (this.vista === 'usuarios') {
      this.cargarUsuarios();
    } else {
      this.cargarGeneral();
    }
  }

  private cargarUsuarios(): void {
    this.cargando = true;
    this.error = '';
    this.auditoriaService.obtenerAuditoria({
      periodo: this.periodo,
      desde: this.periodo === 'rango' ? this.desde : undefined,
      hasta: this.periodo === 'rango' ? this.hasta : undefined,
      usuarioId: this.usuarioIdFiltro,
      accion: this.accionFiltro,
    }).subscribe({
      next: (res) => {
        this.eventos = res.eventos;
        this.usuarios = res.usuarios;
        this.limitado = res.limitado;
        this.cargando = false;
      },
      error: (err) => {
        this.error = err.error?.error || 'No se pudo cargar el histórico de auditoría.';
        this.cargando = false;
      },
    });
  }

  private cargarGeneral(): void {
    this.cargando = true;
    this.error = '';
    this.auditoriaService.obtenerAuditoriaGeneral({
      periodo: this.periodo,
      desde: this.periodo === 'rango' ? this.desde : undefined,
      hasta: this.periodo === 'rango' ? this.hasta : undefined,
      modulo: this.moduloFiltro,
      accion: this.accionGeneralFiltro,
      usuario: this.usuarioGeneralFiltro,
      rol: this.soloConsulta ? 'consulta' : null,
    }).subscribe({
      next: (res) => {
        this.eventosGeneral = res.eventos;
        this.usuariosGeneral = res.usuarios;
        this.limitadoGeneral = res.limitado;
        this.cargando = false;
      },
      error: (err) => {
        this.error = err.error?.error || 'No se pudo cargar el histórico de auditoría general.';
        this.cargando = false;
      },
    });
  }

  // ---------- Búsqueda de texto libre (cliente) ----------
  eventosFiltrados(): EventoAuditoriaUsuario[] {
    const termino = this.terminoBusqueda.trim().toLowerCase();
    if (!termino) return this.eventos;
    return this.eventos.filter((e) =>
      (e.UsuarioNombreActual || '').toLowerCase().includes(termino) ||
      (e.UsernameIntentado || '').toLowerCase().includes(termino) ||
      (e.RealizadoPorUsername || '').toLowerCase().includes(termino) ||
      (e.IP || '').toLowerCase().includes(termino) ||
      this.resumenCambio(e).toLowerCase().includes(termino)
    );
  }

  eventosGeneralFiltrados(): EventoAuditoriaGeneral[] {
    const termino = this.terminoBusqueda.trim().toLowerCase();
    if (!termino) return this.eventosGeneral;
    return this.eventosGeneral.filter((e) =>
      (e.Entidad || '').toLowerCase().includes(termino) ||
      (e.EntidadNombre || '').toLowerCase().includes(termino) ||
      (e.RealizadoPorUsername || '').toLowerCase().includes(termino) ||
      (e.IP || '').toLowerCase().includes(termino) ||
      this.resumenCambioGeneral(e).toLowerCase().includes(termino)
    );
  }

  etiquetaAccion(accion: AccionAuditoriaUsuario): string {
    return ETIQUETAS_ACCION[accion] || accion;
  }

  claseAccion(accion: AccionAuditoriaUsuario): string {
    if (accion === 'LOGIN_FALLIDO' || accion === 'DESACTIVACION' || accion === 'RECUPERACION_FALLIDA' || accion === 'RECUPERACION_BLOQUEADA' || accion === 'RECUPERACION_ENVIO_FALLIDO') return 'accion-danger';
    if (accion === 'LOGIN_EXITOSO' || accion === 'ACTIVACION' || accion === 'CREACION' || accion === 'RECUPERACION_EXITOSA') return 'accion-ok';
    return 'accion-neutro';
  }

  // Arma un resumen legible del "qué cambió" para no tener que mostrar 8
  // columnas Anterior/Nuevo vacías la mayoría de las veces.
  resumenCambio(e: EventoAuditoriaUsuario): string {
    const partes: string[] = [];
    if (e.NombreCompletoAnterior !== null || e.NombreCompletoNuevo !== null) {
      partes.push(`Nombre: "${e.NombreCompletoAnterior ?? '—'}" → "${e.NombreCompletoNuevo ?? '—'}"`);
    }
    if (e.RolAnterior !== null || e.RolNuevo !== null) {
      partes.push(`Rol: ${e.RolAnterior ?? '—'} → ${e.RolNuevo ?? '—'}`);
    }
    if (e.ModulosAnterior !== null || e.ModulosNuevo !== null) {
      partes.push(`Módulos: [${e.ModulosAnterior ?? '—'}] → [${e.ModulosNuevo ?? '—'}]`);
    }
    if (e.ActivoAnterior !== null || e.ActivoNuevo !== null) {
      partes.push(`Activo: ${e.ActivoAnterior ?? '—'} → ${e.ActivoNuevo ?? '—'}`);
    }
    if (e.PasswordCambiada) {
      partes.push('Contraseña cambiada');
    }
    return partes.length ? partes.join(' · ') : (e.Detalle || '—');
  }

  etiquetaModulo(modulo: ModuloAuditoriaGeneral | string): string {
    return ETIQUETAS_MODULO[modulo as ModuloAuditoriaGeneral] || modulo;
  }

  etiquetaAccionGeneral(accion: AccionAuditoriaGeneral): string {
    return ETIQUETAS_ACCION_GENERAL[accion] || accion;
  }

  claseAccionGeneral(accion: AccionAuditoriaGeneral): string {
    if (accion === 'ELIMINACION' || accion === 'ELIMINACION_LOGICA' || accion === 'DESHABILITACION' || accion === 'CERTIFICADO_ELIMINADO' || accion === 'PETICION_ELIMINADA' || accion === 'CONSUMO_BLOQUEADO') return 'accion-danger';
    if (accion === 'CREACION' || accion === 'RESTAURACION' || accion === 'HABILITACION' || accion === 'CERTIFICADO_AGREGADO' || accion === 'PETICION_GUARDADA') return 'accion-ok';
    return 'accion-neutro';
  }

  // Mismo criterio que resumenCambio() de arriba, pero a partir del arreglo
  // genérico [{campo, etiqueta, anterior, nuevo}] que arma diffCampos() en
  // el backend — cada entidad tiene campos distintos, así que no se puede
  // usar una lista fija de columnas como en Usuarios.
  /** El evento lo hizo un usuario con rol Consulta (el backend lo marca con el cambio `rolModulo`). */
  esConsulta(e: EventoAuditoriaGeneral): boolean {
    return !!e.cambios && e.cambios.some((c) => c.campo === 'rolModulo');
  }

  resumenCambioGeneral(e: EventoAuditoriaGeneral): string {
    if (this.esConsulta(e)) {
      // Eventos de Consulta: una línea por dato (URL, resultado, cuerpo…), sin repetir la marca de rol.
      const lineas = e.cambios.filter((c) => c.campo !== 'rolModulo').map((c) => `${c.etiqueta}: ${c.nuevo ?? '—'}`);
      return [e.Detalle || '', ...lineas].filter(Boolean).join('\n');
    }
    if (e.cambios && e.cambios.length) {
      return e.cambios
        .map((c) => `${c.etiqueta}: "${c.anterior ?? '—'}" → "${c.nuevo ?? '—'}"`)
        .join(' · ');
    }
    return e.Detalle || '—';
  }
}
