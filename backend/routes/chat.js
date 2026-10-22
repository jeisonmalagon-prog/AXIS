const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { verifyToken } = require('../middlewares/authMiddleware');
const { permisosVigentes } = require('../utils/permisosModulos');
const { MODULOS_VALIDOS } = require('../utils/modulos');
const {
  nuevoIdConversacion,
  guardarMensaje,
  obtenerConversaciones,
  obtenerHistorialConversacion
} = require('../utils/asistenteHistorial');
const {
  TEMAS,
  MODULOS_INFO,
  ADMIN_ONLY_INFO,
  normalizar,
  bloqueATexto,
  extraerPalabrasClave,
  extraerIps,
  detectarTemas,
  nombresDeModulos,
  obtenerDatosDeTema
} = require('../utils/asistenteTemas');
const openWebUi = require('../utils/openWebUi');

// ==========================================================================
// ASISTENTE IA (Ollama) -- CONTEXTO POR TEMAS Y POR MÓDULOS
// ==========================================================================
// Cada mensaje del usuario se compara contra una lista de "temas" (ver
// utils/asistenteTemas.js): aplicaciones, servidores, sub-aplicativos,
// certificados, servicios ACE, apuntamientos, validación de nodos, tareas,
// pasos a producción, F5, n8n, App Móvil, monitoreo, etc. Solo se consultan y
// se envían a Ollama los temas que calzan con la pregunta -- así puede
// responder sobre MUCHAS tablas sin mandarle todo el inventario en cada
// mensaje (el prompt sería enorme y las respuestas lentísimas sin GPU).
//
// PERMISOS: cada tema pertenece a uno o varios módulos de la app. El
// asistente SOLO consulta y responde con los temas de los módulos que el
// usuario tiene habilitados (mismo criterio que requireModule en las
// pantallas); si pregunta por un módulo que no tiene, se le dice que no tiene
// acceso en vez de darle datos. Los datos por usuario (tareas) solo traen lo
// suyo, igual que su pantalla.
//
// Sigue la regla de este proyecto de "nunca borrar, solo leer": todas las
// consultas son SELECT; el asistente no modifica nada.

const MAX_TEMAS_POR_MENSAJE = 3;
const MAX_CARACTERES_CONTEXTO = 9000; // ~2.800 tokens: cabe en num_ctx junto al resto del prompt

// Configuración de Ollama (variables de entorno, con los valores de siempre
// por defecto):
//   OLLAMA_URL    http://localhost:11434
//   OLLAMA_MODEL  qwen2.5:7b  (debe estar descargado: `ollama pull qwen2.5:7b`;
//                 la opción más liviana es llama3.2:3b-instruct-q4_K_M)
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 180000;

// Modelo a usar: si el configurado (OLLAMA_MODEL) no está descargado en ESE
// servidor Ollama, Ollama responde 404 y antes el usuario solo veía "Error
// interno de la IA". Ahora se consulta /api/tags (con caché de 5 min) y, si
// falta, se usa el mejor modelo de chat que sí esté instalado.
const PREFERENCIA_MODELOS = ['qwen2.5', 'qwen3', 'llama3.3', 'llama3.1', 'llama3.2', 'llama3', 'mistral', 'gemma', 'phi', 'deepseek', 'qwen'];
let cacheModelo = { hasta: 0, modelo: null, instalados: [] };

