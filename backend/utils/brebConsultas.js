// Catálogo de consultas de Monitoreo transaccional > BREB. TODAS son de SOLO LECTURA y las arma el backend:
//   · SQL Server (base BreB): trx.Redeban (toda la información transaccional), dbo.llave / usuario / cuenta / qr, historico.*, tipo.*, dbo.parametros.
//   · MariaDB (LogBre_B.Log): trazas de cada paso de la transacción (por CUS = columna Transaccion, y por Documento).
// Los valores siempre van como parámetros; nunca se arma SQL con texto de la pantalla.
//
// Cada bloque: { id, titulo, ayuda, origen: 'sql' | 'log', sql, params, mascara, vista, clic, columnaId, vertical, tope }
//   · SQL Server: parámetros con nombre [{ nombre, tipo, valor }] y @nombre en el SQL.
//   · MariaDB: parámetros posicionales (?) en un arreglo.
//   · mascara: { Columna: 'documento' | 'cuenta' | 'nombre' | 'llave' | 'correo' | 'telefono' | 'oculto' } (se aplica antes de responder).

const P = (nombre, valor, tipo = 'varchar') => ({ nombre, tipo, valor });

// ---------------------------------------------------------------------------
// Expresiones SQL Server reutilizables
// ---------------------------------------------------------------------------
const RED = 'trx.Redeban r WITH (NOLOCK)';
const MONTO = 'COALESCE(r.OriginalCtrlSumAmt, r.MoneyAmt, 0)';
const APROBADA = "r.GlobalTxStatus IN ('ACCP', 'ACSC')";
const RECHAZADA = "r.GlobalTxStatus IN ('RJCT', 'CANC')";
const PENDIENTE = "r.GlobalTxStatus IN ('ACSP', 'ACTC', 'ACWC', 'PDNG')";
const SIN_ESTADO = "(r.GlobalTxStatus IS NULL OR r.GlobalTxStatus = '')";
const CLASE_ESTADO = `CASE WHEN ${APROBADA} THEN 'Aprobada' WHEN ${RECHAZADA} THEN 'Rechazada' WHEN ${PENDIENTE} THEN 'Pendiente' WHEN ${SIN_ESTADO} THEN 'Sin estado' ELSE 'Otro' END`;
const DIRECCION = "CASE WHEN r.DebtorBankId = @propio AND r.CreditorBankId = @propio THEN 'Interna (OnUs)' WHEN r.DebtorBankId = @propio THEN 'Saliente' WHEN r.CreditorBankId = @propio THEN 'Entrante' ELSE 'Otra' END";
const FECHA_TRX = 'r.TransactionDateTime >= CONVERT(datetime, @desde, 120) AND r.TransactionDateTime < CONVERT(datetime, @hasta, 120)';
const LADO_DEBITO_MAL = "(ISNULL(r.DebtorResponseCode, 'NT00') <> 'NT00' OR ISNULL(r.DebtorTransactionStatus, 'ACCP') NOT IN ('ACCP', 'ACSC'))";
const LADO_CREDITO_MAL = "(ISNULL(r.CreditorResponseCode, 'NT00') <> 'NT00' OR ISNULL(r.CreditorTransactionStatus, 'ACCP') NOT IN ('ACCP', 'ACSC'))";
const SUMA = (cond) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;

const pv = (v) => [P('desde', v.desde), P('hasta', v.hasta)];
const pvp = (v, propio) => [...pv(v), P('propio', propio)];

const COLS_LISTA = `
  r.TransactionDateTime AS Fecha,
  r.TransactionID AS CUS,
  ISNULL(r.TransactionUseCase, '—') AS Caso,
  ISNULL(r.TransactionScenario, '—') AS Escenario,
  ISNULL(r.TransactionInitiatorType, '—') AS Iniciador,
  ${MONTO} AS Monto,
  ${CLASE_ESTADO} AS Estado,
  r.GlobalTxStatus AS [Cód. estado],
  ${DIRECCION} AS Dirección,
  r.DebtorBankId AS [Banco débito],
  r.CreditorBankId AS [Banco crédito],
  r.DebtorResponseCode AS [Resp. débito],
  r.CreditorResponseCode AS [Resp. crédito],
  ISNULL(NULLIF(r.DebtorTransactionStatusRsnInf, ''), r.CreditorTransactionStatusRsnInf) AS Motivo`;

