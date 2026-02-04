import { SDK } from '@photon-ai/advanced-imessage-kit';

const IMESSAGE_SERVER_URL = process.env.IMESSAGE_SERVER_URL;
const IMESSAGE_API_KEY = process.env.IMESSAGE_API_KEY;

if (!IMESSAGE_SERVER_URL) {
  throw new Error('IMESSAGE_SERVER_URL environment variable is required');
}

if (!IMESSAGE_API_KEY) {
  throw new Error('IMESSAGE_API_KEY environment variable is required');
}

let sdk: ReturnType<typeof SDK> | null = null;
let isConnected = false;

/**
 * Get or create the iMessage SDK instance
 * Connects to Photon's existing iMessage infrastructure via advanced-imessage-kit
 */
export async function getIMessageSDK() {
  if (!sdk) {
    sdk = SDK({
      serverUrl: IMESSAGE_SERVER_URL!,
      apiKey: IMESSAGE_API_KEY!,
      logLevel: process.env.NODE_ENV === 'production' ? 'error' : 'info',
    });

    try {
      await sdk.connect();
      isConnected = true;
      console.log('✅ Connected to Photon iMessage server');
    } catch (error) {
      console.error('❌ Failed to connect to Photon iMessage server:', error);
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
 * Disconnect from Photon iMessage server
 */
export async function disconnectIMessage() {
  if (sdk) {
    await sdk.close();
    sdk = null;
    isConnected = false;
    console.log('Disconnected from Photon iMessage server');
  }
}

/**
 * Send an iMessage to a phone number or iCloud email
 * Automatically enables rich link previews for messages containing URLs
 * 
 * @param handle - Phone number (+1234567890) or iCloud email (user@icloud.com)
 * @param message - Message text to send
 * @param options - Optional settings for the message
 */
export async function sendIMessage(
  handle: string, 
  message: string,
  options?: { disableRichLink?: boolean }
): Promise<string> {
  const client = await getIMessageSDK();
  
  // Build chatGuid - use 'any' to auto-detect service type (SMS vs iMessage)
  // Format: any;-;+1234567890 (for phone) or any;-;user@icloud.com (for email)
  const chatGuid = `any;-;${handle}`;
  
  // Check if message contains a URL (http:// or https://)
  const containsUrl = /https?:\/\/[^\s]+/.test(message);
  
  // Enable rich link only if URL is present AND not explicitly disabled
  const enableRichLink = containsUrl && !options?.disableRichLink;
  
  const result = await client.messages.sendMessage({
    chatGuid,
    message,
    richLink: enableRichLink,
  });

  return result.guid;
}

/**
 * Fetch recent messages from a phone number or iCloud email
 * Returns last N messages, filtered to exclude Manus-sent messages
 * 
 * @param handle - Phone number (+1234567890) or iCloud email (user@icloud.com)
 * @param limit - Maximum number of messages to fetch
 */
export async function fetchIMessages(
  handle: string,
  limit: number = 100
): Promise<Array<{
  from: string;
  to: string;
  text: string;
  timestamp: string;
  guid: string;
  isFromMe: boolean;
  attachments?: Array<{
    guid: string;
    filename: string;
    mimeType: string;
    transferName: string;
  }>;
}>> {
  const client = await getIMessageSDK();
  
  // Build chatGuid - use 'any' to auto-detect service type
  const chatGuid = `any;-;${handle}`;
  
  try {
    // Get messages from the chat
    const messages = await client.messages.getMessages({
      chatGuid,
      limit,
      sort: 'DESC', // Newest first
    });

    // Transform to our format
    return messages.map((msg) => ({
      from: msg.isFromMe ? 'me' : handle,
      to: msg.isFromMe ? handle : 'me',
      text: msg.text || '',
      timestamp: new Date(msg.dateCreated).toISOString(),
      guid: msg.guid,
      isFromMe: msg.isFromMe,
      attachments: msg.attachments?.map((att: any) => ({
        guid: att.guid,
        filename: att.transferName || 'file',
        mimeType: att.mimeType || 'application/octet-stream',
        transferName: att.transferName,
      })),
    }));
  } catch (error) {
    console.error('Failed to fetch messages:', error);
    // Return empty array if chat doesn't exist yet
    return [];
  }
}

/**
 * Get chat GUID for a phone number or iCloud email
 * 
 * @param handle - Phone number (+1234567890) or iCloud email (user@icloud.com)
 */
export function getChatGuid(handle: string): string {
  return `any;-;${handle}`;
}

/**
 * Send typing indicator and wait
 * 
 * @param handle - Phone number (+1234567890) or iCloud email (user@icloud.com)
 * @param durationMs - Duration in milliseconds to show typing indicator
 */
export async function sendTypingIndicator(handle: string, durationMs: number): Promise<void> {
  const client = await getIMessageSDK();
  const chatGuid = `any;-;${handle}`;
  
  try {
    await client.chats.startTyping(chatGuid);
    await new Promise(resolve => setTimeout(resolve, durationMs));
    await client.chats.stopTyping(chatGuid);
  } catch (error) {
    console.error('Failed to send typing indicator:', error);
    // Continue anyway - not critical
  }
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
