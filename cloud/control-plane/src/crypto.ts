import {
  createCipheriv,
  createDecipheriv,
  createHash,
  timingSafeEqual,
  randomBytes,
} from 'node:crypto';

/**
 * Secret-at-rest helpers. Gateway secrets and Metaso redeem codes are stored
 * as AES-256-GCM ciphertext: base64(iv | ciphertext | tag) with a 12-byte IV
 * and a 16-byte auth tag. The master key is 32 raw bytes (CP_MASTER_KEY,
 * base64-encoded in the environment).
 */

const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

export function encryptSecret(masterKey: Buffer, plaintext: string): string {
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

export function decryptSecret(masterKey: Buffer, encoded: string): string {
  const blob = Buffer.from(encoded, 'base64');
  if (blob.length < GCM_IV_LENGTH + GCM_TAG_LENGTH + 1) {
    throw new Error('ciphertext too short');
  }
  const iv = blob.subarray(0, GCM_IV_LENGTH);
  const tag = blob.subarray(blob.length - GCM_TAG_LENGTH);
  const ciphertext = blob.subarray(GCM_IV_LENGTH, blob.length - GCM_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Constant-time string comparison for secrets and codes. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Keep the comparison work proportional to the longer input.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Mask a phone number for logs: keep the country-code prefix and the last
 * four digits, replace the middle with `****`.
 * `+8613800138000` -> `+861****8000`.
 */
export function maskPhone(phone: string): string {
  if (phone.length <= 8) {
    return '****';
  }
  return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}
