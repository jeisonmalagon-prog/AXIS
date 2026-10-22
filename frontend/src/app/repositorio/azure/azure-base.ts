import { Directive, OnDestroy, OnInit, inject } from '@angular/core';
import { Subject, filter, takeUntil } from 'rxjs';
import { RepositorioContextService } from '../repositorio-context.service';
import { AzureApiService } from './azure-api.service';
import { FalloAzure, falloDe } from './azure-utils';

// Base común de las pestañas: espera a que haya repositorio seleccionado, vuelve
// a cargar cuando el usuario lo cambia y limpia las suscripciones al destruirse.
@Directive()
export abstract class AzureBase implements OnInit, OnDestroy {
  protected readonly api = inject(AzureApiService);
  protected readonly ctx = inject(RepositorioContextService);
  protected readonly destruir$ = new Subject<void>();

  cargando = false;
  fallo: FalloAzure | null = null;

  ngOnInit(): void {
    this.ctx.repositorioActual$.pipe(filter((r) => !!r), takeUntil(this.destruir$)).subscribe(() => this.alCambiarRepo());
    this.ctx.cargarRepositorios();
  }

  ngOnDestroy(): void {
    this.destruir$.next();
    this.destruir$.complete();
  }

  protected abstract alCambiarRepo(): void;

  protected fallar(err: any, porDefecto: string): void {
    this.fallo = falloDe(err, porDefecto);
    this.cargando = false;
  }
}
