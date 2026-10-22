// Informe de Pasos a Producción: volumen, resultado (ejecutado / rollback /
// cancelado / reagendado), puntualidad y duración de los despliegues.
// Respeta la privacidad de la bitácora: solo cuenta lo que el usuario que lo
// pide puede ver (por eso este informe no se programa por correo).
const K = require('../kit');
const { getPool } = require('../../../db');
const acceso = require('../../bitacoraAcceso');

const SEL = `SELECT p.Id, p.Rfc, p.Titulo, p.Entorno, p.Estado, p.FechaHoraProgramada, p.FechaHoraEstimadaFin, p.FechaHoraInicioReal, p.FechaHoraFinReal,
  p.MotivoEstado, ucr.nombre_completo AS Creador, uej.nombre_completo AS Ejecutor, ia.nombre_aplicacion AS Aplicativo
  FROM PasosProduccion p
  INNER JOIN usuarios ucr ON ucr.id = p.CreadoPorId
  LEFT JOIN usuarios uej ON uej.id = p.EjecutadoPorId
  LEFT JOIN vw_inventario_aplicativos ia ON ia.id = p.AplicativoId`;

const mas = (fecha, dias) => { const x = new Date(`${fecha}T00:00:00`); x.setDate(x.getDate() + dias); return K.F.isoFecha(x); };
const min = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);
const ESTADO_TXT = { PROGRAMADO: 'Programado', EJECUTADO: 'Ejecutado', CANCELADO: 'Cancelado', REAGENDADO: 'Reagendado', ROLLBACK: 'Rollback' };
const COL_ESTADO = { Ejecutado: '#16a34a', Programado: '#0ea5e9', Reagendado: '#d97706', Cancelado: '#64748b', Rollback: '#dc2626' };

