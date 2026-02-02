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
 * Send an iMessage to a phone number
 * Automatically enables rich link previews for messages containing URLs
 */
export async function sendIMessage(phoneNumber: string, message: string): Promise<string> {
  const client = await getIMessageSDK();
  
  // Build chatGuid - use 'any' to auto-detect service type
  const chatGuid = `any;-;${phoneNumber}`;
  
  // Check if message contains a URL (http:// or https://)
  const containsUrl = /https?:\/\/[^\s]+/.test(message);
  
  const result = await client.messages.sendMessage({
    chatGuid,
    message,
    richLink: containsUrl, // Enable rich link preview if URL is present
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
  attachments?: Array<{
    guid: string;
    filename: string;
    mimeType: string;
    transferName: string;
  }>;
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
      from: msg.isFromMe ? 'me' : phoneNumber,
      to: msg.isFromMe ? phoneNumber : 'me',
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
 * Download an attachment from iMessage
 * Returns the file buffer and metadata
 */
export async function downloadIMessageAttachment(attachmentGuid: string): Promise<{
  buffer: Buffer;
  filename: string;
  mimeType: string;
}> {
  const client = await getIMessageSDK();
  
  try {
    const attachment = await client.attachments.getAttachment({
      guid: attachmentGuid,
    });

    // Download the file
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      filename: attachment.transferName || 'file',
      mimeType: attachment.mimeType || 'application/octet-stream',
    };
  } catch (error) {
    console.error('Failed to download attachment:', error);
    throw error;
  }
}

/**
 * Get chat GUID for a phone number
 */
export function getChatGuid(phoneNumber: string): string {
  return `any;-;${phoneNumber}`;
}

/**
 * Send typing indicator and wait
 */
export async function sendTypingIndicator(phoneNumber: string, durationMs: number): Promise<void> {
  const client = await getIMessageSDK();
  const chatGuid = `any;-;${phoneNumber}`;
  
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
