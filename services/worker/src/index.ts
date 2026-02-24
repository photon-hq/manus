import { Queue, Worker, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { prisma, QueueStatus } from '@imessage-mcp/database';
import { sanitizeHandle, MessageIntent, INTENT_RESPONSES } from '@imessage-mcp/shared';
import { SDK } from '@photon-ai/advanced-imessage-kit';
import { TypingIndicatorManager } from './typing-manager.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEBOUNCE_WINDOW = 3000; // 3 seconds

// SLM service URL for agentic routing
const SLM_SERVICE_URL = process.env.SLM_SERVICE_URL || 'http://localhost:3001';

// Redis key expiration for task mapping (24 hours)
const TASK_MAPPING_TTL = 24 * 60 * 60; // seconds

// Free tier configuration
const FREE_TIER_TASKS = 3; // Number of free tasks before requiring API key
const FREE_TIER_API_KEY = process.env.MANUS_FREE_TIER_API_KEY || process.env.MANUS_API_KEY;

// iMessage SDK instance
let imessageSDK: ReturnType<typeof SDK> | null = null;

// Typing indicator manager
let typingManager: TypingIndicatorManager | null = null;

// Get or create iMessage SDK instance
async function getIMessageSDK() {
  if (!imessageSDK) {
    const IMESSAGE_SERVER_URL = process.env.IMESSAGE_SERVER_URL;
    const IMESSAGE_API_KEY = process.env.IMESSAGE_API_KEY;

    if (!IMESSAGE_SERVER_URL || !IMESSAGE_API_KEY) {
      throw new Error('IMESSAGE_SERVER_URL and IMESSAGE_API_KEY are required');
    }

    imessageSDK = SDK({
      serverUrl: IMESSAGE_SERVER_URL,
      apiKey: IMESSAGE_API_KEY,
      logLevel: process.env.NODE_ENV === 'production' ? 'error' : 'info',
    });

    await imessageSDK.connect();
    console.log('✅ Worker connected to iMessage SDK');
    
    // Initialize typing manager
    typingManager = new TypingIndicatorManager(imessageSDK);
    console.log('✅ Typing indicator manager initialized');
  }
  return imessageSDK;
}

// Get typing indicator manager
function getTypingManager(): TypingIndicatorManager {
  if (!typingManager) {
    throw new Error('Typing manager not initialized. Call getIMessageSDK() first.');
  }
  return typingManager;
}

// Redis connection
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Map to track queues and workers per phone number
const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

// Map to track active typing indicators per phone number
const typingIndicators = new Map<string, NodeJS.Timeout>();

console.log('Worker service starting...');

// Function to get or create queue for a handle (phone number or email)
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

    // Start worker for this queue
    startWorker(handle);
  }
  return queues.get(handle)!;
}

