import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface PasoProduccionIntegrante {
  id: number;
  nombreCompleto: string;
}

// Servicio del BUS (inventario de Servicios) sobre el que actúa un paso.
export interface ServicioPaso {
  id: number;
  codigo: string | null;
  nombre: string;
}

// Duplicado detectado al crear: ya existe un paso con ese RFC y ambiente (o ese evento de calendario).
export interface PasoDuplicado {
  id: number;
  titulo: string | null;
  rfc: string | null;
  entorno: string;
  creadoPor: string;
  visible: boolean;
}

// Servidor / sub-aplicativo donde se ejecuta un paso (un paso puede tener varios).
export interface AplicativoPaso {
  ComponenteId: number | null;
  Nombre: string;
  ServidorId: number | null;
  ServidorHostname: string | null;
}

export interface PasoProduccion {
  Id: number;
  Rfc: string | null;
  Titulo: string;
  Entorno: 'DESARROLLO' | 'QA' | 'PRODUCCION';
  AplicativoId: number | null;
  // Id del sub-aplicativo (componente) al que pertenece la ficha AplicativoId.
  AplicativoComponenteId?: number | null;
  AplicativoNombre: string | null;
  AplicativoServidorId: number | null;
  AplicativoServidorHostname: string | null;
  AplicativoNegocioId: number | null;
  AplicativoNegocioNombre: string | null;
  // Lista completa de servidores/sub-aplicativos del paso (el primero es el principal).
  Aplicativos: AplicativoPaso[];
  AplicativosTexto: string | null;
  FechaHoraProgramada: string;
  FechaHoraEstimadaFin: string | null;
  FechaHoraInicioReal: string | null;
  FechaHoraFinReal: string | null;
  GoogleEventId: string | null;
  Descripcion: string | null;
  Estado: 'PROGRAMADO' | 'EJECUTADO' | 'CANCELADO' | 'REAGENDADO' | 'ROLLBACK';
  MotivoEstado: string | null;
  ResultadoEjecucion: string | null;
  EjecutadoPorId: number | null;
  EjecutadoPorNombre: string | null;
  CreadoPorId: number;
  CreadoPorNombre: string;
  // Commit de Azure DevOps asociado al cambio que se está desplegando.
  CommitId: string | null;
  CommitRepo: string | null;
  CommitRama: string | null;
  CommitMensaje: string | null;
  CommitAutor: string | null;
  CommitFecha: string | null;
  CommitUrl: string | null;
  FechaCreacion: string;
  FechaActualizacion: string;
  equipo: PasoProduccionIntegrante[];
  // Servicios del BUS vinculados: con servicios el paso es «BUS»; sin ellos, de aplicación/servidores.
  servicios?: ServicioPaso[];
  Tipo?: 'BUS' | 'APLICACION';
  // Mi nivel sobre el paso (bitácora única): PROPIETARIO lo creó; EDICION edita; LECTURA solo ve; ADMIN lo ve como administrador.
  miNivel?: 'PROPIETARIO' | 'EDICION' | 'LECTURA' | 'ADMIN' | null;
  soyParticipante?: boolean;
  // Otros pasos que veo con el mismo RFC y ambiente (posibles duplicados), para ofrecer «Fusionar».
  duplicados?: PasoDuplicadoResumen[];
  // Eliminación lógica («Eliminados») y «ocultar» (personal, solo en mi vista principal).
  Eliminado?: boolean;
  EliminadoEn?: string | null;
  EliminadoPorNombre?: string | null;
  MotivoEliminacion?: string | null;
  Oculto?: boolean;
}

/** Qué se ve: la bitácora principal, lo que YO oculté o lo eliminado (lógicamente). */
export type VistaPasos = 'principal' | 'ocultos' | 'eliminados';

export interface ConteosPasos {
  principal: number;
  ocultos: number;
  eliminados: number;
  /** false mientras no se haya ejecutado el script SQL de eliminación lógica / ocultos. */
  eliminacionLista: boolean;
  ocultosListos: boolean;
  aviso: string | null;
}

export type AccionMasivaPasos = 'ocultar' | 'mostrar' | 'eliminar' | 'restaurar' | 'eliminar-definitivo';

export interface ResultadoMasivoPasos {
  accion: AccionMasivaPasos;
  procesados: number;
  omitidos: { id: number; titulo: string | null; motivo: string }[];
}

