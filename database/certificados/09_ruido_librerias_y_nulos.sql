-- =====================================================================
-- AXIS · BIC_CERTI_MARIA · 09 - Ruido de librerías y caracteres nulos
-- 1. sp_ProcesarDetecciones (versión 05 + paso 1b):
--    * Limpia caracteres nulos (\0) en NombreComun, SAN y EntidadEmisora.
--    * Descarta (Estado DESCARTADO_PRUEBA) los certificados que vienen de
--      archivos de prueba o ejemplo de librerías dentro de los contenedores:
--      rutas con site-packages, dist-packages, node_modules, /test/, /tests/,
--      /demo/, /example(s)/, /sample(s)/, /fixtures/ ...
-- 2. Limpieza única de lo que ya está cargado:
--    * Desactiva (Activo = 0, con histórico) los certificados de PORTAINER
--      cargados desde esas rutas. No borra nada.
--    * Quita los caracteres nulos de los textos ya guardados.
-- Ejecutar primero en DEV. En PROD lo ejecuta el DBA (CREATE OR REPLACE
-- conserva los permisos del procedimiento).
-- =====================================================================
SET NAMES utf8mb4;
USE `BIC_CERTI_MARIA`;

-- ---------------------------------------------------------------------
-- 0. Vista previa: lo que se va a desactivar (revisar antes de continuar)
-- ---------------------------------------------------------------------
SELECT c.Id, s.Hostname, c.Componente, c.NombreComun, c.FechaFin,
       SUBSTRING_INDEX(SUBSTRING_INDEX(c.Observaciones, 'Archivo ', -1), ' |', 1) AS Archivo
  FROM Certificados c
  JOIN Servidores s ON s.Id = c.ServidorId
 WHERE c.Activo = 1
   AND c.Origen = 'PORTAINER'
   AND c.Observaciones REGEXP '/(site-packages|dist-packages|node_modules)/|/(test|tests|testing|testdata|test_data|demo|demos|example|examples|sample|samples|fixtures)/'
 ORDER BY s.Hostname, c.Componente;

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

  -- 1b. Limpieza de texto y descarte de certificados de prueba ---------
  --     Caracteres nulos (\0) en CN/SAN/emisor (p. ej. nullbytecert.pem).
  UPDATE CertificadosDeteccion
     SET NombreComun    = NULLIF(TRIM(REGEXP_REPLACE(NombreComun, '\\x00', ' ')), ''),
         EntidadEmisora = NULLIF(TRIM(REGEXP_REPLACE(EntidadEmisora, '\\x00', ' ')), ''),
         SAN            = NULLIF(TRIM(REGEXP_REPLACE(SAN, '\\x00', ' ')), '')
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE';

  --     Archivos de prueba/ejemplo que traen las librerías dentro de los
  --     contenedores (suite de pruebas de Python, demos, node_modules...).
  UPDATE CertificadosDeteccion
     SET Estado = 'DESCARTADO_PRUEBA',
         Mensaje = LEFT(CONCAT('Certificado de prueba/ejemplo de una librería: ', COALESCE(Detalle, '')), 300)
   WHERE LoteId = p_lote AND Estado = 'PENDIENTE'
     AND Detalle REGEXP '/(site-packages|dist-packages|node_modules)/|/(test|tests|testing|testdata|test_data|demo|demos|example|examples|sample|samples|fixtures)/';

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
-- 2. Limpieza única
-- ---------------------------------------------------------------------
CREATE OR REPLACE TEMPORARY TABLE tmp_cert_ruido AS
SELECT c.Id AS CertId
  FROM Certificados c
 WHERE c.Activo = 1
   AND c.Origen = 'PORTAINER'
   AND c.Observaciones REGEXP '/(site-packages|dist-packages|node_modules)/|/(test|tests|testing|testdata|test_data|demo|demos|example|examples|sample|samples|fixtures)/';

INSERT INTO HistoricoCertificados
       (CertificadoId, Accion, FechaInicioAnterior, FechaFinAnterior, FechaInicioNueva, FechaFinNueva, UsuarioSistema, Observaciones)
SELECT c.Id, 'ACTUALIZACIÓN', c.FechaInicio, c.FechaFin, c.FechaInicio, c.FechaFin, 'N8N-DESCUBRIMIENTO',
       'Desactivado: certificado de prueba/ejemplo de una librería del contenedor (no es de la aplicación)'
  FROM tmp_cert_ruido r JOIN Certificados c ON c.Id = r.CertId;

UPDATE Certificados c JOIN tmp_cert_ruido r ON r.CertId = c.Id
   SET c.Activo = 0, c.FechaUltimaActualizacion = NOW();

SELECT ROW_COUNT() AS CertificadosDesactivados;
DROP TEMPORARY TABLE IF EXISTS tmp_cert_ruido;

UPDATE Certificados
   SET NombreComun    = TRIM(REGEXP_REPLACE(NombreComun, '\\x00', ' ')),
       EntidadEmisora = TRIM(REGEXP_REPLACE(EntidadEmisora, '\\x00', ' '))
 WHERE NombreComun REGEXP '\\x00' OR EntidadEmisora REGEXP '\\x00';

SELECT ROW_COUNT() AS TextosConNuloCorregidos;

-- GRANT EXECUTE ON PROCEDURE `BIC_CERTI_MARIA`.`sp_CargarDeteccionesB64` TO 'n8n_axis'@'192.168.125.130';  -- solo PROD, si hiciera falta
