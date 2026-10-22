const jwt = require('jsonwebtoken');
const { rolEnModulo, ROL_CONSULTA } = require('../utils/permisosModulos');

// Debe ser EXACTAMENTE la misma variable de entorno que usa auth.js al
// firmar el token. Si no coinciden, todo login válido falla como "token inválido".
const SECRET_KEY = process.env.JWT_SECRET;
if (!SECRET_KEY) {
  throw new Error(
    'Falta la variable de entorno JWT_SECRET. Defínela en tu archivo .env ' +
    '(debe ser el mismo valor que usa auth.js) antes de arrancar el servidor.'
  );
}

// Mientras un usuario tiene pendiente el cambio obligatorio de contraseña
// (primer login de una cuenta nueva, o justo después de que un admin le
// resetee la contraseña), el token igual es válido — pero se bloquea el
// acceso a TODA la API excepto este pequeño grupo de endpoints de
// autoservicio bajo /api/auth, que son justo los que le permiten resolver
// el requisito (ver perfil, cambiar contraseña, actualizar su perfil).
const RUTAS_PERMITIDAS_CON_CAMBIO_PENDIENTE = new Set(['/me', '/cambiar-password', '/perfil']);

const verifyToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(403).json({ error: 'Se requiere un token de seguridad.' });

  try {
    const decoded = jwt.verify(token.split(" ")[1], SECRET_KEY); // Espera "Bearer <token>"
    req.user = decoded; // Guardamos los datos del usuario en la petición

    if (decoded.debeCambiarPassword) {
      const esRutaPermitida = req.baseUrl === '/api/auth' && RUTAS_PERMITIDAS_CON_CAMBIO_PENDIENTE.has(req.path);
      if (!esRutaPermitida) {
        return res.status(403).json({
          error: 'Debes actualizar tu contraseña antes de continuar.',
          debeCambiarPassword: true,
        });
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
};

// Middleware para validar si puede editar/crear/borrar (Roles).
// El rol es POR MÓDULO (ver utils/permisosModulos.js): en cada módulo el
// ADMIN_POD decide si el usuario solo consulta (CONSULTA) o administra
// (ADMIN_MIN). Este middleware debe ir DESPUÉS de requireModule(...), que deja
// en req.moduloActual el módulo de la ruta. Si una ruta lo usara sin
// requireModule, se aplica el rol global del usuario (comportamiento anterior).
const requireEditPermission = async (req, res, next) => {
  try {
    if (req.user.rol === 'ADMIN_POD') return next();

    const modulo = req.moduloActual;
    if (!modulo) {
      if (req.user.rol === 'BASIC') {
        return res.status(403).json({ error: 'Tu rol (BASIC) solo permite lectura. Contacta al ADMIN_POD.' });
      }
      return next();
    }

    const rol = await rolEnModulo(req, modulo);
    if (rol === null) {
      return res.status(403).json({ error: `No tienes habilitado el módulo: ${modulo}` });
    }
    if (rol === ROL_CONSULTA) {
      return res.status(403).json({
        error: `Tu rol en el módulo ${modulo} es de Consulta (solo lectura). Contacta al ADMIN_POD.`,
      });
    }
    next();
  } catch (err) {
    console.error('Error en requireEditPermission:', err);
    res.status(500).json({ error: 'No se pudo validar tu permiso de edición.' });
  }
};

// Middleware para validar acceso a módulos específicos
const requireModule = (moduloName) => {
  return (req, res, next) => {
    // Los middlewares siguientes (requireEditPermission) y algunas rutas
    // necesitan saber de qué módulo es la petición.
    req.moduloActual = moduloName;
    // El ADMIN_POD siempre tiene acceso a todos los módulos. Se valida por rol
    // (y no solo por la lista del token) para que un token emitido antes de
    // que existiera un módulo nuevo siga funcionando sin volver a iniciar sesión.
    if (req.user.rol === 'ADMIN_POD') return next();
    if (!(req.user.modulos || []).includes(moduloName)) {
      return res.status(403).json({ error: `No tienes habilitado el módulo: ${moduloName}` });
    }
    next();
  };
};

module.exports = { verifyToken, requireEditPermission, requireModule };
