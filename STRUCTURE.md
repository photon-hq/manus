# Repository Structure

## Overview

This repository contains the **Manus Connector** - a complete iMessage MCP integration system.

## Directory Layout

```
manus/
├── README.md                      # Top-level overview and quick start
├── imessage_mcp_design.md        # Original design document
└── manus-connector/              # Main codebase
    ├── README.md                 # Detailed connector documentation
    ├── SETUP.md                  # Setup instructions
    ├── ARCHITECTURE.md           # System architecture
    ├── DEPLOYMENT.md             # Production deployment guide
    ├── PROJECT_SUMMARY.md        # Complete feature list
    ├── CHECKLIST.md              # Implementation checklist
    │
    ├── packages/                 # Shared packages
    │   ├── database/            # Prisma ORM & schema
    │   └── shared/              # Types, utilities, Zod schemas
    │
    ├── services/                # Microservices
    │   ├── backend/            # Fastify API server
    │   ├── mcp-server/         # MCP protocol implementation
    │   ├── worker/             # BullMQ message processor
    │   └── slm-classifier/     # OpenRouter task classifier
    │
    ├── scripts/                # Automation scripts
    │   ├── quick-start.sh     # One-command setup
    │   ├── test-connection-flow.sh
    │   └── cleanup.sh
    │
    ├── signoz/                 # Observability config
    │   └── otel-collector-config.yaml
    │
    ├── docker-compose.yml      # Infrastructure setup
    ├── pnpm-workspace.yaml     # Monorepo config
    ├── package.json            # Root package
    ├── tsconfig.json           # TypeScript config
    ├── Makefile                # Build commands
    ├── .env.example            # Environment template
    ├── .dockerignore
    └── .gitignore
```

## Quick Navigation

### Getting Started
- **[README.md](README.md)** - Start here for overview
- **[manus-connector/SETUP.md](manus-connector/SETUP.md)** - Detailed setup guide
- **[manus-connector/CHECKLIST.md](manus-connector/CHECKLIST.md)** - Implementation steps

### Understanding the System
- **[manus-connector/ARCHITECTURE.md](manus-connector/ARCHITECTURE.md)** - System design
- **[manus-connector/PROJECT_SUMMARY.md](manus-connector/PROJECT_SUMMARY.md)** - Feature list
- **[imessage_mcp_design.md](imessage_mcp_design.md)** - Original design doc

### Deployment
- **[manus-connector/DEPLOYMENT.md](manus-connector/DEPLOYMENT.md)** - Production guide
- **[manus-connector/docker-compose.yml](manus-connector/docker-compose.yml)** - Infrastructure

### Code Structure
- **[manus-connector/packages/](manus-connector/packages/)** - Shared code
- **[manus-connector/services/](manus-connector/services/)** - Microservices
- **[manus-connector/scripts/](manus-connector/scripts/)** - Automation

## Key Files

### Configuration
- `manus-connector/.env.example` - Environment variables template
- `manus-connector/docker-compose.yml` - Docker infrastructure
- `manus-connector/pnpm-workspace.yaml` - Monorepo workspaces

### Database
- `manus-connector/packages/database/prisma/schema.prisma` - Database schema

### Services
- `manus-connector/services/backend/src/index.ts` - Main API server
- `manus-connector/services/mcp-server/src/index.ts` - MCP protocol
- `manus-connector/services/worker/src/index.ts` - Message queue
- `manus-connector/services/slm-classifier/src/index.ts` - Task classifier

### Scripts
- `manus-connector/scripts/quick-start.sh` - One-command setup
- `manus-connector/scripts/test-connection-flow.sh` - Testing
- `manus-connector/scripts/cleanup.sh` - Clean everything

## Quick Start

```bash
cd manus-connector
./scripts/quick-start.sh
```

## Documentation Flow

1. **First Time?** → Read [README.md](README.md)
2. **Want to Set Up?** → Follow [manus-connector/SETUP.md](manus-connector/SETUP.md)
3. **Need to Understand?** → Read [manus-connector/ARCHITECTURE.md](manus-connector/ARCHITECTURE.md)
4. **Ready to Deploy?** → Follow [manus-connector/DEPLOYMENT.md](manus-connector/DEPLOYMENT.md)
5. **Implementing?** → Use [manus-connector/CHECKLIST.md](manus-connector/CHECKLIST.md)

## Git Workflow

```bash
# Clone repository
git clone <repo-url>
cd manus

# Navigate to connector
cd manus-connector

# Install dependencies
pnpm install

# Start development
./scripts/quick-start.sh
```

## Support

- Check logs: `docker-compose logs -f`
- View metrics: http://localhost:3301
- Review docs in `manus-connector/`
