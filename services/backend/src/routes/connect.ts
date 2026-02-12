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
  // GET /revoke - Revoke connection page
  fastify.get('/revoke', async (request, reply) => {
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Revoke Manus Connection</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="icon" type="image/png" href="/favicon.png">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              min-height: 100vh;
              background: #ffffff;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
              position: relative;
              transition: background 0.3s ease;
            }
            body.dark-mode { background: #1a1a1a; }
            
            .theme-selector { position: fixed; top: 24px; right: 24px; z-index: 1000; }
            .theme-button { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: white; border: 1.5px solid #d1d5db; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; color: #374151; transition: all 0.2s; }
            .theme-button:hover { border-color: #2563eb; }
            body.dark-mode .theme-button { background: #27272a; border-color: #52525b; color: #e4e4e7; }
            body.dark-mode .theme-button:hover { border-color: #3b82f6; }
            .theme-button svg { width: 12px; height: 12px; fill: currentColor; transition: transform 0.2s; }
            .theme-button.open svg { transform: rotate(180deg); }
            .theme-dropdown { position: absolute; top: calc(100% + 8px); right: 0; min-width: 200px; background: white; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); display: none; overflow: hidden; }
            .theme-dropdown.show { display: block; }
            body.dark-mode .theme-dropdown { background: #27272a; border-color: #3f3f46; }
            .theme-option { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; cursor: pointer; font-size: 14px; color: #374151; transition: background 0.15s; }
            .theme-option:hover { background: #f3f4f6; }
            body.dark-mode .theme-option { color: #e4e4e7; }
            body.dark-mode .theme-option:hover { background: #3f3f46; }
            .theme-option.active { font-weight: 500; }
            .theme-option svg { width: 16px; height: 16px; fill: #2563eb; opacity: 0; }
            .theme-option.active svg { opacity: 1; }
            body.dark-mode .theme-option svg { fill: #3b82f6; }
            
            .container { max-width: 480px; width: 100%; text-align: center; }
            h1 { font-size: 32px; font-weight: 600; color: #000000; margin-bottom: 12px; transition: color 0.3s ease; }
            body.dark-mode h1 { color: #ffffff; }
            .subtitle { font-size: 17px; color: rgba(0, 0, 0, 0.6); margin-bottom: 32px; line-height: 1.5; transition: color 0.3s ease; }
            body.dark-mode .subtitle { color: rgba(255, 255, 255, 0.6); }
            .warning { 
              background: rgba(255, 59, 48, 0.1); 
              border: 1px solid rgba(255, 59, 48, 0.3);
              border-radius: 12px;
              padding: 16px;
              margin-bottom: 24px;
              color: #ff3b30;
              font-size: 15px;
            }
            input {
              width: 100%;
              padding: 16px 20px;
              font-size: 17px;
              border: 1px solid rgba(0, 0, 0, 0.1);
              border-radius: 12px;
              background: rgba(0, 0, 0, 0.02);
              margin-bottom: 16px;
              color: #000000;
              transition: all 0.3s ease;
            }
            body.dark-mode input { background: #2a2a2a; border-color: rgba(255, 255, 255, 0.2); color: #ffffff; }
            input:focus { outline: none; border-color: rgba(0, 0, 0, 0.3); background: #ffffff; }
            body.dark-mode input:focus { border-color: rgba(255, 255, 255, 0.4); background: #2a2a2a; }
            input::placeholder { color: rgba(0, 0, 0, 0.3); }
            body.dark-mode input::placeholder { color: rgba(255, 255, 255, 0.3); }
            .btn {
              width: 100%;
              padding: 16px 48px;
              background: #ff3b30;
              color: #ffffff;
              border: none;
              font-size: 17px;
              font-weight: 500;
              border-radius: 12px;
              cursor: pointer;
              transition: all 0.3s;
            }
            .btn:hover:not(:disabled) { background: #ff2d1f; transform: translateY(-1px); }
            .btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .success { 
              background: rgba(52, 199, 89, 0.1); 
              border: 1px solid rgba(52, 199, 89, 0.3);
              border-radius: 12px;
              padding: 16px;
              color: #34c759;
              font-size: 15px;
              display: none;
            }
            .error { 
              background: rgba(255, 59, 48, 0.1); 
              border: 1px solid rgba(255, 59, 48, 0.3);
              border-radius: 12px;
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
              color: rgba(0, 0, 0, 0.4);
              font-size: 14px;
              font-weight: 400;
              transition: color 0.3s ease;
            }
            body.dark-mode .footer-text { color: rgba(255, 255, 255, 0.4); }
            .footer a {
              text-decoration: none;
              transition: opacity 0.2s;
              display: inline-block;
            }
            .footer a:hover { opacity: 0.7; }
            .footer-logo {
              height: 16px;
              width: auto;
              transition: opacity 0.2s;
              vertical-align: middle;
            }
            .footer-logo.dark-logo {
              display: inline-block !important;
            }
            .footer-logo.light-logo {
              display: none !important;
            }
            body.dark-mode .footer-logo.dark-logo {
              display: none !important;
            }
            body.dark-mode .footer-logo.light-logo {
              display: inline-block !important;
            }
            .footer-link {
              color: rgba(0, 0, 0, 0.6);
              font-weight: 500;
              letter-spacing: -0.01em;
            }
            body.dark-mode .footer-link {
              color: rgba(255, 255, 255, 0.6);
            }
            .footer-link:hover {
              color: rgba(0, 0, 0, 0.9);
            }
            body.dark-mode .footer-link:hover {
              color: rgba(255, 255, 255, 0.9);
            }
            @media (max-width: 768px) {
              .footer-logo {
                height: 14px;
              }
            }
            @media (max-width: 480px) {
              .theme-selector { top: 16px; right: 16px; }
              .footer-logo {
                height: 12px;
              }
            }
            @media (max-width: 360px) {
              .footer-logo {
                height: 10px;
              }
            }
          </style>
        </head>
        <body>
          <!-- Theme selector -->
          <div class="theme-selector">
            <button class="theme-button" onclick="toggleThemeDropdown()" aria-label="Select theme">
              <span id="theme-label">Light</span>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/></svg>
            </button>
            <div class="theme-dropdown" id="theme-dropdown">
              <div class="theme-option" onclick="setTheme('system')" data-theme="system"><span>Use system setting</span><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg></div>
              <div class="theme-option" onclick="setTheme('light')" data-theme="light"><span>Light</span><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg></div>
              <div class="theme-option" onclick="setTheme('dark')" data-theme="dark"><span>Dark</span><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg></div>
            </div>
          </div>
          
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
              <span class="footer-text">built by</span>
              <a href="https://photon.codes" target="_blank" rel="noopener noreferrer">
                <img src="/photon-logo-dark.png" alt="Photon" class="footer-logo dark-logo">
                <img src="/photon-logo-light.png" alt="Photon" class="footer-logo light-logo">
              </a>
            </div>
            <div class="footer-text">
              join community at <a href="https://dub.sh/photon-discord" target="_blank" rel="noopener noreferrer" class="footer-link">Discord</a>
            </div>
          </div>
          
          <script>
            function getSystemTheme() { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
            function applyTheme(theme) { if (theme === 'system') theme = getSystemTheme(); document.body.classList.toggle('dark-mode', theme === 'dark'); }
            function updateThemeLabel() {
              const savedTheme = localStorage.getItem('theme') || 'system';
              document.getElementById('theme-label').textContent = savedTheme === 'system' ? 'Use system setting' : savedTheme.charAt(0).toUpperCase() + savedTheme.slice(1);
              document.querySelectorAll('.theme-option').forEach(opt => opt.classList.toggle('active', opt.dataset.theme === savedTheme));
            }
            function setTheme(theme) { localStorage.setItem('theme', theme); applyTheme(theme); updateThemeLabel(); toggleThemeDropdown(); }
            function toggleThemeDropdown() {
              document.getElementById('theme-dropdown').classList.toggle('show');
              document.querySelector('.theme-button').classList.toggle('open');
            }
            document.addEventListener('click', (e) => {
              const selector = document.querySelector('.theme-selector');
              if (selector && !selector.contains(e.target)) {
                document.getElementById('theme-dropdown').classList.remove('show');
                document.querySelector('.theme-button').classList.remove('open');
              }
            });
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
              if ((localStorage.getItem('theme') || 'system') === 'system') applyTheme('system');
            });
            applyTheme(localStorage.getItem('theme') || 'system');
            updateThemeLabel();
            
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
          </script>
        </body>
      </html>
    `);
  });

  // Default SMS number when PHOTON_HANDLE is missing/empty in env (e.g. in Docker)
  const DEFAULT_PHOTON_HANDLE = '+14158156704';

  // GET / - Landing page with "Connect to Manus" button
  fastify.get('/', async (request, reply) => {
    const raw = process.env.PHOTON_HANDLE ?? '';
    const photonHandle = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_PHOTON_HANDLE;
    const smsLink = `sms:${photonHandle}&body=Hey Manus! Please connect my iMessage`;
    
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connect to Manus</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="icon" type="image/png" href="/favicon.png">
          
          <!-- Open Graph / Facebook -->
          <meta property="og:type" content="website">
          <meta property="og:url" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/">
          <meta property="og:title" content="Manus Connector for iMessage">
          <meta property="og:description" content="Manus gives you superpowers. But here's the truth: You're not sitting at your computer all day. So we built the bridge.">
          <meta property="og:image" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/assets/og-preview.png">
          
          <!-- Twitter -->
          <meta property="twitter:card" content="summary_large_image">
          <meta property="twitter:url" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/">
          <meta property="twitter:title" content="Manus Connector for iMessage">
          <meta property="twitter:description" content="Manus gives you superpowers. But here's the truth: You're not sitting at your computer all day. So we built the bridge.">
          <meta property="twitter:image" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/assets/og-preview.png">
          
          <style>
            @font-face {
              font-family: 'Manus';
              src: url('/assets/manus-font-regular.woff2') format('woff2');
              font-weight: normal;
              font-style: normal;
            }

            @font-face {
              font-family: 'Manus';
              src: url('/assets/manus-font-light.woff2') format('woff2');
              font-weight: 300;
              font-style: normal;
            }
          
            * { 
              box-sizing: border-box; 
              margin: 0; 
              padding: 0;
              -webkit-font-smoothing: antialiased;
              -moz-osx-font-smoothing: grayscale;
            }
            
            html {
              height: 100%;
              height: -webkit-fill-available;
              -webkit-text-size-adjust: 100%;
            }
            
            body { 
              font-family: 'Manus', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              min-height: 100vh;
              min-height: -webkit-fill-available;
              background: url('/assets/background.jpeg') no-repeat center center fixed;
              background-size: cover;
              background-position: center center;
              position: relative;
              overflow-x: hidden;
              overflow-y: auto;
              width: 100%;
              margin: 0;
              padding: 0;
            }
            
            @supports (-webkit-touch-callout: none) {
              body {
                min-height: -webkit-fill-available;
              }
            }
            
            body::before {
              content: '';
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              width: 100%;
              height: 100%;
              min-height: 100vh;
              min-height: -webkit-fill-available;
              background: rgba(0, 0, 0, 0.45);
              z-index: 0;
              pointer-events: none;
            }
            
            /* Content container */
            .content {
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              padding: 40px 20px;
              max-width: 900px;
              margin: 0 auto;
              text-align: center;
              position: relative;
              z-index: 1;
            }
            
            /* Logo */
            .logo {
              font-family: 'Manus', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              font-size: 32px;
              font-weight: 300;
              color: #ffffff;
              margin-bottom: 28px;
              letter-spacing: -0.5px;
              text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            }
            
            /* Message */
            .message {
              font-family: 'Manus', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              font-size: 16px;
              color: #ffffff;
              line-height: 1.3;
              font-weight: 400;
              margin-bottom: 28px;
              max-width: 500px;
              letter-spacing: -0.2px;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            }
            
            .message p {
              margin-bottom: 10px;
            }
            
            .message .emphasis {
              font-family: 'Manus', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              font-weight: 400;
              font-size: 18px;
              margin: 15px 0;
            }
            
            /* Liquid Glass Button */
            .connect-btn { 
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 16px 48px;
              background: transparent;
              color: #ffffff;
              text-decoration: none;
              font-size: 17px;
              font-weight: 500;
              border-radius: 50px;
              transition: transform 0.2s ease;
              letter-spacing: -0.01em;
              border: none;
              position: relative;
              overflow: hidden;
              cursor: pointer;
              outline: none;
            }
            
            .connect-btn:hover {
              transform: scale(1.05);
            }
            
            .connect-btn:active {
              transform: scale(0.95);
            }
            
            .glass-filter,
            .glass-overlay,
            .glass-specular {
              position: absolute;
              inset: 0;
              border-radius: 50px;
            }
            
            .glass-filter {
              z-index: 1;
              backdrop-filter: blur(2px);
              filter: url(#glass-distortion) saturate(40%) brightness(0.4);
            }
            
            .glass-overlay {
              z-index: 2;
              background: rgba(255, 255, 255, 0.35);
              border: 1px solid rgba(255, 255, 255, 0.4);
            }
            
            .glass-specular {
              z-index: 3;
              box-shadow: inset 1px 1px 1px rgba(255, 255, 255, 0.75);
            }
            
            .glass-content {
              position: relative;
              z-index: 4;
              color: #ffffff;
              font-weight: 500;
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
              z-index: 1;
            }
            
            .footer-row {
              display: flex;
              align-items: center;
              gap: 8px;
              flex-wrap: wrap;
              justify-content: center;
            }
            
            .footer-text {
              color: rgba(255, 255, 255, 0.9);
              font-size: 14px;
              font-weight: 400;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
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
              height: 16px;
              width: auto;
              transition: opacity 0.2s;
              vertical-align: middle;
              filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
            }
            
            .footer-logo.dark-logo {
              display: none !important;
            }
            
            .footer-logo.light-logo {
              display: inline-block !important;
            }
            
            .footer-link {
              color: rgba(255, 255, 255, 0.9);
              font-weight: 500;
              letter-spacing: -0.01em;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            }
            
            .footer-link:hover {
              color: rgba(255, 255, 255, 1);
            }
            
            /* Responsive Design */
            @media (max-width: 1024px) {
              .content {
                padding: 40px 30px;
              }
              
              .logo {
                font-size: 30px;
              }
              
              .message {
                font-size: 15px;
              }
            }
            
            @media (max-width: 768px) {
              body {
                background-size: cover;
                background-position: center center;
                padding: 30px 20px;
              }
              
              .content {
                padding: 30px 20px;
              }
              
              .logo {
                font-size: 26px;
                margin-bottom: 22px;
              }
              
              .message {
                font-size: 14px;
                max-width: 90%;
              }
              
              .message p {
                margin-bottom: 9px;
              }
              
              .message .emphasis {
                font-size: 16px;
                margin: 13px 0;
              }
              
              .connect-btn {
                padding: 12px 32px;
                font-size: 14px;
              }
              
              .footer {
                bottom: 20px;
              }
              
              .footer-text {
                font-size: 13px;
              }
              
              .footer-logo {
                height: 13px;
              }
            }
            
            @media (max-width: 480px) {
              body {
                background-size: cover;
                background-position: center center;
                padding: 24px 16px;
              }
              
              .content {
                padding: 24px 16px;
              }
              
              .logo {
                font-size: 22px;
                margin-bottom: 18px;
              }
              
              .message {
                font-size: 13px;
                max-width: 95%;
              }
              
              .message p {
                margin-bottom: 8px;
              }
              
              .message .emphasis {
                font-size: 15px;
                margin: 12px 0;
              }
              
              .connect-btn {
                padding: 11px 28px;
                font-size: 13px;
              }
              
              .footer {
                bottom: 16px;
              }
              
              .footer-text {
                font-size: 12px;
              }
              
              .footer-logo {
                height: 12px;
              }
            }
            
            @media (max-width: 375px) {
              body {
                padding: 20px 12px;
              }
              
              .content {
                padding: 20px 12px;
              }
              
              .logo {
                font-size: 20px;
                margin-bottom: 16px;
              }
              
              .message {
                font-size: 12px;
              }
              
              .message p {
                margin-bottom: 7px;
              }
              
              .message .emphasis {
                font-size: 14px;
                margin: 10px 0;
              }
              
              .connect-btn {
                padding: 10px 24px;
                font-size: 12px;
              }
              
              .footer {
                bottom: 12px;
              }
              
              .footer-text {
                font-size: 11px;
              }
              
              .footer-logo {
                height: 11px;
              }
            }
            
            @media (max-width: 320px) {
              .logo {
                font-size: 18px;
              }
              
              .message {
                font-size: 11px;
              }
              
              .message .emphasis {
                font-size: 13px;
              }
              
              .connect-btn {
                padding: 9px 20px;
                font-size: 11px;
              }
            }
          </style>
        </head>
        <body>
          <!-- SVG Filter for Glass Distortion -->
          <svg style="display: none">
            <filter id="glass-distortion">
              <feTurbulence type="turbulence" baseFrequency="0.008" numOctaves="2" result="noise" />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale="77" />
            </filter>
          </svg>
          
          <!-- Content -->
          <div class="content">
            <div class="logo">manus</div>
            
            <div class="message">
              <p>Manus gives you superpowers.<br>But here's the truth:</p>
              
              <p>You're not sitting at your computer all day.<br>
              You're moving. Texting. Living.</p>
              
              <p>So we built the bridge.</p>
              
              <p class="emphasis">Manus Connector for iMessage.</p>
            </div>
            
            <a href="${smsLink}" class="connect-btn">
              <div class="glass-filter"></div>
              <div class="glass-overlay"></div>
              <div class="glass-specular"></div>
              <div class="glass-content">
                <span>Connect to Manus</span>
              </div>
            </a>
          </div>
          
          <!-- Footer -->
          <div class="footer">
            <div class="footer-row">
              <span class="footer-text">built by</span>
              <a href="https://photon.codes" target="_blank" rel="noopener noreferrer">
                <img src="/photon-logo-dark.png" alt="Photon" class="footer-logo dark-logo">
                <img src="/photon-logo-light.png" alt="Photon" class="footer-logo light-logo">
              </a>
            </div>
            <div class="footer-text">
              join community at <a href="https://dub.sh/photon-discord" target="_blank" rel="noopener noreferrer" class="footer-link">Discord</a>
            </div>
          </div>
          
          <script>
            document.addEventListener('DOMContentLoaded', function() {
              // Liquid Glass Button Mouse Effect
              const glassButton = document.querySelector('.connect-btn');
              
              if (glassButton) {
                glassButton.addEventListener('mousemove', function(e) {
                  const rect = this.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const y = e.clientY - rect.top;
                  
                  const specular = this.querySelector('.glass-specular');
                  if (specular) {
                    specular.style.background = \`radial-gradient(
                      circle at \${x}px \${y}px,
                      rgba(255,255,255,0.15) 0%,
                      rgba(255,255,255,0.05) 30%,
                      rgba(255,255,255,0) 60%
                    )\`;
                  }
                });
                
                glassButton.addEventListener('mouseleave', function() {
                  const specular = this.querySelector('.glass-specular');
                  if (specular) {
                    specular.style.background = 'none';
                  }
                });
              }
              
              // Subtle Background Parallax Effect (opposite to mouse direction)
              document.addEventListener('mousemove', function(e) {
                const moveX = (e.clientX - window.innerWidth / 2) / window.innerWidth;
                const moveY = (e.clientY - window.innerHeight / 2) / window.innerHeight;
                
                // Move opposite to mouse direction (negative values)
                const offsetX = -moveX * 10;
                const offsetY = -moveY * 10;
                
                document.body.style.backgroundPosition = \`calc(50% + \${offsetX}px) calc(50% + \${offsetY}px)\`;
              });
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
        const { sendIMessage, sendTypingIndicator } = await import('../lib/imessage.js');
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
        
        // [1 sec typing indicator] Send link to where to paste the config
        await sendTypingIndicator(connection.phoneNumber, 1000);
        await sendIMessage(connection.phoneNumber, "Paste it here:\n\nhttps://manus.im/app#settings/connectors/mcp-server");
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

  // GET /connect/:connectionId - Token input page
  fastify.get('/:connectionId', async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };

    const connection = await prisma.connection.findUnique({
      where: { connectionId },
    });

    // Don't reveal if connection exists - always show the form
    // Backend validation will handle invalid connections
    const connectionExists = !!connection;

    // HTML form with improved UI
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connect to Manus</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="icon" type="image/png" href="/favicon.png">
          
          <!-- Open Graph / Facebook -->
          <meta property="og:type" content="website">
          <meta property="og:url" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/connect/${connectionId}">
          <meta property="og:title" content="Complete Manus Setup">
          <meta property="og:description" content="Enter your Manus API key to complete the connection and bring Manus to your iMessage">
          <meta property="og:image" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/assets/og-preview.png">
          
          <!-- Twitter -->
          <meta property="twitter:card" content="summary_large_image">
          <meta property="twitter:url" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/connect/${connectionId}">
          <meta property="twitter:title" content="Complete Manus Setup">
          <meta property="twitter:description" content="Enter your Manus API key to complete the connection and bring Manus to your iMessage">
          <meta property="twitter:image" content="${process.env.PUBLIC_URL || 'https://manus.photon.codes'}/assets/og-preview.png">
          
          <style>
            @font-face {
              font-family: 'Manus';
              src: url('/assets/manus-font-regular.woff2') format('woff2');
              font-weight: normal;
              font-style: normal;
            }

            @font-face {
              font-family: 'Manus';
              src: url('/assets/manus-font-light.woff2') format('woff2');
              font-weight: 300;
              font-style: normal;
            }
          
            * { 
              box-sizing: border-box; 
              margin: 0; 
              padding: 0;
              -webkit-font-smoothing: antialiased;
              -moz-osx-font-smoothing: grayscale;
            }
            
            html {
              height: 100%;
              height: -webkit-fill-available;
              -webkit-text-size-adjust: 100%;
            }
            
            body { 
              font-family: 'Manus', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              min-height: 100vh;
              background: url('/assets/background.jpeg') no-repeat center center;
              background-size: cover;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 40px 20px;
              position: relative;
              overflow: hidden;
              width: 100%;
              margin: 0;
            }
            
            body::before {
              content: '';
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              width: 100%;
              height: 100%;
              min-height: 100vh;
              min-height: -webkit-fill-available;
              background: rgba(0, 0, 0, 0.45);
              z-index: 0;
              pointer-events: none;
            }
            
            .container {
              max-width: 520px;
              width: 100%;
              text-align: center;
              position: relative;
              z-index: 1;
            }
            
            /* Form Section */
            #form-section {
              text-align: center;
            }
            
            h1 {
              font-family: 'Manus', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              font-size: 36px;
              font-weight: 300;
              color: #ffffff;
              margin-bottom: 8px;
              line-height: 1.05;
              letter-spacing: -0.5px;
              text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            }
            
            .subtitle {
              font-size: 16px;
              color: rgba(255, 255, 255, 0.95);
              margin-bottom: 16px;
              line-height: 1.5;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            }
            
            .get-key-link {
              display: inline-block;
              color: rgba(255, 255, 255, 0.9);
              text-decoration: none;
              font-size: 14px;
              margin-bottom: 28px;
              transition: color 0.2s;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            }
            
            .get-key-link:hover {
              color: #ffffff;
            }
            
            .input-wrapper {
              margin-bottom: 16px;
              max-width: 450px;
              margin-left: auto;
              margin-right: auto;
            }
            
            input {
              width: 100%;
              padding: 12px 20px;
              font-size: 14px;
              border: 1px solid rgba(255, 255, 255, 0.4);
              border-radius: 50px;
              background: rgba(255, 255, 255, 0.25);
              backdrop-filter: blur(12px);
              transition: all 0.2s;
              font-family: 'Manus', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              color: #ffffff;
              box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
            }
            
            input:focus {
              outline: none;
              border-color: rgba(255, 255, 255, 0.6);
              background: rgba(255, 255, 255, 0.3);
              box-shadow: 0 6px 24px rgba(0, 0, 0, 0.15);
            }
            
            input::placeholder {
              color: rgba(255, 255, 255, 0.6);
            }
            
            .submit-btn {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 12px 36px;
              background: transparent;
              color: #ffffff;
              border: none;
              font-size: 14px;
              font-weight: 500;
              border-radius: 50px;
              cursor: pointer;
              transition: transform 0.2s ease;
              letter-spacing: -0.01em;
              position: relative;
              overflow: hidden;
              outline: none;
            }
            
            .submit-btn:hover:not(:disabled) {
              transform: scale(1.05);
            }
            
            .submit-btn:active:not(:disabled) {
              transform: scale(0.95);
            }
            
            .submit-btn:disabled {
              opacity: 0.5;
              cursor: not-allowed;
            }
            
            .glass-filter,
            .glass-overlay,
            .glass-specular {
              position: absolute;
              inset: 0;
              border-radius: 50px;
            }
            
            .glass-filter {
              z-index: 1;
              backdrop-filter: blur(8px);
              filter: url(#glass-distortion) saturate(120%) brightness(1.15);
            }
            
            .glass-overlay {
              z-index: 2;
              background: rgba(255, 255, 255, 0.35);
              border: 1px solid rgba(255, 255, 255, 0.4);
            }
            
            .glass-specular {
              z-index: 3;
              box-shadow: inset 1px 1px 1px rgba(255, 255, 255, 0.75);
            }
            
            .glass-content {
              position: relative;
              z-index: 4;
              color: #ffffff;
              font-weight: 500;
            }
            
            .error {
              margin-top: 16px;
              padding: 12px 18px;
              background: rgba(255, 59, 48, 0.2);
              backdrop-filter: blur(12px);
              color: #ffffff;
              border: 1px solid rgba(255, 59, 48, 0.5);
              border-radius: 50px;
              font-size: 13px;
              display: none;
              box-shadow: 0 4px 16px rgba(255, 59, 48, 0.2);
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
              font-family: 'Manus', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              font-size: 32px;
              font-weight: 300;
              color: #ffffff;
              margin-bottom: 10px;
              letter-spacing: -0.5px;
              text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            }
            
            .success-subtitle {
              font-size: 15px;
              color: rgba(255, 255, 255, 0.9);
              margin-bottom: 32px;
              line-height: 1.5;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            }
            
            .config-container {
              background: rgba(255, 255, 255, 0.25);
              border: 1px solid rgba(255, 255, 255, 0.4);
              border-radius: 20px;
              padding: 20px 24px;
              margin-bottom: 24px;
              position: relative;
              text-align: left;
              backdrop-filter: blur(12px);
              box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
              max-width: 550px;
              margin-left: auto;
              margin-right: auto;
            }
            
            .config-container pre {
              overflow-x: auto;
              font-size: 12px;
              line-height: 1.5;
              color: rgba(255, 255, 255, 0.95);
              font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
              padding-right: 80px;
            }
            
            .copy-btn {
              position: absolute;
              top: 16px;
              right: 16px;
              padding: 6px 14px;
              background: rgba(255, 255, 255, 0.3);
              backdrop-filter: blur(12px);
              color: #ffffff;
              border: 1px solid rgba(255, 255, 255, 0.4);
              border-radius: 50px;
              cursor: pointer;
              font-size: 12px;
              font-weight: 500;
              transition: all 0.2s;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            }
            
            .copy-btn:hover {
              background: rgba(255, 255, 255, 0.4);
              transform: scale(1.05);
            }
            
            .copy-btn.copied {
              background: rgba(52, 199, 89, 0.8);
              border-color: rgba(52, 199, 89, 1);
              color: #ffffff;
            }
            
            .action-btn {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 12px 32px;
              background: transparent;
              color: #ffffff;
              text-decoration: none;
              font-size: 14px;
              font-weight: 500;
              border-radius: 50px;
              transition: transform 0.2s ease;
              letter-spacing: -0.01em;
              border: none;
              position: relative;
              overflow: hidden;
              cursor: pointer;
              outline: none;
            }
            
            .action-btn:hover {
              transform: scale(1.05);
            }
            
            .action-btn:active {
              transform: scale(0.95);
            }
            
            .action-btn .glass-filter,
            .action-btn .glass-overlay,
            .action-btn .glass-specular {
              position: absolute;
              inset: 0;
              border-radius: 50px;
            }
            
            .action-btn .glass-filter {
              z-index: 1;
              backdrop-filter: blur(8px);
              filter: url(#glass-distortion) saturate(120%) brightness(1.15);
            }
            
            .action-btn .glass-overlay {
              z-index: 2;
              background: rgba(255, 255, 255, 0.35);
              border: 1px solid rgba(255, 255, 255, 0.4);
            }
            
            .action-btn .glass-specular {
              z-index: 3;
              box-shadow: inset 1px 1px 1px rgba(255, 255, 255, 0.75);
            }
            
            .action-btn .glass-content {
              position: relative;
              z-index: 4;
              color: #ffffff;
              font-weight: 500;
            }
            
            .note {
              margin-top: 20px;
              font-size: 13px;
              color: rgba(255, 255, 255, 0.75);
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
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
              z-index: 1;
            }
            
            .footer-row {
              display: flex;
              align-items: center;
              gap: 8px;
              flex-wrap: wrap;
              justify-content: center;
            }
            
            .footer-text {
              color: rgba(255, 255, 255, 0.9);
              font-size: 14px;
              font-weight: 400;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
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
              height: 16px;
              width: auto;
              transition: opacity 0.2s;
              vertical-align: middle;
              filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
            }
            
            .footer-logo.dark-logo {
              display: none !important;
            }
            
            .footer-logo.light-logo {
              display: inline-block !important;
            }
            
            .footer-link {
              color: rgba(255, 255, 255, 0.9);
              font-weight: 500;
              letter-spacing: -0.01em;
              text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            }
            
            .footer-link:hover {
              color: rgba(255, 255, 255, 1);
            }
            
            /* Responsive Design */
            @media (max-width: 1024px) {
              body {
                padding: 35px 25px;
              }
              
              h1 {
                font-size: 34px;
              }
              
              .subtitle {
                font-size: 15px;
              }
              
              .input-wrapper {
                max-width: 500px;
              }
            }
            
            @media (max-width: 768px) {
              body {
                padding: 30px 20px;
              }
              
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
              
              input {
                padding: 13px 18px;
                font-size: 15px;
              }
              
              .submit-btn {
                padding: 11px 26px;
                font-size: 14px;
              }
              
              .action-btn {
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
              
              .footer-logo {
                height: 14px;
              }
              
              .success-title {
                font-size: 26px;
              }
              
              .config-container {
                max-width: 90%;
                padding: 18px 20px;
              }
              
              .config-container pre {
                font-size: 11px;
              }
            }
            
            @media (max-width: 480px) {
              .container {
                padding: 24px;
              }
              
              h1 {
                font-size: 32px;
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
              
              input {
                padding: 12px 16px;
                font-size: 14px;
              }
              
              .submit-btn {
                padding: 10px 24px;
                font-size: 13px;
              }
              
              .action-btn {
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
              
              .footer-logo {
                height: 12px;
              }
              
              .success-title {
                font-size: 22px;
                margin-bottom: 10px;
              }
              
              .success-subtitle {
                font-size: 14px;
                margin-bottom: 24px;
              }
              
              .config-container {
                max-width: 95%;
                padding: 16px 18px;
              }
              
              .config-container pre {
                font-size: 10px;
                padding-right: 70px;
              }
              
              .copy-btn {
                top: 14px;
                right: 14px;
                padding: 5px 12px;
                font-size: 11px;
              }
              
              .note {
                font-size: 12px;
              }
            }
            
            @media (max-width: 360px) {
              h1, .success-title {
                font-size: 20px;
              }
              
              .subtitle, .success-subtitle {
                font-size: 13px;
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
              
              .footer-logo {
                height: 10px;
              }
            }
          </style>
        </head>
        <body>
          <!-- SVG Filter for Glass Distortion -->
          <svg style="display: none">
            <filter id="glass-distortion">
              <feTurbulence type="turbulence" baseFrequency="0.008" numOctaves="2" result="noise" />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale="77" />
            </filter>
          </svg>
          
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
                  <div class="glass-filter"></div>
                  <div class="glass-overlay"></div>
                  <div class="glass-specular"></div>
                  <div class="glass-content">
                    <span>Continue</span>
                  </div>
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
                <div class="glass-filter"></div>
                <div class="glass-overlay"></div>
                <div class="glass-specular"></div>
                <div class="glass-content">
                  <span>Open Manus Settings &rarr;</span>
                </div>
              </a>
              
              <p class="note">Configuration also sent to your iMessage</p>
            </div>
          </div>
          
          <!-- Footer -->
          <div class="footer">
            <div class="footer-row">
              <span class="footer-text">built by</span>
              <a href="https://photon.codes" target="_blank" rel="noopener noreferrer">
                <img src="/photon-logo-dark.png" alt="Photon" class="footer-logo dark-logo">
                <img src="/photon-logo-light.png" alt="Photon" class="footer-logo light-logo">
              </a>
            </div>
            <div class="footer-text">
              join community at <a href="https://dub.sh/photon-discord" target="_blank" rel="noopener noreferrer" class="footer-link">Discord</a>
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
            
            document.getElementById('tokenForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const submitBtn = document.getElementById('submitBtn');
              const submitBtnText = submitBtn.querySelector('.glass-content span');
              const errorDiv = document.getElementById('error');
              const manusApiKey = document.getElementById('manusApiKey').value.trim();
              
              // Validate API key format
              if (!isValidManusApiKey(manusApiKey)) {
                errorDiv.textContent = 'Invalid API key format. Please check your key and try again.';
                errorDiv.classList.add('show');
                return;
              }
              
              submitBtn.disabled = true;
              submitBtnText.textContent = 'Connecting...';
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
                  submitBtnText.textContent = 'Continue';
                }
              } catch (error) {
                errorDiv.textContent = 'Connection failed. Please check your API key and try again.';
                errorDiv.classList.add('show');
                submitBtn.disabled = false;
                submitBtnText.textContent = 'Continue';
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
            
            // Liquid Glass Button Mouse Effect
            const glassButtons = document.querySelectorAll('.submit-btn, .action-btn');
            
            glassButtons.forEach(function(glassButton) {
              glassButton.addEventListener('mousemove', function(e) {
                const rect = this.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                
                const specular = this.querySelector('.glass-specular');
                if (specular) {
                  specular.style.background = \`radial-gradient(
                    circle at \${x}px \${y}px,
                    rgba(255,255,255,0.15) 0%,
                    rgba(255,255,255,0.05) 30%,
                    rgba(255,255,255,0) 60%
                  )\`;
                }
              });
              
              glassButton.addEventListener('mouseleave', function() {
                const specular = this.querySelector('.glass-specular');
                if (specular) {
                  specular.style.background = 'none';
                }
              });
            });
            
            // Background Parallax Effect (opposite to mouse direction)
            document.addEventListener('mousemove', function(e) {
              const moveX = (e.clientX - window.innerWidth / 2) / window.innerWidth;
              const moveY = (e.clientY - window.innerHeight / 2) / window.innerHeight;
              
              // Move opposite to mouse direction (negative values)
              const offsetX = -moveX * 10;
              const offsetY = -moveY * 10;
              
              document.body.style.backgroundPosition = \`calc(50% + \${offsetX}px) calc(50% + \${offsetY}px)\`;
            });
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
