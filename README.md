# Manus iMessage Integration

Complete backend system for integrating iMessage with Manus AI, enabling bidirectional communication and intelligent task management.

## 🎯 Overview

This repository contains the **Manus Backend** - a production-ready system that bridges iMessage with Manus AI, allowing users to interact with their AI assistant directly through iMessage.

## 📦 What's Inside

### `manus-backend/`

A complete TypeScript monorepo with 4 microservices:

- **Backend API** - Connection management, webhooks, MCP endpoints
- **MCP Server** - Model Context Protocol implementation (fetch/send tools)
- **Worker Service** - Message queue with intelligent debouncing
- **SLM Classifier** - Task classification (NEW_TASK vs FOLLOW_UP)

### Key Features

✨ **Connection Management** - User-initiated setup via iMessage  
🔌 **MCP Protocol** - Standard tools for Manus AI integration  
📨 **Message Processing** - Sequential per-user, parallel across users  
🤖 **Smart Classification** - AI-powered task routing  
📊 **Full Observability** - SigNoz integration with distributed tracing  
🐳 **Docker Ready** - Complete infrastructure with one command  

## 🚀 Quick Start

```bash
cd manus-backend
./scripts/quick-start.sh
```

This will:
1. Install all dependencies
2. Start Docker services (PostgreSQL, Redis, SigNoz)
3. Run database migrations
4. Start all application services

## 📚 Documentation

All documentation is in the main README:

- **[manus-backend/README.md](manus-backend/README.md)** - Complete documentation including:
  - Setup instructions
  - Architecture overview
  - Integration guides
  - Deployment instructions
  - Troubleshooting

## 🔧 Prerequisites

- Node.js >= 20.0.0
- pnpm >= 8.0.0
- Docker & Docker Compose
- iMessage infrastructure (advanced-imessage-kit or similar)
- OpenRouter API key (for LLM classification)

## 📊 Architecture

```
User (iMessage)
      ↓
iMessage Infrastructure
      ↓
Backend Service (Fastify)
      ↓
   ┌──┴──┐
   ↓     ↓
MCP    Worker → SLM Classifier
Server         (Gemini Flash)
   ↓
Manus AI
```

## 🛠️ Technology Stack

- **Backend:** Fastify + TypeScript
- **Database:** PostgreSQL 16 + Prisma ORM
- **Queue:** BullMQ + Redis 7
- **Classification:** OpenRouter (Gemini 2.0 Flash)
- **Observability:** SigNoz + OpenTelemetry
- **Infrastructure:** Docker Compose

## 📝 Environment Setup

1. Copy environment template:
```bash
cd manus-backend
cp .env.example .env
```

2. Add your credentials:
```env
IMESSAGE_API_KEY=your_key
IMESSAGE_ENDPOINT=https://your-endpoint.com
OPENROUTER_API_KEY=your_openrouter_key
```

3. Start the system:
```bash
./scripts/quick-start.sh
```

## 🧪 Testing

```bash
cd manus-backend
./scripts/test-connection-flow.sh
```

## 🌐 Service Endpoints

- **Backend API:** http://localhost:3000
- **SLM Classifier:** http://localhost:3001  
- **SigNoz Dashboard:** http://localhost:3301

## ✨ Features

✅ **Complete Monorepo** - 4 microservices + 2 shared packages  
✅ **MCP Protocol** - Standard fetch/send tools for Manus AI  
✅ **Smart Queue** - Message debouncing (2s window), sequential per-user  
✅ **AI Classification** - NEW_TASK vs FOLLOW_UP detection (Gemini Flash)  
✅ **Webhook Handling** - Intelligent throttling for task updates  
✅ **Full Observability** - SigNoz with traces, metrics, logs  
✅ **Docker Ready** - Complete infrastructure with one command  
✅ **Type Safe** - TypeScript throughout with Prisma ORM  
✅ **Production Ready** - Health checks, graceful shutdown, error handling  

## 🔐 Security

- Secure API key generation (64-char random)
- Phone number privacy (never exposed to Manus)
- Bearer token authentication
- Environment variable secrets
- Connection status tracking

## 📦 Project Structure

```
manus-backend/
├── packages/
│   ├── shared/           # Shared types & utilities
│   └── database/         # Prisma schema & client
├── services/
│   ├── backend/          # Main API server
│   ├── mcp-server/       # MCP protocol server
│   ├── worker/           # Message queue processor
│   └── slm-classifier/   # Task classification
├── scripts/              # Automation scripts
├── docker-compose.yml    # Infrastructure setup
└── Documentation files
```

## 🚀 Deployment

**Development:**
```bash
cd manus-backend
./scripts/quick-start.sh
```

**Production:**
```bash
cd manus-backend
docker-compose up -d
```

For production setup (SSL, Nginx, monitoring), see [manus-backend/README.md](manus-backend/README.md)

## 🔧 Integration Required

The system has placeholder implementations (marked with TODO) for:

1. **iMessage Integration** - Connect your advanced-imessage-kit
   - `fetchIMessages()` - Get messages from your infrastructure
   - `sendIMessage()` - Send messages via your infrastructure

2. **Manus API** - Task creation and updates
   - `createManusTask()` - Create new task in Manus
   - `appendToTask()` - Add context to existing task

See [manus-backend/README.md](manus-backend/README.md) for detailed integration guides.

## 📞 Support

- Check logs: `docker-compose logs -f`
- View metrics: http://localhost:3301
- Review documentation in `manus-connector/`

## 📄 License

MIT

## 🎯 Next Steps

1. **Setup**: `cd manus-backend && ./scripts/quick-start.sh`
2. **Configure**: Add credentials to `.env`
3. **Test**: `./scripts/test-connection-flow.sh`
4. **Integrate**: Connect your iMessage infrastructure
5. **Deploy**: `docker-compose up -d`

For detailed instructions, see [manus-backend/README.md](manus-backend/README.md)

---

**Built for seamless iMessage + Manus AI integration** 🚀
