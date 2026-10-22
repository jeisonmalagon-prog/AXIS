// Informe de Certificados: estado actual (vigentes / por vencer / vencidos),
// calendario de vencimientos, quién tiene qué en riesgo y la actividad
// (altas/renovaciones) del periodo comparada con el periodo anterior.
const K = require('../kit');
const { armarDatosInforme } = require('../../informeCertificados');

async function armar({ desde, hasta, periodoSel }) {
  const d = await armarDatosInforme(desde, hasta, periodoSel);
  const { resumen, comparacion } = d;
  const vig = resumen.Vigente || 0; const por = resumen['Por vencer'] || 0; const ven = resumen.Vencido || 0;
  const total = d.totalActivos || vig + por + ven;
  const prox = d.proximosVencimientos || [];
  const en30 = prox.filter((p) => p.Estado === 'Por vencer' && Number(p.DiasRestantes) <= 30).length;
  const sinResp = prox.filter((p) => !p.Responsable || p.Responsable === 'Sin asignar').length;
  const pctVig = K.porcentaje(vig, total);

  const kpis = [
    K.kpi('Certificados activos', total, { fmt: 'n', nota: pctVig === null ? null : `${K.F.num(pctVig, 1)} % vigentes` }),
    K.kpi('Vigentes', vig, { tono: 'ok' }),
    K.kpi('Por vencer', por, { tono: por ? 'warn' : 'ok', nota: en30 ? `${en30} en los próximos 30 días` : null }),
    K.kpi('Vencidos', ven, { tono: ven ? 'danger' : 'ok' }),
    K.kpi('Altas en el periodo', d.altasEnPeriodo, { delta: K.delta(comparacion.altas.actual, comparacion.altas.anterior) }),
    K.kpi('Renovaciones', d.renovacionesEnPeriodo, { delta: K.delta(comparacion.renovaciones.actual, comparacion.renovaciones.anterior), nota: d.tasaRenovacionPorc === null ? null : `${d.tasaRenovacionPorc} % de la actividad` }),
  ];

  const h = [];
  if (ven > 0) {
    const apps = (d.topAplicacionesCriticas || []).slice(0, 3).map((x) => `${x.nombre} (${x.total})`).join(', ');
    h.push(K.hallazgo('critico', `${ven} ${ven === 1 ? 'certificado vencido' : 'certificados vencidos'}`, apps ? `Mayor concentración en: ${apps}.` : 'Requieren renovación inmediata.'));
  }
  if (en30 > 0) h.push(K.hallazgo('aviso', `${en30} ${en30 === 1 ? 'certificado vence' : 'certificados vencen'} en los próximos 30 días`, 'Conviene iniciar la renovación ya: los trámites de emisión suelen tardar.'));
  else if (por > 0) h.push(K.hallazgo('aviso', `${por} certificados por vencer`, 'Están dentro de la ventana de alerta pero ninguno vence en menos de 30 días.'));
  const prim = prox.find((p) => p.Estado === 'Por vencer');
  if (prim) h.push(K.hallazgo('info', `El próximo vencimiento es ${prim.NombreComun || 'un certificado'}`, `${prim.Hostname || 'Sin servidor'} · ${prim.Aplicacion || 'Sin aplicación'} · vence el ${K.F.fecha(prim.FechaFin)} (${prim.DiasRestantes} días).`));
  if (sinResp > 0) h.push(K.hallazgo('aviso', `${sinResp} certificados en riesgo sin responsable asignado`, 'Nadie recibirá la alerta de vencimiento; asigna un responsable.'));
  if (d.promedioDiasParaVencer !== null && d.promedioDiasParaVencer <= 15 && por) h.push(K.hallazgo('aviso', `Los certificados por vencer tienen en promedio ${d.promedioDiasParaVencer} días restantes`));
  if (comparacion.vencidos && comparacion.vencidos.anterior !== null && comparacion.vencidos.actual > comparacion.vencidos.anterior) h.push(K.hallazgo('aviso', 'Vencieron más certificados que en el periodo anterior', `${comparacion.vencidos.actual} frente a ${comparacion.vencidos.anterior}.`));
  if (d.renovacionesEnPeriodo === 0 && por > 0) h.push(K.hallazgo('info', 'No se registraron renovaciones en el periodo', 'Hay certificados por vencer y ninguna renovación en el histórico.'));
  if (!ven && !por) h.push(K.hallazgo('ok', 'Todos los certificados activos están vigentes'));

  const tonoEstado = { Vencido: 'danger', 'Por vencer': 'warn', Vigente: 'ok' };
  const secciones = [
    K.seccion('Estado de los certificados', [
      K.grafico({ forma: 'dona', titulo: 'Distribución por estado', etiquetas: ['Vigentes', 'Por vencer', 'Vencidos'], series: [{ nombre: 'Certificados', valores: [vig, por, ven] }], colores: [K.COLOR_TONO.ok, K.COLOR_TONO.warn, K.COLOR_TONO.danger], ancho: 'medio' }),
      K.rankingH('Aplicaciones con más certificados críticos', d.topAplicacionesCriticas || [], { color: '#d97706', ancho: 'medio', nombreSerie: 'Críticos' }),
      d.calendarioVencimientos && d.calendarioVencimientos.some((m) => m.total) ? K.grafico({ forma: 'barras', titulo: 'Calendario de vencimientos (próximos 12 meses)', etiquetas: d.calendarioVencimientos.map((m) => m.etiqueta), series: [{ nombre: 'Vencen', valores: d.calendarioVencimientos.map((m) => m.total), color: '#d97706' }] }) : null,
      K.rankingH('Responsables con más certificados críticos', d.topResponsablesCriticos || [], { color: '#673ab7', ancho: 'medio', nombreSerie: 'Críticos' }),
      K.rankingH('Servidores con más certificados críticos', d.topServidoresCriticos || [], { color: '#0ea5e9', ancho: 'medio', nombreSerie: 'Críticos' }),
    ]),
    K.seccion('Por vencer y vencidos (estado actual)', [
      K.tabla({
        titulo: 'Certificados que requieren atención', hoja: 'Por vencer y vencidos',
        descripcion: 'Ordenados por fecha de vencimiento; los vencidos aparecen primero.',
        columnas: [
          { campo: 'Estado', etiqueta: 'Estado', tonos: tonoEstado, peso: 1.4 },
          { campo: 'Aplicacion', etiqueta: 'Aplicación', peso: 2.4 },
          { campo: 'Hostname', etiqueta: 'Servidor', peso: 2 },
          { campo: 'NombreComun', etiqueta: 'Certificado', peso: 3 },
          { campo: 'FechaFin', etiqueta: 'Vence', tipo: 'fecha' },
          { campo: 'DiasRestantes', etiqueta: 'Días', tipo: 'num', fmt: 'n', umbral: { aviso: 30, critico: 0, mayorEsMalo: false }, peso: 0.9 },
          { campo: 'Responsable', etiqueta: 'Responsable', peso: 2 },
          { campo: 'EntidadEmisora', etiqueta: 'Emisor', peso: 1.8 },
        ],
        filas: prox, vacio: 'No hay certificados por vencer ni vencidos.',
      }),
    ]),
    K.seccion('Actividad del periodo', [
      d.tendencia && d.tendencia.length ? K.grafico({
        forma: 'barras', titulo: 'Altas, renovaciones y vencimientos por tramo',
        etiquetas: d.tendencia.map((t) => t.etiqueta),
        series: [{ nombre: 'Altas', valores: d.tendencia.map((t) => t.altas), color: '#16a34a' }, { nombre: 'Renovaciones', valores: d.tendencia.map((t) => t.renovaciones), color: '#0ea5e9' }, { nombre: 'Vencimientos', valores: d.tendencia.map((t) => t.vencidos), color: '#dc2626' }],
      }) : null,
      K.tabla({
        titulo: 'Altas y renovaciones registradas', hoja: 'Actividad',
        columnas: [
          { campo: 'FechaCambio', etiqueta: 'Fecha', tipo: 'fechahora' },
          { campo: 'Accion', etiqueta: 'Acción', tonos: { ALTA: 'ok' }, peso: 1.4 },
          { campo: 'NombreComun', etiqueta: 'Certificado', peso: 3.5 },
          { campo: 'FechaFinAnterior', etiqueta: 'Vigencia anterior', tipo: 'fecha' },
          { campo: 'FechaFinNueva', etiqueta: 'Nueva vigencia', tipo: 'fecha' },
          { campo: 'UsuarioSistema', etiqueta: 'Usuario', peso: 2 },
        ],
        filas: d.actividadEnPeriodo, vacio: 'No hubo altas ni renovaciones en este periodo.',
      }),
      K.tabla({
        titulo: 'Certificados que vencieron en el periodo', hoja: 'Vencidos en el periodo',
        columnas: [
          { campo: 'Aplicacion', etiqueta: 'Aplicación', peso: 2.4 }, { campo: 'Hostname', etiqueta: 'Servidor', peso: 2 },
          { campo: 'NombreComun', etiqueta: 'Certificado', peso: 3 }, { campo: 'FechaFin', etiqueta: 'Venció', tipo: 'fecha' },
          { campo: 'Responsable', etiqueta: 'Responsable', peso: 2 },
        ],
        filas: d.vencidosEnPeriodo, vacio: 'No venció ningún certificado activo en este periodo.',
      }),
    ]),
  ];

  return K.informe({
    clave: 'certificados', titulo: 'Informe de Certificados', subtitulo: 'Vigencia, vencimientos próximos y actividad de renovación',
    periodo: { desde, hasta }, kpis, hallazgos: h, secciones,
    notas: ['El estado (vigentes / por vencer / vencidos) es el de hoy y no depende del periodo; la actividad (altas y renovaciones) sí se filtra por el periodo elegido.', 'Solo se consideran certificados activos: uno que venció y luego se desactivó no aparece en las cifras de vencidos.'],
  });
}
module.exports = { armar };
