import Fastify from 'fastify';
import cors from '@fastify/cors';
import { prisma } from '@imessage-mcp/database';
import { mcpRoutes } from './routes/mcp';
import { mcpSSERoutes } from './routes/mcp-sse';
import { mcpHTTPRoutes } from './routes/mcp-http';
import { webhookRoutes } from './routes/webhooks';
import { imessageWebhookRoutes } from './routes/imessage-webhook';

// UI Design Version
const UI_DESIGN_VERSION = process.env.UI_DESIGN_VERSION || 'v1';
console.log('🎨 UI_DESIGN_VERSION from env:', process.env.UI_DESIGN_VERSION);
console.log('🎨 Using UI design version:', UI_DESIGN_VERSION);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
  // Increase timeouts for SSE connections
  connectionTimeout: 0, // Disable connection timeout for SSE
  keepAliveTimeout: parseInt(process.env.KEEPALIVE_TIMEOUT_SECONDS || '120') * 1000, // Default 120 seconds
  // Trust proxy headers (required when behind reverse proxy like Traefik)
  trustProxy: true,
});

// Skip logging for health checks
fastify.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') {
    request.log = {
      info: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      warn: () => {},
      trace: () => {},
      child: () => request.log,
    } as any;
  }
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

// Register routes - dynamically load connect routes based on UI_DESIGN_VERSION
const loadConnectRoutes = async () => {
  const connectRoutesModule = UI_DESIGN_VERSION === 'v2' 
    ? await import('./routes/connect-v2.js')
    : await import('./routes/connect-v1.js');
  return connectRoutesModule.connectRoutes;
};

// Register other routes immediately
fastify.register(mcpRoutes, { prefix: '/mcp' });
fastify.register(mcpSSERoutes, { prefix: '/mcp' });
fastify.register(mcpHTTPRoutes, { prefix: '/mcp/http' });
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

// Debug endpoint to check proxy headers and SSE readiness
fastify.get('/debug/proxy', async (request, reply) => {
  return {
    headers: request.headers,
    ip: request.ip,
    hostname: request.hostname,
    protocol: request.protocol,
    url: request.url,
    method: request.method,
    nodeEnv: process.env.NODE_ENV,
    port: PORT,
  };
});

