// Alerta por correo del tablero «Consumo y reusos» (a los ADMIN_POD con correo corporativo).
//
// Cada pocos minutos (BIOMETRIA_ALERTA_CICLO_MIN, 5 por defecto) mira lo de HOY y avisa SOLO cuando hay algo que cuesta plata.
// Solo alertan los proveedores con «avisar» activo en Configuración: OLIMPIA (5 consultas por día y 15 por mes por cliente). ASISA no tiene
// sobrecosto: se monitorea en el tablero pero NO genera correo (salvo que el ADMIN_POD active su alerta).
//   · «cliD:<prov>»  clientes que hoy ya superaron el límite DIARIO por cliente de ese proveedor;
//   · «cliM:<prov>»  clientes que superaron el límite MENSUAL por cliente y siguieron consultando hoy;
//   · «cupoD:<prov>» el proveedor superó el cupo DIARIO (si se configuró uno);
//   · «cupoM:<prov>» el proveedor superó el cupo MENSUAL (si se configuró uno).
//
// Cuándo manda correo:
//   1) DE INMEDIATO si aparece algo nuevo: un tipo de alerta que no se había avisado hoy o un cliente que antes no estaba
//      sobre el límite (aunque el aviso anterior haya sido hace un minuto);
//   2) como RECORDATORIO, cada «alertaCadaMin» minutos (Configuración), mientras la situación siga activa y no haya nada nuevo.
//      0 = sin recordatorios (solo se avisa cuando aparece algo nuevo).
// El estado (qué se avisó y cuándo) vive en ConfiguracionSistema y se reinicia cada día.
// Si el correo (SMTP) o la conexión no están configurados, no hace nada y no molesta.

const { getPool } = require('../db');
const cfg = require('./biometriaConsumoConfig');
const consumo = require('./biometriaConsumo');

const CICLO_MS = Math.max(1, Math.min(60, parseInt(process.env.BIOMETRIA_ALERTA_CICLO_MIN || '5', 10) || 5)) * 60 * 1000;
const PRIMER_AVISO_MS = 2 * 60 * 1000;
const TZ = process.env.TZ_NEGOCIO || 'America/Bogota';
const PROVEEDORES = cfg.PROVEEDORES;
const FILAS_CLIENTES_CORREO = 10;

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (x) => Number(x).toLocaleString('es-CO');

async function correosAdmin(pool) {
  const { dominiosPermitidos } = require('./informes/correo');
  const permitidos = dominiosPermitidos();
  const [filas] = await pool.query("SELECT correo FROM usuarios WHERE rol = 'ADMIN_POD' AND activo = 1 AND correo IS NOT NULL AND correo <> ''");
  return [...new Set(filas.map((f) => String(f.correo).trim().toLowerCase()).filter((c) => permitidos.includes(c.split('@')[1])))];
}

