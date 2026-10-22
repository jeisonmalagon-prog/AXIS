import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ServidorService } from '../../core/services/servidor.service';
import { AplicacionService } from '../../core/services/aplicacion.service';
import { CertificadoService } from '../../core/services/certificado.service';
import { CertificadoVigencia, Servidor } from '../../core/models/models';

type Estado = 'Vigente' | 'Por vencer' | 'Vencido';
type ModoDetalle = 'servidor' | 'aplicacion' | 'componente' | 'certificado';

// "Aplicación interna" (el rol/componente dentro de una aplicación, ej. DOC_MANAGER)
// junto con el o los certificados que tiene cargados hoy. Puede tener 0 (todavía sin
// certificado), 1, o varios (ej. el vigente + el de renovación ya cargado).
interface NodoComponente {
  rol: string;
  aplicacionId: any;
  aplicacionNombre: string;
  servidorId: number;
  certificados: CertificadoVigencia[];
  // Nombres de OTRAS aplicaciones que también tienen este mismo servidor+rol
  // registrado — la señal de la novedad reportada (ej. "MOtor de Firma" / "APP MOVIL").
  otrasAplicaciones: string[];
}

// Una aplicación tal como aparece desplegada en UN servidor concreto (la misma
// aplicación puede repetirse en varios nodos de servidor si está en varios servidores).
interface NodoAplicacion {
  aplicacionId: any;
  aplicacionNombre: string;
  imagenUrl: string | null;
  componentes: NodoComponente[];
  // Certificados de esta aplicación en este servidor que no calzan con ninguna
  // "aplicación interna" definida (típicamente certificados cargados antes de este
  // cambio, que todavía no tienen Componente asignado).
  sueltos: CertificadoVigencia[];
}

interface NodoServidor {
  servidorId: number;
  hostname: string;
  ip: string;
  so: string;
  ambiente: string | null;
  aplicaciones: NodoAplicacion[];
  // Certificados de este servidor que no se pudieron asociar a ninguna aplicación
  // conocida en él (datos inconsistentes / aplicación borrada, etc.).
  sinClasificar: CertificadoVigencia[];
  certificadosPlanos: CertificadoVigencia[];
  totalCertificados: number;
  peorEstado: Estado | null;
  expandido: boolean;
}

interface DetalleContexto {
  modo: ModoDetalle;
  servidor?: NodoServidor;
  aplicacion?: NodoAplicacion;
  componente?: NodoComponente;
  certificado?: CertificadoVigencia;
}

@Component({
  selector: 'app-certificados-por-servidor',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './certificados-por-servidor.component.html',
  styleUrl: './certificados-por-servidor.component.scss',
})
export class CertificadosPorServidorComponent implements OnInit {
  cargando = true;

  private servidores: Servidor[] = [];
  private aplicaciones: any[] = [];
  private certificados: CertificadoVigencia[] = [];

  nodos: NodoServidor[] = [];

  terminoBusqueda = '';
  opcionesFiltro: ('Todos' | Estado)[] = ['Todos', 'Vigente', 'Por vencer', 'Vencido'];
  filtro: 'Todos' | Estado = 'Todos';

  detalle: DetalleContexto | null = null;

