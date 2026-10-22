import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IaService, ChatMensaje, ConversacionResumen, ModeloGeneral } from '../../services/ia.service';

export type ModoAsistente = 'axis' | 'general';

// Cada pestaña (Asistente AXIS / Modelos generales) tiene su propia lista de
// conversaciones, su conversación abierta y sus mensajes.
interface EstadoChat {
  conversaciones: ConversacionResumen[];
  cargandoConversaciones: boolean;
  // null = "conversacion nueva, todavia sin guardar" (antes del primer mensaje).
  conversacionActualId: number | null;
  mensajes: ChatMensaje[];
  cargandoHistorial: boolean;
  cargando: boolean;
  pregunta: string;
}

const MENSAJES_BIENVENIDA: Record<ModoAsistente, string> = {
  axis:
    '¡Hola! Soy el asistente de AXIS. Puedo responder con los datos de la aplicación (servidores, aplicaciones, sub-aplicativos, ' +
    'certificados, servicios, tareas, F5, pasos a producción y más), pero solo de los módulos que tienes habilitados. ¿Qué necesitas saber?',
  general:
    'Aquí puedes conversar con modelos de IA de uso general (redacción, código, explicaciones, ideas...). Elige el modelo arriba. ' +
    'Ojo: esta pestaña NO consulta la base de datos de AXIS; para eso usa la pestaña "Asistente AXIS". No escribas contraseñas ni datos de clientes.'
};

const PLACEHOLDER: Record<ModoAsistente, string> = {
  axis: 'Pregúntame por servidores, aplicaciones, certificados, tareas, F5...',
  general: 'Escribe tu pregunta para el modelo...'
};

@Component({
  selector: 'app-asistente',
  standalone: true,
  imports: [CommonModule, FormsModule], // Importante para usar ngIf, ngFor y ngModel
  templateUrl: './asistente.component.html',
  styleUrl: './asistente.component.scss'
})
export class AsistenteComponent implements OnInit {
  @ViewChild('chatContainer') private chatContainer!: ElementRef;

  modo: ModoAsistente = 'axis';

  private estados: Record<ModoAsistente, EstadoChat> = {
    axis: this.estadoInicial('axis'),
    general: this.estadoInicial('general')
  };

  // Modelos generales (Open WebUI)
  modelos: ModeloGeneral[] = [];
  modeloSeleccionado = '';
  cargandoModelos = false;
  errorModelos = '';
  private modelosCargados = false;

  constructor(private iaService: IaService) {}

  private estadoInicial(modo: ModoAsistente): EstadoChat {
    return {
      conversaciones: [],
      cargandoConversaciones: true,
      conversacionActualId: null,
      mensajes: [this.bienvenida(modo)],
      cargandoHistorial: modo === 'axis',
      cargando: false,
      pregunta: ''
    };
  }

  private bienvenida(modo: ModoAsistente): ChatMensaje {
    return { emisor: 'ia', texto: MENSAJES_BIENVENIDA[modo], fecha: new Date() };
  }

  // El estado de la pestaña activa (el HTML trabaja siempre con `est`).
  get est(): EstadoChat {
    return this.estados[this.modo];
  }

  get placeholder(): string {
    return PLACEHOLDER[this.modo];
  }

  ngOnInit(): void {
    try {
      this.modeloSeleccionado = localStorage.getItem('asistente_modelo_general') || '';
    } catch { /* sin almacenamiento: se elige de nuevo */ }
    this.cargarListaConversaciones('axis', true);
  }

  cambiarModo(modo: ModoAsistente): void {
    if (this.modo === modo) return;
    this.modo = modo;
    if (modo === 'general') {
      if (!this.modelosCargados) this.cargarModelos();
      if (this.est.cargandoConversaciones && this.est.conversaciones.length === 0) this.cargarListaConversaciones('general', false);
    }
    this.hacerScrollAbajo();
  }

  // ---------- Modelos generales ----------
  cargarModelos(): void {
    this.cargandoModelos = true;
    this.errorModelos = '';
    this.iaService.listarModelosGenerales().subscribe({
      next: (res) => {
        this.modelos = res.modelos || [];
        this.modelosCargados = true;
        this.cargandoModelos = false;
        if (!this.modelos.some((m) => m.id === this.modeloSeleccionado)) {
          this.modeloSeleccionado = this.modelos.length ? this.modelos[0].id : '';
        }
        if (!this.modelos.length) this.errorModelos = 'El servidor no tiene modelos disponibles.';
      },
      error: (err) => {
        this.cargandoModelos = false;
        this.errorModelos = err.error?.error || 'No se pudo consultar la lista de modelos.';
      }
    });
  }

  guardarModelo(): void {
    try {
      localStorage.setItem('asistente_modelo_general', this.modeloSeleccionado);
    } catch { /* opcional */ }
  }

  nombreModelo(): string {
    return this.modelos.find((m) => m.id === this.modeloSeleccionado)?.nombre || this.modeloSeleccionado;
  }

