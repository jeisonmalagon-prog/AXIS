// API de Informes. Un solo conjunto de rutas sirve a TODOS los informes del
// catálogo (utils/informes/catalogo.js):
//   GET  /api/informes/catalogo                  informes disponibles para el usuario
//   GET  /api/informes/:clave                    el informe armado (JSON) para la pantalla
//   GET  /api/informes/:clave/pdf  | /xlsx       descarga
//   POST /api/informes/enviar                    enviar ahora por correo
//   GET/POST/PUT/DELETE /api/informes/programados[/:id]   envíos programados
//   POST /api/informes/programados/:id/enviar    probar un envío programado
// Parámetros de periodo: ?periodo=hoy|ayer|semana|mes|trimestre|mesanterior  ó  ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
// Los informes anteriores (/api/reportes/*) siguen funcionando sin cambios.
const express = require('express');
const router = express.Router();
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { getPool } = require('../db');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { catalogo, definicion, puedeVer, permitidos, GENERAL_SECCIONES, PERIODOS, resolverPeriodo, armarInforme, rangoDePeriodo } = require('../utils/informes/catalogo');
const { generarPdfBuffer } = require('../utils/informes/pdfRender');
const { generarXlsxBuffer } = require('../utils/informes/xlsxRender');
const { enviarInforme, validarDestinatarios, smtpConfigurado, dominiosPermitidos } = require('../utils/informes/correo');
const programador = require('../utils/informes/programador');

// Informes es un módulo propio (INFORMES): el ADMIN_POD lo habilita por usuario. Además, cada informe sigue pidiendo
// el módulo de su tema (puedeVer): quien tenga INFORMES solo ve los informes de los módulos que ya tiene.
router.use(verifyToken, requireModule('INFORMES'));

