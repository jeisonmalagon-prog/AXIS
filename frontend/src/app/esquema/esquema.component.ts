import { Component, OnInit, OnDestroy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { AplicacionService } from '../core/services/aplicacion.service'; // Asegúrate de que esta ruta coincida con tu estructura
import { HttpClient } from '@angular/common/http';
import { AuthService } from '../services/auth.service';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-esquema',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './esquema.component.html',
  styleUrl: './esquema.component.scss'
})
export class EsquemaComponent implements OnInit, OnDestroy {
  @ViewChild('drawioIframe') drawioIframe!: ElementRef<HTMLIFrameElement>;

  // ⚠️ Debe coincidir EXACTAMENTE con el origen de la URL del iframe.
  // Se usa tanto para construir la URL como para validar los mensajes recibidos.
  private readonly DRAWIO_ORIGIN = 'https://embed.diagrams.net';

  appSeleccionadaId: number | null = null;
  aplicacionesDisponibles: any[] = [];
  iframeUrl!: SafeResourceUrl;

  xmlDiagramaActual: string | null = null;

  // Solo ADMIN_POD/ADMIN_MIN pueden editar/guardar el diagrama. BASIC = solo ver.
  // No confiamos únicamente en drawio para esto: además de ocultar su botón
  // nativo de Guardar, ponemos una capa transparente sobre el iframe (ver
  // esquema.component.html) que bloquea cualquier clic/arrastre en el canvas.
  puedeEditar = false;

  // --- Estados de UI ---
  iframeListo = false;        // true cuando drawio confirma el evento 'init'
  estaCargandoDiagrama = false; // true mientras pedimos el XML a la BD
  estaGuardando = false;       // true mientras persistimos el XML en la BD
  ultimoGuardadoOk: boolean | null = null; // feedback visual del último guardado

