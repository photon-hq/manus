# Manus Backend - iMessage Integration

Complete backend system for integrating iMessage with Manus AI, enabling bidirectional communication and intelligent task management.

## 🎯 Overview

A production-ready TypeScript monorepo with 4 microservices that bridge iMessage and Manus AI using the Model Context Protocol (MCP).

## 📦 What's Built

### Microservices

1. **Backend Service** (Port 3000)
   - Fastify-based API server
   - Connection management flow
   - MCP endpoints (fetch/send)
   - Webhook receiver for Manus events

2. **MCP Server** (stdio) - Published as `photon-manus-mcp`
   - Model Context Protocol implementation
   - Two tools: `fetch` and `send`
   - Communicates with backend via HTTP
   - Users install via: `npx photon-manus-mcp@latest`

3. **Worker Service** (Background)
   - BullMQ message queue
   - Sequential processing per user
   - 2-second message debouncing
   - Task classification routing

4. **SLM Classifier** (Port 3001)
   - OpenRouter integration (Gemini Flash)
   - NEW_TASK vs FOLLOW_UP classification
   - Fast inference (<500ms)

### Shared Packages

- **@imessage-mcp/shared** - Types, utilities, Zod schemas
- **@imessage-mcp/database** - Prisma schema & client

## 👥 For End Users