// Start worker for a specific handle queue
function startWorker(handle: string) {
  if (workers.has(handle)) return;

  // Sanitize handle for queue name (works for both phone numbers and emails)
  const sanitizedHandle = sanitizeHandle(handle);
  const worker = new Worker(
    `messages-${sanitizedHandle}`,
    async (job) => {
      console.log(`Processing job ${job.name} for ${handle}:`, job.data);
      
      // Handle different job types
      if (job.name === 'incoming-message') {
        // Direct message from iMessage webhook
        const { messageText, messageGuid, threadOriginatorGuid, attachments } = job.data;
        await handleIncomingMessage(handle, messageText, messageGuid, threadOriginatorGuid, attachments);
      } else if (job.name === 'process-message') {
        // Message from queue (debounced)
        await processMessage(handle, job.data);
      } else {
        console.warn(`Unknown job type: ${job.name}`);
      }
    },
    {
      connection: redis,
      concurrency: 1, // Sequential processing per user
    }
  );

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed for ${handle}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed for ${handle}:`, err);
  });

  worker.on('error', (err) => {
    console.error(`Worker error for ${handle}:`, err);
  });

  workers.set(handle, worker);
  console.log(`✅ Worker started for queue: messages-${sanitizedHandle}`);
}

// Handle incoming message (called by backend or message receiver)
export async function handleIncomingMessage(
  phoneNumber: string,
  message: string,
  messageGuid: string,
  threadOriginatorGuid?: string,
  attachments?: Array<{ guid: string; filename: string; mimeType: string }>
) {
  console.log(`Incoming message from ${phoneNumber}`, attachments ? `with ${attachments.length} attachment(s)` : '');

  // Clear existing debounce timer
  const existingTimer = debounceTimers.get(phoneNumber);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Get last pending message
  const lastMessage = await prisma.messageQueue.findFirst({
    where: {
      phoneNumber,
      status: QueueStatus.PENDING,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (lastMessage && Date.now() - lastMessage.createdAt.getTime() < DEBOUNCE_WINDOW && !attachments) {
    // Combine messages (only if no attachments)
    await prisma.messageQueue.update({
      where: { id: lastMessage.id },
      data: {
        messageText: lastMessage.messageText + '\n' + message,
      },
    });
    console.log(`Combined message for ${phoneNumber}`);
  } else {
    // Create new message in queue
    await prisma.messageQueue.create({
      data: {
        phoneNumber,
        messageGuid,
        threadOriginatorGuid,
        messageText: message,
        attachments: attachments ? JSON.parse(JSON.stringify(attachments)) : null,
        status: QueueStatus.PENDING,
      } as any,
    });
    console.log(`Created new message queue entry for ${phoneNumber}`);
  }

  // Set new debounce timer
  const timer = setTimeout(async () => {
    await scheduleProcessing(phoneNumber);
    debounceTimers.delete(phoneNumber);
  }, DEBOUNCE_WINDOW);

  debounceTimers.set(phoneNumber, timer);
}

// Schedule message for processing
async function scheduleProcessing(phoneNumber: string) {
  // Get all pending messages
  const pendingMessages = await prisma.messageQueue.findMany({
    where: {
      phoneNumber,
      status: QueueStatus.PENDING,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  if (pendingMessages.length === 0) return;

  // Add to BullMQ queue
  const queue = getQueue(phoneNumber);
  
  for (const msg of pendingMessages) {
    await queue.add('process-message', {
      messageId: msg.id,
      messageText: msg.messageText,
      messageGuid: msg.messageGuid,
      threadOriginatorGuid: (msg as any).threadOriginatorGuid,
      messageTimestamp: msg.createdAt, // Pass as Date object
      attachments: msg.attachments,
    });

    // Mark as processing
    await prisma.messageQueue.update({
      where: { id: msg.id },
      data: { status: QueueStatus.PROCESSING },
    });
  }

  console.log(`Scheduled ${pendingMessages.length} messages for ${phoneNumber}`);
}

// Process a single message
async function processMessage(phoneNumber: string, data: any) {
  const { messageId, messageText, attachments, messageGuid, threadOriginatorGuid, messageTimestamp } = data;

  try {
    // Check for pending message (message that was blocked due to free tier limit)
    // and combine it with the current message after user has added their API key
    let combinedMessage = messageText;
    const connection = await prisma.connection.findFirst({
      where: { phoneNumber, status: 'ACTIVE' },
    });
    
    const pendingMessage = (connection as any)?.pendingMessage;
    if (pendingMessage && connection?.manusApiKey) {
      console.log(`📋 Found pending message for ${phoneNumber}, combining with current message`);
      
      // If user sends "continue" (case insensitive), just use the pending message
      // Otherwise, combine both messages
      const isContinue = /^continue$/i.test(messageText?.trim() || '');
      if (isContinue) {
        combinedMessage = pendingMessage;
        console.log(`📋 User said "continue" - using pending message only`);
      } else if (messageText) {
        combinedMessage = `${pendingMessage}\n\n${messageText}`;
        console.log(`📋 Combining pending message with new message`);
      } else {
        combinedMessage = pendingMessage;
        console.log(`📋 No new message text - using pending message only`);
      }
      
      // Clear the pending message
      await prisma.connection.update({
        where: { id: connection.id },
        data: { pendingMessage: null } as any,
      });
      console.log(`✅ Cleared pending message for ${phoneNumber}`);
    }
    
    // Early check for free tier limit BEFORE processing attachments
    // This ensures users get the nice prompt instead of an error
    const connForFreeTierCheck = await prisma.connection.findFirst({
      where: { phoneNumber, status: 'ACTIVE' },
    });
    if (connForFreeTierCheck) {
      const { needsApiKeyPrompt } = await resolveApiKeyForConnection(connForFreeTierCheck);
      if (needsApiKeyPrompt) {
        const existingPendingMessage = (connForFreeTierCheck as any)?.pendingMessage;
        
        if (existingPendingMessage) {
          // User already has a pending message and still hasn't added API key
          // Don't overwrite the original blocked message, just remind them to add key
          console.log('📊 Free tier exhausted - user has existing pending message, sending reminder');
          
          const sdk = await getIMessageSDK();
          const chatGuid = `any;-;${phoneNumber}`;
          await sdk.chats.startTyping(chatGuid);
          await new Promise(resolve => setTimeout(resolve, 1000));
          await sdk.chats.stopTyping(chatGuid);
          await sdk.messages.sendMessage({
            chatGuid,
            message: "Please add your API key first to continue. Get it here:\nhttps://manus.im/app#settings/integrations/api",
          });
        } else {
          // First time hitting limit - store message and send full prompt
          console.log('📊 Free tier exhausted - sending prompt before attachment processing');
          // Build message to store (include attachment mention if relevant)
          let blockedMsg = combinedMessage || '';
          if (attachments && attachments.length > 0) {
            blockedMsg = blockedMsg 
              ? `${blockedMsg}\n\n[User also sent ${attachments.length} file(s) that need to be re-sent after adding API key]`
              : `[User sent ${attachments.length} file(s) - please re-send after adding API key]`;
          }
          await sendFreeTierLimitPrompt(phoneNumber, blockedMsg);
        }
        
        // Mark message as completed (not failed - we handled it)
        await prisma.messageQueue.update({
          where: { id: messageId },
          data: {
            status: QueueStatus.COMPLETED,
            processedAt: new Date(),
          },
        });
        return;
      }
    }
    
    // Handle attachments if present
    let fileIds: string[] = [];
    if (attachments && attachments.length > 0) {
      fileIds = await processAttachments(phoneNumber, attachments);
    }

    // If message is empty but has attachments, use a default prompt
    let effectiveMessage = combinedMessage;
    if (!effectiveMessage && fileIds.length > 0) {
      effectiveMessage = `[User sent ${fileIds.length} file(s)]`;
    }

    // Skip processing if both message and attachments are empty
    if (!effectiveMessage && fileIds.length === 0) {
      console.warn(`Skipping empty message for ${phoneNumber}`);
      return;
    }

    // Special handling for file-only messages (no text and no combined pending message)
    // If user sends only files:
    // - No active task → Create new task
    // - Active task exists → Append to current task
    if (!combinedMessage && fileIds.length > 0) {
      // Re-fetch connection since we might have modified it above
      const connForFiles = await prisma.connection.findFirst({
        where: { phoneNumber, status: 'ACTIVE' },
      });

      if (connForFiles?.currentTaskId) {
        // Active task exists - append files to it
        console.log(`📎 File-only message with active task - appending to ${connForFiles.currentTaskId}`);
        await appendToTask(phoneNumber, effectiveMessage, fileIds, messageGuid);
      } else {
        // No active task - create new task
        console.log(`📎 File-only message with no active task - creating new task`);
        await createManusTask(phoneNumber, effectiveMessage, fileIds, messageTimestamp, false, messageGuid);
      }
    } else {
      // Regular message with text - use SLM agentic routing
      // Use original messageText for detection (not combined) to avoid confusion with pending message
      const { isFollowUp, taskId: taskIdForThread, intent, reasoning } = await detectMessageType(
        phoneNumber,
        messageText || '', // Use original for detection
        messageGuid
      );

      // Re-fetch connection for task handling
      const connForTask = await prisma.connection.findFirst({
        where: { phoneNumber, status: 'ACTIVE' },
      });

      // Check if this is a pre-defined intent that should be handled without Manus
      if (intent) {
        const handled = await handlePredefinedIntent(phoneNumber, intent, connForTask, messageGuid, messageText);
        if (handled) {
          console.log(`✅ Pre-defined intent ${intent} handled for ${phoneNumber}${reasoning ? ` (${reasoning})` : ''}`);
          // Mark as completed and return early
          await prisma.messageQueue.update({
            where: { id: messageId },
            data: {
              status: QueueStatus.COMPLETED,
              processedAt: new Date(),
            },
          });
          return;
        }
      }

      if (isFollowUp && taskIdForThread) {
        // Follow-up detected → append to existing task
        console.log(`✅ Follow-up detected - appending to task ${taskIdForThread}${reasoning ? ` (${reasoning})` : ''}`);
        
        // Update connection to point to the current task
        await prisma.connection.update({
          where: { phoneNumber },
          data: { 
            currentTaskId: taskIdForThread,
            triggeringMessageGuid: messageGuid,
          },
        });
        
        await appendToTask(phoneNumber, effectiveMessage, fileIds, messageGuid);
      } else {
        // New task → clear previous task and create new one
        console.log(`🆕 New task detected for ${phoneNumber}${reasoning ? ` (${reasoning})` : ''}`);
        
        if (connForTask?.currentTaskId) {
          await prisma.connection.update({
            where: { phoneNumber },
            data: { currentTaskId: null },
          });
          console.log(`✅ Cleared previous task ID for ${phoneNumber} (NEW_TASK)`);
        }
        
        // Preserve conversation history across task boundaries
        await createManusTask(phoneNumber, effectiveMessage, fileIds, messageTimestamp, true, messageGuid);
      }
    }

    // Mark as completed
    await prisma.messageQueue.update({
      where: { id: messageId },
      data: {
        status: QueueStatus.COMPLETED,
        processedAt: new Date(),
      },
    });
  } catch (error) {
    console.error(`Error processing message ${messageId}:`, error);
    
    // Mark as failed
    await prisma.messageQueue.update({
      where: { id: messageId },
      data: {
        status: QueueStatus.FAILED,
        processedAt: new Date(),
      },
    });

    throw error;
  }
}

// Process attachments: download from iMessage and upload to Manus
async function processAttachments(
  phoneNumber: string,
  attachments: Array<{ guid: string; filename: string; mimeType: string }>
): Promise<string[]> {
  const fileIds: string[] = [];

  try {
    // Get connection to get Manus API key
    const connection = await prisma.connection.findFirst({
      where: { phoneNumber, status: 'ACTIVE' },
    });

    if (!connection) {
      throw new Error('No active connection found');
    }

    // Resolve API key (user's own key vs free tier system key)
    const { apiKey, needsApiKeyPrompt } = await resolveApiKeyForConnection(connection);
    
    if (needsApiKeyPrompt || !apiKey) {
      console.log('⚠️ Cannot process attachments - user has no API key and free tier exhausted');
      throw new Error('No API key available for attachment upload');
    }

    const { SDK } = await import('@photon-ai/advanced-imessage-kit');
    const sdk = SDK({
      serverUrl: process.env.IMESSAGE_SERVER_URL || 'http://localhost:1234',
      apiKey: process.env.IMESSAGE_API_KEY,
      logLevel: 'error',
    });

    await sdk.connect();

    for (const attachment of attachments) {
      try {
        console.log(`Processing attachment: ${attachment.filename}`);

        // Download attachment from iMessage
        const result = await sdk.attachments.downloadAttachment(attachment.guid);

        // Upload to Manus using resolved API key (user's or free tier system key)
        const fileId = await uploadFileToManus(Buffer.from(result), attachment.filename, apiKey);
        fileIds.push(fileId);

        console.log(`✅ Uploaded ${attachment.filename} to Manus (ID: ${fileId})`);
      } catch (error) {
        console.error(`Failed to process attachment ${attachment.filename}:`, error);
        // Continue with other attachments
      }
    }

    await sdk.close();
  } catch (error) {
    console.error('Failed to process attachments:', error);
  }

  return fileIds;
}

// Upload file to Manus
async function uploadFileToManus(fileBuffer: Buffer, filename: string, manusApiKey: string): Promise<string> {
  const MANUS_API_URL = process.env.MANUS_API_URL || 'https://api.manus.im';

  // Step 1: Create file record
  const createResponse = await fetch(`${MANUS_API_URL}/v1/files`, {
    method: 'POST',
    headers: {
      'API_KEY': manusApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filename }),
  });

  if (!createResponse.ok) {
    throw new Error(`Failed to create file record: ${await createResponse.text()}`);
  }

  const fileRecord = await createResponse.json() as { upload_url: string; id: string };

  // Step 2: Upload to presigned URL
  const uploadResponse = await fetch(fileRecord.upload_url, {
    method: 'PUT',
    body: fileBuffer,
    headers: {
      'Content-Type': 'application/octet-stream',
    },
  });

  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload file: ${uploadResponse.statusText}`);
  }

  return fileRecord.id;
}

