# iMessage Backend System - Complete Design Document

## Overview
Build a backend system that integrates user's iMessage with Manus AI, enabling bidirectional communication and task management through iMessage. The system includes an MCP server component that exposes tools to Manus, along with connection management, message routing, and task classification services.

---

## 1. iMessage Integration ✅

**Solution:** Use existing custom iMessage infrastructure
- Backend already has iMessage endpoint and API key configured
- Photon key in DB is sufficient for routing
- Backend handles all iMessage send/receive operations

---

## 2. MCP SDK ✅

**Decision:** Use official `@modelcontextprotocol/sdk`
- Standard implementation
- Handles protocol details
- Lightweight

---

## 3. Database Schema ✅

### Connection Table
```
uuid              (generated on first message sent)
phone_number      (captured on first message sent)
manus_api_key     (set when user inputs token)
photon_api_key    (generated when user inputs manus token)
status            "PENDING" | "ACTIVE" | "REVOKED"
created_at        timestamp
expires_at        timestamp (5 minutes for pending connections)
```

**Fill Order During Connection Flow:**
1. `uuid` - triggered on first message sent
2. `phone_number` - triggered on first message sent  
3. `manus_api_key` - triggered when user adds manus token
4. `photon_api_key` - triggered when user adds manus token

### User Identification
- **Manus identifies users:** Through Photon API key only
- **MCP server enforces:** One key → one phone
- **Privacy:** Manus never sees raw phone numbers

---

## 4. Connection Setup Flow ✅

### Step 1: Initial Landing Page
- User visits: `GET /manus/connect`
- Page shows: "Connect my Manus"
- Button triggers: Opens iMessage with pre-filled message

### Step 2: iMessage Trigger
```
sms:+PHOTON_NUMBER&body=Hey! Please connect my iMessage to Manus
```
- Opens user's Messages app
- Pre-fills message to Photon number
- User sends message

### Step 3: Backend Processing
- Receives message from user
- Generates `uuid` and captures `phone_number`
- Creates connection record with status `PENDING`
- Sets `expires_at` = current_time + 5 minutes
- Generates `connection_id`

### Step 4: Photon Response
Photon sends iMessage to user:
```
Sure! Please input your Manus token in the following link:
https://photon.ai/manus/connect/{connection_id}
```

### Step 5: Token Input Page
- User clicks link → opens webpage
- Page shows: "Input your Manus API key"
- Input field + Submit button

### Step 6: Token Submission
On submit:
- Validate Manus token format
- **Auto-register webhook via Manus API:**
  ```javascript
  await fetch('https://api.manus.im/v1/webhooks', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${user_manus_api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url: 'https://photon.ai/api/webhooks/manus',
      events: ['task_created', 'task_progress', 'task_stopped']
    })
  });
  ```
- Generate `photon_api_key` (format: `photon_sk_xxx`)
- Update connection record:
  - `manus_api_key` = user input
  - `photon_api_key` = generated key
  - `status` = "ACTIVE"
  - `webhook_id` = response from Manus webhook registration
- Store binding in database

**User Experience:** No manual webhook setup needed - we handle it automatically!

### Step 7: Success Response
**Two-way confirmation:**

1. **Redirect to success page:**
```
You're all set! 🎉
Add this MCP config to Manus:

{
  "mcpServers": {
    "photon-imessage": {
      "command": "npx",
      "args": ["@photon-ai/manus-mcp@latest"],
      "env": {
        "PHOTON_API_KEY": "photon_sk_xxx"
      }
    }
  }
}
```

2. **Send iMessage to user:**
Same MCP config for easy copy-paste

### Edge Cases

**User never completes flow:**
- Connection expires after 5 minutes
- Clean up pending connections via cron job

**User texts Photon without connecting first:**
- Prompt them to connect
- Send: "Please connect first: https://photon.ai/manus/connect"

**Multiple devices:**
- One phone number = one Manus account (enforced)

---

## 5. Backend System Architecture ✅

### MCP Server Component
- **Part of backend system** (Docker container)
- Not on user's machine
- User only needs to add MCP config to Manus
- Exposes tools that Manus can call

### Configuration
MCP server setup only requires:
- `PHOTON_API_KEY` (all other bindings in database)

### Tools Exposed

#### Tool 1: `fetch`
**Purpose:** Fetch conversation history for SLM context

**Parameters:** None (uses photon_api_key from env)

**Logic:**
1. Resolve photon_api_key → phone_number from database
2. Fetch last 100 messages between:
   - User's phone number
   - Photon's number
