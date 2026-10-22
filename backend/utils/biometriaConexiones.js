// Credenciales de MotorFirma y ORQBIOMETRIA ingresadas desde la pantalla Biometría.
//
// SON PERSONALES: lo que cada persona escribe vale SOLO PARA ELLA. Queda en la memoria del
// backend ligado a su usuario (sqlServer.establecerSesion), cifrado, vence solo (8 h) y no se
// guarda en ninguna base ni en el .env. Nadie más puede usarlo ni verlo. No existen credenciales
// compartidas: las que una versión anterior hubiera dejado guardadas (cifradas) en la base de AXIS
// YA NO SE USAN; el ADMIN_POD solo puede borrarlas (quitarConexion).
// Todo es para conectarse en SOLO LECTURA: el módulo nunca escribe en SQL Server.

const sql = require('./sqlServer');

const RE_HOST = /^[A-Za-z0-9_.\-\\]{1,200}$/;
const RE_IDENT = /^[A-Za-z0-9_$\- .]{1,128}$/;

// Devuelve { error } o { valor }. `existente`: { claveCifrada } si ya hay una clave en la sesión (se conserva si no se envía otra).
function validarConexion(entrada, existente) {
  const e = entrada || {};
  const v = {};
  v.servidor = String(e.servidor ?? '').trim();
  if (!v.servidor) return { error: 'El servidor es obligatorio.' };
  if (!RE_HOST.test(v.servidor)) return { error: 'El servidor solo puede tener letras, números, punto, guion y «\\» (instancia).' };

  const puerto = e.puerto === undefined || e.puerto === null || String(e.puerto).trim() === '' ? 1433 : parseInt(e.puerto, 10);
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) return { error: 'El puerto debe estar entre 1 y 65535.' };
  v.puerto = puerto;

  v.base = String(e.base ?? '').trim();
  if (v.base && !RE_IDENT.test(v.base)) return { error: 'El nombre de la base de datos no es válido.' };

  v.usuario = String(e.usuario ?? '').trim();
  if (!v.usuario || v.usuario.length > 128) return { error: 'El usuario es obligatorio (máx. 128 caracteres).' };

  const clave = e.clave === undefined || e.clave === null ? '' : String(e.clave);
  if (clave !== '') {
    if (clave.length > 256) return { error: 'La clave es demasiado larga.' };
    v.clave = clave;
  } else if (!existente?.claveCifrada) {
    return { error: 'La clave es obligatoria.' };
  }
  v.cifrado = !!e.cifrado;
  v.confiarCertificado = e.confiarCertificado === undefined ? true : !!e.confiarCertificado;
  return { valor: v };
}

// Datos de la conexión de TU sesión para la pantalla (nunca la clave).
function aPublico(perfil) {
  const resumen = sql.resumenConexion(perfil);
  const ses = sql.infoSesion(sql.usuarioActual(), perfil);
  const base = {
    perfil, nombre: resumen.nombre, origen: resumen.origen, configurada: resumen.configurada, faltan: resumen.faltan,
    servidor: resumen.servidor, puerto: resumen.puerto, base: resumen.base, windows: !!resumen.windows,
    enSesion: !!ses, sesionExpira: ses ? ses.expira : null, guardadaEnBd: false,
    usuario: null, tieneClave: false, claveFin: null, claveLegible: true, cifrado: false, confiarCertificado: true, deLaPantalla: !!ses,
  };
  if (!ses) return base;
  return {
    ...base, usuario: ses.usuario, tieneClave: ses.tieneClave, claveFin: ses.claveFin,
    cifrado: ses.cifrado, confiarCertificado: ses.confiarCertificado,
  };
}

// `admin`: el ADMIN_POD ve además si quedaron credenciales antiguas guardadas en la base (para borrarlas).
async function listarPublicas(almacen, { admin = false } = {}) {
  let antiguas = {};
  if (admin) {
    try { antiguas = await almacen.cargarConexiones(); } catch (_) { antiguas = {}; }
  }
  return Object.keys(sql.PERFILES).map((perfil) => ({ ...aPublico(perfil), guardadaEnBd: !!antiguas[perfil] }));
}

// Credenciales SOLO para la sesión de `usuarioApp` (memoria del backend; nada se guarda en bases ni en el .env).
function definirParaSesion(usuarioApp, perfil, valor) {
  const clave = valor.clave !== undefined ? valor.clave : sql.claveEnClaroSesion(usuarioApp, perfil);
  sql.establecerSesion(usuarioApp, perfil, {
    servidor: valor.servidor, puerto: valor.puerto, base: valor.base, usuario: valor.usuario, clave,
    cifrado: valor.cifrado, confiarCertificado: valor.confiarCertificado,
  });
}

// Limpieza de credenciales antiguas guardadas en la base de AXIS (también se borra la clave cifrada).
async function quitarConexion(almacen, perfil, usuario) {
  const guardadas = await almacen.cargarConexiones();
  if (!guardadas[perfil]) return false;
  delete guardadas[perfil];
  await almacen.guardarConexiones(guardadas, usuario);
  return true;
}

// Borrador para probar sin guardar: si no trae clave se usa la de TU sesión.
async function camposParaProbar(perfil, valor) {
  const campos = { ...valor };
  if (campos.clave === undefined) campos.clave = sql.claveEnClaroSesion(sql.usuarioActual(), perfil) || '';
  return campos;
}

module.exports = { definirParaSesion, validarConexion, listarPublicas, quitarConexion, camposParaProbar };
