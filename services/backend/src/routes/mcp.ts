import { FastifyPluginAsync } from 'fastify';
import { prisma, Status } from '@imessage-mcp/database';
import { isManusMessage, formatManusMessage } from '@imessage-mcp/shared';
import { z } from 'zod';

const SendMessageSchema = z.object({
  message: z.string(),
});

export const mcpRoutes: FastifyPluginAsync = async (fastify) => {
  // Middleware to validate Photon API key
  fastify.addHook('preHandler', async (request, reply) => {
    const authHeader = request.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid authorization header' });
    }

    const photonApiKey = authHeader.replace('Bearer ', '');

    const connection = await prisma.connection.findUnique({
      where: { photonApiKey },
    });

    if (!connection || connection.status !== Status.ACTIVE) {
      return reply.code(401).send({ error: 'Invalid or inactive API key' });
    }

    // Attach connection to request
    (request as any).connection = connection;
  });

  // GET /api/mcp/fetch - Fetch conversation history
  fastify.get('/fetch', async (request, reply) => {
    try {
      const connection = (request as any).connection;
      const { phoneNumber } = connection;

      // Fetch messages from iMessage infrastructure
      const messages = await fetchIMessages(phoneNumber);

      // Get Manus message GUIDs to filter out
      const manusMessageGuids = await prisma.manusMessage.findMany({
        where: { phoneNumber },
        select: { messageGuid: true },
      });

      const guidSet = new Set(manusMessageGuids.map((m) => m.messageGuid));

      // Filter out Manus messages
      const filteredMessages = messages.filter(
        (msg) => !isManusMessage(msg.text) && !guidSet.has(msg.guid || '')
      );

      fastify.log.info(
        { phoneNumber, total: messages.length, filtered: filteredMessages.length },
        'Fetched messages'
      );

      return {
        messages: filteredMessages,
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to fetch messages');
      return reply.code(500).send({ error: 'Failed to fetch messages' });
    }
  });

  // POST /api/mcp/send - Send message to user
  fastify.post('/send', async (request, reply) => {
    try {
      const connection = (request as any).connection;
      const { phoneNumber } = connection;
      const body = SendMessageSchema.parse(request.body);

      // Format message with [Manus] prefix
      const formattedMessage = formatManusMessage(body.message);

      // Send via iMessage infrastructure
      const messageGuid = await sendIMessage(phoneNumber, formattedMessage);

      // Record in database
      await prisma.manusMessage.create({
        data: {
          messageGuid,
          phoneNumber,
          messageType: 'MANUAL',
        },
      });

      fastify.log.info({ phoneNumber, messageGuid }, 'Message sent');

      return {
        success: true,
        messageGuid,
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to send message');
      return reply.code(500).send({ error: 'Failed to send message' });
    }
  });
};

// Helper functions - these will integrate with your iMessage infrastructure
async function fetchIMessages(phoneNumber: string): Promise<any[]> {
  // TODO: Integrate with advanced-imessage-kit or your custom iMessage infrastructure
  // This is a placeholder implementation
  
  const endpoint = process.env.IMESSAGE_ENDPOINT;
  const apiKey = process.env.IMESSAGE_API_KEY;

  if (!endpoint || !apiKey) {
    throw new Error('iMessage configuration missing');
  }

  try {
    const response = await fetch(`${endpoint}/messages?phone=${phoneNumber}&limit=100`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`iMessage API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.messages || [];
  } catch (error) {
    console.error('Failed to fetch iMessages:', error);
    return [];
  }
}

async function sendIMessage(phoneNumber: string, message: string): Promise<string> {
  // TODO: Integrate with advanced-imessage-kit or your custom iMessage infrastructure
  // This is a placeholder implementation
  
  const endpoint = process.env.IMESSAGE_ENDPOINT;
  const apiKey = process.env.IMESSAGE_API_KEY;

  if (!endpoint || !apiKey) {
    throw new Error('iMessage configuration missing');
  }

  try {
    const response = await fetch(`${endpoint}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: phoneNumber,
        message,
      }),
    });

    if (!response.ok) {
      throw new Error(`iMessage API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.messageGuid || data.guid || `msg_${Date.now()}`;
  } catch (error) {
    console.error('Failed to send iMessage:', error);
    throw error;
  }
}
