import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  freshDb,
  MASTER_KEY,
  seedUserAndTenant,
  startAlertSink,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';
import { DockerClient } from '../src/docker/client.js';
import { decryptSecret } from '../src/crypto.js';
import { reconcileAtStartup } from '../src/services/reconcile.js';
import { recoverTenant } from '../src/services/recovery.js';
import { provisionTenant } from '../src/services/provisioning.js';
import { TenantPoller } from '../src/services/poller.js';

let db: Database.Database;
let fake: FakeDocker;
let client: DockerClient;
let sink: { url: string; messages: string[]; close: () => Promise<void> };
let app: TestApp;

before(async () => {
  db = freshDb();
  fake = new FakeDocker({ failCreateImages: ['tenant:broken'] });
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

async function startContainer(tenantId: string, image: string): Promise<void> {
  const created = await client.createContainer({
    name: `idb-${tenantId}`,
    image,
    env: {
      IDBOTS_SERVER_MODE: '1',
      IDBOTS_TENANT_ID: tenantId,
      IDBOTS_GATEWAY_SECRET: 'test-secret',
      FAKE_TENANT_HEALTH_AFTER_MS: '0',
      FAKE_TENANT_PHASES: 'ready:0',
    },
  });
  await client.startContainer(created.Id);
}

function audits(id: string, action: string): Array<{ actor: string }> {
  return db.prepare('SELECT actor FROM audit_log WHERE target = ? AND action = ?').all(id, action) as Array<{
    actor: string;
  }>;
}

function fastPoller(): TenantPoller {
  return new TenantPoller(app.app, { tickFastMs: 50, tickSlowMs: 100 });
}

async function waitForReady(tenantId: string): Promise<void> {
  await waitFor(async () => {
    const row = db.prepare('SELECT status FROM tenants WHERE id = ?').get(tenantId) as
      | { status: string }
      | undefined;
    return row?.status === 'ready' ? true : null;
  }, 15_000);
}

describe('startup recovery (S2-1/S2-2)', () => {
  test('provisioning with an existing container resumes at booting', async () => {
    seedUserAndTenant(db, { userId: 'u_rec1', phone: '+8613900007001', tenantId: 't_rec1', status: 'provisioning' });
    await startContainer('t_rec1', 'fake-tenant:test');

    await reconcileAtStartup(app.app);

    const row = db.prepare("SELECT status FROM tenants WHERE id = 't_rec1'").get() as { status: string };
    assert.equal(row.status, 'booting');
    assert.equal(audits('t_rec1', 'tenant.recovery.booting').length, 1);
    assert.equal(audits('t_rec1', 'tenant.recovery.booting')[0].actor, 'system');
  });

  test('provisioning without a container re-provisions with the SAME secret and reaches ready', async () => {
    seedUserAndTenant(db, {
      userId: 'u_rec2',
      phone: '+8613900007002',
      tenantId: 't_rec2',
      status: 'provisioning',
      gatewaySecret: 'keep-me-secret',
    });

    await reconcileAtStartup(app.app);

    const containers = await client.listContainers({ namePrefix: 'idb-t_rec2' });
    assert.equal(containers.length, 1, 'container re-created');
    const enc = (db.prepare("SELECT gateway_secret_enc FROM tenants WHERE id = 't_rec2'").get() as {
      gateway_secret_enc: string;
    }).gateway_secret_enc;
    assert.equal(decryptSecret(MASTER_KEY, enc), 'keep-me-secret', 'secret unchanged by re-provision');
    assert.equal(audits('t_rec2', 'tenant.recovery.reprovision').length, 1);

    const poller = fastPoller();
    poller.start();
    try {
      await waitForReady('t_rec2');
    } finally {
      await poller.stop();
    }
  });

  test('orphaned upgrading rolls back onto tenants.image (pre-upgrade) and becomes ready again', async () => {
    seedUserAndTenant(db, {
      userId: 'u_rec3',
      phone: '+8613900007003',
      tenantId: 't_rec3',
      status: 'upgrading',
      image: 'tenant:1.0.0',
    });
    // Simulate the mid-upgrade state: a container already recreated from the NEW image.
    await startContainer('t_rec3', 'tenant:1.1.0');

    await reconcileAtStartup(app.app);

    const containers = await client.listContainers({ namePrefix: 'idb-t_rec3' });
    assert.equal(containers.length, 1);
    const inspect = await client.inspectContainer(containers[0].Id);
    assert.equal(inspect.Config.Image, 'tenant:1.0.0', 'recreated from the pre-upgrade image');
    const row = db.prepare("SELECT status FROM tenants WHERE id = 't_rec3'").get() as { status: string };
    assert.equal(row.status, 'booting');
    const rollbackAudits = audits('t_rec3', 'tenant.recovery.rollback');
    assert.equal(rollbackAudits.length, 1);
    assert.equal(rollbackAudits[0].actor, 'system');

    const poller = fastPoller();
    poller.start();
    try {
      await waitForReady('t_rec3');
    } finally {
      await poller.stop();
    }
  });

  test('upgrading recovery failure marks the tenant failed and alerts', async () => {
    seedUserAndTenant(db, {
      userId: 'u_rec4',
      phone: '+8613900007004',
      tenantId: 't_rec4',
      status: 'upgrading',
      image: 'tenant:broken',
    });
    await startContainer('t_rec4', 'tenant:1.1.0');

    await reconcileAtStartup(app.app);

    const row = db.prepare("SELECT status, last_error FROM tenants WHERE id = 't_rec4'").get() as {
      status: string;
      last_error: string | null;
    };
    assert.equal(row.status, 'failed');
    assert.match(row.last_error ?? '', /recovery rollback failed/);
    assert.equal(audits('t_rec4', 'tenant.recovery.failed').length, 1);
    assert.equal((await client.listContainers({ namePrefix: 'idb-t_rec4' })).length, 0);
    await waitFor(async () => (sink.messages.some((m) => m.includes('t_rec4')) ? true : null));
  });

  test('runtime: a stale provisioning row is recovered by the poller without any restart', async () => {
    seedUserAndTenant(db, { userId: 'u_rec5', phone: '+8613900007005', tenantId: 't_rec5', status: 'provisioning' });
    db.prepare("UPDATE tenants SET updated_at = ? WHERE id = 't_rec5'").run(Date.now() - 3_600_000);

    const poller = new TenantPoller(app.app, { tickFastMs: 50, tickSlowMs: 100, staleProvisioningMs: 200 });
    poller.start();
    try {
      await waitFor(async () => {
        const row = db.prepare("SELECT status FROM tenants WHERE id = 't_rec5'").get() as
          | { status: string }
          | undefined;
        return row && row.status !== 'provisioning' ? true : null;
      }, 10_000);
      const containers = await client.listContainers({ namePrefix: 'idb-t_rec5' });
      assert.equal(containers.length, 1, 'stale row re-provisioned by the poller');
    } finally {
      await poller.stop();
    }
  });

  test('concurrent provisioning and recovery runs never double-provision', async () => {
    seedUserAndTenant(db, { userId: 'u_rec6', phone: '+8613900007006', tenantId: 't_rec6', status: 'provisioning' });
    const row = db.prepare("SELECT * FROM tenants WHERE id = 't_rec6'").get() as Parameters<typeof recoverTenant>[1];

    await Promise.all([
      provisionTenant(app.app, 't_rec6'),
      provisionTenant(app.app, 't_rec6'),
      recoverTenant(app.app, row),
    ]);

    const containers = await client.listContainers({ namePrefix: 'idb-t_rec6' });
    assert.equal(containers.length, 1, 'exactly one container despite three concurrent runs');
    const status = (db.prepare("SELECT status FROM tenants WHERE id = 't_rec6'").get() as { status: string }).status;
    assert.ok(status === 'booting' || status === 'ready');
  });
});
