import assert from 'node:assert/strict';
import test from 'node:test';
import { probeSessionRecovery } from '../src/mobile/login/sessionRecovery.ts';
import type { GetMeResult, LoginTenant } from '../src/mobile/login/loginApi.ts';

function me(status: LoginTenant['status']): GetMeResult {
  return {
    user: { id: 'u1', phoneMasked: '+86****0000', createdAt: 1, locale: 'en' },
    tenant: { status, phase: null, appVersion: null, contractVersion: null, error: null },
  };
}

test('cold start uses getMe to restore ready and degraded sessions', async () => {
  for (const status of ['ready', 'degraded'] as const) {
    let calls = 0;
    const action = await probeSessionRecovery(async () => {
      calls += 1;
      return me(status);
    });
    assert.equal(action, 'open-app');
    assert.equal(calls, 1);
  }
});

test('cold start keeps provisioning and failed tenants in the existing preparing flow', async () => {
  assert.equal(await probeSessionRecovery(async () => me('provisioning')), 'preparing');
  assert.equal(await probeSessionRecovery(async () => me('failed')), 'preparing');
});

test('only an unauthorized session opens the login form', async () => {
  assert.equal(await probeSessionRecovery(async () => {
    throw Object.assign(new Error('unauthorized'), { code: 'UNAUTHORIZED' });
  }), 'login');
});

test('transient getMe failures request a retry instead of treating a valid cookie as logged out', async () => {
  for (const error of [new Error('offline'), Object.assign(new Error('server'), { code: 'HTTP_503' })]) {
    assert.equal(await probeSessionRecovery(async () => { throw error; }), 'retry');
  }
});
