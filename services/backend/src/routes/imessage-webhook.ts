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

// SLM service URL for AI-generated responses
const SLM_SERVICE_URL = process.env.SLM_SERVICE_URL || 'http://localhost:3001';

// Onboarding messages (multi-part)
const ONBOARDING_MESSAGES = [
  "Hey! Welcome to Manus on iMessage",
  "Manus is a powerful AI agent that can browse the web, write code, analyze data, and handle complex tasks - all through text.",
  "You get 3 free tasks. After that, add your API key to continue.",
  "Just text me what you need!",
];

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
 * Send onboarding messages to a new user (multi-part with typing indicators)
 */
async function sendOnboardingMessages(handle: string, replyToGuid?: string): Promise<void> {
  const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
  const sdk = await getIMessageSDK();
  const chatGuid = `any;-;${handle}`;
  
  for (let i = 0; i < ONBOARDING_MESSAGES.length; i++) {
    const msg = ONBOARDING_MESSAGES[i];
    const hasUrl = msg.includes('https://') || msg.includes('http://');
    
    await sendTypingIndicator(handle, 1200);
    
    // First message replies to user's message, rest are standalone
    if (i === 0 && replyToGuid) {
      await sdk.messages.sendMessage({
        chatGuid,
        message: msg,
        richLink: hasUrl,
        replyToGuid,
      } as any);
    } else {
      await sdk.messages.sendMessage({
        chatGuid,
        message: msg,
        richLink: hasUrl,
      });
    }
  }
}

/**
 * Get AI-generated contextual answer for first-time user's question
 */
