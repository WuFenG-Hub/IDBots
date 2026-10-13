import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const {
  validatePredictionInput,
  judgeNumericExpectation,
  renderPredictionCalibrationDigest,
  PREDICTION_RESOLVE_DEFAULT_DAYS,
  PREDICTION_RESOLVE_MAX_DAYS,
} = require('../dist-electron/main/libs/predictionLedger.js');
const { buildPredictionAgentTools } = require('../dist-electron/main/libs/predictionAgentTools.js');

function loadDreamServiceModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();

const TODAY = '2026-10-13';
/** Inside the 14-day horizon relative to TODAY. */
const NEAR_DEADLINE = '2026-10-20';
const FUTURE_DEADLINE = '2099-01-01';
const PAST_DEADLINE = '2026-01-01';

const toolStub = () => {
  const tools = [];
  const factory = (name, description, schema, handler) => {
    const tool = { name, description, schema, handler };
    tools.push(tool);
    return tool;
  };
  return { tools, factory };
};

const setupService = async (extraDeps = {}) => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const service = new DreamService({
    coworkStore,
    metabotStore: {
      listMetabots: () => [
        { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
      ],
    },
    dreamStore,
    performChat: async () => {
      throw new Error('tests must not reach the LLM');
    },
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 2, 3, 0),
    ...extraDeps,
  });
  return { db, cleanup, coworkStore, dreamStore, service };
};

test('predictions table creation is idempotent', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    new DreamStore(db, () => {});
    new DreamStore(db, () => {}); // second ensure must not throw
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='metabot_predictions'");
    assert.equal(tables[0].values.length, 1);
    const indexes = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='metabot_predictions'")[0].values.map((row) => row[0]);
    assert.ok(indexes.includes('idx_metabot_predictions_status_deadline'));
  } finally {
    cleanup();
  }
});

test('validatePredictionInput enforces the closed expectation schema per action type', () => {
  const base = { predictionText: '这条 buzz 会获得至少两个互动', resolveDeadline: NEAR_DEADLINE, todayKey: TODAY };
  assert.equal(validatePredictionInput({ ...base, actionType: 'buzz_post', expectation: { metric: 'interactions', op: '>=', value: 2 } }).ok, true);
  // Wrong metric for the action type.
  const badMetric = validatePredictionInput({ ...base, actionType: 'buzz_post', expectation: { metric: 'review_pass', value: true } });
  assert.equal(badMetric.ok, false);
  assert.match(badMetric.error, /metric/);
  const badReceptionMetric = validatePredictionInput({ ...base, actionType: 'buzz_post', expectation: { metric: 'shares', op: '>=', value: 2 } });
  assert.equal(badReceptionMetric.ok, false);
  // Wrong op.
  assert.equal(validatePredictionInput({ ...base, actionType: 'metaweb_comment', expectation: { metric: 'comments', op: '>', value: 2 } }).ok, false);
  // Non-integer / too small value.
  assert.equal(validatePredictionInput({ ...base, actionType: 'buzz_post', expectation: { metric: 'likes', op: '>=', value: 0 } }).ok, false);
  assert.equal(validatePredictionInput({ ...base, actionType: 'buzz_post', expectation: { metric: 'likes', op: '>=', value: 1.5 } }).ok, false);
  // Boolean metrics.
  assert.equal(validatePredictionInput({ ...base, actionType: 'metatask_submission', expectation: { metric: 'review_pass', value: true } }).ok, true);
  assert.equal(validatePredictionInput({ ...base, actionType: 'metatask_submission', expectation: { metric: 'review_pass', value: false } }).ok, false);
  assert.equal(validatePredictionInput({ ...base, actionType: 'service_delivery', expectation: { metric: 'order_completed', value: true } }).ok, true);
  assert.equal(validatePredictionInput({ ...base, actionType: 'service_delivery', expectation: { metric: 'review_pass', value: true } }).ok, false);
  // Unknown action type / extra keys.
  assert.equal(validatePredictionInput({ ...base, actionType: 'metaapp_launch', expectation: { metric: 'interactions', op: '>=', value: 1 } }).ok, false);
  assert.equal(validatePredictionInput({ ...base, actionType: 'buzz_post', expectation: { metric: 'likes', op: '>=', value: 1, note: 'x' } }).ok, false);
});

