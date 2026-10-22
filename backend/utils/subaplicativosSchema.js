// Inventario de Sub-aplicativos — esquema y sincronización.
//
// El inventario de sub-aplicativos toma como FUENTE los componentes
// registrados en la pantalla Aplicaciones (tabla Servidor_Componentes: un
// contenedor/sitio/servicio con su puerto dentro de un servidor) y los
// enriquece con una ficha técnica de detalle. Esa ficha vive en la tabla
// inv_aplicativos que ya existía (la usan Impacto, pasos de producción,
// reportes y las vistas de PowerBI), así que NO se crea una tabla paralela:
// solo se le agrega la columna `componente_id` (el vínculo con el componente)
// y unos pocos campos técnicos nuevos.
//
// Como en el resto del proyecto, todo se garantiza en tiempo de ejecución
// (ALTER ... ADD COLUMN IF NOT EXISTS), sin scripts SQL manuales.
//
// Después de garantizar las columnas se corre una sincronización IDEMPOTENTE
// que enlaza los sub-aplicativos que ya existían en el inventario de
// servidores (filas de Aplicaciones con ServidorId + inv_aplicativos) con su
// componente: primero por servidor + puerto, luego por nombre normalizado, y
// si no hay coincidencia se crea el componente. Volver a correrla no duplica
// nada: solo toca filas que todavía no tienen componente_id.

const {
  esErrorDePrivilegios, columnasFaltantes, indiceExiste, errorFaltaEsquema,
} = require('./esquemaSeguro');

let promesaEsquema = null;

// "container_ms_usuarios", "DotNet-MS_Usuarios", "ms_usuarios.service" →
// "ms_usuarios" — el mismo componente suele escribirse distinto en el
// inventario viejo y en la pantalla Aplicaciones.
function normalizarNombre(nombre) {
  return String(nombre || '')
    .trim()
    .toLowerCase()
    .replace(/\.service$/, '')
    .replace(/^container[_\-\s]+/, '')
    .replace(/^dotnet[_\-\s]+/, '')
    .replace(/[\s\-]+/g, '_');
}

// Aplicacion_Servidor.Descripcion sigue siendo una lista de roles separada
// por comas, derivada de los componentes (el módulo de Impacto y el catálogo
// de opciones de integración todavía la leen con SQL crudo).
async function reconstruirDescripcionServidor(pool, aplicacionId, servidorId) {
  const [roles] = await pool.query(
    `SELECT sc.Rol
       FROM Aplicacion_Componente ac
       JOIN Servidor_Componentes sc ON sc.Id = ac.ComponenteId
      WHERE ac.AplicacionId = ? AND sc.ServidorId = ?
      ORDER BY sc.Rol`,
    [aplicacionId, servidorId]
  );
  const descripcion = roles.map((r) => r.Rol).join(', ');

  const [existente] = await pool.query(
    'SELECT 1 FROM Aplicacion_Servidor WHERE AplicacionId = ? AND ServidorId = ? LIMIT 1',
    [aplicacionId, servidorId]
  );

  if (roles.length === 0) {
    // Sin componentes de esa aplicación en ese servidor: el vínculo
    // aplicación↔servidor deja de tener sentido.
    if (existente.length) {
      await pool.query(
        'DELETE FROM Aplicacion_Servidor WHERE AplicacionId = ? AND ServidorId = ?',
        [aplicacionId, servidorId]
      );
    }
    return;
  }

  if (existente.length) {
    await pool.query(
      'UPDATE Aplicacion_Servidor SET Descripcion = ? WHERE AplicacionId = ? AND ServidorId = ?',
      [descripcion, aplicacionId, servidorId]
    );
  } else {
    await pool.query(
      'INSERT INTO Aplicacion_Servidor (AplicacionId, ServidorId, Descripcion) VALUES (?, ?, ?)',
      [aplicacionId, servidorId, descripcion]
    );
  }
}

