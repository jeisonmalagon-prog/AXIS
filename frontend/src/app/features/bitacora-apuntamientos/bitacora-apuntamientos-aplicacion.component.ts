import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApuntamientoService } from '../../core/services/apuntamiento.service';
import { AplicacionService } from '../../core/services/aplicacion.service';
import { AceServiciosService } from '../../core/services/ace-servicios.service';
import {
  Apuntamiento,
  AceServicioInventario,
  CategoriaApuntamiento,
  RegistrarCambioApuntamientoPayload,
} from '../../core/models/models';
import { AuthService } from '../../services/auth.service';

// Formulario de "Nuevo apuntamiento" / "Editar apuntamiento" (Acción 1). Al
// CREAR se usan todos los campos (sigue haciendo falta la info completa de
// una vez). Al EDITAR un apuntamiento que ya existe, el template solo
// muestra los campos estructurales (AplicacionId/ServidorId/Componente/
// SinApuntamiento) — Categoría/Servicio/Observaciones/FechaActualizacion se
// dejan en el objeto por si se está creando, pero no se tocan al editar (ver
// guardar() más abajo y "Registrar cambio").
interface FormularioApuntamiento {
  AplicacionId: number | null;
  ServidorId: number | null;
  Componente: string;
  SinApuntamiento: boolean;
  Categoria: CategoriaApuntamiento | '';
  ServicioInventarioId: number | null;
  Observaciones: string;
  // Formato de <input type="datetime-local"> (ej. "2026-09-10T15:12").
  // Vacío = al guardar, el backend usa la fecha/hora actual.
  FechaActualizacion: string;
}

function formularioVacio(): FormularioApuntamiento {
  return {
    AplicacionId: null,
    ServidorId: null,
    Componente: '',
    SinApuntamiento: false,
    Categoria: '',
    ServicioInventarioId: null,
    Observaciones: '',
    FechaActualizacion: '',
  };
}

// Formulario de "Registrar cambio" (Acción 2: ajuste, mantenimiento o
// mejora). Documenta un cambio operativo sobre un apuntamiento que ya
// existe — Categoría, Servicio, Observaciones, y opcionalmente TRANDID,
// error e imagen (evidencia) — y SÍ queda en el histórico.
interface FormularioCambio {
  Categoria: CategoriaApuntamiento | '';
  ServicioInventarioId: number | null;
  Observaciones: string;
  TrandId: string;
  Error: string;
  // Data URI base64 ya leída del archivo elegido, o null si no se adjuntó
  // ninguna imagen.
  Imagen: string | null;
  FechaActualizacion: string;
}

function formularioCambioVacio(): FormularioCambio {
  return {
    Categoria: '',
    ServicioInventarioId: null,
    Observaciones: '',
    TrandId: '',
    Error: '',
    Imagen: null,
    FechaActualizacion: '',
  };
}

// Un "nodo" agrupa los apuntamientos de esta aplicación por servidor físico
// (o, cuando servidorId es null, los que no tienen un servidor específico
// asignado). Se muestran como botones para filtrar la tabla — distintos
// nodos de una misma aplicación pueden apuntar a servicios completamente
// distintos, por eso hace falta poder verlos por separado.
interface NodoTab {
  id: number | 'sin-servidor';
  etiqueta: string;
  cantidad: number;
}

// Vista "Comparar nodos": una fila por servicio y, para cada nodo, qué
// categorías (ACE / Bus de Integración 10) apuntan a ese servicio. Si algún
// nodo no apunta a él, o apunta con otra categoría, la fila es "diferente".
interface CeldaComparacion {
  ausente: boolean;
  sinApuntamiento: boolean;
  categorias: CategoriaApuntamiento[];
}

interface FilaComparacion {
  clave: string;
  codigo: string;
  nombre: string;
  pod: string;
  celdas: CeldaComparacion[];
  // Por celda: true si ese nodo es "el distinto" (su apuntamiento no coincide
  // con el de la mayoría de nodos). Si no hay mayoría, todos quedan marcados.
  diferentes: boolean[];
  igual: boolean;
  presentesEn: number;
}

