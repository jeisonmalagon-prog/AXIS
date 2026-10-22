-- =====================================================================
-- 08 · SOLO DEV · Verificación después de restaurar en DEV las 55 tablas de
-- producción (dump-BIC_CERTI_MARIA-202610221106.sql).
-- Ejecutar completo en la conexión <AXIS DESARROLLO>. Solo consulta, no modifica.
-- =====================================================================
USE `BIC_CERTI_MARIA`;

-- 1. Servidor correcto (debe ser el de DEV, no 192.168.118.84)
SELECT @@hostname AS ServidorBD, @@version AS Version, DATABASE() AS BaseDatos;

-- 2. Filas cargadas (comparar con producción)
SELECT 'Servidores' AS Tabla, COUNT(*) AS Filas FROM Servidores
UNION ALL SELECT 'Aplicaciones', COUNT(*) FROM Aplicaciones
UNION ALL SELECT 'Servidor_Componentes', COUNT(*) FROM Servidor_Componentes
UNION ALL SELECT 'Certificados', COUNT(*) FROM Certificados
UNION ALL SELECT 'Certificados activos', COUNT(*) FROM Certificados WHERE Activo = 1
UNION ALL SELECT 'HistoricoCertificados', COUNT(*) FROM HistoricoCertificados
UNION ALL SELECT 'CertificadosLotes', COUNT(*) FROM CertificadosLotes
UNION ALL SELECT 'CertificadosDeteccion', COUNT(*) FROM CertificadosDeteccion
UNION ALL SELECT 'Certificado_Aplicacion', COUNT(*) FROM Certificado_Aplicacion;

-- 3. Las vistas y la pantalla siguen funcionando sobre las tablas restauradas
SELECT 'VW_CertificadosVigencia' AS Vista, COUNT(*) AS Filas FROM VW_CertificadosVigencia
UNION ALL SELECT 'vw_CertificadosUso', COUNT(*) FROM vw_CertificadosUso
UNION ALL SELECT 'vw_CoberturaServidores', COUNT(*) FROM vw_CoberturaServidores
UNION ALL SELECT 'vw_CertificadosAlertas', COUNT(*) FROM vw_CertificadosAlertas;

SELECT Uso, Evidencia, COUNT(*) AS Ubicaciones
  FROM VW_CertificadosVigencia
 GROUP BY UsoCodigo, Uso, EvidenciaCodigo, Evidencia
 ORDER BY UsoCodigo, EvidenciaCodigo;

-- 4. Referencias de tablas que SOLO existen en DEV hacia las tablas restauradas.
--    Huerfanos > 0 = registros de DEV que apuntan a un Id que ya no existe.
SELECT 'inv_aplicativo_conexiones_bd.aplicativo_id -> Aplicaciones' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativo_conexiones_bd` x LEFT JOIN `Aplicaciones` r ON r.Id = x.`aplicativo_id` WHERE x.`aplicativo_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_aplicativo_conexiones_bd.servidor_bd_id -> Servidores' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativo_conexiones_bd` x LEFT JOIN `Servidores` r ON r.Id = x.`servidor_bd_id` WHERE x.`servidor_bd_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_aplicativo_integraciones.aplicativo_origen_id -> Aplicaciones' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativo_integraciones` x LEFT JOIN `Aplicaciones` r ON r.Id = x.`aplicativo_origen_id` WHERE x.`aplicativo_origen_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_aplicativo_integraciones.aplicativo_destino_id -> Aplicaciones' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativo_integraciones` x LEFT JOIN `Aplicaciones` r ON r.Id = x.`aplicativo_destino_id` WHERE x.`aplicativo_destino_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_aplicativo_integraciones.servidor_destino_id -> Servidores' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativo_integraciones` x LEFT JOIN `Servidores` r ON r.Id = x.`servidor_destino_id` WHERE x.`servidor_destino_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_aplicativo_servicios_bus.aplicativo_id -> Aplicaciones' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativo_servicios_bus` x LEFT JOIN `Aplicaciones` r ON r.Id = x.`aplicativo_id` WHERE x.`aplicativo_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_aplicativo_servicios_bus.servicio_id -> AceServiciosInventario' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativo_servicios_bus` x LEFT JOIN `AceServiciosInventario` r ON r.Id = x.`servicio_id` WHERE x.`servicio_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_aplicativos.aplicacion_id -> Aplicaciones' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativos` x LEFT JOIN `Aplicaciones` r ON r.Id = x.`aplicacion_id` WHERE x.`aplicacion_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_aplicativos.aplicacion_negocio_id -> Aplicaciones' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativos` x LEFT JOIN `Aplicaciones` r ON r.Id = x.`aplicacion_negocio_id` WHERE x.`aplicacion_negocio_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_aplicativos.certificado_id -> Certificados' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_aplicativos` x LEFT JOIN `Certificados` r ON r.Id = x.`certificado_id` WHERE x.`certificado_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_servidor_integraciones.servidor_origen_id -> Servidores' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_servidor_integraciones` x LEFT JOIN `Servidores` r ON r.Id = x.`servidor_origen_id` WHERE x.`servidor_origen_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_servidor_integraciones.servidor_destino_id -> Servidores' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_servidor_integraciones` x LEFT JOIN `Servidores` r ON r.Id = x.`servidor_destino_id` WHERE x.`servidor_destino_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_servidor_integraciones.aplicativo_destino_id -> Aplicaciones' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_servidor_integraciones` x LEFT JOIN `Aplicaciones` r ON r.Id = x.`aplicativo_destino_id` WHERE x.`aplicativo_destino_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_servidores.servidor_id -> Servidores' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_servidores` x LEFT JOIN `Servidores` r ON r.Id = x.`servidor_id` WHERE x.`servidor_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'inv_servidores.certificado_id -> Certificados' AS Referencia, COUNT(*) AS Huerfanos FROM `inv_servidores` x LEFT JOIN `Certificados` r ON r.Id = x.`certificado_id` WHERE x.`certificado_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'monitoreo_servidores.servidor_id -> Servidores' AS Referencia, COUNT(*) AS Huerfanos FROM `monitoreo_servidores` x LEFT JOIN `Servidores` r ON r.Id = x.`servidor_id` WHERE x.`servidor_id` IS NOT NULL AND r.Id IS NULL
UNION ALL
SELECT 'PasosProduccionBusServicios.ServicioId -> AceServiciosInventario' AS Referencia, COUNT(*) AS Huerfanos FROM `PasosProduccionBusServicios` x LEFT JOIN `AceServiciosInventario` r ON r.Id = x.`ServicioId` WHERE x.`ServicioId` IS NOT NULL AND r.Id IS NULL;
