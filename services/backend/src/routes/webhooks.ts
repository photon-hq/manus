import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@imessage-mcp/database';
import { WebhookEventSchema, formatManusMessage } from '@imessage-mcp/shared';

/**
 * Webhook Handler for Manus AI Events
 * 
 * Current Behavior: Shows ALL webhook data to users via iMessage
 * TODO: Add filtering logic later to customize what gets shown to users
 * 
 * Filtering can be added in:
 * - handleTaskCreated() - Filter task creation notifications
 * - handleTaskProgress() - Filter progress updates (currently throttled to 1/min)
 * - handleTaskStopped() - Filter completion/question notifications
 * 
 * Attachment Handling:
 * - V1: Sends download links in text (current implementation)
 * - V2: TODO - Add option to download and send actual files via iMessage
 */

// Throttling state
const progressTimestamps = new Map<string, number>();
const taskStartTimes = new Map<string, number>();

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/webhooks/manus - Receive webhooks from Manus
  fastify.post('/webhook', async (request, reply) => {
    try {
      // Log incoming webhook for debugging
      fastify.log.info({ 
        headers: request.headers, 
        body: request.body 
      }, 'Incoming webhook - full details');
      
      // Validate webhook event
      const event = WebhookEventSchema.parse(request.body);
      
      // Extract task ID from the event to find the connection
      const taskId = event.task_detail?.task_id || event.progress_detail?.task_id;
      
      if (!taskId) {
        fastify.log.warn('Webhook missing task_id');
        return reply.code(400).send({ error: 'Missing task_id' });
      }

      // Find connection by task ID (stored in currentTaskId or check message history)
      let connection = await prisma.connection.findFirst({
        where: { 
          currentTaskId: taskId,
          status: 'ACTIVE' 
        },
      });

      // If not found by currentTaskId, try to find via webhookId in the URL or other means
      // For now, if we can't find the connection, try to match based on webhook signature/headers
      if (!connection) {
        // Check if there's a signature header we can use to identify the user
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const apiKey = authHeader.replace('Bearer ', '');
          connection = await prisma.connection.findFirst({
            where: { manusApiKey: apiKey, status: 'ACTIVE' },
          });
        }
      }

      if (!connection) {
        fastify.log.warn({ taskId }, 'No active connection found for task');
        // Accept the webhook but can't deliver
        return { success: true, message: 'No active connection found' };
      }

      const { phoneNumber } = connection;

      fastify.log.info({ event: event.event_type, phoneNumber }, 'Webhook received');

      // Handle different event types
      switch (event.event_type) {
        case 'task_created':
          await handleTaskCreated(phoneNumber, event);
          break;

        case 'task_progress':
          await handleTaskProgress(phoneNumber, event);
          break;

        case 'task_stopped':
          await handleTaskStopped(phoneNumber, event);
          break;
      }

      return { success: true };
    } catch (error) {
      fastify.log.error(error, 'Webhook processing failed');
      return reply.code(500).send({ error: 'Webhook processing failed' });
    }
  });
};

async function handleTaskCreated(phoneNumber: string, event: any) {
  const taskId = event.task_detail?.task_id;
  const taskTitle = event.task_detail?.task_title || 'your task';
  const taskUrl = event.task_detail?.task_url;

  // Send all data from webhook (can be filtered later)
  let message = formatManusMessage(`✅ Task Created\n\nTitle: ${taskTitle}`);
  if (taskUrl) {
    message += `\n\nView: ${taskUrl}`;
  }
  
  const messageGuid = await sendIMessage(phoneNumber, message);
  console.log(`✅ Task created notification sent to ${phoneNumber} (task: ${taskId})`);

  // Record in database
  await prisma.manusMessage.create({
    data: {
      messageGuid,
      phoneNumber,
      messageType: 'WEBHOOK',
    },
  });

  // Track task start time
  if (taskId) {
    taskStartTimes.set(taskId, Date.now());
  }
}

