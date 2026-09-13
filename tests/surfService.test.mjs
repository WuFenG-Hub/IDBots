import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js');
const { MetawebSurfStore } = await import('../dist-electron/main/metawebSurfStore.js');
const { SurfService } = await import('../dist-electron/main/services/surfService.js');

const NOW_MS = Date.parse('2026-09-13T01:00:00.000Z');
const NOW_SEC = Math.floor(NOW_MS / 1000);

const makeItem = (pinId, createdAt, protocolKey = 'alpha') => ({
  pinId,
  protocolKey,
  chainName: 'mvc',
  title: `Title ${pinId}`,
  summary: '',
  authorName: '',
  authorGlobalMetaId: 'idq-test',
  createdAt,
  likeCount: null,
  commentCount: null,
  extra: null,
});

const setup = (registry) => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new MetawebSurfStore(db, () => {});
  const events = [];
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: (id) => (id === 7 ? { id: 7, name: 'Tester' } : null),
      getMetabotSetting: () => null,
    },
    broadcast: (payload) => events.push(payload),
    registry,
    nowMs: () => NOW_MS,
  });
  return { store, service, events };
};

const alphaDescriptor = (items) => ({
  key: 'alpha',
  displayName: 'Fake alpha',
  paths: ['/protocols/alpha'],
  interactions: ['like'],
  relevanceHint: 'hint',
  fetchFresh: async () => items,
});

test('digest-only run: report written, watermark advanced, events broadcast', async () => {
  const { store, service, events } = setup([alphaDescriptor([makeItem('pin-a', NOW_SEC - 100), makeItem('pin-b', NOW_SEC - 50)])]);
  const run = await service.runSurfAndWait(7, 'manual-ui');

  assert.equal(run.status, 'done');
  assert.equal(run.stats.fetched, 2);
  assert.match(run.reportMarkdown, /# Surf digest/);
  assert.match(run.reportMarkdown, /pin-a/);

  const state = store.getProtocolState(7, 'alpha');
  assert.equal(state.lastSeenTs, NOW_SEC - 50, 'watermark advanced to newest fetched');

  assert.deepEqual(events.map((e) => e.status), ['running', 'done']);
  assert.equal(events[0].trigger, 'manual-ui');
});

test('second surf finds nothing new (watermark + seen ledger)', async () => {
  const { service } = setup([alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])]);
  await service.runSurfAndWait(7, 'manual-ui');
  const second = await service.runSurfAndWait(7, 'pre-dream');
  assert.equal(second.status, 'done');
  assert.equal(second.stats.fetched, 0);
});

test('failed protocol fetch keeps its watermark for retry', async () => {
  const failing = {
    key: 'broken',
    displayName: 'Broken',
    paths: ['/protocols/broken'],
    interactions: ['like'],
    relevanceHint: 'hint',
    fetchFresh: async () => { throw new Error('boom'); },
  };
  const { store, service } = setup([failing]);
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'done', 'protocol failure is a section error, not a run failure');
  assert.equal(store.getProtocolState(7, 'broken'), null);
});

test('per-bot mutex: a second start while running throws', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = {
    key: 'slow',
    displayName: 'Slow',
    paths: ['/protocols/slow'],
    interactions: ['like'],
    relevanceHint: 'hint',
    fetchFresh: () => gate.then(() => []),
  };
  const { service } = setup([slow]);
  service.startSurf(7, 'manual-ui');
  assert.throws(() => service.startSurf(7, 'manual-ui'), /already in progress/);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotThrow(() => service.startSurf(7, 'manual-ui'));
});

test('unknown bot is rejected', async () => {
  const { service } = setup([]);
  await assert.rejects(() => service.runSurfAndWait(9, 'manual-ui'), /not found/);
});

test('memory-disabled bot is rejected loudly before any run row exists (P2.2)', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    isMemoryEnabled: () => false,
    nowMs: () => NOW_MS,
  });
  assert.throws(() => service.startSurf(7, 'manual-ui'), /Memory is disabled/);
  await assert.rejects(() => service.runSurfAndWait(7, 'pre-dream'), /Memory is disabled/);
  assert.equal(store.listRunsByMetabot(7).length, 0, 'no orphan run row was created');
  assert.equal(store.getSeenAction(7, 'pin-a'), null, 'nothing was presented');
  assert.equal(service.shouldPreDreamSurf(7), false, 'pre-dream path skips quietly when memory is off');
});

test('injected session overrides digest stats and prepends its report', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    runSurfSession: async () => ({
      stats: { savedToKb: 1, liked: 2 },
      reportMarkdown: '# Session report',
      reportJson: '{"liked":2}',
    }),
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.stats.fetched, 1);
  assert.equal(run.stats.savedToKb, 1);
  assert.equal(run.stats.liked, 2);
  assert.match(run.reportMarkdown, /^# Session report/);
  assert.match(run.reportMarkdown, /# Surf digest/);
  assert.equal(run.reportJson, '{"liked":2}');
});

test('session failure fails the run without advancing watermarks', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const service = new SurfService({
    store,
    metabotStore: {
      getMetabotById: () => ({ id: 7, name: 'Tester' }),
      getMetabotSetting: () => null,
    },
    broadcast: () => {},
    registry: [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100)])],
    runSurfSession: async () => { throw new Error('llm down'); },
    nowMs: () => NOW_MS,
  });
  const run = await service.runSurfAndWait(7, 'manual-ui');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /llm down/);
  assert.equal(store.getProtocolState(7, 'alpha'), null);
});

test('a failed run re-presents the same window on the next surf (P1 regression)', async () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  const metabotStore = {
    getMetabotById: () => ({ id: 7, name: 'Tester' }),
    getMetabotSetting: () => null,
  };
  const registry = [alphaDescriptor([makeItem('pin-a', NOW_SEC - 100), makeItem('pin-b', NOW_SEC - 50)])];
  const failing = new SurfService({
    store,
    metabotStore,
    broadcast: () => {},
    registry,
    runSurfSession: async () => { throw new Error('llm down'); },
    nowMs: () => NOW_MS,
  });
  const failed = await failing.runSurfAndWait(7, 'manual-ui');
  assert.equal(failed.status, 'failed');
  assert.equal(store.getSeenAction(7, 'pin-a'), null, 'failed run must not mark pins presented');
  assert.equal(store.getSeenAction(7, 'pin-b'), null);

  const digestOnly = new SurfService({
    store,
    metabotStore,
    broadcast: () => {},
    registry,
    nowMs: () => NOW_MS,
  });
  const retry = await digestOnly.runSurfAndWait(7, 'pre-dream');
  assert.equal(retry.status, 'done');
  assert.equal(retry.stats.fetched, 2, 'the lost window is presented again after the failure');
  assert.match(retry.reportMarkdown, /pin-a/);
  assert.equal(store.getSeenAction(7, 'pin-a'), 'presented', 'success path marks presented');
  assert.equal(store.getProtocolState(7, 'alpha').lastSeenTs, NOW_SEC - 50);
});

test('crash recovery fails stale running rows', () => {
  const db = createNativeSqliteDatabase(':memory:');
  const store = new MetawebSurfStore(db, () => {});
  store.createRun({ id: 'stale-1', metabotId: 7, trigger: 'manual-ui', nowIso: '2026-09-12T01:00:00.000Z' });
  const service = new SurfService({
    store,
    metabotStore: { getMetabotById: () => null, getMetabotSetting: () => null },
    broadcast: () => {},
    registry: [],
    nowMs: () => NOW_MS,
  });
  assert.equal(service.recoverAfterRestart(), 1);
  assert.equal(store.getRun('stale-1').status, 'failed');
});
