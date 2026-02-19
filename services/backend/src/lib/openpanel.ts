import { OpenPanel } from '@openpanel/sdk';

/**
 * Singleton OpenPanel client instance for backend tracking
 */
let openpanelClient: OpenPanel | null = null;

/**
 * Get or create the OpenPanel client instance for backend tracking
 * Returns null if credentials are not configured
 */
export function getOpenPanelClient(): OpenPanel | null {
  const clientId = process.env.OPENPANEL_CLIENT_ID;
  const clientSecret = process.env.OPENPANEL_CLIENT_SECRET;
  const apiUrl = process.env.OPENPANEL_API_URL;

  // Return null if credentials are not configured
  if (!clientId || clientId.trim() === '' || !clientSecret || clientSecret.trim() === '' || !apiUrl || apiUrl.trim() === '') {
    return null;
  }

  // Return existing instance if already created
  if (openpanelClient) {
    return openpanelClient;
  }

  // Create new instance
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
    return; // Silently skip if not configured
  }

  try {
    await client.track(eventName, properties);
  } catch (error) {
    // Log error but don't throw - analytics failures shouldn't break the app
    console.error('OpenPanel tracking error:', error);
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
    return; // Silently skip if not configured
  }

  try {
    await client.identify({
      profileId,
      ...properties,
    });
  } catch (error) {
    console.error('OpenPanel identify error:', error);
  }
}
