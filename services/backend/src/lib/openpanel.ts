import { OpenPanel } from '@openpanel/sdk';

/**
 * Singleton OpenPanel client instance for backend tracking
 */
let openpanelClient: OpenPanel | null = null;
let configLogged = false;

/**
 * Get or create the OpenPanel client instance for backend tracking
 * Returns null if credentials are not configured
 */
export function getOpenPanelClient(): OpenPanel | null {
  const clientId = process.env.OPENPANEL_CLIENT_ID;
  const clientSecret = process.env.OPENPANEL_CLIENT_SECRET;
  const apiUrl = process.env.OPENPANEL_API_URL;

  // Log configuration status only once
  if (!configLogged) {
    console.log('📊 OpenPanel Backend Configuration:', {
      clientId: clientId ? `${clientId.substring(0, 8)}...` : 'NOT SET',
      clientSecret: clientSecret ? '***SET***' : 'NOT SET',
      apiUrl: apiUrl || 'NOT SET',
      configured: !!(clientId && clientSecret && apiUrl),
    });
    configLogged = true;
  }

  // Return null if credentials are not configured
  if (!clientId || clientId.trim() === '' || !clientSecret || clientSecret.trim() === '' || !apiUrl || apiUrl.trim() === '') {
    if (!openpanelClient && !configLogged) {
      console.warn('⚠️  OpenPanel backend tracking disabled - credentials not configured');
    }
    return null;
  }

  // Return existing instance if already created
  if (openpanelClient) {
    return openpanelClient;
  }

  // Create new instance
  console.log('🆕 Creating new OpenPanel client instance');
  openpanelClient = new OpenPanel({
    clientId,
    clientSecret,
    apiUrl,
  });

  return openpanelClient;
}

/**
 * Generate OpenPanel frontend script tag
 * Returns empty string if OPENPANEL_CLIENT_ID or OPENPANEL_API_URL is not configured
 */
export function getOpenPanelScriptTag(): string {
  const clientId = process.env.OPENPANEL_CLIENT_ID;
  const apiUrl = process.env.OPENPANEL_API_URL;

  if (!clientId || clientId.trim() === '' || !apiUrl || apiUrl.trim() === '') {
    return '';
  }

  return `
    <!-- OpenPanel Analytics -->
    <script>
      window.op=window.op||function(){var n=[];return new Proxy(function(){arguments.length&&n.push([].slice.call(arguments))},{get:function(t,r){return"q"===r?n:function(){n.push([r].concat([].slice.call(arguments)))}} ,has:function(t,r){return"q"===r}}) }();
      window.op('init', {
        clientId: '${clientId}',
        apiUrl: '${apiUrl}',
        trackScreenViews: true,
        trackOutgoingLinks: true,
        trackAttributes: true,
      });
      console.log('📊 OpenPanel initialized:', { clientId: '${clientId.substring(0, 8)}...', apiUrl: '${apiUrl}' });
    </script>
    <script src="https://openpanel.dev/op1.js" defer async></script>
    <!-- End OpenPanel Analytics -->
  `;
}

/**
 * Track a custom event (helper function for route handlers)
 */
export async function trackEvent(
  eventName: string,
  properties?: Record<string, any>
): Promise<void> {
  const client = getOpenPanelClient();
  if (!client) {
    console.log(`📊 [SKIPPED] Event not tracked (OpenPanel not configured): ${eventName}`, properties);
    return; // Silently skip if not configured
  }

  try {
    console.log(`📊 [TRACKING] Event: ${eventName}`, properties);
    await client.track(eventName, properties);
    console.log(`✅ [SUCCESS] Event tracked: ${eventName}`);
  } catch (error) {
    // Log error but don't throw - analytics failures shouldn't break the app
    console.error(`❌ [ERROR] OpenPanel tracking failed for event: ${eventName}`, error);
  }
}

/**
 * Identify a user (helper function for route handlers)
 */
export async function identifyUser(
  profileId: string,
  properties?: Record<string, any>
): Promise<void> {
  const client = getOpenPanelClient();
  if (!client) {
    console.log(`📊 [SKIPPED] User identify not tracked (OpenPanel not configured): ${profileId}`);
    return; // Silently skip if not configured
  }

  try {
    console.log(`📊 [IDENTIFYING] User: ${profileId}`, properties);
    await client.identify({
      profileId,
      ...properties,
    });
    console.log(`✅ [SUCCESS] User identified: ${profileId}`);
  } catch (error) {
    console.error(`❌ [ERROR] OpenPanel identify failed for user: ${profileId}`, error);
  }
}