// Detection result interface
interface DetectionResult {
  isFollowUp: boolean;
  taskId: string | null;
  intent?: MessageIntent; // Full intent from SLM router
  reasoning?: string; // Debug info from SLM
}

/**
 * Detect whether a message is a follow-up to an existing task or a new task
 * Uses SLM agentic routing to classify message intent
 */
async function detectMessageType(
  phoneNumber: string,
  messageText: string,
  messageGuid: string
): Promise<DetectionResult> {
  // Get connection to check active task
  const connection = await prisma.connection.findFirst({
    where: { phoneNumber, status: 'ACTIVE' },
  });

  console.log(`🤖 SLM agentic router for ${phoneNumber}`);
  
  // Get last task context (last 20 messages), excluding the current message
  const recentMessages = await getRecentMessages(phoneNumber, 20, messageGuid);

  // Log context being sent to SLM
  console.log(`📝 Context for SLM (${recentMessages.length} messages):`, 
    recentMessages.map(m => `${m.from}: ${m.text.substring(0, 50)}`).join(' | '));

  // Classify message using SLM router
  const classification = await classifyMessage(messageText, recentMessages);
  console.log(`🎯 Intent classification for ${phoneNumber}:`, classification);

  const intent = classification.intent;
  
  // Map intent to detection result
  switch (intent) {
    case MessageIntent.NEW_TASK:
      return { isFollowUp: false, taskId: null, intent, reasoning: classification.reasoning };
    
    case MessageIntent.FOLLOW_UP:
      return { isFollowUp: true, taskId: connection?.currentTaskId || null, intent, reasoning: classification.reasoning };
    
    case MessageIntent.REVOKE:
    case MessageIntent.GENERAL_QUESTION:
      // These intents are handled by pre-defined responses or AI, not Manus tasks
      return { isFollowUp: false, taskId: null, intent, reasoning: classification.reasoning };
    
    default:
      // Unknown intent, default to NEW_TASK
      console.warn(`Unknown intent: ${intent}, defaulting to NEW_TASK`);
      return { isFollowUp: false, taskId: null, intent: MessageIntent.NEW_TASK };
  }
}

/**
 * Get recent messages for context (only from current task)
 * Used by SLM mode to provide conversation context to the classifier
 */
