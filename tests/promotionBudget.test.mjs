import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createSqliteStore } from './memoryTestUtils.mjs';
import { createDreamHarness, dayStartMs, dreamJson, seedSession } from './fixtures/rrsiDreamHarness.mjs';

const require = createRequire(import.meta.url);
const {
  PROMOTION_BUDGET_MAX,
  PROMOTION_BUDGET_MIN,
  PROMOTION_BUDGET_ANNEAL_NIGHTS,
  promotionBudgetForNight,
} = require('../dist-electron/main/libs/promotionBudget.js');
const { DreamStore } = require('../dist-electron/main/dreamStore.js');

// ---------------------------------------------------------------------------
// Pure vectors (RRSI P2 Task 2)
// ---------------------------------------------------------------------------

test('promotion budget anneals from max to min over 60 nights', () => {
  assert.equal(PROMOTION_BUDGET_MAX, 3);
  assert.equal(PROMOTION_BUDGET_MIN, 1);
  assert.equal(PROMOTION_BUDGET_ANNEAL_NIGHTS, 60);
  const vectors = [
    [0, 3], [10, 3], [20, 3], [29, 3],
    [30, 2], [40, 2], [59, 2],
    [60, 1], [500, 1],
    [-1, 3], [NaN, 3],
  ];
  for (const [nights, expected] of vectors) {
    assert.equal(promotionBudgetForNight(nights), expected, `t=${nights}`);
  }
});

test('promotion budget honors custom max/min/annealNights', () => {
  const options = { max: 4, min: 1, annealNights: 10 };
  assert.equal(promotionBudgetForNight(0, options), 4);
  assert.equal(promotionBudgetForNight(5, options), 3);
  assert.equal(promotionBudgetForNight(10, options), 1);
});

// ---------------------------------------------------------------------------
// DreamStore.countNonEmptyDreamNights
// ---------------------------------------------------------------------------

test('countNonEmptyDreamNights counts only non-empty nights strictly before the date', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const dreamStore = new DreamStore(db, () => {});
    const insertDaily = (metabotId, dreamDate, emptyDay) => db.run(
      'INSERT INTO metabot_dream_telemetry_daily (metabot_id, dream_date, empty_day, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
      [metabotId, dreamDate, emptyDay],
    );
    insertDaily(5, '2026-08-01', 0);
    insertDaily(5, '2026-08-02', 1);
    insertDaily(5, '2026-08-03', 0);
    insertDaily(9, '2026-08-01', 0);
    assert.equal(dreamStore.countNonEmptyDreamNights(5, '2026-08-04'), 2);
    assert.equal(dreamStore.countNonEmptyDreamNights(5, '2026-08-03'), 1);
    assert.equal(dreamStore.countNonEmptyDreamNights(9, '2026-08-04'), 1);
    assert.equal(dreamStore.countNonEmptyDreamNights(7, '2026-08-04'), 0, 'unknown bot has no nights');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Promotion pass flows (harness)
// ---------------------------------------------------------------------------

const seedValidatedDrafts = (h, nightDate, count) => {
  h.coworkStore.insertCapabilityDrafts(5, '2026-08-02', Array.from({ length: count }, (_, index) => ({
    title: `技巧${index + 1}:先验证再交付`,
    description: '交付前自检一遍',
    capabilityType: 'workflow',
  })));
  const drafts = h.coworkStore.listCapabilityDrafts(5, { status: 'draft' });
  assert.equal(drafts.length, count);
  for (const draft of drafts) {
    h.coworkStore.updateCapabilityDraftValidation({
      id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9,
    });
    h.db.run(
      'UPDATE capability_drafts SET validated_at = ? WHERE id = ?',
      [dayStartMs('2026-08-02'), draft.id],
    );
  }
  void nightDate;
};

test('a fresh bot promotes up to 3 drafts and records the budget telemetry', async () => {
  const h = await createDreamHarness();
  try {
    seedValidatedDrafts(h, '2026-08-04', 4);
    seedSession(h.coworkStore, h.db, '2026-08-04', [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    await h.runNight('2026-08-04');
    assert.deepEqual(h.telemetry('2026-08-04')?.promotionBudget, {
      nights: 0, budget: 3, candidates: 4, promoted: 3,
    });
    const promoted = h.coworkStore.listCapabilityDrafts(5).filter((draft) => draft.promotedAt != null);
    assert.equal(promoted.length, 3);
  } finally {
    h.cleanup();
  }
});

test('a bot with 60 non-empty nights promotes only 1 draft per night', async () => {
  const h = await createDreamHarness();
  try {
    for (let index = 0; index < 60; index += 1) {
      const day = new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10);
      h.db.run(
        'INSERT INTO metabot_dream_telemetry_daily (metabot_id, dream_date, empty_day, created_at, updated_at) VALUES (?, ?, 0, 0, 0)',
        [5, day],
      );
    }
    seedValidatedDrafts(h, '2026-08-04', 4);
    seedSession(h.coworkStore, h.db, '2026-08-04', [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    await h.runNight('2026-08-04');
    assert.deepEqual(h.telemetry('2026-08-04')?.promotionBudget, {
      nights: 60, budget: 1, candidates: 4, promoted: 1,
    });
    const promoted = h.coworkStore.listCapabilityDrafts(5).filter((draft) => draft.promotedAt != null);
    assert.equal(promoted.length, 1);
  } finally {
    h.cleanup();
  }
});
