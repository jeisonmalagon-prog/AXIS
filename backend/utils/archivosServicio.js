// Reconoce qué clase de archivo de consumo es (proyecto SoapUI, colección Postman…)
// para etiquetarlo en pantalla y validar que no esté corrupto. No ejecuta nada: solo lee texto.

const EXTENSIONES_VALIDAS = new Set(['xml', 'json', 'wsdl', 'xsd', 'yaml', 'yml', 'zip', 'txt']);

const ETIQUETAS_CLASE = {
  SOAPUI: 'Proyecto SoapUI',
  WSDL: 'WSDL',
  XSD: 'Esquema XSD',
  XML: 'XML',
  POSTMAN: 'Colección Postman',
  INSOMNIA: 'Exportación Insomnia',
  OPENAPI: 'OpenAPI / Swagger',
  JSON: 'JSON',
  YAML: 'YAML',
  ZIP: 'ZIP',
  TEXTO: 'Texto',
  OTRO: 'Archivo',
};

const MIME = {
  xml: 'application/xml', wsdl: 'application/xml', xsd: 'application/xml', json: 'application/json',
  yaml: 'application/yaml', yml: 'application/yaml', zip: 'application/zip', txt: 'text/plain',
};

function textoDe(buffer) {
  let t = buffer.toString('utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}

/** @returns {{clase: string, mime: string, error?: string}} */
function detectarClase(nombre, buffer) {
  const extension = String(nombre).includes('.') ? String(nombre).split('.').pop().toLowerCase() : '';
  const mime = MIME[extension] || 'application/octet-stream';

  if (extension === 'zip') {
    // Los ZIP empiezan con "PK".
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return { clase: 'OTRO', mime, error: 'El archivo no es un ZIP válido.' };
    return { clase: 'ZIP', mime };
  }

  const texto = textoDe(buffer);
  const inicio = texto.trimStart();

  if (extension === 'xml' || extension === 'wsdl' || extension === 'xsd') {
    if (!inicio.startsWith('<')) return { clase: 'OTRO', mime, error: 'El archivo no parece un XML válido (debe empezar con «<»).' };
    const muestra = texto.slice(0, 200000);
    if (/soapui-project|con:soapui/i.test(muestra)) return { clase: 'SOAPUI', mime };
    if (extension === 'wsdl' || /<(\w+:)?definitions[\s>]/i.test(muestra.slice(0, 5000)) && /wsdl/i.test(muestra.slice(0, 5000))) return { clase: 'WSDL', mime };
    if (extension === 'xsd' || /<(\w+:)?schema[\s>]/i.test(muestra.slice(0, 5000))) return { clase: 'XSD', mime };
    return { clase: 'XML', mime };
  }

  if (extension === 'json') {
    let obj;
    try { obj = JSON.parse(texto); } catch (_) { return { clase: 'OTRO', mime, error: 'El archivo no es un JSON válido.' }; }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      if (obj.info && Array.isArray(obj.item)) return { clase: 'POSTMAN', mime };
      if (obj._type === 'export' && Array.isArray(obj.resources)) return { clase: 'INSOMNIA', mime };
      if (obj.openapi || obj.swagger) return { clase: 'OPENAPI', mime };
    }
    return { clase: 'JSON', mime };
  }

  if (extension === 'yaml' || extension === 'yml') {
    if (/^\s*(openapi|swagger)\s*:/m.test(texto.slice(0, 5000))) return { clase: 'OPENAPI', mime };
    return { clase: 'YAML', mime };
  }

  return { clase: 'TEXTO', mime };
}

module.exports = { detectarClase, EXTENSIONES_VALIDAS, ETIQUETAS_CLASE };
