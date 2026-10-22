// Accesos del módulo Repositorio: qué secciones y qué repositorios ve cada usuario
// de AXIS. Se monta dentro de azureRepo.js (que ya exige sesión + módulo
// REPOSITORIO y aplica el control de acceso a las demás rutas).
//
//   GET /mi-acceso                       -> lo que puede ver el usuario actual
//   GET /accesos                         -> (ADMIN_POD) usuarios, catálogo, repositorios y asignaciones
//   PUT /accesos/usuarios/:usuarioId     -> (ADMIN_POD) reemplaza secciones y repos de un usuario

const express = require('express');
const { getPool } = require('../db');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const C = require('../utils/azureCliente');
const P = require('../utils/repositorioPermisos');

const router = express.Router();

const soloAdminPod = (req, res, next) => {
  if (C.esAdminPod(req)) return next();
  res.status(403).json({ error: 'Solo el ADMIN_POD puede administrar esto.', codigo: 'SOLO_ADMIN' });
};

router.get('/mi-acceso', async (req, res) => {
  try {
    const pool = await getPool();
    const estricto = await P.modoEstricto(pool);
    const acceso = req.accesoRepo || (await P.accesoDe(pool, req.user));
    res.json({ estricto, ...P.resumenParaCliente(acceso) });
  } catch (err) {
    console.error('Error en /azure-repo/mi-acceso:', err);
    res.status(500).json({ error: 'No se pudo consultar tu acceso.' });
  }
});

// Repositorios existentes en Azure DevOps (nombre y rama por defecto).
async function repositoriosDeAzure() {
  const r = await C.obtener(C.urlProyecto('/git/repositories'), {}, { area: 'codigo' });
  return (r.value || [])
    .map((x) => ({ nombre: x.name, ramaPorDefecto: (x.defaultBranch || '').replace('refs/heads/', '') || null, deshabilitado: !!x.isDisabled }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

router.get('/accesos', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const estricto = await P.modoEstricto(pool);
    let repos = [];
    let errorRepos = null;
    try { repos = await repositoriosDeAzure(); } catch (err) {
      errorRepos = C.mensajePublico(err);
      if (err.configuracionFaltante) errorRepos = err.message;
    }
    const base = { estricto, secciones: P.SECCIONES, repositorios: repos, errorRepositorios: errorRepos, repoPorDefecto: C.REPO };
    if (!estricto) return res.json({ ...base, usuarios: [], asignaciones: {} });
    const [usuarios, asignaciones] = await Promise.all([P.usuariosAsignables(pool), P.asignacionesVigentes(pool)]);
    res.json({ ...base, usuarios, asignaciones });
  } catch (err) {
    console.error('Error en accesos del Repositorio:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/accesos/usuarios/:usuarioId', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    if (!(await P.modoEstricto(pool))) {
      return res.status(503).json({ error: 'Falta crear la tabla de permisos. Ejecuta una sola vez el script crear_tabla_repositorio_permisos.sql.' });
    }
    const usuarioId = parseInt(req.params.usuarioId, 10);
    const usuarios = await P.usuariosAsignables(pool);
    const usuario = usuarios.find((u) => u.id === usuarioId);
    if (!usuario) return res.status(404).json({ error: 'El usuario no existe, está inactivo o es ADMIN_POD (que ve todo).' });

    const secciones = req.body?.secciones;
    const repos = req.body?.repos;
    if (!Array.isArray(secciones) || secciones.length > 50 || secciones.some((s) => typeof s !== 'string' || !P.IDS_SECCION.has(s))) {
      return res.status(400).json({ error: 'La lista de secciones no es válida.' });
    }
    if (!Array.isArray(repos) || repos.length > 500 || repos.some((r) => typeof r !== 'string' || (r !== P.TODOS_LOS_REPOS && !P.REPO_VALIDO.test(r)))) {
      return res.status(400).json({ error: 'La lista de repositorios no es válida.' });
    }

    const seccionesFinales = [...new Set(secciones)];
    let reposFinales = [...new Set(repos)];
    if (reposFinales.includes(P.TODOS_LOS_REPOS)) reposFinales = [P.TODOS_LOS_REPOS];

    // Solo se aceptan repositorios que existen hoy en Azure; uno que ya estaba
    // asignado y no aparece (renombrado/borrado, o Azure no respondió) se conserva.
    const vigentes = (await P.asignacionesVigentes(pool))[usuarioId]?.repos || [];
    if (!reposFinales.includes(P.TODOS_LOS_REPOS)) {
      let conocidos = null;
      try { conocidos = new Set((await repositoriosDeAzure()).map((r) => r.nombre)); } catch { /* sin lista: no se valida */ }
      if (conocidos) {
        const desconocidos = reposFinales.filter((r) => !conocidos.has(r) && !vigentes.includes(r));
        if (desconocidos.length) return res.status(400).json({ error: `Repositorio no encontrado en Azure DevOps: ${desconocidos.slice(0, 3).join(', ')}.` });
      }
    }

    const { agregados, quitados } = await P.guardarAsignacion(pool, req, usuarioId, seccionesFinales, reposFinales);

    if (agregados.length || quitados.length) {
      const nombre = (k) => { const [tipo, ...r] = k.split('|'); const c = r.join('|'); return tipo === 'SECCION' ? (P.SECCIONES.find((s) => s.id === c)?.nombre || c) : (c === P.TODOS_LOS_REPOS ? 'todos los repos' : `repo ${c}`); };
      const lista = (ids) => ids.slice(0, 6).map(nombre).join(', ') + (ids.length > 6 ? `… (+${ids.length - 6})` : '');
      const partes = [];
      if (agregados.length) partes.push(`+${agregados.length}: ${lista(agregados)}`);
      if (quitados.length) partes.push(`-${quitados.length}: ${lista(quitados)}`);
      try {
        await registrarEventoGeneral(pool, req, {
          modulo: 'REPOSITORIO',
          entidad: 'Acceso al Repositorio',
          entidadId: usuarioId,
          entidadNombre: usuario.username,
          accion: 'EDICION',
          detalle: `Accesos de ${usuario.username} (${seccionesFinales.length} secciones, ${reposFinales.includes(P.TODOS_LOS_REPOS) ? 'todos los repos' : reposFinales.length + ' repos'}): ${partes.join(' | ')}`.slice(0, 500),
          cambios: [
            { campo: 'secciones', etiqueta: 'Secciones con acceso', anterior: String(seccionesAntes(agregados, quitados, seccionesFinales)), nuevo: String(seccionesFinales.length) },
          ],
        });
      } catch (errAudit) {
        console.error('No se pudo registrar la auditoría de accesos del Repositorio:', errAudit);
      }
    }
    res.json({ ok: true, agregados: agregados.length, quitados: quitados.length });
  } catch (err) {
    console.error('Error guardando accesos del Repositorio:', err);
    res.status(500).json({ error: err.message });
  }
});

// Cantidad de secciones que tenía antes = las de ahora - las agregadas + las quitadas.
function seccionesAntes(agregados, quitados, finales) {
  const agr = agregados.filter((k) => k.startsWith('SECCION|')).length;
  const qui = quitados.filter((k) => k.startsWith('SECCION|')).length;
  return Math.max(0, finales.length - agr + qui);
}

module.exports = router;
