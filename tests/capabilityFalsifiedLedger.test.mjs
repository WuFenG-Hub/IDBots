import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore, getColumns } from './memoryTestUtils.mjs';

const DAYMS = 86_400_000;

test('schema migration creates the falsified ledger idempotently', async () => {
  const { db, store, userDataPath, cleanup } = await createSqliteStore();
  try {
    const columns = getColumns(db, 'capability_falsified_hypotheses');
    for (const column of [
      'id', 'metabot_id', 'title', 'title_key', 'description', 'reason', 'source',
      'source_draft_id', 'falsified_at', 'hit_count', 'last_hit_at',
    ]) {
      assert.ok(columns.includes(column), `missing column ${column}`);
    }
    const coworkStore = createCoworkStore(db);
    const row = coworkStore.recordFalsifiedHypothesis({
      metabotId: 5, title: '先验证再交付', description: 'd', reason: 'r',
      source: 'validation', sourceDraftId: 1, falsifiedAt: 1000,
    });
    assert.ok(row);
    assert.doesNotThrow(() => store.initializeTables(userDataPath));
    assert.equal(coworkStore.listFalsifiedHypotheses(5).length, 1, 'existing rows survive re-migration');
  } finally {
    cleanup();
  }
});

test('record upserts by title key and keeps hit_count', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    const first = coworkStore.recordFalsifiedHypothesis({
      metabotId: 5, title: '先验证再交付', description: 'd1', reason: '第一次',
      source: 'validation', sourceDraftId: 1, falsifiedAt: 1000,
    });
    assert.ok(first);
    const second = coworkStore.recordFalsifiedHypothesis({
      metabotId: 5, title: ' 先验证、再交付 ', description: 'd2', reason: '第二次',
      source: 're_review', sourceDraftId: 2, falsifiedAt: 2000,
    });
    assert.ok(second);
    const rows = coworkStore.listFalsifiedHypotheses(5);
    assert.equal(rows.length, 1, 'same normalized title key upserts one row');
    assert.equal(rows[0].reason, '第二次');
    assert.equal(rows[0].description, 'd2');
    assert.equal(rows[0].source, 're_review');
    assert.equal(rows[0].falsifiedAt, 2000);
    assert.equal(rows[0].hitCount, 0, 're-falsification never resets hit_count');
    assert.equal(coworkStore.recordFalsifiedHypothesis({
      metabotId: 5, title: '   ', description: 'd', reason: 'r',
      source: 'validation', sourceDraftId: null, falsifiedAt: 3000,
    }), null, 'empty title records nothing');
  } finally {
    cleanup();
  }
});

test('source column is CHECK-constrained', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    assert.throws(() => {
      db.run(
        `INSERT INTO capability_falsified_hypotheses
         (metabot_id, title, title_key, description, reason, source, source_draft_id, falsified_at)
         VALUES (5, 't', 't', '', '', 'rollback', NULL, 1)`,
      );
    }, /CHECK|constraint/i);
  } finally {
    cleanup();
  }
});

test('list orders newest-first and honors the sinceMs window', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    for (const [title, at] of [['甲', 1000], ['乙', 3000], ['丙', 2000]]) {
      coworkStore.recordFalsifiedHypothesis({
        metabotId: 5, title, description: '', reason: '',
        source: 'validation', sourceDraftId: null, falsifiedAt: at,
      });
    }
    assert.deepEqual(
      coworkStore.listFalsifiedHypotheses(5).map((row) => row.title),
      ['乙', '丙', '甲'],
    );
    assert.deepEqual(
      coworkStore.listFalsifiedHypotheses(5, { sinceMs: 2000 }).map((row) => row.title),
      ['乙', '丙'],
    );
  } finally {
    cleanup();
  }
});