3. **Filter out:**
   - Messages with `[sent_by_mcp]` metadata/flag
   - Scheduled messages from Manus web
   - Web-agent pushes
4. Return filtered message history

**Response:**
```json
{
  "messages": [
    {
      "from": "+91XXXXXXXXXX",
      "to": "+PHOTON_NUMBER",
      "text": "message content",
      "timestamp": "2026-02-02T10:30:00Z"
    }
  ]
}
```

#### Tool 2: `send`
**Purpose:** Send message from Photon to user

**Parameters:**
```json
{
  "message": "string"
}
```

**Logic:**
1. Resolve photon_api_key → phone_number from database
2. Send message from Photon number to user's phone
3. Tag message with `[sent_by_mcp]` metadata

**Constraints:**
- Always: From Photon number → To bound phone number
- No character limit (removed)
- Text only (no images/attachments for now)

---

## 6. Message Processing Strategy ✅

### Core Principle: Process Every User Message Intelligently

**User → Manus:** Process ALL user messages (can't ignore - bad UX)
**Manus → User:** Send SELECTIVE webhook-driven updates (avoid spam)

---

### A. User Message Processing (iMessage → Manus)

#### Message Queue System
- Queue messages per phone number
- Process sequentially per user (prevents race conditions)
- Async between different users (parallel processing)

#### Debouncing Rapid Messages
```javascript
const DEBOUNCE_WINDOW = 2000; // 2 seconds

// If user sends multiple messages within 2 seconds, combine them
if (timeSinceLastMessage < DEBOUNCE_WINDOW) {
  combinedMessage += "\n" + newMessage;
  resetDebounceTimer();
} else {
  processMessage(combinedMessage);
}
```

**Why:** User might send:
```
"Hey can you"
"research AI trends"
"from 2024"
```
Combine into one: "Hey can you research AI trends from 2024"

#### Processing Flow
```
User sends iMessage
    ↓
Filter check (skip [Manus] messages)
    ↓
Add to queue (per phone number)
    ↓
Debounce (2 sec wait)
    ↓
SLM Classification
    ↓
├─ NEW_TASK → Create new Manus task via API
└─ FOLLOW_UP → Reply to existing task
```

---

### B. SLM Task Classification

#### Purpose
Determine if incoming message is a new task or follow-up to existing task

#### Model
- Use: `gpt-4.1-nano`, `gemini-2.5-flash`, or OpenRouter
- **Use `agent_stream` instead of `generate`** (faster)

#### Context Window
- Pass entire last task message history
- **Exclude:** Messages with `[Manus]` prefix
- No summaries (avoid overhead, keep it fast)

#### Deployment
- Docker / Dokploy
- Separate service from MCP server

#### Logic Flow
```javascript
// SLM receives
{
  "latest_message": "user's new message",
  "last_task_context": [...] // all messages from last task
}

// SLM returns
{
  "type": "FOLLOW_UP" | "NEW_TASK"
}

// Backend handles
if (type === "FOLLOW_UP") {
  append_to_task_context()
} else {
  create_new_manus_task()
  mark_previous_task_as_completed()
}
```

---

### C. Webhook-Driven Notifications (Manus → User)

#### Event 1: task_created
**When:** Task starts
**Action:** ALWAYS send confirmation

```
[Manus] Got it! Working on: "Research AI trends"
```

**Why:** Immediate feedback that task started

---

#### Event 2: task_progress
**When:** Task updates its plan (multiple times)
**Action:** Send SELECTIVELY (avoid spam)

**Throttling Rules:**
- Skip if task duration < 2 minutes (short tasks)
- Max 1 update per minute
- Only send meaningful milestones

```javascript
const lastProgressSent = getLastProgressTime(phoneNumber);
const MIN_PROGRESS_INTERVAL = 60000; // 1 minute

if (Date.now() - lastProgressSent < MIN_PROGRESS_INTERVAL) {
  return; // Skip
}

if (taskDuration < 120000) { // 2 minutes
  return; // Skip for short tasks
}

// Send progress update
await sendMessage({
  message: "[Manus] 🔄 Still working on your research...\nCurrent step: Analyzing 50 research papers"
});
```

---

#### Event 3: task_stopped (stop_reason: "finish")
**When:** Task completes successfully
**Action:** ALWAYS send results

```
[Manus] ✅ Task complete: "Research AI trends"

Here's what I found:
- Key trend 1: ...
- Key trend 2: ...

Full report: https://manus.im/app/task_abc123
```

**Include:**
- Summary of results
- Key findings (if short enough)
- Link to full task
- Attachments (if any)

---

#### Event 4: task_stopped (stop_reason: "ask")
**When:** Task needs user input
**Action:** ALWAYS send - CRITICAL

```
[Manus] ❓ I need your input:

Which restaurant do you prefer?
1) Bistro Milano - 7:00 PM
2) Garden Terrace - 7:30 PM
3) The Blue Door - 8:00 PM

Reply with the number.
```

**Why critical:** Task is blocked waiting for user response

---

### D. Edge Cases Handled

**User sends 10 messages rapidly:**
→ Debounce combines them, SLM processes once

**Task takes 30 minutes:**
→ Send progress updates every minute (throttled)

**Task needs input but user doesn't respond:**
→ Send reminder after 10 minutes
→ Optional: Timeout and mark task as "waiting"

**User texts while task is running:**
→ SLM determines if related (FOLLOW_UP) or new (NEW_TASK)
→ If FOLLOW_UP: adds context to running task
→ If NEW_TASK: creates new task (previous auto-completes)

**Webhook fails to deliver:**
→ Retry logic (3 attempts)
→ Store webhook delivery status
→ Fallback: User can check Manus web

---

## 7. Message Filtering ✅

### Flagging System
**Option 1:** Metadata flag
```json
{
  "message_id": "msg_123",
  "metadata": {
    "sent_by_mcp": true
  }
}
```

**Option 2:** Message prefix/suffix
```
[MCP] Your task is complete!
```

**Decision:** Use metadata (cleaner, doesn't pollute message content)

### Who Sends Flagged Messages?
- Scheduled messages from Manus web
- Web-agent pushes (task notifications, reminders)
- Any automated Manus communication

### Filtering Logic
When fetching for SLM:
```javascript
messages.filter(msg => !msg.metadata?.sent_by_mcp)
```

---

## 8. Photon API Key Generation ✅

### Generation
- Backend service generates on token submission
- Format: `photon_sk_xxx`
- Random, unique, cryptographically secure

### Storage
Database stores:
```
photon_api_key → phone_number → manus_api_key
```

### Revocation
**Two methods to disconnect:**

1. **Via iMessage:**
   - User texts: "disconnect manus"
   - Backend detects keyword
   - Deletes webhook via Manus API
   - Invalidates photon_api_key
   - Updates status to "REVOKED"

2. **Via Manus Web:**
   - User clicks disconnect in connector settings
   - Calls Photon API to revoke key
   - Backend deletes webhook via Manus API
   - Updates status to "REVOKED"

**Webhook Cleanup:**
```javascript
// On revocation
await fetch(`https://api.manus.im/v1/webhooks/${webhook_id}`, {
  method: 'DELETE',
  headers: {
    'Authorization': `Bearer ${user_manus_api_key}`
  }
});
```

**Where is revocation logic?**
- Backend service (not MCP server)
- MCP server just validates key on each request

---

## 9. Task State Management ✅

### Task Model (Optional - TBD)
```json
{
  "id": "string",
  "phone_number": "string",
  "status": "ACTIVE" | "COMPLETED",
  "summary": "string",
  "last_updated": "timestamp"
}
```

### State Updates
- **Who updates:** Backend service
- **When:** SLM determines new task → mark previous as COMPLETED

### Active Task Tracking
- Maintain one active task per phone number
- When new task created → previous auto-completes

### Open Question
- Do we actually need task state storage?
- Or just rely on SLM + message history?
- **TBD:** Evaluate if state management adds value

---

## 10. Manus Webhooks Integration ✅

### Reference
https://open.manus.im/docs/webhooks#custom-dashboard-updates

### Use Case
For messages sent from Manus web agent to iMessage:
- Use webhooks to trigger iMessage sends
- Tag with `[sent_by_mcp]` metadata
- Enables scheduled tasks, reminders, notifications

### Flow
```
Manus Task Completed
  ↓