async function resolverModeloOllama() {
  const ahora = Date.now();
  if (cacheModelo.modelo && cacheModelo.hasta > ahora) return cacheModelo;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const datos = await r.json();
    const instalados = (datos.models || []).map((m) => m.name || m.model).filter(Boolean)
      .filter((n) => !/embed|rerank|bge|nomic/i.test(n));
    const base = (n) => String(n).toLowerCase();
    let elegido = instalados.find((n) => base(n) === base(OLLAMA_MODEL))
      || instalados.find((n) => base(n) === base(OLLAMA_MODEL) + ':latest');
    if (!elegido) {
      for (const pref of PREFERENCIA_MODELOS) {
        elegido = instalados.find((n) => base(n).startsWith(pref));
        if (elegido) break;
      }
      elegido = elegido || instalados[0] || null;
      if (elegido) console.warn(`Ollama: el modelo "${OLLAMA_MODEL}" no está instalado en ${OLLAMA_URL}; se usa "${elegido}". Define OLLAMA_MODEL para fijar uno.`);
    }
    cacheModelo = { hasta: ahora + 5 * 60 * 1000, modelo: elegido, instalados };
    return cacheModelo;
  } catch (err) {
    // Si /api/tags no responde se intenta igual con el modelo configurado; el
    // error real (conexión, etc.) lo reporta la llamada de chat.
    return { hasta: 0, modelo: OLLAMA_MODEL, instalados: [], error: err.message };
  }
}

// ==========================================================================
// DATOS "EN VIVO" DE OTROS MÓDULOS (F5, n8n, App Móvil)
// ==========================================================================
// Se piden solo cuando la pregunta es de ese módulo y el usuario lo tiene
// habilitado. Si la fuente no responde, el tema queda con una nota y el chat
// sigue funcionando.
async function datosF5() {
  const { cargarDispositivosF5, obtenerVirtualesConEstado } = require('../utils/f5Cliente');
  const pool = await getPool();
  const filas = [];
  for (const dispositivo of cargarDispositivosF5()) {
    let virtuales;
    try {
      virtuales = await obtenerVirtualesConEstado(dispositivo);
    } catch (err) {
      filas.push({ equipo: dispositivo.nombre, error: 'El F5 no respondio a la consulta' });
      continue;
    }
    const alias = new Map();
    try {
      const [a] = await pool.query('SELECT virtual_full_path, alias FROM f5_alias WHERE dispositivo_id = ?', [dispositivo.id]);
      a.forEach((x) => alias.set(x.virtual_full_path, x.alias));
    } catch (err) { /* los alias son opcionales */ }

    const arriba = virtuales.filter((v) => String(v.estado).includes('available')).length;
    const abajo = virtuales.filter((v) => String(v.estado).includes('offline')).length;
    filas.push({
      equipo: dispositivo.nombre,
      virtual_servers_total: virtuales.length,
      arriba,
      abajo,
      conexiones_abiertas_total: virtuales.reduce((s, v) => s + (Number(v.conexionesActuales) || 0), 0)
    });
    for (const v of virtuales) {
      filas.push({
        virtual_server: alias.get(v.fullPath) || v.nombre,
        nombre_tecnico: alias.get(v.fullPath) ? v.nombre : undefined,
        destino: v.destino,
        pool: v.pool,
        estado: v.estado,
        conexiones_abiertas: v.conexionesActuales,
        nodos_habilitados: v.nodosTotal !== null ? `${v.nodosArriba}/${v.nodosTotal}` : undefined,
        nodos: (v.nodos || []).map((n) => `${n.direccion} (${n.estado})`)
      });
    }
  }
  return filas;
}

const proveedores = {
  f5: () => datosF5().catch((err) => { console.warn('Asistente: no se pudo leer el F5:', err.message); return null; }),
  // n8n depende del usuario: solo ve los flujos que el ADMIN_POD le asignó.
  n8n: (user) => Promise.resolve()
    .then(() => require('./n8n').resumenParaAsistente(user))
    .catch((err) => { console.warn('Asistente: no se pudo leer n8n:', err.message); return null; }),
  appMovil: () => Promise.resolve()
    .then(() => require('./appMovil').resumenParaAsistente())
    .catch((err) => { console.warn('Asistente: no se pudo leer App Movil:', err.message); return null; })
};

