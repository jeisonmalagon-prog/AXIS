const express = require('express');
const { mensajeErrorAmigable } = require('../utils/mensajesError');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken, requireModule, requireEditPermission } = require('../middlewares/authMiddleware');
const { registrarEventoGeneral, diffCampos } = require('../utils/auditoriaGeneral');
const { compararCodigoAce } = require('../utils/ordenarCodigoAce');
const { esErrorDePrivilegios, columnasFaltantes } = require('../utils/esquemaSeguro');
const { registrar: registrarArchivosServicio, contarArchivosPorServicio } = require('./aceServiciosArchivos');
const { registrar: registrarPeticionesServicio, contarPeticionesPorServicio } = require('./aceServiciosPeticiones');

const ETIQUETAS_CAMPOS = {
  Codigo: 'Código',
  NombreServicio: 'Nombre del servicio',
  UrlDev: 'URL Desarrollo',
  UrlQa: 'URL QA',
  UrlPrd: 'URL Producción',
  Pod: 'Pod',
  Tipo: 'Tipo (SOAP/REST)',
  RequestEjemplo: 'Request de ejemplo',
  UrlDevBus10: 'URL Desarrollo (BUS 10)',
  UrlQaBus10: 'URL QA (BUS 10)',
  UrlPrdBus10: 'URL Producción (BUS 10)',
};
const CAMPOS_AUDITADOS = Object.keys(ETIQUETAS_CAMPOS);
// El request puede ser un XML/JSON largo: en la auditoría solo se deja
// constancia de que cambió y su tamaño, no el contenido completo.
const FORMATEADORES_AUDITORIA = {
  RequestEjemplo: (v) => (v === null || v === undefined || v === '' ? null : `(${String(v).length} caracteres)`),
};
const MAX_REQUEST_CARACTERES = 200000;
const MAX_URL_CARACTERES = 500;
const MAX_FILAS_IMPORTACION = 1000;

// ==========================================================
// Columna Tipo (SOAP / REST)
// ==========================================================
// Un mismo código de servicio puede existir como SOAP y como REST (dos filas
// distintas), así que el inventario se divide por tipo. Los servicios que ya
// estaban cargados son todos SOAP (valor por defecto de la columna).
//
// El usuario de la app en producción puede no tener ALTER: se consulta
// information_schema primero, se intenta crear la columna solo si falta y, si
// no hay privilegios, el módulo sigue funcionando tratando todo como SOAP
// hasta que se ejecute agregar_tipo_servicio_rest_soap.sql con una cuenta con
// privilegios (se vuelve a verificar solo, sin reiniciar el backend).
const TIPOS_SERVICIO = ['SOAP', 'REST'];
const MENSAJE_SIN_TIPO =
  'Para registrar servicios REST falta la columna "Tipo" en la base de datos. ' +
  'Ejecuta una sola vez el script agregar_tipo_servicio_rest_soap.sql con una cuenta con privilegios de ALTER.';
const MENSAJE_SIN_REQUEST =
  'Para guardar el request de un servicio falta la columna "RequestEjemplo" en la base de datos. ' +
  'Ejecuta una sola vez el script agregar_tipo_servicio_rest_soap.sql con una cuenta con privilegios de ALTER.';

// ==========================================================
// BUS 10 (URLs por ambiente)
// ==========================================================
// El inventario nació para el BUS ACE 12. Para el BUS 10 se guardan en la MISMA
// fila las URLs de sus tres ambientes (UrlDevBus10/UrlQaBus10/UrlPrdBus10): el
// código, el nombre, el POD, el tipo y el request de ejemplo se comparten entre
// ambos buses (el request es el mismo para ACE 12 y para BUS 10).
const COLUMNAS_BUS10 = ['UrlDevBus10', 'UrlQaBus10', 'UrlPrdBus10'];
const MENSAJE_SIN_BUS10 =
  'Para registrar URLs del BUS 10 faltan las columnas UrlDevBus10, UrlQaBus10 y UrlPrdBus10 en la base de datos. ' +
  'Ejecuta una sola vez el script agregar_bus10_servicios.sql con una cuenta con privilegios de ALTER.';

