const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral } = require('../utils/auditoriaGeneral');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const catalogo = require('../utils/catalogoDatos');
const origenesDb = require('../utils/catalogoOrigenes');
const sesion = require('../utils/catalogoSesion');
const { probarOrigen, mensajeErrorOrigen, parsearUsuarioDominio } = require('../utils/catalogoExtraccion');

// ==========================================================================
// Módulo CATALOGO_DATOS: mapa navegable de bases, tablas, columnas y llaves
// foráneas de los servidores SQL Server / MariaDB registrados.
//
//  - Todo es de SOLO LECTURA sobre los catálogos del sistema de cada servidor.
//  - Quien tenga el módulo busca, ve el diccionario, el diagrama ER y el mapa.
//  - «Actualizar» (volver a leer los servidores) requiere permiso de edición.
//  - Los orígenes (servidor, puerto, opciones) son PERSONALES: cada persona (con permiso de edición) registra los suyos y solo
//    ve y administra los que ella creó; NO llevan usuario ni clave.
//  - CADA PERSONA usa SUS credenciales: las escribe en «Mis credenciales» (una por motor), viven solo en la
//    memoria del backend durante su sesión (nunca en la base ni en el .env, nunca vuelven al navegador, nunca
//    se auditan) y con ellas se construye SU catálogo y SU mapa estelar. Nadie ve el de otra persona.
// ==========================================================================

router.use(verifyToken, requireModule('CATALOGO_DATOS'));

// Todo lo que sigue (catálogo, búsquedas, mapa, queries) se resuelve en nombre de quien hace la petición.
router.use((req, res, next) => sesion.ejecutarComo(req.user?.username, next));

// Repositorio de queries, constructor guiado, asistente IA y ejecución de solo lectura.
router.use('/queries', require('./catalogoQueries'));

const soloAdminPod = (req, res, next) => {
  if (req.user?.rol === 'ADMIN_POD') return next();
  return res.status(403).json({ error: 'Solo el ADMIN_POD puede hacer esto.' });
};

async function auditar(req, datos) {
  try {
    await registrarEventoGeneral(await getPool(), req, { modulo: 'CATALOGO_DATOS', ...datos });
  } catch (error) {
    console.error('[catalogo-datos] No se pudo registrar la auditoría:', error.message);
  }
}

// Límites por usuario (ventana de 1 minuto) para las operaciones que tocan los servidores.
const ventanas = new Map();
function excede(clave, limite) {
  const ahora = Date.now();
  const recientes = (ventanas.get(clave) || []).filter((t) => ahora - t < 60000);
  if (recientes.length >= limite) { ventanas.set(clave, recientes); return true; }
  recientes.push(ahora);
  ventanas.set(clave, recientes);
  return false;
}

const refDe = (q) => ({ o: String(q.o || ''), bd: String(q.bd || ''), es: String(q.es || ''), n: String(q.n || '') });

// --------------------------------------------------------------------------
// Lectura (cualquiera con el módulo)
// --------------------------------------------------------------------------
router.get('/resumen', async (req, res) => {
  try {
    const pool = await getPool();
    const { tabla } = await origenesDb.listarOrigenesAdmin(pool);
    if (tabla) await catalogo.asegurarCargado(pool);
    res.json({ tablaOrigenes: tabla, credenciales: sesion.resumen(req.user.username), ...catalogo.resumen() });
  } catch (error) {
    console.error('Error en el resumen del catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el resumen del catálogo de datos' }) });
  }
});

router.get('/galaxia', (req, res) => {
  res.json(catalogo.galaxia());
});

router.get('/buscar', (req, res) => {
  const q = String(req.query.q || '').slice(0, 100);
  const tipo = ['todo', 'tabla', 'columna'].includes(req.query.tipo) ? req.query.tipo : 'todo';
  res.json(catalogo.buscar({ q, tipo, origenId: req.query.origen || null, bd: req.query.bd || null, limite: req.query.limite }));
});

router.get('/columna', (req, res) => {
  const nombre = String(req.query.nombre || '').slice(0, 128);
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la columna.' });
  res.json(catalogo.lugaresDeColumna(nombre, { origenId: req.query.origen || null, bd: req.query.bd || null, desde: req.query.desde, limite: req.query.limite }));
});