test('validatePredictionInput enforces text length and the deadline horizon', () => {
  const expectation = { metric: 'interactions', op: '>=', value: 1 };
  const short = validatePredictionInput({ actionType: 'buzz_post', predictionText: '会火', expectation, todayKey: TODAY });
  assert.equal(short.ok, false);
  assert.match(short.error, /too vague/);
  // Default deadline = today + 3d.
  const defaulted = validatePredictionInput({ actionType: 'buzz_post', predictionText: '这条 buzz 会获得至少一个互动', expectation, todayKey: TODAY });
  assert.equal(defaulted.ok, true);
  assert.equal(defaulted.resolveDeadline, '2026-10-16', `default is today + ${PREDICTION_RESOLVE_DEFAULT_DAYS}d`);
  // Overlong deadline is refused.
  const tooFar = validatePredictionInput({ actionType: 'buzz_post', predictionText: '这条 buzz 会获得至少一个互动', expectation, resolveDeadline: '2026-11-30', todayKey: TODAY });
  assert.equal(tooFar.ok, false);
  assert.match(tooFar.error, new RegExp(`${PREDICTION_RESOLVE_MAX_DAYS}d`));
  // Past deadline / malformed date are refused.
  assert.equal(validatePredictionInput({ actionType: 'buzz_post', predictionText: '这条 buzz 会获得至少一个互动', expectation, resolveDeadline: PAST_DEADLINE, todayKey: TODAY }).ok, false);
  assert.equal(validatePredictionInput({ actionType: 'buzz_post', predictionText: '这条 buzz 会获得至少一个互动', expectation, resolveDeadline: 'next week', todayKey: TODAY }).ok, false);
});

test('judgeNumericExpectation: hit / partial / miss', () => {
  const expectation = { metric: 'interactions', op: '>=', value: 3 };
  assert.equal(judgeNumericExpectation(expectation, 5), 'hit');
  assert.equal(judgeNumericExpectation(expectation, 3), 'hit');
  assert.equal(judgeNumericExpectation(expectation, 1), 'partial');
  assert.equal(judgeNumericExpectation(expectation, 0), 'miss');
});

test('prediction_record tool validates, records, and refuses unverifiable predictions', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const dreamStore = new DreamStore(db, () => {});
    const { tools, factory } = toolStub();
    const built = buildPredictionAgentTools({
      tool: factory,
      predictions: dreamStore,
      sessionId: 'sess-1',
      resolveMetabotId: () => 5,
    });
    assert.deepEqual(built, tools);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'prediction_record');

    const okResult = await tools[0].handler({
      action_type: 'buzz_post',
      prediction_text: '这篇关于网格系统的笔记会获得至少两个互动',
      expectation: { metric: 'interactions', op: '>=', value: 2 },
    });
    assert.equal(okResult.isError ?? false, false);
    const stored = dreamStore.listPendingPredictions(5);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].actionType, 'buzz_post');
    assert.equal(stored[0].sessionId, 'sess-1');
    assert.equal(stored[0].source, 'cowork');
    assert.equal(stored[0].status, 'pending');
    assert.deepEqual(stored[0].expectation, { metric: 'interactions', op: '>=', value: 2 });
    assert.match(stored[0].resolveDeadline, /^\d{4}-\d{2}-\d{2}$/);

    const refused = await tools[0].handler({
      action_type: 'buzz_post',
      prediction_text: '这篇笔记会获得至少两个互动',
      expectation: { metric: 'virality', op: '>=', value: 2 },
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Refused/);
    assert.equal(dreamStore.listPendingPredictions(5).length, 1, 'refused predictions never reach the ledger');

    const unattributed = buildPredictionAgentTools({
      tool: factory,
      predictions: dreamStore,
      sessionId: 'sess-x',
      resolveMetabotId: () => null,
    })[0];
    const noBotResult = await unattributed.handler({ action_type: 'buzz_post', prediction_text: '这篇笔记会获得至少两个互动', expectation: { metric: 'likes', op: '>=', value: 1 } });
    assert.equal(noBotResult.isError, true);
    assert.match(noBotResult.content[0].text, /could not resolve/);

    // Surf sessions default the source to 'surf'.
    const surfTool = buildPredictionAgentTools({
      tool: factory,
      predictions: dreamStore,
      sessionId: 'sess-surf',
      resolveMetabotId: () => 5,
      defaultSource: 'surf',
    })[0];
    await surfTool.handler({
      action_type: 'metaweb_comment',
      prediction_text: '这条评论会获得至少一个点赞',
      expectation: { metric: 'likes', op: '>=', value: 1 },
      subject_ref: 'pin-comment-1',
    });
    const pending = dreamStore.listPendingPredictions(5);
    assert.equal(pending.length, 2);
    assert.equal(pending.find((p) => p.sessionId === 'sess-surf').source, 'surf');
  } finally {
    cleanup();
  }
});

