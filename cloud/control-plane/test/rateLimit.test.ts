import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_ATTEMPTS_PER_CODE,
  FAILED_VERIFY_LOCK_THRESHOLD,
  PHONE_LOCK_MS,
  canAttemptCode,
  checkPhoneLock,
  checkSmsSend,
  utcDayStart,
} from '../src/rateLimit.js';
import { freshDb, insertSmsSend } from './helpers.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const IP = '203.0.113.10';

describe('SMS send: 1 per 60 s per phone', () => {
  test('blocked inside the 60 s window', () => {
    const db = freshDb();
    insertSmsSend(db, { phone: '+8613900000001', ip: IP, now: NOW - 59_999 });
    const check = checkSmsSend(db, { phone: '+8613900000001', ip: IP, now: NOW });
    assert.equal(check.allowed, false);
    assert.equal(check.reason, 'SMS_TOO_FREQUENT');
  });

  test('allowed exactly at the 60th second', () => {
    const db = freshDb();
    insertSmsSend(db, { phone: '+8613900000002', ip: IP, now: NOW - MINUTE });
    const check = checkSmsSend(db, { phone: '+8613900000002', ip: IP, now: NOW });
    assert.equal(check.allowed, true);
    assert.equal(check.reason, null);
  });
});

describe('SMS send: 10 per day per phone', () => {
  function seedNineSends(db: ReturnType<typeof freshDb>, phone: string): void {
    for (let i = 1; i <= 9; i += 1) {
      insertSmsSend(db, { phone, ip: IP, now: NOW - i * MINUTE * 5 });
    }
  }

  test('9 sends today: the 10th is allowed, the 11th is refused', () => {
    const db = freshDb();
    const phone = '+8613900000010';
    seedNineSends(db, phone);
    assert.equal(checkSmsSend(db, { phone, ip: IP, now: NOW }).allowed, true);
    insertSmsSend(db, { phone, ip: IP, now: NOW - 30_000 });
    // Still refused: the newest send is inside the 60 s window; move past it.
    const refused = checkSmsSend(db, { phone, ip: IP, now: NOW });
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, 'SMS_TOO_FREQUENT');
    const after = checkSmsSend(db, { phone, ip: IP, now: NOW + 31_000 });
    assert.equal(after.allowed, false);
    assert.equal(after.reason, 'SMS_DAILY_LIMIT_PHONE');
  });

  test('10 sends today: the 11th is refused at the daily boundary', () => {
    const db = freshDb();
    const phone = '+8613900000011';
    for (let i = 1; i <= 10; i += 1) {
      insertSmsSend(db, { phone, ip: IP, now: NOW - i * MINUTE * 5 });
    }
    const check = checkSmsSend(db, { phone, ip: IP, now: NOW });
    assert.equal(check.allowed, false);
    assert.equal(check.reason, 'SMS_DAILY_LIMIT_PHONE');
  });

  test('yesterday’s sends do not count against today', () => {
    const db = freshDb();
    const phone = '+8613900000012';
    const dayStart = utcDayStart(NOW);
    insertSmsSend(db, { phone, ip: IP, now: dayStart - 1_000 });
    insertSmsSend(db, { phone, ip: IP, now: dayStart + 1_000 });
    const check = checkSmsSend(db, { phone, ip: IP, now: dayStart + 2_000 + MINUTE });
    assert.equal(check.allowed, true);
  });
});

describe('SMS send: 30 per day per IP', () => {
  test('30 sends from one IP: the 31st is refused', () => {
    const db = freshDb();
    for (let i = 1; i <= 30; i += 1) {
      insertSmsSend(db, { phone: `+86139001${String(i).padStart(5, '0')}`, ip: IP, now: NOW - i * MINUTE * 2 });
    }
    const refused = checkSmsSend(db, { phone: '+8613900299999', ip: IP, now: NOW });
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, 'SMS_DAILY_LIMIT_IP');
  });

  test('29 sends from one IP: the 30th is allowed', () => {
    const db = freshDb();
    for (let i = 1; i <= 29; i += 1) {
      insertSmsSend(db, { phone: `+86139003${String(i).padStart(5, '0')}`, ip: IP, now: NOW - i * MINUTE * 2 });
    }
    const check = checkSmsSend(db, { phone: '+8613900399999', ip: IP, now: NOW });
    assert.equal(check.allowed, true);
  });
});

