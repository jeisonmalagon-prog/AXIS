import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  CasoGlpiLista, FiltrosListadoGlpi, GrupoGlpi, ListadoCasosGlpi, PasoProduccionService, UsuarioGlpi,
} from '../../core/services/paso-produccion.service';
import { OpcionSelector, SelectorBuscableComponent } from '../../shared/selector-buscable/selector-buscable.component';

type Vista = 'tabla' | 'numeros' | 'resumen';
type FormatoNumeros = 'linea' | 'coma' | 'numeral' | 'titulo';

const CLAVE_FILTROS = 'axis.glpi.casos.filtros';

// Listado de casos de GLPI (solo lectura): filtros, vista «solo números», tabla y exportación.
// Desde aquí se puede iniciar «Importar desde GLPI» con un caso concreto; no escribe nada en GLPI.
@Component({
  selector: 'app-glpi-casos-equipo',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectorBuscableComponent],
  templateUrl: './glpi-casos-equipo.component.html',
  styleUrl: './glpi-casos-equipo.component.scss',
})
export class GlpiCasosEquipoComponent implements OnInit {
  @Output() cerrar = new EventEmitter<void>();
  /** Número de caso elegido para importarlo como registro. */
  @Output() importar = new EventEmitter<string>();

  yo: { id: string; nombre: string } | null = null;
  grupos: GrupoGlpi[] = [];
  usuarios: UsuarioGlpi[] = [];
  opcionesTecnicos: OpcionSelector[] = [];
  avisoUsuarios = '';
  filtrosCargados = false;

  f: FiltrosListadoGlpi = this.filtrosPorDefecto();
  listado: ListadoCasosGlpi | null = null;
  cargando = false;
  error = '';

  vista: Vista = 'tabla';
  formato: FormatoNumeros = 'linea';
  ocultarRegistrados = false;
  seleccion = new Set<number>();
  copiado = '';
  private temporizadorCopiado: ReturnType<typeof setTimeout> | null = null;

  readonly estados = [
    { v: 'notold', t: 'No resueltos (abiertos)' },
    { v: 'all', t: 'Todos' },
    { v: '1', t: 'Nuevo' },
    { v: '2', t: 'En curso (asignado)' },
    { v: '3', t: 'En curso (planificado)' },
    { v: '4', t: 'Pendiente' },
    { v: 'old', t: 'Resueltos y cerrados' },
    { v: '5', t: 'Solo resueltos' },
    { v: '6', t: 'Solo cerrados' },
  ];
  readonly ordenes = [
    { v: 'apertura|desc', t: 'Más recientes primero' },
    { v: 'apertura|asc', t: 'Más antiguos primero' },
    { v: 'actualizacion|desc', t: 'Última actualización' },
    { v: 'vencimiento|asc', t: 'Vencimiento más próximo' },
    { v: 'id|desc', t: 'Número de caso (mayor a menor)' },
  ];
  readonly limites = [25, 50, 100, 200, 500];

  constructor(private servicio: PasoProduccionService) {}

  ngOnInit(): void {
    this.f = { ...this.filtrosPorDefecto(), ...this.leerFiltrosGuardados() };
    this.servicio.filtrosGlpi().subscribe({
      next: (r) => {
        this.yo = r.yo;
        this.grupos = r.grupos;
        this.usuarios = r.usuarios || [];
        this.avisoUsuarios = r.usuariosError || '';
        this.opcionesTecnicos = this.usuarios.map((u) => ({ id: u.id, nombre: u.nombre, subtitulo: u.equipo ? 'Mi equipo' : undefined }));
        this.filtrosCargados = true;
        if (this.f.alcance === 'yo' && !this.yo) this.f.alcance = this.grupos.some((g) => g.mio) ? 'grupo' : 'todos';
        if (this.f.alcance === 'grupo' && !this.f.grupoId) this.f.grupoId = (this.grupos.find((g) => g.mio) || this.grupos[0])?.id || '';
        this.buscar();
      },
      error: (e) => {
        this.filtrosCargados = true;
        this.error = e?.error?.error || 'No se pudo consultar GLPI.';
      },
    });
  }

