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
import { nextStatus, type ProbeResult } from '../src/services/statusMachine.js';
import { TenantPoller } from '../src/services/poller.js';

const T = { healthyMs: 60_000, readyFirstMs: 300_000, readyRestartMs: 90_000 };
const NOW = 1_800_000_000_000;

const okProbe = (overrides: Partial<Extract<ProbeResult, { kind: 'ok' }>> = {}): ProbeResult => ({
  kind: 'ok',
  ready: false,
  phase: 'migrating',
  appVersion: '0.12.0',
  contractVersion: '1.0.0',
  readyzError: null,
  ...overrides,
});

describe('status machine transitions (pure)', () => {
  test('booting + health-down within budget stays booting', () => {
    const t = nextStatus('booting', { kind: 'health-down' }, { now: NOW, startedAtMs: NOW - 1000, firstBoot: true }, T);
    assert.equal(t.to, 'booting');
    assert.equal(t.alert, null);
  });

  test('booting + health-down past the healthy budget fails with an alert', () => {
    const t = nextStatus('booting', { kind: 'health-down' }, { now: NOW, startedAtMs: NOW - 61_000, firstBoot: true }, T);
    assert.equal(t.to, 'failed');
    assert.match(t.lastError ?? '', /healthz/);
    assert.ok(t.alert);
  });

  test('provisioning is treated like booting', () => {
    const t = nextStatus('provisioning', { kind: 'health-down' }, { now: NOW, startedAtMs: NOW - 61_000, firstBoot: true }, T);
    assert.equal(t.to, 'failed');
  });

  test('onboarding persists the phase and versions from the probe', () => {
    const t = nextStatus('booting', okProbe({ phase: 'bootstrapping' }), { now: NOW, startedAtMs: NOW - 5000, firstBoot: true }, T);
    assert.equal(t.to, 'onboarding');
    assert.equal(t.phase, 'bootstrapping');
    assert.equal(t.appVersion, '0.12.0');
    assert.equal(t.lastError, null);
  });

  test('starting counts as an onboarding phase', () => {
    const t = nextStatus('booting', okProbe({ phase: 'starting' }), { now: NOW, startedAtMs: NOW - 5000, firstBoot: true }, T);
    assert.equal(t.to, 'onboarding');
    assert.equal(t.phase, 'starting');
  });

  test('ready budget: 300 s on first boot, 90 s on restarts', () => {
    const firstBoot = nextStatus(
      'onboarding',
      okProbe({ phase: 'migrating' }),
      { now: NOW, startedAtMs: NOW - 100_000, firstBoot: true },
      T,
    );
    assert.equal(firstBoot.to, 'onboarding', '100 s is inside the 300 s first-boot budget');
    const restart = nextStatus(
      'onboarding',
      okProbe({ phase: 'migrating' }),
      { now: NOW, startedAtMs: NOW - 100_000, firstBoot: false },
      T,
    );
    assert.equal(restart.to, 'failed', '100 s exceeds the 90 s restart budget');
    assert.match(restart.lastError ?? '', /ready/);
  });

  test('readyz ready -> ready; degraded -> degraded with no last_error', () => {
    const ready = nextStatus('onboarding', okProbe({ ready: true, phase: 'ready' }), { now: NOW, startedAtMs: NOW - 5000, firstBoot: true }, T);
    assert.equal(ready.to, 'ready');
    assert.equal(ready.phase, null);
    const degraded = nextStatus('onboarding', okProbe({ ready: true, phase: 'degraded', readyzError: { step: 'redeemCode', message: 'x' } }), { now: NOW, startedAtMs: NOW - 5000, firstBoot: true }, T);
    assert.equal(degraded.to, 'degraded');
    assert.equal(degraded.lastError, null, 'degraded detail is logs-only');
  });

  test('readyz phase failed fails the tenant with the step detail', () => {
    const t = nextStatus(
      'onboarding',
      okProbe({ ready: false, phase: 'failed', readyzError: { step: 'identity', message: 'boom' } }),
      { now: NOW, startedAtMs: NOW - 5000, firstBoot: true },
      T,
    );
    assert.equal(t.to, 'failed');
    assert.match(t.lastError ?? '', /identity: boom/);
  });

  test('container exit fails from any live status', () => {
    for (const status of ['provisioning', 'booting', 'onboarding', 'ready', 'degraded'] as const) {
      const t = nextStatus(status, { kind: 'exited', exitCode: 1 }, { now: NOW, startedAtMs: NOW - 5000, firstBoot: true }, T);
      assert.equal(t.to, 'failed');
      assert.match(t.lastError ?? '', /exited/);
    }
  });

  test('terminal/admin states never transition', () => {
    const probe = okProbe({ ready: true, phase: 'ready' });
    for (const status of ['stopped', 'suspended', 'upgrading', 'failed'] as const) {
      const t = nextStatus(status, probe, { now: NOW, startedAtMs: NOW - 5000, firstBoot: false }, T);
      assert.equal(t.to, status);
      assert.equal(t.alert, null);
    }
  });

  test('probe errors are transient but still respect the budgets', () => {
    const early = nextStatus('booting', { kind: 'probe-error', message: 'conn refused' }, { now: NOW, startedAtMs: NOW - 1000, firstBoot: true }, T);
    assert.equal(early.to, 'booting');
    const late = nextStatus('booting', { kind: 'probe-error', message: 'conn refused' }, { now: NOW, startedAtMs: NOW - 61_000, firstBoot: true }, T);
    assert.equal(late.to, 'failed');
  });
});

