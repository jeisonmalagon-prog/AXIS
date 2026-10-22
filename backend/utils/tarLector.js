// Lector de archivos TAR por trozos (streaming) — lo que devuelve Docker en GET /containers/{id}/archive.
//
// Está pensado para NO guardar de más: de cada entrada solo se conserva el contenido si el llamador lo pide
// (por nombre y tamaño); todo lo demás se descarta al vuelo. Así se puede recorrer una carpeta grande sin
// llenar la memoria, y las llaves privadas («.key») nunca llegan a quedar en memoria.
//
// Soporta ustar, cabeceras PAX (x) y nombres largos de GNU (L). Enlaces simbólicos y dispositivos se ignoran.

class LectorTar {
  /**
   * @param {object} o
   * @param {(e:{nombre:string,tamano:number,tipo:string})=>boolean} o.quiere  ¿se guarda el contenido de este archivo?
   * @param {(e:{nombre:string,tamano:number}, datos:Buffer)=>void} o.alArchivo  recibe el archivo completo
   * @param {number} [o.maxEntradas]  tope de entradas leídas (protege contra carpetas enormes)
   */
  constructor({ quiere, alArchivo, maxEntradas = 20000 }) {
    this.quiere = quiere;
    this.alArchivo = alArchivo;
    this.maxEntradas = maxEntradas;
    this.pendiente = Buffer.alloc(0);
    this.estado = 'cabecera';
    this.entradas = 0;
    this.archivos = 0;
    this.terminado = false;
    this.excedido = false;
    this.nombreLargo = null;
    this.pax = null;
    this.actual = null;
  }

  static octal(b) {
    // Campo numérico: texto octal o, si el primer byte tiene el bit alto, binario base-256.
    if (b[0] & 0x80) {
      let v = b[0] & 0x7f;
      for (let i = 1; i < b.length; i += 1) v = (v * 256) + b[i];
      return v;
    }
    const t = b.toString('latin1').replace(/\0.*$/, '').trim();
    return t ? parseInt(t, 8) : 0;
  }

  static texto(b) {
    const i = b.indexOf(0);
    return b.subarray(0, i === -1 ? b.length : i).toString('utf8');
  }

  /** Procesa un trozo. Devuelve false cuando ya no hace falta seguir leyendo. */
  escribir(trozo) {
    if (this.terminado) return false;
    this.pendiente = this.pendiente.length ? Buffer.concat([this.pendiente, trozo]) : trozo;
    for (;;) {
      if (this.estado === 'cabecera') {
        if (this.pendiente.length < 512) break;
        const cab = this.pendiente.subarray(0, 512);
        this.pendiente = this.pendiente.subarray(512);
        if (cab.every((x) => x === 0)) { this.terminado = true; return false; }
        this.entradas += 1;
        if (this.entradas > this.maxEntradas) { this.excedido = true; this.terminado = true; return false; }
        const tipo = String.fromCharCode(cab[156] || 48);
        const tamano = LectorTar.octal(cab.subarray(124, 136));
        let nombre = LectorTar.texto(cab.subarray(0, 100));
        const prefijo = LectorTar.texto(cab.subarray(345, 500));
        if (prefijo && cab.subarray(257, 262).toString('latin1') === 'ustar') nombre = `${prefijo}/${nombre}`;
        const relleno = (512 - (tamano % 512)) % 512;
        if (tipo === 'L' || tipo === 'x' || tipo === 'g') {
          this.actual = { meta: tipo, tamano, relleno, partes: [], leido: 0 };
          this.estado = 'meta';
        } else {
          if (this.nombreLargo) { nombre = this.nombreLargo; this.nombreLargo = null; }
          let tam = tamano;
          if (this.pax) {
            if (this.pax.path) nombre = this.pax.path;
            if (this.pax.size !== undefined && Number.isFinite(Number(this.pax.size))) tam = Number(this.pax.size);
            this.pax = null;
          }
          const esArchivo = tipo === '0' || tipo === '\0' || tipo === '7';
          const guardar = esArchivo && this.quiere({ nombre, tamano: tam, tipo });
          const rell = (512 - (tam % 512)) % 512;
          this.actual = { nombre, tamano: tam, relleno: rell, guardar, partes: [], leido: 0, esArchivo };
          this.estado = tam > 0 && esArchivo ? 'datos' : 'saltar';
          if (this.estado === 'saltar') this.actual.saltar = tam + rell; // directorios y enlaces: normalmente 0
          if (!tam && esArchivo && guardar) { this.archivos += 1; this.alArchivo({ nombre, tamano: 0 }, Buffer.alloc(0)); }
          if (this.estado === 'saltar' && this.actual.saltar === 0) this.estado = 'cabecera';
        }
      } else if (this.estado === 'meta') {
        const a = this.actual;
        const faltan = a.tamano + a.relleno - a.leido;
        if (!this.pendiente.length) break;
        const toma = Math.min(faltan, this.pendiente.length);
        a.partes.push(this.pendiente.subarray(0, toma));
        a.leido += toma;
        this.pendiente = this.pendiente.subarray(toma);
        if (a.leido < a.tamano + a.relleno) break;
        const datos = Buffer.concat(a.partes).subarray(0, a.tamano);
        if (a.meta === 'L') this.nombreLargo = LectorTar.texto(datos);
        else if (a.meta === 'x') this.pax = LectorTar.analizarPax(datos);
        this.actual = null;
        this.estado = 'cabecera';
      } else if (this.estado === 'datos') {
        const a = this.actual;
        const faltan = a.tamano + a.relleno - a.leido;
        if (!this.pendiente.length) break;
        const toma = Math.min(faltan, this.pendiente.length);
        if (a.guardar) a.partes.push(this.pendiente.subarray(0, toma));
        a.leido += toma;
        this.pendiente = this.pendiente.subarray(toma);
        if (a.leido < a.tamano + a.relleno) break;
        if (a.guardar) {
          this.archivos += 1;
          this.alArchivo({ nombre: a.nombre, tamano: a.tamano }, Buffer.concat(a.partes).subarray(0, a.tamano));
        }
        this.actual = null;
        this.estado = 'cabecera';
      } else { // saltar
        const a = this.actual;
        if (!this.pendiente.length) break;
        const toma = Math.min(a.saltar, this.pendiente.length);
        a.saltar -= toma;
        this.pendiente = this.pendiente.subarray(toma);
        if (a.saltar > 0) break;
        this.actual = null;
        this.estado = 'cabecera';
      }
    }
    return true;
  }

  static analizarPax(datos) {
    const r = {};
    const t = datos.toString('utf8');
    let i = 0;
    while (i < t.length) {
      const sp = t.indexOf(' ', i);
      if (sp === -1) break;
      const largo = parseInt(t.slice(i, sp), 10);
      if (!Number.isFinite(largo) || largo <= 0) break;
      const registro = Buffer.from(t.slice(i), 'utf8').subarray(0, largo).toString('utf8');
      const m = registro.match(/^\d+ ([^=]+)=([\s\S]*)\n$/);
      if (m) r[m[1]] = m[2];
      // Avanza por caracteres equivalentes a «largo» bytes.
      let bytesAvanzados = 0; let k = i;
      while (k < t.length && bytesAvanzados < largo) { bytesAvanzados += Buffer.byteLength(t[k], 'utf8'); k += 1; }
      i = k;
    }
    return r;
  }
}

module.exports = { LectorTar };
