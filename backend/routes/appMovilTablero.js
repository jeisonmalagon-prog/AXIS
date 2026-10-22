// ==========================================================================
// TABLERO DE MONITOREO DE APP MÓVIL (lee SOLO el ETL de BIC_CERTI_MARIA)
// ==========================================================================
//   GET /tablero/estado     Semáforo del ETL y de las tablas, hoy en vivo y alertas recientes
//   GET /tablero/serie      Serie diaria (volumen, errores, usuarios, latencia) + período anterior
//   GET /tablero/latencia   Ranking de servicios por tiempo de respuesta, con tendencia
//   GET /tablero/clientes   Clientes con más actividad / errores (rango acotado)
//
// Importante: ninguno de estos endpoints consulta LogApp. Todo sale de las tablas de
// resumen diario que ya alimenta la ETL (AppMovilResumenDiario, AppMovilLatenciaDiaria,
// AppMovilPorFuncionalidadDiario, AppMovilPorClienteDiario, AppMovilVersionDiaria,
// AppMovilAlertaMasiva), por lo que son baratos y no suman carga a la tabla de logs.
// Si alguna tabla todavía no existe, el endpoint responde con `disponible: false` y un
// mensaje claro en vez de fallar.
// No requiere ningún script SQL nuevo.
// ==========================================================================

const DIA_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;
const RANGO_MAX_CLIENTES_DIAS = 31;

const TABLAS = [
  { tabla: 'AppMovilResumenDiario', etiqueta: 'Resumen diario', columnaFecha: 'Fecha', descripcion: 'Totales, errores y usuarios por día' },
  { tabla: 'AppMovilPorDispositivoDiario', etiqueta: 'Por dispositivo', columnaFecha: 'Fecha', descripcion: 'Actividad por tipo de dispositivo' },
  { tabla: 'AppMovilPorFuncionalidadDiario', etiqueta: 'Por funcionalidad', columnaFecha: 'Fecha', descripcion: 'Totales y errores por servicio' },
  { tabla: 'AppMovilLatenciaDiaria', etiqueta: 'Latencia diaria', columnaFecha: 'Fecha', descripcion: 'Tiempo de respuesta por servicio' },
  { tabla: 'AppMovilPorClienteDiario', etiqueta: 'Por cliente', columnaFecha: 'Fecha', descripcion: 'Actividad por documento y día' },
  { tabla: 'AppMovilVersionDiaria', etiqueta: 'Versiones por día', columnaFecha: 'Fecha', descripcion: 'Clientes por versión de la app' },
  { tabla: 'AppMovilVersionCliente', etiqueta: 'Versión por cliente', columnaFecha: 'UltimaVez', descripcion: 'Última versión usada por cada cliente' },
  { tabla: 'AppMovilAlertaMasiva', etiqueta: 'Alertas masivas', columnaFecha: 'Detectada', descripcion: 'Historial de alertas de error masivo' }
];

// Umbrales de latencia (segundos, promedio ponderado del servicio en el rango).
const LATENCIA_AVISO_S = 2.5;
const LATENCIA_CRITICA_S = 5;

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function aFecha(texto) { return new Date(`${texto}T00:00:00`); }
function sumarDias(texto, n) { return ymd(new Date(aFecha(texto).getTime() + n * DIA_MS)); }
function diasEntre(ini, fin) { return Math.round((aFecha(fin).getTime() - aFecha(ini).getTime()) / DIA_MS) + 1; }
function redondear(n, d = 2) { return n === null || n === undefined || Number.isNaN(Number(n)) ? null : Number(Number(n).toFixed(d)); }
function numero(v) { return v === null || v === undefined ? 0 : Number(v); }
function tasaExito(total, errores) { return total > 0 ? redondear(((total - errores) / total) * 100, 2) : null; }
function esTablaInexistente(e) { return !!e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146); }
function delta(actual, anterior) {
  if (actual === null || actual === undefined || anterior === null || anterior === undefined || anterior <= 0) return null;
  return redondear(((actual - anterior) / anterior) * 100, 1);
}

