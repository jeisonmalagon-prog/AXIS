// Informe de la App Móvil. Lee SOLO las tablas de resumen del ETL (nunca
// LogApp), así que es rápido y seguro de programar por correo.
const K = require('../kit');
const { getPool } = require('../../../db');

const iso = (d) => K.F.isoFecha(d);
const mas = (fecha, dias) => { const x = new Date(`${fecha}T00:00:00`); x.setDate(x.getDate() + dias); return iso(x); };
const sinTabla = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(e.message || ''));
const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

async function armar({ desde, hasta }) {
  const { nombreServicioLegible } = require('../../../routes/appMovil');
  const pool = await getPool();
  const dias = Math.round((new Date(`${hasta}T00:00:00`) - new Date(`${desde}T00:00:00`)) / 86400000) + 1;
  const antHasta = mas(desde, -1); const antDesde = mas(antHasta, -(dias - 1));

  let diario; let diarioAnt;
  try {
    const q = `SELECT Fecha, TotalTransacciones AS tx, TotalErrores AS err, UsuariosUnicos AS usuarios, SesionesDistintas AS sesiones FROM AppMovilResumenDiario WHERE Fecha BETWEEN ? AND ? ORDER BY Fecha`;
    [[diario], [diarioAnt]] = await Promise.all([pool.query(q, [desde, hasta]), pool.query(q, [antDesde, antHasta])]);
  } catch (e) {
    if (sinTabla(e)) return K.informe({ clave: 'appmovil', titulo: 'Informe de la App Móvil', subtitulo: 'Datos no disponibles', periodo: { desde, hasta }, hallazgos: [K.hallazgo('aviso', 'Todavía no existen las tablas del ETL de la app móvil', 'Ejecuta el script SQL del ETL para empezar a generar este informe.')] });
    throw e;
  }
  const lat = (a, b) => `SELECT Clase, Metodo, SUM(LlamadasMedidas) AS llamadas, SUM(LlamadasMedidas * TiempoPromedioSegundos) / NULLIF(SUM(LlamadasMedidas), 0) AS prom, MAX(TiempoMaximoSegundos) AS maximo FROM AppMovilLatenciaDiaria WHERE Fecha BETWEEN '${a}' AND '${b}' AND LlamadasMedidas > 0 GROUP BY Clase, Metodo`;
  const seguro = async (sql, params = []) => { try { return (await pool.query(sql, params))[0]; } catch (e) { if (sinTabla(e)) return []; throw e; } };
  const [latAct, latAnt, func, disp, ver, alertas, clientes] = await Promise.all([
    seguro(lat(desde, hasta)), seguro(lat(antDesde, antHasta)),
    seguro('SELECT Clase, Metodo, SUM(Total) AS total, SUM(Errores) AS errores FROM AppMovilPorFuncionalidadDiario WHERE Fecha BETWEEN ? AND ? GROUP BY Clase, Metodo', [desde, hasta]),
    seguro('SELECT Dispositivo, SUM(Total) AS total, SUM(Errores) AS errores FROM AppMovilPorDispositivoDiario WHERE Fecha BETWEEN ? AND ? GROUP BY Dispositivo ORDER BY total DESC', [desde, hasta]),
    seguro('SELECT Version, Plataforma, Clientes FROM AppMovilVersionDiaria WHERE Fecha = (SELECT MAX(Fecha) FROM AppMovilVersionDiaria WHERE Fecha <= ?)', [hasta]),
    seguro('SELECT Detectada, Titulo, Tipo, Categoria, Errores, Clientes, TasaError, Servicio FROM AppMovilAlertaMasiva WHERE Detectada BETWEEN ? AND ? ORDER BY Detectada DESC LIMIT 200', [`${desde} 00:00:00`, `${hasta} 23:59:59`]),
    seguro(`SELECT Documento, SUM(Total) AS total, SUM(Errores) AS errores FROM AppMovilPorClienteDiario WHERE Fecha BETWEEN ? AND ? GROUP BY Documento ORDER BY total DESC LIMIT 15`, [mas(hasta, -30) > desde ? mas(hasta, -30) : desde, hasta]),
  ]);

  const suma = (rows, c) => K.suma(rows, (x) => x[c]);
  const tx = suma(diario, 'tx'); const err = suma(diario, 'err');
  const txA = suma(diarioAnt, 'tx'); const errA = suma(diarioAnt, 'err');
  const efe = tx ? +(100 - (err / tx) * 100).toFixed(2) : null;
  const efeA = txA ? +(100 - (errA / txA) * 100).toFixed(2) : null;
  // Día en curso: sus transacciones son parciales, no cuentan para promedios.
  const hoyIso = iso(new Date());
  const diasCompletos = diario.filter((x) => iso(x.Fecha) !== hoyIso);
  const usuariosProm = diasCompletos.length ? Math.round(K.promedio(diasCompletos, (x) => x.usuarios)) : null;
  const usuariosPico = diario.reduce((m, x) => Math.max(m, K.n0(x.usuarios)), 0);

  // Latencia por servicio con comparación contra el periodo anterior.
  const mapAnt = new Map(latAnt.map((x) => [`${x.Clase}.${x.Metodo}`, Number(x.prom)]));
  const servicios = latAct.map((x) => {
    const clave = `${x.Clase}.${x.Metodo}`; const prom = Number(x.prom); const ant = mapAnt.get(clave);
    const f = func.find((y) => y.Clase === x.Clase && y.Metodo === x.Metodo);
    return { servicio: nombreServicioLegible(x.Metodo), tecnico: clave, llamadas: Number(x.llamadas), prom: K.redondo(prom, 2), maximo: K.redondo(Number(x.maximo), 2), cambio: ant ? K.cambioPct(prom, ant) : null, errores: f ? Number(f.errores) : null, estado: prom >= 5 ? 'Crítico' : prom >= 2.5 ? 'Lento' : 'Normal' };
  }).sort((a, b) => b.prom - a.prom);
  const lentos = servicios.filter((s) => s.estado !== 'Normal');
  const empeoran = servicios.filter((s) => s.cambio !== null && s.cambio >= 25 && s.prom >= 1 && s.llamadas >= 200);
  const llamTot = suma(latAct, 'llamadas');
  const latGlobal = llamTot ? latAct.reduce((a, x) => a + Number(x.llamadas) * Number(x.prom), 0) / llamTot : null;
  const llamTotA = suma(latAnt, 'llamadas');
  const latGlobalA = llamTotA ? latAnt.reduce((a, x) => a + Number(x.llamadas) * Number(x.prom), 0) / llamTotA : null;

  const funcionalidades = func.map((x) => ({ funcionalidad: nombreServicioLegible(x.Metodo), tecnico: `${x.Clase}.${x.Metodo}`, total: Number(x.total), errores: Number(x.errores), tasa: Number(x.total) ? K.redondo((Number(x.errores) / Number(x.total)) * 100, 2) : null, efectividad: Number(x.total) ? K.redondo(100 - (Number(x.errores) / Number(x.total)) * 100, 2) : null }))
    .sort((a, b) => b.total - a.total);
  const peorTasa = funcionalidades.filter((f) => f.total >= 500).sort((a, b) => b.tasa - a.tasa)[0];

  // Día con peor tasa de error
  const tasasDia = diasCompletos.filter((x) => x.tx > 0).map((x) => ({ f: iso(x.Fecha), tasa: (x.err / x.tx) * 100, err: x.err }));
  const tasaMedia = tasasDia.length ? K.promedio(tasasDia, (x) => x.tasa) : null;
  const peorDia = tasasDia.slice().sort((a, b) => b.tasa - a.tasa)[0];

  const totDisp = suma(disp, 'total');
  const totVer = suma(ver, 'Clientes');
  const porVersion = new Map();
  ver.forEach((v) => porVersion.set(v.Version, (porVersion.get(v.Version) || 0) + Number(v.Clientes)));
  const versiones = [...porVersion.entries()].map(([nombre, total]) => ({ nombre, total })).sort((a, b) => b.total - a.total);
  const cmpVer = (a, b) => { const pa = a.split('.').map(Number); const pb = b.split('.').map(Number); for (let i = 0; i < 4; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); } return 0; };
  const masReciente = versiones.map((v) => v.nombre).sort(cmpVer)[0];

  const top10 = clientes.slice(0, 10); const txTop10 = suma(top10, 'total'); const txClientes = tx;
  const concentracion = txClientes ? K.porcentaje(txTop10, txClientes) : null;
  const mask = (d) => { const t = String(d || ''); return t.length <= 4 ? t : '•'.repeat(t.length - 4) + t.slice(-4); };

  // Patrón por día de la semana (solo días completos)
  const sem = Array.from({ length: 7 }, () => ({ n: 0, tx: 0 }));
  diasCompletos.forEach((x) => { const w = new Date(`${iso(x.Fecha)}T00:00:00`).getDay(); sem[w].n += 1; sem[w].tx += x.tx; });
  const ordenSem = [1, 2, 3, 4, 5, 6, 0];

  const kpis = [
    K.kpi('Transacciones', tx, { fmt: 'compacto', delta: K.delta(tx, txA) }),
    K.kpi('Efectividad', efe, { fmt: 'pct', tono: efe === null ? null : efe >= 98 ? 'ok' : efe >= 95 ? 'warn' : 'danger', delta: K.delta(efe, efeA, { puntos: true, etiqueta: 'vs. periodo anterior' }) }),
    K.kpi('Errores', err, { fmt: 'n', tono: err ? 'danger' : 'ok', delta: K.delta(err, errA, { mejorSiBaja: true }) }),
    K.kpi('Usuarios por día (prom.)', usuariosProm, { fmt: 'n', nota: usuariosPico ? `Pico: ${K.F.num(usuariosPico)}` : null }),
    K.kpi('Latencia media', latGlobal === null ? null : K.redondo(latGlobal, 2), { fmt: 'seg', tono: latGlobal === null ? null : latGlobal >= 5 ? 'danger' : latGlobal >= 2.5 ? 'warn' : null, delta: K.delta(latGlobal, latGlobalA, { mejorSiBaja: true }) }),
    K.kpi('Alertas masivas', alertas.length, { fmt: 'n', tono: alertas.length ? 'warn' : 'ok' }),
  ];

  const h = [];
  if (efe !== null && efeA !== null && efe - efeA <= -0.5) h.push(K.hallazgo(efe - efeA <= -1.5 ? 'critico' : 'aviso', `La efectividad bajó ${K.F.num(Math.abs(efe - efeA), 2)} puntos`, `${K.F.num(efe, 2)} % frente a ${K.F.num(efeA, 2)} % del periodo anterior.`));
  if (peorDia && tasaMedia && peorDia.tasa >= tasaMedia * 1.6 && peorDia.tasa - tasaMedia >= 1) h.push(K.hallazgo('aviso', `El ${K.F.fechaLarga(peorDia.f)} la tasa de error subió a ${K.F.num(peorDia.tasa, 1)} %`, `Casi el doble del promedio del periodo (${K.F.num(tasaMedia, 1)} %): ${K.F.num(peorDia.err)} errores ese día.`));
  if (lentos.length) h.push(K.hallazgo(lentos.some((s) => s.estado === 'Crítico') ? 'critico' : 'aviso', `${lentos.length} ${lentos.length === 1 ? 'servicio responde' : 'servicios responden'} lento`, lentos.slice(0, 3).map((s) => `${s.servicio} (${K.F.segundos(s.prom)})`).join(', ') + '.'));
  if (empeoran.length) h.push(K.hallazgo('aviso', `${empeoran.length} ${empeoran.length === 1 ? 'servicio empeoró' : 'servicios empeoraron'} su tiempo de respuesta`, empeoran.slice(0, 3).map((s) => `${s.servicio} (+${s.cambio} %)`).join(', ') + ' frente al periodo anterior.'));
  if (peorTasa && peorTasa.tasa >= 3) h.push(K.hallazgo(peorTasa.tasa >= 8 ? 'critico' : 'aviso', `${peorTasa.funcionalidad} tiene la mayor tasa de error: ${K.F.num(peorTasa.tasa, 1)} %`, `${K.F.num(peorTasa.errores)} errores en ${K.F.num(peorTasa.total)} transacciones.`));
  if (alertas.length) h.push(K.hallazgo('aviso', `${alertas.length} ${alertas.length === 1 ? 'alerta masiva' : 'alertas masivas'} en el periodo`, `La más reciente: ${alertas[0].Titulo} (${K.F.fechaHora(alertas[0].Detectada)}).`));
  if (txA && tx) { const c = K.cambioPct(tx, txA); if (c !== null && Math.abs(c) >= 15) h.push(K.hallazgo('info', `El tráfico ${c > 0 ? 'creció' : 'cayó'} ${Math.abs(c)} %`, `${K.F.num(tx)} transacciones frente a ${K.F.num(txA)} del periodo anterior.`)); }
  if (concentracion !== null && concentracion >= 25) h.push(K.hallazgo('info', `Los 10 clientes más activos generan el ${K.F.num(concentracion, 0)} % del tráfico`, 'Un uso muy concentrado puede indicar procesos automáticos o clientes empresariales.'));
  if (masReciente && totVer) { const p = K.porcentaje(porVersion.get(masReciente), totVer); h.push(K.hallazgo(p >= 70 ? 'ok' : 'info', `${K.F.num(p, 0)} % de los clientes usa la versión más reciente (${masReciente})`, p < 70 ? 'Todavía hay una parte importante de clientes en versiones anteriores.' : '')); }
  const faltan = dias - diario.length - (diario.some((x) => iso(x.Fecha) === hoyIso) ? 0 : 0);
  if (diario.length && faltan > 0) h.push(K.hallazgo('info', `Faltan datos de ${faltan} ${faltan === 1 ? 'día' : 'días'} en el periodo`, 'El ETL no había calculado esos días; las cifras pueden quedar por debajo.'));
  if (!diario.length) h.push(K.hallazgo('aviso', 'No hay datos del ETL en el periodo', 'Revisa que el cálculo automático esté corriendo.'));
  if (!h.some((x) => x.nivel === 'critico' || x.nivel === 'aviso') && diario.length) h.unshift(K.hallazgo('ok', 'La app móvil operó con normalidad', 'Sin caídas de efectividad, servicios lentos ni alertas masivas.'));

  const et = diario.map((x) => K.F.fechaCorta(x.Fecha));
  const colNum = (campo, etiqueta, fmt = 'n', extra = {}) => ({ campo, etiqueta, tipo: 'num', fmt, ...extra });
  const secciones = [
    K.seccion('Tráfico y efectividad', diario.length ? [
      K.grafico({ forma: 'linea', titulo: 'Transacciones por día', etiquetas: et, series: [{ nombre: 'Transacciones', valores: diario.map((x) => x.tx), color: '#673ab7' }], fmt: 'compacto' }),
      K.grafico({ forma: 'linea', titulo: 'Efectividad diaria (%)', etiquetas: et, series: [{ nombre: 'Efectividad', valores: diario.map((x) => (x.tx ? +(100 - (x.err / x.tx) * 100).toFixed(2) : null)), color: '#16a34a' }], fmt: 'pct', ancho: 'medio' }),
      K.grafico({ forma: 'barras', titulo: 'Errores por día', etiquetas: et, series: [{ nombre: 'Errores', valores: diario.map((x) => x.err), color: '#dc2626' }], fmt: 'compacto', ancho: 'medio' }),
      K.grafico({ forma: 'barras', titulo: 'Tráfico promedio por día de la semana', etiquetas: ordenSem.map((i) => DIAS_SEMANA[i]), series: [{ nombre: 'Transacciones', valores: ordenSem.map((i) => (sem[i].n ? Math.round(sem[i].tx / sem[i].n) : null)), color: '#0ea5e9' }], fmt: 'compacto', ancho: 'medio' }),
      K.grafico({ forma: 'linea', titulo: 'Usuarios únicos por día', etiquetas: et, series: [{ nombre: 'Usuarios', valores: diario.map((x) => x.usuarios), color: '#0d9488' }], fmt: 'compacto', ancho: 'medio' }),
    ] : []),
    K.seccion('Servicios y tiempos de respuesta', servicios.length ? [
      K.rankingH('Servicios más lentos (promedio)', servicios.slice(0, 10).map((s) => ({ nombre: s.servicio, total: s.prom })), { fmt: 'seg', color: '#d97706' }),
      K.tabla({
        titulo: 'Latencia por servicio', hoja: 'Latencia',
        descripcion: 'Umbrales: lento desde 2,5 s y crítico desde 5 s. El cambio compara con el periodo anterior.',
        columnas: [{ campo: 'servicio', etiqueta: 'Servicio', peso: 3 }, colNum('llamadas', 'Llamadas medidas'), colNum('prom', 'Promedio', 'seg', { umbral: { aviso: 2.5, critico: 5 } }), colNum('maximo', 'Máximo', 'seg'), colNum('cambio', 'Cambio %', 'n', { umbral: { aviso: 25, critico: 60 } }), { campo: 'estado', etiqueta: 'Estado', tonos: { Crítico: 'danger', Lento: 'warn', Normal: 'ok' }, peso: 1.2 }],
        filas: servicios,
      }),
    ] : []),
    K.seccion('Funcionalidades', funcionalidades.length ? [
      K.tabla({
        titulo: 'Uso y efectividad por funcionalidad', hoja: 'Funcionalidades', maxFilas: 500,
        columnas: [{ campo: 'funcionalidad', etiqueta: 'Funcionalidad', peso: 3 }, { campo: 'tecnico', etiqueta: 'Clase.Método', peso: 3 }, colNum('total', 'Transacciones', 'n', { barra: true }), colNum('errores', 'Errores'), colNum('tasa', 'Tasa de error', 'pct', { umbral: { aviso: 3, critico: 8 } }), colNum('efectividad', 'Efectividad', 'pct')],
        filas: funcionalidades,
      }),
    ] : []),
    K.seccion('Dispositivos y versiones', [
      disp.length ? K.grafico({ forma: 'dona', titulo: 'Transacciones por dispositivo', etiquetas: disp.map((x) => x.Dispositivo), series: [{ nombre: 'Transacciones', valores: disp.map((x) => Number(x.total)) }], ancho: 'medio' }) : null,
      versiones.length ? K.grafico({ forma: 'barrasH', titulo: 'Clientes por versión (última foto)', etiquetas: versiones.slice(0, 8).map((x) => x.nombre), series: [{ nombre: 'Clientes', valores: versiones.slice(0, 8).map((x) => x.total), color: '#673ab7' }], fmt: 'n', ancho: 'medio' }) : null,
      disp.length ? K.tabla({ titulo: 'Detalle por dispositivo', hoja: 'Dispositivos', columnas: [{ campo: 'dispositivo', etiqueta: 'Dispositivo', peso: 3 }, colNum('total', 'Transacciones', 'n', { barra: true }), colNum('errores', 'Errores'), colNum('tasa', 'Tasa de error', 'pct', { umbral: { aviso: 3, critico: 8 } }), colNum('participacion', 'Participación', 'pct')], filas: disp.map((x) => ({ dispositivo: x.Dispositivo, total: Number(x.total), errores: Number(x.errores), tasa: Number(x.total) ? K.redondo((Number(x.errores) / Number(x.total)) * 100, 2) : null, participacion: totDisp ? K.redondo((Number(x.total) / totDisp) * 100, 1) : null })) }) : null,
    ]),
    K.seccion('Alertas masivas', [
      K.tabla({
        titulo: 'Alertas detectadas en el periodo', hoja: 'Alertas masivas',
        columnas: [{ campo: 'Detectada', etiqueta: 'Detectada', tipo: 'fechahora' }, { campo: 'Titulo', etiqueta: 'Alerta', peso: 4 }, { campo: 'Servicio', etiqueta: 'Servicio', peso: 2 }, { campo: 'Categoria', etiqueta: 'Categoría', peso: 1.4 }, colNum('Errores', 'Errores'), colNum('Clientes', 'Clientes'), colNum('tasa', 'Tasa de error', 'pct', { umbral: { aviso: 10, critico: 25 } })],
        filas: alertas.map((a) => ({ ...a, tasa: K.redondo(Number(a.TasaError) * 100, 1) })), vacio: 'No hubo alertas masivas en este periodo.',
      }),
    ]),
    K.seccion('Clientes más activos', clientes.length ? [
      K.tabla({
        titulo: 'Top de clientes por transacciones (últimos 31 días del periodo)', hoja: 'Clientes', descripcion: 'Los documentos aparecen enmascarados: solo se ven los últimos 4 dígitos.',
        columnas: [{ campo: 'documento', etiqueta: 'Cliente', peso: 2 }, colNum('total', 'Transacciones', 'n', { barra: true }), colNum('errores', 'Errores'), colNum('tasa', 'Tasa de error', 'pct', { umbral: { aviso: 10, critico: 25 } })],
        filas: clientes.map((c) => ({ documento: mask(c.Documento), total: Number(c.total), errores: Number(c.errores), tasa: Number(c.total) ? K.redondo((Number(c.errores) / Number(c.total)) * 100, 1) : null })),
      }),
    ] : []),
  ];
  return K.informe({
    clave: 'appmovil', titulo: 'Informe de la App Móvil', subtitulo: 'Tráfico, efectividad, tiempos de respuesta, versiones y alertas',
    periodo: { desde, hasta }, kpis, hallazgos: h, secciones,
    notas: ['Los datos salen de las tablas de resumen del ETL (se actualizan cada 5 minutos); el día en curso es parcial y no entra en promedios.', 'La latencia solo considera las llamadas medidas. Los documentos de clientes aparecen enmascarados.'],
  });
}
module.exports = { armar };