// ==========================================================================
// BUSQUEDA LIBRE POR NOMBRE
// ==========================================================================
// Los TEMAS se activan por palabras GENERICAS ("servidor", "certificado"...).
// Pero muchas preguntas nombran algo PUNTUAL (una aplicación, un código de
// servicio, un hostname, un sub-aplicativo) que no calza con ninguna palabra
// genérica. Esto busca las palabras más distintivas de la pregunta como texto
// libre en los nombres -- SOLO en lo que el usuario puede ver según sus módulos.
async function buscarCoincidenciasPorNombre(pool, pregunta, modulos) {
  const vacio = { coincidencias: [], huboCoincidenciaAppOServicio: false, huboCoincidenciaSubAplicativo: false };
  const palabras = extraerPalabrasClave(pregunta);
  if (palabras.length === 0) return vacio;

  const tiene = (...ms) => ms.some((m) => modulos.includes(m));
  const comodines = palabras.map((p) => `%${p}%`);

  try {
    let apps = [];
    let servicios = [];
    let servidores = [];
    let subAplicativos = [];

    if (tiene('CERTIFICADOS', 'SERVIDORES')) {
      [apps] = await pool.query(
        `SELECT 'aplicacion' AS tipo, Nombre AS nombre FROM Aplicaciones WHERE ${palabras.map(() => 'Nombre LIKE ?').join(' OR ')} LIMIT 10`,
        comodines
      );
    }
    if (tiene('SERVICIOS')) {
      [servicios] = await pool.query(
        `SELECT 'servicio_ace_o_bus' AS tipo, CONCAT(Codigo, ' - ', NombreServicio) AS nombre
           FROM AceServiciosInventario WHERE ${palabras.map(() => '(NombreServicio LIKE ? OR Codigo LIKE ?)').join(' OR ')} LIMIT 10`,
        palabras.flatMap((p) => [`%${p}%`, `%${p}%`])
      );
    }
    if (tiene('CERTIFICADOS', 'SERVIDORES')) {
      [servidores] = await pool.query(
        `SELECT 'servidor' AS tipo, Hostname AS nombre FROM Servidores WHERE ${palabras.map(() => 'Hostname LIKE ?').join(' OR ')} LIMIT 10`,
        comodines
      );
    }
    // Los "sub-aplicativos" (API_LLAVES_BREB, SUSCRIPTOR_LLAVES, MS_BREB_QR...)
    // son componentes registrados en Servidor_Componentes dentro de un servidor.
    if (tiene('SERVIDORES')) {
      [subAplicativos] = await pool.query(
        `SELECT 'sub_aplicativo' AS tipo, sc.Rol AS nombre, s.Hostname AS servidor,
                (SELECT GROUP_CONCAT(a.Nombre ORDER BY a.Nombre SEPARATOR ', ')
                   FROM Aplicacion_Componente ac JOIN Aplicaciones a ON a.Id = ac.AplicacionId
                  WHERE ac.ComponenteId = sc.Id) AS aplicacion_negocio
           FROM Servidor_Componentes sc
           JOIN Servidores s ON s.Id = sc.ServidorId
          WHERE ${palabras.map(() => 'sc.Rol LIKE ?').join(' OR ')}
          LIMIT 10`,
        comodines
      );
    }

    return {
      coincidencias: [...apps, ...servicios, ...servidores, ...subAplicativos],
      huboCoincidenciaAppOServicio: apps.length > 0 || servicios.length > 0 || subAplicativos.length > 0,
      huboCoincidenciaSubAplicativo: subAplicativos.length > 0
    };
  } catch (err) {
    console.warn('Aviso: la busqueda libre por nombre fallo:', err.message);
    return vacio;
  }
}

