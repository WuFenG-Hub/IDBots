import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  freshDb,
  seedUserAndTenant,
  startAlertSink,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';
import { DockerClient } from '../src/docker/client.js';
import { reconcileAtStartup } from '../src/services/reconcile.js';
import { TenantPoller } from '../src/services/poller.js';

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

async function startContainer(name: string): Promise<string> {
  const created = await client.createContainer({
    name,
    image: 'fake-tenant:test',
    env: {
      IDBOTS_SERVER_MODE: '1',
      IDBOTS_TENANT_ID: name.replace(/^idb-/, ''),
      IDBOTS_GATEWAY_SECRET: 'test-secret',
      FAKE_TENANT_HEALTH_AFTER_MS: '0',
      FAKE_TENANT_PHASES: 'ready:0',
    },
  });
  await client.startContainer(created.Id);
  return created.Id;
}

describe('startup reconcile (REQ-B-11)', () => {
  test('matches containers to tenants, reports unknowns, fails orphans', async () => {
    // (a) a live tenant with its container, stale version to prove polling resumes
    seedUserAndTenant(db, {
      userId: 'u_rc1',
      phone: '+8613900004001',
      tenantId: 't_known',
      status: 'ready',
      appVersion: '0.0.0-stale',
    });
    await startContainer('idb-t_known');

    // (b) a container the tenants table does not know
    await startContainer('idb-t_ghost');

    // (c) a provisioning tenant with no container at all: re-provisioned, not failed
    seedUserAndTenant(db, {
      userId: 'u_rc3',
      phone: '+8613900004003',
      tenantId: 't_orphan',
      status: 'provisioning',
    });

    const reported = await reconcileAtStartup(app.app);
    assert.equal(reported.length, 1, 'only the unknown container is reported');
    assert.ok(reported.some((entry) => entry.includes('unknown container idb-t_ghost')));

    // (c) recovered: container created, tenant handed to the poller at booting.
    const orphanContainers = await client.listContainers({ namePrefix: 'idb-t_orphan' });
    assert.equal(orphanContainers.length, 1, 'orphaned provisioning tenant re-provisioned');
    const orphan = db.prepare("SELECT status FROM tenants WHERE id = 't_orphan'").get() as { status: string };
    assert.equal(orphan.status, 'booting');
    assert.ok(
      (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE target = 't_orphan' AND action = 'tenant.recovery.reprovision'").get() as { n: number }).n === 1,
      'recovery audit row written',
    );
    const known = db.prepare("SELECT status FROM tenants WHERE id = 't_known'").get() as { status: string };
    assert.equal(known.status, 'ready');

    // (b) the unknown container is reported (alert) and left running, never deleted.
    await waitFor(async () => (sink.messages.some((m) => m.includes('unknown container idb-t_ghost')) ? true : null));
    const ghost = (await client.listContainers({ namePrefix: 'idb-t_ghost' }))[0];
    assert.ok(ghost, 'ghost container still present');
    const ghostInspect = await client.inspectContainer(ghost.Id);
    assert.equal(ghostInspect.State.Running, true, 'ghost container still running');

    // After reconcile, polling resumes over the live tenant: its version is refreshed.
    const poller = new TenantPoller(
      { config: app.config, db, docker: client },
      { tickFastMs: 30, tickSlowMs: 30 },
    );
    await poller.tickOnce();
    await waitFor(async () => {
      const row = db.prepare("SELECT app_version FROM tenants WHERE id = 't_known'").get() as {
        app_version: string | null;
      };
      return row.app_version === '0.12.0' ? true : null;
    });
    await poller.stop();
  });

  test('docker unreachable: reconcile skips without touching statuses', async () => {
    seedUserAndTenant(db, { userId: 'u_rc4', phone: '+8613900004004', tenantId: 't_unreach', status: 'ready' });
    const dead = new DockerClient('http://127.0.0.1:1');
    const reported = await reconcileAtStartup({ config: app.config, db, docker: dead });
    assert.deepEqual(reported, []);
    const row = db.prepare("SELECT status FROM tenants WHERE id = 't_unreach'").get() as { status: string };
    assert.equal(row.status, 'ready', 'status untouched when docker is down');
  });
});
