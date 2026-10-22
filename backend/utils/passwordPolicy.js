// Política de contraseñas seguras — se usa en los 3 lugares donde se fija
// una contraseña: creación de usuario, reseteo por admin, y cambio propio
// (ver routes/usuarios.js y routes/auth.js). Centralizado acá para que los
// tres apliquen exactamente la misma regla — antes solo /cambiar-password
// exigía un mínimo de 6 caracteres, y crear/resetear no validaban nada.
//
// Reglas: longitud mínima de 8, al menos una mayúscula, una minúscula y un
// número (el símbolo es OPCIONAL: "Finandina10" y "Finandina10*" son válidas),
// sin secuencias o palabras comunes, sin repeticiones/consecutivos obvios, y
// sin que la contraseña incluya el usuario o partes del nombre de la persona.
// La palabra "finandina" ya no está en la lista de comunes (es el estilo de
// contraseña que se quiere permitir).

const LONGITUD_MINIMA = 8;

function faltantesDeTipo(texto) {
  const faltan = [];
  if (!/[a-z]/.test(texto)) faltan.push('una minúscula');
  if (!/[A-Z]/.test(texto)) faltan.push('una mayúscula');
  if (!/[0-9]/.test(texto)) faltan.push('un número');
  return faltan;
}

// Palabras/secuencias débiles típicas (en minúscula, sin tildes) — se
// comparan como substring, así que también atrapa variantes como
// "MiPassword1!" o "Contraseña2026".
const PASSWORDS_COMUNES = [
  '123456', '1234567', '12345678', '123456789', '1234567890',
  'password', 'contrasena', 'qwerty', 'qwerty123', 'asdfgh', 'zxcvbn',
  'admin', 'administrador', 'abcdefg', 'abcdefgh', '000000', '111111',
  'iloveyou', 'welcome', 'bienvenido', 'letmein', 'monkey', 'dragon',
  'master', 'football', 'baseball', 'trustno1', '1q2w3e4r', 'passw0rd',
  'p@ssword', 'p@ssw0rd', 'banco', 'certificados', 'axis',
];

// Quita tildes/ñ para que la comparación de nombre/usuario no se salte por
// un acento (ej. "Jeisón" vs "jeison").
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// 3 o más repeticiones seguidas del mismo caracter (ej. "aaaa", "1111").
function contieneRepeticion(password) {
  return /(.)\1{2,}/.test(password);
}

// Tramos de 4+ caracteres consecutivos (ascendentes o descendentes) de
// secuencias de teclado/alfabeto/números obvias.
function contieneSecuenciaConsecutiva(password) {
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

// La contraseña no puede contener el username completo, ni ninguna palabra
// de 3+ letras del nombre completo de la persona.
function contieneDatoPersonal(password, { username, nombreCompleto } = {}) {
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

// Devuelve { valido, errores } — errores es un arreglo de mensajes en
// español, listos para mostrarle a la persona (uno por regla incumplida,
// nunca solo "contraseña inválida").
function validarPassword(password, { username, nombreCompleto } = {}) {
  const errores = [];
  const texto = String(password || '');

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
  if (contieneDatoPersonal(texto, { username, nombreCompleto })) {
    errores.push('No puede contener tu usuario ni tu nombre.');
  }

  return { valido: errores.length === 0, errores };
}

module.exports = { validarPassword, LONGITUD_MINIMA };
