// Orquestador del "Informe General del Aplicativo" — combina, en un solo
// informe (pantalla y PDF), las secciones que el usuario elija entre los
// módulos que YA tienen su propio informe: Certificados, Servidores/
// Monitoreo, Aplicaciones e Inventario, Bitácora de Apuntamientos y
// Balanceador F5.
//
// No arma datos propios: por cada sección pedida llama al
// armarDatosInforme<Modulo> que ya existe, con el MISMO periodo para todas
// (un solo periodo para todo el informe general, por simplicidad — cada
// informe individual sigue existiendo aparte por si hace falta un periodo
// distinto para un módulo puntual).
//
// Si una sección falla (ej. una caída puntual de la conexión a la base de
// datos mientras se arma otra sección — ver el ECONNRESET que ya se vio en
// /api/reportes/servidores) NO se tumba el informe general completo: esa
// sección queda marcada con error en seccionesConError y las demás se
// siguen entregando con Promise.allSettled.

const { calcularRangoPeriodo, resolverRango, armarDatosInforme: armarDatosInformeCertificados } = require('./informeCertificados');
const { armarDatosInformeServidores } = require('./informeServidores');
const { armarDatosInformeAplicaciones } = require('./informeAplicaciones');
const { armarDatosInformeApuntamientos } = require('./informeApuntamientos');
const { armarDatosInformeF5 } = require('./informeF5');

// Catálogo de secciones disponibles para el informe general. "modulo" es el
// mismo nombre que ya usa requireModule()/moduleGuard para el informe
// individual de esa sección (ver routes/reportes.js) — se usa para filtrar,
// en el backend, qué secciones puede pedir cada usuario (además de lo que ya
// filtra la pantalla en el frontend al armar los checkboxes).
const SECCIONES_DISPONIBLES = [
  { clave: 'certificados', etiqueta: 'Certificados', modulo: 'CERTIFICADOS', armar: armarDatosInformeCertificados },
  { clave: 'servidores', etiqueta: 'Servidores / Monitoreo', modulo: 'SERVIDORES', armar: armarDatosInformeServidores },
  { clave: 'aplicaciones', etiqueta: 'Aplicaciones e Inventario', modulo: 'CERTIFICADOS', armar: armarDatosInformeAplicaciones },
  { clave: 'apuntamientos', etiqueta: 'Bitácora de Apuntamientos', modulo: 'SERVICIOS', armar: armarDatosInformeApuntamientos },
  { clave: 'f5', etiqueta: 'Balanceador F5', modulo: 'BALANCEADOR_F5', armar: armarDatosInformeF5 },
];

// Secciones que el usuario puede pedir según los módulos que tiene
// habilitados (req.user.modulos, el mismo array que ya usa requireModule).
function seccionesPermitidas(modulosUsuario) {
  const modulos = modulosUsuario || [];
  return SECCIONES_DISPONIBLES.filter((s) => modulos.includes(s.modulo));
}

// Lee ?secciones=certificados,servidores,... de la query string.
function parseClavesSolicitadas(req) {
  const crudo = req.query.secciones;
  if (!crudo) return [];
  return String(crudo)
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}

// Arma el informe general: por cada clave solicitada Y permitida para este
// usuario, corre su armarDatosInforme<Modulo>(desde,hasta) en paralelo.
async function armarDatosInformeGeneral(desde, hasta, clavesSolicitadas, modulosUsuario) {
  const disponiblesParaUsuario = seccionesPermitidas(modulosUsuario);
  const clavesPermitidas = new Set(disponiblesParaUsuario.map((s) => s.clave));
  const clavesConocidas = new Set(SECCIONES_DISPONIBLES.map((s) => s.clave));

  const seccionesSinPermiso = clavesSolicitadas.filter((c) => clavesConocidas.has(c) && !clavesPermitidas.has(c));
  const seccionesDesconocidas = clavesSolicitadas.filter((c) => !clavesConocidas.has(c));
  const seccionesAArmar = disponiblesParaUsuario.filter((s) => clavesSolicitadas.includes(s.clave));

  const resultados = await Promise.allSettled(seccionesAArmar.map((s) => s.armar(desde, hasta)));

  const secciones = {};
  const seccionesConError = [];
  resultados.forEach((resultado, indice) => {
    const def = seccionesAArmar[indice];
    if (resultado.status === 'fulfilled') {
      secciones[def.clave] = resultado.value;
    } else {
      secciones[def.clave] = null;
      const mensaje = resultado.reason && resultado.reason.message ? resultado.reason.message : 'Error desconocido';
      seccionesConError.push({ clave: def.clave, etiqueta: def.etiqueta, error: mensaje });
      console.error(`Informe General: falló la sección "${def.clave}":`, resultado.reason);
    }
  });

  return {
    periodo: { desde, hasta },
    seccionesIncluidas: seccionesAArmar.map((s) => ({ clave: s.clave, etiqueta: s.etiqueta })),
    seccionesSinPermiso,
    seccionesDesconocidas,
    secciones,
    seccionesConError,
  };
}

module.exports = {
  SECCIONES_DISPONIBLES,
  seccionesPermitidas,
  parseClavesSolicitadas,
  calcularRangoPeriodo,
  resolverRango,
  armarDatosInformeGeneral,
};
