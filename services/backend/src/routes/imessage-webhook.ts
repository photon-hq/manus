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
  console.log('🔧 Debug configuration:', {
    ALLOW_SELF_MESSAGES: process.env.ALLOW_SELF_MESSAGES,
    ALWAYS_SHARE_CONTACT_CARD: process.env.ALWAYS_SHARE_CONTACT_CARD,
    CONTACT_NAME: process.env.CONTACT_NAME,
    CONTACT_EMAIL: process.env.CONTACT_EMAIL,
  });

  // Listen for new messages
  sdk.on('new-message', async (message) => {
    try {
      // Filter 1: Ignore our own messages (unless debug mode is enabled)
      const allowSelfMessages = process.env.ALLOW_SELF_MESSAGES === 'true';
      
      // Debug logging for environment variables
      console.log('🔍 Debug flags:', {
        ALLOW_SELF_MESSAGES: process.env.ALLOW_SELF_MESSAGES,
        allowSelfMessages,
        ALWAYS_SHARE_CONTACT_CARD: process.env.ALWAYS_SHARE_CONTACT_CARD,
        isFromMe: message.isFromMe,
      });
      
      if (message.isFromMe && !allowSelfMessages) {
        console.log('⏭️  Ignoring message from self (ALLOW_SELF_MESSAGES not enabled)');
        return;
      }
      
      if (message.isFromMe && allowSelfMessages) {
        console.log('⚠️  Processing self-message (debug mode enabled)');
      }

      // Filter 2: Ignore reactions/tapbacks (they have associatedMessageGuid or associatedMessageType)
      const associatedMessageGuid = (message as any).associatedMessageGuid as string | undefined;
      const associatedMessageType = (message as any).associatedMessageType as string | undefined;
      if (associatedMessageGuid || associatedMessageType) {
        console.log('⏭️  Ignoring reaction/tapback (associated with another message)');
        return;
      }

      // Filter 3: Ignore stickers
      const attachments = (message as any).attachments as Array<any> | undefined;
      const hasSticker = attachments?.some((att: any) => att.isSticker === true);
      if (hasSticker) {
        console.log('⏭️  Ignoring sticker message');
        return;
      }

      // Filter 4: Ignore text-based reactions (e.g., "Loved \"message\"", "Emphasized \"message\"")
      const messageText = message.text || '';
      const reactionPatterns = [
        /^Loved\s+".*"$/i,
        /^Liked\s+".*"$/i,
        /^Disliked\s+".*"$/i,
        /^Laughed at\s+".*"$/i,
        /^Emphasized\s+".*"$/i,
        /^Questioned\s+".*"$/i,
        /^Loved\s+an image$/i,
        /^Liked\s+an image$/i,
        /^Disliked\s+an image$/i,
        /^Laughed at\s+an image$/i,
        /^Emphasized\s+an image$/i,
        /^Questioned\s+an image$/i,
        /^Removed a heart from\s+".*"$/i,
        /^Removed a like from\s+".*"$/i,
        /^Removed a dislike from\s+".*"$/i,
        /^Removed a laugh from\s+".*"$/i,
        /^Removed an emphasis from\s+".*"$/i,
        /^Removed a question mark from\s+".*"$/i,
      ];
      
      if (reactionPatterns.some(pattern => pattern.test(messageText))) {
        console.log('⏭️  Ignoring text-based reaction:', messageText.substring(0, 50));
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
      
      // Filter 5: Ignore group chats (chatGuid contains ;+;)
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

          // [1.5 sec typing indicator] "Please input your Manus token in the following link:"
          await sendTypingIndicator(handle, 1500);
          await sendIMessage(handle, 'Please input your Manus token in the following link:');
          
          // [1 sec typing indicator] Send link as separate message
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, linkUrl);

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
        
        // Check if user is trying to revoke (exact command only)
        if (/^revoke$/i.test(messageText.trim())) {
          const { sendIMessage } = await import('../lib/imessage.js');
          await sendIMessage(handle, "You don't have an active connection.");
          return;
        }
        
        // Create connection for any message (not just magic phrase)
        console.log('🔗 Creating connection for unconnected user:', handle);
        
        try {
          const { generateConnectionId, getConnectionExpiry } = await import('@imessage-mcp/shared');
          const connectionId = generateConnectionId();
          const expiresAt = getConnectionExpiry();

          // Create or update to pending connection
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

          // Send response with connection link
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          const linkUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/connect/${connectionId}`;

          // [1 sec typing indicator] "Please connect to Manus here:"
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, "Please connect to Manus here:");
          
          // [1 sec typing indicator] Send link as separate message
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, linkUrl);

          console.log('✅ Generic connection message sent to:', handle);
        } catch (error) {
          console.error('❌ Failed to create connection:', error);
        }
        
        return;
      }

      // Check for revocation confirmation FIRST (before other commands)
      if (/^yes\s+revoke$/i.test(messageText.trim())) {
        console.log('🔌 Revoke confirmation from:', handle);
        
        try {
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          
          // Delete webhook from Manus
          if (connection.webhookId && connection.manusApiKey) {
            try {
              await fetch(`https://api.manus.im/v1/webhooks/${connection.webhookId}`, {
                method: 'DELETE',
                headers: {
                  'API_KEY': connection.manusApiKey,
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
          await sendIMessage(handle, 'Done. All data deleted.');
          
          console.log('✅ Connection revoked and data cleaned up for:', handle);
        } catch (error) {
          console.error('❌ Failed to revoke connection:', error);
          
          try {
            const { sendIMessage } = await import('../lib/imessage.js');
            await sendIMessage(handle, 'Something went wrong. Please try again.');
          } catch (sendError) {
            console.error('❌ Failed to send error message:', sendError);
          }
        }
        
        return;
      }

      // Check if user wants to revoke (exact command only)
      if (/^revoke$/i.test(messageText.trim())) {
        console.log('🔌 Revoke request from:', handle);
        
        try {
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          
          // Send confirmation prompt
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, 'This will disconnect and delete all your data.\n\nReply "YES REVOKE" to confirm.');
          
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

      // Extract attachments (filter out stickers)
      const processedAttachments = message.attachments
        ?.filter((att: any) => !att.isSticker)
        ?.map((att: any) => ({
          guid: att.guid,
          filename: att.transferName || 'file',
          mimeType: att.mimeType || 'application/octet-stream',
        }));

      // Skip empty messages without attachments
      if (!messageText && (!processedAttachments || processedAttachments.length === 0)) {
        console.log('⏭️  Ignoring empty message:', message.guid);
        return;
      }

      console.log('📨 Message received from:', handle);
      console.log('📝 Message text:', messageText || '(empty)');
      console.log('📎 Attachments:', processedAttachments?.length || 0);

      // Always share contact card on every message
      try {
        const { shareContactCard } = await import('../lib/imessage.js');
        console.log('📇 Sharing contact card with:', handle);
        await shareContactCard(chatGuid);
        console.log(`✅ Contact card shared with: ${handle}`);
      } catch (error) {
        console.warn('⚠️  Failed to share contact card (non-blocking):', error);
        // Continue processing the message even if contact card sharing fails
      }

      // Add to queue for worker to process
      const queue = getQueue(handle);
      await queue.add('incoming-message', {
        phoneNumber: handle,
        messageText,
        messageGuid: message.guid,
        attachments: processedAttachments,
      });

      console.log('✅ Message queued for processing');

      // React to the message so user sees we received it (tapback removed when response stream ends)
      try {
        const { sendReaction } = await import('../lib/imessage.js');
        await sendReaction(chatGuid, message.guid, 'love');
      } catch (error) {
        console.warn('Failed to send reaction (non-blocking):', error);
      }

      // Notify worker to ensure it's processing this queue
      try {
        await redis.publish('message-queued', handle);
      } catch (error) {
        // Non-critical - worker should pick it up anyway
        console.warn('Failed to notify worker of queued message:', error);
      }
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
