// Certificados con los que AXIS ejecuta las pruebas de «Probar servicio».
//
//  - CLIENTE: certificado + llave privada (PFX/P12, o PEM con .crt/.pem + .key) para servicios que exigen
//    TLS mutuo (mTLS). El usuario elige cuál usar en cada envío.
//  - CA: certificado(s) de una entidad certificadora interna. AXIS los confía al validar el certificado del
//    servicio (resuelve «SELF_SIGNED_CERT_IN_CHAIN» sin tener que desactivar la verificación TLS).
//
// Seguridad:
//  - El contenido (incluida la llave privada y su clave) se guarda CIFRADO (AES-256-GCM) en la base de datos.
//    La clave de cifrado sale de SERVICIOS_CERT_SECRET (o, si no existe, de JWT_SECRET).
//  - Los secretos NUNCA se devuelven al navegador: solo se listan datos públicos (nombre, sujeto, vencimiento…).
//  - Cada certificado es ÚNICO de su dueño: solo lo ve, lo usa y lo borra quien lo subió (ni siquiera el ADMIN_POD
//    puede usar el de otra persona). Ya no se comparten. Subir y borrar los propios lo puede hacer cualquier usuario del
//    módulo, también con rol Consulta; en ese caso queda auditado con más detalle y se avisa al ADMIN_POD (ver
//    utils/auditoriaConsulta.js).
//  - Si la tabla ServiciosCertificadosConsumo no existe, el resto de Servicios sigue funcionando.

const crypto = require('crypto');
const tls = require('tls');
const { verifyToken, requireModule } = require('../middlewares/authMiddleware');
const { auditarServicios, alertarCritico } = require('../utils/auditoriaConsulta');

const MAX_ARCHIVO_BYTES = 1024 * 1024;
const MAX_CERTIFICADOS_POR_USUARIO = 30;
const MENSAJE_SIN_TABLA =
  'Para registrar certificados falta crear la tabla ServiciosCertificadosConsumo en la base de datos. ' +
  'Ejecuta una sola vez crear_tabla_certificados_consumo.sql.';

// ---------------------------------------------------------------- cifrado
let claveCache = null;
function claveDeCifrado() {
  if (claveCache) return claveCache;
  const secreto = process.env.SERVICIOS_CERT_SECRET || process.env.JWT_SECRET;
  if (!secreto) throw new Error('Falta SERVICIOS_CERT_SECRET (o JWT_SECRET) para cifrar los certificados.');
  claveCache = crypto.scryptSync(secreto, 'axis-servicios-certificados-v1', 32);
  return claveCache;
}

function cifrar(objeto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', claveDeCifrado(), iv);
  const datos = Buffer.concat([c.update(JSON.stringify(objeto), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), datos]).toString('base64');
}

