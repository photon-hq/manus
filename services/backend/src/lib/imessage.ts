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
 * Supports threaded replies via selectedMessageGuid
 * 
 * @param handle - Phone number (+1234567890) or iCloud email (user@icloud.com)
 * @param message - Message text to send
 * @param options - Optional settings for the message
 */
export async function sendIMessage(
  handle: string, 
  message: string,
  options?: { 
    disableRichLink?: boolean;
    replyToMessageGuid?: string; // Thread reply to this message GUID
  }
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
    ...(options?.replyToMessageGuid && { selectedMessageGuid: options.replyToMessageGuid }),
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
 * Send a tapback reaction to a message (e.g. love, like, laugh).
 * Use reaction "-love" etc. to remove a tapback.
 *
 * @param chatGuid - Chat identifier (e.g. any;-;+1234567890)
 * @param messageGuid - Target message GUID
 * @param reaction - love | like | dislike | laugh | emphasize | question, or -love etc. to remove
 */
export async function sendReaction(
  chatGuid: string,
  messageGuid: string,
  reaction: string
): Promise<void> {
  const client = await getIMessageSDK();
  await client.messages.sendReaction({
    chatGuid,
    messageGuid,
    reaction,
  });
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
 * Send an iMessage with attachments
 * Downloads files from URLs and sends them as iMessage attachments
 * 
 * @param handle - Phone number (+1234567890) or iCloud email (user@icloud.com)
 * @param message - Message text to send
 * @param attachments - Array of attachment URLs and filenames
 * @returns Array of message GUIDs (one for text, one per attachment)
 */
export async function sendIMessageWithAttachments(
  handle: string,
  message: string,
  attachments?: Array<{ url: string; filename: string; size_bytes?: number }>,
  options?: { replyToMessageGuid?: string }
): Promise<string[]> {
  const client = await getIMessageSDK();
  const chatGuid = `any;-;${handle}`;
  const messageGuids: string[] = [];
  
  const fs = await import('fs/promises');
  const path = await import('path');
  const os = await import('os');
  
  // File size limit for iMessage (100MB)
  const MAX_FILE_SIZE = 100 * 1024 * 1024;
  
  try {
    // Send text message first if provided
    if (message) {
      const result = await client.messages.sendMessage({
        chatGuid,
        message,
        ...(options?.replyToMessageGuid && { selectedMessageGuid: options.replyToMessageGuid }),
      });
      messageGuids.push(result.guid);
    }
    
    // Process attachments if provided
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        try {
          // Check file size before downloading
          if (attachment.size_bytes && attachment.size_bytes > MAX_FILE_SIZE) {
            console.warn(`⚠️ Attachment ${attachment.filename} exceeds size limit (${(attachment.size_bytes / 1024 / 1024).toFixed(2)} MB), skipping`);
            continue;
          }
          
          console.log(`📥 Downloading attachment: ${attachment.filename} from ${attachment.url}`);
          
          // Download file from URL
          const response = await fetch(attachment.url);
          if (!response.ok) {
            throw new Error(`Failed to download: ${response.statusText}`);
          }
          
          const buffer = Buffer.from(await response.arrayBuffer());
          
          // Double-check size after download
          if (buffer.length > MAX_FILE_SIZE) {
            console.warn(`⚠️ Downloaded file ${attachment.filename} exceeds size limit, skipping`);
            continue;
          }
          
          // Create temporary file
          const tempDir = os.tmpdir();
          const tempFilePath = path.join(tempDir, `manus-${Date.now()}-${attachment.filename}`);
          
          await fs.writeFile(tempFilePath, buffer);
          console.log(`💾 Saved to temp file: ${tempFilePath}`);
          
          try {
            // Send attachment via iMessage SDK, threaded if replyToMessageGuid provided
            console.log(`📤 Sending attachment via iMessage: ${attachment.filename}`);
            const result = await client.attachments.sendAttachment({
              chatGuid,
              filePath: tempFilePath,
              fileName: attachment.filename,
              ...(options?.replyToMessageGuid && { selectedMessageGuid: options.replyToMessageGuid }),
            });
            
            messageGuids.push(result.guid);
            console.log(`✅ Sent attachment: ${attachment.filename}${options?.replyToMessageGuid ? ' (threaded)' : ''}`);
          } finally {
            // Clean up temp file
            try {
              await fs.unlink(tempFilePath);
              console.log(`🧹 Cleaned up temp file: ${tempFilePath}`);
            } catch (cleanupError) {
              console.warn(`Failed to clean up temp file ${tempFilePath}:`, cleanupError);
            }
          }
        } catch (error) {
          console.error(`❌ Failed to send attachment ${attachment.filename}:`, error);
          // Continue with other attachments
        }
      }
    }
    
    return messageGuids;
  } catch (error) {
    console.error('Failed to send message with attachments:', error);
    throw error;
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
