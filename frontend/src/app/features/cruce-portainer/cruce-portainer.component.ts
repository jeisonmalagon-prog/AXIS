import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as XLSX from 'xlsx';
import {
  CruceFila, CrucePortainerService, CrucePuerto, CruceSeccion, Hallazgo, RespuestaCruce,
} from '../../core/services/cruce-portainer.service';

interface VistaSeccion {
  s: CruceSeccion;
  filas: CruceFila[];
  diferencias: number;
}

interface InfoHallazgo {
  id: Hallazgo;
  texto: string;
  clase: string;
  ayuda: string;
}

// Orden en el que aparecen los filtros (lo más importante primero).
export const HALLAZGOS: InfoHallazgo[] = [
  { id: 'sin_registrar', texto: 'Sin registrar', clase: 'chip-alta', ayuda: 'Corre en Portainer y no está en el inventario de sub-aplicativos.' },
  { id: 'sin_contenedor', texto: 'Sin contenedor', clase: 'chip-alta', ayuda: 'Está en el inventario pero no hay contenedor con ese nombre ni ese puerto.' },
  { id: 'puerto_distinto', texto: 'Puerto distinto', clase: 'chip-alta', ayuda: 'El puerto del inventario no es uno de los que publica el contenedor.' },
  { id: 'estado_distinto', texto: 'Estado distinto', clase: 'chip-alta', ayuda: 'El inventario dice Activo y el contenedor está detenido (o al revés).' },
  { id: 'con_problemas', texto: 'Con problemas', clase: 'chip-alta', ayuda: 'Contenedor reiniciándose, en pausa o «unhealthy».' },
  { id: 'puerto_duplicado', texto: 'Puerto duplicado', clase: 'chip-media', ayuda: 'Dos contenedores publican el mismo puerto, uno detenido lo reserva, o el inventario lo repite.' },
  { id: 'varios_contenedores', texto: 'Varios contenedores', clase: 'chip-media', ayuda: 'Más de un contenedor para el mismo sub-aplicativo.' },
  { id: 'version_distinta', texto: 'Versión distinta', clase: 'chip-media', ayuda: 'La versión de imagen registrada no coincide con la que corre.' },
  { id: 'nombre_distinto', texto: 'Nombre distinto', clase: 'chip-media', ayuda: 'Se emparejó por imagen o por puerto: el nombre no coincide.' },
  { id: 'sin_puerto_inventario', texto: 'Sin puerto en inventario', clase: 'chip-marca', ayuda: 'El contenedor publica puertos y el inventario no tiene ninguno registrado.' },
  { id: 'sin_servidor', texto: 'Servidor sin inventario', clase: 'chip-media', ayuda: 'El servidor de Portainer no está en el inventario de servidores.' },
  { id: 'fuera_de_docker', texto: 'Fuera de Docker', clase: '', ayuda: 'Por su nombre no es un contenedor (servicio o sitio del sistema): Portainer no lo ve.' },
];
const INFO = new Map(HALLAZGOS.map((h) => [h.id, h]));

const sinTildes = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Inventario → Conciliación. Cruza lo que corre en Portainer (contenedores y puertos) con el
 * inventario de sub-aplicativos y señala lo que no cuadra. Solo lectura.
 */
@Component({
  selector: 'app-cruce-portainer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './cruce-portainer.component.html',
  styleUrl: './cruce-portainer.component.scss',
})
export class CrucePortainerComponent implements OnInit {
  @Output() abrirSubaplicativo = new EventEmitter<{ servidorId: number; subId: number }>();

  cargando = true;
  error = '';
  datos: RespuestaCruce | null = null;

  texto = '';
  hallazgo: Hallazgo | '' = '';
  soloDiferencias = true;
  ambiente = '';
  ambientes: { nombre: string; total: number }[] = [];
  cerradas = new Set<string>();
  verSinPortainer = false;

  vistas: VistaSeccion[] = [];
  conteos: { info: InfoHallazgo; total: number }[] = [];
  filasVisibles = 0;
  hayFiltros = false;