// ---------------------------------------------------------------------------
// Qué alertas hay
// ---------------------------------------------------------------------------
/** Qué alertas hay HOY, a partir del tablero del día. [{ tipo, titulo, detalle }] */
function alertasDe(tablero) {
  const hoy = tablero.hoy;
  const out = [];
  const clientesHoy = tablero.diaria.find((d) => d.fecha === hoy);
  for (const prov of tablero.proveedores) {
    const l = prov.limite;
    if (!l || !l.avisar) continue; // solo avisan los proveedores con sobrecosto (OLIMPIA)
    const p = prov.proveedor;
    const dia = clientesHoy ? clientesHoy[p] : null;
    if (l.dia && dia && dia.clientesExceden > 0) {
      out.push({
        tipo: `cliD:${p}`, titulo: `${fmt(dia.clientesExceden)} cliente(s) de ${p} superaron ${fmt(l.dia)} consulta(s) hoy`,
        detalle: `Máximo ${fmt(dia.maxIntentos)} intentos en el día; consultas por encima del límite diario: ${fmt(dia.excedente)}.${l.sobrecostoDia !== null ? ` Sobrecosto estimado: $${fmt(l.sobrecostoDia)}.` : ''}`,
      });
    }
    const act = l.mesActual;
    if (l.mes && act && act.excedenHoy > 0) {
      out.push({
        tipo: `cliM:${p}`, titulo: `${fmt(act.excedenHoy)} cliente(s) de ${p} pasaron ${fmt(l.mes)} consulta(s) en el mes y siguieron consultando hoy`,
        detalle: `En ${act.mes} hay ${fmt(act.clientesExceden)} cliente(s) sobre el límite mensual (máximo ${fmt(act.maxIntentos)} consultas); consultas por encima del límite en el mes: ${fmt(act.excedente)}.${l.sobrecostoMes !== null ? ` Sobrecosto estimado del periodo: $${fmt(l.sobrecostoMes)}.` : ''}`,
      });
    }
  }
  for (const p of tablero.proveedores) {
    const c = p.cupo;
    if (!p.limite || !p.limite.avisar) continue; // un proveedor sin sobrecosto no alerta ni por cupos
    if (c.dia !== null && p.hoy > c.dia) {
      out.push({ tipo: `cupoD:${p.proveedor}`, titulo: `${p.proveedor} superó el cupo diario`, detalle: `Hoy lleva ${fmt(p.hoy)} consultas y el cupo diario es ${fmt(c.dia)} (exceso ${fmt(p.hoy - c.dia)}).` });
    }
    if (c.mes !== null && c.mesActual && c.mesActual.total > c.mes) {
      out.push({ tipo: `cupoM:${p.proveedor}`, titulo: `${p.proveedor} superó el cupo mensual`, detalle: `Lleva ${fmt(c.mesActual.total)} en ${c.mesActual.periodo} y el cupo mensual es ${fmt(c.mes)}${c.sobrecostoMes !== null ? ` (sobrecosto estimado $${fmt(c.sobrecostoMes)})` : ''}.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Estado (lo ya avisado)
// ---------------------------------------------------------------------------
/** Clave corta de un cliente sobre el límite: letra del proveedor + id en base 36 (con «m» si es el límite mensual). */
function claveCliente(c) {
  const id = Number(c.idCliente);
  const corto = Number.isSafeInteger(id) && id >= 0 ? id.toString(36) : String(c.idCliente).replace(/[^A-Za-z0-9]/g, '');
  // Los del límite mensual llevan «m» delante para no confundirlos con los del diario (el mismo cliente puede estar en ambos).
  return `${c.tipo === 'mes' ? 'm' : ''}${String(c.proveedor || '?')[0].toUpperCase()}${corto}`;
}

function leerEstado(firma, clientes, hoy) {
  let o = {};
  try { o = JSON.parse(firma || '{}') || {}; } catch { o = {}; }
  if (String(o.f || '') !== hoy) return { f: hoy, u: 0, k: [], n: 0, truncado: false, clientes: new Set(), vacio: true };
  const claves = String(clientes || '').split(',').filter(Boolean);
  return {
    f: hoy, u: Number(o.u) || 0, k: Array.isArray(o.k) ? o.k.map(String) : [], n: Number(o.n) || 0, truncado: !!o.t,
    clientes: new Set(claves), vacio: false,
  };
}

/** { firma, clientes } listos para guardar. Si los clientes no caben, se guardan los que quepan y se marca `t` (se compara por cantidad). */
function armarEstado({ hoy, ahoraMs, tipos, claves }) {
  const cap = cfg.CAPACIDAD_CLIENTES_AVISADOS;
  let texto = '';
  let truncado = false;
  for (const k of [...claves].sort()) {
    const sig = texto ? `${texto},${k}` : k;
    if (sig.length > cap) { truncado = true; break; }
    texto = sig;
  }
  const firma = JSON.stringify({ f: hoy, u: Math.floor(ahoraMs / 60000), k: tipos, n: claves.length, ...(truncado ? { t: 1 } : {}) });
  return { firma, clientes: texto };
}

/**
 * Decide si hoy toca enviar correo. Función pura (se prueba sin base de datos).
 * Devuelve { enviar, modo: 'nuevo'|'recordatorio'|'prueba', alertas: [{..., nueva}], clientes: [{..., nuevo}], nuevosClientes, motivoOmision }.
 */
function decidir({ alertas, excedidos, estado, ahoraMs, cadaMin, forzar = false }) {
  const claves = excedidos.map((c) => ({ c, k: claveCliente(c) }));
  const nuevosPorClave = (x) => (estado.truncado ? false : !estado.clientes.has(x.k));
  let nuevosClientes = claves.filter(nuevosPorClave).length;
  if (estado.truncado) nuevosClientes = Math.max(0, excedidos.length - estado.n);
  const conMarca = alertas.map((a) => ({ ...a, nueva: !estado.k.includes(a.tipo) }));
  const hayNuevo = conMarca.some((a) => a.nueva) || nuevosClientes > 0;
  const base = {
    alertas: conMarca,
    clientes: claves.map(({ c, k }) => ({ ...c, nuevo: estado.vacio || nuevosPorClave({ k }) })),
    nuevosClientes, primerAviso: !!estado.vacio,
  };
  if (forzar) return { ...base, enviar: true, modo: 'prueba' };
  if (!alertas.length) return { ...base, enviar: false, motivoOmision: 'sin alertas' };
  if (hayNuevo) return { ...base, enviar: true, modo: 'nuevo' };
  if (cadaMin > 0 && ahoraMs - estado.u * 60000 >= cadaMin * 60000) return { ...base, enviar: true, modo: 'recordatorio' };
  return { ...base, enviar: false, motivoOmision: cadaMin > 0 ? 'sin novedades (aún no toca el recordatorio)' : 'sin novedades (recordatorios desactivados)' };
}

// ---------------------------------------------------------------------------
// Correo
// ---------------------------------------------------------------------------
const textoCadaMin = (m) => {
  if (!m) return null;
  if (m < 60) return `${m} minutos`;
  if (m === 60) return '1 hora';
  if (m < 1440) return `${m / 60} horas`;
  return '24 horas';
};

const enmascarar = (doc) => {
  const d = String(doc || '').replace(/\s+/g, '');
  if (!d) return '—';
  return d.length <= 4 ? d : `••••${d.slice(-4)}`;
};

function horaLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

const MODOS = {
  nuevo: { color: '#b91c1c', suave: '#fef2f2', etiqueta: 'ALERTA NUEVA', titulo: 'Se detectó un posible sobrecosto en consultas de biometría' },
  recordatorio: { color: '#b45309', suave: '#fffbeb', etiqueta: 'RECORDATORIO', titulo: 'La alerta de consumo de biometría sigue activa' },
  prueba: { color: '#475569', suave: '#f1f5f9', etiqueta: 'CORREO DE PRUEBA', titulo: 'Así se verán las alertas de consumo de biometría' },
};

/** Asunto según el motivo: lo más importante primero y con números. */
function asuntoDe(modo, alertas) {
  const nuevas = alertas.filter((a) => a.nueva);
  const principal = (modo === 'nuevo' && nuevas.length ? nuevas : alertas)[0];
  const mas = (modo === 'nuevo' ? nuevas.length : alertas.length) - 1;
  const cola = mas > 0 ? ` (+${mas} más)` : '';
  if (modo === 'nuevo') return `[AXIS] Biometría · NUEVA alerta: ${principal.titulo}${cola}`;
  if (modo === 'recordatorio') return `[AXIS] Biometría · Sigue activa: ${principal.titulo}${cola}`;
  return `[AXIS] Biometría · Prueba de alerta: ${principal.titulo}${cola}`;
}

function correo({ tablero, decision, cadaMin }) {
  const m = MODOS[decision.modo];
  const { alertas } = decision;
  const lim = tablero.umbrales.limites || {};
  const textoLimites = PROVEEDORES.filter((p) => lim[p] && lim[p].avisar && (lim[p].dia || lim[p].mes)).map((p) => `${p}: ${lim[p].dia ? `${fmt(lim[p].dia)} por día` : 'sin límite diario'}${lim[p].mes ? ` y ${fmt(lim[p].mes)} por mes` : ''}`).join(' · ');
  const hoy = tablero.hoy;
  const ahora = new Date();
  const fechaBase = new Date(`${hoy}T12:00:00Z`).toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fechaLarga = fechaBase.charAt(0).toUpperCase() + fechaBase.slice(1);
  const horaGen = ahora.toLocaleTimeString('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

  const porProv = PROVEEDORES.map((p) => {
    const pr = tablero.proveedores.find((x) => x.proveedor === p) || {};
    const dia = tablero.diaria.find((d) => d.fecha === hoy)?.[p] || {};
    const viaApp = tablero.origenes.filter((o) => o.proveedor === p && o.canal === 1).reduce((a, o) => a + o.total, 0);
    const l = pr.limite || {};
    return {
      p, total: pr.hoy || 0, viaApp, reintentos: dia.reintentos || 0, cupoDia: pr.cupo?.dia ?? null, avisa: !!l.avisar,
      // Solo cuentan para el aviso los proveedores que alertan; ASISA se muestra pero sin «sobre el límite».
      clientes: l.avisar ? (dia.clientesExceden || 0) : 0, excedente: l.avisar ? (dia.excedente || 0) : 0,
      clientesMes: l.avisar ? (l.mesActual?.excedenHoy || 0) : 0, limiteDia: l.dia ?? null, limiteMes: l.mes ?? null,
    };
  });
  const totalHoy = porProv.reduce((a, x) => a + x.total, 0);
  const clientesSobre = porProv.reduce((a, x) => a + x.clientes, 0);
  const clientesSobreMes = porProv.reduce((a, x) => a + x.clientesMes, 0);
  const excedente = porProv.reduce((a, x) => a + x.excedente, 0);

  const nuevasAlertas = alertas.filter((a) => a.nueva).length;
  const intro = decision.modo === 'nuevo' && decision.primerAviso
    ? `Primer aviso de hoy: ${fmt(alertas.length)} alerta(s) activa(s)${clientesSobre || clientesSobreMes ? `, con ${fmt(clientesSobre + clientesSobreMes)} cliente(s) sobre el límite` : ''}.`
    : decision.modo === 'nuevo'
    ? `${nuevasAlertas ? `${fmt(nuevasAlertas)} alerta(s) nueva(s)` : ''}${nuevasAlertas && decision.nuevosClientes ? ' y ' : ''}${decision.nuevosClientes ? `${fmt(decision.nuevosClientes)} cliente(s) nuevo(s) sobre el límite` : ''} desde el último aviso.`
    : decision.modo === 'recordatorio'
      ? 'No hay novedades desde el último aviso, pero la situación sigue activa.'
      : 'Este es un correo de prueba enviado por un administrador: muestra lo que hay hoy y no cambia los avisos programados.';

  const kpi = (titulo, valor, nota, color) => `<td style="width:33.33%;padding:0 4px"><div style="border:1px solid #e2e8f0;border-top:3px solid ${color};border-radius:6px;padding:10px 12px;background:#fff"><div style="font-size:11px;color:#64748b">${esc(titulo)}</div><div style="font-size:22px;font-weight:700;color:#0f172a;margin-top:2px">${esc(valor)}</div><div style="font-size:11px;color:#64748b;margin-top:1px">${esc(nota)}</div></div></td>`;
  const kpis = `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 -4px"><tr>${[
    kpi('Consultas hoy', fmt(totalHoy), porProv.map((x) => `${x.p} ${fmt(x.total)}`).join(' · '), '#334155'),
    kpi('Clientes sobre el límite', fmt(clientesSobre + clientesSobreMes), textoLimites || 'límites desactivados', clientesSobre + clientesSobreMes ? m.color : '#16a34a'),
    kpi('Consultas de más hoy', fmt(excedente), 'por encima del límite diario por cliente', excedente ? m.color : '#16a34a'),
  ].join('')}</tr></table>`;

  const celda = 'padding:6px 8px;border-bottom:1px solid #e2e8f0';
  const tablaProv = `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:12px"><tr style="color:#64748b;text-align:left;background:#f8fafc"><th style="${celda}">Proveedor</th><th style="${celda};text-align:right">Hoy</th><th style="${celda};text-align:right">Desde app</th><th style="${celda};text-align:right">En reintento</th><th style="${celda};text-align:right">Sobre el límite (día / mes)</th></tr>${porProv.map((x) => `<tr><td style="${celda}"><b>${esc(x.p)}</b></td><td style="${celda};text-align:right">${fmt(x.total)}${x.cupoDia !== null ? ` <span style="color:#64748b">/ ${fmt(x.cupoDia)}</span>` : ''}</td><td style="${celda};text-align:right">${fmt(x.viaApp)}</td><td style="${celda};text-align:right">${fmt(x.reintentos)}</td>${x.avisa ? `<td style="${celda};text-align:right;${x.clientes || x.clientesMes ? `color:${m.color};font-weight:700` : ''}">${fmt(x.clientes)} / ${fmt(x.clientesMes)}</td>` : `<td style="${celda};text-align:right;color:#94a3b8">solo monitoreo</td>`}</tr>`).join('')}</table>`;

  const pastilla = (txt, fondo, color) => `<span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:.4px;padding:2px 7px;border-radius:10px;background:${fondo};color:${color};vertical-align:middle">${txt}</span>`;
  const bloqueAlertas = alertas.map((a) => `<div style="border-left:4px solid ${a.nueva || decision.modo === 'prueba' || decision.primerAviso ? m.color : '#94a3b8'};background:#f8fafc;padding:8px 12px;margin:0 0 8px;border-radius:0 6px 6px 0"><div style="font-weight:700;font-size:13px;color:#0f172a">${esc(a.titulo)} ${decision.modo === 'prueba' || decision.primerAviso ? '' : a.nueva ? pastilla('NUEVA', m.color, '#fff') : pastilla('SIGUE ACTIVA', '#e2e8f0', '#475569')}</div><div style="font-size:12px;color:#475569;margin-top:2px">${esc(a.detalle)}</div></div>`).join('');

  const lista = [...decision.clientes].sort((a, b) => b.intentos - a.intentos);
  const visibles = lista.slice(0, FILAS_CLIENTES_CORREO);
  const filasClientes = visibles.map((c) => `<tr><td style="${celda}">${esc(enmascarar(c.documento))}<br><span style="color:#64748b">${esc(c.nombre || 'Sin nombre')}</span></td><td style="${celda}">${esc(c.proveedor)}<br><span style="color:#64748b">${c.tipo === 'mes' ? `en el mes (límite ${fmt(c.limite)})` : `en el día (límite ${fmt(c.limite)})`}</span></td><td style="${celda};text-align:right"><b>${fmt(c.intentos)}</b> <span style="color:#64748b">(+${fmt(c.exceso)})</span></td><td style="${celda};text-align:right">${c.viaApp ? fmt(c.viaApp) : '—'}</td><td style="${celda};text-align:right">${esc(horaLocal(c.ultimoIntento))}</td><td style="${celda};text-align:right">${decision.modo === 'nuevo' && !decision.primerAviso && c.nuevo ? pastilla('NUEVO', m.color, '#fff') : ''}</td></tr>`).join('');
  const resto = lista.length - visibles.length;
  const tablaClientes = visibles.length
    ? `<div style="font-size:13px;font-weight:700;margin:18px 0 6px;color:#0f172a">Clientes sobre el límite</div><table role="presentation" style="width:100%;border-collapse:collapse;font-size:12px"><tr style="color:#64748b;text-align:left;background:#f8fafc"><th style="${celda}">Cliente</th><th style="${celda}">Proveedor</th><th style="${celda};text-align:right">Consultas</th><th style="${celda};text-align:right">Desde app</th><th style="${celda};text-align:right">Última</th><th style="${celda}"></th></tr>${filasClientes}</table>${resto > 0 ? `<div style="font-size:11px;color:#64748b;margin-top:6px">Y ${fmt(resto)} cliente(s) más; el listado completo está en AXIS. Los documentos se muestran parcialmente.</div>` : '<div style="font-size:11px;color:#64748b;margin-top:6px">Los documentos se muestran parcialmente. «(+n)» son las consultas por encima del límite (del día o del mes, según se indica).</div>'}`
    : '';

  const cada = textoCadaMin(cadaMin);
  const politica = cada
    ? `<b>Qué sigue:</b> un cliente o una alerta nueva se avisa de inmediato; si la situación continúa sin cambios, te lo recordaremos cada <b>${esc(cada)}</b>. Un administrador puede cambiar este intervalo en Biometría → Consumo y reusos → Configuración.`
    : '<b>Qué sigue:</b> los recordatorios están desactivados; solo recibirás un nuevo correo cuando aparezca un cliente o una alerta nueva. Se pueden activar en Biometría → Consumo y reusos → Configuración.';

  const url = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/+$/, '')}/biometria/consumo` : null;
  const boton = url ? `<div style="margin:18px 0 0"><a href="${esc(url)}" style="display:inline-block;background:${m.color};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">Abrir Consumo y reusos</a></div>` : '';

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:660px;margin:0 auto;color:#1e293b">
<div style="background:${m.color};color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
<div style="font-size:11px;letter-spacing:1.5px;opacity:.85">AXIS · BIOMETRÍA · CONSUMO Y REUSOS</div>
<div style="margin-top:6px"><span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:.8px;padding:2px 8px;border-radius:10px;background:rgba(255,255,255,.2)">${m.etiqueta}</span></div>
<div style="font-size:19px;font-weight:700;margin-top:6px;line-height:1.25">${esc(m.titulo)}</div>
<div style="font-size:12px;opacity:.9;margin-top:4px">${esc(fechaLarga)} · corte ${esc(horaGen)}</div></div>
<div style="border:1px solid #e2e8f0;border-top:0;padding:16px 20px;border-radius:0 0 10px 10px;background:#fff">
<p style="font-size:13px;color:#334155;margin:0 0 12px">${esc(intro)}</p>
${kpis}
<div style="font-size:13px;font-weight:700;margin:18px 0 6px;color:#0f172a">${alertas.length === 1 ? 'Alerta activa' : `Alertas activas (${alertas.length})`}</div>
${bloqueAlertas}
<div style="font-size:13px;font-weight:700;margin:18px 0 6px;color:#0f172a">Consumo de hoy por proveedor</div>
${tablaProv}
<div style="font-size:11px;color:#64748b;margin-top:6px">ASISA incluye los casos hechos desde la app (canal 1, reglas 1 y 99) y no tiene sobrecosto: solo se monitorea. OLIMPIA es todo lo demás (canal 0 WhoisWho y regla 0 desde la app) y es la que se alerta${textoLimites ? ` (${esc(textoLimites)})` : ''}.</div>
${tablaClientes}
<div style="background:${m.suave};border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;margin:18px 0 0;font-size:12px;color:#334155;line-height:1.45">${politica}</div>
${boton}
<p style="font-size:11px;color:#94a3b8;margin:16px 0 0">Mensaje automático de AXIS; no respondas a este correo.</p></div></div>`;

  const lineas = [
    `${m.etiqueta}: ${m.titulo}`, `${fechaLarga} · corte ${horaGen}`, '', intro, '',
    `Consultas hoy: ${fmt(totalHoy)} (${porProv.map((x) => `${x.p} ${fmt(x.total)}, ${fmt(x.viaApp)} desde app`).join(' · ')})`,
    `Clientes sobre el límite${textoLimites ? ` (${textoLimites})` : ''}: ${fmt(clientesSobre)} en el día, ${fmt(clientesSobreMes)} en el mes · consultas de más hoy: ${fmt(excedente)}`, '',
    'ALERTAS', ...alertas.map((a) => `- ${decision.modo !== 'prueba' && !decision.primerAviso ? (a.nueva ? '[NUEVA] ' : '[sigue activa] ') : ''}${a.titulo}: ${a.detalle}`),
  ];
  if (visibles.length) {
    lineas.push('', 'CLIENTES SOBRE EL LÍMITE', ...visibles.map((c) => `- ${enmascarar(c.documento)} ${c.nombre || ''} · ${c.proveedor} · ${fmt(c.intentos)} consultas ${c.tipo === 'mes' ? 'en el mes' : 'en el día'} (límite ${fmt(c.limite)}, +${fmt(c.exceso)})${c.viaApp ? `, ${fmt(c.viaApp)} desde app` : ''}${decision.modo === 'nuevo' && !decision.primerAviso && c.nuevo ? ' [NUEVO]' : ''}`));
    if (resto > 0) lineas.push(`  … y ${fmt(resto)} más (ver AXIS).`);
  }
  lineas.push('', cada ? `Qué sigue: lo nuevo se avisa de inmediato; si nada cambia, recordatorio cada ${cada}.` : 'Qué sigue: recordatorios desactivados; solo se avisa cuando aparezca algo nuevo.', url ? `Detalle: ${url}` : 'Detalle en AXIS → Biometría → Consumo y reusos.');
  return { asunto: asuntoDe(decision.modo, alertas), html, texto: lineas.join('\n') };
}

