// Envíos programados de informes por correo. Cada minuto revisa la tabla
// ReportesProgramados y manda los que ya toca (diario / semanal / mensual).
// Si el backend estuvo apagado a la hora del envío, lo manda al volver ese
// mismo día. Sin la tabla (falta correr el SQL) simplemente no hace nada.
const { getPool } = require('../../db');
const { definicion, rangoDePeriodo, armarInforme } = require('./catalogo');
const { enviarInforme, smtpConfigurado } = require('./correo');

const INTERVALO_MS = 60 * 1000;
const enCurso = new Set();
let avisoTablaMostrado = false;

// ¿Toca enviar ahora? Compara contra la hora programada de HOY y contra el último envío
// (o la creación del programa, para que uno nuevo no dispare de inmediato).
function tocaEnviar(r, ahora = new Date()) {
  const [h, m] = String(r.Hora || '07:00').split(':').map(Number);
  const prog = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), h || 0, m || 0, 0);
  if (ahora < prog) return false;
  if (r.Frecuencia === 'semanal' && ahora.getDay() !== Number(r.DiaSemana)) return false;
  if (r.Frecuencia === 'mensual' && ahora.getDate() !== Number(r.DiaMes)) return false;
  const base = r.UltimoEnvio ? new Date(r.UltimoEnvio) : (r.FechaCreacion ? new Date(r.FechaCreacion) : null);
  return !base || base < prog;
}

async function colorMarca(pool) {
  try { return await require('../configuracionSistema').obtenerColorLogin(pool); } catch (e) { return null; }
}

// Arma y envía un programa. Devuelve { enviado, destinatarios } o lanza.
async function ejecutarPrograma(r) {
  const def = definicion(r.Informe);
  if (!def) throw new Error(`El informe "${r.Informe}" ya no existe.`);
  const { desde, hasta } = rangoDePeriodo(r.Periodo);
  const secciones = r.Secciones ? String(r.Secciones).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const inf = await armarInforme(r.Informe, { desde, hasta, secciones, sinFiltroModulos: true, modulos: [], usuario: null });
  const pool = await getPool();
  return enviarInforme(inf, {
    destinatarios: String(r.Destinatarios).split(',').map((c) => c.trim()).filter(Boolean),
    formatos: String(r.Formatos || 'pdf,xlsx').split(',').map((f) => f.trim()),
    asunto: `${r.Nombre} — ${inf.titulo}`,
    nota: `Envío programado "${r.Nombre}".`,
    colorMarca: await colorMarca(pool),
  });
}

async function registrarResultado(id, estado, mensaje) {
  const pool = await getPool();
  await pool.query('UPDATE ReportesProgramados SET UltimoEstado = ?, UltimoMensaje = ? WHERE Id = ?', [estado, String(mensaje || '').slice(0, 480), id]);
}

async function ciclo() {
  if (!smtpConfigurado()) return;
  let filas;
  try {
    const pool = await getPool();
    [filas] = await pool.query('SELECT * FROM ReportesProgramados WHERE Activo = 1');
  } catch (e) {
    if (e && e.code === 'ER_NO_SUCH_TABLE') { if (!avisoTablaMostrado) { console.log('Informes programados: falta la tabla ReportesProgramados (ejecuta crear_reportes_programados.sql).'); avisoTablaMostrado = true; } return; }
    console.warn('Informes programados: no se pudo leer la tabla:', e.message); return;
  }
  const ahora = new Date();
  for (const r of filas) {
    if (enCurso.has(r.Id) || !tocaEnviar(r, ahora)) continue;
    enCurso.add(r.Id);
    try {
      const pool = await getPool();
      // Se marca ANTES de enviar: si el envío tarda o falla no se repite en el siguiente ciclo.
      await pool.query("UPDATE ReportesProgramados SET UltimoEnvio = NOW(), UltimoEstado = 'enviando' WHERE Id = ?", [r.Id]);
      const res = await ejecutarPrograma(r);
      await registrarResultado(r.Id, 'ok', `Enviado a ${res.destinatarios.length} destinatario(s).`);
      console.log(`Informe programado "${r.Nombre}" enviado a ${res.destinatarios.join(', ')}.`);
    } catch (e) {
      console.warn(`Informe programado "${r.Nombre}" falló: ${e.message}`);
      try { await registrarResultado(r.Id, 'error', e.message); } catch (e2) { /* sin acción */ }
    } finally { enCurso.delete(r.Id); }
  }
}

let iniciado = false;
function iniciar() {
  if (iniciado) return;
  iniciado = true;
  setTimeout(ciclo, 30 * 1000);
  setInterval(ciclo, INTERVALO_MS);
  console.log(smtpConfigurado() ? 'Informes programados: activos (revisión cada minuto).' : 'Informes programados: inactivos (faltan SMTP_HOST/SMTP_USER/SMTP_PASS en el .env).');
}

module.exports = { iniciar, ejecutarPrograma, tocaEnviar, registrarResultado };
