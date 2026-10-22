const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Importación de enrutadores
const sistemasOperativosRouter = require('./routes/sistemasOperativos');
const servidoresRouter = require('./routes/servidores');
const aplicacionesRouter = require('./routes/aplicaciones');
const certificadosRouter = require('./routes/certificados');
const certificadosContenedoresRouter = require('./routes/certificadosContenedores');
const historicoRouter = require('./routes/historico');
const dashboardRouter = require('./routes/dashboard');
const servidoresInventario = require('./routes/servidoresInventario');
const subaplicativosRouter = require('./routes/subaplicativos');
const authRouter = require('./routes/auth');
const recuperacionRouter = require('./routes/recuperacion');
const usuariosRoutes = require('./routes/usuarios');
const esquemasRouter = require('./routes/esquemas');
const chat = require('./routes/chat'); // Tu archivo de IA
const n8n = require('./routes/n8n');
const appmovil = require('./routes/appMovil');
const monitoreoRouter = require('./routes/monitoreo');
const portainerSaludRouter = require('./routes/portainerSalud');
const soporteN1Router = require('./routes/soporteN1');
const prospeccionRouter = require('./routes/prospeccion');
const brebRouter = require('./routes/breb');
const puertosRouter = require('./routes/puertos');
const aceCatalogoRouter = require('./routes/aceCatalogo');
const aceServiciosRouter = require('./routes/aceServicios');
const apuntamientosRouter = require('./routes/apuntamientos');
const apuntamientosHistoricoRouter = require('./routes/apuntamientosHistorico');
const validacionNodosRouter = require('./routes/validacionNodos');
const { iniciarProgramadorValidacionNodos } = require('./utils/apuntamientosNodos');
const azureRepoRouter = require('./routes/azureRepo');
const f5Router = require('./routes/f5Monitoreo');
const reportesRouter = require('./routes/reportes');
const informesRouter = require('./routes/informes');
const auditoriaUsuariosRouter = require('./routes/auditoriaUsuarios');
const auditoriaGeneralRouter = require('./routes/auditoriaGeneral');
const configuracionRouter = require('./routes/configuracion');
const tareasRouter = require('./routes/tareas');
const calendarioRouter = require('./routes/calendario');
const pasosProduccionRouter = require('./routes/pasosProduccion');
const swaggerRouter = require('./routes/swagger');
const biometriaRouter = require('./routes/biometria');
const biometriaConsumoRouter = require('./routes/biometriaConsumo');
const { iniciarProgramador: iniciarAlertasConsumoBiometria } = require('./utils/biometriaConsumoAlertas');
const catalogoDatosRouter = require('./routes/catalogoDatos');
const inicioRouter = require('./routes/inicio');
const manualesRouter = require('./routes/manuales');
const notificacionesRouter = require('./routes/notificaciones');

const app = express();

// Middlewares globales
app.use(cors());
// El límite por defecto de express.json() es 100kb — muy poco para el
// "Registrar cambio" de la Bitácora de Apuntamientos, que puede adjuntar
// una imagen en base64 (hasta ~2 MB de binario, ~2.8 MB ya codificada en
// base64), y para los adjuntos/evidencias de la Bitácora de Pasos a
// Producción (hasta ~10 MB de binario, ~13.5 MB ya codificados en base64 —
// ver TAMANO_MAXIMO_ADJUNTO_BYTES en backend/routes/pasosProduccion.js). Se
// sube el límite global; el resto de la API sigue mandando payloads mucho
// más chicos, así que esto no afecta a nadie más.
app.use(express.json({ limit: '15mb' }));

// Correo saliente (SMTP) configurable desde Configuración: vuelca lo guardado en la BD
// sobre process.env (como mucho una lectura cada 20 s) antes de atender cualquier /api.
const correoConfig = require('./utils/correoConfig');
app.use('/api', (req, res, next) => { correoConfig.asegurar().then(() => next(), () => next()); });

// Ruta base de prueba de salud (Healthcheck)
app.get('/', (req, res) => {
  res.json({ status: 'API Gestión de Certificados activa' });
});

// Registro de endpoints de la API
app.use('/api/sistemas-operativos', sistemasOperativosRouter);
app.use('/api/servidores', servidoresRouter);
app.use('/api/aplicaciones', aplicacionesRouter);
app.use('/api/certificados-contenedores', certificadosContenedoresRouter); // Certificados que usan los contenedores (Portainer) y conciliación con el inventario
app.use('/api/certificados', certificadosRouter);
app.use('/api/historico', historicoRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/servidoresInventario', servidoresInventario);
app.use('/api/subaplicativos', subaplicativosRouter);
// Recuperación de contraseña con código (OTP): rutas públicas, van ANTES del router de auth.
app.use('/api/auth/recuperar', recuperacionRouter);
app.use('/api/auth', authRouter);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/esquemas', esquemasRouter);

// 👇 AQUÍ ESTÁ LA CORRECCIÓN CLAVE 👇
// Cambiamos '/api/chat' por '/api/ia' para que coincida con Angular
app.use('/api/ia', chat);

app.use('/api/n8n', n8n);
app.use('/api/app-movil', appmovil); // Uso de la variable que ya habías importado arriba
app.use('/api/monitoreo', monitoreoRouter);
app.use('/api/monitoreo/portainer', portainerSaludRouter);
app.use('/api/soporte-n1/prospeccion', prospeccionRouter); // Soporte N1 > Monitorear prospección (GestionCliente, solo lectura)
app.use('/api/soporte-n1', soporteN1Router); // Soporte Nivel 1: reinicio de monitores (OTP a aprobadores para rol Consulta)
app.use('/api/monitoreo-transaccional/breb', brebRouter); // Monitoreo transaccional > BREB (SQL Server + logs MariaDB + servicio de llaves, solo lectura)
app.use('/api/puertos', puertosRouter);
app.use('/api/ace-catalogo', aceCatalogoRouter);
app.use('/api/ace-servicios', aceServiciosRouter);
app.use('/api/apuntamientos', apuntamientosRouter);
app.use('/api/apuntamientos-historico', apuntamientosHistoricoRouter);
app.use('/api/validacion-nodos', validacionNodosRouter);
app.use('/api/azure-repo', azureRepoRouter);
app.use('/api/f5', f5Router);
app.use('/api/reportes', reportesRouter);
app.use('/api/informes', informesRouter); // Informes nuevos (pantalla, PDF, Excel, correo y envíos programados)
app.use('/api/auditoria-usuarios', auditoriaUsuariosRouter);
app.use('/api/auditoria-general', auditoriaGeneralRouter);
app.use('/api/configuracion', configuracionRouter);
app.use('/api/tareas', tareasRouter);
app.use('/api/calendario', calendarioRouter);
app.use('/api/pasos-produccion', pasosProduccionRouter);
app.use('/api/swagger', swaggerRouter);
app.use('/api/biometria', biometriaRouter);
app.use('/api/biometria-consumo', biometriaConsumoRouter);
app.use('/api/catalogo-datos', catalogoDatosRouter);
app.use('/api/inicio', inicioRouter);
app.use('/api/manuales', manualesRouter);
app.use('/api/notificaciones', notificacionesRouter);

// Manejo de rutas no encontradas (404)
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Manejador global de errores inesperados (500)
app.use((err, req, res, next) => {
  console.error('Error no controlado en el servidor:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API escuchando en http://localhost:${PORT}`);
  iniciarProgramadorValidacionNodos();
  iniciarAlertasConsumoBiometria();
  correoConfig.asegurar({ force: true });
});
