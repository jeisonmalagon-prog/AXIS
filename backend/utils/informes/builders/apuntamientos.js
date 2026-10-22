// Informe de la Bitácora de Apuntamientos: cobertura actual y actividad /
// incidencias del periodo.
const K = require('../kit');
const { armarDatosInformeApuntamientos } = require('../../informeApuntamientos');

async function armar({ desde, hasta, periodoSel }) {
  const d = await armarDatosInformeApuntamientos(desde, hasta, periodoSel);
  const r = d.resumenActual; const c = d.comparacion;
  const cobertura = r.total ? K.porcentaje(r.total - r.sinApuntamiento, r.total) : null;
  const inc = d.incidenciasEnPeriodo;
  const kpis = [
    K.kpi('Total apuntamientos', r.total),
    K.kpi('Sin apuntamiento', r.sinApuntamiento, { tono: r.sinApuntamiento ? 'warn' : 'ok', nota: cobertura === null ? null : `${K.F.num(cobertura, 1)} % con apuntamiento` }),
    K.kpi('ACE', r.ace),
    K.kpi('Bus de Integración 10', r.busIntegracion10),
    K.kpi('Altas en el periodo', d.altasEnPeriodo, { delta: K.delta(c.altas.actual, c.altas.anterior) }),
    K.kpi('Incidencias', inc.length, { tono: inc.length ? 'danger' : 'ok', delta: K.delta(c.incidencias.actual, c.incidencias.anterior, { mejorSiBaja: true }) }),
  ];
  const h = [];
  if (inc.length) {
    const top = d.topServiciosPorIncidencias[0];
    h.push(K.hallazgo(inc.length > (c.incidencias.anterior || 0) ? 'critico' : 'aviso', `${inc.length} incidencias registradas en el periodo`, top ? `El servicio con más incidencias es ${top.nombre} (${top.total}).` : ''));
  }
  if (c.incidencias.anterior !== null && c.incidencias.actual < c.incidencias.anterior) h.push(K.hallazgo('ok', 'Las incidencias bajaron frente al periodo anterior', `${c.incidencias.actual} contra ${c.incidencias.anterior}.`));
  if (r.sinApuntamiento) h.push(K.hallazgo('aviso', `${r.sinApuntamiento} servicios sin apuntamiento`, 'Sin apuntamiento no se sabe a qué nodo responde cada servicio.'));
  if (d.ajustesEnPeriodo > d.altasEnPeriodo * 2 && d.ajustesEnPeriodo > 5) h.push(K.hallazgo('info', 'Hubo muchos más ajustes que altas', `${d.ajustesEnPeriodo} ajustes frente a ${d.altasEnPeriodo} altas.`));
  if (!h.length) h.push(K.hallazgo('ok', 'Sin incidencias en el periodo'));
  const secciones = [
    K.seccion('Cobertura actual', [
      K.grafico({ forma: 'dona', titulo: 'Apuntamientos por categoría', etiquetas: ['ACE', 'Bus de Integración 10', 'Otros'], series: [{ nombre: 'Servicios', valores: [r.ace, r.busIntegracion10, Math.max(0, r.total - r.ace - r.busIntegracion10)] }], ancho: 'medio' }),
      K.grafico({ forma: 'dona', titulo: 'Cobertura de apuntamiento', etiquetas: ['Con apuntamiento', 'Sin apuntamiento'], series: [{ nombre: 'Servicios', valores: [r.total - r.sinApuntamiento, r.sinApuntamiento] }], colores: [K.COLOR_TONO.ok, K.COLOR_TONO.warn], ancho: 'medio' }),
    ]),
    K.seccion('Actividad e incidencias del periodo', [
      d.tendencia && d.tendencia.length ? K.grafico({ forma: 'barras', titulo: 'Altas, ajustes e incidencias por tramo', etiquetas: d.tendencia.map((t) => t.etiqueta), series: [{ nombre: 'Altas', valores: d.tendencia.map((t) => t.altas), color: '#16a34a' }, { nombre: 'Ajustes', valores: d.tendencia.map((t) => t.ajustes), color: '#0ea5e9' }, { nombre: 'Incidencias', valores: d.tendencia.map((t) => t.incidencias), color: '#dc2626' }] }) : null,
      K.rankingH('Servicios con más incidencias', d.topServiciosPorIncidencias, { color: '#dc2626', ancho: 'medio', nombreSerie: 'Incidencias' }),
      K.rankingH('Aplicaciones con más incidencias', d.topAplicacionesPorIncidencias, { color: '#d97706', ancho: 'medio', nombreSerie: 'Incidencias' }),
      K.tabla({
        titulo: 'Incidencias registradas', hoja: 'Incidencias',
        columnas: [
          { campo: 'FechaCambio', etiqueta: 'Fecha', tipo: 'fechahora' }, { campo: 'ServicioNuevoNombre', etiqueta: 'Servicio', peso: 2.6 },
          { campo: 'AplicacionNuevoNombre', etiqueta: 'Aplicación', peso: 2.4 }, { campo: 'TrandId', etiqueta: 'TRANDID', peso: 1.8 },
          { campo: 'ErrorDescripcion', etiqueta: 'Descripción', peso: 3.5 },
        ],
        filas: inc.map((x) => ({ ...x, ServicioNuevoNombre: x.ServicioNuevoNombre || 'Sin asignar', AplicacionNuevoNombre: x.AplicacionNuevoNombre || 'Sin asignar' })), vacio: 'No se registraron incidencias en este periodo.',
      }),
    ]),
  ];
  return K.informe({
    clave: 'apuntamientos', titulo: 'Informe de la Bitácora de Apuntamientos', subtitulo: 'Cobertura de apuntamientos y actividad del periodo',
    periodo: { desde, hasta }, kpis, hallazgos: h, secciones,
    notas: ['La cobertura es la de hoy; altas, ajustes e incidencias salen del histórico del periodo. Una incidencia es un cambio con error o TRANDID registrado.'],
  });
}
module.exports = { armar };
