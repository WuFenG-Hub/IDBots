import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadRunnerModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    try {
      return require('../dist-electron/main/libs/coworkRunner.js');
    } catch {
      return require('../dist-electron/libs/coworkRunner.js');
    }
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadRunnerModule();

let formatExperienceRecallResults;
let formatExperienceTimelineFallback;
let resolveExperienceRecallQuery;
try {
  ({
    formatExperienceRecallResults,
    formatExperienceTimelineFallback,
    resolveExperienceRecallQuery,
  } = await import('../dist-electron/main/libs/experiencePromptBlocks.js'));
} catch {
  ({
    formatExperienceRecallResults,
    formatExperienceTimelineFallback,
    resolveExperienceRecallQuery,
  } = await import('../dist-electron/experiencePromptBlocks.js'));
}

const summaries = (dates) => dates.map((date, index) => ({
  summaryDate: date,
  summaryText: `那天做了第 ${index + 1} 件事。`,
}));

test('granularity=day renders one line per summary (default behavior preserved)', () => {
  const text = formatExperienceRecallResults(summaries(['2026-07-01', '2026-07-02']), 'day');
  assert.ok(text.includes('2026-07-01:'));
  assert.ok(text.includes('2026-07-02:'));
  assert.ok(!text.includes('Week of'));
  assert.ok(!text.includes('Month 2026-07'));
});

test('granularity=week groups same-week summaries under a Monday-based header', () => {
  // 2026-07-06 and 2026-07-08 are both in the week of Monday 2026-07-06.
  const text = formatExperienceRecallResults(summaries(['2026-07-08', '2026-07-06', '2026-06-29']), 'week');
  assert.ok(text.includes('Week of 2026-07-06'), 'Monday key groups the two same-week days');
  assert.ok(text.includes('2 days'), 'group size labeled');
  assert.ok(text.includes('Week of 2026-06-29'), 'separate week for 2026-06-29');
});

test('granularity=month groups by YYYY-MM', () => {
  const text = formatExperienceRecallResults(summaries(['2026-08-13', '2026-08-01', '2026-07-20']), 'month');
  assert.ok(text.includes('Month 2026-08'));
  assert.ok(text.includes('Month 2026-07'));
  assert.ok(text.includes('2 days'), 'August group has two days');
});

test('empty result still returns the no-summaries message regardless of granularity', () => {
  const dayEmpty = formatExperienceRecallResults([], 'day');
  assert.ok(dayEmpty.includes('No experience summaries found'));
  const monthEmpty = formatExperienceRecallResults([], 'month');
  assert.ok(monthEmpty.includes('No experience summaries found'));
});

test('a busy day\u2019s longer diary survives day-granularity recall (not clipped to the old 600 cap)', () => {
  const longText = '充实的一天:'.repeat(200); // ~1400 chars, well past the old 600 cap
  const text = formatExperienceRecallResults([{ summaryDate: '2026-08-13', summaryText: longText }], 'day');
  assert.ok(text.includes('充实的一天'), 'full-length diary content preserved, not truncated at 600');
  assert.ok(text.length > 1000, 'recall output is substantial for a rich day');
});

test('formatExperienceTimelineFallback lists raw episodes when no summary exists', () => {
  const text = formatExperienceTimelineFallback({
    dateFrom: '2026-06-01',
    dateTo: '2026-06-30',
    episodes: [
      { startedAt: Date.parse('2026-06-10T00:00:00.000Z'), sourceChannel: 'cowork', episodeType: 'task_participation' },
      { startedAt: Date.parse('2026-06-15T00:00:00.000Z'), sourceChannel: 'metaweb_private', episodeType: 'direct_interaction' },
    ],
  });
  assert.ok(text.includes('No dream summaries were consolidated'));
  assert.ok(text.includes('2 episode(s)'));
  assert.ok(text.includes('task_participation'));
  assert.ok(text.includes('direct_interaction'));

  const none = formatExperienceTimelineFallback({ dateFrom: '2026-06-01', episodes: [] });
  assert.ok(none.includes('No raw episodes found'));
});

test('resolveExperienceRecallQuery normalizes granularity and defaults to day', () => {
  assert.equal(resolveExperienceRecallQuery({ granularity: 'WEEK' }).granularity, 'week');
  assert.equal(resolveExperienceRecallQuery({ granularity: 'bogus' }).granularity, 'day');
  assert.equal(resolveExperienceRecallQuery({}).granularity, 'day');
});

const setup = async ({ episodeTimelineProvider } = {}) => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/dreamStore.js'));
  const dreamStore = new DreamStore(db, () => {});
  // Seed a June and an August summary (no July), so July is a gap.
  dreamStore.upsertDailySummary({ metabotId: 5, summaryDate: '2026-06-10', summaryText: '六月做了选型', sections: {}, stats: {}, llmId: null });
  dreamStore.upsertDailySummary({ metabotId: 5, summaryDate: '2026-06-12', summaryText: '六月又改了方案', sections: {}, stats: {}, llmId: null });
  dreamStore.upsertDailySummary({ metabotId: 5, summaryDate: '2026-08-05', summaryText: '八月上线了', sections: {}, stats: {}, llmId: null });
  const runner = new CoworkRunner(coworkStore, {
    experienceStore: dreamStore,
    ...(episodeTimelineProvider ? { episodeTimelineProvider } : {}),
    getMetabotById: () => ({ id: 5, globalmetaid: 'idq1testowner' }),
  });
  const session = coworkStore.createSession('回忆上个月', '/tmp/a', '', 'local', [], 5);
  return { cleanup, runner, session };
};

test('experience_recall with granularity=month groups the seeded summaries', async () => {
  const { cleanup, runner, session } = await setup();
  try {
    const result = runner.runExperienceRecallTool(
      { date_from: '2026-06-01', date_to: '2026-08-31', granularity: 'month', limit: 30 },
      session.id,
    );
    assert.equal(result.isError, false);
    assert.ok(result.text.includes('Month 2026-06'), 'June group present');
    assert.ok(result.text.includes('Month 2026-08'), 'August group present');
    assert.ok(result.text.includes('2 days'), 'June has two entries');
  } finally {
    cleanup();
  }
});

test('experience_recall falls back to the raw episode timeline for a pinned range with no summary', async () => {
  const episodeTimelineProvider = {
    listEpisodes({ ownerGlobalMetaID, fromTime, toTime }) {
      assert.equal(ownerGlobalMetaID, 'idq1testowner');
      return [
        { startedAt: Date.parse('2026-07-10T00:00:00.000Z'), sourceChannel: 'cowork', episodeType: 'task_participation' },
      ];
    },
  };
  const { cleanup, runner, session } = await setup({ episodeTimelineProvider });
  try {
    const result = runner.runExperienceRecallTool(
      { date_from: '2026-07-01', date_to: '2026-07-31', limit: 30 },
      session.id,
    );
    assert.equal(result.isError, false);
    assert.ok(result.text.includes('No dream summaries were consolidated'), 'fallback message shown');
    assert.ok(result.text.includes('1 episode(s)'), 'raw episode surfaced');
    assert.ok(result.text.includes('task_participation'));
  } finally {
    cleanup();
  }
});

test('experience_recall without an episode provider keeps the empty-summaries message for gap ranges', async () => {
  const { cleanup, runner, session } = await setup();
  try {
    const result = runner.runExperienceRecallTool(
      { date_from: '2026-07-01', date_to: '2026-07-31', limit: 30 },
      session.id,
    );
    assert.equal(result.isError, false);
    assert.ok(result.text.includes('No experience summaries found'));
  } finally {
    cleanup();
  }
});
