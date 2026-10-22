// Servicio de Monitoreo transaccional > BREB: ejecuta el catálogo de consultas (brebConsultas) en SOLO LECTURA contra
// SQL Server (base BreB) y MariaDB (LogBre_B.Log), aísla los errores por bloque, enmascara datos personales, cruza ambas
// fuentes (transacción ↔ recorrido en logs) y calcula hallazgos.
//
// Garantías de solo lectura (defensa en profundidad):
//  1) Las consultas las arma el backend; los valores van como parámetros.
//  2) `sqlSoloLectura` / `sqlSoloLecturaMaria` exigen un único SELECT/WITH sin palabras de escritura, DDL, EXEC ni INTO.
//  3) SQL Server: READ UNCOMMITTED + LOCK_TIMEOUT + NOLOCK (no bloquea a nadie). MariaDB: sesión READ ONLY + tope de tiempo.
//  4) Se recomienda además que las cuentas de BD tengan solo permiso SELECT.

const sql = require('./sqlServer');
const maria = require('./brebMaria');
const conexion = require('./brebConexion');
const C = require('./brebConsultas');
const S = require('./brebSanitizar');

const PREFIJO = 'SET NOCOUNT ON; SET LOCK_TIMEOUT 8000; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n';
const MAX_TEXTO = 300;
const MAX_FILAS = 500;
const CONCURRENCIA = 2;
const MAX_DIAS_LOGS = 3;
const CODIGOS_CONEXION_SQL = ['ELOGIN', 'ESOCKET', 'ETIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EINSTLOOKUP', 'EHOSTUNREACH', 'ECONNCLOSED', 'ENOTOPEN', 'SIN_CONFIG', 'SIN_DRIVER'];
const PERFIL = 'breb';

class ErrorBreb extends Error {
  constructor(mensaje, status = 400, codigo = 'VALIDACION') { super(mensaje); this.status = status; this.codigo = codigo; }
}

// ---------------------------------------------------------------------------
// Guarda de solo lectura (SQL Server)
// ---------------------------------------------------------------------------
const RE_PROHIBIDAS = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|SHUTDOWN|RECONFIGURE|DBCC|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|WAITFOR|INTO|KILL|USE|SET|DECLARE)\b/i;

function sqlSoloLectura(texto) {
  const t = String(texto || '')
    .replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\[[^\]]*\]/g, '[x]')
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim();
  if (!/^(SELECT|WITH)\b/i.test(t)) return false;
  if (t.includes(';')) return false;
  if (RE_PROHIBIDAS.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Formato de valores
// ---------------------------------------------------------------------------
const dos = (n) => String(n).padStart(2, '0');

function valorSeguro(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // El driver entrega la hora de la base como si fuera UTC: se muestra tal cual, sin convertir zonas.
    const base = `${v.getUTCFullYear()}-${dos(v.getUTCMonth() + 1)}-${dos(v.getUTCDate())}`;
    const hora = `${dos(v.getUTCHours())}:${dos(v.getUTCMinutes())}:${dos(v.getUTCSeconds())}`;
    return hora === '00:00:00' ? base : `${base} ${hora}`;
  }
  if (Buffer.isBuffer(v)) return `(binario ${v.length} bytes)`;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  if (typeof v === 'boolean') return v;
  const s = String(v);
  return s.length > MAX_TEXTO ? `${s.slice(0, MAX_TEXTO)}…` : s;
}

// Columnas de MariaDB que llegan como texto (DECIMAL de SUM, BIGINT) pero son conteos.
const RE_CONTEO_LOG = /^(Registros|Errores|Debitos|Debito|Registro|Reporte|Mensajeria|Veces|Transacciones|Clientes|TieneRq|TieneRs)$/;