  // ---------- Conversaciones ----------
  // recienEntrando=true: si hay conversaciones, abre automaticamente la mas
  // reciente (al entrar por primera vez a la pantalla). En false solo
  // refresca la lista, sin tocar lo que se esta viendo.
  private cargarListaConversaciones(modo: ModoAsistente, recienEntrando: boolean): void {
    const e = this.estados[modo];
    this.iaService.listarConversaciones(modo).subscribe({
      next: (lista) => {
        e.conversaciones = lista;
        e.cargandoConversaciones = false;
        if (recienEntrando && lista.length > 0) {
          this.abrirConversacion(lista[0].conversacionId, modo);
        } else if (recienEntrando) {
          e.cargandoHistorial = false;
        }
      },
      error: (err) => {
        console.error('No se pudo cargar la lista de conversaciones:', err);
        e.cargandoConversaciones = false;
        e.cargandoHistorial = false;
      }
    });
  }

  // Cada usuario ve solo sus propias conversaciones (el backend filtra por
  // el usuario del token).
  abrirConversacion(conversacionId: number, modo: ModoAsistente = this.modo): void {
    const e = this.estados[modo];
    if (e.cargando) return; // no cambiar de chat mientras espera una respuesta
    e.cargandoHistorial = true;
    e.conversacionActualId = conversacionId;
    this.iaService.obtenerConversacion(conversacionId).subscribe({
      next: (filas) => {
        e.mensajes = filas.length > 0
          ? filas.map((f) => ({
              emisor: f.rol === 'assistant' ? 'ia' : 'usuario',
              texto: f.mensaje,
              fecha: new Date(f.fecha)
            }))
          : [this.bienvenida(modo)];
        e.cargandoHistorial = false;
        this.hacerScrollAbajo();
      },
      error: (err) => {
        console.error('No se pudo cargar la conversacion:', err);
        e.cargandoHistorial = false;
      }
    });
  }

  // Botón "+ Nueva conversación": limpia la pantalla; el hilo real recien se
  // crea en el backend con el PRIMER mensaje que se envie desde aca.
  nuevaConversacion(): void {
    const e = this.est;
    if (e.cargando) return;
    e.conversacionActualId = null;
    e.mensajes = [this.bienvenida(this.modo)];
  }

  puedeEnviar(): boolean {
    const e = this.est;
    if (!e.pregunta.trim() || e.cargando) return false;
    if (this.modo === 'general' && !this.modeloSeleccionado) return false;
    return true;
  }

  enviarMensaje(): void {
    if (!this.puedeEnviar()) return;
    const modo = this.modo;
    const e = this.est;

    const textoUsuario = e.pregunta;
    e.mensajes.push({ emisor: 'usuario', texto: textoUsuario, fecha: new Date() });
    e.pregunta = '';
    e.cargando = true;
    this.hacerScrollAbajo();

    // TODO el historial de la conversación va al backend (él recorta lo que
    // manda al modelo). Roles: 'user' (usuario) y 'assistant' (IA).
    const historialParaEnviar = e.mensajes.map((m) => ({
      role: m.emisor === 'ia' ? 'assistant' : 'user',
      content: m.texto
    }));

    const esConversacionNueva = e.conversacionActualId === null;
    const peticion = modo === 'axis'
      ? this.iaService.enviarPregunta(historialParaEnviar as any, e.conversacionActualId)
      : this.iaService.enviarPreguntaGeneral(this.modeloSeleccionado, historialParaEnviar as any, e.conversacionActualId);

    peticion.subscribe({
      next: (res) => {
        e.mensajes.push({ emisor: 'ia', texto: res.reply, fecha: new Date() });
        e.conversacionActualId = res.conversacionId;
        e.cargando = false;
        this.hacerScrollAbajo();
        // Si este mensaje creo una conversacion nueva, refresca el panel lateral.
        if (esConversacionNueva) this.cargarListaConversaciones(modo, false);
      },
      error: (err) => {
        console.error(err);
        e.mensajes.push({
          emisor: 'ia',
          texto: err.error?.error || 'Hubo un error de conexión con el servidor.',
          fecha: new Date()
        });
        e.cargando = false;
        this.hacerScrollAbajo();
      }
    });
  }

  // Permite enviar el mensaje presionando la tecla Enter
  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.enviarMensaje();
    }
  }

  // Formato mínimo para las respuestas del asistente: se escapa TODO el HTML y
  // solo se reconocen bloques de código, `código en línea` y **negritas**.
  formatear(texto: string): string {
    const escapar = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const partes = String(texto || '').split(/```/);
    return partes
      .map((parte, i) => {
        if (i % 2 === 1) {
          // Bloque de código: se descarta la primera línea si es solo el lenguaje.
          const cuerpo = parte.replace(/^[a-zA-Z0-9+#_-]*\n/, '');
          return `<pre class="bloque-codigo"><code>${escapar(cuerpo.replace(/\n$/, ''))}</code></pre>`;
        }
        return escapar(parte)
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
      })
      .join('');
  }

  // Mueve el scroll hacia abajo automáticamente cuando hay nuevos mensajes
  private hacerScrollAbajo(): void {
    setTimeout(() => {
      try {
        this.chatContainer.nativeElement.scrollTop = this.chatContainer.nativeElement.scrollHeight;
      } catch (err) {}
    }, 100);
  }
}
