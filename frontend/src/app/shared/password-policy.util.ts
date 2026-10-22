// Política de contraseñas seguras -- espejo en el frontend de
// backend/utils/passwordPolicy.js (MISMAS reglas). El backend sigue siendo
// la fuente de verdad (nunca hay que confiar solo en esta validación de
// cliente), pero repetirla acá da feedback inmediato sin un viaje al
// servidor, y evita el caso de "guardar" y solo enterarse del rechazo tras
// el POST/PUT.

export interface ContextoPassword {
  username?: string;
  nombreCompleto?: string;
}

// 8 caracteres mínimo, con mayúscula, minúscula y número; el símbolo es
// OPCIONAL (ej. "Finandina10" o "Finandina10*"). Las demás reglas (sin
// secuencias/palabras comunes, sin repeticiones, sin datos personales) se
// mantienen porque no le cuestan esfuerzo extra a una contraseña razonable.
const LONGITUD_MINIMA = 8;

function faltantesDeTipo(texto: string): string[] {
  const faltan: string[] = [];
  if (!/[a-z]/.test(texto)) faltan.push('una minúscula');
  if (!/[A-Z]/.test(texto)) faltan.push('una mayúscula');
  if (!/[0-9]/.test(texto)) faltan.push('un número');
  return faltan;
}

const PASSWORDS_COMUNES = [
  '123456', '1234567', '12345678', '123456789', '1234567890',
  'password', 'contrasena', 'qwerty', 'qwerty123', 'asdfgh', 'zxcvbn',
  'admin', 'administrador', 'abcdefg', 'abcdefgh', '000000', '111111',
  'iloveyou', 'welcome', 'bienvenido', 'letmein', 'monkey', 'dragon',
  'master', 'football', 'baseball', 'trustno1', '1q2w3e4r', 'passw0rd',
  'p@ssword', 'p@ssw0rd', 'banco', 'certificados', 'axis',
];

function normalizar(texto: string | null | undefined): string {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function contieneRepeticion(password: string): boolean {
  return /(.)\1{2,}/.test(password);
}

function contieneSecuenciaConsecutiva(password: string): boolean {
  const minusc = normalizar(password);
  const secuencias = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  for (const secuencia of secuencias) {
    for (let i = 0; i <= secuencia.length - 4; i++) {
      const tramo = secuencia.slice(i, i + 4);
      const tramoInverso = tramo.split('').reverse().join('');
      if (minusc.includes(tramo) || minusc.includes(tramoInverso)) return true;
    }
  }
  return false;
}

function contieneDatoPersonal(password: string, { username, nombreCompleto }: ContextoPassword): boolean {
  const minusc = normalizar(password);
  if (username && username.trim().length >= 3 && minusc.includes(normalizar(username))) {
    return true;
  }
  if (nombreCompleto) {
    const partes = normalizar(nombreCompleto).split(/[^a-z0-9]+/).filter((p) => p.length >= 3);
    if (partes.some((parte) => minusc.includes(parte))) return true;
  }
  return false;
}

// Devuelve la lista de mensajes de error (vacía = contraseña válida).
export function validarPasswordSegura(password: string, contexto: ContextoPassword = {}): string[] {
  const errores: string[] = [];
  const texto = password || '';

  if (texto.length < LONGITUD_MINIMA) {
    errores.push(`Debe tener al menos ${LONGITUD_MINIMA} caracteres.`);
  }
  const faltan = faltantesDeTipo(texto);
  if (faltan.length) {
    errores.push(`Debe incluir ${faltan.join(', ').replace(/, ([^,]*)$/, ' y $1')} (el símbolo es opcional).`);
  }

  const normalizada = normalizar(texto);
  if (PASSWORDS_COMUNES.some((comun) => normalizada.includes(comun))) {
    errores.push('No puede contener palabras o secuencias comunes (ej. "123456", "qwerty", "password").');
  }
  if (contieneRepeticion(texto)) {
    errores.push('No puede repetir el mismo caracter 3 o más veces seguidas.');
  }
  if (contieneSecuenciaConsecutiva(texto)) {
    errores.push('No puede contener secuencias consecutivas obvias (ej. "1234", "abcd", "qwer").');
  }
  if (contieneDatoPersonal(texto, contexto)) {
    errores.push('No puede contener tu usuario ni tu nombre.');
  }

  return errores;
}

// Texto corto de ayuda para mostrar bajo el campo de contraseña nueva.
export const REQUISITOS_PASSWORD_TEXTO =
  `Mínimo ${LONGITUD_MINIMA} caracteres con mayúscula, minúscula y número; el símbolo es opcional (ej. Finandina10*). ` +
  'No puede contener tu usuario/nombre ni secuencias comunes (123456, qwerty, etc), y debe ser distinta a la actual.';
