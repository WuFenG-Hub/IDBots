import { randomInt } from 'node:crypto';
import { sha256Hex } from './crypto.js';

/**
 * SMS providers. Verification logic (rate limits, attempts, expiry) lives in
 * the auth service; a provider only delivers (or, for the fake provider,
 * records) a code. Codes are 6 digits and always stored/transported hashed.
 */

export type SmsPurpose = 'login' | 'reverify';

export interface SmsSendRecord {
  phone: string;
  purpose: SmsPurpose;
  code: string;
  at: number;
}

export interface SmsProvider {
  readonly mode: string;
  send(phone: string, purpose: SmsPurpose, code: string): Promise<void>;
}

/** 6-digit numeric code, zero-padded. */
export function generateSmsCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashSmsCode(phone: string, purpose: SmsPurpose, code: string): string {
  return sha256Hex(`${phone}:${purpose}:${code}`);
}

/**
 * Staging-only provider: accepts only the configured test numbers and always
 * "sends" the fixed code 246810 so tests and demos can log in. Sends are
 * recorded in memory for assertions; nothing leaves the process.
 */
export class FakeSmsProvider implements SmsProvider {
  readonly mode = 'fake';
  readonly fixedCode = '246810';
  readonly sends: SmsSendRecord[] = [];
  readonly #allowed: Set<string>;

  constructor(allowedNumbers: string[]) {
    this.#allowed = new Set(allowedNumbers);
  }

  async send(phone: string, purpose: SmsPurpose, code: string): Promise<void> {
    if (!this.#allowed.has(phone)) {
      throw new Error(`fake SMS rejected: number not in CP_FAKE_SMS_NUMBERS (${phone})`);
    }
    this.sends.push({ phone, purpose, code, at: Date.now() });
  }
}

/**
 * Placeholder for the Alibaba Cloud SMS integration (hand-signed RPC or the
 * official SDK — decided in the provisioning phase). Selecting it today is a
 * configuration error: it throws instead of silently dropping messages.
 */
export class AliyunSmsProvider implements SmsProvider {
  readonly mode = 'aliyun';

  constructor() {
    throw new Error('AliyunSmsProvider is not configured yet: aliyun SMS is not implemented');
  }

  async send(): Promise<void> {
    throw new Error('AliyunSmsProvider is not configured yet: aliyun SMS is not implemented');
  }
}
