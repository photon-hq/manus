import Fastify from 'fastify';
import cors from '@fastify/cors';
import { prisma } from '@imessage-mcp/database';
import { connectRoutes } from './routes/connect';
import { mcpRoutes } from './routes/mcp';
import { mcpSSERoutes } from './routes/mcp-sse';
import { webhookRoutes } from './routes/webhooks';
import { imessageWebhookRoutes } from './routes/imessage-webhook';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

// Register plugins
fastify.register(cors, {
  origin: [
    'https://manus.im',
    'https://app.manus.im',
    'https://open.manus.im',
    process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null,
  ].filter(Boolean) as string[],
  credentials: true,
});

// Root redirect to /connect landing page
fastify.get('/', async (request, reply) => {
  return reply.redirect(301, '/connect');
});

// Register routes
fastify.register(connectRoutes, { prefix: '/connect' });
fastify.register(mcpRoutes, { prefix: '/mcp' });
fastify.register(mcpSSERoutes, { prefix: '/mcp' });
fastify.register(webhookRoutes, { prefix: '' }); // Root level
fastify.register(imessageWebhookRoutes, { prefix: '' }); // Root level for health

// Internal health check endpoint (Docker only, not publicly exposed)
fastify.get('/health', async (request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return reply.code(200).send({ status: 'ok' });
  } catch (error) {
    return reply.code(503).send({ status: 'unhealthy' });
  }
});

// Serve favicon at root
fastify.get('/favicon.png', async (request, reply) => {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  // In Docker: /app/favicon.png, Local: ../../favicon.png from services/backend
  const faviconPath = process.env.NODE_ENV === 'production'
    ? '/app/favicon.png'
    : path.join(process.cwd(), '../../favicon.png');
  
  try {
    const favicon = await fs.readFile(faviconPath);
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=31536000')
      .send(favicon);
  } catch (error) {
    return reply.code(404).send({ error: 'Favicon not found' });
  }
});

// Also serve favicon.ico for browser default requests
fastify.get('/favicon.ico', async (request, reply) => {
  return reply.redirect('/favicon.png');
});

// Graceful shutdown
const closeGracefully = async (signal: string) => {
  fastify.log.info(`Received ${signal}, closing gracefully`);
  
  // Stop iMessage event listener
  try {
    const { stopIMessageListener } = await import('./routes/imessage-webhook.js');
    await stopIMessageListener();
  } catch (error) {
    // Ignore if not initialized
  }
  
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
    // Initialize iMessage connection and event listener
    try {
      const { getIMessageSDK } = await import('./lib/imessage.js');
      await getIMessageSDK();
      fastify.log.info('✅ Connected to Photon iMessage infrastructure');
      
      // Start event listener for incoming messages
      const { startIMessageListener } = await import('./routes/imessage-webhook.js');
      await startIMessageListener();
      fastify.log.info('✅ iMessage event listener started');
    } catch (error) {
      fastify.log.error('❌ Failed to connect to Photon iMessage infrastructure');
      fastify.log.error('Check IMESSAGE_SERVER_URL and IMESSAGE_API_KEY in .env');
      throw error; // Fail fast if iMessage is not available
    }

    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Backend server running on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