async function garantizarColumnas(pool) {
  // Solo se ejecuta DDL si falta algo (el usuario de BD puede no tener
  // ALTER/INDEX); ver utils/esquemaSeguro.js.
  const faltan = await columnasFaltantes(pool, 'inv_aplicativos', [
    'componente_id', 'estado', 'version_imagen', 'repositorio_url', 'pipeline_url', 'url_salud',
  ]);
  if (faltan.length) {
    try {
      await pool.query(`
        ALTER TABLE inv_aplicativos
          ADD COLUMN IF NOT EXISTS componente_id INT NULL,
          ADD COLUMN IF NOT EXISTS estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
          ADD COLUMN IF NOT EXISTS version_imagen VARCHAR(255) NULL,
          ADD COLUMN IF NOT EXISTS repositorio_url VARCHAR(500) NULL,
          ADD COLUMN IF NOT EXISTS pipeline_url VARCHAR(500) NULL,
          ADD COLUMN IF NOT EXISTS url_salud VARCHAR(500) NULL
      `);
    } catch (err) {
      if (esErrorDePrivilegios(err)) throw errorFaltaEsquema(`inv_aplicativos: faltan columnas ${faltan.join(', ')}`, err);
      throw err;
    }
  }
  // Un componente tiene como máximo una ficha. Varios NULL no chocan entre sí.
  if (!(await indiceExiste(pool, 'inv_aplicativos', 'uq_inv_aplicativos_componente'))) {
    try {
      await pool.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_aplicativos_componente ON inv_aplicativos (componente_id)'
      );
    } catch (err) {
      if (esErrorDePrivilegios(err)) throw errorFaltaEsquema('inv_aplicativos: falta el índice uq_inv_aplicativos_componente', err);
      throw err;
    }
  }
}

async function sincronizarLegacy(pool) {
  // Sub-aplicativos del inventario viejo que todavía no tienen componente.
  const [pendientes] = await pool.query(`
    SELECT ap.Id AS aplicacion_id, ap.Nombre AS nombre, ap.ServidorId AS servidor_id,
           ia.id AS inv_id, ia.puerto, ia.aplicacion_negocio_id
      FROM Aplicaciones ap
      LEFT JOIN inv_aplicativos ia ON ia.aplicacion_id = ap.Id
     WHERE ap.ServidorId IS NOT NULL
       AND (ia.id IS NULL OR ia.componente_id IS NULL)
     ORDER BY ap.Id
  `);
  if (pendientes.length === 0) return;

  const [componentes] = await pool.query(
    'SELECT Id, ServidorId, Rol, Puerto FROM Servidor_Componentes'
  );
  const [yaUsados] = await pool.query(
    'SELECT componente_id FROM inv_aplicativos WHERE componente_id IS NOT NULL'
  );
  const usados = new Set(yaUsados.map((f) => f.componente_id));

  const resumen = { porPuerto: 0, porNombre: 0, creados: 0, fallidos: 0 };

  for (const app of pendientes) {
    try {
      const delServidor = componentes.filter((c) => c.ServidorId === app.servidor_id);
      const puertoApp = app.puerto !== null && app.puerto !== undefined && app.puerto !== ''
        ? Number(app.puerto) : null;
      let componente = null;

      // 1) Mismo servidor + mismo puerto (el primero en reclamarlo gana: en un
      //    mismo servidor pueden existir dos fichas viejas con el mismo puerto).
      if (puertoApp) {
        componente = delServidor.find((c) => c.Puerto === puertoApp && !usados.has(c.Id)) || null;
        if (componente) resumen.porPuerto++;
      }

      // 2) Mismo servidor + nombre normalizado.
      if (!componente) {
        const nombreNorm = normalizarNombre(app.nombre);
        componente = delServidor.find(
          (c) => !usados.has(c.Id) && normalizarNombre(c.Rol) === nombreNorm
        ) || null;
        if (componente) resumen.porNombre++;
      }

      // 3) Crear el componente.
      if (!componente) {
        let rol = String(app.nombre).trim().slice(0, 150);
        let sufijo = 1;
        while (delServidor.some((c) => c.Rol.toLowerCase() === rol.toLowerCase())) {
          sufijo++;
          rol = `${String(app.nombre).trim().slice(0, 140)} (${sufijo})`;
        }
        const puertoLibre = puertoApp && !delServidor.some((c) => c.Puerto === puertoApp)
          ? puertoApp : null;
        const [ins] = await pool.query(
          'INSERT INTO Servidor_Componentes (ServidorId, Rol, Puerto) VALUES (?, ?, ?)',
          [app.servidor_id, rol, puertoLibre]
        );
        componente = { Id: ins.insertId, ServidorId: app.servidor_id, Rol: rol, Puerto: puertoLibre };
        componentes.push(componente);
        resumen.creados++;
      }

      usados.add(componente.Id);

      if (app.inv_id) {
        await pool.query('UPDATE inv_aplicativos SET componente_id = ? WHERE id = ?', [componente.Id, app.inv_id]);
      } else {
        await pool.query(
          'INSERT INTO inv_aplicativos (aplicacion_id, componente_id) VALUES (?, ?)',
          [app.aplicacion_id, componente.Id]
        );
      }

      // Si la ficha vieja ya tenía "Aplicación de negocio" y el componente no
      // pertenece a ninguna, se respeta esa relación.
      if (app.aplicacion_negocio_id) {
        const [links] = await pool.query(
          'SELECT 1 FROM Aplicacion_Componente WHERE ComponenteId = ? LIMIT 1',
          [componente.Id]
        );
        if (links.length === 0) {
          await pool.query(
            'INSERT IGNORE INTO Aplicacion_Componente (AplicacionId, ComponenteId) VALUES (?, ?)',
            [app.aplicacion_negocio_id, componente.Id]
          );
          await reconstruirDescripcionServidor(pool, app.aplicacion_negocio_id, app.servidor_id);
        }
      }
    } catch (err) {
      resumen.fallidos++;
      console.error(`[subaplicativos] No se pudo sincronizar "${app.nombre}" (Aplicaciones.Id ${app.aplicacion_id}):`, err.message);
    }
  }

  console.log(
    `[subaplicativos] Sincronización del inventario: ${pendientes.length} fichas revisadas → ` +
    `${resumen.porPuerto} por puerto, ${resumen.porNombre} por nombre, ${resumen.creados} componentes nuevos, ${resumen.fallidos} con error.`
  );
}

