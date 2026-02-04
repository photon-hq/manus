# iMessage Webhook Response Fixes

## Summary

This document outlines the fixes implemented to ensure task completion responses are reliably sent back to iMessage users.

## Changes Made

### 1. Clear currentTaskId on Task Completion ✅ (Critical)

**File:** `services/backend/src/routes/webhooks.ts` (lines 163-169)

**Problem:** When tasks completed with `stop_reason: 'finish'`, the `currentTaskId` was not cleared from the connection record. This caused follow-up messages to be incorrectly appended to completed tasks.

**Fix:**
```typescript
// Clear currentTaskId from connection when task finishes successfully
if (stopReason === 'finish') {
  await prisma.connection.updateMany({
    where: { currentTaskId: taskId },
    data: { currentTaskId: null },
  });
}
```

**Impact:** Follow-up messages will now correctly create new tasks instead of appending to finished ones.

---

### 2. Fix Progress Throttling Key ✅ (Important)

**File:** `services/backend/src/routes/webhooks.ts` (lines 117-119, 148)

**Problem:** Progress updates were throttled per phone number, causing multiple concurrent tasks from the same user to share the same throttle window.

**Fix:**
```typescript
// Use task-specific key so multiple concurrent tasks don't interfere
const throttleKey = `${phoneNumber}:${taskId}`;
const lastSent = progressTimestamps.get(throttleKey) || 0;
// ...
progressTimestamps.set(throttleKey, now);
```

**Impact:** Each task now has independent progress throttling, allowing users to receive updates for multiple concurrent tasks.

---

### 3. Add Retry Logic for iMessage Sends ✅ (Reliability)

**File:** `services/backend/src/routes/webhooks.ts` (lines 220-244)

**Problem:** Failed `sendIMessage()` calls were logged but not retried, causing transient network failures to lose completion notifications.

**Fix:**
```typescript
async function sendIMessage(phoneNumber: string, message: string, retries = 3): Promise<string> {
  const { sendIMessage: sendMessage } = await import('../lib/imessage.js');
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await sendMessage(phoneNumber, message);
    } catch (error) {
      console.error(`❌ Failed to send iMessage (attempt ${attempt}/${retries}):`, error);
      
      if (attempt === retries) {
        console.error('❌ All retry attempts exhausted for iMessage send');
        throw error;
      }
      
      // Wait before retrying (exponential backoff: 1s, 2s, 4s)
      const delayMs = Math.pow(2, attempt - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  throw new Error('Unexpected error in sendIMessage');
}
```

**Impact:** Transient network failures will be automatically retried with exponential backoff (1s, 2s, 4s), improving message delivery reliability.

---

### 4. Enhanced Webhook Authentication Logging ✅ (Debugging)

**File:** `services/backend/src/routes/webhooks.ts` (lines 35-36, 47-48)

**Problem:** Webhook authentication failures had minimal logging, making it difficult to diagnose issues.

**Fix:**
```typescript
if (!authHeader || !authHeader.startsWith('Bearer ')) {
  fastify.log.warn('Webhook authentication failed: Missing or invalid Authorization header');
  return reply.code(401).send({ error: 'Unauthorized' });
}

if (!connection) {
  fastify.log.warn({ manusApiKey: manusApiKey.substring(0, 10) + '...' }, 'Webhook authentication failed: No active connection found for API key');
  return reply.code(401).send({ error: 'Unauthorized' });
}
```

**Impact:** Authentication failures now log detailed warnings to help diagnose webhook delivery issues.

---

### 5. Success Logging for Message Delivery ✅ (Monitoring)

**File:** `services/backend/src/routes/webhooks.ts` (lines 90, 136, 208)

**Problem:** No visibility into successful message deliveries, making it hard to confirm webhooks are working.

**Fix:** Added success logging in all three handlers:
```typescript
// Task Created
console.log(`✅ Task created notification sent to ${phoneNumber} (task: ${taskId})`);

// Progress Update
console.log(`✅ Progress update sent to ${phoneNumber} (task: ${taskId})`);

// Task Stopped
console.log(`✅ Task completion notification sent to ${phoneNumber} (task: ${taskId}, reason: ${stopReason})`);
```

