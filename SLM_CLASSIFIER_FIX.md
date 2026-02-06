# SLM Classifier Fix: Task Context Filtering

## Problem

The SLM classifier was creating a new task on every request because it was receiving **all recent messages** from the conversation history, including messages from previous completed tasks. This made it impossible for the SLM to distinguish between:
- Follow-up messages for the current task
- New task requests after a previous task completed

## Root Cause

In `services/worker/src/index.ts`, the `getRecentMessages()` function was fetching the last 20 messages from the entire conversation without filtering by task boundaries:

```typescript
// OLD CODE - fetched ALL recent messages
const messages = await sdk.messages.getMessages({
  chatGuid,
  limit: 20,
  sort: 'DESC',
});
```

When the SLM classifier received this context, it would see:
- Messages from Task 1 (completed)
- Messages from Task 2 (completed)
- New incoming message

The SLM couldn't tell that Tasks 1 and 2 were finished, so it would sometimes classify the new message as a follow-up to an old task.

## Solution

We now track **when each task starts** and only pass messages from the current active task to the SLM classifier:

### 1. Database Schema Change

Added `currentTaskStartedAt` field to the `Connection` model:

```prisma
model Connection {
  // ... existing fields
  currentTaskId String?
  currentTaskStartedAt DateTime? // NEW: Track when current task started
  // ... rest of fields
}
```

### 2. Store Task Start Time

When creating a new task in `createManusTask()`:

```typescript
const taskStartTime = new Date();
await prisma.connection.update({
  where: { phoneNumber },
  data: { 
    currentTaskId: data.task_id,
    currentTaskStartedAt: taskStartTime, // NEW
  },
});
```

### 3. Filter Messages by Task

Updated `getRecentMessages()` to only return messages from the current task:

```typescript
// If no active task, return empty context (indicates NEW_TASK)
if (!connection?.currentTaskId || !connection?.currentTaskStartedAt) {
  return [];
}

// Filter messages after task start time
const taskStartTime = connection.currentTaskStartedAt.getTime();
const filteredMessages = messages.filter((msg) => {
  const messageTime = new Date(msg.dateCreated).getTime();
  return messageTime >= taskStartTime && !guidSet.has(msg.guid);
});
```

### 4. Clear Context on Task Completion

When a task finishes or is stopped, we clear the task context:

**In webhooks.ts** (when task finishes):
```typescript
if (stopReason === 'finish') {
  await prisma.connection.updateMany({
    where: { currentTaskId: taskId },
    data: { 
      currentTaskId: null,
      currentTaskStartedAt: null, // NEW
    },
  });
}
```

**In worker index.ts** (when task-stopped event received):
```typescript
await prisma.connection.update({
  where: { phoneNumber },
  data: { 
    currentTaskId: null,
    currentTaskStartedAt: null, // NEW
  },
});
```

## What the SLM Now Receives

### Scenario 1: First message (no active task)
- `last_task_context`: `[]` (empty)
- **Result**: SLM classifies as `NEW_TASK` ✅

### Scenario 2: Follow-up during active task
- `last_task_context`: Messages from current task only
- **Result**: SLM can see the ongoing conversation and classify as `FOLLOW_UP` ✅

### Scenario 3: New message after task completes
- `last_task_context`: `[]` (empty, because task context was cleared)
- **Result**: SLM classifies as `NEW_TASK` ✅

## Migration

A new database migration was created:
- `packages/database/prisma/migrations/20260206000000_add_task_started_at/migration.sql`

This adds the `currentTaskStartedAt` column to the `connections` table.

To apply in production:
```bash
cd packages/database
npx prisma migrate deploy
```

## Testing

To verify the fix works:

1. Send a new task request → Should create a new task
2. Send a follow-up message → Should append to existing task
3. Wait for task to complete
4. Send another message → Should create a NEW task (not append to old one)

## Files Changed

1. `packages/database/prisma/schema.prisma` - Added `currentTaskStartedAt` field
2. `services/worker/src/index.ts` - Updated logic to filter messages by task and store/clear task start time
3. `services/backend/src/routes/webhooks.ts` - Clear task start time on completion
4. `packages/database/prisma/migrations/20260206000000_add_task_started_at/migration.sql` - Database migration
5. `packages/database/tsconfig.json` - Added `composite: true` for project references
6. `packages/shared/tsconfig.json` - Added `composite: true` for project references

## Build Status

✅ All TypeScript compilation errors fixed
✅ Worker service compiled successfully  
✅ No type errors related to `currentTaskStartedAt`
✅ Prisma client regenerated with new schema
✅ All linter errors resolved
