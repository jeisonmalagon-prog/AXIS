// Lectura de certificados desde archivos (PEM, DER/CRT/CER, PFX/P12 y JKS) y desde la propia conexión TLS.
//
// REGLAS DE SEGURIDAD (importan más que cualquier otra cosa en este archivo):
//   - Solo se extraen CERTIFICADOS (la parte pública). Las llaves privadas NUNCA se descifran, se copian ni se
//     devuelven: en PFX los «bags» de llave se saltan sin abrirse, en JKS se salta el bloque de la llave y en
//     PEM solo se recortan los bloques «CERTIFICATE».
//   - Las contraseñas llegan por parámetro, se usan en memoria y no se guardan ni se escriben en ningún log.
//
// Sin dependencias externas: el PKCS#12 se lee con un lector ASN.1 mínimo (ver abajo).
// Las funciones no tocan red ni base de datos.

const crypto = require('crypto');
const { descifrarRc2Cbc } = require('./rc2Descifrar');

// ---------------------------------------------------------------- información de un certificado
function valorDn(dn, clave) {
  const m = String(dn || '').match(new RegExp(`(?:^|\\n)${clave}=([^\\n]*)`));
  return m ? m[1].trim() : null;
}

const aHex = (texto) => String(texto || '').replace(/[^0-9a-f]/gi, '').toUpperCase();

/** Datos de un certificado X.509 (DER o PEM). Devuelve null si no se puede leer. */
function infoCertificado(entrada) {
  let x;
  try { x = new crypto.X509Certificate(entrada); } catch { return null; }
  const desde = new Date(x.validFrom);
  const hasta = new Date(x.validTo);
  if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) return null;
  const sujeto = String(x.subject || '').split('\n').join(', ');
  const emisor = String(x.issuer || '').split('\n').join(', ');
  const cn = valorDn(x.subject, 'CN') || valorDn(x.subject, 'O') || sujeto || null;
  let algoritmo = null;
  try {
    const k = x.publicKey;
    const d = k.asymmetricKeyDetails || {};
    algoritmo = k.asymmetricKeyType === 'rsa' ? `RSA ${d.modulusLength || ''}`.trim()
      : k.asymmetricKeyType === 'ec' ? `EC ${d.namedCurve || ''}`.trim() : String(k.asymmetricKeyType || '').toUpperCase();
  } catch { /* clave pública no soportada: se omite */ }
  const san = x.subjectAltName
    ? String(x.subjectAltName).split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/i, '')).filter(Boolean)
    : [];
  return {
    cn,
    sujeto,
    emisor,
    emisorCn: valorDn(x.issuer, 'CN') || valorDn(x.issuer, 'O') || emisor || null,
    serie: aHex(x.serialNumber).replace(/^0+(?=.)/, ''),
    thumbprint: aHex(x.fingerprint),
    sha256: aHex(x.fingerprint256),
    desde: desde.toISOString().slice(0, 10),
    hasta: hasta.toISOString().slice(0, 10),
    venceEn: hasta.toISOString(),
    esCA: !!x.ca,
    autofirmado: x.subject === x.issuer,
    san,
    algoritmo,
  };
}

// ---------------------------------------------------------------- PEM / JKS
const RE_CERT_PEM = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

/** Solo los bloques CERTIFICATE de un texto PEM (las llaves, aunque estén en el mismo archivo, se ignoran). */
function certificadosDePem(texto) {
  const salida = [];
  let m;
  RE_CERT_PEM.lastIndex = 0;
  while ((m = RE_CERT_PEM.exec(texto))) {
    const der = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    if (der.length) salida.push(der);
  }
  return salida;
}