router.get('/tabla', (req, res) => {
  const d = catalogo.detalle(refDe(req.query));
  if (!d) return res.status(404).json({ error: 'No se encontró esa tabla en el catálogo (¿se actualizó o se quitó el origen?).' });
  res.json(d);
});

router.get('/grafo', (req, res) => {
  const g = catalogo.grafo(refDe(req.query), req.query.profundidad);
  if (!g) return res.status(404).json({ error: 'No se encontró esa tabla en el catálogo.' });
  res.json(g);
});

router.get('/mapa-base', (req, res) => {
  const m = catalogo.mapaBase(String(req.query.o || ''), String(req.query.bd || ''));
  if (!m) return res.status(404).json({ error: 'No se encontró esa base en el catálogo.' });
  res.json(m);
});

// --------------------------------------------------------------------------
// Mis credenciales (cada persona las suyas, una por motor). Solo en memoria y por sesión.
// --------------------------------------------------------------------------
const motorDe = (req) => String(req.params.motor || '').toUpperCase();

router.get('/credenciales', (req, res) => {
  res.json({ credenciales: sesion.resumen(req.user.username), horas: parseFloat(process.env.CATALOGO_SESION_HORAS || '8') || 8 });
});

router.put('/credenciales/:motor', async (req, res) => {
  const motor = motorDe(req);
  if (!sesion.MOTORES.includes(motor)) return res.status(400).json({ error: 'Motor desconocido.' });
  if (excede(`cred:${req.user.id}`, 10)) return res.status(429).json({ error: 'Demasiados cambios seguidos. Espera un minuto.' });
  const v = sesion.validar(req.body, sesion.tieneClave(req.user.username, motor));
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    sesion.definir(req.user.username, motor, v.valor);
    // Nunca se audita ni se registra la clave.
    await auditar(req, { entidad: 'Credenciales del catálogo', entidadId: motor, entidadNombre: sesion.nombreMotor(motor), accion: 'EDICION', detalle: `Definió sus credenciales personales de ${sesion.nombreMotor(motor)} para esta sesión.` });
    const r = await catalogo.actualizar(await getPool());   // arma SU catálogo en segundo plano
    res.json({ credenciales: sesion.resumen(req.user.username), iniciados: r.iniciados || 0 });
  } catch (error) {
    console.error('Error al definir las credenciales del catálogo:', error.message);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'tus credenciales del catálogo' }) });
  }
});

router.delete('/credenciales/:motor', async (req, res) => {
  const motor = motorDe(req);
  if (!sesion.MOTORES.includes(motor)) return res.status(400).json({ error: 'Motor desconocido.' });
  try {
    sesion.quitar(req.user.username, motor);
    await auditar(req, { entidad: 'Credenciales del catálogo', entidadId: motor, entidadNombre: sesion.nombreMotor(motor), accion: 'ELIMINACION', detalle: `Quitó sus credenciales personales de ${sesion.nombreMotor(motor)}.` });
    await catalogo.actualizar(await getPool());   // saca de SU catálogo lo leído con esas credenciales
    res.json({ credenciales: sesion.resumen(req.user.username) });
  } catch (error) {
    console.error('Error al quitar las credenciales del catálogo:', error.message);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'tus credenciales del catálogo' }) });
  }
});

// --------------------------------------------------------------------------
// Actualizar la caché (vuelve a leer los servidores)
// --------------------------------------------------------------------------
router.post('/actualizar', requireEditPermission, async (req, res) => {
  if (excede(`act:${req.user.id}`, 3)) return res.status(429).json({ error: 'Demasiadas actualizaciones seguidas. Espera un minuto.' });
  try {
    const pool = await getPool();
    const r = await catalogo.actualizar(pool, { origenId: req.body?.origen || null });
    if (!r.tabla) return res.status(409).json({ error: 'Falta crear la tabla de orígenes (crear_tabla_catalogo_origenes.sql).' });
    await auditar(req, { entidad: 'Catalogo', entidadId: req.body?.origen || 'todos', entidadNombre: 'Catálogo de datos', accion: 'EJECUCION', detalle: `Actualización de ${r.iniciados} origen(es).` });
    res.json({ iniciado: true, origenes: r.iniciados, sinCredenciales: r.sinCredenciales || 0 });
  } catch (error) {
    console.error('Error al actualizar el catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la actualización del catálogo de datos' }) });
  }
});