Webhook triggered
  ↓
Backend receives webhook
  ↓
Send iMessage to user (via Photon)
  ↓
Tag with [sent_by_mcp]
```

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         User (iMessage)                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────┐
│              Custom iMessage Infrastructure                  │
│              (existing endpoint + API key)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                    Photon Backend Service                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Database:                                            │   │
│  │ - uuid, phone_number, manus_api_key, photon_api_key │   │
│  │ - Connection status, timestamps                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  - Connection setup flow                                    │
│  - API key generation & validation                          │
│  - Message routing & filtering                              │
│  - Webhook handling (from Manus)                            │
└──────────────────┬───────────────────────┬───────────────────┘
                   │                       │
                   ↓                       ↓
    ┌──────────────────────┐   ┌──────────────────────┐
    │   MCP Server         │   │   SLM Service        │
    │   (Docker)           │   │   (Docker/Dokploy)   │
    │                      │   │                      │
    │ Tools:               │   │ - Task classifier    │
    │ - fetch (0 params)   │   │ - agent_stream       │
    │ - send (message)     │   │ - Fast inference     │
    └──────────┬───────────┘   └──────────────────────┘
               │
               ↓
    ┌──────────────────────┐
    │     Manus AI         │
    │                      │
    │ - Uses MCP tools     │
    │ - Never sees phone # │
    │ - Only has photon key│
    └──────────────────────┘
```