const esAdmin = (u) => u && u.rol === 'ADMIN_POD';
function responderError(res, err, contexto) {
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(`Error en informes (${contexto}):`, err);
  return res.status(500).json({ error: mensajeErrorAmigable(err) });
}
async function colorMarca() {
  try { return await require('../utils/configuracionSistema').obtenerColorLogin(await getPool()); } catch (e) { return null; }
}
function seccionesDeQuery(q) {
  return String(q.secciones || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
async function construir(req, clave, params = null) {
  const def = definicion(clave);
  if (!def) throw Object.assign(new Error('Ese informe no existe.'), { status: 404 });
  if (!puedeVer(req.user, def)) throw Object.assign(new Error(`No tienes habilitado el módulo para este informe.`), { status: 403 });
  const q = params || req.query;
  const { desde, hasta } = resolverPeriodo(q);
  return armarInforme(clave, { desde, hasta, usuario: req.user, modulos: req.user.modulos || [], secciones: Array.isArray(q.secciones) ? q.secciones : seccionesDeQuery(q) });
}

// ---------- Catálogo ----------
router.get('/catalogo', (req, res) => {
  const lista = permitidos(req.user).map((c) => ({
    clave: c.clave, titulo: c.titulo, descripcion: c.descripcion, categoria: c.categoria, icono: c.icono, programable: c.programable,
    secciones: c.clave === 'general' ? GENERAL_SECCIONES.filter((s) => puedeVer(req.user, s)).map((s) => ({ clave: s.clave, titulo: s.titulo })) : undefined,
  }));
  res.json({ informes: lista, periodos: PERIODOS, correo: { configurado: smtpConfigurado(), dominios: dominiosPermitidos() } });
});

// ---------- Envíos programados ----------
const FRECUENCIAS = ['diaria', 'semanal', 'mensual'];
const PERIODOS_PROG = ['ayer', 'semana', 'mes', 'mesanterior'];
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

async function tablaProgramados(res) {
  const pool = await getPool();
  try { await pool.query('SELECT 1 FROM ReportesProgramados LIMIT 1'); return pool; } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') { res.status(409).json({ disponible: false, error: 'Falta crear la tabla de envíos programados: ejecuta el script crear_reportes_programados.sql en la base de datos.' }); return null; }
    throw e;
  }
}
function validarPrograma(b, user) {
  const def = definicion(b.informe);
  if (!def) throw Object.assign(new Error('Elige un informe válido.'), { status: 400 });
  if (!def.programable) throw Object.assign(new Error('Ese informe no se puede programar por correo.'), { status: 400 });
  if (!puedeVer(user, def)) throw Object.assign(new Error('No tienes habilitado el módulo de ese informe.'), { status: 403 });
  const nombre = String(b.nombre || '').trim();
  if (!nombre || nombre.length > 120) throw Object.assign(new Error('Escribe un nombre (hasta 120 caracteres).'), { status: 400 });
  if (!FRECUENCIAS.includes(b.frecuencia)) throw Object.assign(new Error('La frecuencia debe ser diaria, semanal o mensual.'), { status: 400 });
  if (!PERIODOS_PROG.includes(b.periodo)) throw Object.assign(new Error('Elige un periodo válido para el informe.'), { status: 400 });
  if (!RE_HORA.test(b.hora || '')) throw Object.assign(new Error('La hora debe tener el formato HH:MM.'), { status: 400 });
  const diaSemana = b.frecuencia === 'semanal' ? Number(b.diaSemana) : null;
  if (b.frecuencia === 'semanal' && !(diaSemana >= 0 && diaSemana <= 6)) throw Object.assign(new Error('Elige el día de la semana.'), { status: 400 });
  const diaMes = b.frecuencia === 'mensual' ? Number(b.diaMes) : null;
  if (b.frecuencia === 'mensual' && !(diaMes >= 1 && diaMes <= 28)) throw Object.assign(new Error('El día del mes debe estar entre 1 y 28.'), { status: 400 });
  const destinatarios = validarDestinatarios(Array.isArray(b.destinatarios) ? b.destinatarios : String(b.destinatarios || '').split(/[,;\s]+/));
  const formatos = (Array.isArray(b.formatos) ? b.formatos : ['pdf', 'xlsx']).filter((f) => ['pdf', 'xlsx'].includes(f));
  if (!formatos.length) throw Object.assign(new Error('Elige al menos un formato (PDF o Excel).'), { status: 400 });
  let secciones = null;
  if (def.clave === 'general') {
    const s = (Array.isArray(b.secciones) ? b.secciones : []).filter((x) => GENERAL_SECCIONES.some((g) => g.clave === x && puedeVer(user, g)));
    if (!s.length) throw Object.assign(new Error('Elige al menos una sección para el informe general.'), { status: 400 });
    secciones = s.join(',');
  }
  return { nombre, informe: def.clave, secciones, periodo: b.periodo, frecuencia: b.frecuencia, diaSemana, diaMes, hora: `${b.hora}:00`, destinatarios: destinatarios.join(','), formatos: formatos.join(','), activo: b.activo === false ? 0 : 1 };
}
const aJson = (r) => ({
  id: r.Id, nombre: r.Nombre, informe: r.Informe, secciones: r.Secciones ? r.Secciones.split(',') : [], periodo: r.Periodo, frecuencia: r.Frecuencia, diaSemana: r.DiaSemana, diaMes: r.DiaMes,
  hora: String(r.Hora).slice(0, 5), destinatarios: String(r.Destinatarios).split(','), formatos: String(r.Formatos).split(','), activo: !!r.Activo,
  ultimoEnvio: r.UltimoEnvio, ultimoEstado: r.UltimoEstado, ultimoMensaje: r.UltimoMensaje, creadoPor: r.CreadoPor, propio: false,
});

router.get('/programados', async (req, res) => {
  try {
    const pool = await tablaProgramados(res); if (!pool) return;
    const [filas] = await pool.query(`SELECT * FROM ReportesProgramados ${esAdmin(req.user) ? '' : 'WHERE CreadoPorId = ?'} ORDER BY Activo DESC, Nombre`, esAdmin(req.user) ? [] : [req.user.id]);
    res.json({ disponible: true, programados: filas.filter((r) => esAdmin(req.user) || puedeVer(req.user, definicion(r.Informe))).map((r) => ({ ...aJson(r), propio: r.CreadoPorId === req.user.id })) });
  } catch (e) { responderError(res, e, 'listar programados'); }
});

router.post('/programados', async (req, res) => {
  try {
    const pool = await tablaProgramados(res); if (!pool) return;
    const p = validarPrograma(req.body || {}, req.user);
    const [r] = await pool.query(
      `INSERT INTO ReportesProgramados (Nombre, Informe, Secciones, Periodo, Frecuencia, DiaSemana, DiaMes, Hora, Destinatarios, Formatos, Activo, CreadoPorId, CreadoPor)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [p.nombre, p.informe, p.secciones, p.periodo, p.frecuencia, p.diaSemana, p.diaMes, p.hora, p.destinatarios, p.formatos, p.activo, req.user.id, req.user.username]);
    res.status(201).json({ id: r.insertId });
  } catch (e) { responderError(res, e, 'crear programado'); }
});

async function cargarPropio(pool, req, res) {
  const [[fila]] = await pool.query('SELECT * FROM ReportesProgramados WHERE Id = ?', [req.params.id]);
  if (!fila) { res.status(404).json({ error: 'Ese envío programado no existe.' }); return null; }
  if (!esAdmin(req.user) && fila.CreadoPorId !== req.user.id) { res.status(403).json({ error: 'Solo quien lo creó (o un administrador) puede modificarlo.' }); return null; }
  return fila;
}
router.put('/programados/:id', async (req, res) => {
  try {
    const pool = await tablaProgramados(res); if (!pool) return;
    const fila = await cargarPropio(pool, req, res); if (!fila) return;
    const p = validarPrograma({ ...req.body, informe: fila.Informe }, req.user);
    await pool.query(
      `UPDATE ReportesProgramados SET Nombre=?, Secciones=?, Periodo=?, Frecuencia=?, DiaSemana=?, DiaMes=?, Hora=?, Destinatarios=?, Formatos=?, Activo=? WHERE Id=?`,
      [p.nombre, p.secciones, p.periodo, p.frecuencia, p.diaSemana, p.diaMes, p.hora, p.destinatarios, p.formatos, p.activo, fila.Id]);
    res.json({ ok: true });
  } catch (e) { responderError(res, e, 'editar programado'); }
});
router.delete('/programados/:id', async (req, res) => {
  try {
    const pool = await tablaProgramados(res); if (!pool) return;
    const fila = await cargarPropio(pool, req, res); if (!fila) return;
    await pool.query('DELETE FROM ReportesProgramados WHERE Id = ?', [fila.Id]);
    res.json({ ok: true });
  } catch (e) { responderError(res, e, 'borrar programado'); }
});
router.post('/programados/:id/enviar', async (req, res) => {
  try {
    const pool = await tablaProgramados(res); if (!pool) return;
    const fila = await cargarPropio(pool, req, res); if (!fila) return;
    const r = await programador.ejecutarPrograma(fila);
    await programador.registrarResultado(fila.Id, 'ok', `Enviado a ${r.destinatarios.length} destinatario(s) (envío manual).`);
    res.json(r);
  } catch (e) { responderError(res, e, 'enviar programado'); }
});

// ---------- Enviar ahora ----------
router.post('/enviar', async (req, res) => {
  try {
    const b = req.body || {};
    const inf = await construir(req, b.informe, { periodo: b.periodo, desde: b.desde, hasta: b.hasta, secciones: Array.isArray(b.secciones) ? b.secciones : [] });
    const formatos = (Array.isArray(b.formatos) ? b.formatos : ['pdf', 'xlsx']).filter((f) => ['pdf', 'xlsx'].includes(f));
    if (!formatos.length) return res.status(400).json({ error: 'Elige al menos un formato (PDF o Excel).' });
    const r = await enviarInforme(inf, { destinatarios: Array.isArray(b.destinatarios) ? b.destinatarios : String(b.destinatarios || '').split(/[,;\s]+/), formatos, nota: b.nota ? String(b.nota).slice(0, 400) : `Enviado por ${req.user.username}.`, colorMarca: await colorMarca() });
    res.json(r);
  } catch (e) { responderError(res, e, 'enviar ahora'); }
});

// ---------- Informe (pantalla / PDF / Excel) ----------
router.get('/:clave', async (req, res) => {
  try { res.json(await construir(req, req.params.clave)); } catch (e) { responderError(res, e, req.params.clave); }
});
function nombreArchivo(inf, ext) { return `informe-${inf.clave}_${inf.periodo.desde}_a_${inf.periodo.hasta}.${ext}`; }
router.get('/:clave/pdf', async (req, res) => {
  try {
    const inf = await construir(req, req.params.clave);
    const buf = await generarPdfBuffer(inf, { colorMarca: await colorMarca() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo(inf, 'pdf')}"`);
    res.end(buf);
  } catch (e) { responderError(res, e, `${req.params.clave}/pdf`); }
});
router.get('/:clave/xlsx', async (req, res) => {
  try {
    const inf = await construir(req, req.params.clave);
    const buf = await generarXlsxBuffer(inf, { colorMarca: await colorMarca() });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo(inf, 'xlsx')}"`);
    res.end(buf);
  } catch (e) { responderError(res, e, `${req.params.clave}/xlsx`); }
});

programador.iniciar();
void catalogo; void rangoDePeriodo;
module.exports = router;
