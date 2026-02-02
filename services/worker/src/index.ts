import './tracing';
import { Queue, Worker, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { prisma, QueueStatus } from '@imessage-mcp/database';
import { TaskClassification } from '@imessage-mcp/shared';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const SLM_SERVICE_URL = process.env.SLM_SERVICE_URL || 'http://localhost:3001';
const DEBOUNCE_WINDOW = 2000; // 2 seconds

// Redis connection
const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Map to track queues and workers per phone number
const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

console.log('Worker service starting...');

// Function to get or create queue for a phone number
function getQueue(phoneNumber: string): Queue {
  if (!queues.has(phoneNumber)) {
    const queue = new Queue(`messages:${phoneNumber}`, {
      connection,
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

    // Start worker for this queue
    startWorker(phoneNumber);
  }
  return queues.get(phoneNumber)!;
}

// Start worker for a specific phone number queue
function startWorker(phoneNumber: string) {
  if (workers.has(phoneNumber)) return;

  const worker = new Worker(
    `messages:${phoneNumber}`,
    async (job) => {
      console.log(`Processing message for ${phoneNumber}:`, job.data);
      await processMessage(phoneNumber, job.data);
    },
    {
      connection,
      concurrency: 1, // Sequential processing per user
    }
  );

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed for ${phoneNumber}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed for ${phoneNumber}:`, err);
  });

  workers.set(phoneNumber, worker);
}

// Handle incoming message (called by backend or message receiver)
export async function handleIncomingMessage(phoneNumber: string, message: string, messageGuid: string) {
  console.log(`Incoming message from ${phoneNumber}`);

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

  if (lastMessage && Date.now() - lastMessage.createdAt.getTime() < DEBOUNCE_WINDOW) {
    // Combine messages
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
        messageText: message,
        status: QueueStatus.PENDING,
      },
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
  const { messageId, messageText } = data;

  try {
    // Get last task context (last 20 messages)
    const recentMessages = await getRecentMessages(phoneNumber, 20);

    // Classify message using SLM
    const classification = await classifyMessage(messageText, recentMessages);

    console.log(`Classification for ${phoneNumber}:`, classification);

    if (classification.type === TaskClassification.NEW_TASK) {
      // Create new Manus task
      await createManusTask(phoneNumber, messageText);
    } else {
      // Follow-up to existing task
      await appendToTask(phoneNumber, messageText);
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

// Get recent messages for context
async function getRecentMessages(phoneNumber: string, limit: number = 20): Promise<any[]> {
  try {
    const { SDK } = await import('@photon-ai/advanced-imessage-kit');
    const sdk = SDK({
      serverUrl: process.env.IMESSAGE_SERVER_URL || 'http://localhost:1234',
      apiKey: process.env.IMESSAGE_API_KEY,
      logLevel: 'error',
    });

    await sdk.connect();

    const chatGuid = `any;-;${phoneNumber}`;
    const messages = await sdk.messages.getMessages({
      chatGuid,
      limit,
      sort: 'DESC',
    });

    await sdk.close();

    return messages.map((msg) => ({
      from: msg.isFromMe ? 'me' : phoneNumber,
      text: msg.text || '',
      timestamp: new Date(msg.dateCreated).toISOString(),
    }));
  } catch (error) {
    console.error('Failed to fetch recent messages:', error);
    return [];
  }
}

// Classify message using SLM service
async function classifyMessage(message: string, context: any[]): Promise<any> {
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

    return await response.json();
  } catch (error) {
    console.error('Classification failed:', error);
    // Default to NEW_TASK on error
    return { type: TaskClassification.NEW_TASK, confidence: 0.5 };
  }
}

// Create new Manus task
async function createManusTask(phoneNumber: string, message: string) {
  console.log(`Creating new Manus task for ${phoneNumber}:`, message);
  
  // Get connection to get Manus API key
  const connection = await prisma.connection.findFirst({
    where: { phoneNumber, status: 'ACTIVE' },
  });

  if (!connection || !connection.manusApiKey) {
    throw new Error('No active connection found');
  }

  // TODO: Call Manus API to create task
  // This would use the Manus API to create a new task
  console.log('TODO: Implement Manus task creation API call');
}

// Append to existing task
async function appendToTask(phoneNumber: string, message: string) {
  console.log(`Appending to existing task for ${phoneNumber}:`, message);
  
  // TODO: Call Manus API to append to task
  // This would use the Manus API to add context to running task
  console.log('TODO: Implement Manus task append API call');
}

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down worker service...');
  
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
  await connection.quit();
  await prisma.$disconnect();
  
  console.log('Worker service shut down gracefully');
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log('Worker service ready and listening for messages');
