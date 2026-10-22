import { Component, EventEmitter, HostListener, Input, OnInit, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { CatalogoRespuesta, InformeCatalogo, ParamsInforme, Programado, InformesService } from './informes.service';

export type ModoDialogo = 'enviar' | 'programar' | 'editar';

const DIAS = [
  { v: 1, t: 'Lunes' }, { v: 2, t: 'Martes' }, { v: 3, t: 'Miércoles' }, { v: 4, t: 'Jueves' }, { v: 5, t: 'Viernes' }, { v: 6, t: 'Sábado' }, { v: 0, t: 'Domingo' }
];
const PERIODOS_PROG = ['ayer', 'semana', 'mes', 'mesanterior'];

// ============================================================================
// Diálogo único para tres cosas: enviar el informe ahora por correo, crear un
// envío programado y editar uno existente. Los destinatarios se limitan a los
// dominios que el backend permite (REPORTE_EMAIL_DOMINIOS).
// ============================================================================
@Component({
  selector: 'app-informe-dialogo',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="velo" (click)="cerrar.emit()"></div>
    <div class="dlg" role="dialog" aria-modal="true" [attr.aria-label]="titulo">
      <header>
        <h2>{{ titulo }}</h2>
        <button type="button" class="x" (click)="cerrar.emit()" aria-label="Cerrar">×</button>
      </header>

      <div class="cuerpo">
        @if (!cat.correo.configurado) {
          <p class="aviso">El servidor de correo (SMTP) todavía no está configurado: los envíos fallarán hasta que se defina SMTP_HOST, SMTP_USER y SMTP_PASS en el backend.</p>
        }

        @if (modo !== 'enviar') {
          <label class="campo"><span>Nombre del envío</span>
            <input type="text" [(ngModel)]="nombre" maxlength="120" placeholder="Ej.: Resumen semanal de certificados" />
          </label>
        }

        <label class="campo"><span>Informe</span>
          @if (modo === 'programar') {
            <select [(ngModel)]="informe" (ngModelChange)="alCambiarInforme()">
              @for (i of programables; track i.clave) { <option [value]="i.clave">{{ i.titulo }}</option> }
            </select>
          } @else {
            <input type="text" [value]="tituloInforme" disabled />
          }
        </label>

        @if (esGeneral) {
          <div class="campo"><span>Secciones del informe general</span>
            <div class="chips">
              @for (s of seccionesDisponibles; track s.clave) {
                <label class="chk"><input type="checkbox" [checked]="secciones.includes(s.clave)" (change)="alternarSeccion(s.clave)" />{{ s.titulo }}</label>
              }
            </div>
          </div>
        }

        @if (modo === 'enviar') {
          <p class="nota">Se enviará con el periodo que estás viendo: <strong>{{ resumenPeriodo }}</strong>.</p>
        } @else {
          <div class="fila">
            <label class="campo"><span>Periodo que cubre</span>
              <select [(ngModel)]="periodo">
                @for (p of periodosProg; track p.clave) { <option [value]="p.clave">{{ p.etiqueta }}</option> }
              </select>
            </label>
            <label class="campo"><span>Frecuencia</span>
              <select [(ngModel)]="frecuencia">
                <option value="diaria">Todos los días</option><option value="semanal">Una vez por semana</option><option value="mensual">Una vez al mes</option>
              </select>
            </label>
          </div>
          <div class="fila">
            @if (frecuencia === 'semanal') {
              <label class="campo"><span>Día de la semana</span>
                <select [(ngModel)]="diaSemana">@for (d of dias; track d.v) { <option [ngValue]="d.v">{{ d.t }}</option> }</select>
              </label>
            }
            @if (frecuencia === 'mensual') {
              <label class="campo"><span>Día del mes</span>
                <select [(ngModel)]="diaMes">@for (d of diasMes; track d) { <option [ngValue]="d">{{ d }}</option> }</select>
              </label>
            }
            <label class="campo"><span>Hora (hora de Colombia)</span><input type="time" [(ngModel)]="hora" /></label>
          </div>
        }

        <label class="campo"><span>Destinatarios</span>
          <textarea rows="2" [(ngModel)]="destinatarios" placeholder="nombre@{{ dominioEjemplo }}, otra.persona@{{ dominioEjemplo }}"></textarea>
          <small>Separados por coma o espacio. Solo se permiten correos de: {{ cat.correo.dominios.join(', ') }}.</small>
        </label>

        <div class="campo"><span>Adjuntar</span>
          <div class="chips">
            <label class="chk"><input type="checkbox" [checked]="formatos.includes('pdf')" (change)="alternarFormato('pdf')" />PDF</label>
            <label class="chk"><input type="checkbox" [checked]="formatos.includes('xlsx')" (change)="alternarFormato('xlsx')" />Excel (con gráficos)</label>
          </div>
        </div>

        @if (modo === 'enviar') {
          <label class="campo"><span>Mensaje (opcional)</span><textarea rows="2" [(ngModel)]="nota" maxlength="400" placeholder="Una línea de contexto para quien lo recibe"></textarea></label>
        } @else {
          <label class="chk activo"><input type="checkbox" [(ngModel)]="activo" />Envío activo</label>
          @if (programado === null) { <p class="nota">El primer envío sale en la próxima hora programada, no de inmediato. Luego puedes usar «Enviar ahora» desde la lista.</p> }
        }

        @if (error) { <p class="error">{{ error }}</p> }
      </div>

      <footer>
        <button type="button" class="btn btn--sec" (click)="cerrar.emit()" [disabled]="guardando">Cancelar</button>
        <button type="button" class="btn btn--pri" (click)="guardar()" [disabled]="guardando">{{ guardando ? 'Un momento…' : (modo === 'enviar' ? 'Enviar ahora' : (modo === 'editar' ? 'Guardar cambios' : 'Crear envío')) }}</button>
      </footer>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; font-family: 'Inter', sans-serif; }
    .velo { position: absolute; inset: 0; background: rgba(15, 23, 42, .55); backdrop-filter: blur(2px); }
    .dlg { position: relative; background: var(--ax-surface, #fff); color: var(--ax-text, #1e293b); border: 1px solid var(--ax-border, #e2e8f0); border-radius: 20px; width: 100%; max-width: 560px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; box-shadow: 0 30px 70px rgba(0, 0, 0, .35); animation: sube .2s ease-out; }
    @keyframes sube { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }
    header { display: flex; justify-content: space-between; align-items: center; padding: 18px 22px 8px; }
    h2 { margin: 0; font-size: 18px; font-weight: 800; letter-spacing: -.3px; }
    .x { border: none; background: transparent; font-size: 26px; line-height: 1; color: var(--ax-text-muted, #64748b); cursor: pointer; padding: 0 4px; }
    .cuerpo { padding: 6px 22px 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
    .fila { display: flex; gap: 12px; flex-wrap: wrap; } .fila .campo { flex: 1 1 160px; }
    .campo { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .campo > span { font-size: 11.5px; font-weight: 800; color: var(--ax-text-muted, #64748b); text-transform: uppercase; letter-spacing: .3px; }
    .campo input[type=text], .campo input[type=time], .campo select, .campo textarea { padding: 9px 12px; border-radius: 10px; border: 1px solid var(--ax-border, #e2e8f0); font-size: 13.5px; font-family: inherit; background: var(--ax-surface-2, #f8fafc); color: var(--ax-text, #1e293b); width: 100%; box-sizing: border-box; color-scheme: light dark; resize: vertical; }
    .campo input:disabled { opacity: .75; }
    .campo input:focus, .campo select:focus, .campo textarea:focus { outline: 2px solid rgba(var(--ax-brand-primary-rgb, 103, 58, 183), .45); outline-offset: 1px; }
    small { font-size: 11.5px; color: var(--ax-text-muted, #64748b); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px 14px; }
    .chk { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .chk input { width: 16px; height: 16px; accent-color: var(--ax-brand-primary, #673ab7); cursor: pointer; }
    .nota { margin: 0; font-size: 12.5px; color: var(--ax-text-muted, #64748b); background: var(--ax-surface-2, #f8fafc); border-radius: 10px; padding: 9px 12px; }
    .aviso { margin: 0; font-size: 12.5px; color: #b45309; background: rgba(245, 158, 11, .15); border-radius: 10px; padding: 9px 12px; font-weight: 600; }
    :host-context(.dark-theme) .aviso { color: #fcd34d; }
    .error { margin: 0; font-size: 13px; font-weight: 700; color: #b91c1c; background: rgba(239, 68, 68, .12); border-radius: 10px; padding: 9px 12px; }
    :host-context(.dark-theme) .error { color: #fca5a5; }
    footer { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 22px 18px; border-top: 1px solid var(--ax-border, #e2e8f0); }
    .btn { padding: 9px 20px; border-radius: 10px; font-size: 13.5px; font-weight: 700; cursor: pointer; border: 1px solid transparent; font-family: inherit; }
    .btn:disabled { opacity: .6; cursor: default; }
    .btn--pri { background: var(--ax-brand-primary, #673ab7); color: #fff; }
    .btn--sec { background: transparent; border-color: var(--ax-border, #e2e8f0); color: var(--ax-text, #1e293b); }
  `]
})
export class InformeDialogoComponent implements OnInit {
  @Input({ required: true }) modo: ModoDialogo = 'enviar';
  @Input({ required: true }) cat!: CatalogoRespuesta;
  /** Informe preseleccionado (enviar/programar). */
  @Input() clave = '';
  /** Periodo en pantalla (solo «enviar»). */
  @Input() params: ParamsInforme = {};
  @Input() resumenPeriodo = '';
  @Input() seccionesInicial: string[] = [];
  @Input() programado: Programado | null = null;
  @Output() cerrar = new EventEmitter<void>();
  @Output() hecho = new EventEmitter<string>();

  readonly dias = DIAS;
  readonly diasMes = Array.from({ length: 28 }, (_, i) => i + 1);
  informe = ''; nombre = ''; secciones: string[] = []; periodo = 'semana'; frecuencia = 'semanal'; diaSemana: number = 1; diaMes = 1; hora = '07:00';
  destinatarios = ''; formatos: string[] = ['pdf', 'xlsx']; nota = ''; activo = true;
  error: string | null = null; guardando = false;

  constructor(private svc: InformesService) {}

  get programables(): InformeCatalogo[] { return this.cat.informes.filter((i) => i.programable); }
  get periodosProg() { return this.cat.periodos.filter((p) => PERIODOS_PROG.includes(p.clave)); }
  get esGeneral(): boolean { return this.informe === 'general'; }
  get seccionesDisponibles() { return this.cat.informes.find((i) => i.clave === 'general')?.secciones || []; }
  get tituloInforme(): string { return this.cat.informes.find((i) => i.clave === this.informe)?.titulo || this.informe; }
  get titulo(): string { return this.modo === 'enviar' ? 'Enviar por correo' : this.modo === 'editar' ? 'Editar envío programado' : 'Programar envío por correo'; }
  get dominioEjemplo(): string { return this.cat.correo.dominios[0] || 'empresa.com'; }

  ngOnInit(): void {
    const p = this.programado;
    if (p) {
      this.informe = p.informe; this.nombre = p.nombre; this.secciones = [...p.secciones]; this.periodo = p.periodo; this.frecuencia = p.frecuencia;
      this.diaSemana = p.diaSemana ?? 1; this.diaMes = p.diaMes ?? 1; this.hora = p.hora; this.destinatarios = p.destinatarios.join(', '); this.formatos = [...p.formatos]; this.activo = p.activo;
    } else {
      this.informe = this.clave || this.programables[0]?.clave || '';
      this.secciones = this.seccionesInicial.length ? [...this.seccionesInicial] : this.seccionesDisponibles.map((s) => s.clave);
      this.nombre = this.modo === 'programar' ? `${this.tituloInforme} — envío automático` : '';
    }
  }
  @HostListener('document:keydown.escape') esc(): void { if (!this.guardando) this.cerrar.emit(); }

  alCambiarInforme(): void {
    if (this.modo === 'programar' && (!this.nombre || this.nombre.endsWith('— envío automático'))) this.nombre = `${this.tituloInforme} — envío automático`;
    if (this.esGeneral && !this.secciones.length) this.secciones = this.seccionesDisponibles.map((s) => s.clave);
  }
  alternarSeccion(c: string): void { this.secciones = this.secciones.includes(c) ? this.secciones.filter((x) => x !== c) : [...this.secciones, c]; }
  alternarFormato(f: string): void { this.formatos = this.formatos.includes(f) ? this.formatos.filter((x) => x !== f) : [...this.formatos, f]; }

  private lista(): string[] { return this.destinatarios.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean); }

  guardar(): void {
    this.error = null;
    const dest = this.lista();
    if (!dest.length) { this.error = 'Escribe al menos un destinatario.'; return; }
    if (!this.formatos.length) { this.error = 'Elige al menos un formato (PDF o Excel).'; return; }
    if (this.esGeneral && !this.secciones.length) { this.error = 'Elige al menos una sección.'; return; }
    this.guardando = true;
    const fallo = (e: any) => { this.guardando = false; this.error = e?.error?.error || 'No se pudo completar la operación.'; };
    if (this.modo === 'enviar') {
      this.svc.enviar({ informe: this.informe, ...this.params, secciones: this.esGeneral ? this.secciones : undefined, destinatarios: dest, formatos: this.formatos, nota: this.nota.trim() || undefined }).subscribe({
        next: (r) => { this.guardando = false; this.hecho.emit(`Informe enviado a ${r.destinatarios.length} destinatario${r.destinatarios.length === 1 ? '' : 's'}.`); }, error: fallo
      });
      return;
    }
    if (!this.nombre.trim()) { this.guardando = false; this.error = 'Escribe un nombre para el envío.'; return; }
    const f = {
      nombre: this.nombre.trim(), informe: this.informe, secciones: this.esGeneral ? this.secciones : [], periodo: this.periodo, frecuencia: this.frecuencia,
      diaSemana: this.frecuencia === 'semanal' ? Number(this.diaSemana) : null, diaMes: this.frecuencia === 'mensual' ? Number(this.diaMes) : null,
      hora: this.hora, destinatarios: dest, formatos: this.formatos, activo: this.activo
    };
    const op: Observable<unknown> = this.modo === 'editar' && this.programado ? this.svc.editarProgramado(this.programado.id, f) : this.svc.crearProgramado(f);
    op.subscribe({ next: () => { this.guardando = false; this.hecho.emit(this.modo === 'editar' ? 'Envío programado actualizado.' : 'Envío programado creado.'); }, error: fallo });
  }
}