function descifrar(texto) {
  const b = Buffer.from(texto, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', claveDeCifrado(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}

// ---------------------------------------------------------------- análisis de lo que se sube
const RE_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const RE_LLAVE = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

function soloSujeto(x) { return String(x || '').replace(/\n/g, ', ').slice(0, 400); }

function detallesDe(pem) {
  const x = new crypto.X509Certificate(pem);
  return {
    x509: x,
    sujeto: soloSujeto(x.subject),
    emisor: soloSujeto(x.issuer),
    huella: x.fingerprint256,
    venceEn: new Date(x.validTo),
  };
}

/**
 * Lee un PFX/P12 sin librerías externas: lo usa un servidor TLS local (loopback) y se consulta el certificado que presenta.
 * Devuelve sujeto, emisor, vencimiento y las CA incluidas en la cadena del PFX; null si no se pudo leer.
 */
function leerPfx(pfx, clave) {
  return new Promise((resolve) => {
    let srv; let cli; let hecho = false;
    const fin = (valor) => {
      if (hecho) return;
      hecho = true;
      clearTimeout(reloj);
      try { if (cli) cli.destroy(); } catch { /* nada */ }
      try { if (srv) srv.close(); } catch { /* nada */ }
      resolve(valor);
    };
    const reloj = setTimeout(() => fin(null), 4000);
    try {
      srv = tls.createServer({ pfx, passphrase: clave || undefined }, (sock) => { sock.on('error', () => {}); sock.end(); });
    } catch { return fin(null); }
    srv.on('error', () => fin(null));
    srv.on('tlsClientError', () => {});
    srv.listen(0, '127.0.0.1', () => {
      cli = tls.connect({ host: '127.0.0.1', port: srv.address().port, rejectUnauthorized: false, servername: 'localhost' }, () => {
        try {
          const cadena = [];
          const vistos = new Set();
          let c = cli.getPeerCertificate(true);
          while (c && c.raw && !vistos.has(c.fingerprint256)) {
            vistos.add(c.fingerprint256);
            cadena.push(new crypto.X509Certificate(c.raw));
            c = c.issuerCertificate;
          }
          if (!cadena.length) return fin(null);
          const hoja = cadena[0];
          fin({
            sujeto: soloSujeto(hoja.subject), emisor: soloSujeto(hoja.issuer), huella: hoja.fingerprint256,
            venceEn: new Date(hoja.validTo), cadena: cadena.slice(1).map((x) => x.toString()),
          });
        } catch { fin(null); }
      });
      cli.on('error', () => fin(null));
    });
  });
}

/**
 * @param {{nombreOriginal: string, contenidoBase64: string}[]} archivos
 * @returns {{tipo: 'CLIENTE'|'CA', formato: 'PFX'|'PEM', material: object, sujeto: string|null, emisor: string|null, huella: string|null, venceEn: Date|null}}
 */
async function analizar(archivos, clave) {
  if (!Array.isArray(archivos) || !archivos.length) throw new Error('Adjunta el archivo del certificado.');
  const buffers = archivos.map((a) => {
    const b = Buffer.from(String(a.contenidoBase64 || ''), 'base64');
    if (!b.length) throw new Error(`El archivo «${a.nombreOriginal}» está vacío.`);
    if (b.length > MAX_ARCHIVO_BYTES) throw new Error(`El archivo «${a.nombreOriginal}» supera 1 MB.`);
    return { nombre: String(a.nombreOriginal || ''), b };
  });
  const esTexto = (b) => b.subarray(0, 4096).toString('latin1').includes('-----BEGIN');

  // ---- PFX / P12 (binario) ----
  const binarios = buffers.filter((x) => !esTexto(x.b));
  if (binarios.length) {
    if (buffers.length > 1) throw new Error('Un archivo PFX/P12 se sube solo, sin otros archivos.');
    const pfx = binarios[0].b;
    try {
      tls.createSecureContext({ pfx, passphrase: clave || undefined });
    } catch (e) {
      throw new Error(/mac verify|password|passphrase/i.test(e.message)
        ? 'La contraseña del PFX es incorrecta.'
        : 'El archivo no es un PFX/P12 válido.');
    }
    const info = await leerPfx(pfx, clave);
    return {
      tipo: 'CLIENTE', formato: 'PFX',
      material: { pfx: pfx.toString('base64'), passphrase: clave || '', cadena: info ? info.cadena : [] },
      sujeto: info ? info.sujeto : null, emisor: info ? info.emisor : null,
      huella: info ? info.huella : crypto.createHash('sha256').update(pfx).digest('hex').toUpperCase().match(/.{2}/g).join(':'),
      venceEn: info ? info.venceEn : null,
    };
  }

  // ---- PEM (uno o varios archivos: certificado, cadena, llave) ----
  const texto = buffers.map((x) => x.b.toString('utf8')).join('\n');
  const certs = texto.match(RE_CERT) || [];
  const llavePem = (texto.match(RE_LLAVE) || [])[0];
  if (!certs.length) throw new Error('No se encontró ningún certificado (-----BEGIN CERTIFICATE-----) en los archivos.');

  const detalles = certs.map((c) => {
    try { return { pem: c, ...detallesDe(c) }; } catch { throw new Error('Uno de los certificados no se puede leer (PEM dañado).'); }
  });

  if (!llavePem) {
    const primero = detalles[0];
    const vence = new Date(Math.min(...detalles.map((d) => d.venceEn.getTime())));
    return {
      tipo: 'CA', formato: 'PEM', material: { ca: certs },
      sujeto: primero.sujeto, emisor: primero.emisor, huella: primero.huella, venceEn: vence,
    };
  }

  let llave;
  try {
    llave = crypto.createPrivateKey({ key: llavePem, passphrase: clave || undefined });
  } catch {
    throw new Error(clave ? 'La llave privada no se pudo abrir: revisa la contraseña.' : 'La llave privada está protegida: escribe su contraseña.');
  }
  const hoja = detalles.find((d) => d.x509.checkPrivateKey(llave));
  if (!hoja) throw new Error('La llave privada no corresponde a ninguno de los certificados.');
  const cadena = [hoja.pem, ...detalles.filter((d) => d !== hoja).map((d) => d.pem)].join('\n');
  return {
    tipo: 'CLIENTE', formato: 'PEM',
    material: { cert: cadena, key: llavePem, passphrase: clave || '' },
    sujeto: hoja.sujeto, emisor: hoja.emisor, huella: hoja.huella, venceEn: hoja.venceEn,
  };
}

// ---------------------------------------------------------------- acceso a datos
let estadoTabla = { lista: false, revisadoEn: 0 };
async function tablaLista(pool) {
  if (estadoTabla.lista) return true;
  if (Date.now() - estadoTabla.revisadoEn < 30 * 1000) return false;
  try {
    await pool.query('SELECT 1 FROM ServiciosCertificadosConsumo LIMIT 1');
    estadoTabla = { lista: true, revisadoEn: Date.now() };
    return true;
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') { estadoTabla = { lista: false, revisadoEn: Date.now() }; return false; }
    throw error;
  }
}

// Único por usuario: solo el dueño ve y usa su certificado (tampoco el ADMIN_POD usa los de otros).
const puedeVer = (fila, user) => fila.CreadoPorId === user.id;

function aMeta(fila, user) {
  return {
    Id: fila.Id, Nombre: fila.Nombre, Tipo: fila.Tipo, Formato: fila.Formato, Sujeto: fila.Sujeto, Emisor: fila.Emisor,
    Huella: fila.Huella, VenceEn: fila.VenceEn, Compartido: false,
    CreadoPorNombre: fila.CreadoPorNombre || null, FechaCreacion: fila.FechaCreacion,
    Propio: fila.CreadoPorId === user.id,
    Vencido: fila.VenceEn ? new Date(fila.VenceEn).getTime() < Date.now() : false,
  };
}

/**
 * Material TLS para ejecutar una petición: certificado de cliente elegido (si hay) y las CA visibles para el usuario.
 * @returns {{ opciones: object, nombreCliente: string|null }}
 */
async function materialTls(pool, user, certificadoId) {
  const opciones = {};
  let nombreCliente = null;
  let caDelPfx = [];
  if (!(await tablaLista(pool))) {
    if (certificadoId) throw Object.assign(new Error(MENSAJE_SIN_TABLA), { status: 400 });
    return { opciones, nombreCliente };
  }
  if (certificadoId) {
    const [[fila]] = await pool.query('SELECT * FROM ServiciosCertificadosConsumo WHERE Id = ?', [certificadoId]);
    if (!fila || !puedeVer(fila, user) || fila.Tipo !== 'CLIENTE') {
      throw Object.assign(new Error('El certificado elegido no existe o no tienes acceso a él.'), { status: 403 });
    }
    if (fila.VenceEn && new Date(fila.VenceEn).getTime() < Date.now()) {
      throw Object.assign(new Error(`El certificado «${fila.Nombre}» está vencido.`), { status: 400 });
    }
    let m;
    try { m = descifrar(fila.ContenidoCifrado); }
    catch {
      throw Object.assign(new Error(`No se pudo abrir el certificado «${fila.Nombre}» (¿cambió SERVICIOS_CERT_SECRET o JWT_SECRET?). Vuelve a subirlo.`), { status: 400 });
    }
    if (m.pfx) {
      opciones.pfx = Buffer.from(m.pfx, 'base64');
      // Las CA que vienen dentro del PFX se usan también para confiar en el servidor (como al importar el PFX en SoapUI).
      let cadena = m.cadena;
      if (cadena === undefined) { const i = await leerPfx(opciones.pfx, m.passphrase); cadena = i ? i.cadena : []; }
      caDelPfx = cadena || [];
    } else { opciones.cert = m.cert; opciones.key = m.key; }
    if (m.passphrase) opciones.passphrase = m.passphrase;
    nombreCliente = fila.Nombre;
  }
  const [cas] = await pool.query("SELECT * FROM ServiciosCertificadosConsumo WHERE Tipo = 'CA' AND CreadoPorId = ?", [user.id]);
  const pem = [];
  for (const c of cas) {
    if (!puedeVer(c, user)) continue;
    if (c.VenceEn && new Date(c.VenceEn).getTime() < Date.now()) continue;
    // Una CA ilegible (cambió la clave de cifrado) no debe impedir las demás pruebas.
    try { pem.push(...descifrar(c.ContenidoCifrado).ca); } catch { console.error(`No se pudo abrir la CA «${c.Nombre}»: vuelve a subirla.`); }
  }
  if (pem.length || caDelPfx.length) opciones.ca = [...tls.rootCertificates, ...pem, ...caDelPfx];
  return { opciones, nombreCliente };
}

/** Los PFX subidos antes de poder leerlos no tienen sujeto ni vencimiento: se completan una sola vez al listar. */
async function completarPfx(pool, filas) {
  const pendientes = filas.filter((f) => f.Formato === 'PFX' && !f.Sujeto).slice(0, 10);
  for (const f of pendientes) {
    try {
      const [[fila]] = await pool.query('SELECT ContenidoCifrado FROM ServiciosCertificadosConsumo WHERE Id = ?', [f.Id]);
      const m = descifrar(fila.ContenidoCifrado);
      const info = await leerPfx(Buffer.from(m.pfx, 'base64'), m.passphrase);
      if (!info) continue;
      m.cadena = info.cadena;
      await pool.query('UPDATE ServiciosCertificadosConsumo SET Sujeto = ?, Emisor = ?, Huella = ?, VenceEn = ?, ContenidoCifrado = ? WHERE Id = ?',
        [info.sujeto, info.emisor, info.huella, info.venceEn, cifrar(m), f.Id]);
      Object.assign(f, { Sujeto: info.sujeto, Emisor: info.emisor, Huella: info.huella, VenceEn: info.venceEn });
    } catch (e) { console.error(`No se pudo leer el PFX «${f.Nombre}»:`, e.message); }
  }
}

// ---------------------------------------------------------------- rutas
function registrar(router, { getPool }) {
  const base = '/consumo/certificados';

  router.get(base, verifyToken, requireModule('SERVICIOS'), async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.json({ disponible: false, mensaje: MENSAJE_SIN_TABLA, certificados: [] });
      const [filas] = await pool.query(
        `SELECT c.Id, c.Nombre, c.Tipo, c.Formato, c.Sujeto, c.Emisor, c.Huella, c.VenceEn, c.Compartido, c.CreadoPorId, c.FechaCreacion,
                u.nombre_completo AS CreadoPorNombre
           FROM ServiciosCertificadosConsumo c LEFT JOIN usuarios u ON u.id = c.CreadoPorId
          WHERE c.CreadoPorId = ?
          ORDER BY c.Tipo, c.Nombre`, [req.user.id]);
      const visibles = filas.filter((f) => puedeVer(f, req.user));
      await completarPfx(pool, visibles);
      return res.json({ disponible: true, certificados: visibles.map((f) => aMeta(f, req.user)) });
    } catch (error) {
      console.error('Error al listar certificados de consumo:', error);
      return res.status(500).json({ error: 'No se pudieron consultar los certificados.' });
    }
  });

  router.post(base, verifyToken, requireModule('SERVICIOS'), async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.status(400).json({ error: MENSAJE_SIN_TABLA });
      const nombre = String(req.body?.nombre || '').trim().slice(0, 120);
      if (!nombre) return res.status(400).json({ error: 'Ponle un nombre al certificado.' });

      const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM ServiciosCertificadosConsumo WHERE CreadoPorId = ?', [req.user.id]);
      if (total >= MAX_CERTIFICADOS_POR_USUARIO) return res.status(400).json({ error: `Llegaste al máximo de ${MAX_CERTIFICADOS_POR_USUARIO} certificados.` });

      let a;
      try { a = await analizar(req.body?.archivos, String(req.body?.clave || '')); }
      catch (e) { return res.status(400).json({ error: e.message }); }

      const compartido = 0; // los certificados son únicos de cada usuario: ya no se comparten
      const [r] = await pool.query(
        `INSERT INTO ServiciosCertificadosConsumo (Nombre, Tipo, Formato, Sujeto, Emisor, Huella, VenceEn, Compartido, ContenidoCifrado, CreadoPorId)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [nombre, a.tipo, a.formato, a.sujeto, a.emisor, a.huella, a.venceEn, compartido, cifrar(a.material), req.user.id]);

      const tipoTxt = a.tipo === 'CA' ? 'CA de confianza' : 'Certificado de cliente';
      await auditarServicios(pool, req, {
        entidad: 'Certificado de consumo', entidadId: String(r.insertId), entidadNombre: nombre,
        accion: 'CERTIFICADO_AGREGADO', detalle: `${tipoTxt} (${a.formato})`,
      }, [
        { campo: 'tipoCertificado', etiqueta: 'Tipo', nuevo: `${tipoTxt} (${a.formato})` },
        { campo: 'sujeto', etiqueta: 'Sujeto', nuevo: a.sujeto },
        { campo: 'emisor', etiqueta: 'Emisor', nuevo: a.emisor },
        { campo: 'huella', etiqueta: 'Huella SHA-256', nuevo: a.huella },
        { campo: 'venceEn', etiqueta: 'Vence', nuevo: a.venceEn ? new Date(a.venceEn).toISOString().slice(0, 10) : null },
        { campo: 'archivos', etiqueta: 'Archivos subidos', nuevo: (req.body?.archivos || []).map((x) => String(x.nombreOriginal || '').slice(0, 80)).join(', ') },
      ]);
      alertarCritico(pool, req, {
        tipo: 'CERTIFICADO', titulo: 'Un usuario Consulta cargó un certificado',
        filas: [['Certificado', `${nombre} — ${tipoTxt} (${a.formato})`], ['Sujeto', a.sujeto || '—'], ['Huella SHA-256', a.huella || '—'], ['Vence', a.venceEn ? new Date(a.venceEn).toISOString().slice(0, 10) : '—']],
      });

      const [[fila]] = await pool.query(
        `SELECT c.*, u.nombre_completo AS CreadoPorNombre FROM ServiciosCertificadosConsumo c LEFT JOIN usuarios u ON u.id = c.CreadoPorId WHERE c.Id = ?`, [r.insertId]);
      return res.status(201).json(aMeta(fila, req.user));
    } catch (error) {
      console.error('Error al guardar el certificado de consumo:', error);
      return res.status(500).json({ error: 'No se pudo guardar el certificado.' });
    }
  });

  router.delete(`${base}/:cid`, verifyToken, requireModule('SERVICIOS'), async (req, res) => {
    try {
      const pool = await getPool();
      if (!(await tablaLista(pool))) return res.status(400).json({ error: MENSAJE_SIN_TABLA });
      const [[fila]] = await pool.query('SELECT Id, Nombre, Tipo, CreadoPorId, Compartido FROM ServiciosCertificadosConsumo WHERE Id = ?', [req.params.cid]);
      if (!fila || !puedeVer(fila, req.user)) return res.status(404).json({ error: 'El certificado no existe.' });
      await pool.query('DELETE FROM ServiciosCertificadosConsumo WHERE Id = ?', [fila.Id]);
      const tipoTxt = fila.Tipo === 'CA' ? 'CA de confianza' : 'Certificado de cliente';
      await auditarServicios(pool, req, {
        entidad: 'Certificado de consumo', entidadId: String(fila.Id), entidadNombre: fila.Nombre,
        accion: 'CERTIFICADO_ELIMINADO', detalle: `${tipoTxt} eliminado`,
      });
      alertarCritico(pool, req, {
        tipo: 'CERTIFICADO', titulo: 'Un usuario Consulta eliminó un certificado',
        filas: [['Certificado', `${fila.Nombre} — ${tipoTxt}`]],
      });
      return res.status(204).send();
    } catch (error) {
      console.error('Error al eliminar el certificado de consumo:', error);
      return res.status(500).json({ error: 'No se pudo eliminar el certificado.' });
    }
  });
}

module.exports = { registrar, materialTls, _prueba: { analizar, cifrar, descifrar, leerPfx } };
