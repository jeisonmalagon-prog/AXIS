import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Definimos la estructura de un mensaje
export interface ChatMensaje {
  emisor: 'usuario' | 'ia';
  texto: string;
  fecha: Date;
}

// Forma en la que llega cada fila del historial guardado en el backend
// (AsistenteHistorial) -- distinta a ChatMensaje porque usa los mismos roles
// que Ollama ('user'/'assistant') en vez de 'usuario'/'ia'.
export interface HistorialMensaje {
  rol: 'user' | 'assistant';
  mensaje: string;
  fecha: string;
}

// Resumen de una conversacion para el panel lateral tipo "chats" (una fila
// por conversacion, no por mensaje).
export interface ConversacionResumen {
  conversacionId: number;
  titulo: string;
  fechaUltimoMensaje: string;
}

// Modelo disponible en el servidor de "modelos generales" (Open WebUI).
export interface ModeloGeneral {
  id: string;
  nombre: string;
}

@Injectable({
  providedIn: 'root'
})
export class IaService {
  private apiUrl = `${environment.apiUrl}/ia`;

  constructor(private http: HttpClient) {}

  // conversacionId: null/undefined en el primer mensaje de una conversacion
  // nueva -- el backend crea uno y lo devuelve en la respuesta. Del segundo
  // mensaje en adelante se manda el mismo id para seguir en el mismo hilo.
  enviarPregunta(historial: any[], conversacionId?: number | null): Observable<{ reply: string; conversacionId: number }> {
    return this.http.post<{ reply: string; conversacionId: number }>(`${this.apiUrl}/chat`, { historial, conversacionId });
  }

  // Lista de conversaciones del usuario actual (cada quien ve solo las
  // suyas), mas reciente primero -- para el panel lateral de chats.
  // tipo 'general' = las de la pestana de modelos generales.
  listarConversaciones(tipo: 'axis' | 'general' = 'axis'): Observable<ConversacionResumen[]> {
    return this.http.get<ConversacionResumen[]>(`${this.apiUrl}/conversaciones`, {
      params: tipo === 'general' ? { tipo: 'general' } : {}
    });
  }

  // Modelos que ofrece el servidor de modelos generales.
  listarModelosGenerales(): Observable<{ servidor: string; modelos: ModeloGeneral[] }> {
    return this.http.get<{ servidor: string; modelos: ModeloGeneral[] }>(`${this.apiUrl}/modelos-generales`);
  }

  // Conversa con un modelo general (sin acceso a la base de datos de AXIS).
  enviarPreguntaGeneral(modelo: string, historial: any[], conversacionId?: number | null): Observable<{ reply: string; conversacionId: number; modelo: string }> {
    return this.http.post<{ reply: string; conversacionId: number; modelo: string }>(`${this.apiUrl}/chat-general`, { modelo, historial, conversacionId });
  }

  // Mensajes de UNA conversacion en concreto (al hacer click en el panel
  // lateral).
  obtenerConversacion(conversacionId: number): Observable<HistorialMensaje[]> {
    return this.http.get<HistorialMensaje[]>(`${this.apiUrl}/historial/${conversacionId}`);
  }
}