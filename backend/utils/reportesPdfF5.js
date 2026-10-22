// PDF del informe de Balanceador F5. Mismo layout compartido que
// utils/reportesPdf.js (Certificados) — ver utils/pdfHelpers.js — más las
// gráficas simples de utils/pdfGraficos.js.
//
// Texto solo con caracteres de WinAnsi (sin flechas ni símbolos): la fuente
// estándar Helvetica de pdfkit no los tiene y los pinta como un caracter suelto.
const {
  COLOR_OK,
  COLOR_WARN,
  COLOR_DANGER,
  COLOR_ACENTO,
  COLOR_GRIS,
  COLOR_TEXTO,
  MARGEN_IZQ,
  ANCHO_UTIL,
  titulo,
  encabezadoDocumento,
  filaKpis,
  tabla,
  asegurarEspacio,
} = require('./pdfHelpers');
const { graficaLineas, graficaBarras, barrasHorizontales, PALETA } = require('./pdfGraficos');
const { formatearBitsPorSegundo, formatearBytes } = require('./f5Cliente');

// ---------- Formato ----------
const nf = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('es-CO'));
const bps = (n) => (n === null || n === undefined ? '-' : formatearBitsPorSegundo(n));
const bytes = (n) => (n === null || n === undefined ? '-' : formatearBytes(n));
const porcentaje = (n) => (n === null || n === undefined ? '-' : `${n.toFixed(n === 100 ? 0 : 2)}%`);

