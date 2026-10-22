import { Pipe, PipeTransform } from '@angular/core';

// Número con formato es-CO (miles con punto, decimales con coma). Los textos del
// tablero ya se formatean así; esto evita mezclar con el pipe `number` (en-US).
@Pipe({ name: 'numEs', standalone: true })
export class NumEsPipe implements PipeTransform {
  transform(valor: number | null | undefined, maxDecimales = 0, minDecimales = 0): string {
    if (valor === null || valor === undefined || Number.isNaN(Number(valor))) return '—';
    return Number(valor).toLocaleString('es-CO', { minimumFractionDigits: minDecimales, maximumFractionDigits: maxDecimales });
  }
}
