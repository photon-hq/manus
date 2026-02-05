import { FastifyPluginAsync } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { prisma, Status } from '@imessage-mcp/database';
import { formatManusMessage, splitMessageByParagraphs, stripMarkdownFormatting } from '@imessage-mcp/shared';
import { z } from 'zod';

const SendMessageSchema = z.object({
  message: z.string(),
});

// Track active connections
const activeConnections = new Map<string, { server: Server; transport: SSEServerTransport; phoneNumber: string }>();

// Connection timeout (1 hour)
const CONNECTION_TIMEOUT_MS = 60 * 60 * 1000;

export const mcpSSERoutes: FastifyPluginAsync = async (fastify) => {
  // GET /mcp - Establish SSE connection
  fastify.get('/', async (request, reply) => {
    try {
      // Extract and validate API key
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        // If accessed from browser (no auth header), redirect to /connect
        const acceptHeader = request.headers.accept || '';
        if (acceptHeader.includes('text/html')) {
          return reply.redirect(301, '/connect');
        }
        return reply.code(401).send({ error: 'Missing or invalid authorization header' });
      }

      const photonApiKey = authHeader.replace('Bearer ', '');

      // Validate connection
      const connection = await prisma.connection.findUnique({
        where: { photonApiKey },
      });

      if (!connection) {
        return reply.code(401).send({ error: 'Invalid API key' });
      }

      if (connection.status === Status.REVOKED) {
        return reply.code(403).send({ 
          error: 'Connection revoked',
          message: 'This connection has been revoked. Please reconnect at https://manus.photon.codes/connect'
        });
      }

      if (connection.status !== Status.ACTIVE) {
        return reply.code(401).send({ error: 'Inactive API key' });
      }

      // Validate Origin header to prevent DNS rebinding attacks
      const origin = request.headers.origin;
      const allowedOrigins = [
        'https://manus.im',
        'https://app.manus.im',
        'https://open.manus.im',
      ];
      
      if (origin && !allowedOrigins.includes(origin) && process.env.NODE_ENV === 'production') {
        fastify.log.warn({ origin }, 'Blocked request from unauthorized origin');
        return reply.code(403).send({ error: 'Forbidden origin' });
      }

      fastify.log.info({ photonApiKey, phoneNumber: connection.phoneNumber }, 'SSE connection established');

      // Create MCP server instance
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

      // Register tool handlers
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
      server.setRequestHandler(CallToolRequestSchema, async (toolRequest) => {
        const { name, arguments: args } = toolRequest.params;

        try {
          switch (name) {
            case 'fetch': {
              // Fetch messages from iMessage infrastructure
              const messages = await fetchIMessages(connection.phoneNumber);

              // Get Manus message GUIDs to filter out
              const manusMessageGuids = await prisma.manusMessage.findMany({
                where: { phoneNumber: connection.phoneNumber },
                select: { messageGuid: true },
              });

              const guidSet = new Set(manusMessageGuids.map((m) => m.messageGuid));

              // Filter out Manus messages by GUID (database is source of truth)
              const filteredMessages = messages.filter(
                (msg) => !guidSet.has(msg.guid || '')
              );

              fastify.log.info(
                { phoneNumber: connection.phoneNumber, total: messages.length, filtered: filteredMessages.length },
                'Fetched messages via SSE'
              );

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(filteredMessages, null, 2),
                  },
                ],
              };
            }

            case 'send': {
              const body = SendMessageSchema.parse(args);

              // Format message (no prefix - returns as-is)
              const formattedMessage = formatManusMessage(body.message);

              // Strip markdown and split by paragraphs
              const cleanMessage = stripMarkdownFormatting(formattedMessage);
              const chunks = splitMessageByParagraphs(cleanMessage);

              fastify.log.info({ phoneNumber: connection.phoneNumber, chunks: chunks.length }, 'Sending message chunks via MCP-SSE');

              // Send each chunk as a separate message
              const messageGuids: string[] = [];
              for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                
                // Show typing indicator before each chunk (except first)
                if (i > 0) {
                  await sendTypingIndicator(connection.phoneNumber, 500);
                }
                
                // Send the message chunk
                const messageGuid = await sendIMessage(connection.phoneNumber, chunk);
                messageGuids.push(messageGuid);
                
                // Record each chunk in database
                await prisma.manusMessage.create({
                  data: {
                    messageGuid,
                    phoneNumber: connection.phoneNumber,
                    messageType: 'MANUAL',
                  },
                });
                
                // Small delay between messages (except after last one)
                if (i < chunks.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, 500));
                }
              }

              fastify.log.info({ phoneNumber: connection.phoneNumber, messageGuids }, 'All message chunks sent via SSE');

              return {
                content: [
                  {
                    type: 'text',
                    text: `Message sent successfully in ${chunks.length} chunk(s). GUIDs: ${messageGuids.join(', ')}`,
                  },
                ],
              };
            }

            default:
              throw new Error(`Unknown tool: ${name}`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          fastify.log.error({ error, tool: name }, 'Tool execution failed');
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

      // Create SSE transport
      const transport = new SSEServerTransport('/mcp', reply.raw);
      
      // Setup connection lifecycle handlers
      transport.onclose = () => {
        fastify.log.info({ photonApiKey, sessionId: transport.sessionId }, 'SSE connection closed');
        activeConnections.delete(transport.sessionId);
      };

      transport.onerror = (error) => {
        fastify.log.error({ error, photonApiKey, sessionId: transport.sessionId }, 'SSE connection error');
        activeConnections.delete(transport.sessionId);
      };

      // Store active connection
      activeConnections.set(transport.sessionId, {
        server,
        transport,
        phoneNumber: connection.phoneNumber,
      });

      // Setup connection timeout
      const timeout = setTimeout(() => {
        fastify.log.info({ sessionId: transport.sessionId }, 'Connection timeout, closing');
        transport.close();
        activeConnections.delete(transport.sessionId);
      }, CONNECTION_TIMEOUT_MS);

      // Clear timeout on close
      const originalOnClose = transport.onclose;
      transport.onclose = () => {
        clearTimeout(timeout);
        if (originalOnClose) originalOnClose();
      };

      // Connect server to transport
      await server.connect(transport);
      
      // Start SSE stream
      await transport.start();

    } catch (error) {
      fastify.log.error(error, 'Failed to establish SSE connection');
      return reply.code(500).send({ error: 'Failed to establish connection' });
    }
  });

  // POST /mcp - Receive messages from client
  fastify.post('/', async (request, reply) => {
    try {
      // Extract session ID from query or body
      const sessionId = (request.query as any).sessionId || (request.body as any)?.sessionId;
      
      if (!sessionId) {
        return reply.code(400).send({ error: 'Invalid request' });
      }

      const connection = activeConnections.get(sessionId);
      
      if (!connection) {
        return reply.code(400).send({ error: 'Invalid request' });
      }

      // Handle the POST message
      await connection.transport.handlePostMessage(request.raw, reply.raw);
      
    } catch (error) {
      fastify.log.error(error, 'Failed to handle POST message');
      return reply.code(500).send({ error: 'Failed to handle message' });
    }
  });

  // GET /mcp/status - Check connection status (optional, for debugging)
  fastify.get('/status', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const photonApiKey = authHeader.replace('Bearer ', '');

    const connection = await prisma.connection.findUnique({
      where: { photonApiKey },
    });

    if (!connection) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (connection.status === Status.REVOKED) {
      return {
        status: 'REVOKED',
        message: 'Connection has been revoked',
        reconnectUrl: 'https://manus.photon.codes/connect',
      };
    }

    // Find active session for this connection
    let activeSession = null;
    for (const [sessionId, conn] of activeConnections.entries()) {
      if (conn.phoneNumber === connection.phoneNumber) {
        activeSession = sessionId;
        break;
      }
    }

    return {
      status: connection.status,
      phoneNumber: connection.phoneNumber,
      activeSession,
      totalActiveSessions: activeConnections.size,
    };
  });
};

// Helper functions - integrate with advanced-imessage-kit
async function fetchIMessages(phoneNumber: string): Promise<any[]> {
  const { fetchIMessages: fetchMessages } = await import('../lib/imessage.js');
  return fetchMessages(phoneNumber, 100);
}

async function sendIMessage(phoneNumber: string, message: string): Promise<string> {
  const { sendIMessage: sendMessage } = await import('../lib/imessage.js');
  return sendMessage(phoneNumber, message);
}

async function sendTypingIndicator(phoneNumber: string, durationMs: number): Promise<void> {
  try {
    const { sendTypingIndicator: showTyping } = await import('../lib/imessage.js');
    await showTyping(phoneNumber, durationMs);
  } catch (error) {
    console.warn('Failed to send typing indicator:', error);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  for (const [sessionId, connection] of activeConnections.entries()) {
    connection.transport.close();
    activeConnections.delete(sessionId);
  }
});

process.on('SIGINT', () => {
  for (const [sessionId, connection] of activeConnections.entries()) {
    connection.transport.close();
    activeConnections.delete(sessionId);
  }
});
