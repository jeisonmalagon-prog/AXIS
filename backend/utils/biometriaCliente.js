// Consulta de biometría POR CLIENTE (solo lectura, SQL Server): el usuario busca por cédula (o nombre, número de caso o
// RadNumber) y ve todo lo que hay del cliente:
//
//  · ORQBIOMETRIA: CLIENTE → CASO (+ ESTADO) → CAPTURA → RESULTADO (+ ESTADO), con todas las columnas "simples" de cada tabla;
//  · MotorFirma: Firma.Detalle (por IdCasoBiometria de esos casos) → PendienteFirma.Solicitudes (por RadNumber).
//
// Las columnas de cada tabla se descubren con INFORMATION_SCHEMA (así se muestra "lo demás" sin hardcodear el esquema).
// Se omiten columnas binarias, textos largos y nombres que huelen a imagen/plantilla/clave (fotos, huellas, tokens).
// Todas las consultas las arma el backend con identificadores fijos y parámetros: no se acepta SQL del usuario.

const { consultar } = require('./sqlServer');
const { esEstadoExitoso, ENMASCARADO } = require('./biometriaConsulta');

const TTL_COLUMNAS_MS = 10 * 60 * 1000;
const MAX_CLIENTES = 25;
const MAX_CASOS = 200;
const MAX_RADICADOS = 100;
const LOTE = 400;

const TIPOS_OMITIDOS = new Set(['binary', 'varbinary', 'image', 'xml', 'text', 'ntext', 'geography', 'geometry', 'hierarchyid', 'sql_variant', 'timestamp', 'rowversion']);
const NOMBRE_SENSIBLE = /(foto|imagen|image|base64|plantilla|template|wsq|bytes|blob|password|passw|clave|secret|token|hash|biometria_?data)/i;
const MAX_LARGO_TEXTO = 500;

const RE_DOC = /^[A-Za-z0-9]{3,25}$/;
const RE_NOMBRE = /^[\p{L}\p{N} .'\-]{3,60}$/u;
const RE_ID = /^\d{1,18}$/;
const RE_RAD = /^[A-Za-z0-9._\-]{1,40}$/;

/** Mide cuánto tarda cada consulta y lo deja en `etapas` (así se ve cuál es la lenta). */
async function medir(etapas, nombre, fn) {
  const t0 = Date.now();
  try { return await fn(); } finally { etapas.push({ etapa: nombre, ms: Date.now() - t0 }); }
}

const corchetes = (n) => `[${String(n).replace(/\]/g, ']]')}]`;
const validacion = (m) => Object.assign(new Error(m), { codigo: 'VALIDACION' });
const sinTildes = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------------------------------------------------------------------------
// Descubrimiento de columnas
// ---------------------------------------------------------------------------
const cacheColumnas = new Map();

/** [{ nombre, tipo }] de las columnas «simples» de una tabla (sin binarios, textos largos ni nombres sensibles). */
async function columnasSimples(perfil, esquema, tabla) {
  const clave = `${perfil}|${esquema}|${tabla}`;
  const previa = cacheColumnas.get(clave);
  if (previa && previa.expira > Date.now()) return previa.cols;
  let cols = [];
  try {
    const filas = await consultar(
      perfil,
      `SELECT COLUMN_NAME AS nombre, DATA_TYPE AS tipo, CHARACTER_MAXIMUM_LENGTH AS largo
         FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @esquema AND TABLE_NAME = @tabla ORDER BY ORDINAL_POSITION`,
      [{ nombre: 'esquema', tipo: 'nvarchar', valor: esquema }, { nombre: 'tabla', tipo: 'nvarchar', valor: tabla }]
    );
    cols = filas
      .map((f) => ({ nombre: String(f.nombre), tipo: String(f.tipo || '').toLowerCase(), largo: f.largo === null || f.largo === undefined ? null : Number(f.largo) }))
      .filter((c) => !TIPOS_OMITIDOS.has(c.tipo))
      .filter((c) => !(c.largo !== null && (c.largo === -1 || c.largo > MAX_LARGO_TEXTO)))
      .filter((c) => !NOMBRE_SENSIBLE.test(c.nombre))
      .map(({ nombre, tipo }) => ({ nombre, tipo }));
  } catch (e) {
    // Sin permiso sobre INFORMATION_SCHEMA: se usan solo las columnas conocidas (ver `conFallback`).
    if (!e.perfil) e.perfil = perfil;
    cols = [];
  }
  cacheColumnas.set(clave, { cols, expira: Date.now() + TTL_COLUMNAS_MS });
  return cols;
}

/** Si no se pudieron descubrir columnas, usa las que las otras consultas del módulo ya conocen. */
function conFallback(cols, conocidas) {
  return cols.length ? cols : conocidas.map((nombre) => ({ nombre, tipo: 'desconocido' }));
}

function nombreReal(cols, nombre) {
  const n = nombre.toLowerCase();
  return (cols.find((c) => c.nombre.toLowerCase() === n) || {}).nombre || nombre;
}

const proyeccion = (alias, cols) => cols.map((c) => `${alias}.${corchetes(c.nombre)} AS ${corchetes(c.nombre)}`).join(', ');

function valorLimpio(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) return null;
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t; }
  if (typeof v === 'bigint') return v.toString();
  return v;
}

