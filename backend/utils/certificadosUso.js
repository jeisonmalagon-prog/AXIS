// ============================================================================
// Uso detectado de los certificados (descubrimiento automático, script 06).
// La vista VW_CertificadosVigencia trae UsoCodigo:
//   1 = En uso · 2 = En uso (otro registro) · 3 = Sin uso detectado
// Los tableros cuentan por defecto solo lo que está EN USO, para que los
// certificados que solo están instalados en el almacén de un servidor (sin
// binding, puerto, servicio ni sub-aplicativo) no inflen "vencidos" ni la salud.
// Si la vista aún no tiene la columna (BD sin el script 06), no se filtra nada.
// ============================================================================
let tieneColumna = null;
let revisadoEn = 0;

async function vistaTieneUso(pool) {
  if (tieneColumna === true) return true;
  if (tieneColumna === false && Date.now() - revisadoEn < 60000) return false;
  revisadoEn = Date.now();
  try {
    const [filas] = await pool.query(
      "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'VW_CertificadosVigencia' AND COLUMN_NAME = 'UsoCodigo' LIMIT 1"
    );
    tieneColumna = filas.length > 0;
  } catch (e) {
    tieneColumna = false;
  }
  return tieneColumna;
}

// Devuelve el fragmento " AND UsoCodigo < 3" (o "" si no aplica) para agregar a un WHERE.
async function condicionEnUso(pool, incluirSinUso = false) {
  if (incluirSinUso) return '';
  return (await vistaTieneUso(pool)) ? ' AND COALESCE(UsoCodigo, 1) < 3' : '';
}

// ?incluirSinUso=1 | true | si  ->  true
function pideIncluirSinUso(req) {
  const v = String(req?.query?.incluirSinUso ?? '').trim().toLowerCase();
  return ['1', 'true', 'si', 'sí'].includes(v);
}

module.exports = { vistaTieneUso, condicionEnUso, pideIncluirSinUso };