// ==========================================================================
// ARMADO DEL CONTEXTO (con presupuesto de caracteres)
// ==========================================================================
// Reparte el presupuesto entre los bloques y recorta las filas que no caben,
// para que el prompt nunca desborde num_ctx (Ollama recorta en silencio y el
// modelo "olvida" partes del contexto).
function armarContexto(bloques) {
  if (bloques.length === 0) return '';
  const porBloque = Math.floor(MAX_CARACTERES_CONTEXTO / bloques.length);
  return bloques
    .map((b) => {
      const filas = Array.isArray(b.datos) ? b.datos : [];
      let texto = bloqueATexto(filas);
      if (texto.length > porBloque) {
        const lineas = texto.split('\n');
        const conservadas = [];
        let largo = 0;
        for (const l of lineas) {
          if (largo + l.length + 1 > porBloque) break;
          conservadas.push(l);
          largo += l.length + 1;
        }
        const omitidas = lineas.length - conservadas.length;
        texto = conservadas.join('\n') + `\n(... ${omitidas} registros mas no se muestran; si el usuario busca uno puntual, pidele que lo nombre)`;
      }
      return `### ${b.clave}\n${texto}`;
    })
    .join('\n\n');
}

// ==========================================================================
// RECORTE DE HISTORIAL
// ==========================================================================
const MAX_MENSAJES_HISTORIAL = 8;

function recortarHistorial(historial) {
  const limpio = historial
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
  return limpio.length <= MAX_MENSAJES_HISTORIAL ? limpio : limpio.slice(-MAX_MENSAJES_HISTORIAL);
}

// Respuestas cortas por defecto (más rápidas en CPU); más margen cuando piden
// listados, resúmenes o "todo".
const PATRON_RESPUESTA_LARGA = /\btodo\b|\btodos\b|esquema|panorama|detall|lista|listado|cuales|resumen|explica/i;

function calcularNumPredict(pregunta) {
  return PATRON_RESPUESTA_LARGA.test(normalizar(pregunta)) ? 500 : 200;
}

// ==========================================================================
// MANUAL DE LA APP (general + por módulo)
// ==========================================================================
const MANUAL_GENERAL = `
AXIS es la aplicacion interna de Banco Finandina para gestionar la
infraestructura y operacion de TI: inventario de servidores y aplicaciones,
certificados, servicios ACE/Bus, balanceador F5, monitoreo, tareas, pasos a
produccion y mas. Cada usuario ve solo los modulos que el administrador le
habilito, y dentro de cada modulo su rol puede ser Consulta (solo ver) o
Administrador del modulo (crear/editar/borrar). El sistema NO crea ni borra
tablas de la base de datos: solo consulta, inserta y actualiza registros.
`.trim();

function descripcionModulos(modulos) {
  return MODULOS_VALIDOS
    .filter((m) => modulos.includes(m) && MODULOS_INFO[m])
    .map((m) => `- ${MODULOS_INFO[m].nombre}: ${MODULOS_INFO[m].resumen}.`)
    .join('\n');
}

function manualDeModulos(temas, modulosUsuario) {
  const vistos = new Set();
  const partes = [];
  for (const t of temas) {
    for (const m of t.modulos || []) {
      if (modulosUsuario.includes(m) && MODULOS_INFO[m] && !vistos.has(m)) {
        vistos.add(m);
        partes.push(MODULOS_INFO[m].detalle);
      }
    }
  }
  return partes.join('\n');
}

