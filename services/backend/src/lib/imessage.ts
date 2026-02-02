import { SDK } from '@photon-ai/advanced-imessage-kit';

const IMESSAGE_SERVER_URL = process.env.IMESSAGE_SERVER_URL || 'http://localhost:1234';
const IMESSAGE_API_KEY = process.env.IMESSAGE_API_KEY;

let sdk: ReturnType<typeof SDK> | null = null;
let isConnected = false;

/**
 * Get or create the iMessage SDK instance
 */
export async function getIMessageSDK() {
  if (!sdk) {
    sdk = SDK({
      serverUrl: IMESSAGE_SERVER_URL,
      apiKey: IMESSAGE_API_KEY,
      logLevel: process.env.NODE_ENV === 'production' ? 'error' : 'info',
    });

    try {
      await sdk.connect();
      isConnected = true;
      console.log('✅ Connected to iMessage server');
    } catch (error) {
      console.error('❌ Failed to connect to iMessage server:', error);
      throw error;
    }
  }

  return sdk;
}

/**
 * Check if SDK is connected
 */
export function isIMessageConnected(): boolean {
  return isConnected;
}

/**
 * Disconnect from iMessage server
 */
export async function disconnectIMessage() {
  if (sdk) {
    await sdk.close();
    sdk = null;
    isConnected = false;
    console.log('Disconnected from iMessage server');
  }
}

/**
 * Send an iMessage to a phone number
 */
export async function sendIMessage(phoneNumber: string, message: string): Promise<string> {
  const client = await getIMessageSDK();
  
  // Build chatGuid - use 'any' to auto-detect service type
  const chatGuid = `any;-;${phoneNumber}`;
  
  const result = await client.messages.sendMessage({
    chatGuid,
    message,
  });

  return result.guid;
}

/**
 * Fetch recent messages from a phone number
 * Returns last N messages, filtered to exclude Manus-sent messages
 */
export async function fetchIMessages(
  phoneNumber: string,
  limit: number = 100
): Promise<Array<{
  from: string;
  to: string;
  text: string;
  timestamp: string;
  guid: string;
  isFromMe: boolean;
}>> {
  const client = await getIMessageSDK();
  
  // Build chatGuid
  const chatGuid = `any;-;${phoneNumber}`;
  
  try {
    // Get messages from the chat
    const messages = await client.messages.getMessages({
      chatGuid,
      limit,
      sort: 'DESC', // Newest first
    });

    // Transform to our format
    return messages.map((msg) => ({
      from: msg.isFromMe ? process.env.PHOTON_NUMBER || 'me' : phoneNumber,
      to: msg.isFromMe ? phoneNumber : process.env.PHOTON_NUMBER || 'me',
      text: msg.text || '',
      timestamp: new Date(msg.dateCreated).toISOString(),
      guid: msg.guid,
      isFromMe: msg.isFromMe,
    }));
  } catch (error) {
    console.error('Failed to fetch messages:', error);
    // Return empty array if chat doesn't exist yet
    return [];
  }
}

/**
 * Get chat GUID for a phone number
 */
export function getChatGuid(phoneNumber: string): string {
  return `any;-;${phoneNumber}`;
}

/**
 * Handle graceful shutdown
 */
process.on('SIGTERM', async () => {
  await disconnectIMessage();
});

process.on('SIGINT', async () => {
  await disconnectIMessage();
});
