#!/usr/bin/env node
import './tracing.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const PHOTON_API_KEY = process.env.PHOTON_API_KEY;

if (!PHOTON_API_KEY) {
  console.error('Error: PHOTON_API_KEY environment variable is required');
  process.exit(1);
}

// Create MCP server
const server = new Server(
  {
    name: 'photon-imessage',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'fetch',
        description: 'Fetch conversation history from iMessage. Returns the last 100 messages between the user and Photon, filtered to exclude Manus-generated messages.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'send',
        description: 'Send a message to the user via iMessage. The message will be prefixed with [Manus] to indicate it came from the AI assistant.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message text to send to the user',
            },
          },
          required: ['message'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'fetch': {
        // Fetch messages from backend
        const response = await fetch(`${BACKEND_URL}/api/mcp/fetch`, {
          headers: {
            Authorization: `Bearer ${PHOTON_API_KEY}`,
          },
        });

        if (!response.ok) {
          throw new Error(`Backend API error: ${response.statusText}`);
        }

        const data = await response.json();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data.messages, null, 2),
            },
          ],
        };
      }

      case 'send': {
        const { message } = args as { message: string };

        if (!message) {
          throw new Error('Message is required');
        }

        // Send message via backend
        const response = await fetch(`${BACKEND_URL}/api/mcp/send`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${PHOTON_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message }),
        });

        if (!response.ok) {
          throw new Error(`Backend API error: ${response.statusText}`);
        }

        const data = await response.json();

        return {
          content: [
            {
              type: 'text',
              text: `Message sent successfully. GUID: ${data.messageGuid}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Photon iMessage MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