// Crea (si no existe) la fila Aplicaciones(ServidorId) + inv_aplicativos que
// sirve de "ficha" del componente, y devuelve el Aplicaciones.Id (aplicacionId).
// Se comparte entre el inventario de sub-aplicativos y Pasos a Producción:
// PasosProduccion.AplicativoId es una FK a Aplicaciones(Id) de la ficha.
async function asegurarFicha(conn, componenteId, servidorId, nombre) {
  const [existente] = await conn.query(
    'SELECT id, aplicacion_id FROM inv_aplicativos WHERE componente_id = ?',
    [componenteId]
  );
  if (existente.length) return { aplicacionId: existente[0].aplicacion_id, invId: existente[0].id };

  const [insApp] = await conn.query(
    'INSERT INTO Aplicaciones (Nombre, ServidorId, Activo) VALUES (?, ?, 1)',
    [nombre, servidorId]
  );
  const [insInv] = await conn.query(
    'INSERT INTO inv_aplicativos (aplicacion_id, componente_id) VALUES (?, ?)',
    [insApp.insertId, componenteId]
  );
  return { aplicacionId: insApp.insertId, invId: insInv.insertId };
}

// Punto de entrada: se llama al inicio de cada request del router; el trabajo
// real solo ocurre una vez por proceso (o hasta que falle).
function garantizarEsquemaSubaplicativos(pool) {
  if (!promesaEsquema) {
    promesaEsquema = (async () => {
      await garantizarColumnas(pool);
      await sincronizarLegacy(pool);
    })().catch((err) => {
      promesaEsquema = null; // permite reintentar en el siguiente request
      throw err;
    });
  }
  return promesaEsquema;
}

module.exports = {
  garantizarEsquemaSubaplicativos,
  reconstruirDescripcionServidor,
  asegurarFicha,
  normalizarNombre,
};
