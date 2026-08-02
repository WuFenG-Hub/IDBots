import test from 'node:test';
import assert from 'node:assert/strict';

import { createSqliteStore } from './memoryTestUtils.mjs';

let DreamStore;
try {
  ({ DreamStore } = await import('../dist-electron/main/dreamStore.js'));
} catch {
  ({ DreamStore } = await import('../dist-electron/dreamStore.js'));
}

const seedSummaries = (store, metabotId, rows) => {
  for (const [date, text, sections] of rows) {
    store.upsertDailySummary({
      metabotId,
      summaryDate: date,
      summaryText: text,
      sections: sections ?? {},
      stats: {},
      llmId: null,
    });
  }
};

test('searchDailySummaries: warm date-range lookup, newest first', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    seedSummaries(store, 5, [
      ['2026-07-01', '月初的总结'],
      ['2026-07-10', '月中的总结'],
      ['2026-07-20', '月末的总结'],
      ['2026-08-01', '下个月的总结'],
    ]);
    seedSummaries(store, 6, [['2026-07-15', '别的 bot 的总结']]);

    const range = store.searchDailySummaries(5, { dateFrom: '2026-07-05', dateTo: '2026-07-31' });
    assert.deepEqual(range.map((s) => s.summaryDate), ['2026-07-20', '2026-07-10']);

    const all = store.searchDailySummaries(5, {});
    assert.deepEqual(all.map((s) => s.summaryDate), ['2026-08-01', '2026-07-20', '2026-07-10', '2026-07-01']);
  } finally {
    cleanup();
  }
});

test('searchDailySummaries: cold keyword search across full history', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    seedSummaries(store, 5, [
      ['2025-12-01', '去年和用户讨论过发布计划'],
      ['2026-07-01', '这周做了视频'],
      ['2026-07-20', '和用户敲定发布计划的细节'],
    ]);

    const hits = store.searchDailySummaries(5, { query: '发布计划' });
    assert.deepEqual(hits.map((s) => s.summaryDate), ['2026-07-20', '2025-12-01']);

    // Keyword also matches inside sections_json.
    store.upsertDailySummary({
      metabotId: 5,
      summaryDate: '2026-07-21',
      summaryText: '概要里没关键词',
      sections: { a2a: '和 PeerBot 讨论了发布计划' },
      stats: {},
      llmId: null,
    });
    const sectionHit = store.searchDailySummaries(5, { query: '发布计划', limit: 1 });
    assert.deepEqual(sectionHit.map((s) => s.summaryDate), ['2026-07-21']);
  } finally {
    cleanup();
  }
});

test('searchDailySummaries: LIKE wildcards in the query are escaped', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    seedSummaries(store, 5, [
      ['2026-07-01', '进度达到 100% 了'],
      ['2026-07-02', '普通的一天'],
    ]);

    assert.deepEqual(
      store.searchDailySummaries(5, { query: '%' }).map((s) => s.summaryDate),
      ['2026-07-01'],
      'bare % is a literal percent sign, matching only texts that contain one'
    );
    assert.deepEqual(
      store.searchDailySummaries(5, { query: '100%' }).map((s) => s.summaryDate),
      ['2026-07-01']
    );
    assert.equal(store.searchDailySummaries(5, { query: '_' }).length, 0);
  } finally {
    cleanup();
  }
});