export interface PasoDuplicadoResumen {
  id: number;
  titulo: string;
  estado: string;
  fechaHoraProgramada: string;
  creadoPor: string;
  participantes: string;
  miNivel: 'PROPIETARIO' | 'EDICION' | 'LECTURA' | 'ADMIN' | null;
  /** Puedo dejar este paso como el que se conserva. */
  puedeConservar: boolean;
  /** Puedo fusionar este paso dentro de otro (lo creé yo, o soy administrador). */
  puedeAbsorber: boolean;
}

// Imagen de evidencia de un ítem (sin contenido; se pide aparte con obtenerAdjunto).
export interface EvidenciaItem {
  Id: number;
  NombreOriginal: string;
  TamanoBytes: number;
  FechaSubida: string;
  SubidoPorNombre: string | null;
}

export interface ChecklistItem {
  Id: number;
  Descripcion: string;
  Completado: boolean;
  Orden: number;
  CompletadoPorId: number | null;
  CompletadoPorNombre: string | null;
  FechaCompletado: string | null;
  FechaCreacion: string;
  // Último adjunto marcado como evidencia de este ítem (ver
  // POST /:id/checklist/:itemId/evidencia) -- null si todavía no tiene.
  EvidenciaAdjuntoId: number | null;
  EvidenciaNombre: string | null;
  // Todas las evidencias del ítem; se conservan aunque el ítem se desmarque.
  Evidencias: EvidenciaItem[];
}

// Metadatos de un adjunto -- SIN el contenido (ver AdjuntoCompleto), para que
// listar los adjuntos de un registro no descargue de una vez todos los
// archivos.
export interface Adjunto {
  Id: number;
  NombreOriginal: string;
  MimeType: string;
  TamanoBytes: number;
  ChecklistItemId: number | null;
  SubidoPorId: number | null;
  SubidoPorNombre: string | null;
  FechaSubida: string;
}

export interface AdjuntoCompleto extends Adjunto {
  ContenidoBase64: string;
}

// Commit de Azure DevOps, tal como lo devuelve GET /commits-disponibles.
export interface CommitAzure {
  id: string;
  idCorto: string;
  comentario: string;
  autor: string;
  fecha: string | null;
  url: string | null;
}

// Repositorio de Azure DevOps, tal como lo devuelve GET /repositorios-disponibles.
export interface RepositorioAzure {
  id: string;
  nombre: string;
  esPorDefecto: boolean;
  ramaPorDefecto: string | null;
}

// Forma mínima que viaja al backend al asociar/desasociar un commit (ver
// normalizarCommit en pasosProduccion.js) -- se arma a partir de un
// CommitAzure elegido en el buscador.
export interface CommitAsociado {
  id: string;
  repo?: string | null;
  rama?: string | null;
  mensaje?: string | null;
  autor?: string | null;
  fecha?: string | null;
  url?: string | null;
}

export interface CambioHistorial {
  campo: string;
  etiqueta: string;
  anterior: string | null;
  nuevo: string | null;
}

export interface EventoHistorial {
  Id: number;
  Accion: string;
  Detalle: string | null;
  RealizadoPorUsername: string | null;
  FechaEvento: string;
  cambios: CambioHistorial[];
}

// ---------- Importación desde GLPI (vista previa, no guarda nada) ----------
export interface PendienteGlpi { campo: string; etiqueta: string; motivo: string; }

export interface HallazgoServidorGlpi {
  texto: string; ip: string | null; hostname: string | null; servidorId: number | null;
  estado: 'ok' | 'elegir' | 'sin_componentes' | 'no_inventario';
  componenteId?: number | null;
  componentes: { id: number; nombre: string }[];
}

export interface PropuestaGlpi {
  caso: { id: number; titulo: string | null; url: string | null; estado: string | null; fechaApertura: string | null; categoria: string | null };
  propuesta: {
    rfc: string; titulo: string; entorno: 'DESARROLLO' | 'QA' | 'PRODUCCION';
    fechaHoraProgramada: string; fechaHoraEstimadaFin: string; descripcion: string;
    componenteIds: number[]; equipoIds: number[]; checklist: string[];
  };
  hallazgos: { servidores: HallazgoServidorGlpi[]; equipo: { nombre: string; usuarioId: number | null }[] };
  pendientes: PendienteGlpi[];
  origen: 'api' | 'manual';
  duplicados: { id: number; titulo: string; estado: string; fechaHoraProgramada: string }[];
}

