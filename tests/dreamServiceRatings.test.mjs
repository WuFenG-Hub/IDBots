/**
 * Dream review P0 (2026-10-23), item 2: skill-service buyer ratings reach the
 * PROVIDER bot's dream.
 *
 * Buyer rating pins are synced chain-wide by gigSquareRatingSyncService into
 * remote_skill_service_rating_seen (+ the rating_avg/count rollup on
 * remote_skill_service). This suite covers the provider-side read path:
 *   1. DreamStore.getActivityForDate — ratings received on the dream date for
 *      services owned by the dreaming bot (service title, stars, comment,
 *      order txid, rater metaId), excluding other providers and other days,
 *   2. buildDreamPrompt — the buyer-rating section rendering + truncation,
 *      fragment mode omission, and the output-contract rule covering low
 *      ratings in work_reviews / value_lessons,
 *   3. counterfactual replay — a ≤2-star service rating becomes a
 *      low_service_rating decision point; any service rating counts as
 *      explicit human feedback for the hasExplicitHumanFeedback denominator.
  * NOTE: imports the dist-electron build — run `pnpm run compile:electron` first.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  DreamStore,
  createDreamInputDropCounters,
} = require('../dist-electron/main/dreamStore.js');
const {
  buildDreamPrompt,
} = require('../dist-electron/main/libs/dreamPrompt.js');
const {
  extractNegativeDecisionPoints,
  hasExplicitHumanFeedback,
} = require('../dist-electron/main/libs/counterfactualReplayPrompt.js');

const DAY = '2026-08-02';
const DAY_START = new Date(2026, 7, 2).getTime();
const DAY_END = DAY_START + 86_400_000;

const insertMetabot = (db, { id, metaid, globalmetaid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, globalmetaid, metabot_type, created_by,
      role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `pub-${id}`, `chatpub-${id}`, `Bot ${id}`, metaid, globalmetaid],
  );
};

const insertService = (db, { id, metaid, globalmetaid = null, name }) => {
  db.run(
    `INSERT INTO remote_skill_service (id, metaid, global_metaid, service_name, display_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, metaid, globalmetaid, name, `展示:${name}`, 1],
  );
};

const insertRating = (db, { pinId, serviceId, rate, comment = null, tx = null, raterGlobal = null, raterMeta = null, createdAt }) => {
  db.run(
    `INSERT INTO remote_skill_service_rating_seen (
      pin_id, service_id, service_paid_tx, rate, comment, rater_global_metaid, rater_metaid, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [pinId, serviceId, tx, rate, comment, raterGlobal, raterMeta, createdAt],
  );
};

const seedProviderFixtures = (db) => {
  // The dreaming bot owns services A (by globalmetaid) and B (by metaid only).
  insertMetabot(db, { id: 5, metaid: 'metaid-5', globalmetaid: 'gm-5' });
  insertMetabot(db, { id: 7, metaid: 'metaid-7', globalmetaid: 'gm-7' });
  insertService(db, { id: 'svc-a', metaid: 'other-metaid', globalmetaid: 'gm-5', name: '视频剪辑服务' });
  insertService(db, { id: 'svc-b', metaid: 'metaid-5', globalmetaid: null, name: '海报设计服务' });
  insertService(db, { id: 'svc-c', metaid: 'metaid-7', globalmetaid: 'gm-7', name: '别人的服务' });
};

test('getActivityForDate: own-service ratings on the dream date are collected with identity fields', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedProviderFixtures(db);
    insertRating(db, {
      pinId: 'pin-r1', serviceId: 'svc-a', rate: 2, comment: '交付比约定慢了一天',
      tx: 'tx-abc123', raterGlobal: 'buyer-gm-1', createdAt: DAY_START + 60_000,
    });
    insertRating(db, {
      pinId: 'pin-r2', serviceId: 'svc-b', rate: 5, createdAt: DAY_START + 120_000,
    });

    createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    const activity = dreamStore.getActivityForDate(5, DAY_START, DAY_END);
    assert.equal(activity.serviceRatings.length, 2);

    const low = activity.serviceRatings.find((row) => row.ratingPinId === 'pin-r1');
    assert.equal(low.serviceId, 'svc-a');
    assert.equal(low.serviceName, '展示:视频剪辑服务', 'display name wins over service_name');
    assert.equal(low.rating, 2);
    assert.equal(low.comment, '交付比约定慢了一天');
    assert.equal(low.orderTxid, 'tx-abc123');
    assert.equal(low.raterGlobalMetaId, 'buyer-gm-1');
    assert.equal(low.ratedAtMs, DAY_START + 60_000);

    const high = activity.serviceRatings.find((row) => row.ratingPinId === 'pin-r2');
    assert.equal(high.rating, 5);
    assert.equal(high.serviceName, '展示:海报设计服务', 'metaid-only provider service matches too');
  } finally {
    cleanup();
  }
});

test('getActivityForDate: other providers, other days and unrated-service pins are excluded', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedProviderFixtures(db);
    insertRating(db, { pinId: 'pin-x1', serviceId: 'svc-c', rate: 1, createdAt: DAY_START + 60_000 });
    insertRating(db, { pinId: 'pin-x2', serviceId: 'svc-a', rate: 1, createdAt: DAY_START - 60_000, comment: '昨天的差评' });
    insertRating(db, { pinId: 'pin-x3', serviceId: 'svc-a', rate: 1, createdAt: DAY_END + 60_000 });

    createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    const activity = dreamStore.getActivityForDate(5, DAY_START, DAY_END);
    assert.equal(activity.serviceRatings.length, 0, 'nothing on the dream date belongs to the dreaming bot');

    const tomorrow = dreamStore.getActivityForDate(5, DAY_END, DAY_END + 86_400_000);
    assert.equal(tomorrow.serviceRatings.length, 1, 'day window is respected');
  } finally {
    cleanup();
  }
});

test('getActivityForDate: service ratings are capped per day and the overflow is counted (review M4)', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedProviderFixtures(db);
    for (let index = 0; index < 15; index += 1) {
      insertRating(db, {
        pinId: `pin-flood-${index}`, serviceId: 'svc-a', rate: 4, createdAt: DAY_START + 1000 * index,
      });
    }
    createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    const counters = createDreamInputDropCounters();
    const activity = dreamStore.getActivityForDate(5, DAY_START, DAY_END, counters);
    assert.equal(activity.serviceRatings.length, 10, 'bounded so a popular service cannot flood the dream');
    assert.equal(counters.serviceRatings, 5, 'the exact overflow feeds the drop counters, like chainWrites/Reads');
  } finally {
    cleanup();
  }
});

test('buildDreamPrompt renders the buyer-rating section with truncation, omits it in fragment mode', () => {
  const baseActivity = { sessions: [], taskRuns: [], orderCount: 0, groupTasks: [] };
  const without = buildDreamPrompt({ botName: '小火', date: DAY, activity: baseActivity });
  assert.ok(!without.user.includes('## 当天我发布的服务收到的买家评价'), 'no ratings → no section');

  const withRatings = buildDreamPrompt({
    botName: '小火',
    date: DAY,
    activity: {
      ...baseActivity,
      serviceRatings: [
        {
          serviceId: 'svc-a', serviceName: '视频剪辑服务', ratingPinId: 'pin-r1', rating: 2,
          comment: '交付比约定慢了一天'.padEnd(500, '。'),
          orderTxid: 'tx-abc123', raterGlobalMetaId: 'buyer-gm-1', raterMetaId: null,
          ratedAtMs: DAY_START,
        },
        {
          serviceId: 'svc-b', serviceName: '海报设计服务', ratingPinId: 'pin-r2', rating: 5,
          comment: null, orderTxid: null, raterGlobalMetaId: null, raterMetaId: 'buyer-meta-2',
          ratedAtMs: DAY_START + 1000,
        },
      ],
    },
  });
  assert.ok(withRatings.user.includes('## 当天我发布的服务收到的买家评价'));
  assert.ok(withRatings.user.includes('「视频剪辑服务」2 星'));
  assert.ok(withRatings.user.includes('订单支付tx:tx-abc123'));
  assert.ok(withRatings.user.includes('买家:buyer-gm-1'));
  const commentLine = withRatings.user.split('\n').find((line) => line.includes('买家评语:'));
  assert.ok(commentLine, 'comment rendered');
  assert.ok(commentLine.length <= 220, 'comment truncated sanely');
  assert.ok(withRatings.user.includes('「海报设计服务」5 星'));

  // Output-contract rule: low service ratings must reach work_reviews/value_lessons.
  assert.match(withRatings.user, /关于我发布的服务的买家评价/);
  assert.match(withRatings.user, /低分\(1-2 星\)必须正视/);

  const fragment = buildDreamPrompt({
    botName: '小火',
    date: DAY,
    activity: {
      ...baseActivity,
      serviceRatings: [{ serviceId: 'svc-a', serviceName: '视频剪辑服务', ratingPinId: 'p', rating: 1, comment: null, orderTxid: null, raterGlobalMetaId: null, raterMetaId: null, ratedAtMs: DAY_START }],
    },
    sourceMode: 'fragment',
  });
  assert.ok(!fragment.user.includes('## 当天我发布的服务收到的买家评价'), 'fragment prompt stays lean');
});

test('counterfactual replay: ≤2-star service rating becomes a low_service_rating decision point', () => {
  const activity = {
    sessions: [],
    taskRuns: [],
    orderCount: 0,
    groupTasks: [],
    serviceRatings: [
      {
        serviceId: 'svc-a', serviceName: '视频剪辑服务', ratingPinId: 'pin-r1', rating: 2,
        comment: '交付比约定慢了一天', orderTxid: 'tx-abc123', raterGlobalMetaId: 'buyer-gm-1',
        raterMetaId: null, ratedAtMs: DAY_START,
      },
      {
        serviceId: 'svc-b', serviceName: '海报设计服务', ratingPinId: 'pin-r2', rating: 5,
        comment: null, orderTxid: null, raterGlobalMetaId: null, raterMetaId: null,
        ratedAtMs: DAY_START,
      },
    ],
  };
  const points = extractNegativeDecisionPoints(activity);
  assert.equal(points.length, 1, 'only the low rating is a negative decision point');
  assert.equal(points[0].kind, 'low_service_rating');
  assert.equal(points[0].id, 'svc:svc-a:pin-r1');
  assert.ok(points[0].situation.includes('视频剪辑服务'));
  assert.ok(points[0].botAction.includes('tx-abc123'));
  assert.ok(points[0].outcome.includes('2/5'));
  assert.ok(points[0].outcome.includes('buyer-gm-1'));
});

test('hasExplicitHumanFeedback: any service rating counts, so a rated day is never "no data"', () => {
  const base = { sessions: [], taskRuns: [], orderCount: 0, groupTasks: [] };
  assert.equal(hasExplicitHumanFeedback(base), false);
  assert.equal(hasExplicitHumanFeedback({
    ...base,
    serviceRatings: [{
      serviceId: 'svc-a', serviceName: '视频剪辑服务', ratingPinId: 'pin-r1', rating: 5,
      comment: null, orderTxid: null, raterGlobalMetaId: null, raterMetaId: null, ratedAtMs: DAY_START,
    }],
  }), true);
});
