-- =====================================================================
-- AXIS · BIC_CERTI_MARIA · DESARROLLO (192.168.79.158)
-- Deja el módulo de certificados de DEV igual a PRODUCCIÓN: aplica en orden
-- 01 migración + 03 fechas + 04 cobertura + 05 presencia/uso.
-- Diferencias con los scripts de producción:
--   * Sin CREATE USER ni GRANT (en DEV no existen n8n_axis / axis_scan_ro).
--   * 02 (rollback) no se incluye.
-- Es re-ejecutable: tablas/columnas con IF NOT EXISTS y objetos con
-- CREATE OR REPLACE / DROP IF EXISTS.
-- Ejecutar completo como script (DBeaver: Alt+X) con un usuario con permisos
-- de ALTER, CREATE, CREATE ROUTINE y CREATE VIEW sobre BIC_CERTI_MARIA.
-- =====================================================================
SET NAMES utf8mb4;
USE `BIC_CERTI_MARIA`;


-- #####################################################################
-- 01_migracion_descubrimiento_certificados.sql
-- #####################################################################
-- =====================================================================
-- AXIS · BIC_CERTI_MARIA
-- Descubrimiento automático de certificados (n8n + colectores)
-- Ejecutar con el cliente mariadb o HeidiSQL (usa DELIMITER).
-- Compatible con lo que AXIS ya usa: no elimina columnas ni filas.
-- =====================================================================
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- 1. Columnas nuevas en Certificados
-- ---------------------------------------------------------------------
ALTER TABLE `Certificados`
  ADD COLUMN IF NOT EXISTS `Origen` varchar(20) DEFAULT NULL
      COMMENT 'SCAN_RED | PORTAINER | WINDOWS | PM2 | NULL = carga anterior/manual',
  ADD COLUMN IF NOT EXISTS `FechaUltimaDeteccion` datetime DEFAULT NULL
      COMMENT 'Última vez que un colector vio el certificado en esta ubicación',
  ADD COLUMN IF NOT EXISTS `ThumbprintNorm` varchar(64)
      AS (UPPER(REPLACE(REPLACE(`Thumbprint`, ':', ''), ' ', ''))) PERSISTENT;

ALTER TABLE `Certificados`
  ADD INDEX IF NOT EXISTS `IX_Certificados_Servidor_Thumb` (`ServidorId`, `ThumbprintNorm`);

