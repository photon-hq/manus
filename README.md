# Manus Backend - iMessage Integration

Backend system for integrating iMessage with Manus AI using SSE-based MCP protocol.

## Overview

TypeScript monorepo with 3 microservices that bridge iMessage and Manus AI.

## Services

- **Backend** (Port 3000) - API server, SSE MCP endpoint, connection flow, webhooks
- **Worker** - BullMQ queue, message processing, debouncing
- **SLM Classifier** (Port 3001) - Task classification (NEW_TASK vs FOLLOW_UP)
- **Shared Packages** - Types, utilities, Prisma ORM

## User Setup

1. Visit `manus.photon.codes` → Click "Connect to Manus"
2. Send iMessage → Submit Manus API key ([Get key](https://manus.im/app#settings/integrations/api))
3. Copy SSE config → Paste in [Manus Settings](https://manus.im/app#settings/connectors/mcp-server)

**Config format:**
```json
{
  "mcpServers": {
    "photon-imessage": {
      "type": "sse",
      "url": "https://manus.photon.codes/mcp",
      "headers": { "Authorization": "Bearer ph_live_AbC123XyZ789PqR45678" }
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
- `LANDING_VIDEO_URL` - Optional background video URL for landing page

## Architecture

```
User → iMessage SDK → Backend (SSE MCP + Events) → Worker → Classifier
                           ↓                              ↓
                        Manus AI ←────────────────────────┘
```

**SSE MCP Features:**
- Self-hosted (no npm package)
- Bearer token auth, CORS whitelist
- Tools: `fetch` (get messages), `send` (send message)

**Flow:** User texts → Queue → Debounce (2s) → Classify → Route to Manus → Webhook → Reply

## API Endpoints

**Connection:** `GET /connect`, `POST /connect`, `PUT /connect/:id`, `DELETE /connect/:id`  
**MCP:** `GET /mcp` (SSE stream), `POST /mcp` (messages), `GET /mcp/status`  
**Webhooks:** `POST /webhook`  
**Health:** `GET /health`

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

**Nginx SSE config:**
```nginx
location /mcp {
    proxy_pass http://backend:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
}
```

**Production env:** Set `PUBLIC_URL=https://manus.photon.codes`, `NODE_ENV=production`, and all credentials.

## Development

```bash
# Run services
pnpm dev  # All services
pnpm --filter backend dev  # Individual

# Database
pnpm db:generate
pnpm db:migrate
pnpm db:studio
make reset-db

# Testing
./scripts/test-connection-flow.sh
curl http://localhost:3000/health
curl -N -H "Authorization: Bearer photon_sk_xxx" http://localhost:3000/mcp
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

# Test SSE
curl -N -H "Authorization: Bearer ph_live_AbC123XyZ789PqR45678" http://localhost:3000/mcp

# Reset
docker compose down -v && docker compose up -d
make reset-db
```

**CORS issues:** Check `services/backend/src/index.ts` for allowed origins.

---

**Built for seamless iMessage + Manus AI integration**
