import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  freshDb,
  insertInvite,
  seedUserAndTenant,
  startAlertSink,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';
import { DockerClient } from '../src/docker/client.js';
import { encryptSecret } from '../src/crypto.js';
import { provisionTenant } from '../src/services/provisioning.js';

let db: Database.Database;
let fake: FakeDocker;
let client: DockerClient;
let sink: { url: string; messages: string[]; close: () => Promise<void> };
let app: TestApp;

before(async () => {
  db = freshDb();
  fake = new FakeDocker();
  await fake.listen(0);
  client = new DockerClient(fake.url());
  sink = await startAlertSink();
  app = await startTestApp({ db, dockerUrl: fake.url(), alertWebhook: sink.url });
});

after(async () => {
  await app.close();
  await sink.close();
  await fake.close();
  db.close();
});

async function containerEnv(tenantId: string): Promise<string[]> {
  const containers = await client.listContainers({ namePrefix: `idb-${tenantId}` });
  assert.equal(containers.length, 1);
  const inspect = await client.inspectContainer(containers[0].Id);
  return inspect.Config.Env;
}

describe('empty redeem pool alerting (S2-3)', () => {
  test('a plain invite provisions silently: no warn-alert, no redeem env', async () => {
    insertInvite(db, { code: 'PLAIN-1', maxUses: 5, withRedeem: 0, now: Date.now() });
    seedUserAndTenant(db, {
      userId: 'u_pa1',
      phone: '+8613900008001',
      tenantId: 't_pa1',
      status: 'provisioning',
      inviteCode: 'PLAIN-1',
    });

    await provisionTenant(app.app, 't_pa1');

    const env = await containerEnv('t_pa1');
    assert.ok(
      !env.some((entry) => entry.startsWith('IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE=')),
      'no redeem code env for a plain invite',
    );
    assert.equal(
      sink.messages.some((m) => m.includes('pool empty')),
      false,
      'plain invite must not raise the empty-pool alert',
    );
    const row = db.prepare("SELECT status FROM tenants WHERE id = 't_pa1'").get() as { status: string };
    assert.equal(row.status, 'booting');
  });

  test('a with_redeem invite with an empty pool still warns and alerts', async () => {
    insertInvite(db, { code: 'REDEEM-1', maxUses: 5, withRedeem: 1, now: Date.now() });
    seedUserAndTenant(db, {
      userId: 'u_pa2',
      phone: '+8613900008002',
      tenantId: 't_pa2',
      status: 'provisioning',
      inviteCode: 'REDEEM-1',
    });

    await provisionTenant(app.app, 't_pa2');

    const env = await containerEnv('t_pa2');
    assert.ok(
      !env.some((entry) => entry.startsWith('IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE=')),
      'pool was empty: provisioned without a code',
    );
    await waitFor(async () =>
      sink.messages.some((m) => m.includes('t_pa2') && m.includes('pool empty')) ? true : null,
    );
    const row = db.prepare("SELECT status FROM tenants WHERE id = 't_pa2'").get() as { status: string };
    assert.equal(row.status, 'booting');
  });

  test('a with_redeem invite with an assigned code attaches it silently', async () => {
    insertInvite(db, { code: 'REDEEM-2', maxUses: 5, withRedeem: 1, now: Date.now() });
    seedUserAndTenant(db, {
      userId: 'u_pa3',
      phone: '+8613900008003',
      tenantId: 't_pa3',
      status: 'provisioning',
      inviteCode: 'REDEEM-2',
    });
    const before = sink.messages.length;
    db.prepare(
      `INSERT INTO redeem_codes (code_enc, code_hash, batch_note, imported_at, assigned_user_id, assigned_at)
       VALUES (?, 'pa3-hash', 'test', ?, 'u_pa3', ?)`,
    ).run(encryptSecret(app.app.config.masterKey, 'CODE-FOR-PA3'), Date.now(), Date.now());

    await provisionTenant(app.app, 't_pa3');

    const env = await containerEnv('t_pa3');
    assert.ok(env.includes('IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE=CODE-FOR-PA3'));
    assert.equal(sink.messages.length, before, 'no alert when the code was assigned');
  });

  test('a corrupt redeem ciphertext fails the tenant instead of crashing (S3-3)', async () => {
    insertInvite(db, { code: 'REDEEM-3', maxUses: 5, withRedeem: 1, now: Date.now() });
    seedUserAndTenant(db, {
      userId: 'u_pa4',
      phone: '+8613900008004',
      tenantId: 't_pa4',
      status: 'provisioning',
      inviteCode: 'REDEEM-3',
    });
    db.prepare(
      `INSERT INTO redeem_codes (code_enc, code_hash, batch_note, imported_at, assigned_user_id, assigned_at)
       VALUES ('###undecryptable###', 'pa4-hash', 'test', ?, 'u_pa4', ?)`,
    ).run(Date.now(), Date.now());

    // Must resolve (no unhandled rejection) and leave the tenant failed.
    await provisionTenant(app.app, 't_pa4');

    const row = db.prepare("SELECT status, last_error FROM tenants WHERE id = 't_pa4'").get() as {
      status: string;
      last_error: string | null;
    };
    assert.equal(row.status, 'failed');
    assert.match(row.last_error ?? '', /spec build failed/);
    await waitFor(async () => (sink.messages.some((m) => m.includes('t_pa4')) ? true : null));
    assert.equal((await client.listContainers({ namePrefix: 'idb-t_pa4' })).length, 0);
  });
});
