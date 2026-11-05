import * as crypto from 'crypto';

/**
 * Generates an RFC 9562 compliant UUIDv7 identifier.
 * Uses 48-bit UNIX millisecond timestamp + sub-millisecond randomness + variant RFC 4122.
 */
export function generateUuidV7(): string {
  const value = crypto.randomBytes(16);
  const now = Date.now();

  // 48 bits timestamp (ms since epoch)
  value.writeUIntBE(Math.floor(now / 0x100000000), 0, 2);
  value.writeUIntBE(now >>> 0, 2, 4);

  // version 7 (0111) in byte 6
  value[6] = (value[6] & 0x0f) | 0x70;
  // variant (10) in byte 8
  value[8] = (value[8] & 0x3f) | 0x80;

  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

