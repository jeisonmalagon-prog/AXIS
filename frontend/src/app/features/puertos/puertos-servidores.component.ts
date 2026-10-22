import { Component, OnInit } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import {
  EntornoPuertos, EstadoInventarioPortainer, InventarioPuerto, NormaPuerto, NormasPuertos, PuertoPortainer, PuertoSugerido,
  PuertosService, RespuestaPuertosPortainer, SugerenciaPuertos,
} from '../../core/services/puertos.service';

type Vista = 'uso' | 'sugerir';
type FiltroEstado = '' | 'activo' | 'reservado';
type FiltroInventario = '' | 'no_inventariado' | 'inventariado';

interface VistaEntorno {
  e: EntornoPuertos;
  filas: PuertoPortainer[];
}

interface UsoDelPuerto {
  puerto: number;
  usos: { servidor: string; contenedor: string; reservado: boolean }[];
}

const sinTildes = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Inventario → Puertos. Sin SSH: lee de Portainer qué puertos publica cada contenedor en cada servidor Docker
 * (solo lectura), los compara con el inventario y sugiere puertos libres según el tipo de componente.
 */
@Component({
  selector: 'app-puertos-servidores',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './puertos-servidores.component.html',
  styleUrl: './puertos-servidores.component.scss',
})
export class PuertosServidoresComponent implements OnInit {
  vista: Vista = 'uso';

  // ---- Puertos en uso
  cargando = true;
  error = '';
  datos: RespuestaPuertosPortainer | null = null;
  texto = '';
  estado: FiltroEstado = '';
  inventario: FiltroInventario = '';
  ambiente = '';
  ambientes: { nombre: string; total: number }[] = [];
  cerradas = new Set<number>();
  vistas: VistaEntorno[] = [];
  hayFiltros = false;
  usoDelPuerto: UsoDelPuerto | null = null;
  kpi = { servidores: 0, total: 0, contenedores: 0, enUso: 0, reservados: 0, sinInventariar: 0, conError: 0 };

  // ---- Sugerir
  normas: NormasPuertos | null = null;
  errorNormas = '';
  tipoId = '';
  destino: number | 'todos' = 'todos';
  cantidad = 3;
  sugiriendo = false;
  errorSugerencia = '';
  sugerencia: SugerenciaPuertos | null = null;
  copiado: number | null = null;
  verNormas = false;

  constructor(private api: PuertosService) {}

  ngOnInit(): void {
    this.cargar(false);
    this.cargarNormas();
  }

  cambiarVista(v: Vista): void { this.vista = v; }

  // ------------------------------------------------------------------ Puertos en uso

  cargar(forzar: boolean): void {
    this.cargando = true;
    this.error = '';
    this.api.portainer(forzar).subscribe({
      next: (r) => {
        this.datos = r;
        this.cargando = false;
        this.error = r.error || '';
        const cuenta = new Map<string, number>();
        for (const e of r.entornos) {
          if (!e.ambiente) continue;
          cuenta.set(e.ambiente, (cuenta.get(e.ambiente) ?? 0) + 1);
        }
        this.ambientes = [...cuenta.entries()].map(([nombre, total]) => ({ nombre, total })).sort((a, b) => a.nombre.localeCompare(b.nombre));
        if (this.ambiente && !cuenta.has(this.ambiente)) this.ambiente = '';
        // Si cambió la lista de servidores, se descarta una sugerencia vieja hacia un servidor que ya no está.
        if (this.destino !== 'todos' && !r.entornos.some((e) => e.id === this.destino)) this.destino = 'todos';
        this.recalcular();
      },
      error: (e) => {
        this.cargando = false;
        this.datos = null;
        this.error = e?.error?.error || 'No se pudo consultar Portainer.';
        this.recalcular();
      },
    });
  }

