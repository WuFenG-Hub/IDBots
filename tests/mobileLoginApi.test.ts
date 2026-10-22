import test from 'node:test';
import assert from 'node:assert/strict';
import { sendCode, verifyCode } from '../src/mobile/login/loginApi';

const PHONE = '+8613800000000';

test('loginApi.sendCode returns the C3 resendAfterSec shape', async () => {
  const result = await sendCode(PHONE);
  assert.deepEqual(result, { resendAfterSec: 60 });
});

test('loginApi.sendCode rejects invalid phone numbers with INVALID_PHONE', async () => {
  await assert.rejects(sendCode('123'), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'INVALID_PHONE');
    return true;
  });
});

test('loginApi.verifyCode returns C3 user and tenant objects', async () => {
  const result = await verifyCode(PHONE, '123456');
  assert.equal(result.user.id, 'mock-user');
  assert.ok(result.user.phoneMasked.includes('****'));
  assert.ok(!result.user.phoneMasked.includes(PHONE.slice(3, 11)));
  assert.equal(result.tenant.status, 'provisioning');
  assert.equal(result.tenant.error, null);
});

test('loginApi.verifyCode rejects an empty code with CODE_INVALID', async () => {
  await assert.rejects(verifyCode(PHONE, ''), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CODE_INVALID');
    return true;
  });
});

test('loginApi logs never contain the phone number or SMS code (SEC-12)', async () => {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await sendCode(PHONE);
    await verifyCode(PHONE, '123456', 'invite-token');
  } finally {
    console.info = original;
  }
  const all = lines.join('\n');
  assert.ok(all.includes('[loginApi] sendCode'));
  assert.ok(all.includes('[loginApi] verifyCode'));
  assert.ok(!all.includes(PHONE), 'phone number must not be logged');
  assert.ok(!all.includes('13800000000'), 'phone digits must not be logged');
  assert.ok(!all.includes('123456'), 'SMS code must not be logged');
  assert.ok(!all.includes('invite-token'), 'invite code must not be logged');
});