interface ResultadoComparacion {
  columnas: NodoTab[];
  filas: FilaComparacion[];
  totalIguales: number;
  totalDiferentes: number;
}

// Vista de detalle de UNA aplicación dentro de la Bitácora de Apuntamientos:
// se llega aquí desde la tarjeta de esa aplicación en
// bitacora-apuntamientos-list.component.ts. Antes toda esta lógica (crear/
// editar/registrar cambio/eliminar) vivía en la vista agrupada; ahora vive
// acá, ya filtrada a una sola aplicación y con botones para elegir el nodo.
@Component({
  selector: 'app-bitacora-apuntamientos-aplicacion',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './bitacora-apuntamientos-aplicacion.component.html',
  styleUrl: './bitacora-apuntamientos-aplicacion.component.scss',
})
export class BitacoraApuntamientosAplicacionComponent implements OnInit {
  cargando = true;
  aplicacionId!: number;
  aplicacionNombre = '';

  apuntamientos: Apuntamiento[] = [];
  terminoBusqueda = '';

  // Un número = ServidorId específico; 'sin-servidor' = apuntamientos sin
  // servidor asignado; 'comparar' = vista que pone todos los nodos lado a
  // lado. Ya no existe "todos los nodos" mezclados: se ve nodo por nodo.
  // null = todavía no se eligió (se elige el primer nodo al terminar de cargar).
  nodoSeleccionado: number | 'sin-servidor' | 'comparar' | null = null;

  // En la vista "Comparar nodos": mostrar solo las filas donde los nodos
  // difieren (lo más útil para ver qué cambia de un nodo a otro).
  soloDiferencias = true;
  private comparacionCache: ResultadoComparacion | null = null;

  // Aplicaciones (con sus "componentes" ya calculados a partir de la
  // descripción de cada servidor, igual que en Aplicaciones → Servidores) y
  // el catálogo de servicios (mismo catálogo para ACE y Bus de Integración 10).
  aplicaciones: any[] = [];
  serviciosInventario: AceServicioInventario[] = [];

  // Solo ADMIN_POD/ADMIN_MIN pueden crear/editar/borrar. BASIC = solo lectura.
  puedeEditar = false;

  // ============================================================
  // "Nuevo apuntamiento" / "Editar apuntamiento" (Acción 1)
  // ============================================================
  mostrarForm = false;
  editando: Apuntamiento | null = null;
  form: FormularioApuntamiento = formularioVacio();
  guardando = false;

  // Cuando se edita un apuntamiento cuyo servidor ya no aparece en la lista
  // de servidores de la aplicación (caso raro, ej. datos cargados por
  // script), esto guarda su etiqueta para poder mostrarlo igual.
  editandoServidorLabel: string | null = null;

  // Listas cacheadas para el formulario (servidores/componentes disponibles
  // según la aplicación y servidor elegidos). Se recalculan explícitamente
  // con actualizarListasFormulario() en vez de llamarse desde el *ngFor del
  // template directamente: eso generaba un array nuevo en cada ciclo de
  // detección de cambios y desestabilizaba el binding del <select>.
  servidoresDisponiblesForm: any[] = [];
  componentesDisponiblesForm: string[] = [];

  // ============================================================
  // "Registrar cambio" (Acción 2: ajuste, mantenimiento o mejora)
  // ============================================================
  mostrarFormCambio = false;
  apuntamientoCambio: Apuntamiento | null = null;
  formCambio: FormularioCambio = formularioCambioVacio();
  guardandoCambio = false;

  // Validación del lado del cliente para la imagen adjunta (además de la
  // que hace el backend — nunca hay que confiar solo en el frontend).
  private readonly MAX_IMAGEN_BYTES = 2 * 1024 * 1024;
  private readonly TIPOS_IMAGEN_PERMITIDOS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  imagenNombreArchivo: string | null = null;
  imagenErrorCliente: string | null = null;

