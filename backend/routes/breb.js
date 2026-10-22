const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { rolEnModulo } = require('../utils/permisosModulos');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const conexion = require('../utils/brebConexion');
const api = require('../utils/brebApi');
const S = require('../utils/brebServicio');

// ==========================================================================
// Monitoreo transaccional > BREB (se monta en /api/monitoreo-transaccional/breb).
//  · Lo ve quien tenga el módulo MONITOREO_TRANSACCIONAL (cualquier rol: todo es de SOLO LECTURA).
//  · Solo el ADMIN_POD configura las conexiones (SQL Server, logs MariaDB y servicio de llaves); las claves se guardan cifradas
//    y nunca vuelven al navegador.
//  · «Consultar llave» y «resolver llave» llaman al servicio de BreB (solo esas dos operaciones, de lectura).
//  · Auditoría: cambios de conexiones (sin claves), consultas por cliente y consultas de llaves (documentos enmascarados).
// ==========================================================================

router.use(verifyToken, requireModule('MONITOREO_TRANSACCIONAL'));

const soloAdmin = (req, res, next) => {
  if (req.user && req.user.rol === 'ADMIN_POD') return next();
  return res.status(403).json({ error: 'Solo el ADMIN_POD puede cambiar las conexiones de BREB.' });
};

async function auditar(req, datos) {
  try {
    await registrarEventoGeneral(await getPool(), req, { modulo: 'MONITOREO_TRANSACCIONAL', entidad: 'BREB', ...datos });
  } catch (e) { console.error('[breb] No se pudo registrar la auditoría:', e.message); }
}

function responderError(res, err, contexto) {
  if (err instanceof S.ErrorBreb || err instanceof conexion.ErrorConexion || err instanceof api.ErrorLlaves) {
    return res.status(err.status || 400).json({ error: err.message, codigo: err.codigo });
  }
  console.error(`[breb] Error en ${contexto}:`, err && err.message);
  return res.status(500).json({ error: 'No se pudo completar la consulta de BREB.' });
}

const q = (req) => req.query || {};

router.get('/', async (req, res) => {
  try {
    const admin = req.user.rol === 'ADMIN_POD';
    const [rol, conexiones] = await Promise.all([rolEnModulo(req, 'MONITOREO_TRANSACCIONAL'), conexion.vistas({ admin })]);
    res.json({ rol, esAdminPod: admin, conexiones });
  } catch (err) { responderError(res, err, 'GET /'); }
});

// ---------------------------------------------------------------------------
// Conexiones (solo ADMIN_POD)
// ---------------------------------------------------------------------------
const NOMBRES = { sql: 'base SQL Server de BreB', log: 'logs de BreB (MariaDB)', api: 'servicio de llaves de BreB' };

function cambiosDe(destino, antes, despues, body) {
  const cambios = [];
  const cmp = (campo, etiqueta, a, b) => { if (String(a ?? '') !== String(b ?? '')) cambios.push({ campo, etiqueta, anterior: String(a ?? '') || '(vacío)', nuevo: String(b ?? '') || '(vacío)' }); };
  const sn = (x) => (x ? 'sí' : 'no');
  if (destino === 'api') {
    cmp('url', 'Dirección', antes.guardadaEnApp ? antes.url : '', despues.url);
    cmp('validarTls', 'Validar certificado TLS', sn(antes.validarTls), sn(despues.validarTls));
    cmp('rutaConsultar', 'Ruta de consultar llave', antes.guardadaEnApp ? antes.rutaConsultar : '', despues.rutaConsultar);
    cmp('rutaResolver', 'Ruta de resolver llave', antes.guardadaEnApp ? antes.rutaResolver : '', despues.rutaResolver);
    return cambios;
  }
  cmp('servidor', 'Servidor', antes.guardadaEnApp ? antes.servidor : '', despues.servidor);
  cmp('puerto', 'Puerto', antes.guardadaEnApp ? antes.puerto : '', despues.puerto);
  cmp('base', 'Base de datos', antes.guardadaEnApp ? antes.base : '', despues.base);
  cmp('usuario', 'Usuario', antes.usuario, despues.usuario);
  cmp('cifrado', 'Cifrar conexión', sn(antes.cifrado), sn(despues.cifrado));
  cmp('confiarCertificado', 'Confiar en el certificado', sn(antes.confiarCertificado), sn(despues.confiarCertificado));
  if (destino === 'sql') cmp('bancoPropio', 'Código de la entidad propia', antes.bancoPropio, despues.bancoPropio);
  if (body && String(body.clave || '') !== '') cambios.push({ campo: 'clave', etiqueta: 'Clave', anterior: '(oculta)', nuevo: '(cambiada)' });
  return cambios;
}

const destinoDe = (req) => conexion.destinoValido(req.params.destino);

router.put('/conexion/:destino', soloAdmin, async (req, res) => {
  try {
    const destino = destinoDe(req);
    const antes = await conexion.vista(destino, { admin: true });
    const v = conexion.validar(destino, req.body, { claveActual: await conexion.claveActual(destino) });
    if (v.error) return res.status(400).json({ error: v.error });
    await conexion.guardar(destino, v.valor, req.user.id);
    const despues = await conexion.vista(destino, { admin: true });
    const cambios = cambiosDe(destino, antes, despues, req.body);
    await auditar(req, { entidadId: `conexion-${destino}`, entidadNombre: `Conexión: ${NOMBRES[destino]}`, accion: 'EDICION', detalle: cambios.length ? `Conexión de ${NOMBRES[destino]} actualizada.` : `Conexión de ${NOMBRES[destino]} guardada sin cambios.`, cambios });
    res.json(despues);
  } catch (err) { responderError(res, err, 'PUT /conexion'); }
});