// ==========================================================================
// POST /api/ia/chat -- Asistente AXIS (Ollama + base de datos)
// ==========================================================================
router.post('/chat', verifyToken, async (req, res) => {
  const { historial } = req.body;
  // Si el frontend no manda conversacionId, es un chat nuevo -- se crea uno.
  const conversacionId = req.body.conversacionId || nuevoIdConversacion();

  if (!historial || !Array.isArray(historial)) {
    return res.status(400).json({ error: 'El historial de mensajes es obligatorio' });
  }

  try {
    const pool = await getPool();
    const mensajesUsuario = historial.filter((m) => m.role === 'user');
    const ultimaPregunta = mensajesUsuario[mensajesUsuario.length - 1];
    const textoPregunta = ultimaPregunta ? ultimaPregunta.content : '';
    const preguntaPrevia = mensajesUsuario.length > 1 ? mensajesUsuario[mensajesUsuario.length - 2].content : '';

    // Módulos habilitados de ESTE usuario (consulta vigente a la BD, no solo lo
    // que dice el token: si el admin le quitó un módulo, aplica de inmediato).
    let modulos;
    try {
      modulos = (await permisosVigentes(pool, req.user.id)).modulos || [];
    } catch (err) {
      modulos = req.user.modulos || [];
    }
    if (req.user.rol === 'ADMIN_POD') modulos = [...MODULOS_VALIDOS];

    // Detección de temas sobre la pregunta; si no calza con nada, se mira
    // también la pregunta anterior ("¿y su IP?" depende del mensaje previo).
    let { permitidos, denegados } = detectarTemas(textoPregunta, modulos);
    let textoParaBuscar = textoPregunta;
    if (permitidos.length === 0 && denegados.length === 0 && preguntaPrevia) {
      const previa = detectarTemas(preguntaPrevia, modulos);
      if (previa.permitidos.length || previa.denegados.length) {
        permitidos = previa.permitidos;
        denegados = previa.denegados;
        textoParaBuscar = `${preguntaPrevia} ${textoPregunta}`;
      }
    }

    // Preguntan SOLO por algo de módulos que no tienen: se responde sin
    // gastar Ollama y sin entregar ningún dato.
    if (permitidos.length === 0 && denegados.length > 0) {
      const nombres = nombresDeModulos(denegados);
      const respuesta = `No tienes habilitado el módulo ${nombres.join(' ni el módulo ')}, por eso no puedo darte esa información. ` +
        'Si la necesitas, pídele acceso al administrador de la aplicación (ADMIN_POD).';
      if (ultimaPregunta) guardarMensaje(pool, req.user.id, conversacionId, 'user', ultimaPregunta.content);
      guardarMensaje(pool, req.user.id, conversacionId, 'assistant', respuesta);
      return res.json({ reply: respuesta, conversacionId });
    }

    const temas = permitidos.length > 0
      ? permitidos.slice(0, MAX_TEMAS_POR_MENSAJE)
      : [TEMAS.find((t) => t.esDefault)];

    const { coincidencias, huboCoincidenciaAppOServicio, huboCoincidenciaSubAplicativo } =
      await buscarCoincidenciasPorNombre(pool, textoParaBuscar, modulos);

    const agregarTema = (clave) => {
      const tema = TEMAS.find((t) => t.clave === clave);
      if (!tema || temas.some((t) => t.clave === clave)) return;
      if (tema.modulos && !tema.modulos.some((m) => modulos.includes(m))) return;
      temas.push(tema);
    };
    // Si el nombre calzó con una aplicación/servicio/componente, se suma
    // dónde está apuntado/consumido; si fue un sub-aplicativo, también su
    // ficha y su aplicación de negocio.
    if (huboCoincidenciaAppOServicio) agregarTema('suscriptores_servicios');
    if (huboCoincidenciaSubAplicativo) {
      agregarTema('subaplicativos');
      agregarTema('aplicaciones');
    }
    // Los sub-aplicativos ya vienen completos en su tema: se quitan de las
    // coincidencias para que el modelo no vea el mismo dato dos veces.
    const coincidenciasFinal = temas.some((t) => t.clave === 'subaplicativos')
      ? coincidencias.filter((c) => c.tipo !== 'sub_aplicativo')
      : coincidencias;

    const ctx = {
      user: req.user,
      modulos,
      palabras: extraerPalabrasClave(textoParaBuscar),
      ips: extraerIps(textoParaBuscar),
      pregunta: textoPregunta,
      proveedores
    };

    const bloquesContexto = await Promise.all(
      temas.map(async (tema) => ({ clave: tema.clave, datos: await obtenerDatosDeTema(tema, pool, ctx) }))
    );
    if (coincidenciasFinal.length > 0) {
      bloquesContexto.unshift({ clave: 'coincidencias_por_nombre', datos: coincidenciasFinal });
    }

    const contextoTexto = armarContexto(bloquesContexto);
    const manualModulos = manualDeModulos(temas, modulos);
    const notaDenegados = denegados.length > 0
      ? `\nNOTA: la pregunta tambien toca ${nombresDeModulos(denegados).join(' y ')}, que el usuario NO tiene habilitado. De eso no tienes datos: dile que no tiene ese modulo y que pida acceso al administrador.`
      : '';

    const mensajeSistema = {
      role: 'system',
      content: `
Eres el asistente de AXIS (Banco Finandina). Conoces la aplicacion, sus modulos y su
inventario tecnico, y SOLO ayudas con lo que el usuario puede ver segun sus modulos.

${MANUAL_GENERAL}

MODULOS HABILITADOS PARA ESTE USUARIO:
${descripcionModulos(modulos) || '(ninguno)'}${req.user.rol === 'ADMIN_POD' ? `\n${ADMIN_ONLY_INFO}` : ''}
Si preguntan por algo de un modulo que NO esta en esa lista, responde que no lo tiene
habilitado y que pida acceso al administrador; no inventes datos de ese modulo.${notaDenegados}
${manualModulos ? `\nGUIA DE LOS MODULOS RELEVANTES:\n${manualModulos}\n` : ''}
REGLAS DE ESTILO (muy importantes, siguelas siempre):
- Responde en espanol, en 1 a 3 frases y un parrafo corto -- SALVO que pidan "todo",
  un listado, un resumen o "detalle": ahi usa una lista corta (una linea por
  elemento), solo con nombres que esten literalmente en el CONTEXTO.
- Contesta SOLO lo que se pregunto. No agregues contexto de mas ni expliques
  como llegaste a la respuesta.
- No repitas la pregunta. No digas "segun el inventario" ni "segun los datos".
  No muestres JSON ni las lineas "campo=valor" tal cual las ves abajo: son tu
  referencia, redactalas en espanol natural.
- NUNCA inventes que significa una sigla o nombre (BREB, ACE, un codigo...) a
  menos que ese significado este escrito en el CONTEXTO.
- No repitas el mismo componente o servidor dos veces en la respuesta.
- Los numeros (conteos, IPs, puertos, fechas, estados) se copian EXACTOS del
  CONTEXTO; si hay que contar, cuenta las filas del CONTEXTO.
- Si el dato pedido no aparece en el CONTEXTO, responde: "No tengo ese dato en lo
  que consulte. Prueba reformular la pregunta o revisa la pantalla
  correspondiente." No inventes ni asumas valores.
- Si el contexto trae "coincidencias_por_nombre", son resultados de buscar el
  nombre mencionado en aplicaciones, servicios, servidores y componentes: usalo
  para confirmar de que se trata. Si no aparece, ese nombre no esta registrado
  en este inventario.
- Si una fila del CONTEXTO empieza con "aviso=", NADA coincide por nombre con lo
  preguntado y las filas que siguen son solo una muestra. Si preguntaron por un
  nombre concreto, responde que no esta registrado (puedes citar 1 o 2 nombres
  parecidos como "quizas te refieres a ...") y NUNCA presentes la muestra como la
  respuesta; si la pregunta era general (conteos, estados, listados), usa las filas.
- Si una fila trae "nota=ERROR", no pudiste leer esos datos: dilo claramente.
- Si te preguntan como se usa una pantalla o que hace un modulo, explica con la
  guia de modulos de arriba.

EJEMPLOS DE ESTILO:
Pregunta: "que ip tiene el servidor srv-app01"
Respuesta correcta: "srv-app01 tiene la IP 10.20.30.5."
Pregunta: "cuantos certificados vencen pronto"
Respuesta correcta: "Hay 3 certificados que vencen en los proximos 30 dias."

CONTEXTO (datos relevantes a la pregunta actual):
${contextoTexto}
      `.trim()
    };

    const mensajesOllama = [mensajeSistema, ...recortarHistorial(historial)];

    const { modelo: modeloOllama, instalados: modelosInstalados } = await resolverModeloOllama();
    if (!modeloOllama) {
      return res.status(502).json({
        error: `El servidor Ollama (${OLLAMA_URL}) no tiene ningún modelo de chat instalado. Descarga uno con "ollama pull ${OLLAMA_MODEL}" y vuelve a intentar.`
      });
    }

    let ollamaResponse;
    try {
      ollamaResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
        body: JSON.stringify({
          model: modeloOllama,
          messages: mensajesOllama,
          stream: false,
          // Mantiene el modelo cargado 30 min tras cada uso (en vez de 5).
          keep_alive: '30m',
          options: {
            num_predict: calcularNumPredict(textoPregunta),
            // Bajo: para un asistente de datos importa mas la consistencia.
            temperature: 0.2,
            repeat_penalty: 1.2,
            // El contexto es grande (varios temas + guia de modulos): si
            // num_ctx queda chico, Ollama recorta el prompt en silencio.
            num_ctx: 6144
          }
        })
      });
    } catch (err) {
      const porTiempo = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      console.error('Error al contactar a Ollama:', err.message);
      return res.status(porTiempo ? 504 : 502).json({
        error: porTiempo
          ? 'La IA tardó demasiado en responder. Intenta con una pregunta más corta.'
          : `No se pudo conectar con el servicio de IA (Ollama en ${OLLAMA_URL}). Revisa que esté encendido y que OLLAMA_URL apunte al servidor correcto.`
      });
    }

    if (!ollamaResponse.ok) {
      let detalle = '';
      try { const e = await ollamaResponse.json(); detalle = e && e.error ? String(e.error) : ''; } catch (e) { /* sin cuerpo */ }
      console.error(`Error de Ollama (${OLLAMA_URL}, modelo ${modeloOllama}): ${ollamaResponse.status} ${detalle}`);
      cacheModelo = { hasta: 0, modelo: null, instalados: [] };
      if (ollamaResponse.status === 404) {
        return res.status(502).json({
          error: `El modelo "${modeloOllama}" no está disponible en ${OLLAMA_URL}.` +
            (modelosInstalados.length ? ` Modelos instalados: ${modelosInstalados.slice(0, 6).join(', ')}. Define OLLAMA_MODEL con uno de ellos.` : '')
        });
      }
      return res.status(502).json({ error: `La IA respondió con un error${detalle ? ': ' + detalle.slice(0, 200) : ` (${ollamaResponse.status})`}.` });
    }

    const data = await ollamaResponse.json();
    const respuesta = data.message.content;

    // Se guarda DESPUES de tener la respuesta, sin esperarlo (si falla,
    // guardarMensaje solo avisa por consola).
    if (ultimaPregunta) guardarMensaje(pool, req.user.id, conversacionId, 'user', ultimaPregunta.content);
    guardarMensaje(pool, req.user.id, conversacionId, 'assistant', respuesta);

    res.json({ reply: respuesta, conversacionId });
  } catch (error) {
    console.error('Error en el chat del asistente:', error.message);
    res.status(500).json({ error: 'Error interno de la IA.' });
  }
});