function datosDe(fila, cols) {
  const o = {};
  for (const c of cols) o[c.nombre] = valorLimpio(fila[c.nombre]);
  return o;
}

const aTexto = (v) => (v === null || v === undefined ? null : String(v).trim());

function lotes(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}

function params(prefijo, valores, tipo = 'varchar') {
  return valores.map((v, k) => ({ nombre: `${prefijo}${k}`, tipo, valor: v }));
}
const marcadores = (prefijo, n) => Array.from({ length: n }, (_, k) => `@${prefijo}${k}`).join(',');

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------
function validarCriterio(criterio, valorCrudo) {
  const valor = String(valorCrudo ?? '').trim();
  if (!valor) throw validacion('Escribe lo que quieres buscar.');
  switch (criterio) {
    case 'cc':
      if (!RE_DOC.test(valor)) throw validacion('La cédula solo puede tener letras y números (3 a 25 caracteres).');
      if (ENMASCARADO.test(valor)) throw validacion('La cédula viene enmascarada (xxxx): no se puede buscar.');
      return valor;
    case 'nombre':
      if (!RE_NOMBRE.test(valor)) throw validacion('El nombre debe tener al menos 3 letras (solo letras, números, espacio, punto y guion).');
      return valor.replace(/\s+/g, ' ');
    case 'caso':
      if (!RE_ID.test(valor)) throw validacion('El número de caso debe tener solo dígitos.');
      return valor;
    case 'radicado':
      if (!RE_RAD.test(valor)) throw validacion('El RadNumber solo puede tener letras, números, punto, guion y guion bajo.');
      return valor;
    default:
      throw validacion('Elige por qué quieres buscar: cédula, nombre, número de caso o RadNumber.');
  }
}

const LISTA_CLIENTES = `SELECT TOP (${MAX_CLIENTES + 1}) CLI.[id] AS id, CLI.[numeroDocumento] AS cc, CLI.[nombre] AS nombre,
       (SELECT COUNT(*) FROM [dbo].[CASO] X WHERE X.[idCliente] = CLI.[id]) AS totalCasos,
       (SELECT MAX(X.[id]) FROM [dbo].[CASO] X WHERE X.[idCliente] = CLI.[id]) AS ultimoCaso
  FROM [dbo].[CLIENTE] CLI`;

async function casosDeRadicado(radicado) {
  const cols = conFallback(await columnasSimples('motorfirma', 'Firma', 'Detalle'), ['RadNumber', 'IdCasoBiometria']);
  const rad = nombreReal(cols, 'RadNumber');
  const caso = nombreReal(cols, 'IdCasoBiometria');
  const filas = await consultar(
    'motorfirma',
    `SELECT DISTINCT TOP (${MAX_RADICADOS}) ${corchetes(caso)} AS idCaso FROM [Firma].[Detalle] WHERE ${corchetes(rad)} = @r AND ${corchetes(caso)} IS NOT NULL`,
    [{ nombre: 'r', tipo: 'varchar', valor: radicado }]
  );
  return filas.map((f) => aTexto(f.idCaso)).filter((v) => v && RE_ID.test(v));
}