  constructor(
    private apuntamientoService: ApuntamientoService,
    private aplicacionService: AplicacionService,
    private aceServiciosService: AceServiciosService,
    private authService: AuthService,
    private route: ActivatedRoute,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('SERVICIOS');

    this.route.paramMap.subscribe((params) => {
      this.aplicacionId = Number(params.get('aplicacionId'));
      this.nodoSeleccionado = null;
      this.cargar();
    });

    // Mismo criterio que Aplicaciones → Servidores: la "descripcion" de cada
    // servidor es una lista separada por comas de componentes/roles.
    this.aplicacionService.listar().subscribe((data) => {
      this.aplicaciones = (data as any[]).map((app: any) => {
        if (app.servidores) {
          app.servidores = app.servidores.map((s: any) => {
            s.roles = s.descripcion
              ? s.descripcion.split(',').map((r: string) => r.trim()).filter((r: string) => r !== '')
              : [];
            return s;
          });
        }
        return app;
      });
      const app = this.aplicaciones.find((a) => (a.id ?? a.Id) === this.aplicacionId);
      if (app) this.aplicacionNombre = app.nombre || app.Nombre;
    });

    this.aceServiciosService.listar().subscribe((s) => (this.serviciosInventario = s));
  }

  cargar(): void {
    this.cargando = true;
    this.apuntamientoService.listar().subscribe({
      next: (datos) => {
        this.apuntamientos = datos;
        this.cargando = false;
        this.apuntamientosCambiaron();
      },
      error: (err) => {
        console.error('Error al cargar la bitácora de apuntamientos:', err);
        this.cargando = false;
      },
    });
  }

  volver(): void {
    this.router.navigate(['/apuntamientos']);
  }

  // Todos los apuntamientos de ESTA aplicación (sin filtrar por nodo ni
  // búsqueda todavía) — base para los botones de nodo y para la tabla.
  get apuntamientosDeAplicacion(): Apuntamiento[] {
    return this.apuntamientos.filter((a) => a.AplicacionId === this.aplicacionId);
  }

  // Botones de nodo: "Todos los nodos" + uno por cada servidor físico (o el
  // grupo "sin servidor específico") que tenga al menos un apuntamiento acá.
  get nodos(): NodoTab[] {
    const mapa = new Map<string, NodoTab>();
    for (const a of this.apuntamientosDeAplicacion) {
      const clave = a.ServidorId != null ? String(a.ServidorId) : 'sin-servidor';
      let nodo = mapa.get(clave);
      if (!nodo) {
        nodo = {
          id: a.ServidorId != null ? a.ServidorId : 'sin-servidor',
          etiqueta: a.ServidorHostname ? `${a.ServidorHostname} (${a.ServidorIP})` : 'Sin servidor específico',
          cantidad: 0,
        };
        mapa.set(clave, nodo);
      }
      nodo.cantidad++;
    }
    return Array.from(mapa.values()).sort((a, b) => a.etiqueta.localeCompare(b.etiqueta));
  }

  // `nodos` genera objetos nuevos en cada cambio de detección; sin trackBy el
  // *ngFor recreaba los botones de nodo en cada ciclo y un clic podía perderse
  // si el botón se reemplazaba entre que se presiona y se suelta el mouse.
  trackNodo(_indice: number, nodo: NodoTab): number | string {
    return nodo.id;
  }

  seleccionarNodo(id: number | 'sin-servidor' | 'comparar'): void {
    this.nodoSeleccionado = id;
  }

  get comparando(): boolean {
    return this.nodoSeleccionado === 'comparar';
  }

  // Hay que invalidar la comparación y revisar que el nodo elegido siga
  // existiendo cada vez que cambia la lista (cargar, crear, editar, borrar).
  private apuntamientosCambiaron(): void {
    this.comparacionCache = null;
    const lista = this.nodos;
    if (this.nodoSeleccionado === 'comparar') {
      if (lista.length < 2) this.nodoSeleccionado = lista.length ? lista[0].id : null;
      return;
    }
    const sigueExistiendo = lista.some((n) => n.id === this.nodoSeleccionado);
    if (!sigueExistiendo) this.nodoSeleccionado = lista.length ? lista[0].id : null;
  }