async function getOnboardingAnswer(question: string): Promise<string | null> {
  try {
    const response = await fetch(`${SLM_SERVICE_URL}/before-onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    
    if (response.ok) {
      const { answer } = await response.json() as { answer: string };
      return answer;
    }
  } catch (error) {
    console.error('Failed to get onboarding answer:', error);
  }
  return null;
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
      // Clean the message first - handle quotes, backticks, whitespace
      let cleanedForKeyCheck = messageText.trim();
      cleanedForKeyCheck = cleanedForKeyCheck.replace(/^["'`]+|["'`]+$/g, '').trim();
      
      const isApiKeyMessage = /^sk-[A-Za-z0-9_-]{70,100}$/.test(cleanedForKeyCheck);
      const looksLikeApiKey = /^sk-/i.test(cleanedForKeyCheck); // Starts with sk- but might be malformed

      if (isApiKeyMessage) {
        console.log('🔑 API key detected from:', handle);
        // This will be handled below in the API key detection section
        // Continue to the API key handling logic
      } else if (looksLikeApiKey) {
        // User sent something that looks like an API key but doesn't match the expected format
        console.log('⚠️  Malformed API key attempt from:', handle, '- length:', cleanedForKeyCheck.length);
        const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
        await sendTypingIndicator(handle, 1000);
        await sendIMessage(handle, "That doesn't look like a complete API key. Make sure you copy the entire key - it should be about 80 characters long.\n\nGet your key here:\nhttps://manus.im/app#settings/integrations/api");
        return;
      }

      // Detect onboarding trigger phrase (sent by contact card / app link)
      const isOnboardingTrigger = /^send this message to get started!?$/i.test(messageText.trim());

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
        
        // Check if this is an API key - user wants to start with their own key
        if (isApiKeyMessage) {
          console.log('🔑 API key received as first message - creating connection with user key');
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          
          // Clean up the API key
          let apiKey = messageText.trim();
          apiKey = apiKey.replace(/^["'`]+|["'`]+$/g, '').trim();
          
          // Validate the API key by attempting webhook registration
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
              if (response.status === 401 || response.status === 403) {
                await sendTypingIndicator(handle, 1000);
                await sendIMessage(handle, "That API key didn't work. Please double-check you copied the entire key.\n\nGet a fresh key here:\nhttps://manus.im/app#settings/integrations/api");
                return;
              }
              if (response.status >= 400) {
                await sendTypingIndicator(handle, 1000);
                await sendIMessage(handle, "Something went wrong while validating your API key. Please try again in a moment.");
                return;
              }
            }
            
            const data = await response.json() as { webhook_id?: string; id?: string };
            webhookId = data.webhook_id || data.id || null;
            console.log('✅ Webhook registered for new user:', webhookId);
          } catch (error) {
            console.warn('⚠️ Webhook registration failed:', error);
          }
          
          // Create connection with their API key directly
          const connectionId = generateConnectionId();
          const photonApiKey = generatePhotonApiKey();
          
          await prisma.connection.upsert({
            where: { phoneNumber: handle },
            create: {
              connectionId,
              phoneNumber: handle,
              photonApiKey,
              manusApiKey: apiKey,
              webhookId,
              status: 'ACTIVE',
              activatedAt: new Date(),
              tasksUsed: 0,
              hasOnboarded: true, // API key user is onboarded
            } as any,
            update: {
              connectionId,
              photonApiKey,
              manusApiKey: apiKey,
              webhookId,
              status: 'ACTIVE',
              activatedAt: new Date(),
              currentTaskId: null,
              currentTaskStartedAt: null,
              triggeringMessageGuid: null,
              hasOnboarded: true, // Mark as onboarded
            } as any,
          });
          
          console.log('✅ Connection created with user API key for:', handle);
          
          // Send welcome with confirmation (multi-part)
          await sendTypingIndicator(handle, 1500);
          await sendIMessage(handle, "Hey! Welcome to Manus on iMessage");
          
          await sendTypingIndicator(handle, 1200);
          await sendIMessage(handle, "Your API key is connected - you have unlimited access.");
          
          await sendTypingIndicator(handle, 1200);
          await sendIMessage(handle, "What can I help you with?");
          
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

          // Check if this is a returning user (already onboarded before)
          const wasOnboarded = (existingConnection as any)?.hasOnboarded ?? false;
          const isReturningUser = !!existingConnection;
          const tasksUsed = (existingConnection as any)?.tasksUsed ?? 0;
          const hasApiKey = !!(existingConnection as any)?.manusApiKey;

          // Create ACTIVE connection - preserve tasksUsed for returning users
          // But CLEAR old task data (currentTaskId, currentTaskStartedAt) since those tasks
          // no longer exist after revoke or belong to a different API key
          await prisma.connection.upsert({
            where: { phoneNumber: handle },
            create: {
              connectionId,
              phoneNumber: handle,
              photonApiKey,
              status: 'ACTIVE',
              activatedAt: new Date(),
              tasksUsed: 0,
              hasOnboarded: false, // Will be set to true after onboarding messages
            } as any,
            update: {
              connectionId,
              photonApiKey,
              status: 'ACTIVE',
              activatedAt: new Date(),
              // Clear old task data - tasks don't persist across revoke/reactivate
              currentTaskId: null,
              currentTaskStartedAt: null,
              triggeringMessageGuid: null,
              // Don't reset tasksUsed or hasOnboarded for existing users
            } as any,
          });

          console.log(`✅ Connection ${isReturningUser ? 'reactivated' : 'created'} for:`, { connectionId, handle, tasksUsed, hasApiKey, wasOnboarded });

          // Send welcome message based on user status
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          
          if (isReturningUser && wasOnboarded) {
            // Returning user who was already onboarded - shorter welcome
            await sendTypingIndicator(handle, 1500);
            if (hasApiKey) {
              await sendIMessage(handle, "Welcome back! Your API key is still connected and ready to go.");
            } else {
              const remainingTasks = Math.max(0, 3 - tasksUsed);
              if (remainingTasks > 0) {
                await sendIMessage(handle, `Welcome back! You have ${remainingTasks} free task${remainingTasks === 1 ? '' : 's'} remaining.`);
              } else {
                await sendIMessage(handle, "Welcome back! You've used your free tasks.\n\nTo continue, add your Manus API key - type \"add key\" for instructions.");
              }
            }
          } else {
            // New user or returning user who wasn't onboarded - full onboarding flow
            
            if (isOnboardingTrigger) {
              // Standard onboarding trigger - send onboarding messages directly
              console.log('📋 Sending onboarding messages (trigger phrase)');
              await sendOnboardingMessages(handle, message.guid);
            } else {
              // User sent a custom first message - get AI response first, then onboarding
              console.log('📋 Custom first message - getting AI answer then onboarding');
              
              // Get AI-generated contextual answer
              const aiAnswer = await getOnboardingAnswer(messageText);
              if (aiAnswer) {
                // Send AI answer as reply to user's message
                const sdk = await getIMessageSDK();
                const chatGuid = `any;-;${handle}`;
                const hasUrl = aiAnswer.includes('https://') || aiAnswer.includes('http://');
                await sdk.chats.startTyping(chatGuid);
                await new Promise(resolve => setTimeout(resolve, 1200));
                await sdk.chats.stopTyping(chatGuid);
                await sdk.messages.sendMessage({
                  chatGuid,
                  message: aiAnswer,
                  richLink: hasUrl,
                  replyToGuid: message.guid,
                } as any);
              }
              
              // Then send onboarding messages (without reply - standalone)
              await sendOnboardingMessages(handle);
            }
            
            // Mark as onboarded
            await prisma.connection.update({
              where: { phoneNumber: handle },
              data: { hasOnboarded: true } as any,
            });
            console.log(`✅ User ${handle} marked as onboarded`);
          }

          console.log('✅ Welcome message sent to:', handle);
          
          // If this was the onboarding trigger or a new user's first message, don't queue as task
          if (isOnboardingTrigger || !wasOnboarded) {
            console.log('⏭️  Onboarding flow completed - not queueing as task');
            return;
          }
          
          // Otherwise, queue the actual user message for processing (returning user)
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
        
        // Continue to queue the real message with the new connection
        // (Fall through to the message queueing logic below)
      }

      // If user is already connected and sends the onboarding trigger again, just acknowledge
      if (isOnboardingTrigger) {
        console.log('⏭️  Already connected user sent onboarding trigger - acknowledging');
        try {
          const { sendIMessage: sendMsg, sendTypingIndicator: showTyping } = await import('../lib/imessage.js');
          await showTyping(handle, 1000);
          await sendMsg(handle, "You're already connected! Just send me what you need help with.");
        } catch (error) {
          console.error('❌ Failed to send already-connected message:', error);
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

            // Update connection status to REVOKED and clear all transient state
            // Also reset hasOnboarded so they get full onboarding on re-connect
            await tx.connection.update({
              where: { id: connection.id },
              data: {
                status: 'REVOKED',
                revokedAt: new Date(),
                manusApiKey: null,
                currentTaskId: null,
                currentTaskStartedAt: null,
                triggeringMessageGuid: null,
                pendingMessage: null,
                hasOnboarded: false, // Reset so they get onboarding on re-connect
              } as any,
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

      // Handle API key submission (user pasting their API key in chat)
      if (isApiKeyMessage) {
        console.log('🔑 Processing API key submission from:', handle);
        
        try {
          const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
          
          // Clean up the API key - handle whitespace, quotes, markdown code blocks
          let apiKey = messageText.trim();
          // Remove surrounding quotes
          apiKey = apiKey.replace(/^["'`]+|["'`]+$/g, '');
          // Remove markdown code formatting
          apiKey = apiKey.replace(/^`+|`+$/g, '');
          // Clean any remaining whitespace
          apiKey = apiKey.trim();
          
          // Get fresh connection data
          const conn = await prisma.connection.findFirst({
            where: { phoneNumber: handle, status: 'ACTIVE' },
          });
          
          if (!conn) {
            await sendTypingIndicator(handle, 1000);
            await sendIMessage(handle, "I received an API key, but couldn't find your connection. Please try again.");
            return;
          }
          
          const isUpdating = !!conn.manusApiKey;
          
          // If updating, delete old webhook first
          if (isUpdating && conn.webhookId && conn.manusApiKey) {
            try {
              const deleteResponse = await fetch(`https://api.manus.im/v1/webhooks/${conn.webhookId}`, {
                method: 'DELETE',
                headers: { 'API_KEY': conn.manusApiKey },
              });
              if (deleteResponse.ok) {
                console.log('✅ Old webhook deleted:', conn.webhookId);
              }
            } catch (error) {
              console.warn('⚠️ Failed to delete old webhook:', error);
            }
          }
          
          // Register webhook with new API key
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
          
          console.log(`✅ API key ${isUpdating ? 'updated' : 'connected'} for:`, handle);
          
          // Send confirmation messages
          await sendTypingIndicator(handle, 1000);
          
          if (isUpdating) {
            await sendIMessage(handle, "Done! Your API key has been updated.");
          } else {
            await sendIMessage(handle, "All set! Your API key is connected. You now have unlimited access.");
            
            await sendTypingIndicator(handle, 1000);
            await sendIMessage(handle, "What would you like to work on?");
          }
          
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
