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
 * Send onboarding messages to teach users about reply threads
 * Called after MCP config is sent, with a delay to give users time to paste the config
 */
async function sendOnboardingMessages(phoneNumber: string, delayMs: number = 7000) {
  const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
  
  // Wait for user to have time to paste the config and view the visual guide
  await new Promise(resolve => setTimeout(resolve, delayMs));
  
  // Message 1: Introduction
  await sendTypingIndicator(phoneNumber, 800);
  await sendIMessage(phoneNumber, "Here's how to use:");
  
  // Message 2: Reply threads explanation
  await sendTypingIndicator(phoneNumber, 1200);
  await sendIMessage(phoneNumber, "Reply to a message to continue that conversation (manus will remember everything in that thread)");
  
  // Message 3: New message explanation
  await sendTypingIndicator(phoneNumber, 1500);
  await sendIMessage(phoneNumber, "Send a new message (not a reply) to start fresh on a new topic");
  
  // Message 4: Email metaphor
  await sendTypingIndicator(phoneNumber, 900);
  await sendIMessage(phoneNumber, "Think of it as email threads.");
  
  // Message 5: Task acknowledgment
  await sendTypingIndicator(phoneNumber, 1200);
  await sendIMessage(phoneNumber, "If you give me a task, I'll react with 👍 to acknowledge it and ❤️ when it's been completed.");
  
  // Message 6: Revoke instruction
  await sendTypingIndicator(phoneNumber, 1000);
  await sendIMessage(phoneNumber, "(Use \"revoke\" to revoke your connection)");
  
  // Message 7: Closing
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

  // GET /go - Redirect route for Instagram iOS in-app browser workaround
  fastify.get('/go', async (request, reply) => {
    const raw = process.env.PHOTON_HANDLE ?? '';
    const photonHandle = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_PHOTON_HANDLE;
    // Shorter message for Instagram to avoid encoding issues
    const smsLink = `sms:${photonHandle}?body=Hey`;
    return reply.type('text/html').send(`
      <!DOCTYPE html><html><head>
      <meta http-equiv="refresh" content="0;url=${smsLink}">
      <script>window.location.href = '${smsLink}';</script>
      </head>
      <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <a href="${smsLink}" style="font-size:18px;padding:16px 32px;background:#34322D;color:#fff;border-radius:100px;text-decoration:none">
          Open iMessage
        </a>
      </body></html>
    `);
  });

  // GET / - Landing page with "Connect to Manus" button (Manus Brand Design)
  fastify.get('/', async (request, reply) => {
    const raw = process.env.PHOTON_HANDLE ?? '';
    const photonHandle = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_PHOTON_HANDLE;
    const smsLink = `sms:${photonHandle}?body=Hey`;
    const metaPixel = getMetaPixelCode();
    const openPanel = getOpenPanelScriptTag();
    
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connect to Manus</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="icon" type="image/png" href="/favicon.png?v=2">
          
          <!-- Open Graph / Facebook -->
          <meta property="og:type" content="website">
          <meta property="og:url" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/">
          <meta property="og:title" content="manus, in iMessages">
          <meta property="og:description" content="Connect Manus to iMessage">
          <meta property="og:image" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/assets/ogBanner.png?v=2">
          
          <!-- Twitter -->
          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:url" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/">
          <meta name="twitter:title" content="manus, in iMessages">
          <meta name="twitter:description" content="Connect Manus to iMessage">
          <meta name="twitter:image" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/assets/ogBanner.png?v=2">
          
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
          
          <style>
            * { 
              box-sizing: border-box; 
              margin: 0; 
              padding: 0;
              -webkit-font-smoothing: antialiased;
              -moz-osx-font-smoothing: grayscale;
            }
            
            html {
              height: 100%;
              -webkit-text-size-adjust: 100%;
            }
            
            body { 
              font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              min-height: 100vh;
              background: #FFFFFF;
              position: relative;
              overflow-x: hidden;
              overflow-y: auto;
              width: 100%;
              margin: 0;
              padding: 0;
            }
            
            /* Top Bar */
            .top-bar {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 24px 40px;
              z-index: 10;
            }
            
            .brand-logo {
              position: absolute;
              left: 40px;
              top: 24px;
            }
            
            .brand-logo img {
              height: 40px;
              width: auto;
            }
            
            /* Content container */
            .content {
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              padding: 60px 40px;
              max-width: 800px;
              margin: 0 auto;
              text-align: center;
              position: relative;
            }
            
            /* Available Badge */
            .available-badge {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              background: #FFFFFF;
              border: 1px solid #34322D;
              border-radius: 50px;
              padding: 8px 16px;
              font-size: 14px;
              color: #34322D;
              font-weight: 400;
            }
            
            .available-badge img {
              height: 20px;
              width: auto;
            }
            
            /* Logo */
            .logo {
              margin-bottom: 4px;
            }
            
            .logo img {
              height: 70px;
              width: auto;
              display: block;
              margin: 0 auto;
              transform: translateX(-5%);
            }
            
            .tagline {
              font-family: 'Libre Baskerville', serif;
              font-size: 24px;
              font-weight: 400;
              color: #34322D;
              margin-bottom: 20px;
              letter-spacing: -0.3px;
              line-height: 1;
              opacity: 0.9;
            }
            
            /* CTA Button */
            .connect-btn { 
              display: inline-flex;
              align-items: center;
              justify-content: center;
              gap: 10px;
              padding: 18px 48px;
              background: #34322D;
              color: #FFFFFF;
              text-decoration: none;
              font-size: 17px;
              font-weight: 500;
              border-radius: 100px;
              transition: all 0.2s ease;
              letter-spacing: -0.01em;
              border: none;
              cursor: pointer;
              outline: none;
            }
            
            .connect-btn img {
              height: 20px;
              width: auto;
            }
            
            .connect-btn:hover {
              background: #2a2823;
              transform: translateY(-2px);
              box-shadow: 0 8px 24px rgba(52, 50, 45, 0.2);
            }
            
            .connect-btn:active {
              transform: translateY(0);
            }
            
            /* Footer */
            .footer {
              position: fixed;
              bottom: 40px;
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
            
            .footer a:hover {
              opacity: 0.7;
            }
            
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
            
            /* Responsive Design */
            @media (max-width: 1024px) {
              .content {
                padding: 50px 30px;
              }
              
              .tagline {
                font-size: 22px;
              }
            }
            
            @media (max-width: 768px) {
              .top-bar {
                padding: 20px 24px;
              }
              
              .brand-logo {
                left: 24px;
                top: 20px;
              }
              
              .brand-logo img {
                height: 36px;
              }
              
              .content {
                padding: 40px 24px;
              }
              
              .available-badge {
                font-size: 13px;
                padding: 7px 14px;
              }
              
              .available-badge img {
                height: 18px;
              }
              
              .logo img {
                height: 56px;
              }
              
              .tagline {
                font-size: 20px;
                margin-bottom: 18px;
              }
              
              .connect-btn {
                padding: 16px 40px;
                font-size: 16px;
                gap: 8px;
              }
              
              .connect-btn img {
                height: 18px;
              }
              
              .footer {
                bottom: 30px;
              }
              
              .footer-text {
                font-size: 13px;
              }
              
              .footer-logo {
                height: 20px;
              }
            }
            
            @media (max-width: 480px) {
              .brand-logo img {
                height: 32px;
              }
              
              .content {
                padding: 32px 20px;
              }
              
              .logo img {
                height: 48px;
              }
              
              .tagline {
                font-size: 18px;
                margin-bottom: 16px;
              }
              
              .connect-btn {
                padding: 14px 32px;
                font-size: 15px;
              }
              
              .footer {
                bottom: 24px;
              }
              
              .footer-text {
                font-size: 12px;
              }
              
              .footer-logo {
                height: 18px;
              }
            }
            
            @media (max-width: 375px) {
              .logo img {
                height: 38px;
              }
              
              .tagline {
                font-size: 14px;
                gap: 6px;
                margin-bottom: 14px;
              }
              
              .imessage-logo {
                height: 20px;
              }
              
              .connect-btn {
                padding: 12px 28px;
                font-size: 14px;
              }
              
              .footer {
                bottom: 20px;
              }
              
              .footer-logo {
                height: 16px;
              }
            }
            
            /* Fallback UI styles */
            @keyframes fadeIn {
              from {
                opacity: 0;
                transform: translateY(10px);
              }
              to {
                opacity: 1;
                transform: translateY(0);
              }
            }
            
            #fallback-ui h2 {
              font-size: 22px;
            }
            
            #fallback-ui p {
              font-size: 14px;
            }
            
            #copy-phone-btn {
              font-size: 17px;
            }
            
            #copy-phone-btn:hover {
              background: #f5f5f5;
              transform: translateY(-1px);
              box-shadow: 0 4px 12px rgba(52, 50, 45, 0.12);
            }
            
            #copy-phone-btn:active {
              transform: translateY(0);
            }
            
            @media (max-width: 480px) {
              #fallback-ui {
                margin-top: 20px;
                max-width: 100%;
              }
              
              #fallback-ui h2 {
                font-size: 20px;
                margin-bottom: 10px;
              }
              
              #fallback-ui p {
                font-size: 13px;
                margin-bottom: 20px;
              }
              
              #copy-phone-btn {
                padding: 13px 18px;
                font-size: 16px;
              }
            }
            
            @media (max-width: 360px) {
              #fallback-ui h2 {
                font-size: 18px;
              }
              
              #fallback-ui p {
                font-size: 12px;
              }
              
              #copy-phone-btn {
                padding: 12px 16px;
                font-size: 15px;
              }
            }
          </style>
          ${metaPixel}
          ${openPanel}
        </head>
        <body>
          <!-- Top Bar -->
          <div class="top-bar">
            <div class="brand-logo">
              <img src="/assets/Manus-Logo-Lockup-Inline-Black.svg" alt="Manus from Meta">
            </div>
          </div>
          
          <!-- Content -->
          <div class="content">
            <div class="logo">
              <img src="/assets/Manus-Logo-Black.png" alt="Manus">
            </div>
            <div class="tagline">now in iMessage</div>
            
            <a href="${smsLink}" class="connect-btn" id="connect-btn" data-track="connect_to_manus_clicked">
              <img src="/assets/imessage_logo.png" alt="iMessage">
              <span>Start Connecting</span>
            </a>
            
            <!-- Fallback UI for in-app browsers -->
            <div id="fallback-ui" style="display: none; margin-top: 24px; max-width: 380px; width: 100%; animation: fadeIn 0.3s ease-in;">
              <h2 style="font-family: 'Libre Baskerville', serif; font-size: 22px; font-weight: 700; color: #34322D; margin-bottom: 12px; line-height: 1.3;">Opening iMessage...</h2>
              <p style="font-size: 14px; color: #34322D; opacity: 0.7; line-height: 1.5; margin-bottom: 24px;">Sometimes, browsers or apps may block iMessage from opening directly. You can open it manually and text the following number.</p>
              <button id="copy-phone-btn" style="width: 100%; padding: 14px 20px; background: #FFFFFF; border: 1.5px solid #34322D; border-radius: 8px; color: #34322D; font-size: 17px; font-weight: 600; cursor: pointer; transition: all 0.2s; font-family: 'DM Sans', sans-serif; letter-spacing: 0.3px; box-shadow: 0 2px 8px rgba(52, 50, 45, 0.08);">
                +1 ${photonHandle.replace(/^\+1/, '').replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')}
              </button>
            </div>
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
            document.addEventListener('DOMContentLoaded', function() {
              const connectButton = document.getElementById('connect-btn');
              const fallbackUI = document.getElementById('fallback-ui');
              const copyPhoneBtn = document.getElementById('copy-phone-btn');
              
              // Detect in-app browser
              function isInAppBrowser() {
                const ua = navigator.userAgent || navigator.vendor || window.opera;
                return /Twitter|FBAN|FBAV|Instagram|LinkedInApp|TikTok|Line/i.test(ua);
              }
              
              // Detect Instagram iOS specifically
              function isInstagramIOS() {
                const ua = navigator.userAgent || '';
                return /Instagram/i.test(ua) && /iPhone|iPad|iPod/i.test(ua);
              }
              
              // Handle connect button click
              if (connectButton) {
                connectButton.addEventListener('click', function(e) {
                  // Track button click
                  if (window.op) {
                    window.op('track', 'connect_to_manus_clicked');
                  }
                  
                  const href = this.getAttribute('href');
                  
                  // Instagram iOS in-app browser workaround: escape to Safari via x-safari-https scheme
                  if (isInstagramIOS()) {
                    e.preventDefault();
                    const publicUrl = '${process.env.PUBLIC_URL || 'https://manus.photon.codes'}';
                    const goUrl = publicUrl + '/connect/go';
                    
                    // Try to escape Instagram's WebView by opening in Safari
                    const safariUrl = goUrl.replace(/^https:\/\//, 'x-safari-https://').replace(/^http:\/\//, 'x-safari-http://');
                    window.location.href = safariUrl;
                    
                    // Fallback: If Safari doesn't open after 2 seconds, show manual fallback UI
                    // This handles cases where Safari is not the default browser
                    setTimeout(function() {
                      if (document.hasFocus()) {
                        connectButton.style.display = 'none';
                        fallbackUI.style.display = 'block';
                      }
                    }, 2000);
                    return;
                  }
                  
                  // If in-app browser (Twitter, Facebook, etc.), show fallback immediately
                  if (isInAppBrowser()) {
                    e.preventDefault();
                    connectButton.style.display = 'none';
                    fallbackUI.style.display = 'block';
                    return;
                  }
                  
                  // Try to open SMS, show fallback after delay if still on page
                  setTimeout(function() {
                    // If user is still on page after 1.5s, SMS likely didn't open
                    if (document.hasFocus()) {
                      connectButton.style.display = 'none';
                      fallbackUI.style.display = 'block';
                    }
                  }, 1500);
                });
              }
              
              // Track link clicks for Photon and Discord
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
              
              // Copy phone number to clipboard
              if (copyPhoneBtn) {
                const phoneNumber = '${photonHandle}';
                const formattedPhone = '+1 ${photonHandle.replace(/^\+1/, '').replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')}';
                
                copyPhoneBtn.addEventListener('click', function(e) {
                  e.preventDefault();
                  
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(phoneNumber).then(function() {
                      copyPhoneBtn.textContent = 'Copied!';
                      copyPhoneBtn.style.background = '#34c759';
                      copyPhoneBtn.style.color = '#FFFFFF';
                      copyPhoneBtn.style.borderColor = '#34c759';
                      setTimeout(function() {
                        copyPhoneBtn.textContent = formattedPhone;
                        copyPhoneBtn.style.background = '#FFFFFF';
                        copyPhoneBtn.style.color = '#34322D';
                        copyPhoneBtn.style.borderColor = '#34322D';
                      }, 2000);
                    }).catch(function() {
                      fallbackCopy(phoneNumber, formattedPhone);
                    });
                  } else {
                    fallbackCopy(phoneNumber, formattedPhone);
                  }
                });
              }
              
              function fallbackCopy(text, formattedText) {
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.opacity = '0';
                document.body.appendChild(textArea);
                textArea.select();
                try {
                  document.execCommand('copy');
                  copyPhoneBtn.textContent = 'Copied!';
                  copyPhoneBtn.style.background = '#34c759';
                  copyPhoneBtn.style.color = '#FFFFFF';
                  copyPhoneBtn.style.borderColor = '#34c759';
                  setTimeout(function() {
                    copyPhoneBtn.textContent = formattedText;
                    copyPhoneBtn.style.background = '#FFFFFF';
                    copyPhoneBtn.style.color = '#34322D';
                    copyPhoneBtn.style.borderColor = '#34322D';
                  }, 2000);
                } catch (err) {
                  alert('Please copy the number manually: ' + text);
                }
                document.body.removeChild(textArea);
              }
            });
          </script>
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
        
        // [1.5 sec typing indicator] "Sure! Please input your Manus token..."
        await sendTypingIndicator(phoneNumber, 1500);
        await sendIMessage(phoneNumber, `Sure! Please input your Manus token in the following link:\n\n${linkUrl}`);
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

  // GET /connect/:connectionId - Token input page (Manus Brand Design)
  fastify.get('/:connectionId', async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };
    const metaPixel = getMetaPixelCode();
    const openPanel = getOpenPanelScriptTag();

    const connection = await prisma.connection.findUnique({
      where: { connectionId },
    });

    // Don't reveal if connection exists - always show the form
    // Backend validation will handle invalid connections
    const connectionExists = !!connection;
    
    // If connection is already ACTIVE, show the MCP config page directly
    const isActive = connection?.status === 'ACTIVE';
    const mcpConfig = isActive && connection?.photonApiKey ? {
      mcpServers: {
        'photon-imessage': {
          type: 'streamableHttp',
          url: `${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/mcp/http`,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            Authorization: `Bearer ${connection.photonApiKey}`,
          },
        },
      },
    } : null;

    // HTML form with Manus brand design
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connect to Manus</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="icon" type="image/png" href="/favicon.png?v=2">
          
          <!-- Open Graph / Facebook -->
          <meta property="og:type" content="website">
          <meta property="og:url" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/connect/${connectionId}">
          <meta property="og:title" content="Complete Manus Setup">
          <meta property="og:description" content="Enter your Manus API key to complete the connection and bring Manus to your iMessage">
          <meta property="og:image" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/assets/ogBanner.png?v=2">
          
          <!-- Twitter -->
          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:url" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/connect/${connectionId}">
          <meta name="twitter:title" content="Complete Manus Setup">
          <meta name="twitter:description" content="Enter your Manus API key to complete the connection and bring Manus to your iMessage">
          <meta name="twitter:image" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/assets/ogBanner.png?v=2">
          
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
          
          <style>
            * { 
              box-sizing: border-box; 
              margin: 0; 
              padding: 0;
              -webkit-font-smoothing: antialiased;
              -moz-osx-font-smoothing: grayscale;
            }
            
            html {
              height: 100%;
              -webkit-text-size-adjust: 100%;
            }
            
            body { 
              font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              min-height: 100vh;
              background: #F8F8F8;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 40px 20px;
              position: relative;
              overflow: hidden;
              width: 100%;
              margin: 0;
            }
            
            .container {
              max-width: 520px;
              width: 100%;
              text-align: center;
              position: relative;
            }
            
            /* Form Section */
            #form-section {
              text-align: center;
            }
            
            h1 {
              font-family: 'Libre Baskerville', serif;
              font-size: 36px;
              font-weight: 700;
              color: #34322D;
              margin-bottom: 12px;
              line-height: 1.2;
            }
            
            .subtitle {
              font-size: 16px;
              color: #34322D;
              opacity: 0.7;
              margin-bottom: 16px;
              line-height: 1.5;
            }
            
            .get-key-link {
              display: inline-block;
              color: #34322D;
              text-decoration: underline;
              font-size: 14px;
              margin-bottom: 28px;
              transition: opacity 0.2s;
              opacity: 0.8;
            }
            
            .get-key-link:hover {
              opacity: 1;
            }
            
            .input-wrapper {
              margin-bottom: 16px;
              max-width: 450px;
              margin-left: auto;
              margin-right: auto;
            }
            
            input {
              width: 100%;
              padding: 14px 20px;
              font-size: 15px;
              border: 1px solid #34322D;
              border-radius: 8px;
              background: #FFFFFF;
              transition: all 0.2s;
              font-family: 'DM Sans', sans-serif;
              color: #34322D;
            }
            
            input:focus {
              outline: none;
              border-color: #34322D;
              box-shadow: 0 0 0 3px rgba(52, 50, 45, 0.1);
            }
            
            input::placeholder {
              color: rgba(52, 50, 45, 0.4);
            }
            
            .submit-btn {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 14px 36px;
              background: #34322D;
              color: #FFFFFF;
              border: none;
              font-size: 15px;
              font-weight: 500;
              border-radius: 100px;
              cursor: pointer;
              transition: all 0.2s ease;
              letter-spacing: -0.01em;
              font-family: 'DM Sans', sans-serif;
            }
            
            .submit-btn:hover:not(:disabled) {
              background: #2a2823;
              transform: translateY(-1px);
              box-shadow: 0 4px 12px rgba(52, 50, 45, 0.2);
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
              padding: 12px 18px;
              background: rgba(255, 59, 48, 0.1);
              color: #ff3b30;
              border: 1px solid rgba(255, 59, 48, 0.3);
              border-radius: 8px;
              font-size: 13px;
              display: none;
              max-width: 450px;
              margin-left: auto;
              margin-right: auto;
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
              font-family: 'Libre Baskerville', serif;
              font-size: 32px;
              font-weight: 700;
              color: #34322D;
              margin-bottom: 12px;
            }
            
            .success-subtitle {
              font-size: 15px;
              color: #34322D;
              opacity: 0.7;
              margin-bottom: 32px;
              line-height: 1.5;
            }
            
            .config-container {
              background: #FFFFFF;
              border: 1px solid #34322D;
              border-radius: 8px;
              padding: 20px 24px;
              margin-bottom: 24px;
              position: relative;
              text-align: left;
              max-width: 550px;
              margin-left: auto;
              margin-right: auto;
            }
            
            .config-container pre {
              overflow-x: auto;
              font-size: 12px;
              line-height: 1.5;
              color: #34322D;
              font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
              padding-right: 80px;
            }
            
            .copy-btn {
              position: absolute;
              top: 16px;
              right: 16px;
              padding: 6px 14px;
              background: #34322D;
              color: #FFFFFF;
              border: none;
              border-radius: 100px;
              cursor: pointer;
              font-size: 12px;
              font-weight: 500;
              transition: all 0.2s;
              font-family: 'DM Sans', sans-serif;
            }
            
            .copy-btn:hover {
              background: #2a2823;
              transform: scale(1.05);
            }
            
            .copy-btn.copied {
              background: #34c759;
            }
            
            .action-btn {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 14px 32px;
              background: #34322D;
              color: #FFFFFF;
              text-decoration: none;
              font-size: 15px;
              font-weight: 500;
              border-radius: 100px;
              transition: all 0.2s ease;
              letter-spacing: -0.01em;
              border: none;
              cursor: pointer;
              font-family: 'DM Sans', sans-serif;
            }
            
            .action-btn:hover {
              background: #2a2823;
              transform: translateY(-1px);
              box-shadow: 0 4px 12px rgba(52, 50, 45, 0.2);
            }
            
            .action-btn:active {
              transform: translateY(0);
            }
            
            .note {
              margin-top: 20px;
              font-size: 13px;
              color: #34322D;
              opacity: 0.6;
            }
            
            /* Footer */
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
            
            .footer a:hover {
              opacity: 0.7;
            }
            
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
            
            /* Responsive Design */
            @media (max-width: 768px) {
              h1 {
                font-size: 32px;
              }
              
              .subtitle, .success-subtitle {
                font-size: 16px;
                margin-bottom: 28px;
              }
              
              .get-key-link {
                font-size: 15px;
                margin-bottom: 24px;
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
              
              .footer-logo {
                height: 20px;
              }
              
              .success-title {
                font-size: 26px;
              }
            }
            
            @media (max-width: 480px) {
              h1 {
                font-size: 28px;
                margin-bottom: 12px;
              }
              
              .subtitle {
                font-size: 15px;
                margin-bottom: 24px;
              }
              
              .get-key-link {
                font-size: 14px;
                margin-bottom: 20px;
              }
              
              .config-container {
                padding: 14px;
                border-radius: 8px;
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
              
              .footer-logo {
                height: 18px;
              }
              
              .success-title {
                font-size: 22px;
                margin-bottom: 10px;
              }
              
              .success-subtitle {
                font-size: 14px;
                margin-bottom: 24px;
              }
            }
          </style>
          ${metaPixel}
          ${openPanel}
        </head>
        <body>
          <div class="container">
            <!-- Form Section -->
            <div id="form-section">
              <h1>Complete Setup</h1>
              <p class="subtitle">Enter your Manus API key to activate the connection</p>
              
              <a href="https://manus.im/app#settings/integrations/api" target="_blank" class="get-key-link">Get your API key &rarr;</a>
              
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
                <button type="submit" class="submit-btn" id="submitBtn">
                  Continue
                </button>
              </form>
              
              <div id="error" class="error"></div>
            </div>
            
            <!-- Success Section -->
            <div id="success-section">
              <h1 class="success-title">All Set!</h1>
              <p class="success-subtitle">Copy the configuration below and paste it in Manus</p>
              
              <div class="config-container">
                <button class="copy-btn" onclick="copyConfig()">Copy</button>
                <pre id="config"></pre>
              </div>
              
              <a href="https://manus.im/app#settings/connectors/mcp-server" target="_blank" class="action-btn">
                Open Manus Settings &rarr;
              </a>
              
              <p class="note">Configuration also sent to your iMessage</p>
            </div>
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
            let mcpConfigData = null;
            
            // Validate Manus API key format
            function isValidManusApiKey(key) {
              // Manus API keys start with sk- followed by base64-like characters
              // Format: sk-[A-Za-z0-9_-]{70,100}
              return /^sk-[A-Za-z0-9_-]{70,100}$/.test(key);
            }
            
            // Track when user pastes API key
            document.getElementById('manusApiKey').addEventListener('paste', function() {
              if (window.op) {
                window.op('track', 'manus_api_key_pasted', { connectionId: '${connectionId}' });
              }
            });
            
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
            
            // Check if connection is already active and show success page
            (function() {
              const isActive = ${isActive ? 'true' : 'false'};
              const existingConfig = ${mcpConfig ? JSON.stringify(mcpConfig) : 'null'};
              
              if (isActive && existingConfig) {
                mcpConfigData = existingConfig;
                document.getElementById('config').textContent = JSON.stringify(existingConfig, null, 2);
                document.getElementById('form-section').style.display = 'none';
                document.getElementById('success-section').style.display = 'block';
              }
            })();
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