  // Un servicio (o el grupo "sin apuntamiento") por fila y una columna por nodo.
  get comparacion(): ResultadoComparacion {
    if (this.comparacionCache) return this.comparacionCache;

    const columnas = this.nodos;
    const filasPorClave = new Map<string, FilaComparacion>();

    for (const a of this.apuntamientosDeAplicacion) {
      const idxColumna = columnas.findIndex((n) =>
        a.ServidorId != null ? n.id === a.ServidorId : n.id === 'sin-servidor');
      if (idxColumna === -1) continue;

      const clave = a.SinApuntamiento || a.ServicioInventarioId == null ? 'sin-apuntamiento' : String(a.ServicioInventarioId);
      let fila = filasPorClave.get(clave);
      if (!fila) {
        fila = {
          clave,
          codigo: clave === 'sin-apuntamiento' ? '' : (a.ServicioCodigo || ''),
          nombre: clave === 'sin-apuntamiento' ? 'Sin apuntamiento a servicios' : (a.ServicioNombre || ''),
          pod: clave === 'sin-apuntamiento' ? '' : (a.ServicioPod || ''),
          celdas: columnas.map(() => ({ ausente: true, sinApuntamiento: false, categorias: [] })),
          diferentes: columnas.map(() => false),
          igual: true,
          presentesEn: 0,
        };
        filasPorClave.set(clave, fila);
      }

      const celda = fila.celdas[idxColumna];
      celda.ausente = false;
      if (clave === 'sin-apuntamiento') {
        celda.sinApuntamiento = true;
      } else if (a.Categoria && !celda.categorias.includes(a.Categoria)) {
        celda.categorias.push(a.Categoria);
        celda.categorias.sort();
      }
    }

    const firma = (c: CeldaComparacion) => (c.ausente ? '-' : c.sinApuntamiento ? 'sin' : c.categorias.join('+'));
    const filas = Array.from(filasPorClave.values());
    for (const f of filas) {
      f.presentesEn = f.celdas.filter((c) => !c.ausente).length;
      f.igual = f.celdas.every((c) => firma(c) === firma(f.celdas[0]));
      if (!f.igual) {
        const firmas = f.celdas.map(firma);
        const conteo = new Map<string, number>();
        firmas.forEach((x) => conteo.set(x, (conteo.get(x) || 0) + 1));
        const maximo = Math.max(...conteo.values());
        const mayoritarias = Array.from(conteo.entries()).filter(([, n]) => n === maximo);
        f.diferentes = mayoritarias.length === 1
          ? firmas.map((x) => x !== mayoritarias[0][0])
          : firmas.map(() => true);
      }
    }

    // Primero las que difieren (las que faltan en más nodos arriba), luego
    // por código del servicio.
    filas.sort((x, y) => {
      if (x.igual !== y.igual) return x.igual ? 1 : -1;
      if (x.presentesEn !== y.presentesEn) return x.presentesEn - y.presentesEn;
      return x.codigo.localeCompare(y.codigo, 'es', { numeric: true });
    });

    this.comparacionCache = {
      columnas,
      filas,
      totalIguales: filas.filter((f) => f.igual).length,
      totalDiferentes: filas.filter((f) => !f.igual).length,
    };
    return this.comparacionCache;
  }

  get filasComparacionVisibles(): FilaComparacion[] {
    let filas = this.comparacion.filas;
    if (this.soloDiferencias) filas = filas.filter((f) => !f.igual);
    const termino = this.terminoBusqueda.toLowerCase().trim();
    if (termino) {
      filas = filas.filter((f) => `${f.codigo} ${f.nombre} ${f.pod}`.toLowerCase().includes(termino));
    }
    return filas;
  }

