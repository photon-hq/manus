# Manus Architecture: Race Conditions & Resilience Analysis

## Executive Summary

**Separation of Services: ✅ GOOD**  
All services run independently with isolated containers and can restart without crashing others (except backend blocks worker on startup).

**Service Resilience: ⚠️ PARTIALLY ADDRESSED**  
We've fixed the critical issue (postgres/redis restart policy), but there are several remaining race conditions and resilience gaps.

**Application-Level Error Handling: ⚠️ GAPS EXIST**  
Error handling is inconsistent. Some operations have retries; others log and continue, risking cascading failures.

---

## 1. Service Separation & Isolation

### Current Architecture
```
┌─────────────┐
│   Postgres  │ (restart: unless-stopped ✅ FIXED)
└─────────────┘
       │
       ├─ Backend (depends_on postgres:healthy)
       │  └─ runs migrations
       │     └─ serves HTTP API
       │
       └─ Worker (depends_on postgres:healthy + backend:healthy ✅ NEW)
          └─ processes BullMQ jobs
          └─ sends iMessages

┌─────────────┐
│    Redis    │ (restart: unless-stopped ✅ FIXED)
└─────────────┘
       │
       ├─ Backend (depends_on redis:healthy)
       │
       └─ Worker (depends_on redis:healthy)

┌─────────────────┐
│ SLM Classifier  │ (restart: unless-stopped, NO DEPS)
└─────────────────┘
```

### Analysis

**✅ Services are isolated:**
- Each runs in its own container
- If one crashes, Docker restarts it (with `restart: unless-stopped`)
- Network isolation via custom bridge network

**⚠️ Dependency Chain Issues:**

1. **Backend Block on Worker Startup** (FIXED)
   - Worker now waits for `backend: condition: service_healthy`
   - This ensures migrations are complete before worker starts
   - Otherwise: worker queries non-existent tables → crashes

2. **SLM Classifier has no dependencies**
   - It's only called when `DETECTION_MODE=slm`
   - Backend makes HTTP calls to it
   - If SLM is down, backend gets connection errors but doesn't fail fast
   - No retry logic for SLM calls in backend code

3. **Worker → External iMessage SDK**
   - Worker depends on external iMessage server (`IMESSAGE_SERVER_URL`)
   - No healthcheck, no automatic retry with backoff
   - If SDK unavailable: worker starts but all SDK operations throw immediately

4. **Worker → External Manus API**
   - Calls `https://api.manus.im/v1/tasks` for every message
   - No retry logic; errors are caught and logged but don't cause full restart
   - Transient failures silently lose tasks

---

## 2. Identified Race Conditions

### **Race Condition #1: Backend Migration Concurrency** (LOW RISK - FIX PREVENTS THIS)
**Status:** Mostly mitigated by fix, but edge case remains

- Backend's `docker-entrypoint.sh` runs migrations sequentially
- If backend crashes during migration, next restart may find:
  - `_prisma_migrations` table exists but some migrations incomplete
  - Migration state marked as failed
- **Current handling:** The script attempts `prisma migrate resolve --rolled-back` for hardcoded migration IDs (brittle!)

**Recommendation:**
```sh
# Better: Query dynamically instead of hardcoding migration IDs
FAILED_MIGRATIONS=$(npx prisma migrate status 2>&1 | grep "Failed" | grep -oP '\d+_\w+' || true)
for migration in $FAILED_MIGRATIONS; do
  npx prisma migrate resolve --rolled-back "$migration"
done
```

---

### **Race Condition #2: Worker Startup Before SDK Ready** (MEDIUM RISK)
**Status:** Partially mitigated by async initialization

**Current code:**
```typescript
// Line 1591-1592: Fire-and-forget initialization
initializeSDK();
initializeExistingQueues();
```

**Problem:**
- `initializeSDK()` is async but not awaited
- `initializeExistingQueues()` starts immediately in parallel
- If a message arrives before SDK connects, it crashes

**Example failure sequence:**
1. Worker starts, calls `initializeSDK()` (async, not awaited)
2. `initializeExistingQueues()` runs immediately
3. `checkForNewConnections()` fires at 10s interval
4. Backend sends `connection-activated` event
5. Worker tries to `getQueue(phoneNumber)` → starts processing jobs
6. Job handler calls `await getIMessageSDK()` → still initializing
7. If SDK init fails: error is caught but typing indicator fails silently