async function armar({ desde, hasta, usuario }) {
  const pool = await getPool();
  const dias = Math.round((new Date(`${hasta}T00:00:00`) - new Date(`${desde}T00:00:00`)) / 86400000) + 1;
  const antHasta = mas(desde, -1); const antDesde = mas(antHasta, -(dias - 1));
  const vis = await acceso.condicionVisible(pool, 'p', usuario);
  const leer = async (a, b) => (await pool.query(`${SEL} WHERE p.FechaHoraProgramada BETWEEN ? AND ? AND ${vis.sql} ORDER BY p.FechaHoraProgramada DESC`, [`${a} 00:00:00`, `${b} 23:59:59`, ...vis.params]))[0];
  const [filas, ant] = await Promise.all([leer(desde, hasta), leer(antDesde, antHasta)]);

  const cuenta = (rows, e) => rows.filter((x) => x.Estado === e).length;
  const ej = cuenta(filas, 'EJECUTADO'); const rb = cuenta(filas, 'ROLLBACK'); const ca = cuenta(filas, 'CANCELADO'); const re = cuenta(filas, 'REAGENDADO'); const pr = cuenta(filas, 'PROGRAMADO');
  const ejA = cuenta(ant, 'EJECUTADO'); const rbA = cuenta(ant, 'ROLLBACK');
  const resueltos = ej + rb; const resueltosA = ejA + rbA;
  const exito = resueltos ? K.porcentaje(ej, resueltos) : null;
  const exitoA = resueltosA ? K.porcentaje(ejA, resueltosA) : null;
  const ejecutados = filas.filter((x) => x.Estado === 'EJECUTADO');
  const durac = ejecutados.map((x) => min(x.FechaHoraInicioReal, x.FechaHoraFinReal)).filter((v) => v !== null && v >= 0);
  const durProm = durac.length ? Math.round(K.promedio(durac)) : null;
  const retraso = ejecutados.map((x) => min(x.FechaHoraProgramada, x.FechaHoraInicioReal)).filter((v) => v !== null);
  const retProm = retraso.length ? Math.round(K.promedio(retraso)) : null;
  const sobre = ejecutados.map((x) => { const real = min(x.FechaHoraInicioReal, x.FechaHoraFinReal); const est = min(x.FechaHoraProgramada, x.FechaHoraEstimadaFin); return real !== null && est ? real - est : null; }).filter((v) => v !== null);
  const pasadoEst = sobre.filter((v) => v > 15).length;
  const prod = filas.filter((x) => x.Entorno === 'PRODUCCION');
  const rbProd = prod.filter((x) => x.Estado === 'ROLLBACK').length;

  const conteo = (rows, campo, vacio = 'Sin asignar') => {
    const m = new Map();
    rows.forEach((x) => { const k = (x[campo] && String(x[campo]).trim()) || vacio; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].map(([nombre, total]) => ({ nombre, total })).sort((a, b) => b.total - a.total);
  };

  const kpis = [
    K.kpi('Pasos programados', filas.length, { delta: K.delta(filas.length, ant.length) }),
    K.kpi('Ejecutados', ej, { tono: 'ok', delta: K.delta(ej, ejA) }),
    K.kpi('Tasa de éxito', exito, { fmt: 'pct', tono: exito === null ? null : exito >= 95 ? 'ok' : exito >= 85 ? 'warn' : 'danger', nota: resueltos ? `${ej} de ${resueltos} ejecuciones` : 'Sin ejecuciones', delta: K.delta(exito, exitoA, { puntos: true }) }),
    K.kpi('Rollbacks', rb, { tono: rb ? 'danger' : 'ok', delta: K.delta(rb, rbA, { mejorSiBaja: true }) }),
    K.kpi('Cancelados / reagendados', `${ca} / ${re}`, { fmt: 'txt', tono: ca + re ? 'warn' : 'ok' }),
    K.kpi('Duración promedio', durProm, { fmt: 'n', nota: durProm === null ? 'Sin datos' : 'minutos por despliegue' }),
  ];
  const h = [];
  if (rbProd) h.push(K.hallazgo('critico', `${rbProd} ${rbProd === 1 ? 'rollback' : 'rollbacks'} en producción`, filas.filter((x) => x.Estado === 'ROLLBACK' && x.Entorno === 'PRODUCCION').slice(0, 3).map((x) => x.Titulo).join(' · ')));
  else if (rb) h.push(K.hallazgo('aviso', `${rb} ${rb === 1 ? 'rollback' : 'rollbacks'} en el periodo`, 'Ninguno fue en producción.'));
  if (exito !== null && exito < 90) h.push(K.hallazgo(exito < 80 ? 'critico' : 'aviso', `La tasa de éxito es del ${K.F.num(exito, 1)} %`, exitoA === null ? '' : `Antes era del ${K.F.num(exitoA, 1)} %.`));
  if (ca + re > 0 && filas.length && (ca + re) / filas.length >= 0.25) h.push(K.hallazgo('aviso', `${ca + re} pasos cancelados o reagendados (${K.F.num(K.porcentaje(ca + re, filas.length), 0)} %)`, 'Una proporción alta suele indicar planeación o dependencias que no se cumplen.'));
  if (pasadoEst > 0) h.push(K.hallazgo('info', `${pasadoEst} despliegues tardaron más de lo estimado`, `Más de 15 minutos sobre la hora estimada de fin.`));
  if (retProm !== null && retProm > 20) h.push(K.hallazgo('info', `Los pasos arrancan ${retProm} minutos tarde en promedio`));
  const vencidos = filas.filter((x) => x.Estado === 'PROGRAMADO' && new Date(x.FechaHoraProgramada) < new Date());
  if (vencidos.length) h.push(K.hallazgo('aviso', `${vencidos.length} pasos siguen "Programado" con fecha ya vencida`, 'Actualiza su estado (ejecutado, cancelado o reagendado).'));
  const ap = conteo(filas, 'Aplicativo')[0];
  if (ap && filas.length >= 5) h.push(K.hallazgo('info', `${ap.nombre} es el aplicativo con más pasos`, `${ap.total} de ${filas.length}.`));
  if (!filas.length) h.push(K.hallazgo('info', 'No hay pasos a producción en el periodo'));
  else if (!h.some((x) => x.nivel === 'critico' || x.nivel === 'aviso')) h.unshift(K.hallazgo('ok', 'Los despliegues del periodo salieron sin rollbacks ni incidentes'));

  const porDia = new Map();
  filas.forEach((x) => { const k = K.F.isoFecha(x.FechaHoraProgramada); porDia.set(k, (porDia.get(k) || 0) + 1); });
  const dd = []; for (let i = 0; i < dias && i < 120; i++) { const f = mas(desde, i); dd.push({ f, n: porDia.get(f) || 0 }); }
  const estados = Object.keys(ESTADO_TXT).map((k) => ({ k, n: cuenta(filas, k) })).filter((x) => x.n);
  const entornos = conteo(filas, 'Entorno').map((e) => ({ nombre: e.nombre === 'PRODUCCION' ? 'Producción' : e.nombre === 'QA' ? 'QA' : 'Desarrollo', total: e.total }));

  const colsPaso = [
    { campo: 'Rfc', etiqueta: 'RFC', peso: 1.4 }, { campo: 'Titulo', etiqueta: 'Título', peso: 4 }, { campo: 'Aplicativo', etiqueta: 'Aplicativo', peso: 2.2 },
    { campo: 'Entorno', etiqueta: 'Entorno', peso: 1.4, tonos: { Producción: 'brand' } },
    { campo: 'EstadoTxt', etiqueta: 'Estado', peso: 1.4, tonos: { Rollback: 'danger', Cancelado: 'warn', Reagendado: 'warn', Ejecutado: 'ok' } },
    { campo: 'FechaHoraProgramada', etiqueta: 'Programado', tipo: 'fechahora' },
    { campo: 'duracion', etiqueta: 'Duración (min)', tipo: 'num', fmt: 'n', peso: 1.2 },
    { campo: 'Ejecutor', etiqueta: 'Ejecutó', peso: 2 },
  ];
  const mapa = (x) => ({ ...x, EstadoTxt: ESTADO_TXT[x.Estado] || x.Estado, Entorno: x.Entorno === 'PRODUCCION' ? 'Producción' : x.Entorno === 'QA' ? 'QA' : 'Desarrollo', Aplicativo: x.Aplicativo || 'Sin asignar', Ejecutor: x.Ejecutor || '—', duracion: min(x.FechaHoraInicioReal, x.FechaHoraFinReal) });
  const secciones = [
    K.seccion('Resultado de los despliegues', filas.length ? [
      K.grafico({ forma: 'dona', titulo: 'Pasos por estado', etiquetas: estados.map((e) => ESTADO_TXT[e.k]), series: [{ nombre: 'Pasos', valores: estados.map((e) => e.n) }], colores: estados.map((e) => COL_ESTADO[ESTADO_TXT[e.k]]), ancho: 'medio' }),
      K.grafico({ forma: 'barrasH', titulo: 'Pasos por entorno', etiquetas: entornos.map((e) => e.nombre), series: [{ nombre: 'Pasos', valores: entornos.map((e) => e.total), color: '#673ab7' }], ancho: 'medio' }),
      K.grafico({ forma: 'barras', titulo: 'Pasos programados por día', etiquetas: dd.map((x) => K.F.fechaCorta(x.f)), series: [{ nombre: 'Pasos', valores: dd.map((x) => x.n), color: '#673ab7' }] }),
      K.rankingH('Aplicativos con más pasos', conteo(filas, 'Aplicativo'), { color: '#0ea5e9', ancho: 'medio', nombreSerie: 'Pasos' }),
      K.rankingH('Quién ejecuta más pasos', conteo(ejecutados, 'Ejecutor', '—'), { color: '#16a34a', ancho: 'medio', nombreSerie: 'Ejecutados' }),
    ] : []),
    K.seccion('Rollbacks, cancelaciones y reagendamientos', [
      K.tabla({ titulo: 'Pasos con problemas', hoja: 'Con problemas', descripcion: 'Incluye el motivo registrado.', columnas: [...colsPaso.slice(0, 6), { campo: 'MotivoEstado', etiqueta: 'Motivo', peso: 4 }], filas: filas.filter((x) => ['ROLLBACK', 'CANCELADO', 'REAGENDADO'].includes(x.Estado)).map(mapa), vacio: 'No hubo rollbacks, cancelaciones ni reagendamientos.' }),
    ]),
    K.seccion('Detalle', [K.tabla({ titulo: 'Todos los pasos del periodo', hoja: 'Pasos', columnas: colsPaso, filas: filas.map(mapa), vacio: 'No hay pasos en este periodo.' })]),
  ];
  return K.informe({
    clave: 'pasos', titulo: 'Informe de Pasos a Producción', subtitulo: 'Despliegues, resultados, puntualidad y duración',
    periodo: { desde, hasta }, kpis, hallazgos: h, secciones,
    notas: ['Solo incluye los pasos que tu usuario puede ver en la bitácora. La tasa de éxito = ejecutados / (ejecutados + rollbacks). El periodo filtra por fecha programada.'],
  });
}
module.exports = { armar };
