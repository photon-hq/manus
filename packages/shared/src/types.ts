import { z } from 'zod';

// Connection Status
export enum ConnectionStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

// Message Type
export enum MessageType {
  SCHEDULED = 'SCHEDULED',
  WEBHOOK = 'WEBHOOK',
  MANUAL = 'MANUAL',
}

// Queue Status
export enum QueueStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

// Message Intent - Agentic Router Classification
export enum MessageIntent {
  NEW_TASK = 'NEW_TASK',           // Start a new Manus task
  FOLLOW_UP = 'FOLLOW_UP',         // Continue existing task
  API_KEY_HELP = 'API_KEY_HELP',   // Questions about API key setup/instructions
  STATUS_CHECK = 'STATUS_CHECK',   // Check connection status
  HELP_REQUEST = 'HELP_REQUEST',   // General help/commands list
  REVOKE = 'REVOKE',               // Disconnect/revoke access
  GENERAL_INFO = 'GENERAL_INFO',   // General questions (about photon, how it works, etc.)
}

// Legacy alias for backwards compatibility
export const TaskClassification = MessageIntent;

// Schemas
export const ConnectionSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string(),
  phoneNumber: z.string(),
  manusApiKey: z.string().optional(),
  photonApiKey: z.string().optional(),
  webhookId: z.string().optional(),
  status: z.nativeEnum(ConnectionStatus),
  createdAt: z.date(),
  expiresAt: z.date().optional(),
  activatedAt: z.date().optional(),
  revokedAt: z.date().optional(),
});

export const MessageSchema = z.object({
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  guid: z.string().optional(),
});

export const ClassificationRequestSchema = z.object({
  latest_message: z.string(),
  last_task_context: z.array(MessageSchema),
});

export const ClassificationResponseSchema = z.object({
  intent: z.nativeEnum(MessageIntent),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(), // Brief explanation for debugging
});

// Legacy schema for backwards compatibility
export const LegacyClassificationResponseSchema = z.object({
  type: z.nativeEnum(MessageIntent),
  confidence: z.number().min(0).max(1),
});

export const WebhookEventSchema = z.object({
  event_id: z.string(),
  event_type: z.enum(['task_created', 'task_progress', 'task_stopped']),
  task_detail: z.object({
    task_id: z.string(),
    task_title: z.string().optional(),
    task_url: z.string().optional(),
    message: z.string().optional(),
    attachments: z.array(z.any()).optional(),
    stop_reason: z.enum(['finish', 'ask']).optional(),
  }).optional(),
  progress_detail: z.object({
    task_id: z.string(),
    progress_type: z.string(),
    message: z.string(),
    description: z.string().optional(), // Task step description (more detailed than message)
    timestamp: z.number().optional(),
  }).optional(),
});

// Types
export type Connection = z.infer<typeof ConnectionSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ClassificationRequest = z.infer<typeof ClassificationRequestSchema>;
export type ClassificationResponse = z.infer<typeof ClassificationResponseSchema>;
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

// Pre-defined responses for non-task intents
export const INTENT_RESPONSES: Record<string, string | string[]> = {
  API_KEY_HELP: [
    "To add your Manus API key:",
    "Go to: https://manus.im/app#settings/integrations/api",
    "Copy your API key and paste it here in this chat.",
  ],
  
  API_KEY_HELP_ALREADY_CONNECTED: [
    "You already have an API key connected.",
    "To update it, just paste your new key here and I'll replace the old one.",
  ],
  
  HELP_REQUEST: [
    "Here's what I can do:",
    "Just message me normally and I'll help you with anything - browsing, coding, research, and more.",
    "Commands:\n• \"help\" - Show this message\n• \"status\" - Check your connection & usage\n• \"add key\" - Add or update your Manus API key\n• \"revoke\" - Disconnect and delete all data",
  ],

  REVOKE_CONFIRM: [
    "This will disconnect and delete all your data.",
    "Reply \"YES REVOKE\" to confirm.",
  ],
  
  GENERAL_INFO: [
    "Photon connects Manus to iMessage.",
    "It lets you use Manus's AI capabilities directly from your Messages app - no apps to install, just text me what you need!",
    "Here's how it works:\n1. You send me a message with what you need\n2. I route it to Manus (a powerful AI agent)\n3. Manus works on your task and sends back results",
  ],
};