**Recommendation:** Await SDK init before queues:
```typescript
async function startup() {
  await initializeSDK();  // Wait for SDK
  await initializeExistingQueues();
  listenForEvents();
  setInterval(checkForNewConnections, 10000);
}
startup().catch(err => {
  console.error('Critical startup failure:', err);
  process.exit(1);
});
```

---

### **Race Condition #3: Database Connection Loss During Message Processing** (MEDIUM RISK)
**Status:** Unhandled

**Current code (lines 1401-1422):**
```typescript
async function initializeExistingQueues() {
  try {
    const activeConnections = await prisma.connection.findMany({...});
    for (const conn of activeConnections) {
      getQueue(conn.phoneNumber);
    }
  } catch (error) {
    console.error('Failed to initialize existing queues:', error);
    // ⚠️ CONTINUES ANYWAY - worker still starts!
    console.log('Worker service ready and listening for messages');
  }
}
```

**Problem:**
- If `prisma.connection.findMany()` fails (e.g., postgres restarting), catch block logs and continues
- Worker starts even though no queues were initialized
- New messages arrive but no queue exists to handle them

**Similar issue in `checkForNewConnections()` (lines 1425-1443):**
```typescript
async function checkForNewConnections() {
  try {
    const activeConnections = await prisma.connection.findMany({...});
    // ...
  } catch (error) {
    console.error('Failed to check for new connections:', error);
    // ⚠️ CONTINUES - timer runs again at 10s, but silently fails if DB is down
  }
}
```

**Impact:**
- Postgres goes down temporarily
- Worker doesn't crash (good for resilience)
- But it silently stops detecting new connections for 10+ seconds
- Messages during downtime accumulate in queue but aren't processed

---

### **Race Condition #4: Stale Task Context on Worker Restart** (MEDIUM RISK)
**Status:** Partially handled

**Current code (lines 1304-1322):**
```typescript
if (response.status === 404 && errorText.includes('task not found')) {
  // Task expired on Manus side
  await prisma.connection.update({
    where: { phoneNumber },
    data: { 
      currentTaskId: null,
      currentTaskStartedAt: null,
      triggeringMessageGuid: null,
    },
  });
  return createManusTask(...);  // Create new task
}
```

**Problem:**
- If worker crashes while a task is running (but not yet marked done), next restart loads stale task
- User sends follow-up → worker appends to old task (even if Manus already finished processing)
- Result: User messages lost or duplicated

**Why it's not a race condition per se:**
- Each message processes sequentially (concurrency: 1 per user)
- But if message is processed, ack'd in BullMQ, then worker dies before DB write → message reprocessed next restart

---

### **Race Condition #5: Redis Connection Loss During Queue Operations** (LOW-MEDIUM RISK)
**Status:** Configured for resilience but could be better

**Current config (lines 65-67):**
```typescript
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,  // ⚠️ No automatic retries for individual commands
});
```

**Impact:**
- BullMQ job enqueue fails if Redis connection momentarily drops
- No automatic retry → message lost
- Error is caught but job not reattempted

**Better config:**
```typescript
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,  // Retry individual commands up to 3 times
  enableReadyCheck: true,
  enableOfflineQueue: true,  // Buffer commands while reconnecting
  retryStrategy: (times) => Math.min(times * 50, 2000),  // Exponential backoff
});
```

---

## 3. External Dependency Resilience

### Backend → iMessage Server
**Issue:** No retry logic for SDK initialization
```typescript
await imessageSDK.connect();  // ⚠️ Single attempt, no retry
```

**Recommendation:** Add retry with exponential backoff
```typescript
async function connectWithRetry(maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await imessageSDK.connect();
      return;
    } catch (err) {
      if (i === maxAttempts - 1) throw err;
      const delay = Math.min(1000 * Math.pow(2, i), 30000);
      console.log(`Retrying SDK connection in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

### Backend → SLM Classifier
**Issue:** No fallback or retry
```typescript
const response = await fetch(`${SLM_SERVICE_URL}/classify`, {...});
// If it fails, the message is misclassified or rejected
```

**Recommendation:** 
- Add timeout + retry logic
- Fallback to thread-based detection if SLM unavailable
- Circuit breaker pattern for cascading failures