Want to connect your iMessage to Manus AI? Visit **[manus.photon.codes](https://manus.photon.codes)** to get started!

### Quick Setup (2 minutes)

1. Visit [manus.photon.codes](https://manus.photon.codes)
2. Enter your phone number or iCloud email
3. Submit your Manus API key
4. Copy the MCP configuration
5. Paste it in [Manus Settings](https://manus.im/settings/mcp)

That's it! You can now use iMessage tools in Manus AI.

### MCP Package

The MCP server is published as [`photon-manus-mcp`](https://www.npmjs.com/package/photon-manus-mcp) on NPM.

**Installation:** Automatic via `npx` (included in MCP config)

**Documentation:** See [`services/mcp-server/README.md`](services/mcp-server/README.md)

---

## 🚀 For Developers - Quick Start

### Prerequisites

- Node.js >= 20.0.0
- pnpm >= 8.0.0
- Docker & Docker Compose
- Access to Photon iMessage server (endpoint + API key)

### Setup Steps

1. **Configure Environment**
```bash
cp .env.example .env
# Edit .env with your Photon iMessage credentials
```

2. **One-Command Setup**
```bash
./scripts/quick-start.sh
```

### Manual Setup

```bash
# Install dependencies
pnpm install

# Start infrastructure
docker-compose up -d postgres redis

# Setup database
pnpm db:generate
pnpm db:migrate

# Start all services
pnpm dev
```

## 🔧 Configuration

### 1. iMessage Integration

This project uses [advanced-imessage-kit](https://github.com/photon-hq/advanced-imessage-kit) SDK to connect to your existing iMessage infrastructure.

**Requirements:**
- Access to Photon's iMessage server endpoint
- API key for authentication

**No setup needed** - the SDK connects to your existing iMessage infrastructure via API

### 2. Configure Environment

Copy environment template:
```bash
cp .env.example .env
```

Add your credentials:
```env
# iMessage Integration (advanced-imessage-kit)
IMESSAGE_SERVER_URL=https://your-imessage-server.photon.codes
IMESSAGE_API_KEY=your_photon_imessage_api_key
PHOTON_HANDLE=+1234567890  # or support@photon.codes (for landing page)

# LLM Provider (get from https://openrouter.ai)
OPENROUTER_API_KEY=your_openrouter_key

# Database (Docker defaults - no changes needed)
DATABASE_URL=postgresql://postgres:password@localhost:5432/manus_imessage

# Redis (Docker defaults - no changes needed)
REDIS_URL=redis://localhost:6379

# Public URL (change for production deployment)
PUBLIC_URL=http://localhost:3000
```

## 📊 Service Endpoints

| Service | Port | URL | Purpose |
|---------|------|-----|---------|
| Backend API | 3000 | http://localhost:3000 | Main API, webhooks, MCP |
| SLM Classifier | 3001 | http://localhost:3001 | Task classification |
| PostgreSQL | 5432 | localhost:5432 | Database |
| Redis | 6379 | localhost:6379 | Message queue |

## 🧪 Testing

```bash
# Run test suite
./scripts/test-connection-flow.sh

# Manual API tests
curl http://localhost:3000/health
curl http://localhost:3001/health
```

## 🏗️ Architecture

### System Overview

```
User (iMessage)
      ↓
iMessage Infrastructure (advanced-imessage-kit)
      ↓ (SDK events: new-message)
Backend Service (Fastify) - Event listener, connection flow, webhooks, MCP endpoints
      ↓
   ┌──┴──┐
   ↓     ↓
MCP    Worker → SLM Classifier (Gemini Flash)
Server         (BullMQ Queue)
   ↓
Manus AI
```

**Key Features:**
- Real-time message reception via SDK events (no webhooks)
- Automatic filtering: ignores self-messages and group chats
- Persistent SDK connection with auto-reconnection
- Built-in message deduplication

### Connection Flow (User Onboarding)

1. **Landing Page**: User visits `GET /api/connect` - Shows "Connect to Manus" button
2. **Opens iMessage**: Button opens Messages app with pre-filled message to `PHOTON_HANDLE`
3. **User Sends Message**: "Hey Manus! Please connect my iMessage"
4. **Backend Captures**: Creates connection record, generates `connectionId`
5. **Typing Indicator (2 sec)**: Shows "typing..." in iMessage
6. **Response 1**: "Sure!"
7. **Typing Indicator (3 sec)**: Shows "typing..." again
8. **Response 2**: "Please input your Manus token in the following link: [URL]"
9. **User Opens Link**: Web page with token input form
10. **User Submits Token**: Validates format (`manus_sk_xxx`), registers webhook
11. **Backend Generates**: Creates `photonApiKey` for user
12. **Typing Indicator (1 sec)**: "You're all set! 🎉"
13. **Typing Indicator (1 sec)**: "You can also add the MCP config to your Manus:"
14. **Sends MCP Config**: JSON config sent via iMessage
15. **Sends Link**: "Paste it here: https://manus.im/settings/mcp"
16. **Web Page**: Shows success with copy button for MCP config

### Data Flow

1. **Message Reception**: User sends iMessage → SDK emits `new-message` event → Backend listener filters (ignore self/groups) → Queue
2. **Message Processing**: Queue → Debounce → Classify (NEW_TASK/FOLLOW_UP) → Upload files to Manus → Route to Manus
3. **Webhook Handling**: Manus event → Backend receives → Throttle/filter → Send iMessage to user (with attachment links)

### Attachment Handling

**User → Manus (Sending Files)**
1. User sends iMessage with attachment (photo, PDF, document, etc.)
2. SDK emits `new-message` event with attachment metadata
3. Backend listener adds to queue
4. Worker downloads attachment from iMessage server
5. Worker uploads to Manus via Files API (presigned URL)
6. Task created with file_id attachment reference

**Manus → User (Receiving Files)**
1. Manus completes task with attachments
2. Backend receives webhook with attachment metadata
3. User receives iMessage with download links:
   ```
   [Manus] ✅ Task Complete
   
   📎 Attachments (2):
   1. report.pdf (2.00 MB)
      https://s3.amazonaws.com/manus-files/report.pdf
   2. data.xlsx (0.50 MB)
      https://s3.amazonaws.com/manus-files/data.xlsx
   ```

**Supported File Types**: All file types supported by iMessage and Manus (images, PDFs, documents, spreadsheets, etc.)

### Database Schema

- **connections** - Store connection state (phone, API keys, status)
- **manus_messages** - Track Manus-sent messages (for filtering)
- **message_queue** - Queue incoming messages (debouncing, processing)

## 🛠️ Development

### Running Services

```bash
# All services
pnpm dev

# Individual service
pnpm --filter backend dev
pnpm --filter worker dev
pnpm --filter slm-classifier dev
```

### Database Operations

```bash
# Generate Prisma client
pnpm db:generate

# Create migration
pnpm db:migrate

# Open Prisma Studio
pnpm db:studio

# Reset database
make reset-db
```

### Docker Operations

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down

# Clean everything
./scripts/cleanup.sh
```

## 🏗️ Project Structure

```
manus/
├── packages/
│   ├── shared/              # Shared types & utilities
│   │   ├── src/
│   │   │   ├── types.ts     # Zod schemas & types
│   │   │   └── utils.ts     # Helper functions
│   │   └── package.json
│   └── database/            # Prisma ORM
│       ├── prisma/
│       │   └── schema.prisma
│       ├── src/
│       │   └── index.ts
│       └── package.json
├── services/
│   ├── backend/             # Main API server
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── connect.ts          # Connection flow
│   │   │   │   ├── mcp.ts              # MCP endpoints
│   │   │   │   ├── webhooks.ts         # Manus webhooks
│   │   │   │   └── imessage-webhook.ts # iMessage incoming messages
│   │   │   ├── lib/
│   │   │   │   ├── imessage.ts         # iMessage SDK integration
│   │   │   │   └── manus-files.ts      # File upload utilities
│   │   │   ├── index.ts
│   │   │   └── tracing.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── mcp-server/          # MCP protocol server
│   │   ├── src/
│   │   │   ├── index.ts     # fetch/send tools
│   │   │   └── tracing.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── worker/              # Message queue processor
│   │   ├── src/
│   │   │   ├── index.ts     # BullMQ worker
│   │   │   └── tracing.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   └── slm-classifier/      # Task classifier
│       ├── src/
│       │   ├── index.ts     # Classification endpoint
│       │   └── tracing.ts
│       ├── Dockerfile
│       └── package.json
├── scripts/
│   ├── quick-start.sh       # One-command setup
│   ├── test-connection-flow.sh
│   └── cleanup.sh
├── docker-compose.yml
├── pnpm-workspace.yaml
├── package.json
└── .env.example
```

## 🔐 Security

- ✅ Secure API key generation (64-char random)
- ✅ Bearer token authentication
- ✅ Phone number privacy (never exposed to Manus)
- ✅ Environment variable secrets
- ✅ Connection status tracking
- ✅ Webhook signature validation (Manus webhooks)
- ✅ **No public iMessage webhook endpoint** (uses SDK events)

## 📈 Performance

- Message processing: <5 seconds end-to-end
- SLM classification: <500ms
- MCP tool calls: <1 second
- Webhook delivery: <2 seconds
- Debounce window: 2 seconds

## 🔧 Integration Points

### 1. iMessage Integration ✅ **IMPLEMENTED**

**Status:** Fully integrated using [advanced-imessage-kit](https://github.com/photon-hq/advanced-imessage-kit)

**Implementation:**
- `services/backend/src/lib/imessage.ts` - Shared iMessage SDK client
- `services/backend/src/routes/imessage-webhook.ts` - Event listener for incoming messages
- `services/backend/src/routes/connect.ts` - Sends connection setup messages
- `services/backend/src/routes/mcp.ts` - Fetches and sends messages
- `services/backend/src/routes/webhooks.ts` - Sends webhook notifications
- `services/worker/src/index.ts` - Fetches message context for SLM

**Features:**
- ✅ **Real-time event-based message reception** (SDK events, not HTTP webhooks)
- ✅ Auto-detect iMessage vs SMS
- ✅ Support both phone numbers and iCloud email addresses
- ✅ **Automatic filtering**: Ignores self-messages and group chats
- ✅ Send text messages with `[Manus]` prefix
- ✅ **Typing indicators** for natural conversation flow
- ✅ **Rich link previews** for URLs
- ✅ Fetch conversation history (last 100 messages)
- ✅ Filter out Manus-sent messages using `isFromMe` flag
- ✅ **Download attachments from iMessage**
- ✅ Built-in message deduplication
- ✅ Automatic reconnection on disconnect
- ✅ Connection pooling and error handling
- ✅ Graceful shutdown

**Requirements:**
- Access to Photon iMessage server endpoint
- Valid API key for authentication

### 2. Manus API Integration ✅ **IMPLEMENTED**

**Status:** Fully integrated using [Manus AI API](https://open.manus.im/docs/api-reference)

**Implementation:**
- `services/worker/src/index.ts` - Task creation and multi-turn conversations
- `packages/database/prisma/schema.prisma` - Tracks current task ID per user

**Features:**
- ✅ Create new tasks via `POST /v1/tasks`
- ✅ Multi-turn conversations using `taskId` parameter
- ✅ Interactive mode enabled (Manus can ask follow-up questions)
- ✅ Automatic task ID tracking per user
- ✅ Fallback to new task if no active task found
- ✅ **File attachments support** (upload via Files API)
- ✅ **Download links for Manus-generated files**
- ✅ Error handling and logging

**API Endpoints Used:**
- `POST https://api.manus.ai/v1/tasks` - Create new task or continue existing
- `POST https://api.manus.ai/v1/files` - Get presigned URL for file upload
- `PUT <presigned_url>` - Upload file content to S3
- Uses user's `manusApiKey` from database for authentication
- Stores `currentTaskId` for follow-up messages

**File Handling:**
1. User sends iMessage with attachment → Backend downloads from iMessage
2. Backend uploads to Manus via Files API (presigned S3 URL)
3. Task created with `file_id` attachment reference
4. Manus processes file and can return attachments in response
5. User receives download links in iMessage

## 📡 API Reference

### Backend Endpoints (Port 3000)

#### Connection Flow
- `GET /api/connect` - Landing page with "Connect to Manus" button (opens iMessage)
- `POST /api/connect/start` - Initiate connection (with typing indicators and link)
- `POST /api/connect/verify` - Verify Manus token and activate connection
- `GET /api/connect/page/:connectionId` - Token input page (HTML)
- `POST /api/connect/revoke` - Revoke connection and delete webhook

#### MCP Endpoints (Manus AI calls these)
- `POST /api/mcp/fetch` - Fetch recent messages from user
- `POST /api/mcp/send` - Send message to user

#### Webhook Endpoints
- `POST /api/webhooks/manus` - Receive Manus AI events (task_created, task_progress, task_stopped)

#### Health Checks
- `GET /health` - Backend health
- `GET /api/imessage/health` - iMessage event listener health

### iMessage Event Listener

**No webhook configuration needed!** The backend uses SDK event listeners:

```typescript
sdk.on('new-message', (message) => {
  // Automatically receives all incoming messages
  // Filters: ignores self-messages and group chats
  // Adds to queue for processing
});
```

**Filters applied:**
- `isFromMe: true` - Ignored (our own messages)
- `chatGuid` contains `;+;` - Ignored (group chats)
- No active connection - Ignored

**Old webhook payload format (deprecated):**

```json
{
  "chatGuid": "any;-;+1234567890",
  "phoneNumber": "+1234567890",
  "message": {
    "guid": "msg_abc123",
    "text": "Analyze this document",
    "isFromMe": false,
    "dateCreated": 1234567890000,
    "attachments": [
      {
        "guid": "att_xyz789",
        "transferName": "document.pdf",
        "mimeType": "application/pdf"
      }
    ]
  }
}
```

**Response:**
```json
{
  "success": true,
  "messageGuid": "msg_abc123",
  "attachmentCount": 1
}
```

### Manus Webhook Payload

Manus sends webhooks to `/api/webhooks/manus`:

```json
{
  "event_type": "task_stopped",
  "task_detail": {
    "task_id": "task_abc123",
    "task_title": "Document Analysis",
    "task_url": "https://manus.im/app/task_abc123",
    "message": "I've analyzed the document...",
    "stop_reason": "finish",
    "attachments": [
      {
        "file_name": "analysis.pdf",
        "url": "https://s3.amazonaws.com/manus-files/analysis.pdf",
        "size_bytes": 2048576
      }
    ]
  }
}
```

## 🚀 Deployment

### Development
```bash
pnpm dev
```

### Production with Docker

1. **Set up environment**:
```bash
cp .env.example .env.production
# Edit with production values
```

2. **Build and start**:
```bash
docker-compose -f docker-compose.yml --env-file .env.production up -d
```

3. **Run migrations**:
```bash
docker-compose exec backend pnpm db:migrate
```

### Production with Nginx (Recommended)

```nginx
server {
    listen 443 ssl http2;
    server_name manus.photon.codes;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /manus/ {
        proxy_pass http://localhost:3000;
    }
}
```

### Scaling

- **Backend**: Stateless, scale horizontally with load balancer
- **Worker**: Run multiple instances, Redis handles distribution
- **Database**: Use connection pooling, consider read replicas
- **Redis**: Increase memory, enable persistence

## 🐛 Troubleshooting

### Services won't start
```bash
docker-compose down -v
docker-compose up -d
```

### Database issues
```bash
docker-compose logs postgres
make reset-db
```

### View logs
```bash
docker-compose logs -f [service-name]
```

## ✨ Features

✅ **Complete Monorepo** - 4 microservices + 2 shared packages  
✅ **MCP Protocol** - Standard fetch/send tools for Manus AI  
✅ **Smart Queue** - Message debouncing (2s window), sequential per-user  
✅ **AI Classification** - NEW_TASK vs FOLLOW_UP detection (Gemini Flash)  
✅ **Webhook Handling** - Intelligent throttling for task updates  
✅ **Docker Ready** - Complete infrastructure with one command  
✅ **Type Safe** - TypeScript throughout with Prisma ORM  
✅ **Production Ready** - Health checks, graceful shutdown, error handling

## 🎯 Next Steps

1. **Setup**: `./scripts/quick-start.sh`
2. **Configure**: Add credentials to `.env`
3. **Test**: `./scripts/test-connection-flow.sh`
4. **Integrate**: Connect your iMessage infrastructure
5. **Deploy**: `docker-compose up -d`

---

**Built with ❤️ for seamless iMessage + Manus AI integration**