describe('verify: 5 attempts per code', () => {
  test(`the ${MAX_ATTEMPTS_PER_CODE}th attempt is refused`, () => {
    const db = freshDb();
    const phone = '+8613900000020';
    const id = insertSmsSend(db, { phone, ip: IP, now: NOW, attempts: MAX_ATTEMPTS_PER_CODE - 1 });
    assert.equal(canAttemptCode(db, id, NOW), true);
    const exhausted = insertSmsSend(db, { phone, ip: IP, now: NOW, attempts: MAX_ATTEMPTS_PER_CODE });
    assert.equal(canAttemptCode(db, exhausted, NOW), false);
  });

  test('consumed or expired codes cannot be attempted', () => {
    const db = freshDb();
    const phone = '+8613900000021';
    const consumed = insertSmsSend(db, { phone, ip: IP, now: NOW, consumedAt: NOW - 1 });
    assert.equal(canAttemptCode(db, consumed, NOW), false);
    const expired = insertSmsSend(db, { phone, ip: IP, now: NOW });
    db.prepare('UPDATE sms_codes SET expires_at = ? WHERE id = ?').run(NOW - 1, expired);
    assert.equal(canAttemptCode(db, expired, NOW), false);
  });
});

describe('20 failed verifies per phone per day lock the phone for 24 h', () => {
  function seedFailures(db: ReturnType<typeof freshDb>, phone: string, count: number, lastAt: number): void {
    // Rapid-fire failures: all attempts land on the same instant.
    for (let i = 0; i < count; i += 1) {
      insertSmsSend(db, { phone, ip: IP, now: lastAt, attempts: 1 });
    }
  }

  test(`${FAILED_VERIFY_LOCK_THRESHOLD - 1} failures do not lock`, () => {
    const db = freshDb();
    const phone = '+8613900000030';
    seedFailures(db, phone, FAILED_VERIFY_LOCK_THRESHOLD - 1, NOW - MINUTE);
    assert.equal(checkPhoneLock(db, phone, NOW).locked, false);
  });

  test(`${FAILED_VERIFY_LOCK_THRESHOLD} failures lock the phone and block sends`, () => {
    const db = freshDb();
    const phone = '+8613900000031';
    const lastFailAt = NOW - MINUTE;
    seedFailures(db, phone, FAILED_VERIFY_LOCK_THRESHOLD, lastFailAt);
    const lock = checkPhoneLock(db, phone, NOW);
    assert.equal(lock.locked, true);
    assert.equal(lock.failedCount, FAILED_VERIFY_LOCK_THRESHOLD);
    assert.equal(lock.lockedUntil, lastFailAt + PHONE_LOCK_MS);
    const send = checkSmsSend(db, { phone, ip: IP, now: NOW });
    assert.equal(send.allowed, false);
    assert.equal(send.reason, 'PHONE_LOCKED');
  });

  test('consumed codes do not count toward the lock', () => {
    const db = freshDb();
    const phone = '+8613900000032';
    for (let i = 0; i < 19; i += 1) {
      insertSmsSend(db, { phone, ip: IP, now: NOW - (20 - i) * MINUTE, attempts: 1 });
    }
    insertSmsSend(db, { phone, ip: IP, now: NOW - MINUTE, attempts: 1, consumedAt: NOW - 30_000 });
    assert.equal(checkPhoneLock(db, phone, NOW).locked, false);
  });

  test('the lock expires 24 h after the last failure', () => {
    const db = freshDb();
    const phone = '+8613900000033';
    const lastFailAt = NOW - HOUR;
    seedFailures(db, phone, FAILED_VERIFY_LOCK_THRESHOLD, lastFailAt);
    const lock = checkPhoneLock(db, phone, NOW);
    assert.equal(lock.locked, true);
    assert.equal(checkPhoneLock(db, phone, lastFailAt + PHONE_LOCK_MS - 1).locked, true);
    assert.equal(checkPhoneLock(db, phone, lastFailAt + PHONE_LOCK_MS).locked, false);
  });
});
