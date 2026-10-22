// Credenciales PREDEFINIDAS del módulo Biometría, puestas aquí a pedido del propietario del sistema para que
// nadie tenga que escribir usuarios ni claves en la pantalla. Las usan SOLO sqlServer.js (SQL Server) y
// biometriaRemota.js (SSH); nunca se envían al navegador, ni se registran, ni se auditan.
// Este archivo está en .gitignore: no se sube al repositorio. Para cambiar una clave, se edita aquí y se reinicia el backend.
module.exports = Object.freeze({
  // Servidor de biometría (SSH, 10.240.1.116; el usuario está en biometriaRemota.js)
  clave: 'F1n4nd1n42050$',
  // SQL Server (solo lectura)
  sql: Object.freeze({
    motorfirma: Object.freeze({ servidor: '192.168.118.53', puerto: 61733, base: 'MotorFirma', usuario: 'Usr_MtFir', clave: 'SkZ35cIP7NlO5cP4UC5A' }),
    orqbiometria: Object.freeze({ servidor: '192.168.118.53', puerto: 61733, base: 'ORQBIOMETRIA', usuario: 'Usr_bio', clave: 'dbnS5AtQj1AIpSEY3mKj' }),
  }),
});
