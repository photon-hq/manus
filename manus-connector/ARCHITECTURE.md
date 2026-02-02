# System Architecture

This document describes the architecture of the iMessage MCP Integration System.

## Overview

The system consists of 4 main services that work together to enable bidirectional communication between iMessage and Manus AI:

```
┌─────────────────────────────────────────────────────────────┐
│                         User (iMessage)                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────┐
│              Custom iMessage Infrastructure                  │
│              (advanced-imessage-kit)                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                    Backend Service (Fastify)                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ • Connection management                              │   │
│  │ • API key generation                                 │   │
│  │ • Webhook handling                                   │   │
│  │ • MCP endpoints                                      │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────┬───────────────────────┬───────────────────┘
                   │                       │
                   ↓                       ↓
    ┌──────────────────────┐   ┌──────────────────────┐
    │   MCP Server         │   │   Worker Service     │
    │   (stdio protocol)   │   │   (BullMQ)           │
    │                      │   │                      │
    │ • fetch tool         │   │ • Message queue      │
    │ • send tool          │   │ • Debouncing         │
    └──────────┬───────────┘   │ • Task routing       │
               │               └──────────┬───────────┘
               │                          │
               ↓                          ↓
    ┌──────────────────────┐   ┌──────────────────────┐
    │     Manus AI         │   │  SLM Classifier      │
    │                      │   │  (Gemini Flash)      │
    │ • Task execution     │   │                      │
    │ • Sends webhooks     │   │ • NEW_TASK vs        │
    └──────────────────────┘   │   FOLLOW_UP          │
                               └──────────────────────┘
```

## Service Breakdown

### 1. Backend Service (Port 3000)

**Technology:** Fastify + TypeScript

**Responsibilities:**
- Connection setup flow (initiate → token submission → activation)
- Photon API key generation and validation
- MCP endpoint implementation (fetch/send)
- Webhook receiver for Manus events
- iMessage integration (via advanced-imessage-kit)

**Key Routes:**
- `POST /api/connect/initiate` - Start connection flow
- `POST /api/connect/submit-token` - Complete connection
- `POST /api/connect/revoke` - Revoke connection
- `GET /api/mcp/fetch` - Fetch messages (MCP tool)
- `POST /api/mcp/send` - Send message (MCP tool)
- `POST /api/webhooks/manus` - Receive Manus webhooks

**Database Tables Used:**
- `connections` - Store connection state
- `manus_messages` - Track Manus-sent messages

### 2. MCP Server (stdio)

**Technology:** @modelcontextprotocol/sdk + TypeScript

**Responsibilities:**
- Expose tools to Manus AI via MCP protocol
- Communicate with backend via HTTP
- Handle stdio transport (stdin/stdout)

**Tools Exposed:**
1. **fetch** - Fetch conversation history
   - No parameters
   - Returns filtered message list
   - Filters out [Manus] prefixed messages

2. **send** - Send message to user
   - Parameter: `message` (string)
   - Sends via backend API
   - Automatically prefixes with [Manus]

**Configuration:**
```json
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

### 3. Worker Service (Background)

**Technology:** BullMQ + Redis + TypeScript

**Responsibilities:**
- Sequential message processing per user
- Message debouncing (2-second window)
- Task classification routing
- Manus API integration

**Message Flow:**
1. Receive message from iMessage
2. Add to user-specific queue
3. Debounce (combine rapid messages)
4. Classify via SLM service
5. Route to Manus (new task or follow-up)

**Queue Structure:**
- One queue per phone number: `messages:{phoneNumber}`
- Concurrency: 1 (sequential per user)
- Parallel across different users

### 4. SLM Classifier Service (Port 3001)

**Technology:** Fastify + OpenRouter (Gemini Flash) + TypeScript

**Responsibilities:**
- Classify incoming messages
- Determine NEW_TASK vs FOLLOW_UP
- Fast inference (<500ms)

**Endpoint:**
- `POST /classify`

**Input:**
```json
{
  "latest_message": "Can you also check pricing?",
  "last_task_context": [...]
}
```

**Output:**
```json
{
  "type": "NEW_TASK" | "FOLLOW_UP",
  "confidence": 0.95
}
```

**Model:** `google/gemini-2.0-flash-exp:free`
- Fast (200-500ms)
- Free tier available
- JSON output mode

## Data Flow

### Connection Setup Flow

```
User → iMessage → Backend
                    ↓
              Create PENDING connection
                    ↓
              Generate connection_id
                    ↓
              Send link to user
                    ↓