router.post('/conexion/:destino/quitar', soloAdmin, async (req, res) => {
  try {
    const destino = destinoDe(req);
    await conexion.guardar(destino, null, req.user.id);
    await auditar(req, { entidadId: `conexion-${destino}`, entidadNombre: `Conexión: ${NOMBRES[destino]}`, accion: 'ELIMINACION', detalle: `Se quitó la conexión guardada de ${NOMBRES[destino]} (si hay variables BREB_* en el .env, se usarán).` });
    res.json(await conexion.vista(destino, { admin: true }));
  } catch (err) { responderError(res, err, 'POST /conexion/quitar'); }
});

router.post('/conexion/:destino/probar', soloAdmin, async (req, res) => {
  try {
    const destino = destinoDe(req);
    const r = await conexion.probar(destino, req.body && Object.keys(req.body).length ? req.body : null);
    await auditar(req, { entidadId: `conexion-${destino}`, entidadNombre: `Conexión: ${NOMBRES[destino]}`, accion: 'PRUEBA_CONEXION', detalle: r.ok ? `Prueba de conexión correcta (${NOMBRES[destino]}).` : `Prueba de conexión fallida (${NOMBRES[destino]}).` });
    const { ok, version, baseConectada, servidor, puerto, base, url, error, aviso, rutaConsultar, rutaResolver } = r;
    res.json({ ok: !!ok, version: version || null, baseConectada: baseConectada || null, servidor: servidor || null, puerto: puerto || null, base: base || null, url: url || null, error: error || null, aviso: aviso || null, rutaConsultar: rutaConsultar || null, rutaResolver: rutaResolver || null });
  } catch (err) { responderError(res, err, 'POST /conexion/probar'); }
});

// ---------------------------------------------------------------------------
// Consultas (solo lectura)
// ---------------------------------------------------------------------------
const ruta = (path, nombre, fn, auditoria) => router.get(path, async (req, res) => {
  try {
    const salida = await fn(req);
    if (auditoria) await auditoria(req, salida);
    res.json(salida);
  } catch (err) { responderError(res, err, nombre); }
});

ruta('/resumen', 'resumen', (req) => S.resumen(q(req)));
ruta('/transacciones', 'transacciones', (req) => S.transacciones(q(req)));
ruta('/transaccion/:cus', 'transaccion', (req) => S.transaccion({ cus: req.params.cus }));
ruta('/errores', 'errores', (req) => S.errores(q(req)));
ruta('/reconciliacion', 'reconciliacion', (req) => S.reconciliacion(q(req)));
ruta('/cliente', 'cliente', (req) => S.cliente(q(req)),
  (req, salida) => auditar(req, { entidadId: salida.enmascarado, entidadNombre: 'Consulta por documento', accion: 'CONSULTA', detalle: `Consultó el cliente ${salida.enmascarado} en BREB.` }));
ruta('/llaves-qr', 'llaves-qr', (req) => S.llaves(q(req)));
ruta('/parametros', 'parametros', (req) => S.parametros(q(req)));
ruta('/logs', 'logs', (req) => S.logs(q(req)));
ruta('/logs/:codigo', 'log', (req) => S.logDetalle({ codigo: req.params.codigo }));
ruta('/catalogos', 'catalogos', () => S.catalogos());

// ---------------------------------------------------------------------------
// Herramientas de llaves (consultan el servicio de BreB; solo «consultar» y «resolver»)
// ---------------------------------------------------------------------------
router.post('/llaves/consultar', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await api.consultarLlave({ idTipoPersona: b.idTipoPersona, idTipoDocumento: b.idTipoDocumento, numeroDocumento: b.numeroDocumento });
    const doc = String(b.numeroDocumento).trim();
    const cruce = await S.cruceConsultar({ documento: doc, idTipoPersona: Number(b.idTipoPersona), idTipoDocumento: Number(b.idTipoDocumento) });
    await auditar(req, { entidadId: S.enmascarar(doc), entidadNombre: 'Consultar llave', accion: 'CONSULTA', detalle: `Consultó las llaves del documento ${S.enmascarar(doc)} en el servicio de BreB (HTTP ${r.http}).` });
    res.json({ ...r, cruce });
  } catch (err) { responderError(res, err, 'POST /llaves/consultar'); }
});

router.post('/llaves/resolver', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await api.resolverLlave({ aliasValue: b.aliasValue, received: b.received });
    const alias = String(b.aliasValue).trim();
    const cruce = await S.cruceResolver({ aliasValue: alias });
    await auditar(req, { entidadId: S.enmascarar(alias), entidadNombre: 'Resolver llave', accion: 'CONSULTA', detalle: `Resolvió la llave ${S.enmascarar(alias)} en el servicio de BreB (HTTP ${r.http}).` });
    res.json({ ...r, cruce });
  } catch (err) { responderError(res, err, 'POST /llaves/resolver'); }
});

module.exports = router;
