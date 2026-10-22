import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// Forma mínima de opción que acepta el selector — a propósito es un
// subconjunto de OpcionIntegracion (servidores.component.ts) para poder
// pasarle esa misma lista sin necesidad de transformarla antes.
export interface OpcionSelector {
  id: any;
  nombre: string;
  subtitulo?: string;
}

// Combobox reutilizable: un <input> de texto que filtra una lista larga de
// opciones (servidores, etc.) en vez de un <select> plano con cientos de
// filas. Se usa con el mismo patrón que un <select> con [ngModel]/(ngModelChange):
//   <app-selector-buscable [opciones]="..." [valor]="x" (valorChange)="x = $event"></app-selector-buscable>
@Component({
  selector: 'app-selector-buscable',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './selector-buscable.component.html',
  styleUrl: './selector-buscable.component.scss',
})
export class SelectorBuscableComponent implements OnChanges {
  @Input() opciones: OpcionSelector[] = [];
  @Input() valor: any = null;
  @Input() placeholder = 'Buscar...';
  @Input() deshabilitado = false;
  // Texto a mostrar cuando `opciones` viene vacío (p. ej. "primero elige un
  // servidor" o "ningún servidor tiene esa plataforma todavía").
  @Input() textoVacio: string | null = null;
  @Input() permitirLimpiar = true;

  // Modo "texto libre con catálogo" (ej. personas responsables): además de
  // elegir una opción ya existente, cuando lo escrito no coincide con
  // ninguna aparece una fila "+ Agregar '...'" al final de la lista. Se usa
  // con opciones donde id === nombre (un catálogo de strings, no de ids
  // numéricos) — por eso solo tiene sentido activarlo ahí; el resto de usos
  // de este selector (elegir un servidor/aplicativo ya registrado) lo deja
  // en false, su valor por defecto, y no cambian en nada.
  @Input() permitirAgregar = false;

  @Output() valorChange = new EventEmitter<any>();
  // Se dispara cuando el usuario confirma "+ Agregar '...'", con el texto tal
  // cual lo escribió — quien use el selector decide qué hacer con eso (acá,
  // persistirlo en el catálogo compartido). valorChange también se emite en
  // el mismo click, así que no hace falta asignar el valor aparte.
  @Output() agregar = new EventEmitter<string>();

  textoFiltro = '';
  abierto = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['valor'] || changes['opciones']) {
      this.sincronizarTexto();
    }
  }

  private sincronizarTexto(): void {
    if (this.abierto) return; // no pisar lo que el usuario está escribiendo
    const opcion = this.opciones.find((o) => o.id === this.valor);
    if (opcion) {
      this.textoFiltro = opcion.nombre;
    } else if (this.permitirAgregar && typeof this.valor === 'string' && this.valor) {
      // Modo texto libre: un valor capturado antes de que existiera este
      // catálogo (o que todavía no se agregó a él) se sigue mostrando tal
      // cual, en vez de dejar el campo vacío como si el dato se hubiera
      // perdido.
      this.textoFiltro = this.valor;
    } else {
      this.textoFiltro = '';
    }
  }

  get opcionSeleccionada(): OpcionSelector | undefined {
    return this.opciones.find((o) => o.id === this.valor);
  }

  get opcionesFiltradas(): OpcionSelector[] {
    const termino = this.textoFiltro.trim().toLowerCase();
    if (!termino) return this.opciones;
    // Si el texto en el input todavía es el de la opción ya elegida (recién
    // se abrió el combobox sin escribir nada nuevo), se muestran todas —
    // evita que el filtro "se coma" la lista con el nombre ya puesto.
    const seleccionada = this.opcionSeleccionada;
    if (seleccionada && seleccionada.nombre.toLowerCase() === termino) {
      return this.opciones;
    }
    // Búsqueda por palabras: cada palabra escrita debe aparecer en el nombre o
    // en el subtítulo (así "api movil" encuentra "API_APP_MOVIL · srv01").
    // Con un solo término sigue siendo una búsqueda por subcadena.
    const palabras = termino.split(/\s+/).filter(Boolean);
    return this.opciones.filter((o) => {
      const texto = (o.nombre + ' ' + (o.subtitulo || '')).toLowerCase();
      return palabras.every((p) => texto.includes(p));
    });
  }

  abrir(): void {
    if (this.deshabilitado) return;
    this.abierto = true;
    // Al enfocar se limpia el texto para partir de la lista completa y
    // dejar escribir el filtro desde cero.
    this.textoFiltro = '';
  }

  elegir(op: OpcionSelector): void {
    this.valor = op.id;
    this.textoFiltro = op.nombre;
    this.abierto = false;
    this.valorChange.emit(op.id);
  }

  // Sólo tiene sentido con permitirAgregar=true (ver comentario en el
  // @Input): no ofrecer "+ Agregar" si ya existe una opción con ese mismo
  // nombre (sin distinguir mayúsculas), para no invitar a crear un
  // duplicado cuando basta con elegir la que ya está en la lista.
  get mostrarOpcionAgregar(): boolean {
    if (!this.permitirAgregar) return false;
    const termino = this.textoFiltro.trim();
    if (!termino) return false;
    return !this.opciones.some((o) => o.nombre.toLowerCase() === termino.toLowerCase());
  }

  elegirAgregar(): void {
    const nombreNuevo = this.textoFiltro.trim();
    if (!nombreNuevo) return;
    this.valor = nombreNuevo;
    this.textoFiltro = nombreNuevo;
    this.abierto = false;
    this.agregar.emit(nombreNuevo);
    this.valorChange.emit(nombreNuevo);
  }

  limpiar(): void {
    this.valor = null;
    this.textoFiltro = '';
    this.abierto = false;
    this.valorChange.emit(null);
  }

  alPerderFoco(): void {
    // mousedown en una opción ocurre ANTES que este blur, así que retrasar el
    // cierre le da tiempo a (mousedown)="elegir(...)" de registrarse.
    setTimeout(() => {
      this.abierto = false;
      this.sincronizarTexto();
    }, 150);
  }
}
