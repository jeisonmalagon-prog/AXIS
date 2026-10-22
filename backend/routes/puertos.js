const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const { consultarPuertos, sshConfigurado, winrmConfigurado, metodosDisponibles } = require('../utils/puertosServidor');
const { cruzarConInventario, componentesDelServidor } = require('../utils/puertosInventario');

// ==========================================================================
// Inventario → Puertos: qué puertos están en escucha en cada servidor.
// Solo lectura: Linux se consulta por SSH (misma llave y usuario del
// monitoreo); Windows por WinRM (cuenta de servicio) o por SSH si el servidor
// lo tiene. No guarda nada en la base de datos ni cambia nada en los servidores.
// ==========================================================================

// Como mucho 4 consultas SSH a la vez en toda la aplicación, para no
// saturar el sshd de los servidores (el monitoreo ya aprendió esa lección) ni
// este mismo servidor cuando alguien pulsa «Consultar todos».
const MAX_SIMULTANEAS = 4;
let enCurso = 0;
const espera = [];
function tomarTurno() {
  return new Promise((resolve) => {
    const entrar = () => { enCurso += 1; resolve(); };
    if (enCurso < MAX_SIMULTANEAS) entrar(); else espera.push(entrar);
  });
}
function soltarTurno() {
  enCurso -= 1;
  const siguiente = espera.shift();
  if (siguiente) siguiente();
}

const SO_SOPORTADOS = ['linux', 'windows'];

// GET /api/puertos/servidores - servidores del inventario y si se pueden consultar
router.get('/servidores', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query(`
      SELECT s.Id AS id, s.Hostname AS hostname, s.IP AS ip, s.Ambiente AS ambiente,
             s.Activo AS activo, so.Nombre AS sistemaOperativo
      FROM Servidores s
      LEFT JOIN SistemasOperativos so ON so.Id = s.SistemaOperativoId
      ORDER BY s.Hostname
    `);
    const servidores = filas.map((f) => {
      const metodos = metodosDisponibles(f.sistemaOperativo);
      return {
        ...f,
        activo: f.activo === null || f.activo === undefined ? true : Boolean(f.activo),
        consultable: SO_SOPORTADOS.includes(String(f.sistemaOperativo || '').toLowerCase()),
        // Canales con los que hoy se puede consultar (según el .env): ssh y/o winrm.
        metodos,
      };
    });
    res.json({ sshConfigurado: sshConfigurado(), winrmConfigurado: winrmConfigurado(), servidores });
  } catch (err) {
    res.status(500).json({ error: mensajeErrorAmigable(err) });
  }
});

// GET /api/puertos/servidor/:id - consulta (SSH o WinRM) los puertos de UN servidor y los cruza con el inventario.
// Una falla de ese servidor (sin conexión, sin llave, SO no soportado) se
// responde con 200 y ok:false para que la pantalla la muestre en su tarjeta
// sin tratarla como falla de la aplicación.
router.get('/servidor/:id', verifyToken, requireModule('SERVIDORES'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Identificador de servidor no válido.' });

  let servidor;
  try {
    const pool = await getPool();
    const [filas] = await pool.query(`
      SELECT s.Id AS id, s.Hostname AS hostname, s.IP AS ip, s.Ambiente AS ambiente, so.Nombre AS sistemaOperativo
      FROM Servidores s
      LEFT JOIN SistemasOperativos so ON so.Id = s.SistemaOperativoId
      WHERE s.Id = ?
    `, [id]);
    if (!filas.length) return res.status(404).json({ error: 'Servidor no encontrado.' });
    servidor = filas[0];
  } catch (err) {
    return res.status(500).json({ error: mensajeErrorAmigable(err) });
  }

  const inicio = Date.now();
  await tomarTurno();
  try {
    const r = await consultarPuertos(servidor.ip, servidor.sistemaOperativo);
    // Cruce con el inventario: qué puertos están registrados (componente/aplicación) y cuáles no.
    // Si el inventario no se puede leer, los puertos igual se muestran (sin el cruce).
    let cruce = null;
    let errorInventario = null;
    try {
      const pool = await getPool();
      cruce = cruzarConInventario(r.puertos, await componentesDelServidor(pool, servidor.id));
    } catch (e) {
      console.error(`Puertos: no se pudo cruzar con el inventario (${servidor.hostname}):`, e.message);
      errorInventario = 'No se pudo leer el inventario para comparar los puertos.';
    }
    res.json({
      ...servidor, ok: true, error: null, consultadoEn: new Date().toISOString(), duracionMs: Date.now() - inicio, ...r,
      ...(cruce ? { puertos: cruce.puertos, inventarioSinEscuchar: cruce.inventarioSinEscuchar, resumen: { ...r.resumen, ...cruce.resumen } } : { inventarioSinEscuchar: [] }),
      errorInventario,
    });
  } catch (err) {
    if (!err.amigable) console.error(`Puertos: error inesperado consultando ${servidor.hostname}:`, err);
    res.json({
      ...servidor, ok: false,
      error: err.amigable ? err.message : 'No se pudo consultar este servidor.',
      consultadoEn: new Date().toISOString(), duracionMs: Date.now() - inicio, puertos: [], resumen: null,
    });
  } finally {
    soltarTurno();
  }
});

// Versión sin SSH: puertos en uso según Portainer + sugerencia de puertos libres.
require('./puertosPortainer').registrar(router, { getPool });

module.exports = router;