// ---------------------------------------------------------------------------
// RESUMEN (SQL Server)
// ---------------------------------------------------------------------------
function bloquesResumen(v, { propio }) {
  const p = pvp(v, propio);
  return [
    ['kpis', {
      origen: 'sql', titulo: 'Indicadores', vertical: true,
      sql: `SELECT COUNT(*) AS Total,
        ${SUMA(APROBADA)} AS Aprobadas, ${SUMA(RECHAZADA)} AS Rechazadas, ${SUMA(PENDIENTE)} AS Pendientes, ${SUMA(SIN_ESTADO)} AS SinEstado,
        SUM(CASE WHEN ${APROBADA} THEN ${MONTO} ELSE 0 END) AS MontoAprobado,
        SUM(${MONTO}) AS MontoTotal,
        AVG(CASE WHEN ${APROBADA} THEN CAST(${MONTO} AS float) END) AS TicketPromedio,
        MAX(CASE WHEN ${APROBADA} THEN ${MONTO} END) AS MontoMaximo,
        AVG(CAST(r.ExecutionTime AS float)) AS EjecucionPromedio,
        MAX(r.ExecutionTime) AS EjecucionMaxima,
        COUNT(DISTINCT r.DebtorDocumentNumber) AS ClientesDebito,
        ${SUMA('r.DebtorBankId = @propio AND ISNULL(r.CreditorBankId, \'\') <> @propio')} AS Salientes,
        ${SUMA('r.CreditorBankId = @propio AND ISNULL(r.DebtorBankId, \'\') <> @propio')} AS Entrantes,
        ${SUMA('r.DebtorBankId = @propio AND r.CreditorBankId = @propio')} AS Internas,
        MIN(r.TransactionDateTime) AS Primera, MAX(r.TransactionDateTime) AS Ultima,
        DATEDIFF(minute, MAX(r.TransactionDateTime), GETDATE()) AS MinDesdeUltima
      FROM ${RED} WHERE ${FECHA_TRX}`,
      params: p,
    }],
    ['inconsistentes', {
      origen: 'sql', titulo: 'Débitos sin crédito', vertical: true,
      sql: `SELECT COUNT(*) AS Casos FROM ${RED}
        WHERE ${FECHA_TRX} AND r.DebtorTransactionStatus IN ('ACCP', 'ACSC')
          AND (${RECHAZADA} OR ISNULL(r.CreditorTransactionStatus, 'ACCP') IN ('RJCT', 'CANC') OR ISNULL(r.CreditorResponseCode, 'NT00') <> 'NT00')`,
      params: pv(v),
    }],
    ['ser_hora', {
      origen: 'sql', titulo: 'Transacciones por hora del día',
      sql: `SELECT DATEPART(hour, r.TransactionDateTime) AS Hora, COUNT(*) AS Total, ${SUMA(APROBADA)} AS Aprobadas, ${SUMA(RECHAZADA)} AS Rechazadas, SUM(${MONTO}) AS Monto
        FROM ${RED} WHERE ${FECHA_TRX} GROUP BY DATEPART(hour, r.TransactionDateTime) ORDER BY 1`,
      params: pv(v),
    }],
    ['ser_dia', {
      origen: 'sql', titulo: 'Transacciones por día',
      sql: `SELECT CONVERT(varchar(10), r.TransactionDateTime, 120) AS Dia, COUNT(*) AS Total, ${SUMA(APROBADA)} AS Aprobadas, ${SUMA(RECHAZADA)} AS Rechazadas, SUM(${MONTO}) AS Monto
        FROM ${RED} WHERE ${FECHA_TRX} GROUP BY CONVERT(varchar(10), r.TransactionDateTime, 120) ORDER BY 1`,
      params: pv(v),
    }],
    ['por_estado', {
      origen: 'sql', titulo: 'Por estado de la transacción',
      sql: `SELECT ${CLASE_ESTADO} AS Estado, ISNULL(r.GlobalTxStatus, '—') AS [Cód. estado], COUNT(*) AS Total, SUM(${MONTO}) AS Monto
        FROM ${RED} WHERE ${FECHA_TRX} GROUP BY ${CLASE_ESTADO}, ISNULL(r.GlobalTxStatus, '—') ORDER BY COUNT(*) DESC`,
      params: pv(v),
    }],
    ['por_caso', {
      origen: 'sql', titulo: 'Por caso de uso y escenario',
      ayuda: 'P2P = entre personas, P2M = pago a comercio. Escenario y subproceso tal como los reporta Redeban.',
      sql: `SELECT ISNULL(r.TransactionUseCase, '—') AS [Caso de uso], ISNULL(r.TransactionScenario, '—') AS Escenario, ISNULL(r.TransactionSubProcess, '—') AS Subproceso,
          COUNT(*) AS Total, ${SUMA(APROBADA)} AS Aprobadas, ${SUMA(RECHAZADA)} AS Rechazadas, SUM(${MONTO}) AS Monto
        FROM ${RED} WHERE ${FECHA_TRX}
        GROUP BY ISNULL(r.TransactionUseCase, '—'), ISNULL(r.TransactionScenario, '—'), ISNULL(r.TransactionSubProcess, '—') ORDER BY COUNT(*) DESC`,
      params: pv(v),
    }],
    ['por_iniciador', {
      origen: 'sql', titulo: 'Cómo se inició (QR, directorio…)',
      sql: `SELECT ISNULL(r.TransactionInitiatorType, '—') AS Iniciador, ISNULL(r.TransactionInitiatorSubType, '—') AS Subtipo,
          COUNT(*) AS Total, ${SUMA(APROBADA)} AS Aprobadas, ${SUMA(RECHAZADA)} AS Rechazadas, SUM(${MONTO}) AS Monto
        FROM ${RED} WHERE ${FECHA_TRX}
        GROUP BY ISNULL(r.TransactionInitiatorType, '—'), ISNULL(r.TransactionInitiatorSubType, '—') ORDER BY COUNT(*) DESC`,
      params: pv(v),
    }],
    ['por_direccion', {
      origen: 'sql', titulo: 'Dirección del dinero',
      ayuda: 'Saliente = el cliente del banco paga o envía; Entrante = el cliente del banco recibe; Interna = ambas puntas son del banco.',
      sql: `SELECT ${DIRECCION} AS Dirección, COUNT(*) AS Total, ${SUMA(APROBADA)} AS Aprobadas, ${SUMA(RECHAZADA)} AS Rechazadas, SUM(${MONTO}) AS Monto
        FROM ${RED} WHERE ${FECHA_TRX} GROUP BY ${DIRECCION} ORDER BY COUNT(*) DESC`,
      params: p,
    }],
    ['por_banco', {
      origen: 'sql', titulo: 'Entidades contraparte',
      ayuda: 'Código de la otra entidad (la del cliente que paga o recibe frente a un cliente del banco). Mayor número de rechazos = más atención.',
      sql: `SELECT TOP 20 CASE WHEN r.DebtorBankId = @propio THEN r.CreditorBankId ELSE r.DebtorBankId END AS Entidad,
          COUNT(*) AS Total, ${SUMA(APROBADA)} AS Aprobadas, ${SUMA(RECHAZADA)} AS Rechazadas, SUM(${MONTO}) AS Monto
        FROM ${RED} WHERE ${FECHA_TRX}
        GROUP BY CASE WHEN r.DebtorBankId = @propio THEN r.CreditorBankId ELSE r.DebtorBankId END ORDER BY COUNT(*) DESC`,
      params: p,
    }],
    ['por_codigos', {
      origen: 'sql', titulo: 'Códigos de respuesta y motivos',
      ayuda: 'NT00 es el código de éxito. Cualquier otro código merece revisión en la pestaña Errores.',
      sql: `SELECT TOP 30 x.Lado, ISNULL(x.Codigo, '—') AS Código, ISNULL(x.Motivo, '—') AS Motivo, COUNT(*) AS Total
        FROM (
          SELECT 'Débito' AS Lado, r.DebtorResponseCode AS Codigo, r.DebtorTransactionStatusRsnInf AS Motivo FROM ${RED} WHERE ${FECHA_TRX}
          UNION ALL
          SELECT 'Crédito', r.CreditorResponseCode, r.CreditorTransactionStatusRsnInf FROM ${RED} WHERE ${FECHA_TRX}
        ) x GROUP BY x.Lado, ISNULL(x.Codigo, '—'), ISNULL(x.Motivo, '—') ORDER BY COUNT(*) DESC`,
      params: pv(v),
    }],
    ['por_monto', {
      origen: 'sql', titulo: 'Distribución por monto',
      sql: `SELECT x.Rango, COUNT(*) AS Total FROM (
          SELECT CASE WHEN ${MONTO} < 10000 THEN '1. Menos de $10 mil' WHEN ${MONTO} < 50000 THEN '2. $10 mil a $50 mil'
                      WHEN ${MONTO} < 200000 THEN '3. $50 mil a $200 mil' WHEN ${MONTO} < 1000000 THEN '4. $200 mil a $1 millón'
                      ELSE '5. Más de $1 millón' END AS Rango
          FROM ${RED} WHERE ${FECHA_TRX}) x GROUP BY x.Rango ORDER BY x.Rango`,
      params: pv(v),
    }],
  ];
}

