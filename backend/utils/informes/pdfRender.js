// Renderizador PDF de un informe descrito con utils/informes/kit.js.
//
// Estructura de cada PDF: franja de encabezado con título/periodo → resumen
// ejecutivo (tarjetas de KPI) → hallazgos clave → secciones (gráficos y
// tablas) → notas de alcance. Pie de página con numeración "Página x de y" y
// marcadores (índice del visor de PDF) por sección.
//
// Todo se dibuja con coordenadas propias (cursor "c.y") en vez del flujo
// automático de pdfkit: así los saltos de página son predecibles y ningún
// bloque queda partido por la mitad.

const PDFDocument = require('pdfkit');
const { F, PALETA, COLOR_TONO, COLOR_NIVEL, tonoDeCelda } = require('./kit');

const PAG_W = 595.28;
const PAG_H = 841.89;
const M = 40;
const W = PAG_W - M * 2; // 515
const TOP = 54;
const BOTTOM = 56;
const LIM_Y = PAG_H - BOTTOM;

const INK = '#1e293b';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const SOFT = '#f8fafc';
const HEAD = '#f1f5f9';

const NIVEL_ETIQUETA = { critico: 'CRÍTICO', aviso: 'AVISO', info: 'INFO', ok: 'OK' };

function mezclar(hex, con, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(hex); const b = p(con);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
const oscurecer = (hex, t) => mezclar(hex, '#000000', t);
const aclarar = (hex, t) => mezclar(hex, '#ffffff', t);

function techoRedondo(valor) {
  if (!(valor > 0)) return 1;
  const magnitud = 10 ** Math.floor(Math.log10(valor));
  const n = valor / magnitud;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 8 ? 8 : 10) * magnitud;
}

// Escala del eje Y: parte de 0, salvo porcentajes muy altos y casi planos
// (disponibilidad 98-100 %), donde se acerca para que se vea la variación.
function escala(valores, fmt) {
  const v = valores.filter((x) => x !== null && Number.isFinite(x));
  const max = v.length ? Math.max(...v) : 1;
  const min = v.length ? Math.min(...v) : 0;
  if (fmt === 'pct' && min >= 50 && max <= 100.0001) {
    const rango = Math.max(0.5, max - min);
    let lo = Math.max(0, Math.floor(min - rango * 0.6 - 0.5));
    const hiIdeal = Math.min(100, Math.ceil(max + rango * 0.15 + 0.2));
    const paso = Math.max(1, Math.ceil((hiIdeal - lo) / 4));
    let hi = lo + paso * 4;
    if (hi > 100) { hi = 100; lo = Math.max(0, 100 - paso * 4); }
    return { lo, hi };
  }
  if (min >= 0 && v.length && v.every((x) => Number.isInteger(x)) && max <= 20) return { lo: 0, hi: Math.max(4, Math.ceil(max / 4) * 4) };
  if (min < 0) { const t = techoRedondo(Math.max(Math.abs(min), max)); return { lo: -t, hi: t }; }
  return { lo: 0, hi: techoRedondo(max) };
}

function generarPdfBuffer(informe, opciones = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', bufferPages: true,
        margins: { top: TOP, bottom: BOTTOM, left: M, right: M },
        info: { Title: informe.titulo, Author: 'AXIS · Banco Finandina', Subject: informe.subtitulo || '', Creator: 'AXIS Gestión de Certificados' },
      });
      const partes = [];
      doc.on('data', (p) => partes.push(p));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', reject);
      dibujarInforme(doc, informe, opciones);
      doc.end();
    } catch (e) { reject(e); }
  });
}

