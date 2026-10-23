import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, waitFor } from './helpers.js';
import { setupProxyTest, type ProxyTest } from './proxyHarness.js';

describe('account deletion request (REQ-B-17)', () => {
  let t: ProxyTest;

  before(async () => {
    t = await setupProxyTest({ withAlertSink: true });
  });

  after(async () => {
    await t.close();
  });

  test('creates a request, answers 202, and alerts with the masked phone', async () => {
    const res = await api(t.cpBase, '/api/v1/account/deletion-request', {
      method: 'POST',
      cookie: t.cookie,
      body: { reason: 'testing' },
    });
    assert.equal(res.status, 202);
    const { requestId } = res.json as { requestId: number };
    assert.ok(requestId > 0);

    const row = t.db.prepare('SELECT user_id, reason, status FROM deletion_requests WHERE id = ?').get(requestId) as {
      user_id: string;
      reason: string;
      status: string;
    };
    assert.equal(row.user_id, t.userId);
    assert.equal(row.reason, 'testing');
    assert.equal(row.status, 'open');

    await waitFor(async () =>
      t.sink!.messages.some((m) => m.includes(`deletion request #${requestId}`)) ? true : null,
    );
    const alert = t.sink!.messages.find((m) => m.includes(`deletion request #${requestId}`))!;
    assert.ok(alert.includes('+861****'), 'alert carries the masked phone');
    assert.ok(!alert.includes(t.phone), 'alert never carries the full phone');

    const audit = t.db
      .prepare("SELECT actor, action FROM audit_log WHERE action = 'account.deletion-request'")
      .get() as { actor: string; action: string } | undefined;
    assert.equal(audit?.actor, `user:${t.userId}`);
  });

  test('a second call while one is open returns the same request id', async () => {
    const first = await api(t.cpBase, '/api/v1/account/deletion-request', {
      method: 'POST',
      cookie: t.cookie,
      body: {},
    });
    assert.equal(first.status, 202);
    const second = await api(t.cpBase, '/api/v1/account/deletion-request', {
      method: 'POST',
      cookie: t.cookie,
      body: { reason: 'again' },
    });
    assert.equal(second.status, 202);
    assert.equal((second.json as { requestId: number }).requestId, (first.json as { requestId: number }).requestId);
    const count = t.db
      .prepare("SELECT COUNT(*) AS n FROM deletion_requests WHERE user_id = ? AND status = 'open'")
      .get(t.userId) as { n: number };
    assert.equal(count.n, 1, 'still exactly one open request');
  });
});