---

### Environment Variables

### Photon Backend
```env
IMESSAGE_API_KEY=xxx
IMESSAGE_ENDPOINT=https://...
DATABASE_URL=postgresql://...
# Note: Uses user's Manus API token for webhook validation, not a separate secret
```
### MCP Server
```env
PHOTON_API_KEY=photon_sk_xxx  # Set by user in Manus
```

### SLM Service
```env
OPENROUTER_API_KEY=xxx  # or other LLM provider
PHOTON_BACKEND_URL=https://...
LLM_MODEL=gpt-4.1-nano  # or gemini-2.5-flash
```

---

## Resolved Design Decisions

### 1. Task State Management ✅
**Decision:** Rely on SLM only, no persistent task storage
- Simpler architecture
- SLM determines new task vs follow-up based on message history
- Backend marks previous task as completed when new task created
- No need for complex state management

### 2. SLM Execution Mode ✅
**Decision:** Async between users, sequential per user
- Different users: Process messages in parallel (async)
- Same user: Process messages one after another (sequential)
- **Benefit:** Reduces errors from race conditions
- **Implementation:** Message queue per phone number

### 3. Message Filtering ✅
**Decision:** Database tracking + `[Manus]` prefix (dual-layer approach)

**Why this approach:**
- `advanced-imessage-kit` doesn't support custom metadata
- Database tracking provides reliability
- Visible prefix provides transparency and trust
- Professional for pitching to Manus AI
- Easy to filter programmatically

**Implementation:**
```javascript
// When sending from Manus
await sdk.messages.sendMessage({
  chatGuid: chatGuid,
  message: "[Manus] Your task is complete! Here's what I found..."
})

// Store in database
await db.manus_messages.insert({
  message_guid: response.guid,
  phone_number: phoneNumber,
  sent_at: new Date()
})

// When fetching for SLM
const messages = await sdk.messages.getMessages({...})
const userMessages = messages.filter(msg => 
  !msg.text.startsWith('[Manus]') && 
  !isInManusDatabase(msg.guid)
)
```

**Database Schema:**
```sql
CREATE TABLE manus_messages (
  message_guid VARCHAR(255) PRIMARY KEY,
  phone_number VARCHAR(20),
  message_type VARCHAR(50), -- 'scheduled', 'webhook', 'manual'
  sent_at TIMESTAMP
);
```

### 4. Connection ID ✅
**Decision:** Persist after setup

**Pros of persisting:**
- Audit trail for connections
- Can track when user connected
- Useful for debugging connection issues
- Can show connection history in admin panel

**Cons of discarding:**
- Saves minimal storage
- No historical record

**Recommendation:** Persist - the benefits outweigh the minimal storage cost

### 5. Phone Number Storage ✅
**Decision:** Store in Photon backend database (no third-party)
- All data stays in our infrastructure
- Better privacy control
- Simpler architecture

---

## API Contracts

### REST Endpoints

#### Connection Management

**POST /api/connect/initiate**
- Receives initial iMessage from user
- Creates connection record
- Returns connection_id

**POST /api/connect/submit-token**
```json
{
  "connection_id": "conn_xxx",
  "manus_api_key": "manus_sk_xxx"
}
```
Response:
```json
{
  "success": true,
  "photon_api_key": "photon_sk_xxx",
  "mcp_config": {...}
}
```

**POST /api/connect/revoke**
```json
{
  "photon_api_key": "photon_sk_xxx"
}
```

#### MCP Tool Endpoints (called by MCP server)

