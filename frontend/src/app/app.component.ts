import { Component, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BrandColorService } from './services/brand-color.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet></router-outlet>`,
  styles: [],
})
export class AppComponent implements OnInit {
  constructor(private brandColorService: BrandColorService) {}

  ngOnInit(): void {
    // Aplica el color de marca guardado por el admin (ver /configuracion) a
    // TODA la app apenas arranca, antes de que se pinte cualquier vista
    // (incluido el login). Ver BrandColorService para el detalle.
    this.brandColorService.inicializar();
  }
}