function filaSegura(f, columnas, origen) {
  const o = {};
  for (const n of columnas) {
    let x = valorSeguro(f[n]);
    if (origen === 'log' && typeof x === 'string' && RE_CONTEO_LOG.test(n) && /^-?\d{1,15}$/.test(x)) x = Number(x);
    o[n] = x;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Ejecución de un bloque
// ---------------------------------------------------------------------------
const RE_PARAM_SENSIBLE = /(pass|pwd|clave|secret|token|key|llave|credential|cert|private|conn|cadena|user|usuario|apikey|auth|firma|signer)/i;
const RE_VALOR_SENSIBLE = /(password|pwd|secret|token|apikey)\s*[=:]/i;

function ocultarSensibles(filas, cfg) {
  const valores = Array.isArray(cfg.valor) ? cfg.valor : [cfg.valor];
  return filas.map((f) => {
    const o = { ...f };
    const sensible = RE_PARAM_SENSIBLE.test(String(f[cfg.clave] ?? ''));
    for (const col of valores) {
      if (!(col in o) || o[col] === null) continue;
      const t = String(o[col]);
      if (sensible || RE_VALOR_SENSIBLE.test(t)) o[col] = '[oculto]';
      else o[col] = S.limpiarPayload(t, { max: 300 })?.texto ?? t;
    }
    return o;
  });
}

function configurado(origen) {
  return origen === 'sql' ? sql.resumenConexion(PERFIL).configurada : maria.resumen().configurada;
}

const NOMBRE_ORIGEN = { sql: 'la base SQL Server de BreB', log: 'los logs de BreB (MariaDB)' };

function esConexionCaida(origen, error) {
  const codigo = error?.code || error?.codigo;
  return origen === 'sql' ? CODIGOS_CONEXION_SQL.includes(codigo) : maria.CODIGOS_CONEXION.includes(codigo);
}

async function ejecutarBloque(id, b) {
  const base = { id, titulo: b.titulo, ayuda: b.ayuda || null, vista: 'tabla', clic: b.clic || null, columnaId: b.columnaId || null, externa: false, vertical: !!b.vertical, origen: b.origen };
  if (!configurado(b.origen)) {
    return { ...base, ok: false, omitido: true, error: `La conexión a ${NOMBRE_ORIGEN[b.origen]} no está configurada.`, columnas: [], filas: [], sql: null };
  }
  if (b.omitido) return { ...base, ok: false, omitido: true, error: b.omitido, columnas: [], filas: [], sql: null };
  const permitido = b.origen === 'sql' ? sqlSoloLectura(b.sql) : maria.sqlSoloLecturaMaria(b.sql);
  if (!permitido) return { ...base, ok: false, error: 'Consulta bloqueada: no es de solo lectura.', columnas: [], filas: [], sql: null };
  const t0 = Date.now();
  try {
    const crudo = b.origen === 'sql' ? await sql.consultar(PERFIL, PREFIJO + b.sql, b.params || []) : await maria.consultar(b.sql, b.params || []);
    const nombres = Object.keys(crudo.columns || crudo[0] || {}).filter((n) => !(b.ocultarColumnas || []).includes(n));
    const tope = Math.min(b.tope || MAX_FILAS, MAX_FILAS);
    const truncado = crudo.length > tope;
    let filas = crudo.slice(0, tope).map((f) => filaSegura(f, nombres, b.origen));
    filas = S.limpiarTextoLibre(filas);
    if (b.mascara) filas = S.enmascararFilas(filas, b.mascara);
    if (b.valoresSensibles) filas = ocultarSensibles(filas, b.valoresSensibles);
    const salida = {
      ...base, ok: true, columnas: nombres.map((n) => ({ clave: n, etiqueta: n })), filas, truncado, ms: Date.now() - t0, sql: null,
    };
    if (b.crudo) salida._crudo = crudo.slice(0, (b.tope || MAX_FILAS) + 1);
    return salida;
  } catch (error) {
    const mensaje = b.origen === 'sql' ? sql.mensajeErrorSql(error, PERFIL) : maria.mensajeError(error);
    return { ...base, ok: false, error: mensaje, columnas: [], filas: [], ms: Date.now() - t0, sql: null, conexionCaida: esConexionCaida(b.origen, error) };
  }
}

async function ejecutarLista(lista) {
  const resultados = {};
  const porOrigen = { sql: lista.filter(([, b]) => b.origen === 'sql'), log: lista.filter(([, b]) => b.origen === 'log') };
  await Promise.all(Object.values(porOrigen).map(async (items) => {
    let i = 0;
    const trabajadores = Array.from({ length: Math.min(CONCURRENCIA, items.length) }, async () => {
      while (i < items.length) {
        const [id, bloque] = items[i]; i += 1;
        resultados[id] = await ejecutarBloque(id, bloque);
      }
    });
    await Promise.all(trabajadores);
  }));
  return resultados;
}

async function ejecutarUno(id, bloque) { return ejecutarBloque(id, bloque); }

/** Quita lo interno (filas crudas) antes de responder. */
function limpiar(resultados) {
  const o = {};
  for (const [k, v] of Object.entries(resultados)) { const { _crudo, conexionCaida, ...resto } = v; o[k] = resto; }
  return o;
}

/** Estado de cada fuente según lo ocurrido en los bloques; lanza 409/502 si ninguna sirvió. */
function estadoOrigenes(resultados) {
  const salida = {};
  for (const origen of ['sql', 'log']) {
    const usados = Object.values(resultados).filter((b) => b.origen === origen);
    if (!configurado(origen)) { salida[origen] = { estado: 'sin_config', error: null }; continue; }
    const intentados = usados.filter((b) => !b.omitido);
    if (!intentados.length) { salida[origen] = { estado: 'no_usado', error: null }; continue; }
    const caidos = intentados.filter((b) => b.conexionCaida);
    if (caidos.length === intentados.length) salida[origen] = { estado: 'error', error: caidos[0].error };
    else salida[origen] = { estado: 'ok', error: null };
  }
  return salida;
}

function verificarOrigenes(origenes, necesita = ['sql', 'log']) {
  const relevantes = necesita.map((o) => origenes[o]).filter(Boolean);
  if (relevantes.length && relevantes.every((x) => x.estado === 'sin_config')) {
    throw new ErrorBreb('No hay conexiones configuradas: el ADMIN_POD debe guardarlas en Monitoreo transaccional > BREB > Conexiones.', 409, 'SIN_CONFIG');
  }
  const activos = relevantes.filter((x) => x.estado !== 'sin_config' && x.estado !== 'no_usado');
  if (activos.length && activos.every((x) => x.estado === 'error')) throw new ErrorBreb(activos[0].error, 502, 'CONEXION');
}

// ---------------------------------------------------------------------------
// Reloj de la base y ventanas de tiempo
// ---------------------------------------------------------------------------
let cacheAhora = { en: 0, valor: null };

const fmt = (d) => `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())} ${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())}:${dos(d.getUTCSeconds())}`;
const fmtDia = (d) => fmt(d).slice(0, 10);

function parseFecha(texto) {
  const m = String(texto || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
}

/** Hora actual según la BASE DE DATOS (no según el servidor de AXIS, que puede estar en otra zona horaria). */
async function ahoraBd() {
  if (cacheAhora.valor && Date.now() - cacheAhora.en < 10000) return cacheAhora.valor;
  let valor = null;
  let ultimoError = null;
  if (configurado('sql')) {
    try {
      const f = await sql.consultar(PERFIL, `${PREFIJO}SELECT CONVERT(varchar(19), GETDATE(), 120) AS ahora`, []);
      valor = parseFecha(f[0]?.ahora);
    } catch (e) { ultimoError = e; }
  }
  if (!valor && configurado('log')) {
    try {
      const f = await maria.consultar('SELECT NOW() AS ahora');
      valor = parseFecha(f[0]?.ahora);
    } catch (e) { ultimoError = e; }
  }
  if (!valor) {
    if (!configurado('sql') && !configurado('log')) throw new ErrorBreb('No hay conexiones configuradas: el ADMIN_POD debe guardarlas en Monitoreo transaccional > BREB > Conexiones.', 409, 'SIN_CONFIG');
    throw new ErrorBreb(ultimoError ? (esConexionCaida('sql', ultimoError) || esConexionCaida('log', ultimoError) ? (configurado('sql') ? sql.mensajeErrorSql(ultimoError, PERFIL) : maria.mensajeError(ultimoError)) : 'No se pudo leer la hora de la base de datos.') : 'No se pudo leer la hora de la base de datos.', 502, 'CONEXION');
  }
  cacheAhora = { en: Date.now(), valor };
  return valor;
}

const RANGOS = {
  '1h': 'Última hora', '6h': 'Últimas 6 horas', '24h': 'Últimas 24 horas', hoy: 'Hoy', ayer: 'Ayer',
  '3d': 'Últimos 3 días', '7d': 'Últimos 7 días', '30d': 'Últimos 30 días', '90d': 'Últimos 90 días', custom: 'Rango personalizado',
};

const sumar = (d, ms) => new Date(d.getTime() + ms);
const H = 3600 * 1000;
const D = 24 * H;
const inicioDia = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Ventana { desde, hasta (exclusiva), rango, etiqueta, dias, ahora } a partir de lo que pide la pantalla. */
function ventana(q, ahora, { maxDias = 92, defecto = 'hoy' } = {}) {
  const mN = /^(\d{1,3})d$/.exec(String(q.rango || ''));
  const rango = RANGOS[q.rango] || mN ? q.rango : defecto;
  const hoy0 = inicioDia(ahora);
  let desde; let hasta;
  switch (rango) {
    case '1h': desde = sumar(ahora, -H); hasta = sumar(ahora, 60000); break;
    case '6h': desde = sumar(ahora, -6 * H); hasta = sumar(ahora, 60000); break;
    case '24h': desde = sumar(ahora, -24 * H); hasta = sumar(ahora, 60000); break;
    case 'ayer': desde = sumar(hoy0, -D); hasta = hoy0; break;
    case '3d': desde = sumar(hoy0, -2 * D); hasta = sumar(hoy0, D); break;
    case '7d': desde = sumar(hoy0, -6 * D); hasta = sumar(hoy0, D); break;
    case '30d': desde = sumar(hoy0, -29 * D); hasta = sumar(hoy0, D); break;
    case '90d': desde = sumar(hoy0, -89 * D); hasta = sumar(hoy0, D); break;
    case 'custom': {
      const soloDia = (t) => /^\d{4}-\d{2}-\d{2}$/.test(String(t || '').trim());
      const d0 = parseFecha(soloDia(q.desde) ? `${q.desde.trim()} 00:00:00` : String(q.desde || '').trim());
      let h0 = parseFecha(soloDia(q.hasta) ? `${q.hasta.trim()} 00:00:00` : String(q.hasta || '').trim());
      if (!d0 || !h0) throw new ErrorBreb('Indica la fecha de inicio y de fin (AAAA-MM-DD o AAAA-MM-DD HH:MM).');
      h0 = soloDia(q.hasta) ? sumar(h0, D) : sumar(h0, 1000);
      desde = d0; hasta = h0;
      break;
    }
    default:
      if (mN && +mN[1] >= 1) { desde = sumar(hoy0, -(+mN[1] - 1) * D); hasta = sumar(hoy0, D); } else { desde = hoy0; hasta = sumar(hoy0, D); } // hoy
  }
  if (!(desde < hasta)) throw new ErrorBreb('La fecha de inicio debe ser anterior a la de fin.');
  const dias = Math.max(1, Math.ceil((hasta - desde) / D));
  if (dias > maxDias) throw new ErrorBreb(`El rango máximo para esta consulta es de ${maxDias} días (pediste ${dias}).`);
  return { desde: fmt(desde), hasta: fmt(hasta), rango, etiqueta: RANGOS[rango] || `Últimos ${rango.replace('d', '')} días`, dias, ahora: fmt(ahora), _d: desde, _h: hasta };
}

/** Los logs son muy grandes: se consultan como máximo `max` días (los más recientes del rango). */
function ventanaLogs(v, max = MAX_DIAS_LOGS) {
  const limite = sumar(v._h, -max * D);
  if (v._d >= limite) return { desde: v.desde, hasta: v.hasta, recortada: false, dias: v.dias };
  return { desde: fmt(limite), hasta: v.hasta, recortada: true, dias: max };
}

const limpiarVentana = ({ _d, _h, ...r }) => r;

// ---------------------------------------------------------------------------
// Validaciones de parámetros de pantalla
// ---------------------------------------------------------------------------
function entero(valor, defecto, min, max, nombre) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return defecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErrorBreb(`${nombre} debe ser un entero entre ${min} y ${max}.`);
  return n;
}

function texto(valor, re, mensaje, { max = 100 } = {}) {
  const t = String(valor ?? '').trim();
  if (!t) return null;
  if (t.length > max || !re.test(t)) throw new ErrorBreb(mensaje);
  return t;
}

const RE_ID = /^[A-Za-z0-9._\-@]+$/;
const RE_CODIGO = /^[A-Za-z0-9_\- ]+$/;
const documentoValido = (v) => {
  const d = String(v ?? '').trim();
  if (!/^[A-Za-z0-9]{3,20}$/.test(d)) throw new ErrorBreb('El documento debe tener entre 3 y 20 letras o números, sin espacios ni símbolos.');
  return d;
};
const cusValido = (v) => {
  const c = String(v ?? '').trim();
  if (!/^[A-Za-z0-9._\-]{6,80}$/.test(c)) throw new ErrorBreb('El CUS debe tener entre 6 y 80 letras o números.');
  return c;
};
const enmascarar = (doc) => S.mascDocumento(String(doc));

// ---------------------------------------------------------------------------
// Utilidades de análisis
// ---------------------------------------------------------------------------
const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
const fila0 = (res, id) => (res[id] && res[id].ok && res[id].filas[0] ? res[id].filas[0] : null);
const fmtNum = (n) => Number(n).toLocaleString('es-CO');
const fmtMoneda = (n) => `$${Math.round(Number(n)).toLocaleString('es-CO')}`;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function duracionTexto(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

function minutosTexto(min) {
  if (min === null || min === undefined) return '—';
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.floor(min / 1440)} días`;
}

const clasifica = (st) => {
  if (['ACCP', 'ACSC'].includes(st)) return 'Aprobada';
  if (['RJCT', 'CANC'].includes(st)) return 'Rechazada';
  if (['ACSP', 'ACTC', 'ACWC', 'PDNG'].includes(st)) return 'Pendiente';
  if (!st) return 'Sin estado';
  return 'Otro';
};

// ---------------------------------------------------------------------------
// Hallazgos del resumen
// ---------------------------------------------------------------------------
function hallazgosResumen(res, v, origenes) {
  const h = [];
  const k = fila0(res, 'kpis');
  const periodo = v.etiqueta.toLowerCase();
  if (origenes.sql.estado === 'error') h.push({ nivel: 'alto', texto: `No se pudo leer la base SQL Server de BreB: ${origenes.sql.error}` });
  if (k) {
    const total = num(k.Total) || 0;
    const rech = num(k.Rechazadas) || 0;
    const pend = num(k.Pendientes) || 0;
    const sin = num(k.SinEstado) || 0;
    const desdeUltima = num(k.MinDesdeUltima);
    const incluyeAhora = v._h > new Date(parseFecha(v.ahora)) && v._d <= parseFecha(v.ahora);
    if (!total) h.push({ nivel: incluyeAhora ? 'alto' : 'info', texto: `No hay transacciones registradas en trx.Redeban (${periodo}).` });
    else {
      if (incluyeAhora && desdeUltima !== null && desdeUltima >= 30) h.push({ nivel: desdeUltima >= 120 ? 'alto' : 'medio', texto: `Sin movimiento hace ${minutosTexto(desdeUltima)}: la última transacción fue a las ${String(k.Ultima).slice(11, 16)}.` });
      const tasa = pct(rech, total);
      if (rech > 0) h.push({ nivel: tasa >= 15 ? 'alto' : tasa >= 5 ? 'medio' : 'info', texto: `${fmtNum(rech)} transacciones rechazadas de ${fmtNum(total)} (${String(tasa).replace('.', ',')} %) ${periodo}.` });
      if (pend > 0) h.push({ nivel: 'medio', texto: `${fmtNum(pend)} transacciones siguen en un estado pendiente (ACSP, ACTC o PDNG): confirmar que se liquiden.` });
      if (sin > 0) h.push({ nivel: 'medio', texto: `${fmtNum(sin)} transacciones sin estado global registrado.` });
      const otras = total - (num(k.Aprobadas) || 0) - rech - pend - sin;
      if (otras > 0) h.push({ nivel: 'medio', texto: `${fmtNum(otras)} transacciones con un estado global poco común: revisa «Por estado de la transacción».` });
    }
  }
  const inc = fila0(res, 'inconsistentes');
  if (inc && num(inc.Casos) > 0) h.push({ nivel: 'alto', texto: `${fmtNum(inc.Casos)} transacciones con el débito aceptado pero el crédito o la transacción rechazados: revisar en Errores si requieren reverso.` });
  const codigos = res.por_codigos && res.por_codigos.ok ? res.por_codigos.filas.filter((f) => f['Código'] !== 'NT00' && f['Código'] !== '—') : [];
  if (codigos.length) {
    const top = codigos[0];
    h.push({ nivel: 'info', texto: `Código de respuesta más frecuente distinto de NT00: ${top['Código']} (${top.Lado.toLowerCase()}, ${fmtNum(top.Total)} casos${top.Motivo && top.Motivo !== '—' ? `, «${top.Motivo}»` : ''}).` });
  }
  const lk = fila0(res, 'log_kpis');
  if (lk) {
    const errores = num(lk.Errores) || 0;
    if (errores > 0) h.push({ nivel: errores > 50 ? 'alto' : 'medio', texto: `${fmtNum(errores)} registros con error en los logs de BreB${res.log_kpis.ayuda ? '' : ''} (ver la pestaña Errores).` });
    const deb = num(lk.Debitos) || 0;
    const sal = k ? num(k.Salientes) || 0 : null;
    if (sal !== null && deb > 0 && sal >= 0 && !v.logsRecortados && Math.abs(deb - sal) / Math.max(deb, 1) > 0.1 && Math.abs(deb - sal) >= 5) {
      h.push({ nivel: 'medio', texto: `Los logs muestran ${fmtNum(deb)} débitos (PAIN 008) y la base registra ${fmtNum(sal)} transacciones salientes: la diferencia se revisa en Errores > Reconciliación.` });
    }
  }
  if (origenes.log.estado === 'error') h.push({ nivel: 'medio', texto: `No se pudieron leer los logs de BreB: ${origenes.log.error}` });
  if (!h.length || !h.some((x) => x.nivel === 'alto' || x.nivel === 'medio')) h.push({ nivel: 'ok', texto: `Sin alertas ${periodo}: las transacciones fluyen sin rechazos ni inconsistencias detectadas.` });
  return h;
}

// ---------------------------------------------------------------------------
// Estado de cada paso de una transacción a partir de sus logs
// ---------------------------------------------------------------------------
const ETAPAS = {
  debito: 'Débito en el core (PAIN 008)',
  gateway: 'Reporte del gateway (Redeban)',
  registro: 'Registro de la transacción',
  onus: 'Envío interno (OnUs)',
  reporte: 'Reporte en el hub de BreB',
  notificacion: 'Notificación (Kafka y correo)',
  mensajeria: 'Mensajería al cliente',
  otro: 'Otros',
};
const ORDEN_ETAPAS = ['debito', 'gateway', 'registro', 'onus', 'reporte', 'notificacion', 'mensajeria', 'otro'];

function etapaDe(l) {
  const clase = String(l.Clase || '');
  const metodo = String(l.Metodo || '');
  if (metodo === 'PAIN 008') return 'debito';
  if (clase === 'GatewayBreBRB') return 'gateway';
  if (clase === 'WebApiTransacciones' || metodo === 'CrearTransaccion') return 'registro';
  if (metodo === 'OnUs') return 'onus';
  if (metodo === 'TransactionReport') return 'reporte';
  if (metodo === 'TransactionReportKafka') return 'notificacion';
  if (metodo === 'SendMail') return 'mensajeria';
  return 'otro';
}

const RE_ERROR_TEXTO = /(error|excep|fall(o|ó|a)\b)/i;

function detalleDeRs(rs) {
  if (!rs) return null;
  const j = S.leerJson(rs);
  if (j && typeof j === 'object') {
    const d = j.description || j.message || j.detail || j.mensaje || j.error;
    const c = j.statusCode || j.status || j.code;
    if (d && c) return `${String(c)} · ${String(d).trim()}`.slice(0, 240);
    if (d) return String(d).trim().slice(0, 240);
    if (c) return `Código ${String(c)}`;
  }
  const t = S.limpiarPayload(rs, { max: 200 });
  return t ? t.texto.replace(/\s+/g, ' ').slice(0, 200) : null;
}

function esErrorLog(l) {
  if (RE_ERROR_TEXTO.test(String(l.Descripcion || ''))) return true;
  const j = S.leerJson(l.Rs);
  const c = j && (j.statusCode || j.status);
  return !!(c && /^[45]\d\d$/.test(String(c)));
}

/** Tiempos T110…T540 del reporte de la transacción (Rq): hora de cada punto y cuánto tardó cada tramo. */
function latenciasDe(logs) {
  const candidatos = logs.filter((l) => l.Metodo === 'TransactionReport' && /"T\d{3}"/.test(String(l.Rq || '')));
  const hub = candidatos.find((l) => l.Clase === 'WebApiHubBreB') || candidatos[0];
  if (!hub) return null;
  const pares = [];
  const re = /"(T\d{3})"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)"/g;
  let m = re.exec(hub.Rq);
  while (m) { pares.push({ codigo: m[1], t: Date.parse(`${m[2]}Z`), hora: m[2].slice(11, 23) }); m = re.exec(hub.Rq); }
  const puntos = pares.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t || a.codigo.localeCompare(b.codigo));
  if (puntos.length < 2) return null;
  const t0 = puntos[0].t;
  let mayor = null;
  const lista = puntos.map((p, i) => {
    const paso = i ? p.t - puntos[i - 1].t : 0;
    if (i && (!mayor || paso > mayor.ms)) mayor = { de: puntos[i - 1].codigo, a: p.codigo, ms: paso };
    return { codigo: p.codigo, hora: p.hora, desdeInicioMs: p.t - t0, pasoMs: paso };
  });
  return { puntos: lista, totalMs: puntos[puntos.length - 1].t - t0, mayorTramo: mayor };
}

function analizarFlujo(logs, { direccion, encontradaEnBd }) {
  const porEtapa = {};
  for (const l of logs) {
    const e = etapaDe(l);
    (porEtapa[e] ||= []).push(l);
  }
  const pasos = [];
  for (const e of ORDEN_ETAPAS) {
    const ls = porEtapa[e] || [];
    const errores = ls.filter(esErrorLog);
    let estado;
    if (!ls.length) estado = 'falta';
    else if (errores.length) estado = 'error';
    else estado = 'ok';
    if (e === 'otro' && !ls.length) continue;
    if (e === 'onus' && !ls.length) continue;
    pasos.push({
      id: e, nombre: ETAPAS[e], estado, cantidad: ls.length, primera: ls[0] ? ls[0].Fecha : null,
      detalle: errores[0] ? (detalleDeRs(errores[0].Rs) || String(errores[0].Descripcion || '').slice(0, 200)) : null,
    });
  }
  const gw = (porEtapa.gateway || []).length;
  const tipoFlujo = (porEtapa.registro || []).map((l) => String(l.Descripcion || '')).find((d) => /onus|offus/i.test(d));
  const esperados = direccion === 'Saliente' ? ['debito', 'registro', 'reporte'] : [];
  for (const p of pasos) if (p.estado === 'falta' && !esperados.includes(p.id)) p.estado = 'info';
  return {
    pasos, total: logs.length, errores: logs.filter(esErrorLog).length, tipoFlujo: tipoFlujo ? (/offus/i.test(tipoFlujo) ? 'OffUs (otra entidad)' : 'OnUs (misma entidad)') : null,
    gatewayRepetido: gw > 1 ? gw : 0, faltantes: pasos.filter((p) => p.estado === 'falta').map((p) => p.nombre), evaluado: esperados.length > 0 && encontradaEnBd,
  };
}

// ---------------------------------------------------------------------------
// Pantallas
// ---------------------------------------------------------------------------
async function contexto(q, opciones) {
  const [ahora, propio] = await Promise.all([ahoraBd(), conexion.bancoPropio()]);
  return { ahora, propio, v: ventana(q, ahora, opciones) };
}

async function resumen(q) {
  const { v, propio } = await contexto(q, { maxDias: 92, defecto: 'hoy' });
  const lista = [...C.bloquesResumen(v, { propio })];
  const vl = ventanaLogs(v);
  const logs = C.bloquesLogsErrores(vl, { top: 10 }).filter(([id]) => ['log_kpis', 'log_err_hora'].includes(id));
  lista.push(...logs);
  const res = await ejecutarLista(lista);
  const origenes = estadoOrigenes(res);
  verificarOrigenes(origenes);
  const bloques = limpiar(res);
  const recortados = vl.recortada;
  if (recortados && bloques.log_kpis) bloques.log_kpis.ayuda = `Los logs se consultan hasta ${MAX_DIAS_LOGS} días: se muestran los últimos ${MAX_DIAS_LOGS} del rango.`;
  const vv = { ...v, logsRecortados: recortados };
  return {
    ventana: limpiarVentana(v), propio, origenes, bloques, hallazgos: hallazgosResumen(res, vv, origenes), logsRecortados: recortados, generadoEn: new Date().toISOString(),
  };
}

async function transacciones(q) {
  const { v, propio } = await contexto(q, { maxDias: 92, defecto: 'hoy' });
  const top = entero(q.top, 100, 25, 500, 'El tope');
  const estado = texto(q.estado, /^(aprobada|rechazada|pendiente|sinestado|problema)$/, 'El estado no es válido.', { max: 20 });
  const direccion = texto(q.direccion, /^(saliente|entrante|interna)$/, 'La dirección no es válida.', { max: 20 });
  const montoMin = q.montoMin !== undefined && String(q.montoMin).trim() !== '' ? Number(q.montoMin) : null;
  const montoMax = q.montoMax !== undefined && String(q.montoMax).trim() !== '' ? Number(q.montoMax) : null;
  for (const [n, x] of [['El monto mínimo', montoMin], ['El monto máximo', montoMax]]) if (x !== null && (!Number.isFinite(x) || x < 0 || x > 1e12)) throw new ErrorBreb(`${n} no es válido.`);
  const bloque = C.bloqueTransacciones(v, {
    propio, estado, direccion, top,
    caso: texto(q.caso, RE_CODIGO, 'El caso de uso no es válido.', { max: 30 }),
    escenario: texto(q.escenario, RE_CODIGO, 'El escenario no es válido.', { max: 30 }),
    iniciador: texto(q.iniciador, RE_CODIGO, 'El iniciador no es válido.', { max: 30 }),
    entidad: texto(q.entidad, RE_CODIGO, 'La entidad no es válida.', { max: 20 }),
    montoMin, montoMax, q: texto(q.q, RE_ID, 'La búsqueda solo admite letras, números y . _ - @ (un CUS, documento, cuenta o llave exactos).', { max: 120 }),
  });
  const res = await ejecutarLista([['transacciones', bloque]]);
  const origenes = estadoOrigenes(res);
  verificarOrigenes(origenes, ['sql']);
  return { ventana: limpiarVentana(v), propio, origenes, bloques: limpiar(res), generadoEn: new Date().toISOString() };
}

const SECCIONES_DETALLE = (r, propio, direccion) => {
  const m = (x) => (x === null || x === undefined || x === '' || /^null$/i.test(String(x)) ? null : String(x));
  const fecha = (d) => valorSeguro(d);
  const lado = (p) => [
    ['Tipo de parte', m(r[`${p}PartyType`])],
    ['Identificador de sistema', m(r[`${p}PartySystemIdentifier`])],
    ['Tipo de identificación', m(r[`${p}PartyIdentifierType`])],
    ['Identificación / llave', S.mascLlave(m(r[`${p}PartyIdentifier`]))],
    ['Documento', S.mascDocumento(m(r[`${p}DocumentNumber`]))],
    ['Nombre o alias', S.mascNombre(m(r[`${p}PartyAlias`] || r[`${p}NamePerson`]))],
    ['Entidad', m(r[`${p}BankId`])],
    ['Tipo de cuenta', m(r[`${p}ProductsTypeAccount`])],
    ['Cuenta', S.mascCuenta(m(r[`${p}ProductsAccountNumber`]))],
    ['Estado', m(r[`${p}TransactionStatus`])],
    ['Motivo', m(r[`${p}TransactionStatusRsnInf`])],
    ['Número de aprobación', m(r[`${p}NumberAproval`])],
    ['Código de respuesta', m(r[`${p}ResponseCode`])],
    ['Tiempo de respuesta', r[`${p}ResponseTime`] === null || r[`${p}ResponseTime`] === undefined ? null : `${r[`${p}ResponseTime`]} ms`],
  ];
  const credito = lado('Creditor');
  if (m(r.CreditorInstructedAgent)) credito.splice(7, 0, ['Agente instruido', m(r.CreditorInstructedAgent)]);
  const monto = r.OriginalCtrlSumAmt ?? r.MoneyAmt;
  return [
    {
      titulo: 'Resumen', campos: [
        ['Fecha de la transacción', fecha(r.TransactionDateTime)], ['Fecha en la entidad', fecha(r.EntityDateTime)], ['Fecha del reporte', fecha(r.ReportDateTime)],
        ['Estado global', `${clasifica(r.GlobalTxStatus)}${r.GlobalTxStatus ? ` (${r.GlobalTxStatus})` : ''}`],
        ['Monto', monto === null || monto === undefined ? null : `${fmtMoneda(monto)} ${m(r.Currency) || m(r.MoneyCcy) || ''}`.trim()],
        ['Dirección', direccion], ['Caso de uso', m(r.TransactionUseCase)], ['Escenario', m(r.TransactionScenario)], ['Subproceso', m(r.TransactionSubProcess)],
        ['Quién inició', m(r.TransactionInitiator)], ['Medio de inicio', [m(r.TransactionInitiatorType), m(r.TransactionInitiatorSubType)].filter(Boolean).join(' · ') || null],
        ['Tiempo de ejecución', r.ExecutionTime === null || r.ExecutionTime === undefined ? null : String(r.ExecutionTime)],
        ['Número de transacciones', r.NumberOfTxs === null ? null : String(r.NumberOfTxs)], ['Impuesto (CdTax)', m(r.CdTax)], ['Nota', m(r.Note)],
      ],
    },
    { titulo: 'Débito (quien paga o envía)', campos: lado('Debtor') },
    { titulo: 'Crédito (quien recibe)', campos: credito },
    {
      titulo: 'Identificadores y registro', campos: [
        ['CUS (TransactionID)', m(r.TransactionID)], ['Id en el directorio', m(r.TransactionDirectoryId)], ['Id externo', m(r.TransactionExternalId)],
        ['Registrada por', m(r.UsuarioCreo)], ['Creada', fecha(r.FechaCreo)], ['Modificada', fecha(r.FechaModifico)], ['Entidad propia usada para la dirección', propio],
      ],
    },
  ].map((s) => ({ titulo: s.titulo, campos: s.campos.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([etiqueta, valor]) => ({ etiqueta, valor: String(valor) })) }));
};

function direccionDe(r, propio) {
  if (!r) return null;
  if (r.DebtorBankId === propio && r.CreditorBankId === propio) return 'Interna (OnUs)';
  if (r.DebtorBankId === propio) return 'Saliente';
  if (r.CreditorBankId === propio) return 'Entrante';
  return 'Otra';
}

function hallazgosDetalle(r, flujo, lat, repeticiones, logsCount, origenes, direccion) {
  const h = [];
  if (r) {
    const clase = clasifica(r.GlobalTxStatus);
    if (clase === 'Rechazada') h.push({ nivel: 'alto', texto: `La transacción fue rechazada (estado ${r.GlobalTxStatus}).` });
    else if (clase === 'Pendiente') h.push({ nivel: 'medio', texto: `La transacción sigue pendiente (estado ${r.GlobalTxStatus}).` });
    else if (clase === 'Sin estado') h.push({ nivel: 'medio', texto: 'La transacción no tiene estado global registrado.' });
    else if (clase === 'Otro') h.push({ nivel: 'medio', texto: `Estado global poco común: ${r.GlobalTxStatus}.` });
    for (const [p, nombre] of [['Debtor', 'débito'], ['Creditor', 'crédito']]) {
      const cod = r[`${p}ResponseCode`];
      const motivo = r[`${p}TransactionStatusRsnInf`];
      if (cod && cod !== 'NT00') h.push({ nivel: 'medio', texto: `El ${nombre} respondió con el código ${cod}${motivo ? ` («${motivo}»)` : ''}.` });
    }
    if (['ACCP', 'ACSC'].includes(r.DebtorTransactionStatus) && (clase === 'Rechazada' || ['RJCT', 'CANC'].includes(r.CreditorTransactionStatus) || (r.CreditorResponseCode && r.CreditorResponseCode !== 'NT00'))) {
      h.push({ nivel: 'alto', texto: 'El débito fue aceptado pero el crédito o la transacción no: puede requerir reverso al cliente.' });
    }
    if (repeticiones > 1) h.push({ nivel: 'medio', texto: `Este CUS está guardado ${repeticiones} veces en trx.Redeban.` });
  }
  if (lat) {
    const nivel = lat.totalMs >= 15000 ? 'alto' : lat.totalMs >= 8000 ? 'medio' : 'info';
    const mayor = lat.mayorTramo && lat.mayorTramo.ms >= 1000 ? ` El tramo más lento fue ${lat.mayorTramo.de} → ${lat.mayorTramo.a} (${duracionTexto(lat.mayorTramo.ms)}).` : '';
    h.push({ nivel, texto: `De extremo a extremo tardó ${duracionTexto(lat.totalMs)} (T${lat.puntos[0].codigo.slice(1)} a ${lat.puntos[lat.puntos.length - 1].codigo}).${mayor}` });
  }
  if (flujo) {
    for (const p of flujo.pasos.filter((x) => x.estado === 'error')) h.push({ nivel: 'alto', texto: `Error en «${p.nombre}»${p.detalle ? `: ${p.detalle}` : '.'}` });
    if (flujo.evaluado && flujo.faltantes.length) h.push({ nivel: 'medio', texto: `En los logs no aparece: ${flujo.faltantes.join(', ')}.` });
    if (flujo.gatewayRepetido) h.push({ nivel: 'info', texto: `El gateway reportó la transacción ${flujo.gatewayRepetido} veces (normal si hubo reintentos).` });
  }
  if (!logsCount && origenes.log.estado === 'ok') h.push({ nivel: 'info', texto: 'No hay registros de esta transacción en los logs (en la ventana consultada).' });
  if (!r && logsCount && origenes.sql.estado === 'ok') h.push({ nivel: 'medio', texto: 'Hay registros en los logs pero la transacción no está en trx.Redeban: aún no se reportó o el reporte no llegó.' });
  if (origenes.sql.estado === 'error') h.push({ nivel: 'medio', texto: `No se pudo leer la base SQL Server: ${origenes.sql.error}` });
  if (origenes.log.estado === 'error') h.push({ nivel: 'medio', texto: `No se pudieron leer los logs: ${origenes.log.error}` });
  if (!h.length) h.push({ nivel: 'ok', texto: 'Sin hallazgos: la transacción fue aprobada y su recorrido no muestra errores.' });
  else if (!h.some((x) => x.nivel === 'alto' || x.nivel === 'medio') && r && clasifica(r.GlobalTxStatus) === 'Aprobada') h.unshift({ nivel: 'ok', texto: 'Transacción aprobada sin errores en su recorrido.' });
  return h;
}

async function transaccion({ cus: cusIn }) {
  const cus = cusValido(cusIn);
  const ahora = await ahoraBd();
  const propio = await conexion.bancoPropio();
  const resSql = await ejecutarLista(C.bloquesDetalle(cus, { propio }));
  const crudos = resSql.det_trx && resSql.det_trx._crudo ? resSql.det_trx._crudo : [];
  const r = crudos[0] || null;
  const repeticiones = fila0(resSql, 'det_repeticiones') ? num(fila0(resSql, 'det_repeticiones').Registros) || 0 : 0;
  const f = r && r.TransactionDateTime instanceof Date ? r.TransactionDateTime : null;
  const rangoLogs = f ? { desde: fmt(sumar(f, -D)), hasta: fmt(sumar(f, 2 * D)) } : { desde: fmt(sumar(ahora, -7 * D)), hasta: fmt(sumar(ahora, 60000)) };
  const extras = [['logs', C.bloqueLogsDeTrx(rangoLogs, cus)]];
  const bl = r ? C.bloqueLlavesDeTrx({ llaves: [r.CreditorPartyIdentifier, r.DebtorPartyIdentifier] }) : null;
  if (bl) extras.push(['det_llaves', bl]);
  const resExtra = await ejecutarLista(extras);
  const res = { ...resSql, ...resExtra };
  const origenes = estadoOrigenes(res);
  verificarOrigenes(origenes);
  const direccion = direccionDe(r, propio);
  const logsCrudos = (res.logs && res.logs._crudo) || [];
  const flujo = res.logs && res.logs.ok ? analizarFlujo(logsCrudos, { direccion, encontradaEnBd: !!r }) : null;
  const lat = res.logs && res.logs.ok ? latenciasDe(logsCrudos) : null;
  const encontrada = !!r || logsCrudos.length > 0;
  const logsVista = logsCrudos.map((l) => ({
    Codigo: String(l.Codigo), Fecha: valorSeguro(l.Fecha), Etapa: ETAPAS[etapaDe(l)], Clase: l.Clase, Metodo: l.Metodo,
    Nivel: esErrorLog(l) ? 'Error' : 'Info', Descripcion: S.limpiarTexto(String(l.Descripcion || '').slice(0, 220)), Detalle: (() => { const d = detalleDeRs(l.Rs); return d ? S.limpiarTexto(String(d)) : d; })(), Ip: l.Ip,
  }));
  const columnasLogs = ['Fecha', 'Etapa', 'Metodo', 'Nivel', 'Descripcion', 'Detalle', 'Codigo'];
  const bloques = limpiar(res);
  delete bloques.det_trx; delete bloques.det_repeticiones;
  if (bloques.logs) {
    bloques.logs = { ...bloques.logs, columnas: columnasLogs.map((n) => ({ clave: n, etiqueta: n === 'Metodo' ? 'Método' : n === 'Descripcion' ? 'Descripción' : n === 'Codigo' ? 'Código' : n })), filas: logsVista.map((x) => Object.fromEntries(columnasLogs.map((n) => [n, x[n] ?? null]))), clic: 'fila', columnaId: 'Codigo', titulo: 'Recorrido en los logs' };
  }
  return {
    cus, encontrada, enBd: !!r, repeticiones, direccion, propio,
    estado: r ? { clase: clasifica(r.GlobalTxStatus), codigo: r.GlobalTxStatus || null } : null,
    monto: r ? num(r.OriginalCtrlSumAmt ?? r.MoneyAmt) : null,
    secciones: r ? SECCIONES_DETALLE(r, propio, direccion) : [],
    flujo, latencias: lat, hallazgos: encontrada ? hallazgosDetalle(r, flujo, lat, repeticiones, logsCrudos.length, origenes, direccion) : [{ nivel: 'info', texto: 'No se encontró ese CUS ni en trx.Redeban ni en los logs (revisa que esté completo).' }],
    origenes, bloques, generadoEn: new Date().toISOString(),
  };
}

// ---- Errores --------------------------------------------------------------
async function errores(q) {
  const { v, propio } = await contexto(q, { maxDias: 31, defecto: 'hoy' });
  const vl = ventanaLogs(v);
  const lista = [...C.bloquesErroresSql(v, { propio, top: 100 }), ...C.bloquesLogsErrores(vl, { top: 100 })];
  const res = await ejecutarLista(lista);
  // Detalle (último Rs) de cada grupo de errores de log.
  const grupos = res.log_err_grupos;
  if (grupos && grupos.ok && grupos.filas.length) {
    try {
      const codigos = grupos.filas.map((f) => f.UltimoCodigo).filter(Boolean);
      const muestras = await maria.consultar('SELECT Codigo, LEFT(Rs, 700) AS Rs FROM `Log` WHERE Codigo IN (?)', [codigos]);
      const mapa = new Map(muestras.map((m) => [String(m.Codigo), detalleDeRs(m.Rs)]));
      grupos.columnas = [...grupos.columnas.filter((c) => c.clave !== 'UltimoCodigo'), { clave: 'Detalle', etiqueta: 'Detalle del último caso' }];
      grupos.filas = grupos.filas.map(({ UltimoCodigo, ...resto }) => ({ ...resto, Detalle: mapa.get(String(UltimoCodigo)) || null }));
    } catch { /* si no se puede, queda sin detalle */ }
  }
  const origenes = estadoOrigenes(res);
  verificarOrigenes(origenes);
  const bloques = limpiar(res);
  if (vl.recortada) for (const id of Object.keys(bloques)) if (bloques[id].origen === 'log') bloques[id].ayuda = `${bloques[id].ayuda ? `${bloques[id].ayuda} ` : ''}(Los logs se consultan hasta ${MAX_DIAS_LOGS} días: se muestran los últimos ${MAX_DIAS_LOGS} del rango.)`;
  const hallazgos = hallazgosErrores(res, v, origenes);
  return { ventana: limpiarVentana(v), propio, origenes, bloques, hallazgos, logsRecortados: vl.recortada, generadoEn: new Date().toISOString() };
}

function hallazgosErrores(res, v, origenes) {
  const h = [];
  const n = (id) => (res[id] && res[id].ok ? res[id].filas.length : null);
  const inc = n('err_inconsistentes');
  if (inc) h.push({ nivel: 'alto', texto: `${inc}${res.err_inconsistentes.truncado ? '+' : ''} transacciones con el débito aceptado y el crédito o la transacción rechazados: revisar para un posible reverso.` });
  const dup = n('err_duplicadas');
  if (dup) h.push({ nivel: 'medio', texto: `${dup} CUS aparecen repetidos en trx.Redeban.` });
  const mot = res.err_motivos && res.err_motivos.ok ? res.err_motivos.filas : [];
  if (mot.length) {
    const t = mot[0];
    h.push({ nivel: 'medio', texto: `Motivo más frecuente de problema: ${t.Lado.toLowerCase()} con código ${t['Código']}${t.Motivo && t.Motivo !== '—' ? ` («${t.Motivo}»)` : ''}, ${fmtNum(t.Casos)} casos.` });
  }
  const lg = res.log_err_grupos && res.log_err_grupos.ok ? res.log_err_grupos.filas : [];
  if (lg.length) {
    const total = lg.reduce((a, f) => a + (f.Veces || 0), 0);
    h.push({ nivel: total > 50 ? 'alto' : 'medio', texto: `${fmtNum(total)} errores en los logs en ${lg.length} tipo${lg.length === 1 ? '' : 's'}; el más frecuente: ${lg[0].Clase} · ${lg[0].Metodo} («${String(lg[0].Descripcion).slice(0, 90)}», ${fmtNum(lg[0].Veces)} veces).` });
  }
  const inc2 = res.log_flujo_incompleto && res.log_flujo_incompleto.ok ? res.log_flujo_incompleto.filas.length : 0;
  if (inc2) h.push({ nivel: 'medio', texto: `${inc2}${res.log_flujo_incompleto.truncado ? '+' : ''} transacciones con débito en el core pero sin registro o sin reporte en los logs.` });
  const av = res.log_avisos && res.log_avisos.ok ? res.log_avisos.filas.reduce((a, f) => a + (f.Veces || 0), 0) : 0;
  if (av) h.push({ nivel: 'info', texto: `${fmtNum(av)} avisos de mensajería incompleta (informativos, no afectan la transacción).` });
  if (origenes.sql.estado === 'error') h.push({ nivel: 'alto', texto: `No se pudo leer la base SQL Server: ${origenes.sql.error}` });
  if (origenes.log.estado === 'error') h.push({ nivel: 'medio', texto: `No se pudieron leer los logs: ${origenes.log.error}` });
  if (!h.some((x) => x.nivel === 'alto' || x.nivel === 'medio')) h.push({ nivel: 'ok', texto: `Sin errores relevantes ${v.etiqueta.toLowerCase()}.` });
  return h;
}

// ---- Reconciliación SQL Server ↔ logs ---------------------------------------
const trozos = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

async function reconciliacion(q) {
  const { v, propio, ahora } = await contexto(q, { maxDias: 2, defecto: 'hoy' });
  if (!configurado('sql') || !configurado('log')) throw new ErrorBreb('La reconciliación necesita las dos conexiones (SQL Server y logs de MariaDB) configuradas.', 409, 'SIN_CONFIG');
  const TOPE = 4000;
  const logsDebito = await ejecutarUno('l_deb', {
    origen: 'log', titulo: 'x', crudo: true, tope: TOPE,
    sql: `SELECT Transaccion AS CUS, MIN(Fecha) AS Inicio, MAX(Clase) AS Clase FROM \`Log\` WHERE Fecha >= ? AND Fecha < ? AND Metodo = 'PAIN 008' AND Transaccion IS NOT NULL AND Transaccion <> '' GROUP BY Transaccion ORDER BY MIN(Fecha) DESC LIMIT ${TOPE + 1}`,
    params: [v.desde, v.hasta],
  });
  const sqlSal = await ejecutarUno('s_sal', {
    origen: 'sql', titulo: 'x', crudo: true, tope: TOPE,
    sql: `SELECT TOP ${TOPE + 1} r.TransactionID AS CUS, r.TransactionDateTime AS Fecha, ${C.MONTO} AS Monto, ${C.CLASE_ESTADO} AS Estado
      FROM ${C.RED} WHERE ${C.FECHA_TRX} AND r.DebtorBankId = @propio AND r.TransactionID IS NOT NULL ORDER BY r.TransactionDateTime DESC`,
    params: [C.P('desde', v.desde), C.P('hasta', v.hasta), C.P('propio', propio)],
  });
  const origenes = estadoOrigenes({ a: logsDebito, b: sqlSal });
  verificarOrigenes(origenes);
  const errorPorOrigen = [logsDebito, sqlSal].find((x) => !x.ok);
  if (errorPorOrigen) throw new ErrorBreb(errorPorOrigen.error, 502, 'CONEXION');

  const delLog = logsDebito._crudo.slice(0, TOPE);
  const delSql = sqlSal._crudo.slice(0, TOPE);
  const truncado = logsDebito._crudo.length > TOPE || sqlSal._crudo.length > TOPE;
  const cusLog = delLog.map((f) => String(f.CUS));
  const cusSql = delSql.map((f) => String(f.CUS));
  const enBd = new Set();
  for (const grupo of trozos(cusLog, 400)) {
    const ps = grupo.map((c, i) => C.P(`c${i}`, c));
    const filas = await sql.consultar(PERFIL, `${PREFIJO}SELECT r.TransactionID AS CUS FROM ${C.RED} WHERE r.TransactionID IN (${ps.map((x) => `@${x.nombre}`).join(', ')})`, ps);
    for (const f of filas) enBd.add(String(f.CUS));
  }
  const enLog = new Set();
  const vd = { desde: fmt(sumar(v._d, -D)), hasta: fmt(sumar(v._h, D)) };
  for (const grupo of trozos(cusSql, 400)) {
    const filas = await maria.consultar('SELECT DISTINCT Transaccion AS CUS FROM `Log` WHERE Transaccion IN (?) AND Metodo = \'PAIN 008\' AND Fecha >= ? AND Fecha < ?', [grupo, vd.desde, vd.hasta]);
    for (const f of filas) enLog.add(String(f.CUS));
  }
  const limite = sumar(ahora, -5 * 60000);
  const logSinBd = delLog.filter((f) => !enBd.has(String(f.CUS))).map((f) => ({ CUS: String(f.CUS), Inicio: valorSeguro(f.Inicio), Reciente: parseFecha(f.Inicio) > limite ? 'Sí (puede estar en curso)' : 'No' }));
  const bdSinLog = delSql.filter((f) => !enLog.has(String(f.CUS))).map((f) => ({ CUS: String(f.CUS), Fecha: valorSeguro(f.Fecha), Monto: valorSeguro(f.Monto), Estado: valorSeguro(f.Estado) }));
  const mk = (id, titulo, ayuda, columnas, filas) => ({
    id, titulo, ayuda, vista: 'tabla', clic: 'fila', columnaId: 'CUS', externa: false, vertical: false, ok: true, columnas: columnas.map((c) => ({ clave: c, etiqueta: c })),
    filas: filas.slice(0, MAX_FILAS), truncado: filas.length > MAX_FILAS, sql: null, origen: 'sql',
  });
  const reales = logSinBd.filter((f) => f.Reciente === 'No');
  const hallazgos = [];
  if (reales.length) hallazgos.push({ nivel: 'alto', texto: `${fmtNum(reales.length)} transacciones con débito en el core (logs) que NO están en trx.Redeban (y no son recientes): posible débito sin reporte.` });
  if (bdSinLog.length) hallazgos.push({ nivel: 'info', texto: `${fmtNum(bdSinLog.length)} transacciones salientes de trx.Redeban sin registro de débito (PAIN 008) en los logs del rango.` });
  if (truncado) hallazgos.push({ nivel: 'info', texto: `El rango tiene más de ${fmtNum(TOPE)} transacciones: se compararon las ${fmtNum(TOPE)} más recientes de cada fuente.` });
  if (!hallazgos.some((x) => x.nivel === 'alto')) hallazgos.unshift({ nivel: 'ok', texto: 'Los débitos de los logs coinciden con las transacciones registradas en trx.Redeban.' });
  return {
    ventana: limpiarVentana(v), propio, origenes: estadoOrigenes({ a: logsDebito, b: sqlSal }), hallazgos,
    resumen: { debitosEnLog: delLog.length, salientesEnBd: delSql.length, logSinBd: logSinBd.length, bdSinLog: bdSinLog.length, coinciden: delLog.length - logSinBd.length },
    bloques: {
      rec_log_sin_bd: mk('rec_log_sin_bd', 'Débito en logs sin registro en trx.Redeban', 'Los de los últimos 5 minutos pueden estar en curso.', ['CUS', 'Inicio', 'Reciente'], logSinBd),
      rec_bd_sin_log: mk('rec_bd_sin_log', 'Salientes en trx.Redeban sin débito en logs', 'Puede deberse a logs rotados o a transacciones iniciadas por otra vía.', ['CUS', 'Fecha', 'Monto', 'Estado'], bdSinLog),
    },
    generadoEn: new Date().toISOString(),
  };
}