**Impact:** Backend logs now clearly show when messages are successfully sent, making it easy to verify the webhook flow is working.

---

## Verification Checklist

To verify the fixes are working:

### 1. Check Webhook Registration
```sql
SELECT "webhookId", "manusApiKey", "phoneNumber", "status" 
FROM connections 
WHERE status = 'ACTIVE';
```
- Verify `webhookId` is not null (if null, webhooks won't be delivered)

### 2. Test Task Flow
1. Send a message to create a task: "Research the history of pizza"
2. Monitor backend logs for:
   - ✅ Webhook received
   - ✅ Task created notification sent
   - ✅ Task completion notification sent
3. Check iMessage for completion response

### 3. Monitor Logs
```bash
# Backend logs
docker logs -f manus-backend | grep -E "Webhook|Task|iMessage"

# Worker logs
docker logs -f manus-worker | grep -E "task|manus"
```

### 4. Test Multiple Concurrent Tasks
1. Send two tasks quickly: "Task 1" and "Task 2"
2. Verify both receive progress updates independently
3. Verify both receive completion notifications

---

## Expected Behavior

### Before Fixes:
- ❌ Task completions not sent back to iMessage
- ❌ currentTaskId never cleared, causing task confusion
- ❌ Multiple tasks share throttle window
- ❌ Network failures lose messages permanently
- ❌ Minimal logging makes debugging hard

### After Fixes:
- ✅ Task completions reliably sent to iMessage
- ✅ currentTaskId cleared on finish, enabling new tasks
- ✅ Each task has independent progress throttling
- ✅ Network failures automatically retried with backoff
- ✅ Comprehensive logging for monitoring and debugging

---

## Architecture Overview

```
User (iMessage)
    │
    ▼
Backend (/webhook endpoint)
    │
    ├─ Authenticate (Bearer token)
    ├─ Route by event_type
    │
    ├─ task_created → handleTaskCreated()
    ├─ task_progress → handleTaskProgress() [throttled per task]
    └─ task_stopped → handleTaskStopped() [clears currentTaskId]
         │
         ▼
    sendIMessage() [3 retries with backoff]
         │
         ▼
    Photon iMessage SDK
         │
         ▼
    User (iMessage) ✅
```

---

## Troubleshooting

### Issue: Still not receiving responses

1. **Check PUBLIC_URL accessibility**
   ```bash
   curl https://manus.photon.codes/health
   ```
   - Must return 200 OK from external networks

2. **Verify webhook registration**
   - Visit: https://manus.im/app?show_settings=integrations&app_name=api
   - Check if webhook URL matches your PUBLIC_URL

3. **Check backend logs for authentication errors**
   ```bash
   docker logs manus-backend | grep "401\|Unauthorized"
   ```

4. **Test webhook endpoint manually**
   ```bash
   curl -X POST https://manus.photon.codes/webhook \
     -H "Authorization: Bearer YOUR_MANUS_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"event_type":"task_stopped","event_id":"test","task_detail":{"task_id":"test","stop_reason":"finish","task_title":"Test Task","message":"Test complete"}}'
   ```

### Issue: Webhooks arrive but messages not sent

1. **Check iMessage SDK connection**
   ```bash
   docker logs manus-backend | grep "iMessage"
   ```
   - Should see: "✅ Connected to Photon iMessage infrastructure"

2. **Check for iMessage send errors**
   ```bash
   docker logs manus-backend | grep "Failed to send iMessage"
   ```

3. **Verify connection status in database**
   ```sql
   SELECT * FROM connections WHERE "phoneNumber" = '+1234567890';
   ```
   - Status should be 'ACTIVE'
   - manusApiKey should not be null

---

## Next Steps

The webhook infrastructure is now robust and production-ready. Future enhancements could include:

1. **Webhook signature verification** - Add RSA signature validation for additional security
2. **Message filtering** - Allow users to customize which webhook events trigger notifications
3. **Attachment downloads** - Automatically download and send files instead of just links
4. **Webhook delivery tracking** - Store webhook delivery status in database for analytics

---

Generated: 2026-02-04
