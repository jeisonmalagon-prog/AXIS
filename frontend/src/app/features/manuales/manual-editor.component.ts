import {
  AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, Output, ViewChild, ViewEncapsulation,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';
import { comprimirImagen } from './manuales-util';

// Imagen con ancho opcional (se usa para achicar capturas grandes).
const ImagenConAncho = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('width'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs['width'] ? { width: attrs['width'] } : {}),
      },
    };
  },
});

const COLORES_TEXTO = [
  { nombre: 'Rojo', valor: '#dc2626' },
  { nombre: 'Naranja', valor: '#ea580c' },
  { nombre: 'Verde', valor: '#16a34a' },
  { nombre: 'Azul', valor: '#2563eb' },
  { nombre: 'Morado', valor: '#7c3aed' },
  { nombre: 'Gris', valor: '#64748b' },
];
const COLORES_RESALTADO = [
  { nombre: 'Amarillo', valor: '#fef08a' },
  { nombre: 'Verde', valor: '#bbf7d0' },
  { nombre: 'Celeste', valor: '#bae6fd' },
  { nombre: 'Rosa', valor: '#fbcfe8' },
];

@Component({
  selector: 'app-manual-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  encapsulation: ViewEncapsulation.None,
  templateUrl: './manual-editor.component.html',
  styleUrl: './manual-editor.component.scss',
})
export class ManualEditorComponent implements AfterViewInit, OnDestroy {
  /** Contenido inicial (HTML ya limpio por el servidor). Para cargar otra página se vuelve a crear el componente. */
  @Input() html = '';
  /** Si es false (página nueva) el cursor no se mueve al contenido, para dejar el foco en el título. */
  @Input() enfocar = true;
  @Output() cambio = new EventEmitter<string>();
  @Output() aviso = new EventEmitter<string>();
  @ViewChild('anfitrion', { static: true }) anfitrion!: ElementRef<HTMLElement>;
  @ViewChild('archivoImagen', { static: true }) archivoImagen!: ElementRef<HTMLInputElement>;

  editor: Editor | null = null;
  readonly coloresTexto = COLORES_TEXTO;
  readonly coloresResaltado = COLORES_RESALTADO;
  menu: '' | 'color' | 'resaltado' | 'tabla' | 'enlace' = '';
  enlaceUrl = '';

