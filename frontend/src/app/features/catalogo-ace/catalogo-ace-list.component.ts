import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AceCatalogoService } from '../../core/services/ace-catalogo.service';
import { AceServicio, AceOperacion } from '../../core/models/models';
import { AuthService } from '../../services/auth.service';
import { descargarCsv, fechaParaArchivo } from '../../core/utils/exportar-csv';
import { compararAce, OrdenAce, OPCIONES_ORDEN_ACE } from '../../core/utils/ordenar-codigo-ace';

// Un Servicio del catálogo ACE, con el estado de expansión propio de la
// vista (no viene del backend).
interface NodoServicio extends AceServicio {
  expandido: boolean;
}

interface FormularioServicio {
  Codigo: string;
  Nombre: string;
}

interface FormularioOperacion {
  CodigoOperacion: string;
  Operacion: string;
  OperacionBackend: string;
  Descripcion: string;
  Arquitectura: string;
  Version: string;
  Instancias: number | null;
  Compuestos: number | null;
  Atomicos: number | null;
  Sincrono: boolean;
  Asincrono: boolean;
}

function formularioOperacionVacio(): FormularioOperacion {
  return {
    CodigoOperacion: '',
    Operacion: '',
    OperacionBackend: '',
    Descripcion: '',
    Arquitectura: '',
    Version: '',
    Instancias: null,
    Compuestos: null,
    Atomicos: null,
    Sincrono: false,
    Asincrono: false,
  };
}

@Component({
  selector: 'app-catalogo-ace-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './catalogo-ace-list.component.html',
  styleUrl: './catalogo-ace-list.component.scss',
})
export class CatalogoAceListComponent implements OnInit {
  cargando = true;
  nodos: NodoServicio[] = [];
  terminoBusqueda = '';

  detalle: { servicio: NodoServicio; operacion: AceOperacion } | null = null;

  // Solo ADMIN_POD/ADMIN_MIN pueden crear/editar/borrar. BASIC = solo lectura.
  puedeEditar = false;

  // --- Formulario de Servicio ---
  mostrarFormServicio = false;
  editandoServicio: NodoServicio | null = null;
  formServicio: FormularioServicio = { Codigo: '', Nombre: '' };
  guardandoServicio = false;

  // --- Formulario de Operación ---
  mostrarFormOperacion = false;
  editandoOperacion: AceOperacion | null = null;
  servicioDeOperacion: NodoServicio | null = null;
  formOperacion: FormularioOperacion = formularioOperacionVacio();
  guardandoOperacion = false;

  constructor(
    private aceCatalogoService: AceCatalogoService,
    private authService: AuthService,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('SERVICIOS');

    this.cargar();
  }

  cargar(): void {
    this.cargando = true;
    this.aceCatalogoService.listar().subscribe({
      next: (servicios) => {
        this.nodos = servicios.map((s) => ({ ...s, expandido: false }));
        this.ordenarNodos();
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al cargar el catálogo ACE:', err);
        this.cargando = false;
      },
    });
  }

  // Orden elegido por el usuario (por defecto, código de menor a mayor).
  readonly opcionesOrden = OPCIONES_ORDEN_ACE;
  orden: OrdenAce = 'codigo-asc';

  ordenarNodos(): void {
    this.nodos.sort((a, b) => compararAce(this.orden, a, b));
  }

  get nodosFiltrados(): NodoServicio[] {
    if (!this.terminoBusqueda) return this.nodos;
    const termino = this.terminoBusqueda.toLowerCase().trim();
    return this.nodos.filter((n) => {
      const texto = JSON.stringify(n).toLowerCase();
      return texto.includes(termino);
    });
  }

  // Exporta a CSV lo que se está viendo (búsqueda y orden actuales): una fila
  // por operación, repitiendo el servicio; un servicio sin operaciones sale en
  // una sola fila con las columnas de operación vacías.
  exportar(): void {
    const filas: unknown[][] = [];
    for (const n of this.nodosFiltrados) {
      const ops = n.Operaciones || [];
      if (!ops.length) {
        filas.push([n.Codigo, n.Nombre, '', '', '', '', '', '', '', '', '', '', '', '']);
        continue;
      }
      for (const o of ops) {
        filas.push([
          n.Codigo, n.Nombre, o.CodigoOperacion, o.Operacion, o.OperacionBackend, o.Descripcion,
          o.DescripcionExcel, o.Arquitectura, o.Version, o.Instancias, o.Compuestos, o.Atomicos,
          o.Sincrono, o.Asincrono,
        ]);
      }
    }
    descargarCsv(
      `catalogo_ace_${fechaParaArchivo()}.csv`,
      ['Código servicio', 'Servicio', 'Código operación', 'Operación', 'Operación backend', 'Descripción',
       'Descripción Excel', 'Arquitectura', 'Versión', 'Instancias', 'Compuestos', 'Atómicos', 'Síncrono', 'Asíncrono'],
      filas,
    );
  }

