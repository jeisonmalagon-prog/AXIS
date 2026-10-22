import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApuntamientoHistoricoService } from '../../core/services/apuntamiento-historico.service';
import { ApuntamientoHistorico, CategoriaApuntamiento } from '../../core/models/models';

// Un "nodo" agrupa las filas del histórico de una aplicación por servidor
// (o, cuando el servidor es null, las que no tienen uno asignado). Mismo
// concepto que en bitacora-apuntamientos-aplicacion.component.ts: distintos
// nodos de una misma aplicación pueden tener cambios muy distintos entre
// sí, así que hace falta poder verlos por separado.
interface NodoTab {
  id: number | 'sin-servidor';
  etiqueta: string;
  cantidad: number;
}

// Comparación de nodos: una fila por servicio y una celda por nodo con lo
// que se ha registrado de ese servicio en ese nodo (cuántos cambios y el
// último). Sirve para ver en qué nodos se aplicó un cambio y en cuáles no.
interface CeldaComparacionHist {
  cantidad: number;
  ultima: ApuntamientoHistorico | null;
}

interface FilaComparacionHist {
  clave: string;
  etiqueta: string;
  celdas: CeldaComparacionHist[];
  faltan: number; // nodos donde este servicio NO tiene ningún registro
}

interface ResultadoComparacionHist {
  nodos: NodoTab[];
  filas: FilaComparacionHist[];
  completas: number;
  parciales: number;
}

// Tarjeta de la vista de aterrizaje (sin filtros): una por Aplicación con
// al menos un cambio en el histórico. Mismo patrón que
// bitacora-apuntamientos-list.component.ts — evita mezclar el histórico de
// TODAS las aplicaciones en una sola línea de tiempo larguísima; se elige
// primero la aplicación y ahí adentro el nodo.
interface AplicacionResumenHistorico {
  aplicacionId: number;
  aplicacionNombre: string;
  total: number;
  ultimoCambio: string | null;
  nodos: NodoTab[];
}

// Pantalla dedicada al histórico de cambios de la Bitácora de Apuntamientos
// (ver migracion_apuntamientos_historico.sql). Vive separada del formulario
// de edición a propósito: mostrar la línea de tiempo completa ahí adentro
// recargaba/saturaba ese modal. Se puede llegar aquí de tres formas:
//   - sin parámetros — vista de aterrizaje: una tarjeta por Aplicación (ver
//     gruposAplicacion más abajo), igual que la Bitácora de Apuntamientos.
//   - ?aplicacionId=X — filtrado a TODA una aplicación, con botones para
//     elegir el nodo (al entrar a una tarjeta de arriba, o desde "Ver
//     histórico" en su detalle — ver bitacora-apuntamientos-aplicacion.component.ts).
//   - ?apuntamientoId=X — filtrado a UN apuntamiento en particular (desde el
//     ícono de reloj en la Bitácora).
@Component({
  selector: 'app-apuntamientos-historico-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './apuntamientos-historico-list.component.html',
  styleUrl: './apuntamientos-historico-list.component.scss',
})
export class ApuntamientosHistoricoListComponent implements OnInit {
  cargando = true;
  historico: ApuntamientoHistorico[] = [];
  terminoBusqueda = '';

  apuntamientoIdFiltrado: number | null = null;
  aplicacionIdFiltrado: number | null = null;
  etiquetaFiltro: string | null = null;

  // Solo tiene sentido cuando aplicacionIdFiltrado está activo: un número =
  // ServidorIdNuevo específico; 'sin-servidor' = filas sin servidor asignado;
  // 'comparar' = matriz que cruza los nodos; null = aún sin elegir (se elige
  // el primer nodo al cargar). Ya no existe la vista "Todos los nodos".
  nodoSeleccionado: number | 'sin-servidor' | 'comparar' | null = null;
  soloDiferencias = true;
  private nodosCache: NodoTab[] | null = null;
  private comparacionCache: ResultadoComparacionHist | null = null;