// ---------------------------------------------------------------------------
// TRANSACCIONES (lista con filtros)
// ---------------------------------------------------------------------------
function bloqueTransacciones(v, { propio, estado, caso, escenario, iniciador, entidad, direccion, montoMin, montoMax, q, top }) {
  const params = [...pvp(v, propio)];
  const where = [FECHA_TRX];
  const ESTADOS = { aprobada: APROBADA, rechazada: RECHAZADA, pendiente: PENDIENTE, sinestado: SIN_ESTADO, problema: `(NOT (${APROBADA}) OR ${LADO_DEBITO_MAL} OR ${LADO_CREDITO_MAL})` };
  if (estado && ESTADOS[estado]) where.push(ESTADOS[estado]);
  if (caso) { where.push('r.TransactionUseCase = @caso'); params.push(P('caso', caso)); }
  if (escenario) { where.push('r.TransactionScenario = @escenario'); params.push(P('escenario', escenario)); }
  if (iniciador) { where.push('r.TransactionInitiatorType = @iniciador'); params.push(P('iniciador', iniciador)); }
  if (entidad) { where.push('(r.DebtorBankId = @entidad OR r.CreditorBankId = @entidad)'); params.push(P('entidad', entidad)); }
  if (direccion) {
    const D = { saliente: 'r.DebtorBankId = @propio AND ISNULL(r.CreditorBankId, \'\') <> @propio', entrante: 'r.CreditorBankId = @propio AND ISNULL(r.DebtorBankId, \'\') <> @propio', interna: 'r.DebtorBankId = @propio AND r.CreditorBankId = @propio' };
    if (D[direccion]) where.push(`(${D[direccion]})`);
  }
  if (montoMin !== null && montoMin !== undefined) { where.push(`${MONTO} >= TRY_CONVERT(decimal(18, 2), @montoMin)`); params.push(P('montoMin', String(montoMin))); }
  if (montoMax !== null && montoMax !== undefined) { where.push(`${MONTO} <= TRY_CONVERT(decimal(18, 2), @montoMax)`); params.push(P('montoMax', String(montoMax))); }
  if (q) {
    where.push(`(r.TransactionID = @q OR r.TransactionDirectoryId = @q OR r.TransactionExternalId = @q
      OR r.DebtorDocumentNumber = @q OR r.CreditorDocumentNumber = @q
      OR r.DebtorProductsAccountNumber = @q OR r.CreditorProductsAccountNumber = @q
      OR r.DebtorPartyIdentifier = @q OR r.CreditorPartyIdentifier = @q)`);
    params.push(P('q', q));
  }
  return {
    origen: 'sql', titulo: 'Transacciones', clic: 'fila', columnaId: 'CUS', tope: top,
    ayuda: 'Haz clic en una fila para ver la transacción completa con su recorrido en los logs.',
    sql: `SELECT TOP (${Number(top) + 1}) ${COLS_LISTA} FROM ${RED} WHERE ${where.join(' AND ')} ORDER BY r.TransactionDateTime DESC, r.id DESC`,
    params,
    mascara: {},
  };
}

// ---------------------------------------------------------------------------
// DETALLE de una transacción (por CUS)
// ---------------------------------------------------------------------------
const COLUMNAS_DETALLE = [
  'id', 'TransactionID', 'TransactionDirectoryId', 'TransactionExternalId', 'TransactionDateTime', 'EntityDateTime', 'ReportDateTime', 'NumberOfTxs', 'OriginalCtrlSumAmt',
  'Currency', 'GlobalTxStatus', 'ExecutionTime',
  'DebtorPartyType', 'DebtorPartySystemIdentifier', 'DebtorPartyIdentifier', 'DebtorPartyIdentifierType', 'DebtorDocumentNumber', 'DebtorPartyAlias', 'DebtorBankId',
  'DebtorProductsTypeAccount', 'DebtorProductsAccountNumber', 'DebtorTransactionStatus', 'DebtorTransactionStatusRsnInf', 'DebtorNumberAproval', 'DebtorResponseCode', 'DebtorResponseTime', 'DebtorNamePerson',
  'CreditorPartyType', 'CreditorPartySystemIdentifier', 'CreditorPartyIdentifier', 'CreditorPartyIdentifierType', 'CreditorDocumentNumber', 'CreditorInstructedAgent', 'CreditorPartyAlias', 'CreditorBankId',
  'CreditorProductsTypeAccount', 'CreditorProductsAccountNumber', 'CreditorTransactionStatus', 'CreditorTransactionStatusRsnInf', 'CreditorNumberAproval', 'CreditorResponseCode', 'CreditorResponseTime', 'CreditorNamePerson',
  'TransactionUseCase', 'TransactionScenario', 'TransactionSubProcess', 'TransactionInitiator', 'TransactionInitiatorType', 'TransactionInitiatorSubType', 'TransactionInitiatorTypeDataMap',
  'CdTax', 'MoneyCcy', 'MoneyAmt', 'Note', 'UsuarioCreo', 'FechaCreo', 'FechaModifico',
];

function bloquesDetalle(cus, { propio }) {
  const cols = COLUMNAS_DETALLE.map((c) => `r.${c}`).join(', ');
  return [
    ['det_trx', {
      origen: 'sql', titulo: 'Transacción', vertical: true,
      sql: `SELECT TOP 5 ${cols}, LEN(r.TransactionExternalId) AS ExternalIdLargo FROM ${RED} WHERE r.TransactionID = @cus ORDER BY r.id DESC`,
      params: [P('cus', cus), P('propio', propio)],
      crudo: true,
    }],
    ['det_repeticiones', {
      origen: 'sql', titulo: 'Registros con el mismo CUS',
      sql: `SELECT COUNT(*) AS Registros, MIN(r.FechaCreo) AS Primero, MAX(r.FechaCreo) AS Ultimo FROM ${RED} WHERE r.TransactionID = @cus`,
      params: [P('cus', cus)],
    }],
  ];
}

