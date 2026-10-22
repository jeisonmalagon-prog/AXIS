// ============================================================================
// Versión de la app móvil que usa el cliente (visor de logs de App Móvil)
// ============================================================================
// LogApp no tiene una columna "versión": el dato viaja dentro de los textos
// libres de cada fila (Sesion, Adicional o Rq), normalmente como JSON. Como no
// hay un nombre de campo garantizado, se busca de forma tolerante:
//   1) claves "de la app" (deviceVersion -- la real en LogApp --, appVersion, versionApp, versionName…);
//   2) si no hay, claves genéricas (version, ver, build) con formato 1.2.3 -- nunca
//      las que hablan del equipo o del SO (osVersion, androidVersion…: no coinciden).
// Se pueden sumar nombres de clave propios con la variable de entorno
// LOGAPP_VERSION_KEYS (separados por coma), sin tocar el código.
// No se enmascara nada: la versión se muestra tal cual viene en el log.
// ============================================================================

const normalizar = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const CLAVES_APP = new Set([
  // En LogApp.Sesion la versión de la app viaja como "deviceVersion" (confirmado: {"device":"Infinix/X6850-OP/...","deviceVersion":"9.0.5",...}).
  'deviceversion',
  'appversion', 'versionapp', 'versionaplicacion', 'appversionname', 'appversioncode', 'versionname',
  'appver', 'versionmovil', 'mobileversion', 'clientversion', 'versioncliente', 'versionapk',
  'versionapplication', 'applicationversion', 'versionofapp', 'appbuild', 'appbuildnumber'
]);
const CLAVES_GENERICAS = new Set(['version', 'ver', 'build', 'buildnumber', 'versioncode']);

function clavesExtra() {
  return String(process.env.LOGAPP_VERSION_KEYS || '')
    .split(',').map(normalizar).filter(Boolean);
}

// Acepta "1.2.3", "v1.2.3", "5.4.0.123", "2024.10.1+45", "1.2.3 (45)". Rechaza fechas/IPs/ids largos.
function valorPareceVersion(v) {
  const s = String(v).trim();
  if (!s || s.length > 40) return false;
  if (!/^v?\d/i.test(s)) return false;
  if (/^\d{8,}$/.test(s)) return false;                 // ids / timestamps numéricos largos
  return /^v?\d+([.\-+_ ()][\w]+)*$/i.test(s);
}

function candidatos(texto) {
  const lista = [];
  if (!texto) return lista;
  // JSON doblemente codificado: \"clave\":\"valor\"  ->  "clave":"valor"
  const t = String(texto).replace(/\\"/g, '"');
  const reJson = /"([A-Za-z_][\w\- ]{0,40})"\s*:\s*(?:"([^"]{1,60})"|(-?\d+(?:\.\d+)*))/g;
  let m;
  while ((m = reJson.exec(t))) lista.push({ clave: m[1], valor: m[2] != null ? m[2] : m[3] });
  // clave=valor / clave: valor sin comillas (texto plano)
  const rePlano = /\b([A-Za-z_][\w\-]{2,30})\s*[=:]\s*(v?\d[\w.\-+]{0,30})/g;
  while ((m = rePlano.exec(t))) lista.push({ clave: m[1], valor: m[2] });
  return lista;
}

/**
 * Busca la versión de la app en uno o varios textos (en orden de preferencia).
 * @returns {{version: string, clave: string}|null}
 */
function extraerVersionApp(...textos) {
  const extra = new Set(clavesExtra());
  let generica = null;
  for (const texto of textos) {
    for (const c of candidatos(texto)) {
      const k = normalizar(c.clave);
      if (!valorPareceVersion(c.valor)) continue;
      if (CLAVES_APP.has(k) || extra.has(k)) return { version: String(c.valor).trim(), clave: c.clave };
      // Una clave genérica ("version") exige formato con punto (1.2.3): un entero suelto suele ser la versión del SO (ej. Android 13).
      if (!generica && CLAVES_GENERICAS.has(k) && /\./.test(String(c.valor))) {
        generica = { version: String(c.valor).trim(), clave: c.clave };
      }
    }
  }
  return generica;
}

