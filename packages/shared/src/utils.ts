import * as crypto from 'crypto';

/**
 * Generate a secure Photon API key
 */
export function generatePhotonApiKey(): string {
  const random = crypto.randomBytes(32).toString('hex');
  return `photon_sk_${random}`;
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
