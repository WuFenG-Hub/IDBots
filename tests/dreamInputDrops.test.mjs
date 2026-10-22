/**
 * Dream review P0 (2026-10-23), item 4: silent-drop counters + telemetry.
 *
 * Every silent truncation in dream input assembly now increments a counter on
 * the mutable DreamInputDropCounters object threaded through the activity
 * query, prompt building and parsing; the dream run surfaces the object in
 * run telemetry (metabot_dream_telemetry_daily.extra_json) and console.warns
 * when any counter is non-zero. Covers:
 *   1. group-chat messages over the 400/task cap,
 *   2. chain writes / reads over the 50/day cap,
 *   3. implicit signals over the 5/day cap,
 *   4. sessions reduced to title-only by fair-share budgeting,
 *   5. surf-report chars cut by the 2000-char cap,
 *   6. per-output-array truncations at parse time,
 *   7. end-to-end: a dream run reports inputDrops in the run telemetry.
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
  parseDreamOutput,
} = require('../dist-electron/main/libs/dreamPrompt.js');
const { extractImplicitSignals } = require('../dist-electron/main/libs/implicitSignals.js');

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

const DAY = '2026-08-06';
const DAY_START = new Date(2026, 7, 6).getTime();
const DAY_END = DAY_START + 86_400_000;
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

test('group-chat messages over the 400/task cap are counted', async () => {
  const { db, cleanup } = await createSqliteStore();
  createCoworkStore(db);
  try {
    db.run(
      `INSERT INTO group_tasks (id, group_id, title, goal, status, chair_metabot_id)
       VALUES (11, 'group-11', ' flood 任务', 'g', 'executing', 5)`,
    );
    db.run(
      `INSERT INTO group_task_members (task_id, metabot_id, role) VALUES (11, 5, 'worker')`,
    );
    for (let index = 0; index < 450; index += 1) {
      db.run(
        `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_name, content, chain_timestamp, protocol)
         VALUES (?, 'group-11', 'm1', 'peer', ?, ?, 'metaweb_group_chat')`,
        [`flood-pin-${index}`, `消息 ${index}`, Math.floor((DAY_START + index * 1000) / 1000)],
      );
    }
    const dreamStore = new DreamStore(db, () => {});
    const counters = createDreamInputDropCounters();
    const activity = dreamStore.getActivityForDate(5, DAY_START, DAY_END, counters);
    assert.equal(activity.groupChats[0].messages.length, 400);
    assert.equal(counters.groupChatMessages, 50, 'the overflow over the per-task cap is counted');
  } finally {
    cleanup();
  }
});

test('chain writes/reads over the 50/day cap are counted', async () => {
  const { db, cleanup } = await createSqliteStore();
  createCoworkStore(db);
  try {
    for (let index = 0; index < 60; index += 1) {
      db.run(
        `INSERT INTO metabot_chain_writes (metabot_id, pin_id, occurred_at_ms) VALUES (5, ?, ?)`,
        [`write-pin-${index}`, DAY_START + index * 1000],
      );
    }
    for (let index = 0; index < 55; index += 1) {
      db.run(
        `INSERT INTO metabot_chain_reads (metabot_id, pin_id, last_read_at_ms, first_read_at_ms) VALUES (5, ?, ?, ?)`,
        [`read-pin-${index}`, DAY_START + index * 1000, DAY_START + index * 1000],
      );
    }
    const dreamStore = new DreamStore(db, () => {});
    const counters = createDreamInputDropCounters();
    const activity = dreamStore.getActivityForDate(5, DAY_START, DAY_END, counters);
    assert.equal(activity.chainWrites.length, 50);
    assert.equal(activity.chainReads.length, 50);
    assert.equal(counters.chainWrites, 10);
    assert.equal(counters.chainReads, 5);
  } finally {
    cleanup();
  }
});

test('implicit signals over the 5/day cap are counted', () => {
  // Eight sessions whose tail is ≥2 consecutive user messages: 8 candidate
  // signals, 3 over the cap.
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    sessionId: `s${index}`,
    title: `会话 ${index}`,
    sessionType: 'standard',
    peerName: null,
    isOrder: false,
    messages: [
      { type: 'user', content: '在吗', createdAt: index * 10 + 1 },
      { type: 'user', content: '还在吗', createdAt: index * 10 + 2 },
    ],
  }));
  const counters = createDreamInputDropCounters();
  const signals = extractImplicitSignals({ sessions, taskRuns: [], orderCount: 0, groupTasks: [] }, counters);
  assert.equal(signals.length, 5);
  assert.equal(counters.implicitSignals, 3);
});

test('title-only sessions by share budgeting and surf-report truncation are counted', () => {
  const counters = createDreamInputDropCounters();
  const sessions = Array.from({ length: 300 }, (_, index) => ({
    sessionId: `s${index}`,
    title: `会话 ${index}`,
    sessionType: 'standard',
    peerName: null,
    isOrder: false,
    messages: [
      { type: 'user', content: '内容'.repeat(200), createdAt: index * 10 + 1 },
      { type: 'assistant', content: '回复'.repeat(200), createdAt: index * 10 + 2 },
    ],
  }));
  const prompt = buildDreamPrompt({
    botName: '小火',
    date: DAY,
    activity: { sessions, taskRuns: [], orderCount: 0, groupTasks: [] },
    activityTokenBudget: 256,
    surfReport: '浪'.repeat(3000),
  }, counters);
  assert.equal(counters.sessionsTitleOnly, 300, 'every session reduced to a title-only stub is counted');
  assert.equal(counters.surfReportChars, 1000, 'surf chars beyond the 2000 cap are counted');
});

test('parse-time per-output-array truncations are counted', () => {
  const counters = createDreamInputDropCounters();
  const payload = JSON.stringify({
    daily_summary: '今天很充实。',
    sections: {},
    work_reviews: Array.from({ length: 7 }, (_, index) => ({ subject: `工作 ${index}`, counterparty: '', evaluation: 'stable', note: '' })),
    important_memories: Array.from({ length: 6 }, (_, index) => `记忆 ${index}`),
    value_lessons: Array.from({ length: 5 }, (_, index) => ({ rule: `准则 ${index} 要这样做`, source: 's' })),
    self_identity: LONG_IDENTITY,
    impression_updates: [],
    knowledge_points: [],
    capability_learnings: [],
    practice_proposals: [],
  });
  const parsed = parseDreamOutput(payload, counters);
  assert.equal(parsed.ok, true);
  // work_reviews 7→5 (+2), important_memories 6→5 (+1), value_lessons 5→3 (+2).
  assert.equal(counters.parseArrayEntries, 5);
});

test('dream run surfaces inputDrops in run telemetry', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('聊交付', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['u1', session.id, 'user', '今天怎么样', '{}', DAY_START + 1000, 1]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'assistant', '挺好的', '{}', DAY_START + 2000, 2]
  );

  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 7, 3, 0),
    performChat: async () => JSON.stringify({
      daily_summary: '今天很充实。',
      sections: {},
      work_reviews: [],
      important_memories: Array.from({ length: 8 }, (_, index) => `记忆 ${index}`),
      value_lessons: [],
      self_identity: LONG_IDENTITY,
      capability_learnings: [],
    }),
  });
  try {
    await service.runNow(5, DAY);
    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.deepEqual(telemetry.inputDrops, {
      groupChatMessages: 0,
      chainWrites: 0,
      chainReads: 0,
      implicitSignals: 0,
      sessionsTitleOnly: 0,
      surfReportChars: 0,
      parseArrayEntries: 3,
    });
  } finally {
    cleanup();
  }
});
