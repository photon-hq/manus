import './tracing'; // Initialize tracing first
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { prisma } from '@imessage-mcp/database';
import { connectRoutes } from './routes/connect';
import { mcpRoutes } from './routes/mcp';
import { webhookRoutes } from './routes/webhooks';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
      process.env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  },
});

// Register plugins
fastify.register(cors, {
  origin: true,
});

// Register routes
fastify.register(connectRoutes, { prefix: '/api/connect' });
fastify.register(mcpRoutes, { prefix: '/api/mcp' });
fastify.register(webhookRoutes, { prefix: '/api/webhooks' });

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Graceful shutdown
const closeGracefully = async (signal: string) => {
  fastify.log.info(`Received ${signal}, closing gracefully`);
  
  // Disconnect iMessage
  try {
    const { disconnectIMessage } = await import('./lib/imessage.js');
    await disconnectIMessage();
  } catch (error) {
    // Ignore if not initialized
  }
  
  await prisma.$disconnect();
  await fastify.close();
  process.exit(0);
};

process.on('SIGINT', () => closeGracefully('SIGINT'));
process.on('SIGTERM', () => closeGracefully('SIGTERM'));

// Start server
const start = async () => {
  try {
    // Initialize iMessage connection
    try {
      const { getIMessageSDK } = await import('./lib/imessage.js');
      await getIMessageSDK();
      fastify.log.info('✅ iMessage SDK initialized');
    } catch (error) {
      fastify.log.warn('⚠️  iMessage SDK not available - messages will fail');
      fastify.log.warn('Make sure advanced-imessage-kit server is running on IMESSAGE_SERVER_URL');
    }

    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Backend server running on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