// ---------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------
/**
 * Evalúa hoy y envía si toca. `forzar`: manda ya, ignorando lo avisado y sin tocar el estado (prueba del ADMIN_POD).
 * Devuelve { enviado, modo, alertas, destinatarios } o { omitido: 'motivo' }. Nunca lanza.
 */
async function evaluar({ forzar = false } = {}) {
  try {
    const config = await cfg.obtenerInterna({ force: true });
    if (!forzar && !config.alerta) return { omitido: 'alertas apagadas' };
    if (!config.configurada) return { omitido: 'conexión sin configurar' };
    const { smtpConfigurado, enviarTexto } = require('./informes/correo');
    if (!smtpConfigurado()) return { omitido: 'correo (SMTP) sin configurar' };

    const hoy = consumo.hoyIso();
    const tablero = await consumo.generarTablero({ desde: hoy, hasta: hoy, forzar: true });
    const alertas = alertasDe(tablero);
    if (!alertas.length) return { omitido: 'sin alertas', alertas: [] };
    const excedidos = await consumo.excedidosDelDia(hoy, tablero.umbrales.limites);

    const ahoraMs = Date.now();
    const estado = leerEstado(config.ultimaAlerta, config.clientesAvisados, hoy);
    const decision = decidir({ alertas, excedidos, estado, ahoraMs, cadaMin: config.alertaCadaMin, forzar });
    if (!decision.enviar) return { omitido: decision.motivoOmision, alertas };

    const pool = await getPool();
    const destinatarios = await correosAdmin(pool);
    if (!destinatarios.length) return { omitido: 'ningún ADMIN_POD con correo corporativo válido', alertas };

    const { asunto, html, texto } = correo({ tablero, decision, cadaMin: config.alertaCadaMin });
    await enviarTexto({ destinatarios, asunto, html, texto });
    if (!forzar) {
      const nuevo = armarEstado({ hoy, ahoraMs, tipos: alertas.map((a) => a.tipo), claves: excedidos.map(claveCliente) });
      await cfg.registrarAlertaEnviada(nuevo.firma, nuevo.clientes);
    }
    return { enviado: true, modo: decision.modo, alertas: decision.alertas, destinatarios: destinatarios.length };
  } catch (error) {
    console.error('[biometria-consumo] No se pudo evaluar/enviar la alerta:', cfg.mensajeError(error));
    return { omitido: 'error', error: cfg.mensajeError(error) };
  }
}

let temporizador = null;
function iniciarProgramador() {
  if (temporizador) return;
  let enCurso = false;
  const ciclo = () => {
    if (enCurso) return; // un ciclo lento no se encima con el siguiente
    enCurso = true;
    evaluar().catch(() => { /* ya registrado */ }).finally(() => { enCurso = false; });
  };
  setTimeout(ciclo, PRIMER_AVISO_MS).unref();
  temporizador = setInterval(ciclo, CICLO_MS);
  temporizador.unref();
}

module.exports = {
  evaluar, iniciarProgramador,
  _prueba: { alertasDe, decidir, leerEstado, armarEstado, claveCliente, correo, asuntoDe, enmascarar, CICLO_MS },
};
