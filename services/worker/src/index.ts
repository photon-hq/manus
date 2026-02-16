import { Queue, Worker, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { prisma, QueueStatus } from '@imessage-mcp/database';
import { sanitizeHandle } from '@imessage-mcp/shared';
import { SDK } from '@photon-ai/advanced-imessage-kit';
import { TypingIndicatorManager } from './typing-manager.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEBOUNCE_WINDOW = 3000; // 3 seconds

// Redis key expiration for task mapping (24 hours)
const TASK_MAPPING_TTL = 24 * 60 * 60; // seconds

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
    // Handle attachments if present
    let fileIds: string[] = [];
    if (attachments && attachments.length > 0) {
      fileIds = await processAttachments(phoneNumber, attachments);
    }

    // If message is empty but has attachments, use a default prompt
    let effectiveMessage = messageText;
    if (!effectiveMessage && fileIds.length > 0) {
      effectiveMessage = `[User sent ${fileIds.length} file(s)]`;
    }

    // Skip processing if both message and attachments are empty
    if (!effectiveMessage && fileIds.length === 0) {
      console.warn(`Skipping empty message for ${phoneNumber}`);
      return;
    }

    // Special handling for file-only messages (no text)
    // If user sends only files:
    // - No active task → Create new task
    // - Active task exists → Append to current task
    if (!messageText && fileIds.length > 0) {
      const connection = await prisma.connection.findFirst({
        where: { phoneNumber, status: 'ACTIVE' },
      });

      if (connection?.currentTaskId) {
        // Active task exists - append files to it
        console.log(`📎 File-only message with active task - appending to ${connection.currentTaskId}`);
        await appendToTask(phoneNumber, effectiveMessage, fileIds, messageGuid);
      } else {
        // No active task - create new task
        console.log(`📎 File-only message with no active task - creating new task`);
        await createManusTask(phoneNumber, effectiveMessage, fileIds, messageTimestamp, false, messageGuid);
      }
    } else {
      // Regular message with text - use thread detection
      // Get connection to check thread info and active task
      const connection = await prisma.connection.findFirst({
        where: { phoneNumber, status: 'ACTIVE' },
      });

      // Check if user is replying to ANY message in ANY task's thread
      let isFollowUp = false;
      let taskIdForThread: string | null = null;

      if (threadOriginatorGuid) {
        // Direct lookup: msg:task:{messageGuid} → taskId
        const msgTaskKey = `msg:task:${threadOriginatorGuid}`;
        taskIdForThread = await redis.get(msgTaskKey);
        
        if (taskIdForThread) {
          isFollowUp = true;
          console.log(`✅ Found thread match via direct lookup: ${threadOriginatorGuid} → ${taskIdForThread}`);
        }
      }

      console.log(`🔗 Thread detection for ${phoneNumber}:`, {
        threadOriginatorGuid: threadOriginatorGuid || 'none',
        currentTaskId: connection?.currentTaskId || 'none',
        isFollowUp,
        taskIdForThread,
        hasActiveTask: !!connection?.currentTaskId
      });

      if (isFollowUp && taskIdForThread) {
        // User replied to a task thread → switch to that task and append
        console.log(`✅ Thread reply detected - switching to task ${taskIdForThread}`);
        
        // Restore the original triggeringMessageGuid for this task to maintain proper threading
        const taskTriggerKey = `task:trigger:${taskIdForThread}`;
        const originalTriggeringGuid = await redis.get(taskTriggerKey);
        
        if (originalTriggeringGuid) {
          console.log(`✅ Restored original trigger GUID for task ${taskIdForThread}: ${originalTriggeringGuid}`);
        } else {
          console.log(`⚠️  No stored trigger GUID found for task ${taskIdForThread}, using current message GUID as fallback`);
        }
        
        // Update connection to point to the task being replied to AND restore its original trigger
        await prisma.connection.update({
          where: { phoneNumber },
          data: { 
            currentTaskId: taskIdForThread,
            triggeringMessageGuid: originalTriggeringGuid || threadOriginatorGuid || messageGuid,
          },
        });
        
        await appendToTask(phoneNumber, effectiveMessage, fileIds, messageGuid);
      } else {
        // Not a thread reply or no active task → create new task
        if (connection?.currentTaskId) {
          await prisma.connection.update({
            where: { phoneNumber },
            data: { currentTaskId: null },
          });
          console.log(`✅ Cleared previous task ID for ${phoneNumber} (NEW_TASK - not a thread reply)`);
        }
        await createManusTask(phoneNumber, effectiveMessage, fileIds, messageTimestamp, false, messageGuid);
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

    if (!connection?.manusApiKey) {
      throw new Error('No Manus API key found for user');
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

        // Upload to Manus using user's API key
        const fileId = await uploadFileToManus(Buffer.from(result), attachment.filename, connection.manusApiKey);
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

// SLM classifier functions removed - now using thread detection instead

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

  if (!connection.manusApiKey) {
    console.error(`❌ No Manus API key found for ${phoneNumber}`);
    throw new Error('No Manus API key configured');
  }

  console.log(`✅ Found connection for ${phoneNumber}, creating task...`);

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
        'API_KEY': connection.manusApiKey,
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
      await prisma.connection.update({
        where: { phoneNumber },
        data: { 
          currentTaskId: data.task_id,
          triggeringMessageGuid: triggeringMessageGuid || null,
        } as any,
      });
      console.log(`✅ Updated task ID, preserved conversation history`);
    } else {
      // Update both task ID and start time (new conversation)
      // Use the user's message timestamp as task start time (not when Manus creates the task)
      // This ensures the user's triggering message is included in the context
      const taskStartTime = messageTimestamp 
        ? (messageTimestamp instanceof Date ? messageTimestamp : new Date(messageTimestamp))
        : new Date();
      await prisma.connection.update({
        where: { phoneNumber },
        data: { 
          currentTaskId: data.task_id,
          currentTaskStartedAt: taskStartTime,
          triggeringMessageGuid: triggeringMessageGuid || null,
        } as any,
      });
      console.log(`✅ Stored task start time: ${taskStartTime.toISOString()} (user message time, not task creation time)`);
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
      // Ensure SDK is initialized
      await getIMessageSDK();
      const manager = getTypingManager();
      await manager.startTyping(phoneNumber, data.task_id);
    } catch (error) {
      console.warn('Failed to start typing indicator:', error);
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

  if (!connection || !connection.manusApiKey) {
    throw new Error('No active connection found');
  }

  if (!connection.currentTaskId) {
    console.warn('No current task ID found, creating new task instead');
    return createManusTask(phoneNumber, message, fileIds);
  }

  // Ensure typing indicator is active (start if not already)
  try {
    // Ensure SDK is initialized
    await getIMessageSDK();
    const manager = getTypingManager();
    if (!manager.isTyping(phoneNumber)) {
      await manager.startTyping(phoneNumber, connection.currentTaskId);
    }
  } catch (error) {
    console.warn('Failed to ensure typing indicator:', error);
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
        'API_KEY': connection.manusApiKey,
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
      throw new Error(`Manus API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as { task_id: string };
    console.log('✅ Appended to Manus task:', data.task_id);

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
        try {
          const data = JSON.parse(message);
          const { phoneNumber, taskId } = data;
          console.log(`🔄 Ensure typing event received: ${phoneNumber} (task: ${taskId})`);
          
          // Ensure typing indicator is active
          try {
            await getIMessageSDK();
            const manager = getTypingManager();
            if (!manager.isTyping(phoneNumber)) {
              console.log(`🟢 Restarting typing indicator for ${phoneNumber} (task: ${taskId})`);
              await manager.startTyping(phoneNumber, taskId);
            } else {
              console.log(`✅ Typing indicator already active for ${phoneNumber}`);
            }
          } catch (error) {
            console.warn('Failed to ensure typing indicator:', error);
          }
        } catch (error) {
          console.error('Failed to handle ensure-typing event:', error);
        }
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