function formatoFechaCorta(valor) {
  if (!valor) return '-';
  const texto = String(valor);
  const m = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}`; // fecha pura: no pasar por Date (corre un día en zonas UTC-)
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (isNaN(fecha.getTime())) return texto;
  const dd = (n) => String(n).padStart(2, '0');
  return `${dd(fecha.getDate())}/${dd(fecha.getMonth() + 1)}`;
}

function formatoFechaHora(valor) {
  if (!valor) return '-';
  const f = new Date(valor);
  if (isNaN(f.getTime())) return '-';
  return f.toLocaleString('es-CO', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function escala(maximoBps) {
  if (maximoBps >= 5e8) return { div: 1e9, u: 'Gbps' };
  if (maximoBps >= 5e5) return { div: 1e6, u: 'Mbps' };
  return { div: 1e3, u: 'Kbps' };
}

const colorEstado = (estado) => (
  estado === 'disponible' || estado === 'available' ? COLOR_OK
    : estado === 'deshabilitado' ? COLOR_WARN
      : estado === 'caido' ? COLOR_DANGER : COLOR_TEXTO
);
const textoEstadoNodo = (e) => ({ disponible: 'Disponible', deshabilitado: 'Deshabilitado', caido: 'Caído' }[e] || e);
const textoEstadoVirtual = (v) => (!v.habilitado ? 'Deshabilitado' : v.estado === 'available' ? 'Disponible' : v.estado === 'offline' ? 'Caído' : v.estado === 'unknown' ? 'Sin dato' : v.estado);

function nota(doc, texto, color = COLOR_GRIS) {
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(color).text(texto, MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
  doc.moveDown(0.5);
}

// opciones.resumido = true cuando el F5 va dentro del Informe General: solo el
// resumen, las gráficas, lo que requiere atención y los principales Virtual
// Servers; el detalle completo está en el informe individual de F5.
function generarPdfF5(doc, datos, opciones = {}) {
  const {
    periodo, f5Configurado, resumenActual, conteos = {}, resumenPeriodo = {}, tendenciaDiaria = [],
    picosPeriodo, porDispositivo = [], traficoDiario = [], virtuales = [], nodos = [], atencion = {}, notas = [], fuentes = {},
  } = datos;
  const resumido = !!opciones.resumido;

  encabezadoDocumento(doc, 'Informe de Balanceador F5', periodo);

  if (!f5Configurado) {
    nota(doc, 'No hay ningún dispositivo F5 configurado en el backend (variables F5_DEVICE_*) — este informe no tiene datos que mostrar.');
    return;
  }
  if (resumenActual.dispositivosConError && resumenActual.dispositivosConError.length) {
    const nombres = resumenActual.dispositivosConError.map((d) => d.nombre || d.id).join(', ');
    nota(doc, `No se pudo consultar en vivo: ${nombres} (no se incluyen en el estado actual).`, COLOR_DANGER);
  }

  // ---------- Resumen ejecutivo ----------
  titulo(doc, 'Estado actual (en vivo)');
  filaKpis(doc, [
    { etiqueta: 'Dispositivos F5', valor: resumenActual.dispositivosTotal, color: COLOR_ACENTO },
    { etiqueta: 'Virtual Servers disponibles', valor: `${resumenActual.virtualesArriba}/${resumenActual.virtualesTotal}`, color: resumenActual.virtualesAbajo ? COLOR_WARN : COLOR_OK },
    { etiqueta: 'Nodos disponibles', valor: `${conteos.nodosDisponibles ?? '-'}/${(conteos.nodosDisponibles ?? 0) + (conteos.nodosCaidos ?? 0) + (conteos.nodosDeshabilitados ?? 0)}`, color: (conteos.nodosCaidos || conteos.nodosDeshabilitados) ? COLOR_WARN : COLOR_OK },
    { etiqueta: 'Nodos caídos / deshabilitados', valor: `${conteos.nodosCaidos ?? 0} / ${conteos.nodosDeshabilitados ?? 0}`, color: conteos.nodosCaidos ? COLOR_DANGER : (conteos.nodosDeshabilitados ? COLOR_WARN : COLOR_OK) },
  ]);

  titulo(doc, 'Resumen del periodo');
  filaKpis(doc, [
    { etiqueta: 'Disponibilidad Virtual Serv.', valor: porcentaje(resumenPeriodo.disponibilidadVirtualesPct), color: COLOR_OK },
    { etiqueta: 'Disponibilidad nodos', valor: porcentaje(resumenPeriodo.disponibilidadNodosPct), color: COLOR_OK },
    { etiqueta: 'Máx. VS caídos a la vez', valor: picosPeriodo.virtualesAbajoPico ?? '-', color: picosPeriodo.virtualesAbajoPico ? COLOR_DANGER : COLOR_OK },
    { etiqueta: 'Máx. nodos caídos a la vez', valor: picosPeriodo.nodosAbajoPico ?? '-', color: picosPeriodo.nodosAbajoPico ? COLOR_DANGER : COLOR_OK },
  ]);
  filaKpis(doc, [
    { etiqueta: 'Entrada promedio', valor: bps(resumenPeriodo.entradaPromBps), color: COLOR_ACENTO },
    { etiqueta: 'Salida promedio', valor: bps(resumenPeriodo.salidaPromBps), color: COLOR_ACENTO },
    { etiqueta: 'Conexiones pico', valor: nf(resumenPeriodo.conexionesPico), color: COLOR_ACENTO },
    { etiqueta: 'Conexiones nuevas', valor: nf(resumenPeriodo.conexionesNuevas), color: COLOR_ACENTO },
  ]);
  doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_GRIS).text(
    `Picos: entrada ${bps(resumenPeriodo.entradaPicoBps)} (${formatoFechaHora(resumenPeriodo.entradaPicoEn)}), salida ${bps(resumenPeriodo.salidaPicoBps)} (${formatoFechaHora(resumenPeriodo.salidaPicoEn)}), conexiones ${nf(resumenPeriodo.conexionesPico)} (${formatoFechaHora(resumenPeriodo.conexionesPicoEn)}).`,
    MARGEN_IZQ, doc.y, { width: ANCHO_UTIL }
  );
  doc.moveDown(0.8);
  filaKpis(doc, [
    { etiqueta: 'Datos recibidos (entrada)', valor: bytes(resumenPeriodo.datosEntradaBytes), color: COLOR_ACENTO },
    { etiqueta: 'Datos enviados (salida)', valor: bytes(resumenPeriodo.datosSalidaBytes), color: COLOR_ACENTO },
    { etiqueta: 'Transacciones HTTP (AVR)', valor: nf(resumenPeriodo.transaccionesTotal), color: COLOR_ACENTO },
    { etiqueta: 'Capturas de disponibilidad', valor: nf(picosPeriodo.totalCapturas), color: COLOR_GRIS },
  ]);

  // ---------- Gráficas ----------
  titulo(doc, 'Evolución diaria');
  const etiquetasTrafico = traficoDiario.map((d) => formatoFechaCorta(d.fecha));
  const maxBps = Math.max(0, ...traficoDiario.flatMap((d) => [d.entradaPicoBps || 0, d.salidaPicoBps || 0]));
  const esc = escala(maxBps);
  graficaLineas(doc, {
    titulo: `Velocidad promedio diaria (${esc.u})`,
    etiquetas: etiquetasTrafico,
    series: [
      { nombre: 'Entrada', color: PALETA[0], valores: traficoDiario.map((d) => (d.entradaPromBps === null ? null : +(d.entradaPromBps / esc.div).toFixed(2))) },
      { nombre: 'Salida', color: PALETA[1], valores: traficoDiario.map((d) => (d.salidaPromBps === null ? null : +(d.salidaPromBps / esc.div).toFixed(2))) },
    ],
  });
  graficaBarras(doc, {
    titulo: 'Conexiones simultáneas pico por día',
    etiquetas: etiquetasTrafico,
    valores: traficoDiario.map((d) => d.conexionesPico),
    color: PALETA[0],
  });
  if (traficoDiario.some((d) => d.transacciones !== null && d.transacciones !== undefined)) {
    graficaBarras(doc, {
      titulo: 'Transacciones HTTP por día (AVR)',
      etiquetas: etiquetasTrafico,
      valores: traficoDiario.map((d) => d.transacciones),
      color: PALETA[1],
    });
  }
  graficaLineas(doc, {
    titulo: 'Disponibilidad diaria (%)',
    etiquetas: tendenciaDiaria.map((d) => formatoFechaCorta(d.fecha)),
    series: [
      { nombre: 'Virtual Servers', color: PALETA[0], valores: tendenciaDiaria.map((d) => d.virtualesPct) },
      { nombre: 'Nodos', color: PALETA[1], valores: tendenciaDiaria.map((d) => d.nodosPct) },
    ],
    formatoY: (v) => `${Math.round(v)}`,
  });

  // ---------- Requiere atención ----------
  titulo(doc, 'Requiere atención');
  const hayAtencion = (atencion.virtualesAbajo?.length || 0) + (atencion.virtualesDeshabilitados?.length || 0)
    + (atencion.nodosCaidos?.length || 0) + (atencion.nodosDeshabilitados?.length || 0) + (atencion.nodosSinTrafico?.length || 0);
  if (!hayAtencion) {
    nota(doc, 'Nada que reportar: todos los Virtual Servers y nodos están en servicio y con actividad en este periodo.', COLOR_OK);
  }
  const tablaNodos = (etiqueta, lista, vacio) => {
    if (!lista || !lista.length) return;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLOR_TEXTO).text(`${etiqueta} (${lista.length})`, MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
    doc.moveDown(0.3);
    tabla(doc, [
      { etiqueta: 'Nodo', campo: 'miembro', ancho: 120 },
      { etiqueta: 'Virtual Server', campo: 'virtualNombre', ancho: 150 },
      { etiqueta: 'Dispositivo', campo: 'dispositivoNombre', ancho: 105 },
      { etiqueta: 'Último tráfico', campo: 'ultimoTraficoEn', ancho: 140, formato: (v) => (v ? formatoFechaHora(v) : 'Sin registro') },
    ], lista.slice(0, resumido ? 12 : 60), { vacio });
  };
  if (atencion.virtualesAbajo?.length) {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLOR_TEXTO).text(`Virtual Servers no disponibles (${atencion.virtualesAbajo.length})`, MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
    doc.moveDown(0.3);
    tabla(doc, [
      { etiqueta: 'Virtual Server', campo: 'nombreMostrado', ancho: 170 },
      { etiqueta: 'Dispositivo', campo: 'dispositivoNombre', ancho: 105 },
      { etiqueta: 'Estado', campo: 'estado', ancho: 70, formato: (v, f) => textoEstadoVirtual(f), color: () => COLOR_DANGER },
      { etiqueta: 'Motivo', campo: 'motivoEstado', ancho: 170 },
    ], atencion.virtualesAbajo.slice(0, 40), {});
  }
  tablaNodos('Nodos caídos (el monitor de salud los marca abajo)', atencion.nodosCaidos);
  tablaNodos('Nodos deshabilitados por un administrador', atencion.nodosDeshabilitados);
  tablaNodos('Nodos disponibles SIN tráfico en el periodo', atencion.nodosSinTrafico);
  if (atencion.virtualesDeshabilitados?.length) {
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_GRIS).text(
      `Virtual Servers deshabilitados (${atencion.virtualesDeshabilitados.length}): ${atencion.virtualesDeshabilitados.slice(0, 12).map((v) => v.nombreMostrado).join(', ')}${atencion.virtualesDeshabilitados.length > 12 ? ', ...' : ''}.`,
      MARGEN_IZQ, doc.y, { width: ANCHO_UTIL }
    );
    doc.moveDown(0.6);
  }

  // ---------- Rankings ----------
  // El tráfico se mide en el pool: un pool compartido por varios Virtual Servers
  // se cuenta una sola vez en los rankings.
  const vistos = new Set();
  const porPool = virtuales.filter((v) => {
    const k = `${v.dispositivoId}::${v.pool || v.fullPath}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  }).map((v) => ({
    nombre: v.poolCompartidoCon ? `${v.nombreMostrado} (+${v.poolCompartidoCon})` : v.nombreMostrado,
    datos: (v.trafico?.datosEntradaBytes || 0) + (v.trafico?.datosSalidaBytes || 0),
    trans: v.transacciones || 0,
  }));
  titulo(doc, 'Principales Virtual Servers');
  barrasHorizontales(doc, {
    titulo: 'Por datos transferidos (entrada + salida)',
    items: porPool.filter((p) => p.datos > 0).sort((a, b) => b.datos - a.datos).slice(0, 10).map((p) => ({ nombre: p.nombre, valor: p.datos, texto: bytes(p.datos) })),
    color: PALETA[0],
  });
  if (porPool.some((p) => p.trans > 0)) {
    barrasHorizontales(doc, {
      titulo: 'Por transacciones HTTP (AVR)',
      items: porPool.filter((p) => p.trans > 0).sort((a, b) => b.trans - a.trans).slice(0, 10).map((p) => ({ nombre: p.nombre, valor: p.trans, texto: nf(p.trans) })),
      color: PALETA[1],
    });
  }

  // ---------- Detalle por Virtual Server ----------
  titulo(doc, resumido ? 'Virtual Servers con más actividad' : 'Detalle por Virtual Server');
  const topVirtuales = resumido ? virtuales.slice(0, 15) : virtuales.slice(0, 120);
  tabla(doc, [
    { etiqueta: 'Virtual Server', campo: 'nombreMostrado', ancho: 104, formato: (v, f) => (f.poolCompartidoCon ? `${v} *` : v) },
    { etiqueta: 'Estado', campo: 'estado', ancho: 56, formato: (v, f) => textoEstadoVirtual(f), color: (v, f) => (!f.habilitado ? COLOR_WARN : colorEstado(f.estado)) },
    { etiqueta: 'Nodos', campo: 'nodosArriba', ancho: 38, formato: (v, f) => (f.nodosTotal === null || f.nodosTotal === undefined ? '-' : `${f.nodosArriba}/${f.nodosTotal}`) },
    { etiqueta: 'Datos ent.', campo: 'trafico', ancho: 56, formato: (v) => bytes(v?.datosEntradaBytes) },
    { etiqueta: 'Datos sal.', campo: 'trafico', ancho: 56, formato: (v) => bytes(v?.datosSalidaBytes) },
    { etiqueta: 'Pico ent.', campo: 'trafico', ancho: 50, formato: (v) => bps(v?.entradaPicoBps) },
    { etiqueta: 'Pico sal.', campo: 'trafico', ancho: 50, formato: (v) => bps(v?.salidaPicoBps) },
    { etiqueta: 'Conex.', campo: 'trafico', ancho: 39, formato: (v) => nf(v?.conexionesPico) },
    { etiqueta: 'Trans. HTTP', campo: 'transacciones', ancho: 60, formato: (v) => nf(v) },
  ], topVirtuales, { vacio: 'No hay Virtual Servers para mostrar.' });
  if (virtuales.length > topVirtuales.length) nota(doc, `Se muestran ${topVirtuales.length} de ${virtuales.length} Virtual Servers (los de más actividad).`);
  if (virtuales.some((v) => v.poolCompartidoCon)) {
    nota(doc, '* El tráfico se mide en el pool: los Virtual Servers que comparten pool muestran las mismas cifras de tráfico.');
  }

  if (!resumido) {
    // ---------- Detalle por nodo ----------
    titulo(doc, 'Detalle por nodo');
    const topNodos = nodos.slice(0, 200);
    tabla(doc, [
      { etiqueta: 'Nodo', campo: 'miembro', ancho: 98 },
      { etiqueta: 'Virtual Server', campo: 'virtualNombre', ancho: 100 },
      { etiqueta: 'Estado', campo: 'estado', ancho: 60, formato: (v) => textoEstadoNodo(v), color: (v) => colorEstado(v) },
      { etiqueta: 'Últ. tráfico', campo: 'ultimoTraficoEn', ancho: 72, formato: (v) => (v ? formatoFechaHora(v) : 'Sin registro') },
      { etiqueta: 'Datos', campo: 'trafico', ancho: 56, formato: (v) => (v ? bytes((v.datosEntradaBytes || 0) + (v.datosSalidaBytes || 0)) : '-') },
      { etiqueta: 'Pico ent.', campo: 'trafico', ancho: 56, formato: (v) => bps(v?.entradaPicoBps) },
      { etiqueta: 'Trans. HTTP', campo: 'transacciones', ancho: 73, formato: (v) => nf(v) },
    ], topNodos, { vacio: 'No hay nodos para mostrar.' });
    if (nodos.length > topNodos.length) nota(doc, `Se muestran ${topNodos.length} de ${nodos.length} nodos (los de más actividad). El CSV de la pantalla trae todos.`);

    // ---------- Disponibilidad ----------
    titulo(doc, 'Disponibilidad diaria (promedio de las capturas del día, arriba / total)');
    tabla(doc, [
      { etiqueta: 'Fecha', campo: 'fecha', ancho: 70, formato: formatoFechaCorta },
      { etiqueta: 'Virtual Servers', campo: 'virtualesArribaProm', ancho: 120, formato: (v, f) => `${v} / ${f.virtualesTotalProm}` },
      { etiqueta: 'Disp. VS', campo: 'virtualesPct', ancho: 70, formato: porcentaje },
      { etiqueta: 'Nodos', campo: 'nodosArribaProm', ancho: 120, formato: (v, f) => `${v} / ${f.nodosTotalProm}` },
      { etiqueta: 'Disp. nodos', campo: 'nodosPct', ancho: 70, formato: porcentaje },
      { etiqueta: 'Mín. nodos', campo: 'nodosPctMin', ancho: 65, formato: porcentaje },
    ], tendenciaDiaria, { vacio: 'Aún no hay suficiente histórico guardado en este periodo — las capturas se hacen cada 10 minutos.' });

    titulo(doc, 'Promedio por dispositivo en el periodo');
    tabla(doc, [
      { etiqueta: 'Dispositivo', campo: 'dispositivoNombre', ancho: 150 },
      { etiqueta: 'Virtual Servers', campo: 'virtualesArribaProm', ancho: 140, formato: (v, f) => `${v} / ${f.virtualesTotalProm}` },
      { etiqueta: 'Nodos', campo: 'nodosArribaProm', ancho: 125, formato: (v, f) => `${v} / ${f.nodosTotalProm}` },
      { etiqueta: 'Capturas', campo: 'capturas', ancho: 100 },
    ], porDispositivo, { vacio: 'Sin datos históricos suficientes en este periodo.' });

    // ---------- Tabla diaria de tráfico ----------
    titulo(doc, 'Tráfico diario');
    tabla(doc, [
      { etiqueta: 'Fecha', campo: 'fecha', ancho: 55, formato: formatoFechaCorta },
      { etiqueta: 'Ent. prom.', campo: 'entradaPromBps', ancho: 62, formato: bps },
      { etiqueta: 'Sal. prom.', campo: 'salidaPromBps', ancho: 62, formato: bps },
      { etiqueta: 'Pico ent.', campo: 'entradaPicoBps', ancho: 62, formato: bps },
      { etiqueta: 'Pico sal.', campo: 'salidaPicoBps', ancho: 62, formato: bps },
      { etiqueta: 'Conex.', campo: 'conexionesPico', ancho: 52, formato: nf },
      { etiqueta: 'Nuevas', campo: 'conexionesNuevas', ancho: 58, formato: nf },
      { etiqueta: 'Trans. HTTP', campo: 'transacciones', ancho: 102, formato: nf },
    ], traficoDiario, { vacio: 'Sin datos de tráfico en este periodo.' });

    // ---------- Notas ----------
    titulo(doc, 'Fuentes y notas');
    const lineas = [
      'Estado actual: se consulta en vivo al F5 (iControl REST) al generar el informe, sin importar el periodo elegido.',
      `Disponibilidad: foto cada 10 minutos de cuántos Virtual Servers y nodos estaban arriba (${nf(picosPeriodo.totalCapturas)} capturas en el periodo${fuentes.disponibilidad?.primeraCaptura ? `; la primera registrada es del ${formatoFechaHora(fuentes.disponibilidad.primeraCaptura)}` : ''}). En esta serie "arriba" significa habilitado; el estado actual del detalle distingue además los nodos que el monitor de salud marca caídos.`,
      `Tráfico: lecturas por nodo cada ${Math.round((fuentes.trafico?.intervaloSegundos || 300) / 60)} minutos (${nf(fuentes.trafico?.lecturas)} lecturas en el periodo${fuentes.trafico?.primeraLectura ? `, desde ${formatoFechaHora(fuentes.trafico.primeraLectura)}` : ''}). Las velocidades son promedios entre lecturas; los picos son el mayor promedio entre dos lecturas, no instantáneos.`,
      'Transacciones HTTP: vienen de AVR (Statistics > Analytics del F5), incluyen días anteriores al despliegue y solo cubren Virtual Servers con perfil de analítica HTTP.',
      'Un nodo compartido por varios Virtual Servers se lista una vez; el tráfico se mide en el pool.',
      ...notas,
    ];
    lineas.forEach((l) => {
      asegurarEspacio(doc, 24);
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_GRIS).text(`- ${l}`, MARGEN_IZQ, doc.y, { width: ANCHO_UTIL });
      doc.moveDown(0.3);
    });
  }
}

module.exports = { generarPdfF5 };
