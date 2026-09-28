import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetaTaskProjectionStore } = require('../dist-electron/main/services/metatask/projectionStore.js');
const { replayMetaTask } = require('../dist-electron/main/services/metatask/engine.js');

/**
 * MetaTask projection store (P1): additive idempotent migration + event cache
 * round-trip + projection persistence + board derivation (my-roles) + refresh
 * state transitions. The store is a rebuildable cache of the chain replay.
 */

const ev = (pinId, path, body, author = 'idq1somebot', height = 190_100) => ({
  pinId,
  path,
  author,
  height,
  txIndex: 0,
  timestampMs: 1_790_000_000_000,
  body,
});

const buildProjection = () => {
  const events = [
    ev('tree0000000001i0', 'tree', {
      root: 'r1',
      nodes: [
        { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 5000 },
        { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 5000 },
      ],
    }, 'idq1publisherx'),
    ev('task0000000001i0', 'task', {
      title: 'store test task',
      treeid: 'tree0000000001i0',
      policy: { verify_quorum: 2, claim_ttl_hours: 48, verify_window_hours: 72 },
      tags: ['metatask'],
    }, 'idq1publisherx'),
    ev('claim00000001i0', 'claim', { taskid: 'task0000000001i0', node: 't1' }, 'idq1workerbee'),
  ];
  return replayMetaTask(events, { rootPinId: 'task0000000001i0' });
};

async function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metatask-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new MetaTaskProjectionStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  return { dir, sqliteStore, store };
}