// ---- Cliente 360 ------------------------------------------------------------
function lineaTiempoCliente(res) {
  const ev = [];
  const poner = (fecha, tipo, titulo, detalle, cus) => { if (fecha) ev.push({ fecha: String(fecha), tipo, titulo, detalle: detalle || null, cus: cus || null }); };
  for (const f of res.cl_trx?.filas || []) {
    const mal = f.Estado !== 'Aprobada';
    poner(f.Fecha, mal ? 'trx_mal' : 'trx', `${f.Rol === 'Débito' ? 'Pagó o envió' : 'Recibió'} ${f.Monto !== null ? fmtMoneda(f.Monto) : ''} · ${f.Caso}/${f.Escenario}`.trim(), `${f.Estado}${f['Resp. débito'] && f['Resp. débito'] !== 'NT00' ? ` · débito ${f['Resp. débito']}` : ''}${f['Resp. crédito'] && f['Resp. crédito'] !== 'NT00' ? ` · crédito ${f['Resp. crédito']}` : ''}`, f.CUS);
  }
  for (const f of res.cl_historico?.filas || []) poner(f.Fecha, 'llave', `Llave: ${f.Proceso || 'cambio'}`, `${f.Tipo || ''} ${f.Llave || ''} · ${f.Estado || ''}`.trim(), null);
  for (const f of res.cl_log_errores?.filas || []) poner(f.Fecha, 'error', `Error en ${f.Clase} · ${f.Metodo}`, f.Descripcion, f.CUS);
  for (const f of res.cl_qr?.filas || []) poner(f.Creado, 'qr', `QR creado (${f.Tipo || 'tipo desconocido'})`, `${f.Usos} usos · ${f.Estado}`, null);
  ev.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  return ev.slice(0, 250);
}