  constructor(private zona: NgZone, private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    this.editor = new Editor({
      element: this.anfitrion.nativeElement,
      content: this.html || '',
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: { HTMLAttributes: { class: 'language-bash' } } }),
        Underline,
        TextStyle,
        Color,
        Highlight.configure({ multicolor: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
        ImagenConAncho.configure({ inline: false, allowBase64: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({ placeholder: 'Escribe aquí… Puedes pegar capturas de pantalla con Ctrl+V.' }),
      ],
      editorProps: {
        attributes: { class: 'man-contenido man-editable', spellcheck: 'true' },
        handlePaste: (_vista, evento) => this.alPegar(evento),
        handleDrop: (_vista, evento) => this.alSoltar(evento),
      },
      onUpdate: ({ editor }) => this.cambio.emit(editor.getHTML()),
      onTransaction: () => this.cdr.markForCheck(),
    });
    // Al abrir un manual el cursor queda al inicio del contenido.
    if (this.enfocar) setTimeout(() => this.editor?.commands.focus('end'), 0);
  }

  ngOnDestroy(): void {
    this.editor?.destroy();
    this.editor = null;
  }

  // ---------- imágenes ----------

  private archivosDeImagen(lista: FileList | null | undefined): File[] {
    return Array.from(lista || []).filter((f) => f.type.startsWith('image/'));
  }

  private alPegar(evento: ClipboardEvent): boolean {
    const imagenes = this.archivosDeImagen(evento.clipboardData?.files);
    if (!imagenes.length) return false;
    evento.preventDefault();
    void this.insertarImagenes(imagenes);
    return true;
  }

  private alSoltar(evento: DragEvent): boolean {
    const imagenes = this.archivosDeImagen(evento.dataTransfer?.files);
    if (!imagenes.length) return false;
    evento.preventDefault();
    void this.insertarImagenes(imagenes);
    return true;
  }

  elegirImagen(): void {
    this.archivoImagen.nativeElement.click();
  }

  alElegirImagen(): void {
    const entrada = this.archivoImagen.nativeElement;
    const imagenes = this.archivosDeImagen(entrada.files);
    entrada.value = '';
    if (imagenes.length) void this.insertarImagenes(imagenes);
  }

  private async insertarImagenes(archivos: File[]): Promise<void> {
    for (const archivo of archivos) {
      try {
        const src = await comprimirImagen(archivo);
        this.zona.run(() => this.editor?.chain().focus().setImage({ src, alt: archivo.name || 'captura' }).run());
      } catch {
        this.aviso.emit('No se pudo insertar una de las imágenes.');
      }
    }
  }

  anchoImagen(porcentaje: number | null): void {
    this.editor?.chain().focus().updateAttributes('image', { width: porcentaje ? `${porcentaje}%` : null }).run();
  }

  // ---------- comandos ----------

  activo(nombre: string, atributos?: Record<string, unknown>): boolean {
    return !!this.editor?.isActive(nombre, atributos);
  }

  estiloBloque(): string {
    const e = this.editor;
    if (!e) return 'p';
    for (const n of [1, 2, 3]) if (e.isActive('heading', { level: n })) return `h${n}`;
    if (e.isActive('codeBlock')) return 'code';
    return 'p';
  }

  cambiarEstilo(valor: string): void {
    const c = this.editor?.chain().focus();
    if (!c) return;
    if (valor === 'p') c.setParagraph().run();
    else if (valor === 'code') c.setCodeBlock().run();
    else c.setHeading({ level: Number(valor.slice(1)) as 1 | 2 | 3 }).run();
  }

  cmd(nombre: string): void {
    const c = this.editor?.chain().focus();
    if (!c) return;
    switch (nombre) {
      case 'negrita': c.toggleBold().run(); break;
      case 'cursiva': c.toggleItalic().run(); break;
      case 'subrayado': c.toggleUnderline().run(); break;
      case 'tachado': c.toggleStrike().run(); break;
      case 'codigoLinea': c.toggleCode().run(); break;
      case 'bloqueCodigo': c.toggleCodeBlock().run(); break;
      case 'viñetas': c.toggleBulletList().run(); break;
      case 'numerada': c.toggleOrderedList().run(); break;
      case 'cita': c.toggleBlockquote().run(); break;
      case 'linea': c.setHorizontalRule().run(); break;
      case 'deshacer': c.undo().run(); break;
      case 'rehacer': c.redo().run(); break;
      case 'izquierda': c.setTextAlign('left').run(); break;
      case 'centro': c.setTextAlign('center').run(); break;
      case 'limpiar': c.unsetAllMarks().clearNodes().run(); break;
      default: break;
    }
  }

  puede(nombre: 'deshacer' | 'rehacer'): boolean {
    const e = this.editor;
    if (!e) return false;
    return nombre === 'deshacer' ? e.can().undo() : e.can().redo();
  }

  // ---------- colores ----------

  ponerColor(valor: string | null): void {
    const c = this.editor?.chain().focus();
    if (!c) return;
    if (valor) c.setColor(valor).run(); else c.unsetColor().run();
    this.menu = '';
  }

  ponerResaltado(valor: string | null): void {
    const c = this.editor?.chain().focus();
    if (!c) return;
    if (valor) c.setHighlight({ color: valor }).run(); else c.unsetHighlight().run();
    this.menu = '';
  }

  // ---------- tabla ----------

  tablaCmd(nombre: string): void {
    const c = this.editor?.chain().focus();
    if (!c) return;
    switch (nombre) {
      case 'insertar': c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
      case 'filaMas': c.addRowAfter().run(); break;
      case 'filaMenos': c.deleteRow().run(); break;
      case 'colMas': c.addColumnAfter().run(); break;
      case 'colMenos': c.deleteColumn().run(); break;
      case 'quitar': c.deleteTable().run(); break;
      default: break;
    }
    if (nombre === 'insertar') this.menu = '';
  }

  // ---------- enlaces ----------

  abrirEnlace(): void {
    const previo = this.editor?.getAttributes('link')['href'];
    this.enlaceUrl = typeof previo === 'string' ? previo : '';
    this.menu = this.menu === 'enlace' ? '' : 'enlace';
  }

  aplicarEnlace(): void {
    const c = this.editor?.chain().focus();
    if (!c) return;
    let url = this.enlaceUrl.trim();
    if (!url) { c.extendMarkRange('link').unsetLink().run(); this.menu = ''; return; }
    if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) url = `https://${url}`;
    c.extendMarkRange('link').setLink({ href: url }).run();
    this.menu = '';
  }

  quitarEnlace(): void {
    this.editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    this.menu = '';
  }

  alternarMenu(m: 'color' | 'resaltado' | 'tabla'): void {
    this.menu = this.menu === m ? '' : m;
  }
}