  // Modal de "Ver detalle": el cuadro completo de una fila del histórico
  // (comparación anterior/nuevo de TODOS los campos, no solo los que
  // cambiaron, más Observaciones/TRANDID/Error/Imagen). La imagen se pide a
  // demanda con ApuntamientoHistoricoService.imagen() al abrir el detalle
  // (ver migracion_apuntamientos_ajustes.sql — nunca viaja en el listado).
  detalle: ApuntamientoHistorico | null = null;
  imagenDetalle: string | null = null;
  cargandoImagenDetalle = false;
  errorImagenDetalle: string | null = null;

  constructor(
    private historicoService: ApuntamientoHistoricoService,
    private route: ActivatedRoute,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.route.queryParamMap.subscribe((params) => {
      const idParam = params.get('apuntamientoId');
      const aplicacionParam = params.get('aplicacionId');
      this.apuntamientoIdFiltrado = idParam ? Number(idParam) : null;
      // apuntamientoId manda si vienen los dos a la vez (no debería pasar en
      // la práctica, pero evita un estado ambiguo).
      this.aplicacionIdFiltrado = !idParam && aplicacionParam ? Number(aplicacionParam) : null;
      this.nodoSeleccionado = null;
      this.cargar();
    });
  }

  cargar(): void {
    this.cargando = true;
    // El filtro por aplicación (y por nodo) se hace en el cliente, igual que
    // en bitacora-apuntamientos-aplicacion.component.ts — no hay un
    // endpoint dedicado en el backend para eso, así que se trae el
    // histórico completo y se filtra acá.
    const fuente = this.apuntamientoIdFiltrado
      ? this.historicoService.porApuntamiento(this.apuntamientoIdFiltrado)
      : this.historicoService.listar();

    fuente.subscribe({
      next: (filas) => {
        this.historico = filas;
        this.historicoCambio();
        this.etiquetaFiltro = this.calcularEtiquetaFiltro();
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al cargar el histórico de apuntamientos:', err);
        this.cargando = false;
      },
    });
  }

  private calcularEtiquetaFiltro(): string | null {
    if (this.apuntamientoIdFiltrado) {
      return this.historico.length ? this.etiquetaApuntamiento(this.historico[0]) : null;
    }
    if (this.aplicacionIdFiltrado) {
      const fila = this.historico.find((h) => h.AplicacionIdNuevo === this.aplicacionIdFiltrado);
      return fila?.AplicacionNuevoNombre || `Aplicación #${this.aplicacionIdFiltrado}`;
    }
    return null;
  }

  quitarFiltro(): void {
    this.apuntamientoIdFiltrado = null;
    this.aplicacionIdFiltrado = null;
    this.nodoSeleccionado = null;
    this.etiquetaFiltro = null;
    this.cargar();
  }

  // Todas las filas de ESTA aplicación (sin filtrar por nodo ni búsqueda
  // todavía) — cuando no hay aplicacionIdFiltrado, es simplemente
  // this.historico tal cual llegó (ya filtrado por apuntamiento, o completo).
  get historicoDeAplicacion(): ApuntamientoHistorico[] {
    if (!this.aplicacionIdFiltrado) return this.historico;
    return this.historico.filter((h) => h.AplicacionIdNuevo === this.aplicacionIdFiltrado);
  }

  // Nombre con el que se muestra un nodo: hostname (IP); si el servidor no
  // trae hostname se usa la IP, luego el componente y por último el id.
  private etiquetaNodoDe(h: ApuntamientoHistorico): string {
    if (h.ServidorIdNuevo == null) return 'Sin servidor específico';
    if (h.ServidorNuevoHostname) return h.ServidorNuevoIP ? `${h.ServidorNuevoHostname} (${h.ServidorNuevoIP})` : h.ServidorNuevoHostname;
    if (h.ServidorNuevoIP) return h.ServidorNuevoIP;
    return h.ComponenteNuevo || `Nodo #${h.ServidorIdNuevo}`;
  }

