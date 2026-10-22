import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ServidorService } from '../../core/services/servidor.service';
import { SistemaOperativoService } from '../../core/services/sistema-operativo.service';
import { AuthService } from '../../services/auth.service';
import { Servidor, SistemaOperativo } from '../../core/models/models';

@Component({
  selector: 'app-servidores-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './servidores-list.component.html',
  styleUrl: './servidores-list.component.scss',
})
export class ServidoresListComponent implements OnInit {
  servidores: Servidor[] = [];
  sistemasOperativos: SistemaOperativo[] = [];
  mostrarForm = false;
  editando: Servidor | null = null;
  terminoBusqueda: string = '';

  // Filtro rápido por ambiente (chips debajo del buscador). null = "Todos".
  // Se combina con terminoBusqueda: primero se filtra por ambiente, luego
  // por texto sobre ese subconjunto.
  filtroAmbiente: string | null = null;

  // Solo ADMIN_POD/ADMIN_MIN pueden crear/editar/borrar. BASIC = solo lectura.
  puedeEditar = false;

  form: Partial<Servidor> = { Hostname: '', IP: '', SistemaOperativoId: undefined, Ambiente: null };

  constructor(
    private servidorService: ServidorService,
    private soService: SistemaOperativoService,
    private authService: AuthService,
  ) {}

  ngOnInit(): void {
    this.puedeEditar = this.authService.puedeEditar('CERTIFICADOS');

    // Cargamos primero los S.O. para tenerlos disponibles para el buscador
    this.soService.listar().subscribe((so) => {
      this.sistemasOperativos = so;
      this.cargar(); // Cargamos los servidores después
    });
  }

  cargar(): void {
    this.servidorService.listar().subscribe((data) => (this.servidores = data));
  }

  // Helper para buscar el nombre real del S.O. cruzando los IDs
  obtenerNombreSO(idSo: any): string {
    if (!idSo) return '';
    const so = this.sistemasOperativos.find(s => s.Id === idSo);
    return so ? so.Nombre : '';
  }


  get servidoresFiltrados(): any[] {
    let lista = this.servidores;

    if (this.filtroAmbiente) {
      lista = lista.filter((s) => this.normalizarAmbiente(s.Ambiente) === this.filtroAmbiente);
    }

    if (this.terminoBusqueda) {
      const termino = this.terminoBusqueda.toLowerCase().trim();
      // JSON.stringify convierte TODA la información del servidor a texto.
      // Si la palabra "Linux" existe en cualquier parte de los datos, la encontrará.
      lista = lista.filter((servidor) => JSON.stringify(servidor).toLowerCase().includes(termino));
    }

    return lista;
  }

  // --- Ambiente: los datos vienen con variantes inconsistentes de la misma
  // información ("PRODUCCION", "Producción", "Produccion"...), probablemente
  // por captura manual a lo largo del tiempo. Se normaliza SOLO para mostrar
  // el chip de filtro y el color del badge — nunca se reescribe el dato
  // original en la base de datos.
  normalizarAmbiente(ambiente: string | null | undefined): string {
    if (!ambiente || !ambiente.trim()) return 'Sin especificar';
    const limpio = ambiente
      .trim()
      .toLowerCase()
      .replace(/[áàäâ]/g, 'a')
      .replace(/[éèëê]/g, 'e')
      .replace(/[íìïî]/g, 'i')
      .replace(/[óòöô]/g, 'o')
      .replace(/[úùüû]/g, 'u'); // quita tildes para comparar, sin depender de normalize('NFD')

    if (limpio.startsWith('prod')) return 'Producción';
    if (limpio === 'qa') return 'QA';
    if (limpio.startsWith('desarrollo') || limpio === 'dev') return 'Desarrollo';
    if (limpio.startsWith('prueba')) return 'Pruebas';
    return ambiente.trim();
  }

  claseAmbiente(ambienteNormalizado: string): string {
    const v = ambienteNormalizado.toLowerCase();
    if (v === 'producción') return 'amb-prod';
    if (v === 'qa') return 'amb-qa';
    if (v === 'desarrollo') return 'amb-dev';
    if (v === 'pruebas') return 'amb-pruebas';
    if (v === 'sin especificar') return 'amb-ninguno';
    return 'amb-otro';
  }

  // Chips de ambiente con conteo, ordenados de mayor a menor.
  get chipsAmbiente(): { valor: string; total: number }[] {
    const mapa = new Map<string, number>();
    for (const s of this.servidores) {
      const norm = this.normalizarAmbiente(s.Ambiente);
      mapa.set(norm, (mapa.get(norm) || 0) + 1);
    }
    return Array.from(mapa.entries())
      .map(([valor, total]) => ({ valor, total }))
      .sort((a, b) => b.total - a.total);
  }

  seleccionarAmbiente(valor: string): void {
    this.filtroAmbiente = this.filtroAmbiente === valor ? null : valor;
  }

  // --- Sistema operativo: para el color del badge y el resumen de arriba.
  claseSO(nombreSO: string | undefined): string {
    const v = (nombreSO || '').toLowerCase();
    if (v.includes('linux')) return 'so-linux';
    if (v.includes('windows')) return 'so-windows';
    return 'so-otro';
  }

  contarPorSO(fragmento: string): number {
    const f = fragmento.toLowerCase();
    return this.servidores.filter((s) => (s.SistemaOperativo || '').toLowerCase().includes(f)).length;
  }

  abrirFormulario(): void {
    if (!this.puedeEditar) return;
    this.editando = null;
    this.form = { Hostname: '', IP: '', SistemaOperativoId: undefined, Ambiente: null };
    this.mostrarForm = true;
  }

  editar(servidor: Servidor): void {
    if (!this.puedeEditar) return;
    this.editando = servidor;
    this.form = { ...servidor };
    this.mostrarForm = true;
  }

  cerrarFormulario(): void {
    this.mostrarForm = false;
  }

  guardar(): void {
    if (!this.puedeEditar) return;
    if (!this.form.Hostname || !this.form.IP || !this.form.SistemaOperativoId) {
      alert('Hostname, IP y Sistema Operativo son obligatorios');
      return;
    }

    const accion = this.editando && this.editando.Id
      ? this.servidorService.actualizar(this.editando.Id, this.form)
      : this.servidorService.crear(this.form);

    accion.subscribe({
      next: () => {
        this.cargar();
        this.cerrarFormulario();
      },
      error: (err) => {
        console.error('Error guardando servidor:', err);
        const detalleError = err.error?.error || 'Verifica que Hostname e IP no estén duplicados.';
        alert(`❌ Error al guardar el servidor:\n${detalleError}`);
      }
    });
  }

  eliminar(servidor: Servidor): void {
    if (!this.puedeEditar) return;
    if (!confirm(`¿Eliminar el servidor ${servidor.Hostname}?`)) return;

    if (servidor.Id) {
      this.servidorService.eliminar(servidor.Id).subscribe({
        next: () => this.cargar(),
        error: (err) => {
          console.error('Error eliminando servidor:', err);
          const detalleError = err.error?.error || 'No se pudo eliminar el servidor.';
          alert(`❌ Error al eliminar:\n${detalleError}`);
        }
      });
    }
  }
}