/** Llaves relacionadas con los identificadores de la transacción (se arman cuando ya se leyó la transacción). */
function bloqueLlavesDeTrx({ llaves }) {
  const lista = [...new Set((llaves || []).filter((x) => x && !/^null$/i.test(x)))].slice(0, 6);
  if (!lista.length) return null;
  const params = lista.map((x, i) => P(`k${i}`, x));
  return {
    origen: 'sql', titulo: 'Llave en el directorio local',
    ayuda: 'Coincidencias exactas de la llave de la transacción con las llaves registradas en la base de BreB.',
    sql: `SELECT TOP 20 l.llave AS Llave, tl.descripcion AS Tipo, te.descripcion AS Estado, ts.descripcion AS Spbvi, l.alias AS Alias,
        c.numeroCuenta AS Cuenta, c.codigoEntidad AS Entidad, tc.descripcion AS [Tipo de cuenta], u.numeroDocumento AS Documento, l.fechaCreo AS Creada, l.fechaModifico AS Modificada
      FROM dbo.llave l WITH (NOLOCK)
      LEFT JOIN tipo.llave tl WITH (NOLOCK) ON tl.id = l.idTipoLlave
      LEFT JOIN tipo.estado te WITH (NOLOCK) ON te.id = l.idTipoEstado
      LEFT JOIN tipo.spbvi ts WITH (NOLOCK) ON ts.id = l.idSpbvi
      LEFT JOIN dbo.cuenta c WITH (NOLOCK) ON c.id = l.idCuenta
      LEFT JOIN tipo.cuenta tc WITH (NOLOCK) ON tc.id = c.idTipoCuenta
      LEFT JOIN dbo.usuario u WITH (NOLOCK) ON u.id = l.idUsuario
      WHERE l.llave IN (${params.map((x) => `@${x.nombre}`).join(', ')}) ORDER BY l.fechaModifico DESC`,
    params,
    mascara: { Llave: 'llave', Alias: 'nombre', Cuenta: 'cuenta', Documento: 'documento' },
  };
}

// ---------------------------------------------------------------------------
// ERRORES (SQL Server)
// ---------------------------------------------------------------------------
function bloquesErroresSql(v, { propio, top = 100 }) {
  const p = pvp(v, propio);
  return [
    ['err_motivos', {
      origen: 'sql', titulo: 'Motivos de rechazo y códigos distintos de NT00',
      ayuda: 'Agrupa por lado (débito o crédito), código de respuesta y motivo. «Ejemplo» es un CUS para abrir el detalle.',
      sql: `SELECT TOP 40 x.Lado, ISNULL(x.Codigo, '—') AS Código, ISNULL(x.Estado, '—') AS [Estado del lado], ISNULL(x.Motivo, '—') AS Motivo,
          COUNT(*) AS Casos, MAX(x.Fecha) AS [Última vez], MAX(x.Cus) AS Ejemplo
        FROM (
          SELECT 'Débito' AS Lado, r.DebtorResponseCode AS Codigo, r.DebtorTransactionStatus AS Estado, r.DebtorTransactionStatusRsnInf AS Motivo, r.TransactionDateTime AS Fecha, r.TransactionID AS Cus
            FROM ${RED} WHERE ${FECHA_TRX} AND ${LADO_DEBITO_MAL}
          UNION ALL
          SELECT 'Crédito', r.CreditorResponseCode, r.CreditorTransactionStatus, r.CreditorTransactionStatusRsnInf, r.TransactionDateTime, r.TransactionID
            FROM ${RED} WHERE ${FECHA_TRX} AND ${LADO_CREDITO_MAL}
        ) x GROUP BY x.Lado, ISNULL(x.Codigo, '—'), ISNULL(x.Estado, '—'), ISNULL(x.Motivo, '—') ORDER BY COUNT(*) DESC`,
      params: pv(v), clic: 'fila', columnaId: 'Ejemplo',
    }],
    ['err_lista', {
      origen: 'sql', titulo: 'Transacciones con problema (más recientes)',
      ayuda: 'No aprobadas, o con algún lado con código distinto de NT00.',
      sql: `SELECT TOP (${top}) ${COLS_LISTA} FROM ${RED}
        WHERE ${FECHA_TRX} AND (NOT (${APROBADA}) OR ${LADO_DEBITO_MAL} OR ${LADO_CREDITO_MAL}) ORDER BY r.TransactionDateTime DESC, r.id DESC`,
      params: p, clic: 'fila', columnaId: 'CUS',
    }],
    ['err_inconsistentes', {
      origen: 'sql', titulo: 'Débito aceptado pero crédito o transacción rechazados',
      ayuda: 'El cliente pudo quedar con el débito aplicado y el dinero sin llegar: son los casos a revisar primero para un posible reverso.',
      sql: `SELECT TOP (${top}) ${COLS_LISTA} FROM ${RED}
        WHERE ${FECHA_TRX} AND r.DebtorTransactionStatus IN ('ACCP', 'ACSC')
          AND (${RECHAZADA} OR ISNULL(r.CreditorTransactionStatus, 'ACCP') IN ('RJCT', 'CANC') OR ISNULL(r.CreditorResponseCode, 'NT00') <> 'NT00')
        ORDER BY r.TransactionDateTime DESC, r.id DESC`,
      params: p, clic: 'fila', columnaId: 'CUS',
    }],
    ['err_lentas', {
      origen: 'sql', titulo: 'Más lentas (tiempo de ejecución reportado)',
      sql: `SELECT TOP 20 r.TransactionDateTime AS Fecha, r.TransactionID AS CUS, ISNULL(r.TransactionUseCase, '—') AS Caso, ${MONTO} AS Monto, ${CLASE_ESTADO} AS Estado,
          r.ExecutionTime AS [Ejecución], r.DebtorResponseTime AS [Resp. débito (ms)], r.CreditorResponseTime AS [Resp. crédito (ms)]
        FROM ${RED} WHERE ${FECHA_TRX} AND r.ExecutionTime IS NOT NULL AND r.ExecutionTime > 0 ORDER BY r.ExecutionTime DESC`,
      params: pv(v), clic: 'fila', columnaId: 'CUS',
    }],
    ['err_duplicadas', {
      origen: 'sql', titulo: 'CUS repetidos',
      ayuda: 'Un mismo CUS guardado más de una vez en trx.Redeban.',
      sql: `SELECT TOP 50 r.TransactionID AS CUS, COUNT(*) AS Repeticiones, MIN(r.TransactionDateTime) AS Primera, MAX(r.TransactionDateTime) AS Última,
          MIN(r.GlobalTxStatus) AS [Estado mín.], MAX(r.GlobalTxStatus) AS [Estado máx.]
        FROM ${RED} WHERE ${FECHA_TRX} AND r.TransactionID IS NOT NULL
        GROUP BY r.TransactionID HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC`,
      params: pv(v), clic: 'fila', columnaId: 'CUS',
    }],
    ['err_clientes', {
      origen: 'sql', titulo: 'Clientes con más transacciones no aprobadas',
      ayuda: 'Documento enmascarado. Sirve para detectar reintentos repetidos o posibles problemas de un cliente.',
      sql: `SELECT TOP 15 r.DebtorDocumentNumber AS Documento, COUNT(*) AS Intentos, ${SUMA(`NOT (${APROBADA})`)} AS [No aprobadas], SUM(${MONTO}) AS Monto, MAX(r.TransactionDateTime) AS [Último intento]
        FROM ${RED} WHERE ${FECHA_TRX} AND r.DebtorBankId = @propio AND r.DebtorDocumentNumber IS NOT NULL
        GROUP BY r.DebtorDocumentNumber HAVING ${SUMA(`NOT (${APROBADA})`)} > 0 ORDER BY ${SUMA(`NOT (${APROBADA})`)} DESC, COUNT(*) DESC`,
      params: p, mascara: { Documento: 'documento' },
    }],
  ];
}

