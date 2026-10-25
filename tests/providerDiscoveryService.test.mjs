import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadProviderDiscoveryService() {
  try {
    return require('../dist-electron/main/services/providerDiscoveryService.js');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require('../dist-electron/main/services/providerDiscoveryService.js');
  }
}

function createPresenceStub(statuses = {}, options = {}) {
  return {
    statusCalls: [],
    async fetchOnlineStatus(globalMetaIds) {
      this.statusCalls.push([...globalMetaIds]);
      if (options.fail) {
        throw new Error(options.fail);
      }
      return {
        total: globalMetaIds.length,
        onlineCount: globalMetaIds.filter((id) => statuses[id]?.isOnline).length,
        list: globalMetaIds.map((id) => ({
          globalMetaId: id,
          isOnline: Boolean(statuses[id]?.isOnline),
          lastSeenAt: statuses[id]?.lastSeenAt ?? 0,
          lastSeenAgoSeconds: statuses[id]?.lastSeenAgoSeconds ?? 0,
          deviceCount: statuses[id]?.deviceCount ?? 0,
        })),
      };
    },
  };
}

test('provider discovery queries idchat online-status for unique service provider globalMetaIds', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({
    idq1providera: { isOnline: true, lastSeenAt: 171000, deviceCount: 2 },
  });
  const service = new ProviderDiscoveryService({
    presence,
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: ' IDQ1ProviderA ', providerAddress: 'mvc-a', serviceName: 'alpha' },
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a2', serviceName: 'alpha copy' },
    { providerGlobalMetaId: 'idq1providerb', providerAddress: 'mvc-b', serviceName: 'bravo' },
  ]);
  presence.statusCalls.length = 0;
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(presence.statusCalls, [['idq1providera', 'idq1providerb']]);
  assert.deepEqual(snapshot.onlineBots, { idq1providera: 171 });
  assert.deepEqual(snapshot.availableServices.map((entry) => entry.serviceName), ['alpha', 'alpha copy']);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, true);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].lastSource, 'idchat');
  assert.equal(snapshot.providers['idq1providerb::mvc-b'].online, false);
});

test('provider discovery marks providers offline when idchat online-status fails', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({}, { fail: 'idchat unavailable' });
  const service = new ProviderDiscoveryService({
    presence,
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
    { providerGlobalMetaId: 'idq1providerb', providerAddress: 'mvc-b', serviceName: 'bravo' },
  ]);
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, false);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].lastError, 'online_status_failed');
  assert.equal(snapshot.providers['idq1providerb::mvc-b'].online, false);
});

test('provider discovery keeps provider offline when idchat says provider is offline', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({
    idq1providera: { isOnline: false, lastSeenAt: 199000, deviceCount: 0 },
  });
  const service = new ProviderDiscoveryService({
    presence,
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].lastSource, 'idchat');
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, false);
});

test('provider discovery treats provider without globalMetaId as offline without idchat lookup', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub();
  const service = new ProviderDiscoveryService({
    presence,
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerAddress: 'mvc-missing', serviceName: 'missing id' },
  ]);
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(presence.statusCalls, []);
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['::mvc-missing'].online, false);
  assert.equal(snapshot.providers['::mvc-missing'].lastError, 'missing_global_metaid');
});

test('provider discovery keeps ping-failed provider offline until explicitly cleared', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({
    idq1providera: { isOnline: true, lastSeenAt: 171000, deviceCount: 1 },
  });
  const service = new ProviderDiscoveryService({
    presence,
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);
  await service.refreshNow();
  assert.deepEqual(service.getDiscoverySnapshot().onlineBots, { idq1providera: 171 });

  service.markOffline('idq1providera');
  await service.refreshNow();
  let snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].lastError, 'locally_disabled');

  service.clearForceOffline('idq1providera');
  await service.refreshNow();
  snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, { idq1providera: 171 });
  assert.equal(snapshot.availableServices.length, 1);
});