/** Java KeyStore (JKS/JCEKS): los certificados van en claro; el bloque de la llave privada se salta sin leerlo. */
function certificadosDeJks(buf) {
  const certs = [];
  let tieneLlave = false;
  let pos = 8;
  const u2 = () => { const v = buf.readUInt16BE(pos); pos += 2; return v; };
  const u4 = () => { const v = buf.readUInt32BE(pos); pos += 4; return v; };
  const version = buf.readUInt32BE(4);
  const cuenta = u4();
  const leerCert = (hoja) => {
    if (version === 2) { const n = u2(); pos += n; } // tipo de certificado ("X.509")
    const largo = u4();
    if (largo < 0 || pos + largo > buf.length) throw new Error('JKS dañado');
    certs.push({ der: Buffer.from(buf.subarray(pos, pos + largo)), hoja });
    pos += largo;
  };
  if (cuenta > 100000) throw new Error('JKS dañado');
  for (let i = 0; i < cuenta; i += 1) {
    const tag = u4();
    const largoAlias = u2();
    pos += largoAlias;     // alias
    pos += 8;              // fecha de creación
    if (tag === 1) {       // llave privada + cadena de certificados
      tieneLlave = true;
      const largoLlave = u4();
      pos += largoLlave;   // la llave (cifrada) se salta sin leerla
      const n = u4();
      for (let k = 0; k < n; k += 1) leerCert(k === 0); // el primero de la cadena es el del servidor
    } else if (tag === 2) { // certificado de confianza
      leerCert(false);
    } else {
      break;               // entrada de otro tipo (JCEKS con llaves secretas): no se sigue
    }
  }
  return { certs, tieneLlave };
}

// ---------------------------------------------------------------- ASN.1 mínimo (BER/DER)
function nodo(buf, pos, limite = buf.length) {
  if (pos + 2 > limite) throw new Error('ASN.1 truncado');
  const b0 = buf[pos];
  let p = pos + 1;
  let tag = b0 & 0x1f;
  if (tag === 0x1f) { tag = 0; let b; do { b = buf[p]; p += 1; tag = (tag << 7) | (b & 0x7f); } while (b & 0x80 && p < limite); }
  const cons = !!(b0 & 0x20);
  const cls = b0 >> 6;
  let l = buf[p]; p += 1;
  if (l === 0x80) {
    if (!cons) throw new Error('ASN.1 inválido');
    // longitud indefinida: se recorren los hijos hasta el «00 00»
    const hijos = [];
    let q = p;
    while (true) {
      if (q + 2 > limite) throw new Error('ASN.1 truncado');
      if (buf[q] === 0 && buf[q + 1] === 0) break;
      const h = nodo(buf, q, limite);
      hijos.push(h);
      q = h.sig;
    }
    return { buf, tag, cls, cons, ini: p, fin: q, sig: q + 2, hijosPre: hijos };
  }
  if (l & 0x80) {
    const n = l & 0x7f;
    if (n > 4 || p + n > limite) throw new Error('ASN.1 inválido');
    l = 0;
    for (let i = 0; i < n; i += 1) { l = (l * 256) + buf[p]; p += 1; }
  }
  if (p + l > limite) throw new Error('ASN.1 truncado');
  return { buf, tag, cls, cons, ini: p, fin: p + l, sig: p + l };
}

function hijos(n) {
  if (n.hijosPre) return n.hijosPre;
  const lista = [];
  let p = n.ini;
  while (p < n.fin) { const h = nodo(n.buf, p, n.fin); lista.push(h); p = h.sig; }
  return lista;
}

const bytes = (n) => n.buf.subarray(n.ini, n.fin);
const esUniv = (n, tag) => n.cls === 0 && n.tag === tag;

function oid(n) {
  const b = bytes(n);
  if (!b.length) return '';
  const partes = [];
  let v = 0;
  for (let i = 0; i < b.length; i += 1) {
    v = (v * 128) + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { partes.push(v); v = 0; }
  }
  const primero = partes.shift();
  const a = primero < 40 ? 0 : primero < 80 ? 1 : 2;
  return [a, primero - (a * 40), ...partes].join('.');
}

function entero(n) {
  const b = bytes(n);
  let v = 0;
  for (let i = 0; i < b.length && i < 6; i += 1) v = (v * 256) + b[i];
  return v;
}

