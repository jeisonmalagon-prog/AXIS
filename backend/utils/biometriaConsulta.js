// Consulta del módulo Biometría de firmas (solo lectura, todo en SQL Server):
//
//  1) MotorFirma · [PendienteFirma].[Solicitudes]
//        WHERE IdEstadoBiometria = 60 AND IdEstadoFirma = 30
//          AND FechaModificacion dentro del rango de fechas que elige la persona   (ÚNICO filtro)
//  2) MotorFirma · [Firma].[Detalle]
//        por cada RadNumber de las solicitudes -> sus IdCasoBiometria
//  3) ORQBIOMETRIA · CASO + CLIENTE + ESTADO + CAPTURA + RESULTADO + ESTADO
//        por esos IdCasoBiometria, solo los resultados «CEDULA ORIGINAL OK»
//        -> cédula (CC), nombre, caso (y su estado), canal y resultado (y su estado)
//  3b) VALIDACIÓN: un cliente puede tener varios intentos (casos). Se toma el ÚLTIMO (el de mayor id de caso) y,
//        si ese último intento está en un estado exitoso, el cliente no se tiene en cuenta (ya quedó resuelto).
//  4) Con la CC de cada caso se consulta la biometría en el servidor (curl por SSH): biometriaRemota.js
//
// Las dos bases están en servidores distintos, por eso los pasos se encadenan aquí y no con un JOIN.
// Las credenciales de las dos bases están predefinidas en el código (sqlServer.js / biometriaClave.js); siempre con parámetros.

const { consultar } = require('./sqlServer');

const IDENT = /^[A-Za-z0-9_]{1,64}$/;

// Fijo (las consultas del equipo):
const SOLICITUDES = { esquema: 'PendienteFirma', tabla: 'Solicitudes' };
const DETALLE = { esquema: 'Firma', tabla: 'Detalle' };
const ID_ESTADO_FIRMA = 30;
const ID_ESTADO_BIOMETRIA = 60;
const RESULTADO_OK = 'CEDULA ORIGINAL OK';