async function handleTaskProgress(phoneNumber: string, event: any) {
  const taskId = event.progress_detail?.task_id;
  const progressMessage = event.progress_detail?.message;
  const progressType = event.progress_detail?.progress_type;

  if (!taskId || !progressMessage) return;

  // TODO: Add filtering logic here later to decide what to show
  // For now, show all progress updates with basic throttling

  // Throttle: max 1 update per minute per task (prevent spam)
  // Use task-specific key so multiple concurrent tasks don't interfere
  const throttleKey = `${phoneNumber}:${taskId}`;
  const lastSent = progressTimestamps.get(throttleKey) || 0;
  const now = Date.now();

  if (now - lastSent < 60000) {
    // Skip if less than 1 minute since last progress update for this task
    return;
  }

  // Send all progress data (can be filtered later)
  let message = formatManusMessage(`🔄 Progress Update`);
  if (progressType) {
    message += `\n\nType: ${progressType}`;
  }
  message += `\n\n${progressMessage}`;
  
  const messageGuid = await sendIMessage(phoneNumber, message);
  console.log(`✅ Progress update sent to ${phoneNumber} (task: ${taskId})`);

  // Record in database
  await prisma.manusMessage.create({
    data: {
      messageGuid,
      phoneNumber,
      messageType: 'WEBHOOK',
    },
  });

  // Update timestamp for this specific task
  progressTimestamps.set(throttleKey, now);
}

async function handleTaskStopped(phoneNumber: string, event: any) {
  const taskId = event.task_detail?.task_id;
  const stopReason = event.task_detail?.stop_reason;
  const taskTitle = event.task_detail?.task_title;
  const taskUrl = event.task_detail?.task_url;
  const resultMessage = event.task_detail?.message;
  const attachments = event.task_detail?.attachments;

  // Clean up task tracking
  if (taskId) {
    taskStartTimes.delete(taskId);
    
    // Clear currentTaskId from connection when task finishes successfully
    if (stopReason === 'finish') {
      await prisma.connection.updateMany({
        where: { currentTaskId: taskId },
        data: { currentTaskId: null },
      });
    }
  }

  // TODO: Add filtering logic here later to customize what to show
  // For now, show all data from webhook

  let message: string;

  if (stopReason === 'ask') {
    // Task needs user input - CRITICAL
    message = formatManusMessage(`❓ Question\n\n${resultMessage}`);
  } else if (stopReason === 'finish') {
    // Task completed successfully
    message = formatManusMessage(`✅ Task Complete: "${taskTitle}"`);
    if (resultMessage) {
      message += `\n\n${resultMessage}`;
    }
    if (taskUrl) {
      message += `\n\nView full report: ${taskUrl}`;
    }
    if (attachments && attachments.length > 0) {
      message += `\n\n📎 Attachments (${attachments.length}):`;
      attachments.forEach((att: any, idx: number) => {
        const sizeMB = (att.size_bytes / 1024 / 1024).toFixed(2);
        message += `\n${idx + 1}. ${att.file_name} (${sizeMB} MB)\n   ${att.url}`;
      });
    }
  } else {
    // Other stop reasons (error, cancelled, etc.)
    message = formatManusMessage(`⚠️ Task Stopped: "${taskTitle}"\n\nReason: ${stopReason}`);
    if (resultMessage) {
      message += `\n\n${resultMessage}`;
    }
    if (taskUrl) {
      message += `\n\nView: ${taskUrl}`;
    }
  }

  const messageGuid = await sendIMessage(phoneNumber, message);
  console.log(`✅ Task completion notification sent to ${phoneNumber} (task: ${taskId}, reason: ${stopReason})`);

  // Record in database
  await prisma.manusMessage.create({
    data: {
      messageGuid,
      phoneNumber,
      messageType: 'WEBHOOK',
    },
  });
}

// Helper function to send iMessage with retry logic
async function sendIMessage(phoneNumber: string, message: string, retries = 3): Promise<string> {
  const { sendIMessage: sendMessage } = await import('../lib/imessage.js');
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await sendMessage(phoneNumber, message);
    } catch (error) {
      console.error(`❌ Failed to send iMessage (attempt ${attempt}/${retries}):`, error);
      
      if (attempt === retries) {
        // Last attempt failed - log and rethrow
        console.error('❌ All retry attempts exhausted for iMessage send');
        throw error;
      }
      
      // Wait before retrying (exponential backoff: 1s, 2s, 4s)
      const delayMs = Math.pow(2, attempt - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  // This should never be reached, but TypeScript needs it
  throw new Error('Unexpected error in sendIMessage');
}