User clicks → Web page → Submit Manus token
                    ↓
              Register webhook with Manus
                    ↓
              Generate photon_api_key
                    ↓
              Update to ACTIVE
                    ↓
              Return MCP config
```

### Message Processing Flow

```
User sends iMessage
        ↓
Backend receives
        ↓
Add to message queue (Redis)
        ↓
Debounce (2 seconds)
        ↓
Worker picks up
        ↓
Fetch recent context
        ↓
Call SLM classifier
        ↓
    ┌───────────────┐
    │ NEW_TASK?     │
    └───┬───────┬───┘
        │       │
    Yes │       │ No (FOLLOW_UP)
        │       │
        ↓       ↓
Create new   Append to
Manus task   existing task
        │       │
        └───┬───┘
            ↓
    Task executes in Manus
            ↓
    Webhooks sent back
            ↓
    Backend receives
            ↓
    Send iMessage to user
```

### Webhook Flow (Manus → User)

```
Manus task event
        ↓
Webhook to backend
        ↓
    ┌───────────────────┐
    │ Event type?       │
    └─┬──────┬────────┬─┘
      │      │        │
task_ │      │ task_  │ task_
created│      │progress│stopped
      │      │        │
      ↓      ↓        ↓
  Always  Throttled Always
   send    (1/min)   send
      │      │        │
      └──────┴────────┘
              ↓
    Format with [Manus]
              ↓
    Send via iMessage
              ↓
    Record in database
```

## Database Schema

### connections
- Primary key: `id` (UUID)
- Unique: `connectionId`, `photonApiKey`
- Indexes: `phoneNumber`, `photonApiKey`, `status`
- Relations: `manusMessages[]`, `messageQueue[]`

### manus_messages
- Primary key: `messageGuid`
- Purpose: Track messages sent by Manus
- Used for: Filtering in fetch tool
- Index: `(phoneNumber, sentAt)`

### message_queue
- Primary key: `id` (auto-increment)
- Purpose: Queue incoming messages for processing
- Status: PENDING → PROCESSING → COMPLETED/FAILED
- Index: `(phoneNumber, status, createdAt)`

## Infrastructure

### PostgreSQL
- Main data store
- Stores connections, messages, queue
- Managed via Prisma ORM

### Redis
- Message queue backend (BullMQ)
- Job persistence
- Per-user queues

### SigNoz (Observability)
- ClickHouse: Metrics storage
- OTEL Collector: Trace collection
- Query Service: API for dashboards
- Frontend: Web UI (port 3301)

## Security

### Authentication
- Photon API keys: `photon_sk_xxx` (64 chars random)
- Manus API keys: Stored encrypted in database
- Webhook validation: Bearer token authentication

### Privacy
- Phone numbers: Only stored in backend database
- Manus never sees raw phone numbers
- API keys: Environment variables only

### Network
- All services communicate via internal Docker network
- Only backend exposed to internet (via reverse proxy)
- MCP server: stdio only (no network exposure)

## Scalability

### Horizontal Scaling
- Backend: Stateless, can scale to N instances
- Worker: Can run multiple instances (Redis handles distribution)
- SLM Classifier: Stateless, can scale to N instances

### Vertical Scaling
- Database: Increase connection pool
- Redis: Increase memory
- Services: Increase CPU/memory limits

### Performance Targets
- Message processing: <5 seconds end-to-end
- SLM classification: <500ms
- MCP tool calls: <1 second
- Webhook delivery: <2 seconds

## Monitoring

### Key Metrics
- Request latency (p50, p95, p99)
- Error rates by endpoint
- Queue depth per user
- Message processing time
- Webhook delivery success rate

### Alerts
- High error rate (>5%)
- Queue depth >100 messages
- Database connection pool exhausted
- Service down >1 minute

### Logs
- Structured JSON logs
- Correlation IDs for tracing
- Log levels: debug, info, warn, error
- Retention: 7 days in SigNoz

## Deployment

### Development
```bash
pnpm dev
```
- Hot reload enabled
- Debug logging
- Local PostgreSQL/Redis

### Production
```bash
docker-compose up -d
```
- All services containerized
- Production logging
- Health checks enabled
- Automatic restarts

## Future Enhancements

1. **Multi-user support** - Handle multiple phone numbers per Manus account
2. **Message attachments** - Support images, files, etc.
3. **Voice messages** - Transcribe and process voice messages
4. **Group chats** - Support iMessage group conversations
5. **Advanced analytics** - Usage patterns, popular tasks
6. **Rate limiting** - Prevent abuse
7. **Caching layer** - Redis cache for frequent queries
8. **WebSocket support** - Real-time updates to Manus
