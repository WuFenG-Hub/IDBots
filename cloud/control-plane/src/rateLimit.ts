import type Database from 'better-sqlite3';

/**
 * C3 rate-limit rules, implemented as small query helpers over the
 * `sms_codes` table. Every function takes `now` (ms since epoch) explicitly
 * so tests stay deterministic. All multiplicities are inclusive at the limit
 * (the 10th send of the day succeeds, the 11th is refused) unless noted.
 */

export const SMS_RESEND_WINDOW_MS = 60_000; // 1 send per 60 s per phone
export const SMS_PER_DAY_PER_PHONE = 10;
export const SMS_PER_DAY_PER_IP = 30;
export const MAX_ATTEMPTS_PER_CODE = 5;
export const FAILED_VERIFY_LOCK_THRESHOLD = 20;
export const PHONE_LOCK_MS = 86_400_000; // 24 h

export const DAY_MS = 86_400_000;

/** Start of the current UTC day, used for the per-day counters. */
export function utcDayStart(now: number): number {
  return now - (now % DAY_MS);
}

export type SmsSendRefusal =
  | 'PHONE_LOCKED'
  | 'SMS_TOO_FREQUENT' // 1 per 60 s per phone
  | 'SMS_DAILY_LIMIT_PHONE' // 10 per day per phone
  | 'SMS_DAILY_LIMIT_IP'; // 30 per day per IP

export interface SmsSendCheck {
  allowed: boolean;
  reason: SmsSendRefusal | null;
  /** Seconds until the refusal clears, when computable. */
  retryAfterSec: number | null;
  phoneLock: PhoneLockStatus;
}

export interface PhoneLockStatus {
  locked: boolean;
  failedCount: number;
  /** ms timestamp when the current lock lifts; null when not locked. */
  lockedUntil: number | null;
}

function countSmsSince(db: Database.Database, phone: string, since: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM sms_codes WHERE phone_e164 = ? AND created_at > ?')
    .get(phone, since) as { n: number };
  return row.n;
}

function countSmsOnDay(db: Database.Database, phone: string, dayStart: number, now: number): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM sms_codes WHERE phone_e164 = ? AND created_at >= ? AND created_at <= ?',
    )
    .get(phone, dayStart, now) as { n: number };
  return row.n;
}

function countSmsOnDayByIp(db: Database.Database, ip: string, dayStart: number, now: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM sms_codes WHERE ip = ? AND created_at >= ? AND created_at <= ?')
    .get(ip, dayStart, now) as { n: number };
  return row.n;
}

/**
 * 20 failed verifies per phone per day lock the phone for 24 h. A failed
 * verify is an `sms_codes` row with at least one spent attempt that was never
 * consumed. The lock lifts 24 h after the most recent failed verify.
 */
export function checkPhoneLock(db: Database.Database, phone: string, now: number): PhoneLockStatus {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(attempts), 0) AS failed_count, MAX(created_at) AS last_fail_at
       FROM sms_codes
       WHERE phone_e164 = ? AND consumed_at IS NULL AND attempts > 0 AND created_at >= ?`,
    )
    .get(phone, now - PHONE_LOCK_MS) as { failed_count: number; last_fail_at: number | null };
  const lockedUntil =
    row.failed_count >= FAILED_VERIFY_LOCK_THRESHOLD && row.last_fail_at !== null
      ? row.last_fail_at + PHONE_LOCK_MS
      : null;
  const locked = lockedUntil !== null && now < lockedUntil;
  return {
    locked,
    failedCount: row.failed_count,
    lockedUntil: locked ? lockedUntil : null,
  };
}

/** Full pre-send gate: phone lock first, then per-minute, then daily counters. */
export function checkSmsSend(
  db: Database.Database,
  input: { phone: string; ip: string; now: number },
): SmsSendCheck {
  const { phone, ip, now } = input;
  const phoneLock = checkPhoneLock(db, phone, now);

  if (phoneLock.locked) {
    return {
      allowed: false,
      reason: 'PHONE_LOCKED',
      retryAfterSec: phoneLock.lockedUntil === null ? null : Math.ceil((phoneLock.lockedUntil - now) / 1000),
      phoneLock,
    };
  }
  if (countSmsSince(db, phone, now - SMS_RESEND_WINDOW_MS) >= 1) {
    return { allowed: false, reason: 'SMS_TOO_FREQUENT', retryAfterSec: 60, phoneLock };
  }
  const dayStart = utcDayStart(now);
  if (countSmsOnDay(db, phone, dayStart, now) >= SMS_PER_DAY_PER_PHONE) {
    return { allowed: false, reason: 'SMS_DAILY_LIMIT_PHONE', retryAfterSec: null, phoneLock };
  }
  if (countSmsOnDayByIp(db, ip, dayStart, now) >= SMS_PER_DAY_PER_IP) {
    return { allowed: false, reason: 'SMS_DAILY_LIMIT_IP', retryAfterSec: null, phoneLock };
  }
  return { allowed: true, reason: null, retryAfterSec: null, phoneLock };
}

/** Verify-attempt gate for one code: fresh, unconsumed, under the attempt cap. */
export function canAttemptCode(db: Database.Database, smsCodeId: number, now: number): boolean {
  const row = db
    .prepare(
      'SELECT attempts, expires_at, consumed_at FROM sms_codes WHERE id = ?',
    )
    .get(smsCodeId) as { attempts: number; expires_at: number; consumed_at: number | null } | undefined;
  if (!row) {
    return false;
  }
  return row.consumed_at === null && row.expires_at > now && row.attempts < MAX_ATTEMPTS_PER_CODE;
}

/** Spend one verify attempt (wrong-code or attempt bookkeeping). */
export function incrementCodeAttempts(db: Database.Database, smsCodeId: number): void {
  db.prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?').run(smsCodeId);
}