// Admin endpoint to reconnect iMessage SDK
fastify.post('/admin/reconnect-imessage', async (request, reply) => {
  try {
    console.log('🔄 Manual iMessage SDK reconnection requested...');
    
    // Import the disconnect and connect functions
    const { disconnectIMessage, getIMessageSDK } = await import('./lib/imessage.js');
    const { stopIMessageListener, startIMessageListener } = await import('./routes/imessage-webhook.js');
    
    // Stop the event listener
    console.log('⏸️  Stopping iMessage event listener...');
    await stopIMessageListener();
    
    // Disconnect the SDK
    console.log('🔌 Disconnecting from Photon iMessage server...');
    await disconnectIMessage();
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Reconnect the SDK
    console.log('🔌 Reconnecting to Photon iMessage server...');
    await getIMessageSDK();
    
    // Restart the event listener
    console.log('▶️  Restarting iMessage event listener...');
    await startIMessageListener();
    
    console.log('✅ iMessage SDK reconnection complete');
    
    return reply.code(200).send({ 
      status: 'success',
      message: 'iMessage SDK reconnected successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Failed to reconnect iMessage SDK:', error);
    return reply.code(500).send({ 
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Test SSE endpoint (no auth required) - for debugging proxy issues
fastify.get('/debug/sse', async (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send initial message
  reply.raw.write('data: {"message": "SSE connection established"}\n\n');

  // Send a message every second for 5 seconds
  let count = 0;
  const interval = setInterval(() => {
    count++;
    reply.raw.write(`data: {"count": ${count}, "timestamp": "${new Date().toISOString()}"}\n\n`);
    
    if (count >= 5) {
      clearInterval(interval);
      reply.raw.write('data: {"message": "SSE test complete"}\n\n');
      reply.raw.end();
    }
  }, 1000);

  // Handle client disconnect
  request.raw.on('close', () => {
    clearInterval(interval);
    reply.raw.end();
  });
});

// Test long-lived SSE connection (mimics MCP behavior)
fastify.get('/debug/sse-long', async (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial endpoint event (like MCP does)
  const sessionId = Math.random().toString(36).substring(7);
  reply.raw.write('event: endpoint\n');
  reply.raw.write(`data: /debug/sse-long?sessionId=${sessionId}\n\n`);

  // Keep connection alive for 2 minutes, sending heartbeat every 10 seconds
  let count = 0;
  const interval = setInterval(() => {
    count++;
    reply.raw.write(`data: {"heartbeat": ${count}, "timestamp": "${new Date().toISOString()}"}\n\n`);
    
    if (count >= 12) { // 2 minutes (12 * 10 seconds)
      clearInterval(interval);
      reply.raw.write('data: {"message": "Long SSE test complete"}\n\n');
      reply.raw.end();
    }
  }, 10000); // Every 10 seconds

  // Handle client disconnect
  request.raw.on('close', () => {
    clearInterval(interval);
    reply.raw.end();
  });
});

// Serve favicon at root
fastify.get('/favicon.png', async (request, reply) => {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  // In Docker: /app/assets/favicon.png, Local: ../../assets/favicon.png from services/backend
  const faviconPath = process.env.NODE_ENV === 'production'
    ? '/app/assets/favicon.png'
    : path.join(process.cwd(), '../../assets/favicon.png');
  
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

// Serve Photon logo images
fastify.get('/photon-logo-light.png', async (request, reply) => {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  const logoPath = process.env.NODE_ENV === 'production'
    ? '/app/assets/photon-logo-light.png'
    : path.join(process.cwd(), '../../assets/photon-logo-light.png');
  
  try {
    const logo = await fs.readFile(logoPath);
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=31536000')
      .send(logo);
  } catch (error) {
    return reply.code(404).send({ error: 'Logo not found' });
  }
});

fastify.get('/photon-logo-dark.png', async (request, reply) => {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  const logoPath = process.env.NODE_ENV === 'production'
    ? '/app/assets/photon-logo-dark.png'
    : path.join(process.cwd(), '../../assets/photon-logo-dark.png');
  
  try {
    const logo = await fs.readFile(logoPath);
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=31536000')
      .send(logo);
  } catch (error) {
    return reply.code(404).send({ error: 'Logo not found' });
  }
});

// Serve background image for connect page
fastify.get('/assets/:filename', async (request, reply) => {
  const fs = await import('fs/promises');
  const path = await import('path');
  const { filename } = request.params as { filename: string };
  
  const imagePath = process.env.NODE_ENV === 'production'
    ? `/app/assets/${filename}`
    : path.join(process.cwd(), '../../assets', filename);
  
  try {
    const image = await fs.readFile(imagePath);
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === '.jpeg' || ext === '.jpg' ? 'image/jpeg' : 
                       ext === '.png' ? 'image/png' : 
                       ext === '.gif' ? 'image/gif' :
                       ext === '.woff2' ? 'font/woff2' :
                       ext === '.woff' ? 'font/woff' : 'application/octet-stream';
    
    return reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=31536000')
      .send(image);
  } catch (error) {
    return reply.code(404).send({ error: 'Asset not found' });
  }
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
    // Log UI design version and load connect routes
    console.log('🎨 Loading connect routes for version:', UI_DESIGN_VERSION);
    fastify.log.info(`🎨 Using UI design version: ${UI_DESIGN_VERSION}`);
    const connectRoutes = await loadConnectRoutes();
    console.log('✅ Connect routes loaded successfully');
    await fastify.register(connectRoutes, { prefix: '/connect' });
    
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