  get apuntamientosFiltrados(): Apuntamiento[] {
    let lista = this.apuntamientosDeAplicacion;

    if (this.nodoSeleccionado === null || this.nodoSeleccionado === 'comparar') {
      return [];
    } else if (this.nodoSeleccionado === 'sin-servidor') {
      lista = lista.filter((a) => a.ServidorId == null);
    } else {
      lista = lista.filter((a) => a.ServidorId === this.nodoSeleccionado);
    }

    if (!this.terminoBusqueda) return lista;
    const termino = this.terminoBusqueda.toLowerCase().trim();
    return lista.filter((a) => JSON.stringify(a).toLowerCase().includes(termino));
  }

  etiquetaCategoria(categoria: CategoriaApuntamiento | null): string {
    if (categoria === 'ACE') return 'ACE';
    if (categoria === 'BUS_INTEGRACION_10') return 'Bus de Integración 10';
    return '—';
  }

  // Componentes ya registrados para esa aplicación (unión de los roles de
  // todos sus servidores, sin repetir), para reutilizarlos como "sub
  // aplicación" en vez de escribirlos de nuevo a mano. Se usa solo cuando
  // todavía no se ha elegido un servidor específico.
  componentesDeAplicacion(aplicacionId: number | null): string[] {
    if (!aplicacionId) return [];
    const app = this.aplicaciones.find((a) => (a.id || a.Id) === aplicacionId);
    if (!app || !app.servidores) return [];

    const vistos = new Set<string>();
    const resultado: string[] = [];
    for (const servidor of app.servidores) {
      for (const rol of servidor.roles || []) {
        const clave = rol.toLowerCase();
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        resultado.push(rol);
      }
    }
    return resultado;
  }

  // Servidores físicos reales (hostname + IP) registrados para esa
  // aplicación en Aplicaciones → Servidores. Varios servidores pueden
  // compartir el mismo rol/componente (ej. 3 nodos con "API Nodo"), por
  // eso hace falta identificar el servidor exacto y no solo el rol.
  servidoresDeAplicacion(aplicacionId: number | null): any[] {
    if (!aplicacionId) return [];
    const app = this.aplicaciones.find((a) => (a.id || a.Id) === aplicacionId);
    return app?.servidores || [];
  }

  servidorEstaRegistrado(servidorId: number | null): boolean {
    if (!servidorId) return false;
    return this.servidoresDisponiblesForm.some((sv: any) => (sv.id || sv.Id) === servidorId);
  }

  // Componentes disponibles para el formulario: si ya se eligió un
  // servidor específico, solo los roles de ESE servidor (evita mezclar
  // roles de otros nodos); si no, la unión de toda la aplicación.
  componentesDisponibles(aplicacionId: number | null, servidorId: number | null): string[] {
    if (servidorId) {
      const servidor = this.servidoresDeAplicacion(aplicacionId).find((s: any) => (s.id || s.Id) === servidorId);
      return servidor?.roles || [];
    }
    return this.componentesDeAplicacion(aplicacionId);
  }

  onCambioAplicacion(): void {
    this.form.ServidorId = null;
    this.form.Componente = '';
    this.actualizarListasFormulario();
  }

  onCambioServidor(): void {
    this.form.Componente = '';
    this.actualizarListasFormulario();
  }

  // Recalcula las listas cacheadas del formulario (servidores/componentes
  // disponibles) según la aplicación y servidor elegidos actualmente.
  private actualizarListasFormulario(): void {
    this.servidoresDisponiblesForm = this.servidoresDeAplicacion(this.form.AplicacionId);
    this.componentesDisponiblesForm = this.componentesDisponibles(this.form.AplicacionId, this.form.ServidorId);
  }