describe('status machine against the fake tenant (integration)', () => {
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

  async function startTenantContainer(
    tenantId: string,
    env: Record<string, string>,
  ): Promise<void> {
    const created = await client.createContainer({
      name: `idb-${tenantId}`,
      image: 'fake-tenant:test',
      env: {
        IDBOTS_SERVER_MODE: '1',
        IDBOTS_TENANT_ID: tenantId,
        IDBOTS_GATEWAY_SECRET: 'test-secret',
        ...env,
      },
    });
    await client.startContainer(created.Id);
  }

  function makePoller(dbRef: Database.Database): TenantPoller {
    return new TenantPoller(
      { config: app.config, db: dbRef, docker: client },
      { tickFastMs: 40, tickSlowMs: 80, timeouts: { healthyMs: 400, readyFirstMs: 1000, readyRestartMs: 800 } },
    );
  }

  test('a tenant that never becomes healthy fails and alerts', async () => {
    seedUserAndTenant(db, { userId: 'u_sm1', phone: '+8613900003001', tenantId: 't_sm1', status: 'booting' });
    await startTenantContainer('t_sm1', {
      FAKE_TENANT_HEALTH_AFTER_MS: '60000',
      FAKE_TENANT_PHASES: 'ready:0',
    });
    const poller = makePoller(db);
    poller.start();
    try {
      await waitFor(async () => {
        const row = db.prepare("SELECT status, last_error FROM tenants WHERE id = 't_sm1'").get() as
          | { status: string; last_error: string | null }
          | undefined;
        return row?.status === 'failed' ? row : null;
      }, 10_000);
      const failedRow = db.prepare("SELECT last_error FROM tenants WHERE id = 't_sm1'").get() as {
        last_error: string;
      };
      assert.match(failedRow.last_error, /healthz/);
      await waitFor(async () => (sink.messages.some((m) => m.includes('t_sm1')) ? true : null));
    } finally {
      await poller.stop();
    }
  });

  test('a tenant that crashes during onboarding fails and alerts', async () => {
    seedUserAndTenant(db, { userId: 'u_sm2', phone: '+8613900003002', tenantId: 't_sm2', status: 'onboarding' });
    await startTenantContainer('t_sm2', {
      FAKE_TENANT_HEALTH_AFTER_MS: '0',
      FAKE_TENANT_PHASES: 'migrating:60000',
      FAKE_TENANT_EXIT_AFTER_MS: '150',
    });
    const poller = makePoller(db);
    poller.start();
    try {
      await waitFor(async () => {
        const row = db.prepare("SELECT status, last_error FROM tenants WHERE id = 't_sm2'").get() as
          | { status: string; last_error: string | null }
          | undefined;
        return row?.status === 'failed' ? row : null;
      }, 10_000);
      const failedRow2 = db.prepare("SELECT last_error FROM tenants WHERE id = 't_sm2'").get() as {
        last_error: string;
      };
      assert.match(failedRow2.last_error, /exited/);
      await waitFor(async () => (sink.messages.some((m) => m.includes('t_sm2')) ? true : null));
    } finally {
      await poller.stop();
    }
  });

  test('a tenant walking a degraded script lands on degraded with versions persisted', async () => {
    seedUserAndTenant(db, { userId: 'u_sm3', phone: '+8613900003003', tenantId: 't_sm3', status: 'booting' });
    await startTenantContainer('t_sm3', {
      FAKE_TENANT_HEALTH_AFTER_MS: '0',
      FAKE_TENANT_PHASES: 'migrating:40,degraded:0',
    });
    const poller = makePoller(db);
    poller.start();
    try {
      await waitFor(async () => {
        const row = db.prepare("SELECT status FROM tenants WHERE id = 't_sm3'").get() as { status: string } | undefined;
        return row?.status === 'degraded' ? row : null;
      }, 10_000);
      const row = db.prepare("SELECT status, last_error, app_version FROM tenants WHERE id = 't_sm3'").get() as {
        status: string;
        last_error: string | null;
        app_version: string | null;
      };
      assert.equal(row.status, 'degraded');
      assert.equal(row.last_error, null);
      assert.equal(row.app_version, '0.12.0');
    } finally {
      await poller.stop();
    }
  });
});
