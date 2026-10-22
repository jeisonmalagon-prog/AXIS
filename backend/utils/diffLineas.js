// Diferencias línea a línea entre dos textos (algoritmo de Myers, O(ND)).
// Azure DevOps no entrega "diff unificado" por API; se calcula aquí comparando
// el contenido de las dos versiones del archivo.
//
// Devuelve { lineas: [{ tipo: 'igual'|'agregada'|'quitada', texto, n1, n2 }],
//            resumen: { agregadas, quitadas }, truncado }
// Las líneas iguales lejos de un cambio se recortan (contexto) en bloques
// { tipo: 'salto', cantidad } para que el visor no muestre archivos enteros.

const MAX_LINEAS = 6000;     // por lado
const MAX_D = 3000;          // máximo de ediciones que explora Myers
const CONTEXTO = 3;

function dividir(texto) {
  if (!texto) return [];
  const t = String(texto).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const l = t.split('\n');
  if (l.length && l[l.length - 1] === '') l.pop();
  return l;
}

// Myers: devuelve la lista de operaciones [{op:'=',a,b} | {op:'-',a} | {op:'+',b}] (índices 0-based)
function myers(a, b) {
  const N = a.length, M = b.length;
  const max = Math.min(N + M, MAX_D);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trazas = [];
  let encontrado = -1;
  for (let d = 0; d <= max; d++) {
    trazas.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { encontrado = d; break; }
    }
    if (encontrado >= 0) break;
  }
  if (encontrado < 0) return null; // demasiado distintos

  // Reconstrucción hacia atrás
  const ops = [];
  let x = N, y = M;
  for (let d = encontrado; d > 0; d--) {
    const vd = trazas[d];
    const k = x - y;
    let kPrev;
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) kPrev = k + 1; else kPrev = k - 1;
    const xPrev = vd[offset + kPrev];
    const yPrev = xPrev - kPrev;
    while (x > xPrev && y > yPrev) { ops.push({ op: '=', a: x - 1, b: y - 1 }); x--; y--; }
    if (x === xPrev) { ops.push({ op: '+', b: y - 1 }); y--; } else { ops.push({ op: '-', a: x - 1 }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ op: '=', a: x - 1, b: y - 1 }); x--; y--; }
  return ops.reverse();
}

function diffLineas(textoA, textoB) {
  let a = dividir(textoA), b = dividir(textoB);
  let truncado = false;
  if (a.length > MAX_LINEAS) { a = a.slice(0, MAX_LINEAS); truncado = true; }
  if (b.length > MAX_LINEAS) { b = b.slice(0, MAX_LINEAS); truncado = true; }

  // Recorta prefijo/sufijo común (acelera casi siempre)
  let ini = 0;
  while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++;
  let finA = a.length, finB = b.length;
  while (finA > ini && finB > ini && a[finA - 1] === b[finB - 1]) { finA--; finB--; }

  const medioA = a.slice(ini, finA), medioB = b.slice(ini, finB);
  let ops = myers(medioA, medioB);
  if (!ops) {
    // Muy distintos: todo el bloque central como quitado + agregado
    ops = [...medioA.map((_, i) => ({ op: '-', a: i })), ...medioB.map((_, i) => ({ op: '+', b: i }))];
    truncado = true;
  }

  const completo = [];
  for (let i = 0; i < ini; i++) completo.push({ tipo: 'igual', texto: a[i], n1: i + 1, n2: i + 1 });
  for (const o of ops) {
    if (o.op === '=') completo.push({ tipo: 'igual', texto: medioA[o.a], n1: ini + o.a + 1, n2: ini + o.b + 1 });
    else if (o.op === '-') completo.push({ tipo: 'quitada', texto: medioA[o.a], n1: ini + o.a + 1, n2: null });
    else completo.push({ tipo: 'agregada', texto: medioB[o.b], n1: null, n2: ini + o.b + 1 });
  }
  const colaN = a.length - finA;
  for (let i = 0; i < colaN; i++) completo.push({ tipo: 'igual', texto: a[finA + i], n1: finA + i + 1, n2: finB + i + 1 });

  const resumen = {
    agregadas: completo.filter((l) => l.tipo === 'agregada').length,
    quitadas: completo.filter((l) => l.tipo === 'quitada').length,
  };

  // Contexto: conserva solo las líneas cercanas a un cambio
  const mantener = new Array(completo.length).fill(false);
  completo.forEach((l, i) => {
    if (l.tipo !== 'igual') for (let j = Math.max(0, i - CONTEXTO); j <= Math.min(completo.length - 1, i + CONTEXTO); j++) mantener[j] = true;
  });
  const lineas = [];
  let omitidas = 0;
  completo.forEach((l, i) => {
    if (mantener[i]) {
      if (omitidas) { lineas.push({ tipo: 'salto', cantidad: omitidas }); omitidas = 0; }
      lineas.push(l);
    } else omitidas++;
  });
  if (omitidas && lineas.length) lineas.push({ tipo: 'salto', cantidad: omitidas });

  return { lineas, resumen, truncado, sinCambios: resumen.agregadas === 0 && resumen.quitadas === 0 };
}

module.exports = { diffLineas, dividir };
