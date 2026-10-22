const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { rolEnModulo } = require('../utils/permisosModulos');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const conexion = require('../utils/prospeccionConexion');
const S = require('../utils/prospeccionServicio');

// ==========================================================================
// Soporte Nivel 1 > Monitorear prospección (se monta en /api/soporte-n1/prospeccion).
//  · Lo ve quien tenga el módulo SOPORTE_N1 (cualquier rol: todo es de SOLO LECTURA).
//  · Solo el ADMIN_POD configura la conexión a GestionCliente (servidor, base, usuario y clave; la clave se guarda cifrada
//    y nunca vuelve al navegador).
//  · Auditoría: cambios de la conexión (sin la clave) y consultas por cliente (documento enmascarado).
// ==========================================================================

router.use(verifyToken, requireModule('SOPORTE_N1'));

const soloAdmin = (req, res, next) => {
  if (req.user && req.user.rol === 'ADMIN_POD') return next();
  return res.status(403).json({ error: 'Solo el ADMIN_POD puede cambiar la conexión de Monitorear prospección.' });
};

async function auditar(req, datos) {
  try {
    await registrarEventoGeneral(await getPool(), req, { modulo: 'SOPORTE_N1', entidad: 'Monitorear prospección', ...datos });
  } catch (e) { console.error('[prospeccion] No se pudo registrar la auditoría:', e.message); }
}

function responderError(res, err, contexto) {
  if (err instanceof S.ErrorProspeccion || err instanceof conexion.ErrorConexion) {
    return res.status(err.status || 400).json({ error: err.message, codigo: err.codigo });
  }
  console.error(`[prospeccion] Error en ${contexto}:`, err && err.message);
  return res.status(500).json({ error: 'No se pudo completar la consulta de prospección.' });
}

const q = (req) => req.query || {};

router.get('/', async (req, res) => {
  try {
    const admin = req.user.rol === 'ADMIN_POD';
    const [rol, vista] = await Promise.all([rolEnModulo(req, 'SOPORTE_N1'), conexion.vista({ admin })]);
    res.json({ rol, esAdminPod: admin, conexion: vista });
  } catch (err) { responderError(res, err, 'GET /'); }
});

// ---------------------------------------------------------------------------
// Conexión (solo ADMIN_POD)
// ---------------------------------------------------------------------------
router.put('/conexion', soloAdmin, async (req, res) => {
  try {
    const antes = await conexion.vista({ admin: true });
    const v = conexion.validar(req.body, { claveActual: await conexion.claveActual() });
    if (v.error) return res.status(400).json({ error: v.error });
    await conexion.guardar(v.valor, req.user.id);
    S.olvidarEsquema();
    const despues = await conexion.vista({ admin: true });

    const cambios = [];
    const cmp = (campo, etiqueta, a, b) => { if (String(a ?? '') !== String(b ?? '')) cambios.push({ campo, etiqueta, anterior: String(a ?? '') || '(vacío)', nuevo: String(b ?? '') || '(vacío)' }); };
    cmp('servidor', 'Servidor', antes.guardadaEnApp ? antes.servidor : '', despues.servidor);
    cmp('puerto', 'Puerto', antes.guardadaEnApp ? antes.puerto : '', despues.puerto);
    cmp('base', 'Base de datos', antes.guardadaEnApp ? antes.base : '', despues.base);
    cmp('usuario', 'Usuario', antes.usuario, despues.usuario);
    cmp('cifrado', 'Cifrar conexión', antes.cifrado ? 'sí' : 'no', despues.cifrado ? 'sí' : 'no');
    cmp('confiarCertificado', 'Confiar en el certificado', antes.confiarCertificado ? 'sí' : 'no', despues.confiarCertificado ? 'sí' : 'no');
    if (req.body && String(req.body.clave || '') !== '') cambios.push({ campo: 'clave', etiqueta: 'Clave', anterior: '(oculta)', nuevo: '(cambiada)' });
    await auditar(req, { entidadId: 'conexion', entidadNombre: 'Conexión a GestionCliente', accion: 'EDICION', detalle: cambios.length ? 'Conexión a GestionCliente actualizada.' : 'Conexión a GestionCliente guardada sin cambios.', cambios });
    res.json(despues);
  } catch (err) { responderError(res, err, 'PUT /conexion'); }
});

router.post('/conexion/quitar', soloAdmin, async (req, res) => {
  try {
    await conexion.guardar(null, req.user.id);
    S.olvidarEsquema();
    await auditar(req, { entidadId: 'conexion', entidadNombre: 'Conexión a GestionCliente', accion: 'ELIMINACION', detalle: 'Se quitó la conexión guardada de GestionCliente (si hay variables GESTIONCLIENTE_DB_* en el .env, se usarán).' });
    res.json(await conexion.vista({ admin: true }));
  } catch (err) { responderError(res, err, 'POST /conexion/quitar'); }
});

router.post('/conexion/probar', soloAdmin, async (req, res) => {
  try {
    const r = await conexion.probar(req.body && Object.keys(req.body).length ? req.body : null);
    await auditar(req, { entidadId: 'conexion', entidadNombre: 'Conexión a GestionCliente', accion: 'PRUEBA_CONEXION', detalle: r.ok ? `Prueba de conexión correcta (${r.servidor || ''}/${r.baseConectada || r.base || ''}).` : 'Prueba de conexión fallida.' });
    const { ok, version, baseConectada, servidor, puerto, base, error } = r;
    res.json({ ok: !!ok, version: version || null, baseConectada: baseConectada || null, servidor: servidor || null, puerto: puerto || null, base: base || null, error: error || null });
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

ruta('/resumen', 'resumen', (req) => S.resumen({ dias: q(req).dias }));
ruta('/cargues', 'cargues', (req) => S.cargues({ top: q(req).top }));
ruta('/cargues/:id', 'cargue', (req) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw new S.ErrorProspeccion('El identificador del cargue debe ser un número.');
  return S.cargue({ id: req.params.id });
});
ruta('/cliente', 'cliente', (req) => S.cliente({ documento: q(req).documento, trazaDias: q(req).trazaDias }),
  (req, salida) => auditar(req, { entidadId: S.enmascarar(salida.documento), entidadNombre: 'Consulta por documento', accion: 'CONSULTA', detalle: `Consultó la trazabilidad de prospección del documento ${S.enmascarar(salida.documento)}.` }));
ruta('/procesos', 'procesos', (req) => S.procesos({ dias: q(req).dias, top: q(req).top, estado: q(req).estado, aliado: q(req).aliado }));
ruta('/pagares', 'pagares', (req) => S.pagares({ dias: q(req).dias, top: q(req).top }));
ruta('/logs', 'logs', (req) => S.logs({ tabla: q(req).tabla, dias: q(req).dias, top: q(req).top }));
ruta('/esquema', 'esquema', (req) => S.esquema({ forzar: q(req).forzar === '1' }));

module.exports = router;
