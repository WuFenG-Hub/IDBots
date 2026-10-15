// RRSI P3 — usage evidence storage (Task 1) and the usage-audit pass (Task 3).
//
// Storage section: the shared hot-layer usage stats query, DreamStore read /
// write methods over hot_layer_usage, and the capability-draft dormant field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { getSqlJs, createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const {
  queryHotLayerUsageStats,
} = require('../dist-electron/main/libs/hotLayerUsageQueries.js');

// ---------------------------------------------------------------------------
// Usage stats (RRSI P3 Task 1)
// ---------------------------------------------------------------------------

/** Seed one hot_layer_usage row; audited=audited_at ms (null = never audited). */
function seedUsage(db, { date, kind, id, exposure, applied, audited, count = 1, bot = 5 }) {
  db.run(
    `INSERT INTO hot_layer_usage (
       metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count, applied, evidence, audited_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bot, date, kind, id, exposure, 1_000, count, applied, applied === null ? null : '{"labels":[],"channels":[]}', audited],
  );
}

/** Six dates D1..D6 with a mix of hot/recall, audited/unaudited, applied 1/0/NULL. */
function seedSixDays(db) {
  // technique 7: applied on 2 nights (one hot, one recall), 3 audited hot nights.
  seedUsage(db, { date: '2026-08-25', kind: 'technique', id: '7', exposure: 'hot', applied: 1, audited: 1_000 });
  seedUsage(db, { date: '2026-08-26', kind: 'technique', id: '7', exposure: 'hot', applied: 0, audited: 2_000 });
  seedUsage(db, { date: '2026-08-27', kind: 'technique', id: '7', exposure: 'recall', applied: 1, audited: 3_000 });
  seedUsage(db, { date: '2026-08-28', kind: 'technique', id: '7', exposure: 'hot', applied: null, audited: null });
  seedUsage(db, { date: '2026-08-29', kind: 'technique', id: '7', exposure: 'recall', applied: null, audited: null });
  seedUsage(db, { date: '2026-08-30', kind: 'technique', id: '7', exposure: 'hot', applied: null, audited: 6_000 });
  // procedure proc-1: audited hot on 3 nights, never applied.
  seedUsage(db, { date: '2026-08-25', kind: 'procedure', id: 'proc-1', exposure: 'hot', applied: 0, audited: 1_000 });
  seedUsage(db, { date: '2026-08-27', kind: 'procedure', id: 'proc-1', exposure: 'hot', applied: 0, audited: 3_000 });
  seedUsage(db, { date: '2026-08-29', kind: 'procedure', id: 'proc-1', exposure: 'hot', applied: 0, audited: 5_000 });
}

test('usage stats: applied counts hot and recall, exposed counts audited hot only', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedSixDays(db);
    const dreamStore = new DreamStore(db, () => {});
    const stats = dreamStore.listHotLayerUsageStats(5, {
      kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30',
    });
    assert.deepEqual(stats.get('7'), { itemId: '7', appliedNights: 2, exposedNights: 3, auditedNights: 4 });
    const procedureStats = dreamStore.listHotLayerUsageStats(5, {
      kind: 'procedure', sinceDate: '2026-08-25', untilDate: '2026-08-30',
    });
    assert.deepEqual(procedureStats.get('proc-1'), { itemId: 'proc-1', appliedNights: 0, exposedNights: 3, auditedNights: 3 });
    // The pure helper agrees with the store method.
    const direct = queryHotLayerUsageStats(db, {
      metabotId: 5, kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30',
    });
    assert.deepEqual(direct.get('7'), stats.get('7'));
  } finally {
    cleanup();
  }
});

test('usage stats: date bounds are inclusive and the itemIds filter works', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedSixDays(db);
    const dreamStore = new DreamStore(db, () => {});
    const inner = dreamStore.listHotLayerUsageStats(5, {
      kind: 'technique', sinceDate: '2026-08-26', untilDate: '2026-08-29',
    });
    assert.deepEqual(inner.get('7'), { itemId: '7', appliedNights: 1, exposedNights: 1, auditedNights: 2 });
    const filtered = dreamStore.listHotLayerUsageStats(5, {
      kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30', itemIds: ['7', '999'],
    });
    assert.ok(filtered.has('7'));
    assert.ok(!filtered.has('999'), 'items without rows never appear');
    const empty = dreamStore.listHotLayerUsageStats(5, {
      kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30', itemIds: [],
    });
    assert.equal(empty.size, 0, 'an empty itemIds list skips the query entirely');
  } finally {
    cleanup();
  }
});

test('usage stats: a database without the table returns an empty map', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  try {
    const stats = queryHotLayerUsageStats(db, {
      metabotId: 5, kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30',
    });
    assert.equal(stats.size, 0);
  } finally {
    db.close();
  }
});

test('listHotLayerExposures orders hot first, then exposure_count, kind, id', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedUsage(db, { date: '2026-08-26', kind: 'procedure', id: 'p-b', exposure: 'hot', applied: null, audited: null, count: 3 });
    seedUsage(db, { date: '2026-08-26', kind: 'technique', id: '7', exposure: 'hot', applied: null, audited: null, count: 1 });
    seedUsage(db, { date: '2026-08-26', kind: 'procedure', id: 'p-a', exposure: 'hot', applied: null, audited: null, count: 5 });
    seedUsage(db, { date: '2026-08-26', kind: 'procedure', id: 'p-c', exposure: 'recall', applied: null, audited: null, count: 9 });
    const dreamStore = new DreamStore(db, () => {});
    const rows = dreamStore.listHotLayerExposures(5, '2026-08-26');
    assert.deepEqual(rows.map((row) => `${row.kind}:${row.itemId}`), [
      'procedure:p-a',
      'procedure:p-b',
      'technique:7',
      'procedure:p-c',
    ]);
    assert.deepEqual(rows[0], {
      kind: 'procedure', itemId: 'p-a', exposure: 'hot', exposureCount: 5, applied: null, auditedAt: null,
    });
    assert.deepEqual(dreamStore.listHotLayerExposures(5, '2026-08-27'), [], 'other dates stay out');
  } finally {
    cleanup();
  }
});

test('recordHotLayerUsageVerdicts writes evidence JSON and a re-run overwrites', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedUsage(db, { date: '2026-08-26', kind: 'technique', id: '7', exposure: 'hot', applied: null, audited: null });
    seedUsage(db, { date: '2026-08-26', kind: 'procedure', id: 'proc-1', exposure: 'hot', applied: null, audited: null });
    const dreamStore = new DreamStore(db, () => {});
    const changed = dreamStore.recordHotLayerUsageVerdicts(5, '2026-08-26', [
      { kind: 'technique', itemId: '7', applied: true, evidence: { labels: ['S1.M2'], channels: ['owner'] } },
      { kind: 'procedure', itemId: 'proc-1', applied: false, evidence: { labels: [], channels: [] } },
    ], 42_000);
    assert.equal(changed, 2);
    const technique = getRow(db, "SELECT applied, evidence, audited_at FROM hot_layer_usage WHERE item_id = '7'");
    assert.equal(technique.applied, 1);
    assert.equal(technique.audited_at, 42_000);
    assert.equal(technique.evidence, '{"labels":["S1.M2"],"channels":["owner"]}');
    const procedure = getRow(db, "SELECT applied, evidence, audited_at FROM hot_layer_usage WHERE item_id = 'proc-1'");
    assert.equal(procedure.applied, 0);
    assert.equal(procedure.audited_at, 42_000);

    const rewritten = dreamStore.recordHotLayerUsageVerdicts(5, '2026-08-26', [
      { kind: 'technique', itemId: '7', applied: false, evidence: { labels: [], channels: [] } },
    ], 84_000);
    assert.equal(rewritten, 1, 'a re-audit only rewrites rows that exist');
    const after = getRow(db, "SELECT applied, evidence, audited_at FROM hot_layer_usage WHERE item_id = '7'");
    assert.equal(after.applied, 0);
    assert.equal(after.evidence, '{"labels":[],"channels":[]}');
    assert.equal(after.audited_at, 84_000, 'the second call overwrites the first');
  } finally {
    cleanup();
  }
});

test('getCapabilityDraft returns the row with dormantAt null for pre-P3 drafts', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '旧技巧', description: 'd', capabilityType: 'workflow' },
    ]);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    const loaded = coworkStore.getCapabilityDraft(5, draft.id);
    assert.ok(loaded, 'the bot owns the row');
    assert.equal(loaded.id, draft.id);
    assert.equal(loaded.dormantAt, null, 'pre-P3 rows read back dormant-free');
    assert.equal(coworkStore.getCapabilityDraft(6, draft.id), null, 'another bot gets null');
    assert.equal(coworkStore.getCapabilityDraft(5, 999_999), null, 'a missing row is null');
  } finally {
    cleanup();
  }
});