  // Cada vez que cambia this.historico hay que descartar lo calculado.
  private historicoCambio(): void {
    this.nodosCache = null;
    this.comparacionCache = null;
    const lista = this.nodos;
    if (!this.aplicacionIdFiltrado || this.apuntamientoIdFiltrado) return;
    const actual = this.nodoSeleccionado;
    const existe = actual === 'comparar' ? lista.length > 1 : lista.some((n) => n.id === actual);
    if (!existe) this.nodoSeleccionado = lista.length ? lista[0].id : null;
  }

  // Botones de nodo: uno por cada servidor (o el grupo "sin servidor
  // específico") que tenga al menos una fila de histórico en esta
  // aplicación. Vacío cuando no se está filtrando por aplicación. Se
  // memoiza: devolver objetos nuevos en cada detección de cambios recrearía
  // los botones y un clic podía perderse.
  get nodos(): NodoTab[] {
    if (!this.aplicacionIdFiltrado) return [];
    if (this.nodosCache) return this.nodosCache;
    const mapa = new Map<string, NodoTab>();
    for (const h of this.historicoDeAplicacion) {
      const clave = h.ServidorIdNuevo != null ? String(h.ServidorIdNuevo) : 'sin-servidor';
      let nodo = mapa.get(clave);
      if (!nodo) {
        nodo = {
          id: h.ServidorIdNuevo != null ? h.ServidorIdNuevo : 'sin-servidor',
          etiqueta: this.etiquetaNodoDe(h),
          cantidad: 0,
        };
        mapa.set(clave, nodo);
      }
      nodo.cantidad++;
    }
    this.nodosCache = Array.from(mapa.values()).sort((a, b) => a.etiqueta.localeCompare(b.etiqueta));
    return this.nodosCache;
  }

  trackNodo(_i: number, n: NodoTab): number | string {
    return n.id;
  }

  trackFila(_i: number, f: FilaComparacionHist): string {
    return f.clave;
  }

  seleccionarNodo(id: number | 'sin-servidor' | 'comparar'): void {
    this.nodoSeleccionado = id;
  }

  get comparando(): boolean {
    return this.nodoSeleccionado === 'comparar';
  }

  get historicoFiltrado(): ApuntamientoHistorico[] {
    if (this.comparando) return [];
    let lista = this.historicoDeAplicacion;

    if (this.aplicacionIdFiltrado && !this.apuntamientoIdFiltrado && this.nodoSeleccionado != null) {
      lista = this.nodoSeleccionado === 'sin-servidor'
        ? lista.filter((h) => h.ServidorIdNuevo == null)
        : lista.filter((h) => h.ServidorIdNuevo === this.nodoSeleccionado);
    }

    if (!this.terminoBusqueda) return lista;
    const termino = this.terminoBusqueda.toLowerCase().trim();
    return lista.filter((h) => JSON.stringify(h).toLowerCase().includes(termino));
  }

  // Cruce servicio x nodo del histórico de la aplicación.
  get comparacion(): ResultadoComparacionHist {
    if (this.comparacionCache) return this.comparacionCache;
    const nodos = this.nodos;
    const indice = new Map<string, number>(nodos.map((n, i) => [String(n.id), i]));
    const filas = new Map<string, FilaComparacionHist>();
    const instante = (h: ApuntamientoHistorico) => new Date(h.FechaActualizacionDeclarada || h.FechaCambio).getTime() || 0;

    for (const h of this.historicoDeAplicacion) {
      const col = indice.get(h.ServidorIdNuevo != null ? String(h.ServidorIdNuevo) : 'sin-servidor');
      if (col == null) continue;
      const servicioId = h.ServicioInventarioIdNuevo ?? h.ServicioInventarioIdAnterior;
      const codigo = h.ServicioNuevoCodigo || h.ServicioAnteriorCodigo;
      const nombre = h.ServicioNuevoNombre || h.ServicioAnteriorNombre;
      const clave = servicioId != null ? `s${servicioId}` : 'sin-servicio';
      let fila = filas.get(clave);
      if (!fila) {
        fila = {
          clave,
          etiqueta: codigo ? `${codigo}${nombre ? ' — ' + nombre : ''}` : 'Sin servicio asociado',
          celdas: nodos.map(() => ({ cantidad: 0, ultima: null })),
          faltan: 0,
        };
        filas.set(clave, fila);
      }
      const celda = fila.celdas[col];
      celda.cantidad++;
      if (!celda.ultima || instante(h) > instante(celda.ultima)) celda.ultima = h;
    }

    const lista = Array.from(filas.values());
    for (const f of lista) f.faltan = f.celdas.filter((c) => !c.cantidad).length;
    lista.sort((a, b) => (b.faltan > 0 ? 1 : 0) - (a.faltan > 0 ? 1 : 0) || a.etiqueta.localeCompare(b.etiqueta, 'es', { numeric: true }));

    this.comparacionCache = {
      nodos,
      filas: lista,
      completas: lista.filter((f) => f.faltan === 0).length,
      parciales: lista.filter((f) => f.faltan > 0).length,
    };
    return this.comparacionCache;
  }

