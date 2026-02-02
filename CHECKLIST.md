# Implementation Checklist

This checklist helps you verify that everything is set up correctly and guides you through the remaining integration steps.

## ✅ What's Already Done

### Infrastructure
- [x] Monorepo structure with pnpm workspaces
- [x] TypeScript configuration for all services
- [x] Docker Compose setup with all services
- [x] Database schema (Prisma)
- [x] Environment variable templates

### Services
- [x] Backend API (Fastify)
  - [x] Connection management routes
  - [x] MCP endpoints (fetch/send)
  - [x] Webhook receiver
  - [x] OpenTelemetry tracing
- [x] MCP Server
  - [x] fetch tool implementation
  - [x] send tool implementation
  - [x] stdio transport
- [x] Worker Service
  - [x] BullMQ queue setup
  - [x] Message debouncing
  - [x] Sequential processing per user
- [x] SLM Classifier
  - [x] OpenRouter integration
  - [x] Gemini Flash model
  - [x] Classification endpoint

### Observability
- [x] SigNoz stack configured
- [x] OpenTelemetry in all services
- [x] Distributed tracing
- [x] Metrics collection

### Documentation
- [x] README.md
- [x] SETUP.md
- [x] ARCHITECTURE.md
- [x] DEPLOYMENT.md
- [x] PROJECT_SUMMARY.md

### Scripts
- [x] Quick start script
- [x] Test script
- [x] Cleanup script

## 🔧 What You Need to Do

### 1. Environment Setup

- [ ] Copy `.env.example` to `.env`
- [ ] Add your iMessage credentials:
  ```env
  IMESSAGE_API_KEY=your_actual_key
  IMESSAGE_ENDPOINT=https://your-actual-endpoint.com
  ```
- [ ] Add OpenRouter API key:
  ```env
  OPENROUTER_API_KEY=sk-or-v1-xxx
  ```
  Get one at: https://openrouter.ai
- [ ] Update Photon phone number:
  ```env
  PHOTON_NUMBER=+1234567890
  ```

### 2. iMessage Integration

The following files have `TODO` comments for iMessage integration:

- [ ] **`services/backend/src/routes/connect.ts`**
  - Line ~78: Implement `sendIMessage()` for connection link
  - Line ~135: Implement `sendIMessage()` for MCP config

- [ ] **`services/backend/src/routes/mcp.ts`**
  - Line ~88: Implement `fetchIMessages()` function
  - Line ~108: Implement `sendIMessage()` function

- [ ] **`services/backend/src/routes/webhooks.ts`**
  - Line ~159: Implement `sendIMessage()` function

**Integration Steps:**
1. Install your iMessage SDK: `pnpm add your-imessage-sdk`
2. Create a helper file: `services/backend/src/lib/imessage.ts`
3. Implement the three functions:
   - `fetchIMessages(phoneNumber: string): Promise<Message[]>`
   - `sendIMessage(phoneNumber: string, message: string): Promise<string>`
   - `getChatGuid(phoneNumber: string): Promise<string>`
4. Replace TODO comments with actual implementations

### 3. Manus API Integration

The following files need Manus API integration:

- [ ] **`services/worker/src/index.ts`**
  - Line ~147: Implement `createManusTask()` function
  - Line ~158: Implement `appendToTask()` function

**Integration Steps:**
1. Review Manus API documentation
2. Create helper file: `services/worker/src/lib/manus.ts`
3. Implement task management functions:
   - `createTask(apiKey: string, message: string): Promise<string>`
   - `appendToTask(apiKey: string, taskId: string, message: string): Promise<void>`
   - `getTaskStatus(apiKey: string, taskId: string): Promise<TaskStatus>`

### 4. Testing

- [ ] Start the system:
  ```bash
  ./scripts/quick-start.sh
  ```

- [ ] Run tests:
  ```bash
  ./scripts/test-connection-flow.sh
  ```

- [ ] Test with real credentials:
  - [ ] Send iMessage to initiate connection
  - [ ] Complete token submission
  - [ ] Add MCP config to Manus
  - [ ] Test fetch tool
  - [ ] Test send tool
  - [ ] Test webhook delivery

### 5. Deployment (Optional)