### Worker → Manus API
**Issue:** Errors logged but task silently fails
```typescript
try {
  const response = await fetch(`${MANUS_API_URL}/v1/tasks`, {...});
  // ⚠️ If 500+ errors: logged but not retried
} catch (error) {
  console.error('Failed to create Manus task:', error);
  throw error;  // Caller catches and continues
}
```

**Current workaround:** BullMQ job has `attempts: 3` with exponential backoff
- Good: Jobs retry automatically
- Limitation: Doesn't help if the job is never enqueued (backend failure)

---

## 4. Summary: What's Protected vs. What's Not

### ✅ Protected (Resilient)
- **Postgres/Redis restart** — now have `restart: unless-stopped`
- **Worker dependency on backend** — waits for migrations
- **Docker healthchecks** — detect dead services
- **BullMQ job retries** — 3 attempts with exponential backoff
- **Database transaction consistency** — Prisma handles atomicity
- **Service isolation** — no cross-container process dependencies

### ⚠️ Partially Protected
- **Database unavailability** — worker doesn't crash but silently stops detecting connections
- **SDK initialization** — error logged but worker proceeds without SDK
- **Typing indicator failures** — non-critical, caught and logged
- **SLM classification** — no fallback if service unavailable

### ❌ Not Protected
- **External API failures** — no circuit breaker, no fallback strategy
- **Message loss on worker crash** — BullMQ helps but not foolproof
- **Stale task context** — handled for 404, but not for other failure modes
- **Network jitter** — no adaptive retry strategies

---

## 5. Recommendations (Priority Order)

### 🔴 High Priority (Do First)
1. **Await SDK initialization before startup**
   - File: `services/worker/src/index.ts` lines 1591-1592
   - Impact: Prevents silent SDK failures

2. **Add connection retry logic with exponential backoff**
   - File: `services/worker/src/index.ts` lines 1401-1422, 1425-1443
   - Add proper error handling: retry on DB connection errors

3. **Make failed migration migration names dynamic**
   - File: `services/backend/docker-entrypoint.sh` lines 37-43
   - Stop hardcoding migration IDs

### 🟡 Medium Priority (Do Soon)
4. **Add circuit breaker for external APIs**
   - SLM Classifier, iMessage Server, Manus API
   - Fail fast instead of hanging

5. **Improve Redis client configuration**
   - Enable retries: `maxRetriesPerRequest: 3`
   - Enable offline queue: `enableOfflineQueue: true`

6. **Add graceful shutdown handlers**
   - SIGTERM → close queues, stop typing indicators, exit cleanly
   - Prevents orphaned jobs

### 🟢 Low Priority (Nice to Have)
7. **Add metrics/observability**
   - Track job success/failure rates
   - Alert on repeated failures

8. **Document failure scenarios**
   - What happens if X goes down?
   - Recovery procedures

---

## 6. Testing Recommendations

To verify resilience, test these scenarios:

```bash
# Test 1: Postgres fails during startup
docker-compose down postgres
docker-compose up  # Should wait, not crash
docker-compose up postgres -d  # Bring it back
# Verify: Backend completes migrations, worker starts

# Test 2: Redis fails during message processing
docker exec manus-redis redis-cli shutdown
# Send a message
# Verify: Job is retried when Redis restarts

# Test 3: Worker crashes during job processing
docker kill -9 manus-worker
# Send another message
# Verify: BullMQ marks job failed, reprocesses on worker restart

# Test 4: Backend health check fails
curl http://localhost:3000/health  # Should return 200
docker kill -9 manus-postgres-1
sleep 2
curl http://localhost:3000/health  # Should return 503
# Verify: Worker doesn't start until backend is healthy

# Test 5: SLM Classifier unavailable
docker pause manus-slm-classifier
# Send a message with DETECTION_MODE=slm
# Verify: Timeout/failure is handled gracefully
```

---

## 7. Implementation Plan

### Phase 1 (This Sprint)
- [ ] Await SDK initialization
- [ ] Add connection retry logic
- [ ] Make migrations dynamic

### Phase 2 (Next Sprint)
- [ ] Add circuit breaker for external APIs
- [ ] Improve Redis config
- [ ] Add graceful shutdown

### Phase 3 (Future)
- [ ] Observability & metrics
- [ ] Documentation & runbooks
