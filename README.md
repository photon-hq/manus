# Manus on iMessage

Bring Manus AI to iMessage. Built by [Photon](https://photon.codes).

## Overview

TypeScript monorepo that bridges iMessage and [Manus AI](https://manus.im). Users text a phone number, Manus handles their request, and the response comes back as an iMessage.

**How it works:**
1. User texts the Photon number via iMessage
2. Message is queued, debounced, and classified (new task vs follow-up)
3. Manus AI processes the task
4. Results are delivered back via iMessage

## Services

| Service | Port | Description |
|---------|------|-------------|
| **Backend** | 3000 | Fastify API server -- connection flow, webhooks, iMessage event listener |
| **Worker** | -- | BullMQ processor -- message debouncing, intent classification, Manus API |
| **SLM Classifier** | 3001 | Intent router -- classifies messages as NEW_TASK / FOLLOW_UP via Claude |

**Shared packages:**
- `packages/shared` -- Types, Zod schemas, utilities
- `packages/database` -- Prisma ORM, migrations

## Quick Start

**Prerequisites:** Node.js 20+, pnpm 8+, Docker

```bash
cp .env.example .env    # Edit with your credentials
pnpm install
make dev                # Starts postgres, redis, runs migrations, starts all services
```

Or manually:

```bash
docker compose up -d postgres redis
pnpm db:generate && pnpm db:migrate
pnpm dev
```

## Production Deployment

```bash
docker compose -f docker-compose.prod.yml up -d
```

All services run in Docker. The backend entrypoint handles migrations automatically on startup.

## Configuration

Copy `.env.example` and fill in the required values:

```env
# Required
IMESSAGE_SERVER_URL=https://your-imessage-server.photon.codes
IMESSAGE_API_KEY=your_photon_imessage_api_key
PHOTON_HANDLE=+14158156704
PUBLIC_URL=https://manus.photon.codes

# Required for SLM classification (DETECTION_MODE=slm)
OPENROUTER_API_KEY=your_openrouter_api_key

# Optional (have defaults)
DATABASE_URL=postgresql://postgres:password@localhost:5432/manus_imessage
REDIS_URL=redis://localhost:6379
MANUS_API_URL=https://api.manus.im
MANUS_FREE_TIER_API_KEY=sk-...   # Shared key for first 3 free tasks per user
DETECTION_MODE=slm               # slm (LLM-based) or thread (iMessage reply metadata)
```

See `.env.example` for the full list including analytics, contact card, and UI options.

## Architecture

```
User ──iMessage──► Backend (event listener) ──► Redis Queue ──► Worker
                       │                                          │
                       │                                    SLM Classifier
                       │                                    (intent routing)
                       │                                          │
                       ◄────── Manus Webhooks ◄──────── Manus AI ◄┘
```

**Message flow:**
1. iMessage SDK event arrives at Backend
2. Backend queues message in BullMQ (per-user queues)
3. Worker debounces (3s window), then classifies intent via SLM
4. NEW_TASK: creates Manus task | FOLLOW_UP: appends to existing task
5. Manus processes and sends webhooks (task_created, task_progress, task_stopped)
6. Backend delivers results back via iMessage

**Key subsystems:**

- **Intent classification** -- SLM classifier uses Claude to determine if a message is a new task, follow-up, revoke, or service question. Conversation context (both user and bot messages) is included for accurate detection.
- **Typing indicators** -- Managed by `TypingIndicatorManager` in worker. Auto-refreshes every 50s, coordinated via Redis pub/sub (`ensure-typing`, `task-stopped`).
- **Free tier** -- First 3 tasks use a shared system API key. After that, users are prompted to add their own Manus API key.
- **File attachments** -- Downloads from iMessage, uploads to Manus Files API. Falls back to download links if sending fails.
- **Tapback reactions** -- "Love" reaction on receipt, removed on task completion.

## API Endpoints

**Connection flow:**
- `GET /connect` -- Landing page
- `POST /connect` -- Start connection (sends iMessage to user)
- `GET /connect/:id` -- API key input page
- `PUT /connect/:id` -- Activate with Manus API key
- `DELETE /connect/:id` -- Revoke connection

**Webhooks:**
- `POST /webhook` -- Receives task events from Manus AI

**Health:**
- `GET /health` -- Health check (includes DB ping)

## Project Structure

```
manus/
├── packages/
│   ├── shared/              # Types, Zod schemas, utilities
│   └── database/            # Prisma schema, migrations, client
├── services/
│   ├── backend/             # Fastify API + iMessage event listener
│   │   └── src/routes/
│   │       ├── webhooks.ts          # Manus webhook handler
│   │       └── imessage-webhook.ts  # iMessage event listener + onboarding
│   ├── worker/              # BullMQ message processor
│   │   └── src/
│   │       ├── index.ts             # Queue workers, intent detection, Manus API
│   │       └── typing-manager.ts    # Typing indicator lifecycle
│   └── slm-classifier/     # LLM-based intent classification
│       └── src/index.ts             # Claude-powered message router
├── docker-compose.yml       # Dev environment
├── docker-compose.prod.yml  # Production environment
├── Makefile                 # Common commands
└── .env.example             # Environment template
```

## Development

```bash
make dev          # Start everything
make reset-db     # Reset database (deletes all data)
make db-studio    # Open Prisma Studio
make logs         # Tail all Docker logs

# Individual services
pnpm --filter @imessage-mcp/backend dev
pnpm --filter @imessage-mcp/worker dev

# Database
pnpm db:generate  # Regenerate Prisma client
pnpm db:migrate   # Run migrations

# Health check
curl http://localhost:3000/health
```

## Troubleshooting

**Messages not processing:** Check worker logs (`docker compose logs -f worker`). Verify `IMESSAGE_SERVER_URL` and `IMESSAGE_API_KEY` are correct.

**Follow-ups creating new tasks:** Check SLM classifier logs. Ensure `DETECTION_MODE=slm` and `OPENROUTER_API_KEY` is set. The classifier needs conversation context (both user messages and bot responses) to detect follow-ups.

**Typing indicator stuck:** Check worker logs for `TypingIndicatorManager` errors. Indicators auto-stop on task completion via Redis `task-stopped` event.

**Webhooks not received:** Verify `PUBLIC_URL` is accessible from the internet. Webhook endpoint is `POST /webhook`.

**Reset everything:**
```bash
docker compose down -v && docker compose up -d
```

---

Built by [Photon](https://photon.codes)
