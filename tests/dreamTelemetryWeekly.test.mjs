import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  getPreviousIsoWeekRange,
  buildWeeklyDreamPrompt,
  parseWeeklyDreamOutput,
  WEEKLY_DREAM_MIN_DAYS,
} = require('../dist-electron/main/libs/weeklyDreamPrompt.js');

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
const { DreamStore } = require('../dist-electron/main/dreamStore.js');

const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

const dreamPayload = (summary = '普通的一天。') => JSON.stringify({
  daily_summary: summary,
  sections: {},
  work_reviews: [],
  important_memories: [],
  value_lessons: [],
  self_identity: LONG_IDENTITY,
  capability_learnings: [],
});

const seedOneMessageDay = (coworkStore, db, dateMs) => {
  const session = coworkStore.createSession('聊天', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`m-${dateMs}`, session.id, 'user', '你好', '{}', dateMs, 1]
  );
  return session;
};

const seedWeekSummaries = (dreamStore, dates) => {
  for (const date of dates) {
    dreamStore.upsertDailySummary({
      metabotId: 5,
      summaryDate: date,
      summaryText: `${date} 的日记:交付了视频,用户满意。`,
      sections: {},
      stats: {},
      sessionRefs: [],
      llmId: 'bot-own-llm',
    });
  }
};