module.exports = function registrarRutasTablero(router, deps) {
  const { verifyToken, requireModule, getPool, resolverRango, estadoEtl, nombreServicioLegible } = deps;

  const cache = new Map();
  async function conCache(clave, fn) {
    const hit = cache.get(clave);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
    const v = await fn();
    cache.set(clave, { t: Date.now(), v });
    if (cache.size > 80) {
      const viejos = [...cache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 30);
      for (const [k] of viejos) cache.delete(k);
    }
    return v;
  }

  function rangoDe(query, maxDias) {
    const r = resolverRango(query || {});
    let inicio = r.fechaInicioTexto;
    const fin = r.fechaFinTexto;
    let dias = diasEntre(inicio, fin);
    if (maxDias && dias > maxDias) { inicio = sumarDias(fin, -(maxDias - 1)); dias = maxDias; }
    return { inicio, fin, dias, recortado: !!(maxDias && diasEntre(r.fechaInicioTexto, fin) > maxDias) };
  }

  const envolver = (nombre, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (esTablaInexistente(err)) {
        return res.json({
          disponible: false,
          mensaje: 'Todavía no existen las tablas de resumen de App Móvil en BIC_CERTI_MARIA. Pide al administrador de base de datos que ejecute los scripts crear_tablas_rollup_app_movil_BIC_CERTI_MARIA.sql y crear_tablas_analisis_app_movil_BIC_CERTI_MARIA.sql.'
        });
      }
      console.error(`Tablero App Móvil (${nombre}):`, err.message);
      res.status(500).json({ error: 'No se pudo calcular esta vista del tablero.' });
    }
  };

  // ------------------------------------------------------------------------
  // SERIE DIARIA
  // ------------------------------------------------------------------------
  async function leerSerie(pool, inicio, fin) {
    const [resumen] = await pool.query(
      `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d') AS dia, TotalTransacciones AS total, TotalErrores AS errores,
              UsuariosUnicos AS usuarios, SesionesDistintas AS sesiones,
              DATE_FORMAT(ActualizadoEn, '%Y-%m-%d %H:%i:%s') AS actualizado
         FROM AppMovilResumenDiario WHERE Fecha BETWEEN ? AND ? ORDER BY Fecha`, [inicio, fin]);

    let latencia = [];
    let login = [];
    try {
      [latencia] = await pool.query(
        `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d') AS dia, SUM(LlamadasMedidas) AS n,
                SUM(TiempoPromedioSegundos * LlamadasMedidas) AS sp, MAX(TiempoMaximoSegundos) AS mx
           FROM AppMovilLatenciaDiaria WHERE Fecha BETWEEN ? AND ? GROUP BY Fecha`, [inicio, fin]);
      [login] = await pool.query(
        `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d') AS dia, SUM(LlamadasMedidas) AS n,
                SUM(TiempoPromedioSegundos * LlamadasMedidas) AS sp
           FROM AppMovilLatenciaDiaria WHERE Fecha BETWEEN ? AND ? AND Clase = 'UsersService' AND Metodo = 'login_api'
          GROUP BY Fecha`, [inicio, fin]);
    } catch (e) { if (!esTablaInexistente(e)) throw e; }

    const porDia = new Map(resumen.map((f) => [f.dia, f]));
    const lat = new Map(latencia.map((f) => [f.dia, f]));
    const log = new Map(login.map((f) => [f.dia, f]));
    const serie = [];
    for (let d = inicio; d <= fin; d = sumarDias(d, 1)) {
      const f = porDia.get(d);
      const l = lat.get(d);
      const g = log.get(d);
      const total = f ? numero(f.total) : 0;
      const errores = f ? numero(f.errores) : 0;
      serie.push({
        dia: d,
        sinDato: !f,
        total, errores,
        exitosas: Math.max(0, total - errores),
        tasaExito: f ? tasaExito(total, errores) : null,
        usuarios: f ? numero(f.usuarios) : 0,
        sesiones: f ? numero(f.sesiones) : 0,
        latenciaPromedio: l && numero(l.n) > 0 ? redondear(numero(l.sp) / numero(l.n)) : null,
        latenciaMaxima: l && l.mx !== null ? redondear(l.mx) : null,
        loginPromedio: g && numero(g.n) > 0 ? redondear(numero(g.sp) / numero(g.n)) : null,
        actualizado: f ? f.actualizado : null
      });
    }
    return serie;
  }

  function sumarSerie(serie) {
    const conDato = serie.filter((s) => !s.sinDato);
    const total = conDato.reduce((a, s) => a + s.total, 0);
    const errores = conDato.reduce((a, s) => a + s.errores, 0);
    const conLat = serie.filter((s) => s.latenciaPromedio !== null);
    // Promedio simple de los promedios diarios: aproximación suficiente para el indicador.
    const latProm = conLat.length ? redondear(conLat.reduce((a, s) => a + s.latenciaPromedio, 0) / conLat.length) : null;
    const conLogin = serie.filter((s) => s.loginPromedio !== null);
    const loginProm = conLogin.length ? redondear(conLogin.reduce((a, s) => a + s.loginPromedio, 0) / conLogin.length) : null;
    return {
      total, errores,
      tasaExito: tasaExito(total, errores),
      usuariosPico: conDato.reduce((m, s) => Math.max(m, s.usuarios), 0),
      usuariosPromedio: conDato.length ? Math.round(conDato.reduce((a, s) => a + s.usuarios, 0) / conDato.length) : 0,
      diasConDato: conDato.length,
      diasTotales: serie.length,
      latenciaPromedio: latProm,
      loginPromedio: loginProm
    };
  }

  router.get('/tablero/serie', verifyToken, requireModule('APP_MOVIL'), envolver('serie', async (req, res) => {
    const { inicio, fin, dias } = rangoDe(req.query);
    const clave = `serie|${inicio}|${fin}`;
    const datos = await conCache(clave, async () => {
      const pool = await getPool();
      const serie = await leerSerie(pool, inicio, fin);
      const inicioAnt = sumarDias(inicio, -dias);
      const finAnt = sumarDias(inicio, -1);
      const anterior = await leerSerie(pool, inicioAnt, finAnt);
      const resumen = sumarSerie(serie);
      const resumenAnt = sumarSerie(anterior);

      // Patrón por día de la semana (solo días con dato; el día de hoy, parcial, se excluye).
      const hoy = ymd(new Date());
      const nombres = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
      const acum = Array.from({ length: 7 }, () => ({ dias: 0, total: 0, errores: 0 }));
      for (const s of serie) {
        if (s.sinDato || s.dia === hoy) continue;
        const w = aFecha(s.dia).getDay();
        acum[w].dias += 1; acum[w].total += s.total; acum[w].errores += s.errores;
      }
      const semana = [1, 2, 3, 4, 5, 6, 0].map((w) => ({
        dia: nombres[w],
        diasMedidos: acum[w].dias,
        promedio: acum[w].dias ? Math.round(acum[w].total / acum[w].dias) : 0,
        tasaError: acum[w].total > 0 ? redondear((acum[w].errores / acum[w].total) * 100, 2) : null
      }));

      return {
        disponible: true,
        rango: { inicio, fin, dias },
        rangoAnterior: { inicio: inicioAnt, fin: finAnt },
        serie, anterior, resumen, resumenAnterior: resumenAnt,
        deltas: {
          total: delta(resumen.total, resumenAnt.total),
          errores: delta(resumen.errores, resumenAnt.errores),
          usuarios: delta(resumen.usuariosPromedio, resumenAnt.usuariosPromedio),
          latencia: delta(resumen.latenciaPromedio, resumenAnt.latenciaPromedio),
          login: delta(resumen.loginPromedio, resumenAnt.loginPromedio),
          tasaExitoPuntos: resumen.tasaExito !== null && resumenAnt.tasaExito !== null ? redondear(resumen.tasaExito - resumenAnt.tasaExito, 2) : null
        },
        semana,
        generado: new Date().toISOString()
      };
    });
    res.json(datos);
  }));

  // ------------------------------------------------------------------------
  // LATENCIA POR SERVICIO
  // ------------------------------------------------------------------------
  router.get('/tablero/latencia', verifyToken, requireModule('APP_MOVIL'), envolver('latencia', async (req, res) => {
    const { inicio, fin, dias } = rangoDe(req.query);
    const datos = await conCache(`lat|${inicio}|${fin}`, async () => {
      const pool = await getPool();
      const inicioAnt = sumarDias(inicio, -dias);
      const finAnt = sumarDias(inicio, -1);

      const consultaAgrupada = (a, b) => pool.query(
        `SELECT Clase, Metodo, SUM(LlamadasMedidas) AS n,
                SUM(TiempoPromedioSegundos * LlamadasMedidas) / NULLIF(SUM(LlamadasMedidas), 0) AS prom,
                MAX(TiempoMaximoSegundos) AS mx
           FROM AppMovilLatenciaDiaria WHERE Fecha BETWEEN ? AND ?
          GROUP BY Clase, Metodo HAVING n > 0`, [a, b]);

      const [[actual], [previo], [porDia], [uso]] = await Promise.all([
        consultaAgrupada(inicio, fin),
        consultaAgrupada(inicioAnt, finAnt),
        pool.query(
          `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d') AS dia, Clase, Metodo, TiempoPromedioSegundos AS prom
             FROM AppMovilLatenciaDiaria WHERE Fecha BETWEEN ? AND ? AND LlamadasMedidas > 0`, [inicio, fin]),
        pool.query(
          `SELECT Clase, Metodo, SUM(Total) AS total, SUM(Errores) AS errores
             FROM AppMovilPorFuncionalidadDiario WHERE Fecha BETWEEN ? AND ? GROUP BY Clase, Metodo`, [inicio, fin])
      ]);

      const llave = (c, m) => `${c}\u0000${m}`;
      const mapPrevio = new Map(previo.map((f) => [llave(f.Clase, f.Metodo), f]));
      const mapUso = new Map(uso.map((f) => [llave(f.Clase, f.Metodo), f]));
      const dias_ = [];
      for (let d = inicio; d <= fin; d = sumarDias(d, 1)) dias_.push(d);
      const indiceDia = new Map(dias_.map((d, i) => [d, i]));
      const mapSerie = new Map();
      for (const f of porDia) {
        const k = llave(f.Clase, f.Metodo);
        if (!mapSerie.has(k)) mapSerie.set(k, new Array(dias_.length).fill(null));
        const i = indiceDia.get(f.dia);
        if (i !== undefined) mapSerie.get(k)[i] = redondear(f.prom);
      }

      let sumaPond = 0; let llamadas = 0;
      const servicios = actual.map((f) => {
        const k = llave(f.Clase, f.Metodo);
        const n = numero(f.n);
        const prom = redondear(f.prom);
        sumaPond += numero(f.prom) * n; llamadas += n;
        const p = mapPrevio.get(k);
        const u = mapUso.get(k);
        const total = u ? numero(u.total) : 0;
        const errores = u ? numero(u.errores) : 0;
        const d = p ? delta(numero(f.prom), numero(p.prom)) : null;
        let estado = 'ok';
        if (prom >= LATENCIA_CRITICA_S) estado = 'critico';
        else if (prom >= LATENCIA_AVISO_S) estado = 'aviso';
        const empeora = d !== null && d >= 30 && n >= 30 && numero(f.prom) - numero(p.prom) >= 0.3;
        return {
          clase: f.Clase, metodo: f.Metodo,
          nombre: nombreServicioLegible ? nombreServicioLegible(f.Metodo) : f.Metodo,
          llamadasMedidas: n,
          promedio: prom,
          maximo: redondear(f.mx),
          promedioAnterior: p ? redondear(p.prom) : null,
          deltaPct: d,
          empeora,
          estado,
          total, errores, tasaExito: tasaExito(total, errores),
          serie: mapSerie.get(k) || []
        };
      }).sort((a, b) => b.llamadasMedidas - a.llamadasMedidas).slice(0, 80);

      return {
        disponible: true,
        rango: { inicio, fin, dias },
        dias: dias_,
        umbrales: { aviso: LATENCIA_AVISO_S, critico: LATENCIA_CRITICA_S },
        promedioGlobal: llamadas > 0 ? redondear(sumaPond / llamadas) : null,
        llamadasMedidas: llamadas,
        servicios
      };
    });
    res.json(datos);
  }));

  // ------------------------------------------------------------------------
  // CLIENTES
  // ------------------------------------------------------------------------
  router.get('/tablero/clientes', verifyToken, requireModule('APP_MOVIL'), envolver('clientes', async (req, res) => {
    const { inicio, fin, dias, recortado } = rangoDe(req.query, RANGO_MAX_CLIENTES_DIAS);
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 15, 5), 50);
    const datos = await conCache(`cli|${inicio}|${fin}|${limite}`, async () => {
      const pool = await getPool();
      const base = `FROM AppMovilPorClienteDiario WHERE Fecha BETWEEN ? AND ? GROUP BY Documento`;
      const [[[agg]], [masActivos], [masErrores], [mayorTasa]] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS clientes, COALESCE(SUM(errores > 0), 0) AS conErrores,
                  COALESCE(SUM(errores), 0) AS errores, COALESCE(SUM(total), 0) AS total
             FROM (SELECT Documento, SUM(Total) AS total, SUM(Errores) AS errores ${base}) t`, [inicio, fin]),
        pool.query(`SELECT Documento, SUM(Total) AS total, SUM(Errores) AS errores, COUNT(*) AS dias ${base} ORDER BY total DESC LIMIT ?`, [inicio, fin, limite]),
        pool.query(`SELECT Documento, SUM(Total) AS total, SUM(Errores) AS errores, COUNT(*) AS dias ${base} HAVING errores > 0 ORDER BY errores DESC LIMIT ?`, [inicio, fin, limite]),
        pool.query(`SELECT Documento, SUM(Total) AS total, SUM(Errores) AS errores, COUNT(*) AS dias ${base} HAVING total >= 20 AND errores > 0 ORDER BY (SUM(Errores) / SUM(Total)) DESC, errores DESC LIMIT ?`, [inicio, fin, limite])
      ]);

      const fila = (f) => ({
        documento: String(f.Documento),
        total: numero(f.total), errores: numero(f.errores), dias: numero(f.dias),
        tasaError: numero(f.total) > 0 ? redondear((numero(f.errores) / numero(f.total)) * 100, 2) : 0
      });
      const topErrores = masErrores.map(fila);
      const erroresTop10 = topErrores.slice(0, 10).reduce((a, c) => a + c.errores, 0);
      const erroresTotal = numero(agg.errores);

      return {
        disponible: true,
        rango: { inicio, fin, dias },
        recortado,
        resumen: {
          clientes: numero(agg.clientes),
          clientesConErrores: numero(agg.conErrores),
          porcentajeConErrores: numero(agg.clientes) > 0 ? redondear((numero(agg.conErrores) / numero(agg.clientes)) * 100, 1) : 0,
          transacciones: numero(agg.total),
          errores: erroresTotal,
          promedioPorCliente: numero(agg.clientes) > 0 ? redondear(numero(agg.total) / numero(agg.clientes), 1) : 0,
          concentracionTop10: erroresTotal > 0 ? redondear((erroresTop10 / erroresTotal) * 100, 1) : 0
        },
        masActivos: masActivos.map(fila),
        masErrores: topErrores,
        mayorTasaError: mayorTasa.map(fila)
      };
    });
    res.json(datos);
  }));

  // ------------------------------------------------------------------------
  // ESTADO (semáforo del ETL + hoy + alertas)
  // ------------------------------------------------------------------------
  router.get('/tablero/estado', verifyToken, requireModule('APP_MOVIL'), envolver('estado', async (req, res) => {
    const datos = await conCache('estado', async () => {
      const pool = await getPool();
      const ahora = new Date();
      const hoy = ymd(ahora);
      const nombresTabla = TABLAS.map((t) => t.tabla);

      // Existencia y tamaño aproximado (sin COUNT(*) sobre tablas grandes).
      const [info] = await pool.query(
        `SELECT TABLE_NAME AS nombre, TABLE_ROWS AS filas, (DATA_LENGTH + INDEX_LENGTH) AS bytes
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`, [nombresTabla]);
      const infoPorNombre = new Map(info.map((f) => [f.nombre, f]));

      const tablas = [];
      for (const t of TABLAS) {
        const i = infoPorNombre.get(t.tabla);
        if (!i) { tablas.push({ ...t, existe: false }); continue; }
        let minimo = null; let maximo = null;
        try {
          const [[r]] = await pool.query(
            `SELECT DATE_FORMAT(MIN(${t.columnaFecha}), '%Y-%m-%d %H:%i:%s') AS minimo, DATE_FORMAT(MAX(${t.columnaFecha}), '%Y-%m-%d %H:%i:%s') AS maximo FROM ${t.tabla}`);
          minimo = r.minimo; maximo = r.maximo;
        } catch (e) { if (!esTablaInexistente(e)) throw e; }
        tablas.push({ ...t, existe: true, filasAprox: numero(i.filas), bytes: numero(i.bytes), desde: minimo, hasta: maximo });
      }
      const existe = (n) => !!(tablas.find((t) => t.tabla === n) || {}).existe;

      // Hoy (parcial) y cobertura de los últimos 30 días.
      const desde30 = sumarDias(hoy, -29);
      let hoyFila = null;
      let cobertura = { dias: 30, conDato: 0, faltantes: [] };
      let actualizadoHoy = null;
      let tasaSemana = null;
      if (existe('AppMovilResumenDiario')) {
        const [filas] = await pool.query(
          `SELECT DATE_FORMAT(Fecha, '%Y-%m-%d') AS dia, TotalTransacciones AS total, TotalErrores AS errores, UsuariosUnicos AS usuarios,
                  DATE_FORMAT(ActualizadoEn, '%Y-%m-%d %H:%i:%s') AS actualizado
             FROM AppMovilResumenDiario WHERE Fecha BETWEEN ? AND ?`, [desde30, hoy]);
        const set = new Set(filas.map((f) => f.dia));
        const faltantes = [];
        for (let d = desde30; d <= hoy; d = sumarDias(d, 1)) if (!set.has(d)) faltantes.push(d);
        cobertura = { dias: 30, conDato: set.size, faltantes };
        const h = filas.find((f) => f.dia === hoy);
        if (h) {
          hoyFila = { total: numero(h.total), errores: numero(h.errores), usuarios: numero(h.usuarios), tasaExito: tasaExito(numero(h.total), numero(h.errores)) };
          actualizadoHoy = h.actualizado;
        }
        const semana = filas.filter((f) => f.dia >= sumarDias(hoy, -7) && f.dia < hoy);
        const tt = semana.reduce((a, f) => a + numero(f.total), 0);
        const ee = semana.reduce((a, f) => a + numero(f.errores), 0);
        tasaSemana = tasaExito(tt, ee);
      }

      // Alertas recientes.
      let alertas = { disponible: existe('AppMovilAlertaMasiva'), ultimas24h: 0, ultimos7d: 0, recientes: [] };
      if (alertas.disponible) {
        const [[c]] = await pool.query(
          `SELECT SUM(Detectada >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS d1, COUNT(*) AS d7
             FROM AppMovilAlertaMasiva WHERE Detectada >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
        const [rec] = await pool.query(
          `SELECT Id, DATE_FORMAT(Detectada, '%Y-%m-%d %H:%i:%s') AS detectada, DATE_FORMAT(UltimaVista, '%Y-%m-%d %H:%i:%s') AS ultimaVista,
                  Titulo AS titulo, Tipo AS tipo, Categoria AS categoria, Errores AS errores, Clientes AS clientes, TasaError AS tasaError, Servicio AS servicio
             FROM AppMovilAlertaMasiva ORDER BY Id DESC LIMIT 5`);
        alertas = { disponible: true, ultimas24h: numero(c.d1), ultimos7d: numero(c.d7), recientes: rec.map((r) => ({ ...r, tasaError: numero(r.tasaError) })) };
      }

      // Estado del ETL en memoria del proceso.
      const e = (typeof estadoEtl === 'function' ? estadoEtl() : null) || {};
      const edadMin = (ms) => (ms ? Math.round((Date.now() - ms) / 60000) : null);
      const etl = {
        enCurso: !!e.enCurso,
        enCursoDesde: e.enCursoDesde || null,
        ultimoInicio: e.ultimoInicio || null,
        ultimoFin: e.ultimoFin || null,
        ultimoOk: e.ultimoOk || null,
        ultimoError: e.ultimoError || null,
        ultimoErrorEn: e.ultimoErrorEn || null,
        ciclos: e.ciclos || 0,
        arrancado: e.arrancado || null,
        intervaloMin: e.intervaloMin || 5
      };

      // Semáforo.
      const items = [];
      const agregar = (clave, titulo, estado, detalle) => items.push({ clave, titulo, estado, detalle });

      // 1) Ciclo del ETL
      if (!etl.ultimoInicio) {
        agregar('etl', 'Proceso ETL', 'aviso', 'Este proceso del servidor aún no ha completado su primer ciclo (se reinició hace poco).');
      } else if (etl.ultimoError && (!etl.ultimoOk || etl.ultimoErrorEn >= etl.ultimoOk)) {
        agregar('etl', 'Proceso ETL', 'critico', `El último ciclo terminó con error: ${etl.ultimoError}`);
      } else {
        const edad = edadMin(etl.ultimoOk);
        if (etl.enCurso) agregar('etl', 'Proceso ETL', 'ok', 'Calculando en este momento.');
        else if (edad !== null && edad <= etl.intervaloMin * 3) agregar('etl', 'Proceso ETL', 'ok', `Último ciclo correcto hace ${edad} min (corre cada ${etl.intervaloMin} min).`);
        else agregar('etl', 'Proceso ETL', 'critico', `No hay un ciclo correcto desde hace ${edad ?? '—'} min.`);
      }

      // 2) Frescura de HOY
      if (!existe('AppMovilResumenDiario')) {
        agregar('hoy', 'Datos de hoy', 'critico', 'Falta la tabla AppMovilResumenDiario.');
      } else if (!actualizadoHoy) {
        agregar('hoy', 'Datos de hoy', ahora.getHours() === 0 && ahora.getMinutes() < 15 ? 'aviso' : 'critico', 'Todavía no hay fila de hoy en el resumen diario.');
      } else {
        const edad = Math.round((Date.now() - new Date(actualizadoHoy.replace(' ', 'T')).getTime()) / 60000);
        const estado = edad <= 15 ? 'ok' : (edad <= 45 ? 'aviso' : 'critico');
        agregar('hoy', 'Datos de hoy', estado, `Actualizados hace ${Math.max(0, edad)} min.`);
      }

      // 3) Cobertura
      {
        const f = cobertura.faltantes.length;
        const sinHoy = cobertura.faltantes.filter((d) => d !== hoy);
        if (!existe('AppMovilResumenDiario')) agregar('cobertura', 'Cobertura de 30 días', 'critico', 'Sin tabla de resumen.');
        else if (sinHoy.length === 0) agregar('cobertura', 'Cobertura de 30 días', 'ok', `${cobertura.conDato} de ${cobertura.dias} días completos.`);
        else if (sinHoy.length <= 3) agregar('cobertura', 'Cobertura de 30 días', 'aviso', `Faltan ${sinHoy.length} día(s): ${sinHoy.slice(0, 3).join(', ')}. El relleno avanza solo, 5 días por ciclo.`);
        else agregar('cobertura', 'Cobertura de 30 días', 'aviso', `Faltan ${f} días; el relleno histórico sigue en marcha.`);
      }

      // 4) Latencia
      {
        const t = tablas.find((x) => x.tabla === 'AppMovilLatenciaDiaria');
        if (!t || !t.existe) agregar('latencia', 'Latencia por servicio', 'aviso', 'Falta la tabla AppMovilLatenciaDiaria: no se puede medir tiempos de respuesta.');
        else if (t.hasta && t.hasta.slice(0, 10) >= sumarDias(hoy, -1)) agregar('latencia', 'Latencia por servicio', 'ok', `Medida hasta el ${t.hasta.slice(0, 10)}.`);
        else agregar('latencia', 'Latencia por servicio', 'aviso', `Último dato medido: ${t.hasta ? t.hasta.slice(0, 10) : 'ninguno'}.`);
      }

      // 5) Por cliente
      {
        const t = tablas.find((x) => x.tabla === 'AppMovilPorClienteDiario');
        if (!t || !t.existe) agregar('clientes', 'Actividad por cliente', 'aviso', 'Falta la tabla AppMovilPorClienteDiario: no hay ranking de clientes.');
        else if (t.hasta && t.hasta.slice(0, 10) >= sumarDias(hoy, -1)) agregar('clientes', 'Actividad por cliente', 'ok', `Datos hasta el ${t.hasta.slice(0, 10)}.`);
        else agregar('clientes', 'Actividad por cliente', 'aviso', `Último dato: ${t.hasta ? t.hasta.slice(0, 10) : 'ninguno'}.`);
      }

      // 6) Versiones
      {
        const t = tablas.find((x) => x.tabla === 'AppMovilVersionDiaria');
        if (!t || !t.existe) agregar('versiones', 'Adopción de versiones', 'aviso', 'Faltan las tablas de versiones.');
        else if (t.hasta && t.hasta.slice(0, 10) >= sumarDias(hoy, -1)) agregar('versiones', 'Adopción de versiones', 'ok', `Datos hasta el ${t.hasta.slice(0, 10)}.`);
        else agregar('versiones', 'Adopción de versiones', 'aviso', `Último día calculado: ${t.hasta ? t.hasta.slice(0, 10) : 'ninguno'}.`);
      }

      // 7) Alertas
      if (!alertas.disponible) agregar('alertas', 'Vigilancia de errores masivos', 'aviso', 'Falta la tabla AppMovilAlertaMasiva: las alertas no quedan guardadas.');
      else if (alertas.ultimas24h > 0) agregar('alertas', 'Vigilancia de errores masivos', 'aviso', `${alertas.ultimas24h} alerta(s) en las últimas 24 horas.`);
      else agregar('alertas', 'Vigilancia de errores masivos', 'ok', 'Sin alertas en las últimas 24 horas.');

      const orden = { ok: 0, aviso: 1, critico: 2 };
      const peor = items.reduce((m, i) => (orden[i.estado] > orden[m] ? i.estado : m), 'ok');

      return {
        disponible: true,
        generado: ahora.toISOString(),
        semaforo: peor,
        items,
        etl,
        hoy: hoyFila ? { ...hoyFila, actualizado: actualizadoHoy, tasaSemanaAnterior: tasaSemana } : null,
        cobertura,
        tablas,
        alertas
      };
    });
    res.json(datos);
  }));
};