/**
 * Resume los grupos {sesion, desde, hasta, n} (fechas "YYYY-MM-DD HH:mm:ss") en la línea de
 * tiempo de versiones del cliente: cada versión con su primera/última vez vista, cuántos
 * registros, el equipo (si se conoce), cuál es la actual y qué cambios hubo.
 */
function resumirVersiones(grupos, clasificarDispositivo) {
  const porVersion = new Map();
  let sinVersion = 0;
  let muestraSesion = null;
  let ultimaSinVersion = null;
  for (const g of grupos) {
    const hallada = extraerVersionApp(g.sesion);
    if (!hallada) {
      sinVersion += Number(g.n) || 0;
      if (!ultimaSinVersion || g.hasta > ultimaSinVersion.hasta) ultimaSinVersion = g;
      continue;
    }
    const clave = hallada.version;
    const dispositivo = describirEquipo(g.sesion) || (clasificarDispositivo ? clasificarDispositivo(g.sesion) : null);
    let v = porVersion.get(clave);
    if (!v) { v = { version: clave, campo: hallada.clave, desde: g.desde, hasta: g.hasta, registros: 0, dispositivos: new Set() }; porVersion.set(clave, v); }
    if (g.desde < v.desde) v.desde = g.desde;
    if (g.hasta > v.hasta) v.hasta = g.hasta;
    v.registros += Number(g.n) || 0;
    if (dispositivo) v.dispositivos.add(dispositivo);
  }
  if (ultimaSinVersion) muestraSesion = String(ultimaSinVersion.sesion || '').slice(0, 600);

  const versiones = [...porVersion.values()]
    .map((v) => ({ ...v, dispositivos: [...v.dispositivos] }))
    .sort((a, b) => (a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : 0));

  let actual = null;
  for (const v of versiones) if (!actual || v.hasta > actual.hasta) actual = v;

  // Cambios: de una versión a la siguiente en el tiempo (por primera vez vista).
  const cambios = [];
  for (let i = 1; i < versiones.length; i++) {
    cambios.push({ de: versiones[i - 1].version, a: versiones[i].version, fecha: versiones[i].desde });
  }
  // Convivencia: dos versiones vistas en paralelo (típico: el cliente usa dos equipos).
  let convivencia = false;
  for (let i = 0; i < versiones.length && !convivencia; i++) {
    for (let j = i + 1; j < versiones.length; j++) {
      if (versiones[j].desde <= versiones[i].hasta) { convivencia = true; break; }
    }
  }
  return {
    versiones,
    actual: actual ? actual.version : null,
    actualDesde: actual ? actual.desde : null,
    actualVistaUltimaVez: actual ? actual.hasta : null,
    cambios,
    cambioVersion: versiones.length > 1,
    convivencia,
    registrosSinVersion: sinVersion,
    muestraSesion,
    equipos: resumirEquipos(grupos)
  };
}

/**
 * Equipo legible a partir de Sesion.device, ej.
 * "Infinix/X6850-OP/Infinix-X6850:16/BP2A…/<guid>" -> "Infinix X6850-OP · Android 16".
 * Si no se puede interpretar devuelve null.
 */
function describirEquipo(sesionTexto) {
  if (!sesionTexto) return null;
  const m = /"device"\s*:\s*"([^"]+)"/.exec(String(sesionTexto).replace(/\\"/g, '"'));
  if (!m) return null;
  const partes = m[1].split('/');
  const primero = (partes[0] || '').trim();
  if (!primero) return null;
  if (/^iphone|^ipad/i.test(primero)) return primero;
  const modelo = (partes[1] || '').trim();
  const android = /:(\d{1,2})(?:\.\d+)*\//.exec(m[1]);
  const base = modelo ? `${primero} ${modelo}` : primero;
  return android ? `${base} · Android ${android[1]}` : base;
}

