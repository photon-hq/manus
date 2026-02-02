/**
 * iMessage Webhook Handler
 * Receives incoming messages from iMessage infrastructure
 * Processes attachments and forwards to worker queue
 */

import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@imessage-mcp/database';
import { z } from 'zod';

// Schema for incoming iMessage webhook
const IMessageWebhookSchema = z.object({
  chatGuid: z.string(),
  message: z.object({
    guid: z.string(),
    text: z.string().optional(),
    isFromMe: z.boolean(),
    dateCreated: z.number(),
    attachments: z.array(z.object({
      guid: z.string(),
      transferName: z.string(),
      mimeType: z.string().optional(),
    })).optional(),
  }),
  phoneNumber: z.string(),
});

export const imessageWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/imessage/webhook - Receive incoming iMessages
  fastify.post('/webhook', async (request, reply) => {
    try {
      const data = IMessageWebhookSchema.parse(request.body);
      const { phoneNumber, message } = data;

      // Ignore messages from us
      if (message.isFromMe) {
        return { success: true, ignored: true, reason: 'from_me' };
      }

      // Check if connection exists and is active
      const connection = await prisma.connection.findFirst({
        where: {
          phoneNumber,
          status: 'ACTIVE',
        },
      });

      if (!connection) {
        fastify.log.warn({ phoneNumber }, 'No active connection found for incoming message');
        return { success: true, ignored: true, reason: 'no_connection' };
      }

      // Extract text
      const messageText = message.text || '';
      
      // Skip empty messages without attachments
      if (!messageText && (!message.attachments || message.attachments.length === 0)) {
        return { success: true, ignored: true, reason: 'empty_message' };
      }

      // Extract attachments
      const attachments = message.attachments?.map(att => ({
        guid: att.guid,
        filename: att.transferName || 'file',
        mimeType: att.mimeType || 'application/octet-stream',
      }));

      fastify.log.info(
        { phoneNumber, messageGuid: message.guid, hasAttachments: !!attachments?.length },
        'Received iMessage'
      );

      // Forward to worker for processing
      // Import dynamically to avoid circular dependencies
      const { handleIncomingMessage } = await import('../../../worker/src/index.js');
      await handleIncomingMessage(phoneNumber, messageText, message.guid, attachments);

      return {
        success: true,
        messageGuid: message.guid,
        attachmentCount: attachments?.length || 0,
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to process iMessage webhook');
      return reply.code(500).send({ error: 'Failed to process message' });
    }
  });

  // GET /api/imessage/health - Health check
  fastify.get('/health', async () => {
    return { status: 'ok', service: 'imessage-webhook' };
  });
};
