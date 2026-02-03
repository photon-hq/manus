import { FastifyPluginAsync } from 'fastify';
import { prisma, Status } from '@imessage-mcp/database';
import {
  generateConnectionId,
  generatePhotonApiKey,
  getConnectionExpiry,
  normalizePhoneNumber,
} from '@imessage-mcp/shared';
import { z } from 'zod';

const StartSchema = z.object({
  phoneNumber: z.string(),
});

const InitiateSchema = z.object({
  phoneNumber: z.string(),
  message: z.string().optional(),
});

const VerifySchema = z.object({
  connectionId: z.string(),
  manusApiKey: z.string().startsWith('manus_'),
});

const RevokeSchema = z.object({
  photonApiKey: z.string().startsWith('photon_sk_'),
});

export const connectRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/connect/start - Handle initial iMessage (new flow)
  fastify.post('/start', async (request, reply) => {
    try {
      const body = StartSchema.parse(request.body);
      const phoneNumber = normalizePhoneNumber(body.phoneNumber);
      const connectionId = generateConnectionId();
      const expiresAt = getConnectionExpiry();

      // Create pending connection
      const connection = await prisma.connection.create({
        data: {
          connectionId,
          phoneNumber,
          status: Status.PENDING,
          expiresAt,
        },
      });

      fastify.log.info({ connectionId, phoneNumber }, 'Connection started');

      // Send iMessage back to user with typing indicators
      const linkUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/connect/page/${connectionId}`;
      try {
        const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
        
        // [2 sec typing indicator] "Sure!"
        await sendTypingIndicator(phoneNumber, 2000);
        await sendIMessage(phoneNumber, 'Sure!');
        
        // [3 sec typing indicator] "Please input your Manus token..."
        await sendTypingIndicator(phoneNumber, 3000);
        await sendIMessage(phoneNumber, `Please input your Manus token in the following link:\n\n${linkUrl}`);
      } catch (error) {
        fastify.log.error({ error }, 'Failed to send iMessage');
        // Continue anyway - user can still access the link
      }

      return {
        success: true,
        connectionId,
        message: 'Connection started. Check your iMessage for next steps.',
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to start connection');
      return reply.code(400).send({ error: 'Invalid request' });
    }
  });

  // POST /api/connect/initiate - Handle initial iMessage (legacy, redirects to /start)
  fastify.post('/initiate', async (request, reply) => {
    return fastify.inject({
      method: 'POST',
      url: '/api/connect/start',
      payload: request.body,
      headers: request.headers,
    }).then(res => {
      reply.code(res.statusCode);
      return res.json();
    });
  });

  // POST /api/connect/verify - Submit Manus API key
  fastify.post('/verify', async (request, reply) => {
    try {
      const body = VerifySchema.parse(request.body);
      const { connectionId, manusApiKey } = body;

      // Find pending connection
      const connection = await prisma.connection.findUnique({
        where: { connectionId },
      });

      if (!connection) {
        return reply.code(404).send({ error: 'Connection not found' });
      }

      if (connection.status !== Status.PENDING) {
        return reply.code(400).send({ error: 'Connection already processed' });
      }

      if (connection.expiresAt && new Date() > connection.expiresAt) {
        return reply.code(400).send({ error: 'Connection expired' });
      }

      // Register webhook with Manus
      const webhookId = await registerManusWebhook(manusApiKey);

      // Generate Photon API key
      const photonApiKey = generatePhotonApiKey();

      // Update connection to ACTIVE
      await prisma.connection.update({
        where: { connectionId },
        data: {
          manusApiKey,
          photonApiKey,
          webhookId,
          status: Status.ACTIVE,
          activatedAt: new Date(),
        },
      });

      fastify.log.info({ connectionId, phoneNumber: connection.phoneNumber }, 'Connection activated');

      // MCP config for user
      const mcpConfig = {
        mcpServers: {
          'photon-imessage': {
            command: 'npx',
            args: ['photon-manus-mcp@latest'],
            env: {
              PHOTON_API_KEY: photonApiKey,
              BACKEND_URL: process.env.PUBLIC_URL || 'https://manus.photon.codes',
            },
          },
        },
      };

      // Send iMessage with MCP config and typing indicators
      try {
        const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
        const configText = JSON.stringify(mcpConfig, null, 2);
        
        // [1 sec typing indicator] "You're all set! 🎉"
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "You're all set! 🎉");
        
        // [1 sec typing indicator] "You can also add the MCP config..."
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "You can also add the MCP config to your Manus:");
        
        // Send MCP config
        await sendIMessage(connection.phoneNumber, configText);
        
        // Send link to Manus settings
        await sendIMessage(connection.phoneNumber, "Paste it here: https://manus.im/settings/mcp");
      } catch (error) {
        fastify.log.error({ error }, 'Failed to send iMessage');
        // Continue anyway - user sees config on web page
      }

      return {
        success: true,
        photonApiKey,
        mcpConfig,
        message: 'Connection activated successfully!',
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to verify token');
      return reply.code(400).send({ error: 'Invalid request' });
    }
  });

  // POST /api/connect/submit-token - Legacy endpoint (redirects to /verify)
  fastify.post('/submit-token', async (request, reply) => {
    return fastify.inject({
      method: 'POST',
      url: '/api/connect/verify',
      payload: request.body,
      headers: request.headers,
    }).then(res => {
      reply.code(res.statusCode);
      return res.json();
    });
  });

  // POST /api/connect/revoke - Revoke connection
  fastify.post('/revoke', async (request, reply) => {
    try {
      const body = RevokeSchema.parse(request.body);
      const { photonApiKey } = body;

      const connection = await prisma.connection.findUnique({
        where: { photonApiKey },
      });

      if (!connection) {
        return reply.code(404).send({ error: 'Connection not found' });
      }

      // Delete webhook from Manus
      if (connection.webhookId && connection.manusApiKey) {
        await deleteManusWebhook(connection.manusApiKey, connection.webhookId);
      }

      // Update status to REVOKED
      await prisma.connection.update({
        where: { photonApiKey },
        data: {
          status: Status.REVOKED,
          revokedAt: new Date(),
        },
      });

      fastify.log.info({ photonApiKey }, 'Connection revoked');

      return {
        success: true,
        message: 'Connection revoked successfully',
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to revoke connection');
      return reply.code(400).send({ error: 'Invalid request' });
    }
  });

  // GET /manus/connect/:connectionId - Landing page for token input
  fastify.get('/page/:connectionId', async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };

    const connection = await prisma.connection.findUnique({
      where: { connectionId },
    });

    if (!connection) {
      return reply.code(404).send('Connection not found');
    }

    // HTML form with improved UI
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connect to Manus AI</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f7; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { font-size: 28px; margin-bottom: 10px; color: #1d1d1f; }
            p { color: #6e6e73; margin-bottom: 20px; line-height: 1.5; }
            a { color: #0066cc; text-decoration: none; }
            a:hover { text-decoration: underline; }
            input { width: 100%; padding: 12px; margin: 10px 0; font-size: 16px; border: 1px solid #d2d2d7; border-radius: 8px; }
            input:focus { outline: none; border-color: #0066cc; }
            button { width: 100%; padding: 14px; background: #0066cc; color: white; border: none; font-size: 16px; font-weight: 600; cursor: pointer; border-radius: 8px; margin-top: 10px; }
            button:hover { background: #0055b3; }
            button:disabled { background: #d2d2d7; cursor: not-allowed; }
            .success { display: none; }
            .success h2 { color: #1d1d1f; margin-bottom: 20px; }
            .config-box { background: #f5f5f7; padding: 20px; border-radius: 8px; margin: 20px 0; position: relative; }
            .config-box pre { overflow-x: auto; font-size: 13px; line-height: 1.6; }
            .copy-btn { position: absolute; top: 10px; right: 10px; padding: 8px 16px; background: #0066cc; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; }
            .copy-btn:hover { background: #0055b3; }
            .copy-btn.copied { background: #34c759; }
            .link-btn { display: inline-block; padding: 12px 24px; background: #0066cc; color: white; text-decoration: none; border-radius: 8px; margin-top: 10px; }
            .link-btn:hover { background: #0055b3; text-decoration: none; }
            .error { color: #ff3b30; margin-top: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div id="form-section">
              <h1>Connect to Manus AI</h1>
              <p>Enter your Manus API key to complete the connection.</p>
              <p><a href="https://open.manus.im" target="_blank">Get your Manus API key →</a></p>
              <form id="tokenForm">
                <input type="text" id="manusApiKey" placeholder="manus_sk_..." required />
                <button type="submit" id="submitBtn">Next</button>
              </form>
              <div id="error" class="error"></div>
            </div>
            
            <div id="success-section" class="success">
              <h2>You're all set! 🎉</h2>
              <p>Your connection is active. Add the MCP config below to your Manus settings:</p>
              
              <div class="config-box">
                <button class="copy-btn" onclick="copyConfig()">Copy</button>
                <pre id="config"></pre>
              </div>
              
              <a href="https://manus.im/settings/mcp" target="_blank" class="link-btn">Open Manus Settings →</a>
              
              <p style="margin-top: 20px; font-size: 14px;">The configuration has also been sent to your iMessage.</p>
            </div>
          </div>
          
          <script>
            let mcpConfigData = null;
            
            document.getElementById('tokenForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const submitBtn = document.getElementById('submitBtn');
              const errorDiv = document.getElementById('error');
              const manusApiKey = document.getElementById('manusApiKey').value;
              
              submitBtn.disabled = true;
              submitBtn.textContent = 'Connecting...';
              errorDiv.textContent = '';
              
              try {
                const response = await fetch('/api/connect/verify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ connectionId: '${connectionId}', manusApiKey })
                });
                
                const data = await response.json();
                
                if (data.success) {
                  mcpConfigData = data.mcpConfig;
                  document.getElementById('config').textContent = JSON.stringify(data.mcpConfig, null, 2);
                  document.getElementById('form-section').style.display = 'none';
                  document.getElementById('success-section').style.display = 'block';
                } else {
                  errorDiv.textContent = 'Error: ' + (data.error || 'Failed to connect');
                  submitBtn.disabled = false;
                  submitBtn.textContent = 'Next';
                }
              } catch (error) {
                errorDiv.textContent = 'Error: ' + error.message;
                submitBtn.disabled = false;
                submitBtn.textContent = 'Next';
              }
            });
            
            function copyConfig() {
              const configText = JSON.stringify(mcpConfigData, null, 2);
              navigator.clipboard.writeText(configText).then(() => {
                const btn = document.querySelector('.copy-btn');
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => {
                  btn.textContent = 'Copy';
                  btn.classList.remove('copied');
                }, 2000);
              });
            }
          </script>
        </body>
      </html>
    `);
  });
};

// Helper functions
async function registerManusWebhook(manusApiKey: string): Promise<string> {
  const response = await fetch('https://api.manus.im/v1/webhooks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${manusApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/webhooks/manus`,
      events: ['task_created', 'task_progress', 'task_stopped'],
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to register webhook with Manus');
  }

  const data = await response.json();
  return data.webhook_id || data.id;
}

async function deleteManusWebhook(manusApiKey: string, webhookId: string): Promise<void> {
  await fetch(`https://api.manus.im/v1/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${manusApiKey}`,
    },
  });
}