/** OCTET STRING (también en forma «construida» por tramos). */
function octetos(n) {
  if (!n.cons) return bytes(n);
  return Buffer.concat(hijos(n).map(octetos));
}

/** Contenido «explícito» [0] de un ContentInfo o bag. */
function explicito(n) {
  const h = hijos(n);
  return h.length ? h[0] : null;
}

const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  certBag: '1.2.840.113549.1.12.10.1.3',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  keyBagCifrada: '1.2.840.113549.1.12.10.1.2',
  safeContentsBag: '1.2.840.113549.1.12.10.1.6',
  x509: '1.2.840.113549.1.9.22.1',
  friendlyName: '1.2.840.113549.1.9.20',
  localKeyId: '1.2.840.113549.1.9.21',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
};
const PBE_PKCS12 = {
  '1.2.840.113549.1.12.1.3': { cifrador: 'des-ede3-cbc', clave: 24, rc2: null },
  '1.2.840.113549.1.12.1.4': { cifrador: 'des-ede-cbc', clave: 16, rc2: null },
  '1.2.840.113549.1.12.1.5': { cifrador: 'rc2', clave: 16, rc2: 128 },
  '1.2.840.113549.1.12.1.6': { cifrador: 'rc2', clave: 5, rc2: 40 },
};
const CIFRADO_PBES2 = {
  '2.16.840.1.101.3.4.1.2': { cifrador: 'aes-128-cbc', clave: 16 },
  '2.16.840.1.101.3.4.1.22': { cifrador: 'aes-192-cbc', clave: 24 },
  '2.16.840.1.101.3.4.1.42': { cifrador: 'aes-256-cbc', clave: 32 },
  '1.2.840.113549.3.7': { cifrador: 'des-ede3-cbc', clave: 24 },
};
const PRF = {
  '1.2.840.113549.2.7': 'sha1', '1.2.840.113549.2.8': 'sha224', '1.2.840.113549.2.9': 'sha256',
  '1.2.840.113549.2.10': 'sha384', '1.2.840.113549.2.11': 'sha512',
};
const HASH_MAC = {
  '1.3.14.3.2.26': { h: 'sha1', u: 20, v: 64 },
  '2.16.840.1.101.3.4.2.4': { h: 'sha224', u: 28, v: 64 },
  '2.16.840.1.101.3.4.2.1': { h: 'sha256', u: 32, v: 64 },
  '2.16.840.1.101.3.4.2.2': { h: 'sha384', u: 48, v: 128 },
  '2.16.840.1.101.3.4.2.3': { h: 'sha512', u: 64, v: 128 },
};

// ---------------------------------------------------------------- PKCS#12: derivación de claves (RFC 7292, apéndice B)
function kdfPkcs12(hash, contrasenaBmp, sal, iteraciones, id, n) {
  const { h, u, v } = hash;
  const D = Buffer.alloc(v, id);
  const repetir = (b) => {
    if (!b.length) return Buffer.alloc(0);
    const largo = v * Math.ceil(b.length / v);
    const r = Buffer.alloc(largo);
    for (let i = 0; i < largo; i += 1) r[i] = b[i % b.length];
    return r;
  };
  const I = Buffer.concat([repetir(sal), repetir(contrasenaBmp)]);
  const bloques = Math.ceil(n / u);
  const salida = [];
  for (let i = 0; i < bloques; i += 1) {
    let A = crypto.createHash(h).update(Buffer.concat([D, I])).digest();
    for (let k = 1; k < iteraciones; k += 1) A = crypto.createHash(h).update(A).digest();
    salida.push(A);
    if (i === bloques - 1) break;
    const B = Buffer.alloc(v);
    for (let k = 0; k < v; k += 1) B[k] = A[k % u];
    for (let j = 0; j < I.length; j += v) {
      let acarreo = 1;
      for (let k = v - 1; k >= 0; k -= 1) {
        const suma = I[j + k] + B[k] + acarreo;
        I[j + k] = suma & 0xff;
        acarreo = suma >> 8;
      }
    }
  }
  return Buffer.concat(salida).subarray(0, n);
}
const HASH_SHA1 = HASH_MAC['1.3.14.3.2.26'];

