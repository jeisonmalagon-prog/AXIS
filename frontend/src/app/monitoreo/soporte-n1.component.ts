import { Component, OnDestroy, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription, interval } from 'rxjs';
import {
  AccionEstado, AccionSoporte, FormConfigSoporte, PantallaSoporte, ResultadoReinicio, SolicitudOtp, SoporteN1Service,
} from './soporte-n1.service';

type Paso = 'confirmar' | 'codigo' | 'trabajando' | 'listo' | 'error';

// ============================================================================
// Soporte Nivel 1: dos acciones (reiniciar monitor de pagos / monitor naranja).
//  · Rol de administración: confirma y reinicia.
//  · Rol Consulta: se envía un código a los aprobadores; al escribirlo bien se reinicia.
//  · ADMIN_POD: además configura aprobadores, vigencia del código y contenedor de cada acción.
// ============================================================================
@Component({
  selector: 'app-soporte-n1',
  standalone: true,
  imports: [FormsModule, DatePipe, RouterLink],
  templateUrl: './soporte-n1.component.html',
  styleUrl: './soporte-n1.component.scss',
})
export class SoporteN1Component implements OnInit, OnDestroy {
  datos: PantallaSoporte | null = null;
  cargando = true;
  error: string | null = null;
  aviso: { texto: string; tipo: 'ok' | 'error' } | null = null;
  private avisoT: ReturnType<typeof setTimeout> | undefined;
  private subs: Subscription[] = [];
  private pedido?: Subscription;

  // Diálogo de reinicio
  accion: AccionEstado | null = null;
  paso: Paso = 'confirmar';
  enviando = false;
  solicitud: SolicitudOtp | null = null;
  codigo = '';
  errorDialogo: string | null = null;
  intentosRestantes: number | null = null;
  resultado: ResultadoReinicio | null = null;
  restanteSeg = 0;
  reenvioSeg = 0;
  private finCodigo = 0;
  private finReenvio = 0;

  // Configuración (ADMIN_POD)
  mostrarConfig = false;
  form: FormConfigSoporte | null = null;
  guardando = false;
  probando = false;
  errorConfig: string | null = null;
  avisoConfig: string | null = null;

  constructor(private svc: SoporteN1Service) {}

  get requiereOtp(): boolean { return !!this.datos?.requiereOtp; }
  get esAdminPod(): boolean { return !!this.datos?.esAdminPod; }
  get sinAprobadores(): boolean { return !!this.datos && this.datos.config.aprobadoresTotal === 0; }
  get aprobadoresMasc(): string { return (this.datos?.config.aprobadoresEnmascarados || []).join(', '); }
  get dominiosTxt(): string { return (this.datos?.config.dominios || []).map((x) => '@' + x).join(', '); }
  get puedeSolicitar(): boolean { return !this.requiereOtp || (!this.sinAprobadores && !!this.datos?.config.smtpListo); }

  ngOnInit(): void {
    this.cargar();
    this.subs.push(interval(30_000).subscribe(() => { if (!document.hidden && !this.accion && !this.mostrarConfig) this.cargar(true); }));
    this.subs.push(interval(1000).subscribe(() => this.tick()));
  }
  ngOnDestroy(): void { this.subs.forEach((s) => s.unsubscribe()); this.pedido?.unsubscribe(); clearTimeout(this.avisoT); }

  private tick(): void {
    if (this.paso !== 'codigo' || !this.accion) return;
    this.restanteSeg = Math.max(0, Math.ceil((this.finCodigo - Date.now()) / 1000));
    this.reenvioSeg = Math.max(0, Math.ceil((this.finReenvio - Date.now()) / 1000));
  }

  cargar(silencioso = false): void {
    this.pedido?.unsubscribe();
    if (!silencioso) this.cargando = true;
    this.pedido = this.svc.pantalla().subscribe({
      next: (d) => { this.datos = d; this.cargando = false; this.error = null; },
      error: (e: HttpErrorResponse) => { this.cargando = false; if (!silencioso || !this.datos) this.error = e?.error?.error || 'No se pudo cargar Soporte Nivel 1.'; },
    });
  }

  private mostrar(texto: string, tipo: 'ok' | 'error' = 'ok'): void {
    this.aviso = { texto, tipo };
    clearTimeout(this.avisoT);
    this.avisoT = setTimeout(() => (this.aviso = null), 6000);
  }

