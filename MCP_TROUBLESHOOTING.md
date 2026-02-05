# MCP Connection Troubleshooting Guide

## Quick Diagnosis

### Step 1: Test Basic Connectivity
```bash
# Test if backend is reachable
curl https://manus.photon.codes/health

# Expected: {"status":"ok"}
```

### Step 2: Test SSE Functionality
```bash
# Test if SSE works through the proxy
curl https://manus.photon.codes/debug/sse

# Expected: Stream of messages for 5 seconds
# data: {"message": "SSE connection established"}
# data: {"count": 1, "timestamp": "..."}
# ...
```

### Step 3: Check Proxy Headers
```bash
# Check what headers the proxy is sending
curl https://manus.photon.codes/debug/proxy

# Look for:
# - x-forwarded-for, x-forwarded-proto headers (indicates proxy is working)
# - trustProxy: true (indicates Fastify is configured correctly)
```

### Step 4: Test MCP Endpoint (Without Auth)
```bash
# Should return 401 (auth required)
curl -i https://manus.photon.codes/mcp

# Expected: HTTP 401 with error message
# If you get 502, the proxy is not reaching the backend
```

### Step 5: Test MCP Endpoint (With Auth)
```bash
# Replace YOUR_API_KEY with actual API key
curl -H "Authorization: Bearer YOUR_API_KEY" https://manus.photon.codes/mcp

# Expected: SSE connection starts
# If you get 502, the proxy is blocking SSE
```

## Common Error Messages

### Error: "502 Bad Gateway"

**Symptom:**
```
Error: failed to create connection: OAuth authentication failed: failed to initialize client: transport error: request failed with status 502: error code: 502
```

**Possible Causes:**

1. **Traefik is buffering the SSE connection**
   - Solution: Add Traefik labels to disable buffering (see DOKPLOY_SSE_CONFIG.md)

2. **Backend is not running or not reachable**
   - Check: `curl https://manus.photon.codes/health`
   - Solution: Restart the backend service in Dokploy

3. **Port mismatch**
   - Check: Backend should expose port 3000
   - Solution: Verify Dockerfile EXPOSE 3000 and Dokploy port mapping

4. **SSL/TLS issues**
   - Check: Certificate is valid and not expired
   - Solution: Regenerate certificate in Dokploy

### Error: "Connection timeout"

**Symptom:**
Connection starts but times out after 30-60 seconds

**Solution:**
Add timeout configuration to Traefik labels:
```yaml
traefik.http.services.manus-backend.loadbalancer.responseforwardingtimeouts.readTimeout=3600s
traefik.http.services.manus-backend.loadbalancer.responseforwardingtimeouts.writeTimeout=3600s
```

### Error: "Invalid or inactive API key"

**Symptom:**
```
Error: failed to create connection: OAuth authentication failed: failed to initialize client: transport error: request failed with status 401
```

**Solution:**
1. Check your API key in the MCP client configuration
2. Verify the connection is ACTIVE in the database:
   ```sql
   SELECT * FROM "Connection" WHERE "photonApiKey" = 'your-api-key';
   ```
3. If status is not ACTIVE, reconnect at https://manus.photon.codes/connect

## Debugging Steps

### 1. Check Backend Logs

In Dokploy:
1. Go to your application
2. Click "Logs" tab
3. Look for:
   - `SSE connection established` - indicates successful connection
   - `Failed to establish SSE connection` - indicates error
   - Any error stack traces

### 2. Check Traefik Logs

SSH into your server:
```bash
# Find Traefik container
docker ps | grep traefik

# View logs
docker logs <traefik-container-id> --tail 100 -f

# Look for:
# - 502 errors
# - Timeout errors
# - Routing errors
```

### 3. Test Direct Connection (Bypass Proxy)

SSH into your server:
```bash
# Test backend directly (should work if backend is healthy)
curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:3000/mcp

# If this works but public URL doesn't, it's a proxy issue
```

### 4. Verify Database Connection

```bash
# SSH into server
docker exec -it <postgres-container> psql -U postgres -d manus_imessage

# Check connections
SELECT "phoneNumber", "status", "photonApiKey" FROM "Connection";

# Verify API key exists and status is ACTIVE
```

### 5. Check Environment Variables

In Dokploy, verify these environment variables are set:
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `IMESSAGE_SERVER_URL` - Photon iMessage server URL
- `IMESSAGE_API_KEY` - Photon iMessage API key
- `PUBLIC_URL` - Your public URL (https://manus.photon.codes)
- `NODE_ENV` - Should be "production"

## Resolution Checklist

- [ ] Backend health check passes (`/health` returns 200)
- [ ] SSE test endpoint works (`/debug/sse` streams messages)
- [ ] Proxy headers are present (`/debug/proxy` shows x-forwarded-* headers)
- [ ] MCP endpoint returns 401 without auth (not 502)
- [ ] Traefik labels are configured for SSE (see DOKPLOY_SSE_CONFIG.md)
- [ ] Backend is binding to 0.0.0.0:3000 (not 127.0.0.1)
- [ ] Domain SSL certificate is valid
- [ ] API key is valid and connection status is ACTIVE
- [ ] Backend logs show no errors

## Still Not Working?

### Option 1: Restart Everything
```bash
# In Dokploy UI
1. Stop the application
2. Wait 10 seconds
3. Start the application
4. Check logs for startup errors
```

### Option 2: Rebuild and Redeploy
```bash
# In Dokploy UI
1. Go to application settings
2. Click "Rebuild"
3. Wait for build to complete
4. Check logs
```

### Option 3: Check Dokploy System Status
```bash
# SSH into server
docker ps  # All containers should be running
docker stats  # Check resource usage

# Restart Traefik if needed
docker restart <traefik-container-id>
```

### Option 4: Contact Support

If none of the above works, gather this information:
1. Output of `/health` endpoint
2. Output of `/debug/sse` endpoint
3. Output of `/debug/proxy` endpoint
4. Backend logs (last 100 lines)
5. Traefik logs (last 100 lines)
6. Your Dokploy Traefik labels configuration

## Additional Resources

- [DOKPLOY_SSE_CONFIG.md](./DOKPLOY_SSE_CONFIG.md) - Detailed Traefik configuration
- [Dokploy Troubleshooting](https://docs.dokploy.com/docs/core/troubleshooting)
- [Traefik SSE Configuration](https://doc.traefik.io/traefik/middlewares/http/buffering/)