// ---------------------------------------------------------------------------
// CLIENTE 360 (SQL Server)
// ---------------------------------------------------------------------------
function bloquesCliente(v, { documento, propio, top = 200 }) {
  const dp = P('doc', documento);
  const p = [...pvp(v, propio), dp];
  const ROL = "CASE WHEN r.DebtorDocumentNumber = @doc THEN 'Débito' ELSE 'Crédito' END";
  return [
    ['cl_usuario', {
      origen: 'sql', titulo: 'Cliente en BreB',
      sql: `SELECT TOP 5 tp.descripcion AS Persona, td.descripcion AS [Tipo de documento], u.numeroDocumento AS Documento,
          u.primerNombre AS Nombre, u.primerApellido AS Apellido, u.nombreComercial AS [Nombre comercial], u.fechaCreo AS Creado, u.id AS IdUsuario, u.idTipoPersona AS IdTipoPersona, u.idTipoDocumento AS IdTipoDocumento
        FROM dbo.usuario u WITH (NOLOCK)
        LEFT JOIN tipo.persona tp WITH (NOLOCK) ON tp.id = u.idTipoPersona
        LEFT JOIN tipo.documento td WITH (NOLOCK) ON td.id = u.idTipoDocumento
        WHERE u.numeroDocumento = @doc`,
      params: [dp], mascara: { Documento: 'documento', Nombre: 'nombre', Apellido: 'inicial', 'Nombre comercial': 'nombre' }, crudo: true,
    }],
    ['cl_llaves', {
      origen: 'sql', titulo: 'Llaves registradas',
      sql: `SELECT TOP 100 l.llave AS Llave, tl.descripcion AS Tipo, te.descripcion AS Estado, ts.descripcion AS Spbvi, l.alias AS Alias,
          c.numeroCuenta AS Cuenta, c.codigoEntidad AS Entidad, tc.descripcion AS [Tipo de cuenta], l.fechaCreo AS Creada, l.fechaModifico AS Modificada
        FROM dbo.usuario u WITH (NOLOCK)
        JOIN dbo.llave l WITH (NOLOCK) ON l.idUsuario = u.id
        LEFT JOIN tipo.llave tl WITH (NOLOCK) ON tl.id = l.idTipoLlave
        LEFT JOIN tipo.estado te WITH (NOLOCK) ON te.id = l.idTipoEstado
        LEFT JOIN tipo.spbvi ts WITH (NOLOCK) ON ts.id = l.idSpbvi
        LEFT JOIN dbo.cuenta c WITH (NOLOCK) ON c.id = l.idCuenta
        LEFT JOIN tipo.cuenta tc WITH (NOLOCK) ON tc.id = c.idTipoCuenta
        WHERE u.numeroDocumento = @doc ORDER BY l.fechaModifico DESC`,
      params: [dp], mascara: { Llave: 'llave', Alias: 'nombre', Cuenta: 'cuenta' },
    }],
    ['cl_historico', {
      origen: 'sql', titulo: 'Historial de cambios de llaves',
      ayuda: 'Altas, bajas y cambios de estado de cada llave (historico.llave).',
      sql: `SELECT TOP 100 h.fechaModifico AS Fecha, tp.descripcion AS Proceso, h.llave AS Llave, tl.descripcion AS Tipo, te.descripcion AS Estado, h.usuarioCreo AS [Usuario del cambio]
        FROM dbo.usuario u WITH (NOLOCK)
        JOIN historico.llave h WITH (NOLOCK) ON h.idUsuario = u.id
        LEFT JOIN tipo.proceso tp WITH (NOLOCK) ON tp.id = h.idTipoProceso
        LEFT JOIN tipo.llave tl WITH (NOLOCK) ON tl.id = h.idTipoLlave
        LEFT JOIN tipo.estado te WITH (NOLOCK) ON te.id = h.idTipoEstado
        WHERE u.numeroDocumento = @doc ORDER BY h.fechaModifico DESC`,
      params: [dp], mascara: { Llave: 'llave' },
    }],
    ['cl_qr', {
      origen: 'sql', titulo: 'Códigos QR',
      ayuda: 'No se muestran la imagen ni el código de seguridad.',
      sql: `SELECT TOP 100 tq.descripcion AS Tipo, q.quantityUses AS Usos, q.fechaExpiracion AS Expira, CASE WHEN q.fechaExpiracion >= GETDATE() THEN 'Vigente' ELSE 'Vencido' END AS Estado,
          q.fechaCreo AS Creado, q.fechaModifico AS Modificado
        FROM dbo.usuario u WITH (NOLOCK)
        JOIN dbo.qr q WITH (NOLOCK) ON q.idUsuario = u.id
        LEFT JOIN tipo.qr tq WITH (NOLOCK) ON tq.id = q.idTipoQr
        WHERE u.numeroDocumento = @doc ORDER BY q.fechaCreo DESC`,
      params: [dp],
    }],
    ['cl_resumen_trx', {
      origen: 'sql', titulo: 'Resumen de transacciones',
      sql: `SELECT ${ROL} AS Rol, COUNT(*) AS Total, ${SUMA(APROBADA)} AS Aprobadas, ${SUMA(RECHAZADA)} AS Rechazadas, SUM(${MONTO}) AS Monto, MAX(r.TransactionDateTime) AS Última
        FROM ${RED} WHERE ${FECHA_TRX} AND (r.DebtorDocumentNumber = @doc OR r.CreditorDocumentNumber = @doc) GROUP BY ${ROL}`,
      params: p,
    }],
    ['cl_trx', {
      origen: 'sql', titulo: 'Transacciones del cliente', clic: 'fila', columnaId: 'CUS',
      sql: `SELECT TOP (${top}) ${ROL} AS Rol, ${COLS_LISTA} FROM ${RED}
        WHERE ${FECHA_TRX} AND (r.DebtorDocumentNumber = @doc OR r.CreditorDocumentNumber = @doc) ORDER BY r.TransactionDateTime DESC, r.id DESC`,
      params: p,
    }],
  ];
}

