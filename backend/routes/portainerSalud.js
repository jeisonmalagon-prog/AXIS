const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { getPool } = require('../db');
const { verifyToken, requireEditPermission, requireModule } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const { notificarVarios } = require('../utils/notificaciones');
const { PORTAINER_CONFIGURADO } = require('../utils/portainer');
const S = require('../utils/portainerSalud');

// Salud real, stacks e higiene de Portainer. Se monta en /api/monitoreo/portainer
// (después del router de monitoreo) — ver utils/portainerSalud.js.
const router = express.Router();
router.use(verifyToken, requireModule('SERVIDORES'));

const fresco = (req) => req.query.fresco === '1' || req.query.fresco === 'true';
function responder(fn) {
  return async (req, res) => {
    if (!PORTAINER_CONFIGURADO) return res.json({ configurado: false });
    try {
      const datos = await S.recolectar({ fresco: fresco(req) });
      res.json(fn(datos, req));
    } catch (err) {
      console.warn(`Portainer (salud): ${err.message}`);
      res.json({ configurado: true, error: mensajeErrorAmigable(err) });
    }
  };
}

router.get('/salud', responder((d) => S.salud(d)));
router.get('/stacks', responder((d) => S.stacks(d)));
router.get('/higiene', responder((d) => S.higiene(d)));
router.get('/alertas', (req, res) => res.json({ configurado: PORTAINER_CONFIGURADO, ...S.estadoVigilancia() }));

async function auditar(req, datos) {
  try { await registrarEventoGeneral(await getPool(), req, { modulo: 'SERVIDORES', ...datos }); } catch (e) { console.error('Auditoría Portainer:', e.message); }
}
function fallo(res, err) {
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: mensajeErrorAmigable(err) });
}

// POST /stacks/reiniciar { entornoId, stack } — reinicia todos los contenedores del stack.
router.post('/stacks/reiniciar', requireEditPermission, async (req, res) => {
  const { entornoId, stack } = req.body || {};
  if (!entornoId || !stack || typeof stack !== 'string') return res.status(400).json({ error: 'Indica el entorno y el stack.' });
  try {
    const r = await S.reiniciarStack(entornoId, stack);
    await auditar(req, { entidad: 'Stack Docker', entidadId: `${entornoId}:${stack}`, entidadNombre: stack, accion: 'REINICIAR_STACK', detalle: `Reinicio del stack "${stack}" en ${r.entorno}: ${r.reiniciados} contenedor(es) reiniciado(s)${r.fallidos.length ? `, ${r.fallidos.length} con error` : ''}.` });
    res.json(r);
  } catch (err) { fallo(res, err); }
});

// POST /higiene/limpiar-imagenes { entornoId, modo: 'huerfanas' | 'antiguas', dias? }
router.post('/higiene/limpiar-imagenes', requireEditPermission, async (req, res) => {
  const { entornoId, modo, dias } = req.body || {};
  if (!entornoId) return res.status(400).json({ error: 'Indica el entorno.' });
  try {
    const r = await S.limpiarImagenes(entornoId, modo, dias);
    await auditar(req, { entidad: 'Imágenes Docker', entidadId: String(entornoId), entidadNombre: r.entorno, accion: 'LIMPIAR_IMAGENES', detalle: `Limpieza de imágenes (${modo === 'huerfanas' ? 'sin etiqueta' : 'sin uso y antiguas'}) en ${r.entorno}: ${r.eliminadas} eliminada(s), ${r.espacioLiberado} liberados.` });
    res.json(r);
  } catch (err) { fallo(res, err); }
});

// Vigilancia: revisa la flota y avisa por la campana (y por correo si PORTAINER_ALERTA_EMAILS está definido).
async function enviarCorreoAlerta(alertas) {
  const lista = String(process.env.PORTAINER_ALERTA_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!lista.length) return;
  const correo = require('../utils/informes/correo');
  if (!correo.smtpConfigurado()) return;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await correo.enviarTexto({
    destinatarios: lista,
    asunto: `[AXIS] Portainer: ${alertas.length === 1 ? alertas[0].titulo : `${alertas.length} alertas nuevas`}`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px"><h2 style="margin:0 0 10px;color:#b91c1c">Alertas de Portainer</h2>${alertas.map((a) => `<div style="border-left:4px solid #dc2626;background:#fef2f2;padding:10px 14px;margin:8px 0;border-radius:0 6px 6px 0"><b>${esc(a.titulo)}</b><br><span style="color:#475569;font-size:13px">${esc(a.mensaje)}</span></div>`).join('')}<p style="font-size:12px;color:#64748b">Detalle en AXIS > Monitoreo > Salud. Mensaje automático.</p></div>`,
    texto: alertas.map((a) => `${a.titulo}\n${a.mensaje}`).join('\n\n'),
  });
}
S.iniciarVigilancia({ notificarVarios, getPool, enviarCorreo: enviarCorreoAlerta });

module.exports = router;
