import * as crypto from 'crypto';

/**
 * Generate a secure Photon API key
 * Format: ph_live_AbC123XyZ789PqR45678 (24 chars base58)
 * Base58 alphabet excludes ambiguous characters (0, O, I, l)
 */
export function generatePhotonApiKey(env: 'live' | 'test' = 'live'): string {
  // Base58 alphabet (no 0, O, I, l to avoid confusion)
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const length = 24;
  
  // Generate cryptographically secure random key
  const bytes = crypto.randomBytes(length);
  let result = '';
  
  for (let i = 0; i < length; i++) {
    result += alphabet[bytes[i] % alphabet.length];
  }
  
  return `ph_${env}_${result}`;
}

/**
 * Validate Photon API key format
 */
export function isValidPhotonApiKey(key: string): boolean {
  return /^ph_(live|test)_[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{24}$/.test(key);
}

/**
 * Generate a unique connection ID
 */
export function generateConnectionId(): string {
  const random = crypto.randomBytes(16).toString('hex');
  return `conn_${random}`;
}

/**
 * Check if a message is from Manus (has [Manus] prefix)
 */
export function isManusMessage(text: string): boolean {
  return text.startsWith('[Manus]');
}

/**
 * Format a message with [Manus] prefix
 * Note: Prefix removed - now returns text as-is for cleaner UX
 */
export function formatManusMessage(text: string): string {
  return text; // No prefix - rely on database tracking instead
}

/**
 * Parse phone number to standard format
 */
export function normalizePhoneNumber(phone: string): string {
  // Remove all non-digit characters except +
  return phone.replace(/[^\d+]/g, '');
}

/**
 * Check if connection has expired
 */
export function isConnectionExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return new Date() > expiresAt;
}

/**
 * Calculate expiry time (5 minutes from now)
 */
export function getConnectionExpiry(): Date {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + 5);
  return expiry;
}

/**
 * Sanitize handle (phone number or email) for use in queue names
 * - Phone numbers: +918527438574 -> phone-918527438574 (preserves country code)
 * - iCloud emails: user@icloud.com -> email-user-at-icloud-com
 * - Adds prefix to prevent collisions and preserve full identity
 * - Removes special characters that can't be used in Redis keys
 */
export function sanitizeHandle(handle: string): string {
  // Check if it's an email (contains @)
  if (handle.includes('@')) {
    // Replace @ with -at- and . with - (dots), add email- prefix
    return 'email-' + handle
      .toLowerCase()
      .replace(/@/g, '-at-')
      .replace(/\./g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }
  
  // It's a phone number - keep all digits including country code, add phone- prefix
  // This preserves the full number: +918527438574 -> phone-918527438574
  const digits = handle.replace(/[^0-9]/g, '');
  return 'phone-' + digits;
}

/**
 * Check if a handle is an email address
 */
export function isEmail(handle: string): boolean {
  return handle.includes('@');
}

/**
 * Check if a handle is a phone number
 */
export function isPhoneNumber(handle: string): boolean {
  return /^\+?\d+$/.test(handle.replace(/[\s\-()]/g, ''));
}

/**
 * Validate phone number has country code
 * Returns true if phone number starts with + and has at least 10 digits
 */
export function hasCountryCode(phoneNumber: string): boolean {
  if (!phoneNumber.startsWith('+')) {
    return false;
  }
  const digits = phoneNumber.replace(/[^0-9]/g, '');
  return digits.length >= 10; // Minimum international format
}

/**
 * Normalize phone number to international format
 * Ensures it starts with + and contains only digits
 */
export function normalizePhoneToInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  return digits.startsWith('+') ? phone : `+${digits}`;
}

/**
 * Split message by paragraph breaks (\n\n) into separate chunks
 * Filters out empty chunks and trims whitespace
 * Useful for sending long messages as multiple separate iMessages for better readability
 */
export function splitMessageByParagraphs(message: string): string[] {
  return message
    .split('\n\n')
    .map(chunk => chunk.trim())
    .filter(chunk => chunk.length > 0);
}

/**
 * Strip markdown formatting from text since iMessage API doesn't support programmatic formatting
 * Removes: **bold**, *italic*, _underline_, ~strikethrough~
 * Keeps the text content without the markdown syntax
 */
export function stripMarkdownFormatting(text: string): string {
  return text
    // Remove bold (**text** or __text__)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // Remove italic (*text* or _text_) - but be careful with underscores in words
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
    // Remove strikethrough (~text~ or ~~text~~)
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/~(.+?)~/g, '$1');
}