  get filasComparacionVisibles(): FilaComparacionHist[] {
    const c = this.comparacion;
    const q = this.terminoBusqueda.toLowerCase().trim();
    return c.filas.filter((f) => (!this.soloDiferencias || f.faltan > 0) && (!q || f.etiqueta.toLowerCase().includes(q)));
  }

  // ============================================================
  // Vista de aterrizaje (sin filtros): una tarjeta por Aplicación, con sus
  // nodos y cuántos cambios tiene cada uno — igual que en la Bitácora de
  // Apuntamientos. Solo tiene sentido calcularlo cuando no hay ningún
  // filtro activo (this.historico trae TODO el histórico en ese caso).
  // ============================================================
  get gruposAplicacion(): AplicacionResumenHistorico[] {
    const mapa = new Map<number, AplicacionResumenHistorico>();
    const nodosPorApp = new Map<number, Map<string, NodoTab>>();

    for (const h of this.historico) {
      const aplicacionId = h.AplicacionIdNuevo;
      if (aplicacionId == null) continue;

      let resumen = mapa.get(aplicacionId);
      if (!resumen) {
        resumen = {
          aplicacionId,
          aplicacionNombre: h.AplicacionNuevoNombre || `Aplicación #${aplicacionId}`,
          total: 0,
          ultimoCambio: null,
          nodos: [],
        };
        mapa.set(aplicacionId, resumen);
      }

      resumen.total++;
      const fecha = h.FechaActualizacionDeclarada || h.FechaCambio;
      if (fecha && (!resumen.ultimoCambio || new Date(fecha) > new Date(resumen.ultimoCambio))) {
        resumen.ultimoCambio = fecha;
      }

      let nodos = nodosPorApp.get(aplicacionId);
      if (!nodos) {
        nodos = new Map<string, NodoTab>();
        nodosPorApp.set(aplicacionId, nodos);
      }
      const clave = h.ServidorIdNuevo != null ? String(h.ServidorIdNuevo) : 'sin-servidor';
      let nodo = nodos.get(clave);
      if (!nodo) {
        nodo = {
          id: h.ServidorIdNuevo != null ? h.ServidorIdNuevo : 'sin-servidor',
          etiqueta: this.etiquetaNodoDe(h),
          cantidad: 0,
        };
        nodos.set(clave, nodo);
      }
      nodo.cantidad++;
    }

    for (const [aplicacionId, resumen] of mapa) {
      const nodos = nodosPorApp.get(aplicacionId);
      resumen.nodos = nodos ? Array.from(nodos.values()).sort((a, b) => a.etiqueta.localeCompare(b.etiqueta)) : [];
    }

    return Array.from(mapa.values()).sort((a, b) => a.aplicacionNombre.localeCompare(b.aplicacionNombre));
  }

  get gruposFiltrados(): AplicacionResumenHistorico[] {
    const grupos = this.gruposAplicacion;
    if (!this.terminoBusqueda) return grupos;
    const termino = this.terminoBusqueda.toLowerCase().trim();
    return grupos.filter(
      (g) => g.aplicacionNombre.toLowerCase().includes(termino) || g.nodos.some((n) => n.etiqueta.toLowerCase().includes(termino)),
    );
  }