  toggleServicio(n: NodoServicio): void {
    n.expandido = !n.expandido;
  }

  expandirTodo(): void {
    this.nodos.forEach((n) => (n.expandido = true));
  }

  colapsarTodo(): void {
    this.nodos.forEach((n) => (n.expandido = false));
  }

  abrirDetalleOperacion(servicio: NodoServicio, operacion: AceOperacion): void {
    this.detalle = { servicio, operacion };
  }

  cerrarDetalle(): void {
    this.detalle = null;
  }

  totalOperaciones(n: NodoServicio): number {
    return n.Operaciones?.length || 0;
  }

  // ============================================================
  // CRUD — SERVICIOS
  // ============================================================
  abrirFormularioServicio(): void {
    if (!this.puedeEditar) return;
    this.editandoServicio = null;
    this.formServicio = { Codigo: '', Nombre: '' };
    this.mostrarFormServicio = true;
  }

  editarServicio(n: NodoServicio, evento: Event): void {
    evento.stopPropagation();
    if (!this.puedeEditar) return;
    this.editandoServicio = n;
    this.formServicio = { Codigo: n.Codigo || '', Nombre: n.Nombre || '' };
    this.mostrarFormServicio = true;
  }

  cerrarFormularioServicio(): void {
    this.mostrarFormServicio = false;
    this.editandoServicio = null;
  }

  guardarServicio(): void {
    if (!this.puedeEditar || this.guardandoServicio) return;

    if (!this.formServicio.Nombre || !this.formServicio.Nombre.trim()) {
      alert('El nombre del servicio es obligatorio');
      return;
    }

    const payload: Partial<AceServicio> = {
      Codigo: this.formServicio.Codigo.trim() || undefined,
      Nombre: this.formServicio.Nombre.trim(),
    };

    this.guardandoServicio = true;
    const accion = this.editandoServicio
      ? this.aceCatalogoService.actualizarServicio(this.editandoServicio.Id, payload)
      : this.aceCatalogoService.crearServicio(payload);

    accion.subscribe({
      next: (servicio) => {
        this.guardandoServicio = false;
        if (this.editandoServicio) {
          const nodo = this.nodos.find((n) => n.Id === this.editandoServicio!.Id);
          if (nodo) {
            nodo.Codigo = servicio.Codigo;
            nodo.Nombre = servicio.Nombre;
          }
          this.ordenarNodos();
        } else {
          this.nodos.push({ ...servicio, Operaciones: servicio.Operaciones || [], expandido: false });
          this.ordenarNodos();
        }
        this.cerrarFormularioServicio();
      },
      error: (err) => {
        this.guardandoServicio = false;
        console.error('Error al guardar el servicio ACE:', err);
        alert(err?.error?.error || 'No se pudo guardar el servicio. Intenta de nuevo.');
      },
    });
  }

  eliminarServicio(n: NodoServicio, evento: Event): void {
    evento.stopPropagation();
    if (!this.puedeEditar) return;
    if (!confirm(`¿Eliminar el servicio "${n.Nombre}" y todas sus operaciones? Esta acción no se puede deshacer.`)) return;

    this.aceCatalogoService.eliminarServicio(n.Id).subscribe({
      next: () => {
        this.nodos = this.nodos.filter((x) => x.Id !== n.Id);
        if (this.detalle?.servicio.Id === n.Id) this.detalle = null;
      },
      error: (err) => {
        console.error('Error al eliminar el servicio ACE:', err);
        alert(err?.error?.error || 'No se pudo eliminar el servicio. Intenta de nuevo.');
      },
    });
  }

  // ============================================================
  // CRUD — OPERACIONES
  // ============================================================
  abrirFormularioOperacion(n: NodoServicio): void {
    if (!this.puedeEditar) return;
    this.editandoOperacion = null;
    this.servicioDeOperacion = n;
    this.formOperacion = formularioOperacionVacio();
    this.mostrarFormOperacion = true;
  }