test('recordPrediction/listPendingPredictions/resolvePrediction round-trip with idempotent resolution', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    const prediction = store.recordPrediction({
      metabotId: 5,
      sessionId: 's1',
      source: 'metatask',
      actionType: 'metatask_submission',
      subjectRef: 'rootPin:nodeA',
      predictionText: '提交会通过评审',
      expectation: { metric: 'review_pass', value: true },
      resolveDeadline: FUTURE_DEADLINE,
    });
    assert.equal(prediction.status, 'pending');
    assert.equal(store.listPendingPredictions(5).length, 1);
    assert.equal(store.listPendingPredictions(6).length, 0, 'scoped per bot');

    const resolved = store.resolvePrediction(prediction.id, {
      status: 'hit',
      resolvedBy: 'dream',
      outcomeText: 'submission review outcome: pass',
      outcomeJson: { outcome: 'pass' },
    });
    assert.equal(resolved, true);
    const after = store.getPrediction(prediction.id);
    assert.equal(after.status, 'hit');
    assert.equal(after.resolvedBy, 'dream');
    assert.deepEqual(after.outcomeJson, { outcome: 'pass' });
    assert.ok(after.resolvedAt > 0);
    assert.equal(store.listPendingPredictions(5).length, 0);
    // Idempotent: a second resolution of the same row is a no-op.
    assert.equal(store.resolvePrediction(prediction.id, { status: 'miss', resolvedBy: 'dream' }), false);
    assert.equal(store.getPrediction(prediction.id).status, 'hit');
  } finally {
    cleanup();
  }
});

test('dream reconciliation resolves service_delivery predictions from the order table', async () => {
  const { db, cleanup, dreamStore, service } = await setupService();
  try {
    db.run(
      `INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency,
        status, first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES ('order-ok', 'seller', 5, 'buyer-gmid', '翻译服务', 'tx-1', 'mvc', '1000', 'SPACE', 'completed', 0, 0, 1, 1)`,
    );
    db.run(
      `INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency,
        status, first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES ('order-bad', 'seller', 5, 'buyer-gmid', '翻译服务', 'tx-2', 'mvc', '1000', 'SPACE', 'refunded', 0, 0, 1, 1)`,
    );
    db.run(
      `INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency,
        status, first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES ('order-open', 'seller', 5, 'buyer-gmid', '翻译服务', 'tx-3', 'mvc', '1000', 'SPACE', 'in_progress', 0, 0, 1, 1)`,
    );
    dreamStore.recordPrediction({
      metabotId: 5, source: 'service', actionType: 'service_delivery', subjectRef: 'order-ok',
      predictionText: '订单会正常完成', expectation: { metric: 'order_completed', value: true }, resolveDeadline: FUTURE_DEADLINE,
    });
    dreamStore.recordPrediction({
      metabotId: 5, source: 'service', actionType: 'service_delivery', subjectRef: 'order-bad',
      predictionText: '订单会正常完成', expectation: { metric: 'order_completed', value: true }, resolveDeadline: FUTURE_DEADLINE,
    });
    // Still in flight and NOT past its deadline: must stay pending.
    dreamStore.recordPrediction({
      metabotId: 5, source: 'service', actionType: 'service_delivery', subjectRef: 'order-open',
      predictionText: '订单会正常完成', expectation: { metric: 'order_completed', value: true }, resolveDeadline: FUTURE_DEADLINE,
    });
    // In flight AND past its deadline: expires.
    dreamStore.recordPrediction({
      metabotId: 5, source: 'service', actionType: 'service_delivery', subjectRef: 'order-open',
      predictionText: '订单会正常完成', expectation: { metric: 'order_completed', value: true }, resolveDeadline: PAST_DEADLINE,
    });
    // Unknown order past its deadline: expires.
    dreamStore.recordPrediction({
      metabotId: 5, source: 'service', actionType: 'service_delivery', subjectRef: 'order-ghost',
      predictionText: '订单会正常完成', expectation: { metric: 'order_completed', value: true }, resolveDeadline: PAST_DEADLINE,
    });

    // An empty dream date is enough — reconciliation runs before synthesis.
    await service.runNow(5, '2026-07-29');

    const calibration = dreamStore.listPredictionCalibration(5, 3650);
    const bucket = calibration.byActionType.service_delivery;
    assert.equal(bucket.hit, 1);
    assert.equal(bucket.miss, 1);
    assert.equal(bucket.expired, 2);
    const pending = dreamStore.listPendingPredictions(5);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].subjectRef, 'order-open', 'the in-flight, in-deadline prediction stays pending');

    const run = dreamStore.getRun(5, '2026-07-29');
    assert.equal(run.status, 'completed');
    assert.deepEqual(run.telemetry?.predictions, { checked: 5, resolved: 4, hit: 1, miss: 1, partial: 0, expired: 2 });
  } finally {
    cleanup();
  }
});

