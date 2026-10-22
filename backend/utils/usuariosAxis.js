// Usuarios de AXIS a los que un ADMIN_POD les puede asignar accesos finos
// (flujos de n8n, secciones y repositorios del módulo Repositorio...).
//
// Se listan TODOS los usuarios activos que no son ADMIN_POD (ese rol ve todo
// siempre), con una marca `tieneModulo` que indica si ya tienen habilitado el
// módulo en cuestión. Así el administrador puede dejar listos los accesos de
// alguien y ver de un vistazo a quién todavía le falta el módulo (se asigna en
// Gestión de Usuarios), en lugar de que esa persona simplemente no aparezca.

async function usuariosAsignablesDelModulo(pool, modulo) {
  const [filas] = await pool.query(
    `SELECT u.id, u.username, u.nombre_completo, u.rol,
            EXISTS (
              SELECT 1 FROM usuario_modulos um
                INNER JOIN modulos m ON m.id = um.modulo_id AND m.nombre = ?
               WHERE um.usuario_id = u.id
            ) AS tiene_modulo
       FROM usuarios u
      WHERE u.activo = 1 AND u.rol <> 'ADMIN_POD'
      ORDER BY u.nombre_completo, u.username`,
    [modulo]
  );
  return filas.map((f) => ({
    id: f.id,
    username: f.username,
    nombre: f.nombre_completo || f.username,
    rol: f.rol,
    tieneModulo: !!Number(f.tiene_modulo),
  }));
}

module.exports = { usuariosAsignablesDelModulo };
