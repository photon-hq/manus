import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@imessage-mcp/database';
import { WebhookEventSchema, formatManusMessage, splitMessageByParagraphs, stripMarkdownFormatting } from '@imessage-mcp/shared';
import Redis from 'ioredis';

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

// Redis connection for task mapping lookup
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

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

      // If not found by currentTaskId, try Redis task mapping (fallback)
      if (!connection) {
        const taskMappingKey = `task:mapping:${taskId}`;
        const phoneNumber = await redis.get(taskMappingKey);
        
        if (phoneNumber) {
          fastify.log.info({ taskId, phoneNumber }, 'Found task mapping in Redis');
          connection = await prisma.connection.findFirst({
            where: { phoneNumber, status: 'ACTIVE' },
          });
        }
      }

      // If still not found, try to find via webhookId in the URL or other means
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
  
  // Log full event
  console.log('\n' + '='.repeat(70));
  console.log('📋 TASK CREATED WEBHOOK RECEIVED');
  console.log('='.repeat(70));
  console.log('Full event object:');
  console.log(JSON.stringify(event, null, 2));
  console.log('\nExtracted fields:');
  console.log(`  • task_id: ${taskId}`);
  console.log(`  • task_title: ${event.task_detail?.task_title}`);
  console.log(`  • task_url: ${event.task_detail?.task_url}`);
  console.log('='.repeat(70) + '\n');
  
  // Don't send notification for task creation - it's usually followed immediately by task completion
  // Users will just get the final result, which is cleaner
  console.log(`📋 Task created for ${phoneNumber} (task: ${taskId}) - not sending notification`);

  // Track task start time
  if (taskId) {
    taskStartTimes.set(taskId, Date.now());
  }
}

async function handleTaskProgress(phoneNumber: string, event: any) {
  const taskId = event.progress_detail?.task_id;
  const progressMessage = event.progress_detail?.message;
  const progressDescription = event.progress_detail?.description;
  const progressType = event.progress_detail?.progress_type;

  // Log full progress_detail to see all available fields
  console.log('\n' + '='.repeat(70));
  console.log('📊 TASK PROGRESS WEBHOOK RECEIVED');
  console.log('='.repeat(70));
  console.log('Full event object:');
  console.log(JSON.stringify(event, null, 2));
  console.log('\nExtracted fields:');
  console.log(`  • task_id: ${taskId}`);
  console.log(`  • progress_type: ${progressType}`);
  console.log(`  • message: "${progressMessage}"`);
  console.log(`  • description: ${progressDescription ? `"${progressDescription}"` : 'N/A'}`);
  console.log('='.repeat(70) + '\n');

  if (!taskId || !progressMessage) {
    console.log('⚠️  Missing required fields (task_id or message), skipping');
    return;
  }

  // Use description if available, otherwise fall back to message
  let displayText = progressDescription || progressMessage;
  
  // Format subtask message: lowercase first letter and add "..." at the end
  // Example: "Research on semantic turn detection" → "research on semantic turn detection..."
  displayText = displayText.charAt(0).toLowerCase() + displayText.slice(1);
  if (!displayText.endsWith('...') && !displayText.endsWith('.')) {
    displayText = displayText + '...';
  }

  // NO FILTERING - send all progress updates to user
  console.log(`📤 Sending progress update: "${displayText}"`);

  // Throttle: max 1 update per 10 seconds per task (prevent spam while staying responsive)
  // Use task-specific key so multiple concurrent tasks don't interfere
  const throttleKey = `${phoneNumber}:${taskId}`;
  const lastSent = progressTimestamps.get(throttleKey) || 0;
  const now = Date.now();

  if (now - lastSent < 10000) {
    // Skip if less than 10 seconds since last progress update for this task
    console.log(`⏭️  Throttled progress notification for ${phoneNumber} (task: ${taskId})`);
    return;
  }

  // Send the progress message (no emoji - just the message text)
  const message = formatManusMessage(displayText);
  
  const messageGuid = await sendIMessage(phoneNumber, message);
  console.log(`✅ Progress update sent to ${phoneNumber} (task: ${taskId}, type: ${progressType})`);

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
  
  // Ensure typing indicator continues after sending progress message
  // The worker's persistent typing indicator should remain active
  try {
    await redis.publish('ensure-typing', JSON.stringify({ phoneNumber, taskId }));
    console.log(`🔄 Requested typing indicator refresh for ${phoneNumber} (task: ${taskId})`);
  } catch (error) {
    console.warn('Failed to request typing indicator refresh:', error);
  }
}