function dibujarInforme(doc, informe, opciones) {
  const marca = /^#[0-9a-fA-F]{6}$/.test(opciones.colorMarca || '') ? opciones.colorMarca : '#673ab7';
  const c = { y: 0 };
  const t = (s) => F.paraPdf(s);
  const periodoTxt = informe.periodo ? `${F.fecha(informe.periodo.desde)} — ${F.fecha(informe.periodo.hasta)}` : null;

  // --- Encabezado corrido (páginas 2+) ---
  let primeraPagina = true;
  doc.on('pageAdded', () => {
    if (primeraPagina) return;
    doc.save();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(t(informe.titulo), M, 24, { width: W * 0.65, lineBreak: false, ellipsis: true });
    if (periodoTxt) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(t(periodoTxt), M + W * 0.5, 24, { width: W * 0.5, align: 'right', lineBreak: false });
    doc.moveTo(M, 38).lineTo(M + W, 38).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.restore();
  });
  const nuevaPagina = () => { doc.addPage(); c.y = TOP; };
  const espacio = (h) => { if (c.y + h > LIM_Y) nuevaPagina(); };

  // =================== Franja de encabezado ===================
  const altoBanda = 112;
  const grad = doc.linearGradient(0, 0, PAG_W, altoBanda);
  grad.stop(0, oscurecer(marca, 0.45)).stop(1, marca);
  doc.rect(0, 0, PAG_W, altoBanda).fill(grad);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(aclarar(marca, 0.75)).text('AXIS  ·  BANCO FINANDINA', M, 26, { characterSpacing: 1.2, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(23).fillColor('#ffffff').text(t(informe.titulo), M, 40, { width: W, lineBreak: false, ellipsis: true });
  if (informe.subtitulo) doc.font('Helvetica').fontSize(10).fillColor(aclarar(marca, 0.85)).text(t(informe.subtitulo), M, 69, { width: W, height: 14, lineBreak: false, ellipsis: true });
  const pie = [periodoTxt ? `Periodo: ${periodoTxt}` : null, `Generado: ${F.fechaHora(new Date())}`].filter(Boolean).join('     ');
  doc.font('Helvetica').fontSize(8.5).fillColor('#ffffff').text(t(pie), M, 90, { width: W, lineBreak: false });
  c.y = altoBanda + 20;
  primeraPagina = false;

  // =================== Resumen ejecutivo ===================
  if (informe.kpis && informe.kpis.length) {
    tituloSeccion(doc, c, 'Resumen ejecutivo', marca, espacio, null);
    dibujarKpis(doc, c, informe.kpis, espacio, marca);
  }

  // =================== Hallazgos ===================
  if (informe.hallazgos && informe.hallazgos.length) {
    tituloSeccion(doc, c, 'Hallazgos clave', marca, espacio, null);
    const mostrar = informe.hallazgos.slice(0, 9);
    for (const h of mostrar) {
      const col = COLOR_NIVEL[h.nivel] || MUTED;
      const wTxt = W - 22;
      doc.font('Helvetica-Bold').fontSize(9.5);
      const hT = doc.heightOfString(t(h.titulo), { width: wTxt - 52 });
      doc.font('Helvetica').fontSize(8.5);
      const hD = h.detalle ? doc.heightOfString(t(h.detalle), { width: wTxt }) : 0;
      const alto = 10 + Math.max(hT, 11) + (hD ? hD + 2 : 0) + 6;
      espacio(alto + 4);
      doc.roundedRect(M, c.y, W, alto, 5).fill(aclarar(col, 0.92));
      doc.rect(M, c.y, 3.5, alto).fill(col);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(col).text(NIVEL_ETIQUETA[h.nivel] || 'INFO', M + 12, c.y + 8.5, { width: 46, lineBreak: false, characterSpacing: 0.4 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(t(h.titulo), M + 12 + 46, c.y + 7, { width: wTxt - 52 });
      if (hD) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(t(h.detalle), M + 12, c.y + 7 + Math.max(hT, 11) + 2, { width: wTxt });
      c.y += alto + 5;
    }
    if (informe.hallazgos.length > mostrar.length) {
      espacio(14);
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(`y ${informe.hallazgos.length - mostrar.length} hallazgos más de menor prioridad (ver la vista en pantalla).`, M, c.y, { width: W, lineBreak: false });
      c.y += 14;
    }
    c.y += 6;
  }

  // =================== Secciones ===================
  for (const s of informe.secciones || []) {
    espacio(40 + altoPrimerBloque(s.bloques[0], s.bloques[1]));
    tituloSeccion(doc, c, s.titulo, marca, espacio, s.descripcion);
    let i = 0;
    const bloques = s.bloques;
    while (i < bloques.length) {
      const b = bloques[i];
      if (b.tipo === 'grafico' && b.ancho === 'medio' && bloques[i + 1] && bloques[i + 1].tipo === 'grafico' && bloques[i + 1].ancho === 'medio') {
        graficoPar(doc, c, b, bloques[i + 1], espacio, marca);
        i += 2;
        continue;
      }
      if (b.tipo === 'grafico') graficoSolo(doc, c, b, espacio, marca);
      else if (b.tipo === 'tabla') dibujarTabla(doc, c, b, espacio, nuevaPagina, marca, opciones.maxFilasTabla || 28);
      else if (b.tipo === 'texto') {
        doc.font('Helvetica').fontSize(9).fillColor(MUTED);
        const h = doc.heightOfString(t(b.texto), { width: W });
        espacio(h + 8);
        doc.text(t(b.texto), M, c.y, { width: W });
        c.y += h + 8;
      } else if (b.tipo === 'kpis') dibujarKpis(doc, c, b.items, espacio, marca);
      i += 1;
    }
    c.y += 4;
  }

  // =================== Notas ===================
  if (informe.notas && informe.notas.length) {
    espacio(70);
    tituloSeccion(doc, c, 'Notas y alcance', marca, espacio, null);
    for (const n of informe.notas) {
      doc.font('Helvetica').fontSize(8.5);
      const h = doc.heightOfString(t(n), { width: W - 12 });
      espacio(h + 5);
      doc.fillColor(marca).text('·', M, c.y, { width: 8, lineBreak: false });
      doc.fillColor(MUTED).text(t(n), M + 12, c.y, { width: W - 12 });
      c.y += h + 4;
    }
  }

  // =================== Pie de página ===================
  const rango = doc.bufferedPageRange();
  for (let i = 0; i < rango.count; i++) {
    doc.switchToPage(rango.start + i);
    const mb = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(M, PAG_H - 40).lineTo(M + W, PAG_H - 40).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(t(`AXIS · Banco Finandina · ${informe.titulo}`), M, PAG_H - 32, { width: W * 0.75, lineBreak: false, ellipsis: true })
      .text(`Página ${i + 1} de ${rango.count}`, M + W * 0.7, PAG_H - 32, { width: W * 0.3, align: 'right', lineBreak: false });
    doc.page.margins.bottom = mb;
  }
}

function altoPrimerBloque(b, sig) {
  if (!b) return 60;
  if (b.tipo === 'grafico') {
    const medio = b.ancho === 'medio' && sig && sig.tipo === 'grafico' && sig.ancho === 'medio';
    return Math.max(altoGrafico(b, medio ? 250 : W), medio ? altoGrafico(sig, 250) : 0) + 14;
  }
  if (b.tipo === 'tabla') return 110;
  return 50;
}

function tituloSeccion(doc, c, titulo, marca, espacio, descripcion) {
  espacio(46);
  doc.rect(M, c.y + 1, 4, 15).fill(marca);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(F.paraPdf(titulo), M + 12, c.y, { width: W - 12, lineBreak: false, ellipsis: true });
  try { doc.outline.addItem(F.paraPdf(titulo)); } catch (e) { /* los marcadores son opcionales */ }
  c.y += 22;
  if (descripcion) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED);
    const h = doc.heightOfString(F.paraPdf(descripcion), { width: W });
    doc.text(F.paraPdf(descripcion), M, c.y, { width: W });
    c.y += h + 6;
  }
}

// ---------- KPIs ----------
function dibujarKpis(doc, c, items, espacio) {
  const n = items.length;
  const cols = n <= 4 ? n : n <= 6 ? 3 : 4;
  const gap = 10;
  const w = (W - gap * (cols - 1)) / cols;
  const h = 66;
  for (let i = 0; i < n; i += cols) {
    espacio(h + 10);
    items.slice(i, i + cols).forEach((k, j) => {
      const x = M + j * (w + gap);
      const col = k.tono ? COLOR_TONO[k.tono] : '#673ab7';
      doc.roundedRect(x, c.y, w, h, 6).lineWidth(0.8).fillAndStroke('#ffffff', LINE);
      doc.save().rect(x + 0.5, c.y + 0.5, w - 1, 3).fill(k.tono ? col : LINE).restore();
      doc.font('Helvetica').fontSize(7.8).fillColor(MUTED).text(F.paraPdf(k.etiqueta), x + 10, c.y + 11, { width: w - 20, lineBreak: false, ellipsis: true });
      const valor = F.paraPdf(F.formatear(k.valor, k.fmt));
      let fs = 20;
      doc.font('Helvetica-Bold');
      while (fs > 11 && doc.fontSize(fs).widthOfString(valor) > w - 20) fs -= 1;
      doc.fontSize(fs).fillColor(k.tono && k.tono !== 'brand' ? col : INK).text(valor, x + 10, c.y + 24, { width: w - 20, lineBreak: false });
      const pieTxt = k.delta ? k.delta.texto : k.nota;
      if (pieTxt) {
        const colD = k.delta ? ({ ok: COLOR_TONO.ok, danger: COLOR_TONO.danger, neutro: MUTED }[k.delta.tono] || MUTED) : MUTED;
        doc.font('Helvetica').fontSize(7.5).fillColor(colD).text(F.paraPdf(pieTxt), x + 10, c.y + h - 17, { width: w - 20, lineBreak: false, ellipsis: true });
      }
    });
    c.y += h + 10;
  }
  c.y += 4;
}

// ---------- Gráficos ----------
function graficoSolo(doc, c, g, espacio, marca) {
  const alto = altoGrafico(g, W);
  espacio(alto + 14);
  dibujarGrafico(doc, g, M, c.y, W, alto);
  c.y += alto + 12;
}
function graficoPar(doc, c, a, b, espacio) {
  const gap = 16;
  const w = (W - gap) / 2;
  const alto = Math.max(altoGrafico(a, w), altoGrafico(b, w));
  espacio(alto + 14);
  dibujarGrafico(doc, a, M, c.y, w, alto);
  dibujarGrafico(doc, b, M + w + gap, c.y, w, alto);
  c.y += alto + 12;
}
function altoGrafico(g, w) {
  const leyenda = g.forma !== 'dona' && g.forma !== 'barrasH' && g.series.length > 1 ? 14 : 0;
  if (g.forma === 'barrasH') return 22 + Math.min(g.etiquetas.length, 12) * 16 + 4;
  if (g.forma === 'dona') return Math.max(22 + 124, 22 + 14 * Math.min(g.etiquetas.length, 9) + 6);
  return 22 + leyenda + (w > 300 ? 128 : 116) + 18;
}

function dibujarGrafico(doc, g, x, y, w, alto) {
  const t = F.paraPdf;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(t(g.titulo), x, y, { width: w, lineBreak: false, ellipsis: true });
  const y0 = y + 18;
  if (!g.etiquetas.length || !g.series.length || g.series.every((s) => s.valores.every((v) => v === null))) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text('Sin datos en este periodo.', x, y0 + 8, { width: w, lineBreak: false });
    return;
  }
  if (g.forma === 'barrasH') return graficoBarrasH(doc, g, x, y0, w);
  if (g.forma === 'dona') return graficoDona(doc, g, x, y0, w);
  graficoEjes(doc, g, x, y0, w, alto - 18);
}

function leyendaSeries(doc, g, x, y, w) {
  let lx = x;
  doc.font('Helvetica').fontSize(7.8);
  for (const s of g.series) {
    const tw = doc.widthOfString(F.paraPdf(s.nombre)) + 22;
    if (lx + tw > x + w) break;
    doc.roundedRect(lx, y + 1.5, 7, 7, 1.5).fill(s.color);
    doc.fillColor(MUTED).text(F.paraPdf(s.nombre), lx + 11, y, { lineBreak: false });
    lx += tw;
  }
}

function graficoEjes(doc, g, x, y, w, h) {
  let top = y;
  if (g.series.length > 1) { leyendaSeries(doc, g, x, y, w); top += 14; }
  const pie = 16;
  const plotH = h - (top - y) - pie;
  const todos = [];
  if (g.apilado && g.forma === 'barras') {
    g.etiquetas.forEach((_, i) => todos.push(g.series.reduce((a, s) => a + (s.valores[i] || 0), 0)));
  } else g.series.forEach((s) => s.valores.forEach((v) => { if (v !== null) todos.push(v); }));
  const { lo, hi } = escala(todos, g.fmt);
  const etiquetaY = (v) => F.paraPdf(g.fmt === 'pct' ? `${F.num(v, (hi - lo) % 4 === 0 ? 0 : 1)} %` : F.formatear(v, g.fmt === 'seg' ? 'seg' : 'compacto'));
  let ancho = 30;
  doc.font('Helvetica').fontSize(7.5);
  for (let i = 0; i <= 4; i++) ancho = Math.max(ancho, doc.widthOfString(etiquetaY(lo + ((hi - lo) * i) / 4)) + 8);
  const px0 = x + ancho; const px1 = x + w - 4; const pw = px1 - px0;
  const yDe = (v) => top + plotH - ((v - lo) / (hi - lo)) * plotH;

  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const yy = yDe(v);
    doc.moveTo(px0, yy).lineTo(px1, yy).lineWidth(i === 0 ? 0.8 : 0.4).strokeColor(i === 0 ? '#cbd5e1' : LINE).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(etiquetaY(v), x, yy - 3.5, { width: ancho - 5, align: 'right', lineBreak: false });
  }
  const n = g.etiquetas.length;
  const salto = Math.max(1, Math.ceil(n / (w > 300 ? 9 : 5)));
  const xCat = (i) => (g.forma === 'barras' ? px0 + (pw / n) * (i + 0.5) : (n === 1 ? px0 + pw / 2 : px0 + (pw * i) / (n - 1)));
  doc.font('Helvetica').fontSize(7.2).fillColor(MUTED);
  g.etiquetas.forEach((e, i) => {
    if (i % salto !== 0 && i !== n - 1) return;
    if (i === n - 1 && n > 1 && (n - 1) % salto !== 0 && (n - 1 - Math.floor((n - 1) / salto) * salto) < salto * 0.6) return;
    const lw = 44;
    let lx = xCat(i) - lw / 2;
    lx = Math.max(x, Math.min(lx, x + w - lw));
    doc.text(F.paraPdf(e), lx, top + plotH + 4, { width: lw, align: 'center', lineBreak: false, ellipsis: true });
  });

  if (g.forma === 'barras') {
    const grupo = pw / n;
    const ns = g.apilado ? 1 : g.series.length;
    const bw = Math.max(2, Math.min(28, (grupo * 0.72) / ns));
    g.etiquetas.forEach((_, i) => {
      const inicio = xCat(i) - (bw * ns) / 2;
      let acum = 0;
      g.series.forEach((s, j) => {
        const v = s.valores[i];
        if (v === null || v === undefined) return;
        const bx = g.apilado ? inicio : inicio + j * bw;
        const base = g.apilado ? acum : Math.max(lo, 0);
        const alt = Math.max(0, ((v - (g.apilado ? 0 : Math.max(lo, 0))) / (hi - lo)) * plotH);
        const yTop = g.apilado ? yDe(acum + v) : yDe(v);
        const hh = g.apilado ? yDe(acum) - yTop : alt;
        if (hh > 0) doc.rect(bx, yTop, bw - (g.apilado ? 0 : 1), hh - (g.apilado && j < g.series.length - 1 ? 0.8 : 0)).fill(s.color);
        if (g.apilado) acum += v;
        else if (n * ns <= 14 && g.series.length === 1) doc.font('Helvetica-Bold').fontSize(7).fillColor(INK).text(F.paraPdf(F.formatear(v, g.fmt === 'pct' ? 'pct' : 'compacto')), bx - 8, yTop - 9, { width: bw + 16, align: 'center', lineBreak: false });
        void base;
      });
    });
    return;
  }

  // Líneas / área
  g.series.forEach((s) => {
    const pts = s.valores.map((v, i) => (v === null || v === undefined ? null : [xCat(i), yDe(v)]));
    const segmentos = [];
    let act = [];
    pts.forEach((p) => { if (p) act.push(p); else if (act.length) { segmentos.push(act); act = []; } });
    if (act.length) segmentos.push(act);
    if (g.series.length === 1 || g.forma === 'area') {
      segmentos.forEach((sg) => {
        if (sg.length < 2) return;
        doc.save().fillOpacity(0.12);
        doc.moveTo(sg[0][0], top + plotH);
        sg.forEach((p) => doc.lineTo(p[0], p[1]));
        doc.lineTo(sg[sg.length - 1][0], top + plotH).closePath().fill(s.color);
        doc.restore();
      });
    }
    segmentos.forEach((sg) => {
      if (sg.length === 1) { doc.circle(sg[0][0], sg[0][1], 2.6).fill(s.color); return; }
      doc.save().lineWidth(1.8).lineJoin('round').lineCap('round').strokeColor(s.color);
      doc.moveTo(sg[0][0], sg[0][1]);
      sg.slice(1).forEach((p) => doc.lineTo(p[0], p[1]));
      doc.stroke().restore();
    });
    const ult = [...pts].reverse().find(Boolean);
    if (ult) doc.circle(ult[0], ult[1], 2.6).lineWidth(1.2).fillAndStroke(s.color, '#ffffff');
    if (g.series.length === 1 && ult) {
      const idx = pts.lastIndexOf(ult);
      const txt = F.paraPdf(F.formatear(s.valores[idx], g.fmt === 'pct' ? 'pct' : g.fmt));
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK).text(txt, Math.min(ult[0] - 30, px1 - 60), Math.max(top, ult[1] - 13), { width: 60, align: 'right', lineBreak: false });
    }
  });
}

