# Production Deployment Guide

This guide covers deploying the iMessage MCP Integration System to production.

## Prerequisites

- Docker and Docker Compose installed on production server
- Domain name configured (e.g., `manus.photon.codes`)
- SSL certificates (Let's Encrypt recommended)
- PostgreSQL database (can use Docker or managed service)
- Redis instance (can use Docker or managed service)

## Deployment Options

### Option 1: Docker Compose (Recommended for single server)

1. **Prepare production environment**

```bash
# On your production server
cd /opt/manus
git clone <your-repo-url> .
```

2. **Set up environment variables**

```bash
cp .env.example .env.production
nano .env.production
```

Update with production values:

```env
DATABASE_URL=postgresql://user:password@your-db-host:5432/manus_imessage
DB_PASSWORD=<strong-password>
REDIS_URL=redis://your-redis-host:6379
IMESSAGE_API_KEY=<your-production-key>
IMESSAGE_ENDPOINT=<your-production-endpoint>
OPENROUTER_API_KEY=<your-key>
NODE_ENV=production
PUBLIC_URL=https://manus.photon.codes
```

3. **Build and start services**

```bash
docker-compose -f docker-compose.yml --env-file .env.production up -d
```

4. **Run migrations**

```bash
docker-compose exec backend pnpm db:migrate
```

5. **Set up reverse proxy (Nginx)**

```nginx
# /etc/nginx/sites-available/manus
server {
    listen 80;
    server_name manus.photon.codes;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name manus.photon.codes;

    ssl_certificate /etc/letsencrypt/live/manus.photon.codes/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/manus.photon.codes/privkey.pem;

    # Backend API
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Connection pages
    location /manus/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SigNoz dashboard
    location /observability/ {
        proxy_pass http://localhost:3301/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

Enable and restart Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/manus /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Option 2: Kubernetes (For scalable deployments)

See `k8s/` directory for Kubernetes manifests (to be created).

## Security Checklist

- [ ] Use strong passwords for database and Redis
- [ ] Enable SSL/TLS for all external connections
- [ ] Set up firewall rules (only expose 80, 443)
- [ ] Use environment variables for secrets (never commit to git)
- [ ] Enable rate limiting on API endpoints
- [ ] Set up monitoring and alerting
- [ ] Regular security updates for Docker images
- [ ] Backup database regularly

## Monitoring

### SigNoz Dashboard

Access at: `https://manus.photon.codes/observability/`

Key metrics to monitor:
- Request latency (p50, p95, p99)
- Error rates
- Queue depth (Redis)
- Database connection pool
- Memory and CPU usage

### Health Checks

Set up monitoring for:
- Backend: `https://manus.photon.codes/api/health`
- SLM Classifier: Internal only (via Docker network)

### Logs

View logs:

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend

# Last 100 lines
docker-compose logs --tail=100 backend
```

## Backup and Recovery

### Database Backup

```bash
# Automated daily backup
0 2 * * * docker exec manus-postgres pg_dump -U postgres manus_imessage | gzip > /backups/manus_$(date +\%Y\%m\%d).sql.gz
```

### Restore from backup

```bash
gunzip < /backups/manus_20260202.sql.gz | docker exec -i manus-postgres psql -U postgres manus_imessage
```

## Scaling

### Horizontal Scaling

To scale workers:

```bash
docker-compose up -d --scale worker=3
```

### Vertical Scaling

Update resource limits in `docker-compose.yml`:

```yaml
services:
  backend:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

## Troubleshooting

### High Memory Usage

```bash
# Check memory usage
docker stats

# Restart service
docker-compose restart backend
```

### Database Connection Pool Exhausted

Increase pool size in Prisma:

```typescript
// packages/database/src/index.ts
new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  // Increase connection pool
  pool: {
    min: 5,
    max: 20,
  },
});
```

### Redis Connection Issues

```bash
# Check Redis
docker-compose exec redis redis-cli ping

# Clear Redis (WARNING: deletes all queue data)
docker-compose exec redis redis-cli FLUSHALL
```

## Maintenance

### Update Dependencies

```bash
pnpm update --latest
pnpm install
docker-compose build
docker-compose up -d
```

### Database Migrations

```bash
# Create migration
pnpm db:migrate

# Deploy to production
docker-compose exec backend pnpm db:migrate
```

### Rolling Updates

```bash
# Update one service at a time
docker-compose up -d --no-deps --build backend
docker-compose up -d --no-deps --build worker
```

## Support

For issues or questions:
- Check logs: `docker-compose logs`
- Review SigNoz dashboard: `https://manus.photon.codes/observability/`
- Check GitHub issues
- Contact support team
