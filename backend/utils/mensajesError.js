// Traduce errores técnicos de MySQL/Node a mensajes claros para el usuario final.
//
// Los mensajes que manda MySQL (ej. "Duplicate entry 'x' for key 'y'") sirven
// para depurar, pero no le dicen nada útil a la persona que está usando la
// aplicación. La idea es: cada ruta sigue haciendo console.error(err) con el
// detalle técnico completo (para que quede en el log del servidor), y usa
// mensajeErrorAmigable(err) para decidir qué texto mostrarle al usuario.

// Mapa de restricciones UNIQUE conocidas -> mensaje amigable cuando se violan.
// (Nombre de la restricción tal como aparece en el error de MySQL, ej.
// "Duplicate entry '...' for key 'UQ_Servidores_IP'").
const MENSAJES_DUPLICADO = {
  UQ_Servidores_IP: 'Ya existe un servidor registrado con esa dirección IP.',
  UQ_Servidores_Hostname: 'Ya existe un servidor registrado con ese Hostname.',
  UQ_SistemasOperativos_Nombre: 'Ya existe un sistema operativo con ese nombre.',
  UQ_Aplicaciones_Nombre_Servidor: 'Ya existe una aplicación con ese nombre para ese servidor.',
  uq_inv_aplicativos_aplicacion: 'Este aplicativo ya tiene un registro en el inventario.',
  uq_inv_servidores_servidor: 'Este servidor ya tiene un registro en el inventario de bases de datos.',
  uq_monitoreo_servidor: 'Este servidor ya está siendo monitoreado.',
  username: 'Ya existe un usuario con ese nombre de usuario.',
  nombre: 'Ya existe un registro con ese nombre.',
  AplicacionId: 'Esta aplicación ya tiene un esquema guardado.',
  uq_calendariosequipo_correo: 'Ese correo ya está en la lista de calendarios del equipo.',
};

/**
 * @param {any} err - el error capturado (de mysql2, o cualquier excepción).
 * @param {{contexto?: string}} [opciones] - contexto opcional para mensajes de
 *   respaldo más específicos, ej. { contexto: 'el servidor' } -> "...para el servidor."
 */
function mensajeErrorAmigable(err, opciones = {}) {
  const { contexto } = opciones;
  const codigo = err && (err.code || err.errno);
  const sqlMsg = (err && (err.sqlMessage || err.message)) || '';

  // 1062 / ER_DUP_ENTRY: se intenta guardar un valor que ya existe en una
  // columna (o combinación de columnas) marcada como única.
  if (codigo === 'ER_DUP_ENTRY' || codigo === 1062) {
    const match = /for key '([^']+)'/i.exec(sqlMsg);
    const clave = match ? match[1] : '';
    return (
      MENSAJES_DUPLICADO[clave] ||
      `Ya existe un registro con esos mismos datos${contexto ? ` para ${contexto}` : ''}. Verifica los campos que no se pueden repetir.`
    );
  }

  // 1451 / 1216: no se puede borrar (o actualizar) porque otro registro depende de este.
  if (codigo === 'ER_ROW_IS_REFERENCED_2' || codigo === 'ER_ROW_IS_REFERENCED' || codigo === 1451 || codigo === 1216) {
    return `No se puede eliminar${contexto ? ` ${contexto}` : ' este registro'} porque tiene información asociada (aplicaciones, certificados u otros datos relacionados). Elimina o desvincula esos datos primero.`;
  }

  // 1452: la fila a la que se hace referencia (llave foránea) no existe.
  if (codigo === 'ER_NO_REFERENCED_ROW_2' || codigo === 'ER_NO_REFERENCED_ROW' || codigo === 1452) {
    return 'Uno de los datos relacionados no existe o fue eliminado. Verifica la información e intenta de nuevo.';
  }

  // 1048: falta un campo obligatorio que no llegó desde el formulario.
  if (codigo === 'ER_BAD_NULL_ERROR' || codigo === 1048) {
    return 'Falta un campo obligatorio. Verifica que todos los datos requeridos estén completos.';
  }

  // 1406 / 1264: un valor no cabe en el tipo o tamaño de la columna.
  if (codigo === 'ER_DATA_TOO_LONG' || codigo === 1406 || codigo === 'ER_WARN_DATA_OUT_OF_RANGE' || codigo === 1264) {
    return 'Uno de los valores ingresados es demasiado largo o no es válido para ese campo.';
  }

  // Problemas de conexión con la base de datos (no son culpa del usuario).
  if (['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'ER_CON_COUNT_ERROR'].includes(codigo)) {
    return 'No se pudo conectar con la base de datos. Intenta de nuevo en unos segundos; si el problema persiste, contacta al administrador.';
  }

  // Nunca se muestra el mensaje crudo de MySQL/Node al usuario final: el
  // detalle técnico ya quedó registrado con console.error() en cada ruta.
  return 'Ocurrió un error al procesar la solicitud. Intenta de nuevo o contacta al administrador si el problema persiste.';
}

module.exports = { mensajeErrorAmigable };
