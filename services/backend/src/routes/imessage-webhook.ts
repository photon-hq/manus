/**
 * iMessage Webhook Handler
 * Receives incoming messages from iMessage infrastructure
 * Processes attachments and forwards to worker queue
 */

import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@imessage-mcp/database';
import { z } from 'zod';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

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

// Redis connection for queue
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Map to cache queues per phone number
const queues = new Map<string, Queue>();

// Get or create queue for a phone number
function getQueue(phoneNumber: string): Queue {
  if (!queues.has(phoneNumber)) {
    const queue = new Queue(`messages:${phoneNumber}`, {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
    queues.set(phoneNumber, queue);
  }
  return queues.get(phoneNumber)!;
}

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

      // Add to queue for worker to process
      const queue = getQueue(phoneNumber);
      await queue.add('incoming-message', {
        phoneNumber,
        messageText,
        messageGuid: message.guid,
        attachments,
      });

      fastify.log.info({ phoneNumber, messageGuid: message.guid }, 'Message added to queue');

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
