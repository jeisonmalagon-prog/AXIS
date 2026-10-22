// Catálogo de consultas de SOLO LECTURA para «Monitorear prospección» (GestionCliente, esquema PD, SQL Server 2012).
//
// Todas las consultas las arma este archivo (nunca llegan de la pantalla) y siempre con parámetros tipados según el tipo REAL
// de cada columna (así los índices se usan: nada de comparar un varchar contra un nvarchar o un bigint contra un varchar).
// Los nombres de tablas y columnas que no conocemos de antemano se toman del propio esquema (INFORMATION_SCHEMA), nunca de la
// pantalla. Si una tabla o columna no existe, el bloque se omite con el motivo en vez de fallar toda la pantalla.
//
// Compatibilidad SQL Server 2012: sin STRING_AGG / TRIM / CONCAT_WS / FORMAT; TOP con paréntesis; WITH (NOLOCK) en todas las tablas.

const SCHEMA = 'pd';

// Esquema mínimo conocido (las consultas de referencia del equipo). Se usa solo si no se pudo leer INFORMATION_SCHEMA.
const BASE = {
  CampanaCargueAliado: { IdCampanaCargue: 'int', FechaCreacion: 'datetime' },
  ProspeccionCargueInterno: { IdCampanaCargue: 'int', IdProspecto: 'bigint', NumeroDocumento: 'varchar', ProspectadoInd: 'bit', FechaCreacion: 'datetime', FechaModificacion: 'datetime' },
  Prospeccion: { Id: 'bigint', NumeroDocumento: 'nvarchar', TipoSubproducto: 'int', IdLote: 'bigint', IdAliadoExterno: 'varchar', FechaRegistro: 'datetime', FechaModificacion: 'datetime' },
  DetalleCampanas: { IdCampana: 'bigint', NumeroDocumento: 'nvarchar', IdEstadoDetalle: 'int' },
  Campana: { IdCampana: 'bigint', IdLoteAliado: 'varchar' },
  ProcesoAliado: { NumeroDocumento: 'bigint', IdLote: 'bigint', IdEstadoProceso: 'int', NoSolicitud: 'bigint', IdAliado: 'int', FechaCreacion: 'datetime', FechaModificacion: 'datetime' },
  OfertaAliado: { NumeroDocumento: 'bigint', IdLote: 'bigint', TipoSubproducto: 'int', Monto: 'decimal' },
  ClienteAliado: { NumeroDocumento: 'bigint' },
  EstadoProcesoAliado: { Id: 'int', NombreEstado: 'varchar' },
  Aliado: { Id: 'int', Nombre: 'varchar' },
  TipoProducto: { IdProducto: 'int', Descripcion: 'varchar' },
  AnalisisListas: { IdProspeccion: 'bigint', IdAnalisisAliado: 'int', FechaCreacion: 'datetime' },
  PagarePublicador: { NumeroDocumento: 'varchar', IDSolicitudLP: 'varchar' },
};

// Columnas que NO se envían al navegador en las consultas «genéricas» (SELECT *): datos de contacto, personales,
// financieros sensibles, secretos y cargas (xml/json) que pueden traer más datos personales.
const RE_COLUMNA_SENSIBLE = /(celular|telefono|tel[eé]fono|movil|m[oó]vil|correo|e_?mail|direccion|direcci[oó]n|nacim|salario|ingreso|egreso|patrimonio|clave|password|contrase|token|secret|cuenta|iban|xml|json|payload|firma|biometr|apellido|^nombres?$|^nombrecompleto$|^razon)/i;

const RE_DOCUMENTO = /^[A-Za-z0-9]{3,20}$/;

// ---------------------------------------------------------------------------
// Esquema descubierto
// ---------------------------------------------------------------------------
class Esquema {
  /** filas: [{ TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH }] */
  constructor(filas, { descubierto = true } = {}) {
    this.descubierto = descubierto;
    this.tablas = new Map(); // minúsculas -> { nombre, columnas: Map(minúsculas -> {nombre, tipo, largo}) }
    for (const f of filas || []) {
      const t = String(f.TABLE_NAME);
      const k = t.toLowerCase();
      if (!this.tablas.has(k)) this.tablas.set(k, { nombre: t, columnas: new Map() });
      this.tablas.get(k).columnas.set(String(f.COLUMN_NAME).toLowerCase(), {
        nombre: String(f.COLUMN_NAME), tipo: String(f.DATA_TYPE || '').toLowerCase(), largo: f.CHARACTER_MAXIMUM_LENGTH,
      });
    }
  }

  static base() {
    const filas = [];
    for (const [t, cols] of Object.entries(BASE)) for (const [c, tipo] of Object.entries(cols)) filas.push({ TABLE_NAME: t, COLUMN_NAME: c, DATA_TYPE: tipo });
    return new Esquema(filas, { descubierto: false });
  }

  tiene(tabla) { return this.tablas.has(String(tabla).toLowerCase()); }
  nombreTabla(tabla) { return this.tablas.get(String(tabla).toLowerCase())?.nombre || null; }
  columnas(tabla) { return [...(this.tablas.get(String(tabla).toLowerCase())?.columnas.values() || [])]; }

  /** Nombre real de la primera columna que exista entre los candidatos (sin importar mayúsculas), o null. */
  columna(tabla, ...candidatos) {
    const t = this.tablas.get(String(tabla).toLowerCase());
    if (!t) return null;
    for (const c of candidatos) {
      const f = t.columnas.get(String(c).toLowerCase());
      if (f) return f.nombre;
    }
    return null;
  }

  columnaLike(tabla, regex, excluir) {
    for (const c of this.columnas(tabla)) if (regex.test(c.nombre) && !(excluir && excluir.test(c.nombre))) return c.nombre;
    return null;
  }

  tipo(tabla, columna) {
    return this.tablas.get(String(tabla).toLowerCase())?.columnas.get(String(columna).toLowerCase())?.tipo || null;
  }

  /** Tablas que empiezan por «LOG_» (registros de errores y de procesos). */
  tablasLog() { return [...this.tablas.values()].map((t) => t.nombre).filter((n) => /^log_/i.test(n)).sort(); }