  private filtrosPorDefecto(): FiltrosListadoGlpi {
    return { alcance: 'yo', grupoId: '', tecnicoId: '', tecnico: '', solicitante: '', estado: 'notold', texto: '', desde: '', hasta: '', soloVencidos: false, orden: 'apertura', sentido: 'desc', limite: 100 };
  }

  private leerFiltrosGuardados(): Partial<FiltrosListadoGlpi> {
    try {
      const crudo = localStorage.getItem(CLAVE_FILTROS);
      if (!crudo) return {};
      const o = JSON.parse(crudo) as Partial<FiltrosListadoGlpi>;
      return { alcance: o.alcance, grupoId: o.grupoId, tecnicoId: o.tecnicoId, estado: o.estado, orden: o.orden, sentido: o.sentido, limite: o.limite };
    } catch { return {}; }
  }

  private guardarFiltros(): void {
    try {
      localStorage.setItem(CLAVE_FILTROS, JSON.stringify({ alcance: this.f.alcance, grupoId: this.f.grupoId, tecnicoId: this.f.tecnicoId, estado: this.f.estado, orden: this.f.orden, sentido: this.f.sentido, limite: this.f.limite }));
    } catch { /* sin almacenamiento: no pasa nada */ }
  }

  get ordenSeleccionado(): string { return `${this.f.orden}|${this.f.sentido}`; }
  set ordenSeleccionado(v: string) { const [o, s] = v.split('|'); this.f.orden = o; this.f.sentido = s === 'asc' ? 'asc' : 'desc'; }

  get puedeBuscar(): boolean {
    if (this.cargando) return false;
    if (this.f.alcance === 'grupo') return !!this.f.grupoId;
    if (this.f.alcance === 'tecnico') return this.opcionesTecnicos.length ? !!this.f.tecnicoId : !!(this.f.tecnico || '').trim();
    return true;
  }

  buscar(): void {
    if (!this.puedeBuscar) return;
    this.cargando = true;
    this.error = '';
    this.seleccion.clear();
    this.guardarFiltros();
    this.servicio.casosGlpi({ ...this.f, tecnicoId: this.f.alcance === 'tecnico' ? this.f.tecnicoId : '', tecnico: (this.f.tecnico || '').trim(), solicitante: (this.f.solicitante || '').trim(), texto: (this.f.texto || '').trim() }).subscribe({
      next: (r) => { this.listado = r; this.cargando = false; },
      error: (e) => { this.error = e?.error?.error || 'No se pudo consultar los casos en GLPI.'; this.cargando = false; },
    });
  }

  limpiar(): void {
    const { alcance, grupoId, tecnicoId } = this.f;
    this.f = { ...this.filtrosPorDefecto(), alcance, grupoId, tecnicoId };
    this.ocultarRegistrados = false;
    this.buscar();
  }

  cambiarTecnico(id: string | null): void { this.f.tecnicoId = id || ''; if (this.f.tecnicoId) this.buscar(); }

  // ----- Datos visibles -----
  get casos(): CasoGlpiLista[] {
    const todos = this.listado?.casos || [];
    return this.ocultarRegistrados ? todos.filter((c) => !c.registroAxis) : todos;
  }

  get casosParaSalida(): CasoGlpiLista[] {
    const visibles = this.casos;
    return this.seleccion.size ? visibles.filter((c) => this.seleccion.has(c.id)) : visibles;
  }