const MAX_SOLICITUDES = 5000;
const MAX_DIAS = 366;
const LOTE = 400;
// «xxxx», «****», «1XXXXXXXXX2»…: el dato viene enmascarado (lo hace el propio SQL Server) y no sirve para consultar.
const ENMASCARADO = /^[xX*#•·\-.\s]+$|[xX*#•·]{2,}/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// ¿El nombre del estado (tabla ESTADO) es un estado EXITOSO? Se decide por el nombre, sin tildes ni mayúsculas.
// Si en ORQBIOMETRIA los nombres son otros, se ajustan estas dos expresiones.
const ESTADO_EXITO = /(exito|aprobad|finaliz|complet)/;
const ESTADO_NO_EXITO = /(\bno\b|fall|rechaz|error|fraud|reintent|pendient|vencid|cancel|bloquead)/;
const sinTildes = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function esEstadoExitoso(nombre) {
  const n = sinTildes(nombre);
  return !!n && ESTADO_EXITO.test(n) && !ESTADO_NO_EXITO.test(n);
}

const corchetes = (n) => `[${String(n).replace(/\]/g, ']]')}]`;
const aTexto = (v) => (v === null || v === undefined ? null : String(v).trim());
const aFecha = (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : (v ? String(v) : null));

function conPerfil(perfil, error) {
  if (error && !error.perfil) error.perfil = perfil;
  return error;
}

// Valida el rango (yyyy-MM-dd, ambos días incluidos). Devuelve { desde, hasta } o { error }.
function validarRango(desde, hasta) {
  const d = String(desde ?? '').trim();
  const h = String(hasta ?? '').trim();
  if (!RE_FECHA.test(d) || !RE_FECHA.test(h)) return { error: 'Elige la fecha «Desde» y la fecha «Hasta».' };
  const fd = Date.parse(`${d}T00:00:00Z`);
  const fh = Date.parse(`${h}T00:00:00Z`);
  if (Number.isNaN(fd) || Number.isNaN(fh)) return { error: 'Las fechas no son válidas.' };
  if (fd > fh) return { error: 'La fecha «Desde» no puede ser posterior a «Hasta».' };
  if ((fh - fd) / 86400000 + 1 > MAX_DIAS) return { error: `El rango no puede pasar de ${MAX_DIAS} días.` };
  return { desde: d, hasta: h };
}

const sinGuiones = (f) => f.replace(/-/g, '');

// Busca una columna sin distinguir mayúsculas.
function columna(columnas, nombre) {
  const n = nombre.toLowerCase();
  return columnas.find((c) => c.toLowerCase() === n) || null;
}

async function columnasDe(perfil, { esquema, tabla }) {
  const filas = await consultar(
    perfil,
    `SELECT COLUMN_NAME AS nombre FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @esquema AND TABLE_NAME = @tabla ORDER BY ORDINAL_POSITION`,
    [{ nombre: 'esquema', tipo: 'nvarchar', valor: esquema }, { nombre: 'tabla', tipo: 'nvarchar', valor: tabla }]
  );
  return filas.map((f) => String(f.nombre));
}

function exigirColumnas(columnas, destino, necesarias) {
  if (!columnas.length) {
    throw Object.assign(new Error(`No se encontró la tabla [${destino.esquema}].[${destino.tabla}] en la base de MotorFirma (o la cuenta no tiene permiso para verla).`), { codigo: 'CONFIG' });
  }
  const r = {};
  for (const n of necesarias) {
    r[n] = columna(columnas, n);
    if (!r[n]) {
      throw Object.assign(new Error(`La tabla [${destino.esquema}].[${destino.tabla}] no tiene la columna ${n}. Columnas: ${columnas.join(', ')}.`), { codigo: 'CONFIG' });
    }
  }
  return r;
}

// Paso 1: solicitudes en reintento de firma dentro del rango de FechaModificacion.
async function leerSolicitudes(rango) {
  for (const v of [SOLICITUDES.esquema, SOLICITUDES.tabla, DETALLE.esquema, DETALLE.tabla]) {
    if (!IDENT.test(v)) throw Object.assign(new Error(`El nombre ${v} no es válido.`), { codigo: 'CONFIG' });
  }
  let cols;
  try { cols = await columnasDe('motorfirma', SOLICITUDES); } catch (e) { throw conPerfil('motorfirma', e); }
  const c = exigirColumnas(cols, SOLICITUDES, ['IdEstadoFirma', 'IdEstadoBiometria', 'RadNumber', 'FechaModificacion']);
  const idCol = columna(cols, 'IdSolicitud');
  const origen = `${corchetes(SOLICITUDES.esquema)}.${corchetes(SOLICITUDES.tabla)}`;
  const filtro = `WHERE ${corchetes(c.IdEstadoBiometria)} = @eb AND ${corchetes(c.IdEstadoFirma)} = @ef
       AND ${corchetes(c.FechaModificacion)} >= CONVERT(datetime, @desde, 112)
       AND ${corchetes(c.FechaModificacion)} <  DATEADD(day, 1, CONVERT(datetime, @hasta, 112))`;
  const parametros = [
    { nombre: 'eb', tipo: 'int', valor: ID_ESTADO_BIOMETRIA },
    { nombre: 'ef', tipo: 'int', valor: ID_ESTADO_FIRMA },
    { nombre: 'desde', tipo: 'varchar', valor: sinGuiones(rango.desde) },
    { nombre: 'hasta', tipo: 'varchar', valor: sinGuiones(rango.hasta) },
  ];
  try {
    const conteo = await consultar('motorfirma', `SELECT COUNT(*) AS total FROM ${origen} ${filtro}`, parametros);
    const total = Number(conteo[0]?.total || 0);
    const filas = total ? await consultar(
      'motorfirma',
      `SELECT TOP (${MAX_SOLICITUDES}) ${idCol ? `${corchetes(idCol)} AS idSolicitud,` : 'NULL AS idSolicitud,'}
              ${corchetes(c.RadNumber)} AS radNumber, ${corchetes(c.FechaModificacion)} AS fechaModificacion
         FROM ${origen} ${filtro}
        ORDER BY ${corchetes(c.FechaModificacion)} DESC`,
      parametros
    ) : [];
    return {
      total,
      solicitudes: filas.map((f) => ({
        idSolicitud: aTexto(f.idSolicitud), radNumber: aTexto(f.radNumber), fechaModificacion: aFecha(f.fechaModificacion),
      })),
    };
  } catch (e) { throw conPerfil('motorfirma', e); }
}

// Paso 2: IdCasoBiometria de cada RadNumber en Firma.Detalle. Devuelve Map(radNumber -> Set(idCaso)).
async function leerDetalle(radNumbers) {
  let cols;
  try { cols = await columnasDe('motorfirma', DETALLE); } catch (e) { throw conPerfil('motorfirma', e); }
  const c = exigirColumnas(cols, DETALLE, ['RadNumber', 'IdCasoBiometria']);
  const origen = `${corchetes(DETALLE.esquema)}.${corchetes(DETALLE.tabla)}`;
  const porRad = new Map();
  try {
    for (let i = 0; i < radNumbers.length; i += LOTE) {
      const lote = radNumbers.slice(i, i + LOTE);
      const filas = await consultar(
        'motorfirma',
        `SELECT ${corchetes(c.RadNumber)} AS radNumber, ${corchetes(c.IdCasoBiometria)} AS idCaso
           FROM ${origen}
          WHERE ${corchetes(c.RadNumber)} IN (${lote.map((_, k) => `@r${k}`).join(',')})
            AND ${corchetes(c.IdCasoBiometria)} IS NOT NULL`,
        lote.map((v, k) => ({ nombre: `r${k}`, tipo: 'varchar', valor: v }))
      );
      for (const f of filas) {
        const rad = aTexto(f.radNumber);
        const caso = aTexto(f.idCaso);
        if (!rad || !caso || !/^\d+$/.test(caso)) continue;
        if (!porRad.has(rad)) porRad.set(rad, new Set());
        porRad.get(rad).add(caso);
      }
    }
  } catch (e) { throw conPerfil('motorfirma', e); }
  return porRad;
}

// Paso 3: casos de ORQBIOMETRIA con resultado «CEDULA ORIGINAL OK». Devuelve Map(idCaso -> datos).
async function leerCasosOrq(idsCaso) {
  const porCaso = new Map();
  try {
    for (let i = 0; i < idsCaso.length; i += LOTE) {
      const lote = idsCaso.slice(i, i + LOTE);
      const filas = await consultar(
        'orqbiometria',
        `SELECT CLI.[numeroDocumento] AS cc, CLI.[nombre] AS nombreCliente, C.[id] AS idCaso,
                E_CASO.[estado] AS estadoCaso, C.[idCanal] AS idCanal,
                R.[id] AS idResultado, E_RESULTADO.[estado] AS estadoResultado,
                R.[codigoResultado] AS codigoResultado, R.[descripcionResultado] AS descripcionResultado
           FROM [dbo].[CASO] C
           INNER JOIN [dbo].[CLIENTE] CLI ON C.[idCliente] = CLI.[id]
           INNER JOIN [dbo].[ESTADO] E_CASO ON C.[idEstado] = E_CASO.[id]
           INNER JOIN [dbo].[CAPTURA] CAP ON C.[id] = CAP.[idCaso]
           INNER JOIN [dbo].[RESULTADO] R ON CAP.[id] = R.[idCaptura]
           INNER JOIN [dbo].[ESTADO] E_RESULTADO ON R.[idEstado] = E_RESULTADO.[id]
          WHERE R.[descripcionResultado] = @ok
            AND C.[id] IN (${lote.map((_, k) => `@c${k}`).join(',')})`,
        [{ nombre: 'ok', tipo: 'varchar', valor: RESULTADO_OK }, ...lote.map((v, k) => ({ nombre: `c${k}`, tipo: 'varchar', valor: v }))]
      );
      for (const f of filas) {
        const id = aTexto(f.idCaso);
        const previo = porCaso.get(id);
        const idRes = Number(f.idResultado) || 0;
        if (previo && previo.idResultado >= idRes) continue;   // un caso puede tener varias capturas OK: se queda el último resultado
        porCaso.set(id, {
          cc: aTexto(f.cc), nombre: aTexto(f.nombreCliente), idCaso: id, estadoCaso: aTexto(f.estadoCaso), idCanal: aTexto(f.idCanal),
          idResultado: idRes, estadoResultado: aTexto(f.estadoResultado), codigoResultado: aTexto(f.codigoResultado),
          descripcionResultado: aTexto(f.descripcionResultado),
        });
      }
    }
  } catch (e) { throw conPerfil('orqbiometria', e); }
  return porCaso;
}

// Paso 3b: el ÚLTIMO intento (caso de mayor id) de cada cliente, con el nombre del estado de ese caso.
// Devuelve Map(cc -> { idCaso, estadoCaso }). Se mira TODO el historial del cliente, no solo «CEDULA ORIGINAL OK».
async function leerUltimoIntento(documentos) {
  const porCc = new Map();
  try {
    for (let i = 0; i < documentos.length; i += LOTE) {
      const lote = documentos.slice(i, i + LOTE);
      const filas = await consultar(
        'orqbiometria',
        `SELECT t.cc, t.idCaso, t.estadoCaso
           FROM (SELECT CLI.[numeroDocumento] AS cc, C.[id] AS idCaso, E.[estado] AS estadoCaso,
                        ROW_NUMBER() OVER (PARTITION BY CLI.[numeroDocumento] ORDER BY C.[id] DESC) AS rn
                   FROM [dbo].[CASO] C
                   INNER JOIN [dbo].[CLIENTE] CLI ON C.[idCliente] = CLI.[id]
                   LEFT JOIN [dbo].[ESTADO] E ON C.[idEstado] = E.[id]
                  WHERE CLI.[numeroDocumento] IN (${lote.map((_, k) => `@d${k}`).join(',')})) t
          WHERE t.rn = 1`,
        lote.map((v, k) => ({ nombre: `d${k}`, tipo: 'varchar', valor: v }))
      );
      for (const f of filas) {
        const cc = aTexto(f.cc);
        if (cc) porCc.set(cc, { idCaso: aTexto(f.idCaso), estadoCaso: aTexto(f.estadoCaso) });
      }
    }
  } catch (e) { throw conPerfil('orqbiometria', e); }
  return porCc;
}

// Consulta completa. `filtro`: { desde, hasta } (yyyy-MM-dd).
const MAX_DESCARTADAS = 300;

async function consultarBiometria(filtro) {
  const inicio = Date.now();
  const rango = validarRango(filtro?.desde, filtro?.hasta);
  if (rango.error) throw Object.assign(new Error(rango.error), { codigo: 'VALIDACION' });

  const { total, solicitudes } = await leerSolicitudes(rango);
  const radNumbers = [...new Set(solicitudes.map((s) => s.radNumber).filter(Boolean))];
  const porRad = radNumbers.length ? await leerDetalle(radNumbers) : new Map();
  const idsCaso = [...new Set([...porRad.values()].flatMap((s) => [...s]))];
  const casos = idsCaso.length ? await leerCasosOrq(idsCaso) : new Map();

  // Validación: último intento de cada cliente (por cédula real; las enmascaradas no se pueden cruzar).
  const valido = (cc) => !!cc && cc.length >= 3 && !ENMASCARADO.test(cc);
  const ccs = [...new Set([...casos.values()].map((c) => c.cc).filter(valido))];
  const ultimos = ccs.length ? await leerUltimoIntento(ccs) : new Map();

  const filas = [];
  let sinCaso = 0;
  const descartados = new Set();   // casos cuyo cliente ya tiene un último intento exitoso
  const descartadas = [];          // esos mismos casos, completos, para mostrarlos como información (ya tienen biometría exitosa)
  for (const s of solicitudes) {
    const ids = s.radNumber && porRad.get(s.radNumber) ? [...porRad.get(s.radNumber)] : [];
    if (!ids.length) { sinCaso += 1; continue; }
    for (const id of ids) {
      const c = casos.get(id);
      if (!c) continue;
      const documentoValido = valido(c.cc);
      const ultimo = documentoValido ? ultimos.get(c.cc) : null;
      const clave = `${s.idSolicitud ?? ''}|${s.radNumber}|${c.idCaso}`;
      const ya = ultimo && esEstadoExitoso(ultimo.estadoCaso);
      if (ya) descartados.add(c.idCaso);
      (ya ? descartadas : filas).push({
        clave: ya ? `ok|${clave}` : clave,
        idSolicitud: s.idSolicitud, radNumber: s.radNumber, fechaModificacion: s.fechaModificacion,
        cc: c.cc, nombre: c.nombre, idCaso: c.idCaso, estadoCaso: c.estadoCaso, idCanal: c.idCanal,
        idResultado: c.idResultado, estadoResultado: c.estadoResultado, codigoResultado: c.codigoResultado,
        descripcionResultado: c.descripcionResultado,
        ultimoCaso: ultimo ? ultimo.idCaso : null, ultimoEstado: ultimo ? ultimo.estadoCaso : null,
        documentoValido,
      });
    }
  }
  const documentos = new Set(filas.filter((f) => f.documentoValido).map((f) => f.cc));
  const casosConOk = new Set([...filas.map((f) => f.idCaso), ...descartados]);

  return {
    generado: new Date().toISOString(),
    duracionMs: Date.now() - inicio,
    filtro: rango,
    pasos: {
      solicitudes: total,
      solicitudesLeidas: solicitudes.length,
      truncado: total > solicitudes.length,
      radNumbers: radNumbers.length,
      solicitudesSinCaso: sinCaso,
      casosEnDetalle: idsCaso.length,
      casosConResultadoOk: casosConOk.size,
      descartadosPorExito: descartados.size,
      documentos: documentos.size,
      sinDocumentoValido: filas.filter((f) => !f.documentoValido).length,
    },
    resultadoOk: RESULTADO_OK,
    filas,
    // Clientes que ya tienen un intento exitoso reciente: no se vuelven a procesar, pero se muestran como información.
    descartadas: descartadas.slice(0, MAX_DESCARTADAS),
    descartadasTruncado: descartadas.length > MAX_DESCARTADAS,
  };
}

// Verifica que existan las tablas de ORQBIOMETRIA que usa la consulta.
async function verificarTablasOrq() {
  const filas = await consultar(
    'orqbiometria',
    `SELECT TABLE_NAME AS nombre FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME IN ('CASO', 'CAPTURA', 'RESULTADO', 'CLIENTE')`
  );
  const existen = new Set(filas.map((f) => String(f.nombre).toUpperCase()));
  return ['CASO', 'CAPTURA', 'RESULTADO', 'CLIENTE'].filter((t) => !existen.has(t));
}

module.exports = {
  consultarBiometria, verificarTablasOrq, validarRango, esEstadoExitoso,
  IDENT, ENMASCARADO, RESULTADO_OK, ID_ESTADO_FIRMA, ID_ESTADO_BIOMETRIA,
};