// ---------- Publicar la documentación del registro en el caso de GLPI ----------
export interface ArchivoSeguimientoGlpi { id: number; nombre: string; tipo: string | null; tamano: number; esImagen: boolean; item: string | null; }

export type TipoRespuestaGlpi = 'SEGUIMIENTO' | 'SOLUCION';

export interface EstadoCasoGlpi {
  caso: string; titulo: string; codigo: number; estado: string; cerrado: boolean; url: string;
  fechaApertura: string | null; fechaSolucion: string | null; fechaCierre: string | null;
}

export interface SeguimientoGlpiPreview {
  configurado: boolean;
  caso: string;
  rfc: string | null;
  texto: string;
  textoCierre: string;
  estadoPaso: string | null;
  checklistPendientes: number;
  archivos: ArchivoSeguimientoGlpi[];
  yaPublicado: { fecha: string; usuario: string | null; tipo: TipoRespuestaGlpi }[];
}

export interface SeguimientoGlpiResultado {
  ok: boolean; seguimientoId: number; url: string; caso: string; privado: boolean; tipo: TipoRespuestaGlpi;
  archivos: { nombre: string; ok: boolean; error?: string; incrustada?: boolean; enRespuesta?: boolean }[];
}


// ----- Listado de casos del equipo en GLPI (solo lectura) -----
export interface CasoGlpiLista {
  id: number; url: string; titulo: string; estado: string; codigo: number | null; cerrado: boolean;
  apertura: string | null; actualizacion: string | null; vence: string | null; solucion: string | null; vencido: boolean;
  solicitantes: string[]; tecnicos: string[]; grupos: string[]; categoria: string | null; entidad: string | null; prioridad: string | null;
  registroAxis: { pasoId: number; estado: string } | null;
}
export interface ListadoCasosGlpi { total: number; devueltos: number; truncado: boolean; casos: CasoGlpiLista[]; }
export interface FiltrosListadoGlpi {
  alcance: 'yo' | 'grupo' | 'tecnico' | 'todos'; grupoId?: string; tecnicoId?: string; tecnico?: string; solicitante?: string;
  estado: string; texto?: string; desde?: string; hasta?: string; soloVencidos?: boolean;
  orden: string; sentido: 'asc' | 'desc'; limite: number;
}
export interface GrupoGlpi { id: string; nombre: string; mio: boolean; }
export interface UsuarioGlpi { id: string; nombre: string; equipo: boolean; }
export interface FiltrosGlpiDisponibles { yo: { id: string; nombre: string } | null; grupos: GrupoGlpi[]; usuarios: UsuarioGlpi[]; usuariosError: string | null; }

@Injectable({ providedIn: 'root' })
export class PasoProduccionService {
  private baseUrl = `${environment.apiUrl}/pasos-produccion`;

  constructor(private http: HttpClient) {}

  listar(filtros: { entorno?: string; estado?: string; desde?: string; hasta?: string; propietarios?: string; equipos?: string; compartidos?: string; todos?: string; vista?: VistaPasos } = {}): Observable<PasoProduccion[]> {
    const params: Record<string, string> = {};
    Object.entries(filtros).forEach(([k, v]) => { if (v) params[k] = v; });
    return this.http.get<PasoProduccion[]>(this.baseUrl, { params });
  }

  estadoGlpi(): Observable<{ configurado: boolean }> {
    return this.http.get<{ configurado: boolean }>(`${this.baseUrl}/glpi/estado`);
  }

  previsualizarGlpi(datos: { caso: string; contenido?: string; titulo?: string }): Observable<PropuestaGlpi> {
    return this.http.post<PropuestaGlpi>(`${this.baseUrl}/glpi/previsualizar`, datos);
  }

  filtrosGlpi(): Observable<FiltrosGlpiDisponibles> {
    return this.http.get<FiltrosGlpiDisponibles>(`${this.baseUrl}/glpi/filtros`);
  }

  casosGlpi(f: FiltrosListadoGlpi): Observable<ListadoCasosGlpi> {
    const params: Record<string, string> = {
      alcance: f.alcance, estado: f.estado, orden: f.orden, sentido: f.sentido, limite: String(f.limite),
    };
    if (f.grupoId) params['grupoId'] = f.grupoId;
    if (f.tecnicoId) params['tecnicoId'] = f.tecnicoId;
    if (f.tecnico) params['tecnico'] = f.tecnico;
    if (f.solicitante) params['solicitante'] = f.solicitante;
    if (f.texto) params['texto'] = f.texto;
    if (f.desde) params['desde'] = f.desde;
    if (f.hasta) params['hasta'] = f.hasta;
    if (f.soloVencidos) params['soloVencidos'] = '1';
    return this.http.get<ListadoCasosGlpi>(`${this.baseUrl}/glpi/casos`, { params });
  }