// ==========================================================================
// MODELOS GENERALES (Open WebUI) -- sin acceso a la base de datos de AXIS
// ==========================================================================
// Las conversaciones de modelos generales se guardan en la misma tabla del
// historial pero con ConversacionId NEGATIVO, así el panel lateral de cada
// pestaña lista solo las suyas.
const MENSAJE_SISTEMA_GENERAL =
  'Eres un asistente de inteligencia artificial de proposito general para el equipo de TI de Banco Finandina. ' +
  'Responde siempre en espanol, de forma clara, ordenada y precisa; si no sabes algo, dilo en vez de inventarlo. ' +
  'No tienes acceso a la base de datos ni a los sistemas internos de AXIS: si te preguntan por servidores, ' +
  'aplicaciones, certificados u otros datos internos de la empresa, indica que para eso usen la pestana "Asistente AXIS". ' +
  'Nunca pidas contrasenas, tokens ni datos personales de clientes.';

const MAX_MENSAJES_GENERAL = 14;
const MAX_CARACTERES_MENSAJE_GENERAL = 8000;

function responderErrorOpenWebUi(res, error, contexto) {
  console.error(`Error en ${contexto}:`, error.message);
  if (error instanceof openWebUi.ErrorOpenWebUi) {
    return res.status(error.status === 500 ? 500 : error.status).json({ error: error.message });
  }
  return res.status(500).json({ error: 'Error interno al consultar los modelos generales.' });
}

