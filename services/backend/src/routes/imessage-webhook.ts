/**
 * iMessage Event Listener
 * Listens for incoming messages via SDK events (not webhooks)
 * Filters and forwards to worker queue for processing
 */

import { FastifyPluginAsync } from 'fastify';
import { getIMessageSDK } from '../lib/imessage.js';
import { prisma } from '@imessage-mcp/database';
import { sanitizeHandle, isEmail, hasCountryCode, generateConnectionId, generatePhotonApiKey } from '@imessage-mcp/shared';
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

      // Check if this message is an API key (sk-... format)
      const trimmedMessage = messageText.trim();
      const isApiKeyMessage = /^sk-[A-Za-z0-9_-]{70,100}$/.test(trimmedMessage);
      const looksLikeApiKey = /^sk-/i.test(trimmedMessage); // Starts with sk- but might be malformed

      if (isApiKeyMessage) {
        console.log('🔑 API key detected from:', handle);
        // This will be handled below in the API key detection section
        // Continue to the API key handling logic
      } else if (looksLikeApiKey) {
        // User sent something that looks like an API key but doesn't match the expected format
        console.log('⚠️  Malformed API key attempt from:', handle);
        const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
        await sendTypingIndicator(handle, 1000);
        await sendIMessage(handle, "That doesn't look like a valid Manus API key. API keys start with 'sk-' followed by a long string of characters.\n\nMake sure you copy the entire key from:\nhttps://manus.im/app#settings/integrations/api");
        return;
      }

      // Legacy connection request phrases - now we just create ACTIVE connection on any first message
      // const isConnectionRequest = /(hey|hello)\s+manus.*connect.*imessage/i.test(messageText) || 
      //                             /connect.*imessage/i.test(messageText);

      // Always share contact card on every message (before connection check)
      try {
        const { shareContactCard } = await import('../lib/imessage.js');
        console.log('📇 Sharing contact card with:', handle);
        await shareContactCard(chatGuid);
        console.log(`✅ Contact card shared with: ${handle}`);
      } catch (error) {
        console.warn('⚠️  Failed to share contact card (non-blocking):', error);
        // Continue processing the message even if contact card sharing fails
      }

      // Check if connection exists and is active
      let connection = await prisma.connection.findFirst({
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
        
        // Check if this is an API key - can't activate without existing connection
        if (isApiKeyMessage) {
          console.log('⚠️  API key received but no connection exists yet');
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, "I received an API key, but you don't have a connection yet. Please send me a message first to get started!");
          return;
        }
        
        // Create or reactivate connection with free tier (no web link needed)
        console.log('🔗 Creating/reactivating connection for user:', handle);
        
        try {
          const connectionId = generateConnectionId();
          const photonApiKey = generatePhotonApiKey();

          // Check if user already exists (PENDING or REVOKED) to preserve their tasksUsed
          const existingConnection = await prisma.connection.findFirst({
            where: { phoneNumber: handle },
          });

          // Create ACTIVE connection - preserve tasksUsed for returning users
          await prisma.connection.upsert({
            where: { phoneNumber: handle },
            create: {
              connectionId,
              phoneNumber: handle,
              photonApiKey,
              status: 'ACTIVE',
              activatedAt: new Date(),
              tasksUsed: 0,
            } as any,
            update: {
              connectionId,
              photonApiKey,
              status: 'ACTIVE',
              activatedAt: new Date(),
              // Don't reset tasksUsed for existing users - they keep their count
            } as any,
          });

          const isReturningUser = !!existingConnection;
          const tasksUsed = (existingConnection as any)?.tasksUsed ?? 0;
          const hasApiKey = !!(existingConnection as any)?.manusApiKey;
          console.log(`✅ Connection ${isReturningUser ? 'reactivated' : 'created'} for:`, { connectionId, handle, tasksUsed, hasApiKey });

          // Send welcome message based on user status
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          await sendTypingIndicator(handle, 1000);
          
          if (isReturningUser) {
            if (hasApiKey) {
              await sendIMessage(handle, "Welcome back! Your connection is reactivated.");
            } else {
              const remainingTasks = Math.max(0, 3 - tasksUsed);
              if (remainingTasks > 0) {
                await sendIMessage(handle, `Welcome back! You have ${remainingTasks} free task${remainingTasks === 1 ? '' : 's'} remaining.`);
              } else {
                await sendIMessage(handle, "Welcome back! You've used your free tasks. Please add your API key to continue.");
              }
            }
          } else {
            await sendIMessage(handle, "Hey! You're all set. You have 3 free tasks to try out Manus.");
          }

          console.log('✅ Welcome message sent to:', handle);
          
          // Now queue the message for processing (don't return - continue to queue)
          // The worker will handle the task creation
        } catch (error) {
          console.error('❌ Failed to create connection:', error);
          return;
        }
        
        // Re-fetch the connection we just created and assign to connection variable
        connection = await prisma.connection.findFirst({
          where: { phoneNumber: handle, status: 'ACTIVE' },
        });
        
        if (!connection) {
          console.error('❌ Failed to find newly created connection');
          return;
        }
        
        // Continue to queue the message with the new connection
        // (Fall through to the message queueing logic below)
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
          
          // Get fresh connection data for status
          const conn = await prisma.connection.findFirst({
            where: { phoneNumber: handle, status: 'ACTIVE' },
          });
          
          const tasksUsed = (conn as any)?.tasksUsed ?? 0;
          const hasApiKey = !!conn?.manusApiKey;
          
          const statusMessage = `✅ Connection Status: ACTIVE

Phone: ${handle}
Connected: ${conn?.activatedAt ? new Date(conn.activatedAt).toLocaleDateString() : 'N/A'}
API Key: ${hasApiKey ? 'Connected' : `Free tier (${3 - tasksUsed} tasks remaining)`}
Photon API Key: ${conn?.photonApiKey?.substring(0, 15)}...

Your iMessage is connected to Manus AI.`;
          
          await sendIMessage(handle, statusMessage);
          
          console.log('✅ Sent status message to:', handle);
        } catch (error) {
          console.error('❌ Failed to send status message:', error);
        }
        
        return;
      }

      // Handle API key submission (user pasting their API key in chat)
      if (isApiKeyMessage) {
        console.log('🔑 Processing API key submission from:', handle);
        
        try {
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          const apiKey = messageText.trim();
          
          // Get fresh connection data
          const conn = await prisma.connection.findFirst({
            where: { phoneNumber: handle, status: 'ACTIVE' },
          });
          
          if (!conn) {
            await sendTypingIndicator(handle, 1000);
            await sendIMessage(handle, "I received an API key, but couldn't find your connection. Please try again.");
            return;
          }
          
          if (conn.manusApiKey) {
            await sendTypingIndicator(handle, 1000);
            await sendIMessage(handle, "You already have an API key connected. Use 'revoke' to disconnect first if you want to change it.");
            return;
          }
          
          // Register webhook with Manus
          let webhookId: string | null = null;
          try {
            const response = await fetch('https://api.manus.im/v1/webhooks', {
              method: 'POST',
              headers: {
                'API_KEY': apiKey,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                webhook: {
                  url: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/webhook`,
                },
              }),
            });
            
            if (!response.ok) {
              const errorText = await response.text();
              console.error('❌ Webhook registration failed:', response.status, errorText);
              
              // Check if it's an invalid API key error
              if (response.status === 401 || response.status === 403) {
                await sendTypingIndicator(handle, 1000);
                await sendIMessage(handle, "That API key didn't work. Please double-check you copied the entire key.\n\nGet a fresh key here:\nhttps://manus.im/app#settings/integrations/api");
                return;
              }
              // For other errors (5xx, rate limits, etc.), don't save the key
              if (response.status >= 400) {
                await sendTypingIndicator(handle, 1000);
                await sendIMessage(handle, "Something went wrong while validating your API key. Please try again in a moment.");
                return;
              }
              throw new Error(`Failed to register webhook: ${response.status}`);
            }
            
            const data = await response.json() as { webhook_id?: string; id?: string };
            webhookId = data.webhook_id || data.id || null;
            console.log('✅ Webhook registered:', webhookId);
          } catch (error) {
            console.warn('⚠️  Webhook registration failed (expected for localhost):', error instanceof Error ? error.message : error);
            // Continue without webhook - it's optional for development
          }
          
          // Ensure photonApiKey exists (should already exist for free tier users)
          const photonApiKey = conn.photonApiKey || generatePhotonApiKey();
          
          // Update connection with API key
          await prisma.connection.update({
            where: { id: conn.id },
            data: {
              manusApiKey: apiKey,
              webhookId,
              photonApiKey,
            },
          });
          
          console.log('✅ API key connected for:', handle);
          
          // Build MCP config
          const mcpConfig = {
            mcpServers: {
              'photon-imessage': {
                type: 'streamableHttp',
                url: `${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/mcp/http`,
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json, text/event-stream',
                  Authorization: `Bearer ${photonApiKey}`,
                },
              },
            },
          };
          
          // Send activation messages
          const { sendLocalFile } = await import('../lib/imessage.js');
          const path = await import('path');
          
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, "All set! Your API key is connected.");
          
          await sendTypingIndicator(handle, 1500);
          await sendIMessage(handle, `Here's your MCP configuration (copy and paste this in Manus settings):\n\n\`\`\`\n${JSON.stringify(mcpConfig, null, 2)}\n\`\`\``);
          
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, "Open Manus Settings → Connectors → Custom MCP → Add custom MCP server → Import by JSON");
          
          // Send the MCP setup guide image
          try {
            // Path works both locally and in Docker
            const imagePath = process.env.NODE_ENV === 'production' 
              ? '/app/assets/mcp-setup-guide.png' 
              : path.join(process.cwd(), '../../assets/mcp-setup-guide.png');
            await sendLocalFile(handle, imagePath, 'mcp-setup-guide.png');
          } catch (imgError) {
            console.warn('⚠️ Failed to send MCP setup guide image (non-blocking):', imgError);
          }
          
          await sendTypingIndicator(handle, 1000);
          await sendIMessage(handle, "You're ready to go. Type \"continue\" to pick up where you left off, or just tell me what you'd like to work on.");
          
          console.log('✅ API key activation complete for:', handle);
        } catch (error) {
          console.error('❌ Failed to process API key:', error);
          
          try {
            const { sendIMessage } = await import('../lib/imessage.js');
            await sendIMessage(handle, 'Something went wrong while connecting your API key. Please try again.');
          } catch (sendError) {
            console.error('❌ Failed to send error message:', sendError);
          }
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

      // Extract thread originator GUID (if user replied to a message)
      const threadOriginatorGuid = (message as any).threadOriginatorGuid as string | undefined;

      console.log('📨 Message received from:', handle);
      console.log('📝 Message text:', messageText || '(empty)');
      console.log('📎 Attachments:', processedAttachments?.length || 0);
      console.log('🔗 Thread info:', {
        messageGuid: message.guid,
        threadOriginatorGuid: threadOriginatorGuid || 'none (not a reply)'
      });

      // Add to queue for worker to process
      const queue = getQueue(handle);
      await queue.add('incoming-message', {
        phoneNumber: handle,
        messageText,
        messageGuid: message.guid,
        threadOriginatorGuid, // NEW: Pass thread info to worker
        attachments: processedAttachments,
      });

      console.log('✅ Message queued for processing');

      // React to the message with thumbs up to acknowledge receipt (will be changed to heart when task completes)
      // Send reaction after 1 second delay (non-blocking)
      setTimeout(async () => {
        try {
          const { sendReaction } = await import('../lib/imessage.js');
          await sendReaction(chatGuid, message.guid, 'like');
        } catch (error) {
          console.warn('Failed to send reaction (non-blocking):', error);
        }
      }, 1000);

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