  constructor(
    private servidorService: ServidorService,
    private aplicacionService: AplicacionService,
    private certificadoService: CertificadoService,
  ) {}

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando = true;
    forkJoin({
      servidores: this.servidorService.listar(),
      aplicaciones: this.aplicacionService.listar(),
      certificados: this.certificadoService.listar(),
    }).subscribe({
      next: ({ servidores, aplicaciones, certificados }) => {
        this.servidores = servidores;
        this.aplicaciones = aplicaciones;
        this.certificados = certificados;
        this.construirArbol();
        this.cargando = false;
      },
      error: (err) => {
        console.error('Error cargando la vista por servidor:', err);
        this.cargando = false;
      },
    });
  }

  // ============================================================
  // CONSTRUCCIÓN DEL ÁRBOL: Servidor → Aplicación → Aplicación interna → Certificado(s)
  // ============================================================

  // La API de Aplicaciones devuelve { id, nombre, servidores: [{ id, hostname, ip,
  // roles, ... }] } — desde el ajuste de "puerto por componente", roles es un
  // arreglo de objetos { rol, puerto, tipo } (mismo criterio usado en
  // certificados-list.component.ts y aplicaciones-list.component.ts); aquí solo
  // interesa el nombre, así que se soportan ambas formas por compatibilidad.
  private rolesDe(entradaServidor: any): string[] {
    if (entradaServidor?.roles && entradaServidor.roles.length) {
      return entradaServidor.roles.map((r: any) => (typeof r === 'string' ? r : r.rol)).filter((r: string) => !!r);
    }
    const desc = entradaServidor?.descripcion || entradaServidor?.Descripcion || '';
    return desc
      ? desc.split(',').map((r: string) => r.trim()).filter((r: string) => r !== '')
      : [];
  }

  // Mismo criterio de "duplicado" ya usado en Certificados/Aplicaciones: busca si el
  // mismo servidor+rol también está asignado a otra aplicación distinta.
  private otrasAplicacionesConEsteComponente(servidorId: number, rol: string, idAppActual: any): string[] {
    const rolLower = rol.toLowerCase();
    const nombres: string[] = [];
    for (const otraApp of this.aplicaciones) {
      const idOtraApp = otraApp.id ?? otraApp.Id;
      if (idOtraApp === idAppActual) continue;
      const servidor = (otraApp.servidores || []).find((s: any) => (s.id ?? s.Id) === servidorId);
      if (!servidor) continue;
      if (this.rolesDe(servidor).some((r) => r.toLowerCase() === rolLower)) {
        nombres.push(otraApp.nombre || otraApp.Nombre);
      }
    }
    return nombres;
  }

  private peorEstadoDe(certs: CertificadoVigencia[]): Estado | null {
    if (certs.some((c) => c.Estado === 'Vencido')) return 'Vencido';
    if (certs.some((c) => c.Estado === 'Por vencer')) return 'Por vencer';
    if (certs.length) return 'Vigente';
    return null;
  }

  private construirArbol(): void {
    this.nodos = this.servidores.map((servidor) => {
      // Agrupar por Hostname (no por ServidorId): la vista SQL ya resuelve el
      // servidor correcto tanto para certificados nuevos (con su propio
      // ServidorId/Componente) como para certificados antiguos (que solo tienen el
      // servidor "legado" de su Aplicación) — reutilizar ese resultado evita
      // duplicar esa lógica de fallback aquí.
      const hostnameServidor = (servidor.Hostname || '').toLowerCase();
      const certsDelServidor = this.certificados.filter(
        (c) => (c.Hostname || '').toLowerCase() === hostnameServidor,
      );
      const certsUsados = new Set<CertificadoVigencia>();

      const aplicacionesEnServidor = this.aplicaciones
        .map((app) => {
          const entradaServidor = (app.servidores || []).find((s: any) => (s.id ?? s.Id) === servidor.Id);
          if (!entradaServidor) return null;
          return { app, roles: this.rolesDe(entradaServidor) };
        })
        .filter((x): x is { app: any; roles: string[] } => x !== null);

      const nodoAplicaciones: NodoAplicacion[] = aplicacionesEnServidor.map(({ app, roles }) => {
        const idApp = app.id ?? app.Id;
        const nombreApp = app.nombre || app.Nombre;

        const componentes: NodoComponente[] = roles.map((rol) => {
          const rolLower = rol.toLowerCase();
          // Un certificado pertenece al servidor + aplicación interna, no a una
          // aplicación puntual — por eso NO se filtra por AplicacionId: si el
          // componente es compartido, el mismo certificado aparece aquí y
          // también bajo cada otra aplicación que lo comparta (ver
          // migracion_certificados_compartidos.sql).
          const certsDelComponente = certsDelServidor.filter(
            (c) => (c.Componente || '').toLowerCase() === rolLower,
          );
          certsDelComponente.forEach((c) => certsUsados.add(c));

          return {
            rol,
            aplicacionId: idApp,
            aplicacionNombre: nombreApp,
            servidorId: servidor.Id,
            certificados: certsDelComponente,
            otrasAplicaciones: this.otrasAplicacionesConEsteComponente(servidor.Id, rol, idApp),
          };
        });

        // Certificados de esta aplicación en este servidor que no quedaron ligados a
        // ninguna aplicación interna (por ejemplo, cargados antes de este cambio).
        const sueltos = certsDelServidor.filter((c) => c.AplicacionId === idApp && !certsUsados.has(c));
        sueltos.forEach((c) => certsUsados.add(c));

        return {
          aplicacionId: idApp,
          aplicacionNombre: nombreApp,
          imagenUrl: app.imagenUrl || app.ImagenUrl || null,
          componentes,
          sueltos,
        };
      });

      const sinClasificar = certsDelServidor.filter((c) => !certsUsados.has(c));

      return {
        servidorId: servidor.Id,
        hostname: servidor.Hostname,
        ip: servidor.IP,
        so: servidor.SistemaOperativo || '',
        ambiente: servidor.Ambiente,
        aplicaciones: nodoAplicaciones,
        sinClasificar,
        certificadosPlanos: certsDelServidor,
        totalCertificados: certsDelServidor.length,
        peorEstado: this.peorEstadoDe(certsDelServidor),
        expandido: true,
      };
    });
  }

  // ============================================================
  // FILTRO (estado + búsqueda) — se aplica a nivel de servidor, para no complicar
  // la visualización interna del árbol; las filas de certificado que no coinciden
  // con el filtro de estado quedan atenuadas (ver certCoincideFiltro).
  // ============================================================

  get nodosFiltrados(): NodoServidor[] {
    return this.nodos.filter((n) => this.nodoCoincide(n));
  }

  private nodoCoincide(n: NodoServidor): boolean {
    if (this.filtro !== 'Todos' && !n.certificadosPlanos.some((c) => c.Estado === this.filtro)) {
      return false;
    }
    if (!this.terminoBusqueda) return true;
    const termino = this.terminoBusqueda.toLowerCase().trim();
    const texto = JSON.stringify({
      hostname: n.hostname,
      ip: n.ip,
      so: n.so,
      ambiente: n.ambiente,
      aplicaciones: n.aplicaciones,
      sinClasificar: n.sinClasificar,
    }).toLowerCase();
    return texto.includes(termino);
  }

  // Atenúa (sin ocultar) las filas de certificado que no coinciden con el filtro de
  // estado activo, para no reconstruir todo el árbol solo por eso.
  certCoincideFiltro(cert: CertificadoVigencia): boolean {
    return this.filtro === 'Todos' || cert.Estado === this.filtro;
  }

  // ============================================================
  // EXPANDIR / COLAPSAR
  // ============================================================

  toggleServidor(n: NodoServidor): void {
    n.expandido = !n.expandido;
  }

  expandirTodo(): void {
    this.nodos.forEach((n) => (n.expandido = true));
  }

  colapsarTodo(): void {
    this.nodos.forEach((n) => (n.expandido = false));
  }

  // ============================================================
  // PANEL DE DETALLE
  // ============================================================

  abrirDetalleServidor(n: NodoServidor): void {
    this.detalle = { modo: 'servidor', servidor: n };
  }

  abrirDetalleAplicacion(n: NodoServidor, a: NodoAplicacion): void {
    this.detalle = { modo: 'aplicacion', servidor: n, aplicacion: a };
  }

  abrirDetalleComponente(n: NodoServidor, a: NodoAplicacion, c: NodoComponente): void {
    this.detalle = { modo: 'componente', servidor: n, aplicacion: a, componente: c };
  }

  abrirDetalleCertificado(
    n: NodoServidor,
    a: NodoAplicacion | null,
    c: NodoComponente | null,
    cert: CertificadoVigencia,
  ): void {
    this.detalle = {
      modo: 'certificado',
      servidor: n,
      aplicacion: a ?? undefined,
      componente: c ?? undefined,
      certificado: cert,
    };
  }

  cerrarDetalle(): void {
    this.detalle = null;
  }

  // Total de certificados de una aplicación (en un servidor dado): la suma de los
  // que están clasificados por aplicación interna más los "sueltos" sin clasificar.
  totalCertsDeAplicacion(a: NodoAplicacion): number {
    return a.componentes.reduce((total, c) => total + c.certificados.length, 0) + a.sueltos.length;
  }

  // ============================================================
  // HELPERS VISUALES (mismo criterio que certificados-list y aplicaciones-list)
  // ============================================================

  estadoClase(estado: string | undefined | null): string {
    if (estado === 'Vigente') return 'status-vigente';
    if (estado === 'Por vencer') return 'status-por-vencer';
    if (estado === 'Vencido') return 'status-vencido';
    return '';
  }

  // Cubre los patrones reales usados en el inventario (container_*, API_URL_*, etc.)
  claseRol(rol: string): string {
    const r = (rol || '').toLowerCase();

    if (r.includes('kafka')) return 'tag-kafka';
    if (r.includes('suscriptor')) return 'tag-suscriptor';
    if (r.includes('orquestador')) return 'tag-orquestador';
    if (
      r.includes('api') ||
      r.includes('gateway') ||
      r.includes('akaunt') ||
      r.includes('nodo') ||
      r.includes('mensajeria')
    )
      return 'tag-api';
    if (r.includes('log')) return 'tag-logs';
    if (r.includes('imagen') || r.includes('doc') || r.includes('firm')) return 'tag-docs';
    if (r.includes('balanceador') || r.includes(' lb') || r.startsWith('lb')) return 'tag-balanceador';
    if (r.includes('job') || r.includes('batch') || r.includes('cron') || r.includes('scheduler'))
      return 'tag-job';
    if (r.includes('db') || r.includes('base de datos') || r.includes('sql') || r.includes('mysql'))
      return 'tag-db';

    return 'tag-otro';
  }
}