// GET /api/ia/modelos-generales -- modelos disponibles en el servidor.
router.get('/modelos-generales', verifyToken, async (req, res) => {
  try {
    const modelos = await openWebUi.listarModelos();
    res.json({ servidor: openWebUi.URL_BASE, modelos });
  } catch (error) {
    responderErrorOpenWebUi(res, error, 'GET /ia/modelos-generales');
  }
});

// POST /api/ia/chat-general { modelo, historial: [{role, content}], conversacionId? }
router.post('/chat-general', verifyToken, async (req, res) => {
  const { modelo, historial } = req.body || {};
  if (!modelo || typeof modelo !== 'string') {
    return res.status(400).json({ error: 'Elige el modelo con el que quieres conversar.' });
  }
  if (!Array.isArray(historial) || historial.length === 0) {
    return res.status(400).json({ error: 'El historial de mensajes es obligatorio' });
  }

  const mensajes = historial
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_MENSAJES_GENERAL)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CARACTERES_MENSAJE_GENERAL) }));
  const ultimo = mensajes[mensajes.length - 1];
  if (!ultimo || ultimo.role !== 'user') {
    return res.status(400).json({ error: 'El último mensaje debe ser una pregunta del usuario.' });
  }

  // Id negativo = conversación de modelos generales.
  let conversacionId = Number(req.body.conversacionId);
  if (!Number.isFinite(conversacionId) || conversacionId >= 0) conversacionId = -nuevoIdConversacion();

  try {
    const respuesta = await openWebUi.conversar(modelo, [{ role: 'system', content: MENSAJE_SISTEMA_GENERAL }, ...mensajes]);

    const pool = await getPool();
    guardarMensaje(pool, req.user.id, conversacionId, 'user', ultimo.content);
    guardarMensaje(pool, req.user.id, conversacionId, 'assistant', respuesta);

    res.json({ reply: respuesta, conversacionId, modelo });
  } catch (error) {
    responderErrorOpenWebUi(res, error, 'POST /ia/chat-general');
  }
});