function hallazgosCliente(res, usuarioEncontrado, origenes) {
  const h = [];
  if (origenes.sql.estado === 'ok' && !usuarioEncontrado) h.push({ nivel: 'info', texto: 'No hay un cliente con ese documento en la base de BreB (puede aparecer solo como contraparte de transacciones).' });
  const ll = res.cl_llaves && res.cl_llaves.ok ? res.cl_llaves.filas : [];
  if (usuarioEncontrado && res.cl_llaves?.ok && !ll.length) h.push({ nivel: 'info', texto: 'El cliente existe pero no tiene llaves registradas.' });
  const noActivas = ll.filter((f) => f.Estado && !/activ/i.test(String(f.Estado)));
  if (noActivas.length) h.push({ nivel: 'info', texto: `${noActivas.length} de ${ll.length} llaves no están activas (${[...new Set(noActivas.map((x) => x.Estado))].join(', ')}).` });
  const filasRes = res.cl_resumen_trx && res.cl_resumen_trx.ok ? res.cl_resumen_trx.filas : [];
  const rech = filasRes.reduce((a, f) => a + (f.Rechazadas || 0), 0);
  const tot = filasRes.reduce((a, f) => a + (f.Total || 0), 0);
  if (rech) h.push({ nivel: pct(rech, tot) >= 30 ? 'alto' : 'medio', texto: `${rech} de ${tot} transacciones del cliente fueron rechazadas en el período.` });
  const lk = fila0(res, 'cl_log_kpis');
  if (lk && num(lk.Errores) > 0) h.push({ nivel: 'medio', texto: `${fmtNum(lk.Errores)} registros con error en los logs del cliente.` });
  if (origenes.sql.estado === 'error') h.push({ nivel: 'alto', texto: `No se pudo leer la base SQL Server: ${origenes.sql.error}` });
  if (origenes.log.estado === 'error') h.push({ nivel: 'medio', texto: `No se pudieron leer los logs: ${origenes.log.error}` });
  if (!h.length) h.push({ nivel: 'ok', texto: 'Sin hallazgos para este cliente en el período.' });
  return h;
}

