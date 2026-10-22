// Auditoría GENERAL del aplicativo — a diferencia de UsuariosHistorico (que
// solo cubre cuentas/accesos), esta tabla registra cambios de CUALQUIER
// módulo: Certificados, Servidores, Aplicaciones, Servicios/ACE, Esquemas,
// Bitácora de Apuntamientos, Balanceador F5, y acciones operativas como
// iniciar/detener un contenedor Docker o activar/desactivar un workflow de
// n8n.
//
// A diferencia de ApuntamientosHistorico o UsuariosHistorico (que tienen
// columnas Anterior/Nuevo fijas por campo), aquí las entidades son de
// naturaleza muy distinta entre sí (un certificado no se parece en nada a un
// contenedor Docker o a un workflow de n8n) — así que los cambios se guardan
// como un JSON [{campo, etiqueta, anterior, nuevo}], no como columnas fijas.
// El frontend ya sabe renderizar esa forma (mismo criterio que
// resumenCambio() en la pantalla de Auditoría de Usuarios).
//
// Igual que con UsuariosHistorico, la tabla se garantiza en tiempo de
// ejecución (CREATE TABLE IF NOT EXISTS) para no depender de un script de
// migración manual.

const { esErrorDePrivilegios, tablaExiste } = require('./esquemaSeguro');

let tablaAuditoriaGeneralLista = false;
// true si la tabla no existe y el usuario de BD no puede crearla: la auditoría
// general se omite (con aviso en el log) en vez de romper cada operación.
let auditoriaNoDisponible = false;

async function garantizarTablaAuditoriaGeneral(pool) {
  if (tablaAuditoriaGeneralLista || auditoriaNoDisponible) return;
  if (await tablaExiste(pool, 'AuditoriaGeneral')) {
    tablaAuditoriaGeneralLista = true;
    return;
  }
  try {
    await crearTablaAuditoriaGeneral(pool);
  } catch (err) {
    if (esErrorDePrivilegios(err)) {
      auditoriaNoDisponible = true;
      console.error(
        '[auditoria] No se puede crear AuditoriaGeneral (sin privilegios de DDL). La auditoría general queda ' +
        'DESACTIVADA hasta ejecutar migracion_esquema_sin_privilegios.sql con una cuenta con privilegios.'
      );
      return;
    }
    throw err;
  }
  tablaAuditoriaGeneralLista = true;
}

async function crearTablaAuditoriaGeneral(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS AuditoriaGeneral (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      Modulo VARCHAR(30) NOT NULL,
      Entidad VARCHAR(50) NOT NULL,
      EntidadId VARCHAR(50) NULL,
      EntidadNombre VARCHAR(255) NULL,
      Accion VARCHAR(30) NOT NULL,
      Detalle VARCHAR(500) NULL,
      CambiosJson TEXT NULL,
      RealizadoPorId INT NULL,
      RealizadoPorUsername VARCHAR(100) NULL,
      IP VARCHAR(64) NULL,
      UserAgent VARCHAR(255) NULL,
      FechaEvento DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_auditoriageneral_modulo (Modulo, FechaEvento),
      INDEX idx_auditoriageneral_accion (Accion, FechaEvento),
      INDEX idx_auditoriageneral_entidad (Entidad, EntidadId),
      CONSTRAINT fk_auditoriageneral_usuario FOREIGN KEY (RealizadoPorId) REFERENCES usuarios(id) ON DELETE SET NULL
    )
  `);
}

// Copia local a propósito (mismo criterio que usuariosAuditoria.js): este
// proyecto prefiere una pequeña duplicación de utilidades chicas antes que
// acoplar dos módulos de auditoría independientes entre sí.
function obtenerIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) return String(forwardedFor).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

function obtenerUserAgent(req) {
  const ua = req.headers['user-agent'];
  return ua ? String(ua).slice(0, 255) : null;
}

// Compara dos objetos "planos" (mismo shape) campo por campo y arma la lista
// de cambios solo con lo que realmente cambió — evita que cada ruta tenga
// que reimplementar su propio diff a mano.
//
// `mapaEtiquetas` es opcional: { campoCrudo: 'Etiqueta legible' }. Un campo
// sin etiqueta se muestra tal cual.
//
// `formateadores` es opcional: { campoCrudo: (valor) => texto } para casos
// donde el valor crudo no es legible directamente (ids, booleanos, arrays).
function diffCampos(antes, despues, campos, mapaEtiquetas = {}, formateadores = {}) {
  const cambios = [];
  for (const campo of campos) {
    const valorAntes = antes ? antes[campo] : undefined;
    const valorDespues = despues ? despues[campo] : undefined;

    const normalizado = (v) => (v === undefined || v === null ? null : v);
    const a = normalizado(valorAntes);
    const b = normalizado(valorDespues);

    // Comparación por valor (no por referencia) para que arrays/objetos con
    // el mismo contenido no se marquen como "cambiados".
    const iguales = JSON.stringify(a) === JSON.stringify(b);
    if (iguales) continue;

    const formatear = formateadores[campo] || ((v) => (v === null ? null : v));
    cambios.push({
      campo,
      etiqueta: mapaEtiquetas[campo] || campo,
      anterior: formatear(a),
      nuevo: formatear(b),
    });
  }
  return cambios;
}

// Registra un evento de auditoría general. `cambios`, si se pasa, debe ser
// el array que devuelve diffCampos() (o uno armado a mano con la misma
// forma); se guarda como JSON. Si `cambios` viene vacío y no hay `detalle`,
// igual se guarda el evento (por ejemplo una ELIMINACION no tiene "cambios",
// solo el hecho de que la entidad dejó de existir).
async function registrarEventoGeneral(pool, req, datos) {
  await garantizarTablaAuditoriaGeneral(pool);
  if (auditoriaNoDisponible) return; // ver garantizarTablaAuditoriaGeneral
  const {
    modulo,
    entidad,
    entidadId = null,
    entidadNombre = null,
    accion,
    detalle = null,
    cambios = null,
  } = datos;

  const realizadoPorId = req?.user?.id ?? null;
  const realizadoPorUsername = req?.user?.username ?? null;

  await pool.query(
    `INSERT INTO AuditoriaGeneral
      (Modulo, Entidad, EntidadId, EntidadNombre, Accion, Detalle, CambiosJson,
       RealizadoPorId, RealizadoPorUsername, IP, UserAgent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      modulo,
      entidad,
      entidadId !== null && entidadId !== undefined ? String(entidadId) : null,
      entidadNombre,
      accion,
      detalle,
      cambios && cambios.length ? JSON.stringify(cambios) : null,
      realizadoPorId,
      realizadoPorUsername,
      obtenerIp(req),
      obtenerUserAgent(req),
    ]
  );
}

module.exports = {
  garantizarTablaAuditoriaGeneral,
  registrarEventoGeneral,
  diffCampos,
  obtenerIp,
  obtenerUserAgent,
};