// ==========================================================================
// GET /api/ia/conversaciones[?tipo=general] -- lista de conversaciones del
// usuario que hace la peticion (cada quien ve solo las suyas), mas reciente
// primero. Sin tipo: las del Asistente AXIS; tipo=general: las de modelos
// generales.
// ==========================================================================
router.get('/conversaciones', verifyToken, async (req, res) => {
  try {
    const pool = await getPool();
    const todas = await obtenerConversaciones(pool, req.user.id);
    const general = req.query.tipo === 'general';
    res.json(todas.filter((c) => (general ? Number(c.conversacionId) < 0 : Number(c.conversacionId) >= 0)));
  } catch (error) {
    console.error('Error al listar conversaciones del asistente:', error.message);
    res.status(500).json({ error: 'No se pudieron listar las conversaciones.' });
  }
});

// ==========================================================================
// GET /api/ia/historial/:conversacionId -- mensajes de UNA conversacion en
// concreto. Se valida que sea del usuario que pregunta.
// ==========================================================================
router.get('/historial/:conversacionId', verifyToken, async (req, res) => {
  try {
    const pool = await getPool();
    const filas = await obtenerHistorialConversacion(pool, req.user.id, req.params.conversacionId);
    res.json(filas.map((f) => ({
      rol: f.Rol,
      mensaje: f.Mensaje,
      fecha: f.FechaMensaje
    })));
  } catch (error) {
    console.error('Error al obtener una conversacion del asistente:', error.message);
    res.status(500).json({ error: 'No se pudo obtener la conversacion.' });
  }
});

module.exports = router;