test('dream reconciliation resolves metatask submissions from the projection dep', async () => {
  const outcomes = new Map([
    ['rootP:nodePass', { outcome: 'pass', detail: 'verified' }],
    ['rootP:nodeFail', { outcome: 'fail', detail: 'failed by review' }],
    ['rootP:nodeOpen', { outcome: 'pending' }],
  ]);
  const { cleanup, dreamStore, service } = await setupService({
    getMetataskSubmissionOutcome: ({ subjectRef }) => outcomes.get(subjectRef) ?? null,
  });
  try {
    dreamStore.recordPrediction({
      metabotId: 5, source: 'metatask', actionType: 'metatask_submission', subjectRef: 'rootP:nodePass',
      predictionText: '提交会通过评审', expectation: { metric: 'review_pass', value: true }, resolveDeadline: FUTURE_DEADLINE,
    });
    dreamStore.recordPrediction({
      metabotId: 5, source: 'metatask', actionType: 'metatask_submission', subjectRef: 'rootP:nodeFail',
      predictionText: '提交会通过评审', expectation: { metric: 'review_pass', value: true }, resolveDeadline: FUTURE_DEADLINE,
    });
    dreamStore.recordPrediction({
      metabotId: 5, source: 'metatask', actionType: 'metatask_submission', subjectRef: 'rootP:nodeOpen',
      predictionText: '提交会通过评审', expectation: { metric: 'review_pass', value: true }, resolveDeadline: FUTURE_DEADLINE,
    });
    dreamStore.recordPrediction({
      metabotId: 5, source: 'metatask', actionType: 'metatask_submission', subjectRef: 'rootP:nodeUnknown',
      predictionText: '提交会通过评审', expectation: { metric: 'review_pass', value: true }, resolveDeadline: PAST_DEADLINE,
    });

    await service.runNow(5, '2026-07-29');

    const calibration = dreamStore.listPredictionCalibration(5, 3650);
    assert.equal(calibration.byActionType.metatask_submission.hit, 1);
    assert.equal(calibration.byActionType.metatask_submission.miss, 1);
    assert.equal(calibration.byActionType.metatask_submission.expired, 1);
    assert.equal(dreamStore.listPendingPredictions(5).length, 1, 'the unreviewed submission stays pending');
    assert.equal(dreamStore.listPendingPredictions(5)[0].subjectRef, 'rootP:nodeOpen');
  } finally {
    cleanup();
  }
});