async function getRecentMessages(phoneNumber: string, limit: number = 20, excludeMessageGuid?: string): Promise<any[]> {
  try {
    // Get connection to check if there's an active task
    const connection = await prisma.connection.findFirst({
      where: { phoneNumber, status: 'ACTIVE' },
    }) as any;

    // If no active task or no start time, return empty context (indicates NEW_TASK)
    if (!connection?.currentTaskId || !connection?.currentTaskStartedAt) {
      console.log(`No active task context for ${phoneNumber}, returning empty context`);
      return [];
    }

    const { SDK } = await import('@photon-ai/advanced-imessage-kit');
    const sdk = SDK({
      serverUrl: process.env.IMESSAGE_SERVER_URL || 'http://localhost:1234',
      apiKey: process.env.IMESSAGE_API_KEY,
      logLevel: 'error',
    });

    await sdk.connect();

    const chatGuid = `any;-;${phoneNumber}`;
    
    // Small delay to ensure the incoming message has been saved to iMessage database
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const messages = await sdk.messages.getMessages({
      chatGuid,
      limit,
      sort: 'DESC',
    });

    await sdk.close();

    // Log ALL messages to debug why user messages are missing
    console.log(`📋 All ${messages.length} messages from iMessage:`, messages.slice(0, 5).map(m => ({
      guid: m.guid?.substring(0, 8),
      isFromMe: m.isFromMe,
      text: m.text?.substring(0, 30),
      dateCreated: new Date(m.dateCreated).toISOString(),
    })));

    // Get only MANUAL message GUIDs (sent via MCP tool) to filter out
    // Keep WEBHOOK messages (task responses) in context for SLM classifier
    const manualMessageGuids = await prisma.manusMessage.findMany({
      where: { 
        phoneNumber,
        messageType: 'MANUAL'
      },
      select: { messageGuid: true },
    });

    const guidSet = new Set(manualMessageGuids.map((m) => m.messageGuid));

    // Filter messages:
    // 1. Only messages after current task started (with 5 second buffer for timing differences)
    // 2. Exclude MANUAL messages
    // 3. Keep user messages and webhook responses
    const taskStartTime = connection.currentTaskStartedAt!.getTime();
    const bufferMs = 5000; // 5 second buffer to account for timing differences
    
    console.log(`⏰ Task started at: ${connection.currentTaskStartedAt!.toISOString()} (${taskStartTime})`);
    
    const filteredRawMessages = messages.filter((msg) => {
      const messageTime = new Date(msg.dateCreated).getTime();
      const passesTimeFilter = messageTime >= (taskStartTime - bufferMs);
      const notManual = !guidSet.has(msg.guid);
      const notCurrent = msg.guid !== excludeMessageGuid;
      
      console.log(`  Message ${msg.guid?.substring(0, 8)}: time=${passesTimeFilter}, notManual=${notManual}, notCurrent=${notCurrent}, isFromMe=${msg.isFromMe}`);
      
      return passesTimeFilter && notManual && notCurrent;
    });

    console.log(`Fetched ${messages.length} total messages, ${filteredRawMessages.length} after filtering for current task context`);
    console.log(`Excluding message GUID: ${excludeMessageGuid || 'none'}`);
    console.log(`Filtered messages:`, filteredRawMessages.map(m => ({ 
      guid: m.guid?.substring(0, 8), 
      isFromMe: m.isFromMe,
      text: m.text?.substring(0, 30) 
    })));

    const filteredMessages = filteredRawMessages.map((msg) => ({
      from: msg.isFromMe ? 'me' : phoneNumber,
      to: msg.isFromMe ? phoneNumber : 'me',
      text: msg.text || '',
      timestamp: new Date(msg.dateCreated).toISOString(),
    }));
    // Send context in chronological order (oldest first) so the classifier sees conversation flow
    return filteredMessages.reverse();
  } catch (error) {
    console.error('Failed to fetch recent messages:', error);
    return [];
  }
}

/**
 * Classify message using SLM agentic router service
 * Returns { intent: MessageIntent, confidence: number, reasoning?: string }
 */
