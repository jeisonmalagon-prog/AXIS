// Lista ÚNICA de módulos de la aplicación. La usan auth.js (módulos del token
// de un ADMIN_POD, que siempre tiene acceso a todo) y usuarios.js (catálogo
// de módulos asignables). Antes cada archivo tenía su propia copia y la de
// auth.js se quedó sin TAREAS, CALENDARIO y PASOS_PRODUCCION, por lo que ni
// un ADMIN_POD podía entrar a esos módulos ("No tienes habilitado el módulo").
// Al agregar un módulo nuevo, solo hay que añadirlo aquí (y en el frontend:
// usuarios.component.ts, app.routes.ts y shell.component.html).
const MODULOS_VALIDOS = [
  'CERTIFICADOS',
  'SERVIDORES',
  'APP_MOVIL',
  'SERVICIOS',
  'ORQUESTADOR_N8N',
  'REPOSITORIO',
  'BALANCEADOR_F5',
  'TAREAS',
  'CALENDARIO',
  'PASOS_PRODUCCION',
  'SWAGGER',
  'BIOMETRIA',
  'CATALOGO_DATOS',
  'MANUALES',
  'SOPORTE_N1',
  'INFORMES',
];

module.exports = { MODULOS_VALIDOS };
