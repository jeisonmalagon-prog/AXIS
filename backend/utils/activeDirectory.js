// ============================================================================
// Integración con Active Directory (LDAP) -- autenticación por "simple bind"
// directo como "${username}@${LDAP_DOMAIN}" (formato UPN), SIN cuenta de
// servicio ni búsqueda LDAP previa: el propio intento de bind ES la
// verificación (si el usuario o la contraseña son incorrectos, el bind
// falla). Se eligió este enfoque -- en vez de bind con cuenta de servicio +
// búsqueda -- por simplicidad y menor privilegio: no hace falta guardar
// ninguna credencial de administrador del dominio en este proyecto.
//
// Limitación conocida de este enfoque: al no hacer una búsqueda LDAP, no se
// obtienen atributos del usuario (nombre completo, correo, etc.) -- por eso
// una cuenta nueva autoprovisionada (ver backend/routes/auth.js) se crea con
// el nombre completo igual al username, y un ADMIN_POD lo puede corregir
// después desde Gestión de Usuarios.
//
// Variables de entorno (mismo criterio que el resto de integraciones de este
// proyecto -- Google Calendar, Azure DevOps, F5 -- ver backend/.env):
//   LDAP_URL            ej. ldaps://dc01.bancofinandina.corp:636
//                        (o ldap://host:389 si todavía no hay LDAPS)
//   LDAP_DOMAIN          ej. bancofinandina.corp -- se arma el UPN como
//                        "${username}@${LDAP_DOMAIN}"
//   LDAP_TLS_INSECURE    opcional, "true" para no validar el certificado del
//                        controlador de dominio (útil si ese certificado lo
//                        emite una CA interna que este contenedor no trae
//                        instalada) -- dejar sin definir (validación normal)
//                        salvo que de verdad haga falta.
// ============================================================================

const ldap = require('ldapjs');

function credencialesConfiguradas() {
  return !!(process.env.LDAP_URL && process.env.LDAP_DOMAIN);
}

// Intenta autenticar a `username` contra Active Directory mediante un bind
// simple. Devuelve true/false para credenciales correctas/incorrectas, y
// RECHAZA la promesa solo cuando el directorio mismo no se pudo consultar
// (host inalcanzable, timeout, etc.) -- así el llamador puede distinguir en
// sus logs "contraseña mala" de "AD caído", aunque al usuario final siempre
// se le muestre el mismo mensaje genérico en ambos casos.
function autenticarLdap(username, password) {
  return new Promise((resolve, reject) => {
    if (!credencialesConfiguradas()) {
      reject(new Error(
        'Active Directory todavía no está configurado. Faltan las variables de entorno ' +
        'LDAP_URL y/o LDAP_DOMAIN.'
      ));
      return;
    }

    // Muchos servidores LDAP aceptan un "bind anónimo" cuando la contraseña
    // llega vacía (te autentican como "nadie" en vez de fallar) -- hay que
    // rechazar esto explícitamente antes de intentar el bind.
    if (!password) {
      resolve(false);
      return;
    }

    const client = ldap.createClient({
      url: process.env.LDAP_URL,
      timeout: 5000,
      connectTimeout: 5000,
      tlsOptions: process.env.LDAP_TLS_INSECURE === 'true' ? { rejectUnauthorized: false } : undefined,
    });

    let terminado = false;
    const finalizar = (fn, valor) => {
      if (terminado) return;
      terminado = true;
      client.unbind(() => {});
      fn(valor);
    };

    // Un error de conexión (host inalcanzable, TLS, timeout) dispara este
    // evento en vez de pasar por el callback de bind().
    client.on('error', (err) => finalizar(reject, err));

    const userPrincipalName = `${username}@${process.env.LDAP_DOMAIN}`;
    client.bind(userPrincipalName, password, (err) => {
      if (err) {
        // InvalidCredentialsError y similares = usuario o contraseña
        // incorrectos -- el caso normal de "no existe en AD" o "contraseña
        // mala", no una falla del servidor.
        finalizar(resolve, false);
        return;
      }
      finalizar(resolve, true);
    });
  });
}

module.exports = {
  credencialesConfiguradas,
  autenticarLdap,
};
