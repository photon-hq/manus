/**
 * iMessage Event Listener
 * Listens for incoming messages via SDK events (not webhooks)
 * Filters and forwards to worker queue for processing
 */

import { FastifyPluginAsync } from 'fastify';
import { getIMessageSDK } from '../lib/imessage.js';
import { prisma } from '@imessage-mcp/database';
import { sanitizeHandle } from '@imessage-mcp/shared';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

// Redis connection for queue
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Map to cache queues per phone number
const queues = new Map<string, Queue>();

// Get or create queue for a handle (phone number or email)
function getQueue(handle: string): Queue {
  if (!queues.has(handle)) {
    // Sanitize handle for queue name (works for both phone numbers and emails)
    const sanitizedHandle = sanitizeHandle(handle);
    const queue = new Queue(`messages-${sanitizedHandle}`, {
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
    queues.set(handle, queue);
  }
  return queues.get(handle)!;
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

      // Extract handle (phone number or email) from chatGuid
      // Format: any;-;+1234567890 (SMS/iMessage via phone)
      //     or: iMessage;-;user@icloud.com (iMessage via iCloud)
      const parts = chatGuid.split(';-;');
      if (parts.length !== 2) {
        console.warn('⚠️  Invalid chatGuid format:', chatGuid);
        return;
      }

      const handle = parts[1]; // Can be phone number or iCloud email

      // Extract message text
      const messageText = message.text || '';

      // Check if this is a connection initiation message
      const isConnectionRequest = /hey\s+manus.*connect.*imessage/i.test(messageText) || 
                                  /connect.*imessage/i.test(messageText);

      if (isConnectionRequest) {
        console.log('🔗 Connection request detected from:', handle);
        
        // Check if connection already exists
        const existingConnection = await prisma.connection.findFirst({
          where: { phoneNumber: handle },
        });

        if (existingConnection && existingConnection.status === 'ACTIVE') {
          console.log('ℹ️  Connection already active for:', handle);
          // Send reminder message
          const { sendIMessage } = await import('../lib/imessage.js');
          await sendIMessage(handle, "You're already connected! You can start using Manus with your iMessage.");
          return;
        }

        // Create new connection via internal API call
        try {
          const { generateConnectionId, getConnectionExpiry } = await import('@imessage-mcp/shared');
          const connectionId = generateConnectionId();
          const expiresAt = getConnectionExpiry();

          // Create pending connection
          await prisma.connection.upsert({
            where: { phoneNumber: handle },
            create: {
              connectionId,
              phoneNumber: handle,
              status: 'PENDING',
              expiresAt,
            },
            update: {
              connectionId,
              status: 'PENDING',
              expiresAt,
            },
          });

          console.log('✅ Connection created:', { connectionId, handle });

          // Send response with link
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          const linkUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/connect/${connectionId}`;

          // [1 sec typing indicator] "Sure!"
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, 'Sure!');

          // [1.5 sec typing indicator] "Please input your Manus token..."
          await sendTypingIndicator(handle, 1500);
          await sendIMessage(handle, `Please input your Manus token in the following link:\n\n${linkUrl}`);

          console.log('✅ Connection setup message sent to:', handle);
        } catch (error) {
          console.error('❌ Failed to handle connection request:', error);
        }
        
        return; // Don't process as regular message
      }

      // Check if connection exists and is active
      const connection = await prisma.connection.findFirst({
        where: {
          phoneNumber: handle,
          status: 'ACTIVE',
        },
      });

      if (!connection) {
        console.log('⏭️  No active connection for:', handle);
        
        // Check if user is trying to disconnect
        if (/disconnect|stop|remove|revoke/i.test(messageText)) {
          const { sendIMessage } = await import('../lib/imessage.js');
          await sendIMessage(handle, "You don't have an active connection.");
          return;
        }
        
        // Send helpful message
        const { sendIMessage } = await import('../lib/imessage.js');
        await sendIMessage(handle, `Please connect first: ${process.env.PUBLIC_URL || 'http://localhost:3000'}/connect`);
        return;
      }

      // Check if user wants to disconnect
      if (/disconnect|stop manus|remove connection/i.test(messageText)) {
        console.log('🔌 Disconnect request from:', handle);
        
        try {
          // Delete webhook from Manus
          if (connection.webhookId && connection.manusApiKey) {
            await fetch(`https://api.manus.im/v1/webhooks/${connection.webhookId}`, {
              method: 'DELETE',
              headers: {
                Authorization: `Bearer ${connection.manusApiKey}`,
              },
            });
          }

          // Update status to REVOKED
          await prisma.connection.update({
            where: { id: connection.id },
            data: {
              status: 'REVOKED',
              revokedAt: new Date(),
            },
          });

          const { sendIMessage } = await import('../lib/imessage.js');
          await sendIMessage(handle, 'Your connection has been disconnected. Thanks for using Manus!');
          
          console.log('✅ Connection revoked for:', handle);
        } catch (error) {
          console.error('❌ Failed to disconnect:', error);
        }
        
        return;
      }

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
        handle,
        messageGuid: message.guid,
        textLength: messageText.length,
        attachmentCount: attachments?.length || 0,
      });

      // Add to queue for worker to process
      const queue = getQueue(handle);
      await queue.add('incoming-message', {
        phoneNumber: handle,
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
  // No routes needed here - health check is in main index.ts
};
