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
  NEW_TASK = 'NEW_TASK',               // Start a new Manus task
  FOLLOW_UP = 'FOLLOW_UP',             // Continue existing task
  REVOKE = 'REVOKE',                   // Disconnect/revoke access
  GENERAL_QUESTION = 'GENERAL_QUESTION', // All other questions (API key, status, help, etc.) - answered by AI
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
  REVOKE_CONFIRM: [
    "This will disconnect and delete all your data.",
    "Reply \"YES REVOKE\" to confirm.",
  ],
  
  // Onboarding messages for new users (multi-part)
  ONBOARDING: [
    "Hey! Welcome to Manus on iMessage",
    "Manus is a powerful AI agent that can browse the web, write code, analyze data, and handle complex tasks - all through text.",
    "You get 3 free tasks. After that, add your API key to continue.",
    "Just text me what you need!",
  ],
};
