require('dotenv').config();
const app = require('./app');
const prisma = require('./shared/database/prisma');
const logger = require('./shared/utils/logger');

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 10000;

const setupGracefulShutdown = (server) => {
    const gracefulShutdown = (signal) => {
        logger.info(`Recibida señal ${signal}, iniciando shutdown graceful...`);

        server.close(async (err) => {
            if (err) {
                logger.error('Error al cerrar el servidor HTTP', { error: err.message, stack: err.stack });
                process.exit(1);
            }

            logger.info('Servidor HTTP cerrado');

            try {
                await prisma.$disconnect();
                logger.info('Conexión a Prisma cerrada correctamente');
                process.exit(0);
            } catch (error) {
                logger.error('Error al desconectar Prisma', { error: error.message, stack: error.stack });
                process.exit(1);
            }
        });

        setTimeout(() => {
            logger.error('Timeout en shutdown, forzando salida...');
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    process.on('beforeExit', () => {
        logger.info('Proceso está a punto de terminar...');
    });
};

const startServer = async () => {
    try {
        await prisma.$connect();
        logger.info('Conexión a la base de datos PostgreSQL exitosa (Prisma)');

        const server = app.listen(PORT, () => {
            logger.info(`Servidor escuchando en el puerto ${PORT}`);
        });

        setupGracefulShutdown(server);
    } catch (error) {
        logger.error('Error fatal al conectar a la base de datos', { error: error.message, stack: error.stack });
        process.exit(1);
    }
};

startServer();