  claseEstado(a: AccionEstado): string {
    if (!a.encontrado) return 'st--desconocido';
    return a.estado === 'running' ? 'st--ok' : a.estado === 'restarting' ? 'st--aviso' : 'st--mal';
  }
  textoEstado(a: AccionEstado): string {
    if (!a.encontrado) return 'No ubicado';
    const mapa: Record<string, string> = { running: 'En ejecución', restarting: 'Reiniciando', exited: 'Detenido', paused: 'En pausa', created: 'Creado', dead: 'Caído' };
    return mapa[a.estado || ''] || (a.estado || 'Desconocido');
  }
  mmss(seg: number): string { return `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`; }

  // ---------------------------------------------------------------- diálogo
  abrir(a: AccionEstado): void {
    if (!a.encontrado || a.enfriamientoSeg > 0) return;
    this.accion = a;
    this.paso = 'confirmar';
    this.enviando = false;
    this.solicitud = null;
    this.codigo = '';
    this.errorDialogo = null;
    this.intentosRestantes = null;
    this.resultado = null;
  }

  cerrar(): void {
    if (this.paso === 'trabajando') return;
    const huboReinicio = this.paso === 'listo' || this.paso === 'error';
    this.accion = null;
    this.solicitud = null;
    this.codigo = '';
    if (huboReinicio) this.cargar(true);
  }

  confirmar(): void {
    if (!this.accion || this.enviando) return;
    if (this.requiereOtp) this.pedirCodigo(); else this.ejecutar();
  }

  pedirCodigo(): void {
    if (!this.accion || this.enviando) return;
    const clave: AccionSoporte = this.accion.clave;
    this.enviando = true;
    this.errorDialogo = null;
    this.svc.solicitarOtp(clave).subscribe({
      next: (s) => this.alRecibirCodigo(s),
      error: (e: HttpErrorResponse) => {
        this.enviando = false;
        // «Ya enviamos uno hace poco»: se sigue con la solicitud vigente.
        if (e?.error?.codigo === 'REENVIO' && e.error.solicitudId && this.paso === 'confirmar') {
          this.solicitud = { solicitudId: e.error.solicitudId, expiraEn: e.error.expiraEn, vigenciaMin: this.datos?.config.vigenciaMin || 10, reenvioSeg: e.error.esperaSeg || 60, enviadoA: this.datos?.config.aprobadoresEnmascarados || [], aprobadores: this.datos?.config.aprobadoresTotal || 0, maxIntentos: this.datos?.config.maxIntentos || 5 };
          this.paso = 'codigo';
          this.finCodigo = new Date(e.error.expiraEn).getTime();
          this.finReenvio = Date.now() + (e.error.esperaSeg || 60) * 1000;
          this.tick();
          this.errorDialogo = 'Ya se había enviado un código hace instantes; sigue siendo válido.';
          return;
        }
        this.errorDialogo = e?.error?.error || 'No se pudo enviar el código.';
        if (e?.error?.esperaSeg) { this.finReenvio = Date.now() + e.error.esperaSeg * 1000; }
      },
    });
  }

  private alRecibirCodigo(s: SolicitudOtp): void {
    this.enviando = false;
    this.solicitud = s;
    this.paso = 'codigo';
    this.codigo = '';
    this.errorDialogo = null;
    this.intentosRestantes = s.maxIntentos;
    this.finCodigo = new Date(s.expiraEn).getTime();
    this.finReenvio = Date.now() + s.reenvioSeg * 1000;
    this.tick();
  }

  reenviar(): void {
    if (this.reenvioSeg > 0 || this.enviando || !this.accion) return;
    this.enviando = true;
    this.errorDialogo = null;
    this.svc.solicitarOtp(this.accion.clave).subscribe({
      next: (s) => { this.alRecibirCodigo(s); this.mostrar('Se envió un código nuevo a los aprobadores.'); },
      error: (e: HttpErrorResponse) => { this.enviando = false; this.errorDialogo = e?.error?.error || 'No se pudo reenviar el código.'; },
    });
  }

  soloDigitos(): void { this.codigo = this.codigo.replace(/\D/g, '').slice(0, 6); }
  get codigoCompleto(): boolean { return /^\d{6}$/.test(this.codigo); }