async function handleTaskStopped(phoneNumber: string, event: any) {
  const taskId = event.task_detail?.task_id;
  const stopReason = event.task_detail?.stop_reason;
  const taskTitle = event.task_detail?.task_title;
  const taskUrl = event.task_detail?.task_url;
  const resultMessage = event.task_detail?.message;
  const attachments = event.task_detail?.attachments;

  // Log full event
  console.log('\n' + '='.repeat(70));
  console.log('🛑 TASK STOPPED WEBHOOK RECEIVED');
  console.log('='.repeat(70));
  console.log('Full event object:');
  console.log(JSON.stringify(event, null, 2));
  console.log('\nExtracted fields:');
  console.log(`  • task_id: ${taskId}`);
  console.log(`  • task_title: ${taskTitle}`);
  console.log(`  • task_url: ${taskUrl}`);
  console.log(`  • stop_reason: ${stopReason}`);
  console.log(`  • message: "${resultMessage?.substring(0, 100)}..."`);
  console.log(`  • attachments: ${attachments?.length || 0} file(s)`);
  console.log('='.repeat(70) + '\n');

  // Stop typing indicator via Redis pub/sub to worker
  try {
    await redis.publish('task-stopped', JSON.stringify({ phoneNumber, taskId }));
    console.log(`📢 Published task-stopped event for ${phoneNumber} (task: ${taskId})`);
  } catch (error) {
    console.warn('Failed to publish task-stopped event:', error);
  }

  // Clean up task tracking
  if (taskId) {
    taskStartTimes.delete(taskId);
    
    // DON'T clear currentTaskId immediately - keep it for 30 seconds to allow follow-ups
    // The worker will handle clearing it after the grace period
    // This allows users to send follow-up messages right after a task completes
    
    // Clean up Redis task mapping
    const taskMappingKey = `task:mapping:${taskId}`;
    await redis.del(taskMappingKey);
  }

  // TODO: Add filtering logic here later to customize what to show
  // For now, show all data from webhook

  let message: string;

  if (stopReason === 'ask') {
    // Task needs user input - CRITICAL
    message = formatManusMessage(`❓ Question\n\n${resultMessage}`);
  } else if (stopReason === 'finish') {
    // Task completed successfully - just send the result message
    if (resultMessage) {
      message = formatManusMessage(resultMessage);
    } else {
      // Fallback if no message
      message = formatManusMessage(`✅ Task Complete: "${taskTitle}"`);
      if (taskUrl) {
        message += `\n\nView: ${taskUrl}`;
      }
    }
  } else {
    // Other stop reasons (error, cancelled, etc.)
    message = formatManusMessage(`⚠️ Task Stopped: "${taskTitle}"\n\nReason: ${stopReason}`);
    if (resultMessage) {
      message += `\n\n${resultMessage}`;
    }
  }

  // Strip markdown formatting (iMessage API doesn't support programmatic formatting)
  const cleanMessage = stripMarkdownFormatting(message);
  
  // Split message by paragraphs for better readability
  const chunks = splitMessageByParagraphs(cleanMessage);
  console.log(`📤 Sending ${chunks.length} message chunk(s) to ${phoneNumber} (task: ${taskId}, reason: ${stopReason})`);

  // Send each chunk as a separate message
  const messageGuids: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    // Show typing indicator before each chunk (except first)
    if (i > 0) {
      await sendTypingIndicator(phoneNumber, 500);
    }
    
    // Send the message chunk
    const messageGuid = await sendIMessage(phoneNumber, chunk);
    messageGuids.push(messageGuid);
    console.log(`  ✅ Sent chunk ${i + 1}/${chunks.length} (guid: ${messageGuid})`);
    
    // Small delay between messages (except after last one)
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Handle attachments - send actual files via iMessage
  if (attachments && attachments.length > 0 && stopReason === 'finish') {
    console.log(`📎 Processing ${attachments.length} attachment(s) for ${phoneNumber}`);
    
    try {
      // Try to send attachments as actual files
      const { sendIMessageWithAttachments } = await import('../lib/imessage.js');
      
      // Show typing indicator before sending attachments
      await sendTypingIndicator(phoneNumber, 1000);
      
      // Send attachments (no text message, just files)
      const attachmentGuids = await sendIMessageWithAttachments(
        phoneNumber,
        '', // No text message, just attachments
        attachments.map((att: any) => ({
          url: att.url,
          filename: att.file_name,
          size_bytes: att.size_bytes,
        }))
      );
      
      messageGuids.push(...attachmentGuids);
      console.log(`✅ Sent ${attachmentGuids.length} attachment(s) successfully`);
    } catch (error) {
      // Fallback: If attachment sending fails, send download links as text
      console.error('❌ Failed to send attachments as files, falling back to links:', error);
      
      let fallbackMessage = `\n\n📎 Attachments (${attachments.length}):`;
      attachments.forEach((att: any, idx: number) => {
        const sizeMB = (att.size_bytes / 1024 / 1024).toFixed(2);
        fallbackMessage += `\n${idx + 1}. ${att.file_name} (${sizeMB} MB)\n   ${att.url}`;
      });
      
      // Send fallback message with links
      await sendTypingIndicator(phoneNumber, 500);
      const fallbackGuid = await sendIMessage(phoneNumber, fallbackMessage);
      messageGuids.push(fallbackGuid);
      console.log(`✅ Sent attachment links as fallback`);
    }
  }
  
  // Record as single database entry with all GUIDs (reduces DB spam)
  // Store first GUID as primary, others in a JSON array for tracking
  await prisma.manusMessage.create({
    data: {
      messageGuid: messageGuids[0], // Primary GUID for lookups
      phoneNumber,
      messageType: 'WEBHOOK',
      // Note: If you need to track all chunks, add a JSON field to schema
      // For now, we just track the first message GUID which represents the whole response
    },
  });
  
  console.log(`✅ All ${chunks.length} message chunk(s) sent successfully (tracked as 1 DB record)`);
}

// Helper function to send iMessage with retry logic
async function sendIMessage(phoneNumber: string, message: string, retries = 3): Promise<string> {
  const { sendIMessage: sendMessage } = await import('../lib/imessage.js');
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Disable rich link previews for Manus responses to ensure full message text is visible
      return await sendMessage(phoneNumber, message, { disableRichLink: true });
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

// Helper function to show typing indicator
async function sendTypingIndicator(phoneNumber: string, durationMs: number): Promise<void> {
  try {
    const { sendTypingIndicator: showTyping } = await import('../lib/imessage.js');
    await showTyping(phoneNumber, durationMs);
  } catch (error) {
    console.warn('Failed to send typing indicator:', error);
    // Non-critical - continue anyway
  }
}