/** Contraseña candidata en las dos formas que usa PKCS#12 (la vacía tiene dos variantes legítimas). */
function candidatos(claves) {
  const lista = [
    { utf8: Buffer.alloc(0), bmp: Buffer.alloc(0), orig: -1 },
    { utf8: Buffer.alloc(0), bmp: Buffer.from([0, 0]), orig: -1 },
  ];
  const vistos = new Set(['']);
  (claves || []).forEach((c, orig) => {
    const t = String(c ?? '');
    if (!t || t.length > 256 || vistos.has(t)) return;
    vistos.add(t);
    const bmp = Buffer.alloc(t.length * 2 + 2);
    for (let i = 0; i < t.length; i += 1) bmp.writeUInt16BE(t.charCodeAt(i), i * 2);
    lista.push({ utf8: Buffer.from(t, 'utf8'), bmp, orig });
  });
  return lista;
}

/** Descifra un «EncryptedContentInfo». Devuelve el texto claro, o null si la contraseña no sirve o el algoritmo no se soporta. */
function descifrarContenido(alg, cifrado, cand) {
  try {
    const algOid = oid(hijos(alg)[0]);
    const params = hijos(alg)[1];
    if (algOid === OID.pbes2) {
      const [kdf, esquema] = hijos(params);
      const [kdfOid, kdfParams] = hijos(kdf);
      if (oid(kdfOid) !== OID.pbkdf2) return null;
      const partes = hijos(kdfParams);
      const sal = octetos(partes[0]);
      const iter = entero(partes[1]);
      let resto = partes.slice(2);
      let largoClave = null;
      if (resto.length && esUniv(resto[0], 2)) { largoClave = entero(resto[0]); resto = resto.slice(1); }
      const prf = resto.length ? (PRF[oid(hijos(resto[0])[0])] || null) : 'sha1';
      if (!prf) return null;
      const [esqOid, esqIv] = hijos(esquema);
      const cif = CIFRADO_PBES2[oid(esqOid)];
      if (!cif) return null;
      const clave = crypto.pbkdf2Sync(cand.utf8, sal, iter, largoClave || cif.clave, prf);
      const d = crypto.createDecipheriv(cif.cifrador, clave, octetos(esqIv));
      return Buffer.concat([d.update(cifrado), d.final()]);
    }
    const pbe = PBE_PKCS12[algOid];
    if (!pbe) return null; // p. ej. RC4: no se soporta
    const [salNodo, iterNodo] = hijos(params);
    const sal = octetos(salNodo);
    const iter = entero(iterNodo);
    const clave = kdfPkcs12(HASH_SHA1, cand.bmp, sal, iter, 1, pbe.clave);
    const iv = kdfPkcs12(HASH_SHA1, cand.bmp, sal, iter, 2, 8);
    if (pbe.cifrador === 'rc2') return descifrarRc2Cbc(cifrado, clave, iv, pbe.rc2);
    const d = crypto.createDecipheriv(pbe.cifrador, clave, iv);
    return Buffer.concat([d.update(cifrado), d.final()]);
  } catch {
    return null;
  }
}

function verificarMac(macData, contenido, cand) {
  try {
    const [digestInfo, sal, iterNodo] = hijos(macData);
    const [algNodo, digestNodo] = hijos(digestInfo);
    const hash = HASH_MAC[oid(hijos(algNodo)[0])];
    if (!hash) return null; // algoritmo no soportado: no se puede saber
    const iter = iterNodo ? entero(iterNodo) : 1;
    const clave = kdfPkcs12(hash, cand.bmp, octetos(sal), iter, 3, hash.u);
    const calculado = crypto.createHmac(hash.h, clave).update(contenido).digest();
    const esperado = octetos(digestNodo);
    return calculado.length === esperado.length && crypto.timingSafeEqual(calculado, esperado);
  } catch {
    return null;
  }
}

