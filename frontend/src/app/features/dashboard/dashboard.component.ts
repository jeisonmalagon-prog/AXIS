import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DashboardService } from '../../core/services/dashboard.service';
import { CertificadoVigencia, ResumenDashboard } from '../../core/models/models';

interface SegmentoDonut { estado: string; valor: number; color: string; porcentaje: number; dashArray: string; dashOffset: number; }
interface GrupoConteo { nombre: string; cantidad: number; porcentajeAncho: number; }
interface RangoTiempo { etiqueta: string; cantidad: number; porcentajeAlto: number; clase: string; }

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit {
  resumen: ResumenDashboard | null = null;
  porVencerUrgentes: CertificadoVigencia[] = []; // Solo <= 30 días para la tabla

  segmentosDonut: SegmentoDonut[] = [];
  porAplicacion: GrupoConteo[] = [];
  porServidor: GrupoConteo[] = [];
  proyeccionTiempo: RangoTiempo[] = [];
  renovacionesTrimestre: number = 0;

  // Geometría del donut (SVG)
  readonly donutTamano = 150;
  readonly donutRadio = 65;
  readonly donutGrosor = 16;
  readonly donutCircunferencia = 2 * Math.PI * this.donutRadio;

  constructor(private dashboardService: DashboardService) {}

  ngOnInit(): void {
    // 1. Cargamos el resumen general
    this.dashboardService.resumen().subscribe((r) => {
      this.resumen = r;
      setTimeout(() => this.segmentosDonut = this.calcularDonut(r), 100);
    });

    // 2. Cargamos el panorama de TODO el año (365 días) para nutrir la analítica
    this.dashboardService.porVencer(365).subscribe((certificados) => {
      // Filtramos solo los urgentes para las tablas de abajo
      this.porVencerUrgentes = certificados.filter(c => c.DiasRestantes <= 30);
      
      // x.Aplicacion puede venir null: un certificado ya no pertenece a una
      // aplicación puntual, así que los certificados nuevos (ligados a
      // servidor + aplicación interna compartida) no traen un solo nombre de
      // aplicación resuelto en esta vista — se agrupan como "Sin especificar".
      this.porAplicacion = this.agrupar(this.porVencerUrgentes, (x) => x.Aplicacion || 'Sin especificar');
      this.porServidor = this.agrupar(this.porVencerUrgentes, (x) => x.Hostname);

      // Analítica extendida
      this.proyeccionTiempo = this.calcularProyeccion(certificados);
      this.renovacionesTrimestre = certificados.filter(c => c.DiasRestantes >= 0 && c.DiasRestantes <= 90).length;
    });
  }

  get totalCertificados(): number {
    if (!this.resumen) return 0;
    return (this.resumen.Vigente || 0) + (this.resumen['Por vencer'] || 0) + (this.resumen.Vencido || 0);
  }

  get indiceSalud(): number {
    if (this.totalCertificados === 0) return 100;
    const saludables = this.resumen?.Vigente || 0;
    return Math.round((saludables / this.totalCertificados) * 100);
  }

  estadoClase(estado: string): string {
    if (estado === 'Vigente') return 'status-vigente';
    if (estado === 'Por vencer') return 'status-por-vencer';
    return 'status-vencido';
  }

  urgenciaAncho(diasRestantes: number): number {
    const acotado = Math.max(0, Math.min(diasRestantes, 30));
    return Math.round(100 - (acotado / 30) * 100);
  }

  // --- LÓGICA DE GRÁFICOS ---

  private calcularDonut(resumen: ResumenDashboard | null): SegmentoDonut[] {
    if (!resumen) return [];
    const datos = [
      { estado: 'Vigentes', valor: resumen.Vigente || 0, color: '#10b981' },
      { estado: 'Por vencer', valor: resumen['Por vencer'] || 0, color: '#f59e0b' },
      { estado: 'Vencidos', valor: resumen.Vencido || 0, color: '#ef4444' },
    ];
    const total = datos.reduce((acc, d) => acc + d.valor, 0);
    if (total === 0) return [];

    let acumulado = 0;
    return datos.filter((d) => d.valor > 0).map((d) => {
      const porcentaje = (d.valor / total) * 100;
      const largo = (porcentaje / 100) * this.donutCircunferencia;
      const segmento = {
        estado: d.estado, valor: d.valor, color: d.color, porcentaje: Math.round(porcentaje),
        dashArray: `${largo} ${this.donutCircunferencia - largo}`, dashOffset: -acumulado,
      };
      acumulado += largo;
      return segmento;
    });
  }

  private calcularProyeccion(items: CertificadoVigencia[]): RangoTiempo[] {
    const rangos: RangoTiempo[] = [
      { etiqueta: 'Críticos', cantidad: items.filter(i => i.DiasRestantes < 0).length, porcentajeAlto: 0, clase: 'bar-danger' },
      { etiqueta: '≤ 30d', cantidad: items.filter(i => i.DiasRestantes >= 0 && i.DiasRestantes <= 30).length, porcentajeAlto: 0, clase: 'bar-warn' },
      { etiqueta: '31 - 60d', cantidad: items.filter(i => i.DiasRestantes > 30 && i.DiasRestantes <= 60).length, porcentajeAlto: 0, clase: 'bar-purple' },
      { etiqueta: '61 - 90d', cantidad: items.filter(i => i.DiasRestantes > 60 && i.DiasRestantes <= 90).length, porcentajeAlto: 0, clase: 'bar-purple-light' },
      { etiqueta: '91 - 180d', cantidad: items.filter(i => i.DiasRestantes > 90 && i.DiasRestantes <= 180).length, porcentajeAlto: 0, clase: 'bar-ok' },
      { etiqueta: '> 180d', cantidad: items.filter(i => i.DiasRestantes > 180).length, porcentajeAlto: 0, clase: 'bar-ok-light' }
    ];

    const max = Math.max(...rangos.map(r => r.cantidad), 1);
    rangos.forEach(r => r.porcentajeAlto = Math.round((r.cantidad / max) * 100));
    return rangos;
  }

  private agrupar(items: CertificadoVigencia[], selector: (c: CertificadoVigencia) => string, limite = 5): GrupoConteo[] {
    const mapa = new Map<string, number>();
    for (const item of items) {
      const clave = selector(item) || 'Sin especificar';
      mapa.set(clave, (mapa.get(clave) || 0) + 1);
    }
    const grupos: GrupoConteo[] = Array.from(mapa.entries())
      .map(([nombre, cantidad]) => ({ nombre, cantidad, porcentajeAncho: 0 }))
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, limite);
    const max = grupos.length ? grupos[0].cantidad : 1;
    grupos.forEach((g) => (g.porcentajeAncho = Math.round((g.cantidad / max) * 100)));
    return grupos;
  }
}