- [ ] Set up production server
- [ ] Configure domain name (e.g., manus.photon.codes)
- [ ] Set up SSL certificates (Let's Encrypt)
- [ ] Configure Nginx reverse proxy
- [ ] Update environment variables for production
- [ ] Deploy with Docker Compose
- [ ] Set up monitoring alerts
- [ ] Configure database backups

## 📋 Pre-Launch Checklist

### Security
- [ ] All API keys stored in environment variables (not in code)
- [ ] Database password is strong and unique
- [ ] Redis is not exposed to public internet
- [ ] HTTPS enabled for all external endpoints
- [ ] Rate limiting configured
- [ ] CORS properly configured

### Performance
- [ ] Database indexes created (already in schema)
- [ ] Connection pooling configured
- [ ] Redis memory limits set
- [ ] Docker resource limits configured
- [ ] SigNoz retention policy set

### Monitoring
- [ ] SigNoz dashboard accessible
- [ ] Health check endpoints working
- [ ] Alerts configured for critical errors
- [ ] Log aggregation working
- [ ] Metrics being collected

### Documentation
- [ ] API endpoints documented
- [ ] Environment variables documented
- [ ] Deployment process documented
- [ ] Troubleshooting guide available
- [ ] Team trained on system

## 🧪 Testing Scenarios

### Connection Flow
- [ ] User sends initial iMessage
- [ ] System creates pending connection
- [ ] User receives link
- [ ] User submits Manus token
- [ ] Webhook registered with Manus
- [ ] User receives MCP config
- [ ] Connection marked as ACTIVE

### Message Processing
- [ ] User sends single message → processed correctly
- [ ] User sends rapid messages → debounced and combined
- [ ] NEW_TASK classified correctly
- [ ] FOLLOW_UP classified correctly
- [ ] Messages queued per user
- [ ] Processing is sequential per user

### Webhook Handling
- [ ] task_created → confirmation sent
- [ ] task_progress → throttled correctly
- [ ] task_stopped (finish) → results sent
- [ ] task_stopped (ask) → question sent
- [ ] All messages prefixed with [Manus]
- [ ] Messages recorded in database

### MCP Tools
- [ ] fetch tool returns filtered messages
- [ ] send tool delivers messages
- [ ] Authentication works correctly
- [ ] Error handling works
- [ ] Timeouts handled gracefully

## 🐛 Common Issues & Solutions

### Issue: Services won't start
**Solution:**
```bash
docker-compose down -v
docker-compose up -d
```

### Issue: Database connection failed
**Solution:**
```bash
docker-compose logs postgres
# Wait for "database system is ready to accept connections"
```

### Issue: Prisma client not generated
**Solution:**
```bash
pnpm --filter @imessage-mcp/database generate
```

### Issue: Port already in use
**Solution:**
Edit `docker-compose.yml` and change conflicting ports

### Issue: Environment variables not loaded
**Solution:**
```bash
# Make sure .env exists
cp .env.example .env
# Edit .env with your values
# Restart services
docker-compose restart
```

## 📊 Success Metrics

After implementation, you should see:

- [ ] All services running (check `docker-compose ps`)
- [ ] All health checks passing
- [ ] SigNoz dashboard showing traces
- [ ] Messages being processed in <5 seconds
- [ ] SLM classification in <500ms
- [ ] Zero errors in logs (except expected ones)
- [ ] Database queries optimized (check SigNoz)

## 🎯 Next Steps After Completion

1. **Beta Testing**
   - Test with 5-10 users
   - Collect feedback
   - Monitor performance

2. **Optimization**
   - Review SigNoz metrics
   - Optimize slow queries
   - Tune queue settings

3. **Feature Additions**
   - Message attachments
   - Group chats
   - Voice messages

4. **Scale Preparation**
   - Load testing
   - Database optimization
   - Caching layer

## 📞 Getting Help

If you get stuck:

1. **Check logs:**
   ```bash
   docker-compose logs -f [service-name]
   ```

2. **Check SigNoz:**
   http://localhost:3301

3. **Review documentation:**
   - SETUP.md - Setup instructions
   - ARCHITECTURE.md - System design
   - DEPLOYMENT.md - Production deployment

4. **Common commands:**
   ```bash
   # Restart everything
   docker-compose restart
   
   # View all logs
   docker-compose logs -f
   
   # Check service status
   docker-compose ps
   
   # Open database GUI
   pnpm db:studio
   ```

---

**Good luck with your implementation! 🚀**