function atributos(setNodo) {
  const r = {};
  if (!setNodo) return r;
  for (const a of hijos(setNodo)) {
    const [idNodo, valores] = hijos(a);
    const id = oid(idNodo);
    const v = hijos(valores)[0];
    if (!v) continue;
    if (id === OID.friendlyName) {
      const b = bytes(v);
      let t = '';
      for (let i = 0; i + 1 < b.length; i += 2) t += String.fromCharCode(b.readUInt16BE(i));
      r.nombre = t;
    } else if (id === OID.localKeyId) {
      r.localKeyId = bytes(v).toString('hex');
    }
  }
  return r;
}

/** Recorre los «SafeBag»: junta los certificados y solo anota si hay llaves (sin abrirlas). */
function recorrerBags(contenido, salida) {
  const bags = hijos(nodo(contenido, 0));
  for (const bag of bags) {
    const partes = hijos(bag);
    const tipo = oid(partes[0]);
    const valor = partes[1] ? explicito(partes[1]) : null;
    const attrs = atributos(partes[2]);
    if (tipo === OID.certBag && valor) {
      const [certId, certValor] = hijos(valor);
      if (oid(certId) === OID.x509 && certValor) {
        const der = octetos(explicito(certValor));
        salida.certs.push({ der: Buffer.from(der), nombre: attrs.nombre || null, localKeyId: attrs.localKeyId || null });
      }
    } else if (tipo === OID.keyBag || tipo === OID.keyBagCifrada) {
      salida.tieneLlave = true;
      if (attrs.localKeyId) salida.llavesIds.add(attrs.localKeyId);
    } else if (tipo === OID.safeContentsBag && valor) {
      recorrerBags(Buffer.from(octetos(valor)), salida);
    }
  }
}

/**
 * Lee los certificados de un PFX/P12 sin tocar la llave privada.
 * @returns {{certs: {der: Buffer, nombre: string|null, hoja: boolean}[], tieneLlave: boolean, protegido: boolean, claveUsada: boolean, error: string|null}}
 */
function certificadosDePkcs12(buf, claves = []) {
  const salida = { certs: [], tieneLlave: false, llavesIds: new Set(), protegido: false, claveUsada: false, claveIndice: -1, error: null };
  let seguras;
  let contenidoAuth;
  let macData = null;
  try {
    const raiz = nodo(buf, 0);
    const partes = hijos(raiz);
    if (partes.length < 2 || !esUniv(partes[0], 2)) throw new Error('no es PKCS#12');
    const [tipoNodo, cuerpo] = hijos(partes[1]);
    if (oid(tipoNodo) !== OID.data) { salida.error = 'PFX con firma de clave pública (no soportado)'; return limpiar(salida); }
    contenidoAuth = Buffer.from(octetos(explicito(cuerpo)));
    seguras = hijos(nodo(contenidoAuth, 0));
    macData = partes[2] || null;
  } catch {
    salida.error = 'No es un PFX/P12 válido o está dañado';
    return limpiar(salida);
  }

  const lista = candidatos(claves);
  // Qué contraseña es la buena: la que verifica el MAC (si el archivo trae MAC).
  let elegida = null;
  if (macData) {
    for (const c of lista) { if (verificarMac(macData, contenidoAuth, c) === true) { elegida = c; break; } }
    if (elegida && elegida.orig >= 0) { salida.claveUsada = true; salida.claveIndice = elegida.orig; }
  }
  const intentos = elegida ? [elegida] : lista;

  for (const ci of seguras) {
    try {
      const [tipoNodo, cuerpo] = hijos(ci);
      const tipo = oid(tipoNodo);
      if (tipo === OID.data) {
        recorrerBags(Buffer.from(octetos(explicito(cuerpo))), salida);
      } else if (tipo === OID.encryptedData) {
        const ed = explicito(cuerpo);
        const eci = hijos(ed)[1];
        const [, alg, cifNodo] = hijos(eci);
        const cifrado = Buffer.from(octetos(cifNodo));
        let claro = null;
        for (const c of intentos) {
          const intento = descifrarContenido(alg, cifrado, c);
          if (!intento) continue;
          try { nodo(intento, 0); } catch { continue; } // basura: contraseña equivocada
          claro = intento;
          salida.claveUsada = salida.claveUsada || !!(c.utf8.length);
          if (c.orig >= 0 && salida.claveIndice < 0) salida.claveIndice = c.orig;
          break;
        }
        if (claro) recorrerBags(claro, salida); else salida.protegido = true;
      }
    } catch {
      salida.protegido = true;
    }
  }
  return limpiar(salida);
}