  get resumenEstados(): { estado: string; total: number; vencidos: number }[] {
    const m = new Map<string, { estado: string; total: number; vencidos: number }>();
    for (const c of this.casos) {
      const x = m.get(c.estado) || { estado: c.estado, total: 0, vencidos: 0 };
      x.total += 1;
      if (c.vencido) x.vencidos += 1;
      m.set(c.estado, x);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }

  get resumenTecnicos(): { tecnico: string; total: number }[] {
    const m = new Map<string, number>();
    for (const c of this.casos) {
      const nombres = c.tecnicos.length ? c.tecnicos : ['(sin técnico asignado)'];
      for (const n of nombres) m.set(n, (m.get(n) || 0) + 1);
    }
    return [...m.entries()].map(([tecnico, total]) => ({ tecnico, total })).sort((a, b) => b.total - a.total);
  }

  get totalVencidos(): number { return this.casos.filter((c) => c.vencido).length; }
  get sinRegistro(): number { return this.casos.filter((c) => !c.registroAxis).length; }

  // ----- Selección -----
  alternar(c: CasoGlpiLista): void { if (this.seleccion.has(c.id)) this.seleccion.delete(c.id); else this.seleccion.add(c.id); }
  get todosMarcados(): boolean { return this.casos.length > 0 && this.casos.every((c) => this.seleccion.has(c.id)); }
  alternarTodos(): void {
    if (this.todosMarcados) this.seleccion.clear();
    else this.casos.forEach((c) => this.seleccion.add(c.id));
  }

  // ----- Salidas -----
  get textoNumeros(): string {
    const lista = this.casosParaSalida;
    switch (this.formato) {
      case 'coma': return lista.map((c) => c.id).join(', ');
      case 'numeral': return lista.map((c) => `#${c.id}`).join(', ');
      case 'titulo': return lista.map((c) => `${c.id} - ${c.titulo}`).join('\n');
      default: return lista.map((c) => c.id).join('\n');
    }
  }

  private filaTabla(c: CasoGlpiLista): string[] {
    return [String(c.id), c.titulo, c.estado, c.prioridad || '', c.apertura || '', c.vence || '', c.vencido ? 'Sí' : 'No', c.tecnicos.join(' | '), c.grupos.join(' | '), c.solicitantes.join(' | '), c.categoria || '', c.registroAxis ? `Registro #${c.registroAxis.pasoId}` : '', c.url];
  }
  private readonly encabezados = ['Caso', 'Título', 'Estado', 'Prioridad', 'Apertura', 'Vence', 'Vencido', 'Técnicos', 'Grupo', 'Solicitantes', 'Categoría', 'En AXIS', 'Enlace'];

  private marcar(que: string): void {
    this.copiado = que;
    if (this.temporizadorCopiado) clearTimeout(this.temporizadorCopiado);
    this.temporizadorCopiado = setTimeout(() => { this.copiado = ''; }, 2200);
  }

  private async copiar(texto: string, que: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(texto);
      this.marcar(que);
    } catch {
      const area = document.createElement('textarea');
      area.value = texto;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); this.marcar(que); } catch { this.error = 'El navegador no permitió copiar; selecciona el texto y usa Ctrl+C.'; }
      document.body.removeChild(area);
    }
  }

  copiarNumeros(): void { void this.copiar(this.textoNumeros, 'numeros'); }

  copiarTabla(): void {
    const filas = [this.encabezados, ...this.casosParaSalida.map((c) => this.filaTabla(c))];
    void this.copiar(filas.map((r) => r.map((x) => x.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n'), 'tabla');
  }

  descargarCsv(): void {
    const esc = (x: string) => `"${x.replace(/"/g, '""')}"`;
    const filas = [this.encabezados, ...this.casosParaSalida.map((c) => this.filaTabla(c))];
    const csv = '﻿' + filas.map((r) => r.map(esc).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `casos_glpi_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ----- Presentación -----
  fecha(v: string | null): string { return v ? v.slice(0, 16) : '—'; }
  primeros(lista: string[], n = 2): string { return lista.slice(0, n).join(', ') + (lista.length > n ? ` +${lista.length - n}` : ''); }
  claseEstado(c: CasoGlpiLista): string {
    if (c.cerrado) return 'est-cerrado';
    if (c.codigo === 4) return 'est-pendiente';
    if (c.codigo === 1) return 'est-nuevo';
    return 'est-curso';
  }
  claseResumen(estado: string): string {
    const e = estado.toLowerCase();
    return /resuelto|cerrado/.test(e) ? 'est-cerrado' : /pendiente/.test(e) ? 'est-pendiente' : /nuevo/.test(e) ? 'est-nuevo' : 'est-curso';
  }
  trackCaso(_: number, c: CasoGlpiLista): number { return c.id; }
}
