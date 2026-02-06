import { FastifyPluginAsync } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { prisma, Status } from '@imessage-mcp/database';
import { formatManusMessage, splitMessageByParagraphs, stripMarkdownFormatting } from '@imessage-mcp/shared';
import * as z from 'zod';

const SendMessageSchema = z.object({
  message: z.string(),
  attachments: z.array(z.object({
    url: z.string(),
    filename: z.string(),
    size_bytes: z.number().optional(),
  })).optional(),
});

export const mcpHTTPRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /mcp/http - Handle Streamable HTTP requests
  fastify.post('/', async (request, reply) => {
    try {
      // Extract and validate API key
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
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

      fastify.log.info({ photonApiKey, phoneNumber: connection.phoneNumber }, 'HTTP MCP request received');

      // Create MCP server instance for this request
      const server = new McpServer(
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

      // Register fetch tool
      server.registerTool(
        'fetch',
        {
          description: 'Fetch conversation history from iMessage. Returns the last 100 messages between the user and Photon, filtered to exclude Manus-generated messages.',
          inputSchema: z.object({}),
        },
        async () => {
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
            'Fetched messages via HTTP'
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
      );

      // Register send tool
      server.registerTool(
        'send',
        {
          description: 'Send a message to the user via iMessage. Optionally include file attachments.',
          inputSchema: SendMessageSchema,
        },
        async (args) => {
          const body = args as z.infer<typeof SendMessageSchema>;

          // Format message (no prefix - returns as-is)
          const formattedMessage = formatManusMessage(body.message);

          // Strip markdown and split by paragraphs
          const cleanMessage = stripMarkdownFormatting(formattedMessage);
          const chunks = splitMessageByParagraphs(cleanMessage);

          fastify.log.info({ phoneNumber: connection.phoneNumber, chunks: chunks.length, attachments: body.attachments?.length || 0 }, 'Sending message chunks via MCP-HTTP');

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
            
            // Small delay between messages (except after last one)
            if (i < chunks.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
          
          // Handle attachments if provided
          let attachmentsSent = 0;
          if (body.attachments && body.attachments.length > 0) {
            try {
              fastify.log.info({ phoneNumber: connection.phoneNumber, attachmentCount: body.attachments.length }, 'Sending attachments via MCP-HTTP');
              
              const attachmentGuids = await sendIMessageWithAttachments(
                connection.phoneNumber,
                body.attachments
              );
              
              messageGuids.push(...attachmentGuids);
              attachmentsSent = attachmentGuids.length;
              fastify.log.info({ phoneNumber: connection.phoneNumber, attachmentGuids }, 'Attachments sent successfully');
            } catch (error) {
              fastify.log.error(error, 'Failed to send attachments, continuing without them');
              // Continue - don't fail the whole request if attachments fail
            }
          }

          // Record as single database entry (reduces DB spam)
          await prisma.manusMessage.create({
            data: {
              messageGuid: messageGuids[0], // Primary GUID
              phoneNumber: connection.phoneNumber,
              messageType: 'MANUAL',
            },
          });

          fastify.log.info({ phoneNumber: connection.phoneNumber, messageGuids }, 'All message chunks sent via HTTP (tracked as 1 DB record)');

          return {
            content: [
              {
                type: 'text',
                text: `Message sent successfully in ${chunks.length} chunk(s)${attachmentsSent > 0 ? ` with ${attachmentsSent} attachment(s)` : ''}. GUIDs: ${messageGuids.join(', ')}`,
              },
            ],
          };
        }
      );

      // Create Streamable HTTP transport (stateless mode)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode - no session tracking
      });

      // Connect server to transport
      await server.connect(transport);

      // Handle the HTTP request
      await transport.handleRequest(request.raw, reply.raw, request.body);

      // Clean up on response close
      reply.raw.on('close', () => {
        transport.close();
        server.close();
      });

    } catch (error) {
      fastify.log.error(error, 'Failed to handle HTTP MCP request');
      if (!reply.sent) {
        return reply.code(500).send({ error: 'Failed to process request' });
      }
    }
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

async function sendIMessageWithAttachments(
  phoneNumber: string,
  attachments: Array<{ url: string; filename: string; size_bytes?: number }>
): Promise<string[]> {
  const { sendIMessageWithAttachments: sendWithAttachments } = await import('../lib/imessage.js');
  return sendWithAttachments(phoneNumber, '', attachments);
}
