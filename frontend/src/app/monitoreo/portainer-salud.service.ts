import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export type NivelSalud = 'ok' | 'aviso' | 'critico';
export interface ProblemaContenedor { codigo: string; nivel: 'aviso' | 'critico'; titulo: string; detalle: string; }
export interface ContenedorSalud {
  id: string; entornoId: number; entorno: string; nombre: string; imagen: string; estado: string; estadoTexto: string; salud: string;
  reinicios: number | null; oomKilled: boolean; codigoSalida: number | null; iniciadoEn: string | null; terminadoEn: string | null; politica: string | null;
  nivel: NivelSalud; problemas: ProblemaContenedor[]; stack: string | null;
}
export interface EntornoSalud {
  id: number; nombre: string; conexion: 'up' | 'down'; error: string | null; semaforo: NivelSalud; total: number; corriendo: number; detenidos: number;
  criticos: number; avisos: number; puntaje: number; reinicios: number;
}
export interface RespuestaSalud {
  configurado: boolean; error?: string; generadoEn: string; semaforo: NivelSalud;
  resumen: { entornos: number; entornosArriba: number; entornosCaidos: number; contenedores: number; corriendo: number; criticos: number; avisos: number; sanos: number; porcentajeSano: number | null; sinHealthcheck: number; oom: number; };
  entornos: EntornoSalud[]; inestables: ContenedorSalud[]; problemas: ContenedorSalud[]; truncado: boolean;
}
export interface ContenedorStack { id: string; nombre: string; servicio: string | null; imagen: string; tag: string; estado: string; estadoTexto: string; salud: string; nivel: NivelSalud; reinicios: number | null; }
export interface StackInfo {
  entornoId: number; entorno: string; nombre: string; tipo: 'compose' | 'swarm' | null; gestionadoPortainer: boolean; stackId: number | null;
  git: { url: string | null; rama: string | null } | null; total: number; corriendo: number; criticos: number; avisos: number;
  estado: 'ok' | 'avisos' | 'parcial' | 'problemas' | 'caido'; desplegadoEn: string | null; ultimoInicio: string | null;
  versiones: { repo: string; tags: string[] }[]; mezclaVersiones: boolean; contenedores: ContenedorStack[];
}
export interface RespuestaStacks {
  configurado: boolean; error?: string; generadoEn: string;
  resumen: { stacks: number; conProblemas: number; gestionados: number; mezclaVersiones: number; imagenesConDesfase: number; contenedoresSueltos: number; };
  stacks: StackInfo[]; sueltos: { entornoId: number; entorno: string; contenedores: number }[];
  desfase: { repo: string; versiones: { tag: string; entornos: string[] }[] }[];
}
export interface CategoriaHigiene {
  codigo: string; titulo: string; descripcion: string; nivel: 'info' | 'aviso'; cantidad: number; bytes?: number;
  items: { entorno: string; entornoId: number; nombre: string; extra: string; bytes?: number }[];
}
export interface EntornoHigiene {
  id: number; nombre: string; conexion: string; imagenesSinUso: number; bytesRecuperables: number; volumenesHuerfanos: number; redesSinUso: number;
  privilegiados: number; sinLimiteMemoria: number; corriendo: number; sinHealthcheck: number; puertosExpuestos: number; comoRoot: number; puntaje: number | null; parcial: string[];
}
export interface RespuestaHigiene {
  configurado: boolean; error?: string; generadoEn: string; diasImagenAntigua: number;
  resumen: { espacioRecuperableBytes: number; espacioRecuperableTexto: string; espacioSinEtiquetaBytes: number; espacioSinEtiquetaTexto: string; espacioAntiguasBytes: number; espacioAntiguasTexto: string; hallazgos: number; puntajePromedio: number | null; };
  categorias: CategoriaHigiene[]; entornos: EntornoHigiene[];
}
export interface AlertaPortainer { clave: string; tipo: string; titulo: string; mensaje: string; nivel: 'critico' | 'ok'; en: string; entorno?: string; }
export interface RespuestaAlertas {
  configurado: boolean; activa: boolean; cadaMin: number; repetirHoras: number; correo: boolean; ultima: { en: string; activas: number; nuevas: number } | null;
  activasAhora: { clave: string; titulo: string; desde: string }[]; recientes: AlertaPortainer[];
}

@Injectable({ providedIn: 'root' })
export class PortainerSaludService {
  private base = `${environment.apiUrl}/monitoreo/portainer`;
  constructor(private http: HttpClient) {}
  private p(fresco: boolean): HttpParams { return fresco ? new HttpParams().set('fresco', '1') : new HttpParams(); }
  salud(fresco = false): Observable<RespuestaSalud> { return this.http.get<RespuestaSalud>(`${this.base}/salud`, { params: this.p(fresco) }); }
  stacks(fresco = false): Observable<RespuestaStacks> { return this.http.get<RespuestaStacks>(`${this.base}/stacks`, { params: this.p(fresco) }); }
  higiene(fresco = false): Observable<RespuestaHigiene> { return this.http.get<RespuestaHigiene>(`${this.base}/higiene`, { params: this.p(fresco) }); }
  alertas(): Observable<RespuestaAlertas> { return this.http.get<RespuestaAlertas>(`${this.base}/alertas`); }
  reiniciarStack(entornoId: number, stack: string) { return this.http.post<{ entorno: string; stack: string; reiniciados: number; fallidos: { nombre: string; error: string }[] }>(`${this.base}/stacks/reiniciar`, { entornoId, stack }); }
  limpiarImagenes(entornoId: number, modo: 'huerfanas' | 'antiguas', dias?: number) {
    return this.http.post<{ entorno: string; modo: string; eliminadas: number; bytesLiberados: number; espacioLiberado: string; fallidas: string[] }>(`${this.base}/higiene/limpiar-imagenes`, { entornoId, modo, dias });
  }
  reiniciarContenedor(entornoId: number, contenedorId: string) {
    return this.http.post<{ mensaje: string }>(`${this.base}/entornos/${entornoId}/contenedores/${contenedorId}/accion`, { accion: 'restart' });
  }
}