  private windowListener: any;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private aplicacionService: AplicacionService,
    private http: HttpClient,
    private sanitizer: DomSanitizer,
    private authService: AuthService
  ) {
    this.puedeEditar = this.authService.puedeEditar('CERTIFICADOS');

    // 🔧 FIX PRINCIPAL:
    // "viewer.diagrams.net" es el VISOR de solo lectura y NO implementa el
    // protocolo postMessage (init / load / save / exit) de la misma forma.
    // Para embeber el EDITOR real hay que usar "embed.diagrams.net".
    //
    // Parámetros usados:
    // - embed=1        -> modo embebido (sin la landing page de drawio)
    // - proto=json      -> comunicación por postMessage con mensajes JSON
    // - spin=1          -> muestra un spinner nativo mientras carga
    // - ui=min          -> interfaz minimalista, más moderna y compacta
    // - saveAndExit=0   -> "Guardar" no cierra el editor
    // - noSaveBtn       -> oculto para BASIC (no tiene sentido mostrar un botón
    //                      de guardar que además bloqueamos con la capa de solo lectura)
    // - noExitBtn=0     -> muestra el botón nativo de Salir
    // - lightbox=1      -> SOLO para modo solo lectura (BASIC): oculta los paneles
    //                      de "Formas" y "Formato" (que no tiene sentido mostrar si
    //                      no puede editar), dejando visibles los controles de
    //                      zoom/ajustar página para poder navegar el diagrama.
    const noSaveBtn = this.puedeEditar ? 0 : 1;
    const lightbox = this.puedeEditar ? '' : '&lightbox=1';
    const rawUrl =
      `${this.DRAWIO_ORIGIN}/?embed=1&proto=json&spin=1&ui=min` +
      `&saveAndExit=0&noSaveBtn=${noSaveBtn}&noExitBtn=0&libraries=0${lightbox}`;

    this.iframeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(rawUrl);
  }

  ngOnInit() {
    const idParam = this.route.snapshot.paramMap.get('id');
    this.appSeleccionadaId = idParam ? parseInt(idParam, 10) : null;

    this.aplicacionService.listar().subscribe({
      next: (res: any) => this.aplicacionesDisponibles = res,
      error: (err) => console.error('Error cargando lista de apps:', err)
    });

    this.windowListener = this.recibirMensajeDrawIo.bind(this);
    window.addEventListener('message', this.windowListener);

    if (this.appSeleccionadaId) {
      this.cargarEsquemaDeBD(this.appSeleccionadaId);
    }
  }

  ngOnDestroy() {
    if (this.windowListener) {
      window.removeEventListener('message', this.windowListener);
    }
  }

  volver() {
    this.router.navigate(['/aplicaciones']);
  }

  cambiarAplicacion(nuevoId: number) {
    this.appSeleccionadaId = nuevoId;
    this.cargarEsquemaDeBD(nuevoId);
  }



  recibirMensajeDrawIo(event: MessageEvent) {
    // 🔒 Validación de seguridad: solo aceptamos mensajes que vengan
    // realmente del origen de drawio y de NUESTRO iframe concreto.
    if (event.origin !== this.DRAWIO_ORIGIN) return;
    if (event.source !== this.drawioIframe?.nativeElement?.contentWindow) return;
    if (!event.data || typeof event.data !== 'string') return;

    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      // Mensajes no-JSON (o de otras librerías) se ignoran silenciosamente
      return;
    }

    switch (msg.event) {
      case 'init':
        // El editor ya está listo para recibir el XML
        this.iframeListo = true;
        this.cargarXmlEnDrawIo();
        break;

      case 'save':
        // BASIC no puede guardar aunque, por lo que sea, este mensaje llegue
        // (defensa en profundidad; la capa transparente ya debería impedir
        // que se dispare desde la interacción del usuario).
        if (!this.puedeEditar) return;
        this.guardarEsquemaEnBD(msg.xml);
        break;

      case 'exit':
        this.volver();
        break;
    }
  }

  cargarXmlEnDrawIo() {
    // No podemos enviar el XML hasta que el iframe exista Y drawio haya
    // confirmado 'init'; si no, el mensaje se pierde en el vacío.
    if (!this.drawioIframe?.nativeElement || !this.iframeListo) return;

    const payload = {
      action: 'load',
      autosave: 1,
      xml: this.xmlDiagramaActual || ''
    };

    this.drawioIframe.nativeElement.contentWindow?.postMessage(
      JSON.stringify(payload),
      this.DRAWIO_ORIGIN
    );
  }

cargarEsquemaDeBD(appId: number) {
    // Agregamos la URL completa del backend
    this.http.get<{ xml: string }>(`${environment.apiUrl}/esquemas/${appId}`).subscribe({
      next: (res) => {
        this.xmlDiagramaActual = res ? res.xml : null;
        this.cargarXmlEnDrawIo();
      },
      error: () => {
        this.xmlDiagramaActual = null;
        this.cargarXmlEnDrawIo();
      }
    });
  }

  guardarEsquemaEnBD(xmlData: string) {
    if (!this.puedeEditar) return; // BASIC: solo lectura, nunca persiste cambios
    if (!this.appSeleccionadaId) return;

    // Agregamos la URL completa del backend
    this.http.post(`${environment.apiUrl}/esquemas/${this.appSeleccionadaId}`, { xml: xmlData }).subscribe({
      next: () => {
        alert('¡Diagrama guardado correctamente en la base de datos!');
        if (this.drawioIframe && this.drawioIframe.nativeElement) {
          this.drawioIframe.nativeElement.contentWindow?.postMessage(
            JSON.stringify({ action: 'status', message: 'Guardado exitosamente', modified: false }), '*'
          );
        }
      },
      error: (err) => {
        alert('Error guardando el esquema en BD: ' + err.message);
        if (this.drawioIframe && this.drawioIframe.nativeElement) {
          this.drawioIframe.nativeElement.contentWindow?.postMessage(
            JSON.stringify({ action: 'status', message: 'Error en servidor', modified: true }), '*'
          );
        }
      }
    });
  }
}