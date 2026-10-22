// Informe de Aplicaciones e Inventario: calidad del inventario (servidores sin
// aplicativos, sub-aplicativos sin certificado), criticidad y conexiones a BD.
const K = require('../kit');
const { armarDatosInformeAplicaciones } = require('../../informeAplicaciones');

async function armar({ desde, hasta, periodoSel }) {
  const d = await armarDatosInformeAplicaciones(desde, hasta, periodoSel);
  const r = d.resumenActual; const cmp = d.comparacionConexionesBd;
  const cobertura = r.totalSubaplicativos ? K.porcentaje(r.totalSubaplicativos - r.subaplicativosSinCertificado, r.totalSubaplicativos) : null;
  const sinDefinir = (d.criticidadSubaplicativos.find((c) => c.nombre === 'Sin definir') || {}).total || 0;
  const kpis = [
    K.kpi('Aplicaciones de negocio', r.totalAplicacionesNegocio),
    K.kpi('Sub-aplicativos', r.totalSubaplicativos),
    K.kpi('Servidores activos', r.totalServidores),
    K.kpi('Servidores sin aplicativos', r.servidoresSinAplicativos, { tono: r.servidoresSinAplicativos ? 'warn' : 'ok' }),
    K.kpi('Sub-aplicativos sin certificado', r.subaplicativosSinCertificado, { tono: r.subaplicativosSinCertificado ? 'warn' : 'ok', nota: cobertura === null ? null : `${K.F.num(cobertura, 1)} % con certificado` }),
    K.kpi('Conexiones BD registradas', d.altasConexionesBdEnPeriodo, { delta: K.delta(cmp.actual, cmp.anterior), nota: 'en el periodo' }),
  ];
  const h = [];
  if (r.servidoresSinAplicativos) h.push(K.hallazgo('aviso', `${r.servidoresSinAplicativos} servidores activos sin aplicativos registrados`, `Pueden estar sin uso o con el inventario incompleto. Ejemplos: ${d.servidoresSinAplicativos.slice(0, 3).map((s) => s.Hostname).join(', ')}.`));
  if (r.subaplicativosSinCertificado) h.push(K.hallazgo('aviso', `${r.subaplicativosSinCertificado} sub-aplicativos sin certificado asociado`, cobertura === null ? '' : `La cobertura de certificados es del ${K.F.num(cobertura, 1)} %.`));
  if (sinDefinir) h.push(K.hallazgo('info', `${sinDefinir} sub-aplicativos sin criticidad definida`, 'Sin criticidad no se puede priorizar su atención.'));
  if (cmp.actual > 0 && cmp.anterior !== null) h.push(K.hallazgo('info', `Se registraron ${cmp.actual} conexiones a bases de datos`, cmp.cambioPorc === null ? '' : `${cmp.cambioPorc > 0 ? '+' : ''}${cmp.cambioPorc} % frente al periodo anterior.`));
  if (!r.servidoresSinAplicativos && !r.subaplicativosSinCertificado) h.push(K.hallazgo('ok', 'El inventario está completo: todo servidor tiene aplicativos y todo sub-aplicativo tiene certificado'));

  const secciones = [
    K.seccion('Inventario y criticidad', [
      K.grafico({ forma: 'dona', titulo: 'Sub-aplicativos por criticidad', etiquetas: d.criticidadSubaplicativos.map((c) => c.nombre), series: [{ nombre: 'Sub-aplicativos', valores: d.criticidadSubaplicativos.map((c) => c.total) }], ancho: 'medio' }),
      K.rankingH('Motores de base de datos más usados', d.topMotoresBd, { color: '#0ea5e9', ancho: 'medio', nombreSerie: 'Conexiones' }),
    ]),
    K.seccion('Calidad del inventario', [
      K.tabla({ titulo: 'Servidores sin aplicativos registrados', hoja: 'Servidores sin aplicativos', columnas: [{ campo: 'Hostname', etiqueta: 'Servidor', peso: 3 }, { campo: 'IP', etiqueta: 'IP', peso: 2 }], filas: d.servidoresSinAplicativos, vacio: 'Todos los servidores activos tienen al menos un aplicativo.' }),
      K.tabla({ titulo: 'Sub-aplicativos sin certificado', hoja: 'Sin certificado', columnas: [{ campo: 'Nombre', etiqueta: 'Sub-aplicativo', peso: 3 }, { campo: 'Hostname', etiqueta: 'Servidor', peso: 2 }], filas: d.subaplicativosSinCertificado.map((x) => ({ ...x, Hostname: x.Hostname || 'Sin asignar' })), vacio: 'Todos los sub-aplicativos tienen certificado.' }),
    ]),
    K.seccion('Conexiones a bases de datos', [
      d.tendenciaConexionesBd && d.tendenciaConexionesBd.length ? K.grafico({ forma: 'barras', titulo: 'Conexiones registradas por tramo', etiquetas: d.tendenciaConexionesBd.map((t) => t.etiqueta), series: [{ nombre: 'Conexiones', valores: d.tendenciaConexionesBd.map((t) => t.total), color: '#673ab7' }] }) : null,
      K.tabla({
        titulo: 'Conexiones registradas en el periodo', hoja: 'Conexiones BD',
        columnas: [
          { campo: 'AplicativoNombre', etiqueta: 'Aplicativo', peso: 2.5 }, { campo: 'motor_bd', etiqueta: 'Motor', peso: 1.4 },
          { campo: 'nombre_base_datos', etiqueta: 'Base de datos', peso: 2.2 }, { campo: 'esquema', etiqueta: 'Esquema', peso: 1.6 },
          { campo: 'ServidorBdHostname', etiqueta: 'Servidor BD', peso: 2 }, { campo: 'fecha_registro', etiqueta: 'Registrada', tipo: 'fechahora' },
        ],
        filas: d.conexionesBdEnPeriodo.map((c) => ({ ...c, AplicativoNombre: c.AplicativoNombre || 'Sin asignar' })), vacio: 'No se registraron conexiones en este periodo.',
      }),
    ]),
  ];
  return K.informe({
    clave: 'aplicaciones', titulo: 'Informe de Aplicaciones e Inventario', subtitulo: 'Calidad del inventario, criticidad y conexiones a bases de datos',
    periodo: { desde, hasta }, kpis, hallazgos: h, secciones,
    notas: ['Aplicaciones e Inventario no guardan fecha de alta: casi todo el informe es una foto del estado actual. Solo las conexiones a bases de datos se filtran por periodo.'],
  });
}
module.exports = { armar };
