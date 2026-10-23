import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  api,
  freshDb,
  insertInvite,
  MASTER_KEY,
  sessionCookieFrom,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';
import { encryptSecret } from '../src/crypto.js';
import { TenantPoller } from '../src/services/poller.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let fake: FakeDocker;
let app: TestApp;
let poller: TenantPoller;

interface AuthBody {
  user: { id: string; phoneMasked: string; createdAt: number; locale: string };
  tenant: {
    status: string;
    phase: string | null;
    appVersion: string | null;
    contractVersion: string | null;
    error: string | null;
  };
}

const PHONE = '+8613900000200';
const INVITE = 'FLOW-1';
const REDEEM_CODE = 'REDEEM-CODE-123';

async function sendSms(phone: string): Promise<void> {
  const res = await api(app.baseUrl, '/api/v1/auth/sms/send', {
    method: 'POST',
    body: { phone, purpose: 'login' },
  });
  assert.equal(res.status, 200);
}

before(async () => {
  db = freshDb();
  fake = new FakeDocker();
  await fake.listen(0);
  app = await startTestApp({
    db,
    dockerUrl: fake.url(),
    fakeSmsNumbers: [PHONE],
    tenantEnv: {
      FAKE_TENANT_HEALTH_AFTER_MS: '50',
      // Generous phase windows so 40 ms db polls cannot skip a status even
      // under CPU contention.
      FAKE_TENANT_PHASES: 'migrating:300,bootstrapping:300,ready:0',
    },
  });
  poller = new TenantPoller(app.app, { tickFastMs: 50, tickSlowMs: 100 });
  poller.start();

  insertInvite(db, { code: INVITE, maxUses: 5, withRedeem: 1, now: Date.now() });
  db.prepare(
    `INSERT INTO redeem_codes (code_enc, code_hash, batch_note, imported_at)
     VALUES (?, ?, 'flow-test', ?)`,
  ).run(encryptSecret(MASTER_KEY, REDEEM_CODE), 'flow-hash-1', Date.now());
});

after(async () => {
  await poller.stop();
  await app.close();
  await fake.close();
  db.close();
});

describe('auth flow end to end (REQ-B-7, REQ-B-9)', () => {
  test('invite sign-up -> provisioning -> ready, redeem code reaches the tenant', async () => {
    await sendSms(PHONE);

    const verify = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone: PHONE, code: '246810', inviteCode: INVITE, displayName: 'Lin' },
    });
    assert.equal(verify.status, 200);
    const body = verify.json as AuthBody;
    const userId = body.user.id as string;
    assert.match(body.user.phoneMasked, /^\+861\*\*\*\*\d{4}$/);
    assert.equal(body.tenant.status, 'provisioning');
    const cookie = sessionCookieFrom(verify.setCookie);

    // The fake provider recorded the send with the fixed code.
    const fakeSms = app.app.sms as { sends: Array<{ phone: string; code: string }> };
    assert.equal(fakeSms.sends.at(-1)?.code, '246810');

    // Record the status transitions from the database.
    const seen: string[] = [];
    await waitFor(async () => {
      const row = db.prepare('SELECT status FROM tenants WHERE user_id = ?').get(userId) as
        | { status: string }
        | undefined;
      if (row && seen[seen.length - 1] !== row.status) {
        seen.push(row.status);
      }
      return row?.status === 'ready' ? true : null;
    }, 15_000);

    const ordered = (...statuses: string[]) => {
      const indexes = statuses.map((s) => seen.indexOf(s));
      return indexes.every((i) => i !== -1) && indexes.every((v, i) => i === 0 || v > indexes[i - 1]);
    };
    assert.ok(
      ordered('booting', 'onboarding', 'ready'),
      `expected booting -> onboarding -> ready in order, saw: ${seen.join(',')}`,
    );
    assert.ok(seen[0] === 'provisioning' || seen[0] === 'booting', `first status was ${seen[0]}`);

    // The invite was consumed exactly once; the redeem pool is now assigned.
    const invite = db.prepare('SELECT used_count FROM invites WHERE code = ?').get(INVITE) as { used_count: number };
    assert.equal(invite.used_count, 1);
    const redeem = db
      .prepare('SELECT assigned_user_id FROM redeem_codes WHERE code_hash = ?')
      .get('flow-hash-1') as { assigned_user_id: string | null };
    assert.equal(redeem.assigned_user_id, userId);

    // The tenant container got the full C1 env, including the redeem code.
    const containers = await app.app.docker.listContainers({ namePrefix: `idb-` });
    assert.equal(containers.length, 1);
    const inspect = await app.app.docker.inspectContainer(containers[0].Id);
    assert.equal(inspect.State.Running, true);
    const tenantRow = db.prepare('SELECT id FROM tenants WHERE user_id = ?').get(userId) as { id: string };
    assert.ok(inspect.Config.Env.includes(`IDBOTS_TENANT_ID=${tenantRow.id}`));
    assert.ok(inspect.Config.Env.includes(`IDBOTS_BOOTSTRAP_DISPLAY_NAME=Lin`));
    assert.ok(inspect.Config.Env.includes(`IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE=${REDEEM_CODE}`));
    assert.ok(inspect.Config.Env.includes('IDBOTS_SERVER_MODE=1'));

    // GET /api/v1/me reflects the ready tenant.
    const me = await api(app.baseUrl, '/api/v1/me', { cookie });
    assert.equal(me.status, 200);
    const meBody = me.json as AuthBody;
    assert.equal(meBody.user.id, userId);
    assert.equal(meBody.tenant.status, 'ready');
    assert.equal(meBody.tenant.appVersion, '0.12.0');
    assert.equal(meBody.tenant.phase, null);

    // Re-login without an invite: same user, same tenant, nothing consumed twice.
    const logout = await api(app.baseUrl, '/api/v1/auth/logout', { method: 'POST', cookie });
    assert.equal(logout.status, 204);
    db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(PHONE);
    await sendSms(PHONE);
    const reverify = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone: PHONE, code: '246810' },
    });
    assert.equal(reverify.status, 200);
    const reBody = reverify.json as AuthBody;
    assert.equal(reBody.user.id, userId);
    assert.equal(reBody.tenant.status, 'ready');

    const inviteAfter = db.prepare('SELECT used_count FROM invites WHERE code = ?').get(INVITE) as {
      used_count: number;
    };
    assert.equal(inviteAfter.used_count, 1, 'no second invite use');
    const assignments = (
      db.prepare('SELECT COUNT(*) AS n FROM redeem_codes WHERE assigned_user_id = ?').get(userId) as { n: number }
    ).n;
    assert.equal(assignments, 1, 'no second redeem code');
  }, 30_000);
});