/** Devuelve { criterio, valor, clientes: [{ id, cc, nombre, totalCasos, ultimoCaso }], truncado, nota }. */
async function buscarClientes({ criterio, valor }) {
  const v = validarCriterio(criterio, valor);
  let where; let parametros; let nota = null;
  if (criterio === 'cc') {
    where = 'WHERE CLI.[numeroDocumento] = @v'; parametros = [{ nombre: 'v', tipo: 'varchar', valor: v }];
  } else if (criterio === 'nombre') {
    const patron = `%${sinTildes(v).replace(/[\\%_[]/g, (m) => `\\${m}`).replace(/ /g, '%')}%`;
    where = `WHERE CLI.[nombre] COLLATE Latin1_General_CI_AI LIKE @v ESCAPE '\\'`; parametros = [{ nombre: 'v', tipo: 'nvarchar', valor: patron }];
  } else if (criterio === 'caso') {
    where = 'WHERE CLI.[id] IN (SELECT C.[idCliente] FROM [dbo].[CASO] C WHERE C.[id] = @v)'; parametros = [{ nombre: 'v', tipo: 'varchar', valor: v }];
  } else {
    let ids;
    try { ids = await casosDeRadicado(v); } catch (e) { if (!e.perfil) e.perfil = 'motorfirma'; throw e; }
    if (!ids.length) return { criterio, valor: v, clientes: [], truncado: false, nota: 'Ese RadNumber no tiene IdCasoBiometria en Firma.Detalle.' };
    where = `WHERE CLI.[id] IN (SELECT C.[idCliente] FROM [dbo].[CASO] C WHERE C.[id] IN (${marcadores('c', ids.length)}))`;
    parametros = params('c', ids);
    nota = `El RadNumber ${v} está ligado a ${ids.length} caso(s) de biometría.`;
  }
  let filas;
  try {
    filas = await consultar('orqbiometria', `${LISTA_CLIENTES} ${where} ORDER BY CLI.[id] DESC`, parametros);
  } catch (e) { if (!e.perfil) e.perfil = 'orqbiometria'; throw e; }
  const clientes = filas.slice(0, MAX_CLIENTES).map((f) => ({
    id: aTexto(f.id), cc: aTexto(f.cc), nombre: aTexto(f.nombre), totalCasos: Number(f.totalCasos) || 0, ultimoCaso: aTexto(f.ultimoCaso),
  }));
  return { criterio, valor: v, clientes, truncado: filas.length > MAX_CLIENTES, nota };
}

