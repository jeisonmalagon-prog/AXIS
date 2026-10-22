// Utilidades de color de marca de AXIS. El admin elige UN solo
// color de marca desde /configuracion (ver backend ConfiguracionSistema,
// clave 'color_login'); a partir de ese único valor generamos toda la
// paleta que usa el login (tono oscuro para el degradado, tonos claros para
// que se siga viendo bien sobre fondo oscuro) para no pedirle al admin que
// combine varios colores a mano.

export const COLOR_LOGIN_POR_DEFECTO = '#673ab7';

const PATRON_HEX = /^#[0-9A-Fa-f]{6}$/;

export interface PaletaLogin {
  primario: string;
  primarioRgb: string;
  primarioHover: string;
  secundario: string;
  secundarioRgb: string;
  primarioClaro: string;
  secundarioClaro: string;
  primarioClaroRgb: string;
}

function normalizarHex(color: string): string {
  return PATRON_HEX.test(color || '') ? color : COLOR_LOGIN_POR_DEFECTO;
}

function componentesRgb(hex: string): [number, number, number] {
  const limpio = hex.replace('#', '');
  const numero = parseInt(limpio, 16);
  return [(numero >> 16) & 255, (numero >> 8) & 255, numero & 255];
}

function hexDesdeRgb(r: number, g: number, b: number): string {
  const canal = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${canal(r)}${canal(g)}${canal(b)}`;
}

function rgbTexto(hex: string): string {
  const [r, g, b] = componentesRgb(hex);
  return `${r}, ${g}, ${b}`;
}

// Mezcla el color con blanco (0 a 1) -- para variantes claras sobre fondo oscuro.
function aclarar(hex: string, porcentaje: number): string {
  const [r, g, b] = componentesRgb(hex);
  return hexDesdeRgb(
    r + (255 - r) * porcentaje,
    g + (255 - g) * porcentaje,
    b + (255 - b) * porcentaje
  );
}

// Mezcla el color con negro (0 a 1) -- para el segundo tono del degradado.
function oscurecer(hex: string, porcentaje: number): string {
  const [r, g, b] = componentesRgb(hex);
  return hexDesdeRgb(r * (1 - porcentaje), g * (1 - porcentaje), b * (1 - porcentaje));
}

// A partir de un único color elegido por el admin, arma toda la paleta que
// usa el login (degradado, foco de inputs, sombras) tanto en modo claro
// como oscuro. Es una función pura (sin llamadas HTTP) para poder usarla
// tanto en el login real como en la vista previa de /configuracion.
export function generarPaletaLogin(colorBase: string): PaletaLogin {
  const primario = normalizarHex(colorBase);
  const primarioHover = oscurecer(primario, 0.08); // para :hover de botones/enlaces
  const secundario = oscurecer(primario, 0.22);
  const primarioClaro = aclarar(primario, 0.35);
  const secundarioClaro = aclarar(secundario, 0.45);

  return {
    primario,
    primarioRgb: rgbTexto(primario),
    primarioHover,
    secundario,
    secundarioRgb: rgbTexto(secundario),
    primarioClaro,
    secundarioClaro,
    primarioClaroRgb: rgbTexto(primarioClaro),
  };
}
