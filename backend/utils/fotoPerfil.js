// Foto de perfil del usuario: se guarda como "data URI" base64 en la columna
// usuarios.foto_perfil (ver Claude outputs/agregar_foto_perfil_usuarios.sql). El
// frontend ya la redimensiona a ~320 px antes de subirla.
//
// Si la columna todavía no existe (el script no se ha corrido), nada se rompe:
// el login y el resto siguen igual, solo que sin foto -- por eso cada consulta
// pregunta primero a information_schema (solo requiere SELECT).

const MAX_FOTO_PERFIL_BASE64_CHARS = 2_100_000; // ~1.5 MB de imagen real
const FORMATO_FOTO = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

// Devuelve un mensaje de error, o null si la foto es válida.
function validarFotoPerfil(foto) {
  if (typeof foto !== 'string' || !foto) return 'La foto no es válida.';
  if (foto.length > MAX_FOTO_PERFIL_BASE64_CHARS) return 'La foto es demasiado pesada (máximo ~1.5 MB).';
  if (!FORMATO_FOTO.test(foto)) return 'La foto debe ser una imagen JPG, PNG o WEBP.';
  return null;
}

let columnaConfirmada = false;
let proximaRevision = 0;

async function columnaFotoDisponible(pool) {
  if (columnaConfirmada) return true;
  if (Date.now() < proximaRevision) return false;
  const [filas] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'foto_perfil' LIMIT 1`
  );
  if (filas.length) { columnaConfirmada = true; return true; }
  proximaRevision = Date.now() + 60000; // reintenta en 1 minuto (por si ya corrieron el script)
  return false;
}

module.exports = { validarFotoPerfil, columnaFotoDisponible, MAX_FOTO_PERFIL_BASE64_CHARS };