**GET /api/mcp/fetch**
Headers: `Authorization: Bearer photon_sk_xxx`
Response:
```json
{
  "messages": [
    {
      "from": "+91XXXXXXXXXX",
      "to": "+PHOTON_NUMBER",
      "text": "message content",
      "timestamp": "2026-02-02T10:30:00Z",
      "guid": "msg_xxx"
    }
  ]
}
```

**POST /api/mcp/send**
Headers: `Authorization: Bearer photon_sk_xxx`
```json
{
  "message": "Your task is complete!"
}
```

#### Webhook Receiver (from Manus)

**POST /api/webhooks/manus**
Headers: `Authorization: Bearer <user's manus_api_key>`

**Event 1: task_created**
```json
{
  "event_id": "task_created_task_abc123",
  "event_type": "task_created",
  "task_detail": {
    "task_id": "task_abc123",
    "task_title": "Research AI trends",
    "task_url": "https://manus.im/app/task_abc123"
  }
}
```
Action: Send confirmation to user

**Event 2: task_progress**
```json
{
  "event_id": "task_progress_task_abc123_1234567890",
  "event_type": "task_progress",
  "progress_detail": {
    "task_id": "task_abc123",
    "progress_type": "plan_update",
    "message": "Analyzing research papers"
  }
}
```
Action: Send progress update (if throttle allows)

**Event 3: task_stopped**
```json
{
  "event_id": "task_stopped_task_abc123",
  "event_type": "task_stopped",
  "task_detail": {
    "task_id": "task_abc123",
    "task_title": "Research AI trends",
    "task_url": "https://manus.im/app/task_abc123",
    "message": "Here's what I found...",
    "attachments": [...],
    "stop_reason": "finish" // or "ask"
  }
}
```
Action: Send results or question to user

---

## Database Schema

### connections table
```sql
CREATE TABLE connections (
  uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id VARCHAR(50) UNIQUE,
  phone_number VARCHAR(20) NOT NULL,
  manus_api_key VARCHAR(255),
  photon_api_key VARCHAR(255) UNIQUE,
  webhook_id VARCHAR(255), -- Manus webhook ID for cleanup on revocation
  status VARCHAR(20) CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  activated_at TIMESTAMP,
  revoked_at TIMESTAMP
);

CREATE INDEX idx_phone_number ON connections(phone_number);
CREATE INDEX idx_photon_api_key ON connections(photon_api_key);
CREATE INDEX idx_status ON connections(status);
```

### manus_messages table
```sql
CREATE TABLE manus_messages (
  message_guid VARCHAR(255) PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL,
  message_type VARCHAR(50) CHECK (message_type IN ('scheduled', 'webhook', 'manual')),
  sent_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_phone_number_sent ON manus_messages(phone_number, sent_at);
```

### message_queue table (for sequential processing)
```sql
CREATE TABLE message_queue (
  id SERIAL PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL,
  message_guid VARCHAR(255) NOT NULL,
  message_text TEXT NOT NULL,
  status VARCHAR(20) CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);

CREATE INDEX idx_queue_status ON message_queue(phone_number, status, created_at);
```

---

## Implementation Roadmap

### Phase 1: Core Infrastructure (Week 1-2)
- [ ] Set up database schema
- [ ] Implement connection flow (web pages + API)
- [ ] Integrate advanced-imessage-kit
- [ ] Build API key generation service
- [ ] Create basic MCP server with fetch/send tools

### Phase 2: Message Processing (Week 2-3)
- [ ] Implement message queue system
- [ ] Build SLM classification service
- [ ] Set up message filtering logic
- [ ] Implement database tracking for Manus messages
- [ ] Add `[Manus]` prefix to outgoing messages

### Phase 3: Integration & Testing (Week 3-4)
- [ ] Webhook receiver for Manus events
- [ ] Revocation flow (iMessage + web)
- [ ] Connection expiry cleanup cron
- [ ] End-to-end testing
- [ ] Load testing for concurrent users

### Phase 4: Deployment & Monitoring (Week 4-5)
- [ ] Docker containerization
- [ ] Deploy to Dokploy
- [ ] Set up logging and monitoring
- [ ] Error tracking and alerting
- [ ] Documentation for users

### Phase 5: Polish & Launch (Week 5-6)
- [ ] User onboarding flow refinement
- [ ] Admin dashboard for monitoring
- [ ] Pitch deck for Manus AI integration
- [ ] Beta testing with select users
- [ ] Public launch