test('dream reconciliation resolves reception predictions, with subject fallback to the writes ledger', async () => {
  const { db, cleanup, dreamStore, service } = await setupService({
    fetchPredictionReception: async ({ pinIds }) => pinIds.map((pinId) => (
      pinId === 'pin-hot' ? { pinId, likes: 2, comments: 1 } : { pinId, likes: 0, comments: 0 }
    )),
  });
  try {
    // The write exists only in the chain-writes ledger — the prediction was
    // recorded BEFORE the post, with no subject_ref.
    db.run(
      `INSERT INTO metabot_chain_writes (metabot_id, pin_id, path, operation, content_text, occurred_at_ms)
       VALUES (5, 'pin-hot', '/protocols/simplebuzz', 'create', '网格系统笔记', ?)`,
      [Date.now()],
    );
    // Subject-less prediction falls back to the earliest own write after it.
    const early = dreamStore.recordPrediction({
      metabotId: 5, source: 'surf', actionType: 'buzz_post',
      predictionText: '这篇笔记会获得至少三个互动', expectation: { metric: 'interactions', op: '>=', value: 3 }, resolveDeadline: FUTURE_DEADLINE,
    });
    db.run('UPDATE metabot_predictions SET created_at = ? WHERE id = ?', [Date.now() - 60_000, early.id]);
    // An explicit subject_ref with an under-target (but non-zero) reception and
    // a FUTURE deadline stays pending (an early partial never settles).
    dreamStore.recordPrediction({
      metabotId: 5, source: 'surf', actionType: 'buzz_post', subjectRef: 'pin-cold',
      predictionText: '这篇会获得至少两个互动', expectation: { metric: 'interactions', op: '>=', value: 2 }, resolveDeadline: FUTURE_DEADLINE,
    });
    // Same under-target prediction PAST its deadline resolves as partial.
    dreamStore.recordPrediction({
      metabotId: 5, source: 'surf', actionType: 'buzz_post', subjectRef: 'pin-zero',
      predictionText: '这篇会获得至少两个互动', expectation: { metric: 'interactions', op: '>=', value: 2 }, resolveDeadline: PAST_DEADLINE,
    });
    // Never posted (no own write, no subject) and past deadline: expires.
    dreamStore.recordPrediction({
      metabotId: 5, source: 'surf', actionType: 'buzz_post',
      predictionText: '这篇会获得至少两个互动', expectation: { metric: 'interactions', op: '>=', value: 2 }, resolveDeadline: PAST_DEADLINE,
    });

    await service.runNow(5, '2026-07-29');

    const fallback = dreamStore.getPrediction(early.id);
    assert.equal(fallback.status, 'hit', '3 observed >= 3 expected resolves as an early hit');
    assert.equal(fallback.outcomeJson.resolvedSubjectRef, 'pin-hot', 'the fallback subject is recorded in outcome_json');
    assert.equal(fallback.outcomeJson.likes, 2);
    assert.equal(fallback.outcomeJson.comments, 1);

    const calibration = dreamStore.listPredictionCalibration(5, 3650);
    assert.equal(calibration.byActionType.buzz_post.hit, 1);
    assert.equal(calibration.byActionType.buzz_post.miss, 1, 'pin-zero had zero interactions at its deadline');
    assert.equal(calibration.byActionType.buzz_post.expired, 1);
    assert.equal(dreamStore.listPendingPredictions(5).length, 1, 'the under-target prediction with a future deadline stays pending');
    assert.equal(dreamStore.listPendingPredictions(5)[0].subjectRef, 'pin-cold');
  } finally {
    cleanup();
  }
});

test('reception fetch failure keeps predictions pending (and expires them past the deadline)', async () => {
  const { cleanup, dreamStore, service } = await setupService({
    fetchPredictionReception: async () => { throw new Error('backend down'); },
  });
  try {
    dreamStore.recordPrediction({
      metabotId: 5, source: 'surf', actionType: 'buzz_post', subjectRef: 'pin-x',
      predictionText: '这篇会获得至少两个互动', expectation: { metric: 'interactions', op: '>=', value: 2 }, resolveDeadline: FUTURE_DEADLINE,
    });
    dreamStore.recordPrediction({
      metabotId: 5, source: 'surf', actionType: 'buzz_post', subjectRef: 'pin-y',
      predictionText: '这篇会获得至少两个互动', expectation: { metric: 'interactions', op: '>=', value: 2 }, resolveDeadline: PAST_DEADLINE,
    });
    await service.runNow(5, '2026-07-29');
    const pending = dreamStore.listPendingPredictions(5);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].subjectRef, 'pin-x');
    const expired = dreamStore.listPredictionCalibration(5, 3650).byActionType.buzz_post;
    assert.equal(expired.expired, 1);
  } finally {
    cleanup();
  }
});

