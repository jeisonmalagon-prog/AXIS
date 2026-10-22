import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SistemaOperativo } from '../models/models';

@Injectable({ providedIn: 'root' })
export class SistemaOperativoService {
  private baseUrl = `${environment.apiUrl}/sistemas-operativos`;

  constructor(private http: HttpClient) {}

  listar(): Observable<SistemaOperativo[]> {
    return this.http.get<SistemaOperativo[]>(this.baseUrl);
  }
}