  ejecutar(): void {
    if (!this.accion || this.enviando) return;
    if (this.requiereOtp && (!this.solicitud || !this.codigoCompleto)) return;
    const a = this.accion;
    this.enviando = true;
    this.errorDialogo = null;
    this.paso = 'trabajando';
    this.svc.reiniciar(a.clave, this.requiereOtp ? this.solicitud!.solicitudId : undefined, this.requiereOtp ? this.codigo : undefined).subscribe({
      next: (r) => { this.enviando = false; this.resultado = r; this.paso = 'listo'; this.codigo = ''; },
      error: (e: HttpErrorResponse) => {
        this.enviando = false;
        const cod = e?.error?.codigo as string | undefined;
        const msg = e?.error?.error || 'No se pudo reiniciar.';
        // Errores del código: se vuelve a pedir, no es un fallo del reinicio.
        if (this.requiereOtp && ['INCORRECTO', 'FORMATO'].includes(cod || '')) {
          this.paso = 'codigo'; this.errorDialogo = msg; this.intentosRestantes = e.error.intentosRestantes ?? this.intentosRestantes; this.codigo = ''; return;
        }
        if (this.requiereOtp && ['VENCIDO', 'BLOQUEADO', 'SIN_SOLICITUD', 'NO_VIGENTE'].includes(cod || '')) {
          this.paso = 'codigo'; this.errorDialogo = msg; this.solicitud = null; this.codigo = ''; this.finCodigo = 0; this.reenvioSeg = 0; this.finReenvio = 0; return;
        }
        this.errorDialogo = msg;
        this.paso = 'error';
      },
    });
  }

  // ---------------------------------------------------------------- configuración
  abrirConfig(): void {
    const c = this.datos?.config;
    if (!c || !this.esAdminPod) return;
    this.form = {
      aprobadores: (c.aprobadores || []).join('\n'),
      vigenciaMin: c.vigenciaMin,
      acciones: {
        monitor_pagos: { entorno: c.acciones.monitor_pagos.entorno, contenedor: c.acciones.monitor_pagos.contenedor },
        monitor_naranja: { entorno: c.acciones.monitor_naranja.entorno, contenedor: c.acciones.monitor_naranja.contenedor },
      },
    };
    this.errorConfig = null;
    this.avisoConfig = null;
    this.mostrarConfig = true;
  }
  cerrarConfig(): void { if (!this.guardando) this.mostrarConfig = false; }

  guardarConfig(): void {
    if (!this.form || this.guardando) return;
    this.guardando = true;
    this.errorConfig = null;
    this.avisoConfig = null;
    this.svc.guardarConfig(this.form).subscribe({
      next: () => { this.guardando = false; this.mostrarConfig = false; this.mostrar('Configuración de Soporte Nivel 1 guardada.'); this.cargar(true); },
      error: (e: HttpErrorResponse) => { this.guardando = false; this.errorConfig = e?.error?.error || 'No se pudo guardar la configuración.'; },
    });
  }

  probarCorreo(): void {
    if (this.probando) return;
    this.probando = true;
    this.errorConfig = null;
    this.avisoConfig = null;
    this.svc.probarCorreo().subscribe({
      next: (r) => { this.probando = false; this.avisoConfig = r.mensaje; },
      error: (e: HttpErrorResponse) => { this.probando = false; this.errorConfig = e?.error?.error || 'No se pudo enviar el correo de prueba.'; },
    });
  }

  etiquetaEvento(accion: string): string {
    const m: Record<string, string> = {
      REINICIO: 'Reinicio', REINICIO_FALLIDO: 'Reinicio fallido', SOLICITUD_OTP: 'Código solicitado', SOLICITUD_OTP_FALLIDA: 'Código no enviado',
      OTP_INCORRECTA: 'Código incorrecto', OTP_VENCIDA: 'Código vencido', OTP_BLOQUEADA: 'Código bloqueado', EDICION: 'Configuración', PRUEBA_CORREO: 'Correo de prueba',
    };
    return m[accion] || accion;
  }
  claseEvento(accion: string): string {
    if (accion === 'REINICIO') return 'ev--ok';
    return /FALLIDO|INCORRECTA|VENCIDA|BLOQUEADA|FALLIDA/.test(accion) ? 'ev--mal' : 'ev--info';
  }
  trackAccion(_i: number, a: AccionEstado): string { return a.clave; }
}
