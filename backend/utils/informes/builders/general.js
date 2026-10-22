// Informe general (ejecutivo): junta las secciones que el usuario elija. Cada
// sección es el informe individual completo; arriba va un resumen con los
// hallazgos más importantes de todos.
const K = require('../kit');

async function armar({ desde, hasta, secciones, catalogo, ctx }) {
  const defs = catalogo.filter((c) => secciones.includes(c.clave) && c.clave !== 'general');
  const res = await Promise.allSettled(defs.map((d) => d.armar({ ...ctx, desde, hasta })));
  const kpis = []; const hall = []; const sec = []; const notas = []; const errores = [];
  res.forEach((r, i) => {
    const d = defs[i];
    if (r.status !== 'fulfilled') { errores.push(`${d.titulo}: ${(r.reason && r.reason.message) || 'error desconocido'}`); console.error(`Informe general: falló "${d.clave}":`, r.reason); return; }
    const inf = r.value;
    const principales = inf.kpis.slice(0, 2).map((k) => ({ ...k, etiqueta: `${d.corto || d.titulo} · ${k.etiqueta}` }));
    kpis.push(...principales);
    inf.hallazgos.filter((x) => x.nivel === 'critico' || x.nivel === 'aviso').slice(0, 2).forEach((x) => hall.push({ ...x, titulo: `${d.corto || d.titulo}: ${x.titulo}` }));
    if (!inf.hallazgos.some((x) => x.nivel === 'critico' || x.nivel === 'aviso')) hall.push(K.hallazgo('ok', `${d.corto || d.titulo}: sin hallazgos que atender`));
    const secs = [];
    secs.push(K.seccion(`${d.titulo}`, [
      inf.kpis.length ? { tipo: 'kpis', items: inf.kpis } : null,
      ...(inf.hallazgos.length ? [{ tipo: 'texto', texto: inf.hallazgos.slice(0, 4).map((x) => `• ${x.titulo}${x.detalle ? ` — ${x.detalle}` : ''}`).join('\n') }] : []),
    ], { id: `${d.clave}-resumen` }));
    inf.secciones.forEach((s) => secs.push({ ...s, id: `${d.clave}-${s.id}`, titulo: `${d.corto || d.titulo} › ${s.titulo}`, bloques: s.bloques.map((b) => (b.tipo === 'tabla' ? { ...b, hoja: `${(d.corto || d.titulo).slice(0, 10)} ${b.hoja || b.titulo}` } : b)) }));
    sec.push(...secs);
    inf.notas.forEach((n) => notas.push(`${d.corto || d.titulo}: ${n}`));
  });
  errores.forEach((e) => hall.push(K.hallazgo('aviso', 'Una sección no se pudo armar', e)));
  return K.informe({
    clave: 'general', titulo: 'Informe General del Aplicativo', subtitulo: defs.map((d) => d.corto || d.titulo).join(' · '),
    periodo: { desde, hasta }, kpis, hallazgos: hall, secciones: sec, notas,
  });
}
module.exports = { armar };