// ---------------------------------------------------------------------------
// LLAVES Y QR (SQL Server)
// ---------------------------------------------------------------------------
function bloquesLlaves(v) {
  const FH = 'h.fechaModifico >= CONVERT(datetime, @desde, 120) AND h.fechaModifico < CONVERT(datetime, @hasta, 120)';
  return [
    ['ll_totales', {
      origen: 'sql', titulo: 'Totales', vertical: true,
      sql: `SELECT (SELECT COUNT(*) FROM dbo.usuario WITH (NOLOCK)) AS Clientes, (SELECT COUNT(*) FROM dbo.llave WITH (NOLOCK)) AS Llaves,
        (SELECT COUNT(*) FROM dbo.cuenta WITH (NOLOCK)) AS Cuentas, (SELECT COUNT(*) FROM dbo.qr WITH (NOLOCK)) AS QR,
        (SELECT COUNT(*) FROM dbo.qr WITH (NOLOCK) WHERE fechaExpiracion >= GETDATE()) AS QRVigentes,
        (SELECT COUNT(*) FROM dbo.llave WITH (NOLOCK) WHERE fechaCreo >= CONVERT(datetime, @desde, 120) AND fechaCreo < CONVERT(datetime, @hasta, 120)) AS LlavesCreadas`,
      params: pv(v),
    }],
    ['ll_tipo_estado', {
      origen: 'sql', titulo: 'Llaves por tipo y estado (hoy)',
      sql: `SELECT ISNULL(tl.descripcion, CONVERT(varchar(20), l.idTipoLlave)) AS Tipo, ISNULL(te.descripcion, CONVERT(varchar(20), l.idTipoEstado)) AS Estado, COUNT(*) AS Total
        FROM dbo.llave l WITH (NOLOCK)
        LEFT JOIN tipo.llave tl WITH (NOLOCK) ON tl.id = l.idTipoLlave
        LEFT JOIN tipo.estado te WITH (NOLOCK) ON te.id = l.idTipoEstado
        GROUP BY ISNULL(tl.descripcion, CONVERT(varchar(20), l.idTipoLlave)), ISNULL(te.descripcion, CONVERT(varchar(20), l.idTipoEstado)) ORDER BY COUNT(*) DESC`,
      params: [],
    }],
    ['ll_spbvi', {
      origen: 'sql', titulo: 'Llaves por Spbvi',
      sql: `SELECT ISNULL(ts.descripcion, CONVERT(varchar(20), l.idSpbvi)) AS Spbvi, COUNT(*) AS Total
        FROM dbo.llave l WITH (NOLOCK) LEFT JOIN tipo.spbvi ts WITH (NOLOCK) ON ts.id = l.idSpbvi
        GROUP BY ISNULL(ts.descripcion, CONVERT(varchar(20), l.idSpbvi)) ORDER BY COUNT(*) DESC`,
      params: [],
    }],
    ['ll_proceso', {
      origen: 'sql', titulo: 'Cambios de llaves por proceso (rango)',
      sql: `SELECT ISNULL(tp.descripcion, CONVERT(varchar(20), h.idTipoProceso)) AS Proceso, COUNT(*) AS Total
        FROM historico.llave h WITH (NOLOCK) LEFT JOIN tipo.proceso tp WITH (NOLOCK) ON tp.id = h.idTipoProceso
        WHERE ${FH} GROUP BY ISNULL(tp.descripcion, CONVERT(varchar(20), h.idTipoProceso)) ORDER BY COUNT(*) DESC`,
      params: pv(v),
    }],
    ['ll_dia', {
      origen: 'sql', titulo: 'Cambios de llaves por día',
      sql: `SELECT CONVERT(varchar(10), h.fechaModifico, 120) AS Dia, COUNT(*) AS Total
        FROM historico.llave h WITH (NOLOCK) WHERE ${FH} GROUP BY CONVERT(varchar(10), h.fechaModifico, 120) ORDER BY 1`,
      params: pv(v),
    }],
    ['ll_recientes', {
      origen: 'sql', titulo: 'Últimos cambios de llaves',
      sql: `SELECT TOP 50 h.fechaModifico AS Fecha, tp.descripcion AS Proceso, h.llave AS Llave, tl.descripcion AS Tipo, te.descripcion AS Estado, h.usuarioCreo AS [Usuario del cambio]
        FROM historico.llave h WITH (NOLOCK)
        LEFT JOIN tipo.proceso tp WITH (NOLOCK) ON tp.id = h.idTipoProceso
        LEFT JOIN tipo.llave tl WITH (NOLOCK) ON tl.id = h.idTipoLlave
        LEFT JOIN tipo.estado te WITH (NOLOCK) ON te.id = h.idTipoEstado
        WHERE ${FH} ORDER BY h.fechaModifico DESC`,
      params: pv(v), mascara: { Llave: 'llave' },
    }],
    ['ll_anomalias', {
      origen: 'sql', titulo: 'Posibles inconsistencias en llaves',
      ayuda: 'Llaves repetidas, sin cuenta o sin cliente asociado.',
      sql: `SELECT 'Llave repetida (más de un registro)' AS Anomalía, COUNT(*) AS Casos FROM (SELECT l.llave FROM dbo.llave l WITH (NOLOCK) GROUP BY l.llave HAVING COUNT(*) > 1) d
        UNION ALL SELECT 'Llave sin cuenta asociada', COUNT(*) FROM dbo.llave l WITH (NOLOCK) WHERE NOT EXISTS (SELECT 1 FROM dbo.cuenta c WITH (NOLOCK) WHERE c.id = l.idCuenta)
        UNION ALL SELECT 'Llave sin cliente asociado', COUNT(*) FROM dbo.llave l WITH (NOLOCK) WHERE NOT EXISTS (SELECT 1 FROM dbo.usuario u WITH (NOLOCK) WHERE u.id = l.idUsuario)`,
      params: [],
    }],
    ['qr_tipo', {
      origen: 'sql', titulo: 'Códigos QR por tipo',
      sql: `SELECT ISNULL(tq.descripcion, CONVERT(varchar(20), q.idTipoQr)) AS Tipo, COUNT(*) AS Total, ${SUMA('q.fechaExpiracion >= GETDATE()').replace(/r\./g, 'q.')} AS Vigentes, SUM(q.quantityUses) AS Usos
        FROM dbo.qr q WITH (NOLOCK) LEFT JOIN tipo.qr tq WITH (NOLOCK) ON tq.id = q.idTipoQr
        GROUP BY ISNULL(tq.descripcion, CONVERT(varchar(20), q.idTipoQr)) ORDER BY COUNT(*) DESC`,
      params: [],
    }],
  ];
}