  constructor(private api: CrucePortainerService) {}

  ngOnInit(): void { this.cargar(false); }

  cargar(forzar: boolean): void {
    this.cargando = true;
    this.error = '';
    this.api.cruce(forzar).subscribe({
      next: (r) => {
        this.datos = r;
        this.cargando = false;
        this.error = r.error || '';
        const cuenta = new Map<string, number>();
        for (const s of r.secciones) if (s.ambiente) cuenta.set(s.ambiente, (cuenta.get(s.ambiente) ?? 0) + 1);
        this.ambientes = [...cuenta.entries()].map(([nombre, total]) => ({ nombre, total })).sort((a, b) => a.nombre.localeCompare(b.nombre));
        if (this.ambiente && !cuenta.has(this.ambiente)) this.ambiente = '';
        this.recalcular();
      },
      error: (e) => {
        this.cargando = false;
        this.datos = null;
        this.error = e?.error?.error || 'No se pudo calcular el cruce con Portainer.';
        this.recalcular();
      },
    });
  }

  recalcular(): void {
    const secciones = this.datos?.secciones ?? [];
    const q = sinTildes(this.texto.trim());
    this.hayFiltros = !!(q || this.hallazgo || this.ambiente || !this.soloDiferencias);
    const vistas: VistaSeccion[] = [];
    let visibles = 0;

    for (const s of secciones) {
      if (this.ambiente && s.ambiente !== this.ambiente) continue;
      const coincideServidor = !!q && sinTildes(`${s.entorno} ${s.hostname ?? ''} ${s.ip ?? ''}`).includes(q);
      const filas = s.filas.filter((f) => {
        if (this.hallazgo && !f.hallazgos.includes(this.hallazgo)) return false;
        if (this.soloDiferencias && f.estado === 'ok') return false;
        if (!q || coincideServidor) return true;
        return sinTildes(this.textoFila(f)).includes(q);
      });
      const diferencias = s.filas.filter((f) => f.estado !== 'ok').length;
      const sinFiltroDeFila = !this.hallazgo && !q;
      if (filas.length || (!s.ok && sinFiltroDeFila) || (coincideServidor && !this.hallazgo)) {
        vistas.push({ s, filas, diferencias });
        visibles += filas.length;
      }
    }
    this.vistas = vistas;
    this.filasVisibles = visibles;

    const por = this.datos?.resumen?.porHallazgo;
    this.conteos = HALLAZGOS.map((info) => ({ info, total: por ? (por[info.id] ?? 0) : 0 })).filter((c) => c.total > 0);
  }

  private textoFila(f: CruceFila): string {
    const c = f.contenedor;
    const s = f.subaplicativo;
    return [
      c?.nombre, c?.imagen, c?.stack, c?.estado, ...(c?.puertos ?? []).map((p) => p.puerto),
      s?.nombre, s?.tipo, s?.puerto, s?.estado, ...(s?.aplicaciones ?? []),
      ...f.hallazgos.map((h) => INFO.get(h)?.texto ?? h), ...f.notas,
    ].filter((x) => x !== null && x !== undefined && x !== '').join(' ');
  }

  elegirHallazgo(h: Hallazgo): void { this.hallazgo = this.hallazgo === h ? '' : h; this.recalcular(); }
  elegirAmbiente(a: string): void { this.ambiente = this.ambiente === a ? '' : a; this.recalcular(); }
  quitarFiltros(): void { this.texto = ''; this.hallazgo = ''; this.ambiente = ''; this.soloDiferencias = true; this.recalcular(); }

  abierta(s: CruceSeccion): boolean { return !this.cerradas.has(this.clave(s)); }
  alternar(s: CruceSeccion): void {
    const k = this.clave(s);
    if (this.cerradas.has(k)) this.cerradas.delete(k); else this.cerradas.add(k);
  }
  clave(s: CruceSeccion): string { return s.entornoIds.join('-'); }
  trackS = (_: number, v: VistaSeccion): string => this.clave(v.s);
  trackF(i: number, f: CruceFila): string { return `${f.contenedor?.id ?? 's' + f.subaplicativo?.id}-${i}`; }

