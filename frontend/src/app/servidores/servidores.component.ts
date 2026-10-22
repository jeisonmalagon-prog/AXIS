import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';
import { SelectorBuscableComponent, OpcionSelector } from '../shared/selector-buscable/selector-buscable.component';
import { SubaplicativoService, Subaplicativo } from '../core/services/subaplicativo.service';
import { SistemaOperativoService } from '../core/services/sistema-operativo.service';
import { SistemaOperativo } from '../core/models/models';

// Catálogo compartido de personas para los desplegables de "Propietario" y
// "Dev" del servidor (y de los sub-aplicativos, que usan el mismo catálogo).
export interface Persona {
  id: number;
  nombre: string;
}

export interface Certificado {
  id: number;
  nombre_comun: string;
  entidad_emisora?: string;
  numero_serie?: string;
  fecha_fin?: string;
}

export interface OpcionIntegracion {
  id: number | null; // null = solo existe como texto en Aplicacion_Servidor.Descripcion, no tiene fila propia
  nombre: string;
  subtitulo?: string;
  servidor_id?: number; // solo aplica a aplicativos
  aplicacion_negocio_id?: number | null;
  aplicacion_negocio_nombre?: string | null;
}

export interface Integracion {
  id: number;
  descripcion?: string;
  tipo_destino: 'aplicativo' | 'servidor';
  nombre_destino: string;
  servidor_relacionado?: string;
}

export interface Servidor {
  id?: number;
  hostname: string;
  ip_address: string;
  puerto?: number | null;
  id_sistema_operativo: number;
  sistema_operativo?: string;
  plataforma?: string;
  ambiente: string;
  estado: string;
  descripcion?: string;
  fecha_creacion?: string;
  puntos_integracion?: string;
  fecha_ultimo_despliegue?: string;
  dependencias?: string;
  criticidad?: string;
  comandos?: string;
  configuracion?: string;
  info_seguridad?: string;
  propietario?: string;
  dev?: string;
  certificado_id?: number | null;
  total_integraciones?: number;
  /** true si el servidor existe (p. ej. se creó desde Certificados) pero aún no tiene ficha de inventario. */
  sin_ficha?: boolean;
  // Estado de certificados del servidor (se cruza por hostname con el módulo Certificados)
  certificados_total?: number;
  certificados_vencidos?: number;
  certificados_por_vencer?: number;
  certificados_dias_proximo?: number | null;
}

export interface ChipAmbiente { valor: string; total: number; }

// Resumen de los sub-aplicativos de un servidor (se arma con el inventario
// de sub-aplicativos, que es la fuente de verdad de qué corre en cada host).
interface ResumenSubs {
  total: number;
  criticidad: string;
  items: Subaplicativo[];
}

@Component({
  selector: 'app-servidores',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectorBuscableComponent],
  templateUrl: './servidores.component.html',
  styleUrl: './servidores.component.scss'
})
export class ServidoresComponent implements OnInit {
  // La pestaña "Sub-aplicativos" (en el contenedor Inventario) escucha estos
  // eventos para filtrarse por servidor o abrir la ficha de uno puntual.
  @Output() verSubaplicativos = new EventEmitter<number>();
  @Output() abrirSubaplicativo = new EventEmitter<{ servidorId: number; subId: number }>();

  servidores: Servidor[] = [];
  loading = true;
  terminoBusqueda: string = '';
  /** Ambiente normalizado ('Producción', 'QA', ...) o '' para todos. */
  filtroAmbiente = '';
  /** 'linux' | 'windows' | '' (todos). */
  filtroSO = '';
  /** Conteos para el resumen y los filtros rápidos (se recalculan al cargar). */
  chipsAmbiente: ChipAmbiente[] = [];
  totalLinux = 0;
  totalWindows = 0;
  totalOtroSO = 0;
  totalConCertificados = 0;
  totalCertificadosVencidos = 0;

  // Variable que controla si el usuario tiene permiso para modificar datos
  puedeEditar = false;

  // Sub-aplicativos agrupados por servidor
  subsPorServidor = new Map<number, ResumenSubs>();

