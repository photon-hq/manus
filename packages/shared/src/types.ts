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

// Task Classification
export enum TaskClassification {
  NEW_TASK = 'NEW_TASK',
  FOLLOW_UP = 'FOLLOW_UP',
}

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
  type: z.nativeEnum(TaskClassification),
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
  }).optional(),
});

// Types
export type Connection = z.infer<typeof ConnectionSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ClassificationRequest = z.infer<typeof ClassificationRequestSchema>;
export type ClassificationResponse = z.infer<typeof ClassificationResponseSchema>;
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
