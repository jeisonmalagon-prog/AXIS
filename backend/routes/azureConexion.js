// Conexión con Azure DevOps administrable desde la app (SOLO ADMIN_POD):
//   GET    /conexion                      -> ajustes vigentes, tokens (sin el valor) y estado del .env
//   PUT    /conexion/ajustes              -> organización, proyecto, repositorio y rama por defecto
//   POST   /conexion/tokens               -> agrega un token (se guarda cifrado) y lo prueba
//   PUT    /conexion/tokens/:id           -> nombre, activo o nuevo valor del token
//   DELETE /conexion/tokens/:id           -> elimina (borra el valor guardado)
//   POST   /conexion/tokens/orden         -> orden de prioridad
//   POST   /conexion/tokens/:id/probar    -> qué secciones puede leer ese token (id «env» = el del .env)
// El valor del token nunca se devuelve ni se escribe en la auditoría. Se monta dentro de azureRepo.js.

const express = require('express');
const { getPool } = require('../db');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const C = require('../utils/azureCliente');
const CFG = require('../utils/azureConfig');
const { probarAreas } = require('../utils/azurePermisos');

const router = express.Router();

const soloAdminPod = (req, res, next) => {
  if (C.esAdminPod(req)) return next();
  res.status(403).json({ error: 'Solo el ADMIN_POD puede administrar la conexión con Azure DevOps.', codigo: 'SOLO_ADMIN' });
};
router.use('/conexion', soloAdminPod);

const envolver = (contexto, fn) => async (req, res) => {
  try {
    await fn(req, res, await getPool());
  } catch (err) {
    if (err instanceof CFG.ErrorConfig) return res.status(err.status).json({ error: err.message, codigo: err.codigo });
    console.error(`Error en conexión Azure (${contexto}):`, err.message);
    res.status(500).json({ error: 'No se pudo completar la operación.' });
  }
};

async function auditar(pool, req, accion, entidadId, nombre, detalle) {
  try {
    await registrarEventoGeneral(pool, req, { modulo: 'REPOSITORIO', entidad: 'Conexión con Azure DevOps', entidadId, entidadNombre: nombre, accion, detalle: String(detalle).slice(0, 500) });
  } catch (err) {
    console.error('No se pudo registrar la auditoría de la conexión con Azure DevOps:', err.message);
  }
}

// Prueba un token en todas las áreas y guarda el resultado (para elegir el token adecuado por sección).
async function probarToken(pool, { id, valor }) {
  const areas = await probarAreas({ token: { id, valor } });
  const ok = areas.filter((a) => a.ok).length;
  const todasRed = areas.every((a) => a.codigo === 'RED');
  const resultado = {
    areas: Object.fromEntries(areas.map((a) => [a.area, a.ok])),
    detalle: areas.map(({ area, nombre, permiso, ok: bien, codigo }) => ({ area, nombre, permiso, ok: bien, codigo })),
    ok, total: areas.length,
    sinRed: todasRed,
    probadoEn: new Date().toISOString(),
  };
  if (id && !todasRed) await CFG.guardarResultadoPrueba(pool, id, resultado);
  return resultado;
}

router.get('/conexion', envolver('GET', async (req, res, pool) => {
  C.invalidarCache();
  res.json(await CFG.listar(pool));
}));

router.put('/conexion/ajustes', envolver('PUT ajustes', async (req, res, pool) => {
  const antes = (await CFG.listar(pool)).vigente;
  await CFG.guardarAjustes(pool, req.body || {}, req.user.id);
  C.invalidarCache();
  const datos = await CFG.listar(pool);
  await auditar(pool, req, 'EDICION', 'ajustes', 'Organización / proyecto / repositorio',
    `Ajustes de Azure DevOps: ${antes.org}/${antes.project}/${antes.repo}@${antes.branch} → ${datos.vigente.org}/${datos.vigente.project}/${datos.vigente.repo}@${datos.vigente.branch}`);
  res.json(datos);
}));

router.post('/conexion/tokens/orden', envolver('POST orden', async (req, res, pool) => {
  await CFG.reordenar(pool, req.body?.ids, req.user.id);
  res.json(await CFG.listar(pool));
}));

router.post('/conexion/tokens', envolver('POST token', async (req, res, pool) => {
  const nuevo = await CFG.crear(pool, { nombre: req.body?.nombre, token: req.body?.token }, req.user.id);
  C.invalidarCache();
  await auditar(pool, req, 'CREACION', nuevo.id, nuevo.nombre, `Token de Azure DevOps agregado: «${nuevo.nombre}» (termina en ${nuevo.ultimos4}).`);
  let prueba = null;
  try { prueba = await probarToken(pool, await CFG.valorDe(pool, nuevo.id)); } catch (err) { console.error('No se pudo probar el token nuevo:', err.message); }
  res.status(201).json({ ...(await CFG.listar(pool)), idNuevo: nuevo.id, prueba });
}));

router.post('/conexion/tokens/:id/probar', envolver('POST probar', async (req, res, pool) => {
  if (req.params.id === 'env') {
    if (!process.env.AZURE_DEVOPS_PAT) return res.status(404).json({ error: 'No hay un token en el .env.' });
    return res.json({ prueba: await probarToken(pool, { id: 0, valor: process.env.AZURE_DEVOPS_PAT }) });
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Token no válido.' });
  const prueba = await probarToken(pool, await CFG.valorDe(pool, id));
  res.json({ ...(await CFG.listar(pool)), prueba, idProbado: id });
}));

router.put('/conexion/tokens/:id', envolver('PUT token', async (req, res, pool) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Token no válido.' });
  const { nombre, activo, token } = req.body || {};
  await CFG.actualizar(pool, id, {
    nombre, activo: activo === undefined ? undefined : !!activo, token,
  }, req.user.id);
  C.invalidarCache();
  const cambios = [nombre !== undefined && 'nombre', activo !== undefined && (activo ? 'activado' : 'desactivado'), token && 'valor reemplazado'].filter(Boolean).join(', ');
  await auditar(pool, req, 'EDICION', id, nombre || `Token ${id}`, `Token de Azure DevOps #${id} modificado (${cambios || 'sin cambios'}).`);
  let prueba = null;
  if (token && String(token).trim()) {
    try { prueba = await probarToken(pool, await CFG.valorDe(pool, id)); } catch (err) { console.error('No se pudo probar el token:', err.message); }
  }
  res.json({ ...(await CFG.listar(pool)), prueba, idProbado: prueba ? id : null });
}));

router.delete('/conexion/tokens/:id', envolver('DELETE token', async (req, res, pool) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Token no válido.' });
  const r = await CFG.eliminar(pool, id, req.user.id);
  C.invalidarCache();
  await auditar(pool, req, 'ELIMINACION', id, r.nombre, `Token de Azure DevOps eliminado: «${r.nombre}».`);
  res.json(await CFG.listar(pool));
}));

module.exports = router;
