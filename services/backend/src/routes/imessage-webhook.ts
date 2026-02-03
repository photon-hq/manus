/**
 * iMessage Event Listener
 * Listens for incoming messages via SDK events (not webhooks)
 * Filters and forwards to worker queue for processing
 */

import { FastifyPluginAsync } from 'fastify';
import { getIMessageSDK } from '../lib/imessage.js';
import { prisma } from '@imessage-mcp/database';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

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

/**
 * Start listening for incoming iMessages via SDK events
 */
export async function startIMessageListener() {
  const sdk = await getIMessageSDK();

  console.log('🎧 Starting iMessage event listener...');

  // Listen for new messages
  sdk.on('new-message', async (message) => {
    try {
      // Debug: Log full message structure
      console.log('🔍 DEBUG: Received message:', JSON.stringify({
        guid: message.guid,
        isFromMe: message.isFromMe,
        text: message.text?.substring(0, 50),
        chatGuid: (message as any).chatGuid,
        chats: (message as any).chats,
        handle: (message as any).handle,
        handleId: (message as any).handleId,
        keys: Object.keys(message),
      }, null, 2));

      // Filter 1: Ignore our own messages
      if (message.isFromMe) {
        console.log('⏭️  Ignoring message from self:', message.guid);
        return;
      }

      // Try to get chatGuid from message or from chats array
      let chatGuid = (message as any).chatGuid as string | undefined;
      
      // If chatGuid is not directly on the message, check if chats array exists
      if (!chatGuid) {
        const chats = (message as any).chats as Array<{ guid: string }> | undefined;
        if (chats && chats.length > 0) {
          chatGuid = chats[0].guid;
          console.log('📍 Extracted chatGuid from chats array:', chatGuid);
        }
      }
      
      if (!chatGuid) {
        console.warn('⚠️  Message missing chatGuid:', message.guid);
        console.log('Available properties:', Object.keys(message));
        return;
      }
      
      // Filter 2: Ignore group chats (chatGuid contains ;+;)
      if (chatGuid.includes(';+;')) {
        console.log('⏭️  Ignoring group chat message:', message.guid);
        return;
      }
      
      if (chatGuid.includes(';+;')) {
        console.log('⏭️  Ignoring group chat message:', message.guid);
        return;
      }

      // Extract phone number from chatGuid
      // Format: any;-;+1234567890 or iMessage;-;user@icloud.com
      const parts = chatGuid.split(';-;');
      if (parts.length !== 2) {
        console.warn('⚠️  Invalid chatGuid format:', chatGuid);
        return;
      }

      const phoneNumber = parts[1];

      // Check if connection exists and is active
      const connection = await prisma.connection.findFirst({
        where: {
          phoneNumber,
          status: 'ACTIVE',
        },
      });

      if (!connection) {
        console.log('⏭️  No active connection for:', phoneNumber);
        return;
      }

      // Extract message text
      const messageText = message.text || '';

      // Extract attachments
      const attachments = message.attachments?.map((att: any) => ({
        guid: att.guid,
        filename: att.transferName || 'file',
        mimeType: att.mimeType || 'application/octet-stream',
      }));

      // Skip empty messages without attachments
      if (!messageText && (!attachments || attachments.length === 0)) {
        console.log('⏭️  Ignoring empty message:', message.guid);
        return;
      }

      console.log('📨 Received iMessage:', {
        phoneNumber,
        messageGuid: message.guid,
        textLength: messageText.length,
        attachmentCount: attachments?.length || 0,
      });

      // Add to queue for worker to process
      const queue = getQueue(phoneNumber);
      await queue.add('incoming-message', {
        phoneNumber,
        messageText,
        messageGuid: message.guid,
        attachments,
      });

      console.log('✅ Message queued:', message.guid);
    } catch (error) {
      console.error('❌ Error processing message:', error);
      // Don't throw - continue listening for other messages
    }
  });

  // Handle SDK events for monitoring
  sdk.on('disconnect', () => {
    console.warn('⚠️  iMessage SDK disconnected - will auto-reconnect');
  });

  sdk.on('ready', () => {
    console.log('✅ iMessage SDK ready');
  });

  sdk.on('error', (error) => {
    console.error('❌ iMessage SDK error:', error);
  });

  // Periodic cleanup to prevent memory leaks
  setInterval(() => {
    sdk.clearProcessedMessages(1000);
    console.log('🧹 Cleared processed messages cache');
  }, 5 * 60 * 1000); // Every 5 minutes

  console.log('✅ iMessage event listener started');
}

/**
 * Cleanup function for graceful shutdown
 */
export async function stopIMessageListener() {
  // Close all queues
  for (const queue of queues.values()) {
    await queue.close();
  }
  queues.clear();

  // Disconnect Redis
  await redis.quit();

  console.log('🛑 iMessage event listener stopped');
}

// Legacy webhook routes (kept for backwards compatibility, but not used)
export const imessageWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/imessage/health - Health check
  fastify.get('/health', async () => {
    return { status: 'ok', service: 'imessage-events' };
  });
};
