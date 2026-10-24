import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { api } from './helpers.js';
import { setupProxyTest, type ProxyTest } from './proxyHarness.js';
import { decryptSecret } from '../src/crypto.js';
import { MASTER_KEY } from './helpers.js';
import { tenantBaseUrl } from '../src/docker/client.js';

async function freshReverify(t: ProxyTest): Promise<number> {
  // Deterministic resend window: clear this phone's sms rows first.
  t.db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(t.phone);
  const send = await api(t.cpBase, '/api/v1/reverify/send', {
    method: 'POST',
    cookie: t.cookie,
    body: { purpose: 'reveal-mnemonic' },
  });
  assert.equal(send.status, 200);
  const verify = await api(t.cpBase, '/api/v1/reverify/verify', {
    method: 'POST',
    cookie: t.cookie,
    body: { purpose: 'reveal-mnemonic', code: '246810' },
  });
  assert.equal(verify.status, 200);
  return (verify.json as { reverifyId: number }).reverifyId;
}

function auditRows(t: ProxyTest): Array<{ actor: string; action: string; detail_json: string }> {
  return t.db
    .prepare("SELECT actor, action, detail_json FROM audit_log WHERE action = 'sensitive.reveal-mnemonic'")
    .all() as Array<{ actor: string; action: string; detail_json: string }>;
}