  recalcular(): void {
    const entornos = this.datos?.entornos ?? [];
    const q = sinTildes(this.texto.trim());
    this.hayFiltros = !!(q || this.estado || this.inventario || this.ambiente);
    const vistas: VistaEntorno[] = [];

    for (const e of entornos) {
      if (this.ambiente && e.ambiente !== this.ambiente) continue;
      const coincideServidor = !!q && sinTildes(`${e.nombre} ${e.ip ?? ''} ${e.hostname ?? ''}`).includes(q);
      const filas = e.puertos.filter((f) => {
        if (this.estado === 'activo' && f.reservado) return false;
        if (this.estado === 'reservado' && !f.reservado) return false;
        if (this.inventario && f.estadoInventario !== this.inventario) return false;
        if (!q || coincideServidor) return true;
        return sinTildes(`${f.puerto} ${f.destino ?? ''} ${f.contenedor} ${f.imagen} ${f.stack ?? ''} ${this.textoInventario(f)}`).includes(q);
      });
      const soloFiltroDeServidor = !this.estado && !this.inventario;
      if (!this.hayFiltros || filas.length || (coincideServidor && soloFiltroDeServidor) || (!e.ok && !q && soloFiltroDeServidor)) {
        vistas.push({ e, filas });
      }
    }
    this.vistas = vistas;

    const buenos = entornos.filter((e) => e.ok);
    this.kpi = {
      servidores: buenos.length,
      total: entornos.length,
      contenedores: buenos.reduce((n, e) => n + e.contenedores, 0),
      enUso: buenos.reduce((n, e) => n + (e.resumen?.enUso ?? 0), 0),
      reservados: buenos.reduce((n, e) => n + (e.resumen?.reservados ?? 0), 0),
      sinInventariar: buenos.reduce((n, e) => n + (e.resumen?.sinInventariar ?? 0), 0),
      conError: entornos.length - buenos.length,
    };

    // «¿Dónde está el puerto N?»
    this.usoDelPuerto = null;
    if (/^\d{1,5}$/.test(q)) {
      const n = Number(q);
      const usos: UsoDelPuerto['usos'] = [];
      for (const e of buenos) {
        for (const f of e.puertos) {
          if (f.puerto === n) usos.push({ servidor: e.nombre, contenedor: f.contenedor, reservado: f.reservado });
        }
      }
      this.usoDelPuerto = { puerto: n, usos };
    }
  }

  elegirEstado(e: FiltroEstado): void { this.estado = this.estado === e ? '' : e; this.recalcular(); }
  elegirInventario(i: FiltroInventario): void { this.inventario = this.inventario === i ? '' : i; this.recalcular(); }
  elegirAmbiente(a: string): void { this.ambiente = this.ambiente === a ? '' : a; this.recalcular(); }
  quitarFiltros(): void { this.texto = ''; this.estado = ''; this.inventario = ''; this.ambiente = ''; this.recalcular(); }

  abierta(e: EntornoPuertos): boolean { return !this.cerradas.has(e.id); }
  alternar(e: EntornoPuertos): void {
    if (!e.ok) return;
    if (this.cerradas.has(e.id)) this.cerradas.delete(e.id); else this.cerradas.add(e.id);
  }

  etiquetaInventario(s: EstadoInventarioPortainer): string {
    return s === 'inventariado' ? 'En inventario' : s === 'no_inventariado' ? 'No inventariado' : s === 'sistema' ? 'Del sistema' : 'Sin comparar';
  }
  claseInventario(s: EstadoInventarioPortainer): string {
    return s === 'inventariado' ? 'chip-ok' : s === 'no_inventariado' ? 'chip-alta' : '';
  }
  detalleInventario(i: InventarioPuerto): string {
    return [i.rol, i.tipo].filter(Boolean).join(' · ') || 'Componente sin nombre';
  }
  private textoInventario(f: PuertoPortainer): string {
    return f.inventario.map((i) => `${i.rol ?? ''} ${i.tipo ?? ''} ${i.aplicaciones.join(' ')}`).join(' ') +
      (f.estadoInventario === 'no_inventariado' ? ' no inventariado sin inventariar' : '');
  }
  publicado(f: PuertoPortainer): string {
    return f.destino ? `${f.puerto} → ${f.destino}` : String(f.puerto);
  }
  alcanceTexto(f: PuertoPortainer): string {
    if (f.alcance === 'local') return 'solo local';
    if (f.alcance === 'especifica') return f.direcciones.join(', ');
    return '';
  }
  hora(iso: string | null): string { return iso ? formatDate(iso, 'dd/MM/yyyy HH:mm', 'en-US') : ''; }
  trackE(_: number, v: VistaEntorno): number { return v.e.id; }
  trackF(_: number, f: PuertoPortainer): string { return `${f.protocolo}${f.puerto}${f.contenedorId}`; }