async function classifyMessage(message: string, context: any[]): Promise<{ intent: MessageIntent; confidence: number; reasoning?: string }> {
  try {
    const response = await fetch(`${SLM_SERVICE_URL}/classify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        latest_message: message,
        last_task_context: context,
      }),
    });

    if (!response.ok) {
      throw new Error(`SLM service error: ${response.statusText}`);
    }

    const result = await response.json() as { intent?: MessageIntent; type?: MessageIntent; confidence: number; reasoning?: string };
    
    // Support both 'intent' (new) and 'type' (legacy) field names
    return {
      intent: result.intent || result.type || MessageIntent.NEW_TASK,
      confidence: result.confidence,
      reasoning: result.reasoning,
    };
  } catch (error) {
    console.error('Classification failed:', error);
    // Default to NEW_TASK on error
    return { intent: MessageIntent.NEW_TASK, confidence: 0.5, reasoning: 'Classification error' };
  }
}

/**
 * Handle pre-defined intent responses (non-task intents)
 * Returns true if handled, false if should continue to task processing
 */
async function handlePredefinedIntent(
  phoneNumber: string,
  intent: MessageIntent,
  connection: any,
  replyToMessageGuid?: string,
  originalMessage?: string
): Promise<boolean> {
  const sdk = await getIMessageSDK();
  const chatGuid = `any;-;${phoneNumber}`;
  
  const sendWithTyping = async (message: string, delayMs: number = 1000, isFirstMessage: boolean = false) => {
    await sdk.chats.startTyping(chatGuid);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    await sdk.chats.stopTyping(chatGuid);
    
    const hasUrl = message.includes('https://') || message.includes('http://');
    
    await sdk.messages.sendMessage({ 
      chatGuid, 
      message,
      richLink: hasUrl,
      ...(isFirstMessage && replyToMessageGuid ? { replyToGuid: replyToMessageGuid } : {}),
    });
  };
  
  const sendMultipleWithTyping = async (messages: string[], delayMs: number = 1000) => {
    for (let i = 0; i < messages.length; i++) {
      await sendWithTyping(messages[i], delayMs, i === 0);
    }
  };
  
  switch (intent) {
    case MessageIntent.REVOKE: {
      console.log(`📋 Handling REVOKE intent for ${phoneNumber}`);
      const response = INTENT_RESPONSES.REVOKE_CONFIRM;
      if (Array.isArray(response)) {
        await sendMultipleWithTyping(response, 1000);
      } else {
        await sendWithTyping(response as string, 1000);
      }
      return true;
    }
    
    case MessageIntent.GENERAL_QUESTION: {
      console.log(`📋 Handling GENERAL_QUESTION intent for ${phoneNumber} - calling AI`);
      
      // Build natural context for AI to give personalized answers
      const tasksUsed = connection?.tasksUsed ?? 0;
      const hasApiKey = !!connection?.manusApiKey;
      const remainingTasks = Math.max(0, 3 - tasksUsed);
      const connectedSince = connection?.activatedAt 
        ? new Date(connection.activatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : null;
      
      let context: string;
      if (hasApiKey) {
        context = `This user has their own Manus API key connected${connectedSince ? ` since ${connectedSince}` : ''}. They have unlimited access to all features. No task limits.`;
      } else if (remainingTasks > 0) {
        context = `This user is on the free tier. They've used ${tasksUsed} out of 3 free tasks, so they have ${remainingTasks} task${remainingTasks === 1 ? '' : 's'} remaining. After that, they'll need to add their API key to continue.`;
      } else {
        context = `This user has used all 3 free tasks. They need to add their Manus API key to continue using the service. Direct them to get their key at https://manus.im/app#settings/integrations/api`;
      }
      
      // Call SLM /answer endpoint for AI-generated response
      try {
        const answerResponse = await fetch(`${SLM_SERVICE_URL}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            question: originalMessage || 'what can you do?',
            context,
          }),
        });
        
        if (answerResponse.ok) {
          const { messages } = await answerResponse.json() as { messages: string[] };
          if (messages && messages.length > 0) {
            await sendMultipleWithTyping(messages, 1200);
            return true;
          }
        }
      } catch (error) {
        console.error('Failed to get AI answer:', error);
      }
      
      // Fallback response
      await sendMultipleWithTyping([
        "I'm Photon - your bridge to Manus AI through iMessage.",
        "Just text me what you need help with!",
      ], 1200);
      return true;
    }
    
    default:
      // Not a pre-defined intent (NEW_TASK or FOLLOW_UP), continue to task processing
      return false;
  }
}

/**
 * Resolve which API key to use for a connection
 * Returns: { apiKey, shouldIncrementTasksUsed, needsApiKeyPrompt }
 */
async function resolveApiKeyForConnection(connection: any): Promise<{
  apiKey: string | null;
  shouldIncrementTasksUsed: boolean;
  needsApiKeyPrompt: boolean;
}> {
  // If user has their own API key, use it
  if (connection.manusApiKey) {
    return { apiKey: connection.manusApiKey, shouldIncrementTasksUsed: false, needsApiKeyPrompt: false };
  }

  // Check if within free tier
  const tasksUsed = connection.tasksUsed ?? 0;
  if (tasksUsed < FREE_TIER_TASKS) {
    if (!FREE_TIER_API_KEY) {
      console.error('❌ No FREE_TIER_API_KEY configured and user has no API key');
      return { apiKey: null, shouldIncrementTasksUsed: false, needsApiKeyPrompt: true };
    }
    console.log(`📊 Free tier: User has used ${tasksUsed}/${FREE_TIER_TASKS} tasks, using system key`);
    return { apiKey: FREE_TIER_API_KEY, shouldIncrementTasksUsed: true, needsApiKeyPrompt: false };
  }

  // User has exhausted free tier and has no API key
  console.log(`📊 Free tier exhausted: ${tasksUsed}/${FREE_TIER_TASKS} tasks used, prompting for API key`);
  return { apiKey: null, shouldIncrementTasksUsed: false, needsApiKeyPrompt: true };
}

/**
 * Send multi-message prompt when user hits free tier limit
 * Only stores and sends if no pending message exists (to avoid overwriting)
 */
async function sendFreeTierLimitPrompt(phoneNumber: string, blockedMessage: string): Promise<void> {
  console.log(`📢 Sending free tier limit prompt to ${phoneNumber}`);
  
  try {
    const sdk = await getIMessageSDK();
    const chatGuid = `any;-;${phoneNumber}`;
    
    // Check if there's already a pending message (don't overwrite)
    const existingConn = await prisma.connection.findFirst({
      where: { phoneNumber, status: 'ACTIVE' },
    });
    
    if ((existingConn as any)?.pendingMessage) {
      console.log(`⚠️ User already has pending message, not overwriting. Sending reminder instead.`);
      await sdk.chats.startTyping(chatGuid);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await sdk.chats.stopTyping(chatGuid);
      await sdk.messages.sendMessage({
        chatGuid,
        message: "Add your API key to continue. Paste it here when you're ready.",
      });
      return;
    }
    
    // Store the blocked message as pendingMessage
    await prisma.connection.updateMany({
      where: { phoneNumber, status: 'ACTIVE' },
      data: { pendingMessage: blockedMessage } as any,
    });
    console.log(`✅ Stored pending message for ${phoneNumber}`);
    
    // Send multi-message prompt with typing indicators
    const messages = [
      "You've used all 3 free tasks! 🎉",
      "To keep going, add your own Manus API key:\nhttps://manus.im/app#settings/integrations/api\n\nCopy your key and paste it here.",
      "Your progress is saved. Once you add your key, just type \"continue\" or tell me what you were working on.",
    ];
    
    for (const msg of messages) {
      // Typing indicator
      await sdk.chats.startTyping(chatGuid);
      await new Promise(resolve => setTimeout(resolve, 1500));
      await sdk.chats.stopTyping(chatGuid);
      
      // Send message
      await sdk.messages.sendMessage({
        chatGuid,
        message: msg,
        richLink: msg.includes('https://'), // Enable rich link for URL messages
      });
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`✅ Free tier limit prompt sent to ${phoneNumber}`);
  } catch (error) {
    console.error(`❌ Failed to send free tier limit prompt:`, error);
    throw error;
  }
}

// Create new Manus task
async function createManusTask(
  phoneNumber: string, 
  message: string, 
  fileIds: string[] = [], 
  messageTimestamp?: Date | string,
  preserveTaskStartTime: boolean = false, // If true, don't update currentTaskStartedAt
  triggeringMessageGuid?: string // GUID of user message that triggered this task (for threaded replies)
) {
  console.log(`Creating new Manus task for ${phoneNumber}:`, message, fileIds.length > 0 ? `with ${fileIds.length} file(s)` : '');
  
  // Get connection to get Manus API key
  const connection = await prisma.connection.findFirst({
    where: { phoneNumber, status: 'ACTIVE' },
  });

  if (!connection) {
    console.error(`❌ No active connection found for ${phoneNumber}`);
    throw new Error('No active connection found');
  }

  // Resolve API key (user's own key vs free tier system key)
  const { apiKey, shouldIncrementTasksUsed, needsApiKeyPrompt } = await resolveApiKeyForConnection(connection);
  
  if (needsApiKeyPrompt) {
    // User has exhausted free tier, send prompt and store message for later
    await sendFreeTierLimitPrompt(phoneNumber, message);
    return; // Don't create task
  }
  
  if (!apiKey) {
    console.error(`❌ No API key available for ${phoneNumber}`);
    throw new Error('No API key available');
  }

  console.log(`✅ Found connection for ${phoneNumber}, creating task with ${shouldIncrementTasksUsed ? 'free tier key' : 'user key'}...`);

  try {
    // Build attachments array
    const attachments = fileIds.map(fileId => ({
      type: 'file_id',
      file_id: fileId,
    }));

    // Call Manus API to create a new task
    const MANUS_API_URL = process.env.MANUS_API_URL || 'https://api.manus.im';
    const response = await fetch(`${MANUS_API_URL}/v1/tasks`, {
      method: 'POST',
      headers: {
        'API_KEY': apiKey, // Use resolved API key (user's or free tier system key)
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: message,
        agentProfile: 'manus-1.6',
        taskMode: 'agent',
        ...(attachments.length > 0 && { attachments }),
        interactiveMode: true, // Allow Manus to ask follow-up questions
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Manus API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as { task_id: string };
    console.log('✅ Created Manus task:', data.task_id);

    // Store the task ID and optionally start time for follow-ups in database
    if (preserveTaskStartTime) {
      // Only update task ID, preserve existing currentTaskStartedAt
      // This keeps conversation history across task boundaries
      const updateData: any = { 
        currentTaskId: data.task_id,
        triggeringMessageGuid: triggeringMessageGuid || null,
      };
      // Increment tasksUsed if using free tier
      if (shouldIncrementTasksUsed) {
        updateData.tasksUsed = { increment: 1 };
      }
      await prisma.connection.update({
        where: { phoneNumber },
        data: updateData,
      });
      console.log(`✅ Updated task ID, preserved conversation history${shouldIncrementTasksUsed ? ', incremented tasksUsed' : ''}`);
    } else {
      // Update both task ID and start time (new conversation)
      // Use the user's message timestamp as task start time (not when Manus creates the task)
      // This ensures the user's triggering message is included in the context
      const taskStartTime = messageTimestamp 
        ? (messageTimestamp instanceof Date ? messageTimestamp : new Date(messageTimestamp))
        : new Date();
      const updateData: any = { 
        currentTaskId: data.task_id,
        currentTaskStartedAt: taskStartTime,
        triggeringMessageGuid: triggeringMessageGuid || null,
      };
      // Increment tasksUsed if using free tier
      if (shouldIncrementTasksUsed) {
        updateData.tasksUsed = { increment: 1 };
      }
      await prisma.connection.update({
        where: { phoneNumber },
        data: updateData,
      });
      console.log(`✅ Stored task start time: ${taskStartTime.toISOString()}${shouldIncrementTasksUsed ? ', incremented tasksUsed' : ''}`);
    }

    // Store task-to-phone mapping in Redis for webhook lookup
    const taskMappingKey = `task:mapping:${data.task_id}`;
    await redis.set(taskMappingKey, phoneNumber, 'EX', TASK_MAPPING_TTL);
    console.log(`✅ Stored task mapping in Redis: ${data.task_id} → ${phoneNumber}`);

    // Store message GUID → task ID mapping for instant thread detection
    if (triggeringMessageGuid) {
      const msgTaskKey = `msg:task:${triggeringMessageGuid}`;
      await redis.set(msgTaskKey, data.task_id, 'EX', TASK_MAPPING_TTL);
      console.log(`✅ Stored message→task mapping: ${triggeringMessageGuid} → ${data.task_id}`);
    }

    // Store task's original triggeringMessageGuid for thread restoration when switching tasks
    if (triggeringMessageGuid) {
      const taskTriggerKey = `task:trigger:${data.task_id}`;
      await redis.set(taskTriggerKey, triggeringMessageGuid, 'EX', TASK_MAPPING_TTL);
      console.log(`✅ Stored task→trigger mapping: ${data.task_id} → ${triggeringMessageGuid}`);
    }

    // Store reaction info so we can remove tapback when task stops
    if (triggeringMessageGuid) {
      const chatGuid = `any;-;${phoneNumber}`;
      await redis.set(
        `reaction:${data.task_id}`,
        JSON.stringify({ messageGuid: triggeringMessageGuid, chatGuid, reaction: 'love' }),
        'EX',
        TASK_MAPPING_TTL
      );
    }

    // Start persistent typing indicator via manager
    try {
      const typingStartTimestamp = new Date().toISOString();
      console.log(`\n🎬 [${typingStartTimestamp}] ======== INITIAL TYPING INDICATOR START ========`);
      console.log(`📱 Phone: ${phoneNumber}`);
      console.log(`🆔 Task: ${data.task_id}`);
      
      // Ensure SDK is initialized
      console.log(`🔧 [${new Date().toISOString()}] Initializing iMessage SDK...`);
      await getIMessageSDK();
      console.log(`✓  [${new Date().toISOString()}] SDK initialized`);
      
      console.log(`🔧 [${new Date().toISOString()}] Getting typing manager...`);
      const manager = getTypingManager();
      console.log(`✓  [${new Date().toISOString()}] Typing manager ready`);
      
      console.log(`🚀 [${new Date().toISOString()}] Starting typing indicator...`);
      const startTime = Date.now();
      await manager.startTyping(phoneNumber, data.task_id);
      const startDuration = Date.now() - startTime;
      console.log(`✅ [${new Date().toISOString()}] Typing indicator start complete - took ${startDuration}ms`);
      console.log(`======== INITIAL TYPING INDICATOR START COMPLETE ========\n`);
    } catch (error) {
      console.warn(`❌ [${new Date().toISOString()}] Failed to start typing indicator:`, error);
      // Non-critical - continue anyway
    }

    return data.task_id;
  } catch (error) {
    console.error('Failed to create Manus task:', error);
    throw error;
  }
}

// Append to existing task (multi-turn conversation)
async function appendToTask(phoneNumber: string, message: string, fileIds: string[] = [], triggeringMessageGuid?: string) {
  console.log(`Appending to existing task for ${phoneNumber}:`, message, fileIds.length > 0 ? `with ${fileIds.length} file(s)` : '');
  
  // Get connection to get Manus API key and current task ID
  const connection = await prisma.connection.findFirst({
    where: { phoneNumber, status: 'ACTIVE' },
  });

  if (!connection) {
    throw new Error('No active connection found');
  }

  // Resolve API key (user's own key vs free tier system key)
  const { apiKey, shouldIncrementTasksUsed, needsApiKeyPrompt } = await resolveApiKeyForConnection(connection);
  
  if (needsApiKeyPrompt) {
    // User has exhausted free tier, send prompt and store message for later
    await sendFreeTierLimitPrompt(phoneNumber, message);
    return; // Don't append to task
  }
  
  if (!apiKey) {
    throw new Error('No API key available');
  }

  if (!connection.currentTaskId) {
    console.warn('No current task ID found, creating new task instead');
    return createManusTask(phoneNumber, message, fileIds);
  }

  // Ensure typing indicator is active (start if not already)
  try {
    const ensureTypingTimestamp = new Date().toISOString();
    console.log(`\n🔍 [${ensureTypingTimestamp}] ======== ENSURE TYPING (APPEND) ========`);
    console.log(`📱 Phone: ${phoneNumber}`);
    console.log(`🆔 Task: ${connection.currentTaskId}`);
    
    // Ensure SDK is initialized
    console.log(`🔧 [${new Date().toISOString()}] Getting iMessage SDK and typing manager...`);
    await getIMessageSDK();
    const manager = getTypingManager();
    
    const isCurrentlyTyping = manager.isTyping(phoneNumber);
    console.log(`📊 Current typing status: ${isCurrentlyTyping ? 'ACTIVE ✓' : 'INACTIVE ✗'}`);
    
    if (!isCurrentlyTyping) {
      console.log(`🟢 [${new Date().toISOString()}] Typing indicator NOT active - starting now...`);
      const startTime = Date.now();
      await manager.startTyping(phoneNumber, connection.currentTaskId);
      const startDuration = Date.now() - startTime;
      console.log(`✅ [${new Date().toISOString()}] Typing indicator started - took ${startDuration}ms`);
    } else {
      console.log(`✅ [${new Date().toISOString()}] Typing indicator already active - no action needed`);
    }
    console.log(`======== ENSURE TYPING COMPLETE ========\n`);
  } catch (error) {
    console.warn(`❌ [${new Date().toISOString()}] Failed to ensure typing indicator:`, error);
    // Non-critical - continue anyway
  }

  try {
    // Build attachments array
    const attachments = fileIds.map(fileId => ({
      type: 'file_id',
      file_id: fileId,
    }));

    // Continue the existing task by passing taskId
    const MANUS_API_URL = process.env.MANUS_API_URL || 'https://api.manus.im';
    const response = await fetch(`${MANUS_API_URL}/v1/tasks`, {
      method: 'POST',
      headers: {
        'API_KEY': apiKey, // Use resolved API key (user's or free tier system key)
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: message,
        taskId: connection.currentTaskId, // Continue existing task
        agentProfile: 'manus-1.6',
        taskMode: 'agent',
        interactiveMode: true,
        ...(attachments.length > 0 && { attachments }),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      
      // Handle "task not found" error - task may have expired or been deleted on Manus side
      // In this case, clear the stale task ID and create a new task instead
      if (response.status === 404 && errorText.includes('task not found')) {
        console.log(`⚠️ Task ${connection.currentTaskId} not found on Manus - clearing stale task and creating new one`);
        
        // Clear the stale task ID
        await prisma.connection.update({
          where: { phoneNumber },
          data: { 
            currentTaskId: null,
            currentTaskStartedAt: null,
            triggeringMessageGuid: null,
          } as any,
        });
        
        // Create a new task instead
        console.log(`🔄 Creating new task for ${phoneNumber} after stale task cleanup`);
        return createManusTask(phoneNumber, message, fileIds, new Date(), false, triggeringMessageGuid);
      }
      
      throw new Error(`Manus API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as { task_id: string };
    console.log('✅ Appended to Manus task:', data.task_id);
    
    // Increment tasksUsed if using free tier (appending counts as using the task)
    // Note: We only count new tasks, not appends to existing tasks
    // This keeps it simple: 3 tasks = 3 conversations, not 3 messages
    // Uncomment below if you want to count appends as well:
    // if (shouldIncrementTasksUsed) {
    //   await prisma.connection.update({
    //     where: { phoneNumber },
    //     data: { tasksUsed: { increment: 1 } } as any,
    //   });
    // }

    // Store reaction info so we can remove tapback when task stops
    if (triggeringMessageGuid) {
      const chatGuid = `any;-;${phoneNumber}`;
      await redis.set(
        `reaction:${data.task_id}`,
        JSON.stringify({ messageGuid: triggeringMessageGuid, chatGuid, reaction: 'love' }),
        'EX',
        TASK_MAPPING_TTL
      );
      
      // Also update the task's trigger GUID in case it wasn't set initially
      // This ensures the trigger GUID is preserved even when appending to a task
      const taskTriggerKey = `task:trigger:${data.task_id}`;
      const existingTrigger = await redis.get(taskTriggerKey);
      if (!existingTrigger) {
        await redis.set(taskTriggerKey, triggeringMessageGuid, 'EX', TASK_MAPPING_TTL);
        console.log(`✅ Stored task→trigger mapping (append): ${data.task_id} → ${triggeringMessageGuid}`);
      }
    }

    return data.task_id;
  } catch (error) {
    console.error('Failed to append to Manus task:', error);
    throw error;
  }
}

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down worker service...');
  
  // Stop all typing indicators
  if (typingManager) {
    await typingManager.stopAll();
  }
  
  // Close all workers
  for (const [phoneNumber, worker] of workers.entries()) {
    await worker.close();
    console.log(`Closed worker for ${phoneNumber}`);
  }

  // Close all queues
  for (const [phoneNumber, queue] of queues.entries()) {
    await queue.close();
    console.log(`Closed queue for ${phoneNumber}`);
  }

  // Close Redis connection
  await redis.quit();
  await prisma.$disconnect();
  
  console.log('Worker service shut down gracefully');
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Initialize workers for existing queues on startup
async function initializeExistingQueues() {
  try {
    // Get all active connections from database
    const activeConnections = await prisma.connection.findMany({
      where: { status: 'ACTIVE' },
      select: { phoneNumber: true },
    });

    console.log(`Found ${activeConnections.length} active connection(s)`);

    // Start workers for each active phone number
    for (const conn of activeConnections) {
      console.log(`Starting worker for ${conn.phoneNumber}`);
      getQueue(conn.phoneNumber); // This will create queue and start worker
    }

    console.log('Worker service ready and listening for messages');
  } catch (error) {
    console.error('Failed to initialize existing queues:', error);
    console.log('Worker service ready and listening for messages');
  }
}

// Periodically check for new active connections (every 10 seconds)
async function checkForNewConnections() {
  try {
    const activeConnections = await prisma.connection.findMany({
      where: { status: 'ACTIVE' },
      select: { phoneNumber: true },
    });

    // Start workers for any new connections
    for (const conn of activeConnections) {
      if (!workers.has(conn.phoneNumber)) {
        console.log(`📱 New active connection detected: ${conn.phoneNumber}`);
        console.log(`Starting worker for ${conn.phoneNumber}`);
        getQueue(conn.phoneNumber); // This will create queue and start worker
      }
    }
  } catch (error) {
    console.error('Failed to check for new connections:', error);
  }
}

// Listen for connection activation, message events, and task-stopped events via Redis pub/sub
async function listenForEvents() {
  try {
    const Redis = (await import('ioredis')).default;
    const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    
    subscriber.subscribe('connection-activated', 'message-queued', 'task-stopped', 'ensure-typing', (err) => {
      if (err) {
        console.error('Failed to subscribe to Redis channels:', err);
      } else {
        console.log('📡 Listening for connection, message, task, and typing events...');
      }
    });

    subscriber.on('message', async (channel, message) => {
      if (channel === 'connection-activated') {
        const phoneNumber = message;
        console.log(`🔔 Connection activated: ${phoneNumber}`);
        if (!workers.has(phoneNumber)) {
          console.log(`Starting worker immediately for ${phoneNumber}`);
          getQueue(phoneNumber); // Start worker immediately
        }
      } else if (channel === 'message-queued') {
        const phoneNumber = message;
        console.log(`📬 Message queued for: ${phoneNumber}`);
        if (!workers.has(phoneNumber)) {
          console.log(`Starting worker for ${phoneNumber}`);
          getQueue(phoneNumber); // Ensure worker exists
        }
      } else if (channel === 'ensure-typing') {
        const receiveTimestamp = new Date().toISOString();
        console.log(`\n📨 [${receiveTimestamp}] ======== ENSURE-TYPING EVENT RECEIVED ========`);
        
        try {
          const data = JSON.parse(message);
          const { phoneNumber, taskId } = data;
          console.log(`📱 Phone: ${phoneNumber}`);
          console.log(`🆔 Task: ${taskId}`);
          
          // RESTART typing indicator after progress message
          // Sending iMessage stops typing automatically - must restart it manually
          try {
            console.log(`🔍 [${new Date().toISOString()}] Checking typing indicator status...`);
            await getIMessageSDK();
            const manager = getTypingManager();
            const isCurrentlyTyping = manager.isTyping(phoneNumber);
            const isCurrentlyRefreshing = manager.isRefreshing(phoneNumber);
            console.log(`📊 Current status: ${isCurrentlyTyping ? 'ACTIVE ✓' : 'INACTIVE ✗'}, Refreshing: ${isCurrentlyRefreshing ? 'YES' : 'NO'}`);
            
            // Skip if refresh is in progress - it will handle restarting
            if (isCurrentlyRefreshing) {
              console.log(`⏭️  [${new Date().toISOString()}] Refresh in progress - skipping ensure-typing (refresh will handle it)`);
              return;
            }
            
            const totalStartTime = Date.now();
            
            // If typing is active, stop it first (iMessage auto-stopped it when we sent the message)
            if (isCurrentlyTyping) {
              console.log(`🛑 [${new Date().toISOString()}] Stopping typing indicator (iMessage auto-stopped it when we sent progress message)...`);
              const stopTime = Date.now();
              await manager.stopTyping(phoneNumber);
              const stopDuration = Date.now() - stopTime;
              console.log(`⏹️  [${new Date().toISOString()}] Stopped - took ${stopDuration}ms`);
            }
            
            // Start typing indicator (no wait needed)
            console.log(`🟢 [${new Date().toISOString()}] Starting typing indicator...`);
            const startTime = Date.now();
            await manager.startTyping(phoneNumber, taskId);
            const startDuration = Date.now() - startTime;
            const totalDuration = Date.now() - totalStartTime;
            console.log(`✅ [${new Date().toISOString()}] Typing indicator restarted - start took ${startDuration}ms, total operation ${totalDuration}ms`);
          } catch (error) {
            console.warn(`❌ [${new Date().toISOString()}] Failed to restart typing indicator:`, error);
          }
        } catch (error) {
          console.error(`❌ [${new Date().toISOString()}] Failed to handle ensure-typing event:`, error);
        }
        
        console.log(`======== ENSURE-TYPING EVENT COMPLETE ========\n`);
      } else if (channel === 'task-stopped') {
        try {
          const data = JSON.parse(message);
          const { phoneNumber, taskId } = data;
          console.log(`🛑 Task stopped event received: ${phoneNumber} (task: ${taskId})`);
          
          // Stop typing indicator only. Do NOT clear task context here.
          // Context is only cleared when the user sends a message classified as NEW_TASK.
          // This keeps follow-up messages (e.g. "its not getting warm") in the same thread
          // instead of starting a new task when the user is still in the same conversation.
          try {
            await getIMessageSDK();
            const manager = getTypingManager();
            if (manager.isTyping(phoneNumber)) {
              await manager.stopTyping(phoneNumber);
            }
          } catch (error) {
            console.warn('Failed to stop typing indicator:', error);
          }

          // Remove tapback from the user message we reacted to when the response stream started
          try {
            const reactionKey = `reaction:${taskId}`;
            const payload = await redis.get(reactionKey);
            if (payload) {
              const { messageGuid, chatGuid, reaction } = JSON.parse(payload) as {
                messageGuid?: string;
                chatGuid?: string;
                reaction?: string;
              };
              if (messageGuid && chatGuid && reaction) {
                const sdk = await getIMessageSDK();
                await sdk.messages.sendReaction({
                  chatGuid,
                  messageGuid,
                  reaction: `-${reaction}`,
                });
                await redis.del(reactionKey);
              }
            }
          } catch (error) {
            console.warn('Failed to remove tapback (non-blocking):', error);
          }
        } catch (error) {
          console.error('Failed to handle task-stopped event:', error);
        }
      }
    });
  } catch (error) {
    console.error('Failed to set up event listeners:', error);
  }
}

// Initialize iMessage SDK and typing manager on startup
async function initializeSDK() {
  try {
    await getIMessageSDK();
    console.log('✅ iMessage SDK and typing manager initialized');
  } catch (error) {
    console.error('Failed to initialize iMessage SDK:', error);
    // Continue anyway - SDK will be initialized on first use
  }
}

// Initialize on startup
initializeSDK();
initializeExistingQueues();

// Listen for instant activation and message notifications
listenForEvents();

// Check for new connections every 10 seconds (backup mechanism)
setInterval(checkForNewConnections, 10000);