// ----------------------------------------------------------------------------
// Equipos de un cliente
// ----------------------------------------------------------------------------
// Sesion.device tiene esta forma (verificada con logs reales de Android y iPhone):
//   Android: marca/modelo/producto:versiónAndroid/build/…:user/release-keys[/<GUID de instalación>]
//   iPhone : iPhone17,2/<UUID del equipo>[/<GUID de instalación>]
// El GUID final es el de la INSTALACIÓN de la app (no cambia entre inicios de sesión; cambia si se
// reinstala) y no viene en todas las filas (p. ej. las de login). El equipo se identifica por el
// texto del device SIN ese GUID.
const RE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function leerDevice(sesionTexto) {
  if (!sesionTexto) return null;
  const m = /"device"\s*:\s*"([^"]+)"/.exec(String(sesionTexto).replace(/\\"/g, '"'));
  return m ? m[1] : null;
}

/** { equipo (legible), huella (id técnico del equipo), instalacion (GUID o null), plataforma } */
function identificarEquipo(sesionTexto) {
  const device = leerDevice(sesionTexto);
  if (!device) return null;
  const partes = device.split('/');
  let instalacion = null;
  if (partes.length > 1 && RE_GUID.test(partes[partes.length - 1])) {
    // En iPhone el 2.º segmento también es un UUID (del equipo): solo es "instalación" si hay un 3.º.
    const esIphone = /^iphone|^ipad/i.test(partes[0]);
    if (!esIphone || partes.length >= 3) instalacion = partes[partes.length - 1];
  }
  const huella = instalacion ? partes.slice(0, -1).join('/') : device;
  const plataforma = /^iphone|^ipad/i.test(partes[0]) ? 'iOS' : /release-keys|:\d{1,2}\//i.test(device) ? 'Android' : 'Otro';
  return { equipo: describirEquipo(sesionTexto), huella, instalacion, plataforma };
}

/**
 * Equipos que usó un cliente a partir de los grupos {sesion, desde, hasta, n}: cada equipo con
 * sus instalaciones de la app, versiones usadas y primera/última vez.
 */
function resumirEquipos(grupos) {
  const porEquipo = new Map();
  let sinDatoEquipo = 0;
  for (const g of grupos || []) {
    const id = identificarEquipo(g.sesion);
    if (!id) { sinDatoEquipo += Number(g.n) || 0; continue; }
    let e = porEquipo.get(id.huella);
    if (!e) { e = { equipo: id.equipo, huella: id.huella, plataforma: id.plataforma, desde: g.desde, hasta: g.hasta, registros: 0, instalaciones: new Map(), versiones: new Map() }; porEquipo.set(id.huella, e); }
    if (g.desde < e.desde) e.desde = g.desde;
    if (g.hasta > e.hasta) e.hasta = g.hasta;
    e.registros += Number(g.n) || 0;
    if (id.instalacion) {
      const i = e.instalaciones.get(id.instalacion) || { instalacion: id.instalacion, desde: g.desde, hasta: g.hasta };
      if (g.desde < i.desde) i.desde = g.desde;
      if (g.hasta > i.hasta) i.hasta = g.hasta;
      e.instalaciones.set(id.instalacion, i);
    }
    const v = extraerVersionApp(g.sesion);
    if (v) {
      const x = e.versiones.get(v.version) || { version: v.version, desde: g.desde, hasta: g.hasta, registros: 0 };
      if (g.desde < x.desde) x.desde = g.desde;
      if (g.hasta > x.hasta) x.hasta = g.hasta;
      x.registros += Number(g.n) || 0;
      e.versiones.set(v.version, x);
    }
  }
  const equipos = [...porEquipo.values()]
    .map((e) => ({
      equipo: e.equipo, huella: e.huella, plataforma: e.plataforma, desde: e.desde, hasta: e.hasta, registros: e.registros,
      instalaciones: [...e.instalaciones.values()].sort((a, b) => (a.desde < b.desde ? -1 : 1)),
      versiones: [...e.versiones.values()].sort((a, b) => (a.desde < b.desde ? -1 : 1))
    }))
    .sort((a, b) => (a.hasta < b.hasta ? 1 : -1));
  return { equipos, cantidad: equipos.length, registrosSinEquipo: sinDatoEquipo };
}

module.exports = { extraerVersionApp, resumirVersiones, valorPareceVersion, describirEquipo, identificarEquipo, resumirEquipos };
