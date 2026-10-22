import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApuntamientoService } from '../../core/services/apuntamiento.service';
import { AplicacionService } from '../../core/services/aplicacion.service';
import { Apuntamiento } from '../../core/models/models';
import { AuthService } from '../../services/auth.service';

// Un "nodo" es un servidor físico con al menos un apuntamiento dentro de una
// aplicación (o, cuando servidorId es null, el grupo de apuntamientos que no
// tienen un servidor específico asignado). Las cifras de ACE/Bus/sin
// apuntamiento se guardan POR NODO (y no a nivel de aplicación): distintos
// nodos de una misma aplicación pueden apuntar a categorías completamente
// distintas, así que un total combinado a nivel de aplicación (ej. "36 ACE,
// 27 Bus" sumando los 3 nodos) no dice nada útil sobre cada nodo en
// particular — por eso se muestra desglosado aquí.
interface NodoResumen {
  servidorId: number | null;
  etiqueta: string;
  cantidad: number;
  countAce: number;
  countBus: number;
  countSin: number;
}

// Una tarjeta = una Aplicación que YA TIENE al menos un apuntamiento
// registrado. A propósito ya NO se arma a partir del catálogo completo de
// Aplicaciones (antes se mostraba una tarjeta por cada una, incluso las que
// nunca van a tener apuntamientos — Biometría, CRM, Formularios de venta,
// etc. — lo cual llenaba la vista de tarjetas vacías sin ningún uso). Para
// empezar a registrar una aplicación nueva se usa el botón "+ Agregar
// aplicación" (ver abrirAgregarAplicacion() más abajo), que lleva a su
// detalle para crear el primer apuntamiento a propósito.
interface AplicacionResumen {
  aplicacionId: number;
  aplicacionNombre: string;
  total: number;
  ultimaActualizacion: string | null;
  nodos: NodoResumen[];
}

@Component({
  selector: 'app-bitacora-apuntamientos-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './bitacora-apuntamientos-list.component.html',
  styleUrl: './bitacora-apuntamientos-list.component.scss',
})
export class BitacoraApuntamientosListComponent implements OnInit {
  cargando = true;
  apuntamientos: Apuntamiento[] = [];
  aplicaciones: any[] = [];
  terminoBusqueda = '';

  // Solo ADMIN_POD/ADMIN_MIN pueden agregar aplicaciones nuevas a la
  // Bitácora. BASIC = solo lectura (solo ve las tarjetas que ya existen).
  puedeEditar = false;

  // ============================================================
  // "+ Agregar aplicación" — elegir explícitamente qué aplicación empezar a
  // registrar en la Bitácora (en vez de que aparezcan todas automáticamente).
  // ============================================================
  mostrarAgregar = false;
  aplicacionSeleccionadaParaAgregar: number | null = null;

  constructor(
    private apuntamientoService: ApuntamientoService,
    private aplicacionService: AplicacionService,
    private authService: AuthService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('SERVICIOS');

    this.cargar();
    // Se sigue pidiendo el catálogo de Aplicaciones, pero SOLO para poder
    // ofrecerlo como opciones en "+ Agregar aplicación" — ya no se usa para
    // sembrar tarjetas vacías.
    this.aplicacionService.listar().subscribe((data) => (this.aplicaciones = data as any[]));
  }

  cargar(): void {
    this.cargando = true;
    this.apuntamientoService.listar().subscribe({
      next: (datos) => {
        this.apuntamientos = datos;
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error al cargar la bitácora de apuntamientos:', err);
        this.cargando = false;
      },
    });
  }