function graficoBarrasH(doc, g, x, y, w) {
  const s = g.series[0];
  const n = Math.min(g.etiquetas.length, 12);
  doc.font('Helvetica').fontSize(8);
  let lw = 60;
  for (let i = 0; i < n; i++) lw = Math.max(lw, Math.min(w * 0.45, doc.widthOfString(F.paraPdf(g.etiquetas[i])) + 6));
  const vals = s.valores.slice(0, n).map((v) => v || 0);
  const texto = vals.map((v) => F.paraPdf(F.formatear(v, g.fmt)));
  let vw = 30;
  texto.forEach((tx) => { vw = Math.max(vw, doc.widthOfString(tx) + 6); });
  const bx = x + lw + 8;
  const bwMax = w - lw - 8 - vw;
  const max = Math.max(1e-9, ...vals);
  for (let i = 0; i < n; i++) {
    const yy = y + i * 16;
    doc.font('Helvetica').fontSize(8).fillColor(INK).text(F.paraPdf(g.etiquetas[i]), x, yy + 1, { width: lw, lineBreak: false, ellipsis: true });
    doc.roundedRect(bx, yy + 3, bwMax, 8, 2).fill(HEAD);
    const col = (g.colores && g.colores[i]) || s.color;
    const bw = Math.max(2, (vals[i] / max) * bwMax);
    doc.roundedRect(bx, yy + 3, bw, 8, 2).fill(col);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(texto[i], bx + bwMax + 6, yy + 1.5, { width: vw, lineBreak: false });
  }
}