// ---------------------------------------------------------------------------
// PARÁMETROS (SQL Server)
// ---------------------------------------------------------------------------
function bloquesParametros({ app, texto }) {
  const where = [];
  const params = [];
  if (app) { where.push('p.APP = @app'); params.push(P('app', app)); }
  if (texto) { where.push('(p.NAME LIKE @texto OR p.APP LIKE @texto)'); params.push(P('texto', `%${texto.replace(/[%_[]/g, '')}%`)); }
  return [
    ['par_lista', {
      origen: 'sql', titulo: 'Parámetros de la aplicación',
      ayuda: 'Los valores de parámetros con nombres sensibles (claves, tokens, usuarios, cadenas de conexión) se ocultan.',
      sql: `SELECT TOP 500 p.APP, p.NAME AS Nombre, LEFT(CONVERT(nvarchar(max), p.VALUE), 400) AS Valor, p.UPDATE_DATE AS Actualizado, p.USER_CREATE AS [Usuario]
        FROM dbo.parametros p WITH (NOLOCK) ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.APP, p.NAME`,
      params, valoresSensibles: { clave: 'Nombre', valor: 'Valor' },
    }],
    ['par_cambios', {
      origen: 'sql', titulo: 'Diferencias con el respaldo (Parametros_BK)',
      ayuda: 'Parámetros cuyo valor es distinto al del respaldo, o que existen solo en uno de los dos.',
      sql: `SELECT TOP 200 ISNULL(p.APP, b.APP) AS APP, ISNULL(p.NAME, b.NAME) AS Nombre,
          CASE WHEN p.ID IS NULL THEN 'Solo en el respaldo' WHEN b.ID IS NULL THEN 'Solo en el actual' ELSE 'Valor distinto' END AS Diferencia,
          LEFT(CONVERT(nvarchar(max), p.VALUE), 300) AS [Valor actual], LEFT(CONVERT(nvarchar(max), b.VALUE), 300) AS [Valor en respaldo], p.UPDATE_DATE AS Actualizado
        FROM dbo.parametros p WITH (NOLOCK)
        FULL OUTER JOIN dbo.Parametros_BK b WITH (NOLOCK) ON b.APP = p.APP AND b.NAME = p.NAME
        WHERE p.ID IS NULL OR b.ID IS NULL OR CONVERT(nvarchar(max), p.VALUE) <> CONVERT(nvarchar(max), b.VALUE)
        ORDER BY ISNULL(p.APP, b.APP), ISNULL(p.NAME, b.NAME)`,
      params: [], valoresSensibles: { clave: 'Nombre', valor: ['Valor actual', 'Valor en respaldo'] },
    }],
  ];
}

// ---------------------------------------------------------------------------
// LOGS (MariaDB) — tabla Log. Las columnas de payload (Rq, Rs, Adicional) solo se leen en el detalle de un registro.
// ---------------------------------------------------------------------------
const NIVEL_LOG = "CASE WHEN Descripcion LIKE '%error%' OR Descripcion LIKE '%excep%' OR Descripcion LIKE '%fall%' THEN 'Error' ELSE 'Info' END";
const ES_ERROR_LOG = "(Descripcion LIKE '%error%' OR Descripcion LIKE '%excep%' OR Descripcion LIKE '%fall%')";
const FECHA_LOG = 'Fecha >= ? AND Fecha < ?';

function bloquesLogsErrores(v, { top = 100 }) {
  const f = [v.desde, v.hasta];
  return [
    ['log_kpis', {
      origen: 'log', titulo: 'Actividad en logs', vertical: true,
      sql: `SELECT COUNT(*) AS Registros, SUM(${ES_ERROR_LOG}) AS Errores, SUM(Metodo = 'PAIN 008') AS Debitos, COUNT(DISTINCT NULLIF(Transaccion, '')) AS Transacciones,
          COUNT(DISTINCT NULLIF(Documento, '')) AS Clientes, MAX(Fecha) AS UltimoRegistro
        FROM \`Log\` WHERE ${FECHA_LOG}`,
      params: f,
    }],
    ['log_err_grupos', {
      origen: 'log', titulo: 'Errores agrupados',
      ayuda: 'Mismo componente, método y mensaje. «Detalle» es la respuesta del último caso.',
      sql: `SELECT Clase, Metodo, LEFT(Descripcion, 160) AS Descripcion, COUNT(*) AS Veces, COUNT(DISTINCT NULLIF(Transaccion, '')) AS Transacciones,
          MIN(Fecha) AS PrimeraVez, MAX(Fecha) AS UltimaVez, MAX(Codigo) AS UltimoCodigo
        FROM \`Log\` WHERE ${FECHA_LOG} AND ${ES_ERROR_LOG}
        GROUP BY Clase, Metodo, LEFT(Descripcion, 160) ORDER BY COUNT(*) DESC LIMIT 40`,
      params: f, muestraRs: true,
    }],
    ['log_err_hora', {
      origen: 'log', titulo: 'Errores por hora',
      sql: `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d %H:00') AS Hora, SUM(${ES_ERROR_LOG}) AS Errores, SUM(Metodo = 'PAIN 008') AS Debitos
        FROM \`Log\` WHERE ${FECHA_LOG} GROUP BY DATE_FORMAT(Fecha, '%Y-%m-%d %H:00') ORDER BY 1`,
      params: f,
    }],
    ['log_err_recientes', {
      origen: 'log', titulo: 'Errores más recientes', clic: 'fila', columnaId: 'Codigo',
      sql: `SELECT Codigo, Fecha, Clase, Metodo, LEFT(Descripcion, 200) AS Descripcion, Transaccion AS CUS, Documento
        FROM \`Log\` WHERE ${FECHA_LOG} AND ${ES_ERROR_LOG} ORDER BY Codigo DESC LIMIT ${Number(top)}`,
      params: f, mascara: { Documento: 'documento' },
    }],
    ['log_avisos', {
      origen: 'log', titulo: 'Avisos de mensajería (informativos)',
      ayuda: 'Envíos de correo o WhatsApp «incompletos» (por ejemplo, la estrategia no permite WhatsApp). No son errores de la transacción.',
      sql: `SELECT LEFT(Rs, 180) AS Aviso, COUNT(*) AS Veces, MAX(Fecha) AS UltimaVez
        FROM \`Log\` WHERE ${FECHA_LOG} AND Metodo = 'SendMail' AND Rs LIKE '%incompleto%' GROUP BY LEFT(Rs, 180) ORDER BY COUNT(*) DESC LIMIT 10`,
      params: f,
    }],
    ['log_flujo_incompleto', {
      origen: 'log', titulo: 'Transacciones con el flujo incompleto',
      ayuda: 'CUS con débito en el core (PAIN 008) al que le falta el registro de la transacción o su reporte. Los de los últimos 5 minutos pueden seguir en curso.',
      sql: `SELECT Transaccion AS CUS, MIN(Fecha) AS Inicio, MAX(Fecha) AS Fin,
          SUM(Metodo = 'PAIN 008') AS Debito, SUM(Clase = 'WebApiTransacciones' AND Metodo = 'CrearTransaccion') AS Registro,
          SUM(Clase = 'WebApiHubBreB' AND Metodo = 'TransactionReport') AS Reporte, SUM(${ES_ERROR_LOG}) AS Errores
        FROM \`Log\` WHERE ${FECHA_LOG} AND Transaccion IS NOT NULL AND Transaccion <> ''
        GROUP BY Transaccion
        HAVING SUM(Metodo = 'PAIN 008') > 0 AND (SUM(Clase = 'WebApiTransacciones' AND Metodo = 'CrearTransaccion') = 0 OR SUM(Clase = 'WebApiHubBreB' AND Metodo = 'TransactionReport') = 0)
        ORDER BY MIN(Fecha) DESC LIMIT 100`,
      params: f, clic: 'fila', columnaId: 'CUS',
    }],
  ];
}