  estadoCasoGlpi(caso: string): Observable<EstadoCasoGlpi> {
    return this.http.get<EstadoCasoGlpi>(`${this.baseUrl}/glpi/caso/${encodeURIComponent(caso)}`);
  }

  previsualizarSeguimientoGlpi(pasoId: number): Observable<SeguimientoGlpiPreview> {
    return this.http.get<SeguimientoGlpiPreview>(`${this.baseUrl}/${pasoId}/glpi/seguimiento`);
  }

  publicarSeguimientoGlpi(pasoId: number, datos: { caso: string; contenido: string; privado: boolean; adjuntoIds: number[]; tipo: TipoRespuestaGlpi; confirmarCierre?: boolean }): Observable<SeguimientoGlpiResultado> {
    return this.http.post<SeguimientoGlpiResultado>(`${this.baseUrl}/${pasoId}/glpi/seguimiento`, datos);
  }

  obtener(id: number): Observable<PasoProduccion> {
    return this.http.get<PasoProduccion>(`${this.baseUrl}/${id}`);
  }

  crear(datos: {
    rfc?: string | null; titulo: string; entorno: string; aplicativoId?: number | null; componenteId?: number | null; componenteIds?: number[]; fechaHoraProgramada: string;
    fechaHoraEstimadaFin?: string | null; googleEventId?: string | null; descripcion?: string | null; equipo?: number[];
    commit?: CommitAsociado | null; servicioIds?: number[]; tipo?: 'BUS' | 'APLICACION'; confirmarDuplicado?: boolean;
  }): Observable<PasoProduccion> {
    return this.http.post<PasoProduccion>(this.baseUrl, datos);
  }

  actualizar(id: number, datos: Partial<{
    rfc: string | null; titulo: string; entorno: string; aplicativoId: number | null; componenteId: number | null; componenteIds: number[]; fechaHoraProgramada: string;
    fechaHoraEstimadaFin: string | null; fechaHoraInicioReal: string | null; fechaHoraFinReal: string | null;
    descripcion: string | null; equipo: number[]; googleEventId: string | null; commit: CommitAsociado | null; servicioIds: number[];
  }>): Observable<PasoProduccion> {
    return this.http.put<PasoProduccion>(`${this.baseUrl}/${id}`, datos);
  }

  // ---------- Commit de Azure DevOps asociado ----------
  // Flujo: primero se eligen el repo (listarRepositorios), que habilita el
  // desplegable de commits de ESE repo (buscarCommits con `repo`). Ninguna
  // de las dos rutas cuelga de un :id -- sirven igual antes de crear el
  // registro que para uno ya existente (ver comentario en pasosProduccion.js).

  listarRepositorios(): Observable<{ repositorioPorDefecto: string; repositorios: RepositorioAzure[] }> {
    return this.http.get<{ repositorioPorDefecto: string; repositorios: RepositorioAzure[] }>(`${this.baseUrl}/repositorios-disponibles`);
  }

  buscarCommits(filtros: { buscar?: string; repo?: string; rama?: string; top?: number } = {}): Observable<{ repositorio: string; rama: string; commits: CommitAzure[] }> {
    const params: Record<string, string> = {};
    Object.entries(filtros).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') params[k] = String(v); });
    return this.http.get<{ repositorio: string; rama: string; commits: CommitAzure[] }>(`${this.baseUrl}/commits-disponibles`, { params });
  }

  cambiarEstado(id: number, datos: {
    estado: string; motivo?: string; resultadoEjecucion?: string;
    // Duración real -- si no se mandan, el backend las completa solo al
    // marcar EJECUTADO (ver pasosProduccion.js); se mandan explícitas cuando
    // el usuario las prellenó/ajustó en el formulario.
    fechaHoraInicioReal?: string | null; fechaHoraFinReal?: string | null;
    // Obligatoria al pasar a REAGENDADO o ROLLBACK: la nueva fecha/hora de despliegue.
    fechaHoraProgramada?: string;
  }): Observable<PasoProduccion> {
    return this.http.patch<PasoProduccion>(`${this.baseUrl}/${id}/estado`, datos);
  }