// ---------------------------------------------------------------------------
// Detalle de un cliente (por cédula)
// ---------------------------------------------------------------------------
async function leerOrq(cc, etapas) {
  const colsCliente = conFallback(await columnasSimples('orqbiometria', 'dbo', 'CLIENTE'), ['id', 'numeroDocumento', 'nombre']);
  const colsCaso = conFallback(await columnasSimples('orqbiometria', 'dbo', 'CASO'), ['id', 'idCliente', 'idEstado', 'idCanal']);
  const colsCap = conFallback(await columnasSimples('orqbiometria', 'dbo', 'CAPTURA'), ['id', 'idCaso']);
  const colsRes = conFallback(await columnasSimples('orqbiometria', 'dbo', 'RESULTADO'), ['id', 'idCaptura', 'idEstado', 'codigoResultado', 'descripcionResultado']);

  const filasCli = await medir(etapas, 'ORQBIOMETRIA · cliente', () => consultar(
    'orqbiometria',
    `SELECT TOP (${MAX_CLIENTES}) ${proyeccion('CLI', colsCliente)} FROM [dbo].[CLIENTE] CLI WHERE CLI.[numeroDocumento] = @cc ORDER BY CLI.[id] DESC`,
    [{ nombre: 'cc', tipo: 'varchar', valor: cc }]
  ));
  const idCli = nombreReal(colsCliente, 'id');
  const clientes = filasCli.map((f) => ({ id: aTexto(f[idCli]), datos: datosDe(f, colsCliente) })).filter((c) => c.id && RE_ID.test(c.id));
  if (!clientes.length) return { clientes: [], casos: [], truncadoCasos: false };

  const idsCliente = clientes.map((c) => c.id);
  const idCaso = nombreReal(colsCaso, 'id');
  const filasCaso = await medir(etapas, 'ORQBIOMETRIA · casos', () => consultar(
    'orqbiometria',
    `SELECT TOP (${MAX_CASOS + 1}) ${proyeccion('C', colsCaso)}, E.[estado] AS [__estado]
       FROM [dbo].[CASO] C LEFT JOIN [dbo].[ESTADO] E ON C.[idEstado] = E.[id]
      WHERE C.[idCliente] IN (${marcadores('i', idsCliente.length)}) ORDER BY C.[id] DESC`,
    params('i', idsCliente)
  ));
  const truncadoCasos = filasCaso.length > MAX_CASOS;
  const casos = filasCaso.slice(0, MAX_CASOS).map((f) => ({
    id: aTexto(f[idCaso]), estado: aTexto(f.__estado), datos: datosDe(f, colsCaso), capturas: [],
  })).filter((c) => c.id);
  const porCaso = new Map(casos.map((c) => [c.id, c]));

  // Capturas
  const colCapCaso = nombreReal(colsCap, 'idCaso');
  const colCapId = nombreReal(colsCap, 'id');
  const capturas = new Map();
  for (const lote of lotes(casos.map((c) => c.id), LOTE)) {
    const filas = await medir(etapas, 'ORQBIOMETRIA · capturas', () => consultar(
      'orqbiometria',
      `SELECT ${proyeccion('CAP', colsCap)} FROM [dbo].[CAPTURA] CAP WHERE CAP.[idCaso] IN (${marcadores('k', lote.length)}) ORDER BY CAP.[id]`,
      params('k', lote)
    ));
    for (const f of filas) {
      const cap = { id: aTexto(f[colCapId]), datos: datosDe(f, colsCap), resultados: [] };
      const caso = porCaso.get(aTexto(f[colCapCaso]));
      if (!cap.id || !caso) continue;
      caso.capturas.push(cap);
      capturas.set(cap.id, cap);
    }
  }

  // Resultados
  const colResCap = nombreReal(colsRes, 'idCaptura');
  const colResId = nombreReal(colsRes, 'id');
  for (const lote of lotes([...capturas.keys()].filter((v) => RE_ID.test(v)), LOTE)) {
    const filas = await medir(etapas, 'ORQBIOMETRIA · resultados', () => consultar(
      'orqbiometria',
      `SELECT ${proyeccion('R', colsRes)}, E.[estado] AS [__estado]
         FROM [dbo].[RESULTADO] R LEFT JOIN [dbo].[ESTADO] E ON R.[idEstado] = E.[id]
        WHERE R.[idCaptura] IN (${marcadores('r', lote.length)}) ORDER BY R.[id]`,
      params('r', lote)
    ));
    for (const f of filas) {
      const cap = capturas.get(aTexto(f[colResCap]));
      if (cap) cap.resultados.push({ id: aTexto(f[colResId]), estado: aTexto(f.__estado), datos: datosDe(f, colsRes) });
    }
  }
  return { clientes, casos, truncadoCasos };
}

