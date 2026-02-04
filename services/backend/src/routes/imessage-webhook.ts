/**
 * iMessage Event Listener
 * Listens for incoming messages via SDK events (not webhooks)
 * Filters and forwards to worker queue for processing
 */

import { FastifyPluginAsync } from 'fastify';
import { getIMessageSDK } from '../lib/imessage.js';
import { prisma } from '@imessage-mcp/database';
import { sanitizeHandle, isEmail, hasCountryCode } from '@imessage-mcp/shared';
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
      // Filter 1: Ignore our own messages
      if (message.isFromMe) {
        console.log('⏭️  Ignoring message from self');
        return;
      }

      // Try to get chatGuid from message or from chats array
      let chatGuid = (message as any).chatGuid as string | undefined;
      
      // If chatGuid is not directly on the message, check if chats array exists
      if (!chatGuid) {
        const chats = (message as any).chats as Array<{ guid: string }> | undefined;
        if (chats && chats.length > 0) {
          chatGuid = chats[0].guid;
        }
      }
      
      if (!chatGuid) {
        console.warn('⚠️  Message missing chatGuid');
        return;
      }
      
      // Filter 2: Ignore group chats (chatGuid contains ;+;)
      if (chatGuid && chatGuid.includes(';+;')) {
        console.log('⏭️  Ignoring group chat message');
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

      // Validate phone number has country code (for proper queue separation)
      if (!isEmail(handle) && !hasCountryCode(handle)) {
        console.warn('⚠️  Phone number missing country code:', handle);
        console.warn('⚠️  This may cause issues with international users. Recommend using international format (+country_code)');
      }

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

      // Check if user wants to revoke/disconnect
      const revokeKeywords = /revoke|disconnect|stop manus|remove connection|delete.*data|unlink/i;
      if (revokeKeywords.test(messageText)) {
        console.log('🔌 Revoke request from:', handle);
        
        try {
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          
          // Send confirmation prompt
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, '⚠️ Are you sure you want to revoke your connection?\n\nThis will:\n• Disconnect your iMessage from Manus\n• Delete all your messages and data\n• Remove the MCP connector\n\nReply "YES REVOKE" to confirm, or anything else to cancel.');
          
          console.log('✅ Sent revocation confirmation prompt to:', handle);
        } catch (error) {
          console.error('❌ Failed to send revocation prompt:', error);
        }
        
        return;
      }

      // Check for help command
      if (/^help$/i.test(messageText.trim()) || /^commands$/i.test(messageText.trim())) {
        console.log('ℹ️  Help request from:', handle);
        
        try {
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, `📱 Manus iMessage Commands:

• "help" - Show this message
• "status" - Check connection status
• "revoke" - Disconnect and delete all data

Your messages are automatically sent to Manus AI for processing.

Need help? Visit https://manus.photon.codes`);
          
          console.log('✅ Sent help message to:', handle);
        } catch (error) {
          console.error('❌ Failed to send help message:', error);
        }
        
        return;
      }

      // Check for status command
      if (/^status$/i.test(messageText.trim())) {
        console.log('ℹ️  Status request from:', handle);
        
        try {
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          
          await sendTypingIndicator(handle, 1000);
          
          const statusMessage = `✅ Connection Status: ACTIVE

Phone: ${handle}
Connected: ${connection.activatedAt ? new Date(connection.activatedAt).toLocaleDateString() : 'N/A'}
Photon API Key: ${connection.photonApiKey?.substring(0, 15)}...

Your iMessage is connected to Manus AI.`;
          
          await sendIMessage(handle, statusMessage);
          
          console.log('✅ Sent status message to:', handle);
        } catch (error) {
          console.error('❌ Failed to send status message:', error);
        }
        
        return;
      }

      // Check for revocation confirmation
      if (/^yes\s+revoke$/i.test(messageText.trim())) {
        console.log('🔌 Revoke confirmation from:', handle);
        
        try {
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          
          // Send processing message
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, 'Revoking your connection...');
          
          // Delete webhook from Manus
          if (connection.webhookId && connection.manusApiKey) {
            try {
              await fetch(`https://api.manus.im/v1/webhooks/${connection.webhookId}`, {
                method: 'DELETE',
                headers: {
                  Authorization: `Bearer ${connection.manusApiKey}`,
                },
              });
              console.log('✅ Webhook deleted from Manus');
            } catch (error) {
              console.warn('⚠️  Failed to delete webhook from Manus:', error);
            }
          }

          // Clean up all user data in a transaction
          await prisma.$transaction(async (tx) => {
            // Delete all message queue entries
            const deletedQueueItems = await tx.messageQueue.deleteMany({
              where: { phoneNumber: handle },
            });
            console.log(`✅ Deleted ${deletedQueueItems.count} message queue items`);

            // Delete all Manus messages
            const deletedManusMessages = await tx.manusMessage.deleteMany({
              where: { phoneNumber: handle },
            });
            console.log(`✅ Deleted ${deletedManusMessages.count} Manus messages`);

            // Update connection status to REVOKED and clear sensitive data
            await tx.connection.update({
              where: { id: connection.id },
              data: {
                status: 'REVOKED',
                revokedAt: new Date(),
                manusApiKey: null,
                currentTaskId: null,
              },
            });
          });

          // Send confirmation
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, '✅ Your connection has been revoked and all data deleted.\n\nTo reconnect in the future, text "Hey Manus! Please connect my iMessage"');
          
          console.log('✅ Connection revoked and data cleaned up for:', handle);
        } catch (error) {
          console.error('❌ Failed to revoke connection:', error);
          
          try {
            const { sendIMessage } = await import('../lib/imessage.js');
            await sendIMessage(handle, '❌ Failed to revoke connection. Please try again or visit https://manus.photon.codes/connect/revoke');
          } catch (sendError) {
            console.error('❌ Failed to send error message:', sendError);
          }
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

      console.log('📨 Message received:', {
        from: handle,
        text: messageText.substring(0, 50) + (messageText.length > 50 ? '...' : ''),
        attachments: attachments?.length || 0,
      });

      // Add to queue for worker to process
      const queue = getQueue(handle);
      await queue.add('incoming-message', {
        phoneNumber: handle,
        messageText,
        messageGuid: message.guid,
        attachments,
      });

      console.log('✅ Message queued for processing');
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