  // Modales Servidor
  mostrarModalForm = false;
  /** Sección «Ficha técnica» del formulario (opcional): cerrada por defecto. */
  fichaAbierta = false;
  sistemasOperativos: SistemaOperativo[] = [];
  modoEdicion = false;
  servidorActual: Servidor = this.crearServidorVacio();
  // Se pone en true justo después de crear un servidor nuevo (sin cerrar el
  // modal), para mostrar un aviso breve de que ya se puede seguir con sus
  // integraciones — se apaga al abrir el modal de nuevo o al cerrarlo.
  servidorRecienCreado = false;

  // Detalle del servidor
  servidorSeleccionado: Servidor | null = null;
  integracionesDetalle: Integracion[] = [];

  // Visor de código aparte (Comandos/Config), para no inflar el modal de detalle
  codigoVisualizado: { titulo: string; contenido: string } | null = null;
  copiadoOk = false;

  abrirVisorCodigo(titulo: string, contenido?: string): void {
    if (!contenido) return;
    this.codigoVisualizado = { titulo, contenido };
    this.copiadoOk = false;
  }

  cerrarVisorCodigo(): void {
    this.codigoVisualizado = null;
  }

  copiarCodigo(): void {
    if (!this.codigoVisualizado) return;
    navigator.clipboard.writeText(this.codigoVisualizado.contenido).then(() => {
      this.copiadoOk = true;
      setTimeout(() => this.copiadoOk = false, 1500);
    });
  }

  // Catálogos para los desplegables
  certificados: Certificado[] = [];
  opcionesIntegracion: { aplicativos: OpcionIntegracion[]; servidores: OpcionIntegracion[]; servidoresBd: OpcionIntegracion[] } =
    { aplicativos: [], servidores: [], servidoresBd: [] };
  personas: Persona[] = [];

  // El selector reutilizable (app-selector-buscable) espera {id, nombre}; en
  // este catálogo id y nombre son el mismo valor a propósito, porque lo que
  // se guarda en BD es el nombre en texto plano (Propietario/Dev son
  // VARCHAR, no una llave foránea) — no un id numérico aparte.
  personasOpciones: OpcionSelector[] = [];