// --------------------------------------------------------------------------
// Orígenes: cada persona los suyos (solo ve y modifica los que ella creó)
// --------------------------------------------------------------------------
router.get('/origenes', async (req, res) => {
  try {
    res.json(await origenesDb.listarOrigenesAdmin(await getPool()));
  } catch (error) {
    console.error('Error al listar los orígenes del catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'los orígenes del catálogo' }) });
  }
});

router.post('/origenes', requireEditPermission, async (req, res) => {
  const v = origenesDb.validarOrigen(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const pool = await getPool();
    const id = await origenesDb.crearOrigen(pool, req, v.valor);
    await auditar(req, { entidad: 'Origen del catálogo', entidadId: id, entidadNombre: v.valor.nombre, accion: 'CREACION', detalle: `Origen ${v.valor.motor} ${v.valor.host}:${v.valor.puerto}.` });
    res.status(201).json(await origenesDb.obtenerOrigenPublico(pool, id));
  } catch (error) {
    if (error.status === 409 || /Falta esquema/i.test(error.message)) return res.status(409).json({ error: error.message });
    console.error('Error al crear el origen del catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el origen del catálogo' }) });
  }
});

router.put('/origenes/:id', requireEditPermission, async (req, res) => {
  const v = origenesDb.validarOrigen(req.body, { parcial: true });
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const pool = await getPool();
    const actual = await origenesDb.obtenerOrigenPublico(pool, req.params.id);
    if (!actual) return res.status(404).json({ error: 'Origen no encontrado.' });
    await origenesDb.actualizarOrigen(pool, req.params.id, v.valor);
    const campos = Object.keys(v.valor);
    await auditar(req, { entidad: 'Origen del catálogo', entidadId: req.params.id, entidadNombre: v.valor.nombre || actual.nombre, accion: 'EDICION', detalle: `Campos: ${campos.join(', ') || 'ninguno'}.` });
    res.json(await origenesDb.obtenerOrigenPublico(pool, req.params.id));
  } catch (error) {
    if (/Falta esquema/i.test(error.message)) return res.status(409).json({ error: error.message });
    console.error('Error al editar el origen del catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el origen del catálogo' }) });
  }
});

// "Quitar": sin DELETE en producción (se marca como eliminado).
router.delete('/origenes/:id', requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const actual = await origenesDb.obtenerOrigenPublico(pool, req.params.id);
    if (!actual) return res.status(404).json({ error: 'Origen no encontrado.' });
    await origenesDb.quitarOrigen(pool, req.params.id);
    await auditar(req, { entidad: 'Origen del catálogo', entidadId: req.params.id, entidadNombre: actual.nombre, accion: 'ELIMINACION', detalle: 'Origen quitado del catálogo.' });
    await catalogo.actualizar(pool).catch(() => {});   // saca el origen de la caché
    res.json({ ok: true });
  } catch (error) {
    if (/Falta esquema/i.test(error.message)) return res.status(409).json({ error: error.message });
    console.error('Error al quitar el origen del catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'el origen del catálogo' }) });
  }
});

// Probar conexión: con los datos del formulario y las credenciales PERSONALES de quien prueba (las de su sesión).
router.post('/origenes/probar', requireEditPermission, async (req, res) => {
  if (excede(`probar:${req.user.id}`, 10)) return res.status(429).json({ error: 'Demasiadas pruebas seguidas. Espera un minuto.' });
  const b = req.body || {};
  try {
    const pool = await getPool();
    let base = null;
    if (b.id) {
      base = await origenesDb.obtenerOrigenInterno(pool, b.id);
      if (!base) return res.status(404).json({ error: 'Origen no encontrado.' });
    }
    const v = origenesDb.validarOrigen({ nombre: b.nombre || (base && base.nombre) || 'prueba', ...b }, { parcial: !!base });
    if (v.error) return res.status(400).json({ error: v.error });
    const sinCred = { ...(base || {}), ...v.valor };
    if (!sinCred.puerto) sinCred.puerto = origenesDb.PUERTO_DEFECTO[sinCred.motor];
    const origen = sesion.conCredenciales(sinCred, req.user.username);
    if (!origen) return res.status(400).json({ ok: false, sinCredenciales: true, error: `Primero agrega tu usuario y clave de ${sesion.nombreMotor(sinCred.motor)} en «Mis credenciales».` });
    try {
      res.json(await probarOrigen(origen));
    } catch (error) {
      res.json({ ok: false, error: mensajeErrorOrigen(error, origen) });
    }
  } catch (error) {
    console.error('Error al probar el origen del catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la prueba de conexión' }) });
  }
});

