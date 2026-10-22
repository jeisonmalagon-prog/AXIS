import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ManualImportacionResultado, ManualLibreta, ManualModoDivision, ManualesService } from '../../core/services/manuales.service';
import { mensajeDeError, tamanoLegible } from './manuales-util';

interface ArchivoImportar {
  file: File;
  esPdf: boolean;
  seccionNombre: string;
  estado: 'espera' | 'importando' | 'ok' | 'error';
  mensaje: string;
  resultado?: ManualImportacionResultado;
}

export interface ImportacionTerminada { libretaId: number; seccionId: number; paginaId: number; }

const MAX_WORD = 120 * 1024 * 1024;
const MAX_PDF = 14 * 1024 * 1024;

@Component({
  selector: 'app-manual-importar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './manual-importar.component.html',
  styleUrl: './manual-importar.component.scss',
})
export class ManualImportarComponent implements OnInit {
  @Input() libretas: ManualLibreta[] = [];
  @Input() libretaActualId: number | null = null;
  @Input() seccionActualId: number | null = null;
  @Output() cerrar = new EventEmitter<void>();
  @Output() terminada = new EventEmitter<ImportacionTerminada>();

  archivos: ArchivoImportar[] = [];
  destino: 'nueva' | 'libreta' | 'seccion' = 'nueva';
  nombreLibreta = '';
  libretaId: number | null = null;
  seccionId: number | null = null;
  modo: ManualModoDivision = 'auto';
  ayuda = false;
  arrastrando = false;
  fase: 'config' | 'importando' | 'fin' = 'config';
  errorGeneral = '';
  readonly tamano = tamanoLegible;

  readonly modos: { valor: ManualModoDivision; titulo: string; detalle: string }[] = [
    { valor: 'auto', titulo: 'Automático (recomendado)', detalle: 'Separa por títulos si el documento tiene varios; si no, por saltos de página; si no, una sola página.' },
    { valor: 'titulo', titulo: 'Cada título es una página', detalle: 'Cada párrafo con estilo Título o Título 1 abre una página nueva. Es lo que genera OneNote al exportar una sección.' },
    { valor: 'pagina', titulo: 'Cada salto de página es una página', detalle: 'Útil si el documento no tiene títulos pero sí páginas separadas.' },
    { valor: 'una', titulo: 'Todo en una sola página', detalle: 'El documento completo queda como una única página.' },
  ];

  ngOnInit(): void {
    this.libretaId = this.libretaActualId ?? this.libretas[0]?.id ?? null;
    this.seccionId = this.seccionActualId;
    this.destino = this.libretas.length ? 'libreta' : 'nueva';
  }

  get seccionesDeLibreta() {
    return this.libretas.find((l) => l.id === this.libretaId)?.secciones ?? [];
  }

  get hayWord(): boolean { return this.archivos.some((a) => !a.esPdf); }

  get puedeImportar(): boolean {
    if (!this.archivos.length || this.fase !== 'config') return false;
    if (this.destino === 'nueva') return !!this.nombreLibreta.trim();
    if (this.destino === 'libreta') return !!this.libretaId;
    return !!this.seccionId && this.archivos.length === 1;
  }

  alElegir(evento: Event): void {
    const entrada = evento.target as HTMLInputElement;
    this.agregar(Array.from(entrada.files || []));
    entrada.value = '';
  }

  alSoltar(evento: DragEvent): void {
    evento.preventDefault();
    this.arrastrando = false;
    this.agregar(Array.from(evento.dataTransfer?.files || []));
  }

  private agregar(lista: File[]): void {
    this.errorGeneral = '';
    for (const f of lista) {
      const esDocx = /\.docx$/i.test(f.name);
      const esPdf = /\.pdf$/i.test(f.name);
      if (/\.doc$/i.test(f.name)) { this.errorGeneral = `«${f.name}» es un Word antiguo (.doc). Ábrelo en Word y guárdalo como .docx.`; continue; }
      if (!esDocx && !esPdf) { this.errorGeneral = `«${f.name}» no se puede importar: solo se aceptan archivos Word (.docx) y PDF.`; continue; }
      if (esPdf && f.size > MAX_PDF) { this.errorGeneral = `«${f.name}» pesa ${tamanoLegible(f.size)}; el máximo para un PDF es 14 MB.`; continue; }
      if (f.size > MAX_WORD) { this.errorGeneral = `«${f.name}» pesa ${tamanoLegible(f.size)}; el máximo es 120 MB.`; continue; }
      if (this.archivos.some((a) => a.file.name === f.name && a.file.size === f.size)) continue;
      this.archivos.push({ file: f, esPdf, seccionNombre: f.name.replace(/\.[a-z0-9]{2,5}$/i, ''), estado: 'espera', mensaje: '' });
    }
    if (this.destino === 'nueva' && !this.nombreLibreta && this.archivos.length) this.nombreLibreta = 'Mis manuales';
    if (this.archivos.length > 1 && this.destino === 'seccion') this.destino = 'libreta';
  }

  quitar(a: ArchivoImportar): void {
    this.archivos = this.archivos.filter((x) => x !== a);
  }

  async importar(): Promise<void> {
    if (!this.puedeImportar) return;
    this.fase = 'importando';
    this.errorGeneral = '';
    let libretaDestino = this.destino === 'libreta' ? this.libretaId : null;
    for (const a of this.archivos) {
      a.estado = 'importando';
      a.mensaje = '';
      try {
        const r = await firstValueFrom(this.servicio.importar(a.file, {
          modo: a.esPdf ? 'una' : this.modo,
          seccionId: this.destino === 'seccion' ? this.seccionId : null,
          libretaId: libretaDestino,
          nombreLibreta: this.destino === 'nueva' ? this.nombreLibreta.trim() : undefined,
          nombreSeccion: a.seccionNombre.trim() || undefined,
        }));
        a.estado = 'ok';
        a.resultado = r;
        a.mensaje = r.paginas === 1 ? '1 página importada' : `${r.paginas} páginas importadas`;
        if (r.avisos.length) a.mensaje += ` · ${r.avisos.join(' ')}`;
        if (this.destino === 'nueva') libretaDestino = r.libretaId;
      } catch (e) {
        a.estado = 'error';
        a.mensaje = await mensajeDeError(e, 'No se pudo importar este archivo.');
      }
    }
    this.fase = 'fin';
  }

  get primeraImportada(): ManualImportacionResultado | undefined {
    return this.archivos.find((a) => a.estado === 'ok')?.resultado;
  }

  get hayErrores(): boolean { return this.archivos.some((a) => a.estado === 'error'); }

  abrir(): void {
    const r = this.primeraImportada;
    if (r) this.terminada.emit({ libretaId: r.libretaId, seccionId: r.seccionId, paginaId: r.primeraPaginaId });
    else this.cerrar.emit();
  }

  reintentarFallidos(): void {
    this.archivos = this.archivos.filter((a) => a.estado === 'error').map((a) => ({ ...a, estado: 'espera' as const, mensaje: '' }));
    this.destino = this.destino === 'nueva' ? 'libreta' : this.destino;
    this.libretaId = this.primeraImportada?.libretaId ?? this.libretaId;
    this.fase = 'config';
  }

  constructor(private servicio: ManualesService) {}
}
