// Certificados → «Contenedores (Portainer)»: qué certificados usan los contenedores y cómo cuadran con el inventario.
//   GET  /api/certificados-contenedores/entornos    servidores (environments) de Portainer, para elegir el alcance
//   POST /api/certificados-contenedores/escanear    lanza el escaneo en segundo plano (edición)
//   POST /api/certificados-contenedores/cancelar    cancela el escaneo en curso (edición)
//   GET  /api/certificados-contenedores/estado      avance del escaneo
//   GET  /api/certificados-contenedores/resultado   hallazgos conciliados con el inventario (se recalcula en cada consulta)
// Solo lectura sobre Portainer y los contenedores. Las contraseñas que se envíen al escanear solo se usan en memoria:
// no se guardan, no se registran y no entran a la auditoría (ver utils/certContenedores.js).

const express = require('express');
const { getPool } = require('../db');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const portainer = require('../utils/portainer');
const certContenedores = require('../utils/certContenedores');

const router = express.Router();

router.get('/entornos', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  if (!portainer.PORTAINER_CONFIGURADO) return res.json({ configurado: false, entornos: [] });
  try {
    const lista = await portainer.listarEndpoints();
    res.json({
      configurado: true,
      entornos: lista.map((e) => ({ id: e.Id, nombre: e.Name, conexion: e.Status === 1 ? 'up' : 'down' }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre)),
    });
  } catch (err) {
    console.warn(`Certificados/Portainer: no se pudo listar entornos: ${err.message}`);
    res.json({ configurado: true, entornos: [], error: mensajeErrorAmigable(err) });
  }
});

router.get('/estado', verifyToken, requireModule('CERTIFICADOS'), (req, res) => {
  res.json({ configurado: portainer.PORTAINER_CONFIGURADO, ...certContenedores.estadoEscaneo() });
});

router.post('/escanear', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, async (req, res) => {
  if (!portainer.PORTAINER_CONFIGURADO) return res.status(400).json({ error: 'Portainer no está configurado en el backend.' });
  try {
    const pool = await getPool();
    const body = req.body || {};
    const r = await certContenedores.iniciarEscaneo(pool, {
      profundo: body.profundo, incluirDetenidos: body.incluirDetenidos, sondeoTls: body.sondeoTls, archivos: body.archivos,
      rutas: body.rutas, claves: body.claves, entornoIds: body.entornoIds,
    });
    if (!r.yaEnCurso) {
      // La auditoría registra el alcance, NUNCA las contraseñas ni las rutas escritas por el usuario.
      try {
        await registrarEventoGeneral(pool, req, {
          modulo: 'CERTIFICADOS',
          entidad: 'Escaneo de contenedores',
          entidadId: r.id,
          entidadNombre: 'Certificados en contenedores (Portainer)',
          accion: 'EJECUCION',
          detalle: `Escaneo ${r.opciones.profundo ? 'profundo' : 'normal'}${r.opciones.entornoIds.length ? ` de ${r.opciones.entornoIds.length} servidor(es)` : ' de todos los servidores'}`
            + `${r.opciones.sondeoTls ? ', con sondeo TLS' : ''}${r.opciones.archivos ? ', con lectura de archivos' : ''}`
            + `${r.opciones.clavesExtra ? `, con ${r.opciones.clavesExtra} contraseña(s) indicada(s)` : ''}`,
        });
      } catch (e) { console.warn(`Certificados/Portainer: no se pudo auditar el escaneo: ${e.message}`); }
    }
    res.status(r.yaEnCurso ? 200 : 202).json(r);
  } catch (err) {
    console.error('Certificados/Portainer: no se pudo iniciar el escaneo:', err.message);
    res.status(err.codigo || 500).json({ error: mensajeErrorAmigable(err) });
  }
});

router.post('/cancelar', verifyToken, requireModule('CERTIFICADOS'), requireEditPermission, (req, res) => {
  res.json({ cancelado: certContenedores.cancelarEscaneo(), ...certContenedores.estadoEscaneo() });
});

router.get('/resultado', verifyToken, requireModule('CERTIFICADOS'), async (req, res) => {
  try {
    const pool = await getPool();
    res.json(await certContenedores.resultadoConciliado(pool));
  } catch (err) {
    console.error('Certificados/Portainer: no se pudo conciliar:', err.message);
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

module.exports = router;