test('getPreviousIsoWeekRange returns the closed Monday..Sunday week before', () => {
  // 2026-08-10 is a Monday; 2026-08-12 a Wednesday.
  assert.deepEqual(getPreviousIsoWeekRange('2026-08-10'), { weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  assert.deepEqual(getPreviousIsoWeekRange('2026-08-12'), { weekStart: '2026-08-03', weekEnd: '2026-08-09' });
  // Month boundary: 2026-08-05 → previous week starts 2026-07-27 (Monday).
  assert.deepEqual(getPreviousIsoWeekRange('2026-08-05'), { weekStart: '2026-07-27', weekEnd: '2026-08-02' });
  assert.equal(getPreviousIsoWeekRange('not-a-date'), null);
});

test('weekly prompt embeds diaries oldest-first, telemetry and pending drafts', () => {
  const prompt = buildWeeklyDreamPrompt({
    botName: '小火',
    weekStart: '2026-08-03',
    weekEnd: '2026-08-09',
    summaries: [
      { summaryDate: '2026-08-05', summaryText: '周三日记' },
      { summaryDate: '2026-08-03', summaryText: '周一日记' },
    ],
    telemetry: {
      completedRuns: 5,
      totalEstimatedActivityTokens: 12000,
      draftsChecked: 4,
      draftsValidated: 1,
      draftsRejected: 2,
      replayPoints: 3,
      replayLessons: 1,
    },
    pendingDrafts: [{ title: '深夜少发消息', dreamDate: '2026-08-02' }],
  });
  assert.ok(prompt.system.includes('每周长梦'));
  assert.ok(prompt.user.indexOf('周一日记') < prompt.user.indexOf('周三日记'));
  assert.ok(prompt.user.includes('晋升 1 条'));
  assert.ok(prompt.user.includes('深夜少发消息'));
});

test('weekly parser tolerates fences, requires summary, caps patterns', () => {
  const parsed = parseWeeklyDreamOutput('```json\n{"weekly_summary":"这周不错","cross_day_patterns":["a","b","c","d","e","f"],"focus_for_next_week":"少熬夜"}\n```');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.patterns.length, 5);
  assert.equal(parsed.focusForNextWeek, '少熬夜');
  assert.equal(parseWeeklyDreamOutput('{"cross_day_patterns":[]}').ok, false);
  assert.equal(parseWeeklyDreamOutput('nope').ok, false);
});

test('run telemetry roundtrips through the store; weekly summary upsert is idempotent', async () => {
  const { db, cleanup } = await createSqliteStore();
  const dreamStore = new DreamStore(db, () => {});
  try {
    dreamStore.beginRun(5, '2026-08-12', 'bot-own-llm', 13);
    dreamStore.finishRun(5, '2026-08-12', 'completed');
    dreamStore.updateRunTelemetry(5, '2026-08-12', { emptyDay: false, fragmentCount: 2, validation: { checked: 3 } });
    const run = dreamStore.getRun(5, '2026-08-12');
    assert.equal(run.telemetry.fragmentCount, 2);
    assert.equal(run.telemetry.validation.checked, 3);

    const inRange = dreamStore.listRunsInRange(5, '2026-08-03', '2026-08-09');
    assert.equal(inRange.length, 0);
    assert.equal(dreamStore.listRunsInRange(5, '2026-08-10', '2026-08-16').length, 1);

    dreamStore.upsertWeeklySummary({
      metabotId: 5, weekStart: '2026-08-03', weekEnd: '2026-08-09',
      summaryText: '第一周总结', patterns: ['模式一'], llmId: 'bot-own-llm',
    });
    dreamStore.upsertWeeklySummary({
      metabotId: 5, weekStart: '2026-08-03', weekEnd: '2026-08-09',
      summaryText: '第一周总结(重写)', patterns: ['模式二'], llmId: 'bot-own-llm',
    });
    const weekly = dreamStore.getWeeklySummary(5, '2026-08-03');
    assert.equal(weekly.summaryText, '第一周总结(重写)');
    assert.deepEqual(weekly.patterns, ['模式二']);
    assert.equal(dreamStore.getLatestWeeklySummary(5).weekStart, '2026-08-03');
  } finally {
    cleanup();
  }
});

test('dream run writes telemetry and triggers the weekly long dream once per week', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  // Wednesday 2026-08-12; previous ISO week = 08-03..08-09 (3 diaries seeded).
  seedOneMessageDay(coworkStore, db, new Date(2026, 7, 12, 10, 0).getTime());
  // A second active day so the next night's dream actually calls the LLM.
  seedOneMessageDay(coworkStore, db, new Date(2026, 7, 13, 10, 0).getTime());
  seedWeekSummaries(dreamStore, ['2026-08-03', '2026-08-04', '2026-08-05']);

  let weeklyCalls = 0;
  const dreamPromptUsers = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 13, 3, 0),
    performChat: async (system, user) => {
      if (system.includes('每周长梦')) {
        weeklyCalls += 1;
        return JSON.stringify({
          weekly_summary: '上周整体状态不错,交付节奏稳定。',
          cross_day_patterns: ['连续三天交付都获好评'],
          focus_for_next_week: '保持交付前自检',
        });
      }
      dreamPromptUsers.push(user);
      return dreamPayload();
    },
  });
  try {
    await service.runNow(5, '2026-08-12');

    // Telemetry recorded on the run row.
    const run = dreamStore.getRun(5, '2026-08-12');
    assert.equal(run.status, 'completed');
    assert.equal(run.telemetry.emptyDay, false);
    assert.equal(run.telemetry.fastPath, true);
    assert.equal(run.telemetry.fragmentCount, 0);
    assert.ok(run.telemetry.estimatedActivityTokens > 0);
    assert.equal(run.telemetry.weeklyLongDream, true);
    assert.ok(run.telemetry.durationMs >= 0);

    // Weekly long dream ran exactly once and stored the review.
    assert.equal(weeklyCalls, 1);
    const weekly = dreamStore.getWeeklySummary(5, '2026-08-03');
    assert.ok(weekly.summaryText.includes('交付节奏稳定'));
    assert.ok(weekly.patterns.some((pattern) => pattern.includes('下周焦点')));

    // A second dream in the same week does NOT rerun the weekly long dream,
    // but its nightly prompt now carries the weekly review as context.
    await service.runNow(5, '2026-08-13');
    assert.equal(weeklyCalls, 1);
    assert.ok(dreamPromptUsers[1].includes('上周长梦回顾'));
    assert.ok(dreamPromptUsers[1].includes('交付节奏稳定'));
  } finally {
    cleanup();
  }
});

test(`weekly long dream is skipped when the closed week has fewer than MIN_DAYS diaries`, async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedOneMessageDay(coworkStore, db, new Date(2026, 7, 12, 10, 0).getTime());
  seedWeekSummaries(dreamStore, ['2026-08-03', '2026-08-04']); // one short of the minimum

  let weeklyCalls = 0;
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 13, 3, 0),
    performChat: async (system) => {
      if (system.includes('每周长梦')) weeklyCalls += 1;
      return dreamPayload();
    },
  });
  try {
    assert.ok(WEEKLY_DREAM_MIN_DAYS >= 2);
    await service.runNow(5, '2026-08-12');
    assert.equal(weeklyCalls, 0);
    assert.equal(dreamStore.getWeeklySummary(5, '2026-08-03'), null);
    assert.equal(dreamStore.getRun(5, '2026-08-12').telemetry.weeklyLongDream, false);
  } finally {
    cleanup();
  }
});