  // Agrupa los apuntamientos por Aplicación — una tarjeta por cada
  // aplicación que tenga al menos un apuntamiento registrado.
  get gruposAplicacion(): AplicacionResumen[] {
    const mapa = new Map<number, AplicacionResumen>();
    const nodosPorApp = new Map<number, Map<string, NodoResumen>>();

    for (const a of this.apuntamientos) {
      let resumen = mapa.get(a.AplicacionId);
      if (!resumen) {
        resumen = {
          aplicacionId: a.AplicacionId,
          aplicacionNombre: a.AplicacionNombre || `Aplicación #${a.AplicacionId}`,
          total: 0,
          ultimaActualizacion: null,
          nodos: [],
        };
        mapa.set(a.AplicacionId, resumen);
      }

      resumen.total++;
      if (a.FechaActualizacion && (!resumen.ultimaActualizacion || new Date(a.FechaActualizacion) > new Date(resumen.ultimaActualizacion))) {
        resumen.ultimaActualizacion = a.FechaActualizacion;
      }

      let nodos = nodosPorApp.get(a.AplicacionId);
      if (!nodos) {
        nodos = new Map<string, NodoResumen>();
        nodosPorApp.set(a.AplicacionId, nodos);
      }
      const clave = a.ServidorId != null ? String(a.ServidorId) : 'sin-servidor';
      let nodo = nodos.get(clave);
      if (!nodo) {
        nodo = {
          servidorId: a.ServidorId,
          etiqueta: a.ServidorHostname ? `${a.ServidorHostname} (${a.ServidorIP})` : 'Sin servidor específico',
          cantidad: 0,
          countAce: 0,
          countBus: 0,
          countSin: 0,
        };
        nodos.set(clave, nodo);
      }
      nodo.cantidad++;
      if (a.SinApuntamiento) nodo.countSin++;
      else if (a.Categoria === 'ACE') nodo.countAce++;
      else if (a.Categoria === 'BUS_INTEGRACION_10') nodo.countBus++;
    }

    for (const [aplicacionId, resumen] of mapa) {
      const nodos = nodosPorApp.get(aplicacionId);
      resumen.nodos = nodos
        ? Array.from(nodos.values()).sort((x, y) => x.etiqueta.localeCompare(y.etiqueta))
        : [];
    }

    return Array.from(mapa.values()).sort((a, b) => a.aplicacionNombre.localeCompare(b.aplicacionNombre));
  }

  get gruposFiltrados(): AplicacionResumen[] {
    const grupos = this.gruposAplicacion;
    if (!this.terminoBusqueda) return grupos;
    const termino = this.terminoBusqueda.toLowerCase().trim();
    return grupos.filter(
      (g) => g.aplicacionNombre.toLowerCase().includes(termino) || g.nodos.some((n) => n.etiqueta.toLowerCase().includes(termino)),
    );
  }

  // Aplicaciones que todavía no tienen tarjeta en la Bitácora — las únicas
  // que tiene sentido ofrecer en "+ Agregar aplicación".
  get aplicacionesDisponiblesParaAgregar(): any[] {
    const yaListadas = new Set(this.gruposAplicacion.map((g) => g.aplicacionId));
    return this.aplicaciones
      .filter((app) => !yaListadas.has(app.id ?? app.Id))
      .sort((a, b) => (a.nombre || a.Nombre || '').localeCompare(b.nombre || b.Nombre || ''));
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

  // Entrar al detalle de una aplicación: ahí se ve la tabla completa de sus
  // apuntamientos, con botones para filtrar por nodo (ver
  // bitacora-apuntamientos-aplicacion.component.ts) y todas las acciones
  // (crear/editar/registrar cambio/eliminar).
  abrirAplicacion(g: AplicacionResumen): void {
    this.router.navigate(['/apuntamientos/aplicacion', g.aplicacionId]);
  }

  // ============================================================
  // "+ Agregar aplicación": el usuario elige explícitamente cuál aplicación
  // empezar a registrar (en vez de que aparezcan todas automáticamente). Al
  // confirmar, se entra directo a su detalle para crear el primer
  // apuntamiento — una vez creado, la tarjeta aparece sola en esta vista.
  // ============================================================
  abrirAgregarAplicacion(): void {
    if (!this.puedeEditar) return;
    this.aplicacionSeleccionadaParaAgregar = null;
    this.mostrarAgregar = true;
  }

  cerrarAgregarAplicacion(): void {
    this.mostrarAgregar = false;
    this.aplicacionSeleccionadaParaAgregar = null;
  }

  confirmarAgregarAplicacion(): void {
    if (!this.aplicacionSeleccionadaParaAgregar) return;
    this.router.navigate(['/apuntamientos/aplicacion', this.aplicacionSeleccionadaParaAgregar]);
  }
}
