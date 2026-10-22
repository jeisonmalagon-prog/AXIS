import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';

export interface OpcionServidor {
  id: number;
  nombre: string;
  subtitulo?: string;
}

export interface AplicativoImpacto {
  id: number;
  nombre_aplicacion: string;
  plataforma?: string;
  puerto?: number | null;
  criticidad?: string;
  aplicacion_negocio_nombre?: string | null;
}

export interface DependenciaBd {
  id: number;
  motor_bd: string;
  nombre_base_datos: string;
  esquema?: string | null;
  puerto?: number | null;
  usuario_servicio?: string | null;
  aplicativo_id: number;
  aplicativo_nombre: string;
  servidor_id?: number | null;
  servidor_hostname?: string | null;
  servidor_ip?: string | null;
}

export interface ConexionSaliente {
  id: number;
  motor_bd: string;
  nombre_base_datos: string;
  esquema?: string | null;
  puerto?: number | null;
  aplicativo_nombre: string;
  servidor_bd_hostname: string;
  servidor_bd_ip: string;
}

export interface IntegracionEntrante {
  id: number;
  descripcion?: string | null;
  origen_tipo: 'aplicativo' | 'servidor';
  origen_nombre: string;
  origen_servidor?: string | null;
}

export interface IntegracionSaliente {
  id: number;
  descripcion?: string | null;
  origen_nombre: string;
  destino_tipo: 'aplicativo' | 'servidor';
  destino_nombre: string;
  destino_servidor?: string | null;
}

export interface CertificadoImpacto {
  id: number;
  nombre_comun: string;
  entidad_emisora?: string;
  fecha_fin?: string;
}

export interface Impacto {
  servidor: {
    id: number;
    hostname: string;
    ip_address: string;
    ambiente?: string;
    estado?: string;
    criticidad?: string;
    sistema_operativo?: string;
  };
  alojados: AplicativoImpacto[];
  dependen_de_sus_bd: DependenciaBd[];
  conexiones_salientes: ConexionSaliente[];
  entrantes: IntegracionEntrante[];
  salientes: IntegracionSaliente[];
  aplicaciones_negocio: { id: number; nombre: string }[];
  certificados: CertificadoImpacto[];
}

@Component({
  selector: 'app-impacto',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './impacto.component.html',
  styleUrl: './impacto.component.scss'
})
export class ImpactoComponent implements OnInit {
  servidores: OpcionServidor[] = [];
  servidorId: number | null = null;
  impacto: Impacto | null = null;
  cargando = false;
  terminoBusqueda = '';

  private endpoint = `${environment.apiUrl}/servidoresInventario`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.http.get<{ servidores: OpcionServidor[] }>(`${this.endpoint}/catalogos/opciones-integracion`).subscribe({
      next: (data) => this.servidores = data.servidores || [],
      error: (err) => console.error('Error cargando servidores:', err)
    });
  }

  get servidoresFiltrados(): OpcionServidor[] {
    if (!this.terminoBusqueda) return this.servidores;
    const t = this.terminoBusqueda.toLowerCase().trim();
    return this.servidores.filter(s =>
      s.nombre.toLowerCase().includes(t) || (s.subtitulo || '').toLowerCase().includes(t)
    );
  }

  analizar(id: number | null): void {
    this.servidorId = id;
    if (!id) { this.impacto = null; return; }
    this.cargando = true;
    this.http.get<Impacto>(`${this.endpoint}/impacto/${id}`).subscribe({
      next: (data) => { this.impacto = data; this.cargando = false; },
      error: (err) => {
        console.error('Error calculando el impacto:', err);
        this.impacto = null;
        this.cargando = false;
      }
    });
  }

  // --- Resumen ---

  // Servidores distintos que quedarían afectados por caída de las bases de
  // datos que este servidor aloja (no se cuentan conexiones, sino máquinas).
  get servidoresAfectados(): string[] {
    if (!this.impacto) return [];
    return [...new Set(
      this.impacto.dependen_de_sus_bd
        .map(d => d.servidor_hostname)
        .filter((h): h is string => !!h)
    )];
  }

  // Peor criticidad entre el servidor y todo lo que se cae con él: es el
  // número que de verdad importa al decidir una ventana de mantenimiento.
  get criticidadMaxima(): string {
    if (!this.impacto) return 'ND';
    const orden: { [k: string]: number } = { 'Alta': 3, 'Media': 2, 'Baja': 1 };
    let mejor = this.impacto.servidor.criticidad || '';
    let valor = orden[mejor] || 0;
    for (const a of this.impacto.alojados) {
      const v = orden[a.criticidad || ''] || 0;
      if (v > valor) { valor = v; mejor = a.criticidad as string; }
    }
    return mejor || 'ND';
  }

  get totalAfectados(): number {
    if (!this.impacto) return 0;
    return this.impacto.alojados.length
      + this.impacto.dependen_de_sus_bd.length
      + this.impacto.entrantes.length;
  }

  // Certificado vencido o próximo a vencer: un dato que suele descubrirse
  // tarde, justo cuando ya se está interviniendo el servidor.
  diasParaVencer(fecha?: string): number | null {
    if (!fecha) return null;
    const fin = new Date(fecha).getTime();
    if (isNaN(fin)) return null;
    return Math.ceil((fin - Date.now()) / (1000 * 60 * 60 * 24));
  }

  claseVencimiento(fecha?: string): string {
    const dias = this.diasParaVencer(fecha);
    if (dias === null) return '';
    if (dias < 0) return 'vencido';
    if (dias <= 30) return 'por-vencer';
    return '';
  }

  // Se resuelve aquí y no en la plantilla: las comparaciones con "<" dentro de
  // una interpolación son frágiles al parsear el HTML.
  textoVencimiento(fecha?: string): string {
    const dias = this.diasParaVencer(fecha);
    if (dias === null) return '';
    if (dias < 0) return `vencido hace ${Math.abs(dias)} días`;
    if (dias === 0) return 'vence hoy';
    return `vence en ${dias} días`;
  }
}