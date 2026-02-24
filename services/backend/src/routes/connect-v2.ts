import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@imessage-mcp/database';
import {
  generateConnectionId,
  generatePhotonApiKey,
  getConnectionExpiry,
  normalizePhoneNumber,
} from '@imessage-mcp/shared';
import { z } from 'zod';
import { getMetaPixelCode } from '../lib/meta-pixel.js';
import { getOpenPanelScriptTag } from '../lib/openpanel.js';

const StartSchema = z.object({
  phoneNumber: z.string(),
});

const InitiateSchema = z.object({
  phoneNumber: z.string(),
  message: z.string().optional(),
});

const VerifySchema = z.object({
  connectionId: z.string(),
  manusApiKey: z.string().startsWith('manus_'),
});

const RevokeSchema = z.object({
  photonApiKey: z.string().regex(/^ph_(live|test)_[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{24}$/),
});

/**
 * Send onboarding messages to teach users how to use the service
 * Called after MCP config is sent, with a delay to give users time to paste the config
 */
async function sendOnboardingMessages(phoneNumber: string, delayMs: number = 7000) {
  const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
  
  // Wait for user to have time to paste the config and view the visual guide
  await new Promise(resolve => setTimeout(resolve, delayMs));
  
  // Message 1: Introduction
  await sendTypingIndicator(phoneNumber, 800);
  await sendIMessage(phoneNumber, "Here's how to use:");
  
  // Message 2: Task acknowledgment
  await sendTypingIndicator(phoneNumber, 1200);
  await sendIMessage(phoneNumber, "If you give me a task, I'll react with 👍 to acknowledge it and ❤️ when it's been completed.");
  
  // Message 3: Revoke instruction
  await sendTypingIndicator(phoneNumber, 1000);
  await sendIMessage(phoneNumber, "(Use \"revoke\" to revoke your connection)");
  
  // Message 4: Closing
  await sendTypingIndicator(phoneNumber, 600);
  await sendIMessage(phoneNumber, "Enjoy!");
}

export const connectRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /revoke - Revoke connection page (Manus Brand Design)
  fastify.get('/revoke', async (request, reply) => {
    const metaPixel = getMetaPixelCode();
    const openPanel = getOpenPanelScriptTag();
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Revoke Manus Connection</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="icon" type="image/png" href="/favicon.png?v=2">
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { 
              font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              min-height: 100vh;
              background: #F8F8F8;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
              position: relative;
              transition: background 0.3s ease;
            }
            
            .container { max-width: 480px; width: 100%; text-align: center; }
            h1 { 
              font-family: 'Libre Baskerville', serif;
              font-size: 32px; 
              font-weight: 700; 
              color: #34322D; 
              margin-bottom: 12px; 
            }
            .subtitle { 
              font-size: 17px; 
              color: #34322D; 
              opacity: 0.7;
              margin-bottom: 32px; 
              line-height: 1.5; 
            }
            .warning { 
              background: rgba(255, 59, 48, 0.1); 
              border: 1px solid rgba(255, 59, 48, 0.3);
              border-radius: 8px;
              padding: 16px;
              margin-bottom: 24px;
              color: #ff3b30;
              font-size: 15px;
            }
            input {
              width: 100%;
              padding: 16px 20px;
              font-size: 17px;
              border: 1px solid #34322D;
              border-radius: 8px;
              background: #FFFFFF;
              margin-bottom: 16px;
              color: #34322D;
              font-family: 'DM Sans', sans-serif;
              transition: all 0.2s ease;
            }
            input:focus { 
              outline: none; 
              border-color: #34322D; 
              box-shadow: 0 0 0 3px rgba(52, 50, 45, 0.1);
            }
            input::placeholder { color: rgba(52, 50, 45, 0.4); }
            .btn {
              width: 100%;
              padding: 16px 48px;
              background: #34322D;
              color: #FFFFFF;
              border: none;
              font-size: 17px;
              font-weight: 500;
              border-radius: 100px;
              cursor: pointer;
              transition: all 0.2s;
              font-family: 'DM Sans', sans-serif;
            }
            .btn:hover:not(:disabled) { 
              background: #2a2823;
              transform: translateY(-1px);
              box-shadow: 0 4px 12px rgba(52, 50, 45, 0.2);
            }
            .btn:active:not(:disabled) {
              transform: translateY(0);
            }
            .btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .success { 
              background: rgba(52, 199, 89, 0.1); 
              border: 1px solid rgba(52, 199, 89, 0.3);
              border-radius: 8px;
              padding: 16px;
              color: #34c759;
              font-size: 15px;
              display: none;
            }
            .error { 
              background: rgba(255, 59, 48, 0.1); 
              border: 1px solid rgba(255, 59, 48, 0.3);
              border-radius: 8px;
              padding: 16px;
              color: #ff3b30;
              font-size: 15px;
              display: none;
              margin-top: 16px;
            }
            .show { display: block; }
            .footer {
              position: fixed;
              bottom: 30px;
              left: 0;
              right: 0;
              text-align: center;
              padding: 0 20px;
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 8px;
            }
            .footer-row {
              display: flex;
              align-items: center;
              gap: 8px;
              flex-wrap: wrap;
              justify-content: center;
            }
            .footer-text {
              color: #34322D;
              opacity: 0.6;
              font-size: 14px;
              font-weight: 400;
            }
            .footer a {
              text-decoration: none;
              transition: opacity 0.2s;
              display: inline-block;
            }
            .footer a:hover { opacity: 0.7; }
            .footer-logo {
              height: 24px;
              width: auto;
              transition: opacity 0.2s;
              vertical-align: middle;
            }
            .footer-link {
              color: #34322D;
              opacity: 0.8;
              font-weight: 500;
              letter-spacing: -0.01em;
              text-decoration: underline !important;
            }
            .footer-link:hover {
              opacity: 1;
            }
            @media (max-width: 768px) {
              .footer-logo {
                height: 20px;
              }
            }
            @media (max-width: 480px) {
              .footer-logo {
                height: 18px;
              }
            }
          </style>
          ${metaPixel}
          ${openPanel}
        </head>
        <body>
          <div class="container">
            <h1>Revoke Connection</h1>
            <p class="subtitle">Disconnect your iMessage from Manus and delete all your data</p>
            
            <div class="warning">
              ⚠️ This action cannot be undone. All your messages and data will be permanently deleted.
            </div>
            
            <form id="revokeForm">
              <input 
                type="text" 
                id="photonApiKey" 
                placeholder="Enter your Photon API key (ph_live_...)" 
                required 
              />
              <button type="submit" class="btn" id="revokeBtn">Revoke Connection</button>
            </form>
            
            <div id="success" class="success"></div>
            <div id="error" class="error"></div>
          </div>
          
          <!-- Footer -->
          <div class="footer">
            <div class="footer-row">
              <span class="footer-text">powered by</span>
              <a href="https://photon.codes" target="_blank" rel="noopener noreferrer" data-track="photon_link_clicked">
                <img src="/photon-logo-dark.png" alt="Photon" class="footer-logo">
              </a>
            </div>
            <div class="footer-text">
              join community at <a href="https://discord.com/invite/4yXmmFPadR" target="_blank" rel="noopener noreferrer" class="footer-link" data-track="discord_link_clicked"><img src="/assets/discord-icon.png" alt="Discord" style="width: 16px; height: 16px; vertical-align: middle; margin-right: 4px;">Discord</a>
            </div>
          </div>
          
          <script>
            document.getElementById('revokeForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const btn = document.getElementById('revokeBtn');
              const errorDiv = document.getElementById('error');
              const successDiv = document.getElementById('success');
              const photonApiKey = document.getElementById('photonApiKey').value.trim();
              
              btn.disabled = true;
              btn.textContent = 'Revoking...';
              errorDiv.classList.remove('show');
              successDiv.classList.remove('show');
              
              try {
                const response = await fetch('/connect/revoke', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ photonApiKey })
                });
                
                const data = await response.json();
                
                if (data.success) {
                  successDiv.textContent = '✅ Connection revoked successfully! All your data has been deleted. You will receive a confirmation via iMessage.';
                  successDiv.classList.add('show');
                  document.getElementById('revokeForm').style.display = 'none';
                } else {
                  errorDiv.textContent = data.error || 'Failed to revoke connection';
                  errorDiv.classList.add('show');
                  btn.disabled = false;
                  btn.textContent = 'Revoke Connection';
                }
              } catch (error) {
                errorDiv.textContent = 'Failed to revoke connection. Please try again.';
                errorDiv.classList.add('show');
                btn.disabled = false;
                btn.textContent = 'Revoke Connection';
              }
            });
            
            // Track link clicks for Photon and Discord
            document.addEventListener('DOMContentLoaded', function() {
              const photonLinks = document.querySelectorAll('[data-track="photon_link_clicked"]');
              photonLinks.forEach(function(link) {
                link.addEventListener('click', function() {
                  if (window.op) {
                    window.op('track', 'photon_link_clicked');
                  }
                });
              });
              
              const discordLinks = document.querySelectorAll('[data-track="discord_link_clicked"]');
              discordLinks.forEach(function(link) {
                link.addEventListener('click', function() {
                  if (window.op) {
                    window.op('track', 'discord_link_clicked');
                  }
                });
              });
            });
          </script>
        </body>
      </html>
    `);
  });

  // Default SMS number when PHOTON_HANDLE is missing/empty in env (e.g. in Docker)
  const DEFAULT_PHOTON_HANDLE = '+14158156704';

  // COMMENTED OUT: Landing page now on Framer
  // GET /go - Redirect route for Instagram iOS in-app browser workaround
  // fastify.get('/go', async (request, reply) => {
  //   const raw = process.env.PHOTON_HANDLE ?? '';
  //   const photonHandle = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_PHOTON_HANDLE;
  //   // Shorter message for Instagram to avoid encoding issues
  //   const smsLink = `sms:${photonHandle}?body=Hello`;
  //   return reply.type('text/html').send(`
  //     <!DOCTYPE html><html><head>
  //     <meta http-equiv="refresh" content="0;url=${smsLink}">
  //     <script>window.location.href = '${smsLink}';</script>
  //     </head>
  //     <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  //       <a href="${smsLink}" style="font-size:18px;padding:16px 32px;background:#34322D;color:#fff;border-radius:100px;text-decoration:none">
  //         Open iMessage
  //       </a>
  //     </body></html>
  //   `);
  // });

  // COMMENTED OUT: Landing page now on Framer
  // GET / - Landing page with "Connect to Manus" button (Manus Brand Design)
  // See git history for full implementation (removed ~600 lines of HTML template)

  // POST /connect - COMMENTED OUT: Connection creation now happens in imessage-webhook
  // See git history for full implementation (removed ~50 lines)

  // ROUTES REMOVED: GET /, GET /go, POST /, GET /:connectionId
  // These routes were removed because:
  // 1. Landing page is now hosted on Framer (static)
  // 2. Users onboard via iMessage directly (no web flow)
  // 3. API key submission happens via chat message detection

  // Legacy endpoint removed - use POST /connect instead

  // PUT /connect/:id - Submit Manus API key and activate connection
  fastify.put('/:connectionId', async (request, reply) => {
    try {
      const { connectionId } = request.params as { connectionId: string };
      const body = z.object({ 
        manusApiKey: z.string().regex(/^sk-[A-Za-z0-9_-]{70,100}$/, 'Invalid Manus API key format')
      }).parse(request.body);
      const { manusApiKey } = body;

      // Find pending connection
      const connection = await prisma.connection.findUnique({
        where: { connectionId },
      });

      // Return generic error to prevent enumeration
      if (!connection || connection.status !== 'PENDING' || (connection.expiresAt && new Date() > connection.expiresAt)) {
        return reply.code(400).send({ error: 'Invalid or expired connection' });
      }

      // Register webhook with Manus (optional - will fail for localhost)
      let webhookId: string | null = null;
      try {
        webhookId = await registerManusWebhook(manusApiKey);
        console.log('✅ Webhook registered:', webhookId);
      } catch (error) {
        console.warn('⚠️  Webhook registration failed (expected for localhost):', error instanceof Error ? error.message : error);
        // Continue without webhook - it's optional for development
      }

      // Generate Photon API key
      const photonApiKey = generatePhotonApiKey();

      // Update connection to ACTIVE
      await prisma.connection.update({
        where: { connectionId },
        data: {
          manusApiKey,
          photonApiKey,
          webhookId,
          status: 'ACTIVE',
          activatedAt: new Date(),
        },
      });

      fastify.log.info({ connectionId, phoneNumber: connection.phoneNumber }, 'Connection activated');

      // Notify worker to start processing for this phone number
      try {
        const Redis = (await import('ioredis')).default;
        const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
        await redis.publish('connection-activated', connection.phoneNumber);
        await redis.quit();
      } catch (error) {
        // Non-critical - worker will pick it up in the next periodic check
        console.warn('Failed to notify worker:', error);
      }

      // MCP config for user
      const mcpConfig = {
        mcpServers: {
          'photon-imessage': {
            type: 'streamableHttp',
            url: `${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/mcp/http`,
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json, text/event-stream',
              Authorization: `Bearer ${photonApiKey}`,
            },
          },
        },
      };

      // Send iMessage with MCP config and typing indicators
      try {
        const { sendIMessage, sendTypingIndicator, sendIMessageWithAttachments } = await import('../lib/imessage.js');
        const path = await import('path');
        const fs = await import('fs/promises');
        const configText = JSON.stringify(mcpConfig, null, 2);
        
        // [1 sec typing indicator] "All set!"
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "All set!");
        
        // [1 sec typing indicator] "Copy and paste this config into Manus:"
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "Copy and paste this config into Manus:");
        
        // [1 sec typing indicator] Send MCP config as separate message for easy copying
        // Disable rich link preview to show the full JSON text instead of just the URL
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, configText, { disableRichLink: true });
        
        // [1 sec typing indicator] Send instruction text
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "Add custom MCP server > Import by JSON");
        
        // [1 sec typing indicator] Send screenshot showing the UI
        await sendTypingIndicator(connection.phoneNumber, 1000);
        try {
          // Image is at workspace root, not in services/backend
          const imagePath = path.join(process.cwd(), '..', '..', 'assets', 'image.png');
          // Read the file and create a temporary URL (we'll use the SDK's local file support)
          const imageBuffer = await fs.readFile(imagePath);
          const tempDir = (await import('os')).tmpdir();
          const tempImagePath = path.join(tempDir, `mcp-guide-${Date.now()}.png`);
          await fs.writeFile(tempImagePath, imageBuffer);
          
          // Send using the SDK's local file support
          const client = await (await import('../lib/imessage.js')).getIMessageSDK();
          const chatGuid = `any;-;${connection.phoneNumber}`;
          await client.attachments.sendAttachment({
            chatGuid,
            filePath: tempImagePath,
            fileName: 'mcp-import-guide.png',
          });
          
          // Clean up temp file
          await fs.unlink(tempImagePath);
        } catch (imageError) {
          fastify.log.error({ error: imageError }, 'Failed to send image, continuing without it');
          // Continue without image - not critical
        }
        
        // [1 sec typing indicator] Send link introduction
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "Here's the link:");
        
        // [1 sec typing indicator] Send the actual link
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "https://manus.im/app#settings/connectors/mcp-server");
        
        // Send onboarding messages after delay (non-blocking)
        sendOnboardingMessages(connection.phoneNumber, 15000).catch(error => {
          fastify.log.error({ error }, 'Failed to send onboarding messages');
          // Non-critical - don't fail the connection
        });
      } catch (error) {
        fastify.log.error({ error }, 'Failed to send iMessage');
        // Continue anyway - user sees config on web page
      }

      return {
        success: true,
        photonApiKey,
        mcpConfig,
        message: 'Connection activated successfully!',
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to verify token');
      return reply.code(400).send({ error: 'Invalid request' });
    }
  });

  // Legacy endpoint removed - use PUT /connect/:id instead

  // POST /connect/revoke - Revoke connection by Photon API key
  fastify.post('/revoke', async (request, reply) => {
    try {
      const body = RevokeSchema.parse(request.body);
      const { photonApiKey } = body;

      const connection = await prisma.connection.findUnique({
        where: { photonApiKey },
      });

      // Return generic error to prevent enumeration
      if (!connection) {
        return reply.code(400).send({ error: 'Invalid API key' });
      }

      if (connection.status === 'REVOKED') {
        return reply.code(400).send({ error: 'Connection already revoked' });
      }

      fastify.log.info({ photonApiKey, phoneNumber: connection.phoneNumber }, 'Starting connection revocation by API key');

      // Delete webhook from Manus
      if (connection.webhookId && connection.manusApiKey) {
        try {
          await deleteManusWebhook(connection.manusApiKey, connection.webhookId);
          fastify.log.info({ webhookId: connection.webhookId }, 'Webhook deleted from Manus');
        } catch (error) {
          fastify.log.warn({ error }, 'Failed to delete webhook from Manus');
        }
      }

      // Clean up all user data in a transaction
      await prisma.$transaction(async (tx) => {
        await tx.messageQueue.deleteMany({
          where: { phoneNumber: connection.phoneNumber },
        });

        await tx.manusMessage.deleteMany({
          where: { phoneNumber: connection.phoneNumber },
        });

        await tx.connection.update({
          where: { photonApiKey },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            manusApiKey: null,
            currentTaskId: null,
          },
        });
      });

      fastify.log.info({ photonApiKey, phoneNumber: connection.phoneNumber }, 'Connection revoked by API key');

      // Send iMessage notification
      try {
        const { sendIMessage } = await import('../lib/imessage.js');
        await sendIMessage(
          connection.phoneNumber,
          'Your iMessage connection to Manus has been revoked. All your data has been deleted.'
        );
      } catch (error) {
        fastify.log.warn({ error }, 'Failed to send revocation notification');
      }

      return {
        success: true,
        message: 'Connection revoked successfully',
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to revoke connection');
      return reply.code(500).send({ error: 'Failed to revoke connection' });
    }
  });

  // DELETE /connect/:id - Revoke connection and clean up all user data
  fastify.delete('/:connectionId', async (request, reply) => {
    try {
      const { connectionId } = request.params as { connectionId: string };

      const connection = await prisma.connection.findUnique({
        where: { connectionId },
      });

      // Return generic error to prevent enumeration
      if (!connection) {
        return reply.code(400).send({ error: 'Invalid connection' });
      }

      fastify.log.info({ connectionId, phoneNumber: connection.phoneNumber }, 'Starting connection revocation');

      // Delete webhook from Manus
      if (connection.webhookId && connection.manusApiKey) {
        try {
          await deleteManusWebhook(connection.manusApiKey, connection.webhookId);
          fastify.log.info({ webhookId: connection.webhookId }, 'Webhook deleted from Manus');
        } catch (error) {
          fastify.log.warn({ error }, 'Failed to delete webhook from Manus');
          // Continue with revocation even if webhook deletion fails
        }
      }

      // Clean up all user data in a transaction to maintain consistency
      await prisma.$transaction(async (tx) => {
        // Delete all message queue entries for this user
        const deletedQueueItems = await tx.messageQueue.deleteMany({
          where: { phoneNumber: connection.phoneNumber },
        });
        fastify.log.info({ count: deletedQueueItems.count }, 'Deleted message queue items');

        // Delete all Manus messages for this user
        const deletedManusMessages = await tx.manusMessage.deleteMany({
          where: { phoneNumber: connection.phoneNumber },
        });
        fastify.log.info({ count: deletedManusMessages.count }, 'Deleted Manus messages');

        // Update connection status to REVOKED
        await tx.connection.update({
          where: { connectionId },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            // Clear sensitive data
            manusApiKey: null,
            currentTaskId: null,
          },
        });
      });

      fastify.log.info({ connectionId, phoneNumber: connection.phoneNumber }, 'Connection revoked and data cleaned up');

      // Send iMessage notification to user
      try {
        const { sendIMessage } = await import('../lib/imessage.js');
        await sendIMessage(
          connection.phoneNumber,
          'Your iMessage connection to Manus has been revoked. All your data has been deleted.'
        );
      } catch (error) {
        fastify.log.warn({ error }, 'Failed to send revocation notification');
        // Don't fail the revocation if notification fails
      }

      return {
        success: true,
        message: 'Connection revoked and all data deleted successfully',
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to revoke connection');
      return reply.code(500).send({ error: 'Failed to revoke connection' });
    }
  });

  // COMMENTED OUT: Token input page no longer needed - users paste API key in iMessage
  // GET /connect/:connectionId - Token input page (Manus Brand Design)
  // See git history for full implementation
};

// Helper functions
async function registerManusWebhook(manusApiKey: string): Promise<string> {
  const response = await fetch('https://api.manus.im/v1/webhooks', {
    method: 'POST',
    headers: {
      'API_KEY': manusApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      webhook: {
        url: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/webhook`,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ Webhook registration failed:', response.status, errorText);
    throw new Error(`Failed to register webhook with Manus: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as { webhook_id?: string; id?: string };
  return data.webhook_id || data.id || '';
}

async function deleteManusWebhook(manusApiKey: string, webhookId: string): Promise<void> {
  await fetch(`https://api.manus.im/v1/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      'API_KEY': manusApiKey,
    },
  });
}
