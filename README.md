# Manus iMessage Integration

Complete backend system for integrating iMessage with Manus AI, enabling bidirectional communication and intelligent task management.

## 🎯 Overview

This repository contains the **Manus Connector** - a production-ready system that bridges iMessage with Manus AI, allowing users to interact with their AI assistant directly through iMessage.

## 📦 What's Inside

### `manus-connector/`

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
cd manus-connector
./scripts/quick-start.sh
```

This will:
1. Install all dependencies
2. Start Docker services (PostgreSQL, Redis, SigNoz)
3. Run database migrations
4. Start all application services

## 📚 Documentation

Comprehensive documentation is available in the `manus-connector/` directory:

- **[SETUP.md](manus-connector/SETUP.md)** - Detailed setup instructions
- **[ARCHITECTURE.md](manus-connector/ARCHITECTURE.md)** - System architecture and design
- **[DEPLOYMENT.md](manus-connector/DEPLOYMENT.md)** - Production deployment guide
- **[PROJECT_SUMMARY.md](manus-connector/PROJECT_SUMMARY.md)** - Complete feature list
- **[CHECKLIST.md](manus-connector/CHECKLIST.md)** - Implementation checklist

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
cd manus-connector
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
cd manus-connector
./scripts/test-connection-flow.sh
```

## 🌐 Service Endpoints

- **Backend API:** http://localhost:3000
- **SLM Classifier:** http://localhost:3001  
- **SigNoz Dashboard:** http://localhost:3301

## 📈 What's Implemented

✅ Complete monorepo with 4 microservices  
✅ MCP protocol server (fetch/send tools)  
✅ Message queue with debouncing (2-second window)  
✅ AI-powered task classification  
✅ Webhook handling with throttling  
✅ Full observability (traces, metrics, logs)  
✅ Docker infrastructure  
✅ Database schema with Prisma  
✅ Comprehensive documentation  

## 🔐 Security

- Secure API key generation (64-char random)
- Phone number privacy (never exposed to Manus)
- Bearer token authentication
- Environment variable secrets
- Connection status tracking

## 📦 Project Structure

```
manus-connector/
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

For production deployment:

```bash
cd manus-connector
docker-compose up -d
```

See [DEPLOYMENT.md](manus-connector/DEPLOYMENT.md) for detailed production setup including:
- SSL/TLS configuration
- Nginx reverse proxy
- Monitoring & alerts
- Database backups
- Scaling strategies

## 🤝 Integration Points

The system has placeholder implementations for:

1. **iMessage Integration** - Connect your advanced-imessage-kit
2. **Manus API** - Task creation and updates

See [CHECKLIST.md](manus-connector/CHECKLIST.md) for detailed integration steps.

## 📞 Support

- Check logs: `docker-compose logs -f`
- View metrics: http://localhost:3301
- Review documentation in `manus-connector/`

## 📄 License

MIT

## 🎯 Next Steps

1. Review [SETUP.md](manus-connector/SETUP.md) for detailed setup
2. Add your credentials to `.env`
3. Run `./scripts/quick-start.sh`
4. Test with `./scripts/test-connection-flow.sh`
5. Integrate your iMessage infrastructure
6. Deploy to production

---

**Built for seamless iMessage + Manus AI integration** 🚀
