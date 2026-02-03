import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@imessage-mcp/database';
import {
  generateConnectionId,
  generatePhotonApiKey,
  getConnectionExpiry,
  normalizePhoneNumber,
} from '@imessage-mcp/shared';
import { z } from 'zod';

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

export const connectRoutes: FastifyPluginAsync = async (fastify) => {
  // GET / - Landing page with "Connect to Manus" button
  fastify.get('/', async (request, reply) => {
    const fs = await import('fs');
    const path = await import('path');
    
    const faviconPath = path.join(process.cwd(), 'favicon.png');
    
    if (!fs.existsSync(faviconPath)) {
      return reply.code(404).send({ error: 'Favicon not found' });
    }
    
    reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=31536000')
      .send(fs.createReadStream(faviconPath));
  });


  // GET /api/connect - Landing page with "Connect to Manus" button
  fastify.get('/', async (request, reply) => {
    const photonHandle = process.env.PHOTON_HANDLE || '+14158156704';
    const smsLink = `sms:${photonHandle}&body=Hey Manus! Please connect my iMessage`;
    
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connect to Manus</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="icon" type="image/png" href="/favicon.png">
          <style>
            * { 
              box-sizing: border-box; 
              margin: 0; 
              padding: 0; 
            }
            
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              min-height: 100vh;
              background: #ffffff;
              position: relative;
            }
            
            /* Content container */
            .content {
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            
            /* Dynamic Island button */
            .connect-btn { 
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 20px 48px;
              background: rgba(0, 0, 0, 0.85);
              backdrop-filter: blur(20px);
              -webkit-backdrop-filter: blur(20px);
              color: #ffffff;
              text-decoration: none;
              font-size: 17px;
              font-weight: 500;
              border-radius: 50px;
              transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
              letter-spacing: -0.01em;
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            
            .connect-btn:hover { 
              transform: scale(1.05);
              box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
              background: rgba(0, 0, 0, 0.9);
            }
            
            .connect-btn:active {
              transform: scale(0.98);
            }
            
            /* Footer */
            .footer {
              position: fixed;
              bottom: 30px;
              left: 0;
              right: 0;
              text-align: center;
              padding: 0 20px;
            }
            
            .footer a {
              color: rgba(0, 0, 0, 0.6);
              text-decoration: none;
              font-size: 14px;
              font-weight: 500;
              transition: color 0.2s;
              letter-spacing: -0.01em;
            }
            
            .footer a:hover {
              color: rgba(0, 0, 0, 0.9);
            }
            
            /* Responsive Design */
            @media (max-width: 768px) {
              .connect-btn {
                padding: 18px 40px;
                font-size: 16px;
              }
              
              .footer {
                bottom: 20px;
              }
              
              .footer a {
                font-size: 13px;
              }
            }
            
            @media (max-width: 480px) {
              .content {
                padding: 16px;
              }
              
              .connect-btn {
                padding: 16px 36px;
                font-size: 15px;
              }
              
              .footer {
                bottom: 16px;
              }
            }
          </style>
        </head>
        <body>
          <!-- Content -->
          <div class="content">
            <a href="${smsLink}" class="connect-btn">Connect to Manus</a>
          </div>
          
          <!-- Footer -->
          <div class="footer">
            <a href="https://photon.codes" target="_blank">photon.codes</a>
          </div>
        </body>
      </html>
    `);
  });

  // POST /connect - Handle initial iMessage
  fastify.post('/', async (request, reply) => {
    try {
      const body = StartSchema.parse(request.body);
      const phoneNumber = normalizePhoneNumber(body.phoneNumber);
      const connectionId = generateConnectionId();
      const expiresAt = getConnectionExpiry();

      // Create pending connection
      const connection = await prisma.connection.create({
        data: {
          connectionId,
          phoneNumber,
          status: 'PENDING',
          expiresAt,
        },
      });

      fastify.log.info({ connectionId, phoneNumber }, 'Connection started');

      // Send iMessage back to user with typing indicators
      const linkUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/connect/${connectionId}`;
      try {
        const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
        
        // [2 sec typing indicator] "Sure!"
        await sendTypingIndicator(phoneNumber, 2000);
        await sendIMessage(phoneNumber, 'Sure!');
        
        // [3 sec typing indicator] "Please input your Manus token..."
        await sendTypingIndicator(phoneNumber, 3000);
        await sendIMessage(phoneNumber, `Please input your Manus token in the following link:\n\n${linkUrl}`);
      } catch (error) {
        fastify.log.error({ error }, 'Failed to send iMessage');
        // Continue anyway - user can still access the link
      }

      return {
        success: true,
        connectionId,
        message: 'Connection started. Check your iMessage for next steps.',
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to start connection');
      return reply.code(400).send({ error: 'Invalid request' });
    }
  });

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

      if (!connection) {
        return reply.code(404).send({ error: 'Connection not found' });
      }

      if (connection.status !== 'PENDING') {
        return reply.code(400).send({ error: 'Connection already processed' });
      }

      if (connection.expiresAt && new Date() > connection.expiresAt) {
        return reply.code(400).send({ error: 'Connection expired' });
      }

      // Register webhook with Manus
      const webhookId = await registerManusWebhook(manusApiKey);

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

      // MCP config for user
      const mcpConfig = {
        mcpServers: {
          'photon-imessage': {
            type: 'sse',
            url: `${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/mcp`,
            headers: {
              Authorization: `Bearer ${photonApiKey}`,
            },
          },
        },
      };

      // Send iMessage with MCP config and typing indicators
      try {
        const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
        const configText = JSON.stringify(mcpConfig, null, 2);
        
        // [1 sec typing indicator] "You're all set! 🎉"
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "You're all set! 🎉");
        
        // [1 sec typing indicator] "Add this MCP config to Manus:"
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "Add this MCP config to Manus:");
        
        // Send MCP config
        await sendIMessage(connection.phoneNumber, configText);
        
        // Send link to Manus settings
        await sendIMessage(connection.phoneNumber, "Paste it here: https://manus.im/settings/mcp");
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

  // DELETE /connect/:id - Revoke connection
  fastify.delete('/:connectionId', async (request, reply) => {
    try {
      const { connectionId } = request.params as { connectionId: string };

      const connection = await prisma.connection.findUnique({
        where: { connectionId },
      });

      if (!connection) {
        return reply.code(404).send({ error: 'Connection not found' });
      }

      // Delete webhook from Manus
      if (connection.webhookId && connection.manusApiKey) {
        await deleteManusWebhook(connection.manusApiKey, connection.webhookId);
      }

      // Update status to REVOKED
      await prisma.connection.update({
        where: { connectionId },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
        },
      });

      fastify.log.info({ connectionId }, 'Connection revoked');

      return {
        success: true,
        message: 'Connection revoked successfully',
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to revoke connection');
      return reply.code(400).send({ error: 'Invalid request' });
    }
  });

  // GET /connect/:connectionId - Token input page
  fastify.get('/:connectionId', async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };

    const connection = await prisma.connection.findUnique({
      where: { connectionId },
    });

    if (!connection) {
      return reply.code(404).send('Connection not found');
    }

    // HTML form with improved UI
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connect to Manus</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="icon" type="image/png" href="/favicon.png">
          <style>
            * { 
              box-sizing: border-box; 
              margin: 0; 
              padding: 0; 
            }
            
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              min-height: 100vh;
              background: #ffffff;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            
            .container {
              max-width: 480px;
              width: 100%;
            }
            
            /* Form Section */
            #form-section {
              text-align: center;
            }
            
            h1 {
              font-size: 32px;
              font-weight: 600;
              color: #000000;
              margin-bottom: 12px;
              letter-spacing: -0.02em;
            }
            
            .subtitle {
              font-size: 17px;
              color: rgba(0, 0, 0, 0.6);
              margin-bottom: 32px;
              line-height: 1.5;
            }
            
            .get-key-link {
              display: inline-flex;
              align-items: center;
              color: rgba(0, 0, 0, 0.6);
              text-decoration: none;
              font-size: 15px;
              margin-bottom: 24px;
              transition: color 0.2s;
            }
            
            .get-key-link:hover {
              color: rgba(0, 0, 0, 0.9);
            }
            
            .input-wrapper {
              margin-bottom: 16px;
            }
            
            input {
              width: 100%;
              padding: 16px 20px;
              font-size: 17px;
              border: 1px solid rgba(0, 0, 0, 0.1);
              border-radius: 12px;
              background: rgba(0, 0, 0, 0.02);
              transition: all 0.2s;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            
            input:focus {
              outline: none;
              border-color: rgba(0, 0, 0, 0.3);
              background: #ffffff;
            }
            
            input::placeholder {
              color: rgba(0, 0, 0, 0.3);
            }
            
            .submit-btn {
              width: 100%;
              padding: 16px 48px;
              background: rgba(0, 0, 0, 0.85);
              backdrop-filter: blur(20px);
              -webkit-backdrop-filter: blur(20px);
              color: #ffffff;
              border: none;
              font-size: 17px;
              font-weight: 500;
              border-radius: 12px;
              cursor: pointer;
              transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
              letter-spacing: -0.01em;
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            
            .submit-btn:hover:not(:disabled) {
              background: rgba(0, 0, 0, 0.9);
              transform: translateY(-1px);
              box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
            }
            
            .submit-btn:active:not(:disabled) {
              transform: translateY(0);
            }
            
            .submit-btn:disabled {
              opacity: 0.5;
              cursor: not-allowed;
            }
            
            .error {
              margin-top: 16px;
              padding: 12px 16px;
              background: rgba(255, 59, 48, 0.1);
              color: #ff3b30;
              border-radius: 8px;
              font-size: 15px;
              display: none;
            }
            
            .error.show {
              display: block;
            }
            
            /* Success Section */
            #success-section {
              display: none;
              text-align: center;
            }
            
            .success-title {
              font-size: 32px;
              font-weight: 600;
              color: #000000;
              margin-bottom: 12px;
              letter-spacing: -0.02em;
            }
            
            .success-subtitle {
              font-size: 17px;
              color: rgba(0, 0, 0, 0.6);
              margin-bottom: 32px;
              line-height: 1.5;
            }
            
            .config-container {
              background: rgba(0, 0, 0, 0.03);
              border: 1px solid rgba(0, 0, 0, 0.06);
              border-radius: 12px;
              padding: 20px;
              margin-bottom: 20px;
              position: relative;
              text-align: left;
            }
            
            .config-container pre {
              overflow-x: auto;
              font-size: 13px;
              line-height: 1.6;
              color: rgba(0, 0, 0, 0.8);
              font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            }
            
            .copy-btn {
              position: absolute;
              top: 16px;
              right: 16px;
              padding: 8px 16px;
              background: rgba(0, 0, 0, 0.85);
              color: #ffffff;
              border: none;
              border-radius: 8px;
              cursor: pointer;
              font-size: 13px;
              font-weight: 500;
              transition: all 0.2s;
            }
            
            .copy-btn:hover {
              background: rgba(0, 0, 0, 0.95);
              transform: translateY(-1px);
            }
            
            .copy-btn.copied {
              background: #34c759;
            }
            
            .action-btn {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 16px 48px;
              background: rgba(0, 0, 0, 0.85);
              backdrop-filter: blur(20px);
              -webkit-backdrop-filter: blur(20px);
              color: #ffffff;
              text-decoration: none;
              font-size: 17px;
              font-weight: 500;
              border-radius: 12px;
              transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
              letter-spacing: -0.01em;
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            
            .action-btn:hover {
              background: rgba(0, 0, 0, 0.9);
              transform: translateY(-1px);
              box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
            }
            
            .action-btn:active {
              transform: translateY(0);
            }
            
            .note {
              margin-top: 24px;
              font-size: 15px;
              color: rgba(0, 0, 0, 0.5);
            }
            
            /* Footer */
            .footer {
              position: fixed;
              bottom: 30px;
              left: 0;
              right: 0;
              text-align: center;
              padding: 0 20px;
            }
            
            .footer a {
              color: rgba(0, 0, 0, 0.4);
              text-decoration: none;
              font-size: 14px;
              font-weight: 500;
              transition: color 0.2s;
              letter-spacing: -0.01em;
            }
            
            .footer a:hover {
              color: rgba(0, 0, 0, 0.7);
            }
            
            /* Responsive Design */
            @media (max-width: 768px) {
              body {
                padding: 16px;
              }
              
              .container {
                max-width: 100%;
              }
              
              h1, .success-title {
                font-size: 28px;
              }
              
              .subtitle, .success-subtitle {
                font-size: 16px;
                margin-bottom: 28px;
              }
              
              .get-key-link {
                font-size: 14px;
                margin-bottom: 20px;
              }
              
              input {
                padding: 14px 18px;
                font-size: 16px;
              }
              
              .submit-btn, .action-btn {
                padding: 14px 40px;
                font-size: 16px;
              }
              
              .config-container {
                padding: 16px;
              }
              
              .config-container pre {
                font-size: 12px;
              }
              
              .copy-btn {
                top: 12px;
                right: 12px;
                padding: 6px 12px;
                font-size: 12px;
              }
              
              .note {
                font-size: 14px;
                margin-top: 20px;
              }
              
              .footer {
                bottom: 20px;
              }
              
              .footer a {
                font-size: 13px;
              }
            }
            
            @media (max-width: 480px) {
              body {
                padding: 12px;
              }
              
              h1, .success-title {
                font-size: 24px;
                margin-bottom: 10px;
              }
              
              .subtitle, .success-subtitle {
                font-size: 15px;
                margin-bottom: 24px;
              }
              
              .get-key-link {
                font-size: 13px;
                margin-bottom: 16px;
              }
              
              input {
                padding: 12px 16px;
                font-size: 15px;
              }
              
              .submit-btn, .action-btn {
                padding: 12px 32px;
                font-size: 15px;
              }
              
              .config-container {
                padding: 14px;
                border-radius: 10px;
              }
              
              .config-container pre {
                font-size: 11px;
                line-height: 1.5;
              }
              
              .copy-btn {
                top: 10px;
                right: 10px;
                padding: 6px 10px;
                font-size: 11px;
              }
              
              .error {
                padding: 10px 14px;
                font-size: 14px;
              }
              
              .note {
                font-size: 13px;
                margin-top: 16px;
              }
              
              .footer {
                bottom: 16px;
              }
              
              .footer a {
                font-size: 12px;
              }
            }
            
            @media (max-width: 360px) {
              h1, .success-title {
                font-size: 22px;
              }
              
              .subtitle, .success-subtitle {
                font-size: 14px;
              }
              
              input {
                padding: 11px 14px;
                font-size: 14px;
              }
              
              .submit-btn, .action-btn {
                padding: 11px 28px;
                font-size: 14px;
              }
              
              .config-container pre {
                font-size: 10px;
              }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <!-- Form Section -->
            <div id="form-section">
              <h1>Connect to Manus</h1>
              <p class="subtitle">Enter your Manus API key to complete the connection</p>
              
              <a href="https://manus.im/app#settings/integrations/api" target="_blank" class="get-key-link">Get your API key →</a>
              
              <form id="tokenForm">
                <div class="input-wrapper">
                <input 
                  type="text" 
                  id="manusApiKey" 
                  placeholder="sk-..." 
                  autocomplete="off"
                  spellcheck="false"
                  required 
                />
                </div>
                <button type="submit" class="submit-btn" id="submitBtn">Continue</button>
              </form>
              
              <div id="error" class="error"></div>
            </div>
            
            <!-- Success Section -->
            <div id="success-section">
              <h1 class="success-title">All Set! 🎉</h1>
              <p class="success-subtitle">Copy the configuration below and paste it in Manus</p>
              
              <div class="config-container">
                <button class="copy-btn" onclick="copyConfig()">Copy</button>
                <pre id="config"></pre>
              </div>
              
              <a href="https://manus.im/app#settings/connectors/mcp-server" target="_blank" class="action-btn">
                Open Manus Settings →
              </a>
              
              <p class="note">Configuration also sent to your iMessage</p>
            </div>
          </div>
          
          <!-- Footer -->
          <div class="footer">
            <a href="https://photon.codes" target="_blank">photon.codes</a>
          </div>
          
          <script>
            let mcpConfigData = null;
            
            // Validate Manus API key format
            function isValidManusApiKey(key) {
              // Manus API keys start with sk- followed by base64-like characters
              // Format: sk-[A-Za-z0-9_-]{70,100}
              return /^sk-[A-Za-z0-9_-]{70,100}$/.test(key);
            }
            
            document.getElementById('tokenForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const submitBtn = document.getElementById('submitBtn');
              const errorDiv = document.getElementById('error');
              const manusApiKey = document.getElementById('manusApiKey').value.trim();
              
              // Validate API key format
              if (!isValidManusApiKey(manusApiKey)) {
                errorDiv.textContent = 'Invalid API key format. Please check your key and try again.';
                errorDiv.classList.add('show');
                return;
              }
              
              submitBtn.disabled = true;
              submitBtn.textContent = 'Connecting...';
              errorDiv.classList.remove('show');
              errorDiv.textContent = '';
              
              try {
                const response = await fetch('/connect/${connectionId}', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ manusApiKey })
                });
                
                const data = await response.json();
                
                if (data.success) {
                  mcpConfigData = data.mcpConfig;
                  document.getElementById('config').textContent = JSON.stringify(data.mcpConfig, null, 2);
                  document.getElementById('form-section').style.display = 'none';
                  document.getElementById('success-section').style.display = 'block';
                } else {
                  errorDiv.textContent = data.error || 'Failed to connect. Please try again.';
                  errorDiv.classList.add('show');
                  submitBtn.disabled = false;
                  submitBtn.textContent = 'Continue';
                }
              } catch (error) {
                errorDiv.textContent = 'Connection failed. Please check your API key and try again.';
                errorDiv.classList.add('show');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Continue';
              }
            });
            
            function copyConfig() {
              const configText = JSON.stringify(mcpConfigData, null, 2);
              navigator.clipboard.writeText(configText).then(() => {
                const btn = document.querySelector('.copy-btn');
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => {
                  btn.textContent = 'Copy';
                  btn.classList.remove('copied');
                }, 2000);
              });
            }
          </script>
        </body>
      </html>
    `);
  });
};

// Helper functions
async function registerManusWebhook(manusApiKey: string): Promise<string> {
  const response = await fetch('https://api.manus.im/v1/webhooks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${manusApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/webhook`,
      events: ['task_created', 'task_progress', 'task_stopped'],
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to register webhook with Manus');
  }

  const data = await response.json() as { webhook_id?: string; id?: string };
  return data.webhook_id || data.id || '';
}

async function deleteManusWebhook(manusApiKey: string, webhookId: string): Promise<void> {
  await fetch(`https://api.manus.im/v1/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${manusApiKey}`,
    },
  });
}
