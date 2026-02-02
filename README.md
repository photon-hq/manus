# iMessage MCP Integration System

A complete backend system that integrates iMessage with Manus AI, enabling bidirectional communication and intelligent task management.

## Architecture

This is a monorepo containing 4 main services:

- **backend**: Main API server (Fastify) - handles connection flow, webhooks, and MCP endpoints
- **mcp-server**: MCP protocol server - exposes fetch/send tools to Manus
- **worker**: Message queue processor (BullMQ) - handles sequential message processing
- **slm-classifier**: Task classification service - determines NEW_TASK vs FOLLOW_UP

## Prerequisites

- Node.js >= 20.0.0
- pnpm >= 8.0.0
- Docker & Docker Compose
- PostgreSQL 16
- Redis 7

## Quick Start

1. **Install dependencies**
   ```bash
   pnpm install
   ```

2. **Set up environment**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Start infrastructure**
   ```bash
   docker-compose up -d postgres redis
   ```

4. **Run database migrations**
   ```bash
   pnpm db:migrate
   ```

5. **Start all services**
   ```bash
   pnpm dev
   ```

## Development

### Running individual services

```bash
# Backend API
pnpm --filter backend dev

# MCP Server
pnpm --filter mcp-server dev

# Worker
pnpm --filter worker dev

# SLM Classifier
pnpm --filter slm-classifier dev
```

### Database operations

```bash
# Create migration
pnpm db:migrate

# Generate Prisma client
pnpm db:generate

# Open Prisma Studio
pnpm db:studio
```

## Docker Deployment

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

## Project Structure

```
.
├── packages/
│   ├── database/       # Prisma schema & migrations
│   └── shared/         # Shared types & utilities
├── services/
│   ├── backend/        # Main API server
│   ├── mcp-server/     # MCP protocol server
│   ├── worker/         # Message queue processor
│   └── slm-classifier/ # Task classification service
├── docker-compose.yml
└── pnpm-workspace.yaml
```

## Environment Variables

See `.env.example` for all required environment variables.

## License

MIT
# connectors
