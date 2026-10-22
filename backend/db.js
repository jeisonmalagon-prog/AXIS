const mysql = require('mysql2/promise');
require('dotenv').config();

// 1. Validar que las variables de entorno obligatorias del servidor principal existan
const variablesRequeridas = ['DB_USER', 'DB_PASSWORD', 'DB_SERVER', 'DB_DATABASE'];
const variablesFaltantes = variablesRequeridas.filter(env => !process.env[env]);

if (variablesFaltantes.length > 0) {
  console.error(`❌ ERROR CRÍTICO: Faltan las siguientes variables del pool principal: ${variablesFaltantes.join(', ')}`);
}

// Configuración Base de Datos Principal
const configPrincipal = {
  host: process.env.DB_SERVER,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT, 10) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Configuración Base de Datos LogApp (Servidor 192.168.118.58)
const configLogApp = {
  host: process.env.LOGAPP_DB_SERVER || '192.168.118.58',
  user: process.env.LOGAPP_DB_USER || 'jeimal',           // Adjust user or environment variable
  password: process.env.LOGAPP_DB_PASSWORD || 'Finandina10',       // Adjust password or environment variable
  database: process.env.LOGAPP_DB_DATABASE || 'LogApp',
  port: parseInt(process.env.LOGAPP_DB_PORT, 10) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

let poolPrincipal;
let poolLogApp;

// Pool 1: Obtener conexión a la BD Principal
async function getPool() {
  if (poolPrincipal) return poolPrincipal;
  
  try {
    if (!configPrincipal.host) throw new Error("El host del servidor principal (DB_SERVER) no está configurado.");
    
    poolPrincipal = mysql.createPool(configPrincipal);
    const connection = await poolPrincipal.getConnection();
    console.log('✅ Conectado a MariaDB Principal con éxito');
    connection.release();
    
    return poolPrincipal;
  } catch (err) {
    console.error('❌ Error al conectar con MariaDB Principal:', err.message);
    poolPrincipal = null; 
    throw err; 
  }
}

// Pool 2: Obtener conexión a la BD LogApp (192.168.118.58)
async function getLogAppPool() {
  if (poolLogApp) return poolLogApp;
  
  try {
    poolLogApp = mysql.createPool(configLogApp);
    const connection = await poolLogApp.getConnection();
    console.log('✅ Conectado a MariaDB LogApp (192.168.118.58) con éxito');
    connection.release();
    
    return poolLogApp;
  } catch (err) {
    console.error('❌ Error al conectar con MariaDB LogApp:', err.message);
    poolLogApp = null; 
    throw err; 
  }
}

module.exports = { 
  getPool, 
  getLogAppPool 
};