function graficoDona(doc, g, x, y, w) {
  const s = g.series[0];
  const datos = g.etiquetas.map((e, i) => ({ e, v: s.valores[i] || 0, col: (g.colores && g.colores[i]) || PALETA[i % PALETA.length] })).filter((d) => d.v > 0);
  const total = datos.reduce((a, d) => a + d.v, 0);
  if (!total) { doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text('Sin datos en este periodo.', x, y + 8, { width: w, lineBreak: false }); return; }
  const r = 54; const ri = 33;
  const cx = x + r + 4; const cy = y + r + 4;
  let a0 = -Math.PI / 2;
  datos.forEach((d) => {
    const frac = d.v / total;
    if (frac >= 0.9999) {
      doc.circle(cx, cy, r).fill(d.col);
    } else {
      const a1 = a0 + frac * Math.PI * 2;
      const gran = frac > 0.5 ? 1 : 0;
      const P = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
      const [x0, y0] = P(r, a0); const [x1, y1] = P(r, a1); const [x2, y2] = P(ri, a1); const [x3, y3] = P(ri, a0);
      doc.path(`M ${x0} ${y0} A ${r} ${r} 0 ${gran} 1 ${x1} ${y1} L ${x2} ${y2} A ${ri} ${ri} 0 ${gran} 0 ${x3} ${y3} Z`).lineWidth(1.5).fillAndStroke(d.col, '#ffffff');
      a0 = a1;
    }
  });
  doc.circle(cx, cy, ri).fill('#ffffff');
  const totalTxt = F.paraPdf(total >= 10000 ? F.compacto(total) : F.num(total, 0));
  let fsT = 15;
  doc.font('Helvetica-Bold');
  while (fsT > 8 && doc.fontSize(fsT).widthOfString(totalTxt) > ri * 2 - 6) fsT -= 1;
  doc.fontSize(fsT).fillColor(INK).text(totalTxt, cx - ri, cy - fsT / 2 - 3, { width: ri * 2, align: 'center', lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text('Total', cx - ri, cy + fsT / 2 + 1, { width: ri * 2, align: 'center', lineBreak: false });
  const lx = x + r * 2 + 22;
  const lw = Math.max(60, w - (lx - x));
  datos.slice(0, 9).forEach((d, i) => {
    const yy = y + 4 + i * 14;
    doc.roundedRect(lx, yy + 1.5, 8, 8, 2).fill(d.col);
    const estrecho = lw < 150;
    const colW = estrecho ? 34 : 70;
    doc.font('Helvetica').fontSize(8).fillColor(INK).text(F.paraPdf(d.e), lx + 13, yy, { width: lw - colW - 18, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(estrecho ? `${F.num((d.v / total) * 100, 0)} %` : `${F.num(d.v, 0)}  ·  ${F.num((d.v / total) * 100, 0)} %`, lx + lw - colW, yy, { width: colW, align: 'right', lineBreak: false });
  });
}

// ---------- Tablas ----------
const PESO_TIPO = { txt: 3, num: 1.1, fecha: 1.3, fechahora: 1.8 };

function dibujarTabla(doc, c, b, espacio, nuevaPagina, marca, maxFilas) {
  const t = F.paraPdf;
  const filasMostrar = b.filas.slice(0, maxFilas);
  espacio(70);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(t(b.titulo), M, c.y, { width: W * 0.7, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`${F.num(b.totalFilas)} ${b.totalFilas === 1 ? 'registro' : 'registros'}`, M + W * 0.7, c.y + 1.5, { width: W * 0.3, align: 'right', lineBreak: false });
  c.y += 15;
  if (b.descripcion) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED);
    const h = doc.heightOfString(t(b.descripcion), { width: W });
    doc.text(t(b.descripcion), M, c.y, { width: W });
    c.y += h + 3;
  }
  if (!b.filas.length) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(t(b.vacio), M, c.y + 2, { width: W });
    c.y += 24;
    return;
  }
  const pesos = b.columnas.map((col) => col.peso || PESO_TIPO[col.tipo] || 2);
  doc.font('Helvetica-Bold').fontSize(7.3);
  const contenido = b.columnas.map((col) => {
    doc.font('Helvetica').fontSize(8);
    const muestra = b.filas.slice(0, 60);
    const w = Math.max(0, ...muestra.map((f) => { const v = f[col.campo]; return v === null || v === undefined ? 0 : doc.widthOfString(t(F.formatear(v, col.fmt || (col.tipo === 'fecha' ? 'fecha' : col.tipo === 'fechahora' ? 'fechahora' : undefined)))); }));
    return Math.min(Math.ceil(w) + 12, (col.peso || PESO_TIPO[col.tipo] || 2) >= 3 ? 70 : 140);
  });
  doc.font('Helvetica-Bold').fontSize(7.3);
  const minimos = b.columnas.map((col, i) => Math.max(Math.ceil(doc.widthOfString(t(col.etiqueta).toUpperCase())) + 12, contenido[i], col.tipo === 'fechahora' ? 82 : col.tipo === 'fecha' ? 56 : 0));
  let anchos = pesos.map(() => 0);
  let libres = pesos.map((_, i) => i);
  let restante = W;
  for (let ronda = 0; ronda < 6; ronda++) {
    const sp = libres.reduce((a, i) => a + pesos[i], 0);
    let ajustado = false;
    for (const i of libres) {
      const ideal = (pesos[i] / sp) * restante;
      if (ideal < minimos[i]) { anchos[i] = minimos[i]; restante -= minimos[i]; libres = libres.filter((x) => x !== i); ajustado = true; break; }
    }
    if (!ajustado) { for (const i of libres) anchos[i] = (pesos[i] / sp) * restante; break; }
  }
  const xs = anchos.map((_, i) => M + anchos.slice(0, i).reduce((a, v) => a + v, 0));
  const alinea = (col) => (col.tipo === 'num' ? 'right' : 'left');

  const encabezado = () => {
    doc.rect(M, c.y, W, 19).fill(HEAD);
    b.columnas.forEach((col, i) => {
      doc.font('Helvetica-Bold').fontSize(7.3).fillColor(MUTED).text(t(col.etiqueta).toUpperCase(), xs[i] + 5, c.y + 6, { width: anchos[i] - 10, height: 9, align: alinea(col), lineBreak: false, ellipsis: true });
    });
    c.y += 19;
  };
  encabezado();
  const hFila = 17;
  filasMostrar.forEach((fila, k) => {
    if (c.y + hFila > LIM_Y) { nuevaPagina(); encabezado(); }
    if (k % 2 === 1) doc.rect(M, c.y, W, hFila).fill(SOFT);
    b.columnas.forEach((col, i) => {
      const v = fila[col.campo];
      const tono = tonoDeCelda(col, v);
      let txt = v === null || v === undefined || v === '' ? '—' : F.formatear(v, col.fmt || (col.tipo === 'fecha' ? 'fecha' : col.tipo === 'fechahora' ? 'fechahora' : undefined));
      txt = t(txt);
      const colorTxt = tono ? COLOR_TONO[tono] : INK;
      doc.font(tono ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(colorTxt).text(txt, xs[i] + 5, c.y + 4.5, { width: anchos[i] - 10, height: 10, align: alinea(col), lineBreak: false, ellipsis: true });
    });
    c.y += hFila;
  });
  doc.moveTo(M, c.y).lineTo(M + W, c.y).lineWidth(0.5).strokeColor(LINE).stroke();
  c.y += 4;
  if (b.totalFilas > filasMostrar.length) {
    espacio(14);
    doc.font('Helvetica-Oblique').fontSize(7.8).fillColor(MUTED).text(`Se muestran ${filasMostrar.length} de ${F.num(b.totalFilas)} registros. El listado completo está en el Excel y en la vista en pantalla.`, M, c.y + 1, { width: W, lineBreak: false });
    c.y += 14;
  }
  c.y += 10;
}

module.exports = { generarPdfBuffer };
