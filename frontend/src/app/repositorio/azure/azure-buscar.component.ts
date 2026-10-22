import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AzureBase } from './azure-base';
import { AzureFalloComponent } from './azure-fallo.component';
import { falloDe, fmtNum } from './azure-utils';
import { IcoComponent } from '../../shared/ico/ico.component';

@Component({
  selector: 'app-azure-buscar',
  standalone: true,
  imports: [IcoComponent, CommonModule, FormsModule, AzureFalloComponent],
  templateUrl: './azure-buscar.component.html',
  styleUrl: './azure-buscar.component.scss',
})
export class AzureBuscarComponent extends AzureBase {
  readonly fmtNum = fmtNum;

  q = '';
  tipo: 'codigo' | 'wiki' = 'codigo';
  soloEsteRepo = false;
  pagina = 1;
  readonly limite = 25;
  resultado: any = null;
  buscado = false;

  protected alCambiarRepo(): void { /* la búsqueda es bajo demanda */ }

  buscar(reiniciar = true): void {
    const texto = this.q.trim();
    if (texto.length < 2) { this.fallo = { error: 'Escribe al menos 2 caracteres para buscar.' }; return; }
    if (reiniciar) this.pagina = 1;
    this.cargando = true; this.fallo = null; this.buscado = true;
    this.api.get<any>('/buscar', { q: texto, tipo: this.tipo, pagina: this.pagina, limite: this.limite, repo: this.soloEsteRepo ? this.ctx.repositorioActual : '' }, false).subscribe({
      next: (r) => { this.resultado = r; this.cargando = false; },
      error: (e) => { this.resultado = null; this.fallo = falloDe(e, 'No se pudo buscar.'); this.cargando = false; },
    });
  }

  cambiarPagina(d: number): void { this.pagina = Math.max(1, this.pagina + d); this.buscar(false); }

  get hayMas(): boolean { return !!this.resultado && this.resultado.total > this.pagina * this.limite; }
}