test('calibration digest aggregates per action type and renders the dream section', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    const record = (actionType, daysAgo = 0) => {
      const prediction = store.recordPrediction({
        metabotId: 5, source: 'cowork', actionType,
        predictionText: `预测:${actionType} 会有好结果`, expectation: { metric: 'interactions', op: '>=', value: 1 }, resolveDeadline: FUTURE_DEADLINE,
      });
      if (daysAgo > 0) {
        db.run('UPDATE metabot_predictions SET created_at = ? WHERE id = ?', [Date.now() - daysAgo * 86_400_000, prediction.id]);
      }
      return prediction;
    };
    const hit = record('buzz_post');
    store.resolvePrediction(hit.id, { status: 'hit', resolvedBy: 'dream', outcomeText: 'observed 3 interactions' });
    const miss = record('buzz_post');
    store.resolvePrediction(miss.id, { status: 'miss', resolvedBy: 'dream', outcomeText: 'observed 0 interactions' });
    const partial = record('metaweb_comment');
    store.resolvePrediction(partial.id, { status: 'partial', resolvedBy: 'dream', outcomeText: 'observed 1 interactions' });
    const expired = record('metatask_submission');
    store.resolvePrediction(expired.id, { status: 'expired', resolvedBy: 'dream', outcomeText: 'deadline passed' });
    record('service_delivery'); // stays pending
    const ancient = record('buzz_post', 45);
    store.resolvePrediction(ancient.id, { status: 'miss', resolvedBy: 'dream' });
    db.run('UPDATE metabot_predictions SET resolved_at = ? WHERE id = ?', [Date.now() - 45 * 86_400_000, ancient.id]);

    const calibration = store.listPredictionCalibration(5, 30);
    assert.equal(calibration.windowDays, 30);
    assert.equal(calibration.pendingCount, 1);
    // The 45-day-old prediction falls outside the trailing-30d window.
    assert.deepEqual(calibration.byActionType.buzz_post, { hit: 1, miss: 1, partial: 0, expired: 0, resolved: 2, hitRate: 0.5 });
    assert.equal(calibration.byActionType.metaweb_comment.partial, 1);
    assert.equal(calibration.byActionType.metatask_submission.expired, 1);
    assert.equal(calibration.byActionType.metatask_submission.resolved, 0, 'expired never enters the judged set');
    assert.equal(calibration.recentMisses.length, 2, 'miss + partial both surface as calibration signal');
    assert.deepEqual(calibration.recentMisses.map((entry) => entry.status).sort(), ['miss', 'partial']);

    const digest = renderPredictionCalibrationDigest(calibration);
    assert.match(digest, /预测-结果对账/);
    assert.match(digest, /buzz_post/);
    assert.match(digest, /命中率 50%/);
    assert.match(digest, /observed 0 interactions/);

    assert.equal(renderPredictionCalibrationDigest(store.listPredictionCalibration(7, 30)), '', 'no data → no prompt section');
  } finally {
    cleanup();
  }
});

test('pruneResolvedPredictions removes only old terminal rows', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    const make = (resolveDeadline) => store.recordPrediction({
      metabotId: 5, source: 'cowork', actionType: 'buzz_post',
      predictionText: '这篇会获得至少一个互动', expectation: { metric: 'likes', op: '>=', value: 1 }, resolveDeadline,
    });
    const oldResolved = make(PAST_DEADLINE);
    store.resolvePrediction(oldResolved.id, { status: 'hit', resolvedBy: 'dream' });
    db.run('UPDATE metabot_predictions SET resolved_at = ? WHERE id = ?', [Date.now() - 100 * 86_400_000, oldResolved.id]);
    const freshResolved = make(PAST_DEADLINE);
    store.resolvePrediction(freshResolved.id, { status: 'miss', resolvedBy: 'dream' });
    const pending = make(FUTURE_DEADLINE);

    const pruned = store.pruneResolvedPredictions({ cutoffMs: Date.now() - 90 * 86_400_000 });
    assert.equal(pruned, 1);
    assert.equal(store.getPrediction(oldResolved.id), null);
    assert.equal(store.getPrediction(freshResolved.id)?.status, 'miss');
    assert.equal(store.getPrediction(pending.id)?.status, 'pending', 'pending rows are never pruned');
  } finally {
    cleanup();
  }
});