  // Handler del "+ Agregar" de los campos de persona. El selector ya dejó el
  // nombre nuevo escrito en el campo (vía valorChange, que se dispara junto
  // con este evento) — acá solo falta guardarlo en el catálogo compartido.
  onAgregarPersona(nombre: string): void {
    const yaExiste = this.personas.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase());
    if (yaExiste) return;
    this.http.post<Persona>(`${this.endpoint}/catalogos/personas`, { nombre }).subscribe({
      next: (persona) => {
        this.personas = [...this.personas, persona].sort((a, b) => a.nombre.localeCompare(b.nombre));
        this.personasOpciones = this.personas.map((p) => ({ id: p.nombre, nombre: p.nombre }));
      },
      error: (err) => console.error('Error agregando persona al catálogo:', err)
    });
  }

  // Motores de BD reconocidos como "Plataforma" de un SERVIDOR (no incluye
  // "Otro": eso sigue siendo el genérico para plataformas no listadas, sin
  // contar como servidor de base de datos). Debe reflejar la misma lista que
  // usa el backend para decidir qué servidores aparecen en el selector
  // "Servidor de Base de Datos" (ver /catalogos/opciones-integracion).
  motoresBdServidor = ['MySQL', 'SQL Server', 'Oracle', 'PostgreSQL', 'MongoDB'];

  // Integraciones del SERVIDOR que se está editando actualmente
  integracionesServidor: Integracion[] = [];
  nuevaIntegracionServidor: { servidor_id: number | null; aplicativoSeleccionado: OpcionIntegracion | null; descripcion: string } = {
    servidor_id: null, aplicativoSeleccionado: null, descripcion: ''
  };

  // Aplicativos disponibles para el servidor elegido en el picker de integración
  aplicativosDelServidorElegido(servidorId: number | null): OpcionIntegracion[] {
    if (!servidorId) return [];
    return this.opcionesIntegracion.aplicativos.filter(a => a.servidor_id === servidorId);
  }

  // Necesario porque el <select> compara objetos por referencia, y la opción
  // seleccionada no siempre es la misma instancia que la de la lista.
  compararOpcion(a: OpcionIntegracion | null, b: OpcionIntegracion | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.id === b.id && a.nombre === b.nombre && a.servidor_id === b.servidor_id;
  }

  // Orden de severidad para calcular la criticidad "más alta" de un servidor
  private ordenCriticidad: { [key: string]: number } = { 'Alta': 3, 'Media': 2, 'Baja': 1 };

  private endpoint = `${environment.apiUrl}/servidoresInventario`;

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private subService: SubaplicativoService,
    private soService: SistemaOperativoService
  ) {}

  ngOnInit(): void {
    // Verificamos el rol del usuario conectado
    this.puedeEditar = this.authService.puedeEditar('SERVIDORES');

    this.cargarServidores();
    this.cargarCatalogos();
    this.soService.listar().subscribe({
      next: (so) => this.sistemasOperativos = so,
      error: (err) => console.error('Error cargando sistemas operativos:', err)
    });
  }

  cargarCatalogos(): void {
    this.http.get<Certificado[]>(`${this.endpoint}/catalogos/certificados`).subscribe({
      next: (data) => this.certificados = data,
      error: (err) => console.error('Error cargando certificados:', err)
    });
    this.http.get<{ aplicativos: OpcionIntegracion[]; servidores: OpcionIntegracion[]; servidoresBd: OpcionIntegracion[] }>(`${this.endpoint}/catalogos/opciones-integracion`).subscribe({
      next: (data) => this.opcionesIntegracion = data,
      error: (err) => console.error('Error cargando opciones de integración:', err)
    });
    this.http.get<Persona[]>(`${this.endpoint}/catalogos/personas`).subscribe({
      next: (data) => {
        this.personas = data;
        this.personasOpciones = data.map((p) => ({ id: p.nombre, nombre: p.nombre }));
      },
      error: (err) => console.error('Error cargando catálogo de personas:', err)
    });
  }

  cargarServidores(): void {
    this.loading = true;
    this.http.get<Servidor[]>(this.endpoint).subscribe({
      next: (data) => {
        this.servidores = data;
        this.recalcularResumen();
        this.loading = false;
      },
      error: (err) => {
        console.error('Error cargando el inventario:', err);
        this.loading = false;
      }
    });
    this.cargarSubaplicativos();
  }

  // Quién corre en cada servidor sale del inventario de sub-aplicativos.
  private cargarSubaplicativos(): void {
    this.subService.listar().subscribe({
      next: (subs) => {
        const mapa = new Map<number, ResumenSubs>();
        for (const s of subs) {
          const r = mapa.get(s.servidor_id) || { total: 0, criticidad: '', items: [] };
          r.total++;
          r.items.push(s);
          if ((this.ordenCriticidad[s.criticidad || ''] || 0) > (this.ordenCriticidad[r.criticidad] || 0)) {
            r.criticidad = s.criticidad as string;
          }
          mapa.set(s.servidor_id, r);
        }
        this.subsPorServidor = mapa;
      },
      error: (err) => console.error('Error cargando sub-aplicativos por servidor:', err)
    });
  }

  // --- Ambiente: los datos vienen con variantes de la misma información
  // ("PRODUCCION", "Producción", "Produccion"...). Se normaliza SOLO para
  // mostrar y filtrar; el dato guardado no se reescribe.
  normalizarAmbiente(ambiente: string | null | undefined): string {
    if (!ambiente || !ambiente.trim()) return 'Sin especificar';
    const limpio = ambiente.trim().toLowerCase()
      .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i').replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u');
    if (limpio.startsWith('prod')) return 'Producción';
    if (limpio === 'qa') return 'QA';
    if (limpio.startsWith('desarrollo') || limpio === 'dev') return 'Desarrollo';
    if (limpio.startsWith('prueba')) return 'Pruebas';
    return ambiente.trim();
  }

  claseAmbiente(normalizado: string): string {
    const v = normalizado.toLowerCase();
    if (v === 'producción') return 'amb-prod';
    if (v === 'qa') return 'amb-qa';
    if (v === 'desarrollo') return 'amb-dev';
    if (v === 'pruebas') return 'amb-pruebas';
    return 'amb-otro';
  }

  /** Valor que usa el formulario (select) para un ambiente guardado en cualquier variante. */
  ambienteParaFormulario(ambiente: string | null | undefined): string {
    const n = this.normalizarAmbiente(ambiente);
    if (n === 'Producción') return 'PRODUCCION';
    if (n === 'QA') return 'QA';
    if (n === 'Pruebas') return 'PRUEBAS';
    if (n === 'Desarrollo') return 'DESARROLLO';
    return n === 'Sin especificar' ? 'PRODUCCION' : n;
  }

  /** 'linux' | 'windows' | 'otro' según el sistema operativo del servidor. */
  tipoSO(s: Servidor): string {
    const v = (s.sistema_operativo || '').toLowerCase();
    if (v.includes('linux')) return 'linux';
    if (v.includes('windows')) return 'windows';
    return 'otro';
  }

  nombreSO(s: Servidor): string {
    return s.sistema_operativo || (s.id_sistema_operativo === 2 ? 'Windows' : s.id_sistema_operativo === 1 ? 'Linux' : 'Sin definir');
  }

  private recalcularResumen(): void {
    const mapa = new Map<string, number>();
    let linux = 0, windows = 0, otro = 0, conCert = 0, vencidos = 0;
    for (const s of this.servidores) {
      const amb = this.normalizarAmbiente(s.ambiente);
      mapa.set(amb, (mapa.get(amb) || 0) + 1);
      const so = this.tipoSO(s);
      if (so === 'linux') linux++; else if (so === 'windows') windows++; else otro++;
      if ((s.certificados_total || 0) > 0) conCert++;
      if ((s.certificados_vencidos || 0) > 0) vencidos++;
    }
    this.chipsAmbiente = [...mapa.entries()].map(([valor, total]) => ({ valor, total })).sort((a, b) => b.total - a.total);
    this.totalLinux = linux;
    this.totalWindows = windows;
    this.totalOtroSO = otro;
    this.totalConCertificados = conCert;
    this.totalCertificadosVencidos = vencidos;
  }

  seleccionarAmbiente(valor: string): void {
    this.filtroAmbiente = this.filtroAmbiente === valor ? '' : valor;
  }

  seleccionarSO(valor: string): void {
    this.filtroSO = this.filtroSO === valor ? '' : valor;
  }

  limpiarFiltros(): void {
    this.terminoBusqueda = '';
    this.filtroAmbiente = '';
    this.filtroSO = '';
  }

  get hayFiltros(): boolean {
    return !!(this.terminoBusqueda.trim() || this.filtroAmbiente || this.filtroSO);
  }

  get servidoresFiltrados(): Servidor[] {
    const term = this.terminoBusqueda.toLowerCase().trim();
    return this.servidores.filter((s) => {
      if (this.filtroAmbiente && this.normalizarAmbiente(s.ambiente) !== this.filtroAmbiente) return false;
      if (this.filtroSO && this.tipoSO(s) !== this.filtroSO) return false;
      if (!term) return true;
      const subs = (this.subsPorServidor.get(s.id as number)?.items || []).map((x) => x.nombre).join(' ');
      return [s.hostname, s.ip_address, this.nombreSO(s), this.normalizarAmbiente(s.ambiente), s.plataforma, s.propietario, s.dev, s.descripcion, subs]
        .join(' ').toLowerCase().includes(term);
    });
  }

  /** Texto corto del estado de certificados de un servidor ('' si no tiene). */
  textoCertificados(s: Servidor): string {
    const total = s.certificados_total || 0;
    if (!total) return '';
    const partes = [`${total} certificado${total === 1 ? '' : 's'}`];
    if (s.certificados_vencidos) partes.push(`${s.certificados_vencidos} vencido${s.certificados_vencidos === 1 ? '' : 's'}`);
    else if (s.certificados_por_vencer) partes.push(`${s.certificados_por_vencer} por vencer`);
    return partes.join(' · ');
  }

  claseCertificados(s: Servidor): string {
    if (s.certificados_vencidos) return 'cert-mal';
    if (s.certificados_por_vencer) return 'cert-aviso';
    return 'cert-ok';
  }

  totalSubs(s: Servidor): number {
    return this.subsPorServidor.get(s.id as number)?.total || 0;
  }

  subsDe(s: Servidor): Subaplicativo[] {
    return this.subsPorServidor.get(s.id as number)?.items || [];
  }

  // Criticidad más alta entre los sub-aplicativos del servidor; si no tiene
  // (o ninguno trae criticidad), usa la del propio servidor.
  criticidadServidor(s: Servidor): string {
    return this.subsPorServidor.get(s.id as number)?.criticidad || s.criticidad || 'ND';
  }

  verDetalle(servidor: Servidor): void {
    if (!servidor.id) return;
    this.http.get<Servidor>(`${this.endpoint}/${servidor.id}`).subscribe({
      next: (data) => {
        this.servidorSeleccionado = data;
        this.cargarIntegracionesDetalle(servidor.id!);
      },
      error: (err) => console.error('Error obteniendo detalle:', err)
    });
  }

  cargarIntegracionesDetalle(servidorId: number): void {
    this.http.get<Integracion[]>(`${this.endpoint}/${servidorId}/integraciones`).subscribe({
      next: (data) => this.integracionesDetalle = data,
      error: (err) => console.error('Error cargando integraciones del detalle:', err)
    });
  }

  cerrarDetalle(): void {
    this.servidorSeleccionado = null;
    this.integracionesDetalle = [];
  }

  // Salto a la pestaña de Sub-aplicativos
  irASubaplicativos(servidor: Servidor, event?: Event): void {
    if (event) event.stopPropagation();
    if (!servidor.id) return;
    this.cerrarDetalle();
    this.verSubaplicativos.emit(servidor.id);
  }

  irAFicha(servidor: Servidor, sub: Subaplicativo, event?: Event): void {
    if (event) event.stopPropagation();
    if (!servidor.id) return;
    this.cerrarDetalle();
    this.abrirSubaplicativo.emit({ servidorId: servidor.id, subId: sub.id });
  }

  // --- FORMULARIO SERVIDOR ---
  crearServidorVacio(): Servidor {
    return {
      hostname: '',
      ip_address: '',
      puerto: null,
      id_sistema_operativo: undefined as unknown as number,
      plataforma: '',
      ambiente: 'PRODUCCION',
      estado: 'ACTIVO',
      descripcion: '',
      puntos_integracion: '',
      fecha_ultimo_despliegue: '',
      dependencias: '',
      criticidad: '',
      comandos: '',
      configuracion: '',
      info_seguridad: 'Ninguna',
      certificado_id: null,
      propietario: '',
      dev: ''
    };
  }

  abrirModalNuevo(): void {
    this.modoEdicion = false;
    this.servidorActual = this.crearServidorVacio();
    this.integracionesServidor = [];
    this.servidorRecienCreado = false;
    this.fichaAbierta = false;
    this.mostrarModalForm = true;
  }

  abrirModalEditar(servidor: Servidor, event?: Event): void {
    if (event) event.stopPropagation();
    this.modoEdicion = true;
    const fecha = servidor.fecha_ultimo_despliegue
      ? new Date(servidor.fecha_ultimo_despliegue).toISOString().split('T')[0]
      : '';
    this.servidorActual = {
      ...servidor,
      fecha_ultimo_despliegue: fecha,
      // La ficha de un servidor creado desde Certificados puede venir sin estos datos
      ambiente: this.ambienteParaFormulario(servidor.ambiente),
      estado: servidor.estado || 'ACTIVO',
      criticidad: servidor.criticidad || '',
      plataforma: servidor.plataforma || '',
      info_seguridad: servidor.info_seguridad || 'Ninguna'
    };
    this.servidorRecienCreado = false;
    // Si el servidor ya tiene ficha técnica, se abre directamente
    this.fichaAbierta = !servidor.sin_ficha;
    this.mostrarModalForm = true;
    this.cargarIntegracionesServidor();
  }

  cargarIntegracionesServidor(): void {
    if (!this.servidorActual.id) { this.integracionesServidor = []; return; }
    this.http.get<Integracion[]>(`${this.endpoint}/${this.servidorActual.id}/integraciones`).subscribe({
      next: (data) => this.integracionesServidor = data,
      error: (err) => console.error('Error cargando integraciones del servidor:', err)
    });
  }

  agregarIntegracionServidor(): void {
    if (!this.servidorActual.id) {
      alert('Guarda primero el servidor antes de agregar integraciones.');
      return;
    }
    if (!this.nuevaIntegracionServidor.servidor_id) {
      alert('Selecciona un servidor destino.');
      return;
    }
    const sel = this.nuevaIntegracionServidor.aplicativoSeleccionado;
    const payload = sel && sel.id
      ? { tipo: 'aplicativo', destino_id: sel.id, descripcion: this.nuevaIntegracionServidor.descripcion }
      : {
          tipo: 'servidor',
          destino_id: this.nuevaIntegracionServidor.servidor_id,
          descripcion: sel ? [sel.nombre, this.nuevaIntegracionServidor.descripcion].filter(Boolean).join(' — ') : this.nuevaIntegracionServidor.descripcion
        };
    this.http.post(`${this.endpoint}/${this.servidorActual.id}/integraciones`, payload).subscribe({
      next: () => {
        this.nuevaIntegracionServidor = { servidor_id: null, aplicativoSeleccionado: null, descripcion: '' };
        this.cargarIntegracionesServidor();
      },
      error: (err) => console.error('Error agregando integración:', err)
    });
  }

  eliminarIntegracionServidor(integracionId: number): void {
    this.http.delete(`${this.endpoint}/integraciones/servidor/${integracionId}`).subscribe({
      next: () => this.cargarIntegracionesServidor(),
      error: (err) => console.error('Error eliminando integración:', err)
    });
  }

  cerrarModalForm(): void {
    this.mostrarModalForm = false;
    this.servidorRecienCreado = false;
  }

  guardarServidor(): void {
    if (!this.servidorActual.hostname?.trim() || !this.servidorActual.ip_address?.trim() || !this.servidorActual.id_sistema_operativo) {
      alert('Hostname, IP y Sistema operativo son obligatorios');
      return;
    }

    const idExistente = this.servidorActual.id;

    if (this.modoEdicion && idExistente) {
      this.http.put(`${this.endpoint}/${idExistente}`, this.servidorActual).subscribe({
        next: () => {
          this.cargarServidores();
          this.cerrarModalForm();
        },
        error: (err) => {
          console.error('Error actualizando:', err);
          const detalleError = err.error?.error || err.message || 'Error desconocido';
          alert(`❌ Error al actualizar:\n${detalleError}`);
        }
      });
    } else {
      this.http.post<{ id: number }>(this.endpoint, this.servidorActual).subscribe({
        next: (resp) => {
          this.cargarServidores();
          // En vez de cerrar el modal, seguimos en el MISMO formulario pero ya
          // en modo edición: el servidor recién creado ya tiene id, así que el
          // panel de "Integraciones" queda disponible de inmediato.
          if (resp?.id && this.fichaAbierta) {
            this.servidorActual.id = resp.id;
            this.modoEdicion = true;
            this.servidorRecienCreado = true;
            this.cargarIntegracionesServidor();
          } else {
            this.cerrarModalForm();
          }
        },
        error: (err) => {
          console.error('Error creando:', err);
          const detalleError = err.error?.error || 'Verifica que Hostname e IP no estén duplicados.';
          alert(`❌ Error al crear:\n${detalleError}`);
        }
      });
    }
  }

  eliminarServidor(id?: number, event?: Event): void {
    if (event) event.stopPropagation();
    if (!id) return;

    const total = this.subsPorServidor.get(id)?.total || 0;
    const aviso = total
      ? `Este servidor tiene ${total} sub-aplicativo(s) registrado(s). Debes eliminarlos o moverlos primero.\n\n¿Intentar eliminarlo de todos modos?`
      : '¿Estás seguro de que deseas eliminar este servidor del inventario?';

    if (confirm(aviso)) {
      this.http.delete(`${this.endpoint}/${id}`).subscribe({
        next: () => this.cargarServidores(),
        error: () => alert('No se pudo eliminar el servidor debido a dependencias asociadas.')
      });
    }
  }
}
