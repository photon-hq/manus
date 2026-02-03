# Photon iMessage MCP Server

MCP (Model Context Protocol) server for integrating iMessage with Manus AI through Photon's infrastructure.

## What This Does

This package allows Manus AI to interact with your iMessages through two tools:

- **fetch**: Retrieve your iMessage conversation history
- **send**: Send iMessages directly from Manus AI

## Prerequisites

- Node.js 18 or higher
- A Photon API key (get one at [manus.photon.codes](https://manus.photon.codes))
- Manus AI account

## Getting Started

### 1. Get Your API Key

Visit [manus.photon.codes](https://manus.photon.codes) and complete the onboarding flow:

1. Enter your phone number or iCloud email
2. Submit your Manus API key
3. Receive your `PHOTON_API_KEY`

### 2. Add to Manus

Copy the MCP configuration provided during onboarding and paste it into your Manus settings at [manus.im/settings/mcp](https://manus.im/settings/mcp):

```json
{
  "mcpServers": {
    "photon-imessage": {
      "command": "npx",
      "args": ["@photon-ai/manus-mcp@latest"],
      "env": {
        "PHOTON_API_KEY": "photon_sk_your_key_here",
        "BACKEND_URL": "https://manus.photon.codes"
      }
    }
  }
}
```

### 3. Use in Manus

Once configured, you can use these commands in Manus:

- "Fetch my recent iMessages"
- "Send an iMessage to [contact]"
- "Check my iMessage conversations"

## Configuration

### Environment Variables

- `PHOTON_API_KEY` (required): Your Photon API key from the onboarding flow
- `BACKEND_URL` (optional): Photon backend URL (defaults to `https://manus.photon.codes`)

## Tools Available

### fetch

Retrieves your iMessage conversation history (last 100 messages).

**Usage in Manus:**
```
"Show me my recent iMessages"
```

**Returns:** JSON array of messages with sender, recipient, text, and timestamp.

### send

Sends an iMessage to a contact.

**Usage in Manus:**
```
"Send an iMessage saying 'Hello!' to +1234567890"
```

**Parameters:**
- `message` (string): The message text to send

**Returns:** Confirmation with message GUID.

## Troubleshooting

### "PHOTON_API_KEY environment variable is required"

Make sure your MCP configuration includes the `PHOTON_API_KEY` in the `env` section.

### "Backend API error: 401 Unauthorized"

Your API key may be invalid or revoked. Visit [manus.photon.codes](https://manus.photon.codes) to generate a new one.

### "Backend API error: 404 Connection not found"

Your connection may have been revoked. Complete the onboarding flow again to create a new connection.

### Connection Issues

If the MCP server can't connect to the backend:

1. Check your internet connection
2. Verify `BACKEND_URL` is set correctly
3. Try running with explicit URL: `BACKEND_URL=https://manus.photon.codes npx @photon-ai/manus-mcp@latest`

## Support

- Documentation: [manus.photon.codes](https://manus.photon.codes)
- Issues: [GitHub Issues](https://github.com/photon-hq/manus-backend/issues)

## Privacy & Security

- Your API key is used only to authenticate with Photon's backend
- Messages are fetched and sent through Photon's secure iMessage infrastructure
- No message content is stored by this package
- All communication is encrypted (HTTPS)

## License

MIT
