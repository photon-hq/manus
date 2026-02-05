# Dokploy SSE Configuration for MCP

## Problem
The MCP endpoint (`/mcp`) uses Server-Sent Events (SSE), which requires special reverse proxy configuration. Without proper configuration, you'll get 502 Bad Gateway errors when trying to connect via `manus-mcp-cli`.

## Solution

### Step 1: Configure Traefik Labels in Dokploy

In your Dokploy application settings, add the following **Custom Labels** (or Traefik labels):

#### For the entire service:
```yaml
traefik.http.services.manus-backend.loadbalancer.server.port=3000
```

#### For SSE-specific middleware (disable buffering):
```yaml
traefik.http.middlewares.sse-headers.headers.customresponseheaders.X-Accel-Buffering=no
traefik.http.middlewares.sse-headers.headers.customresponseheaders.Cache-Control=no-cache, no-transform
traefik.http.middlewares.sse-buffering.buffering.maxRequestBodyBytes=0
traefik.http.middlewares.sse-buffering.buffering.maxResponseBodyBytes=0
traefik.http.middlewares.sse-buffering.buffering.memRequestBodyBytes=0
traefik.http.middlewares.sse-buffering.buffering.memResponseBodyBytes=0
```

#### Apply middleware to your router:
```yaml
traefik.http.routers.manus-backend.middlewares=sse-headers,sse-buffering
```

### Step 2: Verify Application Binding

Ensure your backend is binding to `0.0.0.0:3000` (not `127.0.0.1`). This is already configured correctly in the Dockerfile.

### Step 3: Check Domain Configuration

1. Ensure your domain is pointed to your server's IP **before** adding it in Dokploy
2. Let the SSL certificate generate properly
3. If you already added the domain, you may need to:
   - Delete and recreate the domain in Dokploy, OR
   - Restart Traefik

### Step 4: Test the Connection

After applying the labels and redeploying:

```bash
# Test basic connectivity
curl -I https://manus.photon.codes/health

# Test MCP endpoint (should get 401 without auth)
curl -I https://manus.photon.codes/mcp

# Test with CLI
manus-mcp-cli tool list --server photon-imessage
```

## Alternative: Use Dokploy's Advanced Settings

If custom labels don't work, you can try:

1. Go to your application in Dokploy
2. Navigate to "Advanced" settings
3. Add a custom Traefik configuration file
4. Create a file with these contents:

```yaml
http:
  middlewares:
    sse-buffering:
      buffering:
        maxRequestBodyBytes: 0
        maxResponseBodyBytes: 0
        memRequestBodyBytes: 0
        memResponseBodyBytes: 0
    sse-headers:
      headers:
        customResponseHeaders:
          X-Accel-Buffering: "no"
          Cache-Control: "no-cache, no-transform"
  
  routers:
    manus-backend:
      middlewares:
        - sse-buffering
        - sse-headers
```

## Debugging

### Check Traefik Logs
```bash
# SSH into your Dokploy server
docker logs traefik

# Or check Dokploy's Traefik container
docker ps | grep traefik
docker logs <traefik-container-id>
```

### Check Backend Logs
In Dokploy UI:
1. Go to your application
2. Click "Logs"
3. Look for SSE connection attempts

### Test Direct Connection (Bypass Proxy)
If you have SSH access:
```bash
# SSH into server
curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:3000/mcp
```

If this works but the public URL doesn't, it's definitely a proxy configuration issue.

## Common Issues

### Issue: 502 Bad Gateway
**Cause:** Traefik is buffering the SSE connection or timing out
**Solution:** Apply the buffering middleware labels above

### Issue: Connection times out after 60 seconds
**Cause:** Default proxy timeout is too short for long-lived SSE connections
**Solution:** Add timeout configuration:
```yaml
traefik.http.services.manus-backend.loadbalancer.responseforwardingtimeouts.readTimeout=3600s
traefik.http.services.manus-backend.loadbalancer.responseforwardingtimeouts.writeTimeout=3600s
```

### Issue: 404 Not Found
**Cause:** Routing is not configured correctly
**Solution:** Verify the domain is properly configured and the backend is running

## References
- [Traefik Buffering Documentation](https://doc.traefik.io/traefik/middlewares/http/buffering/)
- [Dokploy Troubleshooting](https://docs.dokploy.com/docs/core/troubleshooting)
- [SSE Proxy Configuration Best Practices](https://tyk.io/docs/advanced-configuration/sse-proxy)