test('metatask projection store: idempotent migration', async () => {
  const { dir, sqliteStore, store } = await openStore();
  try {
    // Re-instantiate on the same database: tables already exist, no error.
    const again = new MetaTaskProjectionStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
    assert.ok(again);
  } finally {
    sqliteStore.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metatask projection store: event cache round-trip', async () => {
  const { dir, sqliteStore, store } = await openStore();
  try {
    const events = [
      ev('aaa0000000001i0', 'claim', { taskid: 't', node: 'n1' }, 'idq1a', 190_100),
      ev('aaa0000000002i0', 'verify', { targetid: 'x', verdict: 'pass', semantic_check: 'ok' }, 'idq1b', 190_101),
    ];
    store.upsertEvents(events);
    store.upsertEvents(events); // idempotent by pin_id
    const loaded = store.loadEvents();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].path, 'claim');
    assert.equal(loaded[0].body.node, 'n1');
  } finally {
    sqliteStore.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metatask projection store: projections persist and board derives my-roles', async () => {
  const { dir, sqliteStore, store } = await openStore();
  try {
    const projection = buildProjection();
    store.saveProjections([projection]);
    const loaded = store.getProjection(projection.rootPinId);
    assert.ok(loaded);
    assert.equal(loaded.title, 'store test task');
    assert.equal(loaded.nodeStates.t1.status, 'claimed');

    // The worker's roster marks the task as "participating"; a stranger's does not.
    const asWorker = store.board(['idq1workerbee']);
    assert.equal(asWorker.tasks.length, 1);
    assert.deepEqual(asWorker.tasks[0].myRoles, ['participant']);
    // Nothing verified yet: the mid-task estimate is 0 (not undefined).
    assert.equal(asWorker.tasks[0].myStats.estShareBP, 0);
    const asPublisher = store.board(['idq1publisherx']);
    assert.deepEqual(asPublisher.tasks[0].myRoles, ['publisher']);
    const asStranger = store.board(['idq1stranger']);
    assert.deepEqual(asStranger.tasks[0].myRoles, []);

    // Stale roots drop out on the next save.
    store.saveProjections([]);
    assert.equal(store.board([]).tasks.length, 0);
  } finally {
    sqliteStore.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metatask projection store: board activity uses the engine clock, not holder/submission stamps', async () => {
  const { dir, sqliteStore, store } = await openStore();
  try {
    const base = 1_790_000_000_000;
    const trace = (pinId, path, body, author, height, offsetMs) => ({
      ...ev(pinId, path, body, author, height),
      timestampMs: base + offsetMs,
    });
    const events = [
      trace(
        'tree0000000002i0',
        'tree',
        {
          root: 'r1',
          nodes: [
            { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 5000 },
            { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 5000 },
          ],
        },
        'idq1publisherx',
        190_100,
        0,
      ),
      trace(
        'task0000000002i0',
        'task',
        { title: 'actively reviewed', treeid: 'tree0000000002i0', policy: { verify_quorum: 1, claim_ttl_hours: 48, verify_window_hours: 72 } },
        'idq1publisherx',
        190_101,
        1_000,
      ),
      trace('claim00000002i0', 'claim', { taskid: 'task0000000002i0', node: 't1' }, 'idq1workerbee', 190_110, 60_000),
      trace(
        'submiss0000002i0',
        'submission',
        { taskid: 'task0000000002i0', node: 't1', claimid: 'claim00000002i0', result: { type: 'table' }, hash: '5'.repeat(64) },
        'idq1workerbee',
        190_111,
        120_000,
      ),
      trace(
        'verify00000002i0',
        'verify',
        { targetid: 'submiss0000002i0', verdict: 'pass', method: 'ran the spec', semantic_check: 'checked' },
        'idq1reviewerzz',
        190_120,
        600_000,
      ),
    ];
    const projection = replayMetaTask(events, { rootPinId: 'task0000000002i0' });
    assert.equal(projection.nodeStates.t1.status, 'verified');
    // The freshest task-scoped event is a VOTE: it is outside the
    // holder/submission scan, which is exactly how a freshly reviewed task used
    // to sort first while displaying "days ago".
    assert.equal(projection.lastActivityMs, base + 600_000);
    assert.ok(projection.lastActivityMs > projection.nodeStates.t1.submission.atMs);

    store.saveProjections([projection]);
    const board = store.board([]);
    assert.equal(board.tasks.length, 1);
    assert.equal(board.tasks[0].lastActivityMs, projection.lastActivityMs);
  } finally {
    sqliteStore.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metatask projection store: board myStats carries the mid-task estShareBP', async () => {
  const { dir, sqliteStore, store } = await openStore();
  try {
    const events = [
      ev('tree0000000003i0', 'tree', {
        root: 'r1',
        nodes: [
          { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 5000 },
          { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 5000 },
        ],
      }, 'idq1publisherx'),
      ev('task0000000003i0', 'task', {
        title: 'mid-task estimate',
        treeid: 'tree0000000003i0',
        policy: { verify_quorum: 1, claim_ttl_hours: 48, verify_window_hours: 72 },
        tags: ['metatask'],
      }, 'idq1publisherx'),
      ev('claim00000003i0', 'claim', { taskid: 'task0000000003i0', node: 't1' }, 'idq1workerbee'),
      ev('submiss0000003i0', 'submission', {
        taskid: 'task0000000003i0',
        node: 't1',
        claimid: 'claim00000003i0',
        result: { type: 'table' },
        hash: '6'.repeat(64),
      }, 'idq1workerbee'),
      ev('verify00000003i0', 'verify', {
        targetid: 'submiss0000003i0',
        verdict: 'pass',
        method: 'ran the spec',
        semantic_check: 'checked',
      }, 'idq1reviewerzz'),
    ];
    const projection = replayMetaTask(events, { rootPinId: 'task0000000003i0' });
    assert.equal(projection.nodeStates.t1.status, 'verified');
    assert.equal(projection.settlement, null, 'the root is still open, so nothing is settled');
    assert.equal('estimation' in projection, false, 'replay output never carries estimation');
    store.saveProjections([projection]);
    assert.equal('estimation' in (store.getProjection('task0000000003i0') ?? {}), false, 'estimation is never persisted');

    // t1 carries 5000bp: submitter floor(5000*8000/10000) = 4000, pool 1000 to
    // the single reviewer -> the whole roster estimates 5000.
    const both = store.board(['idq1workerbee', 'idq1reviewerzz']);
    assert.equal(both.tasks[0].myStats.estShareBP, 5000);
    assert.equal(both.tasks[0].myStats.shareBP, 0, 'shareBP stays 0 until a manifest exists');
    assert.equal(both.tasks[0].settlementFinalized, false);

    const workerOnly = store.board(['idq1workerbee']);
    assert.deepEqual(workerOnly.tasks[0].myRoles, ['participant']);
    assert.equal(workerOnly.tasks[0].myStats.estShareBP, 4000);
    assert.equal(workerOnly.tasks[0].myStats.verified, 1);

    // A roster with no recorded activity has no myStats at all (publisher-only
    // role is not participation).
    const publisherOnly = store.board(['idq1publisherx']);
    assert.deepEqual(publisherOnly.tasks[0].myRoles, ['publisher']);
    assert.equal(publisherOnly.tasks[0].myStats, null);
  } finally {
    sqliteStore.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metatask projection store: refresh state transitions', async () => {
  const { dir, sqliteStore, store } = await openStore();
  try {
    assert.equal(store.refreshInfo().refreshing, false);
    store.setRefreshing(true);
    assert.equal(store.refreshInfo().refreshing, true);
    store.markRefreshDone(true, null, 190_151);
    const info = store.refreshInfo();
    assert.equal(info.refreshing, false);
    assert.equal(info.boundaryBlock, 190_151);
    assert.equal(info.lastError, null);
    assert.ok(info.lastOkAtMs);
    const seq1 = store.bumpSeq();
    const seq2 = store.bumpSeq();
    assert.equal(seq2, seq1 + 1);
  } finally {
    sqliteStore.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
