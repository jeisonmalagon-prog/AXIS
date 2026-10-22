// Catálogo único de informes. Para agregar uno nuevo: crear su constructor en
// ./builders/<nombre>.js (devuelve un informe armado con ./kit) y registrarlo aquí.
// Pantalla, PDF, Excel, correo y envíos programados lo toman de este catálogo.

const catalogo = [
  { clave: 'certificados', titulo: 'Certificados', corto: 'Certificados', descripcion: 'Vigencia, próximos vencimientos, responsables en riesgo y renovaciones.', categoria: 'Certificados e inventario', modulo: 'CERTIFICADOS', icono: 'certificado', programable: true, archivo: 'certificados' },
  { clave: 'aplicaciones', titulo: 'Aplicaciones e inventario', corto: 'Aplicaciones', descripcion: 'Calidad del inventario, criticidad, sub-aplicativos sin certificado y conexiones a bases de datos.', categoria: 'Certificados e inventario', modulo: 'CERTIFICADOS', icono: 'aplicacion', programable: true, archivo: 'aplicaciones' },
  { clave: 'servidores', titulo: 'Servidores y monitoreo', corto: 'Servidores', descripcion: 'Estado de la flota de contenedores, CPU y memoria, entornos que más consumen.', categoria: 'Infraestructura', modulo: 'SERVIDORES', icono: 'servidor', programable: true, archivo: 'servidores' },
  { clave: 'f5', titulo: 'Balanceador F5', corto: 'F5', descripcion: 'Salud de Virtual Servers y nodos, disponibilidad, tráfico y elementos que requieren atención.', categoria: 'Infraestructura', modulo: 'BALANCEADOR_F5', icono: 'balanceador', programable: true, archivo: 'f5' },
  { clave: 'appmovil', titulo: 'App móvil', corto: 'App móvil', descripcion: 'Tráfico, efectividad, tiempos de respuesta por servicio, versiones, dispositivos y alertas masivas.', categoria: 'Operación', modulo: 'APP_MOVIL', icono: 'movil', programable: true, archivo: 'appmovil' },
  { clave: 'apuntamientos', titulo: 'Bitácora de apuntamientos', corto: 'Apuntamientos', descripcion: 'Cobertura de apuntamientos, actividad e incidencias por servicio y aplicación.', categoria: 'Operación', modulo: 'SERVICIOS', icono: 'apuntamiento', programable: true, archivo: 'apuntamientos' },
  { clave: 'pasos', titulo: 'Pasos a producción', corto: 'Pasos a prod.', descripcion: 'Despliegues, tasa de éxito, rollbacks, puntualidad y duración. Solo con lo que tu usuario puede ver.', categoria: 'Operación', modulo: 'PASOS_PRODUCCION', icono: 'despliegue', programable: false, archivo: 'pasos' },
  { clave: 'general', titulo: 'Informe general', corto: 'General', descripcion: 'Un solo documento con las secciones que elijas: resumen ejecutivo y detalle de cada módulo.', categoria: 'Ejecutivo', modulo: null, icono: 'general', programable: true, archivo: 'general' },
];

const GENERAL_SECCIONES = catalogo.filter((c) => c.clave !== 'general');

function definicion(clave) { return catalogo.find((c) => c.clave === clave) || null; }
function puedeVer(usuario, def) {
  if (!def) return false;
  if (!def.modulo) return true;
  return ((usuario && usuario.modulos) || []).includes(def.modulo);
}
function permitidos(usuario) { return catalogo.filter((c) => puedeVer(usuario, c)); }

// ---------- Periodos ----------
const PERIODOS = [
  { clave: 'hoy', etiqueta: 'Hoy' }, { clave: 'ayer', etiqueta: 'Ayer' }, { clave: 'semana', etiqueta: '7 días' },
  { clave: 'mes', etiqueta: '30 días' }, { clave: 'trimestre', etiqueta: '90 días' }, { clave: 'mesanterior', etiqueta: 'Mes anterior' },
];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function rangoDePeriodo(periodo, ahora = new Date()) {
  const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const menos = (n) => new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - n);
  switch (periodo) {
    case 'hoy': return { desde: iso(hoy), hasta: iso(hoy) };
    case 'ayer': return { desde: iso(menos(1)), hasta: iso(menos(1)) };
    case 'dia': return { desde: iso(menos(1)), hasta: iso(hoy) }; // compatibilidad con los informes anteriores
    case 'mes': return { desde: iso(menos(29)), hasta: iso(hoy) };
    case 'trimestre': return { desde: iso(menos(89)), hasta: iso(hoy) };
    case 'mesanterior': return { desde: iso(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)), hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 0)) };
    case 'semana': default: return { desde: iso(menos(6)), hasta: iso(hoy) };
  }
}
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS = 400;
// query: { periodo } o { desde, hasta }. Lanza Error con mensaje claro si es inválido.
function resolverPeriodo(q) {
  if (q.desde || q.hasta) {
    if (!RE_FECHA.test(q.desde || '') || !RE_FECHA.test(q.hasta || '')) throw Object.assign(new Error('Las fechas deben tener el formato AAAA-MM-DD.'), { status: 400 });
    if (q.desde > q.hasta) throw Object.assign(new Error('La fecha inicial debe ser anterior o igual a la final.'), { status: 400 });
    const dias = (new Date(`${q.hasta}T00:00:00`) - new Date(`${q.desde}T00:00:00`)) / 86400000 + 1;
    if (dias > MAX_DIAS) throw Object.assign(new Error(`El rango no puede superar ${MAX_DIAS} días.`), { status: 400 });
    return { desde: q.desde, hasta: q.hasta };
  }
  return rangoDePeriodo(q.periodo);
}

function constructor(def) { return require(`./builders/${def.archivo}`); }

// Arma un informe. params: { desde, hasta, usuario, modulos, secciones }
async function armarInforme(clave, params) {
  const def = definicion(clave);
  if (!def) throw Object.assign(new Error('Informe desconocido.'), { status: 404 });
  const base = { desde: params.desde, hasta: params.hasta, periodoSel: 'rango', usuario: params.usuario || null, modulos: params.modulos || [] };
  if (def.clave === 'general') {
    const pedidas = (params.secciones && params.secciones.length ? params.secciones : GENERAL_SECCIONES.map((s) => s.clave));
    const ok = GENERAL_SECCIONES.filter((s) => pedidas.includes(s.clave) && (params.sinFiltroModulos || (base.modulos || []).includes(s.modulo)));
    if (!ok.length) throw Object.assign(new Error('No hay secciones disponibles para tu usuario en este informe.'), { status: 403 });
    const todos = ok.map((s) => ({ ...s, armar: (p) => constructor(s).armar(p) }));
    return constructor(def).armar({ ...base, secciones: ok.map((s) => s.clave), catalogo: todos, ctx: { periodoSel: 'rango', usuario: base.usuario, modulos: base.modulos } });
  }
  return constructor(def).armar(base);
}

module.exports = { catalogo, GENERAL_SECCIONES, definicion, puedeVer, permitidos, PERIODOS, rangoDePeriodo, resolverPeriodo, armarInforme };