describe('reverify and mnemonic export (REQ-B-16)', () => {
  let t: ProxyTest;

  before(async () => {
    t = await setupProxyTest();
  });

  after(async () => {
    await t.close();
  });

  test('full happy path: send -> verify -> reveal returns the mnemonic with no-store and a clean audit row', async () => {
    t.db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(t.phone);
    const send = await api(t.cpBase, '/api/v1/reverify/send', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic' },
    });
    assert.equal(send.status, 200);
    assert.deepEqual(send.json, { resendAfterSec: 60 });

    // The fake provider recorded the send to the user's own phone.
    const fakeSms = t.app.app.sms as { sends: Array<{ phone: string; purpose: string; code: string }> };
    const last = fakeSms.sends.at(-1)!;
    assert.equal(last.phone, t.phone);
    assert.equal(last.purpose, 'reverify');
    assert.equal(last.code, '246810');

    const verify = await api(t.cpBase, '/api/v1/reverify/verify', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic', code: '246810' },
    });
    assert.equal(verify.status, 200);
    const { reverifyId, expiresAt } = verify.json as { reverifyId: number; expiresAt: number };
    assert.ok(reverifyId > 0);
    assert.ok(expiresAt > Date.now() + 100_000, 'reverifyId is valid ~120 s');

    const reveal = await api(t.cpBase, '/api/v1/sensitive/reveal-mnemonic', {
      method: 'POST',
      cookie: t.cookie,
      body: { reverifyId, target: 'user' },
    });
    assert.equal(reveal.status, 200);
    const setCookieHeader = reveal.setCookie; // no cookies set here
    assert.deepEqual(setCookieHeader, []);
    const mnemonic = (reveal.json as { mnemonic: string }).mnemonic;
    assert.equal(mnemonic.split(' ').length, 12, '12-word mnemonic returned');

    const audits = auditRows(t);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor, `user:${t.userId}`);
    assert.equal(audits[0].action, 'sensitive.reveal-mnemonic');
    assert.ok(!audits[0].detail_json.includes(mnemonic.split(' ')[0]), 'audit detail has no mnemonic words');
  });

  test('the response carries Cache-Control: no-store', async () => {
    const reverifyId = await freshReverify(t);
    const res = await fetch(`${t.cpBase}/api/v1/sensitive/reveal-mnemonic`, {
      method: 'POST',
      headers: { Cookie: t.cookie, Origin: t.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reverifyId, target: 'user' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('single use: a second reveal with the same id is refused', async () => {
    const reverifyId = await freshReverify(t);
    const first = await api(t.cpBase, '/api/v1/sensitive/reveal-mnemonic', {
      method: 'POST',
      cookie: t.cookie,
      body: { reverifyId, target: 'user' },
    });
    assert.equal(first.status, 200);

    const second = await api(t.cpBase, '/api/v1/sensitive/reveal-mnemonic', {
      method: 'POST',
      cookie: t.cookie,
      body: { reverifyId, target: 'user' },
    });
    assert.equal(second.status, 403);
    assert.equal((second.json as { error: { code: string } }).error.code, 'REVERIFY_REQUIRED');
  });

  test('an expired reverifyId is refused', async () => {
    const reverifyId = await freshReverify(t);
    t.db.prepare('UPDATE reverify SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, reverifyId);
    const reveal = await api(t.cpBase, '/api/v1/sensitive/reveal-mnemonic', {
      method: 'POST',
      cookie: t.cookie,
      body: { reverifyId, target: 'user' },
    });
    assert.equal(reveal.status, 403);
    assert.equal((reveal.json as { error: { code: string } }).error.code, 'REVERIFY_REQUIRED');
  });

  test("another user's reverifyId and a wrong purpose are refused", async () => {
    const reverifyId = await freshReverify(t);
    t.db
      .prepare(
        `INSERT INTO users (id, phone_e164, display_name, locale, status, invite_code, created_at)
         VALUES ('u_other', '+8613900009999', 'Other', 'zh', 'active', NULL, ?)`,
      )
      .run(Date.now());
    t.db.prepare('UPDATE reverify SET user_id = ? WHERE id = ?').run('u_other', reverifyId);
    const wrongUser = await api(t.cpBase, '/api/v1/sensitive/reveal-mnemonic', {
      method: 'POST',
      cookie: t.cookie,
      body: { reverifyId, target: 'user' },
    });
    assert.equal(wrongUser.status, 403);

    const mine = await freshReverify(t);
    t.db.prepare("UPDATE reverify SET purpose = 'other' WHERE id = ?").run(mine);
    const wrongPurpose = await api(t.cpBase, '/api/v1/sensitive/reveal-mnemonic', {
      method: 'POST',
      cookie: t.cookie,
      body: { reverifyId: mine, target: 'user' },
    });
    assert.equal(wrongPurpose.status, 403);
  });

  test('code errors: missing/wrong/expired/attempt-capped', async () => {
    t.db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(t.phone);
    const send = await api(t.cpBase, '/api/v1/reverify/send', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic' },
    });
    assert.equal(send.status, 200);

    const wrong = await api(t.cpBase, '/api/v1/reverify/verify', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic', code: '000000' },
    });
    assert.equal(wrong.status, 400);
    assert.equal((wrong.json as { error: { code: string } }).error.code, 'CODE_INVALID');

    const attempts = t.db
      .prepare("SELECT attempts FROM sms_codes WHERE phone_e164 = ? AND purpose = 'reverify' AND consumed_at IS NULL")
      .get(t.phone) as { attempts: number };
    assert.equal(attempts.attempts, 1, 'the wrong attempt was counted');

    t.db.prepare('UPDATE sms_codes SET attempts = 5 WHERE phone_e164 = ? AND purpose = ?').run(t.phone, 'reverify');
    const capped = await api(t.cpBase, '/api/v1/reverify/verify', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic', code: '246810' },
    });
    assert.equal(capped.status, 429);
    assert.equal((capped.json as { error: { code: string } }).error.code, 'TOO_MANY_ATTEMPTS');

    t.db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ? AND purpose = ?').run(t.phone, 'reverify');
    await api(t.cpBase, '/api/v1/reverify/send', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic' },
    });
    t.db.prepare('UPDATE sms_codes SET expires_at = ? WHERE phone_e164 = ? AND purpose = ?').run(
      Date.now() - 1000,
      t.phone,
      'reverify',
    );
    const expired = await api(t.cpBase, '/api/v1/reverify/verify', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic', code: '246810' },
    });
    assert.equal(expired.status, 400);
    assert.equal((expired.json as { error: { code: string } }).error.code, 'CODE_EXPIRED');
  });

  test('the 60 s resend limit applies to reverify sends', async () => {
    t.db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ? AND purpose = ?').run(t.phone, 'reverify');
    const first = await api(t.cpBase, '/api/v1/reverify/send', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic' },
    });
    assert.equal(first.status, 200);
    const second = await api(t.cpBase, '/api/v1/reverify/send', {
      method: 'POST',
      cookie: t.cookie,
      body: { purpose: 'reveal-mnemonic' },
    });
    assert.equal(second.status, 429);
    assert.equal((second.json as { error: { code: string } }).error.code, 'RATE_LIMITED');
  });

  test('a not-ready tenant answers 409 and the reverifyId stays unconsumed', async () => {
    const reverifyId = await freshReverify(t);
    t.db.prepare("UPDATE tenants SET status = 'stopped' WHERE id = ?").run(t.tenantId);

    const reveal = await api(t.cpBase, '/api/v1/sensitive/reveal-mnemonic', {
      method: 'POST',
      cookie: t.cookie,
      body: { reverifyId, target: 'user' },
    });
    assert.equal(reveal.status, 409);
    assert.equal((reveal.json as { error: { code: string } }).error.code, 'TENANT_NOT_READY');

    const row = t.db.prepare('SELECT consumed_at FROM reverify WHERE id = ?').get(reverifyId) as {
      consumed_at: number | null;
    };
    assert.equal(row.consumed_at, null, 'not-ready tenant did not burn the single use');

    // And the same id still works once the tenant is back.
    t.db.prepare("UPDATE tenants SET status = 'ready' WHERE id = ?").run(t.tenantId);
    const retry = await api(t.cpBase, '/api/v1/sensitive/reveal-mnemonic', {
      method: 'POST',
      cookie: t.cookie,
      body: { reverifyId, target: 'metabot', metabotId: 3 },
    });
    assert.equal(retry.status, 200);
    const audits = auditRows(t);
    assert.ok(audits.some((a) => a.detail_json.includes('"metabotId":3')));
  });

  test('the tenant rejects a replayed C2 token with 401', async () => {
    // Craft a valid token against the tenant (the test knows the master key)
    // and replay it: first call 200, replayed nonce 401.
    const enc = (
      t.db.prepare('SELECT gateway_secret_enc FROM tenants WHERE id = ?').get(t.tenantId) as {
        gateway_secret_enc: string;
      }
    ).gateway_secret_enc;
    const secret = decryptSecret(MASTER_KEY, enc);
    const containers = await t.client.listContainers({ namePrefix: `idb-${t.tenantId}` });
    const inspect = await t.client.inspectContainer(containers[0].Id);
    const base = tenantBaseUrl(inspect);

    const nonce = crypto.randomBytes(16).toString('base64url');
    const payload = JSON.stringify({ t: t.tenantId, p: 'reveal-mnemonic', e: Date.now() + 120_000, n: nonce });
    const sig = crypto.createHmac('sha256', secret).update(payload).digest();
    const token = `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig.toString('base64url')}`;

    const call = () =>
      fetch(`${base}/gateway/v1/sensitive/reveal-mnemonic`, {
        method: 'POST',
        headers: { 'X-IDBots-Gateway-Secret': secret, 'X-IDBots-Reverify': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'user' }),
      });
    const first = await call();
    assert.equal(first.status, 200);
    const replay = await call();
    assert.equal(replay.status, 401, 'reused nonce rejected');
  });
});