  // Formato legible de fechas para la columna "Última actualización".
  formatearFecha(fecha: string | null | undefined): string {
    if (!fecha) return '—';
    const d = new Date(fecha);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-CO', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // Convierte la fecha que devuelve el backend (ISO o "YYYY-MM-DD HH:MM:SS")
  // al formato que espera <input type="datetime-local"> (ej. "2026-09-10T15:12").
  private aFechaInputLocal(fecha: string | null | undefined): string {
    if (!fecha) return '';
    const d = new Date(fecha);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Convierte el valor de <input type="datetime-local"> (ej.
  // "2026-09-10T15:12") al formato que espera el backend/MySQL
  // ("2026-09-10 15:12:00"). Vacío => undefined, para que el backend use
  // la fecha/hora actual.
  private aFechaMysql(valor: string): string | undefined {
    if (!valor) return undefined;
    return `${valor.replace('T', ' ')}:00`;
  }

  // El histórico de cambios se ve en su propia pantalla (/apuntamientos-historico,
  // ver ApuntamientosHistoricoListComponent) en vez de aquí adentro, para no
  // recargar/saturar este formulario de edición con eso.
  verHistorico(a: Apuntamiento): void {
    this.router.navigate(['/apuntamientos-historico'], { queryParams: { apuntamientoId: a.Id } });
  }

  // Histórico de TODA esta aplicación (con sus propios botones de nodo para
  // filtrar ahí mismo — ver apuntamientos-historico-list.component.ts).
  // Distinto de verHistorico() de arriba, que filtra a UN solo apuntamiento.
  verHistoricoAplicacion(): void {
    this.router.navigate(['/apuntamientos-historico'], { queryParams: { aplicacionId: this.aplicacionId } });
  }

  // ============================================================
  // "Nuevo apuntamiento" / "Editar apuntamiento" (Acción 1)
  // ============================================================
  abrirFormulario(): void {
    if (!this.puedeEditar) return;
    this.editando = null;
    this.editandoServidorLabel = null;
    this.form = formularioVacio();
    // Precarga la aplicación actual (y el nodo activo, si hay uno elegido)
    // ya que se está creando desde el detalle de esa aplicación.
    this.form.AplicacionId = this.aplicacionId;
    if (typeof this.nodoSeleccionado === 'number') {
      this.form.ServidorId = this.nodoSeleccionado;
    }
    this.actualizarListasFormulario();
    this.mostrarForm = true;
  }

  editar(a: Apuntamiento): void {
    if (!this.puedeEditar) return;
    this.editando = a;
    this.editandoServidorLabel = a.ServidorHostname ? `${a.ServidorHostname} (${a.ServidorIP})` : null;
    // Categoria/ServicioInventarioId/Observaciones/FechaActualizacion se
    // precargan solo como referencia (no se muestran ni se envían al editar
    // — ver guardar() y la nota de FormularioApuntamiento).
    this.form = {
      AplicacionId: a.AplicacionId,
      ServidorId: a.ServidorId,
      Componente: a.Componente || '',
      SinApuntamiento: !!a.SinApuntamiento,
      Categoria: a.Categoria || '',
      ServicioInventarioId: a.ServicioInventarioId,
      Observaciones: a.Observaciones || '',
      FechaActualizacion: this.aFechaInputLocal(a.FechaActualizacion),
    };
    this.actualizarListasFormulario();
    this.mostrarForm = true;
  }

  cerrarFormulario(): void {
    this.mostrarForm = false;
    this.editando = null;
    this.editandoServidorLabel = null;
  }

  guardar(): void {
    if (!this.puedeEditar || this.guardando) return;

    if (!this.form.AplicacionId) {
      alert('Debes seleccionar la aplicación');
      return;
    }

    // ------------------------------------------------------------
    // Editar un apuntamiento que ya existe (Acción 1, PUT /:id): solo
    // corrige datos ESTRUCTURALES. Categoría, Servicio, Observaciones y la
    // fecha de última actualización NO se tocan aquí — para eso está
    // "Registrar cambio" (guardarCambio() más abajo), que además sí deja
    // constancia en el histórico.
    // ------------------------------------------------------------
    if (this.editando) {
      const payload: Partial<Apuntamiento> = {
        AplicacionId: this.form.AplicacionId,
        ServidorId: this.form.ServidorId,
        Componente: this.form.Componente.trim() || undefined,
        SinApuntamiento: this.form.SinApuntamiento,
      };

      this.guardando = true;
      this.apuntamientoService.actualizar(this.editando.Id, payload).subscribe({
        next: (resultado) => {
          this.guardando = false;
          const idx = this.apuntamientos.findIndex((x) => x.Id === resultado.Id);
          if (idx !== -1) this.apuntamientos[idx] = resultado;
          this.apuntamientosCambiaron();
          this.cerrarFormulario();
        },
        error: (err) => {
          this.guardando = false;
          console.error('Error al actualizar el apuntamiento:', err);
          alert(err?.error?.error || 'No se pudo guardar el apuntamiento. Intenta de nuevo.');
        },
      });
      return;
    }

    // ------------------------------------------------------------
    // Crear un apuntamiento nuevo: sigue necesitando los datos completos de
    // una vez (o "sin apuntamiento a servicios", o categoría + servicio).
    // ------------------------------------------------------------
    if (!this.form.SinApuntamiento) {
      if (!this.form.Categoria) {
        alert('Selecciona la categoría del apuntamiento (ACE o Bus de Integración 10), o marca que no tiene apuntamientos a servicios');
        return;
      }
      if (!this.form.ServicioInventarioId) {
        alert('Selecciona el servicio al que apunta, o marca que no tiene apuntamientos a servicios');
        return;
      }
    }

    const payload: Partial<Apuntamiento> = {
      AplicacionId: this.form.AplicacionId,
      ServidorId: this.form.ServidorId,
      Componente: this.form.Componente.trim() || undefined,
      SinApuntamiento: this.form.SinApuntamiento,
      Categoria: this.form.SinApuntamiento ? null : (this.form.Categoria as CategoriaApuntamiento),
      ServicioInventarioId: this.form.SinApuntamiento ? null : this.form.ServicioInventarioId,
      Observaciones: this.form.Observaciones.trim() || undefined,
      FechaActualizacion: this.aFechaMysql(this.form.FechaActualizacion),
    };

    this.guardando = true;
    this.apuntamientoService.crear(payload).subscribe({
      next: (resultado) => {
        this.guardando = false;
        this.apuntamientos.push(resultado);
        this.apuntamientosCambiaron();
        this.cerrarFormulario();
      },
      error: (err) => {
        this.guardando = false;
        console.error('Error al crear el apuntamiento:', err);
        alert(err?.error?.error || 'No se pudo guardar el apuntamiento. Intenta de nuevo.');
      },
    });
  }

  eliminar(a: Apuntamiento): void {
    if (!this.puedeEditar) return;
    const etiqueta = [a.AplicacionNombre, a.ServidorHostname, a.Componente].filter((p) => !!p).join(' / ');
    if (!confirm(`¿Eliminar el apuntamiento de "${etiqueta}"? Esta acción no se puede deshacer.`)) return;

    this.apuntamientoService.eliminar(a.Id).subscribe({
      next: () => {
        this.apuntamientos = this.apuntamientos.filter((x) => x.Id !== a.Id);
        this.apuntamientosCambiaron();
      },
      error: (err) => {
        console.error('Error al eliminar el apuntamiento:', err);
        alert(err?.error?.error || 'No se pudo eliminar el apuntamiento. Intenta de nuevo.');
      },
    });
  }

  // ============================================================
  // "Registrar cambio" (Acción 2: ajuste, mantenimiento o mejora)
  // ============================================================
  abrirFormularioCambio(a: Apuntamiento): void {
    if (!this.puedeEditar) return;
    if (a.SinApuntamiento) {
      alert('Este apuntamiento está marcado como "sin apuntamiento a servicios". Edítalo primero (Editar apuntamiento) para quitar esa marca antes de registrar un cambio de categoría/servicio.');
      return;
    }

    this.apuntamientoCambio = a;
    this.formCambio = {
      // Se precargan la categoría/servicio actuales como punto de partida —
      // si el usuario no los toca, "Registrar cambio" simplemente deja
      // constancia de un ajuste sin cambiar a qué apunta.
      Categoria: a.Categoria || '',
      ServicioInventarioId: a.ServicioInventarioId,
      Observaciones: '',
      TrandId: '',
      Error: '',
      Imagen: null,
      FechaActualizacion: '',
    };
    this.imagenNombreArchivo = null;
    this.imagenErrorCliente = null;

    // Evita apilar los dos modales si se abre desde el pie de "Editar
    // apuntamiento".
    this.mostrarForm = false;
    this.mostrarFormCambio = true;
  }

  cerrarFormularioCambio(): void {
    this.mostrarFormCambio = false;
    this.apuntamientoCambio = null;
    this.imagenNombreArchivo = null;
    this.imagenErrorCliente = null;
  }

  // Lee el archivo elegido y lo convierte a data URI base64 (ver
  // migracion_apuntamientos_ajustes.sql — así se guarda: no hay servidor de
  // archivos en este proyecto). Valida tipo y tamaño en el cliente; el
  // backend vuelve a validar ambas cosas, nunca hay que confiar solo aquí.
  onArchivoImagenSeleccionado(event: Event): void {
    const input = event.target as HTMLInputElement;
    const archivo = input.files && input.files[0];
    if (!archivo) return;

    this.imagenErrorCliente = null;

    if (!this.TIPOS_IMAGEN_PERMITIDOS.includes(archivo.type)) {
      this.imagenErrorCliente = 'La imagen debe ser un archivo PNG, JPG, GIF o WEBP.';
      input.value = '';
      return;
    }
    if (archivo.size > this.MAX_IMAGEN_BYTES) {
      this.imagenErrorCliente = 'La imagen es muy grande (máximo ~2 MB).';
      input.value = '';
      return;
    }

    const lector = new FileReader();
    lector.onload = () => {
      this.formCambio.Imagen = lector.result as string;
      this.imagenNombreArchivo = archivo.name;
    };
    lector.onerror = () => {
      this.imagenErrorCliente = 'No se pudo leer el archivo de imagen. Intenta de nuevo.';
    };
    lector.readAsDataURL(archivo);
  }

  quitarImagen(inputArchivo: HTMLInputElement): void {
    this.formCambio.Imagen = null;
    this.imagenNombreArchivo = null;
    this.imagenErrorCliente = null;
    inputArchivo.value = '';
  }

  guardarCambio(): void {
    if (!this.puedeEditar || this.guardandoCambio || !this.apuntamientoCambio) return;

    if (!this.formCambio.Categoria) {
      alert('Selecciona la categoría (ACE o Bus de Integración 10)');
      return;
    }
    if (!this.formCambio.ServicioInventarioId) {
      alert('Selecciona el servicio al que apunta');
      return;
    }

    const payload: RegistrarCambioApuntamientoPayload = {
      Categoria: this.formCambio.Categoria as CategoriaApuntamiento,
      ServicioInventarioId: this.formCambio.ServicioInventarioId,
      Observaciones: this.formCambio.Observaciones.trim() || undefined,
      TrandId: this.formCambio.TrandId.trim() || undefined,
      Error: this.formCambio.Error.trim() || undefined,
      Imagen: this.formCambio.Imagen || undefined,
      FechaActualizacion: this.aFechaMysql(this.formCambio.FechaActualizacion),
    };

    this.guardandoCambio = true;
    this.apuntamientoService.registrarCambio(this.apuntamientoCambio.Id, payload).subscribe({
      next: (resultado) => {
        this.guardandoCambio = false;
        const idx = this.apuntamientos.findIndex((x) => x.Id === resultado.Id);
        if (idx !== -1) this.apuntamientos[idx] = resultado;
        this.apuntamientosCambiaron();
        this.cerrarFormularioCambio();
      },
      error: (err) => {
        this.guardandoCambio = false;
        console.error('Error al registrar el cambio del apuntamiento:', err);
        alert(err?.error?.error || 'No se pudo registrar el cambio. Intenta de nuevo.');
      },
    });
  }
}
