# Setup Guide

This guide will help you set up and run the iMessage MCP Integration System.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** >= 20.0.0
- **pnpm** >= 8.0.0
- **Docker** and **Docker Compose**
- **Git**

## Installation

### 1. Clone the repository (if not already done)

```bash
cd /Users/vandit/Desktop/manus
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```env
# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/manus_imessage
DB_PASSWORD=password

# Redis
REDIS_URL=redis://localhost:6379

# iMessage Integration (your advanced-imessage-kit credentials)
IMESSAGE_API_KEY=your_imessage_api_key
IMESSAGE_ENDPOINT=https://your-imessage-endpoint.com

# LLM Provider (get from https://openrouter.ai)
OPENROUTER_API_KEY=your_openrouter_key

# SigNoz (default is fine for local development)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# App Config
PORT=3000
NODE_ENV=development
PHOTON_NUMBER=+1234567890
```

### 4. Start infrastructure services

```bash
docker-compose up -d postgres redis clickhouse signoz-otel-collector signoz-query-service signoz-frontend
```

Wait for services to be ready (about 30 seconds):

```bash
docker-compose ps
```

### 5. Run database migrations

```bash
pnpm db:generate
pnpm db:migrate
```

### 6. Start all application services

**Option A: Development mode (recommended for local development)**

```bash
pnpm dev
```

This will start all services with hot-reload enabled.

**Option B: Docker mode (production-like)**

```bash
docker-compose up -d
```

## Verify Installation

### Check service health

1. **Backend API**: http://localhost:3000/health
2. **SLM Classifier**: http://localhost:3001/health
3. **SigNoz Dashboard**: http://localhost:3301

### View logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend
```

## Development Workflow

### Running individual services

```bash
# Backend only
pnpm --filter backend dev

# Worker only
pnpm --filter worker dev

# SLM Classifier only
pnpm --filter slm-classifier dev
```

### Database operations

```bash
# Open Prisma Studio (database GUI)
pnpm db:studio

# Create a new migration
pnpm db:migrate

# Reset database (WARNING: deletes all data)
make reset-db
```

### View observability data

Open SigNoz dashboard at http://localhost:3301 to view:
- Request traces
- Service metrics
- Error logs
- Performance analytics

## Testing the Connection Flow

### 1. Initiate connection

```bash
curl -X POST http://localhost:3000/api/connect/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+1234567890",
    "message": "Hey! Please connect my iMessage to Manus"
  }'
```

Response will include a `connectionId`.

### 2. Visit the connection page

Open in browser:
```
http://localhost:3000/api/connect/page/{connectionId}
```

### 3. Submit Manus API key

Enter your Manus API key (format: `manus_sk_...`) in the form.

### 4. Get MCP config

After successful connection, you'll receive:
- `photonApiKey` - Your unique Photon API key
- `mcpConfig` - Configuration to add to Manus

### 5. Test MCP tools

```bash
# Fetch messages
curl http://localhost:3000/api/mcp/fetch \
  -H "Authorization: Bearer photon_sk_..."

# Send message
curl -X POST http://localhost:3000/api/mcp/send \
  -H "Authorization: Bearer photon_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from MCP!"}'
```

## Troubleshooting

### Services won't start

```bash
# Check Docker services
docker-compose ps

# View logs
docker-compose logs

# Restart services
docker-compose restart
```

### Database connection issues

```bash
# Check PostgreSQL is running
docker-compose ps postgres

# Reset database
make reset-db
```

### Port conflicts

If ports 3000, 3001, 5432, 6379, or 3301 are already in use, you can change them in `docker-compose.yml`.

### Clear all data and restart

```bash
docker-compose down -v
rm -rf node_modules packages/*/node_modules services/*/node_modules
pnpm install
docker-compose up -d postgres redis
pnpm db:migrate
pnpm dev
```

## Next Steps

1. **Configure iMessage Integration**: Set up your `advanced-imessage-kit` credentials
2. **Get OpenRouter API Key**: Sign up at https://openrouter.ai
3. **Test with Manus**: Add the MCP config to your Manus AI instance
4. **Monitor with SigNoz**: Check http://localhost:3301 for observability data

## Production Deployment

For production deployment:

1. Update environment variables for production
2. Use `docker-compose.yml` with production settings
3. Set up SSL/TLS certificates
4. Configure domain name
5. Set up monitoring and alerts
6. Enable database backups

See `DEPLOYMENT.md` for detailed production deployment instructions.
