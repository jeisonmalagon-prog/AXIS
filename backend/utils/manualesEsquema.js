// Tablas del módulo MANUALES (libretas > secciones > páginas, más el historial
// de versiones de cada página). Nada se borra nunca: «eliminar» marca Activo = 0,
// porque el usuario de BD de producción no tiene DELETE.
//
// Mismo criterio que el resto de módulos: primero se consulta information_schema
// (solo requiere SELECT); si faltan tablas se intentan crear, y si el usuario no
// tiene privilegios de DDL el módulo responde con un mensaje claro pidiendo
// ejecutar «crear_tablas_manuales.sql» (carpeta Claude outputs) una sola vez.

const { esErrorDePrivilegios, tablaExiste } = require('./esquemaSeguro');

const TABLAS = ['manuales_libretas', 'manuales_secciones', 'manuales_paginas', 'manuales_versiones', 'manuales_comparticiones'];

const OPCIONES = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

const DDL = [
  `CREATE TABLE IF NOT EXISTS manuales_libretas (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    Nombre VARCHAR(150) NOT NULL,
    Descripcion VARCHAR(500) NULL,
    Orden INT NOT NULL DEFAULT 0,
    Activo TINYINT(1) NOT NULL DEFAULT 1,
    CreadoPor VARCHAR(100) NULL,
    FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_manuales_libretas_activo (Activo, Orden)
  ) ${OPCIONES}`,
  `CREATE TABLE IF NOT EXISTS manuales_secciones (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    LibretaId INT NOT NULL,
    Nombre VARCHAR(150) NOT NULL,
    Color VARCHAR(9) NULL,
    Orden INT NOT NULL DEFAULT 0,
    Activo TINYINT(1) NOT NULL DEFAULT 1,
    CreadoPor VARCHAR(100) NULL,
    FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_manuales_secciones_libreta (LibretaId, Activo, Orden),
    CONSTRAINT fk_manuales_secciones_libreta FOREIGN KEY (LibretaId) REFERENCES manuales_libretas(Id)
  ) ${OPCIONES}`,
  `CREATE TABLE IF NOT EXISTS manuales_paginas (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    SeccionId INT NOT NULL,
    Titulo VARCHAR(255) NOT NULL,
    Tipo VARCHAR(10) NOT NULL DEFAULT 'RICO',
    ContenidoHtml MEDIUMTEXT NULL,
    ContenidoTexto MEDIUMTEXT NULL,
    ArchivoNombre VARCHAR(255) NULL,
    ArchivoMime VARCHAR(100) NULL,
    ArchivoTamano INT NULL,
    ArchivoDatos LONGBLOB NULL,
    FechaOrigen DATETIME NULL,
    Orden INT NOT NULL DEFAULT 0,
    Version INT NOT NULL DEFAULT 1,
    Activo TINYINT(1) NOT NULL DEFAULT 1,
    CreadoPor VARCHAR(100) NULL,
    FechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ActualizadoPor VARCHAR(100) NULL,
    FechaActualizacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_manuales_paginas_seccion (SeccionId, Activo, Orden),
    INDEX idx_manuales_paginas_titulo (Titulo),
    CONSTRAINT fk_manuales_paginas_seccion FOREIGN KEY (SeccionId) REFERENCES manuales_secciones(Id)
  ) ${OPCIONES}`,
  `CREATE TABLE IF NOT EXISTS manuales_versiones (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    PaginaId INT NOT NULL,
    Titulo VARCHAR(255) NOT NULL,
    ContenidoHtml MEDIUMTEXT NULL,
    GuardadoPor VARCHAR(100) NULL,
    FechaGuardado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_manuales_versiones_pagina (PaginaId, FechaGuardado),
    CONSTRAINT fk_manuales_versiones_pagina FOREIGN KEY (PaginaId) REFERENCES manuales_paginas(Id)
  ) ${OPCIONES}`,
  // Cada libreta es de quien la creó; solo la ven otras personas si su dueño la comparte y ellas aceptan.
  `CREATE TABLE IF NOT EXISTS manuales_comparticiones (
    Id INT AUTO_INCREMENT PRIMARY KEY,
    LibretaId INT NOT NULL,
    Propietario VARCHAR(100) NOT NULL,
    Destinatario VARCHAR(100) NOT NULL,
    Permiso VARCHAR(10) NOT NULL DEFAULT 'LECTURA',
    Estado VARCHAR(10) NOT NULL DEFAULT 'PENDIENTE',
    FechaSolicitud DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FechaRespuesta DATETIME NULL,
    UNIQUE KEY uq_manuales_comp (LibretaId, Destinatario),
    INDEX idx_manuales_comp_dest (Destinatario, Estado),
    CONSTRAINT fk_manuales_comp_libreta FOREIGN KEY (LibretaId) REFERENCES manuales_libretas(Id)
  ) ${OPCIONES}`,
];

const MENSAJE_FALTA_ESQUEMA =
  'El módulo Manuales todavía no tiene sus tablas en la base de datos. Pídele al administrador de base de datos ' +
  'que ejecute una sola vez los scripts crear_tablas_manuales.sql y crear_tablas_notificaciones_y_comparticion_manuales.sql (carpeta «Claude outputs»).';

let listo = false;
let proximoIntento = 0;

async function asegurarEsquemaManuales(pool) {
  if (listo) return { ok: true };
  const faltan = [];
  for (const t of TABLAS) if (!(await tablaExiste(pool, t))) faltan.push(t);
  if (!faltan.length) { listo = true; return { ok: true }; }
  if (Date.now() < proximoIntento) return { ok: false, mensaje: MENSAJE_FALTA_ESQUEMA };
  try {
    for (const ddl of DDL) await pool.query(ddl);
    listo = true;
    return { ok: true };
  } catch (err) {
    if (esErrorDePrivilegios(err)) {
      proximoIntento = Date.now() + 60000;
      return { ok: false, mensaje: MENSAJE_FALTA_ESQUEMA };
    }
    throw err;
  }
}

module.exports = { asegurarEsquemaManuales, DDL, TABLAS };