  // Entra al histórico de UNA aplicación (con sus botones de nodo) — mismo
  // destino al que llega "Ver histórico" desde bitacora-apuntamientos-aplicacion.component.ts.
  abrirAplicacion(g: AplicacionResumenHistorico): void {
    this.router.navigate(['/apuntamientos-historico'], { queryParams: { aplicacionId: g.aplicacionId } });
  }

  // Identifica el apuntamiento de una fila usando su estado más reciente
  // (los campos "Nuevo"), para mostrarlo como encabezado cuando se ve todo
  // el histórico mezclado.
  etiquetaApuntamiento(h: ApuntamientoHistorico): string {
    const partes = [h.AplicacionNuevoNombre, h.ServidorNuevoHostname, h.ComponenteNuevo].filter((p) => !!p);
    return partes.length ? partes.join(' / ') : `Apuntamiento #${h.ApuntamientoId}`;
  }

  etiquetaCategoria(categoria: CategoriaApuntamiento | null): string {
    if (categoria === 'ACE') return 'ACE';
    if (categoria === 'BUS_INTEGRACION_10') return 'Bus de Integración 10';
    return '—';
  }

  // 'AJUSTE' (Registrar cambio) se distingue de 'ACTUALIZACION' (ya no se
  // genera — "Editar apuntamiento" no deja histórico — pero sigue pudiendo
  // aparecer en datos antiguos).
  etiquetaAccion(accion: string): string {
    if (accion === 'ALTA') return 'Creado';
    if (accion === 'AJUSTE') return 'Ajuste';
    return 'Actualizado';
  }

  claseAccion(accion: string): string {
    if (accion === 'ALTA') return 'accion-alta';
    if (accion === 'AJUSTE') return 'accion-ajuste';
    return 'accion-actualizacion';
  }

  // Abre el modal de detalle completo de una fila; si trae imagen, la pide
  // de una vez (así el usuario no tiene que dar un segundo clic para verla).
  verDetalle(h: ApuntamientoHistorico): void {
    this.detalle = h;
    this.imagenDetalle = null;
    this.errorImagenDetalle = null;

    if (h.TieneImagen) {
      this.cargandoImagenDetalle = true;
      this.historicoService.imagen(h.Id).subscribe({
        next: (resp) => {
          this.cargandoImagenDetalle = false;
          this.imagenDetalle = resp.ImagenBase64;
        },
        error: (err) => {
          this.cargandoImagenDetalle = false;
          console.error('Error al obtener la imagen del histórico:', err);
          this.errorImagenDetalle = err?.error?.error || 'No se pudo cargar la imagen.';
        },
      });
    }
  }

  cerrarDetalle(): void {
    this.detalle = null;
    this.imagenDetalle = null;
    this.errorImagenDetalle = null;
  }