  editarOperacion(n: NodoServicio, op: AceOperacion, evento: Event): void {
    evento.stopPropagation();
    if (!this.puedeEditar) return;
    this.editandoOperacion = op;
    this.servicioDeOperacion = n;
    this.formOperacion = {
      CodigoOperacion: op.CodigoOperacion || '',
      Operacion: op.Operacion || '',
      OperacionBackend: op.OperacionBackend || '',
      Descripcion: op.Descripcion || '',
      Arquitectura: op.Arquitectura || '',
      Version: op.Version || '',
      Instancias: op.Instancias,
      Compuestos: op.Compuestos,
      Atomicos: op.Atomicos,
      Sincrono: !!op.Sincrono,
      Asincrono: !!op.Asincrono,
    };
    this.mostrarFormOperacion = true;
  }

  cerrarFormularioOperacion(): void {
    this.mostrarFormOperacion = false;
    this.editandoOperacion = null;
    this.servicioDeOperacion = null;
  }

  guardarOperacion(): void {
    if (!this.puedeEditar || this.guardandoOperacion || !this.servicioDeOperacion) return;

    if (!this.formOperacion.Operacion || !this.formOperacion.Operacion.trim()) {
      alert('El nombre de la operación es obligatorio');
      return;
    }

    const payload: Partial<AceOperacion> & { ServicioId?: number } = {
      CodigoOperacion: this.formOperacion.CodigoOperacion.trim() || undefined,
      Operacion: this.formOperacion.Operacion.trim(),
      OperacionBackend: this.formOperacion.OperacionBackend.trim() || undefined,
      Descripcion: this.formOperacion.Descripcion.trim() || undefined,
      Arquitectura: this.formOperacion.Arquitectura.trim() || undefined,
      Version: this.formOperacion.Version.trim() || undefined,
      Instancias: this.formOperacion.Instancias,
      Compuestos: this.formOperacion.Compuestos,
      Atomicos: this.formOperacion.Atomicos,
      Sincrono: this.formOperacion.Sincrono,
      Asincrono: this.formOperacion.Asincrono,
    };

    const servicioId = this.servicioDeOperacion.Id;
    this.guardandoOperacion = true;

    const accion = this.editandoOperacion
      ? this.aceCatalogoService.actualizarOperacion(this.editandoOperacion.Id, payload)
      : this.aceCatalogoService.crearOperacion({ ...payload, ServicioId: servicioId });

    accion.subscribe({
      next: (operacion) => {
        this.guardandoOperacion = false;
        const nodo = this.nodos.find((n) => n.Id === servicioId);
        if (nodo) {
          if (!nodo.Operaciones) nodo.Operaciones = [];
          if (this.editandoOperacion) {
            const idx = nodo.Operaciones.findIndex((o) => o.Id === operacion.Id);
            if (idx !== -1) nodo.Operaciones[idx] = operacion;
            if (this.detalle?.operacion.Id === operacion.Id) this.detalle = { servicio: nodo, operacion };
          } else {
            nodo.Operaciones.push(operacion);
          }
        }
        this.cerrarFormularioOperacion();
      },
      error: (err) => {
        this.guardandoOperacion = false;
        console.error('Error al guardar la operación ACE:', err);
        alert(err?.error?.error || 'No se pudo guardar la operación. Intenta de nuevo.');
      },
    });
  }

  eliminarOperacion(n: NodoServicio, op: AceOperacion, evento: Event): void {
    evento.stopPropagation();
    if (!this.puedeEditar) return;
    if (!confirm(`¿Eliminar la operación "${op.Operacion || op.CodigoOperacion}"? Esta acción no se puede deshacer.`)) return;

    this.aceCatalogoService.eliminarOperacion(op.Id).subscribe({
      next: () => {
        const nodo = this.nodos.find((x) => x.Id === n.Id);
        if (nodo && nodo.Operaciones) {
          nodo.Operaciones = nodo.Operaciones.filter((o) => o.Id !== op.Id);
        }
        if (this.detalle?.operacion.Id === op.Id) this.detalle = null;
      },
      error: (err) => {
        console.error('Error al eliminar la operación ACE:', err);
        alert(err?.error?.error || 'No se pudo eliminar la operación. Intenta de nuevo.');
      },
    });
  }
}
