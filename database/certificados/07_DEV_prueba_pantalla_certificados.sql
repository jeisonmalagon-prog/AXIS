-- 07 · SOLO DEV · Prueba de la pantalla de Certificados (localhost:4200/certificados)
-- Simula una carga del colector Windows en FABOGAPPLIN07 (192.168.125.68):
--   * fabogapplin07.finandina.corp -> se confirma (Última detección = hoy)
--   * certificado-de-prueba.finandina.corp -> certificado nuevo en el almacén ("Sin uso detectado")
-- NO ejecutar en producción.
USE `BIC_CERTI_MARIA`;
-- Prueba en DEV: simula que el colector Windows encontró 2 certificados en FABOGAPPLIN07
CALL sp_CargarDeteccionesB64(TO_BASE64(JSON_OBJECT(
  'lote', 'PRUEBA-DEV-UI',
  'origen', 'WINDOWS',
  'detecciones', JSON_ARRAY(
    JSON_OBJECT('IP','192.168.125.68','Hostname','FABOGAPPLIN07','Componente','MS_RADICACION_ALIADOS','Puerto',443,
                'NombreComun','fabogapplin07.finandina.corp','EntidadEmisora','SUBCA-BFA',
                'NumeroSerie','619063096205959656656096567505980091920933581544',
                'Thumbprint','E4:02:D2:D8:0C:BE:CE:C5:F7:31:18:F1:94:EC:6C:E9:AC:8B:93:6D',
                'FechaInicio','2026-06-10','FechaFin','2027-06-10'),
    JSON_OBJECT('IP','192.168.125.68','Hostname','FABOGAPPLIN07','Almacen','LocalMachine\\Root',
                'NombreComun','certificado-de-prueba.finandina.corp','EntidadEmisora','SUBCA-BFA',
                'Thumbprint','0123456789ABCDEF0123456789ABCDEF01234567',
                'FechaInicio','2024-01-01','FechaFin','2025-01-01')
  )
)));

SELECT Id, Componente, NombreComun, FechaUltimaDeteccion, Uso, Evidencia
  FROM VW_CertificadosVigencia ORDER BY Id;

-- ---------------------------------------------------------------------
-- Limpieza (opcional, cuando termine la prueba): quita el certificado y el lote de prueba
-- DELETE h FROM HistoricoCertificados h JOIN Certificados c ON c.Id = h.CertificadoId
--  WHERE c.NombreComun = 'certificado-de-prueba.finandina.corp';
-- DELETE FROM Certificados WHERE NombreComun = 'certificado-de-prueba.finandina.corp';
-- DELETE FROM CertificadosLotes WHERE Referencia = 'PRUEBA-DEV-UI';
-- UPDATE Certificados SET FechaUltimaDeteccion = NULL, Origen = NULL WHERE Id IN (292, 294);
