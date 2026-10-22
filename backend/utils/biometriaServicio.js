// Orquestación del módulo Biometría de firmas: una consulta (con las credenciales de QUIEN CONSULTA).
//
// El resultado es PERSONAL: vive solo en la memoria del backend, ligado al usuario que consultó (con SUS
// credenciales), y nadie más lo ve. No se guarda en ninguna base (lleva datos de clientes: cédula y nombre).
// No hay consulta automática ni credenciales compartidas: solo consulta quien lo pide.

const { consultarBiometria } = require('./biometriaConsulta');
const { mensajeErrorSql } = require('./sqlServer');

const CANDADO_MAX_MS = 10 * 60 * 1000;
const RETENCION_MS = 3600 * 1000;

// usuario -> { resultado, error, enEjecucion, inicio, ultimo }
const estados = new Map();

setInterval(() => {
  const limite = Date.now() - RETENCION_MS;
  for (const [u, e] of [...estados.entries()]) if (!e.enEjecucion && (e.ultimo || 0) < limite) estados.delete(u);
}, 10 * 60 * 1000).unref();

/** Última consulta de ESTA persona (para la pantalla). */
function ultimoResultado(usuario) {
  const e = estados.get(usuario);
  return { resultado: e?.resultado || null, error: e?.error || null, enEjecucion: !!e?.enEjecucion };
}

// Devuelve { resultado } | { enEjecucion: true } | { error, configuracion }.
// Debe llamarse dentro de ejecutarComo(usuario, …) para que se usen las credenciales de esa persona.
async function ejecutarConsulta(usuario, filtro) {
  if (!usuario) return { error: 'No se pudo identificar tu sesión.', configuracion: true };
  const e = estados.get(usuario) || { resultado: null, error: null, enEjecucion: false, inicio: null, ultimo: 0 };
  if (e.enEjecucion && e.inicio && Date.now() - e.inicio < CANDADO_MAX_MS) return { enEjecucion: true };
  e.enEjecucion = true; e.inicio = Date.now();
  estados.set(usuario, e);
  try {
    const resultado = await consultarBiometria(filtro);
    Object.assign(e, { resultado, error: null, enEjecucion: false, ultimo: Date.now() });
    return { resultado };
  } catch (error) {
    const validacion = error?.codigo === 'VALIDACION';
    const mensaje = validacion ? error.message : mensajeErrorSql(error, error?.perfil);
    if (!validacion && !['CONFIG', 'SIN_CONFIG', 'SIN_DRIVER'].includes(error?.codigo)) console.error('[biometria] Error en la consulta:', error?.message);
    Object.assign(e, { error: mensaje.slice(0, 500), enEjecucion: false, ultimo: Date.now() });
    return { error: mensaje, configuracion: validacion || ['CONFIG', 'SIN_CONFIG', 'SIN_DRIVER'].includes(error?.codigo) };
  }
}

module.exports = { ejecutarConsulta, ultimoResultado };