  /** Eliminación FÍSICA (definitiva): borra el registro y todo lo que cuelga de él. */
  eliminar(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }

  /** Eliminación LÓGICA: pasa a «Eliminados» (se puede restaurar). */
  eliminarLogico(id: number, motivo?: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.baseUrl}/${id}/eliminar`, { motivo: motivo || undefined });
  }

  restaurar(id: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.baseUrl}/${id}/restaurar`, {});
  }

  /** Oculta el paso SOLO de mi vista principal. */
  ocultar(id: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.baseUrl}/${id}/ocultar`, {});
  }

  mostrar(id: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.baseUrl}/${id}/mostrar`, {});
  }

  accionMasiva(accion: AccionMasivaPasos, ids: number[], motivo?: string): Observable<ResultadoMasivoPasos> {
    return this.http.post<ResultadoMasivoPasos>(`${this.baseUrl}/acciones-masivas`, { accion, ids, motivo: motivo || undefined });
  }

  conteos(filtros: { propietarios?: string; equipos?: string; compartidos?: string; todos?: string } = {}): Observable<ConteosPasos> {
    const params: Record<string, string> = {};
    Object.entries(filtros).forEach(([k, v]) => { if (v) params[k] = v; });
    return this.http.get<ConteosPasos>(`${this.baseUrl}/conteos`, { params });
  }

  // ---------- Checklist de sub-pasos ----------

  listarChecklist(pasoId: number): Observable<ChecklistItem[]> {
    return this.http.get<ChecklistItem[]>(`${this.baseUrl}/${pasoId}/checklist`);
  }

  agregarChecklistItem(pasoId: number, descripcion: string): Observable<ChecklistItem> {
    return this.http.post<ChecklistItem>(`${this.baseUrl}/${pasoId}/checklist`, { descripcion });
  }

  actualizarChecklistItem(pasoId: number, itemId: number, datos: Partial<{ descripcion: string; completado: boolean }>): Observable<ChecklistItem> {
    return this.http.put<ChecklistItem>(`${this.baseUrl}/${pasoId}/checklist/${itemId}`, datos);
  }

  eliminarChecklistItem(pasoId: number, itemId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${pasoId}/checklist/${itemId}`);
  }

  // Marca el ítem como completado Y sube el pantallazo de evidencia en una
  // sola operación -- usado por el marcado "en línea" desde la vista
  // principal, donde la evidencia es obligatoria (ver pasosProduccion.js).
  // Con `completar: false` solo agrega la imagen al ítem, sin cambiar si está
  // marcado o no (para subir varias imágenes o sumar más a un ítem ya hecho).
  completarChecklistItemConEvidencia(pasoId: number, itemId: number, datos: { nombreOriginal: string; mimeType: string; contenidoBase64: string; completar?: boolean }): Observable<{ item: ChecklistItem; adjunto: Adjunto }> {
    return this.http.post<{ item: ChecklistItem; adjunto: Adjunto }>(`${this.baseUrl}/${pasoId}/checklist/${itemId}/evidencia`, datos);
  }

  // ---------- Adjuntos/evidencias ----------

  listarAdjuntos(pasoId: number): Observable<Adjunto[]> {
    return this.http.get<Adjunto[]>(`${this.baseUrl}/${pasoId}/adjuntos`);
  }

  obtenerAdjunto(pasoId: number, adjuntoId: number): Observable<AdjuntoCompleto> {
    return this.http.get<AdjuntoCompleto>(`${this.baseUrl}/${pasoId}/adjuntos/${adjuntoId}`);
  }

  subirAdjunto(pasoId: number, datos: { nombreOriginal: string; mimeType: string; contenidoBase64: string }): Observable<Adjunto> {
    return this.http.post<Adjunto>(`${this.baseUrl}/${pasoId}/adjuntos`, datos);
  }

  eliminarAdjunto(pasoId: number, adjuntoId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${pasoId}/adjuntos/${adjuntoId}`);
  }

  // ---------- Historial de cambios (reutiliza AuditoriaGeneral) ----------

  listarHistorial(pasoId: number): Observable<EventoHistorial[]> {
    return this.http.get<EventoHistorial[]>(`${this.baseUrl}/${pasoId}/historial`);
  }
}
