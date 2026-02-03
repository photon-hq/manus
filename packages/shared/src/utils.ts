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
 */
export function formatManusMessage(text: string): string {
  return `[Manus] ${text}`;
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