function bloqueLogsLista(v, { cus, documento, clase, metodo, nivel, texto, enPayload, antes, top }) {
  const where = [FECHA_LOG];
  const params = [v.desde, v.hasta];
  if (cus) { where.push('Transaccion = ?'); params.push(cus); }
  if (documento) { where.push('Documento = ?'); params.push(documento); }
  if (clase) { where.push('Clase = ?'); params.push(clase); }
  if (metodo) { where.push('Metodo = ?'); params.push(metodo); }
  if (nivel === 'error') where.push(ES_ERROR_LOG);
  if (texto) {
    const like = `%${texto.replace(/[%_\\]/g, '')}%`;
    if (enPayload) { where.push('(Descripcion LIKE ? OR Rq LIKE ? OR Rs LIKE ?)'); params.push(like, like, like); } else { where.push('Descripcion LIKE ?'); params.push(like); }
  }
  if (antes) { where.push('Codigo < ?'); params.push(antes); }
  return {
    origen: 'log', titulo: 'Registros de log', clic: 'fila', columnaId: 'Codigo', tope: top,
    sql: `SELECT Codigo, Fecha, Clase, Metodo, ${NIVEL_LOG} AS Nivel, LEFT(Descripcion, 220) AS Descripcion, Transaccion AS CUS, Documento, Ip,
        CASE WHEN Rq IS NULL OR Rq = '' THEN 0 ELSE 1 END AS TieneRq, CASE WHEN Rs IS NULL OR Rs = '' THEN 0 ELSE 1 END AS TieneRs
      FROM \`Log\` WHERE ${where.join(' AND ')} ORDER BY Codigo DESC LIMIT ${Number(top) + 1}`,
    params, mascara: { Documento: 'documento' },
  };
}

function bloqueLogsActividad(v) {
  return {
    origen: 'log', titulo: 'Actividad por componente y método',
    sql: `SELECT Clase, Metodo, COUNT(*) AS Registros, SUM(${ES_ERROR_LOG}) AS Errores, MAX(Fecha) AS UltimaVez
      FROM \`Log\` WHERE ${FECHA_LOG} GROUP BY Clase, Metodo ORDER BY COUNT(*) DESC LIMIT 60`,
    params: [v.desde, v.hasta],
  };
}

function bloqueLogDetalle(codigo) {
  return {
    origen: 'log', titulo: 'Registro', vertical: true, crudo: true,
    sql: 'SELECT Codigo, Clave, Fecha, Documento, CanalCodigo, FuncionalidadCodigo, TipoCodigo, ProcesoCodigo, Clase, Metodo, Descripcion, Adicional, Transaccion, Rq, Rs, Ip, Sesion FROM `Log` WHERE Codigo = ? LIMIT 1',
    params: [codigo],
  };
}

/** Todo el recorrido de una transacción (por CUS). Las columnas Rq/Rs sirven para leer tiempos y respuestas; el payload se limpia antes de salir. */
function bloqueLogsDeTrx(v, cus) {
  return {
    origen: 'log', titulo: 'Recorrido en los logs', crudo: true, clic: 'fila', columnaId: 'Codigo',
    ayuda: 'Haz clic en un registro para ver lo enviado y recibido (con los datos personales ocultos).',
    sql: `SELECT Codigo, Fecha, Clase, Metodo, Descripcion, Documento, Ip, LEFT(Rq, 6000) AS Rq, LEFT(Rs, 1500) AS Rs
      FROM \`Log\` WHERE Transaccion = ? AND ${FECHA_LOG} ORDER BY Codigo ASC LIMIT 200`,
    params: [cus, v.desde, v.hasta],
  };
}

function bloquesLogsCliente(v, documento) {
  const f = [v.desde, v.hasta];
  return [
    ['cl_log_kpis', {
      origen: 'log', titulo: 'Actividad del cliente en logs', vertical: true,
      sql: `SELECT COUNT(*) AS Registros, SUM(${ES_ERROR_LOG}) AS Errores, COUNT(DISTINCT NULLIF(Transaccion, '')) AS Transacciones, MIN(Fecha) AS Primero, MAX(Fecha) AS Ultimo
        FROM \`Log\` WHERE Documento = ? AND ${FECHA_LOG}`,
      params: [documento, ...f],
    }],
    ['cl_log_trx', {
      origen: 'log', titulo: 'Transacciones vistas en los logs', clic: 'fila', columnaId: 'CUS',
      ayuda: 'Una fila por CUS: cuántos registros dejó, si hubo errores y qué pasos se vieron.',
      sql: `SELECT Transaccion AS CUS, MIN(Fecha) AS Inicio, MAX(Fecha) AS Fin, COUNT(*) AS Registros, SUM(${ES_ERROR_LOG}) AS Errores,
          SUM(Metodo = 'PAIN 008') AS Debito, SUM(Metodo = 'CrearTransaccion') AS Registro, SUM(Metodo = 'TransactionReport') AS Reporte, SUM(Metodo = 'SendMail') AS Mensajeria
        FROM \`Log\` WHERE Documento = ? AND ${FECHA_LOG} AND Transaccion IS NOT NULL AND Transaccion <> ''
        GROUP BY Transaccion ORDER BY MAX(Fecha) DESC LIMIT 100`,
      params: [documento, ...f],
    }],
    ['cl_log_errores', {
      origen: 'log', titulo: 'Errores del cliente en los logs', clic: 'fila', columnaId: 'Codigo',
      sql: `SELECT Codigo, Fecha, Clase, Metodo, LEFT(Descripcion, 200) AS Descripcion, Transaccion AS CUS
        FROM \`Log\` WHERE Documento = ? AND ${FECHA_LOG} AND ${ES_ERROR_LOG} ORDER BY Codigo DESC LIMIT 50`,
      params: [documento, ...f],
    }],
  ];
}

module.exports = {
  P, RED, MONTO, APROBADA, RECHAZADA, PENDIENTE, SIN_ESTADO, CLASE_ESTADO, DIRECCION, FECHA_TRX, COLUMNAS_DETALLE,
  bloquesResumen, bloqueTransacciones, bloquesDetalle, bloqueLlavesDeTrx, bloquesErroresSql, bloquesCliente, bloquesLlaves, bloquesParametros,
  bloquesLogsErrores, bloqueLogsLista, bloqueLogsActividad, bloqueLogDetalle, bloqueLogsDeTrx, bloquesLogsCliente, ES_ERROR_LOG,
};