async function cliente(q) {
  const documento = documentoValido(q.documento);
  const dias = entero(q.dias, 30, 1, 90, 'Los días');
  const { v, propio } = await contexto({ rango: `${dias}d` }, { maxDias: 92 });
  const diasLogs = entero(q.diasLogs, 3, 1, 7, 'Los días de logs');
  const vl = ventanaLogs(v, diasLogs);
  const lista = [...C.bloquesCliente(v, { documento, propio, top: 200 }), ...C.bloquesLogsCliente(vl, documento)];
  const res = await ejecutarLista(lista);
  const origenes = estadoOrigenes(res);
  verificarOrigenes(origenes);
  const crudoUsuario = (res.cl_usuario && res.cl_usuario._crudo) || [];
  const usuarios = crudoUsuario.map((u) => ({ idTipoPersona: num(u.IdTipoPersona), idTipoDocumento: num(u.IdTipoDocumento), persona: u.Persona || null, tipoDocumento: u['Tipo de documento'] || null }));
  if (res.cl_usuario && res.cl_usuario.ok) {
    res.cl_usuario.columnas = res.cl_usuario.columnas.filter((c) => !['IdUsuario', 'IdTipoPersona', 'IdTipoDocumento'].includes(c.clave));
    res.cl_usuario.filas = res.cl_usuario.filas.map(({ IdUsuario, IdTipoPersona, IdTipoDocumento, ...r }) => r);
  }
  const bloques = limpiar(res);
  return {
    enmascarado: enmascarar(documento), dias, diasLogs: vl.dias, ventana: limpiarVentana(v), propio, encontrado: usuarios.length > 0, usuarios, origenes, bloques,
    lineaTiempo: lineaTiempoCliente(bloques), hallazgos: hallazgosCliente(bloques, usuarios.length > 0, origenes), generadoEn: new Date().toISOString(),
  };
}

