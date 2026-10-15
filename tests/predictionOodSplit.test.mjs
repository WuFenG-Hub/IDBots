/**
 * RRSI evolution P5 (design §6.5 P5.3): the internal vs external prediction
 * split — the OOD held-out set that reveals scorer fitting.
 *
 * Covers:
 *   1. listPredictionCalibration.bySourceClass bucket arithmetic (cowork/surf
 *      → internal, metatask/service → external, unknown sources skipped),
 *   2. the per-status sums equal the byActionType totals,
 *   3. renderPredictionCalibrationDigest output stays byte-identical with
 *      bySourceClass present vs deleted (the dream prompt text is frozen),
 *   4. run telemetry predictionOod { internal, external, gap } on both dream
 *      paths, gap null without external resolutions.
 *
 * Note: listPredictionCalibration windows on the REAL clock (Date.now), so
 * predictions are inserted with created_at = Date.now() - 3_600_000 by raw
 * SQL — not the harness clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';
import { createDreamHarness, dreamJson, seedSession } from './fixtures/rrsiDreamHarness.mjs';

const require = Module.createRequire(import.meta.url);
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const {
  renderPredictionCalibrationDigest,
  PREDICTION_SOURCE_CLASS,
} = require('../dist-electron/main/libs/predictionLedger.js');

const DAY1 = '2026-08-02';
const DAY2 = '2026-08-03';

test('PREDICTION_SOURCE_CLASS maps cowork/surf internal, metatask/service external', () => {
  assert.deepEqual(PREDICTION_SOURCE_CLASS, {
    cowork: 'internal',
    surf: 'internal',
    metatask: 'external',
    service: 'external',
  });
});

/** Insert one terminal prediction row on the real clock (an hour ago). */
const insertPrediction = (db, index, source, actionType, status) => {
  db.run(
    `INSERT INTO metabot_predictions (
       id, metabot_id, created_at, session_id, source, action_type, subject_ref,
       prediction_text, expectation_json, resolve_deadline, status, resolved_at, resolved_by
     ) VALUES (?, 5, ?, NULL, ?, ?, NULL, ?, '{}', '2026-12-31', ?, ?, 'test')`,
    [`pred-${index}`, Date.now() - 3_600_000, source, actionType, `预测 ${index}`, status, Date.now() - 1_800_000],
  );
};

test('bySourceClass buckets internal vs external with the same arithmetic', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    // cowork: 3 hit, 1 miss; surf: 1 partial; metatask: 1 hit, 2 miss; service: 1 expired.
    insertPrediction(db, 1, 'cowork', 'buzz_post', 'hit');
    insertPrediction(db, 2, 'cowork', 'buzz_post', 'hit');
    insertPrediction(db, 3, 'cowork', 'buzz_post', 'hit');
    insertPrediction(db, 4, 'cowork', 'buzz_post', 'miss');
    insertPrediction(db, 5, 'surf', 'metaweb_comment', 'partial');
    insertPrediction(db, 6, 'metatask', 'metatask_submission', 'hit');
    insertPrediction(db, 7, 'metatask', 'metatask_submission', 'miss');
    insertPrediction(db, 8, 'metatask', 'metatask_submission', 'miss');
    insertPrediction(db, 9, 'service', 'service_delivery', 'expired');
    const dreamStore = new DreamStore(db, () => {});
    const digest = dreamStore.listPredictionCalibration(5, 30);

    assert.deepEqual(
      { ...digest.bySourceClass.internal },
      { hit: 3, miss: 1, partial: 1, expired: 0, resolved: 5, hitRate: 0.6 },
    );
    assert.deepEqual(
      { ...digest.bySourceClass.external },
      { hit: 1, miss: 2, partial: 0, expired: 1, resolved: 3, hitRate: 1 / 3 },
    );

    // Sums: for each status, internal + external equals the byActionType total.
    for (const status of ['hit', 'miss', 'partial', 'expired', 'resolved']) {
      const byAction = Object.values(digest.byActionType).reduce((sum, bucket) => sum + (bucket?.[status] ?? 0), 0);
      const byClass = digest.bySourceClass.internal[status] + digest.bySourceClass.external[status];
      assert.equal(byClass, byAction, `${status}: bySourceClass sums equal the per-action totals`);
    }
  } finally {
    cleanup();
  }
});

test('renderPredictionCalibrationDigest output is unchanged by bySourceClass', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    insertPrediction(db, 1, 'cowork', 'buzz_post', 'hit');
    insertPrediction(db, 2, 'cowork', 'buzz_post', 'miss');
    insertPrediction(db, 3, 'metatask', 'metatask_submission', 'hit');
    insertPrediction(db, 4, 'metatask', 'metatask_submission', 'miss');
    const dreamStore = new DreamStore(db, () => {});
    const digest = dreamStore.listPredictionCalibration(5, 30);
    const withoutSplit = { ...digest };
    delete withoutSplit.bySourceClass;
    assert.equal(
      renderPredictionCalibrationDigest(digest),
      renderPredictionCalibrationDigest(withoutSplit),
      'the digest text must not print the internal/external split',
    );
    assert.ok(renderPredictionCalibrationDigest(digest).length > 0);
  } finally {
    cleanup();
  }
});

test('run telemetry records predictionOod with the rounded gap (non-empty night)', async () => {
  const h = await createDreamHarness();
  try {
    insertPrediction(h.db, 1, 'cowork', 'buzz_post', 'hit');
    insertPrediction(h.db, 2, 'cowork', 'buzz_post', 'hit');
    insertPrediction(h.db, 3, 'cowork', 'buzz_post', 'hit');
    insertPrediction(h.db, 4, 'cowork', 'buzz_post', 'miss');
    insertPrediction(h.db, 5, 'surf', 'metaweb_comment', 'partial');
    insertPrediction(h.db, 6, 'metatask', 'metatask_submission', 'hit');
    insertPrediction(h.db, 7, 'metatask', 'metatask_submission', 'miss');
    insertPrediction(h.db, 8, 'metatask', 'metatask_submission', 'miss');
    seedSession(h.coworkStore, h.db, DAY1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({}));
    await h.runNight(DAY1);
    assert.deepEqual(
      h.telemetry(DAY1)?.predictionOod,
      {
        internal: { resolved: 5, hit: 3, hitRate: 0.6 },
        external: { resolved: 3, hit: 1, hitRate: 0.3333333333333333 },
        gap: 0.2667,
      },
    );
  } finally {
    h.cleanup();
  }
});

test('run telemetry: gap is null without external resolutions (empty night)', async () => {
  const h = await createDreamHarness();
  try {
    insertPrediction(h.db, 1, 'cowork', 'buzz_post', 'hit');
    insertPrediction(h.db, 2, 'cowork', 'buzz_post', 'hit');
    insertPrediction(h.db, 3, 'service', 'service_delivery', 'expired');
    // No session — the empty-day telemetry path still carries predictionOod.
    await h.runNight(DAY2);
    const predictionOod = h.telemetry(DAY2)?.predictionOod;
    assert.ok(predictionOod, 'the empty-night path writes predictionOod too');
    assert.deepEqual(predictionOod.internal, { resolved: 2, hit: 2, hitRate: 1 });
    assert.deepEqual(predictionOod.external, { resolved: 0, hit: 0, hitRate: null });
    assert.equal(predictionOod.gap, null, 'no external resolutions → no gap');
  } finally {
    h.cleanup();
  }
});
