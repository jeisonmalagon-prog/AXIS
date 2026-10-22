import { Component, OnInit } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import * as XLSX from 'xlsx';
import { AuthService } from '../../services/auth.service';
import { BiometriaService, FilaListado, ListadoBiometrias } from '../../core/services/biometria.service';

type Nivel = 'ok' | 'aviso' | 'mal' | 'nulo';
type Preset = 'hoy' | 'ayer' | '7' | '15' | '30';

const POR_PAGINA = 50;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const sinTildes = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const atras = (n: number): Date => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const aFecha = (d: Date): string => formatDate(d, 'yyyy-MM-dd', 'en-US');

function nivelEstado(nombre: string | null | undefined): Nivel {
  const n = sinTildes(nombre ?? '');
  if (!n) return 'nulo';
  if (/(\bno\b|fall|rechaz|error|fraud|bloquead|vencid|cancel)/.test(n)) return 'mal';
  if (/(exito|aprobad|finaliz|complet|ok\b)/.test(n)) return 'ok';
  return 'aviso';
}

/** Biometrías en general: todos los casos de ORQBIOMETRIA en un rango de fechas, con filtros por estado y resultado. */
@Component({
  selector: 'app-biometria-general',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './biometria-general.component.html',
  styleUrl: './biometria-general.component.scss',
})
export class BiometriaGeneralComponent implements OnInit {
  puedeEditar = false;
  desde = '';
  hasta = '';
  presetActivo: Preset | '' = '';
  estado = '';
  resultado = '';
  consultando = false;
  error = '';
  datos: ListadoBiometrias | null = null;
  pagina = 1;
  totalPaginas = 1;
  paginaFilas: FilaListado[] = [];

  constructor(private api: BiometriaService, private auth: AuthService) {}

  ngOnInit(): void {
    // Todo el módulo es de lectura: consulta cualquiera que lo tenga habilitado (también con rol Consulta).
    this.puedeEditar = this.auth.rolEnModulo('BIOMETRIA') !== null;
    this.elegirPreset('hoy');
  }

  elegirPreset(p: Preset): void {
    switch (p) {
      case 'hoy': this.desde = aFecha(new Date()); this.hasta = aFecha(new Date()); break;
      case 'ayer': this.desde = aFecha(atras(1)); this.hasta = aFecha(atras(1)); break;
      case '7': this.desde = aFecha(atras(6)); this.hasta = aFecha(new Date()); break;
      case '15': this.desde = aFecha(atras(14)); this.hasta = aFecha(new Date()); break;
      case '30': this.desde = aFecha(atras(29)); this.hasta = aFecha(new Date()); break;
    }
    this.presetActivo = p;
  }

  cambioManual(): void { this.presetActivo = ''; }

  get rangoValido(): boolean { return RE_FECHA.test(this.desde) && RE_FECHA.test(this.hasta) && this.desde <= this.hasta; }

  /** Consulta el rango. `conservarFiltros` = al cambiar de estado/resultado se mantiene el rango. */
  consultar(limpiarFiltros = true): void {
    if (!this.puedeEditar || this.consultando || !this.rangoValido) return;
    if (limpiarFiltros) { this.estado = ''; this.resultado = ''; }
    this.cargar();
  }

  private cargar(): void {
    this.consultando = true;
    this.error = '';
    this.api.listado({ desde: this.desde, hasta: this.hasta, estado: this.estado || undefined, resultado: this.resultado || undefined }).subscribe({
      next: (r) => { this.consultando = false; this.datos = r; this.pagina = 1; this.paginar(); },
      error: (err) => { this.consultando = false; this.error = err?.error?.error || 'No se pudo completar la consulta.'; },
    });
  }

  elegirEstado(e: string): void { this.estado = this.estado === e ? '' : e; this.cargar(); }
  elegirResultado(r: string): void { this.resultado = this.resultado === r ? '' : r; this.cargar(); }
  quitarFiltros(): void { this.estado = ''; this.resultado = ''; this.cargar(); }

  private paginar(): void {
    const filas = this.datos?.filas ?? [];
    this.totalPaginas = Math.max(1, Math.ceil(filas.length / POR_PAGINA));
    this.pagina = Math.min(this.pagina, this.totalPaginas);
    this.paginaFilas = filas.slice((this.pagina - 1) * POR_PAGINA, this.pagina * POR_PAGINA);
  }

  cambiarPagina(d: number): void { this.pagina = Math.min(Math.max(1, this.pagina + d), this.totalPaginas); this.paginar(); }

  nivel(estado: string | null): Nivel { return nivelEstado(estado); }
  claseNivel(n: Nivel): string { return n === 'ok' ? 'est-ok' : n === 'aviso' ? 'est-aviso' : n === 'mal' ? 'est-mal' : 'est-nulo'; }
  fecha(v: string | null): string { return v ? formatDate(v, 'dd/MM/yyyy HH:mm:ss', 'en-US', 'UTC') : '—'; }
  fechaCorta(v: string): string { return RE_FECHA.test(v) ? formatDate(`${v}T00:00:00`, 'dd/MM/yyyy', 'en-US') : v; }
  trackFila = (_: number, f: FilaListado): string => f.idCaso;

  get hayFiltros(): boolean { return !!(this.datos?.filtro.estado || this.datos?.filtro.resultado); }

  get tiempos(): string {
    return (this.datos?.etapas ?? []).map((e) => `${e.etapa} ${(e.ms / 1000).toFixed(1)} s`).join(' · ');
  }

  exportarExcel(): void {
    const d = this.datos;
    if (!d || !d.filas.length) return;
    const filas = d.filas.map((f) => ({ 'Caso': f.idCaso, 'Cédula': f.cc, 'Nombre': f.nombre, 'Fecha': this.fecha(f.fecha), 'Estado': f.estado, 'Canal': f.idCanal, 'Último resultado': f.resultado }));
    const resumen: (string | number)[][] = [
      ['Rango', `${this.fechaCorta(d.filtro.desde)} a ${this.fechaCorta(d.filtro.hasta)}`],
      ['Filtro de estado', d.filtro.estado || '(todos)'], ['Filtro de resultado', d.filtro.resultado || '(todos)'],
      ['Casos en el rango', d.totalRango], ['Casos listados', d.filas.length],
      ...d.porEstado.map((e) => [`Estado: ${e.estado}`, e.total] as (string | number)[]),
    ];
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Biometrías');
    XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');
    XLSX.writeFile(libro, `biometrias-${d.filtro.desde}-a-${d.filtro.hasta}.xlsx`);
  }
}