test('provider discovery only emits on material changes unless rebroadcast is requested', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({
    idq1providera: { isOnline: true, lastSeenAt: 111000, deviceCount: 1 },
  });
  const service = new ProviderDiscoveryService({
    presence,
    now: () => 140_000,
  });

  const snapshots = [];
  service.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);

  await service.refreshNow();
  await service.refreshNow();
  await service.refreshNow({ rebroadcast: true });

  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0], snapshots[1]);
});

test('ProviderDiscoveryService forwards polling refresh errors to caller', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const wasmError = new WebAssembly.RuntimeError('memory access out of bounds');
  let handledError = null;
  let handledPhase = null;

  const handled = new Promise((resolve) => {
    const service = new ProviderDiscoveryService({
      presence: {
        fetchOnlineStatus: async () => ({ list: [] }),
      },
      now: () => 1_700_000_000_000,
    });

    service.startPolling(
      () => {
        throw wasmError;
      },
      {
        onRefreshError: (error, phase) => {
          handledError = error;
          handledPhase = phase;
          service.dispose();
          resolve();
        },
      },
    );
  });

  await handled;

  assert.equal(handledError, wasmError);
  assert.equal(handledPhase, 'initial');
});

test('ProviderDiscoveryService waitForRefresh waits for an active refresh', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  let releasePresence;
  let waitSettled = false;
  const service = new ProviderDiscoveryService({
    presence: {
      fetchOnlineStatus: async () => {
        await new Promise((resolve) => {
          releasePresence = resolve;
        });
        return {
          list: [{ globalMetaId: 'meta-1', isOnline: true, lastSeenAt: 1_700_000_000_000 }],
        };
      },
    },
    now: () => 1_700_000_000_000,
  });

  service.startPolling(() => [
    {
      providerGlobalMetaId: 'meta-1',
      providerAddress: 'addr-1',
      status: 1,
      available: 1,
    },
  ]);

  await new Promise((resolve) => setImmediate(resolve));
  const waitPromise = service.waitForRefresh().then(() => {
    waitSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waitSettled, false);

  releasePresence();
  await waitPromise;
  service.dispose();

  assert.equal(waitSettled, true);
  assert.equal(service.getDiscoverySnapshot().availableServices.length, 1);
});

test('refreshNowIfStale skips a network refresh when the snapshot is younger than 10s', async () => {
  const { DISCOVERY_SNAPSHOT_MIN_AGE_MS, ProviderDiscoveryService } = loadProviderDiscoveryService();
  let nowMs = 200_000;
  const presence = createPresenceStub({
    idq1providera: { isOnline: true, lastSeenAt: 171000, deviceCount: 1 },
  });
  const service = new ProviderDiscoveryService({
    presence,
    now: () => nowMs,
  });
  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);
  await service.refreshNow();
  const afterFirst = presence.statusCalls.length;

  nowMs += DISCOVERY_SNAPSHOT_MIN_AGE_MS - 1;
  const refreshed = await service.refreshNowIfStale();
  assert.equal(refreshed, false);
  assert.equal(presence.statusCalls.length, afterFirst);
  service.dispose();
});

test('refreshNowIfStale refreshes when the snapshot is missing or at least 10s old', async () => {
  const { DISCOVERY_SNAPSHOT_MIN_AGE_MS, ProviderDiscoveryService } = loadProviderDiscoveryService();
  let nowMs = 200_000;
  const presence = createPresenceStub({
    idq1providera: { isOnline: true, lastSeenAt: 171000, deviceCount: 1 },
  });
  const neverRefreshed = new ProviderDiscoveryService({
    presence,
    now: () => nowMs,
  });
  assert.equal(neverRefreshed.getLastRefreshAtMs(), null);
  assert.equal(await neverRefreshed.refreshNowIfStale(), true);
  assert.equal(neverRefreshed.getLastRefreshAtMs(), nowMs);
  neverRefreshed.dispose();

  const service = new ProviderDiscoveryService({
    presence,
    now: () => nowMs,
  });
  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);
  await service.waitForRefresh();
  presence.statusCalls.length = 0;

  nowMs += DISCOVERY_SNAPSHOT_MIN_AGE_MS;
  const refreshed = await service.refreshNowIfStale();
  assert.equal(refreshed, true);
  assert.equal(presence.statusCalls.length, 1);
  assert.equal(service.getLastRefreshAtMs(), nowMs);
  service.dispose();
});