function limpiar(s) {
  const certs = s.certs.map((c) => ({ ...c, hoja: !!(c.localKeyId && s.llavesIds.has(c.localKeyId)) }));
  return { certs, tieneLlave: s.tieneLlave, protegido: s.protegido, claveUsada: s.claveUsada, claveIndice: s.claveIndice, error: s.error };
}

// ---------------------------------------------------------------- punto de entrada: un archivo cualquiera
const EXT_CERT = /\.(pem|crt|cer|cert|der|pfx|p12|jks|keystore|truststore)$/i;

/** ¿Vale la pena traer este archivo del contenedor? (por extensión; las llaves «.key» nunca) */
function nombreInteresa(nombre) {
  return EXT_CERT.test(String(nombre || ''));
}

/**
 * @param {string} nombre  nombre del archivo (solo para el aviso)
 * @param {Buffer} buf     contenido
 * @param {string[]} claves contraseñas a probar (solo PFX), en memoria
 * @returns {{formato: string, certificados: object[], tieneLlave: boolean, protegido: boolean, claveUsada: boolean, error: string|null}}
 */
function leerArchivoCertificados(nombre, buf, claves = []) {
  const vacio = (formato, extra = {}) => ({ formato, certificados: [], tieneLlave: false, protegido: false, claveUsada: false, claveIndice: -1, error: null, ...extra });
  if (!buf || !buf.length) return vacio('?', { error: 'Archivo vacío' });
  const enInfo = (ders) => ders.map((d) => (Buffer.isBuffer(d) ? { der: d } : d))
    .map((d) => ({ ...d, info: infoCertificado(d.der) })).filter((d) => d.info);

  // JKS / JCEKS
  if (buf.length > 12 && (buf.readUInt32BE(0) === 0xfeedfeed || buf.readUInt32BE(0) === 0xcececece)) {
    try {
      const { certs, tieneLlave } = certificadosDeJks(buf);
      return vacio('JKS', { certificados: enInfo(certs), tieneLlave });
    } catch (e) { return vacio('JKS', { error: e.message }); }
  }
  // PEM
  if (buf.subarray(0, Math.min(buf.length, 8192)).toString('latin1').includes('-----BEGIN')) {
    const ders = certificadosDePem(buf.toString('latin1'));
    const tieneLlave = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(buf.toString('latin1'));
    return vacio('PEM', { certificados: enInfo(ders), tieneLlave });
  }
  // DER suelto (.crt/.cer/.der)
  const suelto = infoCertificado(buf);
  if (suelto) return vacio('DER', { certificados: [{ der: buf, info: suelto }] });
  // PFX / P12
  if (buf[0] === 0x30) {
    const r = certificadosDePkcs12(buf, claves);
    return vacio('PFX', {
      certificados: enInfo(r.certs), tieneLlave: r.tieneLlave, protegido: r.protegido, claveUsada: r.claveUsada, claveIndice: r.claveIndice, error: r.error,
    });
  }
  return vacio('?', { error: 'Formato no reconocido' });
}

module.exports = {
  infoCertificado, certificadosDePem, certificadosDeJks, certificadosDePkcs12, leerArchivoCertificados, nombreInteresa,
  aHex,
};