  resumen() {
    return [...this.tablas.values()].map((t) => ({ nombre: t.nombre, columnas: [...t.columnas.values()].map((c) => ({ nombre: c.nombre, tipo: c.tipo, largo: c.largo ?? null })) }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  }
}

// Identificador seguro: solo nombres que vienen del propio esquema; se encierran entre corchetes.
const q = (nombre) => `[${String(nombre).replace(/]/g, ']]')}]`;
const tabla = (esq, t) => `${SCHEMA}.${q(esq.nombreTabla(t))}`;
const omitir = (motivo) => ({ omitido: motivo });

/** null si existen todas las tablas/columnas, o el motivo de por qué no se puede armar el bloque. */
function requiere(esq, mapa) {
  for (const [t, cols] of Object.entries(mapa)) {
    if (!esq.tiene(t)) return `No existe la tabla ${SCHEMA}.${t} (o la cuenta no puede verla).`;
    const faltan = cols.filter((c) => !esq.columna(t, c));
    if (faltan.length) return `En ${SCHEMA}.${t} no se encontró: ${faltan.join(', ')}.`;
  }
  return null;
}

/** Tipo de parámetro (de mssql) que corresponde al tipo REAL de la columna. */
function tipoParametro(esq, t, columna) {
  const tipo = esq.tipo(t, columna);
  if (['tinyint', 'smallint', 'int'].includes(tipo)) return 'int';
  if (['bigint', 'numeric', 'decimal'].includes(tipo)) return 'bigint';
  if (['nchar', 'nvarchar', 'ntext'].includes(tipo)) return 'nvarchar';
  return 'varchar';
}

/** Parámetro de documento para una columna concreta, o null si la columna es numérica y el documento no. */
function paramDocumento(esq, t, columna, valor, nombre = 'doc') {
  const tipo = tipoParametro(esq, t, columna);
  if ((tipo === 'int' || tipo === 'bigint') && !/^\d{1,18}$/.test(String(valor))) return null;
  return { nombre, tipo, valor: String(valor) };
}

/** Parámetro numérico (id) para una columna, o null si el valor no es un entero válido. */
function paramEntero(esq, t, columna, valor, nombre = 'id') {
  if (!/^\d{1,18}$/.test(String(valor))) return null;
  const tipo = tipoParametro(esq, t, columna);
  return { nombre, tipo: tipo === 'int' ? 'int' : 'bigint', valor: String(valor) };
}

/** Expresión CAST para que un lado numérico coincida con el tipo de columna de texto del otro lado (y al revés). */
function comoTipoDe(esq, tDestino, cDestino, expresion) {
  const tipo = esq.tipo(tDestino, cDestino);
  if (['char', 'varchar', 'nchar', 'nvarchar'].includes(tipo)) {
    const largo = esq.tablas.get(tDestino.toLowerCase())?.columnas.get(cDestino.toLowerCase())?.largo;
    const n = largo && largo > 0 && largo < 4000 ? largo : 50;
    return `CAST(${expresion} AS ${tipo.startsWith('n') ? 'nvarchar' : 'varchar'}(${Math.max(n, 20)}))`;
  }
  return expresion;
}

const DESDE = 'DATEADD(day, 1 - @dias, CAST(GETDATE() AS date))';
const HASTA = 'DATEADD(day, 1, CAST(GETDATE() AS date))';
const enVentana = (col) => `${col} >= ${DESDE} AND ${col} < ${HASTA}`;

function columnaFecha(esq, t) {
  return esq.columna(t, 'FechaCreacion', 'FechaRegistro', 'Fecha', 'FechaCarga', 'FechaEvento', 'FechaHora') || esq.columnaLike(t, /^fecha/i);
}
function columnaOrden(esq, t) {
  return columnaFecha(esq, t) || esq.columnas(t)[0]?.nombre || null;
}
function columnaNombre(esq, t) {
  return esq.columna(t, 'NombreEstado', 'Nombre', 'Descripcion', 'Detalle') || esq.columnaLike(t, /(nombre|descripcion)/i);
}
function columnaIdPropio(esq, t) {
  return esq.columna(t, 'Id', `Id${t}`, 'IdEstado') || esq.columnaLike(t, /^id/i);
}

const esActivo = (esq) => {
  const c = esq.columna('ProspeccionCargueInterno', 'ProspectadoInd');
  return c ? q(c) : null;
};

// ---------------------------------------------------------------------------
// RESUMEN (ventana de `dias` días: 1 = hoy)
// ---------------------------------------------------------------------------
function kpi(id, titulo, ayuda, sqlTexto) {
  return { id, titulo, ayuda, kpi: true, sql: sqlTexto, params: [] };
}

function bloquesResumen(esq, { dias }) {
  const p = [{ nombre: 'dias', tipo: 'int', valor: dias }];
  const con = (b) => (b.omitido ? b : { ...b, params: [...(b.params || []), ...p] });
  const lista = [];

  // KPIs
  const kc = (id, titulo, ayuda, t, cols = [], extra = '') => {
    const m = requiere(esq, { [t]: cols });
    const fecha = esq.tiene(t) ? columnaFecha(esq, t) : null;
    if (m) return omitir(m);
    if (!fecha) return omitir(`${SCHEMA}.${t} no tiene una columna de fecha para filtrar por día.`);
    return con(kpi(id, titulo, ayuda, `SELECT COUNT(*) AS valor FROM ${tabla(esq, t)} WITH (NOLOCK) WHERE ${enVentana(q(fecha))}${extra}`));
  };

  const act = esActivo(esq);
  lista.push(['kpi_cargues', kc('kpi_cargues', 'Cargues de campaña', 'Cargues recibidos de los aliados en el período (CampanaCargueAliado).', 'CampanaCargueAliado')]);
  lista.push(['kpi_prospectos', kc('kpi_prospectos', 'Prospectos cargados', 'Registros que llegaron en los cargues (ProspeccionCargueInterno).', 'ProspeccionCargueInterno')]);
  lista.push(['kpi_prospectados', kc('kpi_prospectados', 'Prospectados', 'De los cargados, los que ya se prospectaron (ProspectadoInd = 1).', 'ProspeccionCargueInterno', ['ProspectadoInd'], ` AND ${act} = 1`)]);
  lista.push(['kpi_prospecciones', kc('kpi_prospecciones', 'Prospecciones registradas', 'Prospecciones creadas en PD.Prospeccion (por fecha de registro).', 'Prospeccion', ['FechaRegistro'])]);
  lista.push(['kpi_procesos', kc('kpi_procesos', 'Procesos aliado', 'Procesos aliado creados (ProcesoAliado).', 'ProcesoAliado')]);
  lista.push(['kpi_analisis', kc('kpi_analisis', 'Análisis de listas', 'Consultas a listas restrictivas (AnalisisListas).', 'AnalisisListas')]);
  const logErr = esq.tablasLog().find((n) => /error/i.test(n));
  lista.push(['kpi_errores', logErr ? kc('kpi_errores', 'Errores de aliados', `Registros nuevos en ${logErr}.`, logErr) : omitir('No hay tabla de log de errores (LOG_ErrorAliados) visible.')]);
  lista.push(['kpi_pagares', kc('kpi_pagares', 'Pagarés', 'Registros en PagarePublicador en el período.', 'PagarePublicador')]);

  // Serie diaria de cargues
  {
    const m = requiere(esq, { ProspeccionCargueInterno: ['FechaCreacion', 'ProspectadoInd'] });
    lista.push(['ser_cargues_dia', m ? omitir(m) : con({
      id: 'ser_cargues_dia', titulo: 'Cargados vs prospectados por día', vista: 'serie',
      ayuda: 'Por fecha de creación del registro cargado. «Prospectados» = ProspectadoInd = 1.',
      sql: `SELECT CAST(${q(esq.columna('ProspeccionCargueInterno', 'FechaCreacion'))} AS date) AS Dia, COUNT(*) AS Cargados,
       SUM(CASE WHEN ${act} = 1 THEN 1 ELSE 0 END) AS Prospectados
FROM ${tabla(esq, 'ProspeccionCargueInterno')} WITH (NOLOCK)
WHERE ${enVentana(q(esq.columna('ProspeccionCargueInterno', 'FechaCreacion')))}
GROUP BY CAST(${q(esq.columna('ProspeccionCargueInterno', 'FechaCreacion'))} AS date)
ORDER BY Dia`,
    })]);
  }

  // Actividad por hora (prospecciones registradas)
  {
    const m = requiere(esq, { Prospeccion: ['FechaRegistro'] });
    lista.push(['ser_hora', m ? omitir(m) : con({
      id: 'ser_hora', titulo: 'Prospecciones por hora del día', vista: 'barras',
      ayuda: 'Hora de registro de las prospecciones del período (útil para ver a qué hora corre la prospección del aliado).',
      sql: `SELECT DATEPART(hour, ${q(esq.columna('Prospeccion', 'FechaRegistro'))}) AS Hora, COUNT(*) AS Prospecciones
FROM ${tabla(esq, 'Prospeccion')} WITH (NOLOCK)
WHERE ${enVentana(q(esq.columna('Prospeccion', 'FechaRegistro')))}
GROUP BY DATEPART(hour, ${q(esq.columna('Prospeccion', 'FechaRegistro'))})
ORDER BY Hora`,
    })]);
  }

  // Procesos por estado
  {
    const m = requiere(esq, { ProcesoAliado: ['IdEstadoProceso', 'FechaCreacion'], EstadoProcesoAliado: ['Id', 'NombreEstado'] });
    lista.push(['tab_procesos_estado', m ? omitir(m) : con({
      id: 'tab_procesos_estado', titulo: 'Procesos aliado por estado', vista: 'barras',
      ayuda: 'ProcesoAliado creados en el período, agrupados por EstadoProcesoAliado.',
      sql: `SELECT ISNULL(est.NombreEstado, '(sin estado)') AS Estado, pa.IdEstadoProceso AS IdEstado, COUNT(*) AS Cantidad
FROM ${tabla(esq, 'ProcesoAliado')} pa WITH (NOLOCK)
LEFT JOIN ${tabla(esq, 'EstadoProcesoAliado')} est WITH (NOLOCK) ON est.Id = pa.IdEstadoProceso
WHERE ${enVentana('pa.FechaCreacion')}
GROUP BY est.NombreEstado, pa.IdEstadoProceso
ORDER BY Cantidad DESC`,
    })]);
  }

  // Procesos por aliado y estado
  {
    const m = requiere(esq, { ProcesoAliado: ['IdEstadoProceso', 'FechaCreacion', 'IdAliado'], EstadoProcesoAliado: ['Id', 'NombreEstado'], Aliado: ['Id', 'Nombre'] });
    lista.push(['tab_procesos_aliado', m ? omitir(m) : con({
      id: 'tab_procesos_aliado', titulo: 'Procesos por aliado y estado',
      ayuda: 'Cuántos procesos tiene cada aliado en cada estado dentro del período.',
      sql: `SELECT TOP (200) al.Nombre AS Aliado, ISNULL(est.NombreEstado, '(sin estado)') AS Estado, COUNT(*) AS Cantidad
FROM ${tabla(esq, 'ProcesoAliado')} pa WITH (NOLOCK)
LEFT JOIN ${tabla(esq, 'Aliado')} al WITH (NOLOCK) ON al.Id = pa.IdAliado
LEFT JOIN ${tabla(esq, 'EstadoProcesoAliado')} est WITH (NOLOCK) ON est.Id = pa.IdEstadoProceso
WHERE ${enVentana('pa.FechaCreacion')}
GROUP BY al.Nombre, est.NombreEstado
ORDER BY Cantidad DESC`,
    })]);
  }

  // Detalle de campañas por estado
  {
    const t = 'DetalleCampanas';
    const m = requiere(esq, { [t]: ['IdEstadoDetalle'] });
    const fecha = esq.tiene(t) ? columnaFecha(esq, t) : null;
    const cat = esq.tablas.has('tipoestadodetallecampana') ? 'TipoEstadoDetalleCampana' : null;
    const catId = cat ? columnaIdPropio(esq, cat) : null;
    const catNom = cat ? columnaNombre(esq, cat) : null;
    if (m) lista.push(['tab_detalle_estado', omitir(m)]);
    else if (!fecha) lista.push(['tab_detalle_estado', omitir('DetalleCampanas no tiene una columna de fecha: no se agrupa para no recorrer toda la tabla.')]);
    else {
      const unir = cat && catId && catNom ? `LEFT JOIN ${tabla(esq, cat)} e WITH (NOLOCK) ON e.${q(catId)} = d.${q(esq.columna(t, 'IdEstadoDetalle'))}` : '';
      const nombre = cat && catId && catNom ? `ISNULL(CAST(e.${q(catNom)} AS nvarchar(100)), '(sin nombre)')` : "'(estado)'";
      lista.push(['tab_detalle_estado', con({
        id: 'tab_detalle_estado', titulo: 'Detalle de campañas por estado', vista: 'barras',
        ayuda: 'Estado de los registros de DetalleCampanas creados en el período (TipoEstadoDetalleCampana).',
        sql: `SELECT ${nombre} AS Estado, d.${q(esq.columna(t, 'IdEstadoDetalle'))} AS IdEstado, COUNT(*) AS Cantidad
FROM ${tabla(esq, t)} d WITH (NOLOCK)
${unir}
WHERE ${enVentana(`d.${q(fecha)}`)}
GROUP BY ${cat && catId && catNom ? `e.${q(catNom)}, ` : ''}d.${q(esq.columna(t, 'IdEstadoDetalle'))}
ORDER BY Cantidad DESC`,
      })]);
    }
  }

  return lista;
}

// ---------------------------------------------------------------------------
// CARGUES (lista de cargues con su avance)
// ---------------------------------------------------------------------------
function bloqueCargues(esq, { top }) {
  const t = 'CampanaCargueAliado';
  const m = requiere(esq, { [t]: [], ProspeccionCargueInterno: ['IdCampanaCargue', 'ProspectadoInd'] });
  if (m) return omitir(m);
  const idCol = esq.columna(t, 'IdCampanaCargue', 'Id') || esq.columnas(t)[0]?.nombre;
  const orden = columnaOrden(esq, t);
  if (!idCol || !orden) return omitir(`No se pudo determinar la columna identificadora de ${SCHEMA}.${t}.`);
  const pci = 'ProspeccionCargueInterno';
  const ci = q(esq.columna(pci, 'IdCampanaCargue'));
  const act = esActivo(esq);
  return {
    id: 'tab_cargues', titulo: 'Cargues de campaña de los aliados', generico: true, clic: 'cargue', columnaId: idCol,
    ayuda: `Últimos cargues (CampanaCargueAliado) con cuántos prospectos trajo cada uno y cuántos ya se prospectaron. Orden: ${orden} descendente.`,
    sql: `SELECT TOP (@top) c.*, ISNULL(s.Total, 0) AS AxTotal, ISNULL(s.Prospectados, 0) AS AxProspectados, ISNULL(s.Total, 0) - ISNULL(s.Prospectados, 0) AS AxPendientes
FROM ${tabla(esq, t)} c WITH (NOLOCK)
LEFT JOIN (
    SELECT ci.${ci} AS IdCargue, COUNT(*) AS Total, SUM(CASE WHEN ci.${act} = 1 THEN 1 ELSE 0 END) AS Prospectados
    FROM ${tabla(esq, pci)} ci WITH (NOLOCK)
    WHERE ci.${ci} IN (SELECT TOP (@top) x.${q(idCol)} FROM ${tabla(esq, t)} x WITH (NOLOCK) ORDER BY x.${q(orden)} DESC)
    GROUP BY ci.${ci}
) s ON s.IdCargue = c.${q(idCol)}
ORDER BY c.${q(orden)} DESC`,
    params: [{ nombre: 'top', tipo: 'int', valor: top }],
  };
}

// ---------------------------------------------------------------------------
// DETALLE DE UN CARGUE (param: id = IdCampanaCargue)
// ---------------------------------------------------------------------------
function bloquesCargue(esq, { id }) {
  const pci = 'ProspeccionCargueInterno';
  const lista = [];
  const mBase = requiere(esq, { [pci]: ['IdCampanaCargue'] });
  if (mBase) return [['cd_resumen', omitir(mBase)]];
  const colId = esq.columna(pci, 'IdCampanaCargue');
  const pId = paramEntero(esq, pci, colId, id);
  if (!pId) return [['cd_resumen', omitir('El identificador del cargue debe ser un número.')]];
  const T = tabla(esq, pci);
  const act = esActivo(esq);
  const fc = esq.columna(pci, 'FechaCreacion');
  const fm = esq.columna(pci, 'FechaModificacion');

  const resumenCols = ['COUNT(*) AS Total'];
  if (act) resumenCols.push(`SUM(CASE WHEN ci.${act} = 1 THEN 1 ELSE 0 END) AS Prospectados`, `SUM(CASE WHEN ISNULL(ci.${act}, 0) <> 1 THEN 1 ELSE 0 END) AS Pendientes`);
  if (fc) resumenCols.push(`MIN(ci.${q(fc)}) AS PrimeraCarga`);
  if (fm) resumenCols.push(`MAX(ci.${q(fm)}) AS UltimaModificacion`);
  lista.push(['cd_resumen', { id: 'cd_resumen', titulo: 'Resumen del cargue', kpiFila: true, sql: `SELECT ${resumenCols.join(', ')}\nFROM ${T} ci WITH (NOLOCK)\nWHERE ci.${q(colId)} = @id`, params: [pId] }]);

  if (esq.tiene('CampanaCargueAliado')) {
    const idCampana = esq.columna('CampanaCargueAliado', 'IdCampanaCargue', 'Id') || esq.columnas('CampanaCargueAliado')[0]?.nombre;
    const p2 = paramEntero(esq, 'CampanaCargueAliado', idCampana, id);
    lista.push(['cd_fila', p2 ? { id: 'cd_fila', titulo: 'Datos del cargue (CampanaCargueAliado)', generico: true, vertical: true, sql: `SELECT TOP (1) * FROM ${tabla(esq, 'CampanaCargueAliado')} WITH (NOLOCK) WHERE ${q(idCampana)} = @id`, params: [p2] } : omitir('Identificador no numérico.')]);
  }

  if (act) {
    lista.push(['cd_pendientes', {
      id: 'cd_pendientes', titulo: 'Prospectos del cargue SIN prospectar', generico: true,
      ayuda: 'Registros del cargue con ProspectadoInd distinto de 1 (máx. 200, más recientes primero).',
      sql: `SELECT TOP (200) * FROM ${T} WITH (NOLOCK) WHERE ${q(colId)} = @id AND ISNULL(${act}, 0) <> 1 ORDER BY ${q(fm || fc || colId)} DESC`, params: [pId],
    }]);
  }
  lista.push(['cd_prospectos', {
    id: 'cd_prospectos', titulo: 'Prospectos del cargue', generico: true,
    ayuda: 'Registros que trajo el cargue (máx. 200, más recientes primero). Se ocultan datos de contacto.',
    sql: `SELECT TOP (200) * FROM ${T} WITH (NOLOCK) WHERE ${q(colId)} = @id ORDER BY ${q(fm || fc || colId)} DESC`, params: [pId],
  }]);

  // Prospecciones creadas desde el cargue (IdAliadoExterno = IdProspecto): el vínculo exacto con el cargue.
  const mPro = requiere(esq, { Prospeccion: ['IdAliadoExterno', 'IdLote'], [pci]: ['IdProspecto'] });
  if (mPro) {
    lista.push(['cd_prospeccion', omitir(mPro)]);
  } else {
    const ext = q(esq.columna('Prospeccion', 'IdAliadoExterno'));
    const idPro = q(esq.columna(pci, 'IdProspecto'));
    const subconsulta = `SELECT ${comoTipoDe(esq, 'Prospeccion', esq.columna('Prospeccion', 'IdAliadoExterno'), `ci.${idPro}`)} FROM ${T} ci WITH (NOLOCK) WHERE ci.${q(colId)} = @id`;
    const colsP = ['Id', 'NumeroDocumento', 'TipoSubproducto', 'IdLote', 'IdAliadoExterno', 'FechaRegistro', 'FechaModificacion']
      .map((c) => esq.columna('Prospeccion', c)).filter(Boolean).map((c) => `p.${q(c)}`);
    const ordenP = esq.columna('Prospeccion', 'FechaModificacion', 'FechaRegistro', 'Id');
    lista.push(['cd_prospeccion', {
      id: 'cd_prospeccion', titulo: 'Prospecciones creadas por el cargue',
      ayuda: 'PD.Prospeccion cuyo IdAliadoExterno es el IdProspecto de este cargue (el vínculo exacto; no depende del documento).',
      sql: `SELECT TOP (200) ${colsP.join(', ')}\nFROM ${tabla(esq, 'Prospeccion')} p WITH (NOLOCK)\nWHERE p.${ext} IN (${subconsulta})\nORDER BY p.${q(ordenP)} DESC`, params: [pId],
    }]);

    const colLote = q(esq.columna('Prospeccion', 'IdLote'));
    const fr = esq.columna('Prospeccion', 'FechaRegistro');
    lista.push(['cd_lotes', {
      id: 'cd_lotes', titulo: 'Lotes (IdLote) generados por el cargue',
      ayuda: 'Con el lote se siguen los procesos aliado y sus estados.',
      sql: `SELECT p.${colLote} AS IdLote, COUNT(*) AS Prospecciones${fr ? `, MIN(p.${q(fr)}) AS Primera, MAX(p.${q(fr)}) AS Ultima` : ''}\nFROM ${tabla(esq, 'Prospeccion')} p WITH (NOLOCK)\nWHERE p.${ext} IN (${subconsulta})\nGROUP BY p.${colLote}\nORDER BY p.${colLote} DESC`, params: [pId],
    }]);

    const mProc = requiere(esq, { ProcesoAliado: ['IdLote', 'IdEstadoProceso'], EstadoProcesoAliado: ['Id', 'NombreEstado'] });
    if (mProc) {
      lista.push(['cd_procesos_estado', omitir(mProc)]);
      lista.push(['cd_procesos', omitir(mProc)]);
    } else {
      const lotes = `SELECT DISTINCT p.${colLote} FROM ${tabla(esq, 'Prospeccion')} p WITH (NOLOCK) WHERE p.${ext} IN (${subconsulta})`;
      lista.push(['cd_procesos_estado', {
        id: 'cd_procesos_estado', titulo: 'Procesos aliado de esos lotes, por estado', vista: 'barras',
        sql: `SELECT ISNULL(est.NombreEstado, '(sin estado)') AS Estado, COUNT(*) AS Cantidad\nFROM ${tabla(esq, 'ProcesoAliado')} pa WITH (NOLOCK)\nLEFT JOIN ${tabla(esq, 'EstadoProcesoAliado')} est WITH (NOLOCK) ON est.Id = pa.IdEstadoProceso\nWHERE pa.${q(esq.columna('ProcesoAliado', 'IdLote'))} IN (${lotes})\nGROUP BY est.NombreEstado\nORDER BY Cantidad DESC`, params: [pId],
      }]);
      const cols = [['NumeroDocumento', 'Documento'], ['IdLote', 'IdLote'], ['IdEstadoProceso', 'IdEstado'], ['NoSolicitud', 'NoSolicitud'], ['FechaCreacion', 'Creado'], ['FechaModificacion', 'Modificado']]
        .filter(([c]) => esq.columna('ProcesoAliado', c)).map(([c, a]) => `pa.${q(esq.columna('ProcesoAliado', c))} AS ${a}`);
      const aliado = esq.tiene('Aliado') && esq.columna('ProcesoAliado', 'IdAliado') && esq.columna('Aliado', 'Id') && esq.columna('Aliado', 'Nombre');
      lista.push(['cd_procesos', {
        id: 'cd_procesos', titulo: 'Procesos aliado de esos lotes',
        sql: `SELECT TOP (300) ${cols.join(', ')}, est.NombreEstado AS Estado${aliado ? ', al.Nombre AS Aliado' : ''}\nFROM ${tabla(esq, 'ProcesoAliado')} pa WITH (NOLOCK)\nLEFT JOIN ${tabla(esq, 'EstadoProcesoAliado')} est WITH (NOLOCK) ON est.Id = pa.IdEstadoProceso\n${aliado ? `LEFT JOIN ${tabla(esq, 'Aliado')} al WITH (NOLOCK) ON al.Id = pa.IdAliado\n` : ''}WHERE pa.${q(esq.columna('ProcesoAliado', 'IdLote'))} IN (${lotes})\nORDER BY ${esq.columna('ProcesoAliado', 'FechaModificacion', 'FechaCreacion') ? `pa.${q(esq.columna('ProcesoAliado', 'FechaModificacion', 'FechaCreacion'))} DESC` : '1'}`, params: [pId],
      }]);
    }
  }
  return lista;
}

// ---------------------------------------------------------------------------
// CLIENTE (param: documento) — todo lo que se sabe de un documento en PD y en la traza
// ---------------------------------------------------------------------------
function bloquesCliente(esq, { documento, trazaDias }) {
  const lista = [];
  const doc = String(documento);
  const generico = (id, titulo, t, colDoc, ordenCols, top = 100, ayuda) => {
    const m = requiere(esq, { [t]: [colDoc] });
    if (m) return [id, omitir(m)];
    const col = esq.columna(t, colDoc);
    const p = paramDocumento(esq, t, col, doc);
    if (!p) return [id, omitir('No aplica: la columna es numérica y el documento tiene letras.')];
    const ord = esq.columna(t, ...ordenCols) || esq.columnas(t)[0]?.nombre;
    return [id, { id, titulo, generico: true, ayuda, sql: `SELECT TOP (${top}) * FROM ${tabla(esq, t)} WITH (NOLOCK) WHERE ${q(col)} = @doc ORDER BY ${q(ord)} DESC`, params: [p] }];
  };

  lista.push(generico('cl_cargues', 'Cargues en los que aparece', 'ProspeccionCargueInterno', 'NumeroDocumento', ['FechaModificacion', 'FechaCreacion', 'IdCampanaCargue'], 50,
    'ProspeccionCargueInterno: IdCampanaCargue, si se prospectó (ProspectadoInd) y la fecha (FechaModificacion).'));

  {
    const t = 'Prospeccion';
    const m = requiere(esq, { [t]: ['NumeroDocumento'] });
    if (m) lista.push(['cl_prospeccion', omitir(m)]);
    else {
      const col = esq.columna(t, 'NumeroDocumento');
      const p = paramDocumento(esq, t, col, doc);
      const cols = ['Id', 'NumeroDocumento', 'TipoSubproducto', 'IdLote', 'IdAliadoExterno', 'FechaRegistro', 'FechaModificacion'].map((c) => esq.columna(t, c)).filter(Boolean).map((c) => `p.${q(c)}`);
      const ord = esq.columna(t, 'FechaModificacion', 'FechaRegistro', 'Id');
      lista.push(['cl_prospeccion', p ? { id: 'cl_prospeccion', titulo: 'Prospecciones (PD.Prospeccion)', ayuda: 'Una fila por prospección; IdLote une con los procesos aliado.', sql: `SELECT TOP (50) ${cols.join(', ')}\nFROM ${tabla(esq, t)} p WITH (NOLOCK)\nWHERE p.${q(col)} = @doc\nORDER BY p.${q(ord)} DESC`, params: [p] } : omitir('Documento no numérico.')]);
    }
  }

  lista.push(generico('cl_detalle', 'Campañas del cliente (DetalleCampanas)', 'DetalleCampanas', 'NumeroDocumento', ['IdCampana'], 100, 'Estado de cada campaña generada para el documento.'));

  // Procesos aliado + oferta (trazabilidad)
  {
    const m = requiere(esq, { ProcesoAliado: ['NumeroDocumento'] });
    if (m) lista.push(['cl_procesos', omitir(m)]);
    else {
      const tp = 'ProcesoAliado';
      const col = esq.columna(tp, 'NumeroDocumento');
      const p = paramDocumento(esq, tp, col, doc);
      if (!p) lista.push(['cl_procesos', omitir('No aplica: ProcesoAliado.NumeroDocumento es numérico y el documento tiene letras.')]);
      else {
        const pa = (c) => (esq.columna(tp, c) ? `pa.${q(esq.columna(tp, c))}` : null);
        const sel = [[pa('IdLote'), 'IdLote'], [pa('IdEstadoProceso'), 'IdEstado'], [pa('NoSolicitud'), 'NoSolicitud'], [pa('FechaCreacion'), 'Creado'], [pa('FechaModificacion'), 'Modificado']]
          .filter(([e]) => e).map(([e, a]) => `${e} AS ${a}`);
        const unionEstado = esq.tiene('EstadoProcesoAliado') && esq.columna('EstadoProcesoAliado', 'Id') && esq.columna('EstadoProcesoAliado', 'NombreEstado') && pa('IdEstadoProceso');
        const unionAliado = esq.tiene('Aliado') && pa('IdAliado') && esq.columna('Aliado', 'Id') && esq.columna('Aliado', 'Nombre');
        const oferta = esq.tiene('OfertaAliado') && esq.columna('OfertaAliado', 'NumeroDocumento') && esq.columna('OfertaAliado', 'IdLote') && esq.columna('OfertaAliado', 'Monto') && pa('IdLote');
        const prod = oferta && esq.tiene('TipoProducto') && esq.columna('OfertaAliado', 'TipoSubproducto') && esq.columna('TipoProducto', 'IdProducto') && esq.columna('TipoProducto', 'Descripcion');
        const O = (c) => `o.${q(esq.columna('OfertaAliado', c))}`;
        const ord = esq.columna(tp, 'FechaModificacion', 'FechaCreacion');
        lista.push(['cl_procesos', {
          id: 'cl_procesos', titulo: 'Procesos aliado y oferta (trazabilidad)',
          ayuda: 'ProcesoAliado con su estado, aliado, solicitud y la oferta (monto y producto) del mismo lote. Una fila por proceso.',
          sql: `SELECT TOP (100) ${sel.join(', ')}${unionEstado ? ', est.NombreEstado AS Estado' : ''}${unionAliado ? ', al.Nombre AS Aliado' : ''}${oferta ? `, ofe.Monto AS Monto${prod ? ', ofe.Producto AS Producto' : ''}` : ''}
FROM ${tabla(esq, tp)} pa WITH (NOLOCK)
${unionEstado ? `LEFT JOIN ${tabla(esq, 'EstadoProcesoAliado')} est WITH (NOLOCK) ON est.Id = pa.${q(esq.columna(tp, 'IdEstadoProceso'))}\n` : ''}${unionAliado ? `LEFT JOIN ${tabla(esq, 'Aliado')} al WITH (NOLOCK) ON al.Id = pa.${q(esq.columna(tp, 'IdAliado'))}\n` : ''}${oferta ? `OUTER APPLY (
    SELECT TOP (1) ${O('Monto')} AS Monto${prod ? `, tp.${q(esq.columna('TipoProducto', 'Descripcion'))} AS Producto` : ''}
    FROM ${tabla(esq, 'OfertaAliado')} o WITH (NOLOCK)
    ${prod ? `LEFT JOIN ${tabla(esq, 'TipoProducto')} tp WITH (NOLOCK) ON tp.${q(esq.columna('TipoProducto', 'IdProducto'))} = ${O('TipoSubproducto')}\n    ` : ''}WHERE ${O('NumeroDocumento')} = pa.${q(col)} AND ${O('IdLote')} = ${pa('IdLote')}
) ofe\n` : ''}WHERE pa.${q(col)} = @doc
ORDER BY ${ord ? `pa.${q(ord)} DESC` : '1'}`,
          params: [p],
        }]);
      }
    }
  }

  // Análisis de listas por las prospecciones del documento
  {
    const m = requiere(esq, { AnalisisListas: ['IdProspeccion'], Prospeccion: ['Id', 'NumeroDocumento'] });
    if (m) lista.push(['cl_analisis', omitir(m)]);
    else {
      const pcol = esq.columna('Prospeccion', 'NumeroDocumento');
      const p = paramDocumento(esq, 'Prospeccion', pcol, doc);
      const ord = esq.columna('AnalisisListas', 'FechaCreacion') || esq.columna('AnalisisListas', 'IdProspeccion');
      lista.push(['cl_analisis', p ? {
        id: 'cl_analisis', titulo: 'Análisis de listas', generico: true,
        ayuda: 'AnalisisListas de las prospecciones de este documento (sin filtro de fecha; máx. 100).',
        sql: `SELECT TOP (100) * FROM ${tabla(esq, 'AnalisisListas')} WITH (NOLOCK)\nWHERE ${q(esq.columna('AnalisisListas', 'IdProspeccion'))} IN (SELECT pr.${q(esq.columna('Prospeccion', 'Id'))} FROM ${tabla(esq, 'Prospeccion')} pr WITH (NOLOCK) WHERE pr.${q(pcol)} = @doc)\nORDER BY ${q(ord)} DESC`, params: [p],
      } : omitir('Documento no numérico.')]);
    }
  }

  lista.push(generico('cl_pagares', 'Pagarés (PagarePublicador)', 'PagarePublicador', 'NumeroDocumento', ['FechaCreacion', 'FechaModificacion', 'Id'], 50, 'Pagarés publicados para el documento.'));

  // Campañas del lote
  {
    const m = requiere(esq, { Campana: ['IdLoteAliado'], ProcesoAliado: ['NumeroDocumento', 'IdLote'] });
    if (m) lista.push(['cl_campanas', omitir(m)]);
    else {
      const col = esq.columna('ProcesoAliado', 'NumeroDocumento');
      const p = paramDocumento(esq, 'ProcesoAliado', col, doc);
      const lote = `pa.${q(esq.columna('ProcesoAliado', 'IdLote'))}`;
      const cl = esq.columna('Campana', 'IdLoteAliado');
      lista.push(['cl_campanas', p ? {
        id: 'cl_campanas', titulo: 'Campañas generadas por sus lotes (Campana)', generico: true,
        ayuda: 'Campana.IdLoteAliado = IdLote de sus procesos aliado.',
        sql: `SELECT TOP (100) * FROM ${tabla(esq, 'Campana')} WITH (NOLOCK)\nWHERE ${q(cl)} IN (SELECT ${comoTipoDe(esq, 'Campana', cl, lote)} FROM ${tabla(esq, 'ProcesoAliado')} pa WITH (NOLOCK) WHERE pa.${q(col)} = @doc)\nORDER BY ${q(esq.columna('Campana', 'FechaCreacion', 'IdCampana') || cl)} DESC`, params: [p],
      } : omitir('Documento no numérico.')]);
    }
  }

  // Errores en los logs de PD
  {
    const tl = esq.tablasLog().find((n) => /error/i.test(n));
    const cd = tl ? esq.columnaLike(tl, /documento/i) : null;
    if (!tl || !cd) lista.push(['cl_errores', omitir('No hay tabla de errores con una columna de documento.')]);
    else {
      const p = paramDocumento(esq, tl, cd, doc);
      lista.push(['cl_errores', p ? { id: 'cl_errores', titulo: `Errores registrados (${tl})`, generico: true, sql: `SELECT TOP (50) * FROM ${tabla(esq, tl)} WITH (NOLOCK) WHERE ${q(cd)} = @doc ORDER BY ${q(columnaOrden(esq, tl))} DESC`, params: [p] } : omitir('Documento no numérico.')]);
    }
  }

  // Traza transaccional (otra base: LogTransaccional)
  lista.push(['cl_traza', {
    id: 'cl_traza', titulo: 'Traza transaccional (LogTransaccional)', externa: true,
    ayuda: `Registros de la traza del documento en los últimos ${trazaDias} día(s): paso, método, servicio ACE y mensaje. No se trae la columna Datos (puede contener datos personales).`,
    sql: `SELECT TOP (200) r.Fecha, p.Nombre AS Paso, r.Metodo, ace.Servicio, ace.Metodo AS Operacion, r.Mensaje, r.Guid
FROM LogTransaccional.Traza.Traza t WITH (NOLOCK)
INNER JOIN LogTransaccional.Traza.Registro r WITH (NOLOCK) ON t.Codigo = r.Traza
INNER JOIN LogTransaccional.Traza.Paso p WITH (NOLOCK) ON t.Paso = p.Codigo
LEFT JOIN LogTransaccional.Traza.Ace ace WITH (NOLOCK) ON r.Ace = ace.Codigo
WHERE t.Documento = @doc
  AND r.Fecha >= DATEADD(day, 1 - @dias, CAST(GETDATE() AS date)) AND r.Fecha < ${HASTA}
ORDER BY r.Fecha DESC`,
    params: [{ nombre: 'doc', tipo: 'varchar', valor: doc }, { nombre: 'dias', tipo: 'int', valor: trazaDias }],
  }]);
  return lista;
}

// ---------------------------------------------------------------------------
// PROCESOS ALIADO (lista filtrable)
// ---------------------------------------------------------------------------
function bloqueProcesos(esq, { dias, top, estado, aliado }) {
  const m = requiere(esq, { ProcesoAliado: ['IdEstadoProceso', 'FechaCreacion'] });
  if (m) return omitir(m);
  const tp = 'ProcesoAliado';
  const pa = (c) => (esq.columna(tp, c) ? `pa.${q(esq.columna(tp, c))}` : null);
  const params = [{ nombre: 'dias', tipo: 'int', valor: dias }, { nombre: 'top', tipo: 'int', valor: top }];
  let filtros = '';
  if (estado !== undefined && estado !== null && estado !== '') {
    params.push({ nombre: 'estado', tipo: 'int', valor: estado });
    filtros += ' AND pa.' + q(esq.columna(tp, 'IdEstadoProceso')) + ' = @estado';
  }
  if (aliado !== undefined && aliado !== null && aliado !== '' && pa('IdAliado')) {
    params.push({ nombre: 'aliado', tipo: 'int', valor: aliado });
    filtros += ` AND ${pa('IdAliado')} = @aliado`;
  }
  const cols = [[pa('NumeroDocumento'), 'Documento'], [pa('IdLote'), 'IdLote'], [pa('IdEstadoProceso'), 'IdEstado'], [pa('NoSolicitud'), 'NoSolicitud'], [pa('FechaCreacion'), 'Creado'], [pa('FechaModificacion'), 'Modificado']]
    .filter(([e]) => e).map(([e, a]) => `${e} AS ${a}`);
  const est = esq.tiene('EstadoProcesoAliado') && esq.columna('EstadoProcesoAliado', 'Id') && esq.columna('EstadoProcesoAliado', 'NombreEstado');
  const ali = esq.tiene('Aliado') && pa('IdAliado') && esq.columna('Aliado', 'Id') && esq.columna('Aliado', 'Nombre');
  return {
    id: 'tab_procesos', titulo: 'Procesos aliado',
    ayuda: 'ProcesoAliado creados en el período, con estado y aliado. Se puede filtrar por estado y por aliado.',
    sql: `SELECT TOP (@top) ${cols.join(', ')}${est ? ', est.NombreEstado AS Estado' : ''}${ali ? ', al.Nombre AS Aliado' : ''}
FROM ${tabla(esq, tp)} pa WITH (NOLOCK)
${est ? `LEFT JOIN ${tabla(esq, 'EstadoProcesoAliado')} est WITH (NOLOCK) ON est.Id = pa.${q(esq.columna(tp, 'IdEstadoProceso'))}\n` : ''}${ali ? `LEFT JOIN ${tabla(esq, 'Aliado')} al WITH (NOLOCK) ON al.Id = ${pa('IdAliado')}\n` : ''}WHERE ${enVentana('pa.' + q(esq.columna(tp, 'FechaCreacion')))}${filtros}
ORDER BY pa.${q(esq.columna(tp, 'FechaModificacion', 'FechaCreacion'))} DESC`,
    params,
  };
}

function bloquesCatalogos(esq) {
  const lista = [];
  const m1 = requiere(esq, { EstadoProcesoAliado: ['Id', 'NombreEstado'] });
  lista.push(['estados', m1 ? omitir(m1) : { id: 'estados', titulo: 'Estados', sql: `SELECT TOP (200) Id, NombreEstado AS Nombre FROM ${tabla(esq, 'EstadoProcesoAliado')} WITH (NOLOCK) ORDER BY Id`, params: [] }]);
  const m2 = requiere(esq, { Aliado: ['Id', 'Nombre'] });
  lista.push(['aliados', m2 ? omitir(m2) : { id: 'aliados', titulo: 'Aliados', sql: `SELECT TOP (300) Id, Nombre FROM ${tabla(esq, 'Aliado')} WITH (NOLOCK) ORDER BY Nombre`, params: [] }]);
  return lista;
}

// ---------------------------------------------------------------------------
// PAGARÉS
// ---------------------------------------------------------------------------
function bloquesPagares(esq, { dias, top }) {
  const t = 'PagarePublicador';
  if (!esq.tiene(t)) return [['tab_pagares', omitir(`No existe la tabla ${SCHEMA}.${t} (o la cuenta no puede verla).`)]];
  const fecha = columnaFecha(esq, t);
  const orden = columnaOrden(esq, t);
  const params = [{ nombre: 'top', tipo: 'int', valor: top }, ...(fecha ? [{ nombre: 'dias', tipo: 'int', valor: dias }] : [])];
  const ventana = fecha ? ` WHERE ${enVentana(q(fecha))}` : '';
  const lista = [['tab_pagares', {
    id: 'tab_pagares', titulo: 'Pagarés publicados', generico: true,
    ayuda: fecha ? `PagarePublicador del período (por ${fecha}), más recientes primero. Se ocultan datos personales.` : 'PagarePublicador, más recientes primero (la tabla no tiene columna de fecha).',
    sql: `SELECT TOP (@top) * FROM ${tabla(esq, t)} WITH (NOLOCK)${ventana} ORDER BY ${q(orden)} DESC`, params,
  }]];
  const colEstado = esq.columna(t, 'IdEstadoPublicador', 'IdEstado', 'Estado') || esq.columnaLike(t, /estado/i);
  if (colEstado) {
    const cat = esq.tiene('TipoEstadoPublicador') ? 'TipoEstadoPublicador' : null;
    const catId = cat ? columnaIdPropio(esq, cat) : null;
    const catNom = cat ? columnaNombre(esq, cat) : null;
    const unir = cat && catId && catNom ? `LEFT JOIN ${tabla(esq, cat)} e WITH (NOLOCK) ON e.${q(catId)} = p.${q(colEstado)}` : '';
    lista.push(['tab_pagares_estado', {
      id: 'tab_pagares_estado', titulo: 'Pagarés por estado', vista: 'barras',
      sql: `SELECT ${unir ? `ISNULL(CAST(e.${q(catNom)} AS nvarchar(100)), '(sin nombre)')` : `CAST(p.${q(colEstado)} AS nvarchar(100))`} AS Estado, COUNT(*) AS Cantidad\nFROM ${tabla(esq, t)} p WITH (NOLOCK)\n${unir}\n${fecha ? `WHERE ${enVentana('p.' + q(fecha))}\n` : ''}GROUP BY ${unir ? `e.${q(catNom)}` : `p.${q(colEstado)}`}\nORDER BY Cantidad DESC`,
      params: fecha ? [{ nombre: 'dias', tipo: 'int', valor: dias }] : [],
    }]);
  }
  return lista;
}

// ---------------------------------------------------------------------------
// LOGS (tablas LOG_* de PD)
// ---------------------------------------------------------------------------
function bloquesLogs(esq, { tabla: nombre, dias, top }) {
  const disponibles = esq.tablasLog();
  const elegida = disponibles.find((n) => n.toLowerCase() === String(nombre || '').toLowerCase()) || disponibles.find((n) => /error/i.test(n)) || disponibles[0];
  if (!elegida) return { tablas: [], bloques: [['tab_log', omitir('No hay tablas LOG_* visibles en el esquema pd.')]] };
  const fecha = columnaFecha(esq, elegida);
  const orden = columnaOrden(esq, elegida);
  const params = [{ nombre: 'top', tipo: 'int', valor: top }, ...(fecha ? [{ nombre: 'dias', tipo: 'int', valor: dias }] : [])];
  const bloques = [['tab_log', {
    id: 'tab_log', titulo: `Registros de ${elegida}`, generico: true,
    ayuda: fecha ? `Más recientes primero; período por ${fecha}.` : 'Más recientes primero (sin columna de fecha: se muestra el tope).',
    sql: `SELECT TOP (@top) * FROM ${tabla(esq, elegida)} WITH (NOLOCK)${fecha ? ` WHERE ${enVentana(q(fecha))}` : ''} ORDER BY ${q(orden)} DESC`, params,
  }]];
  if (fecha) {
    bloques.push(['tab_log_dia', {
      id: 'tab_log_dia', titulo: `${elegida}: registros por día`, vista: 'barras',
      sql: `SELECT CAST(${q(fecha)} AS date) AS Dia, COUNT(*) AS Registros FROM ${tabla(esq, elegida)} WITH (NOLOCK) WHERE ${enVentana(q(fecha))} GROUP BY CAST(${q(fecha)} AS date) ORDER BY Dia`,
      params: [{ nombre: 'dias', tipo: 'int', valor: dias }],
    }]);
  }
  return { tablas: disponibles, elegida, bloques };
}

const SQL_ESQUEMA = `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = '${SCHEMA}'
ORDER BY TABLE_NAME, ORDINAL_POSITION`;

module.exports = {
  SCHEMA, RE_COLUMNA_SENSIBLE, RE_DOCUMENTO, SQL_ESQUEMA,
  Esquema, q, requiere, tipoParametro, paramDocumento, paramEntero, comoTipoDe, columnaFecha, columnaOrden,
  bloquesResumen, bloqueCargues, bloquesCargue, bloquesCliente, bloqueProcesos, bloquesCatalogos, bloquesPagares, bloquesLogs,
};
