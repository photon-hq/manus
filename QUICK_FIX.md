# Quick Fix for MCP 502 Error

## TL;DR
The 502 error is caused by Dokploy's Traefik reverse proxy not being configured for Server-Sent Events (SSE). Apply the Traefik labels below to fix it.

## Immediate Action Required

### Step 1: Add Traefik Labels in Dokploy

1. Open your Dokploy dashboard
2. Navigate to your Manus backend application
3. Go to "Advanced" or "Labels" section
4. Add these labels:

```yaml
# Disable buffering for SSE
traefik.http.middlewares.manus-sse.buffering.maxRequestBodyBytes=0
traefik.http.middlewares.manus-sse.buffering.maxResponseBodyBytes=0
traefik.http.middlewares.manus-sse.buffering.memRequestBodyBytes=0
traefik.http.middlewares.manus-sse.buffering.memResponseBodyBytes=0

# Add SSE-specific headers
traefik.http.middlewares.manus-sse-headers.headers.customresponseheaders.X-Accel-Buffering=no
traefik.http.middlewares.manus-sse-headers.headers.customresponseheaders.Cache-Control=no-cache, no-transform

# Set timeouts for long-lived connections
traefik.http.services.manus-backend.loadbalancer.responseforwardingtimeouts.readTimeout=3600s
traefik.http.services.manus-backend.loadbalancer.responseforwardingtimeouts.writeTimeout=3600s

# Apply middlewares to router
traefik.http.routers.manus-backend.middlewares=manus-sse,manus-sse-headers
```

**Note:** Replace `manus-backend` with your actual service/router name in Dokploy if it's different.

### Step 2: Deploy Updated Backend Code

The code changes I made include:
- Added SSE-friendly headers (`X-Accel-Buffering: no`)
- Increased Fastify timeouts for long-lived connections
- Added `trustProxy: true` for proper proxy header handling
- Added debug endpoints for troubleshooting

Deploy the changes:
```bash
# Commit and push
git add .
git commit -m "fix: add SSE proxy support and debug endpoints for MCP"
git push origin main

# Then in Dokploy, trigger a rebuild/redeploy
```

### Step 3: Test the Fix

After redeploying, test in order:

```bash
# 1. Test basic health
curl https://manus.photon.codes/health
# Expected: {"status":"ok"}

# 2. Test SSE functionality
curl https://manus.photon.codes/debug/sse
# Expected: Stream of 5 messages over 5 seconds

# 3. Test MCP connection
manus-mcp-cli tool list --server photon-imessage
# Expected: List of tools (fetch, send)
```

## If Still Not Working

### Check Traefik Label Format

Dokploy might require labels in a different format. Try these alternatives:

**Format 1: Dot notation (most common)**
```
traefik.http.middlewares.manus-sse.buffering.maxRequestBodyBytes=0
```

**Format 2: Docker Compose style**
```yaml
labels:
  - "traefik.http.middlewares.manus-sse.buffering.maxRequestBodyBytes=0"
```

**Format 3: Dokploy UI (key-value pairs)**
```
Key: traefik.http.middlewares.manus-sse.buffering.maxRequestBodyBytes
Value: 0
```

### Verify Labels Are Applied

SSH into your server and check:
```bash
# Find your backend container
docker ps | grep backend

# Inspect labels
docker inspect <container-id> | grep -A 20 Labels

# Should see your traefik labels
```

### Restart Traefik

Sometimes Traefik needs a restart to pick up new labels:
```bash
# Find Traefik container
docker ps | grep traefik

# Restart it
docker restart <traefik-container-id>
```

## Alternative: Nginx Proxy

If Traefik continues to cause issues, you can add an nginx sidecar:

```yaml
# In docker-compose.prod.yml
services:
  nginx:
    image: nginx:alpine
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - backend
    ports:
      - "8080:80"
```

```nginx
# nginx.conf
events {
    worker_connections 1024;
}

http {
    upstream backend {
        server backend:3000;
    }

    server {
        listen 80;
        
        location /mcp {
            proxy_pass http://backend;
            proxy_http_version 1.1;
            proxy_set_header Connection '';
            proxy_set_header X-Accel-Buffering no;
            proxy_buffering off;
            proxy_cache off;
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
        }
        
        location / {
            proxy_pass http://backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
    }
}
```

## What Changed in the Code

1. **Backend server configuration** (`services/backend/src/index.ts`):
   - Added `connectionTimeout: 0` - Disables timeout for SSE
   - Added `keepAliveTimeout: 72000` - Keeps connections alive longer
   - Added `trustProxy: true` - Trusts proxy headers

2. **MCP SSE route** (`services/backend/src/routes/mcp-sse.ts`):
   - Added `X-Accel-Buffering: no` header - Disables nginx buffering
   - Added `Cache-Control: no-cache, no-transform` - Prevents caching

3. **Debug endpoints** (`services/backend/src/index.ts`):
   - `/debug/proxy` - Shows proxy headers and configuration
   - `/debug/sse` - Tests SSE functionality through the proxy

## Need More Help?

See the detailed guides:
- [MCP_TROUBLESHOOTING.md](./MCP_TROUBLESHOOTING.md) - Complete troubleshooting guide
- [DOKPLOY_SSE_CONFIG.md](./DOKPLOY_SSE_CONFIG.md) - Detailed Traefik configuration

Or contact support with:
1. Output of all three test commands above
2. Backend logs from Dokploy
3. Traefik logs (if accessible)