// Columnas opcionales que el módulo sabe usar si existen: nombre -> DDL.
const COLUMNAS_OPCIONALES = {
  Tipo: "ADD COLUMN Tipo VARCHAR(10) NOT NULL DEFAULT 'SOAP' AFTER Pod",
  RequestEjemplo: 'ADD COLUMN RequestEjemplo MEDIUMTEXT NULL AFTER UrlPrd',
  UrlDevBus10: 'ADD COLUMN UrlDevBus10 VARCHAR(500) NULL',
  UrlQaBus10: 'ADD COLUMN UrlQaBus10 VARCHAR(500) NULL',
  UrlPrdBus10: 'ADD COLUMN UrlPrdBus10 VARCHAR(500) NULL',
};
const columnasDisponibles = new Set();
let ultimaVerificacionColumnas = 0;

async function verificarColumnas(pool) {
  if (columnasDisponibles.size === Object.keys(COLUMNAS_OPCIONALES).length) return columnasDisponibles;
  // Mientras falte alguna se reintenta como máximo cada 30 s (consulta liviana).
  if (Date.now() - ultimaVerificacionColumnas < 30000) return columnasDisponibles;
  ultimaVerificacionColumnas = Date.now();
  try {
    const nombres = Object.keys(COLUMNAS_OPCIONALES);
    const faltantes = await columnasFaltantes(pool, 'AceServiciosInventario', nombres);
    nombres.filter((n) => !faltantes.includes(n)).forEach((n) => columnasDisponibles.add(n));
    for (const nombre of faltantes) {
      try {
        await pool.query(`ALTER TABLE AceServiciosInventario ${COLUMNAS_OPCIONALES[nombre]}`);
        columnasDisponibles.add(nombre);
      } catch (error) {
        if (esErrorDePrivilegios(error)) {
          console.warn(`AceServiciosInventario.${nombre} no existe y no hay privilegios de ALTER: funciona sin esa columna.`);
        } else {
          console.error(`No se pudo crear AceServiciosInventario.${nombre}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('No se pudo verificar el esquema de AceServiciosInventario:', error.message);
  }
  return columnasDisponibles;
}

function normalizarTipo(valor) {
  const t = String(valor || 'SOAP').trim().toUpperCase();
  return TIPOS_SERVICIO.includes(t) ? t : null;
}

router.use(verifyToken, async (req, res, next) => {
  try {
    const cols = await verificarColumnas(await getPool());
    req.tipoDisponible = cols.has('Tipo');
    req.requestDisponible = cols.has('RequestEjemplo');
    req.bus10Disponible = COLUMNAS_BUS10.every((c) => cols.has(c));
  } catch (_) {
    req.tipoDisponible = false;
    req.requestDisponible = false;
    req.bus10Disponible = false;
  }
  next();
});

// Texto del request: se respeta tal cual (XML/JSON con sus saltos de línea),
// solo se recorta el espacio sobrante en los extremos. Vacío = sin request.
function normalizarRequest(valor) {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor).trim();
  return texto ? texto : null;
}

// Rellena lo que la base aún no tiene para que el frontend vea siempre la misma forma.
function completarFila(req, fila) {
  if (!req.tipoDisponible) fila.Tipo = 'SOAP';
  if (!req.requestDisponible) fila.RequestEjemplo = null;
  if (!req.bus10Disponible) COLUMNAS_BUS10.forEach((c) => { fila[c] = null; });
  return fila;
}

// URLs del BUS 10 que llegan en el cuerpo. undefined = no vino (se conserva lo
// que hay); cadena vacía/null = borrar. Devuelve {valores, error}.
function leerUrlsBus10(body, actual) {
  const valores = {};
  for (const c of COLUMNAS_BUS10) {
    const crudo = body[c];
    if (crudo === undefined) { valores[c] = actual ? actual[c] ?? null : null; continue; }
    const texto = crudo === null ? '' : String(crudo).trim();
    if (texto.length > MAX_URL_CARACTERES) return { error: `Una URL del BUS 10 supera los ${MAX_URL_CARACTERES} caracteres` };
    valores[c] = texto || null;
  }
  return { valores };
}

// ==========================================================
// GET /api/ace-servicios - inventario de servicios (hoja INVENTARIO)
// ==========================================================
// La carga inicial se hizo por SQL (ver
// documentacion/migracion_ace_servicios.sql) a partir de "Inventario
// Servicios ACE12.xlsx"; a partir de aquí el CRUD de abajo permite
// mantenerlo al día desde la propia app.
router.get('/', verifyToken, requireModule('SERVICIOS'), async (req, res) => {
  try {
    const pool = await getPool();
    const [filas] = await pool.query('SELECT * FROM AceServiciosInventario');
    const archivosPorServicio = await contarArchivosPorServicio(pool);
    const peticionesPorServicio = await contarPeticionesPorServicio(pool, req.user.id);
    filas.forEach((f) => { completarFila(req, f); f.NumArchivos = archivosPorServicio.get(f.Id) || 0; f.NumPeticiones = peticionesPorServicio.get(f.Id) || 0; });
    filas.sort((a, b) => compararCodigoAce(a, b, 'NombreServicio'));
    res.json(filas);
  } catch (error) {
    console.error('Error al listar el inventario de servicios:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// POST /api/ace-servicios - crear un servicio del inventario
// ==========================================================
router.post('/', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  const { Codigo, NombreServicio, UrlDev, UrlQa, UrlPrd, Pod } = req.body;

  if (!NombreServicio || !NombreServicio.trim()) {
    return res.status(400).json({ error: 'El nombre del servicio es obligatorio' });
  }
  const Tipo = normalizarTipo(req.body.Tipo);
  if (!Tipo) return res.status(400).json({ error: 'El tipo del servicio debe ser SOAP o REST' });
  if (Tipo === 'REST' && !req.tipoDisponible) return res.status(409).json({ error: MENSAJE_SIN_TIPO });
  const RequestEjemplo = normalizarRequest(req.body.RequestEjemplo);
  if (RequestEjemplo && RequestEjemplo.length > MAX_REQUEST_CARACTERES) {
    return res.status(400).json({ error: `El request es demasiado largo (máximo ${MAX_REQUEST_CARACTERES} caracteres)` });
  }
  if (RequestEjemplo && !req.requestDisponible) return res.status(409).json({ error: MENSAJE_SIN_REQUEST });
  const bus10 = leerUrlsBus10(req.body, null);
  if (bus10.error) return res.status(400).json({ error: bus10.error });
  if (!req.bus10Disponible && COLUMNAS_BUS10.some((c) => bus10.valores[c])) return res.status(409).json({ error: MENSAJE_SIN_BUS10 });

  try {
    const pool = await getPool();
    const [resultado] = await pool.query(
      `INSERT INTO AceServiciosInventario (Codigo, NombreServicio, UrlDev, UrlQa, UrlPrd, Pod${req.tipoDisponible ? ', Tipo' : ''}${req.requestDisponible ? ', RequestEjemplo' : ''}${req.bus10Disponible ? ', ' + COLUMNAS_BUS10.join(', ') : ''}, FechaActualizacion)
       VALUES (?, ?, ?, ?, ?, ?${req.tipoDisponible ? ', ?' : ''}${req.requestDisponible ? ', ?' : ''}${req.bus10Disponible ? ', ?, ?, ?' : ''}, NOW())`,
      [
        Codigo?.trim() || null,
        NombreServicio.trim(),
        UrlDev?.trim() || null,
        UrlQa?.trim() || null,
        UrlPrd?.trim() || null,
        Pod?.trim() || null,
        ...(req.tipoDisponible ? [Tipo] : []),
        ...(req.requestDisponible ? [RequestEjemplo] : []),
        ...(req.bus10Disponible ? COLUMNAS_BUS10.map((c) => bus10.valores[c]) : []),
      ]
    );

    const [filas] = await pool.query('SELECT * FROM AceServiciosInventario WHERE Id = ?', [resultado.insertId]);
    completarFila(req, filas[0]);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVICIOS',
      entidad: 'Servicio ACE',
      entidadId: resultado.insertId,
      entidadNombre: NombreServicio.trim(),
      accion: 'CREACION',
      detalle: `Servicio ${Tipo} creado (código: ${Codigo?.trim() || '—'})`,
    });

    res.status(201).json(filas[0]);
  } catch (error) {
    console.error('Error al crear el servicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// PUT /api/ace-servicios/:id - actualizar un servicio del inventario
// ==========================================================
router.put('/:id', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  const { id } = req.params;
  const { Codigo, NombreServicio, UrlDev, UrlQa, UrlPrd, Pod } = req.body;

  if (!NombreServicio || !NombreServicio.trim()) {
    return res.status(400).json({ error: 'El nombre del servicio es obligatorio' });
  }
  const Tipo = normalizarTipo(req.body.Tipo);
  if (!Tipo) return res.status(400).json({ error: 'El tipo del servicio debe ser SOAP o REST' });
  if (Tipo === 'REST' && !req.tipoDisponible) return res.status(409).json({ error: MENSAJE_SIN_TIPO });
  const RequestEjemplo = normalizarRequest(req.body.RequestEjemplo);
  if (RequestEjemplo && RequestEjemplo.length > MAX_REQUEST_CARACTERES) {
    return res.status(400).json({ error: `El request es demasiado largo (máximo ${MAX_REQUEST_CARACTERES} caracteres)` });
  }
  if (RequestEjemplo && !req.requestDisponible) return res.status(409).json({ error: MENSAJE_SIN_REQUEST });

  try {
    const pool = await getPool();

    const [antesFilas] = await pool.query('SELECT * FROM AceServiciosInventario WHERE Id = ?', [id]);
    if (!antesFilas.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const antes = antesFilas[0];
    completarFila(req, antes);

    const bus10 = leerUrlsBus10(req.body, antes);
    if (bus10.error) return res.status(400).json({ error: bus10.error });
    if (!req.bus10Disponible && COLUMNAS_BUS10.some((c) => bus10.valores[c])) return res.status(409).json({ error: MENSAJE_SIN_BUS10 });

    const nuevoServicio = {
      Codigo: Codigo?.trim() || null,
      NombreServicio: NombreServicio.trim(),
      UrlDev: UrlDev?.trim() || null,
      UrlQa: UrlQa?.trim() || null,
      UrlPrd: UrlPrd?.trim() || null,
      Pod: Pod?.trim() || null,
      Tipo,
      RequestEjemplo,
      ...bus10.valores,
    };

    const [resultado] = await pool.query(
      `UPDATE AceServiciosInventario
       SET Codigo = ?, NombreServicio = ?, UrlDev = ?, UrlQa = ?, UrlPrd = ?, Pod = ?${req.tipoDisponible ? ', Tipo = ?' : ''}${req.requestDisponible ? ', RequestEjemplo = ?' : ''}${req.bus10Disponible ? ', ' + COLUMNAS_BUS10.map((c) => `${c} = ?`).join(', ') : ''}, FechaActualizacion = NOW()
       WHERE Id = ?`,
      [
        nuevoServicio.Codigo,
        nuevoServicio.NombreServicio,
        nuevoServicio.UrlDev,
        nuevoServicio.UrlQa,
        nuevoServicio.UrlPrd,
        nuevoServicio.Pod,
        ...(req.tipoDisponible ? [Tipo] : []),
        ...(req.requestDisponible ? [RequestEjemplo] : []),
        ...(req.bus10Disponible ? COLUMNAS_BUS10.map((c) => bus10.valores[c]) : []),
        id,
      ]
    );

    if (resultado.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    const [filas] = await pool.query('SELECT * FROM AceServiciosInventario WHERE Id = ?', [id]);
    completarFila(req, filas[0]);

    const cambios = diffCampos(antes, nuevoServicio, CAMPOS_AUDITADOS, ETIQUETAS_CAMPOS, FORMATEADORES_AUDITORIA);

    await registrarEventoGeneral(pool, req, {
      modulo: 'SERVICIOS',
      entidad: 'Servicio ACE',
      entidadId: id,
      entidadNombre: nuevoServicio.NombreServicio,
      accion: 'EDICION',
      cambios,
    });

    res.json(filas[0]);
  } catch (error) {
    console.error('Error al actualizar el servicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// POST /api/ace-servicios/importar-bus10 - carga masiva de URLs del BUS 10
// ==========================================================
// Recibe filas {Codigo, NombreServicio, UrlDev, UrlQa, UrlPrd} (las URLs son las
// del BUS 10) y las suma al inventario: si el servicio ya existe (mismo tipo y
// mismo código o, sin código, mismo nombre) solo se completan sus URLs del BUS 10
// —el request y el resto de datos compartidos no se tocan—; si no existe se crea
// una fila nueva. Las URLs vacías de la fila no borran lo que ya hay.
router.post('/importar-bus10', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  if (!req.bus10Disponible) return res.status(409).json({ error: MENSAJE_SIN_BUS10 });

  const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
  if (!filas.length) return res.status(400).json({ error: 'No hay filas para importar' });
  if (filas.length > MAX_FILAS_IMPORTACION) {
    return res.status(400).json({ error: `Máximo ${MAX_FILAS_IMPORTACION} filas por importación` });
  }
  const Tipo = req.tipoDisponible ? normalizarTipo(req.body.Tipo) : 'SOAP';
  if (!Tipo) return res.status(400).json({ error: 'El tipo del servicio debe ser SOAP o REST' });

  const limpio = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
  const clave = (v) => String(v || '').trim().toLowerCase();

  try {
    const pool = await getPool();
    const [existentes] = await pool.query('SELECT * FROM AceServiciosInventario');
    const delTipo = existentes.map((f) => completarFila(req, f)).filter((f) => f.Tipo === Tipo);
    const porCodigo = new Map();
    const porNombre = new Map();
    for (const f of delTipo) {
      if (clave(f.Codigo) && !porCodigo.has(clave(f.Codigo))) porCodigo.set(clave(f.Codigo), f);
      if (clave(f.NombreServicio) && !porNombre.has(clave(f.NombreServicio))) porNombre.set(clave(f.NombreServicio), f);
    }

    const resultado = { creados: 0, actualizados: 0, sinCambios: 0, omitidos: 0, errores: [] };
    for (let i = 0; i < filas.length; i += 1) {
      const fila = filas[i] || {};
      const Codigo = limpio(fila.Codigo);
      const Nombre = limpio(fila.NombreServicio);
      const urls = { UrlDevBus10: limpio(fila.UrlDev), UrlQaBus10: limpio(fila.UrlQa), UrlPrdBus10: limpio(fila.UrlPrd) };
      if ((!Codigo && !Nombre) || !COLUMNAS_BUS10.some((c) => urls[c])) { resultado.omitidos += 1; continue; }
      if (COLUMNAS_BUS10.some((c) => urls[c] && urls[c].length > MAX_URL_CARACTERES)) {
        resultado.errores.push(`Fila ${i + 1}: una URL supera los ${MAX_URL_CARACTERES} caracteres`);
        resultado.omitidos += 1;
        continue;
      }

      const existente = (Codigo && porCodigo.get(clave(Codigo))) || (Nombre && porNombre.get(clave(Nombre))) || null;
      if (existente) {
        const cambios = COLUMNAS_BUS10.filter((c) => urls[c] && urls[c] !== existente[c]);
        if (!cambios.length) { resultado.sinCambios += 1; continue; }
        await pool.query(
          `UPDATE AceServiciosInventario SET ${cambios.map((c) => `${c} = ?`).join(', ')}, FechaActualizacion = NOW() WHERE Id = ?`,
          [...cambios.map((c) => urls[c]), existente.Id]
        );
        cambios.forEach((c) => { existente[c] = urls[c]; });
        resultado.actualizados += 1;
      } else {
        if (!Nombre) {
          resultado.errores.push(`Fila ${i + 1}: el servicio con código ${Codigo} no existe y la fila no trae nombre para crearlo`);
          resultado.omitidos += 1;
          continue;
        }
        const [ins] = await pool.query(
          `INSERT INTO AceServiciosInventario (Codigo, NombreServicio${req.tipoDisponible ? ', Tipo' : ''}, ${COLUMNAS_BUS10.join(', ')}, FechaActualizacion)
           VALUES (?, ?${req.tipoDisponible ? ', ?' : ''}, ?, ?, ?, NOW())`,
          [Codigo, Nombre, ...(req.tipoDisponible ? [Tipo] : []), ...COLUMNAS_BUS10.map((c) => urls[c])]
        );
        const nuevo = { Id: ins.insertId, Codigo, NombreServicio: Nombre, Tipo, ...urls };
        if (Codigo) porCodigo.set(clave(Codigo), nuevo);
        porNombre.set(clave(Nombre), nuevo);
        resultado.creados += 1;
      }
    }

    if (resultado.creados || resultado.actualizados) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVICIOS',
        entidad: 'Servicio ACE',
        entidadId: null,
        entidadNombre: 'Importación BUS 10',
        accion: 'EDICION',
        detalle: `Importación de URLs del BUS 10 (${Tipo}): ${resultado.actualizados} actualizado(s), ${resultado.creados} creado(s)`,
      });
    }

    res.json({ ...resultado, errores: resultado.errores.slice(0, 20) });
  } catch (error) {
    console.error('Error al importar las URLs del BUS 10:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// ==========================================================
// DELETE /api/ace-servicios/:id - eliminar un servicio del inventario
// ==========================================================
router.delete('/:id', verifyToken, requireModule('SERVICIOS'), requireEditPermission, async (req, res) => {
  try {
    const pool = await getPool();
    const [antesFilas] = await pool.query('SELECT * FROM AceServiciosInventario WHERE Id = ?', [req.params.id]);
    const servicioBorrado = antesFilas[0] || null;

    const [resultado] = await pool.query('DELETE FROM AceServiciosInventario WHERE Id = ?', [req.params.id]);

    if (resultado.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    if (servicioBorrado) {
      await registrarEventoGeneral(pool, req, {
        modulo: 'SERVICIOS',
        entidad: 'Servicio ACE',
        entidadId: req.params.id,
        entidadNombre: servicioBorrado.NombreServicio,
        accion: 'ELIMINACION',
        detalle: `Servicio eliminado (código: ${servicioBorrado.Codigo || '—'})`,
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error al eliminar el servicio:', error);
    res.status(500).json({ error: mensajeErrorAmigable(error) });
  }
});

// Archivos de consumo por servicio (proyecto XML de SoapUI / colección REST): /:id/archivos
registrarArchivosServicio(router, { getPool });
registrarPeticionesServicio(router, { getPool });

// Probar servicio: ejecuta peticiones SOAP/REST desde AXIS (POST /:id/consumir).
require('./aceServiciosConsumo').registrar(router, { getPool });

module.exports = router;
