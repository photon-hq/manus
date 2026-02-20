# Manus AI (Photon Integration)

Bring Manus AI into the messaging channel.

## Overview

TypeScript monorepo with 2 microservices that bridge messaging apps and Manus AI.

## Services

- **Backend** (Port 3000) - API server, HTTP MCP endpoint, connection flow, webhooks
- **Worker** - BullMQ queue, message processing, debouncing, thread detection
- **Shared Packages** - Types, utilities, Prisma ORM

## User Setup

1. Visit `manus.photon.codes` → Click "Connect to Manus"
2. Send iMessage (via phone number or iCloud email) → Submit Manus API key ([Get key](https://manus.im/app#settings/integrations/api))
   - API key format: `sk-` followed by 70-100 alphanumeric characters
3. Receive MCP config via iMessage → Copy and paste into [Manus Settings](https://manus.im/app#settings/connectors/mcp-server)

**Supported Handles:**
- Phone numbers: `+1234567890` (SMS or iMessage)
- iCloud emails: `user@icloud.com` (iMessage only)

**What you'll receive:**
After completing setup, you'll receive the MCP configuration JSON directly via iMessage. Simply copy and paste it into Manus.

**Example config format:**
```json
{
  "mcpServers": {
    "photon-imessage": {
      "type": "streamableHttp",
      "url": "https://manus.photon.codes/mcp/http",
      "headers": {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer ph_live_AbC123XyZ789PqR45678"
      }
    }
  }
}
```

## Quick Start

**Prerequisites:** Node.js 20+, pnpm, Docker

```bash
# Setup
cp .env.example .env  # Edit with your credentials
pnpm install
docker compose up -d postgres redis
pnpm db:generate && pnpm db:migrate
pnpm dev
```

## Configuration

**Required environment variables:**
```env
# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/manus_imessage
DB_PASSWORD=password

# Redis
REDIS_URL=redis://localhost:6379

# iMessage Integration (Photon)
IMESSAGE_SERVER_URL=https://your-imessage-server.photon.codes
IMESSAGE_API_KEY=your_photon_api_key
PHOTON_HANDLE=+1234567890

# Manus API
MANUS_API_URL=https://api.manus.im

# App Config
PORT=3000
NODE_ENV=production
PUBLIC_URL=https://manus.photon.codes
```

**Ports:** Backend (3000), PostgreSQL (5432), Redis (6379)

**Timing Configuration:**
- Message debounce window: 3 seconds
- Typing indicator refresh: 25 seconds
- Progress update throttle: 10 seconds
- Redis key TTL: 24 hours

## Advanced Features

**Thread Detection System:**
- Redis-based message threading using `threadOriginatorGuid`
- Automatically detects follow-up messages vs new tasks
- 24-hour context window with Redis keys: `msg:task:{messageGuid}`, `task:trigger:{taskId}`, `task:mapping:{taskId}`
- No external classifier needed - uses iMessage reply metadata

**Typing Indicators:**
- Managed by `TypingManager` in worker service
- Auto-refreshes every 25 seconds to keep indicator active during long tasks
- Automatically stops when task completes
- Coordinated via Redis pub/sub (`ensure-typing`, `task-stopped`)

**Tapback Reactions:**
- Backend sends "love" reaction (❤️) when message is received
- Worker removes reaction when task completes
- Provides visual feedback to user during processing
- Reaction metadata stored in Redis: `reaction:{taskId}`

**Contact Card Sharing:**
- Shares contact card on first interaction (configurable)
- Tracks sharing status per user in database (`contactCardShared` field)
- Configurable contact name and email via environment variables
- Debug mode available for testing (`ALWAYS_SHARE_CONTACT_CARD`)

**File Attachment Handling:**
- Downloads files from URLs and sends as native iMessage attachments
- Uploads to Manus Files API before task creation
- Automatic fallback to download links if attachment sending fails
- Supports multiple attachments per message
- File-only messages create tasks with `[User sent N file(s)]` prompt

**Redis Pub/Sub Channels:**
- `connection-activated` - New connection established
- `message-queued` - Message queued for processing
- `task-stopped` - Task completed (stop typing, remove tapback)
- `ensure-typing` - Keep typing indicator active (e.g., after progress updates)

**Environment Variable Details:**

*Required:*
- `IMESSAGE_SERVER_URL` - Your Photon iMessage server endpoint
- `IMESSAGE_API_KEY` - Your Photon API key for iMessage integration
- `PHOTON_HANDLE` - Phone number or iCloud email for landing page SMS link
- `PUBLIC_URL` - Your deployed backend URL (e.g., `https://manus.photon.codes`)

*Optional (have defaults):*
- `DATABASE_URL` - PostgreSQL connection string (default: `postgresql://postgres:password@localhost:5432/manus_imessage`)
- `DB_PASSWORD` - PostgreSQL password (default: `password`)
- `REDIS_URL` - Redis connection string (default: `redis://localhost:6379`)
- `MANUS_API_URL` - Manus API base URL (default: `https://api.manus.im`)
- `PORT` - Backend server port (default: `3000`)
- `NODE_ENV` - Environment mode (default: `development`, set to `production` for deployment)
- `CONNECTION_TIMEOUT_HOURS` - SSE connection timeout in hours (default: `4`)
- `KEEPALIVE_TIMEOUT_SECONDS` - Server keep-alive timeout in seconds (default: `120`)

*Not Required:*
- `PHOTON_API_KEY` - Not needed! Each user provides their own Manus API key during setup

*UI Design Configuration:*
- `UI_DESIGN_VERSION` - Choose between `v1` (glassmorphism) or `v2` (Manus brand design)
  - `v1` (default): Current design with liquid glass buttons, background image, and Manus custom font
  - `v2`: Clean Manus brand design with Libre Baskerville serif, DM Sans sans-serif, and minimal styling

*Analytics & Tracking (Optional):*
- `OPENPANEL_CLIENT_ID` - OpenPanel analytics client ID (leave empty to disable)
- `OPENPANEL_CLIENT_SECRET` - OpenPanel analytics secret
- `OPENPANEL_API_URL` - Custom OpenPanel API URL (default: `https://op.photon.codes/api`)
- `META_PIXEL_ID` - Facebook Pixel ID for analytics (leave empty to disable)

*Contact Card Configuration (Optional):*
- `CONTACT_NAME` - Name for contact card (default: `Manus`)
- `CONTACT_EMAIL` - Email for contact card (default: `manus.photon.codes`)
- `ALWAYS_SHARE_CONTACT_CARD` - Debug: Always share contact card on every message (default: `false`)
- `ALLOW_SELF_MESSAGES` - Debug: Allow processing messages from self for testing (default: `false`)

## Architecture

```
User → iMessage SDK → Backend (HTTP MCP + Webhooks) → Worker (Thread Detection via Redis)
                           ↓                                ↓
                        Manus AI ←──────────────────────────┘
```

**HTTP MCP Features:**
- Self-hosted streamableHttp transport
- Bearer token auth, CORS whitelist
- Tools: `fetch_messages` (get messages), `send_message` (send message)

**Flow:** 
1. User texts → Queue → Debounce (3s) → Thread Detection (Redis) → Create/Append Task
2. Manus AI processes → Webhooks (task_created, task_progress, task_stopped) → Reply to user

**Key Features:**
- Smart thread detection using Redis (NEW_TASK vs FOLLOW_UP) with 24-hour context window
- Real-time progress updates via webhooks (throttled to 1 per 10 seconds)
- File attachments sent as actual iMessage files (with fallback to download links)
- Typing indicators during task processing (auto-refresh every 25s)
- Message debouncing and deduplication
- Tapback reactions ("love") on message receipt, removed on task completion
- Contact card sharing with tracking per user
- Redis pub/sub for real-time coordination between services

## API Endpoints

**Connection:** 
- `GET /` - Redirects to `/connect`
- `GET /connect` - Landing page with "Connect to Manus" button
- `POST /connect` - Start connection flow (send iMessage with link)
- `GET /connect/:connectionId` - Token input page
- `PUT /connect/:connectionId` - Activate connection with Manus API key
- `DELETE /connect/:connectionId` - Revoke connection
- `GET /connect/revoke` - Revoke connection page
- `POST /connect/revoke` - Revoke connection by Photon API key

**MCP:** 
- `POST /mcp/http` - HTTP MCP endpoint (streamableHttp transport)
- `GET /mcp` - Legacy SSE endpoint (deprecated, use HTTP)
- `POST /mcp` - SSE POST handler

**Webhooks:** 
- `POST /webhook` - Receive webhooks from Manus AI

**Health & Debug:** 
- `GET /health` - Health check endpoint
- `GET /debug/proxy` - Proxy header inspection (debug only)
- `GET /debug/sse` - SSE test endpoint (debug only)
- `GET /debug/sse-long` - Long SSE test (debug only)

## Security

- Bearer token auth, CORS whitelist, origin validation
- 1-hour connection timeout, graceful shutdown
- Secure API key generation, phone privacy
- No public webhooks (SDK events only)

## Deployment

```bash
docker compose up -d
docker compose logs -f backend
docker compose exec backend pnpm db:migrate
```

**Nginx config for MCP HTTP endpoint:**
```nginx
location /mcp/http {
    proxy_pass http://backend:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**Production env:** Set `PUBLIC_URL=https://manus.photon.codes`, `NODE_ENV=production`, and all credentials.

## Development

```bash
# Run services
pnpm dev  # All services
pnpm --filter backend dev  # Individual service

# Database
pnpm db:generate  # Generate Prisma client
pnpm db:migrate   # Run migrations
pnpm db:studio    # Open Prisma Studio
make reset-db     # Reset database

# Testing
curl http://localhost:3000/health  # Health check

# Test MCP HTTP endpoint
curl -X POST http://localhost:3000/mcp/http \
  -H "Authorization: Bearer ph_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"method":"tools/list"}'
```

## Structure

```
manus/
├── packages/shared/         # Types, utilities
├── packages/database/       # Prisma ORM
├── services/backend/        # API + HTTP MCP
├── services/worker/         # Queue processor
└── assets/                  # Static assets (images, fonts)
```

## Troubleshooting

```bash
# Check logs
docker compose logs -f backend
docker compose logs -f worker

# Test MCP HTTP endpoint
curl -X POST http://localhost:3000/mcp/http \
  -H "Authorization: Bearer ph_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"method":"tools/list"}'

# Reset everything
docker compose down -v && docker compose up -d
make reset-db
```

**Common Issues:**

- **CORS issues:** Check `services/backend/src/index.ts` for allowed origins
- **Webhook not received:** Verify `PUBLIC_URL` is set correctly and accessible from Manus. Webhook endpoint is `POST /webhook` (not `/api/webhooks/webhook`)
- **Thread detection issues:** Check Redis connection and verify keys exist: `msg:task:{messageGuid}`, `task:trigger:{taskId}`, `task:mapping:{taskId}`. Keys have 24-hour TTL.
- **Messages not sending:** Verify iMessage SDK connection and Photon credentials
- **Typing indicator stuck:** Check worker logs for `TypingManager` errors. Indicator auto-refreshes every 25s and stops on task completion via Redis `task-stopped` event
- **Task context issues:** Check Redis connection and worker logs for task mapping. Verify `threadOriginatorGuid` is set correctly on messages
- **File attachments failing:** Check Manus Files API upload logs. System falls back to download links if attachment sending fails
- **Contact card not shared:** Verify `CONTACT_NAME` and `CONTACT_EMAIL` are set. Check `contactCardShared` field in database
- **Tapback reactions not working:** Check Redis `reaction:{taskId}` key exists. Backend sends "love" on receipt, worker removes on completion

---

**Built for seamless iMessage + Manus AI integration**