// ---- Llaves y QR / Parámetros --------------------------------------------------
async function llaves(q) {
  const { v } = await contexto(q, { maxDias: 92, defecto: '30d' });
  const res = await ejecutarLista(C.bloquesLlaves(v));
  const origenes = estadoOrigenes(res);
  verificarOrigenes(origenes, ['sql']);
  const bloques = limpiar(res);
  const h = [];
  const an = bloques.ll_anomalias && bloques.ll_anomalias.ok ? bloques.ll_anomalias.filas.filter((f) => f.Casos > 0) : [];
  for (const a of an) h.push({ nivel: 'medio', texto: `${fmtNum(a.Casos)} casos: ${String(a['Anomalía']).toLowerCase()}.` });
  const tot = fila0(res, 'll_totales');
  if (tot) h.push({ nivel: 'info', texto: `${fmtNum(tot.Llaves)} llaves de ${fmtNum(tot.Clientes)} clientes; ${fmtNum(tot.LlavesCreadas)} creadas en el rango.` });
  if (!an.length && tot) h.unshift({ nivel: 'ok', texto: 'Sin inconsistencias detectadas en llaves.' });
  return { ventana: limpiarVentana(v), origenes, bloques, hallazgos: h, generadoEn: new Date().toISOString() };
}

async function parametros(q) {
  const app = texto(q.app, RE_CODIGO, 'La aplicación no es válida.', { max: 50 });
  const t = texto(q.texto, /^[A-Za-z0-9_.\- ]+$/, 'El texto solo admite letras, números, espacio y . _ -', { max: 60 });
  const res = await ejecutarLista(C.bloquesParametros({ app, texto: t }));
  const origenes = estadoOrigenes(res);
  verificarOrigenes(origenes, ['sql']);
  return { origenes, bloques: limpiar(res), generadoEn: new Date().toISOString() };
}

