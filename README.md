# Manus Backend - iMessage Integration

Backend system for integrating iMessage with Manus AI using HTTP-based MCP protocol.

## Overview

TypeScript monorepo with 3 microservices that bridge iMessage and Manus AI.

## Services

- **Backend** (Port 3000) - API server, HTTP MCP endpoint, connection flow, webhooks
- **Worker** - BullMQ queue, message processing, debouncing, task classification
- **SLM Classifier** (Port 3001) - Task classification (NEW_TASK vs FOLLOW_UP)
- **Shared Packages** - Types, utilities, Prisma ORM

## User Setup

1. Visit `manus.photon.codes` → Click "Connect to Manus"
2. Send iMessage (via phone number or iCloud email) → Submit Manus API key ([Get key](https://manus.im/app#settings/integrations/api))
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
# One-command setup
./scripts/quick-start.sh

# Or manual
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

# LLM Provider
OPENROUTER_API_KEY=your_openrouter_key

# App Config
PORT=3000
NODE_ENV=production
PUBLIC_URL=https://manus.photon.codes
```

**Ports:** Backend (3000), Classifier (3001), PostgreSQL (5432), Redis (6379)

**Environment Variable Details:**

*Required:*
- `IMESSAGE_SERVER_URL` - Your Photon iMessage server endpoint
- `IMESSAGE_API_KEY` - Your Photon API key for iMessage integration
- `PHOTON_HANDLE` - Phone number or iCloud email for landing page SMS link
- `OPENROUTER_API_KEY` - API key for LLM classification service
- `PUBLIC_URL` - Your deployed backend URL (e.g., `https://manus.photon.codes`)

*Optional (have defaults):*
- `DATABASE_URL` - PostgreSQL connection string (default: `postgresql://postgres:password@localhost:5432/manus_imessage`)
- `DB_PASSWORD` - PostgreSQL password (default: `password`)
- `REDIS_URL` - Redis connection string (default: `redis://localhost:6379`)
- `MANUS_API_URL` - Manus API base URL (default: `https://api.manus.im`)
- `PORT` - Backend server port (default: `3000`)
- `NODE_ENV` - Environment mode (default: `development`, set to `production` for deployment)

*Not Required:*
- `PHOTON_API_KEY` - Not needed! Each user provides their own Manus API key during setup

## Architecture

```
User → iMessage SDK → Backend (HTTP MCP + Webhooks) → Worker → Classifier
                           ↓                                ↓
                        Manus AI ←──────────────────────────┘
```

**HTTP MCP Features:**
- Self-hosted streamableHttp transport
- Bearer token auth, CORS whitelist
- Tools: `fetch_messages` (get messages), `send_message` (send message)

**Flow:** 
1. User texts → Queue → Debounce (2s) → Classify (SLM) → Create/Append Task
2. Manus AI processes → Webhooks (task_created, task_progress, task_stopped) → Reply to user

**Key Features:**
- Smart task classification (NEW_TASK vs FOLLOW_UP) with 10-minute context window
- Real-time progress updates via webhooks (throttled to 1 per 10 seconds)
- File attachments sent as actual iMessage files (with fallback to download links)
- Typing indicators during task processing
- Message debouncing and deduplication

## API Endpoints

**Connection:** 
- `GET /` - Landing page with "Connect to Manus" button
- `GET /:connectionId` - Token input page
- `PUT /:connectionId` - Activate connection with Manus API key
- `GET /revoke` - Revoke connection page
- `POST /revoke` - Revoke connection

**MCP:** 
- `POST /mcp/http` - HTTP MCP endpoint (streamableHttp transport)
- `GET /mcp` - Legacy SSE endpoint (deprecated, use HTTP)

**Webhooks:** 
- `POST /api/webhooks/webhook` - Receive webhooks from Manus AI

**Health:** 
- `GET /health` - Health check endpoint

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
./scripts/test-connection-flow.sh  # Test full connection flow
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
├── services/backend/        # API + SSE MCP
├── services/worker/         # Queue processor
├── services/slm-classifier/ # Task classifier
└── scripts/                 # Setup & test scripts
```

## Troubleshooting

```bash
# Check logs
docker compose logs -f backend
docker compose logs -f worker
docker compose logs -f slm-classifier

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
- **Webhook not received:** Verify `PUBLIC_URL` is set correctly and accessible from Manus
- **Classification errors:** Check SLM classifier logs and OpenRouter API key
- **Messages not sending:** Verify iMessage SDK connection and Photon credentials
- **Task context issues:** Check Redis connection and worker logs for task mapping

---

**Built for seamless iMessage + Manus AI integration**
