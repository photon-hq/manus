# MCP HTTP Transport Implementation

## Overview

This document explains the HTTP-based MCP transport implementation added to resolve CloudFlare HTTP/2 + SSE incompatibility issues.

## Problem

The original SSE-based MCP implementation (`/mcp`) failed when accessed through CloudFlare due to HTTP/2 incompatibility:

1. Client establishes SSE connection (GET `/mcp`)
2. Server sends initial `event: endpoint` with session ID
3. **CloudFlare aborts the HTTP/2 stream immediately**
4. Backend removes session from `activeConnections`
5. Client's subsequent POST requests return 404 (session not found)

This made the MCP server unusable through CloudFlare proxy.

## Solution

Implemented a **Streamable HTTP** transport using the MCP SDK's `StreamableHTTPServerTransport` class. This transport uses standard HTTP POST requests instead of long-lived SSE connections, completely bypassing CloudFlare's HTTP/2 issues.

## Architecture

### SSE Transport (Original - BROKEN through CloudFlare)
- Endpoint: `/mcp`
- Method: GET (establish SSE) + POST (send messages)
- Session management: In-memory `activeConnections` map
- State: Stateful (session-based)
- CloudFlare compatible: ❌ No (HTTP/2 stream aborted)

### HTTP Transport (New - WORKING through CloudFlare)
- Endpoint: `/mcp/http`
- Method: POST only
- Session management: None (stateless)
- State: Stateless (each request is independent)
- CloudFlare compatible: ✅ Yes (standard HTTP POST)

## Configuration

### Manus Workbench Configuration

Update your MCP server configuration from SSE to HTTP:

**Before (SSE):**
```json
{
  "mcpServers": {
    "photon-imessage": {
      "type": "sse",
      "url": "https://manus.photon.codes/mcp",
      "headers": {
        "Authorization": "Bearer ph_live_NXtdeP1YFWwrrq1f7KgaGB4X"
      }
    }
  }
}
```

**After (HTTP):**
```json
{
  "mcpServers": {
    "photon-imessage": {
      "type": "streamableHttp",
      "url": "https://manus.photon.codes/mcp/http",
      "headers": {
        "Content-Type": "application/json",
        "Authorization": "Bearer ph_live_NXtdeP1YFWwrrq1f7KgaGB4X"
      }
    }
  }
}
```

## Implementation Details

### File Structure

- **`services/backend/src/routes/mcp-http.ts`** - HTTP transport implementation
- **`services/backend/src/routes/mcp-sse.ts`** - Original SSE transport (kept for backward compatibility)
- **`services/backend/src/routes/mcp.ts`** - REST endpoints (unchanged)

### Key Features

1. **Stateless Design**: No session management, each request is independent
2. **Authentication**: Bearer token validated on every request
3. **Tool Support**: Same `fetch` and `send` tools as SSE implementation
4. **Error Handling**: Proper error responses for invalid auth, revoked connections
5. **Origin Validation**: DNS rebinding attack protection

### Authentication Flow

1. Extract `Authorization: Bearer <photonApiKey>` header
2. Query database: `prisma.connection.findUnique({ where: { photonApiKey } })`
3. Validate connection status is `ACTIVE`
4. Process request with connection context

### Available Tools

#### `fetch`
- **Description**: Fetch conversation history from iMessage
- **Input**: None
- **Output**: Last 100 messages, filtered to exclude Manus-generated messages

#### `send`
- **Description**: Send a message to the user via iMessage
- **Input**: 
  - `message` (string, required): Message text
  - `attachments` (array, optional): File attachments with `url`, `filename`, `size_bytes`
- **Output**: Confirmation with message GUIDs

## Testing

### Production Testing (through CloudFlare)

```bash
# Test initialize
curl -X POST https://manus.photon.codes/mcp/http \
  -H "Authorization: Bearer ph_live_NXtdeP1YFWwrrq1f7KgaGB4X" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "test", "version": "1.0.0"}
    }
  }'

# Test tools/list
curl -X POST https://manus.photon.codes/mcp/http \
  -H "Authorization: Bearer ph_live_NXtdeP1YFWwrrq1f7KgaGB4X" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

### Using manus-mcp-cli

```bash
manus-mcp-cli tool list --server photon-imessage
```

## Advantages of HTTP Transport

1. **CloudFlare Compatible**: Standard HTTP POST works through any proxy
2. **Simpler Architecture**: No session management or connection tracking
3. **Better Reliability**: No connection drops or timeouts
4. **Easier Debugging**: Standard request/response pattern
5. **Horizontal Scaling**: Stateless design scales easily across multiple servers

## Limitations

- **No Server-Initiated Notifications**: Server can't push updates to client (not needed for current use case)
- **Slightly Higher Latency**: Each tool call requires a new HTTP request (minimal impact)

## Backward Compatibility

The SSE endpoint (`/mcp`) remains functional for clients that can use it directly without CloudFlare. Both transports can coexist:

- `/mcp` - SSE transport (stateful, session-based)
- `/mcp/http` - HTTP transport (stateless, CloudFlare-compatible)
- `/mcp/fetch` - REST fetch endpoint
- `/mcp/send` - REST send endpoint

## Troubleshooting

### 401 Unauthorized
- **Cause**: Invalid or missing API key
- **Solution**: Verify the `Authorization: Bearer <photonApiKey>` header is correct

### 403 Forbidden
- **Cause**: Connection revoked or unauthorized origin
- **Solution**: Reconnect at https://manus.photon.codes/connect

### 500 Internal Server Error
- **Cause**: Server-side error (check logs)
- **Solution**: Check Dokploy logs for detailed error messages

## References

- [MCP SDK Documentation](https://github.com/modelcontextprotocol/typescript-sdk)
- [Streamable HTTP Specification](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/)
- [CloudFlare HTTP/2 Documentation](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/)