  get hayPuertos(): boolean { return this.vistas.some((v) => v.filas.length > 0); }
  get sinPortainer(): boolean { return !!this.datos && !this.datos.configurado; }
  /** Servidores donde Docker no reportó puertos de algún contenedor con red «host». */
  get conRedHost(): number { return this.vistas.filter((v) => v.e.redHost.length).length; }

  // ------------------------------------------------------------------ Sugerir

  cargarNormas(): void {
    this.errorNormas = '';
    this.api.normas().subscribe({
      next: (n) => {
        this.normas = n;
        if (!this.tipoId && n.tipos.length) this.tipoId = n.tipos[0].id;
      },
      error: (e) => { this.errorNormas = e?.error?.error || 'No se pudieron cargar las normas de puertos.'; },
    });
  }

  get tipoActual(): NormaPuerto | null {
    return this.normas?.tipos.find((t) => t.id === this.tipoId) ?? null;
  }
  get entornosOk(): EntornoPuertos[] { return (this.datos?.entornos ?? []).filter((e) => e.ok); }

  elegirTipo(id: string): void { this.tipoId = id; this.sugerencia = null; this.errorSugerencia = ''; }

  sugerir(): void {
    if (this.sugiriendo || !this.tipoId) return;
    this.sugiriendo = true;
    this.errorSugerencia = '';
    this.api.sugerir(this.tipoId, this.destino, this.cantidad).subscribe({
      next: (r) => { this.sugerencia = r; this.sugiriendo = false; },
      error: (e) => {
        this.sugiriendo = false;
        this.sugerencia = null;
        this.errorSugerencia = e?.error?.error || 'No se pudieron calcular las sugerencias.';
      },
    });
  }

  copiar(s: PuertoSugerido): void {
    const marcar = (): void => {
      this.copiado = s.puerto;
      setTimeout(() => { if (this.copiado === s.puerto) this.copiado = null; }, 1600);
    };
    try {
      if (navigator.clipboard) { navigator.clipboard.writeText(String(s.puerto)).then(marcar, () => undefined); return; }
    } catch { /* sin portapapeles */ }
    marcar();
  }

  alternarNormas(): void { this.verNormas = !this.verNormas; }

  // ------------------------------------------------------------------ Excel

  exportarExcel(): void {
    const filas: Record<string, string | number>[] = [];
    for (const v of this.vistas) {
      for (const f of v.filas) {
        filas.push({
          Servidor: v.e.nombre,
          IP: v.e.ip ?? v.e.ipInventario ?? '',
          Ambiente: v.e.ambiente ?? '',
          Puerto: f.puerto,
          Protocolo: f.protocolo,
          'Puerto en el contenedor': f.destino ?? '',
          Contenedor: f.contenedor,
          Imagen: f.imagen,
          Stack: f.stack ?? '',
          Estado: f.reservado ? 'Reservado (contenedor detenido)' : 'En uso',
          'Estado en inventario': this.etiquetaInventario(f.estadoInventario),
          'Componente (inventario)': f.inventario.map((i) => this.detalleInventario(i)).join(' | '),
          'Aplicaciones (inventario)': f.inventario.flatMap((i) => i.aplicaciones).join(', '),
        });
      }
    }
    if (!filas.length) return;
    const hoja = XLSX.utils.json_to_sheet(filas);
    hoja['!cols'] = [20, 16, 12, 8, 10, 12, 28, 34, 18, 28, 18, 30, 34].map((wch) => ({ wch }));
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Puertos');

    const ausentes: Record<string, string | number>[] = [];
    for (const v of this.vistas) {
      for (const i of v.e.inventarioSinEscuchar) {
        ausentes.push({
          Servidor: v.e.nombre, IP: v.e.ip ?? '', Puerto: i.puerto,
          'Componente (inventario)': this.detalleInventario(i), 'Aplicaciones (inventario)': i.aplicaciones.join(', '),
        });
      }
    }
    if (ausentes.length) {
      const h2 = XLSX.utils.json_to_sheet(ausentes);
      h2['!cols'] = [20, 16, 8, 34, 34].map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(libro, h2, 'Inventario sin publicar');
    }
    XLSX.writeFile(libro, `puertos-servidores-${formatDate(new Date(), 'yyyy-MM-dd', 'en-US')}.xlsx`);
  }
}
