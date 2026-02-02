import { FastifyPluginAsync } from 'fastify';
import { prisma, Status } from '@imessage-mcp/database';
import {
  generateConnectionId,
  generatePhotonApiKey,
  getConnectionExpiry,
  normalizePhoneNumber,
} from '@imessage-mcp/shared';
import { z } from 'zod';

const InitiateSchema = z.object({
  phoneNumber: z.string(),
  message: z.string(),
});

const SubmitTokenSchema = z.object({
  connectionId: z.string(),
  manusApiKey: z.string().startsWith('manus_'),
});

const RevokeSchema = z.object({
  photonApiKey: z.string().startsWith('photon_sk_'),
});

export const connectRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/connect/initiate - Handle initial iMessage
  fastify.post('/initiate', async (request, reply) => {
    try {
      const body = InitiateSchema.parse(request.body);
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

      fastify.log.info({ connectionId, phoneNumber }, 'Connection initiated');

      // Send iMessage back to user with link
      const linkUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/connect/page/${connectionId}`;
      try {
        const { sendIMessage } = await import('../lib/imessage.js');
        await sendIMessage(phoneNumber, `Sure! Please input your Manus token in the following link:\n${linkUrl}`);
      } catch (error) {
        fastify.log.error({ error }, 'Failed to send iMessage');
        // Continue anyway - user can still access the link
      }

      return {
        success: true,
        connectionId,
        message: 'Connection initiated. Check your iMessage for next steps.',
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to initiate connection');
      return reply.code(400).send({ error: 'Invalid request' });
    }
  });

  // POST /api/connect/submit-token - Submit Manus API key
  fastify.post('/submit-token', async (request, reply) => {
    try {
      const body = SubmitTokenSchema.parse(request.body);
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
            args: ['@photon-ai/manus-mcp@latest'],
            env: {
              PHOTON_API_KEY: photonApiKey,
            },
          },
        },
      };

      // Send iMessage with MCP config
      try {
        const { sendIMessage } = await import('../lib/imessage.js');
        const configText = JSON.stringify(mcpConfig, null, 2);
        await sendIMessage(
          connection.phoneNumber,
          `You're all set! 🎉\n\nYour Photon API Key:\n${photonApiKey}\n\nAdd this MCP config to Manus:\n\n${configText}`
        );
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
      fastify.log.error(error, 'Failed to submit token');
      return reply.code(400).send({ error: 'Invalid request' });
    }
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

    // Simple HTML form
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connect to Manus</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
            input { width: 100%; padding: 10px; margin: 10px 0; font-size: 16px; }
            button { width: 100%; padding: 12px; background: #007bff; color: white; border: none; font-size: 16px; cursor: pointer; }
            button:hover { background: #0056b3; }
          </style>
        </head>
        <body>
          <h1>Connect to Manus AI</h1>
          <p>Enter your Manus API key to complete the connection.</p>
          <form id="tokenForm">
            <input type="text" id="manusApiKey" placeholder="manus_sk_..." required />
            <button type="submit">Connect</button>
          </form>
          <div id="result"></div>
          <script>
            document.getElementById('tokenForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const manusApiKey = document.getElementById('manusApiKey').value;
              const response = await fetch('/api/connect/submit-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId: '${connectionId}', manusApiKey })
              });
              const data = await response.json();
              if (data.success) {
                document.getElementById('result').innerHTML = '<h2>Success! 🎉</h2><p>Your Photon API Key:</p><pre>' + data.photonApiKey + '</pre><p>Add this to Manus:</p><pre>' + JSON.stringify(data.mcpConfig, null, 2) + '</pre>';
              } else {
                document.getElementById('result').innerHTML = '<p style="color:red;">Error: ' + data.error + '</p>';
              }
            });
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
