import { Component, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';

// ============================================================================
// Detalle de UNA fila del log (GET /app-movil/logs/detalle), pensado para
// personas que no son técnicas: lo que la app pidió (Rq), lo que respondió el
// servicio (Rs) y los datos adicionales, ya traducidos a lenguaje normal.
// NO se oculta información: lo que está en el log se muestra tal cual (el
// texto original siempre queda disponible). Que una fila no tenga Rq, Rs o
// Datos NO significa que el servicio no haya respondido: muchas filas del log
// son solo "avisos" internos (inicio de operación, pasos) que por diseño no
// traen esos campos.
// ============================================================================

export type EstadoFila = 'exito' | 'error' | 'aviso' | 'inicio' | 'paso' | 'info';

export interface NodoTraducido {
  e: string;          // etiqueta en lenguaje normal
  t?: string;         // nombre técnico original
  v?: string;         // valor
  nota?: string;      // aclaración (ej. significado de un código)
  h?: NodoTraducido[]; // hijos
  n?: number;         // cantidad de elementos (listas)
  mas?: number;       // elementos omitidos por tamaño
  indice?: boolean;   // elemento numerado de una lista
  vacio?: boolean;
}

export interface EstadoServicio {
  origen: string;
  codigo: string | null;
  severidad: string | null;
  mensaje: string | null;
  nivel: 'ok' | 'info' | 'aviso' | 'error';
  traduccion?: string | null;
}

export interface SeccionTraducida {
  formato: 'xml' | 'json' | 'consulta' | 'texto' | 'error' | 'vacio';
  resumen: string | null;
  destino: string | null;
  operacion: string | null;
  http: number | null;
  estados: EstadoServicio[];
  nodos: NodoTraducido[];
  tecnicos: NodoTraducido[];
  texto: string | null;
  nota: string | null;
  tecnico?: string | null;
  omitidos: number;
  truncado: boolean;
  original: string;
}

export interface TraduccionFila {
  tipo: string;
  tipoTexto: string;
  estado: EstadoFila;
  estadoTexto: string;
  servicioDetalle: string | null;
  queHace: string | null;
  rq: SeccionTraducida | null;
  rs: SeccionTraducida | null;
  datos: SeccionTraducida | null;
  vacios: { rq: string | null; rs: string | null; datos: string | null };
}

export interface FilaRelacionada {
  codigo: number;
  fechaTxt: string;
  hora: string;
  descripcion: string | null;
  tipoTexto: string;
  estado: EstadoFila;
  estadoTexto: string;
  actual: boolean;
}

export interface DetalleLog {
  codigo: number;
  fechaTxt: string;
  documento: string | null;
  servicio: string;
  metodo: string;
  clase: string | null;
  descripcion: string | null;
  canalCodigo: number | null;
  funcionalidadCodigo: number | null;
  tipoCodigo: number | null;
  procesoCodigo: number | null;
  transaccion: string | null;
  ip: string | null;
  dispositivo: string;
  version?: string | null;
  nodo?: number | null;
  equipo?: string | null;
  sesion: SeccionTraducida | null;
  traduccion: TraduccionFila;
  relacionadas: FilaRelacionada[];
  original: { rq: string; rs: string; adicional: string; sesion: string };
}

type ModoArbol = 'normal' | 'todo' | 'ninguno';

@Component({
  selector: 'app-log-detalle',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './log-detalle.component.html',
  styleUrl: './log-detalle.component.scss'
})
export class LogDetalleComponent implements OnChanges, OnDestroy {
  /** Código (clave) de la fila del log a mostrar. */
  @Input() codigo: number | null = null;
  /** Fecha de la fila (AAAA-MM-DD o con hora): sirve para saber en qué tabla mensual buscarla. */
  @Input() fecha = '';
  @Output() cerrar = new EventEmitter<void>();

  cargando = false;
  error: string | null = null;
  detalle: DetalleLog | null = null;
  modoArbol: ModoArbol = 'normal';
  /** Secciones cuyo texto original está desplegado. */
  originalAbierto = new Set<string>();
  copiado: string | null = null;

  private suscripcion?: Subscription;
  private temporizadorCopia?: ReturnType<typeof setTimeout>;
  private apiUrl = `${environment.apiUrl}/app-movil`;

  constructor(private http: HttpClient) {}

  ngOnChanges(cambios: SimpleChanges): void {
    if ((cambios['codigo'] || cambios['fecha']) && this.codigo) this.cargar(this.codigo, this.fecha);
  }

  ngOnDestroy(): void {
    this.suscripcion?.unsubscribe();
    if (this.temporizadorCopia) clearTimeout(this.temporizadorCopia);
  }

  @HostListener('document:keydown.escape')
  alEscape(): void { this.cerrar.emit(); }

  cargar(codigo: number, fecha: string): void {
    this.suscripcion?.unsubscribe();
    this.cargando = true;
    this.error = null;
    this.originalAbierto = new Set<string>();
    this.modoArbol = 'normal';
    const params = new HttpParams().set('codigo', String(codigo)).set('fecha', String(fecha).slice(0, 10));
    this.suscripcion = this.http.get<DetalleLog>(`${this.apiUrl}/logs/detalle`, { params }).subscribe({
      next: (d) => { this.detalle = d; this.cargando = false; },
      error: (err: HttpErrorResponse) => {
        this.cargando = false;
        this.detalle = null;
        this.error = err.error?.error || 'No se pudo leer el detalle de este registro. Intenta de nuevo.';
      }
    });
  }

  verRelacionada(f: FilaRelacionada): void {
    if (f.actual) return;
    this.cargar(f.codigo, f.fechaTxt);
  }

  alternarOriginal(clave: string): void {
    const copia = new Set(this.originalAbierto);
    if (copia.has(clave)) copia.delete(clave); else copia.add(clave);
    this.originalAbierto = copia;
  }

  fijarArbol(modo: ModoArbol): void { this.modoArbol = modo; }

  abierto(nivel: number): boolean {
    return this.modoArbol === 'todo' || (this.modoArbol === 'normal' && nivel < 2);
  }

  async copiar(clave: string, texto: string): Promise<void> {
    let ok = false;
    try {
      await navigator.clipboard.writeText(texto);
      ok = true;
    } catch {
      const area = document.createElement('textarea');
      area.value = texto;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      document.body.removeChild(area);
    }
    this.copiado = ok ? clave : null;
    if (this.temporizadorCopia) clearTimeout(this.temporizadorCopia);
    this.temporizadorCopia = setTimeout(() => { this.copiado = null; }, 2200);
  }

  /** Texto en claro de una sección (para copiar). */
  textoPlano(s: SeccionTraducida | null): string {
    if (!s) return '';
    const lineas: string[] = [];
    if (s.resumen) lineas.push(s.resumen);
    if (s.destino) lineas.push(`Destino: ${s.destino}`);
    if (s.operacion) lineas.push(`Operación: ${s.operacion}`);
    for (const e of s.estados) lineas.push(`${e.origen}: ${[e.codigo ? 'código ' + e.codigo : '', e.severidad ?? '', e.mensaje ?? ''].filter(Boolean).join(' · ')}`);
    const recorrer = (nodos: NodoTraducido[], sangria: string): void => {
      for (const n of nodos) {
        lineas.push(`${sangria}${n.e}${n.v !== undefined ? ': ' + n.v : ''}${n.nota ? ' (' + n.nota + ')' : ''}`);
        if (n.h) recorrer(n.h, sangria + '  ');
      }
    };
    recorrer(s.nodos, '');
    if (s.texto) lineas.push(s.texto);
    return lineas.join('\n');
  }

  claseEstado(e: string): string {
    if (e === 'exito') return 'pill pill--ok';
    if (e === 'error') return 'pill pill--error';
    if (e === 'aviso') return 'pill pill--warn';
    if (e === 'inicio') return 'pill pill--info';
    return 'pill';
  }

  icono(e: string): string {
    if (e === 'exito' || e === 'ok') return '✓';
    if (e === 'error') return '✕';
    if (e === 'aviso') return '!';
    if (e === 'inicio') return '▶';
    return 'i';
  }

  tieneDatosTecnicos(s: SeccionTraducida | null): boolean {
    return !!s && (s.tecnicos.length > 0 || !!s.tecnico);
  }

  trackRel(_: number, f: FilaRelacionada): number { return f.codigo; }
}
