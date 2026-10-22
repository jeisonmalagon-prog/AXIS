// Lector mínimo de ZIP/JAR/WAR en memoria: solo para sacar de un .jar/.war los archivos que se piden (p. ej. el
// keystore.p12 que Spring Boot guarda en «classpath:»). Sin dependencias. No descomprime nada que no se pida y
// limita lo que descomprime (protección contra «zip bombs»).
//
// No soporta ZIP64 ni entradas cifradas: en ese caso devuelve un aviso y ninguna entrada.

const zlib = require('zlib');

const FIRMA_EOCD = 0x06054b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_LOCAL = 0x04034b50;

/**
 * @param {Buffer} buf  contenido del zip
 * @param {object} o
 * @param {(nombre:string, tamano:number)=>boolean} o.quiere  ¿se extrae esta entrada?
 * @param {number} [o.maxBytesEntrada]  tope de bytes descomprimidos por entrada
 * @param {number} [o.maxEntradas]  tope de entradas del directorio central que se recorren
 * @returns {{entradas: {nombre:string, datos:Buffer}[], aviso: string|null}}
 */
function leerZip(buf, { quiere, maxBytesEntrada = 2 * 1024 * 1024, maxEntradas = 200000 } = {}) {
  const salida = { entradas: [], aviso: null };
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.readUInt32LE(0) !== FIRMA_LOCAL) { salida.aviso = 'No es un ZIP/JAR válido'; return salida; }

  // Fin del directorio central: se busca desde el final (el comentario puede medir hasta 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === FIRMA_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) { salida.aviso = 'ZIP dañado (sin directorio central)'; return salida; }
  let total = buf.readUInt16LE(eocd + 10);
  let tamCentral = buf.readUInt32LE(eocd + 12);
  let offCentral = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || tamCentral === 0xffffffff || offCentral === 0xffffffff) { salida.aviso = 'ZIP64 no soportado'; return salida; }
  if (offCentral + tamCentral > buf.length) { salida.aviso = 'ZIP dañado (directorio central fuera de rango)'; return salida; }

  let pos = offCentral;
  let n = 0;
  while (pos + 46 <= buf.length && n < Math.min(total, maxEntradas)) {
    if (buf.readUInt32LE(pos) !== FIRMA_CENTRAL) break;
    n += 1;
    const flags = buf.readUInt16LE(pos + 8);
    const metodo = buf.readUInt16LE(pos + 10);
    const tamComp = buf.readUInt32LE(pos + 20);
    const tamReal = buf.readUInt32LE(pos + 24);
    const lonNombre = buf.readUInt16LE(pos + 28);
    const lonExtra = buf.readUInt16LE(pos + 30);
    const lonComentario = buf.readUInt16LE(pos + 32);
    const offLocal = buf.readUInt32LE(pos + 42);
    const nombre = buf.subarray(pos + 46, pos + 46 + lonNombre).toString('utf8');
    pos += 46 + lonNombre + lonExtra + lonComentario;

    if (nombre.endsWith('/') || tamReal === 0 || tamReal > maxBytesEntrada) continue;
    if (!quiere(nombre, tamReal)) continue;
    if (flags & 1) continue; // cifrada
    if (offLocal + 30 > buf.length || buf.readUInt32LE(offLocal) !== FIRMA_LOCAL) continue;
    const inicio = offLocal + 30 + buf.readUInt16LE(offLocal + 26) + buf.readUInt16LE(offLocal + 28);
    if (inicio + tamComp > buf.length) continue;
    const crudo = buf.subarray(inicio, inicio + tamComp);
    try {
      if (metodo === 0) salida.entradas.push({ nombre, datos: Buffer.from(crudo) });
      else if (metodo === 8) salida.entradas.push({ nombre, datos: zlib.inflateRawSync(crudo, { maxOutputLength: maxBytesEntrada }) });
    } catch { /* entrada dañada o más grande de lo declarado: se omite */ }
  }
  return salida;
}

module.exports = { leerZip };