async function leerFirmas(idsCaso, etapas) {
  if (!idsCaso.length) return { filas: [], truncado: false };
  const colsDet = conFallback(await columnasSimples('motorfirma', 'Firma', 'Detalle'), ['RadNumber', 'IdCasoBiometria']);
  const colsSol = conFallback(await columnasSimples('motorfirma', 'PendienteFirma', 'Solicitudes'), ['RadNumber', 'IdEstadoFirma', 'IdEstadoBiometria', 'FechaModificacion']);
  const radDet = nombreReal(colsDet, 'RadNumber');
  const casoDet = nombreReal(colsDet, 'IdCasoBiometria');
  const radSol = nombreReal(colsSol, 'RadNumber');

  const porRad = new Map();   // radNumber -> { radNumber, casos:Set, detalle: datos de la 1.ª fila, filasDetalle }
  for (const lote of lotes(idsCaso, LOTE)) {
    const filas = await medir(etapas, 'MotorFirma · Firma.Detalle', () => consultar(
      'motorfirma',
      `SELECT TOP (1000) ${proyeccion('D', colsDet)} FROM [Firma].[Detalle] D WHERE D.${corchetes(casoDet)} IN (${marcadores('c', lote.length)})`,
      params('c', lote)
    ));
    for (const f of filas) {
      const rad = aTexto(f[radDet]);
      if (!rad) continue;
      if (!porRad.has(rad)) porRad.set(rad, { radNumber: rad, casos: new Set(), detalle: datosDe(f, colsDet), filasDetalle: 0 });
      const e = porRad.get(rad);
      e.filasDetalle += 1;
      const caso = aTexto(f[casoDet]);
      if (caso) e.casos.add(caso);
    }
  }
  const radicados = [...porRad.keys()];
  const truncado = radicados.length > MAX_RADICADOS;
  const usar = radicados.slice(0, MAX_RADICADOS);
  const solicitudes = new Map();
  for (const lote of lotes(usar, LOTE)) {
    const filas = await medir(etapas, 'MotorFirma · Solicitudes', () => consultar(
      'motorfirma',
      `SELECT ${proyeccion('S', colsSol)} FROM [PendienteFirma].[Solicitudes] S WHERE S.${corchetes(radSol)} IN (${marcadores('r', lote.length)})`,
      params('r', lote)
    ));
    for (const f of filas) {
      const rad = aTexto(f[radSol]);
      if (rad && !solicitudes.has(rad)) solicitudes.set(rad, datosDe(f, colsSol));
    }
  }
  const filas = usar.map((rad) => {
    const e = porRad.get(rad);
    return { radNumber: rad, casos: [...e.casos], detalle: e.detalle, filasDetalle: e.filasDetalle, solicitud: solicitudes.get(rad) || null };
  });
  return { filas, truncado };
}

/** Resumen corto para la parte de arriba de la pantalla. */
function resumir(casos) {
  const porEstado = {};
  for (const c of casos) { const e = c.estado || 'Sin estado'; porEstado[e] = (porEstado[e] || 0) + 1; }
  const ultimo = casos[0] || null;   // vienen ordenados del más reciente al más antiguo
  let conCedulaOk = 0;
  for (const c of casos) {
    if (c.capturas.some((cap) => cap.resultados.some((r) => /cedula original ok/i.test(sinTildes(r.datos.descripcionResultado || r.datos.DescripcionResultado || ''))))) conCedulaOk += 1;
  }
  return {
    totalCasos: casos.length,
    ultimoCaso: ultimo ? { id: ultimo.id, estado: ultimo.estado, exitoso: esEstadoExitoso(ultimo.estado) } : null,
    casosExitosos: casos.filter((c) => esEstadoExitoso(c.estado)).length,
    conCedulaOk,
    porEstado: Object.entries(porEstado).map(([estado, total]) => ({ estado, total })).sort((a, b) => b.total - a.total),
  };
}

/** Todo lo que hay de un cliente por su cédula. Lanza VALIDACION si la cédula no sirve. */
async function detalleCliente({ cc }) {
  const doc = validarCriterio('cc', cc);
  const inicio = Date.now();
  let orq;
  const etapas = [];
  try { orq = await leerOrq(doc, etapas); } catch (e) { if (!e.perfil) e.perfil = 'orqbiometria'; throw e; }
  const advertencias = [];
  if (orq.truncadoCasos) advertencias.push(`El cliente tiene más de ${MAX_CASOS} casos: se muestran los ${MAX_CASOS} más recientes.`);

  let firmas = { disponible: true, error: null, filas: [], truncado: false };
  try {
    const r = await leerFirmas(orq.casos.map((c) => c.id).filter((v) => RE_ID.test(v)), etapas);
    firmas = { disponible: true, error: null, ...r };
  } catch (e) {
    // MotorFirma es información complementaria: si falla, el resto de la pantalla sigue funcionando.
    const { mensajeErrorSql } = require('./sqlServer');
    firmas = { disponible: false, error: mensajeErrorSql(e, e.perfil || 'motorfirma'), filas: [], truncado: false };
  }
  return {
    generado: new Date().toISOString(), duracionMs: Date.now() - inicio, cc: doc,
    encontrado: orq.clientes.length > 0,
    clientes: orq.clientes, casos: orq.casos, resumen: resumir(orq.casos), firmas, advertencias, etapas,
  };
}