// ── issue #24: online-status poll backoff (ladder + circuit breaker) ─────────

const { PollBackoffController } = require('../dist-electron/main/services/pollBackoffController.js');

const makeBackoffDiscovery = (failModeRef) => {
  const clock = { value: 1_790_000_000_000 };
  const logs = [];
  const presence = {
    statusCalls: 0,
    async fetchOnlineStatus(globalMetaIds) {
      this.statusCalls += 1;
      if (failModeRef.value) throw new Error(failModeRef.value);
      return {
        total: globalMetaIds.length,
        onlineCount: 0,
        list: globalMetaIds.map((id) => ({
          globalMetaId: id, isOnline: false, lastSeenAt: 0, lastSeenAgoSeconds: 0, deviceCount: 0,
        })),
      };
    },
  };
  const backoff = new PollBackoffController({
    name: 'test-provider-discovery',
    baseMs: 10_000,
    now: () => clock.value,
    random: () => 0.5,
    emitLog: (line) => logs.push(line),
  });
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const service = new ProviderDiscoveryService({ presence, now: () => clock.value, backoff });
  const getServices = () => [
    { providerGlobalMetaId: 'idq1providerissue24', providerAddress: 'mvc-x', serviceName: 'svc' },
  ];
  return { service, presence, backoff, clock, logs, getServices };
};

test('issue #24: online-status failures escalate the ladder, open the circuit, and recover via a probe', async () => {
  const failMode = { value: 'timeout' };
  const h = makeBackoffDiscovery(failMode);
  try {
    // install the service list (the immediate 'initial' tick is failure #1)
    h.service.startPolling(h.getServices);
    await h.service.waitForRefresh();
    const delays = [h.backoff.nextDelayMs()];
    h.clock.value += h.backoff.nextDelayMs() + 1;
    for (let i = 2; i <= 4; i += 1) {
      await h.service.refreshNow();
      delays.push(h.backoff.nextDelayMs());
      h.clock.value += h.backoff.nextDelayMs() + 1;
    }
    assert.deepEqual(delays, [20_000, 40_000, 80_000, 160_000], 'base 10s ladder: 20/40/80/160s');
    const backingOff = h.logs.filter((l) => l.includes('[PollBackoff:test-provider-discovery]') && l.includes('backing off after failure #'));
    assert.equal(backingOff.length, 4, 'each failing refresh logs a backing-off line');

    // 5th failure opens the circuit (default threshold 5)
    await h.service.refreshNow();
    await h.service.waitForRefresh();
    assert.equal(h.backoff.getState().circuit, 'open');
    assert.ok(h.logs.some((l) => l.includes('circuit OPEN')), 'circuit OPEN logged');

    // past the cooldown the controller allows exactly one half-open probe;
    // the outage ends right before it, so the probe succeeds and closes
    failMode.value = null;
    h.clock.value += 600_000;
    assert.equal(h.backoff.ready(), true);
    assert.equal(h.backoff.getState().circuit, 'half-open');
    await h.service.refreshNow();
    assert.equal(h.backoff.getState().circuit, 'closed');
    assert.equal(h.backoff.nextDelayMs(), 10_000, 'base cadence restored');
    assert.ok(h.logs.some((l) => l.includes('recovered — resuming normal cadence')), 'recovery logged');
  } finally {
    h.service.dispose();
  }
});

test('issue #24: a refresh with no provider ids records nothing (no network attempted)', async () => {
  const failMode = { value: 'timeout' };
  const h = makeBackoffDiscovery(failMode);
  try {
    await h.service.refreshNow();
    assert.equal(h.backoff.getState().consecutiveFailures, 0, 'no ids -> no attempt -> no failure');
    assert.equal(h.presence.statusCalls, 0);
  } finally {
    h.service.dispose();
  }
});