test('purge honors the cutoff, the per-bot cap and the exclusion set', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    const record = (metabotId, title, at) => coworkStore.recordFalsifiedHypothesis({
      metabotId, title, description: '', reason: '',
      source: 'validation', sourceDraftId: null, falsifiedAt: at,
    });
    record(5, '旧甲', 1000);
    record(5, '新甲', 5000);
    assert.equal(
      coworkStore.purgeFalsifiedHypotheses({ cutoffMs: 2000, maxPerBot: 200 }),
      1,
      'rows falsified before the cutoff drain',
    );
    assert.deepEqual(
      coworkStore.listFalsifiedHypotheses(5).map((row) => row.title),
      ['新甲'],
    );

    for (const at of [1, 2, 3, 4, 5]) {
      record(6, `技巧${at}`, at * 1000);
    }
    record(7, '别家', 999_999);
    assert.equal(
      coworkStore.purgeFalsifiedHypotheses({ cutoffMs: 0, maxPerBot: 3, excludeMetabotIds: new Set([7]) }),
      2,
      'the two oldest rows beyond the cap go; excluded bot untouched',
    );
    assert.equal(coworkStore.listFalsifiedHypotheses(6).length, 3);
    assert.equal(coworkStore.listFalsifiedHypotheses(7).length, 1);
  } finally {
    cleanup();
  }
});

test('checked insert skips duplicate live drafts (including within one batch)', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '先验证再交付', description: '交付前自检', capabilityType: 'workflow' },
    ]);
    const result = coworkStore.insertCapabilityDraftsChecked(5, '2026-08-02', [
      { title: '先验证再交付', description: '重复提案', capabilityType: 'workflow' },
      { title: '新技巧', description: '全新做法', capabilityType: 'skill' },
      { title: '新技巧', description: '批内重复', capabilityType: 'skill' },
    ], { nowMs: 200 * DAYMS });
    assert.deepEqual(
      { inserted: result.inserted, skippedDuplicate: result.skippedDuplicate, skippedFalsified: result.skippedFalsified },
      { inserted: 1, skippedDuplicate: 2, skippedFalsified: 0 },
    );
    assert.equal(result.insertedIds.length, 1);
    assert.equal(coworkStore.listCapabilityDrafts(5, { status: 'draft' }).length, 2);
  } finally {
    cleanup();
  }
});

test('checked insert blocks titles falsified within FALSIFIED_BLOCK_DAYS', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const nowMs = 100 * DAYMS;
  try {
    coworkStore.recordFalsifiedHypothesis({
      metabotId: 5, title: '深夜连环追问', description: '深夜连续追问进度', reason: '照做后被差评',
      source: 'validation', sourceDraftId: null, falsifiedAt: nowMs - 10 * DAYMS,
    });
    coworkStore.recordFalsifiedHypothesis({
      metabotId: 5, title: '过期的证伪', description: 'd', reason: 'r',
      source: 're_review', sourceDraftId: null, falsifiedAt: nowMs - 31 * DAYMS,
    });

    const blocked = coworkStore.insertCapabilityDraftsChecked(5, '2026-08-02', [
      { title: '深夜连环追问', description: '换个说法再来', capabilityType: 'skill' },
    ], { nowMs });
    assert.equal(blocked.skippedFalsified, 1);
    assert.equal(blocked.inserted, 0);
    const ledger = coworkStore.listFalsifiedHypotheses(5, { limit: 10 });
    const blockedRow = ledger.find((row) => row.title === '深夜连环追问');
    assert.equal(blockedRow.hitCount, 1, 'the blocked proposal bumps hit_count');
    assert.equal(blockedRow.lastHitAt, nowMs);

    const expired = coworkStore.insertCapabilityDraftsChecked(5, '2026-08-02', [
      { title: '过期的证伪', description: '超过封锁窗口', capabilityType: 'skill' },
    ], { nowMs });
    assert.equal(expired.inserted, 1, 'a ledger row older than the block window does not block');
    assert.equal(expired.skippedFalsified, 0);
  } finally {
    cleanup();
  }
});

test('rejected drafts are not live for the checked insert', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '已被否决', description: 'd', capabilityType: 'skill' },
    ]);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    coworkStore.updateCapabilityDraftValidation({ id: draft.id, metabotId: 5, status: 'rejected' });
    const result = coworkStore.insertCapabilityDraftsChecked(5, '2026-08-02', [
      { title: '已被否决', description: '重新提出', capabilityType: 'skill' },
    ]);
    assert.equal(result.inserted, 1, 'a rejected draft does not block re-proposal');
    assert.equal(result.skippedDuplicate, 0);
  } finally {
    cleanup();
  }
});
