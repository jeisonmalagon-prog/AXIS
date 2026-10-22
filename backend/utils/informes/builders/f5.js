// Informe del Balanceador F5: estado en vivo (Virtual Servers y nodos),
// disponibilidad histórica, tráfico y los elementos que requieren atención.
const K = require('../kit');
const { armarDatosInformeF5 } = require('../../informeF5');

const ESTADO_NODO = { disponible: 'Disponible', caido: 'Caído', deshabilitado: 'Deshabilitado' };
const TONO_NODO = { Caído: 'danger', Deshabilitado: 'warn', Disponible: 'ok' };

async function armar({ desde, hasta }) {
  const d = await armarDatosInformeF5(desde, hasta);
  const r = d.resumenActual; const rp = d.resumenPeriodo; const cn = d.conteos;
  const td = d.traficoDiario || [];
  const bytesTotal = K.suma(td, (x) => K.n0(x.datosEntradaBytes) + K.n0(x.datosSalidaBytes));
  const picoCon = td.reduce((m, x) => Math.max(m, K.n0(x.conexionesPico)), 0);
  const dispV = rp.disponibilidadVirtualesPct; const dispN = rp.disponibilidadNodosPct;
  const tonoDisp = (v) => (v === null ? null : v >= 99.5 ? 'ok' : v >= 98 ? 'warn' : 'danger');

  const kpis = [
    K.kpi('Virtual Servers arriba', r.configurado ? `${r.virtualesArriba} / ${r.virtualesTotal}` : '—', { fmt: 'txt', tono: r.configurado ? (r.virtualesAbajo ? 'danger' : 'ok') : null }),
    K.kpi('Nodos arriba', r.configurado ? `${r.nodosArriba} / ${r.nodosTotal}` : '—', { fmt: 'txt', tono: r.configurado ? (r.nodosAbajo ? 'warn' : 'ok') : null }),
    K.kpi('Disponibilidad Virtual Servers', dispV, { fmt: 'pct', tono: tonoDisp(dispV) }),
    K.kpi('Disponibilidad nodos', dispN, { fmt: 'pct', tono: tonoDisp(dispN) }),
    K.kpi('Transacciones HTTP', rp.transaccionesTotal, { fmt: 'compacto', nota: rp.transaccionesTotal === null ? 'AVR sin datos' : null }),
    K.kpi('Datos transferidos', bytesTotal || null, { fmt: 'bytes', nota: picoCon ? `Pico: ${K.F.num(picoCon)} conexiones` : null }),
  ];

  const h = [];
  if (!r.configurado) h.push(K.hallazgo('aviso', 'No hay ningún F5 configurado en el backend', 'Solo se muestra lo guardado en el histórico.'));
  (r.dispositivosConError || []).forEach((e) => h.push(K.hallazgo('critico', `No se pudo leer el F5 "${e.nombre || e.id}"`, e.error)));
  if (r.virtualesAbajo) h.push(K.hallazgo('critico', `${r.virtualesAbajo} Virtual Servers no disponibles ahora`, d.atencion.virtualesAbajo.slice(0, 4).map((v) => v.nombreMostrado).join(', ')));
  if (cn.nodosCaidos) h.push(K.hallazgo('critico', `${cn.nodosCaidos} nodos caídos según el monitor de salud`, d.atencion.nodosCaidos.slice(0, 4).map((n) => `${n.miembro}`).join(', ')));
  if (cn.nodosDeshabilitados) h.push(K.hallazgo('aviso', `${cn.nodosDeshabilitados} nodos deshabilitados por un administrador`, 'Siguen sin recibir tráfico: confirma que sea intencional.'));
  if (cn.virtualesDeshabilitados) h.push(K.hallazgo('aviso', `${cn.virtualesDeshabilitados} Virtual Servers deshabilitados`));
  if (cn.nodosSinTrafico) h.push(K.hallazgo('aviso', `${cn.nodosSinTrafico} nodos disponibles sin tráfico en el periodo`, 'Están arriba pero no atienden conexiones: pueden estar fuera de rotación.'));
  if (dispV !== null && dispV < 99.5) h.push(K.hallazgo(dispV < 98 ? 'critico' : 'aviso', `Disponibilidad de Virtual Servers de ${K.F.num(dispV, 2)} %`, d.picosPeriodo.virtualesAbajoPico ? `En el peor momento hubo ${d.picosPeriodo.virtualesAbajoPico} Virtual Servers caídos a la vez.` : ''));
  const peor = (d.porDispositivo || []).filter((x) => x.virtualesPct !== null).sort((a, b) => a.virtualesPct - b.virtualesPct)[0];
  if (peor && peor.virtualesPct < 99.5 && d.porDispositivo.length > 1) h.push(K.hallazgo('info', `${peor.dispositivoNombre} tuvo la menor disponibilidad`, `${K.F.num(peor.virtualesPct, 2)} % en Virtual Servers.`));
  const topV = d.virtuales.find((v) => v.transacciones);
  if (topV) h.push(K.hallazgo('info', `${topV.nombreMostrado} concentra más transacciones HTTP`, `${K.F.num(topV.transacciones)} transacciones en el periodo.`));
  if (!h.some((x) => x.nivel === 'critico' || x.nivel === 'aviso')) h.unshift(K.hallazgo('ok', 'El balanceador está sano: todo arriba y sin nodos fuera de servicio'));

  const et = (d.tendenciaDiaria || []).map((x) => K.F.fechaCorta(x.fecha));
  const etT = td.map((x) => K.F.fechaCorta(x.fecha));
  const mbps = (v) => (v === null || v === undefined ? null : +(v / 1e6).toFixed(2));
  const tablaAtencion = (titulo, hoja, filas, tipo) => K.tabla({
    titulo, hoja,
    columnas: tipo === 'virtual'
      ? [{ campo: 'dispositivoNombre', etiqueta: 'Dispositivo' }, { campo: 'nombreMostrado', etiqueta: 'Virtual Server', peso: 3 }, { campo: 'destino', etiqueta: 'Destino', peso: 2 }, { campo: 'pool', etiqueta: 'Pool', peso: 2.5 }, { campo: 'motivoEstado', etiqueta: 'Motivo', peso: 3 }]
      : [{ campo: 'dispositivoNombre', etiqueta: 'Dispositivo' }, { campo: 'virtualNombre', etiqueta: 'Virtual Server', peso: 3 }, { campo: 'miembro', etiqueta: 'Nodo', peso: 2.5 }, { campo: 'direccion', etiqueta: 'Dirección', peso: 1.8 }, { campo: 'puerto', etiqueta: 'Puerto', tipo: 'num', fmt: 'txt', peso: 0.9 }, { campo: 'motivoEstado', etiqueta: 'Motivo', peso: 3 }],
    filas, vacio: 'Ninguno: todo en orden.',
  });
  const secciones = [
    K.seccion('Requiere atención', [
      tablaAtencion('Virtual Servers no disponibles', 'VS no disponibles', d.atencion.virtualesAbajo, 'virtual'),
      tablaAtencion('Nodos caídos', 'Nodos caídos', d.atencion.nodosCaidos, 'nodo'),
      tablaAtencion('Nodos deshabilitados', 'Nodos deshabilitados', d.atencion.nodosDeshabilitados, 'nodo'),
      tablaAtencion('Nodos disponibles sin tráfico', 'Nodos sin tráfico', d.atencion.nodosSinTrafico, 'nodo'),
    ]),
    K.seccion('Disponibilidad', et.length ? [
      K.grafico({ forma: 'linea', titulo: 'Disponibilidad diaria (%)', etiquetas: et, series: [{ nombre: 'Virtual Servers', valores: d.tendenciaDiaria.map((x) => x.virtualesPct), color: '#673ab7' }, { nombre: 'Nodos', valores: d.tendenciaDiaria.map((x) => x.nodosPct), color: '#0ea5e9' }], fmt: 'pct' }),
      K.tabla({
        titulo: 'Disponibilidad por dispositivo', hoja: 'Por dispositivo',
        columnas: [{ campo: 'dispositivoNombre', etiqueta: 'Dispositivo', peso: 3 }, { campo: 'virtualesPct', etiqueta: 'VS arriba', tipo: 'num', fmt: 'pct', umbral: { aviso: 99.5, critico: 98, mayorEsMalo: false } }, { campo: 'nodosPct', etiqueta: 'Nodos arriba', tipo: 'num', fmt: 'pct', umbral: { aviso: 99.5, critico: 98, mayorEsMalo: false } }, { campo: 'virtualesTotalProm', etiqueta: 'VS (prom.)', tipo: 'num', fmt: 'n1' }, { campo: 'nodosTotalProm', etiqueta: 'Nodos (prom.)', tipo: 'num', fmt: 'n1' }, { campo: 'capturas', etiqueta: 'Capturas', tipo: 'num', fmt: 'n' }],
        filas: d.porDispositivo,
      }),
    ] : []),
    K.seccion('Tráfico', td.length ? [
      td.some((x) => x.transacciones) ? K.grafico({ forma: 'barras', titulo: 'Transacciones HTTP por día', etiquetas: etT, series: [{ nombre: 'Transacciones', valores: td.map((x) => x.transacciones), color: '#673ab7' }], fmt: 'compacto', ancho: 'medio' }) : null,
      td.some((x) => x.entradaPicoBps) ? K.grafico({ forma: 'linea', titulo: 'Velocidad pico (Mbps)', etiquetas: etT, series: [{ nombre: 'Entrada', valores: td.map((x) => mbps(x.entradaPicoBps)), color: '#0ea5e9' }, { nombre: 'Salida', valores: td.map((x) => mbps(x.salidaPicoBps)), color: '#16a34a' }], fmt: 'n2', ancho: 'medio' }) : null,
      td.some((x) => x.conexionesPico) ? K.grafico({ forma: 'linea', titulo: 'Conexiones simultáneas (pico diario)', etiquetas: etT, series: [{ nombre: 'Conexiones', valores: td.map((x) => x.conexionesPico), color: '#d97706' }], fmt: 'compacto', ancho: 'medio' }) : null,
      td.some((x) => x.datosEntradaBytes) ? K.grafico({ forma: 'barras', titulo: 'Datos transferidos por día (GB)', etiquetas: etT, series: [{ nombre: 'Entrada', valores: td.map((x) => (x.datosEntradaBytes === null ? null : +(x.datosEntradaBytes / 1073741824).toFixed(2))), color: '#0ea5e9' }, { nombre: 'Salida', valores: td.map((x) => (x.datosSalidaBytes === null ? null : +(x.datosSalidaBytes / 1073741824).toFixed(2))), color: '#16a34a' }], fmt: 'n2', apilado: true, ancho: 'medio' }) : null,
    ] : []),
    K.seccion('Virtual Servers y nodos', [
      K.rankingH('Virtual Servers con más transacciones', d.virtuales.filter((v) => v.transacciones).map((v) => ({ nombre: v.nombreMostrado, total: v.transacciones })), { fmt: 'compacto', color: '#673ab7' }),
      K.tabla({
        titulo: 'Virtual Servers', hoja: 'Virtual Servers',
        columnas: [{ campo: 'dispositivoNombre', etiqueta: 'Dispositivo' }, { campo: 'nombreMostrado', etiqueta: 'Virtual Server', peso: 3 }, { campo: 'destino', etiqueta: 'Destino', peso: 2 }, { campo: 'estadoTxt', etiqueta: 'Estado', tonos: { 'No disponible': 'danger', Deshabilitado: 'warn', Disponible: 'ok' }, peso: 1.5 }, { campo: 'nodos', etiqueta: 'Nodos', peso: 1 }, { campo: 'conexionesActuales', etiqueta: 'Conex.', tipo: 'num', fmt: 'n' }, { campo: 'transacciones', etiqueta: 'Transacciones', tipo: 'num', fmt: 'n', barra: true }],
        filas: d.virtuales.map((v) => ({ ...v, estadoTxt: !v.habilitado ? 'Deshabilitado' : v.estado === 'available' ? 'Disponible' : 'No disponible', nodos: v.nodosTotal === null || v.nodosTotal === undefined ? '—' : `${v.nodosArriba}/${v.nodosTotal}` })),
      }),
      K.tabla({
        titulo: 'Nodos', hoja: 'Nodos',
        columnas: [{ campo: 'dispositivoNombre', etiqueta: 'Dispositivo' }, { campo: 'virtualNombre', etiqueta: 'Virtual Server', peso: 3 }, { campo: 'miembro', etiqueta: 'Nodo', peso: 2.5 }, { campo: 'direccion', etiqueta: 'Dirección', peso: 1.8 }, { campo: 'estadoTxt', etiqueta: 'Estado', tonos: TONO_NODO, peso: 1.4 }, { campo: 'entrada', etiqueta: 'Entrada', tipo: 'num', fmt: 'bytes' }, { campo: 'salida', etiqueta: 'Salida', tipo: 'num', fmt: 'bytes' }, { campo: 'transacciones', etiqueta: 'Transacciones', tipo: 'num', fmt: 'n', barra: true }],
        filas: d.nodos.map((n) => ({ ...n, estadoTxt: ESTADO_NODO[n.estado] || n.estado, entrada: n.trafico ? n.trafico.datosEntradaBytes : null, salida: n.trafico ? n.trafico.datosSalidaBytes : null })),
      }),
    ]),
  ];
  return K.informe({
    clave: 'f5', titulo: 'Informe del Balanceador F5', subtitulo: 'Salud, disponibilidad y tráfico de Virtual Servers y nodos',
    periodo: { desde, hasta }, kpis, hallazgos: h, secciones,
    notas: ['Estado de Virtual Servers y nodos: en vivo (iControl REST). Disponibilidad: fotos cada 10 min. Tráfico: lecturas por nodo cada 5 min. Transacciones HTTP: AVR del F5 (hasta ~30 días atrás y solo Virtual Servers con analítica HTTP).', ...(d.notas || [])],
  });
}
module.exports = { armar };
