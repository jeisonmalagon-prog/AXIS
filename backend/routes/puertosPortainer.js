// Inventario → Puertos, versión Portainer: qué puertos están en uso, en qué servidor y en qué
// contenedor, y sugerencia de puertos libres según el tipo de componente.
//   GET /api/puertos/portainer?forzar=1   puertos publicados por los contenedores de cada servidor
//   GET /api/puertos/cruce?forzar=1       cruce de contenedores con el inventario de sub-aplicativos
//   GET /api/puertos/normas               rangos de puertos por tipo de componente
//   GET /api/puertos/sugerir?tipo=api&entorno=12|todos&cantidad=3
// Solo lectura: no se conecta a los servidores, solo a Portainer (ver utils/portainer.js).

const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { cargarNormas, consultarConInventario, puroSugerir } = require('../utils/puertosPortainer');
const { cruzarPortainerConInventario } = require('../utils/cruceSubaplicativos');
const { garantizarEsquemaSubaplicativos } = require('../utils/subaplicativosSchema');

function registrar(router, { getPool }) {
  router.get('/portainer', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
    // Un fallo de Portainer (caído, credenciales, TLS) no es un 500 de la aplicación: se responde 200 con el motivo.
    try {
      const pool = await getPool();
      const r = await consultarConInventario(pool, { forzar: req.query.forzar === '1' });
      res.json({ ...r, error: null });
    } catch (err) {
      console.warn(`Puertos/Portainer: no se pudo consultar: ${err.message}`);
      res.json({ configurado: true, entornos: [], consultadoEn: null, error: mensajeErrorAmigable(err) });
    }
  });

  // Cruce de los contenedores de Portainer con el inventario de sub-aplicativos (nombre, imagen, puerto, estado).
  router.get('/cruce', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
    try {
      const pool = await getPool();
      try { await garantizarEsquemaSubaplicativos(pool); } catch (e) { console.warn(`Cruce: esquema de sub-aplicativos: ${e.message}`); }
      const r = await cruzarPortainerConInventario(pool, { forzar: req.query.forzar === '1' });
      res.json({ ...r, error: null });
    } catch (err) {
      console.warn(`Cruce Portainer/inventario: no se pudo calcular: ${err.message}`);
      res.json({ configurado: true, consultadoEn: null, secciones: [], servidoresSinPortainer: [], resumen: null, error: mensajeErrorAmigable(err) });
    }
  });

  router.get('/normas', verifyToken, requireModule('SERVIDORES'), (req, res) => {
    res.json(cargarNormas());
  });

  router.get('/sugerir', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
    try {
      const normas = cargarNormas();
      const tipoId = String(req.query.tipo || '').trim().toLowerCase();
      if (!tipoId) return res.status(400).json({ error: 'Indica el tipo de componente.' });
      const crudo = String(req.query.entorno || 'todos').trim().toLowerCase();
      let entornoId = null;
      if (crudo !== 'todos') {
        entornoId = Number(crudo);
        if (!Number.isInteger(entornoId) || entornoId <= 0) return res.status(400).json({ error: 'Servidor no válido.' });
      }
      const pool = await getPool();
      const datos = await consultarConInventario(pool, {});
      if (!datos.configurado) return res.status(400).json({ error: 'Portainer no está configurado en el backend.' });
      const r = puroSugerir({ entornos: datos.entornos, normas, tipoId, entornoId, cantidad: req.query.cantidad });
      if (r.error) return res.status(400).json({ error: r.error });
      res.json({ ...r, consultadoEn: datos.consultadoEn, normasOrigen: normas.origen });
    } catch (err) {
      console.error('Puertos/Portainer: error al sugerir:', err);
      res.status(500).json({ error: mensajeErrorAmigable(err) });
    }
  });
}

module.exports = { registrar };
