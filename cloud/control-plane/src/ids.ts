import { randomBytes, randomInt } from 'node:crypto';

/**
 * Random id/code generators. User and tenant ids are `u_`/`t_` followed by 20
 * lowercase RFC 4648 base32 characters (no padding) — 100 bits of entropy from
 * 13 random bytes. Invite codes use an alphabet with no ambiguous characters
 * (0, O, 1, I, L excluded).
 */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 13 random bytes -> 21 base32 chars; we keep the first 20. */
function base32Random(chars: number): string {
  const bytes = randomBytes(13);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  while (out.length < chars) {
    out += BASE32_ALPHABET[randomInt(32)];
  }
  return out;
}

export function newUserId(): string {
  return `u_${base32Random(20)}`;
}

export function newTenantId(): string {
  return `t_${base32Random(20)}`;
}

/** Uppercase alphabet without 0, O, 1, I, L. */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newInviteCode(): string {
  const length = 8 + randomInt(5); // 8..12 inclusive
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  }
  return out;
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newGatewaySecret(): string {
  return randomBytes(32).toString('base64url');
}