// ---- Logs -----------------------------------------------------------------------
async function logs(q) {
  const cus = texto(q.cus, /^[A-Za-z0-9._\-]+$/, 'El CUS no es válido.', { max: 80 });
  const documento = q.documento ? documentoValido(q.documento) : null;
  const acotado = !!(cus || documento);
  const { v } = await contexto(q, { maxDias: acotado ? 7 : MAX_DIAS_LOGS, defecto: acotado ? '3d' : '1h' });
  const top = entero(q.top, 100, 25, 200, 'El tope');
  const clase = texto(q.clase, /^[A-Za-z0-9_.\- ]+$/, 'El componente no es válido.', { max: 60 });
  const metodo = texto(q.metodo, /^[A-Za-z0-9_.\- ]+$/, 'El método no es válido.', { max: 60 });
  const nivel = texto(q.nivel, /^(error|todos)$/, 'El nivel no es válido.', { max: 10 });
  const t = texto(q.texto, /^[^\u0000-\u001f%_\\]+$/, 'El texto a buscar tiene caracteres no válidos.', { max: 80 });
  const antes = texto(q.antes, /^\d{1,20}$/, 'El cursor no es válido.', { max: 20 });
  const enPayload = q.enPayload === '1' || q.enPayload === true;
  if (enPayload && !acotado && v.dias > 1) throw new ErrorBreb('Para buscar dentro de los datos enviados y recibidos (Rq/Rs) limita el rango a 1 día o filtra por CUS o documento.');
  const lista = [['lista', C.bloqueLogsLista(v, { cus, documento, clase, metodo, nivel, texto: t, enPayload, antes, top })]];
  if (!antes) lista.push(['actividad', C.bloqueLogsActividad(v)]);
  const res = await ejecutarLista(lista);
  const origenes = estadoOrigenes(res);
  verificarOrigenes(origenes, ['log']);
  const bloques = limpiar(res);
  const sig = bloques.lista && bloques.lista.ok && bloques.lista.truncado ? bloques.lista.filas[bloques.lista.filas.length - 1].Codigo : null;
  return { ventana: limpiarVentana(v), origenes, bloques, siguiente: sig, generadoEn: new Date().toISOString() };
}