// ---------------------------------------------------------------------------
// Biometrías en general (por rango de fechas): todos los casos de ORQBIOMETRIA, sin pasar por MotorFirma.
// ---------------------------------------------------------------------------
const MAX_DIAS_GENERAL = 31;
const MAX_FILAS_GENERAL = 1000;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS_FECHA = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset']);
const PREFERIDAS_FECHA = ['fechacreacion', 'fecharegistro', 'fechainicio', 'fecha', 'fechacaso', 'createdat', 'created', 'fechacreado'];
const TEXTO_LIBRE = /^[\p{L}\p{N} .'\-_/()]{1,100}$/u;

const sinGuiones = (f) => f.replace(/-/g, '');

function validarRangoGeneral(desde, hasta) {
  const d = String(desde ?? '').trim();
  const h = String(hasta ?? '').trim();
  if (!RE_FECHA.test(d) || !RE_FECHA.test(h)) throw validacion('Elige la fecha «Desde» y la fecha «Hasta».');
  const fd = Date.parse(`${d}T00:00:00Z`);
  const fh = Date.parse(`${h}T00:00:00Z`);
  if (Number.isNaN(fd) || Number.isNaN(fh)) throw validacion('Las fechas no son válidas.');
  if (fd > fh) throw validacion('La fecha «Desde» no puede ser posterior a «Hasta».');
  if ((fh - fd) / 86400000 + 1 > MAX_DIAS_GENERAL) throw validacion(`El rango no puede pasar de ${MAX_DIAS_GENERAL} días (la tabla de casos es grande).`);
  return { desde: d, hasta: h };
}

/** Columna de fecha de CASO: la más «natural» por nombre, o la primera de tipo fecha. */
function columnaFechaCaso(cols) {
  const fechas = cols.filter((c) => TIPOS_FECHA.has(c.tipo));
  for (const n of PREFERIDAS_FECHA) { const c = fechas.find((x) => x.nombre.toLowerCase() === n); if (c) return c.nombre; }
  return fechas.length ? fechas[0].nombre : null;
}

/** Casos de ORQBIOMETRIA en un rango de fechas, con filtros opcionales por estado y resultado. */
async function listarBiometrias({ desde, hasta, estado, resultado }) {
  const rango = validarRangoGeneral(desde, hasta);
  const est = String(estado ?? '').trim();
  const res = String(resultado ?? '').trim();
  if (est && !TEXTO_LIBRE.test(est)) throw validacion('El estado elegido no es válido.');
  if (res && !TEXTO_LIBRE.test(res)) throw validacion('El resultado elegido no es válido.');
  const inicio = Date.now();
  const etapas = [];
  const colsCaso = await columnasSimples('orqbiometria', 'dbo', 'CASO');
  const colFecha = columnaFechaCaso(colsCaso);
  if (!colFecha) {
    throw Object.assign(new Error('No se encontró en la tabla CASO de ORQBIOMETRIA una columna de fecha para filtrar por rango (o la cuenta no puede ver INFORMATION_SCHEMA).'), { codigo: 'CONFIG', perfil: 'orqbiometria' });
  }
  const fecha = `C.${corchetes(colFecha)}`;
  const filtroBase = `${fecha} >= CONVERT(datetime, @desde, 112) AND ${fecha} < DATEADD(day, 1, CONVERT(datetime, @hasta, 112))`;
  const pBase = [{ nombre: 'desde', tipo: 'varchar', valor: sinGuiones(rango.desde) }, { nombre: 'hasta', tipo: 'varchar', valor: sinGuiones(rango.hasta) }];
  const ULTIMO_RES = '(SELECT TOP (1) R.[descripcionResultado] FROM [dbo].[CAPTURA] CAP INNER JOIN [dbo].[RESULTADO] R ON R.[idCaptura] = CAP.[id] WHERE CAP.[idCaso] = C.[id] ORDER BY R.[id] DESC)';

  try {
    // Resumen del rango (alimenta los filtros): casos por estado y por resultado.
    const porEstado = await medir(etapas, 'Casos por estado', () => consultar(
      'orqbiometria',
      `SELECT E.[estado] AS estado, COUNT(*) AS total FROM [dbo].[CASO] C LEFT JOIN [dbo].[ESTADO] E ON C.[idEstado] = E.[id] WHERE ${filtroBase} GROUP BY E.[estado] ORDER BY COUNT(*) DESC`,
      pBase
    ));
    const porResultado = await medir(etapas, 'Casos por resultado', () => consultar(
      'orqbiometria',
      `SELECT TOP (30) R.[descripcionResultado] AS resultado, COUNT(DISTINCT C.[id]) AS total
         FROM [dbo].[CASO] C INNER JOIN [dbo].[CAPTURA] CAP ON CAP.[idCaso] = C.[id] INNER JOIN [dbo].[RESULTADO] R ON R.[idCaptura] = CAP.[id]
        WHERE ${filtroBase} GROUP BY R.[descripcionResultado] ORDER BY COUNT(DISTINCT C.[id]) DESC`,
      pBase
    ));

    let where = filtroBase;
    const parametros = [...pBase];
    if (est) { where += ' AND E.[estado] = @estado'; parametros.push({ nombre: 'estado', tipo: 'nvarchar', valor: est }); }
    if (res) {
      where += ' AND EXISTS (SELECT 1 FROM [dbo].[CAPTURA] CAP2 INNER JOIN [dbo].[RESULTADO] R2 ON R2.[idCaptura] = CAP2.[id] WHERE CAP2.[idCaso] = C.[id] AND R2.[descripcionResultado] = @resultado)';
      parametros.push({ nombre: 'resultado', tipo: 'nvarchar', valor: res });
    }
    const filas = await medir(etapas, 'Listado de casos', () => consultar(
      'orqbiometria',
      `SELECT TOP (${MAX_FILAS_GENERAL + 1}) C.[id] AS idCaso, CLI.[numeroDocumento] AS cc, CLI.[nombre] AS nombre, ${fecha} AS fecha,
              E.[estado] AS estado, C.[idCanal] AS idCanal, ${ULTIMO_RES} AS resultado
         FROM [dbo].[CASO] C
         INNER JOIN [dbo].[CLIENTE] CLI ON C.[idCliente] = CLI.[id]
         LEFT JOIN [dbo].[ESTADO] E ON C.[idEstado] = E.[id]
        WHERE ${where} ORDER BY C.[id] DESC`,
      parametros
    ));
    return {
      generado: new Date().toISOString(), duracionMs: Date.now() - inicio, filtro: { ...rango, estado: est || null, resultado: res || null },
      columnaFecha: colFecha,
      totalRango: porEstado.reduce((a, f) => a + (Number(f.total) || 0), 0),
      porEstado: porEstado.map((f) => ({ estado: aTexto(f.estado) || 'Sin estado', total: Number(f.total) || 0 })),
      porResultado: porResultado.map((f) => ({ resultado: aTexto(f.resultado) || 'Sin descripción', total: Number(f.total) || 0 })),
      truncado: filas.length > MAX_FILAS_GENERAL,
      filas: filas.slice(0, MAX_FILAS_GENERAL).map((f) => ({
        idCaso: aTexto(f.idCaso), cc: aTexto(f.cc), nombre: aTexto(f.nombre), fecha: valorLimpio(f.fecha),
        estado: aTexto(f.estado), idCanal: aTexto(f.idCanal), resultado: aTexto(f.resultado),
      })),
      etapas,
    };
  } catch (e) { if (!e.perfil) e.perfil = 'orqbiometria'; throw e; }
}

module.exports = {
  buscarClientes, detalleCliente, listarBiometrias, validarCriterio, columnasSimples, resumir, validarRangoGeneral, columnaFechaCaso,
 _limpiarCache: () => cacheColumnas.clear() };