  info(h: Hallazgo): InfoHallazgo { return INFO.get(h) ?? { id: h, texto: h, clase: '', ayuda: '' }; }
  etiquetaEstado(f: CruceFila): string { return f.estado === 'ok' ? 'Coincide' : this.info(f.estado).texto; }

  claseContenedor(estado: string): string {
    if (estado === 'running') return 'chip-ok';
    if (estado === 'restarting' || estado === 'paused') return 'chip-alta';
    return 'chip-media';
  }
  etiquetaContenedor(estado: string): string {
    const m: Record<string, string> = { running: 'En ejecución', exited: 'Detenido', created: 'Creado', restarting: 'Reiniciando', paused: 'En pausa', dead: 'Muerto', removing: 'Eliminando' };
    return m[estado] ?? estado;
  }
  puertosTexto(ps: CrucePuerto[]): string {
    return ps.map((p) => (p.destino ? `${p.puerto}→${p.destino}` : String(p.puerto))).join(', ');
  }
  hora(iso: string | null): string { return iso ? formatDate(iso, 'dd/MM/yyyy HH:mm', 'en-US') : ''; }
  verEnInventario(f: CruceFila): void {
    if (f.subaplicativo) this.abrirSubaplicativo.emit({ servidorId: f.subaplicativo.servidorId, subId: f.subaplicativo.id });
  }

  get sinPortainer(): boolean { return !!this.datos && !this.datos.configurado; }
  get hayFilas(): boolean { return this.filasVisibles > 0; }

  // ------------------------------------------------------------------ Excel (lo que se ve, con los filtros)
  exportarExcel(): void {
    const filas: Record<string, string | number>[] = [];
    for (const v of this.vistas) {
      for (const f of v.filas) {
        const c = f.contenedor;
        const s = f.subaplicativo;
        filas.push({
          Servidor: v.s.hostname ?? v.s.entorno,
          IP: v.s.ip ?? '',
          Ambiente: v.s.ambiente ?? '',
          Resultado: f.estado === 'ok' ? 'Coincide' : f.hallazgos.map((h) => this.info(h).texto).join(' | '),
          Contenedor: c?.nombre ?? '',
          'Estado del contenedor': c ? this.etiquetaContenedor(c.estado) : '',
          Imagen: c?.imagen ?? '',
          Stack: c?.stack ?? '',
          'Puertos publicados': c ? this.puertosTexto(c.puertos) : '',
          'Sub-aplicativo (inventario)': s?.nombre ?? '',
          Tipo: s?.tipo ?? '',
          'Puerto en inventario': s?.puerto ?? '',
          'Estado en inventario': s?.estado ?? '',
          Criticidad: s?.criticidad ?? '',
          'Versión en inventario': s?.versionImagen ?? '',
          'Aplicaciones de negocio': s ? s.aplicaciones.join(', ') : '',
          'Emparejado por': f.emparejadoPor ?? '',
          Detalle: f.notas.join(' '),
        });
      }
    }
    if (!filas.length && !(this.datos?.servidoresSinPortainer.length)) return;
    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.json_to_sheet(filas);
    hoja['!cols'] = [20, 14, 12, 34, 28, 16, 34, 16, 18, 30, 12, 12, 14, 11, 14, 28, 12, 70].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(libro, hoja, 'Conciliación');

    const sin = (this.datos?.servidoresSinPortainer ?? []).map((s) => ({
      Servidor: s.hostname, IP: s.ip ?? '', Ambiente: s.ambiente ?? '', 'Sub-aplicativos registrados': s.subaplicativos,
    }));
    if (sin.length) {
      const h2 = XLSX.utils.json_to_sheet(sin);
      h2['!cols'] = [24, 16, 14, 26].map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(libro, h2, 'Servidores sin Portainer');
    }
    XLSX.writeFile(libro, `conciliacion-portainer-${formatDate(new Date(), 'yyyy-MM-dd', 'en-US')}.xlsx`);
  }
}