async function logDetalle({ codigo }) {
  const c = texto(codigo, /^\d{1,20}$/, 'El código del registro no es válido.', { max: 20 });
  if (!c) throw new ErrorBreb('Indica el código del registro.');
  const r = await ejecutarUno('detalle', C.bloqueLogDetalle(c));
  if (!r.ok) throw new ErrorBreb(r.error, r.omitido ? 409 : 502, r.omitido ? 'SIN_CONFIG' : 'CONEXION');
  const f = r._crudo[0];
  if (!f) throw new ErrorBreb('No se encontró ese registro.', 404, 'NO_ENCONTRADO');
  const lat = f.Metodo === 'TransactionReport' ? latenciasDe([f]) : null;
  return {
    codigo: String(f.Codigo), fecha: valorSeguro(f.Fecha), clase: f.Clase, metodo: f.Metodo, descripcion: f.Descripcion, cus: f.Transaccion || null,
    documento: S.mascDocumento(f.Documento), ip: f.Ip || null, sesion: f.Sesion || null, nivel: esErrorLog(f) ? 'Error' : 'Info',
    canal: f.CanalCodigo, funcionalidad: f.FuncionalidadCodigo, tipo: f.TipoCodigo, proceso: f.ProcesoCodigo,
    etapa: ETAPAS[etapaDe(f)], latencias: lat,
    rq: S.limpiarPayload(f.Rq), rs: S.limpiarPayload(f.Rs), adicional: S.limpiarPayload(f.Adicional, { max: 4000 }),
  };
}

// ---- Catálogos para las herramientas de llaves ---------------------------------------
async function catalogos() {
  const [propio, res] = await Promise.all([conexion.bancoPropio(), ejecutarLista([
    ['personas', { origen: 'sql', titulo: 'Tipos de persona', sql: 'SELECT TOP 50 id AS Id, descripcion AS Nombre FROM tipo.persona WITH (NOLOCK) ORDER BY id', params: [] }],
    ['documentos', { origen: 'sql', titulo: 'Tipos de documento', sql: 'SELECT TOP 50 id AS Id, descripcion AS Nombre FROM tipo.documento WITH (NOLOCK) ORDER BY id', params: [] }],
  ])]);
  const lista = (id) => (res[id] && res[id].ok ? res[id].filas.map((f) => ({ id: f.Id, nombre: f.Nombre })) : []);
  return { propio, personas: lista('personas'), documentos: lista('documentos'), disponible: !!(res.personas && res.personas.ok), error: res.personas && !res.personas.ok && !res.personas.omitido ? res.personas.error : null };
}

/** Cruce local de «consultar llave»: lo que la base de BreB tiene del mismo documento. */
async function cruceConsultar({ documento, idTipoPersona, idTipoDocumento }) {
  if (!configurado('sql')) return null;
  try {
    const v = { desde: '2000-01-01 00:00:00', hasta: '2100-01-01 00:00:00' };
    const propio = await conexion.bancoPropio();
    const lista = C.bloquesCliente(v, { documento, propio, top: 25 }).filter(([id]) => ['cl_usuario', 'cl_llaves'].includes(id));
    const res = await ejecutarLista(lista);
    const bloques = limpiar(res);
    return { usuario: bloques.cl_usuario, llaves: bloques.cl_llaves, idTipoPersona, idTipoDocumento };
  } catch { return null; }
}

async function cruceResolver({ aliasValue }) {
  if (!configurado('sql')) return null;
  const b = C.bloqueLlavesDeTrx({ llaves: [aliasValue] });
  const r = await ejecutarUno('local', b);
  const { _crudo, conexionCaida, ...resto } = r;
  return resto;
}

module.exports = {
  ErrorBreb, sqlSoloLectura, valorSeguro, ejecutarBloque, ejecutarLista, ventana, ventanaLogs, parseFecha, fmt, entero, documentoValido, cusValido, enmascarar,
  hallazgosResumen, hallazgosErrores, analizarFlujo, latenciasDe, detalleDeRs, esErrorLog, etapaDe, clasifica, direccionDe, duracionTexto,
  resumen, transacciones, transaccion, errores, reconciliacion, cliente, llaves, parametros, logs, logDetalle, catalogos, cruceConsultar, cruceResolver, ahoraBd,
  limpiarCacheReloj: () => { cacheAhora = { en: 0, valor: null }; },
};
