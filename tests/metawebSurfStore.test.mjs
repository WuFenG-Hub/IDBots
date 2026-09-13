import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js');
const {
  MetawebSurfStore,
  ensureMetawebSurfSchema,
  emptySurfRunStats,
  SURF_SEEN_MAX_ROWS_PER_BOT,
} = await import('../dist-electron/main/metawebSurfStore.js');

const setup = () => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new MetawebSurfStore(db, () => {});
  return { db, store };
};

const NOW = '2026-09-13T01:00:00.000Z';

test('schema creation is idempotent', () => {
  const { db } = setup();
  ensureMetawebSurfSchema(db);
  ensureMetawebSurfSchema(db);
});

test('run lifecycle: create running, finish done with stats and report', () => {
  const { store } = setup();
  const run = store.createRun({ id: 'run-1', metabotId: 7, trigger: 'pre-dream', nowIso: NOW });
  assert.equal(run.status, 'running');
  assert.equal(run.trigger, 'pre-dream');

  const stats = { ...emptySurfRunStats(), fetched: 12, savedToKb: 3, liked: 2 };
  store.finishRun('run-1', {
    status: 'done',
    stats,
    reportMarkdown: '# Surf report',
    reportJson: '{"learned":3}',
    finishedAtIso: '2026-09-13T01:20:00.000Z',
  });
  const finished = store.getRun('run-1');
  assert.equal(finished.status, 'done');
  assert.equal(finished.stats.fetched, 12);
  assert.equal(finished.stats.savedToKb, 3);
  assert.equal(finished.reportMarkdown, '# Surf report');
  assert.equal(store.getLatestFinishedRun(7).id, 'run-1');
  assert.equal(store.getLatestFinishedRun(8), null);
});

test('listRunsByMetabot is newest first and capped', () => {
  const { store } = setup();
  for (let i = 0; i < 5; i += 1) {
    store.createRun({
      id: `run-${i}`,
      metabotId: 7,
      trigger: 'manual-ui',
      nowIso: `2026-09-1${i}T01:00:00.000Z`,
    });
  }
  const runs = store.listRunsByMetabot(7, 3);
  assert.equal(runs.length, 3);
  assert.equal(runs[0].id, 'run-4');
});

test('stale running runs fail on crash recovery', () => {
  const { store } = setup();
  store.createRun({ id: 'run-live', metabotId: 7, trigger: 'manual-chat', nowIso: NOW });
  store.createRun({ id: 'run-stale', metabotId: 7, trigger: 'manual-chat', nowIso: NOW });
  const recovered = store.failStaleRunningRuns({
    error: 'process restarted',
    nowIso: '2026-09-13T02:00:00.000Z',
    excludeId: 'run-live',
  });
  assert.equal(recovered, 1);
  assert.equal(store.getRun('run-stale').status, 'failed');
  assert.equal(store.getRun('run-live').status, 'running');
});

test('protocol watermark advances but never rewinds', () => {
  const { store } = setup();
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 1000, lastPinId: 'pin-a', nowIso: NOW });
  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 500, lastPinId: 'pin-old', nowIso: NOW });
  let state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.lastSeenTs, 1000);

  store.advanceProtocolState(7, 'simplebuzz', { lastSeenTs: 2000, lastPinId: 'pin-b', nowIso: NOW });
  state = store.getProtocolState(7, 'simplebuzz');
  assert.equal(state.lastSeenTs, 2000);
  assert.equal(state.lastPinId, 'pin-b');
  assert.equal(store.listProtocolStates(7).length, 1);
});

test('seen ledger upgrades to the strongest action and filters unseen', () => {
  const { store } = setup();
  store.markSeen(7, 'pin-1', 'presented', NOW);
  store.markSeen(7, 'pin-1', 'read', NOW);
  store.markSeen(7, 'pin-1', 'presented', NOW);
  assert.equal(store.getSeenAction(7, 'pin-1'), 'read');

  store.markSeen(7, 'pin-2', 'liked', NOW);
  store.markSeen(7, 'pin-2', 'read', NOW);
  assert.equal(store.getSeenAction(7, 'pin-2'), 'liked', 'interaction must not downgrade to read');

  const unseen = store.filterUnseen(7, ['pin-1', 'pin-2', 'pin-3', '']);
  assert.deepEqual(unseen, ['pin-3']);
});

test('seen ledger prunes by retention window and per-bot cap', () => {
  const { store } = setup();
  store.markSeen(7, 'pin-old', 'read', '2026-01-01T00:00:00.000Z');
  store.markSeen(7, 'pin-new', 'read', NOW);
  store.pruneSeenPins(7, NOW);
  assert.equal(store.getSeenAction(7, 'pin-old'), null, 'older than retention window');
  assert.equal(store.getSeenAction(7, 'pin-new'), 'read');

  for (let i = 0; i < SURF_SEEN_MAX_ROWS_PER_BOT + 10; i += 1) {
    store.markSeen(9, `bulk-${i}`, 'presented', `2026-09-13T02:${String(i % 60).padStart(2, '0')}:00.000Z`);
  }
  store.pruneSeenPins(9, NOW);
  const remaining = store.filterUnseen(9, Array.from({ length: SURF_SEEN_MAX_ROWS_PER_BOT + 10 }, (_, i) => `bulk-${i}`));
  assert.equal(remaining.length, 10, 'oldest 10 pruned, cap holds');
});

test('markSeenBatch writes a run batch with strongest-action-wins and one save', () => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  let saves = 0;
  const store = new MetawebSurfStore(db, () => { saves += 1; });

  saves = 0;
  store.markSeenBatch(7, [
    { pinId: 'pin-1', action: 'presented' },
    { pinId: 'pin-1', action: 'liked' },
    { pinId: 'pin-2', action: 'presented' },
    { pinId: ' pin-3 ', action: 'read' },
    { pinId: '', action: 'presented' },
  ], NOW);
  assert.equal(store.getSeenAction(7, 'pin-1'), 'liked', 'strongest action inside the batch wins');
  assert.equal(store.getSeenAction(7, 'pin-2'), 'presented');
  assert.equal(store.getSeenAction(7, 'pin-3'), 'read', 'pin ids are trimmed');
  assert.equal(saves, 1, 'the whole batch persists with a single saveDb');

  saves = 0;
  store.markSeenBatch(7, [
    { pinId: 'pin-1', action: 'read' },
    { pinId: 'pin-2', action: 'saved' },
  ], NOW);
  assert.equal(store.getSeenAction(7, 'pin-1'), 'liked', 'batch never downgrades a stored action');
  assert.equal(store.getSeenAction(7, 'pin-2'), 'saved');
  assert.equal(saves, 1, 'still one save even when only some rows change');

  saves = 0;
  store.markSeenBatch(7, [{ pinId: 'pin-1', action: 'presented' }], NOW);
  assert.equal(saves, 0, 'a no-op batch skips the save entirely');
  store.markSeenBatch(7, [], NOW);
  assert.equal(saves, 0);
});