-- ---------------------------------------------------------------------
-- 2. Relación N:N Certificado ↔ Aplicación (elimina la necesidad de
--    duplicar la ubicación por cada aplicación de negocio)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `Certificado_Aplicacion` (
  `CertificadoId` int(11) NOT NULL,
  `AplicacionId`  int(11) NOT NULL,
  `Origen`        varchar(20) NOT NULL DEFAULT 'MANUAL',
  `FechaRegistro` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`CertificadoId`, `AplicacionId`),
  KEY `FK_CertApp_Aplicacion` (`AplicacionId`),
  CONSTRAINT `FK_CertApp_Certificado` FOREIGN KEY (`CertificadoId`) REFERENCES `Certificados` (`Id`) ON DELETE CASCADE,
  CONSTRAINT `FK_CertApp_Aplicacion`  FOREIGN KEY (`AplicacionId`)  REFERENCES `Aplicaciones` (`Id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- Backfill: cada fila duplicada por aplicación aporta su relación a TODAS
-- las filas equivalentes (mismo servidor + thumbprint + componente)
INSERT IGNORE INTO `Certificado_Aplicacion` (`CertificadoId`, `AplicacionId`, `Origen`)
SELECT c2.`Id`, c1.`AplicacionId`, 'MIGRACION'
  FROM `Certificados` c1
  JOIN `Certificados` c2
    ON c2.`ServidorId` = c1.`ServidorId`
   AND c2.`ThumbprintNorm` = c1.`ThumbprintNorm`
   AND COALESCE(c2.`Componente`, '') = COALESCE(c1.`Componente`, '')
 WHERE c1.`AplicacionId` IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. Tablas de recepción (staging) de los colectores
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `CertificadosLotes` (
  `Id`             int(11) NOT NULL AUTO_INCREMENT,
  `Referencia`     varchar(80) DEFAULT NULL,
  `Origen`         varchar(20) DEFAULT NULL,
  `Total`          int(11) DEFAULT NULL,
  `FechaRecepcion` datetime NOT NULL DEFAULT current_timestamp(),
  `FechaProceso`   datetime DEFAULT NULL,
  `Resumen`        varchar(1000) DEFAULT NULL,
  `DesactivarAusentes` tinyint(1) NOT NULL DEFAULT 0
      COMMENT '1 = inventario completo de Windows: desactiva lo que ya no está instalado',
  `MaxDesactivarPct` int(11) NOT NULL DEFAULT 50
      COMMENT 'Protección: si un servidor perdería más de este % de ubicaciones activas, no se desactiva nada en él',
  PRIMARY KEY (`Id`),
  KEY `IX_Lotes_Fecha` (`FechaRecepcion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS `CertificadosDeteccion` (
  `Id`              bigint(20) NOT NULL AUTO_INCREMENT,
  `LoteId`          int(11) NOT NULL,
  `Origen`          varchar(20) DEFAULT NULL,
  `IP`              varchar(45) DEFAULT NULL,
  `Hostname`        varchar(100) DEFAULT NULL,
  `Componente`      varchar(150) DEFAULT NULL,
  `Puerto`          int(11) DEFAULT NULL,
  `Almacen`         varchar(80) DEFAULT NULL,
  `NombreComun`     varchar(150) DEFAULT NULL,
  `SAN`             varchar(1000) DEFAULT NULL,
  `EntidadEmisora`  varchar(150) DEFAULT NULL,
  `NumeroSerie`     varchar(100) DEFAULT NULL,
  `Thumbprint`      varchar(100) DEFAULT NULL,
  `ThumbprintNorm`  varchar(64) DEFAULT NULL,
  `FechaInicio`     date DEFAULT NULL,
  `FechaFin`        date DEFAULT NULL,
  `Detalle`         varchar(500) DEFAULT NULL,
  `ServidorId`      int(11) DEFAULT NULL,
  `ComponenteId`    int(11) DEFAULT NULL,
  `ComponenteFinal` varchar(150) DEFAULT NULL,
  `EsGenerico`      tinyint(1) NOT NULL DEFAULT 0,
  `CertificadoId`   int(11) DEFAULT NULL,
  `Estado`          varchar(30) NOT NULL DEFAULT 'PENDIENTE',
  `Mensaje`         varchar(300) DEFAULT NULL,
  `FechaDeteccion`  datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`Id`),
  KEY `IX_Deteccion_Lote_Estado` (`LoteId`, `Estado`),
  KEY `IX_Deteccion_Serv_Thumb` (`ServidorId`, `ThumbprintNorm`),
  CONSTRAINT `FK_Deteccion_Lote` FOREIGN KEY (`LoteId`) REFERENCES `CertificadosLotes` (`Id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- ---------------------------------------------------------------------
-- 4. Procedimientos
-- ---------------------------------------------------------------------
DELIMITER $$

DROP PROCEDURE IF EXISTS `sp__CertTocarExactos` $$
CREATE PROCEDURE `sp__CertTocarExactos`(IN p_lote INT)
BEGIN
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_match AS
  SELECT d.Id AS DetId, c.Id AS CertId
    FROM CertificadosDeteccion d
    JOIN Certificados c
      ON c.ServidorId = d.ServidorId
     AND c.ThumbprintNorm = d.ThumbprintNorm
     AND c.Componente = d.ComponenteFinal
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE';

  -- El thumbprint identifica el certificado: si AXIS tiene otras fechas/serie, se corrigen
  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Fechas corregidas según el certificado detectado por ', d.Origen,
                     ' (', c.ThumbprintNorm, ')'), 500)
    FROM tmp_cert_match m
    JOIN Certificados c ON c.Id = m.CertId
    JOIN CertificadosDeteccion d ON d.Id = m.DetId
   WHERE c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio);

  UPDATE Certificados c
    JOIN tmp_cert_match m ON m.CertId = c.Id
    JOIN CertificadosDeteccion d ON d.Id = m.DetId
     SET c.FechaUltimaActualizacion = IF(c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio), NOW(), c.FechaUltimaActualizacion),
         c.FechaFin = d.FechaFin,
         c.FechaInicio = d.FechaInicio,
         c.NumeroSerie = COALESCE(d.NumeroSerie, c.NumeroSerie),
         c.EntidadEmisora = COALESCE(d.EntidadEmisora, c.EntidadEmisora),
         c.FechaUltimaDeteccion = NOW(),
         c.Origen = d.Origen,
         c.Puerto = COALESCE(c.Puerto, d.Puerto),
         c.Activo = 1;

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_match GROUP BY DetId) m ON m.DetId = d.Id
     SET d.Estado = 'ACTUALIZADO', d.CertificadoId = m.CertId;

  DROP TEMPORARY TABLE IF EXISTS tmp_cert_match;
END $$

DROP PROCEDURE IF EXISTS `sp_ProcesarDetecciones` $$
CREATE PROCEDURE `sp_ProcesarDetecciones`(IN p_lote INT)
BEGIN
  DECLARE v_max_id INT DEFAULT 0;

  -- 1. Normalizar y validar ------------------------------------------
  UPDATE CertificadosDeteccion
     SET ThumbprintNorm = UPPER(REPLACE(REPLACE(REPLACE(Thumbprint, ':', ''), ' ', ''), '-', '')),
         IP         = NULLIF(TRIM(IP), ''),
         Hostname   = NULLIF(UPPER(SUBSTRING_INDEX(TRIM(Hostname), '.', 1)), ''),
         Componente = NULLIF(TRIM(Componente), ''),
         Almacen    = NULLIF(TRIM(Almacen), ''),
         FechaInicio = IF(FechaInicio >= FechaFin, NULL, FechaInicio)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE';

  UPDATE CertificadosDeteccion
     SET Estado = 'RECHAZADO', Mensaje = 'Thumbprint inválido o sin fecha de vencimiento'
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE'
     AND (ThumbprintNorm IS NULL OR LENGTH(ThumbprintNorm) <> 40 OR FechaFin IS NULL);

  -- 2. Resolver servidor (IP y luego hostname) ------------------------
  UPDATE CertificadosDeteccion d
    JOIN Servidores s ON s.IP = d.IP
     SET d.ServidorId = s.Id
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE';

  UPDATE CertificadosDeteccion d
    JOIN Servidores s ON UPPER(s.Hostname) = d.Hostname
     SET d.ServidorId = s.Id
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.ServidorId IS NULL;

  UPDATE CertificadosDeteccion
     SET Estado = 'SERVIDOR_NO_REGISTRADO',
         Mensaje = LEFT(CONCAT('No existe en Servidores: ', COALESCE(IP, ''), ' ', COALESCE(Hostname, '')), 300)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND ServidorId IS NULL;

  -- 3. Resolver componente --------------------------------------------
  -- 3a. Nombre reportado = sub-aplicativo registrado
  UPDATE CertificadosDeteccion d
    JOIN Servidor_Componentes sc ON sc.ServidorId = d.ServidorId AND sc.Rol = d.Componente
     SET d.ComponenteId = sc.Id, d.ComponenteFinal = sc.Rol
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.Componente IS NOT NULL;

  UPDATE CertificadosDeteccion
     SET ComponenteFinal = LEFT(Componente, 150)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND Componente IS NOT NULL AND ComponenteFinal IS NULL;

  -- 3b. Sin nombre: sub-aplicativo por puerto
  UPDATE CertificadosDeteccion d
    JOIN Servidor_Componentes sc ON sc.ServidorId = d.ServidorId AND sc.Puerto = d.Puerto
     SET d.ComponenteId = sc.Id, d.ComponenteFinal = sc.Rol
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.ComponenteFinal IS NULL AND d.Puerto IS NOT NULL;

  -- 3c. Puerto sin sub-aplicativo registrado
  UPDATE CertificadosDeteccion
     SET ComponenteFinal = CONCAT('PUERTO ', Puerto)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND ComponenteFinal IS NULL AND Puerto IS NOT NULL;

  -- 3d. Solo presente en almacén (convención AXIS)
  UPDATE CertificadosDeteccion
     SET EsGenerico = 1,
         ComponenteFinal = IF(Almacen LIKE '%Root%', 'ALMACEN ROOT', 'SIN COMPONENTE IDENTIFICADO')
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND ComponenteFinal IS NULL;

  -- 3e. Duplicados dentro del mismo lote
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_keep AS
  SELECT MIN(Id) AS KeepId, ServidorId, ThumbprintNorm, ComponenteFinal
    FROM CertificadosDeteccion
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE'
   GROUP BY ServidorId, ThumbprintNorm, ComponenteFinal
  HAVING COUNT(*) > 1;

  UPDATE CertificadosDeteccion d
    JOIN tmp_cert_keep k
      ON k.ServidorId = d.ServidorId AND k.ThumbprintNorm = d.ThumbprintNorm AND k.ComponenteFinal = d.ComponenteFinal
     SET d.Estado = 'DUPLICADO_LOTE'
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.Id <> k.KeepId;

  -- 4. Ubicaciones ya conocidas: solo marcar detección ------------------
  CALL sp__CertTocarExactos(p_lote);

  -- 5. Identificar componente en filas genéricas existentes --------------
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_upg (
    CertId INT, DetId BIGINT, CompAnterior VARCHAR(150), CompNuevo VARCHAR(150),
    Origen VARCHAR(20), Puerto INT, ComponenteId INT
  ) DEFAULT CHARSET=utf8mb4;

  -- 5a. "SIN COMPONENTE IDENTIFICADO" -> primer uso real detectado
  INSERT INTO tmp_cert_upg
  SELECT c.Id, d.Id, c.Componente, d.ComponenteFinal, d.Origen, d.Puerto, d.ComponenteId
    FROM Certificados c
    JOIN (SELECT ServidorId, ThumbprintNorm, MIN(Id) AS DetId
            FROM CertificadosDeteccion
           WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND EsGenerico = 0
           GROUP BY ServidorId, ThumbprintNorm) p
      ON p.ServidorId = c.ServidorId AND p.ThumbprintNorm = c.ThumbprintNorm
    JOIN CertificadosDeteccion d ON d.Id = p.DetId
   WHERE c.Componente IS NULL OR c.Componente = '' OR c.Componente = 'SIN COMPONENTE IDENTIFICADO';

  -- 5b. "PUERTO n" -> nombre real del mismo puerto (IIS, contenedor, PM2)
  INSERT INTO tmp_cert_upg
  SELECT c.Id, d.Id, c.Componente, d.ComponenteFinal, d.Origen, d.Puerto, d.ComponenteId
    FROM Certificados c
    JOIN (SELECT ServidorId, ThumbprintNorm, Puerto, MIN(Id) AS DetId
            FROM CertificadosDeteccion
           WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND EsGenerico = 0
             AND Puerto IS NOT NULL AND ComponenteFinal NOT LIKE 'PUERTO %'
           GROUP BY ServidorId, ThumbprintNorm, Puerto) p
      ON p.ServidorId = c.ServidorId AND p.ThumbprintNorm = c.ThumbprintNorm AND p.Puerto = c.Puerto
    JOIN CertificadosDeteccion d ON d.Id = p.DetId
   WHERE c.Componente LIKE 'PUERTO %';

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, c.FechaInicio, c.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Componente identificado por ', u.Origen, ': ', COALESCE(NULLIF(u.CompAnterior, ''), '(vacío)'), ' -> ', u.CompNuevo), 500)
    FROM tmp_cert_upg u JOIN Certificados c ON c.Id = u.CertId;

  UPDATE Certificados c
    JOIN tmp_cert_upg u ON u.CertId = c.Id
     SET c.Componente = u.CompNuevo,
         c.Puerto = COALESCE(c.Puerto, u.Puerto),
         c.Origen = u.Origen,
         c.FechaUltimaDeteccion = NOW(),
         c.FechaUltimaActualizacion = NOW(),
         c.Activo = 1;

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_upg GROUP BY DetId) u ON u.DetId = d.Id
     SET d.Estado = 'COMPONENTE_IDENTIFICADO', d.CertificadoId = u.CertId
   WHERE d.Estado = 'PENDIENTE';

  CALL sp__CertTocarExactos(p_lote);

  -- 6. Renovación: mismo servidor + componente (o puerto) + nombre común,
  --    thumbprint nuevo y más vigente, y el anterior ya no aparece -------
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_ren AS
  SELECT c.Id AS CertId, MIN(d.Id) AS DetId
    FROM CertificadosDeteccion d
    JOIN Certificados c
      ON c.ServidorId = d.ServidorId
     AND (c.Componente = d.ComponenteFinal OR (d.Puerto IS NOT NULL AND c.Puerto = d.Puerto))
     AND c.ThumbprintNorm <> d.ThumbprintNorm
     AND c.FechaFin < d.FechaFin
     AND COALESCE(c.NombreComun, '') = COALESCE(d.NombreComun, '')
     AND c.Activo = 1
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.EsGenerico = 0
     AND NOT EXISTS (SELECT 1 FROM CertificadosDeteccion d2
                      WHERE d2.LoteId = p_lote AND d2.ServidorId = c.ServidorId
                        AND d2.ThumbprintNorm = c.ThumbprintNorm)
   GROUP BY c.Id;

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Renovación detectada por ', d.Origen, ' en ', d.ComponenteFinal,
                     ': ', c.ThumbprintNorm, ' -> ', d.ThumbprintNorm), 500)
    FROM tmp_cert_ren r
    JOIN Certificados c ON c.Id = r.CertId
    JOIN CertificadosDeteccion d ON d.Id = r.DetId;

  UPDATE Certificados c
    JOIN tmp_cert_ren r ON r.CertId = c.Id
    JOIN CertificadosDeteccion d ON d.Id = r.DetId
     SET c.Thumbprint = REGEXP_REPLACE(d.ThumbprintNorm, '(..)(?!$)', '\\1:'),
         c.NumeroSerie = COALESCE(d.NumeroSerie, c.NumeroSerie),
         c.EntidadEmisora = COALESCE(d.EntidadEmisora, c.EntidadEmisora),
         c.FechaInicio = d.FechaInicio,
         c.FechaFin = d.FechaFin,
         c.Componente = IF(c.Componente LIKE 'PUERTO %' AND d.ComponenteFinal NOT LIKE 'PUERTO %', d.ComponenteFinal, c.Componente),
         c.Puerto = COALESCE(c.Puerto, d.Puerto),
         c.Origen = d.Origen,
         c.FechaUltimaDeteccion = NOW(),
         c.FechaUltimaActualizacion = NOW();

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_ren GROUP BY DetId) r ON r.DetId = d.Id
     SET d.Estado = 'RENOVADO', d.CertificadoId = r.CertId
   WHERE d.Estado = 'PENDIENTE';

  CALL sp__CertTocarExactos(p_lote);

  -- 7. Genérico "SIN COMPONENTE": si el certificado ya figura en el servidor
  --    con otro componente (no Root), solo se marca como detectado ----------
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_gen AS
  SELECT d.Id AS DetId, c.Id AS CertId
    FROM CertificadosDeteccion d
    JOIN Certificados c
      ON c.ServidorId = d.ServidorId AND c.ThumbprintNorm = d.ThumbprintNorm
     AND c.Componente <> 'ALMACEN ROOT'
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.EsGenerico = 1
     AND d.ComponenteFinal = 'SIN COMPONENTE IDENTIFICADO';

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Fechas corregidas según el certificado detectado por ', d.Origen, ' (', c.ThumbprintNorm, ')'), 500)
    FROM tmp_cert_gen g
    JOIN Certificados c ON c.Id = g.CertId
    JOIN CertificadosDeteccion d ON d.Id = g.DetId
   WHERE c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio);

  UPDATE Certificados c
    JOIN tmp_cert_gen g ON g.CertId = c.Id
    JOIN CertificadosDeteccion d ON d.Id = g.DetId
     SET c.FechaUltimaActualizacion = IF(c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio), NOW(), c.FechaUltimaActualizacion),
         c.FechaFin = d.FechaFin,
         c.FechaInicio = d.FechaInicio,
         c.NumeroSerie = COALESCE(d.NumeroSerie, c.NumeroSerie),
         c.FechaUltimaDeteccion = NOW(), c.Activo = 1;

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_gen GROUP BY DetId) g ON g.DetId = d.Id
     SET d.Estado = 'ACTUALIZADO', d.CertificadoId = g.CertId;

  -- 8. Ubicaciones nuevas ----------------------------------------------
  SELECT COALESCE(MAX(Id), 0) INTO v_max_id FROM Certificados;

  INSERT INTO Certificados
         (AplicacionId, ServidorId, Componente, NombreComun, EntidadEmisora, NumeroSerie, Thumbprint, Puerto,
          FechaInicio, FechaFin, Responsable, Observaciones, Activo, Origen, FechaUltimaDeteccion)
  SELECT (SELECT MIN(ac.AplicacionId) FROM Aplicacion_Componente ac WHERE ac.ComponenteId = d.ComponenteId),
         d.ServidorId, d.ComponenteFinal, d.NombreComun, d.EntidadEmisora, d.NumeroSerie,
         REGEXP_REPLACE(d.ThumbprintNorm, '(..)(?!$)', '\\1:'),
         d.Puerto, d.FechaInicio, d.FechaFin, NULL,
         LEFT(CONCAT('Detectado por ', d.Origen,
                     IF(d.Almacen IS NULL, '', CONCAT(' | Almacén: ', d.Almacen)),
                     IF(d.Detalle IS NULL, '', CONCAT(' | ', d.Detalle))), 500),
         1, d.Origen, NOW()
    FROM CertificadosDeteccion d
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE'
   ORDER BY d.Id;

  UPDATE CertificadosDeteccion d
    JOIN Certificados c
      ON c.Id > v_max_id
     AND c.ServidorId = d.ServidorId AND c.ThumbprintNorm = d.ThumbprintNorm AND c.Componente = d.ComponenteFinal
     SET d.Estado = 'INSERTADO', d.CertificadoId = c.Id
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE';

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT d.CertificadoId, 'ALTA', d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Alta automática por ', d.Origen, ' en ', d.ComponenteFinal), 500)
    FROM CertificadosDeteccion d
   WHERE d.LoteId = p_lote AND d.Estado = 'INSERTADO';

  -- 9. Aplicaciones de negocio vía sub-aplicativo ------------------------
  INSERT IGNORE INTO Certificado_Aplicacion (CertificadoId, AplicacionId, Origen)
  SELECT DISTINCT d.CertificadoId, ac.AplicacionId, 'AUTO'
    FROM CertificadosDeteccion d
    JOIN Aplicacion_Componente ac ON ac.ComponenteId = d.ComponenteId
   WHERE d.LoteId = p_lote AND d.CertificadoId IS NOT NULL;

  UPDATE Certificados c
    JOIN (SELECT CertificadoId, MIN(AplicacionId) AS AplicacionId
            FROM Certificado_Aplicacion GROUP BY CertificadoId) ca ON ca.CertificadoId = c.Id
    JOIN CertificadosDeteccion d ON d.CertificadoId = c.Id AND d.LoteId = p_lote
     SET c.AplicacionId = ca.AplicacionId
   WHERE c.AplicacionId IS NULL;

  -- 10. Inventario completo Windows: ubicaciones que ya no existen -------
  IF (SELECT DesactivarAusentes FROM CertificadosLotes WHERE Id = p_lote) = 1 THEN
    CREATE OR REPLACE TEMPORARY TABLE tmp_cert_aus AS
    SELECT c.Id AS CertId
      FROM Certificados c
     WHERE c.Activo = 1
       AND (c.Origen IS NULL OR c.Origen = 'WINDOWS')
       AND c.ServidorId IN (SELECT DISTINCT ServidorId FROM CertificadosDeteccion
                             WHERE LoteId = p_lote AND ServidorId IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM CertificadosDeteccion d
                        WHERE d.LoteId = p_lote AND d.ServidorId = c.ServidorId
                          AND d.ThumbprintNorm = c.ThumbprintNorm);

    -- Protección contra inventarios incompletos
    CREATE OR REPLACE TEMPORARY TABLE tmp_cert_aus_srv AS
    SELECT c.ServidorId, COUNT(*) AS Ausentes,
           (SELECT COUNT(*) FROM Certificados c2 WHERE c2.ServidorId = c.ServidorId AND c2.Activo = 1) AS Activos
      FROM tmp_cert_aus a JOIN Certificados c ON c.Id = a.CertId
     GROUP BY c.ServidorId;

    INSERT INTO CertificadosDeteccion (LoteId, Origen, ServidorId, Estado, Mensaje)
    SELECT p_lote, 'WINDOWS', s.ServidorId, 'DESACTIVACION_OMITIDA',
           CONCAT('Se omitió: ', s.Ausentes, ' de ', s.Activos, ' ubicaciones activas no aparecen (supera el ',
                  l.MaxDesactivarPct, '%). Revisar el inventario o reenviar con maxDesactivarPct mayor.')
      FROM tmp_cert_aus_srv s JOIN CertificadosLotes l ON l.Id = p_lote
     WHERE s.Ausentes * 100 > s.Activos * l.MaxDesactivarPct;

    DELETE a FROM tmp_cert_aus a
      JOIN Certificados c ON c.Id = a.CertId
      JOIN tmp_cert_aus_srv s ON s.ServidorId = c.ServidorId
      JOIN CertificadosLotes l ON l.Id = p_lote
     WHERE s.Ausentes * 100 > s.Activos * l.MaxDesactivarPct;

    INSERT INTO HistoricoCertificados
           (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
    SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, c.FechaInicio, c.FechaFin, 'N8N-DESCUBRIMIENTO',
           'Desactivado: el certificado ya no está instalado en el servidor (inventario completo WINDOWS)'
      FROM tmp_cert_aus a JOIN Certificados c ON c.Id = a.CertId;

    UPDATE Certificados c JOIN tmp_cert_aus a ON a.CertId = c.Id
       SET c.Activo = 0, c.FechaUltimaActualizacion = NOW();

    INSERT INTO CertificadosDeteccion (LoteId, Origen, ServidorId, Estado, Mensaje, CertificadoId)
    SELECT p_lote, 'WINDOWS', c.ServidorId, 'DESACTIVADO_AUSENTE', LEFT(CONCAT(COALESCE(c.NombreComun,''), ' · ', COALESCE(c.Componente,'')), 300), c.Id
      FROM tmp_cert_aus a JOIN Certificados c ON c.Id = a.CertId;

    DROP TEMPORARY TABLE IF EXISTS tmp_cert_aus;
    DROP TEMPORARY TABLE IF EXISTS tmp_cert_aus_srv;
  END IF;

  -- 11. Resumen --------------------------------------------------------
  UPDATE CertificadosLotes l
     SET l.FechaProceso = NOW(),
         l.Resumen = (SELECT GROUP_CONCAT(CONCAT(x.Estado, '=', x.n) ORDER BY x.Estado SEPARATOR ', ')
                        FROM (SELECT Estado, COUNT(*) AS n FROM CertificadosDeteccion
                               WHERE LoteId = p_lote GROUP BY Estado) x)
   WHERE l.Id = p_lote;

  DROP TEMPORARY TABLE IF EXISTS tmp_cert_keep;
  DROP TEMPORARY TABLE IF EXISTS tmp_cert_upg;
  DROP TEMPORARY TABLE IF EXISTS tmp_cert_ren;
  DROP TEMPORARY TABLE IF EXISTS tmp_cert_gen;

  SELECT p_lote AS LoteId, Estado, COUNT(*) AS Total
    FROM CertificadosDeteccion
   WHERE LoteId = p_lote
   GROUP BY Estado
   ORDER BY Estado;
END $$

-- Punto de entrada para n8n: recibe el JSON del colector en Base64
-- {"lote":"...","origen":"SCAN_RED","detecciones":[{...}, ...]}
DROP PROCEDURE IF EXISTS `sp_CargarDeteccionesB64` $$
CREATE PROCEDURE `sp_CargarDeteccionesB64`(IN p_b64 LONGTEXT)
BEGIN
  DECLARE v_json LONGTEXT;
  DECLARE v_lote INT;

  SET v_json = CONVERT(FROM_BASE64(p_b64) USING utf8mb4);
  IF v_json IS NULL OR JSON_VALID(v_json) = 0 OR JSON_TYPE(JSON_EXTRACT(v_json, '$.detecciones')) <> 'ARRAY' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payload inválido: se esperaba {lote, origen, detecciones:[...]}';
  END IF;

  INSERT INTO CertificadosLotes (Referencia, Origen, Total, DesactivarAusentes, MaxDesactivarPct)
  VALUES (LEFT(JSON_UNQUOTE(JSON_EXTRACT(v_json, '$.lote')), 80),
          LEFT(JSON_UNQUOTE(JSON_EXTRACT(v_json, '$.origen')), 20),
          JSON_LENGTH(v_json, '$.detecciones'),
          IF(JSON_UNQUOTE(JSON_EXTRACT(v_json, '$.origen')) = 'WINDOWS'
             AND JSON_EXTRACT(v_json, '$.desactivarAusentes') = TRUE, 1, 0),
          LEAST(100, GREATEST(0, COALESCE(CAST(JSON_EXTRACT(v_json, '$.maxDesactivarPct') AS INT), 50))));
  SET v_lote = LAST_INSERT_ID();

  INSERT INTO CertificadosDeteccion
         (LoteId, Origen, IP, Hostname, Componente, Puerto, Almacen, NombreComun, SAN,
          EntidadEmisora, NumeroSerie, Thumbprint, FechaInicio, FechaFin, Detalle)
  SELECT v_lote,
         LEFT(COALESCE(j.Origen, JSON_UNQUOTE(JSON_EXTRACT(v_json, '$.origen'))), 20),
         LEFT(j.IP, 45), LEFT(j.Hostname, 100), LEFT(j.Componente, 150), j.Puerto, LEFT(j.Almacen, 80),
         LEFT(j.NombreComun, 150), LEFT(j.SAN, 1000), LEFT(j.EntidadEmisora, 150), LEFT(j.NumeroSerie, 100),
         LEFT(j.Thumbprint, 100),
         CAST(NULLIF(LEFT(j.FechaInicio, 10), '') AS DATE),
         CAST(NULLIF(LEFT(j.FechaFin, 10), '') AS DATE),
         LEFT(j.Detalle, 500)
    FROM JSON_TABLE(v_json, '$.detecciones[*]' COLUMNS (
           Origen         VARCHAR(50)   PATH '$.Origen',
           IP             VARCHAR(100)  PATH '$.IP',
           Hostname       VARCHAR(255)  PATH '$.Hostname',
           Componente     VARCHAR(500)  PATH '$.Componente',
           Puerto         INT           PATH '$.Puerto' NULL ON ERROR,
           Almacen        VARCHAR(200)  PATH '$.Almacen',
           NombreComun    VARCHAR(500)  PATH '$.NombreComun',
           SAN            VARCHAR(4000) PATH '$.SAN',
           EntidadEmisora VARCHAR(500)  PATH '$.EntidadEmisora',
           NumeroSerie    VARCHAR(200)  PATH '$.NumeroSerie',
           Thumbprint     VARCHAR(200)  PATH '$.Thumbprint',
           FechaInicio    VARCHAR(40)   PATH '$.FechaInicio',
           FechaFin       VARCHAR(40)   PATH '$.FechaFin',
           Detalle        VARCHAR(2000) PATH '$.Detalle'
         )) j;

  CALL sp_ProcesarDetecciones(v_lote);
END $$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 5. Vistas para alertas y seguimiento
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW `vw_CertificadosAlertas` AS
SELECT c.ThumbprintNorm,
       MAX(c.NombreComun)    AS NombreComun,
       MAX(c.EntidadEmisora) AS EntidadEmisora,
       MAX(c.FechaFin)       AS FechaFin,
       DATEDIFF(MAX(c.FechaFin), CURDATE()) AS DiasRestantes,
       CASE
         WHEN DATEDIFF(MAX(c.FechaFin), CURDATE()) < -30 THEN 'VENCIDO'
         WHEN DATEDIFF(MAX(c.FechaFin), CURDATE()) < 0   THEN 'VENCIDO_RECIENTE'
         WHEN DATEDIFF(MAX(c.FechaFin), CURDATE()) <= 7  THEN 'CRITICO_7'
         WHEN DATEDIFF(MAX(c.FechaFin), CURDATE()) <= 30 THEN 'CRITICO_30'
         WHEN DATEDIFF(MAX(c.FechaFin), CURDATE()) <= 60 THEN 'ALERTA_60'
         ELSE 'ALERTA_90'
       END AS Nivel,
       COUNT(DISTINCT c.Id) AS Ubicaciones,
       COUNT(DISTINCT CASE WHEN c.Componente NOT IN ('ALMACEN ROOT', 'SIN COMPONENTE IDENTIFICADO') THEN c.Id END) AS UbicacionesEnUso,
       GROUP_CONCAT(DISTINCT CONCAT(s.Hostname, ' (', s.IP, ') · ', COALESCE(c.Componente, '?'))
                    ORDER BY s.Hostname SEPARATOR '\n') AS DondeEsta,
       GROUP_CONCAT(DISTINCT a.Nombre ORDER BY a.Nombre SEPARATOR ', ') AS Aplicaciones,
       MAX(c.FechaUltimaDeteccion) AS UltimaDeteccion
  FROM Certificados c
  JOIN Servidores s ON s.Id = c.ServidorId
  LEFT JOIN Certificado_Aplicacion ca ON ca.CertificadoId = c.Id
  LEFT JOIN Aplicaciones a ON a.Id = ca.AplicacionId
 WHERE c.Activo = 1
   AND c.FechaFin <= CURDATE() + INTERVAL 90 DAY
 GROUP BY c.ThumbprintNorm;

CREATE OR REPLACE VIEW `vw_CertificadosNoDetectados` AS
SELECT c.Id, s.Hostname, s.IP, c.Componente, c.NombreComun, c.FechaFin, c.Origen, c.FechaUltimaDeteccion,
       DATEDIFF(NOW(), c.FechaUltimaDeteccion) AS DiasSinDetectar
  FROM Certificados c
  JOIN Servidores s ON s.Id = c.ServidorId
 WHERE c.Activo = 1
   AND c.Origen IS NOT NULL
   AND c.FechaUltimaDeteccion < NOW() - INTERVAL 7 DAY;

CREATE OR REPLACE VIEW `vw_PuertosTlsSinSubaplicativo` AS
SELECT s.Hostname, s.IP, c.Puerto, c.NombreComun, c.FechaFin, c.FechaUltimaDeteccion, c.Id AS CertificadoId
  FROM Certificados c
  JOIN Servidores s ON s.Id = c.ServidorId
 WHERE c.Activo = 1 AND c.Componente LIKE 'PUERTO %';

CREATE OR REPLACE VIEW `vw_DeteccionesPendientes` AS
SELECT l.Id AS LoteId, l.Referencia, l.FechaRecepcion, d.Origen, d.IP, d.Hostname, d.Estado, d.Mensaje,
       d.NombreComun, d.FechaFin, d.ComponenteFinal, d.Puerto
  FROM CertificadosDeteccion d
  JOIN CertificadosLotes l ON l.Id = d.LoteId
 WHERE d.Estado IN ('SERVIDOR_NO_REGISTRADO', 'RECHAZADO');

-- ---------------------------------------------------------------------
-- 6. Usuarios (reemplazar contraseñas). Ejecutar como administrador.
-- ---------------------------------------------------------------------
-- Usuario de n8n: ejecuta procedimientos y lee vistas
-- CREATE USER 'n8n_axis'@'192.168.125.130' IDENTIFIED BY '<<CLAVE_SEGURA>>';
-- GRANT EXECUTE ON PROCEDURE BIC_CERTI_MARIA.sp_CargarDeteccionesB64 TO 'n8n_axis'@'192.168.125.130';
-- GRANT SELECT ON BIC_CERTI_MARIA.vw_CertificadosAlertas TO 'n8n_axis'@'192.168.125.130';
-- GRANT SELECT ON BIC_CERTI_MARIA.vw_CertificadosNoDetectados TO 'n8n_axis'@'192.168.125.130';
-- GRANT SELECT ON BIC_CERTI_MARIA.vw_DeteccionesPendientes TO 'n8n_axis'@'192.168.125.130';
-- GRANT SELECT ON BIC_CERTI_MARIA.CertificadosLotes TO 'n8n_axis'@'192.168.125.130';
--
-- Usuario de solo lectura del escáner (lista de servidores y puertos)
-- CREATE USER 'axis_scan_ro'@'192.168.125.130' IDENTIFIED BY '<<CLAVE_SEGURA>>';
-- GRANT SELECT ON BIC_CERTI_MARIA.Servidores TO 'axis_scan_ro'@'192.168.125.130';
-- GRANT SELECT ON BIC_CERTI_MARIA.Servidor_Componentes TO 'axis_scan_ro'@'192.168.125.130';
-- GRANT SELECT ON BIC_CERTI_MARIA.Certificados TO 'axis_scan_ro'@'192.168.125.130';
--
-- Nota: los procedimientos se crean con SQL SECURITY DEFINER (por defecto),
-- así n8n no necesita permisos directos de escritura sobre las tablas.

-- ---------------------------------------------------------------------
-- 7. FASE 2 (solo cuando AXIS lea Certificado_Aplicacion): quitar las
--    filas duplicadas por aplicación. NO ejecutar antes.
-- ---------------------------------------------------------------------
-- CREATE TEMPORARY TABLE tmp_dup AS
-- SELECT c.Id, k.KeepId
--   FROM Certificados c
--   JOIN (SELECT ServidorId, ThumbprintNorm, COALESCE(Componente,'') Comp, MIN(Id) KeepId
--           FROM Certificados GROUP BY ServidorId, ThumbprintNorm, COALESCE(Componente,'')
--          HAVING COUNT(*) > 1) k
--     ON k.ServidorId = c.ServidorId AND k.ThumbprintNorm = c.ThumbprintNorm
--    AND k.Comp = COALESCE(c.Componente,'') AND c.Id <> k.KeepId;
-- UPDATE HistoricoCertificados h JOIN tmp_dup d ON d.Id = h.CertificadoId SET h.CertificadoId = d.KeepId;
-- INSERT IGNORE INTO Certificado_Aplicacion (CertificadoId, AplicacionId, Origen)
--   SELECT d.KeepId, ca.AplicacionId, ca.Origen FROM Certificado_Aplicacion ca JOIN tmp_dup d ON d.Id = ca.CertificadoId;
-- DELETE c FROM Certificados c JOIN tmp_dup d ON d.Id = c.Id;


-- #####################################################################
-- 03_ajuste_sincronizar_fechas.sql
-- #####################################################################
-- =====================================================================
-- AXIS · BIC_CERTI_MARIA · Ajuste 03 (para el ADMINISTRADOR DE BD)
-- Recrea los procedimientos de carga para que, cuando un colector detecte un
-- certificado ya registrado, también corrija FechaInicio/FechaFin/NumeroSerie
-- si en AXIS estaban desactualizadas (el thumbprint identifica el certificado).
-- No modifica tablas ni datos y no elimina objetos (usa CREATE OR REPLACE).
-- Requiere privilegios CREATE ROUTINE / ALTER ROUTINE. Ejecutar con mariadb o HeidiSQL.
-- =====================================================================
SET NAMES utf8mb4;
USE `BIC_CERTI_MARIA`;

DELIMITER $$

CREATE OR REPLACE PROCEDURE `sp__CertTocarExactos`(IN p_lote INT)
BEGIN
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_match AS
  SELECT d.Id AS DetId, c.Id AS CertId
    FROM CertificadosDeteccion d
    JOIN Certificados c
      ON c.ServidorId = d.ServidorId
     AND c.ThumbprintNorm = d.ThumbprintNorm
     AND c.Componente = d.ComponenteFinal
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE';

  -- El thumbprint identifica el certificado: si AXIS tiene otras fechas/serie, se corrigen
  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Fechas corregidas según el certificado detectado por ', d.Origen,
                     ' (', c.ThumbprintNorm, ')'), 500)
    FROM tmp_cert_match m
    JOIN Certificados c ON c.Id = m.CertId
    JOIN CertificadosDeteccion d ON d.Id = m.DetId
   WHERE c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio);

  UPDATE Certificados c
    JOIN tmp_cert_match m ON m.CertId = c.Id
    JOIN CertificadosDeteccion d ON d.Id = m.DetId
     SET c.FechaUltimaActualizacion = IF(c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio), NOW(), c.FechaUltimaActualizacion),
         c.FechaFin = d.FechaFin,
         c.FechaInicio = d.FechaInicio,
         c.NumeroSerie = COALESCE(d.NumeroSerie, c.NumeroSerie),
         c.EntidadEmisora = COALESCE(d.EntidadEmisora, c.EntidadEmisora),
         c.FechaUltimaDeteccion = NOW(),
         c.Origen = d.Origen,
         c.Puerto = COALESCE(c.Puerto, d.Puerto),
         c.Activo = 1;

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_match GROUP BY DetId) m ON m.DetId = d.Id
     SET d.Estado = 'ACTUALIZADO', d.CertificadoId = m.CertId;

  DROP TEMPORARY TABLE IF EXISTS tmp_cert_match;
END $$

CREATE OR REPLACE PROCEDURE `sp_ProcesarDetecciones`(IN p_lote INT)
BEGIN
  DECLARE v_max_id INT DEFAULT 0;

  -- 1. Normalizar y validar ------------------------------------------
  UPDATE CertificadosDeteccion
     SET ThumbprintNorm = UPPER(REPLACE(REPLACE(REPLACE(Thumbprint, ':', ''), ' ', ''), '-', '')),
         IP         = NULLIF(TRIM(IP), ''),
         Hostname   = NULLIF(UPPER(SUBSTRING_INDEX(TRIM(Hostname), '.', 1)), ''),
         Componente = NULLIF(TRIM(Componente), ''),
         Almacen    = NULLIF(TRIM(Almacen), ''),
         FechaInicio = IF(FechaInicio >= FechaFin, NULL, FechaInicio)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE';

  UPDATE CertificadosDeteccion
     SET Estado = 'RECHAZADO', Mensaje = 'Thumbprint inválido o sin fecha de vencimiento'
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE'
     AND (ThumbprintNorm IS NULL OR LENGTH(ThumbprintNorm) <> 40 OR FechaFin IS NULL);

  -- 2. Resolver servidor (IP y luego hostname) ------------------------
  UPDATE CertificadosDeteccion d
    JOIN Servidores s ON s.IP = d.IP
     SET d.ServidorId = s.Id
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE';

  UPDATE CertificadosDeteccion d
    JOIN Servidores s ON UPPER(s.Hostname) = d.Hostname
     SET d.ServidorId = s.Id
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.ServidorId IS NULL;

  UPDATE CertificadosDeteccion
     SET Estado = 'SERVIDOR_NO_REGISTRADO',
         Mensaje = LEFT(CONCAT('No existe en Servidores: ', COALESCE(IP, ''), ' ', COALESCE(Hostname, '')), 300)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND ServidorId IS NULL;

  -- 3. Resolver componente --------------------------------------------
  -- 3a. Nombre reportado = sub-aplicativo registrado
  UPDATE CertificadosDeteccion d
    JOIN Servidor_Componentes sc ON sc.ServidorId = d.ServidorId AND sc.Rol = d.Componente
     SET d.ComponenteId = sc.Id, d.ComponenteFinal = sc.Rol
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.Componente IS NOT NULL;

  UPDATE CertificadosDeteccion
     SET ComponenteFinal = LEFT(Componente, 150)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND Componente IS NOT NULL AND ComponenteFinal IS NULL;

  -- 3b. Sin nombre: sub-aplicativo por puerto
  UPDATE CertificadosDeteccion d
    JOIN Servidor_Componentes sc ON sc.ServidorId = d.ServidorId AND sc.Puerto = d.Puerto
     SET d.ComponenteId = sc.Id, d.ComponenteFinal = sc.Rol
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.ComponenteFinal IS NULL AND d.Puerto IS NOT NULL;

  -- 3c. Puerto sin sub-aplicativo registrado
  UPDATE CertificadosDeteccion
     SET ComponenteFinal = CONCAT('PUERTO ', Puerto)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND ComponenteFinal IS NULL AND Puerto IS NOT NULL;

  -- 3d. Solo presente en almacén (convención AXIS)
  UPDATE CertificadosDeteccion
     SET EsGenerico = 1,
         ComponenteFinal = IF(Almacen LIKE '%Root%', 'ALMACEN ROOT', 'SIN COMPONENTE IDENTIFICADO')
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND ComponenteFinal IS NULL;

  -- 3e. Duplicados dentro del mismo lote
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_keep AS
  SELECT MIN(Id) AS KeepId, ServidorId, ThumbprintNorm, ComponenteFinal
    FROM CertificadosDeteccion
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE'
   GROUP BY ServidorId, ThumbprintNorm, ComponenteFinal
  HAVING COUNT(*) > 1;

  UPDATE CertificadosDeteccion d
    JOIN tmp_cert_keep k
      ON k.ServidorId = d.ServidorId AND k.ThumbprintNorm = d.ThumbprintNorm AND k.ComponenteFinal = d.ComponenteFinal
     SET d.Estado = 'DUPLICADO_LOTE'
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.Id <> k.KeepId;

  -- 4. Ubicaciones ya conocidas: solo marcar detección ------------------
  CALL sp__CertTocarExactos(p_lote);

  -- 5. Identificar componente en filas genéricas existentes --------------
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_upg (
    CertId INT, DetId BIGINT, CompAnterior VARCHAR(150), CompNuevo VARCHAR(150),
    Origen VARCHAR(20), Puerto INT, ComponenteId INT
  ) DEFAULT CHARSET=utf8mb4;

  -- 5a. "SIN COMPONENTE IDENTIFICADO" -> primer uso real detectado
  INSERT INTO tmp_cert_upg
  SELECT c.Id, d.Id, c.Componente, d.ComponenteFinal, d.Origen, d.Puerto, d.ComponenteId
    FROM Certificados c
    JOIN (SELECT ServidorId, ThumbprintNorm, MIN(Id) AS DetId
            FROM CertificadosDeteccion
           WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND EsGenerico = 0
           GROUP BY ServidorId, ThumbprintNorm) p
      ON p.ServidorId = c.ServidorId AND p.ThumbprintNorm = c.ThumbprintNorm
    JOIN CertificadosDeteccion d ON d.Id = p.DetId
   WHERE c.Componente IS NULL OR c.Componente = '' OR c.Componente = 'SIN COMPONENTE IDENTIFICADO';

  -- 5b. "PUERTO n" -> nombre real del mismo puerto (IIS, contenedor, PM2)
  INSERT INTO tmp_cert_upg
  SELECT c.Id, d.Id, c.Componente, d.ComponenteFinal, d.Origen, d.Puerto, d.ComponenteId
    FROM Certificados c
    JOIN (SELECT ServidorId, ThumbprintNorm, Puerto, MIN(Id) AS DetId
            FROM CertificadosDeteccion
           WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND EsGenerico = 0
             AND Puerto IS NOT NULL AND ComponenteFinal NOT LIKE 'PUERTO %'
           GROUP BY ServidorId, ThumbprintNorm, Puerto) p
      ON p.ServidorId = c.ServidorId AND p.ThumbprintNorm = c.ThumbprintNorm AND p.Puerto = c.Puerto
    JOIN CertificadosDeteccion d ON d.Id = p.DetId
   WHERE c.Componente LIKE 'PUERTO %';

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, c.FechaInicio, c.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Componente identificado por ', u.Origen, ': ', COALESCE(NULLIF(u.CompAnterior, ''), '(vacío)'), ' -> ', u.CompNuevo), 500)
    FROM tmp_cert_upg u JOIN Certificados c ON c.Id = u.CertId;

  UPDATE Certificados c
    JOIN tmp_cert_upg u ON u.CertId = c.Id
     SET c.Componente = u.CompNuevo,
         c.Puerto = COALESCE(c.Puerto, u.Puerto),
         c.Origen = u.Origen,
         c.FechaUltimaDeteccion = NOW(),
         c.FechaUltimaActualizacion = NOW(),
         c.Activo = 1;

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_upg GROUP BY DetId) u ON u.DetId = d.Id
     SET d.Estado = 'COMPONENTE_IDENTIFICADO', d.CertificadoId = u.CertId
   WHERE d.Estado = 'PENDIENTE';

  CALL sp__CertTocarExactos(p_lote);

  -- 6. Renovación: mismo servidor + componente (o puerto) + nombre común,
  --    thumbprint nuevo y más vigente, y el anterior ya no aparece -------
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_ren AS
  SELECT c.Id AS CertId, MIN(d.Id) AS DetId
    FROM CertificadosDeteccion d
    JOIN Certificados c
      ON c.ServidorId = d.ServidorId
     AND (c.Componente = d.ComponenteFinal OR (d.Puerto IS NOT NULL AND c.Puerto = d.Puerto))
     AND c.ThumbprintNorm <> d.ThumbprintNorm
     AND c.FechaFin < d.FechaFin
     AND COALESCE(c.NombreComun, '') = COALESCE(d.NombreComun, '')
     AND c.Activo = 1
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.EsGenerico = 0
     AND NOT EXISTS (SELECT 1 FROM CertificadosDeteccion d2
                      WHERE d2.LoteId = p_lote AND d2.ServidorId = c.ServidorId
                        AND d2.ThumbprintNorm = c.ThumbprintNorm)
   GROUP BY c.Id;

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Renovación detectada por ', d.Origen, ' en ', d.ComponenteFinal,
                     ': ', c.ThumbprintNorm, ' -> ', d.ThumbprintNorm), 500)
    FROM tmp_cert_ren r
    JOIN Certificados c ON c.Id = r.CertId
    JOIN CertificadosDeteccion d ON d.Id = r.DetId;

  UPDATE Certificados c
    JOIN tmp_cert_ren r ON r.CertId = c.Id
    JOIN CertificadosDeteccion d ON d.Id = r.DetId
     SET c.Thumbprint = REGEXP_REPLACE(d.ThumbprintNorm, '(..)(?!$)', '\\1:'),
         c.NumeroSerie = COALESCE(d.NumeroSerie, c.NumeroSerie),
         c.EntidadEmisora = COALESCE(d.EntidadEmisora, c.EntidadEmisora),
         c.FechaInicio = d.FechaInicio,
         c.FechaFin = d.FechaFin,
         c.Componente = IF(c.Componente LIKE 'PUERTO %' AND d.ComponenteFinal NOT LIKE 'PUERTO %', d.ComponenteFinal, c.Componente),
         c.Puerto = COALESCE(c.Puerto, d.Puerto),
         c.Origen = d.Origen,
         c.FechaUltimaDeteccion = NOW(),
         c.FechaUltimaActualizacion = NOW();

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_ren GROUP BY DetId) r ON r.DetId = d.Id
     SET d.Estado = 'RENOVADO', d.CertificadoId = r.CertId
   WHERE d.Estado = 'PENDIENTE';

  CALL sp__CertTocarExactos(p_lote);

  -- 7. Genérico "SIN COMPONENTE": si el certificado ya figura en el servidor
  --    con otro componente (no Root), solo se marca como detectado ----------
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_gen AS
  SELECT d.Id AS DetId, c.Id AS CertId
    FROM CertificadosDeteccion d
    JOIN Certificados c
      ON c.ServidorId = d.ServidorId AND c.ThumbprintNorm = d.ThumbprintNorm
     AND c.Componente <> 'ALMACEN ROOT'
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.EsGenerico = 1
     AND d.ComponenteFinal = 'SIN COMPONENTE IDENTIFICADO';

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Fechas corregidas según el certificado detectado por ', d.Origen, ' (', c.ThumbprintNorm, ')'), 500)
    FROM tmp_cert_gen g
    JOIN Certificados c ON c.Id = g.CertId
    JOIN CertificadosDeteccion d ON d.Id = g.DetId
   WHERE c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio);

  UPDATE Certificados c
    JOIN tmp_cert_gen g ON g.CertId = c.Id
    JOIN CertificadosDeteccion d ON d.Id = g.DetId
     SET c.FechaUltimaActualizacion = IF(c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio), NOW(), c.FechaUltimaActualizacion),
         c.FechaFin = d.FechaFin,
         c.FechaInicio = d.FechaInicio,
         c.NumeroSerie = COALESCE(d.NumeroSerie, c.NumeroSerie),
         c.FechaUltimaDeteccion = NOW(), c.Activo = 1;

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_gen GROUP BY DetId) g ON g.DetId = d.Id
     SET d.Estado = 'ACTUALIZADO', d.CertificadoId = g.CertId;

  -- 8. Ubicaciones nuevas ----------------------------------------------
  SELECT COALESCE(MAX(Id), 0) INTO v_max_id FROM Certificados;

  INSERT INTO Certificados
         (AplicacionId, ServidorId, Componente, NombreComun, EntidadEmisora, NumeroSerie, Thumbprint, Puerto,
          FechaInicio, FechaFin, Responsable, Observaciones, Activo, Origen, FechaUltimaDeteccion)
  SELECT (SELECT MIN(ac.AplicacionId) FROM Aplicacion_Componente ac WHERE ac.ComponenteId = d.ComponenteId),
         d.ServidorId, d.ComponenteFinal, d.NombreComun, d.EntidadEmisora, d.NumeroSerie,
         REGEXP_REPLACE(d.ThumbprintNorm, '(..)(?!$)', '\\1:'),
         d.Puerto, d.FechaInicio, d.FechaFin, NULL,
         LEFT(CONCAT('Detectado por ', d.Origen,
                     IF(d.Almacen IS NULL, '', CONCAT(' | Almacén: ', d.Almacen)),
                     IF(d.Detalle IS NULL, '', CONCAT(' | ', d.Detalle))), 500),
         1, d.Origen, NOW()
    FROM CertificadosDeteccion d
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE'
   ORDER BY d.Id;

  UPDATE CertificadosDeteccion d
    JOIN Certificados c
      ON c.Id > v_max_id
     AND c.ServidorId = d.ServidorId AND c.ThumbprintNorm = d.ThumbprintNorm AND c.Componente = d.ComponenteFinal
     SET d.Estado = 'INSERTADO', d.CertificadoId = c.Id
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE';

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT d.CertificadoId, 'ALTA', d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Alta automática por ', d.Origen, ' en ', d.ComponenteFinal), 500)
    FROM CertificadosDeteccion d
   WHERE d.LoteId = p_lote AND d.Estado = 'INSERTADO';

  -- 9. Aplicaciones de negocio vía sub-aplicativo ------------------------
  INSERT IGNORE INTO Certificado_Aplicacion (CertificadoId, AplicacionId, Origen)
  SELECT DISTINCT d.CertificadoId, ac.AplicacionId, 'AUTO'
    FROM CertificadosDeteccion d
    JOIN Aplicacion_Componente ac ON ac.ComponenteId = d.ComponenteId
   WHERE d.LoteId = p_lote AND d.CertificadoId IS NOT NULL;

  UPDATE Certificados c
    JOIN (SELECT CertificadoId, MIN(AplicacionId) AS AplicacionId
            FROM Certificado_Aplicacion GROUP BY CertificadoId) ca ON ca.CertificadoId = c.Id
    JOIN CertificadosDeteccion d ON d.CertificadoId = c.Id AND d.LoteId = p_lote
     SET c.AplicacionId = ca.AplicacionId
   WHERE c.AplicacionId IS NULL;

  -- 10. Inventario completo Windows: ubicaciones que ya no existen -------
  IF (SELECT DesactivarAusentes FROM CertificadosLotes WHERE Id = p_lote) = 1 THEN
    CREATE OR REPLACE TEMPORARY TABLE tmp_cert_aus AS
    SELECT c.Id AS CertId
      FROM Certificados c
     WHERE c.Activo = 1
       AND (c.Origen IS NULL OR c.Origen = 'WINDOWS')
       AND c.ServidorId IN (SELECT DISTINCT ServidorId FROM CertificadosDeteccion
                             WHERE LoteId = p_lote AND ServidorId IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM CertificadosDeteccion d
                        WHERE d.LoteId = p_lote AND d.ServidorId = c.ServidorId
                          AND d.ThumbprintNorm = c.ThumbprintNorm);

    -- Protección contra inventarios incompletos
    CREATE OR REPLACE TEMPORARY TABLE tmp_cert_aus_srv AS
    SELECT c.ServidorId, COUNT(*) AS Ausentes,
           (SELECT COUNT(*) FROM Certificados c2 WHERE c2.ServidorId = c.ServidorId AND c2.Activo = 1) AS Activos
      FROM tmp_cert_aus a JOIN Certificados c ON c.Id = a.CertId
     GROUP BY c.ServidorId;

    INSERT INTO CertificadosDeteccion (LoteId, Origen, ServidorId, Estado, Mensaje)
    SELECT p_lote, 'WINDOWS', s.ServidorId, 'DESACTIVACION_OMITIDA',
           CONCAT('Se omitió: ', s.Ausentes, ' de ', s.Activos, ' ubicaciones activas no aparecen (supera el ',
                  l.MaxDesactivarPct, '%). Revisar el inventario o reenviar con maxDesactivarPct mayor.')
      FROM tmp_cert_aus_srv s JOIN CertificadosLotes l ON l.Id = p_lote
     WHERE s.Ausentes * 100 > s.Activos * l.MaxDesactivarPct;

    DELETE a FROM tmp_cert_aus a
      JOIN Certificados c ON c.Id = a.CertId
      JOIN tmp_cert_aus_srv s ON s.ServidorId = c.ServidorId
      JOIN CertificadosLotes l ON l.Id = p_lote
     WHERE s.Ausentes * 100 > s.Activos * l.MaxDesactivarPct;

    INSERT INTO HistoricoCertificados
           (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
    SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, c.FechaInicio, c.FechaFin, 'N8N-DESCUBRIMIENTO',
           'Desactivado: el certificado ya no está instalado en el servidor (inventario completo WINDOWS)'
      FROM tmp_cert_aus a JOIN Certificados c ON c.Id = a.CertId;

    UPDATE Certificados c JOIN tmp_cert_aus a ON a.CertId = c.Id
       SET c.Activo = 0, c.FechaUltimaActualizacion = NOW();

    INSERT INTO CertificadosDeteccion (LoteId, Origen, ServidorId, Estado, Mensaje, CertificadoId)
    SELECT p_lote, 'WINDOWS', c.ServidorId, 'DESACTIVADO_AUSENTE', LEFT(CONCAT(COALESCE(c.NombreComun,''), ' · ', COALESCE(c.Componente,'')), 300), c.Id
      FROM tmp_cert_aus a JOIN Certificados c ON c.Id = a.CertId;

    DROP TEMPORARY TABLE IF EXISTS tmp_cert_aus;
    DROP TEMPORARY TABLE IF EXISTS tmp_cert_aus_srv;
  END IF;

  -- 11. Resumen --------------------------------------------------------
  UPDATE CertificadosLotes l
     SET l.FechaProceso = NOW(),
         l.Resumen = (SELECT GROUP_CONCAT(CONCAT(x.Estado, '=', x.n) ORDER BY x.Estado SEPARATOR ', ')
                        FROM (SELECT Estado, COUNT(*) AS n FROM CertificadosDeteccion
                               WHERE LoteId = p_lote GROUP BY Estado) x)
   WHERE l.Id = p_lote;

  DROP TEMPORARY TABLE IF EXISTS tmp_cert_keep;
  DROP TEMPORARY TABLE IF EXISTS tmp_cert_upg;
  DROP TEMPORARY TABLE IF EXISTS tmp_cert_ren;
  DROP TEMPORARY TABLE IF EXISTS tmp_cert_gen;

  SELECT p_lote AS LoteId, Estado, COUNT(*) AS Total
    FROM CertificadosDeteccion
   WHERE LoteId = p_lote
   GROUP BY Estado
   ORDER BY Estado;
END $$

-- Punto de entrada para n8n: recibe el JSON del colector en Base64
-- {"lote":"...","origen":"SCAN_RED","detecciones":[{...}, ...]}
CREATE OR REPLACE PROCEDURE `sp_CargarDeteccionesB64`(IN p_b64 LONGTEXT)
BEGIN
  DECLARE v_json LONGTEXT;
  DECLARE v_lote INT;

  SET v_json = CONVERT(FROM_BASE64(p_b64) USING utf8mb4);
  IF v_json IS NULL OR JSON_VALID(v_json) = 0 OR JSON_TYPE(JSON_EXTRACT(v_json, '$.detecciones')) <> 'ARRAY' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payload inválido: se esperaba {lote, origen, detecciones:[...]}';
  END IF;

  INSERT INTO CertificadosLotes (Referencia, Origen, Total, DesactivarAusentes, MaxDesactivarPct)
  VALUES (LEFT(JSON_UNQUOTE(JSON_EXTRACT(v_json, '$.lote')), 80),
          LEFT(JSON_UNQUOTE(JSON_EXTRACT(v_json, '$.origen')), 20),
          JSON_LENGTH(v_json, '$.detecciones'),
          IF(JSON_UNQUOTE(JSON_EXTRACT(v_json, '$.origen')) = 'WINDOWS'
             AND JSON_EXTRACT(v_json, '$.desactivarAusentes') = TRUE, 1, 0),
          LEAST(100, GREATEST(0, COALESCE(CAST(JSON_EXTRACT(v_json, '$.maxDesactivarPct') AS INT), 50))));
  SET v_lote = LAST_INSERT_ID();

  INSERT INTO CertificadosDeteccion
         (LoteId, Origen, IP, Hostname, Componente, Puerto, Almacen, NombreComun, SAN,
          EntidadEmisora, NumeroSerie, Thumbprint, FechaInicio, FechaFin, Detalle)
  SELECT v_lote,
         LEFT(COALESCE(j.Origen, JSON_UNQUOTE(JSON_EXTRACT(v_json, '$.origen'))), 20),
         LEFT(j.IP, 45), LEFT(j.Hostname, 100), LEFT(j.Componente, 150), j.Puerto, LEFT(j.Almacen, 80),
         LEFT(j.NombreComun, 150), LEFT(j.SAN, 1000), LEFT(j.EntidadEmisora, 150), LEFT(j.NumeroSerie, 100),
         LEFT(j.Thumbprint, 100),
         CAST(NULLIF(LEFT(j.FechaInicio, 10), '') AS DATE),
         CAST(NULLIF(LEFT(j.FechaFin, 10), '') AS DATE),
         LEFT(j.Detalle, 500)
    FROM JSON_TABLE(v_json, '$.detecciones[*]' COLUMNS (
           Origen         VARCHAR(50)   PATH '$.Origen',
           IP             VARCHAR(100)  PATH '$.IP',
           Hostname       VARCHAR(255)  PATH '$.Hostname',
           Componente     VARCHAR(500)  PATH '$.Componente',
           Puerto         INT           PATH '$.Puerto' NULL ON ERROR,
           Almacen        VARCHAR(200)  PATH '$.Almacen',
           NombreComun    VARCHAR(500)  PATH '$.NombreComun',
           SAN            VARCHAR(4000) PATH '$.SAN',
           EntidadEmisora VARCHAR(500)  PATH '$.EntidadEmisora',
           NumeroSerie    VARCHAR(200)  PATH '$.NumeroSerie',
           Thumbprint     VARCHAR(200)  PATH '$.Thumbprint',
           FechaInicio    VARCHAR(40)   PATH '$.FechaInicio',
           FechaFin       VARCHAR(40)   PATH '$.FechaFin',
           Detalle        VARCHAR(2000) PATH '$.Detalle'
         )) j;

  CALL sp_ProcesarDetecciones(v_lote);
END $$

DELIMITER ;

-- CREATE OR REPLACE conserva los permisos existentes; el GRANT se repite solo como
-- verificación (no tiene efecto si el permiso ya existe).
-- (DEV) GRANT EXECUTE ON PROCEDURE `BIC_CERTI_MARIA`.`sp_CargarDeteccionesB64` TO 'n8n_axis'@'192.168.125.130';



-- #####################################################################
-- 04_cobertura_servidores.sql
-- #####################################################################
-- =====================================================================
-- AXIS · BIC_CERTI_MARIA
-- 04 - Cobertura del inventario de certificados por servidor
--   * vw_CoberturaServidores : estado de verificación de cada servidor
--   * vw_CertificadosNoDetectados : incluye también los registros manuales
--     que algún colector confirmó (antes los excluía por Origen NULL)
-- Ejecutar con un usuario con CREATE VIEW (DBA). No modifica datos.
-- =====================================================================
USE BIC_CERTI_MARIA;

-- ---------------------------------------------------------------------
-- 1. Cobertura por servidor
--    EstadoCobertura:
--      AL_DIA                 todos sus certificados activos se vieron en los últimos 3 días
--      PARCIAL                se leyó el servidor, pero hay certificados activos sin confirmar
--      DESACTUALIZADO         la última lectura tiene más de 3 días (falla del colector o de acceso)
--      NUNCA_VERIFICADO       tiene certificados registrados que ningún colector ha visto
--      SIN_CERTIFICADOS       no tiene certificados activos ni lecturas (fuera de cobertura o sin TLS)
--    3 días = tolera el fin de semana de la tarea Windows (lunes a viernes).
-- ---------------------------------------------------------------------
CREATE OR REPLACE SQL SECURITY DEFINER VIEW `vw_CoberturaServidores` AS
SELECT s.Id                                   AS ServidorId,
       s.Hostname,
       s.IP,
       CASE s.SistemaOperativoId WHEN 3 THEN 'Linux' WHEN 4 THEN 'Windows' ELSE 'Otro SO' END AS SistemaOperativo,
       s.Ambiente,
       COALESCE(SUM(c.Activo = 1), 0)                                                         AS CertificadosActivos,
       COALESCE(SUM(c.Activo = 1 AND c.FechaUltimaDeteccion >= NOW() - INTERVAL 3 DAY), 0)    AS ConfirmadosRecientes,
       COALESCE(SUM(c.Activo = 1 AND (c.FechaUltimaDeteccion IS NULL
                                      OR c.FechaUltimaDeteccion < NOW() - INTERVAL 3 DAY)), 0) AS SinConfirmar,
       COALESCE(SUM(c.Activo = 1 AND c.FechaFin < CURDATE()), 0)                              AS Vencidos,
       COALESCE(SUM(c.Activo = 1 AND c.FechaFin BETWEEN CURDATE() AND CURDATE() + INTERVAL 30 DAY), 0) AS VencenEn30Dias,
       MAX(c.FechaUltimaDeteccion)                                                            AS UltimaDeteccion,
       DATEDIFF(NOW(), MAX(c.FechaUltimaDeteccion))                                           AS DiasSinLectura,
       GROUP_CONCAT(DISTINCT CASE WHEN c.FechaUltimaDeteccion IS NOT NULL THEN COALESCE(c.Origen, 'MANUAL') END
                    ORDER BY c.Origen SEPARATOR ', ')                                         AS Fuentes,
       CASE
         WHEN MAX(c.FechaUltimaDeteccion) IS NULL AND COALESCE(SUM(c.Activo = 1), 0) = 0 THEN 'SIN_CERTIFICADOS'
         WHEN MAX(c.FechaUltimaDeteccion) IS NULL                                        THEN 'NUNCA_VERIFICADO'
         WHEN MAX(c.FechaUltimaDeteccion) < NOW() - INTERVAL 3 DAY                       THEN 'DESACTUALIZADO'
         WHEN SUM(c.Activo = 1 AND (c.FechaUltimaDeteccion IS NULL
                                    OR c.FechaUltimaDeteccion < NOW() - INTERVAL 3 DAY)) > 0 THEN 'PARCIAL'
         ELSE 'AL_DIA'
       END                                                                                    AS EstadoCobertura
  FROM Servidores s
  LEFT JOIN Certificados c ON c.ServidorId = s.Id
 WHERE s.Activo = 1
 GROUP BY s.Id, s.Hostname, s.IP, s.SistemaOperativoId, s.Ambiente;

-- ---------------------------------------------------------------------
-- 2. No detectados: basta con que algún colector lo haya visto alguna vez
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW `vw_CertificadosNoDetectados` AS
SELECT c.Id, s.Hostname, s.IP, c.Componente, c.NombreComun, c.FechaFin, c.Origen, c.FechaUltimaDeteccion,
       DATEDIFF(NOW(), c.FechaUltimaDeteccion) AS DiasSinDetectar
  FROM Certificados c
  JOIN Servidores s ON s.Id = c.ServidorId
 WHERE c.Activo = 1
   AND c.FechaUltimaDeteccion IS NOT NULL
   AND c.FechaUltimaDeteccion < NOW() - INTERVAL 7 DAY;

-- ---------------------------------------------------------------------
-- 3. Permisos de lectura (n8n para la alerta diaria)
--    Si el usuario del aplicativo AXIS no tiene SELECT sobre toda la BD,
--    descomente la segunda línea con su usuario y host.
-- ---------------------------------------------------------------------
-- (DEV) GRANT SELECT ON BIC_CERTI_MARIA.vw_CoberturaServidores      TO 'n8n_axis'@'192.168.125.130';
-- (DEV) GRANT SELECT ON BIC_CERTI_MARIA.vw_CertificadosNoDetectados TO 'n8n_axis'@'192.168.125.130';
-- GRANT SELECT ON BIC_CERTI_MARIA.vw_CoberturaServidores TO '<usuario_axis>'@'<host_axis>';

-- ---------------------------------------------------------------------
-- 4. Verificación
-- ---------------------------------------------------------------------
SELECT EstadoCobertura, COUNT(*) AS Servidores
  FROM vw_CoberturaServidores
 GROUP BY EstadoCobertura
 ORDER BY Servidores DESC;


-- #####################################################################
-- 05_presencia_y_uso_certificados.sql
-- #####################################################################
-- =====================================================================
-- AXIS · BIC_CERTI_MARIA · Ajuste 05 (para el ADMINISTRADOR DE BD)
-- 1. sp_ProcesarDetecciones: nuevo paso 9b "presencia confirmada por thumbprint".
--    Si el certificado está instalado en el servidor pero AXIS lo tiene registrado
--    con otro componente, se marca como detectado (antes quedaba "sin confirmar").
-- 2. Corrección inicial: aplica la misma regla a las lecturas de los últimos 3 días.
-- 3. vw_CertificadosUso: clasifica cada certificado activo en
--      1 EN USO                 binding IIS/HTTP.SYS, puerto TLS, servicio (WMSvc, RDP,
--                               WinRM, SQL), contenedor o componente registrado
--      2 EN USO (OTRO REGISTRO) registro genérico de un certificado que en el mismo
--                               servidor ya figura en uso con otro componente
--      3 SIN USO DETECTADO      solo instalado en el almacén, sin uso identificado
--    No retira ni modifica certificados en los servidores.
-- 4. vw_CoberturaServidores: agrega VencidosEnUso y VencidosSinUso.
-- Usa CREATE OR REPLACE: conserva permisos y no elimina objetos.
-- Requiere CREATE ROUTINE / ALTER ROUTINE / CREATE VIEW.
-- =====================================================================
SET NAMES utf8mb4;
USE `BIC_CERTI_MARIA`;

-- ---------------------------------------------------------------------
-- 1. Procedimiento de carga
-- ---------------------------------------------------------------------
DELIMITER $$

CREATE OR REPLACE PROCEDURE `sp_ProcesarDetecciones`(IN p_lote INT)
BEGIN
  DECLARE v_max_id INT DEFAULT 0;

  -- 1. Normalizar y validar ------------------------------------------
  UPDATE CertificadosDeteccion
     SET ThumbprintNorm = UPPER(REPLACE(REPLACE(REPLACE(Thumbprint, ':', ''), ' ', ''), '-', '')),
         IP         = NULLIF(TRIM(IP), ''),
         Hostname   = NULLIF(UPPER(SUBSTRING_INDEX(TRIM(Hostname), '.', 1)), ''),
         Componente = NULLIF(TRIM(Componente), ''),
         Almacen    = NULLIF(TRIM(Almacen), ''),
         FechaInicio = IF(FechaInicio >= FechaFin, NULL, FechaInicio)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE';

  UPDATE CertificadosDeteccion
     SET Estado = 'RECHAZADO', Mensaje = 'Thumbprint inválido o sin fecha de vencimiento'
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE'
     AND (ThumbprintNorm IS NULL OR LENGTH(ThumbprintNorm) <> 40 OR FechaFin IS NULL);

  -- 2. Resolver servidor (IP y luego hostname) ------------------------
  UPDATE CertificadosDeteccion d
    JOIN Servidores s ON s.IP = d.IP
     SET d.ServidorId = s.Id
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE';

  UPDATE CertificadosDeteccion d
    JOIN Servidores s ON UPPER(s.Hostname) = d.Hostname
     SET d.ServidorId = s.Id
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.ServidorId IS NULL;

  UPDATE CertificadosDeteccion
     SET Estado = 'SERVIDOR_NO_REGISTRADO',
         Mensaje = LEFT(CONCAT('No existe en Servidores: ', COALESCE(IP, ''), ' ', COALESCE(Hostname, '')), 300)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND ServidorId IS NULL;

  -- 3. Resolver componente --------------------------------------------
  -- 3a. Nombre reportado = sub-aplicativo registrado
  UPDATE CertificadosDeteccion d
    JOIN Servidor_Componentes sc ON sc.ServidorId = d.ServidorId AND sc.Rol = d.Componente
     SET d.ComponenteId = sc.Id, d.ComponenteFinal = sc.Rol
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.Componente IS NOT NULL;

  UPDATE CertificadosDeteccion
     SET ComponenteFinal = LEFT(Componente, 150)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND Componente IS NOT NULL AND ComponenteFinal IS NULL;

  -- 3b. Sin nombre: sub-aplicativo por puerto
  UPDATE CertificadosDeteccion d
    JOIN Servidor_Componentes sc ON sc.ServidorId = d.ServidorId AND sc.Puerto = d.Puerto
     SET d.ComponenteId = sc.Id, d.ComponenteFinal = sc.Rol
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.ComponenteFinal IS NULL AND d.Puerto IS NOT NULL;

  -- 3c. Puerto sin sub-aplicativo registrado
  UPDATE CertificadosDeteccion
     SET ComponenteFinal = CONCAT('PUERTO ', Puerto)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND ComponenteFinal IS NULL AND Puerto IS NOT NULL;

  -- 3d. Solo presente en almacén (convención AXIS)
  UPDATE CertificadosDeteccion
     SET EsGenerico = 1,
         ComponenteFinal = IF(Almacen LIKE '%Root%', 'ALMACEN ROOT', 'SIN COMPONENTE IDENTIFICADO')
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND ComponenteFinal IS NULL;

  -- 3e. Duplicados dentro del mismo lote
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_keep AS
  SELECT MIN(Id) AS KeepId, ServidorId, ThumbprintNorm, ComponenteFinal
    FROM CertificadosDeteccion
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE'
   GROUP BY ServidorId, ThumbprintNorm, ComponenteFinal
  HAVING COUNT(*) > 1;

  UPDATE CertificadosDeteccion d
    JOIN tmp_cert_keep k
      ON k.ServidorId = d.ServidorId AND k.ThumbprintNorm = d.ThumbprintNorm AND k.ComponenteFinal = d.ComponenteFinal
     SET d.Estado = 'DUPLICADO_LOTE'
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.Id <> k.KeepId;

  -- 4. Ubicaciones ya conocidas: solo marcar detección ------------------
  CALL sp__CertTocarExactos(p_lote);

  -- 5. Identificar componente en filas genéricas existentes --------------
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_upg (
    CertId INT, DetId BIGINT, CompAnterior VARCHAR(150), CompNuevo VARCHAR(150),
    Origen VARCHAR(20), Puerto INT, ComponenteId INT
  ) DEFAULT CHARSET=utf8mb4;

  -- 5a. "SIN COMPONENTE IDENTIFICADO" -> primer uso real detectado
  INSERT INTO tmp_cert_upg
  SELECT c.Id, d.Id, c.Componente, d.ComponenteFinal, d.Origen, d.Puerto, d.ComponenteId
    FROM Certificados c
    JOIN (SELECT ServidorId, ThumbprintNorm, MIN(Id) AS DetId
            FROM CertificadosDeteccion
           WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND EsGenerico = 0
           GROUP BY ServidorId, ThumbprintNorm) p
      ON p.ServidorId = c.ServidorId AND p.ThumbprintNorm = c.ThumbprintNorm
    JOIN CertificadosDeteccion d ON d.Id = p.DetId
   WHERE c.Componente IS NULL OR c.Componente = '' OR c.Componente = 'SIN COMPONENTE IDENTIFICADO';

  -- 5b. "PUERTO n" -> nombre real del mismo puerto (IIS, contenedor, PM2)
  INSERT INTO tmp_cert_upg
  SELECT c.Id, d.Id, c.Componente, d.ComponenteFinal, d.Origen, d.Puerto, d.ComponenteId
    FROM Certificados c
    JOIN (SELECT ServidorId, ThumbprintNorm, Puerto, MIN(Id) AS DetId
            FROM CertificadosDeteccion
           WHERE LoteId = p_lote AND Estado = 'PENDIENTE' AND EsGenerico = 0
             AND Puerto IS NOT NULL AND ComponenteFinal NOT LIKE 'PUERTO %'
           GROUP BY ServidorId, ThumbprintNorm, Puerto) p
      ON p.ServidorId = c.ServidorId AND p.ThumbprintNorm = c.ThumbprintNorm AND p.Puerto = c.Puerto
    JOIN CertificadosDeteccion d ON d.Id = p.DetId
   WHERE c.Componente LIKE 'PUERTO %';

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, c.FechaInicio, c.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Componente identificado por ', u.Origen, ': ', COALESCE(NULLIF(u.CompAnterior, ''), '(vacío)'), ' -> ', u.CompNuevo), 500)
    FROM tmp_cert_upg u JOIN Certificados c ON c.Id = u.CertId;

  UPDATE Certificados c
    JOIN tmp_cert_upg u ON u.CertId = c.Id
     SET c.Componente = u.CompNuevo,
         c.Puerto = COALESCE(c.Puerto, u.Puerto),
         c.Origen = u.Origen,
         c.FechaUltimaDeteccion = NOW(),
         c.FechaUltimaActualizacion = NOW(),
         c.Activo = 1;

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_upg GROUP BY DetId) u ON u.DetId = d.Id
     SET d.Estado = 'COMPONENTE_IDENTIFICADO', d.CertificadoId = u.CertId
   WHERE d.Estado = 'PENDIENTE';

  CALL sp__CertTocarExactos(p_lote);

  -- 6. Renovación: mismo servidor + componente (o puerto) + nombre común,
  --    thumbprint nuevo y más vigente, y el anterior ya no aparece -------
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_ren AS
  SELECT c.Id AS CertId, MIN(d.Id) AS DetId
    FROM CertificadosDeteccion d
    JOIN Certificados c
      ON c.ServidorId = d.ServidorId
     AND (c.Componente = d.ComponenteFinal OR (d.Puerto IS NOT NULL AND c.Puerto = d.Puerto))
     AND c.ThumbprintNorm <> d.ThumbprintNorm
     AND c.FechaFin < d.FechaFin
     AND COALESCE(c.NombreComun, '') = COALESCE(d.NombreComun, '')
     AND c.Activo = 1
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.EsGenerico = 0
     AND NOT EXISTS (SELECT 1 FROM CertificadosDeteccion d2
                      WHERE d2.LoteId = p_lote AND d2.ServidorId = c.ServidorId
                        AND d2.ThumbprintNorm = c.ThumbprintNorm)
   GROUP BY c.Id;

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Renovación detectada por ', d.Origen, ' en ', d.ComponenteFinal,
                     ': ', c.ThumbprintNorm, ' -> ', d.ThumbprintNorm), 500)
    FROM tmp_cert_ren r
    JOIN Certificados c ON c.Id = r.CertId
    JOIN CertificadosDeteccion d ON d.Id = r.DetId;

  UPDATE Certificados c
    JOIN tmp_cert_ren r ON r.CertId = c.Id
    JOIN CertificadosDeteccion d ON d.Id = r.DetId
     SET c.Thumbprint = REGEXP_REPLACE(d.ThumbprintNorm, '(..)(?!$)', '\\1:'),
         c.NumeroSerie = COALESCE(d.NumeroSerie, c.NumeroSerie),
         c.EntidadEmisora = COALESCE(d.EntidadEmisora, c.EntidadEmisora),
         c.FechaInicio = d.FechaInicio,
         c.FechaFin = d.FechaFin,
         c.Componente = IF(c.Componente LIKE 'PUERTO %' AND d.ComponenteFinal NOT LIKE 'PUERTO %', d.ComponenteFinal, c.Componente),
         c.Puerto = COALESCE(c.Puerto, d.Puerto),
         c.Origen = d.Origen,
         c.FechaUltimaDeteccion = NOW(),
         c.FechaUltimaActualizacion = NOW();

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_ren GROUP BY DetId) r ON r.DetId = d.Id
     SET d.Estado = 'RENOVADO', d.CertificadoId = r.CertId
   WHERE d.Estado = 'PENDIENTE';

  CALL sp__CertTocarExactos(p_lote);

  -- 7. Genérico "SIN COMPONENTE": si el certificado ya figura en el servidor
  --    con otro componente (no Root), solo se marca como detectado ----------
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_gen AS
  SELECT d.Id AS DetId, c.Id AS CertId
    FROM CertificadosDeteccion d
    JOIN Certificados c
      ON c.ServidorId = d.ServidorId AND c.ThumbprintNorm = d.ThumbprintNorm
     AND c.Componente <> 'ALMACEN ROOT'
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE' AND d.EsGenerico = 1
     AND d.ComponenteFinal = 'SIN COMPONENTE IDENTIFICADO';

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Fechas corregidas según el certificado detectado por ', d.Origen, ' (', c.ThumbprintNorm, ')'), 500)
    FROM tmp_cert_gen g
    JOIN Certificados c ON c.Id = g.CertId
    JOIN CertificadosDeteccion d ON d.Id = g.DetId
   WHERE c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio);

  UPDATE Certificados c
    JOIN tmp_cert_gen g ON g.CertId = c.Id
    JOIN CertificadosDeteccion d ON d.Id = g.DetId
     SET c.FechaUltimaActualizacion = IF(c.FechaFin <> d.FechaFin OR NOT (c.FechaInicio <=> d.FechaInicio), NOW(), c.FechaUltimaActualizacion),
         c.FechaFin = d.FechaFin,
         c.FechaInicio = d.FechaInicio,
         c.NumeroSerie = COALESCE(d.NumeroSerie, c.NumeroSerie),
         c.FechaUltimaDeteccion = NOW(), c.Activo = 1;

  UPDATE CertificadosDeteccion d
    JOIN (SELECT DetId, MIN(CertId) AS CertId FROM tmp_cert_gen GROUP BY DetId) g ON g.DetId = d.Id
     SET d.Estado = 'ACTUALIZADO', d.CertificadoId = g.CertId;

  -- 8. Ubicaciones nuevas ----------------------------------------------
  SELECT COALESCE(MAX(Id), 0) INTO v_max_id FROM Certificados;

  INSERT INTO Certificados
         (AplicacionId, ServidorId, Componente, NombreComun, EntidadEmisora, NumeroSerie, Thumbprint, Puerto,
          FechaInicio, FechaFin, Responsable, Observaciones, Activo, Origen, FechaUltimaDeteccion)
  SELECT (SELECT MIN(ac.AplicacionId) FROM Aplicacion_Componente ac WHERE ac.ComponenteId = d.ComponenteId),
         d.ServidorId, d.ComponenteFinal, d.NombreComun, d.EntidadEmisora, d.NumeroSerie,
         REGEXP_REPLACE(d.ThumbprintNorm, '(..)(?!$)', '\\1:'),
         d.Puerto, d.FechaInicio, d.FechaFin, NULL,
         LEFT(CONCAT('Detectado por ', d.Origen,
                     IF(d.Almacen IS NULL, '', CONCAT(' | Almacén: ', d.Almacen)),
                     IF(d.Detalle IS NULL, '', CONCAT(' | ', d.Detalle))), 500),
         1, d.Origen, NOW()
    FROM CertificadosDeteccion d
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE'
   ORDER BY d.Id;

  UPDATE CertificadosDeteccion d
    JOIN Certificados c
      ON c.Id > v_max_id
     AND c.ServidorId = d.ServidorId AND c.ThumbprintNorm = d.ThumbprintNorm AND c.Componente = d.ComponenteFinal
     SET d.Estado = 'INSERTADO', d.CertificadoId = c.Id
   WHERE d.LoteId = p_lote AND d.Estado = 'PENDIENTE';

  INSERT INTO HistoricoCertificados
         (CertificadoId, Accion, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
  SELECT d.CertificadoId, 'ALTA', d.FechaInicio, d.FechaFin, 'N8N-DESCUBRIMIENTO',
         LEFT(CONCAT('Alta automática por ', d.Origen, ' en ', d.ComponenteFinal), 500)
    FROM CertificadosDeteccion d
   WHERE d.LoteId = p_lote AND d.Estado = 'INSERTADO';

  -- 9. Aplicaciones de negocio vía sub-aplicativo ------------------------
  INSERT IGNORE INTO Certificado_Aplicacion (CertificadoId, AplicacionId, Origen)
  SELECT DISTINCT d.CertificadoId, ac.AplicacionId, 'AUTO'
    FROM CertificadosDeteccion d
    JOIN Aplicacion_Componente ac ON ac.ComponenteId = d.ComponenteId
   WHERE d.LoteId = p_lote AND d.CertificadoId IS NOT NULL;

  UPDATE Certificados c
    JOIN (SELECT CertificadoId, MIN(AplicacionId) AS AplicacionId
            FROM Certificado_Aplicacion GROUP BY CertificadoId) ca ON ca.CertificadoId = c.Id
    JOIN CertificadosDeteccion d ON d.CertificadoId = c.Id AND d.LoteId = p_lote
     SET c.AplicacionId = ca.AplicacionId
   WHERE c.AplicacionId IS NULL;

  -- 9b. Presencia confirmada por thumbprint ------------------------------
  --     El certificado está instalado en el servidor aunque el registro de AXIS
  --     tenga otro componente (p. ej. PORTAL_PRIVADO vs. sitio IIS BancaLinea, o
  --     "SIN COMPONENTE" vs. "ALMACEN ROOT"). Solo marca la detección: no cambia
  --     componente, origen ni aplicación del registro existente.
  CREATE OR REPLACE TEMPORARY TABLE tmp_cert_pres AS
  SELECT c.Id AS CertId, c.ServidorId
    FROM Certificados c
    JOIN (SELECT DISTINCT ServidorId, ThumbprintNorm
            FROM CertificadosDeteccion
           WHERE LoteId = p_lote AND ServidorId IS NOT NULL AND ThumbprintNorm IS NOT NULL
             AND Estado IN ('ACTUALIZADO', 'INSERTADO', 'RENOVADO', 'COMPONENTE_IDENTIFICADO', 'DUPLICADO_LOTE')) p
      ON p.ServidorId = c.ServidorId AND p.ThumbprintNorm = c.ThumbprintNorm
   WHERE c.Activo = 1
     AND NOT EXISTS (SELECT 1 FROM CertificadosDeteccion d
                      WHERE d.LoteId = p_lote AND d.CertificadoId = c.Id);

  UPDATE Certificados c JOIN tmp_cert_pres p ON p.CertId = c.Id
     SET c.FechaUltimaDeteccion = NOW();

  INSERT INTO CertificadosDeteccion (LoteId, Origen, ServidorId, Estado, Mensaje, CertificadoId)
  SELECT p_lote, (SELECT Origen FROM CertificadosLotes WHERE Id = p_lote), c.ServidorId, 'PRESENCIA_CONFIRMADA',
         LEFT(CONCAT('Instalado en el servidor con otro componente: ', COALESCE(c.NombreComun, ''), ' · ', COALESCE(c.Componente, '')), 300),
         c.Id
    FROM tmp_cert_pres p JOIN Certificados c ON c.Id = p.CertId;

  DROP TEMPORARY TABLE IF EXISTS tmp_cert_pres;

  -- 10. Inventario completo Windows: ubicaciones que ya no existen -------
  IF (SELECT DesactivarAusentes FROM CertificadosLotes WHERE Id = p_lote) = 1 THEN
    CREATE OR REPLACE TEMPORARY TABLE tmp_cert_aus AS
    SELECT c.Id AS CertId
      FROM Certificados c
     WHERE c.Activo = 1
       AND (c.Origen IS NULL OR c.Origen = 'WINDOWS')
       AND c.ServidorId IN (SELECT DISTINCT ServidorId FROM CertificadosDeteccion
                             WHERE LoteId = p_lote AND ServidorId IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM CertificadosDeteccion d
                        WHERE d.LoteId = p_lote AND d.ServidorId = c.ServidorId
                          AND d.ThumbprintNorm = c.ThumbprintNorm);

    -- Protección contra inventarios incompletos
    CREATE OR REPLACE TEMPORARY TABLE tmp_cert_aus_srv AS
    SELECT c.ServidorId, COUNT(*) AS Ausentes,
           (SELECT COUNT(*) FROM Certificados c2 WHERE c2.ServidorId = c.ServidorId AND c2.Activo = 1) AS Activos
      FROM tmp_cert_aus a JOIN Certificados c ON c.Id = a.CertId
     GROUP BY c.ServidorId;

    INSERT INTO CertificadosDeteccion (LoteId, Origen, ServidorId, Estado, Mensaje)
    SELECT p_lote, 'WINDOWS', s.ServidorId, 'DESACTIVACION_OMITIDA',
           CONCAT('Se omitió: ', s.Ausentes, ' de ', s.Activos, ' ubicaciones activas no aparecen (supera el ',
                  l.MaxDesactivarPct, '%). Revisar el inventario o reenviar con maxDesactivarPct mayor.')
      FROM tmp_cert_aus_srv s JOIN CertificadosLotes l ON l.Id = p_lote
     WHERE s.Ausentes * 100 > s.Activos * l.MaxDesactivarPct;

    DELETE a FROM tmp_cert_aus a
      JOIN Certificados c ON c.Id = a.CertId
      JOIN tmp_cert_aus_srv s ON s.ServidorId = c.ServidorId
      JOIN CertificadosLotes l ON l.Id = p_lote
     WHERE s.Ausentes * 100 > s.Activos * l.MaxDesactivarPct;

    INSERT INTO HistoricoCertificados
           (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
    SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, c.FechaInicio, c.FechaFin, 'N8N-DESCUBRIMIENTO',
           'Desactivado: el certificado ya no está instalado en el servidor (inventario completo WINDOWS)'
      FROM tmp_cert_aus a JOIN Certificados c ON c.Id = a.CertId;

    UPDATE Certificados c JOIN tmp_cert_aus a ON a.CertId = c.Id
       SET c.Activo = 0, c.FechaUltimaActualizacion = NOW();

    INSERT INTO CertificadosDeteccion (LoteId, Origen, ServidorId, Estado, Mensaje, CertificadoId)
    SELECT p_lote, 'WINDOWS', c.ServidorId, 'DESACTIVADO_AUSENTE', LEFT(CONCAT(COALESCE(c.NombreComun,''), ' · ', COALESCE(c.Componente,'')), 300), c.Id
      FROM tmp_cert_aus a JOIN Certificados c ON c.Id = a.CertId;

    DROP TEMPORARY TABLE IF EXISTS tmp_cert_aus;
    DROP TEMPORARY TABLE IF EXISTS tmp_cert_aus_srv;
  END IF;

  -- 11. Resumen --------------------------------------------------------
  UPDATE CertificadosLotes l
     SET l.FechaProceso = NOW(),
         l.Resumen = (SELECT GROUP_CONCAT(CONCAT(x.Estado, '=', x.n) ORDER BY x.Estado SEPARATOR ', ')
                        FROM (SELECT Estado, COUNT(*) AS n FROM CertificadosDeteccion
                               WHERE LoteId = p_lote GROUP BY Estado) x)
   WHERE l.Id = p_lote;

  DROP TEMPORARY TABLE IF EXISTS tmp_cert_keep;
  DROP TEMPORARY TABLE IF EXISTS tmp_cert_upg;
  DROP TEMPORARY TABLE IF EXISTS tmp_cert_ren;
  DROP TEMPORARY TABLE IF EXISTS tmp_cert_gen;

  SELECT p_lote AS LoteId, Estado, COUNT(*) AS Total
    FROM CertificadosDeteccion
   WHERE LoteId = p_lote
   GROUP BY Estado
   ORDER BY Estado;
END $$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 2. Corrección inicial (única vez): certificados instalados que quedaron
--    "sin confirmar" solo por tener otro componente en AXIS. Toma la fecha
--    real de la última lectura del mismo servidor + thumbprint.
-- ---------------------------------------------------------------------
UPDATE Certificados c
  JOIN (SELECT ServidorId, ThumbprintNorm, MAX(FechaDeteccion) AS Ultima
          FROM CertificadosDeteccion
         WHERE FechaDeteccion >= NOW() - INTERVAL 3 DAY
           AND ServidorId IS NOT NULL AND ThumbprintNorm IS NOT NULL
           AND Estado IN ('ACTUALIZADO', 'INSERTADO', 'RENOVADO', 'COMPONENTE_IDENTIFICADO', 'DUPLICADO_LOTE')
         GROUP BY ServidorId, ThumbprintNorm) d
    ON d.ServidorId = c.ServidorId AND d.ThumbprintNorm = c.ThumbprintNorm
   SET c.FechaUltimaDeteccion = d.Ultima
 WHERE c.Activo = 1
   AND (c.FechaUltimaDeteccion IS NULL OR c.FechaUltimaDeteccion < d.Ultima);

SELECT ROW_COUNT() AS CertificadosConfirmados;

-- ---------------------------------------------------------------------
-- 3. Uso de cada certificado activo
-- ---------------------------------------------------------------------
CREATE OR REPLACE SQL SECURITY DEFINER VIEW `vw_CertificadosUso` AS
SELECT c.Id                                   AS CertificadoId,
       s.Hostname,
       s.IP,
       CASE s.SistemaOperativoId WHEN 3 THEN 'Linux' WHEN 4 THEN 'Windows' ELSE 'Otro SO' END AS SistemaOperativo,
       c.Componente,
       c.NombreComun,
       c.EntidadEmisora,
       c.FechaFin,
       DATEDIFF(c.FechaFin, CURDATE())        AS DiasRestantes,
       CASE WHEN c.FechaFin < CURDATE()                         THEN 'VENCIDO'
            WHEN c.FechaFin <= CURDATE() + INTERVAL 30 DAY      THEN 'POR VENCER'
            ELSE 'VIGENTE' END                AS Vigencia,
       CASE WHEN NOT (c.Componente IS NULL OR c.Componente = '' OR c.Componente LIKE 'ALMACEN %' OR c.Componente = 'SIN COMPONENTE IDENTIFICADO') THEN 1
            WHEN EXISTS (SELECT 1 FROM Certificados c2
                          WHERE c2.ServidorId = c.ServidorId AND c2.ThumbprintNorm = c.ThumbprintNorm
                            AND c2.Activo = 1 AND c2.Id <> c.Id
                            AND NOT (c2.Componente IS NULL OR c2.Componente = '' OR c2.Componente LIKE 'ALMACEN %' OR c2.Componente = 'SIN COMPONENTE IDENTIFICADO')) THEN 2
            ELSE 3 END                        AS UsoCodigo,
       CASE WHEN NOT (c.Componente IS NULL OR c.Componente = '' OR c.Componente LIKE 'ALMACEN %' OR c.Componente = 'SIN COMPONENTE IDENTIFICADO') THEN 'EN USO'
            WHEN EXISTS (SELECT 1 FROM Certificados c2
                          WHERE c2.ServidorId = c.ServidorId AND c2.ThumbprintNorm = c.ThumbprintNorm
                            AND c2.Activo = 1 AND c2.Id <> c.Id
                            AND NOT (c2.Componente IS NULL OR c2.Componente = '' OR c2.Componente LIKE 'ALMACEN %' OR c2.Componente = 'SIN COMPONENTE IDENTIFICADO')) THEN 'EN USO (OTRO REGISTRO)'
            ELSE 'SIN USO DETECTADO' END      AS Uso,
       c.Thumbprint,
       c.Origen,
       c.FechaUltimaDeteccion
  FROM Certificados c
  JOIN Servidores s ON s.Id = c.ServidorId
 WHERE c.Activo = 1;

-- ---------------------------------------------------------------------
-- 4. Cobertura por servidor con vencidos separados por uso
-- ---------------------------------------------------------------------
CREATE OR REPLACE SQL SECURITY DEFINER VIEW `vw_CoberturaServidores` AS
SELECT s.Id                                   AS ServidorId,
       s.Hostname,
       s.IP,
       CASE s.SistemaOperativoId WHEN 3 THEN 'Linux' WHEN 4 THEN 'Windows' ELSE 'Otro SO' END AS SistemaOperativo,
       s.Ambiente,
       COALESCE(SUM(c.Activo = 1), 0)                                                         AS CertificadosActivos,
       COALESCE(SUM(c.Activo = 1 AND c.FechaUltimaDeteccion >= NOW() - INTERVAL 3 DAY), 0)    AS ConfirmadosRecientes,
       COALESCE(SUM(c.Activo = 1 AND (c.FechaUltimaDeteccion IS NULL
                                      OR c.FechaUltimaDeteccion < NOW() - INTERVAL 3 DAY)), 0) AS SinConfirmar,
       COALESCE(SUM(c.Activo = 1 AND c.FechaFin < CURDATE()), 0)                              AS Vencidos,
       COALESCE(SUM(c.Activo = 1 AND c.FechaFin < CURDATE() AND NOT (c.Componente IS NULL OR c.Componente = '' OR c.Componente LIKE 'ALMACEN %' OR c.Componente = 'SIN COMPONENTE IDENTIFICADO')), 0)                  AS VencidosEnUso,
       COALESCE(SUM(c.Activo = 1 AND c.FechaFin < CURDATE() AND (c.Componente IS NULL OR c.Componente = '' OR c.Componente LIKE 'ALMACEN %' OR c.Componente = 'SIN COMPONENTE IDENTIFICADO')), 0)                      AS VencidosSinUso,
       COALESCE(SUM(c.Activo = 1 AND c.FechaFin BETWEEN CURDATE() AND CURDATE() + INTERVAL 30 DAY), 0) AS VencenEn30Dias,
       MAX(c.FechaUltimaDeteccion)                                                            AS UltimaDeteccion,
       DATEDIFF(NOW(), MAX(c.FechaUltimaDeteccion))                                           AS DiasSinLectura,
       GROUP_CONCAT(DISTINCT CASE WHEN c.FechaUltimaDeteccion IS NOT NULL THEN COALESCE(c.Origen, 'MANUAL') END
                    ORDER BY c.Origen SEPARATOR ', ')                                         AS Fuentes,
       CASE
         WHEN MAX(c.FechaUltimaDeteccion) IS NULL AND COALESCE(SUM(c.Activo = 1), 0) = 0 THEN 'SIN_CERTIFICADOS'
         WHEN MAX(c.FechaUltimaDeteccion) IS NULL                                        THEN 'NUNCA_VERIFICADO'
         WHEN MAX(c.FechaUltimaDeteccion) < NOW() - INTERVAL 3 DAY                       THEN 'DESACTUALIZADO'
         WHEN SUM(c.Activo = 1 AND (c.FechaUltimaDeteccion IS NULL
                                    OR c.FechaUltimaDeteccion < NOW() - INTERVAL 3 DAY)) > 0 THEN 'PARCIAL'
         ELSE 'AL_DIA'
       END                                                                                    AS EstadoCobertura
  FROM Servidores s
  LEFT JOIN Certificados c ON c.ServidorId = s.Id
 WHERE s.Activo = 1
 GROUP BY s.Id, s.Hostname, s.IP, s.SistemaOperativoId, s.Ambiente;

-- ---------------------------------------------------------------------
-- 5. Permisos (CREATE OR REPLACE conserva los existentes)
-- ---------------------------------------------------------------------
-- (DEV) GRANT EXECUTE ON PROCEDURE `BIC_CERTI_MARIA`.`sp_CargarDeteccionesB64` TO 'n8n_axis'@'192.168.125.130';
-- (DEV) GRANT SELECT ON BIC_CERTI_MARIA.vw_CertificadosUso     TO 'n8n_axis'@'192.168.125.130';
-- (DEV) GRANT SELECT ON BIC_CERTI_MARIA.vw_CoberturaServidores TO 'n8n_axis'@'192.168.125.130';
-- GRANT SELECT ON BIC_CERTI_MARIA.vw_CertificadosUso TO '<usuario_axis>'@'<host_axis>';

-- ---------------------------------------------------------------------
-- 6. Verificación
-- ---------------------------------------------------------------------
SELECT UsoCodigo, Uso, COUNT(*) AS Activos,
       SUM(FechaFin < CURDATE()) AS Vencidos,
       SUM(FechaFin BETWEEN CURDATE() AND CURDATE() + INTERVAL 30 DAY) AS VencenEn30Dias
  FROM vw_CertificadosUso
 GROUP BY UsoCodigo, Uso
 ORDER BY UsoCodigo;

SELECT EstadoCobertura, COUNT(*) AS Servidores
  FROM vw_CoberturaServidores
 GROUP BY EstadoCobertura;


-- #####################################################################
-- Verificación final DEV
-- #####################################################################
SELECT 'Certificados.FechaUltimaDeteccion' AS Objeto, COUNT(*) AS Existe FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Certificados' AND COLUMN_NAME = 'FechaUltimaDeteccion'
UNION ALL SELECT 'Tablas nuevas', COUNT(*) FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('CertificadosLotes','CertificadosDeteccion','Certificado_Aplicacion')
UNION ALL SELECT 'Vistas nuevas', COUNT(*) FROM information_schema.VIEWS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('vw_CertificadosAlertas','vw_CertificadosNoDetectados','vw_PuertosTlsSinSubaplicativo',
                                                   'vw_DeteccionesPendientes','vw_CoberturaServidores','vw_CertificadosUso')
UNION ALL SELECT 'Procedimientos', COUNT(*) FROM information_schema.ROUTINES
 WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_NAME IN ('sp__CertTocarExactos','sp_ProcesarDetecciones','sp_CargarDeteccionesB64');
-- Esperado: 1, 3, 6, 3
