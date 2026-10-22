// Informe de Servidores / Monitoreo (Portainer): estado en vivo de la flota y
// tendencia de CPU, memoria y contenedores del periodo.
const K = require('../kit');
const { armarDatosInformeServidores } = require('../../informeServidores');

function mitades(serie, campo) {
  if (serie.length < 4) return null;
  const m = Math.floor(serie.length / 2);
  const a = K.promedio(serie.slice(0, m), (x) => x[campo]);
  const b = K.promedio(serie.slice(m), (x) => x[campo]);
  return { antes: a, despues: b };
}

async function armar({ desde, hasta }) {
  const d = await armarDatosInformeServidores(desde, hasta);
  const r = d.resumenActual; const p = d.picosPeriodo; const t = d.tendenciaDiaria;
  const kpis = [
    K.kpi('Entornos arriba', d.portainerConfigurado ? `${r.entornosArriba} / ${r.entornosTotal}` : '—', { fmt: 'txt', tono: d.portainerConfigurado ? (r.entornosArriba === r.entornosTotal ? 'ok' : 'danger') : null }),
    K.kpi('Contenedores corriendo', r.contenedoresCorriendo, { tono: 'ok', nota: r.contenedoresTotal ? `de ${r.contenedoresTotal}` : null }),
    K.kpi('Contenedores detenidos', r.contenedoresDetenidos, { tono: r.contenedoresDetenidos ? 'warn' : 'ok' }),
    K.kpi('CPU en uso ahora', r.cpuPromedioActual, { fmt: 'pct', tono: r.cpuPromedioActual >= 85 ? 'danger' : r.cpuPromedioActual >= 70 ? 'warn' : null }),
    K.kpi('Memoria en uso ahora', r.memUsadaActualGb, { fmt: 'gb' }),
    K.kpi('Pico de CPU del periodo', p.cpuPico, { fmt: 'pct', tono: p.cpuPico >= 90 ? 'danger' : p.cpuPico >= 75 ? 'warn' : null, nota: `${K.F.num(p.totalCapturas)} capturas` }),
  ];
  const h = [];
  if (!d.portainerConfigurado) h.push(K.hallazgo('aviso', 'Portainer no está configurado en el backend', 'Solo se muestra el histórico guardado; no hay estado en vivo de la flota.'));
  if (d.portainerConfigurado && r.entornosArriba < r.entornosTotal) h.push(K.hallazgo('critico', `${r.entornosTotal - r.entornosArriba} entornos sin conexión`, 'Portainer no pudo consultarlos; sus contenedores no están contados.'));
  if (r.contenedoresDetenidos > 0) h.push(K.hallazgo('aviso', `${r.contenedoresDetenidos} contenedores detenidos`, 'Verifica si es esperado (jobs puntuales) o si hay servicios caídos.'));
  if (p.cpuPico >= 90) h.push(K.hallazgo('critico', `La CPU llegó a ${K.F.num(p.cpuPico, 1)} % en el periodo`, 'Un pico sostenido en este nivel degrada los servicios.'));
  else if (p.cpuPico >= 75) h.push(K.hallazgo('aviso', `La CPU llegó a ${K.F.num(p.cpuPico, 1)} % en el periodo`));
  const mc = mitades(t, 'cpuPromedio');
  if (mc && mc.antes > 0 && (mc.despues - mc.antes) / mc.antes >= 0.2) h.push(K.hallazgo('aviso', 'El consumo de CPU viene subiendo', `Promedio ${K.F.num(mc.antes, 1)} % en la primera mitad del periodo y ${K.F.num(mc.despues, 1)} % en la segunda.`));
  const mm = mitades(t, 'memUsadaGb');
  if (mm && mm.antes > 0 && (mm.despues - mm.antes) / mm.antes >= 0.2) h.push(K.hallazgo('aviso', 'El consumo de memoria viene subiendo', `De ${K.F.num(mm.antes, 1)} GB a ${K.F.num(mm.despues, 1)} GB entre las dos mitades del periodo.`));
  const topCpu = d.topEntornosPorCpu[0];
  if (topCpu && topCpu.cpuPromedio >= 50) h.push(K.hallazgo('info', `${topCpu.entorno} es el entorno con más CPU`, `${K.F.num(topCpu.cpuPromedio, 1)} % en promedio.`));
  if (!t.length && d.portainerConfigurado) h.push(K.hallazgo('info', 'No hay histórico guardado en este periodo', 'Las muestras se toman cada 10 minutos desde que se activó el snapshot.'));
  if (!h.length) h.push(K.hallazgo('ok', 'La flota está estable: sin entornos caídos ni contenedores detenidos'));

  const et = t.map((x) => K.F.fechaCorta(x.fecha));
  const secciones = [
    K.seccion('Uso de recursos', t.length ? [
      K.grafico({ forma: 'linea', titulo: 'CPU promedio (%)', etiquetas: et, series: [{ nombre: 'CPU', valores: t.map((x) => x.cpuPromedio), color: '#673ab7' }], fmt: 'pct', ancho: 'medio' }),
      K.grafico({ forma: 'linea', titulo: 'Memoria usada (GB)', etiquetas: et, series: [{ nombre: 'Memoria', valores: t.map((x) => x.memUsadaGb), color: '#0ea5e9' }], fmt: 'gb', ancho: 'medio' }),
      K.grafico({ forma: 'linea', titulo: 'Contenedores (promedio diario)', etiquetas: et, series: [{ nombre: 'Total', valores: t.map((x) => x.contenedoresTotalProm), color: '#94a3b8' }, { nombre: 'Corriendo', valores: t.map((x) => x.contenedoresCorriendoProm), color: '#16a34a' }] }),
    ] : []),
    K.seccion('Entornos que más consumen', [
      K.rankingH('CPU promedio por entorno', d.topEntornosPorCpu.map((x) => ({ nombre: x.entorno, total: x.cpuPromedio })), { fmt: 'pct', color: '#673ab7', ancho: 'medio' }),
      K.rankingH('Memoria promedio por entorno', d.topEntornosPorMemoria.map((x) => ({ nombre: x.entorno, total: x.memUsadaGbProm })), { fmt: 'gb', color: '#0ea5e9', ancho: 'medio' }),
    ]),
    K.seccion('Detalle diario', [
      K.tabla({
        titulo: 'Tendencia diaria', hoja: 'Tendencia diaria',
        columnas: [
          { campo: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
          { campo: 'contenedoresTotalProm', etiqueta: 'Contenedores', tipo: 'num', fmt: 'n1' },
          { campo: 'contenedoresCorriendoProm', etiqueta: 'Corriendo', tipo: 'num', fmt: 'n1' },
          { campo: 'cpuPromedio', etiqueta: 'CPU prom.', tipo: 'num', fmt: 'pct', umbral: { aviso: 70, critico: 85 } },
          { campo: 'memUsadaGb', etiqueta: 'Memoria', tipo: 'num', fmt: 'gb' },
        ],
        filas: t, vacio: 'Aún no hay histórico suficiente en este periodo.',
      }),
    ]),
  ];
  return K.informe({
    clave: 'servidores', titulo: 'Informe de Servidores y Monitoreo', subtitulo: 'Estado de la flota de contenedores y uso de recursos',
    periodo: { desde, hasta }, kpis, hallazgos: h, secciones,
    notas: ['El estado de entornos y contenedores es el de este momento; la tendencia sale del histórico de Portainer (una captura cada 10 minutos).'],
  });
}
module.exports = { armar };