  // Todas las filas de comparación para el modal de detalle — a diferencia
  // de describirCambios() (que solo lista lo que cambió, para la vista
  // compacta), esto muestra el cuadro completo: incluye también los campos
  // que NO variaron, para tener todo el contexto de una vez.
  filasDetalle(h: ApuntamientoHistorico): { etiqueta: string; anterior: string; nuevo: string; cambio: boolean }[] {
    const servidorAnterior = h.ServidorAnteriorHostname ? `${h.ServidorAnteriorHostname} (${h.ServidorAnteriorIP})` : '—';
    const servidorNuevo = h.ServidorNuevoHostname ? `${h.ServidorNuevoHostname} (${h.ServidorNuevoIP})` : '—';
    const servicioAnterior = h.ServicioAnteriorCodigo ? `${h.ServicioAnteriorCodigo} — ${h.ServicioAnteriorNombre}` : '—';
    const servicioNuevo = h.ServicioNuevoCodigo ? `${h.ServicioNuevoCodigo} — ${h.ServicioNuevoNombre}` : '—';

    return [
      {
        etiqueta: 'Aplicación',
        anterior: h.AplicacionAnteriorNombre || '—',
        nuevo: h.AplicacionNuevoNombre || '—',
        cambio: h.AplicacionIdAnterior !== h.AplicacionIdNuevo,
      },
      {
        etiqueta: 'Servidor',
        anterior: servidorAnterior,
        nuevo: servidorNuevo,
        cambio: h.ServidorIdAnterior !== h.ServidorIdNuevo,
      },
      {
        etiqueta: 'Componente',
        anterior: h.ComponenteAnterior || '—',
        nuevo: h.ComponenteNuevo || '—',
        cambio: (h.ComponenteAnterior || '') !== (h.ComponenteNuevo || ''),
      },
      {
        etiqueta: 'Sin apuntamiento',
        anterior: h.SinApuntamientoAnterior ? 'Sí' : 'No',
        nuevo: h.SinApuntamientoNuevo ? 'Sí' : 'No',
        cambio: !!h.SinApuntamientoAnterior !== !!h.SinApuntamientoNuevo,
      },
      {
        etiqueta: 'Categoría',
        anterior: this.etiquetaCategoria(h.CategoriaAnterior),
        nuevo: this.etiquetaCategoria(h.CategoriaNueva),
        cambio: h.CategoriaAnterior !== h.CategoriaNueva,
      },
      {
        etiqueta: 'Servicio',
        anterior: servicioAnterior,
        nuevo: servicioNuevo,
        cambio: h.ServicioInventarioIdAnterior !== h.ServicioInventarioIdNuevo,
      },
    ];
  }

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

  // Texto legible de cada fila, ej. "Categoría: ACE → Bus de Integración 10"
  // o "Servicio: C022 — PayInq → C104 — FlexiDigitalAdm". Una línea por cada
  // campo que cambió en esa fila.
  describirCambios(h: ApuntamientoHistorico): string[] {
    if (h.Accion === 'ALTA') return ['Registro creado'];

    const cambios: string[] = [];

    if (h.AplicacionIdAnterior !== h.AplicacionIdNuevo) {
      cambios.push(`Aplicación: ${h.AplicacionAnteriorNombre || '—'} → ${h.AplicacionNuevoNombre || '—'}`);
    }
    if (h.ServidorIdAnterior !== h.ServidorIdNuevo) {
      const anterior = h.ServidorAnteriorHostname ? `${h.ServidorAnteriorHostname} (${h.ServidorAnteriorIP})` : '—';
      const nuevo = h.ServidorNuevoHostname ? `${h.ServidorNuevoHostname} (${h.ServidorNuevoIP})` : '—';
      cambios.push(`Servidor: ${anterior} → ${nuevo}`);
    }
    if ((h.ComponenteAnterior || '') !== (h.ComponenteNuevo || '')) {
      cambios.push(`Componente: ${h.ComponenteAnterior || '—'} → ${h.ComponenteNuevo || '—'}`);
    }
    if (!!h.SinApuntamientoAnterior !== !!h.SinApuntamientoNuevo) {
      cambios.push(`Sin apuntamiento: ${h.SinApuntamientoAnterior ? 'Sí' : 'No'} → ${h.SinApuntamientoNuevo ? 'Sí' : 'No'}`);
    }
    if (h.CategoriaAnterior !== h.CategoriaNueva) {
      cambios.push(`Categoría: ${this.etiquetaCategoria(h.CategoriaAnterior)} → ${this.etiquetaCategoria(h.CategoriaNueva)}`);
    }
    if (h.ServicioInventarioIdAnterior !== h.ServicioInventarioIdNuevo) {
      const anterior = h.ServicioAnteriorCodigo ? `${h.ServicioAnteriorCodigo} — ${h.ServicioAnteriorNombre}` : '—';
      const nuevo = h.ServicioNuevoCodigo ? `${h.ServicioNuevoCodigo} — ${h.ServicioNuevoNombre}` : '—';
      cambios.push(`Servicio: ${anterior} → ${nuevo}`);
    }

    return cambios.length ? cambios : ['Se actualizaron las observaciones'];
  }
}
