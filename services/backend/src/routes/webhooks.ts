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
  fastify.post('/manus', async (request, reply) => {
    try {
      // Validate webhook event
      const event = WebhookEventSchema.parse(request.body);
      
      // Get Manus API key from Authorization header
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Missing authorization' });
      }

      const manusApiKey = authHeader.replace('Bearer ', '');

      // Find connection by Manus API key
      const connection = await prisma.connection.findFirst({
        where: { manusApiKey, status: 'ACTIVE' },
      });

      if (!connection) {
        return reply.code(404).send({ error: 'Connection not found' });
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

  // Throttle: max 1 update per minute (prevent spam)
  const lastSent = progressTimestamps.get(phoneNumber) || 0;
  const now = Date.now();

  if (now - lastSent < 60000) {
    // Skip if less than 1 minute since last progress update
    return;
  }

  // Send all progress data (can be filtered later)
  let message = formatManusMessage(`🔄 Progress Update`);
  if (progressType) {
    message += `\n\nType: ${progressType}`;
  }
  message += `\n\n${progressMessage}`;
  
  const messageGuid = await sendIMessage(phoneNumber, message);

  // Record in database
  await prisma.manusMessage.create({
    data: {
      messageGuid,
      phoneNumber,
      messageType: 'WEBHOOK',
    },
  });

  // Update timestamp
  progressTimestamps.set(phoneNumber, now);
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

  // Record in database
  await prisma.manusMessage.create({
    data: {
      messageGuid,
      phoneNumber,
      messageType: 'WEBHOOK',
    },
  });
}

// Helper function to send iMessage
async function sendIMessage(phoneNumber: string, message: string): Promise<string> {
  const { sendIMessage: sendMessage } = await import('../lib/imessage.js');
  return sendMessage(phoneNumber, message);
}