// Borra las claves que quedaron guardadas en la base por la versión anterior (ya no se usan para nada).
router.post('/origenes/limpiar-claves', soloAdminPod, async (req, res) => {
  try {
    const pool = await getPool();
    const n = await origenesDb.limpiarClavesGuardadas(pool);
    await auditar(req, { entidad: 'Origen del catálogo', entidadId: 'todos', entidadNombre: 'Claves guardadas', accion: 'EDICION', detalle: `Borró las credenciales guardadas de ${n} origen(es) (ya no se usan: cada persona usa las suyas).` });
    res.json({ ok: true, limpiados: n });
  } catch (error) {
    if (/Falta esquema/i.test(error.message)) return res.status(409).json({ error: error.message });
    console.error('Error al limpiar las claves guardadas del catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'las claves guardadas del catálogo' }) });
  }
});

// --------------------------------------------------------------------------
// Carga masiva: pegar una lista de servidores SQL Server.
//   modo 'probar'   -> prueba la conexión de cada línea con el usuario/clave escritos ahí (NO se guardan en ningún lado)
//   modo 'registrar'-> guarda como origen (solo host/puerto/opciones) cada línea válida y no repetida; sin credenciales
// Para no bloquear una cuenta de dominio con la clave mal escrita, la primera prueba va de a una
// y se detiene tras 2 inicios de sesión rechazados seguidos mientras ninguno haya funcionado.
// El frontend envía la lista por tandas pequeñas (`verificada: true` desde la segunda tanda si ya hubo un éxito).
// --------------------------------------------------------------------------
const MAX_POR_TANDA = 25;
const PARALELO_MASIVO = 4;

router.post('/origenes/masivo', requireEditPermission, async (req, res) => {
  const b = req.body || {};
  const modo = b.modo === 'registrar' ? 'registrar' : 'probar';
  if (excede(`masivo:${req.user.id}`, 60)) return res.status(429).json({ error: 'Demasiadas operaciones seguidas. Espera un minuto.' });

  const base = origenesDb.validarOrigen({
    nombre: 'masivo', motor: 'MSSQL', host: 'x', cifrado: !!b.cifrado, confiarCertificado: b.confiarCertificado !== false,
  });
  if (base.error) return res.status(400).json({ error: base.error });
  // Credenciales de la prueba: solo viven en esta petición.
  const credPrueba = { usuario: String(b.usuario ?? '').trim(), clave: b.clave === undefined || b.clave === null ? '' : String(b.clave) };
  if (modo === 'probar') {
    if (!credPrueba.usuario || credPrueba.usuario.length > 128) return res.status(400).json({ error: 'Escribe el usuario para la prueba.' });
    if (!credPrueba.clave || credPrueba.clave.length > 256) return res.status(400).json({ error: 'Escribe la clave para la prueba.' });
  }

  const lineas = origenesDb.parsearListaServidores(b.lista);
  if (!lineas.length) return res.status(400).json({ error: 'Pega al menos un servidor (uno por línea).' });
  if (lineas.length > MAX_POR_TANDA) return res.status(400).json({ error: `Máximo ${MAX_POR_TANDA} servidores por tanda.` });

  try {
    const pool = await getPool();
    const { tabla, origenes: existentes } = await origenesDb.listarOrigenesAdmin(pool);
    if (!tabla) return res.status(409).json({ error: 'Falta crear la tabla de orígenes (crear_tabla_catalogo_origenes.sql).' });
    const yaRegistrados = new Set(existentes.filter((o) => o.motor === 'MSSQL').map((o) => origenesDb.claveServidor(o.host, o.puerto)));

    const resultados = lineas.map((l) => ({
      linea: l.linea, texto: l.texto, host: l.host, puerto: l.puerto, nombre: l.nombre,
      estado: l.error ? 'invalida' : (yaRegistrados.has(origenesDb.claveServidor(l.host, l.puerto)) ? 'duplicado' : 'pendiente'),
      mensaje: l.error || (yaRegistrados.has(origenesDb.claveServidor(l.host, l.puerto)) ? 'Ya está registrado como origen.' : null),
    }));
    const porHacer = resultados.filter((r) => r.estado === 'pendiente');
    const opciones = base.valor;
    const origenDe = (r) => ({
      motor: 'MSSQL', nombre: r.nombre, host: r.host, puerto: r.puerto, usuario: credPrueba.usuario, clave: credPrueba.clave,
      cifrado: !!opciones.cifrado, confiarCertificado: opciones.confiarCertificado !== false, basesIncluidas: [],
    });

    let verificada = !!b.verificada;
    let detenido = false;

    if (modo === 'probar') {
      const probarUna = async (r) => {
        const origen = origenDe(r);
        try {
          const p = await probarOrigen(origen);
          r.estado = 'ok'; r.version = p.version || null; r.bases = (p.bases || []).length; r.mensaje = null;
          return { ok: true };
        } catch (error) {
          r.estado = 'error'; r.mensaje = mensajeErrorOrigen(error, origen);
          return { ok: false, login: (error?.code || error?.codigo) === 'ELOGIN' };
        }
      };
      let i = 0;
      let rechazosSeguidos = 0;
      while (!verificada && i < porHacer.length) {
        const r = await probarUna(porHacer[i]);
        i += 1;
        if (r.ok) { verificada = true; break; }
        rechazosSeguidos = r.login ? rechazosSeguidos + 1 : 0;
        if (rechazosSeguidos >= 2) { detenido = true; break; }
      }
      if (detenido) {
        for (let k = i; k < porHacer.length; k += 1) { porHacer[k].estado = 'omitida'; porHacer[k].mensaje = 'Se detuvo para no bloquear la cuenta: revisa el usuario y la clave de red y vuelve a intentar.'; }
      } else {
        const cola = porHacer.slice(i);
        const trabajador = async () => { while (cola.length) { await probarUna(cola.shift()); } };
        await Promise.all(Array.from({ length: Math.min(PARALELO_MASIVO, cola.length) }, trabajador));
      }
      await auditar(req, { entidad: 'Origen del catálogo', entidadId: 'masivo', entidadNombre: 'Carga masiva (prueba)', accion: 'EJECUCION', detalle: `Prueba de ${porHacer.length} servidor(es) con usuario de prueba (no se guarda): ${resultados.filter((r) => r.estado === 'ok').length} con conexión.` });
    } else {
      for (const r of porHacer) {
        try {
          await origenesDb.crearOrigen(pool, req, { nombre: r.nombre, motor: 'MSSQL', host: r.host, puerto: r.puerto, cifrado: !!opciones.cifrado, confiarCertificado: opciones.confiarCertificado !== false, basesIncluidas: [], activo: true });
          r.estado = 'creado'; r.mensaje = null;
          yaRegistrados.add(origenesDb.claveServidor(r.host, r.puerto));
        } catch (error) {
          r.estado = 'error'; r.mensaje = error.status === 409 || /Falta esquema/i.test(error.message) ? error.message : 'No se pudo guardar este servidor.';
        }
      }
      const creados = resultados.filter((r) => r.estado === 'creado').length;
      await auditar(req, { entidad: 'Origen del catálogo', entidadId: 'masivo', entidadNombre: 'Carga masiva', accion: 'CREACION', detalle: `${creados} servidor(es) registrado(s) (sin credenciales: cada persona usa las suyas).` });
    }

    res.json({ modo, resultados, verificada, detenido, dominio: modo === 'probar' && !!parsearUsuarioDominio(credPrueba.usuario) });
  } catch (error) {
    if (/Falta esquema/i.test(error.message)) return res.status(409).json({ error: error.message });
    console.error('Error en la carga masiva de orígenes del catálogo:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error, { contexto: 'la carga masiva de servidores' }) });
  }
});

module.exports = router;
