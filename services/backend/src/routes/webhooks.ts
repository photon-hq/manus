import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@imessage-mcp/database';
import { WebhookEventSchema, formatManusMessage } from '@imessage-mcp/shared';

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

  // Always send confirmation
  const message = formatManusMessage(`Got it! Working on: "${taskTitle}"`);
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

  if (!taskId || !progressMessage) return;

  // Check if task has been running for at least 2 minutes
  const taskStartTime = taskStartTimes.get(taskId);
  if (taskStartTime) {
    const taskDuration = Date.now() - taskStartTime;
    if (taskDuration < 120000) {
      // Skip progress updates for tasks < 2 minutes
      return;
    }
  }

  // Throttle: max 1 update per minute
  const lastSent = progressTimestamps.get(phoneNumber) || 0;
  const now = Date.now();

  if (now - lastSent < 60000) {
    // Skip if less than 1 minute since last progress update
    return;
  }

  // Send progress update
  const message = formatManusMessage(`🔄 ${progressMessage}`);
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

  // Clean up task tracking
  if (taskId) {
    taskStartTimes.delete(taskId);
  }

  let message: string;

  if (stopReason === 'ask') {
    // Task needs user input - CRITICAL
    message = formatManusMessage(`❓ I need your input:\n\n${resultMessage}`);
  } else {
    // Task completed
    message = formatManusMessage(
      `✅ Task complete: "${taskTitle}"\n\n${resultMessage || 'Done!'}\n\nFull report: ${taskUrl}`
    );
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
  const endpoint = process.env.IMESSAGE_ENDPOINT;
  const apiKey = process.env.IMESSAGE_API_KEY;

  if (!endpoint || !apiKey) {
    throw new Error('iMessage configuration missing');
  }

  try {
    const response = await fetch(`${endpoint}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: phoneNumber,
        message,
      }),
    });

    if (!response.ok) {
      throw new Error(`iMessage API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.messageGuid || data.guid || `msg_${Date.now()}`;
  } catch (error) {
    console.error('Failed to send iMessage:', error);
    throw error;
  